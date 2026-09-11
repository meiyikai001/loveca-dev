import { describe, expect, it } from 'vitest';
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
  createLeaveStageEvent,
  createMemberStateChangedEvent,
  createTurnEndEvent,
  createTurnStartEvent,
  type MemberStateChangeCause,
} from '../../src/domain/events/game-events';
import { placeCardInSlot, removeCardFromSlot } from '../../src/domain/entities/zone';
import { getStageMemberIdsActivatedByOwnCardEffectThisTurn } from '../../src/domain/rules/member-turn-state';
import { isMemberStateChangeByOwnCardEffect } from '../../src/domain/rules/member-state-change-queries';
import { unitAliasIs } from '../../src/application/effects/card-selectors';
import {
  CardType,
  FaceState,
  OrientationState as O,
  SlotPosition as S,
  ZoneType,
} from '../../src/shared/types/enums';

const selector = unitAliasIs('Printemps');
const member = (code: string, unitName = 'Printemps'): MemberCardData => ({
  cardCode: code,
  name: code,
  cardType: CardType.MEMBER,
  cost: 1,
  blade: 1,
  hearts: [],
  unitName,
});
const cause = { kind: 'CARD_EFFECT' as const, playerId: 'p1', sourceCardId: 'source' };
function setup() {
  let game = registerCards(createGameState('history', 'p1', 'P1', 'p2', 'P2'), [
    createCardInstance(member('SOURCE'), 'p1', 'source'),
    createCardInstance(member('A'), 'p1', 'a'),
    createCardInstance(member('B'), 'p1', 'b'),
    createCardInstance(member('OTHER', 'BiBi'), 'p1', 'wrong'),
    createCardInstance(member('OPPONENT'), 'p2', 'opponent'),
  ]);
  for (const [slot, id] of [
    [S.LEFT, 'source'],
    [S.CENTER, 'a'],
    [S.RIGHT, 'b'],
  ] as const) {
    game = updatePlayer(game, 'p1', (p) => ({
      ...p,
      memberSlots: placeCardInSlot(p.memberSlots, slot, id, {
        orientation: O.ACTIVE,
        face: FaceState.FACE_UP,
      }),
    }));
  }
  return game;
}
function activated(
  game: GameState,
  id = 'a',
  effectCause: MemberStateChangeCause = cause,
  controller = 'p1'
) {
  return emitGameEvent(
    game,
    createMemberStateChangedEvent(id, controller, S.CENTER, O.WAITING, O.ACTIVE, effectCause)
  );
}
const query = (game: GameState) =>
  getStageMemberIdsActivatedByOwnCardEffectThisTurn(game, 'p1', selector);

describe('member state effect history query', () => {
  it('counts current stage rules objects once, even after they become waiting again; does not require source to remain on stage', () => {
    let game = activated(activated(activated(setup()), 'b'));
    game = emitGameEvent(
      game,
      createMemberStateChangedEvent('a', 'p1', S.CENTER, O.ACTIVE, O.WAITING, cause)
    );
    game = updatePlayer(game, 'p1', (p) => ({
      ...p,
      memberSlots: removeCardFromSlot(p.memberSlots, S.LEFT),
    }));
    expect(query(game)).toEqual(['a', 'b']);
  });
  it('excludes player/rule effects, another controller, a wrong unit, no actual change and off-stage targets', () => {
    let game = setup();
    for (const c of [
      { kind: 'PLAYER_ACTION', playerId: 'p1' },
      { kind: 'RULE_ACTION', playerId: 'p1' },
      { ...cause, playerId: 'p2' },
      { ...cause, sourceCardId: 'wrong' },
    ] as MemberStateChangeCause[])
      game = activated(game, 'a', c);
    game = activated(game, 'opponent', cause, 'p2');
    game = activated(game, 'wrong');
    game = emitGameEvent(
      game,
      createMemberStateChangedEvent('a', 'p1', S.CENTER, O.ACTIVE, O.ACTIVE, cause)
    );
    expect(query(game)).toEqual([]);
  });
  it('drops old lifecycle activation on cross-zone reentry but not an intra-stage entry', () => {
    let game = activated(setup());
    game = emitGameEvent(
      game,
      createEnterStageEvent('a', ZoneType.MEMBER_SLOT, S.CENTER, 'p1', 'p1')
    );
    expect(query(game)).toEqual(['a']);
    game = emitGameEvent(
      game,
      createLeaveStageEvent('a', S.CENTER, ZoneType.WAITING_ROOM, 'p1', 'p1')
    );
    game = emitGameEvent(
      game,
      createEnterStageEvent('a', ZoneType.WAITING_ROOM, S.CENTER, 'p1', 'p1')
    );
    expect(query(game)).toEqual([]);
    expect(query(activated(game))).toEqual(['a']);
  });
  it('uses the newest turn boundary and does not revive prior turn activations', () => {
    let game = emitGameEvent(setup(), createTurnStartEvent(1, 'p1'));
    game = activated(game);
    expect(query(game)).toEqual(['a']);
    game = emitGameEvent(game, createTurnEndEvent(1, 'p1'));
    expect(query(game)).toEqual([]);
    game = emitGameEvent(game, createTurnStartEvent(2, 'p2'));
    expect(query(game)).toEqual([]);
  });
  it('uses effect controller rather than card owner or player choosing a target', () => {
    const game = setup();
    const event = createMemberStateChangedEvent('a', 'p1', S.CENTER, O.WAITING, O.ACTIVE, {
      ...cause,
      sourceCardId: 'opponent',
      selectionPlayerId: 'p2',
    });
    expect(isMemberStateChangeByOwnCardEffect(game, event, 'p1', selector)).toBe(true);
    expect(isMemberStateChangeByOwnCardEffect(game, event, 'p2', selector)).toBe(false);
  });
});
