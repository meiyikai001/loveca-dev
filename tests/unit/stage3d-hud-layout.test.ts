import { describe, expect, it } from 'vitest';
import { getStageIdentitySafeLeft } from '../../client/src/components/game/stage3d/StagePlayerIdentity';

describe('stage identity visible desk inset', () => {
  it.each([
    [0, 0, 0, 64],
    [120, 120, 0, 64],
    [-52, -52, 0, 116],
    [0, -52, 0, 116],
    [52, 52, 80, 92],
    [0, 80, 0, 16],
  ])('keeps the complete panel within the visible desk (%s, %s, %s)', (boardLeft, playerLeft, viewportLeft, expected) => {
    const inset = getStageIdentitySafeLeft(boardLeft, playerLeft, viewportLeft);
    expect(inset).toBe(expected);
    expect(playerLeft + inset).toBeGreaterThanOrEqual(Math.max(boardLeft, viewportLeft) + 64);
  });
});
