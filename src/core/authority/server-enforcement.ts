/**
 * Server enforcement — can GitHub itself protect a grant repo's default branch?
 *
 * A standing grant names each repo `server` or `local` enforcement (types.ts
 * StandingGrantRepo). `server` means GitHub's rulesets / branch protection
 * require checks on the default branch, and merge gate G7 trusts exactly those
 * required checks; `local` means GitHub protects nothing, so G7 requires every
 * check on the head green AND the ashlr-fleet App's host-verified
 * `ashlr/verify` (fleet/verify-check-run.ts), under the lower local ceilings.
 *
 * WHY THIS MODULE EXISTS: on GitHub Free, rulesets AND classic branch
 * protection are unavailable for PRIVATE repos. Verified against the live API
 * (2026-09-26, org plan "free", private ashlrai/measurably):
 *
 *   GET repos/X/rulesets                    → 403 "Upgrade to GitHub Pro or make this repository public to enable this feature."
 *   GET repos/X/rules/branches/main         → 403 (same message)
 *   GET repos/X/branches/main/protection    → 403 (same message)
 *   GET repos/X/branches/main               → 200, protected: false
 *
 * So classic branch protection is NOT a fallback where rulesets are missing
 * (it is plan-gated identically) and the fleet does not try to apply it.
 * Drafts used to mark every repo whose visibility was unknown `server`, which
 * made G7 send every PR in such a repo to the owner lane forever. A draft now
 * asks GitHub and names `server` only where GitHub already enforces at least
 * one required check on the default branch; everything else is `local`.
 *
 * Nothing here gates a merge: G7 re-reads the live protection on every PR.
 * These reads only decide what a DRAFT proposes (Mason still signs it) and
 * what status / setup report. Every call is a `gh api <path>` GET.
 */
import { execFile } from 'node:child_process';

import type { RepoEnforcement } from '../fleet/fleet-types.js';

/** What a failed GitHub read means (drives the wording and whether a draft may treat it as definitive). */
export type GithubReadFailure =
  /** The feature is not on this plan for this repo (private repo on Free): definitive. */
  | 'plan-unavailable'
  /** Auth is missing or lacks access (401/403 other than the plan message, "Resource not accessible"). */
  | 'no-permission'
  /** 404: no such repo, or not visible to this auth. */
  | 'not-found'
  /** 5xx, 429 / rate limits, timeouts, network errors: try again later. */
  | 'transient'
  | 'unknown';

/** GitHub's wording for a plan-gated feature on a private repo (rulesets, branch protection). */
const PLAN_UNAVAILABLE_RE = /upgrade to github pro|make this repository public to enable this feature/iu;
const TRANSIENT_RE = /rate limit|HTTP 5\d\d|HTTP 429|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|could not resolve|network|did not answer|ran out of time|bad gateway|service unavailable/iu;
const PERMISSION_RE = /HTTP 40[13]\b|resource not accessible|must have admin|bad credentials|requires authentication|gh auth login|not logged in/iu;
const NOT_FOUND_RE = /HTTP 404\b|\bnot found\b/iu;

/**
 * PURE: classify a failed GitHub read from its HTTP status (when known) and
 * message (gh's stderr, or the API's `message`). The plan message wins over
 * everything: GitHub sends it with a 403, which would otherwise read as a
 * permission problem. A rate-limit 403 is transient, not a permission problem.
 */
export function classifyGithubReadFailure(input: { status?: number | null; message: string }): GithubReadFailure {
  const message = input.message ?? '';
  const status = input.status ?? null;
  if (PLAN_UNAVAILABLE_RE.test(message)) return 'plan-unavailable';
  if ((status !== null && (status >= 500 || status === 429 || status === 0)) || TRANSIENT_RE.test(message)) return 'transient';
  if (status === 404 || (status === null && NOT_FOUND_RE.test(message))) return 'not-found';
  if (status === 401 || status === 403 || (status === null && PERMISSION_RE.test(message))) return 'no-permission';
  return 'unknown';
}

