import { useRef } from 'react';
import { motion, useAnimationFrame, useMotionValue } from 'framer-motion';
import { interpolateRecoveryPose, measureRecoveryHandPose } from '@/lib/recoveryCardMotion';
import type { BattleAnimationRect } from '@/lib/battleAnimationEvents';
import { RECOVERY_CARD_MOVE_DURATION_MS } from '@/lib/battleAnimationSequencing';
import { EffectCardLight } from './EffectLight';

/** Receives the already visibility-filtered image from MovingCard. Never resolves a card identity. */
export function RecoveryCardMotion({
  objectId,
  from,
  startRotate,
  imagePath,
  imageAlt,
  onDone,
}: {
  objectId: string;
  from: BattleAnimationRect;
  startRotate: number;
  imagePath: string;
  imageAlt: string;
  onDone: () => void;
}) {
  const left = useMotionValue(from.left),
    top = useMotionValue(from.top);
  const width = useMotionValue(from.width),
    height = useMotionValue(from.height);
  const rotation = useMotionValue(startRotate),
    opacity = useMotionValue(0);
  const finish = useRef(onDone);
  finish.current = onDone;
  const completed = useRef(false);
  useAnimationFrame((elapsed) => {
    if (completed.current) return;
    const progress = Math.min(1, elapsed / RECOVERY_CARD_MOVE_DURATION_MS);
    const liveTarget = measureRecoveryHandPose(objectId);
    // If the user has already moved the card again, give the real board ownership immediately.
    if (!liveTarget) {
      completed.current = true;
      finish.current();
      return;
    }
    const pose = interpolateRecoveryPose({ ...from, rotation: startRotate }, liveTarget, progress);
    left.set(pose.left);
    top.set(pose.top);
    width.set(pose.width);
    height.set(pose.height);
    rotation.set(pose.rotation);
    opacity.set(Math.min(1, progress / 0.08));
    if (progress >= 1) {
      completed.current = true;
      finish.current();
    }
  });
  const color = '#bfeee1';
  return (
    <div data-effect-recovery aria-hidden="true">
      <EffectCardLight rect={from} color={color} duration={0.28} source />
      <motion.div
        data-effect-recovery-card
        className="fixed overflow-hidden rounded-lg"
        style={{
          left,
          top,
          width,
          height,
          rotate: rotation,
          opacity,
          border: '1px solid #effff5',
          transformOrigin: 'center',
          willChange: 'transform, opacity',
          boxShadow: `0 8px 20px #11172260, 0 0 5px ${color}, 0 0 18px ${color}65`,
        }}
      >
        <img
          src={imagePath}
          alt={imageAlt}
          draggable={false}
          className="h-full w-full object-cover"
        />
        <motion.div
          style={{
            position: 'absolute',
            inset: '-40%',
            mixBlendMode: 'screen',
            background: `linear-gradient(110deg,transparent 42%,${color}80 49%,#ffffff90 50%,transparent 58%)`,
          }}
          initial={{ x: '-60%' }}
          animate={{ x: '65%' }}
          transition={{ duration: (RECOVERY_CARD_MOVE_DURATION_MS / 1000) * 0.85, ease: 'easeOut' }}
        />
      </motion.div>
    </div>
  );
}
