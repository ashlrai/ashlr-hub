import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { buildSandboxLauncher, escapeSbplPath } from '../sandbox/confine.js';
import { runVerifySubprocessAsync, type VerifySubprocessResult } from '../run/verify-commands.js';
import { acquireLocalStoreLock, ownsLocalStoreLock, releaseLocalStoreLock, verifiedProcessStartRef } from '../fleet/local-store-lock.js';
import type { LocalStoreLock } from '../fleet/local-store-lock.js';
import { artifactDigest, canonical, copyArtifact, digest, ensureUniverseRoot, executable, freezeArtifact, privateDirectory } from './artifacts.js';
import { appendRecord, assertComparatorUnchanged, manifestRecord, newRun, parseEvaluation,
  projectUniverse, readRecords, universePath, type ManifestRecord, type UniverseRecord } from './store.js';
import { scheduledVariants, selectWinners } from './store.js';
import { sanitizePublicJson } from '../util/public-json.js';
import type { UniverseElite, UniverseFeedback, UniverseManifest, UniverseRun, UniverseRunOptions, UniverseTrial } from './types.js';
import { generationResources, newGenerationReceipt } from './generation.js';
import { generateModelCandidate } from './model-candidate.js';
import { buildUniverseFeedback, feedbackReceipt } from './feedback.js';
import { assertUniverseExecution, withUniverseExecution } from './execution.js';
import { assertRunEvidenceBudget, assertTrialEvidenceBudget, preflightTrialEvidenceBudget } from './evidence-size.js';

function shortError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_024) || 'Experiment failed';
}

/** Add narrow write permissions to the existing OS confinement primitive. */
function confinedArgv(command: string[], writable: string, scratch: string, readable: string[], root: string): string[] {
  if (process.platform !== 'darwin') throw new Error('Universe local execution currently requires macOS sandbox-exec; other platforms have no verified Universe confinement profile');
  const env = { HOME: scratch, TMPDIR: scratch };
  const launcher = buildSandboxLauncher({ mode: 'os', networkEgress: false, onUnsupported: 'fail',
    readAllowed: [...readable, dirname(command[0]!)] }, { worktree: writable, home: homedir(), env });
  if (!launcher) throw new Error('Universe experiments require OS confinement');
  if (process.platform === 'darwin') {
    const subpath = (path: string): string => `(subpath "${escapeSbplPath(resolve(path))}")`;
    const ancestors = new Set<string>();
    for (const path of [writable, scratch, ...readable, command[0]!]) {
      for (let parent = dirname(path); ; parent = dirname(parent)) {
        ancestors.add(parent);
        if (dirname(parent) === parent) break;
      }
    }
    const profile = `${launcher.prefixArgs[1]}\n` +
      `(deny file-read* ${subpath(homedir())} ${subpath(root)})\n` +
      `(allow file-read* ${[writable, scratch, ...readable, dirname(command[0]!)].map(subpath).join(' ')})\n` +
      `(allow file-read-metadata ${[...ancestors].map((path) => `(literal "${escapeSbplPath(path)}")`).join(' ')})\n` +
      `(deny file-write*)\n(allow file-write* ${subpath(writable)} ${subpath(scratch)} (literal "/dev/null"))\n`;
    return ['/usr/bin/sandbox-exec', '-p', profile, ...command];
  }
  throw new Error('Universe experiments require macOS sandbox-exec');
}

function commandResultError(result: VerifySubprocessResult, role: string): string | undefined {
  if (result.cancelled) return `${role} cancelled`;
  if (result.timedOut) return `${role} timed out`;
  if (result.error) return `${role} could not start: ${result.error}`.slice(0, 1_024);
  if (result.exitCode !== 0 || result.signal !== null) return `${role} exited with ${result.signal ?? result.exitCode}: ${String(sanitizePublicJson(result.stderr)).slice(-768)}`;
  return undefined;
}

function phaseEnvironment(record: ManifestRecord, generation: number, candidate: string, scratch: string, parent: UniverseElite | undefined): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: scratch, TMPDIR: `${scratch}/`, TMP: scratch, TEMP: scratch,
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NO_COLOR: '1', CI: '1',
    ASHLR_UNIVERSE_OBJECTIVE: record.manifest.objective,
    ASHLR_UNIVERSE_GENERATION: String(generation), ASHLR_UNIVERSE_CANDIDATE: candidate,
    ASHLR_UNIVERSE_PARENT_TRIAL: parent?.trialId ?? '',
  };
}

function recordFinishedRun(directory: string, run: UniverseRun, lock: LocalStoreLock): void {
  if (!ownsLocalStoreLock(lock)) throw new Error('Universe ownership lost before final evidence');
  assertRunEvidenceBudget(run);
  appendRecord(directory, { id: `${run.id}.final`, kind: 'final', run });
}

