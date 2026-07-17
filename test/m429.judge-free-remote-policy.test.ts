/**
 * M429 - judge-free protected-remote policy authority.
 *
 * Only source-complete schema-v2 evidence can satisfy the pure V1 policy. The
 * matrix keeps every refusal closed and proves that source boundaries cannot be
 * flattened into a safe-looking aggregate.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpawnSyncReturns } from 'node:child_process';

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: spawnSyncMock,
}));

import { evaluateEvidenceRemoteProtectionSignal } from '../src/core/inbox/merge.js';
import type { AshlrConfig } from '../src/core/types.js';
import {
  SAFE_MINIMUM_PROTECTED_REMOTE_POLICY_VERSION,
  evaluateSafeMinimumProtectedRemotePolicyV1,
  readBranchProtectionAttestation,
  type BranchProtectionPolicySnapshot,
  type CanonicalClassicProtection,
  type CanonicalRulesetProtection,
  type RequiredCheckBinding,
  type SafeMinimumProtectedRemotePolicyRefusalReason,
} from '../src/core/integrations/github.js';

afterEach(() => {
  spawnSyncMock.mockReset();
});

const TEST_HEAD = '0123456789abcdef0123456789abcdef01234567';

function ghResult(
  body: unknown,
  status: number | null = 0,
  stderr = '',
): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [],
    stdout: typeof body === 'string' ? body : JSON.stringify(body),
    stderr,
    status,
    signal: null,
  };
}

function rawEffectiveRule(
  rule: Record<string, unknown>,
  id = 101,
): Record<string, unknown> {
  return {
    ...structuredClone(rule),
    ruleset_id: id,
    ruleset_source_type: 'Repository',
    ruleset_source: 'acme/widgets',
  };
}

function rawRulesetDetail(
  rules: Record<string, unknown>[],
  id = 101,
): Record<string, unknown> {
  return {
    id,
    source_type: 'Repository',
    source: 'acme/widgets',
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: structuredClone(rules),
  };
}

function rawClassicProtection(): Record<string, unknown> {
  return {
    required_status_checks: {
      strict: true,
      enforcement_level: 'non_admins',
      contexts: CONFIGURED_BINDINGS.map((binding) => binding.context),
      checks: CONFIGURED_BINDINGS.map((binding) => ({
        context: binding.context,
        app_id: Number(binding.appId),
      })),
    },
    enforce_admins: { enabled: true },
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: true,
      required_approving_review_count: 1,
      require_last_push_approval: true,
      dismissal_restrictions: {
        users: [{ id: 11, login: 'Reviewer' }],
        teams: [{ id: 12, slug: 'Core' }],
        apps: [{ id: 13, slug: 'review-bot' }],
      },
      bypass_pull_request_allowances: {
        users: [{ id: 21, login: 'Bypasser' }],
        teams: [{ id: 22, slug: 'Release' }],
        apps: [{ id: 23, slug: 'bypass-bot' }],
      },
    },
    restrictions: {
      users: [{ id: 31, login: 'Maintainer' }],
      teams: [{ id: 32, slug: 'Maintainers' }],
      apps: [{ id: 33, slug: 'push-bot' }],
    },
    required_signatures: { enabled: false },
    required_linear_history: { enabled: false },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    block_creations: { enabled: false },
    required_conversation_resolution: { enabled: false },
    lock_branch: { enabled: false },
    allow_fork_syncing: { enabled: false },
  };
}

function rawClassicAuthority(): Record<string, unknown> {
  const connection = (actors: Record<string, unknown>[]) => ({
    totalCount: actors.length,
    pageInfo: { hasNextPage: false },
    nodes: actors.map((actor) => ({ actor })),
  });
  return {
    id: 'BPR_fixture',
    pattern: 'main',
    allowsDeletions: false,
    allowsForcePushes: false,
    blocksCreations: false,
    dismissesStaleReviews: true,
    isAdminEnforced: true,
    lockAllowsFetchAndMerge: false,
    lockBranch: false,
    requireLastPushApproval: true,
    requiredApprovingReviewCount: 1,
    requiresApprovingReviews: true,
    requiresCodeOwnerReviews: true,
    requiresCommitSignatures: false,
    requiresConversationResolution: false,
    requiresDeployments: false,
    requiresLinearHistory: false,
    requiresStatusChecks: true,
    requiresStrictStatusChecks: true,
    restrictsPushes: true,
    restrictsReviewDismissals: true,
    requiredDeploymentEnvironments: [],
    requiredStatusChecks: CONFIGURED_BINDINGS.map((binding) => ({
      context: binding.context,
      app: { databaseId: Number(binding.appId) },
    })),
    bypassForcePushAllowances: connection([]),
    bypassPullRequestAllowances: connection([
      { __typename: 'User', databaseId: 21, login: 'Bypasser' },
      { __typename: 'Team', databaseId: 22, slug: 'Release' },
      { __typename: 'App', databaseId: 23, slug: 'bypass-bot' },
    ]),
    pushAllowances: connection([
      { __typename: 'User', databaseId: 31, login: 'Maintainer' },
      { __typename: 'Team', databaseId: 32, slug: 'Maintainers' },
      { __typename: 'App', databaseId: 33, slug: 'push-bot' },
    ]),
    reviewDismissalAllowances: connection([
      { __typename: 'User', databaseId: 11, login: 'Reviewer' },
      { __typename: 'Team', databaseId: 12, slug: 'Core' },
      { __typename: 'App', databaseId: 13, slug: 'review-bot' },
    ]),
  };
}

function mockRulesetAttestation(input: {
  effectiveRules: Record<string, unknown>[];
  detail: (id: number, read: number) => Record<string, unknown>;
}) {
  const detailCalls: Array<{ id: number; maxBuffer: number | undefined }> = [];
  let effectiveReads = 0;
  const detailReads = new Map<number, number>();
  spawnSyncMock.mockImplementation((_bin: string, args: string[], options?: { maxBuffer?: number }) => {
    if (args[0] === 'repo') {
      return ghResult({
        id: 'R_fixture',
        nameWithOwner: 'acme/widgets',
        defaultBranchRef: { name: 'main' },
      });
    }
    const path = args[1] ?? '';
    if (path === 'graphql') {
      return ghResult({
        data: {
          repository: {
            id: 'R_fixture',
            nameWithOwner: 'acme/widgets',
            defaultBranchRef: { name: 'main' },
            ref: {
              name: 'main',
              target: { oid: TEST_HEAD },
              branchProtectionRule: null,
            },
          },
        },
      });
    }
    if (path === 'repos/acme/widgets/branches/main') {
      return ghResult({ name: 'main', commit: { sha: TEST_HEAD } });
    }
    if (path === 'repos/acme/widgets/branches/main/protection') {
      return ghResult('', 1, 'HTTP 404: Branch not protected');
    }
    if (path.includes('/rules/branches/main?')) {
      const page = Number(new URL(`https://fixture/${path}`).searchParams.get('page'));
      const start = (page - 1) * 100;
      if (page === 1) effectiveReads++;
      return ghResult(input.effectiveRules.slice(start, start + 100));
    }
    const detailMatch = path.match(/\/rulesets\/([1-9]\d*)\?/);
    if (detailMatch?.[1]) {
      const id = Number(detailMatch[1]);
      const read = (detailReads.get(id) ?? 0) + 1;
      detailReads.set(id, read);
      detailCalls.push({ id, maxBuffer: options?.maxBuffer });
      return ghResult(input.detail(id, read));
    }
    throw new Error(`unexpected gh path: ${path}`);
  });
  return { detailCalls, effectiveReads: () => effectiveReads };
}

function mockClassicAttestation(classic: Record<string, unknown>) {
  const authority = rawClassicAuthority();
  spawnSyncMock.mockImplementation((_bin: string, args: string[]) => {
    if (args[0] === 'repo') {
      return ghResult({
        id: 'R_fixture',
        nameWithOwner: 'acme/widgets',
        defaultBranchRef: { name: 'main' },
      });
    }
    const path = args[1] ?? '';
    if (path === 'graphql') {
      return ghResult({
        data: {
          repository: {
            id: 'R_fixture',
            nameWithOwner: 'acme/widgets',
            defaultBranchRef: { name: 'main' },
            ref: {
              name: 'main',
              target: { oid: TEST_HEAD },
              branchProtectionRule: authority,
            },
          },
        },
      });
    }
    if (path === 'repos/acme/widgets/branches/main') {
      return ghResult({ name: 'main', commit: { sha: TEST_HEAD } });
    }
    if (path === 'repos/acme/widgets/branches/main/protection') return ghResult(classic);
    if (path.includes('/rules/branches/main?')) return ghResult([]);
    throw new Error(`unexpected gh path: ${path}`);
  });
}

const CONFIGURED_BINDINGS: RequiredCheckBinding[] = [
  { context: 'ci/test', appId: '15368' },
  { context: 'security/scan', appId: '20480' },
];

function configuredSignal(requiredChecks: unknown[]) {
  return evaluateEvidenceRemoteProtectionSignal({
    foundry: {
      autoMerge: {
        protectedRemote: { branchProtection: true, requiredChecks },
      },
    },
  } as unknown as AshlrConfig);
}

function emptyActors() {
  return { users: [], teams: [], apps: [] };
}

function classicPolicy(requiredSignatures = false): CanonicalClassicProtection {
  return {
    ruleId: 'BPR_fixture',
    pattern: 'main',
    bypassForcePushAllowanceCount: 0,
    bypassForcePushAllowances: emptyActors(),
    requiredDeployments: null,
    requiredStatusChecks: {
      strict: true,
      enforcementLevel: 'non_admins',
      checks: structuredClone(CONFIGURED_BINDINGS),
    },
    enforceAdmins: true,
    requiredPullRequestReviews: null,
    pushRestrictions: null,
    requiredSignatures,
    requiredLinearHistory: false,
    allowForcePushes: false,
    allowDeletions: false,
    blockCreations: false,
    requiredConversationResolution: false,
    lockBranch: false,
    allowForkSyncing: false,
  };
}

function rulesetPolicy(requiredSignatures = false, id = '101'): CanonicalRulesetProtection {
  return {
    id,
    sourceType: 'Repository',
    source: 'acme/widgets',
    target: 'branch',
    enforcement: 'active',
    bypassActors: [],
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      { type: 'deletion', parameters: null },
      { type: 'non_fast_forward', parameters: null },
      {
        type: 'required_status_checks',
        parameters: {
          do_not_enforce_on_create: false,
          required_status_checks: CONFIGURED_BINDINGS.map((binding) => ({
            context: binding.context,
            integration_id: Number(binding.appId),
          })),
          strict_required_status_checks_policy: true,
        },
      },
      ...(requiredSignatures ? [{ type: 'required_signatures', parameters: null }] : []),
    ],
    requiredCheckBindings: structuredClone(CONFIGURED_BINDINGS),
  };
}

function classicSnapshot(requiredSignatures = false): BranchProtectionPolicySnapshot {
  return { schemaVersion: 2, classic: classicPolicy(requiredSignatures), rulesets: [] };
}

function rulesetSnapshot(requiredSignatures = false): BranchProtectionPolicySnapshot {
  return { schemaVersion: 2, classic: null, rulesets: [rulesetPolicy(requiredSignatures)] };
}

function fullyPopulatedClassicSnapshot(): BranchProtectionPolicySnapshot {
  const classic = classicPolicy();
  classic.requiredDeployments = { environments: ['production'] };
  classic.requiredLinearHistory = true;
  classic.requiredPullRequestReviews = {
    dismissStaleReviews: true,
    requireCodeOwnerReviews: true,
    requiredApprovingReviewCount: 2,
    requireLastPushApproval: true,
    restrictReviewDismissals: true,
    dismissalRestrictions: emptyActors(),
    bypassPullRequestAllowances: emptyActors(),
  };
  classic.pushRestrictions = {
    users: [{ id: '42', name: 'maintainer' }],
    teams: [],
    apps: [],
  };
  return { schemaVersion: 2, classic, rulesets: [] };
}

function deleteClassicField(snapshot: BranchProtectionPolicySnapshot, field: string): void {
  delete (snapshot.classic as unknown as Record<string, unknown>)[field];
}

function deleteRulesetField(snapshot: BranchProtectionPolicySnapshot, field: string): void {
  delete (snapshot.rulesets[0] as unknown as Record<string, unknown>)[field];
}

function mutateClassic(mutator: (classic: CanonicalClassicProtection) => void) {
  const snapshot = classicSnapshot();
  mutator(snapshot.classic!);
  return snapshot;
}

function mutateRuleset(mutator: (ruleset: CanonicalRulesetProtection) => void) {
  const snapshot = rulesetSnapshot();
  mutator(snapshot.rulesets[0]!);
  return snapshot;
}

function setRulesetChecks(
  ruleset: CanonicalRulesetProtection,
  bindings: RequiredCheckBinding[],
): void {
  ruleset.requiredCheckBindings = structuredClone(bindings);
  const status = ruleset.rules.find((rule) => rule.type === 'required_status_checks');
  if (!status) return;
  status.parameters!['required_status_checks'] = bindings.map((binding) => ({
    context: binding.context,
    integration_id: Number(binding.appId),
  }));
}

function composedSnapshot(): BranchProtectionPolicySnapshot {
  const classic = classicPolicy(false);
  classic.requiredStatusChecks!.checks = [{ ...CONFIGURED_BINDINGS[0]! }];
  classic.allowForcePushes = true;
  classic.allowDeletions = true;

  const checks = rulesetPolicy(false, '201');
  checks.rules = checks.rules.filter((rule) => rule.type === 'required_status_checks');
  setRulesetChecks(checks, [{ ...CONFIGURED_BINDINGS[1]! }]);

  const forcePush = rulesetPolicy(true, '202');
  forcePush.rules = forcePush.rules.filter((rule) =>
    rule.type === 'non_fast_forward' || rule.type === 'required_signatures');
  forcePush.requiredCheckBindings = [];

  const deletion = rulesetPolicy(false, '203');
  deletion.rules = deletion.rules.filter((rule) => rule.type === 'deletion');
  deletion.requiredCheckBindings = [];

  return { schemaVersion: 2, classic, rulesets: [checks, forcePush, deletion] };
}

function multiRulesetSnapshot(): BranchProtectionPolicySnapshot {
  const firstChecks = rulesetPolicy(false, '301');
  firstChecks.rules = firstChecks.rules.filter((rule) => rule.type === 'required_status_checks');
  setRulesetChecks(firstChecks, [{ ...CONFIGURED_BINDINGS[0]! }]);

  const secondChecks = rulesetPolicy(false, '302');
  secondChecks.rules = secondChecks.rules.filter((rule) => rule.type === 'required_status_checks');
  setRulesetChecks(secondChecks, [{ ...CONFIGURED_BINDINGS[1]! }]);

  const prohibitions = rulesetPolicy(true, '303');
  prohibitions.rules = prohibitions.rules.filter((rule) =>
    rule.type === 'non_fast_forward' || rule.type === 'deletion' || rule.type === 'required_signatures');
  prohibitions.requiredCheckBindings = [];

  return { schemaVersion: 2, classic: null, rulesets: [firstChecks, secondChecks, prohibitions] };
}

function compactRuleset(id: string): CanonicalRulesetProtection {
  const ruleset = rulesetPolicy(false, id);
  ruleset.rules = [{ type: 'deletion', parameters: null }];
  ruleset.requiredCheckBindings = [];
  return ruleset;
}

function manyBindings(count: number): RequiredCheckBinding[] {
  return Array.from({ length: count }, (_, index) => ({
    context: `ci/check-${index}`,
    appId: String(index + 1),
  }));
}

function expectRefusal(
  snapshot: unknown,
  reason: SafeMinimumProtectedRemotePolicyRefusalReason,
  configured: readonly RequiredCheckBinding[] = CONFIGURED_BINDINGS,
) {
  expect(evaluateSafeMinimumProtectedRemotePolicyV1(snapshot, configured)).toMatchObject({
    ok: false,
    policyVersion: SAFE_MINIMUM_PROTECTED_REMOTE_POLICY_VERSION,
    reason,
  });
}

describe('M429 safe-minimum protected-remote policy V1', () => {
  it.each([
    ['classic signatures explicitly not required', classicSnapshot(false), 'not-required'],
    ['classic signatures required', classicSnapshot(true), 'required'],
    ['ruleset signatures explicitly not required by source-complete absence', rulesetSnapshot(false), 'not-required'],
    ['ruleset signatures required', rulesetSnapshot(true), 'required'],
    [
      'classic signature requirement composes with a ruleset that has no signature rule',
      { schemaVersion: 2, classic: classicPolicy(true), rulesets: [rulesetPolicy(false)] },
      'required',
    ],
    [
      'ruleset signature requirement composes with classic not-required posture',
      { schemaVersion: 2, classic: classicPolicy(false), rulesets: [rulesetPolicy(true)] },
      'required',
    ],
    [
      'classic and multiple rulesets compose disjoint checks and prohibitions',
      composedSnapshot(),
      'required',
    ],
    [
      'multiple rulesets compose an exact effective policy',
      multiRulesetSnapshot(),
      'required',
    ],
    [
      'fully populated canonical classic source',
      fullyPopulatedClassicSnapshot(),
      'not-required',
    ],
    [
      'organization ruleset with a known repository-name selector',
      (() => {
        const snapshot = rulesetSnapshot();
        const ruleset = snapshot.rulesets[0]!;
        ruleset.sourceType = 'Organization';
        ruleset.source = 'acme';
        ruleset.conditions = {
          ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] },
          repository_name: { include: ['widgets'], exclude: [], protected: true },
        };
        return snapshot;
      })(),
      'not-required',
    ],
  ] as const)('accepts %s', (_name, snapshot, signaturePolicy) => {
    expect(evaluateSafeMinimumProtectedRemotePolicyV1(snapshot, CONFIGURED_BINDINGS)).toEqual({
      ok: true,
      policyVersion: 1,
      snapshotSchemaVersion: 2,
      signaturePolicy,
      sourceCount: snapshot.classic ? 1 + snapshot.rulesets.length : snapshot.rulesets.length,
      detail: expect.stringContaining('safe-minimum protected-remote policy V1 satisfied'),
    });
  });

  it.each([
    ['legacy schema remains non-authoritative', { schemaVersion: 1, classic: {}, rulesets: [] }, 'snapshot-schema-unsupported'],
    ['unknown schema remains non-authoritative', { schemaVersion: 3, classic: null, rulesets: [] }, 'snapshot-schema-unsupported'],
    ['malformed snapshot', null, 'snapshot-schema-unsupported'],
    ['no effective source', { schemaVersion: 2, classic: null, rulesets: [] }, 'snapshot-source-missing'],
    [
      'incomplete classic source',
      { schemaVersion: 2, classic: { enforceAdmins: true }, rulesets: [] },
      'classic-source-incomplete',
    ],
    ['missing effective checks', mutateClassic((classic) => { classic.requiredStatusChecks = null; }), 'effective-status-checks-missing'],
    ['non-strict classic checks', mutateClassic((classic) => { classic.requiredStatusChecks!.strict = false; }), 'classic-status-checks-not-strict'],
    [
      'classic any-App check',
      mutateClassic((classic) => { classic.requiredStatusChecks!.checks[0]!.appId = null; }),
      'classic-status-check-bindings-unsafe',
    ],
    [
      'classic duplicate check',
      mutateClassic((classic) => { classic.requiredStatusChecks!.checks.push({ ...classic.requiredStatusChecks!.checks[0]! }); }),
      'classic-status-check-bindings-unsafe',
    ],
    [
      'classic context/App conflict',
      mutateClassic((classic) => { classic.requiredStatusChecks!.checks[0]!.appId = '999'; }),
      'effective-status-check-bindings-unsafe',
    ],
    ['classic admin bypass', mutateClassic((classic) => { classic.enforceAdmins = false; }), 'classic-admin-enforcement-missing'],
    [
      'classic force-push bypass count',
      mutateClassic((classic) => {
        classic.bypassForcePushAllowanceCount = 1;
        classic.bypassForcePushAllowances.apps.push({ id: '1', name: 'bot' });
      }),
      'classic-bypass-actors-present',
    ],
    [
      'classic force-push bypass actor',
      mutateClassic((classic) => {
        classic.bypassForcePushAllowanceCount = 1;
        classic.bypassForcePushAllowances.apps.push({ id: '1', name: 'bot' });
      }),
      'classic-bypass-actors-present',
    ],
    [
      'classic pull-request bypass actor',
      mutateClassic((classic) => {
        classic.requiredPullRequestReviews = {
          dismissStaleReviews: true,
          requireCodeOwnerReviews: false,
          requiredApprovingReviewCount: 1,
          requireLastPushApproval: false,
          restrictReviewDismissals: false,
          dismissalRestrictions: emptyActors(),
          bypassPullRequestAllowances: {
            users: [{ id: '2', name: 'maintainer' }],
            teams: [],
            apps: [],
          },
        };
      }),
      'classic-bypass-actors-present',
    ],
    ['effective force pushes allowed', mutateClassic((classic) => { classic.allowForcePushes = true; }), 'effective-force-push-prohibition-missing'],
    ['effective deletion allowed', mutateClassic((classic) => { classic.allowDeletions = true; }), 'effective-deletion-prohibition-missing'],
    [
      'classic signature policy absent',
      mutateClassic((classic) => { delete (classic as unknown as Record<string, unknown>)['requiredSignatures']; }),
      'classic-source-incomplete',
    ],
    [
      'classic signature policy malformed',
      mutateClassic((classic) => { (classic as unknown as Record<string, unknown>)['requiredSignatures'] = null; }),
      'classic-signature-policy-unknown',
    ],
    [
      'incomplete ruleset source',
      { schemaVersion: 2, classic: null, rulesets: [{ id: '101', rules: [] }] },
      'ruleset-source-incomplete',
    ],
    [
      'duplicate ruleset identity',
      { schemaVersion: 2, classic: null, rulesets: [rulesetPolicy(false), rulesetPolicy(false)] },
      'ruleset-source-duplicate',
    ],
    [
      'ruleset bypass actor',
      mutateRuleset((ruleset) => {
        ruleset.bypassActors.push({ actorId: null, actorType: 'OrganizationAdmin', bypassMode: 'always' });
      }),
      'ruleset-bypass-actors-present',
    ],
    [
      'bypass-only ruleset cannot hide behind a complete classic source',
      (() => {
        const bypass = rulesetPolicy(false, '150');
        bypass.rules = [{ type: 'deletion', parameters: null }];
        bypass.requiredCheckBindings = [];
        bypass.bypassActors.push({ actorId: '42', actorType: 'Team', bypassMode: 'always' });
        return { schemaVersion: 2, classic: classicPolicy(false), rulesets: [bypass] };
      })(),
      'ruleset-bypass-actors-present',
    ],
    [
      'unknown ruleset rule',
      mutateRuleset((ruleset) => { ruleset.rules.push({ type: 'future_bypass', parameters: null }); }),
      'ruleset-rule-unknown',
    ],
    [
      'duplicate ruleset rule',
      mutateRuleset((ruleset) => { ruleset.rules.push({ type: 'deletion', parameters: null }); }),
      'ruleset-rule-duplicate',
    ],
    [
      'missing ruleset checks',
      mutateRuleset((ruleset) => {
        ruleset.rules = ruleset.rules.filter((rule) => rule.type !== 'required_status_checks');
        ruleset.requiredCheckBindings = [];
      }),
      'effective-status-checks-missing',
    ],
    [
      'non-strict ruleset checks',
      mutateRuleset((ruleset) => {
        const status = ruleset.rules.find((rule) => rule.type === 'required_status_checks')!;
        status.parameters!['strict_required_status_checks_policy'] = false;
      }),
      'ruleset-status-checks-not-strict',
    ],
    [
      'ruleset any-App check',
      mutateRuleset((ruleset) => { ruleset.requiredCheckBindings[0]!.appId = null; }),
      'ruleset-status-check-bindings-unsafe',
    ],
    [
      'ruleset parameter/canonical binding conflict',
      mutateRuleset((ruleset) => {
        const status = ruleset.rules.find((rule) => rule.type === 'required_status_checks')!;
        const bindings = status.parameters!['required_status_checks'] as Array<Record<string, unknown>>;
        bindings[0]!['integration_id'] = 999;
      }),
      'ruleset-status-check-bindings-unsafe',
    ],
    [
      'missing ruleset non-fast-forward rule',
      mutateRuleset((ruleset) => { ruleset.rules = ruleset.rules.filter((rule) => rule.type !== 'non_fast_forward'); }),
      'effective-force-push-prohibition-missing',
    ],
    [
      'missing ruleset deletion rule',
      mutateRuleset((ruleset) => { ruleset.rules = ruleset.rules.filter((rule) => rule.type !== 'deletion'); }),
      'effective-deletion-prohibition-missing',
    ],
    [
      'malformed ruleset signature rule',
      mutateRuleset((ruleset) => { ruleset.rules.push({ type: 'required_signatures', parameters: {} }); }),
      'ruleset-signature-policy-unknown',
    ],
    [
      'cross-source context/App conflict',
      (() => {
        const snapshot = composedSnapshot();
        setRulesetChecks(snapshot.rulesets[0]!, [{ context: 'ci/test', appId: '999' }]);
        return snapshot;
      })(),
      'effective-status-check-bindings-unsafe',
    ],
  ] as Array<[string, unknown, SafeMinimumProtectedRemotePolicyRefusalReason]>)('%s', (_name, snapshot, reason) => {
    expectRefusal(snapshot, reason);
  });

  it.each([
    ['missing configured bindings', [], 'configured-bindings-missing'],
    ['nullable configured App', [{ context: 'ci/test', appId: null }], 'configured-binding-any-app'],
    ['any-App configured binding', [{ context: 'ci/test', appId: '-1' }], 'configured-binding-any-app'],
    [
      'duplicate configured binding',
      [{ context: 'ci/test', appId: '15368' }, { context: 'ci/test', appId: '15368' }],
      'configured-binding-duplicate',
    ],
    [
      'conflicting configured context/App binding',
      [{ context: 'ci/test', appId: '15368' }, { context: 'ci/test', appId: '20480' }],
      'configured-binding-conflict',
    ],
    ['malformed configured App', [{ context: 'ci/test', appId: 'app-name' }], 'configured-binding-malformed'],
  ] as Array<[string, RequiredCheckBinding[], SafeMinimumProtectedRemotePolicyRefusalReason]>)('%s', (
    _name,
    configured,
    reason,
  ) => {
    expectRefusal(classicSnapshot(), reason, configured);
  });

  it.each([
    'ruleId',
    'pattern',
    'bypassForcePushAllowanceCount',
    'bypassForcePushAllowances',
    'requiredDeployments',
    'requiredStatusChecks',
    'enforceAdmins',
    'requiredPullRequestReviews',
    'pushRestrictions',
    'requiredSignatures',
    'requiredLinearHistory',
    'allowForcePushes',
    'allowDeletions',
    'blockCreations',
    'requiredConversationResolution',
    'lockBranch',
    'allowForkSyncing',
  ])('rejects a classic source missing canonical field %s', (field) => {
    const snapshot = fullyPopulatedClassicSnapshot();
    deleteClassicField(snapshot, field);
    expectRefusal(snapshot, 'classic-source-incomplete');
  });

  it.each([
    'dismissStaleReviews',
    'requireCodeOwnerReviews',
    'requiredApprovingReviewCount',
    'requireLastPushApproval',
    'restrictReviewDismissals',
    'dismissalRestrictions',
    'bypassPullRequestAllowances',
  ])('rejects a classic review policy missing canonical field %s', (field) => {
    const snapshot = fullyPopulatedClassicSnapshot();
    delete (snapshot.classic!.requiredPullRequestReviews as unknown as Record<string, unknown>)[field];
    expectRefusal(snapshot, 'classic-source-incomplete');
  });

  it.each(['strict', 'enforcementLevel', 'checks'])(
    'rejects classic status checks missing canonical field %s',
    (field) => {
      const snapshot = classicSnapshot();
      delete (snapshot.classic!.requiredStatusChecks as unknown as Record<string, unknown>)[field];
      expectRefusal(snapshot, 'classic-status-checks-missing');
    },
  );

  it.each([
    ['required deployments', (snapshot: BranchProtectionPolicySnapshot) => {
      snapshot.classic!.requiredDeployments = { environments: [] };
    }],
    ['push restrictions', (snapshot: BranchProtectionPolicySnapshot) => {
      (snapshot.classic as unknown as Record<string, unknown>)['pushRestrictions'] = { users: [], teams: [] };
    }],
    ['linear history', (snapshot: BranchProtectionPolicySnapshot) => {
      (snapshot.classic as unknown as Record<string, unknown>)['requiredLinearHistory'] = null;
    }],
    ['review count', (snapshot: BranchProtectionPolicySnapshot) => {
      snapshot.classic!.requiredPullRequestReviews!.requiredApprovingReviewCount = 7;
    }],
    ['review dismissal actors', (snapshot: BranchProtectionPolicySnapshot) => {
      delete (snapshot.classic!.requiredPullRequestReviews!.dismissalRestrictions as unknown as
        Record<string, unknown>)['apps'];
    }],
    ['force-push actor count mismatch', (snapshot: BranchProtectionPolicySnapshot) => {
      snapshot.classic!.bypassForcePushAllowanceCount = 1;
    }],
  ] as const)('rejects malformed canonical classic %s structure', (_name, mutate) => {
    const snapshot = fullyPopulatedClassicSnapshot();
    mutate(snapshot);
    expectRefusal(snapshot, 'classic-source-incomplete');
  });

  it.each([
    'id',
    'sourceType',
    'source',
    'target',
    'enforcement',
    'bypassActors',
    'conditions',
    'rules',
    'requiredCheckBindings',
  ])('rejects a ruleset source missing canonical field %s', (field) => {
    const snapshot = rulesetSnapshot();
    deleteRulesetField(snapshot, field);
    expectRefusal(snapshot, 'ruleset-source-incomplete');
  });

  it.each([
    ['snapshot', () => {
      const snapshot = classicSnapshot() as unknown as Record<string, unknown>;
      snapshot['futurePolicy'] = true;
      return snapshot;
    }, 'snapshot-schema-unsupported'],
    ['classic source', () => mutateClassic((classic) => {
      (classic as unknown as Record<string, unknown>)['futurePolicy'] = true;
    }), 'classic-source-incomplete'],
    ['classic actor category', () => mutateClassic((classic) => {
      (classic.bypassForcePushAllowances as unknown as Record<string, unknown>)['deployKeys'] = [];
    }), 'classic-source-incomplete'],
    ['classic named actor', () => mutateClassic((classic) => {
      classic.pushRestrictions = { users: [], teams: [], apps: [] };
      const actor = { id: '42', name: 'bot', futureIdentity: true };
      classic.pushRestrictions.apps.push(actor as unknown as { id: string; name: string });
    }), 'classic-source-incomplete'],
    ['classic deployment policy', () => mutateClassic((classic) => {
      classic.requiredDeployments = { environments: ['production'] };
      (classic.requiredDeployments as unknown as Record<string, unknown>)['futureGate'] = true;
    }), 'classic-source-incomplete'],
    ['classic review policy', () => {
      const snapshot = fullyPopulatedClassicSnapshot();
      (snapshot.classic!.requiredPullRequestReviews as unknown as
        Record<string, unknown>)['futureReviewGate'] = true;
      return snapshot;
    }, 'classic-source-incomplete'],
    ['classic status checks', () => mutateClassic((classic) => {
      (classic.requiredStatusChecks as unknown as Record<string, unknown>)['futureStatusGate'] = true;
    }), 'classic-status-checks-missing'],
    ['classic canonical binding', () => mutateClassic((classic) => {
      (classic.requiredStatusChecks!.checks[0] as unknown as Record<string, unknown>)['futureApp'] = true;
    }), 'classic-status-checks-missing'],
    ['ruleset source', () => mutateRuleset((ruleset) => {
      (ruleset as unknown as Record<string, unknown>)['futurePolicy'] = true;
    }), 'ruleset-source-incomplete'],
    ['ruleset bypass actor', () => mutateRuleset((ruleset) => {
      ruleset.bypassActors.push({
        actorId: '42',
        actorType: 'Team',
        bypassMode: 'always',
        futureActorMode: true,
      } as unknown as CanonicalRulesetProtection['bypassActors'][number]);
    }), 'ruleset-source-incomplete'],
    ['ruleset actor category', () => mutateRuleset((ruleset) => {
      ruleset.bypassActors.push({
        actorId: '42',
        actorType: 'FutureRole',
        bypassMode: 'always',
      } as unknown as CanonicalRulesetProtection['bypassActors'][number]);
    }), 'ruleset-source-incomplete'],
    ['ruleset condition', () => mutateRuleset((ruleset) => {
      ruleset.conditions['future_selector'] = { include: ['acme/widgets'] };
    }), 'ruleset-source-incomplete'],
    ['ruleset ref-name condition', () => mutateRuleset((ruleset) => {
      (ruleset.conditions['ref_name'] as Record<string, unknown>)['futureRefMode'] = true;
    }), 'ruleset-source-incomplete'],
    ['ruleset rule', () => mutateRuleset((ruleset) => {
      (ruleset.rules[0] as unknown as Record<string, unknown>)['futureRuleMode'] = true;
    }), 'ruleset-rule-unknown'],
    ['ruleset parameters', () => mutateRuleset((ruleset) => {
      const status = ruleset.rules.find((rule) => rule.type === 'required_status_checks')!;
      status.parameters!['futureStatusMode'] = true;
    }), 'ruleset-rule-unknown'],
    ['ruleset parameter binding', () => mutateRuleset((ruleset) => {
      const status = ruleset.rules.find((rule) => rule.type === 'required_status_checks')!;
      const checks = status.parameters!['required_status_checks'] as Array<Record<string, unknown>>;
      checks[0]!['futureApp'] = true;
    }), 'ruleset-rule-unknown'],
    ['ruleset canonical binding', () => mutateRuleset((ruleset) => {
      (ruleset.requiredCheckBindings[0] as unknown as Record<string, unknown>)['futureApp'] = true;
    }), 'ruleset-source-incomplete'],
    ['workflow parameter node', () => mutateRuleset((ruleset) => {
      ruleset.rules.push({
        type: 'workflows',
        parameters: {
          workflows: [{ path: '.github/workflows/ci.yml', repository_id: 1, futureRef: true }],
        },
      });
    }), 'ruleset-rule-unknown'],
    ['code-scanning parameter node', () => mutateRuleset((ruleset) => {
      ruleset.rules.push({
        type: 'code_scanning',
        parameters: {
          code_scanning_tools: [{
            alerts_threshold: 'errors',
            security_alerts_threshold: 'high_or_higher',
            tool: 'CodeQL',
            futureThreshold: 'critical',
          }],
        },
      });
    }), 'ruleset-rule-unknown'],
  ] as const)('rejects unknown schema-v2 semantics in %s', (_name, build, reason) => {
    expectRefusal(build(), reason);
  });

  it.each([
    ['ref_name', (conditions: Record<string, unknown>) => { delete conditions['ref_name']; }],
    ['ref_name.include', (conditions: Record<string, unknown>) => {
      delete (conditions['ref_name'] as Record<string, unknown>)['include'];
    }],
    ['ref_name.exclude', (conditions: Record<string, unknown>) => {
      delete (conditions['ref_name'] as Record<string, unknown>)['exclude'];
    }],
  ] as const)('rejects ruleset conditions missing canonical field %s', (_name, mutate) => {
    const snapshot = rulesetSnapshot();
    mutate(snapshot.rulesets[0]!.conditions);
    expectRefusal(snapshot, 'ruleset-source-incomplete');
  });

  it('bounds aggregate ruleset sources before evaluation', () => {
    const snapshot = rulesetSnapshot();
    snapshot.rulesets = Array.from({ length: 101 }, (_, index) =>
      rulesetPolicy(false, String(index + 1)));
    expectRefusal(snapshot, 'snapshot-schema-unsupported');
  });

  it('accepts documented classic transport metadata without projecting it into authority', async () => {
    const classic = rawClassicProtection();
    Object.assign(classic, {
      enabled: true,
      name: 'main',
      protection_url: 'https://api.github.com/repos/acme/widgets/branches/main/protection',
      url: 'https://api.github.com/repos/acme/widgets/branches/main/protection',
    });
    Object.assign(classic['enforce_admins'] as Record<string, unknown>, {
      url: 'https://api.github.com/repos/acme/widgets/branches/main/protection/enforce_admins',
    });
    Object.assign(classic['required_status_checks'] as Record<string, unknown>, {
      contexts_url: 'https://api.github.com/repos/acme/widgets/branches/main/protection/contexts',
      url: 'https://api.github.com/repos/acme/widgets/branches/main/protection/status-checks',
    });
    const reviews = classic['required_pull_request_reviews'] as Record<string, unknown>;
    reviews['url'] = 'https://api.github.com/repos/acme/widgets/branches/main/protection/reviews';
    Object.assign(reviews['dismissal_restrictions'] as Record<string, unknown>, {
      teams_url: 'https://api.github.com/teams',
      url: 'https://api.github.com/restrictions',
      users_url: 'https://api.github.com/users',
    });
    Object.assign(classic['restrictions'] as Record<string, unknown>, {
      apps_url: 'https://api.github.com/apps',
      teams_url: 'https://api.github.com/teams',
      url: 'https://api.github.com/restrictions',
      users_url: 'https://api.github.com/users',
    });
    const restrictions = classic['restrictions'] as Record<string, unknown>;
    const user = (restrictions['users'] as Record<string, unknown>[])[0]!;
    Object.assign(user, {
      avatar_url: 'https://avatars.githubusercontent.com/u/31',
      node_id: 'U_fixture',
      site_admin: false,
      type: 'User',
      url: 'https://api.github.com/users/Maintainer',
      user_view_type: 'public',
    });
    const team = (restrictions['teams'] as Record<string, unknown>[])[0]!;
    Object.assign(team, {
      description: null,
      node_id: 'T_fixture',
      parent: { id: 320, slug: 'parent', description: null },
      permissions: { pull: true, triage: true, push: true, maintain: true, admin: false },
      type: 'organization',
      url: 'https://api.github.com/teams/32',
    });
    const app = (restrictions['apps'] as Record<string, unknown>[])[0]!;
    Object.assign(app, {
      description: null,
      events: ['push'],
      installations_count: 0,
      owner: { id: 330, login: 'acme', description: null, site_admin: false },
      permissions: { contents: 'read', organization_custom_properties: 'write' },
    });
    mockClassicAttestation(classic);

    const evidence = await readBranchProtectionAttestation(
      '/repo/m429-classic-documented-metadata',
      'main',
      { forceFresh: true, expectedNameWithOwner: 'acme/widgets' },
    );

    expect(evidence).toMatchObject({ ok: true, available: true });
    expect(evidence.policySnapshot?.classic).toMatchObject({
      enforceAdmins: true,
      requiredStatusChecks: { strict: true },
    });
  });

  it.each([
    ['classic root', (classic: Record<string, unknown>) => { classic['future_authority'] = true; }],
    ['enabled wrapper', (classic: Record<string, unknown>) => {
      (classic['enforce_admins'] as Record<string, unknown>)['future_override'] = true;
    }],
    ['wrapper-specific metadata', (classic: Record<string, unknown>) => {
      (classic['allow_deletions'] as Record<string, unknown>)['url'] = 'https://api.github.com/future';
    }],
    ['status policy', (classic: Record<string, unknown>) => {
      (classic['required_status_checks'] as Record<string, unknown>)['future_status_mode'] = true;
    }],
    ['status check', (classic: Record<string, unknown>) => {
      const status = classic['required_status_checks'] as Record<string, unknown>;
      (status['checks'] as Record<string, unknown>[])[0]!['future_app_binding'] = true;
    }],
    ['review policy', (classic: Record<string, unknown>) => {
      (classic['required_pull_request_reviews'] as Record<string, unknown>)['future_review_mode'] = true;
    }],
    ['dismissal restriction set', (classic: Record<string, unknown>) => {
      const reviews = classic['required_pull_request_reviews'] as Record<string, unknown>;
      (reviews['dismissal_restrictions'] as Record<string, unknown>)['future_actor_type'] = [];
    }],
    ['bypass allowance set', (classic: Record<string, unknown>) => {
      const reviews = classic['required_pull_request_reviews'] as Record<string, unknown>;
      (reviews['bypass_pull_request_allowances'] as Record<string, unknown>)['future_actor_type'] = [];
    }],
    ['push restriction set', (classic: Record<string, unknown>) => {
      (classic['restrictions'] as Record<string, unknown>)['future_actor_type'] = [];
    }],
    ['user actor', (classic: Record<string, unknown>) => {
      const restrictions = classic['restrictions'] as Record<string, unknown>;
      (restrictions['users'] as Record<string, unknown>[])[0]!['future_identity'] = true;
    }],
    ['owner-only metadata on a user actor', (classic: Record<string, unknown>) => {
      const restrictions = classic['restrictions'] as Record<string, unknown>;
      (restrictions['users'] as Record<string, unknown>[])[0]!['description'] = 'not valid here';
    }],
    ['team actor', (classic: Record<string, unknown>) => {
      const restrictions = classic['restrictions'] as Record<string, unknown>;
      (restrictions['teams'] as Record<string, unknown>[])[0]!['future_identity'] = true;
    }],
    ['App actor', (classic: Record<string, unknown>) => {
      const restrictions = classic['restrictions'] as Record<string, unknown>;
      (restrictions['apps'] as Record<string, unknown>[])[0]!['future_identity'] = true;
    }],
    ['team permissions', (classic: Record<string, unknown>) => {
      const restrictions = classic['restrictions'] as Record<string, unknown>;
      const team = (restrictions['teams'] as Record<string, unknown>[])[0]!;
      team['permissions'] = {
        pull: true,
        triage: true,
        push: true,
        maintain: true,
        admin: false,
        future_permission: true,
      };
    }],
    ['parent team', (classic: Record<string, unknown>) => {
      const restrictions = classic['restrictions'] as Record<string, unknown>;
      const team = (restrictions['teams'] as Record<string, unknown>[])[0]!;
      team['parent'] = { id: 320, slug: 'parent', future_identity: true };
    }],
    ['App owner', (classic: Record<string, unknown>) => {
      const restrictions = classic['restrictions'] as Record<string, unknown>;
      const app = (restrictions['apps'] as Record<string, unknown>[])[0]!;
      app['owner'] = { id: 330, login: 'acme', future_identity: true };
    }],
  ] as const)('rejects unknown fields in the raw classic %s envelope', async (_name, mutate) => {
    const classic = rawClassicProtection();
    mutate(classic);
    mockClassicAttestation(classic);

    const evidence = await readBranchProtectionAttestation(
      `/repo/m429-classic-${_name.replaceAll(' ', '-')}`,
      'main',
      { forceFresh: true, expectedNameWithOwner: 'acme/widgets' },
    );

    expect(evidence).toMatchObject({
      ok: false,
      available: false,
      detail: 'Classic branch protection was malformed',
      policySnapshot: null,
    });
  });

  it('bounds effective ruleset sources before any per-ruleset detail request', async () => {
    const effectiveRules = Array.from({ length: 101 }, (_, index) => ({
      ruleset_id: index + 1,
      ruleset_source_type: 'Repository',
      ruleset_source: 'acme/widgets',
      type: 'deletion',
    }));
    spawnSyncMock.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === 'repo') {
        return ghResult({
          id: 'R_fixture',
          nameWithOwner: 'acme/widgets',
          defaultBranchRef: { name: 'main' },
        });
      }
      const path = args[1] ?? '';
      if (path === 'graphql') {
        return ghResult({
          data: {
            repository: {
              id: 'R_fixture',
              nameWithOwner: 'acme/widgets',
              defaultBranchRef: { name: 'main' },
              ref: {
                name: 'main',
                target: { oid: TEST_HEAD },
                branchProtectionRule: null,
              },
            },
          },
        });
      }
      if (path === 'repos/acme/widgets/branches/main') {
        return ghResult({ name: 'main', commit: { sha: TEST_HEAD } });
      }
      if (path === 'repos/acme/widgets/branches/main/protection') {
        return ghResult('', 1, 'HTTP 404: Branch not protected');
      }
      if (path.includes('/rules/branches/main?')) {
        return ghResult(path.endsWith('page=1') ? effectiveRules.slice(0, 100) : effectiveRules.slice(100));
      }
      throw new Error(`unexpected gh path: ${path}`);
    });

    const evidence = await readBranchProtectionAttestation(
      '/repo/m429-ruleset-source-bound',
      'main',
      { forceFresh: true, expectedNameWithOwner: 'acme/widgets' },
    );

    expect(evidence).toMatchObject({
      ok: false,
      available: false,
      detail: 'Active ruleset policy is unavailable or malformed',
    });
    expect(spawnSyncMock.mock.calls.some(([, args]) =>
      Array.isArray(args) && String(args[1]).includes('/rulesets/'))).toBe(false);
  });

  it('rejects unknown effective-rule fields before canonical projection or detail fan-out', async () => {
    const effective = rawEffectiveRule({ type: 'deletion', future_bypass: true });
    const harness = mockRulesetAttestation({
      effectiveRules: [effective],
      detail: () => rawRulesetDetail([{ type: 'deletion' }]),
    });

    const evidence = await readBranchProtectionAttestation(
      '/repo/m429-effective-envelope',
      'main',
      { forceFresh: true, expectedNameWithOwner: 'acme/widgets' },
    );

    expect(evidence).toMatchObject({
      ok: false,
      available: false,
      detail: 'Effective branch rules are unavailable or malformed',
    });
    expect(harness.detailCalls).toHaveLength(0);
  });

  it.each([
    ['detail response', (detail: Record<string, unknown>) => { detail['future_authority'] = true; }],
    ['detail rule', (detail: Record<string, unknown>) => {
      (detail['rules'] as Array<Record<string, unknown>>)[0]!['future_bypass'] = true;
    }],
    ['bypass actor', (detail: Record<string, unknown>) => {
      detail['bypass_actors'] = [{
        actor_id: 42,
        actor_type: 'Team',
        bypass_mode: 'always',
        future_identity: true,
      }];
    }],
  ] as const)('rejects unknown fields in the raw %s envelope', async (_name, mutate) => {
    const detail = rawRulesetDetail([{ type: 'deletion' }]);
    mutate(detail);
    const harness = mockRulesetAttestation({
      effectiveRules: [rawEffectiveRule({ type: 'deletion' })],
      detail: () => detail,
    });

    const evidence = await readBranchProtectionAttestation(
      `/repo/m429-${_name.replaceAll(' ', '-')}`,
      'main',
      { forceFresh: true, expectedNameWithOwner: 'acme/widgets' },
    );

    expect(evidence).toMatchObject({
      ok: false,
      available: false,
      detail: 'Active ruleset policy is unavailable or malformed',
    });
    expect(harness.detailCalls).toHaveLength(1);
  });

  it('applies raw envelope closure to the freshness ruleset reread', async () => {
    const clean = rawRulesetDetail([{ type: 'deletion' }]);
    const drifted = rawRulesetDetail([{ type: 'deletion', future_bypass: true }]);
    const harness = mockRulesetAttestation({
      effectiveRules: [rawEffectiveRule({ type: 'deletion' })],
      detail: (_id, read) => read === 1 ? clean : drifted,
    });

    const evidence = await readBranchProtectionAttestation(
      '/repo/m429-fresh-envelope',
      'main',
      { forceFresh: true, expectedNameWithOwner: 'acme/widgets' },
    );

    expect(evidence).toMatchObject({
      ok: false,
      available: false,
      detail: 'Active ruleset policy changed during observation',
    });
    expect(harness.detailCalls).toHaveLength(2);
  });

  it.each([
    ['rules', Array.from({ length: 101 }, () => rawEffectiveRule({ type: 'deletion' }))],
    ['checks', [0, 1].map((source) => rawEffectiveRule({
      type: 'required_status_checks',
      parameters: {
        required_status_checks: Array.from({ length: 51 }, (_, index) => ({
          context: `ci/${source}/${index}`,
          integration_id: index + 1,
        })),
        strict_required_status_checks_policy: true,
      },
    }))],
    ['actors', [0, 1].map((source) => rawEffectiveRule({
      type: 'pull_request',
      parameters: {
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_approving_review_count: 0,
        required_review_thread_resolution: false,
        dismissal_restriction: {
          enabled: true,
          allowed_actors: Array.from({ length: 51 }, (_, index) => ({
            id: source * 51 + index + 1,
            type: 'Team',
          })),
        },
      },
    }))],
  ] as const)('bounds cumulative effective %s before the first detail request', async (_name, effectiveRules) => {
    const harness = mockRulesetAttestation({
      effectiveRules: [...effectiveRules],
      detail: () => rawRulesetDetail([{ type: 'deletion' }]),
    });

    const evidence = await readBranchProtectionAttestation(
      `/repo/m429-effective-${_name}`,
      'main',
      { forceFresh: true, expectedNameWithOwner: 'acme/widgets' },
    );

    expect(evidence).toMatchObject({
      ok: false,
      available: false,
      detail: 'Active ruleset policy is unavailable or malformed',
    });
    expect(harness.detailCalls).toHaveLength(0);
  });

  it('uses the remaining cumulative byte budget before requesting the next ruleset', async () => {
    const large = rawRulesetDetail([{ type: 'deletion' }], 101);
    const conditions = large['conditions'] as Record<string, unknown>;
    const targetBytes = 262_040;
    for (let index = 0; index < 100; index++) {
      const key = `padding_${index}`;
      conditions[key] = '';
      const withEmpty = Buffer.byteLength(JSON.stringify(large), 'utf8');
      const valueLength = Math.min(8_192, targetBytes - withEmpty);
      if (valueLength <= 0) {
        delete conditions[key];
        break;
      }
      conditions[key] = 'x'.repeat(valueLength);
      if (Buffer.byteLength(JSON.stringify(large), 'utf8') >= targetBytes) break;
    }
    const largeBytes = Buffer.byteLength(JSON.stringify(large), 'utf8');
    expect(largeBytes).toBe(targetBytes);

    const harness = mockRulesetAttestation({
      effectiveRules: [
        rawEffectiveRule({ type: 'deletion' }, 101),
        rawEffectiveRule({ type: 'deletion' }, 102),
      ],
      detail: (id) => id === 101 ? large : rawRulesetDetail([{ type: 'deletion' }], 102),
    });

    const evidence = await readBranchProtectionAttestation(
      '/repo/m429-byte-budget-before-request',
      'main',
      { forceFresh: true, expectedNameWithOwner: 'acme/widgets' },
    );

    expect(evidence).toMatchObject({
      ok: false,
      available: false,
      detail: 'Active ruleset policy is unavailable or malformed',
    });
    expect(harness.detailCalls).toEqual([{
      id: 101,
      maxBuffer: expect.any(Number),
    }]);
    expect(harness.detailCalls[0]!.maxBuffer).toBeGreaterThan(largeBytes);
    expect(harness.detailCalls[0]!.maxBuffer).toBeLessThanOrEqual(256 * 1024);
  });

  it.each([
    ['rules', (ruleset: CanonicalRulesetProtection) => {
      ruleset.rules = Array.from({ length: 101 }, () => ({ type: 'deletion', parameters: null }));
    }],
    ['bypass actors', (ruleset: CanonicalRulesetProtection) => {
      ruleset.bypassActors = Array.from({ length: 101 }, (_, index) => ({
        actorId: String(index + 1),
        actorType: 'Team' as const,
        bypassMode: 'always' as const,
      }));
    }],
    ['condition include refs', (ruleset: CanonicalRulesetProtection) => {
      ruleset.conditions = {
        ref_name: { include: Array.from({ length: 257 }, (_, index) => `refs/heads/${index}`), exclude: [] },
      };
    }],
    ['condition object keys', (ruleset: CanonicalRulesetProtection) => {
      ruleset.conditions = Object.fromEntries([
        ['ref_name', { include: ['~DEFAULT_BRANCH'], exclude: [] }],
        ...Array.from({ length: 128 }, (_, index) => [`extra_${index}`, true]),
      ]);
    }],
    ['required check bindings', (ruleset: CanonicalRulesetProtection) => {
      ruleset.requiredCheckBindings = Array.from({ length: 101 }, (_, index) => ({
        context: `ci/${index}`,
        appId: String(index + 1),
      }));
    }],
  ] as const)('bounds oversized %s at the snapshot envelope', (_name, mutate) => {
    const snapshot = rulesetSnapshot();
    mutate(snapshot.rulesets[0]!);
    expectRefusal(snapshot, 'snapshot-schema-unsupported');
  });

  it('rejects an oversized sparse rules array before aggregate traversal', () => {
    const snapshot = rulesetSnapshot();
    const sparseRules = [] as CanonicalRulesetProtection['rules'];
    sparseRules.length = 1_000_000_000;
    sparseRules[0] = { type: 'deletion', parameters: null };
    snapshot.rulesets[0]!.rules = sparseRules;

    expectRefusal(snapshot, 'snapshot-schema-unsupported');
  });

  it('rejects sparse arrays within the per-array length cap', () => {
    const snapshot = rulesetSnapshot();
    const sparseRules = [] as CanonicalRulesetProtection['rules'];
    sparseRules.length = 3;
    sparseRules[0] = { type: 'deletion', parameters: null };
    sparseRules[2] = { type: 'non_fast_forward', parameters: null };
    snapshot.rulesets[0]!.rules = sparseRules;

    expectRefusal(snapshot, 'snapshot-schema-unsupported');
  });

  it('rejects excessive object keys without full Object.keys materialization', () => {
    const snapshot = rulesetSnapshot();
    const excessiveConditions = Object.fromEntries([
      ['ref_name', { include: ['~DEFAULT_BRANCH'], exclude: [] }],
      ...Array.from({ length: 10_000 }, (_, index) => [`future_${index}`, true]),
    ]);
    snapshot.rulesets[0]!.conditions = excessiveConditions;
    const originalObjectKeys = Object.keys;
    const objectKeys = vi.spyOn(Object, 'keys').mockImplementation(((value: object) => {
      if (value === excessiveConditions) {
        throw new Error('excessive policy object reached full Object.keys traversal');
      }
      return originalObjectKeys(value);
    }) as typeof Object.keys);

    let verdict: ReturnType<typeof evaluateSafeMinimumProtectedRemotePolicyV1> | undefined;
    try {
      verdict = evaluateSafeMinimumProtectedRemotePolicyV1(snapshot, CONFIGURED_BINDINGS);
    } finally {
      objectKeys.mockRestore();
    }
    expect(verdict).toMatchObject({
      ok: false,
      policyVersion: SAFE_MINIMUM_PROTECTED_REMOTE_POLICY_VERSION,
      reason: 'snapshot-schema-unsupported',
    });
  });

  it('accepts a compact snapshot at the cumulative ruleset and rule boundary', () => {
    const snapshot = classicSnapshot();
    snapshot.rulesets = Array.from({ length: 100 }, (_, index) => compactRuleset(String(index + 1)));
    expect(evaluateSafeMinimumProtectedRemotePolicyV1(snapshot, CONFIGURED_BINDINGS)).toMatchObject({
      ok: true,
      sourceCount: 101,
    });
  });

  it('rejects per-source rule maxima that multiply beyond the cumulative rule budget', () => {
    const snapshot = classicSnapshot();
    snapshot.rulesets = ['101', '102'].map((id) => {
      const ruleset = compactRuleset(id);
      ruleset.rules = Array.from({ length: 51 }, () => ({ type: 'deletion', parameters: null }));
      return ruleset;
    });
    expectRefusal(snapshot, 'snapshot-schema-unsupported');
  });

  it('admits 100 cumulative actors to schema validation but rejects bypass authority', () => {
    const snapshot = classicSnapshot();
    const ruleset = compactRuleset('101');
    ruleset.bypassActors = Array.from({ length: 100 }, (_, index) => ({
      actorId: String(index + 1),
      actorType: 'Team' as const,
      bypassMode: 'always' as const,
    }));
    snapshot.rulesets = [ruleset];
    expectRefusal(snapshot, 'ruleset-bypass-actors-present');
  });

  it('rejects per-source actor maxima that multiply beyond the cumulative actor budget', () => {
    const snapshot = classicSnapshot();
    snapshot.rulesets = ['101', '102'].map((id, sourceIndex) => {
      const ruleset = compactRuleset(id);
      ruleset.bypassActors = Array.from({ length: 51 }, (_, index) => ({
        actorId: String(sourceIndex * 51 + index + 1),
        actorType: 'Team' as const,
        bypassMode: 'always' as const,
      }));
      return ruleset;
    });
    expectRefusal(snapshot, 'snapshot-schema-unsupported');
  });

  it('includes nested dismissal and required-reviewer actors in the cumulative actor budget', () => {
    const snapshot = classicSnapshot();
    snapshot.rulesets = ['101', '102'].map((id, sourceIndex) => {
      const ruleset = compactRuleset(id);
      ruleset.rules.push({
        type: 'pull_request',
        parameters: {
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 0,
          required_review_thread_resolution: false,
          dismissal_restriction: {
            enabled: true,
            allowed_actors: Array.from({ length: 26 }, (_, index) => ({
              id: sourceIndex * 26 + index + 1,
              type: 'Team',
            })),
          },
          required_reviewers: Array.from({ length: 25 }, (_, index) => ({
            file_patterns: [`src/${sourceIndex}/${index}/**`],
            minimum_approvals: 1,
            reviewer: {
              id: 100 + sourceIndex * 25 + index,
              type: 'Team',
            },
          })),
        },
      });
      return ruleset;
    });

    expectRefusal(snapshot, 'snapshot-schema-unsupported');
  });

  it('accepts 100 logical check bindings across one source', () => {
    const bindings = manyBindings(100);
    const snapshot = rulesetSnapshot();
    setRulesetChecks(snapshot.rulesets[0]!, bindings);
    expect(evaluateSafeMinimumProtectedRemotePolicyV1(snapshot, bindings)).toMatchObject({ ok: true });
  });

  it('rejects repeated per-source check maxima beyond the cumulative check budget', () => {
    const bindings = manyBindings(100);
    const snapshot = rulesetSnapshot();
    const second = rulesetPolicy(false, '102');
    setRulesetChecks(snapshot.rulesets[0]!, bindings);
    setRulesetChecks(second, bindings);
    snapshot.rulesets.push(second);
    expectRefusal(snapshot, 'snapshot-schema-unsupported', bindings);
  });

  it('rejects compact-count snapshots that exceed the cumulative serialized-byte budget', () => {
    const snapshot = classicSnapshot();
    snapshot.rulesets = Array.from({ length: 100 }, (_, index) => {
      const ruleset = compactRuleset(String(index + 1));
      ruleset.conditions = {
        ref_name: {
          include: Array.from({ length: 6 }, (_, refIndex) =>
            `refs/heads/${index}/${refIndex}/${'x'.repeat(480)}`),
          exclude: [],
        },
      };
      return ruleset;
    });
    expectRefusal(snapshot, 'snapshot-schema-unsupported');
  });

  it('enforces the cumulative snapshot budget in UTF-8 bytes', () => {
    const snapshot = classicSnapshot();
    snapshot.rulesets = Array.from({ length: 100 }, (_, index) => {
      const ruleset = compactRuleset(String(index + 1));
      ruleset.conditions = {
        ref_name: {
          include: Array.from({ length: 5 }, () => '\u{1F600}'.repeat(200)),
          exclude: [],
        },
      };
      return ruleset;
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized.length).toBeLessThan(256 * 1024);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeGreaterThan(256 * 1024);
    expectRefusal(snapshot, 'snapshot-schema-unsupported');
  });

  it('bounds configured check count and context length before projection', () => {
    expect(configuredSignal(manyBindings(101))).toMatchObject({
      ok: false,
      expectationMode: 'invalid',
      requiredCheckBindings: [],
    });
    expect(configuredSignal([
      { context: 'ci/test', appId: '1' },
      { context: 'x'.repeat(257), appId: '2' },
    ])).toMatchObject({
      ok: false,
      expectationMode: 'invalid',
      requiredCheckBindings: [],
    });
    expect(configuredSignal(['x'.repeat(257)])).toMatchObject({
      ok: false,
      expectationMode: 'invalid',
      requiredCheckBindings: [],
    });
  });

  it('bounds configured App IDs before decimal validation', () => {
    expectRefusal(
      classicSnapshot(),
      'configured-binding-malformed',
      [{ context: 'ci/test', appId: '9'.repeat(100_000) }],
    );
  });

  it('rejects unknown configured binding fields before projection', () => {
    expect(configuredSignal([{
      context: 'ci/test',
      appId: '15368',
      futureAppAuthority: true,
    }])).toMatchObject({
      ok: false,
      expectationMode: 'invalid',
      requiredCheckBindings: [],
    });
  });

  it('rejects oversized configured App IDs before BigInt conversion', () => {
    const bigInt = vi.spyOn(globalThis, 'BigInt').mockImplementation(() => {
      throw new Error('oversized configured App ID reached BigInt');
    });
    try {
      expect(configuredSignal([{ context: 'ci/test', appId: '9'.repeat(21) }])).toMatchObject({
        ok: false,
        expectationMode: 'invalid',
        requiredCheckBindings: [],
      });
      expect(bigInt).not.toHaveBeenCalled();
    } finally {
      bigInt.mockRestore();
    }
  });

  it('bounds canonical classic App IDs before decimal validation', () => {
    const snapshot = classicSnapshot();
    snapshot.classic!.requiredStatusChecks!.checks[0]!.appId = '9'.repeat(100_000);
    expectRefusal(snapshot, 'snapshot-schema-unsupported');
  });

  it('bounds ruleset parameter App IDs before decimal validation', () => {
    const snapshot = rulesetSnapshot();
    const status = snapshot.rulesets[0]!.rules.find((rule) => rule.type === 'required_status_checks')!;
    const checks = status.parameters!['required_status_checks'] as Array<Record<string, unknown>>;
    checks[0]!['integration_id'] = '9'.repeat(100_000);
    expectRefusal(snapshot, 'snapshot-schema-unsupported');
  });
});
