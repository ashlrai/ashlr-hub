/**
 * m119.quality-metrics.test.ts — fleet oversight data layer tests.
 *
 * Units under test:
 *   1. computeQualityMetrics — rates, per-engine breakdown, trivialRatio
 *   2. decisions-ledger — recordDecision + readDecisions round-trip, never-throws
 *   3. store.setStatus hook — records a ledger entry without changing existing behavior
 *   4. scorecard --json shape
 *
 * Hermetic: HOME is relocated to a tmp dir. listProposals is mocked.
 * Conventions mirror m88.fleet-digest.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hashDiff, signJudgeAttestation } from '../src/core/foundry/provenance.js';
import type { Proposal, RealizedMergeEvidence } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
const origAshlrHome = process.env.ASHLR_HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m119-home-'));
  process.env.HOME = tmpHome;
  process.env.ASHLR_HOME = path.join(tmpHome, '.ashlr');
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  if (origAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = origAshlrHome;
});

// ---------------------------------------------------------------------------
// Mocks — listProposals
// ---------------------------------------------------------------------------

type MockProposal = Pick<Proposal,
  'id' | 'repo' | 'status' | 'createdAt' | 'origin' | 'kind' | 'title' | 'summary'
> & {
  engineModel?: string;
  diff?: string;
  verifyResult?: { passed: boolean; failed?: string[] };
  realizedMerge?: RealizedMergeEvidence;
};

const mockProposals: MockProposal[] = [];
let mockProposalSourceComplete = true;

vi.mock('../src/core/inbox/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/inbox/store.js')>();
  return {
    ...actual,
    listProposals: () => [...mockProposals] as Proposal[],
    listProposalsDetailed: () => ({
      proposals: [...mockProposals] as Proposal[],
      sourceState: mockProposalSourceComplete
        ? (mockProposals.length > 0 ? 'healthy' : 'missing')
        : 'degraded',
      sourcePresent: mockProposals.length > 0,
      complete: mockProposalSourceComplete,
      stopReasons: mockProposalSourceComplete ? [] : ['invalid-file'],
      filesDiscovered: mockProposals.length,
      filesRead: mockProposals.length,
      bytesRead: 0,
      invalidFiles: mockProposalSourceComplete ? 0 : 1,
      unreadableFiles: 0,
    }),
  };
});

beforeEach(() => {
  mockProposals.length = 0;
  mockProposalSourceComplete = true;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let _idSeq = 0;

function makeProposal(
  overrides: Partial<MockProposal> & { status: Proposal['status']; createdAt: string },
): MockProposal {
  const proposal: MockProposal = {
    id: `prop-m119-${_idSeq++}`,
    repo: '/repos/alpha',
    origin: 'backlog',
    kind: 'patch',
    title: 'test proposal',
    summary: 'summary',
    ...overrides,
  };
  if (proposal.status === 'applied' && !Object.hasOwn(overrides, 'realizedMerge')) {
    proposal.realizedMerge = localMergeEvidence(proposal.createdAt);
  }
  return proposal;
}

function localMergeEvidence(observedAt: string): RealizedMergeEvidence {
  return {
    schemaVersion: 1,
    source: 'local-default-branch',
    base: 'main',
    baseBeforeOid: '1'.repeat(40),
    proposalHeadOid: '2'.repeat(40),
    mergeCommitOid: '3'.repeat(40),
    observedAt,
  };
}

/** A substantial diff with 10 changed lines. */
const SUBSTANTIAL_DIFF = [
  '--- a/foo.ts',
  '+++ b/foo.ts',
  '@@ -1,5 +1,5 @@',
  '-const a = 1;',
  '-const b = 2;',
  '-const c = 3;',
  '-const d = 4;',
  '-const e = 5;',
  '+const a = 10;',
  '+const b = 20;',
  '+const c = 30;',
  '+const d = 40;',
  '+const e = 50;',
].join('\n');

/** A trivial diff with only 2 changed lines. */
const TRIVIAL_DIFF = [
  '--- a/foo.ts',
  '+++ b/foo.ts',
  '@@ -1,1 +1,1 @@',
  '-// old comment',
  '+// new comment',
].join('\n');

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// 1. computeQualityMetrics
// ---------------------------------------------------------------------------

