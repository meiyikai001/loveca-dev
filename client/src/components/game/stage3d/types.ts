/** Presentation-only geometry. No authority state or hidden card identities belong here. */
export interface Stage3dPoint { readonly x: number; readonly y: number }
export interface Stage3dVector { readonly x: number; readonly y: number; readonly z: number }
export interface Stage3dRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}
export type Stage3dQuad = readonly [Stage3dPoint, Stage3dPoint, Stage3dPoint, Stage3dPoint];
export type Stage3dSurfaceKind = 'member' | 'live' | 'success' | 'energy' | 'deck' | 'waiting' | 'stack';
export type Stage3dSide = 'self' | 'opponent';
export type Stage3dHighlight = 'limited' | 'actionable' | 'available' | 'none';
export type Stage3dZoneState = 'idle' | 'suggested' | 'active' | 'selectable';

export interface Stage3dSurface {
  readonly key: string;
  /** Null for anonymous backs. Do not synthesize an identity from a private card. */
  readonly objectId: string | null;
  /** Only the URL of the currently permitted, rendered front or back image. */
  readonly imagePath: string;
  readonly rect: Stage3dRect;
  /** Stable slot anchor. A member/LIVE card and its outline use this exact world pose. */
  readonly ownerZoneKey?: string | null;
  /** Displayed dimensions before planar rotation; measured from layout, never inverted from AABB. */
  readonly width: number;
  readonly height: number;
  /** Clockwise degrees on the table, including the explicit LIVE layout quarter turn. */
  readonly rotation: number;
  readonly faceUp: boolean;
  readonly kind: Stage3dSurfaceKind;
  readonly side: Stage3dSide;
  readonly stackDepth: number;
  readonly visible: boolean;
  readonly selected: boolean;
  /** available mirrors the existing automated-effect marker, not command availability. */
  readonly highlight?: Stage3dHighlight;
}

export interface Stage3dZone {
  readonly key: string;
  readonly targetId: string | null;
  readonly anchor: string | null;
  readonly rect: Stage3dRect;
  readonly kind: Stage3dSurfaceKind;
  readonly side: Stage3dSide;
  readonly occupied: boolean;
  readonly rotation?: number;
  readonly outlined?: boolean;
  readonly state?: Stage3dZoneState;
  readonly disabled?: boolean;
}

export interface Stage3dSnapshot {
  readonly viewport: Stage3dRect;
  readonly surfaces: readonly Stage3dSurface[];
  readonly zones: readonly Stage3dZone[];
}

/** World x is right, y is elevation, +z is the near side of the stage. */
export interface Stage3dPose {
  readonly position: Stage3dVector;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
}

/** All screen points are absolute client pixels, not canvas-local or device pixels. */
export interface Stage3dProjection {
  worldToScreen(point: Stage3dVector): Stage3dPoint;
  screenToWorld(point: Stage3dPoint, height?: number): Stage3dVector | null;
}

export interface Stage3dGeometry {
  readonly root: HTMLElement;
  readonly projection: Stage3dProjection;
  readonly snapshot: Stage3dSnapshot;
}

export interface Stage3dResolvedSurface {
  readonly surface: Stage3dSurface;
  readonly pose: Stage3dPose;
  readonly quad: Stage3dQuad;
  readonly projection: Stage3dProjection;
}
