import { describe, expect, it } from 'vitest';
import {
  confirmActiveEffectStep,
  enqueueTriggeredCardEffects,
  resolvePendingCardEffects,
} from '../../src/application/card-effect-runner';
import {
  PL_PB2_041_CONTINUOUS_SUCCESS_COUNTS_AS_TWO_FOR_LILY_WHITE_ABILITY_ID as CONTINUOUS,
  PL_PB2_041_LIVE_START_TWO_LILY_WHITE_SUCCESS_SCORE_ABILITY_ID as ABILITY,
} from '../../src/application/card-effects/ability-ids';
import { getCardAbilityDefinitionsForCardCode } from '../../src/application/card-effects/definitions/lookup';
import { createCardInstance, type LiveCardData } from '../../src/domain/entities/card';
import { createGameState, registerCards, updatePlayer } from '../../src/domain/entities/game';
import { getLiveCardScoreModifier } from '../../src/domain/rules/live-modifiers';
import {
  CardType,
  FaceState,
  OrientationState,
  TriggerCondition as T,
} from '../../src/shared/types/enums';
import { addCheckTimingRuleSentinel } from '../helpers/check-timing-rule-sentinel';

const CONTINUOUS_TEXT =
  '【常时】只要此卡存在于自己的成功LIVE卡区，因自己的『lily white』的卡片，计算存在于自己的成功LIVE卡区的卡片的张数时，此卡当作2张计算。';
const TEXT =
  '【LIVE开始时】存在于自己的成功LIVE卡区的『lily white』的卡片大于等于2张的场合，此卡的分数+1。';
const live = (cardCode: string, unitName = '「lilywhite」'): LiveCardData => ({
  cardCode,
  name: '春情浪漫',
  cardType: CardType.LIVE,
  score: 7,
  requiredHearts: [],
  unitName,
  groupNames: ['μ’s'],
});
function setup(successCodes: string[] = ['PL!-pb2-041-L'], second = false) {
  const sourceIds = second ? ['a', 'b'] : ['a'];
  const successIds = successCodes.map((_, i) => `success-${i}`);
  let game = registerCards(createGameState('romantic', 'p1', 'P1', 'p2', 'P2'), [
    createCardInstance(live('PL!-pb2-041-L'), 'p1', 'a'),
    createCardInstance(live('PL!-pb2-041-NEW'), 'p1', 'b'),
    ...successCodes.map((code, i) =>
      createCardInstance(live(code, code === 'BiBi' ? 'BiBi' : 'lily white'), 'p1', successIds[i])
    ),
  ]);
  game = updatePlayer(game, 'p1', (p) => ({
    ...p,
    liveZone: {
      ...p.liveZone,
      cardIds: sourceIds,
      cardStates: new Map(
        sourceIds.map((id) => [
          id,
          { face: FaceState.FACE_UP, orientation: OrientationState.WAITING },
        ])
      ),
    },
    successZone: { ...p.successZone, cardIds: successIds },
  }));
  game = {
    ...game,
    liveResolution: {
      ...game.liveResolution,
      playerScores: new Map([['p1', 7 * sourceIds.length]]),
    },
  };
  game = addCheckTimingRuleSentinel(game, 'p1', 'romantic1');
  game = addCheckTimingRuleSentinel(game, 'p2', 'romantic2');
  return enqueueTriggeredCardEffects(game, [T.ON_LIVE_START]);
}

