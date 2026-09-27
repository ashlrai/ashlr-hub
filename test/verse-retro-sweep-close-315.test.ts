/**
 * 3.15: the server's close() stops the background retro sweep `ashlr verse`
 * schedules (learn/retro/sweep-timer.ts), the way it closes the Fleet history
 * worker — so a closed server leaves no timer and no sweep writing behind it.
 *
 * Binds a real loopback server (real-io lane). The sweep itself is a fake and
 * never runs; HOME is isolated by test/setup/home.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AshlrConfig } from '../src/core/types.js';
import { startServer } from '../src/core/web/server.js';
import {
  retroSweepScheduled,
  scheduleRetroSweep,
  stopRetroSweepSchedule,
  type RetroSweepTimerDeps,
} from '../src/core/learn/retro/sweep-timer.js';

function config(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'vscode',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    telemetry: {},
    tools: {},
  };
}

afterEach(async () => { await stopRetroSweepSchedule(); });

describe('server close stops the retro sweep schedule', () => {
  it('a scheduled sweep is stopped by handle.close() and never runs afterwards', async () => {
    const sweep = vi.fn(async () => undefined);
    const timers: Array<{ fn: () => void; cleared: boolean }> = [];
    const deps: RetroSweepTimerDeps = {
      now: () => Date.now(),
      lastSweptAt: async () => null,
      inFlight: async () => false,
      sweep,
      // Manual timers: nothing fires on its own, so the test controls every tick.
      setTimer: (fn) => { const t = { fn, cleared: false, unref: () => t }; timers.push(t); return t; },
      clearTimer: (h) => { (h as unknown as { cleared: boolean }).cleared = true; },
    };

    const handle = await startServer(config(), { port: 0, open: false, allowDispatch: true }, { readProjections: null });
    const stop = scheduleRetroSweep(config(), { env: { ASHLR_RETRO_SWEEP_TIMER: '1' }, deps });
    expect(stop).toBeTypeOf('function');
    expect(retroSweepScheduled()).toBe(true);
    expect(timers).toHaveLength(1);

    await handle.close();

    expect(retroSweepScheduled()).toBe(false);
    expect(timers[0]!.cleared).toBe(true);
    expect(sweep).not.toHaveBeenCalled();
  });

  it('close() with no schedule is a no-op, and never starts one', async () => {
    const handle = await startServer(config(), { port: 0, open: false, allowDispatch: true }, { readProjections: null });
    await handle.close();
    expect(retroSweepScheduled()).toBe(false);
  });
});
