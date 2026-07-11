import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import type { DispatchProductionEvent } from '../src/core/fleet/dispatch-production-ledger.js';
import { recordDispatchProduction } from '../src/core/fleet/dispatch-production-ledger.js';
import {
  compactRepairHandoffs,
  dispatchEventFromRepairHandoff,
  readRepairHandoffs,
  recordRepairHandoffs,
  repairHandoffFromDispatchEvent,
  repairHandoffJournalPath,
} from '../src/core/fleet/repair-handoff-journal.js';
import { queueProposalRepairWorkForPendingProposals } from '../src/core/fleet/proposal-repair-work.js';
import { scanQueuedAutonomyWork } from '../src/core/portfolio/scanners.js';
import {
  generatedRepairCooldownKey,
  readGeneratedRepairLifecycle,
  recordGeneratedRepairLifecycle,
} from '../src/core/fleet/generated-repair-lifecycle.js';
import { recentlyDeclined, recordOutcome } from '../src/core/fleet/worked-ledger.js';
import { pendingProposalItemKeysForBacklog, workItemCoverageKey } from '../src/core/fleet/proposal-matching.js';
import type { Proposal, WorkItem } from '../src/core/types.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { queueSelfHealItem } from '../src/core/fleet/self-heal.js';

let fx: H1Fixture;

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
});

afterEach(() => fx.cleanup());

function event(repo: string, overrides: Partial<DispatchProductionEvent> = {}): DispatchProductionEvent {
  return {
    schemaVersion: 1,
    ts: '2026-07-10T12:00:00.000Z',
    itemId: 'repo:self:parent-work',
    source: 'self',
    repo,
    title: 'DO_NOT_PERSIST_PARENT_TITLE',
    backend: 'local-coder',
    tier: 'local',
    assignedBy: 'daemon',
    routeReason: 'DO_NOT_PERSIST_ROUTE_REASON',
    outcome: 'empty-diff',
    proposalCreated: false,
    runId: 'attempt-12345678-1234-4123-8123-123456789abc',
    trajectoryId: 'run:attempt-12345678-1234-4123-8123-123456789abc',
    objectiveHash: 'a'.repeat(64),
    spentUsd: 0.01,
    reason: 'stdout=DO_NOT_PERSIST_STDOUT token=github_pat_1234567890abcdefghijklmnop',
    basis: 'run-proposal-outcome',
    ...overrides,
  };
}

