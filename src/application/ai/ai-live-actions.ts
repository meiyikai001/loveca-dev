import {
  getLiveSetCardCountForPlayer,
  getLiveSetCardLimitForPlayer,
  getPlayerById,
  type GameState,
} from '../../domain/entities/game.js';
import {
  getCurrentSuccessLiveSettlementPlayerId,
  getSuccessLiveSelectionCandidateIds,
  haveAllSuccessLiveSettlementsCompleted,
} from '../../domain/rules/success-live-placement.js';
import { GamePhase, SubPhase } from '../../shared/types/enums.js';
import { GameCommandType } from '../game-commands.js';
import { getRulesModeConfirmStepBlockedReason } from '../player-command-policy.js';

type LiveActionInputKey =
  | 'cardId'
  | 'faceDown'
  | 'subPhase'
  | 'skipSuccessLiveSelection'
  | 'judgmentResults'
  | 'adjustedScore'
  | 'success';

type LiveActionBinding<
  Type extends GameCommandType,
  Input extends object = Record<never, never>,
> = {
  readonly type: Type;
  readonly playerId: string;
} & Input & { readonly [Key in Exclude<LiveActionInputKey, keyof Input>]?: never };

type ConfirmLiveBinding<Phase extends SubPhase> = LiveActionBinding<
  GameCommandType.CONFIRM_STEP,
  { readonly subPhase: Phase }
>;

/** 仅供受信任服务端保存的绑定；模型只选择当前窗口的动作 token。 */
export type LegalRulesLiveAction =
  | {
      readonly kind: 'SET_LIVE_CARD';
      readonly binding: LiveActionBinding<
        GameCommandType.SET_LIVE_CARD,
        { readonly cardId: string; readonly faceDown: true }
      >;
    }
  | {
      readonly kind: 'CONFIRM_LIVE_SET';
      readonly binding: ConfirmLiveBinding<
        SubPhase.LIVE_SET_FIRST_PLAYER | SubPhase.LIVE_SET_SECOND_PLAYER
      >;
    }
  | {
      readonly kind: 'CONTINUE_LIVE_START';
      readonly binding: ConfirmLiveBinding<SubPhase.PERFORMANCE_LIVE_START_EFFECTS>;
    }
  | {
      readonly kind: 'SUBMIT_JUDGMENT';
      readonly binding: LiveActionBinding<
        GameCommandType.SUBMIT_JUDGMENT,
        { readonly judgmentResults: ReadonlyMap<string, boolean> }
      >;
    }
  | {
      readonly kind: 'CONFIRM_JUDGMENT';
      readonly binding: ConfirmLiveBinding<SubPhase.PERFORMANCE_JUDGMENT>;
    }
  | {
      readonly kind: 'SUBMIT_SCORE';
      readonly binding: LiveActionBinding<GameCommandType.SUBMIT_SCORE>;
    }
  | {
      readonly kind: 'CONTINUE_SUCCESS_EFFECTS';
      readonly binding: ConfirmLiveBinding<
        SubPhase.RESULT_FIRST_SUCCESS_EFFECTS | SubPhase.RESULT_SECOND_SUCCESS_EFFECTS
      >;
    }
  | {
      readonly kind: 'CONFIRM_RESULT_ANIMATION';
      readonly binding: ConfirmLiveBinding<SubPhase.RESULT_ANIMATION>;
    }
  | {
      readonly kind: 'SELECT_SUCCESS_LIVE';
      readonly binding: LiveActionBinding<
        GameCommandType.SELECT_SUCCESS_LIVE,
        { readonly cardId: string }
      >;
    }
  | {
      readonly kind: 'SKIP_SUCCESS_LIVE';
      readonly binding: LiveActionBinding<
        GameCommandType.CONFIRM_STEP,
        { readonly subPhase: SubPhase.RESULT_SETTLEMENT; readonly skipSuccessLiveSelection: true }
      >;
    }
  | {
      readonly kind: 'CONFIRM_RESULT_SETTLEMENT';
      readonly binding: ConfirmLiveBinding<SubPhase.RESULT_SETTLEMENT>;
    };

/**
 * 只读枚举当前一步，不执行判定、声援、抽牌或任何 resolver。
 * 调用方必须以 GameSession 中央校验过滤 actor、pending 和可跳过结算权限。
 */
