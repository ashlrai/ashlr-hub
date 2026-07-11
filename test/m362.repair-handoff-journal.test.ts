import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import type { DispatchProductionEvent } from '../src/core/fleet/dispatch-production-ledger.js';
import { dispatchProductionDir, recordDispatchProduction } from '../src/core/fleet/dispatch-production-ledger.js';
import {
  compactRepairHandoffs,
  dispatchEventFromRepairHandoff,
  readRepairHandoffs,
  readRepairHandoffSchemaSummary,
  recordRepairHandoffs as recordRepairHandoffsRaw,
  repairGenerationIdFromHandoffId,
  repairHandoffFromDispatchEvent,
  repairHandoffJournalPath,
  repairHandoffV2JournalPath,
  type RepairHandoffObservation,
  type RepairHandoffObservationV1,
} from '../src/core/fleet/repair-handoff-journal.js';
import { queueProposalRepairWorkForPendingProposals } from '../src/core/fleet/proposal-repair-work.js';
import { scanQueuedAutonomyWork } from '../src/core/portfolio/scanners.js';
import {
  generatedRepairCooldownKey,
  generatedRepairCooldownKeys,
  generatedRepairGenerationId,
  generatedRepairGenerationIds,
  readGeneratedRepairLifecycle,
  recordGeneratedRepairLifecycle,
} from '../src/core/fleet/generated-repair-lifecycle.js';
import { recentlyDeclined, recordOutcome } from '../src/core/fleet/worked-ledger.js';
import { pendingProposalItemKeysForBacklog, workItemCoverageKey } from '../src/core/fleet/proposal-matching.js';
import type { Proposal, WorkItem } from '../src/core/types.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { queueSelfHealItem } from '../src/core/fleet/self-heal.js';
import { repairTreatmentForUnitId } from '../src/core/fleet/generated-repair-identity.js';

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

function recordRepairHandoffs(
  input: DispatchProductionEvent | DispatchProductionEvent[],
) {
  return recordRepairHandoffsRaw(input, { schemaVersion: 2 });
}

function legacyObservation(observation: RepairHandoffObservation): RepairHandoffObservationV1 {
  const {
    repairTreatmentUnitId: _repairTreatmentUnitId,
    repairTreatment: _repairTreatment,
    ...historical
  } = observation;
  const eventId = createHash('sha256').update(JSON.stringify([
    'ashlr:repair-handoff:v1', observation.kind, observation.repo, observation.parentItemId,
    observation.parentOutcome, observation.parentAttemptId,
  ])).digest('hex');
  return {
    ...historical,
    schemaVersion: 1,
    eventId,
    generationId: repairGenerationIdFromHandoffId(eventId)!,
  };
}

function reidentifyV2Observation(
  observation: Extract<RepairHandoffObservation, { schemaVersion: 2 }>,
  overrides: Partial<Extract<RepairHandoffObservation, { schemaVersion: 2 }>>,
): Extract<RepairHandoffObservation, { schemaVersion: 2 }> {
  const row = { ...observation, ...overrides };
  const eventId = createHash('sha256').update(JSON.stringify([
    'ashlr:repair-handoff:v2', row.kind, row.repo, row.parentItemId,
    row.parentObjectiveHash,
  ])).digest('hex');
  const domain = row.kind === 'capture-repair'
    ? 'dispatch-capture-gate-repair'
    : 'dispatch-no-diff-reslice';
  const prefix = row.kind === 'capture-repair'
    ? 'proposal-repair-capture'
    : 'proposal-repair-nodiff';
  const childHash = createHash('sha1')
    .update(`${resolve(row.repo)}\0${row.parentItemId}\0${domain}`)
    .digest('hex')
    .slice(0, 12);
  return {
    ...row,
    eventId,
    generationId: repairGenerationIdFromHandoffId(eventId)!,
    childItemId: `${basename(row.repo)}:${prefix}:${childHash}`,
  };
}

