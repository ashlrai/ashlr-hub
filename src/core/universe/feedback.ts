import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { artifactDigest, canonical, digest, inspectPrivateDirectory } from './artifacts.js';
import { validGenerationPath, validateGenerationConfig } from './generation.js';
import type { UniverseDiagnostic, UniverseFeedback, UniverseGenerationReceipt, UniverseSummary, UniverseVariant } from './types.js';

export const MAX_FEEDBACK_FILE_BYTES = 64 * 1024;
export const MAX_FEEDBACK_CONTEXT_BYTES = 128 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max &&
    [...value].every((character) => { const code = character.charCodeAt(0); return code >= 32 && (code < 127 || code > 159); }) &&
    Buffer.from(value, 'utf8').toString('utf8') === value;
}
function identifier(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }
function hash(value: unknown): value is string { return typeof value === 'string' && HASH.test(value); }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }

/** Only deliberately shareable evaluator diagnostics enter subsequent prompts. */
export function validateDiagnostics(value: unknown): UniverseDiagnostic[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error('Invalid Universe diagnostics: bounded array required');
  const diagnostics = value.map((item: unknown) => {
    if (!object(item) || !exact(item, ['code', 'message', 'path', 'line']) ||
        typeof item.code !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(item.code) ||
        !text(item.message, 512) || (item.path !== undefined && (!text(item.path, 512) || !validGenerationPath(item.path))) ||
        (item.line !== undefined && !positive(item.line))) {
      throw new Error('Invalid Universe diagnostics: code, shareable message, relative path and positive line required');
    }
    return { code: item.code, message: item.message,
      ...(item.path === undefined ? {} : { path: item.path }), ...(item.line === undefined ? {} : { line: item.line }) };
  });
  if (Buffer.byteLength(canonical(diagnostics), 'utf8') > 8 * 1024) throw new Error('Invalid Universe diagnostics: byte limit exceeded');
  return diagnostics;
}

function validMetrics(value: unknown): value is Record<string, number> {
  return object(value) && Object.keys(value).length <= 32 && Object.entries(value).every(([key, item]) =>
    /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(key) && typeof item === 'number' && Number.isFinite(item));
}

/** Validate again at the model boundary; callers cannot extend file authority. */
export function validateUniverseFeedback(value: unknown, paths: string[]): UniverseFeedback {
  if (!object(value) || !exact(value, ['schemaVersion', 'source', 'status', 'score', 'metrics', 'diagnostics', 'previousAttemptFiles']) ||
      value.schemaVersion !== 1 || !object(value.source) ||
      !exact(value.source, ['runId', 'trialId', 'generation', 'comparatorDigest', 'artifactDigest']) ||
      !identifier(value.source.runId) || !identifier(value.source.trialId) || !positive(value.source.generation) ||
      !hash(value.source.comparatorDigest) || (value.source.artifactDigest !== null && !hash(value.source.artifactDigest)) ||
      !['passed', 'failed', 'timed-out', 'cancelled'].includes(String(value.status)) ||
      (value.score !== null && (typeof value.score !== 'number' || !Number.isFinite(value.score))) || !validMetrics(value.metrics) ||
      !Array.isArray(value.previousAttemptFiles) || value.previousAttemptFiles.length > paths.length ||
      (value.source.artifactDigest === null && value.previousAttemptFiles.length !== 0)) {
    throw new Error('Invalid Universe feedback: bounded recorded outcome required');
  }
  const diagnostics = validateDiagnostics(value.diagnostics);
  const allowed = new Set(paths);
  const seen = new Set<string>();
  let bytes = 0;
  const previousAttemptFiles = value.previousAttemptFiles.map((file: unknown) => {
    if (!object(file) || !exact(file, ['path', 'contentDigest', 'content']) || !validGenerationPath(file.path) ||
        !allowed.has(file.path) || seen.has(file.path) || typeof file.content !== 'string' || file.content.includes('\0') ||
        Buffer.from(file.content, 'utf8').toString('utf8') !== file.content || !hash(file.contentDigest) || digest(file.content) !== file.contentDigest) {
      throw new Error('Invalid Universe feedback: unique declared text files with matching digests required');
    }
    seen.add(file.path);
    const size = Buffer.byteLength(file.content, 'utf8');
    bytes += size;
    if (size > MAX_FEEDBACK_FILE_BYTES || bytes > MAX_FEEDBACK_CONTEXT_BYTES) throw new Error('Invalid Universe feedback: file context byte limit exceeded');
    return { path: file.path, contentDigest: file.contentDigest, content: file.content };
  });
  return { schemaVersion: 1, source: { runId: value.source.runId, trialId: value.source.trialId,
    generation: value.source.generation, comparatorDigest: value.source.comparatorDigest, artifactDigest: value.source.artifactDigest },
  status: value.status as UniverseFeedback['status'], score: value.score as number | null, metrics: { ...value.metrics },
  diagnostics, previousAttemptFiles };
}

