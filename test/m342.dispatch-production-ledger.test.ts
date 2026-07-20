/**
 * test/m342.dispatch-production-ledger.test.ts — append-only dispatch-production history.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const privateStorageHarness = vi.hoisted(() => ({
  useSemanticAdapter: false,
  nativeExactPath: undefined as string | undefined,
  nativeRewriteStageObserved: false,
  realCalls: 0,
  realInvocations: [] as Array<{
    path: string;
    kind: 'file' | 'directory';
    mode: 'secure-created' | 'inspect-existing' | 'inspect-owned';
  }>,
}));

vi.mock('../src/core/util/private-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/util/private-storage.js')>();
  const semanticAssurance = { ok: true, reason: 'exact-private-dacl' } as const;
  return {
    ...actual,
    assurePrivateStoragePath: (
      ...args: Parameters<typeof actual.assurePrivateStoragePath>
    ) => {
      const selectivelyNativeStage = privateStorageHarness.nativeExactPath !== undefined &&
        args[0].startsWith(`${privateStorageHarness.nativeExactPath}.`) &&
        args[2] === 'secure-created';
      const selectivelyNativeFinal = privateStorageHarness.nativeExactPath !== undefined &&
        privateStorageHarness.nativeRewriteStageObserved &&
        args[0] === privateStorageHarness.nativeExactPath &&
        args[2] === 'inspect-existing';
      if (process.platform === 'win32' && privateStorageHarness.useSemanticAdapter &&
        !selectivelyNativeStage && !selectivelyNativeFinal) {
        return args[2] === 'inspect-owned'
          ? { ok: true, reason: 'owned-safe-path' }
          : semanticAssurance;
      }
      if (selectivelyNativeFinal) {
        privateStorageHarness.nativeRewriteStageObserved = false;
      }
      privateStorageHarness.realCalls++;
      privateStorageHarness.realInvocations.push({ path: args[0], kind: args[1], mode: args[2] });
      if (process.platform === 'win32') {
        const result = actual.assurePrivateStoragePath(
          args[0], args[1], args[2], { ...args[3], timeoutMs: 15_000 },
        );
        if (selectivelyNativeStage && result.ok) {
          privateStorageHarness.nativeRewriteStageObserved = true;
        }
        return result;
      }
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

import {
  _setDispatchProductionLedgerRetentionHooksForTest,
  createDispatchSelectionObservation,
  dispatchProductionDir,
  hasExactDispatchProductionTreatmentOutcomeReceipt,
  readDispatchProductionEvents,
  readDispatchProductionEventsDetailed,
  readDispatchProductionAttemptReceiptAvailability,
  readDispatchProductionAttemptProtocolQuality,
  readDispatchProductionFailureAttemptReceipts,
  readDispatchProductionParents,
  readDispatchProductionYield,
  readDispatchProductionYieldDetailed,
  recordDispatchProduction,
  resolveDispatchProductionFailureAttemptReceipt,
  resolveDispatchProductionAttemptReceiptWitnesses,
  resolveDispatchProductionAttemptProofs as resolveDispatchProductionAttemptProofBatch,
  sanitizeDispatchProductionEvent,
  summarizeDispatchProductionYield,
  type DispatchProductionEvent,
  type DispatchProductionAttemptProofTarget,
} from '../src/core/fleet/dispatch-production-ledger.js';
import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import { writeSelectionStartReceipt } from '../src/core/fleet/selection-start-receipt.js';
import {
  hasReceiptQualifiedSelectionObservation,
  listTrajectoryRecords,
} from '../src/core/autonomy/trajectory-records.js';
import { buildLearningEligibilityProjectionV1 } from '../src/core/learning/learning-eligibility.js';
import { sanitizeProductionAttemptLearningLabel } from '../src/core/learning/attempt-shape.js';
import { repairGenerationIdFromHandoffId } from '../src/core/fleet/repair-handoff-journal.js';
import {
  generatedRepairLifecycleAttemptHash,
  repairTreatmentForUnitId,
  repairTreatmentUnitId,
} from '../src/core/fleet/generated-repair-identity.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import {
  assurePrivateStoragePath,
  assurePrivateStoragePaths,
} from '../src/core/util/private-storage.js';
import { assureStableRegularFiles } from '../src/core/util/stable-file-read.js';

let prevAshlrHome: string | undefined;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let home: string;

function makeEvent(overrides: Partial<DispatchProductionEvent> = {}): DispatchProductionEvent {
  return {
    schemaVersion: 1,
    ts: '2026-07-08T12:00:00.000Z',
    machineId: 'machine-a',
    itemId: 'item-a',
    source: 'todo',
    repo: join(realpathSync.native(tmpdir()), 'repo'),
    title: 'Implement a thing',
    backend: 'local-coder',
    tier: 'mid',
    model: 'qwen',
    assignedBy: 'daemon',
    routeReason: 'local-mid bulk: local-coder',
    outcome: 'empty-diff',
    proposalCreated: false,
    runId: 'run-a',
    spentUsd: 0.001,
    reason: 'engine completed without file changes',
    basis: 'run-proposal-outcome',
    ...overrides,
  };
}

const PROOF_HANDOFF_ID = 'a'.repeat(64);
const PROOF_OBJECTIVE_HASH = 'b'.repeat(64);
const PROOF_PARENT_OBJECTIVE_HASH = 'c'.repeat(64);
const TEST_RECEIPT_ACTIVATION_ID = '9'.repeat(64);
const TEST_BLOCKED_MEMBERSHIP_BITS = 1_048_576;
const TEST_BLOCKED_MEMBERSHIP_BYTES = TEST_BLOCKED_MEMBERSHIP_BITS / 8;
const TEST_BLOCKED_MEMBERSHIP_HASHES = 7;
const TEST_TREATMENT_RECEIPT_DIGEST_DOMAIN =
  'ashlr:dispatch-treatment-outcome-receipt:v1\0';
const TEST_TREATMENT_RETENTION_DIGEST_DOMAIN =
  'ashlr:dispatch-treatment-retention:v1\0';
const TEST_TREATMENT_RETENTION_COMPACTION_DOMAIN =
  'ashlr:dispatch-treatment-retention-compaction:v1\0';

interface TestTreatmentRetentionState {
  schemaVersion: 3;
  droppedThrough: string;
  retirementEpoch: number;
  previousRetentionDigest: string | null;
  compactedDigest: string;
  compactedCount: number;
  tombstones: Array<{ name: string; receiptDigest: string }>;
}

function treatmentReceiptDigestForTest(
  name: string,
  event: DispatchProductionEvent,
): string {
  return createHash('sha256')
    .update(TEST_TREATMENT_RECEIPT_DIGEST_DOMAIN, 'utf8')
    .update(name, 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify(event), 'utf8')
    .digest('hex');
}

function emptyTreatmentCompactedDigestForTest(): string {
  return createHash('sha256')
    .update(TEST_TREATMENT_RETENTION_COMPACTION_DOMAIN, 'utf8')
    .digest('hex');
}

function treatmentRetentionDigestForTest(state: TestTreatmentRetentionState): string {
  return createHash('sha256')
    .update(TEST_TREATMENT_RETENTION_DIGEST_DOMAIN, 'utf8')
    .update(JSON.stringify(state), 'utf8')
    .digest('hex');
}

function compactedTreatmentDigestForTest(
  priorDigest: string,
  tombstones: TestTreatmentRetentionState['tombstones'],
): string {
  let digest = priorDigest;
  for (const tombstone of tombstones) {
    digest = createHash('sha256')
      .update(TEST_TREATMENT_RETENTION_COMPACTION_DOMAIN, 'utf8')
      .update(digest, 'utf8')
      .update('\0', 'utf8')
      .update(tombstone.name, 'utf8')
      .update('\0', 'utf8')
      .update(tombstone.receiptDigest, 'utf8')
      .digest('hex');
  }
  return digest;
}

function grantWindowsWorldRead(path: string): void {
  if (process.platform !== 'win32') return;
  const result = spawnSync('icacls.exe', [path, '/grant', '*S-1-1-0:R'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`failed to broaden Windows fixture ACL: ${result.stderr}`);
  }
}

function protectWindowsFixtureTree(path: string): void {
  if (process.platform !== 'win32') return;
  const result = spawnSync('icacls.exe', [path, '/inheritance:d', '/t', '/c'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`failed to protect Windows fixture ACLs: ${result.stderr}`);
  }
}

function ownWindowsFixturePaths(paths: string[]): void {
  if (process.platform !== 'win32' || paths.length === 0) return;
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$paths = [Console]::In.ReadToEnd() | ConvertFrom-Json
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
for ($index = 0; $index -lt $paths.Count; $index++) {
  $path = [string]$paths[$index]
  $acl = [System.IO.File]::GetAccessControl($path)
  $acl.SetOwner($owner)
  [System.IO.File]::SetAccessControl($path, $acl)
}
`;
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      input: JSON.stringify(paths),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 16 * 1024,
    },
  );
  if (result.status !== 0) throw new Error(`failed to own Windows fixtures: ${result.stderr}`);
}

// Lifecycle selectors use this after native DACL behavior has been separated
// into the explicit Windows authority tests below.
function useWindowsSemanticPrivateStorageFixture(): void {
  privateStorageHarness.useSemanticAdapter = process.platform === 'win32';
  privateStorageHarness.nativeExactPath = undefined;
  privateStorageHarness.nativeRewriteStageObserved = false;
}

function useWindowsSelectiveNativePrivateStorageFixture(path: string): void {
  privateStorageHarness.useSemanticAdapter = process.platform === 'win32';
  privateStorageHarness.nativeExactPath = path;
  privateStorageHarness.nativeRewriteStageObserved = false;
}

function useNativePrivateStorageFixture(): void {
  privateStorageHarness.useSemanticAdapter = false;
  privateStorageHarness.nativeExactPath = undefined;
  privateStorageHarness.nativeRewriteStageObserved = false;
}

function expectSelectiveNativeFileRewrite(path: string, callsBefore: number): void {
  expect(privateStorageHarness.realInvocations.slice(callsBefore)).toEqual([
    {
      path: expect.stringMatching(new RegExp(
        `^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[a-f0-9]{32}\\.stage$`,
      )),
      kind: 'file',
      mode: 'secure-created',
    },
    { path, kind: 'file', mode: 'inspect-existing' },
  ]);
}

function establishNativePrivateStorageFixtureRoot(): void {
  useNativePrivateStorageFixture();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const ashlrHome = join(home, '.ashlr');
  process.env.ASHLR_HOME = ashlrHome;
  mkdirSync(ashlrHome, { mode: 0o700 });
  expect(assurePrivateStoragePath(
    ashlrHome, 'directory', 'secure-created', { anchorPath: home },
  ).ok).toBe(true);
}

function makeProofEvent(overrides: Partial<DispatchProductionEvent> = {}): DispatchProductionEvent {
  const repo = overrides.repo ?? join(home, 'proof-repo');
  mkdirSync(repo, { recursive: true });
  const runId = overrides.runId ?? 'run-proof-1';
  const backend = overrides.backend ?? 'local-coder';
  const tier = overrides.tier ?? 'mid';
  const model = Object.prototype.hasOwnProperty.call(overrides, 'model') ? overrides.model : 'qwen-2.5-coder';
  const assignedBy = overrides.assignedBy ?? 'daemon';
  const routeReason = overrides.routeReason ?? 'generated repair proof route';
  const itemId = overrides.itemId ?? 'ashlr-hub:proposal-repair-nodiff:abcdef123456';
  const unitId = overrides.repairTreatmentUnitId ?? repairTreatmentUnitId({
    kind: 'no-diff-reslice',
    repo,
    parentItemId: 'ashlr-hub:goal:proof-parent',
    parentObjectiveHash: PROOF_PARENT_OBJECTIVE_HASH,
  })!;
  const treatment = overrides.repairTreatment ?? repairTreatmentForUnitId(unitId)!;
  const spentUsd = overrides.spentUsd ?? 0.002;
  return makeEvent({
    ts: '2026-07-08T12:00:00.000Z',
    itemId,
    source: 'self',
    repo,
    backend,
    tier,
    model,
    assignedBy,
    routeReason,
    outcome: 'empty-diff',
    proposalCreated: false,
    proposalId: undefined,
    runId,
    trajectoryId: overrides.trajectoryId ?? `run:attempt-proof-${runId}`,
    routeSnapshot: overrides.routeSnapshot ?? {
      backend,
      tier,
      ...(model !== undefined ? { model } : {}),
      assignedBy,
      reason: routeReason,
      routerPolicyVersion: 'fleet-router-v1',
    },
    runEventSummary: overrides.runEventSummary ?? {
      runId,
      status: 'done',
      outcome: 'empty-diff',
      proposalCreated: false,
      costUsd: spentUsd,
    },
    objectiveHash: PROOF_OBJECTIVE_HASH,
    repairHandoffId: PROOF_HANDOFF_ID,
    repairGenerationId: repairGenerationIdFromHandoffId(PROOF_HANDOFF_ID)!,
    repairTreatmentUnitId: unitId,
    repairTreatment: treatment,
    repairAttemptOrdinal: 1,
    repairPreviousBackend: undefined,
    spentUsd,
    basis: 'run-proposal-outcome',
    ...overrides,
  });
}

function makeProposalProofEvent(overrides: Partial<DispatchProductionEvent> = {}): DispatchProductionEvent {
  const runId = overrides.runId ?? 'run-proof-proposal';
  const proposalId = overrides.proposalId ?? 'proposal-proof-authority';
  const spentUsd = overrides.spentUsd ?? 0.003;
  const diffFiles = overrides.diffFiles ?? 2;
  const diffLines = overrides.diffLines ?? 17;
  return makeProofEvent({
    runId,
    trajectoryId: overrides.trajectoryId ?? `run:attempt-proof-${runId}`,
    outcome: 'proposal-created',
    proposalCreated: true,
    proposalId,
    spentUsd,
    diffFiles,
    diffLines,
    runEventSummary: overrides.runEventSummary ?? {
      runId,
      status: 'done',
      outcome: 'proposal-created',
      proposalCreated: true,
      proposalId,
      diffFiles,
      diffLines,
      costUsd: spentUsd,
      actionCounts: { proposalCreated: 1, diffFiles, diffLines },
    },
    ...overrides,
  });
}

function makeFailureAttemptEvent(overrides: Partial<DispatchProductionEvent> = {}): DispatchProductionEvent {
  const runId = overrides.runId ?? 'attempt-failure-authority';
  const spentUsd = overrides.spentUsd ?? 0.001;
  return makeProofEvent({
    runId,
    trajectoryId: overrides.trajectoryId ?? `run:${runId}`,
    outcome: 'engine-failed',
    proposalCreated: false,
    proposalId: undefined,
    spentUsd,
    reason: 'provider failed before producing a diff',
    runEventSummary: overrides.runEventSummary ?? {
      runId,
      status: 'failed',
      outcome: 'engine-failed',
      proposalCreated: false,
      costUsd: spentUsd,
    },
    repairRootId: overrides.repairRootId ?? 'd'.repeat(64),
    repairDepth: overrides.repairDepth ?? 0,
    ...overrides,
  });
}

function makeGeneratedRepairFailureEvent(
  kind: 'proposal' | 'capture',
  overrides: Partial<DispatchProductionEvent> = {},
): DispatchProductionEvent {
  const runId = overrides.runId ?? `attempt-${kind}-failure-authority`;
  const outcome = overrides.outcome ?? (kind === 'capture' ? 'proposal-capture-error' : 'engine-failed');
  const spentUsd = overrides.spentUsd ?? 0.001;
  return makeFailureAttemptEvent({
    itemId: `ashlr-hub:proposal-repair${kind === 'capture' ? '-capture' : ''}:abcdef123456`,
    runId,
    trajectoryId: overrides.trajectoryId ?? `run:${runId}`,
    outcome,
    spentUsd,
    runEventSummary: overrides.runEventSummary ?? {
      runId,
      status: 'failed',
      outcome,
      proposalCreated: false,
      costUsd: spentUsd,
    },
    repairTreatmentUnitId: undefined,
    repairTreatment: undefined,
    ...overrides,
  });
}

function failureAttemptReceiptName(event: DispatchProductionEvent, intent = false): string {
  const attemptHash = generatedRepairLifecycleAttemptHash(event.trajectoryId!);
  return `${event.repairGenerationId}-${event.repairAttemptOrdinal}-${attemptHash}.failure${intent ? '.intent' : ''}.json`;
}

function proofTarget(
  event: DispatchProductionEvent,
  overrides: Partial<DispatchProductionAttemptProofTarget> = {},
): DispatchProductionAttemptProofTarget {
  return {
    ts: event.ts,
    itemId: event.itemId,
    repo: event.repo,
    source: event.source,
    outcome: event.outcome === 'proposal-created' ? 'proposal-created' : 'empty-diff',
    ...(event.outcome === 'proposal-created' ? { proposalId: event.proposalId } : {}),
    objectiveHash: event.objectiveHash!,
    repairHandoffId: event.repairHandoffId!,
    repairGenerationId: event.repairGenerationId!,
    repairTreatmentUnitId: event.repairTreatmentUnitId!,
    repairTreatment: event.repairTreatment!,
    repairAttemptOrdinal: event.repairAttemptOrdinal!,
    ...overrides,
  };
}

function resolveDispatchProductionAttemptProofs(
  targets: readonly DispatchProductionAttemptProofTarget[],
) {
  const result = resolveDispatchProductionAttemptProofBatch(targets);
  expect(result.status).toBe('resolved');
  if (result.status !== 'resolved') throw new Error(`unexpected batch degradation: ${result.reason}`);
  return result.resolutions;
}

function appendCanonicalDispatchEvent(event: DispatchProductionEvent): void {
  const canonical = sanitizeDispatchProductionEvent(event, { materializeLearningLabel: true });
  mkdirSync(dispatchProductionDir(), { recursive: true });
  appendFileSync(
    join(dispatchProductionDir(), `${canonical.ts.slice(0, 10)}.jsonl`),
    `${JSON.stringify(canonical)}\n`,
    'utf8',
  );
}

function readExactFileSlice(path: string, offset: number, length: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    expect(readSync(fd, buffer, 0, length, offset)).toBe(length);
    return buffer;
  } finally {
    closeSync(fd);
  }
}

function validatedAttemptReceiptText(event: DispatchProductionEvent): string {
  return `${JSON.stringify({
    receiptSchemaVersion: 1,
    validation: 'bounded-raw-history-v1',
    activationId: TEST_RECEIPT_ACTIVATION_ID,
    event,
  })}\n`;
}

function testBlockedGenerationMembership(generationIds: Iterable<string> = []) {
  const bits = Buffer.alloc(TEST_BLOCKED_MEMBERSHIP_BYTES);
  for (const generationId of generationIds) {
    const digest = createHash('sha256')
      .update('ashlr:dispatch-attempt-generation-membership:v1\0', 'utf8')
      .update(generationId, 'utf8')
      .digest();
    for (let index = 0; index < TEST_BLOCKED_MEMBERSHIP_HASHES; index++) {
      const bit = digest.readUInt32BE(index * 4) % TEST_BLOCKED_MEMBERSHIP_BITS;
      bits[Math.floor(bit / 8)]! |= 1 << (bit % 8);
    }
  }
  return {
    algorithm: 'sha256-bloom-v1',
    bitCount: TEST_BLOCKED_MEMBERSHIP_BITS,
    hashCount: TEST_BLOCKED_MEMBERSHIP_HASHES,
    bits: bits.toString('base64'),
  };
}

function testSegmentedBlockedMembership(
  segments: Array<{ bits: Buffer; insertedCount?: number }> = [{ bits: Buffer.alloc(TEST_BLOCKED_MEMBERSHIP_BYTES) }],
) {
  const popcount = (bits: Buffer): number => {
    let count = 0;
    for (const byte of bits) {
      let value = byte;
      while (value !== 0) {
        value &= value - 1;
        count++;
      }
    }
    return count;
  };
  const normalized = segments.map(({ bits, insertedCount = 0 }) => ({
    algorithm: 'sha256-bloom-v1',
    bitCount: TEST_BLOCKED_MEMBERSHIP_BITS,
    hashCount: TEST_BLOCKED_MEMBERSHIP_HASHES,
    bits: bits.toString('base64'),
    insertedCount,
    setBitCount: popcount(bits),
  }));
  const saturated = normalized.length === 4 &&
    (normalized.at(-1)!.setBitCount / TEST_BLOCKED_MEMBERSHIP_BITS) **
      TEST_BLOCKED_MEMBERSHIP_HASHES >= 1e-7;
  return {
    algorithm: 'segmented-sha256-bloom-v1',
    maxSegmentFalsePositiveRate: 1e-7,
    quality: saturated ? 'saturated' : 'healthy',
    segments: normalized,
  };
}

function writeTestAttemptReceiptProtocolV4(
  generations: Array<{ generationId: string; admittedAt: string }>,
  blockedGenerations = testSegmentedBlockedMembership(),
): void {
  const receiptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
  mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(receiptDir, '.protocol.json'), `${JSON.stringify({
    schemaVersion: 4,
    activationId: TEST_RECEIPT_ACTIVATION_ID,
    activatedAt: '2026-07-15T00:00:00.000Z',
    acceptsEventsAfter: '2025-01-01T00:00:00.000Z',
    generations: [...generations].sort((left, right) => left.generationId.localeCompare(right.generationId)),
    blockedGenerations,
  })}\n`, 'utf8');
}

function writeTestAttemptReceiptProtocolActivation(
  generations: Array<{ generationId: string; state?: 'active' | 'retired'; admittedAt: string }> = [],
  blockedGenerationIds: Iterable<string> = [],
): void {
  const receiptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
  const activeGenerations = generations.filter((generation) => generation.state !== 'retired');
  const blocked = [
    ...blockedGenerationIds,
    ...generations.filter((generation) => generation.state === 'retired')
      .map((generation) => generation.generationId),
  ];
  const earliestAdmission = activeGenerations.reduce<string | null>((earliest, generation) =>
    earliest === null || generation.admittedAt < earliest ? generation.admittedAt : earliest, null);
  mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
  if (!assurePrivateStoragePath(
    receiptDir, 'directory', 'secure-created', { anchorPath: dispatchProductionDir() },
  ).ok) throw new Error('test receipt directory assurance failed');
  const protocolPath = join(receiptDir, '.protocol.json');
  writeFileSync(protocolPath, `${JSON.stringify({
    schemaVersion: 3,
    activationId: TEST_RECEIPT_ACTIVATION_ID,
    activatedAt: '2026-07-15T00:00:00.000Z',
    acceptsEventsAfter: earliestAdmission ?? '2026-07-07T00:00:00.000Z',
    generations: activeGenerations
      .map(({ generationId, admittedAt }) => ({ generationId, admittedAt }))
      .sort((left, right) => left.generationId.localeCompare(right.generationId)),
    blockedGenerations: testBlockedGenerationMembership(blocked),
  })}\n`, 'utf8');
  if (!assurePrivateStoragePath(
    protocolPath, 'file', 'secure-created', { anchorPath: dispatchProductionDir() },
  ).ok) throw new Error('test receipt protocol assurance failed');
}

function seedUnrelatedDatedPartitions(count: number): void {
  mkdirSync(dispatchProductionDir(), { recursive: true });
  for (let index = 0; index < count; index++) {
    const date = new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10);
    const unrelated = sanitizeDispatchProductionEvent(makeEvent({
      ts: `${date}T12:00:00.000Z`,
      itemId: `unrelated-legacy-${index}`,
    }), { materializeLearningLabel: true });
    writeFileSync(
      join(dispatchProductionDir(), `${date}.jsonl`),
      `${JSON.stringify(unrelated)}\n`,
      'utf8',
    );
  }
}

function removeAttemptProofReceipts(): void {
  const dir = join(dispatchProductionDir(), 'repair-attempt-proofs');
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === '.protocol.json') continue;
    rmSync(join(dir, name), { recursive: true, force: true });
  }
}

beforeEach(() => {
  prevAshlrHome = process.env.ASHLR_HOME;
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'ashlr-m342-dispatch-production-')));
  process.env.ASHLR_HOME = home;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  _setDispatchProductionLedgerRetentionHooksForTest(undefined);
  useNativePrivateStorageFixture();
  if (prevAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = prevAshlrHome;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  rmSync(home, { recursive: true, force: true });
});

describe('M342 dispatch production ledger', () => {
  it('persists only an authenticated metadata-only randomized selection commitment', () => {
    const event = makeEvent({
      backend: 'codex',
      tier: 'frontier',
      model: 'gpt-5.6',
      runId: 'selection-run',
      trajectoryId: 'run:selection-run',
      objectiveHash: 'c'.repeat(64),
      routerPolicyVersion: 'fleet-router-v1',
      learningEpoch: '2026-07-08',
    });
    const selectionObservation = createDispatchSelectionObservation({
      candidates: [
        { backend: 'codex', tier: 'frontier', model: 'gpt-5.6' },
        { backend: 'claude', tier: 'frontier', model: 'opus' },
      ],
      selected: { backend: 'codex', tier: 'frontier', model: 'gpt-5.6' },
      selectionPolicyVersion: 'canary-v1',
      randomizationProtocolVersion: 'uniform-v1',
      selectionProbabilityPpm: 500_000,
      trajectoryId: event.trajectoryId!,
      runId: event.runId!,
      objectiveHash: event.objectiveHash!,
      routerPolicyVersion: event.routerPolicyVersion!,
      learningEpoch: event.learningEpoch!,
    }, loadOrCreateKey());
    expect(selectionObservation).not.toBeNull();
    if (!selectionObservation) throw new Error('expected selection observation');

    expect(recordDispatchProduction({ ...event, selectionObservation })).toEqual({
      attempted: 1, recorded: 1, failed: 0,
    });
    const stored = readDispatchProductionEvents();
    expect(stored[0]?.selectionObservation).toMatchObject({
      authority: 'observation-only',
      mode: 'randomized-canary',
      candidateCount: 2,
      selectionProbabilityPpm: 500_000,
      selectedBackend: 'codex',
    });
    expect(JSON.stringify(stored[0])).not.toContain('claude');

    const path = join(dispatchProductionDir(), '2026-07-08.jsonl');
    const tampered = JSON.parse(readFileSync(path, 'utf8').trim()) as Record<string, unknown>;
    (tampered['selectionObservation'] as Record<string, unknown>)['selectedRank'] = 0;
    writeFileSync(path, `${JSON.stringify(tampered)}\n`, 'utf8');
    expect(readDispatchProductionEventsDetailed()).toMatchObject({
      sourceState: 'degraded', complete: false, invalidRows: 1,
    });
  });

  it('keeps V1 signed selection-start receipts unjoined and degrades a missing claimed receipt', () => {
    const now = new Date().toISOString();
    const event = makeEvent({
      ts: now,
      backend: 'codex',
      tier: 'frontier',
      model: 'gpt-5.6',
      runId: 'receipt-qualified-run',
      trajectoryId: 'run:receipt-qualified-run',
      objectiveHash: 'd'.repeat(64),
      routerPolicyVersion: 'fleet-router-v1',
      learningEpoch: now.slice(0, 10),
    });
    const selectionObservation = createDispatchSelectionObservation({
      candidates: [
        { backend: 'codex', tier: 'frontier', model: 'gpt-5.6' },
        { backend: 'claude', tier: 'frontier', model: 'opus' },
      ],
      selected: { backend: 'codex', tier: 'frontier', model: 'gpt-5.6' },
      selectionPolicyVersion: 'canary-v1',
      randomizationProtocolVersion: 'uniform-v1',
      selectionProbabilityPpm: 500_000,
      trajectoryId: event.trajectoryId!,
      runId: event.runId!,
      objectiveHash: event.objectiveHash!,
      routerPolicyVersion: event.routerPolicyVersion!,
      learningEpoch: event.learningEpoch!,
    }, loadOrCreateKey());
    expect(selectionObservation).not.toBeNull();
    if (!selectionObservation) throw new Error('expected selection observation');
    const receipt = writeSelectionStartReceipt({
      root: {
        runId: event.runId!, trajectoryId: event.trajectoryId!, objectiveHash: event.objectiveHash!,
      },
      claim: {
        queueId: '8f76ce25-9b10-4ddb-8e94-43a4d880d4fc', claimEpoch: 1, claimBindingDigest: 'e'.repeat(64),
      },
      selectionObservation,
      ts: new Date(Date.now() - 1_000).toISOString(),
    });
    expect(receipt.status).toBe('recorded');
    if (receipt.status !== 'recorded') throw new Error('receipt was not recorded');
    expect(recordDispatchProduction({
      ...event, selectionObservation, selectionStartReceiptId: receipt.receipt.receiptId,
    })).toMatchObject({ recorded: 1 });
    expect(readDispatchProductionYieldDetailed({ windowMs: 60 * 60 * 1000 }).selectionObservationState)
      .toBe('unjoined');
    const [trajectory] = listTrajectoryRecords({
      windowHours: 1,
      deps: {
        readDispatchProductionEvents: () => [{
          ...event, selectionObservation, selectionStartReceiptId: receipt.receipt.receiptId,
        }],
        readAgentActions: () => [],
        readSkillUseEvents: () => [],
        listOutcomeRecords: () => [],
        loadProposal: () => null,
      },
    });
    expect(trajectory?.receiptQualifiedSelectionObservation).toBeUndefined();
    expect(hasReceiptQualifiedSelectionObservation(trajectory?.receiptQualifiedSelectionObservation)).toBe(false);
    if (!trajectory) throw new Error('trajectory was not projected');
    const eligibility = buildLearningEligibilityProjectionV1({
      records: [trajectory],
      trajectorySourceComplete: true,
      learningEpoch: now.slice(0, 10),
    }, { identityKey: () => loadOrCreateKey() });
    expect(eligibility).toMatchObject({ ok: true });
    if (!eligibility.ok) throw new Error('eligibility projection failed');
    expect(eligibility.projection.members[0]).toMatchObject({ selectionPropensityAvailable: false });

    expect(recordDispatchProduction({
      ...event,
      itemId: 'missing-receipt',
      selectionObservation,
      selectionStartReceiptId: 'f'.repeat(64),
    })).toMatchObject({ recorded: 1 });
    expect(readDispatchProductionYieldDetailed({ windowMs: 60 * 60 * 1000 }).selectionObservationState)
      .toBe('degraded');
  });

  it('appends and reads dispatch-production events newest first', () => {
    const written = recordDispatchProduction([
      makeEvent({ itemId: 'old', ts: '2026-07-07T23:59:00.000Z' }),
      makeEvent({ itemId: 'new', ts: '2026-07-08T00:01:00.000Z', outcome: 'proposal-created', proposalCreated: true, proposalId: 'prop-new' }),
    ]);

    const events = readDispatchProductionEvents();

    expect(written).toEqual({ attempted: 2, recorded: 2, failed: 0 });
    expect(events.map((event) => event.itemId)).toEqual(['new', 'old']);
    expect(events[0]).toMatchObject({
      schemaVersion: 1,
      outcome: 'proposal-created',
      proposalCreated: true,
      proposalId: 'prop-new',
      basis: 'run-proposal-outcome',
    });
  });

  it('persists physical repo identity and rejects legacy lexical or linked aliases', () => {
    useWindowsSemanticPrivateStorageFixture();
    const physicalRepo = join(home, 'physical-repo');
    const nested = join(physicalRepo, 'identity-probe');
    const linkedAlias = join(home, 'repo-alias');
    mkdirSync(nested, { recursive: true });
    const canonicalRepo = realpathSync.native(physicalRepo);
    const lexicalAlias = join(nested, '..');
    symlinkSync(canonicalRepo, linkedAlias, process.platform === 'win32' ? 'junction' : 'dir');

    expect(recordDispatchProduction([
      makeEvent({ itemId: 'lexical-alias', repo: lexicalAlias }),
      makeEvent({ itemId: 'linked-alias', repo: linkedAlias }),
    ])).toEqual({ attempted: 2, recorded: 2, failed: 0 });

    const ledgerPath = join(dispatchProductionDir(), '2026-07-08.jsonl');
    const raw = readFileSync(ledgerPath, 'utf8');
    const rows = raw.trim().split('\n').map((line) => JSON.parse(line) as DispatchProductionEvent);
    expect(rows.map((row) => row.repo)).toEqual([canonicalRepo, canonicalRepo]);
    expect(readDispatchProductionEvents().map((event) => event.repo)).toEqual([canonicalRepo, canonicalRepo]);
    expect(readDispatchProductionParents([{
      ts: '2026-07-08T12:00:00.000Z',
      itemId: 'linked-alias',
      repo: linkedAlias,
      outcome: 'empty-diff',
      attemptId: rows[1]!.trajectoryId ?? rows[1]!.runId!,
    }])).toEqual(['found']);

    const legacyAlias = makeEvent({ itemId: 'legacy-alias', repo: linkedAlias });
    writeFileSync(ledgerPath, `${raw}${JSON.stringify(legacyAlias)}\n`, 'utf8');
    const detailed = readDispatchProductionEventsDetailed();
    expect(detailed.events.map((event) => event.itemId)).toEqual(['linked-alias', 'lexical-alias']);
    expect(detailed).toMatchObject({ sourceState: 'degraded', complete: false, invalidRows: 1 });
    const rawAfter = readFileSync(ledgerPath, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as DispatchProductionEvent);
    expect(rawAfter.at(-1)?.repo).toBe(linkedAlias);
  });

  it('degrades parent authority when a matching partition also contains malformed data', () => {
    const event = makeEvent({
      itemId: 'parent-malformed',
      runId: 'run-parent-malformed',
      trajectoryId: 'run:attempt-parent-malformed',
    });
    expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    appendFileSync(
      join(dispatchProductionDir(), `${event.ts.slice(0, 10)}.jsonl`),
      'malformed sibling\n',
      'utf8',
    );

    expect(readDispatchProductionParents([{
      ts: event.ts,
      itemId: event.itemId,
      repo: event.repo,
      outcome: event.outcome,
      attemptId: event.trajectoryId!,
    }])).toEqual(['degraded']);
  });

  it('degrades parent authority when a matching partition has a torn tail', () => {
    const event = makeEvent({
      itemId: 'parent-torn',
      runId: 'run-parent-torn',
      trajectoryId: 'run:attempt-parent-torn',
    });
    expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    appendFileSync(
      join(dispatchProductionDir(), `${event.ts.slice(0, 10)}.jsonl`),
      '{"schemaVersion":1',
      'utf8',
    );

    expect(readDispatchProductionParents([{
      ts: event.ts,
      itemId: event.itemId,
      repo: event.repo,
      outcome: event.outcome,
      attemptId: event.trajectoryId!,
    }])).toEqual(['degraded']);
  });

  it('degrades parent authority for conflicting canonical sibling routing evidence', () => {
    const event = makeEvent({
      itemId: 'parent-conflicting-sibling',
      runId: 'run-parent-conflicting-sibling',
      trajectoryId: 'run:attempt-parent-conflicting-sibling',
    });
    expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    appendCanonicalDispatchEvent(makeEvent({
      ts: event.ts,
      itemId: event.itemId,
      repo: event.repo,
      outcome: event.outcome,
      runId: event.runId,
      trajectoryId: event.trajectoryId,
      backend: 'codex',
      tier: 'frontier',
      model: 'gpt-5.5',
      assignedBy: 'daemon',
      routeReason: 'conflicting canonical parent route',
    }));

    expect(readDispatchProductionParents([{
      ts: event.ts,
      itemId: event.itemId,
      repo: event.repo,
      outcome: event.outcome,
      attemptId: event.trajectoryId!,
      backend: 'local-coder',
      tier: 'mid',
    }])).toEqual(['degraded']);
  });

  it('indexes 10k parent identities without quadratic target-by-row filtering', () => {
    const repo = join(home, 'parent-performance-repo');
    mkdirSync(repo, { recursive: true });
    const events = Array.from({ length: 10_000 }, (_, index) => sanitizeDispatchProductionEvent(makeEvent({
      ts: '2026-07-08T12:00:00.000Z',
      itemId: `parent-performance-${index}`,
      repo,
      runId: `run-parent-performance-${index}`,
      trajectoryId: `run:attempt-parent-performance-${index}`,
    }), { materializeLearningLabel: true }));
    mkdirSync(dispatchProductionDir(), { recursive: true });
    writeFileSync(
      join(dispatchProductionDir(), '2026-07-08.jsonl'),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
      'utf8',
    );
    const targets = events.map((event) => ({
      ts: event.ts,
      itemId: event.itemId,
      repo: event.repo,
      outcome: event.outcome,
      attemptId: event.trajectoryId!,
    }));

    const started = performance.now();
    const statuses = readDispatchProductionParents(targets);
    const elapsedMs = performance.now() - started;

    expect(statuses).toHaveLength(10_000);
    expect(statuses.every((status) => status === 'found')).toBe(true);
    expect(elapsedMs).toBeLessThan(1_500);
  }, 10_000);

  it('derives exact attempt proofs across UTC partitions without trusting caller routing claims', () => {
    const physicalRepo = join(home, 'proof-physical-repo');
    const linkedAlias = join(home, 'proof-repo-alias');
    mkdirSync(physicalRepo, { recursive: true });
    symlinkSync(physicalRepo, linkedAlias, process.platform === 'win32' ? 'junction' : 'dir');
    const first = makeProofEvent({
      repo: physicalRepo,
      ts: '2026-07-08T23:59:59.999Z',
      runId: 'run-proof-first',
      trajectoryId: 'run:attempt-proof-first',
    });
    const second = makeProofEvent({
      repo: physicalRepo,
      ts: '2026-07-09T00:00:00.000Z',
      runId: 'run-proof-second',
      trajectoryId: 'run:attempt-proof-second',
      backend: 'codex',
      model: undefined,
      routeSnapshot: {
        backend: 'codex',
        tier: 'mid',
        assignedBy: 'daemon',
        reason: 'generated repair proof route',
        routerPolicyVersion: 'fleet-router-v1',
      },
      repairAttemptOrdinal: 2,
      repairPreviousBackend: 'local-coder',
    });

    expect(recordDispatchProduction([first, second])).toEqual({ attempted: 2, recorded: 2, failed: 0 });
    const results = resolveDispatchProductionAttemptProofs([
      proofTarget(second, { repo: linkedAlias }),
      proofTarget(first, { repo: linkedAlias }),
    ]);

    expect(results).toEqual([
      {
        status: 'proven',
        proof: expect.objectContaining({
          schemaVersion: 1,
          integrityClass: 'owner-writable-local',
          cryptographicallyTrusted: false,
          rollbackProtected: false,
          eventTs: second.ts,
          attemptHash: generatedRepairLifecycleAttemptHash(second.trajectoryId!),
          backend: 'codex',
          tier: 'mid',
          model: null,
          repairAttemptOrdinal: 2,
          eventDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      },
      {
        status: 'proven',
        proof: expect.objectContaining({
          eventTs: first.ts,
          attemptHash: generatedRepairLifecycleAttemptHash(first.trajectoryId!),
          backend: 'local-coder',
          tier: 'mid',
          model: 'qwen-2.5-coder',
          repairAttemptOrdinal: 1,
          eventDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      },
    ]);
  });

  it('proves proposal-created attempts only with the exact proposal and coherent summaries', () => {
    const proposal = makeProposalProofEvent();
    expect(recordDispatchProduction(proposal)).toEqual({ attempted: 1, recorded: 1, failed: 0 });

    expect(resolveDispatchProductionAttemptProofs([proofTarget(proposal)])[0]).toMatchObject({
      status: 'proven',
      proof: {
        eventTs: proposal.ts,
        attemptHash: generatedRepairLifecycleAttemptHash(proposal.trajectoryId!),
      },
    });
    expect(resolveDispatchProductionAttemptProofs([
      proofTarget(proposal, { proposalId: 'proposal-proof-substitution' }),
    ])).toEqual([{ status: 'unproven', reason: 'target-mismatch' }]);

    rmSync(dispatchProductionDir(), { recursive: true, force: true });
    const summaryMismatch = makeProposalProofEvent({
      runId: 'run-proof-proposal-summary-mismatch',
      trajectoryId: 'run:attempt-proof-proposal-summary-mismatch',
      runEventSummary: {
        runId: 'run-proof-proposal-summary-mismatch',
        status: 'done',
        outcome: 'proposal-created',
        proposalCreated: true,
        proposalId: 'different-proposal-id',
        diffFiles: 2,
        diffLines: 17,
        costUsd: 0.003,
      },
    });
    expect(recordDispatchProduction(summaryMismatch).recorded).toBe(1);
    expect(resolveDispatchProductionAttemptProofs([proofTarget(summaryMismatch)])).toEqual([
      { status: 'unproven', reason: 'event-ineligible' },
    ]);

    rmSync(dispatchProductionDir(), { recursive: true, force: true });
    const diffMismatch = makeProposalProofEvent({
      runId: 'run-proof-proposal-diff-mismatch',
      trajectoryId: 'run:attempt-proof-proposal-diff-mismatch',
      runEventSummary: {
        runId: 'run-proof-proposal-diff-mismatch',
        status: 'done',
        outcome: 'proposal-created',
        proposalCreated: true,
        proposalId: 'proposal-proof-authority',
        diffFiles: 3,
        diffLines: 17,
        costUsd: 0.003,
        actionCounts: { proposalCreated: 1, diffFiles: 3, diffLines: 17 },
      },
    });
    expect(recordDispatchProduction(diffMismatch).recorded).toBe(1);
    expect(resolveDispatchProductionAttemptProofs([proofTarget(diffMismatch)])).toEqual([
      { status: 'unproven', reason: 'event-ineligible' },
    ]);
  });

  it('materializes exact failure receipts for treatment-free capture and proposal repair lineage', () => {
    useWindowsSemanticPrivateStorageFixture();
    const accepted = (['capture', 'proposal'] as const).map((kind, index) => {
      const handoffId = (10 + index).toString(16).padStart(64, '0');
      return makeGeneratedRepairFailureEvent(kind, {
        repairHandoffId: handoffId,
        repairGenerationId: repairGenerationIdFromHandoffId(handoffId)!,
        runId: `attempt-${kind}-failure`,
        trajectoryId: `run:attempt-${kind}-failure`,
      });
    });
    expect(recordDispatchProduction(accepted)).toEqual({ attempted: 2, recorded: 2, failed: 0 });
    const receiptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
    for (const event of accepted) {
      expect(existsSync(join(receiptDir, failureAttemptReceiptName(event)))).toBe(true);
      expect(resolveDispatchProductionFailureAttemptReceipt({
        repairGenerationId: event.repairGenerationId!,
        repairAttemptOrdinal: 1,
        attemptHash: generatedRepairLifecycleAttemptHash(event.trajectoryId!),
      })).toMatchObject({
        status: 'proven',
        proof: {
          repairGenerationId: event.repairGenerationId,
          repairAttemptOrdinal: 1,
          attemptHash: generatedRepairLifecycleAttemptHash(event.trajectoryId!),
        },
        event: {
          itemId: event.itemId,
          repairRootId: event.repairRootId,
          repairDepth: 0,
        },
      });
    }
    const batch = readDispatchProductionFailureAttemptReceipts(
      accepted.map((event) => event.repairGenerationId!),
    );
    expect(batch).toMatchObject({ status: 'resolved', authoritative: true });
    if (batch.status === 'resolved') {
      expect(batch.receipts).toHaveLength(2);
      expect(batch.receipts.every((receipt) =>
        receipt.proof.repairTreatmentUnitId === undefined &&
        receipt.proof.repairTreatment === undefined)).toBe(true);
    }

    const invalid = accepted.map((event, index) => {
      const handoffId = (20 + index).toString(16).padStart(64, '0');
      return makeGeneratedRepairFailureEvent(index === 0 ? 'capture' : 'proposal', {
        repairHandoffId: handoffId,
        repairGenerationId: repairGenerationIdFromHandoffId(handoffId)!,
        runId: `attempt-invalid-failure-${index}`,
        trajectoryId: index === 0
          ? `run:attempt-invalid-failure-${index}`
          : 'run:another-reservation',
        ...(index === 0 ? { repairRootId: undefined, repairDepth: undefined } : {}),
      });
    });
    expect(recordDispatchProduction(invalid)).toEqual({ attempted: 2, recorded: 2, failed: 0 });
    for (const event of invalid) {
      expect(existsSync(join(receiptDir, failureAttemptReceiptName(event)))).toBe(false);
    }

    const terminalHandoffIds = ['3'.repeat(64), '4'.repeat(64)];
    const terminal = [
      makeProofEvent({
        itemId: 'ashlr-hub:proposal-repair:111111111111',
        repairHandoffId: terminalHandoffIds[0],
        repairGenerationId: repairGenerationIdFromHandoffId(terminalHandoffIds[0]!)!,
        repairTreatmentUnitId: undefined,
        repairTreatment: undefined,
        repairRootId: 'a'.repeat(64),
        repairDepth: 0,
        runId: 'attempt-nondiagnostic-empty',
        trajectoryId: 'run:attempt-nondiagnostic-empty',
      }),
      makeProposalProofEvent({
        itemId: 'ashlr-hub:proposal-repair-capture:222222222222',
        repairHandoffId: terminalHandoffIds[1],
        repairGenerationId: repairGenerationIdFromHandoffId(terminalHandoffIds[1]!)!,
        repairTreatmentUnitId: undefined,
        repairTreatment: undefined,
        repairRootId: 'b'.repeat(64),
        repairDepth: 0,
        runId: 'attempt-nondiagnostic-proposal',
        trajectoryId: 'run:attempt-nondiagnostic-proposal',
      }),
    ];
    expect(recordDispatchProduction(terminal)).toEqual({ attempted: 2, recorded: 2, failed: 0 });
    for (const event of terminal) {
      expect(existsSync(join(receiptDir, `${event.repairGenerationId}-1.json`))).toBe(true);
      expect(resolveDispatchProductionAttemptReceiptWitnesses([{
        repairGenerationId: event.repairGenerationId!, repairAttemptOrdinal: 1,
      }])).toMatchObject({
        status: 'resolved',
        resolutions: [{
          status: 'proven',
          event: {
            repairRootId: event.repairRootId,
            repairDepth: event.repairDepth,
          },
        }],
      });
    }
  }, 30_000);

  it('recovers a failure append crash without duplicating its authoritative raw event', () => {
    useWindowsSemanticPrivateStorageFixture();
    const event = makeGeneratedRepairFailureEvent('proposal', {
      runId: 'attempt-failure-append-crash',
      trajectoryId: 'run:attempt-failure-append-crash',
    });
    const canonical = sanitizeDispatchProductionEvent(event, { materializeLearningLabel: true });
    const receiptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
    const receiptPath = join(receiptDir, failureAttemptReceiptName(canonical));
    const intentPath = join(receiptDir, failureAttemptReceiptName(canonical, true));
    const partition = join(dispatchProductionDir(), `${canonical.ts.slice(0, 10)}.jsonl`);
    let injected = false;
    _setDispatchProductionLedgerRetentionHooksForTest({
      afterFailureAttemptAppend: () => {
        if (injected) return;
        injected = true;
        throw new Error('injected failure append crash');
      },
    });

    expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(existsSync(intentPath)).toBe(true);
    expect(existsSync(receiptPath)).toBe(false);
    expect(readFileSync(partition, 'utf8').split('\n').filter((line) =>
      line === JSON.stringify(canonical))).toHaveLength(1);
    expect(resolveDispatchProductionFailureAttemptReceipt({
      repairGenerationId: canonical.repairGenerationId!,
      repairAttemptOrdinal: canonical.repairAttemptOrdinal!,
      attemptHash: generatedRepairLifecycleAttemptHash(canonical.trajectoryId!),
    })).toEqual({ status: 'missing', reason: 'receipt-uncommitted' });

    const conflicting = {
      ...event,
      routeReason: 'conflicting replay after committed failure append',
    };
    expect(recordDispatchProduction(conflicting)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(existsSync(intentPath)).toBe(true);
    _setDispatchProductionLedgerRetentionHooksForTest(undefined);
    expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(existsSync(intentPath)).toBe(false);
    expect(existsSync(receiptPath)).toBe(true);
    expect(readFileSync(partition, 'utf8').split('\n').filter((line) =>
      line === JSON.stringify(canonical))).toHaveLength(1);
    expect(resolveDispatchProductionFailureAttemptReceipt({
      repairGenerationId: canonical.repairGenerationId!,
      repairAttemptOrdinal: canonical.repairAttemptOrdinal!,
      attemptHash: generatedRepairLifecycleAttemptHash(canonical.trajectoryId!),
    })).toMatchObject({ status: 'proven', event: { outcome: canonical.outcome } });
  });

  it('recovers one exact failure append beyond the analytics partition read bound', () => {
    useWindowsSemanticPrivateStorageFixture();
    const event = makeGeneratedRepairFailureEvent('capture', {
      runId: 'attempt-failure-oversized-append-crash',
      trajectoryId: 'run:attempt-failure-oversized-append-crash',
    });
    const canonical = sanitizeDispatchProductionEvent(event, { materializeLearningLabel: true });
    const canonicalRow = Buffer.from(`${JSON.stringify(canonical)}\n`, 'utf8');
    writeTestAttemptReceiptProtocolActivation([{
      generationId: canonical.repairGenerationId!, admittedAt: canonical.ts,
    }]);
    const partition = join(dispatchProductionDir(), `${canonical.ts.slice(0, 10)}.jsonl`);
    writeFileSync(partition, 'oversized analytics history\n', { mode: 0o600 });
    truncateSync(partition, 33 * 1024 * 1024);
    appendFileSync(partition, '\n');
    const appendOffset = 33 * 1024 * 1024 + 1;
    let injected = false;
    _setDispatchProductionLedgerRetentionHooksForTest({
      afterFailureAttemptAppend: () => {
        if (injected) return;
        injected = true;
        throw new Error('injected oversized failure append crash');
      },
    });

    expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    const receiptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
    const intentPath = join(receiptDir, failureAttemptReceiptName(canonical, true));
    const intent = JSON.parse(readFileSync(intentPath, 'utf8')) as {
      receiptSchemaVersion: number;
      appendAuthority: { appendOffset: number; appendBytes: number };
    };
    expect(intent).toMatchObject({
      receiptSchemaVersion: 2,
      appendAuthority: { appendOffset, appendBytes: canonicalRow.length },
    });
    expect(readExactFileSlice(partition, appendOffset, canonicalRow.length)).toEqual(canonicalRow);

    _setDispatchProductionLedgerRetentionHooksForTest(undefined);
    expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(existsSync(intentPath)).toBe(false);
    expect(readExactFileSlice(partition, appendOffset, canonicalRow.length)).toEqual(canonicalRow);
    expect(readFileSync(partition).length).toBe(appendOffset + canonicalRow.length);
  });

  it.each(['replacement', 'truncation', 'mutation'] as const)(
    'fails closed when a crashed failure append partition suffers %s',
    (damage) => {
      useWindowsSemanticPrivateStorageFixture();
      const event = makeGeneratedRepairFailureEvent('proposal', {
        runId: `attempt-failure-crash-${damage}`,
        trajectoryId: `run:attempt-failure-crash-${damage}`,
      });
      const canonical = sanitizeDispatchProductionEvent(event, { materializeLearningLabel: true });
      let injected = false;
      _setDispatchProductionLedgerRetentionHooksForTest({
        afterFailureAttemptAppend: () => {
          if (injected) return;
          injected = true;
          throw new Error(`injected failure append ${damage}`);
        },
      });
      expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
      const receiptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
      const intentPath = join(receiptDir, failureAttemptReceiptName(canonical, true));
      const receiptPath = join(receiptDir, failureAttemptReceiptName(canonical));
      const intent = JSON.parse(readFileSync(intentPath, 'utf8')) as {
        appendAuthority: { appendOffset: number };
      };
      const partition = join(dispatchProductionDir(), `${canonical.ts.slice(0, 10)}.jsonl`);
      const bytes = readFileSync(partition);
      if (damage === 'replacement') {
        renameSync(partition, `${partition}.replaced`);
        writeFileSync(partition, bytes, { mode: 0o600 });
      } else if (damage === 'truncation') {
        truncateSync(partition, intent.appendAuthority.appendOffset);
      } else {
        bytes[intent.appendAuthority.appendOffset] = bytes[intent.appendAuthority.appendOffset]! ^ 1;
        writeFileSync(partition, bytes, { mode: 0o600 });
      }

      _setDispatchProductionLedgerRetentionHooksForTest(undefined);
      expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
      expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
      expect(existsSync(intentPath)).toBe(true);
      expect(existsSync(receiptPath)).toBe(false);
    },
  );

  it('fails old failure intents closed when exact append metadata is absent', () => {
    const event = makeGeneratedRepairFailureEvent('capture', {
      runId: 'attempt-failure-legacy-intent',
      trajectoryId: 'run:attempt-failure-legacy-intent',
    });
    const canonical = sanitizeDispatchProductionEvent(event, { materializeLearningLabel: true });
    let injected = false;
    _setDispatchProductionLedgerRetentionHooksForTest({
      afterFailureAttemptAppend: () => {
        if (injected) return;
        injected = true;
        throw new Error('injected legacy failure intent crash');
      },
    });
    expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    const receiptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
    const intentPath = join(receiptDir, failureAttemptReceiptName(canonical, true));
    const current = JSON.parse(readFileSync(intentPath, 'utf8')) as { activationId: string };
    writeFileSync(intentPath, `${JSON.stringify({
      receiptSchemaVersion: 1,
      validation: 'bounded-raw-history-v1',
      activationId: current.activationId,
      event: canonical,
    })}\n`, { mode: 0o600 });
    const partition = join(dispatchProductionDir(), `${canonical.ts.slice(0, 10)}.jsonl`);
    const before = readFileSync(partition);

    _setDispatchProductionLedgerRetentionHooksForTest(undefined);
    expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(readFileSync(partition)).toEqual(before);
    expect(existsSync(intentPath)).toBe(true);
    expect(existsSync(join(receiptDir, failureAttemptReceiptName(canonical)))).toBe(false);
  });

  it('rejects materially future-dated canonical generated-repair attempt writes', () => {
    const future = makeProofEvent({
      ts: new Date(Date.now() + 5 * 60_000).toISOString(),
      runId: 'run-proof-future',
      trajectoryId: 'run:attempt-proof-future',
    });

    expect(recordDispatchProduction(future)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(existsSync(join(dispatchProductionDir(), `${future.ts.slice(0, 10)}.jsonl`))).toBe(false);
  });

  it('accepts an attempt within future skew without creating a self-invalid protocol', () => {
    const future = makeProofEvent({
      ts: new Date(Date.now() + 30_000).toISOString(),
      runId: 'run-proof-allowed-future-skew',
      trajectoryId: 'run:attempt-proof-allowed-future-skew',
    });

    expect(recordDispatchProduction(future)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(recordDispatchProduction(future)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(resolveDispatchProductionAttemptReceiptWitnesses([{
      repairGenerationId: future.repairGenerationId!, repairAttemptOrdinal: 1,
    }])).toMatchObject({ status: 'resolved', resolutions: [{ status: 'proven' }] });
    const protocol = JSON.parse(readFileSync(join(
      dispatchProductionDir(), 'repair-attempt-proofs', '.protocol.json',
    ), 'utf8')) as { activatedAt: string; acceptsEventsAfter: string };
    expect(Date.parse(protocol.acceptsEventsAfter)).toBeLessThanOrEqual(Date.parse(protocol.activatedAt));
  });

  it('never publishes a staged attempt receipt when the authority append fails', () => {
    const event = makeProofEvent({
      runId: 'run-proof-append-failure',
      trajectoryId: 'run:attempt-proof-append-failure',
    });
    const partition = join(dispatchProductionDir(), `${event.ts.slice(0, 10)}.jsonl`);
    mkdirSync(dispatchProductionDir(), { recursive: true });
    const appendLock = acquireLocalStoreLock(`${partition}.lock`);
    expect(appendLock).not.toBeNull();

    try {
      expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    } finally {
      if (appendLock) releaseLocalStoreLock(appendLock);
    }
    const receiptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
    expect(existsSync(join(
      receiptDir,
      `${event.repairGenerationId}-${event.repairAttemptOrdinal}.json`,
    ))).toBe(false);
    expect(existsSync(join(
      receiptDir,
      `${event.repairGenerationId}-${event.repairAttemptOrdinal}.intent.json`,
    ))).toBe(true);
    expect(readdirSync(receiptDir).filter((name) => name.includes('.tmp'))).toEqual([]);
    expect(resolveDispatchProductionAttemptReceiptWitnesses([{
      repairGenerationId: event.repairGenerationId!,
      repairAttemptOrdinal: 1,
    }])).toEqual({
      status: 'resolved',
      resolutions: [{ status: 'missing', reason: 'receipt-uncommitted' }],
    });
    expect(resolveDispatchProductionAttemptProofs([proofTarget(event)])[0]?.status).not.toBe('proven');
  });

  it('retires an uncommitted intent so a cross-day retry can acquire authority', () => {
    useWindowsSemanticPrivateStorageFixture();
    seedUnrelatedDatedPartitions(40);
    const currentDayStart = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    const original = makeProofEvent({
      ts: new Date(currentDayStart - 1).toISOString(),
      runId: 'run-cross-day-crash-original',
      trajectoryId: 'run:attempt-cross-day-crash-original',
    });
    const partition = join(dispatchProductionDir(), `${original.ts.slice(0, 10)}.jsonl`);
    const appendLock = acquireLocalStoreLock(`${partition}.lock`);
    expect(appendLock).not.toBeNull();

    try {
      expect(recordDispatchProduction(original)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    } finally {
      if (appendLock) releaseLocalStoreLock(appendLock);
    }
    expect(resolveDispatchProductionAttemptReceiptWitnesses([{
      repairGenerationId: original.repairGenerationId!, repairAttemptOrdinal: 1,
    }])).toEqual({
      status: 'resolved',
      resolutions: [{ status: 'missing', reason: 'receipt-uncommitted' }],
    });

    const conflicting = makeProofEvent({
      ts: new Date(currentDayStart + 1).toISOString(),
      runId: 'run-cross-day-crash-conflict',
      trajectoryId: 'run:attempt-cross-day-crash-conflict',
      backend: 'codex',
      model: 'gpt-5.5',
      routeSnapshot: {
        backend: 'codex',
        tier: 'mid',
        model: 'gpt-5.5',
        assignedBy: 'daemon',
        reason: 'cross-day conflicting retry',
        routerPolicyVersion: 'fleet-router-v1',
      },
    });
    expect(recordDispatchProduction(conflicting)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(readFileSync(
      join(dispatchProductionDir(), `${conflicting.ts.slice(0, 10)}.jsonl`),
      'utf8',
    )).toContain(conflicting.trajectoryId!);
    expect(recordDispatchProduction(original)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(resolveDispatchProductionAttemptReceiptWitnesses([{
      repairGenerationId: original.repairGenerationId!, repairAttemptOrdinal: 1,
    }])).toMatchObject({
      status: 'resolved',
      resolutions: [{ status: 'proven', event: { trajectoryId: conflicting.trajectoryId } }],
    });
  });

  it('resumes a committed append intent before rejecting a conflicting retry', () => {
    const original = makeProofEvent({
      runId: 'run-committed-intent-original',
      trajectoryId: 'run:attempt-committed-intent-original',
    });
    const canonical = sanitizeDispatchProductionEvent(original, { materializeLearningLabel: true });
    writeTestAttemptReceiptProtocolActivation([{
      generationId: canonical.repairGenerationId!,
      admittedAt: canonical.ts,
    }]);
    const receiptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
    writeFileSync(
      join(receiptDir, `${canonical.repairGenerationId}-1.intent.json`),
      validatedAttemptReceiptText(canonical),
      'utf8',
    );
    appendCanonicalDispatchEvent(canonical);
    const conflicting = makeProofEvent({
      ts: '2026-07-09T00:00:00.001Z',
      runId: 'run-committed-intent-conflict',
      trajectoryId: 'run:attempt-committed-intent-conflict',
      backend: 'codex',
      model: 'gpt-5.5',
      routeSnapshot: {
        backend: 'codex',
        tier: 'mid',
        model: 'gpt-5.5',
        assignedBy: 'daemon',
        reason: 'committed intent conflict',
        routerPolicyVersion: 'fleet-router-v1',
      },
    });

    expect(recordDispatchProduction(conflicting)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(existsSync(join(receiptDir, `${canonical.repairGenerationId}-1.intent.json`))).toBe(false);
    expect(existsSync(join(receiptDir, `${canonical.repairGenerationId}-1.json`))).toBe(true);
    expect(resolveDispatchProductionAttemptReceiptWitnesses([{
      repairGenerationId: canonical.repairGenerationId!, repairAttemptOrdinal: 1,
    }])).toMatchObject({
      status: 'resolved',
      resolutions: [{ status: 'proven', event: { trajectoryId: original.trajectoryId } }],
    });
    expect(existsSync(join(dispatchProductionDir(), '2026-07-09.jsonl'))).toBe(false);
  });

  it('never recreates a missing protocol over surviving receipt or intent authority', () => {
    const committed = makeProofEvent({
      runId: 'run-missing-protocol-receipt',
      trajectoryId: 'run:attempt-missing-protocol-receipt',
    });
    expect(recordDispatchProduction(committed)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    const receiptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
    const protocolPath = join(receiptDir, '.protocol.json');
    rmSync(protocolPath);
    expect(readDispatchProductionAttemptProtocolQuality()).toMatchObject({ status: 'degraded' });
    const nextHandoffId = 'd'.repeat(64);
    const next = makeProofEvent({
      repairHandoffId: nextHandoffId,
      repairGenerationId: repairGenerationIdFromHandoffId(nextHandoffId)!,
      runId: 'run-missing-protocol-next',
      trajectoryId: 'run:attempt-missing-protocol-next',
    });
    expect(recordDispatchProduction(next)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(existsSync(protocolPath)).toBe(false);

    rmSync(dispatchProductionDir(), { recursive: true, force: true });
    const pending = makeProofEvent({
      runId: 'run-missing-protocol-intent',
      trajectoryId: 'run:attempt-missing-protocol-intent',
    });
    const partition = join(dispatchProductionDir(), `${pending.ts.slice(0, 10)}.jsonl`);
    mkdirSync(dispatchProductionDir(), { recursive: true });
    const appendLock = acquireLocalStoreLock(`${partition}.lock`);
    expect(appendLock).not.toBeNull();
    try {
      expect(recordDispatchProduction(pending)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    } finally {
      if (appendLock) releaseLocalStoreLock(appendLock);
    }
    const pendingProtocolPath = join(
      dispatchProductionDir(), 'repair-attempt-proofs', '.protocol.json',
    );
    rmSync(pendingProtocolPath);
    expect(readDispatchProductionAttemptProtocolQuality()).toMatchObject({ status: 'degraded' });
    expect(recordDispatchProduction(pending)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(existsSync(pendingProtocolPath)).toBe(false);

    rmSync(dispatchProductionDir(), { recursive: true, force: true });
    const retentionOnlyDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
    mkdirSync(retentionOnlyDir, { recursive: true });
    writeFileSync(join(retentionOnlyDir, '.retention.json'), `${JSON.stringify({
      schemaVersion: 5,
      droppedThrough: pending.ts,
      retirementEpoch: 1,
      pendingGenerations: [],
      pendingArtifacts: [],
    })}\n`, 'utf8');
    expect(readDispatchProductionAttemptProtocolQuality()).toMatchObject({ status: 'degraded' });
  });

  it('detects protocol rollback before consuming a new generation admission', () => {
    const first = makeProofEvent({
      runId: 'run-protocol-rollback-first',
      trajectoryId: 'run:attempt-protocol-rollback-first',
    });
    expect(recordDispatchProduction(first)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    const protocolPath = join(
      dispatchProductionDir(), 'repair-attempt-proofs', '.protocol.json',
    );
    const oldProtocol = readFileSync(protocolPath, 'utf8');
    const secondHandoffId = 'd'.repeat(64);
    const second = makeProofEvent({
      repairHandoffId: secondHandoffId,
      repairGenerationId: repairGenerationIdFromHandoffId(secondHandoffId)!,
      runId: 'run-protocol-rollback-second',
      trajectoryId: 'run:attempt-protocol-rollback-second',
    });
    expect(recordDispatchProduction(second)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    writeFileSync(protocolPath, oldProtocol, 'utf8');
    const thirdHandoffId = 'e'.repeat(64);
    const third = makeProofEvent({
      repairHandoffId: thirdHandoffId,
      repairGenerationId: repairGenerationIdFromHandoffId(thirdHandoffId)!,
      runId: 'run-protocol-rollback-third',
      trajectoryId: 'run:attempt-protocol-rollback-third',
    });

    expect(recordDispatchProduction(third)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(readFileSync(protocolPath, 'utf8')).toBe(oldProtocol);
    expect(existsSync(join(
      dispatchProductionDir(), 'repair-attempt-proofs', `${third.repairGenerationId}-1.json`,
    ))).toBe(false);
  });

  it('never mints a receipt by replaying one row from conflicting pre-receipt history', () => {
    const wanted = makeProofEvent({
      runId: 'run-pre-receipt-wanted',
      trajectoryId: 'run:attempt-pre-receipt-wanted',
    });
    const conflicting = makeProofEvent({
      runId: 'run-pre-receipt-conflict',
      trajectoryId: 'run:attempt-pre-receipt-conflict',
      backend: 'codex',
      model: 'gpt-5.5',
      routeSnapshot: {
        backend: 'codex',
        tier: 'mid',
        model: 'gpt-5.5',
        assignedBy: 'daemon',
        reason: 'conflicting legacy attempt route',
        routerPolicyVersion: 'fleet-router-v1',
      },
    });
    appendCanonicalDispatchEvent(wanted);
    appendCanonicalDispatchEvent(conflicting);

    expect(recordDispatchProduction(wanted)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(resolveDispatchProductionAttemptReceiptWitnesses([{
      repairGenerationId: wanted.repairGenerationId!,
      repairAttemptOrdinal: 1,
    }])).toEqual({
      status: 'resolved',
      resolutions: [{ status: 'degraded', reason: 'source-unavailable' }],
    });
    expect(resolveDispatchProductionAttemptProofs([proofTarget(wanted)])).toEqual([
      { status: 'degraded', reason: 'source-unavailable' },
    ]);
  });

  it('rejects conflicting legacy generation history across the activation day boundary', () => {
    const wanted = makeProofEvent({
      ts: '2026-07-08T00:00:00.001Z',
      runId: 'run-cross-day-legacy-wanted',
      trajectoryId: 'run:attempt-cross-day-legacy-wanted',
    });
    const conflicting = makeProofEvent({
      ts: '2026-07-07T23:59:59.999Z',
      runId: 'run-cross-day-legacy-conflict',
      trajectoryId: 'run:attempt-cross-day-legacy-conflict',
      backend: 'codex',
      model: 'gpt-5.5',
      routeSnapshot: {
        backend: 'codex',
        tier: 'mid',
        model: 'gpt-5.5',
        assignedBy: 'daemon',
        reason: 'cross-day legacy conflict',
        routerPolicyVersion: 'fleet-router-v1',
      },
    });
    appendCanonicalDispatchEvent(conflicting);
    appendCanonicalDispatchEvent(wanted);

    expect(recordDispatchProduction(wanted)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(resolveDispatchProductionAttemptReceiptWitnesses([{
      repairGenerationId: wanted.repairGenerationId!, repairAttemptOrdinal: 1,
    }])).toEqual({
      status: 'resolved',
      resolutions: [{ status: 'degraded', reason: 'source-unavailable' }],
    });
  });

  it('activates a new generation after building bounded authority across forty old partitions', () => {
    seedUnrelatedDatedPartitions(40);
    const event = makeProofEvent({
      ts: new Date(Date.now() - 6 * 60 * 60_000).toISOString(),
      runId: 'run-mature-activation',
      trajectoryId: 'run:attempt-mature-activation',
    });

    expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(resolveDispatchProductionAttemptReceiptWitnesses([{
      repairGenerationId: event.repairGenerationId!, repairAttemptOrdinal: 1,
    }])).toMatchObject({ status: 'resolved', resolutions: [{ status: 'proven' }] });
  });

  it('blocks a forty-partition legacy generation replayed with a current timestamp', () => {
    seedUnrelatedDatedPartitions(40);
    const legacy = makeProofEvent({
      ts: '2024-01-01T12:30:00.000Z',
      runId: 'run-forty-partition-legacy',
      trajectoryId: 'run:attempt-forty-partition-legacy',
    });
    appendCanonicalDispatchEvent(legacy);
    const replay = makeProofEvent({
      ts: new Date().toISOString(),
      repairHandoffId: legacy.repairHandoffId,
      repairGenerationId: legacy.repairGenerationId,
      repairTreatmentUnitId: legacy.repairTreatmentUnitId,
      repairTreatment: legacy.repairTreatment,
      runId: 'run-forty-partition-replay',
      trajectoryId: 'run:attempt-forty-partition-replay',
    });

    expect(recordDispatchProduction(replay)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(resolveDispatchProductionAttemptReceiptWitnesses([{
      repairGenerationId: replay.repairGenerationId!, repairAttemptOrdinal: 1,
    }])).toEqual({
      status: 'resolved',
      resolutions: [{ status: 'degraded', reason: 'source-unavailable' }],
    });
  });

  it('accepts a bounded cross-midnight run while rejecting an older legacy replay', () => {
    seedUnrelatedDatedPartitions(40);
    const currentDayStart = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    const crossing = makeProofEvent({
      ts: new Date(currentDayStart - 1).toISOString(),
      runId: 'run-cross-midnight-activation',
      trajectoryId: 'run:attempt-cross-midnight-activation',
    });
    expect(recordDispatchProduction(crossing)).toEqual({ attempted: 1, recorded: 1, failed: 0 });

    const oldHandoffId = '8'.repeat(64);
    const legacy = makeProofEvent({
      ts: new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString(),
      repairHandoffId: oldHandoffId,
      repairGenerationId: repairGenerationIdFromHandoffId(oldHandoffId)!,
      runId: 'run-old-legacy-replay',
      trajectoryId: 'run:attempt-old-legacy-replay',
    });
    appendCanonicalDispatchEvent(legacy);

    expect(recordDispatchProduction(legacy)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(resolveDispatchProductionAttemptReceiptWitnesses([{
      repairGenerationId: legacy.repairGenerationId!, repairAttemptOrdinal: 1,
    }])).toEqual({
      status: 'resolved',
      resolutions: [{ status: 'missing', reason: 'receipt-missing' }],
    });
  });

  it('observationally distinguishes no append, a committed append, and an available receipt', () => {
    const event = makeProofEvent({
      runId: 'run-receipt-availability',
      trajectoryId: 'run:attempt-receipt-availability',
    });
    const target = proofTarget(event);

    expect(readDispatchProductionAttemptReceiptAvailability([target])).toEqual({
      status: 'resolved',
      resolutions: [{ status: 'missing', reason: 'raw-append-missing' }],
    });
    expect(existsSync(dispatchProductionDir())).toBe(false);

    writeTestAttemptReceiptProtocolActivation([{
      generationId: event.repairGenerationId!, admittedAt: event.ts,
    }]);
    appendCanonicalDispatchEvent(event);
    expect(readDispatchProductionAttemptReceiptAvailability([target])).toMatchObject({
      status: 'resolved',
      resolutions: [{
        status: 'missing',
        reason: 'receipt-missing-after-append',
        event: { trajectoryId: event.trajectoryId },
      }],
    });
    expect(existsSync(join(
      dispatchProductionDir(),
      'repair-attempt-proofs',
      `${event.repairGenerationId}-1.json`,
    ))).toBe(false);

    expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });

    const committedHandoffId = '7'.repeat(64);
    const committed = makeProofEvent({
      repairHandoffId: committedHandoffId,
      repairGenerationId: repairGenerationIdFromHandoffId(committedHandoffId)!,
      runId: 'run-receipt-available',
      trajectoryId: 'run:attempt-receipt-available',
    });
    expect(recordDispatchProduction(committed)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(readDispatchProductionAttemptReceiptAvailability([proofTarget(committed)])).toMatchObject({
      status: 'resolved',
      resolutions: [{ status: 'available', event: { trajectoryId: committed.trajectoryId } }],
    });
  });

  it('detects durable same-generation conflicts outside the caller target window', () => {
    const wanted = makeProofEvent({
      ts: '2026-07-08T12:00:00.000Z',
      runId: 'run-proof-window-wanted',
      trajectoryId: 'run:attempt-proof-window-wanted',
    });
    const outsideWindow = makeProofEvent({
      ts: '2026-07-10T12:00:00.000Z',
      runId: 'run-proof-window-conflict',
      trajectoryId: 'run:attempt-proof-window-conflict',
    });
    expect(recordDispatchProduction(wanted)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(recordDispatchProduction(outsideWindow)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    removeAttemptProofReceipts();
    appendCanonicalDispatchEvent(outsideWindow);

    expect(resolveDispatchProductionAttemptProofs([proofTarget(wanted, {
      sequenceStartTs: wanted.ts,
      sequenceEndTs: wanted.ts,
    })])).toEqual([{ status: 'unproven', reason: 'attempt-sequence-mismatch' }]);
  });

  it('does not let a protocol receipt mask a same-ordinal conflict in another date partition', () => {
    const wanted = makeProofEvent({
      ts: '2026-07-08T12:00:00.000Z',
      runId: 'run-receipt-cross-date-wanted',
      trajectoryId: 'run:attempt-receipt-cross-date-wanted',
    });
    const conflict = makeProofEvent({
      ts: '2026-07-10T12:00:00.000Z',
      runId: 'run-receipt-cross-date-conflict',
      trajectoryId: 'run:attempt-receipt-cross-date-conflict',
    });
    expect(recordDispatchProduction(wanted)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(recordDispatchProduction(conflict)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    appendCanonicalDispatchEvent(conflict);

    expect(resolveDispatchProductionAttemptProofs([proofTarget(wanted, {
      sequenceStartTs: wanted.ts,
      sequenceEndTs: wanted.ts,
    })])).toEqual([{ status: 'degraded', reason: 'partition-conflict' }]);
    expect(resolveDispatchProductionAttemptReceiptWitnesses([{
      repairGenerationId: wanted.repairGenerationId!, repairAttemptOrdinal: 1,
    }])).toEqual({
      status: 'resolved',
      resolutions: [{ status: 'degraded', reason: 'partition-conflict' }],
    });
  });

  it('rejects a stale cooperative generation conflict before it reaches durable history', () => {
    const committed = makeProofEvent({
      runId: 'run-proof-current-authority',
      trajectoryId: 'run:attempt-proof-current-authority',
    });
    const stale = makeProofEvent({
      ts: '2026-07-07T12:00:00.000Z',
      runId: 'run-proof-stale-authority',
      trajectoryId: 'run:attempt-proof-stale-authority',
    });

    expect(recordDispatchProduction(committed)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(recordDispatchProduction(stale)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(existsSync(join(dispatchProductionDir(), '2026-07-07.jsonl'))).toBe(false);
    expect(resolveDispatchProductionAttemptProofs([proofTarget(committed)])[0]).toMatchObject({
      status: 'proven',
      proof: { attemptHash: generatedRepairLifecycleAttemptHash(committed.trajectoryId!) },
    });
  });

  it('fails closed when an attempt authority window spans more than thirty-two days', () => {
    const event = makeProofEvent();
    expect(resolveDispatchProductionAttemptProofs([proofTarget(event, {
      sequenceStartTs: '2026-06-01T12:00:00.000Z',
      sequenceEndTs: event.ts,
    })])).toEqual([{ status: 'degraded', reason: 'date-limit' }]);
  });

  it('proves an old complete sequence from a physical attempt receipt without scanning global partitions', () => {
    useWindowsSemanticPrivateStorageFixture();
    const first = makeProofEvent({
      ts: '2025-01-01T12:00:00.000Z',
      runId: 'run-old-receipt-first',
      trajectoryId: 'run:attempt-old-receipt-first',
    });
    const second = makeProofEvent({
      ts: '2025-01-01T12:01:00.000Z',
      runId: 'run-old-receipt-second',
      trajectoryId: 'run:attempt-old-receipt-second',
      backend: 'codex',
      model: 'gpt-5.5',
      routeSnapshot: {
        backend: 'codex',
        tier: 'mid',
        model: 'gpt-5.5',
        assignedBy: 'daemon',
        reason: 'generated repair proof route',
        routerPolicyVersion: 'fleet-router-v1',
      },
      repairAttemptOrdinal: 2,
      repairPreviousBackend: 'local-coder',
    });
    expect(recordDispatchProduction([first, second])).toEqual({ attempted: 2, recorded: 2, failed: 0 });
    for (let index = 0; index < 40; index++) {
      const date = new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10);
      writeFileSync(join(dispatchProductionDir(), `${date}.jsonl`), 'malformed\n', 'utf8');
    }

    const resolutions = resolveDispatchProductionAttemptProofs([
      proofTarget(first, {
        sequenceStartTs: '2024-01-01T00:00:00.000Z',
        sequenceEndTs: second.ts,
      }),
      proofTarget(second, {
        sequenceStartTs: '2024-01-01T00:00:00.000Z',
        sequenceEndTs: second.ts,
      }),
    ]);

    expect(resolutions).toEqual([
      { status: 'proven', proof: expect.objectContaining({ repairAttemptOrdinal: 1 }) },
      { status: 'proven', proof: expect.objectContaining({ repairAttemptOrdinal: 2 }) },
    ]);

    const witnessed = resolveDispatchProductionAttemptReceiptWitnesses([
      { repairGenerationId: first.repairGenerationId!, repairAttemptOrdinal: 2 },
      { repairGenerationId: first.repairGenerationId!, repairAttemptOrdinal: 1 },
    ]);
    expect(witnessed).toEqual({
      status: 'resolved',
      resolutions: [
        {
          status: 'proven',
          proof: expect.objectContaining({ repairAttemptOrdinal: 2 }),
          event: expect.objectContaining({ trajectoryId: second.trajectoryId }),
        },
        {
          status: 'proven',
          proof: expect.objectContaining({ repairAttemptOrdinal: 1 }),
          event: expect.objectContaining({ trajectoryId: first.trajectoryId }),
        },
      ],
    });
    if (witnessed.status === 'resolved' && witnessed.resolutions[0]?.status === 'proven') {
      witnessed.resolutions[0].event.itemId = 'caller-mutated';
    }
    expect(resolveDispatchProductionAttemptReceiptWitnesses([
      { repairGenerationId: first.repairGenerationId!, repairAttemptOrdinal: 2 },
    ])).toMatchObject({
      status: 'resolved',
      resolutions: [{ status: 'proven', event: { itemId: second.itemId } }],
    });
  });

  it('does not use the receipt fast path for an incomplete old sequence', () => {
    const first = makeProofEvent({
      ts: '2025-01-01T12:00:00.000Z',
      runId: 'run-incomplete-receipt-first',
      trajectoryId: 'run:attempt-incomplete-receipt-first',
    });
    const second = makeProofEvent({
      ts: '2025-01-01T12:01:00.000Z',
      runId: 'run-incomplete-receipt-second',
      trajectoryId: 'run:attempt-incomplete-receipt-second',
      backend: 'codex',
      model: 'gpt-5.5',
      routeSnapshot: {
        backend: 'codex',
        tier: 'mid',
        model: 'gpt-5.5',
        assignedBy: 'daemon',
        reason: 'generated repair proof route',
        routerPolicyVersion: 'fleet-router-v1',
      },
      repairAttemptOrdinal: 2,
      repairPreviousBackend: 'local-coder',
    });
    expect(recordDispatchProduction([first, second])).toEqual({ attempted: 2, recorded: 2, failed: 0 });
    rmSync(join(
      dispatchProductionDir(),
      'repair-attempt-proofs',
      `${first.repairGenerationId}-1.json`,
    ));

    expect(resolveDispatchProductionAttemptReceiptWitnesses([
      { repairGenerationId: first.repairGenerationId!, repairAttemptOrdinal: 2 },
    ])).toEqual({
      status: 'resolved',
      resolutions: [{ status: 'unproven', reason: 'attempt-sequence-missing' }],
    });

    expect(resolveDispatchProductionAttemptProofs([
      proofTarget(second, {
        sequenceStartTs: '2024-01-01T00:00:00.000Z',
        sequenceEndTs: second.ts,
      }),
    ])).toEqual([{ status: 'degraded', reason: 'date-limit' }]);
  });

  it('rejects a canonical receipt stored under a conflicting generation identity', () => {
    const event = makeProofEvent();
    expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    const conflicting = makeProofEvent({
      repairHandoffId: 'd'.repeat(64),
      repairGenerationId: repairGenerationIdFromHandoffId('d'.repeat(64))!,
      runId: 'run-conflicting-receipt-identity',
      trajectoryId: 'run:attempt-conflicting-receipt-identity',
    });
    const canonical = sanitizeDispatchProductionEvent(conflicting, { materializeLearningLabel: true });
    writeFileSync(
      join(
        dispatchProductionDir(),
        'repair-attempt-proofs',
        `${event.repairGenerationId}-1.json`,
      ),
      `${JSON.stringify(canonical)}\n`,
      'utf8',
    );

    expect(resolveDispatchProductionAttemptProofs([proofTarget(event)])).toEqual([
      { status: 'degraded', reason: 'partition-conflict' },
    ]);
    expect(resolveDispatchProductionAttemptReceiptWitnesses([
      { repairGenerationId: event.repairGenerationId!, repairAttemptOrdinal: 1 },
    ])).toEqual({
      status: 'resolved',
      resolutions: [{ status: 'degraded', reason: 'partition-conflict' }],
    });
  });

  it('bounds and validates exact receipt-witness lookup targets before reading storage', () => {
    expect(resolveDispatchProductionAttemptReceiptWitnesses([
      { repairGenerationId: 'not-a-generation', repairAttemptOrdinal: 1 },
      { repairGenerationId: 'e'.repeat(64), repairAttemptOrdinal: 2 },
      {
        repairGenerationId: 'f'.repeat(64),
        repairAttemptOrdinal: 1,
        extra: 'not accepted',
      } as never,
    ])).toEqual({
      status: 'resolved',
      resolutions: [
        { status: 'degraded', reason: 'target-invalid' },
        { status: 'missing', reason: 'receipt-missing' },
        { status: 'degraded', reason: 'target-invalid' },
      ],
    });

    expect(resolveDispatchProductionAttemptReceiptWitnesses(
      Array.from({ length: 257 }, () => ({
        repairGenerationId: 'e'.repeat(64),
        repairAttemptOrdinal: 1 as const,
      })),
    )).toEqual({ status: 'degraded', reason: 'target-limit' });
  });

  it.skipIf(process.platform === 'win32')(
    'shares one cached partition budget across an aligned receipt-witness batch',
    () => {
      const events = Array.from({ length: 34 }, (_, index) => {
        const handoffId = (90_000 + index).toString(16).padStart(64, '0');
        const dayOffset = index === 0 ? 0 : index - 1;
        return sanitizeDispatchProductionEvent(makeProofEvent({
          ts: new Date(Date.UTC(2025, 0, 1 + dayOffset, 12, 0, index)).toISOString(),
          repairHandoffId: handoffId,
          repairGenerationId: repairGenerationIdFromHandoffId(handoffId)!,
          runId: `run-batch-budget-${index}`,
          trajectoryId: `run:attempt-batch-budget-${index}`,
        }), { materializeLearningLabel: true });
      });
      writeTestAttemptReceiptProtocolActivation(events.map((event) => ({
        generationId: event.repairGenerationId!, admittedAt: event.ts,
      })));
      const receiptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
      const byDate = new Map<string, DispatchProductionEvent[]>();
      for (const event of events) {
        writeFileSync(join(receiptDir, `${event.repairGenerationId}-1.json`),
          validatedAttemptReceiptText(event), 'utf8');
        const date = event.ts.slice(0, 10);
        byDate.set(date, [...(byDate.get(date) ?? []), event]);
      }
      for (const [date, datedEvents] of byDate) {
        writeFileSync(join(dispatchProductionDir(), `${date}.jsonl`),
          `${datedEvents.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
      }

      const witnessed = resolveDispatchProductionAttemptReceiptWitnesses(events.map((event) => ({
        repairGenerationId: event.repairGenerationId!, repairAttemptOrdinal: 1 as const,
      })));
      expect(witnessed.status).toBe('resolved');
      if (witnessed.status !== 'resolved') return;
      expect(witnessed.resolutions.slice(0, 2)).toEqual([
        { status: 'degraded', reason: 'date-limit' },
        { status: 'degraded', reason: 'date-limit' },
      ]);
      for (let index = 2; index < 34; index++) {
        expect(witnessed.resolutions[index]).toMatchObject({
          status: 'proven', event: { repairGenerationId: events[index]!.repairGenerationId },
        });
      }
    },
  );

  it('keeps missing receipt and partition reads observational', () => {
    const event = makeProofEvent();
    expect(existsSync(dispatchProductionDir())).toBe(false);

    expect(resolveDispatchProductionAttemptReceiptWitnesses([{
      repairGenerationId: event.repairGenerationId!,
      repairAttemptOrdinal: 1,
    }])).toEqual({
      status: 'resolved',
      resolutions: [{ status: 'missing', reason: 'receipt-missing' }],
    });
    expect(resolveDispatchProductionAttemptProofs([proofTarget(event)])).toEqual([
      { status: 'missing', reason: 'partition-missing' },
    ]);
    expect(existsSync(dispatchProductionDir())).toBe(false);
  });

  it('fails closed at receipt-directory capacity without dropping committed authority', () => {
    const committed = makeProofEvent({
      runId: 'run-capacity-committed',
      trajectoryId: 'run:attempt-capacity-committed',
    });
    expect(recordDispatchProduction(committed)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    const receiptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
    for (let index = 0; index < 2_065; index++) {
      writeFileSync(join(receiptDir, `capacity-noise-${index}.tmp`), 'bounded\n', 'utf8');
    }
    const nextHandoffId = 'd'.repeat(64);
    const next = makeProofEvent({
      repairHandoffId: nextHandoffId,
      repairGenerationId: repairGenerationIdFromHandoffId(nextHandoffId)!,
      runId: 'run-capacity-rejected',
      trajectoryId: 'run:attempt-capacity-rejected',
    });

    expect(recordDispatchProduction(next)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(readFileSync(join(dispatchProductionDir(), '2026-07-08.jsonl'), 'utf8')).not.toContain(
      next.trajectoryId!,
    );
    expect(resolveDispatchProductionAttemptReceiptWitnesses([
      { repairGenerationId: committed.repairGenerationId!, repairAttemptOrdinal: 1 },
      { repairGenerationId: next.repairGenerationId!, repairAttemptOrdinal: 1 },
    ])).toMatchObject({
      status: 'resolved',
      resolutions: [
        { status: 'proven' },
        { status: 'missing', reason: 'receipt-missing' },
      ],
    });
  });

  it.skipIf(process.platform !== 'win32')('establishes exact private DACLs for attempt authority writes', () => {
    establishNativePrivateStorageFixtureRoot();
    const realCallsBefore = privateStorageHarness.realCalls;
    const committed = makeProofEvent({
      runId: 'run-windows-private-receipt',
      trajectoryId: 'run:attempt-windows-private-receipt',
    });
    expect(recordDispatchProduction(committed)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    const receiptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
    const protocolPath = join(receiptDir, '.protocol.json');
    const receiptPath = join(receiptDir, `${committed.repairGenerationId}-1.json`);
    expect(assurePrivateStoragePath(
      receiptDir, 'directory', 'inspect-existing', { anchorPath: dispatchProductionDir() },
    ).ok).toBe(true);
    expect(assurePrivateStoragePath(
      protocolPath, 'file', 'inspect-existing', { anchorPath: dispatchProductionDir() },
    ).ok).toBe(true);
    expect(assurePrivateStoragePath(
      receiptPath, 'file', 'inspect-existing', { anchorPath: dispatchProductionDir() },
    ).ok).toBe(true);

    const pending = makeProofEvent({
      repairHandoffId: committed.repairHandoffId,
      repairGenerationId: committed.repairGenerationId,
      runId: 'run-windows-private-intent',
      trajectoryId: 'run:attempt-windows-private-intent',
      backend: 'codex',
      model: undefined,
      routeSnapshot: {
        backend: 'codex',
        tier: 'mid',
        assignedBy: 'daemon',
        reason: 'generated repair proof route',
        routerPolicyVersion: 'fleet-router-v1',
      },
      repairAttemptOrdinal: 2,
      repairPreviousBackend: 'local-coder',
    });
    const expectedIntentPath = join(
      receiptDir,
      `${pending.repairGenerationId}-2.intent.json`,
    );
    useWindowsSelectiveNativePrivateStorageFixture(expectedIntentPath);
    const intentNativeCallsBefore = privateStorageHarness.realInvocations.length;
    let assuredIntentPath: string | undefined;
    let intentExistedWhenAssured = false;
    _setDispatchProductionLedgerRetentionHooksForTest({
      afterAttemptReceiptIntentAssured: (path) => {
        assuredIntentPath = path;
        intentExistedWhenAssured = existsSync(path);
        throw new Error('M342 injected crash after durable attempt intent');
      },
    });
    try {
      expect(recordDispatchProduction(pending)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    } finally {
      _setDispatchProductionLedgerRetentionHooksForTest(undefined);
    }
    useNativePrivateStorageFixture();
    expectSelectiveNativeFileRewrite(expectedIntentPath, intentNativeCallsBefore);
    expect(assuredIntentPath).toBe(expectedIntentPath);
    expect(intentExistedWhenAssured).toBe(true);
    expect(existsSync(expectedIntentPath)).toBe(true);
    expect(readFileSync(expectedIntentPath, 'utf8')).toContain(pending.trajectoryId!);

    rmSync(dispatchProductionDir(), { recursive: true, force: true });
    const retiringHandoffId = 'e'.repeat(64);
    const retiring = makeProofEvent({
      ts: '2025-01-01T00:00:00.000Z',
      repairHandoffId: retiringHandoffId,
      repairGenerationId: repairGenerationIdFromHandoffId(retiringHandoffId)!,
      runId: 'run-windows-retention-recovery',
      trajectoryId: 'run:attempt-windows-retention-recovery',
    });
    writeTestAttemptReceiptProtocolActivation([{
      generationId: retiring.repairGenerationId!, admittedAt: retiring.ts,
    }]);
    const recoveryReceiptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
    const retentionPath = join(recoveryReceiptDir, '.retention.json');
    writeFileSync(retentionPath, `${JSON.stringify({
      schemaVersion: 5,
      droppedThrough: retiring.ts,
      retirementEpoch: 1,
      pendingGenerations: [retiring.repairGenerationId],
      pendingArtifacts: [],
    })}\n`, 'utf8');
    expect(assurePrivateStoragePath(
      retentionPath, 'file', 'secure-created', { anchorPath: dispatchProductionDir() },
    ).ok).toBe(true);
    useWindowsSelectiveNativePrivateStorageFixture(retentionPath);
    const retentionNativeCallsBefore = privateStorageHarness.realInvocations.length;

    const recoveryHandoffId = 'f'.repeat(63) + 'a';
    const recoveryTrigger = makeProofEvent({
      repairHandoffId: recoveryHandoffId,
      repairGenerationId: repairGenerationIdFromHandoffId(recoveryHandoffId)!,
      runId: 'run-windows-retention-recovery-trigger',
      trajectoryId: 'run:attempt-windows-retention-recovery-trigger',
    });
    expect(recordDispatchProduction(recoveryTrigger)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    useNativePrivateStorageFixture();
    expectSelectiveNativeFileRewrite(retentionPath, retentionNativeCallsBefore);
    expect(existsSync(retentionPath)).toBe(true);
    expect(JSON.parse(readFileSync(retentionPath, 'utf8'))).toMatchObject({
      schemaVersion: 5,
      retirementEpoch: 1,
      pendingGenerations: [],
      pendingArtifacts: [],
    });
    expect(assurePrivateStoragePath(
      retentionPath, 'file', 'inspect-existing', { anchorPath: dispatchProductionDir() },
    ).ok).toBe(true);
    expect(privateStorageHarness.realCalls).toBeGreaterThan(realCallsBefore);
  }, 90_000);

  it('recovers bounded portable crash stages, including a reused legacy PID name', () => {
    const committed = makeProofEvent({
      runId: 'run-stage-committed',
      trajectoryId: 'run:attempt-stage-committed',
    });
    expect(recordDispatchProduction(committed)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    const receiptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
    const nextHandoffId = 'd'.repeat(64);
    const next = makeProofEvent({
      repairHandoffId: nextHandoffId,
      repairGenerationId: repairGenerationIdFromHandoffId(nextHandoffId)!,
      runId: 'run-stage-retry',
      trajectoryId: 'run:attempt-stage-retry',
    });
    const base = `${next.repairGenerationId}-1.json`;
    writeFileSync(join(receiptDir, `${base}.${process.pid}.tmp`), 'legacy crash stage\n', 'utf8');
    for (let index = 0; index < 15; index++) {
      writeFileSync(
        join(receiptDir, `${base}.${index.toString(16).padStart(32, '0')}.stage`),
        'nonce crash stage\n',
        'utf8',
      );
    }

    expect(recordDispatchProduction(next)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(readdirSync(receiptDir).filter((name) => name.endsWith('.stage') || name.endsWith('.tmp'))).toEqual([]);
    expect(resolveDispatchProductionAttemptReceiptWitnesses([{
      repairGenerationId: next.repairGenerationId!, repairAttemptOrdinal: 1,
    }])).toMatchObject({ status: 'resolved', resolutions: [{ status: 'proven' }] });
  });

  it('fails closed when recognized hard-crash stages exceed the cleanup bound', () => {
    const committed = makeProofEvent({
      runId: 'run-stage-saturation-committed',
      trajectoryId: 'run:attempt-stage-saturation-committed',
    });
    expect(recordDispatchProduction(committed)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    const receiptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
    const nextHandoffId = 'e'.repeat(64);
    const next = makeProofEvent({
      repairHandoffId: nextHandoffId,
      repairGenerationId: repairGenerationIdFromHandoffId(nextHandoffId)!,
      runId: 'run-stage-saturation-rejected',
      trajectoryId: 'run:attempt-stage-saturation-rejected',
    });
    const base = `${next.repairGenerationId}-1.json`;
    for (let index = 0; index < 17; index++) {
      writeFileSync(
        join(receiptDir, `${base}.${index.toString(16).padStart(32, '0')}.stage`),
        'saturated crash stage\n',
        'utf8',
      );
    }

    expect(recordDispatchProduction(next)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(readFileSync(join(dispatchProductionDir(), '2026-07-08.jsonl'), 'utf8')).not.toContain(
      next.trajectoryId!,
    );
    expect(readdirSync(receiptDir).filter((name) => name.endsWith('.stage'))).toHaveLength(17);
  });

  it('retires whole old generations at capacity and never re-promotes dropped proof', () => {
    const receiptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
    let oldest: DispatchProductionEvent | undefined;
    let retired: DispatchProductionEvent | undefined;
    const baseMs = Date.parse('2025-01-01T00:00:00.000Z');
    const seeded: DispatchProductionEvent[] = [];
    for (let index = 1; index <= 2_048; index++) {
      const handoffId = index.toString(16).padStart(64, '0');
      const event = makeProofEvent({
        ts: new Date(baseMs + index * 1_000).toISOString(),
        repairHandoffId: handoffId,
        repairGenerationId: repairGenerationIdFromHandoffId(handoffId)!,
        runId: `run-retention-${index}`,
        trajectoryId: `run:attempt-retention-${index}`,
      });
      oldest ??= event;
      if (index === 2) retired = event;
      seeded.push(sanitizeDispatchProductionEvent(event, { materializeLearningLabel: true }));
    }
    writeTestAttemptReceiptProtocolActivation(seeded.map((event) => ({
      generationId: event.repairGenerationId!,
      admittedAt: event.ts,
    })));
    for (const canonical of seeded) {
      writeFileSync(
        join(receiptDir, `${canonical.repairGenerationId}-1.json`),
        validatedAttemptReceiptText(canonical),
        'utf8',
      );
      appendCanonicalDispatchEvent(canonical);
    }
    const next = makeProofEvent({
      ts: '2026-07-08T12:01:00.000Z',
      repairHandoffId: oldest!.repairHandoffId,
      repairGenerationId: oldest!.repairGenerationId,
      repairTreatmentUnitId: oldest!.repairTreatmentUnitId,
      repairTreatment: oldest!.repairTreatment,
      repairAttemptOrdinal: 2,
      repairPreviousBackend: 'local-coder',
      backend: 'codex',
      model: 'gpt-5.5',
      routeSnapshot: {
        backend: 'codex',
        tier: 'mid',
        model: 'gpt-5.5',
        assignedBy: 'daemon',
        reason: 'generated repair proof route',
        routerPolicyVersion: 'fleet-router-v1',
      },
      runId: 'run-retention-next',
      trajectoryId: 'run:attempt-retention-next',
    });

    expect(recordDispatchProduction(next)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(readdirSync(receiptDir).filter((name) => /^[a-f0-9]{64}-[12]\.json$/.test(name))).toHaveLength(2_048);
    expect(existsSync(join(receiptDir, '.retention.json'))).toBe(true);
    expect(resolveDispatchProductionAttemptReceiptWitnesses([
      { repairGenerationId: oldest!.repairGenerationId!, repairAttemptOrdinal: 1 },
      { repairGenerationId: retired!.repairGenerationId!, repairAttemptOrdinal: 1 },
      { repairGenerationId: next.repairGenerationId!, repairAttemptOrdinal: 1 },
      { repairGenerationId: next.repairGenerationId!, repairAttemptOrdinal: 2 },
    ])).toMatchObject({
      status: 'resolved',
      resolutions: [
        { status: 'proven' },
        { status: 'degraded', reason: 'source-unavailable' },
        { status: 'proven' },
        { status: 'proven' },
      ],
    });
    expect(resolveDispatchProductionAttemptProofs([proofTarget(retired!)])).toEqual([
      { status: 'degraded', reason: 'source-unavailable' },
    ]);
    const retiredCrashPath = join(receiptDir, `${retired!.repairGenerationId}-1.json`);
    writeFileSync(
      retiredCrashPath,
      validatedAttemptReceiptText(sanitizeDispatchProductionEvent(
        retired!, { materializeLearningLabel: true },
      )),
      'utf8',
    );
    const retentionPath = join(receiptDir, '.retention.json');
    const interruptedRetention = JSON.parse(readFileSync(retentionPath, 'utf8')) as {
      schemaVersion: number;
      droppedThrough: string;
      pendingGenerations: string[];
    };
    interruptedRetention.pendingGenerations = [retired!.repairGenerationId!];
    writeFileSync(retentionPath, `${JSON.stringify(interruptedRetention)}\n`, 'utf8');
    expect(recordDispatchProduction(next)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(existsSync(retiredCrashPath)).toBe(false);
    expect(JSON.parse(readFileSync(retentionPath, 'utf8'))).toMatchObject({
      schemaVersion: 5,
      retirementEpoch: 1,
      pendingGenerations: [],
      pendingArtifacts: [],
    });
    const retiredReplay = makeProofEvent({
      ts: '2026-07-08T12:02:00.000Z',
      repairHandoffId: retired!.repairHandoffId,
      repairGenerationId: retired!.repairGenerationId,
      repairTreatmentUnitId: retired!.repairTreatmentUnitId,
      repairTreatment: retired!.repairTreatment,
      runId: 'run-retired-newer-replay',
      trajectoryId: 'run:attempt-retired-newer-replay',
    });
    expect(recordDispatchProduction(retiredReplay)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    const retiredCanonical = sanitizeDispatchProductionEvent(retiredReplay, { materializeLearningLabel: true });
    writeFileSync(
      join(receiptDir, `${retiredCanonical.repairGenerationId}-1.json`),
      validatedAttemptReceiptText(retiredCanonical),
      'utf8',
    );
    expect(recordDispatchProduction(retiredReplay)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(resolveDispatchProductionAttemptReceiptWitnesses([{
      repairGenerationId: retired!.repairGenerationId!, repairAttemptOrdinal: 1,
    }])).toEqual({
      status: 'resolved',
      resolutions: [{ status: 'degraded', reason: 'source-unavailable' }],
    });
    rmSync(join(receiptDir, `${retired!.repairGenerationId}-1.json`));
    const retiredCanonicalText = validatedAttemptReceiptText(sanitizeDispatchProductionEvent(
      retired!, { materializeLearningLabel: true },
    ));
    writeFileSync(retentionPath, `${JSON.stringify({
      schemaVersion: 4,
      droppedThrough: retired!.ts,
      retirementEpoch: 1,
      pendingGenerations: [retired!.repairGenerationId],
      pendingArtifacts: [{
        name: `${retired!.repairGenerationId}-1.json`,
        generationId: retired!.repairGenerationId,
        ordinal: 1,
        kind: 'receipt',
        eventTs: retired!.ts,
        eventDigest: createHash('sha256').update(JSON.stringify(sanitizeDispatchProductionEvent(
          retired!, { materializeLearningLabel: true },
        )), 'utf8').digest('hex'),
        fileDigest: createHash('sha256').update(retiredCanonicalText, 'utf8').digest('hex'),
      }],
    })}\n`, 'utf8');
    expect(recordDispatchProduction(next)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(JSON.parse(readFileSync(retentionPath, 'utf8'))).toMatchObject({
      schemaVersion: 5,
      retirementEpoch: 1,
      pendingGenerations: [],
      pendingArtifacts: [],
    });
    const freshHandoffId = 'f'.repeat(64);
    const fresh = makeProofEvent({
      ts: '2026-07-08T12:03:00.000Z',
      repairHandoffId: freshHandoffId,
      repairGenerationId: repairGenerationIdFromHandoffId(freshHandoffId)!,
      runId: 'run-generation-history-capacity',
      trajectoryId: 'run:attempt-generation-history-capacity',
    });
    expect(recordDispatchProduction(fresh)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
  }, 15_000);

  it('sustains failure-only receipt churn at the shared 2,048-artifact capacity', () => {
    const receiptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
    const baseMs = Date.parse('2025-01-01T00:00:00.000Z');
    const seeded = Array.from({ length: 2_048 }, (_, index) => {
      const handoffId = (80_000 + index).toString(16).padStart(64, '0');
      return sanitizeDispatchProductionEvent(makeGeneratedRepairFailureEvent(
        index % 2 === 0 ? 'capture' : 'proposal', {
        ts: new Date(baseMs + index * 1_000).toISOString(),
        repairHandoffId: handoffId,
        repairGenerationId: repairGenerationIdFromHandoffId(handoffId)!,
        runId: `attempt-failure-churn-${index}`,
        trajectoryId: `run:attempt-failure-churn-${index}`,
        }), { materializeLearningLabel: true });
    });
    writeTestAttemptReceiptProtocolActivation(seeded.map((event) => ({
      generationId: event.repairGenerationId!, admittedAt: event.ts,
    })));
    for (const event of seeded) {
      writeFileSync(
        join(receiptDir, failureAttemptReceiptName(event)),
        validatedAttemptReceiptText(event),
        'utf8',
      );
    }
    writeFileSync(
      join(dispatchProductionDir(), '2025-01-01.jsonl'),
      `${seeded.map((event) => JSON.stringify(event)).join('\n')}\n`,
      'utf8',
    );
    protectWindowsFixtureTree(receiptDir);
    const discovered = readDispatchProductionFailureAttemptReceipts(
      seeded.map((event) => event.repairGenerationId!),
    );
    expect(discovered).toMatchObject({ status: 'resolved', authoritative: true });
    if (discovered.status === 'resolved') {
      expect(discovered.receipts).toHaveLength(2_048);
      expect(new Set(discovered.receipts.map((receipt) =>
        receipt.proof.repairGenerationId)).size).toBe(2_048);
    }

    const fresh: DispatchProductionEvent[] = [];
    for (let index = 0; index < 4; index++) {
      const handoffId = (90_000 + index).toString(16).padStart(64, '0');
      const event = makeGeneratedRepairFailureEvent(index % 2 === 0 ? 'capture' : 'proposal', {
        ts: new Date(Date.parse('2026-07-08T13:00:00.000Z') + index * 1_000).toISOString(),
        repairHandoffId: handoffId,
        repairGenerationId: repairGenerationIdFromHandoffId(handoffId)!,
        runId: `attempt-failure-churn-fresh-${index}`,
        trajectoryId: `run:attempt-failure-churn-fresh-${index}`,
      });
      expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
      fresh.push(event);
    }

    const failureNames = readdirSync(receiptDir).filter((name) =>
      /^[a-f0-9]{64}-[12]-[a-f0-9]{64}\.failure\.json$/.test(name));
    expect(failureNames).toHaveLength(2_048);
    expect(existsSync(join(receiptDir, failureAttemptReceiptName(seeded[0]!)))).toBe(false);
    expect(JSON.parse(readFileSync(join(receiptDir, '.retention.json'), 'utf8'))).toMatchObject({
      schemaVersion: 5,
      retirementEpoch: 4,
      pendingGenerations: [],
      pendingArtifacts: [],
    });
    expect(resolveDispatchProductionFailureAttemptReceipt({
      repairGenerationId: seeded[0]!.repairGenerationId!,
      repairAttemptOrdinal: 1,
      attemptHash: generatedRepairLifecycleAttemptHash(seeded[0]!.trajectoryId!),
    })).toEqual({ status: 'degraded', reason: 'source-unavailable' });
    expect(readDispatchProductionFailureAttemptReceipts([
      seeded[0]!.repairGenerationId!,
    ])).toEqual({ status: 'degraded', reason: 'source-unavailable' });
    expect(resolveDispatchProductionFailureAttemptReceipt({
      repairGenerationId: fresh.at(-1)!.repairGenerationId!,
      repairAttemptOrdinal: 1,
      attemptHash: generatedRepairLifecycleAttemptHash(fresh.at(-1)!.trajectoryId!),
    })).toMatchObject({ status: 'proven', event: { outcome: 'engine-failed' } });
  }, 30_000);

  it('bounds and crash-recovers 2,048 same-generation failures with batched assurance', () => {
    useWindowsSemanticPrivateStorageFixture();
    const receiptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
    const handoffId = '8'.repeat(64);
    const generationId = repairGenerationIdFromHandoffId(handoffId)!;
    const baseMs = Date.parse('2025-01-01T00:00:00.000Z');
    const seeded = Array.from({ length: 2_048 }, (_, index) =>
      sanitizeDispatchProductionEvent(makeGeneratedRepairFailureEvent(
        index % 2 === 0 ? 'capture' : 'proposal', {
          ts: new Date(baseMs + index * 1_000).toISOString(),
          repairHandoffId: handoffId,
          repairGenerationId: generationId,
          runId: `attempt-same-generation-failure-${index}`,
          trajectoryId: `run:attempt-same-generation-failure-${index}`,
        }), { materializeLearningLabel: true }));
    writeTestAttemptReceiptProtocolActivation([{
      generationId,
      admittedAt: seeded[0]!.ts,
    }]);
    for (const event of seeded) {
      writeFileSync(
        join(receiptDir, failureAttemptReceiptName(event)),
        validatedAttemptReceiptText(event),
        'utf8',
      );
    }
    writeFileSync(
      join(dispatchProductionDir(), '2025-01-01.jsonl'),
      `${seeded.map((event) => JSON.stringify(event)).join('\n')}\n`,
      'utf8',
    );
    protectWindowsFixtureTree(receiptDir);
    const discovered = readDispatchProductionFailureAttemptReceipts([generationId]);
    expect(discovered).toMatchObject({ status: 'resolved', authoritative: true });
    if (discovered.status === 'resolved') {
      expect(discovered.receipts).toHaveLength(2_048);
      expect(new Set(discovered.receipts.map((receipt) =>
        receipt.proof.attemptHash)).size).toBe(2_048);
    }

    const triggerHandoffId = '7'.repeat(64);
    const trigger = makeGeneratedRepairFailureEvent('proposal', {
      repairHandoffId: triggerHandoffId,
      repairGenerationId: repairGenerationIdFromHandoffId(triggerHandoffId)!,
      runId: 'attempt-same-generation-retention-trigger',
      trajectoryId: 'run:attempt-same-generation-retention-trigger',
    });
    let batchCalls = 0;
    let injectedCrash = false;
    _setDispatchProductionLedgerRetentionHooksForTest({
      assureStableRegularFiles: (paths, anchorPath) => {
        batchCalls++;
        return assureStableRegularFiles(paths, anchorPath);
      },
      afterAttemptRetentionMarker: () => {
        if (!injectedCrash) {
          injectedCrash = true;
          throw new Error('injected retention marker crash');
        }
      },
    });

    expect(recordDispatchProduction(trigger)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    const markerPath = join(receiptDir, '.retention.json');
    const markerText = readFileSync(markerPath, 'utf8');
    expect(Buffer.byteLength(markerText)).toBeLessThanOrEqual(256 * 1024);
    const pendingMarker = JSON.parse(markerText) as {
      schemaVersion: number;
      pendingGenerations: string[];
      pendingArtifacts: { count: number; digests: string[] };
    };
    expect(pendingMarker).toMatchObject({
      schemaVersion: 6,
      pendingGenerations: [generationId],
      pendingArtifacts: { count: 2_048 },
    });
    expect(pendingMarker.pendingArtifacts.digests).toHaveLength(2_048);
    expect(pendingMarker.pendingArtifacts.digests.every((digest) =>
      /^[a-f0-9]{64}$/.test(digest))).toBe(true);
    expect(batchCalls).toBe(4);
    expect(readdirSync(receiptDir).filter((name) =>
      name.endsWith('.failure.json'))).toHaveLength(2_048);

    batchCalls = 0;
    _setDispatchProductionLedgerRetentionHooksForTest({
      assureStableRegularFiles: () => {
        batchCalls++;
        return { ok: false, reason: 'unsafe-file' };
      },
    });
    expect(recordDispatchProduction(trigger)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(batchCalls).toBe(1);
    expect(readdirSync(receiptDir).filter((name) =>
      name.endsWith('.failure.json'))).toHaveLength(2_048);

    rmSync(join(receiptDir, failureAttemptReceiptName(seeded[0]!)));
    expect(readdirSync(receiptDir).filter((name) =>
      name.endsWith('.failure.json'))).toHaveLength(2_047);

    batchCalls = 0;
    _setDispatchProductionLedgerRetentionHooksForTest({
      assureStableRegularFiles: (paths, anchorPath) => {
        batchCalls++;
        return assureStableRegularFiles(paths, anchorPath);
      },
    });
    expect(recordDispatchProduction(trigger)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(batchCalls).toBe(8);
    expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toMatchObject({
      schemaVersion: 5,
      pendingGenerations: [],
      pendingArtifacts: [],
    });
    expect(readdirSync(receiptDir).filter((name) =>
      name.includes(generationId) && name.endsWith('.failure.json'))).toHaveLength(0);
    expect(existsSync(join(receiptDir, failureAttemptReceiptName(trigger)))).toBe(true);
  }, 60_000);

  it.each(['failure-receipt', 'failure-intent'] as const)(
    'recovers an interrupted retention manifest for an exact %s artifact',
    (kind) => {
      useWindowsSemanticPrivateStorageFixture();
      const handoffId = kind === 'failure-receipt' ? 'e'.repeat(64) : 'f'.repeat(64);
      const retired = sanitizeDispatchProductionEvent(makeGeneratedRepairFailureEvent(
        kind === 'failure-receipt' ? 'capture' : 'proposal', {
        ts: '2025-01-01T00:00:00.000Z',
        repairHandoffId: handoffId,
        repairGenerationId: repairGenerationIdFromHandoffId(handoffId)!,
        runId: `attempt-retention-crash-${kind}`,
        trajectoryId: `run:attempt-retention-crash-${kind}`,
        }), { materializeLearningLabel: true });
      writeTestAttemptReceiptProtocolActivation([{
        generationId: retired.repairGenerationId!, admittedAt: retired.ts,
      }]);
      const receiptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
      const intent = kind === 'failure-intent';
      const artifactName = failureAttemptReceiptName(retired, intent);
      const artifactText = validatedAttemptReceiptText(retired);
      const artifactPath = join(receiptDir, artifactName);
      writeFileSync(artifactPath, artifactText, 'utf8');
      if (!intent) appendCanonicalDispatchEvent(retired);
      writeFileSync(join(receiptDir, '.retention.json'), `${JSON.stringify({
        schemaVersion: 5,
        droppedThrough: retired.ts,
        retirementEpoch: 1,
        pendingGenerations: [retired.repairGenerationId],
        pendingArtifacts: [{
          name: artifactName,
          generationId: retired.repairGenerationId,
          ordinal: retired.repairAttemptOrdinal,
          kind,
          eventTs: retired.ts,
          eventDigest: createHash('sha256').update(JSON.stringify(retired), 'utf8').digest('hex'),
          fileDigest: createHash('sha256').update(artifactText, 'utf8').digest('hex'),
        }],
      })}\n`, 'utf8');
      protectWindowsFixtureTree(receiptDir);

      const triggerHandoffId = createHash('sha256').update(`retention-trigger-${kind}`).digest('hex');
      const trigger = makeGeneratedRepairFailureEvent(
        kind === 'failure-receipt' ? 'proposal' : 'capture', {
        repairHandoffId: triggerHandoffId,
        repairGenerationId: repairGenerationIdFromHandoffId(triggerHandoffId)!,
        runId: `attempt-retention-trigger-${kind}`,
        trajectoryId: `run:attempt-retention-trigger-${kind}`,
        });
      expect(recordDispatchProduction(trigger)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
      expect(existsSync(artifactPath)).toBe(false);
      expect(JSON.parse(readFileSync(join(receiptDir, '.retention.json'), 'utf8'))).toMatchObject({
        schemaVersion: 5,
        retirementEpoch: 1,
        pendingGenerations: [],
        pendingArtifacts: [],
      });
      expect(resolveDispatchProductionFailureAttemptReceipt({
        repairGenerationId: retired.repairGenerationId!,
        repairAttemptOrdinal: 1,
        attemptHash: generatedRepairLifecycleAttemptHash(retired.trajectoryId!),
      })).toEqual({ status: 'degraded', reason: 'source-unavailable' });
      expect(resolveDispatchProductionFailureAttemptReceipt({
        repairGenerationId: trigger.repairGenerationId!,
        repairAttemptOrdinal: 1,
        attemptHash: generatedRepairLifecycleAttemptHash(trigger.trajectoryId!),
      })).toMatchObject({ status: 'proven', event: { outcome: trigger.outcome } });
      expect(assurePrivateStoragePath(
        join(receiptDir, '.retention.json'),
        'file',
        'inspect-existing',
        { anchorPath: dispatchProductionDir() },
      ).ok).toBe(true);
      expect(assurePrivateStoragePath(
        join(receiptDir, failureAttemptReceiptName(trigger)),
        'file',
        'inspect-existing',
        { anchorPath: dispatchProductionDir() },
      ).ok).toBe(true);
    },
    15_000,
  );

  it('rejects a deleted retired generation after restoring the pre-retention protocol', () => {
    const receiptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
    const baseMs = Date.parse('2025-01-01T00:00:00.000Z');
    const seeded = Array.from({ length: 2_048 }, (_, index) => {
      const handoffId = (70_000 + index).toString(16).padStart(64, '0');
      return sanitizeDispatchProductionEvent(makeProofEvent({
        ts: new Date(baseMs + index * 1_000).toISOString(),
        repairHandoffId: handoffId,
        repairGenerationId: repairGenerationIdFromHandoffId(handoffId)!,
        runId: `run-retention-rollback-${index}`,
        trajectoryId: `run:attempt-retention-rollback-${index}`,
      }), { materializeLearningLabel: true });
    });
    writeTestAttemptReceiptProtocolActivation(seeded.map((event) => ({
      generationId: event.repairGenerationId!, admittedAt: event.ts,
    })));
    const protocolPath = join(receiptDir, '.protocol.json');
    const preRetentionProtocol = readFileSync(protocolPath, 'utf8');
    for (const event of seeded) {
      writeFileSync(
        join(receiptDir, `${event.repairGenerationId}-1.json`),
        validatedAttemptReceiptText(event),
        'utf8',
      );
    }
    writeFileSync(
      join(dispatchProductionDir(), '2025-01-01.jsonl'),
      `${seeded.map((event) => JSON.stringify(event)).join('\n')}\n`,
      'utf8',
    );
    const triggerHandoffId = 'f'.repeat(63) + '9';
    const trigger = makeProofEvent({
      repairHandoffId: triggerHandoffId,
      repairGenerationId: repairGenerationIdFromHandoffId(triggerHandoffId)!,
      runId: 'run-retention-rollback-trigger',
      trajectoryId: 'run:attempt-retention-rollback-trigger',
    });
    expect(recordDispatchProduction(trigger)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(existsSync(join(receiptDir, `${seeded[0]!.repairGenerationId}-1.json`))).toBe(false);
    expect(JSON.parse(readFileSync(join(receiptDir, '.retention.json'), 'utf8'))).toMatchObject({
      schemaVersion: 5,
      retirementEpoch: 1,
      pendingGenerations: [],
    });

    writeFileSync(protocolPath, preRetentionProtocol, 'utf8');
    expect(readDispatchProductionAttemptProtocolQuality()).toMatchObject({ status: 'degraded' });
    const replay = makeProofEvent({
      ts: '2026-07-08T14:00:00.000Z',
      repairHandoffId: seeded[0]!.repairHandoffId,
      repairGenerationId: seeded[0]!.repairGenerationId,
      repairTreatmentUnitId: seeded[0]!.repairTreatmentUnitId,
      repairTreatment: seeded[0]!.repairTreatment,
      runId: 'run-deleted-retired-generation-replay',
      trajectoryId: 'run:attempt-deleted-retired-generation-replay',
    });
    expect(recordDispatchProduction(replay)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(readFileSync(protocolPath, 'utf8')).toBe(preRetentionProtocol);
    expect(existsSync(join(receiptDir, `${seeded[0]!.repairGenerationId}-1.json`))).toBe(false);
  }, 20_000);

  it('sustains bounded churn with retirement history far beyond receipt capacity', () => {
    const receiptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
    const blockedHandoffIds = Array.from({ length: 8_192 }, (_, index) =>
      (index + 1).toString(16).padStart(64, '0'));
    const blockedGenerationIds = blockedHandoffIds.map((handoffId) =>
      repairGenerationIdFromHandoffId(handoffId)!);
    const active: DispatchProductionEvent[] = [];
    const baseMs = Date.parse('2025-01-01T00:00:00.000Z');
    for (let index = 0; index < 2_048; index++) {
      const handoffId = (10_000 + index).toString(16).padStart(64, '0');
      active.push(sanitizeDispatchProductionEvent(makeProofEvent({
        ts: new Date(baseMs + index * 1_000).toISOString(),
        repairHandoffId: handoffId,
        repairGenerationId: repairGenerationIdFromHandoffId(handoffId)!,
        runId: `run-churn-active-${index}`,
        trajectoryId: `run:attempt-churn-active-${index}`,
      }), { materializeLearningLabel: true }));
    }
    writeTestAttemptReceiptProtocolActivation(active.map((event) => ({
      generationId: event.repairGenerationId!, admittedAt: event.ts,
    })), blockedGenerationIds);
    for (const event of active) {
      writeFileSync(
        join(receiptDir, `${event.repairGenerationId}-1.json`),
        validatedAttemptReceiptText(event),
        'utf8',
      );
    }
    mkdirSync(dispatchProductionDir(), { recursive: true });
    writeFileSync(
      join(dispatchProductionDir(), '2025-01-01.jsonl'),
      `${active.map((event) => JSON.stringify(event)).join('\n')}\n`,
      'utf8',
    );

    for (let index = 0; index < 4; index++) {
      const handoffId = (20_000 + index).toString(16).padStart(64, '0');
      const event = makeProofEvent({
        ts: new Date(Date.parse('2026-07-08T13:00:00.000Z') + index * 1_000).toISOString(),
        repairHandoffId: handoffId,
        repairGenerationId: repairGenerationIdFromHandoffId(handoffId)!,
        runId: `run-churn-new-${index}`,
        trajectoryId: `run:attempt-churn-new-${index}`,
      });
      expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    }

    const protocol = JSON.parse(readFileSync(join(receiptDir, '.protocol.json'), 'utf8')) as {
      generations: unknown[];
      blockedGenerations: { segments: Array<{ bits: string }> };
    };
    expect(protocol.generations).toHaveLength(2_048);
    expect(Buffer.from(protocol.blockedGenerations.segments[0]!.bits, 'base64')).toHaveLength(
      TEST_BLOCKED_MEMBERSHIP_BYTES,
    );
    const blockedReplay = makeProofEvent({
      ts: '2026-07-08T14:00:00.000Z',
      repairHandoffId: blockedHandoffIds[0],
      repairGenerationId: blockedGenerationIds[0],
      runId: 'run-compacted-retirement-replay',
      trajectoryId: 'run:attempt-compacted-retirement-replay',
    });
    expect(recordDispatchProduction(blockedReplay)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
  }, 15_000);

  it('reclaims 2,049 artifactless admissions atomically without permitting replay', () => {
    const handoffIds = Array.from({ length: 2_049 }, (_, index) =>
      (30_000 + index).toString(16).padStart(64, '0'));
    const generations = handoffIds.map((handoffId, index) => ({
      generationId: repairGenerationIdFromHandoffId(handoffId)!,
      admittedAt: new Date(Date.parse('2025-01-01T00:00:00.000Z') + index * 1_000).toISOString(),
    }));
    writeTestAttemptReceiptProtocolActivation(generations);
    const freshHandoffId = 'f'.repeat(63) + 'e';
    const fresh = makeProofEvent({
      repairHandoffId: freshHandoffId,
      repairGenerationId: repairGenerationIdFromHandoffId(freshHandoffId)!,
      runId: 'run-after-artifactless-reclamation',
      trajectoryId: 'run:attempt-after-artifactless-reclamation',
    });

    expect(recordDispatchProduction(fresh)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    const protocol = JSON.parse(readFileSync(join(
      dispatchProductionDir(), 'repair-attempt-proofs', '.protocol.json',
    ), 'utf8')) as { schemaVersion: number; generations: Array<{ generationId: string }> };
    expect(protocol.schemaVersion).toBe(5);
    expect(protocol.generations).toHaveLength(2_049);
    expect(protocol.generations.some((generation) =>
      generation.generationId === generations[0]!.generationId)).toBe(false);

    const replay = makeProofEvent({
      repairHandoffId: handoffIds[0],
      repairGenerationId: generations[0]!.generationId,
      runId: 'run-reclaimed-generation-replay',
      trajectoryId: 'run:attempt-reclaimed-generation-replay',
    });
    expect(recordDispatchProduction(replay)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
  }, 10_000);

  it('migrates and rotates retirement membership without forgetting prior segments', () => {
    const nearlyFullBits = Buffer.alloc(TEST_BLOCKED_MEMBERSHIP_BYTES);
    nearlyFullBits.fill(0xff, 0, Math.floor(TEST_BLOCKED_MEMBERSHIP_BYTES / 10));
    const originalBits = Buffer.from(nearlyFullBits);
    const generations = Array.from({ length: 2_049 }, (_, index) => ({
      generationId: createHash('sha256').update(`rotation-active-${index}`).digest('hex'),
      admittedAt: new Date(Date.parse('2025-01-01T00:00:00.000Z') + index * 1_000).toISOString(),
    }));
    writeTestAttemptReceiptProtocolV4(
      generations,
      testSegmentedBlockedMembership([{ bits: nearlyFullBits, insertedCount: 15_000 }]),
    );
    const handoffId = 'f'.repeat(63) + 'd';
    const event = makeProofEvent({
      repairHandoffId: handoffId,
      repairGenerationId: repairGenerationIdFromHandoffId(handoffId)!,
      runId: 'run-membership-rotation',
      trajectoryId: 'run:attempt-membership-rotation',
    });

    expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    const protocol = JSON.parse(readFileSync(join(
      dispatchProductionDir(), 'repair-attempt-proofs', '.protocol.json',
    ), 'utf8')) as { blockedGenerations: { segments: Array<{ bits: string }> } };
    expect(protocol.blockedGenerations.segments).toHaveLength(2);
    expect(Buffer.from(protocol.blockedGenerations.segments[0]!.bits, 'base64')).toEqual(originalBits);
    expect(readDispatchProductionAttemptProtocolQuality()).toMatchObject({
      status: 'healthy',
      segmentCount: 2,
    });
  }, 10_000);

  it('marks an over-occupied legacy retirement membership saturated during migration', () => {
    writeTestAttemptReceiptProtocolActivation();
    const protocolPath = join(dispatchProductionDir(), 'repair-attempt-proofs', '.protocol.json');
    const protocol = JSON.parse(readFileSync(protocolPath, 'utf8')) as {
      blockedGenerations: { bits: string };
    };
    const overOccupied = Buffer.alloc(TEST_BLOCKED_MEMBERSHIP_BYTES);
    overOccupied.fill(0xff, 0, Math.floor(TEST_BLOCKED_MEMBERSHIP_BYTES / 5));
    protocol.blockedGenerations.bits = overOccupied.toString('base64');
    writeFileSync(protocolPath, `${JSON.stringify(protocol)}\n`, 'utf8');

    expect(readDispatchProductionAttemptProtocolQuality()).toMatchObject({
      status: 'saturated', segmentCount: 1,
    });
    expect(recordDispatchProduction(makeProofEvent({
      runId: 'run-legacy-membership-saturated',
      trajectoryId: 'run:attempt-legacy-membership-saturated',
    }))).toEqual({
      attempted: 1,
      recorded: 0,
      failed: 1,
      failureReasons: ['retirement-membership-saturated'],
    });
  });

  it('marks over-occupied raw attempt history saturated when first activating receipts', () => {
    const seed = makeProofEvent();
    const partition = join(dispatchProductionDir(), `${seed.ts.slice(0, 10)}.jsonl`);
    mkdirSync(dispatchProductionDir(), { recursive: true });
    writeFileSync(partition, '', 'utf8');
    let chunk: string[] = [];
    for (let index = 0; index < 17_000; index++) {
      const repairHandoffId = createHash('sha256').update(`raw-migration-${index}`).digest('hex');
      const runId = `run-raw-migration-${index}`;
      const event = sanitizeDispatchProductionEvent({
        ...seed,
        runId,
        trajectoryId: `run:attempt-raw-migration-${index}`,
        repairHandoffId,
        repairGenerationId: repairGenerationIdFromHandoffId(repairHandoffId)!,
        runEventSummary: { ...seed.runEventSummary!, runId },
      }, { materializeLearningLabel: true });
      chunk.push(`${JSON.stringify(event)}\n`);
      if (chunk.length === 500) {
        appendFileSync(partition, chunk.join(''), 'utf8');
        chunk = [];
      }
    }
    if (chunk.length > 0) appendFileSync(partition, chunk.join(''), 'utf8');

    const nextHandoffId = createHash('sha256').update('raw-migration-next').digest('hex');
    expect(recordDispatchProduction(makeProofEvent({
      runId: 'run-after-raw-migration-saturation',
      trajectoryId: 'run:attempt-after-raw-migration-saturation',
      repairHandoffId: nextHandoffId,
      repairGenerationId: repairGenerationIdFromHandoffId(nextHandoffId)!,
    }))).toEqual({
      attempted: 1,
      recorded: 0,
      failed: 1,
      failureReasons: ['retirement-membership-saturated'],
    });
    expect(readDispatchProductionAttemptProtocolQuality()).toMatchObject({
      status: 'saturated', segmentCount: 1,
    });
  }, 20_000);

  it('surfaces saturated retirement membership distinctly and remains fail closed', () => {
    const nearlyFullBits = Buffer.alloc(TEST_BLOCKED_MEMBERSHIP_BYTES);
    nearlyFullBits.fill(0xff, 0, Math.floor(TEST_BLOCKED_MEMBERSHIP_BYTES / 10));
    const generations = Array.from({ length: 2_049 }, (_, index) => ({
      generationId: createHash('sha256').update(`saturation-active-${index}`).digest('hex'),
      admittedAt: new Date(Date.parse('2025-01-01T00:00:00.000Z') + index * 1_000).toISOString(),
    }));
    writeTestAttemptReceiptProtocolV4(generations, testSegmentedBlockedMembership(Array.from(
      { length: 4 }, () => ({ bits: Buffer.from(nearlyFullBits), insertedCount: 15_000 }),
    )));
    const event = makeProofEvent({
      runId: 'run-membership-saturated',
      trajectoryId: 'run:attempt-membership-saturated',
    });

    expect(readDispatchProductionAttemptProtocolQuality()).toMatchObject({
      status: 'healthy',
      segmentCount: 4,
    });
    expect(recordDispatchProduction(event)).toEqual({
      attempted: 1,
      recorded: 0,
      failed: 1,
      failureReasons: ['retirement-membership-saturated'],
    });
    expect(readDispatchProductionAttemptProtocolQuality()).toMatchObject({
      status: 'saturated',
      segmentCount: 4,
    });
    expect(resolveDispatchProductionAttemptReceiptWitnesses([{
      repairGenerationId: event.repairGenerationId!, repairAttemptOrdinal: 1,
    }])).toEqual({
      status: 'resolved',
      resolutions: [{ status: 'degraded', reason: 'retirement-membership-saturated' }],
    });
  });

  it.each(['receipt', 'intent'] as const)(
    'preserves a digest-conflicting %s and fails retention closed',
    (kind) => {
      const receiptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
      const baseMs = Date.parse('2025-01-01T00:00:00.000Z');
      const seeded = Array.from({ length: 2_048 }, (_, index) => {
        const handoffId = (40_000 + index).toString(16).padStart(64, '0');
        return sanitizeDispatchProductionEvent(makeProofEvent({
          ts: new Date(baseMs + index * 1_000).toISOString(),
          repairHandoffId: handoffId,
          repairGenerationId: repairGenerationIdFromHandoffId(handoffId)!,
          runId: `run-retention-validation-${index}`,
          trajectoryId: `run:attempt-retention-validation-${index}`,
        }), { materializeLearningLabel: true });
      });
      writeTestAttemptReceiptProtocolActivation(seeded.map((event) => ({
        generationId: event.repairGenerationId!, admittedAt: event.ts,
      })));
      mkdirSync(dispatchProductionDir(), { recursive: true });
      writeFileSync(join(dispatchProductionDir(), '2025-01-01.jsonl'),
        `${seeded.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
      for (const event of seeded.slice(0, -1)) {
        writeFileSync(join(receiptDir, `${event.repairGenerationId}-1.json`),
          validatedAttemptReceiptText(event), 'utf8');
      }
      const original = seeded.at(-1)!;
      const conflicting = sanitizeDispatchProductionEvent({
        ...original,
        runId: 'run-retention-digest-conflict',
        trajectoryId: 'run:attempt-retention-digest-conflict',
        runEventSummary: {
          ...original.runEventSummary!,
          runId: 'run-retention-digest-conflict',
        },
      }, { materializeLearningLabel: true });
      const artifactName = kind === 'receipt'
        ? `${original.repairGenerationId}-1.json`
        : `${original.repairGenerationId}-1.intent.json`;
      const artifactPath = join(receiptDir, artifactName);
      writeFileSync(artifactPath, validatedAttemptReceiptText(conflicting), 'utf8');
      const handoffId = 'f'.repeat(63) + (kind === 'receipt' ? 'b' : 'c');
      const next = makeProofEvent({
        repairHandoffId: handoffId,
        repairGenerationId: repairGenerationIdFromHandoffId(handoffId)!,
        runId: `run-after-malformed-${kind}`,
        trajectoryId: `run:attempt-after-malformed-${kind}`,
      });

      expect(recordDispatchProduction(next)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
      expect(existsSync(artifactPath)).toBe(true);
      expect(readFileSync(artifactPath, 'utf8')).toBe(validatedAttemptReceiptText(conflicting));
      expect(existsSync(join(receiptDir, '.retention.json'))).toBe(false);
    },
    20_000,
  );

  it('distinguishes stable missing partitions and events from unproven related evidence', () => {
    const wanted = makeProofEvent();
    expect(resolveDispatchProductionAttemptProofs([proofTarget(wanted)])).toEqual([
      { status: 'missing', reason: 'partition-missing' },
    ]);

    const unrelatedHandoffId = 'f'.repeat(64);
    const unrelated = makeProofEvent({
      itemId: 'ashlr-hub:proposal-repair-nodiff:111111111111',
      repairHandoffId: unrelatedHandoffId,
      repairGenerationId: repairGenerationIdFromHandoffId(unrelatedHandoffId)!,
    });
    expect(recordDispatchProduction(unrelated)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    removeAttemptProofReceipts();
    expect(resolveDispatchProductionAttemptProofs([proofTarget(wanted)])).toEqual([
      { status: 'missing', reason: 'event-missing' },
    ]);

    expect(recordDispatchProduction(wanted)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(resolveDispatchProductionAttemptProofs([
      proofTarget(wanted, { objectiveHash: 'd'.repeat(64) }),
    ])).toEqual([{ status: 'unproven', reason: 'target-mismatch' }]);

    const routeMismatch = makeProofEvent({
      itemId: 'ashlr-hub:proposal-repair-nodiff:222222222222',
      routeSnapshot: {
        backend: 'codex',
        tier: 'mid',
        model: 'qwen-2.5-coder',
        assignedBy: 'daemon',
        reason: 'generated repair proof route',
        routerPolicyVersion: 'fleet-router-v1',
      },
    });
    expect(recordDispatchProduction(routeMismatch)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    removeAttemptProofReceipts();
    expect(resolveDispatchProductionAttemptProofs([proofTarget(routeMismatch)])).toEqual([
      { status: 'unproven', reason: 'event-ineligible' },
    ]);
  });

  it('collapses byte-identical replay and rejects distinct attempts for one exact target', () => {
    const event = makeProofEvent();
    expect(recordDispatchProduction([event, event])).toEqual({ attempted: 2, recorded: 2, failed: 0 });
    expect(resolveDispatchProductionAttemptProofs([proofTarget(event)])[0]).toMatchObject({
      status: 'proven',
      proof: { attemptHash: generatedRepairLifecycleAttemptHash(event.trajectoryId!) },
    });

    const conflicting = makeProofEvent({
      runId: 'run-proof-conflict',
      trajectoryId: 'run:attempt-proof-conflict',
      backend: 'codex',
      model: 'gpt-5.5',
      routeSnapshot: {
        backend: 'codex',
        tier: 'mid',
        model: 'gpt-5.5',
        assignedBy: 'daemon',
        reason: 'generated repair proof route',
        routerPolicyVersion: 'fleet-router-v1',
      },
      runEventSummary: {
        runId: 'run-proof-conflict',
        status: 'done',
        outcome: 'empty-diff',
        proposalCreated: false,
        costUsd: 0.002,
      },
    });
    expect(recordDispatchProduction(conflicting)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(resolveDispatchProductionAttemptProofs([proofTarget(event)])[0]).toMatchObject({
      status: 'proven',
      proof: { attemptHash: generatedRepairLifecycleAttemptHash(event.trajectoryId!) },
    });
  });

  it('never proves from malformed, torn, or over-bound partitions even when the target row is visible', () => {
    const event = makeProofEvent();
    const target = proofTarget(event);
    const path = join(dispatchProductionDir(), '2026-07-08.jsonl');

    recordDispatchProduction(event);
    appendFileSync(path, 'not-json\n', 'utf8');
    removeAttemptProofReceipts();
    expect(resolveDispatchProductionAttemptProofs([target])).toEqual([
      { status: 'degraded', reason: 'partition-invalid' },
    ]);

    rmSync(dispatchProductionDir(), { recursive: true, force: true });
    recordDispatchProduction(event);
    const complete = readFileSync(path, 'utf8');
    writeFileSync(path, complete.slice(0, -1), 'utf8');
    removeAttemptProofReceipts();
    expect(resolveDispatchProductionAttemptProofs([target])).toEqual([
      { status: 'degraded', reason: 'partition-invalid' },
    ]);

    rmSync(dispatchProductionDir(), { recursive: true, force: true });
    recordDispatchProduction(event);
    const exactRow = readFileSync(path, 'utf8');
    writeFileSync(path, '', 'utf8');
    truncateSync(path, 32 * 1024 * 1024 + 1);
    appendFileSync(path, `\n${exactRow}`, 'utf8');
    removeAttemptProofReceipts();
    expect(resolveDispatchProductionAttemptProofs([target])).toEqual([
      { status: 'degraded', reason: 'partition-byte-limit' },
    ]);
  });

  it('rejects a partition containing a row larger than the physical row bound', () => {
    const event = makeProofEvent();
    const path = join(dispatchProductionDir(), '2026-07-08.jsonl');
    expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    appendFileSync(path, `${JSON.stringify({ padding: 'x'.repeat(128 * 1024) })}\n`, 'utf8');
    removeAttemptProofReceipts();

    expect(resolveDispatchProductionAttemptProofs([proofTarget(event)])).toEqual([
      { status: 'degraded', reason: 'partition-invalid' },
    ]);
  });

  it('enforces the aggregate byte bound across individually valid selected partitions', () => {
    const secondHandoffId = 'd'.repeat(64);
    const first = makeProofEvent({
      ts: '2026-07-07T12:00:00.000Z',
      itemId: 'ashlr-hub:proposal-repair-nodiff:000000000071',
      runId: 'run-byte-first',
      trajectoryId: 'run:attempt-byte-first',
    });
    const second = makeProofEvent({
      ts: '2026-07-08T12:00:00.000Z',
      itemId: 'ashlr-hub:proposal-repair-nodiff:000000000072',
      runId: 'run-byte-second',
      trajectoryId: 'run:attempt-byte-second',
      repairHandoffId: secondHandoffId,
      repairGenerationId: repairGenerationIdFromHandoffId(secondHandoffId)!,
    });
    expect(recordDispatchProduction([first, second])).toEqual({ attempted: 2, recorded: 2, failed: 0 });
    const desiredBytes = 17 * 1024 * 1024;
    for (const date of ['2026-07-07', '2026-07-08']) {
      const path = join(dispatchProductionDir(), `${date}.jsonl`);
      const line = readFileSync(path, 'utf8');
      writeFileSync(path, line.repeat(Math.ceil(desiredBytes / Buffer.byteLength(line))), 'utf8');
    }
    removeAttemptProofReceipts();

    expect(resolveDispatchProductionAttemptProofs([proofTarget(first), proofTarget(second)])).toEqual([
      { status: 'degraded', reason: 'partition-byte-limit' },
      { status: 'degraded', reason: 'partition-byte-limit' },
    ]);
  });

  it('bounds one proof-resolution invocation to thirty-two UTC partitions', () => {
    const event = makeProofEvent();
    const targets = Array.from({ length: 33 }, (_, index) => proofTarget(event, {
      ts: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    }));

    expect(resolveDispatchProductionAttemptProofs(targets)).toEqual(
      targets.map(() => ({ status: 'degraded', reason: 'date-limit' })),
    );
  });

  it('bounds target cardinality before touching storage', () => {
    const event = makeProofEvent();
    const targets = Array.from({ length: 257 }, () => proofTarget(event));

    expect(resolveDispatchProductionAttemptProofBatch(targets)).toEqual({
      status: 'degraded', reason: 'target-limit',
    });
    expect(existsSync(dispatchProductionDir())).toBe(false);
  });

  it('fails runtime-invalid and sparse targets closed without hiding valid neighbors', () => {
    const event = makeProofEvent();
    expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    const targets = new Array<DispatchProductionAttemptProofTarget>(4);
    targets[0] = null as never;
    targets[2] = proofTarget(event);
    targets[3] = 7 as never;

    expect(resolveDispatchProductionAttemptProofs(targets)).toEqual([
      { status: 'degraded', reason: 'target-invalid' },
      { status: 'degraded', reason: 'target-invalid' },
      { status: 'proven', proof: expect.objectContaining({ eventTs: event.ts }) },
      { status: 'degraded', reason: 'target-invalid' },
    ]);
  });

  it('rejects existing zero-byte partitions as incomplete rather than authoritative absence', () => {
    const event = makeProofEvent();
    mkdirSync(dispatchProductionDir(), { recursive: true });
    writeFileSync(join(dispatchProductionDir(), '2026-07-08.jsonl'), '', 'utf8');

    expect(resolveDispatchProductionAttemptProofs([proofTarget(event)])).toEqual([
      { status: 'degraded', reason: 'partition-invalid' },
    ]);
  });

  it('rejects every contradictory persisted no-diff signal', () => {
    const events = Array.from({ length: 6 }, (_, index) => {
      const event = makeProofEvent({
        itemId: `ashlr-hub:proposal-repair-nodiff:${String(index + 10).padStart(12, '0')}`,
        runId: `run-contradiction-${index}`,
        trajectoryId: `run:attempt-contradiction-${index}`,
      });
      const summary = { ...event.runEventSummary! };
      if (index === 0) event.diffFiles = 1;
      if (index === 1) event.diffLines = 1;
      if (index === 2) summary.diffFiles = 1;
      if (index === 3) summary.diffLines = 1;
      if (index === 4) summary.actionCounts = { diffFiles: 1 };
      if (index === 5) summary.actionCounts = { proposalCreated: 1 };
      event.runEventSummary = summary;
      return event;
    });
    expect(recordDispatchProduction(events)).toEqual({ attempted: 6, recorded: 6, failed: 0 });

    expect(resolveDispatchProductionAttemptProofs(events.map((event) => proofTarget(event)))).toEqual(
      events.map(() => ({ status: 'unproven', reason: 'event-ineligible' })),
    );
  });

  it('rejects writer-impossible lineage flags and unknown raw metadata', () => {
    const cases: Array<(row: Record<string, unknown>) => void> = [
      (row) => { row['repairLineageInvalid'] = false; },
      (row) => { (row['routeSnapshot'] as Record<string, unknown>)['rawPrompt'] = 'canary'; },
      (row) => { row['rawStdout'] = 'canary'; },
    ];
    for (const mutate of cases) {
      rmSync(dispatchProductionDir(), { recursive: true, force: true });
      const event = makeProofEvent();
      expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
      const path = join(dispatchProductionDir(), '2026-07-08.jsonl');
      const row = JSON.parse(readFileSync(path, 'utf8').trim()) as Record<string, unknown>;
      mutate(row);
      writeFileSync(path, `${JSON.stringify(row)}\n`, 'utf8');
      removeAttemptProofReceipts();
      expect(resolveDispatchProductionAttemptProofs([proofTarget(event)])).toEqual([
        { status: 'degraded', reason: 'partition-invalid' },
      ]);
    }
  });

  it('binds ordinal two to the proven ordinal-one backend and tier', () => {
    const first = makeProofEvent({
      runId: 'run-sequence-first',
      trajectoryId: 'run:attempt-sequence-first',
    });
    const second = makeProofEvent({
      ts: '2026-07-08T12:01:00.000Z',
      runId: 'run-sequence-second',
      trajectoryId: 'run:attempt-sequence-second',
      backend: 'codex',
      model: 'gpt-5.5',
      routeSnapshot: {
        backend: 'codex',
        tier: 'mid',
        model: 'gpt-5.5',
        assignedBy: 'daemon',
        reason: 'generated repair proof route',
        routerPolicyVersion: 'fleet-router-v1',
      },
      repairAttemptOrdinal: 2,
      repairPreviousBackend: 'claude',
    });
    expect(recordDispatchProduction([first, second])).toEqual({ attempted: 2, recorded: 2, failed: 0 });

    expect(resolveDispatchProductionAttemptProofs([proofTarget(first), proofTarget(second)])).toEqual([
      { status: 'unproven', reason: 'attempt-sequence-mismatch' },
      { status: 'unproven', reason: 'attempt-sequence-mismatch' },
    ]);
    expect(resolveDispatchProductionAttemptProofs([proofTarget(second)])).toEqual([
      { status: 'unproven', reason: 'attempt-sequence-mismatch' },
    ]);
  });

  it('propagates degraded first-attempt authority to its dependent second attempt', () => {
    const first = makeProofEvent({
      ts: '2026-07-07T12:00:00.000Z',
      runId: 'run-degraded-first',
      trajectoryId: 'run:attempt-degraded-first',
    });
    const second = makeProofEvent({
      ts: '2026-07-08T12:00:00.000Z',
      runId: 'run-dependent-second',
      trajectoryId: 'run:attempt-dependent-second',
      backend: 'codex',
      model: 'gpt-5.5',
      routeSnapshot: {
        backend: 'codex',
        tier: 'mid',
        model: 'gpt-5.5',
        assignedBy: 'daemon',
        reason: 'generated repair proof route',
        routerPolicyVersion: 'fleet-router-v1',
      },
      repairAttemptOrdinal: 2,
      repairPreviousBackend: 'local-coder',
    });
    expect(recordDispatchProduction([first, second])).toEqual({ attempted: 2, recorded: 2, failed: 0 });
    appendFileSync(join(dispatchProductionDir(), '2026-07-07.jsonl'), 'not-json\n', 'utf8');
    removeAttemptProofReceipts();

    expect(resolveDispatchProductionAttemptProofs([proofTarget(first), proofTarget(second)])).toEqual([
      { status: 'degraded', reason: 'partition-invalid' },
      { status: 'degraded', reason: 'partition-invalid' },
    ]);
  });

  it('rejects a same-lineage second attempt that changes tier', () => {
    const first = makeProofEvent();
    const second = makeProofEvent({
      ts: '2026-07-08T12:02:00.000Z',
      runId: 'run-tier-second',
      trajectoryId: 'run:attempt-tier-second',
      backend: 'codex',
      tier: 'frontier',
      model: 'gpt-5.5',
      routeSnapshot: {
        backend: 'codex',
        tier: 'frontier',
        model: 'gpt-5.5',
        assignedBy: 'daemon',
        reason: 'generated repair proof route',
        routerPolicyVersion: 'fleet-router-v1',
      },
      repairAttemptOrdinal: 2,
      repairPreviousBackend: 'local-coder',
    });
    expect(recordDispatchProduction([first, second])).toEqual({ attempted: 2, recorded: 2, failed: 0 });

    expect(resolveDispatchProductionAttemptProofs([proofTarget(first), proofTarget(second)])[1]).toEqual(
      { status: 'unproven', reason: 'attempt-sequence-mismatch' },
    );
  });

  it('requires one unique first identity and a distinct second identity per sequence', () => {
    const first = makeProofEvent({
      runId: 'run-identity-first',
      trajectoryId: 'run:shared-attempt-identity',
    });
    const second = makeProofEvent({
      ts: '2026-07-08T12:03:00.000Z',
      runId: 'run-identity-second',
      trajectoryId: 'run:shared-attempt-identity',
      backend: 'codex',
      model: 'gpt-5.5',
      routeSnapshot: {
        backend: 'codex',
        tier: 'mid',
        model: 'gpt-5.5',
        assignedBy: 'daemon',
        reason: 'generated repair proof route',
        routerPolicyVersion: 'fleet-router-v1',
      },
      repairAttemptOrdinal: 2,
      repairPreviousBackend: 'local-coder',
    });
    expect(recordDispatchProduction([first, second])).toEqual({ attempted: 2, recorded: 2, failed: 0 });
    expect(resolveDispatchProductionAttemptProofs([proofTarget(first), proofTarget(second)])[1]).toEqual(
      { status: 'unproven', reason: 'attempt-sequence-mismatch' },
    );

    rmSync(dispatchProductionDir(), { recursive: true, force: true });
    const duplicateFirst = makeProofEvent({
      ts: '2026-07-08T12:04:00.000Z',
      runId: 'run-identity-extra-first',
      trajectoryId: 'run:extra-first-attempt-identity',
    });
    expect(recordDispatchProduction(first)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(recordDispatchProduction(duplicateFirst)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    removeAttemptProofReceipts();
    appendFileSync(
      join(dispatchProductionDir(), '2026-07-08.jsonl'),
      `${JSON.stringify(sanitizeDispatchProductionEvent(duplicateFirst, { materializeLearningLabel: true }))}\n`,
      'utf8',
    );
    expect(resolveDispatchProductionAttemptProofs([
      proofTarget(first), proofTarget(duplicateFirst),
    ])).toEqual([
      { status: 'unproven', reason: 'attempt-sequence-mismatch' },
      { status: 'unproven', reason: 'attempt-sequence-mismatch' },
    ]);
  });

  it('accepts producer-compatible route reason normalization without trusting it as identity', () => {
    const event = makeProofEvent({
      routeReason: 'short normalized route reason',
      routeSnapshot: {
        backend: 'local-coder',
        tier: 'mid',
        model: 'qwen-2.5-coder',
        assignedBy: 'daemon',
        reason: 'longer producer route reason retained in the causal snapshot',
        routerPolicyVersion: 'fleet-router-v1',
      },
    });
    expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });

    expect(resolveDispatchProductionAttemptProofs([proofTarget(event)])[0]).toMatchObject({
      status: 'proven',
      proof: { backend: 'local-coder', tier: 'mid' },
    });
  });

  it('idempotently rejects relative and secret-shaped raw repo identities without fallback rows', () => {
    const secret = 'github_pat_1234567890abcdefghijklmnop';
    const invalidRepos = ['relative/repo', join(home, `token=${secret}`)];

    for (const [index, repo] of invalidRepos.entries()) {
      const event = makeEvent({ itemId: `invalid-repo-${index}`, repo });
      expect(() => sanitizeDispatchProductionEvent(event)).toThrow(/repository identity/);
      expect(() => sanitizeDispatchProductionEvent(event)).toThrow(/repository identity/);
      expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
      expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    }

    expect(existsSync(join(dispatchProductionDir(), '2026-07-08.jsonl'))).toBe(false);
  });

  it('preserves complete repair transition lineage and marks partial or inconsistent tuples invalid', () => {
    const handoffId = 'a'.repeat(64);
    const generationId = repairGenerationIdFromHandoffId(handoffId)!;
    recordDispatchProduction([
      makeEvent({
        itemId: 'repair-first',
        repairHandoffId: handoffId,
        repairGenerationId: generationId,
        repairAttemptOrdinal: 1,
      }),
      makeEvent({
        itemId: 'repair-retry',
        repairHandoffId: handoffId,
        repairGenerationId: generationId,
        repairAttemptOrdinal: 2,
        repairPreviousBackend: 'local-coder',
        backend: 'kimi',
      }),
      makeEvent({
        itemId: 'repair-partial',
        repairHandoffId: handoffId,
        repairAttemptOrdinal: 2,
        repairPreviousBackend: 'local-coder',
      }),
      makeEvent({
        itemId: 'repair-inconsistent',
        repairHandoffId: handoffId,
        repairGenerationId: generationId,
        repairAttemptOrdinal: 1,
        repairPreviousBackend: 'local-coder',
      }),
      makeEvent({
        itemId: 'repair-unbound',
        repairHandoffId: handoffId,
        repairGenerationId: 'b'.repeat(64),
        repairAttemptOrdinal: 1,
      }),
      makeEvent({
        itemId: 'repair-same-backend',
        repairHandoffId: handoffId,
        repairGenerationId: generationId,
        repairAttemptOrdinal: 2,
        repairPreviousBackend: 'local-coder',
        backend: 'local-coder',
      }),
    ]);

    const byId = new Map(readDispatchProductionEvents().map((event) => [event.itemId, event]));
    expect(byId.get('repair-first')).toMatchObject({
      repairHandoffId: handoffId,
      repairGenerationId: generationId,
      repairAttemptOrdinal: 1,
    });
    expect(byId.get('repair-first')).not.toHaveProperty('repairPreviousBackend');
    expect(byId.get('repair-retry')).toMatchObject({
      repairHandoffId: handoffId,
      repairGenerationId: generationId,
      repairAttemptOrdinal: 2,
      repairPreviousBackend: 'local-coder',
      backend: 'kimi',
    });
    expect(byId.get('repair-partial')).toMatchObject({ repairLineageInvalid: true });
    expect(byId.get('repair-inconsistent')).toMatchObject({ repairLineageInvalid: true });
    expect(byId.get('repair-unbound')).toMatchObject({ repairLineageInvalid: true });
    expect(byId.get('repair-same-backend')).toMatchObject({ repairLineageInvalid: true });
    expect(summarizeDispatchProductionYield([...byId.values()])?.generatedRepairBackendTransitions).toMatchObject({
      sourceState: 'degraded',
      lineageEvents: 2,
      transitionEvents: 1,
      attempts: 1,
      invalidLineageEvents: 4,
    });
  });

  it('honors limit and sinceMs filters', () => {
    recordDispatchProduction([
      makeEvent({ itemId: 'a', ts: '2026-07-08T00:00:00.000Z' }),
      makeEvent({ itemId: 'b', ts: '2026-07-08T00:01:00.000Z' }),
      makeEvent({ itemId: 'c', ts: '2026-07-08T00:02:00.000Z' }),
    ]);

    expect(readDispatchProductionEvents({ limit: 2 }).map((event) => event.itemId)).toEqual(['c', 'b']);
    expect(readDispatchProductionEvents({ sinceMs: Date.parse('2026-07-08T00:01:30.000Z') }).map((event) => event.itemId)).toEqual(['c']);
    expect(readDispatchProductionEventsDetailed({ limit: 2 })).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      stopReasons: ['event-limit'],
      events: [{ itemId: 'c' }, { itemId: 'b' }],
    });
  });

  it('normalizes invalid timestamps before writing', () => {
    recordDispatchProduction(makeEvent({ itemId: 'bad-ts', ts: 'not-a-date' }));

    const event = readDispatchProductionEvents({ limit: 1 })[0];

    expect(event).toMatchObject({ itemId: 'bad-ts' });
    expect(Number.isFinite(Date.parse(event!.ts))).toBe(true);
  });

  it('skips malformed lines and scrubs secret-shaped text before persistence', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-07-08.jsonl'), 'not-json\n', 'utf8');

    recordDispatchProduction(makeEvent({
      itemId: 'secret-item',
      routeReason: 'Authorization Bearer sk-supersecretsecretsecret',
      reason: 'token=ghp_1234567890abcdefABCDEF leaked by tool',
    }));

    const events = readDispatchProductionEvents();

    expect(events).toHaveLength(1);
    expect(events[0]!.itemId).toBe('secret-item');
    const raw = readFileSync(join(dir, '2026-07-08.jsonl'), 'utf8');
    expect(raw).not.toContain('sk-supersecretsecretsecret');
    expect(raw).not.toContain('ghp_1234567890abcdefABCDEF');
    expect(raw).toContain('[REDACTED]');
  });

  it('persists authoritative versioned learning labels and drops hostile label payloads', () => {
    const rawPromptCanary = 'RAW_PROMPT_ATTEMPT_LABEL_CANARY_M342';
    const rawDiffCanary = 'RAW_DIFF_ATTEMPT_LABEL_CANARY_M342';
    recordDispatchProduction(makeEvent({
      itemId: 'policy-label',
      outcome: 'proposal-disabled',
      proposalCreated: false,
      runEventSummary: {
        outcome: 'proposal-disabled',
        proposalCreated: false,
        actionCounts: { proposalDisabled: 2, diffFiles: 0 },
      },
      learningLabel: {
        schemaVersion: 1,
        classifierVersion: 'attempt-shape-v1',
        authoritative: true,
        learningKind: 'diagnostic-no-proposal',
        policySuppressed: false,
        diagnosticNoProposal: true,
        diagnosticAttempt: true,
        attemptShape: {
          backendNoDiff: 99,
          captureOrGateBlocked: 99,
          repairAttempts: 99,
          policyDisabled: 0,
        },
        rawPrompt: rawPromptCanary,
        rawDiff: rawDiffCanary,
      } as never,
      rawPrompt: rawPromptCanary,
      rawDiff: rawDiffCanary,
    } as never));

    const event = readDispatchProductionEvents({ limit: 1 })[0];
    expect(event?.learningLabel).toMatchObject({
      schemaVersion: 1,
      classifierVersion: 'attempt-shape-v2',
      authoritative: true,
      learningKind: 'policy-suppressed',
      policySuppressed: true,
      diagnosticNoProposal: false,
      diagnosticAttempt: false,
      attemptShape: {
        backendNoDiff: 0,
        captureOrGateBlocked: 0,
        repairAttempts: 0,
        policyDisabled: 2,
      },
    });

    const raw = readFileSync(join(dispatchProductionDir(), '2026-07-08.jsonl'), 'utf8');
    expect(raw).toContain('"learningLabel"');
    expect(raw).toContain('"authoritative":true');
    expect(raw).toContain('"routerPolicyVersion":"fleet-router-v1"');
    expect(raw).toContain('"learningEpoch":"2026-07-08"');
    expect(event?.routerPolicyVersion).toBe('fleet-router-v1');
    expect(event?.learningEpoch).toBe('2026-07-08');
    expect(raw).not.toContain(rawPromptCanary);
    expect(raw).not.toContain(rawDiffCanary);
    expect(JSON.stringify(event)).not.toContain(rawPromptCanary);
    expect(JSON.stringify(event)).not.toContain(rawDiffCanary);
  });

  it('keeps legacy rows visible with read-time labels but without durable rewrite', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-07-08.jsonl'), JSON.stringify(makeEvent({ itemId: 'legacy-row' })) + '\n', 'utf8');

    const event = readDispatchProductionEvents({ limit: 1 })[0];
    const summary = summarizeDispatchProductionYield(event ? [event] : []);

    expect(event?.itemId).toBe('legacy-row');
    expect(event?.routeSnapshot).toMatchObject({
      backend: 'local-coder',
      tier: 'mid',
      model: 'qwen',
      assignedBy: 'daemon',
      reason: 'local-mid bulk: local-coder',
    });
    expect(event?.runEventSummary).toMatchObject({
      runId: 'run-a',
      outcome: 'empty-diff',
      proposalCreated: false,
      costUsd: 0.001,
    });
    expect(event?.learningLabel).toMatchObject({
      authoritative: true,
      learningKind: 'diagnostic-no-proposal',
      diagnosticNoProposal: true,
      attemptShape: { backendNoDiff: 1 },
    });
    expect(summary).toMatchObject({
      attempts: 1,
      attemptShape: { backendNoDiff: 1 },
    });
    const raw = readFileSync(join(dir, '2026-07-08.jsonl'), 'utf8');
    expect(raw).not.toContain('"routeSnapshot"');
    expect(raw).not.toContain('"runEventSummary"');
    expect(raw).not.toContain('"learningLabel"');
  });

  it('uses a valid durable learning label for attempt-shape aggregation when raw signals disagree', () => {
    const event = makeEvent({
      itemId: 'contradictory-label',
      outcome: 'empty-diff',
      proposalCreated: false,
      reason: 'empty-diff from raw run',
      runEventSummary: {
        outcome: 'empty-diff',
        proposalCreated: false,
        actionCounts: { diffFiles: 0 },
      },
      learningLabel: {
        schemaVersion: 1,
        classifierVersion: 'attempt-shape-v1',
        authoritative: true,
        learningKind: 'policy-suppressed',
        policySuppressed: true,
        diagnosticNoProposal: false,
        diagnosticAttempt: false,
        attemptShape: {
          backendNoDiff: 0,
          captureOrGateBlocked: 0,
          repairAttempts: 0,
          policyDisabled: 7,
        },
      },
    });

    const summary = summarizeDispatchProductionYield([event]);

    expect(summary).toMatchObject({
      attempts: 1,
      outcomes: { emptyDiff: 1 },
      attemptShape: {
        backendNoDiff: 0,
        captureOrGateBlocked: 0,
        repairAttempts: 0,
        policyDisabled: 7,
      },
      topReasons: [{ reason: 'empty-diff from raw run', count: 1 }],
      diagnosticTopReasons: [],
      byBackend: [{
        key: 'local-coder',
        topReasons: [{ reason: 'empty-diff from raw run', count: 1 }],
        diagnosticTopReasons: [],
      }],
    });
  });

  it('never throws when persistence is unavailable', () => {
    process.env.ASHLR_HOME = join(home, 'file-home');
    writeFileSync(process.env.ASHLR_HOME, 'not a directory', 'utf8');

    expect(recordDispatchProduction(makeEvent())).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(() => readDispatchProductionEvents()).not.toThrow();
    expect(readDispatchProductionEvents()).toEqual([]);
    expect(existsSync(process.env.ASHLR_HOME)).toBe(true);
  });

  it('reports missing, healthy-empty, and malformed source states without healthy-zero collapse', () => {
    expect(readDispatchProductionEventsDetailed()).toMatchObject({
      events: [],
      sourceState: 'missing',
      sourcePresent: false,
      complete: true,
    });

    mkdirSync(dispatchProductionDir(), { recursive: true });
    expect(readDispatchProductionEventsDetailed()).toMatchObject({
      events: [],
      sourceState: 'healthy',
      sourcePresent: true,
      complete: true,
    });

    writeFileSync(
      join(dispatchProductionDir(), '2026-07-08.jsonl'),
      `${JSON.stringify(makeEvent({ itemId: 'valid' }))}\nnot-json\n`,
      'utf8',
    );
    const degraded = readDispatchProductionEventsDetailed();
    expect(degraded.events.map((event) => event.itemId)).toEqual(['valid']);
    expect(degraded).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      invalidRows: 1,
      unreadableFiles: 0,
    });
  });

  it('reads only the newest bounded tail and never backfills an older partition', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '2026-07-07.jsonl'),
      `${JSON.stringify(makeEvent({ itemId: 'older-partition' }))}\n`,
      'utf8',
    );
    const filler = `${JSON.stringify(makeEvent({ itemId: 'newer-filler' }))}\n`;
    const newest = `${JSON.stringify(makeEvent({ itemId: 'newest-event' }))}\n`;
    writeFileSync(join(dir, '2026-07-08.jsonl'), `${filler}${newest}`, 'utf8');

    const maxBytes = Buffer.byteLength(newest, 'utf8') + 1;
    const read = readDispatchProductionEventsDetailed({ maxBytes, limit: 20, maxRows: 100 });

    expect(read.events.map((event) => event.itemId)).toEqual(['newest-event']);
    expect(read).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      stopReasons: ['byte-limit'],
      filesRead: 1,
      bytesRead: maxBytes,
    });
    expect(read.events.map((event) => event.itemId)).not.toContain('older-partition');
  });

  it('bounds physical malformed rows even when no valid event can be returned', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-07-08.jsonl'), `${'not-json\n'.repeat(10)}`, 'utf8');

    const read = readDispatchProductionEventsDetailed({ maxRows: 3, limit: 20 });

    expect(read).toMatchObject({
      events: [],
      sourceState: 'degraded',
      complete: false,
      rowsScanned: 3,
      invalidRows: 3,
    });
    expect(read.stopReasons).toContain('row-limit');
  });

  it('does not count the terminal JSONL separator against the physical row budget', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '2026-07-08.jsonl'),
      `${JSON.stringify(makeEvent({ itemId: 'single-row' }))}\n`,
      'utf8',
    );

    expect(readDispatchProductionEventsDetailed({ maxRows: 1, limit: 20 })).toMatchObject({
      events: [{ itemId: 'single-row' }],
      sourceState: 'healthy',
      complete: true,
      rowsScanned: 1,
    });
    expect(readDispatchProductionEventsDetailed({ maxRows: 10, limit: 1 })).toMatchObject({
      events: [{ itemId: 'single-row' }],
      sourceState: 'healthy',
      complete: true,
      stopReasons: [],
    });
  });

  it('prunes stale partitions before deciding an exact row budget is exhausted', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(dir, `${now.slice(0, 10)}.jsonl`),
      `${JSON.stringify(makeEvent({ itemId: 'current-row', ts: now }))}\n`,
      'utf8',
    );
    writeFileSync(
      join(dir, '2020-01-01.jsonl'),
      `${JSON.stringify(makeEvent({ itemId: 'stale-row', ts: '2020-01-01T00:00:00.000Z' }))}\n`,
      'utf8',
    );

    expect(readDispatchProductionEventsDetailed({
      sinceMs: Date.now() - 60 * 60 * 1000,
      maxRows: 1,
      limit: 20,
    })).toMatchObject({
      events: [{ itemId: 'current-row' }],
      sourceState: 'healthy',
      complete: true,
      stopReasons: [],
      rowsScanned: 1,
    });
  });

  it('reads dated partitions before loose legacy filenames under a shared byte budget', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true });
    const dated = `${JSON.stringify(makeEvent({ itemId: 'dated-current' }))}\n`;
    writeFileSync(join(dir, '2026-07-08.jsonl'), dated, 'utf8');
    writeFileSync(join(dir, 'zz-legacy.jsonl'), `${'x'.repeat(500)}\n`, 'utf8');

    const read = readDispatchProductionEventsDetailed({ maxBytes: Buffer.byteLength(dated) + 1, limit: 20 });

    expect(read.events.map((event) => event.itemId)).toEqual(['dated-current']);
    expect(read.filesRead).toBe(2);
    expect(read.stopReasons).toContain('byte-limit');
  });

  it('rejects linked partitions and exposes the I/O failure', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true });
    const target = join(home, 'outside.jsonl');
    writeFileSync(target, `${JSON.stringify(makeEvent({ itemId: 'linked' }))}\n`, 'utf8');
    symlinkSync(target, join(dir, '2026-07-08.jsonl'));

    expect(readDispatchProductionEventsDetailed()).toMatchObject({
      events: [],
      sourceState: 'degraded',
      complete: false,
      stopReasons: ['io-error'],
      unreadableFiles: 1,
    });
  });

  it.skipIf(process.platform === 'win32')('rejects a linked storage directory', () => {
    const dir = dispatchProductionDir();
    const outside = join(home, 'outside-dir');
    mkdirSync(outside, { mode: 0o700 });
    mkdirSync(join(home, 'placeholder'), { mode: 0o700 });
    symlinkSync(outside, dir, 'dir');
    writeFileSync(join(outside, '2026-07-08.jsonl'), `${JSON.stringify(makeEvent())}\n`, { mode: 0o600 });

    expect(readDispatchProductionEventsDetailed()).toMatchObject({
      events: [], sourceState: 'degraded', complete: false,
      stopReasons: ['io-error'], unreadableFiles: 1,
    });
  });

  it('bounds physical directory enumeration before selecting ledger files', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (let index = 0; index < 2_049; index++) {
      writeFileSync(join(dir, `noise-${index}.txt`), '');
    }

    expect(readDispatchProductionEventsDetailed()).toMatchObject({
      events: [], sourceState: 'degraded', complete: false,
      stopReasons: ['file-limit'], filesRead: 0,
    });
  });

  it('isolates a torn tail before appending the next durable event', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, '2026-07-08.jsonl');
    writeFileSync(path, `${JSON.stringify(makeEvent({ itemId: 'before-torn' }))}\n{"partial":`, 'utf8');

    recordDispatchProduction(makeEvent({ itemId: 'after-torn' }));
    const read = readDispatchProductionEventsDetailed();

    expect(read.events.map((event) => event.itemId)).toEqual(['after-torn', 'before-torn']);
    expect(read).toMatchObject({ sourceState: 'degraded', invalidRows: 1 });
  });

  it('rejects malformed persisted timestamps instead of promoting them into the current window', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`),
      `${JSON.stringify(makeEvent({ itemId: 'bad-persisted-ts', ts: 'not-a-date' }))}\n`,
      'utf8',
    );

    const read = readDispatchProductionEventsDetailed({ sinceMs: Date.now() - 60_000 });
    expect(read).toMatchObject({ events: [], sourceState: 'degraded', invalidRows: 1 });
  });

  it('propagates bounded read quality through yield diagnostics while preserving wrappers', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, new Date().toISOString().slice(0, 10) + '.jsonl'),
      `${JSON.stringify(makeEvent({ itemId: 'yield-valid', ts: new Date().toISOString() }))}\nnot-json\n`,
      'utf8',
    );

    const detailed = readDispatchProductionYieldDetailed({ windowMs: 60 * 60 * 1000, limit: 20 });
    expect(detailed.summary).toMatchObject({ events: 1 });
    expect(detailed.sourceQuality).toMatchObject({ sourceState: 'degraded', invalidRows: 1 });
    expect(readDispatchProductionYield({ windowMs: 60 * 60 * 1000, limit: 20 })).toMatchObject({ events: 1 });
    expect(readDispatchProductionEvents({ limit: 20 })).toHaveLength(1);
  });

  it('summarizes proposal yield by backend, source, repo, and model', () => {
    const events = [
      makeEvent({
        itemId: 'a',
        backend: 'local-coder',
        model: 'qwen',
        outcome: 'empty-diff',
        proposalCreated: false,
        reason: 'no diff',
        runEventSummary: {
          actionCounts: {
            proposalCaptureAttempts: 1,
            diffFiles: 0,
            proposalBlocked: 1,
          },
        },
      }),
      makeEvent({
        itemId: 'b',
        backend: 'local-coder',
        model: 'qwen',
        outcome: 'gate-blocked',
        proposalCreated: false,
        reason: 'gate blocked',
        runEventSummary: {
          actionCounts: {
            proposalCaptureAttempts: 1,
            completenessGateRuns: 1,
            verifyRepairAttempts: 1,
            diffFiles: 2,
            diffLines: 15,
            proposalBlocked: 1,
          },
        },
      }),
      makeEvent({
        itemId: 'c',
        backend: 'codex',
        model: 'gpt-5.5',
        outcome: 'proposal-created',
        proposalCreated: true,
        proposalId: 'prop-c',
        source: 'goal',
        runEventSummary: {
          actionCounts: {
            proposalCaptureAttempts: 1,
            diffFiles: 1,
            diffLines: 5,
            proposalCreated: 1,
          },
        },
      }),
      makeEvent({
        itemId: 'd',
        backend: 'codex',
        model: 'gpt-5.5',
        outcome: 'proposal-disabled',
        proposalCreated: false,
        reason: 'proposal filing disabled for this sandboxed attempt',
        runEventSummary: {
          actionCounts: {
            proposalDisabled: 1,
          },
        },
      }),
    ];

    const summary = summarizeDispatchProductionYield(events, { windowHours: 24 });

    expect(summary).toMatchObject({
      attempts: 4,
      events: 4,
      proposalsCreated: 1,
      noProposal: 3,
      proposalRate: 1 / 4,
      diagnosticAttempts: 3,
      diagnosticNoProposal: 2,
      diagnosticProposalRate: 1 / 3,
      outcomes: {
        proposalCreated: 1,
        emptyDiff: 1,
        gateBlocked: 1,
        proposalDisabled: 1,
      },
      actionCounts: {
        proposalCaptureAttempts: 3,
        completenessGateRuns: 1,
        verifyRepairAttempts: 1,
        diffFiles: 3,
        diffLines: 20,
        proposalCreated: 1,
        proposalBlocked: 2,
        proposalDisabled: 1,
      },
      attemptShape: {
        backendNoDiff: 1,
        captureOrGateBlocked: 1,
        repairAttempts: 1,
        policyDisabled: 1,
      },
    });
    expect(summary?.byBackend[0]).toMatchObject({
      backend: 'local-coder',
      attempts: 2,
      proposalsCreated: 0,
      noProposal: 2,
      proposalRate: 0,
      diagnosticAttempts: 2,
      diagnosticNoProposal: 2,
      diagnosticProposalRate: 0,
      outcomes: {
        emptyDiff: 1,
        gateBlocked: 1,
      },
      actionCounts: {
        proposalCaptureAttempts: 2,
        completenessGateRuns: 1,
        verifyRepairAttempts: 1,
        diffFiles: 2,
        diffLines: 15,
        proposalBlocked: 2,
      },
      attemptShape: {
        backendNoDiff: 1,
        captureOrGateBlocked: 1,
        repairAttempts: 1,
        policyDisabled: 0,
      },
    });
    expect(summary?.bySource.some((bucket) => bucket.source === 'goal' && bucket.proposalsCreated === 1)).toBe(true);
    expect(summary?.byBackendSource.some((bucket) =>
      bucket.key === 'local-coder:todo' &&
      bucket.backend === 'local-coder' &&
      bucket.source === 'todo' &&
      bucket.attempts === 2 &&
      bucket.proposalRate === 0
    )).toBe(true);
    expect(summary?.byBackendSource.some((bucket) =>
      bucket.key === 'codex:goal' &&
      bucket.backend === 'codex' &&
      bucket.source === 'goal' &&
      bucket.attempts === 1 &&
      bucket.proposalRate === 1
    )).toBe(true);
    expect(summary?.byBackendSource.some((bucket) =>
      bucket.key === 'codex:todo' &&
      bucket.backend === 'codex' &&
      bucket.source === 'todo' &&
      bucket.attempts === 1 &&
      bucket.outcomes.proposalDisabled === 1
    )).toBe(true);
    expect(summary?.byBackend.some((bucket) =>
      bucket.backend === 'codex' &&
      bucket.attempts === 2 &&
      bucket.diagnosticAttempts === 1 &&
      bucket.diagnosticNoProposal === 0 &&
      bucket.diagnosticProposalRate === 1 &&
      bucket.outcomes.proposalDisabled === 1 &&
      bucket.actionCounts?.proposalCreated === 1 &&
      bucket.actionCounts?.proposalDisabled === 1
    )).toBe(true);
    expect(summary?.byBackendModel.some((bucket) =>
      bucket.key === 'codex:gpt-5.5' &&
      bucket.attempts === 2 &&
      bucket.proposalRate === 0.5 &&
      bucket.outcomes.proposalDisabled === 1 &&
      bucket.actionCounts?.diffFiles === 1 &&
      bucket.actionCounts?.diffLines === 5
    )).toBe(true);
  });

  it('classifies generated repair work as repair attempts without raw text in labels', () => {
    const captureRepair = makeEvent({
      itemId: 'ashlr-hub:proposal-repair-capture:abcdef123456',
      title: 'Repair dispatch capture failure for ashlr-hub item ashlr-hub:self-heal:stalled',
      outcome: 'proposal-created',
      proposalCreated: true,
      proposalId: 'prop-repair',
      reason: 'completed repair proposal',
      runEventSummary: {
        runId: 'run-repair',
        outcome: 'proposal-created',
        proposalCreated: true,
        proposalId: 'prop-repair',
        actionCounts: { proposalCreated: 1, diffFiles: 1, diffLines: 8 },
      },
    });
    const noDiffReslice = makeEvent({
      itemId: 'ashlr-hub:proposal-repair-nodiff:123456789abc',
      title: 'Reslice no-diff dispatch for ashlr-hub item ashlr-hub:goal:stalled',
      outcome: 'empty-diff',
      proposalCreated: false,
      proposalId: undefined,
      reason: 'still no diff',
      runEventSummary: {
        runId: 'run-reslice',
        outcome: 'empty-diff',
        proposalCreated: false,
        actionCounts: { diffFiles: 0 },
      },
    });
    recordDispatchProduction(captureRepair);

    const event = readDispatchProductionEvents()[0]!;
    const summary = summarizeDispatchProductionYield([event, noDiffReslice]);

    expect(event.learningLabel).toMatchObject({
      learningKind: 'proposal-created',
      attemptShape: {
        backendNoDiff: 0,
        captureOrGateBlocked: 0,
        repairAttempts: 1,
        policyDisabled: 0,
      },
    });
    expect(JSON.stringify(event.learningLabel)).not.toContain('Repair dispatch');
    expect(summary).toMatchObject({
      attempts: 2,
      proposalsCreated: 1,
      noProposal: 1,
      attemptShape: {
        backendNoDiff: 1,
        captureOrGateBlocked: 0,
        repairAttempts: 2,
        policyDisabled: 0,
      },
      generatedRepairAttempts: {
        attempts: 2,
        proposalsCreated: 1,
        noProposal: 1,
        proposalRate: 0.5,
        captureRepairs: 1,
        diagnosticReslices: 1,
        proposalRepairs: 0,
      },
    });
  });

  it('accounts explicit and historical cancellation separately from genuine engine failure', () => {
    const explicitCancellation = makeEvent({
      itemId: 'explicit-cancellation',
      outcome: 'cancelled' as never,
      proposalCreated: false,
      reason: 'run cancelled by owner',
      runEventSummary: {
        status: 'aborted',
        outcome: 'cancelled',
        proposalCreated: false,
      },
    });
    const historicalCancellation = makeEvent({
      itemId: 'historical-cancellation',
      outcome: 'engine-failed',
      proposalCreated: false,
      reason: 'swarm cancelled by owner',
      runEventSummary: {
        status: 'aborted',
        outcome: 'engine-failed',
        proposalCreated: false,
      },
    });
    const genuineFailure = makeEvent({
      itemId: 'genuine-engine-failure',
      outcome: 'engine-failed',
      proposalCreated: false,
      reason: 'provider request failed',
      runEventSummary: {
        status: 'aborted',
        outcome: 'engine-failed',
        proposalCreated: false,
      },
    });

    const summary = summarizeDispatchProductionYield([
      explicitCancellation,
      historicalCancellation,
      genuineFailure,
    ]);

    expect(summary?.outcomes).toEqual({
      proposalCreated: 0,
      emptyDiff: 0,
      gateBlocked: 0,
      engineFailed: 1,
      cancelled: 2,
      sandboxFailed: 0,
      proposalCaptureError: 0,
      proposalDisabled: 0,
      unknown: 0,
    });
    expect(summary).toMatchObject({
      attempts: 3,
      noProposal: 3,
      diagnosticAttempts: 1,
      diagnosticNoProposal: 0,
      diagnosticProposalRate: 0,
    });
    expect(summary?.byBackend[0]).toMatchObject({
      attempts: 3,
      noProposal: 3,
      diagnosticAttempts: 1,
      diagnosticNoProposal: 0,
      diagnosticProposalRate: 0,
      diagnosticTopReasons: [{ reason: 'provider request failed', count: 1 }],
    });
    expect(summary?.diagnosticTopReasons).toEqual([
      { reason: 'provider request failed', count: 1 },
    ]);
    expect(summary?.byBackend[0]?.outcomes).toEqual(summary?.outcomes);
    expect(summarizeDispatchProductionYield([genuineFailure])?.outcomes.cancelled).toBe(0);
  });

  it('excludes current and historical cancellation from generated-repair conversion accounting', () => {
    const generatedRepair = {
      itemId: 'ashlr-hub:proposal-repair-nodiff:123456789abc',
      title: 'Reslice no-diff dispatch for cancellation accounting',
      proposalCreated: false,
    } as const;
    const explicitCancellation = makeEvent({
      ...generatedRepair,
      runId: 'generated-repair-cancelled',
      outcome: 'cancelled' as never,
      reason: 'run cancelled by owner',
      runEventSummary: { status: 'aborted', outcome: 'cancelled', proposalCreated: false },
    });
    const historicalCancellation = makeEvent({
      ...generatedRepair,
      runId: 'generated-repair-legacy-cancelled',
      outcome: 'engine-failed',
      reason: 'best-of-2 selection cancelled by owner',
      runEventSummary: { status: 'failed', outcome: 'engine-failed', proposalCreated: false },
    });
    const genuineFailure = makeEvent({
      ...generatedRepair,
      runId: 'generated-repair-failed',
      outcome: 'engine-failed',
      reason: 'provider request failed',
      runEventSummary: { status: 'failed', outcome: 'engine-failed', proposalCreated: false },
    });

    const summary = summarizeDispatchProductionYield([
      explicitCancellation,
      historicalCancellation,
      genuineFailure,
    ]);

    expect(summary?.outcomes).toMatchObject({ cancelled: 2, engineFailed: 1 });
    expect(summary?.generatedRepairAttempts).toMatchObject({
      attempts: 1,
      proposalsCreated: 0,
      noProposal: 1,
      proposalRate: 0,
      captureRepairs: 0,
      diagnosticReslices: 1,
      proposalRepairs: 0,
    });
  });

  function treatmentEvents(ts = '2026-07-08T12:00:00.000Z'): DispatchProductionEvent[] {
    const byTreatment = new Map<string, number>();
    const events: DispatchProductionEvent[] = [];
    for (let index = 0; index < 1_000 && (
      (byTreatment.get('baseline-reslice') ?? 0) < 3 ||
      (byTreatment.get('target-localization') ?? 0) < 3
    ); index++) {
      const unitId = repairTreatmentUnitId({
        kind: 'no-diff-reslice',
        repo: '/tmp/repo',
        parentItemId: `repo:goal:treatment-${index}`,
        parentObjectiveHash: index.toString(16).padStart(64, '0'),
      })!;
      const treatment = repairTreatmentForUnitId(unitId)!;
      const armIndex = byTreatment.get(treatment) ?? 0;
      if (armIndex >= 3) continue;
      const handoffId = (index + 1_000).toString(16).padStart(64, '0');
      const itemId = `ashlr-hub:proposal-repair-nodiff:${index.toString(16).padStart(12, '0')}`;
      const runId = `run-treatment-${index}-1`;
      const converted = armIndex === 0;
      const first = makeEvent({
        ts,
        itemId,
        title: 'Reslice no-diff dispatch for treatment learning',
        runId,
        repairHandoffId: handoffId,
        repairGenerationId: repairGenerationIdFromHandoffId(handoffId)!,
        repairTreatmentUnitId: unitId,
        repairTreatment: treatment,
        repairAttemptOrdinal: 1,
        outcome: converted ? 'proposal-created' : 'empty-diff',
        proposalCreated: converted,
        ...(converted ? { proposalId: `prop-treatment-${treatment}` } : {}),
      });
      events.push(first);
      const terminal = converted
        ? first
        : makeEvent({
          ...first,
          runId: `run-treatment-${index}-2`,
          backend: 'kimi',
          repairAttemptOrdinal: 2,
          repairPreviousBackend: 'local-coder',
        });
      if (!converted) events.push(terminal);
      events.push({
        ...terminal,
        basis: 'repair-lifecycle-candidate',
        repairTreatmentAttemptHash: generatedRepairLifecycleAttemptHash(terminal.runId!),
      });
      events.push({
        ...terminal,
        basis: 'repair-lifecycle-outcome',
        repairTreatmentOutcome: converted ? 'converted' : 'not-converted',
        repairTreatmentAttemptHash: generatedRepairLifecycleAttemptHash(terminal.runId!),
      });
      byTreatment.set(treatment, armIndex + 1);
    }
    return events;
  }

  function migrationTreatmentEvent(
    template: DispatchProductionEvent,
    index: number,
    ts: string,
    fixtureId: number,
  ): DispatchProductionEvent {
    const runId = `run-treatment-migration-${fixtureId}-${index}`;
    const handoffId = (fixtureId * 100_000 + index).toString(16).padStart(64, '0');
    return sanitizeDispatchProductionEvent({
      ...template,
      ts,
      runId,
      trajectoryId: undefined,
      repairHandoffId: handoffId,
      repairGenerationId: repairGenerationIdFromHandoffId(handoffId)!,
      repairTreatmentAttemptHash: generatedRepairLifecycleAttemptHash(runId),
    }, { materializeLearningLabel: true });
  }

  function seedV1TreatmentRetentionCapacity(
    template: DispatchProductionEvent,
    droppedThrough: string,
    fixtureId: number,
  ): { receiptDir: string; retentionPath: string; retentionText: string;
    firstActive: DispatchProductionEvent; trigger: DispatchProductionEvent } {
    const root = dispatchProductionDir();
    const receiptDir = join(root, 'repair-treatment-outcomes');
    mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
    const activeBaseMs = Date.parse('2025-02-01T00:00:00.000Z');
    let firstActive: DispatchProductionEvent | undefined;
    for (let index = 0; index < 2_048; index++) {
      const event = migrationTreatmentEvent(
        template,
        index,
        new Date(activeBaseMs + index * 1_000).toISOString(),
        fixtureId,
      );
      firstActive ??= event;
      writeFileSync(
        join(receiptDir, `${event.repairGenerationId}-${event.repairTreatmentAttemptHash}.json`),
        `${JSON.stringify(event)}\n`,
        { mode: 0o600 },
      );
    }
    const retentionPath = join(receiptDir, '.retention.json');
    const retentionText = `${JSON.stringify({ schemaVersion: 1, droppedThrough })}\n`;
    writeFileSync(retentionPath, retentionText, { mode: 0o600 });
    protectWindowsFixtureTree(root);
    return {
      receiptDir,
      retentionPath,
      retentionText,
      firstActive: firstActive!,
      trigger: migrationTreatmentEvent(
        template,
        2_048,
        '2026-07-08T14:00:00.000Z',
        fixtureId,
      ),
    };
  }

  function seedCommittedCompactedTreatmentMarkers(
    events: readonly DispatchProductionEvent[],
  ): { receiptDir: string; markerDir: string; retentionPath: string;
    protocolPath: string; retention: TestTreatmentRetentionState;
    markers: Array<{ schemaVersion: 1; name: string; receiptDigest: string }> } {
    const receiptDir = join(dispatchProductionDir(), 'repair-treatment-outcomes');
    const markerDir = join(receiptDir, '.retired-exact');
    mkdirSync(markerDir, { recursive: true, mode: 0o700 });
    const markers = events.map((event) => {
      const name = `${event.repairGenerationId}-${event.repairTreatmentAttemptHash}.json`;
      return {
        schemaVersion: 1 as const,
        name,
        receiptDigest: treatmentReceiptDigestForTest(name, event),
      };
    }).sort((left, right) => left.name.localeCompare(right.name));
    expect(new Set(markers.map((marker) => marker.name)).size).toBe(markers.length);
    for (const marker of markers) {
      writeFileSync(
        join(markerDir, marker.name),
        `${JSON.stringify(marker)}\n`,
        { mode: 0o600 },
      );
    }
    const retention: TestTreatmentRetentionState = {
      schemaVersion: 3,
      droppedThrough: events.reduce((latest, event) =>
        Date.parse(event.ts) > Date.parse(latest) ? event.ts : latest, events[0]!.ts),
      retirementEpoch: 1,
      previousRetentionDigest: null,
      compactedDigest: compactedTreatmentDigestForTest(
        emptyTreatmentCompactedDigestForTest(), markers,
      ),
      compactedCount: markers.length,
      tombstones: [],
    };
    const retentionPath = join(receiptDir, '.retention.json');
    const protocolPath = join(receiptDir, '.protocol.json');
    writeFileSync(retentionPath, `${JSON.stringify(retention)}\n`, { mode: 0o600 });
    writeFileSync(protocolPath, `${JSON.stringify({
      schemaVersion: 1,
      retirementEpoch: retention.retirementEpoch,
      retentionDigest: treatmentRetentionDigestForTest(retention),
    })}\n`, { mode: 0o600 });
    protectWindowsFixtureTree(dispatchProductionDir());
    return { receiptDir, markerDir, retentionPath, protocolPath, retention, markers };
  }

  it('atomically upgrades v1 raw treatment retirements to exact v3 authority', () => {
    const template = treatmentEvents('2025-01-01T00:00:00.000Z').find((event) =>
      event.basis === 'repair-lifecycle-outcome')!;
    const retired = migrationTreatmentEvent(template, 10_000, template.ts, 1);
    const fixture = seedV1TreatmentRetentionCapacity(template, retired.ts, 1);
    const rawPath = join(dispatchProductionDir(), '2025-01-01.jsonl');
    writeFileSync(rawPath, `${JSON.stringify(retired)}\n`, { mode: 0o600 });

    expect(hasExactDispatchProductionTreatmentOutcomeReceipt(retired)).toBe(true);
    expect(recordDispatchProduction(fixture.trigger))
      .toEqual({ attempted: 1, recorded: 1, failed: 0 });
    const retention = JSON.parse(readFileSync(fixture.retentionPath, 'utf8')) as
      TestTreatmentRetentionState;
    const retiredName = `${retired.repairGenerationId}-${retired.repairTreatmentAttemptHash}.json`;
    expect(retention).toMatchObject({
      schemaVersion: 3,
      retirementEpoch: 1,
      tombstones: expect.arrayContaining([{
        name: retiredName,
        receiptDigest: treatmentReceiptDigestForTest(retiredName, retired),
      }]),
    });

    rmSync(rawPath);
    expect(hasExactDispatchProductionTreatmentOutcomeReceipt(retired)).toBe(true);
    const stableRetention = readFileSync(fixture.retentionPath, 'utf8');
    expect(recordDispatchProduction(retired)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(readFileSync(fixture.retentionPath, 'utf8')).toBe(stableRetention);
    expect(recordDispatchProduction({
      ...retired,
      routeReason: 'conflicting replay after exact v1 cutover',
    })).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(hasExactDispatchProductionTreatmentOutcomeReceipt(retired)).toBe(true);
  });

  it(
    'leaves v1 bytes untouched when legacy raw history is unavailable, oversized, or conflicting',
    () => {
      const template = treatmentEvents('2025-01-01T00:00:00.000Z').find((event) =>
        event.basis === 'repair-lifecycle-outcome')!;
      const retired = migrationTreatmentEvent(template, 10_000, template.ts, 2);
      const fixture = seedV1TreatmentRetentionCapacity(template, retired.ts, 2);
      const rawPath = join(dispatchProductionDir(), '2025-01-01.jsonl');

      expect(recordDispatchProduction(fixture.trigger))
        .toEqual({ attempted: 1, recorded: 0, failed: 1 });
      expect(readFileSync(fixture.retentionPath, 'utf8')).toBe(fixture.retentionText);
      expect(existsSync(join(fixture.receiptDir, '.protocol.json'))).toBe(false);

      writeFileSync(rawPath, `${JSON.stringify(retired)}\n`, { mode: 0o600 });
      truncateSync(rawPath, 33 * 1024 * 1024);
      expect(recordDispatchProduction(fixture.trigger))
        .toEqual({ attempted: 1, recorded: 0, failed: 1 });
      expect(readFileSync(fixture.retentionPath, 'utf8')).toBe(fixture.retentionText);
      expect(existsSync(join(fixture.receiptDir, '.protocol.json'))).toBe(false);

      const conflict = sanitizeDispatchProductionEvent({
        ...retired,
        routeReason: 'conflicting legacy raw treatment semantics',
      }, { materializeLearningLabel: true });
      writeFileSync(
        rawPath,
        `${JSON.stringify(retired)}\n${JSON.stringify(conflict)}\n`,
        { mode: 0o600 },
      );
      expect(recordDispatchProduction(fixture.trigger))
        .toEqual({ attempted: 1, recorded: 0, failed: 1 });
      expect(readFileSync(fixture.retentionPath, 'utf8')).toBe(fixture.retentionText);
      expect(existsSync(join(fixture.receiptDir, '.protocol.json'))).toBe(false);
    },
    120_000,
  );

  it.skipIf(process.platform === 'win32')(
    'idempotently resumes v1 migration after exact compact markers are published',
    () => {
      const template = treatmentEvents('2025-01-01T00:00:00.000Z').find((event) =>
        event.basis === 'repair-lifecycle-outcome')!;
      const retired = Array.from({ length: 2_049 }, (_, index) =>
        migrationTreatmentEvent(
          template,
          10_000 + index,
          new Date(Date.parse(template.ts) + index * 1_000).toISOString(),
          3,
        ));
      const cutoff = retired.at(-1)!.ts;
      const fixture = seedV1TreatmentRetentionCapacity(template, cutoff, 3);
      const rawPath = join(dispatchProductionDir(), '2025-01-01.jsonl');
      writeFileSync(
        rawPath,
        retired.map((event) => `${JSON.stringify(event)}\n`).join(''),
        { mode: 0o600 },
      );
      let markerPublications = 0;
      _setDispatchProductionLedgerRetentionHooksForTest({
        afterTreatmentCompactedMarkers: () => {
          markerPublications++;
          if (markerPublications === 1) throw new Error('simulated treatment migration crash');
        },
      });

      expect(recordDispatchProduction(fixture.trigger))
        .toEqual({ attempted: 1, recorded: 0, failed: 1 });
      expect(readFileSync(fixture.retentionPath, 'utf8')).toBe(fixture.retentionText);
      const markerDir = join(fixture.receiptDir, '.retired-exact');
      expect(readdirSync(markerDir)).toHaveLength(2_049);

      expect(recordDispatchProduction(fixture.trigger))
        .toEqual({ attempted: 1, recorded: 1, failed: 0 });
      const retention = JSON.parse(readFileSync(fixture.retentionPath, 'utf8')) as
        TestTreatmentRetentionState;
      expect(retention).toMatchObject({
        schemaVersion: 3,
        retirementEpoch: 1,
        compactedCount: 2_049,
      });
      expect(markerPublications).toBe(2);
      const stableRetention = readFileSync(fixture.retentionPath, 'utf8');
      rmSync(rawPath);
      expect(hasExactDispatchProductionTreatmentOutcomeReceipt(retired[0]!)).toBe(true);
      expect(recordDispatchProduction(fixture.trigger))
        .toEqual({ attempted: 1, recorded: 1, failed: 0 });
      expect(readFileSync(fixture.retentionPath, 'utf8')).toBe(stableRetention);
      expect(readdirSync(markerDir)).toHaveLength(2_049);
    },
    120_000,
  );

  it.each([
    { mutation: 'deletion' as const },
    { mutation: 'shrink' as const },
  ])(
    'rejects orphan compact markers after legacy raw $mutation with authority bytes unchanged',
    ({ mutation }) => {
      const template = treatmentEvents('2025-01-01T00:00:00.000Z').find((event) =>
        event.basis === 'repair-lifecycle-outcome')!;
      const retired = Array.from({ length: 2_049 }, (_, offset) => migrationTreatmentEvent(
        template,
        30_000 + offset,
        new Date(Date.parse(template.ts) + offset * 1_000).toISOString(),
        mutation === 'deletion' ? 30 : 31,
      ));
      const fixture = seedV1TreatmentRetentionCapacity(
        template, retired.at(-1)!.ts, mutation === 'deletion' ? 30 : 31,
      );
      const rawPath = join(dispatchProductionDir(), '2025-01-01.jsonl');
      writeFileSync(
        rawPath,
        retired.map((event) => `${JSON.stringify(event)}\n`).join(''),
        { mode: 0o600 },
      );
      _setDispatchProductionLedgerRetentionHooksForTest({
        afterTreatmentCompactedMarkers: () => {
          throw new Error('simulated pre-retention-install crash');
        },
      });

      expect(recordDispatchProduction(fixture.trigger))
        .toEqual({ attempted: 1, recorded: 0, failed: 1 });
      _setDispatchProductionLedgerRetentionHooksForTest(undefined);
      const markerDir = join(fixture.receiptDir, '.retired-exact');
      expect(readdirSync(markerDir)).toHaveLength(2_049);
      const authorityPaths = [
        fixture.retentionPath,
        join(fixture.receiptDir, '.protocol.json'),
        ...readdirSync(markerDir).sort().map((name) => join(markerDir, name)),
      ];
      const authorityBytes = authorityPaths.map((path) => readFileSync(path, 'utf8'));
      if (mutation === 'deletion') rmSync(rawPath);
      else writeFileSync(rawPath, `${JSON.stringify(retired[0])}\n`, { mode: 0o600 });

      expect(hasExactDispatchProductionTreatmentOutcomeReceipt(retired[0]!)).toBe(false);
      expect(recordDispatchProduction(fixture.trigger))
        .toEqual({ attempted: 1, recorded: 0, failed: 1 });
      expect(authorityPaths.map((path) => readFileSync(path, 'utf8'))).toEqual(authorityBytes);
      expect(readFileSync(fixture.retentionPath, 'utf8')).toBe(fixture.retentionText);
      expect(readdirSync(markerDir)).toHaveLength(2_049);
    },
    120_000,
  );

  it('rejects an extra compact marker outside the committed aggregate', () => {
    const template = treatmentEvents().find((event) => event.basis === 'repair-lifecycle-outcome')!;
    const committed = migrationTreatmentEvent(template, 40_000, template.ts, 40);
    const extra = migrationTreatmentEvent(
      template, 40_001, new Date(Date.parse(template.ts) + 1_000).toISOString(), 40,
    );
    const fixture = seedCommittedCompactedTreatmentMarkers([committed]);
    const extraName = `${extra.repairGenerationId}-${extra.repairTreatmentAttemptHash}.json`;
    writeFileSync(join(fixture.markerDir, extraName), `${JSON.stringify({
      schemaVersion: 1,
      name: extraName,
      receiptDigest: treatmentReceiptDigestForTest(extraName, extra),
    })}\n`, { mode: 0o600 });
    protectWindowsFixtureTree(fixture.markerDir);

    expect(hasExactDispatchProductionTreatmentOutcomeReceipt(committed)).toBe(false);
    expect(readDispatchProductionEventsDetailed()).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      unreadableFiles: 1,
    });
  });

  it('rejects a missing compact marker from the committed aggregate', () => {
    const template = treatmentEvents().find((event) => event.basis === 'repair-lifecycle-outcome')!;
    const events = [0, 1].map((offset) => migrationTreatmentEvent(
      template,
      41_000 + offset,
      new Date(Date.parse(template.ts) + offset * 1_000).toISOString(),
      41,
    ));
    const fixture = seedCommittedCompactedTreatmentMarkers(events);
    rmSync(join(fixture.markerDir, fixture.markers[1]!.name));

    expect(hasExactDispatchProductionTreatmentOutcomeReceipt(events[0]!)).toBe(false);
    expect(recordDispatchProduction(events[0]!))
      .toEqual({ attempted: 1, recorded: 0, failed: 1 });
  });

  it('rejects a protocol-bound retention aggregate that does not match its compact markers', () => {
    const template = treatmentEvents().find((event) => event.basis === 'repair-lifecycle-outcome')!;
    const event = migrationTreatmentEvent(template, 42_000, template.ts, 42);
    const fixture = seedCommittedCompactedTreatmentMarkers([event]);
    const mismatched = { ...fixture.retention, compactedDigest: 'f'.repeat(64) };
    writeFileSync(fixture.retentionPath, `${JSON.stringify(mismatched)}\n`, { mode: 0o600 });
    writeFileSync(fixture.protocolPath, `${JSON.stringify({
      schemaVersion: 1,
      retirementEpoch: mismatched.retirementEpoch,
      retentionDigest: treatmentRetentionDigestForTest(mismatched),
    })}\n`, { mode: 0o600 });
    protectWindowsFixtureTree(fixture.receiptDir);

    expect(hasExactDispatchProductionTreatmentOutcomeReceipt(event)).toBe(false);
    expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
  });

  it('rejects a compact marker mutated during exact set validation', () => {
    const template = treatmentEvents().find((event) => event.basis === 'repair-lifecycle-outcome')!;
    const event = migrationTreatmentEvent(template, 43_000, template.ts, 43);
    const fixture = seedCommittedCompactedTreatmentMarkers([event]);
    let mutated = false;
    _setDispatchProductionLedgerRetentionHooksForTest({
      assureStableRegularFiles: (paths, anchorPath) => {
        const assurance = assureStableRegularFiles(paths, anchorPath);
        if (!mutated && assurance.ok && paths.every((path) => dirname(path) === fixture.markerDir)) {
          mutated = true;
          const marker = fixture.markers[0]!;
          writeFileSync(join(fixture.markerDir, marker.name), `${JSON.stringify({
            ...marker,
            receiptDigest: 'e'.repeat(64),
          })}\n`, { mode: 0o600 });
          protectWindowsFixtureTree(fixture.markerDir);
        }
        return assurance;
      },
    });

    expect(hasExactDispatchProductionTreatmentOutcomeReceipt(event)).toBe(false);
    expect(mutated).toBe(true);
  });

  it(
    'validates a committed 2,049-marker lookup in bounded assurance batches',
    () => {
      const template = treatmentEvents('2025-01-01T00:00:00.000Z').find((event) =>
        event.basis === 'repair-lifecycle-outcome')!;
      const events = Array.from({ length: 2_049 }, (_, index) => migrationTreatmentEvent(
        template,
        50_000 + index,
        new Date(Date.parse(template.ts) + index * 1_000).toISOString(),
        50,
      ));
      const fixture = seedCommittedCompactedTreatmentMarkers(events);
      let markerBatchCalls = 0;
      _setDispatchProductionLedgerRetentionHooksForTest({
        assureStableRegularFiles: (paths, anchorPath) => {
          if (paths.every((path) => dirname(path) === fixture.markerDir)) markerBatchCalls++;
          return assureStableRegularFiles(paths, anchorPath);
        },
      });

      expect(hasExactDispatchProductionTreatmentOutcomeReceipt(events[1_024]!)).toBe(true);
      expect(markerBatchCalls).toBe(5);
    },
    120_000,
  );

  it('rejects every writer through a linked dispatch-production root and leaves the target untouched', () => {
    const root = dispatchProductionDir();
    expect(recordDispatchProduction(makeEvent({ itemId: 'physical-root-seed' })))
      .toEqual({ attempted: 1, recorded: 1, failed: 0 });
    renameSync(root, join(home, 'replaced-dispatch-production'));
    const outside = join(home, 'linked-dispatch-target');
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(
      outside,
      root,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const treatment = treatmentEvents().find((event) =>
      event.basis === 'repair-lifecycle-outcome')!;

    expect(recordDispatchProduction([
      makeEvent({ itemId: 'linked-root-ledger' }),
      makeProofEvent({ runId: 'linked-root-protocol' }),
      treatment,
    ])).toEqual({ attempted: 3, recorded: 0, failed: 3 });
    expect(readdirSync(outside)).toEqual([]);
    expect(hasExactDispatchProductionTreatmentOutcomeReceipt(treatment)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'deterministically rolls 2,048 retired outcomes into bounded authenticated compaction',
    () => {
    const receiptDir = join(dispatchProductionDir(), 'repair-treatment-outcomes');
    const baseMs = Date.parse('2025-01-01T00:00:00.000Z');
    const template = treatmentEvents(new Date(baseMs).toISOString()).find((event) =>
      event.basis === 'repair-lifecycle-outcome')!;
    const fixture = (index: number): DispatchProductionEvent => {
      const runId = `run-treatment-cap-${index}`;
      const handoffId = (200_000 + index).toString(16).padStart(64, '0');
      return sanitizeDispatchProductionEvent({
        ...template,
        ts: new Date(baseMs + index * 1_000).toISOString(),
        runId,
        trajectoryId: undefined,
        repairHandoffId: handoffId,
        repairGenerationId: repairGenerationIdFromHandoffId(handoffId)!,
        repairTreatmentAttemptHash: generatedRepairLifecycleAttemptHash(runId),
      }, { materializeLearningLabel: true });
    };
    const first = fixture(0);
    expect(first).toMatchObject({
      basis: 'repair-lifecycle-outcome',
      repairTreatmentOutcome: template.repairTreatmentOutcome,
      repairTreatmentAttemptHash: generatedRepairLifecycleAttemptHash('run-treatment-cap-0'),
    });
    expect(recordDispatchProduction(first)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(existsSync(receiptDir)).toBe(true);
    for (let index = 1; index < 2_048; index++) {
      const event = fixture(index);
      writeFileSync(
        join(receiptDir, `${event.repairGenerationId}-${event.repairTreatmentAttemptHash}.json`),
        `${JSON.stringify(event)}\n`,
        { mode: 0o600 },
      );
    }
    const firstName = `${first.repairGenerationId}-${first.repairTreatmentAttemptHash}.json`;
    const firstPath = join(receiptDir, firstName);
    expect(existsSync(firstPath)).toBe(true);
    expect(hasExactDispatchProductionTreatmentOutcomeReceipt(first)).toBe(true);
    const rawPartition = join(dispatchProductionDir(), '2025-01-01.jsonl');
    writeFileSync(rawPartition, 'oversized retired analytics history\n', { mode: 0o600 });
    truncateSync(rawPartition, 33 * 1024 * 1024);
    const rawDigest = createHash('sha256').update(readFileSync(rawPartition)).digest('hex');

    const next = fixture(2_048);
    let treatmentBatchCalls = 0;
    _setDispatchProductionLedgerRetentionHooksForTest({
      assureStableRegularFiles: (paths, anchorPath) => {
        treatmentBatchCalls++;
        return assureStableRegularFiles(paths, anchorPath);
      },
    });
    expect(recordDispatchProduction(next)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(treatmentBatchCalls).toBe(5);
    _setDispatchProductionLedgerRetentionHooksForTest(undefined);
    expect(readdirSync(receiptDir).filter((name) =>
      /^[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(name))).toHaveLength(2_048);
    expect(existsSync(firstPath)).toBe(false);
    expect(hasExactDispatchProductionTreatmentOutcomeReceipt(first)).toBe(true);
    expect(hasExactDispatchProductionTreatmentOutcomeReceipt({
      ...first,
      routeReason: 'conflicting retired receipt semantics',
    })).toBe(false);

    const retentionPath = join(receiptDir, '.retention.json');
    const retained = JSON.parse(readFileSync(retentionPath, 'utf8')) as {
      schemaVersion: number;
      retirementEpoch: number;
      droppedThrough: string;
      tombstones: Array<{ name: string; receiptDigest: string }>;
    };
    expect(retained).toMatchObject({
      schemaVersion: 3,
      retirementEpoch: 1,
      droppedThrough: first.ts,
      tombstones: [{ name: firstName }],
    });

    const retired = Array.from({ length: 2_048 }, (_, offset) => fixture(offset - 2_047));
    const tombstones = retired.map((event) => {
      const name = `${event.repairGenerationId}-${event.repairTreatmentAttemptHash}.json`;
      return { name, receiptDigest: treatmentReceiptDigestForTest(name, event) };
    }).sort((left, right) => left.name.localeCompare(right.name));
    const fullRetentionText = `${JSON.stringify({
      schemaVersion: 2,
      droppedThrough: first.ts,
      retirementEpoch: 2_048,
      tombstones,
    })}\n`;
    expect(Buffer.byteLength(fullRetentionText)).toBeGreaterThan(4_096);
    expect(Buffer.byteLength(fullRetentionText)).toBeLessThanOrEqual(512 * 1024);
    rmSync(join(receiptDir, '.protocol.json'));
    writeFileSync(retentionPath, fullRetentionText, { mode: 0o600 });

    const oldest = retired[0]!;
    expect(hasExactDispatchProductionTreatmentOutcomeReceipt(first)).toBe(true);
    expect(hasExactDispatchProductionTreatmentOutcomeReceipt(oldest)).toBe(true);
    expect(hasExactDispatchProductionTreatmentOutcomeReceipt({
      ...oldest,
      routeReason: 'conflicting oldest retired receipt semantics',
    })).toBe(false);

    const rolled = fixture(2_049);
    const rolledPath = join(
      receiptDir,
      `${rolled.repairGenerationId}-${rolled.repairTreatmentAttemptHash}.json`,
    );
    expect(recordDispatchProduction(rolled)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(readdirSync(receiptDir).filter((name) =>
      /^[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(name))).toHaveLength(2_048);
    expect(existsSync(rolledPath)).toBe(true);
    const rotated = JSON.parse(readFileSync(retentionPath, 'utf8')) as TestTreatmentRetentionState;
    const newlyRetired = fixture(1);
    const newlyRetiredName = `${newlyRetired.repairGenerationId}-${newlyRetired.repairTreatmentAttemptHash}.json`;
    expect(rotated).toMatchObject({
      schemaVersion: 3,
      retirementEpoch: 2_049,
      droppedThrough: newlyRetired.ts,
      compactedCount: 2_048,
      tombstones: [{
        name: newlyRetiredName,
        receiptDigest: treatmentReceiptDigestForTest(newlyRetiredName, newlyRetired),
      }],
    });
    expect(rotated.compactedDigest).toBe(compactedTreatmentDigestForTest(
      emptyTreatmentCompactedDigestForTest(), tombstones,
    ));
    expect(existsSync(rawPartition)).toBe(true);
    expect(createHash('sha256').update(readFileSync(rawPartition)).digest('hex')).toBe(rawDigest);
    expect(hasExactDispatchProductionTreatmentOutcomeReceipt(first)).toBe(true);
    expect(hasExactDispatchProductionTreatmentOutcomeReceipt(oldest)).toBe(true);
    expect(hasExactDispatchProductionTreatmentOutcomeReceipt(newlyRetired)).toBe(true);
    expect(hasExactDispatchProductionTreatmentOutcomeReceipt(next)).toBe(true);
    expect(hasExactDispatchProductionTreatmentOutcomeReceipt(rolled)).toBe(true);

    const laterConflictingReplay = {
      ...first,
      ts: '2026-07-08T15:00:00.000Z',
      routeReason: 'later conflicting compacted treatment semantics',
    };
    expect(recordDispatchProduction(laterConflictingReplay))
      .toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(existsSync(firstPath)).toBe(false);
    expect(hasExactDispatchProductionTreatmentOutcomeReceipt(laterConflictingReplay)).toBe(false);
    expect(hasExactDispatchProductionTreatmentOutcomeReceipt(first)).toBe(true);
    expect(recordDispatchProduction({
      ...oldest,
      ts: '2026-07-08T15:01:00.000Z',
      routeReason: 'later conflicting oldest compacted treatment semantics',
    })).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(hasExactDispatchProductionTreatmentOutcomeReceipt(oldest)).toBe(true);

    writeFileSync(retentionPath, `${JSON.stringify({
      schemaVersion: 1,
      droppedThrough: retained.droppedThrough,
    })}\n`, { mode: 0o600 });
    expect(hasExactDispatchProductionTreatmentOutcomeReceipt(first)).toBe(false);
    expect(recordDispatchProduction(first)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(existsSync(firstPath)).toBe(false);

    writeFileSync(retentionPath, '{corrupt-retention}\n', { mode: 0o600 });
    expect(hasExactDispatchProductionTreatmentOutcomeReceipt(next)).toBe(false);
    expect(recordDispatchProduction(next)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    },
    120_000,
  );

  it('rejects a restored retired receipt paired with an older retention marker', () => {
    const witness = treatmentEvents().find((event) => event.basis === 'repair-lifecycle-outcome')!;
    expect(recordDispatchProduction(witness)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    const receiptDir = join(dispatchProductionDir(), 'repair-treatment-outcomes');
    const name = `${witness.repairGenerationId}-${witness.repairTreatmentAttemptHash}.json`;
    const receiptPath = join(receiptDir, name);
    const receiptText = readFileSync(receiptPath, 'utf8');
    const tombstone = { name, receiptDigest: treatmentReceiptDigestForTest(name, witness) };
    const older: TestTreatmentRetentionState = {
      schemaVersion: 3,
      droppedThrough: witness.ts,
      retirementEpoch: 1,
      previousRetentionDigest: null,
      compactedDigest: emptyTreatmentCompactedDigestForTest(),
      compactedCount: 0,
      tombstones: [tombstone],
    };
    const newer: TestTreatmentRetentionState = {
      ...older,
      droppedThrough: new Date(Date.parse(witness.ts) + 1_000).toISOString(),
      retirementEpoch: 2,
      previousRetentionDigest: treatmentRetentionDigestForTest(older),
    };
    const retentionPath = join(receiptDir, '.retention.json');
    const protocolPath = join(receiptDir, '.protocol.json');
    writeFileSync(retentionPath, `${JSON.stringify(newer)}\n`, { mode: 0o600 });
    writeFileSync(protocolPath, `${JSON.stringify({
      schemaVersion: 1,
      retirementEpoch: newer.retirementEpoch,
      retentionDigest: treatmentRetentionDigestForTest(newer),
    })}\n`, { mode: 0o600 });
    rmSync(receiptPath);
    writeFileSync(receiptPath, receiptText, { mode: 0o600 });
    writeFileSync(retentionPath, `${JSON.stringify(older)}\n`, { mode: 0o600 });
    protectWindowsFixtureTree(receiptDir);

    expect(hasExactDispatchProductionTreatmentOutcomeReceipt(witness)).toBe(false);
    expect(readDispatchProductionEventsDetailed()).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      unreadableFiles: 1,
      events: [],
    });
    expect(recordDispatchProduction(witness)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    expect(readFileSync(retentionPath, 'utf8')).toBe(`${JSON.stringify(older)}\n`);
    expect(existsSync(receiptPath)).toBe(true);
  });

  it('suppresses restored cross-date raw treatment conflicts after exact tombstones rotate', () => {
    const template = treatmentEvents('2026-07-07T23:59:59.000Z').find((event) =>
      event.basis === 'repair-lifecycle-outcome')!;
    const first = sanitizeDispatchProductionEvent(template, { materializeLearningLabel: true });
    const second = sanitizeDispatchProductionEvent({
      ...template,
      ts: '2026-07-08T00:00:01.000Z',
      routeReason: 'conflicting restored raw semantics on another UTC date',
    }, { materializeLearningLabel: true });
    mkdirSync(dispatchProductionDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(dispatchProductionDir(), '2026-07-07.jsonl'), `${JSON.stringify(first)}\n`, { mode: 0o600 });
    writeFileSync(join(dispatchProductionDir(), '2026-07-08.jsonl'), `${JSON.stringify(second)}\n`, { mode: 0o600 });
    const receiptDir = join(dispatchProductionDir(), 'repair-treatment-outcomes');
    mkdirSync(receiptDir, { mode: 0o700 });
    const retention: TestTreatmentRetentionState = {
      schemaVersion: 3,
      droppedThrough: second.ts,
      retirementEpoch: 2,
      previousRetentionDigest: null,
      compactedDigest: 'd'.repeat(64),
      compactedCount: 2_048,
      tombstones: [],
    };
    writeFileSync(join(receiptDir, '.retention.json'), `${JSON.stringify(retention)}\n`, { mode: 0o600 });
    writeFileSync(join(receiptDir, '.protocol.json'), `${JSON.stringify({
      schemaVersion: 1,
      retirementEpoch: retention.retirementEpoch,
      retentionDigest: treatmentRetentionDigestForTest(retention),
    })}\n`, { mode: 0o600 });
    protectWindowsFixtureTree(receiptDir);

    const read = readDispatchProductionEventsDetailed();
    expect(read).toMatchObject({ sourceState: 'degraded', complete: false });
    expect(read.events.filter((event) => event.basis === 'repair-lifecycle-outcome')).toEqual([]);
    expect(summarizeDispatchProductionYield(read.events)?.generatedRepairAttempts).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')(
    'rejects maximum canonical treatment receipts before aggregate compaction allocation',
    () => {
      const receiptDir = join(dispatchProductionDir(), 'repair-treatment-outcomes');
      const baseMs = Date.parse('2025-02-01T00:00:00.000Z');
      const template = treatmentEvents(new Date(baseMs).toISOString()).find((event) =>
        event.basis === 'repair-lifecycle-outcome')!;
      let aggregateBytes = 0;
      const fixture = (index: number): DispatchProductionEvent => {
        const runId = `run-treatment-allocation-${index}`;
        const handoffId = (500_000 + index).toString(16).padStart(64, '0');
        return sanitizeDispatchProductionEvent({
          ...template,
          ts: new Date(baseMs + index * 1_000).toISOString(),
          machineId: 'm'.repeat(120),
          itemId: `${'i'.repeat(180)}:proposal-repair-nodiff:${index.toString(16).padStart(12, '0')}`,
          title: 't'.repeat(160),
          model: 'q'.repeat(160),
          assignedBy: 'a'.repeat(80),
          routeReason: 'r'.repeat(240),
          reason: 'f'.repeat(240),
          runId,
          trajectoryId: undefined,
          repairHandoffId: handoffId,
          repairGenerationId: repairGenerationIdFromHandoffId(handoffId)!,
          repairTreatmentAttemptHash: generatedRepairLifecycleAttemptHash(runId),
        }, { materializeLearningLabel: true });
      };
      const seed = fixture(0);
      expect(recordDispatchProduction(seed)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
      for (let index = 1; index < 2_048; index++) {
        const event = fixture(index);
        const text = `${JSON.stringify(event)}\n`;
        aggregateBytes += Buffer.byteLength(text);
        writeFileSync(
          join(receiptDir, `${event.repairGenerationId}-${event.repairTreatmentAttemptHash}.json`),
          text,
          { mode: 0o600 },
        );
      }
      aggregateBytes += Buffer.byteLength(`${JSON.stringify(seed)}\n`);
      expect(aggregateBytes).toBeGreaterThan(4 * 1024 * 1024);

      const next = fixture(2_048);
      expect(recordDispatchProduction(next)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
      expect(readdirSync(receiptDir).filter((name) =>
        /^[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(name))).toHaveLength(2_048);
      expect(existsSync(join(receiptDir, '.retention.json'))).toBe(false);
    },
    120_000,
  );

  it('requires terminal lifecycle witnesses, sample-gates distinct units, and withholds replayed data', () => {
    const events = treatmentEvents();
    const raw = events.find((event) => event.repairTreatmentOutcome === undefined)!;
    const replay = { ...raw, runId: 'replayed-execution' };
    const lastUnit = events.at(-1)!.repairTreatmentUnitId;

    expect(summarizeDispatchProductionYield(events.filter((event) => event.repairTreatmentUnitId !== lastUnit))?.generatedRepairAttempts)
      .not.toHaveProperty('treatmentConversions');
    const generated = summarizeDispatchProductionYield(events)?.generatedRepairAttempts;
    expect(generated?.treatmentAttribution).toEqual({
      eligibleEvents: 10,
      attributedEvents: 10,
      unattributedEvents: 0,
      distinctUnits: 6,
      replayedEvents: 0,
      minimumTerminalUnitsPerArm: 3,
      arms: [
        { repairTreatment: 'baseline-reslice', attributedUnits: 3, terminalUnits: 3, remaining: 0 },
        { repairTreatment: 'target-localization', attributedUnits: 3, terminalUnits: 3, remaining: 0 },
      ],
      gate: 'ready',
      blockers: [],
    });
    expect(generated?.treatmentConversions).toEqual([
      { repairTreatment: 'baseline-reslice', attempts: 3, proposalsCreated: 1, noProposal: 2, proposalRate: 1 / 3 },
      { repairTreatment: 'target-localization', attempts: 3, proposalsCreated: 1, noProposal: 2, proposalRate: 1 / 3 },
    ]);
    const terminalWitness = events.find((event) => event.repairTreatmentOutcome !== undefined)!;
    const active = summarizeDispatchProductionYield(events.filter((event) => event !== terminalWitness))?.generatedRepairAttempts;
    expect(active?.treatmentAttribution).toMatchObject({
      gate: 'collecting',
      blockers: ['in-flight'],
      arms: expect.arrayContaining([
        expect.objectContaining({
          repairTreatment: terminalWitness.repairTreatment,
          attributedUnits: 3,
          terminalUnits: 2,
          remaining: 1,
        }),
      ]),
    });
    expect(active).not.toHaveProperty('treatmentConversions');
    const mismatched = summarizeDispatchProductionYield(events.map((event) =>
      event === terminalWitness ? { ...event, repairTreatmentAttemptHash: 'f'.repeat(64) } : event
    ))?.generatedRepairAttempts;
    expect(mismatched?.treatmentAttribution).toMatchObject({
      gate: 'withheld',
      blockers: ['in-flight', 'unattributed'],
      arms: expect.arrayContaining([
        expect.objectContaining({
          repairTreatment: terminalWitness.repairTreatment,
          attributedUnits: 3,
          terminalUnits: 2,
          remaining: 1,
        }),
      ]),
    });
    expect(mismatched).not.toHaveProperty('treatmentConversions');
    const duplicateWitness = summarizeDispatchProductionYield([...events, terminalWitness])?.generatedRepairAttempts;
    expect(duplicateWitness?.treatmentAttribution).toMatchObject({
      gate: 'withheld',
      blockers: ['in-flight', 'unmatched-terminal', 'replayed'],
      arms: expect.arrayContaining([
        expect.objectContaining({
          repairTreatment: terminalWitness.repairTreatment,
          attributedUnits: 3,
          terminalUnits: 2,
          remaining: 1,
        }),
      ]),
    });
    expect(duplicateWitness).not.toHaveProperty('treatmentConversions');
    const replayed = summarizeDispatchProductionYield([...events, replay])?.generatedRepairAttempts;
    expect(replayed?.treatmentAttribution?.replayedEvents).toBe(1);
    expect(replayed).not.toHaveProperty('treatmentConversions');
  });

  it('does not let cancelled repair executions contaminate treatment conversions', () => {
    const events = treatmentEvents();
    const raw = events.find((event) =>
      event.repairTreatmentOutcome === undefined &&
      event.basis !== 'repair-lifecycle-candidate'
    )!;
    const explicitCancellation = {
      ...raw,
      runId: 'cancelled-treatment-execution',
      outcome: 'cancelled' as never,
      proposalCreated: false,
      proposalId: undefined,
      runEventSummary: { status: 'aborted', outcome: 'cancelled', proposalCreated: false },
    };
    const historicalCancellation = {
      ...raw,
      runId: 'legacy-cancelled-treatment-execution',
      outcome: 'engine-failed' as const,
      proposalCreated: false,
      proposalId: undefined,
      reason: 'run cancelled by owner',
      runEventSummary: { status: 'aborted', outcome: 'engine-failed', proposalCreated: false },
    };

    const generated = summarizeDispatchProductionYield([
      ...events,
      explicitCancellation,
      historicalCancellation,
    ])?.generatedRepairAttempts;

    expect(generated?.treatmentAttribution).toMatchObject({
      eligibleEvents: 10,
      attributedEvents: 10,
      replayedEvents: 0,
      gate: 'ready',
      blockers: [],
    });
    expect(generated?.treatmentConversions).toEqual([
      { repairTreatment: 'baseline-reslice', attempts: 3, proposalsCreated: 1, noProposal: 2, proposalRate: 1 / 3 },
      { repairTreatment: 'target-localization', attempts: 3, proposalsCreated: 1, noProposal: 2, proposalRate: 1 / 3 },
    ]);
  });

  it('reports sorted per-arm terminal progress for imbalanced treatment samples', () => {
    const events = treatmentEvents();
    const targetUnits = [...new Set(events
      .filter((event) => event.repairTreatment === 'target-localization')
      .map((event) => event.repairTreatmentUnitId))];
    const summary = summarizeDispatchProductionYield(events.filter((event) =>
      event.repairTreatmentUnitId !== targetUnits.at(-1)
    ))?.generatedRepairAttempts?.treatmentAttribution;

    expect(summary).toMatchObject({
      minimumTerminalUnitsPerArm: 3,
      gate: 'collecting',
      blockers: [],
      arms: [
        { repairTreatment: 'baseline-reslice', attributedUnits: 3, terminalUnits: 3, remaining: 0 },
        { repairTreatment: 'target-localization', attributedUnits: 2, terminalUnits: 2, remaining: 1 },
      ],
    });
  });

  it('keeps an otherwise sufficient sample collecting while an extra unit is in flight', () => {
    const events = treatmentEvents();
    const raw = events.find((event) =>
      event.repairTreatment === 'baseline-reslice' &&
      event.basis !== 'repair-lifecycle-candidate' &&
      event.basis !== 'repair-lifecycle-outcome'
    )!;
    const extraUnitId = repairTreatmentUnitId({
      kind: 'no-diff-reslice',
      repo: '/tmp/repo',
      parentItemId: 'repo:goal:extra-in-flight',
      parentObjectiveHash: 'f'.repeat(64),
    })!;
    const extra = {
      ...raw,
      itemId: 'ashlr-hub:proposal-repair-nodiff:eeeeeeeeeeee',
      runId: 'run-extra-in-flight',
      repairTreatmentUnitId: extraUnitId,
      repairTreatment: repairTreatmentForUnitId(extraUnitId)!,
    };
    const generated = summarizeDispatchProductionYield([...events, extra])?.generatedRepairAttempts;

    expect(generated?.treatmentAttribution).toMatchObject({
      gate: 'collecting',
      blockers: ['in-flight'],
      arms: expect.arrayContaining([
        expect.objectContaining({
          repairTreatment: extra.repairTreatment,
          attributedUnits: 4,
          terminalUnits: 3,
          remaining: 0,
        }),
      ]),
    });
    expect(generated).not.toHaveProperty('treatmentConversions');
  });

  it('withholds a ready-looking sample when an extra terminal witness has no raw execution', () => {
    const events = treatmentEvents();
    const terminal = events.find((event) => event.basis === 'repair-lifecycle-outcome')!;
    const extraUnitId = repairTreatmentUnitId({
      kind: 'no-diff-reslice',
      repo: '/tmp/repo',
      parentItemId: 'repo:goal:terminal-only',
      parentObjectiveHash: 'e'.repeat(64),
    })!;
    const terminalOnly = {
      ...terminal,
      itemId: 'ashlr-hub:proposal-repair-nodiff:abababababab',
      runId: 'run-terminal-only',
      trajectoryId: 'trajectory-terminal-only',
      repairTreatmentUnitId: extraUnitId,
      repairTreatment: repairTreatmentForUnitId(extraUnitId)!,
      repairTreatmentAttemptHash: generatedRepairLifecycleAttemptHash('trajectory-terminal-only'),
    };
    const generated = summarizeDispatchProductionYield([...events, terminalOnly])?.generatedRepairAttempts;

    expect(generated?.treatmentAttribution).toMatchObject({
      gate: 'withheld',
      blockers: expect.arrayContaining(['unmatched-terminal']),
      distinctUnits: 7,
    });
    expect(generated).not.toHaveProperty('treatmentConversions');
  });

  it('withholds attribution progress with bounded replay and unattributed blockers', () => {
    const events = treatmentEvents();
    const raw = events.find((event) => event.basis === 'run-proposal-outcome')!;
    const replay = { ...raw, runId: 'replayed-execution' };
    const unattributed = { ...raw, itemId: 'ashlr-hub:proposal-repair-nodiff:dddddddddddd', repairTreatmentUnitId: undefined };
    const summary = summarizeDispatchProductionYield([...events, replay, unattributed])
      ?.generatedRepairAttempts?.treatmentAttribution;

    expect(summary).toMatchObject({
      gate: 'withheld',
      blockers: ['unattributed', 'replayed'],
      unattributedEvents: 1,
      replayedEvents: 1,
    });
    expect(summary?.blockers.every((blocker) =>
      ['in-flight', 'unmatched-terminal', 'unattributed', 'replayed'].includes(blocker)
    )).toBe(true);
  });

  it('exposes treatment progress without raw identities, objectives, paths, or payloads', () => {
    const rawId = 'RAW_TREATMENT_ID_CANARY_M342';
    const rawObjective = 'RAW_TREATMENT_OBJECTIVE_CANARY_M342';
    const rawPath = '/private/treatment/path/canary';
    const rawPayload = 'RAW_TREATMENT_PAYLOAD_CANARY_M342';
    const events = treatmentEvents().map((event) => ({
      ...event,
      rawId,
      objective: rawObjective,
      path: rawPath,
      payload: rawPayload,
    } as DispatchProductionEvent));
    const attribution = summarizeDispatchProductionYield(events)
      ?.generatedRepairAttempts?.treatmentAttribution;
    const serialized = JSON.stringify(attribution);

    expect(attribution).toBeDefined();
    expect(serialized).not.toContain(rawId);
    expect(serialized).not.toContain(rawObjective);
    expect(serialized).not.toContain(rawPath);
    expect(serialized).not.toContain(rawPayload);
    expect(Object.keys(attribution!)).toEqual([
      'eligibleEvents',
      'attributedEvents',
      'unattributedEvents',
      'distinctUnits',
      'replayedEvents',
      'minimumTerminalUnitsPerArm',
      'arms',
      'gate',
      'blockers',
    ]);
  });

  it('appends a terminal lifecycle witness idempotently across acknowledgement retries', () => {
    const witness = treatmentEvents().find((event) => event.basis === 'repair-lifecycle-outcome')!;
    mkdirSync(dispatchProductionDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(dispatchProductionDir(), '2026-07-08.jsonl'), '{malformed-history}\n', { mode: 0o600 });

    expect(recordDispatchProduction(witness)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(recordDispatchProduction(witness)).toEqual({ attempted: 1, recorded: 1, failed: 0 });

    const rows = readDispatchProductionEvents({ limit: 100 });
    expect(rows.filter((event) =>
      event.basis === 'repair-lifecycle-outcome' &&
      event.repairGenerationId === witness.repairGenerationId &&
      event.repairTreatmentAttemptHash === witness.repairTreatmentAttemptHash)).toHaveLength(1);
  });

  it('first-publishes and replays an exact treatment receipt without touching oversized raw history', () => {
    const witness = treatmentEvents().find((event) => event.basis === 'repair-lifecycle-outcome')!;
    const canonical = sanitizeDispatchProductionEvent(witness, { materializeLearningLabel: true });
    const partition = join(dispatchProductionDir(), `${witness.ts.slice(0, 10)}.jsonl`);
    mkdirSync(dispatchProductionDir(), { recursive: true, mode: 0o700 });
    writeFileSync(partition, '\n'.repeat(50_001), { mode: 0o600 });
    truncateSync(partition, 33 * 1024 * 1024);
    const rawBefore = readFileSync(partition);
    const rawDigest = createHash('sha256').update(rawBefore).digest('hex');

    expect(recordDispatchProduction(witness)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(recordDispatchProduction(witness)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(hasExactDispatchProductionTreatmentOutcomeReceipt(witness)).toBe(true);
    expect(createHash('sha256').update(readFileSync(partition)).digest('hex')).toBe(rawDigest);
    expect(readFileSync(partition).length).toBe(rawBefore.length);
    const receiptPath = join(
      dispatchProductionDir(),
      'repair-treatment-outcomes',
      `${witness.repairGenerationId}-${witness.repairTreatmentAttemptHash}.json`,
    );
    expect(readFileSync(receiptPath, 'utf8')).toBe(`${JSON.stringify(canonical)}\n`);
  });

  it('rejects treatment receipt replay with the same filename but different canonical semantics', () => {
    const witness = treatmentEvents().find((event) => event.basis === 'repair-lifecycle-outcome')!;
    expect(recordDispatchProduction(witness)).toEqual({ attempted: 1, recorded: 1, failed: 0 });

    const conflictingReplay = {
      ...witness,
      routeReason: 'semantically different canonical receipt replay',
    };
    expect(recordDispatchProduction(conflictingReplay)).toEqual({ attempted: 1, recorded: 0, failed: 1 });

    const rows = readDispatchProductionEvents({ limit: 100 });
    const receipts = rows.filter((event) =>
      event.basis === 'repair-lifecycle-outcome' &&
      event.repairGenerationId === witness.repairGenerationId &&
      event.repairTreatmentAttemptHash === witness.repairTreatmentAttemptHash);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.routeReason).toBe(witness.routeReason);
  });

  it('verifies only the exact immutable treatment outcome receipt', () => {
    const witness = treatmentEvents().find((event) => event.basis === 'repair-lifecycle-outcome')!;
    const receiptDir = join(dispatchProductionDir(), 'repair-treatment-outcomes');
    expect(hasExactDispatchProductionTreatmentOutcomeReceipt(witness)).toBe(false);
    expect(existsSync(receiptDir)).toBe(false);
    expect(recordDispatchProduction(witness)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(hasExactDispatchProductionTreatmentOutcomeReceipt(witness)).toBe(true);
    expect(hasExactDispatchProductionTreatmentOutcomeReceipt({
      ...witness,
      routeReason: 'different terminal semantics',
    })).toBe(false);
  });

  it('rejects contradictory, unknown-field, and noncanonical treatment receipt bytes everywhere', () => {
    const witness = treatmentEvents().find((event) =>
      event.basis === 'repair-lifecycle-outcome' && event.repairTreatmentOutcome === 'converted')!;
    expect(recordDispatchProduction(witness)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    const receiptPath = join(
      dispatchProductionDir(),
      'repair-treatment-outcomes',
      `${witness.repairGenerationId}-${witness.repairTreatmentAttemptHash}.json`,
    );
    const canonical = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    const invalidRows: string[] = [];
    invalidRows.push(`${JSON.stringify({
      ...canonical,
      outcome: 'engine-failed',
      proposalCreated: false,
      proposalId: undefined,
      repairTreatmentOutcome: 'converted',
    })}\n`);
    invalidRows.push(`${JSON.stringify({
      ...canonical,
      outcome: 'empty-diff',
      proposalCreated: false,
      proposalId: undefined,
      repairTreatmentOutcome: 'not-converted',
      repairAttemptOrdinal: 1,
    })}\n`);
    invalidRows.push(`${JSON.stringify({ ...canonical, unknownAuthority: true })}\n`);
    invalidRows.push(`${JSON.stringify(canonical, null, 2)}\n`);

    for (const text of invalidRows) {
      writeFileSync(receiptPath, text, { mode: 0o600 });
      protectWindowsFixtureTree(dirname(receiptPath));
      expect(hasExactDispatchProductionTreatmentOutcomeReceipt(witness)).toBe(false);
      expect(readDispatchProductionEventsDetailed()).toMatchObject({
        sourceState: 'degraded',
        complete: false,
        invalidRows: 1,
      });
    }
  });

  it('accepts an otherwise canonical legacy treatment receipt without a terminal newline', () => {
    const witness = treatmentEvents().find((event) =>
      event.basis === 'repair-lifecycle-outcome' && event.repairTreatmentOutcome === 'converted')!;
    expect(recordDispatchProduction(witness)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    const receiptPath = join(
      dispatchProductionDir(),
      'repair-treatment-outcomes',
      `${witness.repairGenerationId}-${witness.repairTreatmentAttemptHash}.json`,
    );
    const canonicalLine = readFileSync(receiptPath, 'utf8').trimEnd();
    writeFileSync(receiptPath, canonicalLine, { mode: 0o600 });
    protectWindowsFixtureTree(dirname(receiptPath));

    expect(hasExactDispatchProductionTreatmentOutcomeReceipt(witness)).toBe(true);
    expect(readDispatchProductionEventsDetailed()).toMatchObject({
      sourceState: 'healthy', complete: true, invalidRows: 0,
    });
  });

  it('accepts a sanitizer-validated v1 learning label without relabeling immutable receipt bytes', () => {
    const witness = treatmentEvents().find((event) =>
      event.basis === 'repair-lifecycle-outcome' && event.repairTreatmentOutcome === 'converted')!;
    expect(recordDispatchProduction(witness)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    const receiptPath = join(
      dispatchProductionDir(),
      'repair-treatment-outcomes',
      `${witness.repairGenerationId}-${witness.repairTreatmentAttemptHash}.json`,
    );
    const legacy = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
      learningLabel: { classifierVersion: string };
    };
    legacy.learningLabel.classifierVersion = 'attempt-shape-v1';
    expect(sanitizeProductionAttemptLearningLabel(legacy.learningLabel)).toBeDefined();
    writeFileSync(receiptPath, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
    protectWindowsFixtureTree(dirname(receiptPath));

    expect(hasExactDispatchProductionTreatmentOutcomeReceipt(witness)).toBe(true);
    expect(readDispatchProductionEventsDetailed()).toMatchObject({
      sourceState: 'healthy', complete: true, invalidRows: 0,
    });
  });

  it.skipIf(process.platform !== 'win32')(
    'exact-inspects receipt directory DACLs during pure authority reads',
    () => {
      establishNativePrivateStorageFixtureRoot();
      const attempt = makeProofEvent({
        runId: 'run-directory-dacl-attempt',
        trajectoryId: 'run:attempt-directory-dacl-attempt',
      });
      const treatment = treatmentEvents().find((event) =>
        event.basis === 'repair-lifecycle-outcome')!;
      expect(recordDispatchProduction([attempt, treatment]))
        .toEqual({ attempted: 2, recorded: 2, failed: 0 });
      const attemptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
      const treatmentDir = join(dispatchProductionDir(), 'repair-treatment-outcomes');
      grantWindowsWorldRead(attemptDir);
      grantWindowsWorldRead(treatmentDir);
      const broadenedAuthority = [];
      for (const dir of [attemptDir, treatmentDir]) {
        expect(assurePrivateStoragePath(
          dir, 'directory', 'inspect-owned', { anchorPath: dispatchProductionDir() },
        ).ok).toBe(true);
        const exact = assurePrivateStoragePath(
          dir, 'directory', 'inspect-existing', { anchorPath: dispatchProductionDir() },
        );
        broadenedAuthority.push(exact);
        expect(exact.ok).toBe(false);
      }

      expect({
        broadenedAuthority,
        resolution: resolveDispatchProductionAttemptReceiptWitnesses([{
          repairGenerationId: attempt.repairGenerationId!, repairAttemptOrdinal: 1,
        }]),
      }).toEqual({
        broadenedAuthority: [
          { ok: false, reason: 'unexpected-ace-count' },
          { ok: false, reason: 'unexpected-ace-count' },
        ],
        resolution: {
          status: 'resolved',
          resolutions: [{ status: 'degraded', reason: 'source-unsafe' }],
        },
      });
      expect(readDispatchProductionAttemptProtocolQuality()).toMatchObject({ status: 'degraded' });
      expect(hasExactDispatchProductionTreatmentOutcomeReceipt(treatment)).toBe(false);
      expect(readDispatchProductionEventsDetailed()).toMatchObject({
        sourceState: 'degraded', complete: false, unreadableFiles: 1,
      });
    },
    60_000,
  );

  it.skipIf(process.platform !== 'win32')(
    'rejects owner-safe but non-exact Windows ACLs before parsing treatment authority',
    () => {
      establishNativePrivateStorageFixtureRoot();
      const witness = treatmentEvents().find((event) =>
        event.basis === 'repair-lifecycle-outcome')!;
      expect(recordDispatchProduction(witness)).toEqual({ attempted: 1, recorded: 1, failed: 0 });

      const receiptDir = join(dispatchProductionDir(), 'repair-treatment-outcomes');
      const receiptPath = join(
        receiptDir,
        `${witness.repairGenerationId}-${witness.repairTreatmentAttemptHash}.json`,
      );
      grantWindowsWorldRead(receiptPath);
      expect(assurePrivateStoragePath(
        receiptPath, 'file', 'inspect-owned', { anchorPath: dispatchProductionDir() },
      ).ok).toBe(true);
      expect(assurePrivateStoragePath(
        receiptPath, 'file', 'inspect-existing', { anchorPath: dispatchProductionDir() },
      ).ok).toBe(false);
      expect(hasExactDispatchProductionTreatmentOutcomeReceipt(witness)).toBe(false);
      expect(readDispatchProductionEventsDetailed()).toMatchObject({
        sourceState: 'degraded',
        complete: false,
        invalidRows: 1,
      });
      expect(recordDispatchProduction(witness)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
      expect(assurePrivateStoragePath(
        receiptPath, 'file', 'inspect-existing', { anchorPath: dispatchProductionDir() },
      ).ok).toBe(false);

      rmSync(receiptPath);
      expect(recordDispatchProduction(witness)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
      const retentionPath = join(receiptDir, '.retention.json');
      const retentionTmp = `${retentionPath}.${process.pid}.tmp`;
      writeFileSync(retentionTmp, `${JSON.stringify({
        schemaVersion: 1,
        droppedThrough: '2025-01-01T00:00:00.000Z',
      })}\n`, { mode: 0o600 });
      expect(assurePrivateStoragePath(
        retentionTmp, 'file', 'secure-created', { anchorPath: dispatchProductionDir() },
      ).ok).toBe(true);
      renameSync(retentionTmp, retentionPath);
      grantWindowsWorldRead(retentionPath);
      expect(assurePrivateStoragePath(
        retentionPath, 'file', 'inspect-owned', { anchorPath: dispatchProductionDir() },
      ).ok).toBe(true);
      expect(assurePrivateStoragePath(
        retentionPath, 'file', 'inspect-existing', { anchorPath: dispatchProductionDir() },
      ).ok).toBe(false);
      expect(hasExactDispatchProductionTreatmentOutcomeReceipt(witness)).toBe(false);
      expect(readDispatchProductionEventsDetailed()).toMatchObject({
        sourceState: 'degraded',
        complete: false,
        unreadableFiles: 1,
      });
      expect(recordDispatchProduction(witness)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
      expect(assurePrivateStoragePath(
        retentionPath, 'file', 'inspect-existing', { anchorPath: dispatchProductionDir() },
      ).ok).toBe(false);
    },
    60_000,
  );

  it.skipIf(process.platform !== 'win32')(
    'establishes exact private DACLs for treatment receipt, retention, and protocol writes',
    () => {
      establishNativePrivateStorageFixtureRoot();
      const witness = treatmentEvents().find((event) => event.basis === 'repair-lifecycle-outcome')!;
      const receiptDir = join(dispatchProductionDir(), 'repair-treatment-outcomes');
      const baseMs = Date.parse('2025-01-01T00:00:00.000Z');
      const seedHandoffId = (100_000).toString(16).padStart(64, '0');
      const seed = sanitizeDispatchProductionEvent({
        ...witness,
        ts: new Date(baseMs).toISOString(),
        runId: 'run-treatment-retention-0',
        repairHandoffId: seedHandoffId,
        repairGenerationId: repairGenerationIdFromHandoffId(seedHandoffId)!,
        repairTreatmentAttemptHash: generatedRepairLifecycleAttemptHash(
          'run-treatment-retention-0',
        ),
      }, { materializeLearningLabel: true });
      expect(recordDispatchProduction(seed)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
      const manualReceiptPaths: string[] = [];
      for (let index = 1; index < 2_048; index++) {
        const handoffId = (100_000 + index).toString(16).padStart(64, '0');
        const fixture = sanitizeDispatchProductionEvent({
          ...witness,
          ts: new Date(baseMs + index * 1_000).toISOString(),
          runId: `run-treatment-retention-${index}`,
          repairHandoffId: handoffId,
          repairGenerationId: repairGenerationIdFromHandoffId(handoffId)!,
          repairTreatmentAttemptHash: generatedRepairLifecycleAttemptHash(
            `run-treatment-retention-${index}`,
          ),
        }, { materializeLearningLabel: true });
        const manualReceiptPath = join(
          receiptDir,
          `${fixture.repairGenerationId}-${fixture.repairTreatmentAttemptHash}.json`,
        );
        writeFileSync(
          manualReceiptPath,
          `${JSON.stringify(fixture)}\n`,
          { mode: 0o600 },
        );
        manualReceiptPaths.push(manualReceiptPath);
      }
      ownWindowsFixturePaths(manualReceiptPaths);
      protectWindowsFixtureTree(receiptDir);

      const receiptPaths = readdirSync(receiptDir)
        .filter((name) => name.endsWith('.json'))
        .slice(0, 512)
        .map((name) => join(receiptDir, name));
      const batchPreflight = assurePrivateStoragePaths(receiptPaths, {
        anchorPath: dispatchProductionDir(),
      });
      expect({ batchPreflight, write: recordDispatchProduction(witness) }).toEqual({
        batchPreflight: { ok: true, reason: 'owned-safe-paths' },
        write: { attempted: 1, recorded: 1, failed: 0 },
      });
      expect(recordDispatchProduction(witness)).toEqual({ attempted: 1, recorded: 1, failed: 0 });

      const receiptPath = join(
        receiptDir,
        `${witness.repairGenerationId}-${witness.repairTreatmentAttemptHash}.json`,
      );
      const retentionPath = join(receiptDir, '.retention.json');
      const protocolPath = join(receiptDir, '.protocol.json');
      expect(existsSync(retentionPath)).toBe(true);
      expect(assurePrivateStoragePath(
        receiptPath, 'file', 'inspect-existing', { anchorPath: dispatchProductionDir() },
      ).ok).toBe(true);
      expect(assurePrivateStoragePath(
        retentionPath, 'file', 'inspect-existing', { anchorPath: dispatchProductionDir() },
      ).ok).toBe(true);
      expect(assurePrivateStoragePath(
        protocolPath, 'file', 'inspect-existing', { anchorPath: dispatchProductionDir() },
      ).ok).toBe(true);
      grantWindowsWorldRead(protocolPath);
      expect(hasExactDispatchProductionTreatmentOutcomeReceipt(witness)).toBe(false);
      expect(readDispatchProductionEventsDetailed()).toMatchObject({
        sourceState: 'degraded', complete: false, unreadableFiles: 1,
      });
    },
    120_000,
  );

  it('marks only learning windows intersecting receipt retention as incomplete', () => {
    const witness = treatmentEvents().find((event) => event.basis === 'repair-lifecycle-outcome')!;
    expect(recordDispatchProduction(witness).recorded).toBe(1);
    const receiptDir = join(dispatchProductionDir(), 'repair-treatment-outcomes');
    rmSync(join(receiptDir, '.protocol.json'));
    writeFileSync(join(receiptDir, '.retention.json'), JSON.stringify({
      schemaVersion: 1,
      droppedThrough: '2026-07-07T23:59:59.999Z',
    }) + '\n', { mode: 0o600 });

    expect(readDispatchProductionEventsDetailed({ sinceMs: Date.parse('2026-07-08T00:00:00.000Z') }))
      .toMatchObject({ sourceState: 'healthy', complete: true });
    expect(readDispatchProductionEventsDetailed({ sinceMs: Date.parse('2026-07-07T00:00:00.000Z') }))
      .toMatchObject({ sourceState: 'degraded', complete: false, stopReasons: ['file-limit'] });
  });

  it('withholds conversions when eligible metadata is stripped', () => {
    const events = treatmentEvents();
    const stripped = sanitizeDispatchProductionEvent({
      ...events[0]!,
      repairTreatmentUnitId: undefined,
    });
    const generated = summarizeDispatchProductionYield([...events, stripped])?.generatedRepairAttempts;

    expect(stripped).toMatchObject({ repairLineageInvalid: true });
    expect(stripped).not.toHaveProperty('repairTreatment');
    expect(generated?.treatmentAttribution).toMatchObject({
      eligibleEvents: 11,
      attributedEvents: 10,
      unattributedEvents: 1,
      distinctUnits: 6,
    });
    expect(generated).not.toHaveProperty('treatmentConversions');
  });

  it('withholds detailed conversions for truncated and degraded sources', () => {
    const now = new Date().toISOString();
    const events = treatmentEvents(now);
    recordDispatchProduction([makeEvent({ ts: now, itemId: 'older-noise' }), ...events]);

    const truncated = readDispatchProductionYieldDetailed({ windowMs: 60_000, limit: 100, maxRows: 6 });
    expect(truncated.sourceQuality).toMatchObject({ sourceState: 'degraded', complete: false });
    expect(truncated.sourceQuality.stopReasons).toContain('row-limit');
    expect(truncated.summary?.generatedRepairAttempts?.treatmentAttribution?.distinctUnits).toBeLessThan(6);
    expect(truncated.summary?.generatedRepairAttempts?.treatmentAttribution).toMatchObject({
      gate: 'withheld',
      blockers: expect.arrayContaining(['source-incomplete']),
    });
    expect(truncated.summary?.generatedRepairAttempts).not.toHaveProperty('treatmentConversions');

    rmSync(dispatchProductionDir(), { recursive: true, force: true });
    mkdirSync(dispatchProductionDir(), { recursive: true });
    writeFileSync(
      join(dispatchProductionDir(), `${now.slice(0, 10)}.jsonl`),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\nnot-json\n`,
      'utf8',
    );
    const degraded = readDispatchProductionYieldDetailed({ windowMs: 60_000, limit: 100 });
    expect(degraded.sourceQuality).toMatchObject({ sourceState: 'degraded', complete: false, invalidRows: 1 });
    expect(degraded.summary?.generatedRepairAttempts?.treatmentAttribution).toMatchObject({
      distinctUnits: 6,
      gate: 'withheld',
      blockers: expect.arrayContaining(['source-incomplete']),
    });
    expect(degraded.summary?.generatedRepairAttempts).not.toHaveProperty('treatmentConversions');
  });

  it('keeps raw proposal-disabled reasons while exposing diagnostic reasons for operators', () => {
    const summary = summarizeDispatchProductionYield([
      makeEvent({
        itemId: 'sandbox-policy',
        backend: 'codex',
        outcome: 'proposal-disabled',
        proposalCreated: false,
        reason: 'proposal filing disabled for this sandboxed attempt',
      }),
      makeEvent({
        itemId: 'api-policy',
        backend: 'codex',
        outcome: 'proposal-disabled',
        proposalCreated: false,
        reason: 'proposal filing disabled for this api-model attempt',
      }),
      makeEvent({
        itemId: 'empty-diff',
        backend: 'local-coder',
        outcome: 'empty-diff',
        proposalCreated: false,
        reason: 'engine "local-coder" completed without file changes',
      }),
    ]);

    expect(summary?.topReasons.map((row) => row.reason)).toEqual([
      'engine "local-coder" completed without file changes',
      'proposal filing disabled for this api-model attempt',
      'proposal filing disabled for this sandboxed attempt',
    ]);
    expect(summary?.diagnosticTopReasons).toEqual([
      { reason: 'engine "local-coder" completed without file changes', count: 1 },
    ]);
    const codex = summary?.byBackend.find((bucket) => bucket.backend === 'codex');
    expect(codex?.topReasons.map((row) => row.reason)).toEqual([
      'proposal filing disabled for this api-model attempt',
      'proposal filing disabled for this sandboxed attempt',
    ]);
    expect(codex?.diagnosticTopReasons).toEqual([]);
    expect(codex).toMatchObject({
      attempts: 2,
      noProposal: 2,
      diagnosticAttempts: 0,
      diagnosticNoProposal: 0,
      diagnosticProposalRate: 0,
    });
  });

  it('sorts and truncates buckets by diagnostic yield instead of raw suppressed volume', () => {
    const events = Array.from({ length: 20 }, (_, index) => makeEvent({
      itemId: `cancelled-${index}`,
      backend: 'local-coder',
      outcome: 'cancelled',
      reason: 'dispatch cancelled after daemon ownership changed',
      runEventSummary: {
        status: 'aborted',
        outcome: 'cancelled',
        proposalCreated: false,
      },
    }));
    events.push(
      makeEvent({
        itemId: 'policy-suppressed',
        backend: 'kimi',
        outcome: 'proposal-disabled',
        reason: 'proposal filing disabled for this sandboxed attempt',
      }),
      makeEvent({
        itemId: 'actionable-empty-diff',
        backend: 'codex',
        outcome: 'empty-diff',
        reason: 'engine completed without file changes',
      }),
    );

    const summary = summarizeDispatchProductionYield(events, { limitPerDimension: 1 });

    expect(summary?.byBackend).toHaveLength(1);
    expect(summary?.byBackend[0]).toMatchObject({
      key: 'codex',
      attempts: 1,
      diagnosticAttempts: 1,
      diagnosticNoProposal: 1,
      diagnosticProposalRate: 0,
    });
  });

  it('uses the bucket key as a deterministic diagnostic-yield tie breaker', () => {
    const forward = summarizeDispatchProductionYield([
      makeEvent({ itemId: 'zeta-failure', backend: 'kimi', outcome: 'empty-diff' }),
      makeEvent({ itemId: 'alpha-failure', backend: 'codex', outcome: 'empty-diff' }),
    ]);
    const reverse = summarizeDispatchProductionYield([
      makeEvent({ itemId: 'alpha-failure', backend: 'codex', outcome: 'empty-diff' }),
      makeEvent({ itemId: 'zeta-failure', backend: 'kimi', outcome: 'empty-diff' }),
    ]);

    expect(forward?.byBackend.map((bucket) => bucket.key)).toEqual(['codex', 'kimi']);
    expect(reverse?.byBackend.map((bucket) => bucket.key)).toEqual(['codex', 'kimi']);
  });

  it('treats capture-missing proposal-disabled telemetry as diagnostic, not policy-suppressed', () => {
    recordDispatchProduction(makeEvent({
      itemId: 'capture-missing',
      outcome: 'proposal-capture-error',
      proposalCreated: false,
      reason: 'capture-missing: required proposal dispatch ended before final capture',
      runEventSummary: {
        status: 'failed',
        outcome: 'proposal-disabled',
        proposalCreated: false,
        actionCounts: {
          proposalDisabled: 1,
          proposalCaptureAttempts: 0,
        },
      },
    }));

    const event = readDispatchProductionEvents({ limit: 1 })[0];
    expect(event?.learningLabel).toMatchObject({
      learningKind: 'diagnostic-no-proposal',
      policySuppressed: false,
      diagnosticNoProposal: true,
      diagnosticAttempt: true,
      attemptShape: {
        backendNoDiff: 0,
        captureOrGateBlocked: 1,
        policyDisabled: 0,
      },
    });

    const summary = summarizeDispatchProductionYield([event!]);
    expect(summary).toMatchObject({
      attempts: 1,
      proposalsCreated: 0,
      outcomes: {
        proposalCaptureError: 1,
        proposalDisabled: 0,
      },
      actionCounts: {
        proposalDisabled: 1,
      },
      attemptShape: {
        backendNoDiff: 0,
        captureOrGateBlocked: 1,
        policyDisabled: 0,
      },
      diagnosticTopReasons: [
        {
          reason: 'capture-missing: required proposal dispatch ended before final capture',
          count: 1,
        },
      ],
    });
  });

  it('reads a bounded durable yield window from disk', () => {
    recordDispatchProduction([
      makeEvent({ itemId: 'old', ts: '2026-07-07T00:00:00.000Z' }),
      makeEvent({ itemId: 'new', ts: new Date().toISOString(), outcome: 'proposal-created', proposalCreated: true }),
    ]);

    const summary = readDispatchProductionYield({ windowMs: 60 * 60 * 1000, limit: 20 });

    expect(summary).toMatchObject({
      events: 1,
      proposalsCreated: 1,
      noProposal: 0,
    });
  });

  it('falls back to HOME when ASHLR_HOME is unset or empty', () => {
    const fallbackHome = mkdtempSync(join(tmpdir(), 'ashlr-m342-home-fallback-'));
    try {
      process.env.HOME = fallbackHome;
      process.env.USERPROFILE = fallbackHome;
      delete process.env.ASHLR_HOME;

      recordDispatchProduction(makeEvent({ itemId: 'home-fallback' }));
      expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({ itemId: 'home-fallback' });
      expect(existsSync(join(fallbackHome, '.ashlr', 'dispatch-production'))).toBe(true);

      process.env.ASHLR_HOME = '';
      recordDispatchProduction(makeEvent({ itemId: 'empty-env-fallback' }));
      expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({ itemId: 'empty-env-fallback' });
      expect(existsSync(join(process.cwd(), 'dispatch-production'))).toBe(false);
    } finally {
      rmSync(fallbackHome, { recursive: true, force: true });
    }
  });

  it('scrubs manually-written legacy rows during read aggregation', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '2026-07-08.jsonl'),
      JSON.stringify(makeEvent({
        itemId: 'legacy-secret',
        routeReason: 'token=ghp_1234567890abcdefABCDEF',
        reason: 'Authorization Bearer sk-supersecretsecretsecret',
      })) + '\n',
      'utf8',
    );

    const event = readDispatchProductionEvents({ limit: 1 })[0]!;
    const summary = summarizeDispatchProductionYield([event]);

    expect(event.routeReason).not.toContain('ghp_1234567890abcdefABCDEF');
    expect(summary?.topReasons[0]?.reason).not.toContain('sk-supersecretsecretsecret');
    expect(JSON.stringify(summary)).toContain('[REDACTED]');
  });

  it('deduplicates repair transition learning and degrades contradictory lineage', () => {
    const handoffId = 'a'.repeat(64);
    const generationId = repairGenerationIdFromHandoffId(handoffId)!;
    const retry = makeEvent({
      itemId: `diagnostic:generated-repair:${generationId}`,
      backend: 'kimi',
      outcome: 'proposal-created',
      proposalCreated: true,
      repairHandoffId: handoffId,
      repairGenerationId: generationId,
      repairAttemptOrdinal: 2,
      repairPreviousBackend: 'local-coder',
    });
    const distinct = makeEvent({
      ...retry,
      runId: 'run-b',
      outcome: 'engine-failed',
      proposalCreated: false,
    });
    const cancelled = makeEvent({
      ...retry,
      runId: 'run-c',
      outcome: 'cancelled',
      proposalCreated: false,
      runEventSummary: { status: 'aborted', outcome: 'cancelled', proposalCreated: false },
    });
    const historicalCancelledDuplicate = makeEvent({
      ...cancelled,
      outcome: 'engine-failed',
      reason: 'run cancelled by owner',
      runEventSummary: { status: 'aborted', outcome: 'engine-failed', proposalCreated: false },
    });
    const conflict = makeEvent({
      ...retry,
      runId: retry.runId,
      backend: 'nim',
      outcome: 'empty-diff',
      proposalCreated: false,
    });

    const healthy = summarizeDispatchProductionYield([
      retry,
      { ...retry },
      distinct,
      cancelled,
      historicalCancelledDuplicate,
    ]);
    expect(healthy?.generatedRepairBackendTransitions).toEqual({
      sourceState: 'healthy',
      lineageEvents: 5,
      transitionEvents: 5,
      attempts: 2,
      duplicateEvents: 2,
      conflictingAttempts: 0,
      invalidLineageEvents: 0,
      byTransition: [{
        previousBackend: 'local-coder',
        retryBackend: 'kimi',
        attempts: 2,
        proposalsCreated: 1,
        noProposal: 1,
        proposalRate: 0.5,
        outcomes: expect.objectContaining({ proposalCreated: 1, engineFailed: 1, cancelled: 1 }),
      }],
    });

    const degraded = summarizeDispatchProductionYield([retry, distinct, conflict]);
    expect(degraded?.generatedRepairBackendTransitions).toMatchObject({
      sourceState: 'degraded',
      lineageEvents: 3,
      transitionEvents: 3,
      attempts: 1,
      conflictingAttempts: 1,
      byTransition: [{
        previousBackend: 'local-coder',
        retryBackend: 'kimi',
        attempts: 1,
        proposalsCreated: 0,
        noProposal: 1,
      }],
    });
    expect(JSON.stringify(degraded?.generatedRepairBackendTransitions)).not.toContain(generationId);
    expect(JSON.stringify(degraded?.generatedRepairBackendTransitions)).not.toContain(handoffId);
  });

  it('prunes stale day files before applying recent yield windows', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '2020-01-01.jsonl'),
      JSON.stringify(makeEvent({ itemId: 'stale-file-recent-event', ts: new Date().toISOString() })) + '\n',
      'utf8',
    );
    recordDispatchProduction(makeEvent({
      itemId: 'current-file',
      ts: new Date().toISOString(),
      outcome: 'proposal-created',
      proposalCreated: true,
    }));

    const summary = readDispatchProductionYield({ windowMs: 60 * 60 * 1000, limit: 20 });

    expect(summary).toMatchObject({ events: 1, proposalsCreated: 1 });
    expect(summary?.byBackend[0]?.key).toBe('local-coder');
  });

  it('does not let loose legacy jsonl files consume the dated file budget', () => {
    const dir = dispatchProductionDir();
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(
        join(dir, `zz-legacy-${i}.jsonl`),
        JSON.stringify(makeEvent({ itemId: `legacy-${i}`, ts: new Date().toISOString() })) + '\n',
        'utf8',
      );
    }
    recordDispatchProduction(makeEvent({ itemId: 'current-dated', ts: new Date().toISOString() }));

    const events = readDispatchProductionEvents({
      sinceMs: Date.now() - 60 * 60 * 1000,
      maxFiles: 1,
      limit: 20,
    });

    expect(events.map((event) => event.itemId)).toContain('current-dated');
    expect(readDispatchProductionEventsDetailed({
      sinceMs: Date.now() - 60 * 60 * 1000,
      maxFiles: 1,
      limit: 20,
    })).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      datedFilesRead: 1,
      looseFilesRead: 3,
    });
  });

  it('derives durable yield file bounds from the requested window', () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    recordDispatchProduction(makeEvent({
      itemId: 'five-days-old',
      ts: fiveDaysAgo.toISOString(),
      outcome: 'proposal-created',
      proposalCreated: true,
    }));

    const summary = readDispatchProductionYield({
      windowMs: 6 * 24 * 60 * 60 * 1000,
      limit: 20,
    });

    expect(summary).toMatchObject({ events: 1, proposalsCreated: 1 });
    expect(summary?.byBackend[0]?.key).toBe('local-coder');
  });
});
