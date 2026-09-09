import { describe, expect, it } from 'vitest';
import {
  confirmActiveEffectStep,
  enqueueTriggeredCardEffects,
  resolvePendingCardEffects,
} from '../../src/application/card-effect-runner';
import { PL_PB2_040_LIVE_START_PRINTEMPS_ACTIVATED_MEMBERS_REDUCE_REQUIREMENT_ABILITY_ID as ABILITY } from '../../src/application/card-effects/ability-ids';
import { getCardAbilityDefinitionsForCardCode } from '../../src/application/card-effects/definitions/lookup';
import { setMemberOrientation } from '../../src/application/effects/member-state';
import {
  createCardInstance,
  createHeartRequirement,
  type LiveCardData,
  type MemberCardData,
} from '../../src/domain/entities/card';
import {
  createGameState,
  emitGameEvent,
  getCardById,
  registerCards,
  updatePlayer,
  type GameState,
} from '../../src/domain/entities/game';
import {
  createEnterStageEvent,
  createLeaveStageEvent,
  createTurnEndEvent,
  createTurnStartEvent,
  type MemberStateChangeCause,
} from '../../src/domain/events/game-events';
import { placeCardInSlot, removeCardFromSlot } from '../../src/domain/entities/zone';
import { getLiveCardRequirementModifiers } from '../../src/domain/rules/live-modifiers';
import { applyHeartRequirementModifiers } from '../../src/domain/rules/live-requirement-modifiers';
import {
  CardType,
  FaceState,
  HeartColor,
  OrientationState as O,
  SlotPosition as S,
  TriggerCondition as T,
  ZoneType,
} from '../../src/shared/types/enums';
import { createGameSession } from '../../src/application/game-session';
import { createConfirmEffectStepCommand } from '../../src/application/game-commands';
import { addCheckTimingRuleSentinel } from '../helpers/check-timing-rule-sentinel';

const TEXT =
  '【LIVE开始时】自己的舞台上，存在大于等于1名此回合中因自己的『Printemps』的卡片的效果从待机状态变为活跃状态的成员的场合，此卡的需求HEART减少[無ハート][無ハート][無ハート]。存在大于等于2名的场合，再减少[無ハート][無ハート]。存在大于等于3名的场合，再减少[無ハート]。';
const member = (code: string, unitName = 'BiBi'): MemberCardData => ({
  cardCode: code,
  name: code,
  cardType: CardType.MEMBER,
  cost: 1,
  blade: 1,
  hearts: [],
  unitName,
});
const live = (rare: string): LiveCardData => ({
  cardCode: `PL!-pb2-040-${rare}`,
  name: 'Love marginal',
  cardType: CardType.LIVE,
  score: 7,
  unitName: 'Printemps',
  requirements: createHeartRequirement({
    [HeartColor.PINK]: 2,
    [HeartColor.YELLOW]: 6,
    [HeartColor.RAINBOW]: 10,
  }),
});
const face = { face: FaceState.FACE_UP, orientation: O.WAITING };
const cause = { kind: 'CARD_EFFECT', playerId: 'p1', sourceCardId: 'effect-source' } as const;

