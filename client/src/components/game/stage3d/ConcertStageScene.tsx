import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useThree } from '@react-three/fiber';
import {
    AdditiveBlending, CanvasTexture, Color, DoubleSide, InstancedMesh, Matrix4,
    Object3D, PerspectiveCamera, Plane, Quaternion, Raycaster, RepeatWrapping, SRGBColorSpace, Vector2, Vector3,
} from 'three';
import { getStage3dSurfacePose, getStage3dZonePose, shouldRenderStage3dZone } from './geometry';
import type { Stage3dProjection, Stage3dSnapshot } from './types';
import { StageCardMesh } from './StageCardMesh';
import { StageVfxLayer } from './StageVfxLayer';
import { StageDragLayer } from './StageDragLayer';
import { StageZoneMesh } from './StageZoneMesh';
import { StageScenery } from './StageScenery';

type Vec3 = [number, number, number];
interface Beam { from: Vec3; to: Vec3; radius?: number }
const TABLE_VIEW_TILT = 28 * Math.PI / 180;

function seeded(index: number): number {
    const value = Math.sin(index * 127.1 + 311.7) * 43758.5453;
    return value - Math.floor(value);
}

function createStageTexture(): CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 2048; canvas.height = 1536;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#343944';
    ctx.fillRect(0, 0, 2048, 1536);
    // Fine, non-directional composite floor grain; no baked illumination on card faces.
    for (let i = 0; i < 120000; i++) {
        const shade = seeded(i * 3 + 1) > 0.55 ? 255 : 0;
        ctx.fillStyle = `rgba(${shade},${shade},${shade},${0.018 + seeded(i * 3) * 0.07})`;
        ctx.fillRect(seeded(i) * 2048, seeded(i + 33333) * 1536, 1.2, 1.2);
    }
    // Zone boundaries are drawn from the actual layout below. The floor itself
    // carries only material grain, so no decorative seam can bisect a card area.
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = 4;
    return texture;
}

function createFloorRelief(): CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    const data = ctx.createImageData(128, 128);
    for (let i = 0; i < 128 * 128; i++) {
        const value = Math.round(100 + seeded(i + 710) * 54);
        data.data[i * 4] = data.data[i * 4 + 1] = data.data[i * 4 + 2] = value;
        data.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(data, 0, 0);
    const texture = new CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = RepeatWrapping;
    texture.repeat.set(32, 24);
    return texture;
}

function createLedTexture(): CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 1024; canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#060812'; ctx.fillRect(0, 0, 1024, 128);
    for (let y = 4; y < 128; y += 5) for (let x = 4; x < 1024; x += 5) {
        const strength = Math.max(0.06, (Math.sin(x * 0.013) * 0.25 + 0.32) * (y / 128));
        const blue = seeded(x + y * 1024) > 0.63;
        ctx.fillStyle = blue ? `rgba(112,136,238,${strength})` : `rgba(183,117,191,${strength})`;
        ctx.fillRect(x, y, 2, 2);
    }
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    return texture;
}

function createLampGlow(): CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createRadialGradient(32, 32, 1, 32, 32, 31);
    gradient.addColorStop(0, 'rgba(255,255,255,.78)');
    gradient.addColorStop(.16, 'rgba(255,255,255,.36)');
    gradient.addColorStop(.48, 'rgba(255,255,255,.10)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 64, 64);
    return new CanvasTexture(canvas);
}

