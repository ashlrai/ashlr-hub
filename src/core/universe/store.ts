import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  type ImmutablePrivateRecordCodec, type ImmutablePrivateRecordStoreConfig,
  readImmutablePrivateRecords, writeImmutablePrivateRecord,
} from '../util/immutable-private-record-store.js';
import { acquireLocalStoreLock, releaseLocalStoreLock, verifiedProcessStartRef } from '../fleet/local-store-lock.js';
import {
  artifactDigest, canonical, defaultUniverseRoot, digest, ensureUniverseRoot,
  executable, freezeArtifact, inspectPrivateDirectory, materializeSeed, pinSeed, privateDirectory,
} from './artifacts.js';
import type { UniverseArtifact, UniverseDiagnostic, UniverseElite, UniverseManifest, UniverseOverview, UniverseRun,
  UniverseStoreOptions, UniverseSummary, UniverseTrial } from './types.js';
import { generationResources, newGenerationReceipt, validateGenerationConfig, validGenerationReceipt, validGenerationUsage } from './generation.js';
import { buildUniverseFeedback, feedbackReceipt, validateDiagnostics } from './feedback.js';
import { MAX_UNIVERSE_RECORD_BYTES } from './evidence-size.js';

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const RECORD_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const MAX_RECORDS = 10_000;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function text(value: unknown, max = 4_000): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0');
}
function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function command(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 64 && value.every((part) =>
    typeof part === 'string' && part.length <= 8_192 && !part.includes('\0')) && text(value[0], 4_096);
}

export function validateUniverseManifest(value: unknown): UniverseManifest {
  if (!object(value) || !exact(value, ['schemaVersion', 'id', 'name', 'objective', 'seed', 'metric', 'budget', 'evaluation', 'variants']) ||
      value.schemaVersion !== 1 || !text(value.id, 64) || !ID.test(value.id) || !text(value.name, 160) ||
      !text(value.objective) || !object(value.seed) || !exact(value.seed, ['repo', 'revision']) ||
      !text(value.seed.repo, 4_096) || !text(value.seed.revision, 64) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.seed.revision) ||
      !object(value.metric) || !exact(value.metric, ['name', 'direction', 'minImprovement']) || !text(value.metric.name, 120) ||
      !['maximize', 'minimize'].includes(String(value.metric.direction)) || !finite(value.metric.minImprovement) || value.metric.minImprovement < 0 ||
      !object(value.budget) || !exact(value.budget, ['maxTrials', 'maxDurationMs', 'trialTimeoutMs', 'maxParallel']) ||
      !integer(value.budget.maxTrials, 1, 64) || !integer(value.budget.maxParallel, 1, 8) ||
      !integer(value.budget.maxDurationMs, 1, 86_400_000) || !integer(value.budget.trialTimeoutMs, 1, 900_000) ||
      !object(value.evaluation) || !exact(value.evaluation, ['command', 'timeoutMs']) || !command(value.evaluation.command) ||
      !integer(value.evaluation.timeoutMs, 1, 900_000) || !Array.isArray(value.variants) || value.variants.length < 1 || value.variants.length > 64) {
    throw new Error('Invalid Universe manifest: expected bounded version 1 identity, objective, seed, metric, budget, evaluator, and variants');
  }
  const ids = new Set<string>();
  for (const variant of value.variants) {
    if (!object(variant) || !exact(variant, ['id', 'niche', 'hypothesis', 'command', 'model', 'generation']) ||
        !text(variant.id, 64) || !ID.test(variant.id) || ids.has(variant.id) || !text(variant.niche, 64) ||
        !ID.test(variant.niche) || !text(variant.hypothesis)) throw new Error('Invalid or duplicate Universe variant');
    if (variant.generation !== undefined) {
      if (variant.command !== undefined || variant.model !== undefined) throw new Error('Universe variants must choose a command or local generation, not both');
      validateGenerationConfig(variant.generation);
    } else if (!command(variant.command) || (variant.model !== undefined && !text(variant.model, 160))) {
      throw new Error('Invalid Universe command variant');
    }
    ids.add(variant.id);
  }
  return JSON.parse(canonical(value)) as UniverseManifest;
}

