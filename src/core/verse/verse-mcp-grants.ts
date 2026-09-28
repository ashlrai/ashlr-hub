/**
 * core/verse/verse-mcp-grants.ts — who may call Verse's MCP server, for how
 * long, and with what (3.15 agent tools).
 *
 * THE CHAT GRANT. The operator's per-chat choices in the "Agent tools" sheet
 * (verse-mcp-types.ts VerseAgentToolsGrant) — terminal / browser / computer
 * modes — become the chat's SCOPES. The browser half is the Browser pane's
 * own agent-access switch (browser-bridge.ts): switching browser tools on or
 * off here flips that switch, and switching it off in the pane turns the
 * browser scopes off here. Held in memory only, like the browser grants: a
 * sidecar restart turns every chat's tools off.
 *
 * THE TURN TOKEN. Each turn of a chat with at least one scope gets a fresh
 * 32-byte bearer token, minted while the seat's launch is built
 * (verse-mcp-launch.ts) and REVOKED when the turn ends — cleanly, failed,
 * stopped, or its chat deleted (verse-api.ts turn hooks) — and on the kill
 * switch (verse-mcp.ts refuses every call and revokes every token while
 * ~/.ashlr/KILL is engaged). One live token per chat: a recovery that
 * rebuilds the launch replaces it. A 5 h backstop expiry covers a hook that
 * never ran. Tokens are kept as SHA-256 digests; the plaintext exists only in
 * the seat's private launch material. Scopes are read LIVE on every call, so
 * switching a tool off in the sheet takes effect mid-turn.
 *
 * CONFIRMATIONS. A destructive command (verse-mcp-destructive.ts) waits here
 * for the operator's [Allow once] [Allow for chat] [Deny] — at most 120 s,
 * then the tool answers with an error the model can read. "Allow for chat"
 * allows that RULE for the rest of this chat's life in this sidecar.
 *
 * TAKEOVER. An operator keystroke in a tab an agent is driving (its own tab,
 * or a shell the operator shared) pauses the agent in that tab until the
 * operator presses "Resume agent" (terminal-api.ts reports the keystrokes).
 *
 * No node:fs, no child processes: pure state plus node:crypto.
 */
import { createHash, randomBytes } from 'node:crypto';

import { beginBrowserTurn, browserPolicy, browserSidecarOrigin, cancelBrowserCommands, setBrowserAgentAccess, setBrowserScope } from './browser-bridge.js';
import {
  VERSE_AGENT_TOOLS_OFF,
  VERSE_MCP_PATH,
  scopesOfGrant,
  type VerseAgentAction,
  type VerseAgentPendingConfirmation,
  type VerseAgentTabInfo,
  type VerseAgentToolsGrant,
  type VerseMcpConfirmAnswer,
  type VerseMcpScope,
} from './verse-mcp-types.js';

/** A turn token nobody revoked stops working after this long (the longest turn is a 4 h Devin cloud wait). */
export const VERSE_MCP_TOKEN_MAX_AGE_MS = 5 * 60 * 60 * 1000;
/** How long a destructive command waits for the operator. */
export const VERSE_MCP_CONFIRM_TIMEOUT_MS = 120_000;
const MAX_ACTIONS = 30;
const MAX_PENDING_PER_CHAT = 4;
const MAX_COMPUTER_APPS = 32;

export type VerseMcpConfirmOutcome = VerseMcpConfirmAnswer | 'timeout' | 'revoked';

