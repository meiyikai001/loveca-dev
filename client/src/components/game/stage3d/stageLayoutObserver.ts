/** Coalesce DOM changes; continue only while layout is settling or moving. */
export function createStageLayoutScheduler(sample: () => boolean, visible = () => !document.hidden) {
  let frame: number | null = null;
  let last = -Infinity;
  let disposed = false;
  const request = () => {
    if (!disposed && visible() && frame === null) frame = requestAnimationFrame(tick);
  };
  const tick = (now: number) => {
    frame = null;
    if (disposed || !visible()) return;
    if (now - last < 50) { request(); return; }
    last = now;
    if (sample()) request();
  };
  return {
    request,
    dispose() { disposed = true; if (frame !== null) cancelAnimationFrame(frame); frame = null; },
  };
}

/** Observe inputs, never our synchronous projection writes. No idle polling. */
export function observeStageLayout(root: HTMLElement, sample: () => boolean) {
  const field = '[data-stage3d-field]';
  const relevant = (node: Node) => {
    const element = node instanceof Element ? node : node.parentElement;
    return !!element && !element.closest('[data-stage3d-canvas]')
      && (element === root || !!element.closest(field) || !!element.querySelector(field));
  };
  const options = { subtree: true, childList: true, attributes: true, characterData: true };
  const observer = new MutationObserver(records => {
    if (records.some(record => relevant(record.target))) scheduler.request();
  });
  const scheduler = createStageLayoutScheduler(() => {
    // collectStage3dSnapshot temporarily removes projected transforms. Observing
    // those writes would turn a demand sampler back into a permanent loop.
    observer.disconnect();
    let changed: boolean;
    try { changed = sample(); } finally { observer.observe(root, options); }
    const moving = root.getAnimations({ subtree: true }).some(animation => {
      const effect = animation.effect;
      return animation.playState === 'running' && effect instanceof KeyframeEffect
        && effect.getTiming().iterations !== Infinity && !!effect.target && relevant(effect.target);
    });
    return changed || moving;
  });
  observer.observe(root, options);
  const resize = new ResizeObserver(scheduler.request);
  resize.observe(root);
  const wake = () => scheduler.request();
  const onEvent = (event: Event) => { if (event.target instanceof Node && relevant(event.target)) wake(); };
  const events = ['load', 'transitionrun', 'transitionend', 'transitioncancel', 'animationstart', 'animationend', 'animationcancel', 'pointerover', 'pointerout', 'focusin', 'focusout'];
  for (const name of events) root.addEventListener(name, onEvent, true);
  window.addEventListener('resize', wake);
  window.addEventListener('scroll', wake, true);
  document.addEventListener('visibilitychange', wake);
  scheduler.request();
  return {
    request: scheduler.request,
    dispose() {
      scheduler.dispose(); observer.disconnect(); resize.disconnect();
      for (const name of events) root.removeEventListener(name, onEvent, true);
      window.removeEventListener('resize', wake);
      window.removeEventListener('scroll', wake, true);
      document.removeEventListener('visibilitychange', wake);
    },
  };
}
