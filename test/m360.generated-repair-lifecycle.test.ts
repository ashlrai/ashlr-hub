import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  generatedRepairLifecyclePath,
  generatedRepairGenerationId,
  generatedRepairDispatchLineage,
  generatedRepairRetryPolicy,
  readGeneratedRepairQueueSnapshot,
  acknowledgeGeneratedRepairTreatmentOutcome,
  readGeneratedRepairLifecycle,
  readPendingGeneratedRepairTreatmentOutcomes,
  publishGeneratedRepairTreatmentOutcome,
  recordGeneratedRepairLifecycle,
  readGeneratedRepairTerminalOutcome,
  _setGeneratedRepairLifecycleDirectoryFsyncHookForTest,
  _setGeneratedRepairLifecycleRaceHooksForTest,
  _resetGeneratedRepairLifecycleCacheForTest,
} from '../src/core/fleet/generated-repair-lifecycle.js';
import {
  generatedRepairLifecycleAttemptHash,
  repairGenerationIdFromHandoffId,
  repairTreatmentForUnitId,
} from '../src/core/fleet/generated-repair-identity.js';
import { recordUse } from '../src/core/fleet/quota.js';
import type { WorkItem } from '../src/core/types.js';
import {
  dispatchProductionDir,
  readDispatchProductionFailureAttemptReceipts,
  readDispatchProductionEvents,
  recordDispatchProduction,
  type DispatchProductionEvent,
} from '../src/core/fleet/dispatch-production-ledger.js';
import { workItemObjectiveHash } from '../src/core/fleet/work-item-objective.js';
import { inspectGeneratedRepairRouteFeasibility, routeBackend } from '../src/core/fleet/router.js';
import {
  readRepairHandoffs,
  recordRepairHandoffs,
  repairHandoffFromDispatchEvent,
  repairHandoffJournalPath,
} from '../src/core/fleet/repair-handoff-journal.js';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import { _setProposalReadRaceHookForTest, inboxDir } from '../src/core/inbox/store.js';
import {
  acquireProposalStoreMutationLock,
  releaseProposalStoreMutationLock,
} from '../src/core/inbox/proposal-mutation-lock.js';
import { assurePrivateStoragePath } from '../src/core/util/private-storage.js';

const privateStorageHarness = vi.hoisted(() => ({
  useSemanticAdapter: false,
  realCalls: 0,
  realInvocations: [] as Array<{
    path: string;
    kind: 'file' | 'directory';
    mode: 'secure-created' | 'inspect-existing' | 'inspect-owned';
    anchorPath: string | undefined;
  }>,
}));

vi.mock('../src/core/util/private-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/util/private-storage.js')>();
  return {
    ...actual,
    assurePrivateStoragePath: (
      ...args: Parameters<typeof actual.assurePrivateStoragePath>
    ) => {
      if (process.platform === 'win32' && privateStorageHarness.useSemanticAdapter) {
        return {
          ok: true,
          reason: args[2] === 'inspect-owned' ? 'owned-safe-path' : 'exact-private-dacl',
        };
      }
      privateStorageHarness.realCalls++;
      privateStorageHarness.realInvocations.push({
        path: args[0],
        kind: args[1],
        mode: args[2],
        anchorPath: args[3]?.anchorPath,
      });
      return actual.assurePrivateStoragePath(...args);
    },
    assurePrivateStoragePaths: (
      ...args: Parameters<typeof actual.assurePrivateStoragePaths>
    ) => {
      if (process.platform === 'win32' && privateStorageHarness.useSemanticAdapter) {
        return { ok: true, reason: args[0].length === 0 ? 'no-paths' : 'owned-safe-paths' };
      }
      privateStorageHarness.realCalls++;
      return actual.assurePrivateStoragePaths(...args);
    },
  };
});

vi.mock('../src/core/run/engines.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/run/engines.js')>();
  return { ...actual, engineInstalled: () => true };
});

let fx: H1Fixture;
const MAX_LIFECYCLE_TEST_RSS_KIB = 768 * 1024;

beforeEach(() => {
  expect.hasAssertions();
  privateStorageHarness.useSemanticAdapter = process.platform === 'win32';
  privateStorageHarness.realCalls = 0;
  privateStorageHarness.realInvocations.length = 0;
  fx = makeFixture();
});

afterEach(() => {
  _setGeneratedRepairLifecycleDirectoryFsyncHookForTest(undefined);
  _setGeneratedRepairLifecycleRaceHooksForTest(undefined);
  _setProposalReadRaceHookForTest(undefined);
  try {
    fx.cleanup();
  } finally {
    privateStorageHarness.useSemanticAdapter = false;
  }
});

function repairItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'repo:proposal-repair:abcdef123456',
    repo: fx?.home ?? '/tmp/repo',
    source: 'self',
    title: 'Proposal repair: complete the stalled scheduler fix',
    detail:
      'Proposal repair: produce a corrected proposal.\n' +
      'Proposal: prop-stalled\n' +
      'Original work item: repo:goal:stalled\n' +
      'Produce a fresh complete fix and verify it.',
    value: 4,
    effort: 1,
    score: 4,
    tags: ['self-heal', 'proposal-repair', 'verify'],
    ts: '2026-07-10T12:00:00.000Z',
    repairRootId: 'c'.repeat(64),
    repairRootAuthorityId: 'm360:ordinary-repair-root',
    repairDepth: 0,
    ...overrides,
  };
}

function captureRepairItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return repairItem({
    id: 'repo:proposal-repair-capture:abcdef123456',
    title: 'Dispatch capture repair: preserve a verified scheduler fix',
    detail:
      'Dispatch capture repair: recover a failed proposal capture.\n' +
      'Original work item: repo:goal:capture-stalled\n' +
      'Dispatch outcome: proposal-capture-error\n' +
      'Diff metadata: files=1\n' +
      'Failure: src/app.ts:12 expected a complete proposal\n' +
      'Produce a fresh complete fix and verify it.',
    tags: ['self-heal', 'proposal-repair', 'dispatch-capture-repair', 'capture-gate', 'verify'],
    ...overrides,
  });
}

function useSemanticDiagnosticFixtureStorage(): void {
  if (process.platform === 'win32') privateStorageHarness.useSemanticAdapter = true;
}

function diagnosticRepairItem(
  parentBackend: 'local-coder' | 'codex' = 'local-coder',
  parentTier: 'mid' | 'frontier' = 'mid',
  schemaVersion: 1 | 2 = 2,
  identitySuffix = '',
  parentOverrides: Partial<DispatchProductionEvent> = {},
): WorkItem {
  // Diagnostic behavior fixtures intentionally model exact storage semantics
  // without paying native Windows adapter startup for every prerequisite.
  useSemanticDiagnosticFixtureStorage();
  const nonce = fx.home.replace(/[^a-zA-Z0-9]/g, '').slice(-16);
  const parent: DispatchProductionEvent = {
    schemaVersion: 1,
    ts: '2026-07-10T12:00:00.000Z',
    itemId: `repo:goal:diagnostic-retry:${nonce}${identitySuffix}`,
    source: 'goal',
    repo: fx.home,
    title: 'Repair a stalled objective',
    backend: parentBackend,
    tier: parentTier,
    assignedBy: 'router',
    routeReason: 'test parent route',
    outcome: 'empty-diff',
    proposalCreated: false,
    runId: ATTEMPT_ONE,
    objectiveHash: 'a'.repeat(64),
    spentUsd: 0,
    basis: 'run-proposal-outcome',
    ...parentOverrides,
  };
  expect(repairHandoffFromDispatchEvent(parent)).not.toBeNull();
  if (schemaVersion === 2) {
    recordRepairHandoffs(parent, {
      schemaVersion: 2,
      activation: { id: '11111111-1111-4111-8111-111111111111', activatedAt: '2020-01-01T00:00:00.000Z' },
    });
  } else {
    recordRepairHandoffs(parent, { schemaVersion: 1 });
  }
  const handoff = readRepairHandoffs().observations.find((observation) =>
    observation.schemaVersion === schemaVersion && observation.parentItemId === parent.itemId)!;
  return {
    id: handoff.childItemId,
    repo: parent.repo,
    source: 'self',
    title: `Reslice no-diff dispatch for repo item ${parent.itemId}`,
    detail:
      'Diagnostic reslice: a dispatch completed without file changes.\n' +
      `Original work item: ${parent.itemId}\n` +
      'Dispatch outcome: empty-diff\n' +
      'Action: reslice the work into a smaller concrete edit.',
    value: 5,
    effort: 1,
    score: 5,
    tags: ['self-heal', 'proposal-repair', 'diagnostic-reslice', 'dispatch-no-diff-reslice'],
    ts: parent.ts,
    repairHandoffId: handoff.eventId,
    repairGenerationId: handoff.generationId,
    repairTreatmentUnitId: handoff.repairTreatmentUnitId,
    repairTreatment: handoff.repairTreatment,
    repairParentItemId: parent.itemId,
    repairParentSource: parent.source,
    repairParentBackend: parent.backend,
    repairParentTier: parent.tier,
    repairParentObjectiveHash: parent.objectiveHash,
  };
}

function secureNativeFixtureDescendants(root: string, anchorPath: string): void {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = lstatSync(path);
    expect(stat.isSymbolicLink()).toBe(false);
    if (stat.isDirectory()) {
      expect(assurePrivateStoragePath(
        path,
        'directory',
        'secure-created',
        { anchorPath },
      )).toEqual({ ok: true, reason: 'exact-private-dacl' });
      secureNativeFixtureDescendants(path, anchorPath);
      continue;
    }
    expect(stat.isFile()).toBe(true);
    expect(assurePrivateStoragePath(
      path,
      'file',
      'secure-created',
      { anchorPath },
    )).toEqual({ ok: true, reason: 'exact-private-dacl' });
  }
}

function handoffCaptureRepairItem(): WorkItem {
  const nonce = fx.home.replace(/[^a-zA-Z0-9]/g, '').slice(-16);
  const parent: DispatchProductionEvent = {
    schemaVersion: 1,
    ts: '2026-07-10T12:00:00.000Z',
    itemId: `repo:goal:capture-retry:${nonce}`,
    source: 'goal',
    repo: fx.home,
    title: 'Capture a verified scheduler fix',
    backend: 'local-coder',
    tier: 'mid',
    assignedBy: 'router',
    routeReason: 'test capture parent route',
    outcome: 'proposal-capture-error',
    proposalCreated: false,
    runId: ATTEMPT_ONE,
    objectiveHash: 'b'.repeat(64),
    spentUsd: 0,
    diffFiles: 1,
    basis: 'run-proposal-outcome',
  };
  expect(repairHandoffFromDispatchEvent(parent)).not.toBeNull();
  recordRepairHandoffs(parent, {
    schemaVersion: 2,
    activation: { id: '22222222-2222-4222-8222-222222222222', activatedAt: '2020-01-01T00:00:00.000Z' },
  });
  const handoff = readRepairHandoffs().observations.find((observation) =>
    observation.kind === 'capture-repair' && observation.parentItemId === parent.itemId)!;
  return captureRepairItem({
    id: handoff.childItemId,
    repo: parent.repo,
    ts: parent.ts,
    repairHandoffId: handoff.eventId,
    repairGenerationId: handoff.generationId,
    repairTreatmentUnitId: handoff.repairTreatmentUnitId,
    repairTreatment: handoff.repairTreatment,
    repairParentItemId: parent.itemId,
    repairParentSource: parent.source,
    repairParentBackend: parent.backend,
    repairParentTier: parent.tier,
    repairParentObjectiveHash: parent.objectiveHash,
  });
}

const ATTEMPT_ONE = 'attempt-12345678-1234-4123-8123-123456789abc';
const ATTEMPT_TWO = 'attempt-22345678-1234-4123-8123-123456789abc';
const ATTEMPT_THREE = 'attempt-32345678-1234-4123-8123-123456789abc';

function installFailedLifecycleWrite(prior: Buffer | null, candidate: Buffer): void {
  const path = generatedRepairLifecyclePath();
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const priorBytes = prior ?? Buffer.alloc(0);
  writeFileSync(`${path}.rollback`, priorBytes, { mode: 0o600 });
  writeFileSync(`${path}.failed`, `${JSON.stringify({
    schemaVersion: 1,
    kind: 'rollback-required',
    priorLedgerExisted: prior !== null,
    priorLedgerDigest: digest(priorBytes),
    candidateDigest: digest(candidate),
  })}\n`, { mode: 0o600 });
}

function decodedStringCorpus(value: unknown): string[] {
  if (typeof value === 'string') {
    const strings = [value];
    try {
      const decoded = Buffer.from(value, 'base64');
      if (decoded.length > 0 && decoded.toString('base64') === value) {
        const text = decoded.toString('utf8');
        strings.push(text);
        try { strings.push(...decodedStringCorpus(JSON.parse(text))); } catch { /* not encoded JSON */ }
      }
    } catch { /* not base64 */ }
    return strings;
  }
  if (Array.isArray(value)) return value.flatMap(decodedStringCorpus);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, nested]) => [key, ...decodedStringCorpus(nested)]);
  }
  return [];
}

function writeSyntheticLifecycleLedger(
  path: string,
  count: number,
  recordAt: (index: number) => Record<string, unknown>,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'w', 0o600);
  let chunk = '{"schemaVersion":1,"records":[';
  let chunkBytes = Buffer.byteLength(chunk);
  try {
    for (let index = 0; index < count; index++) {
      const row = `${index === 0 ? '' : ','}${JSON.stringify(recordAt(index))}`;
      const rowBytes = Buffer.byteLength(row);
      if (chunkBytes + rowBytes > 1024 * 1024) {
        writeSync(fd, chunk);
        chunk = '';
        chunkBytes = 0;
      }
      chunk += row;
      chunkBytes += rowBytes;
    }
    writeSync(fd, `${chunk}]}\n`);
  } finally {
    closeSync(fd);
  }
}

function diagnosticEmptyEvent(
  item: WorkItem,
  attemptId: string,
  backend: Exclude<NonNullable<DispatchProductionEvent['backend']>, 'builtin'>,
  tier: NonNullable<DispatchProductionEvent['tier']>,
  ordinal: 1 | 2,
  ts = ordinal === 1 ? '2026-07-10T13:00:00.000Z' : '2026-07-10T14:00:00.000Z',
): DispatchProductionEvent {
  useSemanticDiagnosticFixtureStorage();
  const routeReason = `test diagnostic attempt ${ordinal}`;
  const event: DispatchProductionEvent = {
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
    const lifecycle = readGeneratedRepairLifecycle(item);
    const previousBackend = lifecycle.lastAuthoritativeEmptyBackend;
    if (previousBackend) event.repairPreviousBackend = previousBackend;
  }
  return event;
}

function recordDiagnosticEmpty(
  item: WorkItem,
  attemptId: string,
  backend: Exclude<NonNullable<DispatchProductionEvent['backend']>, 'builtin'>,
  tier: NonNullable<DispatchProductionEvent['tier']>,
  ordinal: 1 | 2,
  ts = ordinal === 1 ? '2026-07-10T13:00:00.000Z' : '2026-07-10T14:00:00.000Z',
) {
  useSemanticDiagnosticFixtureStorage();
  const event = diagnosticEmptyEvent(item, attemptId, backend, tier, ordinal, ts);
  expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
  return recordGeneratedRepairLifecycle(item, { kind: 'dispatch-proof-empty-diff', eventTs: ts });
}

function diagnosticProposalEvent(
  item: WorkItem,
  attemptId: string,
  proposalId: string,
  backend: Exclude<NonNullable<DispatchProductionEvent['backend']>, 'builtin'>,
  tier: NonNullable<DispatchProductionEvent['tier']>,
  ordinal: 1 | 2,
  ts = ordinal === 1 ? '2026-07-10T13:00:00.000Z' : '2026-07-10T14:00:00.000Z',
): DispatchProductionEvent {
  const event = diagnosticEmptyEvent(item, attemptId, backend, tier, ordinal, ts);
  event.outcome = 'proposal-created';
  event.proposalCreated = true;
  event.proposalId = proposalId;
  event.runEventSummary = {
    ...event.runEventSummary!,
    outcome: 'proposal-created',
    proposalCreated: true,
    proposalId,
  };
  return event;
}

function diagnosticFailureEvent(
  item: WorkItem,
  attemptId: string,
  outcome: 'engine-failed' | 'proposal-capture-error',
  backend: Exclude<NonNullable<DispatchProductionEvent['backend']>, 'builtin'> = 'local-coder',
  tier: NonNullable<DispatchProductionEvent['tier']> = 'mid',
  ts = '2026-07-10T13:00:00.000Z',
): DispatchProductionEvent {
  const event = diagnosticEmptyEvent(item, attemptId, backend, tier, 1, ts);
  event.outcome = outcome;
  event.reason = `${outcome}: canonical failed repair attempt`;
  event.repairRootId = item.repairRootId;
  event.repairDepth = item.repairDepth;
  event.runEventSummary = {
    ...event.runEventSummary!,
    status: 'failed',
    outcome,
    proposalCreated: false,
  };
  return event;
}

function persistDurableProposal(item: WorkItem, event: DispatchProductionEvent): void {
  expect(event.proposalId).toBeTruthy();
  expect(event.runId).toBeTruthy();
  expect(event.trajectoryId).toBe(`run:${event.runId}`);
  const dir = inboxDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const diff = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
  writeFileSync(join(dir, `${event.proposalId}.json`), `${JSON.stringify({
    id: event.proposalId,
    repo: item.repo,
    origin: 'agent',
    kind: 'patch',
    title: 'Durable generated repair proposal',
    summary: 'Bound test proposal',
    diff,
    diffHash: createHash('sha256').update(diff, 'utf8').digest('hex'),
    workItemId: item.id,
    workItemGenerationId: generatedRepairGenerationId(item),
    workSource: 'self',
    runId: event.runId,
    trajectoryId: event.trajectoryId,
    runEventSummary: event.runEventSummary,
    status: 'pending',
    createdAt: event.ts,
  })}\n`, { mode: 0o600 });
}

