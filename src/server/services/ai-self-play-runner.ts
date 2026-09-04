import { setImmediate } from 'node:timers/promises';
import type {
  AiDecisionProviderV2,
  AiDecisionRequestV2,
} from '../../application/ai/ai-decision-contract.js';
import { getPublicCardSelectionAutoAdvanceMetadata } from '../../application/card-effects/runtime/public-card-selection-confirmation.js';
import { getPublicEffectChoiceAutoAdvanceMetadata } from '../../application/card-effects/runtime/public-effect-choice-confirmation.js';
import { getPublicRevealAutoAdvanceMetadata } from '../../application/card-effects/runtime/public-reveal-dwell.js';
import {
  createAutoAdvancePublicCardSelectionCommand,
  createAutoAdvancePublicEffectChoiceCommand,
  createAutoAdvancePublicRevealCommand,
  type GameCommandType,
} from '../../application/game-commands.js';
import type { DeckConfig } from '../../application/game-service.js';
import { createGameSession } from '../../application/game-session.js';
import type { GameState } from '../../domain/entities/game.js';
import type { Seat } from '../../online/types.js';
import type { RandomIntegerSource } from '../../shared/random-source.js';
import { GameMode } from '../../shared/types/enums.js';
import { AiTurnCoordinator, type AiTurnStepResult } from './ai-turn-coordinator.js';
import { createDeterministicDebugAiProvider } from './deterministic-debug-ai-provider.js';

export interface AiSelfPlayOptions {
  readonly firstDeck: DeckConfig;
  readonly secondDeck: DeckConfig;
  readonly providers?: Readonly<Record<Seat, AiDecisionProviderV2>>;
  /** Only controls randomness already routed through GameSession, not every deck refresh. */
  readonly randomInt?: RandomIntegerSource;
  readonly maxSteps?: number;
  readonly maxTurns?: number;
  readonly maxWallTimeMs?: number;
  readonly decisionTimeoutMs?: number;
  readonly maxConsecutiveRejections?: number;
  readonly signal?: AbortSignal;
}

export interface AiSelfPlayProgress {
  readonly turnCount: number;
  readonly phase: GameState['currentPhase'];
  readonly subPhase: GameState['currentSubPhase'];
  readonly successCounts: Readonly<Record<Seat, number>>;
  readonly winnerSeat: Seat | null;
  readonly endReason: NonNullable<GameState['endInfo']>['reason'] | null;
}

type DecisionKind = AiDecisionRequestV2['window']['kind'];
type DwellKind = 'PUBLIC_REVEAL' | 'PUBLIC_CARD_SELECTION' | 'PUBLIC_EFFECT_CHOICE';

export interface AiSelfPlayStep {
  readonly index: number;
  readonly actor: Seat | 'SYSTEM';
  readonly kind: DecisionKind | DwellKind;
  readonly status: AiTurnStepResult['status'] | 'ERROR';
  readonly commandType: GameCommandType | null;
  readonly before: AiSelfPlayProgress;
  readonly after: AiSelfPlayProgress;
  readonly durationMs: number;
  readonly providerMs: number;
  readonly virtualWaitMs: number;
}

export interface AiSelfPlayReport {
  readonly schemaVersion: 1;
  readonly status: 'COMPLETED' | 'BLOCKED' | 'LIMIT_REACHED' | 'ABORTED' | 'ERROR';
  readonly stopReason:
    | 'GAME_END'
    | 'UNSUPPORTED_WINDOW'
    | 'NO_DECISION'
    | 'REJECTION_LIMIT'
    | 'MAX_STEPS'
    | 'MAX_TURNS'
    | 'MAX_WALL_TIME'
    | 'ABORTED'
    | 'PROVIDER_ERROR'
    | 'DECISION_TIMEOUT'
    | 'STALE_DECISION'
    | 'EXECUTION_FAULT'
    | 'TIMER_REJECTED'
    | 'NO_PROGRESS'
    | 'INITIALIZATION_FAILED'
    | 'RUNNER_ERROR';
  readonly final: AiSelfPlayProgress | null;
  readonly steps: readonly AiSelfPlayStep[];
  readonly wallTimeMs: number;
  readonly providerTimeMs: number;
  readonly virtualWaitMs: number;
  readonly blocker: {
    readonly pending: 'EFFECT' | 'CHOICE' | 'COST' | 'SPECIAL_MEMBER_PLAY' | 'PHASE';
    readonly inputKinds: readonly string[];
  } | null;
}

