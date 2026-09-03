import type { PlayerViewState, Seat } from '@game/online';
import { GamePhase, SubPhase } from '@game/shared/types/enums';

export type OpponentDebugAiTurnKind = 'MULLIGAN' | 'MAIN_ACTION';

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
