/**
 * V3.10 U6 key tests (SPEC-310B §7): the mutation-fence split, end to end,
 * through the REAL sandboxed producers, real git worktrees and real locks.
 *
 *   - 4 agents across 2 repos run concurrently.
 *   - Refs (worktree creation / filing) are serialized per repo — and only per repo.
 *   - Kill drains mid-inference: every agent is aborted and kill reports
 *     quiescence only once they are gone; a Stop from ANOTHER process reaches
 *     them through the lease probe; an agent that ignores its abort still files
 *     nothing.
 *   - Unenroll drains only its own repo.
 *   - Verification (the completeness gate) runs at most 2 machine-wide, 1 per repo.
 *
 * Only the model is faked (spawnEngine / runTask); everything between the
 * daemon and the model is production code. REAL-IO: see
 * test/helpers/throughput-310b.ts.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AshlrConfig, RunTask } from '../src/core/types.js';
import { makeCfg, makeFixture, type DisposableRepo, type H1Fixture } from './helpers/h1-fixture.js';
import { runTsxChild } from './helpers/throughput-310b.js';

vi.mock('../src/core/run/engines.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/run/engines.js')>();
  return { ...actual, spawnEngine: vi.fn() };
});

vi.mock('../src/core/run/agent-loop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/run/agent-loop.js')>();
  return { ...actual, runTask: vi.fn() };
});

const gateProbe = vi.hoisted(() => ({
  machine: 0,
  machinePeak: 0,
  perRepo: new Map<string, number>(),
  perRepoPeak: new Map<string, number>(),
  /** worktree path → source repo, filled by the spawn double. */
  repoOf: new Map<string, string>(),
}));

vi.mock('../src/core/run/completeness-gate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/run/completeness-gate.js')>();
  return {
    ...actual,
    // Stands in for a real typecheck/test run: occupies its slot for a while
    // and records how many ran at once, machine-wide and per repo.
    runCompletenessGate: vi.fn(async (input: { worktreePath: string; isPartial?: boolean }) => {
      if (input.isPartial) return { pass: false, reason: '[partial]' };
      const key = gateProbe.repoOf.get(input.worktreePath) ?? input.worktreePath;
      gateProbe.machine += 1;
      gateProbe.perRepo.set(key, (gateProbe.perRepo.get(key) ?? 0) + 1);
      gateProbe.machinePeak = Math.max(gateProbe.machinePeak, gateProbe.machine);
      gateProbe.perRepoPeak.set(key, Math.max(gateProbe.perRepoPeak.get(key) ?? 0, gateProbe.perRepo.get(key)!));
      await new Promise((resolve) => setTimeout(resolve, 60));
      gateProbe.machine -= 1;
      gateProbe.perRepo.set(key, gateProbe.perRepo.get(key)! - 1);
      return { pass: true };
    }),
  };
});

import { runTask } from '../src/core/run/agent-loop.js';
import { spawnEngine } from '../src/core/run/engines.js';
import { runApiModelSandboxed, runEngineSandboxed, type SandboxedEngineResult } from '../src/core/run/sandboxed-engine.js';
import { listProposals } from '../src/core/inbox/store.js';
import { acquireRepoLease, countLiveExecutionLeases } from '../src/core/sandbox/execution-leases.js';
import { killSwitchOn, setKill, setKillAndDrain, unenrollAndDrain } from '../src/core/sandbox/policy.js';
import { listSandboxes, removeSandbox } from '../src/core/sandbox/worktree.js';

const REAL_IO_TIMEOUT = 90_000;
const spawnEngineMock = vi.mocked(spawnEngine);
const runTaskMock = vi.mocked(runTask);
const srcUrl = (rel: string): string => pathToFileURL(join(process.cwd(), 'src', rel)).href;

function config(overrides: { completenessGate?: boolean } = {}): AshlrConfig {
  return makeCfg({
    models: { providerChain: [] },
    foundry: {
      completenessGate: overrides.completenessGate ?? false,
      dispatchRetries: 0,
      fleetMcp: false,
      models: {
        claude: 'claude-sonnet-4-5',
        'local-coder': 'qwen2.5:72b-instruct-q4_K_M',
      },
    },
  } as Partial<AshlrConfig>);
}

