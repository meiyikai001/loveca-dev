import type {
  Stage3dGeometry, Stage3dPoint, Stage3dPose, Stage3dProjection, Stage3dQuad,
  Stage3dRect, Stage3dResolvedSurface, Stage3dSide, Stage3dSnapshot,
  Stage3dSurface, Stage3dSurfaceKind, Stage3dZone, Stage3dZoneState,
} from './types';
import { getStageCardFaceHeight, getStageCardThickness, STAGE_CARD_GROUND_GAP } from './stageCardPhysical';

export const STAGE3D_CARD_HEIGHT = getStageCardFaceHeight(1.5, 2.1);
export const STAGE3D_CARD_WIDTH = 1.5;
export const STAGE3D_CARD_ASPECT = 1.4;
export const STAGE3D_CARD_LAYER_HEIGHT = getStageCardThickness(1.5, 2.1) + STAGE_CARD_GROUND_GAP;
// Keep resource cards readable while reducing the main field cards by one third.
export const STAGE3D_RESOURCE_CARD_WIDTH = .7425;
export const STAGE3D_ENERGY_CARD_WIDTH = .16875;
const SURFACE_SELECTOR = '[data-stage3d-surface]';
const ART_SELECTOR = 'img[data-stage3d-art]';
const FIELD_SELECTOR = '[data-stage3d-field]';
const EXPLICIT_ZONE_SELECTOR = '[data-stage3d-zone]';
interface LayoutFrame { center: Stage3dPoint; width: number; height: number; a: number; b: number; c: number; d: number; transform: string }
interface ProjectionStyle { transform: string; transformOrigin: string; clipPath: string; pointerEvents: string; appliedTransform: string }
const elementKeys = new WeakMap<HTMLElement, string>();
const sourceElements = new Map<string, HTMLElement>();
const sourceRoots = new Map<string, HTMLElement>();
const sourceFrames = new Map<HTMLElement, LayoutFrame>();
const zoneElements = new Map<string, HTMLElement>();
const zoneRoots = new Map<string, HTMLElement>();
const zoneCaptions = new Map<HTMLElement, { root: HTMLElement; zoneKey: string }>();
const zoneVisualElements = new Map<string, { root: HTMLElement; elements: readonly HTMLElement[] }>();
const renderedZoneElements = new Map<HTMLElement, HTMLElement>();
const projectedElements = new Map<HTMLElement, ProjectionStyle>();
const dragGuards = new Map<string, { host: HTMLElement; quad: Stage3dQuad; pointerEvents: string; listener: (event: Event) => void }>();
let nextElementKey = 0;
let activeGeometry: Stage3dGeometry | null = null;

function rectOf(rect: DOMRect): Stage3dRect { return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }; }
function centerOf(rect: Stage3dRect): Stage3dPoint { return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; }
function keyOf(element: HTMLElement): string {
  let key = elementKeys.get(element);
  if (!key) { key = 'stage-surface-' + (++nextElementKey); elementKeys.set(element, key); }
  return key;
}
function sideOf(element: HTMLElement): Stage3dSide {
  return element.closest('[data-stage3d-side]')?.getAttribute('data-stage3d-side') === 'opponent' ? 'opponent' : 'self';
}
function kindOf(element: HTMLElement): Stage3dSurfaceKind {
  const explicit = element.dataset.stage3dKind;
  if (explicit) return explicit as Stage3dSurfaceKind;
  const anchor = element.closest('[data-battle-ui-anchor]')?.getAttribute('data-battle-ui-anchor') ?? '';
  if (anchor.includes('success-live')) return 'success';
  if (anchor.includes('live-zone')) return 'live';
  if (anchor.includes('energy-zone')) return 'energy';
  if (anchor.includes('waiting-room')) return 'waiting';
  if (anchor.includes('deck')) return 'deck';
  return 'member';
}
function isFieldElement(element: HTMLElement, root: HTMLElement): boolean {
  const field = element.closest(FIELD_SELECTOR);
  return !!field && root.contains(field) && !element.closest('[data-stage3d-exclude]');
}
function isVisible(element: HTMLElement, root: HTMLElement): boolean {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
    if (current === root) break;
  }
  return true;
}
/** Rule orientation is explicit. CSS transforms are never used to infer active/waiting. */
function rotationOf(element: HTMLElement, root: HTMLElement): number {
  let rotation = Number(element.dataset.stage3dRotation ?? 0);
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    rotation += Number(parent.dataset.stage3dLayoutRotation ?? 0);
    if (parent === root) break;
  }
  return rotation;
}
/** The CSS basis is used only to map interaction geometry back through existing DOM ancestors. */
function frameOf(element: HTMLElement, root: HTMLElement): LayoutFrame {
  let matrix = new DOMMatrix();
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    const values = style.scale && style.scale !== 'none' ? style.scale.split(/\s+/).map(Number) : [];
    const scale = new DOMMatrix().scale(values[0] || 1, values[1] || values[0] || 1);
    const angle = style.rotate && style.rotate !== 'none' ? Number.parseFloat(style.rotate.split(/\s+/).at(-1) ?? '0') : 0;
    const rotation = angle ? new DOMMatrix().rotate(angle) : new DOMMatrix();
    const transform = style.transform && style.transform !== 'none' ? new DOMMatrix(style.transform) : new DOMMatrix();
    matrix = rotation.multiply(scale).multiply(transform).multiply(matrix);
    if (current === root) break;
  }
  const style = getComputedStyle(element);
  return { center: centerOf(rectOf(element.getBoundingClientRect())), width: element.offsetWidth, height: element.offsetHeight,
    a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, transform: style.transform === 'none' ? '' : style.transform || '' };
}

