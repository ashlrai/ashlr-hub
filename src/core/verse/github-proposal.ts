/**
 * core/verse/github-proposal.ts — the pre-click disclosure for an approved
 * proposal of kind `pr` (docs/VERSE-WORKSPACES.md §2).
 *
 * THE POINT OF THIS FILE. Approving a `pr` proposal is the one action in the
 * hub that reaches outside the machine: `core/inbox/apply.ts` builds a branch
 * in a throwaway worktree and calls `createPr()`, which publishes that branch
 * and opens a real pull request. The Approvals view names the repo and the
 * kind. It does not name the branch it is about to create or the pull request
 * it is about to open, so the operator learns both AFTER the click, from
 * `proposal.result` — a sentence, produced by the thing they already approved.
 * This module computes them BEFORE.
 *
 * ── WHAT APPLY ACTUALLY DOES (verified against src/core/inbox/apply.ts) ────
 *   • branch  = `ashlr/proposal/${proposal.id}`      (apply.ts:52, :125, :254)
 *   • createPr(repo, { title: proposal.title,
 *                      body:  proposal.summary,
 *                      head:  branch })              (apply.ts:257-261)
 *   • NO `base` is passed, so GitHub resolves the base to the repository's
 *     default branch. `predictPrPlan` reproduces that locally from
 *     `git symbolic-ref origin/HEAD` and labels it `baseSource: 'predicted'`,
 *     because it is our reading of gh's choice, not an instruction to gh.
 *   • NO `git push` runs. `gh pr create --head <branch>` publishes the branch
 *     as a side effect, which is why `publishesBranch` is true and stated.
 *
 * ── DRIFT ──────────────────────────────────────────────────────────────────
 * `PROPOSAL_BRANCH_PREFIX` is module-private in apply.ts, so the literal is
 * repeated here. test/verse-github-proposal.test.ts reads apply.ts and fails
 * if the two ever diverge — a disclosure that predicts the wrong branch name
 * is worse than none.
 *
 * READ-ONLY. NEVER THROWS. Opens nothing, pushes nothing, spawns only the
 * `git` reads core/git.ts already performs.
 */

import { defaultBranch, resolveGitHubOriginAuthority } from '../git.js';
import type { Proposal } from '../types.js';
import type {
  VerseGithubPrPlan,
  VerseGithubPrPlanSource,
  VerseGithubPrPlanState,
} from './github-types.js';

/**
 * Mirrors `PROPOSAL_BRANCH_PREFIX` in src/core/inbox/apply.ts:52, which is not
 * exported. Guarded against drift by test/verse-github-proposal.test.ts.
 */
export const VERSE_PROPOSAL_BRANCH_PREFIX = 'ashlr/proposal/';

const MAX_BODY_PREVIEW_CHARS = 400;
const MAX_REF_CHARS = 256;
const MAX_TITLE_CHARS = 512;

/**
 * Only a real GitHub pull-request URL is ever surfaced as `prUrl`.
 * `proposal.result` also carries gh's failure text on the unhappy path, and
 * that text is not something to hand a UI as a link.
 */
const PR_URL_RE = /https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+\/pull\/\d+/;

/** The subset of `Proposal` a plan needs. Structural, so fixtures stay small. */
export type VersePrPlanProposal = Pick<
  Proposal,
  'id' | 'kind' | 'repo' | 'title' | 'summary' | 'status'
> &
  Partial<Pick<Proposal, 'result' | 'remoteHandoff' | 'localMergeIntent'>>;

/** Git facts the plan needs. Defaults to core/git.ts; injected in tests. */
export interface VersePrPlanGitProbe {
  defaultBranch(path: string): string;
  nameWithOwner(path: string): string | null;
}

export interface VersePrPlanOptions {
  git?: VersePrPlanGitProbe;
}

const realGit: VersePrPlanGitProbe = {
  defaultBranch: (path) => defaultBranch(path),
  nameWithOwner: (path) => resolveGitHubOriginAuthority(path),
};

/** The branch `applyPr` will create for this proposal id. */
export function verseProposalBranch(proposalId: string): string {
  return `${VERSE_PROPOSAL_BRANCH_PREFIX}${proposalId}`;
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function extractPrUrl(...candidates: readonly unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const match = PR_URL_RE.exec(candidate);
    if (match) return match[0];
  }
  return null;
}