/** A real (non-trivial) source change, so the triviality filter files it. */
function writeChange(cwd: string, tag: string): void {
  writeFileSync(join(cwd, `agent-${tag}.ts`), [
    `export function agent${tag.replace(/\W/g, '')}(values: number[]): number {`,
    '  let total = 0;',
    '  for (const value of values) {',
    '    if (value > 0) total += value * 2;',
    '    else total -= value;',
    '  }',
    '  return total;',
    '}',
    '',
  ].join('\n'), 'utf8');
}

interface Barrier {
  arrive(): Promise<void>;
  readonly arrived: number;
}

/** Resolves every waiter once `n` have arrived; rejects them all after `timeoutMs` (= they were serialized). */
function barrier(n: number, timeoutMs = 15_000): Barrier {
  let arrived = 0;
  let open!: () => void;
  let fail!: (error: Error) => void;
  const gate = new Promise<void>((resolve, reject) => { open = resolve; fail = reject; });
  gate.catch(() => undefined);
  const timer = setTimeout(() => fail(new Error(`only ${arrived}/${n} agents were ever in inference at once`)), timeoutMs);
  return {
    get arrived() { return arrived; },
    arrive: () => {
      arrived += 1;
      if (arrived === n) {
        clearTimeout(timer);
        open();
      }
      return gate;
    },
  };
}

function waitUntil(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('condition not reached'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

let fx: H1Fixture;
let a: DisposableRepo;
let b: DisposableRepo;

beforeEach(() => {
  fx = makeFixture();
  a = fx.makeRepo({ files: { 'README.md': '# repo a\n', 'src/index.ts': 'export const a = 1;\n' } });
  b = fx.makeRepo({ files: { 'README.md': '# repo b\n', 'src/index.ts': 'export const b = 1;\n' } });
  a.enroll();
  b.enroll();
  gateProbe.machine = 0;
  gateProbe.machinePeak = 0;
  gateProbe.perRepo.clear();
  gateProbe.perRepoPeak.clear();
  gateProbe.repoOf.clear();
});

afterEach(() => {
  vi.clearAllMocks();
  try {
    setKill(false, { waitMs: 1_000 });
    for (const sb of listSandboxes()) removeSandbox(sb);
  } catch { /* fixture cleanup removes the tmp HOME regardless */ }
  fx.cleanup();
});

describe('U6 throughput: the fence no longer caps the machine at one agent', () => {
  it('4 CLI agents across 2 repos are in inference at the same time, and all 4 file', async () => {
    const all = barrier(4);
    let inFlight = 0;
    let peak = 0;
    spawnEngineMock.mockImplementation(async (cmd, _cfg, opts) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      writeChange(cmd.cwd!, `${inFlight}${Math.random().toString(36).slice(2, 6)}`);
      try {
        await all.arrive();
      } finally {
        inFlight -= 1;
      }
      expect(opts.signal?.aborted).toBe(false);
      return { ok: true, output: 'done' };
    });

    const runs = [a, a, b, b].map((repo, i) =>
      runEngineSandboxed('claude', `concurrent goal ${i}`, config(), { sourceRepo: repo.dir, propose: true }));
    const results = await Promise.all(runs);

    expect(peak).toBe(4);
    expect(results.map((r) => r.proposalOutcome?.kind)).toEqual(['filed', 'filed', 'filed', 'filed']);
    expect(listProposals()).toHaveLength(4);
    expect(listProposals().filter((p) => p.repo === a.dir)).toHaveLength(2);
    expect(listSandboxes()).toEqual([]);
    expect(countLiveExecutionLeases()).toBe(0);
  }, REAL_IO_TIMEOUT);

  it('CLI and api-model producers share the machine: 2 + 2 in flight at once', async () => {
    const all = barrier(4);
    let peak = 0;
    let inFlight = 0;
    const enter = async (): Promise<void> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try { await all.arrive(); } finally { inFlight -= 1; }
    };
    spawnEngineMock.mockImplementation(async () => {
      await enter();
      return { ok: true, output: 'no changes' };
    });
    runTaskMock.mockImplementation(async (task: RunTask) => {
      await enter();
      task.status = 'done';
      task.result = 'no changes';
      return task;
    });
    const results = await Promise.all([
      runEngineSandboxed('claude', 'cli a', config(), { sourceRepo: a.dir }),
      runEngineSandboxed('claude', 'cli b', config(), { sourceRepo: b.dir }),
      runApiModelSandboxed('local-coder', 'api a', config(), { sourceRepo: a.dir }),
      runApiModelSandboxed('local-coder', 'api b', config(), { sourceRepo: b.dir }),
    ]);
    expect(peak).toBe(4);
    expect(results.map((r) => r.proposalOutcome?.kind)).toEqual(['empty-diff', 'empty-diff', 'empty-diff', 'empty-diff']);
    expect(countLiveExecutionLeases()).toBe(0);
  }, REAL_IO_TIMEOUT);
});

