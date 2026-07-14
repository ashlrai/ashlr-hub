/** Hermetic live branch-protection attestation tests. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnSyncReturns } from 'node:child_process';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', () => ({
  spawnSync: spawnMock,
  execFileSync: () => { throw new Error('execFileSync not expected'); },
}));

import { readBranchProtectionAttestation } from '../src/core/integrations/github.js';

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const RULESET_ID = 101;

function result(
  body: unknown,
  status: number | null = 0,
  stderr = '',
  error?: Error,
): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [],
    stdout: typeof body === 'string' ? body : JSON.stringify(body),
    stderr,
    status,
    signal: null,
    error,
  };
}

function classicProtection(appId = 1): SpawnSyncReturns<string> {
  return result({
    required_status_checks: {
      strict: true,
      enforcement_level: 'non_admins',
      contexts: ['build'],
      checks: [{ context: 'test', app_id: appId }, { context: 'build', app_id: null }],
    },
    enforce_admins: { enabled: true },
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: true,
      required_approving_review_count: 1,
      require_last_push_approval: true,
      dismissal_restrictions: {
        users: [{ id: 2, login: 'Reviewer' }],
        teams: [{ id: 4, slug: 'Core' }],
        apps: [],
      },
      bypass_pull_request_allowances: {
        users: [],
        teams: [{ id: 5, slug: 'Release' }],
        apps: [{ id: 6, slug: 'CI-Bot' }],
      },
    },
    restrictions: {
      users: [{ id: 7, login: 'Maintainer' }],
      teams: [],
      apps: [],
    },
    required_signatures: { enabled: true },
    required_linear_history: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    block_creations: { enabled: true },
    required_conversation_resolution: { enabled: true },
    lock_branch: { enabled: false },
    allow_fork_syncing: { enabled: false },
  });
}

function requiredStatusRule(): Record<string, unknown> {
  return {
    type: 'required_status_checks',
    parameters: {
      strict_required_status_checks_policy: true,
      do_not_enforce_on_create: false,
      required_status_checks: [{ context: 'lint', integration_id: 2 }],
    },
  };
}

function pullRequestRule(): Record<string, unknown> {
  return {
    type: 'pull_request',
    parameters: {
      dismiss_stale_reviews_on_push: true,
      require_code_owner_review: true,
      require_last_push_approval: true,
      required_review_thread_resolution: true,
      required_approving_review_count: 2,
      allowed_merge_methods: ['squash', 'merge'],
    },
  };
}

function effectiveRules(
  rules: Record<string, unknown>[],
  metadata: { id: number; sourceType: string; source: string } = {
    id: RULESET_ID,
    sourceType: 'Repository',
    source: 'acme/widgets',
  },
): Record<string, unknown>[] {
  return rules.map((rule) => ({
    ...rule,
    ruleset_id: metadata.id,
    ruleset_source_type: metadata.sourceType,
    ruleset_source: metadata.source,
  }));
}

function rulesetDetail(
  branch: string,
  rules: Record<string, unknown>[],
  metadata: { id: number; sourceType: string; source: string } = {
    id: RULESET_ID,
    sourceType: 'Repository',
    source: 'acme/widgets',
  },
): SpawnSyncReturns<string> {
  return result({
    id: metadata.id,
    source_type: metadata.sourceType,
    source: metadata.source,
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [
      { actor_id: 42, actor_type: 'Team', bypass_mode: 'pull_request' },
      { actor_id: null, actor_type: 'OrganizationAdmin', bypass_mode: 'always' },
    ],
    conditions: {
      ref_name: {
        include: ['~DEFAULT_BRANCH', `refs/heads/${branch}`],
        exclude: ['refs/heads/archive/*'],
      },
    },
    rules,
  });
}

function successSequence(overrides: {
  classic?: SpawnSyncReturns<string>;
  rules?: SpawnSyncReturns<string>;
  rulesetDetails?: SpawnSyncReturns<string>[];
  branch?: string;
} = {}): SpawnSyncReturns<string>[] {
  const branch = overrides.branch ?? 'main';
  const defaultRules = [requiredStatusRule(), { type: 'non_fast_forward' }];
  const usesDefaultRules = overrides.rules === undefined;
  return [
    result({
      id: 'R_kgDOExample',
      nameWithOwner: 'acme/widgets',
      defaultBranchRef: { name: 'main' },
    }),
    result({ name: branch, commit: { sha: HEAD }, protected: true }),
    overrides.classic ?? classicProtection(),
    overrides.rules ?? result(effectiveRules(defaultRules)),
    ...(overrides.rulesetDetails ?? (usesDefaultRules ? [rulesetDetail(branch, defaultRules)] : [])),
  ];
}

function queue(responses: SpawnSyncReturns<string>[]): void {
  let index = 0;
  spawnMock.mockImplementation(() => {
    const response = responses[index];
    index++;
    if (!response) throw new Error(`unexpected gh call ${index}`);
    return response;
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-11T12:00:00.000Z'));
  spawnMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('readBranchProtectionAttestation parsing', () => {
  it('binds identity and head while normalizing classic and effective rules', async () => {
    queue(successSequence({ branch: 'release/v1' }));

    const evidence = await readBranchProtectionAttestation(
      '/repo/parsing',
      'release/v1',
      { forceFresh: true },
    );

    expect(evidence).toEqual({
      ok: true,
      available: true,
      protected: true,
      branchProtection: true,
      nameWithOwner: 'acme/widgets',
      repositoryId: 'R_kgDOExample',
      defaultBranch: 'main',
      branch: 'release/v1',
      baseHead: HEAD,
      observedAt: '2026-07-11T12:00:00.000Z',
      requirements: [
        'block_creations',
        'enforce_admins',
        'non_fast_forward',
        'pull_request',
        'push_restrictions',
        'required_conversation_resolution',
        'required_linear_history',
        'required_signatures',
        'required_status_checks',
      ],
      requiredChecks: ['build', 'lint', 'test'],
      requiredCheckBindings: [
        { context: 'build', appId: null },
        { context: 'lint', appId: '2' },
        { context: 'test', appId: '1' },
      ],
      sources: ['classic', 'ruleset'],
      policySnapshot: {
        schemaVersion: 1,
        classic: {
          requiredStatusChecks: {
            strict: true,
            enforcementLevel: 'non_admins',
            checks: [
              { context: 'build', appId: null },
              { context: 'test', appId: '1' },
            ],
          },
          enforceAdmins: true,
          requiredPullRequestReviews: {
            dismissStaleReviews: true,
            requireCodeOwnerReviews: true,
            requiredApprovingReviewCount: 1,
            requireLastPushApproval: true,
            dismissalRestrictions: {
              users: [{ id: '2', name: 'reviewer' }],
              teams: [{ id: '4', name: 'core' }],
              apps: [],
            },
            bypassPullRequestAllowances: {
              users: [],
              teams: [{ id: '5', name: 'release' }],
              apps: [{ id: '6', name: 'ci-bot' }],
            },
          },
          pushRestrictions: {
            users: [{ id: '7', name: 'maintainer' }],
            teams: [],
            apps: [],
          },
          requiredSignatures: true,
          requiredLinearHistory: true,
          allowForcePushes: false,
          allowDeletions: false,
          blockCreations: true,
          requiredConversationResolution: true,
          lockBranch: false,
          allowForkSyncing: false,
        },
        rulesets: [{
          id: '101',
          sourceType: 'Repository',
          source: 'acme/widgets',
          target: 'branch',
          enforcement: 'active',
          bypassActors: [
            { actorId: null, actorType: 'OrganizationAdmin', bypassMode: 'always' },
            { actorId: '42', actorType: 'Team', bypassMode: 'pull_request' },
          ],
          conditions: {
            ref_name: {
              include: ['~DEFAULT_BRANCH', 'refs/heads/release/v1'],
              exclude: ['refs/heads/archive/*'],
            },
          },
          rules: [
            { type: 'non_fast_forward', parameters: null },
            {
              type: 'required_status_checks',
              parameters: {
                do_not_enforce_on_create: false,
                required_status_checks: [{ context: 'lint', integration_id: 2 }],
                strict_required_status_checks_policy: true,
              },
            },
          ],
        }],
      },
      detail: 'Live branch protection confirmed with 9 requirement(s)',
    });
    const calls = spawnMock.mock.calls.map((call) => call[1] as string[]);
    expect(calls[1]).toContain('repos/acme/widgets/branches/release/v1');
    expect(calls[2]).toContain('repos/acme/widgets/branches/release/v1/protection');
    expect(calls[3]).toContain('repos/acme/widgets/rules/branches/release/v1');
    expect(calls[4]).toContain('repos/acme/widgets/rulesets/101?includes_parents=true');
  });

  it('accepts an effective ruleset when classic protection is statically absent', async () => {
    const metadata = { id: 202, sourceType: 'Organization', source: 'Acme' };
    const rule = pullRequestRule();
    queue(successSequence({
      classic: result('', 1, 'gh: Branch not protected (HTTP 404)'),
      rules: result(effectiveRules([rule], metadata)),
      rulesetDetails: [rulesetDetail('main', [rule], metadata)],
    }));

    const evidence = await readBranchProtectionAttestation('/repo/rules-only', undefined, { forceFresh: true });

    expect(evidence.ok).toBe(true);
    expect(evidence.sources).toEqual(['ruleset']);
    expect(evidence.requirements).toEqual(['pull_request']);
    expect(evidence.requiredChecks).toEqual([]);
    expect(evidence.requiredCheckBindings).toEqual([]);
    expect(evidence.policySnapshot).toEqual({
      schemaVersion: 1,
      classic: null,
      rulesets: [{
        id: '202',
        sourceType: 'Organization',
        source: 'acme',
        target: 'branch',
        enforcement: 'active',
        bypassActors: [
          { actorId: null, actorType: 'OrganizationAdmin', bypassMode: 'always' },
          { actorId: '42', actorType: 'Team', bypassMode: 'pull_request' },
        ],
        conditions: {
          ref_name: {
            include: ['~DEFAULT_BRANCH', 'refs/heads/main'],
            exclude: ['refs/heads/archive/*'],
          },
        },
        rules: [{
          type: 'pull_request',
          parameters: {
            allowed_merge_methods: ['merge', 'squash'],
            dismiss_stale_reviews_on_push: true,
            require_code_owner_review: true,
            require_last_push_approval: true,
            required_approving_review_count: 2,
            required_review_thread_resolution: true,
          },
        }],
      }],
    });
  });

  it('returns available but unprotected evidence for static absence', async () => {
    queue(successSequence({
      classic: result('', 1, 'HTTP 404: Branch not protected'),
      rules: result([]),
    }));

    const evidence = await readBranchProtectionAttestation('/repo/unprotected', undefined, { forceFresh: true });

    expect(evidence).toMatchObject({
      ok: false,
      available: true,
      protected: false,
      branchProtection: false,
      nameWithOwner: 'acme/widgets',
      branch: 'main',
      baseHead: HEAD,
      requirements: [],
      sources: [],
      policySnapshot: { schemaVersion: 1, classic: null, rulesets: [] },
    });
  });
});

describe('readBranchProtectionAttestation failures', () => {
  it.each([
    ['missing gh', result('', null, '', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))],
    ['HTTP 401', result('', 1, 'HTTP 401: Bad credentials')],
    ['HTTP 403', result('', 1, 'HTTP 403: Resource not accessible')],
    ['HTTP 404', result('', 1, 'HTTP 404: Not Found')],
    ['timeout', result('', null, '', Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }))],
  ])('returns unavailable evidence when repository identity hits %s', async (_label, failure) => {
    queue([failure]);
    const evidence = await readBranchProtectionAttestation(`/repo/error-${_label}`, undefined, { forceFresh: true });
    expect(evidence).toMatchObject({ ok: false, available: false, protected: false });
  });

  it('fails closed on malformed identity, branch, classic, rules, and ruleset-detail payloads', async () => {
    const cases: Array<[string, SpawnSyncReturns<string>[]]> = [
      ['identity', [result('{bad json')]],
      ['branch', [successSequence()[0]!, result({ name: 'main', commit: { sha: 'short' } })]],
      ['classic', [successSequence()[0]!, successSequence()[1]!, result({ required_status_checks: [] })]],
      ['rules', [successSequence()[0]!, successSequence()[1]!, successSequence()[2]!, result({ rules: [] })]],
      ['ruleset detail', successSequence({ rulesetDetails: [result({ id: RULESET_ID })] })],
    ];
    for (const [name, responses] of cases) {
      queue(responses);
      const evidence = await readBranchProtectionAttestation(`/repo/malformed-${name}`, undefined, { forceFresh: true });
      expect(evidence).toMatchObject({ ok: false, available: false, protected: false });
    }
  });
});

describe('readBranchProtectionAttestation cache', () => {
  it('uses a 30s positive TTL and coalesces concurrent reads', async () => {
    queue([...successSequence(), ...successSequence()]);

    const reads = [
      readBranchProtectionAttestation('/repo/positive-cache'),
      readBranchProtectionAttestation('/repo/positive-cache'),
      readBranchProtectionAttestation('/repo/positive-cache'),
    ];
    const first = await Promise.all(reads);
    expect(first.every((item) => item.ok)).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(5);

    vi.advanceTimersByTime(29_999);
    await readBranchProtectionAttestation('/repo/positive-cache');
    expect(spawnMock).toHaveBeenCalledTimes(5);

    vi.advanceTimersByTime(1);
    await readBranchProtectionAttestation('/repo/positive-cache');
    expect(spawnMock).toHaveBeenCalledTimes(10);
  });

  it('uses a 5s negative TTL', async () => {
    const absent = successSequence({
      classic: result('', 1, 'HTTP 404: Branch not protected'),
      rules: result([]),
    });
    queue([...absent, ...absent]);

    await readBranchProtectionAttestation('/repo/negative-cache');
    vi.advanceTimersByTime(4_999);
    await readBranchProtectionAttestation('/repo/negative-cache');
    expect(spawnMock).toHaveBeenCalledTimes(4);

    vi.advanceTimersByTime(1);
    await readBranchProtectionAttestation('/repo/negative-cache');
    expect(spawnMock).toHaveBeenCalledTimes(8);
  });

  it('forceFresh bypasses cache and never serves stale evidence after refresh failure', async () => {
    queue([...successSequence(), result('', 1, 'HTTP 403')]);
    expect((await readBranchProtectionAttestation('/repo/refresh')).ok).toBe(true);

    const refreshed = await readBranchProtectionAttestation('/repo/refresh', undefined, { forceFresh: true });
    expect(refreshed).toMatchObject({ ok: false, available: false });
    expect(spawnMock).toHaveBeenCalledTimes(6);

    const cachedFailure = await readBranchProtectionAttestation('/repo/refresh');
    expect(cachedFailure).toMatchObject({ ok: false, available: false });
    expect(spawnMock).toHaveBeenCalledTimes(6);
  });

  it('forceFresh does not join or get overwritten by an older in-flight read', async () => {
    queue([
      ...successSequence({ classic: classicProtection(1) }),
      ...successSequence({ classic: classicProtection(9) }),
    ]);

    const older = readBranchProtectionAttestation('/repo/concurrent-refresh');
    const fresher = readBranchProtectionAttestation('/repo/concurrent-refresh', undefined, { forceFresh: true });
    const [oldEvidence, freshEvidence] = await Promise.all([older, fresher]);

    expect(oldEvidence.requiredCheckBindings).toContainEqual({ context: 'test', appId: '1' });
    expect(freshEvidence.requiredCheckBindings).toContainEqual({ context: 'test', appId: '9' });
    expect(spawnMock).toHaveBeenCalledTimes(10);
    expect((await readBranchProtectionAttestation('/repo/concurrent-refresh')).requiredCheckBindings)
      .toContainEqual({ context: 'test', appId: '9' });
    expect(spawnMock).toHaveBeenCalledTimes(10);
  });

  it('evicts the least-recently-used entry beyond 128 keys', async () => {
    spawnMock.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === 'repo') return successSequence()[0];
      if (args[1]?.endsWith('/protection')) return successSequence()[2];
      if (args[1]?.includes('/rules/branches/')) return successSequence()[3];
      if (args[1]?.includes('/rulesets/')) return successSequence()[4];
      return successSequence()[1];
    });

    for (let index = 0; index < 129; index++) {
      await readBranchProtectionAttestation(`/repo/lru-${index}`, undefined, { forceFresh: true });
    }
    expect(spawnMock).toHaveBeenCalledTimes(129 * 5);

    await readBranchProtectionAttestation('/repo/lru-1');
    expect(spawnMock).toHaveBeenCalledTimes(129 * 5);
    await readBranchProtectionAttestation('/repo/lru-0');
    expect(spawnMock).toHaveBeenCalledTimes(130 * 5);
  });
});
