import {
  createHash,
  generateKeyPairSync,
  sign as signEd25519,
  verify as verifyEd25519,
} from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  AGENT_OS_LOCAL_CONTAINER_POLICY_V1,
  AGENT_OS_LOCAL_CONTAINER_NATIVE_PRODUCER_ENTRYPOINT_V1,
  agentOsLocalContainerCreatePolicyDigestV1,
  buildAgentOsLocalContainerCreatePolicyV1,
  inspectAgentOsLocalContainerCreatePolicyV1,
  type AgentOsLocalContainerCreatePolicyV1,
  type AgentOsLocalContainerLimitsV1,
} from '../src/core/vision/agent-os-local-container-policy.js';
import {
  AGENT_OS_OBSERVATION_ISOLATION_NO_AUTHORITY_V2,
  createAgentOsObservationIsolationFinalizeAttestationV2,
  createAgentOsObservationIsolationPrepareAttestationV2,
  verifyAgentOsObservationIsolationFinalizeAttestationV2,
  verifyAgentOsObservationIsolationPrepareAttestationV2,
  type AgentOsObservationIsolationBindingsV2,
  type AgentOsObservationIsolationFinalizeInputV2,
  type AgentOsObservationIsolationPostRunEvidenceV2,
  type AgentOsObservationIsolationPrepareInputV2,
  type AgentOsObservationIsolationSignerV2,
  type AgentOsObservationIsolationVerifierV2,
} from '../src/core/vision/agent-os-observation-isolation-v2.js';

const raw = (label: string): string => createHash('sha256').update(`m565\0${label}`).digest('hex');
const NOW = Date.parse('2026-09-04T12:00:00.000Z');

const limits = (): AgentOsLocalContainerLimitsV1 => ({
  cpuNanoCpus: 500_000_000,
  memoryBytes: 512 * 1024 * 1024,
  memorySwapBytes: 512 * 1024 * 1024,
  pidsLimit: 1,
  maxDurationMs: 60_000,
  maxOutputBytes: 1_048_576,
  cleanupStartGraceMs: 1_000,
});

const policyInput = () => ({
  image: `ghcr.io/ashlrai/agent-os-observer@sha256:${raw('image')}`,
  producerDigest: raw('producer'),
  allowedProducerDigests: [raw('producer'), raw('producer-next')].sort(),
  user: '65532:65532',
  workingDir: '/workspace',
  seccompProfileDigest: raw('seccomp'),
  limits: limits(),
});

function policy(): AgentOsLocalContainerCreatePolicyV1 {
  const result = buildAgentOsLocalContainerCreatePolicyV1(policyInput());
  if (!result.policy) throw new Error('policy fixture failed');
  return result.policy;
}

function mutablePolicy(): AgentOsLocalContainerCreatePolicyV1 {
  return JSON.parse(JSON.stringify(policy())) as AgentOsLocalContainerCreatePolicyV1;
}

const pair = generateKeyPairSync('ed25519');
const keyId = raw('attestation-key');
const signer: AgentOsObservationIsolationSignerV2 = {
  keyId,
  sign: (bytes) => signEd25519(null, Buffer.from(bytes), pair.privateKey),
};
const verifier: AgentOsObservationIsolationVerifierV2 = {
  keyId,
  verify: ({ canonicalDomainSeparatedAttestation, signature }) => verifyEd25519(
    null,
    Buffer.from(canonicalDomainSeparatedAttestation),
    pair.publicKey,
    Buffer.from(signature),
  ),
};

const bindings = (overrides: Partial<AgentOsObservationIsolationBindingsV2> = {}):
AgentOsObservationIsolationBindingsV2 => ({
  requestNonce: Buffer.alloc(32, 0x65).toString('base64url'),
  requestDigest: raw('request'),
  deadlineAt: new Date(NOW + 50_000).toISOString(),
  containerId: raw('container'),
  brokerDigest: raw('broker'),
  engineDigest: raw('engine'),
  imageDigest: raw('image'),
  producerDigest: raw('producer'),
  seccompDigest: raw('seccomp'),
  createConfigDigest: buildAgentOsLocalContainerCreatePolicyV1(policyInput()).createConfigDigest!,
  limits: limits(),
  ...overrides,
});

