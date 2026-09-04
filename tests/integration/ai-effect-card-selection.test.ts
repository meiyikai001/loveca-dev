import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AiDecisionProviderV2,
  AiDecisionRequestV2,
  AiDecisionV2,
} from '../../src/application/ai/ai-decision-contract';
import {
  createConfirmEffectStepCommand,
  createPlayMemberToSlotCommand,
  GameCommandType,
} from '../../src/application/game-commands';
import { createGameSession } from '../../src/application/game-session';
import {
  createCardInstance,
  createHeartIcon,
  createHeartRequirement,
  type CardInstance,
  type LiveCardData,
  type MemberCardData,
} from '../../src/domain/entities/card';
import { registerCards, updatePlayer, type GameState } from '../../src/domain/entities/game';
import { placeCardInSlot } from '../../src/domain/entities/zone';
import { toTransport } from '../../src/online/serde';
import { AiTurnCoordinator } from '../../src/server/services/ai-turn-coordinator';
import {
  CardType,
  FaceState,
  GamePhase,
  HeartColor,
  OrientationState,
  SlotPosition,
  SubPhase,
  TurnType,
} from '../../src/shared/types/enums';
import { confirmPublicSelectionIfNeeded } from '../helpers/public-card-selection-confirmation';

const AI = 'selection-private-ai';
const OTHER = 'selection-private-other';
type Session = ReturnType<typeof createGameSession>;
type SelectionRequest = AiDecisionRequestV2 & {
  readonly window: Extract<AiDecisionRequestV2['window'], { kind: 'EFFECT_CARD_SELECTION' }>;
};

afterEach(() => vi.restoreAllMocks());

function member(cardCode: string, cost = 1, unitName?: string): CardInstance {
  const data: MemberCardData = {
    cardCode,
    name: cardCode,
    cardType: CardType.MEMBER,
    cost,
    blade: 1,
    hearts: [createHeartIcon(HeartColor.GREEN, 1)],
    groupNames: ['蓮ノ空女学院スクールアイドルクラブ'],
    ...(unitName ? { unitName } : {}),
  };
  return createCardInstance(data, AI, `private-selection-${cardCode}`);
}

function live(cardCode: string): CardInstance {
  const data: LiveCardData = {
    cardCode,
    name: cardCode,
    cardType: CardType.LIVE,
    score: 2,
    requirements: createHeartRequirement({ [HeartColor.GREEN]: 2 }),
    groupNames: ['蓮ノ空女学院スクールアイドルクラブ'],
  };
  return createCardInstance(data, AI, `private-selection-${cardCode}`);
}

/** Only the initial board is seeded; all card workflows below start with real RULES commands. */
function scenario(options: {
  source: CardInstance;
  sourceOnStage?: boolean;
  hand?: readonly CardInstance[];
  waiting?: readonly CardInstance[];
  top?: readonly CardInstance[];
  energy?: number;
}) {
  const session = createGameSession({ randomInt: (maxExclusive) => maxExclusive - 1 });
  session.createGame('private-card-selection-game', AI, 'AI', OTHER, 'Other');
  const energies = Array.from({ length: options.energy ?? 12 }, (_, index) =>
    createCardInstance(
      { cardCode: `SELECT-ENERGY-${index}`, name: `Energy ${index}`, cardType: CardType.ENERGY },
      AI,
      `private-selection-energy-${index}`
    )
  );
  const remainder = [member('UNKNOWN-DECK-A'), member('UNKNOWN-DECK-B')];
  const opponentHand = createCardInstance(
    member('OPPONENT-SECRET').data,
    OTHER,
    'private-opponent-secret-instance'
  );
  const top = [...(options.top ?? []), ...remainder];
  let state = registerCards(session.state!, [
    options.source,
    ...energies,
    ...top,
    ...(options.hand ?? []),
    ...(options.waiting ?? []),
    opponentHand,
  ]);
  state = {
    ...state,
    currentPhase: GamePhase.MAIN_PHASE,
    currentSubPhase: SubPhase.NONE,
    currentTurnType: TurnType.FIRST_PLAYER_TURN,
    activePlayerIndex: 0,
    waitingPlayerId: null,
  };
  state = updatePlayer(state, AI, (player) => ({
    ...player,
    hand: {
      ...player.hand,
      cardIds: [
        ...(options.sourceOnStage ? [] : [options.source.instanceId]),
        ...(options.hand ?? []).map((card) => card.instanceId),
      ],
    },
    waitingRoom: {
      ...player.waitingRoom,
      cardIds: (options.waiting ?? []).map((card) => card.instanceId),
    },
    mainDeck: { ...player.mainDeck, cardIds: top.map((card) => card.instanceId) },
    memberSlots: options.sourceOnStage
      ? placeCardInSlot(player.memberSlots, SlotPosition.CENTER, options.source.instanceId, {
          orientation: OrientationState.ACTIVE,
          face: FaceState.FACE_UP,
        })
      : player.memberSlots,
    energyZone: {
      ...player.energyZone,
      cardIds: energies.map((card) => card.instanceId),
      cardStates: new Map(
        energies.map((card) => [
          card.instanceId,
          { orientation: OrientationState.ACTIVE, face: FaceState.FACE_UP },
        ])
      ),
    },
  }));
  state = updatePlayer(state, OTHER, (player) => ({
    ...player,
    hand: { ...player.hand, cardIds: [opponentHand.instanceId] },
  }));
  setState(session, state);
  return { session, energies, remainder, opponentHand };
}

