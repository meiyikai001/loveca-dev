import { isMemberCardData } from '../../../../domain/entities/card.js';
import {
  getCardById,
  getPlayerById,
  type GameState,
  type PendingAbilityState,
} from '../../../../domain/entities/game.js';
import { findMemberSlot } from '../../../../domain/entities/player.js';
import type { LeaveStageEvent } from '../../../../domain/events/game-events.js';
import { TriggerCondition, ZoneType } from '../../../../shared/types/enums.js';
import { PR_AUTO_RELAY_REPLACEMENT_COST_NINE_GAIN_TWO_BLADE_ABILITY_ID } from '../../ability-ids.js';
import { addBladeLiveModifierForMember } from '../../runtime/actions.js';
import {
  beginPendingAbilityResolution,
  finishPendingAbilityResolution,
} from '../../runtime/pending-ability-resolution.js';
import {
  getAbilityEffectText,
  registerManualConfirmablePendingAbilityStarterHandler,
} from '../../runtime/workflow-helpers.js';

type ContinuePendingCardEffects = (game: GameState, orderedResolution: boolean) => GameState;

interface RelayReplacementContext {
  readonly leaveStageEventId: string | null;
  readonly replacingCardId: string | null;
  readonly replacingCardName: string | null;
  readonly replacingCardPrintedCost: number | null;
  readonly replacementIsOwnCurrentStageTop: boolean;
  readonly eventMatches: boolean;
  readonly conditionMet: boolean;
}

export function registerRelayReplacementGainBladeWorkflowHandlers(): void {
  registerManualConfirmablePendingAbilityStarterHandler(
    PR_AUTO_RELAY_REPLACEMENT_COST_NINE_GAIN_TWO_BLADE_ABILITY_ID,
    (game, ability, options, context) =>
      resolveRelayReplacementGainBlade(
        game,
        ability,
        options.orderedResolution === true,
        context.continuePendingCardEffects
      ),
    (game, ability) => getConfirmationConfig(game, ability)
  );
}

function getConfirmationConfig(
  game: GameState,
  ability: PendingAbilityState
): { readonly effectText: string; readonly stepText: string } {
  const context = getRelayReplacementContext(game, ability);
  const replacementDescription =
    context.replacingCardName && context.replacingCardPrintedCost !== null
      ? `换手登场成员为「${context.replacingCardName}」（费用${context.replacingCardPrintedCost}）`
      : '没有可确认的换手登场成员';
  const result = context.conditionMet
    ? '条件满足，实际获得[ブレード][ブレード]'
    : '条件未满足，实际不获得[ブレード]';
  return {
    effectText: `${getAbilityEffectText(ability.abilityId)}（${replacementDescription}；${result}。）`,
    stepText: context.conditionMet
      ? '换手登场成员仍在自己的舞台且印刷费用大于等于9，确认后获得[ブレード][ブレード]。'
      : '当前不满足换手登场成员的条件，确认后不获得[ブレード]。',
  };
}

function resolveRelayReplacementGainBlade(
  game: GameState,
  ability: PendingAbilityState,
  orderedResolution: boolean,
  continuePendingCardEffects: ContinuePendingCardEffects
): GameState {
  const context = getRelayReplacementContext(game, ability);
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
          ...context,
          bladeBonus: 0,
          targetMemberCardId: null,
        },
      },
      continuePendingCardEffects
    ).gameState;
  }

  const bladeResult =
    context.conditionMet && context.replacingCardId
      ? addBladeLiveModifierForMember(pendingResolution.gameState, {
          playerId: player.id,
          memberCardId: context.replacingCardId,
          sourceCardId: ability.sourceCardId,
          abilityId: ability.abilityId,
          countDelta: 2,
        })
      : null;
  const resolvedState = bladeResult?.gameState ?? pendingResolution.gameState;

  return finishPendingAbilityResolution(
    resolvedState,
    pendingResolution.receipt,
    {
      outcome: bladeResult ? 'SUCCESS' : 'NO_OP',
      step: bladeResult ? 'RELAY_REPLACEMENT_GAIN_TWO_BLADE' : 'RELAY_REPLACEMENT_NOT_AVAILABLE',
      actionPayload: {
        ...context,
        bladeBonus: bladeResult?.bladeBonus ?? 0,
        targetMemberCardId: bladeResult ? context.replacingCardId : null,
      },
    },
    continuePendingCardEffects
  ).gameState;
}

function getRelayReplacementContext(
  game: GameState,
  ability: PendingAbilityState
): RelayReplacementContext {
  const player = getPlayerById(game, ability.controllerId);
  const event = getExactLeaveStageEvent(game, ability);
  const replacingCardId = event?.replacingCardId ?? null;
  const replacement = replacingCardId ? getCardById(game, replacingCardId) : null;
  const replacementSlot =
    player && replacingCardId ? findMemberSlot(player, replacingCardId) : null;
  const eventMatches =
    event?.cardInstanceId === ability.sourceCardId &&
    event.controllerId === ability.controllerId &&
    event.toZone === ZoneType.WAITING_ROOM;
  const replacementIsOwnCurrentStageTop =
    player !== null &&
    replacement !== null &&
    replacement.ownerId === player.id &&
    replacementSlot !== null &&
    player.memberSlots.slots[replacementSlot] === replacingCardId;
  const printedCost =
    replacement && isMemberCardData(replacement.data) ? replacement.data.cost : null;

  return {
    leaveStageEventId: event?.eventId ?? null,
    replacingCardId,
    replacingCardName:
      replacement && isMemberCardData(replacement.data) ? replacement.data.name : null,
    replacingCardPrintedCost: printedCost,
    replacementIsOwnCurrentStageTop,
    eventMatches,
    conditionMet:
      eventMatches && replacementIsOwnCurrentStageTop && printedCost !== null && printedCost >= 9,
  };
}

function getExactLeaveStageEvent(
  game: GameState,
  ability: PendingAbilityState
): LeaveStageEvent | null {
  for (const eventId of ability.eventIds) {
    const event = game.eventLog.find((entry) => entry.event.eventId === eventId)?.event;
    if (event?.eventType === TriggerCondition.ON_LEAVE_STAGE && 'fromSlot' in event) {
      return event as LeaveStageEvent;
    }
  }
  return null;
}
