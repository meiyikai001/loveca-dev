import { describe, expect, it } from 'vitest';
import {
  confirmActiveEffectStep,
  enqueueTriggeredCardEffects,
  resolvePendingCardEffects,
} from '../../src/application/card-effect-runner';
import { PL_PB2_011_AUTO_OWN_EFFECT_WAIT_OPPONENT_STACK_BIBI_MEMBER_ABILITY_ID as ABILITY } from '../../src/application/card-effects/ability-ids';
import { enqueueMemberStateChangedTriggersFromOrientationResult } from '../../src/application/card-effects/runtime/member-state-changed-triggers';
import { setMemberOrientation } from '../../src/application/effects/member-state';
import { createCardInstance, type MemberCardData } from '../../src/domain/entities/card';
import {
  createGameState,
  emitGameEvent,
  registerCards,
  updatePlayer,
  type GameState,
} from '../../src/domain/entities/game';
import {
  createEnterStageEvent,
  createMemberStateChangedEvent,
  type MemberStateChangeCause,
  type MemberStateChangedEvent,
} from '../../src/domain/events/game-events';
import {
  addEnergyBelowMember,
  placeCardInSlot,
  removeCardFromSlot,
} from '../../src/domain/entities/zone';
import { getMemberEffectiveBladeCount } from '../../src/domain/rules/live-modifiers';
import {
  CardType,
  FaceState,
  OrientationState as O,
  SlotPosition as S,
  TriggerCondition as T,
  ZoneType,
} from '../../src/shared/types/enums';
import { addCheckTimingRuleSentinel } from '../helpers/check-timing-rule-sentinel';

const data = (cardCode: string, unitName = 'BiBi'): MemberCardData => ({
  cardCode,
  name: cardCode,
  unitName,
  cardType: CardType.MEMBER,
  cost: 2,
  blade: 1,
  hearts: [],
});
const cause = {
  kind: 'CARD_EFFECT' as const,
  playerId: 'p1',
  sourceCardId: 'eli',
  abilityId: 'test-wait',
};
function setup() {
  const cards = [
    createCardInstance(data('PL!-pb2-011-NEW'), 'p1', 'eli'),
    createCardInstance(data('OPP'), 'p2', 'opponent'),
    ...['b1', 'b2', 'b3', 'b4'].map((id) => createCardInstance(data(id, '「BiBi」'), 'p1', id)),
    createCardInstance(data('OTHER', 'Printemps'), 'p1', 'other'),
    createCardInstance(
      { cardCode: 'E', name: 'energy', cardType: CardType.ENERGY },
      'p1',
      'energy'
    ),
  ];
  let game = registerCards(createGameState('eli', 'p1', 'P1', 'p2', 'P2'), cards);
  for (const [playerId, cardId] of [
    ['p1', 'eli'],
    ['p2', 'opponent'],
  ])
    game = updatePlayer(game, playerId!, (p) => ({
      ...p,
      memberSlots: placeCardInSlot(p.memberSlots, S.CENTER, cardId!, {
        orientation: O.ACTIVE,
        face: FaceState.FACE_UP,
      }),
    }));
  game = updatePlayer(game, 'p1', (p) => ({
    ...p,
    waitingRoom: { ...p.waitingRoom, cardIds: ['b1', 'b2', 'b3', 'b4', 'other', 'energy'] },
  }));
  game = addCheckTimingRuleSentinel(game, 'p1', 'eli1');
  return addCheckTimingRuleSentinel(game, 'p2', 'eli2');
}
function event(c: MemberStateChangeCause = cause, controller = 'p2'): MemberStateChangedEvent {
  return createMemberStateChangedEvent(
    controller === 'p1' ? 'eli' : 'opponent',
    controller,
    S.CENTER,
    O.ACTIVE,
    O.WAITING,
    c
  );
}
function enqueue(game: GameState, events: MemberStateChangedEvent[]) {
  for (const e of events) game = emitGameEvent(game, e);
  return enqueueTriggeredCardEffects(game, [T.ON_MEMBER_STATE_CHANGED], {
    memberStateChangedEvents: events,
  });
}
function select(game: GameState, id: string) {
  return confirmActiveEffectStep(game, 'p1', game.activeEffect!.id, id);
}
const pending = (game: GameState) => game.pendingAbilities.filter((a) => a.abilityId === ABILITY);

