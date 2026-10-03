import type { BattleAnimationRect } from './battleAnimationEvents';

export interface RecoveryCardPose extends BattleAnimationRect {
  readonly rotation: number;
}

/** The measured box includes the fan rotation. Recover the actual card dimensions. */
export function recoveryPoseFromBounds(
  bounds: BattleAnimationRect,
  rotation: number
): RecoveryCardPose {
  const radians = (rotation * Math.PI) / 180;
  const c = Math.abs(Math.cos(radians)),
    s = Math.abs(Math.sin(radians));
  const divisor = c * c - s * s;
  // Hand fans are bounded to 25 degrees. Unknown geometry uses the measured box.
  const w =
    Math.abs(divisor) > 0.1 ? (bounds.width * c - bounds.height * s) / divisor : bounds.width;
  const h =
    Math.abs(divisor) > 0.1 ? (bounds.height * c - bounds.width * s) / divisor : bounds.height;
  const width = w > 0 ? w : bounds.width,
    height = h > 0 ? h : bounds.height;
  return {
    left: bounds.left + (bounds.width - width) / 2,
    top: bounds.top + (bounds.height - height) / 2,
    width,
    height,
    rotation,
  };
}

/** Resolve only the already-rendered own hand; never identify an anonymous opponent card. */
export function measureRecoveryHandPose(objectId: string): RecoveryCardPose | null {
  const wrapper = Array.from(
    document.querySelectorAll<HTMLElement>('[data-recovery-hand-card]')
  ).find((node) => node.dataset.recoveryHandCard === objectId);
  const card = wrapper?.querySelector<HTMLElement>('[data-object-id]');
  if (!wrapper || !card) return null;
  const rect = card.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const matrix = new DOMMatrixReadOnly(getComputedStyle(wrapper).transform);
  return recoveryPoseFromBounds(rect, (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI);
}

/** A single continuous flight, ending exactly on the latest live hand pose. */
export function interpolateRecoveryPose(
  from: RecoveryCardPose,
  to: RecoveryCardPose,
  progress: number
): RecoveryCardPose {
  const p = Math.max(0, Math.min(1, progress));
  const t = Math.max(0, (p - 0.08) / 0.92);
  // Brief pickup, then a quick flight with a soft final approach.
  const flight = 1 - (1 - t) ** 2;
  const lift = Math.sin(Math.PI * flight) * 16 + Math.min(p / 0.08, 1) * (1 - flight) * 4;
  return {
    left: from.left + (to.left - from.left) * flight,
    top: from.top + (to.top - from.top) * flight - lift,
    width: from.width + (to.width - from.width) * flight,
    height: from.height + (to.height - from.height) * flight,
    rotation: from.rotation + (to.rotation - from.rotation) * flight,
  };
}
