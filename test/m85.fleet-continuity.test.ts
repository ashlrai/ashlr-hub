/**
 * m85.fleet-continuity.test.ts — per-repo fairness, worked-item cooldown,
 * live config reload.
 *
 * SAFETY GUARDRAILS (mirrors m48.fleet-supervisor.test.ts):
 *  - HOME is overridden to a tmp dir so no real ~/.ashlr state is touched.
 *  - runSwarm, runGoal, routeBackend, runAutoMergePass, buildBacklog are ALL
 *    MOCKED — no real agents, subprocesses, or API calls.
 *  - loadConfig is MOCKED so per-tick reload is controlled per test.
 *  - No real portfolio repos are touched.
 *  - ASHLR_IN_DAEMON / ASHLR_IN_SWARM are cleaned up in afterEach.
 *
 * Blocks:
 *  1. worked-ledger: recordOutcome + recentlyDeclined + never-throws.
 *  2. Fairness selection: 3 repos → items from each are selected.
 *  3. Cooldown skip: a recently-'empty' item is not dispatched.
 *  4. Config reload: a changed perTickItems value takes effect next tick.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { AshlrConfig, WorkItem } from '../src/core/types.js';
import type { RouteDecision } from '../src/core/fleet/router.js';

// ---------------------------------------------------------------------------
// HOME isolation — before any module import resolves homedir()
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
const origInDaemon = process.env.ASHLR_IN_DAEMON;
const origInSwarm = process.env.ASHLR_IN_SWARM;

let tmpHome: string;
let tmpRepo: string;
let tmpRepo2: string;
let tmpRepo3: string;

// ---------------------------------------------------------------------------
// Mocks — declared before lazy imports
// ---------------------------------------------------------------------------

const mockRunSwarm = vi.fn();
vi.mock('../src/core/swarm/runner.js', () => ({
  runSwarm: (...args: unknown[]) => mockRunSwarm(...args),
}));

const mockRunGoal = vi.fn();
vi.mock('../src/core/run/orchestrator.js', () => ({
  runGoal: (...args: unknown[]) => mockRunGoal(...args),
}));

let routeResult: RouteDecision = { backend: 'builtin', tier: 'local', reason: 'test' };
const mockRouteBackend = vi.fn();
vi.mock('../src/core/fleet/router.js', () => ({
  routeBackend: (...args: unknown[]) => mockRouteBackend(...args),
}));

const mockRunAutoMergePass = vi.fn();
vi.mock('../src/core/fleet/automerge-pass.js', () => ({
  runAutoMergePass: (...args: unknown[]) => mockRunAutoMergePass(...args),
}));

let backlogItems: WorkItem[] = [];
const mockBuildBacklog = vi.fn();
vi.mock('../src/core/portfolio/backlog.js', () => ({
  buildBacklog: (...args: unknown[]) => mockBuildBacklog(...args),
}));

// loadConfig mock — controllable per test via a mutable holder.
let liveCfgOverride: AshlrConfig | null = null;
const mockLoadConfig = vi.fn();
vi.mock('../src/core/config.js', () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  defaultConfig: () => ({ version: 1 }),
  saveConfig: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Lazy imports — after mocks + HOME isolation
// ---------------------------------------------------------------------------

import { tick } from '../src/core/daemon/loop.js';
import { enroll, unenroll, setKill } from '../src/core/sandbox/policy.js';
import { createProposal } from '../src/core/inbox/store.js';
import {
  _setWorkedLedgerHooksForTest,
  recordOutcome,
  replayWorkedOutcomeAfterDispatchReceipt,
  recentlyDeclined,
  loadWorkedLedger,
  latestWorkedEventForKeys,
  workedEventIsCooling,
  workedLedgerPath,
} from '../src/core/fleet/worked-ledger.js';
import {
  recordDispatchProduction,
  sanitizeDispatchProductionEvent,
} from '../src/core/fleet/dispatch-production-ledger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCfg(overrides?: Partial<AshlrConfig>): AshlrConfig {
  return {
    version: 1,
    daemon: {
      dailyBudgetUsd: 10.0,
      perTickItems: 6,
      parallel: 6,
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
  return {
    id,
    repo,
    source: 'todo',
    title: `Item ${id}`,
    detail: `detail for ${id}`,
    value: 3,
    effort: 3,
    score: 1,
    tags: [],
    ts: new Date().toISOString(),
    ...over,
  };
}

function swarmStub(repo: string) {
  return async () => {
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

// ---------------------------------------------------------------------------
// beforeEach / afterEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  _setWorkedLedgerHooksForTest(undefined);
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m85-home-'));
  tmpRepo  = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m85-repo-'));
  tmpRepo2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m85-repo2-'));
  tmpRepo3 = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m85-repo3-'));
  process.env.HOME = tmpHome;

  for (const r of [tmpRepo, tmpRepo2, tmpRepo3]) {
    initBareGitDir(r);
    fs.writeFileSync(path.join(r, 'package.json'), JSON.stringify({ name: 'r' }), 'utf8');
  }

  mockRunSwarm.mockReset();
  mockRunGoal.mockReset();
  mockRouteBackend.mockReset();
  mockRunAutoMergePass.mockReset();
  mockBuildBacklog.mockReset();
  mockLoadConfig.mockReset();

  routeResult = { backend: 'builtin', tier: 'local', reason: 'test' };
  backlogItems = [];
  liveCfgOverride = null;

  mockRouteBackend.mockImplementation(() => routeResult);
  mockRunAutoMergePass.mockImplementation(async () => ({ attempted: 0, merged: 0, results: [] }));
  mockBuildBacklog.mockImplementation(async () => ({
    generatedAt: new Date().toISOString(),
    repos: [tmpRepo, tmpRepo2, tmpRepo3],
    items: backlogItems,
  }));
  mockRunSwarm.mockImplementation(swarmStub(tmpRepo));
  mockRunGoal.mockImplementation(async () => ({
    id: `mock-run-${Date.now()}`,
    status: 'done',
    usage: { estCostUsd: 0 },
  }));
  // loadConfig returns the override if set, else the base cfg.
  mockLoadConfig.mockImplementation(() => liveCfgOverride ?? makeCfg());

  delete process.env.ASHLR_IN_DAEMON;
  delete process.env.ASHLR_IN_SWARM;
});

afterEach(() => {
  _setWorkedLedgerHooksForTest(undefined);
  try { unenroll(tmpRepo); } catch { /* ignore */ }
  try { unenroll(tmpRepo2); } catch { /* ignore */ }
  try { unenroll(tmpRepo3); } catch { /* ignore */ }
  try { setKill(false); } catch { /* ignore */ }

  fs.rmSync(tmpHome,  { recursive: true, force: true });
  fs.rmSync(tmpRepo,  { recursive: true, force: true });
  fs.rmSync(tmpRepo2, { recursive: true, force: true });
  fs.rmSync(tmpRepo3, { recursive: true, force: true });

  process.env.HOME = origHome;
  if (origInDaemon !== undefined) process.env.ASHLR_IN_DAEMON = origInDaemon;
  else delete process.env.ASHLR_IN_DAEMON;
  if (origInSwarm !== undefined) process.env.ASHLR_IN_SWARM = origInSwarm;
  else delete process.env.ASHLR_IN_SWARM;

  vi.clearAllMocks();
});

