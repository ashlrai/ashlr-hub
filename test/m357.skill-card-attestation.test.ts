/**
 * M357 - domain-separated HMAC attestations for immutable skill-card payloads.
 *
 * HOME is isolated per test so the real provenance key is never read or
 * modified.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  hashDiff,
  provenanceKeyPath,
  signJudgeAttestation,
  signProvenance,
  signSkillCardAttestation,
  verifyProvenance,
  verifySkillCardAttestation,
  type SkillCardAttestationParams,
} from '../src/core/foundry/provenance.js';

const originalHome = process.env.HOME;
let tmpHome: string;

const params: SkillCardAttestationParams = {
  contentHash: hashDiff('{"canonical":"skill-card"}'),
  skillId: 'security.verify-change',
  revision: 3,
  proposalId: 'proposal-357',
  diffHash: hashDiff('diff --git a/src/x.ts b/src/x.ts\n+verified\n'),
};

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m357-home-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = originalHome;
});

describe('M357 skill-card attestation roundtrip', () => {
  it('signs a canonical fixed tuple with the protected provenance key', () => {
    const attestation = signSkillCardAttestation(params);

    expect(attestation).toMatch(/^[0-9a-f]{64}$/);
    expect(verifySkillCardAttestation(attestation, params)).toEqual({ ok: true });
    expect(fs.existsSync(provenanceKeyPath())).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(provenanceKeyPath()).mode & 0o777).toBe(0o600);
    }
  });

  it('is stable for the same key and immutable tuple', () => {
    expect(signSkillCardAttestation(params)).toBe(signSkillCardAttestation(params));
  });

  it.each([
    ['contentHash', { contentHash: hashDiff('different card') }],
    ['skillId', { skillId: 'security.different-skill' }],
    ['revision', { revision: 4 }],
    ['proposalId', { proposalId: 'proposal-other' }],
    ['diffHash', { diffHash: hashDiff('different diff') }],
  ] as const)('binds %s into the attested tuple', (_field, mutation) => {
    const attestation = signSkillCardAttestation(params);
    const verdict = verifySkillCardAttestation(attestation, { ...params, ...mutation });

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/HMAC mismatch/i);
  });

  it('keeps pipe-bearing ids unambiguous', () => {
    const withPipes = {
      ...params,
      skillId: 'security|verify-change',
      proposalId: 'proposal|357',
    };

    const attestation = signSkillCardAttestation(withPipes);
    expect(verifySkillCardAttestation(attestation, withPipes)).toEqual({ ok: true });
    expect(verifySkillCardAttestation(attestation, params).ok).toBe(false);
  });
});

describe('M357 skill-card attestation domain separation', () => {
  it('rejects a proposal provenance signature as a skill-card attestation', () => {
    const proposalSignature = signProvenance(
      params.skillId,
      String(params.revision),
      params.diffHash,
    );

    expect(verifySkillCardAttestation(proposalSignature, params)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/HMAC mismatch/i),
    });
  });

  it('rejects a proposal judge signature as a skill-card attestation', () => {
    const judgeSignature = signJudgeAttestation({
      proposalId: params.proposalId,
      judgeEngine: params.skillId,
      verdict: String(params.revision),
      diffHash: params.diffHash,
    });

    expect(verifySkillCardAttestation(judgeSignature, params)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/HMAC mismatch/i),
    });
  });

  it('does not accept a skill-card signature as proposal provenance', () => {
    const skillSignature = signSkillCardAttestation(params);
    const diff = 'diff --git a/src/x.ts b/src/x.ts\n+verified\n';

    expect(verifyProvenance({
      engineModel: params.skillId,
      engineTier: String(params.revision),
      diff,
      diffHash: params.diffHash,
      provenanceSig: skillSignature,
    }).ok).toBe(false);
  });
});

describe('M357 skill-card attestation fails closed', () => {
  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['short', 'deadbeef'],
    ['non-hex', 'z'.repeat(64)],
    ['non-canonical uppercase', 'A'.repeat(64)],
  ])('rejects a %s attestation without throwing', (_label, attestation) => {
    expect(() => verifySkillCardAttestation(attestation, params)).not.toThrow();
    expect(verifySkillCardAttestation(attestation, params).ok).toBe(false);
  });

  it.each([
    ['missing params', undefined],
    ['missing contentHash', { ...params, contentHash: '' }],
    ['short contentHash', { ...params, contentHash: 'a'.repeat(63) }],
    ['uppercase contentHash', { ...params, contentHash: 'A'.repeat(64) }],
    ['missing skillId', { ...params, skillId: '' }],
    ['whitespace skillId', { ...params, skillId: ' skill ' }],
    ['control character skillId', { ...params, skillId: 'skill\nother' }],
    ['zero revision', { ...params, revision: 0 }],
    ['fractional revision', { ...params, revision: 1.5 }],
    ['non-finite revision', { ...params, revision: Number.NaN }],
    ['missing proposalId', { ...params, proposalId: '' }],
    ['whitespace proposalId', { ...params, proposalId: '   ' }],
    ['missing diffHash', { ...params, diffHash: '' }],
    ['non-hex diffHash', { ...params, diffHash: 'g'.repeat(64) }],
  ])('rejects %s during signing and verification', (_label, candidate) => {
    const malformed = candidate as SkillCardAttestationParams;

    expect(() => signSkillCardAttestation(malformed)).not.toThrow();
    expect(signSkillCardAttestation(malformed)).toBe('');
    expect(() => verifySkillCardAttestation('a'.repeat(64), malformed)).not.toThrow();
    expect(verifySkillCardAttestation('a'.repeat(64), malformed).ok).toBe(false);
  });

  it('does not create a key for malformed inputs', () => {
    expect(signSkillCardAttestation({ ...params, revision: 0 })).toBe('');
    expect(verifySkillCardAttestation('not-a-mac', params).ok).toBe(false);
    expect(fs.existsSync(provenanceKeyPath())).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('refuses to sign or verify with an exposed key', () => {
    expect(signSkillCardAttestation(params)).toMatch(/^[0-9a-f]{64}$/);
    fs.chmodSync(provenanceKeyPath(), 0o644);

    expect(signSkillCardAttestation(params)).toBe('');
    const verdict = verifySkillCardAttestation('a'.repeat(64), params);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/unsafe permissions/i);
  });
});
