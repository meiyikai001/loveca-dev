import * as THREE from 'three';
import { entranceTimeline } from '@/lib/cardEntranceTimeline';
import type { Stage3dPose } from './types';

const smooth = (a: number, b: number, t: number) => {
  const p = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return p * p * (3 - 2 * p);
};

/** All cues follow the existing flight/contact clock, including skipped frames. */
export function sampleStageLandingLight(flightElapsed: number) {
  const after = flightElapsed - entranceTimeline.flight;
  const alive = after >= 0 && after < entranceTimeline.impactDuration;
  return {
    visible: alive,
    pool: alive ? 1 - smooth(0, entranceTimeline.impact.ring, after) : 0,
    beam: alive ? .72 * (1 - smooth(0, 210, after)) : 0,
    rim: alive ? 1 - smooth(0, 150, after) : 0,
    sparks: Math.max(0, Math.min(1, after / entranceTimeline.impactDuration)),
  };
}

const vertex = 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}';
function lightMaterial(fragment: string, color: string) {
  return new THREE.ShaderMaterial({ vertexShader: vertex, fragmentShader: fragment,
    uniforms: { opacity: { value: 0 }, color: { value: new THREE.Color(color) } },
    transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, toneMapped: false });
}

/** A local stage welcome: contact light, then a few suspended flecks. */
export function createStageLandingArt(width: number, height: number, glow: THREE.Texture) {
  const group = new THREE.Group();
  group.name = 'stage-landing-art';
  group.visible = false;
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(width * 3.5, height * 2.8),
    new THREE.MeshBasicMaterial({ map: glow, color: '#d1e6ff', transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = .007;
  group.add(pool);

  const beams = [-1, 1].map(side => {
    const material = lightMaterial(`varying vec2 vUv;uniform vec3 color;uniform float opacity;
      void main(){float side=exp(-pow((vUv.x-.5)*5.4,2.));
        float length=smoothstep(0.,.15,vUv.y)*(1.-smoothstep(.55,1.,vUv.y));
        gl_FragColor=vec4(color,side*length*opacity*.38);}`, side < 0 ? '#ffe0b2' : '#bedbff');
    const start = new THREE.Vector3(side * width * 2.3, height * 2.7, -height * .5);
    const end = new THREE.Vector3(0, .02, 0), direction = start.clone().sub(end);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width * 1.9, direction.length()), material);
    mesh.position.copy(start).add(end).multiplyScalar(.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    group.add(mesh);
    return mesh;
  });
  const rim = new THREE.Mesh(new THREE.PlaneGeometry(width * 1.16, height * 1.13),
    lightMaterial(`varying vec2 vUv;uniform vec3 color;uniform float opacity;
      void main(){vec2 q=abs(vUv-.5)-vec2(.426,.437);
        float d=length(max(q,0.))+min(max(q.x,q.y),0.);
        float edge=exp(-pow(d*100.,2.))*.48+exp(-pow(d*23.,2.))*.16;
        gl_FragColor=vec4(color,edge*opacity);}`, '#e0edff'));
  rim.rotation.x = -Math.PI / 2;
  group.add(rim);
  const lamp = new THREE.PointLight('#d8e7ff', 0, height * 3.4, 2);
  lamp.position.set(0, height * .95, 0);
  group.add(lamp);
  const flecks = Array.from({ length: 12 }, (_, i) => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow,
      color: i % 3 === 0 ? '#ffe2b1' : '#d6eaff', transparent: true, opacity: 0,
      depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, toneMapped: false }));
    group.add(sprite);
    return { sprite, angle: i * 2.39996, speed: .65 + (i % 4) * .13 };
  });
  return {
    group,
    update(pose: Stage3dPose, flightElapsed: number) {
      const frame = sampleStageLandingLight(flightElapsed);
      group.visible = frame.visible;
      group.position.set(pose.position.x, 0, pose.position.z);
      group.rotation.y = -pose.rotation * Math.PI / 180;
      pool.material.opacity = frame.pool * .55;
      beams.forEach(beam => { beam.material.uniforms.opacity.value = frame.beam; });
      rim.position.y = pose.position.y + .026;
      rim.material.uniforms.opacity.value = frame.rim;
      lamp.intensity = frame.pool * .65 + frame.rim * 2.4;
      lamp.visible = frame.visible && lamp.intensity > 0;
      const p = frame.sparks;
      for (const { sprite, angle, speed } of flecks) {
        sprite.position.set(Math.cos(angle) * width * (.6 + p * speed * .55),
          pose.position.y + width * (.06 + Math.sin(p * Math.PI * .85) * speed * .62),
          Math.sin(angle) * height * (.55 + p * speed * .28));
        const size = width * (.055 + (speed - .65) * .08) * (1 - p * .4);
        sprite.scale.set(size, size * 1.5, 1);
        sprite.material.opacity = smooth(0, .06, p) * (1 - smooth(.25, 1, p)) * .9;
      }
    },
    dispose() {
      group.removeFromParent();
      group.traverse(object => {
        if (object instanceof THREE.Mesh) object.geometry.dispose();
        if (object instanceof THREE.Mesh || object instanceof THREE.Sprite) {
          (object.material as THREE.Material).dispose();
        }
      });
      lamp.dispose();
    },
  };
}
