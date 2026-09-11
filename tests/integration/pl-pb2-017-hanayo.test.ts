import { describe, expect, it } from 'vitest';
import {
  confirmActiveEffectStep,
  resolvePendingCardEffects,
} from '../../src/application/card-effect-runner';
import {
  N_SD2_010_AUTO_NIJIGASAKI_MEMBER_WAIT_DISCARD_ACTIVATE_GAIN_TWO_BLADE_ABILITY_ID as REACTION,
  PL_PB2_017_ON_ENTER_STACK_FOUR_PRINTEMPS_MEMBERS_ABILITY_ID as ENTER,
  PL_PB2_017_LIVE_START_DISCARD_BELOW_REPEAT_MEMBER_STATE_ABILITY_ID as START,
} from '../../src/application/card-effects/ability-ids';
import { getCardAbilityDefinitionsForCardCode } from '../../src/application/card-effects/definitions/lookup';
import { createConfirmEffectStepCommand } from '../../src/application/game-commands';
import { createGameSession } from '../../src/application/game-session';
import { createCardInstance, type MemberCardData } from '../../src/domain/entities/card';
import {
  createGameState,
  emitGameEvent,
  registerCards,
  updatePlayer,
  type GameState,
} from '../../src/domain/entities/game';
import {
  addEnergyBelowMember,
  addMemberBelowMember,
  placeCardInSlot,
  removeCardFromSlot,
} from '../../src/domain/entities/zone';
import { createEnterStageEvent } from '../../src/domain/events/game-events';
import { addMemberEffectActivationProhibitionUntilTurnEnd } from '../../src/domain/rules/member-effect-activation-prohibitions';
import {
  CardType,
  FaceState,
  OrientationState as O,
  SlotPosition as S,
  TriggerCondition as T,
  ZoneType,
} from '../../src/shared/types/enums';
import { createPublicObjectId, projectPlayerViewState } from '../../src/online/projector';
import { addCheckTimingRuleSentinel } from '../helpers/check-timing-rule-sentinel';

const ENTER_TEXT = '【登场】将存在于自己的休息室的4张『Printemps』的成员卡放置于此成员的下方。';
const START_TEXT =
  '【LIVE开始时】可以将存在于此成员的下方的至多3张卡片放置入休息室。每有1张因此放置入休息室的卡片，将存在于自己的舞台的1名『Printemps』的成员变为活跃状态或变为待机状态。';
