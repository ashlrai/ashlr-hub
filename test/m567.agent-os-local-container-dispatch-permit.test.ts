import {
  createHash,
  generateKeyPairSync,
  sign as signEd25519,
  verify as verifyEd25519,
} from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_OS_LOCAL_CONTAINER_DISPATCH_PERMIT_SIGNATURE_ALGORITHM_V1,
  AGENT_OS_LOCAL_CONTAINER_DISPATCH_PERMIT_V1,
  AGENT_OS_LOCAL_CONTAINER_DISPATCH_SCOPE_V1,
  canonicalAgentOsLocalContainerDispatchPermitBytesV1,
  digestAgentOsLocalContainerDispatchPermitV1,
  verifyAgentOsLocalContainerDispatchPermitV1,
  type AgentOsLocalContainerDispatchPermitBindingsV1,
  type AgentOsLocalContainerDispatchPermitEnvelopeV1,
  type AgentOsLocalContainerDispatchPermitUnsignedV1,
  type AgentOsLocalContainerDispatchPermitVerifierV1,
} from '../src/core/vision/agent-os-local-container-dispatch-permit.js';

const raw = (label: string): string => createHash('sha256').update(`m567-permit\0${label}`).digest('hex');
const prefixed = (label: string): string => `sha256:${raw(label)}`;
const NOW = Date.parse('2026-09-04T18:00:00.000Z');
const pair = generateKeyPairSync('ed25519');
const KEY_ID = raw('dispatch-key');

function bindings(overrides: Partial<AgentOsLocalContainerDispatchPermitBindingsV1> = {}):
AgentOsLocalContainerDispatchPermitBindingsV1 {
  return {
    requestNonce: Buffer.alloc(32, 0x57).toString('base64url'),
    requestDigest: raw('request'),
    deadlineAt: new Date(NOW + 60_000).toISOString(),
    brokerDigest: raw('broker'),
    engineDigest: raw('engine'),
    imageDigest: raw('image'),
    producerDigest: raw('producer'),
    seccompDigest: raw('seccomp'),
    createConfigDigest: raw('create-config'),
    executionIdentityDigest: prefixed('execution-identity'),
    capacityEvidenceDigest: prefixed('capacity-evidence'),
    slots: 1,
    ...overrides,
  };
}

function unsigned(
  overrides: Partial<AgentOsLocalContainerDispatchPermitUnsignedV1> = {},
): AgentOsLocalContainerDispatchPermitUnsignedV1 {
  return {
    schemaVersion: 1,
    protocol: AGENT_OS_LOCAL_CONTAINER_DISPATCH_PERMIT_V1,
    permitId: raw('permit'),
    keyId: KEY_ID,
    issuedAt: new Date(NOW - 1_000).toISOString(),
    expiresAt: new Date(NOW + 120_000).toISOString(),
    scope: { ...AGENT_OS_LOCAL_CONTAINER_DISPATCH_SCOPE_V1 },
    bindings: bindings(),
    ...overrides,
  };
}

function envelope(
  overrides: Partial<AgentOsLocalContainerDispatchPermitUnsignedV1> = {},
): AgentOsLocalContainerDispatchPermitEnvelopeV1 {
  const value = unsigned(overrides);
  const bytes = canonicalAgentOsLocalContainerDispatchPermitBytesV1(value);
  const permitDigest = digestAgentOsLocalContainerDispatchPermitV1(value);
  if (!bytes || !permitDigest) throw new Error('invalid permit fixture');
  return {
    ...value,
    signatureAlgorithm: AGENT_OS_LOCAL_CONTAINER_DISPATCH_PERMIT_SIGNATURE_ALGORITHM_V1,
    permitDigest,
    signature: signEd25519(null, bytes, pair.privateKey).toString('base64url'),
  };
}

const verifier: AgentOsLocalContainerDispatchPermitVerifierV1 = {
  keyId: KEY_ID,
  verify: ({ canonicalDomainSeparatedPermit, signature }) => verifyEd25519(
    null,
    Buffer.from(canonicalDomainSeparatedPermit),
    pair.publicKey,
    Buffer.from(signature),
  ),
};

function verify(
  value: unknown,
  expected = bindings(),
  selectedVerifier: AgentOsLocalContainerDispatchPermitVerifierV1 = verifier,
  nowMs = NOW,
) {
  return verifyAgentOsLocalContainerDispatchPermitV1(value, expected, selectedVerifier, nowMs);
}

