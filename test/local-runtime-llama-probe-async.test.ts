/**
 * V3.10 — `probeLlamaRuntime` must never block the event loop.
 *
 * The probe runs inside request handlers (bootstrap, seats, the dispatcher).
 * Its ownership check used the SYNC process helpers, each an `execFileSync`
 * of `ps` — a zombie check, an argv read and a full `ps -axww` table scan —
 * which blew the 20 ms handler budget on every poll. This suite pins that the
 * probe only ever reaches the `…Async` twins (the sync ones are rigged to
 * throw), and that the ownership and re-adoption rules are unchanged by the
 * move.
 *
 * HOME-isolated: the probe also stats the kill switch and the launch-agent
 * plist, which resolve under HOME. No real process table is read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const asyncSpies = vi.hoisted(() => ({
  alive: vi.fn<(pid: number) => Promise<boolean>>(),
  argv: vi.fn<(pid: number) => Promise<string | null>>(),
  onPort: vi.fn<(port: number) => Promise<Array<{ pid: number; argv: string; binPath: string; modelPath: string | null }>>>(),
}));

vi.mock('../src/core/local-runtime/llama/process.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/local-runtime/llama/process.js')>();
  const blocked = (name: string) => () => {
    throw new Error(`${name} is synchronous and must not run on the probe path`);
  };
  return {
    ...real,
    processAlive: vi.fn(blocked('processAlive')),
    processArgv: vi.fn(blocked('processArgv')),
    findLlamaServersOnPort: vi.fn(blocked('findLlamaServersOnPort')),
    processAliveAsync: asyncSpies.alive,
    processArgvAsync: asyncSpies.argv,
    findLlamaServersOnPortAsync: asyncSpies.onPort,
  };
});

import { probeLlamaRuntime, type FetchLike } from '../src/core/local-runtime/llama/health.js';
import * as processModule from '../src/core/local-runtime/llama/process.js';
import type { LlamaOwnershipRecord } from '../src/core/local-runtime/llama/types.js';

const BIN = '/opt/homebrew/bin/llama-server';
const MODEL = '/Users/x/.ollama/models/blobs/sha256-2bb2';

function sampleRecord(over: Partial<LlamaOwnershipRecord> = {}): LlamaOwnershipRecord {
  return {
    schemaVersion: 1,
    pid: 4242,
    port: 8080,
    host: '127.0.0.1',
    binPath: BIN,
    modelPath: MODEL,
    modelRef: 'qwen3.8:27b-ctx64k',
    args: ['-m', MODEL, '--port', '8080'],
    requestedSlots: 4,
    requestedContext: 65_536,
    startedAt: '2026-09-21T01:07:00.000Z',
    owner: 'cli',
    ...over,
  };
}

const serving: FetchLike = async (url) => {
  if (url.endsWith('/health')) return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
  if (url.endsWith('/props')) {
    return { ok: true, status: 200, json: async () => ({ total_slots: 4, model_path: MODEL }) };
  }
  return { ok: true, status: 200, json: async () => [{ is_processing: false }] };
};

const server = (pid: number, binPath = BIN) =>
  ({ pid, binPath, modelPath: MODEL, argv: `${binPath} -m ${MODEL} --port 8080` });

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-llama-probe-home-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  asyncSpies.alive.mockReset();
  asyncSpies.argv.mockReset();
  asyncSpies.onPort.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  // Whatever the case did, the sync twins must never have been reached.
  expect(processModule.processAlive).not.toHaveBeenCalled();
  expect(processModule.processArgv).not.toHaveBeenCalled();
  expect(processModule.findLlamaServersOnPort).not.toHaveBeenCalled();
});

const probe = (record: LlamaOwnershipRecord | null) =>
  probeLlamaRuntime({ origin: 'http://127.0.0.1:8080', fetchImpl: serving, record });

describe('probeLlamaRuntime — ownership check off the event loop', () => {
  it('verifies the recorded pid with the async liveness + argv reads', async () => {
    asyncSpies.alive.mockResolvedValue(true);
    asyncSpies.argv.mockResolvedValue(`${BIN} -m ${MODEL} --port 8080`);

    const snapshot = await probe(sampleRecord());

    expect(asyncSpies.alive).toHaveBeenCalledWith(4242);
    expect(asyncSpies.argv).toHaveBeenCalledWith(4242);
    // Proven by the recorded pid: no table scan needed.
    expect(asyncSpies.onPort).not.toHaveBeenCalled();
    expect(snapshot.managed).toBe(true);
    expect(snapshot.pid).toBe(4242);
    expect(snapshot.owner).toBe('cli');
  });

  it('re-adopts exactly one live llama-server on the port after a launchd restart', async () => {
    // The recorded pid is gone; the port holds the restarted job (pid 5151)
    // plus a dead leftover from the same binary (5150) and a foreign binary.
    asyncSpies.alive.mockImplementation(async (pid) => pid === 5151);
    asyncSpies.onPort.mockResolvedValue([server(5150), server(5151), server(6000, '/usr/local/bin/llama-server')]);

    const snapshot = await probe(sampleRecord());

    expect(asyncSpies.onPort).toHaveBeenCalledWith(8080);
    expect(asyncSpies.argv).not.toHaveBeenCalled();
    // The foreign binary is filtered BEFORE its liveness is read.
    expect(asyncSpies.alive.mock.calls.map(([pid]) => pid).sort()).toEqual([4242, 5150, 5151]);
    expect(snapshot.managed).toBe(true);
    expect(snapshot.pid).toBe(5151);
    expect(snapshot.owner).toBe('launchd');
  });

  it('leaves an ambiguous port unmanaged', async () => {
    asyncSpies.alive.mockImplementation(async (pid) => pid !== 4242);
    asyncSpies.onPort.mockResolvedValue([server(5151), server(5152)]);

    const snapshot = await probe(sampleRecord());

    expect(snapshot.managed).toBe(false);
    expect(snapshot.pid).toBeNull();
  });

  it('a live pid whose argv no longer matches falls through to re-adoption', async () => {
    asyncSpies.alive.mockResolvedValue(true);
    asyncSpies.argv.mockResolvedValue('/usr/bin/some-other-daemon --port 8080');
    asyncSpies.onPort.mockResolvedValue([]);

    const snapshot = await probe(sampleRecord());

    expect(asyncSpies.onPort).toHaveBeenCalledWith(8080);
    expect(snapshot.managed).toBe(false);
  });

  it('skips the process table entirely when there is no record', async () => {
    const snapshot = await probe(null);
    expect(asyncSpies.alive).not.toHaveBeenCalled();
    expect(asyncSpies.onPort).not.toHaveBeenCalled();
    expect(snapshot.managed).toBe(false);
  });

  it('yields to the event loop while the process reads are pending', async () => {
    // A slow `ps` must not hold the loop: a timer scheduled during the probe
    // fires BEFORE the probe settles.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    asyncSpies.alive.mockImplementation(async () => { await gate; return true; });
    asyncSpies.argv.mockResolvedValue(`${BIN} -m ${MODEL} --port 8080`);

    const order: string[] = [];
    const pending = probe(sampleRecord()).then((s) => { order.push('probe'); return s; });
    await new Promise<void>((resolve) => setTimeout(() => { order.push('timer'); resolve(); }, 5));
    release();
    const snapshot = await pending;

    expect(order).toEqual(['timer', 'probe']);
    expect(snapshot.managed).toBe(true);
  });
});
