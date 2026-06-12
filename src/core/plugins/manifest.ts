/**
 * core/plugins/manifest.ts — M33 plugin manifest reader + validator.
 *
 * CONTRACT RULES (non-negotiable):
 *  - readManifest NEVER throws; all errors are returned as { ok: false; reason }.
 *  - Bounded read: manifests exceeding 64 KB are rejected.
 *  - Proto-pollution: any object key equal to "__proto__", "constructor", or
 *    "prototype" anywhere in the parsed object rejects the manifest.
 *  - name must match ^[a-z][a-z0-9-]{0,39}$ AND equal basename(dir).
 *  - entry must resolve INSIDE the plugin dir (path-string containment).
 *    The entry file itself may not exist at discovery time — only the path
 *    is validated, not its presence.
 *  - apiVersion is evaluated against PLUGIN_API_VERSION with a hand-rolled
 *    range matcher (exact, ^, ~, x-wildcards). No runtime deps.
 */

import { readFileSync, statSync } from 'node:fs';
import { join, basename, sep, resolve } from 'node:path';
import { PLUGIN_API_VERSION, type PluginManifest, type PluginCapability } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum allowed manifest.json size in bytes (64 KB). */
const MAX_MANIFEST_BYTES = 64 * 1024;

/** Valid plugin name pattern: ^[a-z][a-z0-9-]{0,39}$ */
const NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;

/** Valid PluginCapability values. */
const VALID_CAPABILITIES: ReadonlySet<string> = new Set<PluginCapability>([
  'scanner',
  'template',
  'provider',
  'command',
]);

// ---------------------------------------------------------------------------
// Proto-pollution guard
// ---------------------------------------------------------------------------

/**
 * Recursively scan a parsed JSON value for __proto__, constructor, or
 * prototype keys. Returns true if any such key is found (poison detected).
 * Bounded: objects/arrays in a manifest.json are small; no stack overflow risk
 * in practice, but we cap depth at 8 to be defensive.
 */
