import { describe, expect, it } from 'vitest';
import {
  createCardInstance,
  type LiveCardData,
  type MemberCardData,
} from '../../src/domain/entities/card';
import { createGameState, registerCards, updatePlayer } from '../../src/domain/entities/game';
import {
  countSuccessZoneCardsForCardEffect,
  getOwnedSuccessfulGroupScoreCardIds,
} from '../../src/domain/rules/success-zone-card-queries';
import { sumSuccessfulLiveScore } from '../../src/domain/rules/success-live-score';
import { ruleActionProcessor } from '../../src/domain/rules/rule-actions';
import { countSuccessfulLiveCards } from '../../src/application/effects/conditions';
import { BladeHeartEffect, CardType } from '../../src/shared/types/enums';

const member = (unitName: string): MemberCardData => ({
  cardCode: 'source',
  name: 'source',
  cardType: CardType.MEMBER,
  cost: 4,
  blade: 1,
  hearts: [],
  unitName,
});
const live = (cardCode: string): LiveCardData => ({
  cardCode,
  name: '春情浪漫',
  cardType: CardType.LIVE,
  score: 7,
  requiredHearts: [],
  groupNames: ['μ’s'],
  unitName: '「lilywhite」',
  bladeHearts: [{ effect: BladeHeartEffect.SCORE }],
});
function setup(unitName = 'lily white', rare = 'L') {
  let game = registerCards(createGameState('counts', 'p1', 'P1', 'p2', 'P2'), [
    createCardInstance(member(unitName), 'p1', 'source'),
    createCardInstance(live(`PL!-pb2-041-${rare}`), 'p1', 'romantic'),
    createCardInstance(live('PL!-pb2-041-UNSEEN'), 'p1', 'romantic2'),
    createCardInstance(live('ordinary'), 'p1', 'ordinary'),
    createCardInstance(live('PL!-pb2-041-L'), 'p2', 'opponent'),
    createCardInstance(
      {
        ...member('lilywhite'),
        groupNames: ['μ’s'],
        bladeHearts: [{ effect: BladeHeartEffect.SCORE }],
      },
      'p1',
      'score-member'
    ),
  ]);
  return updatePlayer(game, 'p1', (p) => ({
    ...p,
    successZone: { ...p.successZone, cardIds: ['romantic', 'ordinary'] },
    waitingRoom: { ...p.waitingRoom, cardIds: ['source'] },
  }));
}

describe('success-zone card counts for a card effect', () => {
  it.each(['L', 'NEW'])(
    'counts the %s source card twice only for an own lily white effect, including a paid source in waiting',
    (rare) => {
      const game = setup('「lilywhite」', rare);
      expect(countSuccessZoneCardsForCardEffect(game, 'p1', 'source')).toBe(3);
      expect(countSuccessZoneCardsForCardEffect(setup('Printemps', rare), 'p1', 'source')).toBe(2);
      expect(countSuccessZoneCardsForCardEffect(game, 'p1', 'missing')).toBe(2);
      expect(countSuccessZoneCardsForCardEffect(game, 'p2', 'source')).toBe(0);
      expect(countSuccessZoneCardsForCardEffect(game, 'missing', 'source')).toBe(0);
    }
  );
  it('intersects matching IDs with the current owned zone, deduplicates, and gives each copy exactly two', () => {
    const game = updatePlayer(setup(), 'p1', (p) => ({
      ...p,
      successZone: {
        ...p.successZone,
        cardIds: ['romantic', 'romantic', 'romantic2', 'score-member', 'opponent', 'missing'],
      },
    }));
    expect(countSuccessZoneCardsForCardEffect(game, 'p1', 'source')).toBe(5);
    expect(
      countSuccessZoneCardsForCardEffect(game, 'p1', 'source', [
        'romantic',
        'romantic',
        'ordinary',
        'opponent',
        'missing',
      ])
    ).toBe(2);
    expect(countSuccessZoneCardsForCardEffect(game, 'p1', 'source', [])).toBe(0);
    expect(
      countSuccessZoneCardsForCardEffect(
        game,
        'p1',
        'source',
        getOwnedSuccessfulGroupScoreCardIds(game, 'p1', "μ's")
      )
    ).toBe(5);
  });
  it('does not double a card outside success, physical cards, victory counts, or score sums', () => {
    const game = setup();
    expect(countSuccessZoneCardsForCardEffect(game, 'p1', 'source')).toBe(3);
    expect(countSuccessfulLiveCards(game, 'p1')).toBe(2);
    expect(ruleActionProcessor.checkVictoryCondition(game.players).hasWinner).toBe(false);
    expect(sumSuccessfulLiveScore(game, 'p1')).toBe(14);
    const removed = updatePlayer(game, 'p1', (p) => ({
      ...p,
      successZone: { ...p.successZone, cardIds: ['ordinary'] },
      liveZone: { ...p.liveZone, cardIds: ['romantic'] },
    }));
    expect(countSuccessZoneCardsForCardEffect(removed, 'p1', 'source')).toBe(1);
    expect(game.players[0].successZone.cardIds).toEqual(['romantic', 'ordinary']);
  });
});
