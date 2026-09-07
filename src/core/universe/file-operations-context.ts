import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonical, digest, inspectPrivateDirectory, readArtifactSnapshot } from './artifacts.js';
import { fileOperationsPathKey, validateGenerationConfig, validFileOperationsPath, validGenerationReceipt } from './generation.js';
import type { UniverseArtifact, UniverseGenerationConfig, UniverseGenerationReceipt, UniverseSummary, UniverseVariant } from './types.js';
import type { UniverseFileOperationsContext, UniverseFileState } from './file-operations-types.js';

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 128 * 1024;
export const MAX_FILE_OPERATIONS_CONTEXT_BYTES = 160 * 1024;

function fail(reason: string): never { throw new Error(`Invalid Universe file operations: ${reason}`); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}
function hash(value: unknown): value is string { return typeof value === 'string' && HASH.test(value); }
function id(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }
function generation(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 10_001; }
function states(value: unknown, paths: string[]): UniverseFileState[] {
  if (!Array.isArray(value) || value.length !== paths.length) fail('file-state scope does not match the declared order');
  return value.map((item: unknown, index) => {
    if (!object(item) || !exact(item, ['path', 'contentDigest']) || item.path !== paths[index] ||
        (item.contentDigest !== null && !hash(item.contentDigest))) fail('file-state path or content identity is invalid');
    return { path: item.path as string, contentDigest: item.contentDigest as string | null };
  });
}

/** Independent input boundary; no caller can add paths through its context. */
export function validateUniverseFileOperationsContext(value: unknown, config: UniverseGenerationConfig): UniverseFileOperationsContext {
  const validated = validateGenerationConfig(config);
  if (!validated.fileOperations || !object(value) || !exact(value, ['schemaVersion', 'universeId', 'manifestDigest',
    'comparatorDigest', 'variantId', 'generation', 'parent', 'files', 'contextFiles', 'previous']) || value.schemaVersion !== 1 ||
      !id(value.universeId) || !id(value.variantId) || !hash(value.manifestDigest) || !hash(value.comparatorDigest) || !generation(value.generation) ||
      !object(value.parent) || !exact(value.parent, ['runId', 'trialId', 'generation', 'artifactDigest']) || !hash(value.parent.artifactDigest) ||
      !(value.parent.runId === null && value.parent.trialId === null && value.parent.generation === 0 ||
        id(value.parent.runId) && id(value.parent.trialId) && generation(value.parent.generation) && value.parent.generation < value.generation) ||
      !Array.isArray(value.contextFiles) || value.contextFiles.length !== validated.fileOperations.contextFiles.length) fail('bounded identity and parent context required');
  const files = states(value.files, validated.files);
  let bytes = 0;
  const contextFiles = value.contextFiles.map((item: unknown, index) => {
    if (!object(item) || !exact(item, ['path', 'contentDigest', 'content']) || item.path !== validated.fileOperations!.contextFiles[index] ||
        typeof item.content !== 'string' || item.content.includes('\0') || Buffer.from(item.content, 'utf8').toString('utf8') !== item.content ||
        !hash(item.contentDigest) || digest(item.content) !== item.contentDigest) fail('read-only context does not match its declared path and bytes');
    const size = Buffer.byteLength(item.content, 'utf8'); bytes += size;
    if (size > MAX_FILE_BYTES || bytes > MAX_TEXT_BYTES) fail('read-only context byte limit exceeded');
    return { path: item.path as string, contentDigest: item.contentDigest, content: item.content };
  });
  let previous: UniverseFileOperationsContext['previous'] = null;
  if (value.previous !== null) {
    if (!object(value.previous) || !exact(value.previous, ['runId', 'trialId', 'generation', 'artifactDigest', 'files']) ||
        !id(value.previous.runId) || !id(value.previous.trialId) || !generation(value.previous.generation) || value.previous.generation >= value.generation ||
        (value.previous.artifactDigest !== null && !hash(value.previous.artifactDigest))) fail('previous attempt identity is invalid');
    previous = { runId: value.previous.runId, trialId: value.previous.trialId, generation: value.previous.generation,
      artifactDigest: value.previous.artifactDigest as string | null,
      files: states(value.previous.files, value.previous.artifactDigest === null ? [] : validated.files) };
    if (previous.runId === value.parent.runId && previous.trialId === value.parent.trialId &&
        (previous.generation !== value.parent.generation || previous.artifactDigest !== value.parent.artifactDigest)) {
      fail('shared parent and previous occurrence identities disagree');
    }
  }
  const result: UniverseFileOperationsContext = { schemaVersion: 1, universeId: value.universeId, manifestDigest: value.manifestDigest,
    comparatorDigest: value.comparatorDigest, variantId: value.variantId, generation: value.generation,
    parent: { runId: value.parent.runId as string | null, trialId: value.parent.trialId as string | null,
      generation: value.parent.generation as number, artifactDigest: value.parent.artifactDigest }, files, contextFiles, previous };
  if (Buffer.byteLength(canonical(result), 'utf8') > MAX_FILE_OPERATIONS_CONTEXT_BYTES) fail('file-state context byte limit exceeded');
  return result;
}

