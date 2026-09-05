import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_OS_EPOCH_SNAPSHOT_AUTHENTICATOR_DOMAIN_V2,
  AGENT_OS_EPOCH_SNAPSHOT_ENVELOPE_DOMAIN_V2,
  AGENT_OS_EPOCH_SNAPSHOT_PAYLOAD_DOMAIN_V2,
  canonicalAgentOsEpochSnapshotEnvelopeBytesV2,
  createAgentOsEpochSnapshotEnvelopeV2,
  parseAgentOsEpochSnapshotEnvelopeV2,
  verifyAgentOsEpochSnapshotEnvelopeV2,
  type AgentOsEpochSnapshotClosureContextV2,
  type AgentOsEpochSnapshotEnvelopeV2,
  type AgentOsEpochSnapshotInputV2,
  type AgentOsEpochSnapshotSignerV2,
  type AgentOsEpochSnapshotVerifierV2,
} from '../src/core/vision/agent-os-epoch-snapshot-record.js';
import {
  AGENT_OS_EPOCH_RECORD_AUTHORITY_V1,
  agentOsEpochAttemptIdV1,
} from '../src/core/vision/agent-os-epoch-records.js';
import { AGENT_OS_EPOCH_GENESIS_V1 } from '../src/core/vision/agent-os-rollover-protocol.js';
import type { AgentOsReadModelV1 } from '../src/core/vision/agent-os-read-model.js';

const raw = (label: string): string => createHash('sha256').update(label).digest('hex');
const prefixed = (label: string): string => `sha256:${raw(label)}`;

const HEAD = prefixed('head');
const MANIFEST = prefixed('manifest');
const NAMESPACE = prefixed('namespace');
const TICK = prefixed('tick');
const SOURCE = raw('source');
const POLICY = raw('policy');
const SUCCESSOR_BASE = raw('prior-epoch-snapshot');
const START_RECEIPT = raw('producer-start-receipt');
const PRODUCER = prefixed('producer');
const KEY = raw('key');

function snapshot(): AgentOsReadModelV1 {
  return {
    sourceState: 'healthy',
    livingEndState: {
      northStar: 'Convert governed capacity into durable value.',
      currentBottleneck: 'Authenticated runtime closure',
      revisionLabel: 'Current mission basis',
      evidenceState: 'complete',
    },
    capabilitySpectrum: [{
      lane: 'codex', label: 'Codex', state: 'ready', headroom: 'usable', resetUrgency: 'later',
      resetLabel: 'Reset later', allocationLabel: 'Usable capacity',
    }],
    activeValueBets: [{
      key: raw('bet'), title: 'Value bet 1', valueCase: 'Advance verified runtime evidence.',
      allocationLabel: 'Observe', decision: 'observing', assurance: 'targeted',
      outcome: { state: 'pending', label: 'Pending' },
      evidence: { state: 'complete', label: 'Complete' },
    }],
    nextAction: {
      kind: 'attention', title: 'Verify the epoch', reason: 'A bounded observation is due.',
      evidenceState: 'complete',
    },
  };
}

function tag(bytes: Uint8Array): string {
  return createHash('sha256').update('m558-test-authenticator\0').update(bytes).digest('hex');
}

function crypto(): { signer: AgentOsEpochSnapshotSignerV2; verifier: AgentOsEpochSnapshotVerifierV2 } {
  return {
    signer: {
      producerIdentityDigest: PRODUCER,
      keyId: KEY,
      keyGeneration: 7,
      sign: (bytes) => tag(bytes),
    },
    verifier: {
      producerIdentityDigest: PRODUCER,
      keyId: KEY,
      keyGeneration: 7,
      verify: ({ canonicalDomainSeparatedEnvelope, authenticator }) =>
        tag(canonicalDomainSeparatedEnvelope) === authenticator,
    },
  };
}

function input(overrides: Partial<AgentOsEpochSnapshotInputV2> = {}): AgentOsEpochSnapshotInputV2 {
  const epoch = overrides.epoch ?? 2;
  const attemptNamespaceDigest = overrides.attemptNamespaceDigest ?? NAMESPACE;
  const durableTickDigest = overrides.durableTickDigest ?? TICK;
  return {
    epoch,
    epochSequence: 1,
    anchoredHeadDigest: HEAD,
    epochManifestDigest: MANIFEST,
    attemptNamespaceDigest,
    producerAttemptId: agentOsEpochAttemptIdV1({ epoch, attemptNamespaceDigest, durableTickDigest })!,
    producerStartReceiptDigest: START_RECEIPT,
    durableTickDigest,
    sourceBundleDigest: SOURCE,
    trustPolicyDigest: POLICY,
    previousEnvelopeDigest: SUCCESSOR_BASE,
    renderedAt: '2026-09-03T12:00:00.000Z',
    observedAt: '2026-09-03T12:00:05.000Z',
    kernelCycleDigest: raw('kernel'),
    capabilityProjectionDigest: prefixed('capability'),
    portfolioDigest: raw('portfolio'),
    snapshot: snapshot(),
    snapshotDigest: prefixed('snapshot'),
    ...overrides,
  };
}

