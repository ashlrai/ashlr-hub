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
  pidsLimit: 64,
  maxDurationMs: 60_000,
  maxOutputBytes: 1_048_576,
});

const policyInput = () => ({
  image: `ghcr.io/ashlrai/agent-os-observer@sha256:${raw('image')}`,
  command: ['/opt/ashlr/bin/observation-producer', '--stdio'],
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
  exitEvidenceDigest: raw('exit'),
  removalEvidenceDigest: raw('removal'),
  exitCode: 0,
  oomKilled: false,
  timedOut: false,
  finishedAt: new Date(NOW + 1_000).toISOString(),
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
      ...policyInput(),
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
    ['shell entrypoint', () => ({ ...policyInput(), command: ['/bin/sh', '-c', 'observer'] }),
      'command-invalid'],
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
    ['missing pids limit', (value: any) => { delete value.limits.pidsLimit; },
      'limits-missing-or-invalid'],
  ] as const)('rejects an injected %s policy', (_label, mutate, reason) => {
    const value = mutablePolicy();
    mutate(value);
    expect(inspectAgentOsLocalContainerCreatePolicyV1(value)).toMatchObject({
      state: 'withheld', reason, policy: null, createConfigDigest: null,
    });
  });

  it('rejects accessors, extra fields, sparse commands, and prototype-bearing nested records', () => {
    const accessor = mutablePolicy() as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, 'image', { enumerable: true, get: () => policyInput().image });
    expect(inspectAgentOsLocalContainerCreatePolicyV1(accessor).reason).toBe('invalid-input');

    const extra = { ...mutablePolicy(), HostConfig: { Privileged: true } };
    expect(inspectAgentOsLocalContainerCreatePolicyV1(extra).reason).toBe('invalid-input');

    const sparse = mutablePolicy();
    sparse.command = new Array(2) as string[];
    sparse.command[0] = '/opt/ashlr/bin/observation-producer';
    expect(inspectAgentOsLocalContainerCreatePolicyV1(sparse).reason).toBe('command-invalid');

    const inheritedLimits = mutablePolicy();
    inheritedLimits.limits = Object.assign(Object.create({ pidsLimit: 64 }), limits());
    expect(inspectAgentOsLocalContainerCreatePolicyV1(inheritedLimits).reason)
      .toBe('limits-missing-or-invalid');
  });
});

describe('M565 Agent OS observation isolation attestations', () => {
  it('authenticates exact prepare and finalize bindings while preserving zero authority', () => {
    const prepared = prepare();
    const preparedResult = verifyAgentOsObservationIsolationPrepareAttestationV2(
      prepared, bindings(), verifier, NOW,
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
      finalized, prepared, bindings(), postRun(), verifier, NOW + 4_000,
    );
    expect(finalizedResult).toMatchObject({
      state: 'verified', phase: 'finalized', signatureVerified: true, bindingsVerified: true,
      postRunEvidenceVerified: true, removalEvidencePresent: true,
      prepareAttestationDigest: prepared.attestationDigest,
    });
    expectNoAuthority(finalizedResult as unknown as Record<string, unknown>);
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
    ['limits', { limits: { ...limits(), pidsLimit: 65 } }],
  ] as const)('withholds a signed prepare attestation on %s substitution', (_label, replacement) => {
    const prepared = prepare();
    expect(verifyAgentOsObservationIsolationPrepareAttestationV2(
      prepared, bindings(replacement), verifier, NOW,
    )).toMatchObject({ state: 'withheld', reason: 'binding-mismatch', signatureVerified: false });
  });

  it('rejects replay, signature substitution, expiry, and verifier input mutation', () => {
    const prepared = prepare();
    const replayBindings = bindings({
      requestNonce: Buffer.alloc(32, 0x66).toString('base64url'),
    });
    expect(verifyAgentOsObservationIsolationPrepareAttestationV2(
      prepared, replayBindings, verifier, NOW,
    ).reason).toBe('binding-mismatch');

    expect(verifyAgentOsObservationIsolationPrepareAttestationV2(
      { ...prepared, signature: Buffer.alloc(64, 0x01).toString('base64url') },
      bindings(), verifier, NOW,
    ).reason).toBe('signature-invalid');

    expect(verifyAgentOsObservationIsolationPrepareAttestationV2(
      prepared, bindings(), verifier, NOW + 120_000,
    ).reason).toBe('attestation-expired');

    expect(verifyAgentOsObservationIsolationPrepareAttestationV2(
      prepared,
      bindings(),
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
      wrongLink, prepared, bindings(), postRun(), verifier, NOW + 4_000,
    ).reason).toBe('prepare-link-mismatch');

    const finalized = createAgentOsObservationIsolationFinalizeAttestationV2(
      finalizeInput(prepared.attestationDigest), signer,
    );
    expect(verifyAgentOsObservationIsolationFinalizeAttestationV2(
      finalized, prepared, bindings(), postRun({ inspectDigest: raw('substituted-inspect') }),
      verifier, NOW + 4_000,
    ).reason).toBe('post-run-evidence-mismatch');

    const otherPair = generateKeyPairSync('ed25519');
    expect(verifyAgentOsObservationIsolationFinalizeAttestationV2(
      finalized, prepared, bindings(), postRun(), {
        keyId,
        verify: ({ canonicalDomainSeparatedAttestation, signature }) => verifyEd25519(
          null, Buffer.from(canonicalDomainSeparatedAttestation), otherPair.publicKey, Buffer.from(signature),
        ),
      }, NOW + 4_000,
    ).reason).toBe('prepare-unverified');
  });

  it('refuses incomplete removal evidence and impossible phase chronology', () => {
    const prepared = prepare();
    const incomplete = finalizeInput(prepared.attestationDigest) as unknown as Record<string, unknown>;
    incomplete['postRun'] = { ...postRun(), removalConfirmed: false };
    expect(createAgentOsObservationIsolationFinalizeAttestationV2(incomplete, signer)).toBeNull();

    const timeTravel = createAgentOsObservationIsolationFinalizeAttestationV2(
      finalizeInput(prepared.attestationDigest, {
        issuedAt: new Date(NOW + 72_000).toISOString(),
        postRun: postRun({
          finishedAt: new Date(NOW + 70_000).toISOString(),
          removedAt: new Date(NOW + 71_000).toISOString(),
        }),
      }),
      signer,
    );
    expect(verifyAgentOsObservationIsolationFinalizeAttestationV2(
      timeTravel,
      prepared,
      bindings(),
      postRun({
        finishedAt: new Date(NOW + 70_000).toISOString(),
        removedAt: new Date(NOW + 71_000).toISOString(),
      }),
      verifier,
      NOW + 73_000,
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
