/**
 * M48 fleet-supervisor tests — tick() backend routing, quota fallback, and the
 * opt-in auto-merge pass.
 *
 * SAFETY GUARDRAILS (mirrors test/m24.loop.test.ts):
 *  - HOME is overridden to a tmp dir so no real ~/.ashlr state is touched.
 *  - runSwarm AND runGoal are MOCKED — no real agents, subprocesses, or API
 *    calls. routeBackend is MOCKED so routing is deterministic per test.
 *    runAutoMergePass is MOCKED so it records its invocation + returns a
 *    controlled merged count (the real M47 gate never runs here).
 *  - buildBacklog is MOCKED to return a couple WorkItems for the enrolled repo.
 *  - No real portfolio repos are touched. Tmp repos only, unenrolled in afterEach.
 *  - ASHLR_IN_DAEMON / ASHLR_IN_SWARM are cleaned up in afterEach.
 *
 * What each block asserts:
 *   1. DEFAULT (router → 'builtin'): tick calls runSwarm, NOT runGoal; the tick
 *      records a builtin backend tally; auto-merge pass runs but merged:0 ⇒ the
 *      tick has no `merged` field.
 *   2. FRONTIER (router → 'claude'): tick calls runGoal with engine:'claude' +
 *      sandboxEngine:true; does NOT call runSwarm; tick.backends.claude >= 1.
 *   3. QUOTA FALLBACK: router → 'claude' but cfg.foundry.limits.claude.max=0 ⇒
 *      withinLimit is false ⇒ tick falls back to runSwarm (builtin), not runGoal.
 *   4. AUTO-MERGE PASS: runAutoMergePass mocked to {merged:2} ⇒ tick.merged===2
 *      and it was called with cfg; {merged:0} ⇒ tick has no `merged` field.
 *   5. KILL-SWITCH: halts the tick (reason:'kill-switch', no dispatch).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, DaemonTick, WorkItem } from '../src/core/types.js';
import type { RouteDecision } from '../src/core/fleet/router.js';

// ---------------------------------------------------------------------------
// HOME isolation — must happen before any module import resolves homedir()
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
const origInDaemon = process.env.ASHLR_IN_DAEMON;
const origInSwarm = process.env.ASHLR_IN_SWARM;

let tmpHome: string;
let tmpRepo: string;

// ---------------------------------------------------------------------------
// Mocks — declared before lazy imports of the module under test.
// ---------------------------------------------------------------------------

// runSwarm (builtin backend path). Records calls; returns a minimal SwarmRun
// stub. The loop reads swarmRun.usage?.estCostUsd, so we provide it.
const mockRunSwarm = vi.fn();
vi.mock('../src/core/swarm/runner.js', () => ({
  runSwarm: (...args: unknown[]) => mockRunSwarm(...args),
}));

// runGoal (frontier backend path). Records calls; returns a minimal RunState
// stub. The loop reads runState.usage?.estCostUsd.
const mockRunGoal = vi.fn();
vi.mock('../src/core/run/orchestrator.js', () => ({
  runGoal: (...args: unknown[]) => mockRunGoal(...args),
}));

// routeBackend — controllable per test via a mutable holder.
let routeResult: RouteDecision = { backend: 'builtin', tier: 'local', reason: 'test default' };
const mockRouteBackend = vi.fn();
vi.mock('../src/core/fleet/router.js', () => ({
  routeBackend: (...args: unknown[]) => mockRouteBackend(...args),
}));

// runAutoMergePass — records whether it was called + with what; returns a
// controllable merged count via a mutable holder.
let autoMergeMerged = 0;
const mockRunAutoMergePass = vi.fn();
vi.mock('../src/core/fleet/automerge-pass.js', () => ({
  runAutoMergePass: (...args: unknown[]) => mockRunAutoMergePass(...args),
}));

// buildBacklog — returns a controllable set of WorkItems via a mutable holder.
let backlogItems: WorkItem[] = [];
const mockBuildBacklog = vi.fn();
vi.mock('../src/core/portfolio/backlog.js', () => ({
  buildBacklog: (...args: unknown[]) => mockBuildBacklog(...args),
}));

// ---------------------------------------------------------------------------
// Lazy imports — after mocks + HOME isolation
// ---------------------------------------------------------------------------

import { tick } from '../src/core/daemon/loop.js';
import { enroll, unenroll, setKill } from '../src/core/sandbox/policy.js';
import { createProposal } from '../src/core/inbox/store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCfg(overrides?: Partial<AshlrConfig>): AshlrConfig {
  return {
    version: 1,
    daemon: {
      dailyBudgetUsd: 1.0,
      perTickItems: 3,
      parallel: 2,
      intervalMs: 100,
    },
    ...overrides,
  } as AshlrConfig;
}

function initBareGitDir(dir: string): void {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  fs.writeFileSync(
    path.join(dir, '.git', 'config'),
    '[core]\n\trepositoryformatversion = 0\n',
    'utf8',
  );
}

function makeItem(id: string, repo: string, over?: Partial<WorkItem>): WorkItem {
  const now = new Date().toISOString();
  return {
    id,
    repo,
    source: 'todo',
    title: `Item ${id}`,
    detail: `detail for ${id}`,
    value: 4,
    effort: 4,
    score: 8,
    tags: [],
    ts: now,
    ...over,
  };
}

/** A runSwarm stub that records a PENDING proposal (mirrors propose:true). */
function swarmStub(repo: string) {
  return async (_input: unknown, _cfg: unknown, _opts: unknown) => {
    createProposal({
      repo,
      origin: 'swarm',
      kind: 'patch',
      title: 'Mock swarm proposal',
      summary: 'Generated by mock runSwarm',
      diff: 'diff --git a/x.ts b/x.ts\n',
    });
    return {
      id: `mock-swarm-${Date.now()}`,
      status: 'done',
      goal: 'mock goal',
      result: 'mock result',
      usage: { estCostUsd: 0, totalTokens: 0, steps: 1 },
    };
  };
}

