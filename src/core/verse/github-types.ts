/**
 * core/verse/github-types.ts — the GitHub wire contract for Ashlr Verse
 * (docs/VERSE-WORKSPACES.md §2).
 *
 * `src/core/integrations/github.ts` already does the hard part; none of it was
 * reachable from Verse. These are the shapes that carry it across the wire,
 * plus the one shape the hub never had: a DISCLOSURE of what an approved
 * proposal of kind `pr` is about to do, computed BEFORE the operator clicks.
 *
 * TWO RULES ENCODED HERE RATHER THAN LEFT TO THE UI
 *
 * 1. NO REMOTE URL EVER APPEARS IN THESE SHAPES. A git remote URL may carry
 *    credentials in its userinfo (`https://x-access-token:<token>@github.com/…`
 *    is a supported GitHub transport, and core/git.ts's canonicaliser accepts
 *    it). Repository identity therefore travels ONLY as `nameWithOwner`, which
 *    is derived from the URL and cannot contain one. `pushUrl`/`fetchUrls` from
 *    `resolveGitHubOriginAuthorityDetails()` are deliberately dropped on the
 *    floor; see test/verse-github-repo.test.ts for the guard that keeps it so.
 *
 * 2. THE PR PLAN IS A PREDICTION, AND SAYS SO. Before apply, `branch` and
 *    `base` are what `core/inbox/apply.ts` WOULD use; after apply they are what
 *    it DID use, read back off `proposal.remoteHandoff`. `baseSource` and
 *    `branchSource` name which of the two an operator is looking at, because a
 *    disclosure that cannot distinguish a prediction from a record is not a
 *    disclosure.
 *
 * Nothing here is a new source of truth — every field is a projection of state
 * the hub already computes.
 */

// ---------------------------------------------------------------------------
// Per-repository surfacing
// ---------------------------------------------------------------------------

/**
 * Aggregate state of one pull request's check rollup.
 *
 * `none`    — the head commit has no checks at all.
 * `unknown` — gh returned no rollup for this PR (old gh, partial JSON). NOT
 *             the same as `none`, and never collapsed into it.
 */
export type VerseGithubCheckState = 'passing' | 'failing' | 'pending' | 'none' | 'unknown';

/** Counts behind a `VerseGithubCheckState`, so the UI can show "3 of 9 failing". */
export interface VerseGithubChecks {
  state: VerseGithubCheckState;
  total: number;
  passed: number;
  failed: number;
  pending: number;
}

/** One open pull request, with the CI state `listPrs()` cannot supply. */
export interface VerseGithubPr {
  number: number;
  title: string;
  url: string;
  /** gh's PR state, lowercased: `open` for everything this route returns. */
  state: string;
  /** Login, or `''` for a ghost/deleted author — never null, mirroring listPrs(). */
  author: string;
  draft: boolean;
  headRefName: string | null;
  baseRefName: string | null;
  checks: VerseGithubChecks;
}

/** One open issue — the work a seat could be pointed at. */
export interface VerseGithubIssue {
  number: number;
  title: string;
  url: string;
  state: string;
  author: string;
  labels: string[];
}

/**
 * Whether a root is a git repo at all, and whether its `origin` resolves to a
 * single GitHub repository. `not-github` covers both "no origin" and "origin
 * points somewhere we refuse to reason about" (rewrite rules, divergent
 * fetch/push destinations) — core/git.ts fails closed there and so do we.
 */
export type VerseGithubRemoteState = 'github' | 'not-github' | 'not-a-repo';

/** Repository identity. Deliberately URL-free — see rule 1 in the header. */
export interface VerseGithubRemote {
  state: VerseGithubRemoteState;
  /** Lowercase `owner/name`, or null when `state !== 'github'`. */
  nameWithOwner: string | null;
  /** `origin/HEAD`, else the checked-out branch, else `main`. Null when not a repo. */
  defaultBranch: string | null;
}

