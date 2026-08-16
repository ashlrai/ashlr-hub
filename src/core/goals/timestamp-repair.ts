/**
 * Deterministic, offline repair for stale Goal.updatedAt values.
 *
 * The repair never consults wall-clock or filesystem timestamps. A goal's
 * repaired value is the maximum timestamp already present in that goal and its
 * milestones. Dry-run is strictly read-only. Apply is bound to an exact plan,
 * preserves immutable raw backups, and records deterministic receipts.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  type BigIntStats,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Goal } from '../types.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import {
  readImmutablePrivateRecordPoint,
  recoverImmutablePrivateRecordStore,
  writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec,
  type ImmutablePrivateRecordStoreConfig,
} from '../util/immutable-private-record-store.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import {
  goalsDir,
  goalSnapshotDigest,
  isValidGoalRecord,
  isValidGoalRecordForTimestampRepair,
} from './store.js';

const SCHEMA_VERSION = 1 as const;
const MAX_GOAL_FILES = 200;
const MAX_DIRECTORY_ENTRIES = 512;
const MAX_GOAL_FILE_BYTES = 256 * 1024;
const LOCK_WAIT_MS = 2_000;
const REPAIR_ROOT = '.timestamp-repair-artifacts';
const MAX_ARTIFACT_BYTES = 512 * 1024;

interface StableGoalFile {
  fileName: string;
  raw: Buffer;
  rawDigest: string;
  goal: Goal;
  derivedUpdatedAt: string;
  repairedRaw: Buffer;
  repairedDigest: string;
}

interface StableDirectoryIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
  trackMembership: boolean;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface SourceAncestrySnapshot {
  present: StableDirectoryIdentity[];
  absent: string[];
  goalsPresent: boolean;
}

export interface GoalTimestampRepairPlanEntry {
  goalId: string;
  fileName: string;
  beforeDigest: string;
  afterDigest: string;
  previousUpdatedAt: string;
  derivedUpdatedAt: string;
  repairRequired: boolean;
}

interface GoalTimestampRepairPlanBody {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: 'goal-timestamp-repair';
  sourceDigest: string;
  scannedGoals: number;
  entries: GoalTimestampRepairPlanEntry[];
}

export interface GoalTimestampRepairPlan extends GoalTimestampRepairPlanBody {
  planId: string;
}

export interface GoalTimestampRepairDryRunResult {
  mode: 'dry-run';
  planId: string;
  scannedGoals: number;
  repairableGoals: number;
  entries: GoalTimestampRepairPlanEntry[];
}

export interface GoalTimestampRepairApplyResult {
  mode: 'apply';
  planId: string;
  scannedGoals: number;
  repairableGoals: number;
  repairedGoals: number;
  alreadyAppliedGoals: number;
  receiptCount: number;
  entries: GoalTimestampRepairPlanEntry[];
}

interface StoredReceipt {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: 'goal-timestamp-repair-receipt';
  artifactId: string;
  planId: string;
  goalId: string;
  beforeDigest: string;
  afterDigest: string;
  derivedUpdatedAt: string;
}

interface StoredPlan {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: 'goal-timestamp-repair-plan';
  artifactId: string;
  plan: GoalTimestampRepairPlan;
}

interface StoredRawBackup {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: 'goal-timestamp-repair-raw-backup';
  artifactId: string;
  planId: string;
  goalId: string;
  rawDigest: string;
  rawBase64: string;
}

type TimestampRepairArtifact = StoredPlan | StoredRawBackup | StoredReceipt;

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function ownedByCurrentUser(stat: BigIntStats): boolean {
  return typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid());
}

function assertSupportedCustodyPlatform(): void {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new Error(`goal timestamp repair is unsupported on platform ${process.platform}`);
  }
  if (typeof process.getuid !== 'function') {
    throw new Error('goal timestamp repair requires POSIX uid custody');
  }
}

function assureDarwinSourcePath(path: string, kind: 'directory' | 'file'): void {
  if (process.platform !== 'darwin') return;
  const assurance = assurePrivateStoragePath(path, kind, 'inspect-existing', {
    anchorPath: resolve(homedir()),
  });
  if (!assurance.ok) throw new Error(`goal source ACL custody refused: ${path}: ${assurance.reason}`);
}

function stableRegularFile(stat: BigIntStats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && ownedByCurrentUser(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o022n) === 0n);
}

function readStableFile(path: string, maximumBytes: number): Buffer {
  let fd: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!stableRegularFile(before) || before.size < 1n || before.size > BigInt(maximumBytes)) {
      throw new Error(`unsafe or oversized file: ${path}`);
    }
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
    const openedBefore = fstatSync(fd, { bigint: true });
    if (
      !stableRegularFile(openedBefore) || !sameIdentity(before, openedBefore) ||
      openedBefore.size < 1n || openedBefore.size > BigInt(maximumBytes) ||
      openedBefore.size !== before.size || openedBefore.mtimeNs !== before.mtimeNs ||
      openedBefore.ctimeNs !== before.ctimeNs
    ) {
      throw new Error(`file changed while opening: ${path}`);
    }
    const raw = Buffer.alloc(Number(openedBefore.size));
    let offset = 0;
    while (offset < raw.length) {
      const bytesRead = readSync(fd, raw, offset, raw.length - offset, offset);
      if (bytesRead <= 0) throw new Error(`short read: ${path}`);
      offset += bytesRead;
    }
    const openedAfter = fstatSync(fd, { bigint: true });
    const namedAfter = lstatSync(path, { bigint: true });
    if (
      !stableRegularFile(openedAfter) || !stableRegularFile(namedAfter) ||
      !sameIdentity(before, openedAfter) || !sameIdentity(before, namedAfter) ||
      openedAfter.size < 1n || openedAfter.size > BigInt(maximumBytes) ||
      namedAfter.size < 1n || namedAfter.size > BigInt(maximumBytes) ||
      openedAfter.size !== BigInt(raw.length) || namedAfter.size !== BigInt(raw.length) ||
      openedAfter.mtimeNs !== before.mtimeNs || namedAfter.mtimeNs !== before.mtimeNs ||
      openedAfter.ctimeNs !== before.ctimeNs || namedAfter.ctimeNs !== before.ctimeNs
    ) throw new Error(`file changed while reading: ${path}`);
    return raw;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function derivedGoalUpdatedAt(goal: Goal): string {
  const timestamps = [
    goal.createdAt,
    goal.updatedAt,
    ...goal.milestones.flatMap((milestone) => [milestone.createdAt, milestone.updatedAt]),
  ];
  let maximum = Number.NEGATIVE_INFINITY;
  for (const timestamp of timestamps) {
    const parsed = Date.parse(timestamp);
    if (!Number.isFinite(parsed)) throw new Error(`goal ${goal.id} contains an invalid domain timestamp`);
    maximum = Math.max(maximum, parsed);
  }
  if (!Number.isFinite(maximum)) throw new Error(`goal ${goal.id} has no domain timestamp`);
  return new Date(maximum).toISOString();
}

interface JsonStringToken {
  start: number;
  end: number;
}

function jsonStringTokenAt(raw: Buffer, start: number): JsonStringToken {
  if (raw[start] !== 0x22) throw new Error('JSON string token does not start with a quote');
  let escaped = false;
  for (let index = start + 1; index < raw.length; index += 1) {
    const byte = raw[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (byte === 0x5c) {
      escaped = true;
      continue;
    }
    if (byte === 0x22) return { start, end: index + 1 };
    if (byte < 0x20) throw new Error('JSON string contains an unescaped control byte');
  }
  throw new Error('unterminated JSON string token');
}

function skipJsonWhitespace(raw: Buffer, start: number): number {
  let index = start;
  while (index < raw.length && (
    raw[index] === 0x20 || raw[index] === 0x09 || raw[index] === 0x0a || raw[index] === 0x0d
  )) index += 1;
  return index;
}

function topLevelUpdatedAtToken(raw: Buffer, expectedValue: string): JsonStringToken {
  const matches: JsonStringToken[] = [];
  let depth = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const byte = raw[index]!;
    if (byte === 0x22) {
      const token = jsonStringTokenAt(raw, index);
      if (depth === 1) {
        const afterKey = skipJsonWhitespace(raw, token.end);
        if (raw[afterKey] === 0x3a) {
          let decodedKey: unknown;
          try { decodedKey = JSON.parse(raw.subarray(token.start, token.end).toString('utf8')); } catch {
            throw new Error('top-level JSON property key is invalid');
          }
          if (decodedKey === 'updatedAt') {
            const valueStart = skipJsonWhitespace(raw, afterKey + 1);
            const valueToken = jsonStringTokenAt(raw, valueStart);
            let decodedValue: unknown;
            try { decodedValue = JSON.parse(raw.subarray(valueToken.start, valueToken.end).toString('utf8')); } catch {
              throw new Error('top-level updatedAt string token is invalid');
            }
            if (decodedValue !== expectedValue) {
              throw new Error('top-level updatedAt token does not match the parsed record');
            }
            matches.push(valueToken);
          }
        }
      }
      index = token.end - 1;
      continue;
    }
    if (byte === 0x7b || byte === 0x5b) depth += 1;
    else if (byte === 0x7d || byte === 0x5d) depth -= 1;
    if (depth < 0) throw new Error('JSON nesting became negative');
  }
  if (depth !== 0) throw new Error('JSON nesting is incomplete');
  if (matches.length !== 1) {
    throw new Error(`goal must contain exactly one top-level updatedAt string token; found ${matches.length}`);
  }
  return matches[0]!;
}

function repairedGoalRaw(raw: Buffer, goal: Goal, updatedAt: string): Buffer {
  const token = topLevelUpdatedAtToken(raw, goal.updatedAt);
  const replacement = Buffer.from(JSON.stringify(updatedAt), 'utf8');
  const repairedRaw = Buffer.concat([
    raw.subarray(0, token.start),
    replacement,
    raw.subarray(token.end),
  ]);
  let repaired: unknown;
  try { repaired = JSON.parse(repairedRaw.toString('utf8')); } catch {
    throw new Error(`repaired goal is not valid JSON: ${goal.id}`);
  }
  if (!isValidGoalRecord(repaired)) {
    throw new Error(`repaired goal failed strict validation: ${goal.id}`);
  }
  const expected = structuredClone(goal);
  expected.updatedAt = updatedAt;
  if (goalSnapshotDigest(repaired) !== goalSnapshotDigest(expected)) {
    throw new Error(`repaired goal changed outside updatedAt: ${goal.id}`);
  }
  return repairedRaw;
}

function canonicalGoalAfterRepair(goal: Goal, updatedAt: string): Goal {
  const repaired = structuredClone(goal);
  repaired.updatedAt = updatedAt;
  if (!isValidGoalRecord(repaired)) {
    throw new Error(`repaired goal failed strict validation: ${goal.id}`);
  }
  return repaired;
}

function readStableGoal(path: string, fileName: string): StableGoalFile {
  assureDarwinSourcePath(path, 'file');
  const raw = readStableFile(path, MAX_GOAL_FILE_BYTES);
  assureDarwinSourcePath(path, 'file');
  const text = raw.toString('utf8');
  if (!raw.equals(Buffer.from(text, 'utf8'))) throw new Error(`goal file is not valid UTF-8: ${fileName}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`goal file is not valid JSON: ${fileName}`);
  }
  if (!isValidGoalRecordForTimestampRepair(parsed)) {
    throw new Error(`goal file is structurally invalid: ${fileName}`);
  }
  if (`${parsed.id}.json` !== fileName) throw new Error(`goal filename/id mismatch: ${fileName}`);
  const derivedUpdatedAt = derivedGoalUpdatedAt(parsed);
  const repairedRaw = repairedGoalRaw(raw, parsed, derivedUpdatedAt);
  return {
    fileName,
    raw,
    rawDigest: digest(raw),
    goal: parsed,
    derivedUpdatedAt,
    repairedRaw,
    repairedDigest: digest(repairedRaw),
  };
}

function safeSourceDirectory(stat: BigIntStats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && ownedByCurrentUser(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o022n) === 0n);
}

function lstatPresentOrMissing(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function pinSourceAncestry(): SourceAncestrySnapshot {
  const home = resolve(homedir());
  const ashlr = join(home, '.ashlr');
  const goals = resolve(goalsDir());
  if (goals !== join(ashlr, 'goals')) throw new Error('goal source path escaped its expected ancestry');
  const present: StableDirectoryIdentity[] = [];
  const absent: string[] = [];
  for (const path of [home, ashlr, goals]) {
    const stat = lstatPresentOrMissing(path);
    if (stat === null) {
      if (path === home) throw new Error('goal source home directory is missing');
      absent.push(path);
      continue;
    }
    if (!safeSourceDirectory(stat)) throw new Error(`goal source ancestry is unsafe: ${path}`);
    assureDarwinSourcePath(path, 'directory');
    present.push({
      path,
      dev: stat.dev,
      ino: stat.ino,
      trackMembership: path === goals,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    });
  }
  const ashlrPresent = present.some((identity) => identity.path === ashlr);
  const goalsPresent = present.some((identity) => identity.path === goals);
  if (goalsPresent && !ashlrPresent) throw new Error('goal source ancestry changed while being pinned');
  return { present, absent, goalsPresent };
}

function verifySourceAncestry(snapshot: SourceAncestrySnapshot): void {
  for (const path of snapshot.absent) {
    const stat = lstatPresentOrMissing(path);
    if (stat !== null) throw new Error(`absent goal source ancestry appeared during read: ${path}`);
  }
  for (const identity of snapshot.present) {
    const stat = lstatSync(identity.path, { bigint: true });
    if (
      !safeSourceDirectory(stat) || stat.dev !== identity.dev || stat.ino !== identity.ino ||
      (identity.trackMembership && (
        stat.mtimeNs !== identity.mtimeNs || stat.ctimeNs !== identity.ctimeNs
      ))
    ) throw new Error(`goal source ancestry changed during read: ${identity.path}`);
    assureDarwinSourcePath(identity.path, 'directory');
  }
}

function readCompleteGoalSet(): StableGoalFile[] {
  const dir = goalsDir();
  const ancestry = pinSourceAncestry();
  if (!ancestry.goalsPresent) {
    verifySourceAncestry(ancestry);
    return [];
  }
  const handle = opendirSync(dir);
  const names: string[] = [];
  let entries = 0;
  try {
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) break;
      entries += 1;
      if (entries > MAX_DIRECTORY_ENTRIES) throw new Error('goal source directory entry limit exceeded');
      if (!entry.name.endsWith('.json') || entry.name.endsWith('.tmp')) continue;
      names.push(entry.name);
      if (names.length > MAX_GOAL_FILES) throw new Error('goal source file limit exceeded');
    }
  } finally {
    handle.closeSync();
  }
  names.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const identities = new Set<string>();
  const files = names.map((name) => {
    const goal = readStableGoal(join(dir, name), name);
    const identity = process.platform === 'win32' ? goal.goal.id.toLowerCase() : goal.goal.id;
    if (identities.has(identity)) throw new Error(`duplicate goal identity: ${goal.goal.id}`);
    identities.add(identity);
    return goal;
  });
  verifySourceAncestry(ancestry);
  return files;
}

function planBody(files: readonly StableGoalFile[]): GoalTimestampRepairPlanBody {
  const entries = files.map((file): GoalTimestampRepairPlanEntry => ({
    goalId: file.goal.id,
    fileName: file.fileName,
    beforeDigest: file.rawDigest,
    afterDigest: file.goal.updatedAt === file.derivedUpdatedAt ? file.rawDigest : file.repairedDigest,
    previousUpdatedAt: file.goal.updatedAt,
    derivedUpdatedAt: file.derivedUpdatedAt,
    repairRequired: file.goal.updatedAt !== file.derivedUpdatedAt,
  }));
  const sourceDigest = digest(JSON.stringify(entries.map((entry) => ({
    fileName: entry.fileName,
    beforeDigest: entry.beforeDigest,
  }))));
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'goal-timestamp-repair',
    sourceDigest,
    scannedGoals: entries.length,
    entries,
  };
}

function materializePlan(files: readonly StableGoalFile[]): GoalTimestampRepairPlan {
  const body = planBody(files);
  return { ...body, planId: digest(JSON.stringify(body)) };
}

function validatePlan(value: unknown, expectedPlanId: string): GoalTimestampRepairPlan {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('stored timestamp-repair plan is malformed');
  }
  const plan = value as GoalTimestampRepairPlan;
  if (
    plan.schemaVersion !== SCHEMA_VERSION || plan.kind !== 'goal-timestamp-repair' ||
    plan.planId !== expectedPlanId || !Array.isArray(plan.entries) ||
    !Number.isSafeInteger(plan.scannedGoals) || plan.scannedGoals !== plan.entries.length
  ) throw new Error('stored timestamp-repair plan is malformed');
  const seenFiles = new Set<string>();
  const seenGoals = new Set<string>();
  let previousFileName: string | undefined;
  for (const entry of plan.entries) {
    if (
      typeof entry !== 'object' || entry === null ||
      typeof entry.goalId !== 'string' || !/^[\w.-]+$/.test(entry.goalId) ||
      entry.fileName !== `${entry.goalId}.json` ||
      typeof entry.beforeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.beforeDigest) ||
      typeof entry.afterDigest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.afterDigest) ||
      typeof entry.previousUpdatedAt !== 'string' || !Number.isFinite(Date.parse(entry.previousUpdatedAt)) ||
      typeof entry.derivedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(entry.derivedUpdatedAt)) ||
      typeof entry.repairRequired !== 'boolean' ||
      (entry.repairRequired ? entry.beforeDigest === entry.afterDigest : entry.beforeDigest !== entry.afterDigest) ||
      seenFiles.has(entry.fileName) || seenGoals.has(entry.goalId) ||
      (previousFileName !== undefined && previousFileName >= entry.fileName)
    ) throw new Error('stored timestamp-repair plan contains an invalid entry');
    seenFiles.add(entry.fileName);
    seenGoals.add(entry.goalId);
    previousFileName = entry.fileName;
  }
  const expectedSourceDigest = digest(JSON.stringify(plan.entries.map((entry) => ({
    fileName: entry.fileName,
    beforeDigest: entry.beforeDigest,
  }))));
  if (plan.sourceDigest !== expectedSourceDigest) throw new Error('stored timestamp-repair source digest mismatch');
  const { planId: _planId, ...body } = plan;
  if (digest(JSON.stringify(body)) !== expectedPlanId) throw new Error('stored timestamp-repair plan digest mismatch');
  return plan;
}

function repairRoot(): string {
  return join(goalsDir(), REPAIR_ROOT);
}

function goalLockPath(goalId: string): string {
  return join(goalsDir(), `.${digest(goalId)}.lock`);
}

function planArtifactId(planId: string): string {
  return `plan-${planId}`;
}

function backupArtifactId(planId: string, goalId: string): string {
  return `backup-${planId}-${digest(goalId).slice(0, 32)}`;
}

function receiptArtifactId(planId: string, goalId: string): string {
  return `receipt-${planId}-${digest(goalId).slice(0, 32)}`;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArtifact(value: unknown): TimestampRepairArtifact | null {
  try {
    if (!isRecord(value) || value['schemaVersion'] !== SCHEMA_VERSION ||
      typeof value['kind'] !== 'string' || typeof value['artifactId'] !== 'string') return null;
    if (value['kind'] === 'goal-timestamp-repair-plan') {
      if (!exactKeys(value, ['schemaVersion', 'kind', 'artifactId', 'plan']) ||
        typeof value['artifactId'] !== 'string' || !value['artifactId'].startsWith('plan-')) return null;
      const planId = value['artifactId'].slice('plan-'.length);
      const plan = validatePlan(value['plan'], planId);
      return { schemaVersion: SCHEMA_VERSION, kind: value['kind'], artifactId: value['artifactId'], plan };
    }
    if (value['kind'] === 'goal-timestamp-repair-raw-backup') {
      if (!exactKeys(value, [
        'schemaVersion', 'kind', 'artifactId', 'planId', 'goalId', 'rawDigest', 'rawBase64',
      ]) ||
        typeof value['planId'] !== 'string' || !/^[a-f0-9]{64}$/.test(value['planId']) ||
        typeof value['goalId'] !== 'string' || !/^[\w.-]+$/.test(value['goalId']) ||
        typeof value['rawDigest'] !== 'string' || !/^[a-f0-9]{64}$/.test(value['rawDigest']) ||
        typeof value['rawBase64'] !== 'string' ||
        value['artifactId'] !== backupArtifactId(value['planId'], value['goalId'])) return null;
      const raw = Buffer.from(value['rawBase64'], 'base64');
      if (raw.length < 1 || raw.length > MAX_GOAL_FILE_BYTES ||
        raw.toString('base64') !== value['rawBase64'] || digest(raw) !== value['rawDigest']) return null;
      return value as unknown as StoredRawBackup;
    }
    if (value['kind'] === 'goal-timestamp-repair-receipt') {
      if (!exactKeys(value, [
        'schemaVersion', 'kind', 'artifactId', 'planId', 'goalId', 'beforeDigest', 'afterDigest',
        'derivedUpdatedAt',
      ]) ||
        typeof value['planId'] !== 'string' || !/^[a-f0-9]{64}$/.test(value['planId']) ||
        typeof value['goalId'] !== 'string' || !/^[\w.-]+$/.test(value['goalId']) ||
        typeof value['beforeDigest'] !== 'string' || !/^[a-f0-9]{64}$/.test(value['beforeDigest']) ||
        typeof value['afterDigest'] !== 'string' || !/^[a-f0-9]{64}$/.test(value['afterDigest']) ||
        typeof value['derivedUpdatedAt'] !== 'string' ||
        !Number.isFinite(Date.parse(value['derivedUpdatedAt'])) ||
        value['artifactId'] !== receiptArtifactId(value['planId'], value['goalId'])) return null;
      return value as unknown as StoredReceipt;
    }
    return null;
  } catch {
    return null;
  }
}

function artifactCodec(): ImmutablePrivateRecordCodec<TimestampRepairArtifact> {
  return {
    parse: parseArtifact,
    serialize: (artifact) => `${JSON.stringify(artifact)}\n`,
    recordId: (artifact) => artifact.artifactId,
    recordFileName: (artifact) => `${artifact.artifactId}.json`,
    isRecordFileName: (fileName) => /^(?:plan|backup|receipt)-[a-f0-9-]+\.json$/.test(fileName),
    stageToken: (artifact) => digest(`goal-timestamp-repair-stage:${JSON.stringify(artifact)}`).slice(0, 32),
    equivalent: (left, right) => JSON.stringify(left) === JSON.stringify(right),
  };
}

function artifactStoreConfig(): ImmutablePrivateRecordStoreConfig<TimestampRepairArtifact> {
  return {
    label: 'goal timestamp repair artifact',
    anchorPath: goalsDir(),
    rootPath: repairRoot(),
    lockFileName: '.goal-timestamp-repair-artifacts.lock',
    maxRecordBytes: MAX_ARTIFACT_BYTES,
    defaultMaxFiles: 512,
    hardMaxFiles: 1_024,
    defaultMaxBytes: 64 * 1024 * 1024,
    hardMaxBytes: 256 * 1024 * 1024,
    codecForWrite: artifactCodec,
    codecForRead: artifactCodec,
  };
}

function readArtifact(artifactId: string): TimestampRepairArtifact | null {
  const result = readImmutablePrivateRecordPoint(
    artifactStoreConfig(), artifactId, `${artifactId}.json`,
  );
  if (result.sourceState === 'missing' ||
    (result.sourceState === 'healthy' && result.exactReadComplete && result.record === null)) return null;
  if (result.sourceState !== 'healthy' || !result.exactReadComplete || !result.record) {
    throw new Error(`timestamp-repair artifact store is degraded: ${result.stopReasons.join(',')}`);
  }
  return result.record;
}

function writeArtifact(artifact: TimestampRepairArtifact): void {
  const disposition = writeImmutablePrivateRecord(artifactStoreConfig(), artifact);
  if (disposition !== 'recorded' && disposition !== 'replayed') {
    throw new Error(`timestamp-repair artifact persistence ${disposition}: ${artifact.artifactId}`);
  }
  const persisted = readArtifact(artifact.artifactId);
  if (!persisted || JSON.stringify(persisted) !== JSON.stringify(artifact)) {
    throw new Error(`timestamp-repair artifact verification failed: ${artifact.artifactId}`);
  }
}

function recoverArtifactStore(): void {
  const disposition = recoverImmutablePrivateRecordStore(artifactStoreConfig());
  if (disposition !== 'missing' && disposition !== 'clean' && disposition !== 'recovered') {
    throw new Error(`timestamp-repair artifact recovery ${disposition}`);
  }
}

function storedPlan(planId: string): GoalTimestampRepairPlan | null {
  const artifact = readArtifact(planArtifactId(planId));
  if (artifact === null) return null;
  if (artifact.kind !== 'goal-timestamp-repair-plan' || artifact.plan.planId !== planId) {
    throw new Error('stored timestamp-repair plan artifact mismatch');
  }
  return artifact.plan;
}

function planRecord(plan: GoalTimestampRepairPlan): StoredPlan {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'goal-timestamp-repair-plan',
    artifactId: planArtifactId(plan.planId),
    plan,
  };
}

function backupRecord(planId: string, goalId: string, raw: Buffer): StoredRawBackup {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'goal-timestamp-repair-raw-backup',
    artifactId: backupArtifactId(planId, goalId),
    planId,
    goalId,
    rawDigest: digest(raw),
    rawBase64: raw.toString('base64'),
  };
}

function readBackup(planId: string, goalId: string): StoredRawBackup | null {
  const artifact = readArtifact(backupArtifactId(planId, goalId));
  if (artifact === null) return null;
  if (artifact.kind !== 'goal-timestamp-repair-raw-backup' ||
    artifact.planId !== planId || artifact.goalId !== goalId) {
    throw new Error(`timestamp-repair backup artifact mismatch: ${goalId}`);
  }
  return artifact;
}

function filesByName(files: readonly StableGoalFile[]): Map<string, StableGoalFile> {
  return new Map(files.map((file) => [file.fileName, file]));
}

function preflightStoredPlan(plan: GoalTimestampRepairPlan, files: readonly StableGoalFile[]): void {
  if (files.length !== plan.entries.length) throw new Error('goal source set changed after timestamp-repair planning');
  const current = filesByName(files);
  for (const entry of plan.entries) {
    const file = current.get(entry.fileName);
    if (!file || file.goal.id !== entry.goalId) {
      throw new Error(`goal source membership changed: ${entry.fileName}`);
    }
    const before = file.rawDigest === entry.beforeDigest;
    const after = entry.repairRequired && file.rawDigest === entry.afterDigest;
    if (!before && !after) throw new Error(`goal changed outside repair plan: ${entry.goalId}`);
    if (!entry.repairRequired && !before) throw new Error(`non-target goal changed: ${entry.goalId}`);
    if (after) {
      const backup = readBackup(plan.planId, entry.goalId);
      if (!backup || backup.rawDigest !== entry.beforeDigest) {
        throw new Error(`repaired goal lacks its exact raw backup: ${entry.goalId}`);
      }
    }
  }
}

function receiptFor(plan: GoalTimestampRepairPlan, entry: GoalTimestampRepairPlanEntry): StoredReceipt {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'goal-timestamp-repair-receipt',
    artifactId: receiptArtifactId(plan.planId, entry.goalId),
    planId: plan.planId,
    goalId: entry.goalId,
    beforeDigest: entry.beforeDigest,
    afterDigest: entry.afterDigest,
    derivedUpdatedAt: entry.derivedUpdatedAt,
  };
}

/** Build an exact deterministic repair plan without changing the filesystem. */
export function dryRunGoalTimestampRepair(): GoalTimestampRepairDryRunResult {
  assertSupportedCustodyPlatform();
  const files = readCompleteGoalSet();
  const plan = materializePlan(files);
  return {
    mode: 'dry-run',
    planId: plan.planId,
    scannedGoals: plan.scannedGoals,
    repairableGoals: plan.entries.filter((entry) => entry.repairRequired).length,
    entries: plan.entries,
  };
}

