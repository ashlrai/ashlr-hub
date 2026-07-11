import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import {
  buildResolutionWitness,
  readResolutionWitnesses,
  recordResolutionWitness,
  resolutionWitnessDigest,
  resolutionWitnessLedgerPath,
  sanitizeResolutionWitness,
  type ResolutionWitnessInput,
} from '../src/core/fleet/resolution-witness-ledger.js';

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  expect.hasAssertions();
  previousHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-m365-resolution-witness-'));
  process.env.HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

function input(overrides: Partial<ResolutionWitnessInput> = {}): ResolutionWitnessInput {
  return {
    repo: join(home, 'repo'),
    scannerId: 'merge-verify-contract',
    scannerRevision: 1,
    itemId: 'repo:test:merge-contract',
    objectiveHash: 'a'.repeat(64),
    observerRunId: 'observer-12345678-1234-4123-8123-123456789abc',
    postStateBaseDigest: 'b'.repeat(64),
    observationBaseDigest: 'c'.repeat(64),
    resolutionKind: 'merge-contract-satisfied',
    decidedAt: '2026-07-10T12:00:00.000Z',
    ...overrides,
  };
}

describe('M365 advisory no-change resolution witness ledger', () => {
  it('reports a missing ledger without creating local-store directories', () => {
    expect(readResolutionWitnesses().sourceState).toBe('missing');
    expect(existsSync(join(home, '.ashlr'))).toBe(false);
  });

  it('builds the fixed v1 schema and derives a stable resolution digest', () => {
    const witness = buildResolutionWitness(input())!;

    expect(witness).toEqual({
      schemaVersion: 1,
      decision: 'no-change-required',
      repo: join(home, 'repo'),
      scannerId: 'merge-verify-contract',
      scannerRevision: 1,
      itemId: 'repo:test:merge-contract',
      objectiveHash: 'a'.repeat(64),
      observerRunId: 'observer-12345678-1234-4123-8123-123456789abc',
      postStateBaseDigest: 'b'.repeat(64),
      observationBaseDigest: 'c'.repeat(64),
      resolutionKind: 'merge-contract-satisfied',
      resolutionDigest: resolutionWitnessDigest(witness),
      decidedAt: '2026-07-10T12:00:00.000Z',
    });
  });

  it('persists only exact metadata and reads newest witnesses first', () => {
    const secret = 'github_pat_1234567890abcdefghijklmnop';
    const supplied = { ...input(), title: secret, stdout: secret, arbitrary: { prompt: secret } };
    const newer = input({
      itemId: 'repo:test:newer-contract',
      observerRunId: 'observer-22345678-1234-4123-8123-123456789abc',
      decidedAt: '2026-07-10T12:01:00.000Z',
    });

    expect(recordResolutionWitness(supplied)).toMatchObject({ recorded: 1, invalid: 0, failed: 0 });
    expect(recordResolutionWitness(newer)).toMatchObject({ recorded: 1, invalid: 0, failed: 0 });
    const raw = readFileSync(resolutionWitnessLedgerPath(), 'utf8');
    expect(raw.startsWith('\n')).toBe(false);
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain('title');
    expect(raw).not.toContain('stdout');
    expect(readResolutionWitnesses()).toMatchObject({
      sourceState: 'healthy',
      invalidRows: 0,
      conflictingDigests: 0,
      witnesses: [expect.objectContaining({ itemId: newer.itemId }), expect.objectContaining({ itemId: supplied.itemId })],
    });
  });

  it('rejects malformed required metadata instead of truncating or defaulting it', () => {
    const invalid = [
      input({ scannerId: '../unsafe' }),
      input({ scannerRevision: 0 }),
      input({ objectiveHash: 'A'.repeat(64) }),
      input({ observerRunId: 'unsafe/observer' }),
      input({ decidedAt: '2026-07-10 12:00:00Z' }),
      input({ resolutionKind: 'merge-contract-satisfied' as never, resolutionDigest: 'd'.repeat(64) }),
    ];

    expect(invalid.map((row) => sanitizeResolutionWitness(row))).toEqual(Array(invalid.length).fill(null));
    expect(recordResolutionWitness(invalid[0]!)).toMatchObject({ invalid: 1, recorded: 0 });
    expect(readResolutionWitnesses().sourceState).toBe('missing');
  });

  it('makes exact replay idempotent without adding a physical row', () => {
    expect(recordResolutionWitness(input())).toMatchObject({ recorded: 1, replayed: 0 });
    expect(recordResolutionWitness(input())).toMatchObject({ recorded: 0, replayed: 1, conflicted: 0 });

    const read = readResolutionWitnesses();
    expect(read).toMatchObject({ sourceState: 'healthy', physicalRows: 1, conflictingDigests: 0 });
    expect(read.witnesses).toHaveLength(1);
  });

  it('gives distinct evidence and decision times distinct resolution identities', () => {
    const first = input();
    const differentEvidence = input({ postStateBaseDigest: 'd'.repeat(64) });
    const differentDecisionTime = input({ decidedAt: '2026-07-10T12:00:01.000Z' });
    const firstDigest = buildResolutionWitness(first)?.resolutionDigest;
    expect(buildResolutionWitness(differentEvidence)?.resolutionDigest).not.toBe(firstDigest);
    expect(buildResolutionWitness(differentDecisionTime)?.resolutionDigest).not.toBe(firstDigest);

    expect(recordResolutionWitness(first)).toMatchObject({ recorded: 1 });
    expect(recordResolutionWitness(differentEvidence)).toMatchObject({ recorded: 1, conflicted: 0 });
    expect(readResolutionWitnesses()).toMatchObject({
      sourceState: 'healthy',
      physicalRows: 2,
      conflictingDigests: 0,
    });
    expect(readResolutionWitnesses().witnesses).toHaveLength(2);
  });

  it('rejects malformed, extra-field, and digest-tampered persisted rows', () => {
    const witness = buildResolutionWitness(input())!;
    const path = resolutionWitnessLedgerPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, [
      JSON.stringify({ ...witness, title: 'not metadata' }),
      JSON.stringify({ ...witness, resolutionDigest: 'd'.repeat(64) }),
      '{bad-json',
      '',
    ].join('\n'), { mode: 0o600 });

    expect(readResolutionWitnesses()).toMatchObject({
      sourceState: 'degraded',
      invalidRows: 3,
      conflictingDigests: 0,
      witnesses: [],
    });
  });

  it('fails closed for symlink, hardlink, and shared-mode ledger targets', () => {
    const path = resolutionWitnessLedgerPath();
    const target = join(home, 'target.jsonl');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(target, '', { mode: 0o600 });
    symlinkSync(target, path);
    expect(recordResolutionWitness(input())).toMatchObject({ failed: 1, recorded: 0 });
    expect(readResolutionWitnesses().sourceState).toBe('degraded');

    rmSync(path);
    linkSync(target, path);
    expect(recordResolutionWitness(input())).toMatchObject({ failed: 1, recorded: 0 });
    expect(readResolutionWitnesses().sourceState).toBe('degraded');

    rmSync(path);
    writeFileSync(path, `${JSON.stringify(buildResolutionWitness(input()))}\n`, { mode: 0o600 });
    chmodSync(path, 0o644);
    expect(recordResolutionWitness(input())).toMatchObject({ failed: 1, recorded: 0 });
    expect(readResolutionWitnesses()).toMatchObject({ sourceState: 'degraded', witnesses: [] });
  });

  it('rejects symlinked storage-directory ancestors', () => {
    const path = resolutionWitnessLedgerPath();
    const ashlr = join(home, '.ashlr');
    const outsideAshlr = join(home, 'outside-ashlr');
    mkdirSync(outsideAshlr, { mode: 0o700 });
    symlinkSync(outsideAshlr, ashlr, 'dir');

    expect(recordResolutionWitness(input())).toMatchObject({ failed: 1, recorded: 0 });
    expect(readResolutionWitnesses()).toMatchObject({ sourceState: 'degraded', witnesses: [] });

    rmSync(ashlr);
    mkdirSync(ashlr, { mode: 0o700 });
    const outsideFleet = join(home, 'outside-fleet');
    mkdirSync(outsideFleet, { mode: 0o700 });
    symlinkSync(outsideFleet, dirname(path), 'dir');

    expect(recordResolutionWitness(input())).toMatchObject({ failed: 1, recorded: 0 });
    expect(readResolutionWitnesses()).toMatchObject({ sourceState: 'degraded', witnesses: [] });
  });

  it('requires owner-private modes on both storage directories', () => {
    const ashlr = join(home, '.ashlr');
    mkdirSync(ashlr, { mode: 0o755 });
    chmodSync(ashlr, 0o755);
    expect(recordResolutionWitness(input())).toMatchObject({ failed: 1, recorded: 0 });
    expect(readResolutionWitnesses().sourceState).toBe('degraded');

    chmodSync(ashlr, 0o700);
    const fleet = dirname(resolutionWitnessLedgerPath());
    mkdirSync(fleet, { mode: 0o755 });
    chmodSync(fleet, 0o755);
    expect(recordResolutionWitness(input())).toMatchObject({ failed: 1, recorded: 0 });
    expect(readResolutionWitnesses().sourceState).toBe('degraded');
  });

  it('isolates a torn tail and preserves a later append', () => {
    expect(recordResolutionWitness(input())).toMatchObject({ recorded: 1 });
    writeFileSync(resolutionWitnessLedgerPath(), '{"partial":', { encoding: 'utf8', flag: 'a' });
    const second = input({
      itemId: 'repo:test:second',
      observerRunId: 'observer-32345678-1234-4123-8123-123456789abc',
      decidedAt: '2026-07-10T12:02:00.000Z',
    });
    expect(recordResolutionWitness(second)).toMatchObject({ recorded: 1 });

    const read = readResolutionWitnesses();
    expect(read).toMatchObject({ sourceState: 'degraded', invalidRows: 1, physicalRows: 3 });
    expect(read.witnesses.map((row) => row.itemId).sort()).toEqual([input().itemId, second.itemId].sort());
  });
});
