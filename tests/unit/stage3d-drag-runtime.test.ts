import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installStage3dGeometry } from '../../client/src/components/game/stage3d/geometry';
import { createStageUiDrop, isStageUiDragSource, stageDragRuntime } from '../../client/src/components/game/stage3d/stageDragRuntime';
import { getStageCardFaceHeight } from '../../client/src/components/game/stage3d/stageCardPhysical';

describe('stage drag presentation ownership', () => {
  let uninstall: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    uninstall = installStage3dGeometry({} as HTMLElement, {
      screenToWorld: ({ x, y }, height = 0) => ({ x: x / 100, y: height, z: y / 100 }),
      worldToScreen: ({ x, z }) => ({ x: x * 100, y: z * 100 }),
    }, { viewport: { left: 0, top: 0, width: 1200, height: 800 }, surfaces: [], zones: [] });
  });
  afterEach(() => { stageDragRuntime.cancel(); uninstall(); vi.useRealTimers(); });

  it('keeps popup drags above their UI and bridges the released visible rectangle into the stage', () => {
    expect(isStageUiDragSource('INSPECTION_ZONE')).toBe(true);
    expect(isStageUiDragSource('RESOLUTION_ZONE')).toBe(true);
    expect(isStageUiDragSource('HAND')).toBe(false);
    expect(isStageUiDragSource('MEMBER_SLOT')).toBe(false);
    const drop = createStageUiDrop('obj_popup-card', { left: 400, top: 210, width: 80, height: 112 })!;
    expect(drop.objectId).toBe('obj_popup-card');
    expect(drop.pose.position).toEqual({ x: 4.4, y: .65, z: 2.66 });
    expect(drop.pose.width).toBeCloseTo(.8);
    expect(drop.pose.height).toBeCloseTo(1.12);
    expect(stageDragRuntime.get()).toBeNull();
    drop.consumed();
    expect(createStageUiDrop('obj_popup-card', { left: 0, top: 0, width: 0, height: 0 })).toBeNull();
  });

  it('keeps a ready released card until its exact transfer consumes it, then cleans once', () => {
    const changed = vi.fn();
    const unsubscribe = stageDragRuntime.subscribe(changed);
    stageDragRuntime.begin('obj_own-card', '/permitted-front.jpg', { x: 200, y: 300 });
    const token = stageDragRuntime.get()!.token;
    expect(stageDragRuntime.isReady()).toBe(false);
    stageDragRuntime.markReady(token);
    stageDragRuntime.move({ x: 450, y: 250 });
    const drop = stageDragRuntime.release()!;
    expect(drop.objectId).toBe('obj_own-card');
    expect(drop.pose.position).toEqual({ x: 4.5, y: 0.65, z: 2.5 });
    stageDragRuntime.clearInput();
    stageDragRuntime.move({ x: 0, y: 0 });
    expect(stageDragRuntime.get()!.pose).toEqual(drop.pose);
    expect(stageDragRuntime.isReady()).toBe(true);
    drop.consumed();
    const count = changed.mock.calls.length;
    drop.consumed();
    vi.advanceTimersByTime(300);
    expect(stageDragRuntime.get()).toBeNull();
    expect(changed).toHaveBeenCalledTimes(count);
    unsubscribe();
  });

  it('does not let an old transfer, expiry or texture-ready callback clear or ready a new drag', () => {
    stageDragRuntime.begin('obj_first', '/first-public.jpg', { x: 100, y: 100 });
    const first = stageDragRuntime.get()!.token;
    stageDragRuntime.markReady(first);
    const oldDrop = stageDragRuntime.release()!;
    stageDragRuntime.begin('obj_second', '/second-public.jpg', { x: 500, y: 400 });
    const second = stageDragRuntime.get()!.token;
    expect(second).not.toBe(first);
    oldDrop.consumed();
    stageDragRuntime.markReady(first);
    vi.advanceTimersByTime(1000);
    expect(stageDragRuntime.get()?.token).toBe(second);
    expect(stageDragRuntime.isReady()).toBe(false);
    stageDragRuntime.markReady(second);
    expect(stageDragRuntime.isReady()).toBe(true);
  });

  it('retains a fast release pose before its texture is ready and ignores readiness after cancellation', () => {
    stageDragRuntime.begin('obj_loading', '/permitted-back.jpg', { x: 100, y: 100 });
    const loading = stageDragRuntime.get()!.token;
    stageDragRuntime.move({ x: 600, y: 250 });
    const drop = stageDragRuntime.release()!;
    expect(drop.objectId).toBe('obj_loading');
    expect(drop.pose.position).toEqual({ x: 6, y: 0.65, z: 2.5 });
    expect(stageDragRuntime.isReady()).toBe(false);
    stageDragRuntime.clearInput();
    expect(stageDragRuntime.get()?.released).toBe(true);
    drop.consumed();
    stageDragRuntime.markReady(loading);
    expect(stageDragRuntime.get()).toBeNull();
    stageDragRuntime.begin('obj_cancelled', '/permitted-front.jpg', { x: 100, y: 100 });
    const cancelled = stageDragRuntime.get()!.token;
    stageDragRuntime.clearInput();
    stageDragRuntime.markReady(cancelled);
    expect(stageDragRuntime.get()).toBeNull();
  });

  it('bounds a released preview when no authoritative move takes ownership', () => {
    stageDragRuntime.begin('obj_no-move', '/permitted-front.jpg', { x: 100, y: 100 });
    stageDragRuntime.markReady(stageDragRuntime.get()!.token);
    stageDragRuntime.release();
    vi.advanceTimersByTime(249);
    expect(stageDragRuntime.get()?.released).toBe(true);
    vi.advanceTimersByTime(1);
    expect(stageDragRuntime.get()).toBeNull();
  });

  it('lifts a single lawful back above a tall pile and retains that elevation while dragging', () => {
    const width = .7425, height = width * 1.4;
    uninstall = installStage3dGeometry({} as HTMLElement, {
      screenToWorld: ({ x, y }, elevation = 0) => ({ x: x / 100, y: elevation, z: y / 100 }),
      worldToScreen: ({ x, z }) => ({ x: x * 100, y: z * 100 }),
    }, { viewport: { left: 0, top: 0, width: 1200, height: 800 }, zones: [], surfaces: [{
      key: 'public-deck-top', objectId: 'obj_back', imagePath: '/back.jpg',
      rect: { left: 150, top: 200, width: 50, height: 70 }, width: 50, height: 70,
      rotation: 0, faceUp: false, kind: 'deck', side: 'self', stackDepth: 0,
      visible: true, selected: false, pileCount: 60,
    }] });
    stageDragRuntime.begin('obj_back', '/untrusted-supplied-front.jpg', { x: 175, y: 235 });
    const drag = stageDragRuntime.get()!;
    expect(drag.imagePath).toBe('/back.jpg');
    expect(drag.pose.width).toBe(width);
    expect(drag.pose.height).toBe(height);
    expect(drag.pose.position.y).toBeCloseTo(getStageCardFaceHeight(width, height, 0, 60) + .2);
    const elevation = drag.pose.position.y;
    stageDragRuntime.move({ x: 800, y: 600 });
    expect(stageDragRuntime.release()!.pose.position.y).toBe(elevation);
  });
});
