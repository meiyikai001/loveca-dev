import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AiDecisionProviderV2,
  AiDecisionRequestV2,
  AiDecisionV2,
} from '../../src/application/ai/ai-decision-contract';
import {
  ABILITY_ORDER_SELECTION_ID,
  HS_BP1_006_ON_ENTER_DRAW_DISCARD_ABILITY_ID,
  HS_BP6_001_ON_ENTER_LOOK_STAGE_PLUS_TWO_ABILITY_ID,
  HS_PB1_009_ON_HASUNOSORA_ENTER_GAIN_BLADE_ABILITY_ID,
} from '../../src/application/card-effect-runner';
import { PUBLIC_REVEAL_DWELL_STEP_ID } from '../../src/application/card-effects/runtime/public-reveal-dwell';
import {
  createConfirmEffectStepCommand,
  createMulliganCommand,
  createPlayMemberToSlotCommand,
  GameCommandType,
} from '../../src/application/game-commands';
import { createGameSession } from '../../src/application/game-session';
import type { DeckConfig } from '../../src/application/game-service';
import {
  createCardInstance,
  createHeartIcon,
  createHeartRequirement,
  type CardInstance,
  type LiveCardData,
  type MemberCardData,
} from '../../src/domain/entities/card';
import {
  registerCards,
  updatePlayer,
  type ActiveEffectState,
  type GameState,
} from '../../src/domain/entities/game';
import { placeCardInSlot } from '../../src/domain/entities/zone';
import { toTransport } from '../../src/online/serde';
import { AiTurnCoordinator } from '../../src/server/services/ai-turn-coordinator';
import {
  CardType,
  FaceState,
  GamePhase,
  HeartColor,
  OrientationState,
  SlotPosition,
  SubPhase,
} from '../../src/shared/types/enums';
import { confirmPublicSelectionIfNeeded } from '../helpers/public-card-selection-confirmation';

const AI = 'effect-ai-player-private-id';
const OPPONENT = 'effect-human-player-private-id';
type Session = ReturnType<typeof createGameSession>;
type EffectRequest = AiDecisionRequestV2 & {
  readonly window: Extract<AiDecisionRequestV2['window'], { readonly kind: 'EFFECT_STEP' }>;
};
type EffectCandidate = EffectRequest['window']['candidates'][number];

afterEach(() => vi.restoreAllMocks());

function memberData(cardCode: string, name = cardCode, cost = 1): MemberCardData {
  return {
    cardCode,
    name,
    cardType: CardType.MEMBER,
    cost,
    blade: 1,
    hearts: [createHeartIcon(HeartColor.GREEN, 1)],
    groupNames: ['蓮ノ空女学院スクールアイドルクラブ'],
  };
}

function member(cardCode: string, name = cardCode, cost = 1): CardInstance {
  return createCardInstance(memberData(cardCode, name, cost), AI, `private-instance-${cardCode}`);
}

function liveData(cardCode: string): LiveCardData {
  return {
    cardCode,
    name: cardCode,
    cardType: CardType.LIVE,
    groupNames: ['蓮ノ空女学院スクールアイドルクラブ'],
    score: 2,
    requirements: createHeartRequirement({ [HeartColor.GREEN]: 2 }),
  };
}

function live(cardCode: string): CardInstance {
  return createCardInstance(liveData(cardCode), AI, `private-instance-${cardCode}`);
}

function deck(prefix: string): DeckConfig {
  return {
    mainDeck: [
      ...Array.from({ length: 48 }, (_, index) => memberData(`${prefix}-MEM-${index}`)),
      ...Array.from({ length: 12 }, (_, index) => liveData(`${prefix}-LIVE-${index}`)),
    ],
    energyDeck: Array.from({ length: 12 }, (_, index) => ({
      cardCode: `${prefix}-ENERGY-${index}`,
      name: `Energy ${index}`,
      cardType: CardType.ENERGY,
    })),
  };
}

