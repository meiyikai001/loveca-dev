import { describe, expect, it } from 'vitest';
import type { DeckConfig } from '../../src/application/game-service';
import {
  createGameSession,
  type RulesMainActionCandidate,
} from '../../src/application/game-session';
import { GameCommandType } from '../../src/application/game-commands';
import {
  createHeartIcon,
  createHeartRequirement,
  type EnergyCardData,
  type LiveCardData,
  type MemberCardData,
} from '../../src/domain/entities/card';
import type { ActiveEffectState, GameState } from '../../src/domain/entities/game';
import {
  CardType,
  GamePhase,
  HeartColor,
  OrientationState,
  SlotPosition,
  SubPhase,
} from '../../src/shared/types/enums';

const PLAYER1 = 'player1';
const PLAYER2 = 'player2';
const SLOT_ORDER = [SlotPosition.LEFT, SlotPosition.CENTER, SlotPosition.RIGHT] as const;

interface MemberSpec {
  readonly cardCode: string;
  readonly cost: number;
}

interface StageMemberSpec {
  readonly slot: SlotPosition;
  readonly member: MemberSpec;
  readonly movedToStageThisTurn?: boolean;
}

interface MutablePlayerBoard {
  hand: { cardIds: string[] };
  mainDeck: { cardIds: string[] };
  energyDeck: { cardIds: string[] };
  energyZone: {
    cardIds: string[];
    cardStates: Map<string, { orientation: OrientationState }>;
  };
  memberSlots: {
    slots: Record<SlotPosition, string | null>;
    cardStates: Map<string, { orientation: OrientationState }>;
    energyBelow: Record<SlotPosition, string[]>;
    memberBelow: Record<SlotPosition, string[]>;
  };
  movedToStageThisTurn: string[];
  positionMovedThisTurn: string[];
}

interface ConfiguredBoard {
  readonly handCardIds: readonly string[];
  readonly stageCardIds: Readonly<Partial<Record<SlotPosition, string>>>;
}

function createMemberCard(spec: MemberSpec): MemberCardData {
  return {
    cardCode: spec.cardCode,
    name: spec.cardCode,
    cardType: CardType.MEMBER,
    cost: spec.cost,
    blade: 1,
    hearts: [createHeartIcon(HeartColor.PINK, 1)],
  };
}

function createDeck(prefix: string): DeckConfig {
  const mainDeck: Array<MemberCardData | LiveCardData> = [];
  const energyDeck: EnergyCardData[] = [];
  for (let index = 0; index < 48; index += 1) {
    mainDeck.push(createMemberCard({ cardCode: `${prefix}-MEM-${index}`, cost: 1 }));
  }
  for (let index = 0; index < 12; index += 1) {
    mainDeck.push({
      cardCode: `${prefix}-LIVE-${index}`,
      name: `${prefix} LIVE ${index}`,
      cardType: CardType.LIVE,
      score: 1,
      requirements: createHeartRequirement({ [HeartColor.PINK]: 1 }),
    });
    energyDeck.push({
      cardCode: `${prefix}-ENERGY-${index}`,
      name: `${prefix} Energy ${index}`,
      cardType: CardType.ENERGY,
    });
  }
  return { mainDeck, energyDeck };
}

function createMainPhaseSession() {
  const session = createGameSession();
  session.createGame('main-action-candidates', PLAYER1, 'Player 1', PLAYER2, 'Player 2');
  expect(session.initializeGame(createDeck('P1'), createDeck('P2')).success).toBe(true);

  const state = session.state! as GameState;
  const mutable = state as unknown as {
    currentPhase: GamePhase;
    currentSubPhase: SubPhase;
    activePlayerIndex: number;
    waitingPlayerId: string | null;
  };
  mutable.currentPhase = GamePhase.MAIN_PHASE;
  mutable.currentSubPhase = SubPhase.NONE;
  mutable.activePlayerIndex = 0;
  mutable.waitingPlayerId = null;
  return session;
}

