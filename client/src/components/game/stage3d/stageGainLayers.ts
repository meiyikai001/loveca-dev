import type { EffectFeedbackChange, EffectFeedbackPublicEvent } from '@game/online';

export interface StageGainLayer {
  readonly kind: 'HEART' | 'BLADE' | 'SOURCE';
  readonly color: string;
  readonly delay: number;
  readonly strength: number;
}
const COLORS: Record<string, string> = {
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

/** Independent gain kinds remain visible; decorative motes never encode a numerical count. */
export function buildStageGainLayers(
  mode: EffectFeedbackPublicEvent['mode'],
  changes: readonly EffectFeedbackChange[],
  source = false
): StageGainLayer[] {
  if (source) return [{ kind: 'SOURCE', color: '#d7c8ff', delay: 0, strength: 1 }];
  if (mode !== 'APPLIED') return [];
  const gains: { kind: 'HEART' | 'BLADE'; color: string }[] = [];
  for (const change of changes) {
    if ((change.kind === 'HEART' || change.kind === 'BLADE') && change.delta > 0) {
      gains.push({
        kind: change.kind,
        color: 'color' in change ? COLORS[change.color]! : '#d7c8ff',
      });
    }
  }
  return gains.map((change, lane) => ({
    kind: change.kind,
    color: change.color,
    delay: lane * 75,
    strength: 1 / Math.sqrt(gains.length),
  }));
}
