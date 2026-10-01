/**
 * 3.15 — the Leader reads back what it was only ever writing: the veto
 * playbook deltas (vision/playbook.ts, written by leader-apply's veto path)
 * and Mason's approved knowledge, as one more UNTRUSTED evidence block.
 * A Leader with no lessons keeps a byte-identical evidence digest.
 * HOME is isolated by test/setup/home.ts; no model is called.
 */
import { readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { leaderLessons } from '../src/core/learn/retro/inject.js';
import { buildLeaderPrompt, evidenceDigest, gatherLeaderEvidence, gatherTriggerSignals, leaderRunDue, type LeaderEvidenceSources, type LeaderRunState } from '../src/core/vision/leader.js';
import { buildExecutionFeedback } from '../src/core/fleet/execution-feedback.js';
import { materializeDispatchProductionAttemptEnvelope, type DispatchProductionEventsReadResult } from '../src/core/fleet/dispatch-production-ledger.js';
import { addDelta } from '../src/core/vision/playbook.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';

const T0 = Date.parse('2026-09-24T09:00:00.000Z');
const STATE: LeaderRunState = { v: 1, lastRun: null, runDays: {}, lastEvidenceDigest: null, lastDeepRunAt: null, lastMemoAt: null, baselines: {}, outcomes: [] };

function sources(extra: Partial<LeaderEvidenceSources> = {}): LeaderEvidenceSources {
  return {
    standingPolicy: () => null,
    budgetPolicy: () => defaultBudgetPolicy(),
    capacity: () => ({ publishedAt: new Date(T0).toISOString(), seats: [] }),
    goals: () => ({ goals: [], complete: true }),
    readLedger: async () => ({ entries: [], head: null, chain: 'empty', brokenAtSeq: null, reason: null }) as never,
    holds: () => [],
    quality7d: () => ({ proposalsCreated: 0, merged: 0, rejected: 0, pending: 0, emptyRate: 0, acceptRate: 0, verifyPassRate: 0 }),
    models: () => [],
    reasoning: async () => ({ generatedAt: 'x', window: { from: 'a', to: 'b' }, totals: { steps: 0, sessions: 0, byEngine: {} }, insights: [], trends: [] }),
    ...extra,
  };
}

beforeEach(() => {
  rmSync(join(homedir(), '.ashlr'), { recursive: true, force: true });
});

describe('Leader lessons evidence', () => {
  it('no lessons ⇒ no block and an unchanged digest', async () => {
    const without = await gatherLeaderEvidence(sources(), T0, STATE);
    const withSource = await gatherLeaderEvidence(sources({ lessons: () => leaderLessons() }), T0, STATE);
    expect(withSource.lessons).toBeUndefined();
    expect(evidenceDigest(withSource)).toBe(evidenceDigest(without));
    expect(buildLeaderPrompt(withSource, { dryRun: true, nowIso: new Date(T0).toISOString() })).not.toContain('LESSONS');
  });

  it('veto deltas are read back into the prompt as untrusted data and change the digest', async () => {
    const before = await gatherLeaderEvidence(sources({ lessons: () => leaderLessons() }), T0, STATE);
    addDelta('strategy', 'Mason vetoed the Leader\'s "Pause goal Router cleanup" (goal.pause): it unblocks cost. Weigh this before proposing similar moves.');
    const after = await gatherLeaderEvidence(sources({ lessons: () => leaderLessons() }), T0, STATE);
    expect(after.lessons!.vetoes).toEqual([{ text: expect.stringContaining('Pause goal Router cleanup'), repeats: 1 }]);
    expect(evidenceDigest(after)).not.toBe(evidenceDigest(before));
    const prompt = buildLeaderPrompt(after, { dryRun: true, nowIso: new Date(T0).toISOString() });
    const block = /=== BEGIN UNTRUSTED DATA: LESSONS[^\n]*===\n([^\n]*)\n=== END UNTRUSTED DATA: LESSONS/.exec(prompt);
    expect(block).not.toBeNull();
    expect(block![1]).toContain('Pause goal Router cleanup');
    const outside = prompt.replace(/=== BEGIN UNTRUSTED DATA[\s\S]*?=== END UNTRUSTED DATA: [^\n]*===/g, '');
    expect(outside).not.toContain('Router cleanup');
  });

  it('a failing lessons source is reported as unknown, never as "no lessons"', async () => {
    const e = await gatherLeaderEvidence(sources({ lessons: () => { throw new Error('x'); } }), T0, STATE);
    expect(e.unknown).toContain('lessons');
  });

  it('the veto path still writes the prefix the read-back matches', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'core', 'vision', 'leader-apply.ts'), 'utf8');
    expect(src).toContain('deps.addPlaybookDelta(`Mason vetoed the Leader\'s');
    expect(src).toContain("addPlaybookDelta: (text) => playbook.addDelta('strategy', text)");
  });
});

