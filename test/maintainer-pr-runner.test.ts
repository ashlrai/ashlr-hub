import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import { runVerifyCommandAsync, runVerifySubprocessAsync } from '../src/core/run/verify-commands.js';
import { safeGitCommand } from '../src/core/sandbox/safe-git.js';
import { prepareMaintainerRun, runMaintainerPr, type MaintainerRunContext } from '../src/core/fleet/maintainer-pr-runner.js';

vi.mock('../src/core/sandbox/audit.js', () => ({ audit: vi.fn() }));
// Synthetic admission only; the real launcher/profile/child process are not mocked.
const standing = vi.hoisted(() => ({ policy: null as unknown }));
vi.mock('../src/core/authority/effective-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/authority/effective-config.js')>()),
  currentStandingPolicy: () => standing.policy,
}));
const repositories: string[] = [];
function git(repo: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Verifier', '-c', 'user.email=verifier@example.test', ...args], { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function contract(script = 'console.log("verified")') {
  return JSON.stringify({ schemaVersion: 1, mode: 'replace-detected', commands: [
    { id: 'real-node', kind: 'test', cmd: ['node', '-e', script], required: true, profiles: ['merge'] },
  ] });
}
function fixture(changeContract = false): MaintainerRunContext {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'maintainer-runner-test-'))); repositories.push(repo);
  git(repo, 'init');
  writeFileSync(join(repo, 'ashlr.verify.json'), contract());
  writeFileSync(join(repo, 'code.txt'), 'base\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
  const baseSha = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'code.txt'), 'head\n');
  if (changeContract) writeFileSync(join(repo, 'ashlr.verify.json'), contract('throw new Error("candidate contract must not run")'));
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'head');
  return { repo: 'ashlrai/fixture', pr: 1, baseBranch: 'main', mirrorPath: repo,
    baseSha, headSha: git(repo, 'rev-parse', 'HEAD'), treeSha: git(repo, 'rev-parse', 'HEAD^{tree}'), mergeBaseSha: baseSha,
    cfg: {} as AshlrConfig, assertAuthorized: vi.fn(),
  };
}
const deps = {
  lease: async <T>(_repo: string, fn: () => Promise<T>): Promise<T> => fn(),
  slot: async <T>(_repo: string, fn: () => Promise<T>): Promise<T> => fn(),
  // Unit-only launcher: real harmless Node execution, without mutating live authority.
  openConfinement: async () => ({ runSubprocess: runVerifySubprocessAsync, close: vi.fn() }),
};
afterEach(() => {
  standing.policy = null;
  vi.unstubAllEnvs();
  for (const repo of repositories.splice(0)) {
    expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    rmSync(repo, { recursive: true, force: true });
  }
});

