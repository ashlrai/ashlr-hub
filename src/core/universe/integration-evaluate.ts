import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { readImmutablePrivateRecords, writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec, type ImmutablePrivateRecordStoreConfig } from '../util/immutable-private-record-store.js';
import { artifactDigest, canonical, copyArtifact, defaultUniverseRoot, digest, freezeArtifact, privateDirectory,
  type UniverseArtifactEntry } from './artifacts.js';
import { deliveryGit, type GitTreeEntry } from './delivery-git.js';
import { assertUniverseExecution, withUniverseExecution } from './execution.js';
import { runFixedUniverseEvaluator } from './fixed-evaluator.js';
import { readUniverseIntegrationPlan, validateUniverseIntegrationDefinition } from './integration-plan.js';
import type { UniverseIntegrationEvaluationEvidence, UniverseIntegrationEvaluationRequest,
  UniverseIntegrationEvaluationResult } from './integration-evaluation-types.js';
import { assertComparatorUnchanged, manifestRecord, parseEvaluation, projectUniverse, universePath } from './store.js';
import type { UniverseStoreOptions } from './types.js';

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_ATTEMPTS = 128;
const RECEIPT_HEADROOM_BYTES = 32 * 1024;

class CompositionChangedError extends Error {}
class UnresolvedSettlementError extends Error {}

type AttemptRecord =
  { id: string; kind: 'intent'; request: UniverseIntegrationEvaluationRequest; requestDigest: string; startedAt: string } |
  { id: string; kind: 'receipt'; request: UniverseIntegrationEvaluationRequest; requestDigest: string; startedAt: string; result: UniverseIntegrationEvaluationResult };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every((key) => typeof key === 'string' && keys.includes(key));
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function validMetrics(value: unknown): value is Record<string, number> {
  return object(value) && Object.keys(value).length <= 32 && Object.entries(value).every(([key, item]) =>
    /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(key) && typeof item === 'number' && Number.isFinite(item));
}
function requestDigest(request: UniverseIntegrationEvaluationRequest): string {
  return digest(canonical({ domain: 'universe-integration-evaluation-v1', request }));
}
function resultDigest(result: UniverseIntegrationEvaluationResult): string {
  return digest(canonical({ domain: 'universe-integration-evaluation-result-v1', result }));
}

/** Validate a closed, portable request before reading any acceptance or delivery evidence. */
export function validateUniverseIntegrationEvaluationRequest(value: unknown): UniverseIntegrationEvaluationRequest {
  const acceptance = object(value) && object(value.acceptance) ? value.acceptance : null;
  if (!object(value) || !exact(value, ['schemaVersion', 'id', 'integration', 'expectedCompositionDigest', 'acceptance', 'maxDurationMs']) ||
      value.schemaVersion !== 1 || typeof value.id !== 'string' || !ID.test(value.id) ||
      typeof value.expectedCompositionDigest !== 'string' || !HASH.test(value.expectedCompositionDigest) ||
      !acceptance || !exact(acceptance, ['universeId', 'manifestDigest', 'comparatorDigest']) ||
      typeof acceptance.universeId !== 'string' || !ID.test(acceptance.universeId) ||
      !['manifestDigest', 'comparatorDigest'].every((key) => typeof acceptance[key] === 'string' && HASH.test(acceptance[key] as string)) ||
      !Number.isSafeInteger(value.maxDurationMs) || (value.maxDurationMs as number) < 1 || (value.maxDurationMs as number) > 120_000) {
    throw new Error('Invalid Universe integration evaluation request');
  }
  const integration = validateUniverseIntegrationDefinition(value.integration);
  return { schemaVersion: 1, id: value.id as string, integration, expectedCompositionDigest: value.expectedCompositionDigest as string,
    acceptance: { universeId: acceptance.universeId as string, manifestDigest: acceptance.manifestDigest as string,
      comparatorDigest: acceptance.comparatorDigest as string }, maxDurationMs: value.maxDurationMs as number };
}

