/**
 * The Verse runtime probe must never hold the event loop past the 20 ms
 * per-handler budget (CHANGELOG 3.10.0 recorded 53–78 ms per run).
 *
 * Two synchronous costs remained on the probe path after `ps` went async:
 *   - `statusLocalRuntime` resolved the FULL runtime config on every poll,
 *     which locates llama-server with an `execFileSync('which', …)` — a
 *     blocking fork+exec for a `binPath` the probe never reads;
 *   - the `ps -axww` table (up to 16 MB) was parsed in one synchronous block.
 *
 * Each test drives the real code with a fake heavy input — a synchronous
 * spawn that busy-waits 60 ms, or a ~16 MB process table — and measures the
 * longest synchronous slice the loop saw while the probe ran.
 *
 * HOME-isolated (test/setup/home.ts): the probe stats the kill switch, the
 * launch-agent plist and the ownership record under HOME. No real process is
 * spawned — both child_process entry points the probe could reach are faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** What the fake `ps` prints; set per test. */
const fakePs = vi.hoisted(() => ({ stdout: '' }));

/** A synchronous spawn that costs 60 ms of blocked loop — 3x the budget. */
const HEAVY_SYNC_MS = 60;

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const busy = (): void => {
    const until = performance.now() + HEAVY_SYNC_MS;
    while (performance.now() < until) { /* a slow sync spawn */ }
  };
  return {
    ...real,
    execFileSync: vi.fn(() => {
      busy();
      return '/usr/local/bin/llama-server\n';
    }),
    spawnSync: vi.fn(() => {
      busy();
      return { status: 0, stdout: '', stderr: '' };
    }),
    // The async `ps`: answers on a later tick, like the real one.
    execFile: vi.fn((_file: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) => {
      setImmediate(() => cb(null, fakePs.stdout));
      return {};
    }),
  };
});

import {
  PS_PARSE_SLICE_MS,
  parseLlamaServersOnPort,
  parseLlamaServersOnPortSliced,
} from '../src/core/local-runtime/llama/process.js';
import { statusLocalRuntime } from '../src/core/local-runtime/llama/supervisor.js';
import { probeLlamaRuntime, type FetchLike } from '../src/core/local-runtime/llama/health.js';
import {
  resolveLlamaRuntimeConfig,
  resolveLlamaRuntimeSettings,
} from '../src/core/local-runtime/llama/config.js';
import type { LlamaOwnershipRecord } from '../src/core/local-runtime/llama/types.js';

const BUDGET_MS = 20;
const BIN = '/opt/homebrew/bin/llama-server';

/**
 * Run `fn` and return the longest synchronous stretch the event loop saw.
 * A setImmediate chain ticks once per loop turn; the gap between two ticks is
 * the synchronous work that ran in between.
 */
async function maxSyncSlice(fn: () => Promise<unknown>): Promise<number> {
  let max = 0;
  let done = false;
  let last = performance.now();
  const tick = (): void => {
    const now = performance.now();
    max = Math.max(max, now - last);
    last = now;
    if (!done) setImmediate(tick);
  };
  setImmediate(tick);
  last = performance.now();
  await fn();
  done = true;
  max = Math.max(max, performance.now() - last);
  return max;
}

/** ~16 MB `ps -o pid=,args=` table: thousands of long-argv processes. */
function heavyProcessTable(port: number): string {
  const filler = ` --type=renderer ${'--enable-features=X'.repeat(20)}`;
  const lines: string[] = [];
  for (let pid = 2; pid < 40_000; pid++) {
    lines.push(`${String(pid).padStart(6)} /Applications/Some Helper.app/Contents/MacOS/helper${filler}`);
    if (pid === 20_000 || pid === 39_998) {
      lines.push(`${pid + 100_000} ${BIN} -m /models/q.gguf --port ${port} --host 127.0.0.1`);
    }
  }
  return lines.join('\n') + '\n';
}

const refused: FetchLike = async () => {
  throw new Error('ECONNREFUSED');
};

beforeEach(() => {
  fakePs.stdout = '';
});

