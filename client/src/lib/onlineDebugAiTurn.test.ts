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
    readonly window?: PlayerViewState['match']['window'];
    readonly liveResult?: PlayerViewState['match']['liveResult'];
    readonly hasActiveEffect?: boolean;
    readonly activeEffect?: PlayerViewState['activeEffect'];
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
      window:
        options.window ??
        (options.hasWindow
          ? {
              windowType: 'SERIAL_PRIORITY',
              status: 'OPENED',
              actingSeat: 'SECOND',
              waitingSeats: ['SECOND'],
            }
          : null),
      liveResult: options.liveResult,
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
    activeEffect:
      options.activeEffect ??
      (options.hasActiveEffect ? ({} as NonNullable<PlayerViewState['activeEffect']>) : null),
    pendingCostPayment: options.hasPendingCostPayment
      ? ({} as NonNullable<PlayerViewState['pendingCostPayment']>)
      : null,
    pendingSpecialMemberPlay: options.hasPendingSpecialMemberPlay
      ? ({} as NonNullable<PlayerViewState['pendingSpecialMemberPlay']>)
      : null,
  };
}

function createActiveEffect(
  overrides: Partial<NonNullable<PlayerViewState['activeEffect']>> = {}
): NonNullable<PlayerViewState['activeEffect']> {
  return {
    id: 'effect-test',
    abilityId: 'ability-test',
    sourceObjectId: 'obj-source',
    controllerSeat: 'SECOND',
    effectText: '测试效果',
    stepId: 'step-test',
    stepText: '处理当前效果步骤',
    waitingSeat: 'SECOND',
    ...overrides,
  };
}