/** PURE: true only for GitHub's "not on this plan" answer — never for a permission or transient failure. */
export function isPlanUnavailable(input: { status?: number | null; message: string }): boolean {
  return classifyGithubReadFailure(input) === 'plan-unavailable';
}

/** PURE: a short human phrase for a failure kind. */
export function describeGithubReadFailure(kind: GithubReadFailure): string {
  switch (kind) {
    case 'plan-unavailable': return 'not available on this GitHub plan for a private repo';
    case 'no-permission': return 'your gh auth has no access (check `gh auth status`)';
    case 'not-found': return 'not found, or not visible to your gh auth';
    case 'transient': return 'GitHub did not answer (network, rate limit or outage) — try again';
    default: return 'GitHub refused the read';
  }
}

export type ServerEnforcementState =
  /** GitHub requires at least one status check on the default branch (rulesets or classic protection). */
  | 'enforced'
  /** Protection is readable (the plan has it) but requires no status check: G7 under `server` would owner-lane every PR. */
  | 'no-required-checks'
  /** Rulesets / protection are not on this plan for this (private) repo: only `local` enforcement can work. */
  | 'unavailable'
  /** Could not tell (permission, network, …): never treated as enforced. */
  | 'unreadable';

export interface ServerEnforcementProbe {
  nameWithOwner: string;
  state: ServerEnforcementState;
  /** null = the repo itself could not be read. */
  private: boolean | null;
  /** Why the probe could not tell (state 'unavailable' | 'unreadable'); null otherwise. */
  failure: GithubReadFailure | null;
  /** One human sentence. */
  detail: string;
}

/** One `gh api <path>` GET. `status` is gh's exit code (0 = the API answered 2xx). */
export type GithubGet = (path: string) => Promise<{ status: number; stdout: string; stderr: string }> | { status: number; stdout: string; stderr: string };

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,255}$/u;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text || 'null') as unknown;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function failureMessage(result: { stdout: string; stderr: string }): string {
  const body = record(parseJson(result.stdout));
  const apiMessage = typeof body?.['message'] === 'string' ? body['message'] as string : '';
  return `${result.stderr} ${apiMessage}`.replace(/\s+/gu, ' ').trim().slice(0, 300);
}

/**
 * PURE: how many required status checks GitHub enforces on a branch, from the
 * two reads merge gate G7 uses (fleet/host-merge.ts readRequiredChecks): the
 * effective branch rules and the classic protection summary on GET /branches.
 * Classic contexts with `enforcement_level: "off"` enforce nothing.
 */
export function countRequiredChecks(rules: unknown, branch: unknown): number {
  const contexts = new Set<string>();
  if (Array.isArray(rules)) {
    for (const rule of rules) {
      const r = record(rule);
      if (r?.['type'] !== 'required_status_checks') continue;
      const checks = record(r['parameters'])?.['required_status_checks'];
      if (!Array.isArray(checks)) continue;
      for (const check of checks) {
        const context = record(check)?.['context'];
        if (typeof context === 'string' && context.length > 0) contexts.add(context);
      }
    }
  }
  const classic = record(record(record(branch)?.['protection'])?.['required_status_checks']);
  if (classic && classic['enforcement_level'] !== 'off') {
    for (const list of [classic['contexts'], Array.isArray(classic['checks']) ? (classic['checks'] as unknown[]).map((c) => record(c)?.['context']) : []]) {
      if (!Array.isArray(list)) continue;
      for (const context of list) if (typeof context === 'string' && context.length > 0) contexts.add(context);
    }
  }
  return contexts.size;
}

/**
 * Ask GitHub whether it enforces required checks on `nameWithOwner`'s default
 * branch. At most three GETs: the repo, its effective branch rules, the
 * branch (classic protection summary). Never throws.
 */
