/**
 * core/phantom.ts — Phantom secrets CLI integration.
 *
 * INTENTIONALLY VALUES-FREE: this module inspects only the Phantom CLI's
 * metadata (version, initialization state, secret NAMES).  It never reads,
 * captures, logs, or returns secret values under any code path.
 */

import { spawnSync } from 'node:child_process';
import type { PhantomCapabilitySnapshot, PhantomStatus } from './types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const PHANTOM_BIN = 'phantom';
const TIMEOUT_MS = 5_000;
const FLEET_TIMEOUT_MS = 500;
const FLEET_CACHE_TTL_MS = 30_000;

export const PHANTOM_KNOWN_FLEET_SECRET_NAMES = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GITHUB_TOKEN',
  'ASHLR_PULSE_PAT',
  'ASHLR_PULSE_TOKEN',
  'NVIDIA_NIM_API_KEY',
] as const;

/**
 * Run a phantom sub-command synchronously.
 * Returns stdout/stderr as strings and the exit status.
 * Never throws — all errors are caught and returned in `error`.
 */
function runPhantom(
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): { stdout: string; stderr: string; status: number | null; error?: string } {
  try {
    const result = spawnSync(PHANTOM_BIN, args, {
      encoding: 'utf8',
      timeout: options.timeoutMs ?? TIMEOUT_MS,
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

let cachedFleetStatus: { key: string; expiresAt: number; status: PhantomStatus } | null = null;

function phantomCacheKey(): string {
  return JSON.stringify({
    home: process.env.HOME ?? '',
    userProfile: process.env.USERPROFILE ?? '',
    path: process.env.PATH ?? '',
  });
}

/**
 * Returns true when the `phantom` binary is resolvable and executes without a
 * fatal error.  Uses `phantom --version` as the probe (fast, side-effect-free).
 */
export function phantomInstalled(options: { timeoutMs?: number } = {}): boolean {
  const { status, error } = runPhantom(['--version'], options);
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
export function getPhantomStatus(options: { timeoutMs?: number } = {}): PhantomStatus {
  const timeoutMs = options.timeoutMs;
  // ── 1. Binary presence ──────────────────────────────────────────────────
  if (!phantomInstalled({ timeoutMs })) {
    return {
      installed: false,
      version: null,
      initialized: false,
      secretNames: [],
      capability: buildPhantomCapabilitySnapshot({
        installed: false,
        initialized: false,
        secretNames: [],
      }),
    };
  }

  // ── 2. Version ──────────────────────────────────────────────────────────
  let version: string | null = null;
  {
    const { stdout, status } = runPhantom(['--version'], { timeoutMs });
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
    const { stdout, stderr, status, error } = runPhantom(['status', '--json'], { timeoutMs });
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
    const { stdout, status, error } = runPhantom(['list', '--json'], { timeoutMs });
    if (error === undefined && status === 0 && stdout.trim().length > 0) {
      secretNames = parseSecretNames(stdout);
    }
  }

  const base = {
    installed: true,
    version,
    initialized,
    secretNames,
  };

  const result: PhantomStatus = {
    ...base,
    capability: buildPhantomCapabilitySnapshot(base),
  };

  if (statusError !== undefined) {
    result.error = statusError;
  }

  return result;
}

export function getCachedFleetPhantomStatus(options: {
  ttlMs?: number;
  timeoutMs?: number;
  nowMs?: number;
} = {}): PhantomStatus {
  const nowMs = options.nowMs ?? Date.now();
  const key = phantomCacheKey();
  if (cachedFleetStatus && cachedFleetStatus.key === key && cachedFleetStatus.expiresAt > nowMs) {
    return cachedFleetStatus.status;
  }
  const status = getPhantomStatus({ timeoutMs: options.timeoutMs ?? FLEET_TIMEOUT_MS });
  cachedFleetStatus = {
    key,
    expiresAt: nowMs + (options.ttlMs ?? FLEET_CACHE_TTL_MS),
    status,
  };
  return status;
}

export function resetPhantomStatusCache(): void {
  cachedFleetStatus = null;
}

export function buildPhantomCapabilitySnapshot(
  status: Pick<PhantomStatus, 'installed' | 'initialized' | 'secretNames'>,
): PhantomCapabilitySnapshot {
  const safeNames = [...new Set(status.secretNames.filter(isSafeSecretName))].sort();
  const known = [...PHANTOM_KNOWN_FLEET_SECRET_NAMES];
  const present = known.filter((name) => safeNames.includes(name));
  const missing = known.filter((name) => !safeNames.includes(name));
  return {
    valueMode: 'metadata-and-names-only',
    secretCount: safeNames.length,
    knownFleetSecrets: {
      names: known,
      present,
      missing,
      pulsePatPresent: present.includes('ASHLR_PULSE_PAT'),
      pulseTokenPresent: present.includes('ASHLR_PULSE_TOKEN'),
      pulseCredentialPresent: present.includes('ASHLR_PULSE_PAT') || present.includes('ASHLR_PULSE_TOKEN'),
    },
    modes: {
      metadataStatus: true,
      childEnvInjectionAvailable: status.installed && status.initialized,
      mcpServerAvailable: status.installed,
      mutationRequiresHumanApproval: status.installed,
    },
  };
}

// ---------------------------------------------------------------------------
// Private parsing — deliberately conservative
// ---------------------------------------------------------------------------

/**
 * Read the initialized state from `phantom status --json` output.
 *
 * Returns:
 *   - true / false when a structured boolean field can be determined
 *   - null when the output is not JSON (caller should fall back to the
 *     human-text heuristic)
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
  if (Array.isArray(parsed)) return false;
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

  for (const key of ['error', 'message', 'status', 'detail']) {
    const value = obj[key];
    if (typeof value !== 'string') continue;
    const lc = value.toLowerCase();
    if (lc.includes('not initialized') || lc.includes('run phantom init')) return false;
    if (lc === 'initialized' || lc === 'ready') return true;
  }

  // Unknown structured output is not enough proof of initialization.
  return false;
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
          const name = typeof obj['name'] === 'string'
            ? obj['name']
            : typeof obj['key'] === 'string'
              ? obj['key']
              : undefined;
          if (name && isSafeSecretName(name)) {
            names.push(name.trim());
          }
          // Deliberately skip any other field to avoid leaking values.
        } else if (typeof item === 'string') {
          // Some CLIs emit a flat string array of names.
          if (isSafeSecretName(item)) names.push(item.trim());
        }
      }
      return [...new Set(names)].sort();
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

function isSafeSecretName(value: string): boolean {
  const name = value.trim();
  if (!name || name.length > 120) return false;
  if (!/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(name)) return false;
  if (/\s|=/.test(name)) return false;
  if (/^sk-[A-Za-z0-9_-]{8,}/.test(name)) return false;
  if (/^gh[poursa]_[A-Za-z0-9]{8,}/.test(name)) return false;
  if (/^xox[baprs]-[A-Za-z0-9-]{8,}/i.test(name)) return false;
  if (/^Bearer\s+/i.test(name)) return false;
  if (/^AKIA[0-9A-Z]{16}$/.test(name)) return false;
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(name)) return false;
  return true;
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
    if (token && ENV_VAR_RE.test(token) && token !== 'NAME' && token !== 'KEY' && isSafeSecretName(token)) {
      names.push(token);
    }
  }

  return [...new Set(names)].sort();
}
