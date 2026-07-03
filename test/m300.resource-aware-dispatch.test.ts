/**
 * m300.resource-aware-dispatch.test.ts — M300: Resource-Aware Dispatch + Codex Judge.
 *
 * Verifies:
 *  [D1]  Exhausted claude → dispatch reroutes to codex.
 *  [D2]  Available claude → no reroute (uses original engine).
 *  [D3]  resourceAwareDispatch=false → no reroute even when exhausted (flag-off = byte-identical).
 *  [D4]  All fallbacks exhausted → uses original engine as last resort (never throws).
 *  [D5]  api-model fallback (nim) → runApiModelSandboxed called, NOT runEngineSandboxed.
 *  [J1]  managerJudgeEngine='codex' → codex judge client built (model=gpt-5.5).
 *  [J2]  auto + claude exhausted → resolveFrontierJudgeClient falls to codex judge.
 *  [F1]  isFrontierJudge accepts gpt-5.5.
 *  [F2]  isFrontierJudge accepts codex-* and bare 'codex'.
 *  [F3]  isFrontierJudge still rejects non-frontier (qwen/local/nim/kimi).
 *  [F4]  isFrontierJudge still accepts claude-* (unchanged).
 *  [A1]  Codex ship attestation: evaluateVerificationGate accepts gpt-5.5 judge + valid HMAC.
 *  [S1]  Non-frontier judge: evaluateVerificationGate refuses (qwen2.5:72b).
 *
 * SAFETY: the merge gate (value≥3+corr≥4, verify, scope, frontier-authority,
 * M54 HMAC) is UNCHANGED. Only the frontier-model predicate is widened to include
 * codex/gpt-5.x — the HMAC attestation requirement is fully enforced in [A1].
 *
 * HOME is overridden to a tmp dir so no real ~/.ashlr state is touched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AshlrConfig, TaskSpec } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------
const origHome = process.env.HOME;
let tmpHome: string;

// ---------------------------------------------------------------------------
// Mocks — declared before any lazy import
// ---------------------------------------------------------------------------

// getResourceSnapshot
const mockGetResourceSnapshot = vi.fn();
vi.mock('../src/core/fabric/resource-monitor.js', () => ({
  getResourceSnapshot: (...args: unknown[]) => mockGetResourceSnapshot(...args),
  peekBackendAvailability: vi.fn(() => null),
  recordBackoff: vi.fn(),
  clearBackoff: vi.fn(),
}));

// resolveEngineSpec
const mockResolveEngineSpec = vi.fn();
vi.mock('../src/core/run/engine-registry.js', () => ({
  resolveEngineSpec: (...args: unknown[]) => mockResolveEngineSpec(...args),
  resolveEngineRegistry: vi.fn(() => ({})),
}));

// runEngineSandboxed + runApiModelSandboxed
const mockRunEngineSandboxed = vi.fn();
const mockRunApiModelSandboxed = vi.fn();
vi.mock('../src/core/run/sandboxed-engine.js', () => ({
  runEngineSandboxed: (...args: unknown[]) => mockRunEngineSandboxed(...args),
  runApiModelSandboxed: (...args: unknown[]) => mockRunApiModelSandboxed(...args),
}));

// runAutoMergePass
const mockRunAutoMergePass = vi.fn();
vi.mock('../src/core/fleet/automerge-pass.js', () => ({
  runAutoMergePass: (...args: unknown[]) => mockRunAutoMergePass(...args),
}));

// killSwitchOn / assertMayMutate
const mockKillSwitchOn = vi.fn(() => false);
const mockAssertMayMutate = vi.fn();
vi.mock('../src/core/sandbox/policy.js', () => ({
  killSwitchOn: () => mockKillSwitchOn(),
  assertMayMutate: (repo: string) => mockAssertMayMutate(repo),
  listEnrolled: vi.fn(() => []),
}));

// listProposals
const mockListProposals = vi.fn(() => []);
vi.mock('../src/core/inbox/store.js', () => ({
  listProposals: (...args: unknown[]) => mockListProposals(...args),
}));

// runConductor (flag-off)
vi.mock('../src/core/goals/conductor.js', () => ({
  runConductor: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Record<string, unknown> = {}): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    foundry: {
      simpleConductor: true,
      autoMerge: { enabled: false },
      resourceAwareDispatch: true,
      engineFallbackOrder: ['codex', 'kimi', 'nim', 'local-coder'],
      ...overrides,
    },
  } as unknown as AshlrConfig;
}

function makeSnapshot(backends: Array<{ backend: string; availability: string }>) {
  return {
    generatedAt: new Date().toISOString(),
    backends: backends.map((b) => ({
      ...b,
      usedPct: null,
      cap: null,
      capUnit: null,
      capWindow: null,
      resetsAt: null,
      costPerMTokenOut: 0,
      p50LatencyMs: null,
      snapshotAt: new Date().toISOString(),
      reason: b.availability,
      backoffUntilMs: null,
    })),
  };
}

function writeTasks(tasks: TaskSpec[]): void {
  const dir = join(tmpHome, '.ashlr');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tasks.json'), JSON.stringify(tasks, null, 2) + '\n', 'utf8');
}

function baseTask(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: 'task-1',
    repo: '/tmp/fake-repo',
    instruction: 'fix the bug',
    priority: 0,
    ...overrides,
  };
}

const defaultSandboxResult = { proposalId: 'prop-1' };

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'm300-test-'));
  process.env.HOME = tmpHome;
  vi.clearAllMocks();
  // Default: kill-switch off, assertMayMutate no-op, autoMergePass → 0 merged
  mockKillSwitchOn.mockReturnValue(false);
  mockAssertMayMutate.mockImplementation(() => { /* allow */ });
  mockRunAutoMergePass.mockResolvedValue({ merged: 0, skipped: 0 });
  mockRunEngineSandboxed.mockResolvedValue(defaultSandboxResult);
  mockRunApiModelSandboxed.mockResolvedValue(defaultSandboxResult);
  // Default: cli-agent for all engines
  mockResolveEngineSpec.mockImplementation((engine: string) => ({ id: engine, kind: 'cli-agent', tier: 'frontier' }));
});

