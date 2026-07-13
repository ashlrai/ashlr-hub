import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunState, SwarmRun } from '../src/core/types.js';
import { loadRun, saveRun } from '../src/core/run/orchestrator.js';
import { loadSwarm, saveSwarm } from '../src/core/swarm/store.js';

type Store = 'run' | 'swarm';
type WriterMode = 'fresh' | 'loaded';

type WriterOutcome =
  | { ok: true; revision?: number }
  | { ok: false; reason?: string; error?: string };

interface WriterMessage {
  type: 'ready' | 'result' | 'fatal';
  outcome?: WriterOutcome;
  error?: string;
}

interface WriterHandle {
  child: ChildProcess;
  ready: Promise<void>;
  result: Promise<WriterOutcome>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  go(): void;
}

const CHILD_TIMEOUT_MS = 12_000;
const CHILD_SOURCE = String.raw`
  import { loadRun, saveRun } from './src/core/run/orchestrator.ts';
  import { loadSwarm, saveSwarm } from './src/core/swarm/store.ts';

  const store = process.env.CAS_STORE;
  const mode = process.env.CAS_MODE;
  const id = process.env.CAS_ID;
  const writer = process.env.CAS_WRITER;
  const timeoutMs = Number(process.env.CAS_CHILD_TIMEOUT_MS);

  function makeRun() {
    const now = '2026-07-13T13:00:00.000Z';
    return {
      id,
      goal: 'Cross-process run generation CAS',
      engine: 'builtin',
      provider: 'ollama',
      createdAt: now,
      updatedAt: now,
      budget: { maxTokens: 1_000, maxSteps: 10, allowCloud: false },
      usage: { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 },
      tasks: [],
      steps: [],
      status: 'running',
    };
  }

  function makeSwarm() {
    const goal = 'Cross-process swarm generation CAS';
    return {
      id,
      goal,
      specId: null,
      project: null,
      createdAt: '2026-07-13T13:00:00.000Z',
      updatedAt: '2026-07-13T13:00:00.000Z',
      budget: { maxTokens: 1_000, maxSteps: 10, allowCloud: false },
      usage: { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 },
      parallel: 1,
      status: 'running',
      plan: { specId: null, goal, tasks: [] },
      tasks: [],
    };
  }

  function send(message) {
    return new Promise((resolve, reject) => {
      if (!process.send) return reject(new Error('IPC channel unavailable'));
      process.send(message, (error) => error ? reject(error) : resolve());
    });
  }

  function waitForGo() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for go barrier')), timeoutMs);
      process.once('message', (message) => {
        clearTimeout(timer);
        if (message !== 'go') return reject(new Error('Unexpected parent message'));
        resolve();
      });
    });
  }

  async function main() {
    if (!id || !writer || !Number.isFinite(timeoutMs)) throw new Error('Missing child configuration');
    let state;
    if (store === 'run') {
      state = mode === 'loaded' ? loadRun(id) : makeRun();
    } else if (store === 'swarm') {
      state = mode === 'loaded' ? loadSwarm(id) : makeSwarm();
    } else {
      throw new Error('Unknown persistence store');
    }
    if (!state) throw new Error('Failed to load persistence generation');

    await send({ type: 'ready' });
    await waitForGo();
    state.status = 'done';
    state.result = writer;
    state.updatedAt = writer === 'first-terminal'
      ? '2026-07-13T14:00:00.000Z'
      : '2026-07-13T15:00:00.000Z';

    let outcome;
    if (store === 'swarm') {
      outcome = saveSwarm(state);
    } else {
      try {
        saveRun(state);
        outcome = { ok: true };
      } catch (error) {
        outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    await send({ type: 'result', outcome });
    process.disconnect();
  }

  main().catch(async (error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    try { await send({ type: 'fatal', error: message }); } catch {}
    process.stderr.write(message + '\n');
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
`;

let tmpHome: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousAshlrHome: string | undefined;
const activeChildren = new Set<ChildProcess>();

