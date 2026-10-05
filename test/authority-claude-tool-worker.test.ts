import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
    const invoke = async (call: object) => await run(JSON.stringify({ schemaVersion: 1, root, call }));
    expect(JSON.parse((await invoke({ name: 'create_directory', path: 'src' })).out)).toMatchObject({ created: true });
    const page = JSON.parse((await invoke({ name: 'read_file', path: 'created', offset: 0, limit: 1 })).out);
    expect(JSON.parse((await invoke({ name: 'edit_file', path: 'created', expectedSha256: page.sha256, oldText: 'child', newText: 'worker' })).out)).toMatchObject({ edited: true });
    expect(JSON.parse((await invoke({ name: 'search', path: '.', query: 'worker' })).out).matches[0].text).toBe('actual worker bytes');
    expect(JSON.parse((await invoke({ name: 'list_files', path: '.' })).out).files.map((entry: { name: string }) => entry.name)).toEqual(['created', 'src']);
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
    expect(await run(JSON.stringify({ schemaVersion: 1, root, call: { name: 'edit_file', path: 'pipe', expectedSha256: 'a'.repeat(64), oldText: 'x', newText: 'y' } }))).toMatchObject({ code: 1, out: '' });
  });
  it('refuses an extra path operand before executing a valid write', async () => {
    const result = await run(JSON.stringify(request(root, 'write_file', 'created', 'no')), [join(root, 'ignored')]);
    expect(result.code).toBe(1); expect(result.out).toBe(''); expect(() => readFileSync(join(root, 'created'))).toThrow();
  });
});


