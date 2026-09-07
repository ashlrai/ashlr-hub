import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactDigest, canonical, copyArtifact, digest } from '../src/core/universe/artifacts.js';
import { buildUniverseFileOperationsContext, fileOperationsContextDigest, validateUniverseFileOperationsContext } from '../src/core/universe/file-operations-context.js';
import { buildUniverseFeedback } from '../src/core/universe/feedback.js';
import { newGenerationReceipt, validateGenerationConfig, validGenerationReceipt } from '../src/core/universe/generation.js';
import { preflightTrialEvidenceBudget } from '../src/core/universe/evidence-size.js';
import type { UniverseArtifact, UniverseGenerationConfig, UniverseGenerationReceipt, UniverseRun, UniverseSummary, UniverseTrial } from '../src/core/universe/types.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const A = digest('A'); const B = digest('B');
const configuration = (): UniverseGenerationConfig => ({ kind: 'local-chat', endpoint: 'http://127.0.0.1:11434/v1', model: 'fixture',
  files: ['main.ts', 'helper.ts', 'obsolete.ts'], maxOutputTokens: 256, fileOperations: { schemaVersion: 1, contextFiles: ['types.ts'] } });

function fixture(): { directory: string; summary: UniverseSummary; seed: UniverseArtifact } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'universe-file-contract-'))); roots.push(root);
  const directory = join(root, 'universes', 'fixture'); const path = join(directory, 'seed');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(path, 'main.ts'), 'export const value = 0;'); writeFileSync(join(path, 'types.ts'), 'export type Value = number;');
  writeFileSync(join(path, 'obsolete.ts'), 'old implementation');
  const seed = { path, digest: artifactDigest(path), revision: 'a'.repeat(40) };
  const summary: UniverseSummary = { manifest: { schemaVersion: 1, id: 'fixture', name: 'Fixture', objective: 'Implement a helper',
    seed: { repo: '/unused/repository', revision: seed.revision }, metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
    evaluation: { command: ['never-executed'], timeoutMs: 1000 }, budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 1000, trialTimeoutMs: 1000 },
    variants: [{ id: 'candidate', niche: 'quality', hypothesis: 'Extract a helper', generation: configuration() }] },
  manifestDigest: 'b'.repeat(64), comparatorDigest: 'c'.repeat(64), runs: [], elites: [], activeRun: null, sourceState: 'healthy', reasons: [] };
  return { directory, summary, seed };
}
function build(data: ReturnType<typeof fixture>, feedback = false) {
  return buildUniverseFileOperationsContext(data.summary, data.summary.manifest.variants[0], data.directory, data.seed, feedback ? { feedback: true } : {});
}
function previous(data: ReturnType<typeof fixture>, selected = false): UniverseRun {
  const artifact = join(data.directory, 'artifacts', 'run-1', 'trial-1');
  mkdirSync(join(data.directory, 'artifacts', 'run-1'), { recursive: true, mode: 0o700 }); copyArtifact(data.seed.path, artifact);
  writeFileSync(join(artifact, 'helper.ts'), 'export const helper = 1;'); unlinkSync(join(artifact, 'obsolete.ts'));
  const trial: UniverseTrial = { id: 'trial-1', variantId: 'candidate', niche: 'quality', parentTrialId: null, status: selected ? 'passed' : 'failed',
    score: selected ? 1 : 0, metrics: {}, artifact: { path: artifact, digest: artifactDigest(artifact), revision: data.seed.revision },
    durationMs: 1, delta: null, selected };
  const run: UniverseRun = { id: 'run-1', universeId: 'fixture', generation: 1, manifestDigest: data.summary.manifestDigest,
    comparatorDigest: data.summary.comparatorDigest, startedAt: '2026-09-07T00:00:00.000Z', finishedAt: '2026-09-07T00:00:01.000Z',
    status: 'completed', trials: [trial], durationMs: 1, tokensUsed: null, costUsd: null };
  data.summary.runs.push(run);
  if (selected) data.summary.elites.push({ niche: trial.niche, variantId: trial.variantId, trialId: trial.id, runId: run.id,
    generation: 1, score: 1, metrics: {}, artifact: trial.artifact!, comparatorDigest: run.comparatorDigest });
  return run;
}

