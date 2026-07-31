import {
  getPlayerById,
  type GameState,
  type PendingAbilityState,
} from '../../../../domain/entities/game.js';
import { OrientationState } from '../../../../shared/types/enums.js';
import { placeEnergyFromDeckToZoneByCardEffect } from '../../../effects/energy.js';
import {
  N_BP7_001_AUTO_TURN_ONCE_ENERGY_PLACED_BELOW_PLACE_WAITING_ENERGY_ABILITY_ID,
  PL_N_PB1_012_AUTO_TURN_ONCE_OTHER_COST_ELEVEN_MEMBER_ENTER_PLACE_WAITING_ENERGY_ABILITY_ID,
  SP_PB1_005_ON_ENTER_PLACE_WAITING_ENERGY_ABILITY_ID,
} from '../../ability-ids.js';
import {
  beginPendingAbilityResolution,
  finishPendingAbilityResolution,
} from '../../runtime/pending-ability-resolution.js';
import {
  registerPendingAbilityStarterHandler,
  type PendingAbilityStarterOptions,
} from '../../runtime/starter-registry.js';
import {
  maybeStartManualPendingAbilityConfirmation,
  recordAbilityUseForContext,
} from '../../runtime/workflow-helpers.js';

type ContinuePendingCardEffects = (game: GameState, orderedResolution: boolean) => GameState;

interface PlaceWaitingEnergyConfig {
  readonly abilityId: string;
  readonly actionStep: string;
  readonly recordAbilityUse: boolean;
}

const PLACE_WAITING_ENERGY_CONFIGS: readonly PlaceWaitingEnergyConfig[] = [
  {
    abilityId: N_BP7_001_AUTO_TURN_ONCE_ENERGY_PLACED_BELOW_PLACE_WAITING_ENERGY_ABILITY_ID,
    actionStep: 'PLACE_WAITING_ENERGY_AFTER_ENERGY_PLACED_BELOW_MEMBER',
    recordAbilityUse: true,
  },
  {
    abilityId: SP_PB1_005_ON_ENTER_PLACE_WAITING_ENERGY_ABILITY_ID,
    actionStep: 'PLACE_WAITING_ENERGY',
    recordAbilityUse: false,
  },
  {
    abilityId:
      PL_N_PB1_012_AUTO_TURN_ONCE_OTHER_COST_ELEVEN_MEMBER_ENTER_PLACE_WAITING_ENERGY_ABILITY_ID,
    actionStep: 'PLACE_WAITING_ENERGY_AFTER_OTHER_COST_ELEVEN_MEMBER_ENTER',
    recordAbilityUse: true,
  },
];

export function registerPlaceWaitingEnergyWorkflowHandlers(): void {
  for (const config of PLACE_WAITING_ENERGY_CONFIGS) {
    registerPendingAbilityStarterHandler(config.abilityId, (game, ability, options, context) =>
      resolvePlaceWaitingEnergy(game, ability, config, options, context.continuePendingCardEffects)
    );
  }
}

function resolvePlaceWaitingEnergy(
  game: GameState,
  ability: PendingAbilityState,
  config: PlaceWaitingEnergyConfig,
  options: PendingAbilityStarterOptions,
  continuePendingCardEffects: ContinuePendingCardEffects
): GameState {
  const player = getPlayerById(game, ability.controllerId);
  if (!player) {
    const pendingResolution = beginPendingAbilityResolution(game, ability, {
      orderedResolution: options.orderedResolution === true,
    });
    if (pendingResolution.status !== 'BEGUN') {
      return pendingResolution.gameState;
    }
    return finishPendingAbilityResolution(
      pendingResolution.gameState,
      pendingResolution.receipt,
      {
        outcome: 'STALE',
        step: 'CONTROLLER_UNAVAILABLE',
        actionPayload: {
          placedEnergyCardIds: [],
        },
      },
      continuePendingCardEffects
    ).gameState;
  }

  const manualConfirmation = maybeStartManualPendingAbilityConfirmation(game, ability, options, {
    stepText: '确认后结算此效果。',
  });
  if (manualConfirmation) {
    return manualConfirmation;
  }

  const placement = placeEnergyFromDeckToZoneByCardEffect(
    game,
    player.id,
    1,
    OrientationState.WAITING,
    {
      kind: 'CARD_EFFECT',
      playerId: player.id,
      sourceCardId: ability.sourceCardId,
      abilityId: ability.abilityId,
      pendingAbilityId: ability.id,
    }
  );
  const stateAfterPlacement = placement?.gameState ?? game;
  const pendingResolution = beginPendingAbilityResolution(stateAfterPlacement, ability, {
    orderedResolution: options.orderedResolution === true,
  });
  if (pendingResolution.status !== 'BEGUN') {
    // Placement is an immutable draft at this point; without authority to
    // consume the expected pending instance, discard both it and its event.
    return game;
  }

  let state = pendingResolution.gameState;
  if (config.recordAbilityUse) {
    state = recordAbilityUseForContext(state, player.id, {
      abilityId: pendingResolution.receipt.abilityId,
      sourceCardId: pendingResolution.receipt.sourceCardId,
      pendingAbilityId: pendingResolution.receipt.pendingAbilityId,
      sourceLifecycleId: pendingResolution.receipt.sourceLifecycleId,
    });
  }

  return finishPendingAbilityResolution(
    state,
    pendingResolution.receipt,
    {
      outcome: placement && placement.placedEnergyCardIds.length > 0 ? 'SUCCESS' : 'NO_OP',
      step: config.actionStep,
      actionPayload: {
        placedEnergyCardIds: placement?.placedEnergyCardIds ?? [],
      },
    },
    continuePendingCardEffects
  ).gameState;
}
