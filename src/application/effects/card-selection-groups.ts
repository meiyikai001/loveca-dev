export interface CardSelectionGroup {
  readonly candidateCardIds: readonly string[];
  readonly minCount: number;
  readonly maxCount: number;
}

/** Group matching only; callers validate input shape, duplicates and overall counts. */
export function matchesSelectionGroups(
  selectedCardIds: readonly string[],
  groups: readonly CardSelectionGroup[] | undefined,
  distinctGroupAssignment: boolean
): boolean {
  if (!groups) return true;
  if (
    selectedCardIds.some(
      (cardId) => !groups.some((group) => group.candidateCardIds.includes(cardId))
    )
  ) {
    return false;
  }

  if (!distinctGroupAssignment) {
    return groups.every((group) => {
      const count = selectedCardIds.filter((cardId) =>
        group.candidateCardIds.includes(cardId)
      ).length;
      return count >= group.minCount && count <= group.maxCount;
    });
  }

  return matchesDistinctAssignment(selectedCardIds, groups);
}

function matchesDistinctAssignment(
  selectedCardIds: readonly string[],
  groups: readonly CardSelectionGroup[]
): boolean {
  const cardCount = selectedCardIds.length;
  // Matching counts are integers, so round the bounds without changing comparisons.
  const minimums = groups.map((group) => Math.max(0, Math.ceil(group.minCount)));
  const maximums = groups.map((group) => Math.min(cardCount, Math.floor(group.maxCount)));
  if (
    minimums.some((minimum, index) => !(minimum <= maximums[index]!)) ||
    minimums.reduce((sum, minimum) => sum + minimum, 0) > cardCount ||
    maximums.reduce((sum, maximum) => sum + maximum, 0) < cardCount
  ) {
    return false;
  }

  const cardsByGroup = groups.map((group) => {
    const candidates = new Set(group.candidateCardIds);
    return selectedCardIds.flatMap((cardId, index) => (candidates.has(cardId) ? [index] : []));
  });

  // First find a matching for every required group slot. There can be at most
  // cardCount such slots; augmenting paths avoid enumerating assignments.
  const requiredSlotGroups = minimums.flatMap((minimum, groupIndex) =>
    Array.from({ length: minimum }, () => groupIndex)
  );
  const cardToRequiredSlot = Array<number>(cardCount).fill(-1);
  const matchRequiredSlot = (slotIndex: number, visitedCards: Set<number>): boolean => {
    const groupIndex = requiredSlotGroups[slotIndex]!;
    for (const cardIndex of cardsByGroup[groupIndex]!) {
      if (visitedCards.has(cardIndex)) continue;
      visitedCards.add(cardIndex);
      const previousSlot = cardToRequiredSlot[cardIndex]!;
      if (previousSlot < 0 || matchRequiredSlot(previousSlot, visitedCards)) {
        cardToRequiredSlot[cardIndex] = slotIndex;
        return true;
      }
    }
    return false;
  };
  for (let slotIndex = 0; slotIndex < requiredSlotGroups.length; slotIndex += 1) {
    if (!matchRequiredSlot(slotIndex, new Set())) return false;
  }

  const assignedCardsByGroup = groups.map(() => [] as number[]);
  const groupsByCard = selectedCardIds.map(() => [] as number[]);
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    for (const cardIndex of cardsByGroup[groupIndex]!) {
      groupsByCard[cardIndex]!.push(groupIndex);
    }
  }
  for (let cardIndex = 0; cardIndex < cardCount; cardIndex += 1) {
    const requiredSlot = cardToRequiredSlot[cardIndex]!;
    if (requiredSlot >= 0) {
      assignedCardsByGroup[requiredSlotGroups[requiredSlot]!]!.push(cardIndex);
    }
  }

  // Then match each remaining card within group capacities. An augmenting path
  // replaces one card in every traversed full group and adds one only at its
  // endpoint, so it never decreases a group's already-satisfied minimum.
  const matchRemainingCard = (cardIndex: number, visitedGroups: Set<number>): boolean => {
    for (const groupIndex of groupsByCard[cardIndex]!) {
      if (visitedGroups.has(groupIndex)) continue;
      visitedGroups.add(groupIndex);
      const assignedCards = assignedCardsByGroup[groupIndex]!;
      if (assignedCards.length < maximums[groupIndex]!) {
        assignedCards.push(cardIndex);
        return true;
      }
      for (let position = 0; position < assignedCards.length; position += 1) {
        if (matchRemainingCard(assignedCards[position]!, visitedGroups)) {
          assignedCards[position] = cardIndex;
          return true;
        }
      }
    }
    return false;
  };
  for (let cardIndex = 0; cardIndex < cardCount; cardIndex += 1) {
    if (cardToRequiredSlot[cardIndex]! < 0 && !matchRemainingCard(cardIndex, new Set())) {
      return false;
    }
  }
  return true;
}
