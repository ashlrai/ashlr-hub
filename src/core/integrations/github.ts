/**
 * core/integrations/github.ts — GitHub integration via the `gh` CLI.
 *
 * RULES:
 *  - READ-FIRST: githubStatus, listPrs, listIssues are read-only and NEVER throw.
 *    On any failure (gh missing, not authed, not a repo, malformed output) they
 *    return a safe empty/degraded shape.
 *  - NEVER handle, read, log, or print raw tokens. `gh` owns its own auth.
 *  - createPr is EXPLICIT + MUTATING. The CLI layer (cli/gh.ts) MUST gate it
 *    behind an explicit `ashlr gh pr create` + confirmation prompt before calling.
 *  - All spawns use spawnSync (no shell) with a tight timeout.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { GithubStatus } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GH_BIN = 'gh';
const TIMEOUT_MS = 8_000; // ms — gh can be slow on first auth check
const BRANCH_PROTECTION_CACHE_MAX = 128;
const BRANCH_PROTECTION_POSITIVE_TTL_MS = 30_000;
const BRANCH_PROTECTION_NEGATIVE_TTL_MS = 5_000;
const MAX_BRANCH_RULES = 100;
const EFFECTIVE_RULES_PER_PAGE = 100;
const MAX_EFFECTIVE_RULES = 1_000;
const MAX_POLICY_RULESETS = 100;
const MAX_REQUIRED_CHECKS = 100;
const MAX_POLICY_ACTORS = 100;
const MAX_POLICY_ID_LENGTH = 20;
const MAX_POLICY_DEPTH = 10;
const MAX_POLICY_OBJECT_KEYS = 128;
const MAX_POLICY_ARRAY_ITEMS = 256;
const MAX_POLICY_STRING_LENGTH = 8_192;
const MAX_POLICY_SNAPSHOT_NODES = 10_000;
const MAX_POLICY_SNAPSHOT_BYTES = 256 * 1024;
const MAX_PR_VIEW_JSON_LENGTH = 64 * 1024;
const MAX_PR_SELECTOR_LENGTH = 2_048;
const MAX_PR_REF_LENGTH = 1_024;
const MAX_ATTESTATION_BUFFER_BYTES = 1_048_576;

const EXACT_BRANCH_AUTHORITY_QUERY = `
  query ExactBranchAuthority($owner: String!, $name: String!, $qualifiedName: String!) {
    repository(owner: $owner, name: $name) {
      id
      nameWithOwner
      defaultBranchRef { name }
      ref(qualifiedName: $qualifiedName) {
        name
        target { oid }
        branchProtectionRule {
          id
          pattern
          allowsDeletions
          allowsForcePushes
          blocksCreations
          dismissesStaleReviews
          isAdminEnforced
          lockAllowsFetchAndMerge
          lockBranch
          requireLastPushApproval
          requiredApprovingReviewCount
          requiresApprovingReviews
          requiresCodeOwnerReviews
          requiresCommitSignatures
          requiresConversationResolution
          requiresDeployments
          requiresLinearHistory
          requiresStatusChecks
          requiresStrictStatusChecks
          restrictsPushes
          restrictsReviewDismissals
          requiredDeploymentEnvironments
          requiredStatusChecks { context app { databaseId } }
          bypassForcePushAllowances(first: 100) {
            totalCount
            pageInfo { hasNextPage }
            nodes { actor { ...BypassAllowanceActor } }
          }
          bypassPullRequestAllowances(first: 100) {
            totalCount
            pageInfo { hasNextPage }
            nodes { actor { ...BypassAllowanceActor } }
          }
          pushAllowances(first: 100) {
            totalCount
            pageInfo { hasNextPage }
            nodes { actor { ...PushAllowanceActor } }
          }
          reviewDismissalAllowances(first: 100) {
            totalCount
            pageInfo { hasNextPage }
            nodes { actor { ...ReviewAllowanceActor } }
          }
        }
      }
    }
  }
  fragment BypassAllowanceActor on BranchActorAllowanceActor {
    __typename
    ... on App { databaseId slug }
    ... on Team { databaseId slug }
    ... on User { databaseId login }
  }
  fragment PushAllowanceActor on PushAllowanceActor {
    __typename
    ... on App { databaseId slug }
    ... on Team { databaseId slug }
    ... on User { databaseId login }
  }
  fragment ReviewAllowanceActor on ReviewDismissalAllowanceActor {
    __typename
    ... on App { databaseId slug }
    ... on Team { databaseId slug }
    ... on User { databaseId login }
  }
`;

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** A single PR summary (read-only list). */
export interface PrSummary {
  number: number;
  title: string;
  url: string;
  state: string;
  author: string;
}

export type PrAutoMergeMethod = 'MERGE' | 'REBASE' | 'SQUASH';

export interface PrAutoMergeRequest {
  enabledAt: string;
  enabledByLogin: string;
  mergeMethod: PrAutoMergeMethod;
}

/** Host evidence for auto-merge. Only `absent` proves cancellation. */
export type PrAutoMergeRequestState =
  | { kind: 'absent' }
  | { kind: 'present'; request: PrAutoMergeRequest }
  | { kind: 'unknown'; reason: 'missing' | 'malformed' };

/** Detailed read-only PR status used to reconcile remote host handoffs. */
export interface PrView {
  number?: number;
  url?: string;
  state?: string;
  mergedAt?: string | null;
  closed?: boolean;
  closedAt?: string | null;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  baseRefOid?: string;
  mergeCommitOid?: string;
  autoMergeRequest: PrAutoMergeRequestState;
}

/** A single issue summary (read-only list). */
export interface IssueSummary {
  number: number;
  title: string;
  url: string;
  state: string;
  author: string;
}

/** Issue summary with label names for autonomous actionability policy. */
export interface LabeledIssueSummary extends IssueSummary {
  labels: string[];
}

export interface ListIssuesOptions {
  limit?: number;
  includeLabels?: boolean;
}

/** Options for creating a PR (EXPLICIT mutation only). */
export interface CreatePrOpts {
  title: string;
  body?: string;
  base?: string;
  head?: string;
  draft?: boolean;
  repo?: string;
}

/** Result of a PR creation (EXPLICIT mutation only). */
export interface CreatePrResult {
  ok: boolean;
  url: string | null;
  detail: string;
}

export interface BranchProtectionAttestationOptions {
  /** Bypass any cached observation. Concurrent refreshes still share one read. */
  forceFresh?: boolean;
  /** Canonical origin owner/repo. Prevents ambient GH_REPO from changing authority. */
  expectedNameWithOwner?: string;
}

export interface RequiredCheckBinding {
  context: string;
  appId: string | null;
}

export type CanonicalPolicyValue =
  | null
  | boolean
  | number
  | string
  | CanonicalPolicyValue[]
  | { [key: string]: CanonicalPolicyValue };

export interface CanonicalNamedActor {
  id: string;
  name: string;
}

export interface CanonicalClassicActorSet {
  users: CanonicalNamedActor[];
  teams: CanonicalNamedActor[];
  apps: CanonicalNamedActor[];
}

export interface CanonicalClassicProtection {
  ruleId: string;
  pattern: string;
  bypassForcePushAllowanceCount: number;
  bypassForcePushAllowances: CanonicalClassicActorSet;
  requiredDeployments: { environments: string[] } | null;
  requiredStatusChecks: {
    strict: boolean;
    enforcementLevel: string | null;
    checks: RequiredCheckBinding[];
  } | null;
  enforceAdmins: boolean;
  requiredPullRequestReviews: {
    dismissStaleReviews: boolean;
    requireCodeOwnerReviews: boolean;
    requiredApprovingReviewCount: number;
    requireLastPushApproval: boolean;
    restrictReviewDismissals: boolean;
    dismissalRestrictions: CanonicalClassicActorSet;
    bypassPullRequestAllowances: CanonicalClassicActorSet;
  } | null;
  pushRestrictions: CanonicalClassicActorSet | null;
  requiredSignatures: boolean;
  requiredLinearHistory: boolean;
  allowForcePushes: boolean;
  allowDeletions: boolean;
  blockCreations: boolean;
  requiredConversationResolution: boolean;
  lockBranch: boolean;
  allowForkSyncing: boolean;
}

export interface CanonicalRulesetBypassActor {
  actorId: string | null;
  actorType: 'Integration' | 'OrganizationAdmin' | 'RepositoryRole' | 'Team' | 'DeployKey' |
    'EnterpriseOwner' | 'EnterpriseRole' | 'User';
  bypassMode: 'always' | 'pull_request' | 'exempt';
}

export interface CanonicalRulesetRule {
  type: string;
  parameters: { [key: string]: CanonicalPolicyValue } | null;
}

export interface CanonicalRulesetProtection {
  id: string;
  sourceType: 'Repository' | 'Organization' | 'Enterprise';
  source: string;
  target: 'branch';
  enforcement: 'active';
  bypassActors: CanonicalRulesetBypassActor[];
  conditions: { [key: string]: CanonicalPolicyValue };
  rules: CanonicalRulesetRule[];
  requiredCheckBindings: RequiredCheckBinding[];
}

export interface BranchProtectionPolicySnapshot {
  schemaVersion: 2;
  classic: CanonicalClassicProtection | null;
  rulesets: CanonicalRulesetProtection[];
}

export const SAFE_MINIMUM_PROTECTED_REMOTE_POLICY_EVALUATOR_ID =
  'ashlr:github:safe-minimum-protected-remote-policy' as const;
export const SAFE_MINIMUM_PROTECTED_REMOTE_POLICY_EVALUATOR_VERSION = 1 as const;
export const SAFE_MINIMUM_PROTECTED_REMOTE_POLICY_VERSION =
  SAFE_MINIMUM_PROTECTED_REMOTE_POLICY_EVALUATOR_VERSION;

const PROTECTED_REMOTE_POLICY_AUTHORITY_DIGEST_DOMAIN =
  'ashlr:github:protected-remote-policy-authority-digest:v1' as const;

export type SafeMinimumProtectedRemotePolicyRefusalReason =
  | 'snapshot-schema-unsupported'
  | 'snapshot-source-missing'
  | 'configured-bindings-missing'
  | 'configured-binding-malformed'
  | 'configured-binding-any-app'
  | 'configured-binding-duplicate'
  | 'configured-binding-conflict'
  | 'classic-source-incomplete'
  | 'classic-status-checks-missing'
  | 'classic-status-checks-not-strict'
  | 'classic-status-check-bindings-unsafe'
  | 'classic-admin-enforcement-missing'
  | 'classic-bypass-actors-present'
  | 'classic-signature-policy-unknown'
  | 'ruleset-source-incomplete'
  | 'ruleset-source-duplicate'
  | 'ruleset-bypass-actors-present'
  | 'ruleset-rule-unknown'
  | 'ruleset-rule-duplicate'
  | 'ruleset-status-checks-missing'
  | 'ruleset-status-checks-not-strict'
  | 'ruleset-status-check-bindings-unsafe'
  | 'ruleset-signature-policy-unknown'
  | 'effective-status-checks-missing'
  | 'effective-status-check-bindings-unsafe'
  | 'effective-force-push-prohibition-missing'
  | 'effective-deletion-prohibition-missing';

export type SafeMinimumProtectedRemotePolicyV1Verdict =
  | {
      ok: true;
      policyVersion: typeof SAFE_MINIMUM_PROTECTED_REMOTE_POLICY_VERSION;
      snapshotSchemaVersion: 2;
      signaturePolicy: 'required' | 'not-required';
      sourceCount: number;
      detail: string;
    }
  | {
      ok: false;
      policyVersion: typeof SAFE_MINIMUM_PROTECTED_REMOTE_POLICY_VERSION;
      reason: SafeMinimumProtectedRemotePolicyRefusalReason;
      detail: string;
    };

export interface BranchProtectionAttestation {
  /** True only when live evidence confirms protection and a requirement. */
  ok: boolean;
  available: boolean;
  protected: boolean;
  /** Compatibility field for protected-remote configuration consumers. */
  branchProtection: boolean;
  nameWithOwner: string | null;
  repositoryId: string | null;
  defaultBranch: string | null;
  branch: string | null;
  baseHead: string | null;
  observedAt: string;
  requirements: string[];
  requiredChecks: string[];
  requiredCheckBindings: RequiredCheckBinding[];
  sources: Array<'classic' | 'ruleset'>;
  /** Canonical merge-critical policy semantics. Null when policy evidence is unavailable. */
  policySnapshot?: BranchProtectionPolicySnapshot | null;
  detail: string;
}

interface BranchProtectionCacheEntry {
  value: BranchProtectionAttestation;
  expiresAt: number;
}

const branchProtectionCache = new Map<string, BranchProtectionCacheEntry>();
const branchProtectionFlights = new Map<string, Promise<BranchProtectionAttestation>>();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Run a `gh` sub-command synchronously in `cwd`.
 * Returns trimmed stdout on success (exit 0), or null on any error.
 * NEVER throws.
 */
function runGh(cwd: string, args: string[]): string | null {
  try {
    const res = spawnSync(GH_BIN, args, {
      cwd,
      timeout: TIMEOUT_MS,
      stdio: 'pipe',
      encoding: 'utf8',
      // Suppress interactive prompts; gh is already authed via its own config.
      env: {
        ...process.env,
        GH_HOST: 'github.com',
        GH_NO_UPDATE_NOTIFIER: '1',
        NO_COLOR: '1',
      },
    });
    // spawn error (e.g. ENOENT — gh not on PATH) or non-zero exit → null.
    if (res.error) return null;
    if (res.status !== 0) return null;
    return typeof res.stdout === 'string' ? res.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Parse a JSON string safely. Returns null on any parse error.
 */
function safeJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Determine CI status from the most recent workflow runs in cwd.
 * Uses `gh run list --limit 5 --json status,conclusion` and aggregates:
 *   - any 'in_progress' / 'queued' / 'waiting' → 'pending'
 *   - any 'failure' / 'cancelled' / 'timed_out' → 'failing'
 *   - all 'success' / 'skipped' / 'neutral' → 'passing'
 *   - no runs found → 'none'
 * NEVER throws.
 */
function resolveCiStatus(cwd: string): GithubStatus['ci'] {
  const raw = runGh(cwd, [
    'run',
    'list',
    '--limit',
    '5',
    '--json',
    'status,conclusion',
  ]);
  const parsed = safeJson(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) return 'none';

  type RunEntry = { status?: string; conclusion?: string };
  const runs = parsed as RunEntry[];

  const IN_PROGRESS_STATUSES = new Set([
    'in_progress',
    'queued',
    'waiting',
    'requested',
    'pending',
  ]);
  const FAILURE_CONCLUSIONS = new Set([
    'failure',
    'cancelled',
    'timed_out',
    'action_required',
    'startup_failure',
  ]);
  const SUCCESS_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

  for (const run of runs) {
    const status = (run.status ?? '').toLowerCase();
    const conclusion = (run.conclusion ?? '').toLowerCase();

    if (IN_PROGRESS_STATUSES.has(status)) return 'pending';
    if (FAILURE_CONCLUSIONS.has(conclusion)) return 'failing';
    // completed with non-success conclusion is also failing
    if (status === 'completed' && conclusion && !SUCCESS_CONCLUSIONS.has(conclusion)) {
      return 'failing';
    }
  }

  // If we get here all completed runs were success/skipped/neutral
  return 'passing';
}

// ---------------------------------------------------------------------------
// Public API — READ-ONLY (never throw)
// ---------------------------------------------------------------------------

/**
 * Read-only repo snapshot via `gh`. NEVER throws — degrades to a not-a-repo
 * shape when cwd is not a GitHub repo or gh is unavailable / not authed.
 */
export function githubStatus(cwd: string): GithubStatus {
  const NOT_A_REPO: GithubStatus = {
    isRepo: false,
    openPrs: 0,
    openIssues: 0,
    ci: 'none',
    repo: null,
  };

  // ── 1. Confirm it's a GitHub repo ────────────────────────────────────────
  const repoRaw = runGh(cwd, ['repo', 'view', '--json', 'nameWithOwner']);
  if (!repoRaw) return NOT_A_REPO;

  const repoParsed = safeJson(repoRaw);
  if (
    repoParsed === null ||
    typeof repoParsed !== 'object' ||
    Array.isArray(repoParsed)
  ) {
    return NOT_A_REPO;
  }
  const repoObj = repoParsed as Record<string, unknown>;
  const repoSlug =
    typeof repoObj['nameWithOwner'] === 'string'
      ? repoObj['nameWithOwner']
      : null;
  if (!repoSlug) return NOT_A_REPO;

  // ── 2. Open PR count ─────────────────────────────────────────────────────
  let openPrs = 0;
  {
    const raw = runGh(cwd, [
      'pr',
      'list',
      '--state',
      'open',
      '--json',
      'number',
    ]);
    const parsed = safeJson(raw);
    if (Array.isArray(parsed)) openPrs = parsed.length;
  }

  // ── 3. Open issue count ──────────────────────────────────────────────────
  let openIssues = 0;
  {
    const raw = runGh(cwd, [
      'issue',
      'list',
      '--state',
      'open',
      '--json',
      'number',
    ]);
    const parsed = safeJson(raw);
    if (Array.isArray(parsed)) openIssues = parsed.length;
  }

  // ── 4. CI status ─────────────────────────────────────────────────────────
  const ci = resolveCiStatus(cwd);

  return {
    isRepo: true,
    openPrs,
    openIssues,
    ci,
    repo: repoSlug,
  };
}

/**
 * List open PRs via `gh pr list`. NEVER throws — returns [] on any failure.
 */
export function listPrs(cwd: string): PrSummary[] {
  const raw = runGh(cwd, [
    'pr',
    'list',
    '--state',
    'open',
    '--json',
    'number,title,url,state,author',
  ]);
  const parsed = safeJson(raw);
  if (!Array.isArray(parsed)) return [];

  const results: PrSummary[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;

    const number = typeof obj['number'] === 'number' ? obj['number'] : 0;
    const title = typeof obj['title'] === 'string' ? obj['title'] : '';
    const url = typeof obj['url'] === 'string' ? obj['url'] : '';
    const state = typeof obj['state'] === 'string' ? obj['state'] : '';

    // author is a nested { login: string } object in gh's JSON output
    let author = '';
    if (obj['author'] !== null && typeof obj['author'] === 'object') {
      const a = obj['author'] as Record<string, unknown>;
      if (typeof a['login'] === 'string') author = a['login'];
    } else if (typeof obj['author'] === 'string') {
      author = obj['author'];
    }

    results.push({ number, title, url, state, author });
  }
  return results;
}

/**
 * Read one PR via `gh pr view`. NEVER throws — returns null on any failure.
 *
 * `selector` may be a PR URL, number, or branch name supported by the gh CLI.
 * This is read-only and is safe for daemon reconciliation loops.
 */
export function viewPr(
  cwd: string,
  selector: string,
  options: { repo?: string } = {},
): PrView | null {
  if (selector.length === 0 || selector.length > MAX_PR_SELECTOR_LENGTH ||
      (options.repo !== undefined &&
        (options.repo.length > MAX_PR_REF_LENGTH ||
          !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(options.repo)))) {
    return null;
  }
  const raw = runGh(cwd, [
    'pr',
    'view',
    selector,
    ...(options.repo ? ['--repo', options.repo] : []),
    '--json',
    'number,url,state,mergedAt,closed,closedAt,headRefName,headRefOid,baseRefName,baseRefOid,mergeCommit,autoMergeRequest',
  ]);
  if (raw !== null && raw.length > MAX_PR_VIEW_JSON_LENGTH) return null;
  const parsed = safeJson(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const mergeCommit = obj['mergeCommit'];
  let mergeCommitOid: string | undefined;
  if (mergeCommit !== null && typeof mergeCommit === 'object' && !Array.isArray(mergeCommit)) {
    const commitObj = mergeCommit as Record<string, unknown>;
    if (typeof commitObj['oid'] === 'string') mergeCommitOid = commitObj['oid'];
  }
  const autoMergeRequest = parseAutoMergeRequestState(obj);
  return {
    ...(typeof obj['number'] === 'number' ? { number: obj['number'] } : {}),
    ...(typeof obj['url'] === 'string' ? { url: obj['url'] } : {}),
    ...(typeof obj['state'] === 'string' ? { state: obj['state'] } : {}),
    ...(typeof obj['mergedAt'] === 'string' || obj['mergedAt'] === null ? { mergedAt: obj['mergedAt'] } : {}),
    ...(typeof obj['closed'] === 'boolean' ? { closed: obj['closed'] } : {}),
    ...(typeof obj['closedAt'] === 'string' || obj['closedAt'] === null ? { closedAt: obj['closedAt'] } : {}),
    ...(typeof obj['headRefName'] === 'string' ? { headRefName: obj['headRefName'] } : {}),
    ...(typeof obj['headRefOid'] === 'string' ? { headRefOid: obj['headRefOid'] } : {}),
    ...(typeof obj['baseRefName'] === 'string' ? { baseRefName: obj['baseRefName'] } : {}),
    ...(typeof obj['baseRefOid'] === 'string' ? { baseRefOid: obj['baseRefOid'] } : {}),
    ...(mergeCommitOid ? { mergeCommitOid } : {}),
    autoMergeRequest,
  };
}

function parseAutoMergeRequestState(obj: Record<string, unknown>): PrAutoMergeRequestState {
  if (!Object.prototype.hasOwnProperty.call(obj, 'autoMergeRequest')) {
    return { kind: 'unknown', reason: 'missing' };
  }
  const value = obj['autoMergeRequest'];
  if (value === null) return { kind: 'absent' };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'unknown', reason: 'malformed' };
  }
  const request = value as Record<string, unknown>;
  const enabledAt = boundedNonEmptyString(request['enabledAt'], 128);
  const enabledBy = request['enabledBy'];
  const enabledByLogin = enabledBy !== null && typeof enabledBy === 'object' && !Array.isArray(enabledBy)
    ? boundedNonEmptyString((enabledBy as Record<string, unknown>)['login'], 256)
    : null;
  const mergeMethod = request['mergeMethod'];
  if (!enabledAt || !enabledByLogin ||
      (mergeMethod !== 'MERGE' && mergeMethod !== 'REBASE' && mergeMethod !== 'SQUASH')) {
    return { kind: 'unknown', reason: 'malformed' };
  }
  return {
    kind: 'present',
    request: { enabledAt, enabledByLogin, mergeMethod },
  };
}

function boundedNonEmptyString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  return value.trim().length > 0 && value.length <= maxLength ? value : null;
}

