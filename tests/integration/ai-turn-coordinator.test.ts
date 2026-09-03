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
import {
  createEndPhaseCommand,
  createMulliganCommand,
  createPlayMemberToSlotCommand,
  GameCommandType,
} from '../../src/application/game-commands';
import type {
  AiDecisionProviderV2,
  AiDecisionRequestV2,
  AiDecisionV2,
  AiMainActionDecisionRequestDraftV2,
} from '../../src/application/ai/ai-decision-contract';
import { buildAiDecisionFrameV2 } from '../../src/application/ai/ai-decision-frame';
import { AiTurnCoordinator } from '../../src/server/services/ai-turn-coordinator';
import {
  CardType,
  FaceState,
  GamePhase,
  HeartColor,
  OrientationState,
  SlotPosition,
  SubPhase,
} from '../../src/shared/types/enums';
import { toTransport } from '../../src/online/serde';
import { placeCardInSlot } from '../../src/domain/entities/zone';

const PLAYER1 = 'ai-player';
const PLAYER2 = 'human-player';

type AiMainActionDecisionRequestV2 = AiMainActionDecisionRequestDraftV2 &
  Pick<AiDecisionRequestV2, 'contextDigest'>;

function assertMainActionRequest(
  request: AiDecisionRequestV2
): asserts request is AiMainActionDecisionRequestV2 {
  if (request.window.kind !== 'MAIN_ACTION') {
    throw new Error('测试前置条件失败：当前不是主要阶段窗口');
  }
}

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

function createMainPhaseSession() {
  const session = createMulliganSession();
  expect(session.executeCommand(createMulliganCommand(PLAYER1, [])).success).toBe(true);
  expect(session.executeCommand(createMulliganCommand(PLAYER2, [])).success).toBe(true);
  expect(session.state?.currentPhase).toBe(GamePhase.MAIN_PHASE);
  expect(session.state?.currentSubPhase).toBe(SubPhase.NONE);
  expect(session.getActivePlayerId()).toBe(PLAYER1);
  return session;
}

function createMulliganDecisionV2(
  request: AiDecisionRequestV2,
  selectedCardTokens: readonly string[] = []
): AiDecisionV2 {
  if (request.window.kind !== 'MULLIGAN') {
    throw new Error('测试前置条件失败：当前不是换牌窗口');
  }
  return {
    schemaVersion: request.schemaVersion,
    decisionId: request.decisionId,
    contextDigest: request.contextDigest,
    kind: 'MULLIGAN',
    selectedCardTokens,
  };
}

function createMainActionDecisionV2(
  request: AiDecisionRequestV2,
  selectedActionToken: string
): AiDecisionV2 {
  if (request.window.kind !== 'MAIN_ACTION') {
    throw new Error('测试前置条件失败：当前不是主要阶段窗口');
  }
  return {
    schemaVersion: request.schemaVersion,
    decisionId: request.decisionId,
    contextDigest: request.contextDigest,
    kind: 'MAIN_ACTION',
    selectedActionToken,
  };
}

function getMainActionToken(
  request: AiDecisionRequestV2,
  kind: 'END_MAIN_PHASE' | 'PLAY_MEMBER_TO_EMPTY_SLOT' | 'PLAY_MEMBER_WITH_SINGLE_RELAY'
): string {
  if (request.window.kind !== 'MAIN_ACTION') {
    throw new Error('测试前置条件失败：当前不是主要阶段窗口');
  }
  const token = request.window.candidates.find((candidate) => candidate.kind === kind)?.actionToken;
  if (!token) {
    throw new Error(`测试前置条件失败：缺少 ${kind} 候选`);
  }
  return token;
}

