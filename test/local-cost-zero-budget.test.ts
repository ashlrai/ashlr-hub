/**
 * local-cost-zero-budget.test.ts — local execution costs zero on EVERY path,
 * and a run can be bounded without dollars.
 *
 * ── THE BUG ────────────────────────────────────────────────────────────────
 * `estCostUsd` used to gate on `LOCAL_PROVIDERS = {'ollama', 'lmstudio'}`.
 * `src/core/run/sandboxed-engine.ts` — the daemon's dispatch path — calls it
 * with an ENGINE id instead: 'llama-server', 'local-coder', 'builtin',
 * 'ashlrcode', 'aw'. None were in that set and none are in the price table, so
 * every local run landed on the conservative $3/$15-per-Mtok fallback. A free
 * overnight fleet run billed itself at frontier rates and halted itself on an
 * imaginary dollar budget.
 *
 * Test groups:
 *
 *   1. DRIFT GUARD — driven by the resolved engine registry, not by a list in
 *      this file. Every engine `engineLocality` calls local must price at zero,
 *      including an engine that does not exist yet.
 *   2. DAEMON CALL PATH (api-model) — a real `runApiModelSandboxed` round trip
 *      for 'local-coder' reports estCostUsd 0, with 'nim' as the billable
 *      control that proves the assertion can fail.
 *   3. DAEMON CALL PATH (cli-agent) — a real `runEngineSandboxed` round trip
 *      for 'aw' reports 0, with 'claude' as the billable control.
 *   4. NON-DOLLAR BUDGETS — token-bounded, iteration-bounded and
 *      deadline-bounded runs stop at exactly the right point.
 *   5. THE ZERO TRAP — a $0 daily cap still means STOPPED, even when
 *      everything about to run is free.
 *   6. perItemMaxTokens — neither collapses nor explodes once local cost is 0.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  estCostUsd,
  isFreeSubject,
  anyBillableSubject,
  budgetVerdict,
  overBudget,
  dollarCapVerdict,
  perItemMaxTokens,
  MIN_PER_ITEM_MAX_TOKENS,
  DEFAULT_USD_PER_MTOKEN_OUT,
} from '../src/core/run/budget.js';
import { resolveEngineRegistry } from '../src/core/run/engine-registry.js';
import { engineLocality } from '../src/core/policy/local-only.js';
import type { AshlrConfig, RunBudget, RunUsage } from '../src/core/types.js';
import type { InboxStore } from '../src/core/seams/inbox.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function usage(tokensIn: number, tokensOut: number, steps = 0): RunUsage {
  return { tokensIn, tokensOut, steps, estCostUsd: 0 };
}

function budget(over: Partial<RunBudget> = {}): RunBudget {
  return { maxTokens: Infinity, maxSteps: Infinity, allowCloud: false, ...over };
}

/**
 * An engine that does not exist in the builtin roster, declared by an operator
 * against a loopback endpoint. Nothing in budget.ts knows its name.
 */
const FUTURE_LOCAL_ENGINE = 'ashlr-future-local';

function cfgWithFutureLocalEngine(): AshlrConfig {
  return {
    foundry: {
      engines: {
        [FUTURE_LOCAL_ENGINE]: {
          id: FUTURE_LOCAL_ENGINE,
          kind: 'api-model',
          tier: 'mid',
          api: {
            envKey: '',
            defaultBaseUrl: 'http://127.0.0.1:9911/v1',
            defaultModel: 'whatever-comes-next',
            protocol: 'openai',
          },
          capabilities: ['agent', 'edit'],
        },
        // Same shape, REMOTE endpoint. Locality is decided by the endpoint, so
        // this one must still be priced — otherwise "derived" would just mean
        // "everything added is free".
        'ashlr-future-cloud': {
          id: 'ashlr-future-cloud',
          kind: 'api-model',
          tier: 'mid',
          api: {
            envKey: 'SOME_VENDOR_KEY',
            defaultBaseUrl: 'https://api.some-vendor.example/v1',
            defaultModel: 'whatever-comes-next',
            protocol: 'openai',
          },
          capabilities: ['agent', 'edit'],
        },
      },
    },
  } as unknown as AshlrConfig;
}

// ---------------------------------------------------------------------------
// 1. DRIFT GUARD — the registry drives the test, not a list in this file
// ---------------------------------------------------------------------------

