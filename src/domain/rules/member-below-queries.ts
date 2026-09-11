import { isMemberCardData, type CardInstance } from '../entities/card.js';
import { getCardById, getPlayerById, type GameState } from '../entities/game.js';
import { findMemberSlot } from '../entities/player.js';

/** All physical cards below a current own top-level member, including energy. */
export function getCardsBelowSourceMember(
  game: GameState,
  playerId: string,
  sourceCardId: string
): readonly string[] {
  const player = getPlayerById(game, playerId);
  const source = getCardById(game, sourceCardId);
  if (!player || source?.ownerId !== playerId || !isMemberCardData(source.data)) return [];
  const slot = findMemberSlot(player, sourceCardId);
  return slot === null
    ? []
    : [
        ...(player.memberSlots.memberBelow[slot] ?? []),
        ...(player.memberSlots.energyBelow[slot] ?? []),
      ];
}

/** Counts only owned MEMBER cards; an optional selector narrows their identities. */
export function countMemberCardsBelowSourceMember(
  game: GameState,
  playerId: string,
  sourceCardId: string,
  selector?: (card: CardInstance) => boolean
): number {
  return getCardsBelowSourceMember(game, playerId, sourceCardId).filter((cardId) => {
    const card = getCardById(game, cardId);
    return card?.ownerId === playerId && isMemberCardData(card.data) && (selector?.(card) ?? true);
  }).length;
}
