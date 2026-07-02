import type { AshlrConfig, DaemonConfig } from '../types.js';
import type { ServiceInstallOptions } from './service.js';

/**
 * Map daemon config into OS service install options. This keeps CLI/API/web
 * service repair paths aligned on budget, interval, and parallelism.
 */
export function daemonServiceInstallOptions(
  cfg: Pick<AshlrConfig, 'daemon'>,
  extras: Partial<ServiceInstallOptions> = {},
): ServiceInstallOptions {
  const daemon: Partial<DaemonConfig> = cfg.daemon ?? {};
  return {
    ...(typeof daemon.dailyBudgetUsd === 'number' ? { budget: daemon.dailyBudgetUsd } : {}),
    ...(typeof daemon.intervalMs === 'number' ? { intervalMs: daemon.intervalMs } : {}),
    ...(typeof daemon.parallel === 'number' ? { parallel: daemon.parallel } : {}),
    ...extras,
  };
}
