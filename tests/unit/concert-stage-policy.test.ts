import { describe, expect, it } from 'vitest';
import { canPreviewConcertStage, concertStageUnavailableReason } from '../../client/src/lib/stage3dPolicy';
import { deriveBattleSurfaceCapabilities } from '../../client/src/store/battleSurfaceCapabilities';
import { GameMode } from '../../src/shared/types/enums';

describe('concert stage preview boundary', () => {
  it('allows an explicit preview in the existing local battle surfaces', () => {
    for (const gameMode of [GameMode.DEBUG, GameMode.SOLITAIRE]) {
      expect(canPreviewConcertStage(deriveBattleSurfaceCapabilities({ gameMode }))).toBe(true);
    }
  });

  it('does not change online, tutorial, spectator or replay rendering', () => {
    for (const remoteSessionSource of ['ONLINE', 'DEBUG', 'SOLITAIRE', 'SPECTATOR', 'TUTORIAL', 'AI_DEBUG'] as const) {
      expect(canPreviewConcertStage(deriveBattleSurfaceCapabilities({ gameMode: GameMode.DEBUG, remoteSessionSource }))).toBe(false);
    }
    expect(canPreviewConcertStage(deriveBattleSurfaceCapabilities({ gameMode: GameMode.DEBUG, replaySessionActive: true }))).toBe(false);
  });

  it('explains window, GPU and remote-mode fallbacks without silently hiding the choice', () => {
    const local = deriveBattleSurfaceCapabilities({ gameMode: GameMode.DEBUG });
    expect(concertStageUnavailableReason(local, true, true)).toBeNull();
    expect(concertStageUnavailableReason(local, false, true)).toContain('768 × 640');
    expect(concertStageUnavailableReason(local, true, false)).toContain('WebGL2');
    const remote = deriveBattleSurfaceCapabilities({ gameMode: GameMode.SOLITAIRE, remoteSessionSource: 'SOLITAIRE' });
    expect(concertStageUnavailableReason(remote, true, true)).toContain('双人调试');
  });
});