function setup(secondLive = false) {
  const liveIds = secondLive ? ['live', 'live2'] : ['live'];
  let game = registerCards(createGameState('love-marginal', 'p1', 'P1', 'p2', 'P2'), [
    createCardInstance(live('L'), 'p1', 'live'),
    createCardInstance(live('NEW'), 'p1', 'live2'),
    createCardInstance(member('effect-source', '「Printemps」'), 'p1', 'effect-source'),
    createCardInstance(member('wrong-source'), 'p1', 'wrong-source'),
    ...['a', 'b', 'c'].map((id) => createCardInstance(member(id), 'p1', id)),
  ]);
  game = updatePlayer(game, 'p1', (p) => ({
    ...p,
    memberSlots: placeCardInSlot(
      placeCardInSlot(placeCardInSlot(p.memberSlots, S.LEFT, 'a', face), S.CENTER, 'b', face),
      S.RIGHT,
      'c',
      face
    ),
    liveZone: {
      ...p.liveZone,
      cardIds: liveIds,
      cardStates: new Map(liveIds.map((id) => [id, face])),
    },
    waitingRoom: { ...p.waitingRoom, cardIds: ['effect-source', 'wrong-source'] },
  }));
  game = addCheckTimingRuleSentinel(game, 'p1', 'marginal1');
  game = addCheckTimingRuleSentinel(game, 'p2', 'marginal2');
  return emitGameEvent(game, createTurnStartEvent(1, 'p1'));
}
function orient(
  game: GameState,
  id: string,
  next = O.ACTIVE,
  eventCause: MemberStateChangeCause = cause
) {
  const result = setMemberOrientation(game, 'p1', id, next, eventCause);
  expect(result).not.toBeNull();
  return result!.gameState;
}
function start(game: GameState) {
  return resolvePendingCardEffects(enqueueTriggeredCardEffects(game, [T.ON_LIVE_START])).gameState;
}
function done(game: GameState) {
  return confirmActiveEffectStep(game, 'p1', game.activeEffect!.id);
}
function requirement(game: GameState, cardId = 'live') {
  const card = getCardById(game, cardId)!;
  return applyHeartRequirementModifiers(
    (card.data as LiveCardData).requirements,
    getLiveCardRequirementModifiers(game.liveResolution, cardId)
  );
}