/** Temporarily remove only our own transforms in one synchronous batch. No sampled feedback loop. */
function withLayoutSources<T>(root: HTMLElement, read: () => T): T {
  const restore: Array<[HTMLElement, string]> = [];
  for (const [element, saved] of projectedElements) {
    if (!root.contains(element)) continue;
    if (element.style.transform !== saved.appliedTransform) saved.transform = element.style.transform;
    restore.push([element, element.style.transform]);
    element.style.transform = saved.transform;
  }
  try { return read(); } finally {
    for (const [element, transform] of restore) if (projectedElements.has(element)) element.style.transform = transform;
  }
}
function dropElementOf(element: HTMLElement, root: HTMLElement): HTMLElement | null {
  const inner = element.matches('[data-zone-id]') ? element : element.querySelector<HTMLElement>('[data-zone-id]');
  if (inner) return inner;
  const parent = element.closest<HTMLElement>('[data-zone-id]');
  return parent && root.contains(parent) ? parent : null;
}
function zoneStateOf(element: HTMLElement, drop: HTMLElement | null): Stage3dZoneState {
  const state = drop?.dataset.stage3dDropState;
  if (state === 'active' || state === 'suggested') return state;
  return element.dataset.stage3dZoneState === 'selectable' ? 'selectable' : 'idle';
}

