import { createHash, randomUUID } from 'node:crypto';
import type { GameSession } from '../../application/game-session.js';
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

const DEFAULT_DECISION_TIMEOUT_MS = 30_000;

export type AiTurnStepResult =
  | {
      readonly status: 'EXECUTED';
      readonly decisionId: string;
      readonly commandType:
        GameCommandType.MULLIGAN | GameCommandType.PLAY_MEMBER_TO_SLOT | GameCommandType.END_PHASE;
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
}

export class AiTurnCoordinator {
  private readonly session: GameSession;
  private readonly provider: AiDecisionProviderV2;
  private readonly now: () => number;
  private readonly createDecisionId: () => string;
  private readonly decisionTimeoutMs: number;
  private readonly inFlightPlayerIds = new Set<string>();

  constructor(options: AiTurnCoordinatorOptions) {
    this.session = options.session;
    this.provider = options.provider;
    this.now = options.now ?? Date.now;
    this.createDecisionId = options.createDecisionId ?? randomUUID;
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

    const providerResult = await this.waitForProvider(buildResult.frame.request, externalSignal);
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
    if (!currentBuild.ok || !sameDecisionFrame(buildResult.frame, currentBuild.frame)) {
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

    const command = createResolvedCommand(aiPlayerId, decisionId, resolution, this.now());
    const execution = this.session.executeCommand(command);
    if (!execution.success) {
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
    const draftResult = buildAiDecisionFrameV2(
      view,
      decisionId,
      this.session.getLegalRulesMainActions(aiPlayerId)
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
