/** Pure candidate-artifact controls. No patch application or subprocess launch. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { parseGitBlobBatch } from '../src/core/universe/git-blob-batch.js';

const MiB = 1024 * 1024;
const artifactLimit = 64 * MiB;
const outputLimit = 68 * MiB;
const patch = readFileSync(new URL('../artifacts/hub-verification-batch-candidate.patch', import.meta.url), 'utf8');
const additions = patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n');
const parsed = ts.createSourceFile('candidate-additions.ts', additions, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const functions = parsed.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'evaluatorBlobs');
if (functions.length !== 1) throw new Error('Expected exactly one artifact evaluatorBlobs function');
const helperSource = functions[0]!.getText(parsed);
const javascript = ts.transpileModule(helperSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

type BatchResult = { status: unknown; signal: unknown; stdout: unknown; stderr: unknown; error?: unknown; pid?: number };
const normal = (stdout = Buffer.alloc(0)): BatchResult => ({ status: 0, signal: null, stdout, stderr: Buffer.alloc(0), pid: 0 });
const fallbackBytes = Buffer.from('original');
function fixture(result: BatchResult = normal(), parser: typeof parseGitBlobBatch = parseGitBlobBatch) {
  const spawn = vi.fn((_file: string, _args: string[], _options: Record<string, unknown>) => result);
  const git = vi.fn((_repo: string, _args: string[]) => fallbackBytes);
  const parse = vi.fn(parser);
  const read = runInNewContext(`${javascript}\nevaluatorBlobs`, {
    Buffer, MAX_ARTIFACT_BYTES: artifactLimit, spawnSync: spawn, git, parseGitBlobBatch: parse,
    process: Object.freeze({ env: Object.freeze({ PATH: '/fixed-path' }) }),
    fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }); },
  }, { timeout: 1000 }) as (repo: string, oids: string[]) => Buffer[];
  return { read, spawn, git, parse };
}
function blob(text: string, algorithm: 'sha1' | 'sha256' = 'sha1') {
  const bytes = Buffer.from(text);
  const oid = createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  return { oid, bytes, frame: Buffer.concat([Buffer.from(`${oid} blob ${bytes.length}\n`), bytes, Buffer.from('\n')]) };
}
const first = blob('first'), second = blob('second');
const oids = [first.oid, second.oid];

describe('unapplied preparation batch candidate', () => {
  it.each(['sha1', 'sha256'] as const)('parses a quiet %s batch in requested order with duplicate OIDs', algorithm => {
    const item = blob('shared content', algorithm);
    const f = fixture(normal(Buffer.concat([item.frame, item.frame])));
    expect(f.read('/fixture', [item.oid, item.oid])).toEqual([item.bytes, item.bytes]);
    expect(f.spawn).toHaveBeenCalledExactlyOnceWith('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', '/fixture', 'cat-file', '--batch'], {
      env: { PATH: '/fixed-path', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' },
      timeout: 30000, maxBuffer: outputLimit, input: `${item.oid}\n${item.oid}\n`, stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(f.parse).toHaveBeenCalledWith(expect.any(Buffer), [item.oid, item.oid], artifactLimit);
    expect(f.git).not.toHaveBeenCalled();
  });

  it('keeps one protected path on its original command without batch or parser work', () => {
    const f = fixture();
    expect(f.read('/fixture', [first.oid])).toEqual([fallbackBytes]);
    expect(f.git).toHaveBeenCalledExactlyOnceWith('/fixture', ['cat-file', 'blob', first.oid]);
    expect(f.spawn).not.toHaveBeenCalled(); expect(f.parse).not.toHaveBeenCalled();
  });

  it.each([
    { status: 0, stderr: Buffer.from('small warning') },
    { status: 1, stderr: Buffer.alloc(0) },
    { status: 1, stderr: Buffer.from('command failed') },
  ])('restarts the entire original list on normally exited warnings/failure: %j', flags => {
    // Deliberately unusable payload: warning results are discarded, never parsed.
    const f = fixture({ ...normal(Buffer.from('not a frame')), ...flags });
    expect(f.read('/fixture', [first.oid, second.oid, first.oid])).toEqual([fallbackBytes, fallbackBytes, fallbackBytes]);
    expect(f.git.mock.calls).toEqual([
      ['/fixture', ['cat-file', 'blob', first.oid]], ['/fixture', ['cat-file', 'blob', second.oid]],
      ['/fixture', ['cat-file', 'blob', first.oid]],
    ]);
    expect(f.spawn).toHaveBeenCalledTimes(1); expect(f.parse).not.toHaveBeenCalled();
    expect(f.spawn.mock.invocationCallOrder[0]).toBeLessThan(f.git.mock.invocationCallOrder[0]!);
  });

  it('propagates an original combined-limit error after fallback without accepting a batch prefix', () => {
    const failure = Object.assign(new Error('original combined output exceeded'), { code: 'ENOBUFS' });
    const f = fixture({ ...normal(Buffer.concat([first.frame, second.frame])), stderr: Buffer.from('warning') });
    f.git.mockReturnValueOnce(first.bytes).mockImplementationOnce(() => { throw failure; });
    expect(() => f.read('/fixture', [...oids, first.oid])).toThrow(failure);
    expect(f.git.mock.calls).toEqual([
      ['/fixture', ['cat-file', 'blob', first.oid]], ['/fixture', ['cat-file', 'blob', second.oid]],
    ]);
    expect(f.spawn).toHaveBeenCalledTimes(1); expect(f.parse).not.toHaveBeenCalled();
  });

  it.each([
    { error: new Error('transport failed') }, { error: { code: 'ETIMEDOUT' } }, { error: { code: 'ENOBUFS' } },
    { error: null }, { signal: 'SIGTERM' }, { signal: undefined }, { status: null }, { status: -1 },
    { status: 0.5 }, { status: Number.NaN }, { status: Number.MAX_SAFE_INTEGER + 1 }, { status: '0' },
    { stdout: null }, { stdout: 'text' }, { stderr: null }, { stderr: 'warning' },
  ])('refuses unsafe result without fallback: %j', flags => {
    const f = fixture({ ...normal(), ...flags });
    expect(() => f.read('/fixture', oids)).toThrow('Preparation evaluator batch is unavailable');
    expect(f.spawn).toHaveBeenCalledTimes(1); expect(f.git).not.toHaveBeenCalled(); expect(f.parse).not.toHaveBeenCalled();
  });

  it('propagates a thrown broker refusal without retry', () => {
    const f = fixture(), failure = new Error('broker refused');
    f.spawn.mockImplementation(() => { throw failure; });
    expect(() => f.read('/fixture', oids)).toThrow(failure);
    expect(f.git).not.toHaveBeenCalled(); expect(f.parse).not.toHaveBeenCalled();
  });

  it.each([
    ['missing frame', Buffer.from(`${first.oid} missing\n`)],
    ['reordered frames', Buffer.concat([second.frame, first.frame])],
    ['trailing bytes', Buffer.concat([first.frame, second.frame, Buffer.from('x')])],
    ['missing terminator', Buffer.concat([first.frame, second.frame.subarray(0, -1)])],
    ['wrong content hash', Buffer.concat([Buffer.from(`${first.oid} blob 5\nwrong\n`), second.frame])],
    ['aggregate payload beyond cap', Buffer.from(`${first.oid} blob ${artifactLimit + 1}\n`)],
  ] as const)('refuses clean malformed batch (%s) without fallback', (_name, bytes) => {
    const f = fixture(normal(bytes));
    expect(() => f.read('/fixture', oids)).toThrow();
    expect(f.parse).toHaveBeenCalledTimes(1); expect(f.git).not.toHaveBeenCalled();
  });

  it('counts both output streams against the batch envelope before warning fallback', () => {
    const f = fixture({ ...normal(Buffer.alloc(outputLimit)), stderr: Buffer.from('x') });
    expect(() => f.read('/fixture', oids)).toThrow('Preparation evaluator batch is unavailable');
    expect(f.parse).not.toHaveBeenCalled(); expect(f.git).not.toHaveBeenCalled();
  });

  it.each([8 * MiB, 8 * MiB + 1])('enforces the exact per-blob payload boundary: %i', size => {
    // Isolate this helper guard from the separately tested real framing parser.
    const bytes = Buffer.alloc(size);
    const f = fixture(normal(), () => [bytes, Buffer.alloc(0)]);
    if (size === 8 * MiB) {
      const returned = f.read('/fixture', oids);
      expect(returned).toHaveLength(2); expect(returned[0]).toBe(bytes); expect(returned[1]).toHaveLength(0);
    } else expect(() => f.read('/fixture', oids)).toThrow('Preparation evaluator file exceeds byte bound');
    expect(f.parse).toHaveBeenCalledWith(expect.any(Buffer), oids, artifactLimit);
    expect(f.git).not.toHaveBeenCalled();
  });
});
