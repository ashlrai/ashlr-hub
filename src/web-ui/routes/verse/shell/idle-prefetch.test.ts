/**
 * idle-prefetch — the shell's after-first-paint warm-up scheduler (unit C1).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDLE_FALLBACK_MS, scheduleIdleSteps, whenIdle } from './idle-prefetch.js';

/** A window with a hand-cranked requestIdleCallback. */
function idleWindow() {
  const pending = new Map<number, () => void>();
  let next = 1;
  const win = {
    setTimeout: ((cb: () => void, ms: number) => window.setTimeout(cb, ms)) as Window['setTimeout'],
    clearTimeout: ((id: number) => window.clearTimeout(id)) as Window['clearTimeout'],
    requestIdleCallback: vi.fn((cb: () => void) => {
      const id = next++;
      pending.set(id, cb);
      return id;
    }),
    cancelIdleCallback: vi.fn((id: number) => {
      pending.delete(id);
    }),
  };
  /** Fire every idle callback currently queued. */
  const idle = () => {
    const due = [...pending.entries()];
    pending.clear();
    for (const [, cb] of due) cb();
  };
  return { win, idle, pending };
}

/** A document whose visibility the test controls. */
function visibilityDoc(initial: DocumentVisibilityState = 'visible') {
  const target = new EventTarget();
  const doc = {
    visibilityState: initial,
    addEventListener: vi.fn((type: string, fn: EventListener) => target.addEventListener(type, fn)),
    removeEventListener: vi.fn((type: string, fn: EventListener) => target.removeEventListener(type, fn)),
  };
  const set = (state: DocumentVisibilityState) => {
    doc.visibilityState = state;
    target.dispatchEvent(new Event('visibilitychange'));
  };
  return { doc: doc as unknown as Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>, set, raw: doc };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('whenIdle', () => {
  it('uses requestIdleCallback with a deadline, and falls back to a timeout where it is missing', () => {
    const { win, idle } = idleWindow();
    const run = vi.fn();
    whenIdle(run, { win, timeoutMs: 2_000 });
    expect(win.requestIdleCallback).toHaveBeenCalledWith(run, { timeout: 2_000 });
    idle();
    expect(run).toHaveBeenCalledTimes(1);

    const late = vi.fn();
    const noIdle = { setTimeout: win.setTimeout, clearTimeout: win.clearTimeout };
    whenIdle(late, { win: noIdle });
    vi.advanceTimersByTime(IDLE_FALLBACK_MS - 1);
    expect(late).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(late).toHaveBeenCalledTimes(1);
  });
});

describe('scheduleIdleSteps', () => {
  it('runs one step per idle period, a gap apart — never as one burst', () => {
    const { win, idle } = idleWindow();
    const { doc } = visibilityDoc();
    const ran: number[] = [];
    scheduleIdleSteps([0, 1, 2].map((i) => () => { ran.push(i); }), { win, doc, gapMs: 400 });
    expect(ran).toEqual([]);
    idle();
    expect(ran).toEqual([0]);
    idle(); // nothing queued during the gap
    expect(ran).toEqual([0]);
    vi.advanceTimersByTime(400);
    idle();
    expect(ran).toEqual([0, 1]);
    vi.advanceTimersByTime(400);
    idle();
    expect(ran).toEqual([0, 1, 2]);
    expect(win.requestIdleCallback).toHaveBeenCalledTimes(3);
  });

  it('without requestIdleCallback: the first step waits the fallback delay, later ones only the gap', () => {
    const { doc } = visibilityDoc();
    const win = { setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window) };
    const ran: number[] = [];
    scheduleIdleSteps([0, 1].map((i) => () => { ran.push(i); }), { win, doc, gapMs: 300 });
    vi.advanceTimersByTime(IDLE_FALLBACK_MS - 1);
    expect(ran).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ran).toEqual([0]);
    vi.advanceTimersByTime(299);
    expect(ran).toEqual([0]);
    // The gap, then a zero-delay "idle" (fake timers start a timer created
    // mid-tick 1 ms later) — not another full fallback delay.
    vi.advanceTimersByTime(2);
    expect(ran).toEqual([0, 1]);
  });

  it('runs nothing while the document is hidden, and resumes when it is shown', () => {
    const { win, idle } = idleWindow();
    const vis = visibilityDoc('hidden');
    const step = vi.fn();
    scheduleIdleSteps([step], { win, doc: vis.doc });
    idle();
    expect(step).not.toHaveBeenCalled();
    expect(vis.raw.addEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    vis.set('hidden');
    idle();
    expect(step).not.toHaveBeenCalled();
    vis.set('visible');
    idle();
    expect(step).toHaveBeenCalledTimes(1);
    expect(vis.raw.removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });

  it('cancel stops every step not yet started — the pending idle, the gap and the visibility wait', () => {
    const { win, idle, pending } = idleWindow();
    const { doc } = visibilityDoc();
    const ran: number[] = [];
    const cancel = scheduleIdleSteps([0, 1, 2].map((i) => () => { ran.push(i); }), { win, doc, gapMs: 100 });
    cancel();
    expect(win.cancelIdleCallback).toHaveBeenCalledTimes(1);
    expect(pending.size).toBe(0);
    idle();
    vi.runAllTimers();
    expect(ran).toEqual([]);

    // Mid-gap.
    const second = scheduleIdleSteps([0, 1].map((i) => () => { ran.push(10 + i); }), { win, doc, gapMs: 100 });
    idle();
    expect(ran).toEqual([10]);
    second();
    vi.runAllTimers();
    idle();
    expect(ran).toEqual([10]);

    // While waiting for the window to be shown.
    const vis = visibilityDoc('hidden');
    const third = scheduleIdleSteps([() => { ran.push(99); }], { win, doc: vis.doc });
    idle();
    third();
    expect(vis.raw.removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    vis.set('visible');
    idle();
    expect(ran).toEqual([10]);
  });

  it('a step that throws is skipped, not fatal', () => {
    const { win, idle } = idleWindow();
    const { doc } = visibilityDoc();
    const after = vi.fn();
    scheduleIdleSteps([() => { throw new Error('chunk failed'); }, after], { win, doc, gapMs: 0 });
    idle();
    vi.advanceTimersByTime(0);
    idle();
    expect(after).toHaveBeenCalledTimes(1);
  });
});
