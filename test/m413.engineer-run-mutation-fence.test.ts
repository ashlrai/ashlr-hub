import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AshlrConfig, RunOptions } from '../src/core/types.js';

const mocks = vi.hoisted(() => ({
  createSandbox: vi.fn(),
  removeSandbox: vi.fn(),
  sandboxDiff: vi.fn(),
  createProposal: vi.fn(() => ({ id: 'must-not-file' })),
}));

vi.mock('../src/core/run/provider-client.js', () => ({
  getActiveClient: vi.fn(),
}));

vi.mock('../src/core/run/agent-loop.js', () => ({
  runTask: vi.fn(),
}));

vi.mock('../src/core/run/verify.js', () => ({
  verifyTaskStructured: vi.fn(),
}));

vi.mock('../src/core/run/verify-commands.js', () => ({
  detectVerifyCommands: vi.fn(() => []),
  runVerifyCommand: vi.fn(() => ({
    ok: true,
    command: 'test',
    exitCode: 0,
    output: '',
    timedOut: false,
  })),
  runVerifyCommandAsync: vi.fn(async () => ({
    ok: true,
    command: 'test',
    exitCode: 0,
    output: '',
    timedOut: false,
  })),
}));

vi.mock('../src/core/run/router.js', () => ({
  chooseRoute: vi.fn(),
  cloudKeyAvailable: vi.fn(() => false),
}));

vi.mock('../src/core/run/engines.js', () => ({
  engineInstalled: vi.fn(() => false),
  buildEngineCommand: vi.fn(() => null),
  spawnEngine: vi.fn(),
}));

vi.mock('../src/core/run/engine-registry.js', () => ({
  resolveEngineSpec: vi.fn(() => null),
}));

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

vi.mock('../src/core/run/streaming.js', () => ({
  nullSink: vi.fn(() => () => {}),
}));

vi.mock('../src/core/run/retry.js', () => ({
  withRetry: vi.fn(async (fn: (attempt: number) => Promise<void>) => fn(1)),
}));

vi.mock('../src/core/run/self-heal.js', () => ({
  withHeal: vi.fn(async (fn: (attempt: number) => Promise<void>) => fn(1)),
  defaultHealPolicy: vi.fn(() => ({ maxRestarts: 1, restartDelayMs: 0 })),
}));

vi.mock('../src/core/mcp-native.js', () => ({
  listNativeTools: vi.fn(() => []),
}));

vi.mock('../src/core/mcp-native-engineer.js', () => ({
  buildEngineerToolSpecs: vi.fn(() => []),
  buildNativeToolSpecsWithFn: vi.fn(() => []),
}));

vi.mock('../src/core/seams/inbox.js', () => ({
  selectInboxStore: vi.fn(() => ({ create: mocks.createProposal })),
}));

vi.mock('../src/core/knowledge/index.js', () => ({
  scrubSecrets: vi.fn((value: string) => value),
}));

vi.mock('../src/core/run/prompts/roles.js', () => ({
  PLANNER_ROLE: 'MOCK_PLANNER_ROLE',
  SYNTHESIZER_ROLE: 'MOCK_SYNTHESIZER_ROLE',
}));

vi.mock('../src/core/run/prompts/index.js', () => ({
  systemPromptFor: vi.fn(() => 'MOCK_SYSTEM_PROMPT'),
}));

vi.mock('../src/core/run/model-profile.js', () => ({
  resolveModelProfile: vi.fn(() => 'base'),
  adaptivePromptsEnabled: vi.fn(() => false),
}));

vi.mock('../src/core/env-bridge.js', () => ({
  withToolEnv: vi.fn((_: unknown, fn: () => unknown) => fn()),
}));

vi.mock('../src/core/sandbox/worktree.js', () => ({
  createSandbox: mocks.createSandbox,
  removeSandbox: mocks.removeSandbox,
  sandboxDiff: mocks.sandboxDiff,
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect(): Promise<void> {}
    async listTools(): Promise<{ tools: unknown[] }> { return { tools: [] }; }
    async close(): Promise<void> {}
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {},
}));

