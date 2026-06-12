/**
 * core/plugins/integrity.ts — M33 plugin entry-file integrity check.
 *
 * CONTRACT RULES (non-negotiable):
 *  - hashEntry NEVER throws; returns null on any read failure.
 *  - verifyIntegrity NEVER throws; returns { ok: false } on missing pin,
 *    read failure, or hash mismatch.
 *  - Hashes are sha256 hex prefixed "sha256:".
 *  - recordIntegrity is NOT here — config writes are CLI responsibility.
 *  - Only the entry file is hashed (not the whole plugin directory).
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { AshlrConfig } from '../types.js';

// ---------------------------------------------------------------------------
// hashEntry — compute sha256 of an entry file
// ---------------------------------------------------------------------------

/**
 * Compute the sha256 hash of the file at `entryPath`.
 * Returns the hash as a string prefixed "sha256:<hex>".
 * Returns null if the file cannot be read (absent, permission denied, etc.).
 *
 * NEVER throws.
 */
export function hashEntry(entryPath: string): string | null {
  try {
    const bytes = readFileSync(entryPath);
    const hex = createHash('sha256').update(bytes).digest('hex');
    return `sha256:${hex}`;
  } catch {
    // File not found, permission denied, or other I/O error — return null.
    return null;
  }
}

// ---------------------------------------------------------------------------
// verifyIntegrity — compare live hash against pinned hash in cfg
// ---------------------------------------------------------------------------

/**
 * Verify that the live hash of `entryPath` matches the hash pinned in
 * cfg.plugins?.integrity[name].
 *
 * Returns { ok: true } when the hashes match.
 * Returns { ok: false; reason } when:
 *  - No pin is recorded for this plugin (cfg.plugins?.integrity[name] absent).
 *  - The entry file cannot be read (hashEntry returns null).
 *  - The live hash does not match the pinned hash.
 *
 * NEVER throws.
 */
export function verifyIntegrity(
  cfg: AshlrConfig,
  name: string,
  entryPath: string,
): { ok: boolean; reason?: string } {
  try {
    const pinnedHash = cfg.plugins?.integrity?.[name];

    if (!pinnedHash) {
      return { ok: false, reason: `no integrity pin recorded for plugin "${name}"` };
    }

    const liveHash = hashEntry(entryPath);
    if (liveHash === null) {
      return { ok: false, reason: `could not read entry file for plugin "${name}": ${entryPath}` };
    }

    if (liveHash !== pinnedHash) {
      return {
        ok: false,
        reason: `integrity mismatch for plugin "${name}": pinned ${pinnedHash}, got ${liveHash}`,
      };
    }

    return { ok: true };
  } catch {
    // Belt-and-suspenders: verifyIntegrity must never throw.
    return { ok: false, reason: `unexpected error verifying integrity for plugin "${name}"` };
  }
}