const SEATS = ['FIRST', 'SECOND'] as const;
const PLAYER_IDS = { FIRST: 'self-play-first', SECOND: 'self-play-second' } as const;

/**
 * Owns a fresh in-memory RULES session; never receives an account, room, or live session.
 * Only its local authority clock is fast-forwarded. All moves still execute real commands.
 * Providers receive only the existing anonymous decision contract, never this session.
 */
export async function runAiSelfPlay(options: AiSelfPlayOptions): Promise<AiSelfPlayReport> {
  const maxSteps = positiveInteger(options.maxSteps, 2_000, 'maxSteps');
  const maxTurns = positiveInteger(options.maxTurns, 30, 'maxTurns');
  const maxWallTimeMs = positiveInteger(options.maxWallTimeMs, 30_000, 'maxWallTimeMs');
  const decisionTimeoutMs = positiveInteger(options.decisionTimeoutMs, 5_000, 'decisionTimeoutMs');
  const maxRejections = positiveInteger(
    options.maxConsecutiveRejections,
    16,
    'maxConsecutiveRejections'
  );
  if (maxWallTimeMs > 2_147_483_647 || decisionTimeoutMs > 2_147_483_647) {
    throw new Error('Timeout limits must not exceed 2147483647 ms');
  }
  const started = globalThis.performance.now();
  let virtualNow = Date.now();
  let virtualWaitMs = 0;
  let providerTimeMs = 0;
  let rejectionCount = 0;
  let decisionSequence = 0;
  const steps: AiSelfPlayStep[] = [];
  const abort = new AbortController();
  const onExternalAbort = () => abort.abort();
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (options.signal?.aborted) abort.abort();
  let wallLimitReached = false;
  const wallTimer = setTimeout(() => {
    wallLimitReached = true;
    abort.abort();
  }, maxWallTimeMs);
  const session = createGameSession({
    gameMode: GameMode.DEBUG,
    now: () => virtualNow,
    randomInt: options.randomInt,
    enableTestOnlyLegacyActions: false,
    allowRulesModeSuccessLiveSkip: true,
  });
  const providers = options.providers ?? {
    FIRST: createDeterministicDebugAiProvider(),
    SECOND: createDeterministicDebugAiProvider(),
  };
  // Retain metrics only, not requests containing either player's private hand.
  const invocation: { kind: DecisionKind | null; startedMs: number; durationMs: number | null } = {
    kind: null,
    startedMs: 0,
    durationMs: null,
  };
  const coordinator = new AiTurnCoordinator({
    session,
    decisionTimeoutMs: Math.min(decisionTimeoutMs, maxWallTimeMs),
    createDecisionId: () => `self-play-${++decisionSequence}`,
    provider: {
      async decide(request, signal) {
        invocation.kind = request.window.kind;
        const providerStarted = globalThis.performance.now();
        invocation.startedMs = providerStarted;
        try {
          return await providers[request.observation.match.viewerSeat].decide(request, signal);
        } finally {
          invocation.durationMs = globalThis.performance.now() - providerStarted;
        }
      },
    },
  });
  const finish = (
    status: AiSelfPlayReport['status'],
    stopReason: AiSelfPlayReport['stopReason']
  ): AiSelfPlayReport => ({
    schemaVersion: 1,
    status,
    stopReason,
    final: session.state ? progress(session.state) : null,
    steps,
    wallTimeMs: globalThis.performance.now() - started,
    providerTimeMs,
    virtualWaitMs,
    // Do not export raw errors, internal IDs, cards, observations, or authority snapshots.
    blocker: status === 'BLOCKED' || status === 'ERROR' ? describeBlocker(session.state) : null,
  });
  try {
    if (abort.signal.aborted) return finish('ABORTED', 'ABORTED');
    session.createGame('self-play', PLAYER_IDS.FIRST, 'First', PLAYER_IDS.SECOND, 'Second');
    if (!session.initializeGame(options.firstDeck, options.secondDeck).success) {
      return finish('ERROR', 'INITIALIZATION_FAILED');
    }
    for (;;) {
      // Give cancellation/deadline callbacks a chance even with immediately resolved providers.
      await setImmediate();
      if (wallLimitReached || globalThis.performance.now() - started >= maxWallTimeMs) {
        return finish('LIMIT_REACHED', 'MAX_WALL_TIME');
      }
      if (abort.signal.aborted) return finish('ABORTED', 'ABORTED');
      const state = session.state!;
      if (state.isEnded) return finish('COMPLETED', 'GAME_END');
      if (steps.length >= maxSteps) return finish('LIMIT_REACHED', 'MAX_STEPS');
      if (state.turnCount > maxTurns) return finish('LIMIT_REACHED', 'MAX_TURNS');
      const before = progress(state);
      const beforeSequence = session.getCurrentPublicEventSeq();
      const stepStarted = globalThis.performance.now();
      const dwell = getDwellCommand(state);
      if (dwell) {
        const waitMs = Math.max(0, dwell.deadline - virtualNow);
        virtualNow += waitMs;
        virtualWaitMs += waitMs;
        let status: AiSelfPlayStep['status'];
        try {
          status = session.executeCommand(dwell.command).success ? 'EXECUTED' : 'REJECTED';
        } catch {
          status = 'ERROR';
        }
        steps.push({
          index: steps.length + 1,
          actor: 'SYSTEM',
          kind: dwell.kind,
          status,
          commandType: dwell.command.type,
          before,
          after: progress(session.state!),
          durationMs: globalThis.performance.now() - stepStarted,
          providerMs: 0,
          virtualWaitMs: waitMs,
        });
        if (status !== 'EXECUTED') return finish('ERROR', 'TIMER_REJECTED');
        if (session.state === state && session.getCurrentPublicEventSeq() === beforeSequence) {
          return finish('ERROR', 'NO_PROGRESS');
        }
        rejectionCount = 0;
        continue;
      }
      let attempted = false;
      // Shared confirmation windows can require both seats; the original candidate/actor gates
      // choose who can act. Never parallelize seats or skip a failed decision to let its peer play.
      for (const seat of SEATS) {
        invocation.kind = null;
        invocation.durationMs = null;
        const attemptStarted = globalThis.performance.now();
        const result = await coordinator.advanceOne(PLAYER_IDS[seat], { signal: abort.signal });
        if (result.status === 'UNAVAILABLE' && invocation.kind === null) continue;
        if (result.status === 'ABORTED' && invocation.kind === null) {
          return wallLimitReached
            ? finish('LIMIT_REACHED', 'MAX_WALL_TIME')
            : finish('ABORTED', 'ABORTED');
        }
        attempted = true;
        const durationMs = globalThis.performance.now() - attemptStarted;
        // A timed-out provider may ignore cancellation; count time actually awaited, not a late result.
        const providerMs =
          invocation.durationMs ?? globalThis.performance.now() - invocation.startedMs;
        providerTimeMs += providerMs;
        steps.push({
          index: steps.length + 1,
          actor: seat,
          kind: invocation.kind!,
          status: result.status,
          commandType: result.status === 'EXECUTED' ? result.commandType : null,
          before,
          after: progress(session.state!),
          durationMs,
          providerMs,
          virtualWaitMs: 0,
        });
        if (wallLimitReached || globalThis.performance.now() - started >= maxWallTimeMs) {
          return finish('LIMIT_REACHED', 'MAX_WALL_TIME');
        }
        switch (result.status) {
          case 'EXECUTED':
            if (session.state === state && session.getCurrentPublicEventSeq() === beforeSequence) {
              return finish('ERROR', 'NO_PROGRESS');
            }
            rejectionCount = 0;
            break;
          case 'REJECTED':
            if (++rejectionCount >= maxRejections) return finish('BLOCKED', 'REJECTION_LIMIT');
            break;
          case 'UNAVAILABLE':
            return finish('ERROR', 'EXECUTION_FAULT');
          case 'NO_DECISION':
            return finish('BLOCKED', 'NO_DECISION');
          case 'TIMEOUT':
            return finish('BLOCKED', 'DECISION_TIMEOUT');
          case 'PROVIDER_ERROR':
            return finish('ERROR', 'PROVIDER_ERROR');
          case 'STALE':
            return finish('ERROR', 'STALE_DECISION');
          case 'ABORTED':
            return finish('ABORTED', 'ABORTED');
        }
        break;
      }
      if (!attempted) return finish('BLOCKED', 'UNSUPPORTED_WINDOW');
    }
  } catch {
    return finish('ERROR', 'RUNNER_ERROR');
  } finally {
    clearTimeout(wallTimer);
    options.signal?.removeEventListener('abort', onExternalAbort);
    abort.abort();
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0)
    throw new Error(`${name} must be a positive safe integer`);
  return resolved;
}

