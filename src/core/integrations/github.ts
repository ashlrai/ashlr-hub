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
const MAX_REQUIRED_CHECKS = 100;

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

/** Detailed read-only PR status used to reconcile remote host handoffs. */
export interface PrView {
  number?: number;
  url?: string;
  state?: string;
  mergedAt?: string | null;
  closed?: boolean;
  closedAt?: string | null;
  headRefName?: string;
  baseRefName?: string;
  mergeCommitOid?: string;
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
export function viewPr(cwd: string, selector: string): PrView | null {
  const raw = runGh(cwd, [
    'pr',
    'view',
    selector,
    '--json',
    'number,url,state,mergedAt,closed,closedAt,headRefName,baseRefName,mergeCommit',
  ]);
  const parsed = safeJson(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const mergeCommit = obj['mergeCommit'];
  let mergeCommitOid: string | undefined;
  if (mergeCommit !== null && typeof mergeCommit === 'object' && !Array.isArray(mergeCommit)) {
    const commitObj = mergeCommit as Record<string, unknown>;
    if (typeof commitObj['oid'] === 'string') mergeCommitOid = commitObj['oid'];
  }
  return {
    ...(typeof obj['number'] === 'number' ? { number: obj['number'] } : {}),
    ...(typeof obj['url'] === 'string' ? { url: obj['url'] } : {}),
    ...(typeof obj['state'] === 'string' ? { state: obj['state'] } : {}),
    ...(typeof obj['mergedAt'] === 'string' || obj['mergedAt'] === null ? { mergedAt: obj['mergedAt'] } : {}),
    ...(typeof obj['closed'] === 'boolean' ? { closed: obj['closed'] } : {}),
    ...(typeof obj['closedAt'] === 'string' || obj['closedAt'] === null ? { closedAt: obj['closedAt'] } : {}),
    ...(typeof obj['headRefName'] === 'string' ? { headRefName: obj['headRefName'] } : {}),
    ...(typeof obj['baseRefName'] === 'string' ? { baseRefName: obj['baseRefName'] } : {}),
    ...(mergeCommitOid ? { mergeCommitOid } : {}),
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
  | { kind: 'ok'; stdout: string }
  | { kind: 'not-found' | 'unavailable' };

function runAttestationGh(cwd: string, args: string[]): AttestationGhResult {
  try {
    const res = spawnSync(GH_BIN, args, {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: 1_048_576,
      stdio: 'pipe',
      encoding: 'utf8',
      env: {
        ...process.env,
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
      ? { kind: 'ok', stdout: res.stdout.trim() }
      : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
    detail,
  };
}

function parseAppId(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
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

function addClassicProtection(
  value: unknown,
  requirements: Set<string>,
  checks: Set<string>,
  bindings: Map<string, RequiredCheckBinding>,
): boolean {
  const protection = objectRecord(value);
  if (!protection) return false;

  const statusChecks = protection['required_status_checks'];
  if (statusChecks !== null && statusChecks !== undefined) {
    const status = objectRecord(statusChecks);
    if (!status) return false;
    const contexts = parseRequiredChecks(status['contexts'] ?? []);
    const appChecks = parseRequiredChecks(status['checks'] ?? [], 'app_id');
    if (!contexts || !appChecks) return false;
    requirements.add('required_status_checks');
    for (const binding of [...contexts, ...appChecks]) {
      checks.add(binding.context);
      bindings.set(`${binding.context}\0${binding.appId ?? ''}`, binding);
    }
  }

  const objectRequirements: Array<[string, string]> = [
    ['required_pull_request_reviews', 'pull_request'],
    ['restrictions', 'push_restrictions'],
  ];
  for (const [field, normalized] of objectRequirements) {
    const raw = protection[field];
    if (raw !== null && raw !== undefined) {
      if (!objectRecord(raw)) return false;
      requirements.add(normalized);
    }
  }

  const enabledRequirements: Array<[string, string]> = [
    ['required_signatures', 'required_signatures'],
    ['required_linear_history', 'required_linear_history'],
  ];
  for (const [field, normalized] of enabledRequirements) {
    const raw = protection[field];
    if (raw !== null && raw !== undefined) {
      const obj = objectRecord(raw);
      if (!obj || typeof obj['enabled'] !== 'boolean') return false;
      if (obj['enabled']) requirements.add(normalized);
    }
  }
  return true;
}

function addEffectiveRules(
  value: unknown,
  requirements: Set<string>,
  checks: Set<string>,
  bindings: Map<string, RequiredCheckBinding>,
): boolean {
  if (!Array.isArray(value) || value.length > MAX_BRANCH_RULES) return false;
  for (const item of value) {
    const rule = objectRecord(item);
    const type = boundedNonEmptyString(rule?.['type'], 100);
    if (!rule || !type) return false;
    requirements.add(type);
    if (type !== 'required_status_checks') continue;
    const parameters = objectRecord(rule['parameters']);
    if (!parameters) return false;
    const parsed = parseRequiredChecks(parameters['required_status_checks'], 'integration_id');
    if (!parsed) return false;
    for (const binding of parsed) {
      checks.add(binding.context);
      bindings.set(`${binding.context}\0${binding.appId ?? ''}`, binding);
    }
  }
  return true;
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
  const boundIdentity = { ...identity, baseHead };

  const requirements = new Set<string>();
  const checks = new Set<string>();
  const bindings = new Map<string, RequiredCheckBinding>();
  const sources: Array<'classic' | 'ruleset'> = [];
  const classic = runAttestationGh(repo, [
    'api',
    apiPath(nameWithOwner, branch, '/protection'),
  ]);
  if (classic.kind === 'unavailable') {
    return unavailableAttestation('Classic branch protection is unavailable', branch, boundIdentity);
  }
  if (classic.kind === 'ok') {
    if (!addClassicProtection(safeJson(classic.stdout), requirements, checks, bindings)) {
      return unavailableAttestation('Classic branch protection was malformed', branch, boundIdentity);
    }
    sources.push('classic');
  }

  const rules = runAttestationGh(repo, [
    'api',
    `repos/${nameWithOwner}/rules/branches/${branch.split('/').map(encodeURIComponent).join('/')}`,
  ]);
  if (rules.kind !== 'ok') {
    return unavailableAttestation('Effective branch rules are unavailable or malformed', branch, boundIdentity);
  }
  const parsedRules = safeJson(rules.stdout);
  if (!addEffectiveRules(parsedRules, requirements, checks, bindings)) {
    return unavailableAttestation('Effective branch rules are unavailable or malformed', branch, boundIdentity);
  }
  if (Array.isArray(parsedRules) && parsedRules.length > 0) {
    sources.push('ruleset');
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
  if (existing) return existing.then(cloneAttestation);

  const flight = Promise.resolve()
    .then(() => readBranchProtectionUncached(repo, branch, expectedNameWithOwner))
    .catch(() => unavailableAttestation('Branch-protection refresh failed', branch ?? null));
  branchProtectionFlights.set(key, flight);
  return flight.then((value) => {
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
