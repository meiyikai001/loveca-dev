import { describe, expect, it } from 'vitest';
import {
  createCardInstance,
  createHeartRequirement,
  type CardInstance,
  type MemberCardData,
} from '../../src/domain/entities/card';
import {
  createGameState,
  registerCards,
  updatePlayer,
  type GameState,
} from '../../src/domain/entities/game';
import { placeCardInSlot, removeCardFromSlot } from '../../src/domain/entities/zone';
import { resolvePendingCardEffects } from '../../src/application/card-effect-runner';
import {
  PL_BP5_002_ON_ENTER_WAIT_DISCARD_LOOK_TOP_HIGH_COST_MUSE_MEMBER_ABILITY_ID,
  PL_PB2_026_ACTIVATED_WAIT_SELF_DISCARD_LOOK_TOP_PRINTEMPS_MEMBER_ABILITY_ID,
  PL_PR_023_AUTO_TURN_THREE_MEMBER_WAITED_GAIN_BLADE_ABILITY_ID,
} from '../../src/application/card-effects/ability-ids';
import {
  CardAbilityCategory,
  CardAbilitySourceZone,
} from '../../src/application/card-effects/ability-definition-types';
import { getCardAbilityDefinitionsForCardCode } from '../../src/application/card-effects/definitions/lookup';
import { getActivatedAbilityUiConfig } from '../../src/application/card-effects/runtime/activated-ability-ui';
import { PUBLIC_REVEAL_DWELL_STEP_ID } from '../../src/application/card-effects/runtime/public-reveal-dwell';
import {
  createActivateAbilityCommand,
  createAutoAdvancePublicRevealCommand,
  createConfirmEffectStepCommand,
} from '../../src/application/game-commands';
import { createGameSession } from '../../src/application/game-session';
import { createPublicObjectId } from '../../src/online/projector';
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
const ABILITY = PL_PB2_026_ACTIVATED_WAIT_SELF_DISCARD_LOOK_TOP_PRINTEMPS_MEMBER_ABILITY_ID;
const EFFECT_TEXT =
  '【起动】将此成员变为待机状态，将1张手牌放置入休息室：检视自己的卡组顶的3张卡。可以将其中的1张『Printemps』的成员卡公开并加入手牌。其余的放置入休息室。（待机状态的成员持有的[ブレード]，不会使因声援公开的张数增加。）';

function member(id: string, cardCode = id, options: Partial<MemberCardData> = {}): CardInstance {
  return createCardInstance(
    {
      cardCode,
      name: cardCode,
      cardType: CardType.MEMBER,
      cost: 5,
      blade: 3,
      hearts: [],
      groupNames: ['μ’s'],
      unitName: '「Printemps」',
      ...options,
    },
    P1,
    id
  );
}

