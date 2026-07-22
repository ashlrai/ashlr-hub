/**
 * integrations/secrets.ts — M65: phantom-vault credential resolution for the
 * IN-PROCESS api-model backends (NVIDIA NIMs, Kimi/Moonshot, Hermes-API, …).
 *
 * WHY THIS IS SEPARATE FROM core/phantom.ts: that module is INTENTIONALLY
 * values-free (it only ever inspects names/metadata). This module is the single,
 * deliberate place where a real secret VALUE is pulled into the ashlr process —
 * and only for an in-process network call that genuinely needs it.
 *
 * THE PHANTOM MODEL: `phantom init` rewrites .env real secrets into worthless
 * phantom TOKENS; a local proxy swaps the real value in at the network layer for
 * subprocesses run under `phantom exec` (that's how the CLI-agent backends stay
 * leak-free — engines.ts phantomWrap). But an api-model backend makes its fetch
 * IN-PROCESS, so a plain `process.env[KEY]` read would hand the API a worthless
 * token. When phantom manages the key we therefore `phantom reveal` the real
 * value for that one call. CLI-agent backends remain exec-proxied and never see
 * a real key; this in-process reveal is the documented, narrow exception.
 *
 * SAFETY: never throws; never logs the value; resolves on demand (no caching, so
 * a rotated secret is always current and the value isn't held longer than needed).
 */

import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { AshlrConfig } from '../types.js';
import { phantomInstalled } from '../phantom.js';

const PHANTOM_BIN = 'phantom';
const TIMEOUT_MS = 5_000;

function isPhantomPlaceholderToken(value: string | undefined | null): boolean {
  const trimmed = value?.trim();
  return typeof trimmed === 'string' && trimmed.startsWith('phm_');
}

function usableSecret(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && !isPhantomPlaceholderToken(trimmed) ? value ?? undefined : undefined;
}

/**
 * Reveal a phantom-vault secret value for in-process use. Returns null when
 * phantom can't provide it (not installed, name not in the vault, non-zero exit,
 * empty). Uses `-y` (skip confirmation) + `--quiet` for non-interactive use.
 * Never throws; never logs the value.
 */
export function revealSecret(name: string, options: { cwd?: string } = {}): string | null {
  try {
    const res = spawnSync(PHANTOM_BIN, ['reveal', name, '--yes', '--quiet'], {
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, PHANTOM_NO_UPDATE_CHECK: '1' },
    });
    if (res.status !== 0 || res.error) return null;
    const value = (res.stdout ?? '').trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Resolve an in-process credential by env-var name. When phantom is ENABLED and
 * installed, prefer the phantom-vault value (because `phantom init` rewrites the
 * env to a worthless token — a raw env read would send that token to the API).
 * A caller-supplied legacy config value takes precedence over the environment
 * only after Phantom is unavailable. Placeholder tokens are never returned.
 */
export function resolveProviderKey(
  envKey: string,
  cfg: AshlrConfig,
  options: { configuredValue?: string } = {},
): string | undefined {
  if (!envKey) return undefined;
  const configuredProjectDir = cfg.phantom?.projectDir?.trim();
  const phantomCwd = configuredProjectDir
    ? isAbsolute(configuredProjectDir) ? configuredProjectDir : null
    : undefined;
  if (cfg.phantom?.enabled && phantomCwd !== null && phantomInstalled({ cwd: phantomCwd })) {
    const fromVault = usableSecret(revealSecret(envKey, { cwd: phantomCwd }));
    if (fromVault) return fromVault;
  }
  return usableSecret(options.configuredValue) ?? usableSecret(process.env[envKey]);
}