function setState(session: Session, state: GameState) {
  (session as unknown as { authorityState: GameState }).authorityState = state;
}

function play(session: Session, source: CardInstance, relay = false) {
  expect(
    session.executeCommand(
      createPlayMemberToSlotCommand(AI, source.instanceId, SlotPosition.CENTER, {
        ...(relay ? { relayMode: 'SINGLE' } : {}),
      })
    ).success
  ).toBe(true);
  expect(session.state!.activeEffect).not.toBeNull();
}

function assertSelection(request: AiDecisionRequestV2): asserts request is SelectionRequest {
  if (request.window.kind !== 'EFFECT_CARD_SELECTION')
    throw new Error(`Expected card selection, received ${request.window.kind}`);
}

function select(request: AiDecisionRequestV2, codes: readonly string[]): AiDecisionV2 {
  assertSelection(request);
  return {
    schemaVersion: request.schemaVersion,
    decisionId: request.decisionId,
    contextDigest: request.contextDigest,
    kind: 'EFFECT_CARD_SELECTION',
    choice: 'SELECT',
    selectedCardTokens: codes.map((code) => {
      const candidate = request.window.candidates.find((item) => item.card.cardCode === code);
      if (!candidate) throw new Error(`Missing visible candidate ${code}`);
      return candidate.cardToken;
    }),
  };
}

function skip(request: AiDecisionRequestV2): AiDecisionV2 {
  assertSelection(request);
  return {
    schemaVersion: request.schemaVersion,
    decisionId: request.decisionId,
    contextDigest: request.contextDigest,
    kind: 'EFFECT_CARD_SELECTION',
    choice: 'SKIP',
  };
}

function action(request: AiDecisionRequestV2, code?: string): AiDecisionV2 {
  if (request.window.kind !== 'MAIN_ACTION' && request.window.kind !== 'EFFECT_STEP')
    throw new Error('Expected simple action');
  const candidate = request.window.candidates.find((item) => {
    if (item.kind === 'ACTIVATE_ABILITY') return code === undefined;
    if (item.kind === 'SELECT_CARD') return item.card.cardCode === code;
    if (item.kind === 'SELECT_OPTION') return item.label.includes('支付');
    return item.kind === 'SELECT_SLOT';
  });
  if (!candidate) throw new Error('Missing simple action');
  return {
    schemaVersion: request.schemaVersion,
    decisionId: request.decisionId,
    contextDigest: request.contextDigest,
    kind: request.window.kind,
    selectedActionToken: candidate.actionToken,
  };
}