/** Fixture setup alone places cards; every tested effect starts with a real RULES command. */
function scenario(options: {
  readonly source: CardInstance;
  readonly hand?: readonly CardInstance[];
  readonly top: readonly CardInstance[];
  readonly waiting?: readonly CardInstance[];
  readonly stage?: readonly (readonly [SlotPosition, CardInstance])[];
  readonly slot?: SlotPosition;
  readonly relayMode?: 'SINGLE';
}) {
  const session = createGameSession({ randomInt: (maxExclusive) => maxExclusive - 1 });
  session.createGame('private-ai-effect-game-id', AI, 'AI', OPPONENT, 'Human');
  expect(session.initializeGame(deck('SELF'), deck('OPPONENT')).success).toBe(true);
  expect(session.executeCommand(createMulliganCommand(AI, [])).success).toBe(true);
  expect(session.executeCommand(createMulliganCommand(OPPONENT, [])).success).toBe(true);
  expect(session.state?.currentPhase).toBe(GamePhase.MAIN_PHASE);
  expect(session.state?.currentSubPhase).toBe(SubPhase.NONE);

  const cards = [
    options.source,
    ...(options.hand ?? []),
    ...options.top,
    ...(options.waiting ?? []),
    ...(options.stage ?? []).map(([, card]) => card),
  ];
  let state = registerCards(session.state!, cards);
  const energyIds = [...state.cardRegistry.values()]
    .filter((card) => card.ownerId === AI && card.data.cardType === CardType.ENERGY)
    .map((card) => card.instanceId);
  state = updatePlayer(state, AI, (player) => {
    let memberSlots = player.memberSlots;
    for (const [slot, card] of options.stage ?? []) {
      memberSlots = placeCardInSlot(memberSlots, slot, card.instanceId, {
        orientation: OrientationState.ACTIVE,
        face: FaceState.FACE_UP,
      });
    }
    return {
      ...player,
      hand: {
        ...player.hand,
        cardIds: [
          options.source.instanceId,
          ...(options.hand ?? []).map((card) => card.instanceId),
        ],
      },
      mainDeck: { ...player.mainDeck, cardIds: options.top.map((card) => card.instanceId) },
      waitingRoom: {
        ...player.waitingRoom,
        cardIds: (options.waiting ?? []).map((card) => card.instanceId),
      },
      energyDeck: { ...player.energyDeck, cardIds: [] },
      energyZone: {
        ...player.energyZone,
        cardIds: energyIds,
        cardStates: new Map(
          energyIds.map((id) => [
            id,
            {
              orientation: OrientationState.ACTIVE,
              face: FaceState.FACE_UP,
            },
          ])
        ),
      },
      memberSlots,
      movedToStageThisTurn: [],
    };
  });
  (session as unknown as { authorityState: GameState }).authorityState = state;
  const play = session.executeCommand(
    createPlayMemberToSlotCommand(
      AI,
      options.source.instanceId,
      options.slot ?? SlotPosition.LEFT,
      {
        relayMode: options.relayMode,
      }
    )
  );
  expect(play.success, play.error).toBe(true);
  expect(session.state?.activeEffect).not.toBeNull();
  return session;
}

function assertEffectRequest(request: AiDecisionRequestV2): asserts request is EffectRequest {
  if (request.window.kind !== 'EFFECT_STEP') throw new Error('Expected real EFFECT_STEP request');
}

function decision(request: AiDecisionRequestV2, selectedActionToken: string): AiDecisionV2 {
  assertEffectRequest(request);
  return {
    schemaVersion: request.schemaVersion,
    decisionId: request.decisionId,
    contextDigest: request.contextDigest,
    kind: 'EFFECT_STEP',
    selectedActionToken,
  };
}

function chooseCard(request: EffectRequest, card: CardInstance): EffectCandidate {
  const candidate = request.window.candidates.find(
    (item) => item.kind === 'SELECT_CARD' && item.card.cardCode === card.data.cardCode
  );
  if (!candidate) throw new Error(`Missing visible card candidate: ${card.data.cardCode}`);
  return candidate;
}

