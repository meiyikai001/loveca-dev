import { describe, expect, it, vi } from 'vitest';
import { HeartColor, OrientationState } from '../../src/shared/types/enums';
import type { EffectFeedbackChange } from '../../src/online/types';
import { buildStageGainLayers } from '../../client/src/components/game/stage3d/stageGainLayers';
import {
  stageVfxRuntime,
  type StageVfxDriver,
} from '../../client/src/components/game/stage3d/stageVfxRuntime';
import {
  createStageLandingSignals,
  getStageNeighborPeakAngle,
  sampleStageLanding,
} from '../../client/src/components/game/stage3d/stageLandingLifecycle';
import { entranceTimeline } from '../../client/src/lib/cardEntranceTimeline';
import { isStageCardMove, sampleStageMove, stageCardPoseMatches } from '../../client/src/components/game/stage3d/stageMoveLifecycle';
import type { Stage3dPose } from '../../client/src/components/game/stage3d/types';
import type { StageMoveRequest } from '../../client/src/components/game/stage3d/stageVfxRuntime';

describe('3D stage gain presentation', () => {
  const mixed: EffectFeedbackChange[] = [
    { kind: 'HEART', color: HeartColor.GREEN, delta: 2 },
    { kind: 'BLADE', delta: 2 },
    { kind: 'HEART', color: HeartColor.BLUE, delta: 1 },
  ];
  it('preserves mixed HEART/BLADE in either order without treating particle count as the delta', () => {
    for (const changes of [mixed, [...mixed].reverse()]) {
      const layers = buildStageGainLayers('APPLIED', changes);
      expect(layers).toHaveLength(3);
      expect(layers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'HEART', color: '#a9e4bf' }),
          expect.objectContaining({ kind: 'HEART', color: '#a4d7ff' }),
          expect.objectContaining({ kind: 'BLADE', color: '#d7c8ff' }),
        ])
      );
      expect(layers.every((layer) => layer.strength > 0 && layer.strength < 1)).toBe(true);
    }
    expect(buildStageGainLayers('APPLIED', [{ kind: 'BLADE', delta: 1 }])).toEqual(
      buildStageGainLayers('APPLIED', [{ kind: 'BLADE', delta: 5 }])
    );
  });
  it('does not celebrate a pending ability, cost, zero change or loss', () => {
    expect(buildStageGainLayers('START', mixed)).toEqual([]);
    expect(buildStageGainLayers('UPDATE', mixed)).toEqual([]);
    expect(
      buildStageGainLayers('APPLIED', [
        { kind: 'HEART', color: HeartColor.GREEN, delta: -2 },
        { kind: 'BLADE', delta: 0 },
        { kind: 'ENERGY', delta: -2 },
      ])
    ).toEqual([]);
  });
});

describe('stage renderer lifecycle bridge', () => {
  it('keeps near neighbors visibly lifted while the far row responds less', () => {
    const near = getStageNeighborPeakAngle(1 - 0.25 * 0.8);
    const far = getStageNeighborPeakAngle(1 - 0.7 * 0.8);
    expect(near).toBeGreaterThanOrEqual(30);
    expect(near).toBeLessThanOrEqual(40);
    expect(far).toBeGreaterThanOrEqual(8);
    expect(far).toBeLessThanOrEqual(15);
    expect(getStageNeighborPeakAngle(1)).toBe(46);
    expect(getStageNeighborPeakAngle(0)).toBe(0);
  });
  it('shares the portrait clock and reaches a settled pose after a delayed frame', () => {
    const start = 100;
    expect(sampleStageLanding(start + entranceTimeline.landingAt - 1, start).waiting).toBe(true);
    const contact = sampleStageLanding(
      start + entranceTimeline.landingAt + entranceTimeline.flight,
      start
    );
    expect(contact.flight).toEqual({ path: 1, height: 0, finished: true });
    expect(contact.impactElapsed).toBe(0);
    expect(contact.complete).toBe(false);
    const delayed = sampleStageLanding(start + entranceTimeline.total + 200, start);
    expect(delayed.flight.height).toBe(0);
    expect(delayed.complete).toBe(true);
  });
  it('releases contact and completion once and ignores late frames after skip', () => {
    const impact = vi.fn(),
      done = vi.fn();
    const natural = createStageLandingSignals(impact, done);
    natural.impact();
    natural.impact();
    natural.complete();
    natural.complete();
    natural.impact();
    expect(impact).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
    const skipped = createStageLandingSignals(impact, done);
    skipped.cancel();
    skipped.impact();
    skipped.complete();
    expect(impact).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
  });
  it('an old canvas cleanup cannot disconnect its replacement', () => {
    const old: StageVfxDriver = {
      playMove: vi.fn(() => () => {}),
      playGain: vi.fn(() => () => {}),
      playLanding: vi.fn(() => () => {}),
    };
    const next: StageVfxDriver = {
      playMove: vi.fn(() => () => {}),
      playGain: vi.fn(() => () => {}),
      playLanding: vi.fn(() => () => {}),
    };
    const removeOld = stageVfxRuntime.install(old);
    const removeNext = stageVfxRuntime.install(next);
    removeOld();
    expect(stageVfxRuntime.active).toBe(true);
    removeNext();
    expect(stageVfxRuntime.active).toBe(false);
  });
});

