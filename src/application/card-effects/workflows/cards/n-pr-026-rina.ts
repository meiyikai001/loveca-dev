import {
  addAction,
  getCardById,
  getPlayerById,
  type GameState,
  type PendingAbilityState,
} from '../../../../domain/entities/game.js';
import { CardType, SlotPosition, TriggerCondition } from '../../../../shared/types/enums.js';
import {
  CardAbilityCategory,
  CardAbilitySourceZone,
  type CardAbilityDefinition,
} from '../../ability-definition-types.js';
import { N_PR_026_LIVE_SUCCESS_DELEGATE_MEMBER_BELOW_LIVE_SUCCESS_ABILITIES_ABILITY_ID } from '../../ability-ids.js';
import { getDelegatableQueuedAbilityDefinitions } from '../../runtime/delegatable-definitions.js';
import { getSourceMemberSlot } from '../../runtime/source-member.js';
import { registerPendingAbilityStarterHandler } from '../../runtime/starter-registry.js';
import { maybeStartConfirmablePendingAbilityConfirmation } from '../../runtime/workflow-helpers.js';
import { and, costLte, groupAliasIs, typeIs } from '../../../effects/card-selectors.js';
import { getCardIdsMatchingSelector } from '../../../effects/conditions.js';

type ContinuePendingCardEffects = (game: GameState, orderedResolution: boolean) => GameState;

export function registerNPr026RinaWorkflowHandlers(): void {
  registerPendingAbilityStarterHandler(
    N_PR_026_LIVE_SUCCESS_DELEGATE_MEMBER_BELOW_LIVE_SUCCESS_ABILITIES_ABILITY_ID,
    (game, ability, options, context) => {
      const confirmation = maybeStartConfirmablePendingAbilityConfirmation(game, ability, options);
      if (confirmation) {
        return confirmation;
      }
      return resolveRinaLiveSuccessDelegation(
        game,
        ability,
        options.orderedResolution === true,
        context.continuePendingCardEffects
      );
    }
  );
}

function resolveRinaLiveSuccessDelegation(
  game: GameState,
  ability: PendingAbilityState,
  orderedResolution: boolean,
  continuePendingCardEffects: ContinuePendingCardEffects
): GameState {
  const player = getPlayerById(game, ability.controllerId);
  const sourceSlot = player ? getSourceMemberSlot(game, player.id, ability.sourceCardId) : null;
  if (!player || sourceSlot === null) {
    return skipPendingAbility(
      game,
      ability,
      ability.controllerId,
      orderedResolution,
      'SOURCE_NOT_ON_STAGE',
      continuePendingCardEffects
    );
  }

  const syntheticAbilities = createRinaGrantedLiveSuccessPendingAbilities(
    game,
    ability,
    player.id,
    sourceSlot
  );
  const state = {
    ...game,
    pendingAbilities: [
      ...game.pendingAbilities.filter((candidate) => candidate.id !== ability.id),
      ...syntheticAbilities,
    ],
  };
  return continuePendingCardEffects(
    addAction(state, 'RESOLVE_ABILITY', player.id, {
      pendingAbilityId: ability.id,
      abilityId: ability.abilityId,
      sourceCardId: ability.sourceCardId,
      sourceSlot,
      step:
        syntheticAbilities.length > 0
          ? 'DELEGATE_MEMBER_BELOW_LIVE_SUCCESS_ABILITIES'
          : 'NO_DELEGATABLE_MEMBER_BELOW_LIVE_SUCCESS_ABILITIES',
      syntheticPendingAbilityIds: syntheticAbilities.map((pending) => pending.id),
      delegatedAbilityIds: syntheticAbilities.map((pending) => pending.abilityId),
    }),
    orderedResolution
  );
}

function createRinaGrantedLiveSuccessPendingAbilities(
  game: GameState,
  ability: PendingAbilityState,
  playerId: string,
  rinaSlot: SlotPosition
): readonly PendingAbilityState[] {
  const memberBelowCardIds = getLowCostNijigasakiMemberIdsBelowRina(game, playerId, rinaSlot);
  const liveSuccessEventKey = ability.eventIds.join('|') || `live-success:${ability.id}`;
  const pendingAbilities: PendingAbilityState[] = [];
  for (const memberBelowCardId of memberBelowCardIds) {
    const card = getCardById(game, memberBelowCardId);
    if (!card) {
      continue;
    }
    const definitions = getRinaDelegatableLiveSuccessDefinitions(card.data.cardCode, rinaSlot);
    for (const definition of definitions) {
      pendingAbilities.push({
        id: `rina:${ability.sourceCardId}:${memberBelowCardId}:${definition.abilityId}:${liveSuccessEventKey}`,
        abilityId: definition.abilityId,
        sourceCardId: ability.sourceCardId,
        controllerId: playerId,
        mandatory: false,
        timingId: TriggerCondition.ON_LIVE_SUCCESS,
        eventIds: ability.eventIds,
        sourceSlot: rinaSlot,
        metadata: {
          grantedByAbilityId: ability.abilityId,
          grantedFromMemberBelowCardId: memberBelowCardId,
          grantedFromCardCode: card.data.cardCode,
        },
      });
    }
  }
  return pendingAbilities;
}

function getRinaDelegatableLiveSuccessDefinitions(
  cardCode: string,
  rinaSlot: SlotPosition
): readonly CardAbilityDefinition[] {
  return getDelegatableQueuedAbilityDefinitions({
    cardCode,
    category: CardAbilityCategory.LIVE_SUCCESS,
    sourceZone: CardAbilitySourceZone.STAGE_MEMBER,
    triggerCondition: TriggerCondition.ON_LIVE_SUCCESS,
    sourceSlot: rinaSlot,
  }).filter(
    (definition) =>
      definition.abilityId !==
      N_PR_026_LIVE_SUCCESS_DELEGATE_MEMBER_BELOW_LIVE_SUCCESS_ABILITIES_ABILITY_ID
  );
}

function getLowCostNijigasakiMemberIdsBelowRina(
  game: GameState,
  playerId: string,
  sourceSlot: SlotPosition
): readonly string[] {
  const player = getPlayerById(game, playerId);
  return getCardIdsMatchingSelector(
    game,
    player?.memberSlots.memberBelow[sourceSlot] ?? [],
    and(typeIs(CardType.MEMBER), costLte(9), groupAliasIs('虹ヶ咲'))
  );
}

function skipPendingAbility(
  game: GameState,
  ability: PendingAbilityState,
  playerId: string,
  orderedResolution: boolean,
  step: string,
  continuePendingCardEffects: ContinuePendingCardEffects
): GameState {
  const state = {
    ...game,
    pendingAbilities: game.pendingAbilities.filter((candidate) => candidate.id !== ability.id),
  };
  return continuePendingCardEffects(
    addAction(state, 'RESOLVE_ABILITY', playerId, {
      pendingAbilityId: ability.id,
      abilityId: ability.abilityId,
      sourceCardId: ability.sourceCardId,
      step,
      sourceSlot: ability.sourceSlot,
    }),
    orderedResolution
  );
}
