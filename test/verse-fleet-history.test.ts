/**
 * verse-fleet-history.test.ts — GET /api/verse/fleet/history (V3.10, unit A8).
 *
 * Covers the daily projection (runs / proposals / judge verdicts / verification
 * / authenticated merges), its honesty rules (missing = real zeros, unreadable
 * = null, partly readable = lower bound + reasons, claim-check never faked),
 * the incremental cache, the "fleet dark since" state, the scorecard-trend
 * service (worker, fallback, throttling) including one real worker thread,
 * the HTTP module contract, and an event-loop budget check.
 *
 * Hermetic: HOME is a fresh tmp dir per test; every fixture is written under it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Proposal, ProposalLocalMergeIntent } from '../src/core/types.js';
import type { ScorecardHistoryMaintenanceResult } from '../src/core/fleet/scorecard.js';

const origHome = process.env.HOME;
const origAshlrHome = process.env.ASHLR_HOME;
let tmpHome: string;
let ashlr: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-a8-home-'));
  process.env.HOME = tmpHome;
  delete process.env.ASHLR_HOME;
  ashlr = path.join(tmpHome, '.ashlr');
  fs.mkdirSync(ashlr, { mode: 0o700 });
});

afterEach(async () => {
  const { resetFleetHistoryServiceForTests } = await import('../src/core/verse/fleet-history.js');
  await resetFleetHistoryServiceForTests(null);
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  if (origAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = origAshlrHome;
  vi.restoreAllMocks();
});

// 2026-09-23T15:00:00Z — a fixed "now" so day buckets are deterministic.
const NOW = Date.parse('2026-09-23T15:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Fixture writers
// ---------------------------------------------------------------------------

function privateDir(name: string): string {
  const dir = path.join(ashlr, name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

let seq = 0;
function writeRun(opts: {
  createdMs: number;
  updatedMs?: number;
  status?: 'running' | 'done' | 'failed' | 'aborted';
  engine?: string;
  repo?: string;
  cost?: number;
  id?: string;
}): string {
  const id = opts.id ?? `run-a8-${seq++}`;
  const run = {
    id,
    goal: 'SECRET GOAL TEXT that must never leave the server',
    engine: opts.engine ?? 'claude',
    provider: 'external',
    createdAt: iso(opts.createdMs),
    updatedAt: iso(opts.updatedMs ?? opts.createdMs + 10 * 60 * 1000),
    budget: { maxTokens: 1, maxSteps: 1, allowCloud: false },
    usage: { tokensIn: 1, tokensOut: 1, steps: 1, ...(opts.cost === undefined ? {} : { estCostUsd: opts.cost }) },
    tasks: [],
    steps: [],
    status: opts.status ?? 'done',
    ...(opts.repo ? { delegationScope: { schemaVersion: 1, sourceRepo: opts.repo } } : {}),
  };
  fs.writeFileSync(path.join(privateDir('runs'), `${id}.json`), JSON.stringify(run), { mode: 0o600 });
  return id;
}

function writeProposal(p: Record<string, unknown> & { id: string }): void {
  fs.writeFileSync(path.join(privateDir('inbox'), `${p.id}.json`), JSON.stringify(p), { mode: 0o600 });
}

function proposal(overrides: Record<string, unknown> & { createdMs: number }): Record<string, unknown> & { id: string } {
  const { createdMs, ...rest } = overrides;
  return {
    id: `prop-a8-${seq++}`,
    repo: path.join(tmpHome, 'repos', 'alpha'),
    origin: 'backlog',
    kind: 'patch',
    title: 't',
    summary: 's',
    status: 'rejected',
    createdAt: iso(createdMs),
    diff: '--- a/x\n+++ b/x\n@@\n-a\n+b\n',
    ...rest,
  };
}

async function writeDecision(row: Record<string, unknown>): Promise<void> {
  const { recordDecision } = await import('../src/core/fleet/decisions-ledger.js');
  recordDecision(row as never);
}

async function authenticatedMergedProposal(observedMs: number): Promise<Proposal> {
  const { signLocalMergeIntent, signLocalRealizedMergeReceipt } = await import('../src/core/foundry/provenance.js');
  const id = `prop-a8-merged-${seq++}`;
  const repo = path.join(tmpHome, 'repos', id);
  fs.mkdirSync(repo, { recursive: true });
  const diffHash = 'd'.repeat(64);
  const observedAt = iso(observedMs);
  const p = {
    id,
    repo,
    origin: 'backlog',
    kind: 'patch',
    title: 't',
    summary: 's',
    status: 'applied',
    createdAt: iso(observedMs - HOUR),
    diff: '--- a/file.ts\n+++ b/file.ts\n@@\n-old\n+new\n',
    diffHash,
    verifyResult: { passed: true, baseHead: '1'.repeat(40), diffHash, ran: [{ kind: 'test', cmd: ['npm', 'test'] }] },
  } as unknown as Proposal;
  const unsignedIntent: Omit<ProposalLocalMergeIntent, 'attestation'> = {
    schemaVersion: 1,
    branch: `ashlr/merge/${id}`,
    base: 'main',
    baseBeforeOid: '1'.repeat(40),
    proposalHeadOid: '2'.repeat(40),
    diffHash,
    evidencePackDigest: '4'.repeat(64),
    authorizationId: '5'.repeat(32),
    authorizedAt: observedAt,
  };
  const intentAttestation = signLocalMergeIntent(id, repo, unsignedIntent);
  p.localMergeIntent = { ...unsignedIntent, attestation: intentAttestation };
  const unsignedRealized = {
    schemaVersion: 1 as const,
    source: 'local-default-branch' as const,
    base: 'main',
    baseBeforeOid: '1'.repeat(40),
    proposalHeadOid: '2'.repeat(40),
    mergeCommitOid: '3'.repeat(40),
    observedAt,
    proposalId: id,
    diffHash,
    intentAttestation,
  };
  p.realizedMerge = { ...unsignedRealized, attestation: signLocalRealizedMergeReceipt(id, repo, unsignedRealized) };
  return p;
}

// ---------------------------------------------------------------------------
// Service helpers
// ---------------------------------------------------------------------------

function emptyTrendResult(): ScorecardHistoryMaintenanceResult {
  const empty = { sourceQuality: { sourceState: 'missing' as const, complete: true, reasons: [] }, points: [] };
  return { snapshotAttempted: false, wrote: false, trend7d: empty, trend30d: empty };
}

async function staticScorecard() {
  const { createScorecardTrendService } = await import('../src/core/verse/fleet-history.js');
  return createScorecardTrendService({ now: () => NOW, runWorker: async () => emptyTrendResult() });
}

async function service(now: () => number = () => NOW) {
  const { createFleetHistoryService } = await import('../src/core/verse/fleet-history.js');
  return createFleetHistoryService({ now, scorecard: await staticScorecard() });
}

function dayOf(history: { days: Array<{ day: string }> }, day: string) {
  const found = history.days.find((d) => d.day === day);
  if (!found) throw new Error(`no day ${day}`);
  return found as never as import('../src/core/verse/fleet-history-types.js').FleetHistoryDay;
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

describe('extractors', () => {
  it('reduces a run to metadata only and rejects an id/file mismatch', async () => {
    const { extractRun } = await import('../src/core/verse/fleet-history.js');
    const text = JSON.stringify({
      id: 'r1', status: 'failed', createdAt: iso(NOW), updatedAt: iso(NOW + 5000), engine: 'co dex!',
      goal: 'secret', usage: { estCostUsd: 0.5 }, delegationScope: { sourceRepo: '/Users/x/dev/binshield/' },
    });
    const ok = extractRun(text, 'r1.json');
    expect(ok.values).toEqual([{
      id: 'r1', createdMs: NOW, updatedMs: NOW + 5000, status: 'failed', engine: 'codex', repo: 'binshield', estCostUsd: 0.5,
    }]);
    expect(JSON.stringify(ok)).not.toContain('secret');
    expect(extractRun(text, 'other.json')).toEqual({ values: [], skipped: 1, reasons: ['invalid-file'] });
    expect(extractRun(JSON.stringify({ id: 'r1', status: 'weird', createdAt: iso(NOW) }), 'r1.json').skipped).toBe(1);
  });

  it('classifies verification outcomes by failure category and dates legacy results by filing time', async () => {
    const { extractProposal } = await import('../src/core/verse/fleet-history.js');
    const base = { status: 'rejected', createdAt: iso(NOW), kind: 'patch', diff: '+x' };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ passed: true, verifiedAt: iso(NOW + DAY) }, 'passed'],
      [{ passed: false, failureCategory: 'code' }, 'failed-code'],
      [{ passed: false, failureCategory: 'timeout' }, 'failed-infra'],
      [{ passed: false }, 'failed-unknown'],
    ];
    for (const [verifyResult, outcome] of cases) {
      const out = extractProposal(JSON.stringify({ ...base, id: 'p', verifyResult }), 'p.json');
      expect(out.values[0]!.verification!.outcome).toBe(outcome);
    }
    const dated = extractProposal(JSON.stringify({ ...base, id: 'p', verifyResult: { passed: true, verifiedAt: iso(NOW + DAY) } }), 'p.json');
    expect(dated.values[0]!.verification!.atMs).toBe(NOW + DAY);
    const legacy = extractProposal(JSON.stringify({ ...base, id: 'p', verifyResult: { passed: false } }), 'p.json');
    expect(legacy.values[0]!.verification!.atMs).toBe(NOW);
    const tests = extractProposal(JSON.stringify({
      ...base, id: 'p', verifyResult: { passed: true, ran: [{ kind: 'typecheck' }, { kind: 'test' }] },
    }), 'p.json');
    expect(tests.values[0]!.verification!.ranTests).toBe(true);
  });

  it('never credits an unsigned realized-merge receipt', async () => {
    const { extractProposal } = await import('../src/core/verse/fleet-history.js');
    const forged = {
      id: 'p', status: 'applied', createdAt: iso(NOW), kind: 'patch', diff: '+x', repo: tmpHome,
      realizedMerge: { schemaVersion: 1, source: 'local-default-branch', observedAt: iso(NOW), attestation: 'forged' },
    };
    const out = extractProposal(JSON.stringify(forged), 'p.json');
    expect(out.values[0]!.realizedMs).toBeNull();
  });

  it('buckets judge rows by reason code, falling back to legacy verdicts', async () => {
    const { extractDecisions } = await import('../src/core/verse/fleet-history.js');
    const lines = [
      { ts: iso(NOW), proposalId: 'a', action: 'judged', judgeReasonCode: 'judge-ship-would-merge' },
      { ts: iso(NOW), proposalId: 'b', action: 'judged', verdict: 'review', judgeReasonCode: 'judge-parse-failure' },
      { ts: iso(NOW), proposalId: 'c', action: 'judged', verdict: 'noise' },
      { ts: iso(NOW), proposalId: 'd', action: 'judged', verdict: 'approved' },
      { ts: iso(NOW), proposalId: 'e', action: 'proposed' },
    ].map((row) => JSON.stringify(row));
    const out = extractDecisions([...lines, '{not json', JSON.stringify({ action: 'judged' })].join('\n'));
    expect(out.values.map((v) => v.judge)).toEqual(['ship', 'failed', 'noise', 'failed', null]);
    expect(out.skipped).toBe(2);
    expect(out.reasons).toEqual(['invalid-row']);
  });

  it('computes day keys in the requested zone offset', async () => {
    const { dayKey } = await import('../src/core/verse/fleet-history.js');
    const lateUtc = Date.parse('2026-09-23T02:00:00Z');
    expect(dayKey(lateUtc, 0)).toBe('2026-09-23');
    expect(dayKey(lateUtc, 420)).toBe('2026-09-22'); // PDT: 19:00 on the 22nd
    expect(dayKey(lateUtc, -600)).toBe('2026-09-23'); // UTC+10: noon on the 23rd
  });
});

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

describe('fleet history projection', () => {
  it('reports a fresh machine as a complete, genuinely empty history (real zeros, not unknown)', async () => {
    const history = await (await service()).get({ days: 7, tzOffsetMinutes: 0 });
    expect(history.days).toHaveLength(7);
    expect(history.days[0]!.day).toBe('2026-09-17');
    expect(history.days[6]!.day).toBe('2026-09-23');
    expect(history.sources.runs.state).toBe('missing');
    expect(history.totals).toEqual({
      runsStarted: 0, proposalsFiled: 0, judged: 0, verificationPassed: 0, mergesRealized: 0, estCostUsd: 0,
    });
    expect(history.lastActivityAt).toBeNull();
    expect(history.darkSince).toBeNull();
    expect(history.funnel).toEqual({ filed: 0, verified: 0, verificationPassed: 0, judgedShip: 0, merged: 0 });
  });

  it('never fabricates claim-check data', async () => {
    writeRun({ createdMs: NOW - HOUR });
    const history = await (await service()).get({ days: 7, tzOffsetMinutes: 0 });
    expect(history.sources.claimCheck.state).toBe('not-recorded');
    for (const day of history.days) expect(day.claimCheck).toEqual({ passed: null, flagged: null });
  });

  it('counts runs, proposals, verdicts, verification and merges on the right days', async () => {
    const today = '2026-09-23';
    const yesterday = '2026-09-22';
    writeRun({ createdMs: NOW - HOUR, status: 'done', repo: '/abs/path/binshield', cost: 0.25 });
    writeRun({ createdMs: NOW - 2 * HOUR, status: 'failed', repo: '/abs/path/binshield', cost: 0.5 });
    writeRun({ createdMs: NOW - DAY, status: 'aborted', engine: 'codex' });
    writeRun({ createdMs: NOW - 30 * DAY, status: 'done' }); // outside a 7-day window

    const passedFiled = proposal({ createdMs: NOW - HOUR, verifyResult: { passed: true, ran: [{ kind: 'test' }] } });
    writeProposal(passedFiled);
    writeProposal(proposal({ createdMs: NOW - DAY, verifyResult: { passed: false, failureCategory: 'code' } }));
    writeProposal(proposal({ createdMs: NOW - DAY, diff: '', verifyResult: { passed: false, failureCategory: 'infra' } }));
    const merged = await authenticatedMergedProposal(NOW - 2 * HOUR);
    writeProposal(merged as never);

    await writeDecision({ ts: iso(NOW - HOUR), proposalId: passedFiled.id, action: 'judged', verdict: 'ship', judgeReasonCode: 'judge-ship-review-required' });
    await writeDecision({ ts: iso(NOW - HOUR), proposalId: merged.id, action: 'judged', verdict: 'ship', judgeReasonCode: 'judge-ship-would-merge' });
    // The ledger writer derives judgeReasonCode itself (from verdict + detail).
    await writeDecision({ ts: iso(NOW - DAY), proposalId: 'x', action: 'judged', verdict: 'review', detail: 'judge-network-failure' });
    await writeDecision({ ts: iso(NOW - DAY), proposalId: 'y', action: 'judged', verdict: 'harmful', judgeReasonCode: 'judge-harmful' });

    const history = await (await service()).get({ days: 7, tzOffsetMinutes: 0 });
    const t = dayOf(history, today);
    const y = dayOf(history, yesterday);
    expect(t.runs).toEqual({ started: 2, done: 1, failed: 1, aborted: 0, unfinished: 0 });
    expect(y.runs).toEqual({ started: 1, done: 0, failed: 0, aborted: 1, unfinished: 0 });
    expect(t.estCostUsd).toBeCloseTo(0.75, 6);
    expect(t.proposals).toEqual({ filed: 2, withDiff: 2 });
    expect(y.proposals).toEqual({ filed: 2, withDiff: 1 });
    expect(t.verification).toEqual({ passed: 2, failedCode: 0, failedInfra: 0, failedUnknown: 0, withTests: 2 });
    expect(y.verification).toEqual({ passed: 0, failedCode: 1, failedInfra: 1, failedUnknown: 0, withTests: 0 });
    expect(t.judged).toEqual({ total: 2, ship: 2, review: 0, noise: 0, harmful: 0, failed: 0 });
    expect(y.judged).toEqual({ total: 2, ship: 0, review: 0, noise: 0, harmful: 1, failed: 1 });
    expect(t.merges.realized).toBe(1);
    expect(history.totals.runsStarted).toBe(3);
    expect(history.totals.mergesRealized).toBe(1);
    expect(history.funnel).toEqual({ filed: 4, verified: 4, verificationPassed: 2, judgedShip: 2, merged: 1 });
    expect(history.darkSince).toBeNull();
    expect(history.lastActivityAt).not.toBeNull();

    // Swimlanes: grouped by repo BASENAME, never an absolute path, never goal text.
    const lanes = history.swimlanes.map((lane) => lane.label);
    expect(lanes).toContain('binshield');
    expect(lanes).toContain('codex (no repo)');
    const serialized = JSON.stringify(history);
    expect(serialized).not.toContain('/abs/path');
    expect(serialized).not.toContain('SECRET GOAL');
    expect(serialized).not.toContain(tmpHome);
  });

  // P4 regression (review 3.10 c10): the Spend tile reads per-token spend
  // against the metered cap, so subscription CLI runs must not count.
  it('splits out per-token (metered) spend per day, excluding subscription and free engines', async () => {
    const today = '2026-09-23';
    writeRun({ createdMs: NOW - HOUR, engine: 'claude', cost: 0.5 }); // subscription seat
    writeRun({ createdMs: NOW - HOUR, engine: 'codex', cost: 0.25 }); // subscription seat
    writeRun({ createdMs: NOW - HOUR, engine: 'grok-cli', cost: 0.125 }); // SuperGrok seat
    writeRun({ createdMs: NOW - HOUR, engine: 'grok', cost: 0.2 }); // the per-token xAI API
    writeRun({ createdMs: NOW - HOUR, engine: 'aw', cost: 0.05 }); // unclassifiable: counted, never hidden
    writeRun({ createdMs: NOW - HOUR, engine: 'local-coder', cost: 0.4 }); // loopback: free
    writeRun({ createdMs: NOW - DAY, engine: 'claude', cost: 1 });
    const history = await (await service()).get({ days: 7, tzOffsetMinutes: 0 });
    const t = dayOf(history, today) as ReturnType<typeof dayOf> & { meteredCostUsd: number | null };
    const y = dayOf(history, '2026-09-22') as ReturnType<typeof dayOf> & { meteredCostUsd: number | null };
    expect(t.estCostUsd).toBeCloseTo(1.525, 6);
    expect(t.meteredCostUsd).toBeCloseTo(0.25, 6);
    // A day of subscription-only work is a real $0, not unknown.
    expect(y.meteredCostUsd).toBe(0);
    const { runBilling } = await import('../src/core/verse/fleet-history.js');
    expect(['claude', 'codex', 'grok-cli', 'grok', 'aw', 'local-coder', 'unknown'].map(runBilling))
      .toEqual(['subscription', 'subscription', 'subscription', 'per-token', 'per-token', 'free', 'per-token']);
  });

  it('shifts day buckets by the caller timezone offset', async () => {
    // 02:00Z on the 23rd is still the 22nd in PDT.
    writeRun({ createdMs: Date.parse('2026-09-23T02:00:00Z') });
    const svc = await service();
    const utc = await svc.get({ days: 7, tzOffsetMinutes: 0 });
    const pdt = await svc.get({ days: 7, tzOffsetMinutes: 420 });
    expect(dayOf(utc, '2026-09-23').runs.started).toBe(1);
    expect(dayOf(pdt, '2026-09-22').runs.started).toBe(1);
    expect(pdt.days[6]!.day).toBe('2026-09-23'); // 08:00 PDT on the 23rd
  });

  it('reads as dark after 48h without runs or proposals, even when a judge re-ran an old proposal', async () => {
    const last = NOW - 22 * DAY;
    writeRun({ createdMs: last - HOUR, updatedMs: last });
    await writeDecision({ ts: iso(NOW - HOUR), proposalId: 'old', action: 'judged', verdict: 'review', judgeReasonCode: 'judge-parse-failure' });
    const history = await (await service()).get({ days: 30, tzOffsetMinutes: 0 });
    expect(history.darkSince).toBe(iso(last));
    expect(history.lastActivityAt).toBe(iso(last));
    expect(history.sources.decisions.lastRecordAt).toBe(iso(NOW - HOUR));
  });

  it('flags a long-silent running run as stale and leaves it open-ended', async () => {
    writeRun({ createdMs: NOW - 3 * HOUR, updatedMs: NOW - 2 * HOUR, status: 'running', repo: '/r/alpha' });
    writeRun({ createdMs: NOW - 10 * 60 * 1000, updatedMs: NOW - 60 * 1000, status: 'running', repo: '/r/alpha' });
    const history = await (await service()).get({ days: 7, tzOffsetMinutes: 0 });
    const items = history.swimlanes.find((lane) => lane.id === 'alpha')!.items;
    expect(items.map((item) => [item.endMs, item.stale])).toEqual([[null, true], [null, false]]);
    expect(dayOf(history, '2026-09-23').runs.unfinished).toBe(2);
  });

  it('keeps counts as lower bounds with reasons when some files cannot be read', async () => {
    writeRun({ createdMs: NOW - HOUR });
    const runs = privateDir('runs');
    // Over the 1 MiB per-file bound.
    fs.writeFileSync(path.join(runs, 'huge.json'), JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 10) }), { mode: 0o600 });
    // A symlink is never followed.
    const outside = path.join(tmpHome, 'outside.json');
    fs.writeFileSync(outside, JSON.stringify({ id: 'link', status: 'done', createdAt: iso(NOW) }), { mode: 0o600 });
    fs.symlinkSync(outside, path.join(runs, 'link.json'));
    fs.writeFileSync(path.join(runs, 'bad.json'), '{nope', { mode: 0o600 });

    const history = await (await service()).get({ days: 7, tzOffsetMinutes: 0 });
    expect(history.sources.runs.state).toBe('degraded');
    expect(history.sources.runs.complete).toBe(false);
    expect(history.sources.runs.reasons).toEqual(['invalid-file', 'oversized-file', 'unsafe-file']);
    expect(history.sources.runs.recordsSkipped).toBe(3);
    expect(dayOf(history, '2026-09-23').runs.started).toBe(1); // a lower bound, not null
  });

  it('reports UNKNOWN (null), never zero, when a source cannot be read at all', async () => {
    const runs = privateDir('runs');
    fs.chmodSync(runs, 0o777); // group/world-writable: refused as unsafe
    try {
      const history = await (await service()).get({ days: 7, tzOffsetMinutes: 0 });
      expect(history.sources.runs.state).toBe('degraded');
      expect(history.sources.runs.reasons).toEqual(['unsafe-directory']);
      for (const day of history.days) {
        expect(day.runs.started).toBeNull();
        expect(day.estCostUsd).toBeNull();
        expect((day as typeof day & { meteredCostUsd: number | null }).meteredCostUsd).toBeNull();
      }
      expect(history.totals.runsStarted).toBeNull();
      expect(history.totals.estCostUsd).toBeNull();
      // Other sources stay known.
      expect(history.totals.proposalsFiled).toBe(0);
    } finally {
      fs.chmodSync(runs, 0o700);
    }
  });

  it('re-reads only files that changed (incremental cache)', async () => {
    const id = writeRun({ createdMs: NOW - HOUR, status: 'done' });
    const file = path.join(ashlr, 'runs', `${id}.json`);
    // Whole-second mtime so restoring it below is exact (utimes loses sub-ms precision).
    const fixedMtime = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    fs.utimesSync(file, fixedMtime, fixedMtime);
    let clock = NOW;
    const svc = await service(() => clock);
    expect(dayOf(await svc.get({ days: 7, tzOffsetMinutes: 0 }), '2026-09-23').runs.done).toBe(1);

    // Same size, same mtime, different bytes: a cache hit keeps the old summary.
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text.replace('"status":"done"', '"status":"fail"'));
    fs.utimesSync(file, fixedMtime, fixedMtime);
    clock += 60_000;
    expect(dayOf(await svc.get({ days: 7, tzOffsetMinutes: 0 }), '2026-09-23').runs.done).toBe(1);

    // A real change (new mtime) is picked up on the next refresh.
    fs.writeFileSync(file, text.replace('"status":"done"', '"status":"aborted"'));
    fs.utimesSync(file, fixedMtime, new Date(fixedMtime.getTime() + 5000));
    clock += 60_000;
    const after = dayOf(await svc.get({ days: 7, tzOffsetMinutes: 0 }), '2026-09-23');
    expect(after.runs.done).toBe(0);
    expect(after.runs.aborted).toBe(1);

    // A deleted file drops out.
    fs.rmSync(file);
    clock += 60_000;
    expect(dayOf(await svc.get({ days: 7, tzOffsetMinutes: 0 }), '2026-09-23').runs.started).toBe(0);
  });

  it('serves a fresh projection from memory without rescanning', async () => {
    writeRun({ createdMs: NOW - HOUR });
    const svc = await service();
    await svc.get({ days: 7, tzOffsetMinutes: 0 });
    writeRun({ createdMs: NOW - HOUR }); // within the 30 s freshness window: not yet visible
    expect((await svc.get({ days: 7, tzOffsetMinutes: 0 })).totals.runsStarted).toBe(1);
  });

  it('degrades merges to unknown when two proposals claim the same merge', async () => {
    const a = await authenticatedMergedProposal(NOW - HOUR);
    const b = { ...a, id: `${a.id}-dup` };
    writeProposal(a as never);
    // Same canonical identity (repo + merge commit), different proposal: ambiguous.
    const { signLocalRealizedMergeReceipt, signLocalMergeIntent } = await import('../src/core/foundry/provenance.js');
    const intent = { ...a.localMergeIntent!, attestation: undefined } as never as Omit<ProposalLocalMergeIntent, 'attestation'>;
    delete (intent as { attestation?: string }).attestation;
    const intentAttestation = signLocalMergeIntent(b.id, b.repo!, intent);
    b.localMergeIntent = { ...intent, attestation: intentAttestation };
    const { attestation: _drop, ...realized } = a.realizedMerge as never as Record<string, unknown>;
    const unsigned = { ...realized, proposalId: b.id, intentAttestation } as never;
    b.realizedMerge = { ...(unsigned as object), attestation: signLocalRealizedMergeReceipt(b.id, b.repo!, unsigned) } as never;
    writeProposal(b as never);
    const history = await (await service()).get({ days: 7, tzOffsetMinutes: 0 });
    expect(history.sources.proposals.reasons).toContain('duplicate-canonical-realized-merge-identity');
    expect(history.totals.mergesRealized).toBeNull();
    expect(history.funnel.merged).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scorecard trend service
// ---------------------------------------------------------------------------

function trendResult(wrote: boolean): ScorecardHistoryMaintenanceResult {
  const point = (ts: string, window: '7d' | '30d') => ({
    ts, window, merges: { realized: 1, released: null }, releasedState: 'uncommissioned' as const,
    costPerMergedChangeUsd: null, proposalsFiled: 3, rejectionLessonsWritten: 0,
  });
  const healthy = { sourceState: 'healthy' as const, complete: true, reasons: [] };
  return {
    snapshotAttempted: true,
    wrote,
    // Newest first, as readScorecardTrend returns them.
    trend7d: { sourceQuality: healthy, points: [point('2026-09-23T00:00:00.000Z', '7d'), point('2026-09-22T00:00:00.000Z', '7d')] },
    trend30d: { sourceQuality: healthy, points: [point('2026-09-23T00:00:00.000Z', '30d')] },
  };
}

describe('scorecard trend service', () => {
  it('snapshots through the worker, serves oldest-first, and throttles repeat reads', async () => {
    const { createScorecardTrendService } = await import('../src/core/verse/fleet-history.js');
    let clock = NOW;
    const runWorker = vi.fn(async () => trendResult(true));
    const svc = createScorecardTrendService({ now: () => clock, runWorker });
    const first = await svc.get(90);
    expect(runWorker).toHaveBeenCalledWith({ snapshot: true, limit: 90 });
    expect(first.trend7d.map((p) => p.ts)).toEqual(['2026-09-22T00:00:00.000Z', '2026-09-23T00:00:00.000Z']);
    expect(first.snapshot).toEqual({ mode: 'worker', lastAttemptAt: iso(NOW), lastWroteAt: iso(NOW) });
    expect(first.source.state).toBe('healthy');
    expect(first.source.lastRecordAt).toBe('2026-09-23T00:00:00.000Z');

    clock += 5 * 60 * 1000;
    await svc.get(90);
    expect(runWorker).toHaveBeenCalledTimes(1); // fresh cache

    clock += 6 * 60 * 1000; // cache stale, snapshot not yet due (hourly)
    await svc.get(90);
    expect(runWorker).toHaveBeenLastCalledWith({ snapshot: false, limit: 90 });

    clock += 60 * 60 * 1000; // snapshot due again
    await svc.get(90);
    expect(runWorker).toHaveBeenLastCalledWith({ snapshot: true, limit: 90 });
  });

  it('falls back to a DEFERRED inline run after the worker fails twice, never blocking a request', async () => {
    const { createScorecardTrendService } = await import('../src/core/verse/fleet-history.js');
    const scheduled: Array<() => void> = [];
    const runInline = vi.fn(() => trendResult(true));
    const svc = createScorecardTrendService({
      now: () => NOW,
      runWorker: async () => { throw new Error('worker cannot start'); },
      runInline,
      schedule: (fn) => { scheduled.push(fn); },
      closeWorker: async () => undefined,
    });
    const first = await svc.get(30);
    expect(first.source.reasons).toEqual(['scorecard-worker-unavailable']);
    expect(svc.mode()).toBe('worker');
    const second = await svc.get(30);
    expect(svc.mode()).toBe('inline');
    expect(second.snapshot.mode).toBe('inline');
    expect(runInline).not.toHaveBeenCalled(); // not on the request path
    expect(scheduled).toHaveLength(1);
    await svc.get(30);
    expect(scheduled).toHaveLength(1); // one pending run at a time
    scheduled[0]!();
    expect(runInline).toHaveBeenCalledWith({ snapshot: true, limit: 30 });
    const third = await svc.get(30);
    expect(third.trend30d).toHaveLength(1);
    expect(third.source.state).toBe('healthy');
  });

  it.skipIf(process.platform === 'win32')('runs the real worker thread and persists a snapshot under the isolated HOME', async () => {
    const { createScorecardTrendService } = await import('../src/core/verse/fleet-history.js');
    const svc = createScorecardTrendService();
    try {
      const view = await svc.get(30);
      expect(view.snapshot.mode).toBe('worker');
      expect(view.snapshot.lastWroteAt).not.toBeNull();
      expect(view.trend7d).toHaveLength(1);
      expect(view.trend30d).toHaveLength(1);
      expect(fs.readdirSync(path.join(ashlr, 'scorecard-history')).some((f) => f.endsWith('.jsonl'))).toBe(true);
    } finally {
      await svc.close();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// HTTP module
// ---------------------------------------------------------------------------

interface Captured { status: number; body: unknown }

function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: undefined };
  const res = {
    headersSent: false,
    writeHead(status: number) { captured.status = status; return this; },
    end(payload?: string) { captured.body = payload === undefined ? undefined : JSON.parse(payload); },
  } as unknown as ServerResponse;
  return { res, captured };
}

const req = (url: string) => ({ url, method: 'GET', headers: {} }) as unknown as IncomingMessage;
const ctx = {} as never;

describe('handleFleetHistoryApi', () => {
  it('ignores other paths so the next module can answer', async () => {
    const { handleFleetHistoryApi } = await import('../src/core/verse/fleet-history.js');
    const { res, captured } = fakeRes();
    expect(await handleFleetHistoryApi(ctx, req('/api/verse/fleet'), res, '/api/verse/fleet', 'GET')).toBe(false);
    expect(captured.status).toBe(0);
  });

  it('rejects non-GET and malformed queries without clamping them', async () => {
    const { handleFleetHistoryApi, FLEET_HISTORY_PATH } = await import('../src/core/verse/fleet-history.js');
    const cases: Array<[string, string, number, string | undefined]> = [
      ['POST', FLEET_HISTORY_PATH, 404, undefined],
      ['GET', `${FLEET_HISTORY_PATH}?days=3`, 400, 'INVALID_DAYS'],
      ['GET', `${FLEET_HISTORY_PATH}?days=1000`, 400, 'INVALID_DAYS'],
      ['GET', `${FLEET_HISTORY_PATH}?days=7.5`, 400, 'INVALID_DAYS'],
      ['GET', `${FLEET_HISTORY_PATH}?tz=9999`, 400, 'INVALID_TZ'],
      ['GET', `${FLEET_HISTORY_PATH}?tz=abc`, 400, 'INVALID_TZ'],
    ];
    for (const [method, url, status, code] of cases) {
      const { res, captured } = fakeRes();
      expect(await handleFleetHistoryApi(ctx, req(url), res, FLEET_HISTORY_PATH, method)).toBe(true);
      expect(captured.status).toBe(status);
      if (code) expect((captured.body as { code: string }).code).toBe(code);
    }
  });

  it('answers GET with a sanitized projection for the requested window', async () => {
    const { handleFleetHistoryApi, resetFleetHistoryServiceForTests, createFleetHistoryService, FLEET_HISTORY_PATH } =
      await import('../src/core/verse/fleet-history.js');
    await resetFleetHistoryServiceForTests(createFleetHistoryService({ now: () => NOW, scorecard: await staticScorecard() }));
    writeRun({ createdMs: NOW - HOUR, repo: path.join(tmpHome, 'dev', 'alpha') });
    const { res, captured } = fakeRes();
    expect(await handleFleetHistoryApi(ctx, req(`${FLEET_HISTORY_PATH}?days=14&tz=0`), res, FLEET_HISTORY_PATH, 'GET')).toBe(true);
    expect(captured.status).toBe(200);
    const body = captured.body as { days: unknown[]; window: { days: number }; swimlanes: Array<{ label: string }> };
    expect(body.days).toHaveLength(14);
    expect(body.window.days).toBe(14);
    expect(body.swimlanes[0]!.label).toBe('alpha');
    expect(JSON.stringify(body)).not.toContain(tmpHome);
  });

  it('answers 500 with a stable code when the service throws', async () => {
    const { handleFleetHistoryApi, resetFleetHistoryServiceForTests, FLEET_HISTORY_PATH } = await import('../src/core/verse/fleet-history.js');
    const boom = async (): Promise<never> => { throw new Error(`boom ${tmpHome}`); };
    await resetFleetHistoryServiceForTests({ get: boom, getPayload: boom, close: async () => undefined });
    const { res, captured } = fakeRes();
    await handleFleetHistoryApi(ctx, req(FLEET_HISTORY_PATH), res, FLEET_HISTORY_PATH, 'GET');
    expect(captured.status).toBe(500);
    expect(captured.body).toEqual({ code: 'FLEET_HISTORY_UNAVAILABLE', error: 'fleet history is temporarily unavailable' });
  });
});

// ---------------------------------------------------------------------------
// Event-loop budget
// ---------------------------------------------------------------------------

describe('event-loop budget', () => {
  it('keeps every blocking slice well under the 20 ms handler budget on a cold scan of 3,000 runs', async () => {
    const runs = privateDir('runs');
    const steps = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, kind: 'model', note: 'x'.repeat(200) }));
    for (let i = 0; i < 3000; i++) {
      const id = `run-bulk-${i}`;
      fs.writeFileSync(path.join(runs, `${id}.json`), JSON.stringify({
        id, goal: 'g', engine: i % 2 ? 'claude' : 'codex', provider: 'x',
        createdAt: iso(NOW - (i % 90) * DAY), updatedAt: iso(NOW - (i % 90) * DAY + 1000),
        budget: {}, usage: { estCostUsd: 0.01 }, tasks: [], steps, status: 'done',
        delegationScope: { sourceRepo: `/repos/r${i % 12}` },
      }), { mode: 0o600 });
    }
    const svc = await service();
    const histogram = monitorEventLoopDelay({ resolution: 1 });
    histogram.enable();
    const history = await svc.get({ days: 90, tzOffsetMinutes: 0 });
    histogram.disable();
    expect(history.totals.runsStarted).toBe(3000);
    // Nanoseconds. The target is 20 ms; the assertion leaves room for a loaded CI box.
    const maxMs = histogram.max / 1e6;
    expect(maxMs).toBeLessThan(60);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

describe('serializeFleetHistory', () => {
  it('is byte-identical to sanitizePublicJson over the whole response', async () => {
    const { serializeFleetHistory } = await import('../src/core/verse/fleet-history.js');
    const { sanitizePublicJson } = await import('../src/core/util/public-json.js');
    writeRun({ createdMs: NOW - HOUR, repo: path.join(tmpHome, 'dev', 'ghp_' + 'a'.repeat(36)) });
    writeRun({ createdMs: NOW - DAY, status: 'running', engine: 'codex' });
    writeProposal(proposal({ createdMs: NOW - HOUR, verifyResult: { passed: true } }));
    await writeDecision({ ts: iso(NOW - HOUR), proposalId: 'p', action: 'judged', verdict: 'noise' });
    const history = await (await service()).get({ days: 30, tzOffsetMinutes: 0 });
    expect(serializeFleetHistory(history)).toBe(JSON.stringify(sanitizePublicJson(history)));
  });

  it('memoizes the payload for an unchanged projection and rebuilds after a rescan', async () => {
    writeRun({ createdMs: NOW - HOUR });
    let clock = NOW;
    const svc = await service(() => clock);
    const first = await svc.getPayload({ days: 7, tzOffsetMinutes: 0 });
    expect(await svc.getPayload({ days: 7, tzOffsetMinutes: 0 })).toBe(first);
    writeRun({ createdMs: NOW - HOUR });
    clock += 60_000;
    const second = await svc.getPayload({ days: 7, tzOffsetMinutes: 0 });
    expect(JSON.parse(second).totals.runsStarted).toBe(2);
  });
});