describe('U6 refs are serialized per repo', () => {
  it('a held repo lease blocks worktree creation on THAT repo only', async () => {
    const entered: string[] = [];
    spawnEngineMock.mockImplementation(async (cmd) => {
      entered.push(cmd.cwd!);
      writeChange(cmd.cwd!, `x${entered.length}`);
      return { ok: true, output: 'done' };
    });
    // Stand-in for a mirror sync / fleet push holding repo A.
    const held = await acquireRepoLease(a.dir);
    expect(held.ok).toBe(true);
    if (!held.ok) return;

    const onA = runEngineSandboxed('claude', 'blocked on a', config(), { sourceRepo: a.dir, propose: true });
    const onB = await runEngineSandboxed('claude', 'free on b', config(), { sourceRepo: b.dir, propose: true });

    expect(onB.proposalOutcome?.kind).toBe('filed');
    expect(entered).toHaveLength(1);
    expect(listSandboxes().filter((sb) => sb.sourceRepo === a.dir)).toEqual([]);

    held.lease.release();
    const resultA = await onA;
    expect(resultA.proposalOutcome?.kind).toBe('filed');
    expect(entered).toHaveLength(2);
    expect(listProposals()).toHaveLength(2);
  }, REAL_IO_TIMEOUT);

  it('verification runs at most 2 machine-wide and 1 per repo', async () => {
    spawnEngineMock.mockImplementation(async (cmd) => {
      const sandbox = listSandboxes().find((sb) => sb.worktreePath === cmd.cwd);
      gateProbe.repoOf.set(cmd.cwd!, sandbox?.sourceRepo ?? 'unknown');
      writeChange(cmd.cwd!, Math.random().toString(36).slice(2, 8));
      return { ok: true, output: 'done' };
    });
    const cfg = config({ completenessGate: true });
    const results: SandboxedEngineResult[] = await Promise.all([a, a, a, b, b, b].map((repo, i) =>
      runEngineSandboxed('claude', `verify ${i}`, cfg, { sourceRepo: repo.dir, propose: true })));
    expect(results.every((r) => r.proposalOutcome?.kind === 'filed')).toBe(true);
    expect(gateProbe.machinePeak).toBeLessThanOrEqual(2);
    expect(gateProbe.machinePeak).toBeGreaterThanOrEqual(1);
    expect([...gateProbe.perRepoPeak.keys()].sort()).toEqual([a.dir, b.dir].sort());
    for (const peak of gateProbe.perRepoPeak.values()) expect(peak).toBe(1);
  }, REAL_IO_TIMEOUT);
});