import { runTask } from '../src/core/run/agent-loop.js';
import { runGoal } from '../src/core/run/orchestrator.js';
import { getActiveClient } from '../src/core/run/provider-client.js';
import { enroll, killSwitchOn, setKill } from '../src/core/sandbox/policy.js';

function config(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
  };
}

function abortGate(): {
  entered: Promise<void>;
  wait: (signal: AbortSignal | undefined) => Promise<void>;
} {
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  return {
    entered,
    wait: (signal) => {
      markEntered();
      if (signal?.aborted) return Promise.resolve();
      return new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  };
}

describe('M413 engineer run mutation fence', () => {
  let home: string;
  let repo: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    home = mkdtempSync(join(tmpdir(), 'ashlr-m413-home-'));
    repo = mkdtempSync(join(tmpdir(), 'ashlr-m413-repo-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    expect(setKill(false, { waitMs: 500 }).ok).toBe(true);
    expect(enroll(repo, { waitMs: 500 }).ok).toBe(true);

    mocks.createSandbox.mockReturnValue({
      id: 'm413-sandbox',
      sourceRepo: repo,
      worktreePath: join(repo, '.engineer-worktree'),
      branch: 'ashlr/sandbox/m413',
    });
    mocks.sandboxDiff.mockReturnValue({
      files: 1,
      patch: 'diff --git a/cancelled.ts b/cancelled.ts\n+must not be proposed\n',
      insertions: 1,
      deletions: 0,
    });
  });

  afterEach(() => {
    setKill(false, { waitMs: 500 });
    vi.clearAllMocks();
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  });

  it('holds authority through blocked model cancellation and sandbox finalization', async () => {
    const controller = new AbortController();
    const gate = abortGate();
    const client = {
      id: 'mock-provider',
      model: 'mock-model',
      supportsTools: true,
      chat: vi.fn()
        .mockResolvedValueOnce({
          content: '[{"id":"t1","goal":"remain blocked","deps":[]}]',
          usage: { tokensIn: 1, tokensOut: 1 },
        })
        .mockResolvedValue({
          content: 'must not synthesize',
          usage: { tokensIn: 1, tokensOut: 1 },
        }),
    };
    vi.mocked(getActiveClient).mockResolvedValue(client);
    vi.mocked(runTask).mockImplementationOnce(async (task, _client, ctx) => {
      await gate.wait(ctx.signal);
      return task;
    });

    const options: RunOptions & { noMemory: boolean; noCapture: boolean; noHeal: boolean } = {
      engine: 'builtin',
      engineer: true,
      tools: true,
      cwd: repo,
      signal: controller.signal,
      noMemory: true,
      noCapture: true,
      noHeal: true,
    };
    let running: Promise<Awaited<ReturnType<typeof runGoal>>> | undefined;

    try {
      running = runGoal('exercise the engineer lifecycle', config(), options);
      await gate.entered;

      expect(mocks.createSandbox).toHaveBeenCalledOnce();
      expect(setKill(true, { waitMs: 25 })).toEqual({
        ok: false,
        changed: true,
        quiesced: false,
        reason: 'kill armed; an outward mutation has not quiesced',
      });
      expect(killSwitchOn()).toBe(true);

      controller.abort();
      const state = await running;

      expect(state).toMatchObject({
        status: 'aborted',
        terminationReason: 'cancelled',
        result: 'Run cancelled.',
      });
      expect(mocks.sandboxDiff).not.toHaveBeenCalled();
      expect(mocks.createProposal).not.toHaveBeenCalled();
      expect(mocks.removeSandbox).toHaveBeenCalledOnce();
      expect(mocks.removeSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'm413-sandbox', sourceRepo: repo }),
      );

      expect(setKill(true, { waitMs: 25 })).toMatchObject({
        ok: true,
        changed: false,
        quiesced: true,
      });
    } finally {
      controller.abort();
      await running?.catch(() => undefined);
      setKill(false, { waitMs: 500 });
    }
  }, 15_000);
});
