import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import { buildBacklog } from '../src/core/portfolio/backlog.js';
import {
  loadQueuedAutonomyItems,
  loadQueuedAutonomyItemsDetailed,
} from '../src/core/portfolio/queued-autonomy.js';
import { scanQueuedAutonomyWork } from '../src/core/portfolio/scanners.js';
import {
  captureGateRepairWorkItem,
  generatedRepairRootKey,
  isRejectedCaptureRecoveryAuthorized,
  isVerifiedFailureProposalRepairAuthorized,
  noDiffResliceWorkItem,
  proposalRepairWorkItem,
  queueProposalRepairWorkForPendingProposals,
  resolveDiagnosticResliceParents,
} from '../src/core/fleet/proposal-repair-work.js';
import { proposalRepairId } from '../src/core/fleet/proposal-repair-identity.js';
import { decisionsDir } from '../src/core/fleet/decisions-ledger.js';
import type { Proposal, WorkItem } from '../src/core/types.js';
import {
  dispatchProductionDir,
  recordDispatchProduction,
  type DispatchProductionEvent,
} from '../src/core/fleet/dispatch-production-ledger.js';
import { workItemObjectiveHash } from '../src/core/fleet/work-item-objective.js';
import { workItemCoverageKey } from '../src/core/fleet/proposal-matching.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import {
  recordRepairHandoffs,
  readRepairHandoffs,
  repairGenerationIdFromHandoffId,
  repairHandoffFromDispatchEvent,
  repairHandoffJournalPath,
  repairHandoffV2JournalPath,
} from '../src/core/fleet/repair-handoff-journal.js';
import {
  generatedRepairGenerationId,
  generatedRepairLifecyclePath,
  readGeneratedRepairLifecycle,
  recordGeneratedRepairLifecycle,
} from '../src/core/fleet/generated-repair-lifecycle.js';
import { repairTreatmentForUnitId } from '../src/core/fleet/generated-repair-identity.js';
import { createProposal, inboxDir, loadProposal, setStatus, updateProposalField } from '../src/core/inbox/store.js';
import {
  PROPOSAL_PERSISTENCE_MISMATCH_REASON,
  PROPOSAL_PERSISTENCE_MISMATCH_RESULT,
} from '../src/core/inbox/persistence-mismatch.js';
import { hashDiff } from '../src/core/foundry/provenance.js';
import {
  PRIVATE_STORAGE_TEST_CONTROL,
  _setPrivateStorageTestControlForTest,
  type PrivateStorageRunner,
} from '../src/core/util/private-storage.js';

let fx: H1Fixture;

const semanticPrivateStorageRunner: PrivateStorageRunner = (invocation) => {
  const request = JSON.parse(invocation.input) as {
    nonce: string;
    operation: string;
    mode?: 'secure-created' | 'inspect-existing' | 'inspect-owned';
  };
  const reason = request.operation === 'assure-private-paths'
    ? 'owned-safe-paths'
    : request.mode === 'inspect-owned'
      ? 'owned-safe-path'
      : 'exact-private-dacl';
  return {
    status: 0,
    stdout: JSON.stringify({
      nonce: request.nonce,
      operation: request.operation,
      ok: true,
      reason,
    }),
  };
};

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
});

afterEach(() => {
  vi.useRealTimers();
  fx.cleanup();
});

function item(repo: string, id: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    repo,
    source: 'invent',
    title: `Implement queued autonomy item ${id}`,
    detail: 'Implement a focused code change that improves autonomous engineering reliability.',
    value: 5,
    effort: 2,
    score: 2.5,
    tags: ['generative', 'bold'],
    ts: new Date().toISOString(),
    ...overrides,
  };
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(fx.ashlrDir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
}

function partialProposal(repo: string, overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-partial-repair',
    repo,
    origin: 'swarm',
    kind: 'patch',
    title: 'Partial proposal with useful work',
    summary: 'A sandbox produced partial work that needs repair.',
    status: 'pending',
    createdAt: new Date().toISOString(),
    diff: 'diff --git a/src/secret.ts b/src/secret.ts\n+const leaked = "DO_NOT_COPY_DIFF";\n',
    workItemId: 'repo:goal:original',
    isPartial: true,
    verifyResult: {
      passed: false,
      detail: 'capture gate blocked proposal after test failure in src/app.ts:12: expected ready state',
      source: 'capture-gate',
    },
    ...overrides,
  };
}

function captureFailure(repo: string, overrides: Partial<DispatchProductionEvent> = {}): DispatchProductionEvent {
  const value: DispatchProductionEvent = {
    schemaVersion: 1,
    ts: '2026-07-09T12:00:00.000Z',
    machineId: 'm310',
    itemId: 'repo:self:original-capture',
    source: 'self',
    repo,
    title: 'Self improvement capture failure with useful work',
    backend: 'local-coder',
    tier: 'local',
    model: 'qwen',
    assignedBy: 'daemon',
    routeReason: 'self-improvement local route',
    outcome: 'gate-blocked',
    proposalCreated: false,
    spentUsd: 0,
    reason: 'gate-blocked: completeness gate blocked proposal after test failure',
    objectiveHash: 'a'.repeat(64),
    basis: 'run-proposal-outcome',
    ...overrides,
  };
  recordRepairHandoffs(value, {
    schemaVersion: 2,
    activation: { id: '11111111-1111-4111-8111-111111111111', activatedAt: '2020-01-01T00:00:00.000Z' },
  });
  const handoff = repairHandoffFromDispatchEvent(value);
  return handoff
    ? { ...value, repairHandoffId: handoff.eventId, repairGenerationId: handoff.generationId }
    : value;
}

