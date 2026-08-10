import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ENGINEERING_ASSIGNMENT_PROTOCOL,
  ENGINEERING_ASSIGNMENT_SIGNATURE_DOMAIN,
  ENGINEERING_ASSIGNMENT_VERSION,
  engineeringAssignmentDigest,
  parseEngineeringAssignmentV1,
  type EngineeringAssignmentV1,
} from '../src/core/fleet/cortex-engineering-assignment.js';
import {
  _validateCortexRelayShadowForTest,
  CORTEX_RELAY_SHADOW_TEST_CONTROL,
  type CortexRelayShadowInput,
  type CortexRelayShadowResult,
  type CortexRelayRepositoryObservation,
  type CortexRelayShadowDependencies,
} from '../src/core/fleet/cortex-relay-shadow.js';
import {
  _consumeCortexRelayShadowForTest,
  consumeCortexRelayShadow,
  _recordCortexRelayShadowOutcomeForTest,
} from '../src/core/fleet/cortex-relay-shadow-store.js';
import {
  inspectLocusV3ShadowAuthority,
  type LocusV3ShadowAuthoritySummary,
} from '../src/core/integrations/locus.js';
import type { CortexRelayTrustPolicy } from '../src/core/fleet/cortex-relay-trust.js';
import { _parseCortexRelayTrustPolicyForTest } from '../src/core/fleet/cortex-relay-trust.js';
import {
  resolveTrustedConfiguredExecutable,
  resolveTrustedSystemGit,
  verifySystemExecutablePin,
} from '../src/core/util/system-executable-custody.js';

const NOW = new Date('2026-08-10T12:00:00.000Z');
const SOURCE_COMMIT = '8133c090ef70d0bd4fa07e4d9098d82653079864';
const REPO = '/enrolled/ashlr-hub';
const RAW_OBJECTIVE = 'RAW_OBJECTIVE_CANARY_M499 Authorization Bearer m499-secret-token-value';
const RAW_PATH = 'src/RAW_FILE_CANARY_M499.ts';
const EXECUTOR = 'a'.repeat(64);
const PROVENANCE_KEY = Buffer.alloc(32, 0x49);
const tempRoots: string[] = [];
const ORIGINAL_LOCUS_BIN = process.env.LOCUS_BIN;
const ORIGINAL_PATH = process.env.PATH;
const { privateKey: CORTEX_PRIVATE_KEY, publicKey: CORTEX_PUBLIC_KEY } =
  generateKeyPairSync('ed25519');
const CORTEX_PUBLIC_PEM = CORTEX_PUBLIC_KEY.export({ format: 'pem', type: 'spki' }).toString();
const TRUST_POLICY: CortexRelayTrustPolicy = Object.freeze({
  schemaVersion: 1,
  issuer: 'ashlr-cortex',
  audience: 'ashlr-hub',
  organizationRef: 'org_acme',
  allowedWorkstreams: Object.freeze(['commercial']),
  publicKeys: Object.freeze({ cortex_m499: CORTEX_PUBLIC_PEM }),
  locusExecutable: '/usr/local/bin/locus',
});

function validateCortexRelayShadow(
  value: CortexRelayShadowInput,
  dependencies: Partial<CortexRelayShadowDependencies> = {},
): CortexRelayShadowResult {
  return _validateCortexRelayShadowForTest(
    CORTEX_RELAY_SHADOW_TEST_CONTROL,
    value,
    dependencies,
  );
}

