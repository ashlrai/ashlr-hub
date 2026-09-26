/**
 * Cloud PR preview (3.13) — what the standing merge gates would say about a
 * cloud task's pull request, computed from its SHA-pinned diff, so Needs-you
 * can triage it: land it, close it, or bring it up to date.
 *
 * PURE: the diff, GitHub's view of the PR and the live policy come in; a
 * verdict comes out. Fetching them is pr-actions.ts's job.
 *
 * NOTHING IS REIMPLEMENTED. Each diff check is the gate function the
 * standing merge pass runs (standing-merge-pass.ts evaluateProposal):
 *
 *   protected paths  evaluateG1 (selfRepo for ashlr-hub)
 *   tampering        evaluateG1b
 *   risk and size    classifyRisk + measureAutoMergeDiffScope → evaluateG2,
 *                    against the grant's caps (effectiveScopeCaps) — or the
 *                    compiled STANDING_GRANT_CEILINGS when no grant covers
 *                    the repo, the loosest any grant can ever be
 *   report vs diff   turnIntegrity(claim, changedFileCountFromDiff) → evaluateG4
 *
 * and GitHub's own state stands in for the rest a human would look at
 * (conflicts, behind base, required checks — the G7 "no checks ⇒ owner lane"
 * rule included).
 *
 * WHAT THIS IS NOT: a landing decision. G0 (authority), G3 (verification off
 * the current base), G5 and G6 (judge) run only inside the standing pass, and
 * cloud PRs do not enter it yet (automatic landing arrives with cloud
 * intake). `wouldAutoLand` means "every check the gates can make from the
 * diff and GitHub passes" — the list Mason would otherwise read himself. The
 * Tier-1 test-import half of G1 needs a checkout and is not run here; the
 * other G1 rules, including every Tier-1 source path, are.
 */
import { changedFileCountFromDiff, turnIntegrity, type CompletionClaim } from '../classify/completion-claims.js';
import { STANDING_GRANT_CEILINGS, type EffectiveMergePolicy, type EffectiveRepoPolicy } from '../authority/types.js';
import { measureAutoMergeDiffScope } from '../foundry/automerge-diff-scope.js';
import { classifyRisk } from '../inbox/merge.js';
import type { Proposal } from '../types.js';
import { evaluateG1, evaluateG1b, evaluateG2, evaluateG4 } from '../fleet/merge-gates.js';
import { MERGE_RISK_RANK } from '../fleet/fleet-types.js';
import type { CloudTaskReport } from './types.js';

// ---------------------------------------------------------------------------
// Wire shapes (GET /api/verse/cloud/previews; web imports these as types only)
// ---------------------------------------------------------------------------

export const VERSE_CLOUD_PREVIEWS_PATH = '/api/verse/cloud/previews' as const;

export type CloudPrCheckId = 'protected' | 'tamper' | 'scope' | 'claims' | 'conflicts' | 'behind' | 'ci';

export interface CloudPrCheck {
  id: CloudPrCheckId;
  ok: boolean;
  /** Two to six plain words: "No protected paths", "12 files (cap 10)". */
  text: string;
}

/** GitHub's required-checks rollup on the head commit. */
export type CloudPrChecksState = 'green' | 'red' | 'pending' | 'none';

/** GitHub's view of the PR at `headSha` (pr-actions.ts reads it with `gh`). */
export interface CloudPrGithubState {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  /** 40 hex. */
  headSha: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  /** BEHIND, BLOCKED, CLEAN, DIRTY, DRAFT, HAS_HOOKS, UNKNOWN, UNSTABLE. */
  mergeStateStatus: string;
  /** Commits on the base branch the head does not have; null = not compared. */
  behindBy: number | null;
  checks: CloudPrChecksState;
}

export interface CloudPrPreview {
  taskId: string;
  /** The Needs-you item this preview belongs to. */
  itemId: string;
  prNumber: number;
  /** Every verdict here is about exactly this commit. */
  headSha: string;
  baseBranch: string;
  open: boolean;
  /** Every check below passes. */
  wouldAutoLand: boolean;
  /** One short plain sentence: "Clean: low risk, 3 files, checks green." / "Held: 2 commits behind master." */
  reason: string;
  /** What Land requires (G1 clear, no conflicts, open) — Land is refused otherwise. */
  landable: { ok: boolean; reason: string | null };
  /** The branch is behind its base and Update branch would help. */
  behind: boolean;
  checks: CloudPrCheck[];
  computedAt: string;
}

export interface CloudPrPreviewsResponse {
  generatedAt: string;
  previews: CloudPrPreview[];
}

/** Needs-you id of a cloud task's PR item (cloud-api.ts cloudNeedsYouItems). */
export function cloudPrItemId(taskId: string): string {
  return `fleet:owner-lane-pr:cloud-${taskId}`;
}

// ---------------------------------------------------------------------------
// Diff checks
// ---------------------------------------------------------------------------

/** The live grant's view of one repo; null = no standing grant covers it. */
export interface CloudPrPolicy {
  repo: EffectiveRepoPolicy;
  merge: EffectiveMergePolicy;
}

