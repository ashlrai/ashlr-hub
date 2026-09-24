/**
 * V3.10 (INT5) — the Leader's paid transports reuse the judges' text-only
 * invocations (B-U7 cross-unit request to U8):
 *   - grok: buildGrokCliHeadlessCommand + extractGrokStreamText, in a private
 *     empty cwd that is removed afterwards; refused when the grok-cli seat is
 *     not the seat the router picked;
 *   - claude: restrictClaudeCommand + the judges' credential hook; a refused
 *     credential means nothing is spawned; the token only reaches a
 *     restricted command.
 * child_process and the grok seat resolution are mocked: nothing real is
 * spawned and no seat is prompted.
 */
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface SpawnCall { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; stdin: string; cwdExisted: boolean }

const h = vi.hoisted(() => ({
  calls: [] as SpawnCall[],
  stdout: '' as string,
  exitCode: 0 as number,
  grokCmd: null as null | ((prompt: string, cwd: string, model: string) => { bin: string; args: string[]; cwd: string } | null),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const fs = await import('node:fs');
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter; stderr: EventEmitter; stdin: { end(data: string): void }; kill(): void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => undefined;
      child.stdin = {
        end: (data: string) => {
          h.calls.push({ cmd, args, cwd: opts.cwd, env: opts.env, stdin: data, cwdExisted: fs.existsSync(opts.cwd) });
          setImmediate(() => {
            child.stdout.emit('data', Buffer.from(h.stdout));
            child.emit('close', h.exitCode);
          });
        },
      };
      return child;
    },
  };
});

vi.mock('../src/core/run/engine-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/run/engine-registry.js')>();
  return {
    ...actual,
    buildGrokCliHeadlessCommand: (prompt: string, _cfg: unknown, opts: { cwd: string; model?: string }) =>
      (h.grokCmd ? h.grokCmd(prompt, opts.cwd, opts.model ?? '') : null),
  };
});

import { defaultLeaderTransports, grokLeaderCommand, loadJudgeCredentialHook, type LeaderClaudeCredential } from '../src/core/vision/leader-seat.js';
import { isRestrictedClaudeCommand } from '../src/core/run/engine-registry.js';
import type { AshlrConfig } from '../src/core/types.js';

const CFG = {} as AshlrConfig;
const LAUNCHER = ['/profiles/grok/node', '/profiles/grok/launcher.mjs'];

function grokStream(text: string): string {
  return [
    'grok 0.2.118 starting',
    JSON.stringify({ type: 'message_start', message: { model: 'grok-4.7', usage: { input_tokens: 10 } } }),
    JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } }),
    JSON.stringify({ type: 'result', subtype: 'success', result: text }),
  ].join('\n');
}

beforeEach(() => {
  h.calls.length = 0;
  h.stdout = '';
  h.exitCode = 0;
  h.grokCmd = (prompt, cwd, model) => ({ bin: LAUNCHER[0]!, args: [LAUNCHER[1]!, '--cwd', cwd, '--model', model, `--single=${prompt}`], cwd });
});

afterEach(() => {
  vi.doUnmock('../src/core/fleet/manager.js');
  vi.resetModules();
});