function validResult(value: unknown): value is UniverseIntegrationEvaluationResult {
  const acceptance = object(value) && object(value.acceptance) ? value.acceptance : null;
  if (!object(value) || !exact(value, ['schemaVersion', 'id', 'requestDigest', 'status', 'startedAt', 'finishedAt', 'durationMs',
    'acceptance', 'compositionDigest', 'artifactDigest', 'artifactPath', 'score', 'metrics', 'reason']) || value.schemaVersion !== 1 ||
    typeof value.id !== 'string' || !ID.test(value.id) || typeof value.requestDigest !== 'string' || !HASH.test(value.requestDigest) ||
    !['passed', 'rejected', 'failed', 'timed-out', 'cancelled'].includes(String(value.status)) || !timestamp(value.startedAt) ||
    !timestamp(value.finishedAt) || typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0 ||
    !acceptance || !exact(acceptance, ['universeId', 'manifestDigest', 'comparatorDigest']) ||
    typeof acceptance.universeId !== 'string' || !ID.test(acceptance.universeId) ||
    !['manifestDigest', 'comparatorDigest'].every((key) => typeof acceptance[key] === 'string' && HASH.test(acceptance[key] as string)) ||
    typeof value.compositionDigest !== 'string' || !HASH.test(value.compositionDigest) || !validMetrics(value.metrics) ||
    ![null, 'rejected-by-fixed-evaluator', 'composition-changed', 'evaluator-failed', 'evaluation-timed-out', 'evaluation-cancelled',
      'candidate-materialization-failed'].includes(value.reason as string | null)) return false;
  const measured = value.status === 'passed' || value.status === 'rejected';
  if (value.status === 'passed' && value.reason !== null) return false;
  if (value.status === 'rejected' && value.reason !== 'rejected-by-fixed-evaluator') return false;
  if (value.status === 'failed' && !['composition-changed', 'evaluator-failed', 'candidate-materialization-failed'].includes(String(value.reason))) return false;
  if (value.status === 'timed-out' && value.reason !== 'evaluation-timed-out') return false;
  if (value.status === 'cancelled' && value.reason !== 'evaluation-cancelled') return false;
  return measured ? typeof value.artifactDigest === 'string' && HASH.test(value.artifactDigest) && typeof value.artifactPath === 'string' &&
    value.artifactPath.length > 0 && value.artifactPath.length <= 4_096 && typeof value.score === 'number' && Number.isFinite(value.score) :
    value.artifactDigest === null && value.artifactPath === null && value.score === null && Object.keys(value.metrics).length === 0;
}
function parse(value: unknown): AttemptRecord | null {
  if (!object(value) || !exact(value, ['id', 'kind', 'request', 'requestDigest', 'startedAt', 'result']) ||
      !['intent', 'receipt'].includes(String(value.kind)) || typeof value.id !== 'string' || typeof value.requestDigest !== 'string' ||
      !HASH.test(value.requestDigest) || !timestamp(value.startedAt)) return null;
  let request: UniverseIntegrationEvaluationRequest;
  try { request = validateUniverseIntegrationEvaluationRequest(value.request); } catch { return null; }
  if (requestDigest(request) !== value.requestDigest || value.id !== `${value.requestDigest}.${value.kind}`) return null;
  if (value.kind === 'intent') return value.result === null ? { id: value.id, kind: 'intent', request, requestDigest: value.requestDigest, startedAt: value.startedAt } : null;
  return validResult(value.result) && value.result.id === request.id && value.result.requestDigest === value.requestDigest &&
    value.result.startedAt === value.startedAt && canonical(value.result.acceptance) === canonical(request.acceptance) &&
    value.result.compositionDigest === request.expectedCompositionDigest ?
    { id: value.id, kind: 'receipt', request, requestDigest: value.requestDigest, startedAt: value.startedAt, result: value.result } : null;
}
const codec: ImmutablePrivateRecordCodec<AttemptRecord> = {
  parse, serialize: (value) => `${canonical({ ...value, result: value.kind === 'intent' ? null : value.result })}\n`, recordId: (value) => value.id,
  recordFileName: (value) => `${value.id}.json`, isRecordFileName: (name) => /^[a-f0-9]{64}\.(?:intent|receipt)\.json$/.test(name),
  stageToken: (value) => digest(canonical(value)), equivalent: (left, right) => canonical(left) === canonical(right),
};
function config(directory: string): ImmutablePrivateRecordStoreConfig<AttemptRecord> {
  return { label: 'Universe integration evaluation', anchorPath: directory, rootPath: join(directory, 'integration-evaluations'),
    lockFileName: '.records.lock', maxRecordBytes: 256 * 1024, defaultMaxFiles: MAX_ATTEMPTS * 2, hardMaxFiles: MAX_ATTEMPTS * 2,
    defaultMaxBytes: 32 * 1024 * 1024, hardMaxBytes: 32 * 1024 * 1024, codecForRead: () => codec, codecForWrite: () => codec };
}
function hasEvidenceCapacity(directory: string, existing: AttemptRecord[], request: UniverseIntegrationEvaluationRequest,
  requestDigestValue: string, startedAt: string): boolean {
  const intent: AttemptRecord = { id: `${requestDigestValue}.intent`, kind: 'intent', request, requestDigest: requestDigestValue, startedAt };
  const intentBytes = Buffer.byteLength(codec.serialize(intent), 'utf8');
  // The receipt repeats the exact request, then can add a 4KiB path, 32
  // 80-character metric keys, and all fixed result fields. A 32KiB reserve is
  // deliberately larger than that protocol maximum, including numeric syntax.
  const receiptReserve = Buffer.byteLength(canonical(request), 'utf8') + RECEIPT_HEADROOM_BYTES;
  const limits = config(directory);
  const used = existing.reduce((sum, item) => sum + Buffer.byteLength(codec.serialize(item), 'utf8'), 0);
  return intentBytes <= limits.maxRecordBytes && receiptReserve <= limits.maxRecordBytes &&
    used + intentBytes + receiptReserve <= limits.defaultMaxBytes;
}
function readAttempts(directory: string): AttemptRecord[] {
  const result = readImmutablePrivateRecords(config(directory), { requireComplete: true });
  if (result.sourceState === 'missing') return [];
  if (!result.complete || result.sourceState !== 'healthy') throw new Error('Integration evaluation evidence unavailable');
  const intents = new Map(result.records.filter((item): item is Extract<AttemptRecord, { kind: 'intent' }> => item.kind === 'intent')
    .map((item) => [item.requestDigest, item]));
  for (const item of result.records) {
    if (item.kind !== 'receipt') continue;
    const intent = intents.get(item.requestDigest);
    if (!intent || intent.startedAt !== item.startedAt || canonical(intent.request) !== canonical(item.request)) {
      throw new Error('Integration evaluation evidence is structurally inconsistent');
    }
    const measured = item.result.status === 'passed' || item.result.status === 'rejected';
    const expectedPath = join(directory, 'integrations', item.requestDigest, 'artifact');
    if (measured && item.result.artifactPath !== expectedPath) throw new Error('Integration evaluation evidence has an unexpected artifact path');
  }
  return result.records;
}
function assertNoUnresolvedAttempts(attempts: AttemptRecord[]): void {
  const settled = new Set(attempts.filter((item): item is Extract<AttemptRecord, { kind: 'receipt' }> => item.kind === 'receipt')
    .map((item) => item.requestDigest));
  if (attempts.some((item) => item.kind === 'intent' && !settled.has(item.requestDigest))) {
    throw new Error('Integration evaluation has an unresolved attempt; delivery is withheld pending reconciliation');
  }
}

