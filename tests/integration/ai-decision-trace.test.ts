import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AiDecisionProviderV2,
  AiDecisionRequestV2,
  AiDecisionV2,
} from '../../src/application/ai/ai-decision-contract';
import { createEndPhaseCommand, GameCommandType } from '../../src/application/game-commands';
import { createGameSession, GameSession } from '../../src/application/game-session';
import type { DeckConfig } from '../../src/application/game-service';
import {
  createCardInstance,
  createHeartIcon,
  createHeartRequirement,
  type CardInstance,
  type EnergyCardData,
  type LiveCardData,
  type MemberCardData,
} from '../../src/domain/entities/card';
import { registerCards, updatePlayer, type GameState } from '../../src/domain/entities/game';
import { placeCardInSlot } from '../../src/domain/entities/zone';
import { toTransport } from '../../src/online/serde';
import { AiDecisionTraceRecorder } from '../../src/server/services/ai-decision-trace-recorder';
import { runAiSelfPlay } from '../../src/server/services/ai-self-play-runner';
import { AiTurnCoordinator } from '../../src/server/services/ai-turn-coordinator';
import { createDeterministicDebugAiProvider } from '../../src/server/services/deterministic-debug-ai-provider';
import {
  CardType,
  FaceState,
  GamePhase,
  HeartColor,
  OrientationState,
  SlotPosition,
  SubPhase,
  TurnType,
} from '../../src/shared/types/enums';
import { confirmPublicSelectionIfNeeded } from '../helpers/public-card-selection-confirmation';

const FIRST = 'trace-private-first-player';
const SECOND = 'trace-private-second-player';
const SECRET = 'RESPONSE-AND-ERROR-SECRET-NOT-FOR-TRACE';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function memberData(cardCode: string, cost = 1): MemberCardData {
  return {
    cardCode,
    name: cardCode,
    cardType: CardType.MEMBER,
    cost,
    blade: 1,
    hearts: [createHeartIcon(HeartColor.GREEN, 4)],
    groupNames: ['蓮ノ空女学院スクールアイドルクラブ'],
  };
}

function liveData(cardCode: string, score = 2): LiveCardData {
  return {
    cardCode,
    name: cardCode,
    cardType: CardType.LIVE,
    score,
    requirements: createHeartRequirement({ [HeartColor.GREEN]: 1 }),
  };
}

/** A complete local deck snapshot; no account or external card database is involved. */
function deck(prefix: string, score = 2): DeckConfig {
  const members = Array.from({ length: 48 }, (_, index) => memberData(`${prefix}-MEMBER-${index}`));
  const lives = Array.from({ length: 12 }, (_, index) =>
    liveData(`${prefix}-LIVE-${index}`, score)
  );
  const energyDeck: EnergyCardData[] = Array.from({ length: 12 }, (_, index) => ({
    cardCode: `${prefix}-ENERGY-${index}`,
    name: 'Energy',
    cardType: CardType.ENERGY,
  }));
  return {
    mainDeck: [members[0]!, ...lives.slice(0, 3), ...members.slice(1), ...lives.slice(3)],
    energyDeck,
  };
}

function keep(request: AiDecisionRequestV2): AiDecisionV2 {
  if (request.window.kind !== 'MULLIGAN') throw new Error('Expected mulligan');
  return {
    schemaVersion: request.schemaVersion,
    decisionId: request.decisionId,
    contextDigest: request.contextDigest,
    kind: 'MULLIGAN',
    selectedCardTokens: [],
  };
}

function policy(): AiDecisionProviderV2 {
  const delegate = createDeterministicDebugAiProvider();
  return {
    decide: (request, signal) =>
      request.window.kind === 'MULLIGAN'
        ? Promise.resolve(keep(request))
        : delegate.decide(request, signal),
  };
}

function runnerOptions(traceRecorder?: AiDecisionTraceRecorder) {
  return {
    firstDeck: deck('FIRST-SEAT-PRIVATE'),
    secondDeck: deck('SECOND-SEAT-PRIVATE', 1),
    providers: { FIRST: policy(), SECOND: policy() },
    randomInt: (maxExclusive: number) => maxExclusive - 1,
    maxSteps: 100,
    maxTurns: 4,
    traceRecorder,
  };
}

