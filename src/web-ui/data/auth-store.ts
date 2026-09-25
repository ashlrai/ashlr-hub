/**
 * data/auth-store.ts — the read-session + mutation-token authority for the
 * whole app. Mirrors the two-token model in src/core/web/server.ts exactly:
 *
 *   READ authority  — exchanged via POST /api/session (raw readToken + a
 *                      per-tab client proof) for an HttpOnly cookie good
 *                      for 15 minutes. The raw read token is remembered in
 *                      MEMORY ONLY (never any storage) for the tab's
 *                      lifetime so the 15-minute ticket can be renewed
 *                      silently when a GET/SSE comes back 401 — a live
 *                      chat must not turn into "paste a 64-hex token every
 *                      15 minutes". The client proof is not a secret by
 *                      itself (it has no authority without the signed
 *                      cookie) and is kept in sessionStorage so a page
 *                      reload can keep using the still-valid cookie instead
 *                      of forcing re-entry.
 *
 *   MUTATION authority — the raw x-ashlr-token header, required on every
 *                      mutating call, NEVER exchanged for a session and
 *                      NEVER persisted to any storage. Held in memory only,
 *                      for a bounded "hold" window, so approving a run of
 *                      proposals isn't one window.prompt() per click. The
 *                      hold is cleared on tab close, explicit lock, or
 *                      idle timeout.
 *
 * This module has no React dependency — it is a plain external store
 * consumed via useSyncExternalStore in hooks.ts, per the same pattern used
 * for the query cache.
 */

import { evictAll, invalidateObserved } from './cache.js';
// The composer owns its own storage format, so the key names live with it
// rather than being duplicated here where they could drift.
import { clearComposerMemory } from '../routes/verse/chat/composer-memory.js';

const READ_CLIENT_STORAGE_KEY = 'ashlr.readClientProof.v1';
const READ_CLIENT_RE = /^[a-f0-9]{64}$/;
const MUTATION_HOLD_MS = 20 * 60 * 1000; // 20 minutes of inactivity clears the hold.

export type AuthPhase = 'checking' | 'unauthenticated' | 'authenticated';

interface AuthState {
  phase: AuthPhase;
  /** True once a session check has actually completed (vs. still booting). */
  checked: boolean;
  mutationTokenHeldUntil: number | null;
}

function randomHex64(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function loadOrCreateClientProof(): string {
  try {
    const existing = sessionStorage.getItem(READ_CLIENT_STORAGE_KEY);
    if (existing && READ_CLIENT_RE.test(existing)) return existing;
  } catch {
    // sessionStorage unavailable (privacy mode, etc.) — fall through to an
    // in-memory-only proof for this page life.
  }
  const proof = randomHex64();
  try {
    sessionStorage.setItem(READ_CLIENT_STORAGE_KEY, proof);
  } catch {
    /* best-effort persistence only */
  }
  return proof;
}

let clientProof = loadOrCreateClientProof();

/** In-memory only. Never touches storage. Cleared by clearMutationToken(). */
let mutationToken: string | null = null;
let mutationHoldTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * The mutation token came from the desktop host (window.__ASHLR_TOKENS__).
 * The operator never saw it, so an idle timeout must re-arm the hold rather
 * than clear it — a cleared hold would ask for a token nobody can paste.
 */
let mutationHeldByHost = false;

/**
 * Last read token that the server accepted (typed or host-injected). Memory
 * only, same trust boundary as the mutation hold; used to renew the cookie
 * silently on 401. Dropped on explicit disconnect or when renewal fails.
 */
let rememberedReadToken: string | null = null;
let renewal: Promise<boolean> | null = null;
/** Desktop-injected tokens kept for re-adoption (see the host-injected section below). */
let hostTokens: InjectedTokens | null = null;

let state: AuthState = { phase: 'checking', checked: false, mutationTokenHeldUntil: null };
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function setState(patch: Partial<AuthState>): void {
  state = { ...state, ...patch };
  emit();
}

export function subscribeAuth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAuthSnapshot(): AuthState {
  return state;
}

export function getReadClientProof(): string {
  return clientProof;
}

/** Regenerate the client proof (e.g. after an explicit "forget this device"). */
export function resetReadClientProof(): string {
  clientProof = randomHex64();
  try {
    sessionStorage.setItem(READ_CLIENT_STORAGE_KEY, clientProof);
  } catch {
    /* best-effort */
  }
  return clientProof;
}

/**
 * Exchange a raw read token for a session cookie. Throws on failure with a
 * message safe to show the operator. The raw token never leaves this call.
 */
export async function establishReadSession(rawReadToken: string): Promise<void> {
  const trimmed = rawReadToken.trim();
  if (!/^[a-f0-9]{64}$/.test(trimmed)) {
    throw new Error('That does not look like a read token — expected 64 hex characters.');
  }
  const res = await fetch('/api/session', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'x-ashlr-token': trimmed,
      'x-ashlr-read-client': clientProof,
    },
  });
  if (res.status === 204) {
    rememberedReadToken = trimmed;
    setState({ phase: 'authenticated', checked: true });
    return;
  }
  if (res.status === 401) {
    throw new Error('Server rejected that token. Double-check the read token printed by this server at startup.');
  }
  throw new Error(`Unexpected response establishing session (HTTP ${res.status}).`);
}

