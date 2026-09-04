import {
  createAgentOsObservationIsolationPrepareAttestationV2,
  verifyAgentOsObservationIsolationPrepareAttestationV2,
} from '../src/core/vision/agent-os-observation-isolation-v2.js';
import {
  createHash,
  generateKeyPairSync,
  sign as signEd25519,
  verify as verifyEd25519,
} from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EXECUTION_CAPACITY_EVIDENCE_V1_PROTOCOL,
  ExecutionCapacityLeaseStoreV1,
  canonicalExecutionCapacityEvidenceBytesV1,
  digestExecutionCapacityEvidenceV1,
  type ExecutionCapacityEvidenceEnvelopeV1,
  type ExecutionCapacityEvidenceUnsignedV1,
} from '../src/core/fabric/execution-capacity-lease.js';
import {
  AgentOsLocalContainerBrokerV1,
  type AgentOsLocalContainerBrokerDependenciesV1,
  type AgentOsLocalContainerBrokerEngineV1,
} from '../src/core/daemon/agent-os-local-container-broker.js';
import {
  AgentOsLocalContainerBrokerJournalV1,
  agentOsLocalContainerBrokerRequestNonceDigestV1,
  agentOsLocalContainerBrokerRunIdV1,
  type AgentOsLocalContainerBrokerJournalRecordV1,
  type AgentOsLocalContainerBrokerJournalStageV1,
} from
  '../src/core/daemon/agent-os-local-container-broker-journal.js';
import {
  agentOsDockerContainerNameV1,
  agentOsDockerEngineCreateRequestDigestV1,
} from '../src/core/daemon/agent-os-docker-engine-client.js';
import {
  AGENT_OS_LOCAL_CONTAINER_DISPATCH_PERMIT_SIGNATURE_ALGORITHM_V1,
  AGENT_OS_LOCAL_CONTAINER_DISPATCH_PERMIT_V1,
  AGENT_OS_LOCAL_CONTAINER_DISPATCH_SCOPE_V1,
  canonicalAgentOsLocalContainerDispatchPermitBytesV1,
  digestAgentOsLocalContainerDispatchPermitV1,
  type AgentOsLocalContainerDispatchPermitEnvelopeV1,
  type AgentOsLocalContainerDispatchPermitUnsignedV1,
} from '../src/core/vision/agent-os-local-container-dispatch-permit.js';
import {
  buildAgentOsLocalContainerCreatePolicyV1,
  type AgentOsLocalContainerCreatePolicyV1,
} from '../src/core/vision/agent-os-local-container-policy.js';
import {
  createAgentOsObservationSandboxRequestV1,
  createAgentOsObservationSandboxResponseV1,
  verifyAgentOsObservationSandboxRequestV1,
  type AgentOsObservationSandboxFrameSignerV1,
  type AgentOsObservationSandboxFrameVerifierV1,
  type AgentOsObservationSandboxRequestV1,
} from '../src/core/vision/agent-os-observation-sandbox.js';

const raw = (label: string): string => createHash('sha256').update(`m567-broker\0${label}`).digest('hex');
const prefixed = (label: string): string => `sha256:${raw(label)}`;
const NOW = Date.parse('2026-09-04T20:00:00.000Z');
const BROKER_DIGEST = raw('broker');
const ENGINE_DIGEST = raw('engine');
const CONTAINER_ID = raw('container');
const SECCOMP = Buffer.from('{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}', 'utf8');
const permitPair = generateKeyPairSync('ed25519');
const isolationPair = generateKeyPairSync('ed25519');
const capacityPair = generateKeyPairSync('ed25519');
const PERMIT_KEY_ID = raw('permit-key');
const ISOLATION_KEY_ID = raw('isolation-key');
const REQUEST_KEY_ID = raw('request-key');
const RESPONSE_KEY_ID = raw('response-key');
const CAPACITY_KEY_ID = prefixed('capacity-key');
const REQUEST_HMAC_KEY = Buffer.from('request-frame-key');
const RESPONSE_HMAC_KEY = Buffer.from('response-frame-key');

function hmac(key: Buffer, bytes: Uint8Array): string {
  return createHash('sha256').update(key).update(Buffer.from(bytes)).digest('hex');
}

const requestSigner: AgentOsObservationSandboxFrameSignerV1 = {
  keyId: REQUEST_KEY_ID,
  authenticate: (bytes) => hmac(REQUEST_HMAC_KEY, bytes),
};
const requestVerifier: AgentOsObservationSandboxFrameVerifierV1 = {
  keyId: REQUEST_KEY_ID,
  verify: ({ canonicalDomainSeparatedFrame, authenticator }) =>
    hmac(REQUEST_HMAC_KEY, canonicalDomainSeparatedFrame) === authenticator,
};
const responseSigner: AgentOsObservationSandboxFrameSignerV1 = {
  keyId: RESPONSE_KEY_ID,
  authenticate: (bytes) => hmac(RESPONSE_HMAC_KEY, bytes),
};
const responseVerifier: AgentOsObservationSandboxFrameVerifierV1 = {
  keyId: RESPONSE_KEY_ID,
  verify: ({ canonicalDomainSeparatedFrame, authenticator }) =>
    hmac(RESPONSE_HMAC_KEY, canonicalDomainSeparatedFrame) === authenticator,
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
}

