/**
 * local-cost-zero-budget.test.ts — free execution costs zero on EVERY path,
 * and a run can be bounded without dollars.
 *
 * ── THE BUG ────────────────────────────────────────────────────────────────
 * `estCostUsd` used to gate on `LOCAL_PROVIDERS = {'ollama', 'lmstudio'}`.
 * `src/core/run/sandboxed-engine.ts` — the daemon's dispatch path — calls it
 * with an ENGINE id instead: 'llama-server', 'local-coder', 'builtin'. None
 * were in that set and none are in the price table, so every such run landed on
 * the conservative $3/$15-per-Mtok fallback. A free overnight fleet run billed
 * itself at frontier rates and halted itself on an imaginary dollar budget.
 *
 * ── WHY THIS FILE ASKS METEREDNESS, NOT LOCALITY ───────────────────────────
 * The obvious repair — "route the question through `engineLocality`" — is worse
 * than the bug. `ashlrcode` is a LOCAL process that the hub hands working
 * subscription credentials, and `aw`'s cloud fallback lives in a config this
 * hub does not read. Pricing either at $0 because it runs here would turn a
 * visible wrong number into an invisible zero, and a zero ends scrutiny where a
 * wrong number invites it. So every free/zero assertion below is written
 * against `Meteredness` — "can this bill you" — and `docs/LOCALITY-VS-SPEND.md`
 * is why. §1c pins the disagreement between the two axes directly.
 *
 * Test groups:
 *
 *   1. DRIFT GUARD — driven by the resolved engine registry, not by a list in
 *      this file. Every engine the policy calls `'free'` must price at exactly
 *      zero, everything else must price above it, including an engine that does
 *      not exist yet.
 *   1b. HOT PATH — the classification is resolved once per (config, id).
 *   1c. THE AXES DISAGREE — local, and still priced.
 *   2. DAEMON CALL PATH (api-model) — a real `runApiModelSandboxed` round trip
 *      for 'local-coder' reports estCostUsd 0, with 'nim' as the billable
 *      control that proves the assertion can fail.
 *   3. DAEMON CALL PATH (cli-agent) — a real `runEngineSandboxed` round trip
 *      for 'aw' reports a POSITIVE cost, because a local binary that picks its
 *      own backend is not something this hub can call free.
 *   4. NON-DOLLAR BUDGETS — token-bounded, iteration-bounded and
 *      deadline-bounded runs stop at exactly the right point.
 *   5. THE ZERO TRAP — a $0 daily cap still means STOPPED, even when
 *      everything about to run is free.
 *   6. perItemMaxTokens — neither collapses nor explodes once free work is $0.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  estCostUsd,
  anyBillableSubject,
  budgetVerdict,
  overBudget,
  dollarCapVerdict,
  perItemMaxTokens,
  MIN_PER_ITEM_MAX_TOKENS,
  DEFAULT_USD_PER_MTOKEN_OUT,
  __resetBudgetMeterednessCacheForTests,
} from '../src/core/run/budget.js';
import { resolveEngineRegistry } from '../src/core/run/engine-registry.js';
import { engineLocality, engineMeteredness } from '../src/core/policy/local-only.js';
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
const FUTURE_FREE_ENGINE = 'ashlr-future-local';

function cfgWithFutureEngines(): AshlrConfig {
  return {
    foundry: {
      engines: {
        [FUTURE_FREE_ENGINE]: {
          id: FUTURE_FREE_ENGINE,
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
        // Same shape, REMOTE endpoint. Meteredness is decided by the endpoint,
        // so this one must still be priced — otherwise "derived" would just
        // mean "everything added is free".
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

beforeEach(() => {
  __resetBudgetMeterednessCacheForTests();
});

// ---------------------------------------------------------------------------
// 1. DRIFT GUARD — the registry drives the test, not a list in this file
// ---------------------------------------------------------------------------

describe('free execution costs zero — drift guard', () => {
  it('every engine the policy calls FREE prices at exactly 0, and nothing else does', () => {
    // This loop is the guard. It enumerates NOTHING itself: it walks the
    // resolved registry and asks `engineMeteredness` — the codebase's single
    // authority on spend — which entries are free. Adding an engine to the
    // registry automatically extends both assertions. The only way to add one
    // that is silently priced as frontier, or silently priced at nothing, is to
    // make estCostUsd stop delegating, which fails here immediately.
    const cfg = cfgWithFutureEngines();
    const registry = resolveEngineRegistry(cfg);
    const ids = Object.keys(registry);
    const free = ids.filter((id) => engineMeteredness(id, cfg) === 'free');
    const priced = ids.filter((id) => engineMeteredness(id, cfg) !== 'free');

    // Sanity: the registry really does contain both kinds, so a bug that made
    // `engineMeteredness` answer one way for everything cannot turn either
    // assertion into a vacuous pass.
    expect(free.length).toBeGreaterThan(0);
    expect(priced.length).toBeGreaterThan(0);
    expect(free).toEqual(expect.arrayContaining(['builtin', 'local-coder', 'llama-server']));

    for (const id of free) {
      expect(
        estCostUsd(id, 1_000_000, 1_000_000, 500_000, 200_000, 100_000, cfg),
        `${id} is provably free and must cost exactly 0`,
      ).toBe(0);
    }
    for (const id of priced) {
      expect(
        estCostUsd(id, 1_000_000, 1_000_000, 0, 0, 0, cfg),
        `${id} is not provably free and must not report $0`,
      ).toBeGreaterThan(0);
    }
  });

  it('an engine that does not exist yet is free the moment it is declared on loopback', () => {
    const cfg = cfgWithFutureEngines();
    // Nothing in budget.ts has ever heard of this id.
    expect(engineMeteredness(FUTURE_FREE_ENGINE, cfg)).toBe('free');
    expect(estCostUsd(FUTURE_FREE_ENGINE, 1_000_000, 1_000_000, 0, 0, 0, cfg)).toBe(0);
  });

  it('a config-added engine on a REMOTE endpoint is still priced', () => {
    const cfg = cfgWithFutureEngines();
    expect(engineMeteredness('ashlr-future-cloud', cfg)).toBe('metered');
    expect(estCostUsd('ashlr-future-cloud', 1_000_000, 0, 0, 0, 0, cfg)).toBeGreaterThan(0);
  });

  it('the free serving runtimes cost 0 with no config at all', () => {
    // These are the ids that reach estCostUsd through sandboxed-engine.ts and
    // that the policy can PROVE cost nothing. Each was priced at the $3/$15
    // fallback before.
    for (const engine of ['builtin', 'local-coder', 'llama-server']) {
      expect(estCostUsd(engine, 1_000_000, 1_000_000), `${engine}`).toBe(0);
    }
  });

  it('fails closed: an unclassifiable subject is priced, never assumed free', () => {
    expect(estCostUsd('some-engine-nobody-declared', 1_000_000, 0)).toBeGreaterThan(0);
  });

  it('frontier engines are unaffected', () => {
    expect(estCostUsd('claude', 1_000_000, 0)).toBeGreaterThan(0);
    expect(estCostUsd('codex', 1_000_000, 0)).toBeGreaterThan(0);
    expect(estCostUsd('anthropic', 1_000_000, 0)).toBeGreaterThan(0);
    expect(estCostUsd('nim', 1_000_000, 0)).toBeGreaterThan(0);
  });

  it('the cache does not change any answer', () => {
    const cfg = cfgWithFutureEngines();
    for (const id of ['claude', 'local-coder', FUTURE_FREE_ENGINE, 'ashlr-future-cloud', 'nim']) {
      const first = estCostUsd(id, 1_000_000, 0, 0, 0, 0, cfg);
      const second = estCostUsd(id, 1_000_000, 0, 0, 0, 0, cfg);
      expect(second, id).toBe(first);
      expect(second, id).toBe(engineMeteredness(id, cfg) === 'free' ? 0 : first);
    }
  });

  it('anyBillableSubject answers the daemon question about a whole tick', () => {
    expect(anyBillableSubject(['builtin', 'local-coder', 'llama-server'])).toBe(false);
    expect(anyBillableSubject(['builtin', 'claude'])).toBe(true);
    // 'unknown' is billable. We are not asserting it costs money; we are
    // refusing to assert that it does not.
    expect(anyBillableSubject(['builtin', 'aw'])).toBe(true);
    // Nothing to charge is not billable.
    expect(anyBillableSubject([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 1b. HOT PATH — the classification is resolved once, not once per call
// ---------------------------------------------------------------------------

describe('estCostUsd is cheap enough to sit on a per-step path', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('asks the spend authority once per (config, id) — never once per call', () => {
    // An uncached delegation would resolve the engine registry on every call,
    // and resolving it re-reads the llama-server ownership record from disk
    // (statSync + readFileSync). That would put a synchronous filesystem round
    // trip in the middle of every model step — not merely slow: it shifts
    // concurrent best-of-N candidate timing enough to expose a latent race in
    // test/m142.best-of-n.test.ts. An estimate function has no business doing
    // I/O per step.
    let resolutions = 0;
    vi.doMock('../src/core/policy/local-only.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/core/policy/local-only.js')>();
      return {
        ...actual,
        subjectMeteredness: (...args: Parameters<typeof actual.subjectMeteredness>) => {
          resolutions += 1;
          return actual.subjectMeteredness(...args);
        },
      };
    });

    return (async () => {
      const budgetModule = (await import(
        '../src/core/run/budget.js?hotpath=' + randomUUID()
      )) as typeof import('../src/core/run/budget.js');

      const cfg = cfgWithFutureEngines();
      const ids = ['claude', 'local-coder', FUTURE_FREE_ENGINE, 'nim'];

      for (const id of ids) budgetModule.estCostUsd(id, 10, 10, 0, 0, 0, cfg);
      expect(resolutions).toBe(ids.length);

      const afterWarmup = resolutions;
      for (let i = 0; i < 200; i += 1) {
        for (const id of ids) budgetModule.estCostUsd(id, 10, 10, 0, 0, 0, cfg);
      }
      expect(resolutions).toBe(afterWarmup);
    })();
  });
});

// ---------------------------------------------------------------------------
// 1c. THE AXES DISAGREE — local, and still priced
// ---------------------------------------------------------------------------

describe('a local process is not thereby a free one', () => {
  it('ashlrcode and aw run HERE and are still priced above zero', () => {
    // The whole reason this file asks meteredness. `ashlrcode` is spawned on
    // this machine with `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN` in
    // its environment and chooses its own backend afterwards; `aw`'s cloud
    // fallback lives in config this hub neither reads nor controls. Reporting
    // either at $0 would make a spend dashboard lie.
    for (const engine of ['ashlrcode', 'aw']) {
      expect(engineLocality(engine), `${engine} locality`).toBe('local');
      expect(engineMeteredness(engine), `${engine} meteredness`).not.toBe('free');
      expect(
        estCostUsd(engine, 1_000_000, 1_000_000),
        `${engine} runs locally but must never report $0`,
      ).toBeGreaterThan(0);
    }
  });

  it('and a free subject is free regardless of what locality says about it', () => {
    // The converse direction, so this is a statement about two axes rather
    // than a one-way exception carved out for two names.
    const cfg = cfgWithFutureEngines();
    expect(engineLocality(FUTURE_FREE_ENGINE, cfg)).toBe('local');
    expect(engineMeteredness(FUTURE_FREE_ENGINE, cfg)).toBe('free');
    expect(estCostUsd(FUTURE_FREE_ENGINE, 1_000_000, 0, 0, 0, 0, cfg)).toBe(0);
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

describe('free execution costs zero — through runApiModelSandboxed', () => {
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

describe('a local CLI agent is still priced — through runEngineSandboxed', () => {
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

  it('aw — local, but its backend is its own choice — reports a POSITIVE cost', async () => {
    // The assertion this file originally made here was `toBe(0)`, on the
    // grounds that `aw` runs on this machine. That is the locality answer to a
    // spend question. `aw` opts into cloud fallback through its own .env, which
    // the hub does not read, so the honest classification is 'unknown' and the
    // honest price is the conservative estimate — visible, and wrong in the
    // safe direction.
    expect(await dispatch('aw')).toBeGreaterThan(0);
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

  it('DRIVES A LOOP: a free run spending 250 tokens a turn stops on turn 4 of 1000', () => {
    // Not just "the predicate says true" — an actual loop, with every turn
    // costing $0, halting on the exact turn the token ceiling binds.
    const b = budget({ maxTokens: 1000 });
    const live = usage(0, 0);
    let turns = 0;
    while (!budgetVerdict({ usage: live }, b).exhausted) {
      turns += 1;
      live.tokensIn += 150;
      live.tokensOut += 100;
      live.estCostUsd += estCostUsd('local-coder', 150, 100);
      if (turns > 100) throw new Error('unbounded loop — the token ceiling did not bind');
    }
    expect(turns).toBe(4);                       // 4 x 250 = 1000, exactly the ceiling
    expect(live.estCostUsd).toBe(0);             // and it cost nothing to get there
    expect(budgetVerdict({ usage: live }, b).limiter).toBe('tokens');
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
    // The whole point: a free fleet is still bounded.
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

  it('DRIVES A LOOP: a free run of 100ms turns stops on the turn that crosses the deadline', () => {
    const b = budget({ deadlineEpochMs: T0 + 1000 });
    let nowMs = T0;
    let turns = 0;
    while (!budgetVerdict({ usage: usage(0, 0), nowMs }, b).exhausted) {
      turns += 1;
      nowMs += 100;
      if (turns > 100) throw new Error('unbounded loop — the deadline did not bind');
    }
    expect(turns).toBe(10);       // T0+1000 is the first `now` at the deadline
    expect(nowMs).toBe(T0 + 1000);
    expect(budgetVerdict({ usage: usage(0, 0), nowMs }, b).limiter).toBe('deadline');
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
    // The tempting bug: "this work is free, so a $0 cap shouldn't stop it."
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
    // This is the state a provably-free run lives in: dollars cannot bound it,
    // so the non-monetary limiters do. It is NOT the same state as stopped.
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

  it('billability is a METEREDNESS question, so a local agent keeps the cap enforced', () => {
    // Wiring `billable` off locality would make a tick of pure `ashlrcode` work
    // read as not-applicable and run uncapped against real credentials. This
    // pins the composition the daemon is told to use.
    const cap = dollarCapVerdict({
      dailyBudgetUsd: 10,
      spentUsd: 1,
      billable: anyBillableSubject(['ashlrcode']),
    });
    expect(cap).toStrictEqual({ kind: 'enforced', remainingUsd: 9 });
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
