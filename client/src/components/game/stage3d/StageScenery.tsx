import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { AdditiveBlending, CanvasTexture, Color, Euler, InstancedMesh, Matrix4, Quaternion, SRGBColorSpace, Vector3 } from 'three';

const colors = ['#bd84f7', '#f484c9', '#83cfff', '#cf9bfa', '#97b3ff', '#ffe0ad'];
function noise(i: number) { const n = Math.sin(i * 71.3 + 19.7) * 41927.1; return n - Math.floor(n); }

function createScreen(): CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 1024; canvas.height = 384;
    const ctx = canvas.getContext('2d')!;
    const base = ctx.createLinearGradient(0, 0, 1024, 384);
    base.addColorStop(0, '#161b38'); base.addColorStop(.55, '#46345b'); base.addColorStop(1, '#131d34');
    ctx.fillStyle = base; ctx.fillRect(0, 0, 1024, 384);
    // Fine LED pitch and a concert light ribbon, drawn once rather than a video texture.
    for (let i = 0; i < 9; i++) {
        ctx.beginPath(); ctx.lineWidth = 1.5; ctx.strokeStyle = `rgba(207,187,233,${.12 + i * .018})`;
        for (let x = 0; x <= 1024; x += 4) {
            const y = 194 + Math.sin(x / 180 + i * .18) * (65 + i * 3);
            if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }
    for (let i = 0; i < 100; i++) {
        const x = noise(i) * 1024, y = noise(i + 100) * 384;
        ctx.fillStyle = 'rgba(220,211,236,.32)'; ctx.fillRect(x, y, 2, 2);
    }
    ctx.textAlign = 'center'; ctx.fillStyle = '#eee5d8';
    ctx.font = 'italic 90px Georgia, serif'; ctx.fillText('Loveca', 512, 207);
    ctx.font = '19px sans-serif'; ctx.fillStyle = '#c2b9cd';
    ctx.fillText('L I V E   S T A G E', 512, 253);
    for (let y = 0; y < 384; y += 5) for (let x = 0; x < 1024; x += 5) {
        ctx.fillStyle = 'rgba(2,4,12,.38)'; ctx.fillRect(x, y, 2, 2);
    }
    const texture = new CanvasTexture(canvas); texture.colorSpace = SRGBColorSpace; texture.anisotropy = 4;
    return texture;
}

function createGlow(): CanvasTexture {
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    const pixels = ctx.createImageData(64, 256);
    // A narrow optical halo with a soft end falloff, not a solid colored capsule.
    for (let y = 0; y < 256; y++) for (let x = 0; x < 64; x++) {
        const u = (x - 31.5) / 31.5, v = (y - 127.5) / 127.5;
        const alpha = Math.exp(-u * u * 9) * Math.exp(-Math.pow(v / .78, 8));
        const i = (y * 64 + x) * 4;
        pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 255;
        pixels.data[i + 3] = Math.round(alpha * 170);
    }
    ctx.putImageData(pixels, 0, 0);
    return new CanvasTexture(canvas);
}

/** Effect-owned textures survive development remount checks without reusing disposed maps. */
function useSceneryTextures() {
    const [textures, setTextures] = useState<{ screen: CanvasTexture; glow: CanvasTexture } | null>(null);
    useEffect(() => {
        const next = { screen: createScreen(), glow: createGlow() }; setTextures(next);
        return () => { next.screen.dispose(); next.glow.dispose(); };
    }, []);
    return textures;
}

function WingScreen({ side, depth, texture }: { side: number; depth: number; texture: CanvasTexture | null }) {
    const length = Math.min(4.6, Math.max(2.6, depth * .27));
    return <group position={[side * 9.94, .68, -depth * .075]} rotation={[0, 0, -side * .62]}>
        <mesh castShadow><boxGeometry args={[.17, 1.22, length]} /><meshStandardMaterial color="#171922" roughness={.48} metalness={.6} /></mesh>
        <mesh position={[-side * .091, 0, 0]} rotation={[0, -side * Math.PI / 2, 0]}>
            <planeGeometry args={[length - .12, 1.1]} /><meshBasicMaterial onUpdate={material => { material.needsUpdate = true; }} map={texture} color="#ddd5ed" toneMapped={false} />
        </mesh>
        {[-1, 1].map(end => <mesh key={end} position={[-side * .10, end * .592, 0]}>
            <boxGeometry args={[.025, .025, length - .08]} /><meshStandardMaterial color="#b6a18b" metalness={.8} roughness={.3} />
        </mesh>)}
    </group>;
}