function hasPoisonKey(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value !== 'object') return false;

  const keys = Object.keys(value as object);
  for (const key of keys) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return true;
    }
    if (hasPoisonKey((value as Record<string, unknown>)[key], depth + 1)) {
      return true;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value as unknown[]) {
      if (hasPoisonKey(item, depth + 1)) return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Hand-rolled semver range matcher
// ---------------------------------------------------------------------------

/**
 * Parse a semver string "MAJOR.MINOR.PATCH" into a numeric triple.
 * Returns null if the string is not parseable as a 3-part semver.
 */
function parseSemver(s: string): [number, number, number] | null {
  const parts = s.trim().split('.');
  if (parts.length !== 3) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return nums as [number, number, number];
}

/**
 * Evaluate whether `host` (the host's PLUGIN_API_VERSION) satisfies the
 * plugin's `range` declaration.
 *
 * Supported range forms:
 *  - exact:    "1.0.0"   → host must be exactly 1.0.0
 *  - caret:    "^1.0.0"  → host major must match, host >= range version
 *  - tilde:    "~1.0.0"  → host major+minor must match, host >= range version
 *  - wildcard: "1.x"     → host major must match; minor/patch free
 *              "1.0.x"   → host major+minor must match; patch free
 *
 * Returns true iff host satisfies the range.
 * Returns false for any unrecognised range form (strict unknown rejection).
 */
function semverSatisfies(range: string, host: string): boolean {
  const hostParsed = parseSemver(host);
  if (!hostParsed) return false;
  const [hMaj, hMin, hPatch] = hostParsed;

  const r = range.trim();

  // Caret: ^MAJOR.MINOR.PATCH
  if (r.startsWith('^')) {
    const parsed = parseSemver(r.slice(1));
    if (!parsed) return false;
    const [rMaj, rMin, rPatch] = parsed;
    if (hMaj !== rMaj) return false;
    if (hMin < rMin) return false;
    if (hMin === rMin && hPatch < rPatch) return false;
    return true;
  }

  // Tilde: ~MAJOR.MINOR.PATCH
  if (r.startsWith('~')) {
    const parsed = parseSemver(r.slice(1));
    if (!parsed) return false;
    const [rMaj, rMin, rPatch] = parsed;
    if (hMaj !== rMaj || hMin !== rMin) return false;
    if (hPatch < rPatch) return false;
    return true;
  }

  // Wildcard: "1.x" or "1.0.x"
  if (r.includes('x') || r.includes('X') || r.includes('*')) {
    const parts = r.split('.');
    // "1.x" (2 parts with x)
    if (parts.length === 2) {
      const maj = Number(parts[0]);
      if (!Number.isInteger(maj) || maj < 0) return false;
      const minPart = (parts[1] ?? '').trim().toLowerCase();
      if (minPart !== 'x' && minPart !== '*') return false;
      return hMaj === maj;
    }
    // "1.0.x" (3 parts with x in last position)
    if (parts.length === 3) {
      const maj = Number(parts[0]);
      const min = Number(parts[1]);
      const patchPart = (parts[2] ?? '').trim().toLowerCase();
      if (!Number.isInteger(maj) || maj < 0) return false;
      if (!Number.isInteger(min) || min < 0) return false;
      if (patchPart !== 'x' && patchPart !== '*') return false;
      return hMaj === maj && hMin === min;
    }
    return false;
  }

  // Exact: "MAJOR.MINOR.PATCH"
  const parsed = parseSemver(r);
  if (!parsed) return false;
  const [rMaj, rMin, rPatch] = parsed;
  return hMaj === rMaj && hMin === rMin && hPatch === rPatch;
}

// ---------------------------------------------------------------------------
// readManifest — public API
// ---------------------------------------------------------------------------

/**
 * Read and fully validate <dir>/manifest.json.
 *
 * Returns { ok: true; manifest } on success.
 * Returns { ok: false; reason } on any validation failure.
 *
 * NEVER throws — all errors are caught and returned as { ok: false }.
 */
export function readManifest(
  dir: string,
): { ok: true; manifest: PluginManifest } | { ok: false; reason: string } {
  try {
    const manifestPath = join(dir, 'manifest.json');

    // --- Bounded read (≤ 64 KB) ---
    let size: number;
    try {
      const stat = statSync(manifestPath);
      size = stat.size;
    } catch {
      return { ok: false, reason: `manifest.json not found or unreadable in ${dir}` };
    }

    if (size > MAX_MANIFEST_BYTES) {
      return {
        ok: false,
        reason: `manifest.json exceeds 64 KB limit (${size} bytes) in ${dir}`,
      };
    }

    // --- Read + parse ---
    let raw: string;
    try {
      raw = readFileSync(manifestPath, 'utf8');
    } catch {
      return { ok: false, reason: `could not read manifest.json in ${dir}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: `manifest.json is not valid JSON in ${dir}` };
    }

    // --- Proto-pollution guard (before any property access) ---
    if (hasPoisonKey(parsed)) {
      return {
        ok: false,
        reason: `manifest.json contains forbidden key (__proto__/constructor/prototype) in ${dir}`,
      };
    }

    // --- Top-level must be a plain object ---
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: `manifest.json must be a plain object in ${dir}` };
    }

    const obj = parsed as Record<string, unknown>;

    // --- Required string fields ---
    if (typeof obj['name'] !== 'string' || obj['name'].length === 0) {
      return { ok: false, reason: `manifest.json: "name" must be a non-empty string in ${dir}` };
    }
    if (typeof obj['version'] !== 'string' || obj['version'].length === 0) {
      return {
        ok: false,
        reason: `manifest.json: "version" must be a non-empty string in ${dir}`,
      };
    }
    if (typeof obj['apiVersion'] !== 'string' || obj['apiVersion'].length === 0) {
      return {
        ok: false,
        reason: `manifest.json: "apiVersion" must be a non-empty string in ${dir}`,
      };
    }
    if (typeof obj['entry'] !== 'string' || obj['entry'].length === 0) {
      return { ok: false, reason: `manifest.json: "entry" must be a non-empty string in ${dir}` };
    }

    const name = obj['name'] as string;
    const version = obj['version'] as string;
    const apiVersion = obj['apiVersion'] as string;
    const entry = obj['entry'] as string;

    // --- name pattern ---
    if (!NAME_RE.test(name)) {
      return {
        ok: false,
        reason: `manifest.json: name "${name}" does not match ^[a-z][a-z0-9-]{0,39}$ in ${dir}`,
      };
    }

    // --- name === basename(dir) ---
    const dirBase = basename(resolve(dir));
    if (name !== dirBase) {
      return {
        ok: false,
        reason: `manifest.json: name "${name}" must equal directory basename "${dirBase}" in ${dir}`,
      };
    }

    // --- apiVersion semver range compatibility ---
    if (!semverSatisfies(apiVersion, PLUGIN_API_VERSION)) {
      return {
        ok: false,
        reason: `manifest.json: apiVersion range "${apiVersion}" is not satisfied by host version ${PLUGIN_API_VERSION} in ${dir}`,
      };
    }

    // --- capabilities: non-empty array of valid strings ---
    if (!Array.isArray(obj['capabilities']) || (obj['capabilities'] as unknown[]).length === 0) {
      return {
        ok: false,
        reason: `manifest.json: "capabilities" must be a non-empty array in ${dir}`,
      };
    }
    const capabilities = obj['capabilities'] as unknown[];
    for (const cap of capabilities) {
      if (typeof cap !== 'string' || !VALID_CAPABILITIES.has(cap)) {
        return {
          ok: false,
          reason: `manifest.json: invalid capability "${String(cap)}" in ${dir}`,
        };
      }
    }

    // --- entry: relative, no absolute, no ".." traversal ---
    // Entry must not be absolute.
    if (entry.startsWith('/')) {
      return {
        ok: false,
        reason: `manifest.json: entry "${entry}" must be a relative path in ${dir}`,
      };
    }

    // Resolve entry inside dir and verify containment (path-string check).
    const resolvedDir = resolve(dir) + sep;
    const resolvedEntry = resolve(dir, entry);

    // Containment: resolvedEntry must start with resolvedDir (with trailing sep
    // to prevent "prefix" attacks like /plugins/foo-extra matching /plugins/foo/).
    if (!resolvedEntry.startsWith(resolvedDir)) {
      return {
        ok: false,
        reason: `manifest.json: entry "${entry}" resolves outside plugin directory in ${dir}`,
      };
    }

    // --- Optional fields ---
    const description =
      typeof obj['description'] === 'string' ? obj['description'] : undefined;
    const homepage =
      typeof obj['homepage'] === 'string' ? obj['homepage'] : undefined;

    const manifest: PluginManifest = {
      name,
      version,
      apiVersion,
      entry,
      capabilities: capabilities as PluginCapability[],
      ...(description !== undefined ? { description } : {}),
      ...(homepage !== undefined ? { homepage } : {}),
    };

    return { ok: true, manifest };
  } catch {
    // Belt-and-suspenders: readManifest must never throw.
    return { ok: false, reason: `unexpected error reading manifest in ${dir}` };
  }
}
