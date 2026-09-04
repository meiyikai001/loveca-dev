import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AiDecisionProviderV2,
  AiDecisionRequestV2,
  AiDecisionV2,
} from '../../src/application/ai/ai-decision-contract';
import {
  buildAiDecisionFrameV2,
  type TrustedMainActionCandidateV2,
} from '../../src/application/ai/ai-decision-frame';
import {
  HS_BP1_002_ACTIVATED_PLAY_HASUNOSORA_MEMBER_TO_SOURCE_SLOT_ABILITY_ID,
  HS_BP1_006_ON_ENTER_DRAW_DISCARD_ABILITY_ID,
  HS_SD1_006_ON_ENTER_ACTIVATE_ENERGY_RECOVER_LIVE_ABILITY_ID,
} from '../../src/application/card-effects/ability-ids';
import {
  createActivateAbilityCommand,
  createEndPhaseCommand,
  createMulliganCommand,
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
import { registerCards, updatePlayer, type GameState } from '../../src/domain/entities/game';
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
} from '../../src/shared/types/enums';
import { confirmPublicSelectionIfNeeded } from '../helpers/public-card-selection-confirmation';

const AI = 'activated-ai-private-player';
const OTHER = 'activated-opponent-private-player';
const SAYAKA_ABILITY = HS_BP1_002_ACTIVATED_PLAY_HASUNOSORA_MEMBER_TO_SOURCE_SLOT_ABILITY_ID;
type Session = ReturnType<typeof createGameSession>;
type MainRequest = AiDecisionRequestV2 & {
  readonly window: Extract<AiDecisionRequestV2['window'], { readonly kind: 'MAIN_ACTION' }>;
};
type MainCandidate = MainRequest['window']['candidates'][number];
type EffectRequest = AiDecisionRequestV2 & {
  readonly window: Extract<AiDecisionRequestV2['window'], { readonly kind: 'EFFECT_STEP' }>;
};

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
  return createCardInstance(memberData(cardCode, name, cost), AI, `private-activated-${cardCode}`);
}

function deck(prefix: string): DeckConfig {
  return {
    mainDeck: [
      ...Array.from({ length: 48 }, (_, index) => memberData(`${prefix}-MEM-${index}`)),
      ...Array.from({ length: 12 }, (_, index): LiveCardData => ({
        cardCode: `${prefix}-LIVE-${index}`,
        name: `${prefix} LIVE ${index}`,
        cardType: CardType.LIVE,
        score: 1,
        requirements: createHeartRequirement({ [HeartColor.GREEN]: 1 }),
      })),
    ],
    energyDeck: Array.from({ length: 12 }, (_, index) => ({
      cardCode: `${prefix}-ENERGY-${index}`,
      name: `Energy ${index}`,
      cardType: CardType.ENERGY,
    })),
  };
}

