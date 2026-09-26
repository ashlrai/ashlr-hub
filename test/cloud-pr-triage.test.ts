/**
 * 3.13 cloud PR triage — the pure half: the gate preview of a cloud PR
 * (src/core/cloud/pr-preview.ts), the Needs-you items and actions built from
 * it (cloud-api.ts cloudNeedsYouItems / triageActions), the strict action
 * body, and self-improvement review backpressure (budget.ts, store.ts, the
 * budget route's keys and `ashlr cloud budget --self-improve-max-open`).
 *
 * No GitHub, no disk: every input is passed in.
 */
import { describe, expect, it } from 'vitest';

import { parseBudgetFlags } from '../src/cli/cloud.js';
import { cloudBudgetView } from '../src/core/cloud/budget.js';
import { CloudInputError, cloudNeedsYouItems, parseCloudBudgetBody, parseCloudPrActionBody, triageActions } from '../src/core/cloud/cloud-api.js';
import {
  ceilingPolicy,
  claimOfReport,
  cloudPrDiffChecks,
  cloudPrGithubChecks,
  cloudPrItemId,
  cloudPrPreview,
  landRefusal,
  type CloudPrGithubState,
  type CloudPrPreview,
} from '../src/core/cloud/pr-preview.js';
import { ghRefusal, rollupChecks } from '../src/core/cloud/pr-actions.js';
import { DEFAULT_CLOUD_BUDGET, type CloudBudgetV1, type CloudTaskReport, type CloudTaskV1 } from '../src/core/cloud/types.js';
import { isNeedsYouItem } from '../src/core/verse/workbench-types.js';

const NOW = new Date('2026-09-26T12:00:00.000Z');
const SHA = 'a'.repeat(40);

