import { afterEach, describe, it, expect, vi } from 'vitest';
import * as adoptionModule from '../src/core/verse/adoption-cache.js';
import { startServer } from '../src/core/web/server.js';
import { resetVerseEngine } from '../src/core/verse/verse-api.js';
import type { VerseEngineHandle } from '../src/core/verse/session-engine.js';
import type { AshlrConfig } from '../src/core/types.js';
import { adoptionCache, startOwnedAdoptionCollector } from '../src/core/verse/adoption-cache.js';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); resetVerseEngine(null); });
describe('listener-owned adoption scheduler', () => {
  it('actual listener shutdown closes the Verse engine before waiting for adoption drain', async () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('VITEST', ''); vi.stubEnv('ASHLR_ADOPTION_AUTO', '1');
    let started!: () => void, finishDrain!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const drain = new Promise<void>((resolve) => { finishDrain = resolve; });
    vi.spyOn(adoptionModule, 'startOwnedAdoptionCollector').mockImplementation(() => { started(); return async () => { await drain; }; });
    const engineClosed = vi.fn(); resetVerseEngine({ close: engineClosed } as unknown as VerseEngineHandle);
    const cfg = { version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [], models: {}, telemetry: {}, tools: {} } as AshlrConfig;
    const handle = await startServer(cfg, { port: 0, allowDispatch: false }, { readProjections: null });
    let closing: Promise<void> | null = null;
    try {
      await didStart;
      let completed = false; closing = handle.close().then(() => { completed = true; });
      expect(engineClosed).toHaveBeenCalledTimes(1); expect(completed).toBe(false);
      finishDrain(); await closing; expect(completed).toBe(true);
    } finally { finishDrain(); await (closing ?? handle.close()); }
  });

  it('shares one schedule across owners and only the final close aborts/drains cache flights', async () => {
    vi.useFakeTimers();
    const refresh = vi.spyOn(adoptionCache, 'refresh').mockResolvedValue();
    const reset = vi.spyOn(adoptionCache, 'reset').mockResolvedValue();
    const closeFirst = startOwnedAdoptionCollector(), closeSecond = startOwnedAdoptionCollector();
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000); expect(refresh).toHaveBeenCalledTimes(2);
    await closeFirst(); expect(reset).not.toHaveBeenCalled();
    await closeSecond(); expect(reset).toHaveBeenCalledTimes(1);
    await closeSecond(); expect(reset).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000); expect(refresh).toHaveBeenCalledTimes(2);
  });
});
