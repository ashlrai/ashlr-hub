/**
 * warmup — what the shell warms after first paint (unit C1; review 3.10.1):
 * the order, the idle gating against the operator's own reads, the one-read
 * concurrency, and — end to end through VerseApp — that a first visit to a
 * warmed surface really paints without a skeleton.
 *
 * The end-to-end half lives in THIS file, not VerseApp.test.tsx, on purpose:
 * VerseApp keeps its section loads for the life of the module, and that file
 * visits Growth, Fleet and Mind long before any warm-up test could run, which
 * made "no skeleton" pass whether or not the warm-up loaded a single chunk.
 * Here nothing else mounts VerseApp, and the test first proves it (the
 * PRECONDITION and CONTROL below) before it believes a missing skeleton.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { clearMutationToken, markCheckComplete } from '../../../data/auth-store.js';
import { evictAll, queryGateStats, runQuery } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { MockEventSource } from '../fixtures.test-support.js';
import { resetVerseStore } from '../verse-store.js';
import { getVerseUiState, landedModule, resetVerseUi, setVerseSection, type VerseSectionId } from '../verse-ui-store.js';
import { prefetchAfterFirstPaint, SECTION_MODULES, VerseApp } from '../VerseApp.js';
import { resetCommandBus } from './command-bus.js';
import { resetGuard } from './guarded-action.js';
import { activity, shellFetch, type ShellFetch } from './shell-fixtures.test-support.js';
import { resetActivityForTest } from './useActivity.js';
import { warmUpAfterFirstPaint, type WarmupOptions } from './warmup.js';

/** What VerseApp passes: any read running or queued in the cache's gate. */
const readsInFlight = () => {
  const gate = queryGateStats();
  return gate.active + gate.queued > 0;
};

