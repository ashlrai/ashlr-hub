/** Fake runner only: verifies interceptor bookkeeping without native execution. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerifySubprocessOptions, VerifySubprocessResult } from '../src/core/run/verify-commands.js';
import { createPreparationMutationInterceptor } from './helpers/preparation-mutation-interceptor.js';

let root: string, fixtureRoot: string, scratch: string, toolPath: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-injector-')));
  fixtureRoot = join(root, 'fixture'); scratch = join(root, 'scratch'); toolPath = join(root, 'fixed-tool.mjs');
  mkdirSync(fixtureRoot, { mode: 0o700 }); mkdirSync(scratch, { mode: 0o700 }); writeFileSync(toolPath, '// inert\n', { mode: 0o600 });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
function result(output: Record<string, unknown> = {}): VerifySubprocessResult {
  return { exitCode: 0, signal: null, timedOut: false, cancelled: false, stderr: '', processGroupSettlement: 'group-exit-confirmed',
    stdout: JSON.stringify({ started: true, status: 0, signal: null, error: null,
      stdoutBase64: Buffer.from([0, 255, 10, 128]).toString('base64'), stderrBase64: '', ...output }) + '\n' };
}
function invocation(id = 1, nonce = id.toString(16).padStart(64, '0')) {
  const request = { schemaVersion: 1, id, nonce, api: 'spawnSync', file: '/bin/ls', args: ['-lde', join(fixtureRoot, 'intent.json')],
    options: { cwd: null, encoding: 'buffer', timeoutMs: 30000, maxBuffer: 65536, inputBase64: null } };
  const argv = ['/usr/bin/sandbox-exec', '-p', '(version 1)', process.execPath, '--no-addons', toolPath];
  const opts: VerifySubprocessOptions = { cwd: scratch, env: {}, timeoutMs: 30000, requireProcessGroupExit: true,
    input: JSON.stringify({ request, fixtureRoot, scratch }) };
  return { request, argv, opts };
}
function setup(value = result(), mutate = vi.fn(() => undefined), matches = vi.fn(() => true)) {
  const run = vi.fn(async (_argv: string[], _opts: VerifySubprocessOptions) => value);
  const interceptor = createPreparationMutationInterceptor({ run, toolPath, fixtureRoot, mutate, matches });
  return { interceptor, run, mutate, matches, value };
}

describe.runIf(process.platform !== 'win32')('test-only preparation mutation interceptor', () => {
  it('returns the identical result and forwards identical arguments, injecting after completion exactly once', async () => {
    const events: string[] = []; const value = result(); const before = value.stdout;
    const run = vi.fn(async (_argv: string[], _opts: VerifySubprocessOptions) => { events.push('native-result'); return value; });
    const mutate = vi.fn(() => { events.push('mutation'); });
    const interceptor = createPreparationMutationInterceptor({ run, toolPath, fixtureRoot, mutate, matches: request => {
      expect(Object.isFrozen(request)).toBe(true); expect(Object.isFrozen(request.args)).toBe(true); expect(Object.isFrozen(request.options)).toBe(true);
      return request.file === '/bin/ls' && request.args.includes(join(fixtureRoot, 'intent.json'));
    } });
    const first = invocation(); interceptor.arm();
    expect(await interceptor.run(first.argv, first.opts)).toBe(value);
    expect(run.mock.calls[0]).toEqual([first.argv, first.opts]);
    expect(run.mock.calls[0]![0]).toBe(first.argv); expect(run.mock.calls[0]![1]).toBe(first.opts);
    expect(events).toEqual(['native-result', 'mutation']); expect(value.stdout).toBe(before);
    const second = invocation(2); expect(await interceptor.run(second.argv, second.opts)).toBe(value);
    expect(mutate).toHaveBeenCalledTimes(1); expect(interceptor.injections()).toBe(1); interceptor.assertInjected();
  });

  it('does not inject before arm and preserves earlier native calls in the identity sequence', async () => {
    const f = setup(); const first = invocation(); await f.interceptor.run(first.argv, first.opts);
    expect(f.matches).not.toHaveBeenCalled(); expect(f.interceptor.injections()).toBe(0);
    f.interceptor.arm(); const next = invocation(2); await f.interceptor.run(next.argv, next.opts);
    f.interceptor.assertInjected(); expect(f.run).toHaveBeenCalledTimes(2);
  });

  it('passes unrelated candidate lifecycle calls unchanged, including after a retained fault', async () => {
    const f = setup(); expect(() => f.interceptor.assertInjected()).toThrow('PREPARATION_MUTATION_INTERCEPTOR_FAILED');
    const argv = [process.execPath, 'candidate.mjs']; const opts = invocation().opts;
    expect(await f.interceptor.run(argv, opts)).toBe(f.value); expect(f.mutate).not.toHaveBeenCalled();
  });

  it('requires a matching injection and does not turn a miss into successful refusal', async () => {
    const f = setup(result(), vi.fn(() => undefined), vi.fn(() => false)); f.interceptor.arm(); const call = invocation();
    expect(await f.interceptor.run(call.argv, call.opts)).toBe(f.value);
    expect(() => f.interceptor.assertInjected()).toThrow(); expect(f.interceptor.injections()).toBe(0);
  });

  it.each(['id', 'nonce'] as const)('refuses duplicated %s before another underlying invocation', async kind => {
    const f = setup(); f.interceptor.arm(); const first = invocation(); await f.interceptor.run(first.argv, first.opts);
    const duplicate = invocation(kind === 'id' ? 1 : 2, first.request.nonce);
    await expect(f.interceptor.run(duplicate.argv, duplicate.opts)).rejects.toThrow('PREPARATION_MUTATION_INTERCEPTOR_FAILED');
    expect(f.run).toHaveBeenCalledTimes(1); expect(() => f.interceptor.assertInjected()).toThrow();
  });

  it.each(['foreign-fixture', 'foreign-scratch', 'extra-input', 'bad-request', 'unsafe-command', 'oversize', 'bad-json', 'wrong-argv'])(
    'rejects invalid tool transport %s without invoking the runner', async kind => {
      const f = setup(); f.interceptor.arm(); const call = invocation();
      const input = JSON.parse(call.opts.input!);
      if (kind === 'foreign-fixture') input.fixtureRoot = root;
      if (kind === 'foreign-scratch') input.scratch = fixtureRoot;
      if (kind === 'extra-input') input.extra = true;
      if (kind === 'bad-request') input.request.nonce = 'invalid';
      if (kind === 'unsafe-command') { input.request.file = 'git'; input.request.args = ['-C', fixtureRoot, 'update-ref', 'refs/heads/main', 'a'.repeat(40)]; }
      call.opts.input = kind === 'oversize' ? ' '.repeat(262145) : kind === 'bad-json' ? '{' : JSON.stringify(input);
      if (kind === 'wrong-argv') call.argv.splice(4, 0, '--inspect');
      await expect(f.interceptor.run(call.argv, call.opts)).rejects.toThrow('PREPARATION_MUTATION_INTERCEPTOR_FAILED');
      expect(f.run).not.toHaveBeenCalled(); expect(f.mutate).not.toHaveBeenCalled(); expect(() => f.interceptor.assertInjected()).toThrow();
    });

  it.each([
    ['native-failed', { status: 1 }], ['not-started', { started: false }], ['native-signal', { signal: 'SIGTERM' }],
    ['native-error', { error: { code: 'EPERM' } }], ['bad-base64', { stdoutBase64: 'AA=' }],
    ['too-many-bytes', { stdoutBase64: Buffer.alloc(65537).toString('base64') }], ['extra-field', { extra: true }],
  ] as const)('retains failure for selected result %s', async (_kind, patch) => {
    const f = setup(result(patch)); f.interceptor.arm(); const call = invocation();
    await expect(f.interceptor.run(call.argv, call.opts)).rejects.toThrow('PREPARATION_MUTATION_INTERCEPTOR_FAILED');
    expect(f.run).toHaveBeenCalledTimes(1); expect(f.mutate).not.toHaveBeenCalled(); expect(() => f.interceptor.assertInjected()).toThrow();
  });

  it.each(['unconfirmed', 'cancelled', 'timed-out', 'stderr', 'malformed-output'])(
    'does not inject after wrapper %s', async kind => {
      const value = result();
      if (kind === 'unconfirmed') value.processGroupSettlement = 'unconfirmed';
      if (kind === 'cancelled') value.cancelled = true;
      if (kind === 'timed-out') value.timedOut = true;
      if (kind === 'stderr') value.stderr = 'diagnostic';
      if (kind === 'malformed-output') value.stdout = '{}';
      const f = setup(value); f.interceptor.arm(); const call = invocation();
      await expect(f.interceptor.run(call.argv, call.opts)).rejects.toThrow();
      expect(f.interceptor.injections()).toBe(0); expect(() => f.interceptor.assertInjected()).toThrow();
    });

  it('retains callback failure independently of the candidate error', async () => {
    const f = setup(result(), vi.fn(() => { throw new Error('fixture mutation failed'); })); f.interceptor.arm(); const call = invocation();
    await expect(f.interceptor.run(call.argv, call.opts)).rejects.toThrow('PREPARATION_MUTATION_INTERCEPTOR_FAILED');
    expect(f.run).toHaveBeenCalledTimes(1); expect(f.interceptor.injections()).toBe(0);
    expect(() => f.interceptor.assertInjected()).toThrow(); expect(() => f.interceptor.arm()).toThrow();
  });

  it('refuses rearming instead of silently granting a second mutation', () => {
    const f = setup(); f.interceptor.arm(); expect(() => f.interceptor.arm()).toThrow(); expect(() => f.interceptor.assertInjected()).toThrow();
  });

  it('rejects an async mutation result and retains the failure', async () => {
    const interceptor = createPreparationMutationInterceptor({ run: async () => result(), toolPath, fixtureRoot,
      matches: () => true, mutate: async () => undefined });
    interceptor.arm(); const call = invocation();
    await expect(interceptor.run(call.argv, call.opts)).rejects.toThrow('PREPARATION_MUTATION_INTERCEPTOR_FAILED');
    expect(interceptor.injections()).toBe(0); expect(() => interceptor.assertInjected()).toThrow();
  });

  it('retains matcher failure before any underlying invocation', async () => {
    const f = setup(result(), vi.fn(() => undefined), vi.fn(() => { throw new Error('bad matcher'); }));
    f.interceptor.arm(); const call = invocation();
    await expect(f.interceptor.run(call.argv, call.opts)).rejects.toThrow('PREPARATION_MUTATION_INTERCEPTOR_FAILED');
    expect(f.run).not.toHaveBeenCalled(); expect(f.mutate).not.toHaveBeenCalled(); expect(() => f.interceptor.assertInjected()).toThrow();
  });

  it('retains underlying runner rejection without retrying or injecting', async () => {
    const run = vi.fn(async () => { throw new Error('runner unavailable'); }); const mutate = vi.fn();
    const interceptor = createPreparationMutationInterceptor({ run, toolPath, fixtureRoot, matches: () => true, mutate });
    interceptor.arm(); const call = invocation();
    await expect(interceptor.run(call.argv, call.opts)).rejects.toThrow('PREPARATION_MUTATION_INTERCEPTOR_FAILED');
    expect(run).toHaveBeenCalledTimes(1); expect(mutate).not.toHaveBeenCalled(); expect(() => interceptor.assertInjected()).toThrow();
  });
});
