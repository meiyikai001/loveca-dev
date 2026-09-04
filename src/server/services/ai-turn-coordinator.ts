import { createHash, randomUUID } from 'node:crypto';
import type { GameSession } from '../../application/game-session.js';
import type { GameState } from '../../domain/entities/game.js';
import { MAX_AI_REJECTED_EFFECT_SELECTIONS } from '../../application/ai/ai-effect-card-selection.js';
import {
  createEndPhaseCommand,
  createMulliganCommand,
  createPlayMemberToSlotCommand,
  GameCommandType,
  type GameCommand,
} from '../../application/game-commands.js';
import type {
  AiDecisionProviderV2,
  AiDecisionRequestV2,
} from '../../application/ai/ai-decision-contract.js';
import {
  buildAiDecisionFrameV2,
  finalizeAiDecisionFrameV2,
  resolveAiDecisionV2,
  type AiDecisionFrameV2,
} from '../../application/ai/ai-decision-frame.js';
import type {
  AiDecisionTraceHandle,
  AiDecisionTraceRecorder,
} from './ai-decision-trace-recorder.js';

const DEFAULT_DECISION_TIMEOUT_MS = 30_000;

export type AiTurnStepResult =
  | {
      readonly status: 'EXECUTED';
      readonly decisionId: string;
      readonly commandType:
        | GameCommandType.MULLIGAN
        | GameCommandType.PLAY_MEMBER_TO_SLOT
        | GameCommandType.ACTIVATE_ABILITY
        | GameCommandType.END_PHASE
        | GameCommandType.CONFIRM_EFFECT_STEP
        | GameCommandType.SET_LIVE_CARD
        | GameCommandType.CONFIRM_STEP
        | GameCommandType.SUBMIT_JUDGMENT
        | GameCommandType.SUBMIT_SCORE
        | GameCommandType.SELECT_SUCCESS_LIVE;
      readonly resultingPublicSequence: number;
    }
  | { readonly status: 'UNAVAILABLE'; readonly reason: string }
  | { readonly status: 'NO_DECISION'; readonly decisionId: string }
  | { readonly status: 'STALE'; readonly decisionId: string }
  | { readonly status: 'REJECTED'; readonly decisionId: string; readonly reason: string }
  | { readonly status: 'ABORTED'; readonly decisionId?: string }
  | { readonly status: 'TIMEOUT'; readonly decisionId: string }
  | { readonly status: 'PROVIDER_ERROR'; readonly decisionId: string; readonly reason: string };

export interface AiTurnCoordinatorOptions {
  readonly session: GameSession;
  readonly provider: AiDecisionProviderV2;
  readonly now?: () => number;
  readonly createDecisionId?: () => string;
  readonly decisionTimeoutMs?: number;
  /** Local self-play opt-in only; never included in normal turn results. */
  readonly traceRecorder?: AiDecisionTraceRecorder;
}

export class AiTurnCoordinator {
  private readonly session: GameSession;
  private readonly provider: AiDecisionProviderV2;
  private readonly now: () => number;
  private readonly createDecisionId: () => string;
  private readonly decisionTimeoutMs: number;
  private readonly traceRecorder: AiDecisionTraceRecorder | undefined;
  private readonly inFlightPlayerIds = new Set<string>();
  /** 只记住当前权威局面下实际拒绝的起动，不把一次拒绝变成永久卡牌限制。 */
  private rejectedState: GameState | null = null;
  private readonly rejectedActivationsByPlayer = new Map<string, Set<string>>();
  private readonly rejectedEffectSelectionsByPlayer = new Map<string, (readonly string[])[]>();
  /** 执行异常或失败却改变局面时停止，不能把不确定结果当作可安全重试。 */
  private executionFaultState: GameState | null = null;

  constructor(options: AiTurnCoordinatorOptions) {
    this.session = options.session;
    this.provider = options.provider;
    this.now = options.now ?? Date.now;
    this.createDecisionId = options.createDecisionId ?? randomUUID;
    this.traceRecorder = options.traceRecorder;
    const configuredTimeout = options.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
    this.decisionTimeoutMs =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? Math.floor(configuredTimeout)
        : DEFAULT_DECISION_TIMEOUT_MS;
  }

