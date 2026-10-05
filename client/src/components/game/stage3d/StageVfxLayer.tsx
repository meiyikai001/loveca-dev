import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { entranceTimeline } from '@/lib/cardEntranceTimeline';
import { hasEffectFeedbackGlow } from '@/lib/effectFeedback';
import { getStage3dGeometry, getStage3dSurfacePose, resolveStage3dObjectPose, resolveStage3dMovePose } from './geometry';
import { acquireStageCardTexture, createStageCardVisual, disposeStageCardVisual } from './StageCardVisual';
import { getStageCardThickness } from './stageCardPhysical';
import { sampleStageMove, stageCardPoseMatches } from './stageMoveLifecycle';
import type { Stage3dPose } from './types';
import { buildStageGainLayers } from './stageGainLayers';
import {
  createStageLandingSignals,
  getStageNeighborPeakAngle,
  sampleStageLanding,
} from './stageLandingLifecycle';
import {
  stageVfxRuntime,
  type StageGainRequest,
  type StageLandingRequest,
  type StageMoveRequest,
  type StageVfxDriver,
} from './stageVfxRuntime';

const vertexShader = `varying vec2 vUv;
void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`;
const surfaceFragment = `
varying vec2 vUv;
uniform vec3 uColor;
uniform float uTime;
uniform float uStrength;
uniform float uKind;
uniform float uStage;
void main(){
  vec2 p=vUv-.5;
  float envelope=smoothstep(0.,.18,uTime)*(1.-smoothstep(.62,1.,uTime));
  float aura=exp(-dot(p*vec2(2.8,2.3),p*vec2(2.8,2.3))*2.4)*.21*mix(1.,.48,uStage);
  float border=exp(-pow((max(abs(p.x)*1.28,abs(p.y))-0.38)*36.,2.))*.13*mix(1.,.8,uStage);
  float gloss=0.;
  if(uKind>.5){
    float sweep=-.78+uTime*1.72;
    gloss=exp(-pow((p.x*.72+p.y-sweep)*5.8,2.))*.24;
    gloss*=(1.-smoothstep(.35,.48,abs(p.x)))*(1.-smoothstep(.38,.49,abs(p.y)));
  }else{
    vec2 heartCentre=vec2(-.36,.16);
    gloss=exp(-dot((p-heartCentre)*vec2(5.,3.),(p-heartCentre)*vec2(5.,3.)))*.08;
    gloss*=smoothstep(.14,.42,uTime);
  }
  float alpha=(aura+border+gloss*uStage)*envelope*uStrength;
  gl_FragColor=vec4(uColor,alpha);
}`;
const groundFragment = `
varying vec2 vUv;
uniform float uTime;
void main(){
  vec2 p=(vUv-.5)*2.; float d=length(p); float a=atan(p.y,p.x);
  float r=.10+.78*(1.-pow(1.-uTime,3.));
  float ripple=sin(a*13.+uTime*4.)*.008+sin(a*29.)*.004;
  float edge=exp(-pow((d-r-ripple)*48.,2.));
  float trail=exp(-pow((d-r+.05)*16.,2.))*.22;
  float core=exp(-d*d*18.)*pow(1.-uTime,3.)*.65;
  float fade=smoothstep(0.,.035,uTime)*pow(1.-uTime,.9);
  gl_FragColor=vec4(.68,.82,1.,(edge*.65+trail+core)*fade);
}`;

function additiveMaterial(fragmentShader: string, uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}
function disposeGroup(group: THREE.Object3D) {
  group.removeFromParent();
  group.traverse((object) => {
    if (object instanceof THREE.Mesh) object.geometry.dispose();
    if (object instanceof THREE.Mesh || object instanceof THREE.Sprite) {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material.dispose());
    }
  });
}
function glowTexture() {
  const size = 48;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(((x + 0.5) / size) * 2 - 1, ((y + 0.5) / size) * 2 - 1);
      const offset = (y * size + x) * 4;
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 255;
      pixels[offset + 3] = Math.round(Math.max(0, Math.exp(-d * d * 6.5) - Math.exp(-6.5)) * 255);
    }
  const texture = new THREE.DataTexture(pixels, size, size);
  texture.needsUpdate = true;
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  return texture;
}
type Running = { update(now: number): boolean; dispose(): void; abort?(): void };
type Neighbor = {
  object: THREE.Object3D;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  pivot: THREE.Vector3;
  axis: THREE.Vector3;
  strength: number;
  delay: number;
};