/** A runGoal stub that records a PENDING proposal (mirrors the frontier path). */
function goalStub(repo: string) {
  return async (_goal: unknown, _cfg: unknown, _opts: unknown) => {
    createProposal({
      repo,
      origin: 'swarm',
      kind: 'patch',
      title: 'Mock frontier proposal',
      summary: 'Generated by mock runGoal',
      diff: 'diff --git a/y.ts b/y.ts\n',
    });
    return {
      id: `mock-run-${Date.now()}`,
      status: 'done',
      usage: { estCostUsd: 0 },
    };
  };
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m48-fleet-home-'));
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m48-fleet-repo-'));
  process.env.HOME = tmpHome;

  initBareGitDir(tmpRepo);
  fs.writeFileSync(
    path.join(tmpRepo, 'package.json'),
    JSON.stringify({ name: 'test-repo', version: '1.0.0' }),
    'utf8',
  );

  // Reset mock state + holders.
  mockRunSwarm.mockReset();
  mockRunGoal.mockReset();
  mockRouteBackend.mockReset();
  mockRunAutoMergePass.mockReset();
  mockBuildBacklog.mockReset();

  routeResult = { backend: 'builtin', tier: 'local', reason: 'test default' };
  autoMergeMerged = 0;
  backlogItems = [];

  // Default mock behaviors (each test overrides routeResult / backlogItems).
  mockRouteBackend.mockImplementation(() => routeResult);
  mockRunAutoMergePass.mockImplementation(async () => ({
    attempted: 0,
    merged: autoMergeMerged,
    results: [],
  }));
  mockBuildBacklog.mockImplementation(async () => ({
    generatedAt: new Date().toISOString(),
    repos: [tmpRepo],
    items: backlogItems,
  }));
  mockRunSwarm.mockImplementation(swarmStub(tmpRepo));
  mockRunGoal.mockImplementation(goalStub(tmpRepo));

  delete process.env.ASHLR_IN_DAEMON;
  delete process.env.ASHLR_IN_SWARM;
});

