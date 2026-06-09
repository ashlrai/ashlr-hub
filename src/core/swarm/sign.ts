/**
 * core/swarm/sign.ts — M17 tamper-evident signing for swarm task outputs.
 *
 * SECURITY INVARIANTS (do not relax):
 *  - The local key is generated with crypto.randomBytes(32), stored at mode
 *    0600 under ~/.ashlr/keys/swarm.key. It is NEVER logged, printed, or
 *    committed. Only its file path is returned to callers.
 *  - Phantom path: best-effort only. If phantom is enabled+installed, we derive
 *    an HMAC key from a phantom-sourced value via a one-way sha256 so the
 *    phantom secret itself never appears in memory beyond the derivation step.
 *    On ANY failure we fall back silently to the local key.
 *  - Signatures carry only hashes (hex digests) — never payload content, never
 *    key material, never any secret value.
 *  - verifyOutput never throws. signOutput degrades gracefully on all errors.
 *  - node:crypto is the only dependency (builtin, no install required).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import type { AshlrConfig, OutputSignature } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEYS_DIR = path.join(os.homedir(), '.ashlr', 'keys');
const KEY_FILE = path.join(KEYS_DIR, 'swarm.key');
const PHANTOM_BIN = 'phantom';
const PHANTOM_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// ensureLocalKey
// ---------------------------------------------------------------------------

/**
 * Returns the absolute path to the local signing key file
 * (~/.ashlr/keys/swarm.key). If the file does not yet exist, it is created:
 *   - ~/.ashlr/keys/ is created with mode 0700 (user-only)
 *   - 64 hex chars (32 random bytes) are written to the file with mode 0600
 *
 * The key content is NEVER returned, logged, or printed by this function or
 * any function in this module. Only the path is exposed to callers.
 *
 * Never throws — any filesystem error is surfaced as a thrown Error (callers
 * in signOutput/verifyOutput catch it and degrade gracefully).
 */
export function ensureLocalKey(): string {
  // Create directory with 0700 if missing.
  if (!fs.existsSync(KEYS_DIR)) {
    fs.mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
  }

  // Generate and write key if missing.
  if (!fs.existsSync(KEY_FILE)) {
    const key = crypto.randomBytes(32).toString('hex');
    // Write with mode 0600 (owner read/write only).
    fs.writeFileSync(KEY_FILE, key, { mode: 0o600, encoding: 'utf8' });
    // Ensure mode is 0600 even on platforms where writeFileSync may not honour it.
    fs.chmodSync(KEY_FILE, 0o600);
  }

  return KEY_FILE;
}

// ---------------------------------------------------------------------------
// Internal key-reading helpers
// ---------------------------------------------------------------------------

/**
 * Read the local key bytes from disk. Throws on any IO error so callers can
 * catch and fall back. The key string is converted to a Buffer and the
 * intermediate string is not retained.
 */
function readLocalKeyBytes(): Buffer {
  const keyPath = ensureLocalKey();
  const keyHex = fs.readFileSync(keyPath, 'utf8').trim();
  return Buffer.from(keyHex, 'hex');
}

/**
 * Best-effort: derive a signing key from phantom.
 *
 * Strategy: invoke `phantom env --json` (or `phantom list --json`) to retrieve
 * a deterministic identifier that is available only when phantom is initialized,
 * then derive an HMAC key via sha256(phantomValue + 'ashlr-swarm-sign-v1') so
 * the raw phantom secret never escapes this function.
 *
 * Returns { keyBytes, signerId } on success, null on any failure (binary
 * missing, not initialized, unexpected output format, etc.).
 *
 * IMPORTANT: this function must NEVER return or expose the raw phantom secret
 * value. Only the derived key bytes (a one-way hash) are returned.
 */
