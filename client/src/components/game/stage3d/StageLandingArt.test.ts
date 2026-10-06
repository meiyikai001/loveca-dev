import { describe, expect, it, vi } from 'vitest';
import { Mesh, PointLight, Scene, Sprite, Texture } from 'three';
import { entranceTimeline } from '@/lib/cardEntranceTimeline';
import { createStageLandingArt, sampleStageLandingLight } from './StageLandingArt';

describe('stage welcome lighting', () => {
  it('stays dark until contact, peaks on contact and clears within the shared timeline', () => {
    const contact = entranceTimeline.flight;
    for (const time of [-1, 0, contact - 80, contact - 1]) {
      const approach = sampleStageLandingLight(time);
      expect(approach.visible).toBe(false);
      expect(approach.pool + approach.beam + approach.rim).toBe(0);
      expect(approach.sparks).toBe(0);
    }
    const impact = sampleStageLandingLight(contact);
    expect(impact.visible).toBe(true);
    expect(impact.pool).toBeGreaterThan(0);
    expect(impact.beam).toBeGreaterThan(0);
    expect(impact.rim).toBe(1);
    expect(sampleStageLandingLight(contact + 200).rim).toBe(0);
    for (const time of [contact + entranceTimeline.impactDuration, contact + 2000]) {
      const end = sampleStageLandingLight(time);
      expect(end.visible).toBe(false);
      expect(end.pool + end.beam + end.rim).toBe(0);
      expect(end.sparks).toBe(1);
    }
  });

  it('removes local light and particles on cancellation without releasing the shared glow', () => {
    const texture = new Texture(), sharedDisposed = vi.spyOn(texture, 'dispose');
    const art = createStageLandingArt(1.4, 1.96, texture), scene = new Scene();
    scene.add(art.group);
    const disposed: ReturnType<typeof vi.fn>[] = [];
    art.group.traverse(object => {
      if (object instanceof Mesh) disposed.push(vi.spyOn(object.geometry, 'dispose'));
      if (object instanceof Mesh || object instanceof Sprite) disposed.push(vi.spyOn(object.material, 'dispose'));
    });
    art.update({ position: { x: 3, y: .03, z: 2 }, width: 1.4, height: 1.96, rotation: 90 }, entranceTimeline.flight + 60);
    expect(art.group.position.toArray()).toEqual([3, 0, 2]);
    expect(art.group.rotation.y).toBeCloseTo(-Math.PI / 2);
    let activeLight = false, visibleFlecks = 0;
    scene.traverse(object => {
      if (object instanceof PointLight) activeLight ||= object.intensity > 0;
      if (object instanceof Sprite && object.material.opacity > 0) visibleFlecks++;
    });
    expect(activeLight).toBe(true);
    expect(visibleFlecks).toBe(12);
    art.dispose();
    expect(scene.children).toHaveLength(0);
    expect(disposed.every(spy => spy.mock.calls.length === 1)).toBe(true);
    expect(sharedDisposed).not.toHaveBeenCalled();
    texture.dispose();
  });
});
