import { describe, expect, it } from 'vitest';
import {
  confirmActiveEffectStep,
  enqueueTriggeredCardEffects,
  resolvePendingCardEffects,
} from '../../src/application/card-effect-runner';
import {
  PL_PB2_042_AUTO_ON_CHEER_BIBI_NAMES_WAIT_OPPONENT_ABILITY_ID as ABILITY,
  PL_PB2_015_AUTO_BIBI_EFFECT_WAIT_OPPONENT_ACTIVATE_MEMBER_OR_ENERGY_ABILITY_ID as REACTION,
} from '../../src/application/card-effects/ability-ids';
import {
  CardAbilityCategory,
  CardAbilitySourceZone,
} from '../../src/application/card-effects/ability-definition-types';
import { getCardAbilityDefinitionsForCardCode } from '../../src/application/card-effects/definitions/lookup';
import { getAbilitySourceLifecycleId } from '../../src/application/card-effects/runtime/ability-source-lifecycle';
import {
  createCardInstance,
  createHeartRequirement,
  type CardData,
  type MemberCardData,
} from '../../src/domain/entities/card';
import {
  createGameState,
  emitGameEvent,
  registerCards,
  updatePlayer,
  type GameState,
} from '../../src/domain/entities/game';
import { placeCardInSlot, removeCardFromSlot } from '../../src/domain/entities/zone';
import {
  createCheerEvent,
  createEnterLiveZoneEvent,
  createEnterStageEvent,
} from '../../src/domain/events/game-events';
import {
  addHeartLiveModifierForTargetMember,
  addLiveModifier,
} from '../../src/domain/rules/live-modifiers';
import { addMemberWaitProtectionUntilLiveEnd } from '../../src/domain/rules/member-wait-protections';
import { projectPlayerViewState } from '../../src/online/projector';
import {
  CardType,
  FaceState,
  HeartColor,
  OrientationState as O,
  SlotPosition as S,
  TriggerCondition as T,
  ZoneType,
} from '../../src/shared/types/enums';
import { addCheckTimingRuleSentinel } from '../helpers/check-timing-rule-sentinel';

const TEXT =
  '【自动】【1回合1次】自己进行声援时，因声援被公开的自己的卡片中存在「绚濑绘里」和「西木野真姬」和「矢泽日香（矢泽妮可）」的成员卡，且自己的中央区域存在费用大于等于11的『BiBi』的成员的场合，将存在于对方的舞台的1名原本持有的HEART的数量小于等于4的成员变为待机状态。';
