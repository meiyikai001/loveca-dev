import { describe, expect, it, vi } from 'vitest';
import type {
  AnyCardData,
  CardInstance,
  EnergyCardData,
  LiveCardData,
  MemberCardData,
} from '../../src/domain/entities/card';
import { createHeartIcon, createHeartRequirement } from '../../src/domain/entities/card';
import type { DeckConfig } from '../../src/application/game-service';
import { createGameSession } from '../../src/application/game-session';
import { createMulliganCommand, GameCommandType } from '../../src/application/game-commands';
import type {
  AiDecision,
  AiDecisionProvider,
  AiDecisionRequestV1,
} from '../../src/application/ai/ai-decision-contract';
import { buildAiDecisionFrame } from '../../src/application/ai/ai-decision-frame';
import { AiTurnCoordinator } from '../../src/server/services/ai-turn-coordinator';
import { CardType, HeartColor, SubPhase } from '../../src/shared/types/enums';
import { toTransport } from '../../src/online/serde';

const PLAYER1 = 'ai-player';
const PLAYER2 = 'human-player';

function createTestMemberCard(cardCode: string): MemberCardData {
  return {
    cardCode,
    name: `成员 ${cardCode}`,
    cardType: CardType.MEMBER,
    cost: 1,
    blade: 1,
    hearts: [createHeartIcon(HeartColor.GREEN, 1)],
  };
}

function createTestLiveCard(cardCode: string): LiveCardData {
  return {
    cardCode,
    name: `LIVE ${cardCode}`,
    cardType: CardType.LIVE,
    score: 2,
    requirements: createHeartRequirement({ [HeartColor.GREEN]: 2 }),
  };
}

function createTestEnergyCard(cardCode: string): EnergyCardData {
  return {
    cardCode,
    name: `能量 ${cardCode}`,
    cardType: CardType.ENERGY,
  };
}

function createTestDeck(prefix: string): DeckConfig {
  const mainDeck: AnyCardData[] = [];
  const energyDeck: EnergyCardData[] = [];
  for (let index = 0; index < 48; index += 1) {
    mainDeck.push(createTestMemberCard(`${prefix}-MEM-${index}`));
  }
  for (let index = 0; index < 12; index += 1) {
    mainDeck.push(createTestLiveCard(`${prefix}-LIVE-${index}`));
    energyDeck.push(createTestEnergyCard(`${prefix}-ENE-${index}`));
  }
  return { mainDeck, energyDeck };
}

function createMulliganSession() {
  const session = createGameSession({ randomInt: (maxExclusive) => maxExclusive - 1 });
  session.createGame('ai-bridge-test', PLAYER1, 'AI玩家', PLAYER2, '真人玩家');
  const initialized = session.initializeGame(createTestDeck('P1'), createTestDeck('P2'));
  expect(initialized.success).toBe(true);
  return session;
}