describe('host exact-tree maintainer runner', () => {
  it('runs the real base command on exact head, captures evidence and removes scratch worktrees', async () => {
    const context = fixture();
    const prepared = await prepareMaintainerRun(context, deps);
    expect(Object.isFrozen(prepared.expectedCommands)).toBe(true);
    expect(Object.isFrozen(prepared.expectedCommands[0]!.cmd)).toBe(true);
    const result = await runMaintainerPr(prepared, deps);
    expect(result).toMatchObject({ ok: true, sourceUnchanged: true, worktreeRemoved: true, confinement: 'required', headSha: context.headSha });
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]!.result).toMatchObject({ ok: true, exitCode: 0, timedOut: false });
    expect(result.commands[0]!.result.output).toContain('verified');
    expect(result.commands[0]!.outputSha256).toBe(createHash('sha256').update(result.commands[0]!.result.output).digest('hex'));
    expect(readFileSync(join(context.mirrorPath, 'code.txt'), 'utf8')).toBe('head\n');
  });
  it('keeps the base contract even when candidate changes its own verifier', async () => {
    const context = fixture(true);
    const prepared = await prepareMaintainerRun(context, deps);
    expect(prepared.expectedCommands[0]!.cmd).toContain('console.log("verified")');
    expect((await runMaintainerPr(prepared, deps)).ok).toBe(true);
  });
  it('normalizes nested project cwd and derives the same contract across independent scratch checkouts', async () => {
    const context = fixture(); mkdirSync(join(context.mirrorPath, 'nested'));
    writeFileSync(join(context.mirrorPath, 'nested', 'input.txt'), 'nested input');
    const nestedContract = JSON.parse(contract()); nestedContract.commands[0].cwd = 'nested';
    writeFileSync(join(context.mirrorPath, 'ashlr.verify.json'), JSON.stringify(nestedContract));
    git(context.mirrorPath, 'add', '.'); git(context.mirrorPath, 'commit', '-m', 'nested base');
    context.baseSha = git(context.mirrorPath, 'rev-parse', 'HEAD'); context.mergeBaseSha = context.baseSha;
    writeFileSync(join(context.mirrorPath, 'code.txt'), 'nested head');
    git(context.mirrorPath, 'add', '.'); git(context.mirrorPath, 'commit', '-m', 'nested head');
    context.headSha = git(context.mirrorPath, 'rev-parse', 'HEAD'); context.treeSha = git(context.mirrorPath, 'rev-parse', 'HEAD^{tree}');
    const prepared = await prepareMaintainerRun(context, deps);
    expect(prepared.expectedCommands[0]!.cwd).toBe('nested');
    expect((await prepareMaintainerRun(context, deps)).contractSha256).toBe(prepared.contractSha256);
    expect((await runMaintainerPr(prepared, deps)).ok).toBe(true);
  });
  it('does not execute hostile hooks, filters, diff/fsmonitor programs or inherited Git configuration', async () => {
    const context = fixture();
    writeFileSync(join(context.mirrorPath, '.gitattributes'), 'code.txt filter=hostile diff=hostile\n');
    git(context.mirrorPath, 'add', '.gitattributes'); git(context.mirrorPath, 'commit', '-m', 'candidate attributes');
    context.headSha = git(context.mirrorPath, 'rev-parse', 'HEAD'); context.treeSha = git(context.mirrorPath, 'rev-parse', 'HEAD^{tree}');
    const marker = join(context.mirrorPath, 'host-program-ran');
    const probe = join(context.mirrorPath, '.git', 'host-probe.cjs');
    writeFileSync(probe, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`);
    const program = `${process.execPath} ${probe}`;
    const hooks = join(context.mirrorPath, '.git', 'hostile-hooks'); mkdirSync(hooks);
    writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\n${program}\n`); chmodSync(join(hooks, 'post-checkout'), 0o700);
    for (const [key, value] of [['core.hooksPath', hooks], ['core.fsmonitor', program], ['filter.hostile.smudge', program],
      ['filter.hostile.clean', program], ['filter.hostile.required', 'true'], ['diff.hostile.command', program], ['diff.external', program]]) {
      git(context.mirrorPath, 'config', key!, value!);
    }
    vi.stubEnv('GIT_CONFIG_COUNT', '1'); vi.stubEnv('GIT_CONFIG_KEY_0', 'core.fsmonitor'); vi.stubEnv('GIT_CONFIG_VALUE_0', program);
    vi.stubEnv('GITHUB_TOKEN', 'unit-only-credential-not-for-child');
    const safe = safeGitCommand({ workTree: context.mirrorPath, gitDir: join(context.mirrorPath, '.git'), layout: 'repo', args: ['status'] });
    expect(safe.env['GITHUB_TOKEN']).toBeUndefined();
    expect(safe.env['GIT_CONFIG_KEY_0']).toBe('http.extraHeader'); expect(safe.env['GIT_CONFIG_VALUE_0']).toBe('');
    const prepared = await prepareMaintainerRun(context, deps);
    expect((await runMaintainerPr(prepared, deps)).ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
    // Reset the test-only malicious mirror settings before fixture teardown's ordinary Git.
    vi.unstubAllEnvs();
    for (const key of ['core.hooksPath', 'core.fsmonitor', 'filter.hostile.smudge', 'filter.hostile.clean', 'filter.hostile.required', 'diff.hostile.command', 'diff.external']) {
      git(context.mirrorPath, 'config', '--unset', key);
    }
  });
  it('rejects a caller-substituted command sequence before executing anything', async () => {
    const prepared = await prepareMaintainerRun(fixture(), deps);
    const runCommand = vi.fn();
    const result = await runMaintainerPr({ ...prepared, expectedCommands: [{ kind: 'test', cmd: ['node', '-e', 'true'] }] }, { ...deps, runCommand });
    expect(result.ok).toBe(false); expect(result.reason).toContain('independently detected base commands'); expect(runCommand).not.toHaveBeenCalled();
  });
  it('refuses an incorrect tree pin before creating a candidate worktree', async () => {
    await expect(prepareMaintainerRun({ ...fixture(), treeSha: 'f'.repeat(40) }, deps)).rejects.toThrow('Git pins');
  });
  it('refuses unavailable confinement without an unconfined fallback', async () => {
    const prepared = await prepareMaintainerRun(fixture(), deps); const runCommand = vi.fn();
    const result = await runMaintainerPr(prepared, { ...deps, openConfinement: async () => null, runCommand });
    expect(result).toMatchObject({ ok: false, worktreeRemoved: true }); expect(result.reason).toContain('confinement'); expect(runCommand).not.toHaveBeenCalled();
  });
  it('detects a command changing tracked source and still cleans up', async () => {
    const prepared = await prepareMaintainerRun(fixture(), deps);
    const runCommand = vi.fn(async (_command, directory: string) => {
      writeFileSync(join(directory, 'code.txt'), 'changed by test\n');
      return { ok: true, command: 'node', exitCode: 0, output: '', timedOut: false };
    });
    const result = await runMaintainerPr(prepared, { ...deps, runCommand });
    expect(result).toMatchObject({ ok: false, sourceUnchanged: false, worktreeRemoved: true }); expect(result.reason).toContain('source changed');
  });
  it('does not pass if Stop/authority is revoked after preparation', async () => {
    const context = fixture(); const prepared = await prepareMaintainerRun(context, deps);
    const result = await runMaintainerPr({ ...prepared, assertAuthorized: () => { throw new Error('Stop is active'); } }, deps);
    expect(result).toMatchObject({ ok: false, commands: [], worktreeRemoved: true }); expect(result.reason).toContain('Stop');
  });
  it('treats cancellation after a command as failure and removes its worktree', async () => {
    const controller = new AbortController(); const prepared = await prepareMaintainerRun({ ...fixture(), signal: controller.signal }, deps);
    const runCommand = vi.fn(async () => { controller.abort(); return { ok: true, command: 'node', exitCode: 0, output: '', timedOut: false }; });
    expect(await runMaintainerPr(prepared, { ...deps, runCommand })).toMatchObject({ ok: false, sourceUnchanged: false, worktreeRemoved: true });
  });
  it('passes cancellation into preparation and head-creation lease waits before execution', async () => {
    const controller = new AbortController(); const context = { ...fixture(), signal: controller.signal };
    let calls = 0; const runCommand = vi.fn();
    const lease = async <T>(_repo: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
      expect(signal).toBe(controller.signal);
      if (++calls === 3) { controller.abort(); throw new Error('repository lease unavailable: aborted'); }
      return fn();
    };
    const prepared = await prepareMaintainerRun(context, { ...deps, lease });
    const result = await runMaintainerPr(prepared, { ...deps, lease, runCommand });
    expect(result).toMatchObject({ ok: false, commands: [], worktreeRemoved: true });
    expect(result.reason).toContain('aborted'); expect(runCommand).not.toHaveBeenCalled();
  });
  it('keeps cleanup lease available after its execution signal is aborted', async () => {
    const controller = new AbortController(); const signals: (AbortSignal | undefined)[] = [];
    const lease = async <T>(_repo: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> => { signals.push(signal); return fn(); };
    const prepared = await prepareMaintainerRun({ ...fixture(), signal: controller.signal }, { ...deps, lease });
    const runCommand = vi.fn(async () => { controller.abort(); return { ok: false, command: 'node', exitCode: -1, output: '', timedOut: false, cancelled: true }; });
    const result = await runMaintainerPr(prepared, { ...deps, lease, runCommand });
    expect(result).toMatchObject({ ok: false, worktreeRemoved: true });
    expect(signals).toEqual([controller.signal, controller.signal, controller.signal, undefined]);
  });
  it('keeps cleanup running even if closing confinement fails', async () => {
    const prepared = await prepareMaintainerRun(fixture(), deps);
    const result = await runMaintainerPr(prepared, { ...deps, openConfinement: async () => ({ runSubprocess: runVerifySubprocessAsync, close: () => { throw new Error('cleanup failed'); } }) });
    expect(result).toMatchObject({ ok: false, worktreeRemoved: true }); expect(result.reason).toContain('confinement cleanup');
  });
});

