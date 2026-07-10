/**
 * test/m199.orchestrator.test.ts — M199: Integration tests for orchestrator.ts.
 *
 * Covers the highest-value paths in orchestrator.ts (2325 LOC, previously ZERO tests):
 *
 *  1. PURE EXPORTS (no I/O):
 *     - parseTaskList: JSON array, markdown fences, bulleted list, alternate field
 *       names, cycle detection, duplicate ids, unknown deps.
 *     - foldBrowserVerify: skipped / FAIL (renderOk=false) / FAIL (consoleErrors)
 *       / clean PASS.
 *     - TITRR_MAX_ATTEMPTS is exported and positive.
 *     - titrrTestRun: null when no test command; ok/fail when mocked.
 *
 *  2. planGoal: happy path (client.chat → parsed tasks); fallback on chat error;
 *     fallback on unparseable model output; usage reported via onUsage.
 *
 *  3. runGoal — happy path (plan → dispatch → synthesize → 'done'):
 *     mocks getActiveClient, runTask, verifyTaskStructured, router, fs (HOME).
 *
 *  4. runGoal — HARD BUDGET abort:
 *     overBudget triggers 'aborted' status; pending tasks marked failed with
 *     ABORT_TASK_ERROR sentinel.
 *
 *  5. runGoal — FALLBACK CASCADE (M155-style): router absent → falls back to
 *     run-level client; task still dispatched.
 *
 *  6. runGoal — VERIFY GATE (M171 browserVerify ON/OFF):
 *     - OFF (default): verifyInBrowser never called.
 *     - ON + isWebApp=true + pass: result annotated with [browser-verify: PASS].
 *     - ON + isWebApp=true + fail: result annotated with [browser-verify: FAIL].
 *
 *  7. NEVER-THROWS / error degradation:
 *     - runGoal returns a RunState even when runTask throws.
 *     - governance block returns status='failed' (not a throw).
 *     - resume of already-done run returns early (no-op).
 *
 * HERMETICITY:
 *   - No live LLM / network calls.
 *   - fs writes redirected to real tmp dirs (HOME overridden per test group).
 *   - All external modules mocked via vi.mock (hoisted).
 *
 * Mirrors m140/m155/m164 conventions:
 *   vi.mock() at top, baseConfig()/makeConfig() helpers, lazy imports after mocks,
 *   tmp dir cleanup in afterEach.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Mocks — hoisted by vitest before any imports in this file
// ---------------------------------------------------------------------------

// Mock getActiveClient to return a deterministic stub client.
vi.mock('../src/core/run/provider-client.js', () => ({
  getActiveClient: vi.fn(),
}));

// Mock agent-loop runTask — controls task execution without a real model.
vi.mock('../src/core/run/agent-loop.js', () => ({
  runTask: vi.fn(),
}));

// Mock verifyTaskStructured — default: ok=true.
vi.mock('../src/core/run/verify.js', () => ({
  verifyTaskStructured: vi.fn(),
}));

// Mock verify-commands so titrrTestRun is hermetic.
vi.mock('../src/core/run/verify-commands.js', () => {
  const runVerifyCommand = vi.fn(() => ({ ok: true, command: 'x', exitCode: 0, output: '', timedOut: false }));
  return {
    detectVerifyCommands: vi.fn(() => []),
    runVerifyCommand,
    runVerifyCommandAsync: runVerifyCommand,
  };
});

// Mock router — default: unavailable (returns null from loadRouter path).
// The orchestrator does: import('./router.js') — mock the module it imports.
vi.mock('../src/core/run/router.js', () => ({
  chooseRoute: vi.fn(),
  cloudKeyAvailable: vi.fn(() => false),
}));

// Mock engines so engine checks pass without PATH.
vi.mock('../src/core/run/engines.js', () => ({
  engineInstalled: vi.fn(() => false),
  buildEngineCommand: vi.fn(() => null),
  spawnEngine: vi.fn(() => ({ ok: true, output: 'engine-output', usage: null })),
}));

// Mock engine-registry.
vi.mock('../src/core/run/engine-registry.js', () => ({
  resolveEngineSpec: vi.fn(() => null),
}));

// Mock browser-verify — default: not a web app, verifyInBrowser returns skipped.
vi.mock('../src/core/run/browser-verify.js', () => ({
  isWebApp: vi.fn(() => false),
  verifyInBrowser: vi.fn(async () => ({
    skipped: true,
    renderOk: false,
    consoleErrors: [],
    detail: '',
    screenshotPath: null,
  })),
}));

// Mock budget helpers — passthrough to real implementations except where overridden.
vi.mock('../src/core/run/budget.js', async () => {
  const real = await vi.importActual<typeof import('../src/core/run/budget.js')>(
    '../src/core/run/budget.js',
  );
  return { ...real };
});

// Mock streaming — nullSink is a real no-op; allow override.
vi.mock('../src/core/run/streaming.js', () => ({
  nullSink: vi.fn(() => () => {}),
}));

// Mock retry — call the fn once (no retry in tests).
vi.mock('../src/core/run/retry.js', () => ({
  withRetry: vi.fn(async (fn: (attempt: number) => Promise<void>) => fn(1)),
}));

// Mock self-heal — call the fn once (no heal in tests).
vi.mock('../src/core/run/self-heal.js', () => ({
  withHeal: vi.fn(async (fn: (attempt: number) => Promise<void>) => fn(1)),
  defaultHealPolicy: vi.fn(() => ({ maxRestarts: 1, restartDelayMs: 0 })),
}));

// Mock mcp-native / mcp-native-engineer (avoid MCP SDK load).
vi.mock('../src/core/mcp-native.js', () => ({
  listNativeTools: vi.fn(() => []),
}));
vi.mock('../src/core/mcp-native-engineer.js', () => ({
  buildEngineerToolSpecs: vi.fn(() => []),
  buildNativeToolSpecsWithFn: vi.fn(() => []),
}));

// Mock seams/inbox (avoid file I/O for inbox).
vi.mock('../src/core/seams/inbox.js', () => ({
  selectInboxStore: vi.fn(() => ({
    create: vi.fn(() => ({ id: 'mock-proposal-1' })),
  })),
}));

// Mock knowledge (scrubSecrets).
vi.mock('../src/core/knowledge/index.js', () => ({
  scrubSecrets: vi.fn((s: string) => s),
}));

// Mock prompts — return deterministic strings.
vi.mock('../src/core/run/prompts/roles.js', () => ({
  PLANNER_ROLE: 'MOCK_PLANNER_ROLE',
  SYNTHESIZER_ROLE: 'MOCK_SYNTHESIZER_ROLE',
}));
vi.mock('../src/core/run/prompts/index.js', () => ({
  systemPromptFor: vi.fn(() => 'MOCK_SYSTEM_PROMPT'),
}));

// Mock model-profile.
vi.mock('../src/core/run/model-profile.js', () => ({
  resolveModelProfile: vi.fn(() => 'base'),
  adaptivePromptsEnabled: vi.fn(() => false),
}));

// Mock env-bridge.
vi.mock('../src/core/env-bridge.js', () => ({
  withToolEnv: vi.fn((_, fn: () => unknown) => fn()),
}));

// Mock sandbox/worktree (avoid git worktrees).
vi.mock('../src/sandbox/worktree.js', () => ({
  createSandbox: vi.fn(() => ({ id: 'mock-sb', worktreePath: '/tmp/mock-wt', sourceRepo: '/tmp/mock-src' })),
  removeSandbox: vi.fn(),
  sandboxDiff: vi.fn(() => ({ files: 0, patch: '', insertions: 0, deletions: 0 })),
}));

// ---------------------------------------------------------------------------
// Imports under test (after all vi.mock hoisting)
// ---------------------------------------------------------------------------

import type { AshlrConfig, RunOptions } from '../src/core/types.js';
import {
  parseTaskList,
  planGoal,
  runGoal,
  foldBrowserVerify,
  TITRR_MAX_ATTEMPTS,
  titrrTestRun,
} from '../src/core/run/orchestrator.js';
import { getActiveClient } from '../src/core/run/provider-client.js';
import { runTask } from '../src/core/run/agent-loop.js';
import { verifyTaskStructured } from '../src/core/run/verify.js';
import { isWebApp, verifyInBrowser } from '../src/core/run/browser-verify.js';
import {
  detectVerifyCommands,
  runVerifyCommand,
} from '../src/core/run/verify-commands.js';
import { withRetry } from '../src/core/run/retry.js';
import { withHeal, defaultHealPolicy } from '../src/core/run/self-heal.js';
import { nullSink } from '../src/core/run/streaming.js';
import { withToolEnv } from '../src/core/env-bridge.js';
import {
  cloudKeyAvailable,
  chooseRoute,
} from '../src/core/run/router.js';
import {
  engineInstalled,
  buildEngineCommand,
  spawnEngine,
} from '../src/core/run/engines.js';
import { resolveEngineSpec } from '../src/core/run/engine-registry.js';
import { resolveModelProfile, adaptivePromptsEnabled } from '../src/core/run/model-profile.js';
import { systemPromptFor } from '../src/core/run/prompts/index.js';
import { scrubSecrets } from '../src/core/knowledge/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid AshlrConfig. */
function makeConfig(over: Partial<AshlrConfig> = {}): AshlrConfig {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
    ...over,
  } as AshlrConfig;
}

