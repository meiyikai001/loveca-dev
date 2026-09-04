import { describe, expect, it, vi } from 'vitest';
import { createGameSession } from '../../src/application/game-session';
import { GameCommandType } from '../../src/application/game-commands';
import { createCardInstance } from '../../src/domain/entities/card';
import type { ActiveEffectState, GameState } from '../../src/domain/entities/game';
import {
  CardType,
  FaceState,
  GamePhase,
  SlotPosition,
  SubPhase,
  ZoneType,
} from '../../src/shared/types/enums';
import * as effectRunner from '../../src/application/card-effect-runner';

const PLAYER = 'player1';
const OPPONENT = 'player2';
const SOURCE = 'public-source';
const HAND_IDS = ['own-hand-first', 'own-hand-second'] as const;
const HIDDEN_OPPONENT_HAND = 'hidden-opponent-hand';
const HIDDEN_DECK = 'hidden-deck-top';

function createEffect(patch: Partial<ActiveEffectState> = {}): ActiveEffectState {
  return {
    id: 'current-effect',
    abilityId: 'test-effect-ability',
    sourceCardId: SOURCE,
    controllerId: PLAYER,
    effectText: '测试选择效果',
    stepId: 'TEST_SELECTION',
    stepText: '请选择当前步骤的对象。',
    awaitingPlayerId: PLAYER,
    ...patch,
  };
}

function createSession(effectPatch: Partial<ActiveEffectState> = {}) {
  const session = createGameSession({ now: () => 123_456 });
  const state = session.createGame('effect-candidates', PLAYER, '玩家', OPPONENT, '对手');
  Object.assign(state, {
    currentPhase: GamePhase.MAIN_PHASE,
    currentSubPhase: SubPhase.NONE,
    activePlayerIndex: 0,
    waitingPlayerId: null,
    activeEffect: createEffect(effectPatch),
  });
  const registry = state.cardRegistry as Map<string, ReturnType<typeof createCardInstance>>;
  for (const cardId of [SOURCE, ...HAND_IDS, HIDDEN_OPPONENT_HAND, HIDDEN_DECK]) {
    registry.set(
      cardId,
      createCardInstance(
        { cardCode: `TEST-${cardId}`, name: cardId, cardType: CardType.ENERGY },
        cardId === HIDDEN_OPPONENT_HAND ? OPPONENT : PLAYER,
        cardId
      )
    );
  }
  Object.assign(state.players[0]!.hand, { cardIds: [...HAND_IDS] });
  Object.assign(state.players[0]!.mainDeck, { cardIds: [HIDDEN_DECK] });
  Object.assign(state.players[1]!.hand, { cardIds: [HIDDEN_OPPONENT_HAND] });
  Object.assign(state.players[0]!.waitingRoom, { cardIds: [SOURCE] });
  return session;
}

function expectedBinding(selection: Record<string, unknown> = {}) {
  return {
    type: GameCommandType.CONFIRM_EFFECT_STEP,
    playerId: PLAYER,
    effectId: 'current-effect',
    ...selection,
  };
}