function normalizedIssueAuthor(value: unknown): string | null {
  if (value === null) return '';
  if (typeof value === 'string') return boundedNonEmptyString(value, 256);
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  return boundedNonEmptyString((value as Record<string, unknown>)['login'], 256);
}

function normalizedIssueLabels(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const labels: string[] = [];
  for (const label of value) {
    if (label === null || typeof label !== 'object' || Array.isArray(label)) return null;
    const name = boundedNonEmptyString((label as Record<string, unknown>)['name'], 100);
    if (!name) return null;
    labels.push(name);
  }
  return labels;
}

export function listIssues(cwd: string): IssueSummary[];
export function listIssues(
  cwd: string,
  options: ListIssuesOptions & { includeLabels: true },
): LabeledIssueSummary[];
export function listIssues(
  cwd: string,
  options: ListIssuesOptions & { includeLabels?: false },
): IssueSummary[];
export function listIssues(cwd: string, options: ListIssuesOptions): IssueSummary[];
/** List open issues via `gh issue list`. NEVER throws — returns [] on failure. */
export function listIssues(
  cwd: string,
  options: ListIssuesOptions = {},
): IssueSummary[] | LabeledIssueSummary[] {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) return [];
  if (options.includeLabels !== undefined && typeof options.includeLabels !== 'boolean') return [];
  const includeLabels = options.includeLabels === true;
  if (
    options.limit !== undefined &&
    (typeof options.limit !== 'number' ||
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 100)
  ) return [];
  const requestedLimit = options.limit;
  const localLimit = requestedLimit ?? (includeLabels ? 100 : 30);
  const args = [
    'issue',
    'list',
    '--state',
    'open',
  ];
  if (requestedLimit !== undefined) args.push('--limit', String(requestedLimit));
  args.push(
    '--json',
    includeLabels ? 'number,title,url,state,author,labels' : 'number,title,url,state,author',
  );
  const raw = runGh(cwd, args);
  const parsed = safeJson(raw);
  if (!Array.isArray(parsed)) return [];

  const results: Array<IssueSummary | LabeledIssueSummary> = [];
  for (const item of parsed) {
    if (results.length >= localLimit) break;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;

    const number = obj['number'];
    const title = boundedNonEmptyString(obj['title'], 256);
    const url = boundedNonEmptyString(obj['url'], 2_048);
    const state = boundedNonEmptyString(obj['state'], 32);
    const author = normalizedIssueAuthor(obj['author']);
    if (
      typeof number !== 'number' ||
      !Number.isSafeInteger(number) ||
      number <= 0 ||
      !title ||
      !url ||
      !state ||
      state.toLowerCase() !== 'open' ||
      author === null
    ) continue;

    if (includeLabels) {
      const labels = normalizedIssueLabels(obj['labels']);
      if (!labels) continue;
      results.push({ number, title, url, state, author, labels });
    } else {
      results.push({ number, title, url, state, author });
    }
  }
  return results;
}

type AttestationGhResult =
  | { kind: 'ok'; stdout: string; stdoutBytes: number }
  | { kind: 'not-found' | 'unavailable' };

interface ExactClassicAuthority {
  ruleId: string;
  pattern: string;
  allowsDeletions: boolean;
  allowsForcePushes: boolean;
  blocksCreations: boolean;
  dismissesStaleReviews: boolean;
  isAdminEnforced: boolean;
  lockAllowsFetchAndMerge: boolean;
  lockBranch: boolean;
  requireLastPushApproval: boolean;
  requiredApprovingReviewCount: number | null;
  requiresApprovingReviews: boolean;
  requiresCodeOwnerReviews: boolean;
  requiresCommitSignatures: boolean;
  requiresConversationResolution: boolean;
  requiresDeployments: boolean;
  requiresLinearHistory: boolean;
  requiresStatusChecks: boolean;
  requiresStrictStatusChecks: boolean;
  restrictsPushes: boolean;
  restrictsReviewDismissals: boolean;
  requiredDeploymentEnvironments: string[];
  requiredStatusChecks: RequiredCheckBinding[];
  bypassForcePushAllowanceCount: number;
  bypassPullRequestAllowanceCount: number;
  pushAllowanceCount: number;
  reviewDismissalAllowanceCount: number;
  bypassForcePushAllowances: CanonicalClassicActorSet;
  bypassPullRequestAllowances: CanonicalClassicActorSet;
  pushAllowances: CanonicalClassicActorSet;
  reviewDismissalAllowances: CanonicalClassicActorSet;
}

interface ExactBranchAuthority {
  repositoryId: string;
  nameWithOwner: string;
  defaultBranch: string;
  branch: string;
  headOid: string;
  classic: ExactClassicAuthority | null;
}

function runAttestationGh(
  cwd: string,
  args: string[],
  maxBuffer = MAX_ATTESTATION_BUFFER_BYTES,
): AttestationGhResult {
  try {
    const res = spawnSync(GH_BIN, args, {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: Math.max(1, Math.min(MAX_ATTESTATION_BUFFER_BYTES, Math.floor(maxBuffer))),
      stdio: 'pipe',
      encoding: 'utf8',
      env: {
        ...process.env,
        GH_HOST: 'github.com',
        GH_NO_UPDATE_NOTIFIER: '1',
        NO_COLOR: '1',
        GH_PROMPT_DISABLED: '1',
      },
    });
    if (res.error || res.status !== 0) {
      const stderr = typeof res.stderr === 'string' ? res.stderr : '';
      return /(?:HTTP\s+404|\b404\b|not found)/i.test(stderr)
        ? { kind: 'not-found' }
        : { kind: 'unavailable' };
    }
    return typeof res.stdout === 'string'
      ? {
          kind: 'ok',
          stdout: res.stdout.trim(),
          stdoutBytes: Buffer.byteLength(res.stdout, 'utf8'),
        }
      : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

function parseBoundedCount(value: unknown, max: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
    ? value
    : null;
}

function parseGraphqlRequiredChecks(value: unknown): RequiredCheckBinding[] | null {
  if (!Array.isArray(value) || value.length > MAX_REQUIRED_CHECKS) return null;
  const checks: RequiredCheckBinding[] = [];
  for (const item of value) {
    const check = objectRecord(item);
    const context = boundedNonEmptyString(check?.['context'], 256);
    if (!check || !context || !Object.prototype.hasOwnProperty.call(check, 'app')) return null;
    const rawApp = check['app'];
    let appId: string | null = null;
    if (rawApp !== null) {
      const app = objectRecord(rawApp);
      const parsedAppId = parseAppId(app?.['databaseId']);
      if (!app || parsedAppId === null || parsedAppId === undefined) return null;
      appId = parsedAppId;
    }
    checks.push({ context, appId });
  }
  const sorted = sortedBindings(checks);
  return sorted.length === checks.length ? sorted : null;
}

interface ParsedAllowanceConnection {
  totalCount: number;
  actors: CanonicalClassicActorSet;
}

function parseAllowanceConnection(value: unknown): ParsedAllowanceConnection | null {
  const connection = objectRecord(value);
  const pageInfo = objectRecord(connection?.['pageInfo']);
  const nodes = connection?.['nodes'];
  const totalCount = parseBoundedCount(connection?.['totalCount'], MAX_POLICY_ACTORS);
  if (!connection || !pageInfo || pageInfo['hasNextPage'] !== false || totalCount === null ||
      !Array.isArray(nodes) || nodes.length !== totalCount || nodes.length > MAX_POLICY_ACTORS) {
    return null;
  }
  const actors: CanonicalClassicActorSet = { users: [], teams: [], apps: [] };
  for (const item of nodes) {
    const allowance = objectRecord(item);
    const actor = objectRecord(allowance?.['actor']);
    const type = actor?.['__typename'];
    const id = policyId(actor?.['databaseId']);
    const nameField = type === 'User' ? 'login' : 'slug';
    const name = boundedNonEmptyString(actor?.[nameField], 256);
    if (!allowance || !actor || !id || !name ||
        (type !== 'User' && type !== 'Team' && type !== 'App')) return null;
    const canonical = { id, name: name.toLowerCase() };
    if (type === 'User') actors.users.push(canonical);
    else if (type === 'Team') actors.teams.push(canonical);
    else actors.apps.push(canonical);
  }
  const sortActors = (items: CanonicalNamedActor[]): void => {
    items.sort((a, b) => a.id.localeCompare(b.id) || a.name.localeCompare(b.name));
  };
  sortActors(actors.users);
  sortActors(actors.teams);
  sortActors(actors.apps);
  return { totalCount, actors };
}

function parseDeploymentEnvironments(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_POLICY_ARRAY_ITEMS) return null;
  const environments: string[] = [];
  for (const item of value) {
    const environment = boundedNonEmptyString(item, 256);
    if (!environment) return null;
    environments.push(environment);
  }
  return new Set(environments).size === environments.length ? environments.sort() : null;
}

function parseExactClassicAuthority(value: unknown): ExactClassicAuthority | null {
  const rule = objectRecord(value);
  const ruleId = boundedNonEmptyString(rule?.['id'], 256);
  const pattern = boundedNonEmptyString(rule?.['pattern'], 1_024);
  const bypassForcePush = parseAllowanceConnection(rule?.['bypassForcePushAllowances']);
  const bypassPullRequest = parseAllowanceConnection(rule?.['bypassPullRequestAllowances']);
  const push = parseAllowanceConnection(rule?.['pushAllowances']);
  const reviewDismissal = parseAllowanceConnection(rule?.['reviewDismissalAllowances']);
  const approvingCount = rule?.['requiredApprovingReviewCount'];
  const requiredApprovingReviewCount = approvingCount === null
    ? null
    : parseBoundedCount(approvingCount, 6);
  const booleanFields = [
    'allowsDeletions',
    'allowsForcePushes',
    'blocksCreations',
    'dismissesStaleReviews',
    'isAdminEnforced',
    'lockAllowsFetchAndMerge',
    'lockBranch',
    'requireLastPushApproval',
    'requiresApprovingReviews',
    'requiresCodeOwnerReviews',
    'requiresCommitSignatures',
    'requiresConversationResolution',
    'requiresDeployments',
    'requiresLinearHistory',
    'requiresStatusChecks',
    'requiresStrictStatusChecks',
    'restrictsPushes',
    'restrictsReviewDismissals',
  ];
  if (!rule || !ruleId || !pattern || !bypassForcePush || !bypassPullRequest || !push ||
      !reviewDismissal ||
      (approvingCount !== null && requiredApprovingReviewCount === null) ||
      !booleanFields.every((field) => typeof rule[field] === 'boolean')) return null;

  const requiresStatusChecks = rule['requiresStatusChecks'] as boolean;
  const rawRequiredStatusChecks = rule['requiredStatusChecks'];
  const requiredStatusChecks = rawRequiredStatusChecks === null
    ? []
    : parseGraphqlRequiredChecks(rawRequiredStatusChecks);
  if (!requiredStatusChecks || (rawRequiredStatusChecks === null && requiresStatusChecks) ||
      (!requiresStatusChecks && requiredStatusChecks.length > 0)) return null;

  const requiresDeployments = rule['requiresDeployments'] as boolean;
  const rawEnvironments = rule['requiredDeploymentEnvironments'];
  const requiredDeploymentEnvironments = rawEnvironments === null
    ? []
    : parseDeploymentEnvironments(rawEnvironments);
  if (!requiredDeploymentEnvironments || (rawEnvironments === null && requiresDeployments) ||
      (requiresDeployments && requiredDeploymentEnvironments.length === 0) ||
      (!requiresDeployments && requiredDeploymentEnvironments.length > 0)) return null;
  return {
    ruleId,
    pattern,
    allowsDeletions: rule['allowsDeletions'] as boolean,
    allowsForcePushes: rule['allowsForcePushes'] as boolean,
    blocksCreations: rule['blocksCreations'] as boolean,
    dismissesStaleReviews: rule['dismissesStaleReviews'] as boolean,
    isAdminEnforced: rule['isAdminEnforced'] as boolean,
    lockAllowsFetchAndMerge: rule['lockAllowsFetchAndMerge'] as boolean,
    lockBranch: rule['lockBranch'] as boolean,
    requireLastPushApproval: rule['requireLastPushApproval'] as boolean,
    requiredApprovingReviewCount,
    requiresApprovingReviews: rule['requiresApprovingReviews'] as boolean,
    requiresCodeOwnerReviews: rule['requiresCodeOwnerReviews'] as boolean,
    requiresCommitSignatures: rule['requiresCommitSignatures'] as boolean,
    requiresConversationResolution: rule['requiresConversationResolution'] as boolean,
    requiresDeployments,
    requiresLinearHistory: rule['requiresLinearHistory'] as boolean,
    requiresStatusChecks: rule['requiresStatusChecks'] as boolean,
    requiresStrictStatusChecks: rule['requiresStrictStatusChecks'] as boolean,
    restrictsPushes: rule['restrictsPushes'] as boolean,
    restrictsReviewDismissals: rule['restrictsReviewDismissals'] as boolean,
    requiredDeploymentEnvironments,
    requiredStatusChecks,
    bypassForcePushAllowanceCount: bypassForcePush.totalCount,
    bypassPullRequestAllowanceCount: bypassPullRequest.totalCount,
    pushAllowanceCount: push.totalCount,
    reviewDismissalAllowanceCount: reviewDismissal.totalCount,
    bypassForcePushAllowances: bypassForcePush.actors,
    bypassPullRequestAllowances: bypassPullRequest.actors,
    pushAllowances: push.actors,
    reviewDismissalAllowances: reviewDismissal.actors,
  };
}

function parseExactBranchAuthority(
  value: unknown,
  expectedBranch: string,
): ExactBranchAuthority | null {
  const envelope = objectRecord(value);
  if (envelope && Object.prototype.hasOwnProperty.call(envelope, 'errors')) {
    const errors = envelope['errors'];
    if (!Array.isArray(errors) || errors.length > 0) return null;
  }
  const data = objectRecord(envelope?.['data']);
  const repository = objectRecord(data?.['repository']);
  const defaultBranchRef = objectRecord(repository?.['defaultBranchRef']);
  const ref = objectRecord(repository?.['ref']);
  const target = objectRecord(ref?.['target']);
  const repositoryId = boundedNonEmptyString(repository?.['id'], 256);
  const nameWithOwner = boundedNonEmptyString(repository?.['nameWithOwner'], 512);
  const defaultBranch = boundedNonEmptyString(defaultBranchRef?.['name'], 256);
  const branch = boundedNonEmptyString(ref?.['name'], 256);
  const headOid = boundedNonEmptyString(target?.['oid'], 64);
  if (!envelope || !data || !repository || !ref || !repositoryId || !nameWithOwner || !defaultBranch ||
      !branch || branch !== expectedBranch || !headOid || !/^[0-9a-f]{40}$/i.test(headOid) ||
      !Object.prototype.hasOwnProperty.call(ref, 'branchProtectionRule')) return null;
  const rawClassic = ref['branchProtectionRule'];
  const classic = rawClassic === null ? null : parseExactClassicAuthority(rawClassic);
  if (rawClassic !== null && !classic) return null;
  return { repositoryId, nameWithOwner, defaultBranch, branch, headOid, classic };
}

function readExactBranchAuthority(
  cwd: string,
  nameWithOwner: string,
  branch: string,
): ExactBranchAuthority | null {
  const [owner, name, extra] = nameWithOwner.split('/');
  if (!owner || !name || extra !== undefined) return null;
  const result = runAttestationGh(cwd, [
    'api',
    'graphql',
    '-F',
    `owner=${owner}`,
    '-F',
    `name=${name}`,
    '-F',
    `qualifiedName=refs/heads/${branch}`,
    '-f',
    `query=${EXACT_BRANCH_AUTHORITY_QUERY}`,
  ]);
  return result.kind === 'ok'
    ? parseExactBranchAuthority(safeJson(result.stdout), branch)
    : null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedOwnEnumerableKeys(
  record: Record<string, unknown>,
  maxKeys: number,
): string[] | null {
  const keys: string[] = [];
  for (const key in record) {
    // ECMAScript enumerates an object's own keys before inherited keys.
    if (!Object.prototype.hasOwnProperty.call(record, key)) break;
    if (keys.length >= maxKeys) return null;
    keys.push(key);
  }
  return keys;
}

function attestationCacheKey(repo: string, branch?: string, expectedNameWithOwner?: string): string {
  return `${repo}\0${branch ?? ''}\0${expectedNameWithOwner ?? ''}`;
}

function cloneAttestation(value: BranchProtectionAttestation): BranchProtectionAttestation {
  return {
    ...value,
    requirements: [...value.requirements],
    requiredChecks: [...value.requiredChecks],
    requiredCheckBindings: value.requiredCheckBindings.map((binding) => ({ ...binding })),
    sources: [...value.sources],
    policySnapshot: value.policySnapshot === undefined
      ? undefined
      : value.policySnapshot === null
        ? null
        : JSON.parse(JSON.stringify(value.policySnapshot)) as BranchProtectionPolicySnapshot,
  };
}

function unavailableAttestation(
  detail: string,
  branch: string | null = null,
  identity: Partial<Pick<BranchProtectionAttestation,
    'nameWithOwner' | 'repositoryId' | 'defaultBranch' | 'baseHead'>> = {},
): BranchProtectionAttestation {
  return {
    ok: false,
    available: false,
    protected: false,
    branchProtection: false,
    nameWithOwner: identity.nameWithOwner ?? null,
    repositoryId: identity.repositoryId ?? null,
    defaultBranch: identity.defaultBranch ?? null,
    branch,
    baseHead: identity.baseHead ?? null,
    observedAt: new Date().toISOString(),
    requirements: [],
    requiredChecks: [],
    requiredCheckBindings: [],
    sources: [],
    policySnapshot: null,
    detail,
  };
}

function parseAppId(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value) && (value === -1 || value > 0)) {
    return String(value);
  }
  if (typeof value === 'string' && value.length <= MAX_POLICY_ID_LENGTH &&
      /^(?:-1|[1-9]\d*)$/.test(value)) return value;
  return undefined;
}

