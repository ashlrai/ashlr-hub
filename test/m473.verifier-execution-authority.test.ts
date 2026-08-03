import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  VERIFIER_EXECUTION_AUTHORITY_BLOCKERS_V1,
  VERIFIER_EXECUTION_AUTHORITY_PROTOCOL_V2,
  VERIFIER_EXECUTION_SIGNATURE_ALGORITHM,
  VERIFIER_EXECUTION_TRUST_PROTOCOL_V1,
  canonicalVerifierExecutionAuthorityPayloadV2,
  inspectVerifierExecutionAuthorityV2,
  verifierExecutionAuthorityKeyId,
  verifierExecutionAuthorityTrustPolicyDigest,
  type InspectVerifierExecutionAuthorityV2Input,
  type VerifierExecutionAuthorityStatementUnsignedV2,
  type VerifierExecutionAuthorityStatementV2,
  type VerifierExecutionExpectedBindingsV1,
  type VerifierExecutionTrustPolicyV1,
} from '../src/core/run/verifier-execution-authority.js';

const NOW = Date.parse('2026-08-02T15:05:00.000Z');
const ISSUED_AT = '2026-08-02T15:00:00.000Z';
const EXPIRES_AT = '2026-08-02T15:10:00.000Z';
const NOT_BEFORE = '2026-08-02T14:00:00.000Z';
const NOT_AFTER = '2026-08-02T16:00:00.000Z';
const WINDOWS_RESOLVER_ALIASES = [
  'sh', 'sh.exe', 'bash', 'bash.exe', 'zsh', 'zsh.exe', 'dash', 'dash.exe', 'ksh',
  'ksh.exe', 'fish', 'fish.exe', 'csh', 'csh.exe', 'tcsh', 'tcsh.exe',
  'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'PoWeRsHeLl.ExE',
  'cmd', 'cmd.exe', 'comspec', 'comspec.exe',
  'node', 'node.exe', 'nodejs', 'nodejs.exe', 'python', 'python.exe', 'python3',
  'python3.exe', 'python3.12', 'python3.12.exe', 'py', 'py.exe', 'ruby', 'ruby.exe',
  'perl', 'perl.exe', 'php', 'php.exe', 'java', 'java.exe', 'deno', 'deno.exe',
  'bun', 'bun.exe', 'env', 'env.exe', 'busybox', 'busybox.exe', 'wscript', 'wscript.exe',
  'cscript', 'cscript.exe', 'rundll32', 'rundll32.exe',
  ...['npm', 'npx', 'yarn', 'pnpm', 'corepack'].flatMap((name) =>
    [name, `${name}.cmd`, `${name}.exe`, `${name}.bat`]),
] as const;

function digest(label: string): string {
  return createHash('sha256').update(label).digest('hex');
}

function publicKeySpki(key: KeyObject): string {
  return Buffer.from(key.export({ format: 'der', type: 'spki' })).toString('base64url');
}

interface Fixture {
  input: InspectVerifierExecutionAuthorityV2Input;
  policy: VerifierExecutionTrustPolicyV1;
  privateKey: KeyObject;
  statement: VerifierExecutionAuthorityStatementV2;
  unsigned: VerifierExecutionAuthorityStatementUnsignedV2;
}