function assignment(
  patch: Partial<Omit<EngineeringAssignmentV1, 'assignmentDigest' | 'assignmentSignature'>> = {},
): EngineeringAssignmentV1 {
  const unsigned: Omit<EngineeringAssignmentV1, 'assignmentDigest' | 'assignmentSignature'> = {
    protocol: ENGINEERING_ASSIGNMENT_PROTOCOL,
    version: ENGINEERING_ASSIGNMENT_VERSION,
    issuer: 'ashlr-cortex',
    audience: 'ashlr-hub',
    keyId: 'cortex_m499',
    assignmentId: 'run_m499',
    runId: 'run_m499',
    issuedAt: NOW.toISOString(),
    expiresAt: '2026-08-10T13:00:00.000Z',
    organizationRef: 'org_acme',
    workstream: 'commercial',
    repo: {
      owner: 'ashlrai',
      name: 'ashlr-hub',
      defaultBranch: 'master',
      sourceCommit: SOURCE_COMMIT,
    },
    mission: {
      objective: RAW_OBJECTIVE,
      successSignals: ['Focused tests pass'],
      guardrails: ['Do not merge or deploy'],
      allowedFiles: [RAW_PATH],
    },
    resultContract: {
      kind: 'verified-proposal',
      requireDiff: true,
      requireProposal: true,
      requireVerification: true,
      maxChangedFiles: 12,
      maxChangedLines: 800,
    },
    authority: { effect: 'proposal-only', requiredTenantRef: 'org_acme' },
    ...patch,
  };
  const assignmentDigest = engineeringAssignmentDigest(unsigned);
  const assignmentSignature = `ed25519:${sign(
    null,
    Buffer.from(`${ENGINEERING_ASSIGNMENT_SIGNATURE_DOMAIN}\0${assignmentDigest}`, 'utf8'),
    CORTEX_PRIVATE_KEY,
  ).toString('base64url')}`;
  return { ...unsigned, assignmentDigest, assignmentSignature };
}

function locusSummary(
  patch: Partial<LocusV3ShadowAuthoritySummary> = {},
): LocusV3ShadowAuthoritySummary {
  return {
    schemaVersion: 1,
    authority: 'delegated',
    backingType: 'ci',
    sessionRefDigest: `sha256:${'1'.repeat(64)}`,
    tenantRefDigest: `sha256:${'2'.repeat(64)}`,
    expiresAt: '2026-08-10T12:30:00.000Z',
    frozen: false,
    executorCapabilityPresent: true,
    ...patch,
  };
}

function observation(patch: Partial<CortexRelayRepositoryObservation> = {}): CortexRelayRepositoryObservation {
  return {
    repoPath: REPO,
    nameWithOwner: 'ashlrai/ashlr-hub',
    defaultBranch: 'master',
    sourceCommit: SOURCE_COMMIT,
    dev: 1,
    ino: 2,
    authority: 'local-tracking-ref',
    ...patch,
  };
}

function dependencies(
  patch: Partial<CortexRelayShadowDependencies> = {},
): CortexRelayShadowDependencies {
  return {
    now: () => NOW,
    loadPolicy: () => TRUST_POLICY,
    listEnrolledRepos: () => [REPO],
    observeRepository: () => observation(),
    observeLocusAuthority: () => locusSummary(),
    ...patch,
  };
}

function input(value: unknown = assignment()) {
  return { assignment: value };
}

