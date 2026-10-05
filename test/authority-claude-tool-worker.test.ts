import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_TOOL_FILE_MAX_BYTES, executeClaudeToolRequest } from '../src/core/sandbox/claude-broker-tool-worker.js';
import { CLAUDE_TOOL_WORKER_FLAG, embeddedClaudeToolWorkerDigest, observeClaudeToolWorkerFile, resolveClaudeBrokerToolInvocation } from '../src/core/sandbox/claude-broker-tool-invocation.js';
import { canSymlink, withPlatform } from './helpers/platform.js';

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-tool-worker-'))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const request = (root: string, name: 'read_file' | 'write_file', path: string, text?: string) =>
  ({ schemaVersion: 1, root, call: { name, path, ...(text === undefined ? {} : { text }) } });

describe('isolated source-owned tool filesystem', () => {
  it('writes atomically and reads the real Unicode worktree content', () => {
    mkdirSync(join(root, 'src'));
    expect(executeClaudeToolRequest(request(root, 'write_file', 'src/a.txt', 'hello π\n'))).toBe('Written');
    expect(readFileSync(join(root, 'src/a.txt'), 'utf8')).toBe('hello π\n');
    expect(executeClaudeToolRequest(request(root, 'read_file', 'src/a.txt'))).toBe('hello π\n');
    expect(executeClaudeToolRequest(request(root, 'write_file', 'src/a.txt', 'replaced'))).toBe('Written');
    expect(executeClaudeToolRequest(request(root, 'read_file', 'src/a.txt'))).toBe('replaced');
  });
  it.each(['../outside', '/absolute', 'C:/absolute', 'a\\b', '.git/config', '.GIT/config', '.git. /config', 'a:stream', 'src/../../outside', ''])('refuses path %j', path => {
    expect(() => executeClaudeToolRequest(request(root, 'write_file', path, 'no'))).toThrow();
  });
  it.skipIf(!canSymlink())('refuses symlink directory and leaf escapes without altering outside bytes', () => {
    mkdirSync(join(root, 'outside')); writeFileSync(join(root, 'outside', 'secret'), 'untouched');
    symlinkSync(join(root, 'outside'), join(root, 'alias'), 'dir');
    symlinkSync(join(root, 'outside', 'secret'), join(root, 'leaf'));
    for (const path of ['alias/secret', 'leaf']) {
      expect(() => executeClaudeToolRequest(request(root, 'read_file', path))).toThrow();
      expect(() => executeClaudeToolRequest(request(root, 'write_file', path, 'changed'))).toThrow();
    }
    expect(readFileSync(join(root, 'outside', 'secret'), 'utf8')).toBe('untouched');
  });
  it('refuses hardlinks and oversized reads and writes', () => {
    writeFileSync(join(root, 'a'), 'same'); linkSync(join(root, 'a'), join(root, 'b'));
    for (const name of ['read_file', 'write_file'] as const) expect(() => executeClaudeToolRequest(request(root, name, 'b', name === 'write_file' ? 'changed' : undefined))).toThrow();
    writeFileSync(join(root, 'large'), Buffer.alloc(CLAUDE_TOOL_FILE_MAX_BYTES + 1));
    expect(() => executeClaudeToolRequest(request(root, 'read_file', 'large'))).toThrow();
    expect(() => executeClaudeToolRequest(request(root, 'write_file', 'new', 'x'.repeat(CLAUDE_TOOL_FILE_MAX_BYTES + 1)))).toThrow();
    expect(() => executeClaudeToolRequest(request(root, 'write_file', 'new', 'π'.repeat(CLAUDE_TOOL_FILE_MAX_BYTES)))).toThrow();
    writeFileSync(join(root, 'invalid-utf8'), Buffer.from([0xff]));
    expect(() => executeClaudeToolRequest(request(root, 'read_file', 'invalid-utf8'))).toThrow();
  });
  it('refuses unknown fields, versions, tools and noncanonical roots', () => {
    for (const value of [{ ...request(root, 'read_file', 'a'), extra: true },
      { ...request(root, 'read_file', 'a'), schemaVersion: 2 }, { schemaVersion: 1, root, call: { name: 'bash', path: 'a' } },
      { schemaVersion: 1, root: root + '/.', call: { name: 'read_file', path: 'a' } },
      { schemaVersion: 1, root, call: { name: 'read_file', path: 'a', text: 'ignored' } }]) expect(() => executeClaudeToolRequest(value)).toThrow();
  });
});