describe('M567 local-container dispatch permit', () => {
  it('verifies one exact local observation-container grant without forwarding authority', () => {
    expect(verify(envelope())).toEqual({
      state: 'verified',
      reason: 'permit-verified',
      dispatchAuthorized: true,
      permitDigest: envelope().permitDigest,
      keyId: KEY_ID,
      requestDigest: raw('request'),
      authority: 'verification-only',
      executionAuthority: false,
      effectAuthority: false,
      externalMutationAuthority: false,
      providerContactAuthority: false,
      credentialAuthority: false,
      commissioningAuthority: false,
      activationAuthority: false,
    });
  });

  it('rejects every substituted binding', () => {
    const replacements: Array<[keyof AgentOsLocalContainerDispatchPermitBindingsV1, unknown]> = [
      ['requestNonce', Buffer.alloc(32, 0x58).toString('base64url')],
      ['requestDigest', raw('other-request')],
      ['deadlineAt', new Date(NOW + 59_000).toISOString()],
      ['brokerDigest', raw('other-broker')],
      ['engineDigest', raw('other-engine')],
      ['imageDigest', raw('other-image')],
      ['producerDigest', raw('other-producer')],
      ['seccompDigest', raw('other-seccomp')],
      ['createConfigDigest', raw('other-config')],
      ['executionIdentityDigest', prefixed('other-identity')],
      ['capacityEvidenceDigest', prefixed('other-evidence')],
      ['slots', 2],
    ];
    const signed = envelope();
    for (const [key, value] of replacements) {
      expect(verify(signed, { ...bindings(), [key]: value })).toMatchObject({
        state: 'withheld', reason: key === 'slots' ? 'invalid-input' : 'binding-mismatch',
        dispatchAuthorized: false,
      });
    }
  });

  it('rejects stale, future, overlong, deadline-escaping, wrong-key, and forged permits', () => {
    expect(verify(envelope(), bindings(), verifier, NOW + 120_000)).toMatchObject({
      reason: 'permit-expired', dispatchAuthorized: false,
    });
    expect(verify(envelope({ issuedAt: new Date(NOW + 6_000).toISOString() }))).toMatchObject({
      reason: 'permit-future', dispatchAuthorized: false,
    });
    expect(verify(envelope({
      issuedAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + 300_001).toISOString(),
      bindings: bindings({ deadlineAt: new Date(NOW + 60_000).toISOString() }),
    }))).toMatchObject({ reason: 'permit-lifetime-invalid' });
    expect(verify(envelope({
      expiresAt: new Date(NOW + 30_000).toISOString(),
      bindings: bindings({ deadlineAt: new Date(NOW + 60_000).toISOString() }),
    }))).toMatchObject({ reason: 'permit-lifetime-invalid' });
    expect(verify(envelope(), bindings(), { ...verifier, keyId: raw('wrong-key') })).toMatchObject({
      reason: 'permit-key-mismatch', dispatchAuthorized: false,
    });
    const forged = { ...envelope(), signature: Buffer.alloc(64, 7).toString('base64url') };
    expect(verify(forged)).toMatchObject({ reason: 'signature-invalid', dispatchAuthorized: false });
  });

  it('rejects proxy/accessor/extra-property shapes without invoking verifier code', () => {
    const callback = vi.fn(() => true);
    const pinned = { keyId: KEY_ID, verify: callback };
    const proxied = new Proxy(envelope(), {});
    expect(verify(proxied, bindings(), pinned)).toMatchObject({ reason: 'invalid-input' });
    const accessed = vi.fn(() => raw('attacker'));
    const accessor = { ...envelope() } as Record<string, unknown>;
    Object.defineProperty(accessor, 'permitDigest', { enumerable: true, get: accessed });
    expect(verify(accessor, bindings(), pinned)).toMatchObject({ reason: 'invalid-input' });
    expect(accessed).not.toHaveBeenCalled();
    expect(verify({ ...envelope(), extra: true }, bindings(), pinned)).toMatchObject({
      reason: 'invalid-permit',
    });
    expect(callback).not.toHaveBeenCalled();
  });

  it('detects verifier mutation of authenticated bytes', () => {
    expect(verify(envelope(), bindings(), {
      keyId: KEY_ID,
      verify: ({ canonicalDomainSeparatedPermit }) => {
        canonicalDomainSeparatedPermit[0] = 0;
        return true;
      },
    })).toMatchObject({ reason: 'verifier-mutated-input', dispatchAuthorized: false });
  });
});
