/**
 * terminal/panel-stream.ts — the 3.15 panel's live frames.
 *
 * ONE CONNECTION FOR EVERY PANE. A browser allows about six connections per
 * origin and Verse already holds two (app events, the open chat), so a
 * stream per pane capped the panel at two panes. `createTerminalStreamMux`
 * keeps a single fetch() to `GET /api/verse/terminal/stream?tabs=id:seq,…`
 * whose frames are tagged with their tab, and hands each pane its own:
 *
 *   - subscribe/unsubscribe are batched (a group switch is many of each in
 *     one React commit) into ONE reconnect with the new set; every tab
 *     resumes past its own last seq, so nothing is lost or drawn twice;
 *   - a drop reconnects with backoff, a 401 renews the read session once,
 *     a `gone` frame ends that one tab's subscription;
 *   - a server without the multiplexed route (404 / 400: an older sidecar)
 *     falls back to the per-tab stream below, pane by pane.
 *
 * The per-tab stream is the dock's 3.10 connection — fetch() with the
 * read-client header (not EventSource: the read boundary accepts the client
 * proof as a query parameter only on the EventSource paths it knows), resume
 * with `?after=<last seq>` — with a parser that also reads the shell
 * integration's frames (`block`, `cwd`, `integration`).
 */
import type { VerseTerminalBlock, VerseTerminalShellIntegration, VerseTerminalStreamFrame } from '../../../data/api-types.js';
import { VERSE_TERMINAL_STREAM_PATH } from '../../../../core/verse/workbench-types.js';
import { getReadClientProof, renewReadSession } from '../../../data/auth-store.js';
import { terminalStreamPath } from '../dock/terminal/terminal-client.js';
import { parseTerminalSseBlock, type TerminalStreamDeps, type TerminalStreamHandlers as BaseHandlers, type TerminalStreamState } from '../dock/terminal/terminal-stream.js';

export type { TerminalStreamState };

export interface PanelStreamHandlers {
  onFrame: (frame: VerseTerminalStreamFrame) => void;
  onState?: BaseHandlers['onState'];
}

export interface PanelStream {
  close(): void;
}

export type PanelStreamOpener = (tabId: string, after: () => number, handlers: PanelStreamHandlers, deps?: TerminalStreamDeps) => PanelStream;

const INTEGRATION_STATES: readonly VerseTerminalShellIntegration[] = ['active', 'injected', 'off'];

function isBlock(value: unknown): value is VerseTerminalBlock {
  const b = value as VerseTerminalBlock | null;
  return !!b && typeof b === 'object'
    && typeof b.id === 'string' && /^b-\d+$/.test(b.id)
    && typeof b.command === 'string'
    && (b.state === 'running' || b.state === 'done')
    && typeof b.startSeq === 'number' && typeof b.ordinal === 'number'
    && typeof b.startedAt === 'string';
}

function sseData(block: string): string {
  let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) data += line.slice(line.startsWith('data: ') ? 6 : 5);
  }
  return data;
}

/** Parse one SSE block into a frame (3.10 frames and the 3.15 ones); null for comments and junk. */
export function parsePanelSseBlock(block: string): VerseTerminalStreamFrame | null {
  const base = parseTerminalSseBlock(block);
  if (base) return base;
  const data = sseData(block);
  if (!data) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  return shellFrameFromObject(parsed);
}

/** The 3.15-only frames (block, cwd, integration) from a parsed object. */
function shellFrameFromObject(parsed: unknown): VerseTerminalStreamFrame | null {
  const frame = parsed as Record<string, unknown> | null;
  if (!frame || typeof frame !== 'object') return null;
  if (frame['type'] === 'block' && isBlock(frame['block'])) return { type: 'block', block: frame['block'] };
  if (frame['type'] === 'cwd' && typeof frame['cwd'] === 'string') return { type: 'cwd', cwd: frame['cwd'] };
  if (frame['type'] === 'integration' && INTEGRATION_STATES.includes(frame['state'] as VerseTerminalShellIntegration)) {
    return { type: 'integration', state: frame['state'] as VerseTerminalShellIntegration };
  }
  return null;
}

function defaultBackoff(attempt: number): number {
  return Math.min(250 * 2 ** attempt, 8_000);
}

