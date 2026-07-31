import {
  addAction,
  type ActiveEffectState,
  type GameState,
  type PendingAbilityState,
} from '../../../domain/entities/game.js';
import {
  getActiveEffectSourceLifecycleId,
  getPendingAbilitySourceLifecycleId,
} from './ability-source-lifecycle.js';

export type PendingAbilityResolutionOutcome = 'SUCCESS' | 'NO_OP' | 'STALE' | 'SKIP';

export type ContinuePendingCardEffects = (game: GameState, orderedResolution: boolean) => GameState;

/**
 * Immutable authority captured when one exact pending instance is consumed.
 *
 * This is deliberately not a workflow description. It carries only the identity
 * needed by later audit/continuation code after the pending object has left state.
 */
export interface PendingAbilityResolutionReceipt {
  readonly pendingAbilityId: string;
  readonly abilityId: string;
  readonly sourceCardId: string;
  readonly sourceLifecycleId: string;
  readonly controllerId: string;
  readonly mandatory: boolean;
  readonly timingId: string;
  readonly eventIds: readonly string[];
  readonly sourceSlot?: PendingAbilityState['sourceSlot'];
  readonly beganAtActionSequence: number;
  readonly orderedResolution: boolean;
}

export interface BeginPendingAbilityResolutionOptions {
  readonly orderedResolution: boolean;
}

export type BeginPendingAbilityResolutionResult =
  | {
      readonly status: 'BEGUN';
      readonly gameState: GameState;
      readonly receipt: PendingAbilityResolutionReceipt;
    }
  | {
      readonly status: 'NO_PROGRESS';
      readonly reason: 'PENDING_NOT_FOUND' | 'PENDING_IDENTITY_MISMATCH';
      readonly gameState: GameState;
    };

export interface FinishPendingAbilityResolutionOptions {
  readonly outcome: PendingAbilityResolutionOutcome;
  readonly step: string;
  readonly actionPayload?: Readonly<Record<string, unknown>>;
  /**
   * Used only by a workflow that is finishing the active window created from this
   * exact pending instance. A different/missing active effect is a no-progress
   * result; the helper never clears an unrelated window.
   */
  readonly clearMatchingActiveEffect?: boolean;
}

export type FinishPendingAbilityResolutionResult =
  | {
      readonly status: 'FINISHED';
      readonly gameState: GameState;
    }
  | {
      readonly status: 'NO_PROGRESS';
      readonly reason:
        | 'ALREADY_FINISHED'
        | 'PENDING_STILL_PRESENT'
        | 'ACTIVE_EFFECT_NOT_FOUND'
        | 'ACTIVE_EFFECT_IDENTITY_MISMATCH';
      readonly gameState: GameState;
    };

/**
 * Consumes one exact pending instance without running card business logic.
 *
 * Workflows choose when to call this function, which preserves the existing
 * "consume before effect" versus "consume after effect" ordering.
 */
export function beginPendingAbilityResolution(
  game: GameState,
  expected: PendingAbilityState,
  options: BeginPendingAbilityResolutionOptions
): BeginPendingAbilityResolutionResult {
  const pending = game.pendingAbilities.find((candidate) => candidate.id === expected.id);
  if (!pending) {
    return {
      status: 'NO_PROGRESS',
      reason: 'PENDING_NOT_FOUND',
      gameState: game,
    };
  }

  const pendingSourceLifecycleId = getPendingAbilitySourceLifecycleId(game, pending);
  const expectedSourceLifecycleId = getPendingAbilitySourceLifecycleId(game, expected);
  if (
    pending.abilityId !== expected.abilityId ||
    pending.sourceCardId !== expected.sourceCardId ||
    pending.controllerId !== expected.controllerId ||
    pending.mandatory !== expected.mandatory ||
    pending.timingId !== expected.timingId ||
    pending.sourceSlot !== expected.sourceSlot ||
    pendingSourceLifecycleId !== expectedSourceLifecycleId ||
    !sameStringSequence(pending.eventIds, expected.eventIds)
  ) {
    return {
      status: 'NO_PROGRESS',
      reason: 'PENDING_IDENTITY_MISMATCH',
      gameState: game,
    };
  }

  const receipt = Object.freeze({
    pendingAbilityId: pending.id,
    abilityId: pending.abilityId,
    sourceCardId: pending.sourceCardId,
    sourceLifecycleId: pendingSourceLifecycleId,
    controllerId: pending.controllerId,
    mandatory: pending.mandatory,
    timingId: pending.timingId,
    eventIds: Object.freeze([...(pending.eventIds ?? [])]),
    ...(pending.sourceSlot === undefined ? {} : { sourceSlot: pending.sourceSlot }),
    beganAtActionSequence: game.actionSequence,
    orderedResolution: options.orderedResolution,
  }) satisfies PendingAbilityResolutionReceipt;

  return {
    status: 'BEGUN',
    gameState: {
      ...game,
      pendingAbilities: game.pendingAbilities.filter(
        (candidate) => candidate.id !== receipt.pendingAbilityId
      ),
    },
    receipt,
  };
}

