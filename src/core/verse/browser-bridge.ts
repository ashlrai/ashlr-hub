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
 * ACTING (3.15 P2/P3). Also held here, memory only, per chat: the two extra
 * scopes (`browser_act` comes on with access and can be switched off alone;
 * `browser_script` stays off until switched on), the operator's "Allow for
 * this chat" answers, the TAINT of the current turn (it read content from
 * outside the machine — reset when the chat's next turn launches), the page
 * load the last snapshot's refs belong to, and the last screenshot's
 * geometry (so image coordinates map back to the page). A confirmation card
 * is just another command for the pane (`confirm`), answered by the
 * operator, with a 120 s budget instead of 45 s.
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
  type VerseBrowserConfirmRequest,
  type VerseBrowserDecision,
  type VerseBrowserPolicy,
  type VerseBrowserScope,
} from './browser-types.js';

/** A pane that has not polled for this long is treated as closed. */
export const BROWSER_PANE_STALE_MS = 30_000;
/** A queued command nobody claims within this long fails ("is the pane open?"). */
export const BROWSER_CLAIM_TIMEOUT_MS = 8_000;
/** A claimed command without an answer within this long fails. */
export const BROWSER_RESULT_TIMEOUT_MS = 45_000;
/** The pane's long-poll is answered after at most this long. */
export const BROWSER_POLL_MAX_WAIT_MS = 20_000;
/** How long a confirmation card waits for the operator. */
export const BROWSER_CONFIRM_TIMEOUT_MS = 120_000;
const MAX_QUEUE = 16;
const MAX_ALLOWED_ORIGINS = 32;
const MAX_ALLOWANCES = 32;
const MAX_BLOCKED = 5;

/**
 * Seat engines whose launch loads the browser tools. Since the agent-tools
 * release every seat reaches them through Verse's one MCP server
 * (verse-mcp.ts, injected per seat by verse-mcp-launch.ts); a Devin CLOUD
 * chat cannot (it runs remotely) and the sheet says so.
 */
export const BROWSER_TOOL_ENGINES: readonly string[] = ['claude', 'local', 'codex', 'grok', 'devin'];

export type BrowserOutcome =
  | { ok: true; url?: string; data: unknown }
  | { ok: false; code: 'pane-not-open' | 'timeout' | 'access-off' | 'failed' | 'busy'; message: string };

interface PendingCommand {
  command: VerseBrowserAgentCommand;
  settle: (outcome: BrowserOutcome) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** How long the pane has to answer once it claimed the command. */
  resultMs: number;
  signal?: AbortSignal;
  /** Unified bearer grant/scope check, evaluated again at pane admission. */
  authorize?: () => boolean;
  onAbort?: () => void;
}

/** The last screenshot's geometry (browser-act-policy.ts `BrowserShotGeometry`). */
export interface BrowserShotRecord {
  scale: number;
  originX: number;
  originY: number;
  width: number;
  height: number;
  url: string;
}

/** Content from outside this machine read during the current turn. */
export interface BrowserTurnTaint {
  origin: string;
  at: number;
}

export type BrowserConfirmOutcome = VerseBrowserDecision | 'timeout' | 'unavailable';

interface ChatBrowserState {
  grant: string | null;
  actAccess: boolean;
  scriptAccess: boolean;
  allowances: string[];
  allowanceRevision: number;
  taint: BrowserTurnTaint | null;
  snapshotLoadId: string | null;
  lastShot: BrowserShotRecord | null;
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
      actAccess: false,
      scriptAccess: false,
      allowances: [],
      allowanceRevision: 0,
      taint: null,
      snapshotLoadId: null,
      lastShot: null,
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
    actAccess: state?.grant != null && state.actAccess,
    scriptAccess: state?.grant != null && state.scriptAccess,
    allowances: [...(state?.allowances ?? [])],
    allowedOrigins: [...(state?.allowedOrigins ?? [])],
    blocked: [...(state?.blocked ?? [])],
    toolEngines: [...BROWSER_TOOL_ENGINES],
    paneSeenAt: state?.paneSeenAt != null ? new Date(state.paneSeenAt).toISOString() : null,
  };
}

/** The sidecar origin the chat's grant was minted against (the MCP URL's base), or null. */
export function browserSidecarOrigin(sessionId: string): string | null {
  const state = chats.get(sessionId);
  return state?.grant ? state.sidecarOrigin : null;
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
    if (!state.grant || state.sidecarOrigin !== sidecarOrigin) {
      state.grant = randomBytes(32).toString('base64url');
      // A fresh grant starts from the defaults: acting on, scripts off.
      state.actAccess = true;
      state.scriptAccess = false;
    }
    state.sidecarOrigin = sidecarOrigin;
  } else {
    state.grant = null;
    state.sidecarOrigin = null;
    state.actAccess = false;
    state.scriptAccess = false;
    state.allowances = [];
    state.allowanceRevision++;
    state.taint = null;
    state.snapshotLoadId = null;
    state.lastShot = null;
    failAll(state, { ok: false, code: 'access-off', message: 'The operator switched browser access off for this chat.' });
  }
  return browserPolicy(sessionId);
}

