import { describe, expect, it } from 'vitest';
import { getStage3dOpponentColumnGapAdjustment } from '../../client/src/components/game/stage3d/stageFieldLayout';
import { getStage3dProjectedQuad, getStage3dZonePose, STAGE3D_CARD_HEIGHT } from '../../client/src/components/game/stage3d/geometry';
import type { Stage3dProjection, Stage3dSnapshot, Stage3dZone } from '../../client/src/components/game/stage3d/types';

const projection: Stage3dProjection = {
  worldToScreen: ({ x, y, z }) => ({ x: 800 + x * 100 / (1 - y * .03 - z * .025), y: 400 + z * 80 - y * 30 }),
  screenToWorld: ({ x, y }, height = 0) => {
    const z = (y - 400 + height * 30) / 80;
    return { x: (x - 800) * (1 - height * .03 - z * .025) / 100, y: height, z };
  },
};

function row(side: 'self' | 'opponent', width: number, centerY: number, step: number): Stage3dZone[] {
  return [-1, 0, 1].map((column, index) => ({
    key: `${side}-${index}`, targetId: `${side}-${index}`, anchor: null,
    rect: { left: 800 + column * step - width / 2, top: centerY - width * .7, width, height: width * 1.4 },
    kind: 'member', side, occupied: false, outlined: true, rotation: 0,
  }));
}

function visibleGap(zones: Stage3dZone[]) {
  const edges = zones.map(zone => {
    const pose = getStage3dZonePose(zone, projection)!;
    const quad = getStage3dProjectedQuad({ ...pose, position: { ...pose.position, y: STAGE3D_CARD_HEIGHT } }, projection);
    return { left: Math.min(...quad.map(p => p.x)), right: Math.max(...quad.map(p => p.x)) };
  });
  return ((edges[1]!.left - edges[0]!.right) + (edges[2]!.left - edges[1]!.right)) / 2;
}

describe('concert field projected column spacing', () => {
  it.each([
    [128, 116, 328, 620, 220],
    [64, 58, 120, 610, 290],
    [112, 108, 312, 500, 260],
  ])('matches visible edge gaps while preserving row depth (%s, %s)', (selfWidth, opponentWidth, selfStep, selfY, opponentY) => {
    const self = row('self', selfWidth, selfY, selfStep);
    const baselineOpponentStep = selfStep - selfWidth + opponentWidth;
    const opponent = row('opponent', opponentWidth, opponentY, baselineOpponentStep);
    const snapshot: Stage3dSnapshot = { viewport: { left: 0, top: 0, width: 1600, height: 1000 }, surfaces: [], zones: [...self, ...opponent] };
    expect(visibleGap(opponent)).toBeGreaterThan(visibleGap(self));
    const adjustment = getStage3dOpponentColumnGapAdjustment(snapshot, projection)!;
    expect(adjustment).toBeLessThan(0);
    const adjusted = row('opponent', opponentWidth, opponentY, baselineOpponentStep + adjustment);
    expect(visibleGap(adjusted)).toBeCloseTo(visibleGap(self), 5);
    adjusted.forEach((zone, index) => {
      expect(getStage3dZonePose(zone, projection)!.position.z)
        .toBe(getStage3dZonePose(opponent[index]!, projection)!.position.z);
    });
    // A later sample already includes the CSS shift. It must calculate the
    // original correction again rather than add another correction each frame.
    expect(getStage3dOpponentColumnGapAdjustment({ ...snapshot, zones: [...self, ...adjusted] }, projection))
      .toBeCloseTo(adjustment, 5);
  });

  it('leaves the fallback spacing alone without complete rows or a table projection', () => {
    const self = row('self', 100, 620, 300), opponent = row('opponent', 90, 220, 290);
    const snapshot: Stage3dSnapshot = { viewport: { left: 0, top: 0, width: 1600, height: 1000 }, surfaces: [], zones: [...self, ...opponent] };
    expect(getStage3dOpponentColumnGapAdjustment({ ...snapshot, zones: self }, projection)).toBeNull();
    expect(getStage3dOpponentColumnGapAdjustment(snapshot, { ...projection, screenToWorld: () => null })).toBeNull();
  });
});