describe('GameSession EFFECT_STEP 首批权威候选', () => {
  it('按服务端候选顺序枚举本人手牌单选，并只在显式允许时提供跳过', () => {
    const session = createSession({
      selectableCardIds: HAND_IDS,
      selectableCardVisibility: 'AWAITING_PLAYER_ONLY',
      canSkipSelection: true,
    });
    expect(session.getLegalRulesEffectStepActions(PLAYER)).toEqual([
      { kind: 'SELECT_CARD', binding: expectedBinding({ selectedCardId: HAND_IDS[0] }) },
      { kind: 'SELECT_CARD', binding: expectedBinding({ selectedCardId: HAND_IDS[1] }) },
      { kind: 'SKIP', binding: expectedBinding({ selectedCardId: null }) },
    ]);
    Object.assign(session.state!.activeEffect!, { canSkipSelection: false });
    expect(session.getLegalRulesEffectStepActions(PLAYER)).toHaveLength(2);
  });

  it('支持公开卡牌与精确 1/1 ORDERED_MULTI，但保留两种命令载荷的区别', () => {
    const publicSelection = createSession({
      selectableCardMode: 'SINGLE',
      selectableCardIds: [SOURCE],
      selectableCardVisibility: 'PUBLIC',
    });
    expect(publicSelection.getLegalRulesEffectStepActions(PLAYER)).toEqual([
      { kind: 'SELECT_CARD', binding: expectedBinding({ selectedCardId: SOURCE }) },
    ]);

    const exactSingle = createSession({
      selectableCardIds: HAND_IDS,
      selectableCardMode: 'ORDERED_MULTI',
      selectableCardVisibility: 'AWAITING_PLAYER_ONLY',
      minSelectableCards: 1,
      maxSelectableCards: 1,
    });
    expect(exactSingle.getLegalRulesEffectStepActions(PLAYER)).toEqual(
      HAND_IDS.map((cardId) => ({
        kind: 'SELECT_SINGLE_FROM_MULTI',
        binding: expectedBinding({ selectedCardIds: [cardId] }),
      }))
    );
  });

  it('枚举槽位、普通 option 和结构化单选，排除不可选分支', () => {
    const slots = createSession({ selectableSlots: [SlotPosition.RIGHT, SlotPosition.LEFT] });
    expect(slots.getLegalRulesEffectStepActions(PLAYER)).toEqual([
      { kind: 'SELECT_SLOT', binding: expectedBinding({ selectedSlot: SlotPosition.RIGHT }) },
      { kind: 'SELECT_SLOT', binding: expectedBinding({ selectedSlot: SlotPosition.LEFT }) },
    ]);
    const options = createSession({
      selectableOptions: [
        { id: 'member', label: '选择成员' },
        { id: 'energy', label: '选择能量' },
      ],
    });
    expect(options.getLegalRulesEffectStepActions(PLAYER)).toEqual([
      { kind: 'SELECT_OPTION', binding: expectedBinding({ selectedOptionId: 'member' }) },
      { kind: 'SELECT_OPTION', binding: expectedBinding({ selectedOptionId: 'energy' }) },
    ]);
    const choice = createSession({
      effectChoice: {
        mode: 'SINGLE',
        minSelections: 1,
        maxSelections: 1,
        publicConfirmation: true,
        options: [
          { id: 'available', text: '可选' },
          { id: 'disabled', text: '不可选', selectable: false },
          { id: 'available-second', text: '另一个可选', selectable: true },
        ],
      },
      canSkipSelection: true,
    });
    expect(choice.getLegalRulesEffectStepActions(PLAYER)).toEqual([
      {
        kind: 'SELECT_EFFECT_OPTION',
        binding: expectedBinding({ selectedEffectOptionIds: ['available'] }),
      },
      {
        kind: 'SELECT_EFFECT_OPTION',
        binding: expectedBinding({ selectedEffectOptionIds: ['available-second'] }),
      },
      { kind: 'SKIP', binding: expectedBinding({ selectedCardId: null }) },
    ]);
  });

  it('只为明确 confirm-only 壳提供无输入确认，不把未知空窗或遗漏候选当确认', () => {
    const confirmed = createSession({
      stepId: 'CONFIRM_ONLY_EFFECT',
      metadata: { confirmOnlyPendingAbility: true },
    });
    expect(confirmed.getLegalRulesEffectStepActions(PLAYER)).toEqual([
      { kind: 'CONFIRM', binding: expectedBinding() },
    ]);
    for (const patch of [
      {},
      { canSkipSelection: true },
      { stepId: 'CONFIRM_ONLY_EFFECT' },
      { metadata: { confirmOnlyPendingAbility: true } },
      { selectableCardIds: [], selectableCardMode: 'SINGLE' as const },
      { selectableCardIds: [], selectableSlots: [], selectableOptions: [] },
    ]) {
      expect(createSession(patch).getLegalRulesEffectStepActions(PLAYER)).toEqual([]);
    }
    const explicitlyEmpty = createSession({ selectableCardIds: [], canSkipSelection: true });
    expect(explicitlyEmpty.getLegalRulesEffectStepActions(PLAYER)).toEqual([
      { kind: 'SKIP', binding: expectedBinding({ selectedCardId: null }) },
    ]);
  });

  it('队列只提供下一来源或具体 ability option，不提供 resolveInOrder', () => {
    for (const patch of [
      { selectableCardIds: [SOURCE] },
      { selectableOptions: [{ id: 'pending-ability-id', label: '来源的第二个效果' }] },
    ]) {
      const session = createSession({
        abilityId: 'system:select-pending-card-effect',
        stepId: 'SELECT_NEXT_PENDING_ABILITY',
        canResolveInOrder: true,
        ...patch,
      });
      const actions = session.getLegalRulesEffectStepActions(PLAYER);
      expect(actions).toHaveLength(1);
      expect(actions[0]!.kind).toBe(patch.selectableCardIds ? 'SELECT_CARD' : 'SELECT_OPTION');
      expect(Object.hasOwn(actions[0]!.binding, 'resolveInOrder')).toBe(false);
    }
  });

  it.each<Partial<ActiveEffectState>>([
    { selectableCardIds: HAND_IDS, selectableSlots: [SlotPosition.LEFT] },
    { selectableOptions: [{ id: 'x', label: 'x' }], selectableSlots: [SlotPosition.LEFT] },
    { numericInput: { min: 0, max: 5 } },
    { stageFormation: { playerId: PLAYER, slots: [] } },
    { selectableCardIds: HAND_IDS, selectableCardVisibility: 'AWAITING_PLAYER_BLIND' },
    {
      selectableCardIds: HAND_IDS,
      selectableCardMode: 'ORDERED_MULTI',
      minSelectableCards: 0,
      maxSelectableCards: 1,
    },
    {
      selectableCardIds: HAND_IDS,
      selectableCardMode: 'ORDERED_MULTI',
      minSelectableCards: 2,
      maxSelectableCards: 2,
    },
    {
      selectableCardIds: HAND_IDS,
      selectableCardMode: 'ORDERED_MULTI',
      minSelectableCards: 1,
    },
    {
      selectableCardIds: [SOURCE],
      selectableCardMode: 'ORDERED_MULTI',
      minSelectableCards: 1,
      maxSelectableCards: 1,
      metadata: {
        publicCardSelectionConfirmation: {
          destination: 'HAND',
          groups: [{ candidateCardIds: [SOURCE], minCount: 1, maxCount: 1 }],
        },
      },
    },
    {
      effectChoice: {
        mode: 'MULTI',
        minSelections: 0,
        maxSelections: 2,
        publicConfirmation: true,
        options: [
          { id: 'a', text: 'a' },
          { id: 'b', text: 'b' },
        ],
      },
    },
  ])('拒绝不在首批支持范围内的输入形态，即使 canSkipSelection=true：%j', (patch) => {
    expect(
      createSession({ canSkipSelection: true, ...patch }).getLegalRulesEffectStepActions(PLAYER)
    ).toEqual([]);
  });

  it.each<Partial<ActiveEffectState>>([
    { stepId: 'COMMON_PUBLIC_CARD_SELECTION_CONFIRMATION' },
    { stepId: 'COMMON_PUBLIC_EFFECT_CHOICE_CONFIRMATION' },
    { stepId: 'COMMON_PUBLIC_REVEAL_DWELL' },
    { publicCardSelectionAutoAdvanceAt: 1 },
    { publicEffectChoiceAutoAdvanceAt: 1 },
    { publicRevealAutoAdvanceAt: 1, publicRevealGeneration: 'generation' },
  ])('公开展示窗口不产生 AI 选择或确认候选：%j', (patch) => {
    expect(
      createSession({
        stepId: 'CONFIRM_ONLY_EFFECT',
        metadata: { confirmOnlyPendingAbility: true },
        ...patch,
      }).getLegalRulesEffectStepActions(PLAYER)
    ).toEqual([]);
  });

  it('对手隐藏卡、未公开牌库卡与部分无法投影的候选全部拒绝，不退化为空确认', () => {
    for (const cardIds of [[HIDDEN_OPPONENT_HAND], [HIDDEN_DECK], [SOURCE, HIDDEN_OPPONENT_HAND]]) {
      const session = createSession({ selectableCardIds: cardIds, canSkipSelection: true });
      expect(session.getLegalRulesEffectStepActions(PLAYER)).toEqual([]);
    }
  });

  it('只要求本步等待玩家是调用者，不误用主阶段行动者或效果控制者', () => {
    const session = createSession({
      controllerId: OPPONENT,
      selectableCardIds: HAND_IDS,
      selectableCardVisibility: 'AWAITING_PLAYER_ONLY',
    });
    Object.assign(session.state!, { activePlayerIndex: 1, waitingPlayerId: OPPONENT });
    expect(session.getLegalRulesEffectStepActions(PLAYER)).toHaveLength(2);
    expect(session.getLegalRulesEffectStepActions(OPPONENT)).toEqual([]);
  });

  it('检视采用实际 viewer 而非牌所有者；只允许已向本视角公开的解决区和 LIVE 卡', () => {
    const inspection = createSession({ selectableCardIds: [HIDDEN_OPPONENT_HAND] });
    Object.assign(inspection.state!.players[1]!.hand, { cardIds: [] });
    Object.assign(inspection.state!.inspectionZone, { cardIds: [HIDDEN_OPPONENT_HAND] });
    Object.assign(inspection.state!, {
      inspectionContext: {
        ownerPlayerId: OPPONENT,
        viewerPlayerId: PLAYER,
        sourceZone: ZoneType.MAIN_DECK,
      },
    });
    expect(inspection.getLegalRulesEffectStepActions(PLAYER)).toHaveLength(1);
    Object.assign(inspection.state!.inspectionContext!, { viewerPlayerId: OPPONENT });
    expect(inspection.getLegalRulesEffectStepActions(PLAYER)).toEqual([]);
    Object.assign(inspection.state!.inspectionZone, { revealedCardIds: [HIDDEN_OPPONENT_HAND] });
    expect(inspection.getLegalRulesEffectStepActions(PLAYER)).toHaveLength(1);

    const resolution = createSession({ selectableCardIds: [HIDDEN_OPPONENT_HAND] });
    Object.assign(resolution.state!.players[1]!.hand, { cardIds: [] });
    Object.assign(resolution.state!.resolutionZone, { cardIds: [HIDDEN_OPPONENT_HAND] });
    expect(resolution.getLegalRulesEffectStepActions(PLAYER)).toEqual([]);
    Object.assign(resolution.state!.resolutionZone, { revealedCardIds: [HIDDEN_OPPONENT_HAND] });
    expect(resolution.getLegalRulesEffectStepActions(PLAYER)).toHaveLength(1);

    const live = createSession({ selectableCardIds: [HIDDEN_OPPONENT_HAND] });
    Object.assign(live.state!.players[1]!.hand, { cardIds: [] });
    Object.assign(live.state!.players[1]!.liveZone, {
      cardIds: [HIDDEN_OPPONENT_HAND],
      cardStates: new Map([[HIDDEN_OPPONENT_HAND, { face: FaceState.FACE_DOWN }]]),
    });
    expect(live.getLegalRulesEffectStepActions(PLAYER)).toEqual([]);
    Object.assign(live.state!.activeEffect!, { revealedCardIds: [HIDDEN_OPPONENT_HAND] });
    expect(live.getLegalRulesEffectStepActions(PLAYER)).toHaveLength(1);
  });

  it('拒绝 FREE、不支持阶段、终局、其他 pending 窗口和错误玩家', () => {
    expect(createGameSession().getLegalRulesEffectStepActions(PLAYER)).toEqual([]);
    const free = createSession();
    Object.assign(free.state!, { activeEffect: null });
    expect(free.setManualOperationMode('FREE').success).toBe(true);
    Object.assign(free.state!, { activeEffect: createEffect({ selectableCardIds: HAND_IDS }) });
    expect(free.getLegalRulesEffectStepActions(PLAYER)).toEqual([]);
    const patches: Partial<GameState>[] = [
      { currentPhase: GamePhase.DRAW_PHASE },
      { isEnded: true },
      { activeEffect: null },
      { pendingChoice: { id: 'choice' } as GameState['pendingChoice'] },
      { pendingCostPayment: { id: 'cost' } as GameState['pendingCostPayment'] },
      { pendingSpecialMemberPlay: { id: 'play' } as GameState['pendingSpecialMemberPlay'] },
    ];
    for (const patch of patches) {
      const session = createSession({ selectableCardIds: HAND_IDS });
      Object.assign(session.state!, patch);
      expect(session.getLegalRulesEffectStepActions(PLAYER)).toEqual([]);
    }
    const other = createSession({ selectableCardIds: HAND_IDS });
    expect(other.getLegalRulesEffectStepActions(OPPONENT)).toEqual([]);
    expect(other.getLegalRulesEffectStepActions('missing-player')).toEqual([]);
  });

  it('枚举保持状态与日志不变，不执行命令或 resolver，也不读取隐藏卡正面', () => {
    const session = createSession({ selectableCardIds: HAND_IDS, canSkipSelection: true });
    const state = session.state!;
    const before = globalThis.structuredClone(state);
    const beforeStats = session.getRuntimeStats();
    const beforeCursor = session.getRuntimeCaptureCursor();
    const execute = vi.spyOn(session, 'executeCommand');
    const resolve = vi.spyOn(effectRunner, 'confirmActiveEffectStep');
    const hiddenCard = state.cardRegistry.get(HIDDEN_DECK)!;
    const originalHiddenData = hiddenCard.data;
    const hiddenFace = vi.fn(() => {
      throw new Error('禁止读取隐藏牌库卡正面');
    });
    Object.defineProperty(hiddenCard, 'data', { configurable: true, get: hiddenFace });
    try {
      const first = session.getLegalRulesEffectStepActions(PLAYER);
      expect(first).toHaveLength(3);
      expect(session.getLegalRulesEffectStepActions(PLAYER)).toEqual(first);
      expect(hiddenFace).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      expect(session.state).toBe(state);
      expect(session.getRuntimeStats()).toEqual(beforeStats);
      expect(session.getRuntimeCaptureCursor()).toEqual(beforeCursor);
    } finally {
      Object.defineProperty(hiddenCard, 'data', { configurable: true, value: originalHiddenData });
      execute.mockRestore();
      resolve.mockRestore();
    }
    expect(state).toEqual(before);
  });
});