function policy(): AgentOsLocalContainerCreatePolicyV1 {
  const result = buildAgentOsLocalContainerCreatePolicyV1({
    image: `ghcr.io/ashlrai/agent-os-observer@sha256:${raw('image')}`,
    producerDigest: raw('producer'),
    allowedProducerDigests: [raw('producer')],
    user: '65532:65532',
    workingDir: '/workspace',
    seccompProfileDigest: createHash('sha256').update(SECCOMP).digest('hex'),
    limits: {
      cpuNanoCpus: 500_000_000,
      memoryBytes: 128 * 1024 * 1024,
      memorySwapBytes: 128 * 1024 * 1024,
      pidsLimit: 1,
      maxDurationMs: 60_000,
      maxOutputBytes: 1024,
      cleanupStartGraceMs: 1_000,
    },
  });
  if (!result.policy) throw new Error('policy fixture failed');
  return result.policy;
}

function request(overrides: Partial<{ deadlineAt: string; requestNonce: string }> = {}):
AgentOsObservationSandboxRequestV1 {
  const input = Buffer.from('{"observe":true}', 'utf8');
  const created = createAgentOsObservationSandboxRequestV1({
    requestId: raw('request-id'),
    requestNonce: overrides.requestNonce ?? raw('request-nonce'),
    epoch: 1,
    durableTickDigest: prefixed('tick'),
    attemptId: prefixed('attempt'),
    startReceiptDigest: raw('start'),
    issuedAt: new Date(NOW - 1_000).toISOString(),
    deadlineAt: overrides.deadlineAt ?? new Date(NOW + 60_000).toISOString(),
    maxOutputBytes: policy().limits.maxOutputBytes,
    inputBytes: input.byteLength,
    inputDigest: createHash('sha256').update(input).digest('hex'),
    inputBase64: input.toString('base64'),
  }, {
    expectedBackendIdentityDigest: BROKER_DIGEST,
    expectedPolicyDigest: buildAgentOsLocalContainerCreatePolicyV1({
      image: policy().image,
      producerDigest: policy().producer.digest,
      allowedProducerDigests: [...policy().producer.allowedDigests],
      user: policy().user,
      workingDir: policy().workingDir,
      seccompProfileDigest: policy().seccompProfileDigest,
      limits: { ...policy().limits },
    }).createConfigDigest!,
    requestSigner,
  });
  if (!created) throw new Error('request fixture failed');
  return created;
}

function evidence(expiresAt = new Date(NOW + 120_000).toISOString()): ExecutionCapacityEvidenceEnvelopeV1 {
  const unsigned: ExecutionCapacityEvidenceUnsignedV1 = {
    schemaVersion: 1,
    protocol: EXECUTION_CAPACITY_EVIDENCE_V1_PROTOCOL,
    authority: 'observation-only',
    executionAuthority: false,
    providerContactAuthority: false,
    routingMutation: false,
    verifierIdentityDigest: CAPACITY_KEY_ID,
    executionIdentityDigest: prefixed('execution-identity'),
    observationEpoch: 1,
    trustedSlots: 1,
    observedAt: new Date(NOW - 1_000).toISOString(),
    expiresAt,
  };
  return {
    ...unsigned,
    evidenceDigest: digestExecutionCapacityEvidenceV1(unsigned),
    authenticator: signEd25519(
      null, canonicalExecutionCapacityEvidenceBytesV1(unsigned), capacityPair.privateKey,
    ).toString('base64url'),
  };
}

function permit(
  selectedRequest: AgentOsObservationSandboxRequestV1,
  selectedEvidence: ExecutionCapacityEvidenceEnvelopeV1,
): AgentOsLocalContainerDispatchPermitEnvelopeV1 {
  const selectedPolicy = policy();
  const configDigest = buildAgentOsLocalContainerCreatePolicyV1({
    image: selectedPolicy.image,
    producerDigest: selectedPolicy.producer.digest,
    allowedProducerDigests: [...selectedPolicy.producer.allowedDigests],
    user: selectedPolicy.user,
    workingDir: selectedPolicy.workingDir,
    seccompProfileDigest: selectedPolicy.seccompProfileDigest,
    limits: { ...selectedPolicy.limits },
  }).createConfigDigest!;
  const unsigned: AgentOsLocalContainerDispatchPermitUnsignedV1 = {
    schemaVersion: 1,
    protocol: AGENT_OS_LOCAL_CONTAINER_DISPATCH_PERMIT_V1,
    permitId: raw(`permit-${selectedRequest.requestNonce}`),
    keyId: PERMIT_KEY_ID,
    issuedAt: new Date(NOW - 1_000).toISOString(),
    expiresAt: new Date(NOW + 120_000).toISOString(),
    scope: { ...AGENT_OS_LOCAL_CONTAINER_DISPATCH_SCOPE_V1 },
    bindings: {
      requestNonce: selectedRequest.requestNonce,
      requestDigest: selectedRequest.requestDigest,
      deadlineAt: selectedRequest.deadlineAt,
      brokerDigest: BROKER_DIGEST,
      engineDigest: ENGINE_DIGEST,
      imageDigest: raw('image'),
      producerDigest: selectedPolicy.producer.digest,
      seccompDigest: selectedPolicy.seccompProfileDigest,
      createConfigDigest: configDigest,
      executionIdentityDigest: selectedEvidence.executionIdentityDigest,
      capacityEvidenceDigest: selectedEvidence.evidenceDigest,
      slots: 1,
    },
  };
  const bytes = canonicalAgentOsLocalContainerDispatchPermitBytesV1(unsigned)!;
  return {
    ...unsigned,
    signatureAlgorithm: AGENT_OS_LOCAL_CONTAINER_DISPATCH_PERMIT_SIGNATURE_ALGORITHM_V1,
    permitDigest: digestAgentOsLocalContainerDispatchPermitV1(unsigned)!,
    signature: signEd25519(null, bytes, permitPair.privateKey).toString('base64url'),
  };
}

