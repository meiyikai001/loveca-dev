import { getCardAbilityDefinitions } from '@game/application/card-effect-runner';
import { getBaseCardCode } from '@game/shared/utils/card-code';

export type CardEffectVisualState = 'none' | 'automated' | 'actionable';

const markerFlag = (import.meta.env.VITE_CARD_EFFECT_VISUAL_MARKERS as string | undefined)
  ?.trim()
  .toLowerCase();

// Coverage markers are now a development opt-in; shipped cards already have
// their effects implemented. Gameplay selection/activation hints are separate.
export const CARD_EFFECT_VISUAL_MARKERS_ENABLED =
  markerFlag === 'true' || markerFlag === '1' || markerFlag === 'on';

const SUPPLEMENTAL_AUTOMATED_EFFECT_BASE_CARD_CODES = new Set([
  // Cost-calculator-only effect: no queued/activated ability definition exists for this card.
  'LL-bp2-001',
]);

export function hasAutomatedCardEffect(cardCode: string): boolean {
  if (!CARD_EFFECT_VISUAL_MARKERS_ENABLED) {
    return false;
  }

  if (getCardAbilityDefinitions(cardCode).some((definition) => definition.implemented)) {
    return true;
  }

  return SUPPLEMENTAL_AUTOMATED_EFFECT_BASE_CARD_CODES.has(getBaseCardCode(cardCode));
}

export function getCardEffectVisualState({
  cardCode,
  isFaceUp,
  isActionableNow,
}: {
  readonly cardCode: string;
  readonly isFaceUp: boolean;
  readonly isActionableNow: boolean;
}): CardEffectVisualState {
  if (!isFaceUp || !hasAutomatedCardEffect(cardCode)) {
    return 'none';
  }

  return isActionableNow ? 'actionable' : 'automated';
}
