import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import {
  postMergeObservationLedgerPath,
  recordPostMergeObservation,
} from '../src/core/fleet/post-merge-observations.js';
import {
  postMergeStabilityPartitionPath,
  recordPostMergeStabilityCohort,
} from '../src/core/fleet/post-merge-stability.js';
import { readPostMergeForensicLatestObservation } from '../src/core/fleet/post-merge-forensic-evidence.js';

let home: string;
let previousHome: string | undefined;
let previousAshlrHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.HOME;
  previousAshlrHome = process.env.ASHLR_HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-m442-forensics-'));
  process.env.HOME = home;
  process.env.ASHLR_HOME = join(home, '.ashlr');
  expect(loadOrCreateKey()).toHaveLength(32);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

function recordAdverse(observedAt = '2026-07-11T12:00:00.000Z'): void {
  expect(recordPostMergeObservation({
    observedAt,
    outcome: 'regressed',
    basis: 'bisect-first-bad',
    confidence: 'deterministic',
    repo: join(home, 'repo'),
    proposalId: 'proposal-442',
    mergeCommit: 'a'.repeat(40),
    observedHead: 'b'.repeat(40),
  }).recorded).toBe(1);
}

function recordStable(stableAt = '2026-07-12T12:00:00.000Z'): void {
  expect(recordPostMergeStabilityCohort({
    cohortId: 'cohort-442',
    completedAt: '2026-07-12T12:01:00.000Z',
    witnesses: [{
      cohortId: 'cohort-442',
      repo: join(home, 'repo'),
      proposalId: 'proposal-442',
      mergeCommit: 'a'.repeat(40),
      observedHead: 'c'.repeat(40),
      windowStartedAt: '2026-07-12T00:00:00.000Z',
      stableAt,
      windowMs: 12 * 60 * 60 * 1_000,
      verificationDigest: 'd'.repeat(64),
    }],
  }).recorded).toBe(1);
}

describe('M442 post-merge forensic evidence freshness', () => {
  it('uses only validated observation and released-witness timestamps', () => {
    recordAdverse();
    recordStable();

    const result = readPostMergeForensicLatestObservation();

    expect(result).toMatchObject({
      latestAt: '2026-07-12T12:00:00.000Z',
      observations: { sourceState: 'healthy', complete: true },
      stability: { sourceState: 'healthy', complete: true },
    });
    expect(JSON.stringify(result)).not.toContain(join(home, 'repo'));
    expect(JSON.stringify(result)).not.toContain('verificationDigest');
  });

  it('keeps an empty, readable pair of sources as healthy metadata without a timestamp', () => {
    const result = readPostMergeForensicLatestObservation();

    expect(result).toMatchObject({
      observations: { sourceState: 'missing', complete: true, sourcePresent: false },
      stability: { sourceState: 'missing', complete: true, sourcePresent: false },
    });
    expect(result).not.toHaveProperty('latestAt');
  });

  it('withholds latestAt when either bounded forensic source becomes degraded', () => {
    recordAdverse();
    recordStable();
    chmodSync(postMergeObservationLedgerPath(), 0o644);

    const adverseDegraded = readPostMergeForensicLatestObservation();
    expect(adverseDegraded).toMatchObject({
      observations: { sourceState: 'degraded', complete: false },
      stability: { sourceState: 'healthy', complete: true },
    });
    expect(adverseDegraded).not.toHaveProperty('latestAt');

    chmodSync(postMergeObservationLedgerPath(), 0o600);
    chmodSync(postMergeStabilityPartitionPath('2026-07-12'), 0o644);
    const stabilityDegraded = readPostMergeForensicLatestObservation();
    expect(stabilityDegraded).toMatchObject({
      observations: { sourceState: 'healthy', complete: true },
      stability: { sourceState: 'degraded', complete: false },
    });
    expect(stabilityDegraded).not.toHaveProperty('latestAt');
  });
});
