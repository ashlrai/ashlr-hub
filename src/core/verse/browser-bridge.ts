/**
 * core/verse/browser-bridge.ts — the sidecar's half of the integrated Browser
 * pane (3.15): per-chat agent grants, the per-chat origin allow-list, and the
 * command relay between a chat seat and the pane.
 *
 * WHO EXECUTES. Never the sidecar. A seat's tool call (browser-mcp.ts) becomes
 * a command queued here; the operator's Browser pane — the one open on that
 * chat — long-polls for it, performs it in the browser the operator is
 * looking at (native webview in the desktop app, <iframe> in a browser tab)
 * and posts the answer back. No pane open → the tool fails at once with a
 * message telling the agent to ask the operator. An agent therefore can never
 * browse invisibly, in a chat nobody granted, or after Verse restarts.
 *
 * WHAT IS HELD. Memory only, on purpose: a restart revokes every grant and
 * every allowed origin. The operator switches access back on from the pane.
 *
 * GRANTS. Switching agent access on mints a 32-byte random grant for the
 * chat. It is the whole authentication of the MCP endpoint
 * (`/api/verse/browser/mcp/<grant>`) and reaches exactly one place: the
 * `--mcp-config` of that chat's next Claude turn (adapters/claude.ts). It
 * never appears in a response to the page. Switching access off (or a
 * restart) makes it worthless.
 *
 * No node:fs, no child processes: pure state plus node:crypto.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

import {
  BROWSER_MCP_SERVER_NAME,
  VERSE_BROWSER_MCP_PATH,
  normalizeBrowserOrigin,
  type VerseBrowserAgentCommand,
  type VerseBrowserAgentOp,
  type VerseBrowserBlockedRequest,
  type VerseBrowserCommandResult,
  type VerseBrowserPolicy,
} from './browser-types.js';

/** A pane that has not polled for this long is treated as closed. */
export const BROWSER_PANE_STALE_MS = 30_000;
/** A queued command nobody claims within this long fails ("is the pane open?"). */
export const BROWSER_CLAIM_TIMEOUT_MS = 8_000;
/** A claimed command without an answer within this long fails. */
export const BROWSER_RESULT_TIMEOUT_MS = 45_000;
/** The pane's long-poll is answered after at most this long. */
export const BROWSER_POLL_MAX_WAIT_MS = 20_000;
const MAX_QUEUE = 16;
const MAX_ALLOWED_ORIGINS = 32;
const MAX_BLOCKED = 5;

/** Seat engines whose launch loads the browser tools (adapters/claude.ts serves both). */
export const BROWSER_TOOL_ENGINES: readonly string[] = ['claude', 'local'];

export type BrowserOutcome =
  | { ok: true; url?: string; data: unknown }
  | { ok: false; code: 'pane-not-open' | 'timeout' | 'access-off' | 'failed' | 'busy'; message: string };

interface PendingCommand {
  command: VerseBrowserAgentCommand;
  settle: (outcome: BrowserOutcome) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** How long the pane has to answer once it claimed the command. */
  resultMs: number;
}

interface ChatBrowserState {
  grant: string | null;
  /** `http://127.0.0.1:<port>` of the sidecar that minted the grant (the MCP URL's base). */
  sidecarOrigin: string | null;
  allowedOrigins: string[];
  blocked: VerseBrowserBlockedRequest[];
  queue: PendingCommand[];
  inflight: Map<string, PendingCommand>;
  wakers: Set<() => void>;
  activePolls: number;
  paneSeenAt: number | null;
}

const chats = new Map<string, ChatBrowserState>();
let clock: () => number = Date.now;