function action(request: AiDecisionRequestV2, kind: string, code?: string): AiDecisionV2 {
  if (
    request.window.kind !== 'MAIN_ACTION' &&
    request.window.kind !== 'EFFECT_STEP' &&
    request.window.kind !== 'LIVE_ACTION'
  )
    throw new Error('Expected action window');
  const sourceToken =
    'self' in request.observation
      ? request.observation.self.hand.find((item) => item.card.cardCode === code)?.handToken
      : undefined;
  const candidate = request.window.candidates.find(
    (item) =>
      item.kind === kind &&
      (code === undefined ||
        ('card' in item && item.card.cardCode === code) ||
        ('sourceHandToken' in item && item.sourceHandToken === sourceToken))
  );
  if (!candidate) throw new Error(`Missing action ${kind}`);
  return {
    schemaVersion: request.schemaVersion,
    decisionId: request.decisionId,
    contextDigest: request.contextDigest,
    kind: request.window.kind,
    selectedActionToken: candidate.actionToken,
  };
}

/** Only the initial board is seeded; workflow changes and trace outcomes use real commands. */
function scenario(
  options: {
    sourceCode?: string;
    sourceCost?: number;
    sourceInHand?: boolean;
    energy?: number;
  } = {}
) {
  const session = createGameSession({ randomInt: (maxExclusive) => maxExclusive - 1 });
  session.createGame('private-trace-game', FIRST, 'First', SECOND, 'Second');
  const source = createCardInstance(
    memberData(options.sourceCode ?? 'PL!-sd1-002-SD', options.sourceCost ?? 2),
    FIRST,
    'private-trace-source'
  );
  const target = createCardInstance(
    memberData('PUBLIC-RECOVERY-TARGET'),
    FIRST,
    'private-trace-target'
  );
  let state = registerCards(session.state!, [source, target]);
  const top: CardInstance[] = [];
  for (const ownerId of [FIRST, SECOND]) {
    const prefix = ownerId === FIRST ? 'FIRST' : 'SECOND';
    const hand = createCardInstance(
      liveData(`${prefix}-PRIVATE-HAND-LIVE`),
      ownerId,
      `private-trace-${prefix}-hand`
    );
    const cards = Array.from({ length: 6 }, (_, index) =>
      createCardInstance(
        memberData(`${prefix}-UNKNOWN-TOP-${index}`),
        ownerId,
        `private-trace-${prefix}-top-${index}`
      )
    );
    if (ownerId === FIRST) top.push(...cards);
    const energies = Array.from({ length: options.energy ?? 2 }, (_, index) =>
      createCardInstance(
        { cardCode: `${prefix}-ENERGY-${index}`, name: 'Energy', cardType: CardType.ENERGY },
        ownerId,
        `private-trace-${prefix}-energy-${index}`
      )
    );
    state = registerCards(state, [hand, ...cards, ...energies]);
    state = updatePlayer(state, ownerId, (player) => ({
      ...player,
      hand: {
        ...player.hand,
        cardIds: [
          ...(ownerId === FIRST && options.sourceInHand ? [source.instanceId] : []),
          hand.instanceId,
        ],
      },
      mainDeck: { ...player.mainDeck, cardIds: cards.map((card) => card.instanceId) },
      waitingRoom: { ...player.waitingRoom, cardIds: ownerId === FIRST ? [target.instanceId] : [] },
      memberSlots:
        ownerId === FIRST && !options.sourceInHand
          ? placeCardInSlot(player.memberSlots, SlotPosition.CENTER, source.instanceId, {
              orientation: OrientationState.ACTIVE,
              face: FaceState.FACE_UP,
            })
          : player.memberSlots,
      energyZone: {
        ...player.energyZone,
        cardIds: energies.map((card) => card.instanceId),
        cardStates: new Map(
          energies.map((card) => [
            card.instanceId,
            { orientation: OrientationState.ACTIVE, face: FaceState.FACE_UP },
          ])
        ),
      },
    }));
  }
  (session as unknown as { authorityState: GameState }).authorityState = {
    ...state,
    currentPhase: GamePhase.MAIN_PHASE,
    currentSubPhase: SubPhase.NONE,
    currentTurnType: TurnType.FIRST_PLAYER_TURN,
    activePlayerIndex: 0,
    waitingPlayerId: null,
  };
  return { session, source, target, top };
}

