/**
 * provenance.ts — M47.1: HMAC-signed provenance for inbox proposals (H3).
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ THREAT MODEL — forged frontier merge-authority on a disk record.           ║
 * ║                                                                            ║
 * ║ merge.ts Gate 4 (evaluateMergeAuthority) trusts proposal.engineTier /      ║
 * ║ proposal.engineModel as read from ~/.ashlr/inbox/<id>.json. The agent MCP  ║
 * ║ surface cannot set those fields (they are stamped server-side), but a      ║
 * ║ LOCAL / in-process writer with filesystem access to the inbox COULD forge  ║
 * ║ a record claiming `{engineTier:'frontier', engineModel:'codex:gpt-5.5'}`   ║
 * ║ paired with an arbitrary diff, and slip it past the authority gate.        ║
 * ║                                                                            ║
 * ║ MITIGATION: the sandboxed producer (the ONLY legitimate origin of a        ║
 * ║ frontier proposal) HMAC-signs `${engineModel}|${engineTier}|${diffHash}`   ║
 * ║ with a host-local secret key (~/.ashlr/foundry/provenance.key, mode 0600)  ║
 * ║ and stores the signature + diffHash on the record. The merge gate          ║
 * ║ re-derives the HMAC and FAILS CLOSED on any mismatch. A forger who cannot  ║
 * ║ read the key cannot mint a valid signature; binding the diff hash into the ║
 * ║ MAC also prevents pairing a stolen signature with a swapped diff.          ║
 * ║                                                                            ║
 * ║ RESIDUAL: an attacker who can READ ~/.ashlr/foundry/provenance.key can     ║
 * ║ sign arbitrary records — the key is only as strong as the filesystem       ║
 * ║ permissions protecting it (0600). This raises the bar from "any local      ║
 * ║ writer" to "an attacker who already owns the user's home dir secrets".     ║
 * ║                                                                            ║
 * ║ INVARIANTS: every exported fn NEVER throws (verify catches → fail-closed); ║
 * ║ comparisons are constant-time; node:crypto only.                           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import {
  createHmac,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

/**
 * In-memory ephemeral key used ONLY as a last-resort fallback when the key file
 * can neither be read nor created (e.g. a read-only home). A signature made with
 * this key will not verify against a freshly-loaded persistent key, so the
 * effect is fail-closed at the merge gate — exactly the safe outcome.
 */
let _ephemeralKey: Buffer | null = null;

/**
 * Absolute path to the provenance HMAC key: ~/.ashlr/foundry/provenance.key.
 * Re-resolved at call time so tests can relocate HOME between invocations.
 */
export function provenanceKeyPath(): string {
  return join(homedir(), '.ashlr', 'foundry', 'provenance.key');
}

/**
 * Load the host-local provenance key, creating it on first use.
 *
 * - If the key file exists, read and return its bytes.
 * - Else generate 32 random bytes, `mkdir -p ~/.ashlr/foundry`, and write the
 *   key with mode 0600 via an atomic tmp-write + rename, then return it.
 *
 * NEVER throws. On any I/O failure it falls back to a process-lifetime
 * ephemeral key. That fallback is degenerate by design: signatures made with it
 * will not match a persistent key at verify time, so the merge gate fails
 * closed rather than trusting an unverifiable provenance claim.
 */
export function loadOrCreateKey(): Buffer {
  const keyPath = provenanceKeyPath();
  try {
    if (existsSync(keyPath)) {
      // M107 (P1): refuse to use a key that is group- or world-readable.
      // An attacker who can read the key can forge frontier provenance
      // signatures — the merge gate becomes worthless. 0o077 masks any
      // group-read/write/exec or other-read/write/exec bit.
      const st = statSync(keyPath);
      if ((st.mode & 0o077) !== 0) {
        throw new Error(
          `provenance key at ${keyPath} has unsafe permissions (mode ${'0o' + (st.mode & 0o777).toString(8)}); ` +
          'expected 0600 — run: chmod 600 ' + keyPath,
        );
      }
      const buf = readFileSync(keyPath);
      if (buf.length > 0) return buf;
      // A truncated/empty key file is unusable — regenerate below.
    }
  } catch (err) {
    // Re-throw the permissions error — using a readable key would silently
    // undermine the merge gate. All other I/O errors fall through to create.
    if (err instanceof Error && err.message.startsWith('provenance key at')) throw err;
    // fall through to create / ephemeral
  }

  try {
    const dir = join(homedir(), '.ashlr', 'foundry');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const key = randomBytes(32);
    const tmp = keyPath + '.tmp';
    // mode 0600: owner read/write only — the file holds the signing secret.
    writeFileSync(tmp, key, { mode: 0o600 });
    renameSync(tmp, keyPath);
    return key;
  } catch {
    // Last resort: an ephemeral, process-local key. Persisted records signed
    // with this will NOT verify after a fresh load → fail-closed at merge.
    if (!_ephemeralKey) _ephemeralKey = randomBytes(32);
    return _ephemeralKey;
  }
}

// ---------------------------------------------------------------------------
// Hashing + signing
// ---------------------------------------------------------------------------

