/**
 * test/helpers/h3-stress.ts — H3 deterministic-concurrency stress helpers.
 *
 * MILESTONE H3 "Harden & Prove" — proves the IN-PROCESS budget / concurrency /
 * per-tick / daily-reset / id-uniqueness caps hold UNDER LOAD. These helpers
 * EXTEND the H1 testkit (test/helpers/h1-fixture.ts — REUSE IT) and the H2
 * fault helpers (test/helpers/h2-faults.ts — REUSE IT) with the one new
 * capability H3 needs: deterministic concurrency drivers that flood the REAL
 * bounding / selection / accounting code with many simultaneous units of INSTANT,
 * KNOWN-COST, model-free work.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * DETERMINISTIC-CONCURRENCY TECHNIQUE (the whole point — read before using):
 *   We do NOT spawn real agents and do NOT depend on a model or scheduling luck.
 *   `runSwarm` (tick-level stress) and `runGoal` (runSwarm-internal sliceBudget /
 *   MAX_PARALLEL stress) are MOCKED exactly as M24 / M12 already mock them. The
 *   mock records its call, yields a microtask to FORCE interleaving, returns a
 *   stub with a KNOWN `usage.estCostUsd` (so the REAL accounting sees a precise
 *   per-call spend), and — when modelling `propose:true` — creates a PENDING
 *   proposal via the REAL `createProposal` store.
 *
 *   The REAL code under test therefore runs for real: `bounded()` (loop.ts),
 *   the budget gate + in-tick short-circuit, the `perTickItems` top-K select,
 *   `tickSpent` accounting, `resetDayIfNeeded`, the `parallel` clamp, and
 *   `buildBudget`/`sliceBudget`/`MAX_PARALLEL` (runner.ts). Only the WORK is
 *   synthetic, so the proven guarantees are the production guarantees.
 *
 *   Concurrency is asserted by BOUND, never by order: a probe samples the
 *   in-flight count and the suite asserts the observed PEAK is `<= limit` — a
 *   property true under every interleaving, so the test is deterministic.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ABSOLUTE SAFETY (inherited from H1/H2, unchanged):
 *   - Every helper only ever touches state THROUGH the real stores under the
 *     fixture's ISOLATED tmp HOME — NEVER the real ~/.ashlr. They resolve every
 *     path via the REAL store functions (which read homedir() at call time), so
 *     the H1 fixture's HOME relocation isolates them.
 *   - DETERMINISTIC: no model, no network, no real subprocess. Pure in-process
 *     fan-out + real-store round-trips.
 *
 * These are TEST-ONLY helpers: no production behavior change, no new runtime dep,
 * strict TS, node builtins + the project's own stores only.
 */

import type {
  Proposal,
  RunState,
  RunUsage,
  SwarmRun,
} from '../../src/core/types.js';
import { createProposal, makeProposalId } from '../../src/core/inbox/store.js';

// ===========================================================================
// spawnConcurrent — fan out n units and settle them all
// ===========================================================================

/**
 * Invoke `fn(i)` for every `i` in `[0, n)` and `Promise.all` the results, so
 * MANY units hit the REAL bounded() / sliceBudget paths simultaneously. Returns
 * a `PromiseSettledResult<T>[]` in INPUT ORDER, so a single failing unit never
 * masks the others (mirrors the daemon's own `bounded()` settle semantics).
 */
export async function spawnConcurrent<T>(
  n: number,
  fn: (i: number) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  const units: Array<Promise<T>> = [];
  for (let i = 0; i < n; i++) {
    units.push(fn(i));
  }
  return Promise.allSettled(units);
}

// ===========================================================================
// ConcurrencyProbe — sample peak in-flight count (the CONCURRENCY-CAP primitive)
// ===========================================================================

/** A live concurrency sampler. `enter`/`leave` bracket one unit of work. */
export interface ConcurrencyProbe {
  /** Mark a unit as started; updates the running maximum. */
  enter(): void;
  /** Mark a unit as finished. */
  leave(): void;
  /** The OBSERVED maximum number of simultaneously in-flight units. */
  peak(): number;
  /** The CURRENT number of in-flight units (0 once all units have left). */
  current(): number;
}

/**
 * Create a {@link ConcurrencyProbe}. A mocked unit calls `enter()` on start and
 * `leave()` on finish; a suite floods the REAL `bounded()` / `MAX_PARALLEL` path
 * and asserts `peak() <= limit`. Because we assert the BOUND (not an order), the
 * check is true under every interleaving — deterministic.
 */