const NAMES = ['絢瀬絵里', '西木野真姫', '矢澤にこ'];
const member = (name: string, cost = 11, heartCount = 1, unitName = 'BiBi'): MemberCardData => ({
  name,
  cardCode: `TEST-${name}`,
  cardType: CardType.MEMBER,
  cost,
  blade: 1,
  hearts: [{ color: HeartColor.PURPLE, count: heartCount }],
  groupNames: ['μ’s'],
  unitName,
});
const sourceData = (code = 'PL!-pb2-042-L'): CardData => ({
  cardCode: code,
  name: 'PSYCHIC FIRE',
  cardType: CardType.LIVE,
  score: 7,
  requirements: createHeartRequirement({
    [HeartColor.YELLOW]: 3,
    [HeartColor.PURPLE]: 7,
    [HeartColor.RAINBOW]: 5,
  }),
  unitName: '「BiBi」',
  groupNames: ['μ’s'],
  cardText: TEXT,
});
function setup(options: { copies?: number; centerCost?: number; code?: string } = {}): GameState {
  const copies = options.copies ?? 1;
  let game = registerCards(createGameState('psychic-fire', 'p1', 'P1', 'p2', 'P2'), [
    ...Array.from({ length: copies }, (_, n) =>
      createCardInstance(sourceData(options.code), 'p1', `live${n}`)
    ),
    createCardInstance(member('中央', options.centerCost ?? 11), 'p1', 'center'),
    ...NAMES.map((name, n) => createCardInstance(member(name), 'p1', `cheer${n}`)),
    createCardInstance(member('低心', 3, 4), 'p2', 'low'),
    createCardInstance(member('高心', 3, 5), 'p2', 'high'),
    createCardInstance(member('已待机', 3, 1), 'p2', 'waiting'),
  ]);
  game = updatePlayer(game, 'p1', (p) => ({
    ...p,
    memberSlots: placeCardInSlot(p.memberSlots, S.CENTER, 'center', {
      orientation: O.ACTIVE,
      face: FaceState.FACE_UP,
    }),
    liveZone: {
      ...p.liveZone,
      cardIds: Array.from({ length: copies }, (_, n) => `live${n}`),
      cardStates: new Map(
        Array.from({ length: copies }, (_, n) => [
          `live${n}`,
          { orientation: O.ACTIVE, face: FaceState.FACE_UP },
        ])
      ),
    },
  }));
  game = updatePlayer(game, 'p2', (p) => ({
    ...p,
    memberSlots: placeCardInSlot(
      placeCardInSlot(
        placeCardInSlot(p.memberSlots, S.LEFT, 'low', {
          orientation: O.ACTIVE,
          face: FaceState.FACE_UP,
        }),
        S.CENTER,
        'high',
        { orientation: O.ACTIVE, face: FaceState.FACE_UP }
      ),
      S.RIGHT,
      'waiting',
      { orientation: O.WAITING, face: FaceState.FACE_UP }
    ),
  }));
  game = {
    ...game,
    liveResolution: { ...game.liveResolution, isInLive: true, performingPlayerId: 'p1' },
  };
  for (let n = 0; n < copies; n++)
    game = emitGameEvent(
      game,
      createEnterLiveZoneEvent(`live${n}`, ZoneType.HAND, 'p1', 'p1', FaceState.FACE_UP)
    );
  return addCheckTimingRuleSentinel(addCheckTimingRuleSentinel(game, 'p1', 'pf1'), 'p2', 'pf2');
}
function cheer(
  game: GameState,
  ids = ['cheer0', 'cheer1', 'cheer2'],
  playerId = 'p1',
  additional = false
): GameState {
  const event = createCheerEvent(playerId, ids, ids.length, { automated: true, additional });
  const key =
    playerId === game.players[game.firstPlayerIndex].id
      ? 'firstPlayerCheerCardIds'
      : 'secondPlayerCheerCardIds';
  const state = emitGameEvent(
    {
      ...game,
      liveResolution: {
        ...game.liveResolution,
        [key]: [...new Set([...game.liveResolution[key], ...ids])],
      },
      resolutionZone: {
        ...game.resolutionZone,
        cardIds: [...new Set([...game.resolutionZone.cardIds, ...ids])],
        revealedCardIds: [...new Set([...game.resolutionZone.revealedCardIds, ...ids])],
      },
    },
    event
  );
  return enqueueTriggeredCardEffects(state, [T.ON_CHEER], { cheerEvents: [event] });
}
const start = (game: GameState) => resolvePendingCardEffects(game).gameState;
const choose = (game: GameState, target = 'low') =>
  confirmActiveEffectStep(game, 'p1', game.activeEffect!.id, target);
const confirm = (game: GameState) => confirmActiveEffectStep(game, 'p1', game.activeEffect!.id);
const uses = (game: GameState) =>
  game.actionHistory.filter(
    (a) => a.payload.abilityId === ABILITY && a.payload.step === 'ABILITY_USE'
  );
const orientation = (game: GameState, id = 'low') =>
  game.players[1].memberSlots.cardStates.get(id)?.orientation;
const stateEvents = (game: GameState) =>
  game.eventLog.filter((e) => e.event.eventType === T.ON_MEMBER_STATE_CHANGED);
function setOrientation(game: GameState, playerId: string, id: string, value: O): GameState {
  return updatePlayer(game, playerId, (p) => ({
    ...p,
    memberSlots: {
      ...p.memberSlots,
      cardStates: new Map(
        [...p.memberSlots.cardStates].map(([key, state]) => [
          key,
          key === id ? { ...state, orientation: value } : state,
        ])
      ),
    },
  }));
}
function replaceCardData(game: GameState, id: string, data: CardData, ownerId?: string): GameState {
  const card = game.cardRegistry.get(id)!;
  return {
    ...game,
    cardRegistry: new Map(game.cardRegistry).set(id, {
      ...card,
      data,
      ownerId: ownerId ?? card.ownerId,
    }),
  };
}

