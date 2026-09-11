import {
  addAction,
  getPlayerById,
  type GameState,
  type LiveModifierState,
  type PendingAbilityState,
} from '../../../../domain/entities/game.js';
import { addLiveModifier } from '../../../../domain/rules/live-modifiers.js';
import {
  countSuccessZoneCardsForCardEffect,
  getOwnedSuccessfulGroupScoreCardIds,
} from '../../../../domain/rules/success-zone-card-queries.js';
import { PL_PB1_004_ON_ENTER_CENTER_SUCCESS_MUSE_SCORE_ABILITY_ID } from '../../ability-ids.js';
import { registerPendingAbilityStarterHandler } from '../../runtime/starter-registry.js';

type ContinuePendingCardEffects = (game: GameState, orderedResolution: boolean) => GameState;

export function registerPlPb1004UmiWorkflowHandlers(): void {
  registerPendingAbilityStarterHandler(
    PL_PB1_004_ON_ENTER_CENTER_SUCCESS_MUSE_SCORE_ABILITY_ID,
    (game, ability, options, context) =>
      resolveUmiOnEnter(
        game,
        ability,
        options.orderedResolution === true,
        context.continuePendingCardEffects
      )
  );
}

function resolveUmiOnEnter(
  game: GameState,
  ability: PendingAbilityState,
  orderedResolution: boolean,
  continuePendingCardEffects: ContinuePendingCardEffects
): GameState {
  const player = getPlayerById(game, ability.controllerId);
  if (!player) return game;

  let state: GameState = {
    ...game,
    pendingAbilities: game.pendingAbilities.filter((candidate) => candidate.id !== ability.id),
  };
  const matchingSuccessLiveCount = countSuccessZoneCardsForCardEffect(
    state,
    player.id,
    ability.sourceCardId,
    getOwnedSuccessfulGroupScoreCardIds(state, player.id, "μ's")
  );
  const scoreBonus = matchingSuccessLiveCount >= 2 ? 2 : matchingSuccessLiveCount === 1 ? 1 : 0;

  if (scoreBonus > 0) {
    const modifier: Extract<LiveModifierState, { readonly kind: 'SCORE' }> = {
      kind: 'SCORE',
      playerId: player.id,
      countDelta: scoreBonus,
      sourceCardId: ability.sourceCardId,
      abilityId: ability.abilityId,
    };
    state = addLiveModifier(state, modifier);
    const playerScores = new Map(state.liveResolution.playerScores);
    playerScores.set(player.id, (playerScores.get(player.id) ?? 0) + scoreBonus);
    state = { ...state, liveResolution: { ...state.liveResolution, playerScores } };
  }

  return continuePendingCardEffects(
    addAction(state, 'RESOLVE_ABILITY', player.id, {
      pendingAbilityId: ability.id,
      abilityId: ability.abilityId,
      sourceCardId: ability.sourceCardId,
      step: 'SUCCESS_MUSE_SCORE_THIS_LIVE',
      matchingSuccessLiveCount,
      scoreBonus,
    }),
    orderedResolution
  );
}