function createLiveResult(
  overrides: Partial<NonNullable<PlayerViewState['match']['liveResult']>> = {}
): NonNullable<PlayerViewState['match']['liveResult']> {
  return {
    scores: { FIRST: 0, SECOND: 0 },
    scoreModifiers: { FIRST: 0, SECOND: 0 },
    heartBonuses: { FIRST: [], SECOND: [] },
    cheerHeartColorReplacements: { FIRST: null, SECOND: null },
    requirementReductions: {},
    requirementModifiers: {},
    liveCardScoreModifiers: {},
    winnerSeats: [],
    confirmedSeats: [],
    ...overrides,
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

  it('效果步骤按等待席位归责，不要求对手同时拥有回合或效果控制权', () => {
    expect(
      getOpponentDebugAiTurnKind(
        createPlayerView({
          activeSeat: 'FIRST',
          prioritySeat: 'FIRST',
          hasWindow: true,
          activeEffect: createActiveEffect({ controllerSeat: 'FIRST' }),
        }),
        'SECOND'
      )
    ).toBe('EFFECT_STEP');
  });

  it.each(['FIRST', null] as const)('等待席位是 %s 时不能替对手处理卡效', (waitingSeat) => {
    expect(
      getOpponentDebugAiTurnKind(
        createPlayerView({ activeEffect: createActiveEffect({ waitingSeat }) }),
        'SECOND'
      )
    ).toBeNull();
  });

  it.each([
    ['自由模式', { mode: 'FREE' as const }],
    ['已结束', { hasEndInfo: true }],
    ['不支持的阶段', { phase: GamePhase.ENERGY_PHASE }],
  ])('%s 时不展示对手卡效步骤入口', (_label, overrides) => {
    expect(
      getOpponentDebugAiTurnKind(
        createPlayerView({ ...overrides, activeEffect: createActiveEffect() }),
        'SECOND'
      )
    ).toBeNull();
  });

  it.each([
    'publicCardSelectionAutoAdvanceAt',
    'publicCardSelectionAutoAdvanceAfterMs',
    'publicEffectChoiceAutoAdvanceAt',
    'publicEffectChoiceAutoAdvanceAfterMs',
    'publicRevealAutoAdvanceAt',
    'publicRevealAutoAdvanceAfterMs',
  ] as const)('存在 %s 时交给公开展示自动推进，零剩余时长也不展示入口', (timerField) => {
    expect(
      getOpponentDebugAiTurnKind(
        createPlayerView({ activeEffect: createActiveEffect({ [timerField]: 0 }) }),
        'SECOND'
      )
    ).toBeNull();
  });

  it.each<{
    label: string;
    effect: Partial<NonNullable<PlayerViewState['activeEffect']>>;
  }>([
    { label: '数值输入', effect: { numericInput: { min: 1, max: 3 } } },
    { label: '舞台阵型', effect: { stageFormation: { playerSeat: 'SECOND', slots: [] } } },
    { label: '盲选牌背', effect: { selectableObjectsFaceDown: true } },
    {
      label: '单选模式却要求多张卡牌',
      effect: {
        selectableObjectMode: 'SINGLE',
        minSelectableObjects: 0,
        maxSelectableObjects: 2,
      },
    },
    {
      label: '真正多选效果',
      effect: {
        effectChoice: {
          mode: 'MULTI',
          options: [],
          minSelections: 1,
          maxSelections: 2,
          publicConfirmation: true,
        },
      },
    },
  ])('$label 不在已知支持的卡效步骤范围内', ({ effect }) => {
    expect(
      getOpponentDebugAiTurnKind(
        createPlayerView({
          activeEffect: createActiveEffect({
            selectableObjectMode: 'ORDERED_MULTI',
            minSelectableObjects: 1,
            maxSelectableObjects: 2,
            ...effect,
          }),
        }),
        'SECOND'
      )
    ).toBeNull();
  });

  it.each([
    [1, 1],
    [0, 2],
    [2, 2],
    [3, 3],
  ])('ORDERED_MULTI 选择 %s 至 %s 张时复用卡效一步入口', (min, max) => {
    expect(
      getOpponentDebugAiTurnKind(
        createPlayerView({
          activeEffect: createActiveEffect({
            selectableObjectMode: 'ORDERED_MULTI',
            minSelectableObjects: min,
            maxSelectableObjects: max,
            selectableObjectIds: ['obj-candidate-1', 'obj-candidate-2', 'obj-candidate-3'],
          }),
        }),
        'SECOND'
      )
    ).toBe('EFFECT_STEP');
  });

  it('对手私密候选和选择规格被玩家投影省略时仍保留服务端判定入口', () => {
    const playerViewState = createPlayerView({ activeEffect: createActiveEffect() });
    expect(playerViewState.activeEffect?.selectableObjectIds).toBeUndefined();
    expect(playerViewState.activeEffect?.selectableObjectMode).toBeUndefined();
    expect(getOpponentDebugAiTurnKind(playerViewState, 'SECOND')).toBe('EFFECT_STEP');
  });

  it('私密多选候选与模式缺失时不从数量推断为不支持', () => {
    const playerViewState = createPlayerView({
      activeEffect: createActiveEffect({ minSelectableObjects: 2, maxSelectableObjects: 2 }),
    });
    expect(playerViewState.activeEffect?.selectableObjectIds).toBeUndefined();
    expect(playerViewState.activeEffect?.selectableObjectMode).toBeUndefined();
    expect(getOpponentDebugAiTurnKind(playerViewState, 'SECOND')).toBe('EFFECT_STEP');
  });

  it.each([
    [GamePhase.LIVE_SET_PHASE, SubPhase.LIVE_SET_SECOND_PLAYER],
    [GamePhase.PERFORMANCE_PHASE, SubPhase.PERFORMANCE_LIVE_START_EFFECTS],
    [GamePhase.PERFORMANCE_PHASE, SubPhase.PERFORMANCE_JUDGMENT],
    [GamePhase.LIVE_RESULT_PHASE, SubPhase.RESULT_SECOND_SUCCESS_EFFECTS],
  ])('%s / %s 的待处理简单卡效优先于 LIVE 推进', (phase, subPhase) => {
    expect(
      getOpponentDebugAiTurnKind(
        createPlayerView({ phase, subPhase, activeEffect: createActiveEffect() }),
        'SECOND'
      )
    ).toBe('EFFECT_STEP');
    expect(
      getOpponentDebugAiTurnKind(
        createPlayerView({
          phase,
          subPhase,
          hasWindow: true,
          activeEffect: createActiveEffect({ publicRevealAutoAdvanceAt: 100 }),
        }),
        'SECOND'
      )
    ).toBeNull();
  });

  it.each(['FIRST', 'SECOND'] as const)('先攻为 %s 时只为当前盖牌者显示 LIVE 入口', (firstSeat) => {
    for (const subPhase of [SubPhase.LIVE_SET_FIRST_PLAYER, SubPhase.LIVE_SET_SECOND_PLAYER]) {
      const view = createPlayerView({ phase: GamePhase.LIVE_SET_PHASE, subPhase, firstSeat });
      const settingSeat =
        subPhase === SubPhase.LIVE_SET_FIRST_PLAYER
          ? firstSeat
          : firstSeat === 'FIRST'
            ? 'SECOND'
            : 'FIRST';
      expect(getOpponentDebugAiTurnKind(view, settingSeat)).toBe('LIVE_ACTION');
      expect(
        getOpponentDebugAiTurnKind(view, settingSeat === 'FIRST' ? 'SECOND' : 'FIRST')
      ).toBeNull();
    }
  });

  it.each([
    [GamePhase.PERFORMANCE_PHASE, SubPhase.PERFORMANCE_LIVE_START_EFFECTS],
    [GamePhase.PERFORMANCE_PHASE, SubPhase.PERFORMANCE_JUDGMENT],
    [GamePhase.LIVE_RESULT_PHASE, SubPhase.RESULT_FIRST_SUCCESS_EFFECTS],
    [GamePhase.LIVE_RESULT_PHASE, SubPhase.RESULT_SECOND_SUCCESS_EFFECTS],
  ])('%s / %s 依公开等待窗口识别责任，不推测判定结果', (phase, subPhase) => {
    const view = createPlayerView({ phase, subPhase, hasWindow: true, activeSeat: 'FIRST' });
    expect(getOpponentDebugAiTurnKind(view, 'SECOND')).toBe('LIVE_ACTION');
    expect(getOpponentDebugAiTurnKind(view, 'FIRST')).toBeNull();
    expect(getOpponentDebugAiTurnKind(createPlayerView({ phase, subPhase }), 'SECOND')).toBeNull();
  });

  it('无单独 waitingSeat 的公开表演窗口按 actingSeat 识别', () => {
    expect(
      getOpponentDebugAiTurnKind(
        createPlayerView({
          phase: GamePhase.PERFORMANCE_PHASE,
          subPhase: SubPhase.PERFORMANCE_JUDGMENT,
          window: {
            windowType: 'SERIAL_PRIORITY',
            status: 'OPENED',
            actingSeat: 'SECOND',
            waitingSeats: [],
          },
        }),
        'SECOND'
      )
    ).toBe('LIVE_ACTION');
  });

  it('分数确认依双方各自 confirmedSeats，不依当前 activeSeat 或单人 waitingSeats', () => {
    const options = {
      phase: GamePhase.LIVE_RESULT_PHASE,
      subPhase: SubPhase.RESULT_SCORE_CONFIRM,
      activeSeat: 'FIRST' as const,
      window: {
        windowType: 'SIMULTANEOUS_COMMIT' as const,
        status: 'OPENED' as const,
        waitingSeats: ['FIRST' as const],
      },
    };
    expect(
      getOpponentDebugAiTurnKind(
        createPlayerView({
          ...options,
          liveResult: createLiveResult({ confirmedSeats: ['FIRST'] }),
        }),
        'SECOND'
      )
    ).toBe('LIVE_ACTION');
    expect(
      getOpponentDebugAiTurnKind(
        createPlayerView({
          ...options,
          liveResult: createLiveResult({ confirmedSeats: ['SECOND'] }),
        }),
        'SECOND'
      )
    ).toBeNull();
    expect(getOpponentDebugAiTurnKind(createPlayerView(options), 'SECOND')).toBeNull();
  });

  it('胜者动画入口只为公开胜者出现，是否已确认仍由服务端判断', () => {
    const options = { phase: GamePhase.LIVE_RESULT_PHASE, subPhase: SubPhase.RESULT_ANIMATION };
    expect(
      getOpponentDebugAiTurnKind(
        createPlayerView({ ...options, liveResult: createLiveResult({ winnerSeats: ['SECOND'] }) }),
        'SECOND'
      )
    ).toBe('LIVE_ACTION');
    expect(
      getOpponentDebugAiTurnKind(
        createPlayerView({ ...options, liveResult: createLiveResult({ winnerSeats: ['FIRST'] }) }),
        'SECOND'
      )
    ).toBeNull();
  });

  it('成功 LIVE 结算按公开候选责任席位，完成选卡后按等待窗口', () => {
    const options = {
      phase: GamePhase.LIVE_RESULT_PHASE,
      subPhase: SubPhase.RESULT_SETTLEMENT,
      hasWindow: true,
    };
    expect(
      getOpponentDebugAiTurnKind(
        createPlayerView({
          ...options,
          liveResult: createLiveResult({
            successLiveSelection: {
              waitingSeat: 'FIRST',
              candidateObjectIds: ['obj-live'],
              canSkipToWaitingRoom: false,
            },
          }),
        }),
        'SECOND'
      )
    ).toBeNull();
    expect(
      getOpponentDebugAiTurnKind(
        createPlayerView({
          ...options,
          liveResult: createLiveResult({
            successLiveSelection: {
              waitingSeat: 'SECOND',
              candidateObjectIds: ['obj-live'],
              canSkipToWaitingRoom: false,
            },
          }),
        }),
        'SECOND'
      )
    ).toBe('LIVE_ACTION');
    expect(
      getOpponentDebugAiTurnKind(
        createPlayerView({
          ...options,
          liveResult: createLiveResult({ successLiveSelection: null }),
        }),
        'SECOND'
      )
    ).toBe('LIVE_ACTION');
  });

  it.each([
    [GamePhase.LIVE_SET_PHASE, SubPhase.LIVE_SET_FIRST_DRAW],
    [GamePhase.LIVE_SET_PHASE, SubPhase.LIVE_SET_SECOND_DRAW],
    [GamePhase.PERFORMANCE_PHASE, SubPhase.PERFORMANCE_REVEAL],
    [GamePhase.LIVE_RESULT_PHASE, SubPhase.RESULT_TURN_END],
  ])('%s / %s 自动子阶段不显示 AI 入口', (phase, subPhase) => {
    expect(
      getOpponentDebugAiTurnKind(createPlayerView({ phase, subPhase, hasWindow: true }), 'SECOND')
    ).toBeNull();
  });

  it.each([
    { hasPendingCostPayment: true },
    { hasPendingSpecialMemberPlay: true },
    { activeEffect: createActiveEffect({ waitingSeat: 'FIRST' }) },
    {
      window: {
        windowType: 'INSPECTION' as const,
        status: 'OPENED' as const,
        waitingSeats: ['SECOND' as const],
      },
    },
    {
      window: {
        windowType: 'SERIAL_PRIORITY' as const,
        status: 'CLOSED' as const,
        waitingSeats: ['SECOND' as const],
      },
    },
  ])('待处理输入、检视或关闭窗口不被 LIVE 动作绕过：%j', (overrides) => {
    expect(
      getOpponentDebugAiTurnKind(
        createPlayerView({
          phase: GamePhase.PERFORMANCE_PHASE,
          subPhase: SubPhase.PERFORMANCE_JUDGMENT,
          hasWindow: true,
          ...overrides,
        }),
        'SECOND'
      )
    ).toBeNull();
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