function resign(value: Record<string, unknown>): Record<string, unknown> {
  const { assignmentDigest: _digest, assignmentSignature: _signature, ...unsigned } = value;
  const assignmentDigest = engineeringAssignmentDigest(
    unsigned as Omit<EngineeringAssignmentV1, 'assignmentDigest' | 'assignmentSignature'>,
  );
  return {
    ...unsigned,
    assignmentDigest,
    assignmentSignature: `ed25519:${sign(
      null,
      Buffer.from(`${ENGINEERING_ASSIGNMENT_SIGNATURE_DOMAIN}\0${assignmentDigest}`, 'utf8'),
      CORTEX_PRIVATE_KEY,
    ).toString('base64url')}`,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_LOCUS_BIN === undefined) delete process.env.LOCUS_BIN;
  else process.env.LOCUS_BIN = ORIGINAL_LOCUS_BIN;
  if (ORIGINAL_PATH === undefined) delete process.env.PATH;
  else process.env.PATH = ORIGINAL_PATH;
  vi.resetModules();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('M499 Cortex engineering assignment protocol', () => {
  it('is byte-compatible with the producer digest and freezes valid envelopes', () => {
    const value = assignment();
    expect(value.assignmentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const parsed = parseEngineeringAssignmentV1(value, { now: NOW, verifier: TRUST_POLICY });
    expect(parsed).toEqual(value);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.repo)).toBe(true);
  });

  it('binds issuer, audience, key id, replay identity, digest, and canonical Ed25519 bytes', () => {
    const value = assignment();
    const { assignmentDigest: _digest, assignmentSignature: _signature, ...unsigned } = value;
    const reordered = {
      ...unsigned,
      repo: {
        sourceCommit: unsigned.repo.sourceCommit,
        defaultBranch: unsigned.repo.defaultBranch,
        name: unsigned.repo.name,
        owner: unsigned.repo.owner,
      },
      resultContract: {
        maxChangedLines: unsigned.resultContract.maxChangedLines,
        maxChangedFiles: unsigned.resultContract.maxChangedFiles,
        requireVerification: true as const,
        requireProposal: true as const,
        requireDiff: true as const,
        kind: 'verified-proposal' as const,
      },
    };
    expect(engineeringAssignmentDigest(reordered)).toBe(value.assignmentDigest);
    for (const policy of [
      { ...TRUST_POLICY, issuer: 'other-cortex' },
      { ...TRUST_POLICY, audience: 'other-hub' },
      { ...TRUST_POLICY, publicKeys: { other_key: CORTEX_PUBLIC_PEM } },
      { ...TRUST_POLICY, publicKeys: { cortex_m499: CORTEX_PRIVATE_KEY } },
    ]) {
      expect(parseEngineeringAssignmentV1(value, { now: NOW, verifier: policy })).toBeNull();
    }

    const replayMismatch = structuredClone(value) as unknown as Record<string, unknown>;
    replayMismatch.assignmentId = 'assignment_m499';
    expect(parseEngineeringAssignmentV1(resign(replayMismatch), {
      now: NOW, verifier: TRUST_POLICY,
    })).toBeNull();

    const forgedDigest = { ...value, assignmentDigest: `sha256:${'0'.repeat(64)}` };
    expect(parseEngineeringAssignmentV1(forgedDigest, { now: NOW, verifier: TRUST_POLICY })).toBeNull();

    const encoded = value.assignmentSignature.slice('ed25519:'.length);
    for (const suffix of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_') {
      if (suffix === encoded.at(-1)) continue;
      const malleable = { ...value, assignmentSignature: `ed25519:${encoded.slice(0, -1)}${suffix}` };
      expect(parseEngineeringAssignmentV1(malleable, {
        now: NOW, verifier: TRUST_POLICY,
      })).toBeNull();
    }
  });

  it.each([
    ['cwd', '/tmp/attacker'],
    ['path', '/tmp/attacker'],
    ['locusBinding', 'operator-binding'],
    ['merge', true],
    ['deploy', true],
    ['env', { GITHUB_TOKEN: 'secret' }],
    ['stdout', 'raw output'],
    ['stderr', 'raw error'],
  ])('rejects network-supplied %s before repository observation', (field, value) => {
    const hostile = { ...assignment(), [field]: value };
    const observe = vi.fn(() => observation());
    const result = validateCortexRelayShadow(input(hostile), dependencies({ observeRepository: observe }));
    expect(result.accepted).toBe(false);
    expect(result.metadata.reason).toBe('invalid-assignment');
    expect(observe).not.toHaveBeenCalled();
    expect(result.metadata.effects).toEqual({
      agentsSpawned: 0, proposalsCreated: 0, repositoriesMutated: 0, merges: 0, deployments: 0,
    });
  });

  it('rejects tampering, expiry, traversal, widened authority, and tenant mismatch', () => {
    const tampered = structuredClone(assignment()) as unknown as Record<string, unknown>;
    (tampered.repo as Record<string, unknown>).name = 'other';
    expect(parseEngineeringAssignmentV1(tampered, { now: NOW, verifier: TRUST_POLICY })).toBeNull();

    const traversal = structuredClone(assignment()) as unknown as Record<string, unknown>;
    (traversal.mission as Record<string, unknown>).allowedFiles = ['../outside'];
    expect(parseEngineeringAssignmentV1(resign(traversal), { now: NOW, verifier: TRUST_POLICY })).toBeNull();

    for (const bypass of ['{..,src}/secret', 'src/[.][.]/secret', 'src/%2e%2e/secret']) {
      const encoded = structuredClone(assignment()) as unknown as Record<string, unknown>;
      (encoded.mission as Record<string, unknown>).allowedFiles = [bypass];
      expect(parseEngineeringAssignmentV1(resign(encoded), {
        now: NOW, verifier: TRUST_POLICY,
      })).toBeNull();
    }

    const widened = structuredClone(assignment()) as unknown as Record<string, unknown>;
    (widened.authority as Record<string, unknown>).merge = true;
    expect(parseEngineeringAssignmentV1(resign(widened), { now: NOW, verifier: TRUST_POLICY })).toBeNull();

    expect(parseEngineeringAssignmentV1(assignment(), {
      now: new Date('2026-08-10T13:00:00.000Z'),
      verifier: TRUST_POLICY,
    })).toBeNull();
    expect(validateCortexRelayShadow(input(), dependencies({
      observeLocusAuthority: () => null,
    })).metadata.reason).toBe('locus-authority-invalid');
  });
});

