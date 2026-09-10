import { describe, expect, it } from 'vitest';
import type { MemberCardData, PendingAbilityState } from '../../src/domain/entities/card';
import { createCardInstance, createHeartIcon } from '../../src/domain/entities/card';
import {
  createGameState,
  registerCards,
  updatePlayer,
  type GameState,
} from '../../src/domain/entities/game';
import { addMemberBelowMember, placeCardInSlot } from '../../src/domain/entities/zone';
import { createConfirmEffectStepCommand } from '../../src/application/game-commands';
import { createGameSession } from '../../src/application/game-session';
import { createPublicObjectId, projectPlayerViewState } from '../../src/online/projector';
import {
  confirmActiveEffectStep,
  HS_BP6_006_LIVE_SUCCESS_WAIT_SKIP_NEXT_ACTIVE_ABILITY_ID,
  N_PR_026_LIVE_SUCCESS_DELEGATE_MEMBER_BELOW_LIVE_SUCCESS_ABILITIES_ABILITY_ID,
  N_PR_026_ON_ENTER_STACK_LOW_COST_NIJIGASAKI_MEMBER_FROM_WAITING_ABILITY_ID,
  resolvePendingCardEffects,
} from '../../src/application/card-effect-runner';
import {
  CardType,
  FaceState,
  HeartColor,
  OrientationState,
  SlotPosition,
  TriggerCondition,
} from '../../src/shared/types/enums';

const PLAYER1 = 'player1';
const PLAYER2 = 'player2';

function createMember(
  cardCode: string,
  name: string,
  options: {
    readonly cost?: number;
    readonly groupNames?: readonly string[];
  } = {}
): MemberCardData {
  return {
    cardCode,
    name,
    groupNames: options.groupNames ?? ['虹ヶ咲'],
    unitName: options.groupNames?.[0] ?? '虹ヶ咲',
    cardType: CardType.MEMBER,
    cost: options.cost ?? 9,
    blade: 1,
    hearts: [createHeartIcon(HeartColor.YELLOW, 1)],
  };
}

function setupRinaGame(options: {
  readonly waitingCards?: readonly ReturnType<typeof createCardInstance>[];
  readonly memberBelowCards?: readonly ReturnType<typeof createCardInstance>[];
  readonly pendingAbilityId: string;
}): GameState {
  const source = createCardInstance(
    createMember('PL!N-PR-026-PR', '天王寺璃奈', { cost: 15 }),
    PLAYER1,
    'rina-source'
  );
  const waitingCards = options.waitingCards ?? [];
  const memberBelowCards = options.memberBelowCards ?? [];
  let game = createGameState('n-pr-026-rina', PLAYER1, 'P1', PLAYER2, 'P2');
  game = registerCards(game, [source, ...waitingCards, ...memberBelowCards]);
  game = updatePlayer(game, PLAYER1, (player) => {
    let memberSlots = placeCardInSlot(
      player.memberSlots,
      SlotPosition.CENTER,
      source.instanceId,
      activeFaceUp()
    );
    for (const card of memberBelowCards) {
      memberSlots = addMemberBelowMember(memberSlots, SlotPosition.CENTER, card.instanceId);
    }
    return {
      ...player,
      waitingRoom: {
        ...player.waitingRoom,
        cardIds: waitingCards.map((card) => card.instanceId),
      },
      memberSlots,
    };
  });
  return {
    ...game,
    pendingAbilities: [
      createPendingAbility(options.pendingAbilityId, source.instanceId, SlotPosition.CENTER),
    ],
  };
}

function createPendingAbility(
  abilityId: string,
  sourceCardId: string,
  sourceSlot: SlotPosition
): PendingAbilityState {
  return {
    id: `${abilityId}:pending`,
    abilityId,
    sourceCardId,
    controllerId: PLAYER1,
    mandatory: false,
    timingId: abilityId.includes('on-enter')
      ? TriggerCondition.ON_ENTER_STAGE
      : TriggerCondition.ON_LIVE_SUCCESS,
    eventIds: [`event:${abilityId}`],
    sourceSlot,
  };
}

function createSessionWithState(game: GameState) {
  const session = createGameSession();
  session.createGame('n-pr-026-rina-session', PLAYER1, 'P1', PLAYER2, 'P2');
  (session as unknown as { authorityState: GameState }).authorityState = game;
  return session;
}