function makeRun(id: string): RunState {
  const now = '2026-07-13T13:00:00.000Z';
  return {
    id,
    goal: 'Cross-process run generation CAS',
    engine: 'builtin',
    provider: 'ollama',
    createdAt: now,
    updatedAt: now,
    budget: { maxTokens: 1_000, maxSteps: 10, allowCloud: false },
    usage: { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 },
    tasks: [],
    steps: [],
    status: 'running',
  };
}

function makeSwarm(id: string): SwarmRun {
  const goal = 'Cross-process swarm generation CAS';
  return {
    id,
    goal,
    specId: null,
    project: null,
    createdAt: '2026-07-13T13:00:00.000Z',
    updatedAt: '2026-07-13T13:00:00.000Z',
    budget: { maxTokens: 1_000, maxSteps: 10, allowCloud: false },
    usage: { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 },
    parallel: 1,
    status: 'running',
    plan: { specId: null, goal, tasks: [] },
    tasks: [],
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function spawnWriter(store: Store, mode: WriterMode, id: string, writer: string): WriterHandle {
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
        CAS_STORE: store,
        CAS_MODE: mode,
        CAS_ID: id,
        CAS_WRITER: writer,
        CAS_CHILD_TIMEOUT_MS: String(CHILD_TIMEOUT_MS),
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  activeChildren.add(child);

  const ready = deferred<void>();
  const result = deferred<WriterOutcome>();
  let stderr = '';
  let resultReceived = false;
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const readyTimer = setTimeout(() => {
    child.kill();
    ready.reject(new Error(`Child did not reach ready barrier: ${stderr}`));
  }, CHILD_TIMEOUT_MS);
  const lifetimeTimer = setTimeout(() => {
    child.kill();
    result.reject(new Error(`Child did not report a result: ${stderr}`));
  }, CHILD_TIMEOUT_MS * 2);

  child.on('message', (message: WriterMessage) => {
    if (message.type === 'ready') {
      clearTimeout(readyTimer);
      ready.resolve();
    } else if (message.type === 'result' && message.outcome) {
      resultReceived = true;
      result.resolve(message.outcome);
    } else if (message.type === 'fatal') {
      const error = new Error(`Child writer failed: ${message.error ?? stderr}`);
      clearTimeout(readyTimer);
      clearTimeout(lifetimeTimer);
      ready.reject(error);
      result.reject(error);
    }
  });

  child.on('error', (error) => {
    clearTimeout(readyTimer);
    clearTimeout(lifetimeTimer);
    ready.reject(error);
    result.reject(error);
  });

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => {
      activeChildren.delete(child);
      clearTimeout(readyTimer);
      clearTimeout(lifetimeTimer);
      if (!resultReceived) {
        const error = new Error(`Child exited before reporting a result (${code ?? signal}): ${stderr}`);
        ready.reject(error);
        result.reject(error);
      }
      resolve({ code, signal });
    });
  });

  return {
    child,
    ready: ready.promise,
    result: result.promise,
    exit,
    go(): void {
      child.send('go');
    },
  };
}

async function finish(handle: WriterHandle): Promise<WriterOutcome> {
  const outcome = await handle.result;
  const exited = await handle.exit;
  expect(exited).toEqual({ code: 0, signal: null });
  return outcome;
}

function persistenceRevision(file: string): number {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const marker = parsed['_ashlrPersistence'] as Record<string, unknown>;
  return Number(marker['revision']);
}

function prepareStoreDir(store: Store): void {
  fs.mkdirSync(path.join(tmpHome, '.ashlr', store === 'run' ? 'runs' : 'swarms'), {
    recursive: true,
    mode: 0o700,
  });
}

beforeEach(() => {
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousAshlrHome = process.env.ASHLR_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m389-cas-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.ASHLR_HOME = path.join(tmpHome, '.ashlr');
});

afterEach(() => {
  for (const child of activeChildren) child.kill();
  activeChildren.clear();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
});

