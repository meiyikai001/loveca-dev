import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AiDecisionRequestV2,
  AiDecisionV2,
  AiMainActionObservationV2,
} from '../../src/application/ai/ai-decision-contract';
import { PB1_019_ACTIVATED_ABILITY_ID } from '../../src/application/card-effects/ability-ids';
import {
  createEndPhaseCommand,
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
import { addEnergyActivePhaseSkips } from '../../src/domain/rules/energy-active-skips';
import {
  addBladeLiveModifierForSourceMember,
  addHeartLiveModifierForSourceMember,
  addLiveModifier,
  addMemberCostLiveModifierForMember,
} from '../../src/domain/rules/live-modifiers';
import type { PlayerViewState, Seat, ViewZoneKey } from '../../src/online/types';
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

const FIRST = 'private-observation-first-player';
const SECOND = 'private-observation-second-player';
const SEATS = ['FIRST', 'SECOND'] as const;
const PUBLIC_SUFFIXES = [
  'WAITING_ROOM',
  'SUCCESS_ZONE',
  'EXILE_ZONE',
  'LIVE_ZONE',
  'INSPECTION_ZONE',
] as const;
type Session = ReturnType<typeof createGameSession>;

afterEach(() => vi.restoreAllMocks());

function member(code: string, ownerId = FIRST, cost = 3): CardInstance {
  const data: MemberCardData = {
    cardCode: code,
    name: code === 'PL!-sd1-002-SD' ? '绚濑绘里' : code,
    cardType: CardType.MEMBER,
    cost,
    blade: 2,
    hearts: [createHeartIcon(HeartColor.GREEN, 1)],
    groupNames: ["μ's"],
  };
  return createCardInstance(data, ownerId, `private-instance-${ownerId}-${code}`);
}

function live(code: string, ownerId: string): CardInstance {
  const data: LiveCardData = {
    cardCode: code,
    name: code,
    cardType: CardType.LIVE,
    score: 2,
    requirements: createHeartRequirement({ [HeartColor.GREEN]: 1 }),
  };
  return createCardInstance(data, ownerId, `private-instance-${ownerId}-${code}`);
}

function energy(code: string, ownerId: string): CardInstance {
  return createCardInstance(
    { cardCode: code, name: code, cardType: CardType.ENERGY },
    ownerId,
    `private-instance-${ownerId}-${code}`
  );
}

function setState(session: Session, state: GameState) {
  (session as unknown as { authorityState: GameState }).authorityState = state;
}

/** Initial zones are seeded locally; projections, candidates and subsequent commands are real. */
function scenario(viewer: Seat = 'FIRST') {
  const session = createGameSession({ randomInt: (maxExclusive) => maxExclusive - 1 });
  session.createGame('private-public-observation-game', FIRST, 'First', SECOND, 'Second');
  const sides = [FIRST, SECOND].map((ownerId, index) => {
    const prefix = SEATS[index]!;
    return {
      ownerId,
      source: member(index === 0 ? 'PL!-sd1-002-SD' : 'SECOND-STAGE', ownerId, 2),
      below: member(`${prefix}-BELOW`, ownerId, 9),
      overlay: energy(`${prefix}-OVERLAY`, ownerId),
      hand: [member(`${prefix}-HAND`, ownerId, 1)],
      deck: [0, 1, 2, 3, 4].map((n) => member(`${prefix}-UNSEEN-${n}`, ownerId)),
      energyDeck: [0, 1].map((n) => energy(`${prefix}-UNSEEN-ENERGY-${n}`, ownerId)),
      energies: [0, 1, 2].map((n) => energy(`${prefix}-ENERGY-${n}`, ownerId)),
      waiting: [member(`${prefix}-WAIT-B`, ownerId), member(`${prefix}-WAIT-A`, ownerId)],
      success: [live(`${prefix}-SUCCESS-A`, ownerId), live(`${prefix}-SUCCESS-B`, ownerId)],
      exile: member(`${prefix}-EXILE`, ownerId),
      live: [live(`${prefix}-LIVE-FRONT`, ownerId), live(`${prefix}-LIVE-BACK`, ownerId)],
      resolution: member(`${prefix}-PUBLIC-RESOLUTION`, ownerId),
    };
  });
  let state = session.state!;
  for (const side of sides) {
    state = registerCards(state, [
      side.source,
      side.below,
      side.overlay,
      ...side.hand,
      ...side.deck,
      ...side.energyDeck,
      ...side.energies,
      ...side.waiting,
      ...side.success,
      side.exile,
      ...side.live,
      side.resolution,
    ]);
    state = updatePlayer(state, side.ownerId, (player) => {
      const slots = placeCardInSlot(
        player.memberSlots,
        SlotPosition.CENTER,
        side.source.instanceId,
        { orientation: OrientationState.WAITING, face: FaceState.FACE_UP }
      );
      return {
        ...player,
        memberSlots: {
          ...slots,
          energyBelow: { ...slots.energyBelow, CENTER: [side.overlay.instanceId] },
          memberBelow: { ...slots.memberBelow, CENTER: [side.below.instanceId] },
        },
        hand: { ...player.hand, cardIds: side.hand.map((card) => card.instanceId) },
        mainDeck: { ...player.mainDeck, cardIds: side.deck.map((card) => card.instanceId) },
        energyDeck: {
          ...player.energyDeck,
          cardIds: side.energyDeck.map((card) => card.instanceId),
        },
        energyZone: {
          ...player.energyZone,
          cardIds: side.energies.map((card) => card.instanceId),
          cardStates: new Map(
            side.energies.map((card, index) => [
              card.instanceId,
              {
                orientation: index === 2 ? OrientationState.WAITING : OrientationState.ACTIVE,
                face: FaceState.FACE_UP,
              },
            ])
          ),
        },
        waitingRoom: {
          ...player.waitingRoom,
          cardIds: side.waiting.map((card) => card.instanceId),
        },
        successZone: {
          ...player.successZone,
          cardIds: side.success.map((card) => card.instanceId),
        },
        exileZone: {
          ...player.exileZone,
          cardIds: [side.exile.instanceId],
          cardStates: new Map([
            [
              side.exile.instanceId,
              { orientation: OrientationState.ACTIVE, face: FaceState.FACE_UP },
            ],
          ]),
        },
        liveZone: {
          ...player.liveZone,
          cardIds: side.live.map((card) => card.instanceId),
          cardStates: new Map(
            side.live.map((card, index) => [
              card.instanceId,
              {
                orientation: OrientationState.ACTIVE,
                face: index === 0 ? FaceState.FACE_UP : FaceState.FACE_DOWN,
              },
            ])
          ),
        },
      };
    });
  }
  state = {
    ...state,
    currentPhase: GamePhase.MAIN_PHASE,
    currentSubPhase: SubPhase.NONE,
    currentTurnType: viewer === 'FIRST' ? TurnType.FIRST_PLAYER_TURN : TurnType.SECOND_PLAYER_TURN,
    activePlayerIndex: viewer === 'FIRST' ? 0 : 1,
    waitingPlayerId: null,
    resolutionZone: {
      ...state.resolutionZone,
      cardIds: sides.map((side) => side.resolution.instanceId),
      revealedCardIds: sides.map((side) => side.resolution.instanceId),
    },
  };
  setState(session, state);
  return { session, sides, playerId: viewer === 'FIRST' ? FIRST : SECOND };
}

async function capture(session: Session, playerId = FIRST, projected?: PlayerViewState) {
  const spy = projected ? vi.spyOn(session, 'getPlayerViewState').mockReturnValue(projected) : null;
  let request: AiDecisionRequestV2 | undefined;
  try {
    const result = await new AiTurnCoordinator({
      session,
      createDecisionId: () => 'stable-public-observation',
      provider: {
        decide(value) {
          request = value;
          return Promise.resolve(null);
        },
      },
    }).advanceOne(playerId);
    expect(result.status).toBe('NO_DECISION');
    if (!request) throw new Error('Expected an AI request');
    return request;
  } finally {
    spy?.mockRestore();
  }
}

function observation(request: AiDecisionRequestV2): AiMainActionObservationV2 {
  if (!('self' in request.observation)) throw new Error('Expected post-mulligan observation');
  return request.observation;
}

function zone(request: AiDecisionRequestV2, key: ViewZoneKey) {
  const value = observation(request).visibleZones.find((item) => item.zoneKey === key);
  if (!value) throw new Error(`Missing public zone ${key}`);
  return value;
}

function action(request: AiDecisionRequestV2, token: string): AiDecisionV2 {
  if (
    request.window.kind !== 'MAIN_ACTION' &&
    request.window.kind !== 'EFFECT_STEP' &&
    request.window.kind !== 'LIVE_ACTION'
  )
    throw new Error('Expected action window');
  return {
    schemaVersion: request.schemaVersion,
    decisionId: request.decisionId,
    contextDigest: request.contextDigest,
    kind: request.window.kind,
    selectedActionToken: token,
  };
}

function poison(target: object, key: string) {
  const getter = vi.fn(() => {
    throw new Error(`FORBIDDEN-READ-${key}`);
  });
  Object.defineProperty(target, key, { enumerable: true, configurable: true, get: getter });
  return getter;
}

describe('AI public observation through authoritative player projections', () => {
  it.each(SEATS)('MAIN_ACTION 的 %s 视角包含两席完整公开区域与对手舞台', async (viewer) => {
    const { session, playerId } = scenario(viewer);
    const request = await capture(session, playerId);
    const observed = observation(request);
    const opponent = viewer === 'FIRST' ? 'SECOND' : 'FIRST';
    expect(request.window.kind).toBe('MAIN_ACTION');
    expect(observed.opponent.seat).toBe(opponent);
    const expectedEnergy = {
      activeCount: 2,
      totalCount: 3,
      skipsNextActivePhase: { activeCount: 0, waitingCount: 0 },
    };
    expect(observed.self.energy).toEqual(expectedEnergy);
    expect(observed.opponent.energy).toEqual(expectedEnergy);
    expect(observed.opponent.stage.find((slot) => slot.slot === SlotPosition.CENTER)).toMatchObject(
      {
        energyBelowCount: 1,
        membersBelow: [{ cardCode: `${opponent}-BELOW`, cost: 9, blade: 2 }],
        member: { orientation: OrientationState.WAITING, effectiveCost: 2, effectiveBlade: 2 },
      }
    );
    expect(observed.visibleZones.map((item) => item.zoneKey).sort()).toEqual(
      [
        ...SEATS.flatMap((seat) => PUBLIC_SUFFIXES.map((suffix) => `${seat}_${suffix}`)),
        'SHARED_RESOLUTION_ZONE',
      ].sort()
    );
    for (const seat of SEATS) {
      expect(
        zone(request, `${seat}_WAITING_ROOM`).cards.map((entry) => entry.card.cardCode)
      ).toEqual([`${seat}-WAIT-A`, `${seat}-WAIT-B`]);
      expect(zone(request, `${seat}_SUCCESS_ZONE`)).toMatchObject({
        ordered: true,
        hiddenCount: 0,
        cards: [
          { position: 1, card: { cardCode: `${seat}-SUCCESS-A`, score: 2 } },
          { position: 2, card: { cardCode: `${seat}-SUCCESS-B`, score: 2 } },
        ],
      });
      expect(zone(request, `${seat}_EXILE_ZONE`).cards[0]?.card.cardCode).toBe(`${seat}-EXILE`);
      expect(zone(request, `${seat}_INSPECTION_ZONE`)).toMatchObject({ cards: [], hiddenCount: 0 });
    }
    expect(zone(request, `${viewer}_LIVE_ZONE`)).toMatchObject({ hiddenCount: 0 });
    expect(zone(request, `${viewer}_LIVE_ZONE`).cards).toHaveLength(2);
    expect(zone(request, `${opponent}_LIVE_ZONE`)).toMatchObject({
      hiddenCount: 1,
      cards: [{ card: { cardCode: `${opponent}-LIVE-FRONT` }, faceDown: false }],
    });
    expect(zone(request, 'SHARED_RESOLUTION_ZONE').cards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ownerSeat: 'FIRST', publiclyRevealed: true }),
        expect.objectContaining({ ownerSeat: 'SECOND', publiclyRevealed: true }),
      ])
    );
    const wire = JSON.stringify(request);
    for (const forbidden of [
      ...session.state!.cardRegistry.keys(),
      FIRST,
      SECOND,
      session.state!.gameId,
    ])
      expect(wire).not.toContain(forbidden);
    expect(wire).not.toContain('obj_');
    expect(wire).not.toContain(`${opponent}-HAND`);
    expect(wire).not.toContain(`${opponent}-LIVE-BACK`);
    expect(wire).not.toContain('UNSEEN');
  });

  it('有效费用、BLADE、HEART 取真实修正结果，待机不清零且下方成员不重复加成', async () => {
    const { session, sides } = scenario();
    let state = session.state!;
    for (const side of sides) {
      const options = {
        playerId: side.ownerId,
        sourceCardId: side.source.instanceId,
        abilityId: 'private-numeric-modifier-origin',
      };
      state = addHeartLiveModifierForSourceMember(state, {
        ...options,
        hearts: [createHeartIcon(HeartColor.GREEN, 2)],
      })!.gameState;
      state = addBladeLiveModifierForSourceMember(state, { ...options, countDelta: 3 })!.gameState;
      state = addMemberCostLiveModifierForMember(state, {
        ...options,
        memberCardId: side.source.instanceId,
        countDelta: 4,
      })!.gameState;
    }
    setState(session, state);
    const request = await capture(session);
    for (const board of [observation(request).self, observation(request).opponent]) {
      const center = board.stage.find((slot) => slot.slot === SlotPosition.CENTER)!;
      expect(center.member).toMatchObject({
        orientation: OrientationState.WAITING,
        effectiveCost: 6,
        effectiveBlade: 5,
        card: { cost: 2, blade: 2 },
      });
      expect(center.member!.effectiveHearts).toEqual(center.member!.card.hearts);
      expect(center.member!.effectiveHearts.reduce((sum, icon) => sum + icon.count, 0)).toBe(3);
      expect(center.membersBelow[0]).toMatchObject({
        cost: 9,
        blade: 2,
        hearts: [{ color: HeartColor.GREEN, count: 1 }],
      });
      expect(center.membersBelow[0]?.modifierDelta).toBeUndefined();
    }
    expect(JSON.stringify(request)).not.toContain('private-numeric-modifier-origin');
  });

  it('真实能量跳过激活标记按当前朝向汇总，两份同卡标记不重复计数或泄露 ID', async () => {
    const { session, sides } = scenario();
    const baseline = await capture(session);
    const skips = sides.flatMap((side) =>
      [0, 2, 2].map((index, entryIndex) => ({
        playerId: side.ownerId,
        energyCardId: side.energies[index]!.instanceId,
        sourceCardId: side.source.instanceId,
        abilityId: `private-energy-skip-ability-${entryIndex}`,
      }))
    );
    setState(session, addEnergyActivePhaseSkips(session.state!, skips));
    const changed = await capture(session);
    const expected = {
      activeCount: 2,
      totalCount: 3,
      skipsNextActivePhase: { activeCount: 1, waitingCount: 1 },
    };
    expect(observation(changed).self.energy).toEqual(expected);
    expect(observation(changed).opponent.energy).toEqual(expected);
    expect(changed.observation.match).toEqual(baseline.observation.match);
    expect(changed.contextDigest).not.toBe(baseline.contextDigest);
    expect(JSON.stringify(changed)).not.toContain('private-energy-skip');
    expect(JSON.stringify(changed)).not.toContain('private-instance');
  });

  it('LIVE 中真实声援判心改色按席位公开，变化进入 digest 且不导出来源 metadata', async () => {
    const { session, sides } = scenario('SECOND');
    expect(session.executeCommand(createEndPhaseCommand(SECOND)).success).toBe(true);
    const baseline = await capture(session);
    if (!('live' in baseline.observation)) throw new Error('Expected LIVE observation');
    expect(
      baseline.observation.live.players.map((player) => player.cheerHeartColorReplacement)
    ).toEqual([null, null]);
    let state = session.state!;
    for (const [index, side] of sides.entries()) {
      state = addLiveModifier(state, {
        kind: 'CHEER_CARD_HEART_COLOR_REPLACEMENT',
        playerId: side.ownerId,
        fromColors: index === 0 ? [HeartColor.PINK] : [HeartColor.GREEN, HeartColor.BLUE],
        toColor: index === 0 ? HeartColor.GREEN : HeartColor.PURPLE,
        sourceCardId: side.live[0]!.instanceId,
        abilityId: 'private-cheer-replacement-origin',
      });
    }
    setState(session, state);
    const changed = await capture(session);
    if (!('live' in changed.observation)) throw new Error('Expected LIVE observation');
    expect(
      changed.observation.live.players.map((player) => ({
        seat: player.seat,
        replacement: player.cheerHeartColorReplacement,
      }))
    ).toEqual([
      { seat: 'FIRST', replacement: { fromColors: [HeartColor.PINK], toColor: HeartColor.GREEN } },
      {
        seat: 'SECOND',
        replacement: {
          fromColors: [HeartColor.GREEN, HeartColor.BLUE],
          toColor: HeartColor.PURPLE,
        },
      },
    ]);
    expect(changed.contextDigest).not.toBe(baseline.contextDigest);
    expect(changed.observation.match).toEqual(baseline.observation.match);
    expect(JSON.stringify(changed)).not.toContain('private-cheer-replacement-origin');
    const view = globalThis.structuredClone(session.getPlayerViewState(FIRST)!);
    const getter = poison(
      view.match.liveResult!.cheerHeartColorReplacements.FIRST!,
      'privateMetadata'
    );
    expect(await capture(session, FIRST, view)).toEqual(changed);
    expect(getter).not.toHaveBeenCalled();
  });

  it('四个牌库的隐藏顺序与对手手牌身份变化不改变请求或 digest', async () => {
    const { session, sides } = scenario();
    const baseline = await capture(session);
    for (const player of session.state!.players) {
      for (const hiddenDeck of [player.mainDeck.cardIds, player.energyDeck.cardIds]) {
        (hiddenDeck as string[]).reverse();
        expect(await capture(session)).toEqual(baseline);
      }
    }
    const hidden = sides[1]!.hand[0]!;
    (session.state!.cardRegistry as Map<string, CardInstance>).set(hidden.instanceId, {
      ...hidden,
      data: { ...hidden.data, cardCode: 'OPPONENT-HAND-POISON-IDENTITY', name: 'SECRET' },
    });
    expect(await capture(session)).toEqual(baseline);
  });

  it('不读取隐藏牌库、对手手牌对象表、能量卡面或未来私密 metadata', async () => {
    const { session, sides } = scenario();
    const baseline = await capture(session);
    const view = globalThis.structuredClone(session.getPlayerViewState(FIRST)!);
    const getters = [];
    for (const seat of SEATS)
      for (const suffix of ['MAIN_DECK', 'ENERGY_DECK'])
        getters.push(poison(view.table.zones[`${seat}_${suffix}`]!, 'objectIds'));
    getters.push(poison(view.table.zones.SECOND_HAND!, 'objectIds'));
    for (const side of sides) {
      for (const card of [...side.energies, side.overlay])
        getters.push(poison(view.objects[`obj_${card.instanceId}`]!, 'frontInfo'));
      for (const card of [side.source, side.below, ...side.waiting, ...side.success, side.exile]) {
        const object = view.objects[`obj_${card.instanceId}`]!;
        getters.push(poison(object, 'publicObjectId'), poison(object, 'metadata'));
        getters.push(poison(object.frontInfo!, 'futureSensitiveField'));
      }
    }
    getters.push(poison(view.objects, 'unreferenced-private-object'));
    expect(await capture(session, FIRST, view)).toEqual(baseline);
    for (const getter of getters) expect(getter).not.toHaveBeenCalled();
  });

  it('对手里侧 LIVE 即使意外有 FRONT 标记也只计隐藏数量，不读取卡面或判断', async () => {
    const { session, sides } = scenario();
    const baseline = await capture(session);
    const view = globalThis.structuredClone(session.getPlayerViewState(FIRST)!);
    const hiddenId = `obj_${sides[1]!.live[1]!.instanceId}`;
    const hidden = { ...view.objects[hiddenId]!, surface: 'FRONT' as const };
    const getters = [
      poison(hidden, 'frontInfo'),
      poison(hidden, 'judgmentResult'),
      poison(hidden, 'metadata'),
    ];
    const poisoned = { ...view, objects: { ...view.objects, [hiddenId]: hidden } };
    expect(await capture(session, FIRST, poisoned)).toEqual(baseline);
    for (const getter of getters) expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    ['FIRST_INSPECTION_ZONE', 'FIRST'],
    ['SECOND_INSPECTION_ZONE', 'SECOND'],
    ['SHARED_RESOLUTION_ZONE', 'SECOND'],
  ] as const)('%s 中没有检视或公开权限的牌即使 FRONT 也不读取卡面', async (key, ownerSeat) => {
    const { session } = scenario();
    const view = session.getPlayerViewState(FIRST)!;
    const originalZone = view.table.zones[key]!;
    const objectId = 'obj_private-unrevealed-zone-object';
    const hiddenObject = {
      publicObjectId: objectId,
      ownerSeat,
      controllerSeat: ownerSeat,
      publiclyRevealed: false,
      surface: 'BACK' as const,
    };
    const baselineView: PlayerViewState = {
      ...view,
      table: {
        zones: {
          ...view.table.zones,
          [key]: {
            ...originalZone,
            count: originalZone.count + 1,
            objectIds: [...originalZone.objectIds!, objectId],
          },
        },
      },
      objects: { ...view.objects, [objectId]: hiddenObject },
    };
    const baseline = await capture(session, FIRST, baselineView);
    expect(zone(baseline, key).hiddenCount).toBe(1);
    const poisonedObject = { ...hiddenObject, surface: 'FRONT' as const };
    const getter = poison(poisonedObject, 'frontInfo');
    expect(
      await capture(session, FIRST, {
        ...baselineView,
        objects: { ...baselineView.objects, [objectId]: poisonedObject },
      })
    ).toEqual(baseline);
    expect(getter).not.toHaveBeenCalled();
    const publicObject = {
      ...hiddenObject,
      surface: 'FRONT' as const,
      publiclyRevealed: true,
      frontInfo: { cardCode: 'NOW-PUBLIC', cardType: CardType.MEMBER, cost: 2, blade: 1 },
    };
    const revealed = await capture(session, FIRST, {
      ...baselineView,
      objects: { ...baselineView.objects, [objectId]: publicObject },
    });
    expect(zone(revealed, key).hiddenCount).toBe(0);
    expect(
      zone(revealed, key).cards.find((entry) => entry.card.cardCode === 'NOW-PUBLIC')
    ).toMatchObject({
      ownerSeat,
      publiclyRevealed: true,
    });
    expect(revealed.contextDigest).not.toBe(baseline.contextDigest);
  });

  it('无序公开区交换内部顺序不改变 digest，有序成功区的次序改变则改变 digest', async () => {
    const { session } = scenario();
    const baseline = await capture(session);
    const view = globalThis.structuredClone(session.getPlayerViewState(FIRST)!);
    const zones = view.table.zones;
    const waiting = zones.SECOND_WAITING_ROOM!;
    const reordered = {
      ...view,
      table: {
        zones: {
          ...zones,
          SECOND_WAITING_ROOM: { ...waiting, objectIds: [...waiting.objectIds!].reverse() },
        },
      },
    };
    expect(await capture(session, FIRST, reordered)).toEqual(baseline);
    const success = zones.SECOND_SUCCESS_ZONE!;
    const orderedChange = {
      ...view,
      table: {
        zones: {
          ...zones,
          SECOND_SUCCESS_ZONE: { ...success, objectIds: [...success.objectIds!].reverse() },
        },
      },
    };
    const changed = await capture(session, FIRST, orderedChange);
    expect(changed.contextDigest).not.toBe(baseline.contextDigest);
    expect(changed.observation.match).toEqual(baseline.observation.match);
  });

  it.each(['stage', 'energy', 'waiting', 'success', 'live', 'below'] as const)(
    '同一公开序号下，对手 %s 的合法可见变化进入 digest',
    async (change) => {
      const { session, sides } = scenario();
      const baseline = await capture(session);
      const view = globalThis.structuredClone(session.getPlayerViewState(FIRST)!);
      const side = sides[1]!;
      const card = {
        stage: side.source,
        energy: side.energies[0]!,
        waiting: side.waiting[0]!,
        success: side.success[0]!,
        live: side.live[0]!,
        below: side.below,
      }[change];
      const id = `obj_${card.instanceId}`;
      const object = view.objects[id]!;
      const replacement =
        change === 'energy'
          ? { ...object, orientation: OrientationState.WAITING }
          : change === 'stage'
            ? { ...object, orientation: OrientationState.ACTIVE }
            : { ...object, frontInfo: { ...object.frontInfo!, cardCode: 'CHANGED-PUBLIC-CARD' } };
      const changed = await capture(session, FIRST, {
        ...view,
        objects: { ...view.objects, [id]: replacement },
      });
      expect(changed.contextDigest).not.toBe(baseline.contextDigest);
      expect(changed.observation.match).toEqual(baseline.observation.match);
    }
  );

  it('费用 2 绚濑绘里根据公开休息室起动回收，匿名动作仍绑定真实来源和目标', async () => {
    const { session, sides } = scenario();
    const source = sides[0]!.source;
    const target = sides[0]!.waiting[1]!;
    const requests: AiDecisionRequestV2[] = [];
    const execute = vi.spyOn(session, 'executeCommand');
    const coordinator = new AiTurnCoordinator({
      session,
      provider: {
        decide(request) {
          requests.push(request);
          expect(
            zone(request, 'FIRST_WAITING_ROOM').cards.some(
              (item) => item.card.cardCode === target.data.cardCode
            )
          ).toBe(true);
          expect(
            observation(request).opponent.stage.some(
              (slot) => slot.member?.card.cardCode === 'SECOND-STAGE'
            )
          ).toBe(true);
          if (request.window.kind === 'MAIN_ACTION') {
            const candidate = request.window.candidates.find(
              (item) => item.kind === 'ACTIVATE_ABILITY' && item.sourceSlot === SlotPosition.CENTER
            )!;
            return Promise.resolve(action(request, candidate.actionToken));
          }
          if (request.window.kind !== 'EFFECT_STEP') throw new Error('Expected recovery selection');
          const candidate = request.window.candidates.find(
            (item) => item.kind === 'SELECT_CARD' && item.card.cardCode === target.data.cardCode
          )!;
          return Promise.resolve(action(request, candidate.actionToken));
        },
      },
    });
    expect((await coordinator.advanceOne(FIRST)).status).toBe('EXECUTED');
    expect(execute.mock.calls[0]![0]).toMatchObject({
      type: GameCommandType.ACTIVATE_ABILITY,
      playerId: FIRST,
      cardId: source.instanceId,
      abilityId: PB1_019_ACTIVATED_ABILITY_ID,
    });
    expect((await coordinator.advanceOne(FIRST)).status).toBe('EXECUTED');
    expect(execute.mock.calls[1]![0]).toMatchObject({
      type: GameCommandType.CONFIRM_EFFECT_STEP,
      selectedCardId: target.instanceId,
    });
    confirmPublicSelectionIfNeeded(session);
    expect(session.state!.players[0].hand.cardIds).toContain(target.instanceId);
    expect(session.state!.activeEffect).toBeNull();
    expect(requests.map((request) => request.window.kind)).toEqual(['MAIN_ACTION', 'EFFECT_STEP']);
    expect(JSON.stringify(requests)).not.toContain(source.instanceId);
    expect(JSON.stringify(requests)).not.toContain(PB1_019_ACTIVATED_ABILITY_ID);
  });

  it('费用 2 中须霞的真实检视只公开合法三张，排序动作仍使用候选 token', async () => {
    const { session, sides } = scenario();
    const source = member('PL!N-bp1-002-P', FIRST, 2);
    let state = registerCards(session.state!, [source]);
    state = updatePlayer(state, FIRST, (player) => ({
      ...player,
      hand: { ...player.hand, cardIds: [source.instanceId] },
    }));
    setState(session, state);
    expect(
      session.executeCommand(
        createPlayMemberToSlotCommand(FIRST, source.instanceId, SlotPosition.LEFT)
      ).success
    ).toBe(true);
    const request = await capture(session);
    expect(request.window.kind).toBe('EFFECT_CARD_SELECTION');
    const inspected = zone(request, 'FIRST_INSPECTION_ZONE');
    expect(inspected.cards.map((entry) => entry.card.cardCode)).toEqual(
      sides[0]!.deck.slice(0, 3).map((card) => card.data.cardCode)
    );
    expect(inspected.cards.map((entry) => entry.position)).toEqual([1, 2, 3]);
    expect(inspected.cards.every((entry) => !entry.publiclyRevealed)).toBe(true);
    expect(JSON.stringify(request)).not.toContain('FIRST-UNSEEN-3');
    expect(JSON.stringify(request)).not.toContain('SECOND-HAND');
    // A real inspection window establishes the viewer; card ownership is not permission.
    // Add an already-projected, legitimately visible opponent card without changing candidates.
    const view = session.getPlayerViewState(FIRST)!;
    expect(view.match.window).toMatchObject({ windowType: 'INSPECTION', actingSeat: 'FIRST' });
    const objectId = 'obj_private-legally-inspected-opponent-card';
    const crossOwner = await capture(session, FIRST, {
      ...view,
      table: {
        zones: {
          ...view.table.zones,
          SECOND_INSPECTION_ZONE: {
            ...view.table.zones.SECOND_INSPECTION_ZONE!,
            count: 1,
            objectIds: [objectId],
          },
        },
      },
      objects: {
        ...view.objects,
        [objectId]: {
          publicObjectId: objectId,
          ownerSeat: 'SECOND',
          controllerSeat: 'SECOND',
          surface: 'FRONT',
          publiclyRevealed: false,
          frontInfo: {
            cardCode: 'LEGALLY-INSPECTED-OPPONENT',
            cardType: CardType.MEMBER,
            cost: 3,
            blade: 1,
          },
        },
      },
    });
    expect(zone(crossOwner, 'SECOND_INSPECTION_ZONE')).toMatchObject({
      hiddenCount: 0,
      cards: [
        {
          ownerSeat: 'SECOND',
          publiclyRevealed: false,
          card: { cardCode: 'LEGALLY-INSPECTED-OPPONENT' },
        },
      ],
    });
    expect(crossOwner.window).toEqual(request.window);
    expect(JSON.stringify(crossOwner)).not.toContain(objectId);
    const result = await new AiTurnCoordinator({
      session,
      provider: {
        decide(value) {
          if (value.window.kind !== 'EFFECT_CARD_SELECTION') throw new Error('Expected selection');
          return Promise.resolve({
            schemaVersion: value.schemaVersion,
            decisionId: value.decisionId,
            contextDigest: value.contextDigest,
            kind: 'EFFECT_CARD_SELECTION',
            choice: 'SELECT',
            selectedCardTokens: [
              value.window.candidates[1]!.cardToken,
              value.window.candidates[0]!.cardToken,
            ],
          });
        },
      },
    }).advanceOne(FIRST);
    expect(result.status).toBe('EXECUTED');
    expect(session.state!.players[0].mainDeck.cardIds.slice(0, 2)).toEqual([
      sides[0]!.deck[1]!.instanceId,
      sides[0]!.deck[0]!.instanceId,
    ]);
  });

  it('MAIN 结束后的真实 LIVE 设置继续携带公开观察并执行匿名确认动作', async () => {
    const { session, sides } = scenario('SECOND');
    expect(session.executeCommand(createEndPhaseCommand(SECOND)).success).toBe(true);
    expect(session.state!.currentPhase).toBe(GamePhase.LIVE_SET_PHASE);
    const request = await capture(session, FIRST);
    expect(request.window.kind).toBe('LIVE_ACTION');
    expect(observation(request).opponent.seat).toBe('SECOND');
    expect(zone(request, 'SECOND_LIVE_ZONE')).toMatchObject({ hiddenCount: 1 });
    const view = session.getPlayerViewState(FIRST)!;
    const hiddenId = `obj_${sides[1]!.live[1]!.instanceId}`;
    const hidden = { ...view.objects[hiddenId]!, surface: 'FRONT' as const };
    const getters = [poison(hidden, 'frontInfo'), poison(hidden, 'judgmentResult')];
    expect(
      await capture(session, FIRST, { ...view, objects: { ...view.objects, [hiddenId]: hidden } })
    ).toEqual(request);
    for (const getter of getters) expect(getter).not.toHaveBeenCalled();
    const execute = vi.spyOn(session, 'executeCommand');
    const result = await new AiTurnCoordinator({
      session,
      provider: {
        decide(value) {
          if (value.window.kind !== 'LIVE_ACTION') throw new Error('Expected LIVE');
          const candidate = value.window.candidates.find(
            (item) => item.kind === 'CONFIRM_LIVE_SET'
          )!;
          return Promise.resolve(action(value, candidate.actionToken));
        },
      },
    }).advanceOne(FIRST);
    expect(result.status).toBe('EXECUTED');
    expect(execute.mock.calls[0]![0]).toMatchObject({
      type: GameCommandType.CONFIRM_STEP,
      playerId: FIRST,
    });
  });
});