async function advance(session: Session, select: (request: EffectRequest) => EffectCandidate) {
  const decide = vi.fn<AiDecisionProviderV2['decide']>((request) => {
    assertEffectRequest(request);
    return Promise.resolve(decision(request, select(request).actionToken));
  });
  const result = await new AiTurnCoordinator({ session, provider: { decide } }).advanceOne(AI);
  expect(result).toMatchObject({
    status: 'EXECUTED',
    commandType: GameCommandType.CONFIRM_EFFECT_STEP,
  });
  expect(decide).toHaveBeenCalledTimes(1);
  return decide.mock.calls[0]![0] as EffectRequest;
}

async function capture(session: Session): Promise<EffectRequest> {
  let captured!: EffectRequest;
  const result = await new AiTurnCoordinator({
    session,
    createDecisionId: () => 'fixed-effect-decision',
    provider: {
      decide(request) {
        assertEffectRequest(request);
        captured = request;
        return Promise.resolve(null);
      },
    },
  }).advanceOne(AI);
  expect(result.status).toBe('NO_DECISION');
  return captured;
}

function izumiScenario() {
  const source = member('PL!HS-bp5-008-R', '桂城 泉', 4);
  const discard = member('VISIBLE-DISCARD');
  const target = member('VISIBLE-HIGH-COST-TARGET', '村野さやか', 9);
  const nonTargets = [
    member('INSPECTED-LOW-COST'),
    live('INSPECTED-LIVE'),
    member('INSPECTED-LOW-TWO'),
    member('INSPECTED-LOW-THREE'),
  ];
  const rest = [member('UNINSPECTED-SECRET-ONE'), member('UNINSPECTED-SECRET-TWO')];
  return {
    session: scenario({ source, hand: [discard], top: [target, ...nonTargets, ...rest] }),
    source,
    discard,
    target,
    nonTargets,
    rest,
  };
}