describe('M499 shadow admission', () => {
  it('accepts only an exact bounded Hub trust policy', () => {
    expect(_parseCortexRelayTrustPolicyForTest(TRUST_POLICY)).toEqual(TRUST_POLICY);
    for (const invalid of [
      { ...TRUST_POLICY, extra: true },
      { ...TRUST_POLICY, locusExecutable: 'locus' },
      { ...TRUST_POLICY, allowedWorkstreams: ['commercial', 'commercial'] },
      { ...TRUST_POLICY, publicKeys: {} },
      { ...TRUST_POLICY, issuer: '../cortex' },
    ]) {
      expect(_parseCortexRelayTrustPolicyForTest(invalid)).toBeNull();
    }
  });

  it('loads trust only from Hub policy and fails before observation when unavailable', () => {
    const observe = vi.fn(() => observation());
    const missing = validateCortexRelayShadow(input(), dependencies({
      loadPolicy: () => null,
      observeRepository: observe,
    }));
    expect(missing.metadata.reason).toBe('policy-unavailable');
    expect(observe).not.toHaveBeenCalled();

    const callerOverride = {
      ...input(),
      policy: {
        issuer: 'attacker', audience: 'attacker', organizationRef: 'org_other',
        publicKeys: {}, allowedWorkstreams: ['commercial'], locusExecutable: '/tmp/locus',
      },
    } as CortexRelayShadowInput;
    const observed = validateCortexRelayShadow(callerOverride, dependencies());
    expect(observed.observed).toBe(true);
    expect(observed.metadata.tenantRefDigest).toBe(
      'sha256:a6106492981cc123f51cff54ddf4b8098342f75175ccdfed298ef677153b5e2f',
    );
  });

  it('resolves only the enrolled owner/name but remains observation-only and non-consumable', () => {
    const observe = vi.fn(() => observation());
    const result = validateCortexRelayShadow(input(), dependencies({ observeRepository: observe }));
    expect(result.accepted).toBe(false);
    expect(result.observed, JSON.stringify(result.metadata)).toBe(true);
    if (!result.observed) throw new Error('expected completed shadow observation');
    expect(observe).toHaveBeenCalledTimes(3);
    expect(observe).toHaveBeenNthCalledWith(1, REPO);
    expect(observe).toHaveBeenNthCalledWith(2, REPO);
    expect(observe).toHaveBeenNthCalledWith(3, REPO);
    expect(result.repoPath).toBe(REPO);
    expect(result.metadata.reason).toBe('observation-only');
    expect(result.metadata.accepted).toBe(false);
    expect(result.metadata.consumable).toBe(false);
    expect(result.metadata.authorityGranted).toBe(false);
    expect(result.metadata.executionAuthority).toBe(false);
  });

  it.each([
    ['unknown-repository', () => dependencies({
      observeRepository: () => observation({ nameWithOwner: 'ashlrai/other' }),
    })],
    ['default-branch-mismatch', () => dependencies({
      observeRepository: () => observation({ defaultBranch: 'main' }),
    })],
    ['stale-source', () => dependencies({
      observeRepository: () => observation({ sourceCommit: '1'.repeat(40) }),
    })],
    ['organization-mismatch', () => dependencies({
      loadPolicy: () => ({ ...TRUST_POLICY, organizationRef: 'org_other' }),
    })],
    ['workstream-denied', () => dependencies({
      loadPolicy: () => ({ ...TRUST_POLICY, allowedWorkstreams: ['company'] }),
    })],
  ] as const)('fails closed for %s', (reason, makeDeps) => {
    expect(validateCortexRelayShadow(input(), makeDeps()).metadata.reason).toBe(reason);
  });

  it('rejects enrollment and repository identity races', () => {
    let enrollmentReads = 0;
    const enrollmentRace = validateCortexRelayShadow(input(), dependencies({
      listEnrolledRepos: () => ++enrollmentReads === 1 ? [REPO] : [REPO, '/enrolled/other'],
    }));
    expect(enrollmentRace.metadata.reason).toBe('repository-identity-changed');

    let observations = 0;
    const sourceRace = validateCortexRelayShadow(input(), dependencies({
      observeRepository: () => observation(observations++ === 0 ? {} : { sourceCommit: '2'.repeat(40) }),
    }));
    expect(sourceRace.metadata.reason).toBe('repository-identity-changed');
  });

  it('fails closed when any enrolled repository is unavailable during exact resolution', () => {
    const result = validateCortexRelayShadow(input(), dependencies({
      listEnrolledRepos: () => [REPO, '/enrolled/unavailable'],
      observeRepository: (repoPath) => repoPath === REPO ? observation() : null,
    }));
    expect(result.metadata.reason).toBe('repository-unavailable');
  });

  it('rejects a second enrolled path becoming an ambiguous target between epochs', () => {
    let observations = 0;
    const result = validateCortexRelayShadow(input(), dependencies({
      listEnrolledRepos: () => [REPO, '/enrolled/other'],
      observeRepository: (repoPath) => {
        observations += 1;
        if (repoPath === REPO) return observation();
        return observation({
          repoPath,
          nameWithOwner: observations <= 2 ? 'ashlrai/other' : 'ashlrai/ashlr-hub',
          ino: 3,
        });
      },
    }));
    expect(result.metadata.reason).toBe('repository-identity-changed');
  });

  it('honors cancellation before reads and between observation epochs', () => {
    const controller = new AbortController();
    controller.abort();
    const list = vi.fn(() => [REPO]);
    expect(validateCortexRelayShadow({ ...input(), signal: controller.signal }, dependencies({
      listEnrolledRepos: list,
    })).metadata.reason).toBe('cancelled');
    expect(list).not.toHaveBeenCalled();

    const during = new AbortController();
    const observe = vi.fn(() => observation());
    const result = validateCortexRelayShadow({ ...input(), signal: during.signal }, dependencies({
      observeRepository: observe,
      onPhase: (phase) => { if (phase === 'repository-observed') during.abort(); },
    }));
    expect(result.metadata.reason).toBe('cancelled');
    expect(observe).toHaveBeenCalledTimes(1);

    const midScan = new AbortController();
    const scanObserve = vi.fn((repoPath: string) => {
      if (repoPath === REPO) midScan.abort();
      return observation();
    });
    const scanResult = validateCortexRelayShadow({ ...input(), signal: midScan.signal }, dependencies({
      listEnrolledRepos: () => [REPO, '/enrolled/other'],
      observeRepository: scanObserve,
    }));
    expect(scanResult.metadata.reason).toBe('cancelled');
    expect(scanObserve).toHaveBeenCalledTimes(1);
  });

  it('rechecks expiry immediately before publishing an eligible receipt', () => {
    let reads = 0;
    const result = validateCortexRelayShadow(input(), dependencies({
      now: () => ++reads === 1 ? NOW : new Date('2026-08-10T13:00:00.000Z'),
    }));
    expect(result.metadata.reason).toBe('invalid-assignment');
    expect(result.metadata.accepted).toBe(false);
  });

  it('rechecks Locus expiry immediately before publishing an eligible receipt', () => {
    let authorityReads = 0;
    const result = validateCortexRelayShadow(input(), dependencies({
      observeLocusAuthority: () => ++authorityReads === 1 ? locusSummary() : null,
    }));
    expect(result.metadata.reason).toBe('locus-authority-invalid');
    expect(result.metadata.accepted).toBe(false);
  });

  it('rejects Locus authority mutated after its first validation', () => {
    let authorityReads = 0;
    const result = validateCortexRelayShadow(input(), dependencies({
      observeLocusAuthority: () => ++authorityReads === 1 ? locusSummary() : locusSummary({
        sessionRefDigest: `sha256:${'3'.repeat(64)}`,
      }),
    }));
    expect(result.metadata.reason).toBe('locus-authority-invalid');
    expect(result.metadata.accepted).toBe(false);
  });

  it('observes every producer-valid allowed file without materializing an execution scope', () => {
    const allowedFiles = Array.from({ length: 250 }, (_, index) => `src/file-${index}.ts`);
    const result = validateCortexRelayShadow(input(assignment({
      mission: {
        objective: 'Large bounded assignment', successSignals: ['Tests pass'],
        guardrails: ['Do not merge'], allowedFiles,
      },
    })), dependencies());
    expect(result.observed).toBe(true);
    expect(result.metadata.resultContract?.allowedFileCount).toBe(250);
    expect(result).not.toHaveProperty('delegationScope');
  });

  it('uses the default read-only Git observer against an enrolled registry path', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ashlr-m499-repo-')));
    tempRoots.push(root);
    const repo = resolve(join(root, 'repo'));
    mkdirSync(repo, { mode: 0o700 });
    execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'm499@example.test'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'M499'], { cwd: repo });
    execFileSync('git', ['commit', '--allow-empty', '-qm', 'fixture'], { cwd: repo });
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/ashlrai/ashlr-hub.git'], { cwd: repo });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/master', commit], { cwd: repo });
    execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master'], { cwd: repo });
    const maliciousGit = join(root, 'git');
    const maliciousMarker = join(root, 'path-git-executed');
    writeFileSync(maliciousGit, `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(maliciousMarker)}\n`, {
      mode: 0o700,
    });
    process.env.PATH = `${root}:${ORIGINAL_PATH ?? ''}`;
    const result = validateCortexRelayShadow(input(assignment({
      repo: { owner: 'ashlrai', name: 'ashlr-hub', defaultBranch: 'master', sourceCommit: commit },
    })), {
      now: () => NOW,
      loadPolicy: () => TRUST_POLICY,
      listEnrolledRepos: () => [repo],
      observeLocusAuthority: () => locusSummary(),
    });
    expect(result.observed, JSON.stringify(result.metadata)).toBe(true);
    expect(result.observed && result.repoPath).toBe(repo);
    expect(existsSync(maliciousMarker)).toBe(false);
  });
});