describe('AI 决策桥 v0', () => {
  it('以匿名候选完成换牌，并只通过正式命令链修改权威状态', async () => {
    const session = createMulliganSession();
    const authorityBefore = session.state!;
    const openingHandSize = authorityBefore.players[0].hand.cardIds.length;
    const selectedRawCardId = authorityBefore.players[0].hand.cardIds[0]!;
    const allRawCardIds = [...authorityBefore.cardRegistry.keys()];
    const selectedCardCode = authorityBefore.cardRegistry.get(selectedRawCardId)!.data.cardCode;
    let receivedRequest: AiDecisionRequestV1 | null = null;
    const provider: AiDecisionProvider = {
      decide(request) {
        receivedRequest = request;
        return Promise.resolve({
          schemaVersion: request.schemaVersion,
          decisionId: request.decisionId,
          kind: 'MULLIGAN' as const,
          selectedCardTokens: [request.window.candidates[0]!.token],
        });
      },
    };
    const coordinator = new AiTurnCoordinator({
      session,
      provider,
      now: () => 1_700_000_000_000,
    });
    const executeCommandSpy = vi.spyOn(session, 'executeCommand');

    const result = await coordinator.advanceOne(PLAYER1);

    expect(result).toMatchObject({
      status: 'EXECUTED',
      commandType: GameCommandType.MULLIGAN,
    });
    expect(receivedRequest).not.toBeNull();
    expect(receivedRequest!.window.candidates).toHaveLength(openingHandSize);
    expect(receivedRequest!.window.candidates[0]?.card.cardCode).toBe(selectedCardCode);

    const serializedRequest = JSON.stringify(receivedRequest);
    expect(serializedRequest).not.toContain('obj_');
    expect(serializedRequest).not.toContain(PLAYER1);
    expect(serializedRequest).not.toContain(PLAYER2);
    expect(serializedRequest).not.toContain(authorityBefore.gameId);
    for (const rawCardId of allRawCardIds) {
      expect(serializedRequest).not.toContain(rawCardId);
    }

    expect(executeCommandSpy).toHaveBeenCalledTimes(1);
    const executedCommand = executeCommandSpy.mock.calls[0]![0];
    expect(executedCommand).toMatchObject({
      type: GameCommandType.MULLIGAN,
      playerId: PLAYER1,
      cardIdsToMulligan: [selectedRawCardId],
      timestamp: 1_700_000_000_000,
    });
    expect(executedCommand.idempotencyKey).toMatch(/^ai-.+:mulligan$/);
    expect(session.state?.players[0].hand.cardIds).not.toContain(selectedRawCardId);
    expect(session.getPlayerViewState(PLAYER2)?.match.subPhase).toBe(
      SubPhase.MULLIGAN_SECOND_PLAYER
    );
    expect(session.getCommandLogSince(0).at(-1)).toMatchObject({
      playerId: PLAYER1,
      status: 'ACCEPTED',
      payload: {
        type: GameCommandType.MULLIGAN,
        playerId: PLAYER1,
        timestamp: 1_700_000_000_000,
      },
    });
  });

  it('各隐藏牌库顺序和对手隐藏牌身份均不影响观察', () => {
    const session = createMulliganSession();
    const baselineBuild = buildAiDecisionFrame(
      session.getPlayerViewState(PLAYER1)!,
      'fixed-decision'
    );
    expect(baselineBuild.ok).toBe(true);
    if (!baselineBuild.ok) {
      throw new Error('测试前置条件失败');
    }

    const mutableState = session.state as unknown as {
      players: {
        hand: { cardIds: string[] };
        mainDeck: { cardIds: string[] };
        energyDeck: { cardIds: string[] };
      }[];
      cardRegistry: Map<string, CardInstance>;
    };

    for (const hiddenDeck of [
      mutableState.players[0]!.mainDeck.cardIds,
      mutableState.players[0]!.energyDeck.cardIds,
      mutableState.players[1]!.mainDeck.cardIds,
      mutableState.players[1]!.energyDeck.cardIds,
    ]) {
      hiddenDeck.reverse();
      const changedBuild = buildAiDecisionFrame(
        session.getPlayerViewState(PLAYER1)!,
        'fixed-decision'
      );
      expect(changedBuild.ok).toBe(true);
      if (!changedBuild.ok) {
        throw new Error('测试前置条件失败');
      }
      expect(changedBuild.frame.request).toEqual(baselineBuild.frame.request);
      hiddenDeck.reverse();
    }

    const hiddenOpponentCardId = mutableState.players[1]!.hand.cardIds[0]!;
    const hiddenOpponentCard = mutableState.cardRegistry.get(hiddenOpponentCardId)!;
    mutableState.cardRegistry.set(hiddenOpponentCardId, {
      ...hiddenOpponentCard,
      data: createTestMemberCard('SECRET-HIDDEN-SENTINEL'),
    });
    const identityChangedBuild = buildAiDecisionFrame(
      session.getPlayerViewState(PLAYER1)!,
      'fixed-decision'
    );
    expect(identityChangedBuild.ok).toBe(true);
    if (!identityChangedBuild.ok) {
      throw new Error('测试前置条件失败');
    }
    expect(identityChangedBuild.frame.request).toEqual(baselineBuild.frame.request);
    expect(JSON.stringify(identityChangedBuild.frame.request)).not.toContain(
      'SECRET-HIDDEN-SENTINEL'
    );
  });

  it('UI 投影未来新增字段或区域不会自动扩散到 AI 协议', () => {
    const session = createMulliganSession();
    const view = session.getPlayerViewState(PLAYER1)!;
    const handZone = view.table.zones.FIRST_HAND;
    const ownHandObject = view.objects[handZone.objectIds![0]!]!;
    const mutableFrontInfo = ownHandObject.frontInfo as unknown as Record<string, unknown>;
    mutableFrontInfo.futureSensitiveField = 'FUTURE-FIELD-SENTINEL';
    const nestedFrontInfo = (ownHandObject.frontInfo?.hearts?.[0] ??
      ownHandObject.frontInfo?.requiredHearts) as unknown as Record<string, unknown>;
    nestedFrontInfo.futureNestedField = 'FUTURE-NESTED-SENTINEL';
    const mutableZones = view.table.zones as unknown as Record<string, unknown>;
    mutableZones.FIRST_FUTURE_PRIVATE_ZONE = {
      zone: 'FUTURE_PRIVATE_ZONE',
      ownerSeat: 'FIRST',
      count: 99,
      ordered: true,
    };

    const build = buildAiDecisionFrame(view, 'fixed-decision');

    expect(build.ok).toBe(true);
    if (!build.ok) {
      throw new Error('测试前置条件失败');
    }
    const serializedRequest = JSON.stringify(build.frame.request);
    expect(serializedRequest).not.toContain('FUTURE-FIELD-SENTINEL');
    expect(serializedRequest).not.toContain('FUTURE-NESTED-SENTINEL');
    expect(serializedRequest).not.toContain('FIRST_FUTURE_PRIVATE_ZONE');
  });

  it('拒绝伪造决策令牌、未知候选或重复候选且不执行命令', async () => {
    for (const testCase of [
      { selectedCardTokens: ['missing-token'] },
      { selectedCardTokens: ['hand-1', 'hand-1'] },
      { selectedCardTokens: [], decisionId: 'forged-decision' },
    ] as const) {
      const session = createMulliganSession();
      const before = toTransport(session.state);
      const provider: AiDecisionProvider = {
        decide(request) {
          return Promise.resolve({
            schemaVersion: request.schemaVersion,
            decisionId: testCase.decisionId ?? request.decisionId,
            kind: 'MULLIGAN' as const,
            selectedCardTokens: testCase.selectedCardTokens,
          });
        },
      };

      const result = await new AiTurnCoordinator({ session, provider }).advanceOne(PLAYER1);

      expect(result.status).toBe('REJECTED');
      expect(toTransport(session.state)).toEqual(before);
      expect(session.getCommandLogSince(0)).toHaveLength(0);
    }
  });

  it('策略等待期间局面变化时丢弃过期结果', async () => {
    const session = createMulliganSession();
    let releaseDecision!: (decision: AiDecision) => void;
    let markStarted!: () => void;
    let pendingDecisionId = '';
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const provider: AiDecisionProvider = {
      async decide(request) {
        pendingDecisionId = request.decisionId;
        markStarted();
        return await new Promise<AiDecision>((resolve) => {
          releaseDecision = resolve;
        });
      },
    };
    const coordinator = new AiTurnCoordinator({ session, provider });
    const pendingResult = coordinator.advanceOne(PLAYER1);
    await started;

    expect(session.executeCommand(createMulliganCommand(PLAYER1, [])).success).toBe(true);
    releaseDecision({
      schemaVersion: 1,
      decisionId: pendingDecisionId,
      kind: 'MULLIGAN',
      selectedCardTokens: [],
    });

    const afterLegitimateCommand = toTransport(session.state);
    await expect(pendingResult).resolves.toMatchObject({ status: 'STALE' });
    expect(toTransport(session.state)).toEqual(afterLegitimateCommand);
    expect(session.getCommandLogSince(0)).toHaveLength(1);
  });

  it('等待期间以相同配置重开对局时仍会拒绝跨局旧决策', async () => {
    const session = createMulliganSession();
    let releaseDecision!: (decision: AiDecision) => void;
    let markStarted!: () => void;
    let pendingRequest!: AiDecisionRequestV1;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const provider: AiDecisionProvider = {
      async decide(request) {
        pendingRequest = request;
        markStarted();
        return await new Promise<AiDecision>((resolve) => {
          releaseDecision = resolve;
        });
      },
    };
    const pendingResult = new AiTurnCoordinator({ session, provider }).advanceOne(PLAYER1);
    await started;

    session.createGame('ai-bridge-test', PLAYER1, 'AI玩家', PLAYER2, '真人玩家');
    expect(session.initializeGame(createTestDeck('P1'), createTestDeck('P2')).success).toBe(true);
    const replacementState = toTransport(session.state);
    releaseDecision({
      schemaVersion: pendingRequest.schemaVersion,
      decisionId: pendingRequest.decisionId,
      kind: 'MULLIGAN',
      selectedCardTokens: [],
    });

    await expect(pendingResult).resolves.toMatchObject({ status: 'STALE' });
    expect(toTransport(session.state)).toEqual(replacementState);
    expect(session.getCommandLogSince(0)).toHaveLength(0);
  });

  it('无状态变化的拒绝命令不会使当前 AI 决策失效', async () => {
    const session = createMulliganSession();
    let releaseDecision!: (decision: AiDecision) => void;
    let markStarted!: () => void;
    let pendingDecisionId = '';
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const provider: AiDecisionProvider = {
      async decide(request) {
        pendingDecisionId = request.decisionId;
        markStarted();
        return await new Promise<AiDecision>((resolve) => {
          releaseDecision = resolve;
        });
      },
    };
    const coordinator = new AiTurnCoordinator({ session, provider });
    const pendingResult = coordinator.advanceOne(PLAYER1);
    await started;

    expect(session.executeCommand(createMulliganCommand(PLAYER2, [])).success).toBe(false);
    releaseDecision({
      schemaVersion: 1,
      decisionId: pendingDecisionId,
      kind: 'MULLIGAN',
      selectedCardTokens: [],
    });

    await expect(pendingResult).resolves.toMatchObject({ status: 'EXECUTED' });
    expect(session.getCommandLogSince(0).map((entry) => entry.status)).toEqual([
      'REJECTED',
      'ACCEPTED',
    ]);
  });

  it('将畸形模型响应安全拒绝且不修改权威状态', async () => {
    const malformedDecisionFactories: readonly ((request: AiDecisionRequestV1) => unknown)[] = [
      () => [],
      (request) => ({
        schemaVersion: request.schemaVersion,
        decisionId: request.decisionId,
        kind: 'MULLIGAN',
        selectedCardTokens: null,
      }),
      (request) => ({
        schemaVersion: request.schemaVersion,
        decisionId: request.decisionId,
        kind: 'MULLIGAN',
        selectedCardTokens: [1],
      }),
      (request) => ({
        schemaVersion: 999,
        decisionId: request.decisionId,
        kind: 'MULLIGAN',
        selectedCardTokens: [],
      }),
    ];

    for (const createMalformedDecision of malformedDecisionFactories) {
      const session = createMulliganSession();
      const before = toTransport(session.state);
      const provider: AiDecisionProvider = {
        decide(request) {
          return Promise.resolve(createMalformedDecision(request) as AiDecision);
        },
      };

      const result = await new AiTurnCoordinator({ session, provider }).advanceOne(PLAYER1);

      expect(result.status).toBe('REJECTED');
      expect(toTransport(session.state)).toEqual(before);
      expect(session.getCommandLogSince(0)).toHaveLength(0);
    }
  });

  it('未知玩家返回不可用，不会调用决策器', async () => {
    const session = createMulliganSession();
    const decide = vi.fn<AiDecisionProvider['decide']>();
    const provider: AiDecisionProvider = { decide };

    const result = await new AiTurnCoordinator({ session, provider }).advanceOne('missing-player');

    expect(result.status).toBe('UNAVAILABLE');
    expect(decide).not.toHaveBeenCalled();
  });

  it('决策器即使忽略取消信号也会超时返回', async () => {
    const session = createMulliganSession();
    let providerSignal: AbortSignal | undefined;
    let releaseDecision!: (decision: AiDecision) => void;
    let pendingRequest!: AiDecisionRequestV1;
    const provider: AiDecisionProvider = {
      decide(request, signal) {
        pendingRequest = request;
        providerSignal = signal;
        return new Promise<AiDecision>((resolve) => {
          releaseDecision = resolve;
        });
      },
    };

    const result = await new AiTurnCoordinator({
      session,
      provider,
      decisionTimeoutMs: 5,
    }).advanceOne(PLAYER1);

    expect(result.status).toBe('TIMEOUT');
    expect(providerSignal?.aborted).toBe(true);
    expect(session.getCommandLogSince(0)).toHaveLength(0);

    const afterTimeout = toTransport(session.state);
    releaseDecision({
      schemaVersion: pendingRequest.schemaVersion,
      decisionId: pendingRequest.decisionId,
      kind: 'MULLIGAN',
      selectedCardTokens: [],
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(toTransport(session.state)).toEqual(afterTimeout);
    expect(session.getCommandLogSince(0)).toHaveLength(0);
  });

  it('外部取消会立即返回、释放单飞锁，且迟到结果不会执行', async () => {
    const session = createMulliganSession();
    const abortController = new AbortController();
    let decideCallCount = 0;
    let releaseFirstDecision!: (decision: AiDecision) => void;
    let firstRequest!: AiDecisionRequestV1;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const provider: AiDecisionProvider = {
      decide(request) {
        decideCallCount += 1;
        if (decideCallCount === 1) {
          firstRequest = request;
          markStarted();
          return new Promise<AiDecision>((resolve) => {
            releaseFirstDecision = resolve;
          });
        }
        return Promise.resolve({
          schemaVersion: request.schemaVersion,
          decisionId: request.decisionId,
          kind: 'MULLIGAN',
          selectedCardTokens: [],
        });
      },
    };
    const coordinator = new AiTurnCoordinator({ session, provider });
    const abortedResult = coordinator.advanceOne(PLAYER1, { signal: abortController.signal });
    await started;

    abortController.abort();
    await expect(abortedResult).resolves.toMatchObject({ status: 'ABORTED' });
    await expect(coordinator.advanceOne(PLAYER1)).resolves.toMatchObject({ status: 'EXECUTED' });
    expect(session.getCommandLogSince(0)).toHaveLength(1);

    releaseFirstDecision({
      schemaVersion: firstRequest.schemaVersion,
      decisionId: firstRequest.decisionId,
      kind: 'MULLIGAN',
      selectedCardTokens: [],
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(session.getCommandLogSince(0)).toHaveLength(1);
  });

  it('同一 AI 席位只允许一个在途决策', async () => {
    const session = createMulliganSession();
    let releaseDecision!: (decision: AiDecision) => void;
    let markStarted!: () => void;
    let pendingRequest!: AiDecisionRequestV1;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const decide = vi.fn<AiDecisionProvider['decide']>(async (request) => {
      pendingRequest = request;
      markStarted();
      return await new Promise<AiDecision>((resolve) => {
        releaseDecision = resolve;
      });
    });
    const coordinator = new AiTurnCoordinator({ session, provider: { decide } });
    const firstResult = coordinator.advanceOne(PLAYER1);
    await started;

    await expect(coordinator.advanceOne(PLAYER1)).resolves.toMatchObject({
      status: 'UNAVAILABLE',
    });
    expect(decide).toHaveBeenCalledTimes(1);

    releaseDecision({
      schemaVersion: pendingRequest.schemaVersion,
      decisionId: pendingRequest.decisionId,
      kind: 'MULLIGAN',
      selectedCardTokens: [],
    });
    await expect(firstResult).resolves.toMatchObject({ status: 'EXECUTED' });
  });

  it('非当前操作席位不会获得AI换牌窗口', async () => {
    const session = createMulliganSession();
    let providerCalled = false;
    const provider: AiDecisionProvider = {
      decide() {
        providerCalled = true;
        return Promise.resolve(null);
      },
    };

    const result = await new AiTurnCoordinator({ session, provider }).advanceOne(PLAYER2);

    expect(result).toMatchObject({ status: 'UNAVAILABLE' });
    expect(providerCalled).toBe(false);
    expect(session.getCommandLogSince(0)).toHaveLength(0);
  });
});
