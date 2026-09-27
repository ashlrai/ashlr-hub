/**
 * 3.15 retros — deterministic extraction for every way a task ends
 * (learn/retro/extract.ts). Pure: no I/O, no clock, no model.
 */
import { describe, expect, it } from 'vitest';

import {
  diffPaths,
  pathGlobsFor,
  retroFromCloud,
  retroFromFleet,
  retroFromLeader,
  type CloudEndInput,
  type FleetEndInput,
} from '../src/core/learn/retro/extract.js';
import { retroIdFor } from '../src/core/learn/retro/store.js';

const AT = '2026-09-20T10:00:00.000Z';
const NOW = '2026-09-27T12:00:00.000Z';

function fleet(over: Partial<FleetEndInput>): FleetEndInput {
  return {
    proposalId: 'p-1',
    repo: 'ashlrai/widget',
    endKind: 'gate-refused',
    endedAt: AT,
    title: 'Fix flaky parser test',
    summary: 'The parser test fails on CRLF input.',
    paths: ['src/parser/lex.ts', 'src/parser/lex.test.ts'],
    ...over,
  };
}

function cloud(over: Partial<CloudEndInput>): CloudEndInput {
  return {
    taskId: 'ct_20260920T1000_abcdef',
    repo: 'ashlrai/widget',
    state: 'closed',
    endedAt: AT,
    title: 'Add retry to the uploader',
    prompt: 'Add exponential retry to the uploader.',
    stateReason: 'Closed in Verse without landing.',
    failure: null,
    report: null,
    origin: 'operator',
    ...over,
  };
}

describe('fleet ends', () => {
  it('merged: a success retro with no root cause and no candidates', () => {
    const r = retroFromFleet(fleet({ endKind: 'merged', engine: 'grok-cli' }), NOW);
    expect(r).toMatchObject({ source: 'fleet', endKind: 'merged', rootCause: null, candidates: [], betterPrompt: null, taskKind: 'fix' });
    expect(r.happened).toContain('grok-cli');
    expect(r.id).toBe(retroIdFor('fleet:p-1:merged'));
  });

  it('gate-refused: reads the gate memo into a stable cause, advice, better prompt and a scoped candidate', () => {
    const r = retroFromFleet(fleet({ gate: { gate: 'G2', code: 'files-over-cap', reason: 'the diff touches 14 files (cap 8)' } }), NOW);
    expect(r.rootCause).toMatchObject({ code: 'gate:files-over-cap', label: 'Diff too large', evidence: 'gate G2 memo' });
    expect(r.rootCause!.detail).toContain('14 files');
    expect(r.doDifferently[0]).toMatch(/fewer files/);
    expect(r.betterPrompt).toContain('Fix flaky parser test');
    expect(r.betterPrompt).toContain('Constraints learned from the last attempt');
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.scope).toEqual({ repo: 'ashlrai/widget', pathGlobs: ['src/parser/**'], taskKinds: ['fix'] });
  });

  it('owner-laned on a protected path: cause is protected-path and the note is not kind-scoped', () => {
    const r = retroFromFleet(fleet({
      endKind: 'owner-laned',
      paths: ['.github/workflows/ci.yml'],
      gate: { gate: 'G1', code: 'protected-ci-config', reason: 'touches protected path .github/workflows/ci.yml (ci-config): CI decides merges' },
    }), NOW);
    expect(r.endKind).toBe('owner-laned');
    expect(r.rootCause!.code).toBe('gate:protected-path');
    expect(r.candidates[0]!.text).toMatch(/protected paths/);
    expect(r.candidates[0]!.scope.taskKinds).toEqual([]);
    expect(r.candidates[0]!.scope.pathGlobs).toEqual(['.github/workflows/**']);
  });

  it('verify-failed: classifies by the failed command kind and names the command to run', () => {
    const r = retroFromFleet(fleet({
      endKind: 'verify-failed',
      gate: { gate: 'G3', code: 'verify-failed', reason: 'verification failed: typecheck' },
      verify: { passed: false, failed: ['typecheck'], failureCategory: 'code', detail: 'TS2345 in src/parser/lex.ts', ran: [{ kind: 'typecheck', cmd: ['npx', 'tsc', '--noEmit'] }, { kind: 'test', cmd: ['npx', 'vitest', 'run'] }] },
    }), NOW);
    expect(r.rootCause).toMatchObject({ code: 'verify:typecheck', label: 'Typecheck failed', evidence: 'verify output' });
    expect(r.candidates[0]!.text).toContain('npx tsc --noEmit');
    expect(r.betterPrompt).toContain('npx tsc --noEmit');
    expect(r.sourceKey).toBe('fleet:p-1:verify-failed');
  });

  it('verify infra failures are recorded but never taught', () => {
    const r = retroFromFleet(fleet({ endKind: 'verify-failed', verify: { passed: false, failureCategory: 'tool', detail: 'spawn ENOENT' } }), NOW);
    expect(r.rootCause!.code).toBe('verify:tool');
    expect(r.candidates).toEqual([]);
  });

  it('infra gate codes produce no candidates', () => {
    const r = retroFromFleet(fleet({ endKind: 'owner-laned', gate: { gate: 'G7', code: 'no-required-checks', reason: 'the default branch has no required checks' } }), NOW);
    expect(r.rootCause!.label).toBe('Repo has no required checks');
    expect(r.candidates).toEqual([]);
  });

  it('reverted: post-merge detail is the root cause; the lesson is to run the full suite', () => {
    const r = retroFromFleet(fleet({ endKind: 'reverted', postMerge: { ci: 'green', suite: 'fail', detail: 'suite failed at 3f2a9c1: 2 tests' } }), NOW);
    expect(r.rootCause).toMatchObject({ code: 'revert:suite-failed', evidence: 'post-merge watch' });
    expect(r.candidates[0]!.text).toMatch(/full suite/);
    const ci = retroFromFleet(fleet({ endKind: 'reverted', postMerge: { ci: 'red', suite: 'not-run', detail: 'CI `test` failed' } }), NOW);
    expect(ci.rootCause!.code).toBe('revert:ci-red');
  });

  it('closed by Mason with a reason: the reason becomes a candidate; a generic close does not', () => {
    const r = retroFromFleet(fleet({ endKind: 'closed', close: { reason: 'Wrong approach: use the existing retry helper', actor: 'mason' } }), NOW);
    expect(r.rootCause!.code).toBe('closed:by-mason');
    expect(r.candidates[0]!.text).toContain('use the existing retry helper');
    const generic = retroFromFleet(fleet({ endKind: 'closed', close: { reason: 'Closed on GitHub.', actor: 'mason' } }), NOW);
    expect(generic.candidates).toEqual([]);
    const ttl = retroFromFleet(fleet({ endKind: 'closed', close: { reason: 'auto-rejected: owner-lane proposal unreviewed for 7 days (TTL)', actor: 'daemon' } }), NOW);
    expect(ttl.rootCause!.code).toBe('closed:owner-lane-ttl');
    expect(ttl.candidates).toEqual([]);
  });

  it('scrubs secrets and home paths out of every text field', () => {
    const r = retroFromFleet(fleet({
      endKind: 'closed',
      close: { reason: 'leaked ghp_abcdefghijklmnopqrstuvwxyz0123456789 in /Users/mason/secret/x.ts', actor: 'mason' },
    }), NOW);
    const all = JSON.stringify(r);
    expect(all).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(all).not.toContain('/Users/mason');
  });
});

