import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyStage3dSurfaceProjection, collectStage3dSnapshot, getStage3dGeometry, getStage3dProjectedQuad,
  getStage3dScreenBridgePose, getStage3dSurfacePose, getStage3dZonePose, getStage3dDomMatrix,
  hasStage3dTarget, hitTestStage3dZones, installStage3dGeometry, isPointInStage3dQuad,
  resolveStage3dObjectPose, resolveStage3dMovePose, STAGE3D_CARD_WIDTH,
  STAGE3D_RESOURCE_CARD_WIDTH, STAGE3D_ENERGY_CARD_WIDTH,
  reconcileStage3dDomProjection, releaseStage3dDomProjection,
} from '../../client/src/components/game/stage3d/geometry';
import type { Stage3dProjection, Stage3dSnapshot, Stage3dSurface, Stage3dQuad } from '../../client/src/components/game/stage3d/types';
import { getStageCardThickness } from '../../client/src/components/game/stage3d/StageCardVisual';

const projection: Stage3dProjection = {
  worldToScreen: ({ x, y, z }) => ({ x: 200 + x * 100, y: 150 + z * 80 - y * 30 }),
  screenToWorld: ({ x, y }, height = 0) => ({ x: (x - 200) / 100, y: height, z: (y - 150 + height * 30) / 80 }),
};
const makeSurface = (changes: Partial<Stage3dSurface> = {}): Stage3dSurface => ({
  key: 'visible-card', objectId: 'obj_visible', imagePath: '/visible.webp',
  rect: { left: 150, top: 110, width: 100, height: 140 }, ownerZoneKey: 'empty-stage',
  width: 100, height: 140, rotation: 0, faceUp: true, kind: 'member',
  side: 'self', stackDepth: 1, visible: true, selected: false, ...changes,
});
const makeSnapshot = (surfaces: Stage3dSurface[] = []): Stage3dSnapshot => ({
  viewport: { left: 0, top: 80, width: 1600, height: 820 }, surfaces,
  zones: [{ key: 'empty-stage', targetId: 'player-member-left', anchor: 'self-stage-left',
    rect: { left: 150, top: 110, width: 100, height: 140 }, kind: 'member', side: 'self', occupied: false,
    outlined: true, rotation: 0, state: 'idle' }],
});

function projectCssPoint(matrix: string, x: number, y: number) {
  const values = matrix.slice(9, -1).split(',').map(Number);
  const divisor = values[3]! * x + values[7]! * y + values[15]!;
  return { x: (values[0]! * x + values[4]! * y + values[12]!) / divisor,
    y: (values[1]! * x + values[5]! * y + values[13]!) / divisor };
}

