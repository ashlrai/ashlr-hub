import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { artifactDigest, digest } from '../src/core/universe/artifacts.js';
import { applyFileOperations, parseFileOperations, preflightFileOperations, readFileOperationsSnapshot } from '../src/core/universe/file-operations.js';
import { generateModelCandidate, type ModelCandidateContext } from '../src/core/universe/model-candidate.js';
import { validGenerationReceipt } from '../src/core/universe/generation.js';
import type { UniverseGenerationConfig } from '../src/core/universe/types.js';
import * as verifyCommands from '../src/core/run/verify-commands.js';
import * as fileOperations from '../src/core/universe/file-operations.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(mutable: Record<string, string | null> = { 'main.ts': 'old', 'new/module.ts': null, 'obsolete.ts': 'remove' },
  readonly: Record<string, string> = { 'types.ts': 'export type Value = string;' }): {
  directory: string; root: string; config: UniverseGenerationConfig; context: ModelCandidateContext;
} {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'universe-file-operations-test-'))); roots.push(directory);
  const root = join(directory, 'candidate'); mkdirSync(root, { mode: 0o700 });
  for (const [path, content] of Object.entries({ ...mutable, ...readonly })) {
    if (content === null) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content);
  }
  const config: UniverseGenerationConfig = { kind: 'local-chat', endpoint: 'http://127.0.0.1:11434/v1', model: 'fixture',
    files: Object.keys(mutable), maxOutputTokens: 256, fileOperations: { schemaVersion: 1, contextFiles: Object.keys(readonly) } };
  const context: ModelCandidateContext = { candidatePath: root, objective: 'Useful behavior', hypothesis: 'Extract one module',
    variantId: 'refactor', generation: 1, parentTrialId: null, timeoutMs: 5_000, signal: new AbortController().signal,
    fileOperationsContext: { schemaVersion: 1, universeId: 'fixture', manifestDigest: 'a'.repeat(64), comparatorDigest: 'b'.repeat(64),
      variantId: 'refactor', generation: 1, parent: { runId: null, trialId: null, generation: 0, artifactDigest: artifactDigest(root) },
      files: Object.entries(mutable).map(([path, content]) => ({ path, contentDigest: content === null ? null : digest(content) })),
      contextFiles: Object.entries(readonly).map(([path, content]) => ({ path, contentDigest: digest(content), content })), previous: null } };
  return { directory, root, config, context };
}
const options = (): { timeoutMs: number; signal: AbortSignal } => ({ timeoutMs: 5_000, signal: new AbortController().signal });
function modelResponse(value: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 17, completion_tokens: 11 } }));
}