describe('U6 kill drains mid-inference', () => {
  /** Engines that run until they are told to stop. */
  function blockUntilAborted(entered: { count: number }): void {
    spawnEngineMock.mockImplementation(async (cmd, _cfg, opts) => {
      entered.count += 1;
      writeChange(cmd.cwd!, `k${entered.count}`);
      await new Promise<void>((resolve) => {
        if (opts.signal?.aborted) return resolve();
        opts.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { ok: false, output: '', error: 'run cancelled', terminationReason: 'cancelled' };
    });
  }

  it('Stop aborts every running agent and reports quiescence only once they are gone', async () => {
    const entered = { count: 0 };
    blockUntilAborted(entered);
    const runs = [a, a, b].map((repo, i) =>
      runEngineSandboxed('claude', `long goal ${i}`, config(), { sourceRepo: repo.dir, propose: true }));
    await waitUntil(() => entered.count === 3);
    expect(countLiveExecutionLeases()).toBe(3);

    const stop = await setKillAndDrain({ drainMs: 20_000, pollMs: 25 });
    expect(stop).toMatchObject({ ok: true, quiesced: true, liveExecutionLeases: 0 });
    expect(killSwitchOn()).toBe(true);

    const results = await Promise.all(runs);
    for (const result of results) {
      expect(result.state).toMatchObject({ status: 'aborted', terminationReason: 'cancelled' });
      expect(result).not.toHaveProperty('proposalId');
    }
    expect(listProposals()).toEqual([]);
    expect(countLiveExecutionLeases()).toBe(0);
  }, REAL_IO_TIMEOUT);

  it('a Stop issued by ANOTHER process reaches running agents through the lease probe', async () => {
    const entered = { count: 0 };
    blockUntilAborted(entered);
    const run = runEngineSandboxed('claude', 'long goal', config(), { sourceRepo: a.dir, propose: true });
    await waitUntil(() => entered.count === 1);

    const childSaid = JSON.parse(runTsxChild(String.raw`
      import { setKill } from ${JSON.stringify(srcUrl('core/sandbox/policy.ts'))};
      const result = setKill(true, { waitMs: 2000 });
      process.stdout.write(JSON.stringify(result));
    `, fx.home)) as { quiesced: boolean };
    // The other process sees this run's live lease, so it cannot claim quiescence.
    expect(childSaid.quiesced).toBe(false);

    const started = Date.now();
    const result = await run;
    // Within one probe interval (2 s) plus slack — never "after the model finishes".
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.state).toMatchObject({ status: 'aborted', terminationReason: 'cancelled' });
    expect(listProposals()).toEqual([]);
    expect(await setKillAndDrain({ drainMs: 5_000 })).toMatchObject({ quiesced: true });
  }, REAL_IO_TIMEOUT);

  it('an agent that ignores its abort still files nothing after KILL', async () => {
    spawnEngineMock.mockImplementation(async (cmd) => {
      writeChange(cmd.cwd!, 'ignorer');
      // Arm KILL from another process (no in-process abort), then finish at
      // once — before the 2 s lease probe can notice — as a runaway engine would.
      runTsxChild(String.raw`
        import { setKill } from ${JSON.stringify(srcUrl('core/sandbox/policy.ts'))};
        setKill(true, { waitMs: 2000 });
      `, fx.home);
      return { ok: true, output: 'finished anyway' };
    });
    const result = await runEngineSandboxed('claude', 'runaway', config(), { sourceRepo: a.dir, propose: true });
    expect(killSwitchOn()).toBe(true);
    expect(listProposals()).toEqual([]);
    expect(result.proposalId).toBeUndefined();
    expect(result.candidateProposalId).toBeUndefined();
    // Either the filing gate refused it (the usual case) or the probe fired first.
    const refusedAtFiling = result.proposalOutcome?.kind === 'kill-switch';
    const cancelled = result.state.status === 'aborted';
    expect(refusedAtFiling || cancelled).toBe(true);
    expect(countLiveExecutionLeases()).toBe(0);
  }, REAL_IO_TIMEOUT);

  it('unenroll drains only its own repo', async () => {
    const entered = new Map<string, number>();
    const controllers = [new AbortController(), new AbortController()];
    spawnEngineMock.mockImplementation(async (cmd, _cfg, opts) => {
      const repo = listSandboxes().find((sb) => sb.worktreePath === cmd.cwd)?.sourceRepo ?? 'unknown';
      entered.set(repo, (entered.get(repo) ?? 0) + 1);
      await new Promise<void>((resolve) => {
        if (opts.signal?.aborted) return resolve();
        opts.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { ok: false, output: '', error: 'run cancelled', terminationReason: 'cancelled' };
    });
    const onA = runEngineSandboxed('claude', 'a', config(), { sourceRepo: a.dir, signal: controllers[0]!.signal });
    const onB = runEngineSandboxed('claude', 'b', config(), { sourceRepo: b.dir, signal: controllers[1]!.signal });
    await waitUntil(() => (entered.get(a.dir) ?? 0) === 1 && (entered.get(b.dir) ?? 0) === 1);

    const unenrolled = await unenrollAndDrain(a.dir, { drainMs: 20_000, pollMs: 25 });
    expect(unenrolled).toMatchObject({ ok: true, changed: true, quiesced: true, liveExecutionLeases: 0 });
    expect((await onA).state).toMatchObject({ status: 'aborted' });

    // B is untouched: still running under its lease.
    expect(countLiveExecutionLeases({ repoKeys: [b.dir] })).toBe(1);
    controllers[1]!.abort();
    expect((await onB).state).toMatchObject({ status: 'aborted' });
    expect(countLiveExecutionLeases()).toBe(0);
  }, REAL_IO_TIMEOUT);
});