function settledCardReady(scene: THREE.Scene, objectId: string, pose: Stage3dPose) {
  const card = scene.getObjectByName(`stage-card:${objectId}`);
  if (!card || !card.userData.stageCardReady || !stageCardPoseMatches(card.userData.stageCardPose, pose)) return false;
  for (let parent: THREE.Object3D | null = card; parent; parent = parent.parent) if (!parent.visible) return false;
  return true;
}

function placeCard(card: THREE.Group, pose: Stage3dPose, width: number, height: number) {
  card.position.set(pose.position.x, pose.position.y, pose.position.z);
  card.rotation.set(0, -pose.rotation * Math.PI / 180, 0);
  card.scale.set(pose.width / width, getStageCardThickness(pose.width, pose.height) / getStageCardThickness(width, height), pose.height / height);
}

/** One renderer-owned collection. There are no React state updates in the frame loop. */
class StageVfxController implements StageVfxDriver {
  private root = new THREE.Group();
  private running = new Set<Running>();
  private glow = glowTexture();
  private disposed = false;
  constructor(private scene: THREE.Scene) {
    this.root.name = 'stage-vfx';
    scene.add(this.root);
  }
  private add(effect: Running) {
    this.running.add(effect);
    let cancelled = false;
    return () => {
      if (cancelled) return;
      cancelled = true;
      this.running.delete(effect);
      effect.dispose();
    };
  }
  update(now: number) {
    for (const effect of this.running)
      if (!effect.update(now)) {
        this.running.delete(effect);
        effect.dispose();
      }
  }
  dispose() {
    this.disposed = true;
    for (const effect of this.running) {
      effect.abort?.();
      effect.dispose();
    }
    this.running.clear();
    this.glow.dispose();
    this.root.removeFromParent();
  }
  playMove(request: StageMoveRequest, onArrive: () => void, onDone: () => void) {
    const { event } = request;
    const from = request.fromPose ?? resolveStage3dMovePose(event.render.objectId, event.fromZoneType, event.fromRect, 'from');
    const initialTarget = resolveStage3dMovePose(event.render.objectId, event.toZoneType, event.toRect, 'to');
    if (!from || !initialTarget) return null;
    const card = new THREE.Group();
    card.visible = false;
    this.root.add(card);
    const lease = acquireStageCardTexture(request.imagePath);
    const signals = createStageLandingSignals(onArrive, onDone);
    let texture: THREE.Texture | null = null;
    let visual: THREE.Group | null = null;
    let failed = false, cancelled = false, arrived = false;
    lease.ready.then((loaded) => { if (!cancelled) texture = loaded; }, () => { failed = true; });
    return this.add({
      abort: () => { signals.impact(); signals.complete(); },
      update: (now) => {
        const elapsed = Math.max(0, now - request.startedAt);
        const target = resolveStage3dMovePose(event.render.objectId, event.toZoneType, event.toRect, 'to') ?? initialTarget;
        if (failed) { signals.impact(); signals.complete(); return false; }
        if (!texture) {
          if (elapsed >= request.durationMs) { signals.impact(); signals.complete(); return false; }
          return true;
        }
        if (!visual) {
          const surface = resolveStage3dObjectPose(event.render.objectId)?.surface;
          visual = createStageCardVisual({ width: initialTarget.width, height: initialTarget.height, texture,
            selected: surface?.selected, highlight: surface?.highlight });
          visual.rotation.x = -Math.PI / 2;
          card.add(visual);
        }
        card.visible = true;
        placeCard(card, sampleStageMove(from, target, elapsed, request.durationMs), initialTarget.width, initialTarget.height);
        request.onSourceConsumed?.();
        if (elapsed >= request.durationMs) {
          if (!arrived) { arrived = true; signals.impact(); }
          // Field targets remain represented by this exact physical card until their
          // texture and final pose have committed. Non-field destinations use the UI.
          const fieldTarget = resolveStage3dObjectPose(event.render.objectId);
          if (!fieldTarget || settledCardReady(this.scene, event.render.objectId, target)
            || elapsed >= request.durationMs + 120) {
            signals.complete();
            return false;
          }
        }
        return true;
      },
      dispose: () => {
        if (cancelled) return;
        cancelled = true;
        signals.cancel();
        request.onSourceConsumed?.();
        if (visual) { visual.removeFromParent(); disposeStageCardVisual(visual); }
        card.removeFromParent();
        lease.release();
      },
    });
  }
  playLanding(
    request: StageLandingRequest,
    startedAt: number,
    onImpact: () => void,
    onDone: () => void
  ) {
    const group = new THREE.Group();
    group.visible = false;
    this.root.add(group);
    let texture: THREE.Texture | null = null;
    let failed = false,
      cancelled = false,
      contacted = false,
      built = false;
    let card: THREE.Group | null = null;
    let visual: THREE.Group | null = null;
    let ring: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | null = null;
    let shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null = null;
    const neighbors: Neighbor[] = [];
    const signals = createStageLandingSignals(onImpact, onDone);
    const start = new THREE.Vector3();
    let width = 1,
      height = 1,
      baseRotation = 0;
    const lease = acquireStageCardTexture(request.imagePath);
    lease.ready.then((loaded) => { if (!cancelled && !this.disposed) texture = loaded; }, () => { failed = true; });
    const restore = () =>
      neighbors.forEach((neighbor) => {
        neighbor.object.position.copy(neighbor.position);
        neighbor.object.quaternion.copy(neighbor.quaternion);
      });
    return this.add({
      abort: signals.complete,
      update: (now) => {
        const sampled = sampleStageLanding(now, startedAt);
        if (failed) {
          signals.complete();
          return false;
        }
        if (sampled.waiting) return true;
        const resolved = resolveStage3dObjectPose(request.target.objectId);
        if (!resolved || !resolved.surface.faceUp || !texture) {
          signals.complete();
          return false;
        }
        const { pose, projection } = resolved;
        const target = new THREE.Vector3(pose.position.x, pose.position.y, pose.position.z);
        if (!built) {
          built = true;
          width = pose.width;
          height = pose.height;
          baseRotation = (-pose.rotation * Math.PI) / 180;
          const viewport = getStage3dGeometry()?.snapshot.viewport;
          const projectedStart = projection.screenToWorld(
            {
              x: viewport ? viewport.left + viewport.width * 0.5 : window.innerWidth * 0.5,
              y: viewport ? viewport.top + viewport.height * 0.42 : window.innerHeight * 0.42,
            },
            target.y + height * 1.3
          );
          start.set(projectedStart?.x ?? 0, target.y + height * 1.3, projectedStart?.z ?? target.z);
          if (request.fromPose) start.set(request.fromPose.position.x, request.fromPose.position.y, request.fromPose.position.z);
          card = new THREE.Group();
          visual = createStageCardVisual({ width, height, texture, selected: resolved.surface.selected,
            highlight: resolved.surface.highlight });
          visual.rotation.x = -Math.PI / 2;
          card.add(visual);
          group.add(card);
          shadow = new THREE.Mesh(
            new THREE.PlaneGeometry(width * 1.28, height * 1.18),
            new THREE.MeshBasicMaterial({
              map: this.glow,
              color: '#08030d',
              transparent: true,
              opacity: 0.34,
              depthWrite: false,
              toneMapped: false,
            })
          );
          shadow.rotation.set(-Math.PI / 2, 0, baseRotation);
          group.add(shadow);
          ring = new THREE.Mesh(
            new THREE.PlaneGeometry(height * 2.9, height * 2.9),
            additiveMaterial(groundFragment, { uTime: { value: 0 } })
          );
          ring.rotation.x = -Math.PI / 2;
          ring.position.copy(target);
          ring.position.y = .004;
          ring.visible = false;
          group.add(ring);
        }
        group.visible = true;
        request.onSourceConsumed?.();
        const frame = sampled.flight;
        if (!contacted && card && shadow) {
          card.position.lerpVectors(start, target, frame.path);
          card.position.y = target.y + (start.y - target.y) * frame.height;
          const rotation = request.fromPose
            ? -((request.fromPose.rotation + (pose.rotation - request.fromPose.rotation) * frame.path) * Math.PI) / 180
            : -pose.rotation * Math.PI / 180;
          const tilt = request.fromPose ? 0 : frame.height;
          card.rotation.set(
            0.075 * tilt,
            rotation - 0.065 * tilt,
            -0.045 * tilt
          );
          const fromWidth = request.fromPose?.width ?? pose.width * 1.1;
          const fromHeight = request.fromPose?.height ?? pose.height * 1.1;
          const drawnWidth = pose.width + (fromWidth - pose.width) * frame.height;
          const drawnHeight = pose.height + (fromHeight - pose.height) * frame.height;
          card.scale.set(drawnWidth / width, getStageCardThickness(drawnWidth, drawnHeight) / getStageCardThickness(width, height), drawnHeight / height);
          shadow.position.copy(card.position);
          shadow.position.y = .002;
          shadow.scale.setScalar(1 + frame.height * 0.35);
          shadow.material.opacity = 0.24 + 0.28 * (1 - frame.height);
          if (frame.finished) {
            contacted = true;
            shadow.visible = false;
            signals.impact();
            const geometryAtImpact = getStage3dGeometry();
            const viewport = geometryAtImpact?.snapshot.viewport;
            const firstCorner =
              viewport && projection.screenToWorld({ x: viewport.left, y: viewport.top });
            const lastCorner =
              viewport &&
              projection.screenToWorld({
                x: viewport.left + viewport.width,
                y: viewport.top + viewport.height,
              });
            const radius =
              firstCorner && lastCorner
                ? Math.hypot(lastCorner.x - firstCorner.x, lastCorner.z - firstCorner.z) * 0.55
                : height * 3.1;
            this.scene.traverse((object) => {
              if (
                !object.name.startsWith('stage-card:') ||
                object.name === `stage-card:${request.target.objectId}`
              )
                return;
              const id = object.name.slice('stage-card:'.length);
              const geometry = getStage3dGeometry();
              const surface = geometry?.snapshot.surfaces.find(
                (candidate) => candidate.objectId === id || candidate.key === id
              );
              if (
                !geometry ||
                !surface ||
                !surface.visible ||
                !['member', 'live'].includes(surface.kind) ||
                !object.visible
              )
                return;
              const otherPose = getStage3dSurfacePose(surface, geometry.projection);
              if (!otherPose) return;
              const position = object.position.clone(),
                quaternion = object.quaternion.clone();
              const toward = target
                .clone()
                .sub(
                  new THREE.Vector3(
                    otherPose.position.x,
                    otherPose.position.y,
                    otherPose.position.z
                  )
                );
              toward.y = 0;
              const distance = toward.length();
              if (distance < 0.01 || distance >= radius) return;
              toward.normalize();
              const cardRotation = (-otherPose.rotation * Math.PI) / 180;
              const localDirection = toward
                .clone()
                .applyAxisAngle(new THREE.Vector3(0, 1, 0), -cardRotation);
              const pivot = new THREE.Vector3(
                (-Math.sign(localDirection.x) * otherPose.width) / 2,
                0,
                (-Math.sign(localDirection.z) * otherPose.height) / 2
              ).applyAxisAngle(new THREE.Vector3(0, 1, 0), cardRotation);
              neighbors.push({
                object,
                position,
                quaternion,
                pivot,
                axis: new THREE.Vector3(-toward.z, 0, toward.x).normalize(),
                strength: 1 - (distance / radius) * 0.8,
                delay: (75 * distance) / radius,
              });
            });
          }
        }
        if (contacted && ring) {
          // The projected DOM snapshot may reach the scene one frame after impact.
          // Keep the exactly settled proxy until the real surface is present.
          if (card) {
            placeCard(card, pose, width, height);
            card.visible = !settledCardReady(this.scene, request.target.objectId, pose);
          }
          const after = sampled.impactElapsed;
          ring.visible = after < entranceTimeline.impact.ring;
          ring.material.uniforms.uTime.value = Math.min(1, after / entranceTimeline.impact.ring);
          for (const neighbor of neighbors) {
            const t = Math.max(0, Math.min(1, (after - neighbor.delay) / 290));
            const response = Math.min(1, (Math.sin(Math.PI * t) * (1 - t) ** 0.7) / 0.64);
            const angle = (getStageNeighborPeakAngle(neighbor.strength) * Math.PI) / 180;
            const rotation = new THREE.Quaternion().setFromAxisAngle(
              neighbor.axis,
              response * angle
            );
            neighbor.object.quaternion.copy(neighbor.quaternion).multiply(rotation);
            const correction = neighbor.pivot
              .clone()
              .sub(neighbor.pivot.clone().applyQuaternion(rotation));
            neighbor.object.position
              .copy(neighbor.position)
              .add(correction.applyQuaternion(neighbor.quaternion));
          }
        }
        if (sampled.complete) {
          signals.complete();
          return false;
        }
        return true;
      },
      dispose: () => {
        if (cancelled) return;
        cancelled = true;
        signals.cancel();
        request.onSourceConsumed?.();
        restore();
        if (visual) { visual.removeFromParent(); disposeStageCardVisual(visual); }
        disposeGroup(group);
        lease.release();
      },
    });
  }
  playGain(request: StageGainRequest) {
    if (
      !request.target.objectId ||
      (!request.source && !hasEffectFeedbackGlow(request.event.mode, request.target.changes))
    )
      return () => {};
    const id = request.target.objectId;
    const changes = buildStageGainLayers(
      request.event.mode,
      request.target.changes,
      request.source
    );
    if (!changes.length) return () => {};
    const group = new THREE.Group();
    this.root.add(group);
    const surfaces: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>[] = [];
    const motes: { sprite: THREE.Sprite; lane: number; index: number }[] = [];
    const style = stageVfxRuntime.getGainStyle();
    for (const [lane, change] of changes.entries()) {
      const color = new THREE.Color(change.color);
      const hsl = { h: 0, s: 0, l: 0 };
      color.getHSL(hsl);
      const moteColor = color
        .clone()
        .setHSL(hsl.h, Math.min(1, hsl.s * 1.8), Math.min(0.42, hsl.l));
      const surface = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        additiveMaterial(surfaceFragment, {
          uColor: { value: color },
          uTime: { value: 0 },
          uStrength: { value: change.strength },
          uKind: { value: change.kind === 'BLADE' ? 1 : 0 },
          uStage: { value: style === 'stage' && !request.source ? 1 : 0 },
        })
      );
      surface.rotation.x = -Math.PI / 2;
      surfaces.push(surface);
      group.add(surface);
      if (style === 'stage' && change.kind === 'HEART')
        for (let i = 0; i < 7; i++) {
          const sprite = new THREE.Sprite(
            new THREE.SpriteMaterial({
              map: this.glow,
              color: moteColor,
              transparent: true,
              opacity: 0,
              depthWrite: false,
              // A coloured body remains readable over pale card art; the soft alpha
              // edge supplies the glow without adding the centre to white.
              blending: THREE.NormalBlending,
              toneMapped: false,
            })
          );
          motes.push({ sprite, lane, index: i });
          group.add(sprite);
        }
    }
    let cancelled = false;
    return this.add({
      update: (now) => {
        const resolved = resolveStage3dObjectPose(id);
        if (
          !resolved ||
          !resolved.surface.visible ||
          !resolved.surface.faceUp ||
          now >= request.endsAt
        )
          return false;
        const { pose } = resolved;
        group.position.set(pose.position.x, pose.position.y + 0.032, pose.position.z);
        group.rotation.y = (-pose.rotation * Math.PI) / 180;
        const elapsed = now - request.startedAt;
        for (const [lane, surface] of surfaces.entries()) {
          const duration = request.source ? 420 : 1120;
          const progress = Math.max(0, Math.min(1, (elapsed - changes[lane]!.delay) / duration));
          surface.scale.set(pose.width * 1.25, pose.height * 1.2, 1);
          surface.position.y = 0.001 * lane;
          surface.material.uniforms.uTime.value = progress;
        }
        for (const mote of motes) {
          const p = Math.max(
            0,
            Math.min(1, (elapsed - 80 - mote.index * 28 - mote.lane * 75) / 650)
          );
          const travel = p * p * (3 - 2 * p);
          const destinationX = -pose.width * 0.43,
            destinationZ = -pose.height * 0.18;
          const startX = -pose.width * (0.72 + (mote.index % 3) * 0.24);
          const startZ = -pose.height * (0.3 + (mote.index / 6) * 0.36);
          mote.sprite.position.set(
            startX + (destinationX - startX) * travel,
            pose.width * (0.1 + Math.sin(p * Math.PI) * 0.5),
            startZ + (destinationZ - startZ) * travel
          );
          mote.sprite.scale.setScalar(pose.width * (0.25 + Math.sin(p * Math.PI) * 0.12));
          mote.sprite.material.opacity = (Math.sin(p * Math.PI) * 0.96) / Math.sqrt(changes.length);
        }
        return true;
      },
      dispose: () => {
        if (!cancelled) {
          cancelled = true;
          disposeGroup(group);
        }
      },
    });
  }
}

/** Mount once inside the existing stage Canvas. */
export function StageVfxLayer() {
  const scene = useThree((state) => state.scene);
  const controller = useRef<StageVfxController | null>(null);
  useEffect(() => {
    const next = new StageVfxController(scene);
    controller.current = next;
    const uninstall = stageVfxRuntime.install(next);
    return () => {
      uninstall();
      next.dispose();
      controller.current = null;
    };
  }, [scene]);
  useFrame(() => controller.current?.update(performance.now()));
  return null;
}
