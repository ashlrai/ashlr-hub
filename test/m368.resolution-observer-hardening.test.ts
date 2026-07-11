import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildScannerObservationDigest } from '../src/core/fleet/scanner-observation-digest.js';
import { buildSourceBaseDigest } from '../src/core/fleet/source-base-digest.js';
import {
  readResolutionObserverCheckpoint,
  readResolutionObserverRunSummary,
  readResolutionObserverStatus,
  resolutionObserverRunStatePath,
  runResolutionObserver,
  writeResolutionObserverCheckpoint,
  type ResolutionObserverCheckpointV1,
} from '../src/core/fleet/resolution-observer.js';
import { readResolutionWitnesses } from '../src/core/fleet/resolution-witness-ledger.js';
import { provenanceKeyPath } from '../src/core/foundry/provenance.js';
import type { Backlog, ScannerObservation } from '../src/core/types.js';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';

let fx: H1Fixture;
let repo: string;

beforeEach(() => {
  fx = makeFixture();
  repo = fx.makeRepo().dir;
  const key = provenanceKeyPath();
  mkdirSync(dirname(key), { recursive: true, mode: 0o700 });
  writeFileSync(key, Buffer.alloc(32, 19), { mode: 0o600 });
});

afterEach(() => fx.cleanup());

function sourceBase(state: 'missing' | 'satisfied') {
  return buildSourceBaseDigest({
    repo,
    scannerId: 'merge-verify-contract',
    scannerRevision: 1,
    sourceKind: 'git-tree',
    consistency: 'stable-double-read',
    dirty: 'clean',
    sourceSnapshot: { head: state === 'missing' ? 'a'.repeat(40) : 'b'.repeat(40), contract: state },
    requirementSnapshot: { requirement: 'same', commands: [['npm', 'test']] },
    scannerConfig: { detector: 1 },
  })!;
}

function attest(observation: ScannerObservation): ScannerObservation {
  const observationDigest = buildScannerObservationDigest(observation);
  expect(observationDigest).toMatch(/^[a-f0-9]{64}$/);
  return { ...observation, observationDigest: observationDigest! };
}

function present(): ScannerObservation {
  return attest({
    schemaVersion: 1,
    observedAt: '2026-07-11T11:00:00.000Z',
    repo,
    scannerId: 'merge-verify-contract',
    domain: 'verification',
    source: 'test',
    status: 'present',
    reason: 'item-observed',
    itemId: 'repo:test:merge-contract',
    objectiveHash: 'd'.repeat(64),
    sourceBase: sourceBase('missing'),
  });
}

function absent(observedAt = '2026-07-11T11:30:00.000Z'): ScannerObservation {
  return attest({
    schemaVersion: 1,
    observedAt,
    repo,
    scannerId: 'merge-verify-contract',
    domain: 'verification',
    source: 'test',
    status: 'absent',
    reason: 'source-confirmed-empty',
    sourceBase: sourceBase('satisfied'),
  });
}

function backlog(generatedAt: string, observations: ScannerObservation[], degraded = false): Backlog {
  return {
    generatedAt,
    snapshotId: 'a'.repeat(32),
    repos: [repo],
    items: [],
    observations,
    observationSourceState: degraded ? 'degraded' : 'healthy',
  };
}

function checkpoint(backlogGeneratedAt = '2026-07-11T10:59:00.000Z'): ResolutionObserverCheckpointV1 {
  return {
    schemaVersion: 1,
    backlogGeneratedAt,
    updatedAt: '2026-07-11T11:00:01.000Z',
    pending: [present()],
    lastRun: {
      observerRunId: `resolution-observer:${backlogGeneratedAt}`,
      startedAt: '2026-07-11T11:00:00.000Z',
      completedAt: '2026-07-11T11:00:01.000Z',
      outcome: 'seeded',
      backlogGeneratedAt,
      reposObserved: 1,
      pendingObjectives: 1,
      transitionsMatched: 0,
      recorded: 0,
      replayed: 0,
      conflicted: 0,
      invalid: 0,
      failed: 0,
    },
  };
}

