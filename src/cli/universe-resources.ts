import { resourceCheckOptions, resourceCheckPath, ResourceCheckUsageError } from './resource-check-options.js';

const USAGE = `usage: ashlr universe resources check --resource-runtime ABS [--json]

Checks the explicit private runtime, pool, bindings, quota/local refresh pins,
sterile workspace and current ledger without creating storage or contacting
providers. Lists worker capacity groups, snapshot eligibility and setup warnings.
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
      ...report.checks.map((check) => `${check.code} · ${check.status}`),
      ...report.workers.map((worker) => `${worker.workerId} · ${worker.provider} · capacity=${worker.capacityKey} · ${worker.eligibility}` +
        ` · exclusions=${worker.exclusionReasons.join(', ') || 'none in snapshot'}` +
        ` · quota-refresh=${worker.quotaRefreshConfigured} · local-refresh=${worker.localModelRefreshConfigured}` +
        ` · warnings=${worker.warnings.join(', ') || 'none'}`),
      ...report.warnings.map((warning) => `Warning: ${warning}`),
      'No provider contacted. Configuration validity is not authenticated fleet readiness.',
    ].join('\n'));
    return report.status === 'valid' ? 0 : 1;
  } catch (error) {
    const message = error instanceof ResourceCheckUsageError ? error.message : 'Resource configuration check unavailable';
    if (args.includes('--json')) console.log(JSON.stringify({ error: message }));
    else console.error(message);
    return error instanceof ResourceCheckUsageError ? 2 : 1;
  }
}
