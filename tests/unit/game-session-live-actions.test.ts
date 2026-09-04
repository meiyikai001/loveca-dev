import { describe, expect, it, vi } from 'vitest';
import { createGameSession, type GameSessionOptions } from '../../src/application/game-session';
import { GameCommandType } from '../../src/application/game-commands';
import { GameService } from '../../src/application/game-service';
import {
  createCardInstance,
  createHeartRequirement,
  type AnyCardData,
} from '../../src/domain/entities/card';
import type { ActiveEffectState, GameState } from '../../src/domain/entities/game';
import {
  CardType,
  FaceState,
  GameMode,
  GamePhase,
  OrientationState,
  SubPhase,
} from '../../src/shared/types/enums';
import * as effectRunner from '../../src/application/card-effect-runner';

const PLAYER = 'player1';
const OPPONENT = 'player2';
const MEMBER = 'own-hand-member';
const LIVE = 'own-hand-live';
const ZERO_LIVE = 'own-zero-live';
const FAILED_LIVE = 'own-failed-live';
const OPPONENT_LIVE = 'opponent-live';
const DECK_TOP = 'hidden-deck-top';
const DECK_NEXT = 'hidden-deck-next';

function createSession(
  currentPhase: GamePhase = GamePhase.LIVE_SET_PHASE,
  currentSubPhase: SubPhase = SubPhase.LIVE_SET_FIRST_PLAYER,
  options: GameSessionOptions = {}
) {
  const session = createGameSession({ now: () => 123_456, ...options });
  const state = session.createGame('live-candidates', PLAYER, '玩家', OPPONENT, '对手');
  Object.assign(state, {
    currentPhase,
    currentSubPhase,
    firstPlayerIndex: 0,
    activePlayerIndex: 0,
    waitingPlayerId: null,
    liveSetCardIds: new Map([
      [PLAYER, []],
      [OPPONENT, []],
    ]),
  });
  const registry = state.cardRegistry as Map<string, ReturnType<typeof createCardInstance>>;
  for (const cardId of [MEMBER, LIVE, ZERO_LIVE, FAILED_LIVE, OPPONENT_LIVE, DECK_TOP, DECK_NEXT]) {
    const data: AnyCardData =
      cardId === MEMBER
        ? {
            cardCode: `TEST-${cardId}`,
            name: cardId,
            cardType: CardType.MEMBER,
            cost: 1,
            blade: 0,
            hearts: [],
          }
        : {
            cardCode: `TEST-${cardId}`,
            name: cardId,
            cardType: CardType.LIVE,
            score: cardId === ZERO_LIVE ? 0 : 1,
            requirements: createHeartRequirement({}),
          };
    registry.set(
      cardId,
      createCardInstance(data, cardId === OPPONENT_LIVE ? OPPONENT : PLAYER, cardId)
    );
  }
  Object.assign(state.players[0]!.hand, { cardIds: [MEMBER, LIVE] });
  Object.assign(state.players[0]!.mainDeck, { cardIds: [DECK_TOP, DECK_NEXT] });
  Object.assign(state.players[1]!.hand, { cardIds: [OPPONENT_LIVE] });
  return session;
}

function setLiveZone(state: GameState, playerIndex: 0 | 1, cardIds: readonly string[]) {
  Object.assign(state.players[playerIndex]!.liveZone, {
    cardIds: [...cardIds],
    cardStates: new Map(
      cardIds.map((cardId) => [
        cardId,
        { face: FaceState.FACE_UP, orientation: OrientationState.ACTIVE },
      ])
    ),
  });
}

function confirmBinding(subPhase: SubPhase, playerId = PLAYER) {
  return { type: GameCommandType.CONFIRM_STEP, playerId, subPhase };
}

function actionKinds(session: ReturnType<typeof createGameSession>, playerId = PLAYER) {
  return session.getLegalRulesLiveActions(playerId).map((action) => action.kind);
}

function simpleEffect(patch: Partial<ActiveEffectState> = {}): ActiveEffectState {
  return {
    id: 'live-effect',
    abilityId: 'live-test-ability',
    sourceCardId: MEMBER,
    controllerId: PLAYER,
    effectText: '测试当前 LIVE 步骤',
    stepId: 'TEST_SELECTION',
    stepText: '选择手牌',
    awaitingPlayerId: PLAYER,
    selectableCardIds: [MEMBER],
    ...patch,
  };
}