describe('PL!-pb2-011 费用2 绚濑绘里 opponent waited observer and stacking', () => {
  it('enqueues one ability per actual event, is idempotent, and waits until the current multistep effect finishes', () => {
    const e1 = event(),
      e2 = event();
    let game = setup();
    const active = {
      id: 'other-active',
      abilityId: 'other',
      sourceCardId: 'other',
      controllerId: 'p1',
      awaitingPlayerId: 'p1',
      effectText: 'test',
      stepId: 'TEST',
    };
    game = enqueue({ ...game, activeEffect: active }, [e1, e2, e1]);
    expect(pending(game)).toHaveLength(2);
    expect(pending(game).map((a) => a.eventIds)).toEqual([[e1.eventId], [e2.eventId]]);
    expect(game.activeEffect).toEqual(active);
    game = enqueueTriggeredCardEffects(game, [T.ON_MEMBER_STATE_CHANGED], {
      memberStateChangedEvents: [e1, e2],
    });
    expect(pending(game)).toHaveLength(2);
  });
  it('takes at most three cards through separately resolving events, rechecks cap, and changes BLADE dynamically', () => {
    let game = enqueue(setup(), [event(), event(), event(), event()]);
    game = resolvePendingCardEffects(game).gameState;
    game = confirmActiveEffectStep(game, 'p1', game.activeEffect!.id, null, null, true);
    expect(game.activeEffect).toMatchObject({
      abilityId: ABILITY,
      selectableCardIds: ['b1', 'b2', 'b3', 'b4'],
      canSkipSelection: false,
      selectionLabel: '选择要放置于此成员下方的成员卡',
      confirmSelectionLabel: '放置于此成员下方',
    });
    for (const id of ['b1', 'b2', 'b3']) game = select(game, id);
    expect(game.activeEffect).toBeNull();
    expect(pending(game)).toEqual([]);
    expect(game.players[0]!.memberSlots.memberBelow[S.CENTER]).toEqual(['b1', 'b2', 'b3']);
    expect(game.players[0]!.waitingRoom.cardIds).toContain('b4');
    expect(getMemberEffectiveBladeCount(game, 'p1', 'eli')).toBe(4);
    expect(game.eventLog.some((e) => e.event.eventType === T.ON_ENTER_STAGE)).toBe(false);
    const e = game.eventLog.find((e) => e.event.eventType === T.ON_MEMBER_STATE_CHANGED)!
      .event as MemberStateChangedEvent;
    expect(
      pending(
        enqueueTriggeredCardEffects(game, [T.ON_MEMBER_STATE_CHANGED], {
          memberStateChangedEvents: [e],
        })
      )
    ).toEqual([]);
  });
  it('rejects own member / opponent effect / rule / player events and ignores no actual change through the wrapper', () => {
    let game = enqueue(setup(), [
      event(cause, 'p1'),
      event({ ...cause, playerId: 'p2' }),
      event({ kind: 'RULE_ACTION', playerId: 'p1' }),
      event({ kind: 'PLAYER_ACTION', playerId: 'p1' }),
    ]);
    expect(pending(game)).toEqual([]);
    const result = setMemberOrientation(game, 'p2', 'opponent', O.ACTIVE, cause)!;
    game = enqueueMemberStateChangedTriggersFromOrientationResult(
      game,
      result,
      enqueueTriggeredCardEffects
    ).gameState;
    expect(pending(game)).toEqual([]);
    const actual = setMemberOrientation(game, 'p2', 'opponent', O.WAITING, cause)!;
    game = enqueueMemberStateChangedTriggersFromOrientationResult(
      game,
      actual,
      enqueueTriggeredCardEffects
    ).gameState;
    expect(pending(game)).toHaveLength(1);
  });
  it('includes below energy in the cap and safely finishes if source leaves or returns as a new object', () => {
    let game = setup();
    game = updatePlayer(game, 'p1', (p) => ({
      ...p,
      memberSlots: addEnergyBelowMember(p.memberSlots, S.CENTER, 'energy'),
    }));
    game = enqueue(game, [event(), event(), event()]);
    game = resolvePendingCardEffects(game).gameState;
    game = confirmActiveEffectStep(game, 'p1', game.activeEffect!.id, null, null, true);
    game = select(select(game, 'b1'), 'b2');
    expect(game.activeEffect).toBeNull();
    expect(game.players[0]!.memberSlots.memberBelow[S.CENTER]).toEqual(['b1', 'b2']);
    let stale = resolvePendingCardEffects(enqueue(setup(), [event()])).gameState;
    stale = updatePlayer(stale, 'p1', (p) => ({
      ...p,
      memberSlots: removeCardFromSlot(p.memberSlots, S.CENTER),
    }));
    expect(select(stale, 'b1').activeEffect).toBeNull();
    let reentered = resolvePendingCardEffects(enqueue(setup(), [event()])).gameState;
    reentered = emitGameEvent(
      reentered,
      createEnterStageEvent('eli', ZoneType.WAITING_ROOM, S.CENTER, 'p1', 'p1')
    );
    const done = select(reentered, 'b1');
    expect(done.activeEffect).toBeNull();
    expect(done.players[0]!.memberSlots.memberBelow[S.CENTER]).toEqual([]);
  });
  it('rejects invalid/skip selections, refreshes stale choices and completes with no available target', () => {
    const game = resolvePendingCardEffects(enqueue(setup(), [event()])).gameState;
    expect(select(game, 'other')).toBe(game);
    expect(confirmActiveEffectStep(game, 'p1', game.activeEffect!.id)).toBe(game);
    const stale = updatePlayer(game, 'p1', (p) => ({
      ...p,
      waitingRoom: { ...p.waitingRoom, cardIds: ['b2'] },
    }));
    const refreshed = select(stale, 'b1');
    expect(refreshed.activeEffect?.selectableCardIds).toEqual(['b2']);
    const empty = updatePlayer(refreshed, 'p1', (p) => ({
      ...p,
      waitingRoom: { ...p.waitingRoom, cardIds: [] },
    }));
    expect(select(empty, 'b2').activeEffect).toBeNull();
  });
});