function recordDiagnosticEmpty(
  repair: WorkItem,
  attemptId: string,
  backend: 'local-coder' | 'kimi',
  ordinal: 1 | 2,
) {
  const ts = new Date(Date.now() - (3 - ordinal) * 1_000).toISOString();
  const routeReason = `m310 diagnostic attempt ${ordinal}`;
  const event: DispatchProductionEvent = {
    schemaVersion: 1,
    ts,
    itemId: repair.id,
    source: repair.source,
    repo: repair.repo,
    title: repair.title,
    backend,
    tier: 'mid',
    assignedBy: 'daemon',
    routeReason,
    outcome: 'empty-diff',
    proposalCreated: false,
    runId: attemptId,
    trajectoryId: `run:${attemptId}`,
    routeSnapshot: {
      backend,
      tier: 'mid',
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
    objectiveHash: workItemObjectiveHash(repair),
    spentUsd: 0,
    basis: 'run-proposal-outcome',
    repairHandoffId: repair.repairHandoffId,
    repairGenerationId: repair.repairGenerationId,
    repairTreatmentUnitId: repair.repairTreatmentUnitId,
    repairTreatment: repair.repairTreatment,
    repairAttemptOrdinal: ordinal,
  };
  if (ordinal === 2) event.repairPreviousBackend = 'local-coder';
  expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
  return recordGeneratedRepairLifecycle(repair, { kind: 'dispatch-proof-empty-diff', eventTs: ts });
}

function diagnosticProposalEvent(
  repair: WorkItem,
  attemptId: string,
  proposalId: string,
  ts = '2026-07-10T15:30:00.000Z',
): DispatchProductionEvent {
  const eventTs = Date.parse(ts) < Date.now() - 60_000 ? new Date().toISOString() : ts;
  const routeReason = 'm310 diagnostic proposal attempt';
  return {
    schemaVersion: 1,
    ts: eventTs,
    itemId: repair.id,
    source: repair.source,
    repo: repair.repo,
    title: repair.title,
    backend: 'local-coder',
    tier: 'mid',
    assignedBy: 'daemon',
    routeReason,
    outcome: 'proposal-created',
    proposalCreated: true,
    proposalId,
    runId: attemptId,
    trajectoryId: `run:${attemptId}`,
    routeSnapshot: {
      backend: 'local-coder',
      tier: 'mid',
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
    objectiveHash: workItemObjectiveHash(repair),
    spentUsd: 0,
    diffFiles: 1,
    diffLines: 2,
    basis: 'run-proposal-outcome',
    repairHandoffId: repair.repairHandoffId,
    repairGenerationId: generatedRepairGenerationId(repair) ?? undefined,
    repairTreatmentUnitId: repair.repairTreatmentUnitId,
    repairTreatment: repair.repairTreatment,
    repairAttemptOrdinal: 1,
    ...(repair.repairTreatmentUnitId === undefined && repair.repairTreatment === undefined
      ? { repairRootId: repair.repairRootId, repairDepth: repair.repairDepth }
      : {}),
  };
}

const DIAGNOSTIC_PROPOSAL_DIFF =
  'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';

function diagnosticProposalForEvent(
  repair: WorkItem,
  event: DispatchProductionEvent,
  overrides: Partial<Proposal> = {},
): Proposal {
  if (!event.proposalId || !event.runId || !event.trajectoryId || !event.runEventSummary) {
    throw new Error('diagnostic proposal event must carry complete proposal binding');
  }
  const diff = overrides.diff ?? DIAGNOSTIC_PROPOSAL_DIFF;
  return {
    repo: repair.repo,
    origin: 'agent',
    kind: 'patch',
    title: 'Durable diagnostic repair proposal',
    summary: 'A complete generated repair proposal with matching receipt evidence.',
    status: 'pending',
    createdAt: event.ts,
    ...overrides,
    id: event.proposalId,
    diff,
    diffHash: hashDiff(diff),
    workItemId: repair.id,
    workItemGenerationId: generatedRepairGenerationId(repair)!,
    workSource: 'self',
    runId: event.runId,
    trajectoryId: event.trajectoryId,
    runEventSummary: {
      ...event.runEventSummary,
      ...overrides.runEventSummary,
      runId: event.runId,
      proposalId: event.proposalId,
    },
  };
}

function recordDiagnosticProposal(
  repair: WorkItem,
  attemptId: string,
  proposalId: string,
  ts?: string,
) {
  const event = diagnosticProposalEvent(repair, attemptId, proposalId, ts);
  mkdirSync(inboxDir(), { recursive: true });
  writeJson(
    join(inboxDir(), `${proposalId}.json`),
    diagnosticProposalForEvent(repair, event),
  );
  expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
  return recordGeneratedRepairLifecycle(repair, {
    kind: 'proposal-created',
    attemptId: event.trajectoryId!,
    proposalId,
    ts: event.ts,
  });
}

describe('queued autonomy work scanner', () => {
  it('reports missing queue files as a complete empty observation', () => {
    expect(loadQueuedAutonomyItemsDetailed()).toEqual({
      items: [],
      sourceState: 'complete',
      filesPresent: 0,
      filesMissing: 2,
      filesUnavailable: 0,
      rowsScanned: 0,
      itemsLoaded: 0,
      limitExceeded: false,
    });
  });

  it('reports unavailable rather than reading a mixed snapshot when the queue lock is held', () => {
    mkdirSync(fx.ashlrDir, { recursive: true });
    const lock = acquireLocalStoreLock(join(fx.ashlrDir, '.self-heal-queue.lock'));
    expect(lock).not.toBeNull();
    try {
      expect(loadQueuedAutonomyItemsDetailed()).toMatchObject({
        items: [],
        sourceState: 'unavailable',
        filesUnavailable: 2,
      });
    } finally {
      if (lock) releaseLocalStoreLock(lock);
    }
  });

  it('strictly loads a complete bounded corpus and preserves queue semantics', () => {
    const repo = fx.makeRepo();
    const duplicate = item(repo.dir, 'invent-duplicate');
    const ignored = item(repo.dir, 'todo-ignored', { source: 'todo', tags: ['todo'] });
    writeJson(join(fx.ashlrDir, 'self-heal-queue.json'), [duplicate]);
    writeJson(join(fx.ashlrDir, 'backlog.json'), { items: [duplicate, ignored] });

    const result = loadQueuedAutonomyItemsDetailed();

    expect(result).toMatchObject({
      sourceState: 'complete',
      filesPresent: 2,
      filesMissing: 0,
      filesUnavailable: 0,
      rowsScanned: 3,
      itemsLoaded: 1,
      limitExceeded: false,
    });
    expect(result.items.map((candidate) => candidate.id)).toEqual([duplicate.id]);
  });

  it('canonicalizes accepted rows so unknown fields cannot enter backlog metadata', () => {
    const repo = fx.makeRepo();
    const withUnknown = { ...item(repo.dir, 'canonical-row'), secret: 'RAW_QUEUE_CANARY' };
    writeJson(join(fx.ashlrDir, 'self-heal-queue.json'), [withUnknown]);

    const result = loadQueuedAutonomyItemsDetailed();

    expect(result.sourceState).toBe('complete');
    expect(result.items).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('RAW_QUEUE_CANARY');
    expect(result.items[0]).not.toHaveProperty('secret');
  });

  it('fails the detailed read closed for symlinks and non-regular files', () => {
    const queuePath = join(fx.ashlrDir, 'self-heal-queue.json');
    const targetPath = join(fx.ashlrDir, 'target.json');
    mkdirSync(fx.ashlrDir, { recursive: true });
    writeFileSync(targetPath, '[]', 'utf8');
    symlinkSync(targetPath, queuePath);

    expect(loadQueuedAutonomyItemsDetailed()).toMatchObject({
      items: [],
      sourceState: 'unavailable',
      filesUnavailable: 1,
    });

    rmSync(queuePath);
    mkdirSync(queuePath);
    expect(loadQueuedAutonomyItemsDetailed()).toMatchObject({
      items: [],
      sourceState: 'unavailable',
      filesUnavailable: 1,
    });
  });

  it.runIf(process.platform !== 'win32')('fails the detailed read closed for unreadable files', () => {
    const queuePath = join(fx.ashlrDir, 'self-heal-queue.json');
    mkdirSync(fx.ashlrDir, { recursive: true });
    writeFileSync(queuePath, '[]', { encoding: 'utf8', mode: 0o000 });
    chmodSync(queuePath, 0o000);

    const result = loadQueuedAutonomyItemsDetailed();

    expect(result).toMatchObject({
      items: [],
      sourceState: 'unavailable',
      filesUnavailable: 1,
    });
  });

  it.runIf(process.platform !== 'win32')('fails the detailed read closed for hard links and unsafe write permissions', () => {
    const queuePath = join(fx.ashlrDir, 'self-heal-queue.json');
    const linkedPath = join(fx.ashlrDir, 'linked-queue.json');
    mkdirSync(fx.ashlrDir, { recursive: true });
    writeFileSync(queuePath, '[]', { encoding: 'utf8', mode: 0o600 });
    linkSync(queuePath, linkedPath);

    expect(loadQueuedAutonomyItemsDetailed()).toMatchObject({
      items: [],
      sourceState: 'unavailable',
      filesUnavailable: 1,
    });

    rmSync(linkedPath);
    chmodSync(queuePath, 0o622);
    expect(loadQueuedAutonomyItemsDetailed()).toMatchObject({
      items: [],
      sourceState: 'unavailable',
      filesUnavailable: 1,
    });
  });

  it('fails the detailed read closed without exposing malformed or invalid content', () => {
    const queuePath = join(fx.ashlrDir, 'self-heal-queue.json');
    const secret = 'DO_NOT_EXPOSE_QUEUED_AUTONOMY_CONTENT';
    mkdirSync(fx.ashlrDir, { recursive: true });
    const invalidSources = [
      `{${secret}`,
      JSON.stringify({ payload: secret }),
      JSON.stringify([item(fx.home, 'valid'), { secret }]),
      '[{"id":"","repo":"/tmp/repo","source":"invent","title":"","detail":"","value":1e400,"effort":1,"score":1,"tags":[],"ts":"now"}]',
      JSON.stringify([{ ...item(fx.home, 'relative-repo'), repo: 'relative/repo' }]),
      JSON.stringify([{ ...item(fx.home, 'invalid-time'), ts: 'not-a-time' }]),
      JSON.stringify([{ ...item(fx.home, 'oversized-title'), title: 'x'.repeat(241) }]),
      JSON.stringify([{
        ...item(fx.home, 'invent-with-repair-lineage'),
        repairHandoffId: 'handoff',
        repairGenerationId: 'generation',
      }]),
    ];

    for (const contents of invalidSources) {
      writeFileSync(queuePath, contents, 'utf8');
      const result = loadQueuedAutonomyItemsDetailed();
      expect(result).toMatchObject({
        items: [],
        sourceState: 'unavailable',
        filesUnavailable: 1,
        itemsLoaded: 0,
      });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(result).not.toHaveProperty('reason');
    }
  });

  it('bounds strict reads and reports only limit metadata', () => {
    const queuePath = join(fx.ashlrDir, 'self-heal-queue.json');
    mkdirSync(fx.ashlrDir, { recursive: true });
    writeFileSync(queuePath, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));

    expect(loadQueuedAutonomyItemsDetailed()).toEqual({
      items: [],
      sourceState: 'unavailable',
      filesPresent: 1,
      filesMissing: 1,
      filesUnavailable: 1,
      rowsScanned: 0,
      itemsLoaded: 0,
      limitExceeded: true,
    });
  });

  it('keeps the tolerant legacy loader behavior for invalid rows and containers', () => {
    const valid = item(fx.home, 'legacy-valid');
    writeJson(join(fx.ashlrDir, 'self-heal-queue.json'), [valid, { id: 'invalid' }]);
    writeJson(join(fx.ashlrDir, 'backlog.json'), { payload: [item(fx.home, 'ignored-container')] });

    expect(loadQueuedAutonomyItems().map((candidate) => candidate.id)).toEqual([valid.id]);
    expect(loadQueuedAutonomyItemsDetailed()).toMatchObject({
      items: [],
      sourceState: 'unavailable',
      filesUnavailable: 2,
      itemsLoaded: 0,
    });
  });

  it('keeps a valid repair queue selectable when the legacy backlog is malformed', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const heal = item(repo.dir, 'repair-survives-malformed-backlog', {
      source: 'self',
      title: 'Repair failing autonomous daemon verification: src/daemon.ts(4,1): error TS2304',
      detail: 'Self-heal: build is RED.\nFirst failure: src/daemon.ts(4,1): error TS2304: Cannot find name daemon.',
      tags: ['self-heal', 'verify', 'build'],
    });
    writeJson(join(fx.ashlrDir, 'self-heal-queue.json'), [heal]);
    writeJson(join(fx.ashlrDir, 'backlog.json'), {
      items: [item(repo.dir, 'oversized-legacy-goal', { source: 'goal', title: 'x'.repeat(241) })],
    });

    const detailed = loadQueuedAutonomyItemsDetailed();
    const found = await scanQueuedAutonomyWork(repo.dir);

    expect(detailed).toMatchObject({
      sourceState: 'unavailable',
      filesUnavailable: 1,
      itemsLoaded: 1,
    });
    expect(detailed.items.map((candidate) => candidate.id)).toEqual([heal.id]);
    expect(found.map((candidate) => candidate.id)).toEqual([heal.id]);
  });

  it('rehydrates self-heal and invent items for the scanned enrolled repo only', async () => {
    const repo = fx.makeRepo();
    const otherRepo = fx.makeRepo();
    repo.enroll();
    otherRepo.enroll();

    const heal = item(repo.dir, 'heal-1', {
      source: 'self',
      title: 'Fix broken build in repo: src/index.ts(12,5): error TS2345',
      detail: "Self-heal: build is RED.\nFirst failure: src/index.ts(12,5): error TS2345: Argument of type 'string' is not assignable.",
      tags: ['self-heal', 'verify', 'build'],
    });
    const invent = item(repo.dir, 'invent-1');
    const wrongRepo = item(otherRepo.dir, 'invent-other');
    const lowSignal = item(repo.dir, 'todo-1', { source: 'todo', tags: ['todo'] });

    writeJson(join(fx.ashlrDir, 'self-heal-queue.json'), [heal, wrongRepo]);
    writeJson(join(fx.ashlrDir, 'backlog.json'), {
      generatedAt: '2026-07-02T00:00:00.000Z',
      repos: [repo.dir, otherRepo.dir],
      items: [invent, lowSignal],
    });

    const found = await scanQueuedAutonomyWork(repo.dir);

    expect(found.map((x) => x.id)).toEqual(['heal-1', 'invent-1']);
  });

  it('preserves queued autonomy items through a full backlog refresh', async () => {
    const repo = fx.makeRepo();
    repo.enroll();

    const heal = item(repo.dir, 'heal-build-1', {
      source: 'self',
      title: 'Repair failing autonomous daemon verification: src/daemon.ts(4,1): error TS2304',
      detail: 'Self-heal: build is RED.\nFirst failure: src/daemon.ts(4,1): error TS2304: Cannot find name daemon.',
      tags: ['self-heal', 'daemon'],
    });
    const invent = item(repo.dir, 'invent-build-1', {
      title: 'Add autonomous work selection telemetry',
      tags: ['generative', 'selection'],
    });

    writeJson(join(fx.ashlrDir, 'self-heal-queue.json'), [heal]);
    writeJson(join(fx.ashlrDir, 'backlog.json'), {
      generatedAt: '2026-07-02T00:00:00.000Z',
      repos: [repo.dir],
      items: [invent],
    });

    const backlog = await buildBacklog({
      repos: [repo.dir],
      minItemValue: 2,
      cfg: { foundry: { feedbackEnabled: false } },
      listPendingProposals: () => [],
    });

    expect(backlog.items.some((x) => x.id === 'heal-build-1')).toBe(true);
    expect(backlog.items.some((x) => x.id === 'invent-build-1')).toBe(true);
  });

  it('drops queued self-heal items that only contain toolchain or lifecycle noise', async () => {
    const repo = fx.makeRepo();
    repo.enroll();

    const actionable = item(repo.dir, 'heal-actionable', {
      source: 'self',
      title: 'Fix broken build in repo: src/__tests__/capability-registry.test.ts(256,39): error TS2769',
      detail: 'Self-heal: build is RED.\nFirst failure: src/__tests__/capability-registry.test.ts(256,39): error TS2769: No overload matches this call.',
      tags: ['self-heal', 'build'],
    });
    const banner = item(repo.dir, 'heal-banner', {
      source: 'self',
      title: 'Fix broken build in 10:4: > clipbridge-relay@0.1.0 check',
      detail: 'Self-heal: build is RED.\nFirst failure: > clipbridge-relay@0.1.0 check',
      tags: ['self-heal', 'build'],
    });
    const rustup = item(repo.dir, 'heal-rustup', {
      source: 'self',
      title: "Fix broken build in ashlr-pulse: error: rustup could not choose a version of cargo to run, because one wasn't specified explicitly, and no default is configured.",
      detail: "Self-heal: build is RED.\nFirst failure: error: rustup could not choose a version of cargo to run, because one wasn't specified explicitly, and no default is configured.",
      tags: ['self-heal', 'build'],
    });
    const cargoProgress = item(repo.dir, 'heal-cargo-progress', {
      source: 'self',
      title: 'Fix broken build in phantom-secrets: Downloaded thiserror v2.0.18',
      detail: 'Self-heal: build is RED.\nFirst failure: Downloaded thiserror v2.0.18',
      tags: ['self-heal', 'build'],
    });
    const missingTool = item(repo.dir, 'heal-missing-tool', {
      source: 'self',
      title: `Fix broken build in binshield: Error: Cannot find module '${repo.dir}/node_modules/typescript/bin/tsc'`,
      detail: `Self-heal: build is RED.\nFirst failure: Error: Cannot find module '${repo.dir}/node_modules/typescript/bin/tsc'`,
      tags: ['self-heal', 'build'],
    });

    writeJson(join(fx.ashlrDir, 'self-heal-queue.json'), [
      actionable,
      banner,
      rustup,
      cargoProgress,
      missingTool,
    ]);

    const found = await scanQueuedAutonomyWork(repo.dir);

    expect(found.map((x) => x.id)).toEqual(['heal-actionable']);
  });

  it('queues metadata-only repair work for partial or failed-verify proposals idempotently', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const proposal = partialProposal(repo.dir, {
      verifyResult: {
        passed: false,
        detail: 'capture gate blocked proposal after test failure in src/app.ts:12: expected github_pat_1234567890abcdefghijklmnop to be absent',
        source: 'capture-gate',
      },
    });

    const first = queueProposalRepairWorkForPendingProposals([proposal]);
    const second = queueProposalRepairWorkForPendingProposals([proposal]);
    const rawQueue = JSON.parse(readFileSync(join(fx.ashlrDir, 'self-heal-queue.json'), 'utf8')) as WorkItem[];
    const found = await scanQueuedAutonomyWork(repo.dir);

    expect(first).toMatchObject({ scanned: 1, eligible: 1, queued: 1, failed: 0 });
    expect(second).toMatchObject({ scanned: 1, eligible: 1, queued: 1, failed: 0 });
    expect(rawQueue).toHaveLength(1);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      repo: repo.dir,
      source: 'self',
      tags: expect.arrayContaining(['self-heal', 'proposal-repair', 'partial', 'verify']),
    });
    expect(found[0]!.detail).toContain(proposal.id);
    expect(found[0]!.detail).toContain(proposal.workItemId);
    expect(found[0]!.detail).not.toContain('DO_NOT_COPY_DIFF');
    expect(found[0]!.detail).not.toContain('github_pat_1234567890abcdefghijklmnop');
    expect(found[0]!.detail).toContain('[REDACTED]');
    expect(found[0]!.ts).toBe(proposal.createdAt);
  });

  it('authorizes only the exact complete failed-verification proposal repair', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const input = partialProposal(repo.dir, {
      isPartial: false,
      verifyResult: { passed: false, detail: 'typecheck failed' },
    });
    const { id: _id, status: _status, createdAt: _createdAt, ...proposalInput } = input;
    const created = createProposal(proposalInput);
    const repair = proposalRepairWorkItem(created);
    expect(repair).not.toBeNull();
    if (!repair) throw new Error('expected proposal repair');

    expect(isVerifiedFailureProposalRepairAuthorized(repair)).toBe(true);
    expect(isVerifiedFailureProposalRepairAuthorized({ ...repair, id: `${repair.id}-tampered` })).toBe(false);
    expect(isVerifiedFailureProposalRepairAuthorized({ ...repair, tags: [...repair.tags, 'partial'] })).toBe(false);
  });

  it('recovers a recent rejected capture artifact without reopening or copying it', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const now = new Date(Date.now() - 60_000);
    const createdAt = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const proposal = partialProposal(repo.dir, {
      status: 'rejected',
      createdAt,
      runId: 'attempt-12345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-12345678-1234-4123-8123-123456789abc',
      diffHash: undefined,
      provenanceSig: undefined,
      decisionReason: 'auto-drained: permanent readiness blocker persisted for 3 pass(es): known verification failure',
    });
    (proposal as unknown as Record<string, unknown>)['stuckPassCount'] = 3;

    const first = queueProposalRepairWorkForPendingProposals([proposal], now);
    const second = queueProposalRepairWorkForPendingProposals([proposal], now);
    const found = await scanQueuedAutonomyWork(repo.dir);

    expect(first).toMatchObject({ scanned: 1, eligible: 1, queued: 1, failed: 0 });
    expect(second).toMatchObject({ scanned: 1, eligible: 1, queued: 1, failed: 0 });
    expect(proposal.status).toBe('rejected');
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain('Produce a fresh complete fix');
    expect(found[0]!.detail).not.toContain('DO_NOT_COPY_DIFF');
  });

  it('recovers a machine-rejected persistence mismatch from the durable store', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const input = partialProposal(repo.dir, {
      runId: 'attempt-22345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-22345678-1234-4123-8123-123456789abc',
      diffHash: undefined,
      provenanceSig: undefined,
    });
    const { id: _id, status: _status, createdAt: _createdAt, ...proposalInput } = input;
    const created = createProposal(proposalInput);
    expect(setStatus(
      created.id,
      'rejected',
      PROPOSAL_PERSISTENCE_MISMATCH_RESULT,
      PROPOSAL_PERSISTENCE_MISMATCH_REASON,
    )).toBe(true);
    const proposal = loadProposal(created.id);
    expect(proposal).toMatchObject({
      status: 'rejected',
      result: PROPOSAL_PERSISTENCE_MISMATCH_RESULT,
      decisionReason: PROPOSAL_PERSISTENCE_MISMATCH_REASON,
      decidedAt: expect.any(String),
    });
    // The proposal-local exact machine marker is atomic with rejection. A
    // best-effort causal-ledger outage must not strand the captured diff.
    rmSync(decisionsDir(), { recursive: true, force: true });

    expect(queueProposalRepairWorkForPendingProposals(
      undefined,
      new Date(Date.parse(created.createdAt) + 60_000),
    )).toMatchObject({
      scanned: 1,
      eligible: 1,
      queued: 1,
    });
    const found = await scanQueuedAutonomyWork(repo.dir);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).not.toContain('DO_NOT_COPY_DIFF');
  });

  it('persists physical proposal repo identity and rejects legacy alias authority', () => {
    if (process.platform === 'win32') {
      _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, {
        runner: semanticPrivateStorageRunner,
      });
    }
    try {
      const repo = fx.makeRepo();
      const canonicalRepo = realpathSync.native(repo.dir);
      const nested = join(repo.dir, 'identity-probe');
      const lexicalAlias = join(nested, '..');
      const linkedAlias = join(fx.home, 'proposal-repo-alias');
      mkdirSync(nested);
      symlinkSync(canonicalRepo, linkedAlias, process.platform === 'win32' ? 'junction' : 'dir');

      const createForRepo = (repoPath: string, title: string) => {
        const candidate = partialProposal(repoPath, { title, diffHash: undefined });
        const { id: _id, status: _status, createdAt: _createdAt, ...input } = candidate;
        return createProposal(input);
      };
      const lexical = createForRepo(lexicalAlias, 'Lexical repo alias proposal');
      const linked = createForRepo(linkedAlias, 'Linked repo alias proposal');

      expect(lexical.repo).toBe(canonicalRepo);
      expect(linked.repo).toBe(canonicalRepo);
      expect(loadProposal(lexical.id)?.repo).toBe(canonicalRepo);
      expect(loadProposal(linked.id)?.repo).toBe(canonicalRepo);

      const linkedPath = join(fx.ashlrDir, 'inbox', `${linked.id}.json`);
      const persisted = JSON.parse(readFileSync(linkedPath, 'utf8')) as Proposal;
      expect(persisted.repo).toBe(canonicalRepo);

      writeFileSync(linkedPath, JSON.stringify({ ...persisted, repo: linkedAlias }, null, 2) + '\n', 'utf8');
      expect(loadProposal(linked.id)).toBeNull();
      expect((JSON.parse(readFileSync(linkedPath, 'utf8')) as Proposal).repo).toBe(linkedAlias);
    } finally {
      if (process.platform === 'win32') {
        _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, undefined);
      }
    }
  });

  it('does not derive or journal repair authority from an invalid raw repo identity', () => {
    const secret = 'github_pat_1234567890abcdefghijklmnop';
    const invalid = captureFailure(join(fx.home, `token=${secret}`), {
      runId: 'attempt-32345678-1234-4123-8123-123456789abc',
    });

    expect(repairHandoffFromDispatchEvent(invalid)).toBeNull();
    expect(recordRepairHandoffs(invalid, {
      schemaVersion: 2,
      activation: { id: '22222222-2222-4222-8222-222222222222', activatedAt: '2020-01-01T00:00:00.000Z' },
    })).toEqual({ attempted: 0, recorded: 0, failed: 0 });
    expect(readRepairHandoffs().observations).toEqual([]);
  });

  it('revokes queued mismatch recovery before a later human rejection succeeds', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mkdirSync(join(repo.dir, 'subdir'));
    const noncanonicalRepo = join(repo.dir, 'subdir', '..');
    const input = partialProposal(noncanonicalRepo, {
      runId: 'attempt-32345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-32345678-1234-4123-8123-123456789abc',
    });
    const { id: _id, status: _status, createdAt: _createdAt, ...proposalInput } = input;
    const created = createProposal(proposalInput);
    expect(setStatus(
      created.id,
      'rejected',
      PROPOSAL_PERSISTENCE_MISMATCH_RESULT,
      PROPOSAL_PERSISTENCE_MISMATCH_REASON,
    )).toBe(true);
    const now = new Date(Date.parse(created.createdAt) + 60_000);
    expect(queueProposalRepairWorkForPendingProposals(undefined, now)).toMatchObject({
      scanned: 1,
      eligible: 1,
      queued: 1,
    });
    const queued = await scanQueuedAutonomyWork(repo.dir);
    expect(queued).toHaveLength(1);
    expect(isRejectedCaptureRecoveryAuthorized(queued[0]!, now)).toBe(true);
    expect(setStatus(created.id, 'rejected')).toBe(true);
    const proposal = loadProposal(created.id);
    expect(proposal).not.toBeNull();
    expect(proposal?.result).toBeUndefined();
    expect(proposal?.decisionReason).toBeUndefined();
    expect(await scanQueuedAutonomyWork(repo.dir)).toEqual([]);

    expect(queueProposalRepairWorkForPendingProposals(undefined, now)).toMatchObject({
      scanned: 0,
      eligible: 0,
      queued: 0,
    });
    expect(await scanQueuedAutonomyWork(repo.dir)).toEqual([]);
  });

  it('recovers a legacy mismatch only with one bound durable rejection decision', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const input = partialProposal(repo.dir, {
      runId: 'attempt-42345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-42345678-1234-4123-8123-123456789abc',
    });
    const { id: _id, status: _status, createdAt: _createdAt, ...proposalInput } = input;
    const created = createProposal(proposalInput);
    expect(setStatus(created.id, 'rejected', PROPOSAL_PERSISTENCE_MISMATCH_RESULT)).toBe(true);
    const proposal = loadProposal(created.id);
    expect(proposal).not.toBeNull();

    expect(queueProposalRepairWorkForPendingProposals(
      undefined,
      new Date(Date.parse(created.createdAt) + 60_000),
    )).toMatchObject({ scanned: 1, eligible: 1, queued: 1 });
    expect(setStatus(
      created.id,
      'rejected',
      PROPOSAL_PERSISTENCE_MISMATCH_RESULT,
    )).toBe(true);
    expect(await scanQueuedAutonomyWork(repo.dir)).toHaveLength(1);
  });

  it('makes human rejection authoritative when queue cleanup is unavailable', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const input = partialProposal(repo.dir, {
      runId: 'attempt-52345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-52345678-1234-4123-8123-123456789abc',
    });
    const { id: _id, status: _status, createdAt: _createdAt, ...proposalInput } = input;
    const created = createProposal(proposalInput);
    expect(setStatus(
      created.id,
      'rejected',
      PROPOSAL_PERSISTENCE_MISMATCH_RESULT,
      PROPOSAL_PERSISTENCE_MISMATCH_REASON,
    )).toBe(true);
    expect(queueProposalRepairWorkForPendingProposals(
      undefined,
      new Date(Date.parse(created.createdAt) + 60_000),
    )).toMatchObject({ queued: 1 });
    const queueLock = acquireLocalStoreLock(join(fx.ashlrDir, '.self-heal-queue.lock'));
    expect(queueLock).not.toBeNull();
    try {
      expect(setStatus(created.id, 'rejected')).toBe(true);
    } finally {
      if (queueLock) releaseLocalStoreLock(queueLock);
    }
    expect(loadProposal(created.id)).toMatchObject({ status: 'rejected' });
    expect(loadProposal(created.id)?.decisionReason).toBeUndefined();
    const stale = await scanQueuedAutonomyWork(repo.dir);
    expect(stale).toHaveLength(1);
    expect(isRejectedCaptureRecoveryAuthorized(stale[0]!)).toBe(false);
  });

  it('revokes auto-drained recovery authority even when queue cleanup is unavailable', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const input = partialProposal(repo.dir, {
      runId: 'attempt-62345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-62345678-1234-4123-8123-123456789abc',
      stuckPassCount: 3,
    });
    const { id: _id, status: _status, createdAt: _createdAt, ...proposalInput } = input;
    const created = createProposal(proposalInput);
    expect(updateProposalField(created.id, { stuckPassCount: 3 })).toBe(true);
    expect(setStatus(
      created.id,
      'rejected',
      'auto-drained capture',
      'auto-drained: permanent readiness blocker persisted for 3 pass(es): known verification failure',
    )).toBe(true);
    const now = new Date(Date.parse(created.createdAt) + 60_000);
    expect(queueProposalRepairWorkForPendingProposals(undefined, now)).toMatchObject({ queued: 1 });

    const queueLock = acquireLocalStoreLock(join(fx.ashlrDir, '.self-heal-queue.lock'));
    expect(queueLock).not.toBeNull();
    try {
      expect(setStatus(created.id, 'rejected')).toBe(true);
    } finally {
      if (queueLock) releaseLocalStoreLock(queueLock);
    }

    const revoked = loadProposal(created.id);
    expect(revoked?.decisionReason).toBeUndefined();
    expect(revoked?.stuckPassCount).toBeUndefined();
    const stale = await scanQueuedAutonomyWork(repo.dir);
    expect(stale).toHaveLength(1);
    expect(isRejectedCaptureRecoveryAuthorized(stale[0]!, now)).toBe(false);
  });

  it('uses one repair identity for canonical and noncanonical repo paths', () => {
    const repo = fx.makeRepo();
    const noncanonical = join(repo.dir, 'subdir', '..');
    expect(proposalRepairId(noncanonical, 'prop-canonical')).toBe(
      proposalRepairId(repo.dir, 'prop-canonical'),
    );
  });

  it('expires materialized rejected-capture recovery after the bounded window', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const materializedAt = new Date(Date.now() - 60_000);
    const createdAt = new Date(materializedAt.getTime() - 60 * 60 * 1000).toISOString();
    vi.useFakeTimers();
    vi.setSystemTime(materializedAt);
    const proposal = partialProposal(repo.dir, {
      status: 'rejected',
      createdAt,
      runId: 'attempt-32345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-32345678-1234-4123-8123-123456789abc',
      decisionReason: 'auto-drained: permanent readiness blocker persisted for 2 pass(es): known verification failure',
    });
    (proposal as unknown as Record<string, unknown>)['stuckPassCount'] = 2;
    queueProposalRepairWorkForPendingProposals([proposal], materializedAt);
    expect(await scanQueuedAutonomyWork(repo.dir)).toHaveLength(1);

    const expiredAt = new Date(Date.parse(createdAt) + 48 * 60 * 60 * 1000 + 1);
    vi.setSystemTime(expiredAt);
    const expired = queueProposalRepairWorkForPendingProposals([], expiredAt);

    expect(expired.dispatchRepairPruned).toBe(1);
    expect(await scanQueuedAutonomyWork(repo.dir)).toEqual([]);
  });

  it('rejects stale, human, unbound, empty, and non-capture rejected artifacts', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const now = new Date('2026-07-12T12:00:00.000Z');
    const bound = {
      status: 'rejected' as const,
      createdAt: '2026-07-12T11:00:00.000Z',
      runId: 'attempt-12345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-12345678-1234-4123-8123-123456789abc',
    };
    const proposals = [
      partialProposal(repo.dir, {
        ...bound,
        id: 'human',
        origin: 'agent',
        decidedAt: '2026-07-12T11:05:00.000Z',
        decisionReason: 'human rejected this artifact',
      }),
      partialProposal(repo.dir, { ...bound, id: 'unbound', trajectoryId: 'run:other' }),
      partialProposal(repo.dir, { ...bound, id: 'empty', diff: '' }),
      partialProposal(repo.dir, {
        ...bound,
        id: 'judge-rejected',
        verifyResult: { passed: false, detail: 'judge rejected', source: 'judge' },
      }),
      partialProposal(repo.dir, {
        ...bound,
        id: 'late-persistence-mismatch',
        result: 'proposal persistence verification failed',
        decidedAt: '2026-07-12T11:02:00.000Z',
      }),
      partialProposal(repo.dir, {
        ...bound,
        id: 'malformed-persistence-mismatch-time',
        result: 'proposal persistence verification failed',
        decidedAt: 'not-a-timestamp',
      }),
      partialProposal(repo.dir, { ...bound, id: 'stale', createdAt: '2026-07-09T11:00:00.000Z' }),
    ];

    expect(queueProposalRepairWorkForPendingProposals(proposals, now)).toMatchObject({
      scanned: 0,
      eligible: 0,
      queued: 0,
    });
    expect(await scanQueuedAutonomyWork(repo.dir)).toEqual([]);
  });

  it('applies the terminal lifecycle to ordinary pending-proposal repairs', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const proposal = partialProposal(repo.dir, { createdAt: '2026-07-10T14:00:00.000Z' });
    queueProposalRepairWorkForPendingProposals([proposal], new Date('2026-07-10T15:00:00.000Z'));
    const repair = (await scanQueuedAutonomyWork(repo.dir))[0]!;
    expect(recordDiagnosticProposal(
      repair,
      'attempt-12345678-1234-4123-8123-123456789abc',
      'prop-complete-repair',
    )).toMatchObject({ recorded: true, disposition: 'retired' });

    const result = queueProposalRepairWorkForPendingProposals(
      [proposal],
      new Date('2026-07-10T15:01:00.000Z'),
    );

    expect(result).toMatchObject({
      proposalQueued: 0,
      dispatchRepairRetired: 1,
      dispatchRepairPruned: 1,
    });
    expect(await scanQueuedAutonomyWork(repo.dir)).toEqual([]);
  });

  it('queues metadata-only repair work for self capture-gate failures idempotently', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const now = new Date();
    const recent = new Date(now.getTime() - 60_000).toISOString();
    const older = new Date(now.getTime() - 120_000).toISOString();
    const event = captureFailure(repo.dir, {
      ts: recent,
      runId: 'run-capture-new',
      reason: 'proposal-capture-error: failed after stdout=DO_NOT_COPY_STDOUT; src/app.ts:12 expected ready state token=github_pat_1234567890abcdefghijklmnop',
      outcome: 'proposal-capture-error',
      diffFiles: 3,
      diffLines: 44,
    });
    const duplicateOlderEvent = captureFailure(repo.dir, {
      ts: older,
      runId: 'run-capture-old',
      reason: 'proposal-capture-error: src/old.ts:5 expected stale state',
      outcome: 'proposal-capture-error',
      diffFiles: 1,
      diffLines: 9,
    });
    const gateEvent = captureFailure(repo.dir, {
      ts: recent,
      itemId: 'repo:self:gate-capture',
      runId: 'run-gate-capture',
      outcome: 'gate-blocked',
      reason: 'completeness gate blocked proposal: src/gate.ts:9 expected ready state',
      runEventSummary: {
        actionCounts: {
          completenessGateRuns: 1,
          proposalBlocked: 1,
          diffFiles: 1,
          diffLines: 6,
        },
      },
    });

    const first = queueProposalRepairWorkForPendingProposals(undefined, now, {
      dispatchEvents: [duplicateOlderEvent, event, gateEvent],
    });
    const second = queueProposalRepairWorkForPendingProposals(undefined, now, {
      dispatchEvents: [duplicateOlderEvent, event, gateEvent],
    });
    const rawQueue = JSON.parse(readFileSync(join(fx.ashlrDir, 'self-heal-queue.json'), 'utf8')) as WorkItem[];
    const found = await scanQueuedAutonomyWork(repo.dir);
    const captureRepair = found.find((item) => item.detail.includes(event.itemId));
    const gateRepair = found.find((item) => item.detail.includes(gateEvent.itemId));

    expect(first).toMatchObject({
      scanned: 3,
      eligible: 2,
      queued: 2,
      failed: 0,
      dispatchCaptureScanned: 3,
      dispatchCaptureEligible: 2,
      dispatchCaptureQueued: 2,
      dispatchCaptureFailed: 0,
    });
    expect(second).toMatchObject({ scanned: 3, eligible: 2, queued: 2, failed: 0 });
    expect(rawQueue).toHaveLength(2);
    expect(found).toHaveLength(2);
    expect(captureRepair).toMatchObject({
      repo: repo.dir,
      source: 'self',
      tags: expect.arrayContaining(['self-heal', 'proposal-repair', 'dispatch-capture-repair', 'capture-gate', 'verify', 'high-priority']),
    });
    expect(captureRepair!.id).toContain(':proposal-repair-capture:');
    expect(captureRepair!.id).not.toContain(event.reason!);
    expect(captureRepair!.detail).toContain(event.itemId);
    expect(captureRepair!.detail).toContain('run-capture-new');
    expect(captureRepair!.detail).not.toContain('run-capture-old');
    expect(captureRepair!.detail).toContain('proposal-capture-error');
    expect(captureRepair!.detail).not.toContain('DO_NOT_COPY_STDOUT');
    expect(captureRepair!.detail).not.toContain('github_pat_1234567890abcdefghijklmnop');
    expect(captureRepair!.detail).toContain('stdout=[omitted]');
    expect(gateRepair).toBeDefined();
    expect(gateRepair!.detail).toContain('gate-blocked');
  });

  it('queues capture repair for generic gate-blocked self dispatches with diff evidence', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const now = new Date();
    const recent = new Date(now.getTime() - 60_000).toISOString();
    const event = captureFailure(repo.dir, {
      ts: recent,
      itemId: 'repo:self:generic-gate-blocked',
      runId: 'run-generic-gate',
      outcome: 'gate-blocked',
      reason: 'tests: still failing after 2 attempt(s); stdout=DO_NOT_COPY_STDOUT; token=github_pat_1234567890abcdefghijklmnop',
      title: 'Repair changed-files test failure with github_pat_1234567890abcdefghijklmnop',
      diffFiles: 1,
      diffLines: 53,
    });

    const first = queueProposalRepairWorkForPendingProposals(undefined, now, {
      dispatchEvents: [event],
    });
    const rawQueue = JSON.parse(readFileSync(join(fx.ashlrDir, 'self-heal-queue.json'), 'utf8')) as WorkItem[];
    const found = await scanQueuedAutonomyWork(repo.dir);

    expect(first).toMatchObject({
      scanned: 1,
      eligible: 1,
      queued: 1,
      failed: 0,
      dispatchCaptureScanned: 1,
      dispatchCaptureEligible: 1,
      dispatchCaptureQueued: 1,
      dispatchCaptureFailed: 0,
    });
    expect(rawQueue).toHaveLength(1);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      repo: repo.dir,
      source: 'self',
      tags: expect.arrayContaining(['self-heal', 'proposal-repair', 'dispatch-capture-repair', 'capture-gate', 'verify', 'high-priority']),
    });
    expect(found[0]!.detail).toContain('Original work item: repo:self:generic-gate-blocked');
    expect(found[0]!.detail).toContain('Original title: Repair changed-files test failure with [REDACTED]');
    expect(found[0]!.detail).toContain('Run: run-generic-gate');
    expect(found[0]!.detail).toContain('Dispatch outcome: gate-blocked');
    expect(found[0]!.detail).toContain('Diff metadata: files=1, lines=53');
    expect(found[0]!.detail).toContain('stdout=[omitted]');
    expect(found[0]!.detail).not.toContain('DO_NOT_COPY_STDOUT');
    expect(found[0]!.detail).not.toContain('github_pat_1234567890abcdefghijklmnop');
  });

  it('queues metadata-only diagnostic reslice work for no-diff dispatches idempotently', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const now = new Date();
    const recent = new Date(now.getTime() - 60_000).toISOString();
    const older = new Date(now.getTime() - 120_000).toISOString();
    const event = captureFailure(repo.dir, {
      ts: recent,
      itemId: 'repo:goal:no-diff',
      source: 'goal',
      runId: 'run-nodiff-new',
      outcome: 'empty-diff',
      reason: 'empty-diff: engine completed without file changes; stdout=DO_NOT_COPY_STDOUT; prompt=DO_NOT_COPY_PROMPT; token=github_pat_1234567890abcdefghijklmnop',
      routeReason: 'local-coder route with env=DO_NOT_COPY_ENV',
    });
    const duplicateOlderEvent = captureFailure(repo.dir, {
      ts: older,
      itemId: 'repo:goal:no-diff',
      source: 'goal',
      runId: 'run-nodiff-old',
      outcome: 'empty-diff',
      reason: 'empty-diff: older no diff reason',
    });

    const first = queueProposalRepairWorkForPendingProposals(undefined, now, {
      dispatchEvents: [duplicateOlderEvent, event],
    });
    const second = queueProposalRepairWorkForPendingProposals(undefined, now, {
      dispatchEvents: [duplicateOlderEvent, event],
    });
    const rawQueue = JSON.parse(readFileSync(join(fx.ashlrDir, 'self-heal-queue.json'), 'utf8')) as WorkItem[];
    const found = await scanQueuedAutonomyWork(repo.dir);
    const reslice = found.find((item) => item.tags.includes('dispatch-no-diff-reslice'));

    expect(first).toMatchObject({
      scanned: 2,
      eligible: 1,
      queued: 1,
      failed: 0,
      dispatchCaptureScanned: 2,
      dispatchCaptureEligible: 0,
      dispatchCaptureQueued: 0,
      dispatchCaptureFailed: 0,
      dispatchNoDiffScanned: 2,
      dispatchNoDiffEligible: 1,
      dispatchNoDiffQueued: 1,
      dispatchNoDiffFailed: 0,
    });
    expect(second).toMatchObject({ scanned: 2, eligible: 1, queued: 1, failed: 0 });
    expect(rawQueue).toHaveLength(1);
    expect(found).toHaveLength(1);
    expect(reslice).toMatchObject({
      repo: repo.dir,
      source: 'self',
      repairParentItemId: event.itemId,
      repairParentSource: 'goal',
      repairParentBackend: 'local-coder',
      repairParentTier: 'local',
      tags: expect.arrayContaining(['self-heal', 'proposal-repair', 'diagnostic-reslice', 'dispatch-no-diff-reslice', 'no-diff', 'verify', 'high-priority']),
    });
    expect(reslice!.id).toContain(':proposal-repair-nodiff:');
    expect(reslice!.id).not.toContain(event.reason!);
    expect(reslice!.detail).toContain(event.itemId);
    expect(reslice!.detail).toContain('Original title: Self improvement capture failure with useful work');
    expect(reslice!.detail).toContain('run-nodiff-new');
    expect(reslice!.detail).not.toContain('run-nodiff-old');
    expect(reslice!.detail).toContain('Dispatch outcome: empty-diff');
    expect(reslice!.detail).toContain('Action: reslice');
    expect(reslice!.detail).toContain('smallest complete edit');
    expect(reslice!.detail).toContain('without forcing');
    expect(reslice!.detail).not.toContain('must change repository files');
    expect(reslice!.detail).toContain('stdout=[omitted]');
    expect(reslice!.detail).toContain('prompt=[omitted]');
    expect(reslice!.detail).toContain('env=[omitted]');
    expect(reslice!.detail).not.toContain('DO_NOT_COPY');
    expect(reslice!.detail).not.toContain('github_pat_1234567890abcdefghijklmnop');
  });

  it('binds one repair descendant to its canonical root and refuses a child of that repair', () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const now = new Date('2026-07-10T13:00:00.000Z');
    const original = captureFailure(repo.dir, {
      ts: '2026-07-10T12:00:00.000Z',
      itemId: 'repo:goal:rooted-parent',
      source: 'goal',
      outcome: 'empty-diff',
      runId: 'run-rooted-parent',
      objectiveHash: createHash('sha256').update('rooted-parent').digest('hex'),
    });
    const parentRepair = noDiffResliceWorkItem(original, now);
    expect(parentRepair).toMatchObject({ repairDepth: 0, repairRootId: expect.stringMatching(/^[a-f0-9]{64}$/) });
    if (!parentRepair) throw new Error('expected rooted parent repair');
    const childEvent = captureFailure(repo.dir, {
      ts: '2026-07-10T12:30:00.000Z',
      itemId: parentRepair.id,
      source: 'self',
      outcome: 'empty-diff',
      runId: 'run-rooted-child',
      objectiveHash: workItemObjectiveHash(parentRepair),
      repairGenerationId: 'c'.repeat(64),
    });
    const child = noDiffResliceWorkItem(childEvent, now, parentRepair);

    expect(child).toMatchObject({
      repairRootId: parentRepair.repairRootId,
      repairDepth: 1,
      repairParentItemId: parentRepair.id,
    });
    expect(generatedRepairRootKey(child!)).toBe(generatedRepairRootKey(parentRepair));
    expect(noDiffResliceWorkItem({
      ...childEvent,
      itemId: child!.id,
      objectiveHash: workItemObjectiveHash(child!),
    }, now, child!)).toBeNull();
  });

  it('admits at most one active repair for a canonical repo/root across capture and no-diff producers', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const now = new Date('2026-07-10T13:00:00.000Z');
    const objectiveHash = createHash('sha256').update('shared-root').digest('hex');
    const capture = captureFailure(repo.dir, {
      ts: '2026-07-10T12:00:00.000Z',
      itemId: 'repo:self:shared-repair-root',
      outcome: 'proposal-capture-error',
      runId: 'run-shared-capture',
      objectiveHash,
    });
    const noDiff = captureFailure(repo.dir, {
      ts: '2026-07-10T12:01:00.000Z',
      itemId: capture.itemId,
      outcome: 'empty-diff',
      runId: 'run-shared-empty',
      objectiveHash,
    });

    const result = queueProposalRepairWorkForPendingProposals([], now, {
      dispatchEvents: [capture, noDiff],
    });
    const queued = await scanQueuedAutonomyWork(repo.dir);

    expect(result).toMatchObject({
      repairRootAdmissionConsidered: 2,
      repairRootAdmissionAdmitted: 1,
      repairRootAdmissionAlreadyActive: 1,
    });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ repairDepth: 0, repairRootId: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it('never turns a proposal emitted by generated repair work into another repair descendant', () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const proposal = partialProposal(repo.dir, {
      workItemId: 'repo:proposal-repair:source',
      workItemGenerationId: 'a'.repeat(64),
    });

    expect(proposalRepairWorkItem(proposal)).toBeNull();
  });

  it('assigns stable no-diff treatments and bounds target-localization instructions', () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const now = new Date('2026-07-10T13:00:00.000Z');
    const byTreatment = new Map<string, WorkItem>();
    for (let index = 0; index < 256 && byTreatment.size < 2; index++) {
      const candidate = captureFailure(repo.dir, {
        ts: '2026-07-10T12:00:00.000Z',
        itemId: `repo:goal:treatment-${index}`,
        source: 'goal',
        outcome: 'empty-diff',
        runId: `run-treatment-${index}`,
        objectiveHash: createHash('sha256').update(`objective-${index}`).digest('hex'),
        reason: 'stdout=DO_NOT_PERSIST_STDOUT; stderr=DO_NOT_PERSIST_STDERR; env=DO_NOT_PERSIST_ENV',
      });
      const item = noDiffResliceWorkItem(candidate, now);
      if (item?.repairTreatment) byTreatment.set(item.repairTreatment, item);
    }

    const baseline = byTreatment.get('baseline-reslice')!;
    const localized = byTreatment.get('target-localization')!;
    expect(repairTreatmentForUnitId(localized.repairTreatmentUnitId!)).toBe('target-localization');
    expect(repairTreatmentForUnitId(localized.repairTreatmentUnitId!)).toBe(localized.repairTreatment);
    expect(baseline.detail).not.toContain('exactly one target file or subsystem');
    expect(localized.detail).toContain('exactly one target file or subsystem');
    expect(localized.detail).toContain('bounded current-state evidence');
    expect(localized.detail.length).toBeLessThanOrEqual(4_000);
    expect(JSON.stringify([...byTreatment.values()])).not.toContain('DO_NOT_PERSIST');
  });

  it('resolves diagnostic children from fresh parent context without mutating durable work', () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const parent = item(repo.dir, 'repo:goal:current-parent', {
      source: 'goal',
      title: 'Implement the current scheduler recovery path',
      detail: 'Update src/scheduler.ts so abandoned leases are reclaimed safely.',
      tags: ['scheduler', 'reliability'],
    });
    const now = new Date();
    queueProposalRepairWorkForPendingProposals(undefined, now, {
      dispatchEvents: [captureFailure(repo.dir, {
        ts: now.toISOString(),
        itemId: parent.id,
        source: parent.source,
        title: 'Reslice stale historical title',
        backend: 'local-coder',
        tier: 'mid',
        runId: 'run-current-parent',
        outcome: 'empty-diff',
        objectiveHash: workItemObjectiveHash(parent)!,
      })],
    });
    const child = (JSON.parse(readFileSync(join(fx.ashlrDir, 'self-heal-queue.json'), 'utf8')) as WorkItem[])[0]!;
    const before = JSON.stringify([parent, child]);

    const result = resolveDiagnosticResliceParents([parent, child]);
    const resolved = result.dispatchable.find((candidate) => candidate.id === child.id)!;

    expect(result).toMatchObject({ resolved: 1, missing: 0, quarantined: [] });
    expect(resolved).toMatchObject({
      title: parent.title,
      repairParentItemId: parent.id,
      repairParentSource: 'goal',
      repairParentBackend: 'local-coder',
      repairParentTier: 'mid',
      repairParentObjectiveHash: workItemObjectiveHash(parent)!,
    });
    expect(resolved.detail).toContain(parent.title);
    expect(resolved.detail).toContain(parent.detail);
    expect(resolved.detail).not.toContain('stale context');
    expect(resolved.detail).not.toContain('must change repository files');
    expect(resolved.detail).toContain('without forcing a cosmetic change');
    expect(JSON.stringify([parent, child])).toBe(before);
  });

  it('scrubs and bounds the transient parent title used for repair dispatch', () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const secret = 'github_pat_1234567890abcdefghijklmnop';
    const parent = item(repo.dir, 'repo:goal:sensitive-parent', {
      source: 'goal',
      title: `Repair ${secret} ${'scheduler '.repeat(30)}`,
      detail: 'Recover abandoned scheduler leases.',
    });
    const now = new Date();
    queueProposalRepairWorkForPendingProposals(undefined, now, {
      dispatchEvents: [captureFailure(repo.dir, {
        ts: now.toISOString(),
        itemId: parent.id,
        source: parent.source,
        backend: 'local-coder',
        tier: 'mid',
        runId: 'run-sensitive-parent',
        outcome: 'empty-diff',
        objectiveHash: workItemObjectiveHash(parent)!,
      })],
    });
    const child = (JSON.parse(readFileSync(join(fx.ashlrDir, 'self-heal-queue.json'), 'utf8')) as WorkItem[])[0]!;

    const resolved = resolveDiagnosticResliceParents([parent, child]).dispatchable
      .find((candidate) => candidate.id === child.id)!;

    expect(resolved.title.length).toBeLessThanOrEqual(140);
    expect(resolved.title).not.toContain(secret);
    expect(resolved.title).toContain('[REDACTED]');
  });

  it('quarantines missing and provenance-less parents without deleting the child', () => {
    const repo = fx.makeRepo();
    const child = item(repo.dir, 'repo:proposal-repair-nodiff:123456abcdef', {
      source: 'self',
      title: 'Reslice missing parent',
      detail:
        'Diagnostic reslice: missing parent.\n' +
        'Original work item: repo:goal:missing\n' +
        'Dispatch outcome: empty-diff\n' +
        'Action: reslice the work into a smaller concrete edit.',
      tags: ['self-heal', 'proposal-repair', 'diagnostic-reslice', 'dispatch-no-diff-reslice'],
      repairParentItemId: 'repo:goal:missing',
      repairParentSource: 'goal',
      repairParentTier: 'mid',
    });
    const missing = resolveDiagnosticResliceParents([child]);
    expect(missing.dispatchable).toEqual([]);
    expect(missing.quarantined).toEqual([{ itemId: child.id, reason: 'parent-missing' }]);

    const parent = item(repo.dir, 'repo:goal:missing', { source: 'goal' });
    const legacy = { ...child, repairParentTier: null };
    const unknown = resolveDiagnosticResliceParents([parent, legacy]);
    expect(unknown.dispatchable).toEqual([parent]);
    expect(unknown.quarantined).toEqual([{ itemId: child.id, reason: 'parent-provenance-missing' }]);
    expect(legacy).toMatchObject({ repairParentTier: null });
  });

  it('quarantines a stale generation when the scanner reuses an id for changed objective meaning', () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const original = item(repo.dir, 'repo:goal:stable-id', {
      source: 'goal',
      title: 'Original objective',
      detail: 'Implement the original acceptance criteria.',
    });
    const changed = { ...original, title: 'Changed objective', detail: 'Different acceptance criteria now apply.' };
    const now = new Date();
    queueProposalRepairWorkForPendingProposals(undefined, now, {
      dispatchEvents: [captureFailure(repo.dir, {
        ts: now.toISOString(),
        itemId: original.id,
        source: original.source,
        title: original.title,
        backend: 'local-coder',
        tier: 'mid',
        runId: 'run-stable-parent',
        outcome: 'empty-diff',
        objectiveHash: workItemObjectiveHash(original)!,
      })],
    });
    const child = (JSON.parse(readFileSync(join(fx.ashlrDir, 'self-heal-queue.json'), 'utf8')) as WorkItem[])[0]!;

    const result = resolveDiagnosticResliceParents([changed, child]);

    expect(result.dispatchable).toEqual([changed]);
    expect(result.quarantined).toEqual([{ itemId: child.id, reason: 'parent-objective-changed' }]);
  });

  it('retires legacy diagnostic rows instead of granting fallback generation authority', () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const now = new Date('2026-07-10T16:00:00.000Z');
    const ordinary = item(repo.dir, 'ordinary-invent');
    const legacy = item(repo.dir, 'repo:proposal-repair-nodiff:1e9ac1234567', {
      source: 'self',
      title: 'Diagnostic reslice for a legacy parent',
      detail:
        'Diagnostic reslice: legacy parent.\n' +
        'Original work item: repo:goal:legacy-parent\n' +
        'Dispatch outcome: empty-diff\n' +
        'Action: reslice the work into a smaller concrete edit.',
      tags: ['self-heal', 'proposal-repair', 'diagnostic-reslice', 'dispatch-no-diff-reslice'],
      repairParentItemId: 'repo:goal:legacy-parent',
      repairParentSource: 'goal',
      repairParentBackend: 'local-coder',
      repairParentTier: 'mid',
    });
    writeJson(join(fx.ashlrDir, 'self-heal-queue.json'), [ordinary, legacy]);
    writeJson(join(fx.ashlrDir, 'backlog.json'), {
      generatedAt: now.toISOString(),
      repos: [repo.dir],
      items: [ordinary, legacy],
    });

    const result = queueProposalRepairWorkForPendingProposals(undefined, now, { dispatchEvents: [] });
    const queue = JSON.parse(readFileSync(join(fx.ashlrDir, 'self-heal-queue.json'), 'utf8')) as WorkItem[];
    const backlog = JSON.parse(readFileSync(join(fx.ashlrDir, 'backlog.json'), 'utf8')) as { items: WorkItem[] };

    expect(result).toMatchObject({ dispatchRepairPruned: 2, dispatchRepairPruneFailed: 0 });
    expect(queue.map((candidate) => candidate.id)).toEqual([ordinary.id]);
    expect(backlog.items.map((candidate) => candidate.id)).toEqual([ordinary.id]);
  });

  it('prunes exhausted repair generations while preserving unrelated queued work', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const now = new Date('2026-07-10T16:00:00.000Z');
    const sourceEvent = captureFailure(repo.dir, {
      ts: '2026-07-10T15:00:00.000Z',
      itemId: 'repo:goal:terminal-reslice',
      outcome: 'empty-diff',
      proposalCreated: false,
      backend: 'builtin',
      tier: 'mid',
      runId: 'run-source-empty',
      reason: 'engine completed without file changes',
    });
    queueProposalRepairWorkForPendingProposals(undefined, now, { dispatchEvents: [sourceEvent] });
    const repair = (await scanQueuedAutonomyWork(repo.dir)).find((candidate) =>
      candidate.tags.includes('dispatch-no-diff-reslice'),
    )!;
    const ordinary = item(repo.dir, 'ordinary-invent');
    const currentQueue = JSON.parse(readFileSync(join(fx.ashlrDir, 'self-heal-queue.json'), 'utf8')) as WorkItem[];
    writeJson(join(fx.ashlrDir, 'self-heal-queue.json'), [ordinary, ...currentQueue]);
    writeJson(join(fx.ashlrDir, 'backlog.json'), {
      generatedAt: now.toISOString(),
      repos: [repo.dir],
      items: [ordinary, repair],
    });

    recordDiagnosticEmpty(repair, 'attempt-12345678-1234-4123-8123-123456789abc', 'local-coder', 1);
    const active = queueProposalRepairWorkForPendingProposals(undefined, now, { dispatchEvents: [sourceEvent] });
    recordDiagnosticEmpty(repair, 'attempt-22345678-1234-4123-8123-123456789abc', 'kimi', 2);
    const terminal = queueProposalRepairWorkForPendingProposals(undefined, now, { dispatchEvents: [sourceEvent] });
    const remaining = JSON.parse(readFileSync(join(fx.ashlrDir, 'self-heal-queue.json'), 'utf8')) as WorkItem[];
    const remainingBacklog = JSON.parse(readFileSync(join(fx.ashlrDir, 'backlog.json'), 'utf8')) as { items: WorkItem[] };

    expect(active).toMatchObject({ dispatchRepairExhausted: 0, dispatchRepairPruned: 0 });
    expect(terminal).toMatchObject({
      dispatchRepairRetired: 0,
      dispatchRepairExhausted: 1,
      dispatchRepairPruned: 2,
      dispatchRepairPruneFailed: 0,
      dispatchNoDiffQueued: 0,
    });
    expect(remaining.map((candidate) => candidate.id)).toEqual(['ordinary-invent']);
    expect(remainingBacklog.items.map((candidate) => candidate.id)).toEqual(['ordinary-invent']);
  });

  it('prunes objective-saturated queue projections while retaining lifecycle evidence', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const now = new Date('2026-07-10T16:00:00.000Z');
    const sourceEvent = captureFailure(repo.dir, {
      ts: '2026-07-10T15:00:00.000Z',
      itemId: 'repo:goal:objective-saturated-reslice',
      source: 'goal',
      backend: 'local-coder',
      tier: 'mid',
      outcome: 'empty-diff',
      proposalCreated: false,
      runId: 'attempt-02345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-02345678-1234-4123-8123-123456789abc',
      reason: 'engine completed without file changes',
    });
    queueProposalRepairWorkForPendingProposals(undefined, now, { dispatchEvents: [sourceEvent] });
    const repair = (await scanQueuedAutonomyWork(repo.dir)).find((candidate) =>
      candidate.tags.includes('dispatch-no-diff-reslice'),
    )!;
    const ordinary = item(repo.dir, 'ordinary-preserved-next-to-quarantine');
    const currentQueue = JSON.parse(readFileSync(join(fx.ashlrDir, 'self-heal-queue.json'), 'utf8')) as WorkItem[];
    writeJson(join(fx.ashlrDir, 'self-heal-queue.json'), [ordinary, ...currentQueue]);
    writeJson(join(fx.ashlrDir, 'backlog.json'), {
      generatedAt: now.toISOString(), repos: [repo.dir], items: [ordinary, repair],
    });

    recordDiagnosticEmpty(repair, 'attempt-12345678-1234-4123-8123-123456789abc', 'local-coder', 1);
    expect(recordDiagnosticEmpty(
      repair,
      'attempt-22345678-1234-4123-8123-123456789abc',
      'kimi',
      2,
    )).toMatchObject({ disposition: 'quarantined' });

    const result = queueProposalRepairWorkForPendingProposals(undefined, now, { dispatchEvents: [sourceEvent] });
    const remaining = JSON.parse(readFileSync(join(fx.ashlrDir, 'self-heal-queue.json'), 'utf8')) as WorkItem[];
    const remainingBacklog = JSON.parse(readFileSync(join(fx.ashlrDir, 'backlog.json'), 'utf8')) as { items: WorkItem[] };

    expect(result).toMatchObject({
      dispatchRepairQuarantined: 1,
      dispatchRepairPruned: 2,
      dispatchNoDiffQueued: 0,
      blockedItemKeys: expect.arrayContaining([workItemCoverageKey(repair)]),
    });
    expect(readGeneratedRepairLifecycle(repair)).toMatchObject({
      available: true,
      disposition: 'quarantined',
    });
    expect(remaining.map((candidate) => candidate.id)).toEqual([ordinary.id]);
    expect(remainingBacklog.items.map((candidate) => candidate.id)).toEqual([ordinary.id]);
  });

  it('reports prune failure without claiming a row was durably removed', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const now = new Date('2026-07-10T16:00:00.000Z');
    const sourceEvent = captureFailure(repo.dir, {
      ts: '2026-07-10T15:00:00.000Z',
      itemId: 'repo:goal:prune-failure',
      outcome: 'empty-diff',
      proposalCreated: false,
      runId: 'run-source-prune-failure',
    });
    queueProposalRepairWorkForPendingProposals(undefined, now, { dispatchEvents: [sourceEvent] });
    const repair = (await scanQueuedAutonomyWork(repo.dir))[0]!;
    recordDiagnosticProposal(
      repair,
      'attempt-12345678-1234-4123-8123-123456789abc',
      'prop-prune-failure',
    );
    const queuePath = join(fx.ashlrDir, 'self-heal-queue.json');
    mkdirSync(join(fx.ashlrDir, '.self-heal-queue.lock'));

    const result = queueProposalRepairWorkForPendingProposals(undefined, now, { dispatchEvents: [sourceEvent] });
    const persisted = JSON.parse(readFileSync(queuePath, 'utf8')) as WorkItem[];

    expect(result).toMatchObject({
      dispatchRepairRetired: 1,
      dispatchRepairPruned: 0,
      dispatchRepairPruneFailed: 1,
    });
    expect(persisted.map((candidate) => candidate.id)).toContain(repair.id);
  });

  it('keeps a durably successful generation retired across unchanged recurrence', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const now = new Date('2026-07-10T16:00:00.000Z');
    const firstEvent = captureFailure(repo.dir, {
      ts: '2026-07-10T14:00:00.000Z',
      itemId: 'repo:goal:recurring-reslice',
      outcome: 'empty-diff',
      proposalCreated: false,
      runId: 'run-source-first',
    });
    queueProposalRepairWorkForPendingProposals(undefined, now, { dispatchEvents: [firstEvent] });
    const firstGeneration = (await scanQueuedAutonomyWork(repo.dir))[0]!;
    recordDiagnosticProposal(
      firstGeneration,
      'attempt-12345678-1234-4123-8123-123456789abc',
      'prop-repair-success',
    );
    const retired = queueProposalRepairWorkForPendingProposals(undefined, now, { dispatchEvents: [firstEvent] });

    const nextEvent = captureFailure(repo.dir, {
      ...firstEvent,
      ts: '2026-07-10T15:00:00.000Z',
      runId: 'run-source-next',
      reason: 'new occurrence completed without file changes',
    });
    const recurring = queueProposalRepairWorkForPendingProposals(undefined, now, { dispatchEvents: [nextEvent] });
    const found = await scanQueuedAutonomyWork(repo.dir);

    expect(retired).toMatchObject({ dispatchRepairRetired: 1, dispatchRepairPruned: 1 });
    expect(recurring).toMatchObject({ dispatchNoDiffQueued: 0 });
    expect(found).toEqual([]);
    expect(readGeneratedRepairLifecycle(firstGeneration)).toMatchObject({ disposition: 'retired' });
  });

  it('allows a changed objective to start a fresh generation after retirement', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const now = new Date('2026-07-10T16:00:00.000Z');
    const firstEvent = captureFailure(repo.dir, {
      ts: '2026-07-10T14:00:00.000Z',
      itemId: 'repo:goal:changed-objective-reslice',
      outcome: 'empty-diff',
      objectiveHash: 'a'.repeat(64),
      runId: 'run-source-first-objective',
    });
    queueProposalRepairWorkForPendingProposals(undefined, now, { dispatchEvents: [firstEvent] });
    const first = (await scanQueuedAutonomyWork(repo.dir))[0]!;
    recordDiagnosticProposal(
      first,
      'attempt-12345678-1234-4123-8123-123456789abc',
      'prop-first-objective',
    );

    const changedEvent = captureFailure(repo.dir, {
      ...firstEvent,
      ts: '2026-07-10T15:00:00.000Z',
      objectiveHash: 'b'.repeat(64),
      runId: 'run-source-changed-objective',
    });
    const result = queueProposalRepairWorkForPendingProposals(undefined, now, {
      dispatchEvents: [changedEvent],
    });
    const found = await scanQueuedAutonomyWork(repo.dir);

    expect(result).toMatchObject({ dispatchNoDiffQueued: 1, dispatchRepairRetired: 1 });
    expect(found).toHaveLength(1);
    expect(found[0]!.repairGenerationId).not.toBe(first.repairGenerationId);
    expect(readGeneratedRepairLifecycle(found[0]!)).toMatchObject({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
  });

  it('keeps repairs active and reports unavailable lifecycle control state on corruption', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const now = new Date('2026-07-10T16:00:00.000Z');
    const sourceEvent = captureFailure(repo.dir, {
      ts: '2026-07-10T15:00:00.000Z',
      itemId: 'repo:goal:corrupt-lifecycle',
      outcome: 'empty-diff',
      proposalCreated: false,
      runId: 'run-source-corrupt',
    });
    queueProposalRepairWorkForPendingProposals(undefined, now, { dispatchEvents: [sourceEvent] });
    mkdirSync(dirname(generatedRepairLifecyclePath()), { recursive: true });
    writeFileSync(generatedRepairLifecyclePath(), '{corrupt', 'utf8');

    const result = queueProposalRepairWorkForPendingProposals(undefined, now, { dispatchEvents: [sourceEvent] });
    const found = await scanQueuedAutonomyWork(repo.dir);

    expect(result).toMatchObject({
      dispatchRepairLifecycleUnavailable: 1,
      dispatchRepairPruned: 0,
      dispatchNoDiffQueued: 0,
    });
    expect(found.some((candidate) => candidate.tags.includes('dispatch-no-diff-reslice'))).toBe(true);
  });

  it('fails proposal repair maintenance closed when detailed proposal storage is malformed', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const now = new Date('2026-07-10T16:00:00.000Z');
    const sourceEvent = captureFailure(repo.dir, {
      ts: '2026-07-10T15:00:00.000Z',
      itemId: 'repo:goal:malformed-proposal-storage',
      outcome: 'empty-diff',
      proposalCreated: false,
      runId: 'run-source-malformed-proposal-storage',
    });
    queueProposalRepairWorkForPendingProposals(undefined, now, { dispatchEvents: [sourceEvent] });
    const repair = (await scanQueuedAutonomyWork(repo.dir))[0]!;
    mkdirSync(inboxDir(), { recursive: true });
    writeFileSync(join(inboxDir(), 'hidden-pending.json'), '{malformed', 'utf8');

    const result = queueProposalRepairWorkForPendingProposals(undefined, now, { dispatchEvents: [sourceEvent] });

    expect(result).toMatchObject({
      scanned: 0,
      eligible: 0,
      queued: 0,
      failed: 1,
      proposalInboxAvailable: false,
      dispatchSourceState: 'degraded',
      dispatchSourceComplete: false,
      dispatchSourceInvalidRows: 0,
      dispatchSourceUnreadableFiles: 1,
      dispatchSourceStopReasons: ['io-error'],
    });
    expect((await scanQueuedAutonomyWork(repo.dir)).some((candidate) => candidate.id === repair.id)).toBe(true);
  });

  it('reconciles a crash-persisted exact proposal back to its repair generation', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const now = new Date('2026-07-10T16:00:00.000Z');
    const sourceEvent = captureFailure(repo.dir, {
      ts: '2026-07-10T14:00:00.000Z',
      itemId: 'repo:goal:crash-reconcile',
      outcome: 'empty-diff',
      proposalCreated: false,
      runId: 'run-source-crash',
    });
    queueProposalRepairWorkForPendingProposals(undefined, now, { dispatchEvents: [sourceEvent] });
    const repair = (await scanQueuedAutonomyWork(repo.dir))[0]!;
    const attemptId = 'attempt-12345678-1234-4123-8123-123456789abc';
    const proposalEvent = diagnosticProposalEvent(
      repair,
      attemptId,
      'prop-crash-reconcile',
      '2026-07-10T15:00:00.000Z',
    );
    const durableProposal = diagnosticProposalForEvent(repair, proposalEvent, {
      title: 'Recovered generated repair',
      summary: 'The proposal persisted before lifecycle projection.',
    });

    mkdirSync(inboxDir(), { recursive: true });
    writeJson(join(inboxDir(), `${durableProposal.id}.json`), durableProposal);
    expect(recordDispatchProduction(proposalEvent)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    const result = queueProposalRepairWorkForPendingProposals(undefined, now, {
      dispatchEvents: [sourceEvent, proposalEvent],
      lifecycleProposals: [durableProposal],
    });
    const found = await scanQueuedAutonomyWork(repo.dir);

    expect(result).toMatchObject({ dispatchRepairRetired: 1, dispatchRepairPruned: 1 });
    expect(found).toEqual([]);
  });

  it('blocks a distinct v2 generation when persisted v1 receipt authority is ambiguous', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const now = new Date('2026-07-10T16:00:00.000Z');
    const sourceEvent = captureFailure(repo.dir, {
      ts: '2026-07-10T14:00:00.000Z',
      itemId: 'repo:goal:v1-applied-v2-reconcile',
      outcome: 'empty-diff',
      proposalCreated: false,
      runId: 'run-source-v1-applied',
      objectiveHash: 'c'.repeat(64),
    });
    const v2 = repairHandoffFromDispatchEvent(sourceEvent)!;
    const v1EventId = createHash('sha256').update(JSON.stringify([
      'ashlr:repair-handoff:v1', v2.kind, v2.repo, v2.parentItemId,
      v2.parentOutcome, v2.parentAttemptId,
    ])).digest('hex');
    const v1 = {
      ...v2,
      schemaVersion: 1 as const,
      eventId: v1EventId,
      generationId: repairGenerationIdFromHandoffId(v1EventId)!,
    };
    writeFileSync(repairHandoffJournalPath(), `${JSON.stringify(v1)}\n`, { mode: 0o600 });
    queueProposalRepairWorkForPendingProposals(undefined, now);
    const legacyRepair = (await scanQueuedAutonomyWork(repo.dir))[0]!;
    const attemptId = 'attempt-62345678-1234-4123-8123-123456789abc';
    const pendingProposal: Proposal = {
      id: 'prop-v1-applied-v2-reconcile',
      repo: repo.dir,
      origin: 'agent',
      kind: 'patch',
      title: 'Legacy generation repair',
      summary: 'Captured while the v1 repair generation was current.',
      diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
      workItemId: legacyRepair.id,
      workItemGenerationId: legacyRepair.repairGenerationId,
      workSource: 'self',
      runId: attemptId,
      trajectoryId: `run:${attemptId}`,
      runEventSummary: { runId: attemptId, status: 'done', outcome: 'proposal-created', proposalCreated: true },
      status: 'pending',
      createdAt: '2026-07-10T15:00:00.000Z',
    };

    writeJson(join(fx.ashlrDir, 'self-heal-queue.json'), []);
    writeJson(join(fx.ashlrDir, 'backlog.json'), { generatedAt: now.toISOString(), repos: [repo.dir], items: [] });
    const recurrence = {
      ...sourceEvent,
      ts: '2026-07-10T15:30:00.000Z',
      runId: 'run-source-v2-recurrence',
    };
    recordRepairHandoffs(recurrence, {
      schemaVersion: 2,
      activation: { id: '11111111-1111-4111-8111-111111111111', activatedAt: '2020-01-01T00:00:00.000Z' },
    });
    const appliedProposal: Proposal = { ...pendingProposal, status: 'applied' };
    const proposalEvent = diagnosticProposalEvent(
      legacyRepair,
      attemptId,
      appliedProposal.id,
      appliedProposal.createdAt,
    );
    expect(recordDispatchProduction(proposalEvent)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    const result = queueProposalRepairWorkForPendingProposals(undefined, now, {
      dispatchEvents: [recurrence, proposalEvent],
      lifecycleProposals: [appliedProposal],
    });
    const found = await scanQueuedAutonomyWork(repo.dir);

    expect(v1.generationId).not.toBe(v2.generationId);
    expect(result).toMatchObject({
      dispatchRepairRetired: 0,
      dispatchNoDiffQueued: 0,
      dispatchRepairLifecycleUnavailable: 1,
      blockedItemKeys: expect.arrayContaining([expect.any(String)]),
    });
    expect(found).toEqual([]);
  });

  it('keeps failed, partial, or rejected crash-persisted proposals retryable', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const now = new Date('2026-07-10T16:00:00.000Z');
    const sourceEvent = captureFailure(repo.dir, {
      ts: '2026-07-10T14:00:00.000Z',
      itemId: 'repo:goal:partial-reconcile',
      outcome: 'empty-diff',
      proposalCreated: false,
      runId: 'run-source-partial',
    });
    queueProposalRepairWorkForPendingProposals(undefined, now, { dispatchEvents: [sourceEvent] });
    const repair = (await scanQueuedAutonomyWork(repo.dir))[0]!;
    const attemptId = 'attempt-32345678-1234-4123-8123-123456789abc';
    const partialEvent = diagnosticProposalEvent(
      repair,
      attemptId,
      'prop-partial-reconcile',
      '2026-07-10T15:00:00.000Z',
    );
    const partial = diagnosticProposalForEvent(repair, partialEvent, {
      origin: 'swarm',
      title: 'Partial generated repair',
      summary: 'Useful material from a failed repair attempt.',
      diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+partial\n',
      runEventSummary: { ...partialEvent.runEventSummary!, status: 'failed' },
      isPartial: true,
    });

    const result = queueProposalRepairWorkForPendingProposals(undefined, now, {
      dispatchEvents: [sourceEvent],
      lifecycleProposals: [partial],
    });

    expect(result.dispatchRepairRetired).toBe(0);
    expect(readGeneratedRepairLifecycle(repair)).toMatchObject({ disposition: 'active' });
    expect((await scanQueuedAutonomyWork(repo.dir)).some((candidate) => candidate.id === repair.id)).toBe(true);

    const rejectedEvent = diagnosticProposalEvent(
      repair,
      attemptId,
      'prop-rejected-reconcile',
      partial.createdAt,
    );
    const rejected = diagnosticProposalForEvent(repair, rejectedEvent, {
      isPartial: false,
      status: 'rejected',
    });
    expect(queueProposalRepairWorkForPendingProposals(undefined, now, {
      dispatchEvents: [sourceEvent],
      lifecycleProposals: [rejected],
    }).dispatchRepairRetired).toBe(0);
    expect(readGeneratedRepairLifecycle(repair)).toMatchObject({ disposition: 'active' });

    const proposalEvent = diagnosticProposalEvent(
      repair,
      attemptId,
      'prop-applied-reconcile',
      rejected.createdAt,
    );
    const applied = diagnosticProposalForEvent(repair, proposalEvent, {
      status: 'applied',
    });
    mkdirSync(inboxDir(), { recursive: true });
    writeJson(join(inboxDir(), `${applied.id}.json`), applied);
    expect(recordDispatchProduction(proposalEvent)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(queueProposalRepairWorkForPendingProposals(undefined, now, {
      dispatchEvents: [sourceEvent, proposalEvent],
      lifecycleProposals: [applied],
    })).toMatchObject({ dispatchRepairRetired: 1, dispatchRepairPruned: 1 });
    expect(readGeneratedRepairLifecycle(repair)).toMatchObject({ disposition: 'retired' });
  });

  it('does not reconcile an older or causally mismatched proposal to a newer generation', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const now = new Date('2026-07-10T16:00:00.000Z');
    const sourceEvent = captureFailure(repo.dir, {
      ts: '2026-07-10T15:00:00.000Z',
      itemId: 'repo:goal:new-generation',
      outcome: 'empty-diff',
      proposalCreated: false,
      runId: 'run-source-new',
    });
    const staleProposal = partialProposal(repo.dir, {
      id: 'prop-stale-generation',
      origin: 'agent',
      workItemId: 'placeholder',
      workSource: 'self',
      runId: 'attempt-12345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-12345678-1234-4123-8123-123456789abc',
      runEventSummary: {
        runId: 'attempt-mismatch',
        status: 'done',
        outcome: 'proposal-created',
        proposalCreated: true,
      },
      createdAt: '2026-07-10T14:00:00.000Z',
    });
    queueProposalRepairWorkForPendingProposals(undefined, now, { dispatchEvents: [sourceEvent] });
    const repair = (await scanQueuedAutonomyWork(repo.dir))[0]!;
    staleProposal.workItemId = repair.id;
    staleProposal.workItemGenerationId = generatedRepairGenerationId({
      ...repair,
      ts: '2026-07-10T14:00:00.000Z',
    })!;

    const result = queueProposalRepairWorkForPendingProposals(undefined, now, {
      dispatchEvents: [sourceEvent],
      lifecycleProposals: [staleProposal],
    });

    expect(result).toMatchObject({ dispatchRepairRetired: 0, dispatchNoDiffQueued: 1 });
    expect((await scanQueuedAutonomyWork(repo.dir))).toHaveLength(1);
  });

  it('does not rehydrate hand-written diagnostic reslice lookalikes', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const lookalike = item(repo.dir, 'manual-diagnostic-reslice', {
      source: 'self',
      title: 'Manual diagnostic reslice',
      detail:
        'Diagnostic reslice: copied shape.\n' +
        'Original work item: repo:goal:no-diff\n' +
        'Dispatch outcome: empty-diff\n' +
        'Action: reslice the work into a smaller edit.',
      tags: ['self-heal', 'proposal-repair', 'diagnostic-reslice', 'dispatch-no-diff-reslice'],
    });

    writeJson(join(fx.ashlrDir, 'self-heal-queue.json'), [lookalike]);

    const found = await scanQueuedAutonomyWork(repo.dir);

    expect(found).toEqual([]);
  });

  it('queues issue capture repair but excludes ineligible sources, disabled, stale, and successful dispatches', async () => {
    const repo = fx.makeRepo();
    const otherRepo = fx.makeRepo();
    repo.enroll();
    const now = new Date();
    const recent = new Date(now.getTime() - 60_000).toISOString();
    const events: DispatchProductionEvent[] = [
      captureFailure(repo.dir, { ts: recent, itemId: 'todo-gate', source: 'todo' }),
      captureFailure(repo.dir, {
        ts: recent,
        itemId: 'repo:issue:captured-partial',
        source: 'issue',
        backend: 'codex',
        tier: 'frontier',
        runId: 'attempt-42345678-1234-4123-8123-123456789abc',
        trajectoryId: 'run:attempt-42345678-1234-4123-8123-123456789abc',
        outcome: 'proposal-capture-error',
        reason: 'proposal-capture-error: src/issue.ts:5 expected ready state',
      }),
      captureFailure(repo.dir, { ts: recent, itemId: 'self-disabled', outcome: 'proposal-disabled' }),
      captureFailure(repo.dir, {
        ts: recent,
        itemId: 'self-success',
        outcome: 'proposal-created',
        proposalCreated: true,
        proposalId: 'prop-created',
      }),
      captureFailure(repo.dir, {
        ts: recent,
        itemId: 'self-generic-capture',
        outcome: 'proposal-capture-error',
        reason: 'proposal-capture-error: capture failed without source failure evidence',
      }),
      captureFailure(repo.dir, {
        ts: recent,
        itemId: 'self-generic-gate',
        outcome: 'gate-blocked',
        routeReason: 'local route',
        reason: 'tests still failing after 2 attempt(s)',
      }),
      captureFailure(repo.dir, {
        ts: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(),
        itemId: 'self-old-capture',
        outcome: 'proposal-capture-error',
        reason: 'proposal-capture-error: src/old.ts:5 expected old state',
      }),
      captureFailure(repo.dir, {
        ts: new Date(now.getTime() + 60_000).toISOString(),
        itemId: 'self-future-capture',
        outcome: 'proposal-capture-error',
        reason: 'proposal-capture-error: src/future.ts:5 expected future state',
      }),
      captureFailure(repo.dir, {
        ts: recent,
        itemId: 'repo:proposal-repair:existing',
        outcome: 'proposal-capture-error',
        reason: 'proposal-capture-error: src/repair.ts:5 expected repair state',
      }),
      captureFailure(otherRepo.dir, {
        ts: recent,
        itemId: 'other-unenrolled',
        outcome: 'proposal-capture-error',
        reason: 'proposal-capture-error: src/other.ts:5 expected other state',
      }),
    ];
    const result = queueProposalRepairWorkForPendingProposals(undefined, now, {
      dispatchEvents: events,
    });
    const found = await scanQueuedAutonomyWork(repo.dir);
    const issueCandidate = captureGateRepairWorkItem(events[1]!, now);
    const handoffs = readRepairHandoffs();

    expect(issueCandidate).not.toBeNull();
    expect(handoffs.sourceState).toBe('healthy');
    expect(handoffs.observations.find((row) => row.eventId === events[1]!.repairHandoffId)).toMatchObject({
      kind: 'capture-repair',
      parentSource: 'issue',
      parentBackend: 'codex',
      parentTier: 'frontier',
      parentObjectiveHash: 'a'.repeat(64),
    });
    expect(generatedRepairGenerationId(issueCandidate!)).toMatch(/^[a-f0-9]{64}$/);
    expect(result).toMatchObject({ scanned: events.length, eligible: 1, queued: 1, failed: 0 });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      source: 'self',
      repairParentItemId: 'repo:issue:captured-partial',
      repairParentSource: 'issue',
      repairParentBackend: 'codex',
      repairParentTier: 'frontier',
      repairParentObjectiveHash: 'a'.repeat(64),
    });
    expect(generatedRepairGenerationId(found[0]!)).toMatch(/^[a-f0-9]{64}$/);
    expect(generatedRepairGenerationId({ ...found[0]!, repairParentTier: 'mid' })).toBeNull();
    expect(generatedRepairGenerationId({ ...found[0]!, repairParentSource: 'self' })).toBeNull();
    const {
      repairHandoffId: _handoff,
      repairGenerationId: _generation,
      repairParentItemId: _parentItem,
      repairParentSource: _parentSource,
      repairParentBackend: _parentBackend,
      repairParentTier: _parentTier,
      repairParentObjectiveHash: _parentObjective,
      ...lineageStripped
    } = found[0]!;
    expect(generatedRepairGenerationId(lineageStripped)).toBeNull();
    const unrelatedLegacyShape = {
      ...lineageStripped,
      id: 'repo:proposal-repair-capture:001122334455',
    };
    expect(generatedRepairGenerationId(unrelatedLegacyShape)).toMatch(/^[a-f0-9]{64}$/);
    writeFileSync(repairHandoffV2JournalPath(), '{malformed', 'utf8');
    expect(generatedRepairGenerationId(unrelatedLegacyShape)).toBeNull();
  });

  it('fails closed and reports detailed dispatch storage degradation', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const now = new Date('2026-07-15T12:00:00.000Z');
    const dispatchDir = dispatchProductionDir();
    mkdirSync(dispatchDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dispatchDir, '2026-07-15.jsonl'), '{malformed dispatch row\n', { mode: 0o600 });

    const result = queueProposalRepairWorkForPendingProposals(undefined, now);
    const queued = await scanQueuedAutonomyWork(repo.dir);

    expect(result).toMatchObject({
      scanned: 0,
      eligible: 0,
      queued: 0,
      failed: 1,
      dispatchCaptureFailed: 1,
      dispatchNoDiffFailed: 1,
      dispatchSourceState: 'degraded',
      dispatchSourceComplete: false,
      dispatchSourceInvalidRows: 1,
      proposalInboxAvailable: true,
    });
    expect(result.dispatchSourceStopReasons).toEqual([]);
    expect(queued).toEqual([]);
  });

  it('does not queue repair work for clean pending proposals', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const proposal = partialProposal(repo.dir, {
      isPartial: false,
      verifyResult: { passed: true, detail: 'verified', source: 'manual' },
    });

    const result = queueProposalRepairWorkForPendingProposals([proposal]);
    const found = await scanQueuedAutonomyWork(repo.dir);

    expect(result).toMatchObject({ scanned: 1, eligible: 0, queued: 0, failed: 0 });
    expect(found).toEqual([]);
  });

  it('keeps proposal repair work eligible even when the original item is pending-covered', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const proposal = partialProposal(repo.dir);
    queueProposalRepairWorkForPendingProposals([proposal]);

    const backlog = await buildBacklog({
      repos: [repo.dir],
      minItemValue: 2,
      cfg: { foundry: { feedbackEnabled: false } },
      listPendingProposals: () => [proposal],
    });

    expect(backlog.items.some((x) => x.tags.includes('proposal-repair'))).toBe(true);
    expect(backlog.items.find((x) => x.tags.includes('proposal-repair'))?.id).not.toBe(proposal.workItemId);
  });

  it('refuses to overwrite a malformed self-heal queue while generating repairs', () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const path = join(fx.ashlrDir, 'self-heal-queue.json');
    mkdirSync(fx.ashlrDir, { recursive: true });
    writeFileSync(path, '{corrupt queue', 'utf8');

    const result = queueProposalRepairWorkForPendingProposals([partialProposal(repo.dir)]);

    expect(result).toMatchObject({
      eligible: 0,
      queued: 0,
      failed: 0,
      dispatchRepairPruneFailed: 1,
      blockedRootKeys: [expect.any(String)],
    });
    expect(readFileSync(path, 'utf8')).toBe('{corrupt queue');
  });
});