/**
 * The compiled ceilings as a policy: what the loosest grant could allow. A
 * preview without a grant is still judged against real bounds, never none.
 */
export function ceilingPolicy(repo: string, selfRepo: boolean): CloudPrPolicy {
  const c = STANDING_GRANT_CEILINGS;
  return {
    repo: {
      nameWithOwner: repo,
      stage: 'merge',
      enforcement: 'server',
      maxRisk: c.maxRisk,
      maxFiles: c.maxFiles,
      maxLines: c.maxLines,
      maxMergesPerDay: c.maxMergesPerRepoPerDay,
      selfRepo: selfRepo ? 'merge-non-authority' : null,
    },
    merge: {
      maxFiles: c.maxFiles,
      maxLines: c.maxLines,
      selfRepo: 'merge-non-authority',
      localAuthored: { ...c.localAuthored },
    },
  };
}

/**
 * The claim a cloud report makes, in completion-claims' vocabulary. `done`
 * and `partial` say work was done; `blocked` and `no-change` say none was —
 * a diff under either is the "silent change" G4 refuses. No report asserts
 * nothing (`unknown`, which G4 lets pass: it is not evidence either way).
 */
export function claimOfReport(report: CloudTaskReport | null): CompletionClaim {
  if (!report) return 'unknown';
  if (report.status === 'done' || report.status === 'partial') return 'claims-change';
  return 'reports-blocked';
}

