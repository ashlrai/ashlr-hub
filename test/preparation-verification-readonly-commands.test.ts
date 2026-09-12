/** Pure broker grammar checks: private directories only, no Git/process launch. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

interface Command {
  file: string;
  args: string[];
  options: { maxBuffer: number };
  input?: Buffer;
  blob: boolean;
}
let readonlyCommand: (request: unknown, fixtureRoot: string, scratch: string) => Command;
let createSession: (options: unknown) => Promise<unknown>;
let maxSessionDuration: number;
let root: string, fixture: string, repo: string, scratch: string;
const oid = 'a'.repeat(40);
const configs = ['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.attributesFile=/dev/null',
  'commit.gpgsign=false', 'tag.gpgsign=false', 'gc.auto=0', 'maintenance.auto=false',
  'core.logAllRefUpdates=false', 'protocol.allow=never'];
beforeAll(async () => {
  ({ readonlyCommand, createPreparationCandidateSession: createSession } = await import(new URL('../scripts/evaluators/preparation-verification-controller.mjs', import.meta.url).href));
  ({ MAX_SESSION_DURATION_MS: maxSessionDuration } = await import(new URL('../scripts/evaluators/preparation-verification-protocol.mjs', import.meta.url).href));
});
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-grammar-')));
  fixture = join(root, 'fixture'); repo = join(fixture, 'repo'); scratch = join(root, 'scratch');
  mkdirSync(fixture, { mode: 0o700 }); mkdirSync(repo, { mode: 0o700 }); mkdirSync(scratch, { mode: 0o700 });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
function request(args: string[], input: string | null = null) {
  return { schemaVersion: 1, id: 1, nonce: 'b'.repeat(64), api: 'spawnSync', file: 'git',
    args: ['--no-replace-objects', ...configs.flatMap(value => ['-c', value]), '-C', repo, ...args],
    options: { cwd: null, encoding: 'buffer', timeoutMs: 30_000, maxBuffer: 68 * 1024 * 1024, inputBase64: input } };
}
const parse = (value: unknown) => readonlyCommand(value, fixture, scratch);

describe('closed read-only preparation Git broker', () => {
  it('exports an explicit upper bound matching the fifteen-minute invocation ceiling', () => {
    expect(maxSessionDuration).toBe(900000);
  });

  it.runIf(process.platform === 'darwin')('accepts the exact session cap before inspecting the bridge, without launching', async () => {
    // Stop deliberately at the next validation read, before paths or runtime I/O.
    const marker = new Error('bridge validation reached');
    const bridge = { get runVerifySubprocessAsync() { throw marker; } };
    await expect(createSession({ timeoutMs: maxSessionDuration, bridge })).rejects.toBe(marker);
    await expect(createSession({ bridge })).rejects.toBe(marker); // unchanged default is still accepted
  });

  it.each([900001, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses invalid session duration %s before bridge access', async timeoutMs => {
    let inspected = false;
    const bridge = { get runVerifySubprocessAsync() { inspected = true; throw new Error('must not inspect'); } };
    await expect(createSession({ timeoutMs, bridge })).rejects.toThrow('CANDIDATE_SESSION_FAILED');
    expect(inspected).toBe(false);
  });

  it.each([
    ['rev-parse', '--show-toplevel'],
    ['rev-parse', '--verify', 'refs/heads/codex/upstream'],
    ['rev-parse', '--verify', `${oid}^{commit}`],
    ['rev-parse', '--verify', `${oid}^{tree}`],
    ['rev-parse', '--verify', `${'c'.repeat(64)}^{commit}`],
    ['rev-parse', '--verify', `${'c'.repeat(64)}^{tree}`],
    ['symbolic-ref', '-q', 'refs/heads/codex/upstream'],
    ['show-ref', '--verify', '--quiet', 'refs/heads/codex/upstream'],
    ['rev-list', '--parents', '-n', '1', oid],
    ['rev-list', '--parents', '-n', '1', 'c'.repeat(64)],
    ['for-each-ref', '--format=%(refname)'],
    ['for-each-ref', '--format=%(refname)', 'refs/heads/codex/template'],
    ['ls-tree', '-rz', '--full-tree', oid],
    ['ls-tree', '-rlz', '--full-tree', 'c'.repeat(64)],
    ['cat-file', 'blob', oid],
  ])('accepts exact delivery read query %j', (...args) => {
    const value = parse(request(args));
    expect(value.file).toBe('/usr/bin/git');
    expect(value.args).toEqual(request(args).args);
    expect(value.options.maxBuffer).toBe(68 * 1024 * 1024);
    expect(value.blob).toBe(args[0] === 'cat-file');
  });

  it('preserves legacy requests while enforcing the full fixed safe prefix', () => {
    const value = request(['rev-parse', '--show-toplevel']); value.args = ['-C', repo, 'rev-parse', '--show-toplevel'];
    expect(parse(value).args).toEqual(request(['rev-parse', '--show-toplevel']).args);
  });

  it.each([`${oid}^`, `${oid}~1`, `${oid}^2`, `${oid}^{}`, `${oid}^{blob}`, `${oid}^{tree}:value.json`,
    `${oid}..${oid}`, `${oid}^{commit}^{tree}`, `${oid.slice(1)}^{tree}`, `${oid}a^{tree}`, 'HEAD^{tree}',
    'refs/heads/codex/upstream^{tree}', '--all'])('refuses broad revision expression %s', revision => {
    expect(() => parse(request(['rev-parse', '--verify', revision]))).toThrow('CANDIDATE_SESSION_FAILED');
  });

  it('allows duplicate SHA-1/SHA-256 batch reads without converting byte input', () => {
    const bytes = `${oid}\n${oid}\n${'c'.repeat(64)}\n`;
    const value = parse(request(['cat-file', '--batch'], Buffer.from(bytes).toString('base64')));
    expect(value.input).toEqual(Buffer.from(bytes)); expect(value.blob).toBe(true);
  });

  it.each([
    ['update-ref', 'refs/heads/codex/upstream', oid],
    ['symbolic-ref', 'refs/heads/codex/upstream', 'refs/heads/main'],
    ['symbolic-ref', '-d', 'refs/heads/codex/upstream'],
    ['symbolic-ref', '-q', 'refs/heads/codex/upstream', 'refs/heads/main'],
    ['show-ref', '--verify', '--quiet', '--', 'refs/heads/codex/upstream'],
    ['for-each-ref', '--format=%(refname)', 'refs/heads/codex/template', 'refs/heads/main'],
    ['for-each-ref', '--format=%(refname)', '--shell'],
    ['for-each-ref', '--format=%(contents)', 'refs/heads/codex/template'],
    ['for-each-ref', '--format=%(refname)', 'refs/heads/*'],
    ['for-each-ref', '--format=%(refname)', 'refs/tags/tag'],
    ['hash-object', '-w', '--stdin'], ['mktree', '-z'], ['commit-tree', oid],
    ['checkout', 'main'], ['fetch', 'origin'], ['worktree', 'add', '/tmp/not-allowed'],
    ['cat-file', '--filters', oid], ['cat-file', '--batch-command'],
    ['rev-parse', '--verify', 'HEAD'], ['rev-parse', '--verify', 'refs/tags/tag'],
    ['rev-list', '--parents', '-n', '2', oid], ['rev-list', '--parents', '-n', '1', 'HEAD'],
    ['rev-list', '--parents', '-n', '1', `${oid}~1`], ['rev-list', '--parents', '-n', '1', oid, '--all'],
    ['rev-list', '--parents', '--objects', '-n', '1', oid], ['rev-list', '--parents', '-n', '1'],
  ])('refuses write/expanded query %j', (...args) => { expect(() => parse(request(args))).toThrow('CANDIDATE_SESSION_FAILED'); });

  it.each(['refs/heads/', 'refs/heads/../main', 'refs/heads/a.lock', 'refs/heads/a.',
    'refs/heads/a//b', 'refs/heads/a@{1}', 'refs/heads/a\n', 'refs/heads/.hidden', 'refs/heads/a:other'])(
    'rejects nonliteral or invalid branch ref %j', ref => {
    for (const args of [['symbolic-ref', '-q', ref], ['show-ref', '--verify', '--quiet', ref], ['rev-parse', '--verify', ref],
      ['for-each-ref', '--format=%(refname)', ref]]) {
      expect(() => parse(request(args))).toThrow();
    }
  });

  it.each(['core.hooksPath=/tmp/hooks', 'protocol.allow=always', 'alias.read=!touch /tmp/file', 'core.pager=cat'])(
    'rejects unapproved configuration %s', setting => {
    const value = request(['rev-parse', '--show-toplevel']); value.args = ['-c', setting, '-C', repo, 'rev-parse', '--show-toplevel'];
    expect(() => parse(value)).toThrow();
  });

  it('refuses foreign and symlink repositories and optional foreign cwd', () => {
    const value = request(['rev-parse', '--show-toplevel']);
    value.args = ['-C', scratch, 'rev-parse', '--show-toplevel']; expect(() => parse(value)).toThrow();
    const alias = join(fixture, 'alias'); symlinkSync(repo, alias);
    value.args = ['-C', alias, 'rev-parse', '--show-toplevel']; expect(() => parse(value)).toThrow();
    expect(() => parse({ ...request(['rev-parse', '--show-toplevel']), options: { ...value.options, cwd: scratch } })).toThrow();
  });

  it('refuses excess declaration, injected options, and input on nonblob commands', () => {
    const value = request(['show-ref', '--verify', '--quiet', 'refs/heads/codex/upstream']);
    expect(() => parse({ ...value, options: { ...value.options, maxBuffer: 68 * 1024 * 1024 + 1 } })).toThrow();
    expect(() => parse({ ...value, options: { ...value.options, shell: true } })).toThrow();
    expect(() => parse({ ...value, options: { ...value.options, inputBase64: Buffer.from('input').toString('base64') } })).toThrow();
  });
});