export function makeConcurrencyProbe(): ConcurrencyProbe {
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    enter(): void {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
    },
    leave(): void {
      if (inFlight > 0) inFlight--;
    },
    peak(): number {
      return maxInFlight;
    },
    current(): number {
      return inFlight;
    },
  };
}

// ===========================================================================
// runSwarm mock factory — KNOWN-cost, optionally probed + proposing
// ===========================================================================

/** Options for {@link makeSpendingSwarmStub}. */
export interface SpendingSwarmStubOptions {
  /** The exact `usage.estCostUsd` each dispatch reports (the REAL accounting reads this). */
  costUsd: number;
  /** Optional concurrency probe to bracket each dispatch with. */
  probe?: ConcurrencyProbe;
  /** Repo path to attribute a created proposal to (required when `propose`). */
  repo?: string;
  /** When true, create a PENDING proposal via the REAL store (models propose:true). */
  propose?: boolean;
  /** Status to report on the stub run. Default 'done'. */
  status?: SwarmRun['status'];
}

/**
 * Build a `runSwarm` mock implementation (M24 `makeSwarmRunStub` shape) whose
 * `usage.estCostUsd === costUsd`, so the REAL `tick` accounting + budget
 * short-circuit see a PRECISE per-dispatch spend. Optionally brackets each call
 * with a concurrency probe and creates a PENDING proposal via the REAL store.
 *
 * Yields a microtask (`await Promise.resolve()`) BEFORE returning so concurrent
 * dispatches genuinely interleave, exercising the bounded worker pool under load.
 *
 * Typed loosely on the args (the daemon passes a 4-arg runSwarm) and cast to a
 * `SwarmRun`-shaped value — matching the existing M24 mock convention.
 */
export function makeSpendingSwarmStub(
  opts: SpendingSwarmStubOptions,
): (...args: unknown[]) => Promise<SwarmRun> {
  const status: SwarmRun['status'] = opts.status ?? 'done';
  let n = 0;
  return async (..._args: unknown[]): Promise<SwarmRun> => {
    opts.probe?.enter();
    try {
      // Yield so concurrent dispatches interleave through the REAL worker pool.
      await Promise.resolve();
      if (opts.propose && opts.repo !== undefined) {
        createProposal({
          repo: opts.repo,
          origin: 'swarm',
          kind: 'patch',
          title: `h3 stress proposal ${n}`,
          summary: 'Generated by makeSpendingSwarmStub (H3 deterministic stress)',
          diff: 'diff --git a/x.ts b/x.ts\n',
        });
      }
      const now = new Date().toISOString();
      const usage: RunUsage = {
        tokensIn: 0,
        tokensOut: 0,
        steps: 1,
        estCostUsd: opts.costUsd,
      };
      const run = {
        id: `h3-swarm-${Date.now().toString(36)}-${(n++).toString(36)}`,
        goal: 'h3 stress goal',
        specId: null,
        project: opts.repo ?? null,
        createdAt: now,
        updatedAt: now,
        budget: { maxTokens: 1000, maxSteps: 10, allowCloud: false },
        usage,
        parallel: 1,
        status,
        plan: { specId: null, goal: 'h3 stress goal', tasks: [] },
        tasks: [],
        result: 'h3 stress result',
      };
      return run as unknown as SwarmRun;
    } finally {
      opts.probe?.leave();
    }
  };
}

// ===========================================================================
// runGoal mock factory — probed, KNOWN-usage (the MAX_PARALLEL / sliceBudget stub)
// ===========================================================================

/** Options for {@link makeCountingGoalStub}. */
export interface CountingGoalStubOptions {
  /** Optional concurrency probe to bracket each task with. */
  probe?: ConcurrencyProbe;
  /** Per-task usage the stub reports. Default a tiny local-only usage. */
  usagePerTask?: RunUsage;
}

/**
 * Build a `runGoal` mock implementation (M12 shape) that brackets each task with
 * a concurrency probe and returns a `RunState` stub carrying a KNOWN `RunUsage`,
 * so `runSwarm`'s internal BUILD-phase concurrency (`MAX_PARALLEL`) and per-task
 * `sliceBudget` reservation run FOR REAL under load while the work is instant.
 *
 * Yields a microtask before returning so concurrent BUILD tasks interleave.
 */