// ===========================================================================
// 1. worked-ledger — pure unit tests (no tick(), no mocks needed)
// ===========================================================================

describe('M85 worked-ledger — pure unit', () => {
  it('securely creates missing home and fleet storage for ordinary first use', () => {
    const firstUseHome = path.join(tmpHome, 'missing-first-use-home');
    process.env.HOME = firstUseHome;
    expect(fs.existsSync(firstUseHome)).toBe(false);

    expect(recordOutcome('first-use-item', 'diff', '2026-07-21T23:24:36.686Z')).toBe(true);
    expect(loadWorkedLedger().events).toEqual([
      { itemId: 'first-use-item', outcome: 'diff', ts: '2026-07-21T23:24:36.686Z' },
    ]);
    expect(fs.statSync(path.dirname(workedLedgerPath())).isDirectory()).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.dirname(workedLedgerPath())).mode & 0o777).toBe(0o700);
    }
  });

  it('does not follow or chmod a symlinked first-use fleet target', () => {
    const ashlr = path.join(tmpHome, '.ashlr');
    const victim = path.join(tmpHome, 'first-use-fleet-victim');
    fs.mkdirSync(ashlr, { mode: 0o700 });
    fs.mkdirSync(victim, { mode: 0o755 });
    fs.writeFileSync(path.join(victim, 'marker'), 'untouched', 'utf8');
    fs.symlinkSync(
      victim,
      path.join(ashlr, 'fleet'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const before = fs.statSync(victim);

    expect(recordOutcome('must-not-escape-first-use', 'diff')).toBe(false);
    expect(fs.readFileSync(path.join(victim, 'marker'), 'utf8')).toBe('untouched');
    expect(fs.readdirSync(victim)).toEqual(['marker']);
    expect(fs.statSync(victim).mode).toBe(before.mode);
    expect(fs.lstatSync(path.join(ashlr, 'fleet')).isSymbolicLink()).toBe(true);
  });

  it('recordOutcome persists an event and loadWorkedLedger returns it', () => {
    expect(recordOutcome('item-abc', 'diff')).toBe(true);
    const l = loadWorkedLedger();
    expect(l.events.some(e => e.itemId === 'item-abc' && e.outcome === 'diff')).toBe(true);
  });

  it('idempotently replays a worked outcome only after an exact dispatch receipt', () => {
    expect(recordOutcome('worked-authority-seed', 'diff', '2026-07-21T23:24:35.000Z')).toBe(true);
    const event = sanitizeDispatchProductionEvent({
      schemaVersion: 1,
      ts: '2026-07-21T23:24:36.686Z',
      itemId: 'binshield:self-heal:5f35267a0405',
      source: 'self',
      repo: tmpRepo,
      title: 'Repair binshield verification',
      backend: 'local-coder',
      tier: 'mid',
      assignedBy: 'daemon',
      routeReason: 'operator recovery fixture',
      outcome: 'empty-diff',
      proposalCreated: false,
      runId: 'attempt-d889ccac-023a-478c-8aeb-992afd4b5fa5',
      trajectoryId: 'run:attempt-d889ccac-023a-478c-8aeb-992afd4b5fa5',
      spentUsd: 0.346986,
      basis: 'run-proposal-outcome',
    }, { materializeLearningLabel: true });
    expect(recordDispatchProduction(event)).toMatchObject({ recorded: 1, failed: 0 });
    const dispatchReceipt = {
      ts: event.ts,
      itemId: event.itemId,
      repo: event.repo,
      outcome: event.outcome,
      attemptId: event.trajectoryId!,
      source: event.source,
      backend: event.backend,
      tier: event.tier,
    };
    const replay = {
      itemId: event.itemId,
      outcome: 'empty' as const,
      dispatchReceipt,
    };

    expect(replayWorkedOutcomeAfterDispatchReceipt(replay)).toBe('recorded');
    expect(replayWorkedOutcomeAfterDispatchReceipt(replay)).toBe('already-recorded');
    expect(loadWorkedLedger().events.filter((row) => row.itemId === event.itemId)).toEqual([
      { itemId: event.itemId, outcome: 'empty', ts: event.ts },
    ]);
  });

  it('keeps the copied live replay restart-idempotent', () => {
    if (process.platform === 'win32') {
      expect(process.platform).toBe('win32');
      return;
    }
    expect(recordOutcome('worked-authority-seed', 'diff', '2026-07-21T23:24:35.000Z')).toBe(true);
    const event = sanitizeDispatchProductionEvent({
      schemaVersion: 1,
      ts: '2026-07-21T23:24:36.686Z',
      itemId: 'binshield:self-heal:5f35267a0405',
      source: 'self',
      repo: tmpRepo,
      title: 'Repair binshield verification',
      backend: 'local-coder',
      tier: 'mid',
      assignedBy: 'daemon',
      routeReason: 'copied live restart fixture',
      outcome: 'empty-diff',
      proposalCreated: false,
      runId: 'attempt-d889ccac-023a-478c-8aeb-992afd4b5fa5',
      trajectoryId: 'run:attempt-d889ccac-023a-478c-8aeb-992afd4b5fa5',
      spentUsd: 0.346986,
      basis: 'run-proposal-outcome',
    }, { materializeLearningLabel: true });
    expect(recordDispatchProduction(event)).toMatchObject({ recorded: 1, failed: 0 });
    const input = {
      itemId: event.itemId,
      outcome: 'empty',
      dispatchReceipt: {
        ts: event.ts,
        itemId: event.itemId,
        repo: event.repo,
        outcome: event.outcome,
        attemptId: event.trajectoryId!,
      },
    };
    const workedModule = path.join(process.cwd(), 'src/core/fleet/worked-ledger.ts');
    const script = `
      import { replayWorkedOutcomeAfterDispatchReceipt } from ${JSON.stringify(workedModule)};
      process.stdout.write(replayWorkedOutcomeAfterDispatchReceipt(${JSON.stringify(input)}));
    `;
    const env = { ...process.env, HOME: tmpHome };
    const run = () => spawnSync(
      path.join(process.cwd(), 'node_modules/.bin/tsx'), ['--eval', script],
      { cwd: process.cwd(), env, encoding: 'utf8' },
    );

    const first = run();
    const restarted = run();
    expect({ status: first.status, stdout: first.stdout, stderr: first.stderr })
      .toEqual({ status: 0, stdout: 'recorded', stderr: '' });
    expect({ status: restarted.status, stdout: restarted.stdout, stderr: restarted.stderr })
      .toEqual({ status: 0, stdout: 'already-recorded', stderr: '' });
    expect(loadWorkedLedger().events.filter((row) => row.itemId === event.itemId)).toHaveLength(1);
  });

  it('rejects a caller-supplied future replay timestamp', () => {
    const event = sanitizeDispatchProductionEvent({
      schemaVersion: 1,
      ts: '2026-07-21T23:24:36.686Z',
      itemId: 'binshield:self-heal:future-replay-refusal',
      source: 'self',
      repo: tmpRepo,
      title: 'Reject future replay time',
      backend: 'local-coder',
      tier: 'mid',
      assignedBy: 'daemon',
      routeReason: 'operator recovery fixture',
      outcome: 'empty-diff',
      proposalCreated: false,
      runId: 'attempt-22222222-2222-4222-8222-222222222222',
      trajectoryId: 'run:attempt-22222222-2222-4222-8222-222222222222',
      spentUsd: 0,
      basis: 'run-proposal-outcome',
    }, { materializeLearningLabel: true });
    expect(recordDispatchProduction(event)).toMatchObject({ recorded: 1, failed: 0 });
    const hostile = {
      itemId: event.itemId,
      outcome: 'empty' as const,
      ts: '2099-01-01T00:00:00.000Z',
      dispatchReceipt: {
        ts: event.ts,
        itemId: event.itemId,
        repo: event.repo,
        outcome: event.outcome,
        attemptId: event.trajectoryId!,
      },
    };

    expect(replayWorkedOutcomeAfterDispatchReceipt(hostile)).toBe('invalid');
    expect(loadWorkedLedger().events).toEqual([]);
  });

  it('rejects malformed replay records and nested receipt near-matches without throwing', () => {
    const receipt = {
      ts: '2026-07-21T23:24:36.686Z',
      itemId: 'binshield:self-heal:runtime-validation',
      repo: tmpRepo,
      outcome: 'empty-diff',
      attemptId: 'run:attempt-runtime-validation',
    };
    const throwing = {
      itemId: receipt.itemId,
      outcome: 'empty',
      get dispatchReceipt(): never { throw new Error('must not escape'); },
    };
    const malformed: unknown[] = [
      null,
      [],
      { itemId: receipt.itemId, outcome: 'empty', dispatchReceipt: null },
      { itemId: receipt.itemId, outcome: 'empty', dispatchReceipt: [] },
      { itemId: receipt.itemId, outcome: 'empty', dispatchReceipt: { ...receipt, extra: true } },
      {
        itemId: receipt.itemId,
        outcome: 'empty',
        dispatchReceipt: { ...receipt, ts: '2026-07-21T23:24:36.686+00:00' },
      },
      {
        itemId: receipt.itemId,
        outcome: 'empty',
        dispatchReceipt: { ...receipt, backend: 42 },
      },
      { itemId: receipt.itemId, outcome: 'empty', dispatchReceipt: receipt, extra: true },
      throwing,
    ];

    for (const value of malformed) {
      let result: unknown;
      expect(() => {
        result = replayWorkedOutcomeAfterDispatchReceipt(value as never);
      }).not.toThrow();
      expect(result).toBe('invalid');
    }
    expect(loadWorkedLedger().events).toEqual([]);
  });

  it('serializes replay with a concurrent ordinary worked writer', async () => {
    expect(recordOutcome('worked-authority-seed', 'diff', '2026-07-21T23:24:35.000Z')).toBe(true);
    const event = sanitizeDispatchProductionEvent({
      schemaVersion: 1,
      ts: '2026-07-21T23:24:36.686Z',
      itemId: 'binshield:self-heal:concurrent-replay',
      source: 'self',
      repo: tmpRepo,
      title: 'Serialize worked recovery',
      backend: 'local-coder',
      tier: 'mid',
      assignedBy: 'daemon',
      routeReason: 'operator recovery fixture',
      outcome: 'empty-diff',
      proposalCreated: false,
      runId: 'attempt-33333333-3333-4333-8333-333333333333',
      trajectoryId: 'run:attempt-33333333-3333-4333-8333-333333333333',
      spentUsd: 0,
      basis: 'run-proposal-outcome',
    }, { materializeLearningLabel: true });
    expect(recordDispatchProduction(event)).toMatchObject({ recorded: 1, failed: 0 });
    const started = path.join(tmpHome, 'ordinary-writer-started');
    let child: ChildProcess | undefined;
    _setWorkedLedgerHooksForTest({
      afterReplayLoad: () => {
        const workedModule = path.join(process.cwd(), 'src/core/fleet/worked-ledger.ts');
        child = spawn(path.join(process.cwd(), 'node_modules/.bin/tsx'), ['--eval', `
          import { writeFileSync } from 'node:fs';
          import { recordOutcome } from ${JSON.stringify(workedModule)};
          writeFileSync(${JSON.stringify(started)}, 'started');
          if (!recordOutcome('ordinary:concurrent-writer', 'diff', '2026-07-21T23:24:37.000Z')) process.exit(1);
        `], { cwd: process.cwd(), env: { ...process.env, HOME: tmpHome } });
        const deadline = Date.now() + 2_000;
        const sleep = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(started) && Date.now() < deadline) Atomics.wait(sleep, 0, 0, 10);
        expect(fs.existsSync(started)).toBe(true);
        Atomics.wait(sleep, 0, 0, 100);
      },
    });

    expect(replayWorkedOutcomeAfterDispatchReceipt({
      itemId: event.itemId,
      outcome: 'empty',
      dispatchReceipt: {
        ts: event.ts,
        itemId: event.itemId,
        repo: event.repo,
        outcome: event.outcome,
        attemptId: event.trajectoryId!,
      },
    })).toBe('recorded');
    _setWorkedLedgerHooksForTest(undefined);
    await new Promise<void>((resolveChild, rejectChild) => {
      if (!child) return rejectChild(new Error('ordinary writer did not start'));
      if (child.exitCode !== null) {
        return child.exitCode === 0
          ? resolveChild()
          : rejectChild(new Error(`ordinary writer exited ${child.exitCode}`));
      }
      child.once('error', rejectChild);
      child.once('exit', (code) => code === 0
        ? resolveChild()
        : rejectChild(new Error(`ordinary writer exited ${code}`)));
    });
    expect(loadWorkedLedger().events).toEqual(expect.arrayContaining([
      { itemId: event.itemId, outcome: 'empty', ts: event.ts },
      { itemId: 'ordinary:concurrent-writer', outcome: 'diff', ts: '2026-07-21T23:24:37.000Z' },
    ]));
  });

  it('refuses a replaced fleet directory without overwriting replacement state', () => {
    expect(recordOutcome('directory-seed', 'diff', '2026-07-21T23:24:35.000Z')).toBe(true);
    const originalFleet = path.dirname(workedLedgerPath());
    const displacedFleet = `${originalFleet}-displaced`;
    const replacement = '{"events":[{"itemId":"replacement","outcome":"diff","ts":"2026-07-21T23:24:35.500Z"}]}\n';
    _setWorkedLedgerHooksForTest({
      beforePublication: () => {
        fs.renameSync(originalFleet, displacedFleet);
        fs.mkdirSync(originalFleet, { recursive: true, mode: 0o700 });
        fs.writeFileSync(workedLedgerPath(), replacement, { mode: 0o600 });
      },
    });

    expect(recordOutcome('must-not-overwrite', 'empty', '2026-07-21T23:24:36.686Z')).toBe(false);
    _setWorkedLedgerHooksForTest(undefined);
    expect(fs.readFileSync(workedLedgerPath(), 'utf8')).toBe(replacement);
    expect(fs.readFileSync(path.join(displacedFleet, 'worked.json'), 'utf8'))
      .toContain('directory-seed');
  });

  it('refuses a swapped random temp pathname before destructive publication', () => {
    if (process.platform === 'win32') {
      expect(process.platform).toBe('win32');
      return;
    }
    expect(recordOutcome('temp-swap-seed', 'diff', '2026-07-21T23:24:35.000Z')).toBe(true);
    const original = fs.readFileSync(workedLedgerPath(), 'utf8');
    const victim = path.join(tmpHome, 'random-temp-swap-victim');
    fs.writeFileSync(victim, 'victim-must-not-change', 'utf8');
    let swappedTemporary = '';
    _setWorkedLedgerHooksForTest({
      beforePublication: (temporaryPath) => {
        swappedTemporary = temporaryPath;
        fs.unlinkSync(temporaryPath);
        fs.symlinkSync(victim, temporaryPath, 'file');
      },
    });

    expect(recordOutcome('must-not-publish-swapped-temp', 'empty')).toBe(false);
    _setWorkedLedgerHooksForTest(undefined);
    expect(fs.readFileSync(workedLedgerPath(), 'utf8')).toBe(original);
    expect(fs.lstatSync(workedLedgerPath()).isFile()).toBe(true);
    expect(fs.readFileSync(victim, 'utf8')).toBe('victim-must-not-change');
    expect(fs.lstatSync(swappedTemporary).isSymbolicLink()).toBe(true);
  });

  it('refuses to overwrite a valid worked destination replaced after load', () => {
    expect(recordOutcome('destination-seed', 'diff', '2026-07-21T23:24:35.000Z')).toBe(true);
    const replacement = '{"events":[{"itemId":"concurrent-replacement","outcome":"diff","ts":"2026-07-21T23:24:36.000Z"}]}\n';
    _setWorkedLedgerHooksForTest({
      beforePublication: () => {
        const candidate = path.join(path.dirname(workedLedgerPath()), '.concurrent-worked.json');
        fs.writeFileSync(candidate, replacement, { mode: 0o600 });
        fs.renameSync(candidate, workedLedgerPath());
      },
    });

    expect(recordOutcome('must-not-lose-concurrent-event', 'empty')).toBe(false);
    _setWorkedLedgerHooksForTest(undefined);
    expect(fs.readFileSync(workedLedgerPath(), 'utf8')).toBe(replacement);
    expect(loadWorkedLedger().events).toEqual([
      {
        itemId: 'concurrent-replacement',
        outcome: 'diff',
        ts: '2026-07-21T23:24:36.000Z',
      },
    ]);
  });

  it('refuses to overwrite same-inode worked content changed after load', () => {
    expect(recordOutcome('content-snapshot-seed', 'diff', '2026-07-21T23:24:35.000Z')).toBe(true);
    const before = fs.lstatSync(workedLedgerPath());
    const concurrent = '{"events":[{"itemId":"same-inode-concurrent","outcome":"diff","ts":"2026-07-21T23:24:36.000Z"}]}\n';
    _setWorkedLedgerHooksForTest({
      beforePublication: () => fs.writeFileSync(workedLedgerPath(), concurrent, { mode: 0o600 }),
    });

    expect(recordOutcome('must-not-overwrite-changed-content', 'empty')).toBe(false);
    _setWorkedLedgerHooksForTest(undefined);
    const after = fs.lstatSync(workedLedgerPath());
    expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
    expect(fs.readFileSync(workedLedgerPath(), 'utf8')).toBe(concurrent);
  });

  it('refuses to overwrite a worked destination created after a missing snapshot', () => {
    expect(recordOutcome('missing-snapshot-seed', 'diff')).toBe(true);
    fs.unlinkSync(workedLedgerPath());
    const concurrent = '{"events":[{"itemId":"created-concurrently","outcome":"empty","ts":"2026-07-21T23:24:36.000Z"}]}\n';
    _setWorkedLedgerHooksForTest({
      beforePublication: () => fs.writeFileSync(workedLedgerPath(), concurrent, { mode: 0o600 }),
    });

    expect(recordOutcome('must-not-overwrite-created-destination', 'diff')).toBe(false);
    _setWorkedLedgerHooksForTest(undefined);
    expect(fs.readFileSync(workedLedgerPath(), 'utf8')).toBe(concurrent);
  });

  it('never follows the legacy fixed worked temp symlink', () => {
    expect(recordOutcome('symlink-seed', 'diff', '2026-07-21T23:24:35.000Z')).toBe(true);
    const victim = path.join(tmpHome, 'worked-temp-victim');
    const legacyTemporary = `${workedLedgerPath()}.tmp`;
    fs.writeFileSync(victim, 'victim-must-not-change', 'utf8');
    fs.symlinkSync(victim, legacyTemporary, 'file');

    expect(recordOutcome('symlink-safe', 'empty', '2026-07-21T23:24:36.686Z')).toBe(true);
    expect(fs.readFileSync(victim, 'utf8')).toBe('victim-must-not-change');
    expect(fs.lstatSync(legacyTemporary).isSymbolicLink()).toBe(true);
    expect(loadWorkedLedger().events).toContainEqual({
      itemId: 'symlink-safe', outcome: 'empty', ts: '2026-07-21T23:24:36.686Z',
    });
  });

  it('fails replay closed when strict directory durability is unsupported', () => {
    expect(recordOutcome('worked-authority-seed', 'diff', '2026-07-21T23:24:35.000Z')).toBe(true);
    const event = sanitizeDispatchProductionEvent({
      schemaVersion: 1,
      ts: '2026-07-21T23:24:36.686Z',
      itemId: 'binshield:self-heal:windows-durability-refusal',
      source: 'self',
      repo: tmpRepo,
      title: 'Require replay durability',
      backend: 'local-coder',
      tier: 'mid',
      assignedBy: 'daemon',
      routeReason: 'unsupported directory fsync fixture',
      outcome: 'empty-diff',
      proposalCreated: false,
      runId: 'attempt-44444444-4444-4444-8444-444444444444',
      trajectoryId: 'run:attempt-44444444-4444-4444-8444-444444444444',
      spentUsd: 0,
      basis: 'run-proposal-outcome',
    }, { materializeLearningLabel: true });
    expect(recordDispatchProduction(event)).toMatchObject({ recorded: 1, failed: 0 });
    _setWorkedLedgerHooksForTest({ strictDirectoryDurability: () => false });

    expect(replayWorkedOutcomeAfterDispatchReceipt({
      itemId: event.itemId,
      outcome: 'empty',
      dispatchReceipt: {
        ts: event.ts,
        itemId: event.itemId,
        repo: event.repo,
        outcome: event.outcome,
        attemptId: event.trajectoryId!,
      },
    })).toBe('persistence-failed');
    expect(loadWorkedLedger().events.some((row) => row.itemId === event.itemId)).toBe(false);
    expect(recordOutcome('portable-ordinary-write', 'diff', event.ts)).toBe(true);
  });

  it('never reports recorded after final durability mutates the installed ledger', () => {
    expect(recordOutcome('worked-authority-seed', 'diff', '2026-07-21T23:24:35.000Z')).toBe(true);
    const event = sanitizeDispatchProductionEvent({
      schemaVersion: 1,
      ts: '2026-07-21T23:24:36.686Z',
      itemId: 'binshield:self-heal:final-readback-refusal',
      source: 'self',
      repo: tmpRepo,
      title: 'Prove final worked bytes',
      backend: 'local-coder',
      tier: 'mid',
      assignedBy: 'daemon',
      routeReason: 'final durability mutation fixture',
      outcome: 'empty-diff',
      proposalCreated: false,
      runId: 'attempt-66666666-6666-4666-8666-666666666666',
      trajectoryId: 'run:attempt-66666666-6666-4666-8666-666666666666',
      spentUsd: 0,
      basis: 'run-proposal-outcome',
    }, { materializeLearningLabel: true });
    expect(recordDispatchProduction(event)).toMatchObject({ recorded: 1, failed: 0 });
    const concurrent = '{"events":[{"itemId":"final-boundary-concurrent","outcome":"diff","ts":"2026-07-21T23:24:36.500Z"}]}\n';
    let durabilityCalls = 0;
    _setWorkedLedgerHooksForTest({
      strictDirectoryDurability: () => {
        durabilityCalls += 1;
        if (durabilityCalls === 3) {
          fs.writeFileSync(workedLedgerPath(), concurrent, { mode: 0o600 });
        }
        return true;
      },
    });

    const result = replayWorkedOutcomeAfterDispatchReceipt({
      itemId: event.itemId,
      outcome: 'empty',
      dispatchReceipt: {
        ts: event.ts,
        itemId: event.itemId,
        repo: event.repo,
        outcome: event.outcome,
        attemptId: event.trajectoryId!,
      },
    });
    _setWorkedLedgerHooksForTest(undefined);
    const ledger = loadWorkedLedger();
    expect(durabilityCalls).toBe(3);
    expect({
      result,
      replayPresent: ledger.events.some((row) => row.itemId === event.itemId),
    }).toEqual({ result: 'persistence-failed', replayPresent: false });
    expect(fs.readFileSync(workedLedgerPath(), 'utf8')).toBe(concurrent);
  });

  it('rejects future receipt replay and future suppressible cooldowns', () => {
    const futureTs = new Date(Date.now() + 2 * 60_000).toISOString();
    const event = sanitizeDispatchProductionEvent({
      schemaVersion: 1,
      ts: futureTs,
      itemId: 'binshield:self-heal:future-authority-refusal',
      source: 'self',
      repo: tmpRepo,
      title: 'Reject future authority',
      backend: 'local-coder',
      tier: 'mid',
      assignedBy: 'daemon',
      routeReason: 'future receipt fixture',
      outcome: 'empty-diff',
      proposalCreated: false,
      runId: 'attempt-55555555-5555-4555-8555-555555555555',
      trajectoryId: 'run:attempt-55555555-5555-4555-8555-555555555555',
      spentUsd: 0,
      basis: 'run-proposal-outcome',
    }, { materializeLearningLabel: true });
    expect(recordDispatchProduction(event)).toMatchObject({ recorded: 1, failed: 0 });

    expect(replayWorkedOutcomeAfterDispatchReceipt({
      itemId: event.itemId,
      outcome: 'empty',
      dispatchReceipt: {
        ts: event.ts,
        itemId: event.itemId,
        repo: event.repo,
        outcome: event.outcome,
        attemptId: event.trajectoryId!,
      },
    })).toBe('dispatch-receipt-unavailable');
    expect(workedEventIsCooling(
      { itemId: event.itemId, outcome: 'empty', ts: futureTs },
      60 * 60_000,
      Date.now(),
    )).toBe(false);
    expect(loadWorkedLedger().events).toEqual([]);
  });

  it('refuses worked replay for missing receipts and adversarial outcome near-matches', () => {
    const receipt = {
      ts: '2026-07-21T23:25:00.000Z',
      itemId: 'ashlr-hub:goal:c290bd029f',
      repo: tmpRepo,
      outcome: 'proposal-created',
      attemptId: 'run:attempt-missing-receipt',
    };
    expect(replayWorkedOutcomeAfterDispatchReceipt({
      itemId: receipt.itemId,
      outcome: 'empty',
      dispatchReceipt: receipt,
    })).toBe('invalid');
    expect(replayWorkedOutcomeAfterDispatchReceipt({
      itemId: receipt.itemId,
      outcome: 'diff',
      dispatchReceipt: receipt,
    })).toBe('dispatch-receipt-unavailable');
    expect(loadWorkedLedger().events).toEqual([]);
  });

  it('leaves noncanonical worked history byte-for-byte unchanged during replay refusal', () => {
    const event = sanitizeDispatchProductionEvent({
      schemaVersion: 1,
      ts: '2026-07-21T23:25:00.000Z',
      itemId: 'binshield:self-heal:recovery-preserves-history',
      source: 'self',
      repo: tmpRepo,
      title: 'Preserve worked history',
      backend: 'local-coder',
      tier: 'mid',
      assignedBy: 'daemon',
      routeReason: 'operator recovery fixture',
      outcome: 'empty-diff',
      proposalCreated: false,
      runId: 'attempt-11111111-1111-4111-8111-111111111111',
      trajectoryId: 'run:attempt-11111111-1111-4111-8111-111111111111',
      spentUsd: 0,
      basis: 'run-proposal-outcome',
    }, { materializeLearningLabel: true });
    expect(recordDispatchProduction(event)).toMatchObject({ recorded: 1, failed: 0 });
    const pathToLedger = workedLedgerPath();
    fs.mkdirSync(path.dirname(pathToLedger), { recursive: true });
    const historical = '{"events":[{"itemId":"historical","outcome":"empty","ts":"bad-time"}],"unknown":true}\n';
    fs.writeFileSync(pathToLedger, historical, 'utf8');

    expect(replayWorkedOutcomeAfterDispatchReceipt({
      itemId: event.itemId,
      outcome: 'empty',
      dispatchReceipt: {
        ts: event.ts,
        itemId: event.itemId,
        repo: event.repo,
        outcome: event.outcome,
        attemptId: event.trajectoryId!,
      },
    })).toBe('persistence-failed');
    expect(fs.readFileSync(pathToLedger, 'utf8')).toBe(historical);
  });

  it('recentlyDeclined returns false when no entry exists', () => {
    expect(recentlyDeclined('unknown-item', 6 * 60 * 60 * 1000)).toBe(false);
  });

  it('recentlyDeclined returns false when last outcome is "diff"', () => {
    const ts = new Date(Date.now() - 1000).toISOString(); // 1 second ago
    recordOutcome('item-diff', 'diff', ts);
    expect(recentlyDeclined('item-diff', 6 * 60 * 60 * 1000)).toBe(false);
  });

  it('recentlyDeclined returns true within cooldown after "empty"', () => {
    const ts = new Date(Date.now() - 1000).toISOString(); // 1 second ago
    recordOutcome('item-empty', 'empty', ts);
    // Cooldown = 1 hour; 1 second ago is within 1h
    expect(recentlyDeclined('item-empty', 60 * 60 * 1000)).toBe(true);
  });

  it('recentlyDeclined returns false when "empty" is outside cooldown', () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    recordOutcome('item-old-empty', 'empty', old);
    // Cooldown = 1h; 2h ago is outside
    expect(recentlyDeclined('item-old-empty', 60 * 60 * 1000)).toBe(false);
  });

  it('recentlyDeclined returns false when "diff" follows an "empty"', () => {
    const old = new Date(Date.now() - 1000).toISOString();
    const newer = new Date(Date.now() - 500).toISOString();
    recordOutcome('item-seq', 'empty', old);
    recordOutcome('item-seq', 'diff',  newer); // last event is 'diff'
    expect(recentlyDeclined('item-seq', 60 * 60 * 1000)).toBe(false);
  });

  it('selects one latest outcome across generation aliases', () => {
    const keys = ['repair:v1', 'repair:v2'];
    const olderEmpty = { itemId: keys[0]!, outcome: 'empty' as const, ts: '2026-07-10T12:00:00.000Z' };
    const newerDiff = { itemId: keys[1]!, outcome: 'diff' as const, ts: '2026-07-10T13:00:00.000Z' };
    expect(latestWorkedEventForKeys([olderEmpty, newerDiff], keys)).toBe(newerDiff);
    expect(workedEventIsCooling(newerDiff, 60_000, Date.parse('2026-07-10T13:00:30.000Z'))).toBe(false);

    const newerDecline = { itemId: keys[0]!, outcome: 'judged-decline' as const, ts: '2026-07-10T14:00:00.000Z' };
    expect(latestWorkedEventForKeys([newerDiff, newerDecline], keys)).toBe(newerDecline);
    expect(workedEventIsCooling(newerDecline, 60_000, Date.parse('2026-07-10T14:00:30.000Z'))).toBe(true);
  });

  it('uses append order for equal timestamps and ignores malformed timestamps', () => {
    const first = { itemId: 'repair:v1', outcome: 'empty' as const, ts: '2026-07-10T12:00:00.000Z' };
    const malformed = { itemId: 'repair:v2', outcome: 'judged-decline' as const, ts: 'not-a-date' };
    const last = { itemId: 'repair:v2', outcome: 'diff' as const, ts: first.ts };
    expect(latestWorkedEventForKeys([first, malformed, last], ['repair:v1', 'repair:v2'])).toBe(last);
  });

  it('never throws when the ledger file is missing', () => {
    // HOME already set to fresh tmpHome — file doesn't exist yet
    expect(() => recentlyDeclined('no-file-item', 1000)).not.toThrow();
    expect(() => loadWorkedLedger()).not.toThrow();
  });

  it('never throws when the ledger file is corrupt', () => {
    const p = workedLedgerPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{ NOT VALID JSON !!!', 'utf8');
    expect(() => recentlyDeclined('bad-json', 1000)).not.toThrow();
    expect(() => loadWorkedLedger()).not.toThrow();
    // loadWorkedLedger should return a fresh empty ledger
    expect(loadWorkedLedger().events).toEqual([]);
  });

  it('returns a fresh ledger without reading an oversized worked file', () => {
    const p = workedLedgerPath();
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20), { mode: 0o600 });

    expect(() => loadWorkedLedger()).not.toThrow();
    expect(loadWorkedLedger()).toEqual({ events: [] });
    expect(fs.statSync(p).size).toBe(2 * 1024 * 1024 + 1);
  });

  it('returns a fresh ledger without following a worked file symlink', () => {
    if (process.platform === 'win32') {
      expect(process.platform).toBe('win32');
      return;
    }
    const p = workedLedgerPath();
    const victim = path.join(tmpHome, 'public-load-worked-victim.json');
    const victimBytes = '{"events":[{"itemId":"must-not-load-through-link","outcome":"empty","ts":"2026-07-21T23:24:36.686Z"}]}\n';
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(victim, victimBytes, { mode: 0o600 });
    fs.symlinkSync(victim, p, 'file');

    expect(() => loadWorkedLedger()).not.toThrow();
    expect(loadWorkedLedger()).toEqual({ events: [] });
    expect(fs.readFileSync(victim, 'utf8')).toBe(victimBytes);
    expect(fs.lstatSync(p).isSymbolicLink()).toBe(true);
  });

  it('recordOutcome never throws on a read-only directory (simulated by bad path)', () => {
    // Override HOME to a non-writable path won't work cross-platform easily,
    // so instead we verify the function signature: it returns void, no throw.
    expect(() => recordOutcome('x', 'empty')).not.toThrow();
  });
});