/** Small line arrays and floor monitors use visible driver geometry, not flat silhouettes. */
function SpeakerStack({ side, z }: { side: number; z: number }) {
    return <group position={[side * 10.12, .28, z]} scale={[1.25, 1.25, 1.25]} rotation={[-.4, -side * 1.06, 0]}>
        {[0, 1, 2].map(i => <group key={i} position={[0, i * .41, -i * .025]} rotation={[i * -.05, 0, 0]}>
            <mesh castShadow><boxGeometry args={[.72, .38, .57]} /><meshStandardMaterial color="#181b24" metalness={.34} roughness={.62} /></mesh>
            <mesh position={[0, 0, .289]}><planeGeometry args={[.63, .30]} /><meshStandardMaterial color="#292e39" roughness={.82} /></mesh>
            {[-1, 1].map(edge => <mesh key={`edge-${edge}`} position={[edge * .344, 0, .28]}>
                <boxGeometry args={[.028, .35, .035]} /><meshStandardMaterial color="#4b4d51" roughness={.4} metalness={.65} />
            </mesh>)}
            {[-.17, .17].map(x => <group key={x} position={[x, 0, .299]}>
                <mesh><ringGeometry args={[.075, .119, 20]} /><meshStandardMaterial color="#11151e" metalness={.15} roughness={.55} /></mesh>
                <mesh position={[0, 0, -.008]} rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[.038, .075, .023, 20, 1, true]} /><meshStandardMaterial color="#343740" roughness={.82} /></mesh>
                <mesh position={[0, 0, -.012]} scale={[1, 1, .4]}><sphereGeometry args={[.037, 12, 8]} /><meshStandardMaterial color="#20232b" roughness={.7} /></mesh>
            </group>)}
            <mesh position={[0, -.143, .305]}><boxGeometry args={[.08, .014, .006]} /><meshBasicMaterial color="#b5a68f" /></mesh>
        </group>)}
    </group>;
}

