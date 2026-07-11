import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bestOfNDir,
  readBestOfNRecords,
  readBestOfNRecordsDetailed,
  recordBestOfN,
  type BestOfNRecord,
} from '../src/core/fleet/best-of-n-ledger.js';

let home: string;
let previousAshlrHome: string | undefined;
let previousHome: string | undefined;

function record(overrides: Partial<BestOfNRecord> = {}): BestOfNRecord {
  return {
    ts: '2026-07-11T12:00:00.000Z',
    attemptId: 'attempt-1',
    workItemId: 'item-1',
    source: 'todo',
    repo: '/private/repo',
    n: 2,
    winnerIndex: 1,
    winnerProposalId: 'proposal-1',
    totalCostUsd: 0.03,
    candidates: [
      {
        index: 0,
        runId: 'run-0',
        engine: 'claude',
        model: 'sonnet',
        score: 0.5,
        costUsd: 0.01,
        proposalId: null,
        won: false,
      },
      {
        index: 1,
        runId: 'run-1',
        engine: 'codex',
        model: 'gpt-5',
        score: 0.9,
        testsPassed: true,
        costUsd: 0.02,
        latencyMs: 2_000,
        proposalId: 'proposal-1',
        won: true,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  previousAshlrHome = process.env.ASHLR_HOME;
  previousHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-m370-best-of-n-'));
  process.env.ASHLR_HOME = home;
  process.env.HOME = home;
});

afterEach(() => {
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('M370 bounded best-of-N ledger', () => {
  it('distinguishes missing and healthy sources and exposes non-enumerable compatibility quality', () => {
    expect(readBestOfNRecordsDetailed()).toMatchObject({
      records: [], sourceState: 'missing', sourcePresent: false, complete: true,
    });
    expect(existsSync(bestOfNDir())).toBe(false);

    mkdirSync(bestOfNDir(), { recursive: true, mode: 0o700 });
    expect(readBestOfNRecordsDetailed()).toMatchObject({
      records: [], sourceState: 'healthy', sourcePresent: true, complete: true,
    });
    const records = readBestOfNRecords() as BestOfNRecord[] & { sourceQuality?: unknown };
    expect(records.sourceQuality).toMatchObject({ sourceState: 'healthy', complete: true });
    expect(Object.keys(records)).toEqual([]);
  });

  it('writes a canonical v1 row, scrubs secrets, bounds text, and uses private modes', () => {
    const secret = 'github_pat_1234567890abcdefghijklmnop';
    recordBestOfN(record({
      source: `todo ${secret}`,
      candidates: record().candidates.map((candidate, index) => index === 0
        ? { ...candidate, error: `Authorization Bearer ${secret} ${'x'.repeat(800)}` }
        : candidate),
    }));

    const path = join(bestOfNDir(), '2026-07-11.jsonl');
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain(secret);
    expect(JSON.parse(raw)).toMatchObject({ schemaVersion: 1, ts: '2026-07-11T12:00:00.000Z' });
    expect(readBestOfNRecordsDetailed()).toMatchObject({ sourceState: 'healthy', complete: true });
    if (process.platform !== 'win32') {
      expect(statSync(bestOfNDir()).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it('reads the exact pre-version legacy schema without weakening v1 validation', () => {
    mkdirSync(bestOfNDir(), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(bestOfNDir(), '2026-07-11.jsonl'),
      `${JSON.stringify(record())}\n`,
      { mode: 0o600 },
    );

    expect(readBestOfNRecordsDetailed()).toMatchObject({
      sourceState: 'healthy',
      complete: true,
      invalidRows: 0,
      records: [expect.objectContaining({ schemaVersion: 1, attemptId: 'attempt-1' })],
    });
  });

  it('rejects malformed records and inconsistent candidates before creating storage', () => {
    const malformed: BestOfNRecord[] = [
      record({ ts: '2026-07-11 12:00:00Z' }),
      record({ totalCostUsd: Number.NaN }),
      record({ n: 3 }),
      record({ candidates: [record().candidates[0]!, { ...record().candidates[1]!, index: 0 }] }),
      record({ winnerIndex: 0 }),
      record({ winnerProposalId: null }),
      record({ candidates: [{ ...record().candidates[0]!, score: Number.POSITIVE_INFINITY }, record().candidates[1]!] }),
      record({ candidates: [{ ...record().candidates[0]!, engine: '' }, record().candidates[1]!] }),
    ];
    for (const candidate of malformed) recordBestOfN(candidate);
    expect(existsSync(bestOfNDir())).toBe(false);
    expect(readBestOfNRecordsDetailed().sourceState).toBe('missing');
  });

  it('preserves proposal IDs produced by losing candidates', () => {
    const withLosingProposal = record({
      candidates: [
        { ...record().candidates[0]!, proposalId: 'proposal-loser' },
        record().candidates[1]!,
      ],
    });

    recordBestOfN(withLosingProposal);

    expect(readBestOfNRecordsDetailed()).toMatchObject({
      sourceState: 'healthy',
      records: [expect.objectContaining({
        winnerProposalId: 'proposal-1',
        candidates: [
          expect.objectContaining({ proposalId: 'proposal-loser', won: false }),
          expect.objectContaining({ proposalId: 'proposal-1', won: true }),
        ],
      })],
    });
  });

  it('degrades for malformed rows, schema violations, candidate violations, and partition mismatch', () => {
    const dir = bestOfNDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const valid = { ...record(), schemaVersion: 1 as const };
    writeFileSync(join(dir, '2026-07-11.jsonl'), [
      JSON.stringify(valid),
      '{bad-json',
      JSON.stringify({ ...valid, schemaVersion: 2 }),
      JSON.stringify({ ...valid, arbitrary: 'not-allowed' }),
      JSON.stringify({ ...valid, candidates: [{ ...valid.candidates[0], index: 1 }, valid.candidates[1]] }),
      JSON.stringify({ ...valid, ts: '2026-07-12T00:00:00.000Z' }),
      '',
    ].join('\n'), { mode: 0o600 });

    expect(readBestOfNRecordsDetailed()).toMatchObject({
      records: [expect.objectContaining({ attemptId: 'attempt-1' })],
      sourceState: 'degraded',
      complete: false,
      rowsScanned: 6,
      invalidRows: 5,
    });
    expect(readBestOfNRecords({ requireComplete: true })).toEqual([]);
  });

  it('rejects loose and impossible dated partitions', () => {
    mkdirSync(bestOfNDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(bestOfNDir(), 'legacy.jsonl'), '', { mode: 0o600 });
    expect(readBestOfNRecordsDetailed()).toMatchObject({
      sourceState: 'degraded', complete: false, stopReasons: ['io-error'], unreadableFiles: 1,
    });

    rmSync(join(bestOfNDir(), 'legacy.jsonl'));
    writeFileSync(join(bestOfNDir(), '2026-99-99.jsonl'), '', { mode: 0o600 });
    expect(readBestOfNRecordsDetailed()).toMatchObject({ sourceState: 'degraded', complete: false });
  });

  it('prunes dated partitions with sinceMs and validates timestamps within selected files', () => {
    recordBestOfN(record({ ts: '2026-07-09T12:00:00.000Z', attemptId: 'old' }));
    recordBestOfN(record({ ts: '2026-07-11T11:00:00.000Z', attemptId: 'before-cutoff' }));
    recordBestOfN(record({ ts: '2026-07-11T13:00:00.000Z', attemptId: 'after-cutoff' }));

    const read = readBestOfNRecordsDetailed({ sinceMs: Date.parse('2026-07-11T12:00:00.000Z') });
    expect(read.records.map((row) => row.attemptId)).toEqual(['after-cutoff']);
    expect(read).toMatchObject({ sourceState: 'healthy', complete: true, filesRead: 1, rowsScanned: 2 });
  });

  it('marks event truncation degraded but keeps an exact event cap complete', () => {
    recordBestOfN(record({ ts: '2026-07-11T10:00:00.000Z', attemptId: 'a' }));
    recordBestOfN(record({ ts: '2026-07-11T11:00:00.000Z', attemptId: 'b' }));
    recordBestOfN(record({ ts: '2026-07-11T12:00:00.000Z', attemptId: 'c' }));

    expect(readBestOfNRecordsDetailed({ limit: 2 })).toMatchObject({
      records: [expect.objectContaining({ attemptId: 'c' }), expect.objectContaining({ attemptId: 'b' })],
      sourceState: 'degraded', complete: false, stopReasons: ['event-limit'],
    });
    expect(readBestOfNRecordsDetailed({ limit: 3 })).toMatchObject({
      sourceState: 'healthy', complete: true, stopReasons: [],
    });
  });

  it('reports file, byte, and row hard-stop reasons', () => {
    recordBestOfN(record({ ts: '2026-07-10T12:00:00.000Z', attemptId: 'older' }));
    recordBestOfN(record({ ts: '2026-07-11T12:00:00.000Z', attemptId: 'newer' }));

    expect(readBestOfNRecordsDetailed({ maxFiles: 1 })).toMatchObject({
      sourceState: 'degraded', complete: false, filesRead: 1, stopReasons: ['file-limit'],
    });
    expect(readBestOfNRecordsDetailed({ maxBytes: 1 })).toMatchObject({
      sourceState: 'degraded', complete: false, stopReasons: ['byte-limit'], bytesRead: 0,
    });
    expect(readBestOfNRecordsDetailed({ maxRows: 1 })).toMatchObject({
      sourceState: 'degraded', complete: false, rowsScanned: 1, stopReasons: ['row-limit'],
    });
  });

  it('separates a torn tail before appending and reports the torn row', () => {
    recordBestOfN(record({ attemptId: 'first' }));
    const path = join(bestOfNDir(), '2026-07-11.jsonl');
    writeFileSync(path, '{"partial":', { encoding: 'utf8', flag: 'a' });
    recordBestOfN(record({ ts: '2026-07-11T12:01:00.000Z', attemptId: 'second' }));

    expect(readFileSync(path, 'utf8')).toContain('{"partial":\n{"schemaVersion":1');
    expect(readBestOfNRecordsDetailed()).toMatchObject({
      records: [
        expect.objectContaining({ attemptId: 'second' }),
        expect.objectContaining({ attemptId: 'first' }),
      ],
      sourceState: 'degraded', complete: false, invalidRows: 1, rowsScanned: 3,
    });
  });

  it.skipIf(process.platform === 'win32')('fails closed for symlinked, hardlinked, and group-writable files', () => {
    const dir = bestOfNDir();
    const path = join(dir, '2026-07-11.jsonl');
    const target = join(home, 'target.jsonl');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(target, `${JSON.stringify({ ...record(), schemaVersion: 1 })}\n`, { mode: 0o600 });
    symlinkSync(target, path);
    recordBestOfN(record());
    expect(readBestOfNRecordsDetailed()).toMatchObject({ sourceState: 'degraded', unreadableFiles: 1 });

    rmSync(path);
    linkSync(target, path);
    recordBestOfN(record());
    expect(readBestOfNRecordsDetailed()).toMatchObject({ sourceState: 'degraded', unreadableFiles: 1 });

    rmSync(path);
    writeFileSync(path, `${JSON.stringify({ ...record(), schemaVersion: 1 })}\n`, { mode: 0o600 });
    chmodSync(path, 0o660);
    recordBestOfN(record());
    expect(readBestOfNRecordsDetailed()).toMatchObject({ sourceState: 'degraded', unreadableFiles: 1 });
  });

  it.skipIf(process.platform === 'win32')('rejects unsafe directory ancestors and directory links', () => {
    chmodSync(home, 0o777);
    recordBestOfN(record());
    expect(existsSync(bestOfNDir())).toBe(false);
    expect(readBestOfNRecordsDetailed().sourceState).toBe('missing');

    chmodSync(home, 0o700);
    const outside = join(home, 'outside');
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, bestOfNDir(), 'dir');
    recordBestOfN(record());
    expect(readBestOfNRecordsDetailed()).toMatchObject({ sourceState: 'degraded', complete: false });
  });

  it('falls back to HOME when ASHLR_HOME is relative', () => {
    process.env.ASHLR_HOME = 'relative-local-store';
    const fallback = join(home, '.ashlr', 'best-of-n');
    expect(bestOfNDir()).toBe(fallback);
    recordBestOfN(record());
    expect(readBestOfNRecordsDetailed().records).toHaveLength(1);
    expect(existsSync(join(process.cwd(), 'relative-local-store', 'best-of-n'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('safely migrates owner-readable legacy directories and files', () => {
    mkdirSync(bestOfNDir(), { recursive: true, mode: 0o755 });
    const path = join(bestOfNDir(), '2026-07-11.jsonl');
    writeFileSync(path, `${JSON.stringify(record())}\n`, { mode: 0o644 });

    expect(readBestOfNRecordsDetailed()).toMatchObject({ sourceState: 'healthy', complete: true });
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(bestOfNDir()).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
