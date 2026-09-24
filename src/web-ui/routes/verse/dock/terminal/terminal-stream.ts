/**
 * dock/terminal/terminal-stream.ts — one terminal tab's live output (unit C4).
 *
 * WHY fetch() AND NOT EventSource. The server's read boundary accepts the
 * per-tab client proof as a query parameter ONLY on the three EventSource
 * paths it knows (read-session.ts); everywhere else it must be the
 * `x-ashlr-read-client` header, which EventSource cannot send. fetch() can,
 * and a streamed body reads the same `text/event-stream` frames. It also
 * lets the pane keep exactly ONE connection open — the visible tab's — which
 * matters because a browser allows about six per origin and Verse already
 * holds two (the app events and the open chat).
 *
 * RESUME. Each (re)connect asks for `?after=<the last seq written>`; the
 * server replays only newer frames from its 256 KB scrollback. A dropped
 * connection reconnects with backoff; a 401 renews the read session once;
 * a 404 means the tab is gone (killed, idle-closed, server restarted).
 */
import type { VerseTerminalFrame } from '../../../../data/api-types.js';
import { getReadClientProof, renewReadSession } from '../../../../data/auth-store.js';
import { terminalStreamPath } from './terminal-client.js';

export type TerminalStreamState = 'connecting' | 'open' | 'reconnecting' | 'gone' | 'expired' | 'closed';

export interface TerminalStreamHandlers {
  onFrame: (frame: VerseTerminalFrame) => void;
  onState?: (state: TerminalStreamState) => void;
}

export interface TerminalStreamDeps {
  fetch?: typeof fetch;
  renew?: () => Promise<boolean>;
  proof?: () => string;
  /** Backoff before reconnect attempt `n` (0-based). */
  backoffMs?: (attempt: number) => number;
}

export interface TerminalStream {
  close(): void;
}

function defaultBackoff(attempt: number): number {
  return Math.min(250 * 2 ** attempt, 8_000);
}

/** Parse one SSE block (`event:` / `data:` lines) into a frame; null for comments and junk. */
export function parseTerminalSseBlock(block: string): VerseTerminalFrame | null {
  let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) data += line.slice(line.startsWith('data: ') ? 6 : 5);
  }
  if (!data) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const frame = parsed as Record<string, unknown>;
  if (frame['type'] === 'output' && typeof frame['seq'] === 'number' && typeof frame['dataBase64'] === 'string') {
    return { type: 'output', seq: frame['seq'], dataBase64: frame['dataBase64'] };
  }
  if (frame['type'] === 'title' && typeof frame['title'] === 'string') return { type: 'title', title: frame['title'] };
  if (frame['type'] === 'exit') {
    return {
      type: 'exit',
      code: typeof frame['code'] === 'number' ? frame['code'] : null,
      signal: typeof frame['signal'] === 'string' ? frame['signal'] : null,
    };
  }
  return null;
}

/**
 * Stream `tabId`'s frames, resuming after `after()` on every (re)connect.
 * Returns a handle whose close() aborts the request and stops reconnecting.
 */
export function openTerminalStream(
  tabId: string,
  after: () => number,
  handlers: TerminalStreamHandlers,
  deps: TerminalStreamDeps = {},
): TerminalStream {
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
          const frame = parseTerminalSseBlock(block);
          if (frame && !closed) handlers.onFrame(frame);
        }
      }
    } catch {
      /* aborted, or the connection dropped: reconnect below unless closed */
    }
    // The server ends the stream when the tab is removed; the next connect
    // then answers 404 and reports 'gone'.
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
}