function ordinaryProposalEvent(
  item: WorkItem,
  attemptId: string,
  proposalId: string,
  ts = '2026-07-10T13:00:00.000Z',
): DispatchProductionEvent {
  const generationId = generatedRepairGenerationId(item)!;
  return {
    schemaVersion: 1,
    ts,
    itemId: item.id,
    source: 'self',
    repo: item.repo,
    title: item.title,
    backend: 'local-coder',
    tier: 'mid',
    assignedBy: 'daemon',
    routeReason: 'test ordinary repair proposal',
    outcome: 'proposal-created',
    proposalCreated: true,
    proposalId,
    runId: attemptId,
    trajectoryId: `run:${attemptId}`,
    routeSnapshot: {
      backend: 'local-coder',
      tier: 'mid',
      assignedBy: 'daemon',
      reason: 'test ordinary repair proposal',
      routerPolicyVersion: 'fleet-router-v1',
    },
    runEventSummary: {
      runId: attemptId,
      status: 'done',
      outcome: 'proposal-created',
      proposalCreated: true,
      proposalId,
      costUsd: 0,
    },
    learningSource: 'daemon-dispatch',
    labelBasis: 'dispatch-outcome',
    routerPolicyVersion: 'fleet-router-v1',
    objectiveHash: workItemObjectiveHash(item),
    spentUsd: 0,
    basis: 'run-proposal-outcome',
    ...(item.repairHandoffId ? { repairHandoffId: item.repairHandoffId } : {}),
    repairGenerationId: generationId,
    repairAttemptOrdinal: 1,
    repairRootId: item.repairRootId,
    repairDepth: item.repairDepth,
  };
}

function recordOrdinaryProposal(
  item: WorkItem,
  attemptId: string,
  proposalId: string,
  ts = '2026-07-10T13:00:00.000Z',
) {
  const event = ordinaryProposalEvent(item, attemptId, proposalId, ts);
  persistDurableProposal(item, event);
  expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
  return recordGeneratedRepairLifecycle(item, {
    kind: 'proposal-created',
    attemptId: event.trajectoryId!,
    proposalId,
    ts,
  });
}

function addBlockedGenerationToProtocol(generationId: string): void {
  const path = join(dispatchProductionDir(), 'repair-attempt-proofs', '.protocol.json');
  const protocol = JSON.parse(readFileSync(path, 'utf8')) as {
    schemaVersion: 5;
    retirementEpoch: number;
    generations: Array<{ generationId: string }>;
    blockedGenerations: {
      segments: Array<{ bits: string; insertedCount: number; setBitCount: number }>;
    };
  };
  const segment = protocol.blockedGenerations.segments.at(-1)!;
  const bits = Buffer.from(segment.bits, 'base64');
  const digest = createHash('sha256')
    .update('ashlr:dispatch-attempt-generation-membership:v1\0', 'utf8')
    .update(generationId, 'utf8')
    .digest();
  for (let index = 0; index < 7; index++) {
    const bit = digest.readUInt32BE(index * 4) % 1_048_576;
    bits[Math.floor(bit / 8)]! |= 1 << (bit % 8);
  }
  segment.bits = bits.toString('base64');
  segment.insertedCount++;
  segment.setBitCount = [...bits].reduce((sum, byte) => {
    let count = 0;
    for (let value = byte; value !== 0; value &= value - 1) count++;
    return sum + count;
  }, 0);
  protocol.generations = protocol.generations.filter((entry) => entry.generationId !== generationId);
  writeFileSync(path, `${JSON.stringify(protocol)}\n`, { mode: 0o600 });
}

function retireAttemptProofGeneration(
  item: WorkItem,
  droppedThrough: string,
): void {
  useSemanticDiagnosticFixtureStorage();
  const generationId = item.repairGenerationId!;
  const attemptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
  addBlockedGenerationToProtocol(generationId);
  const protocolPath = join(attemptDir, '.protocol.json');
  const protocol = JSON.parse(readFileSync(protocolPath, 'utf8')) as { retirementEpoch: number };
  protocol.retirementEpoch++;
  writeFileSync(protocolPath, `${JSON.stringify(protocol)}\n`, { mode: 0o600 });
  for (const ordinal of [1, 2]) {
    rmSync(join(attemptDir, `${generationId}-${ordinal}.json`), { force: true });
    rmSync(join(attemptDir, `${generationId}-${ordinal}.intent.json`), { force: true });
  }
  writeFileSync(join(attemptDir, '.retention.json'), `${JSON.stringify({
    schemaVersion: 4,
    droppedThrough,
    retirementEpoch: protocol.retirementEpoch,
    pendingGenerations: [],
    pendingArtifacts: [],
  })}\n`, { mode: 0o600 });
}

function recordDiagnosticProposal(
  item: WorkItem,
  attemptId: string,
  proposalId: string,
  backend: Exclude<NonNullable<DispatchProductionEvent['backend']>, 'builtin'>,
  tier: NonNullable<DispatchProductionEvent['tier']>,
  ordinal: 1 | 2,
  ts = ordinal === 1 ? '2026-07-10T13:00:00.000Z' : '2026-07-10T14:00:00.000Z',
) {
  useSemanticDiagnosticFixtureStorage();
  const event = diagnosticProposalEvent(item, attemptId, proposalId, backend, tier, ordinal, ts);
  persistDurableProposal(item, event);
  expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
  return recordGeneratedRepairLifecycle(item, {
    kind: 'proposal-created',
    attemptId: event.trajectoryId!,
    proposalId,
    ts,
  });
}

