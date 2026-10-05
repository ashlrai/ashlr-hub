/**
 * 3.15 — the Devin CLI fleet engine (`devin-cli`), spawned for real against a
 * FAKE `devin` on PATH:
 *   1. runEngineSandboxed runs it in the sandbox worktree with the exact
 *      registry argv, captures its edit as a PENDING proposal, and records the
 *      exact model it ran (`devin-cli:swe-2-high`) — the identity the merge
 *      path reads — with $0 cost;
 *   2. a per-run model override reaches `--model` and the recorded identity;
 *   3. a hung CLI is killed at the backstop WITH its process group (a
 *      grandchild it forked dies too) and the run never throws;
 *   4. (macOS) under the real autonomous sandbox-exec profile the CLI reads
 *      its per-run login copy, never Mason's real one, and can write only its
 *      worktree; the real `devin` binary starts under the profile.
 *
 * Hermetic: no real Devin call and no network — the only real binary touched
 * is `devin --version`, read-only, when installed. HOME is isolated by
 * test/setup/home.ts; ASHLR_HOME and every path are temp dirs.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildEngineCommand, spawnEngine } from '../src/core/run/engines.js';
import { applyAutonomousEnvOverlay, buildAutonomousEnvOverlay } from '../src/core/sandbox/autonomous-env.js';
import { autonomousConfinementProfile, buildSandboxLauncher } from '../src/core/sandbox/confine.js';
import type { AshlrConfig, EngineId } from '../src/core/types.js';

const posix = process.platform !== 'win32';

function cfg(over: Partial<AshlrConfig> = {}): AshlrConfig {
  return {
    version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [],
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://localhost:11434', providerChain: ['ollama'] },
    telemetry: {}, tools: {},
    foundry: { allowedBackends: ['devin-cli'], dispatchRetries: 0, fleetMcp: false },
    ...over,
  } as unknown as AshlrConfig;
}

describe.runIf(posix)('runEngineSandboxed with a fake `devin` on PATH', () => {
  const cleanup: string[] = [];
  let prevPath: string | undefined;
  let prevAllowAnyRepo: string | undefined;
  let prevAshlrHome: string | undefined;
  let stubDir: string;

  beforeEach(() => {
    // Exercise the historical promotional manual route before the host expiry.
    // Retain real elapsed time for the backstop/process-group timing assertions.
    const elapsedStart = performance.now();
    vi.spyOn(Date,'now').mockImplementation(() => Date.parse('2026-10-05T17:00:00Z') + performance.now() - elapsedStart);
    prevPath = process.env.PATH;
    prevAllowAnyRepo = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
    prevAshlrHome = process.env.ASHLR_HOME;
    process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
    const home = mkdtempSync(join(tmpdir(), 'ashlr-devin-cli-home-'));
    cleanup.push(home);
    process.env.ASHLR_HOME = join(home, '.ashlr');
    stubDir = mkdtempSync(join(tmpdir(), 'ashlr-devin-cli-stub-'));
    cleanup.push(stubDir);
    // A fake `devin`: records its argv (NUL-separated — a goal can hold
    // newlines) and its working directory, edits a file there, prints only a
    // final answer (like print mode) — including a usage-shaped line that
    // must NOT be priced.
    const argsFile = join(stubDir, 'argv');
    const cwdFile = join(stubDir, 'cwd');
    writeFileSync(join(stubDir, 'devin'), [
      '#!/bin/sh',
      `: > "${argsFile}"`,
      `for a in "$@"; do printf '%s\\0' "$a" >> "${argsFile}"; done`,
      `pwd -P > "${cwdFile}"`,
      'printf "export const fixed = true;\\n" > fixed.ts',
      'echo \'{"type":"result","usage":{"input_tokens":900000,"output_tokens":900000}}\'',
      'echo "Fixed the parser."',
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 });
    process.env.PATH = `${stubDir}${delimiter}${prevPath ?? ''}`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.PATH = prevPath;
    if (prevAllowAnyRepo === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
    else process.env.ASHLR_TEST_ALLOW_ANY_REPO = prevAllowAnyRepo;
    if (prevAshlrHome === undefined) delete process.env.ASHLR_HOME;
    else process.env.ASHLR_HOME = prevAshlrHome;
    while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
  });

  function sourceRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ashlr-devin-cli-src-'));
    cleanup.push(dir);
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), '# test\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'init', '--no-gpg-sign'], { cwd: dir });
    return dir;
  }

  // A fresh module instance (other suites doMock this module).
  async function freshSandboxedEngine(): Promise<typeof import('../src/core/run/sandboxed-engine.js')> {
    return await import('../src/core/run/sandboxed-engine.js?bust=' + randomUUID()) as typeof import('../src/core/run/sandboxed-engine.js');
  }

  function spawnedArgv(): string[] {
    const file = join(stubDir, 'argv');
    expect(existsSync(file)).toBe(true);
    return readFileSync(file, 'utf8').split('\0').slice(0, -1);
  }

  it('runs in the sandbox worktree with the exact argv, captures the edit, records devin-cli:swe-2-high at $0', async () => {
    const { runEngineSandboxed } = await freshSandboxedEngine();
    const repo = sourceRepo();
    const result = await runEngineSandboxed('devin-cli' as EngineId, 'Fix the parser edge case', cfg(), { sourceRepo: repo, propose: true });

    const argv = spawnedArgv();
    expect(argv.slice(0, 8)).toEqual(['-p', '--model', 'swe-2-high', '--permission-mode', 'smart', '--respect-workspace-trust', 'false', '--']);
    expect(argv).toHaveLength(9);
    expect(argv[8]).toContain('Fix the parser edge case');
    // The CLI worked in the sandbox worktree — never the source checkout.
    const cwd = readFileSync(join(stubDir, 'cwd'), 'utf8').trim();
    expect(cwd).not.toBe(realpathSync(repo));
    expect(existsSync(join(repo, 'fixed.ts'))).toBe(false);

    expect(result.state.engine).toBe('devin-cli');
    expect(result.state.engineModel).toBe('devin-cli:swe-2-high');
    expect(result.state.engineTier).toBe('mid');
    expect(result.state.usage.estCostUsd).toBe(0);
    expect(result.state.usage.tokensIn).toBe(0);
    expect(result.proposalId).toBeDefined();
    const { loadProposal } = await import('../src/core/inbox/store.js');
    const proposal = loadProposal(result.proposalId!);
    expect(proposal?.engineModel).toBe('devin-cli:swe-2-high');
    expect(proposal?.diff ?? '').toContain('fixed.ts');
  }, 60_000);

  it('a per-run model override reaches --model and the recorded identity; devin.fleetModel is the default', async () => {
    const { runEngineSandboxed } = await freshSandboxedEngine();
    const viaConfig = await runEngineSandboxed('devin-cli' as EngineId, 'g', cfg({ devin: { fleetModel: 'swe-2-max' } } as Partial<AshlrConfig>), {
      sourceRepo: sourceRepo(), propose: false,
    });
    expect(spawnedArgv().slice(1, 3)).toEqual(['--model', 'swe-2-max']);
    expect(viaConfig.state.engineModel).toBe('devin-cli:swe-2-max');

    const override = await runEngineSandboxed('devin-cli' as EngineId, 'g', cfg({ devin: { fleetModel: 'swe-2-max' } } as Partial<AshlrConfig>), {
      sourceRepo: sourceRepo(), propose: false, model: 'swe-2-medium',
    });
    expect(spawnedArgv().slice(1, 3)).toEqual(['--model', 'swe-2-medium']);
    expect(override.state.engineModel).toBe('devin-cli:swe-2-medium');
  }, 60_000);

  it('refuses a selected automatic native account with no issued evidence before contacting the fake CLI', async () => {
    const { runEngineSandboxed } = await freshSandboxedEngine();
    const conf = cfg();
    conf.foundry!.confinement = {'devin-cli':autonomousConfinementProfile('devin-cli')};
    const result = await runEngineSandboxed('devin-cli','must not contact',conf,{sourceRepo:sourceRepo(),selectedDevinAdmission:() => null});
    expect(result.state.status).toBe('failed');
    expect(result.proposalOutcome?.reason).toContain('unconfirmed');
    expect(existsSync(join(stubDir,'argv'))).toBe(false);
  },60_000);

  it('a hung CLI is killed at the backstop with its whole process group, and the run still returns', async () => {
    const pidFile = join(stubDir, 'grandchild.pid');
    writeFileSync(join(stubDir, 'devin'), [
      '#!/bin/sh',
      `sleep 60 & echo $! > "${pidFile}"`,
      'sleep 60',
      '',
    ].join('\n'), { mode: 0o755 });
    const cmd = buildEngineCommand('devin-cli' as EngineId, 'hang', cfg(), { cwd: stubDir, model: 'swe-2-high' })!;
    const started = Date.now();
    // runEngineSandboxed always hands spawnEngine its run's AbortSignal —
    // that is what makes the spawn own a detached process group.
    const owner = new AbortController();
    const res = await spawnEngine(cmd, cfg(), { timeoutMs: 400, signal: owner.signal, _terminationDrainMs: 3_000 });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(res.ok).toBe(false);
    expect({ reason: res.terminationReason, error: res.error }).toMatchObject({ reason: 'backstop-timeout' });
    const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
    expect(Number.isInteger(grandchild) && grandchild > 1).toBe(true);
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try {
        process.kill(grandchild, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// macOS: the autonomous profile, for real
// ---------------------------------------------------------------------------

function onPath(name: string): string | null {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    const candidate = join(dir, name);
    if (dir && existsSync(candidate)) {
      try { return realpathSync(candidate); } catch { /* next */ }
    }
  }
  return null;
}

