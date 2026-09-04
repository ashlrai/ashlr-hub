import { createHash, createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  AGENT_OS_OBSERVATION_SANDBOX_DENY_POLICY_V1,
  AGENT_OS_OBSERVATION_SANDBOX_PROTOCOL_V1,
  agentOsNode22ObservationSeatbeltArgsV1,
  canonicalAgentOsObservationSandboxAttestationAuthenticatorBytesV1,
  compileAgentOsObservationSandboxPreflightV1,
  createAgentOsObservationSandboxResponseV1,
  runAgentOsObservationSandboxV1,
  verifyAgentOsObservationSandboxRequestV1,
  type AgentOsObservationSandboxAttestationV1,
  type AgentOsObservationSandboxBackendKindV1,
  type AgentOsObservationSandboxControlsV1,
  type AgentOsObservationSandboxDependenciesV1,
  type AgentOsObservationSandboxRequestV1,
} from '../src/core/vision/agent-os-observation-sandbox.js';

const raw = (label: string): string => createHash('sha256').update(`m562b\0${label}`).digest('hex');
const prefixed = (label: string): string => `sha256:${raw(label)}`;
const NOW = Date.parse('2026-09-03T15:00:00.000Z');
const ATTESTATION_KEY = Buffer.alloc(32, 0x71);
const REQUEST_KEY = Buffer.alloc(32, 0x72);
const RESPONSE_KEY = Buffer.alloc(32, 0x73);
const ATTESTATION_KEY_ID = raw('attestation-key');
const REQUEST_KEY_ID = raw('request-key');
const RESPONSE_KEY_ID = raw('response-key');
const BACKEND_ID = raw('backend');
const POLICY = raw('policy');

const controls = (overrides: Partial<AgentOsObservationSandboxControlsV1> = {}):
AgentOsObservationSandboxControlsV1 => ({
  processIsolated: true,
  untrustedCodeIsolation: true,
  networkDenied: true,
  filesystemReadRestricted: true,
  filesystemWriteDenied: true,
  environmentSanitized: true,
  hostIpcDenied: true,
  childProcessDenied: true,
  workerThreadsDenied: true,
  nativeAddonsDenied: true,
  wasiDenied: true,
  inspectorDenied: true,
  deadlineKillEnforced: true,
  outputLimitEnforced: true,
  processIdentityBound: true,
  ...overrides,
});

function hmac(key: Buffer, bytes: Uint8Array): string {
  return createHmac('sha256', key).update(bytes).digest('hex');
}

function attestation(
  backendKind: AgentOsObservationSandboxBackendKindV1 = 'local-vm',
  controlOverrides: Partial<AgentOsObservationSandboxControlsV1> = {},
): AgentOsObservationSandboxAttestationV1 {
  const provisional: AgentOsObservationSandboxAttestationV1 = {
    schemaVersion: 1,
    protocol: AGENT_OS_OBSERVATION_SANDBOX_PROTOCOL_V1,
    backendKind,
    backendIdentityDigest: BACKEND_ID,
    policyDigest: POLICY,
    hostPlatform: 'darwin',
    generatedAt: new Date(NOW - 1_000).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    controls: controls(controlOverrides),
    attestationKeyId: ATTESTATION_KEY_ID,
    authenticator: '0'.repeat(64),
  };
  const bytes = canonicalAgentOsObservationSandboxAttestationAuthenticatorBytesV1(provisional);
  if (!bytes) throw new Error('invalid fixture attestation');
  return { ...provisional, authenticator: hmac(ATTESTATION_KEY, bytes) };
}

const attestationVerifier = {
  keyId: ATTESTATION_KEY_ID,
  verify: ({ canonicalDomainSeparatedAttestation, authenticator }: {
    canonicalDomainSeparatedAttestation: Uint8Array; authenticator: string;
  }) => hmac(ATTESTATION_KEY, canonicalDomainSeparatedAttestation) === authenticator,
};
const requestSigner = {
  keyId: REQUEST_KEY_ID,
  authenticate: (bytes: Uint8Array) => hmac(REQUEST_KEY, bytes),
};
const requestVerifier = {
  keyId: REQUEST_KEY_ID,
  verify: ({ canonicalDomainSeparatedFrame, authenticator }: {
    canonicalDomainSeparatedFrame: Uint8Array; authenticator: string;
  }) => hmac(REQUEST_KEY, canonicalDomainSeparatedFrame) === authenticator,
};
const responseSigner = {
  keyId: RESPONSE_KEY_ID,
  authenticate: (bytes: Uint8Array) => hmac(RESPONSE_KEY, bytes),
};
const responseVerifier = {
  keyId: RESPONSE_KEY_ID,
  verify: ({ canonicalDomainSeparatedFrame, authenticator }: {
    canonicalDomainSeparatedFrame: Uint8Array; authenticator: string;
  }) => hmac(RESPONSE_KEY, canonicalDomainSeparatedFrame) === authenticator,
};

