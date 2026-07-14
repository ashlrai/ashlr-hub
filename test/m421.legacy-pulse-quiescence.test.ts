import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig, DaemonTick } from '../src/core/types.js';
import {
  drainDaemonTickEffects,
  runLegacyPulseExport,
  trackDaemonTickEffect,
} from '../src/core/daemon/loop.js';
import {
  acquireDaemonLock,
  loadDaemonState,
  releaseDaemonLock,
  saveDaemonState,
  type DaemonLock,
} from '../src/core/daemon/state.js';
import { exportToPulse } from '../src/core/fleet/pulse-export.js';
import { setKill } from '../src/core/sandbox/policy.js';

const cfg = {
  pulse: { enabled: true, endpoint: 'http://pulse.m421.invalid' },
} as AshlrConfig;

let home: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let daemonLock: DaemonLock | undefined;

beforeEach(() => {
  home = join(tmpdir(), `ashlr-m421-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ASHLR_PULSE_PAT = 'm421-test-pat';
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (daemonLock) releaseDaemonLock(daemonLock);
  daemonLock = undefined;
  delete process.env.ASHLR_PULSE_PAT;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  rmSync(home, { recursive: true, force: true });
});

describe('M421 legacy Pulse quiescence', () => {
  it('drains unresolved tick effects to a fixed point before reporting settlement', async () => {
    const tick: DaemonTick = {
      ts: '2026-07-14T11:58:00.000Z',
      itemsConsidered: 0,
      proposalsCreated: 0,
      spentUsd: 0,
      reason: 'ok',
    };
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    trackDaemonTickEffect(tick, first.promise);

    let drained = false;
    const draining = drainDaemonTickEffects(tick).then(() => { drained = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);

    trackDaemonTickEffect(tick, second.promise);
    first.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);

    second.resolve();
    await draining;
    expect(drained).toBe(true);
  });

  it('keeps KILL non-quiesced while the legacy POST is held', async () => {
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    vi.stubGlobal('fetch', vi.fn(() => {
      started.resolve();
      return response.promise;
    }));

    const exporting = exportToPulse(cfg);
    await started.promise;

    const waitStartedAt = performance.now();
    const whileHeld = setKill(true, { waitMs: 60 });
    const waitedMs = performance.now() - waitStartedAt;

    expect(whileHeld).toMatchObject({ ok: false, quiesced: false });
    expect(waitedMs).toBeGreaterThanOrEqual(40);

    response.resolve(new Response('{}', { status: 200 }));
    await expect(exporting).resolves.toBe(true);
    expect(setKill(true, { waitMs: 500 })).toMatchObject({ ok: true, quiesced: true });
  });

  it('does not write the legacy watermark after daemon abort', async () => {
    const acquired = acquireDaemonLock();
    expect(acquired.acquired).toBe(true);
    if (!acquired.acquired) return;
    daemonLock = acquired.lock;

    const tick: DaemonTick = {
      ts: '2026-07-14T12:00:00.000Z',
      itemsConsidered: 1,
      proposalsCreated: 0,
      spentUsd: 0,
      reason: 'ok',
    };
    const startedAt = '2026-07-14T11:59:00.000Z';
    saveDaemonState({
      running: true,
      pid: process.pid,
      startedAt,
      lastTickAt: tick.ts,
      todayDate: '2026-07-14',
      todaySpentUsd: 0,
      itemsProcessed: 1,
      ticks: [tick],
    });

    const requestStarted = Promise.withResolvers<AbortSignal>();
    let observedReason: unknown;
    vi.stubGlobal('fetch', vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) throw new Error('legacy Pulse POST did not receive an abort signal');
      requestStarted.resolve(signal);
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = (): void => {
          observedReason = signal.reason;
          reject(signal.reason);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    }));

    const controller = new AbortController();
    const exporting = runLegacyPulseExport(cfg, tick, {
      startedAt,
      signal: controller.signal,
      ownerLock: daemonLock,
    });
    const requestSignal = await requestStarted.promise;
    const reason = new Error('daemon shutdown requested');
    controller.abort(reason);
    await exporting;

    expect(requestSignal.reason).toBe(reason);
    expect(observedReason).toBe(reason);
    expect(loadDaemonState().lastPulseExportAt).toBeUndefined();
  });
});