function placeExistingMemberForRelay(
  session: ReturnType<typeof createGameSession>,
  slot: SlotPosition = SlotPosition.LEFT
): string {
  const state = session.state!;
  const player = state.players[0]!;
  const occupantId = player.mainDeck.cardIds.find(
    (cardId) => state.cardRegistry.get(cardId)?.data.cardType === CardType.MEMBER
  );
  if (!occupantId) {
    throw new Error('测试前置条件失败：缺少可放置的成员');
  }
  player.mainDeck.cardIds = player.mainDeck.cardIds.filter((cardId) => cardId !== occupantId);
  player.memberSlots = placeCardInSlot(player.memberSlots, slot, occupantId, {
    orientation: OrientationState.ACTIVE,
    face: FaceState.FACE_UP,
  });
  player.movedToStageThisTurn = [];
  return occupantId;
}

function setMemberHandSize(
  session: ReturnType<typeof createGameSession>,
  count: number
): readonly string[] {
  const state = session.state!;
  const player = state.players[0]!;
  const mainCards = [...player.hand.cardIds, ...player.mainDeck.cardIds];
  const selectedCardIds = mainCards
    .filter((cardId) => state.cardRegistry.get(cardId)?.data.cardType === CardType.MEMBER)
    .slice(0, count);
  expect(selectedCardIds).toHaveLength(count);
  const selectedSet = new Set(selectedCardIds);
  player.hand.cardIds = [...selectedCardIds];
  player.mainDeck.cardIds = mainCards.filter((cardId) => !selectedSet.has(cardId));
  return selectedCardIds;
}

