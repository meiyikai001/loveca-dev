import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectStage3dSnapshot, hitTestStage3dZones, installStage3dGeometry,
  getStage3dProjectedQuad, getStage3dZonePose,
  reconcileStage3dDomProjection, releaseStage3dDomProjection,
} from '../../client/src/components/game/stage3d/geometry';
import type { Stage3dProjection } from '../../client/src/components/game/stage3d/types';

const projection: Stage3dProjection = {
  worldToScreen: ({ x, y, z }) => ({ x: 200 + x * 100, y: 150 + z * 80 - y * 30 }),
  screenToWorld: ({ x, y }, height = 0) => ({ x: (x - 200) / 100, y: height, z: (y - 150 + height * 30) / 80 }),
};

function transformedPoint(element: ElementFixture, point: { x: number; y: number }) {
  for (let current: ElementFixture | null = element; current; current = current.parentElement) {
    const matrix = /matrix3d\(([^)]+)\)/.exec(current.style.transform);
    if (!matrix) continue;
    const values = matrix[1]!.split(',').map(Number);
    const center = { x: current.rect.left + current.rect.width / 2, y: current.rect.top + current.rect.height / 2 };
    const x = point.x - center.x, y = point.y - center.y;
    const divisor = values[3]! * x + values[7]! * y + values[15]!;
    point = { x: center.x + (values[0]! * x + values[4]! * y + values[12]!) / divisor,
      y: center.y + (values[1]! * x + values[5]! * y + values[13]!) / divisor };
  }
  return point;
}

