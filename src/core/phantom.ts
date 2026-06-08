/**
 * core/phantom.ts — Phantom secrets CLI integration.
 *
 * INTENTIONALLY VALUES-FREE: this module inspects only the Phantom CLI's
 * metadata (version, initialization state, secret NAMES).  It never reads,
 * captures, logs, or returns secret values under any code path.
 */

import { spawnSync } from 'node:child_process';
import type { PhantomStatus } from './types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const PHANTOM_BIN = 'phantom';
const TIMEOUT_MS = 5_000;

/**
 * Run a phantom sub-command synchronously.
 * Returns stdout/stderr as strings and the exit status.
 * Never throws — all errors are caught and returned in `error`.
 */
function runPhantom(
  args: string[],
  options: { cwd?: string } = {},
): { stdout: string; stderr: string; status: number | null; error?: string } {
  try {
    const result = spawnSync(PHANTOM_BIN, args, {
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      cwd: options.cwd,
      // Do NOT inherit env vars that could trigger interactive prompts.
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
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true when the `phantom` binary is resolvable and executes without a
 * fatal error.  Uses `phantom --version` as the probe (fast, side-effect-free).
 */
export function phantomInstalled(): boolean {
  const { status, error } = runPhantom(['--version']);
  // spawnSync returns null status when the binary could not be found/launched.
  return error === undefined && status !== null && status === 0;
}

/**
 * Returns a read-only status snapshot of the Phantom CLI.
 *
 * Guarantees:
 *  - Never throws.
 *  - Never returns secret values — only secret NAMES (keys).
 *  - Degrades gracefully when phantom is absent, uninitialized, or returns
 *    an unexpected format.
 */
export function getPhantomStatus(): PhantomStatus {
  // ── 1. Binary presence ──────────────────────────────────────────────────
  if (!phantomInstalled()) {
    return {
      installed: false,
      version: null,
      initialized: false,
      secretNames: [],
    };
  }

  // ── 2. Version ──────────────────────────────────────────────────────────
  let version: string | null = null;
  {
    const { stdout, status } = runPhantom(['--version']);
    if (status === 0) {
      // Expected format: "phantom 0.6.0"
      const match = stdout.trim().match(/\d+\.\d+(?:\.\d+)?/);
      version = match ? match[0] : stdout.trim() || null;
    }
  }

  // ── 3. Initialized state (phantom status --json) ─────────────────────────
  //
  // Prefer the documented `--json` flag and read a structured initialized /
  // secret-count field when present (robust against wording/localization
  // changes). Fall back to the legacy human-text heuristic only when the
  // output is not parseable JSON.
  //
  // Human-text fallback: when NOT initialized, phantom prints something like
  //   "! Not initialized. Run phantom init to get started."
  // When initialized it prints proxy state and a mapped-secrets count. We treat
  // the presence of "not initialized" / "run phantom init" as initialized:false.
  //
  // statusError is reserved for GENUINE spawn failures (binary missing /
  // crashed). A non-zero exit whose output is parseable (e.g. proxy stopped)
  // is NOT a fault and records no error.
  let initialized = false;
  let statusError: string | undefined;
  {
    const { stdout, stderr, status, error } = runPhantom(['status', '--json']);
    if (error !== undefined) {
      // Genuine spawn failure (could not launch the binary).
      statusError = error;
    } else {
      const combined = stdout + stderr;
      const structured = parseInitializedFromJson(combined);
      if (structured !== null) {
        initialized = structured;
      } else {
        // Fallback: human-text heuristic (labeled, brittle-by-design).
        const lc = combined.toLowerCase();
        initialized = !lc.includes('not initialized') && !lc.includes('run phantom init');
      }
      // A stopped proxy / non-zero exit is benign once we have parseable
      // output; do not surface it as a hard error. statusError stays unset.
      void status;
    }
  }

  // ── 4. Secret NAMES (phantom list --json) ───────────────────────────────
  //
  // Only attempt when initialized; avoids spurious error output.
  // We use --json for deterministic parsing.  Expected shape (when secrets
  // exist) is an array of objects each containing at minimum a "name" or
  // "key" field.  If the shape is unrecognised we return [] rather than
  // risk accidentally surfacing values.
  let secretNames: string[] = [];
  if (initialized) {
    const { stdout, status, error } = runPhantom(['list', '--json']);
    if (error === undefined && status === 0 && stdout.trim().length > 0) {
      secretNames = parseSecretNames(stdout);
    }
  }

  const result: PhantomStatus = {
    installed: true,
    version,
    initialized,
    secretNames,
  };

  if (statusError !== undefined) {
    result.error = statusError;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Private parsing — deliberately conservative
// ---------------------------------------------------------------------------

/**
 * Read the initialized state from `phantom status --json` output.
 *
 * Returns:
 *   - true / false when a structured boolean field can be determined
 *   - null when the output is not parseable JSON (caller should fall back to
 *     the human-text heuristic)
 *
 * Recognised shapes (defensive — phantom's exact schema may evolve):
 *   { "initialized": true, ... }
 *   { "vault": { "initialized": true }, ... }
 *   { "secrets": 3, ... }  / { "secretCount": 3 } → initialized when count >= 0
 * Never reads or returns secret values — only boolean/count metadata.
 */
function parseInitializedFromJson(raw: string): boolean | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  // Direct boolean field
  if (typeof obj['initialized'] === 'boolean') return obj['initialized'];

  // Nested vault.initialized
  const vault = obj['vault'];
  if (vault !== null && typeof vault === 'object') {
    const v = (vault as Record<string, unknown>)['initialized'];
    if (typeof v === 'boolean') return v;
  }

  // A numeric secret count implies an initialized vault.
  for (const key of ['secretCount', 'secrets', 'mapped', 'count']) {
    if (typeof obj[key] === 'number') return true;
  }

  // Parseable JSON but no recognised field — treat as initialized (a vault
  // that emits structured status is, by definition, set up).
  return true;
}

/**
 * Extract ONLY secret names from `phantom list --json` output.
 *
 * The function intentionally returns an empty array whenever it cannot
 * confidently identify a "name" field, preventing accidental value leakage
 * if the JSON schema changes.
 *
 * NEVER include or return values, tokens, or any field that is not the
 * human-readable key name.
 */
function parseSecretNames(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);

    // ── Array of objects: [{ name: "KEY" }, ...]  or  [{ key: "KEY" }, ...]
    if (Array.isArray(parsed)) {
      const names: string[] = [];
      for (const item of parsed) {
        if (item !== null && typeof item === 'object') {
          const obj = item as Record<string, unknown>;
          // Prefer "name", fall back to "key" — both are safe identifier fields.
          if (typeof obj['name'] === 'string') {
            names.push(obj['name']);
          } else if (typeof obj['key'] === 'string') {
            names.push(obj['key']);
          }
          // Deliberately skip any other field to avoid leaking values.
        } else if (typeof item === 'string') {
          // Some CLIs emit a flat string array of names.
          names.push(item);
        }
      }
      return names;
    }

    // ── Object with a "secrets" or "keys" array at the top level
    if (parsed !== null && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      for (const key of ['secrets', 'keys', 'names']) {
        if (Array.isArray(obj[key])) {
          return parseSecretNames(JSON.stringify(obj[key]));
        }
      }
    }

    // Unknown shape — return empty rather than risk leaking values.
    return [];
  } catch {
    // JSON parse failed — fall back to line-based extraction.
    return parseSecretNamesFromText(raw);
  }
}

/**
 * Last-resort line-by-line name extractor for plain-text `phantom list` output.
 *
 * Phantom's table format typically looks like:
 *   NAME            PROTECTED
 *   MY_API_KEY      yes
 *   ANOTHER_SECRET  yes
 *
 * We extract the first whitespace-delimited token from each non-header line
 * that looks like an environment-variable name (ALL_CAPS / SCREAMING_SNAKE).
 *
 * Deliberately conservative — returns [] for any line that doesn't look like
 * a canonical env-var name.
 */
function parseSecretNamesFromText(text: string): string[] {
  const ENV_VAR_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
  const names: string[] = [];

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const token = line.split(/\s+/)[0];
    // Skip header lines ("NAME", "KEY", etc.) implicitly — they pass the
    // same regex but are single-word and won't look like multi-word values.
    if (token && ENV_VAR_RE.test(token) && token !== 'NAME' && token !== 'KEY') {
      names.push(token);
    }
  }

  return names;
}