/** All truss rods share one draw call. The braces are actual geometry, not background art. */
function TrussStructure({ depth }: { depth: number }) {
    const ref = useRef<InstancedMesh>(null);
    const beams = useMemo(() => {
        const items: Beam[] = [];
        for (const side of [-1, 1]) for (const end of [-1, 1]) {
            const cx = side * 11.1, cz = end * depth * 0.36;
            const corners: Vec3[] = [[cx - .22, 0, cz - .22], [cx + .22, 0, cz - .22], [cx + .22, 0, cz + .22], [cx - .22, 0, cz + .22]];
            corners.forEach(([x, , z]) => items.push({ from: [x, -.34, z], to: [x, 2.6, z], radius: .042 }));
            for (let level = 0; level < 4; level++) {
                const y = level * .82;
                for (let face = 0; face < 4; face++) {
                    const a = corners[face], b = corners[(face + 1) % 4];
                    items.push({ from: [a[0], y, a[2]], to: [b[0], y, b[2]], radius: .031 });
                    if (level < 3) items.push({ from: [a[0], y, a[2]], to: [b[0], y + .82, b[2]], radius: .024 });
                }
            }
        }
        for (const side of [-1, 1]) {
            for (const y of [-.28, .04]) items.push({ from: [side * 10.7, y, -depth / 2], to: [side * 10.7, y, depth / 2], radius: .045 });
            for (let z = -depth / 2; z < depth / 2; z += .75) {
                items.push({ from: [side * 10.7, -.28, z], to: [side * 10.7, .04, Math.min(z + .75, depth / 2)], radius: .026 });
            }
        }
        return items;
    }, [depth]);
    useLayoutEffect(() => {
        const instance = ref.current;
        if (!instance) return;
        const matrix = new Matrix4(), from = new Vector3(), to = new Vector3(), direction = new Vector3();
        const center = new Vector3(), scale = new Vector3(), quaternion = new Quaternion(), up = new Vector3(0, 1, 0);
        beams.forEach((beam, index) => {
            from.fromArray(beam.from); to.fromArray(beam.to); direction.subVectors(to, from);
            center.addVectors(from, to).multiplyScalar(.5);
            quaternion.setFromUnitVectors(up, direction.clone().normalize());
            scale.set(beam.radius ?? .03, direction.length(), beam.radius ?? .03);
            matrix.compose(center, quaternion, scale); instance.setMatrixAt(index, matrix);
        });
        instance.instanceMatrix.needsUpdate = true;
        instance.computeBoundingSphere();
    }, [beams]);
    return <instancedMesh ref={ref} args={[undefined, undefined, beams.length]} castShadow>
        <cylinderGeometry args={[1, 1, 1, 6]} />
        <meshStandardMaterial color="#867b72" roughness={.4} metalness={.52} />
    </instancedMesh>;
}

