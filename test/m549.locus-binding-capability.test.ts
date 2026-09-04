import { createHmac } from 'node:crypto';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  canonicalLocusBindingCapabilityBytesV1,
  LOCUS_BINDING_CAPABILITY_MAX_AUDIENCE_BYTES,
  LOCUS_BINDING_CAPABILITY_MAX_BYTES,
  LOCUS_BINDING_CAPABILITY_PURPOSE,
  LOCUS_BINDING_CAPABILITY_PROTOCOL,
  LOCUS_BINDING_CAPABILITY_MAX_WORKSPACE_BYTES,
  mintLocusBindingCapabilityV1,
  verifyLocusBindingCapabilityV1,
  type LocusBindingCapabilityDependenciesV1,
  type LocusBindingCapabilityV1,
  type MintLocusBindingCapabilityInputV1,
} from '../src/core/fabric/locus-binding-capability.js';
import { LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST } from
  '../src/core/fabric/external-locus-workspace-identity.js';

const NOW = new Date('2026-09-03T16:00:00.000Z');
const KEY = Buffer.alloc(32, 0x49);
const AUDIENCE_LABEL = 'ashlr-hub:local-observer';
const WORKSPACE_LOCATOR = '/Users/private/source/project';

function dependencies(overrides: Partial<LocusBindingCapabilityDependenciesV1> = {}):
LocusBindingCapabilityDependenciesV1 {
  return {
    key: () => Buffer.from(KEY),
    now: () => NOW,
    randomBytes: (size) => Buffer.alloc(size, 0x5a),
    ...overrides,
  };
}

function input(overrides: Partial<MintLocusBindingCapabilityInputV1> = {}):
MintLocusBindingCapabilityInputV1 {
  return {
    audienceLabel: AUDIENCE_LABEL,
    workspaceLocator: WORKSPACE_LOCATOR,
    purpose: LOCUS_BINDING_CAPABILITY_PURPOSE,
    policyGeneration: 7,
    sequence: 1,
    previousObservationDigest: LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST,
    lifetimeMs: 5 * 60_000,
    ...overrides,
  };
}

function mint(
  overrides: Partial<MintLocusBindingCapabilityInputV1> = {},
  deps = dependencies(),
): LocusBindingCapabilityV1 {
  const result = mintLocusBindingCapabilityV1(input(overrides), deps);
  if (!result.ok) throw new Error(`could not mint fixture: ${result.issue}`);
  return result.capability;
}

function bytes(value: unknown): Buffer {
  const canonical = canonicalLocusBindingCapabilityBytesV1(value);
  if (!canonical) throw new Error('capability was not canonicalizable');
  return canonical;
}

