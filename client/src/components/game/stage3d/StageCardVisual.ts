import {
    Color, ExtrudeGeometry, Group, LinearMipmapLinearFilter, Material, Mesh,
    MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial, Path, Shape,
    ShapeGeometry, SRGBColorSpace, Texture, TextureLoader,
} from 'three';
import type { Stage3dHighlight } from './types';

interface CardTextureEntry {
    texture: Texture;
    ready: Promise<Texture>;
    users: number;
    disposed: boolean;
}
export interface StageCardTextureLease {
    readonly ready: Promise<Texture>;
    /** Release once on unmount, finish, failure or cancellation, including while loading. */
    release(): void;
}
const cardTextures = new Map<string, CardTextureEntry>();

/** Only the currently permitted front/back URL may enter this presentation cache. */
export function acquireStageCardTexture(url: string): StageCardTextureLease {
    // DOM snapshots carry absolute currentSrc; animation requests may use the same
    // public image's relative path. Both presentations must retain the same texture.
    const key = typeof document === 'undefined' ? url : new URL(url, document.baseURI).href;
    let entry = cardTextures.get(key);
    if (!entry) {
        let resolve!: (texture: Texture) => void;
        let reject!: (error: Error) => void;
        const ready = new Promise<Texture>((accept, fail) => { resolve = accept; reject = fail; });
        const retained = { ready, users: 0, disposed: false } as CardTextureEntry;
        retained.texture = new TextureLoader().load(key, texture => {
            if (retained.disposed) texture.dispose();
            resolve(texture);
        }, undefined, () => reject(new Error('The visible card texture could not be loaded.')));
        retained.texture.colorSpace = SRGBColorSpace;
        retained.texture.anisotropy = 4;
        retained.texture.minFilter = LinearMipmapLinearFilter;
        entry = retained;
        cardTextures.set(key, entry);
    }
    const retained = entry;
    retained.users += 1;
    let released = false;
    return {
        ready: retained.ready,
        release() {
            if (released) return;
            released = true;
            retained.users -= 1;
            if (retained.users !== 0) return;
            retained.disposed = true;
            retained.texture.dispose();
            if (cardTextures.get(key) === retained) cardTextures.delete(key);
        },
    };
}

export function getStageCardThickness(width: number, height: number): number {
    return Math.max(0.004, Math.min(0.014, Math.min(width, height) * 0.0055));
}

function roundedRectangle(width: number, height: number, radius: number): Shape {
    const x = width / 2, y = height / 2, r = Math.min(radius, x, y);
    const shape = new Shape();
    shape.moveTo(-x + r, -y);
    shape.lineTo(x - r, -y); shape.quadraticCurveTo(x, -y, x, -y + r);
    shape.lineTo(x, y - r); shape.quadraticCurveTo(x, y, x - r, y);
    shape.lineTo(-x + r, y); shape.quadraticCurveTo(-x, y, -x, y - r);
    shape.lineTo(-x, -y + r); shape.quadraticCurveTo(-x, -y, -x + r, -y);
    shape.closePath();
    return shape;
}

/** Local XY geometry, with positive Z facing out of the card/table. */
export function createStageOutlineGeometry(width: number, height: number, radius: number, stroke: number): ShapeGeometry {
    const outer = roundedRectangle(width + stroke * 2, height + stroke * 2, radius + stroke);
    outer.holes.push(new Path(roundedRectangle(width, height, radius).getPoints(5)));
    return new ShapeGeometry(outer, 5);
}

interface StageCardVisualOptions {
    readonly width: number;
    readonly height: number;
    readonly texture: Texture;
    readonly selected?: boolean;
    readonly highlight?: Stage3dHighlight;
    /** Stacked surfaces are rendered individually; this never invents extra cards. */
    readonly stackDepth?: number;
}

/**
 * Shared by stationary, dragged and flying cards. Face is local XY at Z=0;
 * callers own world position/orientation. Texture ownership remains with its lease.
 */
export function createStageCardVisual({ width, height, texture, selected = false, highlight = 'none' }: StageCardVisualOptions): Group {
    const group = new Group();
    group.name = 'stage-card-visual';
    const radius = Math.min(width, height) * 0.027;
    const thickness = getStageCardThickness(width, height);
    const bevel = Math.min(0.0016, thickness * 0.18);
    const depth = thickness - bevel * 2;
    const bodyGeometry = new ExtrudeGeometry(roundedRectangle(width + 0.005, height + 0.005, radius), {
        depth, steps: 1, bevelEnabled: true, bevelThickness: bevel,
        bevelSize: bevel, bevelSegments: 1, curveSegments: 5,
    });
    // The physical top remains below the artwork: no coplanar front/body surfaces.
    bodyGeometry.translate(0, 0, -depth - bevel - 0.001);
    const body = new Mesh(bodyGeometry, new MeshStandardMaterial({
        color: selected ? '#d8bd92' : '#c9c3b8', roughness: 0.62, metalness: 0.025,
    }));
    body.name = 'stage-card-edge'; body.castShadow = true;
    group.add(body);

    const faceGeometry = new ShapeGeometry(roundedRectangle(width, height, radius), 5);
    const position = faceGeometry.getAttribute('position'), uv = faceGeometry.getAttribute('uv');
    for (let index = 0; index < position.count; index++) {
        uv.setXY(index, position.getX(index) / width + 0.5, position.getY(index) / height + 0.5);
    }
    uv.needsUpdate = true;
    const face = new Mesh(faceGeometry, new MeshPhysicalMaterial({
        map: texture,
        // A readable printed base plus a restrained lit component. Light changes remain
        // visible during a tilt without letting a backlit card lose its illustration.
        color: new Color(0.18, 0.18, 0.18), emissive: '#ffffff',
        emissiveMap: texture, emissiveIntensity: 0.82,
        roughness: 0.48, metalness: 0, ior: 1.35,
        clearcoat: 0.16, clearcoatRoughness: 0.34,
        toneMapped: false,
    }));
    face.name = 'stage-card-face';
    group.add(face);

    if (selected || highlight !== 'none') {
        const subtle = !selected && highlight === 'available';
        const color = selected ? '#f4d499' : highlight === 'limited' ? '#ce94ec'
            : highlight === 'actionable' ? '#83cfff' : '#799bac';
        const outline = new Mesh(
            createStageOutlineGeometry(width + 0.016, height + 0.016, radius + 0.008, Math.max(0.006, width * 0.005)),
            new MeshBasicMaterial({ color, transparent: true, opacity: subtle ? 0.4 : 0.85, depthWrite: false, toneMapped: false }),
        );
        outline.name = 'stage-card-ability'; outline.position.z = 0.002;
        group.add(outline);
    }
    return group;
}

/** Deliberately does not dispose mapped textures; their cache lease has a separate lifetime. */
export function disposeStageCardVisual(group: Group): void {
    group.removeFromParent();
    const materials = new Set<Material>();
    group.traverse(object => {
        if (!(object instanceof Mesh)) return;
        object.geometry.dispose();
        (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => materials.add(material));
    });
    materials.forEach(material => material.dispose());
}

/** Each effect setup owns a fresh attached visual, including StrictMode replay. */
export function mountStageCardVisual(parent: Group, create: () => Group, onReady?: (ready: boolean) => void): () => void {
    const visual = create();
    parent.add(visual);
    onReady?.(true);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        disposeStageCardVisual(visual);
        onReady?.(false);
    };
}