afterEach(() => {
  process.env.HOME = origHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// [D1] Exhausted claude → reroutes to codex
// ---------------------------------------------------------------------------

describe('M300 [D1] exhausted claude → reroutes to codex', () => {
  it('dispatches to codex when claude is exhausted', async () => {
    const cfg = makeConfig();
    writeTasks([baseTask({ engine: 'claude' })]);

    mockGetResourceSnapshot.mockResolvedValue(makeSnapshot([
      { backend: 'claude', availability: 'exhausted' },
      { backend: 'codex',  availability: 'open' },
    ]));
    // codex is a cli-agent
    mockResolveEngineSpec.mockImplementation((engine: string) => ({
      id: engine,
      kind: 'cli-agent',
      tier: 'frontier',
    }));

    const { runSimpleConductor } = await import('../src/core/simple-conductor.js');
    const result = await runSimpleConductor(cfg, { once: true, dryRun: false, allowCloud: false });

    expect(result.errors).toHaveLength(0);
    expect(result.proposalsFiled).toBe(1);
    // runEngineSandboxed was called with 'codex', NOT 'claude'
    expect(mockRunEngineSandboxed).toHaveBeenCalledOnce();
    const [calledEngine] = mockRunEngineSandboxed.mock.calls[0]!;
    expect(calledEngine).toBe('codex');
  });

  it('dispatches to codex when claude is throttled', async () => {
    const cfg = makeConfig();
    writeTasks([baseTask({ engine: 'claude' })]);

    mockGetResourceSnapshot.mockResolvedValue(makeSnapshot([
      { backend: 'claude', availability: 'throttled' },
      { backend: 'codex',  availability: 'open' },
    ]));
    mockResolveEngineSpec.mockImplementation((engine: string) => ({
      id: engine,
      kind: 'cli-agent',
      tier: 'frontier',
    }));

    const { runSimpleConductor } = await import('../src/core/simple-conductor.js');
    const result = await runSimpleConductor(cfg, { once: true, dryRun: false, allowCloud: false });

    expect(result.errors).toHaveLength(0);
    expect(result.proposalsFiled).toBe(1);
    expect(mockRunEngineSandboxed).toHaveBeenCalledOnce();
    const [calledEngine] = mockRunEngineSandboxed.mock.calls[0]!;
    expect(calledEngine).toBe('codex');
  });
});

// ---------------------------------------------------------------------------
// [D2] Available claude → no reroute
// ---------------------------------------------------------------------------

describe('M300 [D2] available claude → no reroute', () => {
  it('uses claude when it is open', async () => {
    const cfg = makeConfig();
    writeTasks([baseTask({ engine: 'claude' })]);

    mockGetResourceSnapshot.mockResolvedValue(makeSnapshot([
      { backend: 'claude', availability: 'open' },
      { backend: 'codex',  availability: 'open' },
    ]));

    const { runSimpleConductor } = await import('../src/core/simple-conductor.js');
    await runSimpleConductor(cfg, { once: true, dryRun: false, allowCloud: false });

    const [calledEngine] = mockRunEngineSandboxed.mock.calls[0]!;
    expect(calledEngine).toBe('claude');
  });
});

// ---------------------------------------------------------------------------
// [D3] resourceAwareDispatch=false → no reroute (flag-off = byte-identical)
// ---------------------------------------------------------------------------

describe('M300 [D3] resourceAwareDispatch=false → no reroute', () => {
  it('uses original engine when flag is off, even if exhausted', async () => {
    const cfg = makeConfig({ resourceAwareDispatch: false });
    writeTasks([baseTask({ engine: 'claude' })]);

    // snapshot says claude exhausted
    mockGetResourceSnapshot.mockResolvedValue(makeSnapshot([
      { backend: 'claude', availability: 'exhausted' },
      { backend: 'codex',  availability: 'open' },
    ]));

    const { runSimpleConductor } = await import('../src/core/simple-conductor.js');
    await runSimpleConductor(cfg, { once: true, dryRun: false, allowCloud: false });

    const [calledEngine] = mockRunEngineSandboxed.mock.calls[0]!;
    // flag off → use original engine
    expect(calledEngine).toBe('claude');
  });
});

// ---------------------------------------------------------------------------
// [D4] All fallbacks exhausted → original engine used as last resort (never throws)
// ---------------------------------------------------------------------------

describe('M300 [D4] all fallbacks exhausted → degrades gracefully', () => {
  it('uses original engine when all fallbacks are also exhausted', async () => {
    const cfg = makeConfig({ engineFallbackOrder: ['codex', 'kimi'] });
    writeTasks([baseTask({ engine: 'claude' })]);

    mockGetResourceSnapshot.mockResolvedValue(makeSnapshot([
      { backend: 'claude', availability: 'exhausted' },
      { backend: 'codex',  availability: 'exhausted' },
      { backend: 'kimi',   availability: 'exhausted' },
    ]));

    const { runSimpleConductor } = await import('../src/core/simple-conductor.js');
    const result = await runSimpleConductor(cfg, { once: true, dryRun: false, allowCloud: false });

    // Should not throw, should still dispatch
    expect(result.errors).toHaveLength(0);
    expect(mockRunEngineSandboxed).toHaveBeenCalledOnce();
    // Falls back to original engine (claude) as last resort
    const [calledEngine] = mockRunEngineSandboxed.mock.calls[0]!;
    expect(calledEngine).toBe('claude');
  });
});

// ---------------------------------------------------------------------------
// [D5] api-model fallback → runApiModelSandboxed called, NOT runEngineSandboxed
// ---------------------------------------------------------------------------

describe('M300 [D5] api-model fallback → uses runApiModelSandboxed', () => {
  it('routes to runApiModelSandboxed when fallback engine kind is api-model', async () => {
    const cfg = makeConfig({ engineFallbackOrder: ['nim', 'codex'] });
    writeTasks([baseTask({ engine: 'claude' })]);

    mockGetResourceSnapshot.mockResolvedValue(makeSnapshot([
      { backend: 'claude', availability: 'exhausted' },
      { backend: 'nim',    availability: 'open' },
    ]));
    // nim is an api-model
    mockResolveEngineSpec.mockImplementation((engine: string) => ({
      id: engine,
      kind: engine === 'nim' ? 'api-model' : 'cli-agent',
      tier: engine === 'nim' ? 'mid' : 'frontier',
    }));

    const { runSimpleConductor } = await import('../src/core/simple-conductor.js');
    const result = await runSimpleConductor(cfg, { once: true, dryRun: false, allowCloud: false });

    expect(result.errors).toHaveLength(0);
    expect(mockRunApiModelSandboxed).toHaveBeenCalledOnce();
    expect(mockRunEngineSandboxed).not.toHaveBeenCalled();
    const [calledEngine] = mockRunApiModelSandboxed.mock.calls[0]!;
    expect(calledEngine).toBe('nim');
  });
});

// ---------------------------------------------------------------------------
// [F1]-[F4] isFrontierJudge — frontier model predicate
// ---------------------------------------------------------------------------

describe('M300 [F] isFrontierJudge frontier predicate', () => {
  // Import directly — no mocking needed, it's a pure function.
  // Use inline require to avoid hoisting issues.
  let isFrontierJudge: (s: string | undefined) => boolean;

  beforeEach(async () => {
    const mod = await import('../src/core/inbox/merge.js');
    isFrontierJudge = mod.isFrontierJudge;
  });

  it('[F1] accepts gpt-5.5', () => {
    expect(isFrontierJudge('gpt-5.5')).toBe(true);
  });

  it('[F1] accepts gpt-5-mini (prefix gpt-5)', () => {
    expect(isFrontierJudge('gpt-5-mini')).toBe(true);
  });

  it('[F2] accepts codex-v2', () => {
    expect(isFrontierJudge('codex-v2')).toBe(true);
  });

  it('[F2] accepts bare "codex"', () => {
    expect(isFrontierJudge('codex')).toBe(true);
  });

  it('[F3] rejects qwen2.5:72b-instruct-q4_K_M', () => {
    expect(isFrontierJudge('qwen2.5:72b-instruct-q4_K_M')).toBe(false);
  });

  it('[F3] rejects "local"', () => {
    expect(isFrontierJudge('local')).toBe(false);
  });

  it('[F3] rejects "nim"', () => {
    expect(isFrontierJudge('nim')).toBe(false);
  });

  it('[F3] rejects "kimi"', () => {
    expect(isFrontierJudge('kimi')).toBe(false);
  });

  it('[F3] rejects "moonshotai/kimi-k2.6"', () => {
    expect(isFrontierJudge('moonshotai/kimi-k2.6')).toBe(false);
  });

  it('[F3] rejects undefined', () => {
    expect(isFrontierJudge(undefined)).toBe(false);
  });

  it('[F3] rejects gpt-4 (not gpt-5 prefix)', () => {
    // gpt-4 is NOT accepted — only gpt-5+ is frontier tier
    expect(isFrontierJudge('gpt-4')).toBe(false);
  });

  it('[F4] accepts claude-opus-4-8', () => {
    expect(isFrontierJudge('claude-opus-4-8')).toBe(true);
  });

  it('[F4] accepts claude-sonnet-4-5', () => {
    expect(isFrontierJudge('claude-sonnet-4-5')).toBe(true);
  });

  it('[F4] accepts claude-3-haiku (contains claude)', () => {
    expect(isFrontierJudge('claude-3-haiku')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// [A1] Codex ship attestation accepted by evaluateVerificationGate
// ---------------------------------------------------------------------------

describe('M300 [A1] codex ship attestation → evaluateVerificationGate accepts gpt-5.5', () => {
  it('accepts a valid HMAC-signed codex attestation (gpt-5.5 judge)', async () => {
    const { evaluateVerificationGate } = await import('../src/core/inbox/merge.js');
    const { signJudgeAttestation, hashDiff, signProvenance } = await import('../src/core/foundry/provenance.js');

    // Minimal proper unified diff: proper --- / +++ headers so classifyRisk parses it as a
    // source file change (medium risk) rather than 'empty diff → high risk'.
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index 0000000..1111111 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -0,0 +1 @@',
      '+export const x = 1;',
    ].join('\n') + '\n';
    const diffHash = hashDiff(diff);
    const judgeEngine = 'gpt-5.5';
    const proposalId = 'prop-m300-a1';

    // Sign an attestation as a gpt-5.5 (Codex) judge
    const judgeAttestation = signJudgeAttestation({ proposalId, judgeEngine, verdict: 'ship', diffHash });

    const mergeAuthority = [{ engine: 'codex', model: 'gpt-5.5' }];
    const provenanceSig = signProvenance('codex:gpt-5.5', 'frontier', diffHash);

    const proposal = {
      id: proposalId,
      title: 'M300 codex attestation test',
      summary: 'test',
      kind: 'fix' as const,
      status: 'pending' as const,
      engineTier: 'frontier' as const,
      engineModel: 'codex:gpt-5.5',
      diff,
      diffHash,       // required by verifyProvenance criterion 5
      provenanceSig,
      verifyResult: { passed: true, output: 'all green' },
      createdAt: new Date().toISOString(),
    };

    const cfg = {
      version: 1,
      roots: [],
      editor: 'cursor',
      staleDays: 30,
      categories: {},
      tidyRules: [],
      keepers: [],
      models: { lmstudio: '', ollama: '', providerChain: [] },
      foundry: {
        autoMerge: { enabled: true, trustBasis: 'verification', maxRisk: 'medium' },
        mergeAuthority,
      },
    } as unknown as AshlrConfig;

    const decisions = [
      {
        action: 'judged',
        verdict: 'ship',
        engine: judgeEngine,
        model: judgeEngine,
        detail: 'would-merge',
        judgeAttestation,
      },
    ];

    const verdict = evaluateVerificationGate(proposal as never, cfg, decisions);
    expect(verdict.authorized).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// [S1] Non-frontier judge → evaluateVerificationGate refuses
// ---------------------------------------------------------------------------

describe('M300 [S1] non-frontier judge → evaluateVerificationGate refuses', () => {
  it('refuses qwen2.5:72b as frontier judge (self-confirmation trap)', async () => {
    const { evaluateVerificationGate } = await import('../src/core/inbox/merge.js');
    const { hashDiff, signProvenance } = await import('../src/core/foundry/provenance.js');

    const diff = 'diff --git a/foo.ts b/foo.ts\n+export const x = 1;\n';
    const diffHash = hashDiff(diff);
    const judgeEngine = 'qwen2.5:72b-instruct-q4_K_M';
    const proposalId = 'prop-m300-s1';

    const mergeAuthority = [{ engine: 'codex', model: 'gpt-5.5' }];
    const provenanceSig = signProvenance('codex:gpt-5.5', 'frontier', diffHash);

    const proposal = {
      id: proposalId,
      title: 'M300 non-frontier judge test',
      summary: 'test',
      kind: 'fix' as const,
      status: 'pending' as const,
      engineTier: 'frontier' as const,
      engineModel: 'codex:gpt-5.5',
      diff,
      provenanceSig,
      verifyResult: { passed: true, output: 'all green' },
      createdAt: new Date().toISOString(),
    };

    const cfg = {
      version: 1,
      roots: [],
      editor: 'cursor',
      staleDays: 30,
      categories: {},
      tidyRules: [],
      keepers: [],
      models: { lmstudio: '', ollama: '', providerChain: [] },
      foundry: {
        autoMerge: { enabled: true, trustBasis: 'verification' },
        mergeAuthority,
      },
    } as unknown as AshlrConfig;

    // No valid HMAC attestation — qwen judge cannot produce one
    const decisions = [
      {
        action: 'judged',
        verdict: 'ship',
        engine: judgeEngine,
        model: judgeEngine,
        detail: 'would-merge',
        judgeAttestation: undefined,
      },
    ];

    const verdict = evaluateVerificationGate(proposal as never, cfg, decisions);
    expect(verdict.authorized).toBe(false);
    expect(verdict.reason).toMatch(/not a frontier/i);
  });
});

// ---------------------------------------------------------------------------
// [J1] managerJudgeEngine='codex' → resolveFrontierJudgeClient returns codex client
// ---------------------------------------------------------------------------

describe('M300 [J1] managerJudgeEngine=codex → codex judge client', () => {
  it('returns a non-null client with gpt-5.5 model when codex installed', async () => {
    // Mock engineInstalled to return true for codex, false for claude
    vi.mock('../src/core/run/engines.js', () => ({
      engineInstalled: (engine: string) => engine === 'codex',
      buildEngineCommand: vi.fn(() => ({ bin: 'codex', argv: ['exec', '--json', 'test'] })),
      spawnEngine: vi.fn(async () => ({ ok: true, output: 'codex output' })),
    }));

    const { resolveFrontierJudgeClient } = await import('../src/core/fleet/manager.js');

    const cfg = {
      version: 1,
      roots: [],
      editor: 'cursor',
      staleDays: 30,
      categories: {},
      tidyRules: [],
      keepers: [],
      models: { lmstudio: '', ollama: '', providerChain: [] },
      foundry: {
        managerJudgeEngine: 'codex',
        managerJudgeModel: 'gpt-5.5',
        autoMerge: { enabled: false },
      },
    } as unknown as AshlrConfig;

    const client = resolveFrontierJudgeClient(cfg);
    expect(client).not.toBeNull();
    expect(client!.model).toMatch(/gpt-5/);
  });
});

// ---------------------------------------------------------------------------
// [J2] auto + claude exhausted → resolveFrontierJudgeClient falls to codex
// ---------------------------------------------------------------------------

describe('M300 [J2] auto + claude exhausted → codex judge fallback', () => {
  it('selects codex when managerJudgeEngine=auto and claude is exhausted per snapshot cache', async () => {
    // The peekBackendAvailability mock controls the cache peek
    const { peekBackendAvailability } = await import('../src/core/fabric/resource-monitor.js');
    vi.mocked(peekBackendAvailability).mockImplementation((backend) =>
      backend === 'claude' ? 'exhausted' : 'open'
    );

    vi.mock('../src/core/run/engines.js', () => ({
      engineInstalled: (engine: string) => engine === 'codex' || engine === 'claude',
      buildEngineCommand: vi.fn(() => ({ bin: 'codex', argv: ['exec', '--json', 'test'] })),
      spawnEngine: vi.fn(async () => ({ ok: true, output: 'codex output' })),
    }));

    const { resolveFrontierJudgeClient } = await import('../src/core/fleet/manager.js');

    const cfg = {
      version: 1,
      roots: [],
      editor: 'cursor',
      staleDays: 30,
      categories: {},
      tidyRules: [],
      keepers: [],
      models: { lmstudio: '', ollama: '', providerChain: [] },
      foundry: {
        managerJudgeEngine: 'auto',
        managerJudgeModel: 'gpt-5.5',
        autoMerge: { enabled: false },
      },
    } as unknown as AshlrConfig;

    const client = resolveFrontierJudgeClient(cfg);
    expect(client).not.toBeNull();
    // When claude is exhausted, should fall to codex → gpt-5.5 model
    expect(client!.model).toMatch(/gpt-5/);
  });
});