export async function clearReadSession(): Promise<void> {
  try {
    await fetch('/api/session', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'x-ashlr-read-client': clientProof },
    });
  } catch {
    /* best-effort */
  }
  rememberedReadToken = null;
  hostTokens = null;
  expireNow();
}

function expireNow(): void {
  clearMutationToken();
  evictAll();
  // `evictAll` clears the query cache so nothing stale leaks into the next
  // session's first paint. The composer's drafts and sent-message history live
  // in localStorage, not in that cache, and they are verbatim prompt text —
  // exactly the kind of content this wipe exists for.
  clearComposerMemory();
  setState({ phase: 'unauthenticated', checked: true });
}

/**
 * Called by data/client.ts whenever any authenticated GET comes back 401
 * (and by sse.ts on `session-expired`). With a remembered read token the
 * cookie is re-issued silently and the phase never flips; the failed call's
 * own retry/reconnect (SSE backoff, the next refetch) then succeeds. Only
 * when renewal fails (server restarted with fresh tokens) does the gate show.
 */
export function reportSessionExpired(): void {
  if (state.phase !== 'authenticated') return;
  if (rememberedReadToken) {
    void renewReadSession();
    return;
  }
  expireNow();
}

/** Re-exchange the remembered read token for a fresh cookie; one flight at a time. */
export function renewReadSession(): Promise<boolean> {
  if (renewal) return renewal;
  const token = rememberedReadToken;
  if (!token) return Promise.resolve(false);
  renewal = (async () => {
    try {
      await establishReadSession(token);
      // Whatever is on screen and 401ed while the ticket was lapsed refetches
      // against the new cookie. Only what is OBSERVED: an entry nobody reads
      // (a surface the idle warm-up fetched but the operator never opened)
      // re-reads when it next mounts, if it is stale or failed — re-running
      // them all here cost ~8 background reads every 15 minutes, all day.
      invalidateObserved('');
      return true;
    } catch {
      rememberedReadToken = null;
      hostTokens = null;
      expireNow();
      return false;
    } finally {
      renewal = null;
    }
  })();
  return renewal;
}

/** Test hygiene: forget the remembered read token and host tokens without a network call. */
export function forgetRememberedTokens(): void {
  rememberedReadToken = null;
  hostTokens = null;
  renewal = null;
}

export function markCheckComplete(authenticated: boolean): void {
  setState({ phase: authenticated ? 'authenticated' : 'unauthenticated', checked: true });
}