function data(code: string, unitName = 'Printemps'): MemberCardData {
  return {
    cardCode: code,
    name: code,
    cardType: CardType.MEMBER,
    unitName,
    groupNames: ['μ’s'],
    cost: 17,
    blade: 6,
    hearts: [],
  };
}
function setup(abilityId = ENTER, waitingCount = 5, rarity = 'P+') {
  const cards = [
    createCardInstance(data(`PL!-pb2-017-${rarity}`), 'p1', 'hanayo'),
    ...Array.from({ length: 5 }, (_, i) => createCardInstance(data(`WAITING-${i}`), 'p1', `m${i}`)),
    createCardInstance(data('OTHER', 'BiBi'), 'p1', 'other'),
    createCardInstance({ cardCode: 'E', name: '能量', cardType: CardType.ENERGY }, 'p1', 'energy'),
  ];
  let game = registerCards(createGameState('hanayo', 'p1', 'P1', 'p2', 'P2'), cards);
  game = updatePlayer(game, 'p1', (p) => ({
    ...p,
    memberSlots: placeCardInSlot(p.memberSlots, S.CENTER, 'hanayo', {
      orientation: O.ACTIVE,
      face: FaceState.FACE_UP,
    }),
    waitingRoom: {
      ...p.waitingRoom,
      cardIds: [...Array.from({ length: waitingCount }, (_, i) => `m${i}`), 'other', 'energy'],
    },
  }));
  game = addCheckTimingRuleSentinel(game, 'p1', 'hanayo1');
  game = addCheckTimingRuleSentinel(game, 'p2', 'hanayo2');
  return {
    ...game,
    pendingAbilities: [
      {
        id: `pending:${abilityId}`,
        abilityId,
        sourceCardId: 'hanayo',
        controllerId: 'p1',
        mandatory: true,
        timingId: abilityId === ENTER ? T.ON_ENTER_STAGE : T.ON_LIVE_START,
        eventIds: [],
        sourceSlot: S.CENTER,
      },
    ],
  };
}
function withBelow(game: GameState, ids: readonly string[]) {
  return updatePlayer(game, 'p1', (p) => {
    let memberSlots = p.memberSlots;
    for (const id of ids)
      memberSlots =
        id === 'energy'
          ? addEnergyBelowMember(memberSlots, S.CENTER, id)
          : addMemberBelowMember(memberSlots, S.CENTER, id);
    return {
      ...p,
      memberSlots,
      waitingRoom: {
        ...p.waitingRoom,
        cardIds: p.waitingRoom.cardIds.filter((id) => !ids.includes(id)),
      },
    };
  });
}
function selectMany(game: GameState, ids: readonly string[]) {
  return confirmActiveEffectStep(
    game,
    'p1',
    game.activeEffect!.id,
    undefined,
    undefined,
    undefined,
    undefined,
    ids
  );
}
function selectMember(game: GameState, id = 'hanayo') {
  return confirmActiveEffectStep(game, 'p1', game.activeEffect!.id, id);
}
function createSession(game: GameState) {
  const session = createGameSession();
  session.createGame('hanayo-session', 'p1', 'P1', 'p2', 'P2');
  (session as unknown as { authorityState: GameState }).authorityState = game;
  return session;
}