function stateFor(sessionId: string): ChatBrowserState {
  let state = chats.get(sessionId);
  if (!state) {
    state = {
      grant: null,
      sidecarOrigin: null,
      allowedOrigins: [],
      blocked: [],
      queue: [],
      inflight: new Map(),
      wakers: new Set(),
      activePolls: 0,
      paneSeenAt: null,
    };
    chats.set(sessionId, state);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export function browserPolicy(sessionId: string): VerseBrowserPolicy {
  const state = chats.get(sessionId);
  return {
    sessionId,
    agentAccess: state?.grant != null,
    allowedOrigins: [...(state?.allowedOrigins ?? [])],
    blocked: [...(state?.blocked ?? [])],
    toolEngines: [...BROWSER_TOOL_ENGINES],
    paneSeenAt: state?.paneSeenAt != null ? new Date(state.paneSeenAt).toISOString() : null,
  };
}

/** The allow-list the gate reads (loopback is always allowed and never listed). */
export function allowedOriginsFor(sessionId: string): string[] {
  return [...(chats.get(sessionId)?.allowedOrigins ?? [])];
}

/**
 * Switch agent access for a chat. On: mint a grant (kept if one exists) bound
 * to the sidecar origin that will serve the MCP endpoint. Off: forget the
 * grant and fail every command still waiting.
 */
export function setBrowserAgentAccess(sessionId: string, enabled: boolean, sidecarOrigin: string): VerseBrowserPolicy {
  const state = stateFor(sessionId);
  if (enabled) {
    if (!state.grant || state.sidecarOrigin !== sidecarOrigin) state.grant = randomBytes(32).toString('base64url');
    state.sidecarOrigin = sidecarOrigin;
  } else {
    state.grant = null;
    state.sidecarOrigin = null;
    failAll(state, { ok: false, code: 'access-off', message: 'The operator switched browser access off for this chat.' });
  }
  return browserPolicy(sessionId);
}

export function setBrowserOriginAllowed(sessionId: string, rawOrigin: string, allowed: boolean): VerseBrowserPolicy | null {
  const origin = normalizeBrowserOrigin(rawOrigin);
  if (!origin) return null;
  const state = stateFor(sessionId);
  if (allowed) {
    if (!state.allowedOrigins.includes(origin)) {
      if (state.allowedOrigins.length >= MAX_ALLOWED_ORIGINS) state.allowedOrigins.shift();
      state.allowedOrigins.push(origin);
    }
    state.blocked = state.blocked.filter((b) => b.origin !== origin);
  } else {
    state.allowedOrigins = state.allowedOrigins.filter((o) => o !== origin);
  }
  return browserPolicy(sessionId);
}

/** Remember an agent request the gate refused, so the pane can offer "Allow". */
export function recordBrowserBlocked(sessionId: string, url: string, origin: string): void {
  const state = stateFor(sessionId);
  state.blocked = [
    { url: url.slice(0, 500), origin, at: new Date(clock()).toISOString() },
    ...state.blocked.filter((b) => b.origin !== origin),
  ].slice(0, MAX_BLOCKED);
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

/** The chat a grant belongs to, or null. Constant-time per comparison. */
export function sessionForBrowserGrant(grant: string): string | null {
  if (typeof grant !== 'string' || grant.length !== 43) return null;
  const presented = Buffer.from(grant, 'utf8');
  let found: string | null = null;
  for (const [sessionId, state] of chats) {
    if (!state.grant) continue;
    const held = Buffer.from(state.grant, 'utf8');
    if (held.length === presented.length && timingSafeEqual(held, presented)) found = sessionId;
  }
  return found;
}

/**
 * What a Claude turn for this chat adds to its launch, or null when agent
 * access is off (then the launch is byte-identical to one without a browser).
 * `mcpConfig` replaces the empty `{"mcpServers":{}}` behind
 * `--strict-mcp-config`; `allowedTool` pre-approves the server's tools, which
 * `-p` could otherwise not ask about.
 */
export function browserSeatLaunch(sessionId: string): { mcpConfig: string; allowedTool: string } | null {
  const state = chats.get(sessionId);
  if (!state?.grant || !state.sidecarOrigin) return null;
  const url = `${state.sidecarOrigin}${VERSE_BROWSER_MCP_PATH}/${state.grant}`;
  return {
    mcpConfig: JSON.stringify({ mcpServers: { [BROWSER_MCP_SERVER_NAME]: { type: 'http', url } } }),
    allowedTool: `mcp__${BROWSER_MCP_SERVER_NAME}`,
  };
}

// ---------------------------------------------------------------------------
// The relay
// ---------------------------------------------------------------------------

function paneIsPresent(state: ChatBrowserState): boolean {
  if (state.activePolls > 0) return true;
  return state.paneSeenAt !== null && clock() - state.paneSeenAt < BROWSER_PANE_STALE_MS;
}

function wake(state: ChatBrowserState): void {
  for (const waker of [...state.wakers]) waker();
}

function failAll(state: ChatBrowserState, outcome: BrowserOutcome): void {
  for (const pending of [...state.queue, ...state.inflight.values()]) {
    if (pending.timer) clearTimeout(pending.timer);
    pending.settle(outcome);
  }
  state.queue = [];
  state.inflight.clear();
}

const PANE_NOT_OPEN =
  'The Browser pane is not open on this chat in Verse, so there is no browser to use. Ask the operator to open the Browser pane on this chat, then try again.';

/**
 * Queue one command for the chat's pane and wait for its answer. Resolves —
 * never rejects — with the pane's result or a refusal the agent can act on.
 */
export function runBrowserCommand(
  sessionId: string,
  op: VerseBrowserAgentOp,
  args: { url?: string; limit?: number } = {},
  timeouts: { claimMs?: number; resultMs?: number } = {},
): Promise<BrowserOutcome> {
  const state = stateFor(sessionId);
  if (!state.grant) {
    return Promise.resolve({ ok: false, code: 'access-off', message: 'Browser access is off for this chat.' });
  }
  if (!paneIsPresent(state)) return Promise.resolve({ ok: false, code: 'pane-not-open', message: PANE_NOT_OPEN });
  if (state.queue.length + state.inflight.size >= MAX_QUEUE) {
    return Promise.resolve({ ok: false, code: 'busy', message: 'Too many browser requests are already waiting; wait for them to finish.' });
  }
  const claimMs = timeouts.claimMs ?? BROWSER_CLAIM_TIMEOUT_MS;
  const resultMs = timeouts.resultMs ?? BROWSER_RESULT_TIMEOUT_MS;
  const command: VerseBrowserAgentCommand = {
    id: `bc_${randomBytes(9).toString('base64url')}`,
    sessionId,
    op,
    ...(args.url !== undefined ? { url: args.url } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    allowedOrigins: [...state.allowedOrigins],
    createdAt: new Date(clock()).toISOString(),
  };
  return new Promise<BrowserOutcome>((resolve) => {
    let settled = false;
    const pending: PendingCommand = {
      command,
      timer: null,
      resultMs,
      settle: (outcome) => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      },
    };
    pending.timer = setTimeout(() => {
      state.queue = state.queue.filter((p) => p !== pending);
      pending.settle({ ok: false, code: 'pane-not-open', message: PANE_NOT_OPEN });
    }, claimMs);
    // The claim timer is swapped for the result timer when the pane takes it.
    state.queue.push(pending);
    wake(state);
  });
}

function claimQueued(state: ChatBrowserState): VerseBrowserAgentCommand[] {
  const taken = state.queue.splice(0, state.queue.length);
  for (const pending of taken) {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      state.inflight.delete(pending.command.id);
      pending.settle({ ok: false, code: 'timeout', message: 'The Browser pane did not answer in time.' });
    }, pending.resultMs);
    state.inflight.set(pending.command.id, pending);
  }
  return taken.map((p) => p.command);
}

/**
 * The pane's long-poll: the commands waiting for this chat, or an empty list
 * after `waitMs`. Only a pane with agent access on is handed anything; every
 * poll counts as "the pane is open".
 */
export function claimBrowserCommands(sessionId: string, opts: { waitMs: number; signal?: AbortSignal }): Promise<VerseBrowserAgentCommand[]> {
  const state = stateFor(sessionId);
  state.paneSeenAt = clock();
  if (state.queue.length > 0 || opts.waitMs <= 0) return Promise.resolve(claimQueued(state));
  state.activePolls += 1;
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      state.wakers.delete(onWake);
      opts.signal?.removeEventListener('abort', onAbort);
      state.activePolls = Math.max(0, state.activePolls - 1);
      state.paneSeenAt = clock();
    };
    const onWake = (): void => {
      finish();
      resolve(claimQueued(state));
    };
    const onAbort = (): void => {
      finish();
      resolve([]);
    };
    const timer = setTimeout(() => {
      finish();
      resolve([]);
    }, Math.min(opts.waitMs, BROWSER_POLL_MAX_WAIT_MS));
    state.wakers.add(onWake);
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The pane's answer. False when no such command is waiting (late, or never issued). */
export function completeBrowserCommand(sessionId: string, result: VerseBrowserCommandResult): boolean {
  const state = chats.get(sessionId);
  const pending = state?.inflight.get(result.id);
  if (!state || !pending) return false;
  state.inflight.delete(result.id);
  if (pending.timer) clearTimeout(pending.timer);
  state.paneSeenAt = clock();
  if (result.ok) {
    pending.settle({ ok: true, ...(typeof result.url === 'string' ? { url: result.url } : {}), data: result.data });
  } else {
    const message = typeof result.error === 'string' && result.error.trim() ? result.error.trim().slice(0, 500) : 'The browser could not do that.';
    pending.settle({ ok: false, code: 'failed', message });
  }
  return true;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Test hygiene: forget every chat (pending commands fail) and restore the clock. */
export function resetBrowserBridgeForTest(): void {
  for (const state of chats.values()) {
    failAll(state, { ok: false, code: 'access-off', message: 'reset' });
    for (const waker of [...state.wakers]) waker();
  }
  chats.clear();
  clock = Date.now;
}

export function setBrowserBridgeClockForTest(next: (() => number) | null): void {
  clock = next ?? Date.now;
}
