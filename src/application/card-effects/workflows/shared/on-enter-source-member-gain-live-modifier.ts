import {
  getPlayerById,
  type GameState,
  type PendingAbilityState,
} from '../../../../domain/entities/game.js';
import { getAllMemberCardIds } from '../../../../domain/entities/zone.js';
import { addHeartLiveModifierForMember } from '../../../../domain/rules/live-modifiers.js';
import { HeartColor } from '../../../../shared/types/enums.js';
import {
  HS_CL1_006_ON_ENTER_GAIN_THREE_BLADE_ABILITY_ID,
  N_SD2_019_ON_ENTER_GAIN_BLUE_HEART_ABILITY_ID,
  S_BP6_013_ON_ENTER_GAIN_TWO_BLADE_ABILITY_ID,
  S_PR_016_ON_ENTER_GAIN_ONE_BLADE_ABILITY_ID,
} from '../../ability-ids.js';
import { addBladeLiveModifierForSourceMember } from '../../runtime/actions.js';
import {
  beginPendingAbilityResolution,
  finishPendingAbilityResolution,
} from '../../runtime/pending-ability-resolution.js';
import { registerPendingAbilityStarterHandler } from '../../runtime/starter-registry.js';
import { registerManualConfirmablePendingAbilityStarterHandler } from '../../runtime/workflow-helpers.js';

type ContinuePendingCardEffects = (game: GameState, orderedResolution: boolean) => GameState;

type OnEnterSourceMemberLiveModifierConfig =
  | {
      readonly abilityId: string;
      readonly kind: 'BLADE';
      readonly amount: number;
      readonly actionStep: string;
      readonly manualConfirmable?: boolean;
    }
  | {
      readonly abilityId: string;
      readonly kind: 'HEART';
      readonly color: HeartColor;
      readonly amount: number;
      readonly actionStep: string;
      readonly manualConfirmable?: boolean;
    };

const ON_ENTER_SOURCE_MEMBER_LIVE_MODIFIER_CONFIGS: readonly OnEnterSourceMemberLiveModifierConfig[] =
  [
    {
      abilityId: S_PR_016_ON_ENTER_GAIN_ONE_BLADE_ABILITY_ID,
      kind: 'BLADE',
      amount: 1,
      actionStep: 'ON_ENTER_SOURCE_MEMBER_GAIN_ONE_BLADE',
    },
    {
      abilityId: S_BP6_013_ON_ENTER_GAIN_TWO_BLADE_ABILITY_ID,
      kind: 'BLADE',
      amount: 2,
      actionStep: 'ON_ENTER_SOURCE_MEMBER_GAIN_TWO_BLADE',
    },
    {
      abilityId: HS_CL1_006_ON_ENTER_GAIN_THREE_BLADE_ABILITY_ID,
      kind: 'BLADE',
      amount: 3,
      actionStep: 'ON_ENTER_SOURCE_MEMBER_GAIN_THREE_BLADE',
    },
    {
      abilityId: N_SD2_019_ON_ENTER_GAIN_BLUE_HEART_ABILITY_ID,
      kind: 'HEART',
      color: HeartColor.BLUE,
      amount: 1,
      actionStep: 'ON_ENTER_SOURCE_MEMBER_GAIN_BLUE_HEART',
      manualConfirmable: true,
    },
  ];

export function registerOnEnterSourceMemberGainLiveModifierWorkflowHandlers(): void {
  for (const config of ON_ENTER_SOURCE_MEMBER_LIVE_MODIFIER_CONFIGS) {
    const resolver: Parameters<typeof registerPendingAbilityStarterHandler>[1] = (
      game,
      ability,
      options,
      context
    ) =>
      resolveOnEnterSourceMemberLiveModifier(
        game,
        ability,
        config,
        options.orderedResolution === true,
        context.continuePendingCardEffects
      );
    if (config.manualConfirmable === true) {
      registerManualConfirmablePendingAbilityStarterHandler(config.abilityId, resolver);
    } else {
      registerPendingAbilityStarterHandler(config.abilityId, resolver);
    }
  }
}

function resolveOnEnterSourceMemberLiveModifier(
  game: GameState,
  ability: PendingAbilityState,
  config: OnEnterSourceMemberLiveModifierConfig,
  orderedResolution: boolean,
  continuePendingCardEffects: ContinuePendingCardEffects
): GameState {
  const pendingResolution = beginPendingAbilityResolution(game, ability, {
    orderedResolution,
  });
  if (pendingResolution.status !== 'BEGUN') {
    return pendingResolution.gameState;
  }

  const player = getPlayerById(pendingResolution.gameState, ability.controllerId);
  if (!player) {
    return finishPendingAbilityResolution(
      pendingResolution.gameState,
      pendingResolution.receipt,
      {
        outcome: 'STALE',
        step: 'CONTROLLER_UNAVAILABLE',
        actionPayload: {
          sourceOnStage: false,
          modifierKind: config.kind,
          modifierAmount: 0,
        },
      },
      continuePendingCardEffects
    ).gameState;
  }

  const sourceOnStage = getAllMemberCardIds(player.memberSlots).includes(ability.sourceCardId);
  const modifierResult = !sourceOnStage
    ? null
    : config.kind === 'BLADE'
      ? addBladeLiveModifierForSourceMember(pendingResolution.gameState, {
          playerId: player.id,
          sourceCardId: ability.sourceCardId,
          abilityId: ability.abilityId,
          amount: config.amount,
        })
      : addHeartLiveModifierForMember(pendingResolution.gameState, {
          playerId: player.id,
          memberCardId: ability.sourceCardId,
          sourceCardId: ability.sourceCardId,
          abilityId: ability.abilityId,
          hearts: [{ color: config.color, count: config.amount }],
        });
  const modifierApplied = modifierResult !== null;

  return finishPendingAbilityResolution(
    modifierResult?.gameState ?? pendingResolution.gameState,
    pendingResolution.receipt,
    {
      outcome: modifierApplied ? 'SUCCESS' : 'NO_OP',
      step: modifierApplied ? config.actionStep : `SOURCE_MEMBER_GAIN_${config.kind}_NO_OP`,
      actionPayload: {
        sourceOnStage,
        modifierKind: config.kind,
        modifierAmount: modifierApplied ? config.amount : 0,
        expectedModifierAmount: config.amount,
        modifierApplied,
        ...(config.kind === 'BLADE'
          ? {
              bladeBonus:
                modifierResult && 'bladeBonus' in modifierResult ? modifierResult.bladeBonus : 0,
              expectedBladeBonus: config.amount,
              bladeApplied: modifierApplied,
            }
          : {
              heartColor: config.color,
              heartBonus: modifierApplied ? config.amount : 0,
              expectedHeartBonus: config.amount,
              heartApplied: modifierApplied,
            }),
      },
    },
    continuePendingCardEffects
  ).gameState;
}