function parseRequiredChecks(
  value: unknown,
  appIdField?: 'app_id' | 'integration_id',
): RequiredCheckBinding[] | null {
  if (!Array.isArray(value) || value.length > MAX_REQUIRED_CHECKS) return null;
  const checks: RequiredCheckBinding[] = [];
  for (const item of value) {
    const record = objectRecord(item);
    const context = typeof item === 'string'
      ? boundedNonEmptyString(item, 256)
      : boundedNonEmptyString(record?.['context'], 256);
    if (!context) return null;
    const appId = appIdField ? parseAppId(record?.[appIdField]) : null;
    if (appId === undefined) return null;
    checks.push({ context, appId });
  }
  return checks;
}

function policyId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && value.length <= MAX_POLICY_ID_LENGTH && /^[1-9]\d*$/.test(value)) {
    return value;
  }
  return null;
}

function compareCanonicalPolicyValues(left: CanonicalPolicyValue, right: CanonicalPolicyValue): number {
  const leftJson = JSON.stringify(left);
  const rightJson = JSON.stringify(right);
  return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
}

function canonicalPolicyValue(value: unknown, depth = 0): CanonicalPolicyValue | undefined {
  if (depth > MAX_POLICY_DEPTH) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.length <= MAX_POLICY_STRING_LENGTH ? value : undefined;
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_POLICY_ARRAY_ITEMS) return undefined;
    const normalized: CanonicalPolicyValue[] = [];
    const members = new Set<string>();
    for (const item of value) {
      const parsed = canonicalPolicyValue(item, depth + 1);
      if (parsed === undefined) return undefined;
      const member = JSON.stringify(parsed);
      if (members.has(member)) return undefined;
      members.add(member);
      normalized.push(parsed);
    }
    return normalized.sort(compareCanonicalPolicyValues);
  }
  const record = objectRecord(value);
  if (!record) return undefined;
  const keys = boundedOwnEnumerableKeys(record, MAX_POLICY_OBJECT_KEYS);
  if (!keys || keys.some((key) => key.length === 0 || key.length > 256)) return undefined;
  const normalized: Record<string, CanonicalPolicyValue> = Object.create(null) as Record<
    string,
    CanonicalPolicyValue
  >;
  for (const key of keys.sort()) {
    const parsed = canonicalPolicyValue(record[key], depth + 1);
    if (parsed === undefined) return undefined;
    normalized[key] = parsed;
  }
  return normalized;
}

function canonicalPolicyObject(value: unknown): Record<string, CanonicalPolicyValue> | null {
  const normalized = canonicalPolicyValue(value);
  return normalized !== undefined && normalized !== null &&
    typeof normalized === 'object' && !Array.isArray(normalized)
    ? normalized
    : null;
}

function sortedBindings(bindings: RequiredCheckBinding[]): RequiredCheckBinding[] {
  const unique = new Map<string, RequiredCheckBinding>();
  for (const binding of bindings) {
    unique.set(`${binding.context}\0${binding.appId ?? ''}`, binding);
  }
  return [...unique.values()].sort((a, b) =>
    a.context.localeCompare(b.context) || (a.appId ?? '').localeCompare(b.appId ?? ''));
}

function recordBindings(
  parsed: RequiredCheckBinding[],
  checks: Set<string>,
  bindings: Map<string, RequiredCheckBinding>,
): void {
  for (const binding of parsed) {
    checks.add(binding.context);
    bindings.set(`${binding.context}\0${binding.appId ?? ''}`, binding);
  }
}

const CLASSIC_PROTECTION_FIELDS = [
  'allow_deletions',
  'allow_force_pushes',
  'allow_fork_syncing',
  'block_creations',
  'enabled',
  'enforce_admins',
  'lock_branch',
  'name',
  'protection_url',
  'required_conversation_resolution',
  'required_linear_history',
  'required_pull_request_reviews',
  'required_signatures',
  'required_status_checks',
  'restrictions',
  'url',
] as const;

const CLASSIC_REQUIRED_WRAPPER_FIELDS = [
  'allow_deletions',
  'allow_force_pushes',
  'allow_fork_syncing',
  'block_creations',
  'enforce_admins',
  'lock_branch',
  'required_conversation_resolution',
  'required_linear_history',
  'required_signatures',
] as const;

const CLASSIC_USER_FIELDS = [
  'avatar_url',
  'email',
  'events_url',
  'followers_url',
  'following_url',
  'gists_url',
  'gravatar_id',
  'html_url',
  'id',
  'login',
  'name',
  'node_id',
  'organizations_url',
  'received_events_url',
  'repos_url',
  'site_admin',
  'starred_at',
  'starred_url',
  'subscriptions_url',
  'type',
  'url',
  'user_view_type',
] as const;

const CLASSIC_APP_OWNER_USER_FIELDS = [
  ...CLASSIC_USER_FIELDS,
  'description',
  'hooks_url',
  'issues_url',
  'members_url',
  'public_members_url',
] as const;

const CLASSIC_TEAM_FIELDS = [
  'access_source',
  'description',
  'enterprise_id',
  'html_url',
  'id',
  'ldap_dn',
  'members_url',
  'name',
  'node_id',
  'notification_setting',
  'organization_id',
  'parent',
  'permission',
  'permissions',
  'privacy',
  'repositories_url',
  'slug',
  'type',
  'url',
] as const;

const CLASSIC_TEAM_SIMPLE_FIELDS = [
  'description',
  'enterprise_id',
  'html_url',
  'id',
  'ldap_dn',
  'members_url',
  'name',
  'node_id',
  'notification_setting',
  'organization_id',
  'permission',
  'privacy',
  'repositories_url',
  'slug',
  'type',
  'url',
] as const;

const CLASSIC_APP_FIELDS = [
  'client_id',
  'created_at',
  'description',
  'events',
  'external_url',
  'html_url',
  'id',
  'installations_count',
  'name',
  'node_id',
  'owner',
  'permissions',
  'slug',
  'updated_at',
] as const;

const CLASSIC_ENTERPRISE_FIELDS = [
  'avatar_url',
  'created_at',
  'description',
  'html_url',
  'id',
  'name',
  'node_id',
  'slug',
  'updated_at',
  'website_url',
] as const;

function optionalTransportStrings(
  record: Record<string, unknown>,
  fields: readonly string[],
  nullable: readonly string[] = [],
): boolean {
  const nullableFields = new Set(nullable);
  return fields.every((field) => {
    if (!hasOwn(record, field)) return true;
    const value = record[field];
    return (value === null && nullableFields.has(field)) ||
      (typeof value === 'string' && value.length <= MAX_POLICY_STRING_LENGTH);
  });
}

function optionalTransportIds(record: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => !hasOwn(record, field) || policyId(record[field]) !== null);
}

function isClassicUserEnvelope(value: unknown, appOwner: boolean): boolean {
  const user = objectRecord(value);
  return Boolean(user && hasExactKeys(
    user,
    appOwner ? CLASSIC_APP_OWNER_USER_FIELDS : CLASSIC_USER_FIELDS,
    ['id', 'login'],
  ) &&
    policyId(user['id']) && boundedNonEmptyString(user['login'], 256) &&
    optionalTransportStrings(user, [
      'avatar_url',
      'email',
      'events_url',
      'followers_url',
      'following_url',
      'gists_url',
      'gravatar_id',
      'html_url',
      'name',
      'node_id',
      'organizations_url',
      'received_events_url',
      'repos_url',
      'starred_at',
      'starred_url',
      'subscriptions_url',
      'type',
      'url',
      'user_view_type',
      ...(appOwner ? ['description', 'hooks_url', 'issues_url', 'members_url', 'public_members_url'] : []),
    ], appOwner
      ? ['description', 'email', 'gravatar_id', 'name']
      : ['email', 'gravatar_id', 'name']) &&
    (!hasOwn(user, 'site_admin') || typeof user['site_admin'] === 'boolean'));
}

function isClassicUserActorEnvelope(value: unknown): boolean {
  return isClassicUserEnvelope(value, false);
}

function isClassicAppOwnerUserEnvelope(value: unknown): boolean {
  return isClassicUserEnvelope(value, true);
}

function isClassicTeamPermissions(value: unknown): boolean {
  const permissions = objectRecord(value);
  const fields = ['pull', 'triage', 'push', 'maintain', 'admin'];
  return Boolean(permissions && hasExactKeys(
    permissions,
    fields,
    fields,
  ) && fields.every((field) => typeof permissions[field] === 'boolean'));
}

function isClassicTeamSimpleEnvelope(value: unknown): boolean {
  const team = objectRecord(value);
  return Boolean(team && hasExactKeys(team, CLASSIC_TEAM_SIMPLE_FIELDS, ['id', 'slug']) &&
    policyId(team['id']) && boundedNonEmptyString(team['slug'], 256) &&
    optionalTransportStrings(team, [
      'description',
      'html_url',
      'ldap_dn',
      'members_url',
      'name',
      'node_id',
      'notification_setting',
      'permission',
      'privacy',
      'repositories_url',
      'type',
      'url',
    ], ['description']) && optionalTransportIds(team, ['organization_id', 'enterprise_id']));
}

function isClassicTeamEnvelope(value: unknown): boolean {
  const team = objectRecord(value);
  if (!team || !hasExactKeys(team, CLASSIC_TEAM_FIELDS, ['id', 'slug']) ||
      !policyId(team['id']) || !boundedNonEmptyString(team['slug'], 256) ||
      !optionalTransportStrings(team, [
        'access_source',
        'description',
        'html_url',
        'ldap_dn',
        'members_url',
        'name',
        'node_id',
        'notification_setting',
        'permission',
        'privacy',
        'repositories_url',
        'type',
        'url',
      ], ['description']) || !optionalTransportIds(team, ['organization_id', 'enterprise_id'])) {
    return false;
  }
  if (hasOwn(team, 'permissions') && !isClassicTeamPermissions(team['permissions'])) return false;
  return !hasOwn(team, 'parent') || team['parent'] === null || isClassicTeamSimpleEnvelope(team['parent']);
}

function isClassicEnterpriseEnvelope(value: unknown): boolean {
  const enterprise = objectRecord(value);
  return Boolean(enterprise && hasExactKeys(enterprise, CLASSIC_ENTERPRISE_FIELDS, ['id', 'slug']) &&
    policyId(enterprise['id']) && boundedNonEmptyString(enterprise['slug'], 256) &&
    optionalTransportStrings(enterprise, [
      'avatar_url',
      'created_at',
      'description',
      'html_url',
      'name',
      'node_id',
      'updated_at',
      'website_url',
    ], ['created_at', 'description', 'updated_at', 'website_url']));
}

function isClassicAppPermissions(value: unknown): boolean {
  const permissions = objectRecord(value);
  if (!permissions) return false;
  const keys = boundedOwnEnumerableKeys(permissions, MAX_POLICY_OBJECT_KEYS);
  return keys !== null && keys.every((key) => key.length > 0 && key.length <= 100 &&
      boundedNonEmptyString(permissions[key], 64) !== null);
}

function isClassicAppEnvelope(value: unknown): boolean {
  const app = objectRecord(value);
  if (!app || !hasExactKeys(app, CLASSIC_APP_FIELDS, ['id', 'slug']) ||
      !policyId(app['id']) || !boundedNonEmptyString(app['slug'], 256) ||
      !optionalTransportStrings(app, [
        'client_id',
        'created_at',
        'description',
        'external_url',
        'html_url',
        'name',
        'node_id',
        'updated_at',
      ], ['description']) || (hasOwn(app, 'installations_count') &&
        (typeof app['installations_count'] !== 'number' ||
          !Number.isSafeInteger(app['installations_count']) || app['installations_count'] < 0))) {
    return false;
  }
  if (hasOwn(app, 'owner')) {
    const owner = objectRecord(app['owner']);
    if (!owner || (hasOwn(owner, 'login')
      ? !isClassicAppOwnerUserEnvelope(owner)
      : !isClassicEnterpriseEnvelope(owner))) return false;
  }
  if (hasOwn(app, 'permissions') && !isClassicAppPermissions(app['permissions'])) return false;
  return !hasOwn(app, 'events') || (Array.isArray(app['events']) &&
    app['events'].length <= MAX_POLICY_ARRAY_ITEMS &&
    app['events'].every((event) => boundedNonEmptyString(event, 256) !== null));
}

type ClassicActorSetTransport = 'dismissal' | 'bypass' | 'restriction';

function isClassicActorSetEnvelope(value: unknown, transport: ClassicActorSetTransport): boolean {
  const actors = objectRecord(value);
  const metadata = transport === 'dismissal'
    ? ['url', 'users_url', 'teams_url']
    : transport === 'restriction'
      ? ['url', 'users_url', 'teams_url', 'apps_url']
      : [];
  if (!actors || !hasExactKeys(actors, ['users', 'teams', 'apps', ...metadata], [
    'users',
    'teams',
    'apps',
  ]) || !optionalTransportStrings(actors, metadata)) return false;
  const users = actors['users'];
  const teams = actors['teams'];
  const apps = actors['apps'];
  return Array.isArray(users) && users.length <= MAX_POLICY_ACTORS && users.every(isClassicUserActorEnvelope) &&
    Array.isArray(teams) && teams.length <= MAX_POLICY_ACTORS && teams.every(isClassicTeamEnvelope) &&
    Array.isArray(apps) && apps.length <= MAX_POLICY_ACTORS && apps.every(isClassicAppEnvelope);
}

function isClassicStatusEnvelope(value: unknown): boolean {
  const status = objectRecord(value);
  if (!status || !hasExactKeys(status, [
    'checks',
    'contexts',
    'contexts_url',
    'enforcement_level',
    'strict',
    'url',
  ], ['checks', 'contexts', 'strict']) || typeof status['strict'] !== 'boolean' ||
      !optionalTransportStrings(status, ['contexts_url', 'enforcement_level', 'url'], ['enforcement_level'])) {
    return false;
  }
  const checks = status['checks'];
  return Array.isArray(checks) && checks.length <= MAX_REQUIRED_CHECKS && checks.every((value) => {
    const check = objectRecord(value);
    return Boolean(check && hasExactKeys(check, ['context', 'app_id']) &&
      boundedNonEmptyString(check['context'], 256) && parseAppId(check['app_id']) !== undefined);
  });
}