describe('grok Leader transport', () => {
  it('runs the headless judge command in a private temp cwd, reads the stream text, then removes the cwd', async () => {
    h.stdout = grokStream('{"bottleneck":"x"}');
    const out = await defaultLeaderTransports(CFG).grok(LAUNCHER, 'grok-4.7')('SYS', 'USER');
    expect(out).toBe('{"bottleneck":"x"}');
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.cmd).toBe(LAUNCHER[0]);
    expect(call.args[0]).toBe(LAUNCHER[1]);
    expect(call.args).toContain('--single=SYS\n\nUSER');
    expect(call.args).toContain('grok-4.7');
    expect(call.cwdExisted).toBe(true);
    expect(call.args[call.args.indexOf('--cwd') + 1]).toBe(call.cwd);
    expect(existsSync(call.cwd)).toBe(false);
  });

  it('refuses when the grok-cli seat is not the seat the router picked, and spawns nothing', async () => {
    await expect(defaultLeaderTransports(CFG).grok(['/other/node', '/other/launcher.mjs'], 'grok-4.7')('S', 'U'))
      .rejects.toThrow(/not the grok seat the router picked/);
    h.grokCmd = () => null;
    await expect(defaultLeaderTransports(CFG).grok(LAUNCHER, 'grok-4.7')('S', 'U')).rejects.toThrow(/does not resolve/);
    expect(h.calls).toHaveLength(0);
  });

  it('a grok error or an empty answer is a failure, not an empty memo', async () => {
    h.stdout = JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'rate limited' });
    await expect(defaultLeaderTransports(CFG).grok(LAUNCHER, 'grok-4.7')('S', 'U')).rejects.toThrow(/grok/);
    h.stdout = 'no json at all';
    await expect(defaultLeaderTransports(CFG).grok(LAUNCHER, 'grok-4.7')('S', 'U')).rejects.toThrow(/no text/);
  });

  it('local-only mode refuses grok-cli at call time', async () => {
    const localOnly = { foundry: { localOnly: true } } as unknown as AshlrConfig;
    await expect(defaultLeaderTransports(localOnly).grok(LAUNCHER, 'grok-4.7')('S', 'U')).rejects.toThrow(/Local-only/);
    expect(h.calls).toHaveLength(0);
  });

  it('grokLeaderCommand requires an exact launcher match', () => {
    expect(grokLeaderCommand(LAUNCHER, 'm', 'S', 'U', CFG, '/tmp/x')).toMatchObject({ ok: true });
    expect(grokLeaderCommand([...LAUNCHER, 'extra'], 'm', 'S', 'U', CFG, '/tmp/x')).toMatchObject({ ok: false });
  });
});

describe('claude Leader transport', () => {
  const CLAUDE = ['/profiles/claude/node', '/profiles/claude/launcher.mjs'];

  it('spawns the restricted command with the credential env the hook returns; prompt on stdin', async () => {
    h.stdout = JSON.stringify({ result: '{"memo":1}' });
    const seen: string[][] = [];
    const credential: LeaderClaudeCredential = async (cmd) => {
      seen.push(cmd.args);
      expect(isRestrictedClaudeCommand(cmd)).toBe(true);
      return { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'tok-test' };
    };
    const out = await defaultLeaderTransports(CFG).claude(CLAUDE, 'claude-opus-5-5', credential)('SYS', 'USER');
    expect(out).toBe('{"memo":1}');
    expect(seen).toHaveLength(1);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.args).toEqual(seen[0]);
    expect(h.calls[0]!.stdin).toBe('USER');
    expect(h.calls[0]!.env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('tok-test');
  });

  it('no credential source registered ⇒ the default env (the seat launcher\'s own login)', async () => {
    h.stdout = JSON.stringify({ result: 'ok' });
    await defaultLeaderTransports(CFG).claude(CLAUDE, 'm', async () => undefined)('S', 'U');
    expect(h.calls[0]!.env).toBe(process.env);
  });

  it('a refused credential spawns nothing', async () => {
    await expect(defaultLeaderTransports(CFG).claude(CLAUDE, 'm', async () => 'refused')('S', 'U')).rejects.toThrow(/refused/);
    expect(h.calls).toHaveLength(0);
  });
});

describe('loadJudgeCredentialHook', () => {
  it('wraps manager.judgeCredentialEnv when the build exports it', async () => {
    const hook = vi.fn(async () => ({ CLAUDE_CODE_OAUTH_TOKEN: 't' }));
    vi.doMock('../src/core/fleet/manager.js', () => ({ judgeCredentialEnv: hook }));
    const { loadJudgeCredentialHook: load } = await import('../src/core/vision/leader-seat.js');
    const fn = await load(CFG);
    expect(fn).not.toBeNull();
    const cmd = { bin: 'node', args: ['x'] };
    await fn!(cmd);
    expect(hook).toHaveBeenCalledWith(cmd, CFG);
  });

  it('is null (Claude not a Leader candidate) when the hook is not exported', async () => {
    vi.doMock('../src/core/fleet/manager.js', () => ({ setJudgeCredentialSource: () => undefined }));
    const { loadJudgeCredentialHook: load } = await import('../src/core/vision/leader-seat.js');
    expect(await load(CFG)).toBeNull();
  });

  it('the unmocked module import never throws', async () => {
    const fn = await loadJudgeCredentialHook(CFG);
    expect(fn === null || typeof fn === 'function').toBe(true);
  });
});