/** Read only marked, currently lawful front/back artwork and stable field layout anchors. */
export function collectStage3dSnapshot(root: HTMLElement): Stage3dSnapshot {
  return withLayoutSources(root, () => {
    const zones: Stage3dZone[] = [];
    const retainedZones = new Set<string>();
    root.querySelectorAll<HTMLElement>('[data-stage3d-zone], [data-zone-id], [data-animation-zone-id]').forEach(element => {
      if (!isFieldElement(element, root) || element.closest('[data-battle-animation-ignore="true"]')) return;
      const explicit = element.matches(EXPLICIT_ZONE_SELECTOR);
      // A physical slot replaces its old aggregate/inner rectangle in both drawing and hit testing.
      if (!explicit && (element.closest(EXPLICIT_ZONE_SELECTOR) || element.querySelector(EXPLICIT_ZONE_SELECTOR))) return;
      if (!explicit && element.dataset.animationZoneId && element.closest('[data-zone-id]')) return;
      const kind = kindOf(element);
      const resourceAnchor = kind === 'deck' || kind === 'waiting'
        ? element.querySelector<HTMLElement>('[data-stage3d-layout-anchor]') : null;
      const rect = rectOf((resourceAnchor || element).getBoundingClientRect());
      if (!rect.width || !rect.height) return;
      const key = element.dataset.stage3dZone || element.id || element.dataset.animationZoneId || keyOf(element);
      const drop = dropElementOf(element, root);
      // Read-only LIVE zones use an animation anchor rather than a droppable,
      // but its aggregate background is still replaced by the physical slots.
      const visualContainer = drop ?? (explicit ? element.closest<HTMLElement>('[data-animation-zone-id]') : null);
      zoneVisualElements.set(key, { root, elements: visualContainer && visualContainer !== element && root.contains(visualContainer)
        ? [element, visualContainer] : [element] });
      const hit = element.querySelector<HTMLElement>('[data-stage3d-zone-hit]');
      if (hit) { zoneElements.set(key, hit); zoneRoots.set(key, root); sourceFrames.set(hit, frameOf(hit, root)); retainedZones.add(key); }
      zones.push({ key, targetId: element.dataset.stage3dTargetId || element.id || element.dataset.animationZoneId || null,
        anchor: element.getAttribute('data-battle-ui-anchor') ?? element.closest('[data-battle-ui-anchor]')?.getAttribute('data-battle-ui-anchor') ?? null,
        rect, kind, side: sideOf(element), occupied: !!element.querySelector(SURFACE_SELECTOR),
        rotation: Number(element.dataset.stage3dZoneRotation ?? (kind === 'live' || kind === 'success' ? -90 : 0)),
        outlined: explicit, state: zoneStateOf(element, drop), disabled: drop?.dataset.stage3dDropDisabled === 'true',
        pileCount: resourceAnchor?.dataset.stage3dPileCount === undefined ? undefined : Number(resourceAnchor.dataset.stage3dPileCount) });
    });
    for (const [key, element] of zoneElements) {
      if (zoneRoots.get(key) === root && !retainedZones.has(key) || !element.isConnected) {
        restoreElementProjection(element); sourceFrames.delete(element); zoneElements.delete(key); zoneRoots.delete(key);
      }
    }
    const retainedZoneVisuals = new Set(zones.map(zone => zone.key));
    for (const [key, source] of zoneVisualElements) {
      if (source.root === root && !retainedZoneVisuals.has(key)) zoneVisualElements.delete(key);
    }
    const captions = new Set(root.querySelectorAll<HTMLElement>('[data-stage3d-zone-caption]'));
    for (const [element, owner] of zoneCaptions) {
      if ((owner.root === root && !captions.has(element)) || !element.isConnected) {
        restoreElementProjection(element); sourceFrames.delete(element); zoneCaptions.delete(element);
      }
    }
    for (const element of captions) {
      zoneCaptions.set(element, { root, zoneKey: element.dataset.stage3dZoneCaption! });
      sourceFrames.set(element, frameOf(element, root));
    }
    const surfaces: Stage3dSurface[] = [];
    const retained = new Set<string>();
    root.querySelectorAll<HTMLElement>(SURFACE_SELECTOR).forEach(element => {
      if (!isFieldElement(element, root)) return;
      const faceUp = element.dataset.stage3dFaceUp !== 'false';
      const art = [...element.querySelectorAll<HTMLImageElement>(ART_SELECTOR)].find(candidate => {
        if (candidate.closest(SURFACE_SELECTOR) !== element) return false;
        const side = candidate.dataset.stage3dArt;
        return side !== 'front' && side !== 'back' || side === (faceUp ? 'front' : 'back');
      });
      if (!art || !art.currentSrc && !art.getAttribute('src')) return;
      const frame = frameOf(element, root);
      if (frame.width <= 0 || frame.height <= 0) return;
      const kind = kindOf(element);
      const owner = kind === 'member' || kind === 'live' || kind === 'success' ? element.closest<HTMLElement>(EXPLICIT_ZONE_SELECTOR) : null;
      const anchor = element.closest<HTMLElement>('[data-stage3d-layout-anchor]');
      const pile = element.closest<HTMLElement>('[data-stage3d-pile-count]');
      const rect = rectOf((owner || anchor || element).getBoundingClientRect());
      const highlight = element.dataset.stage3dHighlight;
      const key = keyOf(element);
      retained.add(key); sourceElements.set(key, element); sourceRoots.set(key, root); sourceFrames.set(element, frame);
      // React may reuse a slot image: currentSrc can still identify the previous
      // card while the newly declared src is loading. Never pair that old texture
      // with the new public object identity.
      surfaces.push({ key, objectId: element.dataset.objectId ?? null, imagePath: art.src || art.currentSrc,
        rect, width: frame.width, height: frame.height, ownerZoneKey: owner?.dataset.stage3dZone ?? null,
        rotation: rotationOf(element, root), faceUp, kind, side: sideOf(element), stackDepth: Number(element.dataset.stage3dStackDepth ?? 0),
        pileCount: pile?.dataset.stage3dPileCount === undefined ? undefined : Number(pile.dataset.stage3dPileCount),
        visible: isVisible(element, root), selected: element.dataset.stage3dSelected === 'true',
        highlight: faceUp && (highlight === 'limited' || highlight === 'actionable' || highlight === 'available') ? highlight : 'none' });
    });
    for (const [key, element] of sourceElements) {
      if (sourceRoots.get(key) === root && !retained.has(key) || !element.isConnected) {
        releaseStage3dSurfaceProjection(key); sourceElements.delete(key); sourceRoots.delete(key); sourceFrames.delete(element);
      }
    }
    return { viewport: rectOf(root.getBoundingClientRect()), surfaces, zones };
  });
}

