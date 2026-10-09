import { describe, expect, it } from 'vitest';
import { createHostCpuSampler } from '../src/core/verse/host-cpu.js';

function cpu(user: number, idle: number, model = 'test-core') {
  return { model, times: { user, idle, nice: 0, sys: 0, irq: 0 } };
}
describe('ephemeral host CPU intervals', () => {
  it('starts unknown then measures all cores, including fully idle and fully busy', () => {
    let at = 0, counters = [cpu(10, 90), cpu(40, 60)];
    const sample = createHostCpuSampler(() => counters, () => at);
    expect(sample()).toBeNull();
    at = 1000; counters = [cpu(20, 180), cpu(80, 120)];
    expect(sample()).toEqual({ usedPercent: 25, intervalMs: 1000 });
    at = 2000; counters = [cpu(20, 280), cpu(80, 220)];
    expect(sample()).toEqual({ usedPercent: 0, intervalMs: 1000 });
    at = 3000; counters = [cpu(120, 280), cpu(180, 220)];
    expect(sample()).toEqual({ usedPercent: 100, intervalMs: 1000 });
  });
  it('detaches counter objects and treats topology changes as a new baseline', () => {
    let at = 0, counters = [cpu(0, 0)];
    const sample = createHostCpuSampler(() => counters, () => at);
    sample(); at = 1000; counters[0]!.times.user = 100;
    expect(sample()?.usedPercent).toBe(100);
    at = 2000; counters = [cpu(200, 0), cpu(0, 0)]; expect(sample()).toBeNull();
    at = 3000; counters = [cpu(200, 100), cpu(0, 100)]; expect(sample()?.usedPercent).toBe(0);
    at = 4000; counters[0]!.model = 'replacement-core'; expect(sample()).toBeNull();
  });
  it('does not turn errors, invalid counters or time into a zero reading', () => {
    let at = 0, counters = [cpu(0, 0)], fail = false;
    const sample = createHostCpuSampler(() => { if (fail) throw new Error('no OS reading'); return counters; }, () => at);
    sample(); at = 1000; fail = true; expect(sample()).toBeNull();
    fail = false; at = 2000; counters = [cpu(100, 100)]; expect(sample()).toBeNull();
    at = 3000; counters = [cpu(200, 200)]; expect(sample()?.usedPercent).toBe(50);
    at = 4000; counters = [cpu(Number.NaN, 300)]; expect(sample()).toBeNull();
    at = 5000; counters = [cpu(300, 300)]; expect(sample()).toBeNull();
    at = 5000; counters = [cpu(400, 400)]; expect(sample()).toBeNull();
    at = Number.POSITIVE_INFINITY; expect(sample()).toBeNull();
    at = 6000; expect(sample()).toBeNull();
  });
  it('rejects rollback, zero movement, empty cores and unsafe aggregation', () => {
    let at = 0, counters = [cpu(100, 100)];
    const sample = createHostCpuSampler(() => counters, () => at);
    sample(); at = 1; counters = [cpu(90, 150)]; expect(sample()).toBeNull();
    at = 2; expect(sample()).toBeNull();
    counters = []; at = 3; expect(sample()).toBeNull();
    counters = [cpu(0, 0), cpu(0, 0)]; at = 4; expect(sample()).toBeNull();
    counters = [cpu(Number.MAX_SAFE_INTEGER, 0), cpu(Number.MAX_SAFE_INTEGER, 0)]; at = 5; expect(sample()).toBeNull();
  });
});