describe('PL!-pb2-042 分数7「PSYCHIC FIRE」', () => {
  it.each(['L', 'P+', 'UNSEEN'])(
    'registers %s with complete corrected Chinese text and directly selects a mandatory public target',
    (rare) => {
      const code = `PL!-pb2-042-${rare}`;
      const defs = getCardAbilityDefinitionsForCardCode(code);
      expect(defs).toHaveLength(1);
      expect(defs[0]).toMatchObject({
        abilityId: ABILITY,
        baseCardCodes: ['PL!-pb2-042'],
        category: CardAbilityCategory.AUTO,
        sourceZone: CardAbilitySourceZone.LIVE_CARD,
        triggerCondition: T.ON_CHEER,
        perTurnLimit: 1,
        queued: true,
        implemented: true,
        effectText: TEXT,
      });
      expect(defs[0]?.cardCodes).toBeUndefined();
      const game = start(cheer(setup({ code })));
      expect(game.activeEffect).toMatchObject({
        abilityId: ABILITY,
        effectText: TEXT,
        selectableCardIds: ['low'],
        selectableCardVisibility: 'PUBLIC',
        canSkipSelection: false,
        confirmSelectionLabel: '变为待机状态',
      });
      expect(game.activeEffect?.metadata?.confirmOnlyPendingAbility).toBeUndefined();
      expect(uses(game)).toHaveLength(1);
      for (const viewer of ['p1', 'p2']) {
        expect(projectPlayerViewState(game, viewer).activeEffect).toMatchObject({
          effectText: TEXT,
          stepText: '请选择对方舞台上1名原本持有的HEART数量小于等于4的活跃成员变为待机状态。',
          selectionLabel: '选择要变为待机状态的对方成员',
          confirmSelectionLabel: '变为待机状态',
        });
      }
      const result = choose(game);
      expect(orientation(result)).toBe(O.WAITING);
      expect(result.activeEffect).toBeNull();
      expect(stateEvents(result)).toHaveLength(1);
      expect(stateEvents(result)[0]?.event).toMatchObject({
        cardInstanceId: 'low',
        cause: { kind: 'CARD_EFFECT', playerId: 'p1', sourceCardId: 'live0', abilityId: ABILITY },
      });
      expect(uses(result)).toHaveLength(1);
      expect(confirmActiveEffectStep(result, 'p1', game.activeEffect!.id, 'low')).toBe(result);
    }
  );

  it.each([0, 1, 2])(
    'confirms and consumes the turn when required name %i is absent',
    (missing) => {
      const game = start(
        cheer(
          setup(),
          ['cheer0', 'cheer1', 'cheer2'].filter((_id, index) => index !== missing)
        )
      );
      expect(game.activeEffect?.metadata?.confirmOnlyPendingAbility).toBe(true);
      expect(game.activeEffect?.effectText).toContain('条件不满足，本次没有成员变为待机状态');
      expect(uses(game)).toHaveLength(0);
      const result = confirm(game);
      expect(uses(result)).toHaveLength(1);
      expect(orientation(result)).toBe(O.ACTIVE);
      expect(result.activeEffect).toBeNull();
    }
  );

  it('lets a structured dual-name member cover two names without requiring three card entities', () => {
    const game = replaceCardData(setup(), 'cheer0', member('绚濑绘里＆西木野真姬'));
    const result = choose(start(cheer(game, ['cheer0', 'cheer2'])));
    expect(orientation(result)).toBe(O.WAITING);
  });

  it.each(['separate', 'combined'])(
    'recognizes the 0910 exported Chinese Nico name on %s cheer cards',
    (kind) => {
      let game = replaceCardData(setup(), 'cheer0', member('绚濑绘里'));
      game = replaceCardData(game, 'cheer1', member('西木野真姬'));
      game = replaceCardData(game, 'cheer2', {
        ...member('矢泽日香（矢泽妮可）', 9),
        cardCode: 'PL!-pb2-009-PP',
      });
      if (kind === 'combined') {
        game = replaceCardData(
          game,
          'cheer2',
          member('绚濑绘里&西木野真姬&矢泽日香（矢泽妮可）')
        );
      }
      const started = start(cheer(game, kind === 'combined' ? ['cheer2'] : undefined));
      expect(started.activeEffect?.metadata?.confirmOnlyPendingAbility).toBeUndefined();
      expect(started.activeEffect?.selectableCardIds).toEqual(['low']);
      const result = choose(started);
      expect(orientation(result)).toBe(O.WAITING);
      expect(stateEvents(result)).toHaveLength(1);
      expect(uses(result)).toHaveLength(1);
    }
  );

  it.each(['LIVE', 'wrong-owner', 'text-only'])(
    'rejects %s as the missing named member',
    (kind) => {
      const replacement =
        kind === 'LIVE'
          ? { ...sourceData(), name: NAMES[2]! }
          : kind === 'text-only'
            ? { ...member('其他成员'), cardText: '此卡文提到矢澤にこ' }
            : member(NAMES[2]!);
      const game = start(
        cheer(replaceCardData(setup(), 'cheer2', replacement, kind === 'wrong-owner' ? 'p2' : 'p1'))
      );
      expect(game.activeEffect?.metadata?.confirmOnlyPendingAbility).toBe(true);
      expect(orientation(confirm(game))).toBe(O.ACTIVE);
    }
  );

  it.each([
    { printed: 10, delta: 0, legal: false },
    { printed: 11, delta: 0, legal: true },
    { printed: 10, delta: 1, legal: true },
    { printed: 11, delta: -1, legal: false },
  ])(
    'uses current effective center cost $printed + $delta at the 11 threshold',
    ({ printed, delta, legal }) => {
      const game = addLiveModifier(setup({ centerCost: printed }), {
        kind: 'MEMBER_COST',
        playerId: 'p1',
        memberCardId: 'center',
        countDelta: delta,
        sourceCardId: 'center',
        abilityId: 'test-cost',
      });
      const started = start(cheer(game));
      expect(started.activeEffect?.metadata?.confirmOnlyPendingAbility === true).toBe(!legal);
      const result = legal ? choose(started) : confirm(started);
      expect(orientation(result)).toBe(legal ? O.WAITING : O.ACTIVE);
      expect(uses(result)).toHaveLength(1);
    }
  );

  it.each(['left-only', 'wrong-unit', 'under-center'])(
    'requires a top-level BiBi member in CENTER: %s',
    (kind) => {
      let game = setup();
      if (kind === 'wrong-unit')
        game = replaceCardData(game, 'center', member('中央', 17, 1, 'Printemps'));
      else
        game = updatePlayer(game, 'p1', (p) => ({
          ...p,
          memberSlots:
            kind === 'left-only'
              ? placeCardInSlot(removeCardFromSlot(p.memberSlots, S.CENTER), S.LEFT, 'center', {
                  orientation: O.ACTIVE,
                  face: FaceState.FACE_UP,
                })
              : {
                  ...removeCardFromSlot(p.memberSlots, S.CENTER),
                  memberBelow: { ...p.memberSlots.memberBelow, [S.CENTER]: ['center'] },
                },
        }));
      const started = start(cheer(game));
      expect(started.activeEffect?.effectText).toContain('中央区域没有『BiBi』成员');
      expect(orientation(confirm(started))).toBe(O.ACTIVE);
    }
  );

  it('counts previously revealed members moved to hand and additional cheer facts settled before this ability', () => {
    let game = cheer(setup(), ['cheer0', 'cheer1']);
    expect(game.pendingAbilities.filter((p) => p.abilityId === ABILITY)).toHaveLength(1);
    game = cheer(game, ['cheer2'], 'p1', true);
    expect(game.pendingAbilities.filter((p) => p.abilityId === ABILITY)).toHaveLength(1);
    game = updatePlayer(
      { ...game, resolutionZone: { ...game.resolutionZone, cardIds: [], revealedCardIds: [] } },
      'p1',
      (p) => ({ ...p, hand: { ...p.hand, cardIds: ['cheer0', 'cheer1', 'cheer2'] } })
    );
    expect(orientation(choose(start(game)))).toBe(O.WAITING);
  });

  it('does not count a historical reveal outside the current LIVE cheer IDs', () => {
    let game = cheer(setup());
    game = {
      ...game,
      liveResolution: { ...game.liveResolution, firstPlayerCheerCardIds: ['cheer0', 'cheer1'] },
    };
    const started = start(game);
    expect(started.activeEffect?.metadata?.confirmOnlyPendingAbility).toBe(true);
    expect(orientation(confirm(started))).toBe(O.ACTIVE);
  });

  it.each(['opponent', 'additional', 'missing'])(
    'does not trigger from %s cheer and rejects a forged matching pending without using the turn',
    (kind) => {
      let game =
        kind === 'missing'
          ? setup()
          : cheer(setup(), [], kind === 'opponent' ? 'p2' : 'p1', kind === 'additional');
      expect(game.pendingAbilities).toEqual([]);
      const eventIds =
        kind === 'missing' ? ['missing-event'] : [game.eventLog.at(-1)!.event.eventId];
      game = start({
        ...game,
        pendingAbilities: [
          {
            id: 'forged',
            abilityId: ABILITY,
            sourceCardId: 'live0',
            controllerId: 'p1',
            mandatory: true,
            timingId: T.ON_CHEER,
            eventIds,
          },
        ],
      });
      expect(game.activeEffect).toBeNull();
      expect(uses(game)).toHaveLength(0);
      expect(stateEvents(game)).toHaveLength(0);
    }
  );

  it('uses original Heart replacement while ignoring ordinary gained Hearts', () => {
    let game = addLiveModifier(setup(), {
      kind: 'MEMBER_ORIGINAL_HEART_REPLACEMENT',
      playerId: 'p2',
      memberCardId: 'high',
      hearts: [{ color: HeartColor.BLUE, count: 4 }],
      sourceCardId: 'high',
      abilityId: 'test-original',
    });
    game = addHeartLiveModifierForTargetMember(game, {
      playerId: 'p2',
      sourceCardId: 'high',
      targetMemberCardId: 'low',
      abilityId: 'test-heart',
      hearts: [{ color: HeartColor.PINK, count: 6 }],
    })!.gameState;
    const started = start(cheer(game));
    expect(started.activeEffect?.selectableCardIds).toEqual(['low', 'high']);
    expect(orientation(choose(started, 'high'), 'high')).toBe(O.WAITING);
    const raisedOriginal = addLiveModifier(setup(), {
      kind: 'MEMBER_ORIGINAL_HEART_REPLACEMENT',
      playerId: 'p2',
      memberCardId: 'low',
      hearts: [{ color: HeartColor.BLUE, count: 5 }],
      sourceCardId: 'low',
      abilityId: 'test-original',
    });
    const noTargets = start(cheer(raisedOriginal));
    expect(noTargets.activeEffect?.effectText).toContain('条件满足，但没有可选择的对方成员');
    expect(stateEvents(confirm(noTargets))).toHaveLength(0);
  });

  it('filters already waiting and protected members and confirms no target with a consumed turn', () => {
    let game = replaceCardData(setup(), 'low', { ...member('低心', 3, 4), groupNames: ['Aqours'] });
    game = addMemberWaitProtectionUntilLiveEnd(game, {
      affectedPlayerId: 'p2',
      sourceCardId: 'high',
      abilityId: 'test-protection',
    });
    const started = start(cheer(game));
    expect(started.activeEffect?.metadata?.confirmOnlyPendingAbility).toBe(true);
    expect(started.activeEffect?.effectText).toContain('没有可选择的对方成员');
    const result = confirm(started);
    expect(uses(result)).toHaveLength(1);
    expect(stateEvents(result)).toHaveLength(0);
  });

  it('rejects illegal targets and skipping, refreshes a stale target and never records a second use', () => {
    let game = replaceCardData(setup(), 'high', member('高心', 3, 4));
    game = start(cheer(game));
    for (const target of ['center', 'cheer0', 'waiting', 'not-a-card'])
      expect(choose(game, target)).toBe(game);
    expect(confirm(game)).toBe(game);
    game = updatePlayer(game, 'p2', (p) => ({
      ...p,
      memberSlots: removeCardFromSlot(p.memberSlots, S.LEFT),
      waitingRoom: { ...p.waitingRoom, cardIds: ['low'] },
    }));
    game = choose(game, 'low');
    expect(game.activeEffect?.selectableCardIds).toEqual(['high']);
    expect(uses(game)).toHaveLength(1);
    expect(stateEvents(game)).toHaveLength(0);
    game = choose(game, 'high');
    expect(orientation(game, 'high')).toBe(O.WAITING);
    expect(uses(game)).toHaveLength(1);
  });

  it('ends safely when the displayed target becomes protected or exceeds the original Heart limit', () => {
    for (const change of ['protected', 'hearts']) {
      let game = replaceCardData(setup(), 'low', {
        ...member('低心', 3, 4),
        groupNames: ['Aqours'],
      });
      game = start(cheer(game));
      game =
        change === 'protected'
          ? addMemberWaitProtectionUntilLiveEnd(game, {
              affectedPlayerId: 'p2',
              sourceCardId: 'high',
              abilityId: 'test-protection',
            })
          : addLiveModifier(game, {
              kind: 'MEMBER_ORIGINAL_HEART_REPLACEMENT',
              playerId: 'p2',
              memberCardId: 'low',
              hearts: [{ color: HeartColor.PURPLE, count: 5 }],
              sourceCardId: 'high',
              abilityId: 'test-original',
            });
      game = choose(game);
      expect(game.activeEffect).toBeNull();
      expect(uses(game)).toHaveLength(1);
      expect(stateEvents(game)).toHaveLength(0);
    }
  });

  it('refreshes a reentered target for a new choice instead of acting on the new rules object', () => {
    let game = start(cheer(setup()));
    game = emitGameEvent(
      game,
      createEnterStageEvent('low', ZoneType.WAITING_ROOM, S.LEFT, 'p2', 'p2')
    );
    game = choose(game);
    expect(game.activeEffect?.selectableCardIds).toEqual(['low']);
    expect(orientation(game)).toBe(O.ACTIVE);
    expect(uses(game)).toHaveLength(1);
    expect(stateEvents(game)).toHaveLength(0);
    expect(orientation(choose(game))).toBe(O.WAITING);
  });

  it('uses each physical source once per turn and automatically processes ordered no-action abilities', () => {
    let game = start(cheer(setup({ copies: 2 }), ['cheer0']));
    expect(game.activeEffect?.abilityId).toBe('system:select-pending-card-effect');
    game = confirmActiveEffectStep(game, 'p1', game.activeEffect!.id, null, null, true);
    expect(game.activeEffect).toBeNull();
    expect(uses(game)).toHaveLength(2);
    expect(new Set(uses(game).map((a) => a.payload.sourceCardId))).toEqual(
      new Set(['live0', 'live1'])
    );
    expect(cheer(game).pendingAbilities).toEqual([]);
    const nextTurn = cheer({ ...game, turnCount: game.turnCount + 1 });
    expect(nextTurn.pendingAbilities.filter((p) => p.abilityId === ABILITY)).toHaveLength(2);
  });

  it('manual selection of a no-action pending uses the confirmation bridge before consuming its turn', () => {
    const game = start(cheer(setup({ copies: 2 }), ['cheer0']));
    const selected = game.pendingAbilities[0]!;
    let manual = confirmActiveEffectStep(
      game,
      'p1',
      game.activeEffect!.id,
      undefined,
      undefined,
      undefined,
      selected.id
    );
    expect(manual.activeEffect?.metadata?.confirmOnlyPendingAbility).toBe(true);
    expect(uses(manual)).toHaveLength(0);
    manual = confirm(manual);
    expect(uses(manual)).toHaveLength(1);
    expect(uses(manual)[0]?.payload.pendingAbilityId).toBe(selected.id);
  });

  it.each(['pending', 'selecting'])(
    'keeps the original source lifecycle when the LIVE leaves and reenters during %s',
    (when) => {
      let game = cheer(setup());
      const original = game.pendingAbilities[0]!.sourceLifecycleId;
      expect(original).toBe(getAbilitySourceLifecycleId(game, ABILITY, 'live0'));
      if (when === 'selecting') game = start(game);
      game = updatePlayer(game, 'p1', (p) => ({
        ...p,
        liveZone: { ...p.liveZone, cardIds: [] },
        waitingRoom: { ...p.waitingRoom, cardIds: ['live0'] },
      }));
      if (when === 'pending') game = start(game);
      expect(game.activeEffect?.sourceLifecycleId).toBe(original);
      game = updatePlayer(game, 'p1', (p) => ({
        ...p,
        liveZone: { ...p.liveZone, cardIds: ['live0'] },
        waitingRoom: { ...p.waitingRoom, cardIds: [] },
      }));
      game = emitGameEvent(
        game,
        createEnterLiveZoneEvent('live0', ZoneType.WAITING_ROOM, 'p1', 'p1', FaceState.FACE_UP)
      );
      const current = getAbilitySourceLifecycleId(game, ABILITY, 'live0');
      expect(current).not.toBe(original);
      game = choose(game);
      expect(uses(game)).toHaveLength(1);
      expect(uses(game)[0]?.payload.sourceLifecycleId).toBe(original);
      const reentered = cheer(setOrientation(game, 'p2', 'low', O.ACTIVE));
      expect(reentered.pendingAbilities).toHaveLength(1);
      expect(reentered.pendingAbilities[0]?.sourceLifecycleId).toBe(current);
      const result = choose(start(reentered));
      expect(uses(result).map((a) => a.payload.sourceLifecycleId)).toEqual([original, current]);
    }
  );

  it('allows the new LIVE lifecycle to trigger while the old invocation remains pending', () => {
    let game = cheer(setup());
    const oldPending = game.pendingAbilities[0]!;
    game = emitGameEvent(
      game,
      createEnterLiveZoneEvent('live0', ZoneType.WAITING_ROOM, 'p1', 'p1', FaceState.FACE_UP)
    );
    game = cheer(game);
    expect(game.pendingAbilities).toHaveLength(2);
    expect(new Set(game.pendingAbilities.map((p) => p.sourceLifecycleId)).size).toBe(2);
    game = start(game);
    game = confirmActiveEffectStep(
      game,
      'p1',
      game.activeEffect!.id,
      undefined,
      undefined,
      undefined,
      oldPending.id
    );
    expect(game.activeEffect?.sourceLifecycleId).toBe(oldPending.sourceLifecycleId);
    game = choose(game);
    expect(uses(game)[0]?.payload.sourceLifecycleId).toBe(oldPending.sourceLifecycleId);
    expect(game.activeEffect?.metadata?.confirmOnlyPendingAbility).toBe(true);
    game = confirm(game);
    expect(uses(game)).toHaveLength(2);
    expect(new Set(uses(game).map((a) => a.payload.sourceLifecycleId)).size).toBe(2);
  });

  it('queues the BiBi 015 reaction from the real state event and starts it only after this ability completes', () => {
    let game = registerCards(setup(), [
      createCardInstance(
        { ...member('西木野真姬', 7), cardCode: 'PL!-pb2-015-P+' },
        'p1',
        'reaction'
      ),
    ]);
    game = updatePlayer(game, 'p1', (p) => ({
      ...p,
      memberSlots: placeCardInSlot(p.memberSlots, S.RIGHT, 'reaction', {
        orientation: O.ACTIVE,
        face: FaceState.FACE_UP,
      }),
    }));
    game = setOrientation(game, 'p1', 'center', O.WAITING);
    game = start(cheer(game));
    expect(game.activeEffect?.abilityId).toBe(ABILITY);
    expect(game.pendingAbilities.some((p) => p.abilityId === REACTION)).toBe(false);
    game = choose(game);
    expect(stateEvents(game)).toHaveLength(1);
    expect(game.activeEffect?.abilityId).toBe(REACTION);
    const finishedAt = game.actionHistory.findIndex(
      (a) =>
        a.payload.abilityId === ABILITY &&
        a.payload.step === 'WAIT_OPPONENT_LOW_ORIGINAL_HEART_MEMBER'
    );
    const triggeredAt = game.actionHistory.findIndex(
      (a) => a.type === 'TRIGGER_ABILITY' && a.payload.abilityId === REACTION
    );
    expect(finishedAt).toBeGreaterThanOrEqual(0);
    expect(triggeredAt).toBeGreaterThan(finishedAt);
  });
});