const input = () => {
  const bytes = Buffer.from('{"sourceBundle":"bounded"}', 'utf8');
  return {
    requestId: raw('request'),
    requestNonce: raw('nonce'),
    epoch: 1,
    durableTickDigest: prefixed('tick'),
    attemptId: prefixed('attempt'),
    startReceiptDigest: raw('start'),
    issuedAt: new Date(NOW - 100).toISOString(),
    deadlineAt: new Date(NOW + 30_000).toISOString(),
    maxOutputBytes: 1_024,
    inputBytes: bytes.byteLength,
    inputDigest: createHash('sha256').update(bytes).digest('hex'),
    inputBase64: bytes.toString('base64'),
  };
};

function dependencies(
  override: Partial<AgentOsObservationSandboxDependenciesV1> = {},
): AgentOsObservationSandboxDependenciesV1 {
  const observedAttestation = attestation();
  const backend = {
    readAttestation: () => ({ ...observedAttestation, controls: { ...observedAttestation.controls } }),
    execute(request: Readonly<AgentOsObservationSandboxRequestV1>) {
      const accepted = verifyAgentOsObservationSandboxRequestV1(request, requestVerifier);
      if (!accepted) return null;
      const output = Buffer.from('{"sourceState":"healthy"}', 'utf8');
      return createAgentOsObservationSandboxResponseV1({
        schemaVersion: 1,
        protocol: AGENT_OS_OBSERVATION_SANDBOX_PROTOCOL_V1,
        requestId: request.requestId,
        requestDigest: request.requestDigest,
        backendIdentityDigest: request.backendIdentityDigest,
        policyDigest: request.policyDigest,
        outcome: 'succeeded',
        process: {
          pid: 7321,
          executableDigest: raw('executable'),
          instanceNonce: raw('process-nonce'),
          launchedAt: new Date(NOW).toISOString(),
        },
        finishedAt: new Date(NOW + 10).toISOString(),
        outputBytes: output.byteLength,
        outputDigest: createHash('sha256').update(output).digest('hex'),
        outputBase64: output.toString('base64'),
      }, responseSigner);
    },
  };
  return {
    expectedBackendIdentityDigest: BACKEND_ID,
    expectedPolicyDigest: POLICY,
    attestationVerifier,
    requestSigner,
    responseVerifier,
    backend,
    now: () => NOW + 20,
    ...override,
  };
}

function expectNoAuthority(value: Record<string, unknown>): void {
  expect(value).toMatchObject({
    authority: 'observation-only',
    executionAuthority: false,
    effectAuthority: false,
    externalMutationAuthority: false,
    credentialAuthority: false,
    commissioningAuthority: false,
    activationAuthority: false,
    sandboxProvisioningAuthority: false,
  });
}

