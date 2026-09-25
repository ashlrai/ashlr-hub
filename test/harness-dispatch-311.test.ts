/**
 * V3.11 — the adopted harness's effort / sampling reach the engine invocation
 * (closes the 3.10 known gap: harness experiments chose effort / sampling but
 * the fleet dispatched every engine at its compiled defaults).
 *
 * Covers, from the pure mapping outwards:
 *   1. harnessTuningFor / applyHarnessToEngineCommand — the per-engine flag
 *      mapping on the REAL registry argv (claude, codex, grok-cli), including
 *      the clamps and the "never duplicate an explicit flag" rule.
 *   2. harnessApiModelRequest — the local lane's request fields, and the
 *      llama-server template's fatal `high` withheld.
 *   3. buildOpenAICompatibleClient — top_p / reasoning_effort on the wire, and
 *      a byte-identical body without them.
 *   4. runEngineSandboxed — a fake `codex` on PATH records the argv it was
 *      spawned with: adopted harness ⇒ `-c model_reasoning_effort=…`;
 *      baseline ⇒ the compiled argv.
 *
 * runGoal's threading and the api-model producer live in
 * harness-dispatch-threading-311 / harness-dispatch-api-model-311 (they
 * doMock modules this file runs for real).
 *
 * Hermetic: no real CLI, no network, no paid model call. HOME is isolated by
 * test/setup/home.ts; ASHLR_HOME points into a temp dir per test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildEngineCommand } from '../src/core/run/engines.js';
import {
  applyHarnessToEngineCommand,
  describeHarnessApplication,
  harnessApiModelRequest,
  harnessLaneOf,
  harnessTuningFor,
  type DispatchHarness,
} from '../src/core/run/harness-dispatch.js';
import { buildOpenAICompatibleClient } from '../src/core/run/provider-client.js';
import type { AshlrConfig, EngineCommand, EngineId } from '../src/core/types.js';

const CFG = { foundry: {} } as unknown as AshlrConfig;

function harness(over: Partial<DispatchHarness> = {}): DispatchHarness {
  return { versionId: 'h-0007', effort: {}, sampling: {}, ...over };
}

function built(engine: string, model?: string): EngineCommand {
  const cmd = buildEngineCommand(engine as EngineId, 'fix the parser', CFG, { cwd: '/wt', ...(model ? { model } : {}), autonomous: true });
  if (!cmd) throw new Error(`no command for ${engine}`);
  return cmd;
}

// ---------------------------------------------------------------------------
// 1. CLI flag mapping
// ---------------------------------------------------------------------------

describe('harnessTuningFor — which lane entry applies', () => {
  it('maps registry engine ids to fleet lanes', () => {
    expect(harnessLaneOf('claude')).toBe('claude-cli');
    expect(harnessLaneOf('codex')).toBe('codex');
    expect(harnessLaneOf('grok-cli')).toBe('grok-cli');
    expect(harnessLaneOf('llama-server')).toBe('local');
    expect(harnessLaneOf('local-coder')).toBe('local');
    expect(harnessLaneOf('grok')).toBeNull();
    expect(harnessLaneOf('aw')).toBeNull();
  });

  it('is null (compiled defaults) with no harness, a baseline harness, or no entry for the lane', () => {
    expect(harnessTuningFor('codex', undefined)).toBeNull();
    expect(harnessTuningFor('codex', null)).toBeNull();
    expect(harnessTuningFor('codex', harness())).toBeNull();
    expect(harnessTuningFor('codex', harness({ effort: { 'claude-cli': 'high' } }))).toBeNull();
    expect(harnessTuningFor('codex', harness({ sampling: { codex: { temperature: null, topP: null, maxOutputTokens: null } } }))).toBeNull();
  });

  it('carries the lane\'s effort and sampling', () => {
    expect(harnessTuningFor('llama-server', harness({
      effort: { local: 'medium' },
      sampling: { local: { temperature: 0.2, topP: null, maxOutputTokens: 1024 } },
    }))).toEqual({ versionId: 'h-0007', lane: 'local', effort: 'medium', temperature: 0.2, topP: null, maxOutputTokens: 1024 });
  });
});

describe('applyHarnessToEngineCommand — engine-specific flags on the real registry argv', () => {
  it('leaves the command untouched (same object) with no tuning', () => {
    const cmd = built('claude');
    const out = applyHarnessToEngineCommand('claude', cmd, null);
    expect(out.cmd).toBe(cmd);
    expect(out.application).toEqual({ applied: [], withheld: [] });
  });

  it('claude: --effort <level>; sampling withheld (no CLI flag)', () => {
    const cmd = built('claude');
    const tuning = harnessTuningFor('claude', harness({
      effort: { 'claude-cli': 'xhigh' },
      sampling: { 'claude-cli': { temperature: 0.3, topP: null, maxOutputTokens: null } },
    }));
    const out = applyHarnessToEngineCommand('claude', cmd, tuning);
    expect(out.cmd.args).toEqual([...cmd.args, '--effort', 'xhigh']);
    expect(out.application.applied).toEqual(['effort=xhigh']);
    expect(out.application.withheld).toEqual(['temperature: claude has no sampling flag']);
    // The input command is never mutated.
    expect(cmd.args).not.toContain('--effort');
  });

  it('codex: -c model_reasoning_effort right after `exec`, the goal stays last', () => {
    const cmd = built('codex', 'gpt-5.5');
    const out = applyHarnessToEngineCommand('codex', cmd, harnessTuningFor('codex', harness({ effort: { codex: 'low' } })));
    expect(out.cmd.args.slice(0, 3)).toEqual(['exec', '-c', 'model_reasoning_effort="low"']);
    expect(out.cmd.args.slice(3)).toEqual(cmd.args.slice(1));
    expect(out.cmd.args.at(-1 - (cmd.args.length - 1 - cmd.args.indexOf('fix the parser')))).toBe('fix the parser');
  });

  it('codex: max runs at the model\'s ceiling — xhigh on gpt-5.4+, high otherwise', () => {
    const max = harness({ effort: { codex: 'max' } });
    const onNew = applyHarnessToEngineCommand('codex', built('codex', 'gpt-5.5'), harnessTuningFor('codex', max));
    expect(onNew.cmd.args).toContain('model_reasoning_effort="xhigh"');
    expect(onNew.application.applied).toEqual(['effort=xhigh (requested max)']);
    const onOld = applyHarnessToEngineCommand('codex', built('codex', 'gpt-5.1'), harnessTuningFor('codex', harness({ effort: { codex: 'xhigh' } })));
    expect(onOld.cmd.args).toContain('model_reasoning_effort="high"');
  });

  it('codex: an explicit model_reasoning_effort outranks the harness', () => {
    const base = built('codex', 'gpt-5.5');
    const cmd = { ...base, args: ['exec', '-c', 'model_reasoning_effort="minimal"', ...base.args.slice(1)] };
    const out = applyHarnessToEngineCommand('codex', cmd, harnessTuningFor('codex', harness({ effort: { codex: 'high' } })));
    expect(out.cmd).toBe(cmd);
    expect(out.application.withheld).toEqual(['effort: the command already sets model_reasoning_effort']);
  });

  it('grok-cli: --reasoning-effort=<level>, xhigh / max clamp to high', () => {
    // The registry's grok-cli argv needs a resolved seat; the template alone is what matters here.
    const cmd: EngineCommand = { bin: 'grok', args: ['--no-auto-update', '--cwd', '/wt', '--permission-mode', 'dontAsk', '--single=fix the parser'], cwd: '/wt' };
    const medium = applyHarnessToEngineCommand('grok-cli', cmd, harnessTuningFor('grok-cli', harness({ effort: { 'grok-cli': 'medium' } })));
    expect(medium.cmd.args).toEqual([...cmd.args, '--reasoning-effort=medium']);
    const max = applyHarnessToEngineCommand('grok-cli', cmd, harnessTuningFor('grok-cli', harness({ effort: { 'grok-cli': 'max' } })));
    expect(max.cmd.args.at(-1)).toBe('--reasoning-effort=high');
    expect(max.application.applied).toEqual(['effort=high (requested max)']);
  });

  it('only the dispatched engine\'s lane applies', () => {
    const cmd = built('claude');
    const out = applyHarnessToEngineCommand('claude', cmd, harnessTuningFor('claude', harness({ effort: { codex: 'high', local: 'low' } })));
    expect(out.cmd).toBe(cmd);
  });

  it('describes what ran for the run log', () => {
    const tuning = harnessTuningFor('claude', harness({
      effort: { 'claude-cli': 'high' },
      sampling: { 'claude-cli': { temperature: 0.1, topP: null, maxOutputTokens: null } },
    }));
    const { application } = applyHarnessToEngineCommand('claude', built('claude'), tuning);
    expect(describeHarnessApplication('claude', tuning, application))
      .toBe('harness h-0007 on claude: applied effort=high; withheld temperature: claude has no sampling flag');
    expect(describeHarnessApplication('claude', null, { applied: [], withheld: [] })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. api-model request fields
// ---------------------------------------------------------------------------

describe('harnessApiModelRequest — the local lane', () => {
  it('llama-server: effort as reasoning_effort, sampling as request fields', () => {
    const out = harnessApiModelRequest('llama-server', harnessTuningFor('llama-server', harness({
      effort: { local: 'low' },
      sampling: { local: { temperature: 0.2, topP: 0.9, maxOutputTokens: 1024 } },
    })));
    expect(out.request).toEqual({ reasoningEffort: 'low', temperature: 0.2, topP: 0.9, maxOutputTokens: 1024 });
    expect(out.application.withheld).toEqual([]);
  });

  it('llama-server: max runs at xhigh; high is withheld (the template raises on it before inference)', () => {
    expect(harnessApiModelRequest('llama-server', harnessTuningFor('llama-server', harness({ effort: { local: 'max' } }))).request)
      .toEqual({ reasoningEffort: 'xhigh' });
    const high = harnessApiModelRequest('llama-server', harnessTuningFor('llama-server', harness({ effort: { local: 'high' } })));
    expect(high.request).toEqual({});
    expect(high.application.withheld[0]).toMatch(/rejects "high"/);
  });

  it('local-coder: sampling applies, effort is withheld (no verified carrier)', () => {
    const out = harnessApiModelRequest('local-coder', harnessTuningFor('local-coder', harness({
      effort: { local: 'medium' },
      sampling: { local: { temperature: 0.4, topP: null, maxOutputTokens: null } },
    })));
    expect(out.request).toEqual({ temperature: 0.4 });
    expect(out.application.withheld).toEqual(['effort: local-coder has no verified effort carrier']);
  });

  it('no tuning ⇒ no fields', () => {
    expect(harnessApiModelRequest('llama-server', null)).toEqual({ request: {}, application: { applied: [], withheld: [] } });
  });
});

// ---------------------------------------------------------------------------
// 3. The wire
// ---------------------------------------------------------------------------

describe('buildOpenAICompatibleClient — harness request fields on the wire', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function bodyOf(temperature: number | undefined, transport: Parameters<typeof buildOpenAICompatibleClient>[6]): Promise<Record<string, unknown>> {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const client = buildOpenAICompatibleClient('http://127.0.0.1:8080/v1', '', 'qwen', false, temperature, undefined, transport);
    await client.chat([{ role: 'user', content: 'hi' }], undefined, undefined, { maxOutputTokens: 512 });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  }

  it('sends temperature, top_p and reasoning_effort when the harness sets them', async () => {
    const body = await bodyOf(0.2, { topP: 0.9, reasoningEffort: 'medium' });
    expect(body).toMatchObject({ temperature: 0.2, top_p: 0.9, reasoning_effort: 'medium', max_tokens: 512 });
  });

  it('sends none of them otherwise (compiled defaults)', async () => {
    const body = await bodyOf(undefined, {});
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'stream']);
  });
});

// ---------------------------------------------------------------------------
// 4. runEngineSandboxed — the argv a real spawn receives
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')('runEngineSandboxed spawns codex with the harness effort', () => {
  const cleanup: string[] = [];
  let prevPath: string | undefined;
  let prevAllowAnyRepo: string | undefined;
  let prevAshlrHome: string | undefined;
  let argsFile: string;

  beforeEach(() => {
    prevPath = process.env.PATH;
    prevAllowAnyRepo = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
    prevAshlrHome = process.env.ASHLR_HOME;
    process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
    const home = mkdtempSync(join(tmpdir(), 'ashlr-h311-home-'));
    cleanup.push(home);
    process.env.ASHLR_HOME = join(home, '.ashlr');
    // A fake `codex` that records its argv NUL-separated (a goal can hold newlines).
    const stubDir = mkdtempSync(join(tmpdir(), 'ashlr-h311-stub-'));
    cleanup.push(stubDir);
    argsFile = join(stubDir, 'argv');
    writeFileSync(join(stubDir, 'codex'), `#!/bin/sh\n: > "${argsFile}"\nfor a in "$@"; do printf '%s\\0' "$a" >> "${argsFile}"; done\nprintf 'done'\nexit 0\n`, { mode: 0o755 });
    process.env.PATH = `${stubDir}:${prevPath ?? ''}`;
  });

  afterEach(() => {
    process.env.PATH = prevPath;
    if (prevAllowAnyRepo === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
    else process.env.ASHLR_TEST_ALLOW_ANY_REPO = prevAllowAnyRepo;
    if (prevAshlrHome === undefined) delete process.env.ASHLR_HOME;
    else process.env.ASHLR_HOME = prevAshlrHome;
    while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
  });

  function sourceRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ashlr-h311-src-'));
    cleanup.push(dir);
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), '# test\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'init', '--no-gpg-sign'], { cwd: dir });
    return dir;
  }

  function cfg(): AshlrConfig {
    return {
      version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [],
      models: { lmstudio: 'http://localhost:1234', ollama: 'http://localhost:11434', providerChain: ['ollama'] },
      telemetry: {}, tools: {}, foundry: { allowedBackends: ['codex'], dispatchRetries: 0 },
    } as unknown as AshlrConfig;
  }

  // A fresh module instance: the runGoal suite above doMocks this module, and
  // a cache-busted id can never resolve to that double.
  async function freshSandboxedEngine(): Promise<typeof import('../src/core/run/sandboxed-engine.js')> {
    return await import('../src/core/run/sandboxed-engine.js?bust=' + randomUUID()) as typeof import('../src/core/run/sandboxed-engine.js');
  }

  function spawnedArgv(): string[] {
    expect(existsSync(argsFile)).toBe(true);
    return readFileSync(argsFile, 'utf8').split('\0').slice(0, -1);
  }

  it('adopted harness ⇒ -c model_reasoning_effort in the spawned argv', async () => {
    const { runEngineSandboxed } = await freshSandboxedEngine();
    await runEngineSandboxed('codex', 'Write hello world', cfg(), {
      sourceRepo: sourceRepo(), propose: false, model: 'gpt-5.5', harness: harness({ effort: { codex: 'high' } }),
    });
    const argv = spawnedArgv();
    expect(argv.slice(0, 3)).toEqual(['exec', '-c', 'model_reasoning_effort="high"']);
  });

  it('no harness ⇒ the compiled argv, no effort override', async () => {
    const { runEngineSandboxed } = await freshSandboxedEngine();
    await runEngineSandboxed('codex', 'Write hello world', cfg(), { sourceRepo: sourceRepo(), propose: false, model: 'gpt-5.5' });
    const argv = spawnedArgv();
    expect(argv[0]).toBe('exec');
    expect(argv.some((a) => a.startsWith('model_reasoning_effort'))).toBe(false);
  });
});

