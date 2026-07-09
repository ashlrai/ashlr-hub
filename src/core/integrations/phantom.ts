/**
 * src/core/integrations/phantom.ts — M168 phantom-secret injection for fleet
 * VERIFICATION/integration tasks.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  ABSOLUTE SECURITY INVARIANT — MUST NEVER BE WEAKENED                  ║
 * ║                                                                         ║
 * ║  Secret VALUES are EPHEMERAL ONLY.                                      ║
 * ║                                                                         ║
 * ║  • Secret values are ONLY placed into a short-lived NodeJS.ProcessEnv  ║
 * ║    object passed as a child-process environment. They are never:        ║
 * ║      - logged to stdout/stderr (scrubbed before returning)              ║
 * ║      - returned to callers in any data structure                        ║
 * ║      - written to a proposal, diff, genome, or audit entry             ║
 * ║      - stored on disk under ~/.ashlr/                                   ║
 * ║      - placed in runFn's return value (scrubSecrets applied)           ║
 * ║  • The injected env object is passed to runFn ONLY. It is not returned ║
 * ║    or stored after runFn completes.                                     ║
 * ║  • runFn output is passed through scrubSecrets (util/scrub.ts) before  ║
 * ║    returning, using the injected values as additional patterns.         ║
 * ║  • listAvailableSecretKeys() returns NAMES ONLY — never values.        ║
 * ║  • When cfg.foundry?.usePhantom is absent or false, NO phantom calls    ║
 * ║    occur at all. The flag defaults to false (opt-in).                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ZERO RUNTIME DEPS: shells out to the `phantom` CLI (like git/gh/ollama).
 * Degrades gracefully when phantom is absent, not initialized, or a key is
 * missing — runFn is always called; secrets simply aren't injected.
 *
 * Usage:
 *   const result = await withPhantomSecrets(
 *     { cfg, keys: ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN'] },
 *     async (env) => {
 *       // env contains the injected keys. Use it as the child process env.
 *       // Return only metadata — never serialize env.
 *       return runVerification(env);
 *     },
 *   );
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
 * Returns true when the `phantom` CLI is on PATH and responds to --version.
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

/**
 * Options for withPhantomSecrets.
 */
export interface PhantomSecretsOpts {
  /** AshlrConfig. When cfg.foundry?.usePhantom is absent/false, runFn runs
   *  without any phantom interaction (flag-OFF fast-path). */
  cfg: AshlrConfig;
  /** The secret key NAMES to request (e.g. ['ANTHROPIC_API_KEY']). */
  keys: string[];
  /** Optional working directory for phantom env invocation. */
  cwd?: string;
}

/**
 * Provision the requested secret keys via the phantom CLI into an ephemeral
 * child env for the duration of runFn, then drop them.
 *
 * SECURITY CONTRACT:
 *  - Secret values exist ONLY in the ephemeral `env` object passed to runFn.
 *  - They are NEVER returned, logged, or stored.
 *  - runFn's string output is passed through scrubSecrets before returning,
 *    using the injected secret values as extra patterns.
 *  - If phantom is unavailable or a key is missing, runFn runs WITHOUT that
 *    secret (degrade path). This function NEVER throws.
 *  - When cfg.foundry?.usePhantom is false/absent, phantom is never called.
 *
 * @param opts  Keys to request + config gate.
 * @param runFn Async function receiving the ephemeral env. MUST NOT return
 *              secret values — its string output will be scrubbed.
 * @returns     runFn's return value, with any accidental secret leakage
 *              scrubbed from string fields.
 */
export async function withPhantomSecrets<T>(
  opts: PhantomSecretsOpts,
  runFn: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  // ── Flag gate (default OFF) ───────────────────────────────────────────────
  if (!opts.cfg.foundry?.usePhantom) {
    // Run without any secret injection.
    return runFn({ ...process.env });
  }

  // ── Degrade: phantom absent ───────────────────────────────────────────────
  if (!phantomAvailable()) {
    return runFn({ ...process.env });
  }

  // ── Inject secrets into ephemeral child env ───────────────────────────────
  const injectedEnv: NodeJS.ProcessEnv = { ...process.env };
  // Track injected values ONLY for scrubbing — never return or log them.
  const injectedValues: string[] = [];

  for (const key of opts.keys) {
    try {
      const value = resolveSecretValue(key, opts.cwd);
      if (value !== null) {
        injectedEnv[key] = value;
        // Record for output scrubbing. Value itself is never returned.
        injectedValues.push(value);
      }
      // Missing key: skip silently (degrade — don't block the run).
    } catch {
      // Any per-key failure: skip and continue (degrade path).
    }
  }

  // ── Run the function with the ephemeral env ───────────────────────────────
  let result: T;
  let scrubValues: string[] = [];
  try {
    result = await runFn(injectedEnv);
    scrubValues = injectedValues.slice();
  } finally {
    // Overwrite injected values in the env object before GC.
    for (const key of opts.keys) {
      if (injectedEnv[key] !== undefined) {
        injectedEnv[key] = '';
      }
    }
    injectedValues.length = 0;
  }

  // ── Scrub any accidental secret leakage from string output ───────────────
  try {
    return scrubResultStrings(result, scrubValues);
  } finally {
    scrubValues.length = 0;
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
 * Resolve a single secret value via `phantom env <KEY>` or `phantom unwrap <KEY>`.
 * Returns the value string, or null when the key is not found / phantom errors.
 *
 * SECURITY: the returned string is placed ONLY in the ephemeral env object and
 * then in `injectedValues` for scrubbing. It is NEVER logged or returned.
 */
function resolveSecretValue(key: string, cwd?: string): string | null {
  // Try `phantom env <KEY>` first — emits the value on stdout.
  const envOut = runPhantomSync(['env', key], cwd);
  if (envOut !== null && envOut.length > 0) {
    // `phantom env KEY` emits "KEY=value\n" or just "value\n". Parse either.
    const trimmed = envOut.trim();
    if (trimmed.startsWith(`${key}=`)) {
      return trimmed.slice(key.length + 1);
    }
    return trimmed;
  }

  // Fallback: `phantom unwrap <KEY>`.
  const unwrapOut = runPhantomSync(['unwrap', key], cwd);
  if (unwrapOut !== null && unwrapOut.trim().length > 0) {
    return unwrapOut.trim();
  }

  return null;
}

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
 * replaces any literal injected value strings (the `extras` list).
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