function deferred() {
  let resolve!: (value: AiDecisionV2) => void;
  const promise = new Promise<AiDecisionV2>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function assertAnonymousTrace(recorder: AiDecisionTraceRecorder) {
  for (const seat of ['FIRST', 'SECOND'] as const) {
    const trace = recorder.getSeatTrace(seat);
    for (const record of trace.records) {
      expect(Object.keys(record).sort()).toEqual(['outcome', 'request', 'validatedChoice']);
      expect(Object.keys(record.outcome).sort()).toEqual(
        record.outcome.status === 'EXECUTED'
          ? ['commandType', 'resultingPublicSequence', 'status']
          : ['status']
      );
    }
    const wire = JSON.stringify(trace);
    for (const forbidden of [
      FIRST,
      SECOND,
      'private-trace',
      'obj_',
      'authorityState',
      'cardRegistry',
      'abilityId',
      'rawResponse',
      SECRET,
    ])
      expect(wire).not.toContain(forbidden);
  }
}

describe('opt-in seat-private AI decision traces', () => {
  it('双方真实换牌分别记录本席输入，默认匿名报告不内嵌任何 trace 或手牌', async () => {
    const traceRecorder = new AiDecisionTraceRecorder();
    const execute = vi.spyOn(GameSession.prototype, 'executeCommand');
    const report = await runAiSelfPlay({ ...runnerOptions(traceRecorder), maxSteps: 2 });
    expect(report).toMatchObject({
      status: 'LIMIT_REACHED',
      stopReason: 'MAX_STEPS',
      final: { phase: GamePhase.MAIN_PHASE },
    });
    expect(execute.mock.calls.map(([command]) => command.type)).toEqual([
      GameCommandType.MULLIGAN,
      GameCommandType.MULLIGAN,
    ]);
    for (const seat of ['FIRST', 'SECOND'] as const) {
      const trace = traceRecorder.getSeatTrace(seat);
      expect(trace).toMatchObject({
        schemaVersion: 1,
        viewerSeat: seat,
        incomplete: false,
        omittedRecords: 0,
      });
      expect(trace.records).toHaveLength(1);
      expect(trace.records[0]).toMatchObject({
        request: { window: { kind: 'MULLIGAN' } },
        validatedChoice: { kind: 'MULLIGAN', selectedCardTokens: [] },
        outcome: { status: 'EXECUTED', commandType: GameCommandType.MULLIGAN },
      });
      expect(JSON.stringify(trace)).toContain(`${seat}-SEAT-PRIVATE`);
      expect(JSON.stringify(trace)).not.toContain(
        `${seat === 'FIRST' ? 'SECOND' : 'FIRST'}-SEAT-PRIVATE`
      );
    }
    const wire = JSON.stringify(report);
    for (const forbidden of [
      'trace',
      'records',
      'observation',
      'validatedChoice',
      'contextDigest',
      'SEAT-PRIVATE',
    ])
      expect(wire).not.toContain(forbidden);
    for (const [command] of execute.mock.calls) expect(wire).not.toContain(command.playerId);
  });

  it('费用 2 绚濑绘里真实起动回收后继续 MAIN→LIVE，记录只含当时本席合法视角', async () => {
    const { session, source, target } = scenario();
    const traceRecorder = new AiDecisionTraceRecorder();
    let choose = (request: AiDecisionRequestV2) => action(request, 'ACTIVATE_ABILITY');
    const coordinator = new AiTurnCoordinator({
      session,
      traceRecorder,
      provider: { decide: (request) => Promise.resolve(choose(request)) },
    });
    expect((await coordinator.advanceOne(FIRST)).status).toBe('EXECUTED');
    expect(session.state!.players[0].waitingRoom.cardIds).toContain(source.instanceId);
    const originalFirstRecord = JSON.stringify(traceRecorder.getSeatTrace('FIRST').records[0]);
    choose = (request) => action(request, 'SELECT_CARD', target.data.cardCode);
    expect((await coordinator.advanceOne(FIRST)).status).toBe('EXECUTED');
    confirmPublicSelectionIfNeeded(session);
    expect(session.state!.players[0].hand.cardIds).toContain(target.instanceId);
    choose = (request) => action(request, 'END_MAIN_PHASE');
    expect((await coordinator.advanceOne(FIRST)).status).toBe('EXECUTED');
    expect((await coordinator.advanceOne(SECOND)).status).toBe('EXECUTED');
    expect(session.state!.currentPhase).toBe(GamePhase.LIVE_SET_PHASE);
    choose = (request) => action(request, 'SET_LIVE_CARD', 'FIRST-PRIVATE-HAND-LIVE');
    expect((await coordinator.advanceOne(FIRST)).status).toBe('EXECUTED');
    expect(session.state!.players[0].liveZone.cardIds).toHaveLength(1);
    expect(session.state!.players[0].liveZone.cardStates.values().next().value?.face).toBe(
      FaceState.FACE_DOWN
    );
    const firstTrace = traceRecorder.getSeatTrace('FIRST');
    expect(firstTrace.records.map((record) => record.request.window.kind)).toEqual([
      'MAIN_ACTION',
      'EFFECT_STEP',
      'MAIN_ACTION',
      'LIVE_ACTION',
    ]);
    expect(firstTrace.records.every((record) => record.outcome.status === 'EXECUTED')).toBe(true);
    expect(JSON.stringify(firstTrace.records[0])).toBe(originalFirstRecord);
    expect(traceRecorder.getSeatTrace('SECOND').records).toHaveLength(1);
    expect(JSON.stringify(firstTrace)).not.toContain('SECOND-PRIVATE-HAND-LIVE');
    assertAnonymousTrace(traceRecorder);
  });

  it('费用 2 中须霞的检视多选记录匿名有序选择且真实按反序放回牌库', async () => {
    const { session, source, top } = scenario({ sourceCode: 'PL!N-bp1-002-P', sourceInHand: true });
    const traceRecorder = new AiDecisionTraceRecorder();
    const coordinator = new AiTurnCoordinator({
      session,
      traceRecorder,
      provider: {
        decide(request) {
          if (request.window.kind === 'MAIN_ACTION')
            return Promise.resolve(
              action(request, 'PLAY_MEMBER_TO_EMPTY_SLOT', source.data.cardCode)
            );
          if (request.window.kind !== 'EFFECT_CARD_SELECTION')
            throw new Error('Expected inspection');
          return Promise.resolve({
            schemaVersion: request.schemaVersion,
            decisionId: request.decisionId,
            contextDigest: request.contextDigest,
            kind: 'EFFECT_CARD_SELECTION',
            choice: 'SELECT',
            selectedCardTokens: [
              request.window.candidates[1]!.cardToken,
              request.window.candidates[0]!.cardToken,
            ],
          });
        },
      },
    });
    expect((await coordinator.advanceOne(FIRST)).status).toBe('EXECUTED');
    expect((await coordinator.advanceOne(FIRST)).status).toBe('EXECUTED');
    expect(session.state!.players[0].mainDeck.cardIds.slice(0, 2)).toEqual([
      top[1]!.instanceId,
      top[0]!.instanceId,
    ]);
    expect(session.state!.players[0].waitingRoom.cardIds).toContain(top[2]!.instanceId);
    const record = traceRecorder.getSeatTrace('FIRST').records[1]!;
    expect(record.validatedChoice).toMatchObject({
      kind: 'EFFECT_CARD_SELECTION',
      choice: 'SELECT',
      selectedCardTokens: ['effect-card-2', 'effect-card-1'],
    });
    expect(JSON.stringify(record.request)).toContain('FIRST-UNKNOWN-TOP-2');
    expect(JSON.stringify(record.request)).not.toContain('FIRST-UNKNOWN-TOP-3');
    assertAnonymousTrace(traceRecorder);
  });

  it('provider 修改请求和返回对象、调用方修改导出副本均不能改写已记录历史', async () => {
    const { session } = scenario();
    const traceRecorder = new AiDecisionTraceRecorder();
    let requestReference!: AiDecisionRequestV2;
    let responseReference!: AiDecisionV2;
    const coordinator = new AiTurnCoordinator({
      session,
      traceRecorder,
      provider: {
        decide(request) {
          requestReference = request;
          responseReference = action(request, 'END_MAIN_PHASE');
          if (!('self' in request.observation)) throw new Error('Expected main observation');
          Object.assign(request.observation.self.hand[0]!.card, { cardCode: SECRET });
          return Promise.resolve(responseReference);
        },
      },
    });
    expect((await coordinator.advanceOne(FIRST)).status).toBe('EXECUTED');
    expect(session.state!.activePlayerIndex).toBe(1);
    const original = JSON.stringify(traceRecorder.getSeatTrace('FIRST'));
    expect(original).not.toContain(SECRET);
    Object.assign(requestReference, { decisionId: SECRET });
    Object.assign(responseReference, { selectedActionToken: SECRET, contextDigest: SECRET });
    const returned = traceRecorder.getSeatTrace('FIRST');
    Object.assign(returned.records[0]!.request, { decisionId: SECRET });
    expect(JSON.stringify(traceRecorder.getSeatTrace('FIRST'))).toBe(original);
  });

  it.each(['unknown-token', 'extra-field', 'provider-error'] as const)(
    '%s 只记录固定失败类别，不记录原响应或私密错误',
    async (mode) => {
      const { session } = scenario();
      const before = toTransport(session.state);
      const traceRecorder = new AiDecisionTraceRecorder();
      const execute = vi.spyOn(session, 'executeCommand');
      const coordinator = new AiTurnCoordinator({
        session,
        traceRecorder,
        provider: {
          decide(request) {
            if (mode === 'provider-error') throw new Error(SECRET);
            const valid = action(request, 'END_MAIN_PHASE');
            return Promise.resolve(
              mode === 'unknown-token'
                ? { ...valid, selectedActionToken: SECRET }
                : { ...valid, rawPrivateReason: SECRET }
            );
          },
        },
      });
      const expected = mode === 'provider-error' ? 'PROVIDER_ERROR' : 'REJECTED';
      expect((await coordinator.advanceOne(FIRST)).status).toBe(expected);
      expect(toTransport(session.state)).toEqual(before);
      expect(execute).not.toHaveBeenCalled();
      expect(traceRecorder.getSeatTrace('FIRST').records).toHaveLength(1);
      const record = traceRecorder.getSeatTrace('FIRST').records[0]!;
      expect(record.validatedChoice).toBeNull();
      expect(record.outcome).toEqual({ status: expected });
      assertAnonymousTrace(traceRecorder);
    }
  );

  it('真实费用不足拒绝保留已验证声明，与格式拒绝区分，且不改变局面', async () => {
    const { session, source } = scenario({
      sourceCode: 'PL!HS-bp1-002-P',
      sourceCost: 11,
      energy: 1,
    });
    const before = toTransport(session.state);
    const traceRecorder = new AiDecisionTraceRecorder();
    const execute = vi.spyOn(session, 'executeCommand');
    const result = await new AiTurnCoordinator({
      session,
      traceRecorder,
      provider: { decide: (request) => Promise.resolve(action(request, 'ACTIVATE_ABILITY')) },
    }).advanceOne(FIRST);
    expect(result.status).toBe('REJECTED');
    expect(execute.mock.calls[0]![0]).toMatchObject({
      type: GameCommandType.ACTIVATE_ABILITY,
      cardId: source.instanceId,
    });
    expect(toTransport(session.state)).toEqual(before);
    const record = traceRecorder.getSeatTrace('FIRST').records[0]!;
    expect(record.validatedChoice).toMatchObject({ kind: 'MAIN_ACTION' });
    expect(record.outcome).toEqual({ status: 'REJECTED' });
    assertAnonymousTrace(traceRecorder);
  });

  it.each(['timeout', 'abort'] as const)(
    '%s 完成后只保留一条记录，迟到响应不追加也不执行命令',
    async (mode) => {
      vi.useFakeTimers();
      const { session } = scenario();
      const before = toTransport(session.state);
      const traceRecorder = new AiDecisionTraceRecorder();
      const pending = deferred();
      const signal = new AbortController();
      let request!: AiDecisionRequestV2;
      const execute = vi.spyOn(session, 'executeCommand');
      const coordinator = new AiTurnCoordinator({
        session,
        traceRecorder,
        decisionTimeoutMs: 20,
        provider: {
          decide(value) {
            request = value;
            return pending.promise;
          },
        },
      });
      const run = coordinator.advanceOne(FIRST, { signal: signal.signal });
      await vi.advanceTimersByTimeAsync(0);
      expect(traceRecorder.getSeatTrace('FIRST')).toMatchObject({
        incomplete: true,
        pendingRecords: 1,
        omittedRecords: 0,
        records: [],
      });
      expect(traceRecorder.incomplete).toBe(false);
      if (mode === 'abort') signal.abort();
      else await vi.advanceTimersByTimeAsync(21);
      const expected = mode === 'abort' ? 'ABORTED' : 'TIMEOUT';
      expect((await run).status).toBe(expected);
      expect(traceRecorder.getSeatTrace('FIRST')).toMatchObject({
        incomplete: false,
        pendingRecords: 0,
      });
      expect(traceRecorder.getSeatTrace('FIRST').records).toHaveLength(1);
      expect(traceRecorder.getSeatTrace('FIRST').records[0]).toMatchObject({
        validatedChoice: null,
        outcome: { status: expected },
      });
      const trace = JSON.stringify(traceRecorder.getSeatTrace('FIRST'));
      pending.resolve(action(request, 'END_MAIN_PHASE'));
      await vi.advanceTimersByTimeAsync(100);
      expect(JSON.stringify(traceRecorder.getSeatTrace('FIRST'))).toBe(trace);
      expect(toTransport(session.state)).toEqual(before);
      expect(execute).not.toHaveBeenCalled();
    }
  );

  it('在途权威阶段变化后迟到合法回复只记 STALE，不再次执行或追加记录', async () => {
    const { session } = scenario();
    const traceRecorder = new AiDecisionTraceRecorder();
    const pending = deferred();
    let request!: AiDecisionRequestV2;
    const execute = vi.spyOn(session, 'executeCommand');
    const coordinator = new AiTurnCoordinator({
      session,
      traceRecorder,
      provider: {
        decide(value) {
          request = value;
          return pending.promise;
        },
      },
    });
    const run = coordinator.advanceOne(FIRST);
    await Promise.resolve();
    expect(session.executeCommand(createEndPhaseCommand(FIRST)).success).toBe(true);
    const changed = toTransport(session.state);
    pending.resolve(action(request, 'END_MAIN_PHASE'));
    expect((await run).status).toBe('STALE');
    const trace = traceRecorder.getSeatTrace('FIRST');
    expect(trace.records).toHaveLength(1);
    expect(trace.records[0]).toMatchObject({ validatedChoice: null, outcome: { status: 'STALE' } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(toTransport(session.state)).toEqual(changed);
    await Promise.resolve();
    expect(traceRecorder.getSeatTrace('FIRST')).toEqual(trace);
  });

  it('容量不足只在当前真实命令完成后停 runner，不重执行或继续第二席', async () => {
    const traceRecorder = new AiDecisionTraceRecorder({ maxBytes: 1 });
    const execute = vi.spyOn(GameSession.prototype, 'executeCommand');
    const report = await runAiSelfPlay(runnerOptions(traceRecorder));
    expect(report).toMatchObject({
      status: 'ERROR',
      stopReason: 'TRACE_INCOMPLETE',
      final: { phase: GamePhase.MULLIGAN_PHASE },
    });
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]).toMatchObject({
      actor: 'FIRST',
      status: 'EXECUTED',
      commandType: GameCommandType.MULLIGAN,
    });
    expect(execute.mock.calls.map(([command]) => command.type)).toEqual([GameCommandType.MULLIGAN]);
    expect(traceRecorder.incomplete).toBe(true);
    expect(traceRecorder.getSeatTrace('FIRST')).toMatchObject({
      incomplete: true,
      omittedRecords: 1,
      records: [],
    });
    expect(traceRecorder.getSeatTrace('SECOND').records).toEqual([]);
    expect(JSON.stringify(report)).not.toContain('SEAT-PRIVATE');
  });
});
