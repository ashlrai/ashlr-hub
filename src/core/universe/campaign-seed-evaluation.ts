/** One evaluator-only seed measurement under the campaign's existing execution lease. */
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { LocalStoreLock } from '../fleet/local-store-lock.js';
import { readKillSwitch } from '../sandbox/policy.js';
import { artifactDigest, canonical, defaultUniverseRoot, digest, privateDirectory } from './artifacts.js';
import { appendCampaignEvent, CampaignControlConflictError, campaignDirectory, foldCampaignEvents,
  readCampaignEvents, readUniverseCampaign } from './campaign-store.js';
import { assertUniverseExecution } from './execution.js';
import { runFixedUniverseEvaluator } from './fixed-evaluator.js';
import { assertComparatorUnchanged, manifestRecord, parseEvaluation, universePath } from './store.js';
import type { UniverseCampaignSeedIntent, UniverseCampaignSeedResult, UniverseRunOptions } from './types.js';

class SeedStopped extends Error {
  constructor(readonly status: 'cancelled' | 'timed-out') { super('Seed evaluation stopped'); }
}
export interface CampaignSeedEvaluationOutcome { status: 'measured' | 'held'; reason: string | null }
const held = (reason: string): CampaignSeedEvaluationOutcome => ({ status: 'held', reason });

