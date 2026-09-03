import { describe, expect, it } from 'vitest';
import type { PlayerViewState } from '@game/online';
import { GameEndReason, GamePhase, SubPhase } from '@game/shared/types/enums';
import { getOpponentDebugAiTurnKind } from './onlineDebugAiTurn';

function createPlayerView(
  options: {
    readonly phase?: GamePhase;
    readonly subPhase?: SubPhase;
    readonly firstSeat?: 'FIRST' | 'SECOND';
    readonly activeSeat?: 'FIRST' | 'SECOND' | null;
    readonly prioritySeat?: 'FIRST' | 'SECOND' | null;
    readonly mode?: 'RULES' | 'FREE';
    readonly hasEndInfo?: boolean;
    readonly hasWindow?: boolean;
    readonly hasActiveEffect?: boolean;
    readonly hasPendingCostPayment?: boolean;
    readonly hasPendingSpecialMemberPlay?: boolean;
  } = {}
): PlayerViewState {
  return {
    match: {
      matchId: 'debug-match',
      viewerSeat: 'FIRST',
      participants: {
        FIRST: { id: 'player-first', name: '先攻' },
        SECOND: { id: 'player-second', name: '后攻' },
      },
      turnCount: 1,
      phase: options.phase ?? GamePhase.MAIN_PHASE,
      subPhase: options.subPhase ?? SubPhase.NONE,
      firstSeat: options.firstSeat ?? 'FIRST',
      activeSeat: options.activeSeat === undefined ? 'SECOND' : options.activeSeat,
      prioritySeat: options.prioritySeat === undefined ? 'SECOND' : options.prioritySeat,
      window: options.hasWindow
        ? {
            windowType: 'SERIAL_PRIORITY',
            status: 'OPENED',
            actingSeat: 'SECOND',
            waitingSeats: ['SECOND'],
          }
        : null,
      endInfo: options.hasEndInfo
        ? {
            reason: GameEndReason.VICTORY_CONDITION,
            winnerSeat: 'FIRST',
            loserSeat: 'SECOND',
          }
        : null,
      manualOperation: {
        mode: options.mode ?? 'RULES',
        canSwitchNow: true,
        disabledReason: null,
        pendingRequest: null,
      },
      seq: 1,
    },
    table: { zones: {} as PlayerViewState['table']['zones'] },
    objects: {},
    permissions: { availableCommands: [] },
    activeEffect: options.hasActiveEffect
      ? ({} as NonNullable<PlayerViewState['activeEffect']>)
      : null,
    pendingCostPayment: options.hasPendingCostPayment
      ? ({} as NonNullable<PlayerViewState['pendingCostPayment']>)
      : null,
    pendingSpecialMemberPlay: options.hasPendingSpecialMemberPlay
      ? ({} as NonNullable<PlayerViewState['pendingSpecialMemberPlay']>)
      : null,
  };
}

describe('getOpponentDebugAiTurnKind', () => {
  it('识别当前轮到对手的先后攻换牌窗口', () => {
    expect(
      getOpponentDebugAiTurnKind(
        createPlayerView({
          phase: GamePhase.MULLIGAN_PHASE,
          subPhase: SubPhase.MULLIGAN_FIRST_PLAYER,
          firstSeat: 'FIRST',
        }),
        'FIRST'
      )
    ).toBe('MULLIGAN');
    expect(
      getOpponentDebugAiTurnKind(
        createPlayerView({
          phase: GamePhase.MULLIGAN_PHASE,
          subPhase: SubPhase.MULLIGAN_SECOND_PLAYER,
          firstSeat: 'FIRST',
        }),
        'SECOND'
      )
    ).toBe('MULLIGAN');
  });

  it('换牌窗口轮到己方时不可用', () => {
    expect(
      getOpponentDebugAiTurnKind(
        createPlayerView({
          phase: GamePhase.MULLIGAN_PHASE,
          subPhase: SubPhase.MULLIGAN_FIRST_PLAYER,
          firstSeat: 'FIRST',
        }),
        'SECOND'
      )
    ).toBeNull();
  });

  it('规则模式下轮到对手的空闲主要阶段返回 MAIN_ACTION', () => {
    expect(getOpponentDebugAiTurnKind(createPlayerView(), 'SECOND')).toBe('MAIN_ACTION');
  });

  it.each([
    ['自由模式', createPlayerView({ mode: 'FREE' })],
    ['对局已结束', createPlayerView({ hasEndInfo: true })],
    ['非主要阶段', createPlayerView({ phase: GamePhase.LIVE_SET_PHASE })],
    ['非空主要子阶段', createPlayerView({ subPhase: SubPhase.PERFORMANCE_JUDGMENT })],
    ['当前活跃席位不是对手', createPlayerView({ activeSeat: 'FIRST' })],
    ['当前优先席位不是对手', createPlayerView({ prioritySeat: 'FIRST' })],
    ['存在公开窗口', createPlayerView({ hasWindow: true })],
    ['存在待处理效果', createPlayerView({ hasActiveEffect: true })],
    ['存在待支付费用', createPlayerView({ hasPendingCostPayment: true })],
    ['存在待处理特殊登场', createPlayerView({ hasPendingSpecialMemberPlay: true })],
  ])('%s 时主要阶段 AI 单步不可用', (_label, playerViewState) => {
    expect(getOpponentDebugAiTurnKind(playerViewState, 'SECOND')).toBeNull();
  });

  it('空局面或缺少对手席位时不可用', () => {
    expect(getOpponentDebugAiTurnKind(null, 'SECOND')).toBeNull();
    expect(getOpponentDebugAiTurnKind(createPlayerView(), null)).toBeNull();
  });
});
