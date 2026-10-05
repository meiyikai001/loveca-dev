import { useLayoutEffect, useMemo, useRef } from 'react';
import { Group, Mesh, MeshStandardMaterial, Shape, ShapeGeometry } from 'three';
import { getStage3dZonePose } from './geometry';
import { createStageOutlineGeometry, mountStageCardVisual } from './StageCardVisual';
import type { Stage3dProjection, Stage3dSnapshot } from './types';

/** Physical inlays follow the same slot poses as cards, never a decorative grid. */
export function StageBoardInlays({ snapshot, projection }: { snapshot: Stage3dSnapshot; projection: Stage3dProjection }) {
    const root = useRef<Group>(null);
    const panels = useMemo(() => {
        const groups = new Map<string, { x: number; z: number; w: number; h: number }[]>();
        for (const zone of snapshot.zones) {
            if (!zone.outlined && zone.kind !== 'deck' && zone.kind !== 'waiting') continue;
            const pose = getStage3dZonePose(zone, projection, snapshot);
            if (!pose) continue;
            const kind = zone.kind === 'deck' || zone.kind === 'waiting' ? 'resource' : zone.kind;
            const key = `${zone.side}-${kind}${kind === 'resource' && snapshot.viewport.width <= 1100 ? `-${zone.key}` : ''}`;
            const rotated = Math.abs(Math.sin(pose.rotation * Math.PI / 180)) > .5;
            const list = groups.get(key) ?? [];
            list.push({ x: pose.position.x, z: pose.position.z, w: rotated ? pose.height : pose.width, h: rotated ? pose.width : pose.height });
            groups.set(key, list);
        }
        return [...groups].map(([key, list]) => {
            const left = Math.min(...list.map(p => p.x - p.w / 2)) - .22;
            const right = Math.max(...list.map(p => p.x + p.w / 2)) + .22;
            const top = Math.min(...list.map(p => p.z - p.h / 2)) - .19;
            const bottom = Math.max(...list.map(p => p.z + p.h / 2)) + .19;
            return { key, x: (left + right) / 2, z: (top + bottom) / 2, width: right - left, height: bottom - top };
        });
    }, [snapshot, projection]);
    useLayoutEffect(() => {
        if (!root.current) return;
        return mountStageCardVisual(root.current, () => {
            const group = new Group();
            for (const panel of panels) {
                const x = panel.width / 2, y = panel.height / 2, c = .17;
                const shape = new Shape();
                shape.moveTo(-x + c, -y); shape.lineTo(x - c, -y); shape.lineTo(x, -y + c);
                shape.lineTo(x, y - c); shape.lineTo(x - c, y); shape.lineTo(-x + c, y);
                shape.lineTo(-x, y - c); shape.lineTo(-x, -y + c); shape.closePath();
                const field = new Mesh(new ShapeGeometry(shape), new MeshStandardMaterial({
                    color: panel.key.includes('live') ? '#252933' : '#232730', roughness: .76, metalness: .18, envMapIntensity: .15,
                }));
                field.rotation.x = -Math.PI / 2;
                field.position.set(panel.x, -.0005, panel.z); field.receiveShadow = true;
                group.add(field);
                const edge = new Mesh(createStageOutlineGeometry(panel.width, panel.height, .14, .012),
                    new MeshStandardMaterial({ color: '#776e63', roughness: .48, metalness: .55 }));
                edge.rotation.x = -Math.PI / 2; edge.position.set(panel.x, .0001, panel.z);
                group.add(edge);
            }
            return group;
        });
    }, [panels]);
    return <group ref={root} />;
}