describe('PL!-pb2-040 分数7「Love marginal」', () => {
  it.each(['L', 'NEW'])('registers full text and all rarities: %s', (rare) => {
    expect(getCardAbilityDefinitionsForCardCode(`PL!-pb2-040-${rare}`)).toContainEqual(
      expect.objectContaining({
        abilityId: ABILITY,
        baseCardCodes: ['PL!-pb2-040'],
        queued: true,
        implemented: true,
        effectText: TEXT,
      })
    );
  });
  it.each([
    [0, 0],
    [1, 3],
    [2, 5],
    [3, 6],
  ])(
    'counts %i current stage members and reduces only this LIVE by %i colorless hearts',
    (count, reduction) => {
      let game = setup();
      for (const id of ['a', 'b', 'c'].slice(0, count)) game = orient(game, id);
      const preview = start(game);
      expect(preview.activeEffect?.effectText).toBe(
        `${TEXT}（当前舞台有${count}名成员满足本回合的活跃条件，此卡实际减少${reduction}个[無ハート]。）`
      );
      expect(preview.activeEffect?.metadata?.confirmOnlyPendingAbility).toBe(true);
      expect(requirement(preview).totalRequired).toBe(18);
      const resolved = done(preview);
      expect(resolved.pendingAbilities).toEqual([]);
      expect(resolved.activeEffect).toBeNull();
      expect(requirement(resolved).totalRequired).toBe(18 - reduction);
      expect(requirement(resolved).colorRequirements.get(HeartColor.PINK)).toBe(2);
      expect(requirement(resolved).colorRequirements.get(HeartColor.YELLOW)).toBe(6);
      expect(requirement(resolved, 'live2').totalRequired).toBe(18);
      expect(confirmActiveEffectStep(resolved, 'p1', preview.activeEffect!.id)).toBe(resolved);
    }
  );
  it('counts each activated target once even after it waits again and the Printemps source has left the stage', () => {
    let game = orient(setup(), 'a');
    game = orient(game, 'a', O.WAITING);
    game = orient(game, 'a');
    game = orient(game, 'a', O.WAITING);
    expect(getCardById(game, 'a')?.data.unitName).toBe('BiBi');
    const resolved = done(start(game));
    expect(requirement(resolved).totalRequired).toBe(15);
  });
  it.each([
    { kind: 'PLAYER_ACTION', playerId: 'p1' },
    { kind: 'RULE_ACTION', playerId: 'p1' },
    { ...cause, playerId: 'p2' },
    { ...cause, sourceCardId: 'wrong-source' },
    { ...cause, sourceCardId: 'missing-source' },
  ] satisfies MemberStateChangeCause[])(
    'does not count an activation from $kind / $sourceCardId / $playerId',
    (eventCause) => {
      expect(
        requirement(done(start(orient(setup(), 'a', O.ACTIVE, eventCause)))).totalRequired
      ).toBe(18);
    }
  );
  it('does not count an ACTIVE-to-ACTIVE no-op', () => {
    let game = orient(setup(), 'a', O.ACTIVE, { kind: 'PLAYER_ACTION', playerId: 'p1' });
    game = orient(game, 'a');
    expect(requirement(done(start(game))).totalRequired).toBe(18);
  });
  it('drops the old rules object on cross-zone reentry but preserves intra-stage movement', () => {
    let game = orient(setup(), 'a');
    const movedWithinStage = emitGameEvent(
      game,
      createEnterStageEvent('a', ZoneType.MEMBER_SLOT, S.LEFT, 'p1', 'p1')
    );
    expect(requirement(done(start(movedWithinStage))).totalRequired).toBe(15);
    game = emitGameEvent(
      game,
      createLeaveStageEvent('a', S.LEFT, ZoneType.WAITING_ROOM, 'p1', 'p1')
    );
    game = emitGameEvent(
      game,
      createEnterStageEvent('a', ZoneType.WAITING_ROOM, S.LEFT, 'p1', 'p1')
    );
    expect(requirement(done(start(game))).totalRequired).toBe(18);
    game = orient(game, 'a', O.WAITING);
    game = orient(game, 'a');
    expect(requirement(done(start(game))).totalRequired).toBe(15);
  });
  it('rechecks current stage and source before settlement and resets at turn boundaries', () => {
    const game = orient(setup(), 'a');
    const preview = start(game);
    const left = updatePlayer(preview, 'p1', (p) => ({
      ...p,
      memberSlots: removeCardFromSlot(p.memberSlots, S.LEFT),
    }));
    expect(requirement(done(left)).totalRequired).toBe(18);
    const sourceGone = updatePlayer(preview, 'p1', (p) => ({
      ...p,
      liveZone: { ...p.liveZone, cardIds: [] },
    }));
    const noSource = done(sourceGone);
    expect(noSource.activeEffect).toBeNull();
    expect(noSource.pendingAbilities).toEqual([]);
    expect(noSource.liveResolution.liveModifiers).toEqual([]);
    const ended = emitGameEvent(game, createTurnEndEvent(1, 'p1'));
    expect(requirement(done(start(ended))).totalRequired).toBe(18);
    const nextTurn = emitGameEvent(ended, createTurnStartEvent(2, 'p2'));
    expect(requirement(done(start(nextTurn))).totalRequired).toBe(18);
  });
  it('restores a confirmation through GameSession and settles exactly once', () => {
    const preview = start(orient(setup(), 'a'));
    const session = createGameSession();
    session.restoreRuntimeState({ authorityState: preview, currentPublicSeq: 0 });
    const command = createConfirmEffectStepCommand('p1', preview.activeEffect!.id);
    expect(session.executeCommand(command).success).toBe(true);
    expect(requirement(session.state!).totalRequired).toBe(15);
    expect(session.executeCommand(command).success).toBe(false);
    expect(getLiveCardRequirementModifiers(session.state!.liveResolution, 'live')).toEqual([
      { color: HeartColor.RAINBOW, countDelta: -3 },
    ]);
  });
  it('keeps ordered resolution and manual selection continuation for two LIVE sources', () => {
    const game = orient(setup(true), 'a');
    let ordered = start(game);
    ordered = confirmActiveEffectStep(ordered, 'p1', ordered.activeEffect!.id, null, null, true);
    expect(ordered.activeEffect).toBeNull();
    expect(ordered.pendingAbilities).toEqual([]);
    expect(requirement(ordered).totalRequired).toBe(15);
    expect(requirement(ordered, 'live2').totalRequired).toBe(15);
    let manual = start(game);
    manual = confirmActiveEffectStep(manual, 'p1', manual.activeEffect!.id, 'live2');
    expect(manual.activeEffect).toMatchObject({
      sourceCardId: 'live2',
      abilityId: ABILITY,
      metadata: { confirmOnlyPendingAbility: true },
    });
    expect(requirement(manual, 'live2').totalRequired).toBe(18);
    manual = done(manual);
    expect(requirement(manual, 'live2').totalRequired).toBe(15);
    expect(manual.activeEffect?.sourceCardId).toBe('live');
  });
});
