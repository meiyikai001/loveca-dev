import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AiDecisionProviderV2,
  AiDecisionRequestV2,
  AiDecisionV2,
} from '../../src/application/ai/ai-decision-contract';
import { GameCommandType, type GameCommand } from '../../src/application/game-commands';
import { GameSession } from '../../src/application/game-session';
import type { DeckConfig } from '../../src/application/game-service';
import {
  createHeartIcon,
  createHeartRequirement,
  type EnergyCardData,
  type LiveCardData,
  type MemberCardData,
} from '../../src/domain/entities/card';
import { runAiSelfPlay } from '../../src/server/services/ai-self-play-runner';
import { createDeterministicDebugAiProvider } from '../../src/server/services/deterministic-debug-ai-provider';
import { CardType, GamePhase, HeartColor } from '../../src/shared/types/enums';

type Report = Awaited<ReturnType<typeof runAiSelfPlay>>;
type RunOptions = Parameters<typeof runAiSelfPlay>[0];
type Seat = 'FIRST' | 'SECOND';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function member(cardCode: string, cost = 1): MemberCardData {
  return {
    cardCode,
    name: cardCode,
    cardType: CardType.MEMBER,
    cost,
    blade: 1,
    hearts: [createHeartIcon(HeartColor.GREEN, 4)],
    groupNames: ['蓮ノ空女学院スクールアイドルクラブ'],
    cardText: 'PRIVATE-CARD-TEXT-NOT-FOR-REPORT',
  };
}

/** Complete in-memory card snapshots, not a card database or an account-owned deck. */
function deck(
  prefix: string,
  score: number,
  options: {
    source?: MemberCardData;
    helperCost?: number;
    inspectionTarget?: MemberCardData;
  } = {}
): DeckConfig {
  const members = Array.from({ length: 48 }, (_, index) =>
    index === 0 && options.source
      ? options.source
      : member(`${prefix}-member${index}-P`, options.helperCost)
  );
  const lives: LiveCardData[] = Array.from({ length: 12 }, (_, index) => ({
    cardCode: `${prefix}-live${index}-L`,
    name: `${prefix} LIVE ${index}`,
    cardType: CardType.LIVE,
    score,
    requirements: createHeartRequirement({ [HeartColor.GREEN]: 1 }),
  }));
  const mainDeck = [
    members[0]!,
    lives[0]!,
    lives[1]!,
    lives[2]!,
    ...members.slice(1),
    ...lives.slice(3),
  ];
  if (options.inspectionTarget) mainDeck[7] = options.inspectionTarget;
  const energyDeck: EnergyCardData[] = Array.from({ length: 12 }, (_, index) => ({
    cardCode: `${prefix}-energy${index}`,
    name: `Energy ${index}`,
    cardType: CardType.ENERGY,
  }));
  return { mainDeck, energyDeck };
}

function keepOpening(request: AiDecisionRequestV2): AiDecisionV2 {
  if (request.window.kind !== 'MULLIGAN') throw new Error('Expected opening request');
  return {
    schemaVersion: request.schemaVersion,
    decisionId: request.decisionId,
    contextDigest: request.contextDigest,
    kind: 'MULLIGAN',
    selectedCardTokens: [],
  };
}

function policy(requests: AiDecisionRequestV2[] = []): AiDecisionProviderV2 {
  const delegate = createDeterministicDebugAiProvider();
  return {
    decide(request, signal) {
      requests.push(request);
      return request.window.kind === 'MULLIGAN'
        ? Promise.resolve(keepOpening(request))
        : delegate.decide(request, signal);
    },
  };
}

function options(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    firstDeck: deck('FIRST-PRIVATE-DECK', 2),
    secondDeck: deck('SECOND-PRIVATE-DECK', 1),
    providers: { FIRST: policy(), SECOND: policy() },
    randomInt: (maxExclusive) => maxExclusive - 1,
    maxSteps: 250,
    maxTurns: 8,
    maxWallTimeMs: 10_000,
    ...overrides,
  };
}