describe.skipIf(process.platform !== 'darwin')('declared file operations', () => {
  it('confined preflight is nonmutating; complete batch creates nested modules, replaces and deletes', async () => {
    const { root, config } = fixture(); chmodSync(join(root, 'main.ts'), 0o755);
    const snapshot = readFileOperationsSnapshot(root, config);
    await preflightFileOperations(snapshot, options());
    expect(artifactDigest(root)).toBe(snapshot.artifactDigest);
    const operations = parseFileOperations(JSON.stringify({ operations: [
      { op: 'create', path: 'new/module.ts', content: 'export const result = 42;' },
      { op: 'replace', path: 'main.ts', content: 'export { result } from "./new/module.js";' },
      { op: 'delete', path: 'obsolete.ts' },
    ] }), snapshot);
    const result = await applyFileOperations(snapshot, operations, options());
    expect(result.map((entry) => entry.op)).toEqual(['create', 'replace', 'delete']);
    expect(result[0]).toMatchObject({ beforeDigest: null, afterDigest: digest('export const result = 42;') });
    expect(result[2]).toMatchObject({ beforeDigest: digest('remove'), afterDigest: null });
    expect(lstatSync(join(root, 'main.ts')).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(root, 'new/module.ts')).mode & 0o111).toBe(0);
    expect(existsSync(join(root, 'obsolete.ts'))).toBe(false);
    expect(readFileSync(join(root, 'types.ts'), 'utf8')).toBe('export type Value = string;');
  });

  it.each([{ operations: [] }, { operations: [{ op: 'replace', path: 'main.ts', content: 'old' }] }])('accepts unchanged operations $operations without fabricated changes', async ({ operations }) => {
    const { root, config } = fixture(); const before = artifactDigest(root);
    const snapshot = readFileOperationsSnapshot(root, config);
    expect(await applyFileOperations(snapshot, operations as Parameters<typeof applyFileOperations>[1], options())).toEqual([]);
    expect(artifactDigest(root)).toBe(before);
    expect(existsSync(join(root, 'new'))).toBe(false);
  });

  it('distinguishes absent files from empty and preserves BOM text', async () => {
    const { root, config } = fixture({ 'empty.ts': '', 'new.ts': null }, {});
    const snapshot = readFileOperationsSnapshot(root, config);
    expect(snapshot.files.map(({ content }) => content)).toEqual(['', null]);
    await applyFileOperations(snapshot, [{ op: 'delete', path: 'empty.ts' }, { op: 'create', path: 'new.ts', content: '\uFEFFhello' }], options());
    expect(readFileSync(join(root, 'new.ts'), 'utf8')).toBe('\uFEFFhello');
  });

  it.each([
    '{', 'null', '[]', '{"edits":[]}', '{"operations":[],"extra":true}',
    '{"operations":[{"op":"rename","path":"main.ts","content":"x"}]}',
    '{"operations":[{"op":"delete","path":"main.ts","content":"x"}]}',
    '{"operations":[{"op":"replace","path":"main.ts"}]}',
    '{"operations":[{"op":"create","path":"main.ts","content":"x"}]}',
    '{"operations":[{"op":"delete","path":"new/module.ts"}]}',
    '{"operations":[{"op":"replace","path":"new/module.ts","content":"x"}]}',
    '{"operations":[{"op":"replace","path":"types.ts","content":"x"}]}',
    '{"operations":[{"op":"create","path":"../escape","content":"x"}]}',
    '{"operations":[{"op":"delete","path":"main.ts"},{"op":"replace","path":"main.ts","content":"x"}]}',
    '{"operations":[{"op":"replace","path":"main.ts","content":"\\u0000"}]}',
    '{"operations":[{"op":"replace","path":"main.ts","content":"\\ud800"}]}',
  ])('rejects malformed or out-of-scope response before filesystem writes: %s', (response) => {
    const { root, config } = fixture(); const before = artifactDigest(root);
    expect(() => parseFileOperations(response, readFileOperationsSnapshot(root, config))).toThrow('Model file operations:');
    expect(artifactDigest(root)).toBe(before); expect(existsSync(join(root, 'new'))).toBe(false);
  });

  it('validates every operation before creating any requested directory', async () => {
    const { root, config } = fixture(); const snapshot = readFileOperationsSnapshot(root, config);
    await expect(applyFileOperations(snapshot, [
      { op: 'create', path: 'new/module.ts', content: 'new' }, { op: 'delete', path: 'missing.ts' },
    ], options())).rejects.toThrow('unique declared mutable path');
    expect(existsSync(join(root, 'new'))).toBe(false);
  });

  it.each(['mutable', 'readonly', 'undeclared', 'appeared'])('rejects %s drift before the first operation', async (kind) => {
    const { root, config } = fixture(); const snapshot = readFileOperationsSnapshot(root, config);
    if (kind === 'appeared') { mkdirSync(join(root, 'new')); writeFileSync(join(root, 'new/module.ts'), 'racing'); }
    else writeFileSync(join(root, kind === 'mutable' ? 'main.ts' : kind === 'readonly' ? 'types.ts' : 'unrelated.ts'), 'drift');
    await expect(applyFileOperations(snapshot, [{ op: 'delete', path: 'obsolete.ts' }], options())).rejects.toThrow('artifact changed');
    expect(readFileSync(join(root, 'obsolete.ts'), 'utf8')).toBe('remove');
  });

  it('rejects a replaced ancestor and never writes through its outside symlink', async () => {
    const { directory, root, config } = fixture({ 'inside/old.ts': 'old', 'inside/new.ts': null }, {});
    const snapshot = readFileOperationsSnapshot(root, config);
    const outside = join(directory, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'old.ts'), 'outside');
    renameSync(join(root, 'inside'), join(root, 'original')); symlinkSync(outside, join(root, 'inside'));
    await expect(applyFileOperations(snapshot, [{ op: 'create', path: 'inside/new.ts', content: 'unexpected' }], options())).rejects.toThrow();
    expect(existsSync(join(outside, 'new.ts'))).toBe(false);
    expect(readFileSync(join(outside, 'old.ts'), 'utf8')).toBe('outside');
  });

  it('the exact worker confinement denies outside and symlink-redirected writes at the OS boundary', async () => {
    const { directory, root, config } = fixture();
    const original = verifyCommands.runVerifySubprocessAsync;
    let invocation: string[] | undefined;
    vi.spyOn(verifyCommands, 'runVerifySubprocessAsync').mockImplementation(async (argv, opts) => {
      invocation = argv;
      expect(opts.env).toEqual({ PATH: '/usr/bin:/bin', TMPDIR: expect.any(String), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NO_COLOR: '1' });
      return original(argv, opts);
    });
    await preflightFileOperations(readFileOperationsSnapshot(root, config), options());
    expect(invocation?.[2]).toContain('(deny network*)');
    const outside = join(directory, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'sentinel'), 'unchanged');
    // Introduce the redirect after the worker profile has already been built.
    symlinkSync(outside, join(root, 'redirect'));
    const program = `const fs=require('node:fs');const path=require('node:path');let denied=0;const outside=process.argv[1];const root=process.argv[2];
      for(const action of [()=>fs.writeFileSync(path.join(outside,'new'),'bad'),()=>fs.writeFileSync(path.join(root,'redirect/sentinel'),'bad'),
        ()=>fs.unlinkSync(path.join(root,'redirect/sentinel')),()=>fs.mkdirSync(path.join(root,'redirect/new-directory'))]) {
        try { action(); } catch(error) { if(error.code==='EPERM'||error.code==='EACCES') denied++; else throw error; }
      } process.stdout.write(String(denied));`;
    const result = await original([...invocation!.slice(0, 4), '-e', program, outside, root], {
      cwd: root, env: { PATH: '/usr/bin:/bin' }, ...options(),
    });
    expect(result.exitCode).toBe(0); expect(result.stdout).toBe('4');
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('unchanged');
    expect(existsSync(join(outside, 'new'))).toBe(false); expect(existsSync(join(outside, 'new-directory'))).toBe(false);
  });

  it('enforces combined current/context and complete output text bounds without truncation', () => {
    const oversized = fixture({ 'a.ts': 'a'.repeat(65_536), 'b.ts': 'b'.repeat(65_536) }, { 'types.ts': 'x' });
    expect(() => readFileOperationsSnapshot(oversized.root, oversized.config)).toThrow('context byte limit');
    const { root, config } = fixture({ 'a.ts': '', 'b.ts': '', 'c.ts': null }, {});
    const snapshot = readFileOperationsSnapshot(root, config);
    expect(() => parseFileOperations(JSON.stringify({ operations: [
      { op: 'replace', path: 'a.ts', content: 'a'.repeat(65_536) },
      { op: 'replace', path: 'b.ts', content: 'b'.repeat(65_536) },
      { op: 'create', path: 'c.ts', content: 'x' },
    ] }), snapshot)).toThrow('text exceeds the byte limit');
  });

  it.each(['symlink', 'hardlink', 'directory', 'invalid-text', 'oversized', 'missing-context'])('rejects unsafe %s inputs before model contact', async (kind) => {
    const { root, config, context } = fixture();
    if (kind === 'missing-context') rmSync(join(root, 'types.ts'));
    else {
      rmSync(join(root, 'main.ts'));
      if (kind === 'symlink') symlinkSync(join(root, 'types.ts'), join(root, 'main.ts'));
      if (kind === 'hardlink') linkSync(join(root, 'types.ts'), join(root, 'main.ts'));
      if (kind === 'directory') mkdirSync(join(root, 'main.ts'));
      if (kind === 'invalid-text') writeFileSync(join(root, 'main.ts'), Buffer.from([0xff]));
      if (kind === 'oversized') writeFileSync(join(root, 'main.ts'), 'a'.repeat(65_537));
    }
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const receipt = await generateModelCandidate(config, context);
    expect(receipt.status).toBe('failed'); expect(receipt.requestStarted).toBe(false); expect(fetch).not.toHaveBeenCalled();
    expect(validGenerationReceipt(receipt)).toBe(true);
  });

  it('supplies explicit mutable absence and read-only context; counts transport usage on success', async () => {
    const { root, config, context } = fixture(); let prompt: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { messages: Array<{ content: string }>; tools?: unknown };
      prompt = JSON.parse(request.messages[1]!.content) as Record<string, unknown>;
      expect(request.tools).toBeUndefined();
      return modelResponse({ operations: [{ op: 'create', path: 'new/module.ts', content: 'new' }] });
    }));
    const receipt = await generateModelCandidate(config, context);
    expect(receipt.error).toBeUndefined(); expect(receipt.status).toBe('succeeded');
    expect(prompt?.files).toEqual([{ path: 'main.ts', content: 'old' }, { path: 'new/module.ts', content: null }, { path: 'obsolete.ts', content: 'remove' }]);
    expect(prompt?.fileOperationsContext).toEqual(context.fileOperationsContext);
    expect(receipt.changedFiles).toEqual(['new/module.ts']); expect(receipt.fileOperations?.operations[0]?.op).toBe('create');
    expect(receipt.usage).toEqual({ state: 'reported', inputTokens: 17, outputTokens: 11 });
    expect(readFileSync(join(root, 'new/module.ts'), 'utf8')).toBe('new'); expect(validGenerationReceipt(receipt)).toBe(true);
  });

  it.each(['invalid-operation', 'stale-context', 'too-large'])('retains actual model usage when output is rejected: %s', async (kind) => {
    const { root, config, context } = fixture();
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (kind === 'stale-context') writeFileSync(join(root, 'types.ts'), 'changed');
      return modelResponse({ operations: [{ op: 'replace', path: kind === 'invalid-operation' ? 'types.ts' : 'main.ts',
        content: kind === 'too-large' ? 'a'.repeat(65_537) : 'new' }] });
    }));
    const receipt = await generateModelCandidate(config, context);
    expect(receipt.status).toBe('failed'); expect(receipt.requestStarted).toBe(true);
    expect(receipt.usage).toEqual({ state: 'reported', inputTokens: 17, outputTokens: 11 });
    expect(receipt.changedFiles).toEqual([]); expect(receipt.fileOperations?.operations).toEqual([]);
    expect(readFileSync(join(root, 'main.ts'), 'utf8')).toBe('old'); expect(validGenerationReceipt(receipt)).toBe(true);
  });

  it.each(['identity', 'parent', 'bytes', 'context-bytes', 'missing'])('rejects contradictory %s context without a request', async (kind) => {
    const { config, context } = fixture();
    if (kind === 'identity') context.variantId = 'other';
    if (kind === 'parent') context.fileOperationsContext!.parent.artifactDigest = 'c'.repeat(64);
    if (kind === 'bytes') context.fileOperationsContext!.files[0]!.contentDigest = 'c'.repeat(64);
    if (kind === 'context-bytes') { context.fileOperationsContext!.contextFiles[0]!.content = 'other'; context.fileOperationsContext!.contextFiles[0]!.contentDigest = digest('other'); }
    if (kind === 'missing') delete context.fileOperationsContext;
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const receipt = await generateModelCandidate(config, context);
    expect(receipt.status).toBe('failed'); expect(fetch).not.toHaveBeenCalled(); expect(validGenerationReceipt(receipt)).toBe(true);
  });

  it('classifies a spent shared budget before model contact as timed-out', async () => {
    const { config, context } = fixture(); context.timeoutMs = 1;
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const receipt = await generateModelCandidate(config, context);
    expect(receipt.status).toBe('timed-out'); expect(fetch).not.toHaveBeenCalled();
    expect(receipt.requestStarted).toBe(false); expect(receipt.fileOperations?.operations).toEqual([]);
  });

  it('rechecks the deadline after synchronous post-worker verification before claiming success', async () => {
    const { config, context } = fixture();
    const actualNow = performance.now.bind(performance); let verificationOverran = false;
    vi.spyOn(performance, 'now').mockImplementation(() => actualNow() + (verificationOverran ? 10_000 : 0));
    vi.stubGlobal('fetch', vi.fn(async () => modelResponse({ operations: [{ op: 'replace', path: 'main.ts', content: 'new' }] })));
    vi.spyOn(fileOperations, 'applyFileOperations').mockImplementation(async () => {
      // A synchronous hash can exhaust the budget before the timeout callback runs.
      verificationOverran = true;
      return [{ op: 'replace', path: 'main.ts', beforeDigest: digest('old'), afterDigest: digest('new') }];
    });
    const receipt = await generateModelCandidate(config, context);
    expect(receipt.status).toBe('timed-out'); expect(receipt.requestStarted).toBe(true);
    expect(receipt.usage).toEqual({ state: 'reported', inputTokens: 17, outputTokens: 11 });
    expect(receipt.changedFiles).toEqual([]); expect(receipt.fileOperations?.operations).toEqual([]);
    expect(validGenerationReceipt(receipt)).toBe(true);
  });
});