interface FileInput { path: string; contentDigest: string | null; content: string | null }

/** Read only a complete, digest-verified artifact. Missing paths are explicit. */
export function readUniverseFileOperationInputs(artifact: UniverseArtifact, config: UniverseGenerationConfig): {
  files: FileInput[]; contextFiles: Array<{ path: string; contentDigest: string; content: string }>;
} {
  const validated = validateGenerationConfig(config);
  if (!validated.fileOperations || realpathSync(artifact.path) !== artifact.path) fail('an exact physical artifact and opt-in configuration are required');
  const snapshot = readArtifactSnapshot(artifact.path);
  if (snapshot.digest !== artifact.digest) fail('artifact bytes changed before file-state reading');
  const entries = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
  const aliases = new Map(snapshot.entries.map((entry) => [fileOperationsPathKey(entry.path), entry.path]));
  let total = 0;
  const read = (path: string, required: boolean): FileInput => {
    const key = fileOperationsPathKey(path);
    const alias = aliases.get(key);
    if (alias !== undefined && alias !== path || [...aliases.keys()].some((other) => key.startsWith(`${other}/`) || other.startsWith(`${key}/`))) {
      fail('declared path aliases or conflicts with an artifact entry');
    }
    const entry = entries.get(path);
    if (!entry) {
      try { lstatSync(join(artifact.path, path)); fail('declared file is not a regular artifact entry'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (required) fail('declared read-only context file is missing');
      return { path, contentDigest: null, content: null };
    }
    if (entry.data.length > MAX_FILE_BYTES || (total += entry.data.length) > MAX_TEXT_BYTES) fail('declared file byte limit exceeded');
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(entry.data); }
    catch { fail('declared files must contain valid UTF-8 text'); }
    if (content.includes('\0')) fail('declared files must not contain NUL bytes');
    return { path, contentDigest: digest(entry.data), content };
  };
  const files = validated.files.map((path) => read(path, false));
  const contextFiles = validated.fileOperations.contextFiles.map((path) => read(path, true) as { path: string; contentDigest: string; content: string });
  return { files, contextFiles };
}

function checkedArtifact(artifact: UniverseArtifact, expectedPath: string, revision: string): UniverseArtifact {
  if (artifact.path !== expectedPath || resolve(artifact.path) !== artifact.path || artifact.revision !== revision || !hash(artifact.digest)) {
    fail('artifact is outside its exact immutable source slot');
  }
  return artifact;
}

/** Bind current and previous file presence to the immutable historical prefix. */
export function buildUniverseFileOperationsContext(summary: UniverseSummary, variant: UniverseVariant, directory: string,
  seedArtifact: UniverseArtifact, options: { feedback?: true } = {}): UniverseFileOperationsContext {
  if (summary.sourceState !== 'healthy' || !variant.generation || !variant.generation.fileOperations ||
      summary.runs.length > 10_000 || summary.manifest.variants.length > 64 || resolve(directory) !== directory ||
      canonical(summary.manifest.variants.find((item) => item.id === variant.id)) !== canonical(variant)) fail('healthy scoped opt-in history required');
  inspectPrivateDirectory(directory);
  const config = validateGenerationConfig(variant.generation);
  const elite = summary.elites.find((item) => item.niche === variant.niche);
  const parentArtifact = elite ? checkedArtifact(elite.artifact, join(directory, 'artifacts', elite.runId, elite.trialId), summary.manifest.seed.revision) :
    checkedArtifact(seedArtifact, join(directory, 'seed'), summary.manifest.seed.revision);
  if (elite) {
    const run = summary.runs.find((item) => item.id === elite.runId && item.status === 'completed');
    const trial = run?.trials.find((item) => item.id === elite.trialId && item.selected && item.status === 'passed');
    if (!trial || trial.niche !== variant.niche || trial.artifact?.digest !== elite.artifact.digest || run!.generation !== elite.generation ||
        elite.comparatorDigest !== summary.comparatorDigest) fail('retained parent occurrence does not match verified history');
  }
  const parent = readUniverseFileOperationInputs(parentArtifact, config);
  let previous: UniverseFileOperationsContext['previous'] = null;
  if (options.feedback) {
    const run = [...summary.runs].sort((a, b) => b.generation - a.generation).find((item) =>
      item.status === 'completed' && item.finishedAt !== null && item.trials.some((trial) => trial.variantId === variant.id));
    const trial = run?.trials.find((item) => item.variantId === variant.id);
    if (run && trial) {
      if (run.universeId !== summary.manifest.id || run.manifestDigest !== summary.manifestDigest ||
          run.comparatorDigest !== summary.comparatorDigest || trial.niche !== variant.niche) fail('previous attempt does not match immutable history');
      previous = { runId: run.id, trialId: trial.id, generation: run.generation, artifactDigest: trial.artifact?.digest ?? null,
        files: trial.artifact ? readUniverseFileOperationInputs(checkedArtifact(trial.artifact,
          join(directory, 'artifacts', run.id, trial.id), summary.manifest.seed.revision), config).files
          .map(({ path, contentDigest }) => ({ path, contentDigest })) : [] };
    }
  }
  return validateUniverseFileOperationsContext({ schemaVersion: 1, universeId: summary.manifest.id,
    manifestDigest: summary.manifestDigest, comparatorDigest: summary.comparatorDigest, variantId: variant.id, generation: summary.runs.length + 1,
    parent: { runId: elite?.runId ?? null, trialId: elite?.trialId ?? null, generation: elite?.generation ?? 0, artifactDigest: parentArtifact.digest },
    files: parent.files.map(({ path, contentDigest }) => ({ path, contentDigest })), contextFiles: parent.contextFiles, previous }, config);
}

export function fileOperationsContextDigest(context: UniverseFileOperationsContext): string { return digest(canonical(context)); }

/** Replay checks full artifact deltas, including any undeclared writes or mode changes. */
export function verifyUniverseFileOperationOutcome(config: UniverseGenerationConfig, receipt: UniverseGenerationReceipt,
  parent: UniverseArtifact, artifact: UniverseArtifact): void {
  config = validateGenerationConfig(config);
  if (!config.fileOperations || !validGenerationReceipt(receipt) || !receipt.fileOperations || receipt.status !== 'succeeded' ||
      realpathSync(parent.path) !== parent.path || realpathSync(artifact.path) !== artifact.path) fail('successful operation evidence and physical artifacts are required');
  const before = readArtifactSnapshot(parent.path);
  const after = readArtifactSnapshot(artifact.path);
  if (before.digest !== parent.digest || after.digest !== artifact.digest) fail('operation artifact bytes changed');
  const beforeEntries = new Map(before.entries.map((entry) => [entry.path, { contentDigest: digest(entry.data), executable: entry.executable }]));
  const afterEntries = new Map(after.entries.map((entry) => [entry.path, { contentDigest: digest(entry.data), executable: entry.executable }]));
  const changes = [...new Set([...beforeEntries.keys(), ...afterEntries.keys()])].filter((path) =>
    canonical(beforeEntries.get(path) ?? null) !== canonical(afterEntries.get(path) ?? null));
  if (changes.length !== receipt.fileOperations.operations.length || changes.some((path) => !config.files.includes(path)) ||
      new Set(receipt.fileOperations.operations.map((operation) => operation.path)).size !== changes.length) fail('artifact changes exceed the exact declared operations');
  for (const operation of receipt.fileOperations.operations) {
    const prior = beforeEntries.get(operation.path); const next = afterEntries.get(operation.path);
    if (!validFileOperationsPath(operation.path) || !changes.includes(operation.path) ||
        operation.beforeDigest !== (prior?.contentDigest ?? null) || operation.afterDigest !== (next?.contentDigest ?? null) ||
        (operation.op === 'create' ? prior !== undefined || next === undefined || next.executable :
          operation.op === 'delete' ? prior === undefined || next !== undefined :
            prior === undefined || next === undefined || prior.executable !== next.executable || prior.contentDigest === next.contentDigest)) {
      fail('operation before and after states do not match immutable artifacts');
    }
  }
}