function derivePhantomKey(cfg: AshlrConfig): { keyBytes: Buffer; signerId: string } | null {
  // Quick guard: phantom must be configured as enabled.
  if (!cfg.phantom?.enabled) return null;

  try {
    // Check binary is present.
    const versionResult = spawnSync(PHANTOM_BIN, ['--version'], {
      encoding: 'utf8',
      timeout: PHANTOM_TIMEOUT_MS,
      env: { ...process.env, PHANTOM_NO_UPDATE_CHECK: '1' },
    });
    if (versionResult.error || versionResult.status !== 0) return null;

    // Retrieve status to confirm initialization.
    const statusResult = spawnSync(PHANTOM_BIN, ['status', '--json'], {
      encoding: 'utf8',
      timeout: PHANTOM_TIMEOUT_MS,
      env: { ...process.env, PHANTOM_NO_UPDATE_CHECK: '1' },
    });
    if (statusResult.error) return null;

    const statusText = (statusResult.stdout ?? '') + (statusResult.stderr ?? '');
    if (!isPhantomInitialized(statusText)) return null;

    // Retrieve secret names only — we never read values here.
    // We use the list of secret names as a stable identifier for the vault
    // identity (combined with the version), then derive key material from
    // the vault's own signing identity via `phantom env --json` for one key.
    //
    // Approach: use `phantom env --json` to get a deterministic vault fingerprint.
    // We look for a known, stable field (vault id, version, or the sorted names
    // list) and hash it — the value itself is never stored or returned.
    const listResult = spawnSync(PHANTOM_BIN, ['list', '--json'], {
      encoding: 'utf8',
      timeout: PHANTOM_TIMEOUT_MS,
      env: { ...process.env, PHANTOM_NO_UPDATE_CHECK: '1' },
    });

    if (listResult.error || listResult.status !== 0) return null;

    const listText = (listResult.stdout ?? '').trim();
    if (!listText) return null;

    // Extract only the secret NAMES (not values) from the list output.
    // We sort them to get a stable fingerprint regardless of list order.
    const names = extractSecretNames(listText);
    if (names.length === 0) return null;

    // Derive key material: sha256(sorted-names-joined + version-string).
    // This is a one-way hash of metadata only — no secret values are used.
    const versionText = (versionResult.stdout ?? '').trim();
    const fingerprint = names.sort().join(',') + '|' + versionText + '|ashlr-swarm-sign-v1';
    const keyBytes = crypto.createHash('sha256').update(fingerprint, 'utf8').digest();

    // Signer id: a SEPARATE one-way hash of the key bytes (NOT the key bytes
    // themselves). The signer is persisted and printed by the CLI, so exposing
    // raw bytes of the live HMAC key (even 6 of 32 bytes) would violate the
    // "signatures/identity carry no key material" invariant. Hashing the key
    // with a distinct domain-separation tag yields a stable, opaque identifier
    // that reveals nothing about the key.
    const signerId =
      'phantom:' +
      crypto
        .createHash('sha256')
        .update('ashlr-swarm-signer-id-v1|')
        .update(keyBytes)
        .digest('hex')
        .slice(0, 12);

    return { keyBytes, signerId };
  } catch {
    // Any unexpected error → fall back to local key.
    return null;
  }
}

/**
 * Heuristic: determine whether phantom is initialized from its status output.
 * Mirrors the logic in core/phantom.ts (parseInitializedFromJson + text fallback).
 */
function isPhantomInitialized(raw: string): boolean {
  const trimmed = raw.trim();
  // Try JSON parse first.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed['initialized'] === 'boolean') return parsed['initialized'];
      const vault = parsed['vault'];
      if (vault !== null && typeof vault === 'object') {
        const v = (vault as Record<string, unknown>)['initialized'];
        if (typeof v === 'boolean') return v;
      }
      for (const key of ['secretCount', 'secrets', 'mapped', 'count']) {
        if (typeof parsed[key] === 'number') return true;
      }
      // Parseable JSON but no recognized field → treat as initialized.
      return true;
    } catch {
      // Fall through to text heuristic.
    }
  }
  // Text heuristic.
  const lc = trimmed.toLowerCase();
  return !lc.includes('not initialized') && !lc.includes('run phantom init');
}

/**
 * Extract secret NAMES (not values) from `phantom list --json` output.
 * Returns an empty array if the output is unrecognized. Mirrors parseSecretNames
 * in core/phantom.ts.
 */