/**
 * Switch one scope. `browser` is the whole grant (setBrowserAgentAccess);
 * `browser_act` / `browser_script` need the grant to be on, and switching
 * one ON without it is refused (null). Switching acting off also forgets the
 * chat's "Allow for this chat" answers.
 */
export function setBrowserScope(sessionId: string, scope: VerseBrowserScope, enabled: boolean, sidecarOrigin: string): VerseBrowserPolicy | null {
  if (scope === 'browser') return setBrowserAgentAccess(sessionId, enabled, sidecarOrigin);
  const state = chats.get(sessionId);
  if (!state?.grant) return enabled ? null : browserPolicy(sessionId);
  if ((scope === 'browser_act' ? state.actAccess : state.scriptAccess) === enabled) return browserPolicy(sessionId);
  if (scope === 'browser_act') {
    state.actAccess = enabled;
    if (!enabled) {
      state.allowances = [];
      state.allowanceRevision++;
      failAll(state, { ok: false, code: 'access-off', message: 'The operator switched browser acting off for this chat.' });
    }
  } else {
    state.scriptAccess = enabled;
    if (!enabled) {
      state.allowances = [];
      state.allowanceRevision++;
      failAll(state, { ok: false, code: 'access-off', message: 'The operator switched browser scripts off for this chat.' });
    }
  }
  return browserPolicy(sessionId);
}

/** What this chat's agents may do right now. */
export function browserScopes(sessionId: string): { access: boolean; act: boolean; script: boolean } {
  const state = chats.get(sessionId);
  if (!state?.grant) return { access: false, act: false, script: false };
  return { access: true, act: state.actAccess, script: state.scriptAccess };
}

// ---------------------------------------------------------------------------
// "Allow for this chat", the turn's taint, refs and screenshot geometry
// ---------------------------------------------------------------------------

export function browserAllowances(sessionId: string): string[] {
  return [...(chats.get(sessionId)?.allowances ?? [])];
}

/** Invalidates a confirmation opened before an allowance was revoked. */
export function browserAllowanceRevision(sessionId: string): number {
  return chats.get(sessionId)?.allowanceRevision ?? 0;
}

export function addBrowserAllowances(sessionId: string, keys: readonly string[]): void {
  const state = chats.get(sessionId);
  if (!state?.grant) return;
  for (const key of keys) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 600 || state.allowances.includes(key)) continue;
    if (state.allowances.length >= MAX_ALLOWANCES) state.allowances.shift();
    state.allowances.push(key);
  }
}

export function revokeBrowserAllowance(sessionId: string, key: string): VerseBrowserPolicy {
  const state = chats.get(sessionId);
  if (state) {
    state.allowances = state.allowances.filter((k) => k !== key);
    state.allowanceRevision++;
  }
  return browserPolicy(sessionId);
}

/**
 * A new turn for this chat is launching: forget what the last one read. The
 * seat adapter calls this next to `browserSeatLaunch`, so the taint is
 * exactly "this turn's".
 */
export function beginBrowserTurn(sessionId: string): void {
  const state = chats.get(sessionId);
  if (state) {
    state.taint = null;
    // Refs and screenshot pixels belong to a page capture, not the next turn.
    state.snapshotLoadId = null;
    state.lastShot = null;
  }
}

/** This turn read content from `origin` (outside the machine). The first origin is kept. */
export function markBrowserTaint(sessionId: string, origin: string): void {
  const state = chats.get(sessionId);
  if (!state?.grant || state.taint) return;
  state.taint = { origin: origin.slice(0, 300), at: clock() };
}

export function browserTaint(sessionId: string): BrowserTurnTaint | null {
  const taint = chats.get(sessionId)?.taint;
  return taint ? { ...taint } : null;
}

/** The page load (tap `loadId`) the last snapshot's refs belong to. */
export function setBrowserSnapshotLoad(sessionId: string, loadId: string | null): void {
  const state = chats.get(sessionId);
  if (state) state.snapshotLoadId = loadId;
}

export function browserSnapshotLoad(sessionId: string): string | null {
  return chats.get(sessionId)?.snapshotLoadId ?? null;
}

export function setBrowserShot(sessionId: string, shot: BrowserShotRecord | null): void {
  const state = chats.get(sessionId);
  if (state) state.lastShot = shot ? { ...shot } : null;
}

export function browserShot(sessionId: string): BrowserShotRecord | null {
  const shot = chats.get(sessionId)?.lastShot;
  return shot ? { ...shot } : null;
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
    pending.settle(outcome);
  }
  state.queue = [];
  state.inflight.clear();
}