function configurePlayer1Board(
  session: ReturnType<typeof createGameSession>,
  hand: readonly MemberSpec[],
  stage: readonly StageMemberSpec[] = []
): ConfiguredBoard {
  const state = session.state!;
  const player = state.players[0] as unknown as MutablePlayerBoard;
  const availableMemberIds = [...player.hand.cardIds, ...player.mainDeck.cardIds].filter(
    (cardId) => state.cardRegistry.get(cardId)?.data.cardType === CardType.MEMBER
  );
  const neededCount = hand.length + stage.length;
  expect(availableMemberIds.length).toBeGreaterThanOrEqual(neededCount);

  const selectedCardIds = availableMemberIds.slice(0, neededCount);
  const handCardIds = selectedCardIds.slice(0, hand.length);
  const stageCardIds: Partial<Record<SlotPosition, string>> = {};
  hand.forEach((spec, index) => replaceMemberData(state, handCardIds[index]!, spec));
  stage.forEach((entry, index) => {
    const cardId = selectedCardIds[hand.length + index]!;
    replaceMemberData(state, cardId, entry.member);
    stageCardIds[entry.slot] = cardId;
  });

  const selectedSet = new Set(selectedCardIds);
  player.hand.cardIds = [...handCardIds];
  player.mainDeck.cardIds = player.mainDeck.cardIds.filter((cardId) => !selectedSet.has(cardId));
  player.memberSlots.cardStates = new Map();
  player.movedToStageThisTurn = [];
  player.positionMovedThisTurn = [];
  for (const slot of SLOT_ORDER) {
    const stageEntry = stage.find((entry) => entry.slot === slot);
    const cardId = stageCardIds[slot] ?? null;
    player.memberSlots.slots[slot] = cardId;
    player.memberSlots.energyBelow[slot] = [];
    player.memberSlots.memberBelow[slot] = [];
    if (cardId) {
      player.memberSlots.cardStates.set(cardId, { orientation: OrientationState.ACTIVE });
      if (stageEntry?.movedToStageThisTurn) {
        player.movedToStageThisTurn.push(cardId);
      }
    }
  }

  return { handCardIds, stageCardIds };
}

function replaceMemberData(state: GameState, cardId: string, spec: MemberSpec): void {
  const card = state.cardRegistry.get(cardId);
  expect(card).toBeDefined();
  (card as unknown as { data: MemberCardData }).data = createMemberCard(spec);
}

function setActiveEnergyCount(session: ReturnType<typeof createGameSession>, count: number): void {
  const player = session.state!.players[0] as unknown as MutablePlayerBoard;
  const allEnergyCardIds = [...player.energyZone.cardIds, ...player.energyDeck.cardIds];
  const activeEnergyCardIds = allEnergyCardIds.slice(0, count);
  const activeSet = new Set(activeEnergyCardIds);
  player.energyZone.cardIds = activeEnergyCardIds;
  player.energyZone.cardStates = new Map(
    activeEnergyCardIds.map((cardId) => [cardId, { orientation: OrientationState.ACTIVE }])
  );
  player.energyDeck.cardIds = allEnergyCardIds.filter((cardId) => !activeSet.has(cardId));
}

function getPlayCandidates(
  session: ReturnType<typeof createGameSession>,
  cardId?: string
): Extract<RulesMainActionCandidate, { kind: 'PLAY_MEMBER_TO_SLOT' }>[] {
  return session
    .getRulesMainActionCandidates(PLAYER1)
    .filter(
      (
        candidate
      ): candidate is Extract<RulesMainActionCandidate, { kind: 'PLAY_MEMBER_TO_SLOT' }> =>
        candidate.kind === 'PLAY_MEMBER_TO_SLOT' &&
        (cardId === undefined || candidate.binding.cardId === cardId)
    );
}

