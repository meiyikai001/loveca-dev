import {
    Color, ExtrudeGeometry, Group, LinearMipmapLinearFilter, Material, Mesh,
    MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial, Path, Shape,
    ShapeGeometry, SRGBColorSpace, Texture, TextureLoader,
} from 'three';
import type { Stage3dHighlight } from './types';
import { getStageCardThickness, getStagePileHeight } from './stageCardPhysical';
export { getStageCardThickness } from './stageCardPhysical';

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
    /** One neutral body and one lawful top face represent this public zone count. */
    readonly pileCount?: number;
}

/** A lit paper core and dark lower laminate give a card volume without a metal frame. */
function createCardSideMaterial(width: number, height: number, thickness: number, pileCount?: number): MeshStandardMaterial {
    const material = new MeshStandardMaterial({ color: pileCount && pileCount > 1 ? '#777d88' : '#c7bda7', roughness: .64, metalness: 0 });
    const topThickness = getStageCardThickness(width, height);
    material.onBeforeCompile = shader => {
        shader.uniforms.uStagePaperTop = { value: topThickness };
        shader.uniforms.uStageBodyDepth = { value: thickness };
        shader.uniforms.uStagePaperDepth = { value: Math.max(.001, thickness - topThickness) };
        shader.uniforms.uStagePaperBands = { value: Math.min(12, Math.max(0, (pileCount ?? 1) - 1)) };
        shader.uniforms.uStagePaperLight = { value: new Color('#c6c3bc') };
        shader.uniforms.uStageSingleCore = { value: new Color('#c7bda7') };
        shader.uniforms.uStageLaminate = { value: new Color('#3d3d47') };
        shader.vertexShader = shader.vertexShader.replace('#include <common>',
            '#include <common>\nvarying float vStagePaperDepth;').replace('#include <begin_vertex>',
            '#include <begin_vertex>\nvStagePaperDepth = -transformed.z - 0.001;');
        shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
varying float vStagePaperDepth;
uniform float uStagePaperTop;
uniform float uStageBodyDepth;
uniform float uStagePaperDepth;
uniform float uStagePaperBands;
uniform vec3 uStagePaperLight;
uniform vec3 uStageSingleCore;
uniform vec3 uStageLaminate;
`).replace('#include <color_fragment>', `#include <color_fragment>
float topCardCore = 1.0 - smoothstep(uStagePaperTop * 0.95, uStagePaperTop * 1.05, vStagePaperDepth);
diffuseColor.rgb = mix(diffuseColor.rgb, uStageSingleCore, topCardCore);
float lowerLaminate = smoothstep(uStageBodyDepth - uStagePaperTop * 0.22,
    uStageBodyDepth - uStagePaperTop * 0.15, vStagePaperDepth);
float printedLip = 1.0 - smoothstep(uStagePaperTop * 0.06, uStagePaperTop * 0.15, vStagePaperDepth);
diffuseColor.rgb = mix(diffuseColor.rgb, uStageLaminate, max(lowerLaminate, printedLip * 0.45));
if (uStagePaperBands > 0.5) {
float paperLayer = (vStagePaperDepth - uStagePaperTop) / uStagePaperDepth;
// Keep roughly 1.4 pixels between seams; small piles soften rather than alias.
float paperBands = min(uStagePaperBands, max(1.0, floor(0.72 / max(fwidth(paperLayer), 0.0001))));
float paperPhase = paperLayer * paperBands;
float paperDistance = abs(fract(paperPhase + 0.5) - 0.5);
float paperAA = max(0.025, fwidth(paperPhase) * 0.5);
float paperLine = (1.0 - smoothstep(0.12 - paperAA, 0.12 + paperAA, paperDistance))
    * step(0.0, paperLayer) * step(paperLayer, 1.0);
diffuseColor.rgb = mix(diffuseColor.rgb, uStagePaperLight, paperLine * 0.8);
}
`);
    };
    material.customProgramCacheKey = () => 'stage-laminated-paper-v2';
    return material;
}

/**
 * Shared by stationary, dragged and flying cards. Face is local XY at Z=0;
 * callers own world position/orientation. Texture ownership remains with its lease.
 */
export function createStageCardVisual({ width, height, texture, selected = false, highlight = 'none', pileCount }: StageCardVisualOptions): Group {
    const group = new Group();
    group.name = 'stage-card-visual';
    const radius = Math.min(width, height) * 0.027;
    const thickness = pileCount === undefined ? getStageCardThickness(width, height) : getStagePileHeight(pileCount, width, height);
    if (thickness <= 0) return group;
    const bevel = Math.min(.013, getStageCardThickness(width, height) * .12);
    const depth = thickness - bevel * 2;
    const binding = Math.min(width, height) * .012;
    const bodyGeometry = new ExtrudeGeometry(roundedRectangle(width + binding, height + binding, radius), {
        depth, steps: 1, bevelEnabled: true, bevelThickness: bevel,
        bevelSize: bevel * .65, bevelSegments: 3, curveSegments: 5,
    });
    // The physical top remains below the artwork: no coplanar front/body surfaces.
    bodyGeometry.translate(0, 0, -depth - bevel - 0.001);
    const body = new Mesh(bodyGeometry, [
        new MeshStandardMaterial({ color: selected ? '#d8c5a5' : '#cfc4b1', roughness: .4, metalness: 0 }),
        createCardSideMaterial(width, height, thickness, pileCount),
    ]);
    body.name = 'stage-card-edge'; body.castShadow = true; body.receiveShadow = true;
    group.add(body);

    const rim = new Mesh(createStageOutlineGeometry(width + .0015, height + .0015, radius, Math.max(.0018, Math.min(width, height) * .007)),
        new MeshStandardMaterial({ color: selected ? '#dfc89f' : '#d2c8b7', roughness: .34, metalness: 0 }));
    rim.name = 'stage-card-rim'; rim.position.z = -.0005; rim.receiveShadow = true;
    group.add(rim);

    const faceGeometry = new ShapeGeometry(roundedRectangle(width, height, radius), 5);
    const position = faceGeometry.getAttribute('position'), uv = faceGeometry.getAttribute('uv');
    for (let index = 0; index < position.count; index++) {
        uv.setXY(index, position.getX(index) / width + 0.5, position.getY(index) / height + 0.5);
    }
    uv.needsUpdate = true;
    const face = new Mesh(faceGeometry, new MeshPhysicalMaterial({
        map: texture,
        // Printed art responds to the key/fill lights; a small readable floor
        // keeps dark illustrations legible while preserving direction and shadow.
        color: new Color(0.58, 0.58, 0.58), emissive: '#ffffff',
        emissiveMap: texture, emissiveIntensity: 0.25,
        roughness: 0.4, metalness: 0, ior: 1.35,
        clearcoat: 0.2, clearcoatRoughness: 0.3,
        toneMapped: false,
    }));
    face.name = 'stage-card-face'; face.receiveShadow = true;
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