async function runTrial(record: ManifestRecord, run: UniverseRun, variant: UniverseManifest['variants'][number],
  parent: UniverseElite | undefined, directory: string, root: string, signal: AbortSignal, deadline: number,
  feedback?: UniverseFeedback): Promise<UniverseTrial> {
  const started = performance.now();
  const trialId = randomUUID();
  const scratch = join(directory, 'scratch', run.id, trialId);
  privateDirectory(scratch);
  const candidate = join(scratch, 'candidate');
  const archivePath = join(directory, 'artifacts', run.id, trialId);
  const workerScratch = privateDirectory(join(scratch, 'worker'));
  const evaluatorScratch = privateDirectory(join(scratch, 'evaluator'));
  const trial: UniverseTrial = { id: trialId, variantId: variant.id, niche: variant.niche,
    parentTrialId: parent?.trialId ?? null, status: 'failed', score: null, metrics: {}, artifact: null,
    durationMs: 0, delta: null, selected: false,
    ...(variant.generation ? { generation: newGenerationReceipt(variant.generation) } : {}) };
  try {
    if (signal.aborted) { trial.status = 'cancelled'; trial.error = 'Run cancelled before trial'; return trial; }
    const source = parent?.artifact ?? record.seedArtifact;
    if (parent && parent.comparatorDigest !== record.comparatorDigest) throw new Error('Parent comparator scope differs');
    if (artifactDigest(source.path) !== source.digest) throw new Error('Parent artifact changed; cannot reproduce lineage');
    const copiedDigest = copyArtifact(source.path, candidate);
    if (copiedDigest !== source.digest) throw new Error('Parent artifact changed during copy');
    const phaseExpired = (): boolean => performance.now() - started >= record.manifest.budget.trialTimeoutMs || Date.now() >= deadline;
    const remaining = (): number => Math.max(1, Math.min(record.manifest.budget.trialTimeoutMs - (performance.now() - started), deadline - Date.now()));
    if (phaseExpired()) { trial.status = 'timed-out'; trial.error = 'Trial budget exhausted before worker'; return trial; }
    // Reserve room for the full receipt before spending a model request. Large
    // evaluator measurements are rejected intact below, never silently trimmed.
    preflightTrialEvidenceBudget(trial, {
      artifact: { path: archivePath, digest: 'f'.repeat(64), revision: record.manifest.seed.revision },
      changedFiles: variant.generation?.files ?? [], ...(feedback ? { feedback: feedbackReceipt(feedback) } : {}),
    });
    if (variant.generation) {
      // The broker receives only declared text. Model output is replacement data,
      // never a tool call or executable command; the fixed evaluator is unchanged.
      trial.generation = await generateModelCandidate(variant.generation, {
        candidatePath: candidate, objective: record.manifest.objective, hypothesis: variant.hypothesis,
        generation: run.generation, parentTrialId: parent?.trialId ?? null, timeoutMs: Math.max(1, Math.floor(remaining())), signal,
        ...(feedback ? { feedback } : {}),
      });
      if (trial.generation.status !== 'succeeded') {
        trial.status = trial.generation.status;
        trial.error = trial.generation.error ?? 'Model candidate generation failed';
        return trial;
      }
    } else {
      const worker = executable(variant.command, candidate);
      const result = await runVerifySubprocessAsync(confinedArgv(worker, candidate, workerScratch, [], root), {
        cwd: candidate, env: phaseEnvironment(record, run.generation, candidate, workerScratch, parent),
        timeoutMs: remaining(), signal,
      });
      const workerError = commandResultError(result, 'Worker');
      if (workerError) {
        trial.error = workerError;
        trial.status = result.cancelled ? 'cancelled' : result.timedOut ? 'timed-out' : 'failed';
        return trial;
      }
    }
    if (signal.aborted) { trial.status = 'cancelled'; trial.error = 'Run cancelled after worker'; return trial; }

    // The worker can write only its scratch candidate. Copy before evaluating:
    // the independently scored bytes are never writable by that worker, even
    // if it left a process behind after its leader exited.
    const snapshotDigest = copyArtifact(candidate, archivePath);
    freezeArtifact(archivePath);
    trial.artifact = { path: archivePath, digest: snapshotDigest, revision: record.manifest.seed.revision };
    assertComparatorUnchanged(record);
    if (phaseExpired()) { trial.status = 'timed-out'; trial.error = 'Trial budget exhausted before evaluator'; return trial; }
    const evaluator = record.evaluationCommand;
    if (digest(readFileSync(evaluator[0]!)) !== record.evaluationExecutableDigest) throw new Error('Evaluator executable changed');
    const evaluation = await runVerifySubprocessAsync(
      confinedArgv(evaluator, evaluatorScratch, evaluatorScratch, [record.seedArtifact.path, archivePath], root), {
        cwd: record.seedArtifact.path,
        env: phaseEnvironment(record, run.generation, archivePath, evaluatorScratch, parent),
        timeoutMs: Math.max(1, Math.min(record.manifest.evaluation.timeoutMs, remaining())), signal,
      });
    const evaluationError = commandResultError(evaluation, 'Evaluator');
    if (evaluationError) {
      trial.error = evaluationError;
      trial.status = evaluation.cancelled ? 'cancelled' : evaluation.timedOut ? 'timed-out' : 'failed';
      return trial;
    }
    assertComparatorUnchanged(record);
    if (artifactDigest(archivePath) !== snapshotDigest) throw new Error('Scored artifact changed during evaluation');
    const measurement = parseEvaluation(evaluation.stdout);
    const measuredTrial: UniverseTrial = { ...trial, metrics: measurement.metrics, score: measurement.score,
      status: measurement.passed ? 'passed' : 'failed',
      ...(measurement.diagnostics ? { diagnostics: measurement.diagnostics } : {}),
      ...(!measurement.passed ? { error: 'Fixed evaluator rejected the candidate' } : {}),
    };
    assertTrialEvidenceBudget(measuredTrial);
    Object.assign(trial, measuredTrial);
    return trial;
  } catch (error) {
    trial.error = shortError(error);
    trial.status = signal.aborted ? 'cancelled' : 'failed';
    return trial;
  } finally {
    trial.durationMs = Math.max(0, performance.now() - started);
    if (trial.generation && !trial.generation.requestStarted && (trial.status === 'cancelled' || trial.status === 'timed-out')) {
      trial.generation.status = trial.status;
    }
    // This exact path was created for this invocation, never the archive or seed.
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Evidence remains readable if scratch cleanup is delayed. */ }
  }
}