// Real kernel confinement on macOS, with isolated test HOME. No live standing
// grant, account credential, provider call, signing or App check is involved.
describe.runIf(process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'))('maintainer runner under the macOS kernel sandbox', () => {
  const kernelDeps = { lease: deps.lease, slot: deps.slot };
  function kernelFixture(script: string): MaintainerRunContext {
    const context = fixture();
    const baseContract = JSON.parse(contract()); baseContract.commands[0].cmd = ['node', 'probe.cjs'];
    writeFileSync(join(context.mirrorPath, 'ashlr.verify.json'), JSON.stringify(baseContract));
    writeFileSync(join(context.mirrorPath, 'probe.cjs'), 'console.log("base probe")');
    git(context.mirrorPath, 'add', '.'); git(context.mirrorPath, 'commit', '-m', 'kernel base');
    context.baseSha = git(context.mirrorPath, 'rev-parse', 'HEAD'); context.mergeBaseSha = context.baseSha;
    writeFileSync(join(context.mirrorPath, 'probe.cjs'), script);
    git(context.mirrorPath, 'add', '.'); git(context.mirrorPath, 'commit', '-m', 'kernel candidate');
    context.headSha = git(context.mirrorPath, 'rev-parse', 'HEAD'); context.treeSha = git(context.mirrorPath, 'rev-parse', 'HEAD^{tree}');
    standing.policy = { grantId: 'synthetic-test-only-not-signed' };
    return context;
  }
  it('completes exact-head Node execution using the real launcher and cleans its worktree', async () => {
    const context = kernelFixture('console.log(require("node:fs").readFileSync("code.txt", "utf8"));');
    const prepared = await prepareMaintainerRun(context, kernelDeps);
    const result = await runMaintainerPr(prepared, kernelDeps);
    expect(result, result.reason).toMatchObject({ ok: true, sourceUnchanged: true, worktreeRemoved: true, confinement: 'required' });
    expect(result.commands[0]!.result).toMatchObject({ ok: true, exitCode: 0 });
    expect(result.commands[0]!.result.output).toContain('head');
    process.stdout.write(`${JSON.stringify({ kind: 'hermetic-macos-kernel-fixture',
      signedLiveAuthority: false, appPosted: false, baseSha: result.baseSha, headSha: result.headSha,
      treeSha: result.treeSha, mergeBaseSha: result.mergeBaseSha, diffSha256: result.diffSha256,
      contractSha256: result.contractSha256, confinement: result.confinement, sourceUnchanged: result.sourceUnchanged,
      worktreeRemoved: result.worktreeRemoved, commands: result.commands.map(({ command, result: commandResult, outputSha256 }) => ({
        id: command.id, exitCode: commandResult.exitCode, ok: commandResult.ok, outputSha256,
      })) })}\n`);
  });
  it('kills a hostile candidate reading a synthetic protected authority file and leaks no content', async () => {
    const secret = join(realpathSync(homedir()), '.ashlr', 'authority', 'maintainer-fixture-only');
    mkdirSync(join(realpathSync(homedir()), '.ashlr', 'authority'), { recursive: true, mode: 0o700 });
    writeFileSync(secret, 'synthetic-not-an-account-secret', { mode: 0o600 });
    try {
      const prepared = await prepareMaintainerRun(kernelFixture(`process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(secret)}, 'utf8'));`), kernelDeps);
      const result = await runMaintainerPr(prepared, kernelDeps);
      expect(result).toMatchObject({ ok: false, worktreeRemoved: true, sourceUnchanged: false });
      expect(result.commands[0]!.result.ok).toBe(false);
      expect(result.commands[0]!.result.output).not.toContain('synthetic-not-an-account-secret');
      expect(readFileSync(secret, 'utf8')).toBe('synthetic-not-an-account-secret');
    } finally { rmSync(secret, { force: true }); }
  });
  it('cancels a real confined child and removes the owned worktree', async () => {
    const controller = new AbortController();
    const context = kernelFixture('process.on("SIGINT", () => {}); require("node:fs").writeFileSync("kernel-started.txt", "started"); setInterval(() => {}, 1000);');
    const prepared = await prepareMaintainerRun({ ...context, signal: controller.signal }, kernelDeps);
    // Abort only after the real command runner starts; no substitute child or launcher.
    const runCommand: typeof runVerifyCommandAsync = async (...args) => {
      const started = join(args[1], 'kernel-started.txt');
      const timer = setInterval(() => { if (existsSync(started)) controller.abort(); }, 10);
      try { return await runVerifyCommandAsync(...args); }
      finally { clearInterval(timer); }
    };
    const result = await runMaintainerPr(prepared, { ...kernelDeps, runCommand });
    expect(result).toMatchObject({ ok: false, worktreeRemoved: true, sourceUnchanged: false });
    expect(result.commands[0]!.result, JSON.stringify(result.commands[0]!.result)).toMatchObject({ ok: false, cancelled: true });
  });
});
