import { Component, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Canvas } from '@react-three/fiber';
import { PCFSoftShadowMap } from 'three';
import { ConcertStageScene } from './ConcertStageScene';
import { collectStage3dSnapshot, installStage3dGeometry, reconcileStage3dDomProjection, releaseStage3dDomProjection } from './geometry';
import { getStage3dOpponentColumnGapAdjustment } from './stageFieldLayout';
import type { Stage3dProjection, Stage3dSnapshot } from './types';
import './stage3d.css';
import './stage-layout.css';

class StageBoundary extends Component<{ children: ReactNode; onUnavailable: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onUnavailable(); }
  render() { return this.state.failed ? null : this.props.children; }
}

export function Stage3dBoardHost({ boardRef, onUnavailable }: {
  readonly boardRef: RefObject<HTMLDivElement | null>;
  readonly onUnavailable: () => void;
}) {
  const [snapshot, setSnapshot] = useState<Stage3dSnapshot | null>(null);
  const [readySurfaces, setReadySurfaces] = useState<ReadonlySet<string>>(() => new Set());
  const onSurfaceReady = useCallback((key: string, ready: boolean) => {
    setReadySurfaces(previous => {
      if (previous.has(key) === ready) return previous;
      const next = new Set(previous);
      if (ready) next.add(key); else next.delete(key);
      return next;
    });
  }, []);
  const [projection, setProjection] = useState<Stage3dProjection | null>(null);
  const onProjectionReady = useCallback((value: Stage3dProjection | null) => setProjection(value), []);
  const presentation = useRef({ projection, readySurfaces });
  useLayoutEffect(() => { presentation.current = { projection, readySurfaces }; }, [projection, readySurfaces]);

  useLayoutEffect(() => {
    const root = boardRef.current;
    return () => { if (root) releaseStage3dDomProjection(root); };
  }, [boardRef]);

  useEffect(() => {
    const root = boardRef.current;
    if (!root) return;
    let frame = 0, previous = '', last = -Infinity;
    // Existing DOM remains the layout and interaction authority. Sampling also follows
    // dnd-kit/Framer transforms without observing our own projection style writes.
    const sample = (now: number) => {
      if (now - last >= 50) {
        last = now;
        const next = collectStage3dSnapshot(root);
        root.style.setProperty('--stage3d-board-height', `${next.viewport.height}px`);
        root.style.setProperty('--stage3d-board-width', `${next.viewport.width}px`);
        const current = presentation.current;
        const columnAdjustment = current.projection ? getStage3dOpponentColumnGapAdjustment(next, current.projection) : null;
        if (columnAdjustment === null) root.style.removeProperty('--stage3d-opponent-column-adjustment');
        else {
          const value = `${columnAdjustment.toFixed(3)}px`;
          if (root.style.getPropertyValue('--stage3d-opponent-column-adjustment') !== value) {
            root.style.setProperty('--stage3d-opponent-column-adjustment', value);
          }
        }
        if (current.projection) reconcileStage3dDomProjection(root, current.projection, next, current.readySurfaces);
        const signature = JSON.stringify(next);
        if (signature !== previous) { previous = signature; setSnapshot(next); }
      }
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    return () => {
      cancelAnimationFrame(frame); releaseStage3dDomProjection(root);
      root.style.removeProperty('--stage3d-board-height'); root.style.removeProperty('--stage3d-board-width');
      root.style.removeProperty('--stage3d-opponent-column-adjustment');
    };
  }, [boardRef]);

  useLayoutEffect(() => {
    const root = boardRef.current;
    if (!root) return;
    if (!snapshot || !projection) {
      releaseStage3dDomProjection(root);
      return;
    }
    const release = installStage3dGeometry(root, projection, snapshot);
    reconcileStage3dDomProjection(root, projection, snapshot, readySurfaces);
    return release;
  }, [boardRef, projection, snapshot, readySurfaces]);

  return <div className="concert-stage-canvas" aria-hidden="true" data-stage3d-canvas="true">
    <StageBoundary onUnavailable={onUnavailable}>
      <Canvas shadows={{ type: PCFSoftShadowMap }} dpr={[1, 1.5]} gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
        onCreated={({ gl }) => {
          gl.domElement.addEventListener('webglcontextlost', () => {
            // R3F deliberately loses its context after normal unmount as well.
            if (gl.domElement.isConnected && boardRef.current?.contains(gl.domElement)) onUnavailable();
          }, { once: true });
        }}>
        {snapshot && <ConcertStageScene snapshot={snapshot} onProjectionReady={onProjectionReady} onSurfaceReady={onSurfaceReady} />}
      </Canvas>
    </StageBoundary>
  </div>;
}