/** A single bounded generation; calling again deliberately creates the next generation. */
export async function runUniverse(id: string, options: UniverseRunOptions = {}): Promise<UniverseRun> {
  if (process.platform !== 'darwin') {
    throw new Error('Universe local execution currently requires macOS sandbox-exec; other platforms have no verified Universe confinement profile');
  }
  return withUniverseExecution(id, options, (lock) => runUniverseOwned(id, options, lock));
}

export interface UniverseOwnedRunOptions extends UniverseRunOptions {
  runId?: string;
  campaign?: UniverseRun['campaign'];
  deadlineMs?: number;
  trialLimit?: number;
  feedback?: true;
}

/** Internal lease-bearing seam: a persisted run identity is never dispatched twice. */
export async function runUniverseOwned(id: string, options: UniverseOwnedRunOptions,
  execution: LocalStoreLock): Promise<UniverseRun> {
  if (process.platform !== 'darwin') {
    throw new Error('Universe local execution currently requires macOS sandbox-exec; other platforms have no verified Universe confinement profile');
  }
  const root = ensureUniverseRoot(options.root);
  const directory = universePath(root, id);
  assertUniverseExecution(directory, execution);
  if (options.runId !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(options.runId)) {
    throw new Error('Invalid reserved Universe run identity');
  }
  if (options.deadlineMs !== undefined && (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs <= 0)) throw new Error('Invalid campaign deadline');
  if (options.trialLimit !== undefined && (!Number.isSafeInteger(options.trialLimit) || options.trialLimit < 1 || options.trialLimit > 64)) throw new Error('Invalid campaign trial limit');
  if (options.campaign && (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(options.campaign.id) ||
    !Number.isSafeInteger(options.campaign.ordinal) || options.campaign.ordinal < 1 || options.campaign.ordinal > 128 ||
    !/^[a-f0-9]{64}$/.test(options.campaign.definitionDigest))) throw new Error('Invalid campaign identity');
  if (!existsSync(directory)) throw new Error(`Universe does not exist: ${id}`);
  privateDirectory(directory);
  const lock = acquireLocalStoreLock(join(directory, '.run.lock'), 0, { anchorPath: directory, exactPrivateStorage: true });
  if (!lock) throw new Error('Universe already has an active run');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const started = performance.now();
  let run: UniverseRun | undefined;
  try {
    let records = readRecords(directory);
    const record = manifestRecord(directory, records);
    assertComparatorUnchanged(record);
    let overview = projectUniverse(directory, records);
    if (overview.sourceState !== 'healthy') throw new Error(overview.reasons.join('; '));

    // An abandoned start is not a successful generation. Preserve completed
    // measurements, append an interruption, and only then start fresh work.
    for (const previous of overview.runs.filter((item) => item.finishedAt === null)) {
      assertUniverseExecution(directory, execution);
      if (!ownsLocalStoreLock(lock)) throw new Error('Universe run ownership lost');
      appendRecord(directory, { id: `${previous.id}.final`, kind: 'final', run: { ...previous,
        status: 'interrupted', finishedAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - Date.parse(previous.startedAt)),
        error: 'Recovered an interrupted generation; partial trials were not promoted' } });
    }
    records = readRecords(directory);
    overview = projectUniverse(directory, records);
    if (overview.sourceState !== 'healthy') throw new Error(overview.reasons.join('; '));
    const existing = options.runId ? overview.runs.find((item) => item.id === options.runId) : undefined;
    if (existing) {
      if (canonical(existing.campaign ?? null) !== canonical(options.campaign ?? null) ||
          Boolean(existing.feedbackEnabled) !== Boolean(options.feedback)) throw new Error('Reserved run context changed');
      return existing;
    }
    if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) throw new Error('Campaign deadline exhausted before generation');
    if (controller.signal.aborted) throw new Error('Run cancelled before generation');
    const nextRun = newRun(record, overview.runs.length + 1);
    if (options.runId) nextRun.id = options.runId;
    if (options.campaign) nextRun.campaign = options.campaign;
    if (options.feedback) nextRun.feedbackEnabled = true;
    const scheduled = scheduledVariants(record.manifest, nextRun.generation);
    if (options.trialLimit !== undefined && options.trialLimit > scheduled.length) throw new Error('Campaign trial limit exceeds scheduled variants');
    const ownerStart = verifiedProcessStartRef(process.pid);
    if (!ownerStart) throw new Error('Cannot identify the Universe run process');
    assertRunEvidenceBudget(nextRun);
    assertUniverseExecution(directory, execution);
    appendRecord(directory, { id: `${nextRun.id}.start`, kind: 'start', run: nextRun, ownerPid: process.pid, ownerStart });
    run = nextRun;
    const artifactDirectory = join(directory, 'artifacts', run.id);
    mkdirSync(artifactDirectory, { mode: 0o700 });
    const deadline = Math.min(Date.now() + record.manifest.budget.maxDurationMs, options.deadlineMs ?? Infinity);
    timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    const variants = scheduled.slice(0, options.trialLimit ?? scheduled.length);
    for (let index = 0; index < variants.length && !controller.signal.aborted; index += record.manifest.budget.maxParallel) {
      assertUniverseExecution(directory, execution);
      if (!ownsLocalStoreLock(lock)) throw new Error('Universe run ownership lost');
      const batch = variants.slice(index, index + record.manifest.budget.maxParallel);
      const results = await Promise.allSettled(batch.map(async (variant) => {
        const trial = await runTrial(record, run!, variant, overview.elites.find((elite) => elite.niche === variant.niche),
          directory, root, controller.signal, deadline,
          options.feedback && variant.generation ? buildUniverseFeedback(overview, variant, directory) : undefined);
        assertUniverseExecution(directory, execution);
        if (!ownsLocalStoreLock(lock)) throw new Error('Universe run ownership lost before evidence write');
        appendRecord(directory, { id: `${run!.id}.trial.${trial.id}`, kind: 'trial', runId: run!.id, trial });
        return trial;
      }));
      for (const result of results) if (result.status === 'fulfilled') run.trials.push(result.value);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }
    if (controller.signal.aborted) {
      run.status = 'interrupted';
      run.error = options.signal?.aborted ? 'Run cancelled by its owner' : 'Run duration budget exhausted';
    } else {
      assertComparatorUnchanged(record);
      run.status = 'completed';
      selectWinners(run, record.manifest, overview.elites);
    }
  } catch (error) {
    controller.abort();
    if (!run) throw error;
    run.status = controller.signal.aborted && options.signal?.aborted ? 'interrupted' : 'failed';
    run.error = shortError(error);
    // Recover all already-published measurements before writing a failed final.
    run.trials = readRecords(directory).filter((item): item is Extract<UniverseRecord, { kind: 'trial' }> => item.kind === 'trial' && item.runId === run!.id).map((item) => item.trial);
    // No selected evidence survives a failed completion, including a comparator change.
    for (const trial of run.trials) trial.selected = false;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    try {
      if (run) {
        assertUniverseExecution(directory, execution);
        Object.assign(run, generationResources(run.trials, run.status === 'completed'));
        run.finishedAt = new Date().toISOString();
        run.durationMs = Math.max(0, performance.now() - started);
        recordFinishedRun(directory, run, lock);
      }
    } finally { releaseLocalStoreLock(lock); }
  }
  return run!;
}