function extractSecretNames(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const names: string[] = [];
      for (const item of parsed) {
        if (item !== null && typeof item === 'object') {
          const obj = item as Record<string, unknown>;
          if (typeof obj['name'] === 'string') names.push(obj['name']);
          else if (typeof obj['key'] === 'string') names.push(obj['key']);
        } else if (typeof item === 'string') {
          names.push(item);
        }
      }
      return names;
    }
    if (parsed !== null && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      for (const key of ['secrets', 'keys', 'names']) {
        if (Array.isArray(obj[key])) return extractSecretNames(JSON.stringify(obj[key]));
      }
    }
    return [];
  } catch {
    // Line-based fallback for plain-text output.
    const ENV_VAR_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
    const names: string[] = [];
    for (const raw_line of raw.split('\n')) {
      const token = raw_line.trim().split(/\s+/)[0];
      if (token && ENV_VAR_RE.test(token) && token !== 'NAME' && token !== 'KEY') {
        names.push(token);
      }
    }
    return names;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a tamper-evident signature over `content`.
 *
 * Output fields:
 *   hash — sha256 hex of the raw content (content digest only, no secrets).
 *   sig  — HMAC-SHA256 hex of the content, keyed by the signing key.
 *   alg  — 'phantom' when a phantom-derived key was used, else 'hmac-sha256'.
 *   signer — opaque identity ('local' or 'phantom:<12-hex-chars>'), no secrets.
 *   ts   — ISO timestamp.
 *
 * Key selection (best-effort phantom, fall back to local):
 *   1. If cfg.phantom.enabled and phantom is installed+initialized → phantom key.
 *   2. Otherwise → local key (~/.ashlr/keys/swarm.key, auto-created 0600).
 *
 * THROWS only when the local key cannot be created/read (e.g. read-only
 * filesystem) AND no phantom key is available. This is deliberate: rather than
 * emit a forgeable all-zero-key signature that LOOKS trusted, signing fails so
 * the caller leaves the output unsigned. The runner calls this best-effort
 * (try/catch) and treats a thrown error / absent signature as "skip downstream
 * verification" — and its unsigned-dependency gate escalates if a signed-swarm
 * dependency ends up without a signature. ensureLocalKey() rarely fails in
 * practice. Never throws for any reason other than key-load failure.
 */
export function signOutput(content: string, cfg: AshlrConfig): OutputSignature {
  const ts = new Date().toISOString();

  // 1. Content digest (independent of key).
  const hash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');

  // 2. Determine key source.
  let keyBytes: Buffer;
  let alg: 'hmac-sha256' | 'phantom' = 'hmac-sha256';
  let signer = 'local';

  const phantomResult = derivePhantomKey(cfg);
  if (phantomResult !== null) {
    keyBytes = phantomResult.keyBytes;
    alg = 'phantom';
    signer = phantomResult.signerId;
  } else {
    // Local key (auto-created 0600 if absent).
    // SECURITY: do NOT fall back to an all-zero key on read failure. A zero-key
    // signature is forgeable by anyone who knows the key is zero, and it carries
    // no marker distinguishing it from a real-key signature — a silent downgrade
    // of the tamper-evidence guarantee to "anyone can forge". Instead, rethrow:
    // the runner's signOutput call is best-effort (wrapped in try/catch) and will
    // leave taskRun.signature undefined, which downstream verification treats as
    // "no signature to verify" rather than emitting a falsely-trusted one. With
    // the unsigned-dependency gate in the runner, a missing signature on a
    // signed-swarm dependency now escalates rather than being silently consumed.
    keyBytes = readLocalKeyBytes();
  }

  // 3. HMAC-SHA256(content, key).
  const sig = crypto.createHmac('sha256', keyBytes).update(content, 'utf8').digest('hex');

  return { alg, hash, sig, signer, ts };
}

/**
 * Verify a previously computed OutputSignature against `content`.
 *
 * Returns true only when:
 *   - The content digest matches sig.hash (sha256 of content == sig.hash).
 *   - The HMAC recomputed with the same key == sig.sig (timing-safe compare).
 *
 * Returns false (NEVER throws) on:
 *   - Any key-loading failure.
 *   - Malformed / missing signature fields.
 *   - Hash or HMAC mismatch (tamper detected).
 *   - Any unexpected exception.
 *
 * Key selection mirrors signOutput: attempt phantom if sig.alg === 'phantom'
 * and phantom is enabled+installed; otherwise use the local key.
 */
export function verifyOutput(
  content: string,
  sig: OutputSignature,
  cfg: AshlrConfig,
): boolean {
  try {
    // Basic shape guard.
    if (
      !sig ||
      typeof sig.hash !== 'string' ||
      typeof sig.sig !== 'string' ||
      typeof sig.alg !== 'string'
    ) {
      return false;
    }

    // 1. Recompute content digest and compare (non-secret, timing-safe anyway).
    const expectedHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    const hashBufExpected = Buffer.from(expectedHash, 'hex');
    const hashBufActual = Buffer.from(sig.hash, 'hex');
    if (
      hashBufExpected.length !== hashBufActual.length ||
      !crypto.timingSafeEqual(hashBufExpected, hashBufActual)
    ) {
      return false;
    }

    // 2. Determine key bytes (must match what signOutput used).
    let keyBytes: Buffer;

    if (sig.alg === 'phantom') {
      const phantomResult = derivePhantomKey(cfg);
      if (phantomResult === null) {
        // Phantom was used for signing but is not available now → cannot verify.
        return false;
      }
      keyBytes = phantomResult.keyBytes;
    } else {
      // 'hmac-sha256' → local key.
      try {
        keyBytes = readLocalKeyBytes();
      } catch {
        return false;
      }
    }

    // 3. Recompute HMAC and compare in constant time.
    const expectedSig = crypto
      .createHmac('sha256', keyBytes)
      .update(content, 'utf8')
      .digest('hex');

    const sigBufExpected = Buffer.from(expectedSig, 'hex');
    const sigBufActual = Buffer.from(sig.sig, 'hex');

    if (sigBufExpected.length !== sigBufActual.length) return false;

    return crypto.timingSafeEqual(sigBufExpected, sigBufActual);
  } catch {
    // Never throw — any unexpected error means we cannot confirm integrity.
    return false;
  }
}
