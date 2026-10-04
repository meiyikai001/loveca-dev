import type { Stage3dPose } from './types';

export function isStageCardMove(fromZone: string, toZone: string) {
  const field = ['MEMBER_SLOT', 'LIVE_ZONE', 'SUCCESS_ZONE', 'ENERGY_ZONE', 'MAIN_DECK', 'ENERGY_DECK', 'WAITING_ROOM'];
  return field.includes(fromZone) || field.includes(toZone);
}

/** Flight and the settled mesh use one pose, including the exact terminal dimensions. */
export function sampleStageMove(from: Stage3dPose, to: Stage3dPose, elapsed: number, duration: number): Stage3dPose {
  const t = Math.max(0, Math.min(1, elapsed / Math.max(1, duration)));
  if (t === 1) return to;
  if (t === 0) return from;
  const p = 1 - (1 - t) ** 3;
  const mix = (a: number, b: number) => a + (b - a) * p;
  const angle = ((to.rotation - from.rotation + 540) % 360) - 180;
  return {
    position: {
      x: mix(from.position.x, to.position.x),
      // Ordinary moves settle directly from their actual starting elevation.
      // Adding a flight arc here makes a card already at its drop target bounce up again.
      y: mix(from.position.y, to.position.y),
      z: mix(from.position.z, to.position.z),
    },
    width: mix(from.width, to.width), height: mix(from.height, to.height),
    rotation: from.rotation + angle * p,
  };
}

/** A named object alone is not sufficient: its texture and exact final pose must be ready. */
export function stageCardPoseMatches(actual: Stage3dPose | undefined, expected: Stage3dPose): boolean {
  if (!actual) return false;
  const epsilon = 0.001;
  return Math.abs(actual.position.x - expected.position.x) < epsilon
    && Math.abs(actual.position.y - expected.position.y) < epsilon
    && Math.abs(actual.position.z - expected.position.z) < epsilon
    && Math.abs(actual.width - expected.width) < epsilon
    && Math.abs(actual.height - expected.height) < epsilon
    && Math.abs(((actual.rotation - expected.rotation + 540) % 360) - 180) < 0.01;
}
