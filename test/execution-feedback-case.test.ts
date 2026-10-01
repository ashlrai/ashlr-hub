import { appendFileSync, mkdirSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildExecutionFeedbackCase, executionCasePrHref, readExecutionFeedbackCase, _resetExecutionFeedbackCaseCacheForTest, type ExecutionCaseSources } from '../src/core/fleet/execution-feedback-case.js';
import { buildExecutionFeedback } from '../src/core/fleet/execution-feedback.js';
import { materializeDispatchProductionAttemptEnvelope, dispatchProductionDir, type DispatchProductionEventsReadResult } from '../src/core/fleet/dispatch-production-ledger.js';
import { appendLedger, ledgerPath } from '../src/core/authority/ledger.js';
import type { LedgerEntry } from '../src/core/authority/types.js';
import type { Proposal, ProposalLocalMergeIntent } from '../src/core/types.js';
import { hashDiff, signLocalMergeIntent, signLocalRealizedMergeReceipt } from '../src/core/foundry/provenance.js';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
const event = materializeDispatchProductionAttemptEnvelope({ schemaVersion: 1, ts: iso(-10_000),
  attemptId: 'attempt-00000000-0000-4000-8000-000000000001', runId: 'run-one', itemId: 'work-one', source: 'backlog',
  repo: '/private/secret', title: 'secret prompt', backend: 'codex', tier: 'frontier', assignedBy: 'budget-policy', routeReason: 'secret',
  outcome: 'proposal-created', proposalCreated: true, proposalId: 'proposal-one', spentUsd: 0, basis: 'run-proposal-outcome', reason: 'private' });
const DIFF = '--- a/file.ts\n+++ b/file.ts\n@@\n-old\n+new\n';
const DIFF_HASH = hashDiff(DIFF);
const proposal = { id: 'proposal-one', runId: event.runId, trajectoryId: event.trajectoryId,
  repo: '/private/secret', origin: 'backlog', kind: 'patch', title: 'secret title', summary: 'private prompt', status: 'applied', createdAt: iso(-10_000),
  diff: DIFF, diffHash: DIFF_HASH, verifyResult: { passed: true, verifiedAt: iso(-9000), diffHash: DIFF_HASH, baseHead: '1'.repeat(40),
    detail: 'secret credentials', ran: [{ kind: 'test', cmd: ['private-command'] }] } };
function source(records: readonly unknown[] = [proposal], entries: LedgerEntry[] = []): ExecutionCaseSources {
  const proposals = { proposals: records as typeof proposal[], sourceState: 'healthy' as const, complete: true };
  const read: DispatchProductionEventsReadResult = { events: [event], sourceState: 'healthy', sourcePresent: true, complete: true, stopReasons: [],
    filesRead: 1, datedFilesRead: 1, looseFilesRead: 0, bytesRead: 100, rowsScanned: 1, invalidRows: 0, unreadableFiles: 0 };
  return { snapshot: buildExecutionFeedback(read, { nowMs: NOW, sinceMs: NOW - 86_400_000, proposals }), proposals, proposalRecords: records,
    ledger: { entries, chain: 'ok', head: null, brokenAtSeq: null, reason: null }, repoIdentities: new Map([['proposal-one', 'example/repo']]),
    authenticatedMerges: new Map(), readableRuns: new Set(['run-one']), nowMs: NOW };
}
function entry(kind: LedgerEntry['kind'], data: unknown): LedgerEntry { return { kind, data, at: iso(), seq: 1 } as LedgerEntry; }
const pr = () => entry('pr:opened', { v: 1, kind: 'change', proposalId: 'proposal-one', repo: 'example/repo', number: 12, headSha: '2'.repeat(40), at: iso(-8000) });
const landed = () => entry('merge:landed', { v: 1, id: 'landing-one', kind: 'merge', proposalId: 'proposal-one', repo: 'example/repo', prNumber: 12,
  headSha: '2'.repeat(40), mergeSha: '3'.repeat(40), revertsLandingId: null, landedAt: iso(-7000) });
const post = () => entry('post-merge:result', { v: 1, landingId: 'landing-one', repo: 'example/repo', mergeSha: '3'.repeat(40), ci: 'unknown', suite: 'pass', verdict: 'green', checkedAt: iso(-6000), detail: 'private token' });
function detail(s = source()) { return buildExecutionFeedbackCase(s.snapshot.view.cases[0]!.caseId, s)!; }

