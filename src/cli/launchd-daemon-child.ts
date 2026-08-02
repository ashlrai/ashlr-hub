import { loadConfigReadOnlyStrict } from '../core/config.js';
import { readBuildIdentity } from '../core/build-identity.js';
import { runDaemon, type DaemonRunResult } from '../core/daemon/loop.js';
import type { DaemonConfig } from '../core/types.js';

const CHILD_RESULT_PROTOCOL = 'ashlr-launchd-daemon-child-result-v1' as const;
const RELEASE_REVISION_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

interface ChildSpec {
  releaseRevision: string;
  budget: number;
  intervalMs: number;
  parallel: number;
}

function parseArgs(args: readonly string[]): ChildSpec | null {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || value === undefined || values.has(flag) ||
      !new Set(['--release', '--budget', '--interval', '--parallel']).has(flag)) return null;
    values.set(flag, value);
  }
  if (values.size !== 4) return null;
  const releaseRevision = values.get('--release');
  const budget = Number(values.get('--budget'));
  const intervalMs = Number(values.get('--interval'));
  const parallel = Number(values.get('--parallel'));
  if (!releaseRevision || !RELEASE_REVISION_RE.test(releaseRevision) ||
    !Number.isFinite(budget) || budget <= 0 ||
    !Number.isFinite(intervalMs) || intervalMs <= 0 ||
    !Number.isSafeInteger(parallel) || parallel <= 0) return null;
  return { releaseRevision, budget, intervalMs, parallel };
}

function disposition(result: DaemonRunResult): {
  startRefusal?: string;
  termination: DaemonRunResult['termination'];
} {
  return {
    ...(result.startRefusal ? { startRefusal: result.startRefusal } : {}),
    termination: result.termination,
  };
}

async function sendDisposition(result: DaemonRunResult): Promise<boolean> {
  if (!process.send) return false;
  return new Promise((resolve) => {
    process.send!({ protocol: CHILD_RESULT_PROTOCOL, result: disposition(result) }, (error) => {
      resolve(error === null);
    });
  });
}

async function main(): Promise<number> {
  if (process.env['ASHLR_LAUNCHD_SUPERVISOR'] !== '1' || !process.send) return 1;
  const spec = parseArgs(process.argv.slice(2));
  if (!spec) return 1;
  const buildIdentity = readBuildIdentity();
  if (buildIdentity.revision !== spec.releaseRevision || buildIdentity.dirty === true ||
    buildIdentity.provenance === 'unavailable') return 1;
  const cfg = loadConfigReadOnlyStrict();
  const daemon: Partial<DaemonConfig> = {
    ...(cfg.daemon ?? {}),
    dailyBudgetUsd: spec.budget,
    intervalMs: spec.intervalMs,
    parallel: spec.parallel,
  };
  const result = await runDaemon({ ...cfg, daemon }, { once: false, dryRun: false });
  return await sendDisposition(result) ? result.termination.exitCode : 1;
}

process.exitCode = await main().catch(() => 1);