describe('M499 Locus V3 and metadata receipts', () => {
  it('pins only root-owned explicit executables and revalidates their custody epoch', () => {
    const git = resolveTrustedSystemGit();
    if (process.platform === 'darwin' || process.platform === 'linux') {
      expect(git?.executable).toBe('/usr/bin/git');
      expect(git && verifySystemExecutablePin(git, { git: true })).toBe(true);
      expect(resolveTrustedConfiguredExecutable('/usr/bin/git')?.digest).toBe(git?.digest);
    } else {
      expect(git).toBeNull();
    }
  });

  function untrustedLocusFixture() {
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'ashlr-m499-locus-')));
    tempRoots.push(home);
    const marker = join(home, 'executed');
    const binPath = join(home, 'locus');
    writeFileSync(binPath, `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(marker)}\n`, { mode: 0o700 });
    return {
      home, marker, binPath,
      source: {
        PATH: home, HOME: '/ambient-home', LOCUS_HOME: home,
        LOCUS_SESSION_ID: 'ses_a11ce', LOCUS_EXECUTOR_CAPABILITY: EXECUTOR,
        GITHUB_TOKEN: 'raw-token', AWS_SECRET_ACCESS_KEY: 'raw-aws',
        LOCUS_CONTROL_CAPABILITY: 'operator-control',
      },
    };
  }

  it('rejects LOCUS_BIN, PATH, and same-UID configured executables before capability exposure', () => {
    const fixture = untrustedLocusFixture();
    process.env.LOCUS_BIN = fixture.binPath;
    expect(inspectLocusV3ShadowAuthority({
      requiredTenantRef: 'org_acme', executable: fixture.binPath, now: NOW, source: fixture.source,
    })).toBeNull();
    expect(existsSync(fixture.marker)).toBe(false);
  });

  it('persists only bounded metadata and deduplicates an assignment exactly once', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-m499-store-'));
    tempRoots.push(root);
    const result = validateCortexRelayShadow(input(), dependencies());
    expect(result.observed).toBe(true);
    const first = _recordCortexRelayShadowOutcomeForTest(
      CORTEX_RELAY_SHADOW_TEST_CONTROL, result.metadata, { root, provenanceKey: PROVENANCE_KEY },
    );
    const duplicate = _recordCortexRelayShadowOutcomeForTest(
      CORTEX_RELAY_SHADOW_TEST_CONTROL, result.metadata, { root, provenanceKey: PROVENANCE_KEY },
    );
    expect(first.state).toBe('recorded');
    expect(duplicate.state).toBe('duplicate');
    const dir = join(root, 'fleet', 'cortex-relay-shadow', 'records');
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const persisted = readFileSync(join(dir, files[0]!), 'utf8');
    expect(persisted).not.toContain(RAW_OBJECTIVE);
    expect(persisted).not.toContain(RAW_PATH);
    expect(persisted).not.toContain(EXECUTOR);
    expect(persisted).not.toContain('ses_a11ce');
    expect(persisted).not.toContain('org_acme');
    expect(persisted).not.toMatch(/stdout|stderr|environment|seal|token|objective/i);
    expect(JSON.parse(persisted)).toMatchObject({
      protocol: 'ashlr-cortex-relay-shadow-receipt/v1',
      signatureAlgorithm: 'hmac-sha256',
      metadata: {
        assignmentId: 'run_m499',
        repository: 'ashlrai/ashlr-hub',
        accepted: false,
        consumable: false,
        effects: { agentsSpawned: 0, proposalsCreated: 0, repositoriesMutated: 0 },
      },
    });
  });

  it('treats a reused assignment id with a different digest as a conflict', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-m499-conflict-'));
    tempRoots.push(root);
    const first = validateCortexRelayShadow(input(), dependencies());
    const changed = assignment({
      mission: {
        objective: 'Different objective', successSignals: ['Tests pass'],
        guardrails: ['Do not merge'], allowedFiles: ['src/other.ts'],
      },
    });
    const second = validateCortexRelayShadow(input(changed), dependencies());
    expect(_recordCortexRelayShadowOutcomeForTest(
      CORTEX_RELAY_SHADOW_TEST_CONTROL, first.metadata, { root, provenanceKey: PROVENANCE_KEY },
    ).state).toBe('recorded');
    expect(_recordCortexRelayShadowOutcomeForTest(
      CORTEX_RELAY_SHADOW_TEST_CONTROL, second.metadata, { root, provenanceKey: PROVENANCE_KEY },
    ).state).toBe('conflict');
  });

  it('refuses a corrupted prior receipt instead of trusting its idempotency state', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-m499-corrupt-'));
    tempRoots.push(root);
    const result = validateCortexRelayShadow(input(), dependencies());
    expect(_recordCortexRelayShadowOutcomeForTest(
      CORTEX_RELAY_SHADOW_TEST_CONTROL, result.metadata, { root, provenanceKey: PROVENANCE_KEY },
    ).state).toBe('recorded');
    const dir = join(root, 'fleet', 'cortex-relay-shadow', 'records');
    const path = join(dir, readdirSync(dir)[0]!);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const corrupted = { ...parsed, signature: `hmac-sha256:${'0'.repeat(64)}` };
    writeFileSync(path, `${JSON.stringify(corrupted)}\n`, { mode: 0o600 });
    expect(_recordCortexRelayShadowOutcomeForTest(
      CORTEX_RELAY_SHADOW_TEST_CONTROL, result.metadata, { root, provenanceKey: PROVENANCE_KEY },
    ).state).toBe('unavailable');
  });

  it('integrates validation and metadata persistence without an execution hook', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-m499-consume-'));
    tempRoots.push(root);
    const firstRepo = vi.fn(() => observation());
    const firstLocus = vi.fn(() => locusSummary());
    const first = _consumeCortexRelayShadowForTest(CORTEX_RELAY_SHADOW_TEST_CONTROL, input(), {
      validation: dependencies({
        observeRepository: firstRepo,
        observeLocusAuthority: firstLocus,
      }),
      root,
      provenanceKey: PROVENANCE_KEY,
    });
    const duplicateRepo = vi.fn(() => observation());
    const duplicateLocus = vi.fn(() => locusSummary());
    const duplicate = _consumeCortexRelayShadowForTest(CORTEX_RELAY_SHADOW_TEST_CONTROL, input(), {
      validation: dependencies({
        observeRepository: duplicateRepo,
        observeLocusAuthority: duplicateLocus,
      }),
      root,
      provenanceKey: PROVENANCE_KEY,
    });
    expect(first.validation.observed).toBe(true);
    expect(first.receipt.state).toBe('recorded');
    expect(first.receipt.metadata.reason).toBe('claim-only');
    expect(first.receipt.metadata).not.toHaveProperty('locus');
    expect(firstRepo).toHaveBeenCalled();
    expect(firstLocus).toHaveBeenCalled();
    expect(duplicate.validation.observed).toBe(false);
    expect(duplicate.validation.metadata.reason).toBe('claim-only');
    expect(duplicate.receipt.state).toBe('duplicate');
    expect(duplicateRepo).not.toHaveBeenCalled();
    expect(duplicateLocus).not.toHaveBeenCalled();
    expect(first.validation.metadata.effects).toEqual({
      agentsSpawned: 0, proposalsCreated: 0, repositoriesMutated: 0, merges: 0, deployments: 0,
    });
    expect(first.effectEligible).toBe(false);
  });

  it('fails closed without an existing receipt signer and never exposes an effect hook', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-m499-no-signer-'));
    tempRoots.push(root);
    const observeRepository = vi.fn(() => observation());
    const observeLocusAuthority = vi.fn(() => locusSummary());
    const result = _consumeCortexRelayShadowForTest(
      CORTEX_RELAY_SHADOW_TEST_CONTROL,
      input(),
      { validation: dependencies({ observeRepository, observeLocusAuthority }), root },
    );
    expect(result.validation.observed).toBe(false);
    expect(result.receipt.state).toBe('unavailable');
    expect(observeRepository).not.toHaveBeenCalled();
    expect(observeLocusAuthority).not.toHaveBeenCalled();
    expect(result.effectEligible).toBe(false);
    expect(result).not.toHaveProperty('execute');
    expect(result).not.toHaveProperty('delegationScope');
  });

  it('ignores caller-supplied verifier overrides on the production consumer', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-m499-no-bypass-'));
    tempRoots.push(root);
    const unknown = assignment({
      repo: {
        owner: 'ashlrai', name: 'relay-unknown-repository', defaultBranch: 'master',
        sourceCommit: SOURCE_COMMIT,
      },
    });
    const injectedObserver = vi.fn(() => observation({
      nameWithOwner: 'ashlrai/relay-unknown-repository',
    }));
    const result = Reflect.apply(consumeCortexRelayShadow, undefined, [input(unknown), {
      root,
      validation: dependencies({ observeRepository: injectedObserver }),
    }]);
    expect(result.validation.accepted).toBe(false);
    expect(injectedObserver).not.toHaveBeenCalled();
  });
});
