import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Group } from 'three';
import { acquireStageCardTexture, createStageCardVisual, disposeStageCardVisual, type StageCardTextureLease } from './StageCardVisual';
import { stageDragRuntime } from './stageDragRuntime';
import { getStage3dGeometry } from './geometry';

export function StageDragLayer() {
  const scene = useThree(state => state.scene);
  const invalidate = useThree(state => state.invalidate);
  const proxy = useRef<{ token: number; root: Group; cleanup: () => void } | null>(null);
  const handTextures = useRef(new Map<string, StageCardTextureLease>());
  const nextWarmup = useRef(0);
  useEffect(() => stageDragRuntime.subscribe(() => invalidate()), [invalidate]);
  useEffect(() => () => {
    proxy.current?.cleanup(); proxy.current = null; stageDragRuntime.cancel();
    for (const lease of handTextures.current.values()) lease.release();
    handTextures.current.clear();
  }, []);
  useFrame(() => {
    if (performance.now() >= nextWarmup.current) {
      nextWarmup.current = performance.now() + 500;
      // Prewarm only images already rendered in the viewer's own hand. No
      // authority state, opponent identity or unseen asset enters the cache.
      const images = getStage3dGeometry()?.root.querySelectorAll<HTMLImageElement>('[data-battle-ui-anchor="self-hand"] img[data-stage3d-art]');
      const paths = new Set(Array.from(images ?? [], image => image.src).filter(Boolean));
      for (const path of paths) if (!handTextures.current.has(path)) {
        const lease = acquireStageCardTexture(path);
        void lease.ready.catch(() => {});
        handTextures.current.set(path, lease);
      }
      for (const [path, lease] of handTextures.current) if (!paths.has(path)) {
        lease.release(); handTextures.current.delete(path);
      }
    }
    const drag = stageDragRuntime.get();
    if (proxy.current && proxy.current.token !== drag?.token) {
      proxy.current.cleanup();
      proxy.current = null;
    }
    if (!drag) return;
    if (!proxy.current) {
      const root = new Group();
      root.name = 'stage-drag-card';
      root.visible = false;
      scene.add(root);
      const lease = acquireStageCardTexture(drag.imagePath);
      let cancelled = false;
      let visual: Group | null = null;
      proxy.current = { token: drag.token, root, cleanup: () => {
        cancelled = true;
        scene.remove(root);
        if (visual) disposeStageCardVisual(visual);
        lease.release();
      } };
      void lease.ready.then(texture => {
        if (cancelled || stageDragRuntime.get()?.token !== drag.token) return;
        visual = createStageCardVisual({ width: drag.pose.width, height: drag.pose.height, texture, selected: true });
        root.add(visual);
        root.visible = true;
        stageDragRuntime.markReady(drag.token);
      }).catch(() => { if (!cancelled && stageDragRuntime.get()?.token === drag.token) stageDragRuntime.cancel(); });
    }
    const { position, rotation } = drag.pose;
    proxy.current.root.position.set(position.x, position.y, position.z);
    proxy.current.root.rotation.set(-Math.PI / 2, 0, -rotation * Math.PI / 180);
    // Runtime poses are imperative; keep drawing until release/cancel removes
    // the proxy, including its async texture and the short drop handoff.
    if (!document.hidden) invalidate();
  });
  return null;
}
