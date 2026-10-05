/** One framing envelope for the camera and DOM interaction anchors. Wide short
 * windows preserve card height; extra horizontal room belongs to the wings. */
export const STAGE_COMPOSITION_ASPECT = 16 / 9;
export function stageCompositionWidth(width: number, height: number): number {
    return Math.min(width, height * STAGE_COMPOSITION_ASPECT);
}
