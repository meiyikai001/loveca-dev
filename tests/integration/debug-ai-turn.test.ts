import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type {
  AiDecisionRequestV2,
  AiDecisionProviderV2,
  AiDecisionV2,
  AiEffectStepCandidateV2,
  AiEffectCardSelectionRequestDraftV2,
  AiEffectCardSelectionWindowV2,
  AiLiveActionCandidateV2,
  AiLiveActionDecisionRequestDraftV2,
  AiLiveActionObservationV2,
  AiMainActionCandidateV2,
  AiMainActionDecisionRequestDraftV2,
} from '../../src/application/ai/ai-decision-contract';
import type { DeckConfig } from '../../src/application/game-service';
import {
  createHeartIcon,
  createHeartRequirement,
  type EnergyCardData,
  type LiveCardData,
  type MemberCardData,
} from '../../src/domain/entities/card';
import { debugOnlineRouter } from '../../src/server/routes/debug-online';
import type { PlayerViewState } from '../../src/online/types';
import {
  executeDebugMatchAiTurn,
  getDebugMatchSnapshot,
  getDebugMatchStatus,
  resetDebugMatch,
  selectDebugSeatDeck,
} from '../../src/server/services/debug-match-service';
import { createDeterministicDebugAiProvider } from '../../src/server/services/deterministic-debug-ai-provider';
import * as debugAiProviderModule from '../../src/server/services/deterministic-debug-ai-provider';
import * as cardSelectionGroups from '../../src/application/effects/card-selection-groups';
import {
  CardType,
  GamePhase,
  HeartColor,
  SlotPosition,
  SubPhase,
} from '../../src/shared/types/enums';

const SERVICE_MATCH_ID = 'debug-ai-turn-service';
const CONCURRENT_MATCH_ID = 'debug-ai-turn-concurrent';
const RECREATED_MATCH_ID = 'debug-ai-turn-recreated';
const RESET_IN_FLIGHT_MATCH_ID = 'debug-ai-turn-reset-in-flight';
const ROUTE_MATCH_ID = 'debug-ai-turn-route';
const MAIN_ACTION_MATCH_ID = 'debug-ai-turn-main-action';
const MATCH_IDS = [
  SERVICE_MATCH_ID,
  CONCURRENT_MATCH_ID,
  RECREATED_MATCH_ID,
  RESET_IN_FLIGHT_MATCH_ID,
  ROUTE_MATCH_ID,
  MAIN_ACTION_MATCH_ID,
] as const;

let deterministicDebugAiProvider: AiDecisionProviderV2;
beforeEach(() => {
  deterministicDebugAiProvider = createDeterministicDebugAiProvider();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const matchId of MATCH_IDS) {
    resetDebugMatch(matchId);
  }
});

