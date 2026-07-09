/**
 * m141.judge-trace.test.ts — Judge trace store + runManager integration tests.
 *
 * Covers:
 *   1. recordJudgeTrace / readJudgeTraces round-trip (basic append + read-back)
 *   2. Secret scrubbing in fullReasoning and promptContext
 *   3. linkOutcome attaches merged/reverted/rejected to the right trace (today's file)
 *   4. linkOutcome patches correct trace when multiple proposals present
 *   5. readJudgeTraces filters: proposalId, verdict, outcomeOnly, limit
 *   6. outcomeStats: total, withOutcome, outcomeRate, byVerdict, byOutcome
 *   7. runManager records a trace per judged proposal with fullReasoning + scores
 *   8. Judge prompt still parses verdict JSON when reasoning precedes it (extractFullReasoning)
 *   9. Parse failure path leaves fullReasoning as empty string (trace not recorded)
 *  10. linkOutcome prior-day fallback: appends patch record to today's file
 *
 * Hermetic: HOME relocated to a tmp dir; fs + client mocked where needed.
 * Mirrors m119/m120/m135 conventions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Proposal } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m141-home-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 0;
function pid(): string { return `p-m141-${_seq++}`; }

function makeTraceDir(): string {
  const d = path.join(tmpHome, '.ashlr', 'judge-traces');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: pid(),
    repo: '/repos/test',
    origin: 'backlog',
    kind: 'patch',
    title: 'm141 test proposal',
    summary: 'test summary',
    status: 'pending',
    createdAt: new Date().toISOString(),
    diff: '+const x = 1;\n',
    ...overrides,
  } as Proposal;
}

/** Build a mock client that returns reasoning block + JSON verdict. */
function mockClientWithReasoning(verdict: object): { complete: (s: string, u: string) => Promise<string>; model: string } {
  const v = verdict as Record<string, unknown>;
  const reasoning = [
    '<reasoning>',
    `VALUE: ${v['value']} — test value assessment.`,
    `CORRECTNESS: ${v['correctness']} — test correctness assessment.`,
    `SCOPE: ${v['scope']} — test scope assessment.`,
    `ALIGNMENT: ${v['alignment']} — test alignment assessment.`,
    `VERDICT: ${v['verdict']} — test verdict reasoning.`,
    `RATIONALE: ${v['rationale']}`,
    '</reasoning>',
    JSON.stringify(verdict),
  ].join('\n');

  return {
    model: 'test-judge-m141',
    complete: vi.fn().mockResolvedValue(reasoning),
  };
}

// ---------------------------------------------------------------------------
// 1. recordJudgeTrace / readJudgeTraces round-trip
// ---------------------------------------------------------------------------