/** No model reservation, trial, elite or generation is created by this operation. */
export async function runCampaignSeedEvaluationOwned(id: string,
  options: UniverseRunOptions & { signal: AbortSignal; deadlineMonotonicMs: number },
  lock: LocalStoreLock): Promise<CampaignSeedEvaluationOutcome> {
  if (!Number.isFinite(options.deadlineMonotonicMs)) throw new Error('Seed evaluation requires a finite original deadline');
  const root = resolve(options.root ?? defaultUniverseRoot());
  const directory = campaignDirectory(id, { root });
  const initial = readUniverseCampaign(id, { root });
  const executionDirectory = universePath(root, initial.definition.universeId);
  const own = () => assertUniverseExecution(executionDirectory, lock);
  own();
  if (initial.sourceState !== 'healthy' || initial.definition.measureSeed !== true || !initial.deadlineAt) {
    throw new Error('Campaign seed evaluation scope unavailable');
  }
  const record = manifestRecord(executionDirectory);
  const pins = () => {
    own(); assertComparatorUnchanged(record);
    if (record.manifestDigest !== initial.manifestDigest || record.comparatorDigest !== initial.comparatorDigest ||
        record.manifest.id !== initial.definition.universeId ||
        artifactDigest(record.seedArtifact.path) !== record.seedArtifact.digest) throw new Error('Seed evaluation integrity changed');
  };
  const checkpoint = () => {
    own();
    const events = readCampaignEvents(directory); const folded = foldCampaignEvents(events);
    if (folded.created.definitionDigest !== initial.definitionDigest || folded.created.manifestDigest !== initial.manifestDigest ||
        folded.created.comparatorDigest !== initial.comparatorDigest || folded.deadlineAt !== initial.deadlineAt) {
      throw new Error('Campaign seed identity changed');
    }
    return { events, folded, hash: digest(canonical(events)) };
  };
  // Safe under the campaign record mutex: no recursive ledger reads.
  const externalGuard = () => {
    own();
    if (options.signal.aborted) throw new SeedStopped('cancelled');
    if (performance.now() >= options.deadlineMonotonicMs || Date.now() >= Date.parse(initial.deadlineAt!)) throw new SeedStopped('timed-out');
    const kill = readKillSwitch();
    let stopped = false;
    try { stopped = options.isExecutionStopped?.() === true; } catch { stopped = true; }
    if (kill.state !== 'inactive' || kill.sourceState !== 'healthy' || stopped) throw new SeedStopped('cancelled');
  };
  const guard = () => {
    const current = checkpoint();
    if (['pause-requested', 'stop-requested'].includes(current.folded.state)) throw new SeedStopped('cancelled');
    if (current.folded.state !== 'running') throw new Error('Campaign seed owner changed');
    externalGuard();
    return current;
  };
  const prior = initial.seedEvaluation;
  if (prior) {
    if (prior.result?.status !== 'measured') return held('Seed evaluation requires attention; its intent is never replayed');
    pins(); guard();
    if (prior.intent.definitionDigest !== initial.definitionDigest || prior.intent.manifestDigest !== record.manifestDigest ||
        prior.intent.comparatorDigest !== record.comparatorDigest || prior.intent.seedArtifactDigest !== record.seedArtifact.digest ||
        prior.result.intentDigest !== digest(canonical(prior.intent)) || prior.result.measurement === null) {
      throw new Error('Recorded seed measurement does not match current pins');
    }
    return { status: 'measured', reason: null };
  }
  pins(); const admission = guard();
  const session = [...admission.events].reverse().find(event => event.kind === 'started');
  if (!session || initial.steps.length) throw new Error('Seed evaluation must precede campaign generation');
  const startedAt = new Date().toISOString(); const started = performance.now();
  const intent: UniverseCampaignSeedIntent = { schemaVersion: 1, id: randomUUID(), sessionSequence: session.sequence,
    definitionDigest: initial.definitionDigest, manifestDigest: record.manifestDigest, comparatorDigest: record.comparatorDigest,
    seedArtifactDigest: record.seedArtifact.digest, context: 'campaign-seed-v1', startedAt, deadlineAt: initial.deadlineAt };
  appendCampaignEvent(directory, { kind: 'seed-evaluation-intent', at: startedAt, evaluation: intent },
    { expectedRecordsDigest: admission.hash, prepublish: () => { pins(); externalGuard(); } });
  let reachedSpawnBoundary = false;
  let receivedSettlement = false;
  let result: UniverseCampaignSeedResult = { schemaVersion: 1, intentDigest: digest(canonical(intent)), status: 'failed',
    finishedAt: startedAt, durationMs: 0, processGroupSettlement: 'not-started', measurement: null, reason: 'integrity-changed' };
  const evaluationController = new AbortController();
  const cancelEvaluation = () => evaluationController.abort();
  options.signal.addEventListener('abort', cancelEvaluation, { once: true });
  if (options.signal.aborted) cancelEvaluation();
  const stopPoll = setInterval(() => {
    try { guard(); } catch { cancelEvaluation(); }
  }, 50);
  try {
    guard();
    const scratch = privateDirectory(join(executionDirectory, 'seed-evaluations', intent.id, 'evaluator'));
    const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: scratch, TMPDIR: `${scratch}/`,
      TMP: scratch, TEMP: scratch, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NO_COLOR: '1', CI: '1',
      ASHLR_UNIVERSE_OBJECTIVE: record.manifest.objective, ASHLR_UNIVERSE_CANDIDATE: record.seedArtifact.path,
      ASHLR_UNIVERSE_EVALUATION_CONTEXT: 'campaign-seed-v1' };
    const evaluation = await runFixedUniverseEvaluator(record, root, record.seedArtifact.path, record.seedArtifact.digest, scratch,
      Math.max(1, Math.min(record.manifest.evaluation.timeoutMs, Math.floor(options.deadlineMonotonicMs - performance.now()))),
      evaluationController.signal, environment, true, () => { guard(); reachedSpawnBoundary = true; });
    if (evaluation.processGroupSettlement !== 'not-started' && evaluation.processGroupSettlement !== 'group-exit-confirmed') {
      return held('Seed evaluator termination is unconfirmed; durable intent retained');
    }
    result.processGroupSettlement = evaluation.processGroupSettlement;
    receivedSettlement = true;
    if (evaluation.timedOut || performance.now() >= options.deadlineMonotonicMs || Date.now() >= Date.parse(initial.deadlineAt)) throw new SeedStopped('timed-out');
    if (evaluation.cancelled) throw new SeedStopped('cancelled');
    pins(); guard();
    if (evaluation.error || evaluation.exitCode !== 0 || evaluation.signal !== null || evaluation.processGroupSettlement !== 'group-exit-confirmed') {
      result.reason = 'evaluator-failed';
    } else {
      try {
        const measurement = parseEvaluation(evaluation.stdout);
        // Reserve the remainder of the 32 KiB campaign record for its envelope;
        // character bounds alone do not bound escaped UTF-8 record bytes.
        if (Buffer.byteLength(canonical(measurement), 'utf8') > 24 * 1024) throw new Error('Seed measurement exceeds record capacity');
        result.measurement = measurement; result.status = 'measured'; result.reason = null;
      } catch { result.measurement = null; result.reason = 'evaluator-invalid-result'; }
    }
  } catch (error) {
    // A throw after dispatch without a returned group receipt may conceal a
    // live evaluator. Never write a falsely settled result in that case.
    if (reachedSpawnBoundary && !receivedSettlement) {
      return held('Seed evaluator termination is unconfirmed; durable intent retained');
    }
    result.measurement = null;
    if (error instanceof SeedStopped) {
      result.status = error.status; result.reason = error.status === 'timed-out' ? 'evaluation-timed-out' : 'evaluation-cancelled';
    } else { result.status = 'failed'; result.reason = 'integrity-changed'; }
  } finally { clearInterval(stopPoll); options.signal.removeEventListener('abort', cancelEvaluation); }
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = checkpoint();
    if (['pause-requested', 'stop-requested'].includes(current.folded.state) || options.signal.aborted) {
      result = { ...result, status: 'cancelled', reason: 'evaluation-cancelled', measurement: null };
    } else if (result.status === 'measured') {
      try { pins(); guard(); }
      catch (error) {
        result = { ...result, status: error instanceof SeedStopped ? error.status : 'failed', measurement: null,
          reason: error instanceof SeedStopped ? error.status === 'timed-out' ? 'evaluation-timed-out' : 'evaluation-cancelled' : 'integrity-changed' };
      }
    }
    result.finishedAt = new Date(Math.max(Date.now(), Date.parse(startedAt))).toISOString();
    result.durationMs = Math.max(0, performance.now() - started);
    try {
      appendCampaignEvent(directory, { kind: 'seed-evaluation-result', at: result.finishedAt, evaluation: result },
        { expectedRecordsDigest: current.hash, prepublish: () => {
          own();
          // A late stop/integrity change refuses measurement publication; the
          // durable intent remains unresolved, never a fabricated success.
          if (result.status === 'measured') { pins(); externalGuard(); }
        } });
      return result.status === 'measured' ? { status: 'measured', reason: null } : held('Seed evaluation did not produce usable measured evidence');
    } catch (error) { if (!(error instanceof CampaignControlConflictError) || attempt > 0) throw error; }
  }
  return held('Seed evaluation requires attention');
}