describe('M368 resolution observer hardening', () => {
  it('refuses a backlog replaced after the parent selected a snapshot token', () => {
    const writeCheckpoint = vi.fn(() => true);
    const result = runResolutionObserver({
      expectedBacklogGeneratedAt: '2026-07-11T11:29:00.000Z',
      expectedBacklogSnapshotId: 'b'.repeat(32),
      deps: {
        loadBacklog: () => backlog('2026-07-11T11:29:00.000Z', [present()]),
        writeCheckpoint,
        writeRunSummary: () => true,
      },
    });

    expect(result.outcome).toBe('source-unavailable');
    expect(writeCheckpoint).not.toHaveBeenCalled();
  });

  it('does not publish a completed outcome after synchronous prework exceeds the deadline', () => {
    const writeCheckpoint = vi.fn(() => true);
    const result = runResolutionObserver({
      deadlineMs: 1,
      deps: {
        loadBacklog: () => {
          const until = Date.now() + 5;
          while (Date.now() < until) { /* exercise synchronous deadline containment */ }
          return backlog('2026-07-11T11:29:00.000Z', [present()]);
        },
        writeCheckpoint,
        writeRunSummary: () => true,
      },
    });

    expect(result.outcome).toBe('deadline-exceeded');
    expect(writeCheckpoint).not.toHaveBeenCalled();
  });

  it('replays one physical witness when only the backlog envelope timestamp changes', () => {
    const prior = checkpoint();
    let writes = 0;
    const first = runResolutionObserver({
      now: () => new Date('2026-07-11T11:31:00.000Z'),
      deps: {
        loadBacklog: () => backlog('2026-07-11T11:29:00.000Z', [absent()]),
        readCheckpoint: () => ({ sourceState: 'healthy', checkpoint: prior }),
        writeCheckpoint: () => ++writes > 1,
      },
    });
    const second = runResolutionObserver({
      now: () => new Date('2026-07-11T11:32:00.000Z'),
      deps: {
        loadBacklog: () => backlog('2026-07-11T11:30:00.000Z', [absent('2026-07-11T11:31:00.000Z')]),
        readCheckpoint: () => ({ sourceState: 'healthy', checkpoint: prior }),
        writeCheckpoint: () => ++writes > 1,
      },
    });

    expect(first).toMatchObject({ outcome: 'write-failed', recorded: 1 });
    expect(second).toMatchObject({ outcome: 'completed', replayed: 1 });
    expect(readResolutionWitnesses()).toMatchObject({ physicalRows: 1, witnesses: [expect.any(Object)] });
  });

  it('refuses a checkpoint rollback and preserves the newer cursor', () => {
    const newer = checkpoint('2026-07-11T11:10:00.000Z');
    newer.updatedAt = '2026-07-11T11:10:01.000Z';
    const older = checkpoint('2026-07-11T11:05:00.000Z');
    older.updatedAt = '2026-07-11T11:11:00.000Z';

    expect(writeResolutionObserverCheckpoint(newer)).toBe(true);
    expect(writeResolutionObserverCheckpoint(older)).toBe(false);
    expect(readResolutionObserverCheckpoint().checkpoint?.backlogGeneratedAt).toBe(newer.backlogGeneratedAt);
  });

  it('reports a failed latest attempt independently from the successful checkpoint cursor', () => {
    expect(writeResolutionObserverCheckpoint(checkpoint())).toBe(true);
    const result = runResolutionObserver({
      now: () => new Date('2026-07-11T11:31:00.000Z'),
      deps: { loadBacklog: () => backlog('2026-07-11T11:29:00.000Z', [absent()], true) },
    });

    expect(result.outcome).toBe('source-unavailable');
    expect(readResolutionObserverRunSummary()).toMatchObject({
      sourceState: 'healthy',
      run: { outcome: 'source-unavailable', backlogGeneratedAt: '2026-07-11T11:29:00.000Z' },
    });
    expect(readResolutionObserverStatus()).toMatchObject({
      state: 'degraded',
      lastOutcome: 'source-unavailable',
      lastBacklogAt: '2026-07-11T10:59:00.000Z',
    });
  });

  it('degrades status when the latest-run sidecar is malformed', () => {
    expect(writeResolutionObserverCheckpoint(checkpoint())).toBe(true);
    writeFileSync(resolutionObserverRunStatePath(), '{"outcome":"completed"}\n', { mode: 0o600 });

    expect(readResolutionObserverRunSummary()).toEqual({ sourceState: 'degraded', run: null });
    expect(readResolutionObserverStatus()).toMatchObject({ state: 'degraded', runState: 'degraded' });
  });
});
