import { getStage3dCardDimensions, getStage3dProjectedQuad, getStage3dZonePose, STAGE3D_CARD_HEIGHT } from './geometry';
import type { Stage3dProjection, Stage3dSnapshot, Stage3dZone } from './types';

const centerX = (zone: Stage3dZone) => zone.rect.left + zone.rect.width / 2;

/** Match the inward LIVE edge to the inward end of that side's success column:
 * self uses its first slot, opponent its last. Move only the central field
 * (and self resources) through layout anchors; success columns remain fixed.
 * Subtract the already-applied shift so later samples cannot accumulate it.
 */
export function getStage3dFieldAdjustment(snapshot: Stage3dSnapshot, projection: Stage3dProjection,
  side: 'self' | 'opponent', appliedAdjustment: number): number | null {
  const live = snapshot.zones.find(zone => zone.outlined && zone.side === side && zone.kind === 'live');
  const successColumn = snapshot.zones.filter(zone => zone.outlined && zone.side === side && zone.kind === 'success')
    .sort((a, b) => a.rect.top - b.rect.top);
  const success = side === 'self' ? successColumn[0] : successColumn.at(-1);
  if (!live || !success) return null;
  const livePose = getStage3dZonePose(live, projection, snapshot);
  const successPose = getStage3dZonePose(success, projection, snapshot);
  if (!livePose || !successPose) return null;
  let depth = successPose.position.z;
  if (side === 'opponent') {
    const selfSuccess = snapshot.zones.filter(zone => zone.outlined && zone.side === 'self' && zone.kind === 'success')
      .sort((a, b) => a.rect.top - b.rect.top)[0];
    const selfPose = selfSuccess && getStage3dZonePose(selfSuccess, projection, snapshot);
    // Short viewports can put the two side columns at overlapping depths. Keep
    // the LIVE inlays separate: .19 padding each, plus .12 visible floor gap.
    if (selfPose) depth = Math.min(depth, selfPose.position.z - livePose.width - .5);
  }
  const aligned = projection.worldToScreen({ ...livePose.position, z: depth });
  const baselineY = live.rect.top + live.rect.height / 2 - appliedAdjustment;
  const adjustment = aligned.y - baselineY;
  return Number.isFinite(adjustment) ? adjustment : null;
}

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