function sameFile(before: Stats, after: Stats): boolean {
  return after.isFile() && !after.isSymbolicLink() && after.nlink === 1 && before.dev === after.dev &&
    before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

function readPreviousFiles(root: string, paths: string[]): UniverseFeedback['previousAttemptFiles'] {
  let bytes = 0;
  return paths.map((path) => {
    const absolute = join(root, path);
    if (realpathSync(dirname(absolute)) !== dirname(absolute)) throw new Error('Universe feedback artifact path contains a symlink');
    const before = lstatSync(absolute);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_FEEDBACK_FILE_BYTES) {
      throw new Error('Universe feedback requires bounded regular single-link source files');
    }
    const fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!sameFile(before, fstatSync(fd))) throw new Error('Universe feedback file changed before reading');
      const data = readFileSync(fd);
      if (!sameFile(before, fstatSync(fd)) || !sameFile(before, lstatSync(absolute)) || data.length !== before.size) {
        throw new Error('Universe feedback file changed while reading');
      }
      bytes += data.byteLength;
      if (bytes > MAX_FEEDBACK_CONTEXT_BYTES) throw new Error('Universe feedback source context byte limit exceeded');
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
      if (content.includes('\0')) throw new Error('Universe feedback source must not contain NUL bytes');
      return { path, contentDigest: digest(data), content };
    } finally { closeSync(fd); }
  });
}

/** A verified history supplies correction context, never a replacement elite parent. */
export function buildUniverseFeedback(summary: UniverseSummary, variant: UniverseVariant, directory: string): UniverseFeedback | undefined {
  if (!variant.generation) return undefined;
  if (summary.sourceState !== 'healthy') throw new Error('Universe feedback requires healthy verified history');
  const declared = summary.manifest.variants.find((item) => item.id === variant.id);
  if (!declared || canonical(declared) !== canonical(variant)) throw new Error('Universe feedback variant does not match its manifest');
  const config = validateGenerationConfig(variant.generation);
  const run = [...summary.runs].sort((a, b) => b.generation - a.generation).find((item) =>
    item.status === 'completed' && item.finishedAt !== null && item.trials.some((trial) => trial.variantId === variant.id));
  if (!run) return undefined;
  if (run.universeId !== summary.manifest.id || run.manifestDigest !== summary.manifestDigest || run.comparatorDigest !== summary.comparatorDigest) {
    throw new Error('Universe feedback history does not match its immutable comparator');
  }
  const trial = run.trials.find((item) => item.variantId === variant.id)!;
  if (trial.niche !== variant.niche) throw new Error('Universe feedback trial niche does not match its variant');
  let previousAttemptFiles: UniverseFeedback['previousAttemptFiles'] = [];
  if (trial.artifact) {
    const path = trial.artifact.path;
    if (!identifier(run.id) || !identifier(trial.id) || resolve(path) !== path ||
        resolve(directory) !== directory || path !== join(directory, 'artifacts', run.id, trial.id) ||
        trial.artifact.revision !== summary.manifest.seed.revision) {
      throw new Error('Universe feedback artifact is outside its exact archive slot');
    }
    inspectPrivateDirectory(directory);
    if (realpathSync(path) !== path || artifactDigest(path) !== trial.artifact.digest) throw new Error('Universe feedback artifact changed before reading');
    previousAttemptFiles = readPreviousFiles(path, config.files);
    if (artifactDigest(path) !== trial.artifact.digest || realpathSync(path) !== path) throw new Error('Universe feedback artifact changed while reading');
  }
  return validateUniverseFeedback({ schemaVersion: 1,
    source: { runId: run.id, trialId: trial.id, generation: run.generation, comparatorDigest: run.comparatorDigest,
      artifactDigest: trial.artifact?.digest ?? null }, status: trial.status, score: trial.score, metrics: trial.metrics,
    diagnostics: trial.diagnostics ?? [], previousAttemptFiles }, config.files);
}

/** Persist only provenance and a digest of the exact feedback sent to the model. */
export function feedbackReceipt(feedback: UniverseFeedback): NonNullable<UniverseGenerationReceipt['feedback']> {
  return { ...feedback.source, digest: digest(canonical(feedback)) };
}
