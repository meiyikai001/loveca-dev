import { describe, expect, it } from 'vitest';
import {
  interpolateRecoveryPose,
  recoveryPoseFromBounds,
} from '../../client/src/lib/recoveryCardMotion';

describe('recovery landing geometry', () => {
  const from = { left: 700, top: 400, width: 45, height: 63, rotation: 0 };
  it('lands on the current hand position after the effect panel closes', () => {
    const oldTarget = { left: 390, top: 760, width: 75, height: 105, rotation: 0 };
    const currentTarget = { left: 760, top: 760, width: 75, height: 105, rotation: 0 };
    expect(interpolateRecoveryPose(from, currentTarget, 1)).toEqual(currentTarget);
    expect(interpolateRecoveryPose(from, currentTarget, 0.9).left).toBeGreaterThan(
      interpolateRecoveryPose(from, oldTarget, 0.9).left
    );
    expect(interpolateRecoveryPose(from, currentTarget, 0)).toEqual(from);
    expect(interpolateRecoveryPose(from, currentTarget, 2)).toEqual(currentTarget);
  });
  it('covers most distance early, then settles without overshooting', () => {
    const target = { ...from, left: 100 };
    const fraction = (p: number) =>
      (interpolateRecoveryPose(from, target, p).left - from.left) / (target.left - from.left);
    expect(fraction(0.5)).toBeGreaterThan(0.65);
    expect(fraction(0.75) - fraction(0.5)).toBeLessThan(fraction(0.5) - fraction(0.25));
    const samples = Array.from({ length: 21 }, (_, i) => fraction(i / 20));
    expect(
      samples.every((value, i) => value >= 0 && value <= 1 && (i === 0 || value >= samples[i - 1]!))
    ).toBe(true);
  });
  it.each([-24, 0, 24])(
    'matches scaled fan geometry at %s degrees without using its inflated bounding box',
    (rotation) => {
      const width = 75 * 0.76,
        height = 105 * 0.76;
      const c = Math.abs(Math.cos((rotation * Math.PI) / 180));
      const s = Math.abs(Math.sin((rotation * Math.PI) / 180));
      const bw = width * c + height * s,
        bh = height * c + width * s;
      const pose = recoveryPoseFromBounds(
        { left: 500 - bw / 2, top: 800 - bh / 2, width: bw, height: bh },
        rotation
      );
      expect(pose.width).toBeCloseTo(width);
      expect(pose.height).toBeCloseTo(height);
      expect(pose.left + pose.width / 2).toBeCloseTo(500);
      expect(pose.top + pose.height / 2).toBeCloseTo(800);
      expect(interpolateRecoveryPose(from, pose, 1).rotation).toBe(rotation);
    }
  );
});
