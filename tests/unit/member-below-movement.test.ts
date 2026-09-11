import { describe, expect, it, vi } from 'vitest';
import { moveCardsBelowSourceMemberToWaitingRoomAndEnqueueTriggers as moveBelow } from '../../src/application/card-effects/runtime/member-below-movement';
import { createCardInstance, type MemberCardData } from '../../src/domain/entities/card';
import {
  createGameState,
  registerCards,
  updatePlayer,
  type GameState,
} from '../../src/domain/entities/game';
import {
  addEnergyBelowMember,
  addMemberBelowMember,
  placeCardInSlot,
} from '../../src/domain/entities/zone';
import {
  CardType,
  SlotPosition as S,
  TriggerCondition as T,
  ZoneType,
} from '../../src/shared/types/enums';

const cause = {
  kind: 'CARD_EFFECT' as const,
  playerId: 'p1',
  sourceCardId: 'host',
  abilityId: 'below-test',
  pendingAbilityId: 'pending',
};
function setup() {
  const member = (id: string): MemberCardData => ({
    cardCode: id,
    name: id,
    cardType: CardType.MEMBER,
    cost: 1,
    blade: 1,
    hearts: [],
  });
  let game = registerCards(createGameState('below', 'p1', 'P1', 'p2', 'P2'), [
    ...['host', 'member', 'other'].map((id) => createCardInstance(member(id), 'p1', id)),
    createCardInstance({ cardCode: 'E', name: 'E', cardType: CardType.ENERGY }, 'p1', 'energy'),
  ]);
  game = updatePlayer(game, 'p1', (p) => ({
    ...p,
    memberSlots: addEnergyBelowMember(
      addMemberBelowMember(placeCardInSlot(p.memberSlots, S.CENTER, 'host'), S.CENTER, 'member'),
      S.CENTER,
      'energy'
    ),
  }));
  return game;
}
describe('explicit member-below card-effect movement', () => {
  it('moves member and energy together, leaves the host intact, and enqueues precisely the new grouped event', () => {
    const before = setup();
    const enqueue = vi.fn((game: GameState) => game);
    const result = moveBelow(
      before,
      { playerId: 'p1', sourceCardId: 'host', selectedCardIds: ['member', 'energy'], cause },
      enqueue
    )!;
    expect(result.movedCardIds).toEqual(['member', 'energy']);
    expect(result.gameState.players[0]!.waitingRoom.cardIds).toEqual(['member', 'energy']);
    expect(result.gameState.players[0]!.energyDeck.cardIds).toEqual([]);
    expect(result.gameState.players[0]!.memberSlots.slots).toEqual(
      before.players[0]!.memberSlots.slots
    );
    expect(result.gameState.players[0]!.memberSlots.cardStates).toEqual(
      before.players[0]!.memberSlots.cardStates
    );
    expect(result.enterWaitingRoomEvent).toMatchObject({
      cardInstanceIds: ['member', 'energy'],
      fromZone: ZoneType.MEMBER_SLOT,
      toZone: ZoneType.WAITING_ROOM,
      cause,
    });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(result.gameState, [T.ON_ENTER_WAITING_ROOM], {
      enterWaitingRoomEvents: [result.enterWaitingRoomEvent],
    });
    expect(result.gameState.eventLog).toHaveLength(1);
  });
  it('rejects duplicate, unknown, non-below and wrong-host selections atomically; zero movement emits no event', () => {
    const game = setup();
    const enqueue = vi.fn((state: GameState) => state);
    for (const selectedCardIds of [
      ['member', 'member'],
      ['member', 'missing'],
      ['member', 'other'],
    ]) {
      expect(
        moveBelow(game, { playerId: 'p1', sourceCardId: 'host', selectedCardIds, cause }, enqueue)
      ).toBeNull();
    }
    expect(
      moveBelow(
        game,
        { playerId: 'p2', sourceCardId: 'host', selectedCardIds: ['member'], cause },
        enqueue
      )
    ).toBeNull();
    expect(
      moveBelow(game, { playerId: 'p1', sourceCardId: 'host', selectedCardIds: [], cause }, enqueue)
    ).toEqual({ gameState: game, movedCardIds: [], enterWaitingRoomEvent: null });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
