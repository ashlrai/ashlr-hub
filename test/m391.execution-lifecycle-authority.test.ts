import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AshlrConfig } from '../src/core/types.js';
import {
  acquireLocalStoreLock,
  ownsLocalStoreLock,
  releaseLocalStoreLock,
} from '../src/core/fleet/local-store-lock.js';
import { createOuterAttemptIdentity } from '../src/core/fleet/attempt-identity.js';
import { runBestOfN } from '../src/core/run/best-of-n.js';
import { runGoal } from '../src/core/run/orchestrator.js';
import { runSwarm } from '../src/core/swarm/runner.js';
import {
  acquireExecutionAuthority,
  beginExecutionAuthority,
  executionAuthorityStatePath,
  finishExecutionAuthority,
} from '../src/core/util/execution-lease.js';

const CHILD_TIMEOUT_MS = 12_000;
const CHILD_SOURCE = String.raw`
  import {
    acquireExecutionAuthority,
    beginExecutionAuthority,
  } from './src/core/util/execution-lease.ts';

  const acquired = acquireExecutionAuthority(
    process.env.LEASE_NAMESPACE,
    process.env.LEASE_ID,
    Number(process.env.LEASE_WAIT_MS ?? 0),
  );
  const began = acquired.ok && process.env.LEASE_BEGIN === '1'
    ? beginExecutionAuthority(acquired.authority)
    : false;
  if (!process.send) throw new Error('IPC unavailable');
  process.send({ ok: acquired.ok, reason: acquired.ok ? undefined : acquired.reason, began });
  if (!acquired.ok || (process.env.LEASE_BEGIN === '1' && !began)) {
    process.disconnect();
  } else {
    setInterval(() => {}, 1_000);
  }
`;

let tmpHome: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousAshlrHome: string | undefined;
const children = new Set<ChildProcess>();

function config(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['ollama'],
    },
    telemetry: {},
    tools: {},
  };
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