  async advanceOne(
    aiPlayerId: string,
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<AiTurnStepResult> {
    if (options.signal?.aborted) {
      return { status: 'ABORTED' };
    }
    if (this.inFlightPlayerIds.has(aiPlayerId)) {
      return { status: 'UNAVAILABLE', reason: '该 AI 席位已有正在进行的决策' };
    }

    this.inFlightPlayerIds.add(aiPlayerId);
    try {
      return await this.advanceOneExclusive(aiPlayerId, options.signal);
    } finally {
      this.inFlightPlayerIds.delete(aiPlayerId);
    }
  }

  private async advanceOneExclusive(
    aiPlayerId: string,
    externalSignal?: AbortSignal
  ): Promise<AiTurnStepResult> {
    if (this.executionFaultState && this.session.state === this.executionFaultState) {
      return { status: 'UNAVAILABLE', reason: '规则执行异常，AI 已暂停，请检查当前对局' };
    }
    let view;
    try {
      view = this.session.getPlayerViewState(aiPlayerId);
    } catch {
      return { status: 'UNAVAILABLE', reason: '游戏尚未开始或玩家不存在' };
    }
    if (!view) {
      return { status: 'UNAVAILABLE', reason: '游戏尚未开始或玩家不存在' };
    }

    const decisionId = `ai-${this.createDecisionId()}`;
    const buildResult = this.buildCurrentDecisionFrame(aiPlayerId, view, decisionId);
    if (!buildResult.ok) {
      return { status: 'UNAVAILABLE', reason: buildResult.reason };
    }
    const authorityStateAnchor = this.session.state;
    const trace = this.traceRecorder?.begin(buildResult.frame.request);
    try {
      const result = await this.advanceDecision(
        aiPlayerId,
        externalSignal,
        buildResult.frame,
        authorityStateAnchor,
        trace
      );
      trace?.finish(result);
      return result;
    } catch (error) {
      trace?.finish({ status: 'ERROR' });
      throw error;
    }
  }

  private async advanceDecision(
    aiPlayerId: string,
    externalSignal: AbortSignal | undefined,
    initialFrame: AiDecisionFrameV2,
    authorityStateAnchor: GameState | null,
    trace: AiDecisionTraceHandle | undefined
  ): Promise<AiTurnStepResult> {
    const decisionId = initialFrame.request.decisionId;
    const providerResult = await this.waitForProvider(initialFrame.request, externalSignal);
    if (externalSignal?.aborted) {
      return { status: 'ABORTED', decisionId };
    }
    if (providerResult.kind === 'ABORTED') {
      return { status: 'ABORTED', decisionId };
    }
    if (providerResult.kind === 'TIMEOUT') {
      return { status: 'TIMEOUT', decisionId };
    }
    if (providerResult.kind === 'ERROR') {
      return {
        status: 'PROVIDER_ERROR',
        decisionId,
        reason:
          providerResult.error instanceof Error
            ? providerResult.error.message
            : 'AI 决策器调用失败',
      };
    }

    let currentView;
    try {
      currentView = this.session.getPlayerViewState(aiPlayerId);
    } catch {
      return { status: 'STALE', decisionId };
    }
    if (!currentView) {
      return { status: 'STALE', decisionId };
    }
    // GameSession 被重开、恢复或任何权威提交后都会替换状态对象。这个仅执行侧
    // 可见的锚点阻止“新局恰好生成相同模型请求”的跨局 ABA，且不向 AI 泄露 gameId。
    if (this.session.state !== authorityStateAnchor) {
      return { status: 'STALE', decisionId };
    }
    const currentBuild = this.buildCurrentDecisionFrame(aiPlayerId, currentView, decisionId);
    if (!currentBuild.ok || !sameDecisionFrame(initialFrame, currentBuild.frame)) {
      return { status: 'STALE', decisionId };
    }

    const decision = providerResult.decision;
    if (!decision) {
      return { status: 'NO_DECISION', decisionId };
    }

    const resolution = resolveAiDecisionV2(currentBuild.frame, decision);
    if (!resolution.ok) {
      return { status: 'REJECTED', decisionId, reason: resolution.reason };
    }
    trace?.setChoice(currentBuild.frame, resolution);

    const command = createResolvedCommand(aiPlayerId, decisionId, resolution, this.now());
    const beforePublicSequence = this.session.getCurrentPublicEventSeq();
    let execution;
    try {
      // 这是模型已选择动作的一次真实执行，不是对候选进行试运行或回滚比较。
      execution = this.session.executeCommand(command);
    } catch {
      this.executionFaultState = this.session.state;
      return { status: 'UNAVAILABLE', reason: '规则执行异常，AI 已暂停，请检查当前对局' };
    }
    if (!execution.success) {
      if (
        this.session.state !== authorityStateAnchor ||
        this.session.getCurrentPublicEventSeq() !== beforePublicSequence
      ) {
        this.executionFaultState = this.session.state;
        return { status: 'UNAVAILABLE', reason: '命令失败但局面已变化，AI 已暂停，请检查当前对局' };
      }
      if (command.type === GameCommandType.ACTIVATE_ABILITY) {
        const rejected = this.rejectedActivationsByPlayer.get(aiPlayerId) ?? new Set<string>();
        rejected.add(activationKey(command.cardId, command.abilityId));
        this.rejectedActivationsByPlayer.set(aiPlayerId, rejected);
        return {
          status: 'REJECTED',
          decisionId,
          reason: '起动声明未执行，当前局面下不再重复申请该动作',
        };
      }
      if (
        command.type === GameCommandType.CONFIRM_EFFECT_STEP &&
        currentBuild.frame.request.window.kind === 'EFFECT_CARD_SELECTION'
      ) {
        if (command.selectedCardIds !== undefined) {
          const rejected = this.rejectedEffectSelectionsByPlayer.get(aiPlayerId) ?? [];
          rejected.push([...command.selectedCardIds]);
          this.rejectedEffectSelectionsByPlayer.set(aiPlayerId, rejected);
          return {
            status: 'REJECTED',
            decisionId,
            reason: '选牌声明未执行，当前局面下请改选其他组合',
          };
        }
        // 明确提供的跳过声明仍被引擎拒绝时，不能无限重复同一个无输入动作。
        this.executionFaultState = this.session.state;
        return { status: 'UNAVAILABLE', reason: '跳过声明未执行，AI 已暂停，请检查当前效果' };
      }
      return {
        status: 'REJECTED',
        decisionId,
        reason: execution.error ?? 'AI 命令执行失败',
      };
    }

    return {
      status: 'EXECUTED',
      decisionId,
      commandType: resolution.commandType,
      resultingPublicSequence: this.session.getCurrentPublicEventSeq(),
    };
  }

  private async waitForProvider(
    request: AiDecisionRequestV2,
    externalSignal?: AbortSignal
  ): Promise<ProviderWaitResult> {
    const providerAbortController = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let removeExternalAbortListener: () => void = () => {};

    const providerPromise: Promise<ProviderWaitResult> = Promise.resolve()
      .then(() => this.provider.decide(request, providerAbortController.signal))
      .then(
        (decision) => ({ kind: 'DECISION', decision }) as const,
        (error: unknown) => ({ kind: 'ERROR', error }) as const
      );
    const timeoutPromise = new Promise<ProviderWaitResult>((resolve) => {
      timeoutHandle = setTimeout(() => {
        providerAbortController.abort();
        resolve({ kind: 'TIMEOUT' });
      }, this.decisionTimeoutMs);
    });
    const competingPromises = [providerPromise, timeoutPromise];

    if (externalSignal) {
      competingPromises.push(
        new Promise<ProviderWaitResult>((resolve) => {
          const onAbort = () => {
            providerAbortController.abort();
            resolve({ kind: 'ABORTED' });
          };
          externalSignal.addEventListener('abort', onAbort, { once: true });
          removeExternalAbortListener = () => externalSignal.removeEventListener('abort', onAbort);
        })
      );
    }

    try {
      return await Promise.race(competingPromises);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      removeExternalAbortListener();
    }
  }

  private buildCurrentDecisionFrame(
    aiPlayerId: string,
    view: NonNullable<ReturnType<GameSession['getPlayerViewState']>>,
    decisionId: string
  ):
    | { readonly ok: true; readonly frame: AiDecisionFrameV2 }
    | { readonly ok: false; readonly reason: string } {
    if (this.rejectedState !== this.session.state) {
      this.rejectedState = this.session.state;
      this.rejectedActivationsByPlayer.clear();
      this.rejectedEffectSelectionsByPlayer.clear();
    }
    const rejected = this.rejectedActivationsByPlayer.get(aiPlayerId);
    const rejectedSelections = this.rejectedEffectSelectionsByPlayer.get(aiPlayerId) ?? [];
    if (rejectedSelections.length >= MAX_AI_REJECTED_EFFECT_SELECTIONS) {
      return { ok: false, reason: '当前多选局面的失败尝试已达上限，AI 已暂停' };
    }
    const draftResult = buildAiDecisionFrameV2(
      view,
      decisionId,
      this.session
        .getRulesMainActionCandidates(aiPlayerId)
        .filter(
          (candidate) =>
            candidate.kind !== 'ACTIVATE_ABILITY' ||
            !rejected?.has(activationKey(candidate.binding.cardId, candidate.binding.abilityId))
        ),
      this.session.getLegalRulesEffectStepActions(aiPlayerId),
      this.session.getLegalRulesLiveActions(aiPlayerId),
      this.session.getRulesEffectCardSelection(aiPlayerId),
      rejectedSelections
    );
    if (!draftResult.ok) {
      return draftResult;
    }

    const contextDigest = `sha256:${createHash('sha256')
      .update(draftResult.frame.canonicalContext, 'utf8')
      .digest('hex')}`;
    return finalizeAiDecisionFrameV2(draftResult.frame, contextDigest);
  }
}

function activationKey(cardId: string, abilityId: string): string {
  return JSON.stringify([cardId, abilityId]);
}

type ProviderWaitResult =
  | {
      readonly kind: 'DECISION';
      readonly decision: Awaited<ReturnType<AiDecisionProviderV2['decide']>>;
    }
  | { readonly kind: 'ERROR'; readonly error: unknown }
  | { readonly kind: 'ABORTED' }
  | { readonly kind: 'TIMEOUT' };

function sameDecisionFrame(left: AiDecisionFrameV2, right: AiDecisionFrameV2): boolean {
  // 比较白名单语义与 SHA-256，而不是会被拒绝命令推进的审计流水。
  // 正式联机接入仍应在串行队列中同时校验单调 remoteRevision。
  return (
    left.canonicalContext === right.canonicalContext &&
    left.request.contextDigest === right.request.contextDigest
  );
}

function createResolvedCommand(
  aiPlayerId: string,
  decisionId: string,
  resolution: Extract<ReturnType<typeof resolveAiDecisionV2>, { readonly ok: true }>,
  timestamp: number
): GameCommand {
  switch (resolution.commandType) {
    case GameCommandType.ACTIVATE_ABILITY:
      return {
        type: GameCommandType.ACTIVATE_ABILITY,
        playerId: aiPlayerId,
        cardId: resolution.cardId,
        abilityId: resolution.abilityId,
        timestamp,
        idempotencyKey: `${decisionId}:main-action`,
      };
    case GameCommandType.SET_LIVE_CARD:
    case GameCommandType.CONFIRM_STEP:
    case GameCommandType.SUBMIT_JUDGMENT:
    case GameCommandType.SUBMIT_SCORE:
    case GameCommandType.SELECT_SUCCESS_LIVE:
      return {
        ...resolution.liveAction,
        playerId: aiPlayerId,
        timestamp,
        idempotencyKey: `${decisionId}:live-action`,
      };
    case GameCommandType.CONFIRM_EFFECT_STEP:
      return {
        ...resolution.effectStep,
        playerId: aiPlayerId,
        timestamp,
        idempotencyKey: `${decisionId}:effect-step`,
      };
    case GameCommandType.MULLIGAN:
      return {
        ...createMulliganCommand(aiPlayerId, resolution.cardIdsToMulligan),
        timestamp,
        idempotencyKey: `${decisionId}:mulligan`,
      };
    case GameCommandType.PLAY_MEMBER_TO_SLOT:
      return {
        ...createPlayMemberToSlotCommand(aiPlayerId, resolution.cardId, resolution.targetSlot, {
          relayMode: resolution.relayMode,
        }),
        timestamp,
        idempotencyKey: `${decisionId}:main-action`,
      };
    case GameCommandType.END_PHASE:
      return {
        ...createEndPhaseCommand(aiPlayerId),
        timestamp,
        idempotencyKey: `${decisionId}:main-action`,
      };
  }
}