async function advance(session: Session, choose: (request: AiDecisionRequestV2) => AiDecisionV2) {
  let received!: AiDecisionRequestV2;
  const result = await new AiTurnCoordinator({
    session,
    provider: {
      decide(request) {
        received = request;
        return Promise.resolve(choose(request));
      },
    },
  }).advanceOne(AI);
  expect(result).toMatchObject({ status: 'EXECUTED' });
  return received;
}

async function capture(session: Session) {
  let received!: AiDecisionRequestV2;
  expect(
    await new AiTurnCoordinator({
      session,
      createDecisionId: () => 'fixed-selection-decision',
      provider: {
        decide(request) {
          received = request;
          return Promise.resolve(null);
        },
      },
    }).advanceOne(AI)
  ).toMatchObject({ status: 'NO_DECISION' });
  assertSelection(received);
  return received;
}

function activeEnergy(session: Session) {
  return [...session.state!.players[0].energyZone.cardStates.values()].filter(
    (state) => state.orientation === OrientationState.ACTIVE
  ).length;
}

async function ginkoRecovery(onlyLive = false) {
  const source = member('PL!HS-pb1-020-N', 9);
  const discards = [member('DISCARD-A'), member('DISCARD-B')];
  const recover = member('CERISE-RECOVER', 3, 'スリーズブーケ');
  const lives = [live('RECOVER-LIVE-A'), live('RECOVER-LIVE-B'), live('RECOVER-LIVE-C')];
  const { session } = scenario({
    source,
    hand: discards,
    waiting: [...(onlyLive ? [] : [recover]), ...lives],
  });
  play(session, source);
  const discardRequest = await advance(session, (request) =>
    select(
      request,
      discards.map((card) => card.data.cardCode)
    )
  );
  return { session, source, discards, recover, lives, discardRequest };
}

async function kahoRecovery() {
  const source = member('PL!HS-bp6-017-N', 11);
  const replacement = member('PLAIN-RELAY-REPLACEMENT', 12);
  const discard = member('KAHO-DISCARD');
  const targetLive = live('KAHO-RECOVER-LIVE');
  const { session } = scenario({
    source,
    sourceOnStage: true,
    hand: [replacement, discard],
    waiting: [targetLive],
    energy: 1,
  });
  play(session, replacement, true);
  await advance(session, (request) => action(request, discard.data.cardCode));
  return { session, source, replacement, discard, targetLive };
}

function kasumiInspection() {
  const source = member('PL!N-bp1-002-P', 2);
  const top = [member('INSPECT-A'), member('INSPECT-B'), member('INSPECT-C')];
  const seeded = scenario({ source, top, energy: 2 });
  play(seeded.session, source);
  return { ...seeded, source, top };
}

async function yoshikoSelection(count = 2) {
  const source = member('PL!S-bp2-006-P', 11);
  const expensive = Array.from({ length: count }, (_, index) => member(`COST-THREE-${index}`, 3));
  const cheap = member('COST-ONE', 1);
  const { session } = scenario({ source, waiting: [...expensive, cheap], energy: 15 });
  play(session, source);
  expect(activeEnergy(session)).toBe(4);
  await advance(session, (request) => action(request));
  expect(activeEnergy(session)).toBe(0);
  expect(session.state!.activeEffect?.stepId).toBe('YOSHIKO_SELECT_WAITING_ROOM_LOW_COST_MEMBERS');
  return { session, source, expensive, cheap };
}