describe('deterministic remote debug AI provider', () => {
  it.each([1, 2, 3])('卡牌多选选择最少的 %s 张并保留候选次序', async (count) => {
    const request = createCardSelectionRequest({ minSelections: count, maxSelections: 3 });
    await expect(
      deterministicDebugAiProvider.decide(request, new AbortController().signal)
    ).resolves.toEqual({
      schemaVersion: request.schemaVersion,
      decisionId: request.decisionId,
      contextDigest: request.contextDigest,
      kind: 'EFFECT_CARD_SELECTION',
      choice: 'SELECT',
      selectedCardTokens: ['card-z', 'card-a', 'card-b'].slice(0, count),
    });
  });

  it.each([
    { distinctGroupAssignment: false, expected: ['card-z'] },
    { distinctGroupAssignment: true, expected: ['card-z', 'card-a'] },
  ])(
    '分组选择复用共享约束，独立组分配为 $distinctGroupAssignment',
    async ({ distinctGroupAssignment, expected }) => {
      const request = createCardSelectionRequest({
        minSelections: 1,
        maxSelections: 2,
        distinctGroupAssignment,
        groups: [
          { candidateCardTokens: ['card-z', 'card-a'], minCount: 1, maxCount: 1 },
          { candidateCardTokens: ['card-z', 'card-b'], minCount: 1, maxCount: 1 },
        ],
      });
      await expect(
        deterministicDebugAiProvider.decide(request, new AbortController().signal)
      ).resolves.toMatchObject({ choice: 'SELECT', selectedCardTokens: expected });
    }
  );

  it('各组必须满足上限，不能只取前两张同组卡', async () => {
    const request = createCardSelectionRequest({
      groups: [
        { candidateCardTokens: ['card-z', 'card-a'], minCount: 1, maxCount: 1 },
        { candidateCardTokens: ['card-b'], minCount: 1, maxCount: 1 },
      ],
    });
    await expect(
      deterministicDebugAiProvider.decide(request, new AbortController().signal)
    ).resolves.toMatchObject({ selectedCardTokens: ['card-z', 'card-b'] });
  });

  it('已拒绝组合按有序数组排除，反向排列仍可选择且不跨请求记忆', async () => {
    const base = createCardSelectionRequest();
    const request = createCardSelectionRequest({
      candidates: base.window.candidates.slice(0, 2),
      rejectedSelections: [['card-z', 'card-a']],
    });
    await expect(
      deterministicDebugAiProvider.decide(request, new AbortController().signal)
    ).resolves.toMatchObject({ selectedCardTokens: ['card-a', 'card-z'] });
    await expect(
      deterministicDebugAiProvider.decide(base, new AbortController().signal)
    ).resolves.toMatchObject({ selectedCardTokens: ['card-z', 'card-a'] });
  });

  it('零张 SELECT 与显式 SKIP 保持不同的响应形状', async () => {
    const request = createCardSelectionRequest({
      candidates: [],
      minSelections: 0,
      maxSelections: 0,
      canSkip: true,
    });
    await expect(
      deterministicDebugAiProvider.decide(request, new AbortController().signal)
    ).resolves.toEqual({
      schemaVersion: request.schemaVersion,
      decisionId: request.decisionId,
      contextDigest: request.contextDigest,
      kind: 'EFFECT_CARD_SELECTION',
      choice: 'SELECT',
      selectedCardTokens: [],
    });
    const skippedRequest = {
      ...request,
      window: { ...request.window, rejectedSelections: [[]] },
    };
    await expect(
      deterministicDebugAiProvider.decide(skippedRequest, new AbortController().signal)
    ).resolves.toEqual({
      schemaVersion: request.schemaVersion,
      decisionId: request.decisionId,
      contextDigest: request.contextDigest,
      kind: 'EFFECT_CARD_SELECTION',
      choice: 'SKIP',
    });
  });

  it.each([false, true])('无满足公开约束的选择时，仅 canSkip=%s 才能跳过', async (canSkip) => {
    const request = createCardSelectionRequest({
      canSkip,
      groups: [{ candidateCardTokens: ['card-z'], minCount: 0, maxCount: 1 }],
    });
    const decision = await deterministicDebugAiProvider.decide(
      request,
      new AbortController().signal
    );
    if (canSkip) {
      expect(decision).toMatchObject({ kind: 'EFFECT_CARD_SELECTION', choice: 'SKIP' });
      expect(decision).not.toHaveProperty('selectedCardTokens');
    } else {
      expect(decision).toBeNull();
    }
  });

  it('候选数量超过协议上限时不进入组合搜索', async () => {
    const request = createCardSelectionRequest({
      candidates: Array.from({ length: 257 }, (_, index) => ({
        cardToken: `card-${index}`,
        card: { cardCode: 'DEBUG', cardType: CardType.MEMBER },
        ownerSeat: 'FIRST' as const,
      })),
    });
    const validation = vi.spyOn(cardSelectionGroups, 'matchesSelectionGroups');
    await expect(
      deterministicDebugAiProvider.decide(request, new AbortController().signal)
    ).resolves.toBeNull();
    expect(validation).not.toHaveBeenCalled();
  });

  it('无解的大组合在硬节点预算内停止，不穷举排列', async () => {
    const request = createCardSelectionRequest({
      minSelections: 10,
      maxSelections: 10,
      candidates: Array.from({ length: 20 }, (_, index) => ({
        cardToken: `card-${index}`,
        card: { cardCode: 'DEBUG', cardType: CardType.MEMBER },
        ownerSeat: 'FIRST' as const,
      })),
      groups: [{ candidateCardTokens: ['card-0'], minCount: 0, maxCount: 1 }],
    });
    const validation = vi.spyOn(cardSelectionGroups, 'matchesSelectionGroups');
    const clock = vi.spyOn(globalThis.performance, 'now').mockReturnValue(0);
    try {
      await expect(
        deterministicDebugAiProvider.decide(request, new AbortController().signal)
      ).resolves.toBeNull();
      expect(validation.mock.calls.length).toBeGreaterThan(0);
      expect(validation.mock.calls.length).toBeLessThanOrEqual(4_096);
    } finally {
      clock.mockRestore();
    }
  });

  it('单调时间预算用尽时停止搜索，不提交尚未验证的组合', async () => {
    const request = createCardSelectionRequest();
    const clock = vi
      .spyOn(globalThis.performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValue(100);
    try {
      await expect(
        deterministicDebugAiProvider.decide(request, new AbortController().signal)
      ).resolves.toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it('LIVE 设置优先第一张手牌 LIVE，不选更早的成员伪装候选', async () => {
    const request = createLiveActionRequest([
      { actionToken: 'set-member', kind: 'SET_LIVE_CARD', sourceHandToken: 'hand-member' },
      { actionToken: 'confirm-set', kind: 'CONFIRM_LIVE_SET' },
      { actionToken: 'set-live', kind: 'SET_LIVE_CARD', sourceHandToken: 'hand-live' },
    ]);
    await expect(
      deterministicDebugAiProvider.decide(request, new AbortController().signal)
    ).resolves.toEqual({
      schemaVersion: request.schemaVersion,
      decisionId: request.decisionId,
      contextDigest: request.contextDigest,
      kind: 'LIVE_ACTION',
      selectedActionToken: 'set-live',
    });
  });

  it('本轮自己的 LIVE 区已有 LIVE 时结束盖牌，不继续加牌或参考对手盖牌', async () => {
    const candidates: AiLiveActionCandidateV2[] = [
      { actionToken: 'set-live', kind: 'SET_LIVE_CARD', sourceHandToken: 'hand-live' },
      { actionToken: 'confirm-set', kind: 'CONFIRM_LIVE_SET' },
    ];
    const ownLive = {
      liveToken: 'own-live',
      faceDown: true,
      card: { cardCode: 'DEBUG-LIVE', cardType: CardType.LIVE, score: 1 },
    };
    const request = createLiveActionRequest(candidates, [ownLive]);
    await expect(
      deterministicDebugAiProvider.decide(request, new AbortController().signal)
    ).resolves.toMatchObject({ selectedActionToken: 'confirm-set' });
    const opponentOnlyRequest = createLiveActionRequest(candidates, [], [ownLive]);
    await expect(
      deterministicDebugAiProvider.decide(opponentOnlyRequest, new AbortController().signal)
    ).resolves.toMatchObject({ selectedActionToken: 'set-live' });
  });

  it('没有手牌 LIVE 候选时直接完成盖牌，不用成员伪装', async () => {
    const request = createLiveActionRequest([
      { actionToken: 'set-member', kind: 'SET_LIVE_CARD', sourceHandToken: 'hand-member' },
      { actionToken: 'confirm-set', kind: 'CONFIRM_LIVE_SET' },
    ]);
    await expect(
      deterministicDebugAiProvider.decide(request, new AbortController().signal)
    ).resolves.toMatchObject({ selectedActionToken: 'confirm-set' });
  });

  it('成功 LIVE 选首个合法候选，不优先跳过或按分数重新计算成功', async () => {
    const request = createLiveActionRequest([
      { actionToken: 'skip-success', kind: 'SKIP_SUCCESS_LIVE' },
      {
        actionToken: 'select-first',
        kind: 'SELECT_SUCCESS_LIVE',
        liveToken: 'first-live',
        card: { cardCode: 'DEBUG-LIVE-LOW', cardType: CardType.LIVE, score: 1 },
      },
      {
        actionToken: 'select-second',
        kind: 'SELECT_SUCCESS_LIVE',
        liveToken: 'second-live',
        card: { cardCode: 'DEBUG-LIVE-HIGH', cardType: CardType.LIVE, score: 9 },
      },
    ]);
    await expect(
      deterministicDebugAiProvider.decide(request, new AbortController().signal)
    ).resolves.toMatchObject({ selectedActionToken: 'select-first' });
  });

  it.each<AiLiveActionCandidateV2['kind']>([
    'CONTINUE_LIVE_START',
    'SUBMIT_JUDGMENT',
    'CONFIRM_JUDGMENT',
    'SUBMIT_SCORE',
    'CONTINUE_SUCCESS_EFFECTS',
    'CONFIRM_RESULT_ANIMATION',
    'SKIP_SUCCESS_LIVE',
    'CONFIRM_RESULT_SETTLEMENT',
  ])('LIVE 单步 %s 只返回候选令牌', async (kind) => {
    const candidate = { actionToken: 'live-next', kind } as AiLiveActionCandidateV2;
    const request = createLiveActionRequest([candidate]);
    await expect(
      deterministicDebugAiProvider.decide(request, new AbortController().signal)
    ).resolves.toEqual({
      schemaVersion: request.schemaVersion,
      decisionId: request.decisionId,
      contextDigest: request.contextDigest,
      kind: 'LIVE_ACTION',
      selectedActionToken: 'live-next',
    });
  });

  it('LIVE 无合法候选时不伪造动作', async () => {
    await expect(
      deterministicDebugAiProvider.decide(createLiveActionRequest([]), new AbortController().signal)
    ).resolves.toBeNull();
  });

  it.each<AiEffectStepCandidateV2>([
    { actionToken: 'effect-confirm', kind: 'CONFIRM' },
    {
      actionToken: 'effect-card',
      kind: 'SELECT_CARD',
      card: { cardCode: 'DEBUG-EFFECT-CARD', cardType: CardType.MEMBER, cost: 1 },
      ownerSeat: 'FIRST',
    },
    { actionToken: 'effect-slot', kind: 'SELECT_SLOT', targetSlot: SlotPosition.LEFT },
    { actionToken: 'effect-option', kind: 'SELECT_OPTION', label: '测试分支' },
    { actionToken: 'effect-choice', kind: 'SELECT_EFFECT_OPTION', label: '测试效果' },
  ])('卡效测试 bot 按顺序选首个非 SKIP 候选：$kind', async (candidate) => {
    const request = createEffectStepRequest([
      { actionToken: 'effect-skip', kind: 'SKIP' },
      candidate,
      { actionToken: 'effect-later-confirm', kind: 'CONFIRM' },
    ]);

    await expect(
      deterministicDebugAiProvider.decide(request, new AbortController().signal)
    ).resolves.toEqual({
      schemaVersion: request.schemaVersion,
      decisionId: request.decisionId,
      contextDigest: request.contextDigest,
      kind: 'EFFECT_STEP',
      selectedActionToken: candidate.actionToken,
    });
  });

  it('卡效仅剩 SKIP 时选它，没有候选时不伪造动作', async () => {
    const request = createEffectStepRequest([{ actionToken: 'effect-skip', kind: 'SKIP' }]);
    await expect(
      deterministicDebugAiProvider.decide(request, new AbortController().signal)
    ).resolves.toMatchObject({ kind: 'EFFECT_STEP', selectedActionToken: 'effect-skip' });
    await expect(
      deterministicDebugAiProvider.decide(createEffectStepRequest([]), new AbortController().signal)
    ).resolves.toBeNull();
  });

  it.each([
    {
      label: '优先起动当前白名单能力，再考虑成员登场或结束阶段',
      candidates: createMainActionCandidates('END', 'SINGLE_RELAY', 'EMPTY_SLOT', 'ACTIVATED'),
      expectedActionToken: 'action-activate',
    },
    {
      label: '优先空槽普通登场',
      candidates: createMainActionCandidates('END', 'SINGLE_RELAY', 'EMPTY_SLOT'),
      expectedActionToken: 'action-empty',
    },
    {
      label: '无空槽登场时选择单换手',
      candidates: createMainActionCandidates('END', 'SINGLE_RELAY'),
      expectedActionToken: 'action-relay',
    },
    {
      label: '无可登场成员时结束主要阶段',
      candidates: createMainActionCandidates('END'),
      expectedActionToken: 'action-end',
    },
  ])('$label', async ({ candidates, expectedActionToken }) => {
    const request = createMainActionRequest(candidates);

    const decision = await deterministicDebugAiProvider.decide(
      request,
      new AbortController().signal
    );

    expect(decision).toEqual({
      schemaVersion: request.schemaVersion,
      decisionId: request.decisionId,
      contextDigest: request.contextDigest,
      kind: 'MAIN_ACTION',
      selectedActionToken: expectedActionToken,
    });
  });

  it('多个起动候选时按权威顺序选第一个，响应仅包含动作 token', async () => {
    const request = createMainActionRequest([
      ...createMainActionCandidates('END'),
      {
        actionToken: 'action-activate-right',
        kind: 'ACTIVATE_ABILITY',
        legality: 'DECLARATION_ONLY',
        sourceSlot: SlotPosition.RIGHT,
        abilityText: '支付 2 能量，处理右侧来源的起动能力',
      },
      ...createMainActionCandidates('ACTIVATED'),
    ]);

    await expect(
      deterministicDebugAiProvider.decide(request, new AbortController().signal)
    ).resolves.toEqual({
      schemaVersion: request.schemaVersion,
      decisionId: request.decisionId,
      contextDigest: request.contextDigest,
      kind: 'MAIN_ACTION',
      selectedActionToken: 'action-activate-right',
    });
  });

  it('起动决定返回即记为已尝试，未执行或被拒绝后也不重复选择同一声明', async () => {
    const request = createMainActionRequest(createMainActionCandidates('ACTIVATED', 'END'));
    await expect(
      deterministicDebugAiProvider.decide(request, new AbortController().signal)
    ).resolves.toMatchObject({ selectedActionToken: 'action-activate' });
    await expect(
      deterministicDebugAiProvider.decide(request, new AbortController().signal)
    ).resolves.toMatchObject({ selectedActionToken: 'action-end' });
    await expect(
      deterministicDebugAiProvider.decide(
        createEffectStepRequest([{ actionToken: 'effect-skip', kind: 'SKIP' }]),
        new AbortController().signal
      )
    ).resolves.toMatchObject({ selectedActionToken: 'effect-skip' });

    const changedRequest = {
      ...request,
      decisionId: 'changed-decision',
      contextDigest: 'sha256:changed-state',
      observation: {
        ...request.observation,
        match: { ...request.observation.match, publicSequence: 9 },
        self: { ...request.observation.self, energy: { activeCount: 0, totalCount: 3 } },
      },
      window: {
        ...request.window,
        candidates: request.window.candidates.map((candidate) =>
          candidate.kind === 'ACTIVATE_ABILITY'
            ? { ...candidate, actionToken: 'changed-activation-token' }
            : candidate
        ),
      },
    };
    await expect(
      deterministicDebugAiProvider.decide(changedRequest, new AbortController().signal)
    ).resolves.toMatchObject({ selectedActionToken: 'action-end' });
  });

  it('已经尝试起动后仍保留普通登场优先级，不直接结束主阶段', async () => {
    const request = createMainActionRequest(
      createMainActionCandidates('ACTIVATED', 'EMPTY_SLOT', 'END')
    );
    await deterministicDebugAiProvider.decide(request, new AbortController().signal);
    await expect(
      deterministicDebugAiProvider.decide(request, new AbortController().signal)
    ).resolves.toMatchObject({ selectedActionToken: 'action-empty' });
  });

  it.each(['sourceSlot', 'abilityText'] as const)('起动尝试签名区分 %s', async (field) => {
    const request = createMainActionRequest(createMainActionCandidates('ACTIVATED', 'END'));
    await deterministicDebugAiProvider.decide(request, new AbortController().signal);
    const distinctRequest = {
      ...request,
      window: {
        ...request.window,
        candidates: request.window.candidates.map((candidate) =>
          candidate.kind === 'ACTIVATE_ABILITY'
            ? {
                ...candidate,
                ...(field === 'sourceSlot'
                  ? { sourceSlot: SlotPosition.RIGHT }
                  : { abilityText: '另一条起动效果' }),
                actionToken: 'distinct-activation',
              }
            : candidate
        ),
      },
    };
    await expect(
      deterministicDebugAiProvider.decide(distinctRequest, new AbortController().signal)
    ).resolves.toMatchObject({ selectedActionToken: 'distinct-activation' });
  });

  it('起动尝试按席位隔离，只在进入另一回合时重新允许', async () => {
    const request = createMainActionRequest(createMainActionCandidates('ACTIVATED', 'END'));
    await deterministicDebugAiProvider.decide(request, new AbortController().signal);
    const otherSeatRequest = {
      ...request,
      observation: {
        ...request.observation,
        match: { ...request.observation.match, viewerSeat: 'SECOND' as const },
      },
    };
    await expect(
      deterministicDebugAiProvider.decide(otherSeatRequest, new AbortController().signal)
    ).resolves.toMatchObject({ selectedActionToken: 'action-activate' });
    await expect(
      deterministicDebugAiProvider.decide(request, new AbortController().signal)
    ).resolves.toMatchObject({ selectedActionToken: 'action-end' });
    const nextTurnRequest = {
      ...request,
      observation: {
        ...request.observation,
        match: { ...request.observation.match, turnCount: 2 },
      },
    };
    await expect(
      deterministicDebugAiProvider.decide(nextTurnRequest, new AbortController().signal)
    ).resolves.toMatchObject({ selectedActionToken: 'action-activate' });
  });

  it('独立 provider 不共享同回合同槽位的起动尝试', async () => {
    const request = createMainActionRequest(createMainActionCandidates('ACTIVATED', 'END'));
    await deterministicDebugAiProvider.decide(request, new AbortController().signal);
    await expect(
      createDeterministicDebugAiProvider().decide(request, new AbortController().signal)
    ).resolves.toMatchObject({ selectedActionToken: 'action-activate' });
  });
});

describe('remote debug AI turn service', () => {
  it('按 match/seat 创建独立 provider，复用时不新建，重开时重新创建', async () => {
    const createProvider = vi.spyOn(debugAiProviderModule, 'createDeterministicDebugAiProvider');
    startDebugMatch(SERVICE_MATCH_ID);
    await executeDebugMatchAiTurn(SERVICE_MATCH_ID, 'FIRST');
    await executeDebugMatchAiTurn(SERVICE_MATCH_ID, 'FIRST');
    expect(createProvider).toHaveBeenCalledTimes(1);
    await executeDebugMatchAiTurn(SERVICE_MATCH_ID, 'SECOND');
    startDebugMatch(MAIN_ACTION_MATCH_ID);
    await executeDebugMatchAiTurn(MAIN_ACTION_MATCH_ID, 'FIRST');
    expect(createProvider).toHaveBeenCalledTimes(3);
    const providers = createProvider.mock.results.map((result) => {
      if (result.type !== 'return') throw new Error('Expected provider factory to return');
      return result.value;
    });
    expect(new Set(providers).size).toBe(3);

    resetDebugMatch(SERVICE_MATCH_ID);
    startDebugMatch(SERVICE_MATCH_ID);
    await executeDebugMatchAiTurn(SERVICE_MATCH_ID, 'FIRST');
    expect(createProvider).toHaveBeenCalledTimes(4);
    expect(providers).not.toContain(createProvider.mock.results[3]?.value);
  });

  it('使用服务端确定性 provider 全换当前手牌，且只返回命令结果', async () => {
    startDebugMatch(SERVICE_MATCH_ID);
    const before = getDebugMatchSnapshot(SERVICE_MATCH_ID, 'FIRST');
    const originalHand = before?.playerViewState.table.zones.FIRST_HAND.objectIds;
    expect(originalHand).toHaveLength(6);

    const result = await executeDebugMatchAiTurn(SERVICE_MATCH_ID, 'FIRST');

    expect(result).toEqual({ success: true });
    const after = getDebugMatchSnapshot(SERVICE_MATCH_ID, 'FIRST');
    expect(after?.seq).toBe((before?.seq ?? 0) + 1);
    expect(after?.playerViewState.match.subPhase).toBe(SubPhase.MULLIGAN_SECOND_PLAYER);
    expect(after?.playerViewState.table.zones.FIRST_HAND.objectIds).toHaveLength(6);
    expect(after?.playerViewState.table.zones.FIRST_HAND.objectIds).not.toEqual(originalHand);
    expect(
      after?.playerViewState.table.zones.FIRST_HAND.objectIds?.some((objectId) =>
        originalHand?.includes(objectId)
      )
    ).toBe(false);
  });

  it('双方换牌后在主要阶段只登场一名成员且 revision 只增加一次', async () => {
    startDebugMatch(MAIN_ACTION_MATCH_ID, createMemberOnlyDeck());
    await expect(executeDebugMatchAiTurn(MAIN_ACTION_MATCH_ID, 'FIRST')).resolves.toEqual({
      success: true,
    });
    await expect(executeDebugMatchAiTurn(MAIN_ACTION_MATCH_ID, 'SECOND')).resolves.toEqual({
      success: true,
    });

    const before = getDebugMatchSnapshot(MAIN_ACTION_MATCH_ID, 'FIRST');
    expect(before?.playerViewState.match.phase).toBe(GamePhase.MAIN_PHASE);
    expect(before?.playerViewState.match.subPhase).toBe(SubPhase.NONE);
    expect(before?.playerViewState.match.activeSeat).toBe('FIRST');
    expect(countStageMembers(before?.playerViewState)).toBe(0);

    await expect(executeDebugMatchAiTurn(MAIN_ACTION_MATCH_ID, 'FIRST')).resolves.toEqual({
      success: true,
    });

    const after = getDebugMatchSnapshot(MAIN_ACTION_MATCH_ID, 'FIRST');
    expect(after?.seq).toBe((before?.seq ?? 0) + 1);
    expect(after?.playerViewState.match.phase).toBe(GamePhase.MAIN_PHASE);
    expect(after?.playerViewState.match.activeSeat).toBe('FIRST');
    expect(countStageMembers(after?.playerViewState)).toBe(1);
    expect(after?.playerViewState.table.zones.FIRST_HAND.count).toBe(
      (before?.playerViewState.table.zones.FIRST_HAND.count ?? 0) - 1
    );
  });

  it('非当前决策席位失败时不推进 revision 也不 touch match', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    startDebugMatch(SERVICE_MATCH_ID);
    const beforeSnapshot = getDebugMatchSnapshot(SERVICE_MATCH_ID, 'SECOND');
    const beforeStatus = getDebugMatchStatus(SERVICE_MATCH_ID);
    now.mockReturnValue(2_000);

    const result = await executeDebugMatchAiTurn(SERVICE_MATCH_ID, 'SECOND');

    expect(result).toMatchObject({ success: false });
    expect(getDebugMatchSnapshot(SERVICE_MATCH_ID, 'SECOND')?.seq).toBe(beforeSnapshot?.seq);
    expect(getDebugMatchStatus(SERVICE_MATCH_ID).updatedAt).toBe(beforeStatus.updatedAt);

    now.mockReturnValue(3_000);
    await expect(executeDebugMatchAiTurn(SERVICE_MATCH_ID, 'FIRST')).resolves.toEqual({
      success: true,
    });
    expect(getDebugMatchStatus(SERVICE_MATCH_ID).updatedAt).toBe(3_000);
  });

  it('每个 match/seat 复用唯一 coordinator，并拒绝同席位并发决策', async () => {
    startDebugMatch(CONCURRENT_MATCH_ID);
    let releaseDecision!: (decision: AiDecisionV2) => void;
    let markStarted!: () => void;
    let pendingRequest!: AiDecisionRequestV2;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const decide = vi
      .spyOn(deterministicDebugAiProvider, 'decide')
      .mockImplementation(async (request) => {
        pendingRequest = request;
        markStarted();
        return await new Promise<AiDecisionV2>((resolve) => {
          releaseDecision = resolve;
        });
      });
    vi.spyOn(debugAiProviderModule, 'createDeterministicDebugAiProvider').mockReturnValue(
      deterministicDebugAiProvider
    );

    const first = executeDebugMatchAiTurn(CONCURRENT_MATCH_ID, 'FIRST');
    await started;
    const concurrent = await executeDebugMatchAiTurn(CONCURRENT_MATCH_ID, 'FIRST');

    expect(concurrent.success).toBe(false);
    expect(concurrent.error).toContain('正在进行');
    expect(decide).toHaveBeenCalledTimes(1);

    releaseDecision(createFullMulliganDecision(pendingRequest));
    await expect(first).resolves.toEqual({ success: true });
  });

  it('重置并以相同 matchId 重建后不会复用旧会话协调器', async () => {
    startDebugMatch(RECREATED_MATCH_ID);
    await expect(executeDebugMatchAiTurn(RECREATED_MATCH_ID, 'FIRST')).resolves.toEqual({
      success: true,
    });

    resetDebugMatch(RECREATED_MATCH_ID);
    startDebugMatch(RECREATED_MATCH_ID);
    const replacementBefore = getDebugMatchSnapshot(RECREATED_MATCH_ID, 'FIRST');

    await expect(executeDebugMatchAiTurn(RECREATED_MATCH_ID, 'FIRST')).resolves.toEqual({
      success: true,
    });
    const replacementAfter = getDebugMatchSnapshot(RECREATED_MATCH_ID, 'FIRST');
    expect(replacementAfter?.seq).toBe((replacementBefore?.seq ?? 0) + 1);
    expect(replacementAfter?.playerViewState.match.subPhase).toBe(SubPhase.MULLIGAN_SECOND_PLAYER);
  });

  it('AI 决策在途时重置重建，不会把旧会话结果提交到新会话', async () => {
    startDebugMatch(RESET_IN_FLIGHT_MATCH_ID);
    let releaseDecision!: (decision: AiDecisionV2) => void;
    let markStarted!: () => void;
    let pendingRequest!: AiDecisionRequestV2;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    vi.spyOn(deterministicDebugAiProvider, 'decide').mockImplementation(async (request) => {
      pendingRequest = request;
      markStarted();
      return await new Promise<AiDecisionV2>((resolve) => {
        releaseDecision = resolve;
      });
    });
    vi.spyOn(debugAiProviderModule, 'createDeterministicDebugAiProvider').mockReturnValue(
      deterministicDebugAiProvider
    );

    const staleTurn = executeDebugMatchAiTurn(RESET_IN_FLIGHT_MATCH_ID, 'FIRST');
    await started;
    resetDebugMatch(RESET_IN_FLIGHT_MATCH_ID);
    startDebugMatch(RESET_IN_FLIGHT_MATCH_ID);
    const replacementBefore = getDebugMatchSnapshot(RESET_IN_FLIGHT_MATCH_ID, 'FIRST');

    releaseDecision(createFullMulliganDecision(pendingRequest));

    await expect(staleTurn).resolves.toEqual({
      success: false,
      error: 'AI 决策期间调试对局已变更',
    });
    const replacementAfter = getDebugMatchSnapshot(RESET_IN_FLIGHT_MATCH_ID, 'FIRST');
    expect(replacementAfter?.seq).toBe(replacementBefore?.seq);
    expect(replacementAfter?.playerViewState.match.subPhase).toBe(
      replacementBefore?.playerViewState.match.subPhase
    );
  });
});

describe('remote debug AI turn route', () => {
  it('只从 aiSeat 决定执行席位，不返回 AI 私有视角快照', async () => {
    startDebugMatch(ROUTE_MATCH_ID);
    const response = await invokeAiTurnRoute({
      params: { matchId: ROUTE_MATCH_ID },
      body: {
        aiSeat: 'FIRST',
        command: { type: 'FORGED_COMMAND' },
        provider: { selectedCardTokens: [] },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      data: { success: true },
      error: null,
    });
    expect(getDebugMatchSnapshot(ROUTE_MATCH_ID, 'FIRST')?.playerViewState.match.subPhase).toBe(
      SubPhase.MULLIGAN_SECOND_PLAYER
    );
  });

  it('拒绝缺少 aiSeat 或非法席位', async () => {
    for (const body of [{ seat: 'FIRST' }, { aiSeat: 'THIRD' }, undefined]) {
      const response = await invokeAiTurnRoute({
        params: { matchId: ROUTE_MATCH_ID },
        body,
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).toEqual({
        data: null,
        error: { code: 'INVALID_REQUEST', message: 'AI 席位参数非法' },
      });
    }
  });
});

function createFullMulliganDecision(request: AiDecisionRequestV2): AiDecisionV2 {
  if (request.window.kind !== 'MULLIGAN') {
    throw new Error('测试前置条件失败：当前不是换牌决策');
  }
  return {
    schemaVersion: request.schemaVersion,
    decisionId: request.decisionId,
    contextDigest: request.contextDigest,
    kind: 'MULLIGAN',
    selectedCardTokens: request.window.candidates.map((candidate) => candidate.token),
  };
}

type DebugMainActionCandidateKind = 'END' | 'SINGLE_RELAY' | 'EMPTY_SLOT' | 'ACTIVATED';

function createMainActionCandidates(
  ...kinds: readonly DebugMainActionCandidateKind[]
): readonly AiMainActionCandidateV2[] {
  return kinds.map((kind): AiMainActionCandidateV2 => {
    switch (kind) {
      case 'ACTIVATED':
        return {
          actionToken: 'action-activate',
          kind: 'ACTIVATE_ABILITY',
          legality: 'DECLARATION_ONLY',
          sourceSlot: SlotPosition.LEFT,
          abilityText: '支付 2 能量，处理来源成员的起动能力',
        };
      case 'EMPTY_SLOT':
        return {
          actionToken: 'action-empty',
          kind: 'PLAY_MEMBER_TO_EMPTY_SLOT',
          sourceHandToken: 'hand-1',
          targetSlot: SlotPosition.LEFT,
          payment: { modifiedCost: 1, energyCost: 1, relayDiscount: 0 },
        };
      case 'SINGLE_RELAY':
        return {
          actionToken: 'action-relay',
          kind: 'PLAY_MEMBER_WITH_SINGLE_RELAY',
          sourceHandToken: 'hand-2',
          targetSlot: SlotPosition.CENTER,
          payment: { modifiedCost: 4, energyCost: 2, relayDiscount: 2 },
        };
      case 'END':
        return { actionToken: 'action-end', kind: 'END_MAIN_PHASE' };
    }
  });
}

function createMainActionRequest(
  candidates: readonly AiMainActionCandidateV2[]
): AiMainActionDecisionRequestDraftV2 & { readonly contextDigest: string } {
  return {
    schemaVersion: 2,
    decisionId: 'debug-main-action-decision',
    contextDigest: 'sha256:debug-main-action-context',
    observation: {
      match: {
        viewerSeat: 'FIRST',
        turnCount: 1,
        phase: GamePhase.MAIN_PHASE,
        subPhase: SubPhase.NONE,
        firstSeat: 'FIRST',
        activeSeat: 'FIRST',
        prioritySeat: 'FIRST',
        publicSequence: 1,
        window: null,
      },
      zoneCounts: [],
      self: {
        hand: [],
        stage: [
          { slot: SlotPosition.LEFT, member: null },
          { slot: SlotPosition.CENTER, member: null },
          { slot: SlotPosition.RIGHT, member: null },
        ],
        energy: { activeCount: 3, totalCount: 3 },
      },
    },
    window: {
      kind: 'MAIN_ACTION',
      minSelections: 1,
      maxSelections: 1,
      candidates,
    },
  };
}

function createCardSelectionRequest(
  overrides: Partial<AiEffectCardSelectionWindowV2> = {}
): AiEffectCardSelectionRequestDraftV2 & { readonly contextDigest: string } {
  return {
    ...createMainActionRequest([]),
    decisionId: 'debug-card-selection-decision',
    contextDigest: 'sha256:debug-card-selection-context',
    window: {
      kind: 'EFFECT_CARD_SELECTION',
      legality: 'DECLARATION_ONLY',
      minSelections: 2,
      maxSelections: 2,
      ordered: true,
      canSkip: false,
      sourceCard: null,
      controllerSeat: 'FIRST',
      effectText: '测试多选效果',
      stepText: '按顺序选择卡牌',
      candidates: ['card-z', 'card-a', 'card-b'].map((cardToken) => ({
        cardToken,
        card: { cardCode: 'DEBUG-SELECTION', cardType: CardType.MEMBER },
        ownerSeat: 'FIRST',
      })),
      distinctGroupAssignment: false,
      rejectedSelections: [],
      ...overrides,
    },
  };
}

function createEffectStepRequest(
  candidates: readonly AiEffectStepCandidateV2[]
): AiDecisionRequestV2 {
  const baseRequest = createMainActionRequest([]);
  return {
    ...baseRequest,
    decisionId: 'debug-effect-step-decision',
    contextDigest: 'sha256:debug-effect-step-context',
    window: {
      kind: 'EFFECT_STEP',
      minSelections: 1,
      maxSelections: 1,
      sourceCard: null,
      controllerSeat: 'FIRST',
      effectText: '测试卡效',
      stepText: '选择当前一步',
      candidates,
    },
  };
}

function createLiveActionRequest(
  candidates: readonly AiLiveActionCandidateV2[],
  ownLiveCards: AiLiveActionObservationV2['live']['players'][number]['liveCards'] = [],
  opponentLiveCards: AiLiveActionObservationV2['live']['players'][number]['liveCards'] = []
): AiLiveActionDecisionRequestDraftV2 & { readonly contextDigest: string } {
  const base = createMainActionRequest([]);
  return {
    ...base,
    decisionId: 'debug-live-action-decision',
    contextDigest: 'sha256:debug-live-action-context',
    observation: {
      ...base.observation,
      self: {
        ...base.observation.self,
        hand: [
          {
            handToken: 'hand-member',
            card: { cardCode: 'DEBUG-MEMBER', cardType: CardType.MEMBER, cost: 1 },
          },
          {
            handToken: 'hand-live',
            card: { cardCode: 'DEBUG-LIVE', cardType: CardType.LIVE, score: 1 },
          },
        ],
      },
      live: {
        players: (['FIRST', 'SECOND'] as const).map((seat) => ({
          seat,
          stage: base.observation.self.stage,
          energy: base.observation.self.energy,
          liveCards: seat === 'FIRST' ? ownLiveCards : opponentLiveCards,
          score: 0,
          scoreModifier: 0,
          heartBonuses: [],
        })),
        winnerSeats: [],
        confirmedSeats: [],
      },
    },
    window: { kind: 'LIVE_ACTION', minSelections: 1, maxSelections: 1, candidates },
  };
}

function countStageMembers(playerViewState: PlayerViewState | undefined): number {
  if (!playerViewState) {
    return 0;
  }
  return (
    playerViewState.table.zones.FIRST_MEMBER_LEFT.count +
    playerViewState.table.zones.FIRST_MEMBER_CENTER.count +
    playerViewState.table.zones.FIRST_MEMBER_RIGHT.count
  );
}

function startDebugMatch(matchId: string, deck: DeckConfig = createDeck()): void {
  selectDebugSeatDeck({
    matchId,
    seat: 'FIRST',
    playerName: 'Alpha',
    deckName: 'A',
    deck,
  });
  selectDebugSeatDeck({
    matchId,
    seat: 'SECOND',
    playerName: 'Beta',
    deckName: 'B',
    deck,
  });
}

function createMemberOnlyDeck(): DeckConfig {
  const mainDeck: MemberCardData[] = [];
  const energyDeck: EnergyCardData[] = [];
  for (let index = 0; index < 60; index += 1) {
    mainDeck.push({
      cardCode: `DEBUG-AI-MEMBER-ONLY-${index}`,
      name: `纯成员调试 ${index}`,
      cardType: CardType.MEMBER,
      cost: 1,
      blade: 1,
      hearts: [createHeartIcon(HeartColor.PINK, 1)],
    });
  }
  for (let index = 0; index < 12; index += 1) {
    energyDeck.push({
      cardCode: `DEBUG-AI-ENERGY-ONLY-${index}`,
      name: `纯成员调试能量 ${index}`,
      cardType: CardType.ENERGY,
    });
  }
  return { mainDeck, energyDeck };
}

function createDeck(): DeckConfig {
  const mainDeck: Array<MemberCardData | LiveCardData> = [];
  const energyDeck: EnergyCardData[] = [];
  for (let index = 0; index < 48; index += 1) {
    mainDeck.push({
      cardCode: `DEBUG-AI-MEMBER-${index}`,
      name: `调试成员 ${index}`,
      cardType: CardType.MEMBER,
      cost: 1,
      blade: 1,
      hearts: [createHeartIcon(HeartColor.PINK, 1)],
    });
  }
  for (let index = 0; index < 12; index += 1) {
    mainDeck.push({
      cardCode: `DEBUG-AI-LIVE-${index}`,
      name: `调试 LIVE ${index}`,
      cardType: CardType.LIVE,
      score: 1,
      requirements: createHeartRequirement({ [HeartColor.PINK]: 1 }),
    });
    energyDeck.push({
      cardCode: `DEBUG-AI-ENERGY-${index}`,
      name: `调试能量 ${index}`,
      cardType: CardType.ENERGY,
    });
  }
  return { mainDeck, energyDeck };
}

function findAiTurnRouteHandler() {
  const layers = debugOnlineRouter.stack as unknown as Array<{
    route?: {
      path?: string;
      methods?: Record<string, boolean>;
      stack: Array<{ handle: (req: Request, res: Response) => void | Promise<void> }>;
    };
  }>;
  const layer = layers.find(
    (candidate) =>
      candidate.route?.path === '/matches/:matchId/ai-turn' && candidate.route.methods?.post
  );
  if (!layer?.route) {
    throw new Error('Route not found: POST /matches/:matchId/ai-turn');
  }
  return layer.route.stack.at(-1)?.handle as (req: Request, res: Response) => void | Promise<void>;
}

async function invokeAiTurnRoute(options: Partial<Request>) {
  const response = createMockResponse();
  const request = {
    params: {},
    body: undefined,
    ...options,
  } as Request;
  await findAiTurnRouteHandler()(request, response);
  return response;
}

function createMockResponse() {
  const response = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return response as Response & {
    statusCode: number;
    body: {
      data: unknown;
      error: { code: string; message: string } | null;
    } | null;
  };
}
