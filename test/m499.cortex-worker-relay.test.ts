import { execFileSync } from 'node:child_process';
import {
  chmodSync,
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
  recordCortexRelayShadowOutcome,
} from '../src/core/fleet/cortex-relay-shadow-store.js';
import {
  type LocusV3ShadowAuthoritySummary,
} from '../src/core/integrations/locus.js';

const NOW = new Date('2026-08-10T12:00:00.000Z');
const SOURCE_COMMIT = '8133c090ef70d0bd4fa07e4d9098d82653079864';
const REPO = '/enrolled/ashlr-hub';
const RAW_OBJECTIVE = 'RAW_OBJECTIVE_CANARY_M499 Authorization Bearer m499-secret-token-value';
const RAW_PATH = 'src/RAW_FILE_CANARY_M499.ts';
const EXECUTOR = 'a'.repeat(64);
const tempRoots: string[] = [];
const ORIGINAL_LOCUS_BIN = process.env.LOCUS_BIN;

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
  patch: Partial<Omit<EngineeringAssignmentV1, 'assignmentDigest'>> = {},
): EngineeringAssignmentV1 {
  const unsigned: Omit<EngineeringAssignmentV1, 'assignmentDigest'> = {
    protocol: ENGINEERING_ASSIGNMENT_PROTOCOL,
    version: ENGINEERING_ASSIGNMENT_VERSION,
    assignmentId: 'assignment_m499',
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
  return { ...unsigned, assignmentDigest: engineeringAssignmentDigest(unsigned) };
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
    ...patch,
  };
}

function dependencies(
  patch: Partial<CortexRelayShadowDependencies> = {},
): CortexRelayShadowDependencies {
  return {
    now: () => NOW,
    listEnrolledRepos: () => [REPO],
    observeRepository: () => observation(),
    observeLocusAuthority: () => locusSummary(),
    ...patch,
  };
}

function input(value: unknown = assignment()) {
  return {
    assignment: value,
    policy: { organizationRef: 'org_acme', allowedWorkstreams: ['commercial'] as const },
  };
}

function resign(value: Record<string, unknown>): Record<string, unknown> {
  const { assignmentDigest: _digest, ...unsigned } = value;
  return {
    ...unsigned,
    assignmentDigest: engineeringAssignmentDigest(unsigned as Omit<EngineeringAssignmentV1, 'assignmentDigest'>),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_LOCUS_BIN === undefined) delete process.env.LOCUS_BIN;
  else process.env.LOCUS_BIN = ORIGINAL_LOCUS_BIN;
  vi.resetModules();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('M499 Cortex engineering assignment protocol', () => {
  it('is byte-compatible with the producer digest and freezes valid envelopes', () => {
    const value = assignment();
    expect(value.assignmentDigest).toBe(
      'sha256:8652894ca2af5ef47868a33fbebb3214cc8cb02874e60f0b4d1ef113d7563855',
    );
    const parsed = parseEngineeringAssignmentV1(value, { now: NOW });
    expect(parsed).toEqual(value);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.repo)).toBe(true);
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
    expect(parseEngineeringAssignmentV1(tampered, { now: NOW })).toBeNull();

    const traversal = structuredClone(assignment()) as unknown as Record<string, unknown>;
    (traversal.mission as Record<string, unknown>).allowedFiles = ['../outside'];
    expect(parseEngineeringAssignmentV1(resign(traversal), { now: NOW })).toBeNull();

    const widened = structuredClone(assignment()) as unknown as Record<string, unknown>;
    (widened.authority as Record<string, unknown>).merge = true;
    expect(parseEngineeringAssignmentV1(resign(widened), { now: NOW })).toBeNull();

    expect(parseEngineeringAssignmentV1(assignment(), {
      now: new Date('2026-08-10T13:00:00.000Z'),
    })).toBeNull();
    expect(validateCortexRelayShadow(input(), dependencies({
      observeLocusAuthority: () => null,
    })).metadata.reason).toBe('locus-authority-invalid');
  });
});

