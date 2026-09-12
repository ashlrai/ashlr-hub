import { resourceCheckOptions, resourceCheckPath, ResourceCheckUsageError } from './resource-check-options.js';

const USAGE = `usage: ashlr resources pool engineering mission check --config ABS [--json]
       ashlr resources pool engineering mission run --config ABS
       --expected-config-digest SHA256 --execute [--json]

Run a standing engineering mission on the existing quota-aware local console.
The private configuration pins an already prepared initial setup, one original
absolute deadline, a lifetime scope count and the existing resource ledger.
Check is read-only. Run is effectful: it can start configured collectors and
workers, consume allowed account resources, evaluate changes and deliver local
Git branches. It automatically proposes and executes subsequent scopes from
verified delivered commits; no per-objective queue action is required.

Each scope uses the same fixed recipe/evaluator and account reserve policies.
Proposal text is retained privately for exact restart recovery. A stopped or
uncertain result is never retried under a replacement task identity. Existing
account pauses, queue pauses, KILL and quota limits are not cleared. The mission
also stops when ROOT/STOP exists or SIGINT/SIGTERM is received, and drains its
owned console. Removing STOP does not renew its original deadline.

This is a foreground owner, not an installed OS service, account connection,
public deployment or unlimited history store. Partial setup and uncertain
ownership remain held; preserve their records for inspection.
Exit codes: 0 checked/completed/help, 1 held/stopped/unavailable, 2 invalid arguments.
`;
export async function cmdResourceEngineeringMission(args: string[]): Promise<number> {
  try {
    if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
    const mode = args[0]; const executes = args.filter(value => value === '--execute').length;
    if (!['check', 'run'].includes(mode ?? '') || executes !== (mode === 'run' ? 1 : 0)) throw new ResourceCheckUsageError('Choose check, or run with --execute');
    const parsed = resourceCheckOptions(['check', ...args.slice(1).filter(value => value !== '--execute')], ['--config', '--expected-config-digest']);
    if (parsed.help) throw new ResourceCheckUsageError('Help must be used alone');
    const file = resourceCheckPath(parsed.values, '--config');
    const expected = parsed.values.get('--expected-config-digest');
    if (mode === 'run' && expected === undefined || expected !== undefined && !/^[a-f0-9]{64}$/.test(expected)) throw new ResourceCheckUsageError('Run requires the checked SHA256 configuration digest');
    const [{ readResourceJson }, { validateResourceEngineeringMissionConfig, missionHash }, { checkResourceEngineeringAutonomousSetup }] = await Promise.all([
      import('../core/resources/pool-runtime.js'), import('../core/resources/engineering-mission-store.js'), import('../core/resources/engineering-autonomous-setup.js'),
    ]);
    const config = validateResourceEngineeringMissionConfig(readResourceJson(file, 512 * 1024));
    const configDigest = missionHash(config);
    if (expected !== undefined && expected !== configDigest) throw new Error('Mission configuration changed');
    const setup = checkResourceEngineeringAutonomousSetup(config.initial.setup);
    if (setup.planDigest !== config.initial.expectedPlanDigest || !setup.initialEnrollmentDigest) throw new Error('Mission initial setup changed');
    if (mode === 'check') {
      console.log(JSON.stringify({ schemaVersion: 1, state: 'checked', missionId: config.id, configDigest,
        deadlineAt: config.deadlineAt, maxScopes: config.maxScopes, holds: setup.holds, effectsExecuted: false })); return 0;
    }
    const { runResourceEngineeringMission } = await import('../core/resources/engineering-mission.js');
    const controller = new AbortController(); const stop = () => controller.abort();
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    try {
      const result = await runResourceEngineeringMission(config, { signal: controller.signal, onProgress: progress => {
        console.error(parsed.json ? JSON.stringify({ event: 'mission-progress', ...progress }) :
          `Mission ${progress.missionId} · scope ${progress.scope} · ${progress.phase}${progress.consoleUrl ? ` · ${progress.consoleUrl}` : ''}`);
      } });
      console.log(JSON.stringify(result)); return result.state === 'completed' ? 0 : 1;
    } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  } catch (error) {
    const message = error instanceof ResourceCheckUsageError ? error.message : 'Engineering mission unavailable; inspect the selected setup and retained mission records';
    if (args.includes('--json')) console.log(JSON.stringify({ error: message })); else console.error(message);
    return error instanceof ResourceCheckUsageError ? 2 : 1;
  }
}