function unavailable(
  proposal: VersePrPlanProposal,
  detail: string,
): VerseGithubPrPlan {
  return {
    proposalId: proposal.id,
    state: 'unavailable',
    kind: proposal.kind,
    repoPath: proposal.repo ?? null,
    nameWithOwner: null,
    branch: null,
    branchSource: 'unknown',
    base: null,
    baseSource: 'unknown',
    title: null,
    bodyPreview: null,
    bodyTruncated: false,
    prUrl: null,
    publishesBranch: false,
    detail,
  };
}

/**
 * Describe what approving this proposal will do — or, once it has been
 * applied, what it did.
 *
 * Returns `state: 'unavailable'` (and no branch/base) for anything that is not
 * an outward-facing `pr` proposal, so a caller can render the disclosure
 * unconditionally and let the shape decide whether there is anything to show.
 */
export function describeVersePrPlan(
  proposal: VersePrPlanProposal,
  opts: VersePrPlanOptions = {},
): VerseGithubPrPlan {
  const git = opts.git ?? realGit;

  if (proposal.kind !== 'pr') {
    return unavailable(proposal, `kind ${proposal.kind} opens no pull request`);
  }

  const repoPath = boundedString(proposal.repo, 4_096);
  if (!repoPath) {
    return unavailable(proposal, 'proposal carries no repository, so no pull request can be opened');
  }

  const handoff = proposal.remoteHandoff;
  const intent = proposal.localMergeIntent;

  // Recorded values win over predicted ones: once apply has run, the plan
  // stops being a forecast and becomes a record of what happened.
  const recordedBranch = boundedString(handoff?.branch, MAX_REF_CHARS)
    ?? boundedString(intent?.branch, MAX_REF_CHARS);
  const branch = recordedBranch ?? verseProposalBranch(proposal.id);
  const branchSource: VerseGithubPrPlanSource = recordedBranch ? 'recorded' : 'predicted';

  const recordedBase = boundedString(handoff?.base, MAX_REF_CHARS)
    ?? boundedString(intent?.base, MAX_REF_CHARS);
  let base = recordedBase;
  let baseSource: VerseGithubPrPlanSource = recordedBase ? 'recorded' : 'unknown';
  if (!base) {
    try {
      base = boundedString(git.defaultBranch(repoPath), MAX_REF_CHARS);
      baseSource = base ? 'predicted' : 'unknown';
    } catch {
      base = null;
      baseSource = 'unknown';
    }
  }

  let nameWithOwner: string | null = null;
  try {
    nameWithOwner = boundedString(git.nameWithOwner(repoPath), 512);
  } catch {
    nameWithOwner = null;
  }

  const prUrl = extractPrUrl(handoff?.prUrl, proposal.result);

  const title = boundedString(proposal.title, MAX_TITLE_CHARS);
  const summary = typeof proposal.summary === 'string' ? proposal.summary.trim() : '';
  const bodyTruncated = summary.length > MAX_BODY_PREVIEW_CHARS;
  const bodyPreview = summary.length === 0
    ? null
    : summary.slice(0, MAX_BODY_PREVIEW_CHARS);

  const state: VerseGithubPrPlanState = prUrl ? 'opened' : 'ready';
  const target = nameWithOwner ?? repoPath;

  const detail = state === 'opened'
    ? `Opened ${prUrl} from ${branch} into ${base ?? 'the default branch'} on ${target}.`
    : `Approving pushes ${branch} to ${target} and opens a pull request into ${base ?? 'its default branch'}.`;

  return {
    proposalId: proposal.id,
    state,
    kind: proposal.kind,
    repoPath,
    nameWithOwner,
    branch,
    branchSource,
    base,
    baseSource,
    title,
    bodyPreview,
    bodyTruncated,
    prUrl,
    // True for a plan that has not run yet: `gh pr create --head <branch>`
    // publishes the branch. Once the PR exists the push has already happened.
    publishesBranch: state === 'ready',
    detail,
  };
}

/** Plans for several proposals, in the order given. Never throws. */
export function describeVersePrPlans(
  proposals: readonly VersePrPlanProposal[],
  opts: VersePrPlanOptions = {},
): VerseGithubPrPlan[] {
  const out: VerseGithubPrPlan[] = [];
  for (const proposal of proposals) {
    try {
      out.push(describeVersePrPlan(proposal, opts));
    } catch {
      out.push(unavailable(proposal, 'could not describe this proposal'));
    }
  }
  return out;
}
