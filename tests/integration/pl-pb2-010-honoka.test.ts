import { describe, expect, it } from 'vitest';
import {
  confirmActiveEffectStep,
  enqueueTriggeredCardEffects,
  resolvePendingCardEffects,
} from '../../src/application/card-effect-runner';
import { PL_PB2_010_LIVE_START_PRINTEMPS_ACTIVATED_STAGE_MEMBERS_GAIN_BLADE_ABILITY_ID as ABILITY } from '../../src/application/card-effects/ability-ids';
import { createCardInstance, type MemberCardData } from '../../src/domain/entities/card';
import {
  createGameState,
  emitGameEvent,
  registerCards,
  updatePlayer,
  type PendingAbilityState,
} from '../../src/domain/entities/game';
import { createMemberStateChangedEvent } from '../../src/domain/events/game-events';
import { placeCardInSlot, removeCardFromSlot } from '../../src/domain/entities/zone';
import { getMemberEffectiveBladeCount } from '../../src/domain/rules/live-modifiers';
import {
  CardType,
  FaceState,
  OrientationState as O,
  SlotPosition as S,
  TriggerCondition as T,
} from '../../src/shared/types/enums';
import { addCheckTimingRuleSentinel } from '../helpers/check-timing-rule-sentinel';

const EFFECT_TEXT =
  '【LIVE开始时】LIVE结束时为止，每有1名存在于自己的舞台的，本回合中因自己的『Printemps』的卡片的效果，从待机状态变为活跃状态的成员，获得[ブレード]。';
const data = (cardCode: string): MemberCardData => ({
  cardCode,
  name: '高坂穗乃果',
  unitName: '「Printemps」',
  cardType: CardType.MEMBER,
  cost: 7,
  blade: 1,
  hearts: [],
});
function setup(activated = true, second = false) {
  const cards = [
    createCardInstance(data('PL!-pb2-010-P+'), 'p1', 'a'),
    createCardInstance(data('PL!-pb2-010-NEW'), 'p1', 'b'),
  ];
  let game = registerCards(createGameState('honoka', 'p1', 'P1', 'p2', 'P2'), cards);
  game = updatePlayer(game, 'p1', (p) => ({
    ...p,
    memberSlots: placeCardInSlot(p.memberSlots, S.CENTER, 'a', {
      orientation: O.ACTIVE,
      face: FaceState.FACE_UP,
    }),
  }));
  if (second)
    game = updatePlayer(game, 'p1', (p) => ({
      ...p,
      memberSlots: placeCardInSlot(p.memberSlots, S.LEFT, 'b', {
        orientation: O.WAITING,
        face: FaceState.FACE_UP,
      }),
    }));
  game = addCheckTimingRuleSentinel(game, 'p1', 'honoka1');
  game = addCheckTimingRuleSentinel(game, 'p2', 'honoka2');
  if (activated)
    game = emitGameEvent(
      game,
      createMemberStateChangedEvent('a', 'p1', S.CENTER, O.WAITING, O.ACTIVE, {
        kind: 'CARD_EFFECT',
        playerId: 'p1',
        sourceCardId: 'a',
      })
    );
  return enqueueTriggeredCardEffects(game, [T.ON_LIVE_START]);
}

describe('PL!-pb2-010 费用7 高坂穗乃果 LIVE-start Printemps activation count', () => {
  it('single pending displays the full ability and current count before granting source BLADE', () => {
    const game = resolvePendingCardEffects(setup()).gameState;
    expect(game.activeEffect?.abilityId).toBe(ABILITY);
    expect(game.activeEffect?.metadata?.confirmOnlyPendingAbility).toBe(true);
    expect(game.activeEffect?.effectText).toBe(
      `${EFFECT_TEXT}（当前舞台有1名成员满足本回合的活跃条件，实际获得1个[ブレード]。）`
    );
    expect(getMemberEffectiveBladeCount(game, 'p1', 'a')).toBe(1);
    const done = confirmActiveEffectStep(game, 'p1', game.activeEffect!.id);
    expect(done.pendingAbilities).toEqual([]);
    expect(done.activeEffect).toBeNull();
    expect(getMemberEffectiveBladeCount(done, 'p1', 'a')).toBe(2);
    expect(done.liveResolution.liveModifiers).toContainEqual({
      kind: 'BLADE',
      target: 'SOURCE_MEMBER',
      playerId: 'p1',
      sourceCardId: 'a',
      abilityId: ABILITY,
      countDelta: 1,
    });
  });
  it('zero qualified members still confirms and completes without modifier', () => {
    const game = resolvePendingCardEffects(setup(false)).gameState;
    expect(game.activeEffect?.effectText).toContain('0名成员');
    const done = confirmActiveEffectStep(game, 'p1', game.activeEffect!.id);
    expect(done.pendingAbilities).toEqual([]);
    expect(done.activeEffect).toBeNull();
    expect(done.liveResolution.liveModifiers).toEqual([]);
  });
  it('ordered same-batch pending settles both without extra confirmation and manual choice confirms only the chosen member', () => {
    const game = setup(true, true);
    let ordered = resolvePendingCardEffects(game).gameState;
    expect(ordered.activeEffect?.canResolveInOrder).toBe(true);
    ordered = confirmActiveEffectStep(ordered, 'p1', ordered.activeEffect!.id, null, null, true);
    expect(ordered.activeEffect).toBeNull();
    expect(ordered.pendingAbilities).toEqual([]);
    expect(getMemberEffectiveBladeCount(ordered, 'p1', 'a')).toBe(2);
    expect(getMemberEffectiveBladeCount(ordered, 'p1', 'b')).toBe(2);
    let manual = resolvePendingCardEffects(game).gameState;
    manual = confirmActiveEffectStep(manual, 'p1', manual.activeEffect!.id, 'b');
    expect(manual.activeEffect).toMatchObject({
      abilityId: ABILITY,
      sourceCardId: 'b',
      metadata: { confirmOnlyPendingAbility: true },
    });
    expect(manual.liveResolution.liveModifiers).toEqual([]);
    manual = confirmActiveEffectStep(manual, 'p1', manual.activeEffect!.id);
    expect(getMemberEffectiveBladeCount(manual, 'p1', 'b')).toBe(2);
    expect(manual.activeEffect?.sourceCardId).toBe('a');
  });
  it('rechecks the current stage at confirmation and safely consumes a source that has left', () => {
    let game = resolvePendingCardEffects(setup()).gameState;
    game = updatePlayer(game, 'p1', (p) => ({
      ...p,
      memberSlots: removeCardFromSlot(p.memberSlots, S.CENTER),
    }));
    const done = confirmActiveEffectStep(game, 'p1', game.activeEffect!.id);
    expect(done.activeEffect).toBeNull();
    expect(done.pendingAbilities).toEqual([]);
    expect(done.liveResolution.liveModifiers).toEqual([]);
  });
});
