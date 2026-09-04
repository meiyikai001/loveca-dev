import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AiDecisionProviderV2,
  AiDecisionRequestV2,
  AiDecisionV2,
} from '../../src/application/ai/ai-decision-contract';
import {
  HS_BP6_030_LIVE_START_DRAW_ONE_DISCARD_ONE_ABILITY_ID,
  MEMBER_LIVE_SUCCESS_DRAW_ONE_DISCARD_ONE_ABILITY_ID,
} from '../../src/application/card-effects/ability-ids';
import {
  createConfirmStepCommand,
  createSetLiveCardCommand,
  GameCommandType,
} from '../../src/application/game-commands';
import { createGameSession } from '../../src/application/game-session';
import type { DeckConfig } from '../../src/application/game-service';
import {
  createHeartIcon,
  createHeartRequirement,
  type CardInstance,
  type EnergyCardData,
  type LiveCardData,
  type MemberCardData,
} from '../../src/domain/entities/card';
import type { GameState } from '../../src/domain/entities/game';
import { toTransport } from '../../src/online/serde';
import { AiTurnCoordinator } from '../../src/server/services/ai-turn-coordinator';
import { CardType, GamePhase, HeartColor, SubPhase } from '../../src/shared/types/enums';
import { confirmPublicSelectionIfNeeded } from '../helpers/public-card-selection-confirmation';

const P1 = 'private-live-first-player';
const P2 = 'private-live-second-player';
const PLAYERS = [P1, P2] as const;
type Session = ReturnType<typeof createGameSession>;
type LiveRequest = AiDecisionRequestV2 & {
  readonly window: Extract<AiDecisionRequestV2['window'], { readonly kind: 'LIVE_ACTION' }>;
};
type LiveCandidate = LiveRequest['window']['candidates'][number];
type DeckOptions = {
  readonly score?: number;
  readonly requiredColor?: HeartColor;
  readonly noOpeningLive?: boolean;
  readonly memberCode?: string;
  readonly memberCost?: number;
  readonly liveCode?: string;
  readonly liveInFirstCheer?: boolean;
};

afterEach(() => vi.restoreAllMocks());

/** Deliberately small inline card snapshots: no registry, account, image, or external dataset. */
function deck(prefix: string, options: DeckOptions = {}): DeckConfig {
  const members: MemberCardData[] = Array.from({ length: 48 }, (_, index) => ({
    cardCode: index === 0 ? (options.memberCode ?? `${prefix}-MEM-0`) : `${prefix}-MEM-${index}`,
    name:
      index === 0 && options.memberCode === 'PL!N-bp5-016-N'
        ? '朝香果林'
        : `${prefix} member ${index}`,
    cardType: CardType.MEMBER,
    cost: index === 0 ? (options.memberCost ?? 1) : 1,
    blade: 1,
    hearts: [createHeartIcon(HeartColor.GREEN, 4)],
    groupNames: ['蓮ノ空'],
  }));
  const lives: LiveCardData[] = Array.from({ length: 12 }, (_, index) => ({
    cardCode: index === 0 ? (options.liveCode ?? `${prefix}-LIVE-0`) : `${prefix}-LIVE-${index}`,
    name:
      index === 0 && options.liveCode === 'PL!HS-bp6-030-L'
        ? 'Very! Very! COCO夏っ'
        : `${prefix} LIVE ${index}`,
    cardType: CardType.LIVE,
    score: options.score ?? 2,
    requirements: createHeartRequirement({ [options.requiredColor ?? HeartColor.GREEN]: 1 }),
    groupNames: ['蓮ノ空'],
  }));
  const mainDeck = options.noOpeningLive
    ? [...members, ...lives]
    : [members[0]!, lives[0]!, lives[1]!, lives[2]!, ...members.slice(1), ...lives.slice(3)];
  if (options.liveInFirstCheer) {
    // Opening 6 + normal draw 1 + one-card LIVE-set draw 1: index 8 is the real first cheer.
    const liveIndex = mainDeck.indexOf(lives[3]!);
    [mainDeck[8], mainDeck[liveIndex]] = [mainDeck[liveIndex]!, mainDeck[8]!];
  }
  const energyDeck: EnergyCardData[] = Array.from({ length: 12 }, (_, index) => ({
    cardCode: `${prefix}-ENERGY-${index}`,
    name: `Energy ${index}`,
    cardType: CardType.ENERGY,
  }));
  return { mainDeck, energyDeck };
}