function jsonClone(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function context(capability: LocusBindingCapabilityV1) {
  return {
    capabilityId: capability.capabilityId,
    purpose: LOCUS_BINDING_CAPABILITY_PURPOSE,
    policyGeneration: capability.policyGeneration,
  };
}

describe('M549 privacy-safe Locus binding capability', () => {
  it('mints context-separated keyed digests without returning private labels or paths', () => {
    const capability = mint();
    const serialized = bytes(capability).toString('utf8');

    expect(capability).toMatchObject({
      schemaVersion: 1,
      protocol: LOCUS_BINDING_CAPABILITY_PROTOCOL,
      recordType: 'locus-binding-capability',
      authority: 'observation-only',
      capabilityScope: 'expectation-only',
      sourceState: 'host-local-unverified',
      purpose: LOCUS_BINDING_CAPABILITY_PURPOSE,
      privacyClass: 'keyed-opaque-digests-only',
      policyGeneration: 7,
      issuedAt: NOW.toISOString(),
      expiresAt: '2026-09-03T16:05:00.000Z',
      sequence: 1,
      previousObservationDigest: LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST,
      sameUserTamperResistant: false,
      rollbackProtected: false,
      truthVerified: false,
      releaseProvenanceVerified: false,
      policyGenerationVerified: false,
      trusted: false,
      planningAuthority: false,
      executionAuthority: false,
      effectAuthority: false,
      proposalAuthority: false,
      routingAuthority: false,
      reservationAuthority: false,
      budgetAuthority: false,
      credentialAuthority: false,
      learningAuthority: false,
      policyAuthority: false,
      promotionAuthority: false,
      verificationAuthority: false,
      mergeAuthority: false,
      releaseAuthority: false,
      deployAuthority: false,
      publicationAuthority: false,
      externalMutationAuthority: false,
      policyEligible: false,
      promotionEligible: false,
    });
    expect(capability.audienceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(capability.workspaceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(capability.audienceDigest).not.toBe(capability.workspaceDigest);
    expect(serialized).not.toContain(AUDIENCE_LABEL);
    expect(serialized).not.toContain(WORKSPACE_LOCATOR);
    expect(serialized).not.toContain('/Users/');

    const audienceMac = createHmac('sha256', KEY)
      .update('ashlr:locus-binding-capability:audience:v1\0', 'utf8')
      .update(JSON.stringify([
        LOCUS_BINDING_CAPABILITY_PURPOSE, 7, AUDIENCE_LABEL,
      ]), 'utf8').digest('hex');
    const workspaceMac = createHmac('sha256', KEY)
      .update('ashlr:locus-binding-capability:workspace:v1\0', 'utf8')
      .update(JSON.stringify([
        LOCUS_BINDING_CAPABILITY_PURPOSE, 7, `sha256:${audienceMac}`, WORKSPACE_LOCATOR,
      ]), 'utf8').digest('hex');
    expect(capability.audienceDigest).toBe(`sha256:${audienceMac}`);
    expect(capability.workspaceDigest).toBe(`sha256:${workspaceMac}`);
  });

  it('verifies to exactly the four M547 expectation fields and nothing authoritative', () => {
    const capability = mint();
    const result = verifyLocusBindingCapabilityV1(bytes(capability), context(capability), dependencies());
    expect(result).toEqual({
      ok: true,
      expectations: {
        audienceDigest: capability.audienceDigest,
        workspaceDigest: capability.workspaceDigest,
        sequence: 1,
        previousObservationDigest: LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST,
      },
      issue: null,
    });
    if (!result.ok) return;
    expect(Object.keys(result.expectations).sort()).toEqual([
      'audienceDigest', 'previousObservationDigest', 'sequence', 'workspaceDigest',
    ]);
    expect('truthVerified' in result.expectations).toBe(false);
    expect('policyAuthority' in result.expectations).toBe(false);
    expect('effectAuthority' in result.expectations).toBe(false);
    expectTypeOf(result.expectations).not.toMatchTypeOf<{ policyAuthority: boolean }>();
  });

  it('deep-freezes mint and verification outputs without freezing caller input', () => {
    const callerInput = input();
    const result = mintLocusBindingCapabilityV1(callerInput, dependencies());
    expect(result.ok).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(callerInput)).toBe(false);
    if (!result.ok) return;
    expect(Object.isFrozen(result.capability)).toBe(true);
    expect(() => {
      (result.capability as unknown as Record<string, unknown>)['trusted'] = true;
    }).toThrow(TypeError);
    const verified = verifyLocusBindingCapabilityV1(
      bytes(result.capability), context(result.capability), dependencies(),
    );
    expect(Object.isFrozen(verified)).toBe(true);
    if (verified.ok) expect(Object.isFrozen(verified.expectations)).toBe(true);
  });

  it('creates unique replay identities while keeping a repeated capability idempotent in its exact context', () => {
    let fill = 1;
    const deps = dependencies({ randomBytes: (size) => Buffer.alloc(size, fill++) });
    const first = mint({}, deps);
    const second = mint({}, deps);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.capabilityId).not.toBe(second.capabilityId);
    expect(first.attestation).not.toBe(second.attestation);
    expect(first.audienceDigest).toBe(second.audienceDigest);
    expect(first.workspaceDigest).toBe(second.workspaceDigest);
    expect(verifyLocusBindingCapabilityV1(bytes(first), context(first), deps).ok).toBe(true);
    expect(verifyLocusBindingCapabilityV1(bytes(first), context(first), deps).ok).toBe(true);
  });

  it('rotates stable bindings across audiences and policy generations', () => {
    const first = mint();
    const otherAudience = mint({ audienceLabel: 'another-audience' });
    const nextGeneration = mint({ policyGeneration: 8 });
    expect(otherAudience.audienceDigest).not.toBe(first.audienceDigest);
    expect(otherAudience.workspaceDigest).not.toBe(first.workspaceDigest);
    expect(nextGeneration.audienceDigest).not.toBe(first.audienceDigest);
    expect(nextGeneration.workspaceDigest).not.toBe(first.workspaceDigest);
  });

  it('rejects replay across capability identity, purpose, or policy generation', () => {
    const first = mint();
    const other = mint({}, dependencies({ randomBytes: (size) => Buffer.alloc(size, 0x33) }));
    expect(verifyLocusBindingCapabilityV1(bytes(first), context(other), dependencies()))
      .toMatchObject({ ok: false, issue: 'context-mismatch' });
    expect(verifyLocusBindingCapabilityV1(bytes(first), {
      ...context(first), policyGeneration: first.policyGeneration + 1,
    }, dependencies())).toMatchObject({ ok: false, issue: 'context-mismatch' });
    expect(verifyLocusBindingCapabilityV1(bytes(first), {
      ...context(first), purpose: 'wrong-purpose' as typeof LOCUS_BINDING_CAPABILITY_PURPOSE,
    }, dependencies())).toMatchObject({ ok: false, issue: 'context-mismatch' });
  });

  it('fails closed when the existing key or secure entropy is unavailable', () => {
    expect(mintLocusBindingCapabilityV1(input(), dependencies({ key: () => null })))
      .toEqual({ ok: false, capability: null, issue: 'key-unavailable' });
    expect(mintLocusBindingCapabilityV1(input(), dependencies({ key: () => Buffer.alloc(31) })))
      .toEqual({ ok: false, capability: null, issue: 'key-unavailable' });
    expect(mintLocusBindingCapabilityV1(input(), dependencies({ randomBytes: () => Buffer.alloc(31) })))
      .toEqual({ ok: false, capability: null, issue: 'entropy-unavailable' });
    expect(mintLocusBindingCapabilityV1(input(), dependencies({ randomBytes: () => { throw new Error('rng'); } })))
      .toEqual({ ok: false, capability: null, issue: 'entropy-unavailable' });
  });

  it('requires canonical, bounded, normalized private inputs and exact purpose', () => {
    const invalid: Array<Partial<MintLocusBindingCapabilityInputV1>> = [
      { audienceLabel: '' },
      { audienceLabel: ' leading' },
      { audienceLabel: 'line\nbreak' },
      { audienceLabel: 'e\u0301' },
      { audienceLabel: 'a'.repeat(LOCUS_BINDING_CAPABILITY_MAX_AUDIENCE_BYTES + 1) },
      { workspaceLocator: '' },
      { workspaceLocator: 'bad\0path' },
      { workspaceLocator: 'w'.repeat(LOCUS_BINDING_CAPABILITY_MAX_WORKSPACE_BYTES + 1) },
      { purpose: 'other' as typeof LOCUS_BINDING_CAPABILITY_PURPOSE },
      { policyGeneration: 0 },
      { policyGeneration: 1.5 },
      { policyGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { lifetimeMs: 999 },
      { lifetimeMs: 300_001 },
    ];
    for (const override of invalid) {
      expect(mintLocusBindingCapabilityV1(input(override), dependencies()), JSON.stringify(override))
        .toMatchObject({ ok: false, issue: 'invalid-input' });
    }
    const extra = { ...input(), extra: true };
    expect(mintLocusBindingCapabilityV1(extra as MintLocusBindingCapabilityInputV1, dependencies()))
      .toMatchObject({ ok: false, issue: 'invalid-input' });
    expect(mint({ policyGeneration: Number.MAX_SAFE_INTEGER }).policyGeneration)
      .toBe(Number.MAX_SAFE_INTEGER);
  });

  it('enforces exact sequence/predecessor lineage shapes', () => {
    expect(mintLocusBindingCapabilityV1(input({ sequence: 1, previousObservationDigest: `sha256:${'1'.repeat(64)}` }), dependencies()))
      .toMatchObject({ ok: false, issue: 'invalid-input' });
    expect(mintLocusBindingCapabilityV1(input({ sequence: 2, previousObservationDigest: LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST }), dependencies()))
      .toMatchObject({ ok: false, issue: 'invalid-input' });
    const successor = mint({ sequence: 2, previousObservationDigest: `sha256:${'1'.repeat(64)}` });
    expect(successor.sequence).toBe(2);
  });

  it('rejects reordered, whitespace, duplicate-key, malformed UTF-8, and oversized JSON', () => {
    const capability = mint();
    const canonical = bytes(capability);
    const reordered = Buffer.from(JSON.stringify(capability), 'utf8');
    expect(reordered.equals(canonical)).toBe(false);
    for (const candidate of [
      reordered,
      Buffer.concat([canonical, Buffer.from('\n')]),
      Buffer.from('{"schemaVersion":1,' + canonical.toString('utf8').slice(1), 'utf8'),
    ]) {
      expect(verifyLocusBindingCapabilityV1(candidate, context(capability), dependencies()))
        .toMatchObject({ ok: false, issue: 'non-canonical-json' });
    }
    expect(verifyLocusBindingCapabilityV1(Buffer.from([0xc3, 0x28]), context(capability), dependencies()))
      .toMatchObject({ ok: false, issue: 'invalid-bytes' });
    expect(verifyLocusBindingCapabilityV1(
      Buffer.alloc(LOCUS_BINDING_CAPABILITY_MAX_BYTES + 1), context(capability), dependencies(),
    )).toMatchObject({ ok: false, issue: 'oversized-capability' });
  });

  it('rejects unknown fields and every attempted authority escalation', () => {
    const capability = mint();
    const unknown = jsonClone(capability);
    unknown['workspaceLocator'] = WORKSPACE_LOCATOR;
    expect(canonicalLocusBindingCapabilityBytesV1(unknown)).toBeNull();
    const accessor = jsonClone(capability);
    const getter = vi.fn(() => false);
    Object.defineProperty(accessor, 'trusted', { enumerable: true, get: getter });
    expect(canonicalLocusBindingCapabilityBytesV1(accessor)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
    const symbolic = jsonClone(capability);
    symbolic[Symbol('hidden') as unknown as string] = true;
    expect(canonicalLocusBindingCapabilityBytesV1(symbolic)).toBeNull();

    for (const key of [
      'sameUserTamperResistant', 'rollbackProtected', 'truthVerified',
      'releaseProvenanceVerified', 'trusted', 'planningAuthority', 'executionAuthority',
      'policyGenerationVerified', 'effectAuthority', 'proposalAuthority', 'routingAuthority',
      'reservationAuthority', 'budgetAuthority', 'credentialAuthority', 'learningAuthority',
      'policyAuthority', 'promotionAuthority', 'verificationAuthority', 'mergeAuthority',
      'releaseAuthority', 'deployAuthority', 'publicationAuthority', 'externalMutationAuthority',
      'policyEligible', 'promotionEligible',
    ]) {
      const forged = jsonClone(capability);
      forged[key] = true;
      expect(canonicalLocusBindingCapabilityBytesV1(forged), key).toBeNull();
    }
  });

  it('enforces future skew, expiration, and bounded validity windows', () => {
    const capability = mint();
    expect(verifyLocusBindingCapabilityV1(bytes(capability), context(capability), dependencies({
      now: () => new Date('2026-09-03T15:58:59.999Z'),
    }))).toMatchObject({ ok: false, issue: 'future-capability' });
    expect(verifyLocusBindingCapabilityV1(bytes(capability), context(capability), dependencies({
      now: () => new Date(capability.expiresAt),
    }))).toMatchObject({ ok: false, issue: 'expired-capability' });

    for (const [issuedAt, expiresAt] of [
      ['2026-09-03T16:00:00.000Z', '2026-09-03T16:00:00.999Z'],
      ['2026-09-03T16:00:00.000Z', '2026-09-03T16:05:00.001Z'],
      ['2026-09-03T16:00:00Z', '2026-09-03T16:05:00.000Z'],
    ]) {
      const invalid = jsonClone(capability);
      invalid['issuedAt'] = issuedAt;
      invalid['expiresAt'] = expiresAt;
      expect(canonicalLocusBindingCapabilityBytesV1(invalid)).toBeNull();
    }
    expect(mintLocusBindingCapabilityV1(input(), dependencies({ now: () => new Date(Number.NaN) })))
      .toMatchObject({ ok: false, issue: 'invalid-input' });
  });

  it('detects identity, attestation, and wrong-key substitutions', () => {
    const capability = mint();
    const badId = jsonClone(capability);
    badId['capabilityId'] = `hmac-sha256:${'1'.repeat(64)}`;
    expect(verifyLocusBindingCapabilityV1(bytes(badId), {
      ...context(capability), capabilityId: badId['capabilityId'] as string,
    }, dependencies())).toMatchObject({ ok: false, issue: 'capability-id-mismatch' });

    const badAttestation = jsonClone(capability);
    badAttestation['attestation'] = `hmac-sha256:${'2'.repeat(64)}`;
    expect(verifyLocusBindingCapabilityV1(bytes(badAttestation), context(capability), dependencies()))
      .toMatchObject({ ok: false, issue: 'attestation-mismatch' });

    expect(verifyLocusBindingCapabilityV1(bytes(capability), context(capability), dependencies({
      key: () => Buffer.alloc(32, 0x50),
    }))).toMatchObject({ ok: false, issue: 'capability-id-mismatch' });
  });

  it('rejects getters without invoking them and never asks for entropy before validation or key access', () => {
    const getter = vi.fn(() => AUDIENCE_LABEL);
    const malicious = { ...input() } as Record<string, unknown>;
    Object.defineProperty(malicious, 'audienceLabel', { enumerable: true, get: getter });
    const key = vi.fn(() => Buffer.from(KEY));
    const entropy = vi.fn((size: number) => Buffer.alloc(size));
    expect(mintLocusBindingCapabilityV1(
      malicious as unknown as MintLocusBindingCapabilityInputV1,
      dependencies({ key, randomBytes: entropy }),
    )).toMatchObject({ ok: false, issue: 'invalid-input' });
    expect(getter).not.toHaveBeenCalled();
    expect(key).not.toHaveBeenCalled();
    expect(entropy).not.toHaveBeenCalled();
  });

  it('does not alias caller-owned bytes during verification', () => {
    const capability = mint();
    const callerBytes = bytes(capability);
    const result = verifyLocusBindingCapabilityV1(callerBytes, context(capability), dependencies());
    expect(result.ok).toBe(true);
    callerBytes.fill(0);
    if (!result.ok) return;
    expect(result.expectations.audienceDigest).toBe(capability.audienceDigest);
  });
});
