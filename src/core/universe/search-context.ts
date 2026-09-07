import { canonical, digest } from './artifacts.js';
import type {
  UniverseElite, UniverseSearchAttempt, UniverseSearchContext, UniverseSearchContextReceipt,
  UniverseSummary, UniverseTrial, UniverseVariant,
} from './types.js';

export const MAX_SEARCH_CONTEXT_ATTEMPTS = 16;
const MAX_HISTORY_RUNS = 10_000;
const MAX_CONTEXT_BYTES = 16 * 1024;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RECORD_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
type Parent = UniverseSearchContext['parent'];

function invalid(detail: string): never { throw new Error(`Invalid Universe search context: ${detail}`); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every((key) => typeof key === 'string' && keys.includes(key));
}
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function integer(value: unknown, low: number, high: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= low && Number(value) <= high;
}
function hash(value: unknown): value is string { return typeof value === 'string' && HASH.test(value); }
function identity(value: unknown, record = false): value is string {
  return typeof value === 'string' && (record ? RECORD_ID : ID).test(value);
}
function validAttempt(value: unknown, generation: number): value is UniverseSearchAttempt {
  return object(value) && identity(value.runId, true) && identity(value.trialId, true) &&
    integer(value.generation, 1, generation - 1) && (value.artifactDigest === null || hash(value.artifactDigest));
}
function attempt(value: UniverseSearchAttempt): UniverseSearchAttempt {
  return { runId: value.runId, trialId: value.trialId, generation: value.generation, artifactDigest: value.artifactDigest };
}
function sameOccurrence(left: Parent, right: Parent): boolean {
  return left === null || right === null ? left === right : left.runId === right.runId && left.trialId === right.trialId;
}