interface FakeEngine extends AgentOsLocalContainerBrokerEngineV1 {
  inspectEngine: ReturnType<typeof vi.fn>;
  createContainer: ReturnType<typeof vi.fn>;
  inspectContainer: ReturnType<typeof vi.fn>;
  resolveContainerIdByName: ReturnType<typeof vi.fn>;
  openAttachment: ReturnType<typeof vi.fn>;
  startContainer: ReturnType<typeof vi.fn>;
  waitContainer: ReturnType<typeof vi.fn>;
  killContainer: ReturnType<typeof vi.fn>;
  removeContainer: ReturnType<typeof vi.fn>;
  confirmContainerAbsent: ReturnType<typeof vi.fn>;
}

function engine(selectedRequest: AgentOsObservationSandboxRequestV1): FakeEngine {
  const output = Buffer.from('{"observed":true}', 'utf8');
  const response = createAgentOsObservationSandboxResponseV1({
    schemaVersion: 1,
    protocol: 'ashlr-agent-os-observation-sandbox-v1',
    requestId: selectedRequest.requestId,
    requestDigest: selectedRequest.requestDigest,
    backendIdentityDigest: selectedRequest.backendIdentityDigest,
    policyDigest: selectedRequest.policyDigest,
    outcome: 'succeeded',
    process: {
      pid: 7,
      executableDigest: policy().producer.digest,
      instanceNonce: raw('instance'),
      launchedAt: new Date(NOW).toISOString(),
    },
    finishedAt: new Date(NOW).toISOString(),
    outputBytes: output.byteLength,
    outputDigest: createHash('sha256').update(output).digest('hex'),
    outputBase64: output.toString('base64'),
  }, responseSigner)!;
  const stdout = Buffer.from(`${canonicalJson(response)}\n`, 'utf8');
  const inspection = {
    containerId: CONTAINER_ID,
    containerName: 'unused',
    inspectionDigest: raw('inspection'),
    effectivePolicyMatched: true,
    policyMismatchReasons: [],
    running: false,
    exitCode: 0,
    oomKilled: false,
    startedAt: new Date(NOW).toISOString(),
    finishedAt: new Date(NOW).toISOString(),
  };
  return {
    inspectEngine: vi.fn(async () => ({ ok: true, value: {
      engineDigest: ENGINE_DIGEST, apiVersion: '1.54', minApiVersion: '1.40', version: 'fixture',
      gitCommit: 'fixture', os: 'linux', arch: 'arm64', socketDevice: '1', socketInode: '2',
    } })),
    createContainer: vi.fn(async () => ({ ok: true, value: {
      containerId: CONTAINER_ID, engineCreateRequestDigest: raw('engine-create'),
    } })),
    inspectContainer: vi.fn(async () => ({ ok: true, value: inspection })),
    resolveContainerIdByName: vi.fn(async () => ({ ok: false, reason: 'container-not-found' })),
    openAttachment: vi.fn(async () => ({ ok: true, value: {
      writeAndClose: vi.fn(() => true),
      abort: vi.fn(),
      completion: Promise.resolve({ ok: true, value: {
        stdout, stderrBytes: 0, stderrDigest: raw('stderr'),
        transportBytes: stdout.byteLength, truncated: false,
      } }),
    } })),
    startContainer: vi.fn(async () => ({ ok: true, value: true })),
    waitContainer: vi.fn(async () => ({ ok: true, value: {
      statusCode: 0, waitEvidenceDigest: raw('wait'),
    } })),
    killContainer: vi.fn(async () => ({ ok: true, value: true })),
    removeContainer: vi.fn(async () => ({ ok: true, value: true })),
    confirmContainerAbsent: vi.fn(async () => ({ ok: true, value: true })),
  } as unknown as FakeEngine;
}

interface Fixture {
  anchor: string;
  capacityRoot: string;
  journalRoot: string;
  capacityStore: ExecutionCapacityLeaseStoreV1;
  journal: AgentOsLocalContainerBrokerJournalV1;
}

const fixtures: Fixture[] = [];

function fixture(enabled = true): Fixture {
  const anchor = mkdtempSync(join(tmpdir(), 'ashlr-m567-broker-'));
  chmodSync(anchor, 0o700);
  const capacityRoot = join(anchor, 'capacity');
  const journalRoot = join(anchor, 'journal');
  const capacityStore = new ExecutionCapacityLeaseStoreV1({
    anchorPath: anchor,
    rootPath: capacityRoot,
    enabled,
    verifier: {
      verifierIdentityDigest: CAPACITY_KEY_ID,
      verify: ({ canonicalDomainSeparatedEnvelope, authenticator }) => verifyEd25519(
        null, Buffer.from(canonicalDomainSeparatedEnvelope), capacityPair.publicKey,
        Buffer.from(authenticator, 'base64url'),
      ),
    },
    clock: () => new Date(NOW),
    lockWaitMs: 0,
  });
  const journal = new AgentOsLocalContainerBrokerJournalV1({
    anchorPath: anchor, rootPath: journalRoot, enabled, clock: () => new Date(NOW), lockWaitMs: 0,
  });
  const value = { anchor, capacityRoot, journalRoot, capacityStore, journal };
  fixtures.push(value);
  return value;
}