/**
 * Everything Verse shows for one workspace root. Reads only; never throws.
 *
 * THREE STATES, NOT TWO. `gh` is a synchronous subprocess with an 8 s ceiling,
 * so a multi-root listing deliberately does not call it — it answers with
 * `listsRequested: false` and identity only, and the UI asks for one root at a
 * time to fill in the rest. `prsAvailable` / `issuesAvailable` then mean
 * something narrower but honest: gh WAS asked and could not answer (absent,
 * unauthenticated, offline, rate-limited). An empty list with `available:
 * true` genuinely means zero open. The UI must be able to tell "nothing open"
 * from "could not look" from "have not looked yet", and a bare `[]` collapses
 * all three.
 */
export interface VerseGithubRepoSnapshot {
  path: string;
  name: string;
  remote: VerseGithubRemote;
  prs: VerseGithubPr[];
  issues: VerseGithubIssue[];
  /** False when this read was identity-only and gh was never invoked. */
  listsRequested: boolean;
  prsAvailable: boolean;
  issuesAvailable: boolean;
  /** ISO-8601. */
  observedAt: string;
  /** One short human sentence: why a list is empty or unavailable. */
  detail: string;
}

/** `GET /api/verse/github` — one entry per requested/known root. */
export interface VerseGithubSnapshot {
  repos: VerseGithubRepoSnapshot[];
  observedAt: string;
}

// ---------------------------------------------------------------------------
// The disclosure: what an approved `pr` proposal will do
// ---------------------------------------------------------------------------

/**
 * `ready`       — this is a `pr` proposal that has not been applied; branch
 *                 and base below are the PREDICTION.
 * `opened`      — a pull request already exists for it; the fields are a RECORD.
 * `unavailable` — not a `pr` proposal, or it carries no repo, so there is
 *                 nothing outward-facing to disclose.
 */
export type VerseGithubPrPlanState = 'ready' | 'opened' | 'unavailable';

/** Where a field came from — prediction, or read back off the applied proposal. */
export type VerseGithubPrPlanSource = 'predicted' | 'recorded' | 'unknown';

/**
 * The pre-click disclosure for an approved proposal of kind `pr`.
 *
 * `core/inbox/apply.ts` applies a `pr` proposal by creating the branch
 * `ashlr/proposal/<id>` in a throwaway worktree and calling
 * `createPr(repo, { title, body: summary, head: branch })` with NO `base` —
 * so GitHub resolves the base to the repository's default branch. `base` below
 * reproduces that resolution locally; `baseSource: 'predicted'` marks it as
 * our reading of what gh will choose, not something gh was told.
 *
 * `publishesBranch` is true and constant for a `ready` plan: `applyPr` never
 * runs `git push`; `gh pr create --head <branch>` publishes the branch as a
 * side effect. An operator approving this is publishing a branch, and the
 * disclosure says so rather than implying a local-only step.
 */
export interface VerseGithubPrPlan {
  proposalId: string;
  state: VerseGithubPrPlanState;
  /** The proposal's kind, verbatim, so the UI need not re-derive it. */
  kind: string;
  /** Filesystem root the PR is opened from. */
  repoPath: string | null;
  /** Lowercase `owner/name` the PR will land on, when origin resolves. */
  nameWithOwner: string | null;
  /** Branch that will be created and published, e.g. `ashlr/proposal/prop-…`. */
  branch: string | null;
  branchSource: VerseGithubPrPlanSource;
  /** Branch the PR will target. */
  base: string | null;
  baseSource: VerseGithubPrPlanSource;
  /** PR title — `proposal.title`, verbatim, as `createPr` receives it. */
  title: string | null;
  /** First lines of the PR body (`proposal.summary`), bounded. */
  bodyPreview: string | null;
  /** True when the body was longer than the preview. */
  bodyTruncated: boolean;
  /** Set once a PR exists. Null for a `ready` plan. */
  prUrl: string | null;
  /** True when approving this publishes a branch to the remote. */
  publishesBranch: boolean;
  /** One human sentence naming the outward-facing effect. */
  detail: string;
}

/** `GET /api/verse/github/pr-plan` — plans for the requested proposals. */
export interface VerseGithubPrPlanResponse {
  plans: VerseGithubPrPlan[];
  observedAt: string;
}
