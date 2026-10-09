/**
 * M168 compatibility helper for caller-owned environment execution.
 * No vault values are extracted: `phantom env` creates examples and `unwrap`
 * removes wrappers. Supported child proxy execution is owned by engines.ts.
 * With usePhantom enabled, apply the existing successful-result scrubber to
 * requested environment values and clear the private copy after the callback.
 * This does not confine arbitrary callbacks or scrub their logs/errors.
 */

import { execFileSync } from 'node:child_process';
import type { AshlrConfig } from '../types.js';
import { scrubSecrets } from '../util/scrub.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PHANTOM_BIN = 'phantom';
const TIMEOUT_MS = 8_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true when the `phantom` CLI is on PATH.
 * Never throws.
 */
export function phantomAvailable(): boolean {
  try {
    execFileSync(
      process.platform === 'win32' ? 'where' : 'which',
      [PHANTOM_BIN],
      { stdio: 'ignore', timeout: TIMEOUT_MS },
    );
    return true;
  } catch {
    return false;
  }
}

export interface PhantomSecretsOpts {
  /** Off/absent preserves the ordinary unsanitized callback path. */
  cfg: AshlrConfig;
  /** Existing environment key names whose successful output is scrubbed. */
  keys: string[];
  /** Kept for compatibility; this callback helper launches no child. */
  cwd?: string;
}

/**
 * Execute with a private copy of the existing environment; never read a vault.
 * Callback errors propagate unchanged. Callers must not log/return credentials.
 */
export async function withPhantomSecrets<T>(
  opts: PhantomSecretsOpts,
  runFn: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  if (!opts.cfg.foundry?.usePhantom) return runFn({ ...process.env });
  const env: NodeJS.ProcessEnv = { ...process.env };
  const values = opts.keys.map(key => env[key]).filter((value): value is string => typeof value === 'string' && value.length > 0);
  try {
    return scrubResultStrings(await runFn(env), values);
  } finally {
    for (const key of opts.keys) if (env[key] !== undefined) env[key] = '';
    values.length = 0;
  }
}

/**
 * List the NAMES of secrets available in the phantom vault.
 * Returns an empty array when phantom is absent, uninitialized, or the flag
 * is off. NEVER returns secret values — only identifier names.
 */
export function listAvailableSecretKeys(cfg: AshlrConfig): string[] {
  // Flag gate.
  if (!cfg.foundry?.usePhantom) return [];
  if (!phantomAvailable()) return [];

  try {
    const stdout = runPhantomSync(['list', '--json'], undefined);
    if (stdout === null) return [];
    return parseSecretNamesFromJson(stdout);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Run a phantom sub-command synchronously, return stdout or null on error.
 * Never throws — all errors are caught.
 */
function runPhantomSync(args: string[], cwd?: string): string | null {
  try {
    const stdout = execFileSync(PHANTOM_BIN, args, {
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      cwd,
      env: { ...process.env, PHANTOM_NO_UPDATE_CHECK: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return typeof stdout === 'string' ? stdout : null;
  } catch {
    return null;
  }
}

/**
 * Parse secret NAMES from `phantom list --json` output.
 * Returns ONLY names (identifier strings). If parsing fails or the shape is
 * unrecognised, returns []. NEVER returns secret values.
 */
function parseSecretNamesFromJson(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);

    // Array of objects: [{ name: "KEY" }, ...]  or  [{ key: "KEY" }, ...]
    if (Array.isArray(parsed)) {
      const names: string[] = [];
      for (const item of parsed) {
        if (item !== null && typeof item === 'object') {
          const obj = item as Record<string, unknown>;
          if (typeof obj['name'] === 'string') {
            names.push(obj['name']);
          } else if (typeof obj['key'] === 'string') {
            names.push(obj['key']);
          }
          // Deliberately skip any other field (including 'value').
        } else if (typeof item === 'string') {
          names.push(item);
        }
      }
      return names;
    }

    // Object with a "secrets" or "keys" array.
    if (parsed !== null && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      for (const key of ['secrets', 'keys', 'names']) {
        if (Array.isArray(obj[key])) {
          return parseSecretNamesFromJson(JSON.stringify(obj[key]));
        }
      }
    }

    return [];
  } catch {
    // Non-JSON fallback: SCREAMING_SNAKE_CASE identifiers only.
    const ENV_VAR_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
    return raw
      .split('\n')
      .map((l) => l.trim().split(/\s+/)[0] ?? '')
      .filter((t) => t && ENV_VAR_RE.test(t) && t !== 'NAME' && t !== 'KEY');
  }
}

/**
 * Walk a result of type T, replacing any accidental secret-value occurrences
 * in string fields with '[REDACTED]'.
 *
 * Applied to runFn's return value as a last-resort safety net.
 * Handles strings, arrays, and plain objects recursively — does not mutate
 * the input; returns a new value when scrubbing is needed.
 *
 * SECURITY: uses scrubSecrets for all regex-based patterns, then additionally
 * replaces any literal requested environment value strings (the `extras` list).
 */
function scrubResultStrings<T>(value: T, extras: string[]): T {
  if (typeof value === 'string') {
    let scrubbed = scrubSecrets(value);
    for (const extra of extras) {
      if (extra.length >= 8) {
        // Only scrub values that are plausibly secret (≥8 chars).
        scrubbed = scrubbed.split(extra).join('[REDACTED]');
      }
    }
    return scrubbed as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubResultStrings(item, extras)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubResultStrings(v, extras);
    }
    return out as T;
  }
  return value;
}