describe('PL!-pb2-017 费用17「小泉花阳」', () => {
  it.each(['P', 'P+', 'R', 'NEW'])(
    'covers %s through base definitions and preserves both complete Chinese paragraphs',
    (rare) => {
      const defs = getCardAbilityDefinitionsForCardCode(`PL!-pb2-017-${rare}`);
      expect(defs.map((d) => d.abilityId)).toEqual([ENTER, START]);
      expect(defs.find((d) => d.abilityId === ENTER)?.effectText).toBe(ENTER_TEXT);
      expect(defs.find((d) => d.abilityId === START)?.effectText).toBe(START_TEXT);
      const state = resolvePendingCardEffects(setup(ENTER, 5, rare)).gameState;
      expect(state.activeEffect).toMatchObject({
        minSelectableCards: 4,
        maxSelectableCards: 4,
        canSkipSelection: false,
        effectText: ENTER_TEXT,
      });
    }
  );

  it('stacks all four selected members in one command, keeps both views public and rejects repeat submission', () => {
    const session = createSession(resolvePendingCardEffects(setup()).gameState);
    const ids = ['m0', 'm1', 'm2', 'm3'];
    const effectId = session.state!.activeEffect!.id;
    const command = createConfirmEffectStepCommand(
      'p1',
      effectId,
      undefined,
      undefined,
      undefined,
      undefined,
      ids
    );
    expect(session.executeCommand(command).success).toBe(true);
    expect(session.state!.activeEffect).toBeNull();
    expect(session.state!.pendingAbilities).toEqual([]);
    expect(session.state!.players[0]!.memberSlots.memberBelow[S.CENTER]).toEqual(ids);
    expect(session.state!.players[0]!.waitingRoom.cardIds).toEqual(['m4', 'other', 'energy']);
    for (const viewer of ['p1', 'p2']) {
      const view = projectPlayerViewState(session.state!, viewer);
      expect(view.table.zones.FIRST_MEMBER_CENTER.memberBelow?.CENTER).toEqual(
        ids.map(createPublicObjectId)
      );
      for (const id of ids) {
        expect(view.objects[createPublicObjectId(id)]?.surface).toBe('FRONT');
        expect(view.objects[createPublicObjectId(id)]?.frontInfo?.cardCode).toBe(
          session.state!.cardRegistry.get(id)!.data.cardCode
        );
      }
    }
    expect(session.state!.eventLog).toEqual([]);
    const after = session.state;
    expect(session.executeCommand(command).success).toBe(false);
    expect(session.state).toEqual(after);
  });

  it.each([1, 2, 3])(
    'stacks all %i available matching members when fewer than four exist',
    (count) => {
      let game = resolvePendingCardEffects(setup(ENTER, count)).gameState;
      expect(game.activeEffect).toMatchObject({
        minSelectableCards: count,
        maxSelectableCards: count,
      });
      const ids = Array.from({ length: count }, (_, i) => `m${i}`);
      game = selectMany(game, ids);
      expect(game.activeEffect).toBeNull();
      expect(game.players[0]!.memberSlots.memberBelow[S.CENTER]).toEqual(ids);
    }
  );

  it('has no optional skip, rejects duplicate/non-Printemps/incomplete selections and safely ends without targets', () => {
    const game = resolvePendingCardEffects(setup()).gameState;
    for (const ids of [[], ['m0'], ['m0', 'm0', 'm1', 'm2'], ['m0', 'm1', 'm2', 'other']]) {
      expect(selectMany(game, ids)).toBe(game);
    }
    expect(resolvePendingCardEffects(setup(ENTER, 0)).gameState.activeEffect).toBeNull();
  });

  it.each(['target-left', 'source-left', 'source-reentered'])(
    'rechecks %s when submitting the displayed selection and never partially stacks',
    (change) => {
      let game = resolvePendingCardEffects(setup()).gameState;
      if (change === 'target-left')
        game = updatePlayer(game, 'p1', (p) => ({
          ...p,
          waitingRoom: {
            ...p.waitingRoom,
            cardIds: p.waitingRoom.cardIds.filter((id) => id !== 'm0'),
          },
          hand: { ...p.hand, cardIds: ['m0'] },
        }));
      if (change === 'source-left')
        game = updatePlayer(game, 'p1', (p) => ({
          ...p,
          memberSlots: removeCardFromSlot(p.memberSlots, S.CENTER),
          hand: { ...p.hand, cardIds: ['hanayo'] },
        }));
      if (change === 'source-reentered')
        game = emitGameEvent(
          game,
          createEnterStageEvent('hanayo', ZoneType.HAND, S.CENTER, 'p1', 'p1')
        );
      game = selectMany(game, ['m0', 'm1', 'm2', 'm3']);
      expect(game.players[0]!.memberSlots.memberBelow[S.CENTER]).toEqual([]);
      expect(game.players[0]!.waitingRoom.cardIds).toEqual(
        expect.arrayContaining(['m1', 'm2', 'm3'])
      );
      if (change === 'target-left')
        expect(game.activeEffect?.selectableCardIds).toEqual(['m1', 'm2', 'm3', 'm4']);
      else expect(game.activeEffect).toBeNull();
    }
  );

  it('finishes the entire selected group before continuing the next pending stacking ability', () => {
    const initial = setup();
    let game = resolvePendingCardEffects(initial).gameState;
    game = {
      ...game,
      pendingAbilities: [{ ...initial.pendingAbilities[0]!, id: 'next-stacking-ability' }],
    };
    game = selectMany(game, ['m0', 'm1', 'm2', 'm3']);
    expect(game.players[0]!.memberSlots.memberBelow[S.CENTER]).toEqual(['m0', 'm1', 'm2', 'm3']);
    expect(game.activeEffect).toMatchObject({
      id: 'next-stacking-ability',
      selectableCardIds: ['m4'],
      minSelectableCards: 1,
      maxSelectableCards: 1,
    });
    game = selectMany(game, ['m4']);
    expect(game.activeEffect).toBeNull();
    expect(game.pendingAbilities).toEqual([]);
    expect(game.players[0]!.memberSlots.memberBelow[S.CENTER]).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
  });

  it('moves members and below energy together, then directly flips the same member three times without state options', () => {
    let game = resolvePendingCardEffects(withBelow(setup(START), ['m0', 'm1', 'energy'])).gameState;
    game = selectMany(game, ['m0', 'energy', 'm1']);
    expect(game.players[0]!.memberSlots.slots[S.CENTER]).toBe('hanayo');
    expect(game.players[0]!.memberSlots.memberBelow[S.CENTER]).toEqual([]);
    expect(game.players[0]!.memberSlots.energyBelow[S.CENTER]).toEqual([]);
    expect(game.players[0]!.energyDeck.cardIds).toEqual([]);
    expect(game.players[0]!.waitingRoom.cardIds).toEqual(
      expect.arrayContaining(['m0', 'm1', 'energy'])
    );
    expect(game.activeEffect).toMatchObject({
      stepId: 'PL_PB2_017_SELECT_PRINTEMPS_MEMBER',
      metadata: { remainingChanges: 3 },
      canSkipSelection: false,
      confirmSelectionLabel: '改变状态',
      effectText: START_TEXT,
    });
    const stepText =
      '请选择1名『Printemps』成员改变状态：活跃成员变为待机状态，待机成员变为活跃状态。还需处理3次，可以再次选择同一成员。';
    expect(game.activeEffect?.stepText).toBe(stepText);
    expect(game.activeEffect?.selectableOptions).toBeUndefined();
    for (const viewer of ['p1', 'p2']) {
      const view = projectPlayerViewState(game, viewer);
      expect(view.activeEffect).toMatchObject({
        effectText: START_TEXT,
        stepText,
        selectionLabel: '选择要改变状态的『Printemps』成员',
        confirmSelectionLabel: '改变状态',
      });
      expect(view.activeEffect?.selectableOptions).toBeUndefined();
    }
    const movement = game.eventLog.filter((e) => e.event.eventType === T.ON_ENTER_WAITING_ROOM);
    expect(movement).toHaveLength(1);
    expect(movement[0]!.event).toMatchObject({
      cardInstanceIds: ['m0', 'energy', 'm1'],
      fromZone: ZoneType.MEMBER_SLOT,
      toZone: ZoneType.WAITING_ROOM,
      cause: { sourceCardId: 'hanayo', abilityId: START },
    });
    for (const [index, orientation] of [O.WAITING, O.ACTIVE, O.WAITING].entries()) {
      game = selectMember(game);
      expect(game.players[0]!.memberSlots.cardStates.get('hanayo')?.orientation).toBe(orientation);
      expect(game.activeEffect?.selectableOptions).toBeUndefined();
      expect(
        game.eventLog.filter((e) => e.event.eventType === T.ON_MEMBER_STATE_CHANGED)
      ).toHaveLength(index + 1);
      if (index < 2)
        expect(game.activeEffect).toMatchObject({
          stepId: 'PL_PB2_017_SELECT_PRINTEMPS_MEMBER',
          metadata: { remainingChanges: 2 - index },
        });
    }
    expect(game.activeEffect).toBeNull();
    expect(game.players[0]!.memberSlots.cardStates.get('hanayo')?.orientation).toBe(O.WAITING);
    expect(
      game.eventLog.filter((e) => e.event.eventType === T.ON_MEMBER_STATE_CHANGED)
    ).toHaveLength(3);
    expect(
      game.eventLog.some(
        (e) =>
          e.event.eventType === T.ON_LEAVE_STAGE || e.event.eventType === T.ON_ENERGY_MOVED_TO_DECK
      )
    ).toBe(false);
    expect(game.actionHistory.some((a) => a.type === 'PAY_COST')).toBe(false);
  });

  it('declines zero and rejects excess, duplicate or stale below cards', () => {
    const game = resolvePendingCardEffects(
      withBelow(setup(START), ['m0', 'm1', 'm2', 'm3'])
    ).gameState;
    expect(selectMany(game, []).activeEffect).toBeNull();
    for (const ids of [['m0', 'm0'], ['m0', 'm1', 'm2', 'm3'], ['other']])
      expect(selectMany(game, ids)).toBe(game);
    const empty = resolvePendingCardEffects(setup(START)).gameState;
    expect(empty.activeEffect?.metadata?.confirmOnlyPendingAbility).toBe(true);
    expect(empty.activeEffect?.effectText).toBe(
      `${START_TEXT}\n（当前此成员下方有0张卡片，不进行成员状态改变。）`
    );
    expect(confirmActiveEffectStep(empty, 'p1', empty.activeEffect!.id).activeEffect).toBeNull();
  });

  it('rejects forged state options and invalid targets without consuming a repetition or refunding moved cards', () => {
    const game = selectMany(
      resolvePendingCardEffects(withBelow(setup(START), ['m0', 'm1'])).gameState,
      ['m0', 'm1']
    );
    for (const target of [undefined, 'hanayo'])
      for (const option of [O.ACTIVE, O.WAITING])
        expect(
          confirmActiveEffectStep(
            game,
            'p1',
            game.activeEffect!.id,
            target,
            undefined,
            undefined,
            option
          )
        ).toBe(game);
    expect(selectMember(game, 'other')).toBe(game);
    expect(selectMany(game, ['hanayo'])).toBe(game);
    expect(game.activeEffect?.metadata?.remainingChanges).toBe(2);
    expect(game.players[0]!.waitingRoom.cardIds).toEqual(expect.arrayContaining(['m0', 'm1']));
    expect(game.eventLog.filter((e) => e.event.eventType === T.ON_MEMBER_STATE_CHANGED)).toEqual(
      []
    );
    const changed = selectMember(game);
    expect(changed.activeEffect?.metadata?.remainingChanges).toBe(1);
    expect(changed.players[0]!.memberSlots.cardStates.get('hanayo')?.orientation).toBe(O.WAITING);
  });

  it('keeps newly triggered abilities pending between state changes and continues only after the final change', () => {
    let game = withBelow(setup(START), ['m0', 'm1', 'energy']);
    game = registerCards(game, [
      createCardInstance(
        { ...data('PL!N-sd2-010-SD', 'other'), groupNames: ['虹ヶ咲'] },
        'p1',
        'reaction'
      ),
    ]);
    const registry = new Map(game.cardRegistry);
    const hanayo = registry.get('hanayo')!;
    registry.set('hanayo', { ...hanayo, data: { ...hanayo.data, groupNames: ['虹ヶ咲'] } });
    game = updatePlayer({ ...game, cardRegistry: registry }, 'p1', (p) => ({
      ...p,
      memberSlots: placeCardInSlot(p.memberSlots, S.RIGHT, 'reaction', {
        orientation: O.ACTIVE,
        face: FaceState.FACE_UP,
      }),
      hand: { ...p.hand, cardIds: ['other'] },
      waitingRoom: {
        ...p.waitingRoom,
        cardIds: p.waitingRoom.cardIds.filter((id) => id !== 'other'),
      },
    }));
    game = selectMany(resolvePendingCardEffects(game).gameState, ['m0', 'm1', 'energy']);
    game = selectMember(game);
    expect(game.activeEffect).toMatchObject({
      abilityId: START,
      metadata: { remainingChanges: 2 },
    });
    expect(game.pendingAbilities.some((p) => p.abilityId === REACTION)).toBe(true);
    game = selectMember(game);
    expect(game.activeEffect).toMatchObject({
      abilityId: START,
      metadata: { remainingChanges: 1 },
    });
    expect(game.pendingAbilities.some((p) => p.abilityId === REACTION)).toBe(true);
    game = selectMember(game);
    expect(
      game.eventLog.filter((e) => e.event.eventType === T.ON_MEMBER_STATE_CHANGED)
    ).toHaveLength(3);
    expect(game.activeEffect?.abilityId).toBe(REACTION);
  });

  it('manually selecting an empty LIVE-start ability confirms, while ordered resolution resolves both without confirmation', () => {
    const initial = setup(START);
    const game = {
      ...initial,
      pendingAbilities: [
        initial.pendingAbilities[0]!,
        { ...initial.pendingAbilities[0]!, id: 'second-empty' },
      ],
    };
    const ordered = resolvePendingCardEffects(game).gameState;
    expect(ordered.activeEffect?.abilityId).toBe('system:select-pending-card-effect');
    const manual = confirmActiveEffectStep(
      ordered,
      'p1',
      ordered.activeEffect!.id,
      undefined,
      undefined,
      undefined,
      initial.pendingAbilities[0]!.id
    );
    expect(manual.activeEffect?.metadata?.confirmOnlyPendingAbility).toBe(true);
    expect(manual.activeEffect?.effectText).toBe(
      `${START_TEXT}\n（当前此成员下方有0张卡片，不进行成员状态改变。）`
    );
    const result = confirmActiveEffectStep(
      ordered,
      'p1',
      ordered.activeEffect!.id,
      null,
      null,
      true
    );
    expect(result.activeEffect).toBeNull();
    expect(result.pendingAbilities).toEqual([]);
  });

  it('rechecks a reentered target against the displayed window lifecycle without replacing the original source lifecycle', () => {
    let game = selectMany(resolvePendingCardEffects(withBelow(setup(START), ['m0'])).gameState, [
      'm0',
    ]);
    const sourceLifecycleId = game.activeEffect?.sourceLifecycleId;
    const oldTargetLifecycleIds = game.activeEffect?.metadata?.targetLifecycleIds;
    game = emitGameEvent(
      game,
      createEnterStageEvent('hanayo', ZoneType.HAND, S.CENTER, 'p1', 'p1')
    );
    game = selectMember(game);
    expect(game.activeEffect).toMatchObject({
      stepId: 'PL_PB2_017_SELECT_PRINTEMPS_MEMBER',
      metadata: { remainingChanges: 1 },
      sourceLifecycleId,
    });
    expect(game.activeEffect?.metadata?.targetLifecycleIds).not.toEqual(oldTargetLifecycleIds);
    expect(game.players[0]!.waitingRoom.cardIds).toContain('m0');
    expect(game.players[0]!.memberSlots.cardStates.get('hanayo')?.orientation).toBe(O.ACTIVE);
    expect(game.eventLog.filter((e) => e.event.eventType === T.ON_MEMBER_STATE_CHANGED)).toEqual(
      []
    );
    game = selectMember(game);
    expect(game.activeEffect).toBeNull();
    expect(game.players[0]!.memberSlots.cardStates.get('hanayo')?.orientation).toBe(O.WAITING);
  });

  it('refreshes a departed target and retains moved cards and remaining repetitions for another member', () => {
    let game = withBelow(setup(START), ['m0', 'm1']);
    game = updatePlayer(game, 'p1', (p) => ({
      ...p,
      memberSlots: placeCardInSlot(p.memberSlots, S.LEFT, 'm2', {
        orientation: O.WAITING,
        face: FaceState.FACE_UP,
      }),
      waitingRoom: { ...p.waitingRoom, cardIds: p.waitingRoom.cardIds.filter((id) => id !== 'm2') },
    }));
    game = selectMany(resolvePendingCardEffects(game).gameState, ['m0', 'm1']);
    game = updatePlayer(game, 'p1', (p) => ({
      ...p,
      memberSlots: removeCardFromSlot(p.memberSlots, S.CENTER),
      hand: { ...p.hand, cardIds: ['hanayo'] },
    }));
    game = selectMember(game);
    expect(game.activeEffect).toMatchObject({
      selectableCardIds: ['m2'],
      metadata: { remainingChanges: 2 },
    });
    expect(game.players[0]!.waitingRoom.cardIds).toEqual(expect.arrayContaining(['m0', 'm1']));
    expect(game.eventLog.filter((e) => e.event.eventType === T.ON_MEMBER_STATE_CHANGED)).toEqual(
      []
    );
    game = selectMember(game, 'm2');
    expect(game.players[0]!.memberSlots.cardStates.get('m2')?.orientation).toBe(O.ACTIVE);
    expect(game.activeEffect?.metadata?.remainingChanges).toBe(1);
    game = selectMember(game, 'm2');
    expect(game.activeEffect).toBeNull();
    expect(game.players[0]!.memberSlots.cardStates.get('m2')?.orientation).toBe(O.WAITING);
  });

  it('filters prohibited activation and ends safely when no remaining member can change state', () => {
    let game = withBelow(setup(START), ['m0', 'm1']);
    game = updatePlayer(game, 'p1', (p) => ({
      ...p,
      memberSlots: placeCardInSlot(p.memberSlots, S.LEFT, 'm2', {
        orientation: O.WAITING,
        face: FaceState.FACE_UP,
      }),
      waitingRoom: { ...p.waitingRoom, cardIds: p.waitingRoom.cardIds.filter((id) => id !== 'm2') },
    }));
    game = addMemberEffectActivationProhibitionUntilTurnEnd(game, {
      affectedPlayerIds: ['p1'],
      sourceCardId: 'other',
      abilityId: 'test-prohibit-activation',
    });
    game = selectMany(resolvePendingCardEffects(game).gameState, ['m0', 'm1']);
    expect(game.activeEffect?.selectableCardIds).toEqual(['hanayo']);
    expect(game.activeEffect?.metadata?.remainingChanges).toBe(2);
    game = selectMember(game);
    expect(game.activeEffect).toBeNull();
    expect(game.pendingAbilities.some((p) => p.abilityId === START)).toBe(false);
    expect(game.players[0]!.memberSlots.cardStates.get('hanayo')?.orientation).toBe(O.WAITING);
    expect(game.players[0]!.waitingRoom.cardIds).toEqual(expect.arrayContaining(['m0', 'm1']));
    expect(
      game.eventLog.filter((e) => e.event.eventType === T.ON_MEMBER_STATE_CHANGED)
    ).toHaveLength(1);
    expect(
      game.actionHistory.filter((a) => a.payload.step === 'CHANGE_PRINTEMPS_MEMBER_STATE')
    ).toHaveLength(1);
    expect(
      game.actionHistory.some((a) => a.payload.step === 'NO_CHANGEABLE_PRINTEMPS_TARGET')
    ).toBe(true);
  });

  it('safely ends without consuming a state change if activation becomes prohibited during target selection', () => {
    let game = withBelow(setup(START), ['m0']);
    game = updatePlayer(game, 'p1', (p) => ({
      ...p,
      memberSlots: {
        ...p.memberSlots,
        cardStates: new Map([['hanayo', { orientation: O.WAITING, face: FaceState.FACE_UP }]]),
      },
    }));
    game = selectMany(resolvePendingCardEffects(game).gameState, ['m0']);
    expect(game.activeEffect?.selectableCardIds).toEqual(['hanayo']);
    game = addMemberEffectActivationProhibitionUntilTurnEnd(game, {
      affectedPlayerIds: ['p1'],
      sourceCardId: 'other',
      abilityId: 'test-prohibit-activation',
    });
    game = selectMember(game);
    expect(game.activeEffect).toBeNull();
    expect(game.players[0]!.waitingRoom.cardIds).toContain('m0');
    expect(game.players[0]!.memberSlots.cardStates.get('hanayo')?.orientation).toBe(O.WAITING);
    expect(game.eventLog.filter((e) => e.event.eventType === T.ON_MEMBER_STATE_CHANGED)).toEqual(
      []
    );
    expect(
      game.actionHistory.filter((a) => a.payload.step === 'CHANGE_PRINTEMPS_MEMBER_STATE')
    ).toEqual([]);
  });
});
