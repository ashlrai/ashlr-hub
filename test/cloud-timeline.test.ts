/**
 * 3.13 — the cloud task evidence timeline (src/core/cloud/timeline.ts).
 *
 * Pure builder over every combination of present / missing / unreadable
 * sources, then the gatherer with injected sources (no real ~/.ashlr, no
 * real git, no ledger on disk): matching a merge record by PR number, branch
 * or task id; ledger rows filtered to the task's proposal; the merge commit
 * found in local git; `git tag --contains`; budgets and caching.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildCloudTimeline,
  clearCloudTimelineCaches,
  cloudTaskTimeline,
  gatherTimelineSources,
  githubNameFromRemote,
  type TimelineDeps,
  type TimelineSources,
} from '../src/core/cloud/timeline.js';
import { TIMELINE_STEP_ORDER, type TimelineStep } from '../src/core/cloud/timeline-types.js';
import type { CloudTaskV1 } from '../src/core/cloud/types.js';
import type { FleetMergeStateV1, FleetMergeStateRead } from '../src/core/fleet/fleet-merge-state.js';
import type { GateResult, LandingRecord } from '../src/core/fleet/fleet-types.js';
import type { PostMergeWatchView } from '../src/core/fleet/post-merge-watch.js';
import type { LedgerReadResult } from '../src/core/authority/types.js';
import type { GitRunner, GitRunResult } from '../src/core/verse/git-ops.js';

const ID = 'ct_20260925T1200_abc123';
const REPO = 'ashlrai/ashlr-hub';
const MERGE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const NOW = new Date('2026-09-26T12:00:00.000Z');

function task(over: Partial<CloudTaskV1> = {}): CloudTaskV1 {
  const id = over.id ?? ID;
  return {
    v: 1,
    id,
    repo: REPO,
    baseBranch: 'master',
    branch: `ashlr-cloud/${id}`,
    title: 'Fix the flaky tracker test',
    prompt: 'Fix the flaky tracker test in test/cloud-tracker.test.ts.',
    origin: 'operator',
    requestedBy: 'mason',
    seat: 'claude-a',
    sessionId: 'session_01abc',
    sessionUrl: 'https://claude.ai/code/session_01abc',
    state: 'running',
    stateReason: null,
    failure: null,
    createdAt: '2026-09-25T12:00:00.000Z',
    launchedAt: '2026-09-25T12:00:05.000Z',
    updatedAt: '2026-09-25T12:00:05.000Z',
    pr: null,
    report: null,
    estimatedCostUsd: 3,
    backlogItemId: null,
    needsYouId: null,
    ...over,
  };
}

const openPr = { number: 512, url: `https://github.com/${REPO}/pull/512`, state: 'open' as const, draft: true, title: '[ashlr-cloud] Fix the flaky tracker test' };
const mergedPr = { ...openPr, state: 'merged' as const, draft: false };
const report = { status: 'done' as const, summary: 'Fixed the race in the tracker test.', testsRun: ['npx vitest run test/cloud-tracker.test.ts'], risks: ['none'], filesChanged: 2 };

function landing(over: Partial<LandingRecord> = {}): LandingRecord {
  return {
    v: 1,
    id: `${REPO}#512@${MERGE_SHA.slice(0, 12)}`,
    kind: 'merge',
    repo: REPO,
    baseBranch: 'master',
    prNumber: 512,
    headSha: HEAD_SHA,
    mergeSha: MERGE_SHA,
    proposalId: 'prop-1',
    revertsLandingId: null,
    grantId: 'grant-1',
    rolloutStageId: 'stage-1',
    gatesDigest: 'd'.repeat(64),
    ledgerHead: 'e'.repeat(64),
    enforcement: 'server',
    risk: 'low',
    files: 3,
    linesAdded: 40,
    linesDeleted: 12,
    producer: null,
    judgeId: null,
    proposedAt: null,
    landedAt: '2026-09-25T14:00:00.000Z',
    watchUntil: '2026-09-25T16:00:00.000Z',
    ...over,
  } as LandingRecord;
}

function mergeRecord(over: Partial<FleetMergeStateV1> = {}): FleetMergeStateV1 {
  return {
    v: 1,
    key: 'prop-1',
    kind: 'change',
    proposalId: 'prop-1',
    revertsLandingId: null,
    repo: REPO,
    repoPath: '/mirror',
    enforcement: 'server',
    createdAt: '2026-09-25T12:30:00.000Z',
    updatedAt: '2026-09-25T14:00:00.000Z',
    gates: {},
    judgeWaitSince: null,
    baseBranch: 'master',
    baseSha: 'c'.repeat(40),
    treeSha: 'f'.repeat(40),
    diffHash: null,
    verifyDigest: null,
    risk: 'low',
    files: 3,
    linesAdded: 40,
    linesDeleted: 12,
    producer: null,
    judgeId: null,
    openGatesDigest: null,
    pr: {
      number: 512,
      nodeId: 'PR_x',
      repositoryId: 'R_x',
      branch: `ashlr-cloud/${ID}`,
      baseBranch: 'master',
      baseSha: 'c'.repeat(40),
      headSha: HEAD_SHA,
      treeSha: 'f'.repeat(40),
      ownerLane: false,
      ownerLaneReason: null,
      openedAt: '2026-09-25T13:00:00.000Z',
      ledgered: true,
      state: 'merged',
      closedBy: null,
      nextCheckAt: null,
      checkBackoffMs: 0,
      checks: { state: 'green', detail: '4 required checks passed.', at: '2026-09-25T13:40:00.000Z' },
      wouldMergeHeadSha: null,
    },
    merge: null,
    landing: landing(),
    landingLedgered: true,
    outcome: 'merged',
    outcomeReason: null,
    ...over,
  } as FleetMergeStateV1;
}

function gateRow(gate: GateResult['gate'], verdict: GateResult['verdict'], at: string, reason = 'ok'): GateResult & { rowAt: string } {
  return { v: 1, gate, proposalId: 'prop-1', repo: REPO, headSha: HEAD_SHA, verdict, code: 'code', reason, at, digest: '0'.repeat(64), rowAt: at };
}

function sources(over: Partial<TimelineSources> = {}): TimelineSources {
  return {
    task: task(),
    merge: { state: 'missing' },
    ledger: { state: 'ok', chain: 'empty', gates: [], landing: null, postMerge: null },
    watch: { state: 'ok', view: null },
    model: null,
    mergeCommit: null,
    release: null,
    ...over,
  };
}

function byKind(steps: TimelineStep[]): Record<string, TimelineStep> {
  return Object.fromEntries(steps.map((s) => [s.kind, s]));
}

afterEach(() => {
  clearCloudTimelineCaches();
});

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

describe('buildCloudTimeline — shape', () => {
  it('always emits every step, in the fixed order', () => {
    const t = buildCloudTimeline(sources(), NOW);
    expect(t.steps.map((s) => s.kind)).toEqual([...TIMELINE_STEP_ORDER]);
    expect(t).toMatchObject({ v: 1, taskId: ID, repo: REPO, state: 'running', generatedAt: NOW.toISOString() });
  });

  it('a running task with nothing downstream: objective and launch verified, the rest unknown and unreached', () => {
    const s = byKind(buildCloudTimeline(sources(), NOW).steps);
    expect(s.objective).toMatchObject({ verified: true, reached: true, at: '2026-09-25T12:00:00.000Z', source: 'cloud task record' });
    expect(s.objective!.detail).toContain('Fix the flaky tracker test in test/cloud-tracker.test.ts.');
    expect(s.objective!.detail).toContain('From New cloud task, requested by mason.');
    expect(s.launch).toMatchObject({ verified: true, reached: true, link: { href: 'https://claude.ai/code/session_01abc', label: 'Open session' } });
    for (const kind of ['pr', 'diff', 'checks', 'gates', 'release', 'health'] as const) {
      expect(s[kind]!.verified, kind).toBe('unknown');
      expect(s[kind]!.reached, kind).toBe(false);
    }
    expect(s.merge).toMatchObject({ reached: false });
  });

  it('model and account are unknown unless recorded; a recorded model is verified', () => {
    const none = byKind(buildCloudTimeline(sources(), NOW).steps).worker!;
    expect(none.verified).toBe('unknown');
    expect(none.detail).toContain('Model: unknown');
    expect(none.detail).toContain('Account: unknown');
    const known = byKind(buildCloudTimeline(sources({ model: 'claude-opus-5-5' }), NOW).steps).worker!;
    expect(known.verified).toBe(true);
    expect(known.detail).toContain('Model: claude-opus-5-5 (evidence pack)');
    expect(known.detail).toContain('Account: unknown');
  });

  it('the cost is always an estimate (verified false) with the real-balance link', () => {
    const cost = byKind(buildCloudTimeline(sources({ task: task({ estimatedCostUsd: 2.5 }) }), NOW).steps).cost!;
    expect(cost).toMatchObject({ verified: false, title: '$2.50 estimated', source: 'cloud budget estimate' });
    expect(cost.link?.href).toBe('https://claude.ai/settings/usage');
  });
});

describe('buildCloudTimeline — the session report is a claim', () => {
  it('is verified false even when everything else is verified', () => {
    const s = byKind(buildCloudTimeline(sources({
      task: task({ state: 'merged', pr: mergedPr, report }),
      merge: { state: 'ok', record: mergeRecord() },
    }), NOW).steps);
    expect(s.report).toMatchObject({ verified: false, title: 'Session reports “done” (unverified)' });
    expect(s.report!.detail).toContain('Tests it says it ran: npx vitest run test/cloud-tracker.test.ts.');
    expect(s.report!.source).toMatch(/claim/);
  });

  it('with no report: unknown, and the PR body is named as the place it was missing', () => {
    const s = byKind(buildCloudTimeline(sources({ task: task({ state: 'pr-open', pr: openPr }) }), NOW).steps);
    expect(s.report).toMatchObject({ verified: 'unknown', reached: true, title: 'No session report' });
  });

  it('a claimed diff size and claimed tests never become verified checks', () => {
    const s = byKind(buildCloudTimeline(sources({ task: task({ state: 'pr-open', pr: openPr, report }) }), NOW).steps);
    expect(s.diff).toMatchObject({ verified: false, title: '2 files changed (claimed)' });
    expect(s.checks).toMatchObject({ verified: 'unknown', title: 'No check run recorded' });
    expect(s.checks!.detail).toContain('are its own claim');
  });

  it('scrubs secrets out of report text', () => {
    const leaky = { ...report, summary: `Used sk-ant-${'x'.repeat(30)} to test.` };
    const s = byKind(buildCloudTimeline(sources({ task: task({ state: 'pr-open', pr: openPr, report: leaky }) }), NOW).steps);
    expect(s.report!.detail).not.toContain('x'.repeat(30));
  });
});

describe('buildCloudTimeline — a fully evidenced merge', () => {
  const full = sources({
    task: task({ state: 'merged', pr: mergedPr, report, deliveryPin: { number: 512, url: mergedPr.url } }),
    merge: { state: 'ok', record: mergeRecord() },
    ledger: {
      state: 'ok',
      chain: 'ok',
      gates: [gateRow('G0', 'wait', '2026-09-25T13:10:00.000Z'), gateRow('G0', 'pass', '2026-09-25T13:20:00.000Z'), gateRow('G1', 'pass', '2026-09-25T13:21:00.000Z')],
      landing: null,
      postMerge: null,
    },
    watch: { state: 'ok', view: { landingId: landing().id, repo: REPO, prNumber: 512, kind: 'merge', mergeSha: MERGE_SHA, phase: 'done', landedAt: '2026-09-25T14:00:00.000Z', watchUntil: '2026-09-25T16:00:00.000Z', ci: 'green', suite: 'pass', outcome: null, verdict: 'green', detail: 'CI green on aaaaaaa.', checkedAt: '2026-09-25T16:00:00.000Z' } as PostMergeWatchView },
    model: 'claude-opus-5-5',
    mergeCommit: { sha: MERGE_SHA, basis: 'landing' },
    release: { state: 'contained', latestTag: 'v3.13.0', firstTag: 'v3.12.1' },
  });

  it('every stage but the report and the cost is verified', () => {
    const steps = buildCloudTimeline(full, NOW).steps;
    for (const s of steps) {
      if (s.kind === 'report' || s.kind === 'cost') expect(s.verified, s.kind).toBe(false);
      else expect(s.verified, s.kind).toBe(true);
    }
  });

  it('links the PR, the merge commit and the release tag; uses the latest gate row per gate', () => {
    const s = byKind(buildCloudTimeline(full, NOW).steps);
    expect(s.pr).toMatchObject({ title: 'PR #512 merged', at: '2026-09-25T13:00:00.000Z', link: { href: mergedPr.url } });
    expect(s.diff).toMatchObject({ title: '3 files, +40 −12', source: 'fleet merge record' });
    expect(s.checks).toMatchObject({ title: 'Required checks passed', at: '2026-09-25T13:40:00.000Z' });
    expect(s.gates).toMatchObject({ title: 'Merge gates passed (2)', at: '2026-09-25T13:21:00.000Z', source: 'authority ledger (hash-chained)' });
    expect(s.gates!.detail).toBe('G0 pass · G1 pass.');
    expect(s.merge).toMatchObject({ title: 'Merged as aaaaaaa', at: '2026-09-25T14:00:00.000Z', link: { href: `https://github.com/${REPO}/commit/${MERGE_SHA}` } });
    expect(s.release).toMatchObject({ title: 'In the latest release, v3.13.0', detail: 'First released in v3.12.1.', link: { href: `https://github.com/${REPO}/releases/tag/v3.13.0` } });
    expect(s.health).toMatchObject({ title: 'Healthy after merge', at: '2026-09-25T16:00:00.000Z' });
  });

  it('a gate that stopped is named in the title with its reason', () => {
    const stopped = sources({
      task: task({ state: 'pr-open', pr: openPr }),
      ledger: { state: 'ok', chain: 'ok', gates: [gateRow('G0', 'pass', '2026-09-25T13:00:00.000Z'), gateRow('G6', 'wait', '2026-09-25T13:05:00.000Z', 'No different-family judge has headroom.')], landing: null, postMerge: null },
    });
    const s = byKind(buildCloudTimeline(stopped, NOW).steps);
    expect(s.gates!.title).toBe('Merge gates: G6 wait');
    expect(s.gates!.detail).toContain('No different-family judge has headroom.');
  });

  it('falls back to the merge record’s gate memos when the ledger has no rows', () => {
    const record = mergeRecord({ gates: { G0: { digest: 'x', verdict: 'pass', code: 'ok', headSha: HEAD_SHA, at: '2026-09-25T13:00:00.000Z' }, G7: { digest: 'y', verdict: 'owner-lane', code: 'protected-path', headSha: HEAD_SHA, at: '2026-09-25T13:01:00.000Z' } } });
    const s = byKind(buildCloudTimeline(sources({ task: task({ state: 'pr-open', pr: openPr }), merge: { state: 'ok', record } }), NOW).steps);
    expect(s.gates).toMatchObject({ verified: true, title: 'Merge gates: G7 owner-lane', source: 'fleet merge record (gate memos)' });
  });
});

describe('buildCloudTimeline — missing and unreadable evidence', () => {
  it('merged on GitHub without a landing: merge verified, commit from local git, release not yet', () => {
    const s = byKind(buildCloudTimeline(sources({
      task: task({ state: 'merged', pr: mergedPr }),
      mergeCommit: { sha: MERGE_SHA, basis: 'git' },
      release: { state: 'not-contained', latestTag: 'v3.12.0' },
    }), NOW).steps);
    expect(s.merge).toMatchObject({ verified: true, title: 'Merged as aaaaaaa', source: 'GitHub (cloud tracker) + local git' });
    expect(s.merge!.at).toBeNull();
    expect(s.release).toMatchObject({ verified: true, reached: false, title: 'Not in the latest release (v3.12.0) yet' });
    expect(s.health).toMatchObject({ verified: 'unknown', title: 'No post-merge watch recorded' });
  });

  it('merged with no merge commit anywhere: release unknown', () => {
    const s = byKind(buildCloudTimeline(sources({ task: task({ state: 'merged', pr: mergedPr }) }), NOW).steps);
    expect(s.merge).toMatchObject({ verified: true, title: 'Merged on GitHub' });
    expect(s.merge!.link).toBeUndefined();
    expect(s.release).toMatchObject({ verified: 'unknown', title: 'Release unknown' });
  });

  it('release lookup failures and repos without tags are unknown, with the reason', () => {
    const base = { task: task({ state: 'merged', pr: mergedPr }), mergeCommit: { sha: MERGE_SHA, basis: 'git' as const } };
    const noCheckout = byKind(buildCloudTimeline(sources({ ...base, release: { state: 'unknown', reason: 'No local mirror or checkout of ashlrai/ashlr-hub to read release tags from.' } }), NOW).steps);
    expect(noCheckout.release).toMatchObject({ verified: 'unknown', detail: 'No local mirror or checkout of ashlrai/ashlr-hub to read release tags from.' });
    const noTags = byKind(buildCloudTimeline(sources({ ...base, release: { state: 'no-tags' } }), NOW).steps);
    expect(noTags.release).toMatchObject({ verified: 'unknown', title: 'No release tags' });
  });

  it('a broken ledger and an unreadable merge record degrade to unknown with the reason', () => {
    const s = byKind(buildCloudTimeline(sources({
      task: task({ state: 'pr-open', pr: openPr }),
      merge: { state: 'unknown', reason: 'state is not JSON' },
      ledger: { state: 'unknown', reason: 'the ledger chain is broken at entry 7, so its rows are not trusted' },
      watch: { state: 'unknown', reason: 'post-merge watches unknown: corrupt' },
    }), NOW).steps);
    expect(s.diff).toMatchObject({ verified: 'unknown' });
    expect(s.diff!.detail).toContain('state is not JSON');
    expect(s.gates).toMatchObject({ verified: 'unknown', source: 'authority ledger (unreadable)' });
    expect(s.gates!.detail).toContain('broken at entry 7');
    expect(s.health!.detail).toContain('could not be read');
  });

  it('a delivery pin without a currently verified PR is unknown, still linked', () => {
    const s = byKind(buildCloudTimeline(sources({ task: task({ state: 'pr-open', pr: null, deliveryPin: { number: 512, url: openPr.url } }) }), NOW).steps);
    expect(s.pr).toMatchObject({ verified: 'unknown', reached: true, title: 'PR #512 (not currently verified)', link: { href: openPr.url } });
  });

  it('a PR that differs from the pinned one is not trusted', () => {
    const s = byKind(buildCloudTimeline(sources({ task: task({ state: 'pr-open', pr: openPr, deliveryPin: { number: 9, url: `https://github.com/${REPO}/pull/9` } }) }), NOW).steps);
    expect(s.pr!.verified).toBe('unknown');
  });

  it('a failed launch says so, verified from the task record, and nothing downstream is reached', () => {
    const s = byKind(buildCloudTimeline(sources({ task: task({ state: 'failed', sessionId: null, sessionUrl: null, failure: 'auth', stateReason: 'Not signed in to claude.ai.' }) }), NOW).steps);
    expect(s.launch).toMatchObject({ verified: true, title: 'Launch failed', detail: 'Not signed in to claude.ai.' });
    expect(s.worker!.reached).toBe(false);
    expect(s.pr!.reached).toBe(false);
  });

  it('a queued task is waiting, not failed', () => {
    const s = byKind(buildCloudTimeline(sources({ task: task({ state: 'queued', sessionId: null, sessionUrl: null, launchedAt: null }) }), NOW).steps);
    expect(s.launch).toMatchObject({ verified: true, reached: false, title: 'Waiting for a launch slot' });
    expect(s.cost!.at).toBe('2026-09-25T12:00:00.000Z');
  });

  it('a closed PR: closed without merging', () => {
    const s = byKind(buildCloudTimeline(sources({ task: task({ state: 'closed', pr: { ...openPr, state: 'closed', draft: false }, stateReason: 'Dismissed in Verse.' }) }), NOW).steps);
    expect(s.merge).toMatchObject({ verified: true, reached: true, title: 'Closed without merging', detail: 'Dismissed in Verse.' });
    expect(s.release!.reached).toBe(false);
  });

  it('health falls back to a ledger post-merge row; an unfinished watch is in progress', () => {
    const merged = { task: task({ state: 'merged', pr: mergedPr }) };
    const row = byKind(buildCloudTimeline(sources({ ...merged, ledger: { state: 'ok', chain: 'ok', gates: [], landing: landing(), postMerge: { v: 1, landingId: landing().id, repo: REPO, mergeSha: MERGE_SHA, ci: 'red', suite: 'fail', verdict: 'red', detail: 'CI test failed.', checkedAt: '2026-09-25T15:00:00.000Z' } } }), NOW).steps);
    expect(row.health).toMatchObject({ verified: true, title: 'Red after merge', source: 'authority ledger (post-merge result)' });
    expect(row.merge!.title).toBe('Merged as aaaaaaa');
    const watching = byKind(buildCloudTimeline(sources({ ...merged, watch: { state: 'ok', view: { landingId: 'l', repo: REPO, prNumber: 512, kind: 'merge', mergeSha: MERGE_SHA, phase: 'watching', landedAt: '2026-09-25T14:00:00.000Z', watchUntil: '2026-09-25T16:00:00.000Z', ci: null, suite: 'not-run', outcome: null, verdict: null, detail: null, checkedAt: null } as PostMergeWatchView } }), NOW).steps);
    expect(watching.health).toMatchObject({ verified: true, title: 'Post-merge watch in progress' });
  });

  it('never links a session or PR on a foreign host', () => {
    const s = byKind(buildCloudTimeline(sources({ task: task({ sessionUrl: 'https://evil.example/code/session_1', state: 'pr-open', pr: { ...openPr, url: 'http://github.com/x/y/pull/1' } }) }), NOW).steps);
    expect(s.launch!.link).toBeUndefined();
    expect(s.pr!.link).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Gathering
// ---------------------------------------------------------------------------

function ok(stdout: string): GitRunResult {
  return { code: 0, stdout, stderr: '', timedOut: false, truncated: false, missing: false };
}
function fail(stderr: string): GitRunResult {
  return { code: 128, stdout: '', stderr, timedOut: false, truncated: false, missing: false };
}

function fakeGit(answers: { mergeLog?: string; squashLog?: string; tags?: string; contains?: GitRunResult }): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitRunner = async (_bin, args) => {
    const a = args.slice(2); // drop `-c core.fsmonitor=false`
    calls.push([...a]);
    if (a[0] === 'log' && a.includes('--all-match')) return ok(answers.mergeLog ?? '');
    if (a[0] === 'log') return ok(answers.squashLog ?? '');
    if (a[0] === 'tag' && a[1] === '--list') return ok(answers.tags ?? '');
    if (a[0] === 'tag' && a[1] === '--contains') return answers.contains ?? ok('');
    return fail('unexpected');
  };
  return { git, calls };
}

function ledgerResult(entries: unknown[], chain: LedgerReadResult['chain'] = 'ok'): LedgerReadResult {
  return { entries: entries as LedgerReadResult['entries'], head: null, chain, brokenAtSeq: chain === 'broken' ? 7 : null, reason: null };
}

function deps(over: Partial<TimelineDeps> = {}): TimelineDeps {
  return {
    now: () => NOW,
    listMergeKeys: () => [],
    readMergeRecord: (): FleetMergeStateRead => ({ state: 'missing' }),
    readLedger: async () => ledgerResult([], 'empty'),
    listWatches: () => [],
    readEvidenceModel: () => null,
    git: fakeGit({}).git,
    checkoutFor: async () => null,
    ...over,
  };
}

describe('gatherTimelineSources', () => {
  it('finds the merge record by repo (any case) and PR number, and reads the model from its evidence pack', async () => {
    const record = mergeRecord({ repo: 'AshlrAI/Ashlr-Hub' });
    const other = mergeRecord({ key: 'prop-2', proposalId: 'prop-2', repo: 'ashlrai/other' });
    const readEvidenceModel = vi.fn((id: string) => (id === 'prop-1' ? 'grok-4.7' : null));
    const s = await gatherTimelineSources(task({ state: 'merged', pr: mergedPr }), deps({
      listMergeKeys: () => ['prop-2', 'prop-1'],
      readMergeRecord: (key) => ({ state: 'ok', record: key === 'prop-1' ? record : other }),
      readEvidenceModel,
    }));
    expect(s.merge).toMatchObject({ state: 'ok', record: { key: 'prop-1' } });
    expect(s.model).toBe('grok-4.7');
    expect(readEvidenceModel).toHaveBeenCalledWith('prop-1');
  });

  it('matches by task branch or task id when the PR number is unknown', async () => {
    const byBranch = mergeRecord({ landing: null });
    const s = await gatherTimelineSources(task({ state: 'running' }), deps({
      listMergeKeys: () => ['prop-1'],
      readMergeRecord: () => ({ state: 'ok', record: byBranch }),
    }));
    expect(s.merge.state).toBe('ok');
  });

  it('an unlistable merge directory is unknown, not missing', async () => {
    const s = await gatherTimelineSources(task(), deps({ listMergeKeys: () => null }));
    expect(s.merge).toEqual({ state: 'unknown', reason: 'the fleet merge records could not be listed' });
  });

  it('keeps only this task’s gate rows, and finds its landing and post-merge result in the ledger', async () => {
    const land = landing({ proposalId: null });
    const readLedger = vi.fn(async () => ledgerResult([
      { kind: 'gate:result', at: '2026-09-25T13:00:00.000Z', data: { ...gateRow('G0', 'pass', '2026-09-25T13:00:00.000Z'), proposalId: ID } },
      { kind: 'gate:result', at: '2026-09-25T13:00:01.000Z', data: { ...gateRow('G0', 'refuse', '2026-09-25T13:00:01.000Z'), proposalId: 'someone-else' } },
      { kind: 'gate:result', at: '2026-09-25T13:00:02.000Z', data: { ...gateRow('G1', 'pass', '2026-09-25T13:00:02.000Z'), proposalId: ID, repo: 'ashlrai/other' } },
      { kind: 'merge:landed', at: '2026-09-25T14:00:00.000Z', data: land },
      { kind: 'post-merge:result', at: '2026-09-25T16:00:00.000Z', data: { v: 1, landingId: land.id, repo: REPO, mergeSha: MERGE_SHA, ci: 'green', suite: 'pass', verdict: 'green', detail: 'ok', checkedAt: '2026-09-25T16:00:00.000Z' } },
    ]));
    const s = await gatherTimelineSources(task({ state: 'merged', pr: mergedPr }), deps({ readLedger }));
    expect(readLedger).toHaveBeenCalledWith({ kinds: ['gate:result', 'merge:landed', 'post-merge:result'], sinceAt: '2026-09-25T12:00:00.000Z' });
    expect(s.ledger.state).toBe('ok');
    if (s.ledger.state !== 'ok') return;
    expect(s.ledger.gates.map((g) => `${g.gate}:${g.verdict}`)).toEqual(['G0:pass']);
    expect(s.ledger.landing?.mergeSha).toBe(MERGE_SHA);
    expect(s.ledger.postMerge?.verdict).toBe('green');
    expect(s.mergeCommit).toEqual({ sha: MERGE_SHA, basis: 'landing' });
  });

  it('a broken ledger chain is unknown; a slow ledger read is cut off at its budget', async () => {
    const broken = await gatherTimelineSources(task(), deps({ readLedger: async () => ledgerResult([], 'broken') }));
    expect(broken.ledger).toMatchObject({ state: 'unknown' });
    const slow = await gatherTimelineSources(task(), deps({ ledgerBudgetMs: 20, readLedger: () => new Promise(() => {}) }));
    expect(slow.ledger).toMatchObject({ state: 'unknown', reason: 'the read took longer than 20 ms' });
  });

  it('finds the merge commit by its merge message, then asks git tag --contains', async () => {
    const { git, calls } = fakeGit({ mergeLog: `${MERGE_SHA}\n`, tags: 'v3.13.0\nv3.12.1\nnightly\n', contains: ok('v3.12.1\nv3.13.0\n') });
    const s = await gatherTimelineSources(task({ state: 'merged', pr: mergedPr }), deps({ git, checkoutFor: async () => '/checkout' }));
    expect(s.mergeCommit).toEqual({ sha: MERGE_SHA, basis: 'git' });
    expect(s.release).toEqual({ state: 'contained', latestTag: 'v3.13.0', firstTag: 'v3.12.1' });
    expect(calls[0]).toEqual(expect.arrayContaining(['--grep=Merge pull request #512 from ', `--grep=ashlr-cloud/${ID}`]));
    expect(calls.find((c) => c[0] === 'tag' && c[1] === '--contains')).toEqual(['tag', '--contains', MERGE_SHA, '--sort=v:refname']);
  });

  it('falls back to a squash subject ending (#N), skipping reverts', async () => {
    const other = 'c'.repeat(40);
    const { git } = fakeGit({ squashLog: `${other}\tRevert "Fix (#512)"\n${MERGE_SHA}\tFix the flaky tracker test (#512)\n`, tags: 'v3.13.0\n', contains: ok('') });
    const s = await gatherTimelineSources(task({ state: 'merged', pr: mergedPr }), deps({ git, checkoutFor: async () => '/checkout' }));
    expect(s.mergeCommit).toEqual({ sha: MERGE_SHA, basis: 'git' });
    expect(s.release).toEqual({ state: 'not-contained', latestTag: 'v3.13.0' });
  });

  it('a commit the checkout does not have is unknown; no checkout at all is unknown; no tags is no-tags', async () => {
    const missing = fakeGit({ tags: 'v1.0.0\n', contains: fail('error: malformed object name') });
    const withLanding = { state: 'ok' as const, record: mergeRecord() };
    const a = await gatherTimelineSources(task({ state: 'merged', pr: mergedPr }), deps({ git: missing.git, checkoutFor: async () => '/c', listMergeKeys: () => ['prop-1'], readMergeRecord: () => withLanding }));
    expect(a.release).toMatchObject({ state: 'unknown', reason: 'Commit aaaaaaa is not in the local checkout (it may need a fetch).' });
    clearCloudTimelineCaches();
    const b = await gatherTimelineSources(task({ state: 'merged', pr: mergedPr }), deps({ listMergeKeys: () => ['prop-1'], readMergeRecord: () => withLanding }));
    expect(b.release).toMatchObject({ state: 'unknown' });
    expect(b.mergeCommit).toEqual({ sha: MERGE_SHA, basis: 'landing' });
    clearCloudTimelineCaches();
    const c = await gatherTimelineSources(task({ state: 'merged', pr: mergedPr }), deps({ git: fakeGit({ tags: 'main-snapshot\n' }).git, checkoutFor: async () => '/c', listMergeKeys: () => ['prop-1'], readMergeRecord: () => withLanding }));
    expect(c.release).toEqual({ state: 'no-tags' });
  });

  it('all git work shares one budget; a recorded landing still names the merge commit when git is slow', async () => {
    const withLanding = { state: 'ok' as const, record: mergeRecord() };
    const s = await gatherTimelineSources(task({ state: 'merged', pr: mergedPr }), deps({
      gitBudgetMs: 20,
      checkoutFor: () => new Promise(() => {}),
      listMergeKeys: () => ['prop-1'],
      readMergeRecord: () => withLanding,
    }));
    expect(s.mergeCommit).toEqual({ sha: MERGE_SHA, basis: 'landing' });
    expect(s.release).toEqual({ state: 'unknown', reason: 'Local git took longer than 20 ms.' });
    const health = byKind(buildCloudTimeline(s, NOW).steps).health!;
    expect(health.detail).toBe('The fleet landed this merge, but no post-merge verdict is recorded yet.');
  });

  it('does not touch git for a task that has not merged', async () => {
    const checkoutFor = vi.fn(async () => '/c');
    const s = await gatherTimelineSources(task({ state: 'pr-open', pr: openPr }), deps({ checkoutFor }));
    expect(checkoutFor).not.toHaveBeenCalled();
    expect(s.release).toBeNull();
  });

  it('matches the post-merge watch by merge SHA, else by PR number; a corrupt store is unknown', async () => {
    const view = { landingId: 'x', repo: REPO, prNumber: 512, kind: 'merge', mergeSha: 'f'.repeat(40), phase: 'done', verdict: 'green' } as PostMergeWatchView;
    const s = await gatherTimelineSources(task({ state: 'merged', pr: mergedPr }), deps({ listWatches: () => [view] }));
    expect(s.watch).toEqual({ state: 'ok', view });
    const bad = await gatherTimelineSources(task(), deps({ listWatches: () => { throw new Error('post-merge watches unknown: corrupt'); } }));
    expect(bad.watch).toEqual({ state: 'unknown', reason: 'post-merge watches unknown: corrupt' });
  });
});

describe('cloudTaskTimeline', () => {
  it('null for an invalid id or a missing task', async () => {
    expect(await cloudTaskTimeline('../etc/passwd', deps({ readTask: () => task() }))).toBeNull();
    expect(await cloudTaskTimeline(ID, deps({ readTask: () => null }))).toBeNull();
  });

  it('caches per task revision and shares one gather between concurrent calls', async () => {
    const readLedger = vi.fn(async () => ledgerResult([], 'empty'));
    let current = task();
    const d = deps({ readTask: () => current, readLedger });
    const [a, b] = await Promise.all([cloudTaskTimeline(ID, d), cloudTaskTimeline(ID, d)]);
    expect(a).toBe(b);
    await cloudTaskTimeline(ID, d);
    expect(readLedger).toHaveBeenCalledTimes(1);
    current = task({ updatedAt: '2026-09-25T13:00:00.000Z', state: 'pr-open', pr: openPr });
    const c = await cloudTaskTimeline(ID, d);
    expect(readLedger).toHaveBeenCalledTimes(2);
    expect(c?.state).toBe('pr-open');
  });
});

describe('githubNameFromRemote', () => {
  it.each([
    ['https://github.com/AshlrAI/ashlr-hub.git', 'ashlrai/ashlr-hub'],
    ['git@github.com:ashlrai/ashlr-hub.git', 'ashlrai/ashlr-hub'],
    ['ssh://git@github.com/ashlrai/ashlr-hub', 'ashlrai/ashlr-hub'],
    ['https://gitlab.com/ashlrai/ashlr-hub.git', null],
    ['https://github.com/ashlrai/ashlr-hub/extra', null],
  ])('%s → %s', (url, want) => {
    expect(githubNameFromRemote(url)).toBe(want);
  });
});
