import { cpus, type CpuInfo } from 'node:os';
import { performance } from 'node:perf_hooks';

/** Host-wide activity over a real interval, not model placement or process CPU. */
export interface HostCpuReading { usedPercent: number; intervalMs: number }
type Counter = Pick<CpuInfo, 'model' | 'times'>;
const FIELDS = ['user', 'nice', 'sys', 'idle', 'irq'] as const;

/** Ephemeral counter baseline only; reading never waits or starts a sampler service. */
export function createHostCpuSampler(read: () => readonly Counter[] = cpus, clock: () => number = () => performance.now()): () => HostCpuReading | null {
  let previous: { counters: Counter[]; at: number } | null = null;
  return () => {
    try {
      const at = clock(), raw = read();
      if (!Number.isFinite(at) || raw.length === 0 || raw.some(cpu => typeof cpu.model !== 'string' ||
          FIELDS.some(field => !Number.isSafeInteger(cpu.times[field]) || cpu.times[field] < 0))) {
        previous = null; return null;
      }
      // Detach caller-owned counters; providers and tests may mutate their objects.
      const counters = raw.map(cpu => ({ model: cpu.model, times: { ...cpu.times } }));
      const old = previous; previous = { counters, at };
      if (!old || at <= old.at || counters.length !== old.counters.length ||
          counters.some((cpu, i) => cpu.model !== old.counters[i]!.model)) return null;
      let total = 0, idle = 0;
      for (let i = 0; i < counters.length; i += 1) {
        let coreTotal = 0;
        for (const field of FIELDS) {
          const delta = counters[i]!.times[field] - old.counters[i]!.times[field];
          if (!Number.isSafeInteger(delta) || delta < 0) return null;
          coreTotal += delta;
          if (field === 'idle') idle += delta;
        }
        if (!Number.isSafeInteger(coreTotal) || coreTotal <= 0) return null;
        total += coreTotal;
      }
      if (!Number.isSafeInteger(total) || !Number.isSafeInteger(idle) || total <= 0) return null;
      return { usedPercent: (total - idle) / total * 100, intervalMs: at - old.at };
    } catch { previous = null; return null; }
  };
}

export const sampleHostCpu = createHostCpuSampler();