function GlowStickWings({ depth, glow }: { depth: number; glow: CanvasTexture | null }) {
    const { camera } = useThree();
    const cores = useRef<InstancedMesh>(null), sleeves = useRef<InstancedMesh>(null);
    const handles = useRef<InstancedMesh>(null), collars = useRef<InstancedMesh>(null), auras = useRef<InstancedMesh>(null);
    const cameraMatrix = useRef(new Matrix4());
    const sticks = useMemo(() => [-1, 1].flatMap(side => Array.from({ length: 21 }, (_, i) => {
        // Audience clusters leave real gaps. Both sides have independent seeds,
        // uneven rows and crossed inclinations instead of a repeated fence.
        const seed = i + (side === 1 ? 173 : 31);
        const cluster = i < 8 ? 0 : i < 15 ? 1 : 2;
        const rotation = new Quaternion().setFromEuler(new Euler(-.5 + noise(seed + 7) * .65, 0,
            side * (.12 + (noise(seed + 19) - .5) * .7)));
        const direction = new Vector3(0, 1, 0).applyQuaternion(rotation);
        const base = new Vector3(side * (9.65 + noise(seed + 21) * .75), -.38 + noise(seed + 61) * .16,
            depth * ([.18, .29, .40][cluster] + (noise(seed + 51) - .5) * .08));
        const length = .38 + noise(seed + 11) * .40;
        const girth = .86 + noise(seed + 29) * .32;
        const center = base.clone().addScaledVector(direction, .2 + length / 2);
        return { rotation, direction, base, center, length, girth, color: colors[Math.floor(noise(seed + 5) * colors.length)] };
    })), [depth]);
    const updateAuras = useCallback(() => {
        if (!auras.current) return;
        const matrix = new Matrix4(), basis = new Matrix4();
        const normal = new Vector3(), up = new Vector3(), right = new Vector3(), rotation = new Quaternion();
        sticks.forEach((s, i) => {
            normal.copy(camera.position).sub(s.center).normalize();
            const alignment = s.direction.dot(normal);
            up.copy(s.direction).addScaledVector(normal, -alignment).normalize();
            right.crossVectors(up, normal).normalize();
            basis.makeBasis(right, up, normal); rotation.setFromRotationMatrix(basis);
            const visibleLength = s.length * Math.sqrt(Math.max(.01, 1 - alignment * alignment));
            matrix.compose(s.center, rotation, new Vector3(.32 * s.girth, visibleLength + .12, 1));
            auras.current!.setMatrixAt(i, matrix);
            auras.current!.setColorAt(i, new Color(s.color));
        });
        auras.current.instanceMatrix.needsUpdate = true;
        if (auras.current.instanceColor) auras.current.instanceColor.needsUpdate = true;
        auras.current.computeBoundingSphere();
        cameraMatrix.current.copy(camera.matrixWorld);
    }, [camera, sticks]);
    useLayoutEffect(() => {
        const matrix = new Matrix4();
        sticks.forEach((s, i) => {
            matrix.compose(s.center, s.rotation, new Vector3(s.girth, s.length, s.girth));
            cores.current?.setMatrixAt(i, matrix); sleeves.current?.setMatrixAt(i, matrix);
            const tint = new Color(s.color);
            cores.current?.setColorAt(i, tint.clone().lerp(new Color('#ffffff'), .8));
            sleeves.current?.setColorAt(i, tint);
            matrix.compose(s.base.clone().addScaledVector(s.direction, .09), s.rotation, new Vector3(s.girth, 1, s.girth));
            handles.current?.setMatrixAt(i, matrix);
            matrix.compose(s.base.clone().addScaledVector(s.direction, .19), s.rotation, new Vector3(s.girth, 1, s.girth));
            collars.current?.setMatrixAt(i, matrix);
        });
        for (const ref of [cores, sleeves, handles, collars]) if (ref.current) {
            ref.current.instanceMatrix.needsUpdate = true;
            if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true;
            ref.current.computeBoundingSphere();
        }
        updateAuras();
    }, [sticks, updateAuras]);
    // Only resize/camera changes require billboard updates; the light sticks are static.
    useFrame(() => { if (!cameraMatrix.current.equals(camera.matrixWorld)) updateAuras(); });
    return <group>
        <instancedMesh ref={cores} args={[undefined, undefined, sticks.length]}>
            <capsuleGeometry args={[.026, 1, 3, 10]} /><meshBasicMaterial toneMapped={false} />
        </instancedMesh>
        <instancedMesh ref={sleeves} args={[undefined, undefined, sticks.length]}>
            <capsuleGeometry args={[.040, 1, 3, 10]} /><meshBasicMaterial transparent opacity={.42} depthWrite={false} toneMapped={false} />
        </instancedMesh>
        <instancedMesh ref={handles} args={[undefined, undefined, sticks.length]}>
            <cylinderGeometry args={[.041, .036, .18, 10]} /><meshStandardMaterial color="#171925" roughness={.38} metalness={.48} />
        </instancedMesh>
        <instancedMesh ref={collars} args={[undefined, undefined, sticks.length]}>
            <cylinderGeometry args={[.044, .044, .025, 10]} /><meshStandardMaterial color="#656877" roughness={.3} metalness={.8} />
        </instancedMesh>
        <instancedMesh ref={auras} args={[undefined, undefined, sticks.length]}>
            <planeGeometry args={[1, 1]} /><meshBasicMaterial onUpdate={material => { material.needsUpdate = true; }} map={glow} transparent opacity={.7} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
        </instancedMesh>
    </group>;
}

export function StageScenery({ depth }: { depth: number }) {
    const textures = useSceneryTextures();
    return <group>
        {[-1, 1].map(side => <group key={side}>
            <WingScreen side={side} depth={depth} texture={textures?.screen ?? null} />
            <SpeakerStack side={side} z={-depth * .31} />
            <SpeakerStack side={side} z={depth * .34} />
        </group>)}
        <GlowStickWings depth={depth} glow={textures?.glow ?? null} />
    </group>;
}
