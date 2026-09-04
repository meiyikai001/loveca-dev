import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AiDecisionProviderV2,
  AiDecisionRequestV2,
  AiDecisionV2,
} from '../../src/application/ai/ai-decision-contract';
import {
  BP5_004_ACTIVATED_STAGE_GROUP_DYNAMIC_COST_WAIT_OPPONENT_COST_TEN_ABILITY_ID,
  N_PR_REVEAL_HAND_NO_LIVE_LOOK_TOP_FIVE_TAKE_LIVE_ABILITY_ID,
  PB1_019_ACTIVATED_ABILITY_ID,
} from '../../src/application/card-effects/ability-ids';
import {
  createPlayMemberToSlotCommand,
  GameCommandType,
} from '../../src/application/game-commands';
import { createGameSession } from '../../src/application/game-session';
import {
  createCardInstance,
  createHeartIcon,
  type CardInstance,
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
  SubPhase,
  TurnType,
} from '../../src/shared/types/enums';
import { confirmPublicSelectionIfNeeded } from '../helpers/public-card-selection-confirmation';

const AI = 'generic-ai-private-player';
const OTHER = 'generic-other-private-player';
type MainRequest = AiDecisionRequestV2 & {
  readonly window: Extract<AiDecisionRequestV2['window'], { readonly kind: 'MAIN_ACTION' }>;
};

afterEach(() => vi.restoreAllMocks());

function member(
  cardCode: string,
  name = cardCode,
  cost = 1,
  groupNames: readonly string[] = ['蓮ノ空'],
  ownerId = AI
): CardInstance {
  const data: MemberCardData = {
    cardCode,
    name,
    cost,
    groupNames,
    cardType: CardType.MEMBER,
    blade: 1,
    hearts: [createHeartIcon(HeartColor.GREEN, 1)],
  };
  return createCardInstance(data, ownerId, `private-generic-${ownerId}-${cardCode}`);
}

/** Minimal seeded RULES board; no external card registry or side-effect preview is used. */
function scenario(options: {
  readonly source: CardInstance;
  readonly stage?: readonly (readonly [SlotPosition, CardInstance])[];
  readonly opponentStage?: readonly (readonly [SlotPosition, CardInstance])[];
  readonly hand?: readonly CardInstance[];
  readonly waiting?: readonly CardInstance[];
  readonly energy?: number;
}) {
  const session = createGameSession({ randomInt: (maxExclusive) => maxExclusive - 1 });
  session.createGame('private-generic-activation-game', AI, 'AI', OTHER, 'Other');
  const energies = Array.from({ length: options.energy ?? 0 }, (_, index) =>
    createCardInstance(
      { cardCode: `GENERIC-ENERGY-${index}`, name: `Energy ${index}`, cardType: CardType.ENERGY },
      AI,
      `private-generic-energy-${index}`
    )
  );
  const top = Array.from({ length: 8 }, (_, index) => member(`UNSEEN-GENERIC-${index}`));
  let state = registerCards(session.state!, [
    options.source,
    ...energies,
    ...top,
    ...(options.stage ?? []).map(([, card]) => card),
    ...(options.opponentStage ?? []).map(([, card]) => card),
    ...(options.hand ?? []),
    ...(options.waiting ?? []),
  ]);
  state = {
    ...state,
    currentPhase: GamePhase.MAIN_PHASE,
    currentSubPhase: SubPhase.NONE,
    currentTurnType: TurnType.FIRST_PLAYER_TURN,
    activePlayerIndex: 0,
    waitingPlayerId: null,
  };
  state = updatePlayer(state, AI, (player) => {
    let memberSlots = placeCardInSlot(
      player.memberSlots,
      SlotPosition.CENTER,
      options.source.instanceId,
      { orientation: OrientationState.ACTIVE, face: FaceState.FACE_UP }
    );
    for (const [slot, card] of options.stage ?? [])
      memberSlots = placeCardInSlot(memberSlots, slot, card.instanceId, {
        orientation: OrientationState.ACTIVE,
        face: FaceState.FACE_UP,
      });
    return {
      ...player,
      memberSlots,
      hand: { ...player.hand, cardIds: (options.hand ?? []).map((card) => card.instanceId) },
      waitingRoom: {
        ...player.waitingRoom,
        cardIds: (options.waiting ?? []).map((card) => card.instanceId),
      },
      mainDeck: { ...player.mainDeck, cardIds: top.map((card) => card.instanceId) },
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
    };
  });
  state = updatePlayer(state, OTHER, (player) => {
    let memberSlots = player.memberSlots;
    for (const [slot, card] of options.opponentStage ?? [])
      memberSlots = placeCardInSlot(memberSlots, slot, card.instanceId, {
        orientation: OrientationState.ACTIVE,
        face: FaceState.FACE_UP,
      });
    return { ...player, memberSlots };
  });
  (session as unknown as { authorityState: GameState }).authorityState = state;
  return session;
}

