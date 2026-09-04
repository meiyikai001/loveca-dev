import type { PlayerViewState, Seat } from '@game/online';
import { GamePhase, SubPhase } from '@game/shared/types/enums';

export type OpponentDebugAiTurnKind = 'MULLIGAN' | 'MAIN_ACTION' | 'EFFECT_STEP' | 'LIVE_ACTION';

export function getOpponentDebugAiTurnKind(
  playerViewState: PlayerViewState | null,
  opponentSeat: Seat | null
): OpponentDebugAiTurnKind | null {
  if (!playerViewState || !opponentSeat) {
    return null;
  }

  const matchView = playerViewState.match;
  if (matchView.manualOperation.mode !== 'RULES' || matchView.endInfo) {
    return null;
  }

  const effect = playerViewState.activeEffect;
  if (effect) {
    if (
      ![
        GamePhase.MAIN_PHASE,
        GamePhase.LIVE_SET_PHASE,
        GamePhase.PERFORMANCE_PHASE,
        GamePhase.LIVE_RESULT_PHASE,
      ].some((phase) => phase === matchView.phase) ||
      effect.waitingSeat !== opponentSeat ||
      effect.publicCardSelectionAutoAdvanceAt !== undefined ||
      effect.publicCardSelectionAutoAdvanceAfterMs !== undefined ||
      effect.publicEffectChoiceAutoAdvanceAt !== undefined ||
      effect.publicEffectChoiceAutoAdvanceAfterMs !== undefined ||
      effect.publicRevealAutoAdvanceAt !== undefined ||
      effect.publicRevealAutoAdvanceAfterMs !== undefined ||
      effect.numericInput ||
      effect.stageFormation ||
      effect.selectableObjectsFaceDown ||
      (effect.selectableObjectMode === 'SINGLE' && (effect.maxSelectableObjects ?? 0) > 1) ||
      (effect.effectChoice?.maxSelections ?? 0) > 1
    ) {
      return null;
    }

    // 对手的私密候选可能不在当前玩家投影中。这里只识别操作责任与已知
    // 未支持的形态，不能把字段缺失当作 confirm-only；由服务端最终校验。
    return 'EFFECT_STEP';
  }

  if (
    playerViewState.pendingCostPayment ||
    playerViewState.pendingSpecialMemberPlay ||
    matchView.window?.windowType === 'INSPECTION' ||
    matchView.window?.status === 'CLOSED'
  ) {
    return null;
  }

  const waitingSeats = matchView.window?.waitingSeats ?? [];
  const opponentResponsible =
    waitingSeats.length > 0
      ? waitingSeats.includes(opponentSeat)
      : matchView.window?.actingSeat === opponentSeat;

  if (
    matchView.phase === GamePhase.LIVE_SET_PHASE &&
    (matchView.subPhase === SubPhase.LIVE_SET_FIRST_PLAYER ||
      matchView.subPhase === SubPhase.LIVE_SET_SECOND_PLAYER)
  ) {
    const settingSeat =
      matchView.subPhase === SubPhase.LIVE_SET_FIRST_PLAYER
        ? matchView.firstSeat
        : matchView.firstSeat === 'FIRST'
          ? 'SECOND'
          : 'FIRST';
    return settingSeat === opponentSeat ? 'LIVE_ACTION' : null;
  }

  if (
    matchView.phase === GamePhase.PERFORMANCE_PHASE &&
    (matchView.subPhase === SubPhase.PERFORMANCE_LIVE_START_EFFECTS ||
      matchView.subPhase === SubPhase.PERFORMANCE_JUDGMENT)
  ) {
    return opponentResponsible ? 'LIVE_ACTION' : null;
  }

  if (matchView.phase === GamePhase.LIVE_RESULT_PHASE) {
    const liveResult = matchView.liveResult;
    switch (matchView.subPhase) {
      case SubPhase.RESULT_FIRST_SUCCESS_EFFECTS:
      case SubPhase.RESULT_SECOND_SUCCESS_EFFECTS:
        return opponentResponsible ? 'LIVE_ACTION' : null;
      case SubPhase.RESULT_SCORE_CONFIRM:
        return liveResult && !liveResult.confirmedSeats.includes(opponentSeat)
          ? 'LIVE_ACTION'
          : null;
      case SubPhase.RESULT_ANIMATION:
        // 动画确认状态未投影到对手视角；服务端仍会排除已经确认的席位。
        return liveResult?.winnerSeats.includes(opponentSeat) ? 'LIVE_ACTION' : null;
      case SubPhase.RESULT_SETTLEMENT:
        return (
          liveResult?.successLiveSelection
            ? liveResult.successLiveSelection.waitingSeat === opponentSeat
            : opponentResponsible
        )
          ? 'LIVE_ACTION'
          : null;
    }
  }

  if (matchView.phase === GamePhase.MULLIGAN_PHASE) {
    if (
      matchView.subPhase === SubPhase.MULLIGAN_FIRST_PLAYER &&
      opponentSeat === matchView.firstSeat
    ) {
      return 'MULLIGAN';
    }
    if (
      matchView.subPhase === SubPhase.MULLIGAN_SECOND_PLAYER &&
      opponentSeat !== matchView.firstSeat
    ) {
      return 'MULLIGAN';
    }
    return null;
  }

  if (
    matchView.phase === GamePhase.MAIN_PHASE &&
    matchView.subPhase === SubPhase.NONE &&
    matchView.activeSeat === opponentSeat &&
    matchView.prioritySeat === opponentSeat &&
    matchView.window === null &&
    !playerViewState.activeEffect &&
    !playerViewState.pendingCostPayment &&
    !playerViewState.pendingSpecialMemberPlay
  ) {
    return 'MAIN_ACTION';
  }

  return null;
}
