/**
 * M47.1 — signed provenance (H3) tests.
 *
 * HERMETICITY: HOME is overridden to a tmp dir per test so the real
 * ~/.ashlr/foundry/provenance.key is NEVER touched; restored in afterEach.
 *
 * Covers:
 *  - sign → verify roundtrip + key file created at mode 0600;
 *  - tampered diff (stale diffHash/sig) → reject (hash mismatch);
 *  - forged frontier proposal with no/random sig → reject (fail-closed);
 *  - missing diffHash / missing engineModel → reject;
 *  - wrong-length sig → reject without throwing (constant-time path);
 *  - integration: a proposal signed with the real key passes verify.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  provenanceKeyPath,
  loadOrCreateKey,
  hashDiff,
  signProvenance,
  verifyProvenance,
} from '../src/core/foundry/provenance.js';

const origHome = process.env.HOME;
let tmpHome: string;

const MODEL = 'codex:gpt-5.5';
const TIER = 'frontier';
const DIFF = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+hello\n';

/** Build a fully-signed proposal-shaped object using the current real key. */
function signedProposal(diff = DIFF) {
  const diffHash = hashDiff(diff);
  const provenanceSig = signProvenance(MODEL, TIER, diffHash);
  return { engineModel: MODEL, engineTier: TIER, diff, diffHash, provenanceSig };
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m47_1-home-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
});

describe('M47.1 provenance — sign/verify roundtrip', () => {
  it('signs then verifies ok', () => {
    const p = signedProposal();
    const v = verifyProvenance(p);
    expect(v.ok).toBe(true);
  });

  it('creates the key file at ~/.ashlr/foundry/provenance.key with mode 0600', () => {
    const key = loadOrCreateKey();
    expect(key.length).toBe(32);

    const keyPath = provenanceKeyPath();
    expect(keyPath).toBe(path.join(tmpHome, '.ashlr', 'foundry', 'provenance.key'));
    expect(fs.existsSync(keyPath)).toBe(true);

    // 0o600 = owner rw only. Mask to the permission bits.
    const mode = fs.statSync(keyPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('is stable: re-loading returns the same key (signatures persist)', () => {
    const sig1 = signProvenance(MODEL, TIER, hashDiff(DIFF));
    const sig2 = signProvenance(MODEL, TIER, hashDiff(DIFF));
    expect(sig1).toBe(sig2);
  });
});

describe('M47.1 provenance — fail-closed verification', () => {
  it('rejects a tampered diff (one char changed, stale diffHash/sig)', () => {
    const p = signedProposal();
    // Change one character of the diff but keep the OLD diffHash + sig.
    const tampered = { ...p, diff: p.diff.replace('+hello', '+hELLo') };
    const v = verifyProvenance(tampered);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/hash mismatch|tampered/i);
  });

  it('rejects a forged frontier proposal with NO provenanceSig (fail-closed)', () => {
    const diffHash = hashDiff(DIFF);
    const forged = {
      engineModel: MODEL,
      engineTier: TIER,
      diff: DIFF,
      diffHash,
      // provenanceSig deliberately absent
    };
    const v = verifyProvenance(forged);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/provenanceSig/i);
  });

  it('rejects a forged frontier proposal with a RANDOM full-length sig', () => {
    const diffHash = hashDiff(DIFF);
    // A plausible-looking 64-hex-char signature that is NOT a valid HMAC.
    const random = 'a'.repeat(64);
    const forged = { engineModel: MODEL, engineTier: TIER, diff: DIFF, diffHash, provenanceSig: random };
    const v = verifyProvenance(forged);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/signature mismatch/i);
  });

  it('rejects when diffHash is missing', () => {
    const p = signedProposal();
    const { diffHash: _drop, ...noHash } = p;
    void _drop;
    const v = verifyProvenance(noHash);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/diffHash/i);
  });

  it('rejects when engineModel is missing', () => {
    const p = signedProposal();
    const { engineModel: _drop, ...noModel } = p;
    void _drop;
    const v = verifyProvenance(noModel);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/engineModel/i);
  });

  it('rejects when engineTier is missing', () => {
    const p = signedProposal();
    const { engineTier: _drop, ...noTier } = p;
    void _drop;
    const v = verifyProvenance(noTier);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/engineTier/i);
  });

  it('rejects when diff is missing', () => {
    const p = signedProposal();
    const { diff: _drop, ...noDiff } = p;
    void _drop;
    const v = verifyProvenance(noDiff);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/diff/i);
  });

  it('constant-time path: a wrong-LENGTH sig is rejected without throwing', () => {
    const diffHash = hashDiff(DIFF);
    // A short sig (length != 64) exercises the length-mismatch short-circuit
    // in the constant-time compare — must reject, never throw.
    const shortSig = 'deadbeef';
    const forged = { engineModel: MODEL, engineTier: TIER, diff: DIFF, diffHash, provenanceSig: shortSig };
    let v: ReturnType<typeof verifyProvenance>;
    expect(() => {
      v = verifyProvenance(forged);
    }).not.toThrow();
    expect(v!.ok).toBe(false);
    expect(v!.reason).toMatch(/signature mismatch/i);
  });

  it('rejects a tier downgrade attempt (sig was for a different tier)', () => {
    // Signature minted for 'frontier' cannot validate a record claiming a
    // different tier (the tier is part of the signed payload).
    const diffHash = hashDiff(DIFF);
    const sigForFrontier = signProvenance(MODEL, 'frontier', diffHash);
    const swapped = {
      engineModel: MODEL,
      engineTier: 'local',
      diff: DIFF,
      diffHash,
      provenanceSig: sigForFrontier,
    };
    const v = verifyProvenance(swapped);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/signature mismatch/i);
  });
});

describe('M47.1 provenance — integration', () => {
  it('a proposal signed via signProvenance with the real key passes verifyProvenance', () => {
    // Mirrors what sandboxed-engine stamps onto the proposal record.
    const diff = 'diff --git a/docs/a.md b/docs/a.md\n+++ b/docs/a.md\n@@\n+doc\n';
    const diffHash = hashDiff(diff);
    const provenanceSig = signProvenance(MODEL, TIER, diffHash);
    const proposal = { engineModel: MODEL, engineTier: TIER, diff, diffHash, provenanceSig };

    const v = verifyProvenance(proposal);
    expect(v.ok).toBe(true);
    expect(v.reason).toMatch(/valid/i);
  });
});
