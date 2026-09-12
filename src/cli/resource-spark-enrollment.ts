import { resourceCheckOptions, resourceCheckPath, ResourceCheckUsageError } from './resource-check-options.js';

const USAGE = `usage: ashlr resources pool spark prepare --pool ABS --bindings ABS --quota-config ABS
       --general-worker ID --spark-worker ID --output ABS [--json]

Prepare a NEW private directory with a General/Spark pool, bindings, quota config
and proposed General reservation. The parent directory must already be private.
Existing output (including an empty or incomplete directory) is never overwritten.
This does not enroll workers, modify a ledger, unpause accounts or refresh quota.
Keep the files private: they contain existing launcher configuration/account hints.

Next: use evolve check/apply against the existing ledger with the proposed files.
Preserve the account pause, merge the proposed General exclusion with existing
exclusions using their fresh revision, then explicitly consider unpausing. The
reservation file is ONE descriptor, not a replacement policy. Shared capacity,
task limits and reserves are preserved. Preparation supplies no fresh usage.
On failure retain incomplete output for inspection; use a new output path after
resolving the cause. No provider, credential, collector or service is started.
Exit codes: 0 prepared/help, 1 unavailable/conflict, 2 invalid arguments.
`;
const PATHS = ['--pool', '--bindings', '--quota-config', '--output'];
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export async function cmdResourceSparkEnrollment(args: string[]): Promise<number> {
  try {
    if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
    if (args[0] !== 'prepare') throw new ResourceCheckUsageError('Expected spark prepare');
    const parsed = resourceCheckOptions(['check', ...args.slice(1)], [...PATHS, '--general-worker', '--spark-worker']);
    const paths = Object.fromEntries(PATHS.map(key => [key, resourceCheckPath(parsed.values, key)]));
    const generalWorkerId = parsed.values.get('--general-worker'); const sparkWorkerId = parsed.values.get('--spark-worker');
    if (!generalWorkerId || !sparkWorkerId || !ID.test(generalWorkerId) || !ID.test(sparkWorkerId) || generalWorkerId === sparkWorkerId) {
      throw new ResourceCheckUsageError('Expected distinct General and Spark worker IDs');
    }
    const { prepareResourceSparkEnrollmentFiles } = await import('../core/resources/spark-enrollment-files.js');
    const report = prepareResourceSparkEnrollmentFiles({ poolPath: paths['--pool']!, bindingsPath: paths['--bindings']!,
      quotaConfigPath: paths['--quota-config']!, output: paths['--output']!, generalWorkerId, sparkWorkerId });
    console.log(parsed.json ? JSON.stringify(report) : [
      `Spark configuration prepared: ${report.manifestPath}`, `Previous pool: ${report.fromPoolDigest}`,
      `Proposed pool: ${report.toPoolDigest}`, 'Ledger and account policy unchanged; General reservation is proposed, not applied.',
      'Keep the account paused through migration and reservation. No quota refresh or provider activation.',
    ].join('\n'));
    return 0;
  } catch (error) {
    const message = error instanceof ResourceCheckUsageError ? error.message
      : 'Spark preparation unavailable; preserve any incomplete output and inspect the selected configuration';
    if (args.includes('--json')) console.log(JSON.stringify({ error: message })); else console.error(message);
    return error instanceof ResourceCheckUsageError ? 2 : 1;
  }
}