interface PendingConfirmation {
  info: VerseAgentPendingConfirmation;
  settle: (outcome: VerseMcpConfirmOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ChatState {
  grant: VerseAgentToolsGrant;
  /** Operator shells of this chat the operator shared with its agent. */
  sharedTabs: Set<string>;
  /** Rules the operator answered "Allow for chat" to. */
  allowedRules: Set<string>;
  sidecarOrigin: string | null;
  actions: VerseAgentAction[];
  pending: Map<string, PendingConfirmation>;
}

interface TurnToken {
  digest: string;
  /** Mint order, process-wide (see verseMcpMintSeq). */
  seq: number;
  sessionId: string;
  engine: string;
  issuedAt: number;
  controller: AbortController;
  /** The turn read content from a non-loopback origin (browser page, remote fetch): exfil-shaped commands need a yes. */
  remoteRead: boolean;
}

const chats = new Map<string, ChatState>();
const tokens = new Map<string, TurnToken>();
const tokenBySession = new Map<string, string>();
/** Agent-owned tabs (opened through terminal_open / terminal_run). Shared shells live on the chat. */
const agentTabs = new Map<string, string>();
const takenOver = new Map<string, number>();
const takeoverListeners = new Set<(tabId: string) => void>();
let clock: () => number = Date.now;
let mintSeq = 0;
/** The origin of the sidecar the page last talked to (the MCP URL's base when a chat has none of its own). */
let fallbackSidecarOrigin: string | null = null;

function chatFor(sessionId: string): ChatState {
  let state = chats.get(sessionId);
  if (!state) {
    state = {
      grant: { ...VERSE_AGENT_TOOLS_OFF, computerApps: [] },
      sharedTabs: new Set(),
      allowedRules: new Set(),
      sidecarOrigin: null,
      actions: [],
      pending: new Map(),
    };
    chats.set(sessionId, state);
  }
  return state;
}

function digestOf(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// The chat grant
// ---------------------------------------------------------------------------

/**
 * The chat's grant as it stands: the stored choices, with the browser half
 * following the Browser pane's switch (off there = off here; on there with
 * nothing chosen here = look).
 */
export function agentToolsGrant(sessionId: string): VerseAgentToolsGrant {
  const stored = chats.get(sessionId)?.grant ?? VERSE_AGENT_TOOLS_OFF;
  const paneOn = browserPolicy(sessionId).agentAccess;
  const browser = !paneOn ? 'off' : stored.browser === 'off' ? 'look' : stored.browser;
  return { ...stored, browser, computerApps: [...stored.computerApps] };
}

export function agentToolScopes(sessionId: string): VerseMcpScope[] {
  return scopesOfGrant(agentToolsGrant(sessionId));
}

export function hasAgentScope(sessionId: string, scope: VerseMcpScope): boolean {
  return agentToolScopes(sessionId).includes(scope);
}

/** For browser-act tools: may this chat act only on loopback pages, or on its allowed origins too? */
export function browserActReach(sessionId: string): 'none' | 'localhost' | 'allowed' {
  const mode = agentToolsGrant(sessionId).browser;
  return mode === 'act-allowed' ? 'allowed' : mode === 'act-localhost' ? 'localhost' : 'none';
}

/** For computer-use tools: the apps the operator listed (empty when computer use is off). */
export function computerAppsFor(sessionId: string): string[] {
  const grant = agentToolsGrant(sessionId);
  return grant.computer === 'apps' ? [...grant.computerApps] : [];
}

/**
 * Change the chat's grant (only the fields given). The browser half flips the
 * Browser pane's agent access, bound to `sidecarOrigin`.
 */
export function setAgentToolsGrant(sessionId: string, patch: Partial<VerseAgentToolsGrant>, sidecarOrigin: string): VerseAgentToolsGrant {
  const state = chatFor(sessionId);
  state.sidecarOrigin = sidecarOrigin;
  fallbackSidecarOrigin = sidecarOrigin;
  const next: VerseAgentToolsGrant = { ...state.grant, computerApps: [...state.grant.computerApps] };
  if (patch.terminal !== undefined) next.terminal = patch.terminal;
  if (patch.browser !== undefined) next.browser = patch.browser;
  if (patch.browserScript !== undefined) next.browserScript = patch.browserScript;
  if (patch.computer !== undefined) next.computer = patch.computer;
  if (patch.computerApps !== undefined) {
    next.computerApps = [...new Set(patch.computerApps.map((a) => a.trim()).filter((a) => a.length > 0 && a.length <= 200))].slice(0, MAX_COMPUTER_APPS);
  }
  if (next.browser !== state.grant.browser || next.browserScript !== state.grant.browserScript) {
    cancelBrowserCommands(sessionId);
  }
  state.grant = next;
  if (patch.browser !== undefined) {
    const paneOn = browserPolicy(sessionId).agentAccess;
    if (next.browser === 'off' && paneOn) setBrowserAgentAccess(sessionId, false, sidecarOrigin);
    else if (next.browser !== 'off' && !paneOn) setBrowserAgentAccess(sessionId, true, sidecarOrigin);
  }
  if (next.browser !== 'off' && (patch.browser !== undefined || patch.browserScript !== undefined)) {
    const acting = next.browser === 'act-localhost' || next.browser === 'act-allowed';
    setBrowserScope(sessionId, 'browser_act', acting, sidecarOrigin);
    setBrowserScope(sessionId, 'browser_script', acting && next.browserScript, sidecarOrigin);
  }
  if (next.terminal !== 'shared') state.sharedTabs.clear();
  // A chat with every tool off holds no live token: nothing may call in.
  if (scopesOfGrant(agentToolsGrant(sessionId)).length === 0) revokeVerseMcpTurn(sessionId, 'The operator switched this chat\'s agent tools off.');
  return agentToolsGrant(sessionId);
}

/** Remember the sidecar's own origin (any page request tells us the port). */
export function noteVerseSidecarOrigin(origin: string): void {
  if (/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin)) fallbackSidecarOrigin = origin;
}

function sidecarOriginFor(sessionId: string): string | null {
  return chats.get(sessionId)?.sidecarOrigin ?? browserSidecarOrigin(sessionId) ?? fallbackSidecarOrigin;
}

// ---------------------------------------------------------------------------
// Turn tokens
// ---------------------------------------------------------------------------

export interface VerseMcpTurnCredential {
  sessionId: string;
  /** Plaintext bearer token. Goes ONLY into private launch material (0600 files, stdin). */
  token: string;
  /** `http://127.0.0.1:<port>/api/verse/agent-tools/mcp` */
  url: string;
  scopes: VerseMcpScope[];
}

/**
 * Mint this turn's token, replacing (and revoking) any the chat still holds.
 * Null when the chat has no scope, or the sidecar's address is unknown — the
 * launch then carries no Verse server at all.
 */
export function mintVerseMcpTurn(sessionId: string, engine: string): VerseMcpTurnCredential | null {
  const scopes = agentToolScopes(sessionId);
  const origin = sidecarOriginFor(sessionId);
  revokeVerseMcpTurn(sessionId, 'A new turn started.');
  if (scopes.length === 0 || !origin) return null;
  beginBrowserTurn(sessionId);
  const token = randomBytes(32).toString('base64url');
  const digest = digestOf(token);
  mintSeq += 1;
  tokens.set(digest, { digest, seq: mintSeq, sessionId, engine, issuedAt: clock(), controller: new AbortController(), remoteRead: false });
  tokenBySession.set(sessionId, digest);
  return { sessionId, token, url: `${origin}${VERSE_MCP_PATH}`, scopes };
}

/**
 * How many tokens this process has minted so far. A turn-end hook reads it
 * FIRST (synchronously) and revokes with `mintedUpTo`, so a follow-up turn
 * the queue started in the meantime keeps its fresh token.
 */
export function verseMcpMintSeq(): number {
  return mintSeq;
}

/** Revoke the chat's live token (turn end, stop, deletion, tools off). Pending confirmations are refused. Idempotent. */
export function revokeVerseMcpTurn(sessionId: string, reason = 'The turn ended.', opts: { mintedUpTo?: number } = {}): void {
  const digest = tokenBySession.get(sessionId);
  if (digest && opts.mintedUpTo !== undefined && (tokens.get(digest)?.seq ?? 0) > opts.mintedUpTo) return;
  if (digest) {
    tokenBySession.delete(sessionId);
    const turn = tokens.get(digest);
    tokens.delete(digest);
    try { turn?.controller.abort(new Error(reason)); } catch { /* already aborted */ }
  }
  const state = chats.get(sessionId);
  if (state) {
    for (const pending of [...state.pending.values()]) pending.settle('revoked');
  }
}

/** Revoke every live token (the kill switch). */
export function revokeAllVerseMcpTurns(reason: string): void {
  for (const sessionId of [...tokenBySession.keys()]) revokeVerseMcpTurn(sessionId, reason);
}

export interface VerseMcpTurn {
  sessionId: string;
  engine: string;
  /** Aborted when the token is revoked. */
  signal: AbortSignal;
  remoteRead(): boolean;
  markRemoteRead(): void;
}

/** The live turn a presented bearer token belongs to, or null (unknown, revoked, expired, malformed). */
export function turnForBearer(token: string): VerseMcpTurn | null {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const turn = tokens.get(digestOf(token));
  if (!turn) return null;
  if (clock() - turn.issuedAt > VERSE_MCP_TOKEN_MAX_AGE_MS) {
    revokeVerseMcpTurn(turn.sessionId, 'The token expired.');
    return null;
  }
  return {
    sessionId: turn.sessionId,
    engine: turn.engine,
    signal: turn.controller.signal,
    remoteRead: () => turn.remoteRead,
    markRemoteRead: () => { turn.remoteRead = true; },
  };
}

/** Does the chat hold a live turn token right now? */
export function verseMcpTurnActive(sessionId: string): boolean {
  return tokenBySession.has(sessionId);
}

// ---------------------------------------------------------------------------
// Terminal tabs: agent-owned, shared, taken over
// ---------------------------------------------------------------------------

export function registerAgentTab(tabId: string, sessionId: string): void {
  agentTabs.set(tabId, sessionId);
}

/** A tab went away: forget everything about it. */
export function forgetAgentTab(tabId: string): void {
  agentTabs.delete(tabId);
  takenOver.delete(tabId);
  for (const state of chats.values()) state.sharedTabs.delete(tabId);
}

/** The chat whose agent owns this tab, or null. */
export function agentTabOwner(tabId: string): string | null {
  return agentTabs.get(tabId) ?? null;
}

/** Agent tabs this chat's agent opened. */
export function agentTabsOf(sessionId: string): string[] {
  return [...agentTabs.entries()].filter(([, owner]) => owner === sessionId).map(([tabId]) => tabId);
}

/**
 * Share (or stop sharing) one of the chat's OWN operator shells with its
 * agent. The API has checked the tab belongs to the chat and is not an agent
 * tab. Only meaningful while the chat's terminal mode is `shared`.
 */
export function setTabShared(sessionId: string, tabId: string, shared: boolean): boolean {
  const state = chatFor(sessionId);
  if (shared) {
    if (state.grant.terminal !== 'shared') return false;
    state.sharedTabs.add(tabId);
  } else {
    state.sharedTabs.delete(tabId);
  }
  return true;
}

export function sharedTabsOf(sessionId: string): string[] {
  const state = chats.get(sessionId);
  if (!state || state.grant.terminal !== 'shared') return [];
  return [...state.sharedTabs];
}

/** How this chat's agent may use a tab: its own, shared with it, or not at all. */
export function tabAccess(sessionId: string, tabId: string): 'agent' | 'shared' | null {
  if (agentTabs.get(tabId) === sessionId) return 'agent';
  if (sharedTabsOf(sessionId).includes(tabId)) return 'shared';
  return null;
}

/**
 * Is this input an operator KEYSTROKE (as opposed to the terminal emulator
 * answering a query — cursor position, device attributes, focus in/out,
 * colour reports)? xterm.js sends those replies through the same input path.
 */
export function isOperatorKeystroke(bytes: Uint8Array): boolean {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  const stripped = text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?>]*[RcnItyO]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[IO]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1bP[^\x1b]*\x1b\\/g, '');
  return stripped.length > 0;
}