describe('worker source and native embedding binding', () => {
  it.skipIf(process.platform === 'win32')('seals a real bounded source and refuses edits, replacement and hardlinks', () => {
    const path = join(root, 'worker.js'); writeFileSync(path, 'export const source = 1;');
    const proof = observeClaudeToolWorkerFile(path);
    expect(proof.isCurrent()).toBe(true);
    writeFileSync(path, 'export const source = 2;'); expect(proof.isCurrent()).toBe(false);
    const changed = observeClaudeToolWorkerFile(path);
    renameSync(path, join(root, 'old')); writeFileSync(path, 'export const source = 2;'); expect(changed.isCurrent()).toBe(false);
    linkSync(path, join(root, 'linked')); expect(() => observeClaudeToolWorkerFile(path)).toThrow();
  });
  it.skipIf(process.platform === 'win32' || !canSymlink())('refuses a symlink instead of a canonical worker source', () => {
    const path = join(root, 'worker'); writeFileSync(path, 'source'); symlinkSync(path, join(root, 'alias'));
    expect(() => observeClaudeToolWorkerFile(join(root, 'alias'))).toThrow();
  });
  it.skipIf(process.platform === 'win32')('refuses group-writable worker source', () => {
    const path = join(root, 'worker'); writeFileSync(path, 'source'); chmodSync(path, 0o666);
    expect(() => observeClaudeToolWorkerFile(path)).toThrow();
  });
  it.skipIf(process.platform === 'win32')('refuses oversized worker source', () => {
    const path = join(root, 'worker');
    writeFileSync(path, Buffer.alloc(128 * 1024 + 1)); expect(() => observeClaudeToolWorkerFile(path)).toThrow();
  });
  it('refuses unsupported Windows integrity before selecting any executable or source', () => {
    withPlatform('win32', () => {
      expect(() => resolveClaudeBrokerToolInvocation()).toThrow('unsupported');
      expect(() => observeClaudeToolWorkerFile(join(root, 'unread'))).toThrow('unsupported');
    });
  });
  it('binds exact embedded worker text/hash to the same qualified artifact identity', () => {
    const identity = JSON.stringify({ schemaVersion: 1, packageVersion: '3.24.1', revision: 'a'.repeat(40), dirty: false, provenance: 'git' });
    const text = 'export const worker = true;'; const sha256 = createHash('sha256').update(text).digest('hex');
    const raw = JSON.stringify({ schemaVersion: 1, buildIdentityJson: identity, text, sha256 });
    expect(embeddedClaudeToolWorkerDigest(raw, identity)).toBe(sha256);
    for (const value of [raw.replace('worker = true', 'worker = false'), raw.replace('"schemaVersion":1', '"schemaVersion":2'),
      JSON.stringify({ schemaVersion: 1, buildIdentityJson: identity, text, sha256, trust: true })]) {
      expect(() => embeddedClaudeToolWorkerDigest(value, identity)).toThrow();
    }
    expect(() => embeddedClaudeToolWorkerDigest(raw, identity.replace('a'.repeat(40), 'b'.repeat(40)))).toThrow();
    expect(() => embeddedClaudeToolWorkerDigest(raw, null)).toThrow();
  });
});

describe.skipIf(process.platform === 'win32')('real fixed worker process (POSIX source integrity)', () => {
  async function run(input: string | Buffer, extra: string[] = []): Promise<{ code: number | null; out: string; err: string }> {
    const invocation = resolveClaudeBrokerToolInvocation();
    expect(invocation.isCurrent()).toBe(true);
    expect(invocation.workerDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(CLAUDE_TOOL_WORKER_FLAG).toMatch(/^--_[a-z-]+$/);
    return await new Promise((resolve, reject) => {
      const child = spawn(invocation.bin, [...invocation.args, ...extra], { env: { HOME: root, PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = ''; let err = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('tool fixture timed out')); }, 5_000);
      child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
      child.stdin.on('error', () => { /* A refused worker may close before its oversized stdin drains. */ });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
      child.stdin.end(input);
    });
  }
  it('uses bounded stdin, not a path operand, for real read/write success', async () => {
    expect(await run(JSON.stringify(request(root, 'write_file', 'created', 'actual child bytes')))).toMatchObject({ code: 0, out: 'Written' });
    expect(await run(JSON.stringify(request(root, 'read_file', 'created')))).toMatchObject({ code: 0, out: 'actual child bytes' });
  });
  it.each(['not JSON', '{"secret":"never-print"}', 'x'.repeat(128 * 1024 + 1)])('refuses malformed/oversized stdin without echoing its bytes', async input => {
    const result = await run(input); expect(result.code).toBe(1); expect(result.out).toBe(''); expect(result.err).toContain('Tool request refused'); expect(result.err).not.toContain('never-print');
  });
  it('refuses invalid UTF-8 stdin without echoing bytes', async () => {
    expect(await run(Buffer.from([0xff]))).toMatchObject({ code: 1, out: '', err: expect.stringContaining('Tool request refused') });
  });
  it.skipIf(process.platform === 'win32')('refuses a FIFO in a bounded real child rather than blocking on open', async () => {
    execFileSync('mkfifo', [join(root, 'pipe')]);
    expect(await run(JSON.stringify(request(root, 'read_file', 'pipe')))).toMatchObject({ code: 1, out: '', err: expect.stringContaining('Tool request refused') });
  });
  it('refuses an extra path operand before executing a valid write', async () => {
    const result = await run(JSON.stringify(request(root, 'write_file', 'created', 'no')), [join(root, 'ignored')]);
    expect(result.code).toBe(1); expect(result.out).toBe(''); expect(() => readFileSync(join(root, 'created'))).toThrow();
  });
});