function assertReportHasNoPrivateState(report: Report, commands: readonly GameCommand[] = []) {
  expect(Object.keys(report).sort()).toEqual(
    [
      'blocker',
      'final',
      'providerTimeMs',
      'schemaVersion',
      'status',
      'steps',
      'stopReason',
      'virtualWaitMs',
      'wallTimeMs',
    ].sort()
  );
  const wire = JSON.stringify(report);
  for (const forbidden of [
    'FIRST-PRIVATE-DECK',
    'SECOND-PRIVATE-DECK',
    'PRIVATE-CARD-TEXT-NOT-FOR-REPORT',
    'cardRegistry',
    'authorityState',
    'selectedCardIds',
    'selectedActionToken',
    'contextDigest',
    'sourceCardId',
    'abilityId',
    'playerId',
  ])
    expect(wire).not.toContain(forbidden);
  for (const command of commands) {
    expect(wire).not.toContain(command.playerId);
    if (command.type === GameCommandType.PLAY_MEMBER_TO_SLOT)
      expect(wire).not.toContain(command.cardId);
  }
}

function sourceThenStopPolicy(sourceCode: string, activate: boolean): AiDecisionProviderV2 {
  const delegate = createDeterministicDebugAiProvider();
  let played = false;
  let activated = false;
  return {
    decide(request, signal) {
      if (request.window.kind === 'MULLIGAN') return Promise.resolve(keepOpening(request));
      if (request.window.kind !== 'MAIN_ACTION') return delegate.decide(request, signal);
      if (!('self' in request.observation)) throw new Error('Missing self observation');
      const observation = request.observation;
      const candidates = request.window.candidates;
      const sourcePlay = candidates.find(
        (candidate) =>
          (candidate.kind === 'PLAY_MEMBER_TO_EMPTY_SLOT' ||
            candidate.kind === 'PLAY_MEMBER_WITH_SINGLE_RELAY') &&
          observation.self.hand.find((entry) => entry.handToken === candidate.sourceHandToken)?.card
            .cardCode === sourceCode
      );
      const activation =
        activate && played && !activated
          ? candidates.find((candidate) => candidate.kind === 'ACTIVATE_ABILITY')
          : undefined;
      if (played && !activation) return Promise.resolve(null);
      const helper = !observation.self.stage.some((slot) => slot.member !== null)
        ? candidates.find((candidate) => candidate.kind === 'PLAY_MEMBER_TO_EMPTY_SLOT')
        : undefined;
      const chosen =
        sourcePlay ??
        activation ??
        helper ??
        candidates.find((candidate) => candidate.kind === 'END_MAIN_PHASE');
      if (!chosen) throw new Error('No setup action');
      if (chosen === sourcePlay) played = true;
      if (chosen === activation) activated = true;
      return Promise.resolve({
        schemaVersion: request.schemaVersion,
        decisionId: request.decisionId,
        contextDigest: request.contextDigest,
        kind: 'MAIN_ACTION',
        selectedActionToken: chosen.actionToken,
      });
    },
  };
}

