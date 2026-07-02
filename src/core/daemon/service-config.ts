import type { DaemonConfig } from '../types.js';
import type { ServiceInstallOptions } from './service.js';

const DEFAULT_SERVICE_BUDGET_USD = 5;
const DEFAULT_SERVICE_INTERVAL_MS = 5 * 60_000;
const DEFAULT_SERVICE_PARALLEL = 1;

/**
 * Map daemon config into OS service install options. This keeps CLI/API/web
 * service repair paths aligned on budget, interval, and parallelism. Defaults
 * intentionally mirror the effective daemon loop defaults rather than the
 * lower-level service generator's conservative historical fallback.
 */
export function daemonServiceInstallOptions(
  cfg?: { daemon?: Partial<DaemonConfig> } | null,
  extras: Partial<ServiceInstallOptions> = {},
): ServiceInstallOptions {
  const daemon: Partial<DaemonConfig> = cfg?.daemon ?? {};
  return {
    budget: typeof daemon.dailyBudgetUsd === 'number' ? daemon.dailyBudgetUsd : DEFAULT_SERVICE_BUDGET_USD,
    intervalMs: typeof daemon.intervalMs === 'number' ? daemon.intervalMs : DEFAULT_SERVICE_INTERVAL_MS,
    parallel: typeof daemon.parallel === 'number' ? daemon.parallel : DEFAULT_SERVICE_PARALLEL,
    ...extras,
  };
}