export function buildRulesLiveActions(
  game: GameState,
  playerId: string
): readonly LegalRulesLiveAction[] {
  const player = getPlayerById(game, playerId);
  if (!player) return [];
  const subPhase = game.currentSubPhase;
  const confirm = { type: GameCommandType.CONFIRM_STEP, playerId, subPhase } as const;

  if (game.currentPhase === GamePhase.LIVE_SET_PHASE) {
    if (
      subPhase !== SubPhase.LIVE_SET_FIRST_PLAYER &&
      subPhase !== SubPhase.LIVE_SET_SECOND_PLAYER
    ) {
      return [];
    }
    const candidates: LegalRulesLiveAction[] = [];
    if (
      getLiveSetCardCountForPlayer(game, playerId) < getLiveSetCardLimitForPlayer(game, playerId)
    ) {
      for (const cardId of player.hand.cardIds) {
        candidates.push({
          kind: 'SET_LIVE_CARD',
          binding: { type: GameCommandType.SET_LIVE_CARD, playerId, cardId, faceDown: true },
        });
      }
    }
    // 确认后才补抽；不提供 UNSET 或跨过抽牌边界回退比较的动作。
    candidates.push({ kind: 'CONFIRM_LIVE_SET', binding: { ...confirm, subPhase } });
    return candidates;
  }

  if (game.currentPhase === GamePhase.PERFORMANCE_PHASE) {
    if (subPhase === SubPhase.PERFORMANCE_LIVE_START_EFFECTS) {
      return [{ kind: 'CONTINUE_LIVE_START', binding: { ...confirm, subPhase } }];
    }
    if (subPhase !== SubPhase.PERFORMANCE_JUDGMENT) return [];
    // 中央门禁以 Map.has 判断完整 draft，false 判定与 0 分不能当作缺失。
    return getRulesModeConfirmStepBlockedReason(game, playerId) === null
      ? [{ kind: 'CONFIRM_JUDGMENT', binding: { ...confirm, subPhase } }]
      : [
          {
            kind: 'SUBMIT_JUDGMENT',
            binding: {
              type: GameCommandType.SUBMIT_JUDGMENT,
              playerId,
              judgmentResults: new Map(),
            },
          },
        ];
  }

  if (game.currentPhase !== GamePhase.LIVE_RESULT_PHASE) return [];
  if (
    subPhase === SubPhase.RESULT_FIRST_SUCCESS_EFFECTS ||
    subPhase === SubPhase.RESULT_SECOND_SUCCESS_EFFECTS
  ) {
    return [{ kind: 'CONTINUE_SUCCESS_EFFECTS', binding: { ...confirm, subPhase } }];
  }
  if (subPhase === SubPhase.RESULT_SCORE_CONFIRM) {
    return game.liveResolution.scoreConfirmedBy.includes(playerId)
      ? []
      : [{ kind: 'SUBMIT_SCORE', binding: { type: GameCommandType.SUBMIT_SCORE, playerId } }];
  }
  if (subPhase === SubPhase.RESULT_ANIMATION) {
    return game.liveResolution.liveWinnerIds.includes(playerId) &&
      !game.liveResolution.animationConfirmedBy.includes(playerId)
      ? [{ kind: 'CONFIRM_RESULT_ANIMATION', binding: { ...confirm, subPhase } }]
      : [];
  }
  if (subPhase !== SubPhase.RESULT_SETTLEMENT) return [];
  if (haveAllSuccessLiveSettlementsCompleted(game)) {
    return game.liveResolution.liveWinnerIds.includes(playerId)
      ? [{ kind: 'CONFIRM_RESULT_SETTLEMENT', binding: { ...confirm, subPhase } }]
      : [];
  }
  if (getCurrentSuccessLiveSettlementPlayerId(game) !== playerId) return [];
  // 是否成功与能否进入成功区由规则 helper 决定，不额外要求分数大于 0。
  const cardIds = getSuccessLiveSelectionCandidateIds(game, playerId);
  if (cardIds.length === 0) {
    return [{ kind: 'CONFIRM_RESULT_SETTLEMENT', binding: { ...confirm, subPhase } }];
  }
  return [
    ...cardIds.map((cardId): LegalRulesLiveAction => ({
      kind: 'SELECT_SUCCESS_LIVE',
      binding: { type: GameCommandType.SELECT_SUCCESS_LIVE, playerId, cardId },
    })),
    {
      kind: 'SKIP_SUCCESS_LIVE',
      binding: { ...confirm, subPhase, skipSuccessLiveSelection: true },
    },
  ];
}