describe('M562b Agent OS observation sandbox boundary', () => {
  it('hard-codes Node Permission Model as seatbelt-only even with authenticated claims', () => {
    const result = compileAgentOsObservationSandboxPreflightV1(attestation(
      'node-permission-seatbelt',
    ), { backendIdentityDigest: BACKEND_ID, policyDigest: POLICY, nowMs: NOW }, attestationVerifier);
    expect(result.state).toBe('seatbelt-only');
    expect(result.enforced).toBe(false);
    expect(result.stopReasons).toEqual(['node-permission-is-seatbelt-only']);
    expectNoAuthority(result as unknown as Record<string, unknown>);
    expect(agentOsNode22ObservationSeatbeltArgsV1()).toEqual([
      '--permission', '--disable-proto=throw', '--no-addons',
    ]);
  });

  it('names every missing isolation property and never upgrades a partial backend', () => {
    const result = compileAgentOsObservationSandboxPreflightV1(attestation('macos-sandbox-exec', {
      processIsolated: false,
      untrustedCodeIsolation: false,
      networkDenied: false,
      filesystemWriteDenied: false,
      deadlineKillEnforced: false,
    }), { backendIdentityDigest: BACKEND_ID, policyDigest: POLICY, nowMs: NOW }, attestationVerifier);
    expect(result.state).toBe('blocked');
    expect(result.stopReasons).toEqual(expect.arrayContaining([
      'process-isolation-not-proven', 'untrusted-code-isolation-not-proven',
      'network-denial-not-proven', 'filesystem-write-denial-not-proven',
      'deadline-kill-not-proven',
    ]));
  });

  it('rejects unauthenticated, stale, overlong, wrong-policy, and mutating attestation evidence', () => {
    const invalidMac = { ...attestation(), authenticator: raw('wrong') };
    expect(compileAgentOsObservationSandboxPreflightV1(invalidMac, {
      backendIdentityDigest: BACKEND_ID, policyDigest: POLICY, nowMs: NOW,
    }, attestationVerifier).stopReasons).toContain('attestation-authentication-failed');

    const stale = attestation();
    const staleResult = compileAgentOsObservationSandboxPreflightV1(stale, {
      backendIdentityDigest: BACKEND_ID, policyDigest: POLICY, nowMs: NOW + 60_001,
    }, attestationVerifier);
    expect(staleResult.stopReasons).toContain('attestation-expired');

    const wrongPolicy = compileAgentOsObservationSandboxPreflightV1(attestation(), {
      backendIdentityDigest: BACKEND_ID, policyDigest: raw('other-policy'), nowMs: NOW,
    }, attestationVerifier);
    expect(wrongPolicy.stopReasons).toContain('policy-mismatch');

    const mutating = compileAgentOsObservationSandboxPreflightV1(attestation(), {
      backendIdentityDigest: BACKEND_ID, policyDigest: POLICY, nowMs: NOW,
    }, {
      keyId: ATTESTATION_KEY_ID,
      verify(value) {
        value.canonicalDomainSeparatedAttestation[0] ^= 1;
        return true;
      },
    });
    expect(mutating.stopReasons).toContain('attestation-verifier-mutated-input');
  });

  it('authenticates exact deny-by-default request and bounded response frames', () => {
    let captured: AgentOsObservationSandboxRequestV1 | null = null;
    const base = dependencies();
    const backend = {
      ...base.backend,
      execute(request: Readonly<AgentOsObservationSandboxRequestV1>) {
        captured = { ...request, policy: { ...request.policy } };
        return base.backend.execute(request);
      },
    };
    const result = runAgentOsObservationSandboxV1(input(), { ...base, backend });
    expect(result.state).toBe('completed');
    expect(result.reason).toBe('succeeded');
    expect(result.enforced).toBe(true);
    expect(Buffer.from(result.output ?? []).toString('utf8')).toBe('{"sourceState":"healthy"}');
    expect(captured?.policy).toEqual(AGENT_OS_OBSERVATION_SANDBOX_DENY_POLICY_V1);
    expect(captured && verifyAgentOsObservationSandboxRequestV1(captured, requestVerifier)).not.toBeNull();
    expect(result.process).toMatchObject({ pid: 7321, executableDigest: raw('executable') });
    expectNoAuthority(result as unknown as Record<string, unknown>);
  });

  it('fails closed when request signing or response verification mutates authenticated bytes', () => {
    const requestFailure = runAgentOsObservationSandboxV1(input(), dependencies({
      requestSigner: {
        keyId: REQUEST_KEY_ID,
        authenticate(bytes) { bytes[0] ^= 1; return raw('authenticator'); },
      },
    }));
    expect(requestFailure.reason).toBe('request-authentication-failed');

    const responseFailure = runAgentOsObservationSandboxV1(input(), dependencies({
      responseVerifier: {
        keyId: RESPONSE_KEY_ID,
        verify(value) { value.canonicalDomainSeparatedFrame[0] ^= 1; return true; },
      },
    }));
    expect(responseFailure.reason).toBe('response-authentication-failed');
  });

  it('pins the authenticated response before a later backend callback can mutate it', () => {
    const base = dependencies();
    let returnedResponse: AgentOsObservationSandboxResponseV1 | null = null;
    let attestationReads = 0;
    const result = runAgentOsObservationSandboxV1(input(), {
      ...base,
      backend: {
        execute(request) {
          const output = Buffer.from('{"untrusted":"output"}', 'utf8');
          const signed = createAgentOsObservationSandboxResponseV1({
            schemaVersion: 1,
            protocol: AGENT_OS_OBSERVATION_SANDBOX_PROTOCOL_V1,
            requestId: request.requestId,
            requestDigest: request.requestDigest,
            backendIdentityDigest: request.backendIdentityDigest,
            policyDigest: request.policyDigest,
            outcome: 'failed',
            process: {
              pid: 7331,
              executableDigest: raw('mutable-executable'),
              instanceNonce: raw('mutable-process-nonce'),
              launchedAt: new Date(NOW).toISOString(),
            },
            finishedAt: new Date(NOW + 10).toISOString(),
            outputBytes: output.byteLength,
            outputDigest: createHash('sha256').update(output).digest('hex'),
            outputBase64: output.toString('base64'),
          }, responseSigner);
          if (!signed) throw new Error('expected signed response');
          returnedResponse = { ...signed, process: { ...signed.process } };
          return returnedResponse;
        },
        readAttestation() {
          attestationReads += 1;
          if (attestationReads === 2 && returnedResponse) {
            returnedResponse.outcome = 'succeeded';
            returnedResponse.responseDigest = raw('mutated-response');
            returnedResponse.process.pid = 9999;
          }
          return base.backend.readAttestation();
        },
      },
    });
    expect(result).toMatchObject({
      state: 'withheld', reason: 'producer-failed', enforced: false, output: null,
      process: { pid: 7331 },
    });
    expect(result.responseDigest).not.toBe(raw('mutated-response'));
  });

  it('withholds expired work, oversized output, failure, and backend attestation drift', () => {
    expect(runAgentOsObservationSandboxV1({ ...input(), deadlineAt: new Date(NOW).toISOString() },
      dependencies()).reason).toBe('deadline-exceeded');

    const base = dependencies();
    const outputLimit = runAgentOsObservationSandboxV1(input(), {
      ...base,
      backend: {
        ...base.backend,
        execute(request) {
          const output = Buffer.alloc(0);
          return createAgentOsObservationSandboxResponseV1({
            schemaVersion: 1, protocol: AGENT_OS_OBSERVATION_SANDBOX_PROTOCOL_V1,
            requestId: request.requestId, requestDigest: request.requestDigest,
            backendIdentityDigest: request.backendIdentityDigest, policyDigest: request.policyDigest,
            outcome: 'output-limit-exceeded',
            process: { pid: 1, executableDigest: raw('exe'), instanceNonce: raw('instance'),
              launchedAt: new Date(NOW).toISOString() },
            finishedAt: new Date(NOW + 1).toISOString(), outputBytes: 0,
            outputDigest: createHash('sha256').update(output).digest('hex'), outputBase64: '',
          }, responseSigner);
        },
      },
    });
    expect(outputLimit.reason).toBe('output-limit-exceeded');

    const attestations = [attestation(), attestation('local-container')];
    let read = 0;
    const driftBase = dependencies();
    const drift = runAgentOsObservationSandboxV1(input(), {
      ...driftBase,
      backend: {
        ...driftBase.backend,
        readAttestation: () => attestations[Math.min(read++, 1)]!,
      },
    });
    expect(drift.reason).toBe('attestation-drift');
    expect(drift.output).toBeNull();
  });

  it('rejects extra properties and cannot elevate a backend from output alone', () => {
    const malformed = { ...input(), extra: true };
    expect(runAgentOsObservationSandboxV1(malformed, dependencies()).reason).toBe('invalid-input');
    expect(runAgentOsObservationSandboxV1(
      { ...input(), inputDigest: raw('substituted') }, dependencies(),
    ).reason).toBe('invalid-input');
    const seatbeltBase = dependencies();
    const result = runAgentOsObservationSandboxV1(input(), {
      ...seatbeltBase,
      backend: {
        ...seatbeltBase.backend,
        readAttestation: () => attestation('node-permission-seatbelt'),
      },
    });
    expect(result.reason).toBe('backend-not-enforced');
    expect(result.preflight?.state).toBe('seatbelt-only');
    expect(result.output).toBeNull();
  });

  it('requires role-separated attestation, controller-request, and backend-response keys', () => {
    const base = dependencies();
    const result = runAgentOsObservationSandboxV1(input(), {
      ...base,
      responseVerifier: { ...responseVerifier, keyId: REQUEST_KEY_ID },
    });
    expect(result.reason).toBe('invalid-dependencies');
    expect(result.enforced).toBe(false);
  });
});
