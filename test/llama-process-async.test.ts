/**
 * Async process-table reads for the llama-server runtime
 * (src/core/local-runtime/llama/process.ts).
 *
 * The runtime probe runs inside the web server, where a synchronous
 * `ps -axww` blocked the event loop 36–78 ms per refresh (3.10 budget: 20 ms).
 * The async variants must answer EXACTLY what the sync ones answer — they feed
 * the same pid-recycling guard — so most tests here compare the two directly.
 *
 * Reads only: the one spawned process is a harmless node timer started under
 * a symlink named `llama-server` in a temp directory, killed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findLlamaServersOnPort,
  findLlamaServersOnPortAsync,
  livenessFactsFor,
  livenessFactsForAsync,
  parseLlamaServersOnPort,
  processAlive,
  processAliveAsync,
  processArgv,
  processArgvAsync,
} from '../src/core/local-runtime/llama/process.js';
import type { LlamaOwnershipRecord } from '../src/core/local-runtime/llama/types.js';

const posix = process.platform !== 'win32';

describe('parseLlamaServersOnPort', () => {
  const table = [
    '    1 /sbin/launchd',
    '  812 /opt/homebrew/bin/llama-server -m /models/qwen.gguf --port 8080 --host 127.0.0.1',
    '  813 /opt/homebrew/bin/llama-server --model=/models/other.gguf --port=9090',
    '  900 grep llama-server --port 8080',
    '  901 /usr/bin/llama-server-wrapper --port 8080',
    '  902 /opt/homebrew/bin/llama-server -m /models/qwen.gguf --port 80800',
    'garbage line',
    '',
  ].join('\n');

  it('keeps only llama-server argv bound to exactly this port', () => {
    expect(parseLlamaServersOnPort(table, 8080)).toEqual([
      {
        pid: 812,
        argv: '/opt/homebrew/bin/llama-server -m /models/qwen.gguf --port 8080 --host 127.0.0.1',
        binPath: '/opt/homebrew/bin/llama-server',
        modelPath: '/models/qwen.gguf',
      },
    ]);
    expect(parseLlamaServersOnPort(table, 9090).map((s) => [s.pid, s.modelPath])).toEqual([
      [813, '/models/other.gguf'],
    ]);
  });

  it('an unreadable table yields no servers rather than a guess', () => {
    expect(parseLlamaServersOnPort(null, 8080)).toEqual([]);
  });
});

describe.skipIf(!posix)('async variants answer what the sync ones answer', () => {
  it('processAliveAsync / processArgvAsync for this very process', async () => {
    expect(await processAliveAsync(process.pid)).toBe(processAlive(process.pid));
    expect(await processAliveAsync(process.pid)).toBe(true);
    const argv = await processArgvAsync(process.pid);
    expect(argv).not.toBeNull();
    expect(argv).toBe(processArgv(process.pid));
  });

  it('rejects invalid pids without spawning anything', async () => {
    for (const pid of [0, 1, -5, 1.5, Number.NaN]) {
      expect(await processAliveAsync(pid)).toBe(false);
      expect(await processArgvAsync(pid)).toBeNull();
    }
  });

  it('livenessFactsForAsync keeps the recycling guard: a live pid with foreign argv never matches', async () => {
    const record: LlamaOwnershipRecord = {
      schemaVersion: 1,
      pid: process.pid,
      port: 8080,
      host: '127.0.0.1',
      binPath: '/opt/homebrew/bin/llama-server',
      modelPath: '/models/qwen.gguf',
      modelRef: null,
      args: [],
      requestedSlots: 1,
      requestedContext: 4096,
      startedAt: '2026-09-23T00:00:00.000Z',
      owner: 'cli',
    };
    const facts = await livenessFactsForAsync(record);
    expect(facts).toEqual(livenessFactsFor(record));
    expect(facts).toEqual({ processAlive: true, argvMatches: false });
  });
});

describe.skipIf(!posix)('findLlamaServersOnPortAsync against a real process table', () => {
  const port = 50_000 + Math.floor(Math.random() * 10_000);
  let dir = '';
  let child: ChildProcess | null = null;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ashlr-llama-proc-'));
    const fake = join(dir, 'llama-server');
    // argv[0] is what ownership checks read, so a node binary started through
    // a symlink named llama-server looks exactly like one in `ps -axww`.
    symlinkSync(process.execPath, fake);
    child = spawn(fake, ['-e', 'setTimeout(() => {}, 60_000)', '--', '--port', String(port), '-m', '/models/fake.gguf'], {
      stdio: 'ignore',
    });
    // Wait until ps can see it (exec has completed).
    for (let i = 0; i < 50; i += 1) {
      if (findLlamaServersOnPort(port).length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  afterAll(() => {
    child?.kill('SIGKILL');
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('finds the same servers as the sync scan', async () => {
    const sync = findLlamaServersOnPort(port);
    const async = await findLlamaServersOnPortAsync(port);
    expect(async).toEqual(sync);
    expect(async).toHaveLength(1);
    expect(async[0]).toMatchObject({
      pid: child?.pid,
      binPath: join(dir, 'llama-server'),
      modelPath: '/models/fake.gguf',
    });
  });

  it('does not hold the event loop while the scan runs', async () => {
    const started = performance.now();
    const pending = findLlamaServersOnPortAsync(port);
    const blockedMs = performance.now() - started;
    await pending;
    // The whole point: the synchronous part is just the spawn hand-off.
    expect(blockedMs).toBeLessThan(20);
  });

  it('a port nobody serves yields nothing', async () => {
    expect(await findLlamaServersOnPortAsync(port + 1)).toEqual([]);
  });
});
