import { EffectGainRadiance, EffectCardLight } from './EffectLight';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import type { EffectFeedbackChange } from '@game/online';
import { HeartColor, OrientationState } from '@game/shared/types/enums';
import { useGameStore } from '@/store/gameStore';
import {
  collectBattleAnimationAnchors,
  type BattleAnimationRect,
} from '@/lib/battleAnimationEvents';
import {
  consumeEffectFeedback,
  hasEffectFeedbackGlow,
  positionEffectFeedback,
  EFFECT_FEEDBACK_DURATION_MS,
  EFFECT_FEEDBACK_STEP_MS,
  type EffectFeedbackCursor,
  type PositionedEffectFeedback,
} from '@/lib/effectFeedback';
import {
  HEART_ICON_SOURCE_BY_COLOR,
  HEART_REQUIREMENT_ICON_SOURCE_BY_COLOR,
  MODIFIER_ICON_SOURCE,
} from '@/lib/modifierIconAssets';

const HEART_COLORS: Record<HeartColor, string> = {
  PINK: '#f7a8d1',
  RED: '#ff8e9a',
  YELLOW: '#ffe191',
  GREEN: '#a9e4bf',
  BLUE: '#a4d7ff',
  PURPLE: '#d2b8ff',
  ORANGE: '#ffc28b',
  GRAY: '#d9d7e6',
  RAINBOW: '#e2d5ff',
};

/** Cosmetic only: no command, barrier, modal suspension or game-state mutation. */
export function EffectFeedbackLayer({ enabled = true }: { readonly enabled?: boolean }) {
  const reduceMotion = !!useReducedMotion();
  const { view, log, isReadOnly } = useGameStore(
    useShallow((state) => ({
      view: state.playerViewState,
      log: state.publicBattleLog,
      isReadOnly: state.getBattleSurfaceCapabilities().isReadOnly,
    }))
  );
  const cursor = useRef<EffectFeedbackCursor | null>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const [playing, setPlaying] = useState<PositionedEffectFeedback[]>([]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  useLayoutEffect(() => {
    const clear = () => {
      timers.current.forEach(clearTimeout);
      timers.current.clear();
      setPlaying([]);
    };
    if (!view || !log.matchId || log.matchId !== view.match.matchId) {
      cursor.current = null;
      clear();
      return;
    }
    const result = consumeEffectFeedback(cursor.current, {
      context: `${view.match.matchId}:${view.match.viewerSeat}:${log.presentationEpoch}:${enabled}:${isReadOnly}`,
      // The current view establishes the floor even when the log arrives later.
      seq: view.match.seq,
      events: log.events.filter((event) => event.matchId === view.match.matchId),
    });
    cursor.current = result.cursor;
    if (result.reset || !enabled || isReadOnly || view.match.entrance) clear();
    if (!enabled || isReadOnly || view.match.entrance || result.events.length === 0) return;
    const schedule = (callback: () => void, delay: number) => {
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        callback();
      }, delay);
      timers.current.add(timer);
    };
    result.events.forEach((event, index) => {
      const delay = reduceMotion ? 0 : index * EFFECT_FEEDBACK_STEP_MS;
      schedule(() => {
        const latest = useGameStore.getState().playerViewState;
        if (
          !latest ||
          latest.match.matchId !== view.match.matchId ||
          latest.match.viewerSeat !== view.match.viewerSeat ||
          latest.match.entrance
        )
          return;
        const positioned = positionEffectFeedback(event, latest, collectBattleAnimationAnchors());
        if (positioned) setPlaying((current) => [...current.slice(-7), positioned]);
      }, delay);
      schedule(
        () => setPlaying((current) => current.filter((item) => item.id !== event.eventId)),
        delay + (reduceMotion ? 240 : EFFECT_FEEDBACK_DURATION_MS)
      );
    });
  }, [view, log, enabled, isReadOnly, reduceMotion]);

  return (
    <div
      aria-hidden="true"
      data-effect-feedback-layer
      className="pointer-events-none fixed inset-0 z-[48] overflow-hidden"
    >
      {playing.map((item) => (
        <Feedback key={item.id} item={item} reduced={reduceMotion} />
      ))}
    </div>
  );
}

