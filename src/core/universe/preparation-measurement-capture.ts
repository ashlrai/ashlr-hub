import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { readKillSwitch } from '../sandbox/policy.js';
import type { VerifySubprocessResult } from '../run/verify-commands.js';
import { artifactDigest, canonical, digest, privateDirectory } from './artifacts.js';
import { resolveBuiltinEvaluator } from './builtin-evaluator-registry.js';
import { assertUniverseExecution, withUniverseExecution } from './execution.js';
import { runFixedUniverseEvaluator } from './fixed-evaluator.js';
import { assertComparatorUnchanged, manifestRecord } from './store.js';
import { parsePreparationMeasurementReport } from './preparation-measurement-report.js';
import { assertPreparationCaptureBudget, ownCaptureData, preparationCaptureDirectory, projectPreparationCapture, readPreparationCaptureRecords,
  validatePreparationMeasurementCaptureRequest, writePreparationCaptureRecord } from './preparation-measurement-capture-store.js';
import type { PreparationMeasurementCapture, PreparationMeasurementCaptureIntent as Intent,
  PreparationMeasurementCaptureReceipt as Receipt, PreparationMeasurementCaptureRequest as Request } from './preparation-measurement-capture-types.js';
export type { PreparationMeasurementCapture, PreparationMeasurementCaptureIntent, PreparationMeasurementCaptureReceipt,
  PreparationMeasurementCaptureRequest } from './preparation-measurement-capture-types.js';

class CaptureStopped extends Error {
  constructor(readonly reason: 'cancelled' | 'deadline-reached') { super('Preparation measurement capture stopped'); }
}
/** Historical evidence only: this reader never acquires execution or refreshes old pins. */
export function readUniversePreparationMeasurementCapture(input: Request): PreparationMeasurementCapture {
  const request = validatePreparationMeasurementCaptureRequest(input);
  return projectPreparationCapture(readPreparationCaptureRecords(preparationCaptureDirectory(request)), request.captureId);
}

