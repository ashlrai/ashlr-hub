/**
 * M45 Foundry tests — the multi-backend sandboxed-engine keystone.
 *
 * Hermetic + deterministic: NO real claude/codex spawn, NO network. The only
 * subprocess used is local `git` (in tmp repos under os.tmpdir()) to PROVE the
 * pre-push containment mechanism that buildContainedEnv relies on.
 *
 * Covers:
 *   1. Engine argv (pure): exact codex argv (±model) + claude autonomous flags.
 *   2. engineTierOf classification (frontier vs local).
 *   3. buildContainedEnv (pure): no credential-shaped keys, git push channels
 *      severed, per-invocation core.hooksPath wired, HOME preserved.
 *   4. ADVERSARIAL: a pre-push hook installed via GIT_CONFIG_* env BLOCKS a real
 *      `git push` — the security proof. Control: same push without the env wins.
 *   5. runEngineSandboxed with an absent/failing binary: never throws, returns a
 *      well-formed frontier RunState, and leaves NO leftover sandbox worktree.
 *
 * GUARDRAIL: NO real delegated agent is ever spawned. Test 5 shadows `codex`
 * with a fast-failing PATH stub, so even on a dev box where codex is installed
 * the run fails immediately offline — the sandbox create -> spawn -> fail ->
 * cleanup path is exercised without any network/auth/model dependency.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';

import {
  buildEngineCommand,
  engineInstalled,
} from '../src/core/run/engines.js';
import {
  runEngineSandboxed,
  buildContainedEnv,
  engineTierOf,
} from '../src/core/run/sandboxed-engine.js';
import { listSandboxes } from '../src/core/sandbox/worktree.js';
import { withTmpHome } from './helpers/h1-fixture.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(over: Partial<AshlrConfig> = {}): AshlrConfig {
  return {
    version: 1,
    roots: ['/home/u/Desktop/github'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['ollama'],
    },
    telemetry: {},
    tools: {},
    ...over,
  } as AshlrConfig;
}

const GOAL = 'Write a hello world program';
const MODEL = 'gpt-5-codex';
const CWD = '/home/u/project';

/** Credential-shaped env key pattern that must NEVER reach the contained env. */
const CRED_KEY_RE = /_(TOKEN|SECRET|KEY|PASSWORD)$/i;

// Track tmp dirs created at the file level so afterEach can sweep them.
const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    timeout: 30_000,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* idempotent cleanup */
    }
  }
});

// ===========================================================================
// 1. Engine argv — PURE, no spawn
// ===========================================================================

describe('M45 engine argv — codex', () => {
  it('bin is "codex"', () => {
    const cmd = buildEngineCommand('codex', GOAL, makeConfig(), { cwd: CWD, model: MODEL });
    expect(cmd).not.toBeNull();
    expect(cmd!.bin).toBe('codex');
  });

  it('produces EXACT argv with a model', () => {
    const cmd = buildEngineCommand('codex', GOAL, makeConfig(), { cwd: CWD, model: MODEL });
    expect(cmd!.args).toEqual([
      'exec',
      '--model',
      MODEL,
      '--sandbox',
      'workspace-write',
      '--cd',
      CWD,
      '--json',
      GOAL,
    ]);
  });

  it('omits --model when no model is provided', () => {
    const cmd = buildEngineCommand('codex', GOAL, makeConfig(), { cwd: CWD });
    expect(cmd!.args).not.toContain('--model');
    expect(cmd!.args).toEqual([
      'exec',
      '--sandbox',
      'workspace-write',
      '--cd',
      CWD,
      '--json',
      GOAL,
    ]);
  });

  it('omits --model when model is empty string', () => {
    const cmd = buildEngineCommand('codex', GOAL, makeConfig(), { cwd: CWD, model: '' });
    expect(cmd!.args).not.toContain('--model');
  });

  it('threads cwd into both --cd and the EngineCommand.cwd', () => {
    const cmd = buildEngineCommand('codex', GOAL, makeConfig(), { cwd: CWD });
    expect(cmd!.cwd).toBe(CWD);
    const idx = cmd!.args.indexOf('--cd');
    expect(cmd!.args[idx + 1]).toBe(CWD);
  });
});