function context(
  value: AgentOsEpochSnapshotEnvelopeV2,
  overrides: Partial<AgentOsEpochSnapshotClosureContextV2> = {},
): AgentOsEpochSnapshotClosureContextV2 {
  return {
    epoch: value.epoch,
    anchoredHeadDigest: value.anchoredHeadDigest,
    epochManifestDigest: value.epochManifestDigest,
    attemptNamespaceDigest: value.attemptNamespaceDigest,
    producerAttemptId: value.producerAttemptId,
    producerStartReceiptDigest: value.producerStartReceiptDigest,
    durableTickDigest: value.durableTickDigest,
    sourceBundleDigest: value.sourceBundleDigest,
    trustPolicyDigest: value.trustPolicyDigest,
    snapshotBasePreviousEnvelopeDigest: value.previousEnvelopeDigest,
    expectedSequence: value.epochSequence,
    expectedPreviousEnvelopeDigest: value.previousEnvelopeDigest,
    expectedProducerIdentityDigest: value.producerIdentityDigest,
    expectedAuthenticatorKeyId: value.authenticatorKeyId,
    expectedAuthenticatorKeyGeneration: value.authenticatorKeyGeneration,
    ...overrides,
  };
}

function fixture(overrides: Partial<AgentOsEpochSnapshotInputV2> = {}) {
  const keys = crypto();
  const envelope = createAgentOsEpochSnapshotEnvelopeV2(input(overrides), keys.signer);
  if (!envelope) throw new Error('invalid M558 fixture');
  const closure = context(envelope);
  return {
    ...keys,
    envelope,
    closure,
    closureVerifier: { verify: () => true },
  };
}