/** Fast gate for tests: no quiet period, no gap, quick busy re-checks (jsdom has no requestIdleCallback). */
const FAST: WarmupOptions = { quietMs: 0, gapMs: 0, pollMs: 5 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A deferred value: a read the test finishes when it chooses. */
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * The surfaces' routes (command/fetch-stub), but every warm-up read is HELD
 * until the test releases it — or, once `auto()` is on, answers on the next
 * tick — and the peak number in flight at once is recorded.
 */
function heldSurfaceFetch() {
  const { fetchMock: answer } = stubSurfaceFetch({ kind: 'live' });
  const held: Array<() => void> = [];
  let auto = false;
  let inFlight = 0;
  let peak = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise<void>((release) => {
      if (auto) setTimeout(release, 1);
      else held.push(release);
    });
    inFlight -= 1;
    return (answer as unknown as typeof fetch)(input, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    held,
    peak: () => peak,
    paths: () => fetchMock.mock.calls.map(([input]) => String(input)),
    auto: () => {
      auto = true;
      for (const release of held.splice(0)) release();
    },
  };
}

describe('warmUpAfterFirstPaint', () => {
  let cancel: (() => void) | null = null;
  beforeEach(() => {
    evictAll();
    resetVerseUi();
  });
  afterEach(() => {
    cancel?.();
    cancel = null;
    vi.unstubAllGlobals();
  });

  it('warms the overlay chunks one at a time, then each rail surface not yet open — its chunk before its reads — in rail order', async () => {
    const net = heldSurfaceFetch();
    net.auto();
    // Fleet is already open behind Chat (keep-alive): its reads are live, so it is skipped.
    setVerseSection('fleet');
    setVerseSection('chat');
    expect(getVerseUiState().mounted).toEqual(expect.arrayContaining(['chat', 'fleet']));
    const log: string[] = [];
    const overlay = (name: string) => vi.fn(async () => { log.push(`overlay ${name}`); });
    const readsBefore = new Map<VerseSectionId, string[]>();
    const loadSection = vi.fn(async (id: VerseSectionId) => {
      log.push(`chunk ${id}`);
      readsBefore.set(id, net.paths());
    });
    cancel = warmUpAfterFirstPaint({ loadSection, overlays: [overlay('palette'), overlay('drawer'), overlay('shortcuts')], readsInFlight }, FAST);
    await vi.waitFor(() => expect(net.paths().some((p) => p.startsWith('/api/reasoning/digest'))).toBe(true), { timeout: 5_000 });
    expect(log).toEqual(['overlay palette', 'overlay drawer', 'overlay shortcuts', 'chunk command', 'chunk growth', 'chunk mind']);
    expect(loadSection).not.toHaveBeenCalledWith('fleet');
    expect(loadSection).not.toHaveBeenCalledWith('chat');
    // No read before the first surface's chunk; Command's reads all out before
    // Growth's chunk. (No seat history: the burn-downs moved to Usage, audit 14.)
    expect(readsBefore.get('command')).toEqual([]);
    const beforeGrowth = readsBefore.get('growth') ?? [];
    for (const path of ['/api/verse/authority', '/api/verse/fleet/live', '/api/verse/leader', '/api/verse/learning', '/api/verse/fleet/history', '/api/verse/budget']) {
      expect(beforeGrowth.some((p) => p.startsWith(path)), path).toBe(true);
    }
  });

  it('never starts while an operator read is running, and holds at most ONE warm-up read in flight', async () => {
    const net = heldSurfaceFetch();
    const loadSection = vi.fn(async () => undefined);
    const overlay = vi.fn(async () => undefined);

    // The operator's first read (the chat's session roots, say) is still out.
    const first = deferred();
    void runQuery('operator:first', () => first.promise);
    cancel = warmUpAfterFirstPaint({ loadSection, overlays: [overlay], readsInFlight }, FAST);
    await sleep(60);
    expect(overlay).not.toHaveBeenCalled();
    expect(loadSection).not.toHaveBeenCalled();
    expect(net.fetchMock).not.toHaveBeenCalled();

    first.resolve({ ok: true });
    await vi.waitFor(() => expect(net.fetchMock).toHaveBeenCalledTimes(1));
    expect(overlay).toHaveBeenCalledTimes(1);
    expect(loadSection).toHaveBeenCalledWith('command');

    // Mid-warm-up the operator acts: their read goes first, the warm-up's next one waits it out.
    const second = deferred();
    void runQuery('operator:second', () => second.promise);
    net.held.shift()!();
    await sleep(60);
    expect(net.fetchMock).toHaveBeenCalledTimes(1);
    second.resolve({ ok: true });
    await vi.waitFor(() => expect(net.fetchMock).toHaveBeenCalledTimes(2));

    // Let the rest run: one read at a time, start to finish.
    net.auto();
    await vi.waitFor(() => expect(net.paths().some((p) => p.startsWith('/api/reasoning/digest'))).toBe(true), { timeout: 5_000 });
    expect(net.peak()).toBe(1);
  });

  it('cancel stops the warm-up between reads', async () => {
    const net = heldSurfaceFetch();
    cancel = warmUpAfterFirstPaint({ loadSection: async () => undefined, overlays: [], readsInFlight }, FAST);
    await vi.waitFor(() => expect(net.fetchMock).toHaveBeenCalledTimes(1));
    cancel();
    net.auto();
    await sleep(60);
    expect(net.fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('the warm-up, end to end through VerseApp', () => {
  const surface = (id: string) => document.querySelector<HTMLElement>(`[data-surface="${id}"]`);
  /** Section modules the SHELL asked for, in order (VerseApp's loadSection is the only caller). */
  const requested: string[] = [];
  let net: ShellFetch;

  beforeAll(async () => {
    // Transform every section once up front (a cold one can outlast findBy's
    // window), THEN start recording: the preload itself is not the shell's.
    await Promise.all(Object.values(SECTION_MODULES).map((load) => load()));
    for (const [key, load] of Object.entries(SECTION_MODULES)) {
      SECTION_MODULES[key] = () => {
        requested.push(key);
        return load();
      };
    }
  }, 30_000);

  beforeEach(() => {
    window.history.replaceState(null, '', '/verse/');
    localStorage.clear();
    evictAll();
    resetVerseStore();
    resetVerseUi();
    resetCommandBus();
    resetGuard();
    clearMutationToken();
    MockEventSource.reset();
    vi.stubGlobal('EventSource', MockEventSource);
    net = shellFetch(activity());
    vi.stubGlobal('fetch', net.fetch);
    resetActivityForTest();
    markCheckComplete(true);
  });
  afterEach(() => {
    act(() => markCheckComplete(false));
    vi.unstubAllGlobals();
    resetActivityForTest();
    window.history.replaceState(null, '', '/');
  });

  it('a first visit to each warmed surface mounts it directly — no skeleton frame', async () => {
    render(<ToastProvider><VerseApp /></ToastProvider>);
    await screen.findByRole('navigation', { name: 'Chats' });
    const warmedIds = ['growth', 'mind', 'fleet'] as const;
    const modules = warmedIds.map((id) => `./sections/${landedModule(id)}.tsx`);

    // PRECONDITION: nothing has loaded these chunks yet, so a missing skeleton
    // below can only be the warm-up's doing.
    expect(requested.filter((key) => modules.includes(key))).toEqual([]);
    // CONTROL: a first visit to a lazy surface the warm-up does NOT cover
    // (a tray page) does paint the skeleton — the detector below is live.
    act(() => setVerseSection('settings'));
    expect(surface('settings')!.querySelector('[data-skeleton]')).not.toBeNull();
    act(() => setVerseSection('chat'));

    const cancel = prefetchAfterFirstPaint(FAST);
    try {
      // Each surface's reads go out only after its chunk has landed; Mind's digest is the last surface's.
      await waitFor(() => {
        const paths = net.fetch.mock.calls.map(([input]) => String(input));
        for (const path of ['/api/verse/budget', '/api/verse/overnight', '/api/verse/fleet/history', '/api/verse/learning', '/api/models', '/api/verse/leader', '/api/reasoning/digest']) {
          expect(paths.some((u) => u.startsWith(path)), path).toBe(true);
        }
      }, { timeout: 5_000 });
      // One load per chunk, however many warm-ups ran.
      for (const key of modules) expect(requested.filter((k) => k === key), key).toHaveLength(1);
      for (const id of warmedIds) {
        act(() => setVerseSection(id));
        expect(surface(id)!.querySelector('[data-skeleton]'), id).toBeNull();
      }
    } finally {
      cancel();
    }
  });
});
