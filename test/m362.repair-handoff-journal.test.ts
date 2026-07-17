import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';

const privateStorageHarness = vi.hoisted(() => ({
  useSemanticAdapter: false,
  captureFileContents: false,
  realCalls: 0,
  semanticInvocations: [] as Array<{
    path: string;
    kind: 'file' | 'directory';
    mode: 'secure-created' | 'inspect-existing' | 'inspect-owned';
    anchorPath: string | undefined;
    fileContents?: string;
  }>,
  semanticFailure: undefined as undefined | {
    path: string;
    kind: 'file' | 'directory';
    mode: 'secure-created' | 'inspect-existing' | 'inspect-owned';
  },
}));

vi.mock('../src/core/util/private-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/util/private-storage.js')>();
  return {
    ...actual,
    assurePrivateStoragePath: (
      ...args: Parameters<typeof actual.assurePrivateStoragePath>
    ) => {
      if (privateStorageHarness.useSemanticAdapter) {
        let fileContents: string | undefined;
        if (privateStorageHarness.captureFileContents && args[1] === 'file' && existsSync(args[0])) {
          try { fileContents = readFileSync(args[0], 'utf8'); } catch { /* changing test path */ }
        }
        privateStorageHarness.semanticInvocations.push({
          path: args[0],
          kind: args[1],
          mode: args[2],
          anchorPath: args[3]?.anchorPath,
          ...(fileContents === undefined ? {} : { fileContents }),
        });
        if (
          privateStorageHarness.semanticFailure?.path === args[0] &&
          privateStorageHarness.semanticFailure.kind === args[1] &&
          privateStorageHarness.semanticFailure.mode === args[2]
        ) return { ok: false, reason: 'semantic-assurance-failure' };
        return {
          ok: true,
          reason: args[2] === 'inspect-owned' ? 'owned-safe-path' : 'exact-private-dacl',
        };
      }
      privateStorageHarness.realCalls += 1;
      return actual.assurePrivateStoragePath(...args);
    },
    assurePrivateStoragePaths: (
      ...args: Parameters<typeof actual.assurePrivateStoragePaths>
    ) => {
      if (process.platform === 'win32' && privateStorageHarness.useSemanticAdapter) {
        return { ok: true, reason: args[0].length === 0 ? 'no-paths' : 'owned-safe-paths' };
      }
      privateStorageHarness.realCalls += 1;
      return actual.assurePrivateStoragePaths(...args);
    },
  };
});

import type { DispatchProductionEvent } from '../src/core/fleet/dispatch-production-ledger.js';
import {
  dispatchProductionDir,
  recordDispatchProduction,
  sanitizeDispatchProductionEvent,
} from '../src/core/fleet/dispatch-production-ledger.js';
import {
  _setRepairHandoffJournalFaultForTest,
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
  type RepairHandoffV2Activation,
} from '../src/core/fleet/repair-handoff-journal.js';
import { queueProposalRepairWorkForPendingProposals } from '../src/core/fleet/proposal-repair-work.js';
import { scanQueuedAutonomyWork } from '../src/core/portfolio/scanners.js';
import {
  generatedRepairCooldownKey,
  generatedRepairCooldownKeys,
  generatedRepairLifecyclePath,
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
import { workItemObjectiveHash } from '../src/core/fleet/work-item-objective.js';
import { inboxDir } from '../src/core/inbox/store.js';
import { assurePrivateStoragePath } from '../src/core/util/private-storage.js';

let fx: H1Fixture;

beforeAll(() => {
  if (process.platform !== 'win32') return;

  const proofFixture = makeFixture();
  const realCallsBefore = privateStorageHarness.realCalls;
  mkdirSync(proofFixture.ashlrDir, { recursive: true });
  try {
    expect(assurePrivateStoragePath(
      proofFixture.ashlrDir,
      'directory',
      'secure-created',
      { anchorPath: proofFixture.home },
    )).toEqual({ ok: true, reason: 'exact-private-dacl' });
    expect(privateStorageHarness.realCalls).toBeGreaterThan(realCallsBefore);
  } finally {
    privateStorageHarness.useSemanticAdapter = true;
    proofFixture.cleanup();
  }
});

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
  privateStorageHarness.semanticInvocations.length = 0;
  privateStorageHarness.semanticFailure = undefined;
  privateStorageHarness.captureFileContents = false;
});

afterEach(() => {
  _setRepairHandoffJournalFaultForTest(undefined);
  privateStorageHarness.semanticFailure = undefined;
  privateStorageHarness.captureFileContents = false;
  privateStorageHarness.useSemanticAdapter = process.platform === 'win32';
  fx.cleanup();
});

afterAll(() => {
  privateStorageHarness.useSemanticAdapter = false;
});

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
  return recordRepairHandoffsRaw(input, { schemaVersion: 2, activation: ACTIVATION_A });
}

const ACTIVATION_A: RepairHandoffV2Activation = {
  id: '11111111-1111-4111-8111-111111111111',
  activatedAt: '2020-01-01T00:00:00.000Z',
};
const ACTIVATION_B: RepairHandoffV2Activation = {
  id: '22222222-2222-4222-8222-222222222222',
  activatedAt: '2021-01-01T00:00:00.000Z',
};

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

