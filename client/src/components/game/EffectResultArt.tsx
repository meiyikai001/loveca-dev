import { motion } from 'framer-motion';
import type { EffectFeedbackChange } from '@game/online';
import type { FeedbackPresentation } from '@/lib/effectFeedbackPresentation';
import { hasEffectFeedbackGlow } from '@/lib/effectFeedback';

/** The original soft bloom, attached to the card rather than a stale screen rectangle. */
function SoftGainLight({
  color,
  blade,
  lane,
  count,
}: {
  color: string;
  blade: boolean;
  lane: number;
  count: number;
}) {
  const delay = 0.15;
  // Mixed gains share a light/mote budget instead of whitening the illustration.
  const strength = 1 / count;
  const motes = Array.from({ length: count === 1 && blade ? 7 : 10 }, (_, i) => i).filter(
    (i) => i % count === lane
  );
  return (
    <div data-effect-gain-radiance={blade ? 'blade' : 'heart'}>
      <motion.div
        style={{
          position: 'absolute',
          inset: '-15% -25%',
          mixBlendMode: 'screen',
          background: `radial-gradient(ellipse at ${count === 1 ? 50 : 30 + (40 * lane) / (count - 1)}% 65%, ${color}85 0%, ${color}35 32%, ${color}0c 52%, transparent 70%)`,
        }}
        initial={{ opacity: 0, scale: 0.7 }}
        animate={{
          opacity: [0, 0.85 * strength, 0.5 * strength, 0],
          scale: [0.7, 1.05, 1.14, 1.22],
        }}
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
        animate={{ opacity: [0, strength, 0.65 * strength, 0] }}
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
            opacity: [0, 0.9 * strength, 0.6 * strength, 0],
            x: blade ? ['-75%', '0%', '55%', '75%'] : '0%',
            y: blade ? '0%' : ['30%', '0%', '-15%', '-30%'],
          }}
          transition={{ delay: delay + 0.05, duration: blade ? 0.7 : 1, times: [0, 0.3, 0.65, 1] }}
        />
      </div>
      {motes.map((i) => {
        const side = i % 2 ? 1 : -1;
        const x = (26 + (i % 3) * 9.5) * side;
        const y = -(14 + (i % 4) * 12);
        return (
          <motion.div
            key={i}
            style={{ position: 'absolute', inset: 0 }}
            initial={{ opacity: 0, x: `${x * 0.35}%`, y: '0%' }}
            animate={{
              opacity: [0, 0.95, 0.6, 0],
              x: [`${x * 0.35}%`, `${x * 0.75}%`, `${x}%`],
              y: ['0%', `${y * 0.5}%`, `${y}%`],
            }}
            transition={{ delay: delay + (i % 4) * 0.04, duration: 0.85, ease: 'easeOut' }}
          >
            <motion.span
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
              initial={{ scale: 0.5 }}
              animate={{ scale: [0.5, 1, 0.35] }}
              transition={{ delay: delay + (i % 4) * 0.04, duration: 0.85, ease: 'easeOut' }}
            />
          </motion.div>
        );
      })}
    </div>
  );
}

/** Every gain retains its own colour/kind; exact deltas remain in the upright overlay. */
export function EffectResultArt({
  item,
  colorFor,
}: {
  item: FeedbackPresentation;
  colorFor: (change: EffectFeedbackChange) => string;
}) {
  if (item.source)
    return (
      <motion.div
        data-effect-source-light
        className="effect-source-light"
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 0.7, 0] }}
        transition={{ duration: 0.4 }}
      />
    );
  if (!hasEffectFeedbackGlow(item.event.mode, item.target.changes)) return null;
  const gains = item.target.changes.filter(
    (change) => (change.kind === 'HEART' || change.kind === 'BLADE') && change.delta > 0
  );
  const others = item.target.changes.filter(
    (change) => change.kind !== 'ORIENTATION' && change.kind !== 'ENERGY' && !gains.includes(change)
  );
  return (
    <div
      className={'effect-result-art' + (item.target.objectId ? '' : ' effect-result-art--zone')}
      data-effect-result-art
      aria-hidden="true"
    >
      {gains.map((change, index) => (
        <SoftGainLight
          key={index}
          color={colorFor(change)}
          blade={change.kind === 'BLADE'}
          lane={index}
          count={gains.length}
        />
      ))}
      {others.length > 0 && (
        <svg className="effect-result-art" viewBox="0 0 100 140" preserveAspectRatio="none">
          {others.map((change, index) => (
            <motion.path
              key={index}
              d="M 30 95 Q 50 103 72 95"
              fill="none"
              stroke={colorFor(change)}
              strokeWidth="1.4"
              strokeLinecap="round"
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: [0, 1, 1], opacity: [0, 0.85, 0] }}
              transition={{ delay: 0.025 + Math.min(index, 4) * 0.035, duration: 0.65 }}
            />
          ))}
        </svg>
      )}
    </div>
  );
}
