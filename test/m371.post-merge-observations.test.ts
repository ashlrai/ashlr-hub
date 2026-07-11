import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  buildPostMergeObservation,
  postMergeObservationEventId,
  postMergeObservationLedgerPath,
  readPostMergeObservations,
  recordPostMergeObservation,
  sanitizePostMergeObservation,
  verifyPostMergeObservation,
  type PostMergeObservationInput,
} from '../src/core/fleet/post-merge-observations.js';

let home: string;
let previousHome: string | undefined;
let previousAshlrHome: string | undefined;

beforeEach(() => {
  expect.hasAssertions();
  previousHome = process.env.HOME;
  previousAshlrHome = process.env.ASHLR_HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-m371-post-merge-'));
  process.env.HOME = home;
  process.env.ASHLR_HOME = join(home, '.ashlr');
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

function input(overrides: Partial<PostMergeObservationInput> = {}): PostMergeObservationInput {
  return {
    observedAt: '2026-07-11T12:00:00.000Z',
    outcome: 'regressed',
    basis: 'bisect-first-bad',
    confidence: 'deterministic',
    repo: join(home, 'repo'),
    proposalId: 'proposal-123',
    runId: 'run-123',
    trajectoryId: 'trajectory:run-123',
    workItemId: 'github:ashlrai/ashlr-hub#123',
    mergeCommit: 'a'.repeat(40),
    observedHead: 'b'.repeat(40),
    baselineHead: 'c'.repeat(40),
    candidateCount: 3,
    commandKinds: ['typecheck', 'test'],
    ...overrides,
  };
}

describe('M371 observation-only post-merge ledger', () => {
  it('reports a complete missing source without creating storage', () => {
    expect(readPostMergeObservations()).toEqual(expect.objectContaining({
      observations: [],
      sourceState: 'missing',
      sourcePresent: false,
      complete: true,
    }));
    expect(existsSync(join(home, '.ashlr'))).toBe(false);
  });

  it('honors a canonical absolute ASHLR_HOME and falls back for unsafe values', () => {
    const configured = join(home, 'isolated', '..', 'isolated-store');
    process.env.ASHLR_HOME = `  ${configured}  `;
    expect(postMergeObservationLedgerPath()).toBe(
      join(resolve(configured), 'fleet', 'post-merge-observations.jsonl'),
    );
    expect(recordPostMergeObservation(input())).toMatchObject({ recorded: 1 });
    expect(existsSync(join(resolve(configured), 'fleet', 'post-merge-observations.jsonl'))).toBe(true);
    expect(existsSync(join(home, '.ashlr', 'fleet', 'post-merge-observations.jsonl'))).toBe(false);

    for (const unsafe of ['', 'relative-store', `relative\nstore`]) {
      process.env.ASHLR_HOME = unsafe;
      expect(postMergeObservationLedgerPath()).toBe(
        join(resolve(home, '.ashlr'), 'fleet', 'post-merge-observations.jsonl'),
      );
    }
  });

  it('builds a strict signed metadata record with deterministic event identity', () => {
    const observation = buildPostMergeObservation(input())!;
    const retried = buildPostMergeObservation(input({ observedAt: '2026-07-11T12:01:00.000Z' }))!;

    expect(observation).toEqual({
      schemaVersion: 1,
      eventId: postMergeObservationEventId(observation),
      observedAt: '2026-07-11T12:00:00.000Z',
      authority: 'observation-only',
      outcome: 'regressed',
      basis: 'bisect-first-bad',
      confidence: 'deterministic',
      repo: join(home, 'repo'),
      proposalId: 'proposal-123',
      runId: 'run-123',
      trajectoryId: 'trajectory:run-123',
      workItemId: 'github:ashlrai/ashlr-hub#123',
      mergeCommit: 'a'.repeat(40),
      observedHead: 'b'.repeat(40),
      baselineHead: 'c'.repeat(40),
      candidateCount: 3,
      commandKinds: ['test', 'typecheck'],
      labelBasis: 'post-merge-regression',
      attestation: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(retried.eventId).toBe(observation.eventId);
    expect(buildPostMergeObservation(input({ runId: undefined, trajectoryId: undefined, workItemId: undefined }))?.eventId)
      .toBe(observation.eventId);
    expect(retried.attestation).not.toBe(observation.attestation);
    expect(verifyPostMergeObservation(observation)).toBe(true);
  });

  it('persists only allowlisted metadata and never raw execution content', () => {
    const secret = 'github_pat_1234567890abcdefghijklmnopqrstuvwxyz';
    const supplied = {
      ...input(),
      signal: secret,
      prompt: secret,
      diff: secret,
      stdout: secret,
      stderr: secret,
      env: { TOKEN: secret },
      fileContents: secret,
    };

    expect(recordPostMergeObservation(supplied)).toMatchObject({ recorded: 1, invalid: 0, failed: 0 });
    const raw = readFileSync(postMergeObservationLedgerPath(), 'utf8');
    for (const forbidden of ['signal', 'prompt', 'diff', 'stdout', 'stderr', 'env', 'fileContents', secret]) {
      expect(raw).not.toContain(forbidden);
    }
    expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual(Object.keys(buildPostMergeObservation(input())!).sort());
  });

  it('rejects malformed identity, SHA, enums, timestamps, and supplied signatures', () => {
    const invalid = [
      input({ proposalId: '../bad id' }),
      input({ mergeCommit: 'A'.repeat(40) }),
      input({ observedHead: 'a'.repeat(39) }),
      input({ observedAt: '2026-07-11 12:00:00Z' }),
      input({ outcome: 'merged' as never }),
      input({ basis: 'raw-signal' as never }),
      input({ confidence: 'maybe' as never }),
      input({ candidateCount: 0 }),
      input({ commandKinds: ['npm run test'] }),
      input({ eventId: 'd'.repeat(64) }),
      input({ attestation: 'e'.repeat(64) }),
    ];

    expect(invalid.map((row) => sanitizePostMergeObservation(row))).toEqual(Array(invalid.length).fill(null));
    expect(recordPostMergeObservation(invalid[0]!)).toMatchObject({ invalid: 1, recorded: 0 });
  });

  it('is idempotent and advances outcomes monotonically without rewriting history', () => {
    const followedUp = {
      outcome: 'followed-up' as const,
      basis: 'overlapping-fix' as const,
      confidence: 'heuristic' as const,
    };
    expect(recordPostMergeObservation(input(followedUp))).toMatchObject({ recorded: 1, replayed: 0 });
    expect(recordPostMergeObservation(input({ ...followedUp, observedAt: '2026-07-11T12:00:01.000Z' })))
      .toMatchObject({ recorded: 0, replayed: 1 });
    expect(recordPostMergeObservation(input({
      outcome: 'regressed',
      basis: 'bisect-first-bad',
      confidence: 'deterministic',
      observedHead: 'd'.repeat(40),
      observedAt: '2026-07-11T12:01:00.000Z',
    }))).toMatchObject({ upgraded: 1 });
    expect(recordPostMergeObservation(input({
      outcome: 'reverted',
      basis: 'git-revert-reference',
      observedHead: 'e'.repeat(40),
      observedAt: '2026-07-11T12:02:00.000Z',
    }))).toMatchObject({ upgraded: 1 });
    expect(recordPostMergeObservation(input({ ...followedUp, observedAt: '2026-07-11T12:03:00.000Z' })))
      .toMatchObject({ obsolete: 1 });

    const read = readPostMergeObservations();
    expect(read).toMatchObject({
      sourceState: 'healthy',
      complete: true,
      physicalRows: 3,
      supersededRows: 2,
      observations: [expect.objectContaining({ outcome: 'reverted', observedHead: 'e'.repeat(40) })],
    });
  });

  it('refuses contradictory evidence at the current outcome rank', () => {
    expect(recordPostMergeObservation(input())).toMatchObject({ recorded: 1 });
    expect(recordPostMergeObservation(input({
      confidence: 'deterministic',
      observedHead: 'd'.repeat(40),
      observedAt: '2026-07-11T12:01:00.000Z',
    }))).toMatchObject({ conflicted: 1 });
    expect(readPostMergeObservations()).toMatchObject({ physicalRows: 1, conflictingEvents: 0 });
  });

  it('upgrades heuristic regression evidence to deterministic parent proof', () => {
    expect(recordPostMergeObservation(input({
      confidence: 'heuristic',
      baselineHead: undefined,
    }))).toMatchObject({ recorded: 1 });
    expect(recordPostMergeObservation(input({
      confidence: 'deterministic',
      observedAt: '2026-07-11T12:01:00.000Z',
    }))).toMatchObject({ upgraded: 1 });
    expect(recordPostMergeObservation(input({
      confidence: 'heuristic',
      baselineHead: undefined,
      observedAt: '2026-07-11T12:02:00.000Z',
    }))).toMatchObject({ obsolete: 1 });

    expect(readPostMergeObservations()).toMatchObject({
      sourceState: 'healthy',
      complete: true,
      physicalRows: 2,
      supersededRows: 1,
      observations: [expect.objectContaining({
        outcome: 'regressed',
        confidence: 'deterministic',
        baselineHead: 'c'.repeat(40),
      })],
    });
  });

  it('degrades on malformed, extra-field, forged, and conflicting persisted rows', () => {
    const valid = buildPostMergeObservation(input())!;
    const conflict = buildPostMergeObservation(input({
      confidence: 'deterministic',
      observedHead: 'd'.repeat(40),
      observedAt: '2026-07-11T12:01:00.000Z',
    }))!;
    const path = postMergeObservationLedgerPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, [
      JSON.stringify(valid),
      JSON.stringify(conflict),
      JSON.stringify({ ...valid, stdout: 'forbidden' }),
      JSON.stringify({ ...valid, observedHead: 'e'.repeat(40) }),
      JSON.stringify({ ...valid, attestation: 'f'.repeat(64) }),
      '{bad-json',
      '',
    ].join('\n'), { mode: 0o600 });

    expect(readPostMergeObservations()).toMatchObject({
      observations: [],
      sourceState: 'degraded',
      complete: false,
      invalidRows: 4,
      conflictingEvents: 1,
      stopReasons: expect.arrayContaining(['invalid-row', 'conflict']),
    });
    expect(readPostMergeObservations({ requireComplete: true }).observations).toEqual([]);
  });

  it('enforces private directories and a private append-only regular file', () => {
    expect(recordPostMergeObservation(input())).toMatchObject({ recorded: 1 });
    const path = postMergeObservationLedgerPath();
    if (process.platform !== 'win32') {
      expect(lstatSync(join(home, '.ashlr')).mode & 0o777).toBe(0o700);
      expect(lstatSync(dirname(path)).mode & 0o777).toBe(0o700);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    }
    chmodSync(path, 0o644);
    expect(recordPostMergeObservation(input())).toMatchObject({ failed: 1 });
    expect(readPostMergeObservations().sourceState).toBe('degraded');
  });

  it('fails closed for symlink and hardlink ledger targets', () => {
    expect(buildPostMergeObservation(input())).not.toBeNull();
    const path = postMergeObservationLedgerPath();
    const target = join(home, 'target.jsonl');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(target, '', { mode: 0o600 });
    symlinkSync(target, path);
    expect(recordPostMergeObservation(input())).toMatchObject({ failed: 1 });
    expect(readPostMergeObservations().sourceState).toBe('degraded');

    rmSync(path);
    linkSync(target, path);
    expect(recordPostMergeObservation(input())).toMatchObject({ failed: 1 });
    expect(readPostMergeObservations().sourceState).toBe('degraded');
  });

  it('degrades torn or corrupt tails and refuses to append through uncertainty', () => {
    expect(recordPostMergeObservation(input())).toMatchObject({ recorded: 1 });
    writeFileSync(postMergeObservationLedgerPath(), '{"partial":', { encoding: 'utf8', flag: 'a' });

    expect(readPostMergeObservations()).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      invalidRows: 1,
      physicalRows: 2,
      observations: [expect.objectContaining({ proposalId: 'proposal-123' })],
    });
    expect(recordPostMergeObservation(input({ proposalId: 'proposal-456' }))).toMatchObject({ failed: 1 });
  });

  it('exposes deterministic file, byte, and row caps as incomplete degraded reads', () => {
    expect(recordPostMergeObservation(input())).toMatchObject({ recorded: 1 });
    expect(recordPostMergeObservation(input({
      proposalId: 'proposal-456',
      runId: 'run-456',
      trajectoryId: 'trajectory:run-456',
      workItemId: 'work-456',
      mergeCommit: 'd'.repeat(40),
      observedAt: '2026-07-11T12:01:00.000Z',
    }))).toMatchObject({ recorded: 1 });

    expect(readPostMergeObservations({ maxFiles: 0 })).toMatchObject({
      sourceState: 'degraded', complete: false, filesRead: 0, limitExceeded: true, stopReasons: ['file-limit'],
    });
    expect(readPostMergeObservations({ maxBytes: 1 })).toMatchObject({
      sourceState: 'degraded', complete: false, observations: [], limitExceeded: true, stopReasons: ['byte-limit'],
    });
    expect(readPostMergeObservations({ maxRows: 1 })).toMatchObject({
      sourceState: 'degraded', complete: false, physicalRows: 2, limitExceeded: true, stopReasons: ['row-limit'],
    });
    expect(readPostMergeObservations({ maxRows: 1, requireComplete: true }).observations).toEqual([]);
  });
});
