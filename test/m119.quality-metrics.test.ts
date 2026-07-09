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
import type { Proposal } from '../src/core/types.js';

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
};

const mockProposals: MockProposal[] = [];

vi.mock('../src/core/inbox/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/inbox/store.js')>();
  return {
    ...actual,
    listProposals: () => [...mockProposals] as Proposal[],
  };
});

beforeEach(() => {
  mockProposals.length = 0;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let _idSeq = 0;

function makeProposal(
  overrides: Partial<MockProposal> & { status: Proposal['status']; createdAt: string },
): MockProposal {
  return {
    id: `prop-m119-${_idSeq++}`,
    repo: '/repos/alpha',
    origin: 'backlog',
    kind: 'patch',
    title: 'test proposal',
    summary: 'summary',
    ...overrides,
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

  it('counts merged/rejected/pending correctly', async () => {
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
    expect(m.merged).toBe(2);   // applied + approved
    expect(m.rejected).toBe(2); // rejected + failed
    expect(m.pending).toBe(1);
    expect(m.acceptRate).toBeCloseTo(2 / 5);
    expect(m.rejectRate).toBeCloseTo(2 / 5);
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

  it('7d window excludes proposals older than 7 days', async () => {
    mockProposals.push(
      makeProposal({ status: 'applied', createdAt: daysAgo(6) }),  // in window
      makeProposal({ status: 'applied', createdAt: daysAgo(8) }),  // outside
    );

    const { computeQualityMetrics } = await import('../src/core/fleet/quality-metrics.js');
    const m = computeQualityMetrics('7d');

    expect(m.proposalsCreated).toBe(1);
    expect(m.merged).toBe(1);
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
      repo: '/repos/alpha',
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
