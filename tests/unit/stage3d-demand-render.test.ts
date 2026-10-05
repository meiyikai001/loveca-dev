import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStageLayoutScheduler } from '../../client/src/components/game/stage3d/stageLayoutObserver';
import { StageVfxController } from '../../client/src/components/game/stage3d/StageVfxLayer';
import { installStage3dGeometry } from '../../client/src/components/game/stage3d/geometry';
import type { StageGainRequest } from '../../client/src/components/game/stage3d/stageVfxRuntime';
import { HeartColor } from '../../src/shared/types/enums';

describe('stage layout demand scheduling', () => {
  let frames: Map<number, FrameRequestCallback>;
  let next: number;
  const flush = (time: number) => {
    const pending = [...frames.values()]; frames.clear();
    pending.forEach(callback => callback(time));
  };
  beforeEach(() => {
    frames = new Map(); next = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('coalesces changes and leaves no polling frames once the layout settles', () => {
    let moving = true;
    const sample = vi.fn(() => moving);
    const scheduler = createStageLayoutScheduler(sample, () => true);
    scheduler.request(); scheduler.request(); scheduler.request();
    expect(frames.size).toBe(1);
    flush(0); flush(16); flush(32); flush(50);
    expect(sample).toHaveBeenCalledTimes(2);
    moving = false; flush(100);
    expect(frames.size).toBe(0);
    flush(5000);
    expect(sample).toHaveBeenCalledTimes(3);
    scheduler.request(); flush(5050);
    expect(sample).toHaveBeenCalledTimes(4);
    expect(frames.size).toBe(0);
  });

  it('suspends hidden-page work and samples fresh state on visibility wake', () => {
    let visible = true;
    const sample = vi.fn(() => true);
    const scheduler = createStageLayoutScheduler(sample, () => visible);
    scheduler.request(); flush(0);
    visible = false; flush(50); scheduler.request();
    expect(frames.size).toBe(0);
    expect(sample).toHaveBeenCalledTimes(1);
    visible = true; scheduler.request(); flush(9000);
    expect(sample).toHaveBeenCalledTimes(2);
    scheduler.dispose();
    expect(frames.size).toBe(0);
    scheduler.request(); flush(10000);
    expect(sample).toHaveBeenCalledTimes(2);
  });
});

describe('imperative VFX in a sleeping canvas', () => {
  it('wakes for concurrent effects, draws cancellation cleanup, and stops after the last effect', () => {
    const release = installStage3dGeometry({} as HTMLElement, {
      worldToScreen: p => ({ x: p.x, y: p.z }), screenToWorld: p => ({ x: p.x, y: 0, z: p.y }),
    }, {
      viewport: { left: 0, top: 0, width: 1000, height: 800 }, zones: [], surfaces: [{
        key: 'card', objectId: 'public-card', kind: 'member', side: 'self', imagePath: '',
        rect: { left: 0, top: 0, width: 100, height: 140 }, width: 100, height: 140,
        rotation: 0, faceUp: true, visible: true, selected: false, highlight: 'none', stackDepth: 0,
      }],
    });
    const wake = vi.fn();
    const controller = new StageVfxController({ add: vi.fn() } as unknown as ConstructorParameters<typeof StageVfxController>[0], wake);
    const request = {
      id: 'gain', source: false, startedAt: 0, endsAt: 1200,
      event: { mode: 'APPLIED' },
      target: { objectId: 'public-card', changes: [{ kind: 'HEART', color: HeartColor.GREEN, delta: 1 }] },
    } as StageGainRequest;
    try {
      controller.update(0);
      expect(wake).not.toHaveBeenCalled();
      const cancelFirst = controller.playGain(request);
      controller.playGain({ ...request, id: 'second' });
      expect(wake).toHaveBeenCalledTimes(2);
      wake.mockClear(); controller.update(200);
      expect(wake).toHaveBeenCalledTimes(1);
      cancelFirst();
      expect(wake).toHaveBeenCalledTimes(2);
      cancelFirst();
      expect(wake).toHaveBeenCalledTimes(2);
      wake.mockClear(); controller.update(400);
      expect(wake).toHaveBeenCalledTimes(1);
      wake.mockClear(); controller.update(1500); controller.update(3000);
      expect(wake).not.toHaveBeenCalled();
      const cancelLast = controller.playGain({ ...request, endsAt: 5000 });
      wake.mockClear(); cancelLast();
      expect(wake).toHaveBeenCalledTimes(1);
      controller.update(4000);
      expect(wake).toHaveBeenCalledTimes(1);
    } finally { controller.dispose(); release(); }
  });
});