describe('PL!-pb2-041 分数7「春情浪漫」', () => {
  it.each(['L', 'NEW'])('has two independent complete paragraphs for rarity %s', (rare) => {
    const definitions = getCardAbilityDefinitionsForCardCode(`PL!-pb2-041-${rare}`);
    expect(definitions).toHaveLength(2);
    expect(definitions).toContainEqual(
      expect.objectContaining({
        abilityId: CONTINUOUS,
        baseCardCodes: ['PL!-pb2-041'],
        queued: false,
        effectText: CONTINUOUS_TEXT,
      })
    );
    expect(definitions).toContainEqual(
      expect.objectContaining({
        abilityId: ABILITY,
        baseCardCodes: ['PL!-pb2-041'],
        queued: true,
        effectText: TEXT,
      })
    );
  });
  it.each([
    { codes: [], counted: 0, bonus: 0 },
    { codes: ['ordinary'], counted: 1, bonus: 0 },
    { codes: ['ordinary', 'ordinary2'], counted: 2, bonus: 1 },
    { codes: ['PL!-pb2-041-L'], counted: 2, bonus: 1 },
    { codes: ['PL!-pb2-041-NEW', 'BiBi'], counted: 2, bonus: 1 },
  ])(
    'counts $codes as $counted and gives this LIVE $bonus only after confirmation',
    ({ codes, counted, bonus }) => {
      const preview = resolvePendingCardEffects(setup(codes)).gameState;
      expect(preview.activeEffect?.abilityId).toBe(ABILITY);
      expect(preview.activeEffect?.effectText).toBe(
        `${TEXT}（当前自己的成功LIVE卡区的『lily white』卡片按本效果计为${counted}张，${bonus ? '满足条件，此卡的分数+1' : '未满足条件，此卡的分数不变'}。）`
      );
      expect(preview.liveResolution.liveModifiers).toEqual([]);
      expect(confirmActiveEffectStep(preview, 'p1', 'invalid')).toBe(preview);
      const done = confirmActiveEffectStep(preview, 'p1', preview.activeEffect!.id);
      expect(done.activeEffect).toBeNull();
      expect(done.pendingAbilities).toEqual([]);
      expect(done.liveResolution.playerScores.get('p1')).toBe(7 + bonus);
      expect(getLiveCardScoreModifier(done.liveResolution, 'a')).toBe(bonus);
      expect(getLiveCardScoreModifier(done.liveResolution, 'b')).toBe(0);
      expect(confirmActiveEffectStep(done, 'p1', preview.activeEffect!.id)).toBe(done);
    }
  );
  it('rechecks the success zone and source at confirmation, then retains an already-resolved bonus', () => {
    const preview = resolvePendingCardEffects(setup()).gameState;
    const cleared = updatePlayer(preview, 'p1', (p) => ({
      ...p,
      successZone: { ...p.successZone, cardIds: [] },
    }));
    expect(
      confirmActiveEffectStep(cleared, 'p1', cleared.activeEffect!.id).liveResolution.liveModifiers
    ).toEqual([]);
    const sourceGone = updatePlayer(preview, 'p1', (p) => ({
      ...p,
      liveZone: { ...p.liveZone, cardIds: [] },
    }));
    const noSource = confirmActiveEffectStep(sourceGone, 'p1', sourceGone.activeEffect!.id);
    expect(noSource.liveResolution.liveModifiers).toEqual([]);
    expect(noSource.pendingAbilities).toEqual([]);
    const done = confirmActiveEffectStep(preview, 'p1', preview.activeEffect!.id);
    const later = updatePlayer(done, 'p1', (p) => ({
      ...p,
      successZone: { ...p.successZone, cardIds: [] },
    }));
    expect(getLiveCardScoreModifier(later.liveResolution, 'a')).toBe(1);
  });
  it('uses the shared ordered/manual pending bridge without triggering the success-zone copy', () => {
    const game = setup(undefined, true);
    expect(game.pendingAbilities.map((p) => p.sourceCardId)).toEqual(['a', 'b']);
    let ordered = resolvePendingCardEffects(game).gameState;
    ordered = confirmActiveEffectStep(ordered, 'p1', ordered.activeEffect!.id, null, null, true);
    expect(ordered.activeEffect).toBeNull();
    expect(ordered.pendingAbilities).toEqual([]);
    expect(ordered.liveResolution.playerScores.get('p1')).toBe(16);
    let manual = resolvePendingCardEffects(game).gameState;
    manual = confirmActiveEffectStep(manual, 'p1', manual.activeEffect!.id, 'b');
    expect(manual.activeEffect).toMatchObject({
      abilityId: ABILITY,
      sourceCardId: 'b',
      metadata: { confirmOnlyPendingAbility: true },
    });
    expect(manual.liveResolution.liveModifiers).toEqual([]);
    manual = confirmActiveEffectStep(manual, 'p1', manual.activeEffect!.id);
    expect(getLiveCardScoreModifier(manual.liveResolution, 'b')).toBe(1);
    expect(manual.activeEffect?.sourceCardId).toBe('a');
  });
});