function center(rect: BattleAnimationRect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function Feedback({ item, reduced }: { item: PositionedEffectFeedback; reduced: boolean }) {
  const source = item.sourceRect;
  return (
    <div data-effect-feedback={item.mode}>
      {source &&
        !reduced &&
        item.targets.some((target) => hasEffectFeedbackGlow(item.mode, target.changes)) && (
          <EffectCardLight rect={source} color="#dac7ff" source duration={0.65} />
        )}
      {item.targets.map((target, index) => {
        const color = feedbackColor(target.changes[0]);
        const to = center(target.rect);
        const gain =
          item.mode === 'APPLIED' &&
          target.changes.length > 0 &&
          target.changes.every((c) => (c.kind === 'HEART' || c.kind === 'BLADE') && c.delta > 0);
        const blade = target.changes.some((c) => c.kind === 'BLADE');
        // Keep feedback inside the viewport, including the top player's cards on narrow layouts.
        const left = Math.max(64, Math.min(window.innerWidth - 64, to.x));
        const top = Math.max(
          8,
          Math.min(window.innerHeight - 44, target.rect.top + target.rect.height * 0.62)
        );
        return (
          <div key={index}>
            {hasEffectFeedbackGlow(item.mode, target.changes) && !reduced && !gain && (
              <EffectCardLight rect={target.rect} color={color} delay={0.15} duration={0.8} />
            )}
            {gain ? (
              <>
                {!reduced && <EffectGainRadiance rect={target.rect} color={color} blade={blade} />}
                <GainArrival target={target} reduced={reduced} delay={0.25} />
              </>
            ) : (
              <motion.div
                data-effect-feedback-badge
                style={{
                  position: 'absolute',
                  left,
                  top,
                  color,
                  x: '-50%',
                  background: 'rgba(32,29,48,.93)',
                  border: `1px solid ${color}80`,
                  borderRadius: 7,
                  boxShadow: '0 3px 10px #18122140',
                  padding: '5px 9px',
                  maxWidth: 180,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexWrap: 'wrap',
                  gap: 7,
                  fontSize: 15,
                  fontWeight: 750,
                  lineHeight: '20px',
                  fontVariantNumeric: 'tabular-nums',
                }}
                initial={{ opacity: 0, y: reduced ? 0 : 4 }}
                animate={{ opacity: [0, 1, 1, 0], y: reduced ? 0 : [4, 0, 0, -3] }}
                transition={{ duration: reduced ? 0.22 : 1.15, times: [0, 0.15, 0.76, 1] }}
              >
                {target.changes.map((change, i) => (
                  <Change key={i} change={change} />
                ))}
              </motion.div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function feedbackColor(change?: EffectFeedbackChange): string {
  if (change?.kind === 'HEART' || change?.kind === 'REQUIREMENT') return HEART_COLORS[change.color];
  if (change?.kind === 'SCORE') return '#ffe0a0';
  if (change?.kind === 'ORIENTATION' && change.orientation === OrientationState.WAITING)
    return '#c6c8dd';
  return '#d7c8ff';
}

function Change({ change }: { change: EffectFeedbackChange }) {
  if (change.kind === 'ORIENTATION')
    return (
      <span style={{ fontSize: 12 }}>
        {change.orientation === OrientationState.ACTIVE ? '活跃' : '待机'}
      </span>
    );
  const icon =
    change.kind === 'HEART'
      ? HEART_ICON_SOURCE_BY_COLOR[change.color]
      : change.kind === 'REQUIREMENT'
        ? HEART_REQUIREMENT_ICON_SOURCE_BY_COLOR[change.color]
        : change.kind === 'BLADE'
          ? MODIFIER_ICON_SOURCE.blade
          : undefined;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap' }}>
      {change.kind === 'REQUIREMENT' && <span style={{ fontSize: 11 }}>需求</span>}
      {change.kind === 'SCORE' && <span style={{ fontSize: 11 }}>分数</span>}
      {change.kind === 'ENERGY' && <span style={{ fontSize: 11 }}>活跃能量</span>}
      {icon && <img src={icon} alt="" style={{ width: 18, height: 18, objectFit: 'contain' }} />}
      <span>
        {change.delta > 0 ? '+' : '−'}
        {Math.abs(change.delta)}
      </span>
    </span>
  );
}

function GainArrival({
  target,
  reduced,
  delay,
}: {
  target: PositionedEffectFeedback['targets'][number];
  reduced: boolean;
  delay: number;
}) {
  useEffect(() => {
    if (reduced || !target.objectId) return;
    const element = Array.from(document.querySelectorAll<HTMLElement>('[data-object-id]')).find(
      (node) => node.dataset.objectId === target.objectId && node.getBoundingClientRect().width > 0
    );
    // Individual scale composes with the card's orientation/drag transform; no persistent style.
    const pulse = element?.animate?.([{ scale: '1' }, { scale: '1.018' }, { scale: '1' }], {
      duration: 540,
      delay: delay * 1000,
      easing: 'cubic-bezier(.2,.7,.3,1)',
    });
    return () => pulse?.cancel();
  }, [target.objectId, reduced, delay]);
  const rect = target.rect;
  return (
    <motion.div
      data-effect-gain-arrival
      style={{
        position: 'fixed',
        left: rect.left + rect.width / 2,
        top: rect.top + rect.height * 0.3,
        x: '-50%',
        display: 'flex',
        gap: 5,
        pointerEvents: 'none',
      }}
      initial={{ opacity: 0, y: reduced ? 0 : 9, scale: reduced ? 1 : 0.72 }}
      animate={{
        opacity: [0, 1, 1, 0],
        y: reduced ? 0 : [9, 0, -2, -10],
        scale: reduced ? 1 : [0.72, 1.08, 1, 0.95],
      }}
      transition={{
        delay: reduced ? 0 : delay,
        duration: reduced ? 0.22 : 0.95,
        times: [0, 0.23, 0.7, 1],
      }}
    >
      {target.changes.map(
        (change, i) =>
          (change.kind === 'HEART' || change.kind === 'BLADE') && (
            <span
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 3,
                filter: `drop-shadow(0 0 9px ${feedbackColor(change)})`,
              }}
            >
              <img
                src={
                  change.kind === 'HEART'
                    ? HEART_ICON_SOURCE_BY_COLOR[change.color]
                    : MODIFIER_ICON_SOURCE.blade
                }
                alt=""
                style={{
                  width: Math.min(36, rect.width * 0.35),
                  height: Math.min(36, rect.width * 0.35),
                  objectFit: 'contain',
                }}
              />
              <span
                style={{
                  color: '#fffaf0',
                  fontSize: Math.min(23, rect.width * 0.24),
                  fontWeight: 800,
                  textShadow: '0 1px 3px #4b342e, 0 0 3px #4b342e',
                }}
              >
                +{change.delta}
              </span>
            </span>
          )
      )}
    </motion.div>
  );
}