describe('concert stage geometry', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses fixed physical card dimensions independent of near/far DOM card sizes', () => {
    const near = getStage3dSurfacePose(makeSurface(), projection)!;
    const far = getStage3dSurfacePose(makeSurface({ rect: { left: 300, top: 20, width: 60, height: 84 }, width: 60, height: 84 }), projection)!;
    expect(near.width).toBe(STAGE3D_CARD_WIDTH);
    expect(near.width).toBe(1.5);
    expect(far.width).toBe(near.width);
    expect(far.height).toBe(near.height);
    expect(near.height / near.width).toBeCloseTo(1.4);
    const resource = getStage3dSurfacePose(makeSurface({ kind: 'deck' }), projection)!;
    expect(resource.width).toBe(STAGE3D_RESOURCE_CARD_WIDTH);
    expect(resource.width).toBe(.7425);
    expect(getStage3dSurfacePose(makeSurface({ kind: 'energy' }), projection)!.width).toBe(STAGE3D_ENERGY_CARD_WIDTH);
  });

  it('keeps stacked card bodies below the next face and the main member above every underlay', () => {
    for (const belowCount of [1, 2, 7, 25]) {
      const main = getStage3dSurfacePose(makeSurface({ stackDepth: belowCount + 1 }), projection)!;
      const thickness = getStageCardThickness(main.width, main.height);
      let previousHeight: number | null = null;
      for (let depth = 0; depth < belowCount; depth++) {
        const underlay = getStage3dSurfacePose(makeSurface({ kind: 'stack', stackDepth: depth }), projection)!;
        expect(main.position.y - thickness).toBeGreaterThan(underlay.position.y);
        if (previousHeight !== null) {
          expect(underlay.position.y - thickness).toBeGreaterThan(previousHeight);
        }
        previousHeight = underlay.position.y;
      }
    }
  });

  it('keeps each resource move endpoint at its drawn card center and physical dimensions', () => {
    const cases = [
      ['MAIN_DECK', 'deck', 0], ['ENERGY_DECK', 'deck', 0],
      ['WAITING_ROOM', 'waiting', 0], ['SUCCESS_ZONE', 'success', -90],
    ] as const;
    for (const [zoneType, kind, rotation] of cases) {
      const surface = makeSurface({ kind, rotation, ownerZoneKey: 'resource' });
      const zone = { ...makeSnapshot().zones[0]!, key: 'resource', kind, rotation };
      const snapshot = { ...makeSnapshot(), surfaces: [surface], zones: [zone] };
      const release = installStage3dGeometry({} as HTMLElement, projection, snapshot);
      const pose = getStage3dSurfacePose(surface, projection, snapshot)!;
      const source = resolveStage3dMovePose(surface.objectId, zoneType, zone.rect, 'from')!;
      const destination = resolveStage3dMovePose(surface.objectId, zoneType, zone.rect, 'to')!;
      expect(source.width).toBe(pose.width);
      expect(source.height).toBe(pose.height);
      expect(source.rotation).toBe(pose.rotation);
      expect(source.position.x).toBe(pose.position.x);
      expect(source.position.z).toBe(pose.position.z);
      expect(destination).toEqual(pose);
      release();
    }
  });

  it('anchors occupied cards and empty slot outlines to the same world center despite DOM hover offsets', () => {
    const snapshot = makeSnapshot();
    const zone = getStage3dZonePose(snapshot.zones[0]!, projection)!;
    const card = getStage3dSurfacePose(makeSurface({ rect: { left: 70, top: 30, width: 200, height: 280 } }), projection, snapshot)!;
    expect(card.position.x).toBe(zone.position.x);
    expect(card.position.z).toBe(zone.position.z);
    expect(card.position.y).toBeGreaterThan(zone.position.y);
    expect(card.width).toBe(zone.width);
    expect(card.height).toBe(zone.height);
    expect(getStage3dProjectedQuad({ ...card, position: zone.position }, projection)).toEqual(getStage3dProjectedQuad(zone, projection));
  });

  it('uses the model quarter turn and identical horizontal LIVE slot/card footprints', () => {
    const snapshot = makeSnapshot();
    const liveZone = { ...snapshot.zones[0]!, kind: 'live' as const, rotation: -90 };
    const liveSnapshot = { ...snapshot, zones: [liveZone] };
    const live = getStage3dSurfacePose(makeSurface({ kind: 'live', rotation: -90 }), projection, liveSnapshot)!;
    const slot = getStage3dZonePose(liveZone, projection)!;
    expect(live.width).toBe(STAGE3D_CARD_WIDTH);
    expect(live.rotation).toBe(-90);
    expect(getStage3dProjectedQuad({ ...live, position: slot.position }, projection)).toEqual(getStage3dProjectedQuad(slot, projection));
    const resting = getStage3dSurfacePose(makeSurface({ rotation: 90 }), projection)!;
    const quad = getStage3dProjectedQuad(resting, projection);
    expect(Math.max(...quad.map(p => p.x)) - Math.min(...quad.map(p => p.x))).toBeCloseTo(STAGE3D_CARD_WIDTH * 1.4 * 100);
  });

  it('bridges only screen-space hand rectangles without a center jump', () => {
    const rect = { left: 470, top: 680, width: 110, height: 154 };
    for (const elevation of [0.035, 0.5, 2]) {
      const pose = getStage3dScreenBridgePose(rect, 110, 154, -12, projection, elevation)!;
      expect(projection.worldToScreen(pose.position)).toEqual({ x: 525, y: 757 });
      expect(pose.height / pose.width).toBeCloseTo(1.4);
    }
    expect(getStage3dScreenBridgePose(rect, 110, 154, 0, { ...projection, screenToWorld: () => null })).toBeNull();
  });

  it('maps all four DOM event-surface corners to the projected quad, including outside the old rectangle', () => {
    const quad: Stage3dQuad = [{ x: -80, y: -45 }, { x: 90, y: -40 }, { x: 115, y: 105 }, { x: -110, y: 110 }];
    const matrix = getStage3dDomMatrix(100, 140, quad)!;
    for (const [index, [x, y]] of [[-50, -70], [50, -70], [50, 70], [-50, 70]].entries()) {
      const projected = projectCssPoint(matrix, x!, y!);
      expect(projected.x).toBeCloseTo(quad[index]!.x, 4);
      expect(projected.y).toBeCloseTo(quad[index]!.y, 4);
    }
    expect(isPointInStage3dQuad({ x: 100, y: 100 }, quad)).toBe(true);
    expect(isPointInStage3dQuad({ x: 110, y: -40 }, quad)).toBe(false);
    expect(getStage3dDomMatrix(0, 0, quad)).toBeNull();
  });

  it('uses the drawn slot footprint for drop targets and excludes disabled slots', () => {
    const root = {} as HTMLElement;
    const firstRelease = installStage3dGeometry(root, projection, makeSnapshot());
    expect(hasStage3dTarget('player-member-left')).toBe(true);
    expect(hitTestStage3dZones({ x: 200, y: 180 })).toEqual(['player-member-left']);
    // The physical slot is wider than its old 100px layout box.
    expect(hitTestStage3dZones({ x: 275, y: 180 })).toEqual(['player-member-left']);
    expect(hitTestStage3dZones({ x: 500, y: 180 })).toEqual([]);
    expect(hitTestStage3dZones({ x: 200, y: 180 }, new Set(['other-target']))).toEqual([]);
    const snapshot = makeSnapshot([makeSurface({ visible: false })]);
    const release = installStage3dGeometry(root, projection, { ...snapshot, zones: snapshot.zones.map(zone => ({ ...zone, disabled: true })) });
    firstRelease();
    expect(resolveStage3dObjectPose('obj_visible')?.surface.visible).toBe(false);
    expect(hitTestStage3dZones({ x: 200, y: 180 })).toEqual([]);
    release(); expect(getStage3dGeometry()).toBeNull();
  });

  it('does not mistake a stale source surface for a move destination or an anonymous hand rectangle', () => {
    const snapshot = makeSnapshot([makeSurface()]);
    const target = { ...snapshot.zones[0]!, key: 'right', targetId: 'player-member-right', rect: { left: 550, top: 110, width: 100, height: 140 } };
    const release = installStage3dGeometry({} as HTMLElement, projection, { ...snapshot, zones: [...snapshot.zones, target] });
    const moved = resolveStage3dMovePose('obj_visible', 'MEMBER_SLOT', target.rect, 'to')!;
    expect(moved.position.x).toBe(getStage3dZonePose(target, projection)!.position.x);
    const hand = resolveStage3dMovePose('obj_visible', 'HAND', { left: 0, top: 600, width: 1000, height: 300 }, 'to')!;
    expect(projection.worldToScreen(hand.position)).toEqual({ x: 500, y: 750 });
    expect(hand.width).toBeCloseTo(1.4);
    expect(hand.height / hand.width).toBeCloseTo(1.4);
    release();
  });

  it('reads only the lawful back, samples stable layout after projection, and restores moved-out DOM nodes', () => {
    vi.stubGlobal('getComputedStyle', (element: { style?: { transform?: string } }) => ({
      scale: 'none', rotate: 'none', transform: element.style?.transform || 'none', opacity: '1', visibility: 'visible', display: 'block',
    }));
    vi.stubGlobal('DOMMatrix', class {
      a = 1; b = 0; c = 0; d = 1;
      scale() { return this; } multiply() { return this; } rotate() { return this; }
    });
    const field = {};
    let showSurface = true;
    let surface: Record<string, unknown>;
    let secondSurface: Record<string, unknown> | null = null;
    const listeners = new Map<string, (event: Event) => void>();
    const dragHost = { style: { pointerEvents: '' },
      addEventListener: (name: string, listener: (event: Event) => void) => listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name) };
    const front = { dataset: { stage3dArt: 'front' }, currentSrc: '/previous-front.webp', src: '/previous-front.webp', closest: () => surface };
    const back = { dataset: { stage3dArt: 'back' }, currentSrc: '/back.webp', src: '/back.webp', closest: () => surface };
    const root = { dataset: {}, parentElement: null, contains: () => true,
      getBoundingClientRect: () => ({ left: 0, top: 80, width: 1600, height: 820 }),
      querySelectorAll: (selector: string) => showSurface && selector === '[data-stage3d-surface]' ? secondSurface ? [surface, secondSurface] : [surface] : [] };
    const data: Record<string, string> = { stage3dFaceUp: 'false', stage3dKind: 'live', objectId: 'anonymous-public-object', stage3dHighlight: 'limited' };
    const style = { transform: '', transformOrigin: '', clipPath: 'inset(1px)', pointerEvents: '' };
    surface = { dataset: data, style, parentElement: root, isConnected: true, offsetWidth: 100, offsetHeight: 140,
      getBoundingClientRect: () => ({ left: style.transform ? 99 : 150, top: style.transform ? 44 : 110, width: 100, height: 140 }),
      querySelectorAll: () => [front, back], querySelector: () => null, contains: () => false,
      closest: (selector: string) => selector === '[data-stage3d-field]' ? field : selector === '[aria-roledescription="draggable"]' ? dragHost : null };
    const snapshot = collectStage3dSnapshot(root as unknown as HTMLElement);
    expect(snapshot.surfaces[0]).toMatchObject({ faceUp: false, imagePath: '/back.webp', highlight: 'none' });
    expect(JSON.stringify(snapshot)).not.toContain('previous-front');
    const current = snapshot.surfaces[0]!;
    applyStage3dSurfaceProjection(root as unknown as HTMLElement, current, getStage3dProjectedQuad(getStage3dSurfacePose(current, projection)!, projection));
    expect(data.stage3dProjected).toBe('true');
    expect(style.transform).toContain('matrix3d(');
    expect(dragHost.style.pointerEvents).toBe('none');
    expect(collectStage3dSnapshot(root as unknown as HTMLElement).surfaces[0]!.rect).toEqual(current.rect);
    // Effect replay can release DOM ownership without changing any public card
    // or layout data. The next sample must still restore its hidden artwork and
    // projected input, instead of waiting for a JSON snapshot change.
    releaseStage3dDomProjection(root as unknown as HTMLElement);
    expect(data.stage3dProjected).toBeUndefined();
    expect(style.transform).toBe('');
    const replayed = collectStage3dSnapshot(root as unknown as HTMLElement);
    expect(replayed).toEqual(snapshot);
    reconcileStage3dDomProjection(root as unknown as HTMLElement, projection, replayed, new Set([current.key]));
    expect(data.stage3dProjected).toBe('true');
    expect(style.transform).toContain('matrix3d(');
    expect(dragHost.style.pointerEvents).toBe('none');
    // Ordinary movement hides the target until arrival. Its decoded static
    // mesh stays ready, so removing CSS visibility must never expose a flat
    // DOM card while the next visibility snapshot reaches the Three scene.
    const occluded = { ...replayed, surfaces: replayed.surfaces.map(candidate => ({ ...candidate, visible: false })) };
    reconcileStage3dDomProjection(root as unknown as HTMLElement, projection, occluded, new Set([current.key]));
    expect(data.stage3dProjected).toBe('true');
    const hiddenTransform = style.transform;
    reconcileStage3dDomProjection(root as unknown as HTMLElement, projection, replayed, new Set([current.key]));
    expect(data.stage3dProjected).toBe('true');
    expect(style.transform).toBe(hiddenTransform);
    expect(dragHost.style.pointerEvents).toBe('none');
    // A failed/unready renderer hands its original artwork and input back.
    reconcileStage3dDomProjection(root as unknown as HTMLElement, projection, replayed, new Set());
    expect(data.stage3dProjected).toBeUndefined();
    expect(style.transform).toBe('');
    expect(dragHost.style.pointerEvents).toBe('');
    expect(listeners.size).toBe(0);
    reconcileStage3dDomProjection(root as unknown as HTMLElement, projection, replayed, new Set([current.key]));
    const outside = { clientX: 80, clientY: 40, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    listeners.get('dblclick')!(outside as unknown as Event);
    expect(outside.preventDefault).toHaveBeenCalledOnce();
    const inside = { clientX: 200, clientY: 180, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    listeners.get('pointerdown')!(inside as unknown as Event);
    expect(inside.preventDefault).not.toHaveBeenCalled();
    // The same slot image can be reused while the browser still exposes the old
    // decoded currentSrc. Public identity must follow the newly declared src.
    data.stage3dFaceUp = 'true';
    data.objectId = 'new-public-card';
    front.src = '/newly-declared-front.webp';
    const replacement = collectStage3dSnapshot(root as unknown as HTMLElement).surfaces[0]!;
    expect(replacement.objectId).toBe('new-public-card');
    expect(replacement.imagePath).toBe('/newly-declared-front.webp');
    expect(replacement.imagePath).not.toBe(front.currentSrc);
    const secondBack = { ...back, closest: () => secondSurface };
    secondSurface = { ...surface, dataset: { ...data, stage3dFaceUp: 'false', objectId: 'public-deck-layer' },
      style: { transform: '', transformOrigin: '', clipPath: '', pointerEvents: '' },
      getBoundingClientRect: () => ({ left: 151, top: 111, width: 100, height: 140 }),
      querySelectorAll: () => [secondBack] };
    const stacked = collectStage3dSnapshot(root as unknown as HTMLElement).surfaces[1]!;
    applyStage3dSurfaceProjection(root as unknown as HTMLElement, stacked,
      getStage3dProjectedQuad(getStage3dSurfacePose(stacked, projection)!, projection));
    // Shared deck layers retain one listener set and restore the original host
    // pointer events only after the last projected surface is released.
    expect(listeners.size).toBe(4);
    showSurface = false;
    collectStage3dSnapshot(root as unknown as HTMLElement);
    expect(data.stage3dProjected).toBeUndefined();
    expect(style.transform).toBe('');
    expect(style.clipPath).toBe('inset(1px)');
    expect(dragHost.style.pointerEvents).toBe('');
    expect(listeners.size).toBe(0);
  });
});