export interface ManifestRecord {
  id: 'manifest'; kind: 'manifest'; manifest: UniverseManifest; manifestDigest: string;
  comparatorDigest: string; seedArtifact: UniverseArtifact; evaluationCommand: string[];
  evaluationExecutableDigest: string;
}
export type UniverseRecord = ManifestRecord |
  { id: string; kind: 'start'; run: UniverseRun; ownerPid: number; ownerStart: string } |
  { id: string; kind: 'trial'; runId: string; trial: UniverseTrial } |
  { id: string; kind: 'final'; run: UniverseRun };

function validMetrics(value: unknown): value is Record<string, number> {
  return object(value) && Object.keys(value).length <= 32 && Object.entries(value).every(([key, item]) =>
    /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(key) && finite(item));
}

function validArtifact(value: unknown): value is UniverseArtifact {
  return object(value) && exact(value, ['path', 'digest', 'revision']) && text(value.path, 4_096) &&
    text(value.digest, 64) && HASH.test(value.digest) && text(value.revision, 64) &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.revision);
}
function validDiagnostics(value: unknown): boolean {
  try { validateDiagnostics(value); return true; } catch { return false; }
}
function validTrial(value: unknown): value is UniverseTrial {
  return object(value) && exact(value, ['id', 'variantId', 'niche', 'parentTrialId', 'status', 'score', 'metrics', 'artifact', 'durationMs', 'delta', 'selected', 'error', 'generation', 'diagnostics']) &&
    text(value.id, 64) && RECORD_ID.test(value.id) && text(value.variantId, 64) && ID.test(value.variantId) &&
    text(value.niche, 64) && ID.test(value.niche) && (value.parentTrialId === null || text(value.parentTrialId, 64)) &&
    ['passed', 'failed', 'timed-out', 'cancelled'].includes(String(value.status)) &&
    (value.score === null || finite(value.score)) && validMetrics(value.metrics) &&
    (value.artifact === null || validArtifact(value.artifact)) && finite(value.durationMs) && value.durationMs >= 0 &&
    (value.delta === null || finite(value.delta)) && typeof value.selected === 'boolean' &&
    (value.error === undefined || text(value.error, 1_024)) &&
    (value.generation === undefined || validGenerationReceipt(value.generation)) &&
    (value.diagnostics === undefined || validDiagnostics(value.diagnostics)) &&
    (value.status !== 'passed' || (finite(value.score) && validArtifact(value.artifact))) &&
    (!value.selected || value.status === 'passed');
}
function validRun(value: unknown): value is UniverseRun {
  return object(value) && exact(value, ['id', 'universeId', 'generation', 'manifestDigest', 'comparatorDigest', 'startedAt', 'finishedAt', 'status', 'trials', 'durationMs', 'tokensUsed', 'costUsd', 'error', 'generationUsage', 'campaign', 'feedbackEnabled']) &&
    text(value.id, 64) && RECORD_ID.test(value.id) && text(value.universeId, 64) && ID.test(value.universeId) &&
    integer(value.generation, 1, MAX_RECORDS) && text(value.manifestDigest, 64) && HASH.test(value.manifestDigest) &&
    text(value.comparatorDigest, 64) && HASH.test(value.comparatorDigest) && text(value.startedAt, 40) &&
    Number.isFinite(Date.parse(value.startedAt)) && (value.finishedAt === null || (text(value.finishedAt, 40) && Number.isFinite(Date.parse(value.finishedAt)))) &&
    ['running', 'completed', 'interrupted', 'failed'].includes(String(value.status)) && Array.isArray(value.trials) && value.trials.length <= 64 && value.trials.every(validTrial) &&
    new Set(value.trials.map((trial) => trial.id)).size === value.trials.length &&
    finite(value.durationMs) && value.durationMs >= 0 && (value.tokensUsed === null || integer(value.tokensUsed, 0, Number.MAX_SAFE_INTEGER)) && value.costUsd === null &&
    (value.generationUsage === undefined || validGenerationUsage(value.generationUsage)) &&
    (value.feedbackEnabled === undefined || value.feedbackEnabled === true) &&
    (value.campaign === undefined || (object(value.campaign) && exact(value.campaign, ['id', 'ordinal', 'definitionDigest']) &&
      text(value.campaign.id, 64) && ID.test(value.campaign.id) && integer(value.campaign.ordinal, 1, 128) &&
      text(value.campaign.definitionDigest, 64) && HASH.test(value.campaign.definitionDigest))) &&
    (value.error === undefined || text(value.error, 1_024)) && resourceEvidenceMatches(value, value.trials);
}