function broker(
  value: Fixture,
  fake: FakeEngine,
  enabled = true,
  overrides: Partial<AgentOsLocalContainerBrokerDependenciesV1> = {},
): AgentOsLocalContainerBrokerV1 {
  return new AgentOsLocalContainerBrokerV1({
    enabled,
    brokerDigest: BROKER_DIGEST,
    expectedEngineDigest: ENGINE_DIGEST,
    policy: policy(),
    seccompProfile: SECCOMP,
    permitVerifier: {
      keyId: PERMIT_KEY_ID,
      verify: ({ canonicalDomainSeparatedPermit, signature }) => verifyEd25519(
        null, Buffer.from(canonicalDomainSeparatedPermit), permitPair.publicKey, Buffer.from(signature),
      ),
    },
    requestVerifier,
    responseVerifier,
    isolationSigner: {
      keyId: ISOLATION_KEY_ID,
      sign: (bytes) => signEd25519(null, Buffer.from(bytes), isolationPair.privateKey),
    },
    isolationVerifier: {
      keyId: ISOLATION_KEY_ID,
      verify: ({ canonicalDomainSeparatedAttestation, signature }) => verifyEd25519(
        null, Buffer.from(canonicalDomainSeparatedAttestation), isolationPair.publicKey, Buffer.from(signature),
      ),
    },
    capacityStore: value.capacityStore,
    journal: value.journal,
    engine: fake,
    clock: () => new Date(NOW),
    ...overrides,
  });
}

function beginActiveJournal(
  value: Fixture,
  selectedRequest: AgentOsObservationSandboxRequestV1,
  selectedEvidence: ExecutionCapacityEvidenceEnvelopeV1,
  targetStage: Extract<AgentOsLocalContainerBrokerJournalStageV1, 'lease-held' | 'created' | 'removed'>,
): AgentOsLocalContainerBrokerJournalRecordV1 {
  const selectedPolicy = policy();
  const selectedPermit = permit(selectedRequest, selectedEvidence);
  const inspected = buildAgentOsLocalContainerCreatePolicyV1({
    image: selectedPolicy.image,
    producerDigest: selectedPolicy.producer.digest,
    allowedProducerDigests: [...selectedPolicy.producer.allowedDigests],
    user: selectedPolicy.user,
    workingDir: selectedPolicy.workingDir,
    seccompProfileDigest: selectedPolicy.seccompProfileDigest,
    limits: { ...selectedPolicy.limits },
  });
  const acquired = value.journal.acquireLifecycleLock();
  if (acquired.state !== 'acquired') throw new Error('journal lock fixture failed');
  try {
    let mutation = value.journal.begin({
      runId: agentOsLocalContainerBrokerRunIdV1(selectedRequest.requestNonce)!,
      requestNonceDigest: agentOsLocalContainerBrokerRequestNonceDigestV1(selectedRequest.requestNonce)!,
      requestDigest: selectedRequest.requestDigest,
      permitDigest: selectedPermit.permitDigest,
      brokerDigest: BROKER_DIGEST,
      engineDigest: ENGINE_DIGEST,
      imageDigest: raw('image'),
      producerDigest: selectedPolicy.producer.digest,
      seccompDigest: selectedPolicy.seccompProfileDigest,
      createConfigDigest: inspected.createConfigDigest!,
      executionIdentityDigest: selectedEvidence.executionIdentityDigest,
      capacityEvidenceDigest: selectedEvidence.evidenceDigest,
      allocationDigest: prefixed('recovery-allocation'),
      leaseEpoch: 1,
      containerName: agentOsDockerContainerNameV1(selectedRequest.requestNonce)!,
      containerId: null,
      engineCreateRequestDigest: null,
      prestartInspectionDigest: null,
      finalInspectionDigest: null,
      prepareAttestationDigest: null,
      finalAttestationDigest: null,
      removalEvidenceDigest: null,
      outcome: null,
    }, acquired.lock);
    if (!mutation.ok) throw new Error(mutation.reason);
    if (targetStage !== 'lease-held') {
      mutation = value.journal.advance(mutation.record.runId, mutation.record.recordDigest, 'created', {
        containerId: CONTAINER_ID,
        engineCreateRequestDigest: agentOsDockerEngineCreateRequestDigestV1(selectedPolicy, SECCOMP),
      }, acquired.lock);
      if (!mutation.ok) throw new Error(mutation.reason);
    }
    if (targetStage === 'removed') {
      mutation = value.journal.advance(mutation.record.runId, mutation.record.recordDigest, 'removed', {
        removalEvidenceDigest: raw('recovery-removal'),
      }, acquired.lock);
      if (!mutation.ok) throw new Error(mutation.reason);
    }
    return mutation.record;
  } finally {
    value.journal.releaseLifecycleLock(acquired.lock);
  }
}

afterEach(() => {
  for (const value of fixtures.splice(0)) rmSync(value.anchor, { recursive: true, force: true });
});