/** Verify that no potentially live integration evaluator remains for this acceptance Universe. */
export function assertUniverseIntegrationEvaluationsSettled(universeId: string, options: UniverseStoreOptions = {}): void {
  if (!ID.test(universeId)) throw new Error('Invalid Universe integration evaluation acceptance id');
  const root = resolve(options.root ?? defaultUniverseRoot());
  assertNoUnresolvedAttempts(readAttempts(universePath(root, universeId)));
}

/** Read one settled integration evaluation without executing an evaluator or changing durable state. */
export function readUniverseIntegrationEvaluation(input: unknown,
  options: UniverseStoreOptions = {}): UniverseIntegrationEvaluationEvidence {
  const request = validateUniverseIntegrationEvaluationRequest(input);
  const root = resolve(options.root ?? defaultUniverseRoot());
  const directory = universePath(root, request.acceptance.universeId);
  const requestDigestValue = requestDigest(request);
  const attempt = readAttempts(directory).find((item) => item.kind === 'receipt' && item.requestDigest === requestDigestValue);
  if (!attempt || attempt.kind !== 'receipt') throw new Error('Integration evaluation receipt is unavailable');
  const plan = readUniverseIntegrationPlan(request.integration, { root });
  if (!plan.compositionReady || plan.compositionDigest !== request.expectedCompositionDigest) {
    throw new Error('Integration evaluation composition evidence changed');
  }
  const record = manifestRecord(directory);
  if (record.manifestDigest !== request.acceptance.manifestDigest || record.comparatorDigest !== request.acceptance.comparatorDigest) {
    throw new Error('Integration evaluation acceptance evidence changed');
  }
  assertComparatorUnchanged(record);
  if (attempt.result.artifactPath !== null && (attempt.result.artifactDigest === null ||
      artifactDigest(attempt.result.artifactPath) !== attempt.result.artifactDigest)) {
    throw new Error('Integration evaluation artifact changed');
  }
  return JSON.parse(canonical({ request, result: attempt.result, resultDigest: resultDigest(attempt.result) })) as UniverseIntegrationEvaluationEvidence;
}
function persist(directory: string, value: AttemptRecord): void {
  const disposition = writeImmutablePrivateRecord(config(directory), value);
  if (!['recorded', 'replayed'].includes(disposition)) throw new Error('Integration evaluation evidence could not be durably written');
}
function statusFor(signal: AbortSignal, timedOut: boolean): 'timed-out' | 'cancelled' | null {
  return timedOut ? 'timed-out' : signal.aborted ? 'cancelled' : null;
}
function emptyResult(request: UniverseIntegrationEvaluationRequest, requestDigestValue: string, startedAt: string,
  status: UniverseIntegrationEvaluationResult['status'], reason: NonNullable<UniverseIntegrationEvaluationResult['reason']>): UniverseIntegrationEvaluationResult {
  return { schemaVersion: 1, id: request.id, requestDigest: requestDigestValue, status, startedAt, finishedAt: new Date().toISOString(),
    durationMs: 0, acceptance: { ...request.acceptance }, compositionDigest: request.expectedCompositionDigest,
    artifactDigest: null, artifactPath: null, score: null, metrics: {}, reason };
}
function finalEntries(request: UniverseIntegrationEvaluationRequest, deadline: number, root: string): { git: ReturnType<typeof deliveryGit>; entries: GitTreeEntry[] } {
  if (performance.now() >= deadline) throw new Error('deadline');
  const git = deliveryGit(request.integration.target.repo, deadline);
  const base = new Map(git.entries(request.integration.target.baseCommit).map((entry) => [entry.path, entry]));
  const plan = readUniverseIntegrationPlan(request.integration, { root });
  if (!plan.compositionReady || plan.compositionDigest !== request.expectedCompositionDigest) throw new CompositionChangedError();
  for (const entry of plan.entries) {
    if (entry.oid === null) base.delete(entry.path);
    else base.set(entry.path, { path: entry.path, oid: entry.oid, executable: entry.executable! });
  }
  return { git, entries: [...base.values()].sort((left, right) => left.path.localeCompare(right.path)) };
}
function materialize(entries: UniverseArtifactEntry[], path: string): string {
  if (existsSync(path)) throw new Error('existing candidate');
  mkdirSync(path, { mode: 0o700 });
  for (const entry of entries) {
    const target = join(path, entry.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, entry.data, { flag: 'wx', mode: entry.executable ? 0o700 : 0o600 });
  }
  freezeArtifact(path);
  return artifactDigest(path);
}
function evaluatorEnvironment(record: ReturnType<typeof manifestRecord>, candidate: string, scratch: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: scratch, TMPDIR: `${scratch}/`, TMP: scratch, TEMP: scratch,
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NO_COLOR: '1', CI: '1',
    ASHLR_UNIVERSE_OBJECTIVE: record.manifest.objective, ASHLR_UNIVERSE_GENERATION: '0',
    ASHLR_UNIVERSE_CANDIDATE: candidate, ASHLR_UNIVERSE_SCRATCH: scratch,
    ASHLR_UNIVERSE_SEED: record.seedArtifact.path, ASHLR_UNIVERSE_PARENT_TRIAL: '' };
}