function isClassicReviewEnvelope(value: unknown): boolean {
  const reviews = objectRecord(value);
  if (!reviews || !hasExactKeys(reviews, [
    'bypass_pull_request_allowances',
    'dismiss_stale_reviews',
    'dismissal_restrictions',
    'require_code_owner_reviews',
    'require_last_push_approval',
    'required_approving_review_count',
    'url',
  ], [
    'dismiss_stale_reviews',
    'require_code_owner_reviews',
    'require_last_push_approval',
    'required_approving_review_count',
  ]) || !optionalTransportStrings(reviews, ['url'])) return false;
  if (hasOwn(reviews, 'dismissal_restrictions') &&
      !isClassicActorSetEnvelope(reviews['dismissal_restrictions'], 'dismissal')) return false;
  return !hasOwn(reviews, 'bypass_pull_request_allowances') ||
    isClassicActorSetEnvelope(reviews['bypass_pull_request_allowances'], 'bypass');
}

function isClassicEnabledWrapper(value: unknown, allowUrl: boolean): boolean {
  const wrapper = objectRecord(value);
  const fields = allowUrl ? ['enabled', 'url'] : ['enabled'];
  return Boolean(wrapper && hasExactKeys(wrapper, fields, ['enabled']) &&
    typeof wrapper['enabled'] === 'boolean' &&
    (!allowUrl || optionalTransportStrings(wrapper, ['url'])));
}

function hasExactClassicProtectionEnvelope(value: unknown): value is Record<string, unknown> {
  const protection = objectRecord(value);
  if (!protection || !hasExactKeys(
    protection,
    CLASSIC_PROTECTION_FIELDS,
    CLASSIC_REQUIRED_WRAPPER_FIELDS,
  ) || !optionalTransportStrings(protection, ['name', 'protection_url', 'url']) ||
      (hasOwn(protection, 'enabled') && typeof protection['enabled'] !== 'boolean')) return false;
  if (hasOwn(protection, 'required_status_checks') &&
      !isClassicStatusEnvelope(protection['required_status_checks'])) return false;
  if (hasOwn(protection, 'required_pull_request_reviews') &&
      !isClassicReviewEnvelope(protection['required_pull_request_reviews'])) return false;
  for (const field of CLASSIC_REQUIRED_WRAPPER_FIELDS) {
    if (!isClassicEnabledWrapper(
      protection[field],
      field === 'enforce_admins' || field === 'required_signatures',
    )) return false;
  }
  return !hasOwn(protection, 'restrictions') ||
    isClassicActorSetEnvelope(protection['restrictions'], 'restriction');
}

function parseEnabledWrapper(value: unknown, allowUrl = false): boolean | null {
  const record = objectRecord(value);
  return record && isClassicEnabledWrapper(record, allowUrl)
    ? record['enabled'] as boolean
    : null;
}

function parseNamedActors(value: unknown, nameField: 'login' | 'slug'): CanonicalNamedActor[] | null {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_POLICY_ACTORS) return null;
  const actors: CanonicalNamedActor[] = [];
  for (const item of value) {
    const actor = objectRecord(item);
    const id = policyId(actor?.['id']);
    const name = boundedNonEmptyString(actor?.[nameField], 256);
    if (!actor || !id || !name) return null;
    actors.push({ id, name: name.toLowerCase() });
  }
  return actors.sort((a, b) => a.id.localeCompare(b.id) || a.name.localeCompare(b.name));
}

function parseClassicActorSet(
  value: unknown,
  transport: ClassicActorSetTransport,
): CanonicalClassicActorSet | null {
  if (value === null || value === undefined) return { users: [], teams: [], apps: [] };
  const record = objectRecord(value);
  if (!record || !isClassicActorSetEnvelope(record, transport)) return null;
  const users = parseNamedActors(record['users'], 'login');
  const teams = parseNamedActors(record['teams'], 'slug');
  const apps = parseNamedActors(record['apps'], 'slug');
  return users && teams && apps ? { users, teams, apps } : null;
}

function classicActorCount(value: CanonicalClassicActorSet): number {
  return value.users.length + value.teams.length + value.apps.length;
}

function classicBindingsMatchAuthority(
  observed: RequiredCheckBinding[],
  authority: RequiredCheckBinding[],
): boolean {
  const remaining = observed.map((binding) => ({ ...binding }));
  for (const expected of authority) {
    const index = remaining.findIndex((candidate) =>
      candidate.context === expected.context &&
      (candidate.appId === expected.appId ||
        (expected.appId === null && (candidate.appId === null || candidate.appId === '-1'))));
    if (index === -1) return false;
    remaining.splice(index, 1);
  }
  return remaining.length === 0;
}

function classicActorSetsEqual(
  observed: CanonicalClassicActorSet,
  authority: CanonicalClassicActorSet,
): boolean {
  return JSON.stringify(observed) === JSON.stringify(authority);
}

function parseClassicProtection(
  value: unknown,
  authority: ExactClassicAuthority,
  requirements: Set<string>,
  checks: Set<string>,
  bindings: Map<string, RequiredCheckBinding>,
): CanonicalClassicProtection | null {
  const protection = objectRecord(value);
  if (!protection || !hasExactClassicProtectionEnvelope(protection)) return null;

  let requiredStatusChecks: CanonicalClassicProtection['requiredStatusChecks'] = null;
  const rawStatus = protection['required_status_checks'];
  if (rawStatus !== null && rawStatus !== undefined) {
    const status = objectRecord(rawStatus);
    if (!status || typeof status['strict'] !== 'boolean') return null;
    const contexts = parseRequiredChecks(status['contexts']);
    const appChecks = parseRequiredChecks(status['checks'], 'app_id');
    const enforcementLevel = status['enforcement_level'] === null || status['enforcement_level'] === undefined
      ? null
      : boundedNonEmptyString(status['enforcement_level'], 100);
    if (!contexts || !appChecks ||
        (status['enforcement_level'] !== null && status['enforcement_level'] !== undefined &&
          enforcementLevel === null)) return null;
    const structuredContexts = new Set(appChecks.map((binding) => binding.context));
    const legacyOnlyContexts = contexts.filter((binding) => !structuredContexts.has(binding.context));
    const parsedChecks = sortedBindings([...appChecks, ...legacyOnlyContexts]);
    requiredStatusChecks = { strict: status['strict'], enforcementLevel, checks: parsedChecks };
    requirements.add('required_status_checks');
    recordBindings(parsedChecks, checks, bindings);
  }

  const enforceAdmins = parseEnabledWrapper(protection['enforce_admins'], true);
  const requiredSignatures = parseEnabledWrapper(protection['required_signatures'], true);
  const requiredLinearHistory = parseEnabledWrapper(protection['required_linear_history']);
  const allowForcePushes = parseEnabledWrapper(protection['allow_force_pushes']);
  const allowDeletions = parseEnabledWrapper(protection['allow_deletions']);
  const blockCreations = parseEnabledWrapper(protection['block_creations']);
  const requiredConversationResolution = parseEnabledWrapper(
    protection['required_conversation_resolution'],
  );
  const lockBranch = parseEnabledWrapper(protection['lock_branch']);
  const allowForkSyncing = parseEnabledWrapper(protection['allow_fork_syncing']);
  if ([
    enforceAdmins,
    requiredSignatures,
    requiredLinearHistory,
    allowForcePushes,
    allowDeletions,
    blockCreations,
    requiredConversationResolution,
    lockBranch,
    allowForkSyncing,
  ].some((enabled) => enabled === null)) return null;

  let requiredPullRequestReviews: CanonicalClassicProtection['requiredPullRequestReviews'] = null;
  const rawReviews = protection['required_pull_request_reviews'];
  if (rawReviews !== null && rawReviews !== undefined) {
    const reviews = objectRecord(rawReviews);
    const count = reviews?.['required_approving_review_count'];
    if (!reviews || typeof reviews['dismiss_stale_reviews'] !== 'boolean' ||
        typeof reviews['require_code_owner_reviews'] !== 'boolean' ||
        typeof reviews['require_last_push_approval'] !== 'boolean' ||
        typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 6) {
      return null;
    }
    const dismissalRestrictions = parseClassicActorSet(reviews['dismissal_restrictions'], 'dismissal');
    const bypassPullRequestAllowances = parseClassicActorSet(
      reviews['bypass_pull_request_allowances'],
      'bypass',
    );
    if (!dismissalRestrictions || !bypassPullRequestAllowances) return null;
    requiredPullRequestReviews = {
      dismissStaleReviews: reviews['dismiss_stale_reviews'],
      requireCodeOwnerReviews: reviews['require_code_owner_reviews'],
      requiredApprovingReviewCount: count,
      requireLastPushApproval: reviews['require_last_push_approval'],
      restrictReviewDismissals: authority.restrictsReviewDismissals,
      dismissalRestrictions,
      bypassPullRequestAllowances,
    };
    requirements.add('pull_request');
  }

  const rawRestrictions = protection['restrictions'];
  const pushRestrictions = rawRestrictions === null || rawRestrictions === undefined
    ? null
    : parseClassicActorSet(rawRestrictions, 'restriction');
  if (rawRestrictions !== null && rawRestrictions !== undefined && !pushRestrictions) return null;
  if (pushRestrictions) requirements.add('push_restrictions');

  const requiredStatusBindings = requiredStatusChecks?.checks ?? [];
  const reviewDismissalCount = requiredPullRequestReviews
    ? classicActorCount(requiredPullRequestReviews.dismissalRestrictions)
    : 0;
  const bypassPullRequestCount = requiredPullRequestReviews
    ? classicActorCount(requiredPullRequestReviews.bypassPullRequestAllowances)
    : 0;
  const pushAllowanceCount = pushRestrictions ? classicActorCount(pushRestrictions) : 0;
  if ((requiredStatusChecks !== null) !== authority.requiresStatusChecks ||
      (requiredPullRequestReviews !== null) !== authority.requiresApprovingReviews ||
      (pushRestrictions !== null) !== authority.restrictsPushes ||
      (requiredStatusChecks !== null &&
        requiredStatusChecks.strict !== authority.requiresStrictStatusChecks) ||
      !classicBindingsMatchAuthority(requiredStatusBindings, authority.requiredStatusChecks) ||
      (requiredPullRequestReviews !== null &&
        (requiredPullRequestReviews.dismissStaleReviews !== authority.dismissesStaleReviews ||
          requiredPullRequestReviews.requireCodeOwnerReviews !== authority.requiresCodeOwnerReviews ||
          requiredPullRequestReviews.requireLastPushApproval !== authority.requireLastPushApproval ||
          requiredPullRequestReviews.requiredApprovingReviewCount !==
            authority.requiredApprovingReviewCount)) ||
      reviewDismissalCount !== authority.reviewDismissalAllowanceCount ||
      bypassPullRequestCount !== authority.bypassPullRequestAllowanceCount ||
      pushAllowanceCount !== authority.pushAllowanceCount ||
      (requiredPullRequestReviews !== null &&
        (!classicActorSetsEqual(
          requiredPullRequestReviews.dismissalRestrictions,
          authority.reviewDismissalAllowances,
        ) || !classicActorSetsEqual(
          requiredPullRequestReviews.bypassPullRequestAllowances,
          authority.bypassPullRequestAllowances,
        ))) ||
      (pushRestrictions !== null &&
        !classicActorSetsEqual(pushRestrictions, authority.pushAllowances)) ||
      enforceAdmins !== authority.isAdminEnforced ||
      requiredSignatures !== authority.requiresCommitSignatures ||
      requiredLinearHistory !== authority.requiresLinearHistory ||
      allowForcePushes !== authority.allowsForcePushes ||
      allowDeletions !== authority.allowsDeletions ||
      blockCreations !== authority.blocksCreations ||
      requiredConversationResolution !== authority.requiresConversationResolution ||
      lockBranch !== authority.lockBranch ||
      allowForkSyncing !== authority.lockAllowsFetchAndMerge) return null;

  if (enforceAdmins) requirements.add('enforce_admins');
  if (requiredSignatures) requirements.add('required_signatures');
  if (requiredLinearHistory) requirements.add('required_linear_history');
  if (blockCreations) requirements.add('block_creations');
  if (requiredConversationResolution) requirements.add('required_conversation_resolution');
  if (lockBranch) requirements.add('lock_branch');
  if (authority.requiresDeployments) requirements.add('required_deployments');

  return {
    ruleId: authority.ruleId,
    pattern: authority.pattern,
    bypassForcePushAllowanceCount: authority.bypassForcePushAllowanceCount,
    bypassForcePushAllowances: authority.bypassForcePushAllowances,
    requiredDeployments: authority.requiresDeployments
      ? { environments: authority.requiredDeploymentEnvironments }
      : null,
    requiredStatusChecks,
    enforceAdmins: enforceAdmins as boolean,
    requiredPullRequestReviews,
    pushRestrictions,
    requiredSignatures: requiredSignatures as boolean,
    requiredLinearHistory: requiredLinearHistory as boolean,
    allowForcePushes: allowForcePushes as boolean,
    allowDeletions: allowDeletions as boolean,
    blockCreations: blockCreations as boolean,
    requiredConversationResolution: requiredConversationResolution as boolean,
    lockBranch: lockBranch as boolean,
    allowForkSyncing: allowForkSyncing as boolean,
  };
}

const SUPPORTED_RULE_TYPES = new Set([
  'creation',
  'update',
  'deletion',
  'required_linear_history',
  'merge_queue',
  'required_deployments',
  'required_signatures',
  'pull_request',
  'required_status_checks',
  'non_fast_forward',
  'commit_message_pattern',
  'commit_author_email_pattern',
  'committer_email_pattern',
  'branch_name_pattern',
  'tag_name_pattern',
  'workflows',
  'code_scanning',
  'copilot_code_review',
  'license_compliance_scanning',
  'file_path_restriction',
  'max_file_path_length',
  'file_extension_restriction',
  'max_file_size',
]);

const PARAMETERLESS_RULE_TYPES = new Set([
  'creation',
  'deletion',
  'required_linear_history',
  'required_signatures',
  'non_fast_forward',
  'license_compliance_scanning',
]);

type ExactBindingValidation =
  | { ok: true; keys: string[] }
  | { ok: false; kind: 'malformed' | 'any-app' | 'duplicate' | 'conflict'; detail: string };

function policyRefusal(
  reason: SafeMinimumProtectedRemotePolicyRefusalReason,
  detail: string,
): SafeMinimumProtectedRemotePolicyV1Verdict {
  return {
    ok: false,
    policyVersion: SAFE_MINIMUM_PROTECTED_REMOTE_POLICY_VERSION,
    reason,
    detail,
  };
}

function validateExactAppBindings(value: unknown): ExactBindingValidation {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REQUIRED_CHECKS) {
    return { ok: false, kind: 'malformed', detail: 'check bindings must be a non-empty bounded array' };
  }
  const byContext = new Map<string, string>();
  const keys: string[] = [];
  for (const item of value) {
    const binding = objectRecord(item);
    const context = boundedNonEmptyString(binding?.['context'], 256);
    const appId = binding?.['appId'];
    if (!binding || !hasExactKeys(binding, ['context', 'appId']) || !context ||
        context.trim() !== context || context.includes('\0') ||
        typeof appId !== 'string' || appId.length > MAX_POLICY_ID_LENGTH ||
        !/^[1-9]\d*$/.test(appId)) {
      if (binding && context && (appId === null || appId === '-1')) {
        return {
          ok: false,
          kind: 'any-app',
          detail: `check '${context}' does not name one exact GitHub App`,
        };
      }
      return { ok: false, kind: 'malformed', detail: 'check binding context/App identity is malformed' };
    }
    const prior = byContext.get(context);
    if (prior !== undefined) {
      return prior === appId
        ? { ok: false, kind: 'duplicate', detail: `check '${context}@${appId}' is duplicated` }
        : {
            ok: false,
            kind: 'conflict',
            detail: `check '${context}' is bound to both App ${prior} and App ${appId}`,
          };
    }
    byContext.set(context, appId);
    keys.push(`${context}\0${appId}`);
  }
  return { ok: true, keys: keys.sort() };
}

function emptyClassicActorSet(value: unknown): boolean {
  const actors = objectRecord(value);
  return Boolean(actors &&
    Array.isArray(actors['users']) && actors['users'].length === 0 &&
    Array.isArray(actors['teams']) && actors['teams'].length === 0 &&
    Array.isArray(actors['apps']) && actors['apps'].length === 0);
}

function hasOwn(record: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}

function hasExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): boolean {
  const keys = boundedOwnEnumerableKeys(record, allowed.length);
  if (!keys) return false;
  const allowedKeys = new Set(allowed);
  return keys.every((field) => allowedKeys.has(field)) &&
    required.every((field) => hasOwn(record, field));
}

interface PolicySnapshotShapeBudget {
  nodes: number;
  bytes: number;
}

function consumePolicySnapshotShape(
  value: unknown,
  budget: PolicySnapshotShapeBudget,
  depth = 0,
): boolean {
  if (depth > MAX_POLICY_DEPTH || ++budget.nodes > MAX_POLICY_SNAPSHOT_NODES) return false;
  if (value === null) {
    budget.bytes += 4;
  } else if (typeof value === 'boolean') {
    budget.bytes += value ? 4 : 5;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return false;
    budget.bytes += String(value).length;
  } else if (typeof value === 'string') {
    if (value.length > MAX_POLICY_STRING_LENGTH) return false;
    budget.bytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
  } else if (Array.isArray(value)) {
    if (value.length > MAX_POLICY_ARRAY_ITEMS) return false;
    budget.bytes += 2 + Math.max(0, value.length - 1);
    for (let index = 0; index < value.length; index++) {
      if (!hasOwn(value as unknown as Record<string, unknown>, String(index)) ||
          !consumePolicySnapshotShape(value[index], budget, depth + 1)) return false;
    }
  } else {
    const record = objectRecord(value);
    if (!record) return false;
    const keys = boundedOwnEnumerableKeys(record, MAX_POLICY_OBJECT_KEYS);
    if (!keys || keys.some((key) => key.length === 0 || key.length > 256)) return false;
    budget.bytes += 2 + Math.max(0, keys.length - 1);
    for (const key of keys) {
      budget.bytes += Buffer.byteLength(JSON.stringify(key), 'utf8') + 1;
      if (!consumePolicySnapshotShape(record[key], budget, depth + 1)) return false;
    }
  }
  return budget.bytes <= MAX_POLICY_SNAPSHOT_BYTES;
}

function canonicalActorSetSize(value: unknown): number {
  const actors = objectRecord(value);
  if (!actors) return 0;
  let total = 0;
  for (const field of ['users', 'teams', 'apps']) {
    const entries = actors[field];
    total += Array.isArray(entries) ? entries.length : 0;
  }
  return total;
}

