import {
    BufferGeometry, Color, ExtrudeGeometry, Float32BufferAttribute, Group, LinearMipmapLinearFilter, Material, Mesh,
    MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial, Path, Shape,
    ShapeGeometry, SRGBColorSpace, Texture, TextureLoader,
} from 'three';
import type { Stage3dHighlight } from './types';
import { getStageCardRimHeight, getStageCardThickness, getStagePileHeight } from './stageCardPhysical';
import { stageCardTextureUrl } from './stageCardBack';
export { getStageCardThickness } from './stageCardPhysical';
const CARD_RIM_OUTSET = .032;

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
    const skinUrl = stageCardTextureUrl(url);
    const key = typeof document === 'undefined' ? skinUrl : new URL(skinUrl, document.baseURI).href;
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

/** Distinct rebate, inner slope, crest and outer slope around the complete print.
 * Separate band vertices retain the normal break at each fold; one material
 * lights all facets and their subtle paper/metal colors in the same scene. */
function createCardRimGeometry(width: number, height: number, radius: number, selected: boolean): BufferGeometry {
    const shortSide = Math.min(width, height);
    const rise = getStageCardRimHeight(width, height);
    const profile = [
        { offset: shortSide * .001, z: rise * .08 },
        { offset: shortSide * .003, z: rise * .08 },
        { offset: shortSide * .010, z: rise },
        { offset: shortSide * .027, z: rise },
        { offset: shortSide * CARD_RIM_OUTSET, z: -rise * .01 },
    ];
    const contours = profile.map(({ offset, z }) => {
        const points = roundedRectangle(width + offset * 2, height + offset * 2, radius + offset).getPoints(8);
        if (points.at(-1)!.equals(points[0]!)) points.pop();
        return points.map(point => [point.x, point.y, z] as const);
    });
    // Read the cross-section before its color: a pale broad top, a recessed
    // darker inner wall, and restrained gold/blue/lilac on the sloping sides.
    // The silhouette and height stay fixed while the visible top gets wider.
    const shades = [
        ['#957241', '#647a9c', '#8a6b9c'],
        ['#c09b59', '#829fc4', '#ab8bc5'],
        [selected ? '#fff0bf' : '#fff0d1', '#eff7ff', '#f4e9fc'],
        ['#d5b274', '#98bfdf', '#bfa3dc'],
    ].map(band => band.map(color => new Color(color)));
    const positions: number[] = [], colors: number[] = [], indices: number[] = [];
    for (let band = 0; band < contours.length - 1; band++) {
        const inner = contours[band]!, outer = contours[band + 1]!;
        const start = positions.length / 3, count = inner.length, palette = shades[band]!;
        for (let index = 0; index < count; index++) {
            positions.push(...inner[index]!, ...outer[index]!);
            const [x, y] = inner[index]!;
            const tint = Math.max(0, Math.min(1, .5 + .25 * (x / (width / 2) - y / (height / 2))));
            const shade = tint < .5 ? palette[0]!.clone().lerp(palette[1]!, tint * 2)
                : palette[1]!.clone().lerp(palette[2]!, (tint - .5) * 2);
            colors.push(shade.r, shade.g, shade.b, shade.r, shade.g, shade.b);
            const a = start + index * 2, b = start + ((index + 1) % count) * 2;
            indices.push(a, a + 1, b + 1, a, b + 1, b);
        }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
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

/** The paper core and dark lower laminate remain visible below the narrow frame. */
function createCardSideMaterial(width: number, height: number, thickness: number, pileCount?: number): MeshStandardMaterial {
    const material = new MeshStandardMaterial({ color: pileCount && pileCount > 1 ? '#777d88' : '#e8dfcc', roughness: .64, metalness: 0 });
    const topThickness = getStageCardThickness(width, height);
    material.onBeforeCompile = shader => {
        shader.uniforms.uStagePaperTop = { value: topThickness };
        shader.uniforms.uStageBodyDepth = { value: thickness };
        shader.uniforms.uStagePaperDepth = { value: Math.max(.001, thickness - topThickness) };
        shader.uniforms.uStagePaperBands = { value: Math.min(12, Math.max(0, (pileCount ?? 1) - 1)) };
        shader.uniforms.uStagePaperLight = { value: new Color('#c6c3bc') };
        shader.uniforms.uStageSingleCore = { value: new Color('#e8dfcc') };
        shader.uniforms.uStageLaminate = { value: new Color('#665887') };
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
    const bevel = getStageCardThickness(width, height) * .16;
    const depth = thickness - bevel * 2;
    const shortSide = Math.min(width, height);
    const binding = shortSide * CARD_RIM_OUTSET * 2;
    // Match the expanded corner radius, then tuck the entire beveled body
    // inside the rim. The old fixed radius left gray wedges at all four corners.
    const bodyOffset = binding / 2 - bevel * .65 - shortSide * .001;
    const bodyGeometry = new ExtrudeGeometry(roundedRectangle(width + bodyOffset * 2, height + bodyOffset * 2, radius + bodyOffset), {
        depth, steps: 1, bevelEnabled: true, bevelThickness: bevel,
        bevelSize: bevel * .65, bevelSegments: 3, curveSegments: 5,
    });
    // The physical top remains below the artwork: no coplanar front/body surfaces.
    bodyGeometry.translate(0, 0, -depth - bevel - 0.001);
    const body = new Mesh(bodyGeometry, [
        new MeshStandardMaterial({ color: '#9386b9', roughness: .48, metalness: .08 }),
        createCardSideMaterial(width, height, thickness, pileCount),
    ]);
    body.name = 'stage-card-edge'; body.castShadow = true; body.receiveShadow = true;
    group.add(body);

    const rim = new Mesh(createCardRimGeometry(width, height, radius, selected),
        new MeshStandardMaterial({ vertexColors: true, roughness: .36, metalness: .18, envMapIntensity: .45, toneMapped: false }));
    rim.name = 'stage-card-rim'; rim.castShadow = true; rim.receiveShadow = true;
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
        color: new Color(0.48, 0.48, 0.48), emissive: '#ffffff',
        emissiveMap: texture, emissiveIntensity: 0.20,
        roughness: 0.52, metalness: 0, ior: 1.4, envMapIntensity: .12,
        clearcoat: 0.28, clearcoatRoughness: 0.26,
        toneMapped: false,
    }));
    face.name = 'stage-card-face'; face.receiveShadow = true;
    group.add(face);

    if (selected || highlight !== 'none') {
        const subtle = !selected && highlight === 'available';
        const color = selected ? '#f4d499' : highlight === 'limited' ? '#ce94ec'
            : highlight === 'actionable' ? '#83cfff' : '#799bac';
        const outline = new Mesh(
            createStageOutlineGeometry(width + binding * 1.2, height + binding * 1.2, radius + binding * .6, Math.max(0.006, width * 0.005)),
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
