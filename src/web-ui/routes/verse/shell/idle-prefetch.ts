/**
 * routes/verse/shell/idle-prefetch.ts — run warm-up work in the gaps the
 * operator leaves, never in front of them (unit C1; review 3.10.1).
 *
 *   createIdleGate()        "is the operator idle?" as a promise: the window
 *                           is shown, no input for `quietMs`, none of the
 *                           operator's reads in flight (`busy`), and — where
 *                           the browser can tell — an idle callback;
 *   runIdleSteps(steps)     the steps one at a time: each waits for the gate,
 *                           and the next starts only after the previous one
 *                           has FINISHED (its promise settled) plus `gapMs`.
 *
 * WHY A GATE AND NOT A TIMER. WebKit — so the desktop app's WKWebView — has
 * no requestIdleCallback. 3.10.1 first fell back to fixed timers there (1.5 s,
 * then a step every 400 ms counted from each step's kickoff, not its end), so
 * the warm-up started ~9 reads in about a second whatever the operator was
 * doing, and a chat opened two seconds after launch queued behind the 90-day
 * history and the reasoning digest. The gate instead measures the two things
 * that matter: the operator's hands (pointer, keys, wheel, touch — observed
 * in the capture phase, passively, never delayed) and the operator's reads
 * (the caller's `busy`, which the shell wires to the query cache's gate).
 * Every wait re-checks both, so warm-up work yields the moment the operator
 * does something and resumes only after a fresh quiet period.
 *
 * A HIDDEN document runs nothing: a wait parks on `visibilitychange`, and
 * coming back counts as input (a fresh quiet period — the operator is about
 * to act). Cancel stops everything still pending — timers, idle callbacks,
 * the visibility and input listeners — and resolves every open wait `false`;
 * a step already running finishes on its own. The runner cancels its gate
 * when the last step is done, so a finished warm-up listens to nothing.
 *
 * LAZY ONLY. Framework- and dependency-free, and never imported statically by
 * VerseApp: shell/warmup.ts (itself loaded with import()) is its only user,
 * so none of this costs chat first-paint bytes (VerseApp.first-paint.test.ts).
 */

type IdleWindow = Pick<Window, 'setTimeout' | 'clearTimeout'> & {
  requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

type GateDocument = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;

export interface IdleGateOptions {
  /** No operator input for this long before anything runs. */
  quietMs?: number;
  /** How often a wait re-checks `busy` once the quiet period is met. */
  pollMs?: number;
  /** True while the operator's own work is in flight (the shell: the query cache's gate). */
  busy?: () => boolean;
  /** requestIdleCallback's deadline, where it exists. */
  timeoutMs?: number;
  /** Test seams. */
  win?: IdleWindow;
  doc?: GateDocument;
  now?: () => number;
}

export interface IdleGate {
  /** Resolves true once the operator is idle; false if the gate is (or gets) cancelled first. */
  wait(): Promise<boolean>;
  /** A plain pause that cancel also ends (false). */
  pause(ms: number): Promise<boolean>;
  cancel(): void;
}

export const IDLE_QUIET_MS = 2_000;
export const IDLE_POLL_MS = 250;
export const IDLE_TIMEOUT_MS = 3_000;
export const IDLE_STEP_GAP_MS = 400;

/** What counts as the operator doing something. */
export const IDLE_INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

const LISTEN = { capture: true, passive: true } as const;

export function createIdleGate(options: IdleGateOptions = {}): IdleGate {
  const win = options.win ?? (window as IdleWindow);
  const doc = options.doc ?? document;
  const now = options.now ?? (() => Date.now());
  const quietMs = options.quietMs ?? IDLE_QUIET_MS;
  const pollMs = Math.max(1, options.pollMs ?? IDLE_POLL_MS);
  const busy = options.busy ?? (() => false);
  const timeoutMs = options.timeoutMs ?? IDLE_TIMEOUT_MS;

  let cancelled = false;
  // The gate is created at first paint: the quiet period counts from there.
  let lastInput = now();
  /** One abort per open wait / pause: disarms what it armed and settles it `false`. */
  const open = new Set<() => void>();

  const onInput = (): void => {
    lastInput = now();
  };
  for (const type of IDLE_INPUT_EVENTS) doc.addEventListener(type, onInput, LISTEN);

  const quietLeft = (): number => lastInput + quietMs - now();
  const idleNow = (): boolean => doc.visibilityState !== 'hidden' && quietLeft() <= 0 && !busy();

  function wait(): Promise<boolean> {
    if (cancelled) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let disarm = (): void => undefined;
      const abort = (): void => {
        disarm();
        resolve(false);
      };
      const done = (): void => {
        open.delete(abort);
        resolve(true);
      };
      open.add(abort);

      const check = (): void => {
        disarm = () => undefined;
        if (doc.visibilityState === 'hidden') {
          const onShown = (): void => {
            if (doc.visibilityState === 'hidden') return;
            doc.removeEventListener('visibilitychange', onShown);
            lastInput = now();
            check();
          };
          doc.addEventListener('visibilitychange', onShown);
          disarm = () => doc.removeEventListener('visibilitychange', onShown);
          return;
        }
        const left = quietLeft();
        if (left > 0 || busy()) {
          const id = win.setTimeout(check, left > 0 ? left : pollMs);
          disarm = () => win.clearTimeout(id);
          return;
        }
        if (typeof win.requestIdleCallback === 'function') {
          // Input or a read may have started while the browser was busy: re-check on the way out.
          const id = win.requestIdleCallback(() => (idleNow() ? done() : check()), { timeout: timeoutMs });
          disarm = () => win.cancelIdleCallback?.(id);
          return;
        }
        done();
      };
      check();
    });
  }

  function pause(ms: number): Promise<boolean> {
    if (cancelled) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let id = 0;
      const abort = (): void => {
        win.clearTimeout(id);
        resolve(false);
      };
      id = win.setTimeout(() => {
        open.delete(abort);
        resolve(true);
      }, ms);
      open.add(abort);
    });
  }

  function cancel(): void {
    if (cancelled) return;
    cancelled = true;
    for (const type of IDLE_INPUT_EVENTS) doc.removeEventListener(type, onInput, LISTEN);
    for (const abort of [...open]) abort();
    open.clear();
  }

  return { wait, pause, cancel };
}

export type IdleStep = (gate: IdleGate) => void | Promise<void>;

export interface IdleStepsOptions extends IdleGateOptions {
  /** Pause after one step has finished before the next waits for the gate. */
  gapMs?: number;
}

/**
 * Run `steps` in order, each once the operator is idle and only after the
 * previous one has settled (plus `gapMs`). A step receives the gate so it can
 * wait again between its own pieces of work. A step that throws or rejects is
 * skipped, never fatal. Returns a cancel that stops every step not yet started
 * and every wait a running step is parked on.
 */
export function runIdleSteps(steps: readonly IdleStep[], options: IdleStepsOptions = {}): () => void {
  const gate = createIdleGate(options);
  const gapMs = options.gapMs ?? IDLE_STEP_GAP_MS;
  void (async () => {
    for (const [index, step] of steps.entries()) {
      if (index > 0 && gapMs > 0 && !(await gate.pause(gapMs))) return;
      if (!(await gate.wait())) return;
      try {
        await step(gate);
      } catch {
        // Warm-up only: a step that fails costs the operator a skeleton later, nothing more.
      }
    }
    gate.cancel();
  })();
  return gate.cancel;
}