export async function probeServerEnforcement(nameWithOwner: string, get: GithubGet): Promise<ServerEnforcementProbe> {
  const out = (state: ServerEnforcementState, isPrivate: boolean | null, failure: GithubReadFailure | null, detail: string): ServerEnforcementProbe =>
    ({ nameWithOwner, state, private: isPrivate, failure, detail });
  if (!REPO_RE.test(nameWithOwner)) return out('unreadable', null, 'unknown', 'not an owner/name repo');
  let repo: { status: number; stdout: string; stderr: string };
  try {
    repo = await get(`repos/${nameWithOwner}`);
  } catch (error) {
    repo = { status: 1, stdout: '', stderr: (error as Error).message };
  }
  if (repo.status !== 0) {
    const failure = classifyGithubReadFailure({ message: failureMessage(repo) });
    return out('unreadable', null, failure, `could not read ${nameWithOwner}: ${describeGithubReadFailure(failure)}`);
  }
  const info = record(parseJson(repo.stdout));
  const isPrivate = info?.['private'] === true ? true : info?.['private'] === false ? false : null;
  const branchName = typeof info?.['default_branch'] === 'string' && BRANCH_RE.test(info['default_branch'] as string) ? info['default_branch'] as string : null;
  if (!branchName) return out('unreadable', isPrivate, 'unknown', `${nameWithOwner} has no readable default branch`);
  const encoded = branchName.split('/').map(encodeURIComponent).join('/');
  let rules: { status: number; stdout: string; stderr: string };
  try {
    rules = await get(`repos/${nameWithOwner}/rules/branches/${encoded}?per_page=100`);
  } catch (error) {
    rules = { status: 1, stdout: '', stderr: (error as Error).message };
  }
  let rulesBody: unknown = [];
  if (rules.status !== 0) {
    const failure = classifyGithubReadFailure({ message: failureMessage(rules) });
    if (failure === 'plan-unavailable') {
      return out('unavailable', isPrivate, failure,
        `GitHub rulesets are unavailable on this plan for ${isPrivate === false ? 'repo' : 'private repo'} ${nameWithOwner}`);
    }
    // G7 reads a 404 here as "no rulesets" (older GHES); anything else is unknown.
    if (failure !== 'not-found') return out('unreadable', isPrivate, failure, `could not read ${nameWithOwner}'s branch rules: ${describeGithubReadFailure(failure)}`);
  } else {
    rulesBody = parseJson(rules.stdout);
  }
  let branch: { status: number; stdout: string; stderr: string };
  try {
    branch = await get(`repos/${nameWithOwner}/branches/${encoded}`);
  } catch (error) {
    branch = { status: 1, stdout: '', stderr: (error as Error).message };
  }
  if (branch.status !== 0) {
    const failure = classifyGithubReadFailure({ message: failureMessage(branch) });
    return out('unreadable', isPrivate, failure, `could not read ${nameWithOwner}'s ${branchName} branch: ${describeGithubReadFailure(failure)}`);
  }
  const required = countRequiredChecks(rulesBody, parseJson(branch.stdout));
  return required > 0
    ? out('enforced', isPrivate, null, `GitHub requires ${required} check${required === 1 ? '' : 's'} on ${nameWithOwner}:${branchName}`)
    : out('no-required-checks', isPrivate, null, `GitHub requires no status check on ${nameWithOwner}:${branchName}`);
}

/**
 * PURE: the enforcement a NEW grant draft names for a repo. `server` only
 * when GitHub already enforces required checks there — anything else
 * (unavailable, nothing required, unreadable, not probed) is `local`, which
 * is the stricter mode: lower ceilings, and G7 then demands the App's
 * host-verified `ashlr/verify` instead of trusting whatever ran.
 */
export function draftEnforcementFor(probe: Pick<ServerEnforcementProbe, 'state'> | null | undefined): RepoEnforcement {
  return probe?.state === 'enforced' ? 'server' : 'local';
}