const prepareInput = (overrides: Partial<AgentOsObservationIsolationPrepareInputV2> = {}):
AgentOsObservationIsolationPrepareInputV2 => ({
  ...bindings(),
  issuedAt: new Date(NOW - 1_000).toISOString(),
  expiresAt: new Date(NOW + 120_000).toISOString(),
  ...overrides,
});

const postRun = (overrides: Partial<AgentOsObservationIsolationPostRunEvidenceV2> = {}):
AgentOsObservationIsolationPostRunEvidenceV2 => ({
  requestDigest: raw('request'),
  responseDigest: raw('response'),
  inspectDigest: raw('inspect'),
  outputEvidenceDigest: raw('output'),
  exitEvidenceDigest: raw('exit'),
  deadlineKillEvidenceDigest: raw('deadline-kill'),
  removalEvidenceDigest: raw('removal'),
  outputBytes: 512,
  outputTruncated: false,
  outputLimitExceeded: false,
  exitCode: 0,
  oomKilled: false,
  timedOut: false,
  deadlineAt: new Date(NOW + 50_000).toISOString(),
  deadlineKillObserved: false,
  killIssuedAt: null,
  finishedAt: new Date(NOW + 1_000).toISOString(),
  cleanupStartedAt: new Date(NOW + 1_500).toISOString(),
  removalConfirmed: true,
  containerAbsentAfterRemoval: true,
  removedAt: new Date(NOW + 2_000).toISOString(),
  ...overrides,
});

function prepare() {
  const value = createAgentOsObservationIsolationPrepareAttestationV2(prepareInput(), signer);
  if (!value) throw new Error('prepare fixture failed');
  return value;
}

function finalizeInput(
  prepareAttestationDigest: string,
  overrides: Partial<AgentOsObservationIsolationFinalizeInputV2> = {},
): AgentOsObservationIsolationFinalizeInputV2 {
  return {
    ...bindings(),
    prepareAttestationDigest,
    issuedAt: new Date(NOW + 3_000).toISOString(),
    expiresAt: new Date(NOW + 120_000).toISOString(),
    postRun: postRun(),
    ...overrides,
  };
}

function expectNoAuthority(value: Record<string, unknown>): void {
  expect(value).toMatchObject({
    ...AGENT_OS_OBSERVATION_ISOLATION_NO_AUTHORITY_V2,
    brokerTruthIndependentlyVerified: false,
    dockerEnforcementVerified: false,
    replayConsumptionRequired: true,
    replayConsumptionVerified: false,
  });
}