describe('M362 durable repair handoff journal', () => {
  it('does not assign diagnostic treatment metadata to capture repairs', () => {
    const repo = fx.makeRepo();
    const observation = repairHandoffFromDispatchEvent(event(repo.dir, {
      outcome: 'proposal-capture-error',
      source: 'self',
      diffFiles: 1,
    }))!;

    expect(observation.kind).toBe('capture-repair');
    expect(observation).not.toHaveProperty('repairTreatment');
    expect(recordRepairHandoffs(event(repo.dir, {
      outcome: 'proposal-capture-error',
      source: 'self',
      diffFiles: 1,
    }))).toMatchObject({ recorded: 1, failed: 0 });
  });

  it('persists fixed routing provenance while excluding free-form execution text', () => {
    const repo = fx.makeRepo();
    const input = event(repo.dir);

    expect(recordRepairHandoffs(input)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(recordRepairHandoffs({ ...input, outcome: 'proposal-disabled' })).toEqual({ attempted: 0, recorded: 0, failed: 0 });
    const raw = readFileSync(repairHandoffV2JournalPath(), 'utf8');
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

  it('uses one v2 generation for repeated attempts of the same objective', () => {
    const repo = fx.makeRepo();
    const first = repairHandoffFromDispatchEvent(event(repo.dir))!;
    const recurrence = repairHandoffFromDispatchEvent(event(repo.dir, {
      ts: '2026-07-10T13:00:00.000Z',
      runId: 'attempt-22345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-22345678-1234-4123-8123-123456789abc',
    }))!;

    expect(first.schemaVersion).toBe(2);
    expect(recurrence.eventId).toBe(first.eventId);
    expect(recurrence.generationId).toBe(first.generationId);
  });

  it('keeps v2 writing default-off and isolates enabled authority for rollback', () => {
    const repo = fx.makeRepo();
    const input = event(repo.dir);

    expect(recordRepairHandoffsRaw(input)).toMatchObject({ recorded: 1, failed: 0 });
    expect(existsSync(repairHandoffJournalPath())).toBe(true);
    expect(existsSync(repairHandoffV2JournalPath())).toBe(false);
    expect(readRepairHandoffs().observations[0]?.schemaVersion).toBe(1);
    expect(readRepairHandoffSchemaSummary()).toMatchObject({
      sourceState: 'healthy',
      v1Authorities: 1,
      v2Authorities: 0,
      v1PhysicalRows: 1,
      v2PhysicalRows: 0,
      aliasFamilies: 0,
      latestV2At: null,
    });

    expect(recordRepairHandoffsRaw(input, { schemaVersion: 2 })).toMatchObject({ recorded: 1, failed: 0 });
    const v2Before = readFileSync(repairHandoffV2JournalPath(), 'utf8');
    const legacyBefore = readFileSync(repairHandoffJournalPath(), 'utf8');
    // A legacy reader/compactor only knows this path; rewriting it cannot touch
    // the sidecar owned by the reader-first v2 release.
    writeFileSync(repairHandoffJournalPath(), legacyBefore, { mode: 0o600 });

    expect(readFileSync(repairHandoffV2JournalPath(), 'utf8')).toBe(v2Before);
    expect(readRepairHandoffs().observations.map((row) => row.schemaVersion).sort()).toEqual([1, 2]);
    expect(readRepairHandoffSchemaSummary()).toMatchObject({
      sourceState: 'healthy',
      v1Authorities: 1,
      v2Authorities: 1,
      v1PhysicalRows: 1,
      v2PhysicalRows: 1,
      aliasFamilies: 1,
      latestV2At: input.ts,
      authorityDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      invalidRows: 0,
      conflictingIds: 0,
      limitExceeded: false,
    });
  });

  it('mints a fresh v2 generation when the objective fingerprint changes', () => {
    const repo = fx.makeRepo();
    const first = repairHandoffFromDispatchEvent(event(repo.dir))!;
    const changed = repairHandoffFromDispatchEvent(event(repo.dir, {
      objectiveHash: 'b'.repeat(64),
      runId: 'attempt-22345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-22345678-1234-4123-8123-123456789abc',
    }))!;

    expect(changed.eventId).not.toBe(first.eventId);
    expect(changed.generationId).not.toBe(first.generationId);
  });

  it('projects newest route provenance without resetting objective control identity', () => {
    const repo = fx.makeRepo();
    const firstEvent = event(repo.dir);
    const newestEvent = event(repo.dir, {
      ts: '2026-07-10T13:00:00.000Z',
      backend: 'codex',
      tier: 'frontier',
      runId: 'attempt-22345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-22345678-1234-4123-8123-123456789abc',
    });
    recordRepairHandoffs([firstEvent, newestEvent]);

    const read = readRepairHandoffs();
    expect(read).toMatchObject({ sourceState: 'healthy', conflictingIds: 0 });
    expect(read.observations).toHaveLength(1);
    expect(read.observations[0]).toMatchObject({
      parentBackend: 'codex',
      parentTier: 'frontier',
      parentAttemptId: newestEvent.trajectoryId,
    });
  });

  it('fails closed on distinct v2 attempts with an equal timestamp', () => {
    const repo = fx.makeRepo();
    recordRepairHandoffs([
      event(repo.dir),
      event(repo.dir, {
        runId: 'attempt-22345678-1234-4123-8123-123456789abc',
        trajectoryId: 'run:attempt-22345678-1234-4123-8123-123456789abc',
      }),
    ]);
    expect(readRepairHandoffs()).toMatchObject({
      sourceState: 'degraded',
      conflictingIds: 1,
      observations: [],
    });
  });

  it('keeps capture failure outcomes in one objective generation', () => {
    const repo = fx.makeRepo();
    const gate = repairHandoffFromDispatchEvent(event(repo.dir, {
      outcome: 'gate-blocked',
      diffFiles: 1,
    }))!;
    const capture = repairHandoffFromDispatchEvent(event(repo.dir, {
      ts: '2026-07-10T13:00:00.000Z',
      outcome: 'proposal-capture-error',
      runId: 'attempt-22345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-22345678-1234-4123-8123-123456789abc',
    }))!;
    expect(capture.kind).toBe('capture-repair');
    expect(capture.eventId).toBe(gate.eventId);
    expect(capture.generationId).toBe(gate.generationId);
  });

  it('rejects raw objective values before journal persistence', () => {
    const repo = fx.makeRepo();
    expect(recordRepairHandoffs(event(repo.dir, { objectiveHash: 'RAW_SECRET_VALUE' })))
      .toEqual({ attempted: 0, recorded: 0, failed: 0 });
    expect(existsSync(repairHandoffJournalPath())).toBe(false);
    expect(readRepairHandoffs()).toMatchObject({ sourceState: 'missing', observations: [] });
  });

  it('accepts legacy rows and reconstructs their historical routing defaults', () => {
    const repo = fx.makeRepo();
    const observation = repairHandoffFromDispatchEvent(event(repo.dir))!;
    const {
      parentSource: _parentSource,
      parentBackend: _parentBackend,
      parentTier: _parentTier,
      parentObjectiveHash: _parentObjectiveHash,
      ...legacy
    } = legacyObservation(observation);
    recordDispatchProduction(event(repo.dir));
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

  it('keeps V1 authority healthy when an upgrade replay adds canonical treatment metadata', () => {
    const repo = fx.makeRepo();
    const input = event(repo.dir, { itemId: 'repo:goal:v1-treatment-enrichment' });
    const historical = legacyObservation(repairHandoffFromDispatchEvent(input)!);
    recordDispatchProduction(input);
    mkdirSync(dirname(repairHandoffJournalPath()), { recursive: true });
    writeFileSync(repairHandoffJournalPath(), `${JSON.stringify(historical)}\n`, { mode: 0o600 });

    expect(recordRepairHandoffsRaw(input)).toMatchObject({ recorded: 1, failed: 0 });
    expect(readRepairHandoffs()).toMatchObject({
      sourceState: 'healthy',
      invalidRows: 0,
      conflictingIds: 0,
      observations: [expect.objectContaining({ eventId: historical.eventId })],
    });
  });

  it('rejects tampered treatment metadata on a v1-authorized diagnostic item', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const input = event(repo.dir, { itemId: 'repo:self:v1-treatment-tamper' });
    expect(recordRepairHandoffsRaw(input)).toMatchObject({ recorded: 1, failed: 0 });
    queueProposalRepairWorkForPendingProposals(undefined, new Date('2026-07-10T12:30:00.000Z'));
    const item = (await scanQueuedAutonomyWork(repo.dir))[0]!;
    const tampered: WorkItem = {
      ...item,
      repairTreatment: item.repairTreatment === 'baseline-reslice'
        ? 'target-localization'
        : 'baseline-reslice',
    };

    expect(item.repairTreatment).toBe(repairTreatmentForUnitId(item.repairTreatmentUnitId!));
    expect(generatedRepairGenerationId(tampered)).toBeNull();
    expect(generatedRepairGenerationIds(tampered)).toEqual([]);
  });

  it('keeps v1 authority immutable when a matching v2 objective arrives', () => {
    const repo = fx.makeRepo();
    const eventValue = event(repo.dir);
    const observation = repairHandoffFromDispatchEvent(eventValue)!;
    const {
      parentSource: _parentSource,
      parentBackend: _parentBackend,
      parentTier: _parentTier,
      parentObjectiveHash: _parentObjectiveHash,
      ...legacy
    } = legacyObservation(observation);
    mkdirSync(dirname(repairHandoffJournalPath()), { recursive: true });
    writeFileSync(repairHandoffJournalPath(), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

    expect(recordRepairHandoffs(eventValue)).toMatchObject({ recorded: 1, failed: 0 });
    const read = readRepairHandoffs();
    expect(read).toMatchObject({ sourceState: 'healthy', conflictingIds: 0 });
    expect(read.observations).toHaveLength(2);
    expect(read.observations.find((row) => row.schemaVersion === 1)).not.toHaveProperty('parentObjectiveHash');
    expect(read.observations.find((row) => row.schemaVersion === 2)?.parentObjectiveHash)
      .toBe(eventValue.objectiveHash);
  });

  it('assigns V1/V2 objective aliases to the same treatment unit and arm', () => {
    const repo = fx.makeRepo();
    const input = event(repo.dir, { itemId: 'repo:goal:alias-stability' });

    expect(recordRepairHandoffsRaw(input)).toMatchObject({ recorded: 1, failed: 0 });
    expect(recordRepairHandoffs(input)).toMatchObject({ recorded: 1, failed: 0 });
    const aliases = readRepairHandoffs().observations;

    expect(aliases).toHaveLength(2);
    expect(new Set(aliases.map((row) => row.generationId)).size).toBe(2);
    expect(new Set(aliases.map((row) => row.repairTreatmentUnitId)).size).toBe(1);
    expect(new Set(aliases.map((row) => row.repairTreatment)).size).toBe(1);
    expect(aliases[0]!.repairTreatment).toBe(repairTreatmentForUnitId(aliases[0]!.repairTreatmentUnitId!));
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
    const path = repairHandoffV2JournalPath();
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
      repairHandoffV2JournalPath(),
      `${JSON.stringify({ ...observation, parentObjectiveHash: 'b'.repeat(64) })}\n`,
      { encoding: 'utf8', flag: 'a' },
    );

    expect(readRepairHandoffs()).toMatchObject({
      sourceState: 'degraded',
      conflictingIds: 1,
      observations: [],
    });
  });

  it('quarantines a malformed claimed id across compaction and later replay', () => {
    const repo = fx.makeRepo();
    const observation = repairHandoffFromDispatchEvent(event(repo.dir))!;
    mkdirSync(dirname(repairHandoffV2JournalPath()), { recursive: true });
    writeFileSync(
      repairHandoffV2JournalPath(),
      `${JSON.stringify({ ...observation, generationId: 'malformed' })}\n`,
      { mode: 0o600 },
    );

    expect(readRepairHandoffs()).toMatchObject({
      sourceState: 'degraded',
      invalidRows: 1,
      conflictingIds: 1,
      observations: [],
    });
    expect(compactRepairHandoffs()).toEqual({ available: false, before: 1, after: 0, removed: 0 });

    writeFileSync(
      repairHandoffV2JournalPath(),
      `${JSON.stringify(observation)}\n`,
      { encoding: 'utf8', flag: 'a' },
    );
    expect(readRepairHandoffs()).toMatchObject({
      sourceState: 'degraded',
      invalidRows: 1,
      conflictingIds: 1,
      observations: [],
    });
  });

  it('rejects self-consistent v2 authority with a noncanonical repo path', () => {
    const repo = fx.makeRepo();
    const observation = repairHandoffFromDispatchEvent(event(repo.dir))!;
    const forged = reidentifyV2Observation(observation, {
      repo: relative(process.cwd(), repo.dir),
    });
    mkdirSync(dirname(repairHandoffV2JournalPath()), { recursive: true });
    writeFileSync(repairHandoffV2JournalPath(), `${JSON.stringify(forged)}\n`, { mode: 0o600 });

    expect(readRepairHandoffs()).toMatchObject({
      sourceState: 'degraded',
      invalidRows: 1,
      conflictingIds: 1,
      observations: [],
    });
  });

  it('rejects v2 authority with a parseable noncanonical timestamp', () => {
    const repo = fx.makeRepo();
    const observation = repairHandoffFromDispatchEvent(event(repo.dir))!;
    mkdirSync(dirname(repairHandoffV2JournalPath()), { recursive: true });
    writeFileSync(
      repairHandoffV2JournalPath(),
      `${JSON.stringify({ ...observation, ts: 'July 10, 2026 12:00:00 UTC' })}\n`,
      { mode: 0o600 },
    );

    expect(readRepairHandoffs()).toMatchObject({
      sourceState: 'degraded',
      invalidRows: 1,
      conflictingIds: 1,
      observations: [],
    });
  });

  it('withholds a self-consistent child when its durable parent is missing', () => {
    const repo = fx.makeRepo();
    const observation = repairHandoffFromDispatchEvent(event(repo.dir, {
      itemId: 'repo:self:orphan-parent',
    }))!;
    mkdirSync(dirname(repairHandoffV2JournalPath()), { recursive: true });
    writeFileSync(repairHandoffV2JournalPath(), `${JSON.stringify(observation)}\n`, { mode: 0o600 });

    expect(readRepairHandoffs()).toMatchObject({ sourceState: 'degraded', observations: [] });
  });

  it('revokes child authority when its durable parent evidence is removed', () => {
    const prior = process.env.ASHLR_HOME;
    process.env.ASHLR_HOME = fx.ashlrDir;
    try {
      const repo = fx.makeRepo();
      expect(recordRepairHandoffs(event(repo.dir, {
        itemId: 'repo:self:removed-parent',
      }))).toMatchObject({ recorded: 1, failed: 0 });
      expect(readRepairHandoffs()).toMatchObject({ sourceState: 'healthy' });

      writeFileSync(join(dispatchProductionDir(), '2026-07-10.jsonl'), '', { mode: 0o600 });
      expect(readRepairHandoffs()).toMatchObject({ sourceState: 'degraded', observations: [] });
    } finally {
      if (prior === undefined) delete process.env.ASHLR_HOME;
      else process.env.ASHLR_HOME = prior;
    }
  });

  it('keeps an exact parent authoritative beyond observational event limits', () => {
    const prior = process.env.ASHLR_HOME;
    process.env.ASHLR_HOME = fx.ashlrDir;
    try {
      const repo = fx.makeRepo();
      expect(recordRepairHandoffs(event(repo.dir, {
        itemId: 'repo:self:bounded-parent-lookup',
      }))).toMatchObject({ recorded: 1, failed: 0 });
      const parentPath = join(dispatchProductionDir(), '2026-07-10.jsonl');
      const existing = readFileSync(parentPath, 'utf8');
      const unrelated = Array.from({ length: 2_001 }, (_, index) => JSON.stringify(event(repo.dir, {
        itemId: `repo:self:unrelated-${index}`,
        ts: '2026-07-10T13:00:00.000Z',
      }))).join('\n');
      writeFileSync(parentPath, `${existing}${unrelated}\n`, { mode: 0o600 });

      expect(readRepairHandoffs()).toMatchObject({
        sourceState: 'healthy',
        observations: [expect.objectContaining({ parentItemId: 'repo:self:bounded-parent-lookup' })],
      });
    } finally {
      if (prior === undefined) delete process.env.ASHLR_HOME;
      else process.env.ASHLR_HOME = prior;
    }
  });

  it('does not append a child when parent persistence is unavailable', () => {
    const prior = process.env.ASHLR_HOME;
    const unavailable = join(fx.home, 'dispatch-home-file');
    writeFileSync(unavailable, 'not a directory', 'utf8');
    process.env.ASHLR_HOME = unavailable;
    try {
      const repo = fx.makeRepo();
      expect(recordRepairHandoffs(event(repo.dir, {
        itemId: 'repo:self:parent-write-failed',
      }))).toEqual({ attempted: 1, recorded: 0, failed: 1 });
      expect(existsSync(repairHandoffV2JournalPath())).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.ASHLR_HOME;
      else process.env.ASHLR_HOME = prior;
    }
  });

  it('canonicalizes and scrubs parent identity before either causal ledger persists it', () => {
    const repo = fx.makeRepo();
    const secret = 'github_pat_1234567890abcdefghijklmnop';
    expect(recordRepairHandoffs(event(relative(process.cwd(), repo.dir), {
      itemId: `repo:goal:${secret}`,
    }))).toMatchObject({ recorded: 1, failed: 0 });

    const read = readRepairHandoffs();
    expect(read).toMatchObject({ sourceState: 'healthy', conflictingIds: 0 });
    expect(read.observations[0]).toMatchObject({ repo: repo.dir });
    expect(read.observations[0]!.parentItemId).not.toContain(secret);
    expect(readFileSync(repairHandoffV2JournalPath(), 'utf8')).not.toContain(secret);
    const parentRaw = readFileSync(join(dispatchProductionDir(), '2026-07-10.jsonl'), 'utf8');
    expect(parentRaw).not.toContain(secret);
  });

  it('quarantines schema authority placed in the wrong journal', () => {
    const repo = fx.makeRepo();
    const input = event(repo.dir, { itemId: 'repo:self:cross-journal-conflict' });
    expect(recordRepairHandoffs(input)).toMatchObject({ recorded: 1 });
    const observation = repairHandoffFromDispatchEvent(input)!;
    writeFileSync(
      repairHandoffJournalPath(),
      `${JSON.stringify({ ...observation, parentTier: 'frontier' })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );

    expect(readRepairHandoffs()).toMatchObject({
      sourceState: 'degraded',
      invalidRows: 1,
      conflictingIds: 1,
      observations: [],
    });
    expect(compactRepairHandoffs()).toMatchObject({ available: false });
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
    writeFileSync(repairHandoffV2JournalPath(), '{"partial":', { encoding: 'utf8', flag: 'a' });
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
    const path = repairHandoffV2JournalPath();
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
      `const result = recordRepairHandoffs(event, { schemaVersion: 2 });`,
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

  it('keeps terminal generations absorbed across an unchanged parent recurrence', async () => {
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
    const recurrenceHandoff = repairHandoffFromDispatchEvent(recurrence)!;
    queueProposalRepairWorkForPendingProposals(undefined, new Date('2026-07-10T15:00:00.000Z'));
    const active = await scanQueuedAutonomyWork(repo.dir);

    expect(active).toEqual([]);
    expect(recurrenceHandoff.generationId).toBe(first.repairGenerationId);
    expect(readGeneratedRepairLifecycle(first).disposition).toBe('retired');
    recordOutcome(firstCooldownKey, 'empty');
    expect(recentlyDeclined(firstCooldownKey, 60_000)).toBe(true);
    expect(generatedRepairCooldownKey({ ...first, repairGenerationId: recurrenceHandoff.generationId }))
      .toBe(firstCooldownKey);
  });

  it('preserves empty-attempt memory across unchanged parent recurrence', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const firstEvent = event(repo.dir);
    recordRepairHandoffs(firstEvent);
    queueProposalRepairWorkForPendingProposals(undefined, new Date('2026-07-10T13:00:00.000Z'));
    const first = (await scanQueuedAutonomyWork(repo.dir))[0]!;
    recordGeneratedRepairLifecycle(first, {
      kind: 'empty-diff',
      attemptId: 'attempt-32345678-1234-4123-8123-123456789abc',
      backend: 'local-coder',
    });

    const recurrence = event(repo.dir, {
      ts: '2026-07-10T14:00:00.000Z',
      backend: 'codex',
      tier: 'frontier',
      runId: 'attempt-42345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-42345678-1234-4123-8123-123456789abc',
    });
    recordRepairHandoffs(recurrence);
    queueProposalRepairWorkForPendingProposals(undefined, new Date('2026-07-10T15:00:00.000Z'));
    const current = (await scanQueuedAutonomyWork(repo.dir))[0]!;

    expect(current.repairGenerationId).toBe(first.repairGenerationId);
    expect(readGeneratedRepairLifecycle(current)).toMatchObject({
      disposition: 'active',
      authoritativeEmptyRuns: 1,
    });
    const exhausted = recordGeneratedRepairLifecycle(current, {
      kind: 'empty-diff',
      attemptId: 'attempt-52345678-1234-4123-8123-123456789abc',
      backend: 'codex',
    });
    expect(exhausted).toMatchObject({ disposition: 'exhausted', authoritativeEmptyRuns: 2 });
  });

  it('carries exact hashful v1 control evidence into the v2 objective family', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const firstEvent = event(repo.dir);
    const v1 = legacyObservation(repairHandoffFromDispatchEvent(firstEvent)!);
    recordDispatchProduction(firstEvent);
    mkdirSync(dirname(repairHandoffJournalPath()), { recursive: true });
    writeFileSync(repairHandoffJournalPath(), `${JSON.stringify(v1)}\n`, { mode: 0o600 });
    queueProposalRepairWorkForPendingProposals(undefined, new Date('2026-07-10T13:00:00.000Z'));
    const legacyItem = (await scanQueuedAutonomyWork(repo.dir))[0]!;
    recordGeneratedRepairLifecycle(legacyItem, {
      kind: 'empty-diff',
      attemptId: 'attempt-32345678-1234-4123-8123-123456789abc',
      backend: 'local-coder',
    });
    recordOutcome(generatedRepairCooldownKey(legacyItem), 'empty');

    const recurrence = event(repo.dir, {
      ts: '2026-07-10T14:00:00.000Z',
      runId: 'attempt-42345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-42345678-1234-4123-8123-123456789abc',
    });
    recordRepairHandoffs(recurrence);
    queueProposalRepairWorkForPendingProposals(undefined, new Date('2026-07-10T15:00:00.000Z'));
    const current = (await scanQueuedAutonomyWork(repo.dir))[0]!;

    expect(current.repairGenerationId).not.toBe(legacyItem.repairGenerationId);
    expect(generatedRepairCooldownKeys(current)).toContain(generatedRepairCooldownKey(legacyItem));
    expect(readGeneratedRepairLifecycle(current)).toMatchObject({
      disposition: 'active',
      authoritativeEmptyRuns: 1,
    });
    const oldProposal = {
      id: 'prop-v1-generation',
      title: 'Legacy generation proposal',
      summary: 'Still pending for the exact objective family.',
      repo: repo.dir,
      workItemId: current.id,
      workItemGenerationId: legacyItem.repairGenerationId,
      status: 'pending',
    } satisfies Pick<Proposal, 'id' | 'title' | 'summary' | 'repo' | 'workItemId' | 'workItemGenerationId' | 'status'>;
    expect(pendingProposalItemKeysForBacklog([current], [oldProposal]))
      .toContain(workItemCoverageKey(current));

    expect(recordGeneratedRepairLifecycle(current, {
      kind: 'empty-diff',
      attemptId: 'attempt-52345678-1234-4123-8123-123456789abc',
      backend: 'codex',
    })).toMatchObject({ disposition: 'exhausted', authoritativeEmptyRuns: 2 });
  });

  it('preserves terminal objective control when the writer rolls back from v2 to v1', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const firstEvent = event(repo.dir, {
      itemId: 'repo:self:rollback-terminal-family',
      ts: '2026-07-10T12:00:00.000Z',
    });
    expect(recordRepairHandoffsRaw(firstEvent)).toMatchObject({ recorded: 1 });
    queueProposalRepairWorkForPendingProposals(undefined, new Date('2026-07-10T12:30:00.000Z'));
    const legacyItem = (await scanQueuedAutonomyWork(repo.dir))[0]!;
    recordGeneratedRepairLifecycle(legacyItem, {
      kind: 'empty-diff',
      attemptId: 'attempt-32345678-1234-4123-8123-123456789abc',
      backend: 'local-coder',
    });
    expect(recordGeneratedRepairLifecycle(legacyItem, {
      kind: 'empty-diff',
      attemptId: 'attempt-42345678-1234-4123-8123-123456789abc',
      backend: 'codex',
    })).toMatchObject({ disposition: 'exhausted' });

    const v2Event = event(repo.dir, {
      ...firstEvent,
      ts: '2026-07-10T13:00:00.000Z',
      runId: 'attempt-52345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-52345678-1234-4123-8123-123456789abc',
    });
    expect(recordRepairHandoffs(v2Event)).toMatchObject({ recorded: 1 });
    queueProposalRepairWorkForPendingProposals(undefined, new Date('2026-07-10T13:30:00.000Z'));
    expect(await scanQueuedAutonomyWork(repo.dir)).toEqual([]);

    const rollbackEvent = event(repo.dir, {
      ...firstEvent,
      ts: '2026-07-10T14:00:00.000Z',
      runId: 'attempt-62345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-62345678-1234-4123-8123-123456789abc',
    });
    expect(recordRepairHandoffsRaw(rollbackEvent)).toMatchObject({ recorded: 1 });
    queueProposalRepairWorkForPendingProposals(undefined, new Date('2026-07-10T14:30:00.000Z'));
    const latest = readRepairHandoffs().observations[0]!;
    const rollbackItem = {
      ...legacyItem,
      ts: latest.ts,
      repairHandoffId: latest.eventId,
      repairGenerationId: latest.generationId,
      repairTreatmentUnitId: latest.repairTreatmentUnitId,
      repairTreatment: latest.repairTreatment,
    };

    expect(latest.schemaVersion).toBe(1);
    expect(generatedRepairGenerationIds(rollbackItem)).toEqual(expect.arrayContaining([
      legacyItem.repairGenerationId,
      repairHandoffFromDispatchEvent(v2Event)!.generationId,
      latest.generationId,
    ]));
    expect(readGeneratedRepairLifecycle(rollbackItem)).toMatchObject({
      available: true,
      disposition: 'exhausted',
      authoritativeEmptyRuns: 2,
    });
    expect(await scanQueuedAutonomyWork(repo.dir)).toEqual([]);
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

  it('quarantines timestamp mutation within one v2 parent attempt', () => {
    const repo = fx.makeRepo();
    const first = event(repo.dir, { ts: '2026-07-10T12:00:00.000Z' });
    const replay = event(repo.dir, { ts: '2026-07-10T12:05:00.000Z' });
    recordRepairHandoffs([first, replay]);

    const read = readRepairHandoffs();
    expect(read).toMatchObject({ sourceState: 'degraded', conflictingIds: 1, observations: [] });
    expect(compactRepairHandoffs()).toMatchObject({ available: false });
  });

  it('projects the newest v2 attempt while compaction preserves attempt history', () => {
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
    expect(read.observations).toHaveLength(1);
    expect(read.observations[0]!.parentAttemptId).toBe(newest.trajectoryId);
    expect(readFileSync(repairHandoffV2JournalPath(), 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
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
      repairHandoffV2JournalPath(),
      `${JSON.stringify({ ...first, parentObjectiveHash: 'b'.repeat(64) })}\n`,
      { encoding: 'utf8', flag: 'a' },
    );

    const read = readRepairHandoffs();
    expect(read).toMatchObject({ sourceState: 'degraded', invalidRows: 1, conflictingIds: 1 });
    expect(read.observations).toEqual([]);
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
