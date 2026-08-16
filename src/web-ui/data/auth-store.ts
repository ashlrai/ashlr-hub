/**
 * data/auth-store.ts — the read-session + mutation-token authority for the
 * whole app. Mirrors the two-token model in src/core/web/server.ts exactly:
 *
 *   READ authority  — exchanged once via POST /api/session (raw readToken +
 *                      a per-tab client proof) for an HttpOnly cookie good
 *                      for 15 minutes. The raw read token is held in memory
 *                      only long enough to make that exchange and is then
 *                      discarded; the client proof is not a secret by
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
    setState({ phase: 'authenticated', checked: true });
    return;
  }
  if (res.status === 401) {
    throw new Error('Server rejected that token. Double-check the value ashlr serve printed.');
  }
  throw new Error(`Unexpected response establishing session (HTTP ${res.status}).`);
}

export async function clearReadSession(): Promise<void> {
  try {
    await fetch('/api/session', { method: 'DELETE', credentials: 'same-origin' });
  } catch {
    /* best-effort */
  }
  setState({ phase: 'unauthenticated' });
}

/** Called by data/client.ts whenever any authenticated GET comes back 401. */
export function reportSessionExpired(): void {
  if (state.phase !== 'authenticated') return;
  setState({ phase: 'unauthenticated' });
}

export function markCheckComplete(authenticated: boolean): void {
  setState({ phase: authenticated ? 'authenticated' : 'unauthenticated', checked: true });
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
  mutationHoldTimer = setTimeout(() => clearMutationToken(), MUTATION_HOLD_MS);
}

/** Set the mutation token for this tab's session hold. Never persisted. */
export function setMutationToken(token: string): void {
  mutationToken = token;
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
  if (mutationHoldTimer) {
    clearTimeout(mutationHoldTimer);
    mutationHoldTimer = null;
  }
  setState({ mutationTokenHeldUntil: null });
}
