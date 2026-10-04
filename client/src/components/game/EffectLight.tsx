import { motion } from 'framer-motion';
import type { BattleAnimationRect } from '@/lib/battleAnimationEvents';

/** Light remains local to the card; its clipped sweep leaves the illustration readable. */
export function EffectCardLight({
  rect,
  color,
  delay = 0,
  duration = 0.85,
  source = false,
}: {
  rect: BattleAnimationRect;
  color: string;
  delay?: number;
  duration?: number;
  source?: boolean;
}) {
  return (
    <motion.div
      aria-hidden="true"
      data-effect-card-light
      style={{
        position: 'fixed',
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        borderRadius: 8,
        pointerEvents: 'none',
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: [0, 1, 0.65, 0] }}
      transition={{ duration, delay, times: [0, 0.16, 0.64, 1] }}
    >
      <div
        style={{
          position: 'absolute',
          inset: -1,
          borderRadius: 8,
          border: `1px solid ${color}c0`,
          boxShadow: `0 0 4px ${color}b0, 0 0 20px ${color}60, inset 0 0 16px ${color}30`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 8,
          overflow: 'hidden',
          mixBlendMode: 'screen',
        }}
      >
        <motion.div
          style={{
            position: 'absolute',
            inset: '-50% -80%',
            background: `linear-gradient(115deg, transparent 38%, ${color}08 44%, ${color}75 49%, #fff9edb0 50%, ${color}30 53%, transparent 60%)`,
          }}
          initial={{ x: '-50%' }}
          animate={{ x: '50%' }}
          transition={{ duration: duration * 0.78, delay, ease: [0.25, 0.1, 0.4, 1] }}
        />
      </div>
      {!source &&
        [0, 1, 2, 3].map((i) => (
          <motion.span
            key={i}
            style={{
              position: 'absolute',
              left: `${i % 2 ? 92 : 8}%`,
              top: `${i < 2 ? 24 : 77}%`,
              width: i % 2 ? 5 : 3,
              height: i % 2 ? 5 : 3,
              background: '#fff9ef',
              boxShadow: `0 0 7px 2px ${color}`,
              clipPath: 'polygon(50% 0,62% 38%,100% 50%,62% 62%,50% 100%,38% 62%,0 50%,38% 38%)',
            }}
            initial={{ opacity: 0, scale: 0.4 }}
            animate={{ opacity: [0, 1, 0], scale: [0.4, 1.4, 0.6], y: [0, -5, -10] }}
            transition={{ delay: delay + 0.15 + i * 0.045, duration: 0.55 }}
          />
        ))}
    </motion.div>
  );
}