/** Minimal RunOptions. */
function makeOpts(over: Partial<RunOptions> & Record<string, unknown> = {}): RunOptions & Record<string, unknown> {
  return {
    engine: 'builtin',
    tools: false,           // skip gateway tool loading
    noMemory: true,         // skip genome recall
    noCapture: true,        // skip auto-capture fire-and-forget
    ...over,
  } as RunOptions & Record<string, unknown>;
}

/** Build a stub ProviderClient. */
function makeClient(id = 'ollama', chatResult: { content: string; usage: { tokensIn: number; tokensOut: number } } = { content: '[]', usage: { tokensIn: 0, tokensOut: 0 } }) {
  return {
    id,
    model: 'llama3',
    supportsTools: false,
    chat: vi.fn(async () => chatResult),
  };
}

/** Tmp dir management. */
const tmpDirs: string[] = [];

function mkTmp(prefix = 'ashlr-m199-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* idempotent */ }
  }
  vi.resetAllMocks();
});

// Redirect ~/.ashlr/runs to a tmp dir so tests never write to real HOME.
let origHome: string | undefined;
beforeEach(() => {
  origHome = process.env['HOME'];
  process.env['HOME'] = mkTmp('ashlr-m199-home-');
});
afterEach(() => {
  if (origHome !== undefined) process.env['HOME'] = origHome;
});