afterEach(() => {
  try { unenroll(tmpRepo); } catch { /* ignore */ }
  try { setKill(false); } catch { /* ignore */ }

  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRepo, { recursive: true, force: true });

  process.env.HOME = origHome;
  if (origInDaemon !== undefined) process.env.ASHLR_IN_DAEMON = origInDaemon;
  else delete process.env.ASHLR_IN_DAEMON;
  if (origInSwarm !== undefined) process.env.ASHLR_IN_SWARM = origInSwarm;
  else delete process.env.ASHLR_IN_SWARM;

  vi.clearAllMocks();
});

// ===========================================================================
// 1. DEFAULT — router → 'builtin' ⇒ runSwarm, NOT runGoal
// ===========================================================================

describe('M48 tick — DEFAULT routing (builtin)', () => {
  beforeEach(() => {
    enroll(tmpRepo);
    backlogItems = [makeItem('default-1', tmpRepo), makeItem('default-2', tmpRepo)];
    routeResult = { backend: 'builtin', tier: 'local', reason: 'bulk → builtin' };
  });

  it('calls runSwarm and does NOT call runGoal', async () => {
    await tick(makeCfg(), { dryRun: false });
    expect(mockRunSwarm).toHaveBeenCalled();
    expect(mockRunGoal).not.toHaveBeenCalled();
  });

  it('tick.backends records a builtin tally', async () => {
    const result: DaemonTick = await tick(makeCfg(), { dryRun: false });
    expect(result.backends).toBeDefined();
    expect(result.backends?.['builtin']).toBeGreaterThanOrEqual(1);
    expect(result.backends?.['claude']).toBeUndefined();
  });

  it('runAutoMergePass is still called even with autoMerge off', async () => {
    await tick(makeCfg(), { dryRun: false });
    expect(mockRunAutoMergePass).toHaveBeenCalled();
  });

  it('merged:0 ⇒ tick has no `merged` field', async () => {
    autoMergeMerged = 0;
    const result = await tick(makeCfg(), { dryRun: false });
    expect(result.merged).toBeUndefined();
  });

  it('runSwarm is called with sandbox:true + propose:true', async () => {
    await tick(makeCfg(), { dryRun: false });
    const callArgs = mockRunSwarm.mock.calls[0];
    const optsArg = callArgs?.find(
      (a: unknown) =>
        a !== null &&
        typeof a === 'object' &&
        'propose' in (a as Record<string, unknown>),
    ) as Record<string, unknown> | undefined;
    expect(optsArg?.['sandbox']).toBe(true);
    expect(optsArg?.['propose']).toBe(true);
  });
});

// ===========================================================================
// 2. FRONTIER — router → 'claude' ⇒ runGoal(engine:'claude'), NOT runSwarm
// ===========================================================================