export const openPanelStream: PanelStreamOpener = (tabId, after, handlers, deps = {}) => {
  const doFetch = deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const renew = deps.renew ?? renewReadSession;
  const proof = deps.proof ?? getReadClientProof;
  const backoff = deps.backoffMs ?? defaultBackoff;
  let closed = false;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let renewedOnce = false;

  const setState = (state: TerminalStreamState): void => {
    if (!closed || state === 'closed') handlers.onState?.(state);
  };

  const schedule = (): void => {
    if (closed) return;
    setState('reconnecting');
    timer = setTimeout(() => {
      timer = null;
      void connect();
    }, backoff(attempt++));
  };

  async function connect(): Promise<void> {
    if (closed) return;
    controller = new AbortController();
    let res: Response;
    try {
      res = await doFetch(terminalStreamPath(tabId, after()), {
        method: 'GET',
        credentials: 'same-origin',
        headers: { 'x-ashlr-read-client': proof(), Accept: 'text/event-stream' },
        signal: controller.signal,
        cache: 'no-store',
      });
    } catch {
      schedule();
      return;
    }
    if (closed) return;
    if (res.status === 404) {
      setState('gone');
      closed = true;
      return;
    }
    if (res.status === 401) {
      if (!renewedOnce && (await renew().catch(() => false))) {
        renewedOnce = true;
        void connect();
        return;
      }
      setState('expired');
      closed = true;
      return;
    }
    if (!res.ok || !res.body) {
      schedule();
      return;
    }
    renewedOnce = false;
    setState('open');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        attempt = 0;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const frame = parsePanelSseBlock(block);
          if (frame && !closed) handlers.onFrame(frame);
        }
      }
    } catch {
      /* aborted, or the connection dropped: reconnect below unless closed */
    }
    schedule();
  }

  setState('connecting');
  void connect();

  return {
    close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
      handlers.onState?.('closed');
    },
  };
};

// ===========================================================================
// The multiplexer
// ===========================================================================

type MuxParsed = { tab: string; frame: VerseTerminalStreamFrame | { type: 'gone' } };

/** One multiplexed frame: which tab, and its frame (or `gone`). Null for comments and junk. */
export function parseMuxSseBlock(block: string): MuxParsed | null {
  const data = sseData(block);
  if (!data) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const obj = parsed as Record<string, unknown> | null;
  if (!obj || typeof obj !== 'object' || typeof obj['tab'] !== 'string' || !/^t-[a-z0-9]{1,32}$/.test(obj['tab'])) return null;
  const tab = obj['tab'];
  if (obj['type'] === 'gone') return { tab, frame: { type: 'gone' } };
  // The 3.10 parser reads an SSE block: hand it this one's data back.
  const base = parseTerminalSseBlock(`data: ${data}`);
  if (base) return { tab, frame: base };
  const shell = shellFrameFromObject(obj);
  return shell ? { tab, frame: shell } : null;
}

export interface TerminalStreamMux {
  /** Same contract as a per-tab stream: frames for `tabId`, resumed past `after()` on every (re)connect. */
  subscribe(tabId: string, after: () => number, handlers: PanelStreamHandlers): PanelStream;
  /** Tabs currently subscribed. */
  tabs(): string[];
  /** Stop everything. */
  close(): void;
}

export interface TerminalStreamMuxDeps extends TerminalStreamDeps {
  /** How subscription changes are batched into one reconnect (default: a 0 ms timer). */
  batch?: (run: () => void) => void;
  /** The per-tab stream a server without the multiplexed route falls back to. */
  openSingle?: PanelStreamOpener;
}

interface MuxSub {
  after: () => number;
  handlers: PanelStreamHandlers;
  /** The per-tab stream, in fallback mode. */
  single: PanelStream | null;
  state: TerminalStreamState | null;
}

export function muxStreamPath(cursors: ReadonlyArray<readonly [string, number]>): string {
  const list = cursors.map(([id, seq]) => (Number.isSafeInteger(seq) && seq > 0 ? `${id}:${seq}` : id)).join(',');
  return `${VERSE_TERMINAL_STREAM_PATH}?tabs=${encodeURIComponent(list)}`;
}

