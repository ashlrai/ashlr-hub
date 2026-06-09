/**
 * core/integrations/identity.ts — Phantom identity probe (M18).
 *
 * INTENTIONALLY VALUES-FREE: derives only names/status from the phantom CLI.
 * Never reads, captures, logs, or returns secret values under any code path.
 *
 * Public API:
 *   getIdentity(): Identity
 *     — reads phantom cloud status + team list to derive who the caller is.
 *     — NEVER throws; degrades to {loggedIn:false,...null} on any failure.
 *     — bounded by a short timeout on each probe call.
 */

import { spawnSync } from 'node:child_process';
import type { Identity } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PHANTOM_BIN = 'phantom';
/** Hard cap per phantom call — keeps getIdentity() snappy. */
const TIMEOUT_MS = 4_000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Run a phantom sub-command synchronously.
 * Never throws — all errors surface in the returned `error` string.
 */
function runPhantom(args: string[]): {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: string;
} {
  try {
    const result = spawnSync(PHANTOM_BIN, args, {
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      // Suppress interactive prompts / update-check noise.
      env: { ...process.env, PHANTOM_NO_UPDATE_CHECK: '1' },
    });

    if (result.error) {
      return { stdout: '', stderr: '', status: null, error: result.error.message };
    }

    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      status: result.status,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { stdout: '', stderr: '', status: null, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Parsers — names/status only, deliberately conservative
// ---------------------------------------------------------------------------

/**
 * Parse `phantom cloud status [--json]` output to extract login state and
 * optional user name.
 *
 * When logged in, phantom typically prints one of:
 *   ->  Cloud: logged in as <user>  (e.g. mason@evero-consulting.com)
 *   ->  Cloud: logged in            (no user shown)
 *
 * When logged out:
 *   ->  Cloud: not logged in — run `phantom login`
 *
 * JSON form (--json) may yield: { "loggedIn": true, "user": "...", ... }
 * We try JSON first, then fall back to the human-text heuristic.
 *
 * NEVER reads or returns secret values.
 */
function parseCloudStatus(raw: string): { loggedIn: boolean; user: string | null } {
  const trimmed = raw.trim();

  // ── JSON path ─────────────────────────────────────────────────────────────
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      // Recognised shapes:
      //   { "loggedIn": true, "user": "alice" }
      //   { "authenticated": true, "email": "alice@example.com" }
      //   { "account": { "email": "..." }, "loggedIn": true }
      const loggedIn =
        typeof parsed['loggedIn'] === 'boolean'
          ? parsed['loggedIn']
          : typeof parsed['authenticated'] === 'boolean'
            ? parsed['authenticated']
            : null;

      if (loggedIn !== null) {
        const user = extractUserFromJson(parsed);
        return { loggedIn, user };
      }
    } catch {
      // Fall through to text heuristic.
    }
  }

  // ── Human-text heuristic ──────────────────────────────────────────────────
  const lc = trimmed.toLowerCase();

  // "not logged in" / "not authenticated" / "run `phantom login`"
  if (
    lc.includes('not logged in') ||
    lc.includes('not authenticated') ||
    lc.includes('phantom login')
  ) {
    return { loggedIn: false, user: null };
  }

  // "logged in as <user>" — extract the user handle that follows "as "
  if (lc.includes('logged in')) {
    const user = extractUserFromText(trimmed);
    return { loggedIn: true, user };
  }

  // Ambiguous / empty — treat as logged out.
  return { loggedIn: false, user: null };
}

/**
 * Extract a user identifier from a JSON object.
 * Only reads fields whose names clearly carry an account handle/email/id.
 * Returns null when none is found.
 */
function extractUserFromJson(obj: Record<string, unknown>): string | null {
  // Direct top-level fields
  for (const key of ['user', 'email', 'username', 'handle', 'id']) {
    if (typeof obj[key] === 'string' && (obj[key] as string).length > 0) {
      return obj[key] as string;
    }
  }
  // Nested account/profile object
  for (const containerKey of ['account', 'profile', 'identity']) {
    const container = obj[containerKey];
    if (container !== null && typeof container === 'object') {
      const inner = container as Record<string, unknown>;
      for (const key of ['user', 'email', 'username', 'handle', 'id']) {
        if (typeof inner[key] === 'string' && (inner[key] as string).length > 0) {
          return inner[key] as string;
        }
      }
    }
  }
  return null;
}

/**
 * Extract the user handle from a human-text "logged in as <user>" line.
 * Returns null when no recognisable handle can be found.
 */
function extractUserFromText(line: string): string | null {
  // Pattern: "logged in as <handle>" or "Logged in as: <handle>"
  // (case-insensitive; tolerates an optional colon after "as").
  const inlineMatch = line.match(/logged\s+in\s+as\s*:?\s+(\S+)/i);
  if (inlineMatch && inlineMatch[1]) {
    return inlineMatch[1];
  }
  // Fallback: a labelled "User: <handle>" line (phantom's verbose text form).
  const userLineMatch = line.match(/^[\t ]*user\s*:?\s+(\S+)/im);
  if (userLineMatch && userLineMatch[1]) {
    return userLineMatch[1];
  }
  return null;
}

/**
 * Parse `phantom team list [--json]` to find the caller's active team name.
 *
 * JSON form may yield:
 *   [ { "name": "my-team", "role": "admin", "active": true }, ... ]
 *   { "teams": [ ... ] }
 *
 * Text form: table lines like "my-team   admin   active"
 *
 * We return the first team marked active, or the first team when none is
 * explicitly marked. Returns null on any parse failure.
 *
 * NEVER reads or returns secret values.
 */
function parseTeamName(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // ── JSON path ─────────────────────────────────────────────────────────────
  // When the input is JSON-shaped we ONLY trust the JSON path and never fall
  // through to the whitespace-token text heuristic — that heuristic would
  // otherwise return the entire raw JSON blob (potentially leaking embedded
  // secret-shaped fields) as the "team name".
  const looksJson = trimmed.startsWith('[') || trimmed.startsWith('{');
  if (looksJson) {
    try {
      let parsed: unknown = JSON.parse(trimmed);
      // Unwrap { "teams": [...] }
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed)
      ) {
        const obj = parsed as Record<string, unknown>;
        if (Array.isArray(obj['teams'])) parsed = obj['teams'];
      }

      if (Array.isArray(parsed) && parsed.length > 0) {
        // Prefer an entry explicitly marked active.
        for (const item of parsed) {
          if (item !== null && typeof item === 'object') {
            const t = item as Record<string, unknown>;
            if (t['active'] === true && typeof t['name'] === 'string') {
              return t['name'] as string;
            }
          }
        }
        // Fall back to the first entry.
        const first = parsed[0];
        if (first !== null && typeof first === 'object') {
          const t = first as Record<string, unknown>;
          if (typeof t['name'] === 'string') return t['name'] as string;
          if (typeof t['slug'] === 'string') return t['slug'] as string;
        }
      }
    } catch {
      // Malformed JSON — do not fall through to the text heuristic.
    }
    // JSON-shaped input is handled exclusively above; never run the text
    // heuristic on it (avoids returning a raw JSON blob as a team name).
    return null;
  }

  // ── Human-text heuristic ──────────────────────────────────────────────────
  // Phantom team list typically renders a table:
  //   NAME         ROLE    STATUS
  //   my-team      admin   active
  //   other-team   member  -
  //
  // Strategy: skip header, extract first token from lines that contain "active".
  const lines = trimmed.split('\n');
  let firstCandidate: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // Skip obvious header lines.
    const lc = line.toLowerCase();
    if (lc.startsWith('name') && (lc.includes('role') || lc.includes('status'))) continue;
    if (lc.startsWith('error') || lc.startsWith('!')) continue;

    const token = line.split(/\s+/)[0];
    if (!token || token.length === 0) continue;

    if (firstCandidate === null) firstCandidate = token;
    if (lc.includes('active')) return token;
  }

  return firstCandidate;
}

