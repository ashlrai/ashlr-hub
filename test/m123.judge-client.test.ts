/**
 * m123.judge-client.test.ts — Provider-client crash-safety tests.
 *
 * Regression guard for "Cannot read properties of undefined (reading 'replace')"
 * when cfg.models.lmstudio is absent (sparse config, e.g. ollama-only).
 *
 * Also verifies the manager + strategist fall through to the direct
 * buildOpenAICompatibleClient path when getActiveClient throws.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m123-home-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Sparse config (ollama only, no lmstudio key)
// ---------------------------------------------------------------------------

const SPARSE_CFG: AshlrConfig = {
  user: { id: 'test', name: 'Test' },
  models: {
    providerChain: ['ollama'],
    ollama: 'http://localhost:11434',
    // lmstudio intentionally absent
  },
} as unknown as AshlrConfig;

// ---------------------------------------------------------------------------
// 1. getProviderRegistry — does NOT throw on sparse config
// ---------------------------------------------------------------------------

describe('getProviderRegistry with sparse config', () => {
  it('does not throw when cfg.models.lmstudio is undefined', async () => {
    // Stub fetch so the Ollama probe returns quickly without a real server.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'qwen2.5:72b-instruct-q4_K_M' }] }),
    }));

    const { getProviderRegistry } = await import('../src/core/providers.js');
    // Must not throw — previously crashed with "Cannot read properties of
    // undefined (reading 'replace')" inside ensurePath.
    const registry = await getProviderRegistry(SPARSE_CFG);
    expect(registry).toBeDefined();
    expect(registry.activeProvider).toBe('ollama');
    expect(registry.providers.some((p) => p.id === 'ollama' && p.up)).toBe(true);
    // lmstudio endpoint should be skipped (up: false, not configured)
    const lm = registry.providers.find((p) => p.id === 'lmstudio');
    expect(lm?.up).toBe(false);
    expect(lm?.error).toBe('not configured');
  });

  it('still works when both lmstudio and ollama are absent', async () => {
    const emptyCfg = {
      user: { id: 'test', name: 'Test' },
      models: { providerChain: [] },
    } as unknown as AshlrConfig;

    const { getProviderRegistry } = await import('../src/core/providers.js');
    const registry = await getProviderRegistry(emptyCfg);
    expect(registry.activeProvider).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. runManager falls through to buildOpenAICompatibleClient when
//    getActiveClient throws (simulates the exact production crash path)
// ---------------------------------------------------------------------------

describe('runManager direct-Ollama fallback', () => {
  it('uses buildOpenAICompatibleClient when getActiveClient throws', async () => {
    // M282: reset the module registry so manager.js is re-imported with fresh
    // static bindings for engineInstalled. Without this, a prior import in the
    // same file (or a parallel test) caches manager.js with the real
    // engineInstalled — which returns true on this machine (claude CLI installed)
    // — causing resolveJudgeClient to pick the Claude path instead of local-72b.
    vi.resetModules();
    // Force engineInstalled to return false → resolveJudgeClient uses local-72b
    vi.doMock('../src/core/run/engines.js', async (importOriginal) => {
      const orig = await importOriginal<typeof import('../src/core/run/engines.js')>();
      return {
        ...orig,
        engineInstalled: vi.fn().mockReturnValue(false),
      };
    });
    // Mock getActiveClient to always throw (simulates broken config / no cloud key)
    vi.doMock('../src/core/run/provider-client.js', async (importOriginal) => {
      const orig = await importOriginal<typeof import('../src/core/run/provider-client.js')>();
      return {
        ...orig,
        getActiveClient: vi.fn().mockRejectedValue(new Error('no provider')),
        buildOpenAICompatibleClient: vi.fn().mockReturnValue({
          id: 'openai-compat',
          model: 'qwen2.5:72b-instruct-q4_K_M',
          supportsTools: true,
          // chat() returns a valid JSON verdict
          chat: vi.fn().mockResolvedValue({
            content: JSON.stringify({
              verdict: 'ship',
              value: 4,
              correctness: 4,
              scope: 2,
              alignment: 5,
              rationale: 'Solid improvement, direct-ollama path',
            }),
            toolCalls: [],
            usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          }),
        }),
      };
    });

    // Mock inbox store
    vi.doMock('../src/core/inbox/store.js', () => ({
      listProposals: vi.fn().mockReturnValue([
        {
          id: 'p-direct-1',
          title: 'Direct Ollama test proposal',
          summary: 'Tests that the direct path works',
          kind: 'fix',
          status: 'pending',
          engineModel: 'qwen2.5:72b-instruct-q4_K_M',
          diff: '+const x = 1;\n',
          createdAt: new Date().toISOString(),
        },
      ]),
      setStatus: vi.fn(),
    }));

    // Mock decisions ledger
    vi.doMock('../src/core/fleet/decisions-ledger.js', () => ({
      recordDecision: vi.fn(),
    }));

    const { runManager } = await import('../src/core/fleet/manager.js');
    const report = await runManager(SPARSE_CFG, { limit: 1 });

    expect(report).toBeDefined();
    // judgeEngine should be the 72b model name (set when buildOpenAICompatibleClient path fires)
    expect(report.judgeEngine).toBe('qwen2.5:72b-instruct-q4_K_M');
    // Should have produced a real verdict (not all 'review' from the null-client fallback)
    expect(report.verdicts).toHaveLength(1);
    expect(report.verdicts[0]!.rationale).not.toBe('no judge available — defaulting to review');

    vi.doUnmock('../src/core/run/engines.js');
    vi.doUnmock('../src/core/run/provider-client.js');
    vi.doUnmock('../src/core/inbox/store.js');
    vi.doUnmock('../src/core/fleet/decisions-ledger.js');
  });
});

describe('judgeProposal cancellation', () => {
  const proposal = {
    id: 'p-cancel-judge',
    repo: null,
    origin: 'agent',
    kind: 'patch',
    title: 'Judge cancellation',
    summary: 'Exercise cancellation propagation.',
    diff: '+const settled = true;\n',
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as const;

  it('does not call the provider when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const complete = vi.fn(async () => '');
    const { judgeProposal } = await import('../src/core/fleet/manager.js');

    await expect(judgeProposal(
      proposal as never,
      SPARSE_CFG,
      { complete },
      { signal: controller.signal },
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('forwards mid-cancel and preserves a response that settles with the abort', async () => {
    const controller = new AbortController();
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    const complete = vi.fn(async (_system: string, _user: string, signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      providerStarted();
      await new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return JSON.stringify({
        verdict: 'ship',
        value: 4,
        correctness: 5,
        scope: 1,
        alignment: 5,
        rationale: 'Provider completed before cancellation settlement.',
      });
    });
    const { judgeProposal } = await import('../src/core/fleet/manager.js');

    const pending = judgeProposal(
      proposal as never,
      SPARSE_CFG,
      { complete },
      { recordTrace: false, signal: controller.signal },
    );
    await started;
    controller.abort();
    const verdict = await pending;

    expect(complete).toHaveBeenCalledTimes(1);
    expect(verdict).toMatchObject({ verdict: 'ship', correctness: 5, alignment: 5 });
  });
});

// ---------------------------------------------------------------------------
// 3. runStrategist falls through to buildOpenAICompatibleClient
// ---------------------------------------------------------------------------

describe('runStrategist direct-Ollama fallback', () => {
  it('uses buildOpenAICompatibleClient when getActiveClient throws', async () => {
    // Ensure a spec exists so strategist doesn't short-circuit.
    const specDir = path.join(tmpHome, '.ashlr', 'vision', 'specs');
    fs.mkdirSync(specDir, { recursive: true });
    const spec = {
      id: 'ecosystem',
      version: 1,
      northStar: 'Autonomous engineering fleet',
      endState: 'Self-improving coding agent',
      principles: ['local-first', 'correctness'],
      priorities: [{ title: 'Reliability', rationale: 'Fleet must be reliable', rank: 1 }],
      openProblems: ['provider crash on sparse config'],
      ambitionLevel: 9,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      updatedBy: 'test',
      history: [],
    };
    fs.writeFileSync(path.join(specDir, 'ecosystem.json'), JSON.stringify(spec));

    vi.doMock('../src/core/run/provider-client.js', async (importOriginal) => {
      const orig = await importOriginal<typeof import('../src/core/run/provider-client.js')>();
      return { ...orig, getActiveClient: vi.fn().mockRejectedValue(new Error('no provider')) };
    });

    // Strategist falls back to a raw fetch to Ollama /chat/completions when
    // getActiveClient yields no usable client. Mock global.fetch (OpenAI-compat shape).
    const briefingJson = JSON.stringify({
      currentState: 'Fleet is operational with local 72b inference.',
      gapToVision: 'Need tighter provider error handling.',
      proposedEvolution: {},
      recommendedDirection: ['Harden provider client', 'Add fleet metrics dashboard'],
      newProblems: [],
      questionsForMason: [],
      proposedGoals: [{ objective: 'Fix provider crashes', rationale: 'Reliability first', specPriority: 'Reliability' }],
    });
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: briefingJson } }] }),
    }) as unknown as typeof fetch;

    try {
      const { runStrategist } = await import('../src/core/vision/strategist.js');
      const briefing = await runStrategist(SPARSE_CFG);
      expect(briefing).toBeDefined();
      expect(briefing.currentState).toContain('Fleet is operational');
      expect(briefing.recommendedDirection).toHaveLength(2);
    } finally {
      global.fetch = origFetch;
      vi.doUnmock('../src/core/run/provider-client.js');
    }
  });
});