describe('GameSession LIVE 首批权威候选', () => {
  it('按手牌顺序逐张盖牌后提供确认，成员亦可盖；不提供撤回或组合', () => {
    const session = createSession();
    expect(session.getLegalRulesLiveActions(PLAYER)).toEqual([
      {
        kind: 'SET_LIVE_CARD',
        binding: {
          type: GameCommandType.SET_LIVE_CARD,
          playerId: PLAYER,
          cardId: MEMBER,
          faceDown: true,
        },
      },
      {
        kind: 'SET_LIVE_CARD',
        binding: {
          type: GameCommandType.SET_LIVE_CARD,
          playerId: PLAYER,
          cardId: LIVE,
          faceDown: true,
        },
      },
      { kind: 'CONFIRM_LIVE_SET', binding: confirmBinding(SubPhase.LIVE_SET_FIRST_PLAYER) },
    ]);
    Object.assign(session.state!.players[0]!.hand, { cardIds: [] });
    expect(actionKinds(session)).toEqual(['CONFIRM_LIVE_SET']);
  });

  it('使用本轮实际盖牌数及动态限额，不把原有 LIVE 区牌数当盖牌数', () => {
    const session = createSession();
    const state = session.state!;
    setLiveZone(state, 0, [ZERO_LIVE, FAILED_LIVE, DECK_TOP]);
    expect(actionKinds(session)).toHaveLength(3);
    Object.assign(state, {
      liveSetCardIds: new Map([[PLAYER, [ZERO_LIVE, FAILED_LIVE, DECK_TOP]]]),
    });
    expect(actionKinds(session)).toEqual(['CONFIRM_LIVE_SET']);
    Object.assign(state, {
      liveSetCardIds: new Map([[PLAYER, [ZERO_LIVE]]]),
      liveSetLimitReductions: [
        { playerId: PLAYER, sourceCardId: MEMBER, abilityId: 'limit', amount: 2 },
      ],
    });
    expect(actionKinds(session)).toEqual(['CONFIRM_LIVE_SET']);
    Object.assign(state, { liveSetCardIds: new Map([[PLAYER, []]]) });
    expect(actionKinds(session)).toHaveLength(3);
    Object.assign(state, {
      liveSetLimitReductions: [
        { playerId: PLAYER, sourceCardId: MEMBER, abilityId: 'limit', amount: 3 },
      ],
    });
    expect(actionKinds(session)).toEqual(['CONFIRM_LIVE_SET']);
  });

  it('盖牌不抽牌，确认后才批量抽牌并切换操作者，不能返回旧盖牌候选', () => {
    const session = createSession();
    const set = session.getLegalRulesLiveActions(PLAYER)[0]!;
    expect(session.executeCommand({ ...set.binding, timestamp: 1 }).success).toBe(true);
    expect(session.state!.players[0]!.hand.cardIds).toEqual([LIVE]);
    expect(session.state!.players[0]!.mainDeck.cardIds).toEqual([DECK_TOP, DECK_NEXT]);
    const confirm = session
      .getLegalRulesLiveActions(PLAYER)
      .find((action) => action.kind === 'CONFIRM_LIVE_SET')!;
    expect(session.executeCommand({ ...confirm.binding, timestamp: 2 }).success).toBe(true);
    expect(session.state!.players[0]!.hand.cardIds).toEqual([LIVE, DECK_TOP]);
    expect(session.state!.players[0]!.mainDeck.cardIds).toEqual([DECK_NEXT]);
    expect(session.state!.currentSubPhase).toBe(SubPhase.LIVE_SET_SECOND_PLAYER);
    expect(actionKinds(session)).toEqual([]);
    expect(actionKinds(session, OPPONENT)).toEqual(['SET_LIVE_CARD', 'CONFIRM_LIVE_SET']);
  });

  it('盖牌操作者按先后攻配置，中央 waitingPlayerId 门禁仍过滤候选', () => {
    const session = createSession();
    Object.assign(session.state!, { firstPlayerIndex: 1 });
    expect(actionKinds(session)).toEqual([]);
    expect(actionKinds(session, OPPONENT)).toEqual(['SET_LIVE_CARD', 'CONFIRM_LIVE_SET']);
    Object.assign(session.state!, { currentSubPhase: SubPhase.LIVE_SET_SECOND_PLAYER });
    expect(actionKinds(session)).toHaveLength(3);
    Object.assign(session.state!, { waitingPlayerId: OPPONENT });
    expect(actionKinds(session)).toEqual([]);
  });

  it.each([
    [GamePhase.PERFORMANCE_PHASE, SubPhase.PERFORMANCE_LIVE_START_EFFECTS, 'CONTINUE_LIVE_START'],
    [
      GamePhase.LIVE_RESULT_PHASE,
      SubPhase.RESULT_FIRST_SUCCESS_EFFECTS,
      'CONTINUE_SUCCESS_EFFECTS',
    ],
  ] as const)('仅在清空效果后的 %s/%s 提供继续', (phase, subPhase, kind) => {
    const session = createSession(phase, subPhase);
    expect(session.getLegalRulesLiveActions(PLAYER)).toEqual([
      { kind, binding: confirmBinding(subPhase) },
    ]);
    expect(actionKinds(session, OPPONENT)).toEqual([]);
  });

  it('第二个成功效果窗口属于后攻而非 activePlayerIndex', () => {
    const session = createSession(
      GamePhase.LIVE_RESULT_PHASE,
      SubPhase.RESULT_SECOND_SUCCESS_EFFECTS
    );
    expect(actionKinds(session)).toEqual([]);
    expect(session.getLegalRulesLiveActions(OPPONENT)).toEqual([
      {
        kind: 'CONTINUE_SUCCESS_EFFECTS',
        binding: confirmBinding(SubPhase.RESULT_SECOND_SUCCESS_EFFECTS, OPPONENT),
      },
    ]);
  });

  it('未有完整 draft 时仅提交空 Map 自动判定，不让 AI 填结果或预演判定', () => {
    const session = createSession(GamePhase.PERFORMANCE_PHASE, SubPhase.PERFORMANCE_JUDGMENT);
    setLiveZone(session.state!, 0, [ZERO_LIVE, FAILED_LIVE]);
    Object.assign(session.state!.liveResolution, { liveResults: new Map([[ZERO_LIVE, true]]) });
    expect(session.getLegalRulesLiveActions(PLAYER)).toEqual([
      {
        kind: 'SUBMIT_JUDGMENT',
        binding: {
          type: GameCommandType.SUBMIT_JUDGMENT,
          playerId: PLAYER,
          judgmentResults: new Map(),
        },
      },
    ]);
    expect(actionKinds(session, OPPONENT)).toEqual([]);
  });

  it('false 判定和 0 分都是完整结果；空 LIVE 区亦可接受而非重复提交', () => {
    const session = createSession(GamePhase.PERFORMANCE_PHASE, SubPhase.PERFORMANCE_JUDGMENT);
    setLiveZone(session.state!, 0, [ZERO_LIVE, FAILED_LIVE]);
    Object.assign(session.state!.liveResolution, {
      liveResults: new Map([
        [ZERO_LIVE, true],
        [FAILED_LIVE, false],
      ]),
      playerScores: new Map([[PLAYER, 0]]),
    });
    expect(session.getLegalRulesLiveActions(PLAYER)).toEqual([
      { kind: 'CONFIRM_JUDGMENT', binding: confirmBinding(SubPhase.PERFORMANCE_JUDGMENT) },
    ]);
    setLiveZone(session.state!, 0, []);
    expect(actionKinds(session)).toEqual(['CONFIRM_JUDGMENT']);
  });

  it('双方可独立确认既有分数，无 adjustedScore 且不重复提交已确认玩家', () => {
    const session = createSession(GamePhase.LIVE_RESULT_PHASE, SubPhase.RESULT_SCORE_CONFIRM);
    Object.assign(session.state!.liveResolution, {
      playerScores: new Map([
        [PLAYER, 0],
        [OPPONENT, 3],
      ]),
    });
    expect(session.getLegalRulesLiveActions(PLAYER)).toEqual([
      { kind: 'SUBMIT_SCORE', binding: { type: GameCommandType.SUBMIT_SCORE, playerId: PLAYER } },
    ]);
    expect(actionKinds(session, OPPONENT)).toEqual(['SUBMIT_SCORE']);
    Object.assign(session.state!.liveResolution, { scoreConfirmedBy: [PLAYER] });
    expect(actionKinds(session)).toEqual([]);
    expect(actionKinds(session, OPPONENT)).toEqual(['SUBMIT_SCORE']);
  });

  it('动画只允许尚未确认的胜者，拒绝败者与重复确认', () => {
    const session = createSession(GamePhase.LIVE_RESULT_PHASE, SubPhase.RESULT_ANIMATION);
    Object.assign(session.state!.liveResolution, { liveWinnerIds: [PLAYER] });
    expect(session.getLegalRulesLiveActions(PLAYER)).toEqual([
      { kind: 'CONFIRM_RESULT_ANIMATION', binding: confirmBinding(SubPhase.RESULT_ANIMATION) },
    ]);
    expect(actionKinds(session, OPPONENT)).toEqual([]);
    Object.assign(session.state!.liveResolution, {
      liveWinnerIds: [PLAYER, OPPONENT],
      animationConfirmedBy: [PLAYER],
    });
    expect(actionKinds(session)).toEqual([]);
    expect(actionKinds(session, OPPONENT)).toEqual(['CONFIRM_RESULT_ANIMATION']);
  });

  it('成功区候选包括 0 分成功 LIVE，排除 false、其他玩家和不在 LIVE 区的牌', () => {
    const session = createSession(GamePhase.LIVE_RESULT_PHASE, SubPhase.RESULT_SETTLEMENT);
    setLiveZone(session.state!, 0, [ZERO_LIVE, FAILED_LIVE]);
    setLiveZone(session.state!, 1, [OPPONENT_LIVE]);
    Object.assign(session.state!.liveResolution, {
      liveWinnerIds: [PLAYER],
      liveResults: new Map([
        [ZERO_LIVE, true],
        [FAILED_LIVE, false],
        [OPPONENT_LIVE, true],
        [LIVE, true],
      ]),
      playerScores: new Map([[PLAYER, 0]]),
    });
    expect(session.getLegalRulesLiveActions(PLAYER)).toEqual([
      {
        kind: 'SELECT_SUCCESS_LIVE',
        binding: { type: GameCommandType.SELECT_SUCCESS_LIVE, playerId: PLAYER, cardId: ZERO_LIVE },
      },
    ]);
    expect(actionKinds(session, OPPONENT)).toEqual([]);
  });

  it.each([{ allowRulesModeSuccessLiveSkip: true }, { gameMode: GameMode.SOLITAIRE }])(
    '仅显式配置或对墙打允许带 true 的跳过成功选卡：%j',
    (options) => {
      const session = createSession(
        GamePhase.LIVE_RESULT_PHASE,
        SubPhase.RESULT_SETTLEMENT,
        options
      );
      setLiveZone(session.state!, 0, [ZERO_LIVE]);
      Object.assign(session.state!.liveResolution, {
        liveWinnerIds: [PLAYER],
        liveResults: new Map([[ZERO_LIVE, true]]),
      });
      expect(session.getLegalRulesLiveActions(PLAYER)).toEqual([
        {
          kind: 'SELECT_SUCCESS_LIVE',
          binding: {
            type: GameCommandType.SELECT_SUCCESS_LIVE,
            playerId: PLAYER,
            cardId: ZERO_LIVE,
          },
        },
        {
          kind: 'SKIP_SUCCESS_LIVE',
          binding: {
            ...confirmBinding(SubPhase.RESULT_SETTLEMENT),
            skipSuccessLiveSelection: true,
          },
        },
      ]);
    }
  );

  it('按 liveWinnerIds 结算顺序选卡；已移卡者不能再次选，全部完成后仍可结束结算', () => {
    const session = createSession(GamePhase.LIVE_RESULT_PHASE, SubPhase.RESULT_SETTLEMENT);
    setLiveZone(session.state!, 0, [ZERO_LIVE]);
    setLiveZone(session.state!, 1, [OPPONENT_LIVE]);
    Object.assign(session.state!.liveResolution, {
      liveWinnerIds: [OPPONENT, PLAYER],
      liveResults: new Map([
        [ZERO_LIVE, true],
        [OPPONENT_LIVE, true],
      ]),
    });
    expect(actionKinds(session)).toEqual([]);
    expect(actionKinds(session, OPPONENT)).toEqual(['SELECT_SUCCESS_LIVE']);
    Object.assign(session.state!.liveResolution, { successCardMovedBy: [OPPONENT] });
    expect(actionKinds(session, OPPONENT)).toEqual([]);
    expect(actionKinds(session)).toEqual(['SELECT_SUCCESS_LIVE']);
    Object.assign(session.state!.liveResolution, { settlementConfirmedBy: [PLAYER] });
    expect(actionKinds(session)).toEqual(['CONFIRM_RESULT_SETTLEMENT']);
    expect(actionKinds(session, OPPONENT)).toEqual(['CONFIRM_RESULT_SETTLEMENT']);
  });

  it('无合法成功候选或被同分限制阻断时使用正常确认，不伪造显式 skip', () => {
    const session = createSession(GamePhase.LIVE_RESULT_PHASE, SubPhase.RESULT_SETTLEMENT);
    setLiveZone(session.state!, 0, [ZERO_LIVE]);
    Object.assign(session.state!.liveResolution, {
      liveWinnerIds: [PLAYER],
      liveResults: new Map([[ZERO_LIVE, true]]),
      playerScores: new Map([
        [PLAYER, 0],
        [OPPONENT, 0],
      ]),
      successLivePlacementRestrictions: [
        {
          playerId: PLAYER,
          sourceCardId: MEMBER,
          abilityId: 'tie',
          appliesWhen: 'TIED_LIVE_SCORE',
          expiresAt: 'LIVE_END',
        },
      ],
    });
    expect(session.getLegalRulesLiveActions(PLAYER)).toEqual([
      { kind: 'CONFIRM_RESULT_SETTLEMENT', binding: confirmBinding(SubPhase.RESULT_SETTLEMENT) },
    ]);
    Object.assign(session.state!.liveResolution, { liveWinnerIds: [] });
    expect(actionKinds(session)).toEqual([]);
  });

  it('所有待决效果、选择、代价、特殊登场、委托队列和检查时点均阻断普通 LIVE 动作', () => {
    const patches: Partial<GameState>[] = [
      { activeEffect: simpleEffect() },
      { pendingAbilities: [{ id: 'pending' }] as GameState['pendingAbilities'] },
      { pendingChoice: { id: 'choice' } as GameState['pendingChoice'] },
      { pendingCostPayment: { id: 'cost' } as GameState['pendingCostPayment'] },
      { pendingSpecialMemberPlay: { id: 'play' } as GameState['pendingSpecialMemberPlay'] },
      { delegatedAbilitySequence: { id: 'delegated' } as GameState['delegatedAbilitySequence'] },
      { checkTimingContext: { id: 'timing' } as GameState['checkTimingContext'] },
    ];
    for (const patch of patches) {
      const session = createSession();
      Object.assign(session.state!, patch);
      expect(actionKinds(session)).toEqual([]);
    }
  });

  it('未开始、FREE、终局、错误玩家及不匹配阶段均无候选', () => {
    expect(createGameSession().getLegalRulesLiveActions(PLAYER)).toEqual([]);
    const free = createSession();
    expect(free.setManualOperationMode('FREE').success).toBe(true);
    expect(actionKinds(free)).toEqual([]);
    const session = createSession();
    expect(actionKinds(session, 'missing-player')).toEqual([]);
    Object.assign(session.state!, { isEnded: true });
    expect(actionKinds(session)).toEqual([]);
    Object.assign(session.state!, { isEnded: false, currentPhase: GamePhase.MAIN_PHASE });
    expect(actionKinds(session)).toEqual([]);
  });

  it.each([
    [GamePhase.LIVE_SET_PHASE, SubPhase.LIVE_SET_FIRST_DRAW],
    [GamePhase.LIVE_SET_PHASE, SubPhase.LIVE_SET_SECOND_DRAW],
    [GamePhase.PERFORMANCE_PHASE, SubPhase.PERFORMANCE_REVEAL],
    [GamePhase.LIVE_RESULT_PHASE, SubPhase.RESULT_TURN_END],
  ] as const)('不枚举自动子阶段 %s/%s', (phase, subPhase) => {
    expect(actionKinds(createSession(phase, subPhase))).toEqual([]);
  });

  it.each([
    [GamePhase.LIVE_SET_PHASE, SubPhase.LIVE_SET_FIRST_DRAW],
    [GamePhase.PERFORMANCE_PHASE, SubPhase.PERFORMANCE_JUDGMENT],
    [GamePhase.LIVE_RESULT_PHASE, SubPhase.RESULT_SETTLEMENT],
  ] as const)('简单效果可在 %s/%s 合法 awaiting 时点处理，计时展示仍拒绝', (phase, subPhase) => {
    const session = createSession(phase, subPhase);
    Object.assign(session.state!, {
      activePlayerIndex: 1,
      waitingPlayerId: OPPONENT,
      activeEffect: simpleEffect(),
    });
    expect(session.getLegalRulesEffectStepActions(PLAYER)).toEqual([
      {
        kind: 'SELECT_CARD',
        binding: {
          type: GameCommandType.CONFIRM_EFFECT_STEP,
          playerId: PLAYER,
          effectId: 'live-effect',
          selectedCardId: MEMBER,
        },
      },
    ]);
    expect(session.getLegalRulesEffectStepActions(OPPONENT)).toEqual([]);
    expect(actionKinds(session)).toEqual([]);
    Object.assign(session.state!, {
      activeEffect: simpleEffect({
        publicRevealAutoAdvanceAt: 1,
        publicRevealGeneration: 'generation-1',
      }),
    });
    expect(session.getLegalRulesEffectStepActions(PLAYER)).toEqual([]);
  });

  it.each([
    [GamePhase.LIVE_SET_PHASE, SubPhase.LIVE_SET_FIRST_PLAYER],
    [GamePhase.PERFORMANCE_PHASE, SubPhase.PERFORMANCE_JUDGMENT],
    [GamePhase.LIVE_RESULT_PHASE, SubPhase.RESULT_SETTLEMENT],
  ] as const)(
    '枚举 %s/%s 纯读：不访问牌库顺序或隐藏牌正面，不运行命令/规则/resolver',
    (phase, subPhase) => {
      const session = createSession(phase, subPhase);
      const state = session.state!;
      setLiveZone(state, 0, [ZERO_LIVE]);
      Object.assign(state.liveResolution, {
        liveWinnerIds: [PLAYER],
        liveResults:
          subPhase === SubPhase.RESULT_SETTLEMENT ? new Map([[ZERO_LIVE, true]]) : new Map(),
      });
      const before = globalThis.structuredClone(state);
      const stats = session.getRuntimeStats();
      const cursor = session.getRuntimeCaptureCursor();
      const execute = vi.spyOn(session, 'executeCommand');
      const process = vi.spyOn(GameService.prototype, 'processAction');
      const resolve = vi.spyOn(effectRunner, 'confirmActiveEffectStep');
      const deck = state.players[0]!.mainDeck;
      const originalCardIds = deck.cardIds;
      const hiddenCard = state.cardRegistry.get(DECK_TOP)!;
      const originalData = hiddenCard.data;
      const hiddenRead = vi.fn(() => {
        throw new Error('禁止读取牌库顺序与隐藏卡数据');
      });
      Object.defineProperty(deck, 'cardIds', { configurable: true, get: hiddenRead });
      Object.defineProperty(hiddenCard, 'data', { configurable: true, get: hiddenRead });
      try {
        const first = session.getLegalRulesLiveActions(PLAYER);
        expect(first.length).toBeGreaterThan(0);
        expect(session.getLegalRulesLiveActions(PLAYER)).toEqual(first);
        expect(hiddenRead).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        expect(process).not.toHaveBeenCalled();
        expect(resolve).not.toHaveBeenCalled();
        expect(session.state).toBe(state);
        expect(session.getRuntimeStats()).toEqual(stats);
        expect(session.getRuntimeCaptureCursor()).toEqual(cursor);
      } finally {
        Object.defineProperty(deck, 'cardIds', { configurable: true, value: originalCardIds });
        Object.defineProperty(hiddenCard, 'data', { configurable: true, value: originalData });
        execute.mockRestore();
        process.mockRestore();
        resolve.mockRestore();
      }
      expect(state).toEqual(before);
    }
  );
});