export function createTerminalStreamMux(deps: TerminalStreamMuxDeps = {}): TerminalStreamMux {
  const doFetch = deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const renew = deps.renew ?? renewReadSession;
  const proof = deps.proof ?? getReadClientProof;
  const backoff = deps.backoffMs ?? defaultBackoff;
  const batch = deps.batch ?? ((run: () => void) => { setTimeout(run, 0); });
  const openSingle = deps.openSingle ?? ((tabId, after, handlers) => openPanelStream(tabId, after, handlers, deps));

  const subs = new Map<string, MuxSub>();
  let closed = false;
  /** An older server: every pane gets its own per-tab stream. */
  let fallback = false;
  let controller: AbortController | null = null;
  /** Bumped on every (re)connect: frames of an older connection are dropped. */
  let generation = 0;
  /** The set the current connection carries (sorted ids joined), or null when none is open. */
  let carrying: string | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let batched = false;
  let attempt = 0;
  let renewedOnce = false;

  const setState = (sub: MuxSub, state: TerminalStreamState): void => {
    if (sub.state === state) return;
    sub.state = state;
    try { sub.handlers.onState?.(state); } catch { /* one pane never breaks the others */ }
  };

  const wanted = (): string => [...subs.keys()].sort().join(',');

  function disconnect(): void {
    generation += 1;
    carrying = null;
    controller?.abort();
    controller = null;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function enterFallback(): void {
    fallback = true;
    disconnect();
    for (const [id, sub] of subs) {
      if (!sub.single) sub.single = openSingle(id, sub.after, sub.handlers);
    }
  }

  function scheduleRetry(gen: number): void {
    if (closed || gen !== generation) return;
    carrying = null;
    for (const sub of subs.values()) setState(sub, 'reconnecting');
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (gen === generation) void connect();
    }, backoff(attempt++));
  }

  function sync(): void {
    batched = false;
    if (closed || fallback) return;
    const key = wanted();
    if (key === '') {
      disconnect();
      return;
    }
    if (key === carrying) return;
    void connect();
  }

  function requestSync(): void {
    if (batched || closed) return;
    batched = true;
    batch(sync);
  }

  function dispatch(parsed: MuxParsed): void {
    const sub = subs.get(parsed.tab);
    if (!sub) return;
    if (parsed.frame.type === 'gone') {
      subs.delete(parsed.tab);
      setState(sub, 'gone');
      return;
    }
    try { sub.handlers.onFrame(parsed.frame); } catch { /* a pane's error never stops the stream */ }
  }

  async function connect(): Promise<void> {
    disconnect();
    if (closed || fallback || subs.size === 0) return;
    const gen = generation;
    const ids = [...subs.keys()].sort();
    carrying = ids.join(',');
    const ctrl = new AbortController();
    controller = ctrl;
    for (const sub of subs.values()) if (sub.state !== 'open') setState(sub, 'connecting');
    let res: Response;
    try {
      res = await doFetch(muxStreamPath(ids.map((id) => [id, subs.get(id)!.after()] as const)), {
        method: 'GET',
        credentials: 'same-origin',
        headers: { 'x-ashlr-read-client': proof(), Accept: 'text/event-stream' },
        signal: ctrl.signal,
        cache: 'no-store',
      });
    } catch {
      scheduleRetry(gen);
      return;
    }
    if (closed || gen !== generation) {
      try { void res.body?.cancel().catch(() => {}); } catch { /* ignore */ }
      return;
    }
    if (res.status === 404 || res.status === 400) {
      // No multiplexed route on this server (or it cannot read our list): one stream per pane.
      enterFallback();
      return;
    }
    if (res.status === 401) {
      if (!renewedOnce && (await renew().catch(() => false))) {
        renewedOnce = true;
        if (gen === generation) void connect();
        return;
      }
      for (const sub of subs.values()) setState(sub, 'expired');
      disconnect();
      return;
    }
    if (!res.ok || !res.body) {
      scheduleRetry(gen);
      return;
    }
    renewedOnce = false;
    for (const sub of subs.values()) setState(sub, 'open');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || gen !== generation) break;
        attempt = 0;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while (gen === generation && (idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const parsed = parseMuxSseBlock(block);
          if (parsed) dispatch(parsed);
        }
      }
    } catch {
      /* aborted, or the connection dropped */
    }
    if (gen !== generation || closed) return;
    if (subs.size === 0) {
      carrying = null;
      return;
    }
    scheduleRetry(gen);
  }

  return {
    subscribe(tabId, after, handlers) {
      const sub: MuxSub = { after, handlers, single: null, state: null };
      // A pane subscribing again replaces its old entry.
      subs.get(tabId)?.single?.close();
      subs.set(tabId, sub);
      if (closed) {
        setState(sub, 'closed');
      } else if (fallback) {
        sub.single = openSingle(tabId, after, handlers);
      } else {
        setState(sub, 'connecting');
        requestSync();
      }
      let done = false;
      return {
        close() {
          if (done) return;
          done = true;
          if (subs.get(tabId) !== sub) return;
          subs.delete(tabId);
          if (sub.single) sub.single.close();
          else setState(sub, 'closed');
          requestSync();
        },
      };
    },
    tabs: () => [...subs.keys()],
    close() {
      if (closed) return;
      closed = true;
      disconnect();
      for (const sub of subs.values()) {
        if (sub.single) sub.single.close();
        else setState(sub, 'closed');
      }
      subs.clear();
    },
  };
}

let sharedMux: TerminalStreamMux | null = null;

/** The panel's default opener: every pane on the page shares one multiplexed connection. */
export const openMuxedPanelStream: PanelStreamOpener = (tabId, after, handlers) => {
  sharedMux ??= createTerminalStreamMux();
  return sharedMux.subscribe(tabId, after, handlers);
};

/** Test hook: forget the shared connection. */
export function resetSharedTerminalMuxForTest(): void {
  sharedMux?.close();
  sharedMux = null;
}