/** Revalidate the complete bounded data-only protocol at the model boundary. */
export function validateUniverseSearchContext(value: unknown): UniverseSearchContext {
  if (!object(value) || !exact(value, ['schemaVersion', 'universeId', 'manifestDigest', 'comparatorDigest', 'variantId',
    'niche', 'generation', 'metric', 'parent', 'previous', 'repetition']) || value.schemaVersion !== 2 ||
      !identity(value.universeId) || !identity(value.variantId) || !identity(value.niche) ||
      !hash(value.manifestDigest) || !hash(value.comparatorDigest) || !integer(value.generation, 1, MAX_HISTORY_RUNS + 1) ||
      !object(value.metric) || !exact(value.metric, ['name', 'direction', 'minImprovement']) ||
      typeof value.metric.name !== 'string' || !value.metric.name.trim() || value.metric.name.length > 120 || value.metric.name.includes('\0') ||
      typeof value.metric.direction !== 'string' || !['maximize', 'minimize'].includes(value.metric.direction) ||
      !finite(value.metric.minImprovement) || value.metric.minImprovement < 0) {
    invalid('bounded version, identity and pinned metric required');
  }
  let parent: Parent = null;
  if (value.parent !== null) {
    if (!object(value.parent) || !exact(value.parent, ['runId', 'trialId', 'generation', 'artifactDigest', 'score']) ||
        !validAttempt(value.parent, value.generation) || !hash(value.parent.artifactDigest) || !finite(value.parent.score)) {
      invalid('retained parent must name a measured historical occurrence');
    }
    parent = { ...attempt(value.parent), artifactDigest: value.parent.artifactDigest, score: value.parent.score };
  }
  let previous: UniverseSearchContext['previous'] = null;
  if (value.previous !== null) {
    if (!object(value.previous) || !exact(value.previous, ['runId', 'trialId', 'generation', 'artifactDigest', 'status', 'score', 'selected', 'delta']) ||
        !validAttempt(value.previous, value.generation) || typeof value.previous.status !== 'string' ||
        !['passed', 'failed', 'timed-out', 'cancelled'].includes(value.previous.status) ||
        (value.previous.score !== null && !finite(value.previous.score)) || typeof value.previous.selected !== 'boolean' ||
        (value.previous.delta !== null && !finite(value.previous.delta)) ||
        (value.previous.status === 'passed' && (!finite(value.previous.score) || !hash(value.previous.artifactDigest))) ||
        (value.previous.status !== 'passed' && (value.previous.selected || value.previous.delta !== null)) ||
        (value.previous.selected && value.previous.delta !== null &&
          (value.previous.delta <= 0 || value.previous.delta < value.metric.minImprovement))) {
      invalid('previous outcome must preserve recorded status and selection semantics');
    }
    previous = { ...attempt(value.previous), status: value.previous.status as UniverseTrial['status'],
      score: value.previous.score, selected: value.previous.selected, delta: value.previous.delta };
  }
  const repeated = value.repetition;
  if (!object(repeated) || !exact(repeated, ['scope', 'limit', 'totalAttempts', 'sampledAttempts', 'truncated',
    'latestArtifactDigest', 'matchingArtifactCount']) || repeated.scope !== 'same-variant-current-parent' ||
      repeated.limit !== MAX_SEARCH_CONTEXT_ATTEMPTS || !integer(repeated.totalAttempts, 0, value.generation - 1) ||
      !Array.isArray(repeated.sampledAttempts) || repeated.sampledAttempts.length !== Math.min(repeated.totalAttempts, MAX_SEARCH_CONTEXT_ATTEMPTS) ||
      repeated.truncated !== (repeated.totalAttempts > MAX_SEARCH_CONTEXT_ATTEMPTS) ||
      !integer(repeated.matchingArtifactCount, 0, MAX_SEARCH_CONTEXT_ATTEMPTS) ||
      (repeated.latestArtifactDigest !== null && !hash(repeated.latestArtifactDigest))) {
    invalid('exact bounded repetition coverage required');
  }
  const sampledAttempts: UniverseSearchAttempt[] = [];
  const runIds = new Set<string>();
  for (const candidate of repeated.sampledAttempts) {
    if (!object(candidate) || !exact(candidate, ['runId', 'trialId', 'generation', 'artifactDigest']) ||
        !validAttempt(candidate, value.generation) || runIds.has(candidate.runId) ||
        (sampledAttempts.length > 0 && candidate.generation <= sampledAttempts.at(-1)!.generation) ||
        (parent !== null && candidate.generation <= parent.generation)) {
      invalid('repetition sample must contain ordered historical parent-scoped occurrences');
    }
    runIds.add(candidate.runId); sampledAttempts.push(attempt(candidate));
  }
  const latest = sampledAttempts.at(-1);
  const latestArtifactDigest = latest?.artifactDigest ?? null;
  const matchingArtifactCount = latestArtifactDigest === null ? 0 :
    sampledAttempts.filter((item) => item.artifactDigest === latestArtifactDigest).length;
  if (repeated.latestArtifactDigest !== latestArtifactDigest || repeated.matchingArtifactCount !== matchingArtifactCount ||
      (latest && (!previous || canonical(attempt(previous)) !== canonical(latest)))) {
    invalid('repetition counts must match the sampled latest recorded outcome');
  }
  const context: UniverseSearchContext = { schemaVersion: 2, universeId: value.universeId, manifestDigest: value.manifestDigest,
    comparatorDigest: value.comparatorDigest, variantId: value.variantId, niche: value.niche, generation: value.generation,
    metric: { name: value.metric.name, direction: value.metric.direction as 'maximize' | 'minimize', minImprovement: value.metric.minImprovement },
    parent, previous, repetition: { scope: 'same-variant-current-parent', limit: 16, totalAttempts: repeated.totalAttempts,
      sampledAttempts, truncated: repeated.truncated, latestArtifactDigest, matchingArtifactCount } };
  if (Buffer.byteLength(canonical(context), 'utf8') > MAX_CONTEXT_BYTES) invalid('serialized metadata exceeds its byte budget');
  return context;
}

function retained(elite: UniverseElite): NonNullable<Parent> {
  return { runId: elite.runId, trialId: elite.trialId, generation: elite.generation,
    artifactDigest: elite.artifact.digest, score: elite.score };
}

/**
 * Pure projection of already validated history; no files, providers or evaluators
 * are read. Parent occurrences are reconstructed before each generation's winners
 * are applied, so siblings never become one another's edit parents.
 */