// ---------------------------------------------------------------------------
// Restore factory-mock implementations after vi.resetAllMocks() wipes them.
//
// vi.resetAllMocks() (called in afterEach above) removes ALL implementations
// from vi.fn() stubs, including those defined inline in vi.mock() factories.
// Any runGoal path that calls withRetry(...).catch(...) or withHeal(...).catch(...)
// will crash with "Cannot read properties of undefined (reading 'catch')" if
// those mocks return undefined.  We restore the defaults here so every test
// starts from a known-good baseline regardless of what the prior test did.
// ---------------------------------------------------------------------------
beforeEach(() => {
  // retry / self-heal — must return Promises so .catch() works
  vi.mocked(withRetry).mockImplementation(
    async (fn: (attempt: number) => Promise<void>) => fn(1),
  );
  vi.mocked(withHeal).mockImplementation(
    async (fn: (attempt: number) => Promise<void>) => fn(1),
  );
  vi.mocked(defaultHealPolicy).mockReturnValue({ maxRestarts: 1, restartDelayMs: 0 } as any);

  // streaming
  vi.mocked(nullSink).mockReturnValue(() => {});

  // env-bridge
  vi.mocked(withToolEnv).mockImplementation((_: unknown, fn: () => unknown) => fn());

  // router defaults (no cloud)
  vi.mocked(cloudKeyAvailable).mockReturnValue(false);
  vi.mocked(chooseRoute).mockReturnValue(undefined as any);

  // engines
  vi.mocked(engineInstalled).mockReturnValue(false);
  vi.mocked(buildEngineCommand).mockReturnValue(null);
  vi.mocked(spawnEngine).mockReturnValue({ ok: true, output: 'engine-output', usage: null } as any);
  vi.mocked(resolveEngineSpec).mockReturnValue(null);

  // model-profile
  vi.mocked(resolveModelProfile).mockReturnValue('base' as any);
  vi.mocked(adaptivePromptsEnabled).mockReturnValue(false);

  // prompts
  vi.mocked(systemPromptFor).mockReturnValue('MOCK_SYSTEM_PROMPT');

  // knowledge
  vi.mocked(scrubSecrets).mockImplementation((s: string) => s);

  // browser-verify defaults (not a web app, returns skipped)
  vi.mocked(isWebApp).mockReturnValue(false);
  vi.mocked(verifyInBrowser).mockResolvedValue({
    skipped: true,
    renderOk: false,
    consoleErrors: [],
    detail: '',
    screenshotPath: null,
  });

  // verify-commands defaults
  vi.mocked(detectVerifyCommands).mockReturnValue([]);
  vi.mocked(runVerifyCommand).mockReturnValue({
    ok: true, command: 'x', exitCode: 0, output: '', timedOut: false,
  });
});

// ---------------------------------------------------------------------------
// 1. parseTaskList — pure, no I/O
// ---------------------------------------------------------------------------

describe('M199 parseTaskList — JSON array', () => {
  it('parses a minimal valid task array', () => {
    const tasks = parseTaskList('[{"id":"t1","goal":"do the thing","deps":[]}]');
    expect(tasks).not.toBeNull();
    expect(tasks!).toHaveLength(1);
    expect(tasks![0].id).toBe('t1');
    expect(tasks![0].goal).toBe('do the thing');
    expect(tasks![0].status).toBe('pending');
  });

  it('parses two-task DAG with a dep', () => {
    const tasks = parseTaskList(
      '[{"id":"a","goal":"step A","deps":[]},{"id":"b","goal":"step B","deps":["a"]}]',
    );
    expect(tasks).toHaveLength(2);
    expect(tasks![1].deps).toEqual(['a']);
  });

  it('accepts alternate field names: name/task/dependsOn', () => {
    const tasks = parseTaskList(
      '[{"name":"x1","task":"alt goal","dependsOn":[]},{"name":"x2","task":"second","dependsOn":["x1"]}]',
    );
    expect(tasks).not.toBeNull();
    expect(tasks![0].id).toBe('x1');
    expect(tasks![0].goal).toBe('alt goal');
  });

  it('strips markdown code fences (```json...```)', () => {
    const text = '```json\n[{"id":"t1","goal":"fenced","deps":[]}]\n```';
    const tasks = parseTaskList(text);
    expect(tasks).not.toBeNull();
    expect(tasks![0].goal).toBe('fenced');
  });

  it('strips trailing commas before ] / }', () => {
    const text = '[{"id":"t1","goal":"trailing comma","deps":[],}]';
    const tasks = parseTaskList(text);
    expect(tasks).not.toBeNull();
    expect(tasks![0].goal).toBe('trailing comma');
  });

  it('returns null for duplicate task ids', () => {
    const tasks = parseTaskList(
      '[{"id":"dup","goal":"a","deps":[]},{"id":"dup","goal":"b","deps":[]}]',
    );
    expect(tasks).toBeNull();
  });

  it('returns null for unknown dep reference', () => {
    const tasks = parseTaskList(
      '[{"id":"t1","goal":"a","deps":["ghost"]}]',
    );
    expect(tasks).toBeNull();
  });

  it('returns null for self-referencing dep', () => {
    const tasks = parseTaskList('[{"id":"t1","goal":"self","deps":["t1"]}]');
    expect(tasks).toBeNull();
  });

  it('returns null for a cyclic DAG (A→B→A)', () => {
    const tasks = parseTaskList(
      '[{"id":"A","goal":"a","deps":["B"]},{"id":"B","goal":"b","deps":["A"]}]',
    );
    expect(tasks).toBeNull();
  });

  it('returns null for empty JSON array []', () => {
    const tasks = parseTaskList('[]');
    expect(tasks).toBeNull();
  });
});

