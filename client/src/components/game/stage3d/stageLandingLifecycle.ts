import { entranceTimeline } from '@/lib/cardEntranceTimeline';
import { getLandingFlightFrame } from '@/lib/cardEntranceLanding';

/** Keep the approved visible near-card response without lifting the far row equally. */
export function getStageNeighborPeakAngle(strength: number) {
  return Math.min(46, 52 * Math.max(0, Math.min(1, strength)) ** 2);
}

/** The stage and portrait share one monotonic clock, including delayed browser frames. */
export function sampleStageLanding(now: number, startedAt: number) {
  const elapsed = Math.max(0, now - startedAt);
  const flightTime = elapsed - entranceTimeline.landingAt;
  return {
    waiting: flightTime < 0,
    flight: getLandingFlightFrame(
      Math.max(0, flightTime),
      entranceTimeline.travel,
      entranceTimeline.press
    ),
    impactElapsed: Math.max(0, flightTime - entranceTimeline.flight),
    complete: elapsed >= entranceTimeline.total,
  };
}

/** Late loader/frame callbacks cannot release a replaced presentation's ownership. */
export function createStageLandingSignals(onImpact: () => void, onDone: () => void) {
  let ended = false;
  let impacted = false;
  return {
    impact() {
      if (ended || impacted) return;
      impacted = true;
      onImpact();
    },
    complete() {
      if (ended) return;
      ended = true;
      onDone();
    },
    cancel() {
      ended = true;
    },
  };
}
