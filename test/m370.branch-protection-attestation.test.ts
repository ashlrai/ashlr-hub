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

type ClassicAuthority = Record<string, unknown> | null;

interface AllowanceActor {
  __typename: 'App' | 'Team' | 'User';
  databaseId: number;
  login?: string;
  slug?: string;
}

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

function classicProtection(appId: number | string = 1): SpawnSyncReturns<string> {
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

function exactClassicAuthority(
  appId: number | string = 1,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const allowance = (actors: AllowanceActor[]) => ({
    totalCount: actors.length,
    pageInfo: { hasNextPage: false },
    nodes: actors.map((actor) => ({ actor })),
  });
  return {
    id: 'BPR_kwDOExample',
    pattern: 'protected/*',
    allowsDeletions: false,
    allowsForcePushes: false,
    blocksCreations: true,
    dismissesStaleReviews: true,
    isAdminEnforced: true,
    lockAllowsFetchAndMerge: false,
    lockBranch: false,
    requireLastPushApproval: true,
    requiredApprovingReviewCount: 1,
    requiresApprovingReviews: true,
    requiresCodeOwnerReviews: true,
    requiresCommitSignatures: true,
    requiresConversationResolution: true,
    requiresDeployments: true,
    requiresLinearHistory: true,
    requiresStatusChecks: true,
    requiresStrictStatusChecks: true,
    restrictsPushes: true,
    restrictsReviewDismissals: true,
    requiredDeploymentEnvironments: ['staging', 'production'],
    requiredStatusChecks: [
      { context: 'build', app: null },
      { context: 'test', app: { databaseId: appId } },
    ],
    bypassForcePushAllowances: allowance([
      { __typename: 'App', databaseId: 8, slug: 'Force-Bot' },
    ]),
    bypassPullRequestAllowances: allowance([
      { __typename: 'Team', databaseId: 5, slug: 'Release' },
      { __typename: 'App', databaseId: 6, slug: 'CI-Bot' },
    ]),
    pushAllowances: allowance([
      { __typename: 'User', databaseId: 7, login: 'Maintainer' },
    ]),
    reviewDismissalAllowances: allowance([
      { __typename: 'User', databaseId: 2, login: 'Reviewer' },
      { __typename: 'Team', databaseId: 4, slug: 'Core' },
    ]),
    ...overrides,
  };
}

function exactAuthority(
  branch = 'main',
  classic: ClassicAuthority = exactClassicAuthority(),
  overrides: {
    head?: string;
    repositoryId?: string;
    nameWithOwner?: string;
    defaultBranch?: string;
  } = {},
): SpawnSyncReturns<string> {
  return result({
    data: {
      repository: {
        id: overrides.repositoryId ?? 'R_kgDOExample',
        nameWithOwner: overrides.nameWithOwner ?? 'acme/widgets',
        defaultBranchRef: { name: overrides.defaultBranch ?? 'main' },
        ref: {
          name: branch,
          target: { oid: overrides.head ?? HEAD },
          branchProtectionRule: classic,
        },
      },
    },
  });
}

function requiredStatusRule(context = 'lint', integrationId = 2): Record<string, unknown> {
  return {
    type: 'required_status_checks',
    parameters: {
      strict_required_status_checks_policy: true,
      do_not_enforce_on_create: false,
      required_status_checks: [{ context, integration_id: integrationId }],
    },
  };
}

function bodyOf(response: SpawnSyncReturns<string>): Record<string, unknown> {
  return JSON.parse(response.stdout) as Record<string, unknown>;
}

function mutateAuthority(
  mutate: (authority: Record<string, unknown>) => void,
): Record<string, unknown> {
  const authority = bodyOf(result(exactClassicAuthority()));
  mutate(authority);
  return authority;
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

function mutateResult(
  response: SpawnSyncReturns<string>,
  mutate: (body: Record<string, unknown>) => void,
): SpawnSyncReturns<string> {
  const body = bodyOf(response);
  mutate(body);
  return result(body);
}

function successSequence(overrides: {
  classic?: SpawnSyncReturns<string>;
  classicAuthority?: ClassicAuthority;
  finalAuthority?: SpawnSyncReturns<string>;
  rules?: SpawnSyncReturns<string>;
  finalRules?: SpawnSyncReturns<string>;
  rulesetDetails?: SpawnSyncReturns<string>[];
  finalRulesetDetails?: SpawnSyncReturns<string>[];
  branch?: string;
} = {}): SpawnSyncReturns<string>[] {
  const branch = overrides.branch ?? 'main';
  const defaultRules = [requiredStatusRule(), { type: 'non_fast_forward' }];
  const usesDefaultRules = overrides.rules === undefined;
  const classic = overrides.classic ?? classicProtection();
  const classicAuthority = overrides.classicAuthority === undefined
    ? (classic.status === 0 ? exactClassicAuthority() : null)
    : overrides.classicAuthority;
  const rules = overrides.rules ?? result(effectiveRules(defaultRules));
  const rulesetDetails = overrides.rulesetDetails ??
    (usesDefaultRules ? [rulesetDetail(branch, defaultRules)] : []);
  return [
    result({
      id: 'R_kgDOExample',
      nameWithOwner: 'acme/widgets',
      defaultBranchRef: { name: 'main' },
    }),
    exactAuthority(branch, classicAuthority),
    result({ name: branch, commit: { sha: HEAD }, protected: true }),
    classic,
    rules,
    ...rulesetDetails,
    overrides.finalRules ?? rules,
    ...(overrides.finalRulesetDetails ?? rulesetDetails),
    overrides.finalAuthority ?? exactAuthority(branch, classicAuthority),
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
        'required_deployments',
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
        schemaVersion: 2,
        classic: {
          ruleId: 'BPR_kwDOExample',
          pattern: 'protected/*',
          bypassForcePushAllowanceCount: 1,
          bypassForcePushAllowances: {
            users: [],
            teams: [],
            apps: [{ id: '8', name: 'force-bot' }],
          },
          requiredDeployments: { environments: ['production', 'staging'] },
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
            restrictReviewDismissals: true,
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
          requiredCheckBindings: [{ context: 'lint', appId: '2' }],
        }],
      },
      detail: 'Live branch protection confirmed with 10 requirement(s)',
    });
    const calls = spawnMock.mock.calls.map((call) => call[1] as string[]);
    expect(calls[1]).toContain('qualifiedName=refs/heads/release/v1');
    expect(calls[2]).toContain('repos/acme/widgets/branches/release/v1');
    expect(calls[3]).toContain('repos/acme/widgets/branches/release/v1/protection');
    expect(calls[4]).toContain(
      'repos/acme/widgets/rules/branches/release/v1?per_page=100&page=1',
    );
    expect(calls[5]).toContain('repos/acme/widgets/rulesets/101?includes_parents=true');
    expect(calls[6]).toContain(
      'repos/acme/widgets/rules/branches/release/v1?per_page=100&page=1',
    );
    expect(calls[7]).toContain('repos/acme/widgets/rulesets/101?includes_parents=true');
    expect(calls[8]).toContain('qualifiedName=refs/heads/release/v1');
    const exactQuery = calls[1]?.find((arg) => arg.startsWith('query='));
    expect(exactQuery).toContain('branchProtectionRule');
    expect(exactQuery).toContain('id');
    expect(exactQuery).toContain('pattern');
    expect(exactQuery).toContain('requiresDeployments');
    expect(exactQuery).toContain('requiredDeploymentEnvironments');
    expect(exactQuery).toContain('bypassForcePushAllowances(first: 100)');
    expect(exactQuery).toContain('bypassPullRequestAllowances(first: 100)');
    expect(exactQuery).toContain('pushAllowances(first: 100)');
    expect(exactQuery).toContain('reviewDismissalAllowances(first: 100)');
    expect(exactQuery).toContain('pageInfo { hasNextPage }');
    expect(exactQuery).toContain('nodes { actor {');
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
      schemaVersion: 2,
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
        requiredCheckBindings: [],
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
      policySnapshot: { schemaVersion: 2, classic: null, rulesets: [] },
    });
    const rulesCalls = spawnMock.mock.calls
      .map((call) => call[1] as string[])
      .filter((args) => args[1]?.includes('/rules/branches/'));
    expect(rulesCalls).toHaveLength(2);
    expect(rulesCalls.every((args) => args[1]?.endsWith('?per_page=100&page=1'))).toBe(true);
  });

  it('continues exact-100 effective-rule pages through a terminal empty page', async () => {
    const repeatedRules = Array.from({ length: 100 }, () => requiredStatusRule());
    const fullPage = result(effectiveRules(repeatedRules));
    queue([
      successSequence()[0]!,
      exactAuthority(),
      successSequence()[2]!,
      classicProtection(),
      fullPage,
      result([]),
      rulesetDetail('main', repeatedRules),
      fullPage,
      result([]),
      rulesetDetail('main', repeatedRules),
      exactAuthority(),
    ]);

    const evidence = await readBranchProtectionAttestation(
      '/repo/exact-page',
      'main',
      { forceFresh: true },
    );

    expect(evidence).toMatchObject({ ok: true, available: true, protected: true });
    const rulesPaths = spawnMock.mock.calls
      .map((call) => (call[1] as string[])[1])
      .filter((path) => path?.includes('/rules/branches/'));
    expect(rulesPaths).toEqual([
      'repos/acme/widgets/rules/branches/main?per_page=100&page=1',
      'repos/acme/widgets/rules/branches/main?per_page=100&page=2',
      'repos/acme/widgets/rules/branches/main?per_page=100&page=1',
      'repos/acme/widgets/rules/branches/main?per_page=100&page=2',
    ]);
  });

  it.each([
    ['malformed', [result(effectiveRules(Array.from({ length: 100 }, () => requiredStatusRule()))), result({ rules: [] })]],
    ['unavailable', [result(effectiveRules(Array.from({ length: 100 }, () => requiredStatusRule()))), result('', 1, 'HTTP 503')]],
    ['over the total bound', [
      ...Array.from({ length: 10 }, () =>
        result(effectiveRules(Array.from({ length: 100 }, () => requiredStatusRule())))),
      result(effectiveRules([requiredStatusRule()])),
    ]],
  ])('fails closed when a later effective-rule page is %s', async (_label, pages) => {
    queue([
      successSequence()[0]!,
      exactAuthority(),
      successSequence()[2]!,
      classicProtection(),
      ...pages,
    ]);

    const evidence = await readBranchProtectionAttestation(
      `/repo/page-${_label}`,
      'main',
      { forceFresh: true },
    );

    expect(evidence).toMatchObject({ ok: false, available: false, protected: false });
    expect(evidence.detail).toContain('Effective branch rules');
  });

  it('keeps identical check contexts local to classic and each active ruleset', async () => {
    const classicBody = bodyOf(classicProtection());
    const status = classicBody['required_status_checks'] as Record<string, unknown>;
    status['contexts'] = [];
    status['checks'] = [{ context: 'shared', app_id: 1 }];
    const repositoryRule = requiredStatusRule('shared', 2);
    const organizationRule = requiredStatusRule('shared', 3);
    const repository = { id: 101, sourceType: 'Repository', source: 'acme/widgets' };
    const organization = { id: 202, sourceType: 'Organization', source: 'acme' };
    const effective = [
      ...effectiveRules([repositoryRule], repository),
      ...effectiveRules([organizationRule], organization),
    ];
    queue(successSequence({
      classic: result(classicBody),
      classicAuthority: exactClassicAuthority(1, {
        requiredStatusChecks: [{ context: 'shared', app: { databaseId: 1 } }],
      }),
      rules: result(effective),
      finalRules: result(effective),
      rulesetDetails: [
        rulesetDetail('main', [repositoryRule], repository),
        rulesetDetail('main', [organizationRule], organization),
      ],
    }));

    const evidence = await readBranchProtectionAttestation(
      '/repo/source-local-checks',
      'main',
      { forceFresh: true },
    );

    expect(evidence).toMatchObject({ ok: true, available: true });
    expect(evidence.requiredChecks).toEqual(['shared']);
    expect(evidence.requiredCheckBindings).toEqual([
      { context: 'shared', appId: '1' },
      { context: 'shared', appId: '2' },
      { context: 'shared', appId: '3' },
    ]);
    expect(evidence.policySnapshot?.rulesets.map((ruleset) => ({
      id: ruleset.id,
      checks: ruleset.rules[0]?.parameters?.['required_status_checks'],
      bindings: ruleset.requiredCheckBindings,
    }))).toEqual([
      {
        id: '202',
        checks: [{ context: 'shared', integration_id: 3 }],
        bindings: [{ context: 'shared', appId: '3' }],
      },
      {
        id: '101',
        checks: [{ context: 'shared', integration_id: 2 }],
        bindings: [{ context: 'shared', appId: '2' }],
      },
    ]);
  });

  it('accepts nullable exact status checks only when status checks are disabled', async () => {
    const classicBody = bodyOf(classicProtection());
    delete classicBody['required_status_checks'];
    const disabledAuthority = exactClassicAuthority(1, {
      requiresStatusChecks: false,
      requiresStrictStatusChecks: false,
      requiredStatusChecks: null,
    });
    queue(successSequence({
      classic: result(classicBody),
      classicAuthority: disabledAuthority,
    }));

    const disabled = await readBranchProtectionAttestation(
      '/repo/status-checks-disabled',
      'main',
      { forceFresh: true },
    );
    expect(disabled).toMatchObject({ ok: true, available: true });
    expect(disabled.policySnapshot?.classic?.requiredStatusChecks).toBeNull();

    queue(successSequence({
      classic: result(classicBody),
      classicAuthority: exactClassicAuthority(1, { requiredStatusChecks: null }),
    }));
    const enabled = await readBranchProtectionAttestation(
      '/repo/status-checks-enabled-null',
      'main',
      { forceFresh: true },
    );
    expect(enabled).toMatchObject({ ok: false, available: false, policySnapshot: null });
  });

  it('accepts classic app_id -1 as any-app authority and rejects a missing app_id', async () => {
    const anyAppBody = bodyOf(classicProtection());
    const anyAppStatus = anyAppBody['required_status_checks'] as Record<string, unknown>;
    anyAppStatus['checks'] = [
      { context: 'test', app_id: -1 },
      { context: 'build', app_id: null },
    ];
    queue(successSequence({
      classic: result(anyAppBody),
      classicAuthority: exactClassicAuthority(1, {
        requiredStatusChecks: [
          { context: 'build', app: null },
          { context: 'test', app: null },
        ],
      }),
    }));

    const anyApp = await readBranchProtectionAttestation(
      '/repo/any-app',
      'main',
      { forceFresh: true },
    );
    expect(anyApp).toMatchObject({ ok: true, available: true });
    expect(anyApp.policySnapshot?.classic?.requiredStatusChecks?.checks).toContainEqual({
      context: 'test',
      appId: '-1',
    });

    const missingBody = bodyOf(classicProtection());
    const missingStatus = missingBody['required_status_checks'] as Record<string, unknown>;
    missingStatus['checks'] = [{ context: 'test' }];
    queue(successSequence({ classic: result(missingBody) }));
    const missing = await readBranchProtectionAttestation(
      '/repo/missing-app-id',
      'main',
      { forceFresh: true },
    );
    expect(missing).toMatchObject({ ok: false, available: false, policySnapshot: null });
  });

  it.each([
    ['numeric zero', 0],
    ['string zero', '0'],
  ])('returns unknown for forbidden classic app_id %s', async (_label, appId) => {
    queue(successSequence({
      classic: classicProtection(appId),
      classicAuthority: exactClassicAuthority(appId),
    }));

    const evidence = await readBranchProtectionAttestation(
      `/repo/forbidden-app-id-${typeof appId}`,
      'main',
      { forceFresh: true },
    );

    expect(evidence).toMatchObject({
      ok: false,
      available: false,
      protected: false,
      policySnapshot: null,
    });
  });

  it('continues to accept positive and any-app classic app IDs', async () => {
    queue([
      ...successSequence({
        classic: classicProtection(7),
        classicAuthority: exactClassicAuthority(7),
      }),
      ...successSequence({
        classic: classicProtection(-1),
        classicAuthority: exactClassicAuthority(1, {
          requiredStatusChecks: [
            { context: 'build', app: null },
            { context: 'test', app: null },
          ],
        }),
      }),
    ]);

    const positive = await readBranchProtectionAttestation(
      '/repo/positive-app-id',
      'main',
      { forceFresh: true },
    );
    const anyApp = await readBranchProtectionAttestation(
      '/repo/negative-one-app-id',
      'main',
      { forceFresh: true },
    );

    expect(positive.policySnapshot?.classic?.requiredStatusChecks?.checks).toContainEqual({
      context: 'test',
      appId: '7',
    });
    expect(anyApp.policySnapshot?.classic?.requiredStatusChecks?.checks).toContainEqual({
      context: 'test',
      appId: '-1',
    });
  });

  it.each([
    ['head', { finalAuthority: exactAuthority('main', exactClassicAuthority(), { head: 'f'.repeat(40) }) }],
    ['effective rule', { finalRules: result(effectiveRules([{ type: 'non_fast_forward' }])) }],
    ['classic policy', {
      finalAuthority: exactAuthority('main', exactClassicAuthority(1, { isAdminEnforced: false })),
    }],
    ['classic pattern', {
      finalAuthority: exactAuthority('main', exactClassicAuthority(1, { pattern: 'release/*' })),
    }],
    ['deployment policy', {
      finalAuthority: exactAuthority('main', exactClassicAuthority(1, {
        requiredDeploymentEnvironments: ['production'],
      })),
    }],
    ['same-count allowance actor substitution', {
      finalAuthority: exactAuthority('main', mutateAuthority((authority) => {
        const connection = authority['pushAllowances'] as Record<string, unknown>;
        connection['nodes'] = [{ actor: {
          __typename: 'User', databaseId: 9, login: 'Substitute',
        } }];
      })),
    }],
  ])('rejects %s drift between the initial and final observation', async (_label, overrides) => {
    queue(successSequence(overrides));

    const evidence = await readBranchProtectionAttestation(
      `/repo/drift-${_label}`,
      'main',
      { forceFresh: true },
    );

    expect(evidence).toMatchObject({ ok: false, available: false, protected: false });
    expect(evidence.detail).toContain('changed during observation');
  });

  it.each([
    ['bypass actor', mutateResult(
      rulesetDetail('main', [requiredStatusRule(), { type: 'non_fast_forward' }]),
      (body) => {
        const actors = body['bypass_actors'] as Array<Record<string, unknown>>;
        actors[0]!['actor_id'] = 99;
      },
    )],
    ['condition', mutateResult(
      rulesetDetail('main', [requiredStatusRule(), { type: 'non_fast_forward' }]),
      (body) => {
        const conditions = body['conditions'] as Record<string, unknown>;
        const refName = conditions['ref_name'] as Record<string, unknown>;
        (refName['include'] as string[]).push('refs/heads/hotfix/*');
      },
    )],
    ['rule', mutateResult(
      rulesetDetail('main', [requiredStatusRule(), { type: 'non_fast_forward' }]),
      (body) => {
        const rules = body['rules'] as Array<Record<string, unknown>>;
        const statusRule = rules[0]!['parameters'] as Record<string, unknown>;
        statusRule['strict_required_status_checks_policy'] = false;
      },
    )],
  ])('rejects %s changes in the final ruleset-detail reread', async (_label, finalDetail) => {
    queue(successSequence({ finalRulesetDetails: [finalDetail] }));

    const evidence = await readBranchProtectionAttestation(
      `/repo/ruleset-detail-drift-${_label}`,
      'main',
      { forceFresh: true },
    );

    expect(evidence).toMatchObject({ ok: false, available: false, protected: false });
    expect(evidence.detail).toBe('Active ruleset policy changed during observation');
    const detailCalls = spawnMock.mock.calls
      .map((call) => (call[1] as string[])[1])
      .filter((path) => path?.includes('/rulesets/'));
    expect(detailCalls).toHaveLength(2);
  });

  it.each([
    ['missing exact rule field', (() => {
      const payload = bodyOf(exactAuthority());
      const repository = ((payload['data'] as Record<string, unknown>)['repository'] as Record<string, unknown>);
      const ref = repository['ref'] as Record<string, unknown>;
      delete ref['branchProtectionRule'];
      return result(payload);
    })()],
    ['truncated exact checks', exactAuthority('main', exactClassicAuthority(1, {
      requiredStatusChecks: [{ context: 'build', app: null }],
    }))],
    ['null allowance authority', exactAuthority('main', exactClassicAuthority(1, {
      bypassPullRequestAllowances: null,
    }))],
    ['allowance hasNextPage', exactAuthority('main', mutateAuthority((authority) => {
      const connection = authority['bypassPullRequestAllowances'] as Record<string, unknown>;
      connection['pageInfo'] = { hasNextPage: true };
    }))],
    ['allowance count mismatch', exactAuthority('main', mutateAuthority((authority) => {
      const connection = authority['pushAllowances'] as Record<string, unknown>;
      connection['totalCount'] = 2;
    }))],
    ['same-count allowance actor mismatch', exactAuthority('main', mutateAuthority((authority) => {
      const connection = authority['pushAllowances'] as Record<string, unknown>;
      connection['nodes'] = [{ actor: {
        __typename: 'User', databaseId: 9, login: 'Substitute',
      } }];
    }))],
  ])('returns unknown for %s', async (_label, authority) => {
    queue([
      successSequence()[0]!,
      authority,
      successSequence()[2]!,
      classicProtection(),
    ]);

    const evidence = await readBranchProtectionAttestation(
      `/repo/exact-${_label}`,
      'main',
      { forceFresh: true },
    );

    expect(evidence).toMatchObject({
      ok: false,
      available: false,
      protected: false,
      policySnapshot: null,
    });
  });

  it('requires exact classic absence and two exhaustive empty rule reads before known unprotected', async () => {
    const protectedAuthority = exactClassicAuthority();
    queue(successSequence({
      classic: result('', 1, 'HTTP 404: Branch not protected'),
      classicAuthority: protectedAuthority,
      rules: result([]),
    }));
    expect(await readBranchProtectionAttestation(
      '/repo/false-absence-classic',
      'main',
      { forceFresh: true },
    )).toMatchObject({ available: false, protected: false });

    queue(successSequence({
      classic: result('', 1, 'HTTP 404: Branch not protected'),
      rules: result([]),
      finalRules: result('', 1, 'HTTP 503'),
    }));
    expect(await readBranchProtectionAttestation(
      '/repo/false-absence-rules',
      'main',
      { forceFresh: true },
    )).toMatchObject({ available: false, protected: false });
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
    const base = successSequence();
    const cases: Array<[string, SpawnSyncReturns<string>[]]> = [
      ['identity', [result('{bad json')]],
      ['branch', [base[0]!, base[1]!, result({ name: 'main', commit: { sha: 'short' } })]],
      ['classic', [base[0]!, base[1]!, base[2]!, result({ required_status_checks: [] })]],
      ['rules', [base[0]!, base[1]!, base[2]!, base[3]!, result({ rules: [] })]],
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
    expect(spawnMock).toHaveBeenCalledTimes(9);

    vi.advanceTimersByTime(29_999);
    await readBranchProtectionAttestation('/repo/positive-cache');
    expect(spawnMock).toHaveBeenCalledTimes(9);

    vi.advanceTimersByTime(1);
    await readBranchProtectionAttestation('/repo/positive-cache');
    expect(spawnMock).toHaveBeenCalledTimes(18);
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
    expect(spawnMock).toHaveBeenCalledTimes(7);

    vi.advanceTimersByTime(1);
    await readBranchProtectionAttestation('/repo/negative-cache');
    expect(spawnMock).toHaveBeenCalledTimes(14);
  });

  it('forceFresh bypasses cache and never serves stale evidence after refresh failure', async () => {
    queue([...successSequence(), result('', 1, 'HTTP 403')]);
    expect((await readBranchProtectionAttestation('/repo/refresh')).ok).toBe(true);

    const refreshed = await readBranchProtectionAttestation('/repo/refresh', undefined, { forceFresh: true });
    expect(refreshed).toMatchObject({ ok: false, available: false });
    expect(spawnMock).toHaveBeenCalledTimes(10);

    const cachedFailure = await readBranchProtectionAttestation('/repo/refresh');
    expect(cachedFailure).toMatchObject({ ok: false, available: false });
    expect(spawnMock).toHaveBeenCalledTimes(10);
  });

  it('forceFresh does not join or get overwritten by an older in-flight read', async () => {
    queue([
      ...successSequence({
        classic: classicProtection(1),
        classicAuthority: exactClassicAuthority(1),
      }),
      ...successSequence({
        classic: classicProtection(9),
        classicAuthority: exactClassicAuthority(9),
      }),
    ]);

    const older = readBranchProtectionAttestation('/repo/concurrent-refresh');
    const fresher = readBranchProtectionAttestation('/repo/concurrent-refresh', undefined, { forceFresh: true });
    const [oldEvidence, freshEvidence] = await Promise.all([older, fresher]);

    expect(oldEvidence.requiredCheckBindings).toContainEqual({ context: 'test', appId: '1' });
    expect(freshEvidence.requiredCheckBindings).toContainEqual({ context: 'test', appId: '9' });
    expect(spawnMock).toHaveBeenCalledTimes(18);
    expect((await readBranchProtectionAttestation('/repo/concurrent-refresh')).requiredCheckBindings)
      .toContainEqual({ context: 'test', appId: '9' });
    expect(spawnMock).toHaveBeenCalledTimes(18);
  });

  it('evicts the least-recently-used entry beyond 128 keys', async () => {
    spawnMock.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === 'repo') return successSequence()[0];
      if (args[1] === 'graphql') return exactAuthority();
      if (args[1]?.endsWith('/protection')) return classicProtection();
      if (args[1]?.includes('/rules/branches/')) {
        return result(effectiveRules([requiredStatusRule(), { type: 'non_fast_forward' }]));
      }
      if (args[1]?.includes('/rulesets/')) {
        return rulesetDetail('main', [requiredStatusRule(), { type: 'non_fast_forward' }]);
      }
      return successSequence()[2];
    });

    for (let index = 0; index < 129; index++) {
      await readBranchProtectionAttestation(`/repo/lru-${index}`, undefined, { forceFresh: true });
    }
    expect(spawnMock).toHaveBeenCalledTimes(129 * 9);

    await readBranchProtectionAttestation('/repo/lru-1');
    expect(spawnMock).toHaveBeenCalledTimes(129 * 9);
    await readBranchProtectionAttestation('/repo/lru-0');
    expect(spawnMock).toHaveBeenCalledTimes(130 * 9);
  });
});