describe('continuous stage card movement', () => {
  const from: Stage3dPose = { position: { x: -3, y: 0.9, z: 4 }, width: 1.3, height: 1.82, rotation: 350 };
  const to: Stage3dPose = { position: { x: 2, y: 0.04, z: 1 }, width: 1.85, height: 2.59, rotation: 10 };
  it('uses the exact released drag pose and exact settled endpoint without a post-arrival lift', () => {
    expect(sampleStageMove(from, to, 0, 360)).toBe(from);
    expect(sampleStageMove(from, to, 360, 360)).toBe(to);
    expect(sampleStageMove(from, to, 1000, 360)).toBe(to);
    const late = [320, 330, 340, 350, 360].map((time) => sampleStageMove(from, to, time, 360));
    expect(late.every((pose, index) => index === 0 || pose.position.y <= late[index - 1].position.y)).toBe(true);
    expect(sampleStageMove(from, to, 180, 360).rotation).toBeGreaterThan(350);
    expect(stageCardPoseMatches({ ...to, rotation: to.rotation + 360 }, to)).toBe(true);
    expect(stageCardPoseMatches({ ...to, width: to.width * 1.05 }, to)).toBe(false);
    expect(stageCardPoseMatches({ ...to, position: { ...to.position, y: to.position.y + 0.01 } }, to)).toBe(false);
    expect(stageCardPoseMatches(undefined, to)).toBe(false);
  });
  it('settles an ordinary play monotonically and never relaunches a card already at table height', () => {
    let previousHeight = from.position.y;
    const atTable = { ...from, position: { ...from.position, y: to.position.y } };
    for (let elapsed = 0; elapsed <= 400; elapsed += 10) {
      const released = sampleStageMove(from, to, elapsed, 400);
      expect(released.position.y).toBeLessThanOrEqual(previousHeight);
      expect(released.position.y).toBeGreaterThanOrEqual(to.position.y);
      previousHeight = released.position.y;
      expect(sampleStageMove(atTable, to, elapsed, 400).position.y).toBe(to.position.y);
    }
  });

  it('includes ordinary unprofiled plays, field moves and returns, while keeping UI-only moves in their UI', () => {
    expect(isStageCardMove('HAND', 'MEMBER_SLOT')).toBe(true);
    expect(isStageCardMove('MEMBER_SLOT', 'WAITING_ROOM')).toBe(true);
    expect(isStageCardMove('WAITING_ROOM', 'HAND')).toBe(true);
    expect(isStageCardMove('INSPECTION_ZONE', 'HAND')).toBe(false);
  });
  it('hands a release pose only to its object and releases its retained preview once', () => {
    vi.useFakeTimers();
    const consumed = vi.fn();
    const move = vi.fn<StageVfxDriver['playMove']>(() => () => {});
    const uninstall = stageVfxRuntime.install({ playMove: move, playGain: () => () => {}, playLanding: () => () => {} });
    const request = (objectId: string): StageMoveRequest => ({ imagePath: '/permitted-front.jpg', startedAt: 0, durationMs: 360,
      event: { id: 'move', kind: 'CARD_MOVE', render: { objectId, cardId: objectId, surface: 'FRONT', fromSurface: 'FRONT', toSurface: 'FRONT' },
        fromZoneType: 'HAND', toZoneType: 'MEMBER_SLOT', fromRect: { left: 0, top: 0, width: 80, height: 112 }, toRect: { left: 200, top: 100, width: 80, height: 112 } } });
    try {
      stageVfxRuntime.retainDropPose('own-card', from, consumed);
      stageVfxRuntime.playMove(request('another-card'), () => {}, () => {});
      expect(move.mock.calls[0][0].fromPose).toBeUndefined();
      stageVfxRuntime.playMove(request('own-card'), () => {}, () => {});
      const transferred = move.mock.calls[1][0];
      expect(transferred.fromPose).toEqual(from);
      expect(consumed).not.toHaveBeenCalled();
      transferred.onSourceConsumed?.();
      transferred.onSourceConsumed?.();
      expect(consumed).toHaveBeenCalledTimes(1);
      stageVfxRuntime.retainDropPose('expired', from, consumed);
      vi.advanceTimersByTime(600);
      expect(consumed).toHaveBeenCalledTimes(2);
      stageVfxRuntime.playMove(request('expired'), () => {}, () => {});
      expect(move.mock.calls[2][0].fromPose).toBeUndefined();
      stageVfxRuntime.retainDropPose('cancelled', from, consumed);
      stageVfxRuntime.clearDropPose();
      stageVfxRuntime.clearDropPose();
      expect(consumed).toHaveBeenCalledTimes(3);
    } finally { uninstall(); vi.useRealTimers(); }
  });
  it('preserves a claimed entrance origin across cold portrait loading without retaining the drag preview', () => {
    vi.useFakeTimers();
    const consumed = vi.fn();
    const landing = vi.fn<StageVfxDriver['playLanding']>(() => () => {});
    const uninstall = stageVfxRuntime.install({ playMove: () => null, playGain: () => () => {}, playLanding: landing });
    try {
      stageVfxRuntime.retainDropPose('obj_entrance', from, consumed);
      const claimed = stageVfxRuntime.claimDropPose('obj_entrance');
      claimed.onSourceConsumed?.();
      vi.advanceTimersByTime(2500);
      expect(consumed).toHaveBeenCalledTimes(1);
      expect(stageVfxRuntime.claimDropPose('obj_entrance')).toEqual({});
      stageVfxRuntime.playLanding({ id: 'entrance', imagePath: '/permitted-front.jpg',
        target: { objectId: 'obj_entrance', cardCode: 'PUBLIC', locationKey: 'own:center', orientation: OrientationState.ACTIVE },
        ...claimed }, 2500, () => {}, () => {});
      expect(landing.mock.calls[0][0].fromPose).toEqual(from);
      landing.mock.calls[0][0].onSourceConsumed?.();
      expect(consumed).toHaveBeenCalledTimes(1);
    } finally { uninstall(); vi.useRealTimers(); }
  });
});