describe('M567 default-off local-container broker', () => {
  it('performs no I/O and returns no authority when disabled', async () => {
    const value = fixture(false);
    const selectedRequest = request();
    const selectedEvidence = evidence();
    const fake = engine(selectedRequest);
    expect(await broker(value, fake, false).run({
      request: selectedRequest, permit: permit(selectedRequest, selectedEvidence),
      capacityEvidence: selectedEvidence,
    })).toMatchObject({
      state: 'withheld', reason: 'disabled', executionAuthority: false,
      commissioningAuthority: false, productionAuthorized: false,
      replayAdmissionConsumed: false, containerRemovalConfirmed: false, capacityReleased: false,
    });
    expect(fake.inspectEngine).not.toHaveBeenCalled();
    expect(() => readdirSync(value.capacityRoot)).toThrow();
    expect(() => readdirSync(value.journalRoot)).toThrow();
  });

  it('runs one exact request, removes before releasing capacity, and returns verified output only', async () => {
    const value = fixture();
    const selectedRequest = request();
    const selectedEvidence = evidence();
    const fake = engine(selectedRequest);
    expect(verifyAgentOsObservationSandboxRequestV1(selectedRequest, requestVerifier)).not.toBeNull();
    const selectedPolicy = policy();
    const configDigest = buildAgentOsLocalContainerCreatePolicyV1({
      image: selectedPolicy.image,
      producerDigest: selectedPolicy.producer.digest,
      allowedProducerDigests: [...selectedPolicy.producer.allowedDigests],
      user: selectedPolicy.user,
      workingDir: selectedPolicy.workingDir,
      seccompProfileDigest: selectedPolicy.seccompProfileDigest,
      limits: { ...selectedPolicy.limits },
    }).createConfigDigest!;
    const bindings = {
      requestNonce: selectedRequest.requestNonce, requestDigest: selectedRequest.requestDigest,
      deadlineAt: selectedRequest.deadlineAt, containerId: CONTAINER_ID,
      brokerDigest: BROKER_DIGEST, engineDigest: ENGINE_DIGEST, imageDigest: raw('image'),
      producerDigest: selectedPolicy.producer.digest, seccompDigest: selectedPolicy.seccompProfileDigest,
      createConfigDigest: configDigest, limits: { ...selectedPolicy.limits },
    };
    const isolationSigner = {
      keyId: ISOLATION_KEY_ID,
      sign: (bytes: Uint8Array) => signEd25519(null, Buffer.from(bytes), isolationPair.privateKey),
    };
    const prepared = createAgentOsObservationIsolationPrepareAttestationV2({
      ...bindings, issuedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 120_000).toISOString(),
    }, isolationSigner);
    expect(prepared).not.toBeNull();
    const preparationInspection = verifyAgentOsObservationIsolationPrepareAttestationV2(prepared, bindings, selectedPolicy, {
      keyId: ISOLATION_KEY_ID,
      verify: ({ canonicalDomainSeparatedAttestation, signature }) => verifyEd25519(
        null, Buffer.from(canonicalDomainSeparatedAttestation), isolationPair.publicKey, Buffer.from(signature),
      ),
    }, NOW);
    expect(preparationInspection.reason).toBe('attestation-verified');
    const completed = await broker(value, fake).run({
      request: selectedRequest, permit: permit(selectedRequest, selectedEvidence),
      capacityEvidence: selectedEvidence,
    });
    expect(completed).toMatchObject({
      state: 'completed', reason: 'succeeded', requestDigest: selectedRequest.requestDigest,
      replayAdmissionConsumed: true, containerRemovalConfirmed: true, capacityReleased: true,
      executionAuthority: false, commissioningAuthority: false, productionAuthorized: false,
      brokerTruthIndependentlyVerified: false, dockerEnforcementVerified: false,
      prepareAttestation: { phase: 'prepared' }, finalizeAttestation: { phase: 'finalized' },
    });
    expect(Buffer.from(completed.output!).toString('utf8')).toBe('{"observed":true}');
    expect(fake.createContainer).toHaveBeenCalledOnce();
    expect(fake.startContainer).toHaveBeenCalledOnce();
    expect(fake.removeContainer.mock.invocationCallOrder[0]).toBeLessThan(
      fake.confirmContainerAbsent.mock.invocationCallOrder[0]!,
    );
    expect(value.capacityStore.inspect().leases[0]).toMatchObject({ state: 'released' });
    expect(value.journal.inspect()).toMatchObject({ complete: true, activeRuns: [], terminalRunCount: 1 });
    const journalText = readdirSync(join(value.journalRoot, 'records')).map((file) =>
      readFileSync(join(value.journalRoot, 'records', file), 'utf8')).join('');
    expect(journalText).not.toContain('ecap_');
    expect(JSON.stringify(completed)).not.toContain('ecap_');
  });

  it('uses the capacity tombstone as nonce consumption and never starts a replay', async () => {
    const value = fixture();
    const selectedRequest = request();
    const selectedEvidence = evidence();
    const fake = engine(selectedRequest);
    const selectedBroker = broker(value, fake);
    expect((await selectedBroker.run({
      request: selectedRequest, permit: permit(selectedRequest, selectedEvidence),
      capacityEvidence: selectedEvidence,
    })).state).toBe('completed');
    const replay = await selectedBroker.run({
      request: selectedRequest, permit: permit(selectedRequest, selectedEvidence),
      capacityEvidence: selectedEvidence,
    });
    expect(replay).toMatchObject({
      state: 'withheld', reason: 'capacity-withheld', replayAdmissionConsumed: false,
    });
    expect(fake.createContainer).toHaveBeenCalledOnce();
    expect(fake.startContainer).toHaveBeenCalledOnce();
  });

  it('denies forged permits and hostile request shapes before engine access', async () => {
    const value = fixture();
    const selectedRequest = request();
    const selectedEvidence = evidence();
    const fake = engine(selectedRequest);
    const forged = { ...permit(selectedRequest, selectedEvidence),
      signature: Buffer.alloc(64, 3).toString('base64url') };
    expect(await broker(value, fake).run({
      request: selectedRequest, permit: forged, capacityEvidence: selectedEvidence,
    })).toMatchObject({ state: 'withheld', reason: 'permit-withheld' });
    expect(fake.inspectEngine).not.toHaveBeenCalled();
    expect(await broker(value, fake).run(new Proxy({
      request: selectedRequest, permit: permit(selectedRequest, selectedEvidence),
      capacityEvidence: selectedEvidence,
    }, {}))).toMatchObject({ state: 'withheld', reason: 'invalid-input' });
    expect(fake.inspectEngine).not.toHaveBeenCalled();
  });

  it('captures verifier capabilities once and rejects dependency accessors without invoking them', async () => {
    const value = fixture();
    const selectedRequest = request();
    const selectedEvidence = evidence();
    const fake = engine(selectedRequest);
    const pinnedRequestVerifier = { ...requestVerifier };
    const selectedBroker = broker(value, fake, true, { requestVerifier: pinnedRequestVerifier });
    pinnedRequestVerifier.verify = () => false;
    expect((await selectedBroker.run({
      request: selectedRequest,
      permit: permit(selectedRequest, selectedEvidence),
      capacityEvidence: selectedEvidence,
    })).state).toBe('completed');

    let getterCalls = 0;
    const hostile = {} as AgentOsLocalContainerBrokerDependenciesV1;
    Object.defineProperty(hostile, 'enabled', {
      enumerable: true,
      get: () => { getterCalls += 1; return true; },
    });
    expect(await new AgentOsLocalContainerBrokerV1(hostile).run({
      request: selectedRequest,
      permit: permit(selectedRequest, selectedEvidence),
      capacityEvidence: selectedEvidence,
    })).toMatchObject({ state: 'withheld', reason: 'disabled' });
    expect(getterCalls).toBe(0);
  });

  it('releases a too-short capacity window without creating a container', async () => {
    const value = fixture();
    const selectedRequest = request();
    const selectedEvidence = evidence(new Date(NOW + 80_000).toISOString());
    const fake = engine(selectedRequest);
    expect(await broker(value, fake).run({
      request: selectedRequest, permit: permit(selectedRequest, selectedEvidence),
      capacityEvidence: selectedEvidence,
    })).toMatchObject({
      state: 'withheld', reason: 'capacity-window-insufficient', replayAdmissionConsumed: true,
      capacityReleased: true,
    });
    expect(fake.createContainer).not.toHaveBeenCalled();
    expect(fake.startContainer).not.toHaveBeenCalled();
  });

  it('rechecks the signed dispatch window immediately before create', async () => {
    const value = fixture();
    const selectedRequest = request({ deadlineAt: new Date(NOW + 100).toISOString() });
    const selectedEvidence = evidence();
    const fake = engine(selectedRequest);
    const brokerNow = { value: NOW };
    fake.inspectEngine.mockImplementationOnce(async () => {
      brokerNow.value = NOW + 101;
      return { ok: true, value: {
        engineDigest: ENGINE_DIGEST, apiVersion: '1.54', minApiVersion: '1.40', version: 'fixture',
        gitCommit: 'fixture', os: 'linux', arch: 'arm64', socketDevice: '1', socketInode: '2',
      } };
    });

    expect(await broker(value, fake, true, { clock: () => new Date(brokerNow.value) }).run({
      request: selectedRequest,
      permit: permit(selectedRequest, selectedEvidence),
      capacityEvidence: selectedEvidence,
    })).toMatchObject({
      state: 'withheld', reason: 'deadline-exceeded', replayAdmissionConsumed: true,
      capacityReleased: true, containerRemovalConfirmed: false,
    });
    expect(fake.createContainer).not.toHaveBeenCalled();
    expect(fake.startContainer).not.toHaveBeenCalled();
    expect(value.journal.inspect()).toMatchObject({ activeRuns: [], terminalRunCount: 1 });
  });

  it('rechecks the signed dispatch window immediately before start', async () => {
    const value = fixture();
    const selectedRequest = request({ deadlineAt: new Date(NOW + 100).toISOString() });
    const selectedEvidence = evidence();
    const fake = engine(selectedRequest);
    const brokerNow = { value: NOW };
    const abort = vi.fn();
    fake.openAttachment.mockImplementationOnce(async () => {
      brokerNow.value = NOW + 101;
      return { ok: true, value: {
        writeAndClose: vi.fn(() => true),
        abort,
        completion: new Promise(() => {}),
      } };
    });

    expect(await broker(value, fake, true, { clock: () => new Date(brokerNow.value) }).run({
      request: selectedRequest,
      permit: permit(selectedRequest, selectedEvidence),
      capacityEvidence: selectedEvidence,
    })).toMatchObject({
      state: 'withheld', reason: 'deadline-exceeded', replayAdmissionConsumed: true,
      containerRemovalConfirmed: true, capacityReleased: true,
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(fake.createContainer).toHaveBeenCalledOnce();
    expect(fake.startContainer).not.toHaveBeenCalled();
    expect(fake.removeContainer).toHaveBeenCalledOnce();
  });

  it('kills an oversized response, removes the container, and withholds all output', async () => {
    const value = fixture();
    const selectedRequest = request();
    const selectedEvidence = evidence();
    const fake = engine(selectedRequest);
    fake.openAttachment.mockResolvedValueOnce({ ok: true, value: {
      writeAndClose: vi.fn(() => true),
      abort: vi.fn(),
      completion: Promise.resolve({ ok: false, reason: 'attach-truncated' }),
    } });
    fake.waitContainer.mockImplementationOnce(() => new Promise(() => {}));
    const withheld = await broker(value, fake).run({
      request: selectedRequest, permit: permit(selectedRequest, selectedEvidence),
      capacityEvidence: selectedEvidence,
    });
    expect(withheld).toMatchObject({
      state: 'withheld', reason: 'output-limit-exceeded', output: null,
      replayAdmissionConsumed: true, containerRemovalConfirmed: true, capacityReleased: true,
    });
    expect(fake.killContainer).toHaveBeenCalledOnce();
    expect(fake.removeContainer).toHaveBeenCalledOnce();
  });

  it('never retries an effect after an ambiguous create failure and performs cleanup-only recovery', async () => {
    const value = fixture();
    const selectedRequest = request();
    const selectedEvidence = evidence();
    const fake = engine(selectedRequest);
    fake.createContainer.mockRejectedValueOnce(new Error('transport closed after write'));
    const selectedBroker = broker(value, fake);
    expect(await selectedBroker.run({
      request: selectedRequest,
      permit: permit(selectedRequest, selectedEvidence),
      capacityEvidence: selectedEvidence,
    })).toMatchObject({
      state: 'unavailable', reason: 'recovery-required', replayAdmissionConsumed: true,
    });
    expect(fake.createContainer).toHaveBeenCalledOnce();
    expect(fake.startContainer).not.toHaveBeenCalled();

    fake.resolveContainerIdByName.mockResolvedValueOnce({ ok: true, value: CONTAINER_ID });
    expect(await selectedBroker.recover()).toMatchObject({
      state: 'recovered', recoveredRuns: 1, unreconciledRuns: 0,
    });
    expect(fake.resolveContainerIdByName).toHaveBeenCalledOnce();
    expect(fake.createContainer).toHaveBeenCalledOnce();
    expect(fake.startContainer).not.toHaveBeenCalled();
  });

  it('resolves and removes a container after an ambiguous create receipt without starting it', async () => {
    const value = fixture();
    const selectedRequest = request();
    const selectedEvidence = evidence();
    const fake = engine(selectedRequest);
    fake.createContainer.mockResolvedValueOnce({ ok: false, reason: 'request-timed-out' });
    fake.resolveContainerIdByName.mockResolvedValueOnce({ ok: true, value: CONTAINER_ID });

    expect(await broker(value, fake).run({
      request: selectedRequest,
      permit: permit(selectedRequest, selectedEvidence),
      capacityEvidence: selectedEvidence,
    })).toMatchObject({
      state: 'withheld', reason: 'container-create-failed', replayAdmissionConsumed: true,
      containerRemovalConfirmed: true, capacityReleased: true,
    });
    expect(fake.resolveContainerIdByName).toHaveBeenCalledOnce();
    expect(fake.inspectContainer).toHaveBeenCalledTimes(2);
    expect(fake.startContainer).not.toHaveBeenCalled();
    expect(fake.removeContainer).toHaveBeenCalledOnce();
    expect(fake.confirmContainerAbsent).toHaveBeenCalledOnce();
  });

  it('keeps ambiguous create state active when name resolution is unavailable', async () => {
    const value = fixture();
    const selectedRequest = request();
    const selectedEvidence = evidence();
    const fake = engine(selectedRequest);
    fake.createContainer.mockResolvedValueOnce({ ok: false, reason: 'request-timed-out' });
    fake.resolveContainerIdByName.mockResolvedValueOnce({ ok: false, reason: 'request-failed' });

    expect(await broker(value, fake).run({
      request: selectedRequest,
      permit: permit(selectedRequest, selectedEvidence),
      capacityEvidence: selectedEvidence,
    })).toMatchObject({
      state: 'unavailable', reason: 'recovery-required', replayAdmissionConsumed: true,
      containerRemovalConfirmed: false, capacityReleased: false,
    });
    expect(fake.startContainer).not.toHaveBeenCalled();
    expect(fake.removeContainer).not.toHaveBeenCalled();
    expect(value.journal.inspect().activeRuns).toHaveLength(1);
    expect(value.capacityStore.inspect().leases[0]).toMatchObject({ state: 'reserved' });
  });

  it('keeps a negative ambiguous-create lookup active until delayed visibility permits cleanup', async () => {
    const value = fixture();
    const selectedRequest = request();
    const selectedEvidence = evidence();
    const fake = engine(selectedRequest);
    fake.createContainer.mockResolvedValueOnce({ ok: false, reason: 'request-timed-out' });

    expect(await broker(value, fake).run({
      request: selectedRequest,
      permit: permit(selectedRequest, selectedEvidence),
      capacityEvidence: selectedEvidence,
    })).toMatchObject({
      state: 'unavailable', reason: 'recovery-required', replayAdmissionConsumed: true,
      containerRemovalConfirmed: false, capacityReleased: false,
    });
    expect(value.journal.inspect().activeRuns).toHaveLength(1);
    expect(value.capacityStore.inspect().leases[0]).toMatchObject({ state: 'reserved' });

    expect(await broker(value, fake).recover()).toMatchObject({
      state: 'unavailable', recoveredRuns: 0, unreconciledRuns: 1,
      stopReasons: ['ambiguous-create-not-found'],
    });
    expect(value.journal.inspect().activeRuns).toHaveLength(1);

    fake.resolveContainerIdByName.mockResolvedValueOnce({ ok: true, value: CONTAINER_ID });
    expect(await broker(value, fake).recover()).toMatchObject({
      state: 'recovered', recoveredRuns: 1, unreconciledRuns: 0,
    });
    expect(fake.createContainer).toHaveBeenCalledOnce();
    expect(fake.startContainer).not.toHaveBeenCalled();
    expect(fake.removeContainer).toHaveBeenCalledOnce();
    expect(fake.confirmContainerAbsent).toHaveBeenCalledOnce();
    expect(value.journal.inspect()).toMatchObject({ activeRuns: [], terminalRunCount: 1 });
  });

  it('kills and removes a running journaled container during cleanup-only recovery', async () => {
    const value = fixture();
    const selectedRequest = request();
    const selectedEvidence = evidence();
    const fake = engine(selectedRequest);
    beginActiveJournal(value, selectedRequest, selectedEvidence, 'created');
    const prior = await fake.inspectContainer({} as never);
    if (!prior.ok) throw new Error('inspection fixture failed');
    fake.inspectContainer.mockClear();
    fake.inspectContainer.mockResolvedValue({ ok: true, value: { ...prior.value, running: true } });

    expect(await broker(value, fake).recover()).toMatchObject({
      state: 'recovered', recoveredRuns: 1, unreconciledRuns: 0,
      executionAuthority: false, commissioningAuthority: false, productionAuthorized: false,
    });
    expect(fake.killContainer).toHaveBeenCalledOnce();
    expect(fake.waitContainer).toHaveBeenCalledOnce();
    expect(fake.removeContainer).toHaveBeenCalledOnce();
    expect(fake.confirmContainerAbsent).toHaveBeenCalledOnce();
    expect(fake.createContainer).not.toHaveBeenCalled();
    expect(fake.startContainer).not.toHaveBeenCalled();
    expect(value.journal.inspect()).toMatchObject({ activeRuns: [], terminalRunCount: 1 });
  });

  it('settles a removal-confirmed crash record without a container endpoint call', async () => {
    const value = fixture();
    const selectedRequest = request();
    const selectedEvidence = evidence();
    const fake = engine(selectedRequest);
    beginActiveJournal(value, selectedRequest, selectedEvidence, 'removed');

    expect(await broker(value, fake).recover()).toMatchObject({
      state: 'recovered', recoveredRuns: 1, unreconciledRuns: 0,
    });
    expect(fake.inspectEngine).toHaveBeenCalledOnce();
    expect(fake.inspectContainer).not.toHaveBeenCalled();
    expect(fake.resolveContainerIdByName).not.toHaveBeenCalled();
    expect(fake.killContainer).not.toHaveBeenCalled();
    expect(fake.removeContainer).not.toHaveBeenCalled();
    expect(fake.startContainer).not.toHaveBeenCalled();
  });

  it('refuses recovery effects when the pinned engine identity drifts', async () => {
    const value = fixture();
    const selectedRequest = request();
    const selectedEvidence = evidence();
    const fake = engine(selectedRequest);
    beginActiveJournal(value, selectedRequest, selectedEvidence, 'created');
    fake.inspectEngine.mockResolvedValue({ ok: false, reason: 'engine-mismatch' });

    expect(await broker(value, fake).recover()).toMatchObject({
      state: 'unavailable', recoveredRuns: 0, unreconciledRuns: 1,
      stopReasons: ['engine-mismatch'],
    });
    expect(fake.inspectContainer).not.toHaveBeenCalled();
    expect(fake.killContainer).not.toHaveBeenCalled();
    expect(fake.removeContainer).not.toHaveBeenCalled();
    expect(value.journal.inspect().activeRuns).toHaveLength(1);
  });

  it('has no shell, Docker CLI, daemon, CLI, configuration, or startup activation path', () => {
    const brokerSource = readFileSync(new URL(
      '../src/core/daemon/agent-os-local-container-broker.ts', import.meta.url,
    ), 'utf8');
    const engineSource = readFileSync(new URL(
      '../src/core/daemon/agent-os-docker-engine-client.ts', import.meta.url,
    ), 'utf8');
    expect(brokerSource).not.toMatch(/node:child_process|\b(?:spawn|spawnSync|exec|execFile)\s*\(/u);
    expect(engineSource).not.toMatch(/node:child_process|\b(?:spawn|spawnSync|exec|execFile)\s*\(/u);
    expect(engineSource).not.toMatch(/dockerode|DOCKER_HOST|\/containers\/[^'`]*\/exec|\/images\/create/u);
    for (const relative of [
      '../src/core/daemon/service.ts',
      '../src/core/daemon/service-config.ts',
      '../src/core/daemon/loop.ts',
      '../src/cli/index.ts',
      '../package.json',
    ]) {
      const activationSource = readFileSync(new URL(relative, import.meta.url), 'utf8');
      expect(activationSource).not.toMatch(/agent-os-local-container-broker|agent-os-docker-engine-client/u);
    }
  });
});