describe('bounded engineering navigation and edits', () => {
  const tool = (call: object): string => executeClaudeToolRequest({ schemaVersion: 1, root, call });
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  it('ranges a real large Unicode file, preserving legacy read limits and its content hash', () => {
    const text = Array.from({ length: 4000 }, (_, i) => `source ${i} π`).join('\n');
    writeFileSync(join(root, 'large.ts'), text);
    expect(() => tool({ name: 'read_file', path: 'large.ts' })).toThrow();
    const page = JSON.parse(tool({ name: 'read_file', path: 'large.ts', offset: 120, limit: 2 }));
    expect(page).toMatchObject({ sha256: hash(text), offset: 120, returnedLines: 2, nextOffset: 122,
      content: '121\tsource 120 π\n122\tsource 121 π\n', totalLines: 4000 });
  });
  it('preserves executable mode for legacy writes and exact single edits; stale or ambiguous edits leave bytes intact', () => {
    const path = join(root, 'run.sh'); writeFileSync(path, '#!/bin/sh\necho old\n', { mode: 0o755 });
    // Establish the fixture's exact permissions independently of the runner's umask.
    chmodSync(path, 0o755);
    tool({ name: 'write_file', path: 'run.sh', text: '#!/bin/sh\necho unique\n' });
    expect(statSync(path).mode & 0o777).toBe(0o755);
    const text = readFileSync(path, 'utf8');
    expect(JSON.parse(tool({ name: 'edit_file', path: 'run.sh', expectedSha256: hash(text), oldText: 'unique', newText: 'new' }))).toMatchObject({ replacements: 1 });
    expect(statSync(path).mode & 0o777).toBe(0o755);
    const fresh = readFileSync(path, 'utf8');
    expect(() => tool({ name: 'edit_file', path: 'run.sh', expectedSha256: hash(text), oldText: 'new', newText: 'lost' })).toThrow();
    writeFileSync(path, 'same same');
    expect(() => tool({ name: 'edit_file', path: 'run.sh', expectedSha256: hash('same same'), oldText: 'same', newText: 'bad' })).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('same same'); expect(fresh).toBe('#!/bin/sh\necho new\n');
  });
  it('preserves BOM and CRLF bytes outside the exact requested replacement', () => {
    const before = Buffer.from('\ufefffirst\r\nreplace here\r\nlast\r\n'); writeFileSync(join(root, 'bom.ts'), before);
    tool({ name: 'edit_file', path: 'bom.ts', expectedSha256: createHash('sha256').update(before).digest('hex'), oldText: 'replace here', newText: 'updated' });
    expect(readFileSync(join(root, 'bom.ts'))).toEqual(Buffer.from('\ufefffirst\r\nupdated\r\nlast\r\n'));
  });
  it('creates nested directories and lists sorted, snapshot-bound pages while excluding private state', () => {
    expect(JSON.parse(tool({ name: 'create_directory', path: 'src/nested' }))).toMatchObject({ created: true });
    expect(JSON.parse(tool({ name: 'create_directory', path: 'src/nested' }))).toMatchObject({ created: false, directoriesCreated: 0 });
    for (const name of ['z.ts', 'a.ts', '.env.local']) writeFileSync(join(root, 'src', name), 'text');
    mkdirSync(join(root, 'src', '.CLAUDE')); mkdirSync(join(root, 'src', 'NODE_MODULES'));
    const first = JSON.parse(tool({ name: 'list_files', path: 'src', limit: 1 }));
    expect(first.files).toEqual([{ name: 'a.ts', kind: 'file' }]); expect(first.skipped).toBe(3);
    const next = JSON.parse(tool({ name: 'list_files', path: 'src', offset: first.nextOffset, expectedSnapshot: first.snapshot }));
    expect(next.files.map((row: { name: string }) => row.name)).toEqual(['nested', 'z.ts']);
    writeFileSync(join(root, 'src', 'b.ts'), 'changed');
    expect(() => tool({ name: 'list_files', path: 'src', offset: 1, expectedSnapshot: first.snapshot })).toThrow();
    expect(() => tool({ name: 'create_directory', path: 'src/a.ts/nested' })).toThrow();
    expect(() => tool({ name: 'read_file', path: 'src/.CLAUDE/auth.json' })).toThrow();
  });
  it('searches literal metacharacters with stable continuation and rejects source changes between pages', () => {
    mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src', 'a.ts'), 'a.*[b] first\na.*[b] second\nregex axb');
    writeFileSync(join(root, 'src', 'b.ts'), 'a.*[b] third');
    const first = JSON.parse(tool({ name: 'search', path: '.', query: 'a.*[b]', limit: 1 }));
    expect(first).toMatchObject({ totalMatches: 3, nextOffset: 1, coverageComplete: true });
    expect(first.matches[0]).toMatchObject({ path: 'src/a.ts', line: 1 });
    const next = JSON.parse(tool({ name: 'search', path: '.', query: 'a.*[b]', offset: 1, expectedSnapshot: first.snapshot }));
    expect(next.matches.map((match: { line: number }) => match.line)).toEqual([2, 1]); expect(next.nextOffset).toBeNull();
    writeFileSync(join(root, 'src', 'b.ts'), 'changed');
    expect(() => tool({ name: 'search', path: '.', query: 'a.*[b]', offset: 1, expectedSnapshot: first.snapshot })).toThrow();
    expect(() => tool({ name: 'search', path: '.', query: 'a.*[b]', offset: 1 })).toThrow();
  });
  it('reports skipped secrets, binaries, oversized source and hardlinks without scanning their content', () => {
    writeFileSync(join(root, '.env'), 'needle secret'); mkdirSync(join(root, '.CoDeX')); writeFileSync(join(root, '.CoDeX', 'token'), 'needle');
    writeFileSync(join(root, 'binary'), Buffer.from([255])); writeFileSync(join(root, 'huge'), 'needle'.repeat(200000));
    writeFileSync(join(root, 'hard'), 'needle'); linkSync(join(root, 'hard'), join(root, 'alias'));
    writeFileSync(join(root, 'good.ts'), 'needle safe');
    const result = JSON.parse(tool({ name: 'search', path: '.', query: 'needle' }));
    expect(result.matches).toEqual([{ path: 'good.ts', line: 1, text: 'needle safe' }]);
    expect(result.coverageComplete).toBe(false); expect(result.skipped).toBe(6);
  });
  it('keeps Unicode output within byte bounds and returns usable JSON for an oversized line', () => {
    writeFileSync(join(root, 'long.ts'), 'π'.repeat(20000));
    for (const call of [{ name: 'read_file', path: 'long.ts', limit: 1 }, { name: 'search', path: '.', query: 'π' }]) {
      const text = tool(call); expect(Buffer.byteLength(text)).toBeLessThanOrEqual(CLAUDE_TOOL_FILE_MAX_BYTES);
      expect(JSON.parse(text)).toMatchObject({ truncated: true, nextOffset: null, reason: expect.any(String) });
    }
  });
  it('does not descend beyond its depth bound or read native credential/config state', () => {
    let path = root;
    for (let i = 0; i < 34; i++) { path = join(path, 'nested'); mkdirSync(path); }
    writeFileSync(join(path, 'deep.ts'), 'needle'); writeFileSync(join(root, 'shallow.ts'), 'needle');
    for (const name of ['.CLAUDE.JSON', '.MCP.JSON', '.NPMRC']) writeFileSync(join(root, name), 'needle secret');
    const result = JSON.parse(tool({ name: 'search', path: '.', query: 'needle' }));
    expect(result.matches).toEqual([{ path: 'shallow.ts', line: 1, text: 'needle' }]); expect(result.coverageComplete).toBe(false);
    for (const name of ['.CLAUDE.JSON', '.MCP.JSON', '.NPMRC']) expect(() => tool({ name: 'read_file', path: name })).toThrow();
  });
  it('charges invalid UTF-8 reads to the scan budget before loading the next large file', () => {
    const binary = Buffer.alloc(1024 * 1024, 65); binary[binary.length - 1] = 255;
    for (let i = 0; i < 17; i++) writeFileSync(join(root, `binary-${i.toString().padStart(2, '0')}`), binary);
    const result = JSON.parse(tool({ name: 'search', path: '.', query: 'absent' }));
    expect(result).toMatchObject({ scanTruncated: true, coverageComplete: false, skipped: 15, filesScanned: 15 });
    expect(result.bytesScanned).toBe(15 * 1024 * 1024); expect(result.readBudgetReserved).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(result.filesAttempted).toBe(16);
  });
  it('bounds empty-directory traversal and identifies incomplete coverage', () => {
    // Branching empty directories count as work even when no files are read.
    for (let i = 0; i < 100; i++) { const parent = join(root, `dir${i}`); mkdirSync(parent); for (let j = 0; j < 51; j++) mkdirSync(join(parent, `empty${j}`)); }
    const result = JSON.parse(tool({ name: 'search', path: '.', query: 'absent' }));
    expect(result).toMatchObject({ scanTruncated: true, coverageComplete: false, filesScanned: 0 });
    expect(result.entriesVisited).toBeLessThanOrEqual(5000);
  });
  it('refuses malformed navigation shapes and symlink/hardlink edits without changing bytes', () => {
    for (const call of [{ name: 'read_file', path: 'a', offset: -1 }, { name: 'list_files', path: '.', limit: 0 },
      { name: 'search', path: '.', query: 'x', limit: 1.1 }, { name: 'search', path: '.', query: 'x\ny' },
      { name: 'edit_file', path: 'a', expectedSha256: 'bad', oldText: 'x', newText: 'y' }, { name: 'create_directory', path: '.git/a' }]) expect(() => tool(call)).toThrow();
    writeFileSync(join(root, 'a'), 'old'); linkSync(join(root, 'a'), join(root, 'hard'));
    expect(() => tool({ name: 'edit_file', path: 'hard', expectedSha256: hash('old'), oldText: 'old', newText: 'bad' })).toThrow();
    if (canSymlink()) { symlinkSync(join(root, 'a'), join(root, 'link')); expect(() => tool({ name: 'edit_file', path: 'link', expectedSha256: hash('old'), oldText: 'old', newText: 'bad' })).toThrow(); }
    expect(readFileSync(join(root, 'a'), 'utf8')).toBe('old');
  });
});