/** Hand/HUD bridge only. Field card dimensions must come from getStage3dCardDimensions. */
export function getStage3dScreenBridgePose(rect: Stage3dRect, width: number, height: number, rotation: number,
  projection: Stage3dProjection, elevation = STAGE3D_CARD_HEIGHT): Stage3dPose | null {
  const center = centerOf(rect), position = projection.screenToWorld(center, elevation);
  const horizontal = projection.screenToWorld({ x: center.x + width / 2, y: center.y }, elevation);
  if (!position || !horizontal || width <= 0 || height <= 0) return null;
  const worldWidth = Math.hypot(horizontal.x - position.x, horizontal.z - position.z) * 2;
  return { position, width: worldWidth, height: worldWidth * height / width, rotation };
}
export function getStage3dCardDimensions(kind: Stage3dSurfaceKind) {
  const width = kind === 'energy' ? STAGE3D_ENERGY_CARD_WIDTH
    : ['deck', 'waiting', 'success'].includes(kind) ? STAGE3D_RESOURCE_CARD_WIDTH : STAGE3D_CARD_WIDTH;
  return { width, height: width * STAGE3D_CARD_ASPECT };
}
export function getStage3dZonePose(zone: Stage3dZone, projection: Stage3dProjection, snapshot?: Stage3dSnapshot): Stage3dPose | null {
  // Aggregate resource zones retain their full legal footprint; their individual
  // card meshes still have fixed physical sizes. Explicit member/LIVE slots do not.
  if (!zone.outlined && zone.kind === 'energy') return getStage3dScreenBridgePose(zone.rect, zone.rect.width, zone.rect.height, zone.rotation ?? 0, projection, 0);
  let position = projection.screenToWorld(centerOf(zone.rect), 0);
  if (position && zone.kind === 'success') {
    // A column follows the table's depth axis, so all slots share world X.
    // Anchor it to the opposite waiting room's footprint, independent of pile
    // height. Perspective is allowed to slope this line on the screen.
    const zones = (snapshot ?? activeGeometry?.snapshot)?.zones;
    const waiting = zones?.find(candidate => candidate.kind === 'waiting' && candidate.side !== zone.side);
    const column = zones?.filter(candidate => candidate.kind === 'success' && candidate.side === zone.side)
      .sort((a, b) => centerOf(a.rect).y - centerOf(b.rect).y);
    const reference = waiting ?? column?.[Math.floor(column.length / 2)] ?? zone;
    const base = projection.screenToWorld(centerOf(reference.rect), 0);
    if (base) position = { ...position, x: base.x };
  }
  return position ? { position, ...getStage3dCardDimensions(zone.kind), rotation: zone.rotation ?? (zone.kind === 'live' || zone.kind === 'success' ? -90 : 0) } : null;
}
export function getStage3dSurfacePose(surface: Stage3dSurface, projection: Stage3dProjection,
  snapshot?: Stage3dSnapshot): Stage3dPose | null {
  const zone = (snapshot ?? activeGeometry?.snapshot)?.zones.find(candidate => candidate.key === surface.ownerZoneKey);
  const base = zone ? getStage3dZonePose(zone, projection, snapshot)?.position : projection.screenToWorld(centerOf(surface.rect), 0);
  if (!base) return null;
  const dimensions = getStage3dCardDimensions(surface.kind);
  const layer = surface.kind === 'member' || surface.kind === 'live' ? Math.max(0, surface.stackDepth - 1) : surface.stackDepth;
  return { position: { x: base.x, y: getStageCardFaceHeight(dimensions.width, dimensions.height, layer, surface.pileCount), z: base.z },
    ...dimensions, rotation: surface.rotation };
}
export function getStage3dProjectedQuad(pose: Stage3dPose, projection: Stage3dProjection): Stage3dQuad {
  const angle = pose.rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([x, z]) => {
    const u = x * pose.width / 2, v = z * pose.height / 2;
    return projection.worldToScreen({ x: pose.position.x + u * cos - v * sin, y: pose.position.y, z: pose.position.z + u * sin + v * cos });
  }) as unknown as Stage3dQuad;
}
export function isPointInStage3dQuad(point: Stage3dPoint, quad: Stage3dQuad): boolean {
  let positive = false, negative = false, area = 0;
  for (let index = 0; index < 4; index++) {
    const a = quad[index]!, b = quad[(index + 1) % 4]!;
    area += a.x * b.y - b.x * a.y;
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    if (cross > .001) positive = true;
    if (cross < -.001) negative = true;
  }
  return Math.abs(area) > .001 && !(positive && negative);
}