describe('generated repair lifecycle store', () => {
  it('consumes protocol v5 emitted by the real dispatch writer', () => {
    const item = diagnosticRepairItem();
    recordDiagnosticEmpty(item, ATTEMPT_TWO, 'local-coder', 'mid', 1);
    const protocol = JSON.parse(readFileSync(
      join(dispatchProductionDir(), 'repair-attempt-proofs', '.protocol.json'),
      'utf8',
    )) as { schemaVersion: number; retirementEpoch: number };
    expect(protocol).toMatchObject({ schemaVersion: 5, retirementEpoch: 0 });
  });

  it('migrates a strict legacy v1 ledger to v2 without erasing its record', () => {
    const item = repairItem();
    const path = generatedRepairLifecyclePath();
    const generationId = generatedRepairGenerationId(item)!;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 1,
      records: [{
        generationId,
        disposition: 'active',
        emptyAttemptHashes: [generatedRepairLifecycleAttemptHash(ATTEMPT_ONE)],
        emptyAttemptBackends: ['local-coder'],
        emptyAttemptTiers: ['mid'],
        updatedAt: '2026-07-10T13:00:00.000Z',
      }],
    })}\n`, { mode: 0o600 });

    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff',
      attemptId: ATTEMPT_TWO,
      backend: 'kimi',
      tier: 'mid',
      ts: '2026-07-10T14:00:00.000Z',
    })).toMatchObject({ available: true, disposition: 'exhausted', recorded: true });
    const upgraded = JSON.parse(readFileSync(path, 'utf8')) as {
      schemaVersion: number;
      records: Array<{ emptyAttemptHashes: string[] }>;
    };
    expect(upgraded.schemaVersion).toBe(2);
    expect(upgraded.records[0]!.emptyAttemptHashes).toEqual([
      generatedRepairLifecycleAttemptHash(ATTEMPT_ONE),
      generatedRepairLifecycleAttemptHash(ATTEMPT_TWO),
    ]);
  });

  it('recovers a legacy v1 timestamp-only treatment acknowledgement through exact republication', () => {
    const item = diagnosticRepairItem();
    const transition = recordDiagnosticProposal(
      item, ATTEMPT_TWO, 'prop-v1-timestamp-only', 'local-coder', 'mid', 1,
    );
    expect(publishGeneratedRepairTreatmentOutcome(
      item.repairGenerationId!, transition.treatmentOutcomeWitness!.attemptHash,
    )).toBe(true);
    const path = generatedRepairLifecyclePath();
    const legacy = JSON.parse(readFileSync(path, 'utf8')) as {
      schemaVersion: number;
      records: Array<Record<string, unknown>>;
    };
    legacy.schemaVersion = 1;
    delete legacy.records[0]!['treatmentWitnessDigest'];
    writeFileSync(path, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
    _resetGeneratedRepairLifecycleCacheForTest();

    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      disposition: 'retired',
    });
    const pending = readPendingGeneratedRepairTreatmentOutcomes();
    expect(pending.available).toBe(true);
    expect(pending).toHaveLength(1);
    expect(publishGeneratedRepairTreatmentOutcome(
      item.repairGenerationId!, transition.treatmentOutcomeWitness!.attemptHash,
    )).toBe(true);
    const upgraded = JSON.parse(readFileSync(path, 'utf8')) as {
      schemaVersion: number;
      records: Array<Record<string, unknown>>;
    };
    expect(upgraded.schemaVersion).toBe(2);
    expect(upgraded.records[0]).toMatchObject({
      treatmentWitnessRecordedAt: expect.any(String),
      treatmentWitnessDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(readPendingGeneratedRepairTreatmentOutcomes()).toEqual([]);
  });

  it('makes v2 output fail closed to a strict v1 writer', () => {
    const item = repairItem();
    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder', tier: 'mid',
    })).toMatchObject({ recorded: true });
    const path = generatedRepairLifecyclePath();
    const before = readFileSync(path);
    const parsed = JSON.parse(before.toString('utf8')) as Record<string, unknown>;
    const acceptedByLegacyV1 = parsed['schemaVersion'] === 1 &&
      Object.keys(parsed).every((key) => key === 'schemaVersion' || key === 'records');

    expect(acceptedByLegacyV1).toBe(false);
    expect(parsed['schemaVersion']).toBe(2);
    expect(readFileSync(path)).toEqual(before);
  });

  it('rejects v1 retention and preserves v2 retention across later writes', () => {
    const item = repairItem({ ts: '2026-07-11T12:00:00.000Z' });
    const path = generatedRepairLifecyclePath();
    const droppedThrough = '2026-07-10T12:00:00.000Z';
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 2,
      retention: { droppedThrough },
      records: [],
    })}\n`, { mode: 0o600 });

    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder', tier: 'mid',
    })).toMatchObject({ available: true, authoritativeEmptyRuns: 1, recorded: true });
    const retained = JSON.parse(readFileSync(path, 'utf8')) as {
      schemaVersion: number;
      retention: { droppedThrough: string };
    };
    expect(retained).toMatchObject({ schemaVersion: 2, retention: { droppedThrough } });

    const invalidLegacy = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      retention: { droppedThrough },
      records: [],
    })}\n`, 'utf8');
    writeFileSync(path, invalidLegacy, { mode: 0o600 });
    _resetGeneratedRepairLifecycleCacheForTest();
    expect(readGeneratedRepairLifecycle(item).available).toBe(false);
    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'kimi', tier: 'mid',
    })).toMatchObject({ available: false, recorded: false });
    expect(readFileSync(path)).toEqual(invalidLegacy);
  });

  it('rolls back to legacy v1 and re-upgrades without losing accepted attempts', () => {
    const item = repairItem();
    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder', tier: 'mid',
    })).toMatchObject({ recorded: true, authoritativeEmptyRuns: 1 });
    const path = generatedRepairLifecyclePath();
    const legacy = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    legacy['schemaVersion'] = 1;
    const legacyBytes = Buffer.from(`${JSON.stringify(legacy)}\n`, 'utf8');
    writeFileSync(path, legacyBytes, { mode: 0o600 });
    _resetGeneratedRepairLifecycleCacheForTest();
    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'kimi', tier: 'mid',
    })).toMatchObject({ recorded: true, disposition: 'exhausted' });
    const failedCandidate = readFileSync(path);
    installFailedLifecycleWrite(legacyBytes, failedCandidate);

    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 1,
    });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ schemaVersion: 1 });
    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'kimi', tier: 'mid',
    })).toMatchObject({ recorded: true, disposition: 'exhausted', authoritativeEmptyRuns: 2 });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ schemaVersion: 2 });
  });

  it('propagates deterministic treatment through lifecycle and dispatch lineage metadata', () => {
    const item = diagnosticRepairItem();
    const expected = repairTreatmentForUnitId(item.repairTreatmentUnitId!)!;

    expect(readGeneratedRepairLifecycle(item)).toMatchObject({ available: true });
    expect(generatedRepairDispatchLineage(item, 'local-coder')).toMatchObject({
      repairGenerationId: item.repairGenerationId,
      repairTreatmentUnitId: item.repairTreatmentUnitId,
      repairTreatment: expected,
      repairAttemptOrdinal: 1,
    });
  });

  it('rejects caller-asserted diagnostic attempt identity and routing', () => {
    const item = diagnosticRepairItem();

    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff',
      attemptId: ATTEMPT_TWO,
      backend: 'local-coder',
      tier: 'mid',
    })).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
      recorded: false,
    });
    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      authoritativeEmptyRuns: 0,
    });
  });

  it('requires a matching canonical production row before diagnostic lifecycle advancement', () => {
    const item = diagnosticRepairItem();

    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'dispatch-proof-empty-diff',
      eventTs: '2026-07-10T13:00:00.000Z',
    })).toMatchObject({ available: false, recorded: false, authoritativeEmptyRuns: 0 });
    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      authoritativeEmptyRuns: 0,
    });
  });

  it('rejects a conflicting immutable attempt write without revoking accepted authority', () => {
    const item = diagnosticRepairItem();
    expect(recordDiagnosticEmpty(item, ATTEMPT_TWO, 'local-coder', 'mid', 1))
      .toMatchObject({ available: true, authoritativeEmptyRuns: 1 });
    const accepted = readDispatchProductionEvents().find((event) => event.itemId === item.id)!;
    const conflicting: DispatchProductionEvent = {
      ...accepted,
      routeReason: 'conflicting persisted route',
      routeSnapshot: {
        ...accepted.routeSnapshot!,
        reason: 'conflicting persisted route',
      },
    };
    expect(recordDispatchProduction(conflicting)).toEqual({ attempted: 1, recorded: 0, failed: 1 });

    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 1,
    });
  });

  it('revokes diagnostic authority when its persisted proof receipt is tampered', () => {
    const item = diagnosticRepairItem();
    expect(recordDiagnosticEmpty(item, ATTEMPT_TWO, 'local-coder', 'mid', 1))
      .toMatchObject({ available: true, authoritativeEmptyRuns: 1 });
    const path = generatedRepairLifecyclePath();
    const ledger = JSON.parse(readFileSync(path, 'utf8')) as {
      records: Array<{ emptyAttemptProofReceipts: Array<{ proof: { eventDigest: string } }> }>;
    };
    ledger.records[0]!.emptyAttemptProofReceipts[0]!.proof.eventDigest = 'f'.repeat(64);
    writeFileSync(path, `${JSON.stringify(ledger)}\n`, 'utf8');

    expect(readGeneratedRepairLifecycle(item)).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
  });

  it('persists diagnostic proof receipts without reversible event prose', () => {
    const item = diagnosticRepairItem();
    expect(recordDiagnosticEmpty(item, ATTEMPT_TWO, 'local-coder', 'mid', 1))
      .toMatchObject({ available: true, authoritativeEmptyRuns: 1 });

    const serialized = readFileSync(generatedRepairLifecyclePath(), 'utf8');
    const parsed = JSON.parse(serialized) as { records: Array<Record<string, unknown>> };
    const receipts = parsed.records[0]!['emptyAttemptProofReceipts'] as Array<Record<string, unknown>>;

    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      proof: {
        eventDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        attemptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(serialized).toContain(item.repo);
    expect(serialized).toContain(item.id);
    expect(serialized).not.toContain(item.title);
    expect(serialized).not.toContain('test diagnostic attempt 1');
  });

  it('rejects same-generation ordinal conflicts at different timestamps', () => {
    const item = diagnosticRepairItem();
    expect(recordDiagnosticEmpty(item, ATTEMPT_TWO, 'local-coder', 'mid', 1))
      .toMatchObject({ available: true, authoritativeEmptyRuns: 1 });
    const conflicting = diagnosticEmptyEvent(
      item,
      ATTEMPT_THREE,
      'kimi',
      'mid',
      1,
      '2026-07-11T13:30:00.000Z',
    );
    expect(recordDispatchProduction(conflicting)).toEqual({ attempted: 1, recorded: 0, failed: 1 });

    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 1,
    });
  });

  it.each(['engine-failed', 'proposal-capture-error'] as const)(
    'accepts an ordinal-two same-tier empty result after canonical ordinal-one %s authority',
    (outcome) => {
      const item = diagnosticRepairItem();
      item.repairRootId = 'd'.repeat(64);
      item.repairRootAuthorityId = 'm360:canonical-failed-predecessor';
      item.repairDepth = 0;
      const failure = diagnosticFailureEvent(item, ATTEMPT_TWO, outcome);
      expect(recordDispatchProduction(failure)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
      const failureReceipts = readDispatchProductionFailureAttemptReceipts([item.repairGenerationId!]);
      expect(failureReceipts).toMatchObject({
        status: 'resolved',
        authoritative: true,
        receipts: [{
          proof: { repairAttemptOrdinal: 1, backend: 'local-coder', previousBackend: null },
          event: { repairRootId: item.repairRootId, repairDepth: item.repairDepth },
        }],
      });
      const alternate = diagnosticEmptyEvent(item, ATTEMPT_THREE, 'kimi', 'mid', 2);
      alternate.repairPreviousBackend = 'local-coder';
      expect(recordDispatchProduction(alternate)).toEqual({ attempted: 1, recorded: 1, failed: 0 });

      expect(recordGeneratedRepairLifecycle(item, {
        kind: 'dispatch-proof-empty-diff',
        eventTs: alternate.ts,
      })).toMatchObject({
        available: true,
        disposition: 'active',
        authoritativeEmptyRuns: 2,
        authoritativeEmptyBackends: ['kimi'],
        recorded: true,
      });
      expect(readGeneratedRepairLifecycle(item)).toMatchObject({
        available: true,
        disposition: 'active',
        authoritativeEmptyRuns: 1,
        authoritativeEmptyBackends: ['kimi'],
      });
      if (failureReceipts.status !== 'resolved') throw new Error('expected resolved failure receipt');
      const predecessor = failureReceipts.receipts[0]!;
      rmSync(join(
        dispatchProductionDir(),
        'repair-attempt-proofs',
        `${item.repairGenerationId}-1-${predecessor.proof.attemptHash}.failure.json`,
      ));
      _resetGeneratedRepairLifecycleCacheForTest();
      expect(readGeneratedRepairLifecycle(item)).toMatchObject({
        available: false,
        disposition: 'active',
        authoritativeEmptyRuns: 0,
      });
    },
  );

  it('publishes an ordinal-two proposal from its capsule after an exact ordinal-one failure', () => {
    const item = diagnosticRepairItem();
    item.repairRootId = 'd'.repeat(64);
    item.repairRootAuthorityId = 'm360:failed-predecessor-publication';
    item.repairDepth = 0;
    expect(recordDispatchProduction(
      diagnosticFailureEvent(item, ATTEMPT_TWO, 'engine-failed'),
    )).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    const proposal = diagnosticProposalEvent(
      item, ATTEMPT_THREE, 'prop-failure-backed-publication', 'kimi', 'mid', 2,
    );
    proposal.repairPreviousBackend = 'local-coder';
    persistDurableProposal(item, proposal);
    expect(recordDispatchProduction(proposal)).toEqual({ attempted: 1, recorded: 1, failed: 0 });

    const transition = recordGeneratedRepairLifecycle(item, {
      kind: 'proposal-created',
      attemptId: proposal.trajectoryId!,
      proposalId: proposal.proposalId!,
      ts: proposal.ts,
    });
    expect(transition).toMatchObject({
      available: true,
      disposition: 'retired',
      recorded: true,
      treatmentOutcomeWitness: { outcome: 'converted' },
    });
    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      disposition: 'retired',
    });
    expect(readPendingGeneratedRepairTreatmentOutcomes()).toHaveLength(1);
    expect(publishGeneratedRepairTreatmentOutcome(
      item.repairGenerationId!,
      transition.treatmentOutcomeWitness!.attemptHash,
    )).toBe(true);
    expect(readPendingGeneratedRepairTreatmentOutcomes()).toEqual([]);
  });

  it('accepts an exact failed predecessor from the same generation-alias family', () => {
    const legacy = diagnosticRepairItem('local-coder', 'mid', 1, ':failure-alias');
    const current = diagnosticRepairItem('local-coder', 'mid', 2, ':failure-alias');
    expect(legacy.id).toBe(current.id);
    expect(legacy.repairGenerationId).not.toBe(current.repairGenerationId);
    for (const item of [legacy, current]) {
      item.repairRootId = 'd'.repeat(64);
      item.repairRootAuthorityId = 'm360:failure-alias-family';
      item.repairDepth = 0;
    }
    expect(recordDispatchProduction(
      diagnosticFailureEvent(legacy, ATTEMPT_TWO, 'engine-failed'),
    )).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    const proposal = diagnosticProposalEvent(
      current, ATTEMPT_THREE, 'prop-failure-alias-family', 'kimi', 'mid', 2,
    );
    proposal.repairPreviousBackend = 'local-coder';
    persistDurableProposal(current, proposal);
    expect(recordDispatchProduction(proposal)).toEqual({ attempted: 1, recorded: 1, failed: 0 });

    const transition = recordGeneratedRepairLifecycle(current, {
      kind: 'proposal-created',
      attemptId: proposal.trajectoryId!,
      proposalId: proposal.proposalId!,
      ts: proposal.ts,
    });
    expect(transition).toMatchObject({ available: true, disposition: 'retired', recorded: true });
    expect(readPendingGeneratedRepairTreatmentOutcomes()).toHaveLength(1);
    expect(publishGeneratedRepairTreatmentOutcome(
      current.repairGenerationId!, transition.treatmentOutcomeWitness!.attemptHash,
    )).toBe(true);
  });

  it('recovers and publishes a V1 proposal receipt after the queue resumes under its V2 alias', () => {
    const legacy = diagnosticRepairItem('local-coder', 'mid', 1, ':proposal-crash-alias');
    const current = diagnosticRepairItem('local-coder', 'mid', 2, ':proposal-crash-alias');
    expect(legacy.id).toBe(current.id);
    const proposal = diagnosticProposalEvent(
      legacy,
      ATTEMPT_TWO,
      'prop-v1-receipt-v2-resume',
      'local-coder',
      'mid',
      1,
    );
    persistDurableProposal(legacy, proposal);
    expect(recordDispatchProduction(proposal)).toEqual({ attempted: 1, recorded: 1, failed: 0 });

    const transition = recordGeneratedRepairLifecycle(current, {
      kind: 'proposal-created',
      attemptId: proposal.trajectoryId!,
      proposalId: proposal.proposalId!,
      ts: proposal.ts,
    });

    expect(transition).toMatchObject({
      available: true,
      disposition: 'retired',
      recorded: true,
      treatmentOutcomeWitness: { generationId: current.repairGenerationId },
    });
    const pending = readPendingGeneratedRepairTreatmentOutcomes();
    expect(pending).toMatchObject([{
      generationId: current.repairGenerationId,
      candidate: { repairGenerationId: legacy.repairGenerationId },
    }]);
    expect(publishGeneratedRepairTreatmentOutcome(
      current.repairGenerationId!,
      transition.treatmentOutcomeWitness!.attemptHash,
    )).toBe(true);
    expect(readPendingGeneratedRepairTreatmentOutcomes()).toEqual([]);
    expect(readGeneratedRepairLifecycle(current)).toMatchObject({
      available: true,
      disposition: 'retired',
    });
  });

  it('recovers and publishes a terminal V1 empty-diff receipt under its V2 alias', () => {
    const legacy = diagnosticRepairItem('local-coder', 'mid', 1, ':empty-crash-alias');
    const current = diagnosticRepairItem('local-coder', 'mid', 2, ':empty-crash-alias');
    expect(recordDiagnosticEmpty(legacy, ATTEMPT_TWO, 'local-coder', 'mid', 1))
      .toMatchObject({ available: true, disposition: 'active', recorded: true });
    const terminal = diagnosticEmptyEvent(legacy, ATTEMPT_THREE, 'kimi', 'mid', 2);
    expect(terminal.repairPreviousBackend).toBe('local-coder');
    expect(recordDispatchProduction(terminal)).toEqual({ attempted: 1, recorded: 1, failed: 0 });

    const transition = recordGeneratedRepairLifecycle(current, {
      kind: 'dispatch-proof-empty-diff',
      eventTs: terminal.ts,
    });

    expect(transition).toMatchObject({
      available: true,
      disposition: 'quarantined',
      authoritativeEmptyRuns: 2,
      recorded: true,
      treatmentOutcomeWitness: { generationId: current.repairGenerationId },
    });
    expect(readPendingGeneratedRepairTreatmentOutcomes()).toMatchObject([{
      generationId: current.repairGenerationId,
      candidate: { repairGenerationId: legacy.repairGenerationId },
    }]);
    expect(publishGeneratedRepairTreatmentOutcome(
      current.repairGenerationId!,
      transition.treatmentOutcomeWitness!.attemptHash,
    )).toBe(true);
    expect(readPendingGeneratedRepairTreatmentOutcomes()).toEqual([]);
  });

  it('rejects competing terminal receipts across exact V1 and V2 aliases', () => {
    const legacy = diagnosticRepairItem('local-coder', 'mid', 1, ':terminal-receipt-conflict');
    const current = diagnosticRepairItem('local-coder', 'mid', 2, ':terminal-receipt-conflict');
    const proposal = diagnosticProposalEvent(
      legacy, ATTEMPT_TWO, 'prop-alias-receipt-authority', 'local-coder', 'mid', 1,
    );
    persistDurableProposal(legacy, proposal);
    expect(recordDispatchProduction(proposal)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    const conflict = diagnosticProposalEvent(
      current, ATTEMPT_THREE, 'prop-competing-alias-receipt', 'kimi', 'mid', 1,
    );
    expect(recordDispatchProduction(conflict)).toEqual({ attempted: 1, recorded: 1, failed: 0 });

    expect(recordGeneratedRepairLifecycle(current, {
      kind: 'proposal-created',
      attemptId: proposal.trajectoryId!,
      proposalId: proposal.proposalId!,
      ts: proposal.ts,
    })).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
      recorded: false,
    });
  });

  it('refuses a V1 receipt from a near but non-identical V2 handoff family', () => {
    const legacy = diagnosticRepairItem('local-coder', 'mid', 1, ':unrelated-receipt-alias');
    const unrelated = diagnosticRepairItem(
      'codex',
      'mid',
      2,
      ':unrelated-receipt-alias',
      { runId: ATTEMPT_THREE },
    );
    expect(legacy.id).toBe(unrelated.id);
    const proposal = diagnosticProposalEvent(
      legacy, ATTEMPT_TWO, 'prop-unrelated-v1-receipt', 'local-coder', 'mid', 1,
    );
    persistDurableProposal(legacy, proposal);
    expect(recordDispatchProduction(proposal)).toEqual({ attempted: 1, recorded: 1, failed: 0 });

    expect(recordGeneratedRepairLifecycle(unrelated, {
      kind: 'proposal-created',
      attemptId: proposal.trajectoryId!,
      proposalId: proposal.proposalId!,
      ts: proposal.ts,
    })).toMatchObject({ available: false, disposition: 'active', recorded: false });
  });

  it('refuses sibling receipt recovery when the V1/V2 handoff family is degraded', () => {
    const legacy = diagnosticRepairItem('local-coder', 'mid', 1, ':degraded-receipt-alias');
    const current = diagnosticRepairItem('local-coder', 'mid', 2, ':degraded-receipt-alias');
    const proposal = diagnosticProposalEvent(
      legacy, ATTEMPT_TWO, 'prop-degraded-v1-receipt', 'local-coder', 'mid', 1,
    );
    persistDurableProposal(legacy, proposal);
    expect(recordDispatchProduction(proposal)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    writeFileSync(repairHandoffJournalPath(), '{"degraded":true}\n', { mode: 0o600 });

    expect(recordGeneratedRepairLifecycle(current, {
      kind: 'proposal-created',
      attemptId: proposal.trajectoryId!,
      proposalId: proposal.proposalId!,
      ts: proposal.ts,
    })).toMatchObject({ available: false, disposition: 'active', recorded: false });
  });

  it.each(['root', 'depth', 'backend', 'tier', 'handoff', 'generation'] as const)(
    'rejects an ordinal-two proposal backed by unrelated alias %s authority',
    (conflict) => {
      const legacy = diagnosticRepairItem('local-coder', 'mid', 1, `:alias-refusal-${conflict}`);
      const current = diagnosticRepairItem('local-coder', 'mid', 2, `:alias-refusal-${conflict}`);
      for (const item of [legacy, current]) {
        item.repairRootId = 'd'.repeat(64);
        item.repairRootAuthorityId = `m360:alias-refusal-${conflict}`;
        item.repairDepth = 0;
      }
      let failure = diagnosticFailureEvent(legacy, ATTEMPT_TWO, 'engine-failed');
      if (conflict === 'root') failure.repairRootId = 'e'.repeat(64);
      if (conflict === 'depth') failure.repairDepth = 1;
      if (conflict === 'backend') {
        failure.backend = 'codex';
        failure.routeSnapshot = { ...failure.routeSnapshot!, backend: 'codex' };
      }
      if (conflict === 'tier') {
        failure.tier = 'frontier';
        failure.routeSnapshot = { ...failure.routeSnapshot!, tier: 'frontier' };
      }
      if (conflict === 'handoff') {
        const unrelated = diagnosticRepairItem('local-coder', 'mid', 2, ':unrelated-handoff');
        failure = diagnosticFailureEvent(unrelated, ATTEMPT_TWO, 'engine-failed');
        failure.itemId = current.id;
        failure.objectiveHash = workItemObjectiveHash(current);
        failure.repairTreatmentUnitId = current.repairTreatmentUnitId;
        failure.repairTreatment = current.repairTreatment;
        failure.repairRootId = current.repairRootId;
        failure.repairDepth = current.repairDepth;
      }
      if (conflict === 'generation') {
        failure.repairHandoffId = 'f'.repeat(64);
        failure.repairGenerationId = repairGenerationIdFromHandoffId(failure.repairHandoffId);
      }
      expect(recordDispatchProduction(failure)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
      const proposal = diagnosticProposalEvent(
        current, ATTEMPT_THREE, `prop-alias-refusal-${conflict}`, 'kimi', 'mid', 2,
      );
      proposal.repairPreviousBackend = 'local-coder';
      persistDurableProposal(current, proposal);
      expect(recordDispatchProduction(proposal)).toEqual({ attempted: 1, recorded: 1, failed: 0 });

      expect(recordGeneratedRepairLifecycle(current, {
        kind: 'proposal-created',
        attemptId: proposal.trajectoryId!,
        proposalId: proposal.proposalId!,
        ts: proposal.ts,
      })).toMatchObject({ available: false, disposition: 'active', recorded: false });
    },
  );

  it.each([
    {
      name: 'previous backend',
      mutate: (_item: WorkItem, _failure: DispatchProductionEvent, alternate: DispatchProductionEvent) => {
        alternate.repairPreviousBackend = 'codex';
      },
    },
    {
      name: 'tier',
      mutate: (_item: WorkItem, failure: DispatchProductionEvent) => {
        failure.tier = 'frontier';
        failure.routeSnapshot = { ...failure.routeSnapshot!, tier: 'frontier' };
      },
    },
    {
      name: 'root',
      mutate: (_item: WorkItem, failure: DispatchProductionEvent) => {
        failure.repairRootId = 'e'.repeat(64);
      },
    },
    {
      name: 'depth',
      mutate: (_item: WorkItem, failure: DispatchProductionEvent) => {
        failure.repairDepth = 1;
      },
    },
  ])('rejects ordinal-two treatment when canonical failure $name authority conflicts', ({ mutate }) => {
    const item = diagnosticRepairItem();
    item.repairRootId = 'd'.repeat(64);
    item.repairRootAuthorityId = 'm360:conflicting-failed-predecessor';
    item.repairDepth = 0;
    const failure = diagnosticFailureEvent(item, ATTEMPT_TWO, 'engine-failed');
    const alternate = diagnosticEmptyEvent(item, ATTEMPT_THREE, 'kimi', 'mid', 2);
    alternate.repairPreviousBackend = 'local-coder';
    mutate(item, failure, alternate);
    expect(recordDispatchProduction(failure)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(recordDispatchProduction(alternate)).toEqual({ attempted: 1, recorded: 1, failed: 0 });

    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'dispatch-proof-empty-diff',
      eventTs: alternate.ts,
    })).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
      recorded: false,
    });
    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
  });

  it('rejects ordinal-two treatment when ordinal-one failed attempt authority is ambiguous', () => {
    const item = diagnosticRepairItem();
    item.repairRootId = 'd'.repeat(64);
    item.repairRootAuthorityId = 'm360:ambiguous-failed-predecessor';
    item.repairDepth = 0;
    const failures = [ATTEMPT_ONE, ATTEMPT_TWO].map((attemptId, index) =>
      diagnosticFailureEvent(
        item,
        attemptId,
        'engine-failed',
        'local-coder',
        'mid',
        `2026-07-10T13:0${index}:00.000Z`,
      ));
    expect(recordDispatchProduction(failures)).toEqual({ attempted: 2, recorded: 2, failed: 0 });
    const alternate = diagnosticEmptyEvent(item, ATTEMPT_THREE, 'kimi', 'mid', 2);
    alternate.repairPreviousBackend = 'local-coder';
    expect(recordDispatchProduction(alternate)).toEqual({ attempted: 1, recorded: 1, failed: 0 });

    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'dispatch-proof-empty-diff',
      eventTs: alternate.ts,
    })).toMatchObject({ available: false, disposition: 'active', recorded: false });
    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
  });

  it('routes the first repair normally and a proven empty retry through a different same-tier backend', () => {
    const item = diagnosticRepairItem();
    const cfg = {
      version: 1,
      roots: ['/tmp'],
      editor: 'cursor',
      staleDays: 30,
      categories: {},
      tidyRules: [],
      keepers: [],
      models: { lmstudio: '', ollama: '', providerChain: [] },
      telemetry: {},
      tools: {},
      foundry: { allowedBackends: ['local-coder', 'kimi'] },
    } as import('../src/core/types.js').AshlrConfig;

    expect(routeBackend(item, cfg)).toMatchObject({ backend: 'local-coder', tier: 'mid' });
    recordDiagnosticEmpty(item, ATTEMPT_TWO, 'local-coder', 'mid', 1);
    expect(routeBackend(item, cfg)).toMatchObject({
      backend: 'kimi',
      tier: 'mid',
      reason: expect.stringContaining('repair-alternative-selected'),
    });
  });

  it('requires a same-tier alternate for proposal and capture repair retries', () => {
    const cfg = {
      version: 1,
      roots: ['/tmp'],
      editor: 'cursor',
      staleDays: 30,
      categories: {},
      tidyRules: [],
      keepers: [],
      models: { lmstudio: '', ollama: '', providerChain: [] },
      telemetry: {},
      tools: {},
      foundry: { allowedBackends: ['local-coder', 'kimi'] },
    } as import('../src/core/types.js').AshlrConfig;
    for (const item of [repairItem(), captureRepairItem()]) {
      expect(recordGeneratedRepairLifecycle(item, {
        kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder', tier: 'mid',
      })).toMatchObject({ available: true, disposition: 'active', authoritativeEmptyRuns: 1 });
      expect(generatedRepairRetryPolicy(item)).toMatchObject({
        applies: true,
        available: true,
        requireAlternative: true,
        excludedBackend: 'local-coder',
        requiredTier: 'mid',
      });
      expect(routeBackend(item, cfg)).toMatchObject({ backend: 'kimi', tier: 'mid' });
      expect(recordGeneratedRepairLifecycle(item, {
        kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'local-coder', tier: 'mid',
      })).toMatchObject({ available: false, disposition: 'active', recorded: false });
    }
  });

  it('promotes only fresh trusted ordinary repairs while preserving retry tier authority', () => {
    const cfg = {
      version: 1,
      roots: ['/tmp'],
      editor: 'cursor',
      staleDays: 30,
      categories: {},
      tidyRules: [],
      keepers: [],
      models: { lmstudio: '', ollama: '', providerChain: [] },
      telemetry: {},
      tools: {},
      foundry: {
        allowedBackends: ['nim', 'local-coder'],
        engines: {
          nim: { id: 'nim', kind: 'cli-agent', tier: 'frontier', bin: 'node', argv: ['$GOAL'] },
          'local-coder': { id: 'local-coder', kind: 'cli-agent', tier: 'mid', bin: 'node', argv: ['$GOAL'] },
        },
      },
    } as import('../src/core/types.js').AshlrConfig;
    const item = repairItem({ id: 'repo:proposal-repair:111111111111' });
    const freshPolicy = readGeneratedRepairQueueSnapshot().retryPolicy(item);

    expect(routeBackend(item, cfg)).toMatchObject({
      backend: 'nim',
      tier: 'frontier',
      reason: expect.stringMatching(/^frontier: generated proposal repair/),
    });
    expect(inspectGeneratedRepairRouteFeasibility(item, cfg, freshPolicy)).toMatchObject({
      feasible: true,
      backend: 'nim',
      requiredTier: null,
      requiresAlternative: false,
    });

    const spoofed = repairItem({ id: 'repo:manual-repair' });
    expect(routeBackend(spoofed, cfg)).toMatchObject({
      backend: 'local-coder',
      tier: 'mid',
      reason: expect.stringMatching(/^local-mid bulk:/),
    });
    expect(inspectGeneratedRepairRouteFeasibility(spoofed, cfg, freshPolicy)).toMatchObject({
      feasible: true,
      backend: 'local-coder',
    });

    const midOnlyCfg = {
      ...cfg,
      foundry: { ...cfg.foundry, allowedBackends: ['local-coder'] },
    } as import('../src/core/types.js').AshlrConfig;
    expect(routeBackend(item, midOnlyCfg)).toMatchObject({ backend: 'local-coder', tier: 'mid' });

    recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder', tier: 'mid',
    });
    const retryPolicy = readGeneratedRepairQueueSnapshot().retryPolicy(item);
    const retryCfg = {
      ...cfg,
      foundry: { ...cfg.foundry, allowedBackends: ['nim', 'local-coder', 'kimi'] },
    } as import('../src/core/types.js').AshlrConfig;
    expect(retryPolicy).toMatchObject({ requireAlternative: true, requiredTier: 'mid' });
    expect(routeBackend(item, retryCfg)).toMatchObject({ backend: 'kimi', tier: 'mid' });
    expect(inspectGeneratedRepairRouteFeasibility(item, retryCfg, retryPolicy)).toMatchObject({
      feasible: true,
      backend: 'kimi',
      requiredTier: 'mid',
      requiresAlternative: true,
    });
  });

  it('inspects retry route feasibility from one read-only lifecycle snapshot', () => {
    const item = repairItem();
    const cfg = {
      version: 1,
      roots: ['/tmp'],
      editor: 'cursor',
      staleDays: 30,
      categories: {},
      tidyRules: [],
      keepers: [],
      models: { lmstudio: '', ollama: '', providerChain: [] },
      telemetry: {},
      tools: {},
      foundry: { allowedBackends: ['local-coder', 'kimi'] },
    } as import('../src/core/types.js').AshlrConfig;
    const fleetDir = dirname(generatedRepairLifecyclePath());
    expect(existsSync(fleetDir)).toBe(false);

    const initial = readGeneratedRepairQueueSnapshot();
    const initialPolicy = initial.retryPolicy(item);
    expect(initialPolicy).toMatchObject({ available: true, requireAlternative: false });
    expect(inspectGeneratedRepairRouteFeasibility(item, cfg, initialPolicy)).toMatchObject({
      feasible: true,
      reason: 'feasible',
    });
    expect(existsSync(fleetDir)).toBe(false);

    recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder', tier: 'mid',
    });
    expect(initial.retryPolicy(item)).toMatchObject({ requireAlternative: false });
    const retry = readGeneratedRepairQueueSnapshot().retryPolicy(item);
    expect(retry).toMatchObject({
      available: true,
      requireAlternative: true,
      excludedBackend: 'local-coder',
      requiredTier: 'mid',
    });
    expect(inspectGeneratedRepairRouteFeasibility(item, cfg, retry)).toMatchObject({
      feasible: true,
      backend: 'kimi',
      reason: 'feasible',
    });
    expect(inspectGeneratedRepairRouteFeasibility(item, {
      ...cfg,
      foundry: { allowedBackends: ['local-coder'] },
    }, retry)).toMatchObject({
      feasible: false,
      reason: 'same-tier-alternative-unavailable',
    });

    const repairOnlyCfg = { ...cfg, foundry: { allowedBackends: ['aw'] } } as import('../src/core/types.js').AshlrConfig;
    const fresh = repairItem({ id: 'repo:proposal-repair:777777777777' });
    const freshPolicy = readGeneratedRepairQueueSnapshot().retryPolicy(fresh);
    expect(inspectGeneratedRepairRouteFeasibility(fresh, repairOnlyCfg, freshPolicy)).toMatchObject({
      feasible: false,
      reason: 'editing-backend-unavailable',
    });
    expect(routeBackend(fresh, repairOnlyCfg)).toMatchObject({ backend: 'builtin' });

    recordUse('local-coder');
    const cappedCfg = {
      ...cfg,
      foundry: {
        allowedBackends: ['local-coder'],
        limits: { 'local-coder': { window: '1h', max: 1 } },
      },
    } as import('../src/core/types.js').AshlrConfig;
    expect(inspectGeneratedRepairRouteFeasibility(fresh, cappedCfg, freshPolicy)).toMatchObject({
      feasible: false,
      reason: 'route-capacity-unavailable',
    });

    const frontierItem = repairItem({
      id: 'repo:proposal-repair:888888888888',
      effort: 5,
      score: 10,
    });
    const frontierCfg = {
      ...cfg,
      foundry: { allowedBackends: ['claude', 'codex'] },
    } as import('../src/core/types.js').AshlrConfig;
    const selected = routeBackend(frontierItem, frontierCfg).backend;
    expect(['claude', 'codex']).toContain(selected);
    recordUse(selected);
    const selectedCappedCfg = {
      ...frontierCfg,
      foundry: {
        allowedBackends: ['claude', 'codex'],
        limits: { [selected]: { window: '1h', max: 1 } },
      },
    } as import('../src/core/types.js').AshlrConfig;
    const frontierPolicy = readGeneratedRepairQueueSnapshot().retryPolicy(frontierItem);
    expect(routeBackend(frontierItem, selectedCappedCfg).backend).toBe(selected);
    expect(inspectGeneratedRepairRouteFeasibility(
      frontierItem,
      selectedCappedCfg,
      frontierPolicy,
    )).toMatchObject({ feasible: false, reason: 'route-capacity-unavailable' });
  });

  it('rejects first parent-bound evidence that conflicts with durable routing tier', () => {
    const item = diagnosticRepairItem('local-coder', 'mid');

    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'codex', tier: 'frontier',
    })).toMatchObject({ available: false, disposition: 'active', recorded: false });
    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      authoritativeEmptyRuns: 0,
    });
  });

  it('never accepts builtin fallback as authoritative repair evidence', () => {
    for (const item of [repairItem(), captureRepairItem(), diagnosticRepairItem()]) {
      expect(recordGeneratedRepairLifecycle(item, {
        kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'builtin', tier: 'local',
      })).toMatchObject({ available: false, disposition: 'active', recorded: false });
      expect(readGeneratedRepairLifecycle(item)).toMatchObject({ authoritativeEmptyRuns: 0 });
    }
  });

  it('fails only the affected generation closed on persisted legacy builtin evidence', () => {
    const affected = repairItem({ id: 'repo:proposal-repair:555555555555' });
    const healthy = repairItem({ id: 'repo:proposal-repair:666666666666' });
    recordGeneratedRepairLifecycle(affected, {
      kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder', tier: 'mid',
    });
    recordGeneratedRepairLifecycle(healthy, {
      kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'kimi', tier: 'mid',
    });
    const path = generatedRepairLifecyclePath();
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      records: Array<{ generationId: string; emptyAttemptBackends?: string[] }>;
    };
    const affectedGeneration = parsed.records.find((record) =>
      record.generationId !== parsed.records.find((candidate) => candidate.emptyAttemptBackends?.[0] === 'kimi')?.generationId
    )!;
    affectedGeneration.emptyAttemptBackends = ['builtin'];
    writeFileSync(path, `${JSON.stringify(parsed)}\n`, 'utf8');

    expect(readGeneratedRepairLifecycle(affected)).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
    expect(readGeneratedRepairLifecycle(healthy)).toMatchObject({
      available: true,
      authoritativeEmptyRuns: 1,
      lastAuthoritativeEmptyBackend: 'kimi',
    });
  });

  it('terminalizes a different same-tier retry for proposal and capture repairs', () => {
    const items = [
      repairItem({ id: 'repo:proposal-repair:111111111111' }),
      captureRepairItem({ id: 'repo:proposal-repair-capture:222222222222' }),
    ];
    for (const item of items) {
      recordGeneratedRepairLifecycle(item, {
        kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder', tier: 'mid',
      });
      expect(recordGeneratedRepairLifecycle(item, {
        kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'kimi', tier: 'mid',
      })).toMatchObject({
        available: true,
        disposition: 'exhausted',
        authoritativeEmptyRuns: 2,
        authoritativeEmptyBackends: ['local-coder', 'kimi'],
        authoritativeEmptyTiers: ['mid', 'mid'],
        recorded: true,
      });
    }
  });

  it('rejects cross-tier retries for proposal and capture repairs', () => {
    const items = [
      repairItem({ id: 'repo:proposal-repair:333333333333' }),
      captureRepairItem({ id: 'repo:proposal-repair-capture:444444444444' }),
    ];
    for (const item of items) {
      recordGeneratedRepairLifecycle(item, {
        kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder', tier: 'mid',
      });
      expect(recordGeneratedRepairLifecycle(item, {
        kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'codex', tier: 'frontier',
      })).toMatchObject({ available: false, disposition: 'active', recorded: false });
      expect(readGeneratedRepairLifecycle(item)).toMatchObject({
        available: true,
        disposition: 'active',
        authoritativeEmptyRuns: 1,
        authoritativeEmptyTiers: ['mid'],
      });
    }
  });

  it('uses a config-promoted backend as an exact-tier retry alternative', () => {
    const item = diagnosticRepairItem('codex', 'frontier');
    const cfg = {
      version: 1,
      roots: ['/tmp'],
      editor: 'cursor',
      staleDays: 30,
      categories: {},
      tidyRules: [],
      keepers: [],
      models: { lmstudio: '', ollama: '', providerChain: [] },
      telemetry: {},
      tools: {},
      foundry: {
        allowedBackends: ['codex', 'kimi'],
        kimi: { tier: 'frontier' },
      },
    } as import('../src/core/types.js').AshlrConfig;
    recordDiagnosticEmpty(item, ATTEMPT_TWO, 'codex', 'frontier', 1);

    expect(routeBackend(item, cfg)).toMatchObject({
      backend: 'kimi',
      tier: 'frontier',
      reason: expect.stringContaining('repair-alternative-selected'),
    });
  });

  it('does not retire from caller-typed proposal input without durable proposal and attempt proof', () => {
    const item = repairItem();
    const transition = recordGeneratedRepairLifecycle(item, {
      kind: 'proposal-created',
      attemptId: ATTEMPT_ONE,
      proposalId: 'prop-generated-repair',
    });

    expect(transition).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
      recorded: false,
    });
    expect(readGeneratedRepairLifecycle(item)).toEqual({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
    expect(existsSync(generatedRepairLifecyclePath())).toBe(false);
  });

  it('retires an ordinary repair only after exact durable proposal and production binding', () => {
    const item = repairItem();
    const transition = recordOrdinaryProposal(item, ATTEMPT_ONE, 'prop-generated-repair');

    expect(transition).toMatchObject({
      available: true,
      disposition: 'retired',
      recorded: true,
    });
    expect(transition).not.toHaveProperty('treatmentOutcomeWitness');
    expect(readGeneratedRepairLifecycle(item).disposition).toBe('retired');
    expect(readGeneratedRepairTerminalOutcome(generatedRepairGenerationId(item)!)).toBeNull();
    expect(readPendingGeneratedRepairTreatmentOutcomes()).toMatchObject({
      available: true,
      prooflessLegacy: 0,
      requiredAction: null,
    });
    expect(readPendingGeneratedRepairTreatmentOutcomes()).toEqual([]);
  });

  it('fences exact proposal content through the lifecycle retirement commit', () => {
    const item = repairItem();
    const event = ordinaryProposalEvent(item, ATTEMPT_ONE, 'prop-retirement-authority-race');
    persistDurableProposal(item, event);
    expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    const proposalPath = join(inboxDir(), `${event.proposalId}.json`);
    let replacementAttempted = false;
    let replacementCommitted = false;
    _setGeneratedRepairLifecycleDirectoryFsyncHookForTest(() => {
      if (replacementAttempted) return;
      replacementAttempted = true;
      const proposalStoreLock = acquireProposalStoreMutationLock(0);
      if (!proposalStoreLock) return;
      try {
        const replacement = JSON.parse(readFileSync(proposalPath, 'utf8')) as Record<string, unknown>;
        replacement['title'] = 'Concurrent replacement with stale provenance';
        writeFileSync(proposalPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
        replacementCommitted = true;
      } finally {
        releaseProposalStoreMutationLock(proposalStoreLock);
      }
    });

    const transition = recordGeneratedRepairLifecycle(item, {
      kind: 'proposal-created',
      attemptId: event.trajectoryId!,
      proposalId: event.proposalId!,
      ts: event.ts,
    });
    _setGeneratedRepairLifecycleDirectoryFsyncHookForTest(undefined);

    expect(replacementAttempted).toBe(true);
    expect(replacementCommitted).toBe(false);
    expect(transition).toMatchObject({ available: true, disposition: 'retired', recorded: true });
    expect(JSON.parse(readFileSync(proposalPath, 'utf8'))).toMatchObject({
      title: 'Durable generated repair proposal',
    });
  });

  it('fences exactly-one ordinary proposal event authority through lifecycle save', () => {
    const item = repairItem();
    const event = ordinaryProposalEvent(item, ATTEMPT_ONE, 'prop-event-authority-race');
    persistDurableProposal(item, event);
    expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    let duplicateWrite: ReturnType<typeof recordDispatchProduction> | undefined;
    _setGeneratedRepairLifecycleRaceHooksForTest({
      ordinaryProposalAuthorityValidated: () => {
        duplicateWrite = recordDispatchProduction(event);
      },
    });

    const transition = recordGeneratedRepairLifecycle(item, {
      kind: 'proposal-created',
      attemptId: event.trajectoryId!,
      proposalId: event.proposalId!,
      ts: event.ts,
    });

    expect(duplicateWrite).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(transition).toMatchObject({ available: true, disposition: 'retired', recorded: true });
    const partition = join(dispatchProductionDir(), `${event.ts.slice(0, 10)}.jsonl`);
    expect(readFileSync(partition, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      disposition: 'retired',
    });
  });

  it('keeps immutable proposal receipt authority when raw analytics rows are duplicated', () => {
    const item = repairItem();
    const event = ordinaryProposalEvent(item, ATTEMPT_ONE, 'prop-duplicate-physical-row');
    persistDurableProposal(item, event);
    expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    const partition = join(dispatchProductionDir(), `${event.ts.slice(0, 10)}.jsonl`);
    writeFileSync(partition, `${readFileSync(partition, 'utf8')}${JSON.stringify(event)}\n`, {
      mode: 0o600,
    });

    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'proposal-created',
      attemptId: event.trajectoryId!,
      proposalId: event.proposalId!,
      ts: event.ts,
    })).toMatchObject({ available: true, disposition: 'retired', recorded: true });
    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      disposition: 'retired',
    });
  });

  it('settles and reads an ordinary proposal after capped and deleted raw analytics history', () => {
    const item = repairItem();
    const event = ordinaryProposalEvent(item, ATTEMPT_ONE, 'prop-receipt-over-raw-history');
    persistDurableProposal(item, event);
    expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    const partition = join(dispatchProductionDir(), `${event.ts.slice(0, 10)}.jsonl`);
    writeFileSync(partition, '\n'.repeat(50_001), { mode: 0o600 });
    truncateSync(partition, 33 * 1024 * 1024);

    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'proposal-created',
      attemptId: event.trajectoryId!,
      proposalId: event.proposalId!,
      ts: event.ts,
    })).toMatchObject({ available: true, disposition: 'retired', recorded: true });
    rmSync(partition);
    _resetGeneratedRepairLifecycleCacheForTest();
    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      disposition: 'retired',
    });
    expect(generatedRepairRetryPolicy(item)).toMatchObject({
      applies: true,
      available: false,
    });
  }, 30_000);

  it('settles an ordinary proposal after its raw analytics partition was rotated away', () => {
    const item = repairItem({ id: 'repo:proposal-repair:feedfacecafe' });
    const event = ordinaryProposalEvent(item, ATTEMPT_ONE, 'prop-receipt-after-rotation');
    persistDurableProposal(item, event);
    expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    rmSync(join(dispatchProductionDir(), `${event.ts.slice(0, 10)}.jsonl`));

    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'proposal-created',
      attemptId: event.trajectoryId!,
      proposalId: event.proposalId!,
      ts: event.ts,
    })).toMatchObject({ available: true, disposition: 'retired', recorded: true });
    _resetGeneratedRepairLifecycleCacheForTest();
    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      disposition: 'retired',
    });
  });

  it('rejects proposal admission when the event run differs from the durable proposal run', () => {
    const item = repairItem();
    const event = ordinaryProposalEvent(item, ATTEMPT_ONE, 'prop-run-binding');
    persistDurableProposal(item, event);
    const mismatchedEvent = { ...event, runId: 'different-durable-run' };
    expect(recordDispatchProduction(mismatchedEvent)).toEqual({
      attempted: 1, recorded: 1, failed: 0,
    });

    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'proposal-created',
      attemptId: event.trajectoryId!,
      proposalId: event.proposalId!,
      ts: event.ts,
    })).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
      recorded: false,
    });
    expect(existsSync(generatedRepairLifecyclePath())).toBe(false);
  });

  it('requires exact canonical proposal proof before retiring a diagnostic repair', () => {
    const item = diagnosticRepairItem();

    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'proposal-created',
      attemptId: ATTEMPT_TWO,
      proposalId: 'prop-unpublished-conversion',
      ts: '2026-07-10T13:00:00.000Z',
    })).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
      recorded: false,
    });
    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
  });

  it('stores an allowlisted metadata-only publication capsule for a proven conversion', () => {
    const item = diagnosticRepairItem();
    const transition = recordDiagnosticProposal(
      item,
      ATTEMPT_TWO,
      'prop-first-attempt-conversion',
      'local-coder',
      'mid',
      1,
    );

    expect(transition).toMatchObject({
      available: true,
      disposition: 'retired',
      authoritativeEmptyRuns: 0,
      recorded: true,
      treatmentOutcomeWitness: { outcome: 'converted' },
    });
    const stored = JSON.parse(readFileSync(generatedRepairLifecyclePath(), 'utf8')) as {
      records: Array<{ terminalAttemptProofReceipt: {
        publication: Record<string, unknown>;
      } }>;
    };
    const receipt = JSON.stringify(stored.records[0]!.terminalAttemptProofReceipt);
    const decoded = decodedStringCorpus(stored).join('\n');
    expect(receipt).toContain('eventDigest');
    expect(stored.records[0]).not.toHaveProperty('treatmentCandidate');
    expect(stored.records[0]!.terminalAttemptProofReceipt).not.toHaveProperty('eventBytes');
    expect(Object.keys(stored.records[0]!.terminalAttemptProofReceipt.publication).sort()).toEqual([
      'itemId', 'objectiveHash', 'outcome', 'proposalId', 'repo', 'schemaVersion', 'source', 'trajectoryId',
    ]);
    expect(stored.records[0]!.terminalAttemptProofReceipt.publication).toMatchObject({
      itemId: item.id,
      repo: item.repo,
      proposalId: 'prop-first-attempt-conversion',
      trajectoryId: `run:${ATTEMPT_TWO}`,
    });
    for (const rawText of [
      item.title,
      item.detail,
      'test diagnostic attempt 1',
      'Failure:',
      'stdout',
      'stderr',
      'environment',
    ]) expect(decoded).not.toContain(rawText);
  });

  it('retires a diagnostic conversion on a proven alternative second attempt', () => {
    const item = diagnosticRepairItem();
    recordDiagnosticEmpty(item, ATTEMPT_TWO, 'local-coder', 'mid', 1);
    const transition = recordDiagnosticProposal(
      item,
      ATTEMPT_THREE,
      'prop-second-attempt-conversion',
      'kimi',
      'mid',
      2,
    );

    expect(transition).toMatchObject({
      available: true,
      disposition: 'retired',
      authoritativeEmptyRuns: 1,
      authoritativeEmptyBackends: ['local-coder'],
      recorded: true,
      treatmentOutcomeWitness: { outcome: 'converted' },
    });
    expect(publishGeneratedRepairTreatmentOutcome(
      item.repairGenerationId!,
      transition.treatmentOutcomeWitness!.attemptHash,
    )).toBe(true);
    expect(readDispatchProductionEvents()).toContainEqual(expect.objectContaining({
      basis: 'repair-lifecycle-outcome',
      repairAttemptOrdinal: 2,
      repairPreviousBackend: 'local-coder',
      repairTreatmentOutcome: 'converted',
    }));
  });

  it('keeps a proven converted witness pending until exact immutable publication', () => {
    const item = diagnosticRepairItem();
    const transition = recordDiagnosticProposal(
      item,
      ATTEMPT_TWO,
      'prop-treatment-outbox',
      'local-coder',
      'mid',
      1,
    );

    const pending = readPendingGeneratedRepairTreatmentOutcomes();
    expect(pending.available).toBe(true);
    expect(pending).toEqual([expect.objectContaining({
      generationId: item.repairGenerationId,
      attemptHash: transition.treatmentOutcomeWitness!.attemptHash,
      outcome: 'converted',
      candidate: expect.objectContaining({ itemId: item.id }),
    })]);
    const acknowledgedAt = '2026-07-10T14:00:00.000Z';
    expect(acknowledgeGeneratedRepairTreatmentOutcome(
      item.repairGenerationId!,
      transition.treatmentOutcomeWitness!.attemptHash,
      acknowledgedAt,
    )).toBe(false);
    expect(recordDispatchProduction({
      ...pending[0]!.candidate,
      ts: acknowledgedAt,
      basis: 'repair-lifecycle-outcome',
      repairTreatmentOutcome: 'converted',
      repairTreatmentAttemptHash: transition.treatmentOutcomeWitness!.attemptHash,
    })).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(acknowledgeGeneratedRepairTreatmentOutcome(
      item.repairGenerationId!,
      transition.treatmentOutcomeWitness!.attemptHash,
      '2026-07-10T14:00:01.000Z',
    )).toBe(false);
    expect(acknowledgeGeneratedRepairTreatmentOutcome(
      item.repairGenerationId!,
      transition.treatmentOutcomeWitness!.attemptHash,
      acknowledgedAt,
    )).toBe(true);
    const drained = readPendingGeneratedRepairTreatmentOutcomes();
    expect(drained.available).toBe(true);
    expect(drained).toEqual([]);
    const compact = (JSON.parse(readFileSync(generatedRepairLifecyclePath(), 'utf8')) as {
      records: Array<Record<string, unknown>>;
    }).records[0]!;
    expect(compact).toMatchObject({
      treatmentWitnessRecordedAt: acknowledgedAt,
      treatmentWitnessDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(compact).not.toHaveProperty('emptyAttemptProofReceipts');
    expect(compact).toHaveProperty('terminalAttemptProofReceipt.publication');
    expect(readGeneratedRepairLifecycle(item)).toMatchObject({ available: true, disposition: 'retired' });
    expect(readDispatchProductionEvents()).toContainEqual(expect.objectContaining({
      basis: 'repair-lifecycle-outcome',
      repairTreatmentOutcome: 'converted',
      proposalId: 'prop-treatment-outbox',
    }));
    const treatmentReceipt = join(
      dispatchProductionDir(),
      'repair-treatment-outcomes',
      `${item.repairGenerationId}-${transition.treatmentOutcomeWitness!.attemptHash}.json`,
    );
    const tampered = JSON.parse(readFileSync(treatmentReceipt, 'utf8')) as Record<string, unknown>;
    tampered['routeReason'] = 'tampered acknowledged receipt';
    writeFileSync(treatmentReceipt, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
    expect(readGeneratedRepairTerminalOutcome(item.repairGenerationId!)).toBeNull();
    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: false,
      unavailableReason: 'proofless-legacy',
      requiredAction: 'operator-reset',
    });
  });

  it('fences proposal deletion through immutable treatment receipt publication', () => {
    const item = diagnosticRepairItem();
    const proposalId = 'prop-publication-authority-race';
    const transition = recordDiagnosticProposal(
      item,
      ATTEMPT_TWO,
      proposalId,
      'local-coder',
      'mid',
      1,
    );
    const proposalPath = join(inboxDir(), `${proposalId}.json`);
    const receiptPath = join(
      dispatchProductionDir(),
      'repair-treatment-outcomes',
      `${item.repairGenerationId}-${transition.treatmentOutcomeWitness!.attemptHash}.json`,
    );
    let deletionAttempted = false;
    let deletionCommitted = false;
    _setGeneratedRepairLifecycleDirectoryFsyncHookForTest(() => {
      if (deletionAttempted || !existsSync(receiptPath)) return;
      deletionAttempted = true;
      const proposalStoreLock = acquireProposalStoreMutationLock(0);
      if (!proposalStoreLock) return;
      try {
        rmSync(proposalPath);
        deletionCommitted = true;
      } finally {
        releaseProposalStoreMutationLock(proposalStoreLock);
      }
    });

    expect(publishGeneratedRepairTreatmentOutcome(
      item.repairGenerationId!,
      transition.treatmentOutcomeWitness!.attemptHash,
    )).toBe(true);
    _setGeneratedRepairLifecycleDirectoryFsyncHookForTest(undefined);

    expect(deletionAttempted).toBe(true);
    expect(deletionCommitted).toBe(false);
    expect(existsSync(proposalPath)).toBe(true);
    expect(existsSync(receiptPath)).toBe(true);
    expect(readGeneratedRepairTerminalOutcome(item.repairGenerationId!)).toMatchObject({
      outcome: 'converted',
      disposition: 'retired',
    });
  });

  it('excludes a current-writer non-diagnostic terminal candidate from the treatment outbox', () => {
    const item = handoffCaptureRepairItem();
    const source = ordinaryProposalEvent(
      item,
      ATTEMPT_TWO,
      'prop-unproven-current-writer',
    );
    const candidate: DispatchProductionEvent = {
      ...source,
      basis: 'repair-lifecycle-candidate',
      repairTreatmentAttemptHash: generatedRepairLifecycleAttemptHash(source.trajectoryId!),
    };
    persistDurableProposal(item, source);
    expect(recordDispatchProduction(source)).toEqual({ attempted: 1, recorded: 1, failed: 0 });

    const transition = recordGeneratedRepairLifecycle(item, {
      kind: 'proposal-created',
      attemptId: source.trajectoryId!,
      proposalId: source.proposalId!,
      ts: source.ts,
      treatmentCandidate: candidate,
    });
    expect(transition).toMatchObject({ available: true, disposition: 'retired', recorded: true });
    expect(transition).not.toHaveProperty('treatmentOutcomeWitness');

    const pending = readPendingGeneratedRepairTreatmentOutcomes();
    expect(pending.available).toBe(true);
    expect(pending.prooflessLegacy).toBe(0);
    expect(pending.requiredAction).toBeNull();
    expect(pending).toEqual([]);
    expect(publishGeneratedRepairTreatmentOutcome(
      item.repairGenerationId!,
      generatedRepairLifecycleAttemptHash(source.trajectoryId!),
    )).toBe(false);
  });

  it('publishes from a durable lifecycle witness after source attempt proof retention', () => {
    const item = diagnosticRepairItem();
    const transition = recordDiagnosticProposal(
      item,
      ATTEMPT_TWO,
      'prop-pruned-source-proof',
      'local-coder',
      'mid',
      1,
    );
    retireAttemptProofGeneration(item, '2026-07-10T13:00:00.000Z');
    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      disposition: 'retired',
    });
    expect(readPendingGeneratedRepairTreatmentOutcomes()).toHaveLength(1);
    expect(publishGeneratedRepairTreatmentOutcome(
      item.repairGenerationId!,
      transition.treatmentOutcomeWitness!.attemptHash,
    )).toBe(true);
    expect(readPendingGeneratedRepairTreatmentOutcomes()).toEqual([]);
  });

  it('keeps terminal alias authority and publication markers when a newer alias is active', () => {
    const legacyItem = diagnosticRepairItem('local-coder', 'mid', 1);
    const transition = recordDiagnosticProposal(
      legacyItem,
      ATTEMPT_TWO,
      'prop-terminal-alias-authority',
      'local-coder',
      'mid',
      1,
    );
    expect(publishGeneratedRepairTreatmentOutcome(
      legacyItem.repairGenerationId!,
      transition.treatmentOutcomeWitness!.attemptHash,
    )).toBe(true);
    const currentItem = diagnosticRepairItem('local-coder', 'mid', 2);
    const path = generatedRepairLifecyclePath();
    const ledger = JSON.parse(readFileSync(path, 'utf8')) as {
      schemaVersion: number;
      records: Array<Record<string, unknown>>;
    };
    const terminal = ledger.records[0]!;
    expect(terminal).toMatchObject({
      generationId: legacyItem.repairGenerationId,
      disposition: 'retired',
      terminalAttemptHash: transition.treatmentOutcomeWitness!.attemptHash,
      terminalAttemptProofReceipt: expect.any(Object),
      proposalAuthority: expect.any(Object),
      treatmentWitnessRecordedAt: '2026-07-10T13:00:00.000Z',
      treatmentWitnessDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    ledger.records.push({
      generationId: currentItem.repairGenerationId,
      disposition: 'active',
      emptyAttemptHashes: [],
      emptyAttemptBackends: [],
      emptyAttemptTiers: [],
      updatedAt: '2026-07-10T15:00:00.000Z',
    });
    writeFileSync(path, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
    _resetGeneratedRepairLifecycleCacheForTest();

    expect(readGeneratedRepairLifecycle(currentItem)).toMatchObject({
      available: true,
      disposition: 'retired',
      authoritativeEmptyRuns: 0,
    });
    const pending = readPendingGeneratedRepairTreatmentOutcomes();
    expect(pending.available).toBe(true);
    expect(pending).toEqual([]);
    expect(readGeneratedRepairTerminalOutcome(legacyItem.repairGenerationId!)).toMatchObject({
      outcome: 'converted',
      attemptHash: transition.treatmentOutcomeWitness!.attemptHash,
    });
  });

  it('rejects conflicting terminal values and authority pairs across aliases', () => {
    const legacyItem = diagnosticRepairItem('local-coder', 'mid', 1);
    const transition = recordDiagnosticProposal(
      legacyItem,
      ATTEMPT_TWO,
      'prop-conflicting-terminal-alias',
      'local-coder',
      'mid',
      1,
    );
    expect(publishGeneratedRepairTreatmentOutcome(
      legacyItem.repairGenerationId!,
      transition.treatmentOutcomeWitness!.attemptHash,
    )).toBe(true);
    const currentItem = diagnosticRepairItem('local-coder', 'mid', 2);
    const path = generatedRepairLifecyclePath();
    const base = JSON.parse(readFileSync(path, 'utf8')) as {
      schemaVersion: number;
      records: Array<Record<string, unknown>>;
    };
    const terminal = base.records[0]!;
    const mutations: Array<(record: Record<string, unknown>) => void> = [
      (record) => {
        record['terminalAttemptHash'] = 'f'.repeat(64);
        delete record['terminalAttemptProofReceipt'];
      },
      (record) => {
        const receipt = record['terminalAttemptProofReceipt'] as Record<string, unknown>;
        receipt['sourceRetirementEpoch'] = Number(receipt['sourceRetirementEpoch']) + 1;
      },
      (record) => {
        const authority = record['proposalAuthority'] as Record<string, unknown>;
        authority['contentDigest'] = 'e'.repeat(64);
        authority['bindingDigest'] = createHash('sha256').update(JSON.stringify([
          'ashlr:generated-repair-proposal-authority:v1',
          authority['proposalIdHash'],
          authority['trajectoryIdHash'],
          authority['eventTs'],
          authority['eventDigest'],
          authority['contentDigest'],
        ]), 'utf8').digest('hex');
      },
      (record) => {
        record['treatmentWitnessRecordedAt'] = '2026-07-10T13:00:01.000Z';
      },
    ];
    for (const mutate of mutations) {
      const conflict = structuredClone(terminal);
      conflict['generationId'] = currentItem.repairGenerationId;
      conflict['updatedAt'] = '2026-07-10T15:00:00.000Z';
      mutate(conflict);
      writeFileSync(path, `${JSON.stringify({
        schemaVersion: 2,
        records: [terminal, conflict],
      })}\n`, { mode: 0o600 });
      _resetGeneratedRepairLifecycleCacheForTest();
      expect(readGeneratedRepairLifecycle(currentItem)).toEqual({
        available: false,
        disposition: 'active',
        authoritativeEmptyRuns: 0,
      });
    }
  });

  it('publishes an ordinal-2 retained proof at the writer retention cutoff', () => {
    const item = diagnosticRepairItem();
    recordDiagnosticEmpty(item, ATTEMPT_TWO, 'local-coder', 'mid', 1);
    const transition = recordDiagnosticProposal(
      item,
      ATTEMPT_THREE,
      'prop-retained-second-attempt',
      'kimi',
      'mid',
      2,
    );
    const droppedThrough = '2026-07-10T14:00:00.000Z';
    retireAttemptProofGeneration(item, droppedThrough);
    const retention = JSON.parse(readFileSync(
      join(dispatchProductionDir(), 'repair-attempt-proofs', '.retention.json'),
      'utf8',
    )) as { droppedThrough: string };

    expect(retention.droppedThrough).toBe(droppedThrough);
    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      disposition: 'retired',
      authoritativeEmptyRuns: 1,
    });
    expect(readPendingGeneratedRepairTreatmentOutcomes()).toHaveLength(1);
    expect(publishGeneratedRepairTreatmentOutcome(
      item.repairGenerationId!,
      transition.treatmentOutcomeWitness!.attemptHash,
    )).toBe(true);
    expect(readPendingGeneratedRepairTreatmentOutcomes()).toEqual([]);
  });

  it('does not let retention hide an exact tampered attempt receipt', () => {
    const item = diagnosticRepairItem();
    recordDiagnosticEmpty(item, ATTEMPT_TWO, 'local-coder', 'mid', 1);
    const attemptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
    const receiptPath = join(attemptDir, `${item.repairGenerationId}-1.json`);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
      event: { routeReason: string };
    };
    receipt.event.routeReason = 'tampered exact receipt under retention';
    writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    writeFileSync(join(attemptDir, '.retention.json'), `${JSON.stringify({
      schemaVersion: 2,
      droppedThrough: '2026-07-10T13:00:00.000Z',
      pendingGenerations: [],
    })}\n`, { mode: 0o600 });

    expect(readGeneratedRepairLifecycle(item)).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
  });

  it('does not let retirement hide an extant malformed exact attempt receipt', () => {
    const item = diagnosticRepairItem();
    const transition = recordDiagnosticProposal(
      item, ATTEMPT_TWO, 'prop-retired-malformed', 'local-coder', 'mid', 1,
    );
    const pending = readPendingGeneratedRepairTreatmentOutcomes()[0]!;
    expect(recordDispatchProduction({
      ...pending.candidate,
      basis: 'repair-lifecycle-outcome',
      repairTreatmentOutcome: 'converted',
      repairTreatmentAttemptHash: transition.treatmentOutcomeWitness!.attemptHash,
    })).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    rmSync(join(dispatchProductionDir(), 'repair-treatment-outcomes'), { recursive: true, force: true });
    const attemptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
    writeFileSync(
      join(attemptDir, `${item.repairGenerationId}-1.json`),
      '{"malformed":"retired protocol crash"}\n',
      { mode: 0o600 },
    );
    writeFileSync(join(attemptDir, '.retention.json'), `${JSON.stringify({
      schemaVersion: 2,
      droppedThrough: '2026-07-10T13:00:00.000Z',
      pendingGenerations: [],
    })}\n`, { mode: 0o600 });

    const unavailable = readPendingGeneratedRepairTreatmentOutcomes();
    expect(unavailable.available).toBe(false);
    expect(unavailable.requiredAction).toBe('operator-reset');
    expect(unavailable).toEqual([]);
    expect(publishGeneratedRepairTreatmentOutcome(
      item.repairGenerationId!, transition.treatmentOutcomeWitness!.attemptHash,
    )).toBe(false);
  });

  it('first-publishes from the capsule beyond the raw partition byte and row limits', () => {
    const item = diagnosticRepairItem();
    const transition = recordDiagnosticProposal(
      item,
      ATTEMPT_TWO,
      'prop-oversized-partition',
      'local-coder',
      'mid',
      1,
      '2026-07-11T13:00:00.000Z',
    );
    const partition = join(dispatchProductionDir(), '2026-07-11.jsonl');
    writeFileSync(partition, '\n'.repeat(50_001), { mode: 0o600 });
    truncateSync(partition, 33 * 1024 * 1024);
    expect(statSync(partition).size).toBeGreaterThan(32 * 1024 * 1024);
    expect(readPendingGeneratedRepairTreatmentOutcomes()).toHaveLength(1);
    expect(publishGeneratedRepairTreatmentOutcome(
      item.repairGenerationId!, transition.treatmentOutcomeWitness!.attemptHash,
    )).toBe(true);
  }, 30_000);

  it('reports a proofless legacy terminal row without mutating or publishing it', () => {
    const item = diagnosticRepairItem();
    const transition = recordDiagnosticProposal(
      item,
      ATTEMPT_TWO,
      'prop-legacy-proofless-outbox',
      'local-coder',
      'mid',
      1,
    );
    const path = generatedRepairLifecyclePath();
    const exact = readPendingGeneratedRepairTreatmentOutcomes()[0]!;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      records: Array<Record<string, unknown>>;
    };
    delete parsed.records[0]!['terminalAttemptProofReceipt'];
    writeFileSync(path, `${JSON.stringify(parsed)}\n`, 'utf8');
    const before = readFileSync(path, 'utf8');
    expect(readGeneratedRepairTerminalOutcome(item.repairGenerationId!)).toBeNull();
    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: false,
      unavailableReason: 'proofless-legacy',
      requiredAction: 'operator-reset',
    });
    expect(recordDispatchProduction({
      ...exact.candidate,
      basis: 'repair-lifecycle-outcome',
      repairTreatmentOutcome: 'converted',
      repairTreatmentAttemptHash: transition.treatmentOutcomeWitness!.attemptHash,
    })).toEqual({ attempted: 1, recorded: 1, failed: 0 });

    const pending = readPendingGeneratedRepairTreatmentOutcomes();
    expect(pending.available).toBe(false);
    expect(pending.prooflessLegacy).toBe(1);
    expect(pending.requiredAction).toBe('operator-reset');
    expect(pending).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(publishGeneratedRepairTreatmentOutcome(
      item.repairGenerationId!,
      transition.treatmentOutcomeWitness!.attemptHash,
    )).toBe(false);
    expect(acknowledgeGeneratedRepairTreatmentOutcome(
      item.repairGenerationId!,
      transition.treatmentOutcomeWitness!.attemptHash,
      exact.candidate.ts,
    )).toBe(false);
    expect(readPendingGeneratedRepairTreatmentOutcomes()).toEqual([]);
    expect(readDispatchProductionEvents().filter((event) =>
      event.basis === 'repair-lifecycle-outcome' &&
      event.repairGenerationId === item.repairGenerationId)).toHaveLength(1);
  });

  it('keeps a legacy write-failure marker operator-actionable and fail-closed', () => {
    const item = diagnosticRepairItem();
    const transition = recordDiagnosticProposal(
      item,
      ATTEMPT_TWO,
      'prop-acknowledgement-recovery',
      'local-coder',
      'mid',
      1,
    );
    const generationId = item.repairGenerationId!;
    const attemptHash = transition.treatmentOutcomeWitness!.attemptHash;
    const path = generatedRepairLifecyclePath();
    writeFileSync(`${path}.failed`, 'lifecycle write failed\n', { encoding: 'utf8', mode: 0o600 });

    const pending = readPendingGeneratedRepairTreatmentOutcomes();
    expect(pending.available).toBe(false);
    expect(pending.requiredAction).toBe('operator-reset');
    expect(pending).toEqual([]);
    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: false,
      unavailableReason: 'storage-recovery-required',
      requiredAction: 'operator-reset',
    });
    expect(publishGeneratedRepairTreatmentOutcome(generationId, attemptHash)).toBe(false);
    expect(existsSync(`${path}.failed`)).toBe(true);
  });

  it('rolls back a failed active save before allowing the same attempt to retry', () => {
    const item = repairItem();
    const candidate = recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff',
      attemptId: ATTEMPT_ONE,
      backend: 'local-coder',
      tier: 'mid',
    });
    expect(candidate).toMatchObject({ recorded: true, authoritativeEmptyRuns: 1 });
    const path = generatedRepairLifecyclePath();
    const candidateBytes = readFileSync(path);
    installFailedLifecycleWrite(null, candidateBytes);

    expect(readGeneratedRepairLifecycle(item)).toEqual({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.failed`)).toBe(false);
    expect(existsSync(`${path}.rollback`)).toBe(false);
    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff',
      attemptId: ATTEMPT_ONE,
      backend: 'local-coder',
      tier: 'mid',
    })).toMatchObject({ recorded: true, authoritativeEmptyRuns: 1 });
  });

  it('does not adopt a failed terminal candidate during lifecycle recovery', () => {
    const item = repairItem();
    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff',
      attemptId: ATTEMPT_ONE,
      backend: 'local-coder',
      tier: 'mid',
    })).toMatchObject({ recorded: true, authoritativeEmptyRuns: 1 });
    const path = generatedRepairLifecyclePath();
    const prior = readFileSync(path);
    const terminal = recordOrdinaryProposal(
      item, ATTEMPT_TWO, 'prop-failed-terminal-candidate', '2026-07-10T14:00:00.000Z',
    );
    expect(terminal).toMatchObject({ recorded: true, disposition: 'retired' });
    const candidate = readFileSync(path);
    installFailedLifecycleWrite(prior, candidate);

    expect(terminal).not.toHaveProperty('treatmentOutcomeWitness');
    expect(readGeneratedRepairTerminalOutcome(generatedRepairGenerationId(item)!)).toBeNull();
    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 1,
    });
    expect(readFileSync(path)).toEqual(prior);
  });

  it('finishes rollback after the prewritten snapshot was renamed under storage pressure', () => {
    const item = repairItem();
    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder', tier: 'mid',
    })).toMatchObject({ recorded: true });
    const path = generatedRepairLifecyclePath();
    const prior = readFileSync(path);
    expect(recordOrdinaryProposal(
      item, ATTEMPT_TWO, 'prop-storage-pressure', '2026-07-10T14:00:00.000Z',
    )).toMatchObject({ recorded: true, disposition: 'retired' });
    const candidate = readFileSync(path);
    installFailedLifecycleWrite(prior, candidate);
    writeFileSync(path, prior, { mode: 0o600 });
    rmSync(`${path}.rollback`);

    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true, disposition: 'active', authoritativeEmptyRuns: 1,
    });
    expect(existsSync(`${path}.failed`)).toBe(false);
  });

  it('recovers a marker written before the rollback rename without allocating a snapshot', () => {
    const item = repairItem();
    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder', tier: 'mid',
    })).toMatchObject({ recorded: true });
    const path = generatedRepairLifecyclePath();
    const prior = readFileSync(path);
    const candidate = Buffer.from(`${prior.toString('utf8').trim()} `, 'utf8');
    const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    writeFileSync(`${path}.failed`, `${JSON.stringify({
      schemaVersion: 1,
      kind: 'rollback-required',
      priorLedgerExisted: true,
      priorLedgerDigest: digest(prior),
      candidateDigest: digest(candidate),
    })}\n`, { mode: 0o600 });
    rmSync(`${path}.rollback`, { force: true });

    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 1,
    });
    expect(readFileSync(path)).toEqual(prior);
    expect(existsSync(`${path}.failed`)).toBe(false);
  });

  it('withholds terminal success while committed-candidate cleanup recovery is pending', () => {
    const item = repairItem();
    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder', tier: 'mid',
    })).toMatchObject({ recorded: true, authoritativeEmptyRuns: 1 });
    const path = generatedRepairLifecyclePath();
    const prior = readFileSync(path);
    let fsyncs = 0;
    _setGeneratedRepairLifecycleDirectoryFsyncHookForTest(() => {
      fsyncs++;
      if (fsyncs === 5 || fsyncs === 6) {
        const error = new Error('simulated repeated ENOSPC during committed cleanup') as NodeJS.ErrnoException;
        error.code = 'ENOSPC';
        throw error;
      }
    });

    const committed = recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'kimi', tier: 'mid',
    });
    expect(committed).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
      recorded: false,
    });
    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: false,
      unavailableReason: 'storage-recovery-required',
    });
    _setGeneratedRepairLifecycleDirectoryFsyncHookForTest(undefined);
    _resetGeneratedRepairLifecycleCacheForTest();

    expect(fsyncs).toBeGreaterThanOrEqual(6);
    expect(readFileSync(path)).not.toEqual(prior);
    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      disposition: 'exhausted',
      authoritativeEmptyRuns: 2,
    });
    expect(existsSync(`${path}.failed`)).toBe(false);
  });

  it('fails terminal readers closed before the lifecycle commit marker is durable', () => {
    const item = diagnosticRepairItem();
    const generationId = item.repairGenerationId!;
    let lifecycleDuringInstall: ReturnType<typeof readGeneratedRepairLifecycle> | undefined;
    let terminalDuringInstall: ReturnType<typeof readGeneratedRepairTerminalOutcome> | undefined;
    let dispatchDuringInstall: ReturnType<ReturnType<typeof readGeneratedRepairQueueSnapshot>['dispatchState']> | undefined;
    _setGeneratedRepairLifecycleRaceHooksForTest({
      candidateInstalledBeforeCommit: () => {
        lifecycleDuringInstall = readGeneratedRepairLifecycle(item);
        terminalDuringInstall = readGeneratedRepairTerminalOutcome(generationId);
        dispatchDuringInstall = readGeneratedRepairQueueSnapshot().dispatchState(item);
      },
    });

    const transition = recordDiagnosticProposal(
      item,
      ATTEMPT_TWO,
      'prop-precommit-reader-race',
      'local-coder',
      'mid',
      1,
    );

    expect(lifecycleDuringInstall).toMatchObject({
      available: false,
      disposition: 'active',
    });
    expect(terminalDuringInstall).toBeNull();
    expect(dispatchDuringInstall).toMatchObject({
      applies: true,
      state: 'lifecycle-unavailable',
      dispatchable: false,
    });
    expect(transition).toMatchObject({ available: true, disposition: 'retired', recorded: true });
    expect(readGeneratedRepairTerminalOutcome(generationId)).toMatchObject({
      outcome: 'converted',
      disposition: 'retired',
    });
  });

  it('does not overwrite state when the bounded rollback snapshot is invalid', () => {
    const item = repairItem();
    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff',
      attemptId: ATTEMPT_ONE,
      backend: 'local-coder',
      tier: 'mid',
    })).toMatchObject({ recorded: true, authoritativeEmptyRuns: 1 });
    const path = generatedRepairLifecyclePath();
    const prior = readFileSync(path);
    expect(recordOrdinaryProposal(
      item, ATTEMPT_TWO, 'prop-invalid-rollback', '2026-07-10T14:00:00.000Z',
    )).toMatchObject({ recorded: true, disposition: 'retired' });
    const candidate = readFileSync(path);
    installFailedLifecycleWrite(prior, candidate);
    writeFileSync(`${path}.rollback`, 'tampered rollback\n', { mode: 0o600 });

    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: false,
      unavailableReason: 'storage-recovery-required',
      requiredAction: 'operator-reset',
    });
    expect(readFileSync(path)).toEqual(candidate);
    expect(existsSync(`${path}.failed`)).toBe(true);
    expect(existsSync(`${path}.rollback`)).toBe(true);
  });

  it('keeps the outbox unavailable when its failure marker is unsafe', () => {
    const item = diagnosticRepairItem();
    recordDiagnosticProposal(
      item,
      ATTEMPT_TWO,
      'prop-unsafe-failure-marker',
      'local-coder',
      'mid',
      1,
    );
    const failurePath = `${generatedRepairLifecyclePath()}.failed`;
    const target = `${failurePath}.target`;
    writeFileSync(target, 'do not trust\n', { encoding: 'utf8', mode: 0o600 });
    symlinkSync(target, failurePath);

    const pending = readPendingGeneratedRepairTreatmentOutcomes();
    expect(pending.available).toBe(false);
    expect(pending).toEqual([]);
    expect(readFileSync(target, 'utf8')).toBe('do not trust\n');
  });

  it('retries converted publication after receipt storage is repaired', () => {
    const item = diagnosticRepairItem();
    const transition = recordDiagnosticProposal(
      item,
      ATTEMPT_TWO,
      'prop-publication-retry',
      'local-coder',
      'mid',
      1,
    );
    const receiptDir = `${dispatchProductionDir()}/repair-treatment-outcomes`;
    rmSync(receiptDir, { recursive: true, force: true });
    writeFileSync(receiptDir, 'blocks receipt directory\n', 'utf8');

    try {
      expect(publishGeneratedRepairTreatmentOutcome(
        item.repairGenerationId!,
        transition.treatmentOutcomeWitness!.attemptHash,
      )).toBe(false);
      expect(readPendingGeneratedRepairTreatmentOutcomes()).toHaveLength(1);
    } finally {
      rmSync(receiptDir, { force: true });
    }

    expect(publishGeneratedRepairTreatmentOutcome(
      item.repairGenerationId!,
      transition.treatmentOutcomeWitness!.attemptHash,
    )).toBe(true);
    expect(readPendingGeneratedRepairTreatmentOutcomes()).toHaveLength(0);
  });

  it('treats exact immutable publication replay as idempotent', () => {
    const item = diagnosticRepairItem();
    const transition = recordDiagnosticProposal(
      item,
      ATTEMPT_TWO,
      'prop-publication-replay',
      'local-coder',
      'mid',
      1,
    );
    const generationId = item.repairGenerationId!;
    const attemptHash = transition.treatmentOutcomeWitness!.attemptHash;

    expect(publishGeneratedRepairTreatmentOutcome(generationId, attemptHash)).toBe(true);
    expect(publishGeneratedRepairTreatmentOutcome(generationId, attemptHash)).toBe(true);
    expect(readDispatchProductionEvents().filter((event) =>
      event.basis === 'repair-lifecycle-outcome' &&
      event.repairGenerationId === generationId &&
      event.repairTreatmentAttemptHash === attemptHash)).toHaveLength(1);
  });

  it.skipIf(process.platform !== 'win32')(
    'accepts an exact-inspected v2 receipt tombstone after the live receipt is retained',
    () => {
      const item = diagnosticRepairItem();
      const transition = recordDiagnosticProposal(
        item,
        ATTEMPT_TWO,
        'prop-retained-treatment-receipt',
        'local-coder',
        'mid',
        1,
      );
      const generationId = item.repairGenerationId!;
      const attemptHash = transition.treatmentOutcomeWitness!.attemptHash;
      expect(publishGeneratedRepairTreatmentOutcome(generationId, attemptHash)).toBe(true);

      const root = dispatchProductionDir();
      const receiptDir = join(root, 'repair-treatment-outcomes');
      const receiptName = `${generationId}-${attemptHash}.json`;
      const receiptPath = join(receiptDir, receiptName);
      const witness = JSON.parse(readFileSync(receiptPath, 'utf8')) as DispatchProductionEvent;
      const receiptDigest = createHash('sha256')
        .update('ashlr:dispatch-treatment-outcome-receipt:v1\0', 'utf8')
        .update(receiptName, 'utf8')
        .update('\0', 'utf8')
        .update(JSON.stringify(witness), 'utf8')
        .digest('hex');
      const retentionPath = join(receiptDir, '.retention.json');
      writeFileSync(retentionPath, `${JSON.stringify({
        schemaVersion: 2,
        droppedThrough: witness.ts,
        retirementEpoch: 1,
        tombstones: [{ name: receiptName, receiptDigest }],
      })}\n`, { mode: 0o600 });
      expect(assurePrivateStoragePath(
        retentionPath,
        'file',
        'secure-created',
        { anchorPath: root },
      ).ok).toBe(true);
      rmSync(receiptPath);
      _resetGeneratedRepairLifecycleCacheForTest();

      expect(readGeneratedRepairTerminalOutcome(generationId)).toMatchObject({
        outcome: 'converted',
        attemptHash,
      });
      expect(publishGeneratedRepairTreatmentOutcome(generationId, attemptHash)).toBe(true);
    },
    60_000,
  );

  it.skipIf(process.platform !== 'win32')(
    'establishes exact private DACLs for lifecycle treatment receipt and existing retention storage',
    () => {
      privateStorageHarness.useSemanticAdapter = false;
      mkdirSync(fx.ashlrDir, { recursive: true, mode: 0o700 });
      expect(assurePrivateStoragePath(
        fx.ashlrDir,
        'directory',
        'secure-created',
        { anchorPath: fx.home },
      )).toEqual({ ok: true, reason: 'exact-private-dacl' });

      // Handoff and proposal storage are prerequisites, not the authority under
      // test. Dispatch receipt and lifecycle publication re-enter native mode.
      privateStorageHarness.useSemanticAdapter = true;
      const item = diagnosticRepairItem();
      const event = diagnosticProposalEvent(
        item,
        ATTEMPT_TWO,
        'prop-publication-private-storage',
        'local-coder',
        'mid',
        1,
      );
      persistDurableProposal(item, event);
      privateStorageHarness.useSemanticAdapter = false;
      secureNativeFixtureDescendants(fx.ashlrDir, fx.ashlrDir);
      const root = dispatchProductionDir();
      expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
      const lifecyclePath = generatedRepairLifecyclePath();
      const lifecycleNativeCallsBefore = privateStorageHarness.realInvocations.length;
      const transition = recordGeneratedRepairLifecycle(item, {
        kind: 'proposal-created',
        attemptId: event.trajectoryId!,
        proposalId: 'prop-publication-private-storage',
        ts: event.ts,
      });
      const lifecycleTempPattern = new RegExp(
        `^${lifecyclePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+\\.[a-f0-9]{12}\\.tmp$`,
      );
      const lifecycleTargetCalls = privateStorageHarness.realInvocations
        .slice(lifecycleNativeCallsBefore)
        .filter((call) => call.path === lifecyclePath || lifecycleTempPattern.test(call.path));
      expect(lifecycleTargetCalls).toEqual([
          {
            path: expect.stringMatching(lifecycleTempPattern),
            kind: 'file',
            mode: 'secure-created',
            anchorPath: fx.home,
          },
          { path: lifecyclePath, kind: 'file', mode: 'inspect-existing', anchorPath: fx.home },
      ]);
      const receiptDir = join(root, 'repair-treatment-outcomes');
      const retentionPath = join(receiptDir, '.retention.json');
      expect(assurePrivateStoragePath(
        root,
        'directory',
        'inspect-existing',
        { anchorPath: fx.ashlrDir },
      )).toEqual({ ok: true, reason: 'exact-private-dacl' });
      mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
      expect(assurePrivateStoragePath(
        receiptDir,
        'directory',
        'secure-created',
        { anchorPath: root },
      )).toEqual({ ok: true, reason: 'exact-private-dacl' });
      writeFileSync(retentionPath, `${JSON.stringify({
        schemaVersion: 1,
        droppedThrough: '2026-07-09T00:00:00.000Z',
      })}\n`, { mode: 0o600 });
      expect(assurePrivateStoragePath(
        retentionPath,
        'file',
        'secure-created',
        { anchorPath: root },
      )).toEqual({ ok: true, reason: 'exact-private-dacl' });

      const generationId = item.repairGenerationId!;
      const attemptHash = transition.treatmentOutcomeWitness!.attemptHash;
      const receiptPath = join(receiptDir, `${generationId}-${attemptHash}.json`);
      const lifecycleDir = dirname(lifecyclePath);
      const lifecycleAssurances: Array<{ ok: boolean; reason: string }> = [];
      const markerKinds: string[] = [];
      let lifecycleFsyncs = 0;
      _setGeneratedRepairLifecycleDirectoryFsyncHookForTest(() => {
        lifecycleFsyncs++;
        if (lifecycleFsyncs === 3) {
          for (const [path, kind] of [
            [lifecycleDir, 'directory'],
            [lifecyclePath, 'file'],
            [`${lifecyclePath}.rollback`, 'file'],
            [`${lifecyclePath}.failed`, 'file'],
          ] as const) {
            lifecycleAssurances.push(assurePrivateStoragePath(
              path,
              kind,
              'inspect-existing',
              { anchorPath: fx.home },
            ));
          }
          markerKinds.push((JSON.parse(readFileSync(
            `${lifecyclePath}.failed`,
            'utf8',
          )) as { kind: string }).kind);
        }
        if (lifecycleFsyncs === 4) {
          lifecycleAssurances.push(assurePrivateStoragePath(
            `${lifecyclePath}.failed`,
            'file',
            'inspect-existing',
            { anchorPath: fx.home },
          ));
          markerKinds.push((JSON.parse(readFileSync(
            `${lifecyclePath}.failed`,
            'utf8',
          )) as { kind: string }).kind);
        }
      });
      const publicationNativeCallsBefore = privateStorageHarness.realInvocations.length;
      expect(publishGeneratedRepairTreatmentOutcome(generationId, attemptHash)).toBe(true);
      const receiptTempPattern = new RegExp(
        `^${receiptPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+\\.tmp$`,
      );
      const publicationTargetCalls = privateStorageHarness.realInvocations
        .slice(publicationNativeCallsBefore)
        .filter((call) => call.path === receiptPath || call.path === retentionPath ||
          receiptTempPattern.test(call.path));
      expect(publicationTargetCalls.every((call) => call.anchorPath === root)).toBe(true);
      expect(publicationTargetCalls.filter((call) => receiptTempPattern.test(call.path))).toEqual([{
        path: expect.stringMatching(receiptTempPattern),
        kind: 'file',
        mode: 'secure-created',
        anchorPath: root,
      }]);
      const retentionCalls = publicationTargetCalls.filter((call) => call.path === retentionPath);
      expect(retentionCalls.length).toBeGreaterThan(0);
      expect(retentionCalls.every((call) =>
        call.kind === 'file' && call.mode === 'inspect-existing')).toBe(true);
      const receiptCalls = publicationTargetCalls.filter((call) => call.path === receiptPath);
      const receiptModes = receiptCalls.map((call) => call.mode);
      const canonicalSecureIndex = receiptModes.indexOf('secure-created');
      expect(canonicalSecureIndex).toBeGreaterThan(0);
      expect(receiptModes.filter((mode) => mode === 'secure-created')).toHaveLength(1);
      expect(receiptModes.slice(0, canonicalSecureIndex).every((mode) =>
        mode === 'inspect-existing')).toBe(true);
      expect(receiptModes.slice(canonicalSecureIndex + 1).length).toBeGreaterThan(0);
      expect(receiptModes.slice(canonicalSecureIndex + 1).every((mode) =>
        mode === 'inspect-existing')).toBe(true);
      expect(receiptCalls.every((call) => call.kind === 'file')).toBe(true);
      _setGeneratedRepairLifecycleDirectoryFsyncHookForTest(undefined);
      expect(lifecycleFsyncs).toBeGreaterThanOrEqual(6);
      expect(markerKinds).toEqual(['rollback-required', 'commit-complete']);
      expect(lifecycleAssurances).toHaveLength(5);
      expect(lifecycleAssurances.every((assurance) =>
        assurance.ok && assurance.reason === 'exact-private-dacl')).toBe(true);
      for (const [path, kind] of [
        [receiptDir, 'directory'],
        [receiptPath, 'file'],
        [retentionPath, 'file'],
      ] as const) {
        expect(assurePrivateStoragePath(
          path,
          kind,
          'inspect-existing',
          { anchorPath: root },
        )).toMatchObject({ ok: true, reason: 'exact-private-dacl' });
      }
      expect(publishGeneratedRepairTreatmentOutcome(generationId, attemptHash)).toBe(true);

      const systemRoot = process.env.SystemRoot;
      process.env.SystemRoot = '';
      _resetGeneratedRepairLifecycleCacheForTest();
      try {
        expect(readGeneratedRepairLifecycle(item).available).toBe(false);
      } finally {
        if (systemRoot === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = systemRoot;
        _resetGeneratedRepairLifecycleCacheForTest();
      }
      const recoveryReadNativeCallsBefore = privateStorageHarness.realInvocations.length;
      expect(readGeneratedRepairLifecycle(item).available).toBe(true);
      expect(privateStorageHarness.realInvocations
        .slice(recoveryReadNativeCallsBefore)
        .filter((call) => call.path === lifecyclePath)).toEqual([{
        path: lifecyclePath,
        kind: 'file',
        mode: 'inspect-existing',
        anchorPath: fx.home,
      }]);
    },
    60_000,
  );

  it('does not acknowledge when a competing immutable receipt wins the race', () => {
    const item = diagnosticRepairItem();
    const transition = recordDiagnosticProposal(
      item,
      ATTEMPT_TWO,
      'prop-publication-race',
      'local-coder',
      'mid',
      1,
    );
    const pending = readPendingGeneratedRepairTreatmentOutcomes()[0]!;
    const competing: DispatchProductionEvent = {
      ...pending.candidate,
      ts: '2026-07-10T15:00:00.000Z',
      routeReason: 'competing terminal publisher',
      basis: 'repair-lifecycle-outcome',
      repairTreatmentOutcome: 'converted',
      repairTreatmentAttemptHash: pending.attemptHash,
    };
    expect(recordDispatchProduction(competing)).toEqual({ attempted: 1, recorded: 1, failed: 0 });

    expect(acknowledgeGeneratedRepairTreatmentOutcome(
      item.repairGenerationId!,
      transition.treatmentOutcomeWitness!.attemptHash,
    )).toBe(false);
    const stillPending = readPendingGeneratedRepairTreatmentOutcomes();
    expect(stillPending.available).toBe(true);
    expect(stillPending).toHaveLength(1);
  });

  it('exhausts after two distinct empty-diff attempts and deduplicates replay', () => {
    const item = repairItem();
    const first = recordGeneratedRepairLifecycle(item, { kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder', tier: 'mid' });
    const replay = recordGeneratedRepairLifecycle(item, { kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder', tier: 'mid' });
    const second = recordGeneratedRepairLifecycle(item, { kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'kimi', tier: 'mid' });

    expect(first).toMatchObject({ disposition: 'active', authoritativeEmptyRuns: 1, recorded: true });
    expect(replay).toMatchObject({ disposition: 'active', authoritativeEmptyRuns: 1, recorded: false });
    expect(second).toMatchObject({
      disposition: 'exhausted',
      authoritativeEmptyRuns: 2,
      recorded: true,
    });
    expect(second).not.toHaveProperty('treatmentOutcomeWitness');
    expect(replay).not.toHaveProperty('treatmentOutcomeWitness');
    expect(readGeneratedRepairLifecycle(item).disposition).toBe('exhausted');
    expect(readGeneratedRepairTerminalOutcome(generatedRepairGenerationId(item)!))
      .toBeNull();
  });

  it('quarantines one objective only with three unique same-tier attempts across two backends', () => {
    const item = diagnosticRepairItem('local-coder', 'mid');
    const first = recordDiagnosticEmpty(item, ATTEMPT_TWO, 'local-coder', 'mid', 1);
    const second = recordDiagnosticEmpty(item, ATTEMPT_THREE, 'kimi', 'mid', 2);

    expect(first).toMatchObject({ disposition: 'active', authoritativeEmptyRuns: 1 });
    expect(second).toMatchObject({
      disposition: 'quarantined',
      authoritativeEmptyRuns: 2,
      authoritativeEmptyBackends: ['local-coder', 'kimi'],
      authoritativeEmptyTiers: ['mid', 'mid'],
      treatmentOutcomeWitness: { outcome: 'not-converted', disposition: 'quarantined' },
    });
    expect(readGeneratedRepairTerminalOutcome(second.treatmentOutcomeWitness!.generationId))
      .toEqual(second.treatmentOutcomeWitness);
  });

  it('binds diagnostic terminalAttemptHash to the final ordinal proof', () => {
    const item = diagnosticRepairItem('local-coder', 'mid');
    recordDiagnosticEmpty(item, ATTEMPT_TWO, 'local-coder', 'mid', 1);
    recordDiagnosticEmpty(item, ATTEMPT_THREE, 'kimi', 'mid', 2);
    const path = generatedRepairLifecyclePath();
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      records: Array<{ generationId: string; emptyAttemptHashes: string[]; terminalAttemptHash: string }>;
    };
    const record = parsed.records[0]!;
    expect(record.emptyAttemptHashes).toHaveLength(2);
    expect(record.terminalAttemptHash).toBe(record.emptyAttemptHashes[1]);
    record.terminalAttemptHash = record.emptyAttemptHashes[0]!;
    writeFileSync(path, `${JSON.stringify(parsed)}\n`, 'utf8');

    expect(readGeneratedRepairLifecycle(item)).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
    expect(readGeneratedRepairTerminalOutcome(record.generationId)).toBeNull();
  });

  it('accepts only an exact terminal diagnostic event as an idempotent replay', () => {
    const item = diagnosticRepairItem('local-coder', 'mid');
    const firstEvent = diagnosticEmptyEvent(item, ATTEMPT_TWO, 'local-coder', 'mid', 1);
    expect(recordDispatchProduction(firstEvent)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'dispatch-proof-empty-diff',
      eventTs: firstEvent.ts,
    })).toMatchObject({ available: true, disposition: 'active', recorded: true });
    const terminalEvent = diagnosticEmptyEvent(item, ATTEMPT_THREE, 'kimi', 'mid', 2);
    expect(recordDispatchProduction(terminalEvent)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'dispatch-proof-empty-diff',
      eventTs: terminalEvent.ts,
    })).toMatchObject({ available: true, disposition: 'quarantined', recorded: true });

    const exactReplay = recordGeneratedRepairLifecycle(item, {
      kind: 'dispatch-proof-empty-diff',
      eventTs: terminalEvent.ts,
      treatmentCandidate: { ...terminalEvent, basis: 'repair-lifecycle-candidate' },
    });
    const staleReplay = recordGeneratedRepairLifecycle(item, {
      kind: 'dispatch-proof-empty-diff',
      eventTs: firstEvent.ts,
      treatmentCandidate: { ...firstEvent, basis: 'repair-lifecycle-candidate' },
    });

    expect(exactReplay).toMatchObject({
      available: true,
      disposition: 'quarantined',
      authoritativeEmptyRuns: 2,
      recorded: false,
    });
    expect(staleReplay).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
      recorded: false,
    });
    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      disposition: 'quarantined',
      authoritativeEmptyRuns: 2,
    });
  });

  it('quarantines complete objective-bound V1 handoffs on the default writer path', () => {
    const item = diagnosticRepairItem('local-coder', 'mid', 1);
    recordDiagnosticEmpty(item, ATTEMPT_TWO, 'local-coder', 'mid', 1);
    expect(recordDiagnosticEmpty(item, ATTEMPT_THREE, 'kimi', 'mid', 2))
      .toMatchObject({ disposition: 'quarantined' });
  });

  it('rejects cross-tier second-attempt evidence before it can become terminal', () => {
    const item = diagnosticRepairItem('local-coder', 'mid');
    recordDiagnosticEmpty(item, ATTEMPT_TWO, 'local-coder', 'mid', 1);
    const second = recordDiagnosticEmpty(item, ATTEMPT_THREE, 'codex', 'frontier', 2);

    expect(second).toMatchObject({ available: false, disposition: 'active', recorded: false });
    expect(readGeneratedRepairLifecycle(item)).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
  });

  it.each([
    { field: 'emptyAttemptTiers', value: ['mid', 'frontier'] },
    { field: 'emptyAttemptBackends', value: ['local-coder', 'builtin'] },
  ])('rejects persisted quarantine with impossible $field evidence', ({ field, value }) => {
    const item = diagnosticRepairItem('local-coder', 'mid');
    recordDiagnosticEmpty(item, ATTEMPT_TWO, 'local-coder', 'mid', 1);
    recordDiagnosticEmpty(item, ATTEMPT_THREE, 'kimi', 'mid', 2);
    const path = generatedRepairLifecyclePath();
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { records: Array<Record<string, unknown>> };
    parsed.records[0]![field] = value;
    writeFileSync(path, `${JSON.stringify(parsed)}\n`, 'utf8');

    expect(readGeneratedRepairLifecycle(item)).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
  });

  it('rejects a replay that changes the authoritative backend for one attempt', () => {
    const item = repairItem();
    recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff',
      attemptId: ATTEMPT_ONE,
      backend: 'local-coder',
      tier: 'mid',
    });

    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff',
      attemptId: ATTEMPT_ONE,
      backend: 'kimi',
      tier: 'mid',
    })).toMatchObject({ available: false, recorded: false, authoritativeEmptyRuns: 1 });
    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      lastAuthoritativeEmptyBackend: 'local-coder',
    });
  });

  it('quarantines pre-backend diagnostic rows as proofless legacy state', () => {
    const item = diagnosticRepairItem();
    recordDiagnosticEmpty(item, ATTEMPT_TWO, 'local-coder', 'mid', 1);
    const path = generatedRepairLifecyclePath();
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      records: Array<{ emptyAttemptBackends?: string[]; emptyAttemptTiers?: string[] }>;
    };
    delete parsed.records[0]!.emptyAttemptBackends;
    delete parsed.records[0]!.emptyAttemptTiers;
    writeFileSync(path, `${JSON.stringify(parsed)}\n`, 'utf8');

    expect(readGeneratedRepairLifecycle(item)).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
      unavailableReason: 'proofless-legacy',
      requiredAction: 'operator-reset',
    });
    expect(generatedRepairRetryPolicy(item)).toMatchObject({
      applies: true,
      available: false,
      requireAlternative: false,
      excludedBackend: null,
    });
  });

  it('does not infer child execution tier from the durable parent handoff', () => {
    const item = diagnosticRepairItem();
    recordDiagnosticEmpty(item, ATTEMPT_TWO, 'local-coder', 'mid', 1);
    const path = generatedRepairLifecyclePath();
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      records: Array<{ emptyAttemptTiers?: string[] }>;
    };
    delete parsed.records[0]!.emptyAttemptTiers;
    writeFileSync(path, `${JSON.stringify(parsed)}\n`, 'utf8');

    expect(readGeneratedRepairLifecycle(item)).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
      unavailableReason: 'proofless-legacy',
      requiredAction: 'operator-reset',
    });
    expect(generatedRepairRetryPolicy(item)).toMatchObject({
      applies: true,
      available: false,
      requireAlternative: false,
      excludedBackend: null,
    });
  });

  it('does not recover a proofless diagnostic through an ordinary proposal transition', () => {
    const item = diagnosticRepairItem();
    recordDiagnosticEmpty(item, ATTEMPT_TWO, 'local-coder', 'mid', 1);
    const proposal = diagnosticProposalEvent(
      item,
      ATTEMPT_THREE,
      'prop-proofless-recovery',
      'kimi',
      'mid',
      2,
    );
    persistDurableProposal(item, proposal);
    expect(recordDispatchProduction(proposal)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    const path = generatedRepairLifecyclePath();
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      records: Array<{ emptyAttemptProofReceipts?: unknown[] }>;
    };
    delete parsed.records[0]!.emptyAttemptProofReceipts;
    writeFileSync(path, `${JSON.stringify(parsed)}\n`, 'utf8');

    expect(readGeneratedRepairLifecycle(item)).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
      unavailableReason: 'proofless-legacy',
      requiredAction: 'operator-reset',
    });
    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'dispatch-proof-empty-diff',
      eventTs: '2026-07-10T13:00:00.000Z',
    })).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
      unavailableReason: 'proofless-legacy',
      requiredAction: 'operator-reset',
      recorded: false,
    });

    const recovery = recordGeneratedRepairLifecycle(item, {
      kind: 'proposal-created',
      attemptId: proposal.trajectoryId!,
      proposalId: 'prop-proofless-recovery',
      ts: proposal.ts,
    });
    expect(recovery).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
      unavailableReason: 'proofless-legacy',
      requiredAction: 'operator-reset',
      recorded: false,
    });
    expect(readGeneratedRepairLifecycle(item)).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
      unavailableReason: 'proofless-legacy',
      requiredAction: 'operator-reset',
    });
  });

  it('keeps non-terminal failures retryable without creating control state', () => {
    const item = repairItem();
    const transition = recordGeneratedRepairLifecycle(item, {
      kind: 'non-terminal',
      attemptId: ATTEMPT_ONE,
    });

    expect(transition).toEqual({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
      recorded: false,
    });
    expect(readGeneratedRepairLifecycle(item).disposition).toBe('active');
  });

  it('keeps terminal states absorbing against late outcomes', () => {
    const item = repairItem();
    recordOrdinaryProposal(item, ATTEMPT_ONE, 'prop-generated-repair');
    const late = recordGeneratedRepairLifecycle(item, { kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'kimi', tier: 'mid' });

    expect(late).toMatchObject({ disposition: 'retired', recorded: false });
    expect(readGeneratedRepairLifecycle(item).disposition).toBe('retired');
  });

  it('invalidates ordinary retirement when immutable proposal content is replaced', () => {
    const item = repairItem();
    expect(recordOrdinaryProposal(item, ATTEMPT_ONE, 'prop-content-bound'))
      .toMatchObject({ disposition: 'retired', recorded: true });
    const proposalPath = join(inboxDir(), 'prop-content-bound.json');
    const proposal = JSON.parse(readFileSync(proposalPath, 'utf8')) as Record<string, unknown>;
    proposal['summary'] = 'mutated after lifecycle retirement';
    writeFileSync(proposalPath, `${JSON.stringify(proposal)}\n`, { mode: 0o600 });
    _resetGeneratedRepairLifecycleCacheForTest();

    expect(readGeneratedRepairLifecycle(item)).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
  });

  it('keeps exact retired proposal authority beyond the default 512-file inbox bound', () => {
    const item = repairItem();
    const proposalId = 'zzz-authoritative-proposal';
    expect(recordOrdinaryProposal(item, ATTEMPT_ONE, proposalId))
      .toMatchObject({ available: true, disposition: 'retired', recorded: true });
    const dir = inboxDir();
    const template = JSON.parse(readFileSync(join(dir, `${proposalId}.json`), 'utf8')) as {
      id: string;
      runEventSummary: { proposalId: string };
    };
    for (let index = 0; index < 512; index++) {
      const fillerId = `aaa-filler-${index.toString().padStart(4, '0')}`;
      writeFileSync(join(dir, `${fillerId}.json`), `${JSON.stringify({
        ...template,
        id: fillerId,
        runEventSummary: { ...template.runEventSummary, proposalId: fillerId },
      })}\n`, { mode: 0o600 });
    }
    expect(readdirSync(dir).filter((name) => name.endsWith('.json'))).toHaveLength(513);
    _resetGeneratedRepairLifecycleCacheForTest();

    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      disposition: 'retired',
    });
  });

  it('loads one bounded proposal authority snapshot for all retired outbox rows', () => {
    const first = diagnosticRepairItem('local-coder', 'mid', 2, ':snapshot-a');
    const second = diagnosticRepairItem('local-coder', 'mid', 2, ':snapshot-b');
    recordDiagnosticProposal(
      first, ATTEMPT_TWO, 'prop-snapshot-a', 'local-coder', 'mid', 1,
    );
    recordDiagnosticProposal(
      second, ATTEMPT_THREE, 'prop-snapshot-b', 'local-coder', 'mid', 1,
    );
    let directoryScans = 0;
    _setProposalReadRaceHookForTest((point) => {
      if (point === 'after-directory-scan') directoryScans++;
    });
    _resetGeneratedRepairLifecycleCacheForTest();

    const pending = readPendingGeneratedRepairTreatmentOutcomes();

    expect(pending.available).toBe(true);
    expect(pending).toHaveLength(2);
    expect(directoryScans).toBe(1);
  });

  it('preserves an unacknowledged terminal while dropping older active state at the count cap', () => {
    const terminalItem = diagnosticRepairItem();
    expect(recordDiagnosticProposal(
      terminalItem, ATTEMPT_TWO, 'prop-terminal-cap', 'local-coder', 'mid', 1,
    )).toMatchObject({ disposition: 'retired', recorded: true });
    const path = generatedRepairLifecyclePath();
    const terminal = (JSON.parse(readFileSync(path, 'utf8')) as {
      records: Array<Record<string, unknown>>;
    }).records[0]!;
    const updatedAt = '2026-07-10T12:00:00.000Z';
    writeSyntheticLifecycleLedger(path, 100_000, (index) => index === 0 ? terminal : ({
      generationId: (index - 1).toString(16).padStart(64, '0'),
      disposition: 'active',
      emptyAttemptHashes: [],
      updatedAt,
    }));

    const appended = recordGeneratedRepairLifecycle(
      repairItem({ id: 'repo:proposal-repair:222222222222' }),
      { kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'local-coder', tier: 'mid' },
    );
    const persisted = readFileSync(path, 'utf8');

    expect(appended).toMatchObject({ disposition: 'active', recorded: true });
    expect(persisted).toContain(`"generationId":"${String(terminal['generationId'])}"`);
    expect(persisted).not.toContain(`"generationId":"${'0'.repeat(64)}"`);
    expect(readGeneratedRepairLifecycle(terminalItem).disposition).toBe('retired');
    expect(process.resourceUsage().maxRSS).toBeLessThan(MAX_LIFECYCLE_TEST_RSS_KIB);
  }, 30_000);

  it('refuses byte-pressure transitions without compacting unacknowledged terminal capsules', () => {
    const updatedAt = '2026-07-10T12:00:00.000Z';
    const recordAt = (index: number): Record<string, unknown> => {
      const handoffId = createHash('sha256').update(`pressure-handoff-${index}`).digest('hex');
      const generationId = repairGenerationIdFromHandoffId(handoffId)!;
      const treatmentUnitId = createHash('sha256').update(`pressure-treatment-${index}`).digest('hex');
      const treatment = repairTreatmentForUnitId(treatmentUnitId)!;
      const attemptHash = createHash('sha256').update(`pressure-attempt-${index}`).digest('hex');
      return {
        generationId,
        disposition: 'retired',
        emptyAttemptHashes: [],
        terminalAttemptHash: attemptHash,
        terminalAttemptProofReceipt: {
          proof: {
            schemaVersion: 1,
            integrityClass: 'owner-writable-local',
            cryptographicallyTrusted: false,
            rollbackProtected: false,
            eventTs: updatedAt,
            eventDigest: createHash('sha256').update(`pressure-event-${index}`).digest('hex'),
            attemptHash,
            backend: 'local-coder',
            tier: 'mid',
            model: `pressure-model-${index}`.padEnd(160, 'x'),
            previousBackend: null,
            repairHandoffId: handoffId,
            repairGenerationId: generationId,
            repairTreatmentUnitId: treatmentUnitId,
            repairTreatment: treatment,
            repairAttemptOrdinal: 1,
          },
          targetDigest: createHash('sha256').update(`pressure-target-${index}`).digest('hex'),
        },
        updatedAt,
      };
    };
    const path = generatedRepairLifecyclePath();
    writeSyntheticLifecycleLedger(path, 14_000, recordAt);
    expect(statSync(path).size).toBeGreaterThan(8 * 1024 * 1024);
    const beforeDigest = createHash('sha256').update(readFileSync(path)).digest('hex');

    const appended = recordOrdinaryProposal(
      repairItem({ id: 'repo:proposal-repair:bbbbbbbbbbbb', ts: '2026-07-11T12:00:00.000Z' }),
      ATTEMPT_ONE,
      'prop-byte-pressure',
      '2026-07-11T13:00:00.000Z',
    );
    expect(appended).toMatchObject({ available: false, disposition: 'active', recorded: false });
    expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(beforeDigest);
  }, 30_000);

  it('does not let ordinary terminals consume the bounded treatment-outbox count cap', () => {
    const updatedAt = '2026-07-10T12:00:00.000Z';
    const path = generatedRepairLifecyclePath();
    writeSyntheticLifecycleLedger(path, 2_048, (index) => ({
      generationId: index.toString(16).padStart(64, '0'),
      disposition: 'retired',
      emptyAttemptHashes: [],
      terminalAttemptHash: createHash('sha256').update(`pending-${index}`).digest('hex'),
      updatedAt,
    }));
    const beforeDigest = createHash('sha256').update(readFileSync(path)).digest('hex');

    const appended = recordOrdinaryProposal(
      repairItem({ id: 'repo:proposal-repair:333333333333' }),
      ATTEMPT_TWO,
      'prop-pending-cap',
    );

    expect(appended).toMatchObject({ available: true, disposition: 'retired', recorded: true });
    expect(createHash('sha256').update(readFileSync(path)).digest('hex')).not.toBe(beforeDigest);
    expect(readPendingGeneratedRepairTreatmentOutcomes()).toMatchObject({
      available: true,
      prooflessLegacy: 0,
      requiredAction: null,
    });
  }, 30_000);

  it('does not suppress a newer immutable generation with the same deterministic item id', () => {
    const firstGeneration = repairItem();
    recordOrdinaryProposal(firstGeneration, ATTEMPT_ONE, 'prop-generated-repair');
    const nextGeneration = repairItem({ ts: '2026-07-10T13:00:00.000Z' });

    expect(readGeneratedRepairLifecycle(firstGeneration).disposition).toBe('retired');
    expect(readGeneratedRepairLifecycle(nextGeneration)).toEqual({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
  });

  it('scopes generations by canonical repo and ignores presentation-only changes', () => {
    const item = repairItem();
    recordOrdinaryProposal(item, ATTEMPT_ONE, 'prop-generated-repair');
    const presentationChange = repairItem({
      title: 'Proposal repair: reworded generated repair title',
      detail:
        'Proposal repair: wording changed.\n' +
        'Proposal: prop-stalled\n' +
        'Original work item: repo:goal:stalled\n' +
        'Produce a fresh complete fix with clearer wording.',
    });
    const otherRepo = repairItem({ repo: '/tmp/other-repo' });

    expect(readGeneratedRepairLifecycle(presentationChange).disposition).toBe('retired');
    expect(readGeneratedRepairLifecycle(otherRepo).disposition).toBe('active');
  });

  it.each([
    repairItem({ source: 'backlog' }),
    repairItem({ id: 'repo:manual-repair' }),
    repairItem({ ts: 'invalid' }),
  ])('fails open for untrusted or invalid repair generation %#', (item) => {
    const transition = recordGeneratedRepairLifecycle(item, { kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder', tier: 'mid' });
    expect(transition.available).toBe(false);
    expect(transition.recorded).toBe(false);
    expect(readGeneratedRepairLifecycle(item).disposition).toBe('active');
  });

  it('rejects unsafe attempt and proposal identities', () => {
    const item = repairItem();
    const badAttempt = recordGeneratedRepairLifecycle(item, { kind: 'empty-diff', attemptId: 'work:spoofed', backend: 'local-coder', tier: 'mid' });
    const badProposal = recordGeneratedRepairLifecycle(item, {
      kind: 'proposal-created',
      attemptId: ATTEMPT_ONE,
      proposalId: '../proposal',
    });

    expect(badAttempt.recorded).toBe(false);
    expect(badProposal.recorded).toBe(false);
    expect(readGeneratedRepairLifecycle(item).disposition).toBe('active');
  });

  it('rejects caller-shaped handoff generation fields that are not cryptographically bound', () => {
    const forged = repairItem({
      repairHandoffId: 'a'.repeat(64),
      repairGenerationId: 'b'.repeat(64),
    });
    const transition = recordGeneratedRepairLifecycle(forged, {
      kind: 'empty-diff',
      attemptId: ATTEMPT_ONE,
      backend: 'local-coder',
      tier: 'mid',
    });

    expect(transition).toMatchObject({ available: false, recorded: false });
    expect(readGeneratedRepairLifecycle(forged).available).toBe(false);
  });

  it('reports corrupt state unavailable without inventing terminal evidence', () => {
    const path = generatedRepairLifecyclePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{corrupt', 'utf8');

    expect(readGeneratedRepairLifecycle(repairItem())).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
    const pending = readPendingGeneratedRepairTreatmentOutcomes();
    expect(pending.available).toBe(false);
    expect(pending).toEqual([]);
    expect(recordGeneratedRepairLifecycle(repairItem(), {
      kind: 'empty-diff',
      attemptId: ATTEMPT_ONE,
      backend: 'local-coder',
      tier: 'mid',
    }).recorded).toBe(false);
  });

  it('reports live writer contention unavailable without poisoning later reads', () => {
    const item = repairItem();
    const lockPath = `${generatedRepairLifecyclePath()}.lock`;
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ token: 'other-owner', pid: process.pid }), { encoding: 'utf8', mode: 0o600 });

    expect(readGeneratedRepairLifecycle(item).available).toBe(false);
    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff',
      attemptId: ATTEMPT_ONE,
      backend: 'local-coder',
      tier: 'mid',
    }).recorded).toBe(false);

    rmSync(lockPath);
    expect(() => readFileSync(`${generatedRepairLifecyclePath()}.failed`)).toThrow();
    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff',
      attemptId: ATTEMPT_ONE,
      backend: 'local-coder',
      tier: 'mid',
    })).toMatchObject({ recorded: true, authoritativeEmptyRuns: 1 });
  });

  it('recovers a lifecycle lock left by a dead owner', () => {
    const item = repairItem();
    const lockPath = `${generatedRepairLifecyclePath()}.lock`;
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      token: 'dead-owner',
      pid: 2_147_483_647,
      startRef: 'a'.repeat(64),
      startRefVerified: true,
    }), { encoding: 'utf8', mode: 0o600 });

    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff',
      attemptId: ATTEMPT_ONE,
      backend: 'local-coder',
      tier: 'mid',
    })).toMatchObject({ available: true, recorded: true, authoritativeEmptyRuns: 1 });
    expect(readGeneratedRepairLifecycle(item).available).toBe(true);
  });

  it('rejects a symlink ledger without mutating its target and recovers after repair', () => {
    const item = repairItem();
    const path = generatedRepairLifecyclePath();
    mkdirSync(dirname(path), { recursive: true });
    const target = `${path}.target`;
    writeFileSync(target, 'do-not-mutate\n', { mode: 0o600 });
    symlinkSync(target, path);

    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff',
      attemptId: ATTEMPT_ONE,
      backend: 'local-coder',
      tier: 'mid',
    })).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
      recorded: false,
    });
    expect(readGeneratedRepairLifecycle(item).available).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('do-not-mutate\n');

    rmSync(path);
    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff',
      attemptId: ATTEMPT_ONE,
      backend: 'local-coder',
      tier: 'mid',
    })).toMatchObject({ available: true, recorded: true, authoritativeEmptyRuns: 1 });
    expect(readGeneratedRepairLifecycle(item)).toMatchObject({ available: true, authoritativeEmptyRuns: 1 });
  });

  it('rejects duplicate generation records instead of weakening terminal state', () => {
    const item = repairItem();
    recordOrdinaryProposal(item, ATTEMPT_ONE, 'prop-generated-repair');
    const path = generatedRepairLifecyclePath();
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion: 1; records: unknown[] };
    parsed.records.push(parsed.records[0]);
    writeFileSync(path, JSON.stringify(parsed), 'utf8');

    expect(readGeneratedRepairLifecycle(item)).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
  });

  it('persists only hashed identities with owner-only permissions', () => {
    const item = repairItem();
    recordOrdinaryProposal(item, ATTEMPT_ONE, 'prop-generated-repair');
    const path = generatedRepairLifecyclePath();
    const raw = readFileSync(path, 'utf8');

    expect(raw).not.toContain(item.repo);
    expect(raw).not.toContain(item.id);
    expect(raw).not.toContain(item.title);
    expect(raw).not.toContain(item.detail);
    expect(raw).not.toContain(ATTEMPT_ONE);
    expect(raw).not.toContain('prop-generated-repair');
    expect(statSync(path).mode & 0o077).toBe(0);
  });

  it('reports unavailable when the exact lifecycle directory is not writable', () => {
    const item = repairItem();
    recordGeneratedRepairLifecycle(item, { kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder', tier: 'mid' });
    const dir = dirname(generatedRepairLifecyclePath());
    chmodSync(dir, 0o500);

    try {
      expect(readGeneratedRepairLifecycle(item)).toMatchObject({ available: false });
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});