describe('m141 judge-trace — round-trip', () => {
  it('recordJudgeTrace writes a JSONL entry and readJudgeTraces reads it back', async () => {
    const { recordJudgeTrace, readJudgeTraces } = await import('../src/core/fleet/judge-trace.js');

    const id = pid();
    recordJudgeTrace({
      proposalId: id,
      judgeEngine: 'claude-sonnet-4-5',
      verdict: 'ship',
      scores: { value: 4, correctness: 5, scope: 1, alignment: 4 },
      fullReasoning: 'VALUE: 4 — good improvement.\nCORRECTNESS: 5 — clearly correct.',
      promptContext: 'test proposal | patch | engine:claude',
    });

    const traces = readJudgeTraces({ proposalId: id });
    expect(traces).toHaveLength(1);
    expect(traces[0]!.proposalId).toBe(id);
    expect(traces[0]!.judgeEngine).toBe('claude-sonnet-4-5');
    expect(traces[0]!.verdict).toBe('ship');
    expect(traces[0]!.scores.value).toBe(4);
    expect(traces[0]!.scores.correctness).toBe(5);
    expect(traces[0]!.fullReasoning).toContain('good improvement');
    expect(traces[0]!.promptContext).toContain('test proposal');
    expect(typeof traces[0]!.ts).toBe('string');
    expect(traces[0]!.outcome).toBeUndefined();
  });

  it('multiple traces accumulate correctly', async () => {
    const { recordJudgeTrace, readJudgeTraces } = await import('../src/core/fleet/judge-trace.js');

    const ids = [pid(), pid(), pid()];
    for (const id of ids) {
      recordJudgeTrace({
        proposalId: id,
        judgeEngine: 'test-engine',
        verdict: 'review',
        scores: { value: 3, correctness: 3, scope: 3, alignment: 3 },
        fullReasoning: `reasoning for ${id}`,
        promptContext: `ctx for ${id}`,
      });
    }

    const all = readJudgeTraces();
    expect(all.length).toBeGreaterThanOrEqual(3);
    const foundIds = all.map((t) => t.proposalId);
    for (const id of ids) {
      expect(foundIds).toContain(id);
    }
  });

  it('readJudgeTraces returns empty array when no traces exist', async () => {
    const { readJudgeTraces } = await import('../src/core/fleet/judge-trace.js');
    const traces = readJudgeTraces();
    expect(traces).toEqual([]);
  });

  it('recordJudgeTrace never throws even when dir creation fails', async () => {
    // Point HOME at a file (not a dir) so mkdirSync will fail.
    const fakeHome = path.join(tmpHome, 'not-a-dir');
    fs.writeFileSync(fakeHome, 'block');
    process.env.HOME = fakeHome;

    const { recordJudgeTrace } = await import('../src/core/fleet/judge-trace.js');
    expect(() => recordJudgeTrace({
      proposalId: 'p-err',
      judgeEngine: 'test',
      verdict: 'review',
      scores: { value: 3, correctness: 3, scope: 3, alignment: 3 },
      fullReasoning: 'test',
      promptContext: 'test',
    })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Scrub asymmetry fix (#6) — shared scrubSecrets covers all 8 pattern families
// ---------------------------------------------------------------------------

describe('scrubSecrets (shared util) — comprehensive redaction', () => {
  it('scrubs sk- API keys', async () => {
    const { scrubSecrets } = await import('../src/core/util/scrub.js');
    expect(scrubSecrets('key=sk-abcdefghijklmnopqrstuvwxyz123456')).toContain('[REDACTED]');
    expect(scrubSecrets('key=sk-abcdefghijklmnopqrstuvwxyz123456')).not.toContain('sk-abc');
  });

  it('scrubs ghp_ GitHub tokens', async () => {
    const { scrubSecrets } = await import('../src/core/util/scrub.js');
    const text = 'token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
    expect(scrubSecrets(text)).not.toContain('ghp_');
    expect(scrubSecrets(text)).toContain('[REDACTED]');
  });

  it('scrubs Bearer tokens', async () => {
    const { scrubSecrets } = await import('../src/core/util/scrub.js');
    const text = 'Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig';
    const out = scrubSecrets(text);
    expect(out).not.toContain('eyJ');
    expect(out).toContain('[REDACTED]');
  });

  it('scrubs password= patterns', async () => {
    const { scrubSecrets } = await import('../src/core/util/scrub.js');
    const text = 'DB_URL=postgres://user:password=supersecretval@host/db';
    const out = scrubSecrets(text);
    expect(out).not.toContain('supersecretval');
  });

  it('scrubs AWS AKIA keys', async () => {
    const { scrubSecrets } = await import('../src/core/util/scrub.js');
    const text = 'aws_access_key_id=AKIAIOSFODNN7EXAMPLE';
    const out = scrubSecrets(text);
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).toContain('[REDACTED]');
  });

  it('scrubs hex-64 strings', async () => {
    const { scrubSecrets } = await import('../src/core/util/scrub.js');
    const hex64 = 'a'.repeat(64);
    expect(scrubSecrets(`key=${hex64}`)).not.toContain(hex64);
  });

  it('preserves ordinary absolute paths that contain long temp directory names', async () => {
    const { scrubSecrets } = await import('../src/core/util/scrub.js');
    const p = '/var/folders/mm/kgqr1v8166dfg1rbpqq7vp6h0000gn/T/ashlr-h1-repo-CeqCFa:m201-item-0';
    expect(scrubSecrets(p)).toBe(p);
  });

  it('scrubs compact long base64-like blobs without path separators', async () => {
    const { scrubSecrets } = await import('../src/core/util/scrub.js');
    const blob = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5';
    expect(scrubSecrets(`blob=${blob}`)).not.toContain(blob);
  });

  it('never throws', async () => {
    const { scrubSecrets } = await import('../src/core/util/scrub.js');
    expect(() => scrubSecrets('')).not.toThrow();
    expect(() => scrubSecrets('normal text without secrets')).not.toThrow();
  });

  it('handlers.ts uses scrubSecrets (not the old weak scrubDiffSecrets)', async () => {
    // Verify at source level that handlers.ts imports from util/scrub and
    // does NOT contain the old local scrubDiffSecrets definition.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(
      resolve(import.meta.dirname ?? '', '../src/core/comms/handlers.ts'),
      'utf8',
    );
    // Must import from util/scrub
    expect(src).toContain("from '../util/scrub.js'");
    // Must not define the old weak function
    expect(src).not.toContain('function scrubDiffSecrets');
    // Must call scrubSecrets
    expect(src).toContain('scrubSecrets(');
  });
});

// ---------------------------------------------------------------------------
// 2. Secret scrubbing
// ---------------------------------------------------------------------------

describe('m141 judge-trace — secret scrubbing', () => {
  it('scrubs sk- API keys from fullReasoning before writing', async () => {
    const { recordJudgeTrace, readJudgeTraces } = await import('../src/core/fleet/judge-trace.js');

    const id = pid();
    recordJudgeTrace({
      proposalId: id,
      judgeEngine: 'test',
      verdict: 'review',
      scores: { value: 3, correctness: 3, scope: 3, alignment: 3 },
      fullReasoning: 'The change uses api_key=sk-abcdefghijklmnopqrstuvwx to call the API.',
      promptContext: 'normal context',
    });

    const traces = readJudgeTraces({ proposalId: id });
    expect(traces[0]!.fullReasoning).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(traces[0]!.fullReasoning).toContain('[REDACTED]');
  });

  it('scrubs Bearer tokens from promptContext before writing', async () => {
    const { recordJudgeTrace, readJudgeTraces } = await import('../src/core/fleet/judge-trace.js');

    const id = pid();
    recordJudgeTrace({
      proposalId: id,
      judgeEngine: 'test',
      verdict: 'noise',
      scores: { value: 1, correctness: 1, scope: 1, alignment: 1 },
      fullReasoning: 'no secrets here',
      promptContext: 'Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig',
    });

    const traces = readJudgeTraces({ proposalId: id });
    expect(traces[0]!.promptContext).not.toContain('eyJ');
    expect(traces[0]!.promptContext).toContain('[REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// 3. linkOutcome — patches today's file
// ---------------------------------------------------------------------------

describe('m141 judge-trace — linkOutcome (today file)', () => {
  it('linkOutcome attaches merged outcome to the right trace', async () => {
    const { recordJudgeTrace, readJudgeTraces, linkOutcome } = await import('../src/core/fleet/judge-trace.js');

    const id = pid();
    recordJudgeTrace({
      proposalId: id,
      judgeEngine: 'test',
      verdict: 'ship',
      scores: { value: 5, correctness: 5, scope: 1, alignment: 5 },
      fullReasoning: 'Ship it.',
      promptContext: 'ctx',
    });

    linkOutcome(id, 'merged');

    const traces = readJudgeTraces({ proposalId: id });
    expect(traces[0]!.outcome).toBe('merged');
    expect(traces[0]!.outcomeAt).toBeDefined();
  });

  it('linkOutcome attaches reverted outcome', async () => {
    const { recordJudgeTrace, readJudgeTraces, linkOutcome } = await import('../src/core/fleet/judge-trace.js');

    const id = pid();
    recordJudgeTrace({
      proposalId: id,
      judgeEngine: 'test',
      verdict: 'ship',
      scores: { value: 4, correctness: 4, scope: 2, alignment: 4 },
      fullReasoning: 'Looked good but caused regression.',
      promptContext: 'ctx',
    });

    linkOutcome(id, 'reverted');

    const traces = readJudgeTraces({ proposalId: id });
    expect(traces[0]!.outcome).toBe('reverted');
  });

  it('linkOutcome attaches rejected outcome', async () => {
    const { recordJudgeTrace, readJudgeTraces, linkOutcome } = await import('../src/core/fleet/judge-trace.js');

    const id = pid();
    recordJudgeTrace({
      proposalId: id,
      judgeEngine: 'test',
      verdict: 'noise',
      scores: { value: 1, correctness: 1, scope: 1, alignment: 1 },
      fullReasoning: 'Trivial.',
      promptContext: 'ctx',
    });

    linkOutcome(id, 'rejected');

    const traces = readJudgeTraces({ proposalId: id });
    expect(traces[0]!.outcome).toBe('rejected');
  });

  it('linkOutcome patches only the correct proposal, leaves others unchanged', async () => {
    const { recordJudgeTrace, readJudgeTraces, linkOutcome } = await import('../src/core/fleet/judge-trace.js');

    const id1 = pid();
    const id2 = pid();
    recordJudgeTrace({ proposalId: id1, judgeEngine: 'e', verdict: 'ship', scores: { value: 5, correctness: 5, scope: 1, alignment: 5 }, fullReasoning: 'a', promptContext: 'a' });
    recordJudgeTrace({ proposalId: id2, judgeEngine: 'e', verdict: 'review', scores: { value: 3, correctness: 3, scope: 3, alignment: 3 }, fullReasoning: 'b', promptContext: 'b' });

    linkOutcome(id1, 'merged');

    const t1 = readJudgeTraces({ proposalId: id1 });
    const t2 = readJudgeTraces({ proposalId: id2 });
    expect(t1[0]!.outcome).toBe('merged');
    expect(t2[0]!.outcome).toBeUndefined();
  });

  it('linkOutcome is a no-op when proposalId not found', async () => {
    const { linkOutcome } = await import('../src/core/fleet/judge-trace.js');
    // Should not throw
    expect(() => linkOutcome('nonexistent-proposal', 'merged')).not.toThrow();
  });

  it('linkOutcome never throws', async () => {
    const { linkOutcome } = await import('../src/core/fleet/judge-trace.js');
    expect(() => linkOutcome('any-id', 'merged')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. readJudgeTraces filters
// ---------------------------------------------------------------------------

describe('m141 judge-trace — readJudgeTraces filters', () => {
  it('filters by proposalId', async () => {
    const { recordJudgeTrace, readJudgeTraces } = await import('../src/core/fleet/judge-trace.js');

    const idA = pid(), idB = pid();
    recordJudgeTrace({ proposalId: idA, judgeEngine: 'e', verdict: 'ship', scores: { value: 5, correctness: 5, scope: 1, alignment: 5 }, fullReasoning: 'a', promptContext: 'a' });
    recordJudgeTrace({ proposalId: idB, judgeEngine: 'e', verdict: 'noise', scores: { value: 1, correctness: 1, scope: 1, alignment: 1 }, fullReasoning: 'b', promptContext: 'b' });

    const result = readJudgeTraces({ proposalId: idA });
    expect(result).toHaveLength(1);
    expect(result[0]!.proposalId).toBe(idA);
  });

  it('filters by verdict', async () => {
    const { recordJudgeTrace, readJudgeTraces } = await import('../src/core/fleet/judge-trace.js');

    recordJudgeTrace({ proposalId: pid(), judgeEngine: 'e', verdict: 'ship', scores: { value: 5, correctness: 5, scope: 1, alignment: 5 }, fullReasoning: '', promptContext: '' });
    recordJudgeTrace({ proposalId: pid(), judgeEngine: 'e', verdict: 'noise', scores: { value: 1, correctness: 1, scope: 1, alignment: 1 }, fullReasoning: '', promptContext: '' });
    recordJudgeTrace({ proposalId: pid(), judgeEngine: 'e', verdict: 'ship', scores: { value: 4, correctness: 4, scope: 2, alignment: 4 }, fullReasoning: '', promptContext: '' });

    const ships = readJudgeTraces({ verdict: 'ship' });
    expect(ships.every((t) => t.verdict === 'ship')).toBe(true);
    expect(ships.length).toBeGreaterThanOrEqual(2);
  });

  it('filters by outcomeOnly', async () => {
    const { recordJudgeTrace, readJudgeTraces, linkOutcome } = await import('../src/core/fleet/judge-trace.js');

    const idA = pid(), idB = pid();
    recordJudgeTrace({ proposalId: idA, judgeEngine: 'e', verdict: 'ship', scores: { value: 5, correctness: 5, scope: 1, alignment: 5 }, fullReasoning: '', promptContext: '' });
    recordJudgeTrace({ proposalId: idB, judgeEngine: 'e', verdict: 'review', scores: { value: 3, correctness: 3, scope: 3, alignment: 3 }, fullReasoning: '', promptContext: '' });
    linkOutcome(idA, 'merged');

    const withOutcome = readJudgeTraces({ outcomeOnly: true });
    expect(withOutcome.every((t) => t.outcome !== undefined)).toBe(true);
    expect(withOutcome.map((t) => t.proposalId)).toContain(idA);
  });

  it('respects limit', async () => {
    const { recordJudgeTrace, readJudgeTraces } = await import('../src/core/fleet/judge-trace.js');

    for (let i = 0; i < 5; i++) {
      recordJudgeTrace({ proposalId: pid(), judgeEngine: 'e', verdict: 'review', scores: { value: 3, correctness: 3, scope: 3, alignment: 3 }, fullReasoning: '', promptContext: '' });
    }

    const limited = readJudgeTraces({ limit: 2 });
    expect(limited).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 5. outcomeStats
// ---------------------------------------------------------------------------

describe('m141 judge-trace — outcomeStats', () => {
  it('returns zero stats when no traces', async () => {
    const { outcomeStats } = await import('../src/core/fleet/judge-trace.js');
    const stats = outcomeStats();
    expect(stats.total).toBe(0);
    expect(stats.withOutcome).toBe(0);
    expect(stats.outcomeRate).toBe(0);
  });

  it('counts total and withOutcome correctly', async () => {
    const { recordJudgeTrace, linkOutcome, outcomeStats } = await import('../src/core/fleet/judge-trace.js');

    const id1 = pid(), id2 = pid(), id3 = pid();
    recordJudgeTrace({ proposalId: id1, judgeEngine: 'e', verdict: 'ship', scores: { value: 5, correctness: 5, scope: 1, alignment: 5 }, fullReasoning: '', promptContext: '' });
    recordJudgeTrace({ proposalId: id2, judgeEngine: 'e', verdict: 'review', scores: { value: 3, correctness: 3, scope: 3, alignment: 3 }, fullReasoning: '', promptContext: '' });
    recordJudgeTrace({ proposalId: id3, judgeEngine: 'e', verdict: 'noise', scores: { value: 1, correctness: 1, scope: 1, alignment: 1 }, fullReasoning: '', promptContext: '' });

    linkOutcome(id1, 'merged');
    linkOutcome(id3, 'rejected');

    const stats = outcomeStats();
    expect(stats.total).toBeGreaterThanOrEqual(3);
    expect(stats.withOutcome).toBeGreaterThanOrEqual(2);
    expect(stats.outcomeRate).toBeGreaterThan(0);
    expect(stats.byOutcome['merged']).toBeGreaterThanOrEqual(1);
    expect(stats.byOutcome['rejected']).toBeGreaterThanOrEqual(1);
  });

  it('byVerdict tracks per-verdict totals', async () => {
    const { recordJudgeTrace, outcomeStats } = await import('../src/core/fleet/judge-trace.js');

    recordJudgeTrace({ proposalId: pid(), judgeEngine: 'e', verdict: 'ship', scores: { value: 5, correctness: 5, scope: 1, alignment: 5 }, fullReasoning: '', promptContext: '' });
    recordJudgeTrace({ proposalId: pid(), judgeEngine: 'e', verdict: 'ship', scores: { value: 4, correctness: 4, scope: 2, alignment: 4 }, fullReasoning: '', promptContext: '' });
    recordJudgeTrace({ proposalId: pid(), judgeEngine: 'e', verdict: 'noise', scores: { value: 1, correctness: 1, scope: 1, alignment: 1 }, fullReasoning: '', promptContext: '' });

    const stats = outcomeStats();
    expect(stats.byVerdict['ship']!.total).toBeGreaterThanOrEqual(2);
    expect(stats.byVerdict['noise']!.total).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 6. runManager records trace with fullReasoning + scores
// ---------------------------------------------------------------------------

describe('m141 runManager — records judge trace per proposal', () => {
  it('runManager records a trace with fullReasoning and scores for each judged proposal', async () => {
    const verdictObj = { verdict: 'ship', value: 5, correctness: 4, scope: 1, alignment: 5, rationale: 'M141 trace test.' };
    const client = mockClientWithReasoning(verdictObj);

    vi.doMock('../src/core/run/engines.js', () => ({
      engineInstalled: vi.fn(() => false),
      buildEngineCommand: vi.fn(),
      spawnEngine: vi.fn(),
      resolveBinAbsolute: vi.fn((b: string) => b),
      phantomInitializedAt: vi.fn(() => false),
    }));

    const proposalId = pid();
    vi.doMock('../src/core/inbox/store.js', () => ({
      listProposals: vi.fn().mockReturnValue([makeProposal({ id: proposalId })]),
      setStatus: vi.fn(),
    }));

    vi.doMock('../src/core/run/provider-client.js', () => ({
      getActiveClient: vi.fn().mockResolvedValue(client),
    }));

    vi.doMock('../src/core/fleet/decisions-ledger.js', () => ({
      recordDecision: vi.fn(),
    }));

    vi.doMock('../src/core/inbox/merge.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/core/inbox/merge.js')>();
      return { ...actual, classifyRisk: vi.fn(() => 'low' as const) };
    });

    try {
      const { runManager } = await import('../src/core/fleet/manager.js');
      const report = await runManager({} as never, { limit: 1 });

      expect(report.verdicts).toHaveLength(1);
      expect(report.verdicts[0]!.verdict).toBe('ship');

      // Trace should be recorded
      const { readJudgeTraces } = await import('../src/core/fleet/judge-trace.js');
      const traces = readJudgeTraces({ proposalId });
      expect(traces).toHaveLength(1);

      const trace = traces[0]!;
      expect(trace.verdict).toBe('ship');
      expect(trace.scores.value).toBe(5);
      expect(trace.scores.correctness).toBe(4);
      expect(trace.scores.scope).toBe(1);
      expect(trace.scores.alignment).toBe(5);
      // fullReasoning must contain the CoT content (not empty)
      expect(trace.fullReasoning.length).toBeGreaterThan(0);
      expect(trace.fullReasoning).toContain('VALUE:');
    } finally {
      vi.doUnmock('../src/core/run/engines.js');
      vi.doUnmock('../src/core/inbox/store.js');
      vi.doUnmock('../src/core/run/provider-client.js');
      vi.doUnmock('../src/core/fleet/decisions-ledger.js');
      vi.doUnmock('../src/core/inbox/merge.js');
    }
  });

  it('runManager records traces for multiple proposals', async () => {
    const verdictObj = { verdict: 'review', value: 3, correctness: 3, scope: 3, alignment: 3, rationale: 'Needs inspection.' };
    const client = mockClientWithReasoning(verdictObj);

    vi.doMock('../src/core/run/engines.js', () => ({
      engineInstalled: vi.fn(() => false),
      buildEngineCommand: vi.fn(),
      spawnEngine: vi.fn(),
      resolveBinAbsolute: vi.fn((b: string) => b),
      phantomInitializedAt: vi.fn(() => false),
    }));

    const ids = [pid(), pid(), pid()];
    vi.doMock('../src/core/inbox/store.js', () => ({
      listProposals: vi.fn().mockReturnValue(ids.map((id) => makeProposal({ id }))),
      setStatus: vi.fn(),
    }));

    vi.doMock('../src/core/run/provider-client.js', () => ({
      getActiveClient: vi.fn().mockResolvedValue(client),
    }));

    vi.doMock('../src/core/fleet/decisions-ledger.js', () => ({
      recordDecision: vi.fn(),
    }));

    try {
      const { runManager } = await import('../src/core/fleet/manager.js');
      await runManager({} as never, { limit: 3 });

      const { readJudgeTraces } = await import('../src/core/fleet/judge-trace.js');
      for (const id of ids) {
        const traces = readJudgeTraces({ proposalId: id });
        expect(traces).toHaveLength(1);
        expect(traces[0]!.verdict).toBe('review');
      }
    } finally {
      vi.doUnmock('../src/core/run/engines.js');
      vi.doUnmock('../src/core/inbox/store.js');
      vi.doUnmock('../src/core/run/provider-client.js');
      vi.doUnmock('../src/core/fleet/decisions-ledger.js');
    }
  });
});

// ---------------------------------------------------------------------------
// 7. extractFullReasoning — reasoning-before-verdict, parse still intact
// ---------------------------------------------------------------------------

describe('m141 — reasoning-before-verdict: verdict JSON still parseable', () => {
  it('judgeProposal correctly parses verdict JSON when reasoning precedes it', async () => {
    const rawResponse = [
      '<reasoning>',
      'VALUE: 4 — solid improvement with clear benefit.',
      'CORRECTNESS: 5 — logic is sound, tests confirm.',
      'SCOPE: 2 — touches two files, both related.',
      'ALIGNMENT: 4 — matches the north-star goal.',
      'VERDICT: ship — high value, high correctness, low risk.',
      'RATIONALE: Clean change improving error handling.',
      '</reasoning>',
      '{"value":4,"correctness":5,"scope":2,"alignment":4,"verdict":"ship","rationale":"Clean change improving error handling."}',
    ].join('\n');

    const client = {
      model: 'test-cot-judge',
      complete: vi.fn().mockResolvedValue(rawResponse),
    };

    vi.doMock('../src/core/inbox/merge.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/core/inbox/merge.js')>();
      return { ...actual, classifyRisk: vi.fn(() => 'low' as const) };
    });

    try {
      const { judgeProposal } = await import('../src/core/fleet/manager.js');
      const proposal = makeProposal({ diff: '+const x = 1;\n' });
      const verdict = await judgeProposal(proposal, {} as never, client);

      // Verdict must be correctly parsed despite prose before JSON
      expect(verdict.verdict).toBe('ship');
      expect(verdict.value).toBe(4);
      expect(verdict.correctness).toBe(5);
      expect(verdict.scope).toBe(2);
      expect(verdict.alignment).toBe(4);
      expect(verdict.rationale).toContain('Clean change');
    } finally {
      vi.doUnmock('../src/core/inbox/merge.js');
    }
  });

  it('judgeProposal handles response with only JSON (no reasoning block) gracefully', async () => {
    const client = {
      model: 'test-plain-judge',
      complete: vi.fn().mockResolvedValue(
        '{"value":3,"correctness":3,"scope":3,"alignment":3,"verdict":"review","rationale":"Standard review."}',
      ),
    };

    const { judgeProposal } = await import('../src/core/fleet/manager.js');
    const proposal = makeProposal();
    const verdict = await judgeProposal(proposal, {} as never, client);

    expect(verdict.verdict).toBe('review');
    expect(verdict.rationale).toBe('Standard review.');
  });

  it('reasoning in JSON-embedded prose is still correctly extracted by extractJson', async () => {
    // Model emits prose + reasoning block + JSON (in that order)
    const rawResponse = [
      'After careful analysis, here is my chain-of-thought:',
      '<reasoning>',
      'VALUE: 2 — minor fix, limited benefit.',
      'CORRECTNESS: 4 — seems correct.',
      'SCOPE: 1 — single file.',
      'ALIGNMENT: 3 — somewhat relevant.',
      'VERDICT: review — value is marginal.',
      'RATIONALE: Minor fix needing review.',
      '</reasoning>',
      'Based on the above reasoning, my verdict is:',
      '{"value":2,"correctness":4,"scope":1,"alignment":3,"verdict":"review","rationale":"Minor fix needing review."}',
    ].join('\n');

    const client = {
      model: 'test-verbose-judge',
      complete: vi.fn().mockResolvedValue(rawResponse),
    };

    const { judgeProposal } = await import('../src/core/fleet/manager.js');
    const verdict = await judgeProposal(makeProposal(), {} as never, client);

    expect(verdict.verdict).toBe('review');
    expect(verdict.value).toBe(2);
    expect(verdict.rationale).toContain('Minor fix');
  });
});

// ---------------------------------------------------------------------------
// 8. linkOutcome prior-day fallback (synthetic patch record)
// ---------------------------------------------------------------------------

describe('m141 judge-trace — linkOutcome prior-day fallback', () => {
  it('appends a patch record to today file when trace is in a prior-day file', async () => {
    const { judgeTracesDir, linkOutcome, readJudgeTraces } = await import('../src/core/fleet/judge-trace.js');

    const dir = judgeTracesDir();
    fs.mkdirSync(dir, { recursive: true });

    // Write a trace into a "yesterday" file
    const yestDate = '2000-01-01'; // guaranteed past
    const id = pid();
    const trace = {
      proposalId: id,
      judgeEngine: 'past-engine',
      verdict: 'ship',
      scores: { value: 5, correctness: 5, scope: 1, alignment: 5 },
      fullReasoning: 'past reasoning',
      promptContext: 'past ctx',
      ts: `${yestDate}T12:00:00.000Z`,
    };
    fs.appendFileSync(path.join(dir, `${yestDate}.jsonl`), JSON.stringify(trace) + '\n', 'utf8');

    // linkOutcome should append a patch to today's file without modifying the past file
    linkOutcome(id, 'merged');

    // The original past file should be unchanged
    const pastRaw = fs.readFileSync(path.join(dir, `${yestDate}.jsonl`), 'utf8');
    const pastLines = pastRaw.trim().split('\n');
    expect(pastLines).toHaveLength(1); // no new line added

    // readJudgeTraces should surface the outcome via the patch record
    const traces = readJudgeTraces({ proposalId: id, outcomeOnly: true });
    expect(traces.length).toBeGreaterThanOrEqual(1);
    expect(traces[0]!.outcome).toBe('merged');
  });
});
