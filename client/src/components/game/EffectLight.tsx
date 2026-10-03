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

/** Local light blooms: soft motes for HEART, sharper facets for BLADE. */
export function EffectGainRadiance({
  rect,
  color,
  blade,
  delay = 0.15,
}: {
  rect: BattleAnimationRect;
  color: string;
  blade: boolean;
  delay?: number;
}) {
  return (
    <div
      data-effect-gain-radiance={blade ? 'blade' : 'heart'}
      style={{
        position: 'fixed',
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        pointerEvents: 'none',
        borderRadius: 8,
      }}
    >
      <motion.div
        style={{
          position: 'absolute',
          inset: '-15% -25%',
          mixBlendMode: 'screen',
          background: `radial-gradient(ellipse at 50% 65%, ${color}85 0%, ${color}35 32%, ${color}0c 52%, transparent 70%)`,
        }}
        initial={{ opacity: 0, scale: 0.7 }}
        animate={{ opacity: [0, 0.85, 0.5, 0], scale: [0.7, 1.05, 1.14, 1.22] }}
        transition={{ delay, duration: 1.05, times: [0, 0.24, 0.6, 1] }}
      />
      <motion.div
        style={{
          position: 'absolute',
          inset: -2,
          borderRadius: 9,
          border: `1px solid ${color}`,
          boxShadow: `0 0 7px ${color}a0, 0 0 24px ${color}60, inset 0 0 22px ${color}55`,
          maskImage: 'linear-gradient(transparent 2%,black 38%,black 88%,transparent)',
        }}
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 1, 0.65, 0] }}
        transition={{ delay, duration: 1.05, times: [0, 0.2, 0.65, 1] }}
      />
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: 8 }}>
        <motion.div
          style={{
            position: 'absolute',
            inset: '-35%',
            mixBlendMode: 'screen',
            background: blade
              ? `linear-gradient(125deg,transparent 39%,${color}30 45%,#fff9edb0 48%,${color}70 50%,transparent 57%)`
              : `radial-gradient(ellipse at 50% 65%,#fff8e880,${color}50 25%,transparent 64%)`,
          }}
          initial={{ opacity: 0, x: blade ? '-75%' : '0%', y: blade ? '0%' : '30%' }}
          animate={{
            opacity: [0, 0.9, 0.6, 0],
            x: blade ? ['-75%', '0%', '55%', '75%'] : '0%',
            y: blade ? '0%' : ['30%', '0%', '-15%', '-30%'],
          }}
          transition={{ delay: delay + 0.05, duration: blade ? 0.7 : 1, times: [0, 0.3, 0.65, 1] }}
        />
      </div>
      {Array.from({ length: blade ? 7 : 10 }, (_, i) => {
        const side = i % 2 ? 1 : -1;
        const x = (0.26 + (i % 3) * 0.095) * rect.width * side;
        const y = -(0.14 + (i % 4) * 0.12) * rect.height;
        return (
          <motion.span
            key={i}
            style={{
              position: 'absolute',
              left: '50%',
              top: '72%',
              width: blade ? 3 : i % 3 === 0 ? 7 : 4,
              height: blade ? 15 + (i % 3) * 7 : i % 3 === 0 ? 7 : 4,
              background: blade
                ? `linear-gradient(transparent, #fffaf0, ${color}, transparent)`
                : '#fff9ec',
              borderRadius: blade ? 2 : '50%',
              boxShadow: `0 0 6px ${color}, 0 0 12px ${color}80`,
              rotate: blade ? side * (22 + (i % 3) * 12) : 0,
              clipPath:
                !blade && i % 3 === 0
                  ? 'polygon(50% 0,62% 38%,100% 50%,62% 62%,50% 100%,38% 62%,0 50%,38% 38%)'
                  : undefined,
            }}
            initial={{ opacity: 0, x: x * 0.35, y: 0, scale: 0.5 }}
            animate={{
              opacity: [0, 0.95, 0.6, 0],
              x: [x * 0.35, x * 0.75, x],
              y: [0, y * 0.5, y],
              scale: [0.5, 1, 0.35],
            }}
            transition={{ delay: delay + (i % 4) * 0.04, duration: 0.85, ease: 'easeOut' }}
          />
        );
      })}
    </div>
  );
}
