import type { GameState } from '../../domain/entities/game.js';
import { GamePhase } from '../../shared/types/enums.js';
import { getManualOperationMode } from '../manual-operation-mode.js';
import type { CardSelectionGroup } from '../effects/card-selection-groups.js';
import { GameCommandType } from '../game-commands.js';
import { isCandidateFrontVisible } from './ai-effect-step-actions.js';

export const MAX_AI_EFFECT_SELECTION_CARDS = 256;
export const MAX_AI_REJECTED_EFFECT_SELECTIONS = 32;

/** 只在受信任执行侧保留实体 ID；不是已经验证全部组合条件的合法动作表。 */
export interface RulesEffectCardSelection {
  readonly binding: {
    readonly type: GameCommandType.CONFIRM_EFFECT_STEP;
    readonly playerId: string;
    readonly effectId: string;
  };
  readonly cardIds: readonly string[];
  readonly minSelections: number;
  readonly maxSelections: number;
  readonly canSkip: boolean;
  readonly groups?: readonly CardSelectionGroup[];
  readonly distinctGroupAssignment: boolean;
}

export type EffectCardSelectionBinding = RulesEffectCardSelection['binding'] &
  (
    | { readonly selectedCardIds: readonly string[]; readonly selectedCardId?: never }
    | { readonly selectedCardId: null; readonly selectedCardIds?: never }
  );

/** 复用当前真实效果窗口，不预执行 resolver，也不检索未公开牌库。 */
export function buildRulesEffectCardSelection(
  game: GameState,
  playerId: string
): RulesEffectCardSelection | null {
  const effect = game.activeEffect;
  if (
    !effect ||
    game.isEnded ||
    getManualOperationMode(game) !== 'RULES' ||
    ![
      GamePhase.MAIN_PHASE,
      GamePhase.LIVE_SET_PHASE,
      GamePhase.PERFORMANCE_PHASE,
      GamePhase.LIVE_RESULT_PHASE,
    ].includes(game.currentPhase) ||
    game.pendingChoice ||
    game.pendingCostPayment ||
    game.pendingSpecialMemberPlay ||
    effect.awaitingPlayerId !== playerId ||
    effect.selectableCardMode !== 'ORDERED_MULTI' ||
    effect.selectableCardVisibility === 'AWAITING_PLAYER_BLIND' ||
    effect.numericInput !== undefined ||
    effect.stageFormation !== undefined ||
    effect.selectableSlots !== undefined ||
    effect.selectableOptions !== undefined ||
    effect.effectChoice !== undefined ||
    effect.publicCardSelectionAutoAdvanceAt !== undefined ||
    effect.publicEffectChoiceAutoAdvanceAt !== undefined ||
    effect.publicRevealAutoAdvanceAt !== undefined ||
    effect.publicRevealGeneration !== undefined
  )
    return null;

  const cardIds = effect.selectableCardIds ?? [];
  const minSelections = effect.minSelectableCards ?? 0;
  const maxSelections = effect.maxSelectableCards ?? cardIds.length;
  if (
    cardIds.length > MAX_AI_EFFECT_SELECTION_CARDS ||
    new Set(cardIds).size !== cardIds.length ||
    !isCount(minSelections) ||
    !isCount(maxSelections) ||
    minSelections > maxSelections ||
    cardIds.some((cardId) => !isCandidateFrontVisible(game, playerId, cardId))
  )
    return null;

  const rawConfig = effect.metadata?.publicCardSelectionConfirmation;
  let groups: readonly CardSelectionGroup[] | undefined;
  let distinctGroupAssignment = false;
  if (rawConfig !== undefined) {
    if (!isRecord(rawConfig)) return null;
    if (
      rawConfig.distinctGroupAssignment !== undefined &&
      typeof rawConfig.distinctGroupAssignment !== 'boolean'
    )
      return null;
    distinctGroupAssignment = rawConfig.distinctGroupAssignment === true;
    if (rawConfig.groups !== undefined) {
      if (
        !Array.isArray(rawConfig.groups) ||
        rawConfig.groups.length > MAX_AI_EFFECT_SELECTION_CARDS
      )
        return null;
      const parsed: CardSelectionGroup[] = [];
      for (const rawGroup of rawConfig.groups) {
        if (
          !isRecord(rawGroup) ||
          !Array.isArray(rawGroup.candidateCardIds) ||
          !isCount(rawGroup.minCount) ||
          !isCount(rawGroup.maxCount) ||
          rawGroup.minCount > rawGroup.maxCount ||
          rawGroup.candidateCardIds.length > MAX_AI_EFFECT_SELECTION_CARDS ||
          new Set(rawGroup.candidateCardIds).size !== rawGroup.candidateCardIds.length ||
          !rawGroup.candidateCardIds.every(
            (id): id is string => typeof id === 'string' && cardIds.includes(id)
          )
        )
          return null;
        parsed.push({
          candidateCardIds: [...rawGroup.candidateCardIds],
          minCount: rawGroup.minCount,
          maxCount: rawGroup.maxCount,
        });
      }
      groups = parsed;
    }
  }
  // 已有无分组精确选一保持单 token EFFECT_STEP；不是第二套多选实现。
  if (minSelections === 1 && maxSelections === 1 && groups === undefined) return null;
  return {
    binding: { type: GameCommandType.CONFIRM_EFFECT_STEP, playerId, effectId: effect.id },
    cardIds: [...cardIds],
    minSelections,
    maxSelections,
    canSkip: effect.canSkipSelection === true,
    ...(groups !== undefined ? { groups } : {}),
    distinctGroupAssignment,
  };
}

function isCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_AI_EFFECT_SELECTION_CARDS
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