/** Apply or resume the exact plan identified by `planId`. */
export function applyGoalTimestampRepair(planId: string): GoalTimestampRepairApplyResult {
  assertSupportedCustodyPlatform();
  if (!/^[a-f0-9]{64}$/.test(planId)) throw new Error('timestamp-repair plan id must be 64 lowercase hex characters');

  let files = readCompleteGoalSet();
  if (existsSync(repairRoot())) recoverArtifactStore();
  let plan = storedPlan(planId);
  files = readCompleteGoalSet();
  if (!plan) {
    const candidate = materializePlan(files);
    if (candidate.planId !== planId) throw new Error('timestamp-repair plan id does not match the current complete goal set');
    writeArtifact(planRecord(candidate));
    plan = candidate;
  }

  files = readCompleteGoalSet();
  preflightStoredPlan(plan, files);

  let repairedGoals = 0;
  let alreadyAppliedGoals = 0;
  let receiptCount = 0;
  for (const entry of plan.entries.filter((candidate) => candidate.repairRequired)) {
    const lock = acquireLocalStoreLock(goalLockPath(entry.goalId), LOCK_WAIT_MS);
    if (!lock) throw new Error(`could not acquire goal repair lock: ${entry.goalId}`);
    let operationFailure: unknown;
    let released = false;
    try {
      const target = join(goalsDir(), entry.fileName);
      const current = readStableGoal(target, entry.fileName);
      if (current.rawDigest === entry.afterDigest) {
        const backup = readBackup(planId, entry.goalId);
        if (!backup || backup.rawDigest !== entry.beforeDigest) {
          throw new Error(`repaired goal lacks its exact raw backup: ${entry.goalId}`);
        }
        writeArtifact(receiptFor(plan, entry));
        alreadyAppliedGoals += 1;
        receiptCount += 1;
      } else {
        if (current.rawDigest !== entry.beforeDigest || current.derivedUpdatedAt !== entry.derivedUpdatedAt) {
          throw new Error(`goal changed after timestamp-repair preflight: ${entry.goalId}`);
        }

        writeArtifact(backupRecord(planId, entry.goalId, current.raw));
        const repaired = canonicalGoalAfterRepair(current.goal, entry.derivedUpdatedAt);
        const repairedRaw = repairedGoalRaw(current.raw, current.goal, entry.derivedUpdatedAt);
        if (digest(repairedRaw) !== entry.afterDigest) throw new Error(`repair output digest mismatch: ${entry.goalId}`);
        const temporary = `${target}.${process.pid}.${randomBytes(12).toString('hex')}.repair.tmp`;
        writePrivateFileAtomically(temporary, target, repairedRaw, {
          anchorPath: goalsDir(),
          label: `goal timestamp repair ${entry.goalId}`,
        });
        const installed = readStableGoal(target, entry.fileName);
        if (installed.rawDigest !== entry.afterDigest || goalSnapshotDigest(installed.goal) !== goalSnapshotDigest(repaired)) {
          throw new Error(`installed timestamp repair failed verification: ${entry.goalId}`);
        }
        writeArtifact(receiptFor(plan, entry));
        repairedGoals += 1;
        receiptCount += 1;
      }
    } catch (error) {
      operationFailure = error;
    } finally {
      released = releaseLocalStoreLock(lock);
    }
    if (operationFailure !== undefined) throw operationFailure;
    if (!released) throw new Error(`goal repair lock release could not be verified: ${entry.goalId}`);
  }

  preflightStoredPlan(plan, readCompleteGoalSet());
  return {
    mode: 'apply',
    planId,
    scannedGoals: plan.scannedGoals,
    repairableGoals: plan.entries.filter((entry) => entry.repairRequired).length,
    repairedGoals,
    alreadyAppliedGoals,
    receiptCount,
    entries: plan.entries,
  };
}