function EdgeLights({ depth }: { depth: number }) {
    const ref = useRef<InstancedMesh>(null);
    const glowRef = useRef<InstancedMesh>(null);
    const glow = useMemo(createLampGlow, []);
    useEffect(() => () => glow.dispose(), [glow]);
    const bulbs = useMemo(() => {
        const items: { position: Vec3; scale: Vec3; color: string }[] = [];
        for (const side of [-1, 1]) for (let index = 0; index < 12; index++) {
            const z = (index / 11 - .5) * (depth - .8);
            items.push({ position: [side * 10.27, .085, z], scale: [.038, .026, .24], color: index % 4 === 1 ? '#d2b1e6' : '#ffe0ae' });
        }
        for (let index = 0; index < 18; index++) items.push({ position: [(index / 17 - .5) * 20.45, .06, depth / 2 - .12], scale: [.25, .024, .033], color: '#ffdda7' });
        return items;
    }, [depth]);
    useLayoutEffect(() => {
        if (!ref.current) return;
        const matrix = new Matrix4(), quaternion = new Quaternion();
        const floorRotation = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
        bulbs.forEach((bulb, index) => {
            matrix.compose(new Vector3(...bulb.position), quaternion, new Vector3(...bulb.scale));
            ref.current!.setMatrixAt(index, matrix); ref.current!.setColorAt(index, new Color(bulb.color));
            matrix.compose(new Vector3(bulb.position[0], bulb.position[1] + .02, bulb.position[2]), floorRotation,
                new Vector3(bulb.scale[0] + .23, bulb.scale[2] + .3, 1));
            glowRef.current?.setMatrixAt(index, matrix);
            glowRef.current?.setColorAt(index, new Color(bulb.color));
        });
        ref.current.instanceMatrix.needsUpdate = true;
        if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true;
        ref.current.computeBoundingSphere();
        if (glowRef.current) {
            glowRef.current.instanceMatrix.needsUpdate = true;
            if (glowRef.current.instanceColor) glowRef.current.instanceColor.needsUpdate = true;
            glowRef.current.computeBoundingSphere();
        }
    }, [bulbs]);
    return <group><instancedMesh ref={ref} args={[undefined, undefined, bulbs.length]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#ffffff" toneMapped={false} />
    </instancedMesh><instancedMesh ref={glowRef} args={[undefined, undefined, bulbs.length]}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial map={glow} color="#ffffff" transparent opacity={.68} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
    </instancedMesh></group>;
}

const beamVertexShader = `
    varying vec2 beamUv;
    varying vec3 beamNormal;
    varying vec3 beamView;
    void main() {
        beamUv = uv;
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        beamNormal = normalize(normalMatrix * normal);
        beamView = -viewPosition.xyz;
        gl_Position = projectionMatrix * viewPosition;
    }
`;
const beamFragmentShader = `
    uniform vec3 tint;
    uniform float strength;
    varying vec2 beamUv;
    varying vec3 beamNormal;
    varying vec3 beamView;
    void main() {
        float distanceFromLens = 1.0 - beamUv.y;
        // Fade the silhouette as well as the far end: no hard translucent cone.
        float feather = pow(abs(dot(normalize(beamNormal), normalize(beamView))), 1.35);
        float haze = pow(1.0 - distanceFromLens, 1.25) * smoothstep(0.0, .025, distanceFromLens);
        gl_FragColor = vec4(tint, strength * feather * haze);
        #include <colorspace_fragment>
    }
`;

function LampBeam({ color, length, radius, strength }: { color: string; length: number; radius: number; strength: number }) {
    const uniforms = useMemo(() => ({ tint: { value: new Color(color) }, strength: { value: strength } }), [color, strength]);
    return <mesh position={[0, 0, .165 + length / 2]} rotation={[-Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[.108, radius, length, 32, 8, true]} />
        <shaderMaterial uniforms={uniforms} vertexShader={beamVertexShader} fragmentShader={beamFragmentShader}
            transparent side={DoubleSide} depthWrite={false} blending={AdditiveBlending} toneMapped={false} />
    </mesh>;
}

function StageLight({ position, rotation, glow, lavender = false }: { position: Vec3; rotation: Vec3; glow: CanvasTexture; lavender?: boolean }) {
    const color = lavender ? '#d0abea' : '#ffe4bd';
    return <group position={position} rotation={rotation}>
        <mesh position={[0, .04, 0]} castShadow><boxGeometry args={[.4, .13, .34]} /><meshStandardMaterial color="#191b22" metalness={.42} roughness={.48} /></mesh>
        {[-1, 1].map(side => <mesh key={side} position={[side * .145, .23, 0]}><boxGeometry args={[.055, .33, .13]} /><meshStandardMaterial color="#30323a" metalness={.6} roughness={.35} /></mesh>)}
        <group position={[0, .29, .045]} rotation={[-.45, 0, 0]}>
            <mesh rotation={[Math.PI / 2, 0, 0]} castShadow><cylinderGeometry args={[.155, .135, .31, 14]} /><meshStandardMaterial color="#272a32" roughness={.36} metalness={.65} /></mesh>
            <mesh position={[0, 0, .16]}><ringGeometry args={[.12, .151, 24]} /><meshStandardMaterial color="#8d8378" metalness={.85} roughness={.22} /></mesh>
            <mesh position={[0, 0, .163]}><circleGeometry args={[.119, 24]} /><meshBasicMaterial color={color} toneMapped={false} /></mesh>
            <LampBeam color={color} length={lavender ? 2.6 : 3.5} radius={lavender ? .65 : .82} strength={lavender ? .22 : .32} />
            <LampBeam color={color} length={lavender ? 1.65 : 2.2} radius={.29} strength={.11} />
            <sprite position={[0, 0, .19]} scale={[.92, .92, 1]}>
                <spriteMaterial map={glow} color={color} transparent opacity={.6} depthWrite={false} blending={AdditiveBlending} toneMapped={false} />
            </sprite>
        </group>
    </group>;
}

function AudienceLights({ depth }: { depth: number }) {
    const ref = useRef<InstancedMesh>(null);
    useLayoutEffect(() => {
        if (!ref.current) return;
        const matrix = new Matrix4(), quaternion = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -.4);
        for (let i = 0; i < 110; i++) {
            const height = .045 + seeded(i + 81) * .13;
            matrix.compose(new Vector3((seeded(i) - .5) * 25, .18 + seeded(i + 99) * .55, -depth / 2 - .55 - seeded(i + 51) * 1.4), quaternion, new Vector3(.024, height * 1.4, .024));
            ref.current.setMatrixAt(i, matrix);
            ref.current.setColorAt(i, new Color(i % 3 ? '#b697de' : '#9faef3'));
        }
        ref.current.instanceMatrix.needsUpdate = true;
        if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true;
        ref.current.computeBoundingSphere();
    }, [depth]);
    return <instancedMesh ref={ref} args={[undefined, undefined, 110]}>
        <boxGeometry args={[1, 1, 1]} /><meshBasicMaterial toneMapped={false} transparent opacity={.72} />
    </instancedMesh>;
}

function ConcertEnvironment({ depth }: { depth: number }) {
    const floor = useMemo(createStageTexture, []);
    const relief = useMemo(createFloorRelief, []);
    const led = useMemo(createLedTexture, []);
    const glow = useMemo(createLampGlow, []);
    const lightTargets = useMemo(() => {
        const warm = new Object3D(), cool = new Object3D();
        warm.position.set(-3.4, 0, -depth * .08);
        cool.position.set(3.4, 0, depth * .18);
        return { warm, cool };
    }, [depth]);
    useEffect(() => () => { floor.dispose(); relief.dispose(); led.dispose(); glow.dispose(); }, [floor, relief, led, glow]);
    return <group>
        <ambientLight intensity={.42} color="#dce0ed" />
        <hemisphereLight args={['#dde1ed', '#373144', .72]} />
        <directionalLight position={[-7, 12, 4]} intensity={2.05} color="#fff0db" castShadow shadow-intensity={0.5} shadow-mapSize={[1024, 1024]} shadow-camera-left={-14} shadow-camera-right={14} shadow-camera-top={14} shadow-camera-bottom={-14} shadow-bias={-.0004} shadow-normalBias={.025} />
        <directionalLight position={[9, 7, -5]} intensity={.85} color="#c2caec" />
        {/* Broad stage lamps light both the print and the floor, so the cards
            share the room's warm/cool illumination instead of glowing alone. */}
        <primitive object={lightTargets.warm} />
        <primitive object={lightTargets.cool} />
        <spotLight position={[-10.95, 1.75, -depth * .38]} target={lightTargets.warm}
            color="#ffe1b6" intensity={65} angle={.7} penumbra={1} distance={26} decay={2} />
        <spotLight position={[10.95, 1.75, depth * .38]} target={lightTargets.cool}
            color="#cbd5ff" intensity={55} angle={.7} penumbra={1} distance={26} decay={2} />
        <mesh position={[0, -.19, 0]} receiveShadow><boxGeometry args={[21, .36, depth]} /><meshStandardMaterial color="#1b1c21" metalness={.3} roughness={.64} /></mesh>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -.004, 0]} receiveShadow><planeGeometry args={[20.9, depth - .06]} /><meshStandardMaterial map={floor} bumpMap={relief} bumpScale={.025} roughness={.74} metalness={.12} /></mesh>
        {[-1, 1].map(side => <group key={side}>
            <mesh position={[side * 10.36, .006, 0]} receiveShadow><boxGeometry args={[.15, .075, depth]} /><meshStandardMaterial color="#77716b" metalness={.8} roughness={.38} /></mesh>
            <mesh position={[side * 10.49, -.035, 0]}><boxGeometry args={[.105, .17, depth]} /><meshStandardMaterial color="#1b1d25" metalness={.6} roughness={.36} /></mesh>
            <mesh position={[side * 11.05, -.37, 0]} receiveShadow><boxGeometry args={[1.22, .12, depth + .6]} /><meshStandardMaterial color="#181b22" roughness={.6} metalness={.43} /></mesh>
            {[-.38, 0, .38].map((ratio, index) => <StageLight key={ratio} position={[side * 10.95, index === 1 ? .02 : 1.28, ratio * depth]} rotation={[0, -side * 1.05, 0]} glow={glow} lavender={index === 1} />)}
            {[-.35, .32].map((ratio, index) => <mesh key={`pool:${ratio}`} rotation={[-Math.PI / 2, 0, 0]} position={[side * 9.6, .012, ratio * depth]}>
                <planeGeometry args={[2.1, 2.9]} /><meshBasicMaterial map={glow} color={index ? '#c9b6e9' : '#e4c396'} transparent opacity={.16} depthWrite={false} blending={AdditiveBlending} toneMapped={false} />
            </mesh>)}
        </group>)}
        <mesh position={[0, -.02, depth / 2]}><boxGeometry args={[21.08, .09, .17]} /><meshStandardMaterial color="#77726d" metalness={.85} roughness={.36} /></mesh>
        <mesh position={[0, -.29, depth / 2 + .035]}><boxGeometry args={[21, .32, .09]} /><meshStandardMaterial color="#10131b" metalness={.58} roughness={.43} /></mesh>
        <TrussStructure depth={depth} />
        {[-1, 1].flatMap(side => [-1, 1].map(end => <group key={`foot:${side}:${end}`} position={[side * 11.1, -.27, end * depth * .36]}>
            <mesh castShadow><boxGeometry args={[.64, .1, .64]} /><meshStandardMaterial color="#4a4544" roughness={.5} metalness={.55} /></mesh>
            {[-1, 1].flatMap(x => [-1, 1].map(z => <mesh key={`${x}:${z}`} position={[x * .25, .058, z * .25]}>
                <cylinderGeometry args={[.038, .038, .022, 6]} /><meshStandardMaterial color="#ad9b88" roughness={.4} metalness={.68} />
            </mesh>))}
        </group>))}
        <EdgeLights depth={depth} />
        <StageScenery depth={depth} />
        <group position={[0, .32, -depth / 2 - .12]}>
            <mesh castShadow><boxGeometry args={[20.5, .65, .18]} /><meshStandardMaterial color="#151721" roughness={.5} metalness={.5} /></mesh>
            <mesh position={[0, .02, .096]}><planeGeometry args={[20.1, .5]} /><meshBasicMaterial map={led} toneMapped={false} /></mesh>
        </group>
        <AudienceLights depth={depth} />
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -.5, 0]}><planeGeometry args={[80, 80]} /><meshStandardMaterial color="#070911" roughness={1} /></mesh>
    </group>;
}

