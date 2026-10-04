import type { EffectFeedbackPublicEvent, EffectFeedbackTarget } from '@game/online';
import type { EntranceStageTarget } from '@/lib/cardEntranceLanding';
import type { BattleAnimationEvent } from '@/lib/battleAnimationEvents';
import type { Stage3dPose } from './types';

export interface StageLandingRequest {
  readonly id: string;
  readonly target: EntranceStageTarget;
  readonly imagePath: string;
  readonly fromPose?: Stage3dPose;
  readonly onSourceConsumed?: () => void;
}
export interface StageMoveRequest {
  readonly event: Extract<BattleAnimationEvent, { kind: 'CARD_MOVE' }>;
  readonly imagePath: string;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly fromPose?: Stage3dPose;
  readonly onSourceConsumed?: () => void;
}
export interface StageGainRequest {
  readonly id: string;
  readonly event: EffectFeedbackPublicEvent;
  readonly target: EffectFeedbackTarget;
  readonly source: boolean;
  readonly startedAt: number;
  readonly endsAt: number;
}
export type StageGainStyle = 'stage' | 'soft';
export interface StageVfxDriver {
  playMove(request: StageMoveRequest, onArrive: () => void, onDone: () => void): (() => void) | null;
  playLanding(
    presentation: StageLandingRequest,
    startedAt: number,
    onImpact: () => void,
    onDone: () => void
  ): () => void;
  playGain(request: StageGainRequest): () => void;
}

let driver: StageVfxDriver | null = null;
let gainStyle: StageGainStyle = 'stage';
type DropPose = { pose: Stage3dPose; expiresAt: number; release: () => void; timer: ReturnType<typeof setTimeout> };
const dropPoses = new Map<string, DropPose>();
const now = () => globalThis.performance?.now() ?? Date.now();
function clearDropPoses() {
  for (const entry of dropPoses.values()) { clearTimeout(entry.timer); entry.release(); }
  dropPoses.clear();
}
function takeDropPose(objectId: string): { fromPose?: Stage3dPose; onSourceConsumed?: () => void } {
  const entry = dropPoses.get(objectId);
  dropPoses.delete(objectId);
  if (!entry) return {};
  clearTimeout(entry.timer);
  if (entry.expiresAt < now()) { entry.release(); return {}; }
  return { fromPose: entry.pose, onSourceConsumed: entry.release };
}

/** A presentation-only bridge. It never reads a game session or emits a command. */
export const stageVfxRuntime = {
  get active() {
    return driver !== null;
  },
  install(next: StageVfxDriver) {
    driver = next;
    return () => {
      if (driver === next) { driver = null; clearDropPoses(); }
    };
  },
  getGainStyle: () => gainStyle,
  setGainStyle(style: StageGainStyle) {
    gainStyle = style;
  },
  retainDropPose(objectId: string, pose: Stage3dPose, onConsumed?: () => void) {
    clearDropPoses();
    let released = false;
    const release = () => { if (!released) { released = true; onConsumed?.(); } };
    const timer = setTimeout(() => { if (dropPoses.get(objectId)?.release === release) dropPoses.delete(objectId); release(); }, 600);
    dropPoses.set(objectId, { pose: { ...pose, position: { ...pose.position } }, expiresAt: now() + 600, release, timer });
  },
  clearDropPose() { clearDropPoses(); },
  /** Claim on the authoritative entrance before portrait assets start loading. */
  claimDropPose(objectId: string) { return takeDropPose(objectId); },
  playMove(request: StageMoveRequest, onArrive: () => void, onDone: () => void) {
    if (!driver) return null;
    const source = request.fromPose ? {} : takeDropPose(request.event.render.objectId);
    const cancel = driver.playMove({ ...request, ...source }, onArrive, onDone);
    if (!cancel) source.onSourceConsumed?.();
    return cancel;
  },
  playLanding(
    presentation: StageLandingRequest,
    startedAt: number,
    onImpact: () => void,
    onDone: () => void
  ) {
    if (!driver) return null;
    return driver.playLanding({ ...presentation, ...(presentation.fromPose ? {} : takeDropPose(presentation.target.objectId)) }, startedAt, onImpact, onDone);
  },
  playGain(request: StageGainRequest) {
    return driver?.playGain(request) ?? null;
  },
};
