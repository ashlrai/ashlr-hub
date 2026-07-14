import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildSourceBaseDigest } from '../src/core/fleet/source-base-digest.js';
import { buildScannerObservationDigest } from '../src/core/fleet/scanner-observation-digest.js';
import { provenanceKeyPath } from '../src/core/foundry/provenance.js';
import type { AshlrConfig, Backlog, ScannerObservation } from '../src/core/types.js';
import {
  readResolutionObserverCheckpoint,
  readResolutionObserverStatus,
  resolutionObserverStatePath,
  runResolutionObserver,
  scheduleResolutionObserver,
  writeResolutionObserverCheckpoint,
  writeResolutionObserverRunSummary,
  type ResolutionObserverCheckpointV1,
} from '../src/core/fleet/resolution-observer.js';
import { runResolutionObserverChild } from '../src/core/daemon/resolution-observer-child.js';
import { readResolutionWitnesses } from '../src/core/fleet/resolution-witness-ledger.js';
import { setKill } from '../src/core/sandbox/policy.js';
import { scheduleResolutionObserverAfterTick } from '../src/core/daemon/loop.js';
import { buildFleetStatus } from '../src/core/fleet/status.js';
import { formatFleetStatus } from '../src/cli/fleet.js';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';

let fx: H1Fixture;
let repo: string;

beforeEach(() => {
  fx = makeFixture();
  repo = fx.makeRepo().dir;
  const key = provenanceKeyPath();
  mkdirSync(dirname(key), { recursive: true, mode: 0o700 });
  writeFileSync(key, Buffer.alloc(32, 11), { mode: 0o600 });
});

afterEach(() => fx.cleanup());

function sourceBase(state: 'missing' | 'satisfied', requirement = 'same') {
  return buildSourceBaseDigest({
    repo,
    scannerId: 'merge-verify-contract',
    scannerRevision: 1,
    sourceKind: 'git-tree',
    consistency: 'stable-double-read',
    dirty: 'clean',
    sourceSnapshot: { head: state === 'missing' ? 'a'.repeat(40) : 'b'.repeat(40), contract: state },
    requirementSnapshot: { requirement, commands: [['npm', 'test']] },
    scannerConfig: { detector: 1 },
  })!;
}

function present(observedAt = '2026-07-11T11:00:00.000Z'): ScannerObservation {
  const observation: ScannerObservation = {
    schemaVersion: 1,
    observedAt,
    repo,
    scannerId: 'merge-verify-contract',
    domain: 'verification',
    source: 'test',
    status: 'present',
    reason: 'item-observed',
    itemId: 'repo:test:merge-contract',
    objectiveHash: 'd'.repeat(64),
    sourceBase: sourceBase('missing'),
  };
  return { ...observation, observationDigest: buildScannerObservationDigest(observation)! };
}

function absent(
  observedAt = '2026-07-11T11:30:00.000Z',
  requirement = 'same',
): ScannerObservation {
  const observation: ScannerObservation = {
    schemaVersion: 1,
    observedAt,
    repo,
    scannerId: 'merge-verify-contract',
    domain: 'verification',
    source: 'test',
    status: 'absent',
    reason: 'source-confirmed-empty',
    sourceBase: sourceBase('satisfied', requirement),
  };
  return { ...observation, observationDigest: buildScannerObservationDigest(observation)! };
}

function unavailable(observedAt = '2026-07-11T11:30:00.000Z'): ScannerObservation {
  return {
    schemaVersion: 1,
    observedAt,
    repo,
    scannerId: 'merge-verify-contract',
    domain: 'verification',
    source: 'test',
    status: 'unavailable',
    reason: 'source-dirty',
  };
}

function backlog(generatedAt: string, observations: ScannerObservation[]): Backlog {
  return {
    generatedAt,
    repos: [repo],
    items: [],
    observations,
    observationSourceState: 'healthy',
  };
}