describe.runIf(process.platform === 'darwin')('devin-cli under the real autonomous sandbox-exec profile', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devin-cli-confine-')));
  const home = join(root, 'home');
  const worktree = join(home, '.ashlr', 'sandboxes', 'sb1');
  const realCreds = join(home, '.local', 'share', 'devin', 'credentials.toml');
  const bin = join(root, 'bin');
  let runCounter = 0;

  function confined(argv: string[], executables: string[] = []): { status: number | null; signal: string | null; stdout: string; stderr: string } {
    const run = join(root, `run-${runCounter++}`);
    mkdirSync(run, { mode: 0o700 });
    const overlay = buildAutonomousEnvOverlay({
      engine: 'devin-cli', runTmpDir: run, home, seatId: null, executables, path: '/usr/bin:/bin', devinCredentialsPath: realCreds,
    });
    // Mason's real file changes AFTER the copy: a confined reader that
    // printed REAL-ONLY would have read the real file, not its copy.
    writeFileSync(realCreds, 'windsurf_api_key = "fake-test-key"\n# REAL-ONLY\n');
    const launcher = buildSandboxLauncher(autonomousConfinementProfile('devin-cli'), { worktree, home, overlay })!;
    const env = applyAutonomousEnvOverlay({ PATH: '/usr/bin:/bin', LANG: 'C' }, overlay);
    const r = spawnSync(launcher.bin, [...launcher.prefixArgs, ...argv], { cwd: worktree, env, encoding: 'utf8', timeout: 20_000 });
    writeFileSync(realCreds, 'windsurf_api_key = "fake-test-key"\n');
    return { status: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  mkdirSync(worktree, { recursive: true });
  mkdirSync(join(home, '.local', 'share', 'devin'), { recursive: true });
  writeFileSync(realCreds, 'windsurf_api_key = "fake-test-key"\n');
  mkdirSync(bin, { recursive: true });

  it('reads its per-run login copy, never the real file, and writes only the worktree', () => {
    const fake = join(bin, 'devin');
    writeFileSync(fake, [
      '#!/bin/sh',
      'cat "$XDG_DATA_HOME/devin/credentials.toml" && echo copy=ok',
      `cat "${realCreds}" 2>/dev/null; echo real=$?`,
      'echo edited > fixed.ts && echo worktree=ok',
      `echo planted > "${join(home, '.local', 'share', 'devin', 'planted')}" 2>/dev/null; echo plant=$?`,
      '',
    ].join('\n'), { mode: 0o755 });
    const r = confined([fake, '-p', '--', 'g'], [fake]);
    expect(r.stdout).toContain('copy=ok');
    expect(r.stdout).toContain('fake-test-key');
    expect(r.stdout).not.toContain('REAL-ONLY');
    expect(r.stdout).not.toContain('real=0');
    expect(r.stdout).toContain('worktree=ok');
    expect(readFileSync(join(worktree, 'fixed.ts'), 'utf8')).toBe('edited\n');
    expect(r.stdout).not.toContain('plant=0');
    expect(existsSync(join(home, '.local', 'share', 'devin', 'planted'))).toBe(false);
  }, 20_000);

  const devin = onPath('devin');
  it.runIf(devin !== null)('the real devin binary starts under the profile (--version: no login, no network)', () => {
    const r = confined([devin!, '--version'], [devin!]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/devin \d+/);
  }, 20_000);
});
