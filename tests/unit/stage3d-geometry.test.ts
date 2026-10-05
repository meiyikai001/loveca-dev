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
import { getStageCardFaceHeight, getStagePileHeight } from '../../client/src/components/game/stage3d/stageCardPhysical';
import { sampleStageMove } from '../../client/src/components/game/stage3d/stageMoveLifecycle';

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
    expect(near.width).toBe(1.4);
    expect(far.width).toBe(near.width);
    expect(far.height).toBe(near.height);
    expect(near.height / near.width).toBeCloseTo(1.4);
    const resource = getStage3dSurfacePose(makeSurface({ kind: 'deck' }), projection)!;
    expect(resource.width).toBe(STAGE3D_RESOURCE_CARD_WIDTH);
    expect(resource.width).toBe(.7425);
    const energy = getStage3dSurfacePose(makeSurface({ kind: 'energy' }), projection)!;
    expect(energy.width).toBe(STAGE3D_ENERGY_CARD_WIDTH);
    expect(energy.width).toBe(.675 / 2);
    expect(energy.height / energy.width).toBeCloseTo(1.4);
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
      ['ENERGY_ZONE', 'energy', 0], ['ENERGY_ZONE', 'energy', 90],
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

  it('aligns success slots along the table depth axis, independent of the opposite waiting pile height', () => {
    const perspective: Stage3dProjection = {
      worldToScreen: ({ x, y, z }) => ({ x: 200 + x * 100 / (1 - y * .03 + z * .005), y: 150 + z * 80 - y * 30 }),
      screenToWorld: ({ x, y }, height = 0) => {
        const z = (y - 150 + height * 30) / 80;
        return { x: (x - 200) * (1 - height * .03 + z * .005) / 100, y: height, z };
      },
    };
    for (const side of ['self', 'opponent'] as const) for (const count of [0, 1, 20, 60]) {
      const waiting = { ...makeSnapshot().zones[0]!, key: 'waiting', kind: 'waiting' as const, side: side === 'self' ? 'opponent' as const : 'self' as const,
        rect: { left: 315, top: 90, width: 50, height: 70 }, pileCount: count };
      const slots = [280, 360, 440].map((top, index) => ({ ...makeSnapshot().zones[0]!, key: `success-${index}`,
        kind: 'success' as const, side, rect: { left: 300, top, width: 70, height: 50 }, rotation: -90 }));
      const surfaces = slots.map(zone => makeSurface({ kind: 'success', side, ownerZoneKey: zone.key, stackDepth: 0, rotation: -90 }));
      const snapshot = { ...makeSnapshot(surfaces), zones: [waiting, ...slots] };
      const waitingBase = getStage3dZonePose(waiting, perspective, snapshot)!;
      const screenCenters: number[] = [];
      surfaces.forEach((surface, index) => {
        const pose = getStage3dSurfacePose(surface, perspective, snapshot)!;
        expect(pose.position.x).toBe(waitingBase.position.x);
        screenCenters.push(perspective.worldToScreen(pose.position).x);
        const frame = getStage3dZonePose(slots[index]!, perspective, snapshot)!;
        expect(frame.position.x).toBe(pose.position.x);
        expect(frame.position.z).toBe(pose.position.z);
        if (index > 0) {
          const previous = getStage3dZonePose(slots[index - 1]!, perspective, snapshot)!;
          // Every covered card still exposes 55% of its face at full size.
          expect(frame.position.z - previous.position.z).toBeCloseTo(frame.width * .55);
        }
      });
      const inwardIndex = side === 'self' ? 0 : slots.length - 1;
      const inward = getStage3dZonePose(slots[inwardIndex]!, perspective, snapshot)!;
      const oldMiddle = perspective.screenToWorld({ x: 335, y: (280 + 440 + 50) / 2 }, 0)!;
      expect(inward.position.z).toBeCloseTo(oldMiddle.z + (inwardIndex - 1) * STAGE3D_CARD_WIDTH * .8);
      // Near/far slots converge in perspective instead of forming a screen-vertical line.
      expect(screenCenters[0]).toBeGreaterThan(screenCenters[2]!);
      const withoutWaiting = { ...snapshot, zones: slots };
      const fallbackX = getStage3dZonePose(slots[1]!, perspective, withoutWaiting)!.position.x;
      slots.forEach(slot => expect(getStage3dZonePose(slot, perspective, withoutWaiting)!.position.x).toBe(fallbackX));
    }
  });

  it('aligns both energy rows along table columns and shares the pose with hits and move endpoints', () => {
    const perspective: Stage3dProjection = {
      worldToScreen: ({ x, y, z }) => ({ x: 200 + x * 100 / (1 - y * .03 + z * .005), y: 150 + z * 80 - y * 30 }),
      screenToWorld: ({ x, y }, height = 0) => {
        const z = (y - 150 + height * 30) / 80;
        return { x: (x - 200) * (1 - height * .03 + z * .005) / 100, y: height, z };
      },
    };
    for (const count of [7, 9, 12]) {
      const surfaces = (['self', 'opponent'] as const).flatMap(side => Array.from({ length: count }, (_, index) => {
        const column = index % 6, row = Math.floor(index / 6);
        return makeSurface({ key: `${side}-${index}`, objectId: `obj_${side}-${index}`, kind: 'energy', side,
          ownerZoneKey: null, energyColumn: column, stackDepth: 0, rotation: index % 2 ? 0 : 90,
          rect: { left: (side === 'self' ? 20 : 900) + column * 45,
            top: (side === 'self' ? 600 : 120) + row * 40, width: 35, height: 25 } });
      }));
      const snapshot = { ...makeSnapshot(surfaces.slice().reverse()), zones: [] };
      const release = installStage3dGeometry({} as HTMLElement, perspective, snapshot);
      try {
        for (const surface of surfaces) {
          const first = surfaces.find(candidate => candidate.side === surface.side && candidate.energyColumn === surface.energyColumn)!;
          const firstPose = getStage3dSurfacePose(first, perspective, snapshot)!;
          const pose = getStage3dSurfacePose(surface, perspective, snapshot)!;
          expect(pose.position.x).toBe(firstPose.position.x);
          expect(pose.position.z).toBe(perspective.screenToWorld({
            x: surface.rect.left + surface.rect.width / 2, y: surface.rect.top + surface.rect.height / 2,
          })!.z);
          expect(pose.width).toBe(STAGE3D_ENERGY_CARD_WIDTH);
          expect(pose.rotation).toBe(surface.rotation);
          expect(resolveStage3dObjectPose(surface.objectId!)!.quad).toEqual(getStage3dProjectedQuad(pose, perspective));
          expect(resolveStage3dMovePose(surface.objectId, 'ENERGY_ZONE', surface.rect, 'to')).toEqual(pose);
          const turned = getStage3dSurfacePose({ ...surface, rotation: surface.rotation === 0 ? 90 : 0 }, perspective, snapshot)!;
          expect(turned.position).toEqual(pose.position);
        }
      } finally { release(); }
    }
  });

  it('keeps LIVE artwork at one physical size throughout movement into successful LIVE', () => {
    const live = { ...makeSnapshot().zones[0]!, key: 'live', kind: 'live' as const, rotation: -90 };
    const success = { ...live, key: 'success', kind: 'success' as const,
      rect: { left: 20, top: 350, width: 160, height: 110 } };
    const surface = makeSurface({ kind: 'live', ownerZoneKey: live.key, rotation: -90 });
    const snapshot = { ...makeSnapshot([surface]), zones: [live, success] };
    const release = installStage3dGeometry({} as HTMLElement, projection, snapshot);
    const from = resolveStage3dMovePose(surface.objectId, 'LIVE_ZONE', live.rect, 'from')!;
    const to = resolveStage3dMovePose(surface.objectId, 'SUCCESS_ZONE', success.rect, 'to')!;
    const settled = getStage3dSurfacePose({ ...surface, kind: 'success', ownerZoneKey: success.key, stackDepth: 0 }, projection, snapshot)!;
    expect(to).toEqual(settled);
    for (const elapsed of [0, 100, 240, 479, 480]) {
      const pose = sampleStageMove(from, to, elapsed, 480);
      expect(pose.width).toBe(from.width);
      expect(pose.height).toBe(from.height);
      expect(pose.rotation).toBe(-90);
    }
    release();
  });

  it('lands a single card on the exact current pile top and leaves no body below the floor', () => {
    const width = STAGE3D_RESOURCE_CARD_WIDTH, height = width * 1.4;
    let previousHeight = 0;
    for (const count of [1, 5, 20, 60]) {
      const surface = makeSurface({ kind: 'waiting', ownerZoneKey: 'pile', stackDepth: 0, pileCount: count });
      const zone = { ...makeSnapshot().zones[0]!, key: 'pile', kind: 'waiting' as const, pileCount: count };
      const snapshot = { ...makeSnapshot(), surfaces: [surface], zones: [zone] };
      const release = installStage3dGeometry({} as HTMLElement, projection, snapshot);
      const pose = getStage3dSurfacePose(surface, projection, snapshot)!;
      expect(pose.position.y).toBeGreaterThan(previousHeight);
      expect(pose.position.y - getStagePileHeight(count, width, height)).toBeCloseTo(.003);
      previousHeight = pose.position.y;
      const to = resolveStage3dMovePose(surface.objectId, 'WAITING_ROOM', zone.rect, 'to')!;
      expect(to).toEqual(pose);
      const from = { ...pose, width: 1.5, height: 2.1, position: { ...pose.position, y: 2 } };
      expect(sampleStageMove(from, to, 480, 480)).toEqual(pose);
      release();
    }
    // A source whose public DOM already moved has one fewer card in its pile.
    const zone = { ...makeSnapshot().zones[0]!, key: 'deck', kind: 'deck' as const, pileCount: 59 };
    const moved = makeSurface();
    const release = installStage3dGeometry({} as HTMLElement, projection, { ...makeSnapshot([moved]), zones: [zone] });
    expect(resolveStage3dMovePose(moved.objectId, 'MAIN_DECK', zone.rect, 'from')!.position.y)
      .toBeCloseTo(getStageCardFaceHeight(width, height, 0, 60));
    release();
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
    expect(hitTestStage3dZones({ x: 265, y: 180 })).toEqual(['player-member-left']);
    expect(hitTestStage3dZones({ x: 275, y: 180 })).toEqual([]);
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
    const sourceSurface = makeSurface({ stackDepth: 4 });
    const snapshot = makeSnapshot([sourceSurface]);
    const target = { ...snapshot.zones[0]!, key: 'right', targetId: 'player-member-right', rect: { left: 550, top: 110, width: 100, height: 140 } };
    const release = installStage3dGeometry({} as HTMLElement, projection, { ...snapshot, zones: [...snapshot.zones, target] });
    expect(resolveStage3dMovePose('obj_visible', 'MEMBER_SLOT', snapshot.zones[0]!.rect, 'from'))
      .toEqual(getStage3dSurfacePose(sourceSurface, projection, snapshot));
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