describe('AI EFFECT_STEP real command integration', () => {
  it('登场抽二弃一只接受匿名单卡 token，并由正式确认命令完成后返回主要阶段', async () => {
    const source = member('PL!HS-bp1-006-P', '藤島 慈', 11);
    const drawn = [member('DRAWN-KEEP'), member('DRAWN-DISCARD')];
    const rest = member('UNSEEN-DRAW-REMAINDER');
    const session = scenario({ source, top: [...drawn, rest] });
    expect(session.state?.activeEffect?.abilityId).toBe(
      HS_BP1_006_ON_ENTER_DRAW_DISCARD_ABILITY_ID
    );
    expect(session.state?.players[0].hand.cardIds).toEqual(drawn.map((card) => card.instanceId));
    const effectId = session.state!.activeEffect!.id;
    const execute = vi.spyOn(session, 'executeCommand');

    const request = await advance(session, (frame) => chooseCard(frame, drawn[1]!));

    expect(request.window.sourceCard?.cardCode).toBe(source.data.cardCode);
    expect(request.window.effectText).toBeTruthy();
    expect(request.window.candidates).toHaveLength(2);
    expect(
      request.window.candidates.every(
        (candidate) => candidate.kind === 'SELECT_CARD' && candidate.ownerSeat === 'FIRST'
      )
    ).toBe(true);
    expect('self' in request.observation && request.observation.self.hand).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toMatchObject({
      type: GameCommandType.CONFIRM_EFFECT_STEP,
      playerId: AI,
      effectId,
      selectedCardId: drawn[1]!.instanceId,
    });
    expect(session.state?.players[0].hand.cardIds).toEqual([drawn[0]!.instanceId]);
    expect(session.state?.players[0].waitingRoom.cardIds).toEqual([drawn[1]!.instanceId]);
    expect(session.state?.players[0].mainDeck.cardIds).toEqual([rest.instanceId]);
    expect(session.state?.activeEffect).toBeNull();
    expect(session.getRulesMainActionCandidates(AI).length).toBeGreaterThan(0);
  });

  it('真实私密看顶留一以 exact-one ORDERED_MULTI 绑定提交，保留未检视牌序', async () => {
    const source = member('PL!HS-bp6-001-R+', '日野下花帆', 4);
    const top = [member('LOOK-FIRST'), live('LOOK-SELECTED'), member('LOOK-THIRD')];
    const rest = member('LOOK-UNSEEN-REMAINDER');
    const session = scenario({ source, top: [...top, rest] });
    expect(session.state?.activeEffect).toMatchObject({
      abilityId: HS_BP6_001_ON_ENTER_LOOK_STAGE_PLUS_TWO_ABILITY_ID,
      selectableCardMode: 'ORDERED_MULTI',
      minSelectableCards: 1,
      maxSelectableCards: 1,
    });
    const execute = vi.spyOn(session, 'executeCommand');

    const request = await advance(session, (frame) => chooseCard(frame, top[1]!));

    expect(request.window.candidates).toHaveLength(3);
    expect(JSON.stringify(request)).not.toContain(rest.data.cardCode);
    expect(execute.mock.calls[0]![0]).toMatchObject({ selectedCardIds: [top[1]!.instanceId] });
    expect(execute.mock.calls[0]![0]).not.toHaveProperty('selectedCardId', top[1]!.instanceId);
    expect(session.state?.players[0].mainDeck.cardIds).toEqual([
      top[1]!.instanceId,
      rest.instanceId,
    ]);
    expect(session.state?.players[0].waitingRoom.cardIds).toEqual([
      top[0]!.instanceId,
      top[2]!.instanceId,
    ]);
    expect(session.state?.inspectionZone.cardIds).toEqual([]);
    expect(session.state?.activeEffect).toBeNull();
  });

  it('可选单弃衔接合法检视候选；公开停留不会交给 AI 确认或提前入手', async () => {
    const { session, source, discard, target, nonTargets } = izumiScenario();
    await advance(session, (frame) => {
      expect(frame.window.candidates.some((candidate) => candidate.kind === 'SKIP')).toBe(true);
      return chooseCard(frame, discard);
    });
    expect(
      session.state?.players[0].memberSlots.cardStates.get(source.instanceId)?.orientation
    ).toBe(OrientationState.WAITING);
    expect(session.state?.inspectionZone.revealedCardIds).toEqual([]);
    const privateRequest = await advance(session, (frame) => {
      expect(
        frame.window.candidates.filter((candidate) => candidate.kind === 'SELECT_CARD')
      ).toHaveLength(1);
      for (const nonTarget of nonTargets)
        expect(JSON.stringify(frame)).not.toContain(nonTarget.data.cardCode);
      return chooseCard(frame, target);
    });
    expect(privateRequest.window.sourceCard?.cardCode).toBe(source.data.cardCode);
    expect(session.state?.activeEffect?.stepId).toBe(PUBLIC_REVEAL_DWELL_STEP_ID);
    expect(session.state?.players[0].hand.cardIds).not.toContain(target.instanceId);
    expect(session.getPlayerViewState(OPPONENT)?.activeEffect?.revealedObjectIds).toEqual([
      `obj_${target.instanceId}`,
    ]);
    const before = toTransport(session.state);
    const decide = vi.fn<AiDecisionProviderV2['decide']>();
    const execute = vi.spyOn(session, 'executeCommand');

    const blocked = await new AiTurnCoordinator({ session, provider: { decide } }).advanceOne(AI);

    expect(blocked.status).toBe('UNAVAILABLE');
    expect(decide).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(toTransport(session.state)).toEqual(before);
    confirmPublicSelectionIfNeeded(session);
    expect(session.state?.players[0].hand.cardIds).toEqual([target.instanceId]);
    expect(session.state?.activeEffect).toBeNull();
  });

  it('显式不发动保留手牌和来源朝向，不把空选推断成无输入确认', async () => {
    const { session, source, discard } = izumiScenario();
    await advance(session, (frame) => {
      const skip = frame.window.candidates.find((candidate) => candidate.kind === 'SKIP');
      if (!skip) throw new Error('Missing explicit optional decline');
      return skip;
    });
    expect(session.state?.players[0].hand.cardIds).toEqual([discard.instanceId]);
    expect(
      session.state?.players[0].memberSlots.cardStates.get(source.instanceId)?.orientation
    ).toBe(OrientationState.ACTIVE);
    expect(session.state?.inspectionZone.cardIds).toEqual([]);
    expect(session.state?.activeEffect).toBeNull();
  });

  it('真实单换手登场后从公开休息室回收，只在选卡展示结束后加入手牌', async () => {
    const source = member('PL!HS-sd1-006-SD', '安養寺 姫芽', 15);
    const target = live('RECOVER-HASUNOSORA-LIVE');
    const other = createCardInstance(
      { ...liveData('RECOVER-INELIGIBLE-LIVE'), groupNames: ['Aqours'] },
      AI,
      'private-ineligible-recovery-id'
    );
    const replaced = member('RELAY-THREE-COST', 'Relay member', 3);
    const session = scenario({
      source,
      top: [member('RECOVER-REMAINDER')],
      waiting: [target, other],
      stage: [
        [SlotPosition.LEFT, member('RELATED-RURINO', '大沢瑠璃乃')],
        [SlotPosition.CENTER, replaced],
      ],
      slot: SlotPosition.CENTER,
      relayMode: 'SINGLE',
    });
    expect(session.state?.players[0].memberSlots.slots.CENTER).toBe(source.instanceId);
    expect(session.state?.players[0].waitingRoom.cardIds).toContain(replaced.instanceId);
    const request = await advance(session, (frame) => chooseCard(frame, target));
    expect(
      request.window.candidates.filter((candidate) => candidate.kind === 'SELECT_CARD')
    ).toHaveLength(1);
    expect(JSON.stringify(request)).not.toContain(other.data.cardCode);
    expect(session.state?.activeEffect?.publicCardSelectionAutoAdvanceAt).toBeDefined();
    expect(session.state?.players[0].hand.cardIds).toEqual([]);
    const decide = vi.fn<AiDecisionProviderV2['decide']>();
    expect(
      (await new AiTurnCoordinator({ session, provider: { decide } }).advanceOne(AI)).status
    ).toBe('UNAVAILABLE');
    expect(decide).not.toHaveBeenCalled();
    confirmPublicSelectionIfNeeded(session);
    expect(session.state?.players[0].hand.cardIds).toEqual([target.instanceId]);
    expect(session.state?.players[0].waitingRoom.cardIds).toEqual([
      other.instanceId,
      replaced.instanceId,
    ]);
    expect(session.state?.activeEffect).toBeNull();
  });

  it('同一登场队列先选择真实效果，再确认无输入 AUTO，并继续抽弃', async () => {
    const source = member('PL!HS-bp1-006-P', '藤島 慈', 11);
    const kaho = member('PL!HS-pb1-009-R', '日野下花帆', 15);
    const drawn = [member('ORDER-DRAW-FIRST'), member('ORDER-DRAW-SECOND')];
    const session = scenario({
      source,
      stage: [[SlotPosition.CENTER, kaho]],
      top: [...drawn, member('ORDER-REMAINDER')],
    });
    expect(session.state?.activeEffect?.abilityId).toBe(ABILITY_ORDER_SELECTION_ID);

    await advance(session, (frame) => chooseCard(frame, kaho));

    expect(session.state?.activeEffect?.abilityId).toBe(
      HS_PB1_009_ON_HASUNOSORA_ENTER_GAIN_BLADE_ABILITY_ID
    );
    expect(session.state?.activeEffect?.metadata?.confirmOnlyPendingAbility).toBe(true);
    expect(session.state?.liveResolution.liveModifiers).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceCardId: kaho.instanceId })])
    );
    await advance(session, (frame) => {
      expect(frame.window.candidates).toHaveLength(1);
      expect(frame.window.candidates[0]?.kind).toBe('CONFIRM');
      return frame.window.candidates[0]!;
    });
    expect(session.state?.liveResolution.liveModifiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'BLADE',
          sourceCardId: kaho.instanceId,
          countDelta: 2,
        }),
      ])
    );
    expect(session.state?.activeEffect?.abilityId).toBe(
      HS_BP1_006_ON_ENTER_DRAW_DISCARD_ABILITY_ID
    );
    await advance(session, (frame) => chooseCard(frame, drawn[0]!));
    expect(session.state?.activeEffect).toBeNull();
    expect(session.state?.pendingAbilities).toEqual([]);
    expect(session.state?.players[0].hand.cardIds).toEqual([drawn[1]!.instanceId]);
  });

  it('隐藏牌库顺序和对手手牌身份不改变请求，只输出本步骤合法且可见的检视候选', async () => {
    const { session, discard, target, nonTargets, rest } = izumiScenario();
    expect(
      session.executeCommand(
        createConfirmEffectStepCommand(AI, session.state!.activeEffect!.id, discard.instanceId)
      ).success
    ).toBe(true);
    const baseline = await capture(session);
    const serialized = JSON.stringify(baseline);
    expect(serialized).toContain(target.data.cardCode);
    for (const card of [...nonTargets, ...rest])
      expect(serialized).not.toContain(card.data.cardCode);
    for (const id of [
      ...session.state!.cardRegistry.keys(),
      AI,
      OPPONENT,
      session.state!.gameId,
      session.state!.activeEffect!.id,
    ]) {
      expect(serialized).not.toContain(id);
    }
    expect(serialized).not.toContain('obj_');
    const opponentView = session.getPlayerViewState(OPPONENT)!;
    expect(opponentView.activeEffect?.inspectionObjectIds).toBeUndefined();
    expect(opponentView.activeEffect?.selectableObjectIds).toBeUndefined();
    expect(opponentView.objects[`obj_${target.instanceId}`]?.frontInfo).toBeUndefined();

    for (const player of session.state!.players) {
      for (const hiddenDeck of [player.mainDeck.cardIds, player.energyDeck.cardIds]) {
        (hiddenDeck as string[]).reverse();
        expect(await capture(session)).toEqual(baseline);
        (hiddenDeck as string[]).reverse();
      }
    }
    const opponentCardId = session.state!.players[1].hand.cardIds[0]!;
    const opponentCard = session.state!.cardRegistry.get(opponentCardId)!;
    (session.state!.cardRegistry as Map<string, CardInstance>).set(opponentCardId, {
      ...opponentCard,
      data: memberData('FORBIDDEN-OPPONENT-HAND-SENTINEL'),
    });
    expect(await capture(session)).toEqual(baseline);
    const decide = vi.fn<AiDecisionProviderV2['decide']>();
    expect(
      (await new AiTurnCoordinator({ session, provider: { decide } }).advanceOne(OPPONENT)).status
    ).toBe('UNAVAILABLE');
    expect(decide).not.toHaveBeenCalled();
  });

  it.each([
    'raw-id',
    'unknown-token',
    'cross-field',
    'raw-effect-id',
    'raw-command',
    'forged-digest',
  ] as const)('拒绝 %s 响应，且不执行命令或改变当前步骤', async (kind) => {
    const { session, discard } = izumiScenario();
    const before = toTransport(session.state);
    const execute = vi.spyOn(session, 'executeCommand');
    const provider: AiDecisionProviderV2 = {
      decide(request) {
        assertEffectRequest(request);
        const valid = decision(request, chooseCard(request, discard).actionToken);
        const malformed = {
          'raw-id': { ...valid, selectedActionToken: discard.instanceId },
          'unknown-token': { ...valid, selectedActionToken: 'not-offered-action' },
          'cross-field': { ...valid, selectedCardIds: [discard.instanceId] },
          'raw-effect-id': { ...valid, effectId: session.state!.activeEffect!.id },
          'raw-command': {
            ...valid,
            command: createConfirmEffectStepCommand(
              AI,
              session.state!.activeEffect!.id,
              discard.instanceId
            ),
          },
          'forged-digest': { ...valid, contextDigest: 'sha256:forged' },
        }[kind];
        return Promise.resolve(malformed as AiDecisionV2);
      },
    };
    expect((await new AiTurnCoordinator({ session, provider }).advanceOne(AI)).status).toBe(
      'REJECTED'
    );
    expect(execute).not.toHaveBeenCalled();
    expect(toTransport(session.state)).toEqual(before);
  });

  it('模型在途期间同一效果已从弃牌进入检视时，丢弃旧步骤响应', async () => {
    const { session, discard } = izumiScenario();
    let release!: (decision: AiDecisionV2) => void;
    let started!: () => void;
    let request!: EffectRequest;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const provider: AiDecisionProviderV2 = {
      async decide(received) {
        assertEffectRequest(received);
        request = received;
        started();
        return new Promise<AiDecisionV2>((resolve) => {
          release = resolve;
        });
      },
    };
    const pending = new AiTurnCoordinator({ session, provider }).advanceOne(AI);
    await waiting;
    const beforeStep = session.state!.activeEffect!.stepId;
    expect(
      session.executeCommand(
        createConfirmEffectStepCommand(AI, session.state!.activeEffect!.id, discard.instanceId)
      ).success
    ).toBe(true);
    expect(session.state!.activeEffect!.stepId).not.toBe(beforeStep);
    const afterLegitimateCommand = toTransport(session.state);
    const execute = vi.spyOn(session, 'executeCommand');
    release(decision(request, chooseCard(request, discard).actionToken));
    await expect(pending).resolves.toMatchObject({ status: 'STALE' });
    expect(execute).not.toHaveBeenCalled();
    expect(toTransport(session.state)).toEqual(afterLegitimateCommand);
  });

  it('真实弃二进入独立多选窗口，随后保留分组回收约束', async () => {
    const session = scenario({
      source: member('PL!HS-pb1-020-N', '百生吟子', 9),
      hand: [member('MULTI-DISCARD-ONE'), member('MULTI-DISCARD-TWO')],
      top: [member('MULTI-REMAINDER')],
      waiting: [live('WAITING-LIVE-ONE'), live('WAITING-LIVE-TWO'), live('WAITING-LIVE-THREE')],
    });
    expect(session.state?.activeEffect).toMatchObject({
      selectableCardMode: 'ORDERED_MULTI',
      minSelectableCards: 2,
      maxSelectableCards: 2,
    });
    const decide = vi.fn<AiDecisionProviderV2['decide']>((request) => {
      if (request.window.kind !== 'EFFECT_CARD_SELECTION')
        throw new Error('Expected multi selection');
      expect(request.window.minSelections).toBe(2);
      expect(request.window.maxSelections).toBe(2);
      return Promise.resolve({
        schemaVersion: request.schemaVersion,
        decisionId: request.decisionId,
        contextDigest: request.contextDigest,
        kind: 'EFFECT_CARD_SELECTION',
        choice: 'SELECT',
        selectedCardTokens: request.window.candidates.map((candidate) => candidate.cardToken),
      });
    });
    expect(
      (await new AiTurnCoordinator({ session, provider: { decide } }).advanceOne(AI)).status
    ).toBe('EXECUTED');
    expect(decide).toHaveBeenCalledTimes(1);
    expect(session.state!.players[0].hand.cardIds).toEqual([]);
    expect(session.getRulesEffectCardSelection(AI)).toMatchObject({
      minSelections: 1,
      maxSelections: 1,
    });
    expect(session.getRulesEffectCardSelection(AI)?.groups).toHaveLength(2);
  });

  it.each([
    { label: '盲选', patch: { selectableCardVisibility: 'AWAITING_PLAYER_BLIND' } },
    { label: '数字输入', patch: { numericInput: { min: 0, max: 3 } } },
    { label: '站位复合选择', patch: { stageFormation: { playerId: AI, slots: [] } } },
    {
      label: '多效果选项',
      patch: {
        effectChoice: {
          mode: 'MULTI',
          minSelections: 1,
          maxSelections: 2,
          publicConfirmation: true,
          options: [
            { id: 'a', text: 'A' },
            { id: 'b', text: 'B' },
          ],
        },
      },
    },
  ] satisfies readonly { label: string; patch: Partial<ActiveEffectState> }[])(
    '未支持的$label保持关闭，不因同时存在单卡候选而执行',
    async ({ patch }) => {
      const { session } = izumiScenario();
      (session as unknown as { authorityState: GameState }).authorityState = {
        ...session.state!,
        activeEffect: { ...session.state!.activeEffect!, ...patch },
      };
      const before = toTransport(session.state);
      const decide = vi.fn<AiDecisionProviderV2['decide']>();
      expect(
        (await new AiTurnCoordinator({ session, provider: { decide } }).advanceOne(AI)).status
      ).toBe('UNAVAILABLE');
      expect(decide).not.toHaveBeenCalled();
      expect(toTransport(session.state)).toEqual(before);
    }
  );
});