// A small DOM fixture exercises the real collector and reconciliation lifecycle.
// Rectangles describe layout sources; projected event surfaces keep their own style.
class ElementFixture {
  readonly children: ElementFixture[] = [];
  parentElement: ElementFixture | null = null;
  isConnected = true;
  id = '';
  style = { transform: '', transformOrigin: '', clipPath: '', pointerEvents: '' };
  constructor(readonly dataset: Record<string, string> = {},
    readonly rect = { left: 150, top: 110, width: 100, height: 140 }) {}
  get offsetWidth() { return this.rect.width; }
  get offsetHeight() { return this.rect.height; }
  getBoundingClientRect() {
    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => transformedPoint(this,
      { x: this.rect.left + x! * this.rect.width, y: this.rect.top + y! * this.rect.height }));
    const left = Math.min(...corners.map(point => point.x)), top = Math.min(...corners.map(point => point.y));
    return { left, top, width: Math.max(...corners.map(point => point.x)) - left,
      height: Math.max(...corners.map(point => point.y)) - top };
  }
  getAttribute(name: string) {
    return this.dataset[name.replace(/^data-/, '').replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] ?? null;
  }
  matches(selector: string) {
    const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (!attribute) return false;
    const value = this.getAttribute(attribute[1]!);
    return value !== null && (attribute[2] === undefined || value === attribute[2]);
  }
  closest(selector: string): ElementFixture | null {
    return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null;
  }
  contains(element: ElementFixture): boolean {
    return this === element || this.children.some(child => child.contains(element));
  }
  querySelectorAll(selector: string): ElementFixture[] {
    const selectors = selector.split(',').map(value => value.trim());
    return this.children.flatMap(child => [
      ...(selectors.some(value => child.matches(value)) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  append(child: ElementFixture) { child.parentElement = this; this.children.push(child); return child; }
}

const roots: ElementFixture[] = [];
function fixture(readonlyLive = false) {
  const root = new ElementFixture({}, { left: 0, top: 80, width: 1600, height: 820 });
  roots.push(root);
  const side = readonlyLive ? 'opponent' : 'self';
  const targetId = `${side}-live`;
  const field = root.append(new ElementFixture({ stage3dField: '', stage3dSide: side }));
  const drop = field.append(new ElementFixture(readonlyLive
    ? { animationZoneId: targetId, battleUiAnchor: 'opponent-live-zone' }
    : { zoneId: 'LIVE_ZONE', stage3dDropState: 'suggested', stage3dDropDisabled: 'false' }));
  if (!readonlyLive) drop.id = targetId;
  const slots = [0, 1, 2].map(index => {
    const slot = drop.append(new ElementFixture({ stage3dZone: `${side}-live-${index}`, stage3dKind: 'live',
      stage3dTargetId: targetId, stage3dZoneRotation: '-90', stage3dZoneState: 'selectable' },
      { left: 150 + index * 250, top: 110, width: 100, height: 140 }));
    const hit = slot.append(new ElementFixture({ stage3dZoneHit: '' }, slot.rect));
    hit.style.clipPath = 'inset(1px)';
    const choice = slot.append(new ElementFixture({ choiceBadge: '可选' }));
    return { slot, hit, choice };
  });
  return { root, field, drop, slots };
}
const dom = (element: ElementFixture) => element as unknown as HTMLElement;

function successFixture() {
  const root = new ElementFixture({}, { left: 0, top: 80, width: 1600, height: 820 });
  roots.push(root);
  const field = root.append(new ElementFixture({ stage3dField: '', stage3dSide: 'self' }));
  const drop = field.append(new ElementFixture({ zoneId: 'SUCCESS_ZONE', battleUiAnchor: 'self-success-live-zone' }));
  drop.id = 'self-success';
  const caption = drop.append(new ElementFixture({ stage3dZoneCaption: 'self-success-0' },
    { left: 305, top: 230, width: 90, height: 20 }));
  caption.style.transformOrigin = '20% 30%';
  caption.style.clipPath = 'inset(1px)';
  caption.style.pointerEvents = 'auto';
  const slots = [0, 1, 2].map(index => {
    const slot = drop.append(new ElementFixture({ stage3dZone: `self-success-${index}`, stage3dKind: 'success',
      stage3dTargetId: drop.id, stage3dZoneRotation: '-90' },
      { left: 300, top: 280 + index * 80, width: 100, height: 70 }));
    const hit = slot.append(new ElementFixture({ stage3dZoneHit: '' }, slot.rect));
    const note = hit.append(new ElementFixture({ note: '♪' },
      { left: slot.rect.left + 45, top: slot.rect.top + 30, width: 10, height: 10 }));
    return { slot, hit, note };
  });
  const opponent = root.append(new ElementFixture({ stage3dField: '', stage3dSide: 'opponent' }));
  const waiting = opponent.append(new ElementFixture({ stage3dZone: 'opponent-waiting', stage3dKind: 'waiting' },
    { left: 550, top: 80, width: 50, height: 70 }));
  const perspective: Stage3dProjection = {
    worldToScreen: ({ x, y, z }) => ({ x: 200 + x * 100 / (1 + z * .1), y: 150 + (z * 80 - y * 30) / (1 + z * .1) }),
    screenToWorld: ({ x, y }, height = 0) => {
      const z = (y - 150 + height * 30) / (80 - (y - 150) * .1);
      return { x: (x - 200) * (1 + z * .1) / 100, y: height, z };
    },
  };
  return { root, drop, caption, slots, waiting, perspective };
}

describe('ready stage zone takeover', () => {
  beforeEach(() => {
    vi.stubGlobal('getComputedStyle', (element: ElementFixture) => ({
      scale: 'none', rotate: 'none', transform: element.style.transform || 'none', opacity: '1', visibility: 'visible', display: 'block',
    }));
    vi.stubGlobal('DOMMatrix', class {
      a = 1; b = 0; c = 0; d = 1;
      scale() { return this; } multiply() { return this; } rotate() { return this; }
    });
  });
  afterEach(() => {
    for (const root of roots.splice(0)) releaseStage3dDomProjection(dom(root));
    vi.unstubAllGlobals();
  });

  it('keeps cold DOM targets until projection is ready, then hands over the frame without hiding choices or changing legal hits', () => {
    const { root, drop, slots } = fixture();
    const snapshot = collectStage3dSnapshot(dom(root));
    expect(drop.dataset.stage3dZoneRendered).toBeUndefined();
    expect(slots.every(({ hit }) => hit.style.transform === '')).toBe(true);
    expect(snapshot.zones).toHaveLength(3);
    expect(snapshot.zones.every(zone => zone.state === 'suggested')).toBe(true);
    reconcileStage3dDomProjection(dom(root), projection, snapshot, new Set());
    expect(drop.dataset.stage3dZoneRendered).toBe('true');
    for (const { slot, hit, choice } of slots) {
      expect(slot.dataset.stage3dZoneRendered).toBe('true');
      expect(hit.dataset.stage3dProjected).toBe('true');
      expect(hit.style.transform).toContain('matrix3d(');
      expect(hit.style.pointerEvents).toBe('auto');
      expect(choice.dataset.stage3dZoneRendered).toBeUndefined();
    }
    const release = installStage3dGeometry(dom(root), projection, snapshot);
    expect(hitTestStage3dZones({ x: 200, y: 180 })).toEqual(['self-live']);
    expect(hitTestStage3dZones({ x: 500, y: 500 })).toEqual([]);
    expect(hitTestStage3dZones({ x: 200, y: 180 }, new Set(['other-target']))).toEqual([]);
    release();
    drop.dataset.stage3dDropState = 'idle';
    drop.dataset.stage3dDropDisabled = 'true';
    const selectable = collectStage3dSnapshot(dom(root));
    expect(selectable.zones.every(zone => zone.state === 'selectable' && zone.disabled)).toBe(true);
    const releaseDisabled = installStage3dGeometry(dom(root), projection, selectable);
    expect(hitTestStage3dZones({ x: 200, y: 180 })).toEqual([]);
    releaseDisabled();
    releaseStage3dDomProjection(dom(root));
    expect(drop.dataset.stage3dZoneRendered).toBeUndefined();
    for (const { slot, hit } of slots) {
      expect(slot.dataset.stage3dZoneRendered).toBeUndefined();
      expect(hit.dataset.stage3dProjected).toBeUndefined();
      expect(hit.style).toEqual({ transform: '', transformOrigin: '', clipPath: 'inset(1px)', pointerEvents: '' });
    }
    expect(collectStage3dSnapshot(dom(root))).toEqual(selectable);
  });

  it('restores an unprojectable target and keeps aggregate energy feedback in the DOM', () => {
    const { root, field, drop, slots } = fixture();
    const energy = field.append(new ElementFixture({ zoneId: 'ENERGY_ZONE', stage3dKind: 'energy', stage3dDropState: 'active' }));
    energy.id = 'self-energy';
    const snapshot = collectStage3dSnapshot(dom(root));
    reconcileStage3dDomProjection(dom(root), projection, snapshot, new Set());
    expect(energy.dataset.stage3dZoneRendered).toBeUndefined();
    expect(snapshot.zones.find(zone => zone.targetId === energy.id)?.state).toBe('active');
    reconcileStage3dDomProjection(dom(root), { ...projection, screenToWorld: () => null }, snapshot, new Set());
    expect(drop.dataset.stage3dZoneRendered).toBeUndefined();
    expect(slots.every(({ slot, hit }) => !slot.dataset.stage3dZoneRendered && !hit.dataset.stage3dProjected && hit.style.transform === '')).toBe(true);
    reconcileStage3dDomProjection(dom(root), projection, snapshot, new Set());
    expect(drop.dataset.stage3dZoneRendered).toBe('true');
  });

  it('retains a shared droppable frame owner while a remaining slot is rendered and releases removed nodes', () => {
    const { root, drop, slots } = fixture();
    reconcileStage3dDomProjection(dom(root), projection, collectStage3dSnapshot(dom(root)), new Set());
    const removed = slots[0]!;
    drop.children.splice(0, 1);
    removed.slot.isConnected = false;
    removed.hit.isConnected = false;
    reconcileStage3dDomProjection(dom(root), projection, collectStage3dSnapshot(dom(root)), new Set());
    expect(removed.slot.dataset.stage3dZoneRendered).toBeUndefined();
    expect(removed.hit.dataset.stage3dProjected).toBeUndefined();
    expect(removed.hit.style.transform).toBe('');
    expect(drop.dataset.stage3dZoneRendered).toBe('true');
    expect(slots[1]!.slot.dataset.stage3dZoneRendered).toBe('true');
    releaseStage3dDomProjection(dom(root));
    expect(drop.dataset.stage3dZoneRendered).toBeUndefined();
  });

  it('hands over the read-only opponent LIVE aggregate background only while its physical slots are ready', () => {
    const { root, drop, slots } = fixture(true);
    const snapshot = collectStage3dSnapshot(dom(root));
    expect(snapshot.zones).toHaveLength(3);
    expect(snapshot.zones.every(zone => zone.side === 'opponent')).toBe(true);
    expect(drop.dataset.zoneId).toBeUndefined();
    expect(drop.dataset.stage3dZoneRendered).toBeUndefined();
    reconcileStage3dDomProjection(dom(root), projection, snapshot, new Set());
    expect(drop.dataset.stage3dZoneRendered).toBe('true');
    expect(slots.every(({ slot }) => slot.dataset.stage3dZoneRendered === 'true')).toBe(true);
    expect(slots.every(({ choice }) => !choice.dataset.stage3dZoneRendered)).toBe(true);
    reconcileStage3dDomProjection(dom(root), { ...projection, screenToWorld: () => null }, snapshot, new Set());
    expect(drop.dataset.stage3dZoneRendered).toBeUndefined();
    reconcileStage3dDomProjection(dom(root), projection, snapshot, new Set());
    releaseStage3dDomProjection(dom(root));
    expect(drop.dataset.stage3dZoneRendered).toBeUndefined();
  });

  it('keeps success captions above the world back edge and notes in the slot quad without drift across repeated samples or resize', () => {
    const { root, caption, slots, waiting, perspective } = successFixture();
    const original = { ...caption.style };
    const before = caption.getBoundingClientRect();
    const check = () => {
      const snapshot = collectStage3dSnapshot(dom(root));
      reconcileStage3dDomProjection(dom(root), perspective, snapshot, new Set());
      const zone = snapshot.zones.find(candidate => candidate.key === 'self-success-0')!;
      const pose = getStage3dZonePose(zone, perspective, snapshot)!;
      const quad = getStage3dProjectedQuad(pose, perspective);
      // The landscape slot's far edge is the edge between its right-hand local
      // corners; the perspective midpoint differs from its old CSS column.
      const centerX = (quad[1].x + quad[2].x) / 2;
      const bounds = caption.getBoundingClientRect();
      expect(bounds.left + bounds.width / 2).toBeCloseTo(centerX, 5);
      expect(bounds.top + bounds.height).toBeCloseTo(Math.min(quad[1].y, quad[2].y) - 8, 5);
      expect(bounds.width).toBeCloseTo(caption.rect.width, 5);
      expect(bounds.height).toBeCloseTo(caption.rect.height, 5);
      expect(caption.style.pointerEvents).toBe('none');
      for (const { slot, hit, note } of slots) {
        const current = snapshot.zones.find(candidate => candidate.key === slot.dataset.stage3dZone)!;
        const currentPose = getStage3dZonePose(current, perspective, snapshot)!;
        const point = transformedPoint(note, { x: note.rect.left + note.rect.width / 2, y: note.rect.top + note.rect.height / 2 });
        const expected = perspective.worldToScreen(currentPose.position);
        expect(note.parentElement).toBe(hit);
        expect(note.style.transform).toBe('');
        expect(point.x).toBeCloseTo(expected.x, 5);
        expect(point.y).toBeCloseTo(expected.y, 5);
      }
      return { snapshot, bounds, transform: caption.style.transform };
    };
    const first = check();
    expect(first.bounds.left).not.toBe(before.left);
    for (let index = 0; index < 4; index++) expect(check()).toEqual(first);
    root.rect.width = 1200;
    waiting.rect.left += 75;
    caption.rect.left -= 40;
    caption.rect.width = 110;
    caption.rect.top += 30;
    for (const { slot, note } of slots) { slot.rect.top += 45; note.rect.top += 45; }
    const resized = check();
    expect(resized.bounds).not.toEqual(first.bounds);
    for (let index = 0; index < 4; index++) expect(check()).toEqual(resized);
    releaseStage3dDomProjection(dom(root));
    expect(caption.style).toEqual(original);
    expect(caption.getBoundingClientRect()).toEqual(caption.rect);
    expect(caption.dataset.stage3dProjected).toBeUndefined();
  });

  it('restores caption styling when projection or its zone is unavailable, and releases replaced caption nodes', () => {
    const { root, drop, caption, perspective } = successFixture();
    const original = { ...caption.style };
    const snapshot = collectStage3dSnapshot(dom(root));
    reconcileStage3dDomProjection(dom(root), perspective, snapshot, new Set());
    expect(caption.dataset.stage3dProjected).toBe('true');
    reconcileStage3dDomProjection(dom(root), { ...perspective, screenToWorld: () => null }, snapshot, new Set());
    expect(caption.style).toEqual(original);
    expect(caption.dataset.stage3dProjected).toBeUndefined();
    reconcileStage3dDomProjection(dom(root), perspective, snapshot, new Set());
    reconcileStage3dDomProjection(dom(root), perspective,
      { ...snapshot, zones: snapshot.zones.filter(zone => zone.key !== 'self-success-0') }, new Set());
    expect(caption.style).toEqual(original);
    reconcileStage3dDomProjection(dom(root), perspective, snapshot, new Set());
    caption.rect.width = 0;
    const collapsed = collectStage3dSnapshot(dom(root));
    reconcileStage3dDomProjection(dom(root), perspective, collapsed, new Set());
    expect(caption.style).toEqual(original);
    expect(caption.dataset.stage3dProjected).toBeUndefined();
    caption.rect.width = 90;
    reconcileStage3dDomProjection(dom(root), perspective, collectStage3dSnapshot(dom(root)), new Set());
    expect(caption.dataset.stage3dProjected).toBe('true');
    drop.children.splice(drop.children.indexOf(caption), 1);
    caption.isConnected = false;
    const replacement = drop.append(new ElementFixture({ stage3dZoneCaption: 'self-success-0' }, caption.rect));
    const replaced = collectStage3dSnapshot(dom(root));
    expect(caption.style).toEqual(original);
    expect(caption.dataset.stage3dProjected).toBeUndefined();
    reconcileStage3dDomProjection(dom(root), perspective, replaced, new Set());
    expect(replacement.dataset.stage3dProjected).toBe('true');
    releaseStage3dDomProjection(dom(root));
    expect(replacement.style.transform).toBe('');
    expect(replacement.dataset.stage3dProjected).toBeUndefined();
  });
});
