import { getStage3dCardDimensions, getStage3dProjectedQuad, STAGE3D_CARD_HEIGHT } from './geometry';
import type { Stage3dProjection, Stage3dSnapshot, Stage3dZone } from './types';

const centerX = (zone: Stage3dZone) => zone.rect.left + zone.rect.width / 2;

function memberEdges(zone: Stage3dZone, x: number, projection: Stage3dProjection) {
  const position = projection.screenToWorld({ x, y: zone.rect.top + zone.rect.height / 2 }, 0);
  if (!position) return null;
  const quad = getStage3dProjectedQuad({
    position: { ...position, y: STAGE3D_CARD_HEIGHT },
    ...getStage3dCardDimensions('member'), rotation: 0,
  }, projection);
  const xs = quad.map(point => point.x);
  return { left: Math.min(...xs), right: Math.max(...xs) };
}

function memberGap(row: readonly Stage3dZone[], step: number | null, projection: Stage3dProjection) {
  const center = centerX(row[1]!);
  const edges = row.map((zone, index) => memberEdges(zone,
    step === null ? centerX(zone) : center + (index - 1) * step, projection));
  if (edges.some(edge => !edge)) return null;
  return ((edges[1]!.left - edges[0]!.right) + (edges[2]!.left - edges[1]!.right)) / 2;
}

/** Equalize visible member edge gaps through their CSS layout anchors. The
 * unmodified self row supplies the baseline, so sampling cannot accumulate an
 * earlier opponent adjustment. LIVE, underlays and badges follow that same gap.
 */
export function getStage3dOpponentColumnGapAdjustment(snapshot: Stage3dSnapshot, projection: Stage3dProjection): number | null {
  const row = (side: 'self' | 'opponent') => snapshot.zones
    .filter(zone => zone.outlined && zone.kind === 'member' && zone.side === side)
    .sort((a, b) => centerX(a) - centerX(b));
  const self = row('self'), opponent = row('opponent');
  if (self.length !== 3 || opponent.length !== 3) return null;
  const selfStep = (centerX(self[2]!) - centerX(self[0]!)) / 2;
  const baselineStep = selfStep - self[1]!.rect.width + opponent[1]!.rect.width;
  const selfGap = memberGap(self, null, projection);
  const opponentGap = memberGap(opponent, baselineStep, projection);
  const expandedGap = memberGap(opponent, baselineStep + 1, projection);
  if (selfGap === null || opponentGap === null || expandedGap === null) return null;
  // Horizontal perspective is linear at a fixed row depth. Measure its actual
  // response to one screen pixel instead of assuming a camera angle or scale.
  const response = expandedGap - opponentGap;
  const adjustment = (selfGap - opponentGap) / response;
  return response > 0 && Number.isFinite(adjustment) ? adjustment : null;
}