function activeFaceUp() {
  return {
    orientation: OrientationState.ACTIVE,
    face: FaceState.FACE_UP,
  };
}

function resolvePendingAndConfirmOnly(game: GameState): GameState {
  let state = resolvePendingCardEffects(game).gameState;
  while (state.activeEffect?.metadata?.confirmOnlyPendingAbility === true) {
    state = confirmActiveEffectStep(state, PLAYER1, state.activeEffect.id);
  }
  return state;
}

describe('PL!N-PR-026-PR Rina memberBelow workflow', () => {
  it('resumes an already-open Rina selection using its preserved step and metadata', () => {
    const card = createCardInstance(
      createMember('PL!N-test', '低费成员'),
      PLAYER1,
      'waiting-legacy'
    );
    let game = setupRinaGame({
      waitingCards: [card],
      pendingAbilityId: N_PR_026_ON_ENTER_STACK_LOW_COST_NIJIGASAKI_MEMBER_FROM_WAITING_ABILITY_ID,
    });
    game = {
      ...game,
      pendingAbilities: [],
      activeEffect: {
        id: 'rina-in-progress',
        abilityId: N_PR_026_ON_ENTER_STACK_LOW_COST_NIJIGASAKI_MEMBER_FROM_WAITING_ABILITY_ID,
        sourceCardId: 'rina-source',
        controllerId: PLAYER1,
        awaitingPlayerId: PLAYER1,
        effectText: '【登场】从自己的休息室将1张费用小于等于9的『虹ヶ咲』成员卡放置于此成员下方。',
        stepId: 'N_PR_026_RINA_SELECT_WAITING_MEMBER',
        selectableCardIds: ['waiting-legacy'],
        selectableCardVisibility: 'PUBLIC',
        canSkipSelection: false,
        metadata: { orderedResolution: false, sourceSlot: SlotPosition.CENTER },
      },
    };
    const result = confirmActiveEffectStep(game, PLAYER1, 'rina-in-progress', 'waiting-legacy');
    expect(result.activeEffect).toBeNull();
    expect(result.players[0]!.memberSlots.memberBelow[SlotPosition.CENTER]).toEqual([
      'waiting-legacy',
    ]);
    expect(result.players[0]!.waitingRoom.cardIds).toEqual([]);
  });
  it('immediately stacks the selected low-cost member, keeps both views public and rejects repeat submission', () => {
    const waitingMember = createCardInstance(
      createMember('PL!N-test-low-cost', '虹ヶ咲低费成员', { cost: 9 }),
      PLAYER1,
      'waiting-low-cost-niji'
    );
    const game = setupRinaGame({
      waitingCards: [waitingMember],
      pendingAbilityId: N_PR_026_ON_ENTER_STACK_LOW_COST_NIJIGASAKI_MEMBER_FROM_WAITING_ABILITY_ID,
    });
    const session = createSessionWithState(resolvePendingCardEffects(game).gameState);

    expect(session.state?.activeEffect?.selectableCardIds).toEqual([waitingMember.instanceId]);
    const command = createConfirmEffectStepCommand(
      PLAYER1,
      session.state!.activeEffect!.id,
      waitingMember.instanceId
    );
    expect(session.executeCommand(command).success).toBe(true);
    expect(session.state!.activeEffect).toBeNull();
    expect(session.state!.pendingAbilities).toEqual([]);
    const player = session.state!.players[0]!;
    expect(player.waitingRoom.cardIds).not.toContain(waitingMember.instanceId);
    expect(player.memberSlots.memberBelow[SlotPosition.CENTER]).toEqual([waitingMember.instanceId]);
    const objectId = createPublicObjectId(waitingMember.instanceId);
    for (const viewer of [PLAYER1, PLAYER2]) {
      const view = projectPlayerViewState(session.state!, viewer);
      expect(view.table.zones.FIRST_MEMBER_CENTER.memberBelow?.CENTER).toEqual([objectId]);
      expect(view.objects[objectId]).toMatchObject({
        surface: 'FRONT',
        frontInfo: { cardCode: waitingMember.data.cardCode },
      });
    }
    expect(session.state?.eventLog).toEqual([]);
    const after = session.state;
    expect(session.executeCommand(command).success).toBe(false);
    expect(session.state).toEqual(after);
  });

  it('skips on enter when waiting room has no legal target', () => {
    const highCost = createCardInstance(
      createMember('PL!N-test-high-cost', '高费虹ヶ咲成员', { cost: 10 }),
      PLAYER1,
      'waiting-high-cost-niji'
    );
    const result = resolvePendingCardEffects(
      setupRinaGame({
        waitingCards: [highCost],
        pendingAbilityId:
          N_PR_026_ON_ENTER_STACK_LOW_COST_NIJIGASAKI_MEMBER_FROM_WAITING_ABILITY_ID,
      })
    ).gameState;

    expect(result.activeEffect).toBeNull();
    expect(
      result.actionHistory.some(
        (action) => action.payload.step === 'NO_WAITING_LOW_COST_NIJIGASAKI_MEMBER'
      )
    ).toBe(true);
  });

  it('delegates implemented live-success abilities from legal memberBelow cards using Rina as source', () => {
    const grantedMember = createCardInstance(
      createMember('PL!HS-bp6-006-R+', '下方授予LIVE成功能力成员', {
        cost: 9,
        groupNames: ['虹ヶ咲'],
      }),
      PLAYER1,
      'granted-live-success-member'
    );
    const result = resolvePendingAndConfirmOnly(
      setupRinaGame({
        memberBelowCards: [grantedMember],
        pendingAbilityId:
          N_PR_026_LIVE_SUCCESS_DELEGATE_MEMBER_BELOW_LIVE_SUCCESS_ABILITIES_ABILITY_ID,
      })
    );

    expect(result.pendingAbilities).toEqual([]);
    expect(result.players[0]!.memberSlots.cardStates.get('rina-source')?.orientation).toBe(
      OrientationState.WAITING
    );
    expect(
      result.actionHistory.some(
        (action) =>
          action.payload.step === 'DELEGATE_MEMBER_BELOW_LIVE_SUCCESS_ABILITIES' &&
          action.payload.delegatedAbilityIds?.includes(
            HS_BP6_006_LIVE_SUCCESS_WAIT_SKIP_NEXT_ACTIVE_ABILITY_ID
          )
      )
    ).toBe(true);
    expect(
      result.actionHistory.some(
        (action) =>
          action.payload.step === 'WAIT_SOURCE_SKIP_NEXT_ACTIVE' &&
          action.payload.sourceCardId === 'rina-source' &&
          action.payload.skipNextActiveMemberCardId === 'rina-source'
      )
    ).toBe(true);
  });

  it('does not delegate high-cost, non-Nijigasaki, or unimplemented memberBelow abilities', () => {
    const highCost = createCardInstance(
      createMember('PL!HS-bp6-006-R+', '高费下方', { cost: 10, groupNames: ['虹ヶ咲'] }),
      PLAYER1,
      'high-cost-below'
    );
    const nonNijigasaki = createCardInstance(
      createMember('PL!HS-bp6-006-R+', '非虹下方', { cost: 9, groupNames: ['蓮ノ空'] }),
      PLAYER1,
      'non-niji-below'
    );
    const unimplemented = createCardInstance(
      createMember('PL!N-test-no-live-success', '无已实现LIVE成功', { cost: 9 }),
      PLAYER1,
      'unimplemented-below'
    );
    const result = resolvePendingAndConfirmOnly(
      setupRinaGame({
        memberBelowCards: [highCost, nonNijigasaki, unimplemented],
        pendingAbilityId:
          N_PR_026_LIVE_SUCCESS_DELEGATE_MEMBER_BELOW_LIVE_SUCCESS_ABILITIES_ABILITY_ID,
      })
    );

    expect(result.pendingAbilities).toEqual([]);
    expect(result.players[0]!.memberSlots.cardStates.get('rina-source')?.orientation).toBe(
      OrientationState.ACTIVE
    );
    expect(
      result.actionHistory.some(
        (action) => action.payload.step === 'NO_DELEGATABLE_MEMBER_BELOW_LIVE_SUCCESS_ABILITIES'
      )
    ).toBe(true);
  });
});
