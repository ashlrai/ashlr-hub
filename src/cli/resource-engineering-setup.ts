import { resourceCheckOptions, resourceCheckPath, ResourceCheckUsageError } from './resource-check-options.js';

const USAGE = `usage: ashlr resources pool engineering setup --recipe ABS --policy ABS --output ABS
       --resource-runtime ABS --workspace ABS --projects ABS
       [--check] [--expected-plan-digest SHA256] [--json]

Prepare one coherent autonomous startup using an existing resource ledger and a
reviewed project recipe. The private policy selects the profile, queue limits and
proposal workers. The recipe fixes the evaluator, seed, mutable files and budgets;
its initial delivery branch must be codex/<recipe.id>.

--output must be an existing private empty directory outside projects and shared
accounting, or the exact completed setup for replay. The resource ledger must
contain valid persisted accounting. Setup refuses active or uncertain console,
resource and collector ownership; stop their owners normally rather than
deleting locks or accounting history. Existing preparation history needs its
original configuration context, not a second setup.

--check reads and returns a plan digest without writing or registering anything.
Without --check, setup prepares the initial objective and its real registration,
then writes matching profile, appendable supervision and successor configuration.
Use --expected-plan-digest to pin a separately reviewed check. Completed exact
replay is read-only. Partial or changed output stays held; do not erase it to
retry uncertain work.

Returned console arguments are NOT executed. Starting that foreground console is
effectful: it can resume ordinary queued tasks, consume allowed resources and
deliver local branches. Its initial registered objective can lead to autonomous
successors without per-objective human actions, within the original queue limits.

Setup does not start workers, evaluators, collectors, consoles or services; clear
KILL; authenticate accounts; change reserves; or replenish usage history.
Configured artifacts are not authenticated capacity, useful engineering yield,
an installed resident service or a production deployment.
Exit codes: 0 planned/prepared/help, 1 unavailable/conflict, 2 invalid arguments.
`;
const PATHS = ['--recipe', '--policy', '--output', '--resource-runtime', '--workspace', '--projects'];
const quoteCommand = (args: string[]) => `node bin/ashlr ${args.map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(' ')}`;

export async function cmdResourceEngineeringSetup(args: string[]): Promise<number> {
  try {
    const checks = args.filter(arg => arg === '--check').length;
    if (checks > 1) throw new ResourceCheckUsageError('Duplicate setup option');
    const help = args.length === 1 && ['--help', '-h'].includes(args[0]!);
    const parsed = resourceCheckOptions(help ? args : ['check', ...args.filter(arg => arg !== '--check')],
      [...PATHS, '--expected-plan-digest']);
    if (parsed.help) { console.log(USAGE); return 0; }
    const recipeFile = resourceCheckPath(parsed.values, '--recipe');
    const policyFile = resourceCheckPath(parsed.values, '--policy');
    const paths = { output: resourceCheckPath(parsed.values, '--output'),
      resourceRuntime: resourceCheckPath(parsed.values, '--resource-runtime'),
      workspace: resourceCheckPath(parsed.values, '--workspace'), projectsFile: resourceCheckPath(parsed.values, '--projects') };
    const expected = parsed.values.get('--expected-plan-digest');
    if (expected !== undefined && !/^[a-f0-9]{64}$/.test(expected)) throw new ResourceCheckUsageError('Expected a SHA256 setup digest');
    const [{ readResourceJson }, backend] = await Promise.all([
      import('../core/resources/pool-runtime.js'), import('../core/resources/engineering-autonomous-setup.js'),
    ]);
    const options = { ...paths, recipe: readResourceJson(recipeFile, 128 * 1024), policy: readResourceJson(policyFile, 16 * 1024) };
    const plan = await backend.checkResourceEngineeringAutonomousSetup(options);
    if (expected !== undefined && expected !== plan.planDigest) throw new Error('Setup plan changed');
    const result = checks ? plan : await backend.prepareResourceEngineeringAutonomousSetup({ ...options,
      expectedPlanDigest: expected ?? plan.planDigest });
    const serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized) > 512 * 1024) throw new Error('Setup report exceeds bound');
    console.log(parsed.json ? serialized : [
      `Autonomous engineering setup · ${result.status}`,
      `Plan digest: ${result.planDigest}`,
      `Output: ${paths.output}`,
      `Known local holds: ${result.holds.join(', ') || 'none observed; capacity is not attested'}`,
      ...(result.status === 'prepared' ? [
        `Start the foreground console (effectful, from the built source checkout): ${quoteCommand(result.consoleArguments)}`,
      ] : ['Check only: no artifacts, registration or runtime effects.']),
      'Returned console arguments are not executed. No worker, evaluator, collector, console or service started.',
      'Account reserves, stop state and shared usage history remain unchanged. Setup is not provider commissioning or production activation.',
    ].join('\n'));
    return 0;
  } catch (error) {
    const message = error instanceof ResourceCheckUsageError ? error.message
      : 'Autonomous engineering setup unavailable; inspect the selected inputs, console ownership and any retained partial setup';
    if (args.includes('--json')) console.log(JSON.stringify({ error: message })); else console.error(message);
    return error instanceof ResourceCheckUsageError ? 2 : 1;
  }
}
