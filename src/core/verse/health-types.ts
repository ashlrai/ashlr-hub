/**
 * Verse seat health — V3.10 contract (unit A0, frozen once written).
 *
 * The account-health sweep (core/verse/account-health.ts) answers "can this
 * seat run a turn right now, and if not, what fixes it?" from ZERO-COST status
 * commands only (`auth status`, `login status`, `--version`, Ollama
 * `/api/version`). Nothing here ever carries a secret: expiry is reported as a
 * timestamp, never the credential.
 *
 * Honesty rule (docs/VERSE-TELEMETRY-V2.md): `null` means UNKNOWN, never
 * "none" or "zero". A seat whose status could not be read is `unknown`, not
 * `connected`.
 *
 * BROWSER-SAFE: imported by the web bundle — type-only imports and plain
 * constants, no node: modules.
 */
import type { VerseEngine } from './types.js';

/**
 * - `connected`    — signed in, credential valid, CLI build usable.
 * - `expiring`     — signed in, but the credential expires soon (from its timestamp).
 * - `signed-out`   — the CLI reports no usable login.
 * - `exhausted`    — signed in, but the subscription window is spent (e.g. codex `limitReached`).
 * - `binary-skew`  — the seat is pinned to an older CLI than the newest installed build.
 * - `unknown`      — status could not be determined.
 */
export type SeatConnection = 'connected' | 'expiring' | 'signed-out' | 'exhausted' | 'binary-skew' | 'unknown';

export const SEAT_CONNECTIONS: readonly SeatConnection[] = [
  'connected',
  'expiring',
  'signed-out',
  'exhausted',
  'binary-skew',
  'unknown',
];

/**
 * - `reauth` — run `command` (the seat launcher's login command) in a terminal.
 * - `repin`  — re-pin the seat's native profile to the newest CLI (`command`).
 * - `wait`   — nothing to do but wait for `resetAt`.
 * - `none`   — healthy, or no known remedy.
 */
export type SeatFixKind = 'reauth' | 'repin' | 'wait' | 'none';

export interface SeatHealthFix {
  kind: SeatFixKind;
  /** argv of the command that fixes it (never a shell string; never contains a secret). */
  command?: string[];
}

export interface SeatHealthReport {
  seatId: string;
  engine: VerseEngine;
  connection: SeatConnection;
  /** ISO time this report was produced. */
  checkedAt: string;
  /** Version of the CLI the seat is pinned to; null when unknown / local. */
  cliVersion: string | null;
  /** Newest installed CLI build found on this machine; null when unknown. */
  newestCliVersion: string | null;
  /** ISO expiry of the seat's credential, from its timestamp only; null when unknown. */
  credentialExpiresAt: string | null;
  /** ISO time the credential was last refreshed; null when unknown. */
  lastRefreshAt: string | null;
  /** ISO time an `exhausted` window resets; null when not exhausted or unknown. */
  resetAt: string | null;
  /** Plain-language, already-scrubbed reasons behind `connection` (empty when connected). */
  reasons: string[];
  fix: SeatHealthFix;
}

/**
 * Engine admission answer for one seat (`getSeatReadiness(seatId)` in
 * core/verse/seats.ts). `alternatives` are seat ids, ranked best-first, that
 * ARE ready — so a refusal always offers a way forward.
 */
export interface SeatReadiness {
  seatId: string;
  ready: boolean;
  /** Plain-language reason when not ready; null when ready. */
  reason: string | null;
  alternatives: string[];
}

/** GET /api/verse/health */
export interface VerseHealthResponse {
  checkedAt: string;
  seats: SeatHealthReport[];
}

export const VERSE_HEALTH_PATH = '/api/verse/health';

/** Stable machine code on the 409 a turn gets when its seat is not ready. */
export const SEAT_NOT_READY_CODE = 'seat-not-ready';

/**
 * 409 body for POST …/turns (or session create) refused by the readiness gate.
 * `error` is the human sentence; `readiness` carries the ranked alternatives.
 */
export interface SeatNotReadyResponse {
  error: string;
  code: typeof SEAT_NOT_READY_CODE;
  readiness: SeatReadiness;
}
