import {
  createHash,
  generateKeyPairSync,
  sign as signEd25519,
  verify as verifyEd25519,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  AGENT_OS_EPOCH_SOURCE_RAW_GENESIS_DIGEST_V2,
  AGENT_OS_EPOCH_RECORD_AUTHORITY_V1,
} from '../src/core/vision/agent-os-epoch-records.js';
import {
  AGENT_OS_EPOCH_SOURCE_RENEWAL_PROTOCOL_V1,
  AGENT_OS_EPOCH_SOURCE_RENEWAL_DIGEST_DOMAIN_V1,
  AGENT_OS_EPOCH_SOURCE_RENEWAL_SIGNATURE_DOMAIN_V1,
  canonicalAgentOsEpochSourceRenewalBytesV1,
  createAgentOsEpochSourceRenewalV1,
  parseAgentOsEpochSourceRenewalV1,
  verifyAgentOsEpochSourceRenewalV1,
  type AgentOsEpochSourceRenewalActiveContextProviderV1,
  type AgentOsEpochSourceRenewalActiveContextV1,
  type AgentOsEpochSourceRenewalInputV1,
  type AgentOsEpochSourceRenewalSignatureVerifierV1,
} from '../src/core/vision/agent-os-epoch-source-ledger.js';

const raw = (label: string): string => createHash('sha256').update(`m559-raw\0${label}`).digest('hex');
const prefixed = (label: string): string => `sha256:${raw(label)}`;

function fixture(sequence = 2) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const payload = Buffer.from('{"source":"renewed"}', 'utf8');
  const input: AgentOsEpochSourceRenewalInputV1 = {
    epoch: 7,
    epochSequence: sequence,
    epochHeadDigest: prefixed('epoch-head'),
    epochManifestDigest: prefixed('epoch-manifest'),
    attemptNamespaceDigest: prefixed('attempt-namespace'),
    previousBundleDigest: raw('previous-source'),
    trustPolicyDigest: raw('policy'),
    policyGeneration: 9,
    sourceKeyId: raw('source-key'),
    sourcePrincipalDigest: prefixed('source-principal'),
    evidencePrincipalDigest: prefixed('evidence-principal'),
    outcomePrincipalDigests: [prefixed('outcome-b'), prefixed('outcome-a')],
    issuedAt: '2026-09-03T12:00:00.000Z',
    expiresAt: '2026-09-03T12:04:00.000Z',
    sourcePayloadBytes: payload,
  };
  const signer = {
    keyId: input.sourceKeyId,
    principalDigest: input.sourcePrincipalDigest,
    sign: (bytes: Uint8Array) => Buffer.from(signEd25519(null, Buffer.from(bytes), privateKey)),
  };
  const verifier: AgentOsEpochSourceRenewalSignatureVerifierV1 = {
    verify: (request) => verifyEd25519(
      null,
      Buffer.from(request.canonicalDomainSeparatedPayload),
      publicKey,
      Buffer.from(request.signature),
    ),
  };
  const context: AgentOsEpochSourceRenewalActiveContextV1 = {
    epoch: input.epoch,
    expectedEpochSequence: input.epochSequence,
    epochHeadDigest: input.epochHeadDigest,
    epochManifestDigest: input.epochManifestDigest,
    attemptNamespaceDigest: input.attemptNamespaceDigest,
    currentSourceBundleDigest: input.previousBundleDigest,
    trustPolicyDigest: input.trustPolicyDigest,
    policyGeneration: input.policyGeneration,
    expectedSourceKeyId: input.sourceKeyId,
    expectedSourcePrincipalDigest: input.sourcePrincipalDigest,
    observedAt: '2026-09-03T12:00:30.000Z',
  };
  const provider: AgentOsEpochSourceRenewalActiveContextProviderV1 = {
    readAuthenticatedActiveEpochContext: () => ({ ...context }),
  };
  const renewal = createAgentOsEpochSourceRenewalV1(input, signer);
  if (!renewal) throw new Error('renewal fixture failed');
  return { input, signer, verifier, context, provider, renewal, payload, privateKey, publicKey };
}