describe('local execution costs zero — drift guard', () => {
  it('every engine the locality authority calls local prices at exactly 0', () => {
    // This loop is the guard. It enumerates NOTHING itself: it walks the
    // resolved registry and asks `engineLocality` — the codebase's single
    // authority — which entries are local. Adding a local engine to the
    // registry automatically extends this assertion. The only way to add one
    // that is silently priced as frontier is to make estCostUsd stop
    // delegating, which fails here immediately.
    const cfg = cfgWithFutureLocalEngine();
    const registry = resolveEngineRegistry(cfg);
    const localIds = Object.keys(registry).filter((id) => engineLocality(id, cfg) === 'local');

    // Sanity: the registry really does contain local engines, so a bug that
    // made `engineLocality` answer 'cloud' for everything cannot turn this
    // into a vacuous pass.
    expect(localIds.length).toBeGreaterThan(0);
    expect(localIds).toEqual(expect.arrayContaining(['builtin', 'local-coder', 'llama-server']));

    for (const id of localIds) {
      expect(
        estCostUsd(id, 1_000_000, 1_000_000, 500_000, 200_000, 100_000, { cfg }),
        `${id} is local and must cost exactly 0`,
      ).toBe(0);
    }
  });

  it('an engine that does not exist yet is free the moment it is declared on loopback', () => {
    const cfg = cfgWithFutureLocalEngine();
    // Nothing in budget.ts has ever heard of this id.
    expect(engineLocality(FUTURE_LOCAL_ENGINE, cfg)).toBe('local');
    expect(estCostUsd(FUTURE_LOCAL_ENGINE, 1_000_000, 1_000_000, 0, 0, 0, { cfg })).toBe(0);
    expect(isFreeSubject(FUTURE_LOCAL_ENGINE, cfg)).toBe(true);
  });

  it('a config-added engine on a REMOTE endpoint is still priced', () => {
    const cfg = cfgWithFutureLocalEngine();
    expect(engineLocality('ashlr-future-cloud', cfg)).toBe('cloud');
    expect(estCostUsd('ashlr-future-cloud', 1_000_000, 0, 0, 0, 0, { cfg })).toBeGreaterThan(0);
  });

  it('every EngineId the daemon treats as local-only costs 0 with no config at all', () => {
    // These are exactly the members of LOCAL_ONLY_BACKENDS in
    // src/core/daemon/loop.ts — the ids that reach estCostUsd through
    // sandboxed-engine.ts. Each was priced at the $3/$15 fallback before.
    for (const engine of ['builtin', 'local-coder', 'ashlrcode', 'aw', 'llama-server']) {
      expect(estCostUsd(engine, 1_000_000, 1_000_000), `${engine}`).toBe(0);
    }
  });

  it('fails closed: an unclassifiable subject is priced, never assumed free', () => {
    expect(isFreeSubject('some-engine-nobody-declared')).toBe(false);
    expect(estCostUsd('some-engine-nobody-declared', 1_000_000, 0)).toBeGreaterThan(0);
  });

  it('frontier engines are unaffected', () => {
    expect(estCostUsd('claude', 1_000_000, 0)).toBeGreaterThan(0);
    expect(estCostUsd('codex', 1_000_000, 0)).toBeGreaterThan(0);
    expect(estCostUsd('anthropic', 1_000_000, 0)).toBeGreaterThan(0);
    expect(estCostUsd('nim', 1_000_000, 0)).toBeGreaterThan(0);
  });

  it('anyBillableSubject answers the daemon question about a whole tick', () => {
    expect(anyBillableSubject(['builtin', 'local-coder', 'llama-server'])).toBe(false);
    expect(anyBillableSubject(['builtin', 'claude'])).toBe(true);
    // Nothing to charge is not billable.
    expect(anyBillableSubject([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Shared doubles for the two real dispatch paths
// ---------------------------------------------------------------------------

function durableInboxStore(proposalId: string): InboxStore {
  const proposals = new Map<string, Record<string, unknown>>();
  return {
    list: () => [...proposals.values()],
    create: (input: Record<string, unknown>) => {
      const proposal = {
        ...input,
        id: proposalId,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      proposals.set(proposalId, proposal);
      return structuredClone(proposal);
    },
    load: (id: string) => (proposals.get(id) ? structuredClone(proposals.get(id)!) : null),
    setStatus: (id: string, status: string, result?: string) => {
      const proposal = proposals.get(id);
      if (!proposal) return;
      proposals.set(id, { ...proposal, status, ...(result !== undefined ? { result } : {}) });
    },
    pendingCount: () => [...proposals.values()].filter((p) => p['status'] === 'pending').length,
  } as unknown as InboxStore;
}

const DIFF_PATCH =
  '--- a/hello.ts\n+++ b/hello.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;\n';

function mockSandboxSurface(repoPath: string): void {
  vi.doMock('../src/core/sandbox/policy.js', () => ({
    assertMayMutate: () => {},
    killSwitchOn: () => false,
  }));
  vi.doMock('../src/core/sandbox/mutation-fence.js', () => ({
    acquireOutwardMutationFence: () => ({}),
    acquireOutwardMutationFenceAsync: async () => ({}),
    ownsOutwardMutationFence: (fence: unknown) => fence !== null,
    releaseOutwardMutationFence: () => {},
  }));
  vi.doMock('../src/core/sandbox/worktree.js', () => {
    const double = {
      createSandbox: (repo: string) => ({
        id: 'sb-cost',
        worktreePath: repoPath,
        sourceRepo: repo,
        branch: 'ashlr-sandbox-cost',
      }),
      borrowSandboxCleanupAuthority: () => ({ outwardFence: {} }),
      removeSandbox: () => {},
      removeSandboxWithBorrowedAuthority: () => {},
      sandboxDiff: () => ({ files: 1, patch: DIFF_PATCH, insertions: 1, deletions: 1 }),
    };
    return {
      ...double,
      createSandboxAsync: async (...args: Parameters<typeof double.createSandbox>) =>
        double.createSandbox(...args),
    };
  });
  vi.doMock('../src/core/mcp-native-engineer.js', () => ({
    buildEngineerToolSpecs: () => [{ name: 'read_file', fn: async () => 'content' }],
  }));
  vi.doMock('../src/core/seams/inbox.js', () => ({
    selectInboxStore: () => durableInboxStore(`prop-${randomUUID().slice(0, 8)}`),
  }));
  vi.doMock('../src/core/knowledge/index.js', () => ({ scrubSecrets: (s: string) => s }));
  vi.doMock('../src/core/foundry/provenance.js', () => ({
    hashDiff: () => 'hash-cost',
    signProvenance: () => 'sig-cost',
  }));
  vi.doMock('../src/core/run/completeness-gate.js', () => ({
    runCompletenessGate: async () => ({ pass: true }),
  }));
}

/** Tokens both dispatch paths report, chosen so frontier pricing is clearly > 0. */
const TOKENS_IN = 400_000;
const TOKENS_OUT = 200_000;

// ---------------------------------------------------------------------------
// 2. DAEMON CALL PATH — api-model (`runApiModelSandboxed`, sandboxed-engine.ts)
// ---------------------------------------------------------------------------

describe('local execution costs zero — through runApiModelSandboxed', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'ashlr-cost-api-'));
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, 'hello.ts'), 'const x = 1;\n');
    mockSandboxSurface(repo);
    vi.doMock('../src/core/run/provider-client.js', () => ({
      buildOpenAICompatibleClient: () => ({
        id: 'openai-compat',
        model: 'test-model',
        supportsTools: true,
      }),
    }));
    vi.doMock('../src/core/run/agent-loop.js', () => ({
      runTask: async (
        task: { status: string; result?: string },
        _client: unknown,
        ctx: {
          reserveModelStep?: (n: number) => {
            finalize(summary: string, u?: { tokensIn: number; tokensOut: number }): void;
          } | undefined;
        },
      ) => {
        ctx.reserveModelStep?.(500)?.finalize('changed hello.ts', {
          tokensIn: TOKENS_IN,
          tokensOut: TOKENS_OUT,
        });
        task.status = 'done';
        task.result = 'Made the change.';
        return task;
      },
    }));
  });

  afterEach(() => {
    try { rmSync(repo, { recursive: true, force: true }); } catch { /* ok */ }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function dispatch(engine: string): Promise<number> {
    const { runApiModelSandboxed } = (await import(
      '../src/core/run/sandboxed-engine.js?bust=' + randomUUID()
    )) as typeof import('../src/core/run/sandboxed-engine.js');

    const cfg = {
      models: { providerChain: [] },
      foundry: { completenessGate: false, dispatchRetries: 0, fleetMcp: false },
    } as never;

    const result = await runApiModelSandboxed(engine as never, 'increment x', cfg, {
      sourceRepo: repo,
      propose: true,
    });
    expect(result.state.usage.tokensIn).toBe(TOKENS_IN);
    return result.state.usage.estCostUsd;
  }

  it('local-coder reports estCostUsd 0 for 600k real tokens', async () => {
    expect(await dispatch('local-coder')).toBe(0);
  });

  it('CONTROL: nim (same code path, remote endpoint) reports a positive cost', async () => {
    // Without this the zero above would also pass if estCostUsd were stubbed
    // to return 0 for everything.
    expect(await dispatch('nim')).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. DAEMON CALL PATH — cli-agent (`runEngineSandboxed`, sandboxed-engine.ts)
// ---------------------------------------------------------------------------

describe('local execution costs zero — through runEngineSandboxed', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'ashlr-cost-cli-'));
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, 'hello.ts'), 'const x = 1;\n');
    mockSandboxSurface(repo);
    vi.doMock('../src/core/run/engines.js', () => ({
      buildEngineCommand: () => ({ bin: 'mock-engine', args: [], cwd: repo }),
      describeRunEventForStream: () => null,
      spawnEngine: async () => ({
        ok: true,
        output: 'done',
        usage: { tokensIn: TOKENS_IN, tokensOut: TOKENS_OUT },
      }),
    }));
    vi.doMock('../src/core/run/agent-diagnostics.js', () => ({
      classifyAgentDiagnosticError: () => 'execution',
      measureAgentDiagnosticText: () => ({ present: false, bytes: 0, lines: 0, truncated: false }),
      recordAgentDiagnostic: () => {},
    }));
  });

  afterEach(() => {
    try { rmSync(repo, { recursive: true, force: true }); } catch { /* ok */ }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function dispatch(engine: string): Promise<number> {
    const { runEngineSandboxed } = (await import(
      '../src/core/run/sandboxed-engine.js?bust=' + randomUUID()
    )) as typeof import('../src/core/run/sandboxed-engine.js');

    const cfg = {
      models: { providerChain: [] },
      foundry: { completenessGate: false, dispatchRetries: 0, fleetMcp: false },
    } as never;

    const result = await runEngineSandboxed(engine as never, 'increment x', cfg, {
      sourceRepo: repo,
      propose: true,
    });
    expect(result.state.usage.tokensIn).toBe(TOKENS_IN);
    return result.state.usage.estCostUsd;
  }

  it('aw — a local CLI agent — reports estCostUsd 0', async () => {
    expect(await dispatch('aw')).toBe(0);
  });

  it('CONTROL: claude (same code path, vendor API) reports a positive cost', async () => {
    expect(await dispatch('claude')).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4. NON-DOLLAR BUDGETS — a run bounded by tokens, iterations, or a deadline
// ---------------------------------------------------------------------------

describe('budgetVerdict — a token-bounded run stops at the right point', () => {
  it('is not exhausted one token below the ceiling', () => {
    const v = budgetVerdict({ usage: usage(600, 399) }, budget({ maxTokens: 1000 }));
    expect(v.exhausted).toBe(false);
    expect(v.limiter).toBeNull();
  });

  it('is exhausted exactly AT the ceiling, not one token past it', () => {
    const v = budgetVerdict({ usage: usage(600, 400) }, budget({ maxTokens: 1000 }));
    expect(v.exhausted).toBe(true);
    expect(v.limiter).toBe('tokens');
    expect(v.reason).toContain('1000');
  });

  it('counts input and output together', () => {
    expect(budgetVerdict({ usage: usage(1000, 0) }, budget({ maxTokens: 1000 })).exhausted).toBe(true);
    expect(budgetVerdict({ usage: usage(0, 1000) }, budget({ maxTokens: 1000 })).exhausted).toBe(true);
  });

  it('an Infinity ceiling never fires', () => {
    expect(budgetVerdict({ usage: usage(1e12, 1e12) }, budget()).exhausted).toBe(false);
  });
});

describe('budgetVerdict — an iteration-bounded run stops at the right point', () => {
  const b = budget({ maxIterations: 3 });

  it('runs while iterations remain', () => {
    expect(budgetVerdict({ usage: usage(0, 0), iterations: 2 }, b).exhausted).toBe(false);
  });

  it('stops on the iteration that reaches the ceiling', () => {
    const v = budgetVerdict({ usage: usage(0, 0), iterations: 3 }, b);
    expect(v.exhausted).toBe(true);
    expect(v.limiter).toBe('iterations');
  });

  it('bounds a run that spends no tokens and no dollars at all', () => {
    // The whole point: a free local fleet is still bounded.
    let iterations = 0;
    const free = budget({ maxIterations: 5 });
    while (!budgetVerdict({ usage: usage(0, 0), iterations }, free).exhausted) {
      iterations += 1;
      if (iterations > 100) throw new Error('unbounded loop — the ceiling did not bind');
    }
    expect(iterations).toBe(5);
  });

  it('an absent iteration count cannot trip the ceiling', () => {
    expect(budgetVerdict({ usage: usage(0, 0) }, b).exhausted).toBe(false);
  });
});

describe('budgetVerdict — a deadline-bounded run stops at the right point', () => {
  const T0 = 1_700_000_000_000;

  it('runs up to the instant before the deadline', () => {
    const b = budget({ deadlineEpochMs: T0 + 5000 });
    expect(budgetVerdict({ usage: usage(0, 0), nowMs: T0 + 4999 }, b).exhausted).toBe(false);
  });

  it('stops AT the deadline', () => {
    const b = budget({ deadlineEpochMs: T0 + 5000 });
    const v = budgetVerdict({ usage: usage(0, 0), nowMs: T0 + 5000 }, b);
    expect(v.exhausted).toBe(true);
    expect(v.limiter).toBe('deadline');
  });

  it('maxWallClockMs is measured from startedAtMs', () => {
    const b = budget({ maxWallClockMs: 60_000 });
    expect(
      budgetVerdict({ usage: usage(0, 0), nowMs: T0 + 59_999, startedAtMs: T0 }, b).exhausted,
    ).toBe(false);
    expect(
      budgetVerdict({ usage: usage(0, 0), nowMs: T0 + 60_000, startedAtMs: T0 }, b).exhausted,
    ).toBe(true);
  });

  it('maxWallClockMs without a startedAtMs cannot fire', () => {
    const b = budget({ maxWallClockMs: 1 });
    expect(budgetVerdict({ usage: usage(0, 0), nowMs: T0 }, b).exhausted).toBe(false);
  });

  it('is pure — no ambient clock, same inputs give the same answer', () => {
    const b = budget({ deadlineEpochMs: T0 });
    const a = budgetVerdict({ usage: usage(0, 0), nowMs: T0 - 1 }, b);
    const c = budgetVerdict({ usage: usage(0, 0), nowMs: T0 - 1 }, b);
    expect(a).toStrictEqual(c);
  });
});

describe('budgetVerdict — limiter precedence and overBudget compatibility', () => {
  it('names tokens first when several ceilings are met at once', () => {
    const v = budgetVerdict(
      { usage: usage(1000, 0, 50), iterations: 99, nowMs: 2 },
      budget({ maxTokens: 1000, maxSteps: 1, maxIterations: 1, deadlineEpochMs: 1 }),
    );
    expect(v.limiter).toBe('tokens');
  });

  it('overBudget is unchanged for the token/step dimensions', () => {
    const b: RunBudget = { maxTokens: 1000, maxSteps: 10, allowCloud: false };
    expect(overBudget(usage(500, 499, 9), b)).toBe(false);
    expect(overBudget(usage(500, 500, 9), b)).toBe(true);
    expect(overBudget(usage(0, 0, 10), b)).toBe(true);
  });

  it('overBudget cannot fire the iteration or deadline ceilings — it carries neither', () => {
    // Documents the boundary: a caller that sets those MUST use budgetVerdict.
    const b = budget({ maxIterations: 0, deadlineEpochMs: 0 });
    expect(overBudget(usage(0, 0), b)).toBe(false);
    expect(budgetVerdict({ usage: usage(0, 0), iterations: 0 }, b).exhausted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. THE ZERO TRAP — $0 means STOPPED even when the work is free
// ---------------------------------------------------------------------------

describe('dollarCapVerdict — zero is a choice, not an absence', () => {
  it('a $0 cap is STOPPED even when nothing about to run is billable', () => {
    // The tempting bug: "local is free, so a $0 cap shouldn't stop it."
    // The cockpit says the loop is stopped; running anyway would make it lie.
    const v = dollarCapVerdict({ dailyBudgetUsd: 0, spentUsd: 0, billable: false });
    expect(v.kind).toBe('stopped');
  });

  it('a $0 cap is STOPPED for billable work too', () => {
    expect(dollarCapVerdict({ dailyBudgetUsd: 0, spentUsd: 0, billable: true }).kind).toBe('stopped');
  });

  it('negative and non-finite caps fail closed to stopped', () => {
    expect(dollarCapVerdict({ dailyBudgetUsd: -1, spentUsd: 0, billable: true }).kind).toBe('stopped');
    expect(dollarCapVerdict({ dailyBudgetUsd: NaN, spentUsd: 0, billable: true }).kind).toBe('stopped');
  });

  it('a positive cap over free work is NOT-APPLICABLE, not exhausted', () => {
    // This is the state a local-only run lives in: dollars cannot bound it, so
    // the non-monetary limiters do. It is NOT the same state as stopped.
    const v = dollarCapVerdict({ dailyBudgetUsd: 1, spentUsd: 0, billable: false });
    expect(v.kind).toBe('not-applicable');
  });

  it('spend never exhausts a not-applicable cap', () => {
    const v = dollarCapVerdict({ dailyBudgetUsd: 1, spentUsd: 999, billable: false });
    expect(v.kind).toBe('not-applicable');
  });

  it('a positive cap over billable work is enforced with real headroom', () => {
    const v = dollarCapVerdict({ dailyBudgetUsd: 1, spentUsd: 0.25, billable: true });
    expect(v).toStrictEqual({ kind: 'enforced', remainingUsd: 0.75 });
  });

  it('headroom never goes negative', () => {
    const v = dollarCapVerdict({ dailyBudgetUsd: 1, spentUsd: 5, billable: true });
    expect(v).toStrictEqual({ kind: 'enforced', remainingUsd: 0 });
  });
});

// ---------------------------------------------------------------------------
// 6. perItemMaxTokens — neither collapses nor explodes
// ---------------------------------------------------------------------------

describe('perItemMaxTokens', () => {
  const enforced = dollarCapVerdict({ dailyBudgetUsd: 1, spentUsd: 0, billable: true });
  const free = dollarCapVerdict({ dailyBudgetUsd: 1, spentUsd: 0, billable: false });
  const stopped = dollarCapVerdict({ dailyBudgetUsd: 0, spentUsd: 0, billable: false });

  it('reproduces the daemon arithmetic exactly for billable work', () => {
    // loop.ts: floor((remaining / items / 15.0) * 1e6), floored at 1000.
    const items = 4;
    const expected = Math.max(
      1000,
      Math.floor((1 / items / DEFAULT_USD_PER_MTOKEN_OUT) * 1_000_000),
    );
    expect(perItemMaxTokens({ items, budget: budget(), cap: enforced })).toBe(expected);
  });

  it('keeps the floor when the dollar headroom is tiny', () => {
    const cap = dollarCapVerdict({ dailyBudgetUsd: 0.000001, spentUsd: 0, billable: true });
    expect(perItemMaxTokens({ items: 100, budget: budget(), cap })).toBe(MIN_PER_ITEM_MAX_TOKENS);
  });

  it('derives from RunBudget.maxTokens — not dollars — when nothing is billable', () => {
    expect(
      perItemMaxTokens({ items: 4, budget: budget({ maxTokens: 400_000 }), cap: free }),
    ).toBe(100_000);
  });

  it('does not EXPLODE: an unbounded maxTokens yields the floor, never Infinity', () => {
    const n = perItemMaxTokens({ items: 4, budget: budget({ maxTokens: Infinity }), cap: free });
    expect(Number.isFinite(n)).toBe(true);
    expect(n).toBe(MIN_PER_ITEM_MAX_TOKENS);
  });

  it('does not COLLAPSE: zero items or zero tokens still yields the floor', () => {
    expect(perItemMaxTokens({ items: 0, budget: budget({ maxTokens: 0 }), cap: free }))
      .toBe(MIN_PER_ITEM_MAX_TOKENS);
    expect(perItemMaxTokens({ items: 0, budget: budget(), cap: enforced }))
      .toBeGreaterThanOrEqual(MIN_PER_ITEM_MAX_TOKENS);
  });

  it('always returns a finite integer at or above the floor', () => {
    for (const cap of [enforced, free, stopped]) {
      for (const items of [0, 1, 7, 1000]) {
        const n = perItemMaxTokens({ items, budget: budget({ maxTokens: 1_000 }), cap });
        expect(Number.isInteger(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(MIN_PER_ITEM_MAX_TOKENS);
      }
    }
  });

  it('a stopped cap yields the floor, not 0 and not Infinity', () => {
    expect(perItemMaxTokens({ items: 4, budget: budget(), cap: stopped }))
      .toBe(MIN_PER_ITEM_MAX_TOKENS);
  });
});