function recordDiagnosticEmpty(
  item: WorkItem,
  attemptId: string,
  backend: 'local-coder' | 'kimi' | 'codex' | 'claude',
  tier: 'mid' | 'frontier',
  ordinal: 1 | 2,
) {
  const ts = new Date(Date.now() - (3 - ordinal) * 60_000).toISOString();
  const routeReason = `m362 diagnostic attempt ${ordinal}`;
  const production: DispatchProductionEvent = {
    schemaVersion: 1,
    ts,
    itemId: item.id,
    source: item.source,
    repo: item.repo,
    title: item.title,
    backend,
    tier,
    assignedBy: 'daemon',
    routeReason,
    outcome: 'empty-diff',
    proposalCreated: false,
    runId: attemptId,
    trajectoryId: `run:${attemptId}`,
    routeSnapshot: {
      backend,
      tier,
      assignedBy: 'daemon',
      reason: routeReason,
      routerPolicyVersion: 'fleet-router-v1',
    },
    runEventSummary: {
      runId: attemptId,
      status: 'done',
      outcome: 'empty-diff',
      proposalCreated: false,
      costUsd: 0,
    },
    learningSource: 'daemon-dispatch',
    labelBasis: 'dispatch-outcome',
    routerPolicyVersion: 'fleet-router-v1',
    objectiveHash: workItemObjectiveHash(item),
    spentUsd: 0,
    basis: 'run-proposal-outcome',
    repairHandoffId: item.repairHandoffId,
    repairGenerationId: item.repairGenerationId,
    repairTreatmentUnitId: item.repairTreatmentUnitId,
    repairTreatment: item.repairTreatment,
    repairAttemptOrdinal: ordinal,
  };
  if (ordinal === 2) {
    const previous = readGeneratedRepairLifecycle(item).lastAuthoritativeEmptyBackend;
    if (previous) production.repairPreviousBackend = previous;
  }
  expect(recordDispatchProduction(production)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
  return recordGeneratedRepairLifecycle(item, { kind: 'dispatch-proof-empty-diff', eventTs: ts });
}

function recordDiagnosticProposal(
  item: WorkItem,
  attemptId: string,
  proposalId: string,
) {
  const ts = new Date(Date.now() - 2 * 60_000).toISOString();
  const tier = item.repairParentTier ?? 'mid';
  const routeReason = 'm362 diagnostic proposal attempt';
  const production: DispatchProductionEvent = {
    schemaVersion: 1,
    ts,
    itemId: item.id,
    source: item.source,
    repo: item.repo,
    title: item.title,
    backend: 'local-coder',
    tier,
    assignedBy: 'daemon',
    routeReason,
    outcome: 'proposal-created',
    proposalCreated: true,
    proposalId,
    runId: attemptId,
    trajectoryId: `run:${attemptId}`,
    routeSnapshot: {
      backend: 'local-coder',
      tier,
      assignedBy: 'daemon',
      reason: routeReason,
      routerPolicyVersion: 'fleet-router-v1',
    },
    runEventSummary: {
      runId: attemptId,
      status: 'done',
      outcome: 'proposal-created',
      proposalCreated: true,
      proposalId,
      diffFiles: 1,
      diffLines: 2,
      costUsd: 0,
    },
    learningSource: 'daemon-dispatch',
    labelBasis: 'dispatch-outcome',
    routerPolicyVersion: 'fleet-router-v1',
    objectiveHash: workItemObjectiveHash(item),
    spentUsd: 0,
    diffFiles: 1,
    diffLines: 2,
    basis: 'run-proposal-outcome',
    repairHandoffId: item.repairHandoffId,
    repairGenerationId: item.repairGenerationId,
    repairTreatmentUnitId: item.repairTreatmentUnitId,
    repairTreatment: item.repairTreatment,
    repairAttemptOrdinal: 1,
  };
  const diff = 'diff --git a/a b/a\n';
  const proposal: Proposal = {
    id: proposalId,
    repo: item.repo,
    origin: 'agent',
    kind: 'patch',
    title: 'M362 diagnostic proposal',
    summary: 'Exact durable proposal fixture for a journal-authorized diagnostic attempt.',
    diff,
    diffHash: createHash('sha256').update(diff, 'utf8').digest('hex'),
    workItemId: item.id,
    workItemGenerationId: item.repairGenerationId,
    workSource: 'self',
    runId: attemptId,
    trajectoryId: production.trajectoryId,
    runEventSummary: production.runEventSummary,
    status: 'pending',
    createdAt: ts,
  };
  const proposalsDir = inboxDir();
  mkdirSync(proposalsDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(proposalsDir, `${proposal.id}.json`), `${JSON.stringify(proposal)}\n`, { mode: 0o600 });
  expect(recordDispatchProduction(production)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
  const transition = recordGeneratedRepairLifecycle(item, {
    kind: 'proposal-created',
    attemptId: production.trajectoryId!,
    proposalId,
    ts,
  });
  return { transition, proposal };
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

  it.each(['issue', 'goal'] as const)('persists %s capture failures as durable repair handoffs', (source) => {
    const repo = fx.makeRepo();
    const input = event(repo.dir, {
      source,
      outcome: 'proposal-capture-error',
      diffFiles: 2,
    });

    expect(recordRepairHandoffs(input)).toMatchObject({ attempted: 1, recorded: 1, failed: 0 });
    expect(readRepairHandoffs().observations[0]).toMatchObject({
      kind: 'capture-repair',
      parentSource: source,
      parentObjectiveHash: input.objectiveHash,
    });
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

    expect(recordRepairHandoffsRaw(input, { schemaVersion: 2, activation: ACTIVATION_A })).toMatchObject({ recorded: 1, failed: 0 });
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

  it.each([
    ['v1', '2026-07-10.jsonl'],
    ['v2', '2026-07-11.jsonl'],
  ] as const)('degrades when only the %s parent of a hashful v1/v2 alias family is lost', (_schema, partition) => {
    const repo = fx.makeRepo();
    const legacy = event(repo.dir, {
      ts: '2026-07-10T12:00:00.000Z',
      runId: 'attempt-32345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-32345678-1234-4123-8123-123456789abc',
    });
    const current = event(repo.dir, {
      ts: '2026-07-11T12:00:00.000Z',
      runId: 'attempt-42345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-42345678-1234-4123-8123-123456789abc',
    });
    expect(recordRepairHandoffsRaw(legacy)).toMatchObject({ recorded: 1, failed: 0 });
    expect(recordRepairHandoffsRaw(current, { schemaVersion: 2, activation: ACTIVATION_A }))
      .toMatchObject({ recorded: 1, failed: 0 });
    expect(readRepairHandoffSchemaSummary()).toMatchObject({
      sourceState: 'healthy',
      aliasFamilies: 1,
      conflictingIds: 0,
    });

    rmSync(join(dispatchProductionDir(), partition));

    expect(readRepairHandoffs()).toMatchObject({
      sourceState: 'degraded',
      conflictingIds: 1,
    });
    expect(readRepairHandoffSchemaSummary()).toMatchObject({
      sourceState: 'degraded',
      conflictingIds: 1,
    });
  });

  it('tracks the active writer epoch without moving the immutable generation anchor', () => {
    const repo = fx.makeRepo();
    const input = event(repo.dir);

    expect(recordRepairHandoffsRaw(input, { schemaVersion: 2, activation: ACTIVATION_A }))
      .toMatchObject({ recorded: 1, failed: 0 });
    expect(readRepairHandoffSchemaSummary(ACTIVATION_A)).toMatchObject({
      v2Authorities: 1,
      currentActivationV2Authorities: 1,
      unboundV2Authorities: 0,
      latestCurrentActivationV2At: input.ts,
    });
    expect(readRepairHandoffSchemaSummary(ACTIVATION_B)).toMatchObject({
      v2Authorities: 1,
      currentActivationV2Authorities: 0,
      latestCurrentActivationV2At: null,
    });

    const reactivatedInput = event(repo.dir, {
      ts: '2026-07-10T12:01:00.000Z',
      runId: 'attempt-22345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-22345678-1234-4123-8123-123456789abc',
    });
    expect(recordRepairHandoffsRaw(reactivatedInput, { schemaVersion: 2, activation: ACTIVATION_B }))
      .toMatchObject({ recorded: 1, failed: 0 });
    const rows = readRepairHandoffs().observations.filter((row) => row.schemaVersion === 2);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ts: input.ts,
      parentAttemptId: input.trajectoryId,
      writerActivationId: ACTIVATION_A.id,
      writerActivatedAt: ACTIVATION_A.activatedAt,
    });
    expect(readRepairHandoffSchemaSummary(ACTIVATION_A)).toMatchObject({
      currentActivationV2Authorities: 0,
      latestCurrentActivationV2At: null,
    });
    expect(readRepairHandoffSchemaSummary(ACTIVATION_B)).toMatchObject({
      v2Authorities: 1,
      v2PhysicalRows: 2,
      currentActivationV2Authorities: 1,
      latestCurrentActivationV2At: reactivatedInput.ts,
    });
  });

  it('preserves the journal-wide high-water through compaction and rejects a stale writer generation', () => {
    const repo = fx.makeRepo();
    const first = event(repo.dir, {
      itemId: 'repo:self:generation-a',
      objectiveHash: 'a'.repeat(64),
    });
    const rollover = event(repo.dir, {
      itemId: 'repo:self:generation-b',
      objectiveHash: 'b'.repeat(64),
      ts: '2026-07-10T12:01:00.000Z',
      runId: 'attempt-22345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-22345678-1234-4123-8123-123456789abc',
    });
    const stale = event(repo.dir, {
      itemId: 'repo:self:generation-c',
      objectiveHash: 'c'.repeat(64),
      ts: '2026-07-10T13:00:00.000Z',
      backend: 'codex',
      tier: 'frontier',
      runId: 'attempt-32345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-32345678-1234-4123-8123-123456789abc',
    });

    expect(recordRepairHandoffsRaw(first, { schemaVersion: 2, activation: ACTIVATION_A }))
      .toMatchObject({ recorded: 1, failed: 0 });
    const legacyReplay = readFileSync(repairHandoffV2JournalPath(), 'utf8');
    writeFileSync(repairHandoffV2JournalPath(), legacyReplay, { encoding: 'utf8', flag: 'a' });
    expect(recordRepairHandoffsRaw(rollover, { schemaVersion: 2, activation: ACTIVATION_B }))
      .toMatchObject({ recorded: 1, failed: 0 });
    expect(compactRepairHandoffs()).toEqual({ available: true, before: 3, after: 2, removed: 1 });
    expect(recordRepairHandoffsRaw(stale, { schemaVersion: 2, activation: ACTIVATION_A }))
      .toEqual({ attempted: 1, recorded: 0, failed: 1 });

    expect(readRepairHandoffs()).toMatchObject({
      sourceState: 'healthy',
      conflictingIds: 0,
      physicalRows: 2,
    });
    expect(readRepairHandoffs().observations.map((row) => row.parentItemId).sort()).toEqual([
      first.itemId,
      rollover.itemId,
    ]);
    expect(readRepairHandoffSchemaSummary(ACTIVATION_A)).toMatchObject({
      currentActivationV2Authorities: 0,
      latestCurrentActivationV2At: null,
    });
    expect(readRepairHandoffSchemaSummary(ACTIVATION_B)).toMatchObject({
      currentActivationV2Authorities: 1,
      latestCurrentActivationV2At: rollover.ts,
    });

    expect(compactRepairHandoffs()).toEqual({ available: true, before: 2, after: 2, removed: 0 });
  });

  it('rejects a distinct writer id claiming the high-water activation instant', () => {
    const repo = fx.makeRepo();
    const ambiguousActivation: RepairHandoffV2Activation = {
      id: '33333333-3333-4333-8333-333333333333',
      activatedAt: ACTIVATION_A.activatedAt,
    };
    expect(recordRepairHandoffsRaw(event(repo.dir, {
      itemId: 'repo:self:equal-time-a',
      objectiveHash: 'a'.repeat(64),
    }), { schemaVersion: 2, activation: ACTIVATION_A }))
      .toMatchObject({ recorded: 1, failed: 0 });
    expect(recordRepairHandoffsRaw(event(repo.dir, {
      itemId: 'repo:self:equal-time-b',
      objectiveHash: 'b'.repeat(64),
      ts: '2026-07-10T12:01:00.000Z',
      runId: 'attempt-22345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-22345678-1234-4123-8123-123456789abc',
    }), { schemaVersion: 2, activation: ambiguousActivation }))
      .toEqual({ attempted: 1, recorded: 0, failed: 1 });

    expect(readRepairHandoffs()).toMatchObject({
      sourceState: 'healthy',
      conflictingIds: 0,
      physicalRows: 1,
      observations: [expect.objectContaining({ parentItemId: 'repo:self:equal-time-a' })],
    });
    expect(compactRepairHandoffs()).toEqual({ available: true, before: 1, after: 1, removed: 0 });
  });

  it('rejects an activation id that mutates its timestamp', () => {
    const repo = fx.makeRepo();
    const mutatedActivation: RepairHandoffV2Activation = {
      id: ACTIVATION_A.id,
      activatedAt: '2022-01-01T00:00:00.000Z',
    };
    expect(recordRepairHandoffsRaw(event(repo.dir, {
      itemId: 'repo:self:id-mutation-a',
      objectiveHash: 'a'.repeat(64),
    }), { schemaVersion: 2, activation: ACTIVATION_A })).toMatchObject({ recorded: 1, failed: 0 });
    expect(recordRepairHandoffsRaw(event(repo.dir, {
      itemId: 'repo:self:id-mutation-b',
      objectiveHash: 'b'.repeat(64),
      ts: '2026-07-10T12:01:00.000Z',
      runId: 'attempt-22345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-22345678-1234-4123-8123-123456789abc',
    }), { schemaVersion: 2, activation: mutatedActivation }))
      .toEqual({ attempted: 1, recorded: 0, failed: 1 });

    expect(readRepairHandoffs()).toMatchObject({
      sourceState: 'healthy',
      conflictingIds: 0,
      physicalRows: 1,
      observations: [expect.objectContaining({ parentItemId: 'repo:self:id-mutation-a' })],
    });
    expect(compactRepairHandoffs()).toEqual({ available: true, before: 1, after: 1, removed: 0 });
  });

  it('journal activation authority: canonicalizes UUID casing before persistence and lookup', () => {
    const repo = fx.makeRepo();
    const input = event(repo.dir);
    const uppercaseActivation = { ...ACTIVATION_A, id: ACTIVATION_A.id.toUpperCase() };

    expect(recordRepairHandoffsRaw(input, { schemaVersion: 2, activation: uppercaseActivation }))
      .toMatchObject({ recorded: 1, failed: 0 });
    expect(JSON.parse(readFileSync(repairHandoffV2JournalPath(), 'utf8'))).toMatchObject({
      writerActivationId: ACTIVATION_A.id,
    });
    expect(readRepairHandoffSchemaSummary(uppercaseActivation)).toMatchObject({
      sourceState: 'healthy',
      currentActivationV2Authorities: 1,
      latestCurrentActivationV2At: input.ts,
    });
  });

  it('journal activation authority: quarantines UUID case-variant timestamp collisions', () => {
    const repo = fx.makeRepo();
    const first = event(repo.dir, {
      itemId: 'repo:self:case-collision-a',
      objectiveHash: 'a'.repeat(64),
    });
    const second = event(repo.dir, {
      itemId: 'repo:self:case-collision-b',
      objectiveHash: 'b'.repeat(64),
      ts: '2026-07-10T12:01:00.000Z',
      runId: 'attempt-22345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-22345678-1234-4123-8123-123456789abc',
    });
    expect(recordRepairHandoffsRaw(first, { schemaVersion: 2, activation: ACTIVATION_A }))
      .toMatchObject({ recorded: 1, failed: 0 });
    expect(recordDispatchProduction(second)).toMatchObject({ recorded: 1, failed: 0 });
    const caseVariant = {
      ...repairHandoffFromDispatchEvent(second)!,
      writerActivationId: ACTIVATION_A.id.toUpperCase(),
      writerActivatedAt: '2022-01-01T00:00:00.000Z',
    };
    writeFileSync(
      repairHandoffV2JournalPath(),
      `${JSON.stringify(caseVariant)}\n`,
      { encoding: 'utf8', flag: 'a' },
    );

    expect(readRepairHandoffs()).toMatchObject({
      sourceState: 'degraded',
      conflictingIds: 2,
      observations: [],
    });
    expect(compactRepairHandoffs()).toMatchObject({ available: false, before: 2 });
  });

  it('reports the true latest authority timestamp across current-activation generations', () => {
    const repo = fx.makeRepo();
    const older = event(repo.dir, {
      itemId: 'repo:self:latest-generation-a',
      objectiveHash: 'a'.repeat(64),
    });
    const newer = event(repo.dir, {
      itemId: 'repo:self:latest-generation-b',
      objectiveHash: 'b'.repeat(64),
      ts: '2026-07-10T14:00:00.000Z',
      runId: 'attempt-22345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-22345678-1234-4123-8123-123456789abc',
    });
    expect(recordRepairHandoffsRaw(older, { schemaVersion: 2, activation: ACTIVATION_B }))
      .toMatchObject({ recorded: 1, failed: 0 });
    expect(recordRepairHandoffsRaw(newer, { schemaVersion: 2, activation: ACTIVATION_B }))
      .toMatchObject({ recorded: 1, failed: 0 });

    expect(readRepairHandoffSchemaSummary(ACTIVATION_B)).toMatchObject({
      sourceState: 'healthy',
      currentActivationV2Authorities: 2,
      latestCurrentActivationV2At: newer.ts,
    });
  });

  it('journal activation authority: reports the latest same-generation recurrence', () => {
    const repo = fx.makeRepo();
    const first = event(repo.dir);
    const recurrence = event(repo.dir, {
      ts: '2026-07-10T14:00:00.000Z',
      runId: 'attempt-22345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-22345678-1234-4123-8123-123456789abc',
    });
    expect(recordRepairHandoffsRaw(first, { schemaVersion: 2, activation: ACTIVATION_B }))
      .toMatchObject({ recorded: 1, failed: 0 });
    expect(recordRepairHandoffsRaw(recurrence, { schemaVersion: 2, activation: ACTIVATION_B }))
      .toMatchObject({ recorded: 1, failed: 0 });

    expect(readRepairHandoffSchemaSummary(ACTIVATION_B)).toMatchObject({
      sourceState: 'healthy',
      v2Authorities: 1,
      v2PhysicalRows: 2,
      currentActivationV2Authorities: 1,
      latestCurrentActivationV2At: recurrence.ts,
    });
  });

  it('degrades summary when an active-epoch recurrence loses its parent', () => {
    const repo = fx.makeRepo();
    const first = event(repo.dir);
    const rollover = event(repo.dir, {
      ts: '2026-07-11T12:00:00.000Z',
      runId: 'attempt-22345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-22345678-1234-4123-8123-123456789abc',
    });
    expect(recordRepairHandoffsRaw(first, { schemaVersion: 2, activation: ACTIVATION_A }))
      .toMatchObject({ recorded: 1, failed: 0 });
    expect(recordRepairHandoffsRaw(rollover, { schemaVersion: 2, activation: ACTIVATION_B }))
      .toMatchObject({ recorded: 1, failed: 0 });

    writeFileSync(join(dispatchProductionDir(), '2026-07-11.jsonl'), '', { mode: 0o600 });
    expect(readRepairHandoffs()).toMatchObject({
      sourceState: 'degraded',
      conflictingIds: 1,
      observations: [expect.objectContaining({ parentAttemptId: first.trajectoryId })],
    });
    expect(readRepairHandoffSchemaSummary(ACTIVATION_B)).toMatchObject({
      sourceState: 'degraded',
      conflictingIds: 1,
      currentActivationV2Authorities: 0,
      latestCurrentActivationV2At: null,
    });
  });

  it('journal activation authority: rejects recurrence authority when its immutable anchor parent is missing', () => {
    const repo = fx.makeRepo();
    const missingAnchor = event(repo.dir, {
      itemId: 'repo:self:missing-generation-anchor',
      objectiveHash: 'a'.repeat(64),
    });
    const survivingRecurrence = event(repo.dir, {
      ...missingAnchor,
      ts: '2026-07-11T12:00:00.000Z',
      runId: 'attempt-22345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-22345678-1234-4123-8123-123456789abc',
    });
    const healthyGeneration = event(repo.dir, {
      itemId: 'repo:self:healthy-generation-anchor',
      objectiveHash: 'b'.repeat(64),
      ts: '2026-07-12T12:00:00.000Z',
      runId: 'attempt-32345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-32345678-1234-4123-8123-123456789abc',
    });
    expect(recordRepairHandoffsRaw(
      [missingAnchor, survivingRecurrence, healthyGeneration],
      { schemaVersion: 2, activation: ACTIVATION_B },
    )).toMatchObject({ recorded: 3, failed: 0 });

    writeFileSync(join(dispatchProductionDir(), '2026-07-10.jsonl'), '', { mode: 0o600 });

    expect(readRepairHandoffs()).toMatchObject({
      sourceState: 'degraded',
      conflictingIds: 1,
      observations: [expect.objectContaining({ parentItemId: healthyGeneration.itemId })],
    });
    expect(readRepairHandoffSchemaSummary(ACTIVATION_B)).toMatchObject({
      sourceState: 'degraded',
      conflictingIds: 1,
      v2Authorities: 1,
      currentActivationV2Authorities: 1,
      latestCurrentActivationV2At: healthyGeneration.ts,
    });
  });

  it('journal activation authority: preserves unbound v2 rows written before activation', () => {
    const repo = fx.makeRepo();
    const input = event(repo.dir);
    const bound = event(repo.dir, {
      itemId: 'repo:self:bound-after-legacy',
      objectiveHash: 'b'.repeat(64),
      ts: '2026-07-10T12:01:00.000Z',
      runId: 'attempt-22345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-22345678-1234-4123-8123-123456789abc',
    });
    expect(recordDispatchProduction(input)).toMatchObject({ recorded: 1, failed: 0 });
    const historical = repairHandoffFromDispatchEvent(input)!;
    mkdirSync(dirname(repairHandoffV2JournalPath()), { recursive: true, mode: 0o700 });
    writeFileSync(repairHandoffV2JournalPath(), `${JSON.stringify(historical)}\n`, { mode: 0o600 });
    expect(recordRepairHandoffsRaw(bound, { schemaVersion: 2, activation: ACTIVATION_A }))
      .toMatchObject({ recorded: 1, failed: 0 });
    expect(readRepairHandoffSchemaSummary(ACTIVATION_A)).toMatchObject({
      sourceState: 'healthy',
      v2Authorities: 2,
      currentActivationV2Authorities: 1,
      unboundV2Authorities: 1,
      latestCurrentActivationV2At: bound.ts,
    });
  });

  it('journal activation authority: quarantines unbound v2 rows written after activation', () => {
    const repo = fx.makeRepo();
    const bound = event(repo.dir, {
      itemId: 'repo:self:bound-before-rollback',
      objectiveHash: 'a'.repeat(64),
    });
    const rollback = event(repo.dir, {
      itemId: 'repo:self:unbound-after-activation',
      objectiveHash: 'b'.repeat(64),
      ts: '2026-07-10T12:01:00.000Z',
      runId: 'attempt-22345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-22345678-1234-4123-8123-123456789abc',
    });
    expect(recordRepairHandoffsRaw(bound, { schemaVersion: 2, activation: ACTIVATION_A }))
      .toMatchObject({ recorded: 1, failed: 0 });
    expect(recordDispatchProduction(rollback)).toMatchObject({ recorded: 1, failed: 0 });
    writeFileSync(
      repairHandoffV2JournalPath(),
      `${JSON.stringify(repairHandoffFromDispatchEvent(rollback)!)}\n`,
      { encoding: 'utf8', flag: 'a' },
    );

    expect(readRepairHandoffs()).toMatchObject({
      sourceState: 'degraded',
      conflictingIds: 1,
      observations: [expect.objectContaining({ parentItemId: bound.itemId })],
    });
    expect(readRepairHandoffSchemaSummary(ACTIVATION_A)).toMatchObject({
      sourceState: 'degraded',
      v2Authorities: 1,
      currentActivationV2Authorities: 1,
      unboundV2Authorities: 0,
      latestCurrentActivationV2At: bound.ts,
    });
    expect(compactRepairHandoffs()).toMatchObject({ available: false, before: 2 });
  });

  it('fails closed before appending a v2 row whose activation is malformed or after the event', () => {
    const repo = fx.makeRepo();
    const input = event(repo.dir);
    expect(recordRepairHandoffsRaw(input, {
      schemaVersion: 2,
      activation: { ...ACTIVATION_A, id: 'not-an-activation' },
    })).toMatchObject({ attempted: 1, recorded: 0, failed: 1 });
    expect(recordRepairHandoffsRaw(input, {
      schemaVersion: 2,
      activation: { ...ACTIVATION_A, activatedAt: '2026-07-10T12:00:01.000Z' },
    })).toMatchObject({ attempted: 1, recorded: 0, failed: 1 });
    expect(existsSync(repairHandoffV2JournalPath())).toBe(false);
  });

  it('rejects activation metadata mutation for the same immutable attempt', () => {
    const repo = fx.makeRepo();
    const input = event(repo.dir);
    expect(recordRepairHandoffsRaw(input, { schemaVersion: 2, activation: ACTIVATION_A }))
      .toMatchObject({ recorded: 1, failed: 0 });
    expect(recordRepairHandoffsRaw(input, { schemaVersion: 2, activation: ACTIVATION_B }))
      .toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(readRepairHandoffs()).toMatchObject({
      sourceState: 'healthy',
      conflictingIds: 0,
      physicalRows: 1,
      observations: [expect.objectContaining({ writerActivationId: ACTIVATION_A.id })],
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

  it('keeps the first exact route tuple as the immutable generation anchor', () => {
    const repo = fx.makeRepo();
    const firstEvent = event(repo.dir, { tier: 'mid' });
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
      ts: firstEvent.ts,
      parentBackend: 'local-coder',
      parentTier: 'mid',
      parentAttemptId: firstEvent.trajectoryId,
    });
    expect(readFileSync(repairHandoffV2JournalPath(), 'utf8')).toContain(newestEvent.trajectoryId!);
  });

  it('does not let a backdated recurrence replace the first durable anchor', () => {
    const repo = fx.makeRepo();
    const first = event(repo.dir, {
      ts: '2026-07-10T12:00:00.000Z',
      tier: 'mid',
    });
    const backdated = event(repo.dir, {
      ts: '2026-07-10T11:00:00.000Z',
      backend: 'codex',
      tier: 'frontier',
      runId: 'attempt-22345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-22345678-1234-4123-8123-123456789abc',
    });
    recordRepairHandoffs([first, backdated]);

    expect(readRepairHandoffs()).toMatchObject({
      sourceState: 'healthy',
      observations: [{
        ts: first.ts,
        parentAttemptId: first.trajectoryId,
        parentBackend: first.backend,
        parentTier: first.tier,
      }],
    });
    expect(compactRepairHandoffs()).toEqual({ available: true, before: 2, after: 2, removed: 0 });
    expect(readRepairHandoffs().observations[0]).toMatchObject({
      ts: first.ts,
      parentAttemptId: first.trajectoryId,
    });
  });

  it('rejects a distinct v2 attempt with an equal timestamp before append', () => {
    const repo = fx.makeRepo();
    expect(recordRepairHandoffs([
      event(repo.dir),
      event(repo.dir, {
        runId: 'attempt-22345678-1234-4123-8123-123456789abc',
        trajectoryId: 'run:attempt-22345678-1234-4123-8123-123456789abc',
      }),
    ])).toEqual({ attempted: 2, recorded: 1, failed: 1 });
    expect(readRepairHandoffs()).toMatchObject({
      sourceState: 'healthy',
      conflictingIds: 0,
      physicalRows: 1,
      observations: [expect.objectContaining({
        parentAttemptId: 'run:attempt-12345678-1234-4123-8123-123456789abc',
      })],
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
    const degraded = readFileSync(path, 'utf8');

    expect(recordRepairHandoffs(event(repo.dir))).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(readFileSync(path, 'utf8')).toBe(degraded);

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

  it('quarantines an exact parent with a conflicting backend/tier sibling', () => {
    const repo = fx.makeRepo();
    const input = event(repo.dir, { itemId: 'repo:self:conflicting-parent-sibling' });
    expect(recordRepairHandoffs(input)).toMatchObject({ recorded: 1, failed: 0 });
    writeFileSync(
      join(dispatchProductionDir(), '2026-07-10.jsonl'),
      `${JSON.stringify({ ...input, backend: 'codex', tier: 'frontier' })}\n`,
      { encoding: 'utf8', flag: 'a' },
    );

    expect(readRepairHandoffs()).toMatchObject({
      sourceState: 'degraded',
      conflictingIds: 1,
      observations: [],
    });
    expect(compactRepairHandoffs()).toMatchObject({ available: false, before: 1 });
  });

  it('quarantines a parent beyond the ledger tail without revoking an unrelated generation', () => {
    const repo = fx.makeRepo();
    const blocked = event(repo.dir, {
      itemId: 'repo:self:parent-outside-tail',
      objectiveHash: 'a'.repeat(64),
    });
    const healthy = event(repo.dir, {
      itemId: 'repo:self:healthy-parent-generation',
      objectiveHash: 'b'.repeat(64),
      ts: '2026-07-11T12:00:00.000Z',
      runId: 'attempt-22345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-22345678-1234-4123-8123-123456789abc',
    });
    expect(recordRepairHandoffs([blocked, healthy])).toMatchObject({ recorded: 2, failed: 0 });
    writeFileSync(
      join(dispatchProductionDir(), '2026-07-10.jsonl'),
      `${'x'.repeat(33 * 1024 * 1024)}\n`,
      { encoding: 'utf8', flag: 'a' },
    );

    const isolated = readRepairHandoffs();
    expect(isolated).toMatchObject({
      sourceState: 'degraded',
      conflictingIds: 1,
      physicalRows: 2,
      observations: [expect.objectContaining({
        parentItemId: healthy.itemId,
        generationId: repairHandoffFromDispatchEvent(healthy)!.generationId,
      })],
    });
    expect(compactRepairHandoffs()).toEqual({ available: false, before: 2, after: 0, removed: 0 });
    expect(readRepairHandoffs()).toMatchObject({
      sourceState: 'degraded',
      conflictingIds: 1,
      observations: [expect.objectContaining({ parentItemId: healthy.itemId })],
    });
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
      const unrelated = Array.from({ length: 2_001 }, (_, index) => JSON.stringify(
        sanitizeDispatchProductionEvent(event(repo.dir, {
          itemId: `repo:self:unrelated-${index}`,
          ts: '2026-07-10T13:00:00.000Z',
        }), { materializeLearningLabel: true }),
      )).join('\n');
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

  it('journal activation authority: reconciles a file-durable append crash before parent settlement', () => {
    const repo = fx.makeRepo();
    const input = event(repo.dir, { itemId: 'repo:self:file-durable-append-crash' });
    expect(recordDispatchProduction(input)).toMatchObject({ recorded: 1, failed: 0 });
    const durableAfterCrash = {
      ...repairHandoffFromDispatchEvent(input)!,
      writerActivationId: ACTIVATION_A.id,
      writerActivatedAt: ACTIVATION_A.activatedAt,
    };
    mkdirSync(dirname(repairHandoffV2JournalPath()), { recursive: true, mode: 0o700 });
    writeFileSync(
      repairHandoffV2JournalPath(),
      `${JSON.stringify(durableAfterCrash)}\n`,
      { mode: 0o600 },
    );

    expect(recordRepairHandoffs(input)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(readFileSync(repairHandoffV2JournalPath(), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readRepairHandoffs()).toMatchObject({
      sourceState: 'healthy',
      physicalRows: 1,
      observations: [expect.objectContaining({
        eventId: durableAfterCrash.eventId,
        parentItemId: input.itemId,
      })],
    });
  });

  it('canonicalizes a lexical parent repo while scrubbing non-identity metadata', () => {
    const repo = fx.makeRepo();
    const secret = 'github_pat_1234567890abcdefghijklmnop';
    const nested = join(repo.dir, 'identity-probe');
    mkdirSync(nested);
    expect(recordRepairHandoffs(event(join(nested, '..'), {
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

  it('rejects exact replay when combined v1 and v2 authority is quarantined', () => {
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
    const durableV2 = readFileSync(repairHandoffV2JournalPath(), 'utf8');
    expect(recordRepairHandoffs(input)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(readFileSync(repairHandoffV2JournalPath(), 'utf8')).toBe(durableV2);
    expect(compactRepairHandoffs()).toMatchObject({ available: false });
  });

  it('rejects a fresh append while the sibling journal is malformed', () => {
    const repo = fx.makeRepo();
    const input = event(repo.dir, { itemId: 'repo:self:malformed-v1-sibling' });
    mkdirSync(dirname(repairHandoffJournalPath()), { recursive: true, mode: 0o700 });
    writeFileSync(repairHandoffJournalPath(), '{}\n', { mode: 0o600 });

    expect(readRepairHandoffs()).toMatchObject({ sourceState: 'degraded', invalidRows: 1 });
    expect(recordRepairHandoffs(input)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(existsSync(repairHandoffV2JournalPath())).toBe(false);

    expect(compactRepairHandoffs()).toEqual({ available: true, before: 1, after: 0, removed: 1 });
    expect(readRepairHandoffs()).toMatchObject({ sourceState: 'healthy', invalidRows: 0 });
    expect(recordRepairHandoffs(input)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
  });

  it.each([
    'append-file-fsync',
    'append-path-verification',
    'append-directory-fsync',
  ] as const)('deterministically reconciles exact replay after %s failure', (faultPoint) => {
    const repo = fx.makeRepo();
    const input = event(repo.dir, { itemId: `repo:self:${faultPoint}` });
    const visits: string[] = [];
    let inject = true;
    _setRepairHandoffJournalFaultForTest((point) => {
      visits.push(point);
      if (point === faultPoint && inject) {
        inject = false;
        throw new Error(`injected ${point} failure`);
      }
    });

    expect(recordRepairHandoffs(input)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(readFileSync(repairHandoffV2JournalPath(), 'utf8')).toContain(input.itemId);
    expect(recordRepairHandoffs(input)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(visits.filter((point) => point === faultPoint)).toHaveLength(2);
    expect(readFileSync(repairHandoffV2JournalPath(), 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
    expect(readRepairHandoffs()).toMatchObject({
      sourceState: 'healthy',
      invalidRows: 0,
      physicalRows: 1,
    });
  });

  it('requires torn-tail compaction to restore health before any later append', () => {
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
    const degraded = readFileSync(repairHandoffV2JournalPath(), 'utf8');

    expect(recordRepairHandoffs(first)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(readFileSync(repairHandoffV2JournalPath(), 'utf8')).toBe(degraded);
    expect(recordRepairHandoffs(second)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(readFileSync(repairHandoffV2JournalPath(), 'utf8')).toBe(degraded);

    expect(compactRepairHandoffs()).toEqual({ available: true, before: 1, after: 1, removed: 0 });
    expect(readRepairHandoffs()).toMatchObject({ sourceState: 'healthy', invalidRows: 0 });
    expect(readFileSync(repairHandoffV2JournalPath(), 'utf8')).not.toContain('{"partial":');
    expect(recordRepairHandoffs(second)).toMatchObject({ recorded: 1, failed: 0 });

    const read = readRepairHandoffs();
    expect(read.sourceState).toBe('healthy');
    expect(read.invalidRows).toBe(0);
    expect(read.observations.map((row) => row.parentItemId).sort()).toEqual([
      'repo:self:first',
      'repo:self:second',
    ]);
  });

  it('rejects exact replay when physical rows exceed the durable journal limit', () => {
    const repo = fx.makeRepo();
    const input = event(repo.dir, { itemId: 'repo:self:over-limit-replay' });
    expect(recordRepairHandoffs(input)).toMatchObject({ recorded: 1, failed: 0 });
    const path = repairHandoffV2JournalPath();
    writeFileSync(path, '{}\n'.repeat(100_000), { encoding: 'utf8', flag: 'a' });
    const overLimit = readFileSync(path, 'utf8');

    expect(recordRepairHandoffs(input)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(readFileSync(path, 'utf8')).toBe(overLimit);
    expect(readRepairHandoffs()).toMatchObject({
      sourceState: 'degraded',
      limitExceeded: true,
      physicalRows: 100_001,
    });
  });

  it('reserves capacity for a torn tail before appending its separator', () => {
    const repo = fx.makeRepo();
    const first = event(repo.dir, { itemId: 'repo:self:capacity-anchor' });
    const next = event(repo.dir, {
      itemId: 'repo:self:capacity-next',
      ts: '2026-07-10T12:01:00.000Z',
      runId: 'attempt-22345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-22345678-1234-4123-8123-123456789abc',
    });
    expect(recordRepairHandoffs(first)).toMatchObject({ recorded: 1, failed: 0 });
    const path = repairHandoffV2JournalPath();
    writeFileSync(path, `${'{}\n'.repeat(99_998)}{`, { encoding: 'utf8', flag: 'a' });
    const atCapacityAfterSeparator = readFileSync(path, 'utf8');

    expect(readRepairHandoffs()).toMatchObject({ physicalRows: 99_999, limitExceeded: false });
    expect(recordRepairHandoffs(next)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(readFileSync(path, 'utf8')).toBe(atCapacityAfterSeparator);
  });

  it('fails compaction unavailable without rewriting an oversized unreadable journal', () => {
    const path = repairHandoffV2JournalPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, '', { mode: 0o600 });
    truncateSync(path, 256 * 1024 * 1024 + 1);
    const oversizedBytes = statSync(path).size;

    expect(readRepairHandoffs()).toMatchObject({
      sourceState: 'degraded',
      limitExceeded: true,
      physicalRows: 0,
    });
    expect(compactRepairHandoffs()).toEqual({
      available: false,
      before: 0,
      after: 0,
      removed: 0,
    });
    expect(statSync(path).size).toBe(oversizedBytes);
  });

  it('anchors fresh Windows fleet and journal authority before writing', () => {
    privateStorageHarness.useSemanticAdapter = true;
    const repo = fx.makeRepo();
    const path = repairHandoffV2JournalPath();
    const fleetDir = dirname(path);

    expect(recordRepairHandoffs(event(repo.dir)))
      .toEqual({ attempted: 1, recorded: 1, failed: 0 });
    const authorityCalls = privateStorageHarness.semanticInvocations.filter(
      (call) => call.path === fleetDir || call.path === path,
    );
    expect(authorityCalls).toEqual(expect.arrayContaining([
      {
        path: fleetDir,
        kind: 'directory',
        mode: 'secure-created',
        anchorPath: fx.ashlrDir,
      },
      {
        path,
        kind: 'file',
        mode: 'secure-created',
        anchorPath: fleetDir,
      },
      {
        path,
        kind: 'file',
        mode: 'inspect-existing',
        anchorPath: fleetDir,
      },
    ]));
    expect(readRepairHandoffs()).toMatchObject({ sourceState: 'healthy', physicalRows: 1 });
  });

  it('exact-inspects pre-existing Windows fleet and journal authority without rewriting it', () => {
    privateStorageHarness.useSemanticAdapter = true;
    const path = repairHandoffV2JournalPath();
    const fleetDir = dirname(path);
    mkdirSync(fleetDir, { recursive: true, mode: 0o700 });
    writeFileSync(path, '', { mode: 0o600 });

    expect(readRepairHandoffs())
      .toMatchObject({ sourceState: 'healthy', physicalRows: 0 });
    const authorityCalls = privateStorageHarness.semanticInvocations.filter(
      (call) => call.path === fleetDir || call.path === path,
    );
    expect(authorityCalls).toEqual(expect.arrayContaining([
      {
        path: fleetDir,
        kind: 'directory',
        mode: 'inspect-existing',
        anchorPath: fx.ashlrDir,
      },
      {
        path,
        kind: 'file',
        mode: 'inspect-existing',
        anchorPath: fleetDir,
      },
    ]));
    expect(authorityCalls.some((call) => call.mode === 'secure-created')).toBe(false);
  });

  it('fails closed when Windows directory or journal assurance fails', () => {
    privateStorageHarness.useSemanticAdapter = true;
    const repo = fx.makeRepo();
    const path = repairHandoffV2JournalPath();
    const fleetDir = dirname(path);
    privateStorageHarness.semanticFailure = {
      path: fleetDir,
      kind: 'directory',
      mode: 'secure-created',
    };

    expect(recordRepairHandoffs(event(repo.dir)))
      .toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(existsSync(path)).toBe(false);

    privateStorageHarness.semanticFailure = {
      path,
      kind: 'file',
      mode: 'secure-created',
    };
    expect(recordRepairHandoffs(event(repo.dir)))
      .toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(readFileSync(path, 'utf8')).toBe('');

    rmSync(path);
    writeFileSync(path, '', { mode: 0o600 });
    privateStorageHarness.semanticFailure = {
      path,
      kind: 'file',
      mode: 'inspect-existing',
    };
    expect(readRepairHandoffs())
      .toMatchObject({ sourceState: 'degraded', observations: [] });
    expect(recordRepairHandoffs(event(repo.dir)))
      .toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(readFileSync(path, 'utf8')).toBe('');
  });

  it('secures Windows compaction files before install and exact-inspects the result', () => {
    privateStorageHarness.useSemanticAdapter = true;
    const repo = fx.makeRepo();
    const path = repairHandoffV2JournalPath();
    const fleetDir = dirname(path);
    expect(recordRepairHandoffs(event(repo.dir)))
      .toMatchObject({ recorded: 1, failed: 0 });
    const row = readRepairHandoffs().observations[0]!;
    const compactedContents = `${JSON.stringify(row)}\n`;
    writeFileSync(path, `${JSON.stringify(row)}\n`, { encoding: 'utf8', flag: 'a' });
    privateStorageHarness.semanticInvocations.length = 0;
    privateStorageHarness.captureFileContents = true;

    expect(compactRepairHandoffs())
      .toEqual({ available: true, before: 2, after: 1, removed: 1 });
    const fileCalls = privateStorageHarness.semanticInvocations.filter(
      (call) => call.kind === 'file' && call.anchorPath === fleetDir,
    );
    const securedTempIndex = fileCalls.findIndex((call) =>
      call.mode === 'secure-created' &&
      /^.+repair-handoffs-v2\.jsonl\.\d+\.[a-f0-9]{12}\.tmp$/.test(call.path));
    const installedInspectIndex = fileCalls.findIndex((call, index) =>
      index > securedTempIndex && call.path === path &&
      call.mode === 'inspect-existing' && call.fileContents === compactedContents);
    expect(securedTempIndex).toBeGreaterThanOrEqual(0);
    expect(fileCalls[securedTempIndex]).toMatchObject({
      mode: 'secure-created',
      anchorPath: fleetDir,
      fileContents: '',
    });
    expect(installedInspectIndex).toBeGreaterThan(securedTempIndex);
    expect(fileCalls[installedInspectIndex]).toEqual({
      path,
      kind: 'file',
      mode: 'inspect-existing',
      anchorPath: fleetDir,
      fileContents: compactedContents,
    });
  });

  it.skipIf(process.platform !== 'win32')(
    'establishes native exact private DACLs for fresh and compacted repair handoff storage',
    () => {
      privateStorageHarness.useSemanticAdapter = false;
      mkdirSync(fx.ashlrDir, { mode: 0o700 });
      expect(assurePrivateStoragePath(
        fx.ashlrDir,
        'directory',
        'secure-created',
        { anchorPath: fx.home },
      ).ok).toBe(true);
      const realCallsBefore = privateStorageHarness.realCalls;
      const repo = fx.makeRepo();
      expect(recordRepairHandoffs(event(repo.dir)))
        .toEqual({ attempted: 1, recorded: 1, failed: 0 });
      const path = repairHandoffV2JournalPath();
      const fleetDir = dirname(path);
      expect(assurePrivateStoragePath(
        fleetDir,
        'directory',
        'inspect-existing',
        { anchorPath: fx.ashlrDir },
      ).ok).toBe(true);
      expect(assurePrivateStoragePath(
        path,
        'file',
        'inspect-existing',
        { anchorPath: fleetDir },
      ).ok).toBe(true);
      const row = readRepairHandoffs().observations[0]!;
      writeFileSync(path, `${JSON.stringify(row)}\n`, { encoding: 'utf8', flag: 'a' });
      expect(compactRepairHandoffs())
        .toEqual({ available: true, before: 2, after: 1, removed: 1 });
      expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(row)}\n`);
      expect(assurePrivateStoragePath(
        path,
        'file',
        'inspect-existing',
        { anchorPath: fleetDir },
      ).ok).toBe(true);
      expect(privateStorageHarness.realCalls).toBeGreaterThan(realCallsBefore);
    },
    90_000,
  );

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
      `const queued = queueSelfHealItem(item);`,
      `if (!queued) console.error(JSON.stringify({ queued, itemId: item.id }));`,
      `process.exit(queued ? 0 : 1);`,
    ].join(' ');
    const children = Array.from({ length: 12 }, (_, index) => new Promise<{
      index: number;
      code: number | null;
      signal: NodeJS.Signals | null;
      stderr: string;
    }>((resolve, reject) => {
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
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ index, code, signal, stderr }));
    }));

    const outcomes = await Promise.all(children);
    expect(outcomes).toEqual(outcomes.map((outcome) => ({
      index: outcome.index,
      code: 0,
      signal: null,
      stderr: '',
    })));
    const queue = JSON.parse(readFileSync(join(fx.ashlrDir, 'self-heal-queue.json'), 'utf8')) as Array<{ id: string }>;
    expect(queue).toHaveLength(12);
    expect(new Set(queue.map((item) => item.id)).size).toBe(12);
  }, 20_000);

  it('preserves a concurrent journal burst and collapses replay by semantic event id', async () => {
    const repo = fx.makeRepo();
    mkdirSync(dispatchProductionDir(), { recursive: true, mode: 0o700 });
    const script = [
      `import { recordRepairHandoffs } from './src/core/fleet/repair-handoff-journal.ts';`,
      `const event = JSON.parse(process.env.ASHLR_TEST_EVENT);`,
      `const result = recordRepairHandoffs(event, { schemaVersion: 2, activation: { id: '11111111-1111-4111-8111-111111111111', activatedAt: '2026-07-10T11:00:00.000Z' } });`,
      `if (result.recorded !== 1) console.error(JSON.stringify(result));`,
      `process.exit(result.recorded === 1 ? 0 : 1);`,
    ].join(' ');
    const inputs = Array.from({ length: 12 }, (_, index) => event(repo.dir, {
      itemId: `repo:self:journal-${index}`,
      runId: `attempt-${String(index).padStart(8, '0')}-1234-4123-8123-123456789abc`,
      trajectoryId: `run:attempt-${String(index).padStart(8, '0')}-1234-4123-8123-123456789abc`,
    }));
    const outcomes = await Promise.all(inputs.map((input, index) => new Promise<{
      index: number;
      code: number | null;
      signal: NodeJS.Signals | null;
      stderr: string;
    }>((resolve, reject) => {
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
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ index, code, signal, stderr }));
    })));
    expect(outcomes).toEqual(outcomes.map((outcome) => ({
      index: outcome.index,
      code: 0,
      signal: null,
      stderr: '',
    })));
    recordRepairHandoffsRaw(inputs[0]!, {
      schemaVersion: 2,
      activation: {
        id: '11111111-1111-4111-8111-111111111111',
        activatedAt: '2026-07-10T11:00:00.000Z',
      },
    });

    const read = readRepairHandoffs();
    expect(read.sourceState).toBe('healthy');
    expect(read.observations).toHaveLength(12);
    expect(new Set(read.observations.map((row) => row.eventId)).size).toBe(12);
  }, 20_000);

  it('serializes an equal-time activation race and keeps exact replay idempotent', async () => {
    const repo = fx.makeRepo();
    const activations: RepairHandoffV2Activation[] = [
      ACTIVATION_A,
      { id: '33333333-3333-4333-8333-333333333333', activatedAt: ACTIVATION_A.activatedAt },
    ];
    const inputs = activations.map((_activation, index) => event(repo.dir, {
      itemId: `repo:self:activation-race-${index}`,
      objectiveHash: `${index + 1}`.repeat(64),
      runId: `attempt-${index + 1}2345678-1234-4123-8123-123456789abc`,
      trajectoryId: `run:attempt-${index + 1}2345678-1234-4123-8123-123456789abc`,
    }));
    const script = [
      `import { recordRepairHandoffs } from './src/core/fleet/repair-handoff-journal.ts';`,
      `const payload = JSON.parse(process.env.ASHLR_TEST_PAYLOAD);`,
      `console.log(JSON.stringify(recordRepairHandoffs(payload.event, { schemaVersion: 2, activation: payload.activation })));`,
    ].join(' ');
    const results = await Promise.all(inputs.map((input, index) => new Promise<{
      attempted: number;
      recorded: number;
      failed: number;
    }>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const child = spawn(join(process.cwd(), 'node_modules', '.bin', 'tsx'), ['-e', script], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: fx.home,
          USERPROFILE: fx.home,
          ASHLR_HOME: fx.ashlrDir,
          ASHLR_TEST_PAYLOAD: JSON.stringify({ event: input, activation: activations[index] }),
        },
        stdio: 'pipe',
      });
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code !== 0) reject(new Error(`activation race child exited ${code}: ${stderr}`));
        else resolve(JSON.parse(stdout.trim()));
      });
    })));

    expect(results.map((result) => result.recorded).sort()).toEqual([0, 1]);
    expect(results.map((result) => result.failed).sort()).toEqual([0, 1]);
    const winner = results.findIndex((result) => result.recorded === 1);
    expect(recordRepairHandoffsRaw(inputs[winner]!, {
      schemaVersion: 2,
      activation: activations[winner]!,
    })).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(readRepairHandoffs()).toMatchObject({
      sourceState: 'healthy',
      conflictingIds: 0,
      physicalRows: 1,
      observations: [expect.objectContaining({ parentItemId: inputs[winner]!.itemId })],
    });
    expect(readFileSync(repairHandoffV2JournalPath(), 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
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
    const terminal = recordDiagnosticProposal(
      first,
      'attempt-32345678-1234-4123-8123-123456789abc',
      'prop-terminal-generation',
    );
    expect(terminal.transition).toMatchObject({ available: true, disposition: 'retired', recorded: true });
    expect(readGeneratedRepairLifecycle(first)).toMatchObject({ available: true, disposition: 'retired' });

    queueProposalRepairWorkForPendingProposals(undefined, new Date(), {
      lifecycleProposals: [terminal.proposal],
    });
    expect(await scanQueuedAutonomyWork(repo.dir)).toEqual([]);

    const recurrence = event(repo.dir, {
      ts: '2026-07-10T14:00:00.000Z',
      runId: 'attempt-42345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-42345678-1234-4123-8123-123456789abc',
    });
    recordRepairHandoffs(recurrence);
    const recurrenceHandoff = repairHandoffFromDispatchEvent(recurrence)!;
    queueProposalRepairWorkForPendingProposals(undefined, new Date(), {
      lifecycleProposals: [terminal.proposal],
    });
    const active = await scanQueuedAutonomyWork(repo.dir);

    expect(active).toEqual([]);
    expect(recurrenceHandoff.generationId).toBe(first.repairGenerationId);
    expect(readGeneratedRepairLifecycle(first)).toMatchObject({
      available: true,
      disposition: 'retired',
    });
    recordOutcome(firstCooldownKey, 'empty');
    expect(recentlyDeclined(firstCooldownKey, 60_000)).toBe(true);
    expect(generatedRepairCooldownKey({ ...first, repairGenerationId: recurrenceHandoff.generationId }))
      .toBe(firstCooldownKey);
  });

  it('preserves empty-attempt memory across unchanged parent recurrence', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const firstEvent = event(repo.dir, { tier: 'mid' });
    recordRepairHandoffs(firstEvent);
    queueProposalRepairWorkForPendingProposals(undefined, new Date('2026-07-10T13:00:00.000Z'));
    const first = (await scanQueuedAutonomyWork(repo.dir))[0]!;
    recordDiagnosticEmpty(
      first,
      'attempt-32345678-1234-4123-8123-123456789abc',
      'local-coder',
      'mid',
      1,
    );

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
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 1,
    });
    expect(recordDiagnosticEmpty(
      current,
      'attempt-52345678-1234-4123-8123-123456789abc',
      'kimi',
      'mid',
      2,
    )).toMatchObject({ disposition: 'quarantined', authoritativeEmptyRuns: 2 });
  });

  it('preserves generation proof across an intentional writer activation rollover', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const firstEvent = event(repo.dir, { tier: 'mid' });
    expect(recordRepairHandoffsRaw(firstEvent, { schemaVersion: 2, activation: ACTIVATION_A }))
      .toMatchObject({ recorded: 1, failed: 0 });
    queueProposalRepairWorkForPendingProposals(undefined, new Date('2026-07-10T13:00:00.000Z'));
    const first = (await scanQueuedAutonomyWork(repo.dir))[0]!;
    expect(recordDiagnosticEmpty(
      first,
      'attempt-32345678-1234-4123-8123-123456789abc',
      'local-coder',
      'mid',
      1,
    )).toMatchObject({ available: true, disposition: 'active', authoritativeEmptyRuns: 1 });

    const rollover = event(repo.dir, {
      ts: '2026-07-10T14:00:00.000Z',
      backend: 'codex',
      tier: 'frontier',
      runId: 'attempt-42345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-42345678-1234-4123-8123-123456789abc',
    });
    expect(recordRepairHandoffsRaw(rollover, { schemaVersion: 2, activation: ACTIVATION_B }))
      .toMatchObject({ recorded: 1, failed: 0 });
    queueProposalRepairWorkForPendingProposals(undefined, new Date('2026-07-10T15:00:00.000Z'));
    const current = (await scanQueuedAutonomyWork(repo.dir))[0]!;

    expect(current.repairGenerationId).toBe(first.repairGenerationId);
    expect(readGeneratedRepairLifecycle(current)).toMatchObject({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 1,
    });
    expect(readRepairHandoffSchemaSummary(ACTIVATION_B)).toMatchObject({
      currentActivationV2Authorities: 1,
      latestCurrentActivationV2At: rollover.ts,
    });
  });

  it('carries exact hashful v1 control evidence into the v2 objective family', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const firstEvent = event(repo.dir, { tier: 'mid' });
    const v1 = legacyObservation(repairHandoffFromDispatchEvent(firstEvent)!);
    recordDispatchProduction(firstEvent);
    mkdirSync(dirname(repairHandoffJournalPath()), { recursive: true });
    writeFileSync(repairHandoffJournalPath(), `${JSON.stringify(v1)}\n`, { mode: 0o600 });
    queueProposalRepairWorkForPendingProposals(undefined, new Date('2026-07-10T13:00:00.000Z'));
    const legacyItem = (await scanQueuedAutonomyWork(repo.dir))[0]!;
    recordDiagnosticEmpty(
      legacyItem,
      'attempt-32345678-1234-4123-8123-123456789abc',
      'local-coder',
      'mid',
      1,
    );
    recordOutcome(generatedRepairCooldownKey(legacyItem), 'empty');

    const recurrence = event(repo.dir, {
      ts: '2026-07-10T14:00:00.000Z',
      tier: 'mid',
      runId: 'attempt-42345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-42345678-1234-4123-8123-123456789abc',
    });
    recordRepairHandoffs(recurrence);
    queueProposalRepairWorkForPendingProposals(undefined, new Date('2026-07-10T15:00:00.000Z'));
    const current = (await scanQueuedAutonomyWork(repo.dir))[0]!;

    const v2GenerationId = repairHandoffFromDispatchEvent(recurrence)!.generationId;
    expect(current.repairGenerationId).not.toBe(legacyItem.repairGenerationId);
    expect(current.repairGenerationId).toBe(v2GenerationId);
    expect(generatedRepairGenerationIds(current)).toEqual(expect.arrayContaining([
      legacyItem.repairGenerationId,
      v2GenerationId,
    ]));
    expect(generatedRepairCooldownKeys(current)).toContain(generatedRepairCooldownKey(legacyItem));
    expect(readGeneratedRepairLifecycle(current)).toMatchObject({
      available: true,
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

    expect(recordDiagnosticEmpty(
      current,
      'attempt-52345678-1234-4123-8123-123456789abc',
      'kimi',
      'mid',
      2,
    )).toMatchObject({ disposition: 'exhausted', authoritativeEmptyRuns: 2 });
  });

  it.each([
    { label: 'same backend', secondBackend: 'local-coder', secondTier: 'mid' },
    { label: 'cross tier', secondBackend: 'codex', secondTier: 'frontier' },
  ] as const)('fails closed when split aliases synthesize $label exhaustion', async ({ secondBackend, secondTier }) => {
    const repo = fx.makeRepo();
    repo.enroll();
    const firstEvent = event(repo.dir, { tier: 'mid' });
    const v1 = legacyObservation(repairHandoffFromDispatchEvent(firstEvent)!);
    recordDispatchProduction(firstEvent);
    mkdirSync(dirname(repairHandoffJournalPath()), { recursive: true });
    writeFileSync(repairHandoffJournalPath(), `${JSON.stringify(v1)}\n`, { mode: 0o600 });
    queueProposalRepairWorkForPendingProposals(undefined, new Date('2026-07-10T13:00:00.000Z'));

    const recurrence = event(repo.dir, {
      ts: '2026-07-10T14:00:00.000Z',
      tier: 'mid',
      runId: 'attempt-42345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-42345678-1234-4123-8123-123456789abc',
    });
    recordRepairHandoffs(recurrence);
    queueProposalRepairWorkForPendingProposals(undefined, new Date('2026-07-10T15:00:00.000Z'));
    const current = (await scanQueuedAutonomyWork(repo.dir))[0]!;
    const generations = generatedRepairGenerationIds(current);
    expect(generations).toHaveLength(2);

    mkdirSync(dirname(generatedRepairLifecyclePath()), { recursive: true });
    writeFileSync(generatedRepairLifecyclePath(), `${JSON.stringify({
      schemaVersion: 1,
      records: [
        {
          generationId: generations[0],
          disposition: 'active',
          emptyAttemptHashes: [createHash('sha256').update('alias-attempt-one').digest('hex')],
          emptyAttemptBackends: ['local-coder'],
          emptyAttemptTiers: ['mid'],
          updatedAt: '2026-07-10T13:00:00.000Z',
        },
        {
          generationId: generations[1],
          disposition: 'active',
          emptyAttemptHashes: [createHash('sha256').update('alias-attempt-two').digest('hex')],
          emptyAttemptBackends: [secondBackend],
          emptyAttemptTiers: [secondTier],
          updatedAt: '2026-07-10T14:00:00.000Z',
        },
      ],
    })}\n`, { mode: 0o600 });

    expect(readGeneratedRepairLifecycle(current)).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
  });

  it('never relabels tierless child evidence across v1 and v2 aliases', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const firstEvent = event(repo.dir, { backend: 'codex', tier: 'frontier' });
    const v1 = legacyObservation(repairHandoffFromDispatchEvent(firstEvent)!);
    recordDispatchProduction(firstEvent);
    mkdirSync(dirname(repairHandoffJournalPath()), { recursive: true });
    writeFileSync(repairHandoffJournalPath(), `${JSON.stringify(v1)}\n`, { mode: 0o600 });
    queueProposalRepairWorkForPendingProposals(undefined, new Date('2026-07-10T13:00:00.000Z'));
    const legacyItem = (await scanQueuedAutonomyWork(repo.dir))[0]!;
    recordDiagnosticEmpty(
      legacyItem,
      'attempt-32345678-1234-4123-8123-123456789abc',
      'codex',
      'frontier',
      1,
    );
    const lifecycle = JSON.parse(readFileSync(generatedRepairLifecyclePath(), 'utf8')) as {
      records: Array<{ emptyAttemptTiers?: string[] }>;
    };
    delete lifecycle.records[0]!.emptyAttemptTiers;
    writeFileSync(generatedRepairLifecyclePath(), `${JSON.stringify(lifecycle)}\n`, 'utf8');

    const recurrence = event(repo.dir, {
      ts: '2026-07-10T14:00:00.000Z',
      backend: 'local-coder',
      tier: 'mid',
      runId: 'attempt-42345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-42345678-1234-4123-8123-123456789abc',
    });
    recordRepairHandoffs(recurrence);
    queueProposalRepairWorkForPendingProposals(undefined, new Date('2026-07-10T15:00:00.000Z'));
    const current = (await scanQueuedAutonomyWork(repo.dir))[0]!;
    const second = recordDiagnosticEmpty(
      current,
      'attempt-52345678-1234-4123-8123-123456789abc',
      'claude',
      'frontier',
      2,
    );

    expect(second).toMatchObject({ available: false, disposition: 'active', authoritativeEmptyRuns: 0 });
  });

  it('preserves terminal objective control when the writer rolls back from v2 to v1', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const firstEvent = event(repo.dir, {
      itemId: 'repo:self:rollback-terminal-family',
      ts: '2026-07-10T12:00:00.000Z',
      tier: 'mid',
    });
    expect(recordRepairHandoffsRaw(firstEvent)).toMatchObject({ recorded: 1 });
    queueProposalRepairWorkForPendingProposals(undefined, new Date('2026-07-10T12:30:00.000Z'));
    const legacyItem = (await scanQueuedAutonomyWork(repo.dir))[0]!;
    recordDiagnosticEmpty(
      legacyItem,
      'attempt-32345678-1234-4123-8123-123456789abc',
      'local-coder',
      'mid',
      1,
    );
    expect(recordDiagnosticEmpty(
      legacyItem,
      'attempt-42345678-1234-4123-8123-123456789abc',
      'kimi',
      'mid',
      2,
    )).toMatchObject({ disposition: 'quarantined' });

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
    expect(readGeneratedRepairLifecycle(rollbackItem)).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
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

  it('rejects timestamp mutation within one v2 parent attempt before append', () => {
    const repo = fx.makeRepo();
    const first = event(repo.dir, { ts: '2026-07-10T12:00:00.000Z' });
    const replay = event(repo.dir, { ts: '2026-07-10T12:05:00.000Z' });
    expect(recordRepairHandoffs([first, replay]))
      .toEqual({ attempted: 2, recorded: 1, failed: 1 });

    const read = readRepairHandoffs();
    expect(read).toMatchObject({
      sourceState: 'healthy',
      conflictingIds: 0,
      physicalRows: 1,
      observations: [expect.objectContaining({ ts: first.ts })],
    });
    expect(compactRepairHandoffs()).toEqual({ available: true, before: 1, after: 1, removed: 0 });
  });

  it('projects the immutable first v2 attempt while compaction preserves recurrence history', () => {
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
    expect(read.observations[0]).toMatchObject({
      ts: first.ts,
      parentAttemptId: first.trajectoryId,
      parentBackend: first.backend,
      parentTier: first.tier,
    });
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

  it('keeps aged malformed crash locks fail-closed for operator repair', () => {
    const lockPath = join(fx.ashlrDir, 'fleet', 'm362.lock');
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, '');
    const old = new Date(Date.now() - 5_000);
    utimesSync(lockPath, old, old);

    const acquired = acquireLocalStoreLock(lockPath, 100);
    expect(acquired).toBeNull();
    expect(existsSync(lockPath)).toBe(true);
    rmSync(lockPath);
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