function fixture(): Fixture {
  const keys = generateKeyPairSync('ed25519');
  const spki = publicKeySpki(keys.publicKey);
  const keyId = verifierExecutionAuthorityKeyId(spki);
  if (!keyId) throw new Error('fixture key was invalid');
  const policy: VerifierExecutionTrustPolicyV1 = {
    schemaVersion: 1,
    protocol: VERIFIER_EXECUTION_TRUST_PROTOCOL_V1,
    policyVersion: 'capsule-admission-2026-08',
    keys: [{
      keyId,
      signatureAlgorithm: VERIFIER_EXECUTION_SIGNATURE_ALGORITHM,
      role: 'verifier-capsule-admission-signer',
      publicKeySpki: spki,
      notBefore: NOT_BEFORE,
      notAfter: NOT_AFTER,
      allowedPlatforms: ['darwin', 'linux', 'win32'],
      allowedArchitectures: ['arm64', 'x64'],
      allowedBackends: [
        'linux-namespace-cgroup-broker',
        'macos-virtualization-framework-broker',
        'windows-appcontainer-job-broker',
      ],
    }],
  };
  const policyDigest = verifierExecutionAuthorityTrustPolicyDigest(policy);
  if (!policyDigest) throw new Error('fixture policy was invalid');
  const unsigned: VerifierExecutionAuthorityStatementUnsignedV2 = {
    schemaVersion: 1,
    protocol: VERIFIER_EXECUTION_AUTHORITY_PROTOCOL_V2,
    assurance: 'externally-signed-capsule-observation',
    ticketDigest: digest('ticket'),
    candidateDigest: digest('candidate'),
    baseDigest: digest('base'),
    commandPlanDigest: digest('command-plan'),
    capsuleTreeDigest: digest('complete-capsule-tree'),
    executableDigest: digest('all-executable-bytes'),
    dependencyDigest: digest('all-dependency-bytes'),
    brokerDigest: digest('signed-native-broker'),
    isolationPolicyDigest: digest('isolation-policy'),
    commandEntrypoints: [
      { commandId: 'test', entrypoint: '/opt/ashlr/verifier-capsule/entrypoints/test' },
      { commandId: 'typecheck', entrypoint: '/opt/ashlr/verifier-capsule/entrypoints/typecheck' },
    ],
    capsuleRoot: '/opt/ashlr/verifier-capsule',
    platform: 'linux',
    architecture: 'x64',
    backend: 'linux-namespace-cgroup-broker',
    candidateMount: 'read-only',
    hostMounts: [],
    networkPolicy: 'denied',
    descendantOwnership: 'kernel-owned',
    capsuleMutability: 'immutable',
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    nonce: Buffer.alloc(24, 7).toString('base64url'),
    trustPolicyDigest: policyDigest,
    keyId,
    signatureAlgorithm: VERIFIER_EXECUTION_SIGNATURE_ALGORITHM,
    executionPermitted: false,
    mergePermitted: false,
    evidencePermitted: false,
  };
  const payload = canonicalVerifierExecutionAuthorityPayloadV2(unsigned);
  if (!payload) throw new Error('fixture statement was invalid');
  const statement: VerifierExecutionAuthorityStatementV2 = {
    ...unsigned,
    signature: sign(null, payload, keys.privateKey).toString('base64url'),
  };
  const expectedBindings: VerifierExecutionExpectedBindingsV1 = {
    ticketDigest: unsigned.ticketDigest,
    candidateDigest: unsigned.candidateDigest,
    baseDigest: unsigned.baseDigest,
    commandPlanDigest: unsigned.commandPlanDigest,
    capsuleTreeDigest: unsigned.capsuleTreeDigest,
    executableDigest: unsigned.executableDigest,
    dependencyDigest: unsigned.dependencyDigest,
    brokerDigest: unsigned.brokerDigest,
    isolationPolicyDigest: unsigned.isolationPolicyDigest,
    commandEntrypoints: structuredClone(unsigned.commandEntrypoints),
    capsuleRoot: unsigned.capsuleRoot,
    platform: unsigned.platform,
    architecture: unsigned.architecture,
    backend: unsigned.backend,
  };
  return {
    privateKey: keys.privateKey,
    policy,
    statement,
    unsigned,
    input: {
      statement,
      trustPolicy: policy,
      expectedPolicyDigest: policyDigest,
      expectedBindings,
      nowMs: NOW,
    },
  };
}

function resign(value: Fixture, changes: Record<string, unknown>): InspectVerifierExecutionAuthorityV2Input {
  const unsigned = { ...value.unsigned, ...changes } as unknown as VerifierExecutionAuthorityStatementUnsignedV2;
  const payload = canonicalVerifierExecutionAuthorityPayloadV2(unsigned);
  if (!payload) {
    return { ...value.input, statement: { ...value.statement, ...changes } } as InspectVerifierExecutionAuthorityV2Input;
  }
  return {
    ...value.input,
    statement: {
      ...unsigned,
      signature: sign(null, payload, value.privateKey).toString('base64url'),
    },
  };
}

