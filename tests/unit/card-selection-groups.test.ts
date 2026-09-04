import { describe, expect, it } from 'vitest';
import {
  matchesSelectionGroups,
  type CardSelectionGroup,
} from '../../src/application/effects/card-selection-groups';

describe('matchesSelectionGroups', () => {
  it.each([false, true])(
    'does not constrain selections when groups are absent (%s)',
    (distinct) => {
      expect(matchesSelectionGroups([], undefined, distinct)).toBe(true);
      expect(matchesSelectionGroups(['a'], undefined, distinct)).toBe(true);
    }
  );

  it.each([false, true])('requires every selected card to belong to a group (%s)', (distinct) => {
    const groups = [{ candidateCardIds: ['a'], minCount: 0, maxCount: 1 }];
    expect(matchesSelectionGroups(['unknown'], groups, distinct)).toBe(false);
    expect(matchesSelectionGroups([], [], distinct)).toBe(true);
    expect(matchesSelectionGroups(['a'], [], distinct)).toBe(false);
  });

  it('counts an overlapping card in every matching group in ordinary mode', () => {
    const groups: readonly CardSelectionGroup[] = [
      { candidateCardIds: ['shared', 'a'], minCount: 1, maxCount: 1 },
      { candidateCardIds: ['shared'], minCount: 1, maxCount: 1 },
    ];
    expect(matchesSelectionGroups(['shared'], groups, false)).toBe(true);
    expect(matchesSelectionGroups(['shared', 'a'], groups, false)).toBe(false);
  });

  it('does not let one physical card fill two required groups in distinct mode', () => {
    const groups: readonly CardSelectionGroup[] = [
      { candidateCardIds: ['shared'], minCount: 1, maxCount: 1 },
      { candidateCardIds: ['shared'], minCount: 1, maxCount: 1 },
    ];
    expect(matchesSelectionGroups(['shared'], groups, true)).toBe(false);
  });

  it('backtracks to find a distinct assignment instead of assigning greedily', () => {
    const groups: readonly CardSelectionGroup[] = [
      { candidateCardIds: ['shared', 'a'], minCount: 1, maxCount: 1 },
      { candidateCardIds: ['shared'], minCount: 1, maxCount: 1 },
    ];
    expect(matchesSelectionGroups(['shared', 'a'], groups, true)).toBe(true);
    expect(matchesSelectionGroups(['a', 'shared'], groups, true)).toBe(true);
  });

  it.each([false, true])('enforces inclusive group minimums and maximums (%s)', (distinct) => {
    const groups = [{ candidateCardIds: ['a', 'b', 'c'], minCount: 1, maxCount: 2 }];
    expect(matchesSelectionGroups([], groups, distinct)).toBe(false);
    expect(matchesSelectionGroups(['a'], groups, distinct)).toBe(true);
    expect(matchesSelectionGroups(['a', 'b'], groups, distinct)).toBe(true);
    expect(matchesSelectionGroups(['a', 'b', 'c'], groups, distinct)).toBe(false);
  });

  it.each([false, true])(
    'allows an optional empty group but rejects an unmet required group (%s)',
    (distinct) => {
      const required = [{ candidateCardIds: [], minCount: 1, maxCount: 1 }];
      const optional = [{ candidateCardIds: [], minCount: 0, maxCount: 1 }];
      expect(matchesSelectionGroups([], required, distinct)).toBe(false);
      expect(matchesSelectionGroups([], optional, distinct)).toBe(true);
    }
  );

  it('preserves the caller selection order and group candidates', () => {
    const selection = Object.freeze(['shared', 'a']);
    const groups = Object.freeze([
      Object.freeze({ candidateCardIds: Object.freeze(['shared', 'a']), minCount: 1, maxCount: 1 }),
      Object.freeze({ candidateCardIds: Object.freeze(['shared']), minCount: 1, maxCount: 1 }),
    ]);
    expect(matchesSelectionGroups(selection, groups, true)).toBe(true);
    expect(selection).toEqual(['shared', 'a']);
    expect(groups[0]!.candidateCardIds).toEqual(['shared', 'a']);
  });

  it('matches an exhaustive assignment oracle for all two-card, two-group memberships and bounds', () => {
    const cards = ['a', 'b'];
    const bounds = [
      [0, 0],
      [0, 1],
      [1, 1],
      [0, 2],
      [1, 2],
      [2, 2],
    ] as const;
    for (let membership = 0; membership < 16; membership += 1) {
      for (const firstBounds of bounds) {
        for (const secondBounds of bounds) {
          const groups = [firstBounds, secondBounds].map(([minCount, maxCount], groupIndex) => ({
            candidateCardIds: cards.filter(
              (_, cardIndex) => (membership & (1 << (groupIndex * cards.length + cardIndex))) !== 0
            ),
            minCount,
            maxCount,
          }));
          for (let selectionMask = 0; selectionMask < 4; selectionMask += 1) {
            const selection = cards.filter((_, index) => (selectionMask & (1 << index)) !== 0);
            expect(matchesSelectionGroups(selection, groups, true)).toBe(
              exhaustiveDistinctAssignment(selection, groups)
            );
          }
        }
      }
    }
  });

  it('matches a deterministic randomized small-case exhaustive oracle', () => {
    let seed = 19790503;
    const next = (bound: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % bound;
    };
    for (let example = 0; example < 400; example += 1) {
      const cards = Array.from({ length: next(7) }, (_, index) => `card-${index}`);
      const groups = Array.from({ length: next(5) }, () => {
        const minCount = next(3);
        return {
          candidateCardIds: cards.filter(() => next(3) !== 0),
          minCount,
          maxCount: minCount + next(4),
        };
      });
      expect(matchesSelectionGroups(cards, groups, true)).toBe(
        exhaustiveDistinctAssignment(cards, groups)
      );
    }
  });

  it.each([0, 1])('rejects a large overlapping Hall bottleneck with minimum %s', (minCount) => {
    const cards = Array.from({ length: 256 }, (_, index) => `card-${index}`);
    const groups = Array.from({ length: 256 }, (_, index) => ({
      candidateCardIds: index < 128 ? cards.slice(0, 129) : cards.slice(129),
      minCount,
      maxCount: 1,
    }));
    expect(matchesSelectionGroups(cards, groups, true)).toBe(false);
  });

  it('fills overlapping required groups and then augments through them to match remaining cards', () => {
    const groups = [
      { candidateCardIds: ['a', 'b'], minCount: 1, maxCount: 1 },
      { candidateCardIds: ['a'], minCount: 0, maxCount: 1 },
    ];
    expect(matchesSelectionGroups(['a', 'b'], groups, true)).toBe(true);
  });
});

function exhaustiveDistinctAssignment(
  selectedCardIds: readonly string[],
  groups: readonly CardSelectionGroup[]
): boolean {
  const counts = groups.map(() => 0);
  const search = (index: number): boolean => {
    if (index === selectedCardIds.length) {
      return groups.every(
        (group, groupIndex) =>
          counts[groupIndex]! >= group.minCount && counts[groupIndex]! <= group.maxCount
      );
    }
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const group = groups[groupIndex]!;
      if (
        !group.candidateCardIds.includes(selectedCardIds[index]!) ||
        counts[groupIndex]! >= group.maxCount
      )
        continue;
      counts[groupIndex] += 1;
      if (search(index + 1)) return true;
      counts[groupIndex] -= 1;
    }
    return false;
  };
  return search(0);
}
