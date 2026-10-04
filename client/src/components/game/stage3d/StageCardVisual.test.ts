import { describe, expect, it, vi } from 'vitest';
import { Group, Mesh, Texture } from 'three';
import { createStageCardVisual, getStageCardThickness, mountStageCardVisual } from './StageCardVisual';

describe('stage card visual ownership', () => {
  it('recreates one attached thick card after StrictMode setup, cleanup and setup', () => {
    const parent = new Group();
    const texture = new Texture();
    const textureDisposed = vi.fn();
    texture.addEventListener('dispose', textureDisposed);
    const ready = vi.fn();
    const create = () => createStageCardVisual({ width: 1.5, height: 2.1, texture, highlight: 'actionable' });
    const firstCleanup = mountStageCardVisual(parent, create, ready);
    const first = parent.children[0] as Group;
    const firstMeshes = first.children as Mesh[];
    const geometriesDisposed = firstMeshes.map(mesh => {
      const disposed = vi.fn();
      mesh.geometry.addEventListener('dispose', disposed);
      return disposed;
    });
    expect(firstMeshes.map(mesh => mesh.name)).toEqual(['stage-card-edge', 'stage-card-face', 'stage-card-ability']);
    expect(ready.mock.calls).toEqual([[true]]);

    firstCleanup();
    expect(parent.children).toHaveLength(0);
    expect(geometriesDisposed.every(disposed => disposed.mock.calls.length === 1)).toBe(true);
    const secondCleanup = mountStageCardVisual(parent, create, ready);
    const second = parent.children[0] as Group;
    expect(parent.children).toHaveLength(1);
    expect(second).not.toBe(first);
    expect(second.children.map(mesh => mesh.name)).toEqual(firstMeshes.map(mesh => mesh.name));
    expect((second.children[0] as Mesh).geometry).not.toBe(firstMeshes[0].geometry);
    const edge = (second.children[0] as Mesh).geometry;
    edge.computeBoundingBox();
    expect(edge.boundingBox!.max.z).toBeLessThan(0);
    expect(edge.boundingBox!.max.z - edge.boundingBox!.min.z).toBeCloseTo(getStageCardThickness(1.5, 2.1));

    // A repeated old cleanup must not remove the replacement or mark it unready.
    firstCleanup();
    expect(parent.children).toEqual([second]);
    expect(ready.mock.calls).toEqual([[true], [false], [true]]);
    secondCleanup();
    secondCleanup();
    expect(parent.children).toHaveLength(0);
    expect(ready.mock.calls).toEqual([[true], [false], [true], [false]]);
    expect(textureDisposed).not.toHaveBeenCalled();
    texture.dispose();
  });
});
