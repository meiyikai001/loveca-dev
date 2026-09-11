import { type BladeHeartItem } from '../entities/card.js';
import { getCardById, getPlayerById, type GameState } from '../entities/game.js';
import { BladeHeartEffect } from '../../shared/types/enums.js';
import { cardBelongsToGroup, cardBelongsToUnit } from '../../shared/utils/card-identity.js';
import { cardCodeMatchesBase } from '../../shared/utils/card-code.js';

/**
 * Counts this controller's success-zone cards for one card effect. The optional
 * matching IDs restrict the current zone; they never represent extra copies.
 * PL!-pb2-041 changes only its own contribution to an own lily white effect.
 * Physical zone sizes, selections and successful LIVE score queries stay separate.
 */
export function countSuccessZoneCardsForCardEffect(
  game: GameState,
  controllerId: string,
  sourceCardId: string,
  matchingCardIds?: readonly string[]
): number {
  const player = getPlayerById(game, controllerId);
  if (!player) return 0;
  const source = getCardById(game, sourceCardId);
  // The effect controller is supplied by its pending/active effect. A paid source
  // can already have left the stage without changing the identity of its effect.
  const isLilyWhiteEffect = source !== null && cardBelongsToUnit(source.data, 'lily white');
  const matching = matchingCardIds === undefined ? null : new Set(matchingCardIds);
  return [...new Set(player.successZone.cardIds)].reduce((count, cardId) => {
    if (matching && !matching.has(cardId)) return count;
    const card = getCardById(game, cardId);
    if (!card || card.ownerId !== controllerId) return count;
    const contribution =
      isLilyWhiteEffect && cardCodeMatchesBase(card.data.cardCode, 'PL!-pb2-041') ? 2 : 1;
    return count + contribution;
  }, 0);
}

/**
 * Returns cards in this player's success zone that they still own, belong to the
 * requested group, and have a printed SCORE blade-heart icon.
 */
export function getOwnedSuccessfulGroupScoreCardIds(
  game: GameState,
  playerId: string,
  groupAlias: string
): readonly string[] {
  const player = getPlayerById(game, playerId);
  if (!player) {
    return [];
  }

  return player.successZone.cardIds.filter((cardId) => {
    const card = getCardById(game, cardId);
    return (
      card !== null &&
      card.ownerId === player.id &&
      cardBelongsToGroup(card.data, groupAlias) &&
      (card.data as { readonly bladeHearts?: readonly BladeHeartItem[] }).bladeHearts?.some(
        (bladeHeart) => bladeHeart.effect === BladeHeartEffect.SCORE
      ) === true
    );
  });
}