function checkpoint(pending: ScannerObservation[] = [present()]): ResolutionObserverCheckpointV1 {
  return {
    schemaVersion: 1,
    backlogGeneratedAt: '2026-07-11T10:59:00.000Z',
    updatedAt: '2026-07-11T11:00:01.000Z',
    pending,
    lastRun: {
      observerRunId: 'resolution-observer:seed',
      startedAt: '2026-07-11T11:00:00.000Z',
      completedAt: '2026-07-11T11:00:01.000Z',
      outcome: 'seeded',
      backlogGeneratedAt: '2026-07-11T10:59:00.000Z',
      reposObserved: 1,
      pendingObjectives: pending.length,
      transitionsMatched: 0,
      recorded: 0,
      replayed: 0,
      conflicted: 0,
      invalid: 0,
      failed: 0,
    },
  };
}

describe('M367 bounded advisory resolution observer', () => {
  it('seeds a restart-safe pending-present checkpoint without minting a witness', () => {
    const result = runResolutionObserver({
      now: () => new Date('2026-07-11T11:01:00.000Z'),
      deps: { loadBacklog: () => backlog('2026-07-11T10:59:00.000Z', [present()]) },
    });

    expect(result).toMatchObject({ outcome: 'seeded', pendingObjectives: 1, recorded: 0 });
    expect(readResolutionObserverCheckpoint()).toMatchObject({
      sourceState: 'healthy',
      checkpoint: { pending: [expect.objectContaining({ itemId: 'repo:test:merge-contract' })] },
    });
    expect(readResolutionWitnesses().sourceState).toBe('missing');
  });

  it('records an authenticated transition and advances only after the witness write', () => {
    expect(writeResolutionObserverCheckpoint(checkpoint())).toBe(true);
    const result = runResolutionObserver({
      now: () => new Date('2026-07-11T11:31:00.000Z'),
      deps: { loadBacklog: () => backlog('2026-07-11T11:29:00.000Z', [absent()]) },
    });

    expect(result).toMatchObject({ outcome: 'completed', transitionsMatched: 1, recorded: 1, pendingObjectives: 0 });
    expect(readResolutionObserverCheckpoint().checkpoint).toMatchObject({
      backlogGeneratedAt: '2026-07-11T11:29:00.000Z',
      pending: [],
    });
    expect(readResolutionWitnesses()).toMatchObject({
      sourceState: 'healthy',
      witnesses: [expect.objectContaining({
        observerRunId: expect.stringMatching(/^resolution-observer:[a-f0-9]{32}$/),
        observationBaseDigest: present().sourceBase?.baseDigest,
        postStateBaseDigest: absent().sourceBase?.baseDigest,
      })],
    });
  });

  it('replays after a checkpoint crash without duplicating physical witness rows', () => {
    const prior = checkpoint();
    let writes = 0;
    const options = {
      now: () => new Date('2026-07-11T11:31:00.000Z'),
      deps: {
        loadBacklog: () => backlog('2026-07-11T11:29:00.000Z', [absent()]),
        readCheckpoint: () => ({ sourceState: 'healthy' as const, checkpoint: prior }),
        writeCheckpoint: () => ++writes > 1,
      },
    };

    expect(runResolutionObserver(options)).toMatchObject({ outcome: 'write-failed', recorded: 1 });
    expect(runResolutionObserver(options)).toMatchObject({ outcome: 'completed', replayed: 1 });
    expect(readResolutionWitnesses()).toMatchObject({ physicalRows: 1, witnesses: [expect.any(Object)] });
  });

  it('retains pending authority across unavailable or hashless current observations', () => {
    const prior = checkpoint();
    let persisted: ResolutionObserverCheckpointV1 | undefined;
    const run = (observation: ScannerObservation) => runResolutionObserver({
      now: () => new Date('2026-07-11T11:31:00.000Z'),
      deps: {
        loadBacklog: () => backlog('2026-07-11T11:29:00.000Z', [observation]),
        readCheckpoint: () => ({ sourceState: 'healthy', checkpoint: prior }),
        writeCheckpoint: (value) => { persisted = value; return true; },
      },
    });

    expect(run(unavailable())).toMatchObject({ outcome: 'completed', pendingObjectives: 1, recorded: 0 });
    expect(persisted?.pending).toHaveLength(1);
    expect(run({ ...absent(), sourceBase: undefined })).toMatchObject({ pendingObjectives: 1, recorded: 0 });
    expect(persisted?.pending).toHaveLength(1);
  });

  it('retires incompatible requirements without claiming a resolution', () => {
    const prior = checkpoint();
    let persisted: ResolutionObserverCheckpointV1 | undefined;
    const result = runResolutionObserver({
      now: () => new Date('2026-07-11T11:31:00.000Z'),
      deps: {
        loadBacklog: () => backlog('2026-07-11T11:29:00.000Z', [absent(undefined, 'changed')]),
        readCheckpoint: () => ({ sourceState: 'healthy', checkpoint: prior }),
        writeCheckpoint: (value) => { persisted = value; return true; },
      },
    });

    expect(result).toMatchObject({ outcome: 'completed', transitionsMatched: 0, recorded: 0, pendingObjectives: 0 });
    expect(persisted?.pending).toEqual([]);
  });

  it('fails closed on degraded sources, cancellation, caps, and stale snapshots', () => {
    const degraded = backlog('2026-07-11T11:29:00.000Z', [absent()]);
    degraded.observationSourceState = 'degraded';
    const controller = new AbortController();
    controller.abort();

    expect(runResolutionObserver({ deps: { loadBacklog: () => degraded } })).toMatchObject({ outcome: 'source-unavailable' });
    expect(runResolutionObserver({
      signal: controller.signal,
      deps: {
        loadBacklog: () => backlog('2026-07-11T11:29:00.000Z', [absent()]),
        readCheckpoint: () => ({ sourceState: 'healthy', checkpoint: checkpoint() }),
      },
    })).toMatchObject({ outcome: 'cancelled' });
    const secondRepo = `${repo}-2`;
    expect(runResolutionObserver({
      maxRepos: 1,
      deps: { loadBacklog: () => ({
        ...backlog('2026-07-11T11:29:00.000Z', [absent(), { ...absent(), repo: secondRepo }]),
        repos: [repo, secondRepo],
      }) },
    })).toMatchObject({ outcome: 'capacity-exceeded' });
    expect(runResolutionObserver({
      deps: {
        loadBacklog: () => backlog('2026-07-11T10:58:00.000Z', [absent()]),
        readCheckpoint: () => ({ sourceState: 'healthy', checkpoint: checkpoint() }),
      },
    })).toMatchObject({ outcome: 'stale' });
  });

  it('refuses incomplete scanner coverage and non-monotonic current evidence', () => {
    expect(runResolutionObserver({
      deps: { loadBacklog: () => ({ ...backlog('2026-07-11T11:29:00.000Z', []), repos: [repo] }) },
    })).toMatchObject({ outcome: 'source-unavailable' });
    expect(runResolutionObserver({
      deps: {
        loadBacklog: () => backlog('2026-07-11T11:29:00.000Z', [absent('2026-07-11T10:59:59.000Z')]),
        readCheckpoint: () => ({ sourceState: 'healthy', checkpoint: checkpoint() }),
      },
    })).toMatchObject({ outcome: 'source-unavailable', recorded: 0 });
  });

  it('suppresses overlapping schedules and shares the in-flight completion', async () => {
    const deps = { loadBacklog: () => backlog('2026-07-11T10:59:00.000Z', [present()]) };
    const first = scheduleResolutionObserver({ deps });
    const second = scheduleResolutionObserver({ deps });

    expect(first.disposition).toBe('scheduled');
    expect(second.disposition).toBe('overlap-suppressed');
    expect(second.completion).toBe(first.completion);
    await expect(first.completion).resolves.toMatchObject({ outcome: 'seeded' });
  });

  it('schedules only after a successful resident live tick', async () => {
    const scheduled = scheduleResolutionObserver({
      deps: { loadBacklog: () => backlog('2026-07-11T10:59:00.000Z', [present()]) },
    });
    await scheduled.completion;
    let calls = 0;
    const schedule = () => {
      calls += 1;
      return scheduled;
    };
    const tick = {
      ts: '2026-07-11T12:00:00.000Z',
      backlogSnapshotAt: '2026-07-11T12:00:00.500Z',
      backlogSnapshotId: 'a'.repeat(32),
      itemsConsidered: 0,
      proposalsCreated: 0,
      spentUsd: 0,
    };

    expect(scheduleResolutionObserverAfterTick(tick, { dryRun: false, once: false }, schedule)).toBe(scheduled);
    expect(scheduleResolutionObserverAfterTick(tick, { dryRun: true, once: false }, schedule)).toBeNull();
    expect(scheduleResolutionObserverAfterTick(tick, { dryRun: false, once: true }, schedule)).toBeNull();
    expect(scheduleResolutionObserverAfterTick(
      { ...tick, reason: 'state-persistence-failed' },
      { dryRun: false, once: false },
      schedule,
    )).toBeNull();
    expect(calls).toBe(1);
  });

  it('keeps pause non-quiesced until the detached child finishes its final write', () => {
    let pauseDuringWrite: ReturnType<typeof setKill> | undefined;
    const exitCode = runResolutionObserverChild([], {
      runObserver: (options) => {
        expect(options.deps?.writeCheckpoint?.(checkpoint())).toBe(true);
        return checkpoint().lastRun;
      },
      writeCheckpoint: () => {
        pauseDuringWrite = setKill(true, { waitMs: 25 });
        return true;
      },
    });

    expect(exitCode).toBe(0);
    expect(pauseDuringWrite).toEqual({
      ok: false,
      changed: true,
      quiesced: false,
      reason: 'kill armed; an outward mutation has not quiesced',
    });
    expect(setKill(true, { waitMs: 500 })).toMatchObject({
      ok: true,
      changed: false,
      quiesced: true,
    });
  });

  it('stores exact metadata privately and reports missing/degraded state honestly', () => {
    expect(readResolutionObserverStatus()).toMatchObject({ state: 'missing', witnesses: 0, pendingObjectives: 0 });
    expect(writeResolutionObserverCheckpoint(checkpoint())).toBe(true);
    expect(writeResolutionObserverRunSummary(checkpoint().lastRun)).toBe(true);
    const raw = readFileSync(resolutionObserverStatePath(), 'utf8');
    expect(raw).not.toContain('prompt');
    expect(readResolutionObserverStatus()).toMatchObject({
      state: 'healthy',
      checkpointState: 'healthy',
      witnessState: 'missing',
      pendingObjectives: 1,
    });

    const unsafeWriteCandidate = checkpoint();
    fx.cleanup();
    fx = makeFixture();
    const outside = join(fx.home, 'outside');
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, fx.ashlrDir);
    expect(readResolutionObserverCheckpoint().sourceState).toBe('degraded');
    expect(writeResolutionObserverCheckpoint(unsafeWriteCandidate)).toBe(false);
  });

  it('surfaces current versus stale observer freshness in Fleet Status and CLI output', async () => {
    expect(writeResolutionObserverCheckpoint(checkpoint())).toBe(true);
    expect(writeResolutionObserverRunSummary(checkpoint().lastRun)).toBe(true);
    writeFileSync(join(fx.ashlrDir, 'backlog.json'), JSON.stringify(backlog(
      '2026-07-11T10:59:00.000Z',
      [present()],
    )), { mode: 0o600 });
    const cfg = {
      version: 1,
      roots: [],
      editor: 'cursor',
      staleDays: 30,
      categories: {},
      tidyRules: [],
      keepers: [],
      models: { lmstudio: '', ollama: '', providerChain: [] },
      telemetry: {},
      tools: {},
    } as AshlrConfig;

    const current = await buildFleetStatus(cfg);
    expect(current.queue.resolutionObserver).toMatchObject({
      state: 'healthy',
      freshness: 'current',
      lagMs: 0,
      pendingObjectives: 1,
      witnesses: 0,
    });
    expect(formatFleetStatus(current)).toContain('resolution:    healthy/current');

    writeFileSync(join(fx.ashlrDir, 'backlog.json'), JSON.stringify(backlog(
      '2026-07-11T11:00:00.000Z',
      [present('2026-07-11T11:00:01.000Z')],
    )), { mode: 0o600 });
    const stale = await buildFleetStatus(cfg);
    expect(stale.queue.resolutionObserver).toMatchObject({ freshness: 'stale', lagMs: 60_000 });
  });
});