function setup(
  options: {
    sourceCode?: string;
    orientation?: OrientationState;
    handEmpty?: boolean;
    deck?: readonly CardInstance[];
    observer?: boolean;
    phase?: GamePhase;
    activePlayerIndex?: 0 | 1;
  } = {}
) {
  const source = member('hanayo', options.sourceCode ?? 'PL!-pb2-026-N', { name: '小泉花阳' });
  const discard = member('discard', 'test-discard', { unitName: 'BiBi' });
  const target = member('target', 'test-printemps-member', { cost: 1 });
  const otherUnit = member('other-unit', 'test-bibi-member', { unitName: 'BiBi' });
  const live = createCardInstance(
    {
      cardCode: 'test-printemps-live',
      name: 'test-live',
      cardType: CardType.LIVE,
      score: 1,
      requirements: createHeartRequirement({}),
      unitName: 'Printemps',
    },
    P1,
    'live'
  );
  const bottom = member('bottom');
  const observer = member('observer', 'PL!-PR-023-PR', { name: '绚濑绘里', cost: 11 });
  const deck = options.deck ?? [target, otherUnit, live, bottom];
  let game = registerCards(
    {
      ...createGameState('wait-discard-inspect', P1, 'P1', P2, 'P2'),
      currentPhase: options.phase ?? GamePhase.MAIN_PHASE,
      currentSubPhase: SubPhase.NONE,
      activePlayerIndex: options.activePlayerIndex ?? 0,
      waitingPlayerId: null,
    },
    [source, discard, ...deck, observer]
  );
  game = updatePlayer(game, P1, (player) => ({
    ...player,
    hand: { ...player.hand, cardIds: options.handEmpty ? [] : [discard.instanceId] },
    mainDeck: { ...player.mainDeck, cardIds: deck.map((card) => card.instanceId) },
    memberSlots: placeCardInSlot(player.memberSlots, SlotPosition.CENTER, source.instanceId, {
      orientation: options.orientation ?? OrientationState.ACTIVE,
      face: FaceState.FACE_UP,
    }),
  }));
  if (options.observer)
    game = updatePlayer(game, P1, (player) => ({
      ...player,
      memberSlots: placeCardInSlot(player.memberSlots, SlotPosition.LEFT, observer.instanceId, {
        orientation: OrientationState.ACTIVE,
        face: FaceState.FACE_UP,
      }),
    }));
  let now = 10_000;
  const session = createGameSession({ now: () => now });
  session.restoreRuntimeState({ authorityState: game, currentPublicSeq: 0 });
  return {
    session,
    source,
    discard,
    target,
    otherUnit,
    live,
    bottom,
    setNow(value: number) {
      now = value;
    },
  };
}

function activate(scenario: ReturnType<typeof setup>) {
  const result = scenario.session.executeCommand(
    createActivateAbilityCommand(P1, scenario.source.instanceId, ABILITY)
  );
  expect(result.success, result.error).toBe(true);
}

function confirm(scenario: ReturnType<typeof setup>, cardId?: string | null) {
  const result = scenario.session.executeCommand(
    createConfirmEffectStepCommand(P1, scenario.session.state!.activeEffect!.id, cardId)
  );
  expect(result.success, result.error).toBe(true);
}

function replaceState(scenario: ReturnType<typeof setup>, game: GameState) {
  scenario.session.restoreRuntimeState({
    authorityState: game,
    currentPublicSeq: scenario.session.getCurrentPublicEventSeq(),
  });
}

function abilityUses(game: GameState) {
  return game.actionHistory.filter(
    (action) => action.payload.step === 'ABILITY_USE' && action.payload.abilityId === ABILITY
  );
}

function inspectionWaitingEvents(game: GameState) {
  return game.eventLog
    .map((entry) => entry.event)
    .filter(
      (event) =>
        event.eventType === TriggerCondition.ON_ENTER_WAITING_ROOM &&
        event.fromZone === ZoneType.MAIN_DECK
    );
}

