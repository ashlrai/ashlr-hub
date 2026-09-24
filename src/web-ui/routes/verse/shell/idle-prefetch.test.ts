/**
 * idle-prefetch — the shell's after-first-paint idle gate and step runner
 * (unit C1; review 3.10.1). Fake timers throughout; the WebKit case (no
 * requestIdleCallback — the desktop app) is the default window here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdleGate, IDLE_INPUT_EVENTS, IDLE_QUIET_MS, runIdleSteps } from './idle-prefetch.js';

/** A window WITHOUT requestIdleCallback — WebKit, so the desktop app's WKWebView. */
function webkitWindow() {
  return {
    setTimeout: ((cb: () => void, ms: number) => window.setTimeout(cb, ms)) as Window['setTimeout'],
    clearTimeout: ((id: number) => window.clearTimeout(id)) as Window['clearTimeout'],
  };
}

/** A window with a hand-cranked requestIdleCallback. */
function idleWindow() {
  const pending = new Map<number, () => void>();
  let next = 1;
  const win = {
    ...webkitWindow(),
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
    const due = [...pending.values()];
    pending.clear();
    for (const cb of due) cb();
  };
  return { win, idle, pending };
}

/** A document whose visibility and input the test controls, counting live listeners. */
function fakeDoc(initial: DocumentVisibilityState = 'visible') {
  const target = new EventTarget();
  const live = new Map<string, number>();
  const doc = {
    visibilityState: initial,
    addEventListener: vi.fn((type: string, fn: EventListener, options?: AddEventListenerOptions | boolean) => {
      live.set(type, (live.get(type) ?? 0) + 1);
      target.addEventListener(type, fn, options);
    }),
    removeEventListener: vi.fn((type: string, fn: EventListener, options?: EventListenerOptions | boolean) => {
      live.set(type, Math.max(0, (live.get(type) ?? 0) - 1));
      target.removeEventListener(type, fn, options);
    }),
  };
  const setVisibility = (state: DocumentVisibilityState) => {
    doc.visibilityState = state;
    target.dispatchEvent(new Event('visibilitychange'));
  };
  const input = (type: (typeof IDLE_INPUT_EVENTS)[number] = 'pointerdown') => target.dispatchEvent(new Event(type));
  const listeners = () => [...live.values()].reduce((a, b) => a + b, 0);
  return { doc: doc as unknown as Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>, setVisibility, input, listeners };
}

