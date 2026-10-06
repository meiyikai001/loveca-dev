import * as THREE from 'three';
import { sampleStageRecovery } from './stageRecoveryMotion';
import type { Stage3dPose } from './types';

const sourceGlowFragment = `
varying vec2 vUv;
uniform vec2 planeSize;
uniform vec2 halfFrame;
uniform float burst;
uniform float opacity;
void main() {
  vec2 p=(vUv-.5)*planeSize;
  vec2 q=abs(p)-halfFrame+.055;
  float d=length(max(q,0.))+min(max(q.x,q.y),0.)-.055;
  float unit=halfFrame.x*2.;
  // Energy gathers inside the pile, then spills out as the card is released.
  float inside=1.-smoothstep(-unit*.12,unit*.10,d);
  vec2 centre=p/(halfFrame*1.1);
  float core=exp(-dot(centre,centre)*2.2);
  float spill=exp(-pow(max(d,0.)/(unit*(.16+burst*.10)),2.));
  float feather=1.-smoothstep(.40,.50,max(abs(vUv.x-.5),abs(vUv.y-.5)));
  float alpha=(inside*.15+core*(.22+burst*.28)+spill*(.09+burst*.15))*feather*opacity;
  vec3 color=mix(vec3(.20,.66,.57),vec3(.83,1.,.88),core*.8+burst*.15);
  gl_FragColor=vec4(color,alpha);
}`;

