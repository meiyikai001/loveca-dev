import { describe, expect, it } from 'vitest';
import { addCheckTimingRuleSentinel } from '../helpers/check-timing-rule-sentinel';
import {
  createCardInstance,
  createHeartRequirement,
  type CardInstance,
} from '../../src/domain/entities/card';
import {
  createGameState,
  registerCards,
  updatePlayer,
  type GameState,
  type PendingAbilityState,
} from '../../src/domain/entities/game';
import { placeCardInSlot, removeCardFromSlot } from '../../src/domain/entities/zone';
import { getMemberEffectiveBladeCount } from '../../src/domain/rules/live-modifiers';
import { resolvePendingCardEffects } from '../../src/application/card-effect-runner';
import {
  HS_PB1_003_AUTO_HAND_TO_WAITING_GAIN_HEART_BLADE_ABILITY_ID,
  PL_PB2_010_LIVE_START_PRINTEMPS_ACTIVATED_STAGE_MEMBERS_GAIN_BLADE_ABILITY_ID,
  PL_PB2_016_LIVE_START_LILY_WHITE_SUCCESS_REPEAT_CHOICES_ABILITY_ID,
} from '../../src/application/card-effects/ability-ids';
import {
  CardAbilityCategory,
  CardAbilitySourceZone,
} from '../../src/application/card-effects/ability-definition-types';
import { getCardAbilityDefinitionsForCardCode } from '../../src/application/card-effects/definitions/lookup';
import { PUBLIC_EFFECT_CHOICE_CONFIRMATION_STEP_ID } from '../../src/application/card-effects/runtime/public-effect-choice-confirmation';
import {
  createAutoAdvancePublicEffectChoiceCommand,
  createConfirmEffectChoiceCommand,
  createConfirmEffectStepCommand,
} from '../../src/application/game-commands';
import { createGameSession } from '../../src/application/game-session';
import {
  CardType,
  FaceState,
  GamePhase,
  OrientationState,
  SlotPosition,
  SubPhase,
  TriggerCondition,
  ZoneType,
} from '../../src/shared/types/enums';

const P1 = 'player1';
const P2 = 'player2';
const ABILITY = PL_PB2_016_LIVE_START_LILY_WHITE_SUCCESS_REPEAT_CHOICES_ABILITY_ID;
const EFFECT_TEXT =
  '【LIVE开始时】存在于自己的成功LIVE卡区的『lily white』的卡片每有1张，从以下选择1项。可以重复选择相同的选项。\n\n·存在于自己的舞台的中央区域的成员，LIVE结束时为止，获得[ブレード]。\n\n·将存在于自己的舞台的1名成员变为活跃状态。\n\n·抽1张卡，将1张手牌放置入休息室。';