/** One durable, non-retrying local composition evaluation; never selects an elite or writes a ref. */
export async function evaluateUniverseIntegration(input: unknown,
  options: UniverseStoreOptions & { signal?: AbortSignal } = {}): Promise<UniverseIntegrationEvaluationResult> {
  const request = validateUniverseIntegrationEvaluationRequest(input);
  const root = resolve(options.root ?? defaultUniverseRoot());
  const requestDigestValue = requestDigest(request);
  return withUniverseExecution(request.acceptance.universeId, { root }, async (lock) => {
    const directory = universePath(root, request.acceptance.universeId);
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const deadline = started + request.maxDurationMs;
    const controller = new AbortController();
    let timedOut = false;
    const cancel = (): void => controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, request.maxDurationMs);
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) controller.abort();
    const check = (): void => {
      if (performance.now() >= deadline) { timedOut = true; controller.abort(); }
      if (timedOut) throw new Error('deadline');
      if (controller.signal.aborted) throw new Error('cancelled');
    };
    try {
      assertUniverseExecution(directory, lock);
      check();
      const attempts = readAttempts(directory);
      const sameId = attempts.filter((attempt) => attempt.request.id === request.id);
      if (sameId.some((attempt) => attempt.requestDigest !== requestDigestValue)) throw new Error('Integration evaluation request id is already bound');
      const existing = attempts.find((attempt) => attempt.requestDigest === requestDigestValue && attempt.kind === 'receipt');
      if (existing?.kind === 'receipt') {
        const current = readUniverseIntegrationPlan(request.integration, { root });
        if (!current.compositionReady || current.compositionDigest !== request.expectedCompositionDigest) throw new CompositionChangedError();
        check(); assertUniverseExecution(directory, lock);
        const record = manifestRecord(directory);
        if (record.manifestDigest !== request.acceptance.manifestDigest || record.comparatorDigest !== request.acceptance.comparatorDigest) {
          throw new Error('Integration evaluation acceptance evidence changed');
        }
        assertComparatorUnchanged(record);
        if (existing.result.artifactPath !== null && (existing.result.artifactDigest === null ||
          artifactDigest(existing.result.artifactPath) !== existing.result.artifactDigest)) throw new Error('Integration evaluation artifact changed');
        return existing.result;
      }
      const intents = attempts.filter((attempt): attempt is Extract<AttemptRecord, { kind: 'intent' }> => attempt.kind === 'intent');
      const settled = new Set(attempts.filter((attempt): attempt is Extract<AttemptRecord, { kind: 'receipt' }> => attempt.kind === 'receipt')
        .map((attempt) => attempt.requestDigest));
      if (intents.some((attempt) => !settled.has(attempt.requestDigest))) {
        throw new Error('Integration evaluation has an unresolved attempt; submit no new request until reconciled');
      }
      if (intents.length >= MAX_ATTEMPTS) throw new Error('Integration evaluation capacity exhausted');
      check();
      const record = manifestRecord(directory);
      const overview = projectUniverse(directory);
      if (overview.sourceState !== 'healthy' || overview.activeRun || record.manifestDigest !== request.acceptance.manifestDigest ||
          record.comparatorDigest !== request.acceptance.comparatorDigest || record.manifest.seed.repo !== request.integration.target.repo ||
          record.manifest.seed.revision !== request.integration.target.baseCommit) throw new Error('Integration evaluation acceptance preflight failed');
      assertComparatorUnchanged(record);
      const initial = readUniverseIntegrationPlan(request.integration, { root });
      if (!initial.compositionReady || initial.compositionDigest !== request.expectedCompositionDigest) throw new CompositionChangedError();
      if (!hasEvidenceCapacity(directory, attempts, request, requestDigestValue, startedAt)) {
        throw new Error('Integration evaluation receipt exceeds bounded evidence capacity');
      }
      check(); assertUniverseExecution(directory, lock);
      persist(directory, { id: `${requestDigestValue}.intent`, kind: 'intent', request, requestDigest: requestDigestValue, startedAt });
      const integrationRoot = join(directory, 'integrations', requestDigestValue);
      const candidatePath = join(integrationRoot, 'candidate');
      const artifactPath = join(integrationRoot, 'artifact');
      const evaluatorScratch = join(integrationRoot, 'evaluator');
      let artifactDigestValue: string | null = null;
      let evaluatorStarted = false;
      let result: UniverseIntegrationEvaluationResult;
      try {
        // If interruption occurs after intent but before any child starts, we
        // can safely settle it without leaving a needless unresolved hold.
        check(); assertUniverseExecution(directory, lock);
        privateDirectory(integrationRoot);
        privateDirectory(evaluatorScratch);
        const resolved = finalEntries(request, deadline, root);
        check();
        artifactDigestValue = materialize(resolved.git.readEntries(resolved.entries), candidatePath);
        if (copyArtifact(candidatePath, artifactPath) !== artifactDigestValue) throw new Error('materialization');
        freezeArtifact(artifactPath);
        if (artifactDigest(artifactPath) !== artifactDigestValue) throw new Error('materialization');
        check(); assertUniverseExecution(directory, lock);
        evaluatorStarted = true;
        const evaluation = await runFixedUniverseEvaluator(record, root, artifactPath, artifactDigestValue, evaluatorScratch,
          Math.max(1, Math.min(record.manifest.evaluation.timeoutMs, Math.floor(deadline - performance.now()))), controller.signal,
          evaluatorEnvironment(record, artifactPath, evaluatorScratch), true);
        // `not-started` is a confirmed non-execution outcome; every other
        // missing or unknown receipt can conceal a still-live evaluator.
        if (evaluation.processGroupSettlement !== 'group-exit-confirmed' && evaluation.processGroupSettlement !== 'not-started') {
          throw new UnresolvedSettlementError();
        }
        check(); assertUniverseExecution(directory, lock);
        const current = readUniverseIntegrationPlan(request.integration, { root });
        check();
        if (!current.compositionReady || current.compositionDigest !== request.expectedCompositionDigest) {
          result = emptyResult(request, requestDigestValue, startedAt, 'failed', 'composition-changed');
        } else if (evaluation.cancelled || options.signal?.aborted) result = emptyResult(request, requestDigestValue, startedAt, 'cancelled', 'evaluation-cancelled');
        else if (evaluation.timedOut || timedOut) result = emptyResult(request, requestDigestValue, startedAt, 'timed-out', 'evaluation-timed-out');
        else if (evaluation.error || evaluation.exitCode !== 0 || evaluation.signal !== null) result = emptyResult(request, requestDigestValue, startedAt, 'failed', 'evaluator-failed');
        else {
          const measured = parseEvaluation(evaluation.stdout);
          result = { schemaVersion: 1, id: request.id, requestDigest: requestDigestValue, status: measured.passed ? 'passed' : 'rejected',
            startedAt, finishedAt: new Date().toISOString(), durationMs: 0, acceptance: { ...request.acceptance },
            compositionDigest: request.expectedCompositionDigest, artifactDigest: artifactDigestValue, artifactPath, score: measured.score,
            metrics: measured.metrics, reason: measured.passed ? null : 'rejected-by-fixed-evaluator' };
        }
      } catch (error) {
        if (error instanceof UnresolvedSettlementError) {
          throw new Error('Integration evaluation process settlement is unresolved; durable intent retained');
        }
        if (performance.now() >= deadline) { timedOut = true; controller.abort(); }
        const ended = statusFor(controller.signal, timedOut);
        result = ended ? emptyResult(request, requestDigestValue, startedAt, ended, ended === 'timed-out' ? 'evaluation-timed-out' : 'evaluation-cancelled') :
          emptyResult(request, requestDigestValue, startedAt, 'failed', error instanceof CompositionChangedError ? 'composition-changed' :
            evaluatorStarted ? 'evaluator-failed' : 'candidate-materialization-failed');
      }
      result.durationMs = Math.max(0, performance.now() - started);
      assertUniverseExecution(directory, lock);
      persist(directory, { id: `${requestDigestValue}.receipt`, kind: 'receipt', request, requestDigest: requestDigestValue,
        startedAt, result });
      return result;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
    }
  });
}