/** One continuous source glow, pop shaft and card-edge trail tied to the recovery timeline. */
export function createStageRecoveryArt(glow: THREE.Texture, from: Stage3dPose) {
  const group = new THREE.Group();
  group.name = 'stage-recovery-art';
  group.visible = false;
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
    map: glow, color: '#060612', transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
  }));
  shadow.rotation.x = -Math.PI / 2;
  // Leave room outside the actual zone for the halo to fade completely to transparent.
  const padding = from.width * .55;
  const planeSize = new THREE.Vector2(from.width + .14 + padding * 2, from.height + .14 + padding * 2);
  const sourceGlow = new THREE.Mesh(new THREE.PlaneGeometry(planeSize.x, planeSize.y), new THREE.ShaderMaterial({
    uniforms: { planeSize: { value: planeSize }, halfFrame: { value: new THREE.Vector2((from.width + .14) / 2, (from.height + .14) / 2) },
      burst: { value: 0 }, opacity: { value: 0 } },
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, toneMapped: false,
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: sourceGlowFragment,
  }));
  sourceGlow.name = 'recovery-source-glow';
  sourceGlow.position.set(from.position.x, from.position.y + .004, from.position.z);
  sourceGlow.rotation.set(-Math.PI / 2, 0, -from.rotation * Math.PI / 180);
  group.add(shadow, sourceGlow);
  // An open, feathered shaft connects the lit pile to the emerging card in world space.
  const shaftPositions = new Float32Array(16 * 3), shaftUvs = new Float32Array(16 * 2);
  const shaftIndices: number[] = [];
  for (let side = 0; side < 4; side++) {
    shaftUvs.set([0, 0, 1, 0, 0, 1, 1, 1], side * 8);
    const k = side * 4;
    shaftIndices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
  }
  const shaftGeometry = new THREE.BufferGeometry();
  shaftGeometry.setAttribute('position', new THREE.BufferAttribute(shaftPositions, 3).setUsage(THREE.DynamicDrawUsage));
  shaftGeometry.setAttribute('uv', new THREE.BufferAttribute(shaftUvs, 2));
  shaftGeometry.setIndex(shaftIndices);
  const shaft = new THREE.Mesh(shaftGeometry, new THREE.ShaderMaterial({
    uniforms: { opacity: { value: 0 } }, transparent: true, depthWrite: false, depthTest: true,
    side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false,
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `varying vec2 vUv;uniform float opacity;
      void main(){
        float side=smoothstep(0.,.18,vUv.x)*(1.-smoothstep(.82,1.,vUv.x));
        float vertical=pow(1.-vUv.y,1.3)*(1.-smoothstep(.82,1.,vUv.y));
        float streak=exp(-pow((vUv.x-.28)/.05,2.))+.65*exp(-pow((vUv.x-.72)/.07,2.));
        gl_FragColor=vec4(.50,.93,.76,side*vertical*(.32+streak*.5)*opacity);
      }`,
  }));
  shaft.name = 'recovery-pop-shaft';
  shaft.position.set(from.position.x, from.position.y, from.position.z);
  shaft.rotation.y = -from.rotation * Math.PI / 180;
  shaft.frustumCulled = false;
  group.add(shaft);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const;
  const segments = 14;
  const trails = [-1, 1].map(side => {
    const positions = new Float32Array((segments + 1) * 6);
    const uv = new Float32Array((segments + 1) * 4), indices: number[] = [];
    for (let i = 0; i <= segments; i++) {
      uv.set([i / segments, 0, i / segments, 1], i * 4);
      if (i < segments) { const k = i * 2; indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geometry.setIndex(indices);
    const material = new THREE.ShaderMaterial({
      uniforms: { opacity: { value: 0 } }, transparent: true, depthWrite: false,
      depthTest: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false,
      vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: `varying vec2 vUv;uniform float opacity;
        void main(){float edge=pow(max(0.,1.-abs(vUv.y*2.-1.)),1.8);
          gl_FragColor=vec4(mix(vec3(.52,.82,.78),vec3(.96,1.,.96),edge*.6),edge*pow(1.-vUv.x,1.4)*opacity);}`,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'recovery-flight-trail';
    mesh.frustumCulled = false;
    group.add(mesh);
    return { positions, mesh, side };
  });
  const position = new THREE.Vector3(), axis = new THREE.Vector3();
  const rotation = new THREE.Quaternion(), startRotation = new THREE.Quaternion();
  const bank = new THREE.Quaternion();
  return {
    group,
    update(from: Stage3dPose, to: Stage3dPose, targetRotation: THREE.Quaternion, elapsed: number, duration: number) {
      const frame = sampleStageRecovery(from, to, elapsed, duration), t = frame.progress;
      group.visible = t > 0 && t < 1;
      if (!group.visible) return;
      const p = frame.pose.position;
      shadow.position.set(p.x + frame.lift * .16, .004, p.z + frame.lift * .20);
      shadow.scale.set(frame.pose.width * (1.2 + frame.lift * .4), frame.pose.height * (1.18 + frame.lift * .4), 1);
      shadow.rotation.z = -frame.pose.rotation * Math.PI / 180;
      shadow.material.opacity = .3 * (1 - frame.flightProgress) / (1 + frame.lift);
      sourceGlow.material.uniforms.opacity.value = frame.sourceGlow;
      sourceGlow.material.uniforms.burst.value = frame.popGlow;
      shaft.visible = frame.riseProgress > 0 && frame.flightProgress === 0;
      shaft.material.uniforms.opacity.value = frame.sourceGlow * (.12 + frame.popGlow * .65);
      for (let side = 0; side < 4; side++) {
        const a = corners[side]!, b = corners[(side + 1) % 4]!;
        shaftPositions.set([
          a[0] * from.width * .36, 0, a[1] * from.height * .36,
          b[0] * from.width * .36, 0, b[1] * from.height * .36,
          a[0] * frame.pose.width * .44, frame.lift, a[1] * frame.pose.height * .44,
          b[0] * frame.pose.width * .44, frame.lift, b[1] * frame.pose.height * .44,
        ], side * 12);
      }
      shaftGeometry.attributes.position.needsUpdate = true;
      startRotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -from.rotation * Math.PI / 180);
      for (const trail of trails) {
        for (let i = 0; i <= segments; i++) {
          const lag = i / segments;
          const previous = sampleStageRecovery(from, to, Math.max(0, elapsed - lag * 64), duration);
          rotation.copy(startRotation).slerp(targetRotation, previous.handBlend);
          bank.setFromAxisAngle(new THREE.Vector3(0, 0, 1), previous.bank);
          rotation.multiply(bank);
          position.set(trail.side * previous.pose.width * .49, .01, previous.pose.height * .25)
            .applyQuaternion(rotation).add(new THREE.Vector3(previous.pose.position.x, previous.pose.position.y, previous.pose.position.z));
          axis.set(1, .25, 0).applyQuaternion(rotation).multiplyScalar(from.width * .018 * (1 - lag));
          trail.positions.set([position.x - axis.x, position.y - axis.y, position.z - axis.z,
            position.x + axis.x, position.y + axis.y, position.z + axis.z], i * 6);
        }
        trail.mesh.geometry.attributes.position.needsUpdate = true;
        trail.mesh.material.uniforms.opacity.value = frame.popGlow * .60 + Math.sin(Math.PI * frame.flightProgress) * .65;
      }
    },
    dispose() {
      group.removeFromParent();
      group.traverse(object => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          (object.material as THREE.Material).dispose();
        }
      });
      // glow belongs to the controller; disposing one flight must not invalidate another.
    },
  };
}
