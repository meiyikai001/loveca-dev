import { Component, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Canvas } from '@react-three/fiber';
import { PCFSoftShadowMap } from 'three';
import { ConcertStageScene } from './ConcertStageScene';
import { collectStage3dSnapshot, installStage3dGeometry, reconcileStage3dDomProjection, releaseStage3dDomProjection, STAGE3D_CARD_WIDTH, STAGE3D_RESOURCE_CARD_WIDTH } from './geometry';
import { getStage3dOpponentColumnGapAdjustment, getStage3dFieldAdjustment } from './stageFieldLayout';
import { stageCompositionWidth } from './stageComposition';
import { stageDragRuntime } from './stageDragRuntime';
import { observeStageLayout } from './stageLayoutObserver';
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
  const requestSample = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    presentation.current = { projection, readySurfaces };
    requestSample.current?.();
  }, [projection, readySurfaces]);

  useLayoutEffect(() => {
    const root = boardRef.current;
    return () => { if (root) releaseStage3dDomProjection(root); };
  }, [boardRef]);

  useEffect(() => {
    const root = boardRef.current;
    if (!root) return;
    let previous = '';
    const observer = observeStageLayout(root, () => {
      const next = collectStage3dSnapshot(root);
      root.style.setProperty('--stage3d-board-height', `${next.viewport.height}px`);
      root.style.setProperty('--stage3d-board-width', `${next.viewport.width}px`);
      root.style.setProperty('--stage3d-frame-width', `${stageCompositionWidth(next.viewport.width, next.viewport.height)}px`);
      root.style.setProperty('--stage3d-success-scale', String(STAGE3D_CARD_WIDTH / STAGE3D_RESOURCE_CARD_WIDTH));
      const current = presentation.current;
      for (const side of ['self', 'opponent'] as const) {
        const property = `--stage3d-${side}-field-adjustment`;
        const applied = parseFloat(root.style.getPropertyValue(property)) || 0;
        const adjustment = current.projection ? getStage3dFieldAdjustment(next, current.projection, side, applied) : null;
        if (adjustment === null) root.style.removeProperty(property);
        else {
          const value = `${adjustment.toFixed(3)}px`;
          // Browser layout rounds to subpixels; do not chase < .05px
          // alignment noise forever in an otherwise stationary scene.
          if (!root.style.getPropertyValue(property) || Math.abs(applied - adjustment) >= .05) root.style.setProperty(property, value);
        }
      }
      const columnAdjustment = current.projection ? getStage3dOpponentColumnGapAdjustment(next, current.projection) : null;
      if (columnAdjustment === null) root.style.removeProperty('--stage3d-opponent-column-adjustment');
      else {
        const value = `${columnAdjustment.toFixed(3)}px`;
        const applied = parseFloat(root.style.getPropertyValue('--stage3d-opponent-column-adjustment'));
        if (!Number.isFinite(applied) || Math.abs(applied - columnAdjustment) >= .05) {
          root.style.setProperty('--stage3d-opponent-column-adjustment', value);
        }
      }
      if (current.projection) reconcileStage3dDomProjection(root, current.projection, next, current.readySurfaces);
      const signature = JSON.stringify(next);
      const changed = signature !== previous;
      if (changed) { previous = signature; setSnapshot(next); }
      return changed || stageDragRuntime.get() !== null;
    });
    requestSample.current = observer.request;
    const unsubscribeDrag = stageDragRuntime.subscribe(observer.request);
    return () => {
      requestSample.current = null;
      unsubscribeDrag(); observer.dispose(); releaseStage3dDomProjection(root);
      root.style.removeProperty('--stage3d-board-height'); root.style.removeProperty('--stage3d-board-width');
      root.style.removeProperty('--stage3d-frame-width');
      root.style.removeProperty('--stage3d-success-scale');
      root.style.removeProperty('--stage3d-self-field-adjustment');
      root.style.removeProperty('--stage3d-opponent-field-adjustment');
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
    return release;
  }, [boardRef, projection, snapshot]);

  return <div className="concert-stage-canvas" aria-hidden="true" data-stage3d-canvas="true">
    <StageBoundary onUnavailable={onUnavailable}>
      <Canvas frameloop="demand" shadows={{ type: PCFSoftShadowMap }} dpr={[1, 1.5]} gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
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
