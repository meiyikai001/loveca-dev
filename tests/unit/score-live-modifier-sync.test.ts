import { describe, expect, it } from 'vitest';
import {
  createGameState,
  updateLiveResolution,
  type GameState,
  type LiveModifierState,
} from '../../src/domain/entities/game';
import {
  addScoreLiveModifierAndSyncPlayerScores,
  replaceScoreLiveModifierAndSyncPlayerScores,
  type ScoreLiveModifierMatch,
} from '../../src/domain/rules/live-modifiers';

type ScoreModifier = Extract<LiveModifierState, { readonly kind: 'SCORE' }>;

const BASE_MODIFIER: ScoreModifier = {
  kind: 'SCORE',
  playerId: 'p1',
  countDelta: 1,
  sourceCardId: 'source-1',
  abilityId: 'test:score',
};

const BASE_MATCH: ScoreLiveModifierMatch = {
  kind: 'SCORE',
  playerId: 'p1',
  liveCardId: null,
  sourceCardId: 'source-1',
  targetMemberCardId: null,
  abilityId: 'test:score',
};

function createGame(score = 0): GameState {
  const game = createGameState('score-modifier-sync', 'p1', 'P1', 'p2', 'P2');
  if (score === 0) {
    return game;
  }
  return updateLiveResolution(game, (liveResolution) => ({
    ...liveResolution,
    playerScores: new Map(liveResolution.playerScores).set('p1', score),
  }));
}

