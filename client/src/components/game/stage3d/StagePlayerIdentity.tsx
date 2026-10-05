import { memo, useLayoutEffect, useRef } from 'react';
import { Music2 } from 'lucide-react';
import type { Seat } from '@game/online';

interface StagePlayerIdentityProps {
  seat: Seat;
  name: string;
  handCount: number;
  active: boolean;
  opponent?: boolean;
}

/** Leave the fixed edge drawer a 64px corridor, even when the desk is offset or clipped. */
export function getStageIdentitySafeLeft(boardLeft: number, playerLeft: number, viewportLeft = 0) {
  return Math.max(16, Math.max(boardLeft, viewportLeft) - playerLeft + 64);
}

/** A neutral stage emblem; the player projection does not provide an avatar. */
export const StagePlayerIdentity = memo(function StagePlayerIdentity({
  seat,
  name,
  handCount,
  active,
  opponent = false,
}: StagePlayerIdentityProps) {
  const identityRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (opponent) return;
    const player = identityRef.current?.closest<HTMLElement>('.stage3d-player-area');
    const board = player?.closest<HTMLElement>('.concert-stage-board');
    if (!player || !board) return;
    const property = '--stage-hud-safe-left';
    const previous = player.style.getPropertyValue(property);
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const left = getStageIdentitySafeLeft(board.getBoundingClientRect().left,
        player.getBoundingClientRect().left, window.visualViewport?.offsetLeft ?? 0);
      player.style.setProperty(property, `${left}px`);
    };
    const schedule = () => {
      if (frame === null) frame = window.requestAnimationFrame(measure);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(board);
    observer?.observe(player);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (previous) player.style.setProperty(property, previous);
      else player.style.removeProperty(property);
    };
  }, [opponent]);

  return (
    <div
      ref={identityRef}
      className={`stage-player-identity stage-player-identity-${opponent ? 'opponent' : 'self'}`}
      data-player-identity-seat={seat}
      data-active={active ? 'true' : 'false'}
    >
      <div className="stage-player-emblem" data-player-communication-seat={seat}>
        <Music2 size={24} strokeWidth={1.4} aria-hidden="true" />
      </div>
      <div className="stage-player-identity-copy">
        <span className="stage-player-name" title={name}>{name}</span>
        <span className="stage-player-hand-count">手牌 <strong>{handCount}</strong></span>
      </div>
    </div>
  );
});