describe('M559 epoch source-renewal ledger contract', () => {
  it('creates and verifies a canonical sequence-two renewal with all authority false', () => {
    const value = fixture();
    expect(value.renewal).toMatchObject({
      schemaVersion: 1,
      protocol: AGENT_OS_EPOCH_SOURCE_RENEWAL_PROTOCOL_V1,
      recordType: 'agent-os-epoch-source-renewal',
      epoch: 7,
      epochSequence: 2,
      previousBundleDigest: value.input.previousBundleDigest,
      outcomePrincipalDigests: [...value.input.outcomePrincipalDigests].sort(),
      ...AGENT_OS_EPOCH_RECORD_AUTHORITY_V1,
    });
    const verified = verifyAgentOsEpochSourceRenewalV1(
      value.renewal,
      value.verifier,
      value.provider,
    );
    expect(verified).toMatchObject({ ok: true, issues: [], ...AGENT_OS_EPOCH_RECORD_AUTHORITY_V1 });
    expect(verified.ok && verified.renewal).not.toBe(value.renewal);
    expect(Object.isFrozen(value.renewal)).toBe(true);
    expect(Object.isFrozen(value.renewal.outcomePrincipalDigests)).toBe(true);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(verified.ok && Object.isFrozen(verified.renewal)).toBe(true);
  });

  it('owns payload bytes and returns deterministic canonical bytes', () => {
    const value = fixture();
    const before = canonicalAgentOsEpochSourceRenewalBytesV1(value.renewal);
    value.payload.fill(0);
    const after = canonicalAgentOsEpochSourceRenewalBytesV1(value.renewal);
    expect(after).toEqual(before);
    expect(parseAgentOsEpochSourceRenewalV1(before!)).toEqual(value.renewal);
  });

  it.each([2, 3, 4_095, 4_096])('accepts bounded renewal sequence %i', (sequence) => {
    const value = fixture(sequence);
    expect(value.renewal.epochSequence).toBe(sequence);
    expect(verifyAgentOsEpochSourceRenewalV1(value.renewal, value.verifier, value.provider).ok).toBe(true);
  });

  it.each([1, 0, -1, 4_097, Number.MAX_SAFE_INTEGER])(
    'rejects sequence outside the renewal range: %s',
    (epochSequence) => {
      const value = fixture();
      expect(createAgentOsEpochSourceRenewalV1({ ...value.input, epochSequence }, value.signer)).toBeNull();
    },
  );

  it('never reuses M555 first-source genesis semantics', () => {
    const value = fixture();
    expect(createAgentOsEpochSourceRenewalV1({
      ...value.input,
      previousBundleDigest: AGENT_OS_EPOCH_SOURCE_RAW_GENESIS_DIGEST_V2,
    }, value.signer)).toBeNull();
    expect(value.renewal.protocol).not.toBe('ashlr-agent-os-epoch-source-bundle-v2');
    expect(AGENT_OS_EPOCH_SOURCE_RENEWAL_SIGNATURE_DOMAIN_V1)
      .not.toBe('ashlr:agent-os:epoch-source-bundle:signature:v2\0');
  });

  it.each([
    ['epoch', { epoch: 8 }],
    ['sequence', { expectedEpochSequence: 3 }],
    ['head', { epochHeadDigest: prefixed('other-head') }],
    ['manifest', { epochManifestDigest: prefixed('other-manifest') }],
    ['namespace', { attemptNamespaceDigest: prefixed('other-namespace') }],
    ['previous source', { currentSourceBundleDigest: raw('other-source') }],
    ['policy', { trustPolicyDigest: raw('other-policy') }],
    ['generation', { policyGeneration: 10 }],
    ['key', { expectedSourceKeyId: raw('other-key') }],
    ['principal', { expectedSourcePrincipalDigest: prefixed('other-principal') }],
  ] as const)('rejects authenticated active-context %s substitution', (_label, replacement) => {
    const value = fixture();
    expect(verifyAgentOsEpochSourceRenewalV1(value.renewal, value.verifier, {
      readAuthenticatedActiveEpochContext: () => ({ ...value.context, ...replacement }),
    })).toMatchObject({ ok: false, issues: ['active-context-mismatch'] });
  });

  it('fails when the internal active-context provider is absent, throws, or returns malformed state', () => {
    const value = fixture();
    for (const provider of [
      { readAuthenticatedActiveEpochContext: () => null },
      { readAuthenticatedActiveEpochContext: () => { throw new Error('anchor unavailable'); } },
      { readAuthenticatedActiveEpochContext: () => ({ ...value.context, extra: false }) },
    ]) {
      expect(verifyAgentOsEpochSourceRenewalV1(
        value.renewal,
        value.verifier,
        provider as AgentOsEpochSourceRenewalActiveContextProviderV1,
      )).toMatchObject({ ok: false, issues: ['active-context-unavailable'] });
    }
  });

  it('detects active closure drift across signature verification', () => {
    const value = fixture();
    let reads = 0;
    const provider: AgentOsEpochSourceRenewalActiveContextProviderV1 = {
      readAuthenticatedActiveEpochContext: () => {
        reads += 1;
        return reads === 1
          ? { ...value.context }
          : { ...value.context, currentSourceBundleDigest: raw('advanced-source') };
      },
    };
    expect(verifyAgentOsEpochSourceRenewalV1(value.renewal, value.verifier, provider))
      .toMatchObject({ ok: false, issues: ['active-context-changed'] });
    expect(reads).toBe(2);
  });

  it('rejects expired, excessive, and far-future validity windows', () => {
    const value = fixture();
    expect(verifyAgentOsEpochSourceRenewalV1(value.renewal, value.verifier, {
      readAuthenticatedActiveEpochContext: () => ({
        ...value.context,
        observedAt: '2026-09-03T12:04:00.000Z',
      }),
    })).toMatchObject({ ok: false, issues: ['source-not-current'] });
    for (const times of [
      { issuedAt: '2026-09-03T12:00:00.000Z', expiresAt: '2026-09-03T12:06:00.000Z' },
      { issuedAt: '2026-09-03T12:02:00.000Z', expiresAt: '2026-09-03T12:04:00.000Z' },
      { issuedAt: '2026-09-03T12:01:30.001Z', expiresAt: '2026-09-03T12:04:00.000Z' },
    ]) {
      const candidate = createAgentOsEpochSourceRenewalV1({ ...value.input, ...times }, value.signer)!;
      expect(verifyAgentOsEpochSourceRenewalV1(candidate, value.verifier, value.provider))
        .toMatchObject({ ok: false, issues: ['source-not-current'] });
    }
  });

  it('rejects role collisions and duplicate outcomes before signing', () => {
    const value = fixture();
    expect(createAgentOsEpochSourceRenewalV1({
      ...value.input,
      evidencePrincipalDigest: value.input.sourcePrincipalDigest,
    }, value.signer)).toBeNull();
    expect(createAgentOsEpochSourceRenewalV1({
      ...value.input,
      outcomePrincipalDigests: [prefixed('duplicate'), prefixed('duplicate')],
    }, value.signer)).toBeNull();
  });

  it('rejects a correctly signed but non-canonically ordered outcome-principal set', () => {
    const value = fixture();
    const unsigned = { ...value.renewal } as Record<string, unknown>;
    delete unsigned['signature'];
    delete unsigned['bundleDigest'];
    unsigned['outcomePrincipalDigests'] = [...value.renewal.outcomePrincipalDigests].reverse();
    const unsignedBytes = Buffer.from(JSON.stringify(Object.fromEntries(
      Object.entries(unsigned).sort(([left], [right]) => left.localeCompare(right)),
    )), 'utf8');
    const signature = Buffer.from(signEd25519(null, Buffer.concat([
      Buffer.from(AGENT_OS_EPOCH_SOURCE_RENEWAL_SIGNATURE_DOMAIN_V1, 'utf8'),
      unsignedBytes,
    ]), value.privateKey));
    const candidate = {
      ...unsigned,
      signature: signature.toString('base64url'),
      bundleDigest: createHash('sha256')
        .update(AGENT_OS_EPOCH_SOURCE_RENEWAL_DIGEST_DOMAIN_V1, 'utf8')
        .update(Buffer.concat([unsignedBytes, signature]))
        .digest('hex'),
    };
    expect(canonicalAgentOsEpochSourceRenewalBytesV1(candidate)).toBeNull();
    expect(verifyAgentOsEpochSourceRenewalV1(candidate, value.verifier, value.provider))
      .toMatchObject({ ok: false, issues: ['invalid-input'] });
  });

  it('rejects signature, linkage, payload, and digest substitution', () => {
    const value = fixture();
    for (const candidate of [
      { ...value.renewal, signature: Buffer.alloc(64, 7).toString('base64url') },
      { ...value.renewal, epochHeadDigest: prefixed('tampered-head') },
      { ...value.renewal, previousBundleDigest: raw('tampered-previous') },
      { ...value.renewal, sourcePayload: Buffer.from('{"source":"tampered"}').toString('base64url') },
      { ...value.renewal, bundleDigest: raw('forged-bundle') },
    ]) {
      expect(canonicalAgentOsEpochSourceRenewalBytesV1(candidate)).toBeNull();
      expect(verifyAgentOsEpochSourceRenewalV1(candidate, value.verifier, value.provider).ok).toBe(false);
    }
  });

  it('fails closed when signature verification throws or uses a different domain', () => {
    const value = fixture();
    expect(verifyAgentOsEpochSourceRenewalV1(value.renewal, {
      verify: () => { throw new Error('verification unavailable'); },
    }, value.provider)).toMatchObject({ ok: false, issues: ['signature-invalid'] });
    expect(verifyAgentOsEpochSourceRenewalV1(value.renewal, {
      verify: (request) => verifyEd25519(
        null,
        Buffer.from(request.canonicalDomainSeparatedPayload).subarray(1),
        value.publicKey,
        Buffer.from(request.signature),
      ),
    }, value.provider)).toMatchObject({ ok: false, issues: ['signature-invalid'] });
  });

  it('rejects signer and verifier mutation of owned callback bytes', () => {
    const value = fixture();
    expect(createAgentOsEpochSourceRenewalV1(value.input, {
      ...value.signer,
      sign: (bytes) => {
        bytes.fill(0);
        return Buffer.alloc(64);
      },
    })).toBeNull();
    expect(verifyAgentOsEpochSourceRenewalV1(value.renewal, {
      verify: (request) => {
        request.canonicalDomainSeparatedPayload.fill(0);
        request.signature.fill(0);
        return true;
      },
    }, value.provider)).toMatchObject({ ok: false, issues: ['verifier-mutated'] });
    expect(verifyAgentOsEpochSourceRenewalV1(value.renewal, value.verifier, value.provider).ok).toBe(true);
  });

  it('rejects noncanonical, unknown-field, accessor, and cyclic values', () => {
    const value = fixture();
    const bytes = canonicalAgentOsEpochSourceRenewalBytesV1(value.renewal)!;
    expect(parseAgentOsEpochSourceRenewalV1(Buffer.concat([bytes, Buffer.from('\n')]))).toBeNull();
    expect(canonicalAgentOsEpochSourceRenewalBytesV1({ ...value.renewal, extra: false })).toBeNull();
    const accessor = { ...value.renewal } as Record<string, unknown>;
    Object.defineProperty(accessor, 'epoch', { enumerable: true, get: () => 7 });
    expect(canonicalAgentOsEpochSourceRenewalBytesV1(accessor)).toBeNull();
    const cyclic = { ...value.renewal } as Record<string, unknown>;
    cyclic['outcomePrincipalDigests'] = [cyclic];
    expect(canonicalAgentOsEpochSourceRenewalBytesV1(cyclic)).toBeNull();
  });

  it('rejects raw/prefixed digest substitution and signer identity mismatch', () => {
    const value = fixture();
    expect(createAgentOsEpochSourceRenewalV1({
      ...value.input,
      epochHeadDigest: raw('wrong-representation'),
    }, value.signer)).toBeNull();
    expect(createAgentOsEpochSourceRenewalV1({
      ...value.input,
      previousBundleDigest: prefixed('wrong-representation'),
    }, value.signer)).toBeNull();
    expect(createAgentOsEpochSourceRenewalV1(value.input, {
      ...value.signer,
      keyId: raw('wrong-key'),
    })).toBeNull();
    expect(createAgentOsEpochSourceRenewalV1(value.input, {
      ...value.signer,
      principalDigest: prefixed('wrong-principal'),
    })).toBeNull();
  });
});