/** Track a promise's settlement without awaiting it. */
function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value: T | undefined } = { settled: false, value: undefined };
  void promise.then((value) => {
    state.settled = true;
    state.value = value;
  });
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createIdleGate', () => {
  it('without requestIdleCallback (WebKit): opens only after a quiet period counted from first paint', async () => {
    const { doc } = fakeDoc();
    const gate = createIdleGate({ win: webkitWindow(), doc });
    const wait = track(gate.wait());
    await vi.advanceTimersByTimeAsync(IDLE_QUIET_MS - 1);
    expect(wait.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(wait).toEqual({ settled: true, value: true });
    gate.cancel();
  });

  it('restarts the quiet period on every pointer, key, wheel and touch — the chat’s first actions go first', async () => {
    const { doc, input } = fakeDoc();
    const gate = createIdleGate({ win: webkitWindow(), doc });
    const wait = track(gate.wait());
    // Mason clicks a chat 1.9 s after launch, then presses a key 1 s later.
    await vi.advanceTimersByTimeAsync(1_900);
    input('pointerdown');
    await vi.advanceTimersByTimeAsync(1_000);
    input('keydown');
    await vi.advanceTimersByTimeAsync(IDLE_QUIET_MS - 1);
    expect(wait.settled).toBe(false);
    for (const type of IDLE_INPUT_EVENTS) {
      input(type);
      await vi.advanceTimersByTimeAsync(IDLE_QUIET_MS - 1);
      expect(wait.settled, type).toBe(false);
    }
    await vi.advanceTimersByTimeAsync(1);
    expect(wait).toEqual({ settled: true, value: true });
    gate.cancel();
  });

  it('yields while the operator’s reads are in flight, and opens once they are done', async () => {
    const { doc } = fakeDoc();
    let busy = true;
    const gate = createIdleGate({ win: webkitWindow(), doc, quietMs: 0, pollMs: 100, busy: () => busy });
    const wait = track(gate.wait());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(wait.settled).toBe(false);
    busy = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(wait).toEqual({ settled: true, value: true });
    gate.cancel();
  });

  it('with requestIdleCallback: quiet and not busy first, then one idle callback — re-checked on the way out', async () => {
    const { win, idle, pending } = idleWindow();
    const { doc, input } = fakeDoc();
    const gate = createIdleGate({ win, doc, quietMs: 500 });
    const wait = track(gate.wait());
    expect(win.requestIdleCallback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(win.requestIdleCallback).toHaveBeenCalledTimes(1);
    // Input lands while the browser was busy: the idle callback does not open the gate.
    input('keydown');
    idle();
    await vi.advanceTimersByTimeAsync(0);
    expect(wait.settled).toBe(false);
    expect(pending.size).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(win.requestIdleCallback).toHaveBeenCalledTimes(2);
    idle();
    await vi.advanceTimersByTimeAsync(0);
    expect(wait).toEqual({ settled: true, value: true });
    gate.cancel();
  });

  it('parks while the window is hidden; coming back starts a fresh quiet period', async () => {
    const { doc, setVisibility } = fakeDoc('hidden');
    const gate = createIdleGate({ win: webkitWindow(), doc, quietMs: 1_000 });
    const wait = track(gate.wait());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wait.settled).toBe(false);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(999);
    expect(wait.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(wait).toEqual({ settled: true, value: true });
    gate.cancel();
  });

  it('cancel settles every open wait and pause false, and drops every listener and timer', async () => {
    const { doc, listeners } = fakeDoc('hidden');
    const gate = createIdleGate({ win: webkitWindow(), doc });
    expect(listeners()).toBe(IDLE_INPUT_EVENTS.length);
    const hiddenWait = track(gate.wait());
    const pause = track(gate.pause(10_000));
    expect(listeners()).toBe(IDLE_INPUT_EVENTS.length + 1); // + the visibility wait
    gate.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(hiddenWait).toEqual({ settled: true, value: false });
    expect(pause).toEqual({ settled: true, value: false });
    expect(listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    // Later waits never open.
    expect(await gate.wait()).toBe(false);
    expect(await gate.pause(1)).toBe(false);
  });
});

describe('runIdleSteps', () => {
  it('runs one step at a time: the next waits for the last to FINISH, the gap, and the gate', async () => {
    const { doc } = fakeDoc();
    const started: number[] = [];
    const finish: Array<() => void> = [];
    const step = (i: number) => () => new Promise<void>((resolve) => {
      started.push(i);
      finish.push(resolve);
    });
    runIdleSteps([step(0), step(1), step(2)], { win: webkitWindow(), doc, quietMs: 1_000, gapMs: 400 });
    await vi.advanceTimersByTimeAsync(999);
    expect(started).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toEqual([0]);
    // Step 0 is still running: however long, nothing else starts.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(started).toEqual([0]);
    finish[0]!();
    await vi.advanceTimersByTimeAsync(399);
    expect(started).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toEqual([0, 1]);
    finish[1]!();
    await vi.advanceTimersByTimeAsync(400);
    expect(started).toEqual([0, 1, 2]);
  });

  it('an operator action between steps holds the next one for a full quiet period', async () => {
    const { doc, input } = fakeDoc();
    const ran: number[] = [];
    runIdleSteps([0, 1].map((i) => () => { ran.push(i); }), { win: webkitWindow(), doc, quietMs: 1_000, gapMs: 200 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ran).toEqual([0]);
    // Mid-gap: the operator presses a key.
    await vi.advanceTimersByTimeAsync(100);
    input('keydown');
    await vi.advanceTimersByTimeAsync(999);
    expect(ran).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(ran).toEqual([0, 1]);
  });

  it('hands each step the gate, so it can wait again between its own pieces of work', async () => {
    const { doc, input } = fakeDoc();
    const pieces: string[] = [];
    runIdleSteps([async (gate) => {
      pieces.push('a');
      if (await gate.wait()) pieces.push('b');
    }], { win: webkitWindow(), doc, quietMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pieces).toEqual(['a', 'b']); // idle already: no extra wait
    const gated: string[] = [];
    runIdleSteps([async (gate) => {
      gated.push('a');
      input('pointerdown');
      if (await gate.wait()) gated.push('b');
    }], { win: webkitWindow(), doc, quietMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(gated).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(gated).toEqual(['a', 'b']);
  });

  it('a step that throws or rejects is skipped, not fatal; a finished run listens to nothing', async () => {
    const { doc, listeners } = fakeDoc();
    const after = vi.fn();
    runIdleSteps([() => { throw new Error('chunk failed'); }, () => Promise.reject(new Error('read failed')), after], { win: webkitWindow(), doc, quietMs: 0, gapMs: 0 });
    expect(listeners()).toBe(IDLE_INPUT_EVENTS.length);
    await vi.advanceTimersByTimeAsync(0);
    expect(after).toHaveBeenCalledTimes(1);
    expect(listeners()).toBe(0);
  });

  it('cancel stops every step not yet started and the wait a running step is parked on', async () => {
    const { doc, input, listeners } = fakeDoc();
    const pieces: string[] = [];
    const cancel = runIdleSteps([
      async (gate) => {
        pieces.push('0a');
        input('keydown');
        if (await gate.wait()) pieces.push('0b');
      },
      () => { pieces.push('1'); },
    ], { win: webkitWindow(), doc, quietMs: 1_000, gapMs: 0 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pieces).toEqual(['0a']);
    cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pieces).toEqual(['0a']);
    expect(listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