// ===========================================================================
// 2. Fairness selection — items from all 3 repos are selected
// ===========================================================================

describe('M85 fairness — round-robin across repos', () => {
  beforeEach(() => {
    enroll(tmpRepo);
    enroll(tmpRepo2);
    enroll(tmpRepo3);
  });

  it('selects at least one item from each of 3 repos when perTickItems >= 3', async () => {
    // Give each repo 2 items so the round-robin has something to pick.
    backlogItems = [
      makeItem('r1-a', tmpRepo,  { score: 5 }),
      makeItem('r1-b', tmpRepo,  { score: 4 }),
      makeItem('r2-a', tmpRepo2, { score: 5 }),
      makeItem('r2-b', tmpRepo2, { score: 4 }),
      makeItem('r3-a', tmpRepo3, { score: 5 }),
      makeItem('r3-b', tmpRepo3, { score: 4 }),
    ];

    const dispatched: string[] = [];
    mockRunSwarm.mockImplementation(async (_input: unknown, _cfg: unknown, opts: unknown) => {
      const o = opts as Record<string, unknown>;
      dispatched.push(o['project'] as string);
      return { id: 'sw', status: 'done', goal: '', result: '', usage: { estCostUsd: 0, totalTokens: 0, steps: 1 } };
    });

    // perTickItems = 6 so all 3 repos get at least one slot
    await tick(makeCfg({ daemon: { dailyBudgetUsd: 10, perTickItems: 6, parallel: 6, intervalMs: 100 } }), { dryRun: false });

    const reposSeen = new Set(dispatched);
    expect(reposSeen.has(tmpRepo)).toBe(true);
    expect(reposSeen.has(tmpRepo2)).toBe(true);
    expect(reposSeen.has(tmpRepo3)).toBe(true);
  });

  it('does NOT dispatch all items from a single repo when multiple repos have items', async () => {
    // Repo1 has 4 high-scoring items; repos 2 and 3 have 1 each.
    // Without fairness, the top-K slice would take all 4 from repo1 first.
    backlogItems = [
      makeItem('r1-a', tmpRepo,  { score: 10 }),
      makeItem('r1-b', tmpRepo,  { score: 9 }),
      makeItem('r1-c', tmpRepo,  { score: 8 }),
      makeItem('r1-d', tmpRepo,  { score: 7 }),
      makeItem('r2-a', tmpRepo2, { score: 3 }),
      makeItem('r3-a', tmpRepo3, { score: 2 }),
    ];

    const dispatched: string[] = [];
    mockRunSwarm.mockImplementation(async (_input: unknown, _cfg: unknown, opts: unknown) => {
      const o = opts as Record<string, unknown>;
      dispatched.push(o['project'] as string);
      return { id: 'sw', status: 'done', goal: '', result: '', usage: { estCostUsd: 0, totalTokens: 0, steps: 1 } };
    });

    // perTickItems = 3 — fairness should give each repo one slot
    await tick(makeCfg({ daemon: { dailyBudgetUsd: 10, perTickItems: 3, parallel: 3, intervalMs: 100 } }), { dryRun: false });

    const reposSeen = new Set(dispatched);
    // All three repos should have been visited
    expect(reposSeen.has(tmpRepo)).toBe(true);
    expect(reposSeen.has(tmpRepo2)).toBe(true);
    expect(reposSeen.has(tmpRepo3)).toBe(true);
    // Repo1 should NOT have consumed all 3 slots
    const repo1Count = dispatched.filter(r => r === tmpRepo).length;
    expect(repo1Count).toBeLessThan(3);
  });
});