describe('M565 Agent OS local-container create policy', () => {
  it('builds one deterministic deny-by-construction policy without granting provision authority', () => {
    const first = buildAgentOsLocalContainerCreatePolicyV1(policyInput());
    const second = buildAgentOsLocalContainerCreatePolicyV1({ ...policyInput(), limits: { ...limits() } });
    expect(first).toMatchObject({
      state: 'admitted',
      reason: 'policy-admitted',
      structurallyAdmissible: true,
      dockerEnforcementVerified: false,
      containerProvisioningAuthority: false,
    });
    expect(first.createConfigDigest).toBe(second.createConfigDigest);
    expect(first.policy).toEqual({
      schemaVersion: 1,
      protocol: AGENT_OS_LOCAL_CONTAINER_POLICY_V1,
      engine: 'docker',
      image: policyInput().image,
      producer: {
        entrypoint: AGENT_OS_LOCAL_CONTAINER_NATIVE_PRODUCER_ENTRYPOINT_V1,
        digest: policyInput().producerDigest,
        allowedDigests: policyInput().allowedProducerDigests,
      },
      command: [AGENT_OS_LOCAL_CONTAINER_NATIVE_PRODUCER_ENTRYPOINT_V1, '--stdio'],
      user: policyInput().user,
      workingDir: policyInput().workingDir,
      seccompProfileDigest: policyInput().seccompProfileDigest,
      limits: policyInput().limits,
      environment: [],
      mounts: [],
      ports: [],
      devices: [],
      namespaces: { network: 'none', pid: 'private', ipc: 'private', uts: 'private', cgroup: 'private' },
      privileged: false,
      capabilities: { add: [], drop: ['ALL'] },
      readonlyRootfs: true,
      noNewPrivileges: true,
      restart: { name: 'no', maximumRetryCount: 0 },
      logging: { driver: 'none', options: {} },
    });
    expect(Object.isFrozen(first.policy)).toBe(true);
  });

  it.each([
    ['tagged image', () => ({ ...policyInput(), image: 'ghcr.io/ashlrai/observer:latest' }),
      'image-not-digest-pinned'],
    ['unallowlisted producer', () => ({ ...policyInput(), producerDigest: raw('attacker') }),
      'producer-not-allowlisted'],
    ['ambient identity', () => ({ ...policyInput(), user: 'root' }), 'identity-invalid'],
    ['relative working directory', () => ({ ...policyInput(), workingDir: 'workspace' }),
      'working-directory-invalid'],
    ['unbound seccomp', () => ({ ...policyInput(), seccompProfileDigest: 'unconfined' }),
      'seccomp-profile-unbound'],
    ['missing limits', () => {
      const value = policyInput() as Record<string, unknown>;
      delete value['limits'];
      return value;
    }, 'invalid-input'],
    ['swap beyond memory', () => ({
      ...policyInput(), limits: { ...limits(), memorySwapBytes: limits().memoryBytes * 2 },
    }), 'limits-missing-or-invalid'],
  ] as const)('rejects %s at construction', (_label, input, reason) => {
    expect(buildAgentOsLocalContainerCreatePolicyV1(input())).toMatchObject({
      state: 'withheld', reason, policy: null, createConfigDigest: null,
    });
  });

  it.each([
    ['environment inheritance', (value: any) => { value.environment = ['PATH=/host/bin']; },
      'environment-inheritance-forbidden'],
    ['bind mounts', (value: any) => { value.mounts = ['/Users:/host']; }, 'mounts-forbidden'],
    ['published ports', (value: any) => { value.ports = ['8080:80']; }, 'ports-forbidden'],
    ['devices', (value: any) => { value.devices = ['/dev/disk0']; }, 'devices-forbidden'],
    ['host network', (value: any) => { value.namespaces.network = 'host'; }, 'network-forbidden'],
    ['host pid namespace', (value: any) => { value.namespaces.pid = 'host'; },
      'host-namespace-forbidden'],
    ['privileged mode', (value: any) => { value.privileged = true; }, 'privileged-mode-forbidden'],
    ['added capability', (value: any) => { value.capabilities.add = ['SYS_ADMIN']; },
      'added-capabilities-forbidden'],
    ['missing capability drop', (value: any) => { value.capabilities.drop = []; },
      'required-capability-drop-missing'],
    ['writable root', (value: any) => { value.readonlyRootfs = false; }, 'writable-rootfs-forbidden'],
    ['restart', (value: any) => { value.restart.name = 'always'; }, 'restart-forbidden'],
    ['logging', (value: any) => { value.logging.driver = 'json-file'; }, 'logging-forbidden'],
    ['fork-capable pids limit', (value: any) => { value.limits.pidsLimit = 2; },
      'limits-missing-or-invalid'],
    ['arbitrary executable', (value: any) => { value.command[0] = '/tmp/producer'; },
      'command-invalid'],
    ['interpreter executable', (value: any) => { value.command = ['/bin/sh', '--stdio']; },
      'command-invalid'],
    ['producer digest outside allowlist', (value: any) => { value.producer.digest = raw('attacker'); },
      'producer-not-allowlisted'],
  ] as const)('rejects an injected %s policy', (_label, mutate, reason) => {
    const value = mutablePolicy();
    mutate(value);
    expect(inspectAgentOsLocalContainerCreatePolicyV1(value)).toMatchObject({
      state: 'withheld', reason, policy: null, createConfigDigest: null,
    });
  });

  it('rejects accessors, extra fields, sparse commands, and prototype-bearing nested records', () => {
    const accessor = mutablePolicy() as unknown as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(accessor, 'image', {
      enumerable: true,
      get() {
        getterCalls += 1;
        (accessor as any).privileged = true;
        return policyInput().image;
      },
    });
    expect(inspectAgentOsLocalContainerCreatePolicyV1(accessor).reason).toBe('invalid-input');
    expect(agentOsLocalContainerCreatePolicyDigestV1(accessor)).toBeNull();
    expect(getterCalls).toBe(0);

    let proxyReads = 0;
    const proxyTarget = mutablePolicy();
    const privilegedSwap = new Proxy(proxyTarget, {
      getOwnPropertyDescriptor(target, property) {
        proxyReads += 1;
        if (proxyReads > 2) target.privileged = true;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    expect(inspectAgentOsLocalContainerCreatePolicyV1(privilegedSwap).reason).toBe('invalid-input');
    expect(agentOsLocalContainerCreatePolicyDigestV1(privilegedSwap)).toBeNull();
    expect(proxyTarget.privileged).toBe(true);

    const extra = { ...mutablePolicy(), HostConfig: { Privileged: true } };
    expect(inspectAgentOsLocalContainerCreatePolicyV1(extra).reason).toBe('invalid-input');

    const sparse = mutablePolicy();
    sparse.command = new Array(2) as any;
    sparse.command[0] = AGENT_OS_LOCAL_CONTAINER_NATIVE_PRODUCER_ENTRYPOINT_V1;
    expect(inspectAgentOsLocalContainerCreatePolicyV1(sparse).reason).toBe('command-invalid');

    const inheritedLimits = mutablePolicy();
    inheritedLimits.limits = Object.assign(Object.create({ pidsLimit: 64 }), limits());
    expect(inspectAgentOsLocalContainerCreatePolicyV1(inheritedLimits).reason)
      .toBe('invalid-input');
  });
});

describe('M565 Agent OS observation isolation attestations', () => {
  it('authenticates exact prepare and finalize bindings while preserving zero authority', () => {
    const prepared = prepare();
    const preparedResult = verifyAgentOsObservationIsolationPrepareAttestationV2(
      prepared, bindings(), policy(), verifier, NOW,
    );
    expect(preparedResult).toMatchObject({
      state: 'verified', phase: 'prepared', signatureVerified: true, bindingsVerified: true,
      postRunEvidenceVerified: false, removalEvidencePresent: false,
    });
    expectNoAuthority(preparedResult as unknown as Record<string, unknown>);

    const finalized = createAgentOsObservationIsolationFinalizeAttestationV2(
      finalizeInput(prepared.attestationDigest), signer,
    );
    expect(finalized).not.toBeNull();
    const finalizedResult = verifyAgentOsObservationIsolationFinalizeAttestationV2(
      finalized, prepared, bindings(), policy(), postRun(), verifier, NOW + 4_000,
    );
    expect(finalizedResult).toMatchObject({
      state: 'verified', phase: 'finalized', signatureVerified: true, bindingsVerified: true,
      policyBindingsVerified: true, postRunEvidenceVerified: true,
      outputLimitEvidenceVerified: true, deadlineKillEvidenceVerified: true,
      cleanupTimingVerified: true, removalEvidencePresent: true,
      prepareAttestationDigest: prepared.attestationDigest,
    });
    expectNoAuthority(finalizedResult as unknown as Record<string, unknown>);
  });

  it('verifies identical bytes twice but explicitly never claims nonce consumption', () => {
    const prepared = prepare();
    const first = verifyAgentOsObservationIsolationPrepareAttestationV2(
      prepared, bindings(), policy(), verifier, NOW,
    );
    const second = verifyAgentOsObservationIsolationPrepareAttestationV2(
      prepared, bindings(), policy(), verifier, NOW,
    );
    expect(first).toEqual(second);
    for (const result of [first, second]) {
      expect(result).toMatchObject({
        state: 'verified',
        replayConsumptionRequired: true,
        replayConsumptionVerified: false,
      });
    }
  });

  it.each([
    ['request nonce', { requestNonce: Buffer.alloc(32, 0x99).toString('base64url') }],
    ['container', { containerId: raw('other-container') }],
    ['broker', { brokerDigest: raw('other-broker') }],
    ['engine', { engineDigest: raw('other-engine') }],
    ['image', { imageDigest: raw('other-image') }],
    ['producer', { producerDigest: raw('other-producer') }],
    ['seccomp', { seccompDigest: raw('other-seccomp') }],
    ['create config', { createConfigDigest: raw('other-config') }],
    ['limits', { limits: {
      ...limits(), memoryBytes: 1024 * 1024 * 1024, memorySwapBytes: 1024 * 1024 * 1024,
    } }],
  ] as const)('withholds a signed prepare attestation on %s substitution', (_label, replacement) => {
    const prepared = prepare();
    expect(verifyAgentOsObservationIsolationPrepareAttestationV2(
      prepared, bindings(replacement), policy(), verifier, NOW,
    )).toMatchObject({ state: 'withheld', reason: 'binding-mismatch', signatureVerified: false });
  });

  it.each([
    ['image', { imageDigest: raw('other-image') }],
    ['seccomp', { seccompDigest: raw('other-seccomp') }],
    ['producer', { producerDigest: raw('other-producer') }],
    ['create config', { createConfigDigest: raw('other-config') }],
    ['limits', { limits: {
      ...limits(), memoryBytes: 1024 * 1024 * 1024, memorySwapBytes: 1024 * 1024 * 1024,
    } }],
  ] as const)('rejects a signed but policy-incoherent %s tuple', (_label, replacement) => {
    const incoherentBindings = bindings(replacement);
    const signed = createAgentOsObservationIsolationPrepareAttestationV2(
      prepareInput(replacement), signer,
    );
    expect(verifyAgentOsObservationIsolationPrepareAttestationV2(
      signed, incoherentBindings, policy(), verifier, NOW,
    )).toMatchObject({ state: 'withheld', reason: 'policy-binding-mismatch' });
  });

  it('rejects nonce mismatch, signature substitution, expiry, and verifier input mutation', () => {
    const prepared = prepare();
    const replayBindings = bindings({
      requestNonce: Buffer.alloc(32, 0x66).toString('base64url'),
    });
    expect(verifyAgentOsObservationIsolationPrepareAttestationV2(
      prepared, replayBindings, policy(), verifier, NOW,
    ).reason).toBe('binding-mismatch');

    expect(verifyAgentOsObservationIsolationPrepareAttestationV2(
      { ...prepared, signature: Buffer.alloc(64, 0x01).toString('base64url') },
      bindings(), policy(), verifier, NOW,
    ).reason).toBe('signature-invalid');

    expect(verifyAgentOsObservationIsolationPrepareAttestationV2(
      prepared, bindings(), policy(), verifier, NOW + 120_000,
    ).reason).toBe('attestation-expired');

    expect(verifyAgentOsObservationIsolationPrepareAttestationV2(
      prepared,
      bindings(),
      policy(),
      {
        keyId,
        verify(value) {
          value.canonicalDomainSeparatedAttestation[0] ^= 1;
          return true;
        },
      },
      NOW,
    ).reason).toBe('verifier-mutated-input');

    expect(verifyAgentOsObservationIsolationPrepareAttestationV2(
      prepared,
      bindings(),
      policy(),
      {
        keyId,
        verify(value) {
          value.signature[0] ^= 1;
          return true;
        },
      },
      NOW,
    ).reason).toBe('verifier-mutated-input');
  });

  it('requires an authenticated prepare link and exact post-run evidence', () => {
    const prepared = prepare();
    const wrongLink = createAgentOsObservationIsolationFinalizeAttestationV2(
      finalizeInput(raw('other-prepare')), signer,
    );
    expect(verifyAgentOsObservationIsolationFinalizeAttestationV2(
      wrongLink, prepared, bindings(), policy(), postRun(), verifier, NOW + 4_000,
    ).reason).toBe('prepare-link-mismatch');

    const finalized = createAgentOsObservationIsolationFinalizeAttestationV2(
      finalizeInput(prepared.attestationDigest), signer,
    );
    expect(verifyAgentOsObservationIsolationFinalizeAttestationV2(
      finalized, prepared, bindings(), policy(), postRun({ inspectDigest: raw('substituted-inspect') }),
      verifier, NOW + 4_000,
    ).reason).toBe('post-run-evidence-mismatch');

    const otherPair = generateKeyPairSync('ed25519');
    expect(verifyAgentOsObservationIsolationFinalizeAttestationV2(
      finalized, prepared, bindings(), policy(), postRun(), {
        keyId,
        verify: ({ canonicalDomainSeparatedAttestation, signature }) => verifyEd25519(
          null, Buffer.from(canonicalDomainSeparatedAttestation), otherPair.publicKey, Buffer.from(signature),
        ),
      }, NOW + 4_000,
    ).reason).toBe('prepare-unverified');

    let verifierCalls = 0;
    expect(verifyAgentOsObservationIsolationFinalizeAttestationV2(
      finalized, prepared, bindings(), policy(), postRun(), {
        keyId,
        verify(value) {
          verifierCalls += 1;
          if (verifierCalls === 2) value.canonicalDomainSeparatedAttestation[0] ^= 1;
          return true;
        },
      }, NOW + 4_000,
    ).reason).toBe('verifier-mutated-input');
  });

  it('takes one owned data snapshot before prepare and finalize verifier callbacks', () => {
    const mutablePrepared = JSON.parse(JSON.stringify(prepare()));
    const mutableBindings = bindings();
    const mutableExpectedPolicy = mutablePolicy();
    const originalPrepareDigest = mutablePrepared.attestationDigest;
    const callbackVerifier: AgentOsObservationIsolationVerifierV2 = {
      keyId,
      verify(input) {
        mutablePrepared.requestNonce = Buffer.alloc(32, 0x55).toString('base64url');
        mutableBindings.containerId = raw('callback-container');
        mutableExpectedPolicy.image = `ghcr.io/ashlrai/other@sha256:${raw('callback-image')}`;
        return verifier.verify(input);
      },
    };
    expect(verifyAgentOsObservationIsolationPrepareAttestationV2(
      mutablePrepared, mutableBindings, mutableExpectedPolicy, callbackVerifier, NOW,
    )).toMatchObject({ state: 'verified', attestationDigest: originalPrepareDigest });

    const prepared = prepare();
    const mutableFinalized = JSON.parse(JSON.stringify(
      createAgentOsObservationIsolationFinalizeAttestationV2(
        finalizeInput(prepared.attestationDigest), signer,
      ),
    ));
    const mutableFinalizePrepare = JSON.parse(JSON.stringify(prepared));
    const mutableFinalizeBindings = bindings();
    const mutableFinalizePolicy = mutablePolicy();
    const mutableEvidence = postRun();
    const originalFinalizeDigest = mutableFinalized.attestationDigest;
    const finalizeCallbackVerifier: AgentOsObservationIsolationVerifierV2 = {
      keyId,
      verify(input) {
        mutableFinalized.postRun.responseDigest = raw('callback-response');
        mutableFinalizePrepare.containerId = raw('callback-prepare-container');
        mutableFinalizeBindings.engineDigest = raw('callback-engine');
        mutableFinalizePolicy.seccompProfileDigest = raw('callback-seccomp');
        mutableEvidence.inspectDigest = raw('callback-inspect');
        return verifier.verify(input);
      },
    };
    expect(verifyAgentOsObservationIsolationFinalizeAttestationV2(
      mutableFinalized,
      mutableFinalizePrepare,
      mutableFinalizeBindings,
      mutableFinalizePolicy,
      mutableEvidence,
      finalizeCallbackVerifier,
      NOW + 4_000,
    )).toMatchObject({ state: 'verified', attestationDigest: originalFinalizeDigest });
  });

  it('rejects Proxy view swaps before prepare or finalize validation', () => {
    const prepared = prepare();
    let prepareView = 0;
    const prepareProxy = new Proxy(JSON.parse(JSON.stringify(prepared)), {
      ownKeys(target) {
        prepareView += 1;
        if (prepareView > 1) target.containerId = raw('swapped-container');
        return Reflect.ownKeys(target);
      },
    });
    expect(verifyAgentOsObservationIsolationPrepareAttestationV2(
      prepareProxy, bindings(), policy(), verifier, NOW,
    ).reason).toBe('invalid-attestation');

    const finalized = createAgentOsObservationIsolationFinalizeAttestationV2(
      finalizeInput(prepared.attestationDigest), signer,
    );
    let finalizeView = 0;
    const finalizeProxy = new Proxy(JSON.parse(JSON.stringify(finalized)), {
      getOwnPropertyDescriptor(target, property) {
        finalizeView += 1;
        if (finalizeView > 2) target.requestNonce = Buffer.alloc(32, 0x54).toString('base64url');
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    expect(verifyAgentOsObservationIsolationFinalizeAttestationV2(
      finalizeProxy, prepared, bindings(), policy(), postRun(), verifier, NOW + 4_000,
    ).reason).toBe('invalid-attestation');
  });

  it('binds output limits, deadline kills, and bounded cleanup chronology', () => {
    const prepared = prepare();
    const invalidEvidence = [
      postRun({ outputBytes: limits().maxOutputBytes + 1 }),
      postRun({ outputTruncated: true, outputLimitExceeded: false }),
      postRun({ timedOut: true }),
      postRun({
        cleanupStartedAt: new Date(NOW + 2_000).toISOString(),
        removedAt: new Date(NOW + 12_001).toISOString(),
      }),
      postRun({
        cleanupStartedAt: new Date(NOW + 2_001).toISOString(),
        removedAt: new Date(NOW + 2_500).toISOString(),
      }),
      postRun({ finishedAt: new Date(NOW + 50_001).toISOString() }),
    ];
    for (const evidence of invalidEvidence) {
      expect(createAgentOsObservationIsolationFinalizeAttestationV2(
        finalizeInput(prepared.attestationDigest, { postRun: evidence }), signer,
      )).toBeNull();
    }

    const idleGap = postRun({
      cleanupStartedAt: new Date(NOW + 100_000).toISOString(),
      removedAt: new Date(NOW + 100_500).toISOString(),
    });
    expect(createAgentOsObservationIsolationFinalizeAttestationV2(
      finalizeInput(prepared.attestationDigest, {
        issuedAt: new Date(NOW + 101_000).toISOString(),
        postRun: idleGap,
      }),
      signer,
    )).toBeNull();

    const cleanupBoundary = postRun({
      cleanupStartedAt: new Date(NOW + 2_000).toISOString(),
      removedAt: new Date(NOW + 2_500).toISOString(),
    });
    const cleanupBoundaryFinalized = createAgentOsObservationIsolationFinalizeAttestationV2(
      finalizeInput(prepared.attestationDigest, { postRun: cleanupBoundary }), signer,
    );
    expect(verifyAgentOsObservationIsolationFinalizeAttestationV2(
      cleanupBoundaryFinalized, prepared, bindings(), policy(), cleanupBoundary, verifier,
      NOW + 4_000,
    )).toMatchObject({ state: 'verified', cleanupTimingVerified: true });

    const cappedOutput = postRun({
      outputBytes: limits().maxOutputBytes,
      outputTruncated: true,
      outputLimitExceeded: true,
    });
    const cappedFinalized = createAgentOsObservationIsolationFinalizeAttestationV2(
      finalizeInput(prepared.attestationDigest, { postRun: cappedOutput }), signer,
    );
    expect(verifyAgentOsObservationIsolationFinalizeAttestationV2(
      cappedFinalized, prepared, bindings(), policy(), cappedOutput, verifier, NOW + 4_000,
    )).toMatchObject({ state: 'verified', outputLimitEvidenceVerified: true });

    const timedOutEvidence = postRun({
      timedOut: true,
      deadlineKillObserved: true,
      killIssuedAt: new Date(NOW + 50_500).toISOString(),
      finishedAt: new Date(NOW + 51_000).toISOString(),
      cleanupStartedAt: new Date(NOW + 51_500).toISOString(),
      removedAt: new Date(NOW + 52_000).toISOString(),
    });
    const finalized = createAgentOsObservationIsolationFinalizeAttestationV2(
      finalizeInput(prepared.attestationDigest, {
        issuedAt: new Date(NOW + 53_000).toISOString(),
        postRun: timedOutEvidence,
      }),
      signer,
    );
    expect(verifyAgentOsObservationIsolationFinalizeAttestationV2(
      finalized, prepared, bindings(), policy(), timedOutEvidence, verifier, NOW + 54_000,
    )).toMatchObject({
      state: 'verified', outputLimitEvidenceVerified: true,
      deadlineKillEvidenceVerified: true, cleanupTimingVerified: true,
    });
  });

  it('refuses incomplete removal evidence and impossible phase chronology', () => {
    const prepared = prepare();
    const incomplete = finalizeInput(prepared.attestationDigest) as unknown as Record<string, unknown>;
    incomplete['postRun'] = { ...postRun(), removalConfirmed: false };
    expect(createAgentOsObservationIsolationFinalizeAttestationV2(incomplete, signer)).toBeNull();

    const timeTravel = createAgentOsObservationIsolationFinalizeAttestationV2(
      finalizeInput(prepared.attestationDigest, {
        issuedAt: new Date(NOW + 121_000).toISOString(),
        expiresAt: new Date(NOW + 180_000).toISOString(),
      }),
      signer,
    );
    expect(verifyAgentOsObservationIsolationFinalizeAttestationV2(
      timeTravel,
      prepared,
      bindings(),
      policy(),
      postRun(),
      verifier,
      NOW + 119_000,
    ).reason).toBe('phase-time-invalid');
  });

  it('rejects signer mutation and keeps the protocol modules pure', () => {
    expect(createAgentOsObservationIsolationPrepareAttestationV2(prepareInput(), {
      keyId,
      sign(bytes) {
        bytes[0] ^= 1;
        return signEd25519(null, Buffer.from(bytes), pair.privateKey);
      },
    })).toBeNull();

    for (const file of [
      'src/core/vision/agent-os-local-container-policy.ts',
      'src/core/vision/agent-os-observation-isolation-v2.ts',
    ]) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/node:(?:fs|net|http|https|child_process)|dockerode|\/var\/run\/docker\.sock/);
      expect(source).not.toMatch(/generateKeyPair|createPrivateKey|randomBytes|randomUUID/);
    }
  });
});
