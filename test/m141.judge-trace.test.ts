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
import {
  signLocalMergeIntent,
  signLocalRealizedMergeReceipt,
} from '../src/core/foundry/provenance.js';

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
const origAshlrHome = process.env.ASHLR_HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m141-home-')));
  process.env.HOME = tmpHome;
  process.env.ASHLR_HOME = path.join(tmpHome, '.ashlr');
  fs.mkdirSync(path.join(tmpHome, 'repo'), { recursive: true, mode: 0o700 });
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  if (origAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = origAshlrHome;
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
    repo: path.join(tmpHome, 'repo'),
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

function persistAuthenticatedMergedProposal(
  id: string,
  observedAt = new Date().toISOString(),
  overrides: Partial<Proposal> = {},
): Proposal {
  const repo = path.join(tmpHome, 'repo');
  fs.mkdirSync(repo, { recursive: true, mode: 0o700 });
  const diffHash = 'd'.repeat(64);
  const baseBeforeOid = 'a'.repeat(40);
  const proposalHeadOid = 'b'.repeat(40);
  const mergeCommitOid = 'c'.repeat(40);
  const unsignedIntent = {
    schemaVersion: 1 as const,
    branch: `ashlr/merge/${id}`,
    base: 'main',
    baseBeforeOid,
    proposalHeadOid,
    diffHash,
    evidencePackDigest: 'e'.repeat(64),
    authorizationId: '1'.repeat(32),
    authorizedAt: new Date().toISOString(),
  };
  const localMergeIntent = {
    ...unsignedIntent,
    attestation: signLocalMergeIntent(id, repo, unsignedIntent),
  };
  const unsignedWitness = {
    schemaVersion: 1 as const,
    source: 'local-default-branch' as const,
    base: 'main',
    baseBeforeOid,
    proposalHeadOid,
    mergeCommitOid,
    observedAt,
    proposalId: id,
    diffHash,
    intentAttestation: localMergeIntent.attestation,
  };
  const proposal = makeProposal({
    id,
    repo,
    status: 'applied',
    diffHash,
    verifyResult: { passed: true, baseHead: baseBeforeOid, diffHash },
    localMergeIntent,
    realizedMerge: {
      ...unsignedWitness,
      attestation: signLocalRealizedMergeReceipt(id, repo, unsignedWitness),
    },
    ...overrides,
  });
  const inbox = path.join(tmpHome, '.ashlr', 'inbox');
  fs.mkdirSync(inbox, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(inbox, `${id}.json`), `${JSON.stringify(proposal)}\n`, { mode: 0o600 });
  return proposal;
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
  it('ignores emulated mode bits only on Windows while preserving filesystem safety checks', async () => {
    const { isSafeJudgeTraceDirectory, isSafeJudgeTraceFile } =
      await import('../src/core/fleet/judge-trace.js');
    const regular = fs.statSync(tmpHome);
    const fileStat = {
      ...regular,
      mode: (regular.mode & ~0o777) | 0o666,
      nlink: 1,
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
    } as unknown as ReturnType<typeof fs.statSync>;
    const directoryStat = {
      ...regular,
      mode: (regular.mode & ~0o777) | 0o777,
      isFile: () => false,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    } as unknown as ReturnType<typeof fs.statSync>;

    expect(isSafeJudgeTraceFile(fileStat, 'win32')).toBe(true);
    expect(isSafeJudgeTraceFile(fileStat, 'linux')).toBe(false);
    expect(isSafeJudgeTraceDirectory(directoryStat, 'win32')).toBe(true);
    expect(isSafeJudgeTraceDirectory(directoryStat, 'linux')).toBe(false);

    expect(isSafeJudgeTraceFile({
      ...fileStat,
      isSymbolicLink: () => true,
    } as ReturnType<typeof fs.statSync>, 'win32')).toBe(false);
    expect(isSafeJudgeTraceFile({
      ...fileStat,
      nlink: 2,
    } as ReturnType<typeof fs.statSync>, 'win32')).toBe(false);
    expect(isSafeJudgeTraceDirectory({
      ...directoryStat,
      isSymbolicLink: () => true,
    } as ReturnType<typeof fs.statSync>, 'win32')).toBe(false);
    if (typeof process.getuid === 'function') {
      expect(isSafeJudgeTraceFile({
        ...fileStat,
        uid: process.getuid() + 1,
      } as ReturnType<typeof fs.statSync>, 'win32')).toBe(false);
    }
  });

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

  it('distinguishes missing, healthy, and degraded bounded sources', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-02T12:00:00.000Z'));
    const { judgeTracesDir, readJudgeTraces, readJudgeTracesDetailed } = await import('../src/core/fleet/judge-trace.js');

    expect(readJudgeTracesDetailed()).toMatchObject({
      sourceState: 'missing',
      sourcePresent: false,
      complete: true,
    });

    const dir = judgeTracesDir();
    fs.mkdirSync(dir, { recursive: true });
    expect(readJudgeTracesDetailed()).toMatchObject({
      sourceState: 'healthy', sourcePresent: true, complete: true,
    });

    const recentTs = new Date(Date.now() - 60_000).toISOString();
    const day = recentTs.slice(0, 10);
    fs.writeFileSync(
      path.join(dir, `${day}.jsonl`),
      [
        JSON.stringify({
          traceId: 'jt-valid', proposalId: 'p-valid', judgeEngine: 'judge', verdict: 'ship',
          scores: { value: 5, correctness: 5, scope: 1, alignment: 5 },
          fullReasoning: 'ok', promptContext: 'ctx', ts: recentTs,
        }),
        '{"proposalId":',
      ].join('\n') + '\n',
      'utf8',
    );
    const degraded = readJudgeTracesDetailed();
    expect(degraded).toMatchObject({ sourceState: 'degraded', complete: false, invalidRows: 1 });
    expect(degraded.traces).toHaveLength(1);
    expect(readJudgeTraces({ requireComplete: true })).toEqual([]);
  });

  it('deduplicates exact trace rows and degrades on a conflicting trace id', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-02T12:00:00.000Z'));
    const { judgeTracesDir, readJudgeTracesDetailed } =
      await import('../src/core/fleet/judge-trace.js');
    const dir = judgeTracesDir();
    fs.mkdirSync(dir, { recursive: true });
    const recentTs = new Date(Date.now() - 60_000).toISOString();
    const day = recentTs.slice(0, 10);
    const row = {
      traceId: 'jt-dedup', proposalId: 'p-dedup', judgeEngine: 'judge', verdict: 'ship',
      scores: { value: 5, correctness: 5, scope: 1, alignment: 5 },
      fullReasoning: 'same', promptContext: 'ctx', ts: recentTs,
    };
    const file = path.join(dir, `${day}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify(row)}\n${JSON.stringify(row)}\n`, 'utf8');
    expect(readJudgeTracesDetailed()).toMatchObject({ complete: true, traces: [row] });

    fs.appendFileSync(file, `${JSON.stringify({ ...row, verdict: 'harmful' })}\n`, 'utf8');
    const conflict = readJudgeTracesDetailed();
    expect(conflict).toMatchObject({
      sourceState: 'degraded', complete: false, stopReasons: ['conflicting-row'],
    });
  });

  it('rejects future trace and outcome timestamps', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-02T12:00:00.000Z'));
    const { judgeTracesDir, readJudgeTracesDetailed } =
      await import('../src/core/fleet/judge-trace.js');
    const dir = judgeTracesDir();
    fs.mkdirSync(dir, { recursive: true });
    const base = {
      traceId: 'jt-future', proposalId: 'p-future', judgeEngine: 'judge', verdict: 'ship',
      scores: { value: 5, correctness: 5, scope: 1, alignment: 5 },
      fullReasoning: 'future', promptContext: 'ctx', ts: '2030-01-02T12:05:00.000Z',
    };
    fs.writeFileSync(
      path.join(dir, '2030-01-02.jsonl'),
      `${JSON.stringify(base)}\n${JSON.stringify({
        ...base, traceId: 'jt-future-outcome', ts: '2030-01-02T11:00:00.000Z',
        outcome: 'rejected', outcomeBasis: 'proposal-rejection-v1',
        outcomeAt: '2030-01-02T12:05:00.000Z',
      })}\n`,
      'utf8',
    );
    expect(readJudgeTracesDetailed()).toMatchObject({
      sourceState: 'degraded', complete: false, invalidRows: 2, traces: [],
    });
  });

  it('fails closed on byte bounds, symlinks, and hardlinks', async () => {
    const { judgeTracesDir, readJudgeTracesDetailed } = await import('../src/core/fleet/judge-trace.js');
    const dir = judgeTracesDir();
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `${day}.jsonl`);
    fs.writeFileSync(file, `${'x'.repeat(512)}\n`, 'utf8');

    expect(readJudgeTracesDetailed({ maxBytes: 64 })).toMatchObject({
      sourceState: 'degraded', complete: false, stopReasons: ['byte-limit'],
    });

    const outside = path.join(tmpHome, 'outside-trace.jsonl');
    fs.writeFileSync(outside, '{}\n', 'utf8');
    fs.rmSync(file);
    fs.symlinkSync(outside, file);
    expect(readJudgeTracesDetailed()).toMatchObject({
      sourceState: 'degraded', complete: false, stopReasons: ['io-error'], unreadableFiles: 1,
    });

    fs.rmSync(file);
    fs.linkSync(outside, file);
    expect(readJudgeTracesDetailed()).toMatchObject({
      sourceState: 'degraded', complete: false, stopReasons: ['io-error'], unreadableFiles: 1,
    });
  });

  it('rejects invalid timestamp partitions without escaping the trace directory', async () => {
    const { recordJudgeTrace, readJudgeTraces } = await import('../src/core/fleet/judge-trace.js');
    recordJudgeTrace({
      ts: '../../escape',
      proposalId: 'p-escape',
      judgeEngine: 'judge',
      verdict: 'review',
      scores: { value: 2, correctness: 2, scope: 2, alignment: 2 },
      fullReasoning: 'none',
      promptContext: 'none',
    });
    expect(readJudgeTraces({ proposalId: 'p-escape' })).toEqual([]);
    expect(fs.existsSync(path.join(tmpHome, 'escape.jsonl'))).toBe(false);
  });

  it('falls back to the home store for empty or relative ASHLR_HOME', async () => {
    const { judgeTracesDir } = await import('../src/core/fleet/judge-trace.js');
    process.env.ASHLR_HOME = '';
    expect(judgeTracesDir()).toBe(path.join(tmpHome, '.ashlr', 'judge-traces'));
    process.env.ASHLR_HOME = 'relative-store';
    expect(judgeTracesDir()).toBe(path.join(tmpHome, '.ashlr', 'judge-traces'));
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
    persistAuthenticatedMergedProposal(id);
    recordJudgeTrace({
      proposalId: id,
      judgeEngine: 'test',
      verdict: 'ship',
      scores: { value: 5, correctness: 5, scope: 1, alignment: 5 },
      fullReasoning: 'Ship it.',
      promptContext: 'ctx',
    });

    linkOutcome(id, 'merged', { basis: 'realized-merge-v1' });

    const traces = readJudgeTraces({ proposalId: id });
    expect(traces[0]!.outcome).toBe('merged');
    expect(traces[0]!.outcomeBasis).toBe('realized-merge-v1');
    expect(traces[0]!.outcomeAt).toBeDefined();
  });

  it('refuses an unqualified merged link at runtime without appending a patch', async () => {
    const { judgeTracesDir, linkOutcomeResult, readJudgeTraces, recordJudgeTrace } =
      await import('../src/core/fleet/judge-trace.js');
    const id = pid();
    recordJudgeTrace({
      proposalId: id,
      judgeEngine: 'test',
      verdict: 'ship',
      scores: { value: 5, correctness: 5, scope: 1, alignment: 5 },
      fullReasoning: 'Ship it.',
      promptContext: 'ctx',
    });
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(judgeTracesDir(), `${day}.jsonl`);
    const before = fs.readFileSync(file, 'utf8');
    const untypedLink = linkOutcomeResult as unknown as (
      proposalId: string,
      outcome: 'merged',
    ) => { status: string };

    expect(untypedLink(id, 'merged')).toEqual({ status: 'unqualified' });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(readJudgeTraces({ proposalId: id })[0]!.outcome).toBeUndefined();
  });

  it('refuses a forged basis when the exact linked proposal has no realized witness', async () => {
    const { judgeTracesDir, linkOutcomeResult, recordJudgeTrace } =
      await import('../src/core/fleet/judge-trace.js');
    const id = pid();
    const pending = makeProposal({ id });
    const inbox = path.join(tmpHome, '.ashlr', 'inbox');
    fs.mkdirSync(inbox, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(inbox, `${id}.json`), `${JSON.stringify(pending)}\n`, { mode: 0o600 });
    recordJudgeTrace({
      proposalId: id, judgeEngine: 'test', verdict: 'ship',
      scores: { value: 5, correctness: 5, scope: 1, alignment: 5 },
      fullReasoning: '', promptContext: '',
    });

    expect(linkOutcomeResult(id, 'merged', { basis: 'realized-merge-v1' })).toEqual({
      status: 'unqualified',
    });
    const file = path.join(judgeTracesDir(), `${new Date().toISOString().slice(0, 10)}.jsonl`);
    expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('refuses merged credit when the proposal source is incomplete', async () => {
    const { judgeTracesDir, linkOutcomeResult, recordJudgeTrace } =
      await import('../src/core/fleet/judge-trace.js');
    const id = pid();
    persistAuthenticatedMergedProposal(id);
    const inbox = path.join(tmpHome, '.ashlr', 'inbox');
    fs.writeFileSync(path.join(inbox, 'corrupt.json'), '{', { mode: 0o600 });
    recordJudgeTrace({
      proposalId: id, judgeEngine: 'test', verdict: 'ship',
      scores: { value: 5, correctness: 5, scope: 1, alignment: 5 },
      fullReasoning: '', promptContext: '',
    });

    expect(linkOutcomeResult(id, 'merged', { basis: 'realized-merge-v1' })).toEqual({
      status: 'degraded',
    });
    const file = path.join(judgeTracesDir(), `${new Date().toISOString().slice(0, 10)}.jsonl`);
    expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('refuses a witness bound to a different proposal id', async () => {
    const { linkOutcomeResult, recordJudgeTrace } = await import('../src/core/fleet/judge-trace.js');
    const id = pid();
    persistAuthenticatedMergedProposal(pid());
    recordJudgeTrace({
      proposalId: id, judgeEngine: 'test', verdict: 'ship',
      scores: { value: 5, correctness: 5, scope: 1, alignment: 5 },
      fullReasoning: '', promptContext: '',
    });

    expect(linkOutcomeResult(id, 'merged', { basis: 'realized-merge-v1' })).toEqual({
      status: 'unqualified',
    });
  });

  it('refuses an exact-looking witness with a forged receipt', async () => {
    const { linkOutcomeResult, recordJudgeTrace } = await import('../src/core/fleet/judge-trace.js');
    const id = pid();
    const proposal = persistAuthenticatedMergedProposal(id);
    proposal.realizedMerge = { ...proposal.realizedMerge!, attestation: '0'.repeat(64) };
    fs.writeFileSync(
      path.join(tmpHome, '.ashlr', 'inbox', `${id}.json`),
      `${JSON.stringify(proposal)}\n`,
      { mode: 0o600 },
    );
    recordJudgeTrace({
      proposalId: id, judgeEngine: 'test', verdict: 'ship',
      scores: { value: 5, correctness: 5, scope: 1, alignment: 5 },
      fullReasoning: '', promptContext: '',
    });

    expect(linkOutcomeResult(id, 'merged', { basis: 'realized-merge-v1' })).toEqual({
      status: 'unqualified',
    });
  });

  it('refuses an authenticated witness observed in the future', async () => {
    const { linkOutcomeResult, recordJudgeTrace } = await import('../src/core/fleet/judge-trace.js');
    const id = pid();
    persistAuthenticatedMergedProposal(id, new Date(Date.now() + 30_000).toISOString());
    recordJudgeTrace({
      proposalId: id, judgeEngine: 'test', verdict: 'ship',
      scores: { value: 5, correctness: 5, scope: 1, alignment: 5 },
      fullReasoning: '', promptContext: '',
    });

    expect(linkOutcomeResult(id, 'merged', { basis: 'realized-merge-v1' })).toEqual({
      status: 'unqualified',
    });
  });

  it('deduplicates an identical qualified merged patch', async () => {
    const { judgeTracesDir, linkOutcomeResult, recordJudgeTrace } =
      await import('../src/core/fleet/judge-trace.js');
    const id = pid();
    persistAuthenticatedMergedProposal(id);
    recordJudgeTrace({
      proposalId: id,
      judgeEngine: 'test',
      verdict: 'ship',
      scores: { value: 5, correctness: 5, scope: 1, alignment: 5 },
      fullReasoning: 'Ship it.',
      promptContext: 'ctx',
    });

    expect(linkOutcomeResult(id, 'merged', { basis: 'realized-merge-v1' }).status).toBe('linked');
    expect(linkOutcomeResult(id, 'merged', { basis: 'realized-merge-v1' }).status).toBe('already-linked');

    const day = new Date().toISOString().slice(0, 10);
    const rows = fs.readFileSync(path.join(judgeTracesDir(), `${day}.jsonl`), 'utf8')
      .trim()
      .split('\n');
    expect(rows).toHaveLength(2);
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

  it('persists an explicit bounded rejection basis', async () => {
    const { linkOutcome, readJudgeTraces, recordJudgeTrace } =
      await import('../src/core/fleet/judge-trace.js');
    const id = pid();
    recordJudgeTrace({
      proposalId: id,
      judgeEngine: 'test',
      verdict: 'noise',
      scores: { value: 1, correctness: 1, scope: 1, alignment: 1 },
      fullReasoning: 'Reject.',
      promptContext: 'ctx',
    });

    linkOutcome(id, 'rejected', { basis: 'proposal-rejection-v1' });

    expect(readJudgeTraces({ proposalId: id })[0]).toMatchObject({
      outcome: 'rejected',
      outcomeBasis: 'proposal-rejection-v1',
    });
  });

  it('linkOutcome patches only the correct proposal, leaves others unchanged', async () => {
    const { recordJudgeTrace, readJudgeTraces, linkOutcome } = await import('../src/core/fleet/judge-trace.js');

    const id1 = pid();
    const id2 = pid();
    persistAuthenticatedMergedProposal(id1);
    recordJudgeTrace({ proposalId: id1, judgeEngine: 'e', verdict: 'ship', scores: { value: 5, correctness: 5, scope: 1, alignment: 5 }, fullReasoning: 'a', promptContext: 'a' });
    recordJudgeTrace({ proposalId: id2, judgeEngine: 'e', verdict: 'review', scores: { value: 3, correctness: 3, scope: 3, alignment: 3 }, fullReasoning: 'b', promptContext: 'b' });

    linkOutcome(id1, 'merged', { basis: 'realized-merge-v1' });

    const t1 = readJudgeTraces({ proposalId: id1 });
    const t2 = readJudgeTraces({ proposalId: id2 });
    expect(t1[0]!.outcome).toBe('merged');
    expect(t2[0]!.outcome).toBeUndefined();
  });

  it('links append-only, materializes one trace, and applies the latest outcome', async () => {
    const { judgeTracesDir, recordJudgeTrace, readJudgeTraces, linkOutcomeResult } =
      await import('../src/core/fleet/judge-trace.js');
    const id = pid();
    recordJudgeTrace({
      proposalId: id,
      judgeEngine: 'judge',
      verdict: 'ship',
      scores: { value: 5, correctness: 5, scope: 1, alignment: 5 },
      fullReasoning: 'ship',
      promptContext: 'ctx',
    });
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(judgeTracesDir(), `${day}.jsonl`);
    const original = fs.readFileSync(file, 'utf8');

    expect(linkOutcomeResult(id, 'followed-up').status).toBe('linked');
    expect(fs.readFileSync(file, 'utf8').startsWith(original)).toBe(true);
    expect(linkOutcomeResult(id, 'reverted').status).toBe('linked');

    const traces = readJudgeTraces({ proposalId: id });
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ outcome: 'reverted' });
    expect(readJudgeTraces({ proposalId: id, outcomeOnly: true })).toHaveLength(1);
  });

  it('targets the newest judgment rather than an older trace with a newer outcome', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-02T23:30:00.000Z'));
    const { recordJudgeTrace, readJudgeTraces, linkOutcomeResult } = await import('../src/core/fleet/judge-trace.js');
    const id = pid();
    const day = new Date().toISOString().slice(0, 10);
    recordJudgeTrace({
      traceId: 'jt-older', proposalId: id, judgeEngine: 'judge', verdict: 'ship',
      scores: { value: 5, correctness: 5, scope: 1, alignment: 5 },
      fullReasoning: 'old', promptContext: 'ctx', ts: `${day}T01:00:00.000Z`,
      outcome: 'merged', outcomeAt: `${day}T23:00:00.000Z`,
    });
    recordJudgeTrace({
      traceId: 'jt-newer', proposalId: id, judgeEngine: 'judge', verdict: 'review',
      scores: { value: 3, correctness: 3, scope: 3, alignment: 3 },
      fullReasoning: 'new', promptContext: 'ctx', ts: `${day}T02:00:00.000Z`,
    });

    expect(linkOutcomeResult(id, 'reverted')).toMatchObject({ status: 'linked', traceId: 'jt-newer' });
    const traces = readJudgeTraces({ proposalId: id });
    expect(traces.find((trace) => trace.traceId === 'jt-newer')?.outcome).toBe('reverted');
    expect(traces.find((trace) => trace.traceId === 'jt-older')?.outcome).toBe('merged');
  });

  it('linkOutcome is a no-op when proposalId not found', async () => {
    const { linkOutcome } = await import('../src/core/fleet/judge-trace.js');
    // Should not throw
    expect(() => linkOutcome('nonexistent-proposal', 'merged', { basis: 'realized-merge-v1' })).not.toThrow();
  });

  it('does not append an outcome label when the source is degraded', async () => {
    const { judgeTracesDir, recordJudgeTrace, linkOutcomeResult } = await import('../src/core/fleet/judge-trace.js');
    const id = pid();
    persistAuthenticatedMergedProposal(id);
    recordJudgeTrace({
      proposalId: id,
      judgeEngine: 'judge',
      verdict: 'ship',
      scores: { value: 5, correctness: 5, scope: 1, alignment: 5 },
      fullReasoning: 'ship',
      promptContext: 'ctx',
    });
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(judgeTracesDir(), `${day}.jsonl`);
    fs.appendFileSync(file, '{"torn":', 'utf8');
    const before = fs.readFileSync(file, 'utf8');

    expect(linkOutcomeResult(id, 'merged', { basis: 'realized-merge-v1' })).toEqual({ status: 'degraded' });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('linkOutcome never throws', async () => {
    const { linkOutcome } = await import('../src/core/fleet/judge-trace.js');
    expect(() => linkOutcome('any-id', 'merged', { basis: 'realized-merge-v1' })).not.toThrow();
  });

  it('deduplicates a qualified patch and persists metadata only', async () => {
    const { judgeTracesDir, recordJudgeTrace, readJudgeTraces, linkOutcomeResult } =
      await import('../src/core/fleet/judge-trace.js');
    const id = pid();
    persistAuthenticatedMergedProposal(id);
    recordJudgeTrace({
      traceId: 'jt-qualified-once',
      proposalId: id,
      judgeEngine: 'judge',
      verdict: 'ship',
      scores: { value: 5, correctness: 5, scope: 1, alignment: 5 },
      fullReasoning: 'PRIVATE_REASONING_SENTINEL',
      promptContext: 'PRIVATE_CONTEXT_SENTINEL',
    });

    expect(linkOutcomeResult(id, 'merged', { basis: 'realized-merge-v1' })).toMatchObject({
      status: 'linked', traceId: 'jt-qualified-once',
    });
    expect(linkOutcomeResult(id, 'merged', { basis: 'realized-merge-v1' })).toMatchObject({
      status: 'already-linked', traceId: 'jt-qualified-once',
    });

    const file = path.join(judgeTracesDir(), `${new Date().toISOString().slice(0, 10)}.jsonl`);
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      _patchForTraceId: 'jt-qualified-once',
      outcome: 'merged',
      outcomeBasis: 'realized-merge-v1',
      fullReasoning: '',
      promptContext: '',
    });
    expect(JSON.stringify(rows[1])).not.toContain('PRIVATE_REASONING_SENTINEL');
    expect(JSON.stringify(rows[1])).not.toContain('PRIVATE_CONTEXT_SENTINEL');
    expect(readJudgeTraces({ proposalId: id })).toMatchObject([
      { outcome: 'merged', outcomeBasis: 'realized-merge-v1' },
    ]);
  });

  it('upgrades one legacy merged label with one qualified patch', async () => {
    const { judgeTracesDir, recordJudgeTrace, readJudgeTraces, linkOutcomeResult } =
      await import('../src/core/fleet/judge-trace.js');
    const id = pid();
    persistAuthenticatedMergedProposal(id);
    recordJudgeTrace({
      traceId: 'jt-legacy-upgrade',
      proposalId: id,
      judgeEngine: 'legacy',
      verdict: 'ship',
      scores: { value: 5, correctness: 5, scope: 1, alignment: 5 },
      fullReasoning: '',
      promptContext: '',
      outcome: 'merged',
      outcomeAt: new Date().toISOString(),
    });

    expect(linkOutcomeResult(id, 'merged', { basis: 'realized-merge-v1' })).toMatchObject({
      status: 'linked', traceId: 'jt-legacy-upgrade',
    });
    expect(linkOutcomeResult(id, 'merged', { basis: 'realized-merge-v1' })).toMatchObject({
      status: 'already-linked', traceId: 'jt-legacy-upgrade',
    });
    expect(readJudgeTraces({ proposalId: id })).toMatchObject([
      { outcome: 'merged', outcomeBasis: 'realized-merge-v1' },
    ]);
    const file = path.join(judgeTracesDir(), `${new Date().toISOString().slice(0, 10)}.jsonl`);
    expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
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
    persistAuthenticatedMergedProposal(idA);
    recordJudgeTrace({ proposalId: idA, judgeEngine: 'e', verdict: 'ship', scores: { value: 5, correctness: 5, scope: 1, alignment: 5 }, fullReasoning: '', promptContext: '' });
    recordJudgeTrace({ proposalId: idB, judgeEngine: 'e', verdict: 'review', scores: { value: 3, correctness: 3, scope: 3, alignment: 3 }, fullReasoning: '', promptContext: '' });
    linkOutcome(idA, 'merged', { basis: 'realized-merge-v1' });

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
    persistAuthenticatedMergedProposal(id1);
    recordJudgeTrace({ proposalId: id1, judgeEngine: 'e', verdict: 'ship', scores: { value: 5, correctness: 5, scope: 1, alignment: 5 }, fullReasoning: '', promptContext: '' });
    recordJudgeTrace({ proposalId: id2, judgeEngine: 'e', verdict: 'review', scores: { value: 3, correctness: 3, scope: 3, alignment: 3 }, fullReasoning: '', promptContext: '' });
    recordJudgeTrace({ proposalId: id3, judgeEngine: 'e', verdict: 'noise', scores: { value: 1, correctness: 1, scope: 1, alignment: 1 }, fullReasoning: '', promptContext: '' });

    linkOutcome(id1, 'merged', { basis: 'realized-merge-v1' });
    linkOutcome(id3, 'rejected');

    const stats = outcomeStats();
    expect(stats.total).toBeGreaterThanOrEqual(3);
    expect(stats.withOutcome).toBeGreaterThanOrEqual(2);
    expect(stats.outcomeRate).toBeGreaterThan(0);
    expect(stats.byOutcome['merged']).toBeGreaterThanOrEqual(1);
    expect(stats.byOutcome['rejected']).toBeGreaterThanOrEqual(1);
  });

  it('preserves an unqualified historical merge for forensics but grants zero CLI credit', async () => {
    const {
      isQualifiedJudgeOutcome,
      outcomeStats,
      readJudgeTraces,
      recordJudgeTrace,
    } = await import('../src/core/fleet/judge-trace.js');
    const id = pid();
    recordJudgeTrace({
      traceId: 'jt-legacy-unqualified',
      proposalId: id,
      judgeEngine: 'legacy',
      verdict: 'ship',
      scores: { value: 5, correctness: 5, scope: 1, alignment: 5 },
      fullReasoning: 'legacy',
      promptContext: 'legacy',
      outcome: 'merged',
      outcomeAt: new Date().toISOString(),
    });

    const legacy = readJudgeTraces({ proposalId: id, outcomeOnly: true });
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({ outcome: 'merged' });
    expect(legacy[0]!.outcomeBasis).toBeUndefined();
    expect(isQualifiedJudgeOutcome(legacy[0]!)).toBe(false);
    expect(outcomeStats()).toMatchObject({
      total: 1,
      withOutcome: 0,
      outcomeRate: 0,
      byOutcome: {},
    });
  });

  it('fails closed on an unknown or outcome-incompatible basis', async () => {
    const { isQualifiedJudgeOutcome, outcomeStats, readJudgeTraces, readJudgeTracesDetailed } =
      await import('../src/core/fleet/judge-trace.js');
    const dir = makeTraceDir();
    const day = new Date().toISOString().slice(0, 10);
    const malformed = {
      traceId: 'jt-malformed-basis',
      proposalId: pid(),
      judgeEngine: 'legacy',
      verdict: 'ship',
      scores: { value: 5, correctness: 5, scope: 1, alignment: 5 },
      fullReasoning: 'legacy',
      promptContext: 'legacy',
      ts: new Date().toISOString(),
      outcome: 'merged',
      outcomeBasis: 'user-asserted-success',
      outcomeAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, `${day}.jsonl`), `${JSON.stringify(malformed)}\n`, { mode: 0o600 });

    expect(readJudgeTracesDetailed()).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      invalidRows: 1,
      traces: [],
    });
    expect(readJudgeTraces({ requireComplete: true })).toEqual([]);
    expect(outcomeStats()).toMatchObject({ total: 0, withOutcome: 0, byOutcome: {} });
    expect(isQualifiedJudgeOutcome(malformed as never)).toBe(false);
    expect(isQualifiedJudgeOutcome({
      outcome: 'rejected',
      outcomeBasis: 'realized-merge-v1',
    })).toBe(false);
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

  it('rejects malformed outcome bases before writing', async () => {
    const { recordJudgeTrace, readJudgeTracesDetailed } =
      await import('../src/core/fleet/judge-trace.js');
    const invalid = {
      proposalId: pid(), judgeEngine: 'judge', verdict: 'ship' as const,
      scores: { value: 5, correctness: 5, scope: 1, alignment: 5 },
      fullReasoning: '', promptContext: '', outcome: 'merged' as const,
      outcomeBasis: 'operator-said-so',
    };
    recordJudgeTrace(invalid as never);
    expect(readJudgeTracesDetailed()).toMatchObject({
      traces: [],
      rowsScanned: 0,
      invalidRows: 0,
    });
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
    vi.doMock('../src/core/inbox/store.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/core/inbox/store.js')>();
      return {
        ...actual,
        listProposals: vi.fn().mockReturnValue([makeProposal({ id: proposalId })]),
        setStatus: vi.fn(),
      };
    });

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
    vi.doMock('../src/core/inbox/store.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/core/inbox/store.js')>();
      return {
        ...actual,
        listProposals: vi.fn().mockReturnValue(ids.map((id) => makeProposal({ id }))),
        setStatus: vi.fn(),
      };
    });

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

  it('judgeProposal can suppress durable trace recording for ephemeral candidate scoring', async () => {
    const client = {
      model: 'test-ephemeral-judge',
      complete: vi.fn().mockResolvedValue(
        '{"value":4,"correctness":4,"scope":2,"alignment":4,"verdict":"review","rationale":"Selection-only score."}',
      ),
    };

    const { judgeProposal } = await import('../src/core/fleet/manager.js');
    const { readJudgeTraces } = await import('../src/core/fleet/judge-trace.js');
    const proposal = makeProposal({ id: 'prop-m141abc1-000001-111111111111111111111111' });
    const verdict = await judgeProposal(proposal, {} as never, client, { recordTrace: false });

    expect(verdict.verdict).toBe('review');
    expect(verdict.semanticEvents?.map((event) => event.kind)).toEqual(['action', 'challenge']);
    expect(readJudgeTraces({ proposalId: proposal.id })).toHaveLength(0);
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
    persistAuthenticatedMergedProposal(id);
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
    linkOutcome(id, 'merged', { basis: 'realized-merge-v1' });

    // The original past file should be unchanged
    const pastRaw = fs.readFileSync(path.join(dir, `${yestDate}.jsonl`), 'utf8');
    const pastLines = pastRaw.trim().split('\n');
    expect(pastLines).toHaveLength(1); // no new line added

    // readJudgeTraces should surface the outcome via the patch record
    const traces = readJudgeTraces({ proposalId: id, outcomeOnly: true });
    expect(traces.length).toBeGreaterThanOrEqual(1);
    expect(traces[0]!.outcome).toBe('merged');
    const recent = readJudgeTraces({
      proposalId: id,
      outcomeOnly: true,
      sinceMs: Date.now() - 60 * 60 * 1000,
      requireComplete: true,
    });
    expect(recent).toHaveLength(1);
    expect(recent[0]!.outcome).toBe('merged');
  });
});