function member(id: string, cardCode = id, unitName = 'lily white'): CardInstance {
  return createCardInstance(
    {
      cardCode,
      name: id,
      cardType: CardType.MEMBER,
      cost: cardCode.startsWith('PL!-pb2-016') ? 17 : 7,
      blade: cardCode.startsWith('PL!-pb2-016') ? 6 : 1,
      hearts: [],
      unitName,
      groupNames: ['μ’s'],
    },
    P1,
    id
  );
}
function pending(sourceCardId: string, abilityId = ABILITY): PendingAbilityState {
  return {
    id: `pending:${sourceCardId}`,
    sourceCardId,
    abilityId,
    controllerId: P1,
    mandatory: true,
    timingId: TriggerCondition.ON_LIVE_START,
    eventIds: ['live-start-event'],
  };
}
function setup(
  options: {
    count?: number;
    noCenter?: boolean;
    noDeck?: boolean;
    noHand?: boolean;
    observer?: boolean;
    secondPending?: boolean;
    sourceCode?: string;
    successCode?: string;
  } = {}
) {
  const source = member('nozomi', options.sourceCode ?? 'PL!-pb2-016-R', '「lilywhite」');
  const center = member('center', 'PL!-pb2-010-P+', 'Printemps');
  const observer = member('observer', 'PL!HS-pb1-003-R', 'Mira-Cra Park!');
  const hand = member('hand');
  const deck = [member('drawn'), member('bottom')];
  const successes = Array.from({ length: options.count ?? 1 }, (_, index) =>
    index === 0
      ? createCardInstance(
          {
            cardCode: options.successCode ?? 'success-live',
            name: 'success-live',
            cardType: CardType.LIVE,
            score: 1,
            requirements: createHeartRequirement({}),
            unitName: '「lilywhite」',
          },
          P1,
          `success-${index}`
        )
      : member(`success-${index}`, `success-member-${index}`, 'lily white')
  );
  const wrongUnit = member('other-success', 'bibi-success', 'BiBi');
  let game = registerCards(
    {
      ...createGameState('pl-pb2-016', P1, 'P1', P2, 'P2'),
      currentPhase: GamePhase.MAIN_PHASE,
      currentSubPhase: SubPhase.NONE,
      activePlayerIndex: 0,
      waitingPlayerId: null,
    },
    [source, center, observer, hand, ...deck, ...successes, wrongUnit]
  );
  game = updatePlayer(game, P1, (player) => {
    let slots = placeCardInSlot(player.memberSlots, SlotPosition.LEFT, source.instanceId, {
      orientation: OrientationState.ACTIVE,
      face: FaceState.FACE_UP,
    });
    if (!options.noCenter)
      slots = placeCardInSlot(slots, SlotPosition.CENTER, center.instanceId, {
        orientation: OrientationState.WAITING,
        face: FaceState.FACE_UP,
      });
    if (options.observer)
      slots = placeCardInSlot(slots, SlotPosition.RIGHT, observer.instanceId, {
        orientation: OrientationState.ACTIVE,
        face: FaceState.FACE_UP,
      });
    return {
      ...player,
      memberSlots: slots,
      mainDeck: {
        ...player.mainDeck,
        cardIds: options.noDeck ? [] : deck.map((card) => card.instanceId),
      },
      hand: { ...player.hand, cardIds: options.noHand ? [] : ['hand'] },
      successZone: {
        ...player.successZone,
        cardIds: [
          ...successes.map((card) => card.instanceId),
          ...(successes.length < 2 ? ['other-success'] : []),
        ],
      },
    };
  });
  game = addCheckTimingRuleSentinel(game, P2, 'nozomi-opponent');
  game = {
    ...game,
    pendingAbilities: [
      pending('nozomi'),
      ...(options.secondPending
        ? [
            pending(
              'center',
              PL_PB2_010_LIVE_START_PRINTEMPS_ACTIVATED_STAGE_MEMBERS_GAIN_BLADE_ABILITY_ID
            ),
          ]
        : []),
    ],
  };
  let now = 10_000;
  const session = createGameSession({ now: () => now });
  session.restoreRuntimeState({
    authorityState: resolvePendingCardEffects(game).gameState,
    currentPublicSeq: 0,
  });
  return {
    session,
    setNow(value: number) {
      now = value;
    },
  };
}
function confirm(s: ReturnType<typeof setup>, cardId?: string | null) {
  const result = s.session.executeCommand(
    createConfirmEffectStepCommand(P1, s.session.state!.activeEffect!.id, cardId)
  );
  expect(result.success, result.error).toBe(true);
}
function choose(s: ReturnType<typeof setup>, option: string) {
  const result = s.session.executeCommand(
    createConfirmEffectChoiceCommand(P1, s.session.state!.activeEffect!.id, {
      selectedEffectOptionIds: [option],
    })
  );
  expect(result.success, result.error).toBe(true);
  expect(s.session.state?.activeEffect?.stepId).toBe(PUBLIC_EFFECT_CHOICE_CONFIRMATION_STEP_ID);
}
function advance(s: ReturnType<typeof setup>, playerId = P2) {
  const effect = s.session.state!.activeEffect!;
  s.setNow(effect.publicEffectChoiceAutoAdvanceAt!);
  const result = s.session.executeCommand(
    createAutoAdvancePublicEffectChoiceCommand(
      playerId,
      effect.id,
      effect.publicEffectChoiceAutoAdvanceAt!
    )
  );
  expect(result.success, result.error).toBe(true);
}
function replaceState(s: ReturnType<typeof setup>, game: GameState) {
  s.session.restoreRuntimeState({
    authorityState: game,
    currentPublicSeq: s.session.getCurrentPublicEventSeq(),
  });
}