function rulesetRuleActorCount(value: unknown): number {
  const rule = objectRecord(value);
  if (rule?.['type'] !== 'pull_request') return 0;
  const parameters = objectRecord(rule['parameters']);
  if (!parameters) return 0;
  const dismissalRestriction = objectRecord(parameters['dismissal_restriction']);
  const allowedActors = dismissalRestriction?.['allowed_actors'];
  const requiredReviewers = parameters['required_reviewers'];
  return (Array.isArray(allowedActors) ? allowedActors.length : 0) +
    (Array.isArray(requiredReviewers) ? requiredReviewers.length : 0);
}

function policySnapshotAggregatesWithinBudget(snapshot: Record<string, unknown>): boolean {
  const rulesets = snapshot['rulesets'];
  if (!Array.isArray(rulesets) || rulesets.length > MAX_POLICY_RULESETS) return false;

  let rules = 0;
  let actors = 0;
  let checks = 0;
  const classic = objectRecord(snapshot['classic']);
  if (classic) {
    actors += canonicalActorSetSize(classic['bypassForcePushAllowances']);
    actors += canonicalActorSetSize(classic['pushRestrictions']);
    const reviews = objectRecord(classic['requiredPullRequestReviews']);
    actors += canonicalActorSetSize(reviews?.['dismissalRestrictions']);
    actors += canonicalActorSetSize(reviews?.['bypassPullRequestAllowances']);
    const status = objectRecord(classic['requiredStatusChecks']);
    checks += Array.isArray(status?.['checks']) ? status['checks'].length : 0;
    if (actors > MAX_POLICY_ACTORS || checks > MAX_REQUIRED_CHECKS) return false;
  }

  for (const value of rulesets) {
    const ruleset = objectRecord(value);
    if (!ruleset) continue;
    const rulesetRules = ruleset['rules'];
    if (Array.isArray(rulesetRules)) {
      rules += rulesetRules.length;
      if (rules > MAX_BRANCH_RULES) return false;
    }
    actors += Array.isArray(ruleset['bypassActors']) ? ruleset['bypassActors'].length : 0;
    if (Array.isArray(rulesetRules)) {
      for (const rule of rulesetRules) {
        actors += rulesetRuleActorCount(rule);
        if (actors > MAX_POLICY_ACTORS) return false;
      }
    }
    checks += Array.isArray(ruleset['requiredCheckBindings'])
      ? ruleset['requiredCheckBindings'].length
      : 0;
    if (actors > MAX_POLICY_ACTORS || checks > MAX_REQUIRED_CHECKS) return false;
  }
  return true;
}

function isCanonicalBindingArray(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > MAX_REQUIRED_CHECKS) return false;
  return value.every((item) => {
    const binding = objectRecord(item);
    const context = boundedNonEmptyString(binding?.['context'], 256);
    const appId = binding?.['appId'];
    return Boolean(binding && hasExactKeys(binding, ['context', 'appId']) && context &&
      (appId === null || (typeof appId === 'string' && parseAppId(appId) === appId)));
  });
}

function canonicalClassicActorCount(value: unknown): number | null {
  const actors = objectRecord(value);
  if (!actors || !hasExactKeys(actors, ['users', 'teams', 'apps'])) return null;
  let count = 0;
  for (const field of ['users', 'teams', 'apps']) {
    const entries = actors[field];
    if (!Array.isArray(entries) || entries.length > MAX_POLICY_ACTORS) return null;
    const actorIds = new Set<string>();
    for (const item of entries) {
      const actor = objectRecord(item);
      const id = policyId(actor?.['id']);
      const name = boundedNonEmptyString(actor?.['name'], 256);
      if (!actor || !hasExactKeys(actor, ['id', 'name']) || !id || !name ||
          name !== name.toLowerCase() || actorIds.has(id)) return null;
      actorIds.add(id);
    }
    count += entries.length;
  }
  return count <= MAX_POLICY_ACTORS ? count : null;
}

function isCanonicalDeploymentPolicy(value: unknown): boolean {
  if (value === null) return true;
  const policy = objectRecord(value);
  const environments = policy?.['environments'];
  if (!policy || !hasExactKeys(policy, ['environments']) ||
      !Array.isArray(environments) || environments.length === 0 ||
      environments.length > MAX_POLICY_ARRAY_ITEMS ||
      !environments.every((item) => boundedNonEmptyString(item, 256) !== null)) return false;
  return new Set(environments).size === environments.length;
}

function isCanonicalReviewPolicy(value: unknown): boolean {
  if (value === null) return true;
  const reviews = objectRecord(value);
  const count = reviews?.['requiredApprovingReviewCount'];
  return Boolean(reviews && hasExactKeys(reviews, [
    'dismissStaleReviews',
    'requireCodeOwnerReviews',
    'requiredApprovingReviewCount',
    'requireLastPushApproval',
    'restrictReviewDismissals',
    'dismissalRestrictions',
    'bypassPullRequestAllowances',
  ]) &&
    typeof reviews['dismissStaleReviews'] === 'boolean' &&
    typeof reviews['requireCodeOwnerReviews'] === 'boolean' &&
    typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && count <= 6 &&
    typeof reviews['requireLastPushApproval'] === 'boolean' &&
    typeof reviews['restrictReviewDismissals'] === 'boolean' &&
    canonicalClassicActorCount(reviews['dismissalRestrictions']) !== null &&
    canonicalClassicActorCount(reviews['bypassPullRequestAllowances']) !== null);
}

function validateCanonicalClassicSource(
  value: unknown,
): SafeMinimumProtectedRemotePolicyV1Verdict | null {
  if (value === null) return null;
  const classic = objectRecord(value);
  if (!classic) {
    return policyRefusal('classic-source-incomplete', 'classic source is neither canonical policy nor null');
  }
  const requiredFields = [
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
  ];
  if (!hasExactKeys(classic, requiredFields) ||
      !boundedNonEmptyString(classic['ruleId'], 256) ||
      !boundedNonEmptyString(classic['pattern'], 1_024)) {
    return policyRefusal('classic-source-incomplete', 'classic canonical fields are incomplete');
  }

  const bypassCount = parseBoundedCount(classic['bypassForcePushAllowanceCount'], MAX_POLICY_ACTORS);
  const canonicalBypassCount = canonicalClassicActorCount(classic['bypassForcePushAllowances']);
  if (bypassCount === null || canonicalBypassCount === null || bypassCount !== canonicalBypassCount ||
      !isCanonicalDeploymentPolicy(classic['requiredDeployments']) ||
      !isCanonicalReviewPolicy(classic['requiredPullRequestReviews']) ||
      (classic['pushRestrictions'] !== null &&
        canonicalClassicActorCount(classic['pushRestrictions']) === null)) {
    return policyRefusal('classic-source-incomplete', 'classic canonical nested structures are incomplete');
  }

  const statusValue = classic['requiredStatusChecks'];
  if (statusValue !== null) {
    const status = objectRecord(statusValue);
    const enforcementLevel = status?.['enforcementLevel'];
    if (!status || !hasExactKeys(status, ['strict', 'enforcementLevel', 'checks']) ||
        typeof status['strict'] !== 'boolean' ||
        (enforcementLevel !== null && !boundedNonEmptyString(enforcementLevel, 100)) ||
        !isCanonicalBindingArray(status['checks'])) {
      return policyRefusal('classic-status-checks-missing', 'classic status-check semantics are incomplete');
    }
  }

  if (typeof classic['requiredSignatures'] !== 'boolean') {
    return policyRefusal(
      'classic-signature-policy-unknown',
      'classic source has no explicit canonical signature policy',
    );
  }
  const booleanFields = [
    'enforceAdmins',
    'requiredLinearHistory',
    'allowForcePushes',
    'allowDeletions',
    'blockCreations',
    'requiredConversationResolution',
    'lockBranch',
    'allowForkSyncing',
  ];
  if (!booleanFields.every((field) => typeof classic[field] === 'boolean')) {
    return policyRefusal('classic-source-incomplete', 'classic canonical boolean fields are incomplete');
  }
  return null;
}

function isCanonicalRulesetBypassActors(
  value: unknown,
  sourceType: unknown,
): boolean {
  if (!Array.isArray(value) || value.length > MAX_POLICY_ACTORS) return false;
  const actorIds = new Set<string>();
  return value.every((item) => {
    const actor = objectRecord(item);
    const actorId = actor?.['actorId'];
    const actorType = actor?.['actorType'];
    const bypassMode = actor?.['bypassMode'];
    const enterpriseActor = actorType === 'EnterpriseOwner' || actorType === 'EnterpriseRole';
    const idlessActor = actorType === 'OrganizationAdmin' || actorType === 'DeployKey' || enterpriseActor;
    const validType = actorType === 'Integration' || actorType === 'OrganizationAdmin' ||
      actorType === 'RepositoryRole' || actorType === 'Team' || actorType === 'DeployKey' ||
      actorType === 'User' ||
      ((sourceType === 'Enterprise' || sourceType === 'Organization') && enterpriseActor);
    const valid = Boolean(actor && hasExactKeys(actor, ['actorId', 'actorType', 'bypassMode']) && validType &&
      (bypassMode === 'always' || bypassMode === 'pull_request' || bypassMode === 'exempt') &&
      (actorId === null || (typeof actorId === 'string' && policyId(actorId) === actorId)) &&
      (idlessActor ? actorId === null : actorId !== null));
    if (!valid) return false;
    const identity = `${actorType as string}\0${actorId ?? ''}`;
    if (actorIds.has(identity)) return false;
    actorIds.add(identity);
    return true;
  });
}

function isBoundedStringArray(value: unknown, maxLength = 512): value is string[] {
  return Array.isArray(value) && value.length <= MAX_POLICY_ARRAY_ITEMS &&
    value.every((item) => boundedNonEmptyString(item, maxLength) !== null);
}

function isCanonicalRefNameCondition(value: unknown): boolean {
  const refName = objectRecord(value);
  return Boolean(refName && hasExactKeys(refName, ['include', 'exclude']) &&
    isBoundedStringArray(refName['include']) && isBoundedStringArray(refName['exclude']));
}

function isCanonicalRepositoryNameCondition(value: unknown): boolean {
  const repositoryName = objectRecord(value);
  return Boolean(repositoryName && hasExactKeys(repositoryName, ['include', 'exclude', 'protected']) &&
    isBoundedStringArray(repositoryName['include']) &&
    isBoundedStringArray(repositoryName['exclude']) &&
    typeof repositoryName['protected'] === 'boolean');
}

function isCanonicalRepositoryIdCondition(value: unknown): boolean {
  const repositoryId = objectRecord(value);
  const ids = repositoryId?.['repository_ids'];
  return Boolean(repositoryId && hasExactKeys(repositoryId, ['repository_ids']) &&
    Array.isArray(ids) && ids.length <= MAX_POLICY_ARRAY_ITEMS &&
    ids.every((id) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0));
}

function isCanonicalRepositoryPropertySpec(value: unknown): boolean {
  const property = objectRecord(value);
  const source = property?.['source'];
  return Boolean(property && hasExactKeys(
    property,
    ['name', 'property_values', 'source'],
    ['name', 'property_values'],
  ) && boundedNonEmptyString(property['name'], 256) &&
    isBoundedStringArray(property['property_values'], 256) &&
    (source === undefined || source === 'custom' || source === 'system'));
}

function isCanonicalRepositoryPropertyCondition(value: unknown): boolean {
  const repositoryProperty = objectRecord(value);
  if (!repositoryProperty || !hasExactKeys(repositoryProperty, ['include', 'exclude'])) return false;
  return ['include', 'exclude'].every((field) => {
    const properties = repositoryProperty[field];
    return Array.isArray(properties) && properties.length <= MAX_POLICY_ARRAY_ITEMS &&
      properties.every(isCanonicalRepositoryPropertySpec);
  });
}

function isCanonicalRulesetConditions(value: unknown, sourceType: unknown): boolean {
  const conditions = objectRecord(value);
  if (!conditions || !hasOwn(conditions, 'ref_name') ||
      !isCanonicalRefNameCondition(conditions['ref_name'])) return false;
  const selectors = ['repository_name', 'repository_id', 'repository_property'];
  const presentSelectors = selectors.filter((field) => hasOwn(conditions, field));
  const allowed = sourceType === 'Repository' ? ['ref_name'] : ['ref_name', ...selectors];
  if (!hasExactKeys(conditions, allowed, ['ref_name']) || presentSelectors.length > 1) return false;
  if (hasOwn(conditions, 'repository_name') &&
      !isCanonicalRepositoryNameCondition(conditions['repository_name'])) return false;
  if (hasOwn(conditions, 'repository_id') &&
      !isCanonicalRepositoryIdCondition(conditions['repository_id'])) return false;
  return !hasOwn(conditions, 'repository_property') ||
    isCanonicalRepositoryPropertyCondition(conditions['repository_property']);
}

function validateCanonicalRulesetSource(
  value: unknown,
): SafeMinimumProtectedRemotePolicyV1Verdict | null {
  const ruleset = objectRecord(value);
  const sourceType = ruleset?.['sourceType'];
  const source = boundedNonEmptyString(ruleset?.['source'], 512);
  const id = policyId(ruleset?.['id']);
  if (!ruleset || !hasExactKeys(ruleset, [
    'id',
    'sourceType',
    'source',
    'target',
    'enforcement',
    'bypassActors',
    'conditions',
    'rules',
    'requiredCheckBindings',
  ]) || !id || !source || source !== source.toLowerCase() ||
      (sourceType !== 'Repository' && sourceType !== 'Organization' && sourceType !== 'Enterprise') ||
      ruleset['target'] !== 'branch' || ruleset['enforcement'] !== 'active' ||
      !hasOwn(ruleset, 'bypassActors') || !hasOwn(ruleset, 'conditions') ||
      !hasOwn(ruleset, 'rules') || !hasOwn(ruleset, 'requiredCheckBindings')) {
    return policyRefusal('ruleset-source-incomplete', 'ruleset source identity or canonical fields are incomplete');
  }
  const rules = ruleset['rules'];
  if (!isCanonicalRulesetBypassActors(ruleset['bypassActors'], sourceType) ||
      !isCanonicalRulesetConditions(ruleset['conditions'], sourceType) ||
      !Array.isArray(rules) || rules.length === 0 || rules.length > MAX_BRANCH_RULES ||
      !isCanonicalBindingArray(ruleset['requiredCheckBindings'])) {
    return policyRefusal('ruleset-source-incomplete', `ruleset '${id}' canonical structures are incomplete`);
  }
  for (const ruleValue of rules) {
    const rule = objectRecord(ruleValue);
    const type = boundedNonEmptyString(rule?.['type'], 100);
    if (!rule || !hasExactKeys(rule, ['type', 'parameters']) || !type ||
        !SUPPORTED_RULE_TYPES.has(type)) {
      return policyRefusal('ruleset-rule-unknown', `ruleset '${id}' contains an unknown or incomplete rule`);
    }
    const parameters = rule['parameters'];
    if (PARAMETERLESS_RULE_TYPES.has(type)) {
      if (parameters !== null) {
        return policyRefusal(
          type === 'required_signatures' ? 'ruleset-signature-policy-unknown' : 'ruleset-rule-unknown',
          `ruleset '${id}' contains malformed rule '${type}'`,
        );
      }
      continue;
    }
    const parameterRecord = objectRecord(parameters);
    if (!parameterRecord || !canonicalPolicyObject(parameterRecord) ||
        !validateRuleParameters(type, parameterRecord)) {
      return policyRefusal('ruleset-rule-unknown', `ruleset '${id}' contains malformed rule '${type}'`);
    }
  }
  return null;
}

function canonicalDigestValue(value: CanonicalPolicyValue): CanonicalPolicyValue {
  if (Array.isArray(value)) {
    return value.map(canonicalDigestValue).sort(compareCanonicalPolicyValues);
  }
  if (value !== null && typeof value === 'object') {
    const canonical: Record<string, CanonicalPolicyValue> = Object.create(null) as Record<
      string,
      CanonicalPolicyValue
    >;
    for (const key of Object.keys(value).sort()) {
      canonical[key] = canonicalDigestValue(value[key]!);
    }
    return canonical;
  }
  return value;
}

/** Canonical plain policy value; policy arrays are unordered sets and reject duplicates. */
function canonicalProtectedRemotePolicySnapshot(value: unknown): CanonicalPolicyValue | null {
  const snapshot = objectRecord(value);
  if (!snapshot || !consumePolicySnapshotShape(value, { nodes: 0, bytes: 0 })) return null;

  const canonical = canonicalPolicyValue(value);
  return canonical === undefined ? null : canonicalDigestValue(canonical);
}

/**
 * Stable identity for one exact schema-v2 policy evaluation input. Collection
 * order is non-semantic, while every source-complete policy value remains bound.
 */
export function buildCanonicalProtectedRemotePolicyDigestV1(
  policySnapshot: unknown,
  configuredBindings: readonly RequiredCheckBinding[],
): string | null {
  const configured = validateExactAppBindings(configuredBindings);
  if (!configured.ok) return null;
  if (!evaluateSafeMinimumProtectedRemotePolicyV1(policySnapshot, configuredBindings).ok) return null;
  const normalizedBindings = configured.keys.map((key) => {
    const separator = key.indexOf('\0');
    return {
      context: key.slice(0, separator),
      appId: key.slice(separator + 1),
    };
  });
  const snapshot = canonicalProtectedRemotePolicySnapshot(policySnapshot);
  if (snapshot === null) return null;

  return createHash('sha256').update(JSON.stringify([
    PROTECTED_REMOTE_POLICY_AUTHORITY_DIGEST_DOMAIN,
    SAFE_MINIMUM_PROTECTED_REMOTE_POLICY_EVALUATOR_ID,
    SAFE_MINIMUM_PROTECTED_REMOTE_POLICY_EVALUATOR_VERSION,
    snapshot,
    normalizedBindings,
  ]), 'utf8').digest('hex');
}

/**
 * Pure V1 authority policy over source-complete schema-v2 evidence. Historical
 * snapshots and future schemas remain readable data, but cannot authorize a
 * protected-remote mutation through this evaluator.
 */