describe('headless AI self-play runner through real authority commands', () => {
  it('从双方换牌到第三张成功 LIVE 自然终局，报告只包含匿名摘要', async () => {
    const requests: Record<Seat, AiDecisionRequestV2[]> = { FIRST: [], SECOND: [] };
    const execute = vi.spyOn(GameSession.prototype, 'executeCommand');
    const report = await runAiSelfPlay(
      options({ providers: { FIRST: policy(requests.FIRST), SECOND: policy(requests.SECOND) } })
    );
    expect(report).toMatchObject({
      schemaVersion: 1,
      status: 'COMPLETED',
      stopReason: 'GAME_END',
      blocker: null,
      final: {
        turnCount: 3,
        successCounts: { FIRST: 3, SECOND: 0 },
        winnerSeat: 'FIRST',
        endReason: 'VICTORY_CONDITION',
      },
    });
    expect(report.steps).toHaveLength(74);
    expect(execute).toHaveBeenCalledTimes(74);
    expect(report.steps.filter((step) => step.kind === 'MULLIGAN')).toHaveLength(2);
    expect(report.steps.filter((step) => step.kind === 'LIVE_ACTION')).toHaveLength(50);
    expect(new Set(report.steps.map((step) => step.actor))).toEqual(new Set(['FIRST', 'SECOND']));
    expect(report.steps.every((step) => step.status === 'EXECUTED')).toBe(true);
    for (const seat of ['FIRST', 'SECOND'] as const) {
      expect(requests[seat].length).toBeGreaterThan(0);
      expect(requests[seat].every((request) => request.observation.match.viewerSeat === seat)).toBe(
        true
      );
    }
    expect(report.virtualWaitMs).toBe(0);
    expect(report.wallTimeMs).toBeGreaterThanOrEqual(0);
    expect(report.providerTimeMs).toBeGreaterThanOrEqual(0);
    assertReportHasNoPrivateState(
      report,
      execute.mock.calls.map(([command]) => command)
    );
  });

  it('不提供 provider 时可用默认独立策略执行真实换牌，并服从步数预算', async () => {
    const execute = vi.spyOn(GameSession.prototype, 'executeCommand');
    const report = await runAiSelfPlay(options({ providers: undefined, maxSteps: 2 }));
    expect(report).toMatchObject({ status: 'LIMIT_REACHED', stopReason: 'MAX_STEPS' });
    expect(report.steps).toHaveLength(2);
    expect(execute.mock.calls.map(([command]) => command.type)).toEqual([
      GameCommandType.MULLIGAN,
      GameCommandType.MULLIGAN,
    ]);
  });

  it('当前玩家返回 null 时停止，不偷偷改由另一席推进', async () => {
    const first = vi.fn<AiDecisionProviderV2['decide']>(() => Promise.resolve(null));
    const second = vi.fn<AiDecisionProviderV2['decide']>(() => Promise.resolve(null));
    const execute = vi.spyOn(GameSession.prototype, 'executeCommand');
    const report = await runAiSelfPlay(
      options({ providers: { FIRST: { decide: first }, SECOND: { decide: second } } })
    );
    expect(report).toMatchObject({ status: 'BLOCKED', stopReason: 'NO_DECISION' });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]).toMatchObject({
      actor: 'FIRST',
      kind: 'MULLIGAN',
      status: 'NO_DECISION',
      commandType: null,
    });
  });

  it('provider 异常立即终止，不把异常携带的隐藏内容写入报告', async () => {
    const first = vi.fn<AiDecisionProviderV2['decide']>(() => {
      throw new Error('PRIVATE-PROVIDER-ERROR-SECRET');
    });
    const execute = vi.spyOn(GameSession.prototype, 'executeCommand');
    const report = await runAiSelfPlay(
      options({ providers: { FIRST: { decide: first }, SECOND: policy() } })
    );
    expect(report).toMatchObject({ status: 'ERROR', stopReason: 'PROVIDER_ERROR' });
    expect(first).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain('PRIVATE-PROVIDER-ERROR-SECRET');
    assertReportHasNoPrivateState(report);
  });

  it('超时取消 provider，迟到响应不能执行命令', async () => {
    vi.useFakeTimers();
    let release!: (decision: AiDecisionV2) => void;
    let request!: AiDecisionRequestV2;
    let providerSignal!: AbortSignal;
    const execute = vi.spyOn(GameSession.prototype, 'executeCommand');
    const pending = runAiSelfPlay(
      options({
        decisionTimeoutMs: 5,
        providers: {
          FIRST: {
            decide(received, signal) {
              request = received;
              providerSignal = signal;
              return new Promise<AiDecisionV2>((resolve) => {
                release = resolve;
              });
            },
          },
          SECOND: policy(),
        },
      })
    );
    await vi.advanceTimersByTimeAsync(6);
    const report = await pending;
    expect(report).toMatchObject({ status: 'BLOCKED', stopReason: 'DECISION_TIMEOUT' });
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]).toMatchObject({ actor: 'FIRST', status: 'TIMEOUT' });
    expect(providerSignal.aborted).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    release(keepOpening(request));
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('开始前已取消时不向 provider 请求也不执行命令', async () => {
    const signal = AbortSignal.abort();
    const decide = vi.fn<AiDecisionProviderV2['decide']>();
    const execute = vi.spyOn(GameSession.prototype, 'executeCommand');
    const report = await runAiSelfPlay(
      options({ signal, providers: { FIRST: { decide }, SECOND: { decide } } })
    );
    expect(report).toMatchObject({ status: 'ABORTED', stopReason: 'ABORTED', steps: [] });
    expect(decide).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('在途取消会中止等待，迟到响应仍不能推进', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: (decision: AiDecisionV2) => void;
    let request!: AiDecisionRequestV2;
    let providerSignal!: AbortSignal;
    const execute = vi.spyOn(GameSession.prototype, 'executeCommand');
    const pending = runAiSelfPlay(
      options({
        signal: controller.signal,
        providers: {
          FIRST: {
            decide(received, signal) {
              request = received;
              providerSignal = signal;
              started();
              return new Promise<AiDecisionV2>((resolve) => {
                release = resolve;
              });
            },
          },
          SECOND: policy(),
        },
      })
    );
    await ready;
    controller.abort();
    const report = await pending;
    expect(report).toMatchObject({ status: 'ABORTED', stopReason: 'ABORTED' });
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]).toMatchObject({ actor: 'FIRST', status: 'ABORTED' });
    expect(providerSignal.aborted).toBe(true);
    release(keepOpening(request));
    await Promise.resolve();
    expect(execute).not.toHaveBeenCalled();
  });

  it('步数和回合上限以真实进度停止，不伪造终局', async () => {
    const oneStep = await runAiSelfPlay(options({ maxSteps: 1 }));
    expect(oneStep).toMatchObject({
      status: 'LIMIT_REACHED',
      stopReason: 'MAX_STEPS',
      final: { winnerSeat: null, endReason: null },
    });
    expect(oneStep.steps).toHaveLength(1);
    const oneTurn = await runAiSelfPlay(options({ maxTurns: 1 }));
    expect(oneTurn).toMatchObject({
      status: 'LIMIT_REACHED',
      stopReason: 'MAX_TURNS',
      final: { winnerSeat: null, endReason: null },
    });
    expect(oneTurn.final!.successCounts).toEqual({ FIRST: 1, SECOND: 0 });
    expect(oneTurn.final!.turnCount).toBe(2);
  });

  it('总墙钟预算可以早于 provider 自身超时中止在途等待', async () => {
    vi.useFakeTimers();
    let providerSignal!: AbortSignal;
    const pending = runAiSelfPlay(
      options({
        maxWallTimeMs: 5,
        decisionTimeoutMs: 100,
        providers: {
          FIRST: {
            decide(_request, signal) {
              providerSignal = signal;
              return new Promise<AiDecisionV2>(() => {});
            },
          },
          SECOND: policy(),
        },
      })
    );
    await vi.advanceTimersByTimeAsync(6);
    const report = await pending;
    expect(report).toMatchObject({ status: 'LIMIT_REACHED', stopReason: 'MAX_WALL_TIME' });
    expect(report.steps).toHaveLength(1);
    expect(providerSignal.aborted).toBe(true);
  });

  it('重复恶意响应受连续拒绝预算约束，不能无限请求或执行伪造命令', async () => {
    const decide = vi.fn<AiDecisionProviderV2['decide']>((request) =>
      Promise.resolve({ ...keepOpening(request), selectedCardTokens: ['private-forged-token'] })
    );
    const execute = vi.spyOn(GameSession.prototype, 'executeCommand');
    const report = await runAiSelfPlay(
      options({ maxConsecutiveRejections: 3, providers: { FIRST: { decide }, SECOND: policy() } })
    );
    expect(report).toMatchObject({ status: 'BLOCKED', stopReason: 'REJECTION_LIMIT' });
    expect(decide).toHaveBeenCalledTimes(3);
    expect(execute).not.toHaveBeenCalled();
    expect(report.steps).toHaveLength(3);
    expect(report.steps.every((step) => step.status === 'REJECTED')).toBe(true);
    expect(JSON.stringify(report)).not.toContain('private-forged-token');
  });

  it.each([
    {
      name: '2 费绚濑绘里自送回收',
      source: member('PL!-sd1-002-SD', 2),
      kind: 'PUBLIC_CARD_SELECTION',
      activate: true,
      helperCost: 1,
    },
    {
      name: '4 费桂城泉弃牌检视并公开加入手牌',
      source: member('PL!HS-bp5-008-R', 4),
      kind: 'PUBLIC_REVEAL',
      activate: false,
      helperCost: 1,
    },
    {
      name: '9 费星空凛登场选择抽弃分支',
      source: member('PL!-PR-005-PR', 9),
      kind: 'PUBLIC_EFFECT_CHOICE',
      activate: false,
      helperCost: 4,
    },
  ] as const)(
    '$name 的真实公开计时由 SYSTEM 推进后继续原效果',
    async ({ source, kind, activate, helperCost }) => {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Called below with the actual session as this.
      const originalExecute = GameSession.prototype.executeCommand;
      const timers: { kind: string; command: GameCommand; success: boolean; phase: GamePhase }[] =
        [];
      const execute = vi
        .spyOn(GameSession.prototype, 'executeCommand')
        .mockImplementation(function (this: GameSession, command) {
          const effect = this.state?.activeEffect;
          const timerKind =
            effect?.publicRevealAutoAdvanceAt !== undefined
              ? 'PUBLIC_REVEAL'
              : effect?.publicCardSelectionAutoAdvanceAt !== undefined
                ? 'PUBLIC_CARD_SELECTION'
                : effect?.publicEffectChoiceAutoAdvanceAt !== undefined
                  ? 'PUBLIC_EFFECT_CHOICE'
                  : null;
          const result = originalExecute.call(this, command);
          if (timerKind)
            timers.push({
              kind: timerKind,
              command,
              success: result.success,
              phase: this.state!.currentPhase,
            });
          return result;
        });
      const report = await runAiSelfPlay(
        options({
          firstDeck: deck('FIRST-PRIVATE-DECK', 2, {
            source,
            helperCost,
            inspectionTarget: member('PRIVATE-HIGH-COST-TARGET', 9),
          }),
          providers: { FIRST: sourceThenStopPolicy(source.cardCode, activate), SECOND: policy() },
        })
      );
      expect(report).toMatchObject({ status: 'BLOCKED', stopReason: 'NO_DECISION' });
      const timerSteps = report.steps.filter((step) => step.kind === kind);
      expect(timerSteps).toHaveLength(1);
      expect(timerSteps[0]).toMatchObject({
        actor: 'SYSTEM',
        status: 'EXECUTED',
        commandType: GameCommandType.CONFIRM_EFFECT_STEP,
        providerMs: 0,
      });
      expect(timerSteps[0]!.virtualWaitMs).toBeGreaterThan(0);
      expect(report.virtualWaitMs).toBe(timerSteps[0]!.virtualWaitMs);
      expect(timers).toHaveLength(1);
      expect(timers[0]).toMatchObject({ kind, success: true, phase: GamePhase.MAIN_PHASE });
      expect(report.steps.at(-1)).toMatchObject({
        actor: 'FIRST',
        kind: 'MAIN_ACTION',
        status: 'NO_DECISION',
      });
      assertReportHasNoPrivateState(
        report,
        execute.mock.calls.map(([command]) => command)
      );
    }
  );

  it.each(['reject', 'throw'] as const)(
    '真实公开回收自动推进 %s 时立即停止，不重复该命令',
    async (failure) => {
      const source = member('PL!-sd1-002-SD', 2);
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Called below with the actual session as this.
      const originalExecute = GameSession.prototype.executeCommand;
      let timerAttempts = 0;
      vi.spyOn(GameSession.prototype, 'executeCommand').mockImplementation(function (
        this: GameSession,
        command
      ) {
        if (this.state!.activeEffect?.publicCardSelectionAutoAdvanceAt !== undefined) {
          timerAttempts++;
          if (failure === 'throw') throw new Error('PRIVATE-TIMER-FAILURE');
          return { success: false, gameState: this.state!, error: 'PRIVATE-TIMER-FAILURE' };
        }
        return originalExecute.call(this, command);
      });
      const report = await runAiSelfPlay(
        options({
          firstDeck: deck('FIRST-PRIVATE-DECK', 2, { source }),
          providers: { FIRST: sourceThenStopPolicy(source.cardCode, true), SECOND: policy() },
        })
      );
      expect(report).toMatchObject({
        status: 'ERROR',
        stopReason: 'TIMER_REJECTED',
        blocker: { pending: 'EFFECT' },
      });
      expect(timerAttempts).toBe(1);
      expect(report.steps.at(-1)).toMatchObject({
        actor: 'SYSTEM',
        kind: 'PUBLIC_CARD_SELECTION',
        status: failure === 'throw' ? 'ERROR' : 'REJECTED',
      });
      expect(JSON.stringify(report)).not.toContain('PRIVATE-TIMER-FAILURE');
    }
  );

  it('权威命令抛异常后立即暂停，不重试或暴露异常正文', async () => {
    const execute = vi.spyOn(GameSession.prototype, 'executeCommand').mockImplementationOnce(() => {
      throw new Error('PRIVATE-ENGINE-FAILURE');
    });
    const report = await runAiSelfPlay(options());
    expect(report).toMatchObject({ status: 'ERROR', stopReason: 'EXECUTION_FAULT' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(report.steps).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain('PRIVATE-ENGINE-FAILURE');
  });

  it('权威边界误报成功但局面未前进时不能继续空转', async () => {
    const execute = vi
      .spyOn(GameSession.prototype, 'executeCommand')
      .mockImplementationOnce(function (this: GameSession) {
        return { success: true, gameState: this.state! };
      });
    const report = await runAiSelfPlay(options());
    expect(report).toMatchObject({ status: 'ERROR', stopReason: 'NO_PROGRESS' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(report.steps).toHaveLength(1);
  });

  it('15 费藤岛慈真实登场进入站位变换时报告不支持形状，不绕过效果', async () => {
    const source = member('PL!HS-bp2-006-P', 15);
    const noWinningLive = (configured: DeckConfig): DeckConfig => ({
      ...configured,
      mainDeck: configured.mainDeck.map((card) =>
        card.cardType === CardType.LIVE
          ? { ...card, requirements: createHeartRequirement({ [HeartColor.GREEN]: 100 }) }
          : card
      ),
    });
    const report = await runAiSelfPlay(
      options({
        firstDeck: noWinningLive(deck('FIRST-PRIVATE-DECK', 2, { source, helperCost: 9 })),
        secondDeck: noWinningLive(deck('SECOND-PRIVATE-DECK', 1)),
        maxTurns: 15,
        maxSteps: 500,
      })
    );
    expect(report).toMatchObject({
      status: 'BLOCKED',
      stopReason: 'UNSUPPORTED_WINDOW',
      blocker: { pending: 'EFFECT', inputKinds: ['STAGE_FORMATION'] },
      final: { phase: GamePhase.MAIN_PHASE, winnerSeat: null, endReason: null },
    });
    assertReportHasNoPrivateState(report);
  });

  it.each([
    'maxSteps',
    'maxTurns',
    'maxWallTimeMs',
    'decisionTimeoutMs',
    'maxConsecutiveRejections',
  ] as const)('%s 拒绝非正整数设置', async (field) => {
    await expect(runAiSelfPlay(options({ [field]: 0 }))).rejects.toThrow();
    await expect(runAiSelfPlay(options({ [field]: 1.5 }))).rejects.toThrow();
  });
});