function resourceEvidenceMatches(run: Record<string, unknown> | UniverseRun, trials: UniverseTrial[]): boolean {
  const resources = generationResources(trials, run.status === 'completed');
  return run.tokensUsed === resources.tokensUsed && run.costUsd === resources.costUsd &&
    canonical(run.generationUsage ?? null) === canonical(resources.generationUsage ?? null);
}

function parseRecord(value: unknown): UniverseRecord | null {
  if (!object(value) || !text(value.id, 128) || !RECORD_ID.test(value.id)) return null;
  if (value.kind === 'manifest') {
    try {
      const manifest = validateUniverseManifest(value.manifest);
      if (!exact(value, ['id', 'kind', 'manifest', 'manifestDigest', 'comparatorDigest', 'seedArtifact', 'evaluationCommand', 'evaluationExecutableDigest']) ||
          value.id !== 'manifest' || digest(canonical(manifest)) !== value.manifestDigest ||
          !text(value.comparatorDigest, 64) || !HASH.test(value.comparatorDigest) || !validArtifact(value.seedArtifact) ||
          !command(value.evaluationCommand) || !text(value.evaluationExecutableDigest, 64) || !HASH.test(value.evaluationExecutableDigest)) return null;
      return value as unknown as ManifestRecord;
    } catch { return null; }
  }
  if (value.kind === 'start' && exact(value, ['id', 'kind', 'run', 'ownerPid', 'ownerStart']) &&
      validRun(value.run) && value.run.status === 'running' && value.run.trials.length === 0 &&
      value.id === `${value.run.id}.start` && integer(value.ownerPid, 1, 2 ** 31) && text(value.ownerStart, 64)) return value as unknown as UniverseRecord;
  if (value.kind === 'trial' && exact(value, ['id', 'kind', 'runId', 'trial']) && text(value.runId, 64) &&
      validTrial(value.trial) && value.id === `${value.runId}.trial.${value.trial.id}` && !value.trial.selected) return value as unknown as UniverseRecord;
  if (value.kind === 'final' && exact(value, ['id', 'kind', 'run']) && validRun(value.run) &&
      value.run.status !== 'running' && value.run.finishedAt !== null && value.id === `${value.run.id}.final`) return value as unknown as UniverseRecord;
  return null;
}

const codec: ImmutablePrivateRecordCodec<UniverseRecord> = {
  parse: parseRecord, serialize: (record) => `${canonical(record)}\n`, recordId: (record) => record.id,
  recordFileName: (record) => `${record.id}.json`, isRecordFileName: (name) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.json$/.test(name),
  stageToken: (record) => digest(canonical(record)), equivalent: (a, b) => canonical(a) === canonical(b),
};

export function universePath(root: string, id: string): string {
  if (!ID.test(id)) throw new Error('Invalid Universe id');
  return join(root, 'universes', id);
}