function spawnAuthorityHolder(id: string, begin: boolean, waitMs = 0): {
  child: ChildProcess;
  ready: Promise<{ ok: boolean; reason?: string; began: boolean }>;
} {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', CHILD_SOURCE],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        ASHLR_HOME: path.join(tmpHome, '.ashlr'),
        LEASE_NAMESPACE: 'run',
        LEASE_ID: id,
        LEASE_BEGIN: begin ? '1' : '0',
        LEASE_WAIT_MS: String(waitMs),
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  children.add(child);
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  const ready = new Promise<{ ok: boolean; reason?: string; began: boolean }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Authority holder did not report readiness: ${stderr}`));
    }, CHILD_TIMEOUT_MS);
    child.once('message', (message: { ok?: unknown; reason?: unknown; began?: unknown }) => {
      clearTimeout(timer);
      resolve({
        ok: message.ok === true,
        ...(typeof message.reason === 'string' ? { reason: message.reason } : {}),
        began: message.began === true,
      });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  child.once('exit', () => children.delete(child));
  return { child, ready };
}

async function killHolder(child: ChildProcess): Promise<void> {
  const exited = waitForExit(child);
  child.kill();
  await exited;
}

beforeEach(() => {
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousAshlrHome = process.env.ASHLR_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m391-execution-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.ASHLR_HOME = path.join(tmpHome, '.ashlr');
  delete process.env.ASHLR_IN_SWARM;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  const active = [...children];
  for (const child of active) child.kill();
  await Promise.all(active.map(waitForExit));
  children.clear();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  delete process.env.ASHLR_IN_SWARM;
});

describe('pre-execution lifecycle authority', () => {
  it('case-folds identities and namespaces run and swarm authority separately', () => {
    expect(executionAuthorityStatePath('run', 'Case-Run'))
      .toBe(executionAuthorityStatePath('run', 'case-run'));
    expect(executionAuthorityStatePath('run', 'case-run'))
      .not.toBe(executionAuthorityStatePath('swarm', 'case-run'));
  });

  it('blocks contenders while a claimed owner lives and recovers after pre-execution death', async () => {
    const holder = spawnAuthorityHolder('crash-before-execution', false);
    expect(await holder.ready).toEqual({ ok: true, began: false });
    expect(acquireExecutionAuthority('run', 'crash-before-execution', 20))
      .toEqual({ ok: false, reason: 'active' });
    await killHolder(holder.child);

    const recovered = acquireExecutionAuthority('run', 'crash-before-execution', 2_000);
    expect(recovered.ok).toBe(true);
    if (recovered.ok) finishExecutionAuthority(recovered.authority);
  }, 30_000);

  it('elects exactly one reclaimer when independent processes race a dead owner', async () => {
    const id = 'dead-owner-reclaimer-election';
    const dead = spawnAuthorityHolder(id, false);
    expect(await dead.ready).toEqual({ ok: true, began: false });
    await killHolder(dead.child);

    const contenders = [
      spawnAuthorityHolder(id, false, 2_000),
      spawnAuthorityHolder(id, false, 2_000),
    ];
    const results = await Promise.all(contenders.map((contender) => contender.ready));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => result.reason === 'active')).toHaveLength(1);
    const winner = contenders[results.findIndex((result) => result.ok)]!;
    await killHolder(winner.child);
  }, 30_000);

  it('fails closed after an executing owner dies because external effects are ambiguous', async () => {
    const holder = spawnAuthorityHolder('crash-after-execution', true);
    expect(await holder.ready).toEqual({ ok: true, began: true });
    await killHolder(holder.child);

    expect(acquireExecutionAuthority('run', 'crash-after-execution', 2_000))
      .toEqual({ ok: false, reason: 'ambiguous' });
    expect(fs.existsSync(executionAuthorityStatePath('run', 'crash-after-execution'))).toBe(true);
  }, 30_000);

  it('removes a completed marker and permits a clean successor', () => {
    const id = 'clean-handoff';
    const first = acquireExecutionAuthority('run', id, 0);
    expect(first.ok).toBe(true);
    expect(first.ok && beginExecutionAuthority(first.authority)).toBe(true);
    if (first.ok) finishExecutionAuthority(first.authority);
    expect(fs.existsSync(executionAuthorityStatePath('run', id))).toBe(false);

    const second = acquireExecutionAuthority('run', id, 0);
    expect(second.ok).toBe(true);
    if (second.ok) finishExecutionAuthority(second.authority);
  });

  it('hands a claimed background authority to a waiting worker before execution begins', async () => {
    const id = 'background-claimed-handoff';
    const launcher = acquireExecutionAuthority('run', id, 0);
    expect(launcher.ok).toBe(true);
    const worker = spawnAuthorityHolder(id, true, 2_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (launcher.ok) finishExecutionAuthority(launcher.authority);

    expect(await worker.ready).toEqual({ ok: true, began: true });
    await killHolder(worker.child);
    expect(acquireExecutionAuthority('run', id, 2_000))
      .toEqual({ ok: false, reason: 'ambiguous' });
  }, 30_000);

  it('does not reclaim a legacy lock owned by a live process', () => {
    const lockPath = path.join(tmpHome, '.ashlr', 'legacy-live.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, token: 'legacy-owner' })}\n`, {
      mode: 0o600,
    });
    const old = new Date(Date.now() - 5_000);
    fs.utimesSync(lockPath, old, old);

    expect(acquireLocalStoreLock(lockPath, 20)).toBeNull();
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toMatchObject({ token: 'legacy-owner' });
  });

  it('probes exact local lock ownership before lifecycle transitions', () => {
    const lockPath = path.join(tmpHome, '.ashlr', 'ownership.lock');
    const lock = acquireLocalStoreLock(lockPath, 0);
    expect(lock).not.toBeNull();
    expect(ownsLocalStoreLock(lock)).toBe(true);
    expect(ownsLocalStoreLock(lock && { ...lock, token: 'not-the-owner' })).toBe(false);
    releaseLocalStoreLock(lock);
    expect(ownsLocalStoreLock(lock)).toBe(false);
  });

  it('refuses a run before provider resolution when another owner is executing', async () => {
    const id = 'm391-overlapping-run';
    const owner = acquireExecutionAuthority('run', id, 0);
    expect(owner.ok).toBe(true);
    expect(owner.ok && beginExecutionAuthority(owner.authority)).toBe(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(runGoal('must not execute', config(), { runId: id, engine: 'builtin' }))
        .rejects.toThrow(/execution authority active/i);
    } finally {
      if (owner.ok) finishExecutionAuthority(owner.authority);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpHome, '.ashlr', 'runs', `${id}.json`))).toBe(false);
  });

  it('returns a non-persisted swarm refusal before planning or task execution', async () => {
    const id = 'm391-overlapping-swarm';
    const owner = acquireExecutionAuthority('swarm', id, 0);
    expect(owner.ok).toBe(true);
    expect(owner.ok && beginExecutionAuthority(owner.authority)).toBe(true);
    let result;
    try {
      result = await runSwarm({ goal: 'must not execute' }, config(), { runId: id }, () => {});
    } finally {
      if (owner.ok) finishExecutionAuthority(owner.authority);
    }
    expect(result).toMatchObject({
      id,
      status: 'failed',
      result: expect.stringMatching(/execution authority active/i),
    });
    expect(fs.existsSync(path.join(tmpHome, '.ashlr', 'swarms', `${id}.json`))).toBe(false);
  });

  it('fails closed before planning when swarm persistence preparation is unavailable', async () => {
    fs.mkdirSync(path.join(tmpHome, '.ashlr'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(tmpHome, '.ashlr', 'swarms'), 'not a directory', { mode: 0o600 });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await runSwarm(
      { goal: 'must not plan' },
      config(),
      { runId: 'm391-unavailable-swarm-store' },
      () => {},
    );

    expect(result).toMatchObject({
      status: 'failed',
      result: expect.stringMatching(/persistence preparation is unavailable/i),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an overlapping Best-of-N outer attempt before candidate execution', async () => {
    const attemptId = createOuterAttemptIdentity();
    const owner = acquireExecutionAuthority('run', attemptId, 0);
    expect(owner.ok).toBe(true);
    expect(owner.ok && beginExecutionAuthority(owner.authority)).toBe(true);
    let result;
    try {
      result = await runBestOfN({
        id: 'm391-item',
        repo: '/tmp/m391-repo',
        source: 'manual',
        title: 'must not execute',
        detail: 'must not execute',
        value: 3,
        effort: 2,
        score: 3,
        tags: [],
        ts: new Date().toISOString(),
      }, config(), { attemptId, n: 3 });
    } finally {
      if (owner.ok) finishExecutionAuthority(owner.authority);
    }
    expect(result).toMatchObject({
      winner: undefined,
      candidates: [],
      critique: {
        n: 3,
        nonEmpty: 0,
        noProposalReasons: [{ reason: 'execution authority active', count: 1 }],
      },
    });
  });

  it('retains ambiguity when a swarm checkpoint fails after task execution', async () => {
    const actualStore = await vi.importActual<typeof import('../src/core/swarm/store.js')>(
      '../src/core/swarm/store.js',
    );
    let taskExecuted = false;
    const runGoalMock = vi.fn(async (goal: string) => {
      taskExecuted = true;
      const now = new Date().toISOString();
      return {
        id: `run-${randomUUID()}`,
        goal,
        engine: 'builtin' as const,
        provider: 'ollama',
        createdAt: now,
        updatedAt: now,
        budget: { maxTokens: 1_000, maxSteps: 10, allowCloud: false },
        usage: { tokensIn: 10, tokensOut: 5, steps: 1, estCostUsd: 0 },
        tasks: [],
        steps: [],
        status: 'done' as const,
        result: 'observable task effect',
      };
    });
    vi.doMock('../src/core/run/orchestrator.js', () => ({ runGoal: runGoalMock }));
    vi.doMock('../src/core/swarm/planner.js', () => ({
      planSwarm: vi.fn(async (goal: string) => ({
        specId: null,
        goal,
        tasks: [{ id: 'build-1', phase: 'build', goal: 'execute once', deps: [] }],
      })),
    }));
    vi.doMock('../src/core/swarm/store.js', () => ({
      ...actualStore,
      saveSwarm: vi.fn((run: import('../src/core/types.js').SwarmRun) => taskExecuted
        ? ({ ok: false, reason: 'unavailable' } as const)
        : actualStore.saveSwarm(run)),
    }));

    const isolated = await import('../src/core/swarm/runner.js?m391=' + randomUUID());
    const id = `swarm-m391-${randomUUID()}`;
    try {
      const result = await isolated.runSwarm(
        { goal: 'checkpoint ambiguity' },
        config(),
        { runId: id, noCapture: true },
        () => {},
      );
      expect(runGoalMock).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        id,
        status: 'failed',
        result: expect.stringMatching(/persistence unavailable/i),
      });
      expect(acquireExecutionAuthority('swarm', id, 2_000))
        .toEqual({ ok: false, reason: 'ambiguous' });
    } finally {
      vi.doUnmock('../src/core/run/orchestrator.js');
      vi.doUnmock('../src/core/swarm/planner.js');
      vi.doUnmock('../src/core/swarm/store.js');
      vi.resetModules();
    }
  });
});