/**
 * Writes the standard completion audit and invokes the canonical continuation
 * once. It does not apply card effects, emit rules events, record per-turn use, or
 * decide whether an effect should succeed.
 */
export function finishPendingAbilityResolution(
  game: GameState,
  receipt: PendingAbilityResolutionReceipt,
  options: FinishPendingAbilityResolutionOptions,
  continuePendingCardEffects: ContinuePendingCardEffects
): FinishPendingAbilityResolutionResult {
  if (hasCompletionAudit(game, receipt)) {
    return {
      status: 'NO_PROGRESS',
      reason: 'ALREADY_FINISHED',
      gameState: game,
    };
  }
  if (game.pendingAbilities.some((ability) => ability.id === receipt.pendingAbilityId)) {
    return {
      status: 'NO_PROGRESS',
      reason: 'PENDING_STILL_PRESENT',
      gameState: game,
    };
  }

  let state = game;
  if (options.clearMatchingActiveEffect === true) {
    const effect = game.activeEffect;
    if (!effect) {
      return {
        status: 'NO_PROGRESS',
        reason: 'ACTIVE_EFFECT_NOT_FOUND',
        gameState: game,
      };
    }
    if (!activeEffectMatchesReceipt(game, effect, receipt)) {
      return {
        status: 'NO_PROGRESS',
        reason: 'ACTIVE_EFFECT_IDENTITY_MISMATCH',
        gameState: game,
      };
    }
    state = { ...game, activeEffect: null };
  }

  const actionPayload = options.actionPayload ?? {};
  const sourceSlotPayload =
    receipt.sourceSlot === undefined
      ? {}
      : {
          ...('sourceSlot' in actionPayload ? {} : { sourceSlot: receipt.sourceSlot }),
          pendingSourceSlot: receipt.sourceSlot,
        };
  const stateWithAudit = addAction(state, 'RESOLVE_ABILITY', receipt.controllerId, {
    ...actionPayload,
    pendingAbilityId: receipt.pendingAbilityId,
    abilityId: receipt.abilityId,
    sourceCardId: receipt.sourceCardId,
    sourceLifecycleId: receipt.sourceLifecycleId,
    controllerId: receipt.controllerId,
    mandatory: receipt.mandatory,
    timingId: receipt.timingId,
    eventIds: receipt.eventIds,
    ...sourceSlotPayload,
    pendingResolutionBeganAtActionSequence: receipt.beganAtActionSequence,
    resolutionOutcome: options.outcome,
    pendingResolutionComplete: true,
    orderedResolution: receipt.orderedResolution,
    step: options.step,
  });

  return {
    status: 'FINISHED',
    gameState: continuePendingCardEffects(stateWithAudit, receipt.orderedResolution),
  };
}

function sameStringSequence(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean {
  const normalizedLeft = left ?? [];
  const normalizedRight = right ?? [];
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

function activeEffectMatchesReceipt(
  game: GameState,
  effect: ActiveEffectState,
  receipt: PendingAbilityResolutionReceipt
): boolean {
  return (
    effect.id === receipt.pendingAbilityId &&
    effect.abilityId === receipt.abilityId &&
    effect.sourceCardId === receipt.sourceCardId &&
    effect.controllerId === receipt.controllerId &&
    getActiveEffectSourceLifecycleId(game, effect) === receipt.sourceLifecycleId
  );
}

function hasCompletionAudit(game: GameState, receipt: PendingAbilityResolutionReceipt): boolean {
  return game.actionHistory.some(
    (action) =>
      action.type === 'RESOLVE_ABILITY' &&
      action.payload.pendingResolutionComplete === true &&
      action.payload.pendingAbilityId === receipt.pendingAbilityId &&
      action.payload.abilityId === receipt.abilityId &&
      action.payload.sourceCardId === receipt.sourceCardId &&
      action.payload.sourceLifecycleId === receipt.sourceLifecycleId
  );
}