describe('PL!-pb2-016 费用17「东条希」', () => {
  it('locks two choices for one 春情浪漫 and completes both even when success cards change between choices', () => {
    const s = setup({ count: 1, successCode: 'PL!-pb2-041-NEW' });
    expect(s.session.state?.activeEffect?.metadata?.totalChoices).toBe(2);
    choose(s, 'blade');
    advance(s);
    replaceState(
      s,
      updatePlayer(s.session.state!, P1, (p) => ({
        ...p,
        successZone: { ...p.successZone, cardIds: [] },
      }))
    );
    expect(s.session.state?.activeEffect?.metadata?.totalChoices).toBe(2);
    choose(s, 'blade');
    advance(s);
    expect(getMemberEffectiveBladeCount(s.session.state!, P1, 'center')).toBe(3);
    expect(s.session.state?.activeEffect).toBeNull();
    expect(s.session.state?.pendingAbilities).toEqual([]);
  });
  it('registers a single LIVE_START definition for all rarities with the full independent Chinese paragraph', () => {
    for (const code of ['PL!-pb2-016-R', 'PL!-pb2-016-UNSEEN']) {
      const definitions = getCardAbilityDefinitionsForCardCode(code);
      expect(definitions).toHaveLength(1);
      expect(definitions[0]).toMatchObject({
        abilityId: ABILITY,
        baseCardCodes: ['PL!-pb2-016'],
        category: CardAbilityCategory.LIVE_START,
        sourceZone: CardAbilitySourceZone.STAGE_MEMBER,
        triggerCondition: TriggerCondition.ON_LIVE_START,
        queued: true,
        implemented: true,
      });
      expect(definitions[0]?.cardCodes).toBeUndefined();
      expect(definitions[0]?.perTurnLimit).toBeUndefined();
      expect(definitions[0]?.effectText).toBe(EFFECT_TEXT);
    }
  });

  it('confirms a zero-count queued effect with live condition text and resolves without a choice', () => {
    const s = setup({ count: 0 });
    expect(s.session.state?.activeEffect?.metadata?.confirmOnlyPendingAbility).toBe(true);
    expect(s.session.state?.activeEffect?.effectText).toBe(
      `${EFFECT_TEXT}\n\n当前成功LIVE卡区的『lily white』卡片为0张，本次不进行选择。`
    );
    expect(s.session.state?.pendingAbilities).toHaveLength(1);
    confirm(s);
    expect(s.session.state?.activeEffect).toBeNull();
    expect(s.session.state?.pendingAbilities).toEqual([]);
    expect(s.session.state?.liveResolution.liveModifiers).toEqual([]);
  });

  it.each(['manual', 'ordered'] as const)(
    'keeps the zero-count %s pending confirmation contract',
    (mode) => {
      const s = setup({ count: 0, secondPending: true });
      expect(s.session.state?.activeEffect?.canResolveInOrder).toBe(true);
      if (mode === 'manual') {
        confirm(s, 'nozomi');
        expect(s.session.state?.activeEffect).toMatchObject({
          abilityId: ABILITY,
          metadata: { confirmOnlyPendingAbility: true },
        });
        expect(s.session.state?.pendingAbilities).toHaveLength(2);
        confirm(s);
        if (s.session.state?.activeEffect?.metadata?.confirmOnlyPendingAbility) confirm(s);
      } else {
        const result = s.session.executeCommand(
          createConfirmEffectStepCommand(
            P1,
            s.session.state!.activeEffect!.id,
            undefined,
            undefined,
            true
          )
        );
        expect(result.success, result.error).toBe(true);
      }
      expect(s.session.state?.activeEffect).toBeNull();
      expect(s.session.state?.pendingAbilities).toEqual([]);
    }
  );

  it('counts a LIVE and a MEMBER in the success zone, then permits two separately disclosed selections of BLADE', () => {
    const s = setup({ count: 2, sourceCode: 'PL!-pb2-016-UNSEEN' });
    expect(s.session.state?.activeEffect?.metadata).toMatchObject({
      totalChoices: 2,
      completedChoices: 0,
    });
    expect(s.session.state?.activeEffect?.metadata?.confirmOnlyPendingAbility).toBeUndefined();
    expect(
      s.session.state?.activeEffect?.effectChoice?.options.map((option) => option.text)
    ).toEqual([
      '存在于自己的舞台的中央区域的成员，LIVE结束时为止，获得[ブレード]。',
      '将存在于自己的舞台的1名成员变为活跃状态。',
      '抽1张卡，将1张手牌放置入休息室。',
    ]);
    const firstId = s.session.state!.activeEffect!.id;
    for (let index = 0; index < 2; index += 1) {
      choose(s, 'blade');
      const effect = s.session.state!.activeEffect!;
      const deadline = effect.publicEffectChoiceAutoAdvanceAt!;
      expect(getMemberEffectiveBladeCount(s.session.state!, P1, 'center')).toBe(1 + index);
      for (const playerId of [P1, P2])
        expect(s.session.getPlayerViewState(playerId)?.activeEffect).toMatchObject({
          publicEffectChoiceAutoAdvanceAt: deadline,
          effectChoice: { selectedOptionIds: ['blade'] },
        });
      expect(
        s.session.executeCommand(
          createAutoAdvancePublicEffectChoiceCommand(P1, effect.id, deadline)
        ).success
      ).toBe(false);
      advance(s, index === 0 ? P1 : P2);
      expect(getMemberEffectiveBladeCount(s.session.state!, P1, 'center')).toBe(2 + index);
      expect(getMemberEffectiveBladeCount(s.session.state!, P1, 'nozomi')).toBe(6);
      if (index === 0)
        expect(s.session.state?.activeEffect).toMatchObject({
          id: firstId,
          metadata: { completedChoices: 1, totalChoices: 2 },
          effectChoice: { mode: 'SINGLE' },
        });
      expect(
        s.session.executeCommand(
          createAutoAdvancePublicEffectChoiceCommand(P2, effect.id, deadline)
        ).success
      ).toBe(false);
    }
    expect(s.session.state?.activeEffect).toBeNull();
    expect(s.session.state?.pendingAbilities).toEqual([]);
    expect(
      s.session.state?.liveResolution.liveModifiers.filter(
        (modifier) => modifier.abilityId === ABILITY
      )
    ).toHaveLength(2);
  });

  it.each([{ selection: ['blade', 'blade'] }, { selection: ['invented'] }])(
    'rejects duplicate or forged SINGLE input %j without reducing the repeat count',
    ({ selection }) => {
      const s = setup({ count: 2 });
      const before = s.session.state!;
      const result = s.session.executeCommand(
        createConfirmEffectChoiceCommand(P1, before.activeEffect!.id, {
          selectedEffectOptionIds: selection,
        })
      );
      expect(result.success).toBe(false);
      expect(s.session.state).toBe(before);
    }
  );

  it('activates an own WAITING target through a state event, then offers the remaining choice', () => {
    const s = setup({ count: 2 });
    choose(s, 'member');
    expect(s.session.state?.players[0].memberSlots.cardStates.get('center')?.orientation).toBe(
      OrientationState.WAITING
    );
    advance(s);
    expect(s.session.state?.activeEffect).toMatchObject({
      selectableCardIds: ['center'],
      confirmSelectionLabel: '变为活跃状态',
    });
    expect(s.session.state?.activeEffect?.effectChoice).toBeUndefined();
    const before = s.session.state!;
    expect(
      s.session.executeCommand(
        createConfirmEffectStepCommand(P1, before.activeEffect!.id, 'nozomi')
      ).success
    ).toBe(false);
    expect(s.session.state).toBe(before);
    confirm(s, 'center');
    expect(s.session.state?.players[0].memberSlots.cardStates.get('center')?.orientation).toBe(
      OrientationState.ACTIVE
    );
    expect(
      s.session.state?.eventLog
        .map((entry) => entry.event)
        .filter((event) => event.eventType === TriggerCondition.ON_MEMBER_STATE_CHANGED)
    ).toEqual([
      expect.objectContaining({
        cardInstanceId: 'center',
        previousOrientation: OrientationState.WAITING,
        nextOrientation: OrientationState.ACTIVE,
        cause: expect.objectContaining({
          kind: 'CARD_EFFECT',
          playerId: P1,
          sourceCardId: 'nozomi',
          abilityId: ABILITY,
        }),
      }),
    ]);
    expect(
      s.session.state?.activeEffect?.effectChoice?.options.find((option) => option.id === 'member')
        ?.selectable
    ).toBe(true);
    choose(s, 'blade');
    advance(s);
    expect(s.session.state?.activeEffect).toBeNull();
  });

  it.each(['blade', 'member'])(
    'does not restore a target that leaves during %s disclosure',
    (choice) => {
      const s = setup();
      choose(s, choice);
      replaceState(
        s,
        updatePlayer(s.session.state!, P1, (player) => ({
          ...player,
          memberSlots: removeCardFromSlot(player.memberSlots, SlotPosition.CENTER),
          waitingRoom: { ...player.waitingRoom, cardIds: ['center'] },
        }))
      );
      advance(s);
      expect(s.session.state?.activeEffect).toBeNull();
      expect(s.session.state?.liveResolution.liveModifiers).toEqual([]);
      expect(s.session.state?.players[0].waitingRoom.cardIds).toEqual(['center']);
    }
  );

  it('draws and completes the required discard before its next choice, keeping new AUTO beside the old pending pool until the whole card ends', () => {
    const s = setup({ count: 2, observer: true, secondPending: true });
    expect(s.session.state?.activeEffect?.canResolveInOrder).toBe(true);
    const orderResult = s.session.executeCommand(
      createConfirmEffectStepCommand(
        P1,
        s.session.state!.activeEffect!.id,
        undefined,
        undefined,
        true
      )
    );
    expect(orderResult.success, orderResult.error).toBe(true);
    expect(s.session.state?.activeEffect?.abilityId).toBe(ABILITY);
    choose(s, 'draw-discard');
    expect(s.session.state?.players[0].hand.cardIds).toEqual(['hand']);
    advance(s);
    expect(s.session.state?.players[0].hand.cardIds).toEqual(['hand', 'drawn']);
    expect(s.session.state?.activeEffect).toMatchObject({
      selectableCardIds: ['hand', 'drawn'],
      canSkipSelection: false,
      metadata: { completedChoices: 0, totalChoices: 2 },
    });
    const effectId = s.session.state!.activeEffect!.id;
    expect(
      s.session.executeCommand(createConfirmEffectStepCommand(P1, effectId, null)).success
    ).toBe(false);
    confirm(s, 'drawn');
    expect(s.session.state?.activeEffect).toMatchObject({
      abilityId: ABILITY,
      metadata: { completedChoices: 1, totalChoices: 2 },
    });
    expect(s.session.state?.pendingAbilities.map((ability) => ability.abilityId)).toEqual(
      expect.arrayContaining([
        PL_PB2_010_LIVE_START_PRINTEMPS_ACTIVATED_STAGE_MEMBERS_GAIN_BLADE_ABILITY_ID,
        HS_PB1_003_AUTO_HAND_TO_WAITING_GAIN_HEART_BLADE_ABILITY_ID,
      ])
    );
    expect(s.session.state?.liveResolution.liveModifiers).toEqual([]);
    expect(
      s.session.state?.eventLog
        .map((entry) => entry.event)
        .filter((event) => event.eventType === TriggerCondition.ON_ENTER_WAITING_ROOM)
    ).toEqual([expect.objectContaining({ fromZone: ZoneType.HAND, cardInstanceIds: ['drawn'] })]);
    choose(s, 'blade');
    advance(s);
    expect(s.session.state?.endInfo).toBeNull();
    expect(s.session.state?.activeEffect?.canResolveInOrder).toBe(true);
    expect(s.session.state?.pendingAbilities).toHaveLength(2);
    confirm(s, 'observer');
    if (s.session.state?.activeEffect?.metadata?.confirmOnlyPendingAbility) confirm(s);
    expect(
      s.session.state?.actionHistory.some(
        (action) => action.payload.step === 'GAIN_PINK_HEART_AND_BLADE_FROM_HAND_TO_WAITING'
      )
    ).toBe(true);
    const finishIndex = s.session.state!.actionHistory.findIndex(
      (action) => action.payload.abilityId === ABILITY && action.payload.completedChoices === 2
    );
    const observerIndex = s.session.state!.actionHistory.findIndex(
      (action) => action.payload.step === 'GAIN_PINK_HEART_AND_BLADE_FROM_HAND_TO_WAITING'
    );
    expect(observerIndex).toBeGreaterThan(finishIndex);
  });

  it('still discards an existing hand when no card can be drawn', () => {
    const s = setup({ noDeck: true });
    choose(s, 'draw-discard');
    advance(s);
    expect(s.session.state?.activeEffect?.selectableCardIds).toEqual(['hand']);
    expect(s.session.state?.activeEffect?.metadata?.drawnCardIds).toEqual([]);
    confirm(s, 'hand');
    expect(s.session.state?.activeEffect).toBeNull();
    expect(
      s.session.state?.eventLog.some(
        (entry) => entry.event.eventType === TriggerCondition.ON_ENTER_WAITING_ROOM
      )
    ).toBe(true);
  });

  it('can repeat draw/discard after completing the previous forced discard', () => {
    const s = setup({ count: 2, noHand: true });
    choose(s, 'draw-discard');
    advance(s);
    confirm(s, 'drawn');
    expect(s.session.state?.activeEffect?.metadata).toMatchObject({
      completedChoices: 1,
      totalChoices: 2,
    });
    expect(s.session.state?.activeEffect?.selectableCardIds).toBeUndefined();
    choose(s, 'draw-discard');
    advance(s);
    expect(s.session.state?.activeEffect?.selectableCardIds).toEqual(['bottom']);
    confirm(s, 'bottom');
    expect(s.session.state?.activeEffect).toBeNull();
    expect(
      s.session.state?.actionHistory
        .filter(
          (action) =>
            action.payload.abilityId === ABILITY && action.payload.step === 'REPEAT_CHOICE_FINISHED'
        )
        .map((action) => action.payload.completedChoices)
    ).toEqual([1, 2]);
  });

  it('allows all printed options without targets and consumes each choice separately, including empty draw/discard', () => {
    const s = setup({ count: 3, noCenter: true, noDeck: true, noHand: true });
    expect(
      s.session.state?.activeEffect?.effectChoice?.options.map((option) => option.selectable)
    ).toEqual([true, true, true]);
    const before = s.session.state!;
    expect(
      s.session.executeCommand(createConfirmEffectStepCommand(P1, before.activeEffect!.id, null))
        .success
    ).toBe(false);
    expect(s.session.state).toBe(before);
    choose(s, 'blade');
    advance(s);
    expect(s.session.state?.activeEffect?.metadata).toMatchObject({
      completedChoices: 1,
      totalChoices: 3,
    });
    choose(s, 'member');
    advance(s);
    expect(s.session.state?.activeEffect?.metadata).toMatchObject({
      completedChoices: 2,
      totalChoices: 3,
    });
    choose(s, 'draw-discard');
    advance(s);
    expect(s.session.state?.activeEffect).toMatchObject({
      selectableCardIds: [],
      canSkipSelection: true,
    });
    confirm(s, null);
    expect(s.session.state?.activeEffect).toBeNull();
    expect(s.session.state?.pendingAbilities).toEqual([]);
  });
});