describe('opt-in file operation configuration and receipt compatibility', () => {
  it('preserves normalized legacy config and exact baseline receipt without adding fields', () => {
    const input = configuration(); delete input.fileOperations;
    const validated = validateGenerationConfig({ ...input, endpoint: 'http://127.0.0.1:11434/' });
    expect(validated).toEqual(input); expect(validated).not.toHaveProperty('fileOperations');
    expect(newGenerationReceipt(validated)).toEqual({ schemaVersion: 1, provider: 'local-openai-compatible', endpoint: input.endpoint,
      model: input.model, status: 'failed', requestStarted: false, promptDigest: null, responseDigest: null, durationMs: 0,
      usage: { state: 'unavailable', inputTokens: null, outputTokens: null }, changedFiles: [] });
  });
  it('returns detached config scope with an explicit empty read-only list permitted', () => {
    const input = configuration(); input.fileOperations!.contextFiles = [];
    const validated = validateGenerationConfig(input); validated.files.push('other.ts');
    expect(input.files).toHaveLength(3); expect(validated.fileOperations).toEqual({ schemaVersion: 1, contextFiles: [] });
  });
  it.each([
    { schemaVersion: 2, contextFiles: [] }, { schemaVersion: 1 }, { schemaVersion: 1, contextFiles: [], extra: true },
    { schemaVersion: 1, contextFiles: ['main.ts'] }, { schemaVersion: 1, contextFiles: ['MAIN.ts'] },
    { schemaVersion: 1, contextFiles: ['main.ts/types.ts'] }, { schemaVersion: 1, contextFiles: ['types.ts', 'types.ts'] },
    { schemaVersion: 1, contextFiles: Array.from({ length: 17 }, (_, i) => `context-${i}.ts`) },
  ])('rejects invalid or overlapping explicit scope %j', (fileOperations) => {
    expect(() => validateGenerationConfig({ ...configuration(), fileOperations })).toThrow(/Invalid Universe/);
  });
  it.each(['A.ts', 'a.ts', 'a.ts/child.ts', 'caf\u0065\u0301.ts', 'file.', 'NUL.ts', '.Git/config', '../escape.ts'])('rejects ambiguous mutable path %s in the new mode', (path) => {
    expect(() => validateGenerationConfig({ ...configuration(), files: ['a.ts', path] })).toThrow(/Invalid Universe/);
  });
  it('does not impose new canonical alias rules on legacy configuration', () => {
    const input = configuration(); delete input.fileOperations; input.files = ['A.ts', 'a.ts', 'NUL.ts'];
    expect(validateGenerationConfig(input).files).toEqual(input.files);
  });
  it('accepts no-op success and validates present/absent operation receipts in response order', () => {
    const receipt: UniverseGenerationReceipt = { ...newGenerationReceipt(configuration()), status: 'succeeded', requestStarted: true,
      promptDigest: A, responseDigest: B, fileOperations: { schemaVersion: 1 as const, contextDigest: A, operations: [] } };
    expect(validGenerationReceipt(receipt)).toBe(true);
    receipt.fileOperations!.operations = [
      { op: 'create', path: 'helper.ts', beforeDigest: null, afterDigest: A },
      { op: 'delete', path: 'obsolete.ts', beforeDigest: B, afterDigest: null },
      { op: 'replace', path: 'main.ts', beforeDigest: A, afterDigest: B },
    ];
    receipt.changedFiles = ['helper.ts', 'obsolete.ts', 'main.ts']; expect(validGenerationReceipt(receipt)).toBe(true);
    receipt.changedFiles.reverse(); expect(validGenerationReceipt(receipt)).toBe(false);
  });
  it.each([
    { op: 'create', path: 'helper.ts', beforeDigest: A, afterDigest: B },
    { op: 'delete', path: 'helper.ts', beforeDigest: null, afterDigest: null },
    { op: 'replace', path: 'helper.ts', beforeDigest: A, afterDigest: A },
    { op: 'rename', path: 'helper.ts', beforeDigest: A, afterDigest: B },
    { op: 'create', path: 'helper.ts', beforeDigest: null, afterDigest: B, content: 'not persisted' },
  ])('rejects invalid operation evidence %j', (operation) => {
    const receipt = { ...newGenerationReceipt(configuration()), status: 'succeeded', requestStarted: true, promptDigest: A, responseDigest: B,
      changedFiles: ['helper.ts'], fileOperations: { schemaVersion: 1, contextDigest: A, operations: [operation] } };
    expect(validGenerationReceipt(receipt)).toBe(false);
  });
  it('pins prompt and file-state context together, while allowing no-contact timeout baselines', () => {
    const receipt = newGenerationReceipt(configuration()); receipt.status = 'timed-out'; expect(validGenerationReceipt(receipt)).toBe(true);
    receipt.promptDigest = A; expect(validGenerationReceipt(receipt)).toBe(false);
    receipt.fileOperations!.contextDigest = B; expect(validGenerationReceipt(receipt)).toBe(true);
    receipt.promptDigest = null; expect(validGenerationReceipt(receipt)).toBe(false);
  });
  it('reserves maximal operation receipt bytes before model contact', () => {
    const config = configuration(); config.files = Array.from({ length: 16 }, (_, index) => `${index}-${'a'.repeat(500)}`);
    const trial = { id: 'trial', variantId: 'candidate', niche: 'quality', parentTrialId: null, status: 'failed' as const,
      score: null, metrics: {}, artifact: null, durationMs: 0, delta: null, selected: false, generation: newGenerationReceipt(config) };
    expect(() => preflightTrialEvidenceBudget(trial, { artifact: { path: '/private/archive', digest: A, revision: 'a'.repeat(40) }, changedFiles: config.files })).toThrow(/before execution/);
  });
});

