import type { MatchViewState, Seat } from '@game/online';
import { GamePhase, SubPhase } from '@game/shared/types/enums';

type MulliganMatchView = Pick<MatchViewState, 'phase' | 'subPhase' | 'firstSeat'>;

export function canExecuteOpponentDebugAiTurn(
  matchView: MulliganMatchView | null,
  opponentSeat: Seat | null
): boolean {
  if (!matchView || !opponentSeat || matchView.phase !== GamePhase.MULLIGAN_PHASE) {
    return false;
  }

  if (matchView.subPhase === SubPhase.MULLIGAN_FIRST_PLAYER) {
    return opponentSeat === matchView.firstSeat;
  }
  if (matchView.subPhase === SubPhase.MULLIGAN_SECOND_PLAYER) {
    return opponentSeat !== matchView.firstSeat;
  }
  return false;
}
