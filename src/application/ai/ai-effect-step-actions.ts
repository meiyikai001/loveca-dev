import type { GameState } from '../../domain/entities/game.js';
import { findCardZone } from '../../domain/entities/player.js';
import { getSeatForPlayer } from '../../online/projector.js';
import { getViewerSurfaceForCard } from '../../online/visibility.js';
import { SlotPosition, ZoneType } from '../../shared/types/enums.js';
import { CONFIRM_ONLY_PENDING_ABILITY_STEP_ID } from '../card-effects/runtime/active-effect.js';
import { PUBLIC_CARD_SELECTION_CONFIRMATION_STEP_ID } from '../card-effects/runtime/public-card-selection-confirmation.js';
import { PUBLIC_EFFECT_CHOICE_CONFIRMATION_STEP_ID } from '../card-effects/runtime/public-effect-choice-confirmation.js';
import { PUBLIC_REVEAL_DWELL_STEP_ID } from '../card-effects/runtime/public-reveal-dwell.js';
import { GameCommandType } from '../game-commands.js';

type EffectStepSelectionKey =
  | 'selectedCardId'
  | 'selectedCardIds'
  | 'selectedSlot'
  | 'selectedOptionId'
  | 'selectedEffectOptionIds'
  | 'resolveInOrder'
  | 'selectedNumber'
  | 'stageFormationMoveHistory'
  | 'stageFormationPlacements'
  | 'publicCardSelectionAutoAdvanceAt'
  | 'publicEffectChoiceAutoAdvanceAt'
  | 'publicRevealAutoAdvanceAt'
  | 'publicRevealGeneration';

type EffectStepBinding<Selection extends object = Record<never, never>> = {
  readonly type: GameCommandType.CONFIRM_EFFECT_STEP;
  readonly playerId: string;
  readonly effectId: string;
} & Selection & {
    readonly [Key in Exclude<EffectStepSelectionKey, keyof Selection>]?: never;
  };

/** 受信任服务端候选；binding 中的实例 ID 不得进入模型请求。 */
export type LegalRulesEffectStepAction =
  | { readonly kind: 'CONFIRM'; readonly binding: EffectStepBinding }
  | {
      readonly kind: 'SKIP';
      readonly binding: EffectStepBinding<{ readonly selectedCardId: null }>;
    }
  | {
      readonly kind: 'SELECT_CARD';
      readonly binding: EffectStepBinding<{ readonly selectedCardId: string }>;
    }
  | {
      readonly kind: 'SELECT_SINGLE_FROM_MULTI';
      readonly binding: EffectStepBinding<{ readonly selectedCardIds: readonly [string] }>;
    }
  | {
      readonly kind: 'SELECT_SLOT';
      readonly binding: EffectStepBinding<{ readonly selectedSlot: SlotPosition }>;
    }
  | {
      readonly kind: 'SELECT_OPTION';
      readonly binding: EffectStepBinding<{ readonly selectedOptionId: string }>;
    }
  | {
      readonly kind: 'SELECT_EFFECT_OPTION';
      readonly binding: EffectStepBinding<{ readonly selectedEffectOptionIds: readonly [string] }>;
    };

/**
 * 只枚举现有候选表面，不运行 resolver、不读取牌库或推测后续结算。
 * 调用方仍须通过 GameSession 中央命令校验过滤并在执行时再次校验。
 */