/**
 * PURE: should a RE-APPROVAL switch a `server` repo to `local`? Only on
 * definitive evidence that GitHub cannot or does not enforce checks there —
 * an unreadable probe (offline, rate-limited) leaves the signed choice alone,
 * so a flaky network during a re-approval cannot quietly rewrite the grant.
 * A re-approval never switches `local` → `server` (that would widen the
 * ceilings; a new grant does it).
 */
export function reapprovalDowngrades(probe: Pick<ServerEnforcementProbe, 'state'> | null | undefined): boolean {
  return probe?.state === 'unavailable' || probe?.state === 'no-required-checks';
}

/**
 * PURE: the mismatch between a signed grant's enforcement and what GitHub
 * does today, as one sentence for status / setup / Verse; null when they
 * agree or the probe could not tell. The grant itself is never changed here —
 * only a re-approval (Touch ID) switches the repo.
 */
export function enforcementMismatch(
  grantRepo: { nameWithOwner: string; enforcement: RepoEnforcement },
  probe: ServerEnforcementProbe | null | undefined,
  grantSeq: number | null = null,
): string | null {
  if (grantRepo.enforcement !== 'server' || !probe) return null;
  const grant = grantSeq === null ? 'the grant' : `grant #${grantSeq}`;
  if (probe.state === 'unavailable') {
    return `${grant} says server enforcement for ${grantRepo.nameWithOwner}, but GitHub rulesets are unavailable on this plan for ${probe.private === false ? 'this repo' : 'this private repo'} ` +
      '— G7 sends its PRs to the owner lane; re-approve (`ashlr authority re-approve`) to switch it to local enforcement with ashlr/verify';
  }
  if (probe.state === 'no-required-checks') {
    return `${grant} says server enforcement for ${grantRepo.nameWithOwner}, but GitHub requires no check on its default branch ` +
      '— G7 sends its PRs to the owner lane; run `ashlr authority protect --apply`, or re-approve to switch it to local enforcement with ashlr/verify';
  }
  return null;
}

// ---------------------------------------------------------------------------
// The default reader: a bounded, read-only `gh api <path>`
// ---------------------------------------------------------------------------

const GH_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._~/?=&%-]{0,400}$/u;
const GH_TIMEOUT_MS = 10_000;

/**
 * `gh api <path>` (GET only, never a shell, killed after 10 s). Under Vitest
 * it refuses without spawning anything: a draft built by a test that did not
 * inject a reader must never read Mason's real GitHub account — and a refusal
 * makes every repo `local`, the stricter answer.
 */
export function defaultGithubGet(path: string): Promise<{ status: number; stdout: string; stderr: string }> {
  if (process.env['VITEST'] === 'true') return Promise.resolve({ status: 1, stdout: '', stderr: 'not read: GitHub reads are disabled under tests' });
  if (!GH_PATH_RE.test(path)) return Promise.resolve({ status: 1, stdout: '', stderr: 'refused: not a gh api path' });
  return new Promise((done) => {
    execFile('gh', ['api', path], {
      encoding: 'utf8',
      timeout: GH_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    }, (error, stdout, stderr) => {
      const code = (error as { code?: unknown } | null)?.code;
      done({ status: error ? (typeof code === 'number' ? code : 1) : 0, stdout: stdout ?? '', stderr: stderr || (error ? error.message : '') });
    });
  });
}

/** Probe several repos concurrently (each probe is ≤ 3 sequential GETs). Keyed by lower-cased owner/name. */
export async function probeServerEnforcementAll(repos: readonly string[], get: GithubGet = defaultGithubGet): Promise<Map<string, ServerEnforcementProbe>> {
  const unique = [...new Map(repos.map((repo) => [repo.toLowerCase(), repo])).values()];
  const probes = await Promise.all(unique.map((repo) => probeServerEnforcement(repo, get)));
  return new Map(probes.map((probe) => [probe.nameWithOwner.toLowerCase(), probe]));
}
