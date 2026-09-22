/**
 * Tests for src/core/verse/github-proposal.ts — the pre-click disclosure of
 * what approving a `pr` proposal will do (docs/VERSE-WORKSPACES.md §2).
 *
 * FULLY HERMETIC. The git probe is injected; no proposal is ever approved, no
 * branch created, no pull request opened. `core/inbox/apply.ts` is read as
 * TEXT, never executed.
 *
 * The two tests that matter most are the DRIFT GUARDS at the bottom. The
 * disclosure predicts a branch name and a base that live inside apply.ts's
 * module-private constants and call site. A prediction that silently stops
 * matching what apply actually does is worse than showing nothing, so these
 * tests fail the build the moment the two drift apart.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  VERSE_PROPOSAL_BRANCH_PREFIX,
  describeVersePrPlan,
  describeVersePrPlans,
  verseProposalBranch,
  type VersePrPlanGitProbe,
  type VersePrPlanProposal,
} from '../src/core/verse/github-proposal.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const APPLY_SOURCE = readFileSync(
  fileURLToPath(new URL('../src/core/inbox/apply.ts', import.meta.url)),
  'utf8',
);

const git: VersePrPlanGitProbe = {
  defaultBranch: () => 'master',
  nameWithOwner: () => 'ashlrai/ashlr-hub',
};

function proposal(over: Partial<VersePrPlanProposal> = {}): VersePrPlanProposal {
  return {
    id: 'prop-1758500000000-a1b2c3',
    kind: 'pr',
    repo: '/Users/m/code/ashlr-hub',
    title: 'Surface GitHub in Verse',
    summary: 'Adds the per-repository panel and the approvals disclosure.',
    status: 'pending',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The prediction
// ---------------------------------------------------------------------------

describe('describeVersePrPlan — before the click', () => {
  it('names the branch it will create and the pull request it will open', () => {
    const plan = describeVersePrPlan(proposal(), { git });

    expect(plan.state).toBe('ready');
    expect(plan.branch).toBe('ashlr/proposal/prop-1758500000000-a1b2c3');
    expect(plan.branchSource).toBe('predicted');
    expect(plan.base).toBe('master');
    expect(plan.baseSource).toBe('predicted');
    expect(plan.nameWithOwner).toBe('ashlrai/ashlr-hub');
    expect(plan.title).toBe('Surface GitHub in Verse');
    expect(plan.bodyPreview).toBe('Adds the per-repository panel and the approvals disclosure.');
    expect(plan.bodyTruncated).toBe(false);
    expect(plan.prUrl).toBeNull();
  });

  it('says out loud that approving publishes a branch', () => {
    // applyPr never runs `git push`; `gh pr create --head <branch>` publishes
    // it. An operator must not read this as a local-only step.
    const plan = describeVersePrPlan(proposal(), { git });
    expect(plan.publishesBranch).toBe(true);
    expect(plan.detail).toBe(
      'Approving pushes ashlr/proposal/prop-1758500000000-a1b2c3 to ashlrai/ashlr-hub '
      + 'and opens a pull request into master.',
    );
  });

  it('falls back to the repo path when origin does not resolve to one GitHub repo', () => {
    const plan = describeVersePrPlan(proposal(), {
      git: { ...git, nameWithOwner: () => null },
    });
    expect(plan.nameWithOwner).toBeNull();
    expect(plan.detail).toContain('/Users/m/code/ashlr-hub');
  });

  it('bounds the body preview and flags that it was cut', () => {
    const plan = describeVersePrPlan(proposal({ summary: 'x'.repeat(900) }), { git });
    expect(plan.bodyPreview).toHaveLength(400);
    expect(plan.bodyTruncated).toBe(true);
  });

  it('reports no base rather than guessing when git cannot answer', () => {
    const plan = describeVersePrPlan(proposal(), {
      git: {
        defaultBranch: () => { throw new Error('not a repo'); },
        nameWithOwner: () => { throw new Error('not a repo'); },
      },
    });
    expect(plan.base).toBeNull();
    expect(plan.baseSource).toBe('unknown');
    expect(plan.detail).toContain('its default branch');
    // Still discloses the branch, which does not depend on git at all.
    expect(plan.branch).toBe('ashlr/proposal/prop-1758500000000-a1b2c3');
  });
});

// ---------------------------------------------------------------------------
// Nothing to disclose
// ---------------------------------------------------------------------------

describe('describeVersePrPlan — nothing outward-facing', () => {
  it('is unavailable for every kind that opens no pull request', () => {
    for (const kind of ['patch', 'deploy', 'note', 'desktop-action', 'browser-action'] as const) {
      const plan = describeVersePrPlan(proposal({ kind }), { git });
      expect(plan.state).toBe('unavailable');
      expect(plan.branch).toBeNull();
      expect(plan.base).toBeNull();
      expect(plan.publishesBranch).toBe(false);
      expect(plan.detail).toBe(`kind ${kind} opens no pull request`);
    }
  });

  it('is unavailable when the proposal carries no repository', () => {
    const plan = describeVersePrPlan(proposal({ repo: null }), { git });
    expect(plan.state).toBe('unavailable');
    expect(plan.detail).toMatch(/carries no repository/);
  });
});

// ---------------------------------------------------------------------------
// After the click
// ---------------------------------------------------------------------------

describe('describeVersePrPlan — after apply', () => {
  it('prefers what happened over what was predicted', () => {
    const plan = describeVersePrPlan(
      proposal({
        status: 'awaiting-host-merge',
        remoteHandoff: {
          provider: 'github',
          state: 'awaiting-host-merge',
          prUrl: 'https://github.com/ashlrai/ashlr-hub/pull/406',
          branch: 'ashlr/proposal/other-branch',
          base: 'verse',
          createdAt: '2026-09-22T10:00:00.000Z',
        },
      }),
      { git },
    );

    expect(plan.state).toBe('opened');
    expect(plan.branch).toBe('ashlr/proposal/other-branch');
    expect(plan.branchSource).toBe('recorded');
    expect(plan.base).toBe('verse');
    expect(plan.baseSource).toBe('recorded');
    expect(plan.prUrl).toBe('https://github.com/ashlrai/ashlr-hub/pull/406');
    // The push already happened; the disclosure must not imply another one.
    expect(plan.publishesBranch).toBe(false);
    expect(plan.detail).toBe(
      'Opened https://github.com/ashlrai/ashlr-hub/pull/406 from ashlr/proposal/other-branch '
      + 'into verse on ashlrai/ashlr-hub.',
    );
  });

  it('recovers the pull request url from the result sentence apply writes', () => {
    const plan = describeVersePrPlan(
      proposal({
        status: 'applied',
        result: 'PR created: https://github.com/ashlrai/ashlr-hub/pull/407',
      }),
      { git },
    );
    expect(plan.state).toBe('opened');
    expect(plan.prUrl).toBe('https://github.com/ashlrai/ashlr-hub/pull/407');
  });

  it('never presents gh failure text as a pull request link', () => {
    // `proposal.result` carries `gh pr create failed: <gh's own words>` on the
    // unhappy path. That is not something to hand a UI as a link.
    for (const result of [
      'gh pr create failed: could not resolve to a Repository with the name',
      'gh pr create failed: see https://github.com/ashlrai/ashlr-hub/actions/runs/1',
      'gh pr create failed: https://github.com/cli/cli/issues/1234',
      'PR created',
    ]) {
      const plan = describeVersePrPlan(proposal({ status: 'failed', result }), { git });
      expect(plan.prUrl).toBeNull();
      expect(plan.state).toBe('ready');
    }
  });
});

describe('describeVersePrPlans', () => {
  it('returns one plan per proposal, in order', () => {
    const plans = describeVersePrPlans(
      [proposal({ id: 'a' }), proposal({ id: 'b', kind: 'patch' })],
      { git },
    );
    expect(plans.map((p) => [p.proposalId, p.state])).toEqual([
      ['a', 'ready'],
      ['b', 'unavailable'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Drift guards against src/core/inbox/apply.ts
// ---------------------------------------------------------------------------

describe('the prediction still matches what apply.ts does', () => {
  it('uses the same branch prefix apply.ts keeps module-private', () => {
    const match = /const PROPOSAL_BRANCH_PREFIX = '([^']+)';/.exec(APPLY_SOURCE);
    expect(match, 'PROPOSAL_BRANCH_PREFIX not found in src/core/inbox/apply.ts').not.toBeNull();
    expect(VERSE_PROPOSAL_BRANCH_PREFIX).toBe(match?.[1]);
  });

  it('builds the branch from the whole proposal id, as apply.ts does', () => {
    expect(APPLY_SOURCE).toContain('const branch = `${PROPOSAL_BRANCH_PREFIX}${proposalId}`;');
    expect(verseProposalBranch('prop-x')).toBe(`${VERSE_PROPOSAL_BRANCH_PREFIX}prop-x`);
  });

  it('still passes no base to createPr, which is why base is only ever predicted', () => {
    // If apply.ts starts passing an explicit base, `baseSource: 'predicted'`
    // becomes a lie and this module must read that base instead of guessing.
    const call = /const prResult = await createPr\(repo, \{([\s\S]*?)\}\);/.exec(APPLY_SOURCE);
    expect(call, 'createPr call site not found in src/core/inbox/apply.ts').not.toBeNull();
    expect(call?.[1]).toContain('title');
    expect(call?.[1]).toContain('body: summary');
    expect(call?.[1]).toContain('head: branch');
    expect(call?.[1]).not.toContain('base');
  });

  it('still opens the pull request without pushing separately', () => {
    // `publishesBranch: true` rests on gh publishing the head branch. A real
    // `git push` appearing in apply.ts would change what the operator is
    // approving, so it must not slip in unnoticed.
    const pushes = APPLY_SOURCE.match(/\[\s*'push'/g) ?? [];
    expect(pushes).toEqual([]);
  });
});
