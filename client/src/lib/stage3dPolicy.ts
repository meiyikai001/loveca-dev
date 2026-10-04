import type { BattleSurfaceCapabilities } from '@/store/battleSurfaceCapabilities';

const STORAGE_KEY = 'loveca-concert-stage-preview';
export const CONCERT_STAGE_VIEWPORT_QUERY = '(min-width: 768px) and (min-height: 640px)';

/** The first playable stage stays an explicit local preview. */
export function canPreviewConcertStage(capabilities: BattleSurfaceCapabilities) {
  return capabilities.authority === 'LOCAL' && !capabilities.isReadOnly &&
    ['LOCAL_DEBUG', 'SOLITAIRE'].includes(capabilities.surface);
}

export function concertStageUnavailableReason(
  capabilities: BattleSurfaceCapabilities,
  viewportFits: boolean,
  supported: boolean
): string | null {
  if (!canPreviewConcertStage(capabilities)) return '三维试作目前支持本机双人调试和离线对墙打，请从「双人调试」进入。';
  if (!viewportFits) return '请将窗口展开至至少 768 × 640，或在桌面浏览器中打开三维舞台。';
  if (!supported) return '当前浏览器无法使用三维舞台，请开启硬件加速后刷新，或换用支持 WebGL2 的浏览器。';
  return null;
}

export function readConcertStageEnabled(): boolean {
  try {
    const requested = new URLSearchParams(window.location.search).get('stage3d');
    return requested === '1' || (requested !== '0' && localStorage.getItem(STORAGE_KEY) === 'true');
  } catch {
    return false;
  }
}

export function saveConcertStageEnabled(enabled: boolean) {
  try { localStorage.setItem(STORAGE_KEY, String(enabled)); } catch { /* Session choice still works. */ }
}

export function supportsConcertStage() {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: true });
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch { return false; }
}