function sessionWithDecks(
  options: {
    readonly first?: DeckOptions;
    readonly second?: DeckOptions;
    readonly allowSkip?: boolean;
  } = {}
) {
  const session = createGameSession({
    randomInt: (maxExclusive) => maxExclusive - 1,
    allowRulesModeSuccessLiveSkip: options.allowSkip,
  });
  session.createGame('private-live-loop-game', P1, 'First', P2, 'Second');
  expect(
    session.initializeGame(
      deck('FIRST', options.first),
      deck('SECOND', { score: 1, ...options.second })
    ).success
  ).toBe(true);
  return session;
}

function assertLive(request: AiDecisionRequestV2): asserts request is LiveRequest {
  if (request.window.kind !== 'LIVE_ACTION') throw new Error('Expected LIVE_ACTION request');
}

function liveDecision(request: AiDecisionRequestV2, actionToken: string): AiDecisionV2 {
  assertLive(request);
  return {
    schemaVersion: request.schemaVersion,
    decisionId: request.decisionId,
    contextDigest: request.contextDigest,
    kind: 'LIVE_ACTION',
    selectedActionToken: actionToken,
  };
}

function liveCandidate(request: LiveRequest, kind: LiveCandidate['kind']): LiveCandidate {
  const candidate = request.window.candidates.find((item) => item.kind === kind);
  if (!candidate) throw new Error(`Missing ${kind} at ${request.observation.match.subPhase}`);
  return candidate;
}

/** Test policy sees only the same anonymous request as any external model. */
function choose(
  request: AiDecisionRequestV2,
  options: { readonly skipSuccess?: boolean } = {}
): AiDecisionV2 {
  const base = {
    schemaVersion: request.schemaVersion,
    decisionId: request.decisionId,
    contextDigest: request.contextDigest,
  };
  if (request.window.kind === 'MULLIGAN')
    return { ...base, kind: 'MULLIGAN', selectedCardTokens: [] };
  if (!('self' in request.observation)) throw new Error('Missing visible self observation');
  if (request.window.kind === 'MAIN_ACTION') {
    const hasMember = request.observation.self.stage.some((slot) => slot.member !== null);
    const candidate =
      (!hasMember &&
        request.window.candidates.find((item) => item.kind === 'PLAY_MEMBER_TO_EMPTY_SLOT')) ||
      request.window.candidates.find((item) => item.kind === 'END_MAIN_PHASE');
    if (!candidate) throw new Error('No bounded main action');
    return { ...base, kind: 'MAIN_ACTION', selectedActionToken: candidate.actionToken };
  }
  if (request.window.kind === 'EFFECT_STEP') {
    const candidate =
      request.window.candidates.find((item) => item.kind !== 'SKIP') ??
      request.window.candidates[0];
    if (!candidate) throw new Error('No simple effect candidate');
    return { ...base, kind: 'EFFECT_STEP', selectedActionToken: candidate.actionToken };
  }
  assertLive(request);
  const candidates = request.window.candidates;
  const ownLiveCount =
    request.observation.zoneCounts.find(
      (zone) => zone.zoneKey === `${request.observation.match.viewerSeat}_LIVE_ZONE`
    )?.count ?? 0;
  const hand = request.observation.self.hand;
  const setLive =
    ownLiveCount === 0
      ? candidates.find(
          (candidate) =>
            candidate.kind === 'SET_LIVE_CARD' &&
            hand.find((card) => card.handToken === candidate.sourceHandToken)?.card.cardType ===
              CardType.LIVE
        )
      : undefined;
  const candidate =
    (options.skipSuccess && candidates.find((item) => item.kind === 'SKIP_SUCCESS_LIVE')) ||
    setLive ||
    candidates.find((item) => item.kind === 'CONFIRM_LIVE_SET') ||
    candidates.find((item) => item.kind === 'SELECT_SUCCESS_LIVE') ||
    candidates.find((item) => item.kind !== 'SET_LIVE_CARD');
  if (!candidate) throw new Error('No safe LIVE action');
  return liveDecision(request, candidate.actionToken);
}