describe('M362 durable repair handoff journal', () => {
  it('persists fixed routing provenance while excluding free-form execution text', () => {
    const repo = fx.makeRepo();
    const input = event(repo.dir);

    expect(recordRepairHandoffs(input)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(recordRepairHandoffs({ ...input, outcome: 'proposal-disabled' })).toEqual({ attempted: 0, recorded: 0, failed: 0 });
    const raw = readFileSync(repairHandoffJournalPath(), 'utf8');
    expect(raw).not.toContain('DO_NOT_PERSIST_PARENT_TITLE');
    expect(raw).not.toContain('DO_NOT_PERSIST_ROUTE_REASON');
    expect(raw).not.toContain('DO_NOT_PERSIST_STDOUT');
    expect(raw).not.toContain('github_pat_');
    const read = readRepairHandoffs();
    expect(read).toMatchObject({ sourceState: 'healthy', invalidRows: 0, conflictingIds: 0 });
    expect(read.observations[0]).toMatchObject({
      parentSource: 'self',
      parentBackend: 'local-coder',
      parentTier: 'local',
      parentObjectiveHash: 'a'.repeat(64),
    });
    expect(dispatchEventFromRepairHandoff(read.observations[0]!)).toMatchObject({
      source: 'self',
      backend: 'local-coder',
      tier: 'local',
      objectiveHash: 'a'.repeat(64),
    });
  });

  it('rejects raw objective values before journal persistence', () => {
    const repo = fx.makeRepo();
    recordRepairHandoffs(event(repo.dir, { objectiveHash: 'RAW_SECRET_VALUE' }));

    const raw = readFileSync(repairHandoffJournalPath(), 'utf8');
    expect(raw).not.toContain('RAW_SECRET_VALUE');
    expect(readRepairHandoffs().observations[0]).not.toHaveProperty('parentObjectiveHash');
  });

  it('accepts legacy rows and reconstructs their historical routing defaults', () => {
    const repo = fx.makeRepo();
    const observation = repairHandoffFromDispatchEvent(event(repo.dir))!;
    const legacy = { ...observation };
    delete legacy.parentSource;
    delete legacy.parentBackend;
    delete legacy.parentTier;
    delete legacy.parentObjectiveHash;
    mkdirSync(dirname(repairHandoffJournalPath()), { recursive: true });
    writeFileSync(repairHandoffJournalPath(), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

    const read = readRepairHandoffs();
    expect(read).toMatchObject({ sourceState: 'healthy', invalidRows: 0, conflictingIds: 0 });
    expect(read.observations).toHaveLength(1);
    expect(dispatchEventFromRepairHandoff(read.observations[0]!)).toMatchObject({
      source: 'self',
      backend: null,
      tier: null,
    });
  });

  it('quarantines a replay that retroactively adds objective authority', () => {
    const repo = fx.makeRepo();
    const eventValue = event(repo.dir);
    const observation = repairHandoffFromDispatchEvent(eventValue)!;
    const legacy = { ...observation };
    delete legacy.parentSource;
    delete legacy.parentBackend;
    delete legacy.parentTier;
    delete legacy.parentObjectiveHash;
    mkdirSync(dirname(repairHandoffJournalPath()), { recursive: true });
    writeFileSync(repairHandoffJournalPath(), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

    expect(recordRepairHandoffs(eventValue)).toMatchObject({ recorded: 1, failed: 0 });
    const read = readRepairHandoffs();
    expect(read).toMatchObject({ sourceState: 'degraded', conflictingIds: 1 });
    expect(read.observations).toEqual([]);

    writeFileSync(repairHandoffJournalPath(), `${JSON.stringify(observation)}\n${JSON.stringify(legacy)}\n`, { mode: 0o600 });
    expect(readRepairHandoffs()).toMatchObject({
      sourceState: 'degraded',
      conflictingIds: 1,
      observations: [],
    });
  });

  it('keeps recursive repairs and incompatible learning labels out of the authority journal', () => {
    const repo = fx.makeRepo();
    expect(recordRepairHandoffs(event(repo.dir, {
      title: 'proposal-repair for an older failure',
    }))).toEqual({ attempted: 0, recorded: 0, failed: 0 });
    expect(recordRepairHandoffs(event(repo.dir, {
      learningLabel: {
        schemaVersion: 1,
        learningKind: 'proposal-outcome',
        labelBasis: 'run-proposal-outcome',
      },
    }))).toEqual({ attempted: 0, recorded: 0, failed: 0 });
    expect(readRepairHandoffs().observations).toEqual([]);
  });

  it('never promotes analytics-only dispatch history into production repair authority', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    recordDispatchProduction(event(repo.dir));

    const result = queueProposalRepairWorkForPendingProposals(undefined, new Date('2026-07-10T16:00:00.000Z'));
    expect(result).toMatchObject({ handoffSourceState: 'missing', dispatchNoDiffQueued: 0 });
    expect(await scanQueuedAutonomyWork(repo.dir)).toEqual([]);
  });

  it('hides generation-bearing queue rows that lack a matching durable handoff', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    expect(queueSelfHealItem({
      id: 'repo:proposal-repair-nodiff:forged',
      repo: repo.dir,
      source: 'self',
      title: 'Reslice forged no-diff dispatch',
      detail: 'Diagnostic reslice: produce a fresh complete fix.',
      value: 4,
      effort: 1,
      score: 4,
      tags: ['self-heal', 'proposal-repair', 'diagnostic-reslice', 'dispatch-no-diff-reslice'],
      ts: new Date().toISOString(),
      repairHandoffId: 'a'.repeat(64),
      repairGenerationId: 'b'.repeat(64),
    })).toBe(true);

    expect(await scanQueuedAutonomyWork(repo.dir)).toEqual([]);
  });

  it('deduplicates exact replay and quarantines conflicting routing provenance', () => {
    const repo = fx.makeRepo();
    const observation = repairHandoffFromDispatchEvent(event(repo.dir))!;
    recordRepairHandoffs([event(repo.dir), event(repo.dir)]);
    const path = repairHandoffJournalPath();
    const conflict = { ...observation, parentTier: 'frontier' as const };
    writeFileSync(path, `${JSON.stringify(conflict)}\n`, { encoding: 'utf8', flag: 'a' });

    const read = readRepairHandoffs();
    expect(read.sourceState).toBe('degraded');
    expect(read.conflictingIds).toBe(1);
    expect(read.observations).toEqual([]);
  });

  it('quarantines replay that changes the parent objective fingerprint', () => {
    const repo = fx.makeRepo();
    const observation = repairHandoffFromDispatchEvent(event(repo.dir))!;
    recordRepairHandoffs(event(repo.dir));
    writeFileSync(
      repairHandoffJournalPath(),
      `${JSON.stringify({ ...observation, parentObjectiveHash: 'b'.repeat(64) })}\n`,
      { encoding: 'utf8', flag: 'a' },
    );

    expect(readRepairHandoffs()).toMatchObject({
      sourceState: 'degraded',
      conflictingIds: 1,
      observations: [],
    });
  });

  it('isolates a torn tail and preserves a later valid append', () => {
    const repo = fx.makeRepo();
    const first = event(repo.dir, { itemId: 'repo:self:first' });
    const second = event(repo.dir, {
      itemId: 'repo:self:second',
      ts: '2026-07-10T12:01:00.000Z',
      runId: 'attempt-22345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-22345678-1234-4123-8123-123456789abc',
    });
    recordRepairHandoffs(first);
    writeFileSync(repairHandoffJournalPath(), '{"partial":', { encoding: 'utf8', flag: 'a' });
    expect(recordRepairHandoffs(second)).toMatchObject({ recorded: 1, failed: 0 });

    const read = readRepairHandoffs();
    expect(read.sourceState).toBe('degraded');
    expect(read.invalidRows).toBe(1);
    expect(read.observations.map((row) => row.parentItemId).sort()).toEqual([
      'repo:self:first',
      'repo:self:second',
    ]);
    expect(compactRepairHandoffs()).toEqual({ available: true, before: 3, after: 2, removed: 1 });
    expect(readRepairHandoffs().sourceState).toBe('healthy');
  });

  it('reconstructs an old unprojected child without dispatch-history limits', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const old = event(repo.dir, { ts: '2026-06-01T12:00:00.000Z' });
    recordRepairHandoffs(old);

    const result = queueProposalRepairWorkForPendingProposals(undefined, new Date('2026-07-10T16:00:00.000Z'));
    const queued = await scanQueuedAutonomyWork(repo.dir);

    expect(result).toMatchObject({ handoffObservations: 1, handoffSourceState: 'healthy', dispatchNoDiffQueued: 1 });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ source: 'self' });
    expect(queued[0]!.repairHandoffId).toMatch(/^[a-f0-9]{64}$/);
    expect(queued[0]!.repairGenerationId).toMatch(/^[a-f0-9]{64}$/);
    expect(queued[0]!.tags).toContain('dispatch-no-diff-reslice');
    expect(readGeneratedRepairLifecycle(queued[0]!).disposition).toBe('active');
  });

  it('does not persist or project from an unsafe journal target', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const path = repairHandoffJournalPath();
    mkdirSync(dirname(path), { recursive: true });
    mkdirSync(path);

    expect(recordRepairHandoffs(event(repo.dir))).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(readRepairHandoffs().sourceState).toBe('degraded');
    expect(queueProposalRepairWorkForPendingProposals(undefined, new Date())).toMatchObject({
      handoffObservations: 0,
      handoffSourceState: 'degraded',
    });
    expect(await scanQueuedAutonomyWork(repo.dir)).toEqual([]);
  });

  it('serializes concurrent queue producers without dropping unrelated work', async () => {
    const repo = fx.makeRepo();
    const script = [
      `import { queueSelfHealItem } from './src/core/fleet/self-heal.ts';`,
      `const item = JSON.parse(process.env.ASHLR_TEST_ITEM);`,
      `process.exit(queueSelfHealItem(item) ? 0 : 1);`,
    ].join(' ');
    const children = Array.from({ length: 12 }, (_, index) => new Promise<void>((resolve, reject) => {
      const child = spawn(join(process.cwd(), 'node_modules', '.bin', 'tsx'), ['-e', script], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: fx.home,
          USERPROFILE: fx.home,
          ASHLR_HOME: fx.ashlrDir,
          ASHLR_TEST_ITEM: JSON.stringify({
            id: `concurrent-${index}`,
            repo: repo.dir,
            source: 'self',
            title: `Concurrent item ${index}`,
            detail: 'Self-heal: code failure requires a focused fix.',
            value: 5,
            effort: 1,
            score: 5,
            tags: ['self-heal', 'test', 'high-priority'],
            ts: new Date().toISOString(),
          }),
        },
        stdio: 'pipe',
      });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`queue child exited ${code}`)));
    }));

    await Promise.all(children);
    const queue = JSON.parse(readFileSync(join(fx.ashlrDir, 'self-heal-queue.json'), 'utf8')) as Array<{ id: string }>;
    expect(queue).toHaveLength(12);
    expect(new Set(queue.map((item) => item.id)).size).toBe(12);
  }, 20_000);

  it('preserves a concurrent journal burst and collapses replay by semantic event id', async () => {
    const repo = fx.makeRepo();
    const script = [
      `import { recordRepairHandoffs } from './src/core/fleet/repair-handoff-journal.ts';`,
      `const event = JSON.parse(process.env.ASHLR_TEST_EVENT);`,
      `const result = recordRepairHandoffs(event);`,
      `process.exit(result.recorded === 1 ? 0 : 1);`,
    ].join(' ');
    const inputs = Array.from({ length: 12 }, (_, index) => event(repo.dir, {
      itemId: `repo:self:journal-${index}`,
      runId: `attempt-${String(index).padStart(8, '0')}-1234-4123-8123-123456789abc`,
      trajectoryId: `run:attempt-${String(index).padStart(8, '0')}-1234-4123-8123-123456789abc`,
    }));
    await Promise.all(inputs.map((input) => new Promise<void>((resolve, reject) => {
      const child = spawn(join(process.cwd(), 'node_modules', '.bin', 'tsx'), ['-e', script], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: fx.home,
          USERPROFILE: fx.home,
          ASHLR_HOME: fx.ashlrDir,
          ASHLR_TEST_EVENT: JSON.stringify(input),
        },
        stdio: 'pipe',
      });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`journal child exited ${code}`)));
    })));
    recordRepairHandoffs(inputs[0]!);

    const read = readRepairHandoffs();
    expect(read.sourceState).toBe('healthy');
    expect(read.observations).toHaveLength(12);
    expect(new Set(read.observations.map((row) => row.eventId)).size).toBe(12);
  }, 20_000);

  it('does not let an older pending proposal suppress a newer repair generation', () => {
    const repo = fx.makeRepo();
    const current: WorkItem = {
      id: 'repo:proposal-repair-nodiff:stable-child',
      repo: repo.dir,
      source: 'self',
      title: 'Reslice no-diff dispatch for repo item parent',
      detail: 'Diagnostic reslice: produce a fresh complete fix.',
      value: 4,
      effort: 1,
      score: 4,
      tags: ['self-heal', 'proposal-repair', 'diagnostic-reslice', 'dispatch-no-diff-reslice'],
      ts: new Date().toISOString(),
      repairHandoffId: 'a'.repeat(64),
      repairGenerationId: 'b'.repeat(64),
    };
    const oldProposal = {
      id: 'prop-old-generation',
      title: 'Old repair',
      summary: 'Old generation remains pending.',
      repo: repo.dir,
      workItemId: current.id,
      workItemGenerationId: 'c'.repeat(64),
      status: 'pending',
    } satisfies Pick<Proposal, 'id' | 'title' | 'summary' | 'repo' | 'workItemId' | 'workItemGenerationId' | 'status'>;

    const keys = pendingProposalItemKeysForBacklog([current], [oldProposal]);
    expect(keys.has(workItemCoverageKey(current))).toBe(false);
  });

  it('keeps terminal generations absorbed while allowing a later parent recurrence', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const firstEvent = event(repo.dir, { ts: '2026-07-10T12:00:00.000Z' });
    recordRepairHandoffs(firstEvent);
    queueProposalRepairWorkForPendingProposals(undefined, new Date('2026-07-10T13:00:00.000Z'));
    const first = (await scanQueuedAutonomyWork(repo.dir))[0]!;
    const firstCooldownKey = generatedRepairCooldownKey(first);
    recordGeneratedRepairLifecycle(first, {
      kind: 'proposal-created',
      attemptId: 'attempt-32345678-1234-4123-8123-123456789abc',
      proposalId: 'prop-terminal-generation',
    });

    queueProposalRepairWorkForPendingProposals(undefined, new Date('2026-07-10T13:01:00.000Z'));
    expect(await scanQueuedAutonomyWork(repo.dir)).toEqual([]);

    const recurrence = event(repo.dir, {
      ts: '2026-07-10T14:00:00.000Z',
      runId: 'attempt-42345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-42345678-1234-4123-8123-123456789abc',
    });
    recordRepairHandoffs(recurrence);
    queueProposalRepairWorkForPendingProposals(undefined, new Date('2026-07-10T15:00:00.000Z'));
    const active = await scanQueuedAutonomyWork(repo.dir);

    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(first.id);
    expect(active[0]!.repairGenerationId).not.toBe(first.repairGenerationId);
    expect(readGeneratedRepairLifecycle(active[0]!).disposition).toBe('active');
    recordOutcome(firstCooldownKey, 'empty');
    expect(recentlyDeclined(firstCooldownKey, 60_000)).toBe(true);
    expect(recentlyDeclined(generatedRepairCooldownKey(active[0]!), 60_000)).toBe(false);
  });

  it('advances bounded projection past already-present newest rows', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const observations = Array.from({ length: 7 }, (_, index) => event(repo.dir, {
      itemId: `repo:self:bounded-${index}`,
      ts: `2026-07-10T12:0${index}:00.000Z`,
      runId: `attempt-${index}2345678-1234-4123-8123-123456789abc`,
      trajectoryId: `run:attempt-${index}2345678-1234-4123-8123-123456789abc`,
    }));
    recordRepairHandoffs(observations);
    for (let pass = 0; pass < 4; pass++) {
      queueProposalRepairWorkForPendingProposals(undefined, new Date('2026-07-10T16:00:00.000Z'), {
        maxDispatchNoDiffQueued: 2,
      });
    }

    const queued = await scanQueuedAutonomyWork(repo.dir);
    expect(queued).toHaveLength(7);
    expect(new Set(queued.map((item) => item.repairGenerationId)).size).toBe(7);
  });

  it('treats timestamp-only replay of one parent attempt as one generation', () => {
    const repo = fx.makeRepo();
    const first = event(repo.dir, { ts: '2026-07-10T12:00:00.000Z' });
    const replay = event(repo.dir, { ts: '2026-07-10T12:05:00.000Z' });
    recordRepairHandoffs([first, replay]);

    const read = readRepairHandoffs();
    expect(read.sourceState).toBe('healthy');
    expect(read.observations).toHaveLength(1);
    expect(compactRepairHandoffs()).toEqual({ available: true, before: 2, after: 1, removed: 1 });
  });

  it('preserves superseded generation fingerprints as immutable conflict history', () => {
    const repo = fx.makeRepo();
    const first = event(repo.dir, {
      ts: '2026-07-10T12:00:00.000Z',
      runId: 'attempt-52345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-52345678-1234-4123-8123-123456789abc',
    });
    const newest = event(repo.dir, {
      ts: '2026-07-10T13:00:00.000Z',
      runId: 'attempt-62345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-62345678-1234-4123-8123-123456789abc',
    });
    recordRepairHandoffs([first, newest]);

    expect(compactRepairHandoffs()).toEqual({ available: true, before: 2, after: 2, removed: 0 });
    const read = readRepairHandoffs();
    expect(read.sourceState).toBe('healthy');
    expect(read.observations).toHaveLength(2);
    expect(read.observations[0]!.parentAttemptId).toBe(newest.trajectoryId);
  });

  it('keeps compacted history able to quarantine a changed old replay', () => {
    const repo = fx.makeRepo();
    const firstEvent = event(repo.dir, {
      runId: 'attempt-72345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-72345678-1234-4123-8123-123456789abc',
    });
    const newestEvent = event(repo.dir, {
      ts: '2026-07-10T13:00:00.000Z',
      runId: 'attempt-82345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-82345678-1234-4123-8123-123456789abc',
    });
    const first = repairHandoffFromDispatchEvent(firstEvent)!;
    recordRepairHandoffs([firstEvent, newestEvent]);
    expect(compactRepairHandoffs()).toMatchObject({ available: true, after: 2 });

    writeFileSync(
      repairHandoffJournalPath(),
      `${JSON.stringify({ ...first, parentObjectiveHash: 'b'.repeat(64) })}\n`,
      { encoding: 'utf8', flag: 'a' },
    );

    const read = readRepairHandoffs();
    expect(read).toMatchObject({ sourceState: 'degraded', conflictingIds: 1 });
    expect(read.observations.map((row) => row.parentAttemptId)).toEqual([newestEvent.trajectoryId]);
  });

  it('recovers malformed crash locks after grace and never releases a successor inode', () => {
    const lockPath = join(fx.ashlrDir, 'fleet', 'm362.lock');
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, '');
    const old = new Date(Date.now() - 5_000);
    utimesSync(lockPath, old, old);

    const acquired = acquireLocalStoreLock(lockPath, 2_000);
    expect(acquired).not.toBeNull();
    const priorPath = `${lockPath}.prior`;
    renameSync(lockPath, priorPath);
    writeFileSync(lockPath, 'successor');
    releaseLocalStoreLock(acquired);

    expect(existsSync(lockPath)).toBe(true);
    rmSync(lockPath);
    rmSync(priorPath);
  });

  it('recovers a dead owner that crashed during hard-link lock installation', () => {
    const lockPath = join(fx.ashlrDir, 'fleet', 'm362-install.lock');
    const candidate = `${lockPath}.2147483647.dead-owner.candidate`;
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(candidate, `${JSON.stringify({
      pid: 2_147_483_647,
      token: 'dead-owner',
      startRef: 'a'.repeat(64),
      startRefVerified: true,
    })}\n`, { mode: 0o600 });
    linkSync(candidate, lockPath);

    const acquired = acquireLocalStoreLock(lockPath, 2_000);
    expect(acquired).not.toBeNull();
    expect(existsSync(candidate)).toBe(false);
    releaseLocalStoreLock(acquired);
    expect(existsSync(lockPath)).toBe(false);
  });
});
