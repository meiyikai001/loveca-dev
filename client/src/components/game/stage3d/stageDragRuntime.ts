import { getStage3dCardDimensions, getStage3dGeometry, getStage3dScreenBridgePose, resolveStage3dObjectPose } from './geometry';
import type { Stage3dPoint, Stage3dPose, Stage3dRect } from './types';

interface StageDrag {
  readonly token: number;
  readonly objectId: string;
  readonly imagePath: string;
  readonly screenOffset: Stage3dPoint;
  pose: Stage3dPose;
  released: boolean;
  ready: boolean;
}
let current: StageDrag | null = null;
let nextToken = 0;
let expiry: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());

/** Visual state only. Rule validation and commands remain in GameBoard's existing drag path. */
export const stageDragRuntime = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  isReady: () => current?.ready ?? false,
  get: () => current,
  begin(objectId: string, imagePath: string, center: Stage3dPoint, rotation = 0) {
    this.cancel();
    const geometry = getStage3dGeometry();
    const source = resolveStage3dObjectPose(objectId);
    const projectedCenter = source && geometry ? geometry.projection.worldToScreen(source.pose.position) : center;
    const position = geometry?.projection.screenToWorld(projectedCenter, Math.max(.65, (source?.pose.position.y ?? 0) + .2));
    if (!position) return;
    current = { token: ++nextToken, objectId, imagePath: source?.surface.imagePath ?? imagePath,
      screenOffset: { x: projectedCenter.x - center.x, y: projectedCenter.y - center.y },
      pose: { ...getStage3dCardDimensions('member'), ...source?.pose, position,
        rotation: source?.pose.rotation ?? rotation }, released: false, ready: false };
    notify();
  },
  move(center: Stage3dPoint) {
    if (!current || current.released) return;
    const position = getStage3dGeometry()?.projection.screenToWorld({
      x: center.x + current.screenOffset.x, y: center.y + current.screenOffset.y,
    }, current.pose.position.y);
    if (position) current.pose = { ...current.pose, position };
  },
  markReady(token: number) {
    if (current?.token !== token || current.ready) return;
    current.ready = true;
    notify();
  },
  release() {
    if (!current) return null;
    current.released = true;
    const token = current.token;
    const result = { objectId: current.objectId, pose: current.pose,
      consumed: () => { if (current?.token === token) this.cancel(); } };
    expiry = setTimeout(result.consumed, 250);
    return result;
  },
  clearInput() { if (!current?.released) this.cancel(); },
  cancel() {
    clearTimeout(expiry);
    expiry = undefined;
    if (!current) return;
    current = null;
    notify();
  },
};

/** Popup cards must remain above the popup; the table canvas sits underneath it. */
export function isStageUiDragSource(zone: string | null | undefined): boolean {
  return zone === 'INSPECTION_ZONE' || zone === 'RESOLUTION_ZONE';
}

/** Hand off the actually visible UI overlay at release, without moving rule state. */
export function createStageUiDrop(objectId: string, rect: Stage3dRect) {
  const geometry = getStage3dGeometry();
  if (!geometry || rect.width <= 0 || rect.height <= 0) return null;
  const pose = getStage3dScreenBridgePose(rect, rect.width, rect.height, 0, geometry.projection, .65);
  return pose ? { objectId, pose, consumed: () => {} } : null;
}