export function evaluateSafeMinimumProtectedRemotePolicyV1(
  policySnapshot: unknown,
  configuredBindings: readonly RequiredCheckBinding[],
): SafeMinimumProtectedRemotePolicyV1Verdict {
  const configured = validateExactAppBindings(configuredBindings);
  if (!configured.ok) {
    const reason: SafeMinimumProtectedRemotePolicyRefusalReason = configured.kind === 'any-app'
      ? 'configured-binding-any-app'
      : configured.kind === 'duplicate'
        ? 'configured-binding-duplicate'
        : configured.kind === 'conflict'
          ? 'configured-binding-conflict'
          : Array.isArray(configuredBindings) && configuredBindings.length === 0
            ? 'configured-bindings-missing'
            : 'configured-binding-malformed';
    return policyRefusal(reason, configured.detail);
  }

  const snapshot = objectRecord(policySnapshot);
  if (!snapshot || snapshot['schemaVersion'] !== 2 ||
      !hasExactKeys(snapshot, ['schemaVersion', 'classic', 'rulesets']) ||
      !Array.isArray(snapshot['rulesets'])) {
    return policyRefusal(
      'snapshot-schema-unsupported',
      'safe-minimum V1 requires a complete schema-v2 policy snapshot',
    );
  }
  if (!consumePolicySnapshotShape(policySnapshot, { nodes: 0, bytes: 0 }) ||
      !policySnapshotAggregatesWithinBudget(snapshot)) {
    return policyRefusal(
      'snapshot-schema-unsupported',
      'schema-v2 policy snapshot exceeds the cumulative validation budget',
    );
  }
  const classicValue = snapshot['classic'];
  const rulesets = snapshot['rulesets'];
  if (classicValue !== null && !objectRecord(classicValue)) {
    return policyRefusal('classic-source-incomplete', 'classic source is neither canonical policy nor null');
  }
  if (classicValue === null && rulesets.length === 0) {
    return policyRefusal('snapshot-source-missing', 'policy snapshot has no effective protection source');
  }
  const classicSchemaRefusal = validateCanonicalClassicSource(classicValue);
  if (classicSchemaRefusal) return classicSchemaRefusal;
  for (const ruleset of rulesets) {
    const rulesetSchemaRefusal = validateCanonicalRulesetSource(ruleset);
    if (rulesetSchemaRefusal) return rulesetSchemaRefusal;
  }

  const effectiveBindings = new Map<string, string>();
  let hasStrictStatusChecks = false;
  let forcePushProhibited = false;
  let deletionProhibited = false;
  let signaturesRequired = false;
  let sourceCount = 0;
  const addEffectiveBindings = (
    bindings: ExactBindingValidation,
    source: string,
  ): SafeMinimumProtectedRemotePolicyV1Verdict | null => {
    if (!bindings.ok) {
      return policyRefusal(
        'effective-status-check-bindings-unsafe',
        `${source} status-check bindings are unsafe: ${bindings.detail}`,
      );
    }
    for (const key of bindings.keys) {
      const separator = key.indexOf('\0');
      const context = key.slice(0, separator);
      const appId = key.slice(separator + 1);
      const prior = effectiveBindings.get(context);
      if (prior !== undefined && prior !== appId) {
        return policyRefusal(
          'effective-status-check-bindings-unsafe',
          `effective check '${context}' conflicts between App ${prior} and App ${appId}`,
        );
      }
      effectiveBindings.set(context, appId);
    }
    hasStrictStatusChecks = true;
    return null;
  };

  const classic = objectRecord(classicValue);
  if (classic) {
    sourceCount++;
    if (!boundedNonEmptyString(classic['ruleId'], 256) ||
        !boundedNonEmptyString(classic['pattern'], 1_024) ||
        !hasOwn(classic, 'bypassForcePushAllowanceCount') ||
        !hasOwn(classic, 'bypassForcePushAllowances') ||
        !hasOwn(classic, 'requiredStatusChecks') ||
        !hasOwn(classic, 'enforceAdmins') ||
        !hasOwn(classic, 'requiredPullRequestReviews') ||
        !hasOwn(classic, 'allowForcePushes') ||
        !hasOwn(classic, 'allowDeletions') ||
        !hasOwn(classic, 'requiredSignatures')) {
      return policyRefusal('classic-source-incomplete', 'classic safety semantics are incomplete');
    }
    const statusValue = classic['requiredStatusChecks'];
    if (statusValue !== null) {
      const status = objectRecord(statusValue);
      const enforcementLevel = status?.['enforcementLevel'];
      if (!status || !hasOwn(status, 'strict') || !hasOwn(status, 'checks') ||
          !hasOwn(status, 'enforcementLevel') ||
          (enforcementLevel !== null && !boundedNonEmptyString(enforcementLevel, 100))) {
        return policyRefusal('classic-status-checks-missing', 'classic status-check semantics are incomplete');
      }
      if (status['strict'] !== true) {
        return policyRefusal('classic-status-checks-not-strict', 'classic status checks are not strict');
      }
      const classicBindings = validateExactAppBindings(status['checks']);
      if (!classicBindings.ok) {
        return policyRefusal(
          'classic-status-check-bindings-unsafe',
          `classic status-check bindings are unsafe: ${classicBindings.detail}`,
        );
      }
      const bindingRefusal = addEffectiveBindings(classicBindings, 'classic');
      if (bindingRefusal) return bindingRefusal;
    }
    if (classic['enforceAdmins'] !== true) {
      return policyRefusal('classic-admin-enforcement-missing', 'classic protection does not enforce administrators');
    }
    const bypassCount = classic['bypassForcePushAllowanceCount'];
    const reviews = classic['requiredPullRequestReviews'];
    const reviewPolicy = objectRecord(reviews);
    const reviewBypassEmpty = reviews === null || (reviewPolicy !== null &&
      hasOwn(reviewPolicy, 'bypassPullRequestAllowances') &&
      emptyClassicActorSet(reviewPolicy?.['bypassPullRequestAllowances']));
    if (typeof bypassCount !== 'number' || !Number.isSafeInteger(bypassCount) || bypassCount !== 0 ||
        !emptyClassicActorSet(classic['bypassForcePushAllowances']) ||
        !reviewBypassEmpty) {
      return policyRefusal('classic-bypass-actors-present', 'classic protection contains bypass authority');
    }
    if (typeof classic['allowForcePushes'] !== 'boolean' || typeof classic['allowDeletions'] !== 'boolean') {
      return policyRefusal('classic-source-incomplete', 'classic force-push/deletion semantics are incomplete');
    }
    forcePushProhibited ||= classic['allowForcePushes'] === false;
    deletionProhibited ||= classic['allowDeletions'] === false;
    if (typeof classic['requiredSignatures'] !== 'boolean') {
      return policyRefusal(
        'classic-signature-policy-unknown',
        'classic source has no explicit canonical signature policy',
      );
    }
    signaturesRequired ||= classic['requiredSignatures'];
  }

  const rulesetIds = new Set<string>();
  for (const rulesetValue of rulesets) {
    const ruleset = objectRecord(rulesetValue);
    const id = boundedNonEmptyString(ruleset?.['id'], 256);
    const source = boundedNonEmptyString(ruleset?.['source'], 512);
    const sourceType = ruleset?.['sourceType'];
    if (!ruleset || !id || !source ||
        (sourceType !== 'Repository' && sourceType !== 'Organization' && sourceType !== 'Enterprise') ||
        ruleset['target'] !== 'branch' || ruleset['enforcement'] !== 'active' ||
        !Array.isArray(ruleset['bypassActors']) || !objectRecord(ruleset['conditions']) ||
        !Array.isArray(ruleset['rules']) || !Array.isArray(ruleset['requiredCheckBindings'])) {
      return policyRefusal('ruleset-source-incomplete', 'ruleset source identity or safety semantics are incomplete');
    }
    if (rulesetIds.has(id)) {
      return policyRefusal('ruleset-source-duplicate', `ruleset '${id}' is duplicated`);
    }
    rulesetIds.add(id);
    sourceCount++;
    if (ruleset['bypassActors'].length > 0) {
      return policyRefusal('ruleset-bypass-actors-present', `ruleset '${id}' contains bypass authority`);
    }

    const rulesByType = new Map<string, Record<string, unknown>>();
    for (const ruleValue of ruleset['rules']) {
      const rule = objectRecord(ruleValue);
      const type = boundedNonEmptyString(rule?.['type'], 100);
      if (!rule || !type || !SUPPORTED_RULE_TYPES.has(type) || !hasOwn(rule, 'parameters')) {
        return policyRefusal('ruleset-rule-unknown', `ruleset '${id}' contains an unknown or incomplete rule`);
      }
      const parameters = rule['parameters'];
      const parameterRecord = objectRecord(parameters);
      if (PARAMETERLESS_RULE_TYPES.has(type)
        ? parameters !== null
        : !parameterRecord || !validateRuleParameters(type, parameterRecord)) {
        return policyRefusal(
          type === 'required_signatures' ? 'ruleset-signature-policy-unknown' : 'ruleset-rule-unknown',
          `ruleset '${id}' contains malformed rule '${type}'`,
        );
      }
      if (rulesByType.has(type)) {
        return policyRefusal('ruleset-rule-duplicate', `ruleset '${id}' duplicates rule '${type}'`);
      }
      rulesByType.set(type, rule);
    }

    const statusRule = rulesByType.get('required_status_checks');
    const statusParameters = objectRecord(statusRule?.['parameters']);
    if (statusRule) {
      if (!statusParameters ||
          !hasOwn(statusParameters, 'strict_required_status_checks_policy') ||
          !hasOwn(statusParameters, 'required_status_checks')) {
        return policyRefusal(
          'ruleset-status-checks-missing',
          `ruleset '${id}' has incomplete status-check semantics`,
        );
      }
      if (statusParameters['strict_required_status_checks_policy'] !== true) {
        return policyRefusal('ruleset-status-checks-not-strict', `ruleset '${id}' status checks are not strict`);
      }
      const parameterBindings = validateExactAppBindings(
        Array.isArray(statusParameters['required_status_checks'])
          ? statusParameters['required_status_checks'].map((binding) => {
              const record = objectRecord(binding);
              return { context: record?.['context'], appId: parseAppId(record?.['integration_id']) };
            })
          : statusParameters['required_status_checks'],
      );
      const canonicalBindings = validateExactAppBindings(ruleset['requiredCheckBindings']);
      if (!parameterBindings.ok || !canonicalBindings.ok ||
          JSON.stringify(parameterBindings.keys) !== JSON.stringify(canonicalBindings.keys)) {
        const issue = !parameterBindings.ok
          ? parameterBindings.detail
          : !canonicalBindings.ok
            ? canonicalBindings.detail
            : 'canonical bindings disagree with rule parameters';
        return policyRefusal(
          'ruleset-status-check-bindings-unsafe',
          `ruleset '${id}' status-check bindings are unsafe: ${issue}`,
        );
      }
      const bindingRefusal = addEffectiveBindings(parameterBindings, `ruleset '${id}'`);
      if (bindingRefusal) return bindingRefusal;
    } else if (ruleset['requiredCheckBindings'].length > 0) {
      return policyRefusal(
        'ruleset-status-check-bindings-unsafe',
        `ruleset '${id}' exposes check bindings without a status-check rule`,
      );
    }

    forcePushProhibited ||= rulesByType.has('non_fast_forward');
    deletionProhibited ||= rulesByType.has('deletion');
    const signatureRule = rulesByType.get('required_signatures');
    if (signatureRule && signatureRule['parameters'] !== null) {
      return policyRefusal(
        'ruleset-signature-policy-unknown',
        `ruleset '${id}' signature policy is not canonical`,
      );
    }
    signaturesRequired ||= Boolean(signatureRule);
  }

  if (!hasStrictStatusChecks) {
    return policyRefusal(
      'effective-status-checks-missing',
      'effective policy has no strict status-check rule',
    );
  }
  const effectiveKeys = [...effectiveBindings.entries()]
    .map(([context, appId]) => `${context}\0${appId}`)
    .sort();
  if (JSON.stringify(effectiveKeys) !== JSON.stringify(configured.keys)) {
    return policyRefusal(
      'effective-status-check-bindings-unsafe',
      'effective context/App binding union does not exactly match configured bindings',
    );
  }
  if (!forcePushProhibited) {
    return policyRefusal(
      'effective-force-push-prohibition-missing',
      'effective policy does not prove force-push prohibition',
    );
  }
  if (!deletionProhibited) {
    return policyRefusal(
      'effective-deletion-prohibition-missing',
      'effective policy does not prove branch-deletion prohibition',
    );
  }
  if (canonicalProtectedRemotePolicySnapshot(policySnapshot) === null) {
    return policyRefusal(
      'snapshot-schema-unsupported',
      'schema-v2 policy snapshot contains a duplicate policy collection member',
    );
  }
  const signaturePolicy = signaturesRequired ? 'required' : 'not-required';
  return {
    ok: true,
    policyVersion: SAFE_MINIMUM_PROTECTED_REMOTE_POLICY_VERSION,
    snapshotSchemaVersion: 2,
    signaturePolicy,
    sourceCount,
    detail: `safe-minimum protected-remote policy V1 satisfied by ${sourceCount} source(s); signatures ${signaturePolicy}`,
  };
}

function isBooleanField(record: Record<string, unknown>, field: string): boolean {
  return typeof record[field] === 'boolean';
}