export function makeCountingGoalStub(
  opts: CountingGoalStubOptions = {},
): (goal: string, ...rest: unknown[]) => Promise<RunState> {
  const usagePerTask: RunUsage = opts.usagePerTask ?? {
    tokensIn: 100,
    tokensOut: 50,
    steps: 1,
    estCostUsd: 0,
  };
  return async (goal: string, ..._rest: unknown[]): Promise<RunState> => {
    opts.probe?.enter();
    try {
      await Promise.resolve();
      const now = new Date().toISOString();
      const state = {
        id: `h3-run-${Math.random().toString(36).slice(2)}`,
        goal,
        engine: 'builtin',
        provider: 'builtin',
        createdAt: now,
        updatedAt: now,
        budget: { maxTokens: 1000, maxSteps: 10, allowCloud: false },
        usage: { ...usagePerTask },
        tasks: [],
        steps: [],
        status: 'done',
        result: `h3 stress result for: ${goal}`,
      };
      return state as unknown as RunState;
    } finally {
      opts.probe?.leave();
    }
  };
}

// ===========================================================================
// collectIds — mint n ids in a tight loop (the IDS-COLLISION-SAFE primitive)
// ===========================================================================

/**
 * Call `mint()` `n` times AS FAST AS POSSIBLE (a tight synchronous loop, so many
 * ids land within the SAME millisecond) and return the produced ids in order.
 * The suite asserts `new Set(ids).size === n` to prove same-ms uniqueness.
 */
export function collectIds(n: number, mint: () => string): string[] {
  const ids: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    ids[i] = mint();
  }
  return ids;
}

/**
 * Mint `n` proposal ids through the REAL inbox id minter, returning the produced
 * ids without coupling this same-millisecond property test to durable fsync.
 * Durable proposal persistence is covered independently by h3.atomic-writes.
 */
export function mintProposalIds(n: number, _repo: string): string[] {
  return collectIds(n, makeProposalId);
}

/**
 * The 4-segment swarm-id shape THE SINGLE PRODUCTION CHANGE guarantees:
 * `swarm-<ts>-<seq>-<rand>`. The PRE-fix `makeId` emitted only 3 segments
 * (`swarm-<ts>-<rand>`, NO `<seq>`), so this regex is the deterministic detector
 * for the missing `_seq` counter: a seq-less id fails it.
 */
export const SWARM_ID_SHAPE = /^swarm-[0-9a-z]+-[0-9a-z]{6}-[0-9a-z]+$/;

/**
 * Mint `n` swarm ids through the REAL `makeId` minter in `swarm/runner.ts` — the
 * exact function the production `runSwarm` path uses to derive every persisted
 * `~/.ashlr/swarms/<id>.json` path. Mints `n` ids in a tight loop (same ms where
 * possible), returning them in order so the suite can assert same-ms uniqueness.
 *
 * `makeId` is passed IN (the caller imports it STATICALLY at top-of-file so
 * vitest's per-file module isolation binds the real exported `makeId`
 * deterministically — a dynamic `import()` here could observe a different,
 * mock-polluted runner module when two suites share the worker graph, which once
 * yielded seq-less ids and an opaque ordering failure). As a defensive guard
 * AGAINST exactly that pollution, every minted id is asserted to carry the
 * 4-segment `<seq>` shape (see {@link SWARM_ID_SHAPE}); a polluted/PRE-fix
 * `makeId` therefore fails LOUDLY with a clear message instead of silently
 * yielding seq-less ids. Runs model-free + subprocess-free + network-free.
 */
export function mintSwarmIds(n: number, makeId: () => string): string[] {
  if (typeof makeId !== 'function') {
    throw new Error(
      'swarm/runner.ts does not export makeId — the H3 integration phase must ' +
        'export makeId (the thin seam) alongside adding the _seq counter (THE ' +
        'SINGLE PRODUCTION CHANGE in CONTRACT-H3.md).',
    );
  }
  const ids = collectIds(n, makeId);
  for (const id of ids) {
    if (!SWARM_ID_SHAPE.test(id)) {
      throw new Error(
        `mintSwarmIds: id "${id}" is missing the <seq> counter segment ` +
          '(expected swarm-<ts>-<seq>-<rand>). The makeId _seq fix (THE SINGLE ' +
          'PRODUCTION CHANGE) is absent or a mock has polluted the runner module.',
      );
    }
  }
  return ids;
}