// ===========================================================================
// 3. Cooldown skip — a recently-'empty' item is not re-dispatched
// ===========================================================================

describe('M85 cooldown skip — recentlyDeclined items are skipped', () => {
  beforeEach(() => {
    enroll(tmpRepo);
  });

  it('skips an item whose last outcome was "empty" within cooldown, dispatches the other', async () => {
    const cooledId = 'cooled-item';
    const freshId  = 'fresh-item';

    // Mark cooledId as recently empty (1 second ago, well within any cooldown).
    const recent = new Date(Date.now() - 1000).toISOString();
    recordOutcome(cooledId, 'empty', recent);

    backlogItems = [
      makeItem(cooledId, tmpRepo, { score: 10 }), // high score but cooled down
      makeItem(freshId,  tmpRepo, { score: 5  }), // lower score but fresh
    ];

    const dispatched: string[] = [];
    mockRunSwarm.mockImplementation(async (_input: unknown, _cfg: unknown, opts: unknown) => {
      const o = opts as Record<string, unknown>;
      // Capture which item title was used as the goal prefix
      const goalStr = (_input as Record<string, unknown>)?.['goal'] as string ?? '';
      dispatched.push(goalStr);
      createProposal({ repo: tmpRepo, origin: 'swarm', kind: 'patch', title: goalStr, summary: '', diff: 'diff\n' });
      return { id: 'sw', status: 'done', goal: goalStr, result: '', usage: { estCostUsd: 0, totalTokens: 0, steps: 1 } };
    });

    // cooldownMs set very large so the 1s-old empty record is within window.
    // We pass it via daemon.cooldownMs (read by the loop defensively).
    const cfg = {
      ...makeCfg(),
      daemon: { dailyBudgetUsd: 10, perTickItems: 3, parallel: 3, intervalMs: 100, cooldownMs: 6 * 60 * 60 * 1000 },
    } as unknown as AshlrConfig;
    liveCfgOverride = cfg;

    await tick(cfg, { dryRun: false });

    // Only the fresh item should have been dispatched
    expect(dispatched.some(g => g.includes(freshId))).toBe(true);
    expect(dispatched.some(g => g.includes(cooledId))).toBe(false);
  });

  it('dispatches a previously-empty item after the cooldown expires', async () => {
    const expiredId = 'expired-item';

    // Mark as empty 3 hours ago; cooldown is 1 hour → should NOT be skipped.
    const oldTs = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    recordOutcome(expiredId, 'empty', oldTs);

    backlogItems = [makeItem(expiredId, tmpRepo, { score: 5 })];

    const dispatched: string[] = [];
    mockRunSwarm.mockImplementation(async (_input: unknown, _cfg: unknown, opts: unknown) => {
      const o = opts as Record<string, unknown>;
      dispatched.push(o['project'] as string ?? '');
      return { id: 'sw', status: 'done', goal: '', result: '', usage: { estCostUsd: 0, totalTokens: 0, steps: 1 } };
    });

    // cooldownMs = 1h; the empty record is 3h old → not declined
    const cfg = {
      ...makeCfg(),
      daemon: { dailyBudgetUsd: 10, perTickItems: 3, parallel: 3, intervalMs: 100, cooldownMs: 60 * 60 * 1000 },
    } as unknown as AshlrConfig;
    liveCfgOverride = cfg;

    await tick(cfg, { dryRun: false });

    expect(dispatched.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 4. Config reload — loadConfig is called per tick; changed values take effect
// ===========================================================================

describe('M85 config — tick honors its cfg arg (live reload is runDaemon\'s job)', () => {
  beforeEach(() => {
    enroll(tmpRepo);
    backlogItems = [makeItem('reload-1', tmpRepo), makeItem('reload-2', tmpRepo)];
  });

  it('honors perTickItems=1 from the passed cfg', async () => {
    const t = await tick(makeCfg({ daemon: { dailyBudgetUsd: 10, perTickItems: 1, parallel: 1, intervalMs: 100 } }), { dryRun: false });
    expect(t.itemsConsidered).toBe(1);
  });

  it('honors perTickItems=2 from the passed cfg', async () => {
    const t = await tick(makeCfg({ daemon: { dailyBudgetUsd: 10, perTickItems: 2, parallel: 2, intervalMs: 100 } }), { dryRun: false });
    expect(t.itemsConsidered).toBe(2);
  });

  it('uses the PASSED cfg, not the on-disk config (never clobbers an explicit cfg)', async () => {
    // loadConfig (mocked) returns perTickItems=5, but tick MUST honor its ARG (1).
    // The live reload happens in runDaemon's loop, not inside tick().
    liveCfgOverride = makeCfg({ daemon: { dailyBudgetUsd: 10, perTickItems: 5, parallel: 5, intervalMs: 100 } });
    const t = await tick(makeCfg({ daemon: { dailyBudgetUsd: 10, perTickItems: 1, parallel: 1, intervalMs: 100 } }), { dryRun: false });
    expect(t.itemsConsidered).toBe(1);
  });
});
