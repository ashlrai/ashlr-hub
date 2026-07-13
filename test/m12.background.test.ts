/**
 * M12 background-worker tests — hermetic. Mocks child_process.spawn so NO real
 * detached process is launched. Asserts the single, consolidated background
 * mechanism: runSwarm persists a skeleton, then spawns the worker as
 *   node <bin/ashlr> swarm --resume <id> --_worker
 * with ASHLR_IN_SWARM CLEARED on the worker env (the worker IS the runner, not
 * a swarm task, so its own recursion guard must not refuse it).
 *
 * SAFETY: HOME is a tmp dir; spawn is mocked; planner + orchestrator are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AshlrConfig,
  SwarmOptions,
  SwarmPlan,
  SwarmRun,
} from '../src/core/types.js';
import type { StreamSink } from '../src/core/run/streaming.js';

// Capture spawn invocations
interface SpawnCall {
  cmd: string;
  args: string[];
  opts: { detached?: boolean; stdio?: unknown; env?: Record<string, string | undefined> };
}
const spawnCalls: SpawnCall[] = [];
class FakeChild extends EventEmitter {
  unref = vi.fn();
  disconnect = vi.fn();
  kill = vi.fn();
}
let fakeChild: FakeChild;
let workerLaunch: 'ack' | 'exit';

vi.mock('node:child_process', async (orig) => {
  const actual = (await orig()) as typeof import('node:child_process');
  return {
    ...actual,
    spawn: vi.fn((cmd: string, args: string[], opts: SpawnCall['opts']) => {
      spawnCalls.push({ cmd, args, opts });
      const token = opts.env?.ASHLR_BACKGROUND_HANDOFF_TOKEN;
      queueMicrotask(() => {
        if (workerLaunch === 'exit') fakeChild.emit('exit', 1, null);
        else fakeChild.emit('message', {
          protocol: 'ashlr-background-handoff-v1',
          swarmId: args[3],
          token,
        });
      });
      return fakeChild as unknown as ReturnType<typeof actual.spawn>;
    }),
  };
});

// Mock orchestrator so the worker path never runs a real agent (it won't be
// reached in the background-launch test, but keep it inert for safety).
vi.mock('../src/core/run/orchestrator.js', () => ({
  runGoal: vi.fn(),
  saveRun: vi.fn(),
  loadRun: vi.fn().mockReturnValue(null),
  listRuns: vi.fn().mockReturnValue([]),
  planGoal: vi.fn(),
}));

const mockPlanSwarm = vi.fn();
vi.mock('../src/core/swarm/planner.js', () => ({
  planSwarm: mockPlanSwarm,
}));

const origHome = process.env.HOME;
const origInSwarm = process.env.ASHLR_IN_SWARM;
let tmpHome: string;

let runSwarm: (
  input: { goal: string; specId?: string },
  cfg: AshlrConfig,
  opts: SwarmOptions,
  sink: StreamSink,
) => Promise<SwarmRun>;
let loadSwarm: (id: string) => SwarmRun | null;

async function ensureImported(): Promise<void> {
  if (!runSwarm) {
    const runner = await import('../src/core/swarm/runner.js');
    runSwarm = runner.runSwarm;
    const store = await import('../src/core/swarm/store.js');
    loadSwarm = store.loadSwarm;
  }
}

function makeConfig(): AshlrConfig {
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
  } as AshlrConfig;
}

function plan(goal = 'bg goal'): SwarmPlan {
  return {
    specId: null,
    goal,
    tasks: [{ id: 'scaffold-1', phase: 'scaffold', goal: 'Init', deps: [] }],
  };
}

const nullSink: StreamSink = () => {};

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m12-bg-'));
  process.env.HOME = tmpHome;
  delete process.env.ASHLR_IN_SWARM;
  spawnCalls.length = 0;
  fakeChild = new FakeChild();
  workerLaunch = 'ack';
  vi.clearAllMocks();
  mockPlanSwarm.mockResolvedValue(plan());
  await ensureImported();
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  if (origInSwarm === undefined) delete process.env.ASHLR_IN_SWARM;
  else process.env.ASHLR_IN_SWARM = origInSwarm;
});

describe('runSwarm — --background spawns the worker correctly', () => {
  it('does not spawn a worker when the skeleton cannot be persisted', async () => {
    fs.mkdirSync(path.join(tmpHome, '.ashlr'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.ashlr', 'swarms'), 'not a directory');

    const result = await runSwarm(
      { goal: 'unpersistable background' },
      makeConfig(),
      { background: true },
      nullSink,
    );

    expect(result).toMatchObject({
      status: 'failed',
      result: expect.stringMatching(/not launched.*persistence unavailable/i),
    });
    expect(spawnCalls).toHaveLength(0);
  });

  it('persists a skeleton and returns the id immediately (no execution)', async () => {
    const result = await runSwarm(
      { goal: 'bg goal' },
      makeConfig(),
      { budget: { maxTokens: 50_000, maxSteps: 100 }, parallel: 1, background: true },
      nullSink,
    );

    // Foreground returns immediately with a persisted record.
    expect(typeof result.id).toBe('string');
    expect(loadSwarm(result.id)).not.toBeNull();
    // It did NOT run to completion in the foreground.
    expect(result.status).not.toBe('done');
  });

  it('reports a failed launch when the worker exits before acknowledging handoff', async () => {
    workerLaunch = 'exit';
    const result = await runSwarm(
      { goal: 'worker cannot start' },
      makeConfig(),
      { background: true },
      nullSink,
    );

    expect(result).toMatchObject({
      status: 'failed',
      result: expect.stringMatching(/handoff was not acknowledged/i),
    });
    expect(loadSwarm(result.id)).toMatchObject({ status: 'failed' });
    expect(fakeChild.unref).not.toHaveBeenCalled();
  });

  it('persists causal identity and resume flags for the detached worker', async () => {
    const workItemGenerationId = 'b'.repeat(64);
    const result = await runSwarm(
      { goal: 'bg repair' },
      makeConfig(),
      {
        budget: { maxTokens: 50_000, maxSteps: 100 },
        parallel: 1,
        background: true,
        propose: true,
        workItemId: 'repo:proposal-repair-nodiff:bg-generation',
        workItemGenerationId,
        workSource: 'self',
      },
      nullSink,
    );

    expect(loadSwarm(result.id)).toMatchObject({
      workItemId: 'repo:proposal-repair-nodiff:bg-generation',
      workItemGenerationId,
      workSource: 'self',
      resumeOptions: { propose: true },
    });
  });

  it('spawns the worker as `swarm --resume <id> --_worker`', async () => {
    const result = await runSwarm(
      { goal: 'bg goal' },
      makeConfig(),
      { budget: { maxTokens: 50_000, maxSteps: 100 }, parallel: 1, background: true },
      nullSink,
    );

    expect(spawnCalls.length).toBe(1);
    const call = spawnCalls[0]!;
    // argv: [binPath, 'swarm', '--resume', <id>, '--_worker']
    expect(call.args[0]).toMatch(/ashlr$/);
    expect(call.args.slice(1)).toEqual(['swarm', '--resume', result.id, '--_worker']);
    expect(call.opts.detached).toBe(true);
    expect(call.opts.stdio).toEqual(['ignore', 'ignore', 'ignore', 'ipc']);
    expect(fakeChild.unref).toHaveBeenCalled();
    expect(fakeChild.disconnect).toHaveBeenCalled();
  });

  it('does NOT set ASHLR_IN_SWARM on the worker env (worker IS the runner)', async () => {
    await runSwarm(
      { goal: 'bg goal' },
      makeConfig(),
      { budget: { maxTokens: 50_000, maxSteps: 100 }, parallel: 1, background: true },
      nullSink,
    );

    const call = spawnCalls[0]!;
    // The worker must start with ASHLR_IN_SWARM unset so its own recursion
    // guard does not refuse it. Node's spawn omits keys whose value is
    // undefined, so the worker process inherits no ASHLR_IN_SWARM.
    expect(call.opts.env?.ASHLR_IN_SWARM).toBeUndefined();
  });
});
