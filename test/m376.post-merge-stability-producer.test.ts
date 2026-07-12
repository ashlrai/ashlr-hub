import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import { readPostMergeStability } from '../src/core/fleet/post-merge-stability.js';
import {
  recordStableWindowWitnesses,
  type StableWindowCandidate,
} from '../src/core/fleet/post-merge-stability-producer.js';

const DAY = 24 * 60 * 60 * 1_000;

function candidate(overrides: Partial<StableWindowCandidate> = {}): StableWindowCandidate {
  const stableAtMs = Date.parse('2026-07-12T12:00:00.000Z');
  return {
    repo: resolve('/repo'),
    proposalId: 'proposal-1',
    mergeCommit: 'a'.repeat(40),
    observedHead: 'b'.repeat(40),
    windowStartedAtMs: stableAtMs - DAY,
    stableAtMs,
    windowMs: DAY,
    verificationDigest: 'd'.repeat(64),
    ...overrides,
  };
}

function success() {
  return { attempted: 1, recorded: 1, replayed: 0, conflicted: 0, invalid: 0, failed: 0, witnessesRecorded: 1 };
}

describe('M376 stable-window witness production', () => {
  it('writes one deterministic metadata-only cohort per logical member', () => {
    const writer = vi.fn(() => success());
    const second = candidate({
      proposalId: 'proposal-2',
      mergeCommit: 'c'.repeat(40),
      stableAtMs: Date.parse('2026-07-13T12:00:00.000Z'),
      windowStartedAtMs: Date.parse('2026-07-12T12:00:00.000Z'),
    });

    expect(recordStableWindowWitnesses([candidate(), second], writer)).toMatchObject({
      candidates: 2, eligible: 2, ineligible: 0, cohortsAttempted: 2,
      cohortsRecorded: 2, witnessesRecorded: 2,
    });
    expect(writer).toHaveBeenCalledTimes(2);
    for (const [input] of writer.mock.calls) {
      expect(input.cohortId).toMatch(/^stable-[a-f0-9]{64}$/);
      expect(input.witnesses[0]).not.toHaveProperty('prompt');
      expect(input.witnesses[0]).not.toHaveProperty('diff');
      expect(input.witnesses[0]).not.toHaveProperty('output');
      expect(input.witnesses[0].verificationDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(input.completedAt.slice(0, 10)).toBe(input.witnesses[0].stableAt.slice(0, 10));
    }
  });

  it('produces replay-stable cohort identity independent of input order', () => {
    const inputs = [candidate(), candidate({ proposalId: 'proposal-2', mergeCommit: 'c'.repeat(40) })];
    const seen: string[] = [];
    const writer = vi.fn((input) => {
      seen.push(JSON.stringify(input));
      return success();
    });

    recordStableWindowWitnesses(inputs, writer);
    recordStableWindowWitnesses([...inputs].reverse(), writer);

    expect(seen.slice(2)).toEqual(seen.slice(0, 2));
  });

  it('rejects malformed verification, identity, and premature candidates', () => {
    const writer = vi.fn(() => success());
    const stableAtMs = Date.parse('2026-07-12T12:00:00.000Z');
    const invalid = [
      candidate({ verificationDigest: '' }),
      candidate({ proposalId: 'proposal-2', mergeCommit: 'c'.repeat(40), verificationDigest: 'D'.repeat(64) }),
      candidate({ proposalId: 'proposal-3', mergeCommit: 'C'.repeat(40) }),
      candidate({ proposalId: 'proposal-4', mergeCommit: 'd'.repeat(40), stableAtMs: stableAtMs - 1 }),
    ];

    expect(recordStableWindowWitnesses(invalid, writer)).toMatchObject({
      candidates: 4, eligible: 0, ineligible: 4, cohortsAttempted: 0,
    });
    expect(writer).not.toHaveBeenCalled();
  });

  it('fails a conflicting duplicate identity closed and contains writer failures', () => {
    const conflict = candidate({ observedHead: 'd'.repeat(40) });
    const writer = vi.fn(() => { throw new Error('storage unavailable'); });

    expect(recordStableWindowWitnesses([candidate(), conflict], writer)).toMatchObject({
      candidates: 2, eligible: 0, ineligible: 1, cohortsAttempted: 0,
    });
    expect(recordStableWindowWitnesses([candidate()], writer)).toMatchObject({
      eligible: 1, cohortsAttempted: 1, cohortsFailed: 1,
    });
  });

  it('bounds candidate population before invoking storage', () => {
    const writer = vi.fn(() => success());
    const inputs = Array.from({ length: 65 }, (_, index) => candidate({
      proposalId: `proposal-${index}`,
      mergeCommit: index.toString(16).padStart(40, '0'),
    }));

    expect(recordStableWindowWitnesses(inputs, writer)).toMatchObject({ candidates: 65, eligible: 0, ineligible: 65 });
    expect(writer).not.toHaveBeenCalled();
  });

  it('writes and replays one real signed observation-only cohort end to end', () => {
    const home = mkdtempSync(join(tmpdir(), 'ashlr-m376-producer-'));
    const previous = process.env.ASHLR_HOME;
    process.env.ASHLR_HOME = join(home, '.ashlr');
    try {
      expect(loadOrCreateKey()).toHaveLength(32);
      expect(recordStableWindowWitnesses([candidate({ repo: resolve(home, 'repo') })])).toMatchObject({
        cohortsRecorded: 1, cohortsReplayed: 0, witnessesRecorded: 1,
      });
      expect(recordStableWindowWitnesses([candidate({ repo: resolve(home, 'repo') })])).toMatchObject({
        cohortsRecorded: 0, cohortsReplayed: 1,
      });
      expect(readPostMergeStability({ requireComplete: true })).toMatchObject({
        sourceState: 'healthy', complete: true, releasedCohorts: 1,
        cohortSummary: { completeCohorts: 1, releasedWitnesses: 1 },
      });
    } finally {
      if (previous === undefined) delete process.env.ASHLR_HOME;
      else process.env.ASHLR_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
