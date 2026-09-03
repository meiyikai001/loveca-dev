import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type {
  AiDecisionRequestV2,
  AiDecisionV2,
  AiMainActionCandidateV2,
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
import { deterministicDebugAiProvider } from '../../src/server/services/deterministic-debug-ai-provider';
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

afterEach(() => {
  vi.restoreAllMocks();
  for (const matchId of MATCH_IDS) {
    resetDebugMatch(matchId);
  }
});

describe('deterministic remote debug AI provider', () => {
  it.each([
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
});

describe('remote debug AI turn service', () => {
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

type DebugMainActionCandidateKind = 'END' | 'SINGLE_RELAY' | 'EMPTY_SLOT';

function createMainActionCandidates(
  ...kinds: readonly DebugMainActionCandidateKind[]
): readonly AiMainActionCandidateV2[] {
  return kinds.map((kind): AiMainActionCandidateV2 => {
    switch (kind) {
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
): AiDecisionRequestV2 {
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