describe('immutable current and previous file-state context', () => {
  it('distinguishes absent helper, present mutable files, and present read-only context', () => {
    const data = fixture(); const context = build(data);
    expect(context.parent).toEqual({ runId: null, trialId: null, generation: 0, artifactDigest: data.seed.digest });
    expect(context.files).toEqual([{ path: 'main.ts', contentDigest: digest('export const value = 0;') },
      { path: 'helper.ts', contentDigest: null }, { path: 'obsolete.ts', contentDigest: digest('old implementation') }]);
    expect(context.contextFiles).toEqual([{ path: 'types.ts', contentDigest: digest('export type Value = number;'), content: 'export type Value = number;' }]);
    expect(context.previous).toBeNull(); expect(fileOperationsContextDigest(context)).toBe(digest(canonical(context)));
    expect(JSON.stringify(context)).not.toContain(data.directory);
  });
  it('keeps rejected new-file content separate from the retained absent parent', () => {
    const data = fixture(); previous(data);
    const context = build(data, true); const feedback = buildUniverseFeedback(data.summary, data.summary.manifest.variants[0], data.directory)!;
    expect(context.files[1].contentDigest).toBeNull(); expect(context.previous!.files[1].contentDigest).toBe(digest('export const helper = 1;'));
    expect(context.previous!.files[2].contentDigest).toBeNull();
    expect(feedback.previousAttemptFiles.map((file) => file.path)).toEqual(['main.ts', 'helper.ts']);
    expect(feedback.previousAttemptFiles[1].content).toBe('export const helper = 1;');
    expect(build(data).previous).toBeNull();
  });
  it('reads an admitted newly created file as present in the next retained parent', () => {
    const data = fixture(); previous(data, true); const context = build(data, true);
    expect(context.parent).toMatchObject({ runId: 'run-1', trialId: 'trial-1', generation: 1 });
    expect(context.files[1].contentDigest).toBe(digest('export const helper = 1;')); expect(context.files[2].contentDigest).toBeNull();
  });
  it('represents a previous no-artifact attempt as unknown, not all files absent', () => {
    const data = fixture(); const run = previous(data); run.trials[0].artifact = null;
    expect(build(data, true).previous).toMatchObject({ artifactDigest: null, files: [] });
  });
  it('keeps missing paths invalid for legacy feedback', () => {
    const data = fixture(); previous(data); delete data.summary.manifest.variants[0].generation!.fileOperations;
    expect(() => buildUniverseFeedback(data.summary, data.summary.manifest.variants[0], data.directory)).toThrow();
  });
  it.each(['missing', 'directory', 'invalid-utf8', 'nul', 'oversize'] as const)('fails closed on %s read-only context', (kind) => {
    const data = fixture(); const target = join(data.seed.path, 'types.ts');
    if (kind === 'missing' || kind === 'directory') unlinkSync(target);
    if (kind === 'directory') mkdirSync(target);
    if (kind === 'invalid-utf8') writeFileSync(target, Buffer.from([0xc3, 0x28]));
    if (kind === 'nul') writeFileSync(target, '\0');
    if (kind === 'oversize') writeFileSync(target, 'a'.repeat(65537));
    data.seed.digest = artifactDigest(data.seed.path);
    expect(() => build(data)).toThrow(/file operations/);
  });
  it('returns detached context and rejects reordered, forged or widened file states', () => {
    const data = fixture(); const context = build(data); const validated = validateUniverseFileOperationsContext(context, configuration());
    validated.files[0].contentDigest = B; expect(context.files[0].contentDigest).not.toBe(B);
    expect(() => validateUniverseFileOperationsContext({ ...context, files: [...context.files].reverse() }, configuration())).toThrow(/file-state/);
    expect(() => validateUniverseFileOperationsContext({ ...context, contextFiles: [{ ...context.contextFiles[0], content: 'forged' }] }, configuration())).toThrow(/read-only/);
    expect(() => validateUniverseFileOperationsContext({ ...context, secret: 'not a protocol field' }, configuration())).toThrow(/identity/);
  });
  it('rejects source drift rather than relabeling it absent', () => {
    const data = fixture(); unlinkSync(join(data.seed.path, 'main.ts'));
    expect(() => build(data)).toThrow(/artifact bytes changed/);
  });
});