/** SHA-256 hex digest of the diff string. Pure; never throws. */
export function hashDiff(diff: string): string {
  return createHash('sha256').update(diff, 'utf8').digest('hex');
}

/**
 * HMAC-SHA256(key, `${engineModel}|${engineTier}|${diffHash}`) as hex.
 * Binds the trust tuple to a concrete diff so a stolen signature cannot be
 * re-paired with a different diff. Never throws.
 */
export function signProvenance(
  engineModel: string,
  engineTier: string,
  diffHash: string,
): string {
  const key = loadOrCreateKey();
  const payload = `${engineModel}|${engineTier}|${diffHash}`;
  return createHmac('sha256', key).update(payload, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Judge attestation — M157: tamper-proof 'ship' verdict binding
// ---------------------------------------------------------------------------

/**
 * HMAC-SHA256 over `${proposalId}|${judgeEngine}|${verdict}|${diffHash}` as hex.
 *
 * Binds the judge identity, the verdict, the proposal id, AND the diff hash into
 * one MAC so that:
 *   - A forged ledger entry without the key cannot mint a valid attestation.
 *   - A stolen attestation cannot be replayed for a different proposalId or diff.
 *   - A stale attestation from a different judging run is rejected if any tuple
 *     member changed.
 *
 * Only called for verdict='ship' from a frontier (claude-*) judge.
 * Never throws.
 */
export function signJudgeAttestation(params: {
  proposalId: string;
  judgeEngine: string;
  verdict: string;
  diffHash: string;
}): string {
  const key = loadOrCreateKey();
  const payload = `${params.proposalId}|${params.judgeEngine}|${params.verdict}|${params.diffHash}`;
  return createHmac('sha256', key).update(payload, 'utf8').digest('hex');
}

export interface JudgeAttestationVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * Verify a judge attestation produced by `signJudgeAttestation`.
 * FAIL-CLOSED — any missing field, HMAC mismatch, or unexpected error → ok:false.
 *
 * Never throws.
 */
export function verifyJudgeAttestation(
  attestation: string | undefined,
  params: {
    proposalId: string;
    judgeEngine: string;
    verdict: string;
    diffHash: string;
  },
): JudgeAttestationVerdict {
  try {
    if (!attestation) {
      return { ok: false, reason: 'missing judge attestation' };
    }
    if (!params.proposalId) {
      return { ok: false, reason: 'missing proposalId' };
    }
    if (!params.judgeEngine) {
      return { ok: false, reason: 'missing judgeEngine' };
    }
    if (!params.verdict) {
      return { ok: false, reason: 'missing verdict' };
    }
    if (!params.diffHash) {
      return { ok: false, reason: 'missing diffHash' };
    }
    const expected = signJudgeAttestation(params);
    if (!constantTimeEqual(expected, attestation)) {
      return { ok: false, reason: 'judge attestation HMAC mismatch — forged or stale attestation' };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `judge attestation verify error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Verification (fail-closed)
// ---------------------------------------------------------------------------

export interface ProvenanceVerdict {
  ok: boolean;
  reason: string;
}

/** Constant-time string compare over equal-length hex; false if lengths differ. */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // timingSafeEqual requires equal-length buffers — a length mismatch is itself
  // a non-match, so short-circuit (without leaking timing on the bytes).
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify a proposal's signed provenance. FAIL-CLOSED in every doubtful case.
 *
 * Rejects when:
 *  - any of engineModel / engineTier / diff / diffHash / provenanceSig is missing;
 *  - hashDiff(diff) !== diffHash (the stored diff was tampered after signing);
 *  - the recomputed HMAC does not equal provenanceSig (constant-time compare;
 *    a length mismatch counts as a non-match).
 *
 * ok:true ONLY when every check passes. NEVER throws (any error → fail-closed).
 */
export function verifyProvenance(p: {
  engineModel?: string;
  engineTier?: string;
  diff?: string;
  diffHash?: string;
  provenanceSig?: string;
}): ProvenanceVerdict {
  try {
    if (!p.engineModel) {
      return { ok: false, reason: 'missing engineModel' };
    }
    if (!p.engineTier) {
      return { ok: false, reason: 'missing engineTier' };
    }
    if (p.diff === undefined || p.diff === null) {
      return { ok: false, reason: 'missing diff' };
    }
    if (!p.diffHash) {
      return { ok: false, reason: 'missing diffHash' };
    }
    if (!p.provenanceSig) {
      return { ok: false, reason: 'missing provenanceSig' };
    }

    // The stored diff must hash to the recorded diffHash — otherwise the diff
    // was swapped after signing (the signature binds the tuple to diffHash, not
    // to the diff bytes directly).
    const recomputedHash = hashDiff(p.diff);
    if (!constantTimeEqual(recomputedHash, p.diffHash)) {
      return { ok: false, reason: 'diff hash mismatch (diff tampered after signing)' };
    }

    const expectedSig = signProvenance(p.engineModel, p.engineTier, p.diffHash);
    if (!constantTimeEqual(expectedSig, p.provenanceSig)) {
      return { ok: false, reason: 'provenance signature mismatch' };
    }

    return { ok: true, reason: 'provenance signature valid' };
  } catch (err) {
    return {
      ok: false,
      reason: `provenance verify error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
