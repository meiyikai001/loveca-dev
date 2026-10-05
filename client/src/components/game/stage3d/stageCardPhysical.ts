/** Shared presentation dimensions for static, dragged and animated cards. */
export const STAGE_CARD_GROUND_GAP = .003;
export const STAGE_PILE_PAPER_STEP = .009;
export const STAGE_FIELD_CARD_WIDTH = 1.4;

export function getStageCardThickness(width: number, height: number): number {
  return Math.max(.003, Math.min(.04, Math.min(width, height) * .017));
}

export function getStageCardRimHeight(width: number, height: number): number {
  return Math.min(width, height) * .028;
}

/** Leave room for the raised frame above the print as well as the paper body. */
export function getStageCardLayerStep(): number {
  const width = STAGE_FIELD_CARD_WIDTH, height = width * 1.4;
  return getStageCardThickness(width, height) + getStageCardRimHeight(width, height) + .008;
}

/** Public counts affect neutral paper volume, never card identities or artwork. */
export function getStagePileHeight(count: number, width: number, height: number): number {
  const cards = Math.max(0, Math.floor(count));
  return cards === 0 ? 0 : getStageCardThickness(width, height) + (cards - 1) * STAGE_PILE_PAPER_STEP;
}

export function getStageCardFaceHeight(width: number, height: number, layer = 0, pileCount?: number): number {
  const body = pileCount === undefined ? getStageCardThickness(width, height) : getStagePileHeight(pileCount, width, height);
  return STAGE_CARD_GROUND_GAP + body + Math.max(0, layer) * getStageCardLayerStep();
}
