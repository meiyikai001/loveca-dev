import { useLayoutEffect, useRef } from 'react';
import { Group, Mesh, MeshBasicMaterial } from 'three';
import { createStageOutlineGeometry, mountStageCardVisual } from './StageCardVisual';
import type { Stage3dPose, Stage3dZone } from './types';

/** Slot framing uses the exact world pose used by card placement and hit testing. */
export function StageZoneMesh({ zone, pose }: { zone: Stage3dZone; pose: Stage3dPose }) {
    const state = zone.state ?? 'idle';
    const root = useRef<Group>(null);
    useLayoutEffect(() => {
        if (!root.current) return;
        return mountStageCardVisual(root.current, () => {
            const group = new Group();
            const color = state === 'active' ? '#9ce4e3' : state === 'suggested' ? '#8cb8c9'
                : state === 'selectable' ? '#e0c494' : '#b8ab95';
            const active = state !== 'idle';
            const outline = new Mesh(
                createStageOutlineGeometry(pose.width + 0.075, pose.height + 0.075, 0.07, active ? 0.03 : 0.024),
                new MeshBasicMaterial({
                    color, transparent: true, opacity: active ? 0.9 : zone.occupied ? 0.48 : 0.6,
                    depthWrite: false, toneMapped: false,
                }),
            );
            group.add(outline);
            if (active) {
                const halo = new Mesh(
                    createStageOutlineGeometry(pose.width + 0.105, pose.height + 0.105, 0.08, 0.045),
                    new MeshBasicMaterial({ color, transparent: true, opacity: state === 'active' ? 0.14 : 0.07, depthWrite: false, toneMapped: false }),
                );
                halo.position.z = -0.0005;
                group.add(halo);
            }
            return group;
        });
    }, [pose.width, pose.height, state, zone.occupied]);

    return <group
        ref={root}
        name={`stage-zone:${zone.key}`}
        position={[pose.position.x, pose.position.y + 0.004, pose.position.z]}
        rotation={[-Math.PI / 2, 0, -pose.rotation * Math.PI / 180]}
    />;
}