function config(directory: string): ImmutablePrivateRecordStoreConfig<UniverseRecord> {
  return { label: 'Universe evidence', anchorPath: directory, rootPath: join(directory, 'ledger'), lockFileName: '.records.lock',
    maxRecordBytes: MAX_UNIVERSE_RECORD_BYTES, defaultMaxFiles: MAX_RECORDS, hardMaxFiles: MAX_RECORDS,
    defaultMaxBytes: 64 * 1024 * 1024, hardMaxBytes: 64 * 1024 * 1024,
    codecForRead: () => codec, codecForWrite: () => codec };
}

export function appendRecord(directory: string, record: UniverseRecord): void {
  const disposition = writeImmutablePrivateRecord(config(directory), record);
  if (disposition !== 'recorded' && disposition !== 'replayed') throw new Error(`Universe evidence write ${disposition}`);
}

export function readRecords(directory: string): UniverseRecord[] {
  const result = readImmutablePrivateRecords(config(directory), { requireComplete: true });
  if (result.sourceState !== 'healthy' || !result.complete) throw new Error(`Universe evidence unavailable: ${result.stopReasons.join(', ') || result.sourceState}`);
  return result.records;
}

export function manifestRecord(directory: string, records = readRecords(directory)): ManifestRecord {
  const record = records.find((item): item is ManifestRecord => item.kind === 'manifest');
  if (!record) throw new Error('Universe manifest missing');
  if (record.seedArtifact.path !== join(directory, 'seed') || record.seedArtifact.revision !== record.manifest.seed.revision ||
      record.comparatorDigest !== comparatorDigest(record)) throw new Error('Universe comparator scope changed');
  return record;
}

export function comparatorDigest(record: Omit<ManifestRecord, 'comparatorDigest'>): string {
  return digest(canonical({ objective: record.manifest.objective, metric: record.manifest.metric,
    seed: record.manifest.seed, seedDigest: record.seedArtifact.digest,
    evaluation: record.manifest.evaluation, evaluationCommand: record.evaluationCommand,
    evaluationExecutableDigest: record.evaluationExecutableDigest }));
}

function pinnedEvaluationCommand(manifest: UniverseManifest, seedPath: string): string[] {
  const args = manifest.evaluation.command.map((arg, index) => {
    if (index === 0) return arg;
    if (arg.split(/[\\/]/).includes('..')) throw new Error('Evaluator arguments cannot escape the pinned source');
    const assignment = /^([^=]+=)(.*)$/.exec(arg);
    const target = assignment?.[2] ?? arg;
    if (!isAbsolute(target)) return arg;
    const within = relative(manifest.seed.repo, target);
    if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
      throw new Error('Evaluator file arguments must come from the pinned source repository');
    }
    return `${assignment?.[1] ?? ''}${join(seedPath, within)}`;
  });
  return executable(args, seedPath);
}

export function initUniverse(input: UniverseManifest, options: UniverseStoreOptions = {}): UniverseManifest {
  const manifest = validateUniverseManifest(input);
  manifest.seed = pinSeed(manifest.seed.repo, manifest.seed.revision);
  const root = ensureUniverseRoot(options.root);
  privateDirectory(join(root, 'universes'));
  const directory = universePath(root, manifest.id);
  privateDirectory(directory);
  const lock = acquireLocalStoreLock(join(directory, '.run.lock'), 0, { anchorPath: directory, exactPrivateStorage: true });
  if (!lock) throw new Error('Universe is busy');
  try {
    if (existsSync(join(directory, 'ledger'))) {
      const current = manifestRecord(directory);
      if (current.manifestDigest !== digest(canonical(manifest))) throw new Error('Universe manifest is immutable; use a new id for a changed objective or comparator');
      return current.manifest;
    }
    privateDirectory(join(directory, 'artifacts'));
    privateDirectory(join(directory, 'scratch'));
    const seedPath = join(directory, 'seed');
    if (existsSync(seedPath)) throw new Error('Interrupted initialization exists; choose a new Universe id');
    const seedDigest = materializeSeed(manifest.seed, seedPath);
    const evalCommand = pinnedEvaluationCommand(manifest, seedPath);
    const partial: Omit<ManifestRecord, 'comparatorDigest'> = { id: 'manifest', kind: 'manifest', manifest,
      manifestDigest: digest(canonical(manifest)), seedArtifact: { path: seedPath, digest: seedDigest, revision: manifest.seed.revision },
      evaluationCommand: evalCommand, evaluationExecutableDigest: digest(readFileSync(evalCommand[0]!)) };
    freezeArtifact(seedPath);
    appendRecord(directory, { ...partial, comparatorDigest: comparatorDigest(partial) });
    return manifest;
  } finally { releaseLocalStoreLock(lock); }
}

