/**
 * core/swarm/sign.ts — M17 tamper-evident signing for swarm task outputs.
 *
 * SECURITY INVARIANTS (do not relax):
 *  - The local key is generated with crypto.randomBytes(32), stored at mode
 *    0600 under ~/.ashlr/keys/swarm.key. It is NEVER logged, printed, or
 *    committed. Only its file path is returned to callers.
 *  - Phantom path: reserved for a future Phantom-held signing primitive only.
 *    Metadata such as secret names, versions, or vault status is NOT key
 *    material and must never be labelled as a Phantom-backed signature.
 *  - Signatures carry only hashes (hex digests) — never payload content, never
 *    key material, never any secret value.
 *  - verifyOutput never throws. signOutput degrades gracefully on all errors.
 *  - node:crypto is the only dependency (builtin, no install required).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AshlrConfig, OutputSignature } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEYS_DIR = path.join(os.homedir(), '.ashlr', 'keys');
const KEY_FILE = path.join(KEYS_DIR, 'swarm.key');

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
 * Reserved Phantom signing hook.
 *
 * Deliberately returns null until Phantom exposes a dedicated signing/HMAC
 * primitive that keeps secret material inside Phantom. Older code derived a
 * key from metadata such as secret names and version text, then labelled the
 * result `alg:"phantom"`. That overstated the trust boundary: metadata is not
 * secret-backed signing material.
 *
 * Future implementation rule: do not use `phantom reveal`, `phantom list`,
 * secret names, vault status, or version strings to mint signing keys here.
 */
function derivePhantomKey(_cfg: AshlrConfig): { keyBytes: Buffer; signerId: string } | null {
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a tamper-evident signature over `content`.
 *
 * Output fields:
 *   hash — sha256 hex of the raw content (content digest only, no secrets).
 *   sig  — HMAC-SHA256 hex of the content, keyed by the local signing key.
 *   alg  — currently always 'hmac-sha256'. 'phantom' is reserved for a future
 *          Phantom-held signing primitive and legacy records fail closed.
 *   signer — opaque identity ('local'), no secrets.
 *   ts   — ISO timestamp.
 *
 * Key selection:
 *   1. Phantom signing is not emitted until Phantom provides a real signer.
 *   2. Local key (~/.ashlr/keys/swarm.key, auto-created 0600).
 *
 * THROWS only when the local key cannot be created/read (e.g. read-only
 * filesystem). This is deliberate: rather than
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
 * Key selection mirrors signOutput. Legacy/future `alg:"phantom"` signatures
 * are fail-closed until a real Phantom-held signing primitive exists.
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
