/**
 * M65: existing environment credentials for in-process API clients.
 * Secrets 0.7.9 supports a child proxy through `phantom exec`, not unattended
 * plaintext extraction. Parent-process clients cannot inherit that proxy.
 * Resolve on demand without logging/caching, and never send its placeholders.
 */
import type { AshlrConfig } from '../types.js';

function isPhantomPlaceholderToken(value: string | undefined | null): boolean {
  const trimmed = value?.trim();
  return typeof trimmed === 'string' && /^phm_[A-Za-z0-9_-]+$/.test(trimmed);
}

/** @deprecated Automatic vault extraction is unsupported. Kept for compatibility. */
export function revealSecret(_name: string): string | null {
  return null;
}

/** Existing private environment route; does not probe or read the Secrets vault. */
export function resolveProviderKey(envKey: string, _cfg: AshlrConfig): string | undefined {
  if (!envKey) return undefined;
  const fromEnv = process.env[envKey];
  return fromEnv && fromEnv.trim().length > 0 && !isPhantomPlaceholderToken(fromEnv) ? fromEnv : undefined;
}

/** Value-free diagnostics; configured vault support is not execution readiness. */
export function explainProviderKey(envKey: string, cfg: AshlrConfig):
  'environment-supported' | 'environment-missing' | 'placeholder-unusable' | 'vault-transport-not-supported' {
  if (envKey && isPhantomPlaceholderToken(process.env[envKey])) return 'placeholder-unusable';
  if (resolveProviderKey(envKey, cfg)) return 'environment-supported';
  return cfg.phantom?.enabled ? 'vault-transport-not-supported' : 'environment-missing';
}