function progress(state: GameState): AiSelfPlayProgress {
  return {
    turnCount: state.turnCount,
    phase: state.currentPhase,
    subPhase: state.currentSubPhase,
    successCounts: {
      FIRST: state.players[0].successZone.cardIds.length,
      SECOND: state.players[1].successZone.cardIds.length,
    },
    winnerSeat:
      state.endInfo?.winnerId === PLAYER_IDS.FIRST
        ? 'FIRST'
        : state.endInfo?.winnerId === PLAYER_IDS.SECOND
          ? 'SECOND'
          : null,
    endReason: state.endInfo?.reason ?? null,
  };
}

function getDwellCommand(state: GameState) {
  const effect = state.activeEffect;
  if (!effect) return null;
  const selection = getPublicCardSelectionAutoAdvanceMetadata(effect);
  if (selection)
    return {
      kind: 'PUBLIC_CARD_SELECTION' as const,
      deadline: selection.autoAdvanceAt,
      command: createAutoAdvancePublicCardSelectionCommand(
        PLAYER_IDS.FIRST,
        effect.id,
        selection.autoAdvanceAt
      ),
    };
  const choice = getPublicEffectChoiceAutoAdvanceMetadata(effect);
  if (choice)
    return {
      kind: 'PUBLIC_EFFECT_CHOICE' as const,
      deadline: choice.autoAdvanceAt,
      command: createAutoAdvancePublicEffectChoiceCommand(
        PLAYER_IDS.FIRST,
        effect.id,
        choice.autoAdvanceAt
      ),
    };
  const reveal = getPublicRevealAutoAdvanceMetadata(effect);
  if (reveal)
    return {
      kind: 'PUBLIC_REVEAL' as const,
      deadline: reveal.autoAdvanceAt,
      command: createAutoAdvancePublicRevealCommand(
        PLAYER_IDS.FIRST,
        effect.id,
        reveal.autoAdvanceAt,
        reveal.generation
      ),
    };
  return null;
}

function describeBlocker(state: GameState | null): AiSelfPlayReport['blocker'] {
  if (!state) return null;
  const effect = state.activeEffect;
  return {
    pending: effect
      ? 'EFFECT'
      : state.pendingChoice
        ? 'CHOICE'
        : state.pendingCostPayment
          ? 'COST'
          : state.pendingSpecialMemberPlay
            ? 'SPECIAL_MEMBER_PLAY'
            : 'PHASE',
    inputKinds: effect
      ? [
          ...(effect.selectableCardIds
            ? [effect.selectableCardMode === 'ORDERED_MULTI' ? 'ORDERED_MULTI' : 'SINGLE_CARD']
            : []),
          ...(effect.selectableCardVisibility === 'AWAITING_PLAYER_BLIND' ? ['BLIND'] : []),
          ...(effect.selectableSlots ? ['SLOT'] : []),
          ...(effect.selectableOptions ? ['OPTION'] : []),
          ...(effect.effectChoice ? ['EFFECT_CHOICE'] : []),
          ...(effect.numericInput ? ['NUMBER'] : []),
          ...(effect.stageFormation ? ['STAGE_FORMATION'] : []),
        ]
      : [],
  };
}