/** Invalidate claimed commands when a grant narrows, including allowed → localhost. */
export function cancelBrowserCommands(sessionId: string): void {
  const state = chats.get(sessionId);
  if (state) failAll(state, { ok: false, code: 'access-off', message: 'The browser grant changed before this command could run.' });
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
  args: { url?: string; limit?: number; args?: Record<string, unknown> } = {},
  timeouts: { claimMs?: number; resultMs?: number; signal?: AbortSignal; authorize?: () => boolean } = {},
): Promise<BrowserOutcome> {
  const state = stateFor(sessionId);
  if (timeouts.signal?.aborted || timeouts.authorize?.() === false) return Promise.resolve({ ok: false, code: 'access-off', message: 'This browser turn ended before the command could run.' });
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
    ...(args.args !== undefined ? { args: args.args } : {}),
    allowedOrigins: [...state.allowedOrigins],
    createdAt: new Date(clock()).toISOString(),
  };
  return new Promise<BrowserOutcome>((resolve) => {
    let settled = false;
    const pending: PendingCommand = {
      command,
      timer: null,
      resultMs,
      signal: timeouts.signal,
      authorize: timeouts.authorize,
      settle: (outcome) => {
        if (settled) return;
        settled = true;
        if (pending.timer) clearTimeout(pending.timer);
        pending.signal?.removeEventListener('abort', pending.onAbort!);
        resolve(outcome);
      },
    };
    pending.onAbort = () => {
      state.queue = state.queue.filter((p) => p !== pending);
      state.inflight.delete(command.id);
      pending.settle({ ok: false, code: 'access-off', message: 'This browser turn ended before the command could run.' });
    };
    pending.signal?.addEventListener('abort', pending.onAbort, { once: true });
    if (pending.signal?.aborted) { pending.onAbort(); return; }
    pending.timer = setTimeout(() => {
      state.queue = state.queue.filter((p) => p !== pending);
      pending.settle({ ok: false, code: 'pane-not-open', message: PANE_NOT_OPEN });
    }, claimMs);
    // The claim timer is swapped for the result timer when the pane takes it.
    state.queue.push(pending);
    wake(state);
  });
}

/**
 * Ask the OPERATOR, on the pane's confirmation card, whether an action may go
 * ahead. Resolves — never rejects — with their answer, `timeout` after
 * BROWSER_CONFIRM_TIMEOUT_MS, or `unavailable` when no pane can show it.
 * Anything but `once` / `chat` means no.
 */
export async function requestBrowserConfirmation(
  sessionId: string,
  request: Omit<VerseBrowserConfirmRequest, 'expiresAt'>,
  timeoutMs = BROWSER_CONFIRM_TIMEOUT_MS,
  signal?: AbortSignal,
  authorize?: () => boolean,
): Promise<BrowserConfirmOutcome> {
  const expiresAt = new Date(clock() + timeoutMs).toISOString();
  const outcome = await runBrowserCommand(sessionId, 'confirm', { args: { ...request, expiresAt } }, { resultMs: timeoutMs, signal, authorize });
  if (!outcome.ok) return outcome.code === 'timeout' ? 'timeout' : 'unavailable';
  const data = outcome.data;
  const decision = typeof data === 'object' && data !== null ? (data as Record<string, unknown>)['decision'] : null;
  return decision === 'once' || decision === 'chat' ? decision : 'deny';
}

function claimQueued(state: ChatBrowserState): VerseBrowserAgentCommand[] {
  const taken = state.queue.splice(0, state.queue.length);
  for (const pending of taken) {
    if (pending.signal?.aborted || pending.authorize?.() === false) {
      pending.settle({ ok: false, code: 'access-off', message: 'This browser turn ended before the command could run.' });
      continue;
    }
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      state.inflight.delete(pending.command.id);
      pending.settle({ ok: false, code: 'timeout', message: 'The Browser pane did not answer in time.' });
    }, pending.resultMs);
    state.inflight.set(pending.command.id, pending);
  }
  return taken.filter((p) => state.inflight.has(p.command.id)).map((p) => p.command);
}

/** Called by the pane immediately before an effect. Claim alone is not authority. */
export function canDispatchBrowserCommand(sessionId: string, id: string): boolean {
  const state = chats.get(sessionId);
  const pending = state?.inflight.get(id);
  if (!state?.grant || !pending || pending.signal?.aborted || pending.authorize?.() === false) return false;
  // The pane received allowedOrigins when it claimed this command. A later
  // origin revocation must invalidate that snapshot before any page effect.
  if (JSON.stringify(pending.command.allowedOrigins) !== JSON.stringify(state.allowedOrigins)) return false;
  if (pending.command.op === 'act' && !state.actAccess) return false;
  if (pending.command.op === 'evaluate' && !state.scriptAccess) return false;
  return true;
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

/**
 * A deleted chat: revoke its grant (the MCP URL stops resolving), fail every command
 * still waiting, release the pane's long-poll and drop the chat's state. Without this a
 * deleted chat's grant stayed valid for the life of the server. Idempotent.
 */
export function forgetBrowserChat(sessionId: string): void {
  const state = chats.get(sessionId);
  if (!state) return;
  state.grant = null;
  state.sidecarOrigin = null;
  failAll(state, { ok: false, code: 'access-off', message: 'This chat was deleted.' });
  for (const waker of [...state.wakers]) waker();
  chats.delete(sessionId);
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
