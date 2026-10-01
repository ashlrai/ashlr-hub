import { rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildExecutionFeedback, lookupExecutionFeedback, readExecutionFeedback, readExecutionFeedbackSnapshot, leaderExecutionFeedback, type ExecutionProposalRead } from '../src/core/fleet/execution-feedback.js';
import { dispatchProductionDir, readDispatchProductionEventsDetailed, materializeDispatchProductionAttemptEnvelope, type DispatchProductionEvent, type DispatchProductionEventsReadResult } from '../src/core/fleet/dispatch-production-ledger.js';
import { retroFromExecutionFailure } from '../src/core/learn/retro/extract.js';
import { sweepRetros, type RetroSweepDeps } from '../src/core/learn/retro/sweep.js';
import { listRetros, readKnowledge } from '../src/core/learn/retro/store.js';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const opts = { nowMs: NOW, sinceMs: NOW - 86_400_000 };
const noProposals: ExecutionProposalRead = { proposals: [], sourceState: 'missing', complete: true };
function event(n = 1, outcome: DispatchProductionEvent['outcome'] = 'engine-failed'): DispatchProductionEvent {
  return materializeDispatchProductionAttemptEnvelope({
    schemaVersion: 1, ts: new Date(NOW - 1000).toISOString(),
    attemptId: `attempt-00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    runId: `run-${n}`, itemId: `work-${n}`, source: 'backlog',
    repo: '/private/secret-repo', title: 'secret prompt account@private.example',
    backend: 'codex', tier: 'frontier', assignedBy: 'budget-policy', routeReason: 'private reason',
    outcome, proposalCreated: outcome === 'proposal-created', ...(outcome === 'proposal-created' ? { proposalId: `proposal-${n}` } : {}),
    spentUsd: 0, basis: 'run-proposal-outcome', reason: 'credential secret error detail',
  });
}
function read(events: DispatchProductionEvent[] = [], extra: Partial<DispatchProductionEventsReadResult> = {}): DispatchProductionEventsReadResult {
  return { events, sourceState: 'healthy', sourcePresent: true, complete: true, stopReasons: [],
    filesRead: 1, datedFilesRead: 1, looseFilesRead: 0, bytesRead: 100, rowsScanned: events.length,
    invalidRows: 0, unreadableFiles: 0, ...extra };
}
function snapshot(events: DispatchProductionEvent[], proposals = noProposals) {
  return buildExecutionFeedback(read(events), { ...opts, proposals });
}
beforeEach(() => rmSync(join(homedir(), '.ashlr'), { recursive: true, force: true }));

describe('recorded execution feedback', () => {
  it('separates producer success, failure, cancelled, refused, empty diff, disabled, and unknown from verified merge', () => {
    const outcomes: DispatchProductionEvent['outcome'][] = ['proposal-created', 'engine-failed', 'sandbox-failed', 'proposal-capture-error', 'cancelled', 'gate-blocked', 'empty-diff', 'proposal-disabled', 'unknown'];
    const result = snapshot(outcomes.map((o, n) => event(n + 1, o)));
    expect(result.view.complete).toBe(true);
    expect(result.view.counts).toEqual({ 'producer-succeeded': 1, failed: 3, cancelled: 1, refused: 1, 'empty-diff': 1, disabled: 1, unknown: 1 });
    expect(JSON.stringify(result.view)).not.toMatch(/secret|account@|private-repo|credential|run-1|attempt-0000|merged|verified/);
    const success = result.view.cases.find((c) => c.outcome === 'producer-succeeded')!;
    expect(lookupExecutionFeedback(result, success.caseId)).toMatchObject({ runId: 'run-1', trajectoryId: `run:${event(1).attemptId}`, proposalIds: ['proposal-1'] });
    expect(lookupExecutionFeedback(result, 'invented')).toBeNull();
  });
  it('deduplicates replays and keeps the digest unchanged across duplicate delivery and assembly time', () => {
    const row = event();
    const once = snapshot([row]);
    const replay = buildExecutionFeedback(read([row, row]), { ...opts, nowMs: NOW + 1000, proposals: noProposals });
    expect(replay.view.observedCounts.failed).toBe(1);
    expect(replay.view.coverage.duplicateRows).toBe(1);
    expect(replay.view.digest).toBe(once.view.digest);
    expect(leaderExecutionFeedback(replay)).toEqual(leaderExecutionFeedback(once));
  });
  it('refuses conflicting same-attempt finals instead of selecting whichever row arrived last', () => {
    const failed = event();
    const success = event(1, 'proposal-created');
    const result = snapshot([failed, success]);
    expect(result.view.counts).toBeNull();
    expect(result.view.cases).toEqual([]);
    expect(result.view.coverage.conflictingAttempts).toBe(1);
    expect(result.correlations.size).toBe(0);
  });
  it.each(['missing', 'degraded'] as const)('%s coverage never becomes an exact zero', (sourceState) => {
    const result = buildExecutionFeedback(read([], { sourceState, complete: false, unreadableFiles: sourceState === 'degraded' ? 1 : 0 }), opts);
    expect(result.view.sourceState).toBe(sourceState);
    expect(result.view.counts).toBeNull();
    expect(result.view.observedCounts.failed).toBe(0);
  });
  it('keeps usable lower bounds when bytes/rows/files truncate or a row is unreadable', () => {
    const result = buildExecutionFeedback(read([event()], { complete: false, stopReasons: ['byte-limit'], unreadableFiles: 1 }), opts);
    expect(result.view.counts).toBeNull();
    expect(result.view.observedCounts.failed).toBe(1);
  });
  it('withholds historical rows without exact writer envelopes and malformed identities', () => {
    const legacy = { ...event(), attemptId: undefined, trajectoryId: undefined, runEventSummary: undefined };
    const invalid = { ...event(2), trajectoryId: 'run:some-other-attempt' };
    const result = snapshot([event(3), legacy, invalid]);
    expect(result.view.counts).toBeNull();
    expect(result.view.observedCounts.failed).toBe(1);
    expect(result.view.coverage.legacyRows + result.view.coverage.invalidAttempts).toBe(2);
  });
  it.each(['2026-10-02T12:00:00.000Z', '2026-02-30T12:00:00.000Z'])('withholds future/torn timestamps %s', (ts) => {
    const result = snapshot([{ ...event(), ts }]);
    expect(result.view.counts).toBeNull();
    expect(result.view.cases).toEqual([]);
  });
  it('ignores valid older rows outside the requested window', () => {
    const result = snapshot([{ ...event(), ts: new Date(opts.sinceMs - 1).toISOString() }]);
    expect(result.view.counts?.failed).toBe(0);
    expect(result.view.observedThrough).toBeNull();
  });
  it('joins a late proposal only on both exact run and attempt trajectory, never a similar run or title', () => {
    const row = event();
    const exact = snapshot([row], { sourceState: 'healthy', complete: true, proposals: [{ id: 'late', runId: row.runId, trajectoryId: row.trajectoryId }] });
    expect(exact.view.cases[0]?.proposalRecorded).toBe(true);
    expect(retroFromExecutionFailure(exact.view.cases[0]!, new Date(NOW).toISOString())).toBeNull();
    const other = snapshot([row], { sourceState: 'healthy', complete: true, proposals: [{ id: 'other', runId: row.runId, trajectoryId: event(2).trajectoryId }] });
    expect(other.view.cases[0]?.proposalRecorded).toBe(false);
    expect(retroFromExecutionFailure(other.view.cases[0]!, new Date(NOW).toISOString())?.rootCause?.code).toBe('execution:engine-failed');
  });
  it('does not infer a missing proposal when its inventory is partial/unreadable', () => {
    const result = snapshot([event()], { sourceState: 'degraded', complete: false, proposals: [] });
    expect(result.view.coverage.proposalSource).toBe('degraded');
    expect(result.correlations.get(result.view.cases[0]!.caseId)?.proposalJoinComplete).toBe(false);
  });
  it('missing stores are inspected without creating storage', () => {
    const result = readExecutionFeedback();
    expect(result.sourceState).toBe('missing');
    expect(result.counts).toBeNull();
    expect(existsSync(join(homedir(), '.ashlr'))).toBe(false);
  });
  it('strict on-disk timestamp validation precedes filtering and reports incomplete evidence, leaving legacy callers unchanged', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, '2026-10-01.jsonl');
    // One impossible date normalizes INTO the window; another normalizes OUT
    // of it. Both are corrupt observations, not a producer or a measured zero.
    writeFileSync(path, `${JSON.stringify({ ...event(), ts: '2026-09-31T11:59:59.000Z' })}\n${JSON.stringify({ ...event(2), ts: '2026-02-30T12:00:00.000Z' })}\n`, { mode: 0o600 });
    const legacy = readDispatchProductionEventsDetailed({ sinceMs: opts.sinceMs, inspectionOnly: true });
    expect(legacy.events).toHaveLength(1);
    expect(legacy.invalidRows).toBe(0);
    const strict = readDispatchProductionEventsDetailed({ sinceMs: opts.sinceMs, inspectionOnly: true, canonicalTimestamps: true });
    expect(strict.events).toEqual([]);
    expect(strict.invalidRows).toBe(2);
    expect(strict.invalidReasonCounts).toContainEqual({ reason: 'timestamp-invalid', count: 2 });
    expect(strict.complete).toBe(false);
    const result = readExecutionFeedbackSnapshot(opts);
    expect(result.view.sourceState).toBe('degraded');
    expect(result.view.counts).toBeNull();
    expect(result.view.observedCounts.failed).toBe(0);
    expect(result.view.coverage.invalidTimestamps).toBe(2);
  });
});

function sweepDeps(result: ReturnType<typeof snapshot>, extra: Partial<RetroSweepDeps> = {}): RetroSweepDeps {
  return { now: () => NOW, executionFeedback: () => result,
    readLedger: async () => ({ entries: [], head: null, chain: 'empty', brokenAtSeq: null, reason: null }),
    decidedProposals: () => [], loadProposal: () => null, cloudTasks: () => [], leaderActions: () => [], model: null, ...extra };
}
describe('deterministic failed-attempt retros', () => {
  it('replays save one metadata-only setup retro and enqueue no code/prompt lesson or model call', async () => {
    const model = { engine: 'api-test', model: 'fake', complete: vi.fn() };
    const categorize = vi.fn(async () => new Map());
    const prime = vi.fn(async () => undefined);
    const deps = sweepDeps(snapshot([event()]), { model, labelRootCauses: categorize, primeTaskKinds: prime });
    expect(await sweepRetros(deps)).toMatchObject({ created: 1, candidates: 0, modelRefined: 0 });
    expect(await sweepRetros(deps)).toMatchObject({ created: 0, candidates: 0, modelRefined: 0 });
    const retros = await listRetros();
    expect(retros).toHaveLength(1);
    expect(retros[0]).toMatchObject({ repo: null, betterPrompt: null, candidates: [], taskKind: 'other', model: null });
    expect(retros[0]?.happened).toContain('cause is unknown');
    expect(retros[0]?.rootCause?.evidence).toBe('Canonical dispatch terminal outcome');
    expect(JSON.stringify(retros)).not.toMatch(/secret|credential|account@|private-repo/);
    expect(await readKnowledge()).toEqual([]);
    expect(model.complete).not.toHaveBeenCalled();
    expect(categorize).not.toHaveBeenCalled();
    expect(prime).not.toHaveBeenCalled();
  });
  it('late exact proposal suppresses the no-proposal retro while unrelated proposal does not', async () => {
    const row = event();
    const result = snapshot([row], { sourceState: 'healthy', complete: true, proposals: [{ id: 'late', runId: row.runId, trajectoryId: row.trajectoryId }] });
    expect(await sweepRetros(sweepDeps(result))).toMatchObject({ created: 0 });
    expect(await sweepRetros(sweepDeps(snapshot([row])))).toMatchObject({ created: 1 });
  });
  it('partial proposal join and throwing sources hold new learning rather than create unknown-cause duplicates', async () => {
    expect(await sweepRetros(sweepDeps(snapshot([event()], { sourceState: 'degraded', complete: false, proposals: [] })))).toMatchObject({ created: 0, unavailable: ['execution-proposal-join'] });
    expect(await sweepRetros(sweepDeps(snapshot([]), { executionFeedback: () => { throw new Error('private error'); } }))).toMatchObject({ created: 0, unavailable: ['execution-feedback'] });
  });
  it('partial dispatch coverage still records each trustworthy observed failure, never invented missing attempts', async () => {
    const result = buildExecutionFeedback(read([event()], { complete: false }), { ...opts, proposals: noProposals });
    expect(await sweepRetros(sweepDeps(result))).toMatchObject({ created: 1, unavailable: ['execution-feedback-partial'] });
  });
  it.each(['cancelled', 'gate-blocked', 'empty-diff', 'proposal-disabled', 'proposal-created', 'unknown'] as const)('%s is not taught as a setup/code failure', async (outcome) => {
    expect(await sweepRetros(sweepDeps(snapshot([event(1, outcome)])))).toMatchObject({ created: 0 });
  });
});