describe('cloud ends', () => {
  it('merged: success', () => {
    const r = retroFromCloud(cloud({ state: 'merged', report: { status: 'done', summary: 'Added retry.', testsRun: [], risks: [] } }), NOW);
    expect(r).toMatchObject({ source: 'cloud', endKind: 'merged', rootCause: null, candidates: [] });
  });

  it('closed with a blocked report: the report summary is the cause and the lesson', () => {
    const r = retroFromCloud(cloud({ report: { status: 'blocked', summary: 'The uploader has no test harness; could not verify.', testsRun: [], risks: ['No tests'] } }), NOW);
    expect(r.rootCause).toMatchObject({ code: 'cloud:blocked', evidence: 'PR report' });
    expect(r.candidates[0]!.text).toContain('no test harness');
    expect(r.doDifferently.some((d) => d.includes('No tests'))).toBe(true);
  });

  it('closed with the fixed Verse reason and no report: recorded, nothing taught', () => {
    const r = retroFromCloud(cloud({}), NOW);
    expect(r.rootCause!.code).toBe('closed:unreviewed');
    expect(r.candidates).toEqual([]);
  });

  it('closed with an operator-written reason: taught', () => {
    const r = retroFromCloud(cloud({ stateReason: 'Duplicates the retry work already on main.' }), NOW);
    expect(r.rootCause!.code).toBe('closed:by-mason');
    expect(r.candidates).toHaveLength(1);
  });

  it('failed launch: the failure code is the cause; infra failures are not taught', () => {
    const auth = retroFromCloud(cloud({ state: 'failed', failure: 'auth', stateReason: 'Not signed in' }), NOW);
    expect(auth.rootCause!.code).toBe('cloud:auth');
    expect(auth.candidates).toEqual([]);
    const remote = retroFromCloud(cloud({ state: 'failed', failure: 'no-remote', stateReason: 'Branch not pushed' }), NOW);
    expect(remote.candidates).toHaveLength(1);
  });

  it('expired: no PR delivered', () => {
    const r = retroFromCloud(cloud({ state: 'expired' }), NOW);
    expect(r.rootCause!.code).toBe('cloud:no-pr');
    expect(r.betterPrompt).toContain('Open the draft pull request early');
  });
});