describe('recorded execution metadata in existing Leader cadence', () => {
  const now = Date.parse('2026-10-01T14:00:00.000Z');
  function feedback(extra: Partial<DispatchProductionEventsReadResult> = {}) {
    const event = materializeDispatchProductionAttemptEnvelope({ schemaVersion: 1, ts: new Date(now - 1000).toISOString(),
      attemptId: 'attempt-00000000-0000-4000-8000-000000000001', runId: 'private-run',
      itemId: 'private-item', source: 'backlog', repo: '/private/repo', title: 'private prompt', backend: 'codex', tier: 'frontier',
      assignedBy: 'daemon', routeReason: 'private account reason', outcome: 'engine-failed', proposalCreated: false,
      spentUsd: 0, basis: 'run-proposal-outcome', reason: 'secret error',
    });
    return buildExecutionFeedback({ events: [event], sourceState: 'healthy', sourcePresent: true, complete: true, stopReasons: [],
      filesRead: 1, datedFilesRead: 1, looseFilesRead: 0, bytesRead: 100, rowsScanned: 1, invalidRows: 0, unreadableFiles: 0, ...extra },
    { nowMs: now, sinceMs: now - 86_400_000, proposals: { proposals: [], sourceState: 'missing', complete: true } });
  }
  const state: LeaderRunState = { ...STATE, lastRun: { at: new Date(now - 10_000).toISOString(), outcome: 'skipped-unchanged', reason: null, memoId: null, trigger: 'schedule' } };
  it('adds safe untrusted aggregate metadata without attempts, run IDs, prompt, account, or errors', async () => {
    const evidence = await gatherLeaderEvidence(sources({ executionFeedback: () => feedback() }), now, state);
    expect(evidence.executionFeedback?.counts?.failed).toBe(1);
    const prompt = buildLeaderPrompt(evidence, { dryRun: true, nowIso: new Date(now).toISOString() });
    expect(prompt).toContain('RECORDED EXECUTION OUTCOMES');
    expect(prompt).toContain('producer success is not verification or merge');
    expect(JSON.stringify(evidence.executionFeedback)).not.toMatch(/private|secret|attempt-|caseId/);
    const again = await gatherLeaderEvidence(sources({ executionFeedback: () => feedback() }), now + 1000, state);
    expect(evidenceDigest(again)).toBe(evidenceDigest(evidence));
  });
  it('partial and throwing metadata remains unknown without a false zero', async () => {
    const partial = await gatherLeaderEvidence(sources({ executionFeedback: () => feedback({ complete: false }) }), now, state);
    expect(partial.executionFeedback?.counts).toBeNull();
    expect(partial.unknown).toContain('execution-feedback-partial');
    const unavailable = await gatherLeaderEvidence(sources({ executionFeedback: () => { throw new Error('private error'); } }), now, state);
    expect(unavailable.executionFeedback).toBeUndefined();
    expect(unavailable.unknown).toContain('execution-feedback');
  });
  it('uses existing insight trigger while preserving daily caps and last-run coalescing', async () => {
    const signals = await gatherTriggerSignals(sources({ executionFeedback: () => feedback() }), state, now);
    expect(signals.executionFailuresSinceLastRun).toBe(1);
    expect(leaderRunDue(now, state, signals)).toMatchObject({ due: true, trigger: 'insight' });
    const capped = { ...state, runDays: { '2026-10-01': 3 } };
    expect(leaderRunDue(now, capped, signals).due).toBe(false);
    const later = { ...state, lastRun: { ...state.lastRun!, at: new Date(now).toISOString() } };
    expect((await gatherTriggerSignals(sources({ executionFeedback: () => feedback() }), later, now)).executionFailuresSinceLastRun).toBe(0);
  });
  it('older callers retain the same evidence and no failure signal', async () => {
    expect((await gatherTriggerSignals(sources(), state, now)).executionFailuresSinceLastRun).toBeUndefined();
    expect((await gatherLeaderEvidence(sources(), now, state)).executionFeedback).toBeUndefined();
  });
  it('an unreadable proposal join is not a no-proposal trigger or a measured zero', async () => {
    const snapshot = feedback();
    snapshot.view.coverage.proposalSource = 'degraded';
    for (const correlation of snapshot.correlations.values()) correlation.proposalJoinComplete = false;
    expect((await gatherTriggerSignals(sources({ executionFeedback: () => snapshot }), state, now)).executionFailuresSinceLastRun).toBeNull();
  });
});