describe('wait-discard look-top shared family: PL!-pb2-026 费用5「小泉花阳」', () => {
  it('registers one unrestricted activated ability for every rarity with the complete JSON paragraph', () => {
    for (const code of ['PL!-pb2-026-N', 'PL!-pb2-026-UNSEEN']) {
      const definitions = getCardAbilityDefinitionsForCardCode(code);
      expect(definitions).toHaveLength(1);
      expect(definitions[0]).toMatchObject({
        abilityId: ABILITY,
        baseCardCodes: ['PL!-pb2-026'],
        category: CardAbilityCategory.ACTIVATED,
        sourceZone: CardAbilitySourceZone.STAGE_MEMBER,
        queued: false,
        implemented: true,
        requiredSourceOrientation: OrientationState.ACTIVE,
      });
      expect(definitions[0]?.cardCodes).toBeUndefined();
      expect(definitions[0]?.perTurnLimit).toBeUndefined();
      expect(definitions[0]?.effectText).toBe(EFFECT_TEXT);
      expect(definitions[0]?.activatedUi?.text).toBe(EFFECT_TEXT);
      expect(getActivatedAbilityUiConfig(code)?.text).toBe(EFFECT_TEXT);
    }
  });

  it('keeps payment optional until hand selection and does not select the fixed source', () => {
    const s = setup();
    activate(s);
    expect(s.session.state?.activeEffect).toMatchObject({
      selectableCardIds: ['discard'],
      selectableCardVisibility: 'AWAITING_PLAYER_ONLY',
      selectionLabel: '请选择要放置入休息室的卡牌',
      confirmSelectionLabel: '放置入休息室',
      canSkipSelection: true,
      skipSelectionLabel: '不发动',
      effectText: EFFECT_TEXT,
    });
    expect(s.session.state?.players[0].memberSlots.cardStates.get('hanayo')?.orientation).toBe(
      OrientationState.ACTIVE
    );
    confirm(s, null);
    expect(s.session.state?.activeEffect).toBeNull();
    expect(s.session.state?.players[0].hand.cardIds).toEqual(['discard']);
    expect(s.session.state?.inspectionZone.cardIds).toEqual([]);
    expect(abilityUses(s.session.state!)).toEqual([]);
    expect(s.session.state?.eventLog).toEqual([]);
  });

  it.each([
    { handEmpty: true },
    { orientation: OrientationState.WAITING },
    { sourceCode: 'PL!-pb2-025-N' },
    { phase: GamePhase.ENERGY_PHASE },
    { activePlayerIndex: 1 as const },
  ])('rejects an unpayable or illegal activated source: %o', (options) => {
    const s = setup(options);
    const before = s.session.state!;
    expect(
      s.session.executeCommand(createActivateAbilityCommand(P1, 'hanayo', ABILITY)).success
    ).toBe(false);
    expect(s.session.state).toBe(before);
  });

  it('rejects illegal and stale hand selections without paying either part of the cost', () => {
    const s = setup();
    activate(s);
    const started = s.session.state!;
    expect(
      s.session.executeCommand(
        createConfirmEffectStepCommand(P1, started.activeEffect!.id, 'target')
      ).success
    ).toBe(false);
    expect(s.session.state).toBe(started);
    replaceState(
      s,
      updatePlayer(started, P1, (player) => ({ ...player, hand: { ...player.hand, cardIds: [] } }))
    );
    expect(
      s.session.executeCommand(
        createConfirmEffectStepCommand(P1, started.activeEffect!.id, 'discard')
      ).success
    ).toBe(false);
    expect(s.session.state?.players[0].memberSlots.cardStates.get('hanayo')?.orientation).toBe(
      OrientationState.ACTIVE
    );
    expect(s.session.state?.eventLog).toEqual([]);
  });

  it.each(['leave', 'wait'] as const)(
    'safely abandons an unpaid cost if the source becomes stale: %s',
    (change) => {
      const s = setup();
      activate(s);
      replaceState(
        s,
        updatePlayer(s.session.state!, P1, (player) => ({
          ...player,
          memberSlots:
            change === 'leave'
              ? removeCardFromSlot(player.memberSlots, SlotPosition.CENTER)
              : placeCardInSlot(player.memberSlots, SlotPosition.CENTER, 'hanayo', {
                  orientation: OrientationState.WAITING,
                  face: FaceState.FACE_UP,
                }),
        }))
      );
      confirm(s, 'discard');
      expect(s.session.state?.activeEffect).toBeNull();
      expect(s.session.state?.players[0].hand.cardIds).toEqual(['discard']);
      expect(abilityUses(s.session.state!)).toEqual([]);
    }
  );

  it.each([P1, P2])(
    'keeps inspection private and delays movement and observers until %s advances the selected reveal',
    (advancer) => {
      const s = setup({ observer: true, sourceCode: 'PL!-pb2-026-UNSEEN' });
      activate(s);
      confirm(s, 'discard');
      const paid = s.session.state!;
      expect(paid.players[0].memberSlots.cardStates.get('hanayo')?.orientation).toBe(
        OrientationState.WAITING
      );
      expect(paid.players[0].waitingRoom.cardIds).toEqual(['discard']);
      expect(paid.activeEffect).toMatchObject({
        selectableCardIds: ['target'],
        inspectionCardIds: ['target', 'other-unit', 'live'],
        selectionLabel: '请选择要公开并加入手牌的成员卡',
        confirmSelectionLabel: '公开并加入手牌',
        skipSelectionLabel: '全部放置入休息室',
      });
      expect(abilityUses(paid)).toHaveLength(1);
      const waitEvents = paid.eventLog
        .map((entry) => entry.event)
        .filter((event) => event.eventType === TriggerCondition.ON_MEMBER_STATE_CHANGED);
      expect(waitEvents).toHaveLength(1);
      expect(waitEvents[0]).toMatchObject({
        cardInstanceId: 'hanayo',
        controllerId: P1,
        previousOrientation: OrientationState.ACTIVE,
        nextOrientation: OrientationState.WAITING,
        cause: { kind: 'CARD_EFFECT', playerId: P1, sourceCardId: 'hanayo' },
      });
      expect(
        paid.eventLog
          .map((entry) => entry.event)
          .filter((event) => event.eventType === TriggerCondition.ON_ENTER_WAITING_ROOM)
      ).toEqual([
        expect.objectContaining({
          cardInstanceIds: ['discard'],
          fromZone: ZoneType.HAND,
          toZone: ZoneType.WAITING_ROOM,
        }),
      ]);
      expect(
        paid.pendingAbilities.filter(
          (ability) =>
            ability.abilityId === PL_PR_023_AUTO_TURN_THREE_MEMBER_WAITED_GAIN_BLADE_ABILITY_ID
        )
      ).toHaveLength(1);
      for (const playerId of [P1, P2]) {
        const view = s.session.getPlayerViewState(playerId)!;
        for (const cardId of ['target', 'other-unit', 'live']) {
          expect(view.objects[createPublicObjectId(cardId)]?.surface).toBe(
            playerId === P1 ? 'FRONT' : 'BACK'
          );
        }
      }
      expect(
        s.session.executeCommand(createConfirmEffectStepCommand(P1, paid.activeEffect!.id, 'live'))
          .success
      ).toBe(false);
      expect(s.session.state).toBe(paid);
      confirm(s, 'target');
      const revealing = s.session.state!;
      const effect = revealing.activeEffect!;
      expect(effect.stepId).toBe(PUBLIC_REVEAL_DWELL_STEP_ID);
      expect(effect.revealedCardIds).toEqual(['target']);
      expect(effect.confirmSelectionLabel).toBeUndefined();
      expect(effect.canSkipSelection).toBeUndefined();
      expect(revealing.inspectionZone.cardIds).toEqual(['target', 'other-unit', 'live']);
      expect(revealing.players[0].hand.cardIds).toEqual([]);
      expect(inspectionWaitingEvents(revealing)).toEqual([]);
      expect(abilityUses(revealing)).toHaveLength(1);
      const deadline = effect.publicRevealAutoAdvanceAt!;
      const generation = effect.publicRevealGeneration!;
      for (const playerId of [P1, P2]) {
        const view = s.session.getPlayerViewState(playerId)!;
        expect(view.activeEffect).toMatchObject({
          publicRevealAutoAdvanceAt: deadline,
          publicRevealGeneration: generation,
        });
        expect(view.objects[createPublicObjectId('target')]?.surface).toBe('FRONT');
        expect(view.objects[createPublicObjectId('other-unit')]?.surface).toBe(
          playerId === P1 ? 'FRONT' : 'BACK'
        );
      }
      const advance = createAutoAdvancePublicRevealCommand(
        advancer,
        effect.id,
        deadline,
        generation
      );
      expect(s.session.executeCommand(advance).success).toBe(false);
      s.setNow(deadline);
      expect(
        s.session.executeCommand(
          createAutoAdvancePublicRevealCommand(advancer, effect.id, deadline, `${generation}:old`)
        ).success
      ).toBe(false);
      expect(s.session.state).toBe(revealing);
      expect(s.session.executeCommand(advance).success).toBe(true);
      const done = s.session.state!;
      expect(done.players[0].hand.cardIds).toEqual(['target']);
      expect(done.players[0].waitingRoom.cardIds).toEqual(['discard', 'other-unit', 'live']);
      expect(inspectionWaitingEvents(done)).toHaveLength(1);
      expect(inspectionWaitingEvents(done)[0]).toMatchObject({
        cardInstanceIds: ['other-unit', 'live'],
        fromZone: ZoneType.MAIN_DECK,
        toZone: ZoneType.WAITING_ROOM,
      });
      expect(done.pendingAbilities).toEqual([]);
      expect(done.activeEffect).toBeNull();
      const finishedAt = done.actionHistory.findIndex(
        (action) => action.payload.abilityId === ABILITY && action.payload.step === 'FINISH'
      );
      const observerAt = done.actionHistory.findIndex(
        (action) => action.payload.step === 'MEMBER_WAITED_GAIN_ONE_BLADE'
      );
      expect(observerAt).toBeGreaterThan(finishedAt);
      expect(s.session.executeCommand(advance).success).toBe(false);
      expect(s.session.state).toBe(done);
    }
  );

  it('may decline taking a card after paying and sends all inspected cards as one group', () => {
    const s = setup();
    activate(s);
    confirm(s, 'discard');
    confirm(s, null);
    expect(s.session.state?.activeEffect).toBeNull();
    expect(s.session.state?.players[0].hand.cardIds).toEqual([]);
    expect(s.session.state?.players[0].waitingRoom.cardIds).toEqual([
      'discard',
      'target',
      'other-unit',
      'live',
    ]);
    expect(inspectionWaitingEvents(s.session.state!)).toHaveLength(1);
    expect(abilityUses(s.session.state!)).toHaveLength(1);
  });

  it('preserves a short-deck reveal on reconnect and does not move a selected card removed before its deadline', () => {
    const target = member('short-target');
    const s = setup({ deck: [target] });
    activate(s);
    confirm(s, 'discard');
    confirm(s, 'short-target');
    const revealing = s.session.state!;
    const effect = revealing.activeEffect!;
    expect(effect.revealedCardIds).toEqual(['short-target']);
    expect(revealing.inspectionZone.cardIds).toEqual(['short-target', 'discard']);
    replaceState(s, revealing);
    expect(s.session.state?.activeEffect).toMatchObject({
      publicRevealAutoAdvanceAt: effect.publicRevealAutoAdvanceAt,
      publicRevealGeneration: effect.publicRevealGeneration,
    });
    const withoutTarget = updatePlayer(s.session.state!, P1, (player) => ({
      ...player,
      waitingRoom: { ...player.waitingRoom, cardIds: ['short-target'] },
    }));
    replaceState(s, {
      ...withoutTarget,
      inspectionZone: {
        ...withoutTarget.inspectionZone,
        cardIds: ['discard'],
        revealedCardIds: [],
      },
    });
    s.setNow(effect.publicRevealAutoAdvanceAt!);
    const result = s.session.executeCommand(
      createAutoAdvancePublicRevealCommand(
        P2,
        effect.id,
        effect.publicRevealAutoAdvanceAt!,
        effect.publicRevealGeneration!
      )
    );
    expect(result.success, result.error).toBe(true);
    expect(s.session.state?.players[0].hand.cardIds).toEqual([]);
    expect(s.session.state?.players[0].waitingRoom.cardIds).toEqual(['short-target']);
    expect(s.session.state?.inspectionZone.cardIds).toEqual(['discard']);
    expect(abilityUses(s.session.state!)).toHaveLength(1);
    expect(inspectionWaitingEvents(s.session.state!)).toEqual([]);
  });

  it('pays the complete cost with no target and a short deck, preserving inspection until confirmation', () => {
    const wrong = member('wrong', 'wrong-unit', { unitName: 'BiBi' });
    const s = setup({ deck: [wrong] });
    activate(s);
    confirm(s, 'discard');
    expect(s.session.state?.activeEffect).toMatchObject({
      inspectionCardIds: ['wrong', 'discard'],
      selectableCardIds: [],
      canSkipSelection: true,
      skipSelectionLabel: '全部放置入休息室',
    });
    expect(s.session.state?.players[0].waitingRoom.cardIds).toEqual([]);
    expect(abilityUses(s.session.state!)).toHaveLength(1);
    confirm(s, null);
    expect(s.session.state?.activeEffect).toBeNull();
    expect(inspectionWaitingEvents(s.session.state!)[0]).toMatchObject({
      cardInstanceIds: ['wrong', 'discard'],
    });
    expect(s.session.state?.players[0].memberSlots.cardStates.get('hanayo')?.orientation).toBe(
      OrientationState.WAITING
    );
  });

  it('allows paying with an initially empty deck and uses the existing check-top refresh before inspection', () => {
    const s = setup({ deck: [] });
    activate(s);
    confirm(s, 'discard');
    expect(s.session.state?.activeEffect).toMatchObject({
      inspectionCardIds: ['discard'],
      selectableCardIds: [],
    });
    expect(s.session.state?.players[0].memberSlots.cardStates.get('hanayo')?.orientation).toBe(
      OrientationState.WAITING
    );
    expect(abilityUses(s.session.state!)).toHaveLength(1);
    expect(inspectionWaitingEvents(s.session.state!)).toEqual([]);
    confirm(s, null);
    expect(s.session.state?.activeEffect).toBeNull();
    expect(inspectionWaitingEvents(s.session.state!)[0]).toMatchObject({
      cardInstanceIds: ['discard'],
    });
  });

  it('can activate again after becoming active, without a fabricated turn limit', () => {
    const s = setup();
    activate(s);
    confirm(s, 'discard');
    confirm(s, null);
    replaceState(
      s,
      updatePlayer(s.session.state!, P1, (player) => ({
        ...player,
        hand: { ...player.hand, cardIds: ['target'] },
        waitingRoom: {
          ...player.waitingRoom,
          cardIds: player.waitingRoom.cardIds.filter((id) => id !== 'target'),
        },
        memberSlots: placeCardInSlot(player.memberSlots, SlotPosition.CENTER, 'hanayo', {
          orientation: OrientationState.ACTIVE,
          face: FaceState.FACE_UP,
        }),
      }))
    );
    activate(s);
    confirm(s, 'target');
    confirm(s, null);
    expect(abilityUses(s.session.state!)).toHaveLength(2);
  });

  it('also enqueues source-WAIT observers for the older ON_ENTER family without interrupting inspection', () => {
    const s = setup({ sourceCode: 'PL!-bp5-002-R', observer: true });
    const game = s.session.state!;
    const pendingId = 'old-family-on-enter';
    const started = resolvePendingCardEffects({
      ...game,
      pendingAbilities: [
        {
          id: pendingId,
          abilityId: PL_BP5_002_ON_ENTER_WAIT_DISCARD_LOOK_TOP_HIGH_COST_MUSE_MEMBER_ABILITY_ID,
          sourceCardId: 'hanayo',
          controllerId: P1,
          mandatory: true,
          timingId: TriggerCondition.ON_ENTER_STAGE,
          eventIds: ['enter-event'],
          sourceSlot: SlotPosition.CENTER,
        },
      ],
    }).gameState;
    replaceState(s, started);
    confirm(s, 'discard');
    expect(s.session.state?.activeEffect?.abilityId).toBe(
      PL_BP5_002_ON_ENTER_WAIT_DISCARD_LOOK_TOP_HIGH_COST_MUSE_MEMBER_ABILITY_ID
    );
    expect(
      s.session.state?.pendingAbilities.filter(
        (ability) =>
          ability.abilityId === PL_PR_023_AUTO_TURN_THREE_MEMBER_WAITED_GAIN_BLADE_ABILITY_ID
      )
    ).toHaveLength(1);
    expect(
      s.session.state?.eventLog.filter(
        (entry) => entry.event.eventType === TriggerCondition.ON_MEMBER_STATE_CHANGED
      )
    ).toHaveLength(1);
    confirm(s, null);
    expect(s.session.state?.activeEffect).toBeNull();
    expect(s.session.state?.pendingAbilities).toEqual([]);
    expect(
      s.session.state?.actionHistory.filter(
        (action) => action.payload.step === 'MEMBER_WAITED_GAIN_ONE_BLADE'
      )
    ).toHaveLength(1);
  });
});
