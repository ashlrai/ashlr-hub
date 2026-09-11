import { resourceCheckOptions, resourceCheckPath, ResourceCheckUsageError } from './resource-check-options.js';

const USAGE = `usage: ashlr resources pool engineering check --root ABS --pool ABS --bindings ABS
       --observations ABS --workspace ABS --projects ABS --engineering ABS
       [--quota-config ABS] [--json]

To create an experiment/campaign and linked catalogs from a reviewed objective,
use: ashlr resources pool engineering prepare --help
For a coherent registered initial objective plus automatic successor startup,
use: ashlr resources pool engineering setup --help

Checks explicit engineering enrollment, projects and shared resource accounting
using existing local evidence. No default configuration is discovered. All paths
must be canonical absolute non-root paths. --workspace is the default project;
--projects and --engineering are the same private catalogs used by the console.
The optional quota configuration is inspected, never refreshed.

This command does not start a console, supervisor, collector, provider or evaluator;
create keys, locks or storage; repair ownership; or change policy. Project entries
marked would-register have not been registered by this check. Existing KILL,
account pauses, quota reserves and uncertain work remain unchanged.
Configured means structural local configuration only, not live admission, authenticated
capacity, successful evaluation or delivery. Launch must recheck current evidence.
Exit codes: 0 configured/help, 1 held or unavailable, 2 invalid arguments.
`;
const PATHS = ['--root', '--pool', '--bindings', '--observations', '--workspace', '--projects', '--engineering', '--quota-config'];
const MAX_REPORT_BYTES = 8 * 1024 * 1024;

export async function cmdResourceEngineeringCheck(args: string[]): Promise<number> {
  try {
    const options = resourceCheckOptions(args, PATHS);
    if (options.help) { console.log(USAGE); return 0; }
    const input = {
      root: resourceCheckPath(options.values, '--root'),
      poolFile: resourceCheckPath(options.values, '--pool'),
      bindingsFile: resourceCheckPath(options.values, '--bindings'),
      observationsFile: resourceCheckPath(options.values, '--observations'),
      workspace: resourceCheckPath(options.values, '--workspace'),
      projectsFile: resourceCheckPath(options.values, '--projects'),
      engineeringFile: resourceCheckPath(options.values, '--engineering'),
      ...(options.values.has('--quota-config') ? { quotaConfigFile: resourceCheckPath(options.values, '--quota-config') } : {}),
    };
    // Deliberately separate from console startup: inspection must never acquire
    // supervisor ownership, initialize storage or activate native collectors.
    const { checkResourceConsoleEngineering } = await import('../core/resources/console-engineering-check.js');
    const report = checkResourceConsoleEngineering(input);
    const serialized = JSON.stringify(report);
    if (Buffer.byteLength(serialized) > MAX_REPORT_BYTES) throw new Error('Report exceeds bound');
    console.log(options.json ? serialized : [
      `Engineering commissioning · ${report.status} · local configuration only`,
      `Snapshot: ${report.sampledAt} · admission: ${report.admission}`,
      ...report.checks.map((check) => `${check.code} · ${check.status}`),
      ...(report.reasons ?? []).map((reason) => `Reason: ${reason}`),
      ...report.enrollments.flatMap((row) => [
        `${row.id} · project=${row.projectId} · graph=${row.graphId} · ${row.status}`,
        `  Enrollment digest: ${row.enrollmentDigest}`,
        `  Project registration: ${row.projectRegistration}`,
        `  Graph: ${row.graph.sourceState} · ${row.graph.status} · definition=${row.graph.definitionDigest ?? 'not recorded'}`,
        `  Reasons: ${row.reasons.join(', ') || 'none observed'}`,
        `  Runtime: ${row.runtime.status}`,
        ...row.runtime.workers.map((worker) => `  Worker ${worker.workerId} · ${worker.eligibility}` +
          ` · policy=${worker.policyHolds.join(', ') || 'none recorded'}` +
          ` · exclusions=${worker.exclusionReasons.join(', ') || 'none in snapshot'}` +
          ` · recheck hint=${worker.nextEligibleAt ?? 'none recorded'} (not promised capacity)`),
        ...row.runtime.warnings.map((warning) => `  Runtime warning: ${warning}`),
      ]),
      'No console, supervisor, collector, provider or evaluator started. No keys, locks, storage or policy changed.',
      'Configured is structural configuration only; it is not live admission, authenticated capacity, evaluation or delivery acceptance. Launch rechecks current evidence.',
    ].join('\n'));
    return report.status === 'configured' ? 0 : 1;
  } catch (error) {
    const message = error instanceof ResourceCheckUsageError ? error.message : 'Engineering commissioning check unavailable';
    if (args.includes('--json')) console.log(JSON.stringify({ error: message }));
    else console.error(message);
    return error instanceof ResourceCheckUsageError ? 2 : 1;
  }
}