describe('3.15: Mason’s close reason and the Devin lane', () => {
  it('`Closed in Verse: <reason>` is closed:by-mason with the reason itself as the lesson', () => {
    const r = retroFromCloud(cloud({ stateReason: 'Closed in Verse: Duplicates the retry already on main.' }), NOW);
    expect(r.rootCause).toMatchObject({ code: 'closed:by-mason', detail: 'Duplicates the retry already on main.', evidence: 'Mason’s close reason' });
    expect(r.doDifferently[0]).toBe('Address the close reason before retrying: Duplicates the retry already on main.');
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.text).toBe('Mason closed a cloud feature change in ashlrai/widget without landing: Duplicates the retry already on main.');
    expect(r.betterPrompt).toContain('Mason closed the last attempt because: Duplicates the retry already on main.');
  });

  it('Mason’s reason outranks a blocked report (the one human judgement about the attempt)', () => {
    const r = retroFromCloud(cloud({
      stateReason: 'Closed in Verse: wrong module, the uploader lives in src/io',
      report: { status: 'blocked', summary: 'No harness.', testsRun: [], risks: [] },
    }), NOW);
    expect(r.rootCause).toMatchObject({ code: 'closed:by-mason', detail: 'wrong module, the uploader lives in src/io' });
  });

  it('a Devin end has its own key, its own words and its own failure codes; source stays cloud', () => {
    const closed = retroFromCloud(cloud({ taskId: 'dv_20260920T1000_abcdef', lane: 'devin', stateReason: 'Closed in Verse: too broad' }), NOW);
    expect(closed).toMatchObject({ source: 'cloud', sourceKey: 'devin:dv_20260920T1000_abcdef:closed', id: retroIdFor('devin:dv_20260920T1000_abcdef:closed') });
    expect(closed.candidates[0]!.text).toMatch(/^Mason closed a Devin /);
    const failed = retroFromCloud(cloud({ taskId: 'dv_20260920T1000_abcdef', lane: 'devin', state: 'failed', failure: 'session-error', stateReason: null }), NOW);
    expect(failed.rootCause).toMatchObject({ code: 'devin:session-error', label: 'Devin session errored' });
    expect(failed.happened).toMatch(/^The Devin launch failed/);
    expect(failed.candidates).toEqual([]);
    const expired = retroFromCloud(cloud({ taskId: 'dv_20260920T1000_abcdef', lane: 'devin', state: 'expired' }), NOW);
    expect(expired.rootCause!.code).toBe('devin:no-pr');
    const blocked = retroFromCloud(cloud({ taskId: 'dv_20260920T1000_abcdef', lane: 'devin', report: { status: 'partial', summary: 'Half done.', testsRun: [], risks: [] } }), NOW);
    expect(blocked.rootCause!.code).toBe('devin:partial');
    expect(blocked.candidates[0]!.text).toMatch(/^Devin /);
    // An unknown Devin code falls back to the Devin lane's own unknown, never the cloud table.
    expect(retroFromCloud(cloud({ lane: 'devin', state: 'failed', failure: 'seat-unavailable' }), NOW).rootCause!.label).toBe('Devin launch failed');
  });
});

describe('leader ends', () => {
  it('vetoed: the veto note is the cause; no candidates (the playbook delta already carries it)', () => {
    const r = retroFromLeader({
      actionId: 'la-1', kind: 'goal.pause', status: 'vetoed', summary: 'Pause goal Router cleanup', why: 'low value',
      endedAt: AT, note: 'Router cleanup unblocks the cost work', statusReason: null, repo: null,
    }, NOW);
    expect(r).toMatchObject({ source: 'leader', endKind: 'vetoed', taskKind: 'leader', candidates: [] });
    expect(r.rootCause!.code).toBe('leader:vetoed:goal.pause');
    expect(r.doDifferently[0]).toContain('unblocks the cost work');
  });

  it('refused: outside the grant', () => {
    const r = retroFromLeader({
      actionId: 'la-2', kind: 'lane.set', status: 'refused', summary: 'Open 4 Grok lanes', why: 'throughput',
      endedAt: AT, note: null, statusReason: 'exceeds the grant', repo: null,
    }, NOW);
    expect(r.endKind).toBe('gate-refused');
    expect(r.rootCause!.label).toBe('Outside the grant');
  });
});

describe('helpers', () => {
  it('pathGlobsFor groups by directory, most common first, bounded', () => {
    expect(pathGlobsFor(['src/a/b/c.ts', 'src/a/b/d.ts', 'README.md', 'test/x.test.ts'])).toEqual(['src/a/b/**', 'README.md', 'test/**']);
    expect(pathGlobsFor(['../escape.ts'])).toEqual([]);
  });

  it('diffPaths reads unified diff headers', () => {
    const diff = 'diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n--- /dev/null\n+++ b/src/new.ts\n';
    expect(diffPaths(diff).sort()).toEqual(['src/new.ts', 'src/x.ts']);
  });
});
