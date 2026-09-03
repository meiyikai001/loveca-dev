import { describe, expect, it } from 'vitest';
import { GamePhase, SubPhase } from '@game/shared/types/enums';
import { canExecuteOpponentDebugAiTurn } from './onlineDebugAiTurn';

describe('canExecuteOpponentDebugAiTurn', () => {
  it('只在当前换牌子阶段轮到对手席位时可用', () => {
    expect(
      canExecuteOpponentDebugAiTurn(
        {
          phase: GamePhase.MULLIGAN_PHASE,
          subPhase: SubPhase.MULLIGAN_FIRST_PLAYER,
          firstSeat: 'FIRST',
        },
        'FIRST'
      )
    ).toBe(true);
    expect(
      canExecuteOpponentDebugAiTurn(
        {
          phase: GamePhase.MULLIGAN_PHASE,
          subPhase: SubPhase.MULLIGAN_SECOND_PLAYER,
          firstSeat: 'FIRST',
        },
        'SECOND'
      )
    ).toBe(true);
  });

  it('己方换牌窗口、其他阶段和空局面均不可用', () => {
    expect(
      canExecuteOpponentDebugAiTurn(
        {
          phase: GamePhase.MULLIGAN_PHASE,
          subPhase: SubPhase.MULLIGAN_FIRST_PLAYER,
          firstSeat: 'FIRST',
        },
        'SECOND'
      )
    ).toBe(false);
    expect(
      canExecuteOpponentDebugAiTurn(
        {
          phase: GamePhase.MAIN_PHASE,
          subPhase: SubPhase.NONE,
          firstSeat: 'FIRST',
        },
        'SECOND'
      )
    ).toBe(false);
    expect(canExecuteOpponentDebugAiTurn(null, 'SECOND')).toBe(false);
  });
});