// ---------------------------------------------------------------------------
// Host-injected tokens (desktop wrapper). The Tauri shell starts the server
// itself and hands both tokens to the page through an initialization script
// (`window.__ASHLR_TOKENS__`, see desktop/README.md) so the operator never
// pastes them. The object is removed from `window` before either token is
// used and kept in this module's memory instead (`hostTokens`), because the
// desktop operator has no terminal to paste from: when the 15-minute cookie
// lapses or the gate re-mounts, adoption re-runs from memory. The read token
// is exchanged for the cookie exactly like a typed one and the mutation token
// goes into the memory-only hold. Nothing is persisted and nothing is logged.
// ---------------------------------------------------------------------------

export interface InjectedTokens {
  readToken: string;
  /** Mutation token; absent or null when the host started the server without dispatch. */
  token?: string | null;
}

declare global {
  interface Window {
    __ASHLR_TOKENS__?: InjectedTokens;
  }
}

/**
 * Take host-injected tokens: from `window` (cleared from the page on first
 * sight, remembered here) or, on later calls, from memory.
 */
export function takeInjectedTokens(): InjectedTokens | null {
  const injected = window.__ASHLR_TOKENS__;
  if (injected && typeof injected === 'object') {
    try {
      delete window.__ASHLR_TOKENS__;
    } catch {
      window.__ASHLR_TOKENS__ = undefined;
    }
    if (typeof injected.readToken === 'string') {
      hostTokens = { readToken: injected.readToken, ...(typeof injected.token === 'string' ? { token: injected.token } : {}) };
    }
  }
  return hostTokens ? { ...hostTokens } : null;
}

/**
 * Establish the read session (and set the mutation hold) from host-injected
 * tokens. Resolves true when a session was established; false when nothing
 * was injected or the server rejected the read token (the caller then falls
 * back to the normal SessionGate flow — the failure is never surfaced with
 * the token in it).
 */
export async function adoptInjectedTokens(): Promise<boolean> {
  const injected = takeInjectedTokens();
  if (!injected) return false;
  try {
    await establishReadSession(injected.readToken);
  } catch {
    // Wrong or stale tokens are not worth retrying from memory.
    hostTokens = null;
    return false;
  }
  if (injected.token && /^[a-f0-9]{64}$/.test(injected.token.trim())) setMutationToken(injected.token.trim(), { host: true });
  return true;
}

// ---------------------------------------------------------------------------
// Mutation token — session-scoped hold, memory-only.
// ---------------------------------------------------------------------------

export function getMutationToken(): string | null {
  return mutationToken;
}

export function hasMutationHold(): boolean {
  return mutationToken !== null;
}

function armIdleClear(): void {
  if (mutationHoldTimer) clearTimeout(mutationHoldTimer);
  mutationHoldTimer = setTimeout(() => {
    // A host-held token has no operator to re-paste it: keep the hold alive.
    if (mutationHeldByHost && mutationToken !== null) touchMutationHold();
    else clearMutationToken();
  }, MUTATION_HOLD_MS);
}

/**
 * Set the mutation token for this tab's session hold. Never persisted.
 * `host` marks a token injected by the desktop wrapper (see adoptInjectedTokens).
 */
export function setMutationToken(token: string, opts: { host?: boolean } = {}): void {
  mutationToken = token;
  mutationHeldByHost = opts.host === true;
  const heldUntil = Date.now() + MUTATION_HOLD_MS;
  setState({ mutationTokenHeldUntil: heldUntil });
  armIdleClear();
}

/** Extend the hold window on real use (called after every mutating call). */
export function touchMutationHold(): void {
  if (mutationToken === null) return;
  const heldUntil = Date.now() + MUTATION_HOLD_MS;
  setState({ mutationTokenHeldUntil: heldUntil });
  armIdleClear();
}

export function clearMutationToken(): void {
  mutationToken = null;
  mutationHeldByHost = false;
  if (mutationHoldTimer) {
    clearTimeout(mutationHoldTimer);
    mutationHoldTimer = null;
  }
  setState({ mutationTokenHeldUntil: null });
}