describe('GameSession MAIN_ACTION 合法候选', () => {
  it('END 固定在前，随后按手牌×左中右枚举空槽与单换手', () => {
    const session = createMainPhaseSession();
    setActiveEnergyCount(session, 12);
    const { handCardIds } = configurePlayer1Board(
      session,
      [
        { cardCode: 'HAND-FIRST', cost: 5 },
        { cardCode: 'HAND-SECOND', cost: 4 },
      ],
      [
        {
          slot: SlotPosition.CENTER,
          member: { cardCode: 'CENTER-MEMBER', cost: 2 },
        },
      ]
    );

    const candidates = session.getRulesMainActionCandidates(PLAYER1);
    expect(
      candidates.map((candidate) =>
        candidate.kind === 'END_PHASE'
          ? 'END'
          : `${candidate.binding.cardId}:${candidate.binding.targetSlot}:${candidate.playMode}`
      )
    ).toEqual([
      'END',
      `${handCardIds[0]}:${SlotPosition.LEFT}:EMPTY`,
      `${handCardIds[0]}:${SlotPosition.CENTER}:SINGLE_RELAY`,
      `${handCardIds[0]}:${SlotPosition.RIGHT}:EMPTY`,
      `${handCardIds[1]}:${SlotPosition.LEFT}:EMPTY`,
      `${handCardIds[1]}:${SlotPosition.CENTER}:SINGLE_RELAY`,
      `${handCardIds[1]}:${SlotPosition.RIGHT}:EMPTY`,
    ]);

    const playCandidates = getPlayCandidates(session);
    for (const candidate of playCandidates) {
      if (candidate.playMode === 'EMPTY') {
        expect(Object.hasOwn(candidate.binding, 'relayMode')).toBe(false);
      } else {
        expect(candidate.binding.relayMode).toBe('SINGLE');
      }
    }
    expect(new Set(candidates.map((candidate) => candidate.binding.type))).toEqual(
      new Set([GameCommandType.END_PHASE, GameCommandType.PLAY_MEMBER_TO_SLOT])
    );
    const serialized = JSON.stringify(candidates);
    expect(serialized).not.toContain('"relayMode":"DOUBLE"');
    expect(serialized).not.toContain(GameCommandType.BEGIN_SPECIAL_MEMBER_PLAY);
    expect(serialized).not.toContain(GameCommandType.ACTIVATE_ABILITY);
  });

  it('过滤费用不足、零费换手、不可换手成员与刚登场槽位', () => {
    const insufficient = createMainPhaseSession();
    const insufficientBoard = configurePlayer1Board(insufficient, [
      { cardCode: 'TOO-EXPENSIVE', cost: 4 },
    ]);
    setActiveEnergyCount(insufficient, 0);
    expect(insufficient.getRulesMainActionCandidates(PLAYER1)).toEqual([
      {
        kind: 'END_PHASE',
        binding: { type: GameCommandType.END_PHASE, playerId: PLAYER1 },
      },
    ]);
    expect(getPlayCandidates(insufficient, insufficientBoard.handCardIds[0])).toEqual([]);

    const zeroCostRelay = createMainPhaseSession();
    const zeroCostBoard = configurePlayer1Board(
      zeroCostRelay,
      [{ cardCode: 'ZERO-COST', cost: 0 }],
      [
        {
          slot: SlotPosition.CENTER,
          member: { cardCode: 'ZERO-COST-TARGET', cost: 2 },
        },
      ]
    );
    setActiveEnergyCount(zeroCostRelay, 0);
    expect(
      getPlayCandidates(zeroCostRelay, zeroCostBoard.handCardIds[0]).map(
        (candidate) => candidate.binding.targetSlot
      )
    ).toEqual([SlotPosition.LEFT, SlotPosition.RIGHT]);

    const protectedRelay = createMainPhaseSession();
    const protectedBoard = configurePlayer1Board(
      protectedRelay,
      [{ cardCode: 'PROTECTED-INCOMING', cost: 2 }],
      [
        {
          slot: SlotPosition.CENTER,
          member: { cardCode: 'LL-bp2-001-R+', cost: 20 },
        },
      ]
    );
    setActiveEnergyCount(protectedRelay, 2);
    expect(
      getPlayCandidates(protectedRelay, protectedBoard.handCardIds[0]).map(
        (candidate) => candidate.binding.targetSlot
      )
    ).toEqual([SlotPosition.LEFT, SlotPosition.RIGHT]);

    const newlyEntered = createMainPhaseSession();
    const newlyEnteredBoard = configurePlayer1Board(
      newlyEntered,
      [{ cardCode: 'NEWLY-ENTERED-INCOMING', cost: 2 }],
      [
        {
          slot: SlotPosition.CENTER,
          member: { cardCode: 'NEWLY-ENTERED-TARGET', cost: 1 },
          movedToStageThisTurn: true,
        },
      ]
    );
    setActiveEnergyCount(newlyEntered, 2);
    expect(
      getPlayCandidates(newlyEntered, newlyEnteredBoard.handCardIds[0]).map(
        (candidate) => candidate.binding.targetSlot
      )
    ).toEqual([SlotPosition.LEFT, SlotPosition.RIGHT]);
  });

  it('FREE、非当前行动者、错误阶段与 pending 窗口均不暴露候选', () => {
    const free = createMainPhaseSession();
    expect(free.setManualOperationMode('FREE').success).toBe(true);
    expect(free.getRulesMainActionCandidates(PLAYER1)).toEqual([]);

    const wrongActor = createMainPhaseSession();
    expect(wrongActor.getRulesMainActionCandidates(PLAYER2)).toEqual([]);

    const wrongPhase = createMainPhaseSession();
    const wrongPhaseState = wrongPhase.state! as unknown as {
      currentPhase: GamePhase;
      currentSubPhase: SubPhase;
    };
    wrongPhaseState.currentPhase = GamePhase.DRAW_PHASE;
    wrongPhaseState.currentSubPhase = SubPhase.NONE;
    expect(wrongPhase.getRulesMainActionCandidates(PLAYER1)).toEqual([]);

    const pending = createMainPhaseSession();
    const activeEffect = {
      id: 'pending-effect',
      abilityId: 'pending-ability',
      sourceCardId: 'pending-source',
      controllerId: PLAYER1,
      effectText: '测试效果',
      stepId: 'PENDING',
      stepText: '请完成效果',
      awaitingPlayerId: PLAYER1,
    } satisfies ActiveEffectState;
    (pending.state! as unknown as { activeEffect: ActiveEffectState | null }).activeEffect =
      activeEffect;
    expect(pending.getRulesMainActionCandidates(PLAYER1)).toEqual([]);
  });
});
