import { Quaternion, Vector3, type Camera } from 'three';
import type { RecoveryCardPose } from '@/lib/recoveryCardMotion';
import {
  STAGE_RECOVERY_DURATION_MS, STAGE_RECOVERY_CHARGE_DURATION_MS,
  STAGE_RECOVERY_RISE_DURATION_MS, STAGE_RECOVERY_HOLD_DURATION_MS,
  RECOVERY_CARD_MOVE_DURATION_MS,
} from '@/lib/battleAnimationSequencing';
import type { Stage3dPose, Stage3dProjection, Stage3dRect } from './types';

const smooth = (a: number, b: number, t: number) => {
  const p = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return p * p * (3 - 2 * p);
};

/** Charge the pile, pop out into a steady hover, then fly to hand. */
export function sampleStageRecovery(from: Stage3dPose, to: Stage3dPose, elapsed: number, duration: number) {
  const t = Math.max(0, Math.min(1, elapsed / Math.max(1, duration)));
  const time = t * STAGE_RECOVERY_DURATION_MS;
  const launchAt = STAGE_RECOVERY_CHARGE_DURATION_MS + STAGE_RECOVERY_RISE_DURATION_MS + STAGE_RECOVERY_HOLD_DURATION_MS;
  const travel = Math.max(0, Math.min(1, (time - launchAt) / RECOVERY_CARD_MOVE_DURATION_MS));
  const flight = 1 - (1 - travel) ** 3;
  const riseProgress = Math.max(0, Math.min(1, (time - STAGE_RECOVERY_CHARGE_DURATION_MS) / STAGE_RECOVERY_RISE_DURATION_MS));
  // A quick release from the pile decelerates into a completely still hover.
  const rise = 1 - (1 - riseProgress) ** 3;
  const lift = from.width * rise * (1 - smooth(0, 1, travel));
  const hoverScale = 1 + .5 * rise;
  const mix = (a: number, b: number) => a + (b - a) * flight;
  const pose: Stage3dPose = t === 0 ? from : t === 1 ? to : {
    position: { x: mix(from.position.x, to.position.x), y: mix(from.position.y, to.position.y) + lift,
      z: mix(from.position.z, to.position.z) },
    width: mix(from.width * hoverScale, to.width), height: mix(from.height * hoverScale, to.height),
    rotation: from.rotation + (((to.rotation - from.rotation + 540) % 360) - 180) * flight,
  };
  return { pose, progress: t, riseProgress,
    popGlow: riseProgress > 0 && riseProgress < 1 ? Math.sin(Math.PI * riseProgress) : 0,
    flightProgress: travel, lift,
    sourceGlow: smooth(0, STAGE_RECOVERY_CHARGE_DURATION_MS, time) * (1 - smooth(launchAt - 50, launchAt, time)),
    bank: Math.sin(Math.PI * travel) * .30 * (to.position.x < from.position.x ? -1 : 1),
    handBlend: smooth(0, .95, travel) };
}

/** A camera-facing endpoint matches the live DOM hand, including its fan rotation. */
export function projectRecoveryHand(hand: RecoveryCardPose, camera: Camera,
  projection: Stage3dProjection, viewport: Stage3dRect) {
  if (hand.width <= 0 || hand.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return null;
  const centre = { x: hand.left + hand.width / 2, y: hand.top + hand.height / 2 };
  const world = projection.screenToWorld(centre, .8);
  if (!world) return null;
  const depth = new Vector3(world.x, world.y, world.z).project(camera).z;
  const unproject = (x: number, y: number) => new Vector3(
    (x - viewport.left) / viewport.width * 2 - 1, 1 - (y - viewport.top) / viewport.height * 2, depth
  ).unproject(camera);
  const position = unproject(centre.x, centre.y);
  const width = unproject(centre.x + hand.width / 2, centre.y).distanceTo(unproject(centre.x - hand.width / 2, centre.y));
  const height = unproject(centre.x, centre.y + hand.height / 2).distanceTo(unproject(centre.x, centre.y - hand.height / 2));
  const quaternion = camera.quaternion.clone()
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -hand.rotation * Math.PI / 180))
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2));
  return { pose: { position: { x: position.x, y: position.y, z: position.z }, width, height,
    rotation: hand.rotation } satisfies Stage3dPose, quaternion };
}