export function assertComparatorUnchanged(record: ManifestRecord): void {
  if (artifactDigest(record.seedArtifact.path) !== record.seedArtifact.digest ||
      digest(readFileSync(record.evaluationCommand[0]!)) !== record.evaluationExecutableDigest ||
      record.comparatorDigest !== comparatorDigest(record)) throw new Error('Universe evaluator or seed comparator changed');
}

export function projectUniverse(directory: string, records = readRecords(directory)): UniverseSummary {
  const stored = manifestRecord(directory, records);
  const starts = records.filter((record) => record.kind === 'start').sort((a, b) => a.run.generation - b.run.generation);
  if (starts.some((record, index) => record.run.generation !== index + 1)) throw new Error('Universe generation sequence contains a duplicate or gap');
  const runs: UniverseRun[] = [];
  const elites = new Map<string, UniverseElite>();
  const reasons: string[] = [];
  try { assertComparatorUnchanged(stored); }
  catch (error) { reasons.push(error instanceof Error ? error.message : 'Comparator unavailable'); }
  let activeRun: UniverseRun | null = null;
  for (const start of starts) {
    const final = records.find((record) => record.kind === 'final' && record.run.id === start.run.id);
    const trials = records.filter((record): record is Extract<UniverseRecord, { kind: 'trial' }> => record.kind === 'trial' && record.runId === start.run.id)
      .map((record) => record.trial);
    if (start.run.universeId !== stored.manifest.id || start.run.manifestDigest !== stored.manifestDigest ||
        start.run.comparatorDigest !== stored.comparatorDigest) throw new Error('Run comparator does not match Universe');
    let run: UniverseRun;
    if (final?.kind === 'final') {
      run = final.run;
      if (run.universeId !== start.run.universeId || run.generation !== start.run.generation || run.manifestDigest !== start.run.manifestDigest ||
          run.comparatorDigest !== start.run.comparatorDigest || run.startedAt !== start.run.startedAt ||
          canonical(run.campaign ?? null) !== canonical(start.run.campaign ?? null) || run.feedbackEnabled !== start.run.feedbackEnabled ||
          !resourceEvidenceMatches(run, trials) || run.trials.length !== trials.length || run.trials.some((trial) => !trials.some((raw) =>
            canonical({ ...trial, selected: false, delta: null }) === canonical({ ...raw, selected: false, delta: null })))) {
        throw new Error('Final run does not match durable trial evidence');
      }
    } else {
      const alive = verifiedProcessStartRef(start.ownerPid) === start.ownerStart;
      run = { ...start.run, trials, ...generationResources(trials, false), status: alive ? 'running' : 'interrupted',
        ...(alive ? {} : { error: 'Run owner exited before writing final evidence' }) };
      if (alive) activeRun = run;
    }
    const previous = new Map(elites);
    const expected = JSON.parse(canonical(run)) as UniverseRun;
    for (const trial of expected.trials) { trial.selected = false; trial.delta = null; }
    if (run.status === 'completed') selectWinners(expected, stored.manifest, [...previous.values()]);
    if (run.trials.some((trial, index) => trial.selected !== expected.trials[index]!.selected ||
        trial.delta !== expected.trials[index]!.delta)) throw new Error('Archived selection does not follow the pinned metric');
    for (const trial of run.trials) {
      const variant = stored.manifest.variants.find((item) => item.id === trial.variantId);
      if (!variant || variant.niche !== trial.niche || trial.parentTrialId !== (previous.get(trial.niche)?.trialId ?? null)) {
        throw new Error('Trial variant or lineage does not match the manifest and prior archive');
      }
      if (variant.generation) {
        const identity = newGenerationReceipt(variant.generation);
        if (!trial.generation || trial.generation.model !== identity.model || trial.generation.endpoint !== identity.endpoint ||
            trial.generation.changedFiles.some((path) => !variant.generation!.files.includes(path)) ||
            (trial.generation.status !== 'succeeded' && (trial.status === 'passed' || trial.artifact !== null))) {
          throw new Error('Trial generation evidence does not match its declared model and file scope');
        }
        const feedback = trial.generation.feedback;
        if (feedback) {
          const prior = [...runs].reverse().find((item) => item.status === 'completed' && item.finishedAt !== null &&
            item.trials.some((candidate) => candidate.variantId === variant.id));
          const source = prior?.trials.find((candidate) => candidate.variantId === variant.id);
          if (!run.feedbackEnabled || !prior || !source || feedback.runId !== prior.id || feedback.trialId !== source.id ||
              feedback.generation !== prior.generation || feedback.comparatorDigest !== prior.comparatorDigest ||
              feedback.artifactDigest !== (source.artifact?.digest ?? null)) {
            throw new Error('Trial feedback does not match the preceding completed variant outcome');
          }
        }
        if (run.feedbackEnabled && trial.generation.promptDigest !== null) {
          const expectedFeedback = buildUniverseFeedback({ manifest: stored.manifest,
            manifestDigest: stored.manifestDigest, comparatorDigest: stored.comparatorDigest,
            runs, elites: [...previous.values()], activeRun: null, sourceState: 'healthy', reasons: [] }, variant, directory);
          if (canonical(feedback ?? null) !== canonical(expectedFeedback ? feedbackReceipt(expectedFeedback) : null)) {
            throw new Error('Trial feedback digest does not match the preceding recorded outcome and source');
          }
        }
      } else if (trial.generation) throw new Error('Command trial cannot claim model generation usage');
      if (trial.artifact && (trial.artifact.path !== join(directory, 'artifacts', run.id, trial.id) ||
          trial.artifact.revision !== stored.manifest.seed.revision)) {
        throw new Error('Trial artifact path is outside its exact archive slot');
      }
      if (run.status === 'completed' && trial.selected && trial.score !== null && trial.artifact) {
        elites.set(trial.niche, { niche: trial.niche, variantId: trial.variantId, trialId: trial.id, runId: run.id,
          generation: run.generation, score: trial.score, metrics: trial.metrics, artifact: trial.artifact,
          comparatorDigest: run.comparatorDigest });
      }
    }
    runs.push(run);
  }
  if (records.some((record) => record.kind === 'trial' && !starts.some((start) => start.run.id === record.runId)) ||
      records.some((record) => record.kind === 'final' && !starts.some((start) => start.run.id === record.run.id))) {
    throw new Error('Orphaned Universe evidence');
  }
  for (const elite of elites.values()) {
    try { if (artifactDigest(elite.artifact.path) !== elite.artifact.digest) reasons.push(`Elite artifact changed: ${elite.niche}`); }
    catch { reasons.push(`Elite artifact unavailable: ${elite.niche}`); }
  }
  return { manifest: stored.manifest, manifestDigest: stored.manifestDigest, comparatorDigest: stored.comparatorDigest,
    runs, elites: reasons.length ? [] : [...elites.values()], activeRun,
    sourceState: reasons.length ? 'degraded' : 'healthy', reasons };
}