/** Seeds only the starting board; all activation, payment, revival, and on-enter steps use commands. */
function scenario(
  options: {
    readonly sourceCode?: string;
    readonly sourceSlot?: SlotPosition;
    readonly activeEnergy?: number;
    readonly hand?: readonly CardInstance[];
    readonly waiting?: readonly CardInstance[];
    readonly top?: readonly CardInstance[];
    readonly otherStage?: readonly (readonly [SlotPosition, CardInstance])[];
  } = {}
) {
  const source = member(options.sourceCode ?? 'PL!HS-bp1-002-RM', '村野沙耶香', 11);
  const sourceSlot = options.sourceSlot ?? SlotPosition.CENTER;
  const top = options.top ?? [member('UNSEEN-A'), member('UNSEEN-B'), member('UNSEEN-C')];
  const session = createGameSession({ randomInt: (maxExclusive) => maxExclusive - 1 });
  session.createGame('private-ai-activated-game', AI, 'AI', OTHER, 'Other');
  expect(session.initializeGame(deck('SELF'), deck('OPPONENT')).success).toBe(true);
  expect(session.executeCommand(createMulliganCommand(AI, [])).success).toBe(true);
  expect(session.executeCommand(createMulliganCommand(OTHER, [])).success).toBe(true);
  expect(session.state?.currentPhase).toBe(GamePhase.MAIN_PHASE);
  const cards = [
    source,
    ...top,
    ...(options.hand ?? []),
    ...(options.waiting ?? []),
    ...(options.otherStage ?? []).map(([, card]) => card),
  ];
  let state = registerCards(session.state!, cards);
  const allEnergyIds = [...state.cardRegistry.values()]
    .filter((card) => card.ownerId === AI && card.data.cardType === CardType.ENERGY)
    .map((card) => card.instanceId);
  const energyIds = allEnergyIds.slice(0, 4);
  state = updatePlayer(state, AI, (player) => {
    let memberSlots = placeCardInSlot(player.memberSlots, sourceSlot, source.instanceId, {
      orientation: OrientationState.ACTIVE,
      face: FaceState.FACE_UP,
    });
    for (const [slot, card] of options.otherStage ?? []) {
      memberSlots = placeCardInSlot(memberSlots, slot, card.instanceId, {
        orientation: OrientationState.ACTIVE,
        face: FaceState.FACE_UP,
      });
    }
    return {
      ...player,
      hand: { ...player.hand, cardIds: (options.hand ?? []).map((card) => card.instanceId) },
      waitingRoom: {
        ...player.waitingRoom,
        cardIds: (options.waiting ?? []).map((card) => card.instanceId),
      },
      mainDeck: { ...player.mainDeck, cardIds: top.map((card) => card.instanceId) },
      energyDeck: { ...player.energyDeck, cardIds: allEnergyIds.slice(4) },
      energyZone: {
        ...player.energyZone,
        cardIds: energyIds,
        cardStates: new Map(
          energyIds.map((id, index) => [
            id,
            {
              orientation:
                index < (options.activeEnergy ?? 4)
                  ? OrientationState.ACTIVE
                  : OrientationState.WAITING,
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
  return { session, source, sourceSlot, energyIds };
}

function assertMain(request: AiDecisionRequestV2): asserts request is MainRequest {
  if (request.window.kind !== 'MAIN_ACTION') throw new Error('Expected MAIN_ACTION');
}

function response(request: AiDecisionRequestV2, actionToken: string): AiDecisionV2 {
  if (request.window.kind !== 'MAIN_ACTION' && request.window.kind !== 'EFFECT_STEP')
    throw new Error('Expected main or effect window');
  return {
    schemaVersion: request.schemaVersion,
    decisionId: request.decisionId,
    contextDigest: request.contextDigest,
    kind: request.window.kind,
    selectedActionToken: actionToken,
  };
}

function findMainCandidate(request: MainRequest, kind: MainCandidate['kind']): MainCandidate {
  const candidate = request.window.candidates.find((item) => item.kind === kind);
  if (!candidate) throw new Error(`Missing ${kind}`);
  return candidate;
}

async function capture(session: Session): Promise<MainRequest> {
  let request!: MainRequest;
  const result = await new AiTurnCoordinator({
    session,
    createDecisionId: () => 'fixed-activated-decision',
    provider: {
      decide(input) {
        assertMain(input);
        request = input;
        return Promise.resolve(null);
      },
    },
  }).advanceOne(AI);
  expect(result.status).toBe('NO_DECISION');
  return request;
}

async function activate(session: Session): Promise<MainRequest> {
  let captured!: MainRequest;
  const result = await new AiTurnCoordinator({
    session,
    provider: {
      decide(request) {
        assertMain(request);
        captured = request;
        return Promise.resolve(
          response(request, findMainCandidate(request, 'ACTIVATE_ABILITY').actionToken)
        );
      },
    },
  }).advanceOne(AI);
  expect(result).toMatchObject({
    status: 'EXECUTED',
    commandType: GameCommandType.ACTIVATE_ABILITY,
  });
  return captured;
}

async function selectEffectCard(session: Session, cardCode: string): Promise<EffectRequest> {
  let captured!: EffectRequest;
  const result = await new AiTurnCoordinator({
    session,
    provider: {
      decide(request) {
        if (request.window.kind !== 'EFFECT_STEP') throw new Error('Expected EFFECT_STEP');
        captured = request as EffectRequest;
        const candidate = request.window.candidates.find(
          (item) => item.kind === 'SELECT_CARD' && item.card.cardCode === cardCode
        );
        if (!candidate) throw new Error(`Missing visible card ${cardCode}`);
        return Promise.resolve(response(request, candidate.actionToken));
      },
    },
  }).advanceOne(AI);
  expect(result).toMatchObject({
    status: 'EXECUTED',
    commandType: GameCommandType.CONFIRM_EFFECT_STEP,
  });
  return captured;
}

function activeEnergy(session: Session): number {
  return [...session.state!.players[0].energyZone.cardStates.values()].filter(
    (state) => state.orientation === OrientationState.ACTIVE
  ).length;
}

describe('AI activated ability real command integration', () => {
  it('匿名起动支付两能量并自送，复活藤岛慈后处理登场抽二弃一，再回到 MAIN_ACTION', async () => {
    const target = member('PL!HS-bp1-006-P', '藤岛慈', 11);
    const tooHigh = member('VISIBLE-COST-16', '不可复活的费用16成员', 16);
    const nonHasu = createCardInstance(
      { ...memberData('VISIBLE-OTHER-GROUP'), groupNames: ['Liella!'] },
      AI,
      'private-other-group-target'
    );
    const drawn = [member('DRAWN-KEEP'), member('DRAWN-DISCARD')];
    const { session, source, sourceSlot, energyIds } = scenario({
      waiting: [target, tooHigh, nonHasu],
      top: [...drawn, member('UNINSPECTED-REMAINDER')],
    });
    const execute = vi.spyOn(session, 'executeCommand');
    const main = await activate(session);
    const candidate = findMainCandidate(main, 'ACTIVATE_ABILITY');
    expect(candidate).toMatchObject({ kind: 'ACTIVATE_ABILITY', sourceSlot });
    if (candidate.kind !== 'ACTIVATE_ABILITY') throw new Error('Missing activation');
    expect(candidate.abilityText.length).toBeGreaterThan(0);
    expect(Object.keys(candidate).sort()).toEqual([
      'abilityText',
      'actionToken',
      'kind',
      'legality',
      'sourceSlot',
    ]);
    expect(session.state!.players[0].memberSlots.slots[sourceSlot]).toBeNull();
    expect(session.state!.players[0].waitingRoom.cardIds).toContain(source.instanceId);
    expect(activeEnergy(session)).toBe(2);
    expect(session.state!.activeEffect?.abilityId).toBe(SAYAKA_ABILITY);
    expect(session.state!.activeEffect?.selectableCardIds).toEqual([
      target.instanceId,
      source.instanceId,
    ]);
    expect(execute.mock.calls[0]![0]).toMatchObject({
      type: GameCommandType.ACTIVATE_ABILITY,
      playerId: AI,
      cardId: source.instanceId,
      abilityId: SAYAKA_ABILITY,
    });
    for (const id of energyIds.slice(0, 2))
      expect(session.state!.players[0].energyZone.cardStates.get(id)?.orientation).toBe(
        OrientationState.WAITING
      );

    const revival = await selectEffectCard(session, target.data.cardCode);
    expect(revival.window.candidates.filter((item) => item.kind === 'SELECT_CARD')).toHaveLength(2);
    expect(revival.window.candidates.some((item) => item.kind === 'SKIP')).toBe(false);
    expect(session.state!.players[0].memberSlots.slots[sourceSlot]).toBe(target.instanceId);
    expect(session.state!.players[0].waitingRoom.cardIds).not.toContain(target.instanceId);
    expect(session.state!.activeEffect?.abilityId).toBe(
      HS_BP1_006_ON_ENTER_DRAW_DISCARD_ABILITY_ID
    );
    expect(session.state!.players[0].hand.cardIds).toEqual(drawn.map((card) => card.instanceId));
    await selectEffectCard(session, drawn[1]!.data.cardCode);
    expect(session.state!.players[0].hand.cardIds).toEqual([drawn[0]!.instanceId]);
    expect(session.state!.players[0].waitingRoom.cardIds).toContain(drawn[1]!.instanceId);
    expect(session.state!.activeEffect).toBeNull();
    expect(session.state!.pendingAbilities).toHaveLength(0);
    expect(activeEnergy(session)).toBe(2);
    expect(
      (await capture(session)).window.candidates.some((item) => item.kind === 'ACTIVATE_ABILITY')
    ).toBe(false);
  });

  it.each([SlotPosition.LEFT, SlotPosition.CENTER, SlotPosition.RIGHT])(
    '休息室为空仍可自送并复活自身，准确返回原 %s 槽且每次实付能量',
    async (sourceSlot) => {
      const { session, source } = scenario({ sourceSlot });
      for (const remaining of [2, 0]) {
        await activate(session);
        expect(session.state!.players[0].memberSlots.slots[sourceSlot]).toBeNull();
        expect(session.state!.activeEffect?.selectableCardIds).toEqual([source.instanceId]);
        await selectEffectCard(session, source.data.cardCode);
        expect(session.state!.players[0].memberSlots.slots[sourceSlot]).toBe(source.instanceId);
        expect(session.state!.players[0].waitingRoom.cardIds).toHaveLength(0);
        expect(session.state!.activeEffect).toBeNull();
        expect(activeEnergy(session)).toBe(remaining);
      }
      expect(
        (await capture(session)).window.candidates.some((item) => item.kind === 'ACTIVATE_ABILITY')
      ).toBe(true);
      const exhaustedState = toTransport(session.state);
      const rejected = await new AiTurnCoordinator({
        session,
        provider: {
          decide(request) {
            assertMain(request);
            return Promise.resolve(
              response(request, findMainCandidate(request, 'ACTIVATE_ABILITY').actionToken)
            );
          },
        },
      }).advanceOne(AI);
      expect(rejected.status).toBe('REJECTED');
      expect(toTransport(session.state)).toEqual(exhaustedState);
      expect(
        session.state!.actionHistory.filter(
          (action) => action.type === 'PAY_COST' && action.payload.abilityId === SAYAKA_ABILITY
        )
      ).toHaveLength(2);
    }
  );

  it('绿莲实际复活姬芽链：吟子满足登场条件，回一能量并公开回收 LIVE 后返回 MAIN', async () => {
    const hime = member('PL!HS-sd1-006-SD', '安养寺姫芽', 15);
    const ginko = member('PL!HS-pb1-020-N', '百生吟子', 9);
    const targetLiveData: LiveCardData = {
      cardCode: 'HASUNOSORA-RECOVERABLE-LIVE',
      name: '可回收的莲之空 LIVE',
      cardType: CardType.LIVE,
      groupNames: ['蓮ノ空女学院スクールアイドルクラブ'],
      score: 1,
      requirements: createHeartRequirement({ [HeartColor.GREEN]: 1 }),
    };
    const targetLive = createCardInstance(targetLiveData, AI, 'private-activated-recovery-live');
    const { session, source } = scenario({
      waiting: [hime, targetLive],
      otherStage: [[SlotPosition.LEFT, ginko]],
    });
    await activate(session);
    expect(activeEnergy(session)).toBe(2);
    await selectEffectCard(session, hime.data.cardCode);
    expect(session.state!.players[0].memberSlots.slots.CENTER).toBe(hime.instanceId);
    expect(session.state!.players[0].memberSlots.slots.LEFT).toBe(ginko.instanceId);
    expect(session.state!.players[0].waitingRoom.cardIds).toContain(source.instanceId);
    expect(activeEnergy(session)).toBe(3);
    expect(session.state!.activeEffect?.abilityId).toBe(
      HS_SD1_006_ON_ENTER_ACTIVATE_ENERGY_RECOVER_LIVE_ABILITY_ID
    );
    const recovery = await selectEffectCard(session, targetLive.data.cardCode);
    expect(recovery.window.candidates).toHaveLength(1);
    expect(session.state!.activeEffect?.publicCardSelectionAutoAdvanceAt).toBeDefined();
    expect(session.state!.players[0].hand.cardIds).not.toContain(targetLive.instanceId);
    const decide = vi.fn<AiDecisionProviderV2['decide']>();
    const beforePublicDwell = toTransport(session.state);
    expect(
      (await new AiTurnCoordinator({ session, provider: { decide } }).advanceOne(AI)).status
    ).toBe('UNAVAILABLE');
    expect(decide).not.toHaveBeenCalled();
    expect(toTransport(session.state)).toEqual(beforePublicDwell);
    confirmPublicSelectionIfNeeded(session);
    expect(session.state!.players[0].hand.cardIds).toEqual([targetLive.instanceId]);
    expect(session.state!.players[0].waitingRoom.cardIds).toEqual([source.instanceId]);
    expect(session.state!.activeEffect).toBeNull();
    expect(activeEnergy(session)).toBe(3);
    expect((await capture(session)).window.kind).toBe('MAIN_ACTION');
  });

  it('特殊能量起动声明进入真实选择两张窗口，由 AI 明确选择后支付', async () => {
    const { session, source, energyIds } = scenario();
    (session as unknown as { authorityState: GameState }).authorityState = {
      ...session.state!,
      energyActivePhaseSkips: [
        {
          playerId: AI,
          energyCardId: energyIds[0]!,
          sourceCardId: source.instanceId,
          abilityId: 'private-energy-marker',
        },
      ],
    };
    const before = toTransport(session.state);
    await activate(session);
    expect(session.state!.activeEffect?.selectableCardMode).toBe('ORDERED_MULTI');
    expect(session.state!.activeEffect?.minSelectableCards).toBe(2);
    expect(session.state!.activeEffect?.maxSelectableCards).toBe(2);
    expect(toTransport(session.state)).not.toEqual(before);
    expect(session.state!.players[0].memberSlots.slots.CENTER).toBe(source.instanceId);
    expect(activeEnergy(session)).toBe(4);
    const decide = vi.fn<AiDecisionProviderV2['decide']>((request) => {
      if (request.window.kind !== 'EFFECT_CARD_SELECTION')
        throw new Error('Expected multi selection');
      expect(request.window.minSelections).toBe(2);
      expect(request.window.maxSelections).toBe(2);
      expect(request.window.canSkip).toBe(false);
      return Promise.resolve({
        schemaVersion: request.schemaVersion,
        decisionId: request.decisionId,
        contextDigest: request.contextDigest,
        kind: 'EFFECT_CARD_SELECTION',
        choice: 'SELECT',
        selectedCardTokens: request.window.candidates
          .slice(2, 4)
          .map((candidate) => candidate.cardToken),
      });
    });
    expect(
      (await new AiTurnCoordinator({ session, provider: { decide } }).advanceOne(AI)).status
    ).toBe('EXECUTED');
    expect(decide).toHaveBeenCalledTimes(1);
    expect(activeEnergy(session)).toBe(2);
    expect(session.state!.players[0].memberSlots.slots.CENTER).toBeNull();
    expect(session.state!.players[0].waitingRoom.cardIds).toContain(source.instanceId);
    expect(session.state!.players[0].energyZone.cardStates.get(energyIds[0]!)?.orientation).toBe(
      OrientationState.ACTIVE
    );
    expect(session.getLegalRulesEffectStepActions(AI).length).toBeGreaterThan(0);
  });

  it('能量不足仍提供显式起动声明，其他已实现起动来源不需要 AI availability 白名单', async () => {
    const otherSource = member('PL!HS-bp1-003-SEC', '乙宗梢', 13);
    const { session } = scenario({
      activeEnergy: 1,
      otherStage: [[SlotPosition.LEFT, otherSource]],
    });
    const before = toTransport(session.state);
    const execute = vi.spyOn(session, 'executeCommand');
    const request = await capture(session);
    const declarations = request.window.candidates.filter(
      (item) => item.kind === 'ACTIVATE_ABILITY'
    );
    expect(declarations).toHaveLength(2);
    expect(declarations.every((item) => item.legality === 'DECLARATION_ONLY')).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(toTransport(session.state)).toEqual(before);
    const decide = vi.fn<AiDecisionProviderV2['decide']>();
    expect(
      (await new AiTurnCoordinator({ session, provider: { decide } }).advanceOne(OTHER)).status
    ).toBe('UNAVAILABLE');
    expect(decide).not.toHaveBeenCalled();
  });

  it('MAIN 起动请求没有内部能力或实例 ID，隐藏牌序和对手手牌变化不改变输入', async () => {
    const { session } = scenario();
    const baseline = await capture(session);
    const wire = JSON.stringify(baseline);
    expect(wire).not.toContain(SAYAKA_ABILITY);
    expect(wire).not.toContain('abilityId');
    expect(wire).not.toContain('obj_');
    for (const value of [...session.state!.cardRegistry.keys(), AI, OTHER, session.state!.gameId])
      expect(wire).not.toContain(value);
    for (const player of session.state!.players)
      for (const ids of [player.mainDeck.cardIds, player.energyDeck.cardIds]) {
        (ids as string[]).reverse();
        expect(await capture(session)).toEqual(baseline);
        (ids as string[]).reverse();
      }
    const hiddenId = session.state!.players[1].hand.cardIds[0]!;
    const hidden = session.state!.cardRegistry.get(hiddenId)!;
    (session.state!.cardRegistry as Map<string, CardInstance>).set(hiddenId, {
      ...hidden,
      data: { ...hidden.data, cardCode: 'PRIVATE-OPPONENT-CHANGED' },
    });
    expect(await capture(session)).toEqual(baseline);
  });

  it.each(['wrong-slot', 'duplicate', 'own-hand', 'opponent-source', 'granted-instance'] as const)(
    'frame 拒绝与公开舞台不一致的 trusted 起动绑定 %s',
    (mode) => {
      const handSource = member('PL!HS-bp1-002-P', '村野沙耶香', 11);
      const { session } = scenario({ hand: [handSource] });
      const actions = session.getRulesMainActionCandidates(AI);
      const activated = actions.find((item) => item.kind === 'ACTIVATE_ABILITY');
      if (!activated || activated.kind !== 'ACTIVATE_ABILITY')
        throw new Error('Missing legal activation');
      let forged: readonly TrustedMainActionCandidateV2[];
      if (mode === 'duplicate') forged = [...actions, activated];
      else {
        const changed = {
          ...activated,
          sourceSlot: mode === 'wrong-slot' ? SlotPosition.LEFT : activated.sourceSlot,
          binding: {
            ...activated.binding,
            ...(mode === 'own-hand' ? { cardId: handSource.instanceId } : {}),
            ...(mode === 'opponent-source'
              ? {
                  playerId: OTHER,
                  cardId: session.state!.players[1].hand.cardIds[0]!,
                }
              : {}),
            ...(mode === 'granted-instance'
              ? { abilityInstanceId: 'private-granted-instance' }
              : {}),
          },
        } as unknown as TrustedMainActionCandidateV2;
        forged = actions.map((item) => (item === activated ? changed : item));
      }
      const before = toTransport(session.state);
      expect(
        buildAiDecisionFrameV2(session.getPlayerViewState(AI)!, 'invalid-binding-frame', forged).ok
      ).toBe(false);
      expect(toTransport(session.state)).toEqual(before);
    }
  );

  it.each(['raw-card-token', 'unknown-token', 'raw-parameters'] as const)(
    '拒绝伪造起动响应 %s，既不支付也不移动来源',
    async (mode) => {
      const { session, source } = scenario();
      const before = toTransport(session.state);
      const execute = vi.spyOn(session, 'executeCommand');
      const result = await new AiTurnCoordinator({
        session,
        provider: {
          decide(request) {
            assertMain(request);
            const candidate = findMainCandidate(request, 'ACTIVATE_ABILITY');
            const actionToken =
              mode === 'raw-card-token'
                ? source.instanceId
                : mode === 'unknown-token'
                  ? 'unknown-activation-token'
                  : candidate.actionToken;
            return Promise.resolve({
              ...response(request, actionToken),
              ...(mode === 'raw-parameters'
                ? { cardId: source.instanceId, abilityId: SAYAKA_ABILITY }
                : {}),
            } as AiDecisionV2);
          },
        },
      }).advanceOne(AI);
      expect(result.status).toBe('REJECTED');
      expect(execute).not.toHaveBeenCalled();
      expect(toTransport(session.state)).toEqual(before);
    }
  );

  it.each(['main-ended', 'source-sacrificed'] as const)(
    '起动响应在途时 %s 后重新验证窗口，旧 token 不再消费能量',
    async (change) => {
      const { session, source } = scenario();
      let release!: (decision: AiDecisionV2) => void;
      let started!: () => void;
      let oldRequest!: MainRequest;
      const waiting = new Promise<void>((resolve) => {
        started = resolve;
      });
      const pending = new AiTurnCoordinator({
        session,
        provider: {
          decide(request) {
            assertMain(request);
            oldRequest = request;
            started();
            return new Promise<AiDecisionV2>((resolve) => {
              release = resolve;
            });
          },
        },
      }).advanceOne(AI);
      await waiting;
      const command =
        change === 'main-ended'
          ? createEndPhaseCommand(AI)
          : createActivateAbilityCommand(AI, source.instanceId, SAYAKA_ABILITY);
      expect(session.executeCommand(command).success).toBe(true);
      const afterLegitimateCommand = toTransport(session.state);
      const execute = vi.spyOn(session, 'executeCommand');
      release(response(oldRequest, findMainCandidate(oldRequest, 'ACTIVATE_ABILITY').actionToken));
      await expect(pending).resolves.toMatchObject({ status: 'STALE' });
      expect(execute).not.toHaveBeenCalled();
      expect(toTransport(session.state)).toEqual(afterLegitimateCommand);
    }
  );
});