/** Operator input reached a tab. Returns true when it paused an agent there. */
export function noteOperatorInput(tabId: string, bytes: Uint8Array): boolean {
  const controlled = agentTabs.has(tabId) || [...chats.values()].some((s) => s.grant.terminal === 'shared' && s.sharedTabs.has(tabId));
  if (!controlled || takenOver.has(tabId) || !isOperatorKeystroke(bytes)) return false;
  takenOver.set(tabId, clock());
  for (const listener of [...takeoverListeners]) {
    try { listener(tabId); } catch { /* one listener never stops the others */ }
  }
  return true;
}

export function tabTakenOver(tabId: string): boolean {
  return takenOver.has(tabId);
}

export function resumeAgentTab(tabId: string): boolean {
  return takenOver.delete(tabId);
}

/** Called (synchronously) whenever the operator takes a tab over. Returns unsubscribe. */
export function onTabTakeover(listener: (tabId: string) => void): () => void {
  takeoverListeners.add(listener);
  return () => { takeoverListeners.delete(listener); };
}

/** Every agent-controlled tab, for the Terminal pane (optionally only these ids). */
export function agentTabInfos(tabIds?: readonly string[]): VerseAgentTabInfo[] {
  const out: VerseAgentTabInfo[] = [];
  for (const [tabId, sessionId] of agentTabs) out.push({ tabId, sessionId, kind: 'agent', takenOverAt: takenOver.has(tabId) ? iso(takenOver.get(tabId)!) : null });
  for (const [sessionId, state] of chats) {
    if (state.grant.terminal !== 'shared') continue;
    for (const tabId of state.sharedTabs) out.push({ tabId, sessionId, kind: 'shared', takenOverAt: takenOver.has(tabId) ? iso(takenOver.get(tabId)!) : null });
  }
  return tabIds ? out.filter((t) => tabIds.includes(t.tabId)) : out;
}