describe('AI authoritative ordered and grouped card selections', () => {
  it('9 费百生吟子真实登场弃二，再分别回收成员与 LIVE，公开停留不由 AI 越过', async () => {
    const { session, discards, recover, lives, discardRequest } = await ginkoRecovery();
    expect(discardRequest.window).toMatchObject({
      kind: 'EFFECT_CARD_SELECTION',
      minSelections: 2,
      maxSelections: 2,
      canSkip: true,
    });
    expect(session.state!.players[0].waitingRoom.cardIds).toEqual(
      expect.arrayContaining(discards.map((card) => card.instanceId))
    );
    const request = await capture(session);
    expect(request.window.groups).toHaveLength(2);
    expect(request.window.groups!.map(({ minCount, maxCount }) => [minCount, maxCount])).toEqual([
      [1, 1],
      [1, 1],
    ]);
    expect(request.window.canSkip).toBe(false);
    await advance(session, (received) =>
      select(received, [recover.data.cardCode, lives[0]!.data.cardCode])
    );
    expect(session.state!.activeEffect?.publicCardSelectionAutoAdvanceAt).toBeDefined();
    expect(session.state!.players[0].hand.cardIds).toEqual([]);
    const decide = vi.fn<AiDecisionProviderV2['decide']>();
    const before = toTransport(session.state);
    expect(
      (await new AiTurnCoordinator({ session, provider: { decide } }).advanceOne(AI)).status
    ).toBe('UNAVAILABLE');
    expect(decide).not.toHaveBeenCalled();
    expect(toTransport(session.state)).toEqual(before);
    confirmPublicSelectionIfNeeded(session);
    expect(session.state!.players[0].hand.cardIds).toEqual([
      recover.instanceId,
      lives[0]!.instanceId,
    ]);
    expect(session.state!.activeEffect).toBeNull();
    expect(session.state!.currentPhase).toBe(GamePhase.MAIN_PHASE);
  });

  it('分组回收仅余一类时仍保留组约束，不降级到普通 exact 1 单选', async () => {
    const { session, lives } = await ginkoRecovery(true);
    const request = await capture(session);
    expect(request.window).toMatchObject({ minSelections: 1, maxSelections: 1, canSkip: false });
    expect(request.window.groups).toHaveLength(2);
    await advance(session, (received) => select(received, [lives[0]!.data.cardCode]));
    confirmPublicSelectionIfNeeded(session);
    expect(session.state!.players[0].hand.cardIds).toEqual([lives[0]!.instanceId]);
  });

  it('11 费日野下花帆通过真实换人离场，弃一后回收自己与 LIVE', async () => {
    const { session, source, replacement, discard, targetLive } = await kahoRecovery();
    const request = await capture(session);
    expect(request.window).toMatchObject({ minSelections: 0, maxSelections: 2, canSkip: true });
    expect(request.window.groups!.map(({ minCount, maxCount }) => [minCount, maxCount])).toEqual([
      [0, 1],
      [0, 1],
    ]);
    await advance(session, (received) =>
      select(received, [source.data.cardCode, targetLive.data.cardCode])
    );
    confirmPublicSelectionIfNeeded(session);
    expect(session.state!.players[0].hand.cardIds).toEqual([
      source.instanceId,
      targetLive.instanceId,
    ]);
    expect(session.state!.players[0].waitingRoom.cardIds).toEqual([discard.instanceId]);
    expect(session.state!.players[0].memberSlots.slots.CENTER).toBe(replacement.instanceId);
  });

  it.each(['SELECT', 'SKIP'] as const)(
    '可选回收的 %s 保留空数组与显式跳过的命令差异',
    async (choice) => {
      const { session, source, discard, targetLive } = await kahoRecovery();
      const execute = vi.spyOn(session, 'executeCommand');
      await advance(session, (request) =>
        choice === 'SELECT' ? select(request, []) : skip(request)
      );
      expect(execute).toHaveBeenCalledTimes(1);
      const command = execute.mock.calls[0]![0];
      expect(command.type).toBe(GameCommandType.CONFIRM_EFFECT_STEP);
      if (command.type !== GameCommandType.CONFIRM_EFFECT_STEP)
        throw new Error('Unexpected command');
      expect(command.selectedCardIds).toEqual(choice === 'SELECT' ? [] : undefined);
      expect(command.selectedCardId).toBe(choice === 'SKIP' ? null : undefined);
      expect(session.state!.activeEffect).toBeNull();
      expect(session.state!.players[0].waitingRoom.cardIds).toEqual(
        expect.arrayContaining([source.instanceId, discard.instanceId, targetLive.instanceId])
      );
    }
  );

  it('11 费村野沙耶香声明后显式选择两张特殊能量，再用原单选流程复活自身', async () => {
    const source = member('PL!HS-bp1-002-RM', 11);
    const { session, energies } = scenario({ source, sourceOnStage: true, energy: 4 });
    setState(session, {
      ...session.state!,
      energyActivePhaseSkips: [
        {
          playerId: AI,
          energyCardId: energies[0]!.instanceId,
          sourceCardId: source.instanceId,
          abilityId: 'private-energy-marker',
        },
      ],
    });
    await advance(session, (request) => action(request));
    expect(activeEnergy(session)).toBe(4);
    const request = await advance(session, (received) =>
      select(received, [energies[2]!.data.cardCode, energies[3]!.data.cardCode])
    );
    expect(request.window).toMatchObject({
      kind: 'EFFECT_CARD_SELECTION',
      minSelections: 2,
      maxSelections: 2,
      canSkip: false,
    });
    expect(activeEnergy(session)).toBe(2);
    expect(
      session.state!.players[0].energyZone.cardStates.get(energies[0]!.instanceId)?.orientation
    ).toBe(OrientationState.ACTIVE);
    expect(
      session.state!.players[0].energyZone.cardStates.get(energies[2]!.instanceId)?.orientation
    ).toBe(OrientationState.WAITING);
    expect(session.state!.players[0].memberSlots.slots.CENTER).toBeNull();
    const revival = await advance(session, (received) => action(received, source.data.cardCode));
    expect(revival.window.kind).toBe('EFFECT_STEP');
    expect(session.state!.players[0].memberSlots.slots.CENTER).toBe(source.instanceId);
    expect(session.state!.activeEffect).toBeNull();
  });

  it('2 费中须霞看顶三张保留反序的两张，未选择牌进入休息室', async () => {
    const { session, top, remainder } = kasumiInspection();
    const request = await advance(session, (received) =>
      select(received, [top[1]!.data.cardCode, top[0]!.data.cardCode])
    );
    expect(request.window).toMatchObject({
      minSelections: 0,
      maxSelections: 3,
      ordered: true,
      canSkip: false,
    });
    expect(session.state!.players[0].mainDeck.cardIds).toEqual([
      top[1]!.instanceId,
      top[0]!.instanceId,
      ...remainder.map((card) => card.instanceId),
    ]);
    expect(session.state!.players[0].waitingRoom.cardIds).toEqual([top[2]!.instanceId]);
    expect(session.state!.activeEffect).toBeNull();
  });

  it('看顶排序允许 SELECT [] 全弃，但没有凭空授予 SKIP', async () => {
    const { session, top, remainder } = kasumiInspection();
    const before = toTransport(session.state);
    const execute = vi.spyOn(session, 'executeCommand');
    const result = await new AiTurnCoordinator({
      session,
      provider: { decide: (request) => Promise.resolve(skip(request)) },
    }).advanceOne(AI);
    expect(result.status).toBe('REJECTED');
    expect(execute).not.toHaveBeenCalled();
    expect(toTransport(session.state)).toEqual(before);
    await advance(session, (request) => select(request, []));
    expect(session.state!.players[0].mainDeck.cardIds).toEqual(
      remainder.map((card) => card.instanceId)
    );
    expect(session.state!.players[0].waitingRoom.cardIds).toEqual(
      top.map((card) => card.instanceId)
    );
  });

  it.each([
    'duplicate',
    'unknown',
    'raw-id',
    'under-count',
    'over-count',
    'same-group',
    'non-array',
    'mixed-fields',
    'skip-array',
  ] as const)('真实分组窗口拒绝 %s 输入且不调用权威命令', async (attack) => {
    const { session, recover, lives } = await ginkoRecovery();
    const before = toTransport(session.state);
    const execute = vi.spyOn(session, 'executeCommand');
    const provider: AiDecisionProviderV2 = {
      decide(request) {
        assertSelection(request);
        const valid = select(request, [recover.data.cardCode, lives[0]!.data.cardCode]);
        if (valid.kind !== 'EFFECT_CARD_SELECTION' || valid.choice !== 'SELECT')
          throw new Error('Expected SELECT');
        const tokens = valid.selectedCardTokens;
        const otherLive = request.window.candidates.find(
          (item) => item.card.cardCode === lives[1]!.data.cardCode
        )!.cardToken;
        let malformed: unknown;
        switch (attack) {
          case 'duplicate':
            malformed = { ...valid, selectedCardTokens: [tokens[0], tokens[0]] };
            break;
          case 'unknown':
            malformed = { ...valid, selectedCardTokens: [tokens[0], 'unknown-token'] };
            break;
          case 'raw-id':
            malformed = {
              ...valid,
              selectedCardTokens: [recover.instanceId, lives[0]!.instanceId],
            };
            break;
          case 'under-count':
            malformed = { ...valid, selectedCardTokens: [tokens[0]] };
            break;
          case 'over-count':
            malformed = { ...valid, selectedCardTokens: [...tokens, otherLive] };
            break;
          case 'same-group':
            malformed = { ...valid, selectedCardTokens: [tokens[1], otherLive] };
            break;
          case 'non-array':
            malformed = { ...valid, selectedCardTokens: tokens[0] };
            break;
          case 'mixed-fields':
            malformed = {
              ...valid,
              selectedCardIds: [recover.instanceId, lives[0]!.instanceId],
              selectedActionToken: tokens[0],
            };
            break;
          case 'skip-array':
            malformed = { ...skip(request), selectedCardTokens: [] };
            break;
        }
        return Promise.resolve(malformed as AiDecisionV2);
      },
    };
    expect((await new AiTurnCoordinator({ session, provider }).advanceOne(AI)).status).toBe(
      'REJECTED'
    );
    expect(execute).not.toHaveBeenCalled();
    expect(toTransport(session.state)).toEqual(before);
  });

  it('只披露当前合法检视候选，未知牌序与对手手牌身份不改变输入和摘要', async () => {
    const { session, top, remainder, opponentHand } = kasumiInspection();
    const baseline = await capture(session);
    expect(baseline.window.candidates.map((item) => item.card.cardCode)).toEqual(
      top.map((card) => card.data.cardCode)
    );
    const alternative = createCardInstance(
      member('OTHER-CHANGED-SECRET', 99).data,
      OTHER,
      'private-changed-opponent'
    );
    let state = registerCards(session.state!, [alternative]);
    state = updatePlayer(state, AI, (player) => ({
      ...player,
      mainDeck: { ...player.mainDeck, cardIds: [...player.mainDeck.cardIds].reverse() },
    }));
    state = updatePlayer(state, OTHER, (player) => ({
      ...player,
      hand: { ...player.hand, cardIds: [alternative.instanceId] },
    }));
    setState(session, state);
    expect(await capture(session)).toEqual(baseline);
    const wire = JSON.stringify(baseline);
    for (const card of [...remainder, opponentHand, alternative]) {
      expect(wire).not.toContain(card.data.cardCode);
      expect(wire).not.toContain(card.instanceId);
    }
    for (const card of top) expect(wire).not.toContain(card.instanceId);
    expect(wire).not.toContain(AI);
    expect(wire).not.toContain(OTHER);
  });

  it('provider 在途时同一效果推进到下一步，旧多选响应失效', async () => {
    const source = member('PL!HS-pb1-020-N', 9);
    const discards = [member('STALE-A'), member('STALE-B')];
    const { session } = scenario({
      source,
      hand: discards,
      waiting: [live('STALE-LIVE-A'), live('STALE-LIVE-B'), live('STALE-LIVE-C')],
    });
    play(session, source);
    let release!: (decision: AiDecisionV2) => void;
    let started!: () => void;
    let request!: AiDecisionRequestV2;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new AiTurnCoordinator({
      session,
      provider: {
        decide(received) {
          request = received;
          started();
          return new Promise<AiDecisionV2>((resolve) => {
            release = resolve;
          });
        },
      },
    }).advanceOne(AI);
    await ready;
    const effectId = session.state!.activeEffect!.id;
    const stepId = session.state!.activeEffect!.stepId;
    expect(
      session.executeCommand(
        createConfirmEffectStepCommand(
          AI,
          effectId,
          undefined,
          undefined,
          undefined,
          undefined,
          discards.map((card) => card.instanceId)
        )
      ).success
    ).toBe(true);
    expect(session.state!.activeEffect!.id).toBe(effectId);
    expect(session.state!.activeEffect!.stepId).not.toBe(stepId);
    const before = toTransport(session.state);
    const execute = vi.spyOn(session, 'executeCommand');
    release(
      select(
        request,
        discards.map((card) => card.data.cardCode)
      )
    );
    expect((await pending).status).toBe('STALE');
    expect(execute).not.toHaveBeenCalled();
    expect(toTransport(session.state)).toEqual(before);
  });

  it('11 费津岛善子已付四能量后，合计六费组合真实拒绝；记忆匿名失败组合后可改选完成', async () => {
    const { session, source, expensive, cheap } = await yoshikoSelection();
    const invalid = expensive.map((card) => card.data.cardCode);
    let selected = invalid;
    const requests: SelectionRequest[] = [];
    const provider: AiDecisionProviderV2 = {
      decide(request) {
        assertSelection(request);
        requests.push(request);
        return Promise.resolve(select(request, selected));
      },
    };
    const coordinator = new AiTurnCoordinator({ session, provider });
    const execute = vi.spyOn(session, 'executeCommand');
    const before = session.state;
    expect(await coordinator.advanceOne(AI)).toMatchObject({
      status: 'REJECTED',
      reason: '选牌声明未执行，当前局面下请改选其他组合',
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(session.state).toBe(before);
    expect(activeEnergy(session)).toBe(0);
    expect(session.state!.players[0].memberSlots.slots.CENTER).toBe(source.instanceId);
    expect((await coordinator.advanceOne(AI)).status).toBe('REJECTED');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests[1]!.window.rejectedSelections).toEqual([
      requests[1]!.window.candidates
        .filter((item) => invalid.includes(item.card.cardCode))
        .map((item) => item.cardToken),
    ]);
    expect(JSON.stringify(requests[1])).not.toContain(expensive[0]!.instanceId);
    selected = [expensive[0]!.data.cardCode, cheap.data.cardCode];
    expect((await coordinator.advanceOne(AI)).status).toBe('EXECUTED');
    expect(execute).toHaveBeenCalledTimes(2);
    await advance(session, (request) => action(request));
    await advance(session, (request) => action(request));
    expect(session.state!.players[0].memberSlots.slots.LEFT).toBe(expensive[0]!.instanceId);
    expect(session.state!.players[0].memberSlots.slots.RIGHT).toBe(cheap.instanceId);
    expect(session.state!.activeEffect).toBeNull();
    expect(activeEnergy(session)).toBe(0);
  });

  it('同局面实际拒绝满 32 个组合后停止，已支付费用保持且不再调用 provider', async () => {
    const { session, expensive } = await yoshikoSelection(9);
    const pairs = expensive.flatMap((first, i) =>
      expensive.slice(i + 1).map((second) => [first.data.cardCode, second.data.cardCode])
    );
    let attempts = 0;
    const decide = vi.fn<AiDecisionProviderV2['decide']>((request) => {
      assertSelection(request);
      expect(request.window.rejectedSelections).toHaveLength(attempts);
      return Promise.resolve(select(request, pairs[attempts++]!));
    });
    const coordinator = new AiTurnCoordinator({ session, provider: { decide } });
    const execute = vi.spyOn(session, 'executeCommand');
    const state = session.state;
    for (let i = 0; i < 32; i++) expect((await coordinator.advanceOne(AI)).status).toBe('REJECTED');
    expect((await coordinator.advanceOne(AI)).status).toBe('UNAVAILABLE');
    expect((await coordinator.advanceOne(AI)).status).toBe('UNAVAILABLE');
    expect(decide).toHaveBeenCalledTimes(32);
    expect(execute).toHaveBeenCalledTimes(32);
    expect(session.state).toBe(state);
    expect(activeEnergy(session)).toBe(0);
  });
});
