import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CanvasTexture, Group, MeshBasicMaterial, Texture } from 'three';
import { acquireStageCardTexture, createStageCardVisual, mountStageCardVisual } from './StageCardVisual';
import type { Stage3dPose, Stage3dSurface } from './types';

export type StageCardPose = Stage3dPose;

function useCardTexture(path: string): Texture | null {
    const [loaded, setLoaded] = useState<{ path: string; texture: Texture } | null>(null);
    useEffect(() => {
        if (!path) return;
        let active = true;
        const lease = acquireStageCardTexture(path);
        lease.ready.then(texture => {
            if (active) setLoaded({ path, texture });
        }).catch(() => {
            // The original DOM artwork stays available until this public image is ready.
        });
        return () => { active = false; lease.release(); };
    }, [path]);
    return loaded?.path === path ? loaded.texture : null;
}

function createContactShadow(): CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 192; canvas.height = 256;
    const context = canvas.getContext('2d')!;
    // The opaque footprint must reach the real card edge. Previously it was
    // smaller than the card and its blur was almost entirely hidden underneath.
    context.shadowColor = 'rgba(0,0,0,0.66)'; context.shadowBlur = 11;
    context.fillStyle = 'rgba(0,0,0,0.88)';
    context.beginPath(); context.roundRect(21, 23, 150, 210, 5); context.fill();
    context.shadowBlur = 3;
    context.fill();
    return new CanvasTexture(canvas);
}

/** The named root is reserved for VFX impulse; the floor contact remains on the table. */
export function StageCardMesh({ surface, pose, onSurfaceReady }: {
    surface: Stage3dSurface;
    pose: StageCardPose;
    onSurfaceReady?: (key: string, ready: boolean) => void;
}) {
    const texture = useCardTexture(surface.imagePath);
    const visualRoot = useRef<Group>(null);
    const contactMaterial = useRef<MeshBasicMaterial>(null);
    const highlight = surface.faceUp ? surface.highlight : 'none';
    // Movement occlusion controls presentation, not texture/mesh ownership. A
    // ready hidden target must keep its DOM artwork suppressed at handoff.
    const renderReady = Boolean(texture) && pose.width > 0 && pose.height > 0;
    const showContact = surface.kind !== 'stack';
    useLayoutEffect(() => {
        const parent = visualRoot.current;
        if (!renderReady || !texture || !parent) {
            onSurfaceReady?.(surface.key, false);
            return;
        }
        const material = contactMaterial.current;
        const contact = material ? createContactShadow() : null;
        if (material && contact) { material.map = contact; material.needsUpdate = true; }
        const unmount = mountStageCardVisual(parent, () => createStageCardVisual({
            width: pose.width, height: pose.height, texture,
            selected: surface.selected, highlight, pileCount: surface.pileCount,
        }), ready => onSurfaceReady?.(surface.key, ready));
        return () => {
            unmount();
            if (material && material.map === contact) { material.map = null; material.needsUpdate = true; }
            contact?.dispose();
        };
    }, [renderReady, texture, pose.width, pose.height, surface.selected, highlight, surface.key, surface.pileCount, showContact, onSurfaceReady]);

    if (!renderReady) return null;
    const angle = -pose.rotation * Math.PI / 180;
    // Match the world direction of the key light, rather than rotating the
    // shadow offset with a card's active/waiting orientation. Height controls
    // the offset of piles; a close contact patch continues to anchor the base.
    const shadowX = Math.min(.24, pose.position.y * 7 / 12);
    const shadowZ = -Math.min(.14, pose.position.y * 4 / 12);
    return (
        <group visible={surface.visible} position={[pose.position.x, pose.position.y, pose.position.z]}>
            {showContact && <group position={[shadowX, -pose.position.y + .002, shadowZ]} rotation={[-Math.PI / 2, 0, angle]}>
                <mesh renderOrder={1}>
                    <planeGeometry args={[pose.width * 1.29, pose.height * 1.23]} />
                    <meshBasicMaterial ref={contactMaterial} transparent opacity={0.58} depthWrite={false} toneMapped={false} />
                </mesh>
            </group>}
            <group
                name={`stage-card:${surface.objectId ?? surface.key}`}
                userData={{ stageSurfaceKey: surface.key, stageCardReady: true, stageCardPose: pose }}
            >
                <group ref={visualRoot} rotation={[-Math.PI / 2, 0, angle]} />
            </group>
        </group>
    );
}