export interface CloudPrDiffInput {
  repo: string;
  /** The unified diff pinned to the head SHA; null = it could not be read. */
  diff: string | null;
  selfRepo: boolean;
  report: CloudTaskReport | null;
  /** null = no standing grant covers the repo (ceilings apply). */
  policy: CloudPrPolicy | null;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The diff-only checks (protected, tamper, scope, claims). Cached per head SHA by pr-actions.ts. */
export function cloudPrDiffChecks(input: CloudPrDiffInput): CloudPrCheck[] {
  if (input.diff === null) {
    return [{ id: 'protected', ok: false, text: 'Diff unavailable' }];
  }
  const diff = input.diff;
  const scope = measureAutoMergeDiffScope(diff);
  const out: CloudPrCheck[] = [];

  const g1 = evaluateG1({ paths: scope.ok ? scope.touchedPaths : null, selfRepo: input.selfRepo });
  if (g1.verdict === 'pass') out.push({ id: 'protected', ok: true, text: 'No protected paths' });
  else if (g1.hits.length > 0) {
    const more = g1.hits.length > 1 ? ` +${g1.hits.length - 1}` : '';
    out.push({ id: 'protected', ok: false, text: `Protected: ${g1.hits[0]!.path}${more}` });
  } else out.push({ id: 'protected', ok: false, text: 'Diff unreadable' });

  const g1b = evaluateG1b(diff);
  out.push(g1b.verdict === 'pass'
    ? { id: 'tamper', ok: true, text: 'No test tampering' }
    : { id: 'tamper', ok: false, text: g1b.code === 'test-tamper' ? 'Test tampering' : 'Tampering not ruled out' });

  // classifyRisk reads only the diff; the rest of a Proposal is irrelevant here.
  const risk = classifyRisk({ diff } as Proposal);
  const policy = input.policy ?? ceilingPolicy(input.repo, input.selfRepo);
  const g2 = evaluateG2({
    partial: false,
    // A cloud PR has no fleet proposal to sign; its identity is the pinned
    // task branch and PR (tracker.ts). Provenance is the standing pass's
    // question once cloud intake exists, not the preview's.
    provenance: { ok: true },
    risk,
    scope: scope.ok ? { files: scope.files, changedLines: scope.changedLines } : null,
    repoPolicy: policy.repo,
    mergePolicy: policy.merge,
    config: {},
    // Claude cloud sessions are frontier-authored.
    producerLocal: false,
  });
  const riskWord = `${risk[0]!.toUpperCase()}${risk.slice(1)} risk`;
  if (!scope.ok) out.push({ id: 'scope', ok: false, text: 'Diff unmeasurable' });
  else if (g2.verdict === 'pass') {
    out.push({ id: 'scope', ok: true, text: `${riskWord} · ${plural(scope.files, 'file', 'files')} · ${plural(scope.changedLines, 'line', 'lines')}` });
  } else if (risk === 'high') {
    out.push({ id: 'scope', ok: false, text: 'High risk' });
  } else if (MERGE_RISK_RANK[risk] > MERGE_RISK_RANK[g2.caps.maxRisk]) {
    // G2's own order: risk, then files, then lines.
    out.push({ id: 'scope', ok: false, text: `${riskWord} (cap ${g2.caps.maxRisk})` });
  } else if (scope.files > g2.caps.maxFiles) {
    out.push({ id: 'scope', ok: false, text: `${plural(scope.files, 'file', 'files')} (cap ${g2.caps.maxFiles})` });
  } else {
    out.push({ id: 'scope', ok: false, text: `${plural(scope.changedLines, 'line', 'lines')} (cap ${g2.caps.maxLines})` });
  }

  const g4 = evaluateG4({
    integrity: turnIntegrity(claimOfReport(input.report), changedFileCountFromDiff(diff)),
    claim: claimOfReport(input.report),
    classifier: 'heuristic',
  });
  if (g4.verdict !== 'pass') out.push({ id: 'claims', ok: false, text: "Report doesn't match diff" });
  else out.push({ id: 'claims', ok: true, text: input.report ? 'Report matches diff' : 'No report' });
  return out;
}

// ---------------------------------------------------------------------------
// GitHub checks and the verdict
// ---------------------------------------------------------------------------

export function isBehind(github: CloudPrGithubState): boolean {
  return (github.behindBy !== null && github.behindBy > 0) || github.mergeStateStatus === 'BEHIND';
}

export function cloudPrGithubChecks(github: CloudPrGithubState, baseBranch: string): CloudPrCheck[] {
  const out: CloudPrCheck[] = [];
  if (github.mergeable === 'MERGEABLE' && github.mergeStateStatus !== 'DIRTY') out.push({ id: 'conflicts', ok: true, text: 'No conflicts' });
  else if (github.mergeable === 'CONFLICTING' || github.mergeStateStatus === 'DIRTY') out.push({ id: 'conflicts', ok: false, text: `Conflicts with ${baseBranch}` });
  else out.push({ id: 'conflicts', ok: false, text: 'GitHub still checking' });

  if (isBehind(github)) {
    out.push({ id: 'behind', ok: false, text: github.behindBy && github.behindBy > 0 ? `${plural(github.behindBy, 'commit', 'commits')} behind` : `Behind ${baseBranch}` });
  } else if (github.behindBy === null) out.push({ id: 'behind', ok: false, text: `Not compared with ${baseBranch}` });
  else out.push({ id: 'behind', ok: true, text: `Up to date with ${baseBranch}` });

  const ci: Record<CloudPrChecksState, CloudPrCheck> = {
    green: { id: 'ci', ok: true, text: 'Checks green' },
    red: { id: 'ci', ok: false, text: 'Checks failing' },
    pending: { id: 'ci', ok: false, text: 'Checks running' },
    // G7: a PR with no checks is never landed automatically.
    none: { id: 'ci', ok: false, text: 'No checks reported' },
  };
  out.push(ci[github.checks]);
  return out;
}

export interface CloudPrPreviewInput {
  taskId: string;
  prNumber: number;
  baseBranch: string;
  github: CloudPrGithubState;
  /** cloudPrDiffChecks for exactly `github.headSha`. */
  diffChecks: readonly CloudPrCheck[];
  now: Date;
}

/** Land's own refusals (pr-actions.ts landCloudPr enforces the same). */
export function landRefusal(github: CloudPrGithubState, diffChecks: readonly CloudPrCheck[], baseBranch: string): string | null {
  if (github.state !== 'OPEN') return `The pull request is ${github.state === 'MERGED' ? 'already merged' : 'closed'}.`;
  const protectedCheck = diffChecks.find((c) => c.id === 'protected');
  if (!protectedCheck || !protectedCheck.ok) {
    return protectedCheck && protectedCheck.text.startsWith('Protected: ')
      ? `It touches a protected path (${protectedCheck.text.slice('Protected: '.length)}); land it on GitHub after review.`
      : 'Its diff could not be checked for protected paths.';
  }
  if (github.mergeable === 'CONFLICTING' || github.mergeStateStatus === 'DIRTY') return `It conflicts with ${baseBranch}.`;
  if (github.mergeable !== 'MERGEABLE') return 'GitHub has not finished checking whether it can merge. Try again in a minute.';
  return null;
}

export function cloudPrPreview(input: CloudPrPreviewInput): CloudPrPreview {
  const checks = [...input.diffChecks, ...cloudPrGithubChecks(input.github, input.baseBranch)];
  const failing = checks.filter((c) => !c.ok);
  const wouldAutoLand = failing.length === 0 && input.github.state === 'OPEN';
  const scope = checks.find((c) => c.id === 'scope');
  const refusal = landRefusal(input.github, input.diffChecks, input.baseBranch);
  let reason: string;
  if (input.github.state !== 'OPEN') reason = refusal ?? 'The pull request is not open.';
  else if (wouldAutoLand) reason = `Clean: ${scope ? scope.text.replace(/ · /g, ', ').toLowerCase() : 'every check passes'}, checks green.`;
  else reason = `Held: ${failing.slice(0, 2).map((c) => c.text.charAt(0).toLowerCase() + c.text.slice(1)).join('; ')}${failing.length > 2 ? ` (+${failing.length - 2} more)` : ''}.`;
  return {
    taskId: input.taskId,
    itemId: cloudPrItemId(input.taskId),
    prNumber: input.prNumber,
    headSha: input.github.headSha,
    baseBranch: input.baseBranch,
    open: input.github.state === 'OPEN',
    wouldAutoLand,
    reason,
    landable: refusal === null ? { ok: true, reason: null } : { ok: false, reason: refusal },
    behind: isBehind(input.github),
    checks,
    computedAt: input.now.toISOString(),
  };
}