beforeEach(() => { _resetExecutionFeedbackCaseCacheForTest(); });
afterEach(() => { vi.useRealTimers(); });
describe('exact execution case evidence', () => {
  it('links the genuine local stages without converting post-merge unknown CI into shipping', () => {
    const result = detail(source([proposal], [pr(), landed(), post(), entry('revert:landed', { v: 1, kind: 'revert', proposalId: null,
      revertsLandingId: 'landing-one', repo: 'example/repo', prNumber: 13, headSha: '4'.repeat(40), mergeSha: '5'.repeat(40), landedAt: iso(-5000) })]));
    expect(result.timeline.map((r) => r.stage)).toEqual(['produced', 'verified', 'pr-opened', 'merged', 'post-merge', 'reverted']);
    expect(result.timeline[4]).toMatchObject({ result: 'green', ci: 'unknown', suite: 'pass' });
    expect(result.timeline[2]?.href).toBe('https://github.com/example/repo/pull/12');
    expect(result.timeline[0]?.href).toBe('/work/runs/run-one');
    expect(result.shipping).toBe('not-recorded');
    expect(JSON.stringify(result)).not.toMatch(/secret|private|credentials|command|attempt-0000|trajectoryId|grantId/);
  });
  it('keeps the real case but refuses borrowing another trajectory or conflicting proposal ID', () => {
    expect(detail(source([{ ...proposal, trajectoryId: 'run:other' }], [pr(), landed()])).timeline.map((r) => r.stage)).toEqual(['produced']);
    const conflict = detail(source([proposal, { ...proposal, diffHash: 'a'.repeat(64) }], [pr(), landed()]));
    expect(conflict.timeline.map((r) => r.stage)).toEqual(['produced']);
    expect(conflict.coverage.conflictingRecords).toBe(1);
    expect(buildExecutionFeedbackCase('a'.repeat(64), source())).toBeNull();
  });
  it('joins a genuine late proposal after producer failure only by exact run and trajectory', () => {
    const s = source();
    const failed = materializeDispatchProductionAttemptEnvelope({ ...event, proposalCreated: false, proposalId: undefined, runEventSummary: undefined, outcome: 'engine-failed' });
    const read = { events: [failed], sourceState: 'healthy', complete: true, invalidRows: 0, unreadableFiles: 0 } as DispatchProductionEventsReadResult;
    s.snapshot = buildExecutionFeedback(read, { sinceMs: NOW - 86_400_000, nowMs: NOW, proposals: s.proposals });
    expect(detail(s)).toMatchObject({ outcome: 'failed', timeline: expect.arrayContaining([expect.objectContaining({ stage: 'verified' })]) });
  });
  it.each([{ diffHash: 'x'.repeat(64) }, { baseHead: undefined }, { verifiedAt: undefined }, { verifiedAt: '2026-02-30T12:00:00.000Z' }, { verifiedAt: iso(1000) }])('qualifies missing or mismatched verification binding %#', (patch) => {
    const result = detail(source([{ ...proposal, verifyResult: { ...proposal.verifyResult, ...patch } }]));
    expect(result.timeline.find((r) => r.stage === 'verified')?.result).toBe('unbound');
    if ('verifiedAt' in patch) expect(result.timeline.find((r) => r.stage === 'verified')?.at).toBeNull();
  });
  it('does not call changed diff bytes verified merely because the old stored hash survived', () => {
    const changed = { ...proposal, diff: DIFF.replace('+new', '+different') };
    expect(detail(source([changed])).timeline.find((r) => r.stage === 'verified')?.result).toBe('unbound');
  });
  it('keeps a bound failed verifier separate from failed producer and records no command text', () => {
    expect(detail(source([{ ...proposal, verifyResult: { ...proposal.verifyResult, passed: false } }])).timeline[1]?.result).toBe('failed');
  });
  it.each(['broken', 'empty'] as const)('does not manufacture a host landing from a %s ledger', (chain) => {
    const s = source([proposal], [pr(), landed()]); s.ledger = { ...s.ledger!, chain };
    expect(detail(s).timeline.map((r) => r.stage)).toEqual(['produced', 'verified']);
    expect(detail(s).coverage.ledger).toBe(chain === 'empty' ? 'missing' : 'broken');
  });
  it('retains unavailable sources independently of known production evidence', () => {
    const s = source(); s.ledger = null; s.proposals = { ...s.proposals, complete: false, sourceState: 'degraded' };
    expect(detail(s).coverage).toMatchObject({ ledger: 'unavailable', proposals: 'degraded', dispatch: 'healthy' });
    s.readableRuns = new Set(); expect(detail(s).timeline[0]?.href).toBeUndefined();
  });
  it.each([{ repo: 'another/repo' }, { number: 0 }, { headSha: 'bad' }, { at: '2026-09-31T01:00:00.000Z' }])('refuses mismatched or malformed PR evidence %#', (patch) => {
    const row = pr(); const changed = { ...row, data: { ...row.data, ...patch } } as LedgerEntry;
    expect(detail(source([proposal], [changed])).timeline.map((r) => r.stage)).toEqual(['produced', 'verified']);
  });
  it('refuses the wrong known proposal head and a landing on a different recorded PR head', () => {
    expect(detail(source([{ ...proposal, remoteHandoff: { expectedHeadOid: '9'.repeat(40) } }], [pr(), landed()])).timeline.map((r) => r.stage)).toEqual(['produced', 'verified']);
    const row = landed(); const s = source([proposal], [pr(), { ...row, data: { ...row.data, headSha: '9'.repeat(40) } } as LedgerEntry]);
    expect(detail(s).timeline.some((r) => r.stage === 'merged')).toBe(false);
  });
  it('withholds ambiguous PR and landing identities rather than choosing an arrival winner', () => {
    const row = landed();
    const s = source([proposal], [pr(), { ...pr(), data: { ...pr().data, number: 14 } } as LedgerEntry, row]);
    expect(detail(s).timeline.some((r) => r.stage === 'merged' || r.stage === 'pr-opened')).toBe(false);
    const s2 = source([proposal], [row, { ...row, data: { ...row.data, mergeSha: '9'.repeat(40) } } as LedgerEntry]);
    expect(detail(s2).coverage.conflictingRecords).toBe(1);
    expect(detail(s2).timeline.some((r) => r.stage === 'merged')).toBe(false);
  });
  it('requires exact landing/repo/merge identity for post-merge and revert evidence', () => {
    const row = post(); const s = source([proposal], [landed(), { ...row, data: { ...row.data, mergeSha: '9'.repeat(40) } } as LedgerEntry]);
    expect(detail(s).timeline.some((r) => r.stage === 'post-merge')).toBe(false);
    expect(detail(s).coverage.invalidRecords).toBe(1);
  });
  it('identical replays do not add events or change the observed digest', () => {
    const once = source([proposal], [pr(), landed(), post()]);
    expect(detail(source([proposal, proposal], [pr(), pr(), landed(), landed(), post(), post()])).digest).toBe(detail(once).digest);
  });
  it('shape-only realized merge and a remote handoff state never earn merge evidence', () => {
    const shaped = { ...proposal, realizedMerge: { source: 'github-host', prUrl: 'https://github.com/example/repo/pull/12', mergeCommitOid: '3'.repeat(40) }, remoteHandoff: { state: 'merged' } };
    expect(detail(source([shaped])).timeline.some((r) => r.stage === 'merged')).toBe(false);
  });
  it.each([['../repo', 1], ['example/..', 1], ['example/repo?secret', 1], ['example/repo', 1.5], ['example/repo', Number.MAX_SAFE_INTEGER + 1], ['example/repo', '12']])('rejects unsafe browser link %s %s', (repo, number) => {
    expect(executionCasePrHref(repo, number)).toBeNull();
  });
});