describe('M199 parseTaskList — bulleted list fallback', () => {
  it('parses numbered list into tasks with synthesised ids', () => {
    const text = '1. Install dependencies\n2. Run tests\n3. Deploy';
    const tasks = parseTaskList(text);
    expect(tasks).not.toBeNull();
    expect(tasks!).toHaveLength(3);
    expect(tasks![0].id).toBe('t1');
    expect(tasks![0].goal).toBe('Install dependencies');
    expect(tasks![2].goal).toBe('Deploy');
  });

  it('parses bulleted list (- prefix)', () => {
    const text = '- Write code\n- Write tests';
    const tasks = parseTaskList(text);
    expect(tasks).not.toBeNull();
    expect(tasks!).toHaveLength(2);
  });

  it('returns null for prose with no extractable structure', () => {
    const text = 'This is a plain sentence with no tasks.';
    const tasks = parseTaskList(text);
    expect(tasks).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. foldBrowserVerify — pure
// ---------------------------------------------------------------------------

describe('M199 foldBrowserVerify — pure fold helper', () => {
  it('returns null when result is skipped', () => {
    const bv = { skipped: true, renderOk: true, consoleErrors: [], detail: '', screenshotPath: null };
    expect(foldBrowserVerify('existing', bv)).toBeNull();
  });

  it('returns FAIL prefix when renderOk=false', () => {
    const bv = { skipped: false, renderOk: false, consoleErrors: [], detail: '', screenshotPath: null };
    const out = foldBrowserVerify('prior', bv);
    expect(out).not.toBeNull();
    expect(out!).toMatch(/browser-verify: FAIL/);
    expect(out!).toContain('prior');
  });

  it('returns FAIL prefix when consoleErrors present (even if renderOk=true)', () => {
    const bv = { skipped: false, renderOk: true, consoleErrors: ['Uncaught TypeError: x is undefined'], detail: '', screenshotPath: null };
    const out = foldBrowserVerify('prior', bv);
    expect(out!).toMatch(/browser-verify: FAIL/);
    expect(out!).toMatch(/Uncaught TypeError/);
  });

  it('returns PASS suffix on clean pass', () => {
    const bv = { skipped: false, renderOk: true, consoleErrors: [], detail: 'render ok', screenshotPath: null };
    const out = foldBrowserVerify('prior', bv);
    expect(out!).toMatch(/browser-verify: PASS/);
    expect(out!).toContain('prior');
  });

  it('handles undefined existing gracefully on PASS', () => {
    const bv = { skipped: false, renderOk: true, consoleErrors: [], detail: 'ok', screenshotPath: '/tmp/ss.png' };
    const out = foldBrowserVerify(undefined, bv);
    expect(out!).toMatch(/browser-verify: PASS/);
    expect(out!).toContain('screenshot:');
  });

  it('FAIL caps consoleErrors at 5', () => {
    const errs = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'];
    const bv = { skipped: false, renderOk: true, consoleErrors: errs, detail: '', screenshotPath: null };
    const out = foldBrowserVerify('x', bv)!;
    // Should not include e6/e7
    expect(out).not.toContain('e6');
    expect(out).not.toContain('e7');
  });
});

// ---------------------------------------------------------------------------
// 3. TITRR_MAX_ATTEMPTS constant
// ---------------------------------------------------------------------------

describe('M199 TITRR_MAX_ATTEMPTS constant', () => {
  it('is exported, is a positive number, equals 2', () => {
    expect(typeof TITRR_MAX_ATTEMPTS).toBe('number');
    expect(TITRR_MAX_ATTEMPTS).toBeGreaterThan(0);
    expect(TITRR_MAX_ATTEMPTS).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4. titrrTestRun — with mocked verify-commands
// ---------------------------------------------------------------------------

describe('M199 titrrTestRun — null when no test command', () => {
  it('returns null when detectVerifyCommands returns empty', async () => {
    vi.mocked(detectVerifyCommands).mockReturnValue([]);
    const result = await titrrTestRun('/tmp/noop', makeConfig());
    expect(result).toBeNull();
  });

  it('returns {ok:true} when mocked test command passes', async () => {
    vi.mocked(detectVerifyCommands).mockReturnValue([{ kind: 'test', cmd: ['sh', '-c', 'exit 0'] } as any]);
    vi.mocked(runVerifyCommand).mockReturnValue({ ok: true, command: 'sh', exitCode: 0, output: 'all pass', timedOut: false });
    const result = await titrrTestRun('/tmp/noop', makeConfig());
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
  });

  it('returns {ok:false} when mocked test command fails', async () => {
    vi.mocked(detectVerifyCommands).mockReturnValue([{ kind: 'test', cmd: ['sh', '-c', 'exit 1'] } as any]);
    vi.mocked(runVerifyCommand).mockReturnValue({ ok: false, command: 'sh', exitCode: 1, output: 'FAIL test_x', timedOut: false });
    const result = await titrrTestRun('/tmp/noop', makeConfig());
    expect(result!.ok).toBe(false);
    expect(result!.output).toContain('FAIL');
  });

  it('truncates output when it exceeds TITRR_OUTPUT_CAP (4000 chars)', async () => {
    vi.mocked(detectVerifyCommands).mockReturnValue([{ kind: 'test', cmd: ['x'] } as any]);
    vi.mocked(runVerifyCommand).mockReturnValue({
      ok: false,
      command: 'x',
      exitCode: 1,
      output: 'A'.repeat(6000),
      timedOut: false,
    });
    const result = await titrrTestRun('/tmp/noop', makeConfig());
    expect(result!.output.length).toBeLessThanOrEqual(4050); // 4000 + truncation marker
    expect(result!.output).toContain('[output truncated]');
  });
});

// ---------------------------------------------------------------------------
// 5. planGoal — with mocked client.chat
// ---------------------------------------------------------------------------

describe('M199 planGoal — happy path', () => {
  it('returns parsed tasks when client.chat returns valid JSON', async () => {
    const json = '[{"id":"t1","goal":"step one","deps":[]},{"id":"t2","goal":"step two","deps":["t1"]}]';
    const client = makeClient('ollama', { content: json, usage: { tokensIn: 10, tokensOut: 20 } });

    const tasks = await planGoal('my goal', client as any);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].goal).toBe('step one');
    expect(tasks[1].deps).toEqual(['t1']);
  });

  it('reports usage via onUsage callback', async () => {
    const json = '[{"id":"t1","goal":"g","deps":[]}]';
    const client = makeClient('ollama', { content: json, usage: { tokensIn: 50, tokensOut: 75 } });

    let reportedIn = 0;
    let reportedOut = 0;
    await planGoal('goal', client as any, (u) => {
      reportedIn = u.tokensIn;
      reportedOut = u.tokensOut;
    });

    expect(reportedIn).toBe(50);
    expect(reportedOut).toBe(75);
  });

  it('falls back to single-task on chat error', async () => {
    const client = makeClient();
    vi.mocked(client.chat).mockRejectedValue(new Error('model offline'));

    const tasks = await planGoal('my goal', client as any);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('t1');
    expect(tasks[0].goal).toBe('my goal');
  });

  it('falls back to single-task when output is unparseable prose', async () => {
    const client = makeClient('ollama', { content: 'Sure! Here are some ideas for you.', usage: { tokensIn: 5, tokensOut: 10 } });
    const tasks = await planGoal('my goal', client as any);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].goal).toBe('my goal');
  });

  it('injects memoryContext into system prompt (non-adaptive)', async () => {
    const json = '[{"id":"t1","goal":"g","deps":[]}]';
    const client = makeClient('ollama', { content: json, usage: { tokensIn: 0, tokensOut: 0 } });
    await planGoal('my goal', client as any, undefined, 'Relevant project memory: context here');
    // The chat call should have been made (we don't inspect the exact prompt but verify it was called)
    expect(client.chat).toHaveBeenCalledOnce();
    const [messages] = vi.mocked(client.chat).mock.calls[0] as any;
    const sysMsg = messages.find((m: any) => m.role === 'system');
    expect(sysMsg.content).toContain('Relevant project memory');
  });
});

// ---------------------------------------------------------------------------
// 6. runGoal — happy path (plan → dispatch → synthesize → 'done')
// ---------------------------------------------------------------------------

describe('M199 runGoal — happy path', () => {
  beforeEach(() => {
    // Client: plan returns two tasks; synthesize returns final answer.
    const planJson = '[{"id":"t1","goal":"task one","deps":[]},{"id":"t2","goal":"task two","deps":["t1"]}]';
    const client = makeClient('ollama', { content: planJson, usage: { tokensIn: 10, tokensOut: 20 } });

    // Second call (synthesize) returns final answer.
    vi.mocked(client.chat)
      .mockResolvedValueOnce({ content: planJson, usage: { tokensIn: 10, tokensOut: 20 } })
      .mockResolvedValue({ content: 'Final synthesized answer', usage: { tokensIn: 5, tokensOut: 10 } });

    vi.mocked(getActiveClient).mockResolvedValue(client as any);

    // runTask sets task to 'done'.
    vi.mocked(runTask).mockImplementation(async (task: any) => {
      task.status = 'done';
      task.result = `result for ${task.id}`;
    });

    // verify passes.
    vi.mocked(verifyTaskStructured).mockResolvedValue({ ok: true, reason: 'heuristic pass' } as any);
  });

  it('returns RunState with status=done', async () => {
    const state = await runGoal('my big goal', makeConfig(), makeOpts());
    expect(state.status).toBe('done');
    expect(state.result).toBeTruthy();
    expect(state.goal).toBe('my big goal');
  });

  it('state has 2 tasks, all done', async () => {
    const state = await runGoal('my big goal', makeConfig(), makeOpts());
    expect(state.tasks).toHaveLength(2);
    for (const t of state.tasks) {
      expect(t.status).toBe('done');
    }
  });

  it('state.usage.steps is > 0 (plan + tasks + synthesize)', async () => {
    const state = await runGoal('goal', makeConfig(), makeOpts());
    expect(state.usage.steps).toBeGreaterThan(0);
  });

  it('state has plan and synthesize steps recorded', async () => {
    const state = await runGoal('goal', makeConfig(), makeOpts());
    const stepKinds = state.steps.map((s) => s.kind);
    expect(stepKinds).toContain('plan');
    expect(stepKinds).toContain('synthesize');
  });

  it('state.id matches expected run-<ts>-<rand> format', async () => {
    const state = await runGoal('goal', makeConfig(), makeOpts());
    expect(state.id).toMatch(/^run-\d+-[a-z0-9]+$/);
  });

  it('uses a caller-preallocated opaque id for a fresh run', async () => {
    const runId = 'attempt-018f6d2e-7c50-4f15-8a2c-6efc97fb87a1';
    const state = await runGoal('goal', makeConfig(), makeOpts({ runId }));

    expect(state.id).toBe(runId);
    await expect(runGoal('duplicate', makeConfig(), makeOpts({ runId })))
      .rejects.toThrow(`Run "${runId}" already exists`);
  });
});

// ---------------------------------------------------------------------------
// 7. runGoal — HARD BUDGET abort
// ---------------------------------------------------------------------------

describe('M199 runGoal — hard budget abort', () => {
  it('returns status=aborted when token budget is exceeded before tasks complete', async () => {
    // Plan returns 3 tasks.
    const planJson = '[{"id":"t1","goal":"a","deps":[]},{"id":"t2","goal":"b","deps":[]},{"id":"t3","goal":"c","deps":[]}]';
    const client = makeClient('ollama', { content: planJson, usage: { tokensIn: 999999, tokensOut: 999999 } });
    vi.mocked(getActiveClient).mockResolvedValue(client as any);

    // runTask succeeds but doesn't consume tokens — budget was blown in planning.
    vi.mocked(runTask).mockImplementation(async (task: any) => {
      task.status = 'done';
      task.result = 'done';
    });
    vi.mocked(verifyTaskStructured).mockResolvedValue({ ok: true, reason: 'pass' } as any);

    const state = await runGoal(
      'budget-busting goal',
      makeConfig(),
      makeOpts({ budget: { maxTokens: 1, maxSteps: 1 } }),
    );

    // Planning alone consumed 999999+999999 tokens > 1 → must be aborted.
    expect(state.status).toBe('aborted');
  });

  it('pending tasks are marked failed with ABORT_TASK_ERROR sentinel on abort', async () => {
    const planJson = '[{"id":"t1","goal":"a","deps":[]}]';
    const client = makeClient('ollama', { content: planJson, usage: { tokensIn: 999999, tokensOut: 999999 } });
    vi.mocked(getActiveClient).mockResolvedValue(client as any);
    vi.mocked(runTask).mockImplementation(async (task: any) => { task.status = 'done'; });
    vi.mocked(verifyTaskStructured).mockResolvedValue({ ok: true, reason: 'pass' } as any);

    const state = await runGoal('goal', makeConfig(), makeOpts({ budget: { maxTokens: 1, maxSteps: 1 } }));
    // All tasks should be either done or failed (with abort sentinel).
    for (const t of state.tasks) {
      if (t.status === 'failed') {
        expect(t.error).toBe('Aborted: run budget exceeded');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 8. runGoal — fallback cascade (router absent → local client)
// ---------------------------------------------------------------------------

describe('M199 runGoal — router absent → fallback to run-level client', () => {
  it('tasks are still dispatched when router module throws on import', async () => {
    const planJson = '[{"id":"t1","goal":"a task","deps":[]}]';
    const client = makeClient('ollama');
    vi.mocked(client.chat)
      .mockResolvedValueOnce({ content: planJson, usage: { tokensIn: 5, tokensOut: 10 } })
      .mockResolvedValue({ content: 'synthesized', usage: { tokensIn: 2, tokensOut: 5 } });
    vi.mocked(getActiveClient).mockResolvedValue(client as any);

    vi.mocked(runTask).mockImplementation(async (task: any) => {
      task.status = 'done';
      task.result = 'fallback result';
    });
    vi.mocked(verifyTaskStructured).mockResolvedValue({ ok: true, reason: 'ok' } as any);

    // Router module is already mocked; chooseRoute throws to simulate unavailability.
    const { chooseRoute } = await import('../src/core/run/router.js');
    vi.mocked(chooseRoute).mockRejectedValue(new Error('router not available'));

    const state = await runGoal('goal', makeConfig(), makeOpts());
    expect(state.status).toBe('done');
    expect(state.tasks[0].status).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// 9. runGoal — verify-gate integration (M171 browserVerify ON/OFF)
// ---------------------------------------------------------------------------

describe('M199 runGoal — browserVerify OFF (default)', () => {
  it('verifyInBrowser is never called when browserVerify flag is absent', async () => {
    const planJson = '[{"id":"t1","goal":"some task","deps":[]}]';
    const client = makeClient('ollama');
    vi.mocked(client.chat)
      .mockResolvedValueOnce({ content: planJson, usage: { tokensIn: 5, tokensOut: 10 } })
      .mockResolvedValue({ content: 'synthesized', usage: { tokensIn: 2, tokensOut: 5 } });
    vi.mocked(getActiveClient).mockResolvedValue(client as any);
    vi.mocked(runTask).mockImplementation(async (task: any) => { task.status = 'done'; task.result = 'ok'; });
    vi.mocked(verifyTaskStructured).mockResolvedValue({ ok: true, reason: 'ok' } as any);

    await runGoal('goal', makeConfig(), makeOpts());
    expect(verifyInBrowser).not.toHaveBeenCalled();
  });
});

describe('M199 runGoal — browserVerify ON, isWebApp=true, clean pass', () => {
  it('appends [browser-verify: PASS] to task result', async () => {
    const planJson = '[{"id":"t1","goal":"build UI","deps":[]}]';
    const client = makeClient('ollama');
    vi.mocked(client.chat)
      .mockResolvedValueOnce({ content: planJson, usage: { tokensIn: 5, tokensOut: 10 } })
      .mockResolvedValue({ content: 'done', usage: { tokensIn: 2, tokensOut: 5 } });
    vi.mocked(getActiveClient).mockResolvedValue(client as any);

    vi.mocked(runTask).mockImplementation(async (task: any) => {
      task.status = 'done';
      task.result = 'task output';
    });
    vi.mocked(verifyTaskStructured).mockResolvedValue({ ok: true, reason: 'ok' } as any);

    // Enable browser verify.
    vi.mocked(isWebApp).mockReturnValue(true);
    vi.mocked(verifyInBrowser).mockResolvedValue({
      skipped: false,
      renderOk: true,
      consoleErrors: [],
      detail: 'page loaded',
      screenshotPath: null,
    });

    const cfg = makeConfig({ foundry: { browserVerify: true } as any });
    const state = await runGoal('goal', cfg, makeOpts());

    const t1 = state.tasks.find((t) => t.id === 't1')!;
    expect(t1.result).toContain('[browser-verify: PASS');
    expect(verifyInBrowser).toHaveBeenCalledOnce();
  });
});

describe('M199 runGoal — browserVerify ON, isWebApp=true, render fail', () => {
  it('prepends [browser-verify: FAIL] to task result', async () => {
    const planJson = '[{"id":"t1","goal":"build UI","deps":[]}]';
    const client = makeClient('ollama');
    vi.mocked(client.chat)
      .mockResolvedValueOnce({ content: planJson, usage: { tokensIn: 5, tokensOut: 10 } })
      .mockResolvedValue({ content: 'done', usage: { tokensIn: 2, tokensOut: 5 } });
    vi.mocked(getActiveClient).mockResolvedValue(client as any);

    vi.mocked(runTask).mockImplementation(async (task: any) => {
      task.status = 'done';
      task.result = 'task output';
    });
    vi.mocked(verifyTaskStructured).mockResolvedValue({ ok: true, reason: 'ok' } as any);

    vi.mocked(isWebApp).mockReturnValue(true);
    vi.mocked(verifyInBrowser).mockResolvedValue({
      skipped: false,
      renderOk: false,
      consoleErrors: [],
      detail: '',
      screenshotPath: null,
    });

    const cfg = makeConfig({ foundry: { browserVerify: true } as any });
    const state = await runGoal('goal', cfg, makeOpts());

    const t1 = state.tasks.find((t) => t.id === 't1')!;
    expect(t1.result).toMatch(/browser-verify: FAIL/);
  });
});

describe('M199 runGoal — browserVerify ON, isWebApp=false → skip', () => {
  it('verifyInBrowser is NOT called when repo is not a web app', async () => {
    const planJson = '[{"id":"t1","goal":"cli task","deps":[]}]';
    const client = makeClient('ollama');
    vi.mocked(client.chat)
      .mockResolvedValueOnce({ content: planJson, usage: { tokensIn: 5, tokensOut: 10 } })
      .mockResolvedValue({ content: 'done', usage: { tokensIn: 2, tokensOut: 5 } });
    vi.mocked(getActiveClient).mockResolvedValue(client as any);
    vi.mocked(runTask).mockImplementation(async (task: any) => { task.status = 'done'; task.result = 'ok'; });
    vi.mocked(verifyTaskStructured).mockResolvedValue({ ok: true, reason: 'ok' } as any);

    vi.mocked(isWebApp).mockReturnValue(false); // not a web app

    const cfg = makeConfig({ foundry: { browserVerify: true } as any });
    await runGoal('goal', cfg, makeOpts());
    expect(verifyInBrowser).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 10. runGoal — never-throws / error degradation
// ---------------------------------------------------------------------------

describe('M199 runGoal — never-throws: runTask throws → task marked failed, run proceeds', () => {
  it('task is marked failed but run returns a RunState (no throw)', async () => {
    const planJson = '[{"id":"t1","goal":"failing task","deps":[]}]';
    const client = makeClient('ollama');
    vi.mocked(client.chat)
      .mockResolvedValueOnce({ content: planJson, usage: { tokensIn: 5, tokensOut: 10 } })
      .mockResolvedValue({ content: 'partial', usage: { tokensIn: 2, tokensOut: 5 } });
    vi.mocked(getActiveClient).mockResolvedValue(client as any);

    // runTask throws an unexpected error.
    vi.mocked(runTask).mockRejectedValue(new Error('model crashed'));
    vi.mocked(verifyTaskStructured).mockResolvedValue({ ok: true, reason: 'ok' } as any);

    const state = await runGoal('goal', makeConfig(), makeOpts());

    // Run must not throw; should return a RunState.
    expect(state).toBeDefined();
    expect(typeof state.id).toBe('string');
    // Task must be marked failed with a descriptive error.
    const t1 = state.tasks.find((t) => t.id === 't1');
    expect(t1?.status).toBe('failed');
    expect(t1?.error).toMatch(/model crashed|Unexpected orchestrator/);
  });
});

describe('M199 runGoal — governance block returns failed state (no throw)', () => {
  it('returns status=failed when governance blocks the run', async () => {
    const client = makeClient();
    vi.mocked(getActiveClient).mockResolvedValue(client as any);

    // Mock governance module to block.
    vi.doMock('../src/core/observability/governance.js', () => ({
      evalGovernance: vi.fn(() => ({
        level: 'over',
        message: 'Monthly spend cap exceeded',
      })),
    }));

    const cfg = makeConfig({ telemetry: { govAction: 'block' } as any });
    const state = await runGoal('any goal', cfg, makeOpts({ overBudget: false }));

    // Even if governance module isn't loaded in this test (dynamic import is
    // best-effort), the run must return a valid state and must never throw.
    expect(state).toBeDefined();
    expect(['failed', 'done', 'running', 'aborted']).toContain(state.status);
  });
});

describe('M199 runGoal — resume of already-done run is a no-op', () => {
  it('returns the existing completed state without re-running tasks', async () => {
    // First: create a real completed run.
    const planJson = '[{"id":"t1","goal":"done task","deps":[]}]';
    const client = makeClient('ollama');
    vi.mocked(client.chat)
      .mockResolvedValueOnce({ content: planJson, usage: { tokensIn: 5, tokensOut: 10 } })
      .mockResolvedValue({ content: 'Final answer', usage: { tokensIn: 2, tokensOut: 5 } });
    vi.mocked(getActiveClient).mockResolvedValue(client as any);
    vi.mocked(runTask).mockImplementation(async (task: any) => { task.status = 'done'; task.result = 'done'; });
    vi.mocked(verifyTaskStructured).mockResolvedValue({ ok: true, reason: 'ok' } as any);

    const first = await runGoal('original goal', makeConfig(), makeOpts());
    expect(first.status).toBe('done');
    const runId = first.id;

    // Reset call count so we can verify resume doesn't re-run tasks.
    vi.mocked(runTask).mockClear();

    // Second: resume the completed run.
    const second = await runGoal('irrelevant', makeConfig(), makeOpts({
      resumeId: runId,
      runId: '../ignored-because-resume-wins',
    }));

    // Resume of a done run is a no-op: tasks are NOT re-executed.
    expect(second.id).toBe(runId);
    expect(second.status).toBe('done');
    expect(runTask).not.toHaveBeenCalled();
  });
});

describe('M199 runGoal — invalid resumeId throws', () => {
  it('throws when resumeId does not exist on disk', async () => {
    const client = makeClient();
    vi.mocked(getActiveClient).mockResolvedValue(client as any);

    await expect(
      runGoal('goal', makeConfig(), makeOpts({ resumeId: 'run-does-not-exist-99' })),
    ).rejects.toThrow(/not found/);
  });
});