describe('m119 computeQualityMetrics', () => {
  it('returns zeroed metrics when no proposals exist', async () => {
    const { computeQualityMetrics } = await import('../src/core/fleet/quality-metrics.js');
    const m = computeQualityMetrics('7d');
    expect(m.proposalsCreated).toBe(0);
    expect(m.merged).toBe(0);
    expect(m.rejected).toBe(0);
    expect(m.pending).toBe(0);
    expect(m.acceptRate).toBe(0);
    expect(m.rejectRate).toBe(0);
    expect(m.trivialRatio).toBe(0);
    expect(m.emptyRate).toBe(0);
    expect(m.avgDiffLines).toBe(0);
    expect(m.byEngine).toEqual({});
    expect(m.byRepo).toEqual({});
  });

  it('counts only evidence-qualified applied proposals as merged', async () => {
    mockProposals.push(
      makeProposal({ status: 'applied',  createdAt: daysAgo(1) }),
      makeProposal({ status: 'approved', createdAt: daysAgo(2) }),
      makeProposal({ status: 'rejected', createdAt: daysAgo(2) }),
      makeProposal({ status: 'failed',   createdAt: daysAgo(3) }),
      makeProposal({ status: 'pending',  createdAt: daysAgo(1) }),
    );

    const { computeQualityMetrics } = await import('../src/core/fleet/quality-metrics.js');
    const m = computeQualityMetrics('30d');

    expect(m.proposalsCreated).toBe(5);
    expect(m.merged).toBe(1);   // applied only; approved is authorization
    expect(m.rejected).toBe(2); // rejected + failed
    expect(m.pending).toBe(1);
    expect(m.acceptRate).toBeCloseTo(1 / 5);
    expect(m.rejectRate).toBeCloseTo(2 / 5);
  });

  it('does not credit branch/manual applied status without an exact witness', async () => {
    mockProposals.push(
      makeProposal({
        status: 'applied',
        createdAt: daysAgo(1),
        engineModel: 'codex:gpt-5.5',
        realizedMerge: undefined,
      }),
    );

    const { computeQualityMetrics } = await import('../src/core/fleet/quality-metrics.js');
    const metrics = computeQualityMetrics('7d');

    expect(metrics.merged).toBe(0);
    expect(metrics.acceptRate).toBe(0);
    expect(metrics.byEngine['codex:gpt-5.5']?.merged).toBe(0);
  });

  it('returns neutral metrics instead of learning from a partial proposal source', async () => {
    mockProposals.push(makeProposal({ status: 'applied', createdAt: daysAgo(1) }));
    mockProposalSourceComplete = false;

    const { computeQualityMetrics } = await import('../src/core/fleet/quality-metrics.js');
    const metrics = computeQualityMetrics('7d');

    expect(metrics.proposalsCreated).toBe(0);
    expect(metrics.merged).toBe(0);
    expect(metrics.byEngine).toEqual({});
  });

  it('does not give approved proposals aggregate or per-engine merge credit', async () => {
    mockProposals.push(
      makeProposal({
        status: 'approved',
        createdAt: daysAgo(1),
        engineModel: 'codex:gpt-5.5',
      }),
    );

    const { computeQualityMetrics } = await import('../src/core/fleet/quality-metrics.js');
    const m = computeQualityMetrics('7d');

    expect(m.merged).toBe(0);
    expect(m.acceptRate).toBe(0);
    expect(m.byEngine['codex:gpt-5.5']?.merged).toBe(0);
    expect(m.byEngine['codex:gpt-5.5']?.acceptRate).toBe(0);
  });

  it('trivialRatio: detects trivial diff (≤6 changed lines)', async () => {
    mockProposals.push(
      makeProposal({ status: 'applied', createdAt: daysAgo(1), diff: TRIVIAL_DIFF }),
      makeProposal({ status: 'applied', createdAt: daysAgo(1), diff: SUBSTANTIAL_DIFF }),
    );

    const { computeQualityMetrics } = await import('../src/core/fleet/quality-metrics.js');
    const m = computeQualityMetrics('7d');

    expect(m.trivialRatio).toBeCloseTo(0.5); // 1 of 2
  });

  it('trivialRatio: detects trivial title pattern', async () => {
    mockProposals.push(
      makeProposal({ status: 'applied', createdAt: daysAgo(1), title: 'fix typo in README' }),
      makeProposal({ status: 'applied', createdAt: daysAgo(1), title: 'feat: big refactor', diff: SUBSTANTIAL_DIFF }),
    );

    const { computeQualityMetrics } = await import('../src/core/fleet/quality-metrics.js');
    const m = computeQualityMetrics('7d');

    expect(m.trivialRatio).toBeCloseTo(0.5);
  });

  it('emptyRate: proposals without diff counted correctly', async () => {
    mockProposals.push(
      makeProposal({ status: 'pending', createdAt: daysAgo(1) }), // no diff
      makeProposal({ status: 'pending', createdAt: daysAgo(1), diff: SUBSTANTIAL_DIFF }),
    );

    const { computeQualityMetrics } = await import('../src/core/fleet/quality-metrics.js');
    const m = computeQualityMetrics('7d');

    expect(m.withDiff).toBe(1);
    expect(m.emptyRate).toBeCloseTo(0.5);
  });

  it('verifyPassRate: computed from verifyResult fields', async () => {
    mockProposals.push(
      makeProposal({ status: 'applied', createdAt: daysAgo(1), verifyResult: { passed: true } }),
      makeProposal({ status: 'applied', createdAt: daysAgo(1), verifyResult: { passed: false, failed: ['test-a'] } }),
      makeProposal({ status: 'pending', createdAt: daysAgo(1) }), // no verifyResult — excluded from rate
    );

    const { computeQualityMetrics } = await import('../src/core/fleet/quality-metrics.js');
    const m = computeQualityMetrics('7d');

    expect(m.verifyPassRate).toBeCloseTo(0.5); // 1/2
  });

  it('byEngine breakdown: keyed by engineModel', async () => {
    mockProposals.push(
      makeProposal({ status: 'applied', createdAt: daysAgo(1), engineModel: 'codex:gpt-5.5', diff: SUBSTANTIAL_DIFF }),
      makeProposal({ status: 'applied', createdAt: daysAgo(1), engineModel: 'codex:gpt-5.5' }),
      makeProposal({ status: 'rejected', createdAt: daysAgo(1), engineModel: 'claude:claude-opus-4' }),
      makeProposal({ status: 'pending',  createdAt: daysAgo(1), engineModel: 'codex:gpt-5.5' }),
    );

    const { computeQualityMetrics } = await import('../src/core/fleet/quality-metrics.js');
    const m = computeQualityMetrics('7d');

    // codex
    const codex = m.byEngine['codex:gpt-5.5'];
    expect(codex).toBeDefined();
    expect(codex!.created).toBe(3);
    expect(codex!.merged).toBe(2);
    expect(codex!.rejected).toBe(0);
    expect(codex!.acceptRate).toBeCloseTo(2 / 3);

    // claude
    const claude = m.byEngine['claude:claude-opus-4'];
    expect(claude).toBeDefined();
    expect(claude!.created).toBe(1);
    expect(claude!.merged).toBe(0);
    expect(claude!.rejected).toBe(1);
    expect(claude!.acceptRate).toBe(0);
  });

  it('byRepo: counts proposals per repo', async () => {
    mockProposals.push(
      makeProposal({ repo: '/repos/alpha', status: 'applied', createdAt: daysAgo(1) }),
      makeProposal({ repo: '/repos/alpha', status: 'pending', createdAt: daysAgo(1) }),
      makeProposal({ repo: '/repos/beta',  status: 'applied', createdAt: daysAgo(1) }),
    );

    const { computeQualityMetrics } = await import('../src/core/fleet/quality-metrics.js');
    const m = computeQualityMetrics('7d');

    expect(m.byRepo['/repos/alpha']).toBe(2);
    expect(m.byRepo['/repos/beta']).toBe(1);
  });

  it('7d merge window uses witness observation time instead of proposal creation', async () => {
    const recentlyRealized = makeProposal({ status: 'applied', createdAt: daysAgo(8) });
    recentlyRealized.realizedMerge = localMergeEvidence(daysAgo(6));
    const oldRealization = makeProposal({ status: 'applied', createdAt: daysAgo(1) });
    oldRealization.realizedMerge = localMergeEvidence(daysAgo(8));
    mockProposals.push(recentlyRealized, oldRealization);

    const { computeQualityMetrics } = await import('../src/core/fleet/quality-metrics.js');
    const m = computeQualityMetrics('7d');

    expect(m.proposalsCreated).toBe(1);
    expect(m.merged).toBe(1);
  });

  it('does not credit a future-dated realized witness', async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
    mockProposals.push(makeProposal({
      status: 'applied',
      createdAt: daysAgo(1),
      realizedMerge: localMergeEvidence(future),
    }));

    const { computeQualityMetrics } = await import('../src/core/fleet/quality-metrics.js');
    const m = computeQualityMetrics('7d');

    expect(m.proposalsCreated).toBe(0);
    expect(m.merged).toBe(0);
    expect(m.acceptRate).toBe(0);
  });

  it('deduplicates trend terminals and requires a realized witness', async () => {
    const realized = makeProposal({ status: 'applied', createdAt: daysAgo(1) });
    const bare = makeProposal({ status: 'pending', createdAt: daysAgo(1) });
    mockProposals.push(realized, bare);
    const { recordDecision } = await import('../src/core/fleet/decisions-ledger.js');
    const ts = daysAgo(1);
    for (const proposal of [realized, bare]) {
      recordDecision({ ts, proposalId: proposal.id, action: 'proposed' });
      recordDecision({
        ts,
        proposalId: proposal.id,
        action: 'merged',
        verdict: 'applied',
        labelBasis: 'realized-merge-v1',
      });
      recordDecision({
        ts,
        proposalId: proposal.id,
        action: 'merged',
        verdict: 'applied',
        labelBasis: 'realized-merge-v1',
      });
    }
    recordDecision({
      ts: new Date(Date.parse(ts) - 1_000).toISOString(),
      proposalId: realized.id,
      action: 'rejected',
      verdict: 'rejected',
    });

    const { computeQualityMetrics } = await import('../src/core/fleet/quality-metrics.js');
    const metrics = computeQualityMetrics('all');

    expect(metrics.trend).toHaveLength(1);
    expect(metrics.trend?.[0]).toMatchObject({ merged: 1, acceptRate: 0.5 });
  });

  it('does not let a legacy merged row borrow a current witness for trend credit', async () => {
    const realized = makeProposal({ status: 'applied', createdAt: daysAgo(1) });
    mockProposals.push(realized);
    const { recordDecision } = await import('../src/core/fleet/decisions-ledger.js');
    const ts = daysAgo(1);
    recordDecision({ ts, proposalId: realized.id, action: 'proposed' });
    recordDecision({ ts, proposalId: realized.id, action: 'merged', verdict: 'applied' });

    const { computeQualityMetrics } = await import('../src/core/fleet/quality-metrics.js');
    const metrics = computeQualityMetrics('all');

    expect(metrics.merged).toBe(1);
    expect(metrics.trend?.[0]).toMatchObject({ merged: 0, acceptRate: 0 });
  });

  it('never throws on bad/corrupt state', async () => {
    const { computeQualityMetrics } = await import('../src/core/fleet/quality-metrics.js');
    expect(() => computeQualityMetrics('all')).not.toThrow();
    expect(() => computeQualityMetrics('7d')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. decisions-ledger round-trip + never-throws
// ---------------------------------------------------------------------------

describe('m119 decisions-ledger', () => {
  it('keeps identity checks while tolerating Windows-emulated POSIX modes', async () => {
    const {
      isSafeDecisionAuthorityDirectory,
      isSafeDecisionAuthorityFile,
    } = await import('../src/core/fleet/decisions-ledger.js');
    const dir = path.join(tmpHome, 'windows-mode-fixture');
    const file = path.join(dir, 'decision.jsonl');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, '{}\n');
    const directoryStat = fs.statSync(dir);
    const fileStat = fs.statSync(file);
    Object.defineProperty(directoryStat, 'mode', { value: 0o40777 });
    Object.defineProperty(fileStat, 'mode', { value: 0o100666 });

    expect(isSafeDecisionAuthorityDirectory(directoryStat, 'win32')).toBe(true);
    expect(isSafeDecisionAuthorityFile(fileStat, 'win32')).toBe(true);
    expect(isSafeDecisionAuthorityDirectory(directoryStat, 'linux')).toBe(false);
    expect(isSafeDecisionAuthorityFile(fileStat, 'linux')).toBe(false);
  });

  it('recordDecision + readDecisions round-trips a basic entry', async () => {
    const { recordDecision, readDecisions } = await import('../src/core/fleet/decisions-ledger.js');

    recordDecision({
      ts: new Date().toISOString(),
      proposalId: 'prop-test-001',
      action: 'merged',
      engine: 'codex',
      model: 'codex:gpt-5.5',
      verdict: 'approved',
      reason: 'looks good',
    });

    const entries = readDecisions();
    expect(entries.length).toBe(1);
    expect(entries[0]!.proposalId).toBe('prop-test-001');
    expect(entries[0]!.action).toBe('merged');
    expect(entries[0]!.engine).toBe('codex');
    expect(entries[0]!.reason).toBe('looks good');
  });

  it('readDecisions filters by proposalId', async () => {
    const { recordDecision, readDecisions } = await import('../src/core/fleet/decisions-ledger.js');

    recordDecision({ ts: new Date().toISOString(), proposalId: 'prop-aaa', action: 'merged' });
    recordDecision({ ts: new Date().toISOString(), proposalId: 'prop-bbb', action: 'rejected' });

    const entries = readDecisions({ proposalId: 'prop-aaa' });
    expect(entries.length).toBe(1);
    expect(entries[0]!.proposalId).toBe('prop-aaa');
  });

  it('readDecisions respects limit', async () => {
    const { recordDecision, readDecisions } = await import('../src/core/fleet/decisions-ledger.js');

    for (let i = 0; i < 5; i++) {
      recordDecision({ ts: new Date().toISOString(), proposalId: `prop-${i}`, action: 'proposed' });
    }

    const entries = readDecisions({ limit: 2 });
    expect(entries.length).toBe(2);
  });

  it('scrubs secrets from detail field', async () => {
    const { recordDecision, readDecisions } = await import('../src/core/fleet/decisions-ledger.js');

    recordDecision({
      ts: new Date().toISOString(),
      proposalId: 'prop-secret',
      action: 'judged',
      detail: 'token=sk-abcdefghijklmnopqrstuvwxyz1234567890 was present',
    });

    const entries = readDecisions({ proposalId: 'prop-secret' });
    expect(entries.length).toBe(1);
    expect(entries[0]!.detail).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(entries[0]!.detail).toContain('[REDACTED]');
  });

  it('never throws on missing decisions dir', async () => {
    const { readDecisions } = await import('../src/core/fleet/decisions-ledger.js');
    // decisions dir does not exist in fresh tmpHome
    expect(() => readDecisions()).not.toThrow();
    expect(readDecisions()).toEqual([]);
  });

  it('never throws on corrupt JSONL line', async () => {
    const { readDecisions, decisionsDir } = await import('../src/core/fleet/decisions-ledger.js');

    const dir = decisionsDir();
    fs.mkdirSync(dir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.join(dir, `${today}.jsonl`), 'not-valid-json\n', 'utf8');
    fs.appendFileSync(
      path.join(dir, `${today}.jsonl`),
      JSON.stringify({ ts: new Date().toISOString(), proposalId: 'prop-ok', action: 'proposed' }) + '\n',
      'utf8',
    );

    let entries: ReturnType<typeof readDecisions> = [];
    expect(() => { entries = readDecisions(); }).not.toThrow();
    expect(entries.length).toBe(1);
    expect(entries[0]!.proposalId).toBe('prop-ok');
  });

  it('marks malformed newer evidence degraded and refuses complete authority reads', async () => {
    const { readDecisions, readDecisionsDetailed, decisionsDir } = await import('../src/core/fleet/decisions-ledger.js');
    const dir = decisionsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '2026-07-11.jsonl'),
      [
        JSON.stringify({ ts: '2026-07-11T10:00:00.000Z', proposalId: 'prop-authority', action: 'judged', verdict: 'ship' }),
        '{"ts":"2026-07-11T10:05:00.000Z","proposalId":"prop-authority","action":',
      ].join('\n') + '\n',
      'utf8',
    );

    const detailed = readDecisionsDetailed({ proposalId: 'prop-authority' });
    expect(detailed).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      invalidRows: 1,
      unreadableFiles: 0,
    });
    expect(detailed.decisions).toHaveLength(1);
    expect(readDecisions({ proposalId: 'prop-authority' })).toHaveLength(1);
    expect(readDecisions({ proposalId: 'prop-authority', requireComplete: true })).toEqual([]);
  });

  it('rejects invalid persisted timestamps instead of normalizing them to now', async () => {
    const { readDecisionsDetailed, decisionsDir } = await import('../src/core/fleet/decisions-ledger.js');
    const dir = decisionsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '2026-07-11.jsonl'),
      JSON.stringify({ ts: '', proposalId: 'prop-empty-ts', action: 'judged', verdict: 'ship' }) + '\n',
      'utf8',
    );

    const detailed = readDecisionsDetailed({ proposalId: 'prop-empty-ts' });
    expect(detailed.decisions).toEqual([]);
    expect(detailed).toMatchObject({ sourceState: 'degraded', complete: false, invalidRows: 1 });
  });

  it('fails closed when file, byte, or filesystem identity bounds prevent a complete read', async () => {
    const { readDecisions, readDecisionsDetailed, decisionsDir } = await import('../src/core/fleet/decisions-ledger.js');
    const dir = decisionsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '2026-07-10.jsonl'),
      JSON.stringify({ ts: '2026-07-10T10:00:00.000Z', proposalId: 'prop-old-ship', action: 'judged', verdict: 'ship' }) + '\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(dir, '2026-07-11.jsonl'),
      JSON.stringify({ ts: '2026-07-11T10:00:00.000Z', proposalId: 'other', action: 'proposed', detail: 'x'.repeat(512) }) + '\n',
      'utf8',
    );

    const fileLimited = readDecisionsDetailed({ proposalId: 'prop-old-ship', maxFiles: 1 });
    expect(fileLimited).toMatchObject({ sourceState: 'degraded', complete: false, stopReasons: ['file-limit'] });
    expect(readDecisions({ proposalId: 'prop-old-ship', maxFiles: 1, requireComplete: true })).toEqual([]);

    const byteLimited = readDecisionsDetailed({ proposalId: 'prop-old-ship', maxBytes: 64 });
    expect(byteLimited).toMatchObject({ sourceState: 'degraded', complete: false, stopReasons: ['byte-limit'] });

    const outside = path.join(tmpHome, 'outside-decisions.jsonl');
    fs.writeFileSync(outside, '{}\n', 'utf8');
    fs.rmSync(path.join(dir, '2026-07-11.jsonl'));
    fs.symlinkSync(outside, path.join(dir, '2026-07-11.jsonl'));
    const linked = readDecisionsDetailed({ proposalId: 'prop-old-ship' });
    expect(linked).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      stopReasons: ['io-error'],
      unreadableFiles: 1,
    });
    expect(readDecisions({ proposalId: 'prop-old-ship', requireComplete: true })).toEqual([]);

    fs.rmSync(path.join(dir, '2026-07-11.jsonl'));
    fs.linkSync(outside, path.join(dir, '2026-07-11.jsonl'));
    const hardLinked = readDecisionsDetailed({ proposalId: 'prop-old-ship' });
    expect(hardLinked).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      stopReasons: ['io-error'],
      unreadableFiles: 1,
    });
  });

  it('keeps an exact one-row bound complete', async () => {
    const { readDecisionsDetailed, decisionsDir } = await import('../src/core/fleet/decisions-ledger.js');
    const dir = decisionsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '2026-07-11.jsonl'),
      JSON.stringify({ ts: '2026-07-11T10:00:00.000Z', proposalId: 'prop-exact', action: 'proposed' }) + '\n',
      'utf8',
    );

    const detailed = readDecisionsDetailed({ proposalId: 'prop-exact', maxRows: 1, limit: 1 });
    expect(detailed).toMatchObject({
      sourceState: 'healthy',
      complete: true,
      rowsScanned: 1,
      stopReasons: [],
    });
    expect(detailed.decisions).toHaveLength(1);
  });

  it('uses append order to break equal-timestamp decision ties', async () => {
    const { readDecisionsDetailed, decisionsDir } = await import('../src/core/fleet/decisions-ledger.js');
    const dir = decisionsDir();
    fs.mkdirSync(dir, { recursive: true });
    const ts = '2026-07-11T10:00:00.000Z';
    fs.writeFileSync(
      path.join(dir, '2026-07-11.jsonl'),
      [
        JSON.stringify({ ts, proposalId: 'prop-tie', action: 'judged', verdict: 'ship' }),
        JSON.stringify({ ts, proposalId: 'prop-tie', action: 'judged', verdict: 'review' }),
      ].join('\n') + '\n',
      'utf8',
    );

    const detailed = readDecisionsDetailed({ proposalId: 'prop-tie' });
    expect(detailed.decisions.map((decision) => decision.verdict)).toEqual(['review', 'ship']);
    expect(detailed).toMatchObject({ sourceState: 'healthy', complete: true });
  });

  it('separates a new append from a torn prior row while preserving degraded source truth', async () => {
    const { recordDecision, readDecisionsDetailed, decisionsDir } = await import('../src/core/fleet/decisions-ledger.js');
    const dir = decisionsDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, new Date().toISOString().slice(0, 10) + '.jsonl');
    fs.writeFileSync(file, '{"torn":true', 'utf8');

    recordDecision({ ts: new Date().toISOString(), proposalId: 'prop-after-torn', action: 'rejected' });

    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).toContain('{"torn":true\n{');
    const detailed = readDecisionsDetailed({ proposalId: 'prop-after-torn' });
    expect(detailed.decisions).toHaveLength(1);
    expect(detailed).toMatchObject({ sourceState: 'degraded', complete: false, invalidRows: 1 });
  });

  it('normalizes and scrubs legacy decision rows on read', async () => {
    const { readDecisions, decisionsDir } = await import('../src/core/fleet/decisions-ledger.js');

    const proposalId = 'prop-legacy-decision';
    const judgeEngine = 'claude-opus-4-5';
    const attestation = signJudgeAttestation({
      proposalId,
      judgeEngine,
      verdict: 'ship',
      diffHash: hashDiff('legacy diff'),
    });
    const dir = decisionsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, '2026-07-08.jsonl'),
      JSON.stringify({
        ts: '2026-07-08T12:30:00.000Z',
        proposalId,
        workItemId: 'repo:test:legacy-decision',
        runId: 'run-legacy-decision',
        action: 'judged',
        engine: judgeEngine,
        verdict: 'ship',
        reason: 'token=sk-abcdefghijklmnopqrstuvwxyz1234567890 should be hidden',
        detail: 'raw detail with sk-abcdefghijklmnopqrstuvwxyz1234567890',
        judgeAttestation: attestation,
        costUsd: 0.42,
        tokensIn: 12,
        tokensOut: 34,
        durationMs: 56,
        cacheHit: true,
        rawPrompt: 'RAW_PROMPT_SENTINEL',
      }) + '\n',
      'utf8',
    );

    const [entry] = readDecisions({ proposalId });

    expect(entry).toMatchObject({
      proposalId,
      trajectoryId: 'run:run-legacy-decision',
      learningSource: 'decision-ledger',
      labelBasis: 'judge-verdict',
      routerPolicyVersion: 'fleet-router-v1',
      learningEpoch: '2026-07-08',
      costUsd: 0.42,
      tokensIn: 12,
      tokensOut: 34,
      durationMs: 56,
      cacheHit: true,
    });
    expect(entry?.judgeAttestation).toBe(attestation);
    expect(entry?.reason).toContain('[REDACTED]');
    expect(entry?.detail).toContain('[REDACTED]');
    expect(JSON.stringify(entry)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(JSON.stringify(entry)).not.toContain('RAW_PROMPT_SENTINEL');
  });

  it('recordDecision never throws on invalid input', async () => {
    const { recordDecision } = await import('../src/core/fleet/decisions-ledger.js');
    // Pass a minimal entry — ts missing (should default to now)
    expect(() => recordDecision({ ts: '', proposalId: '', action: 'proposed' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. store.setStatus hook — records ledger entry without breaking existing behavior
// ---------------------------------------------------------------------------

describe('m119 store.setStatus ledger hook', () => {
  it('records a rejection in the ledger without changing proposal behavior', async () => {
    // We cannot easily test the full store in unit tests without a real inbox dir,
    // so we seed a proposal file directly and call setStatus.
    const inboxPath = path.join(tmpHome, '.ashlr', 'inbox');
    fs.mkdirSync(inboxPath, { recursive: true });

    const proposal = {
      id: 'prop-hook-test-001',
      repo: fs.realpathSync.native(tmpHome),
      origin: 'backlog',
      kind: 'patch',
      title: 'hook test',
      summary: 'testing the hook',
      status: 'pending',
      createdAt: new Date().toISOString(),
      engineModel: 'codex:gpt-5.5',
    };
    fs.writeFileSync(
      path.join(inboxPath, 'prop-hook-test-001.json'),
      JSON.stringify(proposal, null, 2) + '\n',
      'utf8',
    );

    // Use the real store (not mocked in this describe block — vi.mock is module-level
    // so it applies, but we can import the real setStatus separately by re-resolving).
    // Since vi.mock replaces listProposals, we use the actual file-based store for setStatus.
    // We'll call the module directly (it's still the real implementation for setStatus).
    const storeModule = await import('../src/core/inbox/store.js');

    // setStatus should not throw
    expect(() => storeModule.setStatus('prop-hook-test-001', 'rejected', undefined, 'no diff')).not.toThrow();

    // The proposal file should now have status === 'rejected'
    const raw = fs.readFileSync(path.join(inboxPath, 'prop-hook-test-001.json'), 'utf8');
    const updated = JSON.parse(raw) as { status: string; decisionReason?: string };
    expect(updated.status).toBe('rejected');
    expect(updated.decisionReason).toBe('no diff');

    // The ledger should have an entry
    const { readDecisions } = await import('../src/core/fleet/decisions-ledger.js');
    const entries = readDecisions({ proposalId: 'prop-hook-test-001' });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]!.action).toBe('rejected');
    expect(entries[0]!.model).toBe('codex:gpt-5.5');
    expect(entries[0]!.reason).toBe('no diff');
  });

  it('setStatus without reason param behaves identically to before M119', async () => {
    const inboxPath = path.join(tmpHome, '.ashlr', 'inbox');
    fs.mkdirSync(inboxPath, { recursive: true });

    const proposal = {
      id: 'prop-hook-test-002',
      repo: null,
      origin: 'manual',
      kind: 'note',
      title: 'compat check',
      summary: 'no reason param',
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(inboxPath, 'prop-hook-test-002.json'),
      JSON.stringify(proposal, null, 2) + '\n',
      'utf8',
    );

    const storeModule = await import('../src/core/inbox/store.js');
    expect(() => storeModule.setStatus('prop-hook-test-002', 'approved')).not.toThrow();

    const raw = fs.readFileSync(path.join(inboxPath, 'prop-hook-test-002.json'), 'utf8');
    const updated = JSON.parse(raw) as { status: string; decisionReason?: string };
    expect(updated.status).toBe('approved');
    // reason was not passed — decisionReason should be absent
    expect(updated.decisionReason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. scorecard --json shape
// ---------------------------------------------------------------------------

describe('m119 scorecard --json shape', () => {
  it('--json output matches QualityMetrics shape with correct fields', async () => {
    mockProposals.push(
      makeProposal({ status: 'applied',  createdAt: daysAgo(1), engineModel: 'codex:gpt-5.5', diff: SUBSTANTIAL_DIFF }),
      makeProposal({ status: 'rejected', createdAt: daysAgo(2), engineModel: 'claude:opus' }),
      makeProposal({ status: 'pending',  createdAt: daysAgo(1) }),
    );

    const { computeQualityMetrics } = await import('../src/core/fleet/quality-metrics.js');
    const m = computeQualityMetrics('7d');
    const json = JSON.parse(JSON.stringify(m)) as typeof m;

    // Required top-level fields
    expect(typeof json.window).toBe('string');
    expect(typeof json.proposalsCreated).toBe('number');
    expect(typeof json.merged).toBe('number');
    expect(typeof json.rejected).toBe('number');
    expect(typeof json.pending).toBe('number');
    expect(typeof json.withDiff).toBe('number');
    expect(typeof json.emptyRate).toBe('number');
    expect(typeof json.trivialRatio).toBe('number');
    expect(typeof json.acceptRate).toBe('number');
    expect(typeof json.rejectRate).toBe('number');
    expect(typeof json.verifyPassRate).toBe('number');
    expect(typeof json.avgDiffLines).toBe('number');
    expect(typeof json.byEngine).toBe('object');
    expect(typeof json.byRepo).toBe('object');

    // byEngine entries have EngineQuality shape
    for (const eq of Object.values(json.byEngine)) {
      expect(typeof eq.created).toBe('number');
      expect(typeof eq.merged).toBe('number');
      expect(typeof eq.rejected).toBe('number');
      expect(typeof eq.acceptRate).toBe('number');
      expect(typeof eq.avgDiffLines).toBe('number');
      expect(typeof eq.trivialRatio).toBe('number');
    }

    // Correct values
    expect(json.proposalsCreated).toBe(3);
    expect(json.merged).toBe(1);
    expect(json.rejected).toBe(1);
    expect(json.pending).toBe(1);
    expect(json.window).toBe('7d');
  });
});