/** A minimal git-style unified diff adding `lines` new lines to each path. */
function diffOf(files: Record<string, string[]>): string {
  return Object.entries(files).map(([path, lines]) => [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,1 +1,${lines.length + 1} @@`,
    ' const keep = 1;',
    ...lines.map((l) => `+${l}`),
  ].join('\n')).join('\n') + '\n';
}

const DONE: CloudTaskReport = { status: 'done', summary: 'Fixed it.', testsRun: ['npm test'], risks: [] };

function github(over: Partial<CloudPrGithubState> = {}): CloudPrGithubState {
  return { state: 'OPEN', isDraft: true, headSha: SHA, mergeable: 'MERGEABLE', mergeStateStatus: 'DRAFT', behindBy: 0, checks: 'green', ...over };
}

function task(over: Partial<CloudTaskV1> = {}): CloudTaskV1 {
  const id = over.id ?? 'ct_20260926T1100_abc123';
  return {
    v: 1, id, repo: 'ashlrai/ashlr-hub', baseBranch: 'master', branch: `ashlr-cloud/${id}`, title: 'Tidy the drawer',
    prompt: 'p', origin: 'self-improve', requestedBy: 'self-improve', seat: 'claude-a', sessionId: 'session_1', sessionUrl: null,
    state: 'pr-open', stateReason: null, failure: null, createdAt: '2026-09-26T11:00:00.000Z', launchedAt: '2026-09-26T11:00:05.000Z',
    updatedAt: '2026-09-26T11:30:00.000Z',
    pr: { number: 42, url: 'https://github.com/ashlrai/ashlr-hub/pull/42', state: 'open', draft: true, title: '[ashlr-cloud] Tidy' },
    report: DONE, deliveryPin: { number: 42, url: 'https://github.com/ashlrai/ashlr-hub/pull/42' },
    estimatedCostUsd: 3, backlogItemId: null, needsYouId: null, ...over,
  };
}

const small = diffOf({ 'src/web-ui/routes/verse/shell/thing.ts': ['export const x = 2;'] });

function preview(over: { diff?: string | null; github?: Partial<CloudPrGithubState>; report?: CloudTaskReport | null; selfRepo?: boolean } = {}): CloudPrPreview {
  const t = task();
  return cloudPrPreview({
    taskId: t.id,
    prNumber: 42,
    baseBranch: 'master',
    github: github(over.github),
    diffChecks: cloudPrDiffChecks({
      repo: t.repo,
      diff: over.diff === undefined ? small : over.diff,
      selfRepo: over.selfRepo ?? true,
      report: over.report === undefined ? DONE : over.report,
      policy: null,
    }),
    now: NOW,
  });
}

describe('the diff checks reuse the merge gates', () => {
  it('passes a small ordinary change: no protected path, no tampering, medium risk within the ceilings, report matches', () => {
    const checks = cloudPrDiffChecks({ repo: 'ashlrai/ashlr-hub', diff: small, selfRepo: true, report: DONE, policy: null });
    expect(checks.map((c) => [c.id, c.ok])).toEqual([['protected', true], ['tamper', true], ['scope', true], ['claims', true]]);
    expect(checks.find((c) => c.id === 'scope')!.text).toBe('Medium risk · 1 file · 1 line');
  });

  it('G1: a Tier-1 source path in the self repo is protected, named in the text', () => {
    const checks = cloudPrDiffChecks({ repo: 'ashlrai/ashlr-hub', diff: diffOf({ 'src/core/fleet/merge-gates.ts': ['// x'] }), selfRepo: true, report: DONE, policy: null });
    expect(checks[0]).toEqual({ id: 'protected', ok: false, text: 'Protected: src/core/fleet/merge-gates.ts' });
  });

  it('G1: CI config is protected in every repo', () => {
    const checks = cloudPrDiffChecks({ repo: 'ashlrai/other', diff: diffOf({ '.github/workflows/ci.yml': ['on: push'] }), selfRepo: false, report: DONE, policy: null });
    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.text).toMatch(/^Protected: \.github\/workflows\/ci\.yml/);
  });

  it('G1b: an added .only is test tampering', () => {
    const checks = cloudPrDiffChecks({ repo: 'ashlrai/other', diff: diffOf({ 'test/thing.test.ts': ["it.only('x', () => {});"] }), selfRepo: false, report: DONE, policy: null });
    expect(checks.find((c) => c.id === 'tamper')).toEqual({ id: 'tamper', ok: false, text: 'Test tampering' });
  });

  it('G2: over the compiled file ceiling without a grant', () => {
    const files: Record<string, string[]> = {};
    for (let i = 0; i < 11; i += 1) files[`docs/page-${i}.md`] = ['text'];
    const scope = cloudPrDiffChecks({ repo: 'ashlrai/other', diff: diffOf(files), selfRepo: false, report: DONE, policy: null }).find((c) => c.id === 'scope')!;
    expect(scope.ok).toBe(false);
    // classifyRisk calls >10 files high risk before the file cap is reached.
    expect(scope.text).toBe('High risk');
  });

  it('G2: a grant tighter than the ceilings is the cap that applies', () => {
    const policy = ceilingPolicy('ashlrai/other', false);
    policy.repo.maxRisk = 'low';
    const scope = cloudPrDiffChecks({ repo: 'ashlrai/other', diff: small, selfRepo: false, report: DONE, policy }).find((c) => c.id === 'scope')!;
    expect(scope).toEqual({ id: 'scope', ok: false, text: 'Medium risk (cap low)' });
  });

  it('G4: a report of no change over a real diff is a mismatch; no report is not evidence either way', () => {
    const blocked: CloudTaskReport = { ...DONE, status: 'no-change' };
    expect(cloudPrDiffChecks({ repo: 'r/r', diff: small, selfRepo: false, report: blocked, policy: null }).find((c) => c.id === 'claims'))
      .toEqual({ id: 'claims', ok: false, text: "Report doesn't match diff" });
    expect(cloudPrDiffChecks({ repo: 'r/r', diff: small, selfRepo: false, report: null, policy: null }).find((c) => c.id === 'claims'))
      .toEqual({ id: 'claims', ok: true, text: 'No report' });
    expect(claimOfReport({ ...DONE, status: 'partial' })).toBe('claims-change');
    expect(claimOfReport({ ...DONE, status: 'blocked' })).toBe('reports-blocked');
  });

  it('an unreadable diff is never judged clean', () => {
    expect(cloudPrDiffChecks({ repo: 'r/r', diff: null, selfRepo: false, report: DONE, policy: null })).toEqual([{ id: 'protected', ok: false, text: 'Diff unavailable' }]);
  });
});

describe('GitHub checks and the verdict', () => {
  it('conflicts, behind, and checks each read in plain words', () => {
    expect(cloudPrGithubChecks(github({ mergeable: 'CONFLICTING', behindBy: 2, checks: 'red' }), 'master').map((c) => c.text))
      .toEqual(['Conflicts with master', '2 commits behind', 'Checks failing']);
    expect(cloudPrGithubChecks(github({ mergeable: 'UNKNOWN', behindBy: null, checks: 'none' }), 'master').map((c) => c.text))
      .toEqual(['GitHub still checking', 'Not compared with master', 'No checks reported']);
    expect(cloudPrGithubChecks(github(), 'master').every((c) => c.ok)).toBe(true);
  });

  it('clean: would auto-land, landable, with a one-line reason', () => {
    const p = preview();
    expect(p.wouldAutoLand).toBe(true);
    expect(p.landable).toEqual({ ok: true, reason: null });
    expect(p.reason).toBe('Clean: medium risk, 1 file, 1 line, checks green.');
    expect(p.itemId).toBe(cloudPrItemId(p.taskId));
    expect(p.behind).toBe(false);
  });

  it('held but landable when only behind; Update branch is offered', () => {
    const p = preview({ github: { behindBy: 3 } });
    expect(p.wouldAutoLand).toBe(false);
    expect(p.landable.ok).toBe(true);
    expect(p.behind).toBe(true);
    expect(p.reason).toBe('Held: 3 commits behind.');
  });

  it('Land is refused for a protected path, a conflict, an unknown mergeability and a closed PR', () => {
    const protectedChecks = cloudPrDiffChecks({ repo: 'ashlrai/ashlr-hub', diff: diffOf({ 'src/core/authority/ledger.ts': ['x'] }), selfRepo: true, report: DONE, policy: null });
    expect(landRefusal(github(), protectedChecks, 'master')).toBe('It touches a protected path (src/core/authority/ledger.ts); land it on GitHub after review.');
    const clean = cloudPrDiffChecks({ repo: 'r/r', diff: small, selfRepo: false, report: DONE, policy: null });
    expect(landRefusal(github({ mergeable: 'CONFLICTING' }), clean, 'master')).toBe('It conflicts with master.');
    expect(landRefusal(github({ mergeable: 'UNKNOWN' }), clean, 'master')).toMatch(/not finished checking/);
    expect(landRefusal(github({ state: 'MERGED' }), clean, 'master')).toBe('The pull request is already merged.');
    expect(landRefusal(github(), cloudPrDiffChecks({ repo: 'r/r', diff: null, selfRepo: false, report: DONE, policy: null }), 'master'))
      .toBe('Its diff could not be checked for protected paths.');
  });

  it('rolls GitHub checks up fail-closed', () => {
    expect(rollupChecks([])).toBe('none');
    expect(rollupChecks(null)).toBe('none');
    expect(rollupChecks([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }, { __typename: 'StatusContext', state: 'SUCCESS' }])).toBe('green');
    expect(rollupChecks([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' }, { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' }])).toBe('pending');
    expect(rollupChecks([{ __typename: 'CheckRun', status: 'IN_PROGRESS' }, { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }])).toBe('red');
    expect(rollupChecks([{ __typename: 'StatusContext', state: 'ERROR' }])).toBe('red');
    expect(rollupChecks(['garbage'])).toBe('pending');
  });

  it('never forwards gh stderr: it maps to a fixed sentence', () => {
    expect(ghRefusal('GraphQL: Head branch was modified. Review and try the merge again.', 'x')).toBe('The branch moved since it was checked. Review it again.');
    expect(ghRefusal('Pull request is not mergeable: the merge commit cannot be cleanly created.', 'x')).toMatch(/conflicts/);
    expect(ghRefusal('HTTP 401: Bad credentials (https://api.github.com/…) token ghp_abc', 'fallback')).toBe('gh is not signed in to GitHub on this machine.');
    expect(ghRefusal('/Users/someone/secret/path exploded', 'GitHub refused the merge.')).toBe('GitHub refused the merge.');
  });
});

describe('Needs-you items carry the verdict and the triage actions', () => {
  const t = task();

  it('without a preview: the 3.11 item, Dismiss only', () => {
    const [item] = cloudNeedsYouItems([t], NOW);
    expect(item!.actions.map((a) => a.kind)).toEqual(['done']);
    expect(item!.detail).toBe('Cloud session reports (unverified): Fixed it.');
  });

  it('clean: verdict first in the detail; Land, Close, Dismiss mapped onto approve, reject, done', () => {
    const p = preview();
    const [item] = cloudNeedsYouItems([t], NOW, new Map([[t.id, p]]));
    expect(isNeedsYouItem(item)).toBe(true);
    expect(item!.detail).toBe('Clean: medium risk, 1 file, 1 line, checks green. Cloud session reports (unverified): Fixed it.');
    expect(item!.actions.map((a) => [a.kind, a.label])).toEqual([['approve', 'Land'], ['reject', 'Close'], ['done', 'Dismiss']]);
    const land = item!.actions[0]!;
    expect(land.request).toEqual({ method: 'POST', path: `/api/verse/cloud/tasks/${t.id}/land`, body: { headSha: SHA } });
    expect(land.confirm!.title).toBe('Land #42 on master?');
    expect(land.confirm!.body).toContain(`Squash-merges exactly ${SHA.slice(0, 7)}`);
    expect(item!.actions[1]).toMatchObject({ destructive: true, request: { path: `/api/verse/cloud/tasks/${t.id}/close`, body: { headSha: SHA } } });
  });

  it('behind: Update branch (fix) appears; protected: no Land', () => {
    const behind = triageActions(t, preview({ github: { behindBy: 1 } }));
    expect(behind.map((a) => a.kind)).toEqual(['approve', 'reject', 'fix']);
    expect(behind[2]).toMatchObject({ label: 'Update branch', confirm: null, request: { path: `/api/verse/cloud/tasks/${t.id}/update-branch` } });
    const guarded = triageActions(t, preview({ diff: diffOf({ 'src/core/authority/ledger.ts': ['x'] }) }));
    expect(guarded.map((a) => a.kind)).toEqual(['reject']);
  });

  it('ignores a preview of a different PR number or a closed PR', () => {
    const other = { ...preview(), prNumber: 7 };
    expect(cloudNeedsYouItems([t], NOW, new Map([[t.id, other]]))[0]!.actions.map((a) => a.kind)).toEqual(['done']);
    const closed = preview({ github: { state: 'CLOSED' } });
    expect(cloudNeedsYouItems([t], NOW, new Map([[t.id, closed]]))[0]!.actions.map((a) => a.kind)).toEqual(['done']);
  });
});

describe('strict action body', () => {
  it('accepts exactly a 40-hex headSha', () => {
    expect(parseCloudPrActionBody({ headSha: SHA })).toEqual({ headSha: SHA });
    for (const bad of [{}, { headSha: 'abc' }, { headSha: SHA.toUpperCase() }, { headSha: SHA, force: true }]) {
      expect(() => parseCloudPrActionBody(bad)).toThrow(CloudInputError);
    }
  });
});

describe('self-improvement review backpressure', () => {
  function budget(self: Partial<CloudBudgetV1['selfImprove']> = {}): CloudBudgetV1 {
    return { ...DEFAULT_CLOUD_BUDGET, selfImprove: { ...DEFAULT_CLOUD_BUDGET.selfImprove, ...self }, updatedAt: NOW.toISOString() };
  }
  // Launched on an earlier day, so the daily self-improvement cap is not what refuses.
  const old = { createdAt: '2026-09-20T10:00:00.000Z', launchedAt: '2026-09-20T10:00:05.000Z' };
  const open = (n: number, over: Partial<CloudTaskV1> = {}) =>
    Array.from({ length: n }, (_, i) => task({ id: `ct_20260920T1000_open0${i}`, ...old, ...over }));

  it('defaults to 3', () => {
    expect(DEFAULT_CLOUD_BUDGET.selfImprove.maxOpenPrs).toBe(3);
  });

  it('refuses at 3 open self-improvement PRs, in plain words, and only self-improvement', () => {
    const view = cloudBudgetView(open(3), budget(), NOW);
    expect(view.canSelfImprove).toEqual({ ok: false, reason: '3 self-improvement PRs are waiting for review.' });
    expect(view.canLaunch.ok).toBe(true);
    expect(cloudBudgetView(open(2), budget(), NOW).canSelfImprove.ok).toBe(true);
    expect(cloudBudgetView(open(1), budget({ maxOpenPrs: 1 }), NOW).canSelfImprove.reason).toBe('1 self-improvement PR is waiting for review.');
  });

  it("counts only self-improvement tasks with an open PR (not the operator's, not merged ones)", () => {
    const tasks = [...open(2), ...open(2, { origin: 'operator', requestedBy: 'mason' }).map((t, i) => ({ ...t, id: `ct_20260920T1000_oper0${i}` })),
      task({ id: 'ct_20260920T1000_merged', ...old, state: 'merged' })];
    expect(cloudBudgetView(tasks, budget(), NOW).canSelfImprove.ok).toBe(true);
  });

  it('a budget written before 3.13 (no maxOpenPrs) gets the default', () => {
    const legacy = budget();
    delete (legacy.selfImprove as Partial<CloudBudgetV1['selfImprove']>).maxOpenPrs;
    expect(cloudBudgetView(open(3), legacy, NOW).canSelfImprove.ok).toBe(false);
  });

  it('the budget route and the CLI accept it strictly', () => {
    expect(parseCloudBudgetBody({ selfImprove: { maxOpenPrs: 5 } })).toEqual({ selfImprove: { maxOpenPrs: 5 } });
    expect(() => parseCloudBudgetBody({ selfImprove: { maxOpenPrs: 1.5 } })).toThrow(CloudInputError);
    expect(parseBudgetFlags(['--self-improve-max-open', '2', '--self-improve-max', '4'])).toEqual({ selfImprove: { maxOpenPrs: 2, maxPerDay: 4 } });
    expect(() => parseBudgetFlags(['--self-improve-max-open', '0'])).toThrow(/at least 1/);
  });
});
