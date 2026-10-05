import { describe, expect, it } from 'vitest';
import { getStage3dOpponentColumnGapAdjustment, getStage3dFieldAdjustment } from '../../client/src/components/game/stage3d/stageFieldLayout';
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

describe('self field alignment with its fixed success column', () => {
  const makeSnapshot = (liveY: number, successY: number): Stage3dSnapshot => ({
    viewport: { left: 0, top: 0, width: 1600, height: 1000 }, surfaces: [],
    zones: [
      { ...row('self', 100, liveY, 200)[1]!, key: 'self-live', kind: 'live', rotation: -90 },
      ...[0, 1, 2].map(index => ({
        ...row('self', 100, successY + index * 60, 200)[0]!,
        key: `self-success-${index}`, kind: 'success' as const, rotation: -90,
      })),
    ],
  });

  it.each([[420, 510], [470, 540], [610, 650]])('aligns world depth and visible top without moving success (%s, %s)', (liveY, successY) => {
    const snapshot = makeSnapshot(liveY, successY);
    const success = getStage3dZonePose(snapshot.zones[1]!, projection, snapshot)!;
    const adjustment = getStage3dFieldAdjustment(snapshot, projection, 'self', 0)!;
    expect(adjustment).toBeGreaterThan(0);
    const settled = { ...snapshot, zones: snapshot.zones.map(zone => zone.kind === 'live'
      ? { ...zone, rect: { ...zone.rect, top: zone.rect.top + adjustment } } : zone) };
    const live = getStage3dZonePose(settled.zones[0]!, projection, settled)!;
    expect(live.position.z).toBeCloseTo(success.position.z, 6);
    const top = (pose: typeof live) => Math.min(...getStage3dProjectedQuad(pose, projection).map(p => p.y));
    expect(top(live)).toBeCloseTo(top(success), 6);
    expect(getStage3dZonePose(settled.zones[1]!, projection, settled)).toEqual(success);
    expect(getStage3dFieldAdjustment(settled, projection, 'self', adjustment)).toBeCloseTo(adjustment, 6);
    // A viewport relayout can move the success anchor while the previous CSS
    // adjustment is still applied. Solve the new placement without drift.
    const resized = { ...settled, zones: settled.zones.map(zone => zone.kind === 'success'
      ? { ...zone, rect: { ...zone.rect, top: zone.rect.top + 20 } } : zone) };
    expect(getStage3dFieldAdjustment(resized, projection, 'self', adjustment)).toBeCloseTo(adjustment + 20, 6);
  });

  it('retains ordinary layout until both anchors and their table projection exist', () => {
    const snapshot = makeSnapshot(420, 510);
    expect(getStage3dFieldAdjustment({ ...snapshot, zones: snapshot.zones.slice(0, 1) }, projection, 'self', 0)).toBeNull();
    expect(getStage3dFieldAdjustment(snapshot, { ...projection, screenToWorld: () => null }, 'self', 0)).toBeNull();
  });

  it('aligns the opponent LIVE bottom to the last success slot, without moving its success column', () => {
    const base = makeSnapshot(230, 210);
    const snapshot = { ...base, zones: base.zones.map(zone => ({ ...zone, side: 'opponent' as const })) };
    const success = getStage3dZonePose(snapshot.zones.at(-1)!, projection, snapshot)!;
    const adjustment = getStage3dFieldAdjustment(snapshot, projection, 'opponent', 0)!;
    expect(adjustment).toBeGreaterThan(0);
    const settled = { ...snapshot, zones: snapshot.zones.map(zone => zone.kind === 'live'
      ? { ...zone, rect: { ...zone.rect, top: zone.rect.top + adjustment } } : zone) };
    const live = getStage3dZonePose(settled.zones[0]!, projection, settled)!;
    const bottom = (pose: typeof live) => Math.max(...getStage3dProjectedQuad(pose, projection).map(p => p.y));
    expect(bottom(live)).toBeCloseTo(bottom(success), 6);
    expect(getStage3dZonePose(settled.zones.at(-1)!, projection, settled)).toEqual(success);
    expect(getStage3dFieldAdjustment(settled, projection, 'opponent', adjustment)).toBeCloseTo(adjustment, 6);
  });

  it('keeps the central LIVE inlays apart when short-screen success columns overlap in depth', () => {
    const self = makeSnapshot(400, 410);
    const opponent = makeSnapshot(230, 300).zones.map(zone => ({ ...zone, side: 'opponent' as const, key: `opponent-${zone.key}` }));
    const snapshot = { ...self, zones: [...self.zones, ...opponent] };
    const selfDepth = getStage3dZonePose(self.zones[1]!, projection, snapshot)!.position.z;
    const shift = getStage3dFieldAdjustment(snapshot, projection, 'opponent', 0)!;
    const live = opponent[0]!;
    const adjustedLive = { ...live, rect: { ...live.rect, top: live.rect.top + shift } };
    const pose = getStage3dZonePose(adjustedLive, projection, snapshot)!;
    expect(selfDepth - pose.position.z - pose.width).toBeCloseTo(.5, 6);
  });
});
