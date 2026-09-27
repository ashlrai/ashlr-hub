/**
 * terminal/panel-stream.ts — one shell's live frames for the 3.15 panel.
 *
 * The same connection as the dock's 3.10 terminal-stream.ts — fetch() with
 * the read-client header (not EventSource: the read boundary accepts the
 * client proof as a query parameter only on the EventSource paths it knows),
 * resume with `?after=<last seq>`, backoff on a drop, one read-session
 * renewal on a 401, `gone` on a 404 — with a parser that also reads the
 * shell integration's frames (`block`, `cwd`, `integration`), which the 3.10
 * parser deliberately ignores.
 */
import type { VerseTerminalBlock, VerseTerminalShellIntegration, VerseTerminalStreamFrame } from '../../../data/api-types.js';
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

/** Parse one SSE block into a frame (3.10 frames and the 3.15 ones); null for comments and junk. */
export function parsePanelSseBlock(block: string): VerseTerminalStreamFrame | null {
  const base = parseTerminalSseBlock(block);
  if (base) return base;
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