describe('M48 tick — FRONTIER routing (claude)', () => {
  beforeEach(() => {
    enroll(tmpRepo);
    backlogItems = [makeItem('frontier-1', tmpRepo, { source: 'security', effort: 5, score: 9 })];
    routeResult = { backend: 'claude', tier: 'frontier', reason: 'senior → claude' };
  });

  it('calls runGoal and does NOT call runSwarm', async () => {
    await tick(makeCfg(), { dryRun: false });
    expect(mockRunGoal).toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('runGoal is invoked with engine:"claude" and sandboxEngine:true', async () => {
    await tick(makeCfg(), { dryRun: false });
    const callArgs = mockRunGoal.mock.calls[0];
    // runGoal(goal, cfg, opts) — opts is the 3rd argument.
    const optsArg = callArgs?.[2] as Record<string, unknown> | undefined;
    expect(optsArg).toBeDefined();
    expect(optsArg?.['engine']).toBe('claude');
    expect(optsArg?.['sandboxEngine']).toBe(true);
    expect(optsArg?.['requireSandbox']).toBe(true);
  });

  it('tick.backends.claude >= 1 and has no builtin tally', async () => {
    const result = await tick(makeCfg(), { dryRun: false });
    expect(result.backends?.['claude']).toBeGreaterThanOrEqual(1);
    expect(result.backends?.['builtin']).toBeUndefined();
  });
});

// ===========================================================================
// 3. QUOTA FALLBACK — router → 'claude' but limit max=0 ⇒ fall back to builtin
// ===========================================================================

describe('M48 tick — QUOTA FALLBACK (frontier over rate cap → builtin)', () => {
  beforeEach(() => {
    enroll(tmpRepo);
    backlogItems = [makeItem('quota-1', tmpRepo, { source: 'security', effort: 5, score: 9 })];
    routeResult = { backend: 'claude', tier: 'frontier', reason: 'senior → claude' };
  });

  it('falls back to runSwarm (builtin) when claude is over its rate cap', async () => {
    // A max:0 cap means withinLimit('claude', cfg) is false for every dispatch.
    const cfg = makeCfg({
      foundry: { limits: { claude: { window: '1h', max: 0 } } },
    } as Partial<AshlrConfig>);

    await tick(cfg, { dryRun: false });

    // Over-quota frontier ⇒ NO frontier run, builtin swarm instead.
    expect(mockRunGoal).not.toHaveBeenCalled();
    expect(mockRunSwarm).toHaveBeenCalled();
  });

  it('records the dispatch under builtin (not claude) when over cap', async () => {
    const cfg = makeCfg({
      foundry: { limits: { claude: { window: '1h', max: 0 } } },
    } as Partial<AshlrConfig>);

    const result = await tick(cfg, { dryRun: false });
    expect(result.backends?.['builtin']).toBeGreaterThanOrEqual(1);
    expect(result.backends?.['claude']).toBeUndefined();
  });

  it('does NOT fall back when claude is UNDER its rate cap', async () => {
    // A generous cap leaves claude within limit ⇒ frontier path is taken.
    const cfg = makeCfg({
      foundry: { limits: { claude: { window: '1h', max: 100 } } },
    } as Partial<AshlrConfig>);

    await tick(cfg, { dryRun: false });
    expect(mockRunGoal).toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 4. AUTO-MERGE PASS — tick.merged reflects the pass result
// ===========================================================================

describe('M48 tick — AUTO-MERGE PASS plumbing', () => {
  beforeEach(() => {
    enroll(tmpRepo);
    backlogItems = [makeItem('merge-1', tmpRepo)];
    routeResult = { backend: 'builtin', tier: 'local', reason: 'builtin' };
  });

  it('tick.merged === 2 when the pass returns {merged:2}', async () => {
    autoMergeMerged = 2;
    const result = await tick(makeCfg(), { dryRun: false });
    expect(result.merged).toBe(2);
  });

  it('runAutoMergePass is called with the cfg', async () => {
    autoMergeMerged = 2;
    const cfg = makeCfg();
    await tick(cfg, { dryRun: false });
    expect(mockRunAutoMergePass).toHaveBeenCalledWith(cfg);
  });

  it('tick has no `merged` field when the pass returns {merged:0}', async () => {
    autoMergeMerged = 0;
    const result = await tick(makeCfg(), { dryRun: false });
    expect(result.merged).toBeUndefined();
  });
});

// ===========================================================================
// 5. KILL-SWITCH — halts the tick before any dispatch / auto-merge
// ===========================================================================

describe('M48 tick — KILL-SWITCH halts the tick', () => {
  it('returns reason "kill-switch" and dispatches nothing', async () => {
    enroll(tmpRepo);
    backlogItems = [makeItem('kill-1', tmpRepo)];
    routeResult = { backend: 'claude', tier: 'frontier', reason: 'senior → claude' };
    setKill(true);

    const result = await tick(makeCfg(), { dryRun: false });

    expect(result.reason).toBe('kill-switch');
    expect(result.proposalsCreated).toBe(0);
    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(mockRunGoal).not.toHaveBeenCalled();
    expect(mockRunAutoMergePass).not.toHaveBeenCalled();
    expect(mockRouteBackend).not.toHaveBeenCalled();
    expect(result.backends).toBeUndefined();
    expect(result.merged).toBeUndefined();
  });
});