/** Round-robin coverage prevents a small per-generation budget starving later variants. */
export function scheduledVariants(manifest: UniverseManifest, generation: number): UniverseManifest['variants'] {
  const count = Math.min(manifest.budget.maxTrials, manifest.variants.length);
  const offset = ((generation - 1) * count) % manifest.variants.length;
  return Array.from({ length: count }, (_, index) => manifest.variants[(offset + index) % manifest.variants.length]!);
}

/** Deterministic selection is shared by the writer and the independent read projection. */
export function selectWinners(run: UniverseRun, manifest: UniverseManifest, prior: UniverseElite[]): void {
  const multiplier = manifest.metric.direction === 'maximize' ? 1 : -1;
  for (const niche of new Set(manifest.variants.map((variant) => variant.niche))) {
    const previous = prior.find((elite) => elite.niche === niche);
    const candidates = run.trials.filter((trial) => trial.niche === niche && trial.status === 'passed' && trial.score !== null);
    for (const trial of candidates) {
      trial.delta = previous ? multiplier * (trial.score! - previous.score) : null;
      if (trial.delta !== null && !Number.isFinite(trial.delta)) throw new Error('Score improvement exceeds finite numeric bounds');
    }
    candidates.sort((a, b) => multiplier * (b.score! - a.score!) ||
      manifest.variants.findIndex((variant) => variant.id === a.variantId) - manifest.variants.findIndex((variant) => variant.id === b.variantId));
    const best = candidates[0];
    if (best && (!previous || (best.delta! > 0 && best.delta! >= manifest.metric.minImprovement))) best.selected = true;
  }
}