describe('M499 shadow admission', () => {
  it('resolves only the enrolled owner/name and produces a proposal-only in-memory scope', () => {
    const observe = vi.fn(() => observation());
    const result = validateCortexRelayShadow(input(), dependencies({ observeRepository: observe }));
    expect(result.accepted, JSON.stringify(result.metadata)).toBe(true);
    if (!result.accepted) throw new Error('expected accepted shadow admission');
    expect(observe).toHaveBeenCalledTimes(3);
    expect(observe).toHaveBeenNthCalledWith(1, REPO);
    expect(observe).toHaveBeenNthCalledWith(2, REPO);
    expect(observe).toHaveBeenNthCalledWith(3, REPO);
    expect(result.repoPath).toBe(REPO);
    expect(result.delegationScope).toMatchObject({
      origin: 'cortex-relay-shadow',
      sourceRepo: REPO,
      executionRoot: REPO,
      runId: 'run_m499',
      taskId: 'assignment_m499',
      memoryMode: 'repo-only',
      allowedFiles: { include: [RAW_PATH], enforceWrites: true },
      resultContract: {
        kind: 'verified-proposal', requireDiff: true, requireProposal: true,
        requireVerification: true, maxChangedFiles: 12, maxChangedLines: 800,
      },
    });
    expect(result.metadata.accepted).toBe(true);
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
    ['organization-mismatch', () => dependencies()],
    ['workstream-denied', () => dependencies()],
  ] as const)('fails closed for %s', (reason, makeDeps) => {
    const base = input();
    const hostile = reason === 'organization-mismatch'
      ? { ...base, policy: { ...base.policy, organizationRef: 'org_other' } }
      : reason === 'workstream-denied'
        ? { ...base, policy: { ...base.policy, allowedWorkstreams: ['company'] as const } }
        : base;
    expect(validateCortexRelayShadow(hostile, makeDeps()).metadata.reason).toBe(reason);
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

  it('preserves every producer-valid allowed file in the normalized scope', () => {
    const allowedFiles = Array.from({ length: 250 }, (_, index) => `src/file-${index}.ts`);
    const result = validateCortexRelayShadow(input(assignment({
      mission: {
        objective: 'Large bounded assignment', successSignals: ['Tests pass'],
        guardrails: ['Do not merge'], allowedFiles,
      },
    })), dependencies());
    expect(result.accepted).toBe(true);
    expect(result.accepted && result.delegationScope.allowedFiles?.include).toEqual(allowedFiles);
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
    const result = validateCortexRelayShadow(input(assignment({
      repo: { owner: 'ashlrai', name: 'ashlr-hub', defaultBranch: 'master', sourceCommit: commit },
    })), {
      now: () => NOW,
      listEnrolledRepos: () => [repo],
      observeLocusAuthority: () => locusSummary(),
    });
    expect(result.accepted, JSON.stringify(result.metadata)).toBe(true);
    expect(result.accepted && result.repoPath).toBe(repo);
  });
});

describe('M499 Locus V3 and metadata receipts', () => {
  function locusAdapterFixture() {
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'ashlr-m499-locus-')));
    tempRoots.push(home);
    mkdirSync(join(home, 'sessions'), { mode: 0o700 });
    mkdirSync(join(home, 'workers'), { mode: 0o700 });
    const workerHome = join(home, 'workers', 'ses_a11ce');
    mkdirSync(workerHome, { mode: 0o700 });
    const responsePath = join(home, 'whoami.json');
    const binPath = join(home, 'locus-test-adapter');
    writeFileSync(binPath, `#!/bin/sh\n/bin/cat ${JSON.stringify(responsePath)}\n`, { mode: 0o700 });
    chmodSync(binPath, 0o700);
    return {
      binPath,
      responsePath,
      source: {
        PATH: '/usr/bin', HOME: '/ambient-home', LOCUS_HOME: home,
        LOCUS_SESSION_ID: 'ses_a11ce', LOCUS_EXECUTOR_CAPABILITY: EXECUTOR,
        GITHUB_TOKEN: 'raw-token', AWS_SECRET_ACCESS_KEY: 'raw-aws',
        LOCUS_CONTROL_CAPABILITY: 'operator-control',
      },
      whoami: {
        session_id: 'ses_a11ce', binding_alias: 'hub-worker', binding_id: 'binding_m499',
        tenant: 'org_acme', expires_at: '2026-08-10T12:30:00.000Z',
        worker_home: workerHome, seal_ok: true, seal: 'opaque-seal', authority: 'delegated',
        authority_anchor_ok: true, backing_type: 'ci',
        backing_path: join(home, 'sessions', 'ci-a11ce.json'), frozen: false,
      },
    };
  }

  async function loadLocusInspector(fixture: ReturnType<typeof locusAdapterFixture>) {
    process.env.LOCUS_BIN = fixture.binPath;
    writeFileSync(fixture.responsePath, JSON.stringify(fixture.whoami), { mode: 0o600 });
    vi.resetModules();
    return (await import('../src/core/integrations/locus.js')).inspectLocusV3ShadowAuthority;
  }

  it('authenticates delegated CI authority through the local V3 adapter only', async () => {
    const fixture = locusAdapterFixture();
    const inspect = await loadLocusInspector(fixture);
    const valid = inspect({ requiredTenantRef: 'org_acme', now: NOW, source: fixture.source });
    expect(valid?.summary).toMatchObject({ authority: 'delegated', backingType: 'ci' });
    for (const patch of [
      { authority: 'ambient' }, { backing_type: 'active' }, { frozen: true },
      { seal_ok: false }, { authority_anchor_ok: false },
      { expires_at: NOW.toISOString() }, { tenant: 'org_other' },
      { backing_path: join(fixture.source.LOCUS_HOME, 'outside.json') },
    ]) {
      writeFileSync(fixture.responsePath, JSON.stringify({ ...fixture.whoami, ...patch }));
      expect(inspect({ requiredTenantRef: 'org_acme', now: NOW, source: fixture.source })).toBeNull();
    }
    writeFileSync(fixture.responsePath, JSON.stringify(fixture.whoami));
    expect(inspect({
      requiredTenantRef: 'org_acme', now: NOW,
      source: { ...fixture.source, LOCUS_EXECUTOR_CAPABILITY: '' },
    })).toBeNull();
  });

  it('derives a scrubbed dormant child env from authenticated adapter state', async () => {
    const fixture = locusAdapterFixture();
    const inspect = await loadLocusInspector(fixture);
    const evidence = inspect({ requiredTenantRef: 'org_acme', now: NOW, source: fixture.source });
    expect(evidence?.childEnv).toMatchObject({
      PATH: '/usr/bin', HOME: fixture.whoami.worker_home, LOCUS_SESSION_ID: 'ses_a11ce',
      LOCUS_BINDING: 'hub-worker', LOCUS_TENANT: 'org_acme',
      LOCUS_EXECUTOR_CAPABILITY: EXECUTOR,
    });
    expect(evidence?.childEnv).not.toHaveProperty('GITHUB_TOKEN');
    expect(evidence?.childEnv).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(evidence?.childEnv).not.toHaveProperty('LOCUS_CONTROL_CAPABILITY');
  });

  it('persists only bounded metadata and deduplicates an assignment exactly once', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-m499-store-'));
    tempRoots.push(root);
    const result = validateCortexRelayShadow(input(), dependencies());
    expect(result.accepted).toBe(true);
    const first = recordCortexRelayShadowOutcome(result.metadata, { root });
    const duplicate = recordCortexRelayShadowOutcome(result.metadata, { root });
    expect(first.state).toBe('recorded');
    expect(duplicate.state).toBe('duplicate');
    const dir = join(root, 'fleet', 'cortex-relay-shadow');
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
      assignmentId: 'assignment_m499',
      repository: 'ashlrai/ashlr-hub',
      accepted: true,
      effects: { agentsSpawned: 0, proposalsCreated: 0, repositoriesMutated: 0 },
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
    expect(recordCortexRelayShadowOutcome(first.metadata, { root }).state).toBe('recorded');
    expect(recordCortexRelayShadowOutcome(second.metadata, { root }).state).toBe('conflict');
  });

  it('refuses a corrupted prior receipt instead of trusting its idempotency state', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-m499-corrupt-'));
    tempRoots.push(root);
    const result = validateCortexRelayShadow(input(), dependencies());
    expect(recordCortexRelayShadowOutcome(result.metadata, { root }).state).toBe('recorded');
    const dir = join(root, 'fleet', 'cortex-relay-shadow');
    const path = join(dir, readdirSync(dir)[0]!);
    const corrupted = { ...JSON.parse(readFileSync(path, 'utf8')), outcomeDigest: `sha256:${'0'.repeat(64)}` };
    writeFileSync(path, `${JSON.stringify(corrupted)}\n`, { mode: 0o600 });
    expect(recordCortexRelayShadowOutcome(result.metadata, { root }).state).toBe('unavailable');
  });

  it('integrates validation and metadata persistence without an execution hook', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-m499-consume-'));
    tempRoots.push(root);
    const first = _consumeCortexRelayShadowForTest(CORTEX_RELAY_SHADOW_TEST_CONTROL, input(), {
      validation: dependencies(), root,
    });
    const duplicate = _consumeCortexRelayShadowForTest(CORTEX_RELAY_SHADOW_TEST_CONTROL, input(), {
      validation: dependencies(), root,
    });
    expect(first.validation.accepted).toBe(true);
    expect(first.receipt.state).toBe('recorded');
    expect(duplicate.validation.accepted).toBe(true);
    expect(duplicate.receipt.state).toBe('duplicate');
    expect(first.validation.metadata.effects).toEqual({
      agentsSpawned: 0, proposalsCreated: 0, repositoriesMutated: 0, merges: 0, deployments: 0,
    });
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
    const result = consumeCortexRelayShadow(input(unknown), {
      root,
      validation: dependencies({
        observeRepository: () => observation({ nameWithOwner: 'ashlrai/relay-unknown-repository' }),
      }),
    } as { root: string });
    expect(result.validation.accepted).toBe(false);
  });
});
