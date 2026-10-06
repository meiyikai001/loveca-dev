import { describe, expect, it, vi } from 'vitest';
import { Mesh, ShaderMaterial, PerspectiveCamera, Plane, Quaternion, Raycaster, Texture, Vector2, Vector3 } from 'three';
import { projectRecoveryHand, sampleStageRecovery } from './stageRecoveryMotion';
import { createStageRecoveryArt } from './StageRecoveryArt';
import { STAGE_RECOVERY_DURATION_MS as duration, STAGE_RECOVERY_RISE_DURATION_MS as rise,
  STAGE_RECOVERY_CHARGE_DURATION_MS as charge,
  STAGE_RECOVERY_HOLD_DURATION_MS as hold } from '@/lib/battleAnimationSequencing';
import type { Stage3dPose } from './types';

const from: Stage3dPose = { position: { x: 5, y: .25, z: 1 }, width: .74, height: 1.036, rotation: 0 };
const to: Stage3dPose = { position: { x: -2, y: .8, z: 7 }, width: 1.4, height: 1.96, rotation: -18 };
const hoverAt = charge + rise;

describe('recovery from a pile into the current hand', () => {
  it('lifts before travelling, keeps exact endpoints and settles after a delayed frame', () => {
    expect(sampleStageRecovery(from, to, 0, duration).pose).toBe(from);
    expect(sampleStageRecovery(from, to, charge / 2, duration).pose).toEqual(from);
    const pickup = sampleStageRecovery(from, to, charge + 40, duration);
    expect(pickup.pose.position.x).toBe(from.position.x);
    expect(pickup.pose.position.z).toBe(from.position.z);
    expect(pickup.pose.position.y).toBeGreaterThan(from.position.y);
    expect(sampleStageRecovery(from, to, duration, duration).pose).toBe(to);
    expect(sampleStageRecovery(from, to, 2000, duration).pose).toBe(to);
    let lastX = from.position.x;
    for (let elapsed = 0; elapsed <= duration; elapsed += 10) {
      const frame = sampleStageRecovery(from, to, elapsed, duration);
      expect(frame.pose.position.x).toBeLessThanOrEqual(lastX);
      expect(frame.pose.position.x).toBeGreaterThanOrEqual(to.position.x);
      expect(frame.lift).toBeGreaterThanOrEqual(0);
      lastX = frame.pose.position.x;
    }
    const movedHand = { ...to, position: { ...to.position, x: 3 } };
    expect(sampleStageRecovery(from, movedHand, duration, duration).pose).toBe(movedHand);
  });

  it('holds the card at 1.5x size for 400ms and switches off the source before flying', () => {
    expect(hold).toBe(400);
    const floating = sampleStageRecovery(from, to, hoverAt, duration);
    expect(floating.pose.position.y).toBeGreaterThan(from.position.y);
    expect(floating.pose.width).toBeCloseTo(from.width * 1.5);
    expect(floating.pose.height).toBeCloseTo(from.height * 1.5);
    for (let elapsed = hoverAt; elapsed <= hoverAt + hold; elapsed += 10) {
      const frame = sampleStageRecovery(from, to, elapsed, duration);
      expect(frame.pose).toEqual(floating.pose);
      expect(frame.bank).toBeCloseTo(0, 10);
      expect(frame.handBlend).toBe(0);
      expect(frame.flightProgress).toBe(0);
    }
    expect(sampleStageRecovery(from, to, hoverAt + hold / 2, duration).sourceGlow).toBe(1);
    const launch = sampleStageRecovery(from, to, hoverAt + hold, duration);
    expect(launch.sourceGlow).toBe(0);
    const flight = sampleStageRecovery(from, to, hoverAt + hold + 20, duration);
    expect(flight.pose.position.x).toBeLessThan(from.position.x);
    expect(flight.sourceGlow).toBe(0);
  });

  it.each([-24, 0, 24])('projects all four terminal corners onto a %s° DOM hand in wide and narrow views', rotation => {
    for (const viewport of [{ left: 20, top: 30, width: 1600, height: 900 }, { left: 0, top: 55, width: 850, height: 898 }]) {
      const camera = new PerspectiveCamera(32, viewport.width / viewport.height, 1, 120);
      camera.position.set(0, 20, 12); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
      const projection = {
        worldToScreen(point: { x: number; y: number; z: number }) {
          const p = new Vector3(point.x, point.y, point.z).project(camera);
          return { x: viewport.left + (p.x + 1) * viewport.width / 2, y: viewport.top + (1 - p.y) * viewport.height / 2 };
        },
        screenToWorld(point: { x: number; y: number }, height = 0) {
          const ray = new Raycaster();
          ray.setFromCamera(new Vector2((point.x - viewport.left) / viewport.width * 2 - 1, 1 - (point.y - viewport.top) / viewport.height * 2), camera);
          return ray.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), -height), new Vector3());
        },
      };
      const hand = { left: viewport.width * .35, top: viewport.height * .81, width: 92, height: 128.8, rotation };
      const result = projectRecoveryHand(hand, camera, projection, viewport)!;
      const theta = rotation * Math.PI / 180;
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
        const point = new Vector3(sx * result.pose.width / 2, 0, sy * result.pose.height / 2)
          .applyQuaternion(result.quaternion).add(new Vector3(result.pose.position.x, result.pose.position.y, result.pose.position.z));
        const screen = projection.worldToScreen(point), x = sx * hand.width / 2, y = sy * hand.height / 2;
        expect(screen.x).toBeCloseTo(hand.left + hand.width / 2 + x * Math.cos(theta) - y * Math.sin(theta), 5);
        expect(screen.y).toBeCloseTo(hand.top + hand.height / 2 + x * Math.sin(theta) + y * Math.cos(theta), 5);
      }
      expect(projectRecoveryHand({ ...hand, width: 0 }, camera, projection, viewport)).toBeNull();
    }
  });

  it('removes the flight decorations without disposing the shared glow texture', () => {
    const glow = new Texture(), sharedDisposed = vi.spyOn(glow, 'dispose');
    const effect = createStageRecoveryArt(glow, from);
    const resources: ReturnType<typeof vi.fn>[] = [];
    effect.group.traverse(object => {
      if (object instanceof Mesh) {
        resources.push(vi.spyOn(object.geometry, 'dispose'), vi.spyOn(object.material, 'dispose'));
      }
    });
    effect.update(from, to, new Quaternion(), charge + rise / 2, duration);
    expect(effect.group.visible).toBe(true);
    const sourceGlow = effect.group.getObjectByName('recovery-source-glow') as Mesh;
    const trail = effect.group.getObjectByName('recovery-flight-trail') as Mesh;
    const shaft = effect.group.getObjectByName('recovery-pop-shaft') as Mesh;
    expect(shaft.visible).toBe(true);
    expect((shaft.material as ShaderMaterial).uniforms.opacity.value).toBeGreaterThan(.5);
    expect((trail.material as ShaderMaterial).uniforms.opacity.value).toBeGreaterThan(0);
    effect.update(from, to, new Quaternion(), hoverAt + hold / 2, duration);
    expect((sourceGlow.material as ShaderMaterial).uniforms.opacity.value).toBe(1);
    expect((trail.material as ShaderMaterial).uniforms.opacity.value).toBe(0);
    effect.update(from, to, new Quaternion(), hoverAt + hold + 100, duration);
    expect((sourceGlow.material as ShaderMaterial).uniforms.opacity.value).toBe(0);
    expect(shaft.visible).toBe(false);
    expect((trail.material as ShaderMaterial).uniforms.opacity.value).toBeGreaterThan(0);
    effect.group.traverse(object => {
      if (object instanceof Mesh) {
        expect(Array.from(object.geometry.getAttribute('position').array).every(Number.isFinite)).toBe(true);
      }
    });
    effect.update(from, to, new Quaternion(), duration, duration);
    expect(effect.group.visible).toBe(false);
    effect.dispose();
    expect(resources.every(resource => resource.mock.calls.length === 1)).toBe(true);
    expect(sharedDisposed).not.toHaveBeenCalled();
    glow.dispose();
  });
});