/** One explicit seed-only diagnostic invocation. No worker, trial or archive write. */
export async function captureUniversePreparationMeasurement(input: Request & { signal?: AbortSignal }): Promise<PreparationMeasurementCapture> {
  // Read own data once before yielding; getters and subsequent caller mutations
  // cannot change the selected root, capture identity or cancellation source.
  if (!input || typeof input !== 'object' || types.isProxy(input)) throw new Error('Invalid preparation measurement capture request');
  const options = ownCaptureData(input, ['root', 'universeId', 'captureId', ...(Object.hasOwn(input, 'signal') ? ['signal'] : [])]);
  const request = validatePreparationMeasurementCaptureRequest({ root: options.root, universeId: options.universeId, captureId: options.captureId });
  const signal = options.signal;
  if (signal !== undefined && (typeof signal !== 'object' || signal === null || types.isProxy(signal) || !(signal instanceof AbortSignal))) {
    throw new Error('Invalid preparation measurement cancellation signal');
  }
  const prior = readUniversePreparationMeasurementCapture(request);
  if (prior.state !== 'missing') return { ...prior, disposition: 'replayed' };
  return withUniverseExecution(request.universeId, { root: request.root }, async lock => {
    const directory = preparationCaptureDirectory(request);
    const records = readPreparationCaptureRecords(directory);
    const concurrent = projectPreparationCapture(records, request.captureId);
    if (concurrent.state !== 'missing') return { ...concurrent, disposition: 'replayed' };
    // Reserve both records before work; each valid report fits the per-record
    // bound even when its JSON text is escaped inside the custody receipt.
    if (records.filter(row => row.kind === 'intent').length >= 64) throw new Error('Preparation measurement capture capacity exhausted');
    const started = performance.now(), startedAt = new Date().toISOString();
    const record = manifestRecord(directory);
    if (record.manifest.evaluation.builtin !== 'preparation-measurement-v1') throw new Error('Preparation capture requires the pinned measurement builtin');
    const timeoutMs = record.manifest.evaluation.timeoutMs;
    const deadline = started + timeoutMs, deadlineAt = new Date(Date.parse(startedAt) + timeoutMs).toISOString();
    const installed = resolveBuiltinEvaluator('preparation-measurement-v1');
    const intent: Intent = { schemaVersion: 1, captureId: request.captureId, universeId: request.universeId,
      startedAt, deadlineAt, timeoutMs, manifestDigest: record.manifestDigest, comparatorDigest: record.comparatorDigest,
      artifact: structuredClone(record.seedArtifact), evaluator: structuredClone(installed) };
    assertPreparationCaptureBudget(intent);
    const own = () => assertUniverseExecution(directory, lock);
    const verifyPins = () => {
      const current = manifestRecord(directory);
      if (canonical(current) !== canonical(record)) throw new Error('Preparation measurement manifest changed');
      assertComparatorUnchanged(record);
      if (canonical(resolveBuiltinEvaluator('preparation-measurement-v1')) !== canonical(installed) ||
        installed.digest !== record.evaluationBuiltinDigest || installed.executableDigest !== record.evaluationExecutableDigest ||
        canonical(installed.command) !== canonical(record.evaluationCommand) || artifactDigest(record.seedArtifact.path) !== record.seedArtifact.digest) {
        throw new Error('Preparation measurement identity changed');
      }
    };
    const pins = () => { own(); verifyPins(); };
    const controller = new AbortController();
    let stopped: CaptureStopped['reason'] | null = null;
    const checkStop = () => {
      if (signal?.aborted || stopped === 'cancelled') throw new CaptureStopped('cancelled');
      if (performance.now() >= deadline || Date.now() >= Date.parse(deadlineAt) || stopped === 'deadline-reached') throw new CaptureStopped('deadline-reached');
      const kill = readKillSwitch();
      if (kill.sourceState !== 'healthy' || kill.state !== 'inactive') throw new CaptureStopped('cancelled');
    };
    const externalGuard = () => { own(); checkStop(); };
    const guard = () => { pins(); externalGuard(); };
    guard();
    writePreparationCaptureRecord(directory, { id: `${request.captureId}.intent`, kind: 'intent', intent, receipt: null }, guard);
    let reachedDispatch = false;
    let evaluation: VerifySubprocessResult | undefined;
    let identityVerified = false;
    let failure: unknown;
    const abort = () => { stopped = 'cancelled'; controller.abort(); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const stopPoll = setInterval(() => {
      try { externalGuard(); }
      catch (error) { stopped = error instanceof CaptureStopped ? error.reason : 'cancelled'; controller.abort(); }
    }, 50);
    try {
      guard();
      const scratch = privateDirectory(join(directory, 'preparation-measurement-work', request.captureId));
      evaluation = await runFixedUniverseEvaluator(record, request.root, record.seedArtifact.path, record.seedArtifact.digest, scratch,
        Math.max(1, Math.floor(deadline - performance.now())), controller.signal, {}, true,
        () => { guard(); reachedDispatch = true; });
      pins(); identityVerified = true;
      externalGuard();
    } catch (error) { failure = error; if (!(error instanceof CaptureStopped)) identityVerified = false; }
    finally { clearInterval(stopPoll); signal?.removeEventListener('abort', abort); }
    const settlement = evaluation?.processGroupSettlement ?? (reachedDispatch ? 'unconfirmed' : 'not-started');
    let report: Receipt['report'] = null;
    if (evaluation && !evaluation.outputTruncated) {
      try {
        const parsed = parsePreparationMeasurementReport(evaluation.stdout);
        report = { stdout: evaluation.stdout, sha256: digest(evaluation.stdout), bytes: Buffer.byteLength(evaluation.stdout), checksPassed: parsed.checksPassed };
      } catch { /* Invalid or partial transport is never a retained valid report. */ }
    }
    let outcome: Receipt['outcome'] = 'captured', reason: Receipt['reason'] = null;
    if (settlement === 'unconfirmed') { outcome = 'held'; reason = 'settlement-unconfirmed'; }
    else if (failure instanceof CaptureStopped || stopped || evaluation?.cancelled || evaluation?.timedOut) {
      const cause = failure instanceof CaptureStopped ? failure.reason : stopped ?? (evaluation?.timedOut ? 'deadline-reached' : 'cancelled');
      outcome = cause === 'deadline-reached' ? 'timed-out' : 'cancelled'; reason = cause;
    } else if (!identityVerified) { outcome = 'failed'; reason = 'integrity-changed'; }
    else if (!evaluation || evaluation.error || evaluation.exitCode !== 0 || evaluation.signal !== null || settlement !== 'group-exit-confirmed') {
      outcome = 'failed'; reason = 'execution-failed';
    } else if (!report) { outcome = 'failed'; reason = 'invalid-report'; }
    const receipt: Receipt = { schemaVersion: 1, intentDigest: digest(canonical(intent)), finishedAt: new Date(Math.max(Date.now(), Date.parse(startedAt))).toISOString(),
      durationMs: Math.max(0, performance.now() - started), outcome, reason, processGroupSettlement: settlement, identityVerified, report };
    // Failed/held receipts record historical facts under ownership; current
    // cancellation or changed comparator must not erase returned diagnostics.
    const refused: { error?: unknown; known: boolean } = { known: false };
    const publicationGuard = () => {
      own();
      if (receipt.outcome !== 'captured') return;
      // Ownership failures are deliberately outside these marked sections.
      // Only a definite pre-link identity/stop refusal can discharge known
      // settled custody with a historical failure receipt below.
      try { verifyPins(); } catch (error) { refused.known = true; refused.error = error; throw error; }
      own();
      try { checkStop(); } catch (error) { refused.known = true; refused.error = error; throw error; }
    };
    try {
      writePreparationCaptureRecord(directory, { id: `${request.captureId}.receipt`, kind: 'receipt', intent, receipt }, publicationGuard);
    } catch (error) {
      if (!refused.known || receipt.outcome !== 'captured' || settlement !== 'group-exit-confirmed') throw error;
      own();
      // A failed storage write, surviving stage, or already-published receipt
      // is not permission to retry publication. The full read must establish
      // the same intent and a clean, still-uncommitted receipt slot.
      const observed = projectPreparationCapture(readPreparationCaptureRecords(directory), request.captureId);
      if (observed.receipt || canonical(observed.intent) !== canonical(intent)) throw error;
      const stop = refused.error instanceof CaptureStopped ? refused.error.reason : null;
      const failed: Receipt = { ...receipt, outcome: stop === 'deadline-reached' ? 'timed-out' : stop ? 'cancelled' : 'failed',
        reason: stop ?? 'integrity-changed', identityVerified: stop ? receipt.identityVerified : false,
        durationMs: Math.max(0, performance.now() - started), finishedAt: new Date(Math.max(Date.now(), Date.parse(startedAt))).toISOString() };
      writePreparationCaptureRecord(directory, { id: `${request.captureId}.receipt`, kind: 'receipt', intent, receipt: failed }, own);
    }
    return { ...projectPreparationCapture(readPreparationCaptureRecords(directory), request.captureId), disposition: 'created' };
  });
}