export interface ConcertStageSceneProps {
    snapshot: Stage3dSnapshot;
    onProjectionReady: (projection: Stage3dProjection | null) => void;
    onSurfaceReady?: (key: string, ready: boolean) => void;
    children?: ReactNode;
}

/** Mounted inside the host's one Canvas; all cards, the stage and VFX share its camera. */
export function ConcertStageScene({ snapshot, onProjectionReady, onSurfaceReady, children }: ConcertStageSceneProps) {
    const { camera, invalidate } = useThree();
    const [readyProjection, setReadyProjection] = useState<Stage3dProjection | null>(null);
    const { left, top, width, height } = snapshot.viewport;
    const aspect = Math.max(.5, width / Math.max(height, 1));
    const cameraDistance = 23.8 / (2 * Math.tan(16 * Math.PI / 180) * aspect);
    // Fit the near table edge inside the viewport under perspective, including
    // the extra foreshortening of the lower camera angle.
    const nearEdge = .97 * cameraDistance * Math.tan(16 * Math.PI / 180);
    const depth = Math.max(10, Math.min(25, 2 * nearEdge /
        (Math.cos(TABLE_VIEW_TILT) + .97 * Math.tan(16 * Math.PI / 180) * Math.sin(TABLE_VIEW_TILT))));
    const projection = useMemo<Stage3dProjection>(() => {
        const raycaster = new Raycaster(), plane = new Plane(new Vector3(0, 1, 0), 0);
        const screen = new Vector2(), position = new Vector3(), intersection = new Vector3();
        return {
            worldToScreen(point) {
                position.set(point.x, point.y, point.z).project(camera);
                return { x: left + (position.x + 1) * width / 2, y: top + (1 - position.y) * height / 2 };
            },
            screenToWorld(point, worldHeight = 0) {
                if (width <= 0 || height <= 0) return null;
                screen.set((point.x - left) / width * 2 - 1, 1 - (point.y - top) / height * 2);
                raycaster.setFromCamera(screen, camera); plane.constant = -worldHeight;
                if (!raycaster.ray.intersectPlane(plane, intersection)) return null;
                return { x: intersection.x, y: intersection.y, z: intersection.z };
            },
        };
    }, [camera, left, top, width, height]);

    useLayoutEffect(() => {
        if (!(camera instanceof PerspectiveCamera)) return;
        const angle = TABLE_VIEW_TILT;
        camera.fov = 32; camera.aspect = aspect; camera.near = .1; camera.far = 120;
        camera.position.set(0, cameraDistance * Math.cos(angle), cameraDistance * Math.sin(angle));
        camera.up.set(0, 1, 0); camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
        setReadyProjection(projection);
        onProjectionReady(projection); invalidate();
        return () => onProjectionReady(null);
    }, [camera, aspect, cameraDistance, projection, onProjectionReady, invalidate]);

    return <>
        <color attach="background" args={['#090b13']} />
        <fog attach="fog" args={['#090b13', cameraDistance + 12, cameraDistance + 44]} />
        <ConcertEnvironment depth={depth} />
        {readyProjection === projection && snapshot.zones.filter(shouldRenderStage3dZone).map(zone => {
            const pose = getStage3dZonePose(zone, projection, snapshot);
            return pose ? <StageZoneMesh key={zone.key} zone={zone} pose={pose} /> : null;
        })}
        {readyProjection === projection && snapshot.surfaces.map(surface => {
            const pose = getStage3dSurfacePose(surface, projection, snapshot);
            return pose ? <StageCardMesh key={surface.key} surface={surface} pose={pose} onSurfaceReady={onSurfaceReady} /> : null;
        })}
        {children}
        <StageVfxLayer />
        <StageDragLayer />
    </>;
}