describe('SCORE live modifier and playerScores synchronization', () => {
  it('adds stackable modifiers while updating compatibility and score draft atomically', () => {
    const first = addScoreLiveModifierAndSyncPlayerScores(createGame(3), BASE_MODIFIER);
    const second = addScoreLiveModifierAndSyncPlayerScores(first.gameState, {
      ...BASE_MODIFIER,
      sourceCardId: 'source-2',
      abilityId: 'test:score-2',
      countDelta: 2,
    });

    expect(first).toMatchObject({
      previousTotal: 0,
      nextTotal: 1,
      appliedScoreDelta: 1,
    });
    expect(second).toMatchObject({
      previousTotal: 0,
      nextTotal: 2,
      appliedScoreDelta: 2,
    });
    expect(second.gameState.liveResolution.liveModifiers).toHaveLength(2);
    expect(second.gameState.liveResolution.playerScoreBonuses.get('p1')).toBe(3);
    expect(second.gameState.liveResolution.playerScores.get('p1')).toBe(6);
  });

  it.each([
    { previous: 0, next: 2, expectedDelta: 2 },
    { previous: 1, next: 2, expectedDelta: 1 },
    { previous: 2, next: 0, expectedDelta: -2 },
    { previous: 2, next: 2, expectedDelta: 0 },
  ])(
    'replaces $previous→$next using the matched modifier total delta',
    ({ previous, next, expectedDelta }) => {
      let game = createGame();
      if (previous !== 0) {
        game = addScoreLiveModifierAndSyncPlayerScores(game, {
          ...BASE_MODIFIER,
          countDelta: previous,
        }).gameState;
      }

      const result = replaceScoreLiveModifierAndSyncPlayerScores(
        game,
        BASE_MATCH,
        next === 0 ? null : { ...BASE_MODIFIER, countDelta: next }
      );

      expect(result).toMatchObject({
        previousTotal: previous,
        nextTotal: next,
        appliedScoreDelta: expectedDelta,
      });
      expect(result.gameState.liveResolution.playerScores.get('p1') ?? 0).toBe(next);
      expect(result.gameState.liveResolution.playerScoreBonuses.get('p1') ?? 0).toBe(next);
      expect(
        result.gameState.liveResolution.liveModifiers.filter(
          (modifier) =>
            modifier.kind === 'SCORE' &&
            modifier.sourceCardId === BASE_MODIFIER.sourceCardId &&
            modifier.abilityId === BASE_MODIFIER.abilityId
        )
      ).toHaveLength(next === 0 ? 0 : 1);
    }
  );

  it('treats a zero replacement as removal and remains idempotent when repeated', () => {
    const added = addScoreLiveModifierAndSyncPlayerScores(createGame(), {
      ...BASE_MODIFIER,
      countDelta: 2,
    });
    const removed = replaceScoreLiveModifierAndSyncPlayerScores(added.gameState, BASE_MATCH, {
      ...BASE_MODIFIER,
      countDelta: 0,
    });
    const repeated = replaceScoreLiveModifierAndSyncPlayerScores(removed.gameState, BASE_MATCH, {
      ...BASE_MODIFIER,
      countDelta: 0,
    });

    expect(removed).toMatchObject({
      previousTotal: 2,
      nextTotal: 0,
      appliedScoreDelta: -2,
    });
    expect(repeated).toMatchObject({
      previousTotal: 0,
      nextTotal: 0,
      appliedScoreDelta: 0,
    });
    expect(repeated.gameState.liveResolution.liveModifiers).toEqual([]);
    expect(repeated.gameState.liveResolution.playerScoreBonuses.get('p1') ?? 0).toBe(0);
    expect(repeated.gameState.liveResolution.playerScores.get('p1') ?? 0).toBe(0);
  });

  it('keeps a repeated nonzero replacement idempotent', () => {
    const first = replaceScoreLiveModifierAndSyncPlayerScores(
      addScoreLiveModifierAndSyncPlayerScores(createGame(), BASE_MODIFIER).gameState,
      BASE_MATCH,
      { ...BASE_MODIFIER, countDelta: 2 }
    );
    const repeated = replaceScoreLiveModifierAndSyncPlayerScores(first.gameState, BASE_MATCH, {
      ...BASE_MODIFIER,
      countDelta: 2,
    });

    expect(first).toMatchObject({
      previousTotal: 1,
      nextTotal: 2,
      appliedScoreDelta: 1,
    });
    expect(repeated).toMatchObject({
      previousTotal: 2,
      nextTotal: 2,
      appliedScoreDelta: 0,
    });
    expect(repeated.gameState.liveResolution.liveModifiers).toEqual([
      { ...BASE_MODIFIER, countDelta: 2 },
    ]);
    expect(repeated.gameState.liveResolution.playerScores.get('p1')).toBe(2);
  });

  it('rejects a replacement whose identity differs from the exact matcher', () => {
    const game = addScoreLiveModifierAndSyncPlayerScores(createGame(), BASE_MODIFIER).gameState;

    expect(() =>
      replaceScoreLiveModifierAndSyncPlayerScores(game, BASE_MATCH, {
        ...BASE_MODIFIER,
        sourceCardId: 'different-source',
        countDelta: 2,
      })
    ).toThrow('SCORE replacement identity does not match');
    expect(game.liveResolution.liveModifiers).toEqual([BASE_MODIFIER]);
    expect(game.liveResolution.playerScores.get('p1')).toBe(1);
  });

  it('sums every matched old modifier without removing another source', () => {
    let game = addScoreLiveModifierAndSyncPlayerScores(createGame(), BASE_MODIFIER).gameState;
    game = addScoreLiveModifierAndSyncPlayerScores(game, {
      ...BASE_MODIFIER,
      countDelta: 2,
    }).gameState;
    const otherModifier: ScoreModifier = {
      ...BASE_MODIFIER,
      sourceCardId: 'other-source',
      abilityId: 'other:ability',
      countDelta: 4,
    };
    game = addScoreLiveModifierAndSyncPlayerScores(game, otherModifier).gameState;
    const sameIdentityPerLive: ScoreModifier = {
      ...BASE_MODIFIER,
      liveCardId: 'live-1',
      countDelta: 6,
    };
    const sameIdentityTargetMember: ScoreModifier = {
      ...BASE_MODIFIER,
      targetMemberCardId: 'member-1',
      countDelta: 7,
    };
    game = addScoreLiveModifierAndSyncPlayerScores(game, sameIdentityPerLive).gameState;
    game = addScoreLiveModifierAndSyncPlayerScores(game, sameIdentityTargetMember).gameState;

    const result = replaceScoreLiveModifierAndSyncPlayerScores(game, BASE_MATCH, {
      ...BASE_MODIFIER,
      countDelta: 5,
    });

    expect(result).toMatchObject({
      previousTotal: 3,
      nextTotal: 5,
      appliedScoreDelta: 2,
    });
    expect(result.gameState.liveResolution.liveModifiers).toContainEqual(otherModifier);
    expect(result.gameState.liveResolution.liveModifiers).toContainEqual(sameIdentityPerLive);
    expect(result.gameState.liveResolution.liveModifiers).toContainEqual(sameIdentityTargetMember);
    expect(result.gameState.liveResolution.liveModifiers).toHaveLength(4);
    expect(result.gameState.liveResolution.playerScoreBonuses.get('p1')).toBe(22);
    expect(result.gameState.liveResolution.playerScores.get('p1')).toBe(22);
  });

  it('preserves player-total, per-live-card, target-member, and visibility identities', () => {
    const playerTotal = BASE_MODIFIER;
    const perLiveCard: ScoreModifier = {
      ...BASE_MODIFIER,
      sourceCardId: 'source-live',
      abilityId: 'test:per-live',
      liveCardId: 'live-1',
      countDelta: 2,
    };
    const targetMember: ScoreModifier = {
      ...BASE_MODIFIER,
      sourceCardId: 'source-member',
      abilityId: 'test:target-member',
      targetMemberCardId: 'member-1',
      visibilityDependency: {
        kind: 'PLAYER_LIVE_ZONE_CONTENTS',
        playerId: 'p1',
      },
      countDelta: 3,
    };

    let game = addScoreLiveModifierAndSyncPlayerScores(createGame(), playerTotal).gameState;
    game = addScoreLiveModifierAndSyncPlayerScores(game, perLiveCard).gameState;
    game = addScoreLiveModifierAndSyncPlayerScores(game, targetMember).gameState;

    expect(game.liveResolution.liveModifiers).toEqual([playerTotal, perLiveCard, targetMember]);
    expect(game.liveResolution.playerScoreBonuses.get('p1')).toBe(6);
    expect(game.liveResolution.playerScores.get('p1')).toBe(6);
  });

  it('applies the workflow-provided actual negative or zero delta without hidden clamping', () => {
    const negative = addScoreLiveModifierAndSyncPlayerScores(createGame(1), {
      ...BASE_MODIFIER,
      countDelta: -1,
    });
    const zeroAtFloor = addScoreLiveModifierAndSyncPlayerScores(negative.gameState, {
      ...BASE_MODIFIER,
      sourceCardId: 'source-at-floor',
      abilityId: 'test:at-floor',
      countDelta: 0,
    });

    expect(negative.appliedScoreDelta).toBe(-1);
    expect(negative.gameState.liveResolution.playerScores.get('p1')).toBe(0);
    expect(negative.gameState.liveResolution.playerScoreBonuses.get('p1')).toBe(-1);
    expect(zeroAtFloor.appliedScoreDelta).toBe(0);
    expect(zeroAtFloor.gameState.liveResolution.playerScores.get('p1')).toBe(0);
    expect(zeroAtFloor.gameState.liveResolution.liveModifiers.at(-1)).toMatchObject({
      kind: 'SCORE',
      countDelta: 0,
    });
  });
});