function isSafeIntegerBetween(
  record: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): boolean {
  const value = record[field];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function isOptionalBooleanField(record: Record<string, unknown>, field: string): boolean {
  return !hasOwn(record, field) || isBooleanField(record, field);
}

function isOptionalBoundedStringField(
  record: Record<string, unknown>,
  field: string,
  maxLength: number,
): boolean {
  return !hasOwn(record, field) || boundedNonEmptyString(record[field], maxLength) !== null;
}

function isCanonicalStatusCheckParameter(value: unknown): boolean {
  const check = objectRecord(value);
  return Boolean(check && hasExactKeys(check, ['context', 'integration_id'], ['context']) &&
    boundedNonEmptyString(check['context'], 256) &&
    (!hasOwn(check, 'integration_id') || parseAppId(check['integration_id']) !== undefined));
}

function isCanonicalDismissalRestriction(value: unknown): boolean {
  const restriction = objectRecord(value);
  if (!restriction || !hasExactKeys(restriction, ['allowed_actors', 'enabled'], ['enabled']) ||
      typeof restriction['enabled'] !== 'boolean') return false;
  if (!hasOwn(restriction, 'allowed_actors')) return true;
  const actors = restriction['allowed_actors'];
  return Array.isArray(actors) && actors.length <= MAX_POLICY_ACTORS && actors.every((value) => {
    const actor = objectRecord(value);
    return Boolean(actor && hasExactKeys(actor, ['id', 'type']) &&
      typeof actor['id'] === 'number' && Number.isSafeInteger(actor['id']) && actor['id'] > 0 &&
      (actor['type'] === 'User' || actor['type'] === 'Team' ||
        actor['type'] === 'IntegrationInstallation' || actor['type'] === 'RepositoryRole'));
  });
}

function isCanonicalRequiredReviewer(value: unknown): boolean {
  const configuration = objectRecord(value);
  const reviewer = objectRecord(configuration?.['reviewer']);
  return Boolean(configuration && hasExactKeys(configuration, [
    'file_patterns',
    'minimum_approvals',
    'reviewer',
  ]) && isBoundedStringArray(configuration['file_patterns']) &&
    typeof configuration['minimum_approvals'] === 'number' &&
    Number.isSafeInteger(configuration['minimum_approvals']) &&
    configuration['minimum_approvals'] >= 0 &&
    reviewer && hasExactKeys(reviewer, ['id', 'type']) && reviewer['type'] === 'Team' &&
    typeof reviewer['id'] === 'number' && Number.isSafeInteger(reviewer['id']) && reviewer['id'] > 0);
}

function isCanonicalWorkflowReference(value: unknown): boolean {
  const workflow = objectRecord(value);
  return Boolean(workflow && hasExactKeys(
    workflow,
    ['path', 'ref', 'repository_id', 'sha'],
    ['path', 'repository_id'],
  ) && boundedNonEmptyString(workflow['path'], 1_024) &&
    typeof workflow['repository_id'] === 'number' && Number.isSafeInteger(workflow['repository_id']) &&
    workflow['repository_id'] > 0 && isOptionalBoundedStringField(workflow, 'ref', 1_024) &&
    isOptionalBoundedStringField(workflow, 'sha', 64));
}

function isCanonicalCodeScanningTool(value: unknown): boolean {
  const tool = objectRecord(value);
  return Boolean(tool && hasExactKeys(tool, ['alerts_threshold', 'security_alerts_threshold', 'tool']) &&
    (tool['alerts_threshold'] === 'none' || tool['alerts_threshold'] === 'errors' ||
      tool['alerts_threshold'] === 'errors_and_warnings' || tool['alerts_threshold'] === 'all') &&
    (tool['security_alerts_threshold'] === 'none' || tool['security_alerts_threshold'] === 'critical' ||
      tool['security_alerts_threshold'] === 'high_or_higher' ||
      tool['security_alerts_threshold'] === 'medium_or_higher' ||
      tool['security_alerts_threshold'] === 'all') &&
    boundedNonEmptyString(tool['tool'], 256));
}

function validateRuleParameters(type: string, parameters: Record<string, unknown>): boolean {
  if (type === 'required_status_checks') {
    const checks = parameters['required_status_checks'];
    return hasExactKeys(
      parameters,
      ['do_not_enforce_on_create', 'required_status_checks', 'strict_required_status_checks_policy'],
      ['required_status_checks', 'strict_required_status_checks_policy'],
    ) && isBooleanField(parameters, 'strict_required_status_checks_policy') &&
      Array.isArray(checks) && checks.length <= MAX_REQUIRED_CHECKS &&
      checks.every(isCanonicalStatusCheckParameter) &&
      parseRequiredChecks(parameters['required_status_checks'], 'integration_id') !== null &&
      isOptionalBooleanField(parameters, 'do_not_enforce_on_create');
  }
  if (type === 'pull_request') {
    const count = parameters['required_approving_review_count'];
    const allowed = parameters['allowed_merge_methods'];
    const reviewers = parameters['required_reviewers'];
    return hasExactKeys(
      parameters,
      [
        'allowed_merge_methods',
        'dismiss_stale_reviews_on_push',
        'dismissal_restriction',
        'require_code_owner_review',
        'require_last_push_approval',
        'required_approving_review_count',
        'required_review_thread_resolution',
        'required_reviewers',
      ],
      [
        'dismiss_stale_reviews_on_push',
        'require_code_owner_review',
        'require_last_push_approval',
        'required_approving_review_count',
        'required_review_thread_resolution',
      ],
    ) && isBooleanField(parameters, 'dismiss_stale_reviews_on_push') &&
      isBooleanField(parameters, 'require_code_owner_review') &&
      isBooleanField(parameters, 'require_last_push_approval') &&
      isBooleanField(parameters, 'required_review_thread_resolution') &&
      typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && count <= 10 &&
      (!hasOwn(parameters, 'allowed_merge_methods') ||
        (Array.isArray(allowed) && allowed.length > 0 && allowed.length <= 3 &&
          allowed.every((method) => method === 'merge' || method === 'squash' || method === 'rebase'))) &&
      (!hasOwn(parameters, 'dismissal_restriction') ||
        isCanonicalDismissalRestriction(parameters['dismissal_restriction'])) &&
      (!hasOwn(parameters, 'required_reviewers') ||
        (Array.isArray(reviewers) && reviewers.length <= MAX_POLICY_ARRAY_ITEMS &&
          reviewers.every(isCanonicalRequiredReviewer)));
  }
  if (type === 'update') {
    return hasExactKeys(parameters, ['update_allows_fetch_and_merge']) &&
      isBooleanField(parameters, 'update_allows_fetch_and_merge');
  }
  if (type === 'merge_queue') {
    const integerFields = [
      'check_response_timeout_minutes',
      'max_entries_to_build',
      'max_entries_to_merge',
      'min_entries_to_merge',
      'min_entries_to_merge_wait_minutes',
    ];
    return hasExactKeys(parameters, [...integerFields, 'grouping_strategy', 'merge_method']) &&
      isSafeIntegerBetween(parameters, 'check_response_timeout_minutes', 1, 360) &&
      isSafeIntegerBetween(parameters, 'max_entries_to_build', 0, 100) &&
      isSafeIntegerBetween(parameters, 'max_entries_to_merge', 0, 100) &&
      isSafeIntegerBetween(parameters, 'min_entries_to_merge', 0, 100) &&
      isSafeIntegerBetween(parameters, 'min_entries_to_merge_wait_minutes', 0, 360) &&
      (parameters['grouping_strategy'] === 'ALLGREEN' || parameters['grouping_strategy'] === 'HEADGREEN') &&
      (parameters['merge_method'] === 'MERGE' || parameters['merge_method'] === 'SQUASH' ||
        parameters['merge_method'] === 'REBASE');
  }
  if (type === 'required_deployments') {
    const environments = parameters['required_deployment_environments'];
    return hasExactKeys(parameters, ['required_deployment_environments']) &&
      Array.isArray(environments) && environments.length <= MAX_POLICY_ARRAY_ITEMS &&
      environments.every((environment) => boundedNonEmptyString(environment, 256) !== null);
  }
  if (type === 'workflows') {
    return hasExactKeys(parameters, ['do_not_enforce_on_create', 'workflows'], ['workflows']) &&
      isOptionalBooleanField(parameters, 'do_not_enforce_on_create') &&
      Array.isArray(parameters['workflows']) &&
      parameters['workflows'].length <= MAX_POLICY_ARRAY_ITEMS &&
      parameters['workflows'].every(isCanonicalWorkflowReference);
  }
  if (type === 'code_scanning') {
    const tools = parameters['code_scanning_tools'];
    if (!hasExactKeys(parameters, ['code_scanning_tools']) || !Array.isArray(tools) ||
        tools.length > MAX_POLICY_ARRAY_ITEMS || !tools.every(isCanonicalCodeScanningTool)) return false;
    const toolNames = tools.map((tool) => objectRecord(tool)!['tool'] as string);
    return new Set(toolNames).size === toolNames.length;
  }
  if (type === 'copilot_code_review') {
    return hasExactKeys(parameters, ['review_draft_pull_requests', 'review_on_push'], []) &&
      isOptionalBooleanField(parameters, 'review_draft_pull_requests') &&
      isOptionalBooleanField(parameters, 'review_on_push');
  }
  if (type.endsWith('_pattern')) {
    return hasExactKeys(parameters, ['name', 'negate', 'operator', 'pattern'], ['operator', 'pattern']) &&
      (parameters['operator'] === 'starts_with' || parameters['operator'] === 'ends_with' ||
        parameters['operator'] === 'contains' || parameters['operator'] === 'regex') &&
      typeof parameters['pattern'] === 'string' &&
      parameters['pattern'].length <= MAX_POLICY_STRING_LENGTH &&
      isOptionalBoundedStringField(parameters, 'name', 256) && isOptionalBooleanField(parameters, 'negate');
  }
  if (type === 'file_path_restriction' || type === 'file_extension_restriction') {
    const field = type === 'file_path_restriction' ? 'restricted_file_paths' : 'restricted_file_extensions';
    return hasExactKeys(parameters, [field]) && isBoundedStringArray(parameters[field], 1_024);
  }
  if (type === 'max_file_path_length' || type === 'max_file_size') {
    const field = type;
    const max = type === 'max_file_path_length' ? 32_767 : 100;
    return hasExactKeys(parameters, [field]) && isSafeIntegerBetween(parameters, field, 1, max);
  }
  return false;
}

type RuleTransport = 'effective' | 'detail';

const EFFECTIVE_RULE_FIELDS = [
  'parameters',
  'ruleset_id',
  'ruleset_source',
  'ruleset_source_type',
  'type',
] as const;
const DETAIL_RULE_FIELDS = ['parameters', 'type'] as const;

function hasExactRuleTransportEnvelope(
  rule: Record<string, unknown>,
  transport: RuleTransport,
): boolean {
  return transport === 'effective'
    ? hasExactKeys(
        rule,
        EFFECTIVE_RULE_FIELDS,
        ['ruleset_id', 'ruleset_source', 'ruleset_source_type', 'type'],
      )
    : hasExactKeys(rule, DETAIL_RULE_FIELDS, ['type']);
}

function parseCanonicalRule(
  value: unknown,
  transport: RuleTransport,
  checks?: Set<string>,
  bindings?: Map<string, RequiredCheckBinding>,
): CanonicalRulesetRule | null {
  const rule = objectRecord(value);
  const type = boundedNonEmptyString(rule?.['type'], 100);
  if (!rule || !hasExactRuleTransportEnvelope(rule, transport) ||
      !type || !SUPPORTED_RULE_TYPES.has(type)) return null;
  const rawParameters = rule['parameters'];
  if (PARAMETERLESS_RULE_TYPES.has(type)) {
    if (rawParameters !== null && rawParameters !== undefined) return null;
    return { type, parameters: null };
  }
  const parameters = objectRecord(rawParameters);
  const canonical = canonicalPolicyObject(parameters);
  if (!parameters || !canonical || !validateRuleParameters(type, parameters)) return null;
  if (type === 'required_status_checks' && checks && bindings) {
    const parsed = parseRequiredChecks(parameters['required_status_checks'], 'integration_id');
    if (!parsed) return null;
    recordBindings(parsed, checks, bindings);
  }
  return { type, parameters: canonical };
}

function sortRules(rules: CanonicalRulesetRule[]): CanonicalRulesetRule[] {
  return rules.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

interface ParsedEffectiveRule {
  rulesetId: string;
  sourceType: CanonicalRulesetProtection['sourceType'];
  source: string;
  rule: CanonicalRulesetRule;
}

function parseEffectiveRules(
  value: unknown,
  requirements: Set<string>,
  checks: Set<string>,
  bindings: Map<string, RequiredCheckBinding>,
): ParsedEffectiveRule[] | null {
  if (!Array.isArray(value) || value.length > MAX_EFFECTIVE_RULES) return null;
  const parsed: ParsedEffectiveRule[] = [];
  for (const item of value) {
    const effective = objectRecord(item);
    const rulesetId = policyId(effective?.['ruleset_id']);
    const sourceType = effective?.['ruleset_source_type'];
    const source = boundedNonEmptyString(effective?.['ruleset_source'], 512);
    const rule = parseCanonicalRule(effective, 'effective', checks, bindings);
    if (!effective || !rulesetId ||
        (sourceType !== 'Repository' && sourceType !== 'Organization' && sourceType !== 'Enterprise') ||
        !source || !rule) return null;
    requirements.add(rule.type);
    parsed.push({
      rulesetId,
      sourceType,
      source: source.toLowerCase(),
      rule,
    });
  }
  return parsed;
}

function effectiveRulesFingerprint(value: ParsedEffectiveRule[]): string {
  return JSON.stringify(value.map((item) => ({
    rulesetId: item.rulesetId,
    sourceType: item.sourceType,
    source: item.source,
    rule: item.rule,
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

function readEffectiveRules(
  cwd: string,
  nameWithOwner: string,
  branch: string,
): unknown[] | null {
  const encodedBranch = branch.split('/').map(encodeURIComponent).join('/');
  const maxPages = Math.floor(MAX_EFFECTIVE_RULES / EFFECTIVE_RULES_PER_PAGE) + 1;
  const collected: unknown[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const result = runAttestationGh(cwd, [
      'api',
      `repos/${nameWithOwner}/rules/branches/${encodedBranch}` +
        `?per_page=${EFFECTIVE_RULES_PER_PAGE}&page=${page}`,
    ]);
    if (result.kind !== 'ok') return null;
    const parsed = safeJson(result.stdout);
    if (!Array.isArray(parsed) || parsed.length > EFFECTIVE_RULES_PER_PAGE ||
        collected.length + parsed.length > MAX_EFFECTIVE_RULES) return null;
    collected.push(...parsed);
    if (parsed.length < EFFECTIVE_RULES_PER_PAGE) return collected;
  }
  return null;
}

function parseRulesetBypassActors(
  value: unknown,
  sourceType: CanonicalRulesetProtection['sourceType'],
): CanonicalRulesetBypassActor[] | null {
  if (!Array.isArray(value) || value.length > MAX_POLICY_ACTORS) return null;
  const actors: CanonicalRulesetBypassActor[] = [];
  for (const item of value) {
    const actor = objectRecord(item);
    const actorType = actor?.['actor_type'];
    const bypassMode = actor?.['bypass_mode'];
    const nullableId = actor?.['actor_id'];
    const actorId = nullableId === null ? null : policyId(nullableId);
    const enterpriseActor = actorType === 'EnterpriseOwner' || actorType === 'EnterpriseRole';
    const idlessActor = actorType === 'OrganizationAdmin' || actorType === 'DeployKey' ||
      enterpriseActor;
    if (!actor || !hasExactKeys(actor, ['actor_id', 'actor_type', 'bypass_mode']) ||
        (actorType !== 'Integration' && actorType !== 'OrganizationAdmin' &&
          actorType !== 'RepositoryRole' && actorType !== 'Team' &&
          actorType !== 'DeployKey' && actorType !== 'User' &&
          !((sourceType === 'Enterprise' || sourceType === 'Organization') && enterpriseActor)) ||
        (bypassMode !== 'always' && bypassMode !== 'pull_request' && bypassMode !== 'exempt') ||
        (nullableId !== null && !actorId) ||
        (idlessActor && nullableId !== null) ||
        (!idlessActor && actorId === null)) {
      return null;
    }
    actors.push({ actorId, actorType, bypassMode });
  }
  return actors.sort((a, b) =>
    a.actorType.localeCompare(b.actorType) || (a.actorId ?? '').localeCompare(b.actorId ?? '') ||
      a.bypassMode.localeCompare(b.bypassMode));
}

function parseRulesetConditions(value: unknown): Record<string, CanonicalPolicyValue> | null {
  const conditions = objectRecord(value);
  const refName = objectRecord(conditions?.['ref_name']);
  const include = refName?.['include'];
  const exclude = refName?.['exclude'];
  if (!conditions || !refName || !Array.isArray(include) || !Array.isArray(exclude) ||
      include.length > MAX_POLICY_ARRAY_ITEMS || exclude.length > MAX_POLICY_ARRAY_ITEMS ||
      !include.every((ref) => boundedNonEmptyString(ref, 512) !== null) ||
      !exclude.every((ref) => boundedNonEmptyString(ref, 512) !== null)) return null;
  return canonicalPolicyObject(conditions);
}

function rulesetRequiredCheckBindings(
  rules: CanonicalRulesetRule[],
): RequiredCheckBinding[] | null {
  const bindings: RequiredCheckBinding[] = [];
  for (const rule of rules) {
    if (rule.type !== 'required_status_checks') continue;
    const parsed = parseRequiredChecks(
      rule.parameters?.['required_status_checks'],
      'integration_id',
    );
    if (!parsed) return null;
    bindings.push(...parsed);
  }
  return sortedBindings(bindings);
}

const RULESET_DETAIL_FIELDS = [
  '_links',
  'bypass_actors',
  'conditions',
  'created_at',
  'enforcement',
  'id',
  'name',
  'node_id',
  'rules',
  'source',
  'source_type',
  'target',
  'updated_at',
] as const;
const RULESET_DETAIL_AUTHORITY_FIELDS = [
  'bypass_actors',
  'conditions',
  'enforcement',
  'id',
  'rules',
  'source',
  'source_type',
  'target',
] as const;

function isOptionalRulesetDetailLink(value: unknown): boolean {
  const link = objectRecord(value);
  return Boolean(link && hasExactKeys(link, ['href']) && boundedNonEmptyString(link['href'], 2_048));
}

function hasExactRulesetDetailEnvelope(detail: Record<string, unknown>): boolean {
  if (!hasExactKeys(detail, RULESET_DETAIL_FIELDS, RULESET_DETAIL_AUTHORITY_FIELDS)) return false;
  for (const field of ['name', 'node_id', 'created_at', 'updated_at']) {
    if (hasOwn(detail, field) && !boundedNonEmptyString(detail[field], field === 'name' ? 256 : 100)) {
      return false;
    }
  }
  if (!hasOwn(detail, '_links')) return true;
  const links = objectRecord(detail['_links']);
  return Boolean(links && hasExactKeys(links, ['html', 'self']) &&
    isOptionalRulesetDetailLink(links['html']) && isOptionalRulesetDetailLink(links['self']));
}

function parseRulesetProtection(
  value: unknown,
  expected: ParsedEffectiveRule[],
): CanonicalRulesetProtection | null {
  if (expected.length === 0) return null;
  const detail = objectRecord(value);
  const first = expected[0];
  const id = policyId(detail?.['id']);
  const sourceType = detail?.['source_type'];
  const source = boundedNonEmptyString(detail?.['source'], 512);
  if (!detail || !hasExactRulesetDetailEnvelope(detail) || !first ||
      id !== first.rulesetId || sourceType !== first.sourceType ||
      !source || source.toLowerCase() !== first.source || detail['target'] !== 'branch' ||
      detail['enforcement'] !== 'active' ||
      !Object.prototype.hasOwnProperty.call(detail, 'bypass_actors')) return null;
  const bypassActors = parseRulesetBypassActors(detail['bypass_actors'], first.sourceType);
  const conditions = parseRulesetConditions(detail['conditions']);
  const rawRules = detail['rules'];
  if (!bypassActors || !conditions || !Array.isArray(rawRules) || rawRules.length > MAX_BRANCH_RULES) {
    return null;
  }
  const rules: CanonicalRulesetRule[] = [];
  for (const rawRule of rawRules) {
    const rule = parseCanonicalRule(rawRule, 'detail');
    if (!rule) return null;
    rules.push(rule);
  }
  const sortedRules = sortRules(rules);
  const effectiveRules = sortRules(expected.map((item) => item.rule));
  const requiredCheckBindings = rulesetRequiredCheckBindings(sortedRules);
  if (!requiredCheckBindings ||
      JSON.stringify(sortedRules) !== JSON.stringify(effectiveRules)) return null;
  return {
    id,
    sourceType: first.sourceType,
    source: first.source,
    target: 'branch',
    enforcement: 'active',
    bypassActors,
    conditions,
    rules: sortedRules,
    requiredCheckBindings,
  };
}

interface RulesetCollectionBudget extends PolicySnapshotShapeBudget {
  rulesets: number;
  rules: number;
  actors: number;
  checks: number;
  wireBytes: number;
}

function createRulesetCollectionBudget(
  classic: CanonicalClassicProtection | null,
): RulesetCollectionBudget | null {
  const baseSnapshot = { schemaVersion: 2, classic, rulesets: [] };
  const shape: PolicySnapshotShapeBudget = { nodes: 0, bytes: 0 };
  if (!consumePolicySnapshotShape(baseSnapshot, shape) ||
      !policySnapshotAggregatesWithinBudget(baseSnapshot)) return null;
  const classicActors = classic === null
    ? 0
    : canonicalActorSetSize(classic.bypassForcePushAllowances) +
      canonicalActorSetSize(classic.pushRestrictions) +
      canonicalActorSetSize(classic.requiredPullRequestReviews?.dismissalRestrictions) +
      canonicalActorSetSize(classic.requiredPullRequestReviews?.bypassPullRequestAllowances);
  const classicChecks = classic?.requiredStatusChecks?.checks.length ?? 0;
  return {
    ...shape,
    rulesets: 0,
    rules: 0,
    actors: classicActors,
    checks: classicChecks,
    wireBytes: shape.bytes,
  };
}

function effectiveRuleCollectionCounts(
  effectiveRules: ParsedEffectiveRule[],
): { rules: number; actors: number } {
  let actors = 0;
  for (const effective of effectiveRules) {
    actors += rulesetRuleActorCount(effective.rule);
  }
  return { rules: effectiveRules.length, actors };
}

function canonicalRulesetCollectionKey(
  ruleset: Pick<CanonicalRulesetProtection, 'id' | 'source' | 'sourceType'>,
): string {
  return `${ruleset.sourceType}\0${ruleset.source}\0${ruleset.id}`;
}

function minimumRulesetForGroup(group: ParsedEffectiveRule[]): CanonicalRulesetProtection | null {
  const first = group[0];
  if (!first) return null;
  const rules = sortRules(group.map((item) => item.rule));
  const requiredCheckBindings = rulesetRequiredCheckBindings(rules);
  if (!requiredCheckBindings) return null;
  return {
    id: first.rulesetId,
    sourceType: first.sourceType,
    source: first.source,
    target: 'branch',
    enforcement: 'active',
    bypassActors: [],
    conditions: { ref_name: { include: [], exclude: [] } },
    rules,
    requiredCheckBindings,
  };
}

function rulesetCollectionDelta(
  ruleset: CanonicalRulesetProtection,
): (PolicySnapshotShapeBudget & { rules: number; actors: number; checks: number }) | null {
  const shape: PolicySnapshotShapeBudget = { nodes: 0, bytes: 0 };
  if (!consumePolicySnapshotShape(ruleset, shape)) return null;
  let actors = ruleset.bypassActors.length;
  for (const rule of ruleset.rules) {
    actors += rulesetRuleActorCount(rule);
    if (actors > MAX_POLICY_ACTORS) return null;
  }
  return {
    ...shape,
    rules: ruleset.rules.length,
    actors,
    checks: ruleset.requiredCheckBindings.length,
  };
}

function rulesetFitsCollectionBudget(
  budget: RulesetCollectionBudget,
  ruleset: CanonicalRulesetProtection,
  wireBytes = 0,
): ReturnType<typeof rulesetCollectionDelta> {
  const delta = rulesetCollectionDelta(ruleset);
  if (!delta) return null;
  const separatorBytes = budget.rulesets === 0 ? 0 : 1;
  return budget.rulesets + 1 <= MAX_POLICY_RULESETS &&
    budget.nodes + delta.nodes <= MAX_POLICY_SNAPSHOT_NODES &&
    budget.bytes + separatorBytes + delta.bytes <= MAX_POLICY_SNAPSHOT_BYTES &&
    budget.wireBytes + wireBytes <= MAX_POLICY_SNAPSHOT_BYTES &&
    budget.rules + delta.rules <= MAX_BRANCH_RULES &&
    budget.actors + delta.actors <= MAX_POLICY_ACTORS &&
    budget.checks + delta.checks <= MAX_REQUIRED_CHECKS
    ? delta
    : null;
}

function reserveRulesetCollectionBudget(
  budget: RulesetCollectionBudget,
  ruleset: CanonicalRulesetProtection,
  wireBytes: number,
): boolean {
  const delta = rulesetFitsCollectionBudget(budget, ruleset, wireBytes);
  if (!delta) return false;
  budget.nodes += delta.nodes;
  budget.bytes += (budget.rulesets === 0 ? 0 : 1) + delta.bytes;
  budget.rulesets++;
  budget.rules += delta.rules;
  budget.actors += delta.actors;
  budget.checks += delta.checks;
  budget.wireBytes += wireBytes;
  return true;
}

function readRulesetProtections(
  cwd: string,
  nameWithOwner: string,
  effectiveRules: ParsedEffectiveRule[],
  classic: CanonicalClassicProtection | null,
  expectedSnapshot?: CanonicalRulesetProtection[],
): CanonicalRulesetProtection[] | null {
  const grouped = new Map<string, ParsedEffectiveRule[]>();
  for (const effectiveRule of effectiveRules) {
    const key = `${effectiveRule.sourceType}\0${effectiveRule.source}\0${effectiveRule.rulesetId}`;
    const group = grouped.get(key) ?? [];
    group.push(effectiveRule);
    grouped.set(key, group);
  }
  if (grouped.size > MAX_POLICY_RULESETS) return null;
  const budget = createRulesetCollectionBudget(classic);
  if (!budget) return null;
  const effectiveCounts = effectiveRuleCollectionCounts(effectiveRules);
  if (budget.rules + effectiveCounts.rules > MAX_BRANCH_RULES ||
      budget.actors + effectiveCounts.actors > MAX_POLICY_ACTORS) return null;

  const groups = [...grouped.entries()];
  const expectedByKey = expectedSnapshot === undefined
    ? null
    : new Map(expectedSnapshot.map((ruleset) => [canonicalRulesetCollectionKey(ruleset), ruleset]));
  if (expectedByKey && expectedByKey.size !== groups.length) return null;
  const rulesets: CanonicalRulesetProtection[] = [];
  for (const [key, group] of groups) {
    const first = group[0];
    if (!first) return null;
    const minimum = minimumRulesetForGroup(group);
    const minimumWireBytes = minimum === null
      ? 0
      : Buffer.byteLength(JSON.stringify(minimum), 'utf8');
    if (!minimum || !rulesetFitsCollectionBudget(budget, minimum, minimumWireBytes)) return null;
    const remainingWireBytes = MAX_POLICY_SNAPSHOT_BYTES - budget.wireBytes;
    if (remainingWireBytes <= 0) return null;
    const detailResult = runAttestationGh(cwd, [
      'api',
      `repos/${nameWithOwner}/rulesets/${first.rulesetId}?includes_parents=true`,
    ], remainingWireBytes);
    if (detailResult.kind !== 'ok') return null;
    if (detailResult.stdoutBytes > remainingWireBytes) return null;
    const ruleset = parseRulesetProtection(safeJson(detailResult.stdout), group);
    if (!ruleset || canonicalRulesetCollectionKey(ruleset) !== key ||
        !reserveRulesetCollectionBudget(budget, ruleset, detailResult.stdoutBytes)) return null;
    if (expectedByKey) {
      const expected = expectedByKey.get(key);
      if (!expected || JSON.stringify(ruleset) !== JSON.stringify(expected)) return null;
      expectedByKey.delete(key);
    } else {
      rulesets.push(ruleset);
    }
  }
  if (expectedByKey && expectedByKey.size > 0) return null;
  if (expectedSnapshot) return expectedSnapshot;
  return rulesets.sort((a, b) =>
    a.sourceType.localeCompare(b.sourceType) || a.source.localeCompare(b.source) ||
      a.id.localeCompare(b.id));
}

function apiPath(nameWithOwner: string, branch: string, suffix = ''): string {
  const encodedBranch = branch.split('/').map(encodeURIComponent).join('/');
  return `repos/${nameWithOwner}/branches/${encodedBranch}${suffix}`;
}

function readBranchProtectionUncached(
  repo: string,
  requestedBranch?: string,
  expectedNameWithOwner?: string,
): BranchProtectionAttestation {
  const repoResult = runAttestationGh(repo, [
    'repo',
    'view',
    ...(expectedNameWithOwner ? [expectedNameWithOwner] : []),
    '--json',
    'id,nameWithOwner,defaultBranchRef',
  ]);
  if (repoResult.kind !== 'ok') {
    return unavailableAttestation('GitHub repository identity is unavailable', requestedBranch ?? null);
  }
  const repoObject = objectRecord(safeJson(repoResult.stdout));
  const defaultBranchRef = objectRecord(repoObject?.['defaultBranchRef']);
  const nameWithOwner = boundedNonEmptyString(repoObject?.['nameWithOwner'], 512);
  const repositoryId = boundedNonEmptyString(repoObject?.['id'], 256);
  const defaultBranch = boundedNonEmptyString(defaultBranchRef?.['name'], 256);
  if (!repoObject || !nameWithOwner || !repositoryId || !defaultBranch ||
      !/^[^/\s]+\/[^/\s]+$/.test(nameWithOwner) || defaultBranch.trim() !== defaultBranch) {
    return unavailableAttestation('GitHub repository identity was malformed', requestedBranch ?? null);
  }
  if (expectedNameWithOwner && nameWithOwner.toLowerCase() !== expectedNameWithOwner.toLowerCase()) {
    return unavailableAttestation('GitHub repository identity does not match origin', requestedBranch ?? null);
  }
  const branch = requestedBranch === undefined
    ? defaultBranch
    : boundedNonEmptyString(requestedBranch, 256);
  const identity = { nameWithOwner, repositoryId, defaultBranch };
  if (!branch) return unavailableAttestation('GitHub branch name was invalid', null, identity);

  const initialAuthority = readExactBranchAuthority(repo, nameWithOwner, branch);
  if (!initialAuthority) {
    return unavailableAttestation('Exact GitHub branch authority is unavailable', branch, identity);
  }
  if (initialAuthority.nameWithOwner.toLowerCase() !== nameWithOwner.toLowerCase() ||
      initialAuthority.repositoryId !== repositoryId ||
      initialAuthority.defaultBranch !== defaultBranch) {
    return unavailableAttestation('REST and GraphQL repository identity disagree', branch, identity);
  }

  const branchResult = runAttestationGh(repo, ['api', apiPath(nameWithOwner, branch)]);
  if (branchResult.kind !== 'ok') {
    return unavailableAttestation('GitHub branch head is unavailable', branch, identity);
  }
  const branchObject = objectRecord(safeJson(branchResult.stdout));
  const commit = objectRecord(branchObject?.['commit']);
  const returnedBranch = boundedNonEmptyString(branchObject?.['name'], 256);
  const baseHead = boundedNonEmptyString(commit?.['sha'], 64);
  if (!branchObject || returnedBranch !== branch || !baseHead || !/^[0-9a-f]{40}$/i.test(baseHead)) {
    return unavailableAttestation('GitHub branch head was malformed', branch, identity);
  }
  if (baseHead.toLowerCase() !== initialAuthority.headOid.toLowerCase()) {
    return unavailableAttestation('REST and GraphQL branch heads disagree', branch, identity);
  }
  const boundIdentity = { ...identity, baseHead };

  const requirements = new Set<string>();
  const checks = new Set<string>();
  const bindings = new Map<string, RequiredCheckBinding>();
  const sources: Array<'classic' | 'ruleset'> = [];
  let classicProtection: CanonicalClassicProtection | null = null;
  const classic = runAttestationGh(repo, [
    'api',
    apiPath(nameWithOwner, branch, '/protection'),
  ]);
  if (classic.kind === 'unavailable') {
    return unavailableAttestation('Classic branch protection is unavailable', branch, boundIdentity);
  }
  if (classic.kind === 'ok') {
    if (!initialAuthority.classic) {
      return unavailableAttestation('REST and GraphQL classic protection disagree', branch, boundIdentity);
    }
    classicProtection = parseClassicProtection(
      safeJson(classic.stdout),
      initialAuthority.classic,
      requirements,
      checks,
      bindings,
    );
    if (!classicProtection) {
      return unavailableAttestation('Classic branch protection was malformed', branch, boundIdentity);
    }
    sources.push('classic');
  } else if (initialAuthority.classic) {
    return unavailableAttestation('REST and GraphQL classic protection disagree', branch, boundIdentity);
  }

  const parsedRules = readEffectiveRules(repo, nameWithOwner, branch);
  if (!parsedRules) {
    return unavailableAttestation('Effective branch rules are unavailable or malformed', branch, boundIdentity);
  }
  const effectiveRules = parseEffectiveRules(parsedRules, requirements, checks, bindings);
  if (!effectiveRules) {
    return unavailableAttestation('Effective branch rules are unavailable or malformed', branch, boundIdentity);
  }
  const rulesets = readRulesetProtections(
    repo,
    nameWithOwner,
    effectiveRules,
    classicProtection,
  );
  if (!rulesets) {
    return unavailableAttestation('Active ruleset policy is unavailable or malformed', branch, boundIdentity);
  }
  if (rulesets.length > 0) sources.push('ruleset');

  const finalRulesValue = readEffectiveRules(repo, nameWithOwner, branch);
  const finalRules = finalRulesValue === null
    ? null
    : parseEffectiveRules(finalRulesValue, new Set(), new Set(), new Map());
  if (!finalRules ||
      effectiveRulesFingerprint(finalRules) !== effectiveRulesFingerprint(effectiveRules)) {
    return unavailableAttestation('Effective branch rules changed during observation', branch, boundIdentity);
  }
  const finalRulesets = readRulesetProtections(
    repo,
    nameWithOwner,
    finalRules,
    classicProtection,
    rulesets,
  );
  if (!finalRulesets) {
    return unavailableAttestation('Active ruleset policy changed during observation', branch, boundIdentity);
  }
  const finalAuthority = readExactBranchAuthority(repo, nameWithOwner, branch);
  if (!finalAuthority || JSON.stringify(finalAuthority) !== JSON.stringify(initialAuthority)) {
    return unavailableAttestation('Exact GitHub branch authority changed during observation', branch, boundIdentity);
  }

  const normalizedRequirements = [...requirements].sort();
  const requiredChecks = [...checks].sort();
  const requiredCheckBindings = [...bindings.values()].sort((a, b) =>
    a.context.localeCompare(b.context) || (a.appId ?? '').localeCompare(b.appId ?? ''));
  const protectedBranch = sources.length > 0 && normalizedRequirements.length > 0;
  return {
    ok: protectedBranch,
    available: true,
    protected: protectedBranch,
    branchProtection: protectedBranch,
    nameWithOwner,
    repositoryId,
    defaultBranch,
    branch,
    baseHead,
    observedAt: new Date().toISOString(),
    requirements: normalizedRequirements,
    requiredChecks,
    requiredCheckBindings,
    sources,
    policySnapshot: {
      schemaVersion: 2,
      classic: classicProtection,
      rulesets,
    },
    detail: protectedBranch
      ? `Live branch protection confirmed with ${normalizedRequirements.length} requirement(s)`
      : 'No enforceable branch protection requirements were found',
  };
}

/**
 * Read live branch-protection evidence through `gh`. The result never throws,
 * never mutates GitHub, and never reuses stale evidence after a failed refresh.
 */
export function readBranchProtectionAttestation(
  repo: string,
  branch?: string,
  options: BranchProtectionAttestationOptions = {},
): Promise<BranchProtectionAttestation> {
  if (typeof repo !== 'string' || repo.trim().length === 0 || repo.length > 4_096 ||
      (branch !== undefined &&
        (typeof branch !== 'string' || branch.trim().length === 0 ||
          branch.trim() !== branch || branch.length > 256)) ||
      options === null || typeof options !== 'object' || Array.isArray(options) ||
      (options.forceFresh !== undefined && typeof options.forceFresh !== 'boolean') ||
      (options.expectedNameWithOwner !== undefined &&
        (typeof options.expectedNameWithOwner !== 'string' ||
          !/^[^/\s]+\/[^/\s]+$/.test(options.expectedNameWithOwner)))) {
    return Promise.resolve(unavailableAttestation(
      'Branch-protection request was invalid',
      typeof branch === 'string' ? branch : null,
    ));
  }
  const expectedNameWithOwner = options.expectedNameWithOwner;
  const key = attestationCacheKey(repo, branch, expectedNameWithOwner);
  const now = Date.now();
  if (options.forceFresh) branchProtectionCache.delete(key);
  if (!options.forceFresh) {
    const cached = branchProtectionCache.get(key);
    if (cached && cached.expiresAt > now) {
      branchProtectionCache.delete(key);
      branchProtectionCache.set(key, cached);
      return Promise.resolve(cloneAttestation(cached.value));
    }
    if (cached) branchProtectionCache.delete(key);
  }
  const existing = branchProtectionFlights.get(key);
  if (existing && !options.forceFresh) return existing.then(cloneAttestation);

  const flight = Promise.resolve()
    .then(() => readBranchProtectionUncached(repo, branch, expectedNameWithOwner))
    .catch(() => unavailableAttestation('Branch-protection refresh failed', branch ?? null));
  branchProtectionFlights.set(key, flight);
  return flight.then((value) => {
    // A forced refresh supersedes any older flight for the same identity. Only
    // the current flight may populate the cache; late stale reads are returned
    // to their original caller but cannot overwrite newer protection evidence.
    if (branchProtectionFlights.get(key) !== flight) return cloneAttestation(value);
    const ttl = value.ok
      ? BRANCH_PROTECTION_POSITIVE_TTL_MS
      : BRANCH_PROTECTION_NEGATIVE_TTL_MS;
    branchProtectionCache.set(key, { value: cloneAttestation(value), expiresAt: Date.now() + ttl });
    while (branchProtectionCache.size > BRANCH_PROTECTION_CACHE_MAX) {
      const oldest = branchProtectionCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      branchProtectionCache.delete(oldest);
    }
    return cloneAttestation(value);
  }).finally(() => {
    if (branchProtectionFlights.get(key) === flight) branchProtectionFlights.delete(key);
  });
}

// ---------------------------------------------------------------------------
// Public API — EXPLICIT MUTATION (caller must gate behind confirm)
// ---------------------------------------------------------------------------

/**
 * EXPLICIT, MUTATING. Creates a PR via `gh pr create`.
 *
 * The CLI layer (cli/gh.ts) MUST gate this behind an explicit
 * `ashlr gh pr create` command + confirmation prompt — NEVER call this
 * automatically or from any read/status path.
 *
 * May reject on hard failures; ok:false + detail describes the error.
 */
export async function createPr(
  cwd: string,
  opts: CreatePrOpts,
): Promise<CreatePrResult> {
  const args: string[] = ['pr', 'create', '--title', opts.title];

  if (opts.body) {
    args.push('--body', opts.body);
  } else {
    // gh pr create requires --body or --fill; use --fill to generate from commits
    args.push('--fill');
  }
  if (opts.base) args.push('--base', opts.base);
  if (opts.head) args.push('--head', opts.head);
  if (opts.draft) args.push('--draft');
  if (opts.repo) args.push('--repo', opts.repo);

  // NOTE: `gh pr create` does NOT support `--json` (only `gh pr list/view` do).
  // On success it prints the created PR URL as plain text on stdout, which we
  // parse below. Passing `--json` here would make gh exit non-zero on every run.

  try {
    const res = spawnSync(GH_BIN, args, {
      cwd,
      timeout: 30_000, // network operation — allow more time
      stdio: 'pipe',
      encoding: 'utf8',
      env: {
        ...process.env,
        GH_HOST: 'github.com',
        GH_NO_UPDATE_NOTIFIER: '1',
        NO_COLOR: '1',
      },
    });

    if (res.error) {
      return { ok: false, url: null, detail: res.error.message };
    }
    if (res.status !== 0) {
      const stderr = typeof res.stderr === 'string' ? res.stderr.trim() : '';
      return { ok: false, url: null, detail: stderr || `gh pr create exited ${res.status}` };
    }

    const trimmed = typeof res.stdout === 'string' ? res.stdout.trim() : '';
    let url: string | null = null;

    // `gh pr create` prints the created PR URL as plain text on stdout. Scan
    // the output for the first https:// line (gh may emit other lines first).
    for (const line of trimmed.split('\n')) {
      const t = line.trim();
      if (t.startsWith('https://')) {
        url = t;
        break;
      }
    }

    return { ok: true, url, detail: url ? `PR created: ${url}` : 'PR created' };
  } catch (err) {
    const detail =
      err instanceof Error
        ? err.message
        : String(err);
    return { ok: false, url: null, detail };
  }
}