export function buildUniverseSearchContext(summary: UniverseSummary, variant: UniverseVariant): UniverseSearchContext {
  if (summary.sourceState !== 'healthy' || summary.reasons.length || !variant.generation || variant.command !== undefined || variant.model !== undefined ||
      summary.manifest.variants.length > 64 || summary.runs.length > MAX_HISTORY_RUNS) invalid('healthy bounded model-variant history required');
  const declared = summary.manifest.variants.find((item) => item.id === variant.id);
  if (!declared || canonical(declared) !== canonical(variant)) invalid('variant must match its pinned manifest');
  const generation = summary.runs.length + 1;
  const runs = [...summary.runs].sort((left, right) => left.generation - right.generation);
  const runIds = new Set<string>();
  const archive = new Map<string, NonNullable<Parent>>();
  const history: Array<{ attempt: UniverseSearchAttempt; parent: Parent }> = [];
  let previous: UniverseSearchContext['previous'] = null;
  for (const [index, run] of runs.entries()) {
    if (run.generation !== index + 1 || !identity(run.id, true) || runIds.has(run.id) ||
        run.universeId !== summary.manifest.id || run.manifestDigest !== summary.manifestDigest || run.comparatorDigest !== summary.comparatorDigest ||
        !Array.isArray(run.trials) || run.trials.length > 64 || new Set(run.trials.map((trial) => trial.variantId)).size !== run.trials.length ||
        new Set(run.trials.map((trial) => trial.id)).size !== run.trials.length ||
        !['running', 'completed', 'interrupted', 'failed'].includes(run.status) || (run.status === 'completed' && run.finishedAt === null)) {
      invalid('history must preserve contiguous generations, unique occurrences and comparator scope');
    }
    runIds.add(run.id);
    const winners = new Map<string, NonNullable<Parent>>();
    for (const trial of run.trials) {
      const configured = summary.manifest.variants.find((item) => item.id === trial.variantId);
      const parent = archive.get(trial.niche) ?? null;
      if (!configured || configured.niche !== trial.niche || trial.parentTrialId !== (parent?.trialId ?? null)) {
        invalid('trial ancestry must match the retained pre-generation archive');
      }
      if (run.status !== 'completed') {
        if (trial.selected) invalid('unfinished or unsuccessful generations cannot supply selected parents');
        continue;
      }
      if (trial.variantId === variant.id) {
        const source = { runId: run.id, trialId: trial.id, generation: run.generation, artifactDigest: trial.artifact?.digest ?? null };
        previous = { ...source, status: trial.status, score: trial.score, selected: trial.selected, delta: trial.delta };
        history.push({ attempt: source, parent });
      }
      if (trial.selected) {
        if (winners.has(trial.niche) || trial.status !== 'passed' || !finite(trial.score) || !trial.artifact || !hash(trial.artifact.digest)) {
          invalid('selected parent must be a unique measured passing occurrence');
        }
        winners.set(trial.niche, { runId: run.id, trialId: trial.id, generation: run.generation,
          artifactDigest: trial.artifact.digest, score: trial.score });
      }
    }
    for (const [niche, winner] of winners) archive.set(niche, winner);
  }
  const parent = archive.get(variant.niche) ?? null;
  const supplied = summary.elites.filter((elite) => elite.niche === variant.niche);
  if (supplied.length > 1 || (supplied[0] && supplied[0].comparatorDigest !== summary.comparatorDigest) ||
      canonical(parent) !== canonical(supplied[0] ? retained(supplied[0]) : null)) {
    invalid('current retained parent must match the completed historical archive');
  }
  const eligible = history.filter((entry) => sameOccurrence(entry.parent, parent));
  const sampledAttempts = eligible.slice(-MAX_SEARCH_CONTEXT_ATTEMPTS).map((entry) => entry.attempt);
  const latestArtifactDigest = sampledAttempts.at(-1)?.artifactDigest ?? null;
  return validateUniverseSearchContext({ schemaVersion: 2, universeId: summary.manifest.id, manifestDigest: summary.manifestDigest,
    comparatorDigest: summary.comparatorDigest, variantId: variant.id, niche: variant.niche, generation, metric: summary.manifest.metric,
    parent, previous, repetition: { scope: 'same-variant-current-parent', limit: 16, totalAttempts: eligible.length,
      sampledAttempts, truncated: eligible.length > MAX_SEARCH_CONTEXT_ATTEMPTS, latestArtifactDigest,
      matchingArtifactCount: latestArtifactDigest === null ? 0 : sampledAttempts.filter((item) => item.artifactDigest === latestArtifactDigest).length } });
}

/** Persist only the version and digest of exactly the validated metadata sent. */
export function searchContextReceipt(context: UniverseSearchContext): UniverseSearchContextReceipt {
  return { schemaVersion: 2, digest: digest(canonical(validateUniverseSearchContext(context))) };
}