describe('ps table parse (fake 16 MB table)', () => {
  const table = heavyProcessTable(8080);

  it('answers exactly what the synchronous parser answers', async () => {
    const sliced = await parseLlamaServersOnPortSliced(table, 8080);
    expect(sliced).toEqual(parseLlamaServersOnPort(table, 8080));
    expect(sliced.map((s) => s.pid)).toEqual([120_000, 139_998]);
  });

  it('agrees on edge shapes: null, empty, no trailing newline', async () => {
    expect(await parseLlamaServersOnPortSliced(null, 8080)).toEqual([]);
    expect(await parseLlamaServersOnPortSliced('', 8080)).toEqual([]);
    const oneLine = `812 ${BIN} --port 8080`;
    expect(await parseLlamaServersOnPortSliced(oneLine, 8080)).toEqual(parseLlamaServersOnPort(oneLine, 8080));
  });

  it(`never holds the loop longer than ${BUDGET_MS} ms`, async () => {
    const slice = await maxSyncSlice(() => parseLlamaServersOnPortSliced(table, 8080));
    expect(PS_PARSE_SLICE_MS).toBeLessThan(BUDGET_MS);
    expect(slice).toBeLessThan(BUDGET_MS);
  });
});

describe('the runtime probe path', () => {
  it('statusLocalRuntime never runs the synchronous binary lookup', async () => {
    const cp = await import('node:child_process');
    // Warm once (module init, fetch internals), then measure a steady-state
    // poll — the one the UI repeats every few seconds.
    await statusLocalRuntime({ runtime: { port: 1 } });
    const slice = await maxSyncSlice(() => statusLocalRuntime({ runtime: { port: 1 } }));
    expect(cp.execFileSync).not.toHaveBeenCalled();
    expect(cp.spawnSync).not.toHaveBeenCalled();
    expect(slice).toBeLessThan(BUDGET_MS);
  });

  it('still applies the loopback gate to an override on the spawn-free path', async () => {
    // effectiveEndpoint must re-gate exactly like effectiveRuntime: an override
    // object is an ordinary argument and must not carry a non-loopback bind
    // host past the resolver's rule, even on the read-only status path.
    const snapshot = await statusLocalRuntime({ runtime: { host: '0.0.0.0', port: 1 } });
    expect(snapshot.host).toBe('127.0.0.1');
    expect(snapshot.port).toBe(1);
  });

  it('the re-adoption scan over a heavy ps table stays inside the budget', async () => {
    fakePs.stdout = heavyProcessTable(8080);
    const record: LlamaOwnershipRecord = {
      schemaVersion: 1,
      // Beyond any real pid_max, so the liveness check says dead and the
      // probe falls through to the full-table re-adoption scan.
      pid: 2 ** 30,
      port: 8080,
      host: '127.0.0.1',
      binPath: BIN,
      modelPath: '/models/q.gguf',
      modelRef: 'q',
      args: [],
      requestedSlots: 1,
      requestedContext: 4096,
      startedAt: '2026-09-25T00:00:00.000Z',
      owner: 'cli',
    };
    const probe = (): ReturnType<typeof probeLlamaRuntime> =>
      probeLlamaRuntime({ origin: 'http://127.0.0.1:8080', record, fetchImpl: refused });
    const cp = await import('node:child_process');
    await probe();
    const slice = await maxSyncSlice(probe);
    // The scan really ran (the fake async `ps` was read), and in slices.
    expect(cp.execFile).toHaveBeenCalled();
    expect(slice).toBeLessThan(BUDGET_MS);
  });
});

describe('resolveLlamaRuntimeSettings', () => {
  it('resolves the endpoint with no spawn and no binPath', async () => {
    const cp = await import('node:child_process');
    const settings = resolveLlamaRuntimeSettings();
    expect(cp.execFileSync).not.toHaveBeenCalled();
    expect('binPath' in settings).toBe(false);
    expect(typeof settings.port).toBe('number');
  });

  it('is exactly the full config minus binPath (the full resolver is unchanged)', () => {
    // An operator's LLAMA_SERVER_BIN would bypass `which`; take it out of play.
    const savedBin = process.env['LLAMA_SERVER_BIN'];
    delete process.env['LLAMA_SERVER_BIN'];
    try {
      const { binPath, ...rest } = resolveLlamaRuntimeConfig();
      expect(rest).toEqual(resolveLlamaRuntimeSettings());
      // The full resolver still locates the binary (here via the faked `which`).
      expect(binPath).toBe('/usr/local/bin/llama-server');
    } finally {
      if (savedBin !== undefined) process.env['LLAMA_SERVER_BIN'] = savedBin;
    }
  });
});
