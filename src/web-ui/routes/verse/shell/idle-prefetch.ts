/**
 * routes/verse/shell/idle-prefetch.ts — run warm-up work in the gaps the
 * operator leaves, never in front of them (unit C1).
 *
 *   whenIdle(run)            one idle callback, with a plain-timeout fallback
 *                            where requestIdleCallback does not exist (WebKit,
 *                            so the desktop app's WKWebView, and jsdom);
 *   scheduleIdleSteps(steps) the steps one at a time, each in its own idle
 *                            period and `gapMs` after the last, so warming
 *                            four surfaces never lands as one burst. Only the
 *                            FIRST step waits out the fallback delay (it is
 *                            what keeps the work behind first paint); later
 *                            ones are spaced by the gap alone where there is
 *                            no idle callback to wait for.
 *
 * A HIDDEN document runs nothing: the next step waits for the window to be
 * shown again (a minimised app has nobody to be fast for, and its requests
 * would only compete with the fleet's). Cancel stops everything still
 * pending — the pending idle / timeout, the visibility listener — and a step
 * already running finishes on its own; VerseApp cancels on unmount.
 *
 * Framework-free and dependency-free on purpose: it is on the chat
 * first-paint path (VerseApp imports it statically); the work it schedules is
 * what stays lazy.
 */

type IdleWindow = Pick<Window, 'setTimeout' | 'clearTimeout'> & {
  requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

export interface IdleOptions {
  /** requestIdleCallback's deadline: run by then even if the page never idles. */
  timeoutMs?: number;
  /** Where requestIdleCallback is missing: a plain delay. */
  fallbackMs?: number;
  /** Test seams. */
  win?: IdleWindow;
}

export interface IdleStepsOptions extends IdleOptions {
  /** Minimum pause after one step before the next is even scheduled. */
  gapMs?: number;
  doc?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
}

export const IDLE_TIMEOUT_MS = 3_000;
export const IDLE_FALLBACK_MS = 1_500;
export const IDLE_STEP_GAP_MS = 400;

/** Run `run` when the browser is idle (or after the fallback delay). Returns a cancel. */
export function whenIdle(run: () => void, options: IdleOptions = {}): () => void {
  const win = options.win ?? (window as IdleWindow);
  if (typeof win.requestIdleCallback === 'function') {
    const id = win.requestIdleCallback(run, { timeout: options.timeoutMs ?? IDLE_TIMEOUT_MS });
    return () => win.cancelIdleCallback?.(id);
  }
  const id = win.setTimeout(run, options.fallbackMs ?? IDLE_FALLBACK_MS);
  return () => win.clearTimeout(id);
}

/**
 * Run `steps` in order, one per idle period, `gapMs` apart, pausing while the
 * document is hidden. A step that throws is skipped, never fatal. Returns a
 * cancel that stops every step not yet started.
 */
export function scheduleIdleSteps(steps: ReadonlyArray<() => void>, options: IdleStepsOptions = {}): () => void {
  const win = options.win ?? (window as IdleWindow);
  const doc = options.doc ?? document;
  const gapMs = options.gapMs ?? IDLE_STEP_GAP_MS;
  let index = 0;
  let cancelled = false;
  let cancelPending: (() => void) | null = null;

  const waitUntilVisible = (): void => {
    const onChange = (): void => {
      if (doc.visibilityState === 'hidden') return;
      doc.removeEventListener('visibilitychange', onChange);
      cancelPending = null;
      scheduleNext();
    };
    doc.addEventListener('visibilitychange', onChange);
    cancelPending = () => doc.removeEventListener('visibilitychange', onChange);
  };

  const runStep = (): void => {
    cancelPending = null;
    if (cancelled || index >= steps.length) return;
    if (doc.visibilityState === 'hidden') {
      waitUntilVisible();
      return;
    }
    const step = steps[index]!;
    index += 1;
    try {
      step();
    } catch {
      // Warm-up only: a step that fails costs the operator a skeleton later, nothing more.
    }
    if (cancelled || index >= steps.length) return;
    const id = win.setTimeout(scheduleNext, gapMs);
    cancelPending = () => win.clearTimeout(id);
  };

  function scheduleNext(): void {
    if (cancelled || index >= steps.length) return;
    cancelPending = whenIdle(runStep, index === 0 ? options : { ...options, fallbackMs: 0 });
  }

  scheduleNext();
  return () => {
    cancelled = true;
    cancelPending?.();
    cancelPending = null;
  };
}