function windowsEntrypointInput(
  value: Fixture,
  entrypoint: string,
): InspectVerifierExecutionAuthorityV2Input {
  const commandEntrypoints = [{ commandId: 'test', entrypoint }];
  const input = resign(value, {
    platform: 'win32',
    architecture: 'x64',
    backend: 'windows-appcontainer-job-broker',
    capsuleRoot: 'C:\\ashlr-verifier-capsule',
    commandEntrypoints,
  });
  input.expectedBindings = {
    ...input.expectedBindings,
    platform: 'win32',
    architecture: 'x64',
    backend: 'windows-appcontainer-job-broker',
    capsuleRoot: 'C:\\ashlr-verifier-capsule',
    commandEntrypoints: structuredClone(commandEntrypoints),
  };
  return input;
}

function allAuthorityFalse(result: ReturnType<typeof inspectVerifierExecutionAuthorityV2>): void {
  expect(result).toMatchObject({
    authority: 'observation-only',
    executionPermitted: false,
    mergePermitted: false,
    evidencePermitted: false,
    trustPolicyApprovalVerified: false,
    liveImmutabilityVerified: false,
    replayTransparencyVerified: false,
    executionWiringVerified: false,
    blockers: VERIFIER_EXECUTION_AUTHORITY_BLOCKERS_V1,
  });
}

