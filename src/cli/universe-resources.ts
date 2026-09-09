import { resourceCheckOptions, resourceCheckPath, ResourceCheckUsageError } from './resource-check-options.js';
import type { ResourceGenerationCheckStage, ResourceGenerationNextCheck } from '../core/universe/resource-runtime-check.js';

const NEXT_CHECKS: Record<ResourceGenerationNextCheck, string> = {
  'review-owner-pause': 'This capacity is intentionally paused. Preserve the owner policy; use other eligible capacity.',
  'review-subscription-allocation': 'Subscription allocation is disabled. Preserve the allocation policy; use other eligible capacity.',
  'refresh-quota-evidence': 'Review quota evidence and explicitly refresh it when authorized; this check does not contact the provider.',
  'refresh-local-evidence': 'Review local-model evidence and explicitly refresh it when authorized; this check does not query or start a model.',
  'recheck-after-hint': 'Recheck after the timing hint with fresh evidence. Time passage alone does not establish capacity.',
  'inspect-capacity-ownership': 'Inspect unresolved capacity ownership before retrying; do not delete receipts or start a competing worker.',
  'wait-for-active-work': 'Let owned work settle, then recheck within the existing time budget. Do not start a competing worker.',
  'review-task-window': 'Review the recorded task window and recheck its limit; do not reset reservations.',
  'review-reserve-evidence': 'Preserve the configured reserve. Recheck provider evidence before considering admission.',
  'review-worker-availability': 'Inspect the recorded availability and shared-capacity evidence; unavailable does not by itself prove a provider outage.',
  'review-worker-scope': 'Review explicit worker enrollment and task scope; this check does not enroll workers.',
};
const FAILED_CHECKS: Record<ResourceGenerationCheckStage, string> = {
  runtime: 'Check the explicit runtime schema and owner-only private file permissions.',
  boundaries: 'Keep the private runtime and ledger outside the sterile generation workspace; inspect canonical paths.',
  workspace: 'Check the dedicated private, empty Git workspace without changing its contents automatically.',
  pool: 'Check the declared worker pool schema and supported providers.',
  bindings: 'Check worker bindings and shared-capacity assignments against the pool.',
  observations: 'Check the explicit observations schema and worker identities; do not replace unknown usage with zero.',
  'quota-refresh': 'Check quota collector configuration and pinned pool/account identities.',
  'local-model-refresh': 'Check local inventory configuration and pinned model/pool identities.',
  ledger: 'Inspect the selected ledger and its ownership/integrity; do not remove history or reinitialize it to force readiness.',
};

const USAGE = `usage: ashlr universe resources check --resource-runtime ABS [--json]

Checks the explicit private runtime, pool, bindings, quota/local refresh pins,
sterile workspace and current ledger without creating storage or contacting
providers. Lists worker capacity groups, snapshot eligibility and setup warnings.
Separates explicit owner/allocation holds, counts distinct capacity groups, and
preserves planner recheck hints. Guidance does not unpause accounts, change reserves,
refresh evidence or start work. A timing hint is not promised available capacity.
Valid configuration is not authentication, independent account identity, current
provider quota or campaign admission. Campaign-specific boundaries are not checked.
Exit codes: 0 valid configuration (workers can still be excluded), 1 invalid or
unavailable configuration, 2 invalid arguments. No default runtime is discovered.
`;

export async function cmdUniverseResources(args: string[]): Promise<number> {
  try {
    const options = resourceCheckOptions(args, ['--resource-runtime']);
    if (options.help) { console.log(USAGE); return 0; }
    const resourceRuntime = resourceCheckPath(options.values, '--resource-runtime');
    const { checkResourceGenerationRuntime } = await import('../core/universe/resource-runtime-check.js');
    const report = checkResourceGenerationRuntime({ resourceRuntime });
    console.log(options.json ? JSON.stringify(report, null, 2) : [
      `Universe resource configuration · ${report.status} · local checks only`,
      `Snapshot: ${report.sampledAt ?? 'unavailable'} · ledger=${report.sourceState ?? 'unchecked'}`,
      report.counts
        ? `Snapshot workers: ${report.counts.eligibleWorkers}/${report.counts.workers} eligible · ${report.counts.excludedWorkers} excluded` +
          ` · distinct capacity groups: ${report.counts.eligibleCapacities}/${report.counts.capacities} eligible`
        : 'Worker and capacity counts: unavailable (configuration not validated)',
      report.status === 'valid'
        ? `Subscription allocation ceiling: ${report.allocationCeilingPercent === null ? 'per-worker configured reserves' : `${report.allocationCeilingPercent}%`} (policy, not remaining quota)`
        : 'Subscription allocation ceiling: unchecked',
      `Earliest planner recheck hint: ${report.nextEligibleAt ?? 'none recorded'} (not promised availability)`,
      ...report.checks.map((check) => `${check.code} · ${check.status}` +
        (check.status === 'failed' ? `\n  Next check: ${FAILED_CHECKS[check.code]}` : '')),
      ...report.workers.map((worker) => `${worker.workerId} · ${worker.provider} · capacity=${worker.capacityKey} · ${worker.eligibility}` +
        ` · exclusions=${worker.exclusionReasons.join(', ') || 'none in snapshot'}` +
        ` · quota-refresh=${worker.quotaRefreshConfigured} · local-refresh=${worker.localModelRefreshConfigured}` +
        ` · warnings=${worker.warnings.join(', ') || 'none'}` +
        `\n  Policy holds: ${worker.policyHolds.join(', ') || 'none recorded'}` +
        ` · recheck hint=${worker.nextEligibleAt ?? 'none recorded'}` +
        worker.nextChecks.map((next) => `\n  Next check [${next}]: ${NEXT_CHECKS[next]}`).join('')),
      ...report.warnings.map((warning) => `Warning: ${warning}`),
      'No provider contacted. Configuration validity is not authenticated fleet readiness.',
      'Account pauses, allocation ceilings, reserves and ownership remain unchanged. No corrective action was executed.',
    ].join('\n'));
    return report.status === 'valid' ? 0 : 1;
  } catch (error) {
    const message = error instanceof ResourceCheckUsageError ? error.message : 'Resource configuration check unavailable';
    if (args.includes('--json')) console.log(JSON.stringify({ error: message }));
    else console.error(message);
    return error instanceof ResourceCheckUsageError ? 2 : 1;
  }
}