function driver(session: Session, options: { readonly skipSuccess?: boolean } = {}) {
  const requests: AiDecisionRequestV2[] = [];
  const provider: AiDecisionProviderV2 = {
    decide(request) {
      requests.push(request);
      return Promise.resolve(choose(request, options));
    },
  };
  const coordinator = new AiTurnCoordinator({ session, provider });
  return {
    requests,
    async until(stop: (state: GameState) => boolean, limit = 150) {
      for (let index = 0; index < limit; index += 1) {
        if (stop(session.state!)) return;
        const effect = session.state!.activeEffect;
        if (
          effect &&
          (effect.publicRevealAutoAdvanceAt !== undefined ||
            effect.publicCardSelectionAutoAdvanceAt !== undefined ||
            effect.publicEffectChoiceAutoAdvanceAt !== undefined)
        ) {
          confirmPublicSelectionIfNeeded(session);
          continue;
        }
        const outcomes = [];
        for (const playerId of PLAYERS) {
          const result = await coordinator.advanceOne(playerId);
          outcomes.push(result);
          if (result.status === 'EXECUTED') break;
        }
        if (!outcomes.some((result) => result.status === 'EXECUTED')) {
          throw new Error(
            `AI loop stalled at ${session.state!.currentPhase}/${session.state!.currentSubPhase}: ${JSON.stringify(outcomes)}`
          );
        }
      }
      throw new Error('AI loop exceeded bounded command budget');
    },
  };
}

const nextMain = (state: GameState) =>
  state.turnCount >= 2 && state.currentPhase === GamePhase.MAIN_PHASE;
const firstSet = (state: GameState) => state.currentSubPhase === SubPhase.LIVE_SET_FIRST_PLAYER;
const scoreWindow = (state: GameState) => state.currentSubPhase === SubPhase.RESULT_SCORE_CONFIRM;

async function capture(session: Session, playerId: string): Promise<LiveRequest> {
  let captured!: LiveRequest;
  const result = await new AiTurnCoordinator({
    session,
    createDecisionId: () => 'fixed-live-frame',
    provider: {
      decide(request) {
        assertLive(request);
        captured = request;
        return Promise.resolve(null);
      },
    },
  }).advanceOne(playerId);
  expect(result.status).toBe('NO_DECISION');
  return captured;
}

