import { describe, expect, it, vi } from 'vitest';
import { Group, Mesh, MeshPhysicalMaterial, Texture } from 'three';
import { createStageCardVisual, disposeStageCardVisual, getStageCardThickness, mountStageCardVisual } from './StageCardVisual';
import { getStageCardFaceHeight, getStagePileHeight, STAGE_FIELD_CARD_WIDTH } from './stageCardPhysical';

describe('stage card visual ownership', () => {
  it('keeps the raised frame below the next stacked card body', () => {
    const texture = new Texture();
    const width = STAGE_FIELD_CARD_WIDTH, height = width * 1.4;
    const card = createStageCardVisual({ width, height, texture });
    const body = (card.getObjectByName('stage-card-edge') as Mesh).geometry;
    const rim = (card.getObjectByName('stage-card-rim') as Mesh).geometry;
    body.computeBoundingBox(); rim.computeBoundingBox();
    const lowerTop = getStageCardFaceHeight(width, height, 0) + rim.boundingBox!.max.z;
    const upperBottom = getStageCardFaceHeight(width, height, 1) + body.boundingBox!.min.z;
    expect(upperBottom - lowerTop).toBeGreaterThan(.002);
    disposeStageCardVisual(card); texture.dispose();
  });

  it('keeps the faceted rim outside the complete print with inward and outward slopes', () => {
    const texture = new Texture();
    for (const width of [STAGE_FIELD_CARD_WIDTH, .7425, .3375]) {
      const height = width * 1.4, radius = width * .027;
      const card = createStageCardVisual({ width, height, texture });
      const geometry = (card.getObjectByName('stage-card-rim') as Mesh).geometry;
      const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal');
      const slopes: number[] = [];
      for (let index = 0; index < position.count; index++) {
        const x = position.getX(index), y = position.getY(index);
        const dx = Math.abs(x) - (width / 2 - radius), dy = Math.abs(y) - (height / 2 - radius);
        // Signed distance to the rounded print boundary, independent of the rim profile.
        expect(Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius).toBeGreaterThan(0);
        expect(normal.getZ(index)).toBeGreaterThan(0);
        slopes.push(x * normal.getX(index) + y * normal.getY(index));
      }
      expect(Math.min(...slopes)).toBeLessThan(0);
      expect(Math.max(...slopes)).toBeGreaterThan(0);
      disposeStageCardVisual(card);
    }
    texture.dispose();
  });

  it('tucks the body and its rounded corners inside the raised frame silhouette', () => {
    const texture = new Texture();
    for (const width of [STAGE_FIELD_CARD_WIDTH, .7425, .3375]) {
      const card = createStageCardVisual({ width, height: width * 1.4, texture });
      const body = (card.getObjectByName('stage-card-edge') as Mesh).geometry.getAttribute('position');
      const rim = (card.getObjectByName('stage-card-rim') as Mesh).geometry.getAttribute('position');
      // Include diagonal support lines: AABBs alone cannot detect the corner wedges.
      for (let step = 0; step < 32; step++) {
        const angle = step * Math.PI / 16, x = Math.cos(angle), y = Math.sin(angle);
        let bodyExtent = -Infinity, rimExtent = -Infinity;
        for (let index = 0; index < body.count; index++) {
          bodyExtent = Math.max(bodyExtent, body.getX(index) * x + body.getY(index) * y);
        }
        for (let index = 0; index < rim.count; index++) {
          rimExtent = Math.max(rimExtent, rim.getX(index) * x + rim.getY(index) * y);
        }
        expect(bodyExtent).toBeLessThan(rimExtent);
      }
      disposeStageCardVisual(card);
    }
    texture.dispose();
  });

  it('recreates one attached framed card after StrictMode setup, cleanup and setup', () => {
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
    const materialsDisposed = firstMeshes.flatMap(mesh => Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(material => {
      const disposed = vi.fn();
      material.addEventListener('dispose', disposed);
      return disposed;
    });
    expect(firstMeshes.map(mesh => mesh.name)).toEqual(['stage-card-edge', 'stage-card-rim', 'stage-card-face', 'stage-card-ability']);
    expect(ready.mock.calls).toEqual([[true]]);

    firstCleanup();
    expect(parent.children).toHaveLength(0);
    expect(geometriesDisposed.every(disposed => disposed.mock.calls.length === 1)).toBe(true);
    expect(materialsDisposed.every(disposed => disposed.mock.calls.length === 1)).toBe(true);
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
    const face = second.getObjectByName('stage-card-face') as Mesh;
    face.geometry.computeBoundingBox();
    expect(face.geometry.boundingBox!.max.x - face.geometry.boundingBox!.min.x).toBeCloseTo(1.5);
    expect(face.geometry.boundingBox!.max.y - face.geometry.boundingBox!.min.y).toBeCloseTo(2.1);
    const print = face.material as MeshPhysicalMaterial;
    expect(print.map).toBe(texture);
    expect(print.emissiveMap).toBe(texture);
    // The binding surrounds a complete print and stays a narrow card edge.
    const rim = (second.getObjectByName('stage-card-rim') as Mesh).geometry;
    rim.computeBoundingBox();
    expect(rim.boundingBox!.max.x).toBeGreaterThan(face.geometry.boundingBox!.max.x);
    expect(rim.boundingBox!.max.y).toBeGreaterThan(face.geometry.boundingBox!.max.y);
    expect(edge.boundingBox!.max.x - edge.boundingBox!.min.x).toBeLessThan(1.5 * 1.065);
    // A raised inner/outer bevel provides volume without a thick slab under the print.
    expect(rim.boundingBox!.max.z).toBeGreaterThan(face.geometry.boundingBox!.max.z);
    expect(rim.boundingBox!.max.z - rim.boundingBox!.min.z).toBeGreaterThan(.005);
    expect(getStageCardThickness(1.5, 2.1)).toBeLessThan(1.5 * .025);

    // A repeated old cleanup must not remove the replacement or mark it unready.
    firstCleanup();
    expect(parent.children).toEqual([second]);
    expect(ready.mock.calls).toEqual([[true], [false], [true]]);
    secondCleanup();
    secondCleanup();
    expect(parent.children).toHaveLength(0);
    expect(ready.mock.calls).toEqual([[true], [false], [true], [false]]);
    expect(materialsDisposed.every(disposed => disposed.mock.calls.length === 1)).toBe(true);
    expect(textureDisposed).not.toHaveBeenCalled();
    texture.dispose();
  });

  it('keeps public piles on the floor with one lawful artwork face and bounded paper geometry', () => {
    const texture = new Texture();
    const width = .7425, height = width * 1.4;
    let previous = -1;
    for (const count of [0, 1, 5, 20, 60]) {
      const pile = createStageCardVisual({ width, height, texture, pileCount: count });
      const thickness = getStagePileHeight(count, width, height);
      expect(thickness).toBeGreaterThan(previous);
      previous = thickness;
      if (count === 0) {
        expect(pile.children).toHaveLength(0);
      } else {
        const body = pile.getObjectByName('stage-card-edge') as Mesh;
        body.geometry.computeBoundingBox();
        const bounds = body.geometry.boundingBox!;
        expect(bounds.max.z - bounds.min.z).toBeCloseTo(thickness);
        // XY artwork becomes XZ on the table; local +Z is world +Y.
        expect(getStageCardFaceHeight(width, height, 0, count) + bounds.min.z).toBeCloseTo(.002);
        expect(pile.children.filter(child => child.name === 'stage-card-face')).toHaveLength(1);
        expect(pile.children).toHaveLength(3);
      }
      disposeStageCardVisual(pile);
    }
    texture.dispose();
  });
});