describe('M558 epoch-aware snapshot record', () => {
  it('creates deterministic canonical frozen bytes with separated digest domains and all authority false', () => {
    const first = fixture();
    const second = fixture();
    const bytes = canonicalAgentOsEpochSnapshotEnvelopeBytesV2(first.envelope);
    expect(first.envelope).toEqual(second.envelope);
    expect(bytes).not.toBeNull();
    expect(parseAgentOsEpochSnapshotEnvelopeV2(bytes!)).toEqual(first.envelope);
    expect(first.envelope).toMatchObject({
      schemaVersion: 2,
      recordType: 'agent-os-epoch-snapshot',
      epoch: 2,
      epochSequence: 1,
      previousEnvelopeDigest: SUCCESSOR_BASE,
      ...AGENT_OS_EPOCH_RECORD_AUTHORITY_V1,
    });
    expect(Object.isFrozen(first.envelope)).toBe(true);
    expect(Object.isFrozen(first.envelope.payload)).toBe(true);
    expect(Object.isFrozen(first.envelope.payload.snapshot)).toBe(true);
    expect(new Set([
      AGENT_OS_EPOCH_SNAPSHOT_PAYLOAD_DOMAIN_V2,
      AGENT_OS_EPOCH_SNAPSHOT_ENVELOPE_DOMAIN_V2,
      AGENT_OS_EPOCH_SNAPSHOT_AUTHENTICATOR_DOMAIN_V2,
    ]).size).toBe(3);
    expect(verifyAgentOsEpochSnapshotEnvelopeV2(
      first.envelope, first.closure, first.verifier, first.closureVerifier,
    )).toEqual(first.envelope);
  });

  it('accepts sequence one from an explicit non-genesis manifest base and binds later predecessors', () => {
    expect(fixture().envelope.previousEnvelopeDigest).toBe(SUCCESSOR_BASE);

    const prior = fixture().envelope;
    const later = fixture({
      epochSequence: 2,
      previousEnvelopeDigest: prior.envelopeDigest,
      durableTickDigest: prefixed('tick-two'),
      producerAttemptId: agentOsEpochAttemptIdV1({
        epoch: 2, attemptNamespaceDigest: NAMESPACE, durableTickDigest: prefixed('tick-two'),
      })!,
      observedAt: '2026-09-03T12:00:06.000Z',
    });
    expect(verifyAgentOsEpochSnapshotEnvelopeV2(
      later.envelope, later.closure, later.verifier, later.closureVerifier,
    )).toEqual(later.envelope);
    expect(createAgentOsEpochSnapshotEnvelopeV2(input({
      epochSequence: 2,
      previousEnvelopeDigest: AGENT_OS_EPOCH_GENESIS_V1.snapshotTipDigest,
    }), crypto().signer)).toBeNull();
    expect(verifyAgentOsEpochSnapshotEnvelopeV2(
      later.envelope,
      context(later.envelope, { expectedPreviousEnvelopeDigest: raw('rival-predecessor') }),
      later.verifier,
      { verify: () => true },
    )).toBeNull();
  });

  it('derives and verifies the exact prefixed M555 attempt identity', () => {
    const value = fixture();
    expect(value.envelope.producerAttemptId).toBe(agentOsEpochAttemptIdV1({
      epoch: value.envelope.epoch,
      attemptNamespaceDigest: value.envelope.attemptNamespaceDigest,
      durableTickDigest: value.envelope.durableTickDigest,
    }));
    expect(createAgentOsEpochSnapshotEnvelopeV2(input({
      producerAttemptId: prefixed('fabricated-attempt'),
    }), value.signer)).toBeNull();
  });

  it.each([
    ['epoch', { epoch: 3 }],
    ['head', { anchoredHeadDigest: prefixed('rival-head') }],
    ['manifest', { epochManifestDigest: prefixed('rival-manifest') }],
    ['namespace', { attemptNamespaceDigest: prefixed('rival-namespace') }],
    ['attempt', { producerAttemptId: prefixed('rival-attempt') }],
    ['start receipt', { producerStartReceiptDigest: raw('rival-start-receipt') }],
    ['tick', { durableTickDigest: prefixed('rival-tick') }],
    ['source', { sourceBundleDigest: raw('rival-source') }],
    ['policy', { trustPolicyDigest: raw('rival-policy') }],
    ['sequence', { expectedSequence: 2 }],
    ['producer', { expectedProducerIdentityDigest: prefixed('rival-producer') }],
    ['key', { expectedAuthenticatorKeyId: raw('rival-key') }],
    ['key generation', { expectedAuthenticatorKeyGeneration: 8 }],
  ] as Array<[string, Partial<AgentOsEpochSnapshotClosureContextV2>]>)(
    'rejects %s closure substitution even under a permissive context verifier', (_label, replacement) => {
    const value = fixture();
    expect(verifyAgentOsEpochSnapshotEnvelopeV2(
      value.envelope, context(value.envelope, replacement), value.verifier, { verify: () => true },
    )).toBeNull();
    },
  );

  it('keeps control, record, identity, and component digest formats exact', () => {
    const keys = crypto();
    for (const replacement of [
      { anchoredHeadDigest: raw('wrong-head-format') },
      { epochManifestDigest: raw('wrong-manifest-format') },
      { attemptNamespaceDigest: raw('wrong-namespace-format') },
      { durableTickDigest: raw('wrong-tick-format') },
      { sourceBundleDigest: prefixed('wrong-source-format') },
      { trustPolicyDigest: prefixed('wrong-policy-format') },
      { previousEnvelopeDigest: prefixed('wrong-predecessor-format') },
      { producerStartReceiptDigest: prefixed('wrong-start-receipt-format') },
      { kernelCycleDigest: prefixed('wrong-kernel-format') },
      { capabilityProjectionDigest: raw('wrong-capability-format') },
      { portfolioDigest: prefixed('wrong-portfolio-format') },
      { snapshotDigest: raw('wrong-snapshot-format') },
    ]) {
      expect(createAgentOsEpochSnapshotEnvelopeV2(input(replacement), keys.signer)).toBeNull();
    }
    expect(createAgentOsEpochSnapshotEnvelopeV2(input(), {
      ...keys.signer, producerIdentityDigest: raw('wrong-producer-format'),
    })).toBeNull();
    expect(createAgentOsEpochSnapshotEnvelopeV2(input(), {
      ...keys.signer, keyId: prefixed('wrong-key-format'),
    })).toBeNull();
  });

  it('rejects payload, component, envelope, and authenticator tampering', () => {
    const value = fixture();
    for (const candidate of [
      { ...value.envelope, payloadDigest: raw('tampered-payload') },
      { ...value.envelope, kernelCycleDigest: raw('tampered-kernel') },
      { ...value.envelope, producerStartReceiptDigest: raw('tampered-start-receipt') },
      { ...value.envelope, envelopeDigest: raw('tampered-envelope') },
      { ...value.envelope, authenticator: raw('tampered-authenticator') },
      { ...value.envelope, payload: {
        ...value.envelope.payload, snapshotDigest: prefixed('tampered-snapshot'),
      } },
    ]) {
      expect(verifyAgentOsEpochSnapshotEnvelopeV2(
        candidate, value.closure, value.verifier, value.closureVerifier,
      )).toBeNull();
    }
  });

  it('rejects noncanonical bytes, duplicate keys, unknown fields, accessors, cycles, sparse arrays, and V1 records', () => {
    const value = fixture();
    const bytes = canonicalAgentOsEpochSnapshotEnvelopeBytesV2(value.envelope)!;
    expect(parseAgentOsEpochSnapshotEnvelopeV2(Buffer.concat([bytes, Buffer.from('\n')]))).toBeNull();
    expect(parseAgentOsEpochSnapshotEnvelopeV2(Buffer.from(
      `{"schemaVersion":2,${bytes.toString('utf8').slice(1)}`,
    ))).toBeNull();
    expect(canonicalAgentOsEpochSnapshotEnvelopeBytesV2({ ...value.envelope, extra: false })).toBeNull();
    const accessor = { ...value.envelope } as Record<string, unknown>;
    Object.defineProperty(accessor, 'epoch', { enumerable: true, get: () => 2 });
    expect(canonicalAgentOsEpochSnapshotEnvelopeBytesV2(accessor)).toBeNull();
    const cycle = { ...value.envelope } as Record<string, unknown>;
    cycle['payload'] = cycle;
    expect(canonicalAgentOsEpochSnapshotEnvelopeBytesV2(cycle)).toBeNull();
    const sparse = { ...value.envelope, payload: {
      ...value.envelope.payload,
      snapshot: { ...value.envelope.payload.snapshot, capabilitySpectrum: new Array(1) },
    } };
    expect(canonicalAgentOsEpochSnapshotEnvelopeBytesV2(sparse)).toBeNull();
    expect(canonicalAgentOsEpochSnapshotEnvelopeBytesV2({
      schemaVersion: 1, protocol: 'agent-os-snapshot-envelope-v1', recordType: 'agent-os-snapshot',
    })).toBeNull();
  });

  it('contains signer and verifier mutation, exceptions, and callback-owned data', () => {
    let signerSawOwnedBytes = false;
    const value = input();
    const signed = createAgentOsEpochSnapshotEnvelopeV2(value, {
      ...crypto().signer,
      sign: (bytes) => {
        signerSawOwnedBytes = bytes instanceof Uint8Array;
        bytes.fill(0);
        return raw('invalid-after-signer-mutation');
      },
    });
    expect(signerSawOwnedBytes).toBe(true);
    expect(signed).toBeNull();
    expect(value.snapshot.sourceState).toBe('healthy');

    const fixtureValue = fixture();
    let contextFrozen = false;
    const maliciousContext = {
      verify: (candidate: AgentOsEpochSnapshotClosureContextV2) => {
        contextFrozen = Object.isFrozen(candidate);
        expect(() => { (candidate as { epoch: number }).epoch = 99; }).toThrow();
        return true;
      },
    };
    const maliciousVerifier = {
      ...fixtureValue.verifier,
      verify: vi.fn((request) => {
        request.canonicalDomainSeparatedEnvelope.fill(0);
        return true;
      }),
    } satisfies AgentOsEpochSnapshotVerifierV2;
    expect(verifyAgentOsEpochSnapshotEnvelopeV2(
      fixtureValue.envelope, fixtureValue.closure, maliciousVerifier, maliciousContext,
    )).toBeNull();
    expect(contextFrozen).toBe(true);
    expect(verifyAgentOsEpochSnapshotEnvelopeV2(
      fixtureValue.envelope, fixtureValue.closure, { ...fixtureValue.verifier, verify: () => { throw new Error('no key'); } },
      fixtureValue.closureVerifier,
    )).toBeNull();
  });

  it('has no filesystem, runtime, configuration, network, or effect edge', async () => {
    const source = await readFile(new URL(
      '../src/core/vision/agent-os-epoch-snapshot-record.ts', import.meta.url,
    ), 'utf8');
    expect(source).not.toMatch(/from ['"]node:(?:fs|child_process|http|https|net|tls)['"]/u);
    expect(source).not.toMatch(/from ['"].*(?:daemon|config|web|effect|provider).*['"]/u);
    expect(source).not.toMatch(/(?:mkdir|writeFile|appendFile|rename|unlink|spawn|fetch)\s*\(/u);
  });
});