export function buildRulesEffectStepActions(
  game: GameState,
  playerId: string
): readonly LegalRulesEffectStepAction[] {
  const effect = game.activeEffect;
  if (
    !effect ||
    effect.awaitingPlayerId !== playerId ||
    effect.numericInput !== undefined ||
    effect.stageFormation !== undefined ||
    effect.selectableCardVisibility === 'AWAITING_PLAYER_BLIND' ||
    effect.publicCardSelectionAutoAdvanceAt !== undefined ||
    effect.publicEffectChoiceAutoAdvanceAt !== undefined ||
    effect.publicRevealAutoAdvanceAt !== undefined ||
    effect.publicRevealGeneration !== undefined ||
    effect.stepId === PUBLIC_CARD_SELECTION_CONFIRMATION_STEP_ID ||
    effect.stepId === PUBLIC_EFFECT_CHOICE_CONFIRMATION_STEP_ID ||
    effect.stepId === PUBLIC_REVEAL_DWELL_STEP_ID
  ) {
    return [];
  }

  // 分组约束尚未进入玩家投影；即使动态数量退化为 1，也不能仅据 min/max 放行。
  const publicSelectionConfig = effect.metadata?.publicCardSelectionConfirmation;
  if (
    publicSelectionConfig &&
    typeof publicSelectionConfig === 'object' &&
    'groups' in publicSelectionConfig &&
    publicSelectionConfig.groups !== undefined
  ) {
    return [];
  }

  const hasCardInput =
    effect.selectableCardIds !== undefined ||
    effect.selectableCardMode !== undefined ||
    effect.minSelectableCards !== undefined ||
    effect.maxSelectableCards !== undefined;
  const hasSlotInput = effect.selectableSlots !== undefined;
  const hasOptionInput = effect.selectableOptions !== undefined;
  const hasEffectChoice = effect.effectChoice !== undefined;
  const inputCount = [hasCardInput, hasSlotInput, hasOptionInput, hasEffectChoice].filter(
    Boolean
  ).length;
  if (inputCount > 1) return [];

  const binding: EffectStepBinding = {
    type: GameCommandType.CONFIRM_EFFECT_STEP,
    playerId,
    effectId: effect.id,
  };
  if (inputCount === 0) {
    return effect.stepId === CONFIRM_ONLY_PENDING_ABILITY_STEP_ID &&
      effect.metadata?.confirmOnlyPendingAbility === true
      ? [{ kind: 'CONFIRM', binding }]
      : [];
  }

  const candidates: LegalRulesEffectStepAction[] = [];
  if (hasCardInput) {
    const isExactSingleMulti =
      effect.selectableCardMode === 'ORDERED_MULTI' &&
      effect.minSelectableCards === 1 &&
      effect.maxSelectableCards === 1;
    if (
      (effect.selectableCardMode === 'ORDERED_MULTI' && !isExactSingleMulti) ||
      (effect.selectableCardMode !== undefined &&
        effect.selectableCardMode !== 'SINGLE' &&
        effect.selectableCardMode !== 'ORDERED_MULTI') ||
      (effect.selectableCardMode !== 'ORDERED_MULTI' &&
        ((effect.minSelectableCards !== undefined &&
          effect.minSelectableCards !== 0 &&
          effect.minSelectableCards !== 1) ||
          (effect.maxSelectableCards !== undefined && effect.maxSelectableCards !== 1)))
    ) {
      return [];
    }
    const cardIds = effect.selectableCardIds ?? [];
    if (cardIds.some((cardId) => !isCandidateFrontVisible(game, playerId, cardId))) {
      return [];
    }
    for (const cardId of new Set(cardIds)) {
      candidates.push(
        isExactSingleMulti
          ? {
              kind: 'SELECT_SINGLE_FROM_MULTI',
              binding: { ...binding, selectedCardIds: [cardId] },
            }
          : { kind: 'SELECT_CARD', binding: { ...binding, selectedCardId: cardId } }
      );
    }
  } else if (hasSlotInput) {
    for (const slot of new Set(effect.selectableSlots)) {
      if (Object.values(SlotPosition).includes(slot)) {
        candidates.push({ kind: 'SELECT_SLOT', binding: { ...binding, selectedSlot: slot } });
      }
    }
  } else if (hasOptionInput) {
    for (const optionId of new Set(effect.selectableOptions?.map((option) => option.id))) {
      if (optionId.length > 0) {
        candidates.push({
          kind: 'SELECT_OPTION',
          binding: { ...binding, selectedOptionId: optionId },
        });
      }
    }
  } else if (effect.effectChoice) {
    const choice = effect.effectChoice;
    if (
      choice.mode !== 'SINGLE' ||
      choice.minSelections !== 1 ||
      choice.maxSelections !== 1 ||
      choice.publicConfirmation !== true ||
      choice.selectedOptionIds !== undefined ||
      new Set(choice.options.map((option) => option.id)).size !== choice.options.length
    ) {
      return [];
    }
    for (const option of choice.options) {
      if (option.selectable !== false && option.id.length > 0) {
        candidates.push({
          kind: 'SELECT_EFFECT_OPTION',
          binding: { ...binding, selectedEffectOptionIds: [option.id] },
        });
      }
    }
  }
  if (effect.canSkipSelection === true) {
    candidates.push({ kind: 'SKIP', binding: { ...binding, selectedCardId: null } });
  }
  return candidates;
}

/** 复用玩家投影的表面策略，只定位候选，不构造会访问整副牌库的桌面投影。 */
export function isCandidateFrontVisible(
  game: GameState,
  playerId: string,
  cardId: string
): boolean {
  const card = game.cardRegistry.get(cardId);
  const viewerSeat = getSeatForPlayer(game, playerId);
  if (!card || !viewerSeat) return false;
  const cardOwnerSeat = getSeatForPlayer(game, card.ownerId);
  if (!cardOwnerSeat) return false;
  if (game.activeEffect?.revealedCardIds?.includes(cardId)) return true;

  if (game.inspectionZone.cardIds.includes(cardId)) {
    const context = game.inspectionContext;
    if (context?.ownerPlayerId !== card.ownerId) return false;
    const inspectionViewerSeat = getSeatForPlayer(
      game,
      context.viewerPlayerId ?? context.ownerPlayerId
    );
    return (
      getViewerSurfaceForCard({
        zone: ZoneType.INSPECTION_ZONE,
        ownerSeat: inspectionViewerSeat ?? cardOwnerSeat,
        viewerSeat,
        isInspectionCardRevealed: game.inspectionZone.revealedCardIds.includes(cardId),
      }) === 'FRONT'
    );
  }
  if (game.resolutionZone.cardIds.includes(cardId)) {
    return (
      getViewerSurfaceForCard({
        zone: ZoneType.RESOLUTION_ZONE,
        ownerSeat: cardOwnerSeat,
        viewerSeat,
        isResolutionCardRevealed: game.resolutionZone.revealedCardIds.includes(cardId),
      }) === 'FRONT'
    );
  }
  for (const player of game.players) {
    const ownerSeat = getSeatForPlayer(game, player.id)!;
    const zone = findCardZone(player, cardId);
    if (zone !== null) {
      return (
        getViewerSurfaceForCard({
          zone,
          ownerSeat,
          viewerSeat,
          liveFaceState: player.liveZone.cardStates.get(cardId)?.face,
        }) === 'FRONT'
      );
    }
    if (
      Object.values(player.memberSlots.energyBelow).some((ids) => ids.includes(cardId)) ||
      Object.values(player.memberSlots.memberBelow).some((ids) => ids.includes(cardId))
    ) {
      return true;
    }
  }
  return false;
}
