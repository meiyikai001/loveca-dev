import type { CardInstance } from '../entities/card.js';
import { getCardById, type GameState } from '../entities/game.js';
import type { MemberStateChangedEvent } from '../events/game-events.js';

/** Matches the controller and source identity of the effect, not the choosing player. */
export function isMemberStateChangeByOwnCardEffect(
  game: GameState,
  event: MemberStateChangedEvent,
  playerId: string,
  sourceSelector?: (card: CardInstance) => boolean
): boolean {
  const cause = event.cause;
  if (cause?.kind !== 'CARD_EFFECT' || cause.playerId !== playerId) return false;
  if (!sourceSelector) return true;
  const source = getCardById(game, cause.sourceCardId);
  return source !== null && sourceSelector(source);
}