describe('AI 决策桥 V2', () => {
  it('以匿名候选完成换牌，并只通过正式命令链修改权威状态', async () => {
    const session = createMulliganSession();
    const authorityBefore = session.state!;
    const openingHandSize = authorityBefore.players[0].hand.cardIds.length;
    const selectedRawCardId = authorityBefore.players[0].hand.cardIds[0]!;
    const allRawCardIds = [...authorityBefore.cardRegistry.keys()];
    const selectedCardCode = authorityBefore.cardRegistry.get(selectedRawCardId)!.data.cardCode;
    let receivedRequest: AiDecisionRequestV2 | null = null;
    const provider: AiDecisionProviderV2 = {
      decide(request) {
        receivedRequest = request;
        if (request.window.kind !== 'MULLIGAN') {
          throw new Error('预期收到换牌窗口');
        }
        return Promise.resolve(
          createMulliganDecisionV2(request, [request.window.candidates[0]!.token])
        );
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
    expect(receivedRequest!.schemaVersion).toBe(2);
    expect(receivedRequest!.contextDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(receivedRequest!.window.kind).toBe('MULLIGAN');
    if (receivedRequest!.window.kind !== 'MULLIGAN') {
      throw new Error('测试前置条件失败');
    }
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
    const baselineBuild = buildAiDecisionFrameV2(
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
      const changedBuild = buildAiDecisionFrameV2(
        session.getPlayerViewState(PLAYER1)!,
        'fixed-decision'
      );
      expect(changedBuild.ok).toBe(true);
      if (!changedBuild.ok) {
        throw new Error('测试前置条件失败');
      }
      expect(changedBuild.frame.request).toEqual(baselineBuild.frame.request);
      expect(changedBuild.frame.canonicalContext).toBe(baselineBuild.frame.canonicalContext);
      hiddenDeck.reverse();
    }

    const hiddenOpponentCardId = mutableState.players[1]!.hand.cardIds[0]!;
    const hiddenOpponentCard = mutableState.cardRegistry.get(hiddenOpponentCardId)!;
    mutableState.cardRegistry.set(hiddenOpponentCardId, {
      ...hiddenOpponentCard,
      data: createTestMemberCard('SECRET-HIDDEN-SENTINEL'),
    });
    const identityChangedBuild = buildAiDecisionFrameV2(
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

  it('MAIN_ACTION 的新增投影仍不受隐藏牌序、对手手牌身份与未来字段影响', () => {
    const session = createMainPhaseSession();
    const buildCurrentFrame = () =>
      buildAiDecisionFrameV2(
        session.getPlayerViewState(PLAYER1)!,
        'fixed-main-decision',
        session.getLegalRulesMainActions(PLAYER1)
      );
    const baselineBuild = buildCurrentFrame();
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
      const changedBuild = buildCurrentFrame();
      expect(changedBuild.ok).toBe(true);
      if (!changedBuild.ok) {
        throw new Error('测试前置条件失败');
      }
      expect(changedBuild.frame.request).toEqual(baselineBuild.frame.request);
      expect(changedBuild.frame.canonicalContext).toBe(baselineBuild.frame.canonicalContext);
      hiddenDeck.reverse();
    }

    const opponentCardId = mutableState.players[1]!.hand.cardIds[0]!;
    const opponentCard = mutableState.cardRegistry.get(opponentCardId)!;
    mutableState.cardRegistry.set(opponentCardId, {
      ...opponentCard,
      data: createTestMemberCard('MAIN-SECRET-HIDDEN-SENTINEL'),
    });
    const hiddenIdentityBuild = buildCurrentFrame();
    expect(hiddenIdentityBuild.ok).toBe(true);
    if (!hiddenIdentityBuild.ok) {
      throw new Error('测试前置条件失败');
    }
    expect(hiddenIdentityBuild.frame.request).toEqual(baselineBuild.frame.request);

    const viewWithFutureFields = session.getPlayerViewState(PLAYER1)!;
    const ownHandObjectId = viewWithFutureFields.table.zones.FIRST_HAND.objectIds![0]!;
    const ownFrontInfo = viewWithFutureFields.objects[ownHandObjectId]!
      .frontInfo as unknown as Record<string, unknown>;
    ownFrontInfo.futureSensitiveField = 'MAIN-FUTURE-FIELD-SENTINEL';
    (viewWithFutureFields.table.zones as unknown as Record<string, unknown>)[
      'FIRST_FUTURE_PRIVATE_ZONE'
    ] = { zone: 'FUTURE_PRIVATE_ZONE', count: 99, ordered: true };
    const futureFieldBuild = buildAiDecisionFrameV2(
      viewWithFutureFields,
      'fixed-main-decision',
      session.getLegalRulesMainActions(PLAYER1)
    );
    expect(futureFieldBuild.ok).toBe(true);
    if (!futureFieldBuild.ok) {
      throw new Error('测试前置条件失败');
    }
    expect(futureFieldBuild.frame.request).toEqual(baselineBuild.frame.request);
    expect(futureFieldBuild.frame.canonicalContext).toBe(baselineBuild.frame.canonicalContext);
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

    const build = buildAiDecisionFrameV2(view, 'fixed-decision');

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
      const provider: AiDecisionProviderV2 = {
        decide(request) {
          return Promise.resolve({
            schemaVersion: request.schemaVersion,
            decisionId: testCase.decisionId ?? request.decisionId,
            contextDigest: request.contextDigest,
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
    let releaseDecision!: (decision: AiDecisionV2) => void;
    let markStarted!: () => void;
    let pendingRequest!: AiDecisionRequestV2;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const provider: AiDecisionProviderV2 = {
      async decide(request) {
        pendingRequest = request;
        markStarted();
        return await new Promise<AiDecisionV2>((resolve) => {
          releaseDecision = resolve;
        });
      },
    };
    const coordinator = new AiTurnCoordinator({ session, provider });
    const pendingResult = coordinator.advanceOne(PLAYER1);
    await started;

    expect(session.executeCommand(createMulliganCommand(PLAYER1, [])).success).toBe(true);
    releaseDecision(createMulliganDecisionV2(pendingRequest));

    const afterLegitimateCommand = toTransport(session.state);
    await expect(pendingResult).resolves.toMatchObject({ status: 'STALE' });
    expect(toTransport(session.state)).toEqual(afterLegitimateCommand);
    expect(session.getCommandLogSince(0)).toHaveLength(1);
  });

  it('等待期间以相同配置重开对局时仍会拒绝跨局旧决策', async () => {
    const session = createMulliganSession();
    let releaseDecision!: (decision: AiDecisionV2) => void;
    let markStarted!: () => void;
    let pendingRequest!: AiDecisionRequestV2;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const provider: AiDecisionProviderV2 = {
      async decide(request) {
        pendingRequest = request;
        markStarted();
        return await new Promise<AiDecisionV2>((resolve) => {
          releaseDecision = resolve;
        });
      },
    };
    const pendingResult = new AiTurnCoordinator({ session, provider }).advanceOne(PLAYER1);
    await started;

    session.createGame('ai-bridge-test', PLAYER1, 'AI玩家', PLAYER2, '真人玩家');
    expect(session.initializeGame(createTestDeck('P1'), createTestDeck('P2')).success).toBe(true);
    const replacementState = toTransport(session.state);
    releaseDecision(createMulliganDecisionV2(pendingRequest));

    await expect(pendingResult).resolves.toMatchObject({ status: 'STALE' });
    expect(toTransport(session.state)).toEqual(replacementState);
    expect(session.getCommandLogSince(0)).toHaveLength(0);
  });

  it('无状态变化的拒绝命令不会使当前 AI 决策失效', async () => {
    const session = createMulliganSession();
    let releaseDecision!: (decision: AiDecisionV2) => void;
    let markStarted!: () => void;
    let pendingRequest!: AiDecisionRequestV2;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const provider: AiDecisionProviderV2 = {
      async decide(request) {
        pendingRequest = request;
        markStarted();
        return await new Promise<AiDecisionV2>((resolve) => {
          releaseDecision = resolve;
        });
      },
    };
    const coordinator = new AiTurnCoordinator({ session, provider });
    const pendingResult = coordinator.advanceOne(PLAYER1);
    await started;

    expect(session.executeCommand(createMulliganCommand(PLAYER2, [])).success).toBe(false);
    releaseDecision(createMulliganDecisionV2(pendingRequest));

    await expect(pendingResult).resolves.toMatchObject({ status: 'EXECUTED' });
    expect(session.getCommandLogSince(0).map((entry) => entry.status)).toEqual([
      'REJECTED',
      'ACCEPTED',
    ]);
  });

  it('将畸形模型响应安全拒绝且不修改权威状态', async () => {
    const malformedDecisionFactories: readonly ((request: AiDecisionRequestV2) => unknown)[] = [
      () => [],
      (request) => ({
        schemaVersion: request.schemaVersion,
        decisionId: request.decisionId,
        contextDigest: request.contextDigest,
        kind: 'MULLIGAN',
        selectedCardTokens: null,
      }),
      (request) => ({
        schemaVersion: request.schemaVersion,
        decisionId: request.decisionId,
        contextDigest: request.contextDigest,
        kind: 'MULLIGAN',
        selectedCardTokens: [1],
      }),
      (request) => ({
        schemaVersion: 999,
        decisionId: request.decisionId,
        contextDigest: request.contextDigest,
        kind: 'MULLIGAN',
        selectedCardTokens: [],
      }),
      (request) => ({
        ...createMulliganDecisionV2(request),
        command: { type: GameCommandType.END_PHASE },
      }),
      (request) => ({
        ...createMulliganDecisionV2(request),
        contextDigest: 'sha256:forged',
      }),
    ];

    for (const createMalformedDecision of malformedDecisionFactories) {
      const session = createMulliganSession();
      const before = toTransport(session.state);
      const provider: AiDecisionProviderV2 = {
        decide(request) {
          return Promise.resolve(createMalformedDecision(request) as AiDecisionV2);
        },
      };

      const result = await new AiTurnCoordinator({ session, provider }).advanceOne(PLAYER1);

      expect(result.status).toBe('REJECTED');
      expect(toTransport(session.state)).toEqual(before);
      expect(session.getCommandLogSince(0)).toHaveLength(0);
    }
  });

  it('以完整 action token 将成员登场到空成员区', async () => {
    const session = createMainPhaseSession();
    const expectedAction = session
      .getLegalRulesMainActions(PLAYER1)
      .find(
        (candidate) => candidate.kind === 'PLAY_MEMBER_TO_SLOT' && candidate.playMode === 'EMPTY'
      );
    if (!expectedAction || expectedAction.kind !== 'PLAY_MEMBER_TO_SLOT') {
      throw new Error('测试前置条件失败：缺少空成员区登场候选');
    }
    const allRawCardIds = [...session.state!.cardRegistry.keys()];
    const handCountBefore = session.state!.players[0]!.hand.cardIds.length;
    let serializedRequest = '';
    const provider: AiDecisionProviderV2 = {
      decide(request) {
        expect(request.window.kind).toBe('MAIN_ACTION');
        assertMainActionRequest(request);
        expect(request.observation.self.hand).toHaveLength(handCountBefore);
        expect(
          request.observation.self.hand.find((entry) => entry.card.cardType === CardType.MEMBER)
            ?.card.blade
        ).toBe(1);
        expect(request.observation.self.stage.map((entry) => entry.slot)).toEqual([
          SlotPosition.LEFT,
          SlotPosition.CENTER,
          SlotPosition.RIGHT,
        ]);
        expect(request.observation.self.energy.activeCount).toBeGreaterThanOrEqual(1);
        expect(request.window.candidates[0]).toMatchObject({
          actionToken: 'action-1',
          kind: 'END_MAIN_PHASE',
        });
        serializedRequest = JSON.stringify(request);
        return Promise.resolve(
          createMainActionDecisionV2(
            request,
            getMainActionToken(request, 'PLAY_MEMBER_TO_EMPTY_SLOT')
          )
        );
      },
    };
    const executeCommandSpy = vi.spyOn(session, 'executeCommand');

    const result = await new AiTurnCoordinator({
      session,
      provider,
      now: () => 1_700_000_000_001,
    }).advanceOne(PLAYER1);

    expect(result).toMatchObject({
      status: 'EXECUTED',
      commandType: GameCommandType.PLAY_MEMBER_TO_SLOT,
    });
    expect(serializedRequest).not.toContain('obj_');
    expect(serializedRequest).not.toContain(PLAYER1);
    expect(serializedRequest).not.toContain(PLAYER2);
    expect(serializedRequest).not.toContain(session.state!.gameId);
    for (const rawCardId of allRawCardIds) {
      expect(serializedRequest).not.toContain(rawCardId);
    }

    expect(executeCommandSpy).toHaveBeenCalledTimes(1);
    const executedCommand = executeCommandSpy.mock.calls[0]![0];
    expect(executedCommand).toMatchObject({
      type: GameCommandType.PLAY_MEMBER_TO_SLOT,
      playerId: PLAYER1,
      cardId: expectedAction.binding.cardId,
      targetSlot: expectedAction.binding.targetSlot,
      timestamp: 1_700_000_000_001,
    });
    expect(executedCommand).not.toHaveProperty('relayMode');
    expect(executedCommand).not.toHaveProperty('freePlay');
    expect(executedCommand.idempotencyKey).toMatch(/^ai-.+:main-action$/);
    expect(session.state!.players[0]!.memberSlots.slots[expectedAction.binding.targetSlot]).toBe(
      expectedAction.binding.cardId
    );
  });

  it('手牌较多时仍保留全部合法动作和 END，不因旧的 64 项边界停摆', async () => {
    const session = createMainPhaseSession();
    setMemberHandSize(session, 22);
    let candidateCount = 0;
    const provider: AiDecisionProviderV2 = {
      decide(request) {
        assertMainActionRequest(request);
        candidateCount = request.window.candidates.length;
        return Promise.resolve(
          createMainActionDecisionV2(request, getMainActionToken(request, 'END_MAIN_PHASE'))
        );
      },
    };

    const result = await new AiTurnCoordinator({ session, provider }).advanceOne(PLAYER1);

    expect(candidateCount).toBe(67);
    expect(result).toMatchObject({
      status: 'EXECUTED',
      commandType: GameCommandType.END_PHASE,
    });
  });

  it('以显式 SINGLE 语义执行普通单换手', async () => {
    const session = createMainPhaseSession();
    const replacedMemberCardId = placeExistingMemberForRelay(session, SlotPosition.LEFT);
    const expectedAction = session
      .getLegalRulesMainActions(PLAYER1)
      .find(
        (candidate) =>
          candidate.kind === 'PLAY_MEMBER_TO_SLOT' &&
          candidate.playMode === 'SINGLE_RELAY' &&
          candidate.binding.targetSlot === SlotPosition.LEFT
      );
    if (!expectedAction || expectedAction.kind !== 'PLAY_MEMBER_TO_SLOT') {
      throw new Error('测试前置条件失败：缺少单换手候选');
    }
    const provider: AiDecisionProviderV2 = {
      decide(request) {
        expect(request.window.kind).toBe('MAIN_ACTION');
        assertMainActionRequest(request);
        expect(
          request.observation.self.stage.find((entry) => entry.slot === SlotPosition.LEFT)?.member
            ?.card.blade
        ).toBe(1);
        const relayCandidate = request.window.candidates.find(
          (candidate) => candidate.kind === 'PLAY_MEMBER_WITH_SINGLE_RELAY'
        );
        expect(relayCandidate).toMatchObject({
          targetSlot: SlotPosition.LEFT,
          payment: {
            modifiedCost: 1,
            energyCost: 0,
            relayDiscount: 1,
          },
        });
        return Promise.resolve(
          createMainActionDecisionV2(
            request,
            getMainActionToken(request, 'PLAY_MEMBER_WITH_SINGLE_RELAY')
          )
        );
      },
    };
    const executeCommandSpy = vi.spyOn(session, 'executeCommand');

    const result = await new AiTurnCoordinator({ session, provider }).advanceOne(PLAYER1);

    expect(result).toMatchObject({
      status: 'EXECUTED',
      commandType: GameCommandType.PLAY_MEMBER_TO_SLOT,
    });
    expect(executeCommandSpy).toHaveBeenCalledTimes(1);
    expect(executeCommandSpy.mock.calls[0]![0]).toMatchObject({
      type: GameCommandType.PLAY_MEMBER_TO_SLOT,
      playerId: PLAYER1,
      cardId: expectedAction.binding.cardId,
      targetSlot: SlotPosition.LEFT,
      relayMode: 'SINGLE',
    });
    expect(session.state!.players[0]!.memberSlots.slots.LEFT).toBe(expectedAction.binding.cardId);
    expect(session.state!.players[0]!.waitingRoom.cardIds).toContain(replacedMemberCardId);
  });

  it('通过 END_MAIN_PHASE token 结束主要阶段', async () => {
    const session = createMainPhaseSession();
    const provider: AiDecisionProviderV2 = {
      decide(request) {
        return Promise.resolve(
          createMainActionDecisionV2(request, getMainActionToken(request, 'END_MAIN_PHASE'))
        );
      },
    };
    const executeCommandSpy = vi.spyOn(session, 'executeCommand');

    const result = await new AiTurnCoordinator({
      session,
      provider,
      now: () => 1_700_000_000_002,
    }).advanceOne(PLAYER1);

    expect(result).toMatchObject({
      status: 'EXECUTED',
      commandType: GameCommandType.END_PHASE,
    });
    expect(executeCommandSpy).toHaveBeenCalledTimes(1);
    expect(executeCommandSpy.mock.calls[0]![0]).toMatchObject({
      type: GameCommandType.END_PHASE,
      playerId: PLAYER1,
      timestamp: 1_700_000_000_002,
    });
    expect(executeCommandSpy.mock.calls[0]![0].idempotencyKey).toMatch(/^ai-.+:main-action$/);
    expect(session.state!.currentPhase).toBe(GamePhase.MAIN_PHASE);
    expect(session.getActivePlayerId()).toBe(PLAYER2);
  });

  it('FREE 模式不枚举 MAIN_ACTION 也不调用决策器', async () => {
    const session = createMainPhaseSession();
    expect(session.setManualOperationMode('FREE').success).toBe(true);
    const decide = vi.fn<AiDecisionProviderV2['decide']>();

    const result = await new AiTurnCoordinator({
      session,
      provider: { decide },
    }).advanceOne(PLAYER1);

    expect(result).toMatchObject({ status: 'UNAVAILABLE' });
    expect(session.getLegalRulesMainActions(PLAYER1)).toEqual([]);
    expect(decide).not.toHaveBeenCalled();
  });

  it('拒绝畸形、额外字段和未知 MAIN_ACTION token 且不执行命令', async () => {
    const malformedDecisionFactories: readonly ((request: AiDecisionRequestV2) => unknown)[] = [
      (request) => ({
        ...createMainActionDecisionV2(request, 'action-999'),
      }),
      (request) => ({
        ...createMainActionDecisionV2(request, getMainActionToken(request, 'END_MAIN_PHASE')),
        targetSlot: SlotPosition.RIGHT,
      }),
      (request) => ({
        ...createMainActionDecisionV2(request, getMainActionToken(request, 'END_MAIN_PHASE')),
        selectedCardTokens: [],
      }),
      (request) => ({
        schemaVersion: request.schemaVersion,
        decisionId: request.decisionId,
        contextDigest: request.contextDigest,
        kind: 'MAIN_ACTION',
        selectedActionToken: null,
      }),
      (request) => ({
        ...createMainActionDecisionV2(request, getMainActionToken(request, 'END_MAIN_PHASE')),
        contextDigest: 'sha256:forged',
      }),
    ];

    for (const createMalformedDecision of malformedDecisionFactories) {
      const session = createMainPhaseSession();
      const before = toTransport(session.state);
      const commandCountBefore = session.getCommandLogSince(0).length;
      const provider: AiDecisionProviderV2 = {
        decide(request) {
          return Promise.resolve(createMalformedDecision(request) as AiDecisionV2);
        },
      };

      const result = await new AiTurnCoordinator({ session, provider }).advanceOne(PLAYER1);

      expect(result.status).toBe('REJECTED');
      expect(toTransport(session.state)).toEqual(before);
      expect(session.getCommandLogSince(0)).toHaveLength(commandCountBefore);
    }
  });

  it('等待 MAIN_ACTION 期间主要阶段状态变化时丢弃过期结果', async () => {
    const session = createMainPhaseSession();
    let releaseDecision!: (decision: AiDecisionV2) => void;
    let pendingRequest!: AiDecisionRequestV2;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const provider: AiDecisionProviderV2 = {
      async decide(request) {
        pendingRequest = request;
        markStarted();
        return await new Promise<AiDecisionV2>((resolve) => {
          releaseDecision = resolve;
        });
      },
    };
    const pendingResult = new AiTurnCoordinator({ session, provider }).advanceOne(PLAYER1);
    await started;

    expect(session.executeCommand(createEndPhaseCommand(PLAYER1)).success).toBe(true);
    const afterLegitimateCommand = toTransport(session.state);
    releaseDecision(
      createMainActionDecisionV2(
        pendingRequest,
        getMainActionToken(pendingRequest, 'END_MAIN_PHASE')
      )
    );

    await expect(pendingResult).resolves.toMatchObject({ status: 'STALE' });
    expect(toTransport(session.state)).toEqual(afterLegitimateCommand);
    expect(session.state!.currentPhase).toBe(GamePhase.MAIN_PHASE);
    expect(session.getActivePlayerId()).toBe(PLAYER2);
  });

  it('等待 MAIN_ACTION 期间同一行动者登场成员后拒绝旧 token', async () => {
    const session = createMainPhaseSession();
    let releaseDecision!: (decision: AiDecisionV2) => void;
    let pendingRequest!: AiDecisionRequestV2;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const provider: AiDecisionProviderV2 = {
      async decide(request) {
        pendingRequest = request;
        markStarted();
        return await new Promise<AiDecisionV2>((resolve) => {
          releaseDecision = resolve;
        });
      },
    };
    const pendingResult = new AiTurnCoordinator({ session, provider }).advanceOne(PLAYER1);
    await started;

    const playAction = session
      .getLegalRulesMainActions(PLAYER1)
      .find(
        (candidate) => candidate.kind === 'PLAY_MEMBER_TO_SLOT' && candidate.playMode === 'EMPTY'
      );
    if (!playAction || playAction.kind !== 'PLAY_MEMBER_TO_SLOT') {
      throw new Error('测试前置条件失败：缺少空成员区登场候选');
    }
    expect(
      session.executeCommand(
        createPlayMemberToSlotCommand(
          PLAYER1,
          playAction.binding.cardId,
          playAction.binding.targetSlot
        )
      ).success
    ).toBe(true);
    const afterLegitimateCommand = toTransport(session.state);
    releaseDecision(
      createMainActionDecisionV2(
        pendingRequest,
        getMainActionToken(pendingRequest, 'END_MAIN_PHASE')
      )
    );

    await expect(pendingResult).resolves.toMatchObject({ status: 'STALE' });
    expect(toTransport(session.state)).toEqual(afterLegitimateCommand);
    expect(session.state!.currentPhase).toBe(GamePhase.MAIN_PHASE);
    expect(session.getActivePlayerId()).toBe(PLAYER1);
  });

  it('未知玩家返回不可用，不会调用决策器', async () => {
    const session = createMulliganSession();
    const decide = vi.fn<AiDecisionProviderV2['decide']>();
    const provider: AiDecisionProviderV2 = { decide };

    const result = await new AiTurnCoordinator({ session, provider }).advanceOne('missing-player');

    expect(result.status).toBe('UNAVAILABLE');
    expect(decide).not.toHaveBeenCalled();
  });

  it('决策器即使忽略取消信号也会超时返回', async () => {
    const session = createMulliganSession();
    let providerSignal: AbortSignal | undefined;
    let releaseDecision!: (decision: AiDecisionV2) => void;
    let pendingRequest!: AiDecisionRequestV2;
    const provider: AiDecisionProviderV2 = {
      decide(request, signal) {
        pendingRequest = request;
        providerSignal = signal;
        return new Promise<AiDecisionV2>((resolve) => {
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
    releaseDecision(createMulliganDecisionV2(pendingRequest));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(toTransport(session.state)).toEqual(afterTimeout);
    expect(session.getCommandLogSince(0)).toHaveLength(0);
  });

  it('外部取消会立即返回、释放单飞锁，且迟到结果不会执行', async () => {
    const session = createMulliganSession();
    const abortController = new AbortController();
    let decideCallCount = 0;
    let releaseFirstDecision!: (decision: AiDecisionV2) => void;
    let firstRequest!: AiDecisionRequestV2;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const provider: AiDecisionProviderV2 = {
      decide(request) {
        decideCallCount += 1;
        if (decideCallCount === 1) {
          firstRequest = request;
          markStarted();
          return new Promise<AiDecisionV2>((resolve) => {
            releaseFirstDecision = resolve;
          });
        }
        return Promise.resolve(createMulliganDecisionV2(request));
      },
    };
    const coordinator = new AiTurnCoordinator({ session, provider });
    const abortedResult = coordinator.advanceOne(PLAYER1, { signal: abortController.signal });
    await started;

    abortController.abort();
    await expect(abortedResult).resolves.toMatchObject({ status: 'ABORTED' });
    await expect(coordinator.advanceOne(PLAYER1)).resolves.toMatchObject({ status: 'EXECUTED' });
    expect(session.getCommandLogSince(0)).toHaveLength(1);

    releaseFirstDecision(createMulliganDecisionV2(firstRequest));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(session.getCommandLogSince(0)).toHaveLength(1);
  });

  it('同一 AI 席位只允许一个在途决策', async () => {
    const session = createMulliganSession();
    let releaseDecision!: (decision: AiDecisionV2) => void;
    let markStarted!: () => void;
    let pendingRequest!: AiDecisionRequestV2;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const decide = vi.fn<AiDecisionProviderV2['decide']>(async (request) => {
      pendingRequest = request;
      markStarted();
      return await new Promise<AiDecisionV2>((resolve) => {
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

    releaseDecision(createMulliganDecisionV2(pendingRequest));
    await expect(firstResult).resolves.toMatchObject({ status: 'EXECUTED' });
  });

  it('非当前操作席位不会获得AI换牌窗口', async () => {
    const session = createMulliganSession();
    let providerCalled = false;
    const provider: AiDecisionProviderV2 = {
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