function assertMain(request: AiDecisionRequestV2): asserts request is MainRequest {
  if (request.window.kind !== 'MAIN_ACTION') throw new Error('Expected MAIN_ACTION');
}

function decision(request: AiDecisionRequestV2, token: string): AiDecisionV2 {
  if (request.window.kind !== 'MAIN_ACTION' && request.window.kind !== 'EFFECT_STEP')
    throw new Error('Expected action request');
  return {
    schemaVersion: request.schemaVersion,
    decisionId: request.decisionId,
    contextDigest: request.contextDigest,
    kind: request.window.kind,
    selectedActionToken: token,
  };
}

function declaration(request: MainRequest, slot = SlotPosition.CENTER) {
  const candidate = request.window.candidates.find(
    (item) => item.kind === 'ACTIVATE_ABILITY' && item.sourceSlot === slot
  );
  if (!candidate || candidate.kind !== 'ACTIVATE_ABILITY')
    throw new Error(`Missing declaration at ${slot}`);
  expect(candidate.legality).toBe('DECLARATION_ONLY');
  return candidate;
}

function policy(selectCardCode: () => string = () => ''): AiDecisionProviderV2 {
  return {
    decide(request) {
      if (request.window.kind === 'MAIN_ACTION')
        return Promise.resolve(decision(request, declaration(request as MainRequest).actionToken));
      if (request.window.kind !== 'EFFECT_STEP') throw new Error('Unexpected window');
      const candidate = request.window.candidates.find(
        (item) => item.kind === 'SELECT_CARD' && item.card.cardCode === selectCardCode()
      );
      if (!candidate) throw new Error('Missing visible effect target');
      return Promise.resolve(decision(request, candidate.actionToken));
    },
  };
}