/** Project the actual DOM event surface, including corners outside its former layout rectangle. */
export function getStage3dDomMatrix(width: number, height: number, quad: Stage3dQuad): string | null {
  const corners = [[-width / 2, -height / 2], [width / 2, -height / 2], [width / 2, height / 2], [-width / 2, height / 2]];
  const rows: number[][] = [];
  corners.forEach(([x, y], i) => {
    const { x: u, y: v } = quad[i]!;
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u], [0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  });
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) if (Math.abs(rows[row]![col]!) > Math.abs(rows[pivot]![col]!)) pivot = row;
    if (Math.abs(rows[pivot]![col]!) < 1e-10) return null;
    [rows[col], rows[pivot]] = [rows[pivot]!, rows[col]!];
    const divisor = rows[col]![col]!;
    for (let index = col; index <= 8; index++) rows[col]![index] /= divisor;
    for (let row = 0; row < 8; row++) if (row !== col) {
      const factor = rows[row]![col]!;
      for (let index = col; index <= 8; index++) rows[row]![index] -= factor * rows[col]![index]!;
    }
  }
  const h = rows.map(row => row[8]!);
  return 'matrix3d(' + [h[0], h[3], 0, h[6], h[1], h[4], 0, h[7], 0, 0, 1, 0, h[2], h[5], 0, 1].map(value => Number(value).toFixed(9)).join(',') + ')';
}
function applyElementProjection(element: HTMLElement, quad: Stage3dQuad): boolean {
  const frame = sourceFrames.get(element);
  if (!frame) return false;
  const determinant = frame.a * frame.d - frame.b * frame.c;
  if (Math.abs(determinant) < 1e-8) return false;
  const localQuad = quad.map(point => {
    const dx = point.x - frame.center.x, dy = point.y - frame.center.y;
    return { x: (frame.d * dx - frame.c * dy) / determinant, y: (-frame.b * dx + frame.a * dy) / determinant };
  }) as unknown as Stage3dQuad;
  const matrix = getStage3dDomMatrix(frame.width, frame.height, localQuad);
  if (!matrix) return false;
  let saved = projectedElements.get(element);
  if (!saved) {
    saved = { transform: element.style.transform, transformOrigin: element.style.transformOrigin,
      clipPath: element.style.clipPath, pointerEvents: element.style.pointerEvents, appliedTransform: '' };
    projectedElements.set(element, saved);
  }
  const applied = (frame.transform ? frame.transform + ' ' : '') + matrix;
  if (element.style.transform !== applied) element.style.transform = applied;
  // CSSOM normalizes matrix strings; retain its serialization, not our input text.
  saved.appliedTransform = element.style.transform;
  element.style.transformOrigin = '50% 50%';
  element.style.clipPath = 'inset(0)';
  element.style.pointerEvents = 'auto';
  element.dataset.stage3dProjected = 'true';
  return true;
}
const guardEvents = ['pointerdown', 'click', 'dblclick', 'contextmenu'] as const;
export function applyStage3dSurfaceProjection(root: HTMLElement, surface: Stage3dSurface, quad: Stage3dQuad): void {
  const element = sourceElements.get(surface.key);
  if (!element || !root.contains(element) || !applyElementProjection(element, quad)) return;
  const dragHost = element.closest<HTMLElement>('[aria-roledescription="draggable"]') ?? element.querySelector<HTMLElement>('[aria-roledescription="draggable"]');
  if (!dragHost) return;
  const existing = dragGuards.get(surface.key);
  if (existing?.host === dragHost) { existing.quad = quad; return; }
  removeDragGuard(surface.key);
  // A deck's visible top/back layers can share one draggable. Retain its original
  // style once, and use the union of those lawful surfaces as the event boundary.
  const shared = [...dragGuards.values()].find(guard => guard.host === dragHost);
  const guard = { host: dragHost, quad, pointerEvents: shared?.pointerEvents ?? dragHost.style.pointerEvents,
    listener: shared?.listener ?? ((event: Event) => {
      const pointer = event as MouseEvent;
      const inside = [...dragGuards.values()].some(current => current.host === dragHost &&
        isPointInStage3dQuad({ x: pointer.clientX, y: pointer.clientY }, current.quad));
      if (!inside) { event.preventDefault(); event.stopPropagation(); }
    }) };
  dragGuards.set(surface.key, guard);
  // Disable only the obsolete outer rectangle. The projected card restores its own pointer events.
  if (!element.contains(dragHost)) dragHost.style.pointerEvents = 'none';
  if (!shared) for (const name of guardEvents) dragHost.addEventListener(name, guard.listener, true);
}
export function applyStage3dZoneProjection(root: HTMLElement, zone: Stage3dZone, quad: Stage3dQuad): void {
  const element = zoneElements.get(zone.key);
  if (element && root.contains(element)) {
    // Slot DOM already has landscape dimensions. Normalize the corner order so
    // its contents remain upright instead of inheriting the card's quarter turn.
    const ordered = [...quad].sort((a, b) => a.y - b.y);
    const top = ordered.slice(0, 2).sort((a, b) => a.x - b.x);
    const bottom = ordered.slice(2).sort((a, b) => a.x - b.x);
    applyElementProjection(element, [top[0]!, top[1]!, bottom[1]!, bottom[0]!]);
  }
}
/** Keep the scene and DOM takeover on the same set of physical slot frames. */
export function shouldRenderStage3dZone(zone: Stage3dZone): boolean {
  return zone.outlined || zone.kind === 'deck' || zone.kind === 'waiting';
}
function reconcileRenderedZoneElements(root: HTMLElement, rendered: ReadonlySet<HTMLElement>): void {
  for (const [element, owner] of renderedZoneElements) {
    if ((owner === root && !rendered.has(element)) || !element.isConnected) {
      delete element.dataset.stage3dZoneRendered;
      renderedZoneElements.delete(element);
    }
  }
  for (const element of rendered) {
    if (!root.contains(element)) continue;
    element.dataset.stage3dZoneRendered = 'true';
    renderedZoneElements.set(element, root);
  }
}
function removeDragGuard(key: string): void {
  const guard = dragGuards.get(key);
  if (!guard) return;
  dragGuards.delete(key);
  if ([...dragGuards.values()].some(current => current.host === guard.host)) return;
  for (const name of guardEvents) guard.host.removeEventListener(name, guard.listener, true);
  guard.host.style.pointerEvents = guard.pointerEvents;
}
function restoreElementProjection(element: HTMLElement): void {
  const saved = projectedElements.get(element);
  if (!saved) return;
  element.style.transform = saved.transform; element.style.transformOrigin = saved.transformOrigin;
  element.style.clipPath = saved.clipPath; element.style.pointerEvents = saved.pointerEvents;
  delete element.dataset.stage3dProjected;
  projectedElements.delete(element);
}
export function releaseStage3dSurfaceProjection(key: string): void {
  const element = sourceElements.get(key);
  if (element) restoreElementProjection(element);
  removeDragGuard(key);
}
export function releaseStage3dDomProjection(root: HTMLElement): void {
  reconcileRenderedZoneElements(root, new Set());
  for (const [element, owner] of zoneCaptions) if (owner.root === root) {
    restoreElementProjection(element); sourceFrames.delete(element); zoneCaptions.delete(element);
  }
  for (const [key, source] of zoneVisualElements) if (source.root === root) zoneVisualElements.delete(key);
  for (const [key, owner] of sourceRoots) if (owner === root) {
    const element = sourceElements.get(key)!;
    releaseStage3dSurfaceProjection(key); sourceFrames.delete(element); sourceElements.delete(key); sourceRoots.delete(key);
  }
  for (const [key, owner] of zoneRoots) if (owner === root) {
    const element = zoneElements.get(key)!;
    restoreElementProjection(element); sourceFrames.delete(element); zoneElements.delete(key); zoneRoots.delete(key);
  }
  for (const element of projectedElements.keys()) if (root.contains(element) || !element.isConnected) restoreElementProjection(element);
}
/** Reconcile after every layout read, even when the public snapshot is unchanged. */
export function reconcileStage3dDomProjection(root: HTMLElement, projection: Stage3dProjection, snapshot: Stage3dSnapshot,
  readySurfaces: ReadonlySet<string>): void {
  const renderedZones = new Set<HTMLElement>();
  for (const zone of snapshot.zones) {
    const pose = getStage3dZonePose(zone, projection, snapshot);
    if (pose) {
      applyStage3dZoneProjection(root, zone, getStage3dProjectedQuad(pose, projection));
      const source = zoneVisualElements.get(zone.key);
      if (shouldRenderStage3dZone(zone) && source?.root === root) {
        for (const element of source.elements) renderedZones.add(element);
      }
    } else {
      const element = zoneElements.get(zone.key);
      if (element) restoreElementProjection(element);
    }
  }
  // A shared LIVE/success droppable stays suppressed while any of its physical
  // slots is drawn. No artwork, choice badge or command node is hidden here.
  reconcileRenderedZoneElements(root, renderedZones);
  for (const [element, owner] of zoneCaptions) {
    if (owner.root !== root) continue;
    const zone = snapshot.zones.find(candidate => candidate.key === owner.zoneKey);
    const pose = zone && getStage3dZonePose(zone, projection, snapshot);
    const frame = sourceFrames.get(element);
    if (!pose || !frame || !zone || !shouldRenderStage3dZone(zone)) {
      restoreElementProjection(element); continue;
    }
    // Keep captions readable in screen space, anchored to the actual back edge
    // of the world slot rather than its obsolete CSS column.
    const edge = [...getStage3dProjectedQuad(pose, projection)].sort((a, b) => a.y - b.y).slice(0, 2);
    const centerX = (edge[0]!.x + edge[1]!.x) / 2;
    const bottom = Math.min(edge[0]!.y, edge[1]!.y) - 8;
    const halfWidth = frame.width / 2;
    const projected = applyElementProjection(element, [
      { x: centerX - halfWidth, y: bottom - frame.height }, { x: centerX + halfWidth, y: bottom - frame.height },
      { x: centerX + halfWidth, y: bottom }, { x: centerX - halfWidth, y: bottom },
    ]);
    if (projected) element.style.pointerEvents = 'none';
    else restoreElementProjection(element);
  }
  for (const surface of snapshot.surfaces) {
    const pose = getStage3dSurfacePose(surface, projection, snapshot);
    // A temporarily occluded card still owns its ready texture. Retain its
    // projected input and hidden DOM art before movement releases visibility.
    if (pose && readySurfaces.has(surface.key)) {
      applyStage3dSurfaceProjection(root, surface, getStage3dProjectedQuad(pose, projection));
    } else releaseStage3dSurfaceProjection(surface.key);
  }
}
export function installStage3dGeometry(root: HTMLElement, projection: Stage3dProjection, snapshot: Stage3dSnapshot): () => void {
  const geometry = { root, projection, snapshot }; activeGeometry = geometry;
  return () => { if (activeGeometry === geometry) activeGeometry = null; };
}
export function getStage3dGeometry(): Stage3dGeometry | null { return activeGeometry; }
export function hasStage3dTarget(targetId: string): boolean { return activeGeometry?.snapshot.zones.some(zone => zone.targetId === targetId) ?? false; }
export function resolveStage3dObjectPose(objectId: string): Stage3dResolvedSurface | null {
  const geometry = activeGeometry, surface = geometry?.snapshot.surfaces.find(candidate => candidate.objectId === objectId);
  if (!geometry || !surface) return null;
  const pose = getStage3dSurfacePose(surface, geometry.projection, geometry.snapshot);
  return pose ? { surface, pose, quad: getStage3dProjectedQuad(pose, geometry.projection), projection: geometry.projection } : null;
}
export function hitTestStage3dZones(point: Stage3dPoint, allowedTargetIds?: ReadonlySet<string>): string[] {
  const geometry = activeGeometry;
  if (!geometry) return [];
  const hits = geometry.snapshot.zones.flatMap(zone => {
    if (!zone.targetId || zone.disabled || allowedTargetIds && !allowedTargetIds.has(zone.targetId)) return [];
    const pose = getStage3dZonePose(zone, geometry.projection, geometry.snapshot);
    return pose && isPointInStage3dQuad(point, getStage3dProjectedQuad(pose, geometry.projection)) ? [zone.targetId] : [];
  });
  return [...new Set(hits)];
}
/** Public endpoint bridge used by move/drag presentation. No game-state or hidden-card lookup. */
export function resolveStage3dMovePose(objectId: string | null, zoneType: string, rect: Stage3dRect, endpoint: 'from' | 'to'): Stage3dPose | null {
  const geometry = activeGeometry;
  if (!geometry) return null;
  if (zoneType === 'HAND' || zoneType === 'INSPECTION_ZONE') {
    const width = Math.min(140, rect.width, rect.height / STAGE3D_CARD_ASPECT);
    return getStage3dScreenBridgePose(rect, width, width * STAGE3D_CARD_ASPECT, 0, geometry.projection);
  }
  const kind: Stage3dSurfaceKind = zoneType === 'LIVE_ZONE' ? 'live' : zoneType === 'SUCCESS_ZONE' ? 'success'
    : zoneType === 'WAITING_ROOM' ? 'waiting' : zoneType === 'ENERGY_ZONE' ? 'energy'
      : zoneType === 'MAIN_DECK' || zoneType === 'ENERGY_DECK' ? 'deck' : 'member';
  const center = centerOf(rect);
  const zones = geometry.snapshot.zones.filter(zone => zone.kind === kind);
  const zone = zones.sort((a, b) => Math.hypot(centerOf(a.rect).x - center.x, centerOf(a.rect).y - center.y) - Math.hypot(centerOf(b.rect).x - center.x, centerOf(b.rect).y - center.y))[0];
  if (objectId) {
    const resolved = resolveStage3dObjectPose(objectId);
    // Keep the full physical height of a still-present source, including its
    // underlays. A stale surface in another slot cannot be a move endpoint.
    if (resolved && resolved.surface.kind === kind &&
      (!zone || resolved.surface.ownerZoneKey === zone.key || !zone.outlined)) return resolved.pose;
  }
  if (zone) {
    const pose = getStage3dZonePose(zone, geometry.projection, geometry.snapshot);
    const dimensions = getStage3dCardDimensions(kind);
    const pileCount = zone.pileCount === undefined ? undefined : zone.pileCount + (endpoint === 'from' && objectId && resolveStage3dObjectPose(objectId)?.surface.kind !== kind ? 1 : 0);
    return pose ? { ...pose, ...dimensions, position: { ...pose.position, y: getStageCardFaceHeight(dimensions.width, dimensions.height, 0, pileCount) } } : null;
  }
  const position = geometry.projection.screenToWorld(center, 0);
  const dimensions = getStage3dCardDimensions(kind);
  return position ? { position: { ...position, y: getStageCardFaceHeight(dimensions.width, dimensions.height) }, ...dimensions, rotation: kind === 'live' || kind === 'success' ? -90 : 0 } : null;
}