describe('M45 engine argv — claude autonomous', () => {
  it('appends --permission-mode acceptEdits + --add-dir <cwd> when autonomous:true', () => {
    const cmd = buildEngineCommand('claude', GOAL, makeConfig(), {
      cwd: CWD,
      model: MODEL,
      autonomous: true,
    });
    expect(cmd!.args).toEqual([
      '-p',
      GOAL,
      '--model',
      MODEL,
      '--output-format',
      'json',
      '--permission-mode',
      'acceptEdits',
      '--add-dir',
      CWD,
    ]);
  });

  it('autonomous flags work even without a model', () => {
    const cmd = buildEngineCommand('claude', GOAL, makeConfig(), {
      cwd: CWD,
      autonomous: true,
    });
    expect(cmd!.args).toEqual([
      '-p',
      GOAL,
      '--output-format',
      'json',
      '--permission-mode',
      'acceptEdits',
      '--add-dir',
      CWD,
    ]);
  });

  it('does NOT include --permission-mode / --add-dir when autonomous is absent', () => {
    const cmd = buildEngineCommand('claude', GOAL, makeConfig(), { cwd: CWD, model: MODEL });
    expect(cmd!.args).not.toContain('--permission-mode');
    expect(cmd!.args).not.toContain('--add-dir');
    expect(cmd!.args).toEqual(['-p', GOAL, '--model', MODEL, '--output-format', 'json']);
  });

  it('does NOT include autonomous flags when autonomous:false', () => {
    const cmd = buildEngineCommand('claude', GOAL, makeConfig(), {
      cwd: CWD,
      model: MODEL,
      autonomous: false,
    });
    expect(cmd!.args).not.toContain('--permission-mode');
    expect(cmd!.args).not.toContain('--add-dir');
  });
});

describe('M45 engineInstalled — codex', () => {
  it('does not throw and returns a boolean for codex', () => {
    let result: boolean | undefined;
    expect(() => {
      result = engineInstalled('codex');
    }).not.toThrow();
    expect(typeof result).toBe('boolean');
  });
});

// ===========================================================================
// 2. engineTierOf
// ===========================================================================

describe('M45 engineTierOf', () => {
  it('claude -> frontier', () => {
    expect(engineTierOf('claude')).toBe('frontier');
  });
  it('codex -> frontier', () => {
    expect(engineTierOf('codex')).toBe('frontier');
  });
  it('builtin -> local', () => {
    expect(engineTierOf('builtin')).toBe('local');
  });
  it('aw -> local', () => {
    expect(engineTierOf('aw')).toBe('local');
  });
});

// ===========================================================================
// 3. buildContainedEnv — PURE
// ===========================================================================

describe('M45 buildContainedEnv', () => {
  let prevFakeApiKey: string | undefined;
  let prevGhToken: string | undefined;

  beforeEach(() => {
    prevFakeApiKey = process.env.FAKE_API_KEY;
    prevGhToken = process.env.GH_TOKEN;
    process.env.FAKE_API_KEY = 'x';
    process.env.GH_TOKEN = 'y';
  });

  afterEach(() => {
    if (prevFakeApiKey === undefined) delete process.env.FAKE_API_KEY;
    else process.env.FAKE_API_KEY = prevFakeApiKey;
    if (prevGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prevGhToken;
  });

  it('contains NO credential-shaped key (the secrets we injected are absent)', () => {
    const hooksDir = '/tmp/ashlr-hooks-xyz';
    const env = buildContainedEnv(makeConfig(), hooksDir);

    expect(env.FAKE_API_KEY).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();

    const leaked = Object.keys(env).filter((k) => CRED_KEY_RE.test(k));
    expect(leaked).toEqual([]);
  });

  it('severs git push channels (GIT_TERMINAL_PROMPT=0, SSH_AUTH_SOCK undefined)', () => {
    const env = buildContainedEnv(makeConfig(), '/tmp/ashlr-hooks-xyz');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
  });

  it('wires a per-invocation core.hooksPath via GIT_CONFIG_* env', () => {
    const hooksDir = '/tmp/ashlr-hooks-proof';
    const env = buildContainedEnv(makeConfig(), hooksDir);
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('core.hooksPath');
    expect(env.GIT_CONFIG_VALUE_0).toBe(hooksDir);
  });

  it('preserves the real HOME (the agent needs its own vendor session)', () => {
    const env = buildContainedEnv(makeConfig(), '/tmp/ashlr-hooks-xyz');
    expect(env.HOME).toBe(process.env.HOME);
  });
});

// ===========================================================================
// 4. ADVERSARIAL — pre-push hook (via GIT_CONFIG_* env) BLOCKS a real push.
//    This proves the containment mechanism buildContainedEnv relies on.
// ===========================================================================

describe('M45 containment proof — pre-push hook blocks `git push`', () => {
  function makeRepoWithOrigin(): { repo: string; bare: string } {
    const repo = mkTmp('ashlr-m45-repo-');
    const bare = mkTmp('ashlr-m45-bare-');

    // A bare repo to act as `origin`.
    git(bare, ['init', '--bare', '--initial-branch=main', '.']);

    // A working repo with one commit.
    git(repo, ['init', '--initial-branch=main', '.']);
    git(repo, ['config', 'user.email', 'm45@ashlr.test']);
    git(repo, ['config', 'user.name', 'Ashlr M45 Test']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(repo, 'file.txt'), 'hello\n', 'utf8');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '--no-verify', '-m', 'init']);
    git(repo, ['remote', 'add', 'origin', `file://${bare}`]);

    return { repo, bare };
  }

  function makeBlockingHooksDir(): string {
    const hooksDir = mkTmp('ashlr-m45-hooks-');
    writeFileSync(join(hooksDir, 'pre-push'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    return hooksDir;
  }

  const baseEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
  };

  it('push is BLOCKED when core.hooksPath points at a failing pre-push hook', () => {
    const { repo } = makeRepoWithOrigin();
    const hooksDir = makeBlockingHooksDir();

    expect(() => {
      execFileSync('git', ['push', 'origin', 'HEAD'], {
        cwd: repo,
        stdio: 'pipe',
        timeout: 30_000,
        env: {
          ...baseEnv,
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'core.hooksPath',
          GIT_CONFIG_VALUE_0: hooksDir,
        },
      });
    }).toThrow();
  });

  it('CONTROL: the same push SUCCEEDS without the hooks-path env', () => {
    const { repo, bare } = makeRepoWithOrigin();

    expect(() => {
      execFileSync('git', ['push', 'origin', 'HEAD'], {
        cwd: repo,
        stdio: 'pipe',
        timeout: 30_000,
        env: { ...baseEnv, GIT_TERMINAL_PROMPT: '0' },
      });
    }).not.toThrow();

    // The bare origin now has a main branch (the push landed).
    const refs = git(bare, ['for-each-ref', '--format=%(refname:short)']);
    expect(refs).toContain('main');
  });
});