describe('AI real LIVE turn loop', () => {
  it('双方通过匿名决策完成一整个真实回合，规则判定/分数和成功区正确落地', async () => {
    const session = sessionWithDecks();
    const run = driver(session);
    const execute = vi.spyOn(session, 'executeCommand');
    await run.until(nextMain);
    expect(session.state?.players[0].successZone.cardIds).toHaveLength(1);
    expect(session.state?.players[1].successZone.cardIds).toHaveLength(0);
    expect(session.state?.players.every((player) => player.liveZone.cardIds.length === 0)).toBe(
      true
    );
    expect(session.state?.activeEffect).toBeNull();
    const commands = execute.mock.calls.map(([command]) => command);
    expect(
      commands
        .filter((command) => command.type === GameCommandType.SET_LIVE_CARD)
        .map((command) => command.playerId)
    ).toEqual([P1, P2]);
    expect(
      commands.filter((command) => command.type === GameCommandType.SUBMIT_JUDGMENT)
    ).toHaveLength(2);
    expect(
      commands.filter((command) => command.type === GameCommandType.SUBMIT_SCORE)
    ).toHaveLength(2);
    for (const command of commands) {
      if (command.type === GameCommandType.SET_LIVE_CARD) expect(command.faceDown).toBe(true);
      if (command.type === GameCommandType.SUBMIT_JUDGMENT)
        expect(command.judgmentResults.size).toBe(0);
      if (command.type === GameCommandType.SUBMIT_SCORE)
        expect(command.adjustedScore).toBeUndefined();
    }
    expect(run.requests.some((request) => request.window.kind === 'LIVE_ACTION')).toBe(true);
  });

  it('无 LIVE 可设置时双方空确认，仍能回到下一回合而不伪造成功牌', async () => {
    const session = sessionWithDecks({
      first: { noOpeningLive: true },
      second: { noOpeningLive: true },
    });
    const run = driver(session);
    const execute = vi.spyOn(session, 'executeCommand');
    await run.until(nextMain);
    expect(session.state?.players.every((player) => player.successZone.cardIds.length === 0)).toBe(
      true
    );
    expect(
      execute.mock.calls.some(([command]) => command.type === GameCommandType.SET_LIVE_CARD)
    ).toBe(false);
    expect(
      execute.mock.calls.some(([command]) => command.type === GameCommandType.SELECT_SUCCESS_LIVE)
    ).toBe(false);
  });

  it('真实声援无法满足指定色时保留失败判定，失败 LIVE 进休息室且由另一方获胜', async () => {
    const session = sessionWithDecks({ first: { requiredColor: HeartColor.BLUE } });
    const run = driver(session);
    await run.until(scoreWindow);
    const firstLiveId = [...session.state!.cardRegistry.values()].find(
      (card) => card.ownerId === P1 && card.data.cardCode === 'FIRST-LIVE-0'
    )!.instanceId;
    expect(session.state!.liveResolution.liveResults.get(firstLiveId)).toBe(false);
    expect(session.state!.players[0].waitingRoom.cardIds).toContain(firstLiveId);
    expect(session.state!.liveResolution.playerScores.get(P1)).toBe(0);
    await run.until(nextMain);
    expect(session.state!.players[0].successZone.cardIds).toHaveLength(0);
    expect(session.state!.players[1].successZone.cardIds).toHaveLength(1);
  });

  it('连续三个真实回合的第三张成功 LIVE 直接结束游戏，不再生成后续动作', async () => {
    const session = sessionWithDecks();
    const run = driver(session);
    const execute = vi.spyOn(session, 'executeCommand');
    await run.until((state) => state.currentPhase === GamePhase.GAME_END, 220);
    expect(session.state?.endInfo?.winnerId).toBe(P1);
    expect(session.state?.players[0].successZone.cardIds).toHaveLength(3);
    expect(execute.mock.calls.at(-1)?.[0].type).toBe(GameCommandType.SELECT_SUCCESS_LIVE);
    const before = toTransport(session.state);
    const decide = vi.fn<AiDecisionProviderV2['decide']>();
    for (const playerId of PLAYERS) {
      expect(
        (await new AiTurnCoordinator({ session, provider: { decide } }).advanceOne(playerId)).status
      ).toBe('UNAVAILABLE');
    }
    expect(decide).not.toHaveBeenCalled();
    expect(toTransport(session.state)).toEqual(before);
  });

  it('本地明确允许跳过成功区时可选择 SKIP，真实成功牌进休息室且回合继续', async () => {
    const session = sessionWithDecks({ allowSkip: true });
    const run = driver(session, { skipSuccess: true });
    await run.until(nextMain);
    expect(session.state?.players[0].successZone.cardIds).toHaveLength(0);
    expect(
      run.requests.some(
        (request) =>
          request.window.kind === 'LIVE_ACTION' &&
          request.window.candidates.some((candidate) => candidate.kind === 'SKIP_SUCCESS_LIVE')
      )
    ).toBe(true);
    const firstLiveId = [...session.state!.cardRegistry.values()].find(
      (card) => card.ownerId === P1 && card.data.cardCode === 'FIRST-LIVE-0'
    )!.instanceId;
    expect(session.state?.players[0].waitingRoom.cardIds).toContain(firstLiveId);
  });

  it('同分双胜者分别确认动画并按结算顺序各选一张，不能由首席替另一席完成', async () => {
    const session = sessionWithDecks({ second: { score: 2 } });
    const run = driver(session);
    await run.until((state) => state.currentSubPhase === SubPhase.RESULT_ANIMATION);
    expect(session.state?.liveResolution.liveWinnerIds).toEqual([P1, P2]);
    const result = await new AiTurnCoordinator({
      session,
      provider: {
        decide(request) {
          assertLive(request);
          return Promise.resolve(
            liveDecision(request, liveCandidate(request, 'CONFIRM_RESULT_ANIMATION').actionToken)
          );
        },
      },
    }).advanceOne(P1);
    expect(result.status).toBe('EXECUTED');
    expect(session.state?.currentSubPhase).toBe(SubPhase.RESULT_ANIMATION);
    expect(session.state?.liveResolution.animationConfirmedBy).toEqual([P1]);
    const decide = vi.fn<AiDecisionProviderV2['decide']>();
    expect(
      (await new AiTurnCoordinator({ session, provider: { decide } }).advanceOne(P1)).status
    ).toBe('UNAVAILABLE');
    expect(decide).not.toHaveBeenCalled();
    await run.until(nextMain);
    expect(session.state?.players.map((player) => player.successZone.cardIds.length)).toEqual([
      1, 1,
    ]);
  });

  it('对手里侧 LIVE 与隐藏手牌、未检视牌序都不进入 LIVE 决策，变换后请求不变', async () => {
    const session = sessionWithDecks();
    const run = driver(session);
    await run.until((state) => state.currentSubPhase === SubPhase.LIVE_SET_SECOND_PLAYER);
    const baseline = await capture(session, P2);
    const serialized = JSON.stringify(baseline);
    expect(serialized).not.toContain('FIRST-LIVE-0');
    expect('live' in baseline.observation).toBe(true);
    if (!('live' in baseline.observation)) throw new Error('Missing LIVE observation');
    expect(
      baseline.observation.live.players.find((player) => player.seat === 'FIRST')?.liveCards[0]
    ).toMatchObject({ faceDown: true, card: null });
    for (const value of [...session.state!.cardRegistry.keys(), P1, P2, session.state!.gameId])
      expect(serialized).not.toContain(value);
    expect(serialized).not.toContain('obj_');
    for (const player of session.state!.players) {
      for (const hiddenDeck of [player.mainDeck.cardIds, player.energyDeck.cardIds]) {
        (hiddenDeck as string[]).reverse();
        expect(await capture(session, P2)).toEqual(baseline);
        (hiddenDeck as string[]).reverse();
      }
    }
    const hiddenId = session.state!.players[0].hand.cardIds[0]!;
    const hidden = session.state!.cardRegistry.get(hiddenId)!;
    (session.state!.cardRegistry as Map<string, CardInstance>).set(hiddenId, {
      ...hidden,
      data: { ...hidden.data, cardCode: 'OPPONENT-HIDDEN-LIVE-SENTINEL' },
    });
    expect(await capture(session, P2)).toEqual(baseline);
    const readView = session.getPlayerViewState.bind(session);
    const hiddenLiveId = session.state!.players[0].liveZone.cardIds[0]!;
    const hiddenLiveObjectId = `obj_${hiddenLiveId}`;
    const legalFront = readView(P1)!.objects[hiddenLiveObjectId]!.frontInfo!;
    vi.spyOn(session, 'getPlayerViewState').mockImplementation((playerId, options) => {
      const view = readView(playerId, options);
      if (!view || playerId !== P2) return view;
      return {
        ...view,
        objects: {
          ...view.objects,
          [hiddenLiveObjectId]: {
            ...view.objects[hiddenLiveObjectId]!,
            surface: 'FRONT',
            frontInfo: { ...legalFront, cardCode: 'ACCIDENTAL-HIDDEN-FRONT-SENTINEL' },
            judgmentResult: true,
          },
        },
        match: {
          ...view.match,
          liveResult: {
            ...view.match.liveResult!,
            liveCardScoreModifiers: { [hiddenLiveObjectId]: 99 },
            requirementReductions: { [hiddenLiveObjectId]: 99 },
            requirementModifiers: {
              [hiddenLiveObjectId]: [
                { color: HeartColor.GREEN, countDelta: 99, sourceCardId: hiddenLiveId },
              ],
            },
          },
        },
      };
    });
    // Even an upstream accidental front projection must not make a face-down opponent LIVE public.
    expect(await capture(session, P2)).toEqual(baseline);
  });

  it.each([
    {
      label: '判定布尔值',
      subPhase: SubPhase.PERFORMANCE_JUDGMENT,
      field: { judgmentResults: { forged: true } },
    },
    { label: '手动分数', subPhase: SubPhase.RESULT_SCORE_CONFIRM, field: { adjustedScore: 99 } },
  ])('拒绝 AI 注入$label，权威结果和命令日志不变', async ({ subPhase, field }) => {
    const session = sessionWithDecks();
    await driver(session).until((state) => state.currentSubPhase === subPhase);
    const before = toTransport(session.state);
    const execute = vi.spyOn(session, 'executeCommand');
    const provider: AiDecisionProviderV2 = {
      decide(request) {
        return Promise.resolve({ ...choose(request), ...field } as AiDecisionV2);
      },
    };
    expect((await new AiTurnCoordinator({ session, provider }).advanceOne(P1)).status).toBe(
      'REJECTED'
    );
    expect(execute).not.toHaveBeenCalled();
    expect(toTransport(session.state)).toEqual(before);
  });

  it('设置完成引发真实补牌和换席后，旧 LIVE 设置决策在途响应失效', async () => {
    const session = sessionWithDecks();
    await driver(session).until(firstSet);
    const cardId = session.state!.players[0].hand.cardIds.find(
      (id) => session.state!.cardRegistry.get(id)?.data.cardType === CardType.LIVE
    )!;
    expect(session.executeCommand(createSetLiveCardCommand(P1, cardId, true)).success).toBe(true);
    let release!: (decision: AiDecisionV2) => void;
    let started!: () => void;
    let oldRequest!: LiveRequest;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new AiTurnCoordinator({
      session,
      provider: {
        decide(request) {
          assertLive(request);
          oldRequest = request;
          started();
          return new Promise<AiDecisionV2>((resolve) => {
            release = resolve;
          });
        },
      },
    }).advanceOne(P1);
    await waiting;
    const beforeHand = [...session.state!.players[0].hand.cardIds];
    expect(
      session.executeCommand(createConfirmStepCommand(P1, SubPhase.LIVE_SET_FIRST_PLAYER)).success
    ).toBe(true);
    expect(session.state!.players[0].hand.cardIds).toHaveLength(beforeHand.length + 1);
    expect(session.state!.currentSubPhase).toBe(SubPhase.LIVE_SET_SECOND_PLAYER);
    const afterLegitimateCommand = toTransport(session.state);
    const execute = vi.spyOn(session, 'executeCommand');
    release(liveDecision(oldRequest, liveCandidate(oldRequest, 'CONFIRM_LIVE_SET').actionToken));
    await expect(pending).resolves.toMatchObject({ status: 'STALE' });
    expect(execute).not.toHaveBeenCalled();
    expect(toTransport(session.state)).toEqual(afterLegitimateCommand);
  });

  it('真实 LIVE 开始和成功单弃效果继续复用 EFFECT_STEP，结束后继续判分与成功区选择', async () => {
    const session = sessionWithDecks({
      first: { memberCode: 'PL!N-bp5-016-N', memberCost: 2, liveCode: 'PL!HS-bp6-030-L' },
    });
    const run = driver(session);
    await run.until(nextMain);
    for (const abilityId of [
      HS_BP6_030_LIVE_START_DRAW_ONE_DISCARD_ONE_ABILITY_ID,
      MEMBER_LIVE_SUCCESS_DRAW_ONE_DISCARD_ONE_ABILITY_ID,
    ]) {
      expect(
        session.state!.actionHistory.some(
          (action) => action.type === 'RESOLVE_ABILITY' && action.payload.abilityId === abilityId
        )
      ).toBe(true);
    }
    const effectPhases = run.requests
      .filter((request) => request.window.kind === 'EFFECT_STEP')
      .map((request) => request.observation.match.phase);
    expect(effectPhases).toContain(GamePhase.PERFORMANCE_PHASE);
    expect(effectPhases).toContain(GamePhase.LIVE_RESULT_PHASE);
    expect(session.state?.players[0].successZone.cardIds).toHaveLength(1);
  });

  it('真实 LIVE 成功声援回收的公开停留不能被 AI 继续或提前收入手牌', async () => {
    const session = sessionWithDecks({
      first: { liveCode: 'PL!HS-bp1-021-L', liveInFirstCheer: true },
    });
    const run = driver(session);
    await run.until((state) => state.activeEffect?.publicCardSelectionAutoAdvanceAt !== undefined);
    expect(session.state?.currentPhase).toBe(GamePhase.LIVE_RESULT_PHASE);
    const revealedId = session.state!.activeEffect!.revealedCardIds![0]!;
    expect(session.state!.players[0].hand.cardIds).not.toContain(revealedId);
    const before = toTransport(session.state);
    const decide = vi.fn<AiDecisionProviderV2['decide']>();
    for (const playerId of PLAYERS)
      expect(
        (await new AiTurnCoordinator({ session, provider: { decide } }).advanceOne(playerId)).status
      ).toBe('UNAVAILABLE');
    expect(decide).not.toHaveBeenCalled();
    expect(toTransport(session.state)).toEqual(before);
    confirmPublicSelectionIfNeeded(session);
    expect(session.state!.players[0].hand.cardIds).toContain(revealedId);
    await run.until(nextMain);
    expect(session.state!.players[0].successZone.cardIds).toHaveLength(1);
  });
});