describe('M473 Verifier Execution Authority V2 observation', () => {
  it('verifies an exact external statement while keeping every authority hard-false', () => {
    const value = fixture();
    const result = inspectVerifierExecutionAuthorityV2(value.input);

    expect(result).toMatchObject({
      schemaVersion: 1,
      mode: 'verifier-execution-authority-observation-v2',
      state: 'statement-verified',
      reason: 'statement-verified',
      statementDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      trustPolicyDigest: value.input.expectedPolicyDigest,
      keyId: value.statement.keyId,
      platform: 'linux',
      architecture: 'x64',
      backend: 'linux-namespace-cgroup-broker',
      commandCount: 2,
      signatureVerified: true,
    });
    allAuthorityFalse(result);
  });

  it('produces deterministic policy, payload, key, and statement identities', () => {
    const first = fixture();
    const secondResult = inspectVerifierExecutionAuthorityV2(first.input);
    const thirdResult = inspectVerifierExecutionAuthorityV2(structuredClone(first.input));
    expect(verifierExecutionAuthorityTrustPolicyDigest(first.policy))
      .toBe(first.input.expectedPolicyDigest);
    expect(canonicalVerifierExecutionAuthorityPayloadV2(first.unsigned))
      .toEqual(canonicalVerifierExecutionAuthorityPayloadV2(structuredClone(first.unsigned)));
    const reversed = Object.fromEntries(Object.entries(first.unsigned).reverse());
    expect(canonicalVerifierExecutionAuthorityPayloadV2(reversed))
      .toEqual(canonicalVerifierExecutionAuthorityPayloadV2(first.unsigned));
    expect(verifierExecutionAuthorityKeyId(first.policy.keys[0]!.publicKeySpki))
      .toBe(first.statement.keyId);
    expect(secondResult.state).toBe('statement-verified');
    expect(thirdResult.state).toBe('statement-verified');
    expect(thirdResult.statementDigest).toBe(secondResult.statementDigest);
  });

  it.each([
    'ticketDigest', 'candidateDigest', 'baseDigest', 'commandPlanDigest', 'capsuleTreeDigest',
    'executableDigest', 'dependencyDigest', 'brokerDigest', 'isolationPolicyDigest',
  ] as const)('binds caller expectation %s independently of the signer', (field) => {
    const value = fixture();
    const result = inspectVerifierExecutionAuthorityV2({
      ...value.input,
      expectedBindings: { ...value.input.expectedBindings, [field]: digest(`wrong-${field}`) },
    });
    expect(result.reason).toBe('binding-mismatch');
    allAuthorityFalse(result);
  });

  it('binds exact command IDs, entrypoints, capsule root, and platform tuple', () => {
    const value = fixture();
    const mismatches = [
      { commandEntrypoints: [{ commandId: 'test', entrypoint: '/opt/ashlr/verifier-capsule/entrypoints/other' }] },
      { capsuleRoot: '/opt/ashlr/verifier-capsule-v2' },
      { architecture: 'arm64' },
    ];
    for (const mismatch of mismatches) {
      const result = inspectVerifierExecutionAuthorityV2({
        ...value.input,
        expectedBindings: { ...value.input.expectedBindings, ...mismatch },
      });
      expect(result.reason).toBe('binding-mismatch');
      allAuthorityFalse(result);
    }
  });

  it('rejects statement mutation and signatures from a different key', () => {
    const value = fixture();
    expect(inspectVerifierExecutionAuthorityV2({
      ...value.input,
      statement: { ...value.statement, capsuleTreeDigest: digest('tampered') },
      expectedBindings: { ...value.input.expectedBindings, capsuleTreeDigest: digest('tampered') },
    }).reason).toBe('signature-invalid');

    const other = generateKeyPairSync('ed25519');
    const payload = canonicalVerifierExecutionAuthorityPayloadV2(value.unsigned);
    if (!payload) throw new Error('fixture payload missing');
    expect(inspectVerifierExecutionAuthorityV2({
      ...value.input,
      statement: { ...value.statement, signature: sign(null, payload, other.privateKey).toString('base64url') },
    }).reason).toBe('signature-invalid');
  });

  it('requires both caller-pinned and statement-bound policy identity', () => {
    const value = fixture();
    expect(inspectVerifierExecutionAuthorityV2({
      ...value.input, expectedPolicyDigest: digest('different-policy'),
    }).reason).toBe('trust-policy-digest-mismatch');
    expect(inspectVerifierExecutionAuthorityV2(resign(value, {
      trustPolicyDigest: digest('different-policy'),
    })).reason).toBe('trust-policy-digest-mismatch');
  });

  it('rejects unknown signers and malformed or relabeled key material', () => {
    const value = fixture();
    const other = generateKeyPairSync('ed25519');
    const otherSpki = publicKeySpki(other.publicKey);
    const otherKeyId = verifierExecutionAuthorityKeyId(otherSpki);
    if (!otherKeyId) throw new Error('other key invalid');
    expect(inspectVerifierExecutionAuthorityV2(resign(value, { keyId: otherKeyId })).reason)
      .toBe('trust-key-unknown');

    const relabeled = {
      ...value.policy,
      keys: [{ ...value.policy.keys[0]!, publicKeySpki: otherSpki }],
    };
    expect(verifierExecutionAuthorityTrustPolicyDigest(relabeled)).toBeNull();
    expect(inspectVerifierExecutionAuthorityV2({
      ...value.input, trustPolicy: relabeled,
    }).reason).toBe('trust-policy-invalid');

    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(verifierExecutionAuthorityKeyId(publicKeySpki(rsa.publicKey))).toBeNull();
  });

  it('enforces key scope and validity independently of statement validity', () => {
    const value = fixture();
    const scopedPolicy = {
      ...value.policy,
      keys: [{ ...value.policy.keys[0]!, allowedArchitectures: ['arm64'] as ['arm64'] }],
    };
    const scopedDigest = verifierExecutionAuthorityTrustPolicyDigest(scopedPolicy);
    if (!scopedDigest) throw new Error('scoped policy invalid');
    expect(inspectVerifierExecutionAuthorityV2({
      ...resign(value, { trustPolicyDigest: scopedDigest }),
      trustPolicy: scopedPolicy,
      expectedPolicyDigest: scopedDigest,
    }).reason).toBe('trust-key-invalid');

    const inactivePolicy = {
      ...value.policy,
      keys: [{ ...value.policy.keys[0]!, notAfter: '2026-08-02T14:30:00.000Z' }],
    };
    const inactiveDigest = verifierExecutionAuthorityTrustPolicyDigest(inactivePolicy);
    if (!inactiveDigest) throw new Error('inactive policy invalid');
    expect(inspectVerifierExecutionAuthorityV2({
      ...resign(value, { trustPolicyDigest: inactiveDigest }),
      trustPolicy: inactivePolicy,
      expectedPolicyDigest: inactiveDigest,
    }).reason).toBe('trust-key-inactive');
  });

  it.each([
    ['npm', 'command-resolution-forbidden'],
    ['/usr/bin/test', 'command-resolution-forbidden'],
    ['/opt/ashlr/verifier-capsule/entrypoints/npm', 'command-resolution-forbidden'],
    ['/opt/ashlr/verifier-capsule/entrypoints/npx', 'command-resolution-forbidden'],
    ['/opt/ashlr/verifier-capsule/entrypoints/bash', 'command-resolution-forbidden'],
    ['/opt/ashlr/verifier-capsule/entrypoints/../test', 'command-resolution-forbidden'],
    ['/opt/ashlr/verifier-capsule/entrypoints/repo/test', 'command-resolution-forbidden'],
    ['/opt/ashlr/verifier-capsule/entrypoints/node_modules/tool', 'command-resolution-forbidden'],
    ['/opt/ashlr/verifier-capsule/entrypoints/.bin/tool', 'command-resolution-forbidden'],
    ['/opt/ashlr/verifier-capsule/entrypoints/test:stream', 'command-resolution-forbidden'],
  ])('rejects PATH, shell, package-manager, or repository resolution: %s', (entrypoint, reason) => {
    const value = fixture();
    const result = inspectVerifierExecutionAuthorityV2(resign(value, {
      commandEntrypoints: [{ commandId: 'test', entrypoint }],
    }));
    expect(result.reason).toBe(reason);
    allAuthorityFalse(result);
  });

  it.each(WINDOWS_RESOLVER_ALIASES)(
    'rejects Windows shell, interpreter, or package-manager alias %s',
    (alias) => {
      const value = fixture();
      const result = inspectVerifierExecutionAuthorityV2(windowsEntrypointInput(
        value,
        `C:\\ashlr-verifier-capsule\\entrypoints\\${alias}`,
      ));
      expect(result.reason).toBe('command-resolution-forbidden');
      allAuthorityFalse(result);
    },
  );

  it.each([
    'CON', 'con.txt', 'PRN', 'prn.exe', 'AUX', 'NUL', 'nul.log', 'COM1', 'COM9.txt',
    'LPT1', 'LPT9.exe', 'CLOCK$', 'CONIN$', 'CONOUT$',
  ])('rejects Windows reserved device component %s', (component) => {
    const value = fixture();
    const result = inspectVerifierExecutionAuthorityV2(windowsEntrypointInput(
      value,
      `C:\\ashlr-verifier-capsule\\entrypoints\\tools\\${component}`,
    ));
    expect(result.reason).toBe('command-resolution-forbidden');
    allAuthorityFalse(result);
  });

  it.each([
    'C:\\ashlr-verifier-capsule\\entrypoints\\runner.',
    'C:\\ashlr-verifier-capsule\\entrypoints\\runner ',
    'C:\\ashlr-verifier-capsule\\entrypoints\\runner:payload',
    '\\\\server\\share\\entrypoints\\runner.exe',
    '\\\\?\\C:\\ashlr-verifier-capsule\\entrypoints\\runner.exe',
    '\\\\.\\C:\\ashlr-verifier-capsule\\entrypoints\\runner.exe',
    'C:ashlr-verifier-capsule\\entrypoints\\runner.exe',
    'c:\\ashlr-verifier-capsule\\entrypoints\\runner.exe',
    'D:\\ashlr-verifier-capsule\\entrypoints\\runner.exe',
    'C:\\\\ashlr-verifier-capsule\\entrypoints\\runner.exe',
  ])('rejects noncanonical or ambiguous Windows path %s', (entrypoint) => {
    const value = fixture();
    const result = inspectVerifierExecutionAuthorityV2(windowsEntrypointInput(value, entrypoint));
    expect(result.reason).toBe('command-resolution-forbidden');
    allAuthorityFalse(result);
  });

  it('preserves a legitimate absolute Windows capsule-native executable', () => {
    const value = fixture();
    const result = inspectVerifierExecutionAuthorityV2(windowsEntrypointInput(
      value,
      'C:\\ashlr-verifier-capsule\\entrypoints\\ashlr-native-test-runner.exe',
    ));
    expect(result.reason).toBe('statement-verified');
    allAuthorityFalse(result);
  });

  it('requires a nonempty, sorted, unique, bounded exact command map', () => {
    const value = fixture();
    const cases: unknown[] = [
      [],
      [
        { commandId: 'typecheck', entrypoint: '/opt/ashlr/verifier-capsule/entrypoints/typecheck' },
        { commandId: 'test', entrypoint: '/opt/ashlr/verifier-capsule/entrypoints/test' },
      ],
      [
        { commandId: 'test', entrypoint: '/opt/ashlr/verifier-capsule/entrypoints/test' },
        { commandId: 'test', entrypoint: '/opt/ashlr/verifier-capsule/entrypoints/test-2' },
      ],
      Array.from({ length: 65 }, (_, index) => ({
        commandId: `c${String(index).padStart(2, '0')}`,
        entrypoint: `/opt/ashlr/verifier-capsule/entrypoints/c${index}`,
      })),
    ];
    const sparse = new Array(1);
    cases.push(sparse);
    for (const commandEntrypoints of cases) {
      expect(inspectVerifierExecutionAuthorityV2(resign(value, { commandEntrypoints })).reason)
        .toBe('command-map-invalid');
    }
  });

  it.each([
    'fallback', 'sandbox-exec', 'docker', 'bwrap', 'host', 'none',
  ])('rejects unsupported or fallback backend %s', (backend) => {
    const value = fixture();
    expect(inspectVerifierExecutionAuthorityV2(resign(value, { backend })).reason)
      .toBe('unsupported-backend');
  });

  it('rejects backend/platform mismatch and noncanonical capsule roots', () => {
    const value = fixture();
    expect(inspectVerifierExecutionAuthorityV2(resign(value, {
      backend: 'macos-virtualization-framework-broker',
    })).reason).toBe('backend-platform-mismatch');
    expect(inspectVerifierExecutionAuthorityV2(resign(value, {
      capsuleRoot: '/tmp/capsule',
      commandEntrypoints: [{ commandId: 'test', entrypoint: '/tmp/capsule/entrypoints/test' }],
    })).reason).toBe('command-map-invalid');
  });

  it.each([
    {
      platform: 'darwin',
      architecture: 'arm64',
      backend: 'macos-virtualization-framework-broker',
      capsuleRoot: '/opt/ashlr/verifier-capsule',
      entrypoint: '/opt/ashlr/verifier-capsule/entrypoints/test',
    },
    {
      platform: 'win32',
      architecture: 'x64',
      backend: 'windows-appcontainer-job-broker',
      capsuleRoot: 'C:\\ashlr-verifier-capsule',
      entrypoint: 'C:\\ashlr-verifier-capsule\\entrypoints\\test',
    },
  ] as const)('verifies the fixed $platform capsule tuple without enabling it', (platformCase) => {
    const value = fixture();
    const commandEntrypoints = [{ commandId: 'test', entrypoint: platformCase.entrypoint }];
    const {
      entrypoint: _entrypoint,
      ...platformBindings
    } = platformCase;
    const input = resign(value, { ...platformBindings, commandEntrypoints });
    input.expectedBindings = {
      ...input.expectedBindings,
      platform: platformCase.platform,
      architecture: platformCase.architecture,
      backend: platformCase.backend,
      capsuleRoot: platformCase.capsuleRoot,
      commandEntrypoints: structuredClone(commandEntrypoints),
    };
    const result = inspectVerifierExecutionAuthorityV2(input);
    expect(result.reason).toBe('statement-verified');
    allAuthorityFalse(result);
  });

  it.each([
    ['candidateMount', 'writable'],
    ['hostMounts', ['/Users/example']],
    ['networkPolicy', 'allowed'],
    ['descendantOwnership', 'process-group-best-effort'],
    ['capsuleMutability', 'writable'],
  ])('rejects weakened isolation claim %s', (field, weakened) => {
    const value = fixture();
    const result = inspectVerifierExecutionAuthorityV2(resign(value, { [field]: weakened }));
    expect(result.reason).toBe('isolation-claims-invalid');
    allAuthorityFalse(result);
  });

  it.each([
    ['executionPermitted', true], ['mergePermitted', true], ['evidencePermitted', true],
  ])('rejects a statement that claims %s', (field, enabled) => {
    const value = fixture();
    expect(inspectVerifierExecutionAuthorityV2(resign(value, { [field]: enabled })).reason)
      .toBe('statement-invalid');
  });

  it('enforces canonical bounded timestamps, nonce, and lifetime', () => {
    const value = fixture();
    expect(inspectVerifierExecutionAuthorityV2({
      ...value.input, nowMs: Date.parse(EXPIRES_AT),
    }).reason).toBe('statement-expired');
    expect(inspectVerifierExecutionAuthorityV2({
      ...resign(value, { issuedAt: '2026-08-02T15:06:00.000Z' }), nowMs: NOW,
    }).reason).toBe('statement-not-current');
    expect(inspectVerifierExecutionAuthorityV2(resign(value, {
      expiresAt: '2026-08-02T15:11:00.001Z',
    })).reason).toBe('statement-lifetime-invalid');
    expect(inspectVerifierExecutionAuthorityV2(resign(value, {
      nonce: Buffer.alloc(8).toString('base64url'),
    })).reason).toBe('statement-invalid');
    expect(inspectVerifierExecutionAuthorityV2(resign(value, {
      issuedAt: '2026-08-02 15:00:00Z',
    })).reason).toBe('statement-invalid');
  });

  it('rejects unknown fields, accessors, cycles, sparse policies, and oversized policies', () => {
    const value = fixture();
    expect(inspectVerifierExecutionAuthorityV2({ ...value.input, extra: true }).reason)
      .toBe('invalid-input');
    expect(inspectVerifierExecutionAuthorityV2({
      ...value.input, statement: { ...value.statement, extra: true },
    }).reason).toBe('statement-invalid');
    expect(inspectVerifierExecutionAuthorityV2({
      ...value.input, expectedBindings: { ...value.input.expectedBindings, extra: true },
    }).reason).toBe('binding-mismatch');

    const accessor = { ...value.input } as Record<string, unknown>;
    Object.defineProperty(accessor, 'statement', { enumerable: true, get: () => value.statement });
    expect(inspectVerifierExecutionAuthorityV2(accessor).reason).toBe('invalid-input');
    const cyclic: Record<string, unknown> = { ...value.input };
    cyclic['cycle'] = cyclic;
    expect(inspectVerifierExecutionAuthorityV2(cyclic).reason).toBe('invalid-input');

    const sparseKeys = new Array(1);
    expect(inspectVerifierExecutionAuthorityV2({
      ...value.input, trustPolicy: { ...value.policy, keys: sparseKeys },
    }).reason).toBe('trust-policy-invalid');
    expect(inspectVerifierExecutionAuthorityV2({
      ...value.input,
      trustPolicy: { ...value.policy, keys: Array.from({ length: 17 }, () => value.policy.keys[0]!) },
    }).reason).toBe('invalid-input');
  });

  it('withholds caller-controlled content from all rejected projections', () => {
    const value = fixture();
    const secret = 'github_pat_capsule_secret_canary_473';
    const result = inspectVerifierExecutionAuthorityV2({
      ...value.input,
      statement: { ...value.statement, [secret]: secret },
    });
    expect(result.state).toBe('withheld');
    expect(result).toMatchObject({
      statementDigest: null,
      trustPolicyDigest: null,
      keyId: null,
      platform: null,
      architecture: null,
      backend: null,
      commandCount: 0,
      signatureVerified: false,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    allAuthorityFalse(result);
  });

  it('imports no execution, filesystem, clock, environment, or network authority', () => {
    const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
    const source = readFileSync(join(root, 'src/core/run/verifier-execution-authority.ts'), 'utf8');
    expect(source).not.toMatch(/node:(?:child_process|fs|fs\/promises|net|http|https|http2|dns|tls|dgram|worker_threads)/);
    expect(source).not.toMatch(/\b(?:spawn|spawnSync|exec|execFile|fork|fetch|WebSocket)\s*\(/);
    expect(source).not.toMatch(/process\.(?:env|cwd|chdir)|Date\.now\s*\(|performance\.now\s*\(/);
    expect(source).not.toMatch(/generateKeyPair|createPrivateKey|randomBytes|randomUUID|\bsign\s*\(/);
    expect(source).not.toMatch(/writeFile|mkdir|rename|unlink|chmod|chown|openSync|createWriteStream/);
  });

  it('has no runtime wiring from any other production module', () => {
    const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
    const sourceRoot = join(root, 'src');
    const target = 'verifier-execution-authority.js';
    const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
      .flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return files(path);
        return entry.isFile() && /\.ts$/.test(entry.name) ? [path] : [];
      });
    const references = files(sourceRoot).filter((path) =>
      !path.endsWith('verifier-execution-authority.ts') && readFileSync(path, 'utf8').includes(target));
    expect(references.map((path) => relative(root, path))).toEqual([]);
  });

  it('never returns authority on malformed values or hostile platform claims', () => {
    const value = fixture();
    const inputs: unknown[] = [
      null,
      undefined,
      'statement',
      {},
      { ...value.input, nowMs: -1 },
      resign(value, { platform: 'freebsd' }),
      resign(value, { architecture: 'riscv64' }),
      resign(value, { signatureAlgorithm: 'rsa-pss' }),
    ];
    for (const input of inputs) allAuthorityFalse(inspectVerifierExecutionAuthorityV2(input));
  });
});