// ===========================================================================
// 5. runEngineSandboxed with an absent/failing binary — hermetic.
//    Never throws; returns a well-formed frontier RunState; leaves no leftover
//    sandbox worktree.
// ===========================================================================

describe('M45 runEngineSandboxed — absent/failing engine is contained', () => {
  it('never throws, returns a frontier RunState, and leaves no sandbox behind', async () => {
    await withTmpHome(async (fx) => {
      const prevAllow = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
      const prevPath = process.env.PATH;
      process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';

      // HERMETIC: shadow `codex` with a fast-failing stub so the run NEVER spawns
      // the real (network/auth-dependent, slow) engine even on a dev box where
      // codex is installed. buildContainedEnv derives the child PATH from
      // process.env.PATH, so prepending this stub dir guarantees our `codex`
      // wins. The real sandbox create -> spawn -> fail -> cleanup path still runs.
      const stubBin = mkTmp('ashlr-m45-stub-bin-');
      writeFileSync(
        join(stubBin, 'codex'),
        '#!/bin/sh\necho "stub codex: not available" >&2\nexit 127\n',
        { mode: 0o755 },
      );
      process.env.PATH = `${stubBin}:${prevPath ?? ''}`;

      try {
        const repo = fx.makeRepo();
        // runEngineSandboxed -> createSandbox(sourceRepo) does NOT forward
        // allowAnyRepo, so enroll the disposable repo (in the isolated HOME) to
        // let the REAL worktree be created — and then proven removed afterward.
        // ASHLR_TEST_ALLOW_ANY_REPO is also set as a belt-and-suspenders seam.
        repo.enroll();
        const before = listSandboxes().length;

        let result: Awaited<ReturnType<typeof runEngineSandboxed>> | undefined;
        let threw = false;
        try {
          result = await runEngineSandboxed('codex', 'do nothing', makeConfig(), {
            sourceRepo: repo.dir,
            propose: true,
          });
        } catch {
          threw = true;
        }

        // CONTRACT: runEngineSandboxed NEVER throws.
        expect(threw).toBe(false);
        expect(result).toBeDefined();

        const state = result!.state;
        expect(state.engine).toBe('codex');
        expect(state.engineModel.startsWith('codex:')).toBe(true);
        expect(state.engineTier).toBe('frontier');
        // codex isn't runnable here -> the run fails (or, if the sandbox couldn't
        // even be created, also fails). Either way it's a terminal non-'done'... or
        // 'done' with an empty output if codex happened to be a no-op. We assert
        // the status is one of the legitimate terminal states, not 'running'.
        // The stubbed codex exits 127 -> the run is a terminal 'failed' (never
        // 'running'). We accept 'done' too in case a real no-op engine slips in.
        expect(['failed', 'done']).toContain(state.status);

        // No leftover sandbox worktree: the count is unchanged (created-here
        // worktrees are removed in the finally block).
        const after = listSandboxes().length;
        expect(after).toBe(before);
      } finally {
        if (prevAllow === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
        else process.env.ASHLR_TEST_ALLOW_ANY_REPO = prevAllow;
        if (prevPath === undefined) delete process.env.PATH;
        else process.env.PATH = prevPath;
      }
    });
  });
});
