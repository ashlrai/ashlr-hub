import { resourceCheckOptions, resourceCheckPath, ResourceCheckUsageError } from './resource-check-options.js';

const USAGE = `usage: ashlr resources pool engineering prepare --recipe ABS --output ABS
       --resource-runtime ABS --workspace ABS --projects ABS
       [--check] [--expected-plan-digest SHA256] [--json]

Prepare one reviewed engineering objective, with multiple competing hypotheses,
using the existing project catalog and shared resource ledger. The private recipe
declares a full seed revision, fixed evaluator, mutable files, existing workers,
budgets and new local delivery branch. Account configuration is never invented.

--check validates and returns a plan digest without creating files or registering
work. It does not prove authenticated provider capacity or successful evaluation.
Without --check, prepare creates a NEW private bundle at --output and initializes
its experiment/campaign, then emits linked engineering and supervision catalogs.
--output needs an existing private parent outside projects and shared accounting.
Use --expected-plan-digest to pin a separately reviewed check. Otherwise the
command captures and rechecks its own plan before registration.

Completed exact replay verifies the bundle without rewriting it. Incomplete or
changed bundles remain held; never delete them to replay uncertain work.
Preparation does not run workers/evaluators, publish branches, start a console,
install services, clear KILL, authenticate accounts or change usage/reserves.
Returned console arguments are not executed. Automatic console startup is a
separate effectful action that can consume allowance and deliver local branches.
Either console command can resume previously queued ordinary tasks.
Exit codes: 0 prepared/planned/help, 1 unavailable/conflict, 2 invalid arguments.
`;
const PATHS = ['--recipe', '--output', '--resource-runtime', '--workspace', '--projects'];
const HASH = /^[a-f0-9]{64}$/;
const command = (args: string[]) => `node bin/ashlr ${args.map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(' ')}`;

export async function cmdResourceEngineeringPrepare(args: string[]): Promise<number> {
  try {
    const checkCount = args.filter(arg => arg === '--check').length;
    if (checkCount > 1) throw new ResourceCheckUsageError('Duplicate preparation option');
    const help = args.length === 1 && ['--help', '-h'].includes(args[0]!);
    const parsed = resourceCheckOptions(help ? args : ['check', ...args.filter(arg => arg !== '--check')],
      [...PATHS, '--expected-plan-digest']);
    if (parsed.help) { console.log(USAGE); return 0; }
    const recipePath = resourceCheckPath(parsed.values, '--recipe');
    const paths = { output: resourceCheckPath(parsed.values, '--output'),
      resourceRuntime: resourceCheckPath(parsed.values, '--resource-runtime'),
      workspace: resourceCheckPath(parsed.values, '--workspace'),
      projectsFile: resourceCheckPath(parsed.values, '--projects') };
    const expected = parsed.values.get('--expected-plan-digest');
    if (expected !== undefined && !HASH.test(expected)) throw new ResourceCheckUsageError('Expected a SHA256 preparation digest');
    const [{ readResourceJson }, backend] = await Promise.all([
      import('../core/resources/pool-runtime.js'), import('../core/resources/engineering-preparation.js'),
    ]);
    const options = { ...paths, recipe: readResourceJson(recipePath, 128 * 1024) };
    const plan = backend.checkResourceEngineeringPreparation(options);
    if (expected !== undefined && expected !== plan.planDigest) throw new Error('Preparation plan changed');
    const result = checkCount ? plan : backend.prepareResourceEngineeringBundle({ ...options,
      expectedPlanDigest: expected ?? plan.planDigest });
    const serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized) > 256 * 1024) throw new Error('Preparation report exceeds bound');
    console.log(parsed.json ? serialized : [
      `Engineering preparation · ${result.status} · ${result.projectId}`,
      `Plan digest: ${result.planDigest}`,
      `Output: ${result.output}`,
      `Seed revision: ${result.seedRevision}`,
      ...(result.status === 'prepared' ? [
        `Bundle: ${result.disposition} · enrollment digest: ${result.enrollmentDigest}`,
        `Commissioning: ${result.commissioning.status} · ${result.commissioning.reasons.join(', ') || 'no recorded holds'}`,
        `Receipt: ${result.paths.receipt}`,
        `Manual engineering console (run from the built source checkout): ${command(result.consoleArguments.manual)}`,
        `Automatic engineering console (effectful when run): ${command(result.consoleArguments.automatic)}`,
      ] : ['Check only: no files created or campaigns registered.']),
      'No workers, evaluators, console or services started. Account policy and shared usage history are unchanged.',
      'Prepared configuration is not provider commissioning, accepted engineering value or production deployment.',
    ].join('\n'));
    return 0;
  } catch (error) {
    const message = error instanceof ResourceCheckUsageError ? error.message : 'Engineering preparation unavailable; inspect the selected inputs and any incomplete bundle';
    if (args.includes('--json')) console.log(JSON.stringify({ error: message })); else console.error(message);
    return error instanceof ResourceCheckUsageError ? 2 : 1;
  }
}