// ---------------------------------------------------------------------------
// Confirmations
// ---------------------------------------------------------------------------

export interface VerseMcpConfirmRequest {
  tool: string;
  rule: string;
  reason: string;
  command: string;
  tabId: string | null;
}

/**
 * Ask the operator. Resolves — never rejects — with their answer, `timeout`
 * after `timeoutMs`, or `revoked` when the turn ends first. A rule the
 * operator allowed for this chat answers `chat` at once.
 */
export function requestAgentConfirmation(
  sessionId: string,
  req: VerseMcpConfirmRequest,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<VerseMcpConfirmOutcome> {
  const state = chatFor(sessionId);
  // A command can match several rules (`sudo rm -rf …` → `sudo+rm-recursive`): all must be allowed.
  if (req.rule.split('+').every((rule) => state.allowedRules.has(rule))) return Promise.resolve('chat');
  if (opts.signal?.aborted) return Promise.resolve('revoked');
  if (state.pending.size >= MAX_PENDING_PER_CHAT) return Promise.resolve('deny');
  const timeoutMs = opts.timeoutMs ?? VERSE_MCP_CONFIRM_TIMEOUT_MS;
  const now = clock();
  const id = `cf_${randomBytes(9).toString('base64url')}`;
  const info: VerseAgentPendingConfirmation = {
    id,
    sessionId,
    at: iso(now),
    expiresAt: iso(now + timeoutMs),
    tool: req.tool.slice(0, 60),
    rule: req.rule.slice(0, 200),
    reason: req.reason.slice(0, 300),
    command: req.command.slice(0, 2_000),
    tabId: req.tabId,
  };
  return new Promise((resolve) => {
    let settled = false;
    const onAbort = (): void => pending.settle('revoked');
    const pending: PendingConfirmation = {
      info,
      timer: setTimeout(() => pending.settle('timeout'), timeoutMs),
      settle: (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(pending.timer);
        state.pending.delete(id);
        opts.signal?.removeEventListener('abort', onAbort);
        if (outcome === 'chat') for (const rule of info.rule.split('+')) state.allowedRules.add(rule);
        resolve(outcome);
      },
    };
    if (typeof pending.timer.unref === 'function') pending.timer.unref();
    state.pending.set(id, pending);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The operator's answer. False when nothing with that id is waiting on that chat. */
export function answerAgentConfirmation(sessionId: string, id: string, answer: VerseMcpConfirmAnswer): boolean {
  const pending = chats.get(sessionId)?.pending.get(id);
  if (!pending) return false;
  if (answer === 'chat' && pending.info.rule.startsWith('terminal-run-')) return false;
  pending.settle(answer);
  return true;
}

export function pendingConfirmations(sessionId: string): VerseAgentPendingConfirmation[] {
  return [...(chats.get(sessionId)?.pending.values() ?? [])].map((p) => ({ ...p.info }));
}

// ---------------------------------------------------------------------------
// Recent actions
// ---------------------------------------------------------------------------

export function recordAgentAction(sessionId: string, action: Omit<VerseAgentAction, 'id' | 'at'>): string {
  const state = chatFor(sessionId);
  const id = `aa_${randomBytes(6).toString('hex')}`;
  state.actions.unshift({ ...action, id, at: iso(clock()), summary: action.summary.slice(0, 300) });
  if (state.actions.length > MAX_ACTIONS) state.actions.length = MAX_ACTIONS;
  return id;
}

export function updateAgentAction(sessionId: string, id: string, outcome: VerseAgentAction['outcome']): void {
  const action = chats.get(sessionId)?.actions.find((a) => a.id === id);
  if (action) action.outcome = outcome;
}

export function recentAgentActions(sessionId: string): VerseAgentAction[] {
  return (chats.get(sessionId)?.actions ?? []).map((a) => ({ ...a }));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** A deleted chat: revoke its token, refuse its confirmations, forget its tabs and grant. Idempotent. */
export function forgetAgentToolsChat(sessionId: string): void {
  revokeVerseMcpTurn(sessionId, 'This chat was deleted.');
  for (const [tabId, owner] of [...agentTabs]) if (owner === sessionId) forgetAgentTab(tabId);
  chats.delete(sessionId);
}

/** Test hygiene: forget everything and restore the clock. */
export function resetVerseMcpGrantsForTest(): void {
  for (const sessionId of [...chats.keys()]) {
    for (const pending of [...(chats.get(sessionId)?.pending.values() ?? [])]) pending.settle('revoked');
  }
  for (const turn of tokens.values()) { try { turn.controller.abort(); } catch { /* ignore */ } }
  chats.clear();
  tokens.clear();
  tokenBySession.clear();
  agentTabs.clear();
  takenOver.clear();
  takeoverListeners.clear();
  fallbackSidecarOrigin = null;
  clock = Date.now;
}

export function setVerseMcpGrantsClockForTest(next: (() => number) | null): void {
  clock = next ?? Date.now;
}