describe('cross-process persistence generation CAS', () => {
  it('allows exactly one fresh saveRun writer for the same id', async () => {
    const id = 'm389-fresh-run';
    prepareStoreDir('run');
    const writers = [
      spawnWriter('run', 'fresh', id, 'fresh-run-a'),
      spawnWriter('run', 'fresh', id, 'fresh-run-b'),
    ];
    await Promise.all(writers.map((writer) => writer.ready));
    writers.forEach((writer) => writer.go());

    const outcomes = await Promise.all(writers.map(finish));
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    const rejected = outcomes.find((outcome) => !outcome.ok);
    expect(rejected).toMatchObject({ ok: false });
    expect(rejected && 'error' in rejected ? rejected.error : '').toMatch(/Stale run persistence generation/);

    expect(loadRun(id)).toMatchObject({
      id,
      status: 'done',
      result: expect.stringMatching(/^fresh-run-[ab]$/),
    });
    expect(persistenceRevision(path.join(tmpHome, '.ashlr', 'runs', `${id}.json`))).toBe(1);
  }, 30_000);

  it('lets the first barriered terminal saveRun commit win over a stale loader', async () => {
    const id = 'm389-loaded-run';
    saveRun(makeRun(id));
    const first = spawnWriter('run', 'loaded', id, 'first-terminal');
    const stale = spawnWriter('run', 'loaded', id, 'stale-terminal');
    await Promise.all([first.ready, stale.ready]);

    first.go();
    expect(await finish(first)).toEqual({ ok: true });
    stale.go();
    const staleOutcome = await finish(stale);
    expect(staleOutcome).toMatchObject({ ok: false });
    expect(staleOutcome && 'error' in staleOutcome ? staleOutcome.error : '')
      .toMatch(/Stale run persistence generation/);

    expect(loadRun(id)).toMatchObject({ status: 'done', result: 'first-terminal' });
    expect(persistenceRevision(path.join(tmpHome, '.ashlr', 'runs', `${id}.json`))).toBe(2);
  }, 30_000);

  it('returns discriminated saveSwarm results for two fresh same-id writers', async () => {
    const id = 'm389-fresh-swarm';
    prepareStoreDir('swarm');
    const writers = [
      spawnWriter('swarm', 'fresh', id, 'fresh-swarm-a'),
      spawnWriter('swarm', 'fresh', id, 'fresh-swarm-b'),
    ];
    await Promise.all(writers.map((writer) => writer.ready));
    writers.forEach((writer) => writer.go());

    const outcomes = await Promise.all(writers.map(finish));
    expect(outcomes).toContainEqual({ ok: true, revision: 1 });
    expect(outcomes).toContainEqual({ ok: false, reason: 'conflict' });
    expect(loadSwarm(id)).toMatchObject({
      id,
      status: 'done',
      result: expect.stringMatching(/^fresh-swarm-[ab]$/),
    });
    expect(persistenceRevision(path.join(tmpHome, '.ashlr', 'swarms', `${id}.json`))).toBe(1);
  }, 30_000);

  it('returns a conflict when a barriered saveSwarm loader loses the generation', async () => {
    const id = 'm389-loaded-swarm';
    expect(saveSwarm(makeSwarm(id))).toEqual({ ok: true, revision: 1 });
    const first = spawnWriter('swarm', 'loaded', id, 'first-terminal');
    const stale = spawnWriter('swarm', 'loaded', id, 'stale-terminal');
    await Promise.all([first.ready, stale.ready]);

    first.go();
    expect(await finish(first)).toEqual({ ok: true, revision: 2 });
    stale.go();
    expect(await finish(stale)).toEqual({ ok: false, reason: 'conflict' });

    expect(loadSwarm(id)).toMatchObject({ status: 'done', result: 'first-terminal' });
    expect(persistenceRevision(path.join(tmpHome, '.ashlr', 'swarms', `${id}.json`))).toBe(2);
  }, 30_000);
});