export function readUniverseOverview(options: UniverseStoreOptions = {}): UniverseOverview {
  const root = resolve(options.root ?? defaultUniverseRoot());
  const result: UniverseOverview = { schemaVersion: 1, sampledAt: new Date().toISOString(),
    sourceState: 'missing', reasons: [], universes: [], measurementScope: 'local-experiment' };
  try {
    try { lstatSync(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result; throw error; }
    inspectPrivateDirectory(root);
    const directory = join(root, 'universes');
    try { lstatSync(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result; throw error; }
    inspectPrivateDirectory(directory);
    const names = readdirSync(directory).sort();
    if (names.length > 64) throw new Error('Universe inventory limit exceeded');
    result.sourceState = 'healthy';
    for (const id of names) {
      try {
        const path = universePath(root, id);
        inspectPrivateDirectory(path);
        const summary = projectUniverse(path);
        result.universes.push(summary);
        if (summary.sourceState === 'degraded') result.reasons.push(`${id}: ${summary.reasons.join('; ')}`);
      } catch (error) { result.reasons.push(`${id}: ${error instanceof Error ? error.message : 'Unreadable evidence'}`); }
    }
    if (result.reasons.length) result.sourceState = 'degraded';
  } catch (error) {
    result.sourceState = 'degraded';
    result.reasons.push(error instanceof Error ? error.message : 'Universe storage unavailable');
  }
  return result;
}

export function newRun(record: ManifestRecord, generation: number): UniverseRun {
  return { id: randomUUID(), universeId: record.manifest.id, generation, manifestDigest: record.manifestDigest,
    comparatorDigest: record.comparatorDigest, startedAt: new Date().toISOString(), finishedAt: null,
    status: 'running', trials: [], durationMs: 0, tokensUsed: null, costUsd: null };
}

export function parseEvaluation(output: string): { passed: boolean; score: number; metrics: Record<string, number>; diagnostics?: UniverseDiagnostic[] } {
  if (output.length > 24 * 1024) throw new Error('Evaluator output exceeds its bounded JSON protocol');
  const value: unknown = JSON.parse(output.trim());
  if (!object(value) || !exact(value, ['passed', 'score', 'metrics', 'diagnostics']) || typeof value.passed !== 'boolean' ||
      !finite(value.score) || (value.metrics !== undefined && !validMetrics(value.metrics))) {
    throw new Error('Evaluator must emit {passed:boolean, score:finite number, metrics?:numeric object, diagnostics?:shareable diagnostics}');
  }
  return { passed: value.passed, score: value.score, metrics: (value.metrics ?? {}) as Record<string, number>,
    ...(value.diagnostics === undefined ? {} : { diagnostics: validateDiagnostics(value.diagnostics) }) };
}