describe('inspection-only actual disk reader', () => {
  beforeEach(() => { rmSync(join(homedir(), '.ashlr'), { recursive: true, force: true }); vi.useFakeTimers(); vi.setSystemTime(NOW); });
  it('unknown history creates no storage and does not fabricate a case', async () => {
    expect(await readExecutionFeedbackCase('a'.repeat(64))).toBeNull();
    expect(existsSync(join(homedir(), '.ashlr'))).toBe(false);
    vi.useRealTimers();
  });
  it('reads a genuine private PR chain and withholds it after on-disk corruption', async () => {
    const requestedRepo = join(homedir(), 'case-ledger-repo'); mkdirSync(join(requestedRepo, '.git'), { recursive: true });
    const repo = realpathSync.native(requestedRepo);
    writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]\n  url = https://github.com/example/repo.git\n');
    const dir = dispatchProductionDir(); mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, '2026-10-01.jsonl'), JSON.stringify(event)+'\n', { mode: 0o600 });
    const inbox = join(homedir(), '.ashlr', 'inbox'); mkdirSync(inbox, { recursive: true, mode: 0o700 });
    writeFileSync(join(inbox, 'proposal-one.json'), JSON.stringify({ ...proposal, repo }), { mode: 0o600 });
    expect(appendLedger({ kind: 'pr:opened', actor: 'daemon', repo: 'example/repo', grantId: null,
      data: { v: 1, repo: 'example/repo', number: 12, proposalId: 'proposal-one', branch: 'ashlr/fleet/proposal-one', headSha: '2'.repeat(40),
        kind: 'change', ownerLane: false, at: iso(-8000) } }).ok).toBe(true);
    const caseId = source().snapshot.view.cases[0]!.caseId;
    expect((await readExecutionFeedbackCase(caseId))?.timeline).toContainEqual(expect.objectContaining({ stage: 'pr-opened', href: 'https://github.com/example/repo/pull/12' }));
    appendFileSync(ledgerPath(), '{"invalid-complete-row":\n'); _resetExecutionFeedbackCaseCacheForTest();
    const broken = await readExecutionFeedbackCase(caseId);
    expect(broken?.coverage.ledger).toBe('broken');
    expect(broken?.timeline.some((row) => row.stage === 'pr-opened')).toBe(false);
    expect(broken?.timeline.some((row) => row.stage === 'verified')).toBe(true);
  });
  it('authenticates a real local receipt while refusing a changed witness without exposing its repository path', async () => {
    const requestedRepo = join(homedir(), 'fixture-repo'); mkdirSync(requestedRepo, { recursive: true });
    const repo = realpathSync.native(requestedRepo);
    const diff = '--- a/file.ts\n+++ b/file.ts\n@@\n-old\n+new\n';
    const diffHash = hashDiff(diff);
    const p = { ...proposal, repo, diff, diffHash, verifyResult: { ...proposal.verifyResult, diffHash } } as unknown as Proposal;
    const unsigned: Omit<ProposalLocalMergeIntent, 'attestation'> = { schemaVersion: 1, branch: 'ashlr/merge/proposal-one', base: 'main',
      baseBeforeOid: '1'.repeat(40), proposalHeadOid: '2'.repeat(40), diffHash: p.diffHash!, evidencePackDigest: '4'.repeat(64), authorizationId: '5'.repeat(32), authorizedAt: iso(-7000) };
    const attestation = signLocalMergeIntent(p.id, repo, unsigned); p.localMergeIntent = { ...unsigned, attestation };
    const observed = { schemaVersion: 1 as const, source: 'local-default-branch' as const, base: 'main', baseBeforeOid: '1'.repeat(40), proposalHeadOid: '2'.repeat(40),
      mergeCommitOid: '3'.repeat(40), observedAt: iso(-6000), proposalId: p.id, diffHash: p.diffHash!, intentAttestation: attestation };
    p.realizedMerge = { ...observed, attestation: signLocalRealizedMergeReceipt(p.id, repo, observed) };
    const dir = dispatchProductionDir(); mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(join(dir, '2026-10-01.jsonl'), JSON.stringify(event)+'\n', { mode: 0o600 });
    const inbox = join(homedir(), '.ashlr', 'inbox'); mkdirSync(inbox, { recursive: true, mode: 0o700 });
    const path = join(inbox, p.id+'.json'); writeFileSync(path, JSON.stringify(p), { mode: 0o600 });
    const caseId = source().snapshot.view.cases[0]!.caseId;
    const actual = await readExecutionFeedbackCase(caseId);
    expect(actual?.timeline).toContainEqual(expect.objectContaining({ stage: 'merged', basis: 'authenticated-local', result: 'local-merged', at: iso(-6000) }));
    expect(JSON.stringify(actual)).not.toContain(repo);
    _resetExecutionFeedbackCaseCacheForTest();
    p.realizedMerge = { ...p.realizedMerge!, mergeCommitOid: '9'.repeat(40) }; writeFileSync(path, JSON.stringify(p));
    expect((await readExecutionFeedbackCase(caseId))?.timeline.some((r) => r.stage === 'merged')).toBe(false);
    vi.useRealTimers();
  });
});