describe('AI generic activated declarations', () => {
  it.each([
    { cardCode: 'PL!HS-PR-014-PR', name: '日野下花帆', groupNames: ['蓮ノ空'] },
    { cardCode: 'PL!-sd1-002-SD', name: '绚濑绘里', groupNames: ["μ's"] },
  ])(
    '费用 2 $name 的自送成员回收无须逐卡 AI availability 接入',
    async ({ cardCode, name, groupNames }) => {
      const source = member(cardCode, name, 2, groupNames);
      const target = member('GENERIC-RECOVERY-TARGET');
      const session = scenario({ source, waiting: [target] });
      const coordinator = new AiTurnCoordinator({
        session,
        provider: policy(() => target.data.cardCode),
      });
      const execute = vi.spyOn(session, 'executeCommand');
      expect((await coordinator.advanceOne(AI)).status).toBe('EXECUTED');
      expect(execute.mock.calls[0]![0]).toMatchObject({
        type: GameCommandType.ACTIVATE_ABILITY,
        cardId: source.instanceId,
        abilityId: PB1_019_ACTIVATED_ABILITY_ID,
      });
      expect(session.state!.players[0].memberSlots.slots.CENTER).toBeNull();
      expect(session.state!.players[0].waitingRoom.cardIds).toEqual([
        target.instanceId,
        source.instanceId,
      ]);
      expect(session.state!.activeEffect?.abilityId).toBe(PB1_019_ACTIVATED_ABILITY_ID);
      expect((await coordinator.advanceOne(AI)).status).toBe('EXECUTED');
      expect(session.state!.activeEffect?.publicCardSelectionAutoAdvanceAt).toBeDefined();
      expect(session.state!.players[0].hand.cardIds).toEqual([]);
      const before = toTransport(session.state);
      expect((await coordinator.advanceOne(AI)).status).toBe('UNAVAILABLE');
      expect(toTransport(session.state)).toEqual(before);
      confirmPublicSelectionIfNeeded(session);
      expect(session.state!.players[0].hand.cardIds).toEqual([target.instanceId]);
      expect(session.state!.players[0].waitingRoom.cardIds).toEqual([source.instanceId]);
      expect(session.state!.activeEffect).toBeNull();
    }
  );

  it('费用不足由真实命令拒绝；同一局面记住拒绝但不隐藏其他声明，局面改变后允许重试', async () => {
    const source = member('PL!HS-bp1-002-R', '村野沙耶香', 11);
    const other = member('PL!-sd1-002-SD', '绚濑绘里', 2, ["μ's"]);
    const playable = member('GENERIC-NEW-STATE-PLAY', '可正常登场的成员', 1);
    const session = scenario({
      source,
      stage: [[SlotPosition.LEFT, other]],
      hand: [playable],
      energy: 1,
    });
    const requests: MainRequest[] = [];
    const coordinator = new AiTurnCoordinator({
      session,
      provider: {
        decide(request) {
          assertMain(request);
          requests.push(request);
          if (requests.length === 2) {
            expect(
              request.window.candidates.some(
                (item) =>
                  item.kind === 'ACTIVATE_ABILITY' && item.sourceSlot === SlotPosition.CENTER
              )
            ).toBe(false);
            expect(declaration(request, SlotPosition.LEFT)).toBeDefined();
            return Promise.resolve(null);
          }
          return Promise.resolve(decision(request, declaration(request).actionToken));
        },
      },
    });
    const before = session.state;
    const beforeSnapshot = toTransport(before);
    const execute = vi.spyOn(session, 'executeCommand');
    expect(await coordinator.advanceOne(AI)).toMatchObject({
      status: 'REJECTED',
      reason: '起动声明未执行，当前局面下不再重复申请该动作',
    });
    expect(session.state).toBe(before);
    expect(toTransport(session.state)).toEqual(beforeSnapshot);
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await coordinator.advanceOne(AI)).status).toBe('NO_DECISION');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      session.executeCommand(
        createPlayMemberToSlotCommand(AI, playable.instanceId, SlotPosition.RIGHT)
      ).success
    ).toBe(true);
    const changedState = session.state;
    expect(changedState).not.toBe(before);
    expect((await coordinator.advanceOne(AI)).status).toBe('REJECTED');
    expect(execute).toHaveBeenCalledTimes(3);
    expect(session.state).toBe(changedState);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      const wire = JSON.stringify(request);
      expect(wire).not.toContain(source.instanceId);
      expect(wire).not.toContain('abilityId');
    }
  });

  it('动态费用降到零的合法起动可以连续结算，不被协调器错误限制为一回合一次', async () => {
    const source = member('PL!-bp5-004-AR', '园田海未', 13, ["μ's"]);
    const helper = member('GENERIC-THREE-GROUPS', '三个团名的辅助成员', 1, [
      'Aqours',
      'Liella!',
      '蓮ノ空',
    ]);
    const targets = [
      member('GENERIC-OPPONENT-LEFT', '对手左成员', 5, ['Aqours'], OTHER),
      member('GENERIC-OPPONENT-RIGHT', '对手右成员', 5, ['Aqours'], OTHER),
    ];
    const session = scenario({
      source,
      stage: [[SlotPosition.LEFT, helper]],
      opponentStage: [
        [SlotPosition.LEFT, targets[0]!],
        [SlotPosition.RIGHT, targets[1]!],
      ],
    });
    let selectedCode = targets[0]!.data.cardCode;
    const coordinator = new AiTurnCoordinator({ session, provider: policy(() => selectedCode) });
    for (const target of targets) {
      selectedCode = target.data.cardCode;
      expect((await coordinator.advanceOne(AI)).status).toBe('EXECUTED');
      expect(session.state!.activeEffect?.abilityId).toBe(
        BP5_004_ACTIVATED_STAGE_GROUP_DYNAMIC_COST_WAIT_OPPONENT_COST_TEN_ABILITY_ID
      );
      expect((await coordinator.advanceOne(AI)).status).toBe('EXECUTED');
      expect(
        session.state!.players[1].memberSlots.cardStates.get(target.instanceId)?.orientation
      ).toBe(OrientationState.WAITING);
      expect(session.state!.activeEffect).toBeNull();
    }
    const payments = session.state!.actionHistory.filter(
      (action) =>
        action.type === 'PAY_COST' &&
        action.payload.abilityId ===
          BP5_004_ACTIVATED_STAGE_GROUP_DYNAMIC_COST_WAIT_OPPONENT_COST_TEN_ABILITY_ID
    );
    expect(payments).toHaveLength(2);
    expect(payments.every((action) => action.payload.amount === 0)).toBe(true);
    expect(session.state!.players[0].energyZone.cardIds).toEqual([]);
  });

  it('起动成功公开手牌后必须保留真实进度，公开停留不可误当声明失败回退或再执行', async () => {
    const source = member('PL!N-PR-003-PR', '上原步梦', 9, ['虹咲']);
    const hiddenHand = member('GENERIC-HAND-TO-REVEAL');
    const session = scenario({
      source,
      stage: [[SlotPosition.LEFT, member('GENERIC-OTHER-MEMBER')]],
      hand: [hiddenHand],
    });
    const beforeDeclaration = session.state;
    const provider = policy();
    const decide = vi.fn<AiDecisionProviderV2['decide']>((request, signal) =>
      provider.decide(request, signal)
    );
    const coordinator = new AiTurnCoordinator({ session, provider: { decide } });
    const execute = vi.spyOn(session, 'executeCommand');
    expect((await coordinator.advanceOne(AI)).status).toBe('EXECUTED');
    expect(session.state).not.toBe(beforeDeclaration);
    expect(session.state!.activeEffect?.abilityId).toBe(
      N_PR_REVEAL_HAND_NO_LIVE_LOOK_TOP_FIVE_TAKE_LIVE_ABILITY_ID
    );
    expect(session.state!.activeEffect?.publicRevealAutoAdvanceAt).toBeDefined();
    expect(
      session.getPlayerViewState(OTHER)?.objects[`obj_${hiddenHand.instanceId}`]?.frontInfo
        ?.cardCode
    ).toBe(hiddenHand.data.cardCode);
    const committedState = session.state;
    const committedSnapshot = toTransport(committedState);
    expect((await coordinator.advanceOne(AI)).status).toBe('UNAVAILABLE');
    expect(decide).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(session.state).toBe(committedState);
    expect(toTransport(session.state)).toEqual(committedSnapshot);
    expect(
      session.state!.actionHistory.some(
        (action) =>
          action.type === 'RESOLVE_ABILITY' &&
          action.payload.abilityId ===
            N_PR_REVEAL_HAND_NO_LIVE_LOOK_TOP_FIVE_TAKE_LIVE_ABILITY_ID &&
          action.payload.step === 'ABILITY_USE'
      )
    ).toBe(true);
  });

  it.each(['throw-before-commit', 'throw-after-commit', 'reject-after-commit'] as const)(
    '执行边界 %s 时脱敏停止而不回滚，也不再向 provider 自动申请同状态重试',
    async (mode) => {
      const source = member('PL!N-PR-003-PR', '上原步梦', 9, ['虹咲']);
      const revealed = member('GENERIC-EXCEPTION-REVEALED-HAND');
      const session = scenario({
        source,
        stage: [[SlotPosition.LEFT, member('GENERIC-EXCEPTION-OTHER-MEMBER')]],
        hand: [revealed],
      });
      const before = session.state;
      const realExecute = session.executeCommand.bind(session);
      const execute = vi.spyOn(session, 'executeCommand').mockImplementationOnce((command) => {
        if (mode === 'throw-before-commit') throw new Error('PRIVATE-BEFORE-COMMIT');
        const result = realExecute(command);
        expect(result.success).toBe(true);
        if (mode === 'throw-after-commit') throw new Error('PRIVATE-AFTER-COMMIT');
        return { success: false, gameState: session.state!, error: 'PRIVATE-PARTIAL-RESULT' };
      });
      const provider = policy();
      const decide = vi.fn<AiDecisionProviderV2['decide']>((request, signal) =>
        provider.decide(request, signal)
      );
      const coordinator = new AiTurnCoordinator({ session, provider: { decide } });
      const outcome = await coordinator.advanceOne(AI);
      expect(outcome.status).toBe('UNAVAILABLE');
      expect(JSON.stringify(outcome)).not.toContain('PRIVATE-');
      if (mode === 'throw-before-commit') expect(session.state).toBe(before);
      else {
        expect(session.state).not.toBe(before);
        expect(session.state!.activeEffect?.publicRevealAutoAdvanceAt).toBeDefined();
        expect(
          session.getPlayerViewState(OTHER)?.objects[`obj_${revealed.instanceId}`]?.frontInfo
            ?.cardCode
        ).toBe(revealed.data.cardCode);
      }
      const afterBoundary = session.state;
      const snapshot = toTransport(afterBoundary);
      expect((await coordinator.advanceOne(AI)).status).toBe('UNAVAILABLE');
      expect(decide).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(session.state).toBe(afterBoundary);
      expect(toTransport(session.state)).toEqual(snapshot);
    }
  );
});