/**
 * Parse `phantom cloud status [--json]` for a tier/plan name.
 *
 * Phantom may include tier in cloud status:
 *   JSON: { "tier": "pro", ... }  /  { "plan": "free", ... }
 *   Text: typically not surfaced — we return null unless JSON provides it.
 */
function parseTier(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ['tier', 'plan', 'subscription']) {
      if (typeof parsed[key] === 'string' && (parsed[key] as string).length > 0) {
        return parsed[key] as string;
      }
    }
    // Nested: { "account": { "tier": "pro" } }
    for (const containerKey of ['account', 'profile']) {
      const container = parsed[containerKey];
      if (container !== null && typeof container === 'object') {
        const inner = container as Record<string, unknown>;
        for (const key of ['tier', 'plan', 'subscription']) {
          if (typeof inner[key] === 'string' && (inner[key] as string).length > 0) {
            return inner[key] as string;
          }
        }
      }
    }
  } catch {
    // Not JSON or parse failed — no tier.
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns a read-only identity snapshot derived from the `phantom` CLI.
 *
 * Guarantees:
 *  - NEVER throws.
 *  - NEVER returns secret values — names/status only.
 *  - Degrades to {loggedIn:false, user:null, tier:null, team:null} when
 *    phantom is absent, not logged in, or returns unexpected output.
 *  - Each probe call is bounded by TIMEOUT_MS (4 s).
 *
 * Probe sequence:
 *  1. `phantom cloud status --json` — login state + user + tier. A spawn
 *     error here (phantom absent) degrades to {loggedIn:false,...}.
 *  2. `phantom team list --json` — team name (only when logged in).
 */
export function getIdentity(): Identity {
  const notLoggedIn: Identity = {
    loggedIn: false,
    user: null,
    tier: null,
    team: null,
  };

  // ── 1. Cloud status: login state + user + tier ────────────────────────────
  //
  // The first probe is `phantom cloud status` itself — a spawn error here
  // (ENOENT when phantom is absent) degrades to notLoggedIn below, so no
  // separate `--version` presence check is needed.
  //
  //
  // Try --json first; fall back to plain text.  Both paths go through the
  // same parser which handles JSON then falls back to human-text heuristic.
  let loggedIn = false;
  let user: string | null = null;
  let tier: string | null = null;

  {
    // First attempt: structured JSON output.
    const { stdout: jsonOut, error: jsonErr } = runPhantom(['cloud', 'status', '--json']);
    if (jsonErr === undefined && jsonOut.trim().length > 0) {
      const parsed = parseCloudStatus(jsonOut);
      loggedIn = parsed.loggedIn;
      user = parsed.user;
      tier = parseTier(jsonOut);
    }

    // If JSON probe gave nothing useful, try plain text.
    if (!loggedIn && jsonErr !== undefined) {
      const { stdout: txtOut, stderr: txtErr } = runPhantom(['cloud', 'status']);
      const combined = txtOut + txtErr;
      if (combined.trim().length > 0) {
        const parsed = parseCloudStatus(combined);
        loggedIn = parsed.loggedIn;
        user = parsed.user;
        // Tier not available from plain text — stays null.
      }
    }
  }

  // Not logged in — return early without probing team.
  if (!loggedIn) {
    return notLoggedIn;
  }

  // ── 2. Team name (only when logged in) ────────────────────────────────────
  let team: string | null = null;
  {
    const { stdout: jsonOut, error: jsonErr } = runPhantom(['team', 'list', '--json']);
    if (jsonErr === undefined && jsonOut.trim().length > 0) {
      team = parseTeamName(jsonOut);
    }

    // Fallback: plain text team list.
    if (team === null && jsonErr !== undefined) {
      const { stdout: txtOut } = runPhantom(['team', 'list']);
      if (txtOut.trim().length > 0) {
        team = parseTeamName(txtOut);
      }
    }
  }

  return { loggedIn, user, tier, team };
}