describe('GameSession 通用多选声明规格', () => {
  const multi = {
    selectableCardMode: 'ORDERED_MULTI' as const,
    selectableCardIds: HAND_IDS,
    minSelectableCards: 0,
    maxSelectableCards: 2,
  };

  it('保留候选次序、逐组上下限与独占分配语义，不枚举组合', () => {
    const groups = [
      { candidateCardIds: [...HAND_IDS], minCount: 1, maxCount: 1 },
      { candidateCardIds: [HAND_IDS[1]], minCount: 1, maxCount: 1 },
    ];
    const session = createSession({
      ...multi,
      minSelectableCards: 2,
      canSkipSelection: true,
      metadata: {
        publicCardSelectionConfirmation: {
          destination: 'HAND',
          groups,
          distinctGroupAssignment: true,
        },
      },
    });
    const selection = session.getRulesEffectCardSelection(PLAYER);
    expect(selection).toEqual({
      binding: expectedBinding(),
      cardIds: HAND_IDS,
      minSelections: 2,
      maxSelections: 2,
      canSkip: true,
      groups,
      distinctGroupAssignment: true,
    });
    expect(selection!.cardIds).not.toBe(HAND_IDS);
    expect(selection!.groups).not.toBe(groups);
    expect(session.getRulesEffectCardSelection(OPPONENT)).toBeNull();
  });

  it('明确区分空列表确认与跳过，并保持无分组精确选一的既有入口', () => {
    const session = createSession(multi);
    expect(session.getRulesEffectCardSelection(PLAYER)).toMatchObject({
      minSelections: 0,
      maxSelections: 2,
      canSkip: false,
    });
    Object.assign(session.state!.activeEffect!, { minSelectableCards: 1, maxSelectableCards: 1 });
    expect(session.getRulesEffectCardSelection(PLAYER)).toBeNull();
    expect(session.getLegalRulesEffectStepActions(PLAYER)).toHaveLength(2);
    Object.assign(session.state!.activeEffect!, {
      metadata: {
        publicCardSelectionConfirmation: {
          destination: 'HAND',
          groups: [{ candidateCardIds: [HAND_IDS[0]], minCount: 1, maxCount: 1 }],
        },
      },
    });
    expect(session.getRulesEffectCardSelection(PLAYER)).toMatchObject({
      minSelections: 1,
      maxSelections: 1,
    });
    expect(session.getLegalRulesEffectStepActions(PLAYER)).toEqual([]);
  });

  it('畸形分组不能被宽松解析器静默丢弃为无约束窗口', () => {
    const invalidGroups: unknown[] = [
      null,
      'not-groups',
      [null],
      [{}],
      [{ candidateCardIds: [HIDDEN_DECK], minCount: 0, maxCount: 1 }],
      [{ candidateCardIds: [HAND_IDS[0], HAND_IDS[0]], minCount: 0, maxCount: 2 }],
      [{ candidateCardIds: HAND_IDS, minCount: -1, maxCount: 2 }],
      [{ candidateCardIds: HAND_IDS, minCount: 0.5, maxCount: 2 }],
      [{ candidateCardIds: HAND_IDS, minCount: 0, maxCount: Infinity }],
      [{ candidateCardIds: HAND_IDS, minCount: 2, maxCount: 1 }],
    ];
    for (const groups of invalidGroups) {
      const session = createSession({
        ...multi,
        metadata: {
          publicCardSelectionConfirmation: { destination: 'HAND', groups },
        },
      });
      expect(session.getRulesEffectCardSelection(PLAYER)).toBeNull();
    }
    const invalidDistinct = createSession({
      ...multi,
      metadata: {
        publicCardSelectionConfirmation: { destination: 'HAND', distinctGroupAssignment: 'true' },
      },
    });
    expect(invalidDistinct.getRulesEffectCardSelection(PLAYER)).toBeNull();
  });

  it('未知或混合输入、盲选、隐藏对象、计时公开展示与数量超限均不开放', () => {
    const patches: Partial<ActiveEffectState>[] = [
      { selectableCardIds: [HIDDEN_OPPONENT_HAND] },
      { selectableCardIds: [HIDDEN_DECK, HAND_IDS[0]] },
      { selectableCardIds: [HAND_IDS[0], HAND_IDS[0]] },
      { selectableCardVisibility: 'AWAITING_PLAYER_BLIND' },
      { selectableSlots: [] },
      { selectableOptions: [] },
      { numericInput: { min: 0, max: 2 } },
      { stageFormation: { playerId: PLAYER, slots: [] } },
      { publicCardSelectionAutoAdvanceAt: 1 },
      { publicRevealAutoAdvanceAt: 1 },
      { publicEffectChoiceAutoAdvanceAt: 1 },
      { maxSelectableCards: 257 },
      { minSelectableCards: 3 },
      { minSelectableCards: NaN },
    ];
    for (const patch of patches)
      expect(createSession({ ...multi, ...patch }).getRulesEffectCardSelection(PLAYER)).toBeNull();
    const session = createSession(multi);
    Object.assign(session.state!, { isEnded: true });
    expect(session.getRulesEffectCardSelection(PLAYER)).toBeNull();
    expect(createGameSession().getRulesEffectCardSelection(PLAYER)).toBeNull();
  });

  it('查询无副作用，不读隐藏卡面、不执行命令或卡效', () => {
    const session = createSession(multi);
    const beforeState = session.state;
    const beforeStats = session.getRuntimeStats();
    const hiddenCard = session.state!.cardRegistry.get(HIDDEN_DECK)!;
    const originalData = hiddenCard.data;
    const readHidden = vi.fn(() => {
      throw new Error('不允许读取隐藏卡面');
    });
    const execute = vi.spyOn(session, 'executeCommand');
    const resolve = vi.spyOn(effectRunner, 'confirmActiveEffectStep');
    Object.defineProperty(hiddenCard, 'data', { configurable: true, get: readHidden });
    try {
      const first = session.getRulesEffectCardSelection(PLAYER);
      expect(first?.cardIds).toEqual(HAND_IDS);
      expect(session.getRulesEffectCardSelection(PLAYER)).toEqual(first);
      expect(readHidden).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      expect(session.state).toBe(beforeState);
      expect(session.getRuntimeStats()).toEqual(beforeStats);
    } finally {
      Object.defineProperty(hiddenCard, 'data', { configurable: true, value: originalData });
      execute.mockRestore();
      resolve.mockRestore();
    }
  });
});
