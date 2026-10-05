/** A presentation skin shared by visible backs and their moving Three counterparts. */
export const STAGE_CARD_BACK = new URL('./assets/concert-card-back.svg', import.meta.url).href;

export function stageCardTextureUrl(url: string): string {
    if (url === '/back.jpg') return STAGE_CARD_BACK;
    if (typeof document !== 'undefined' && new URL(url, document.baseURI).pathname === '/back.jpg') return STAGE_CARD_BACK;
    return url;
}
