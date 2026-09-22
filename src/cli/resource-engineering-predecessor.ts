import { resourceCheckOptions, resourceCheckPath, ResourceCheckUsageError } from './resource-check-options.js';

const USAGE = `usage: ashlr resources pool engineering predecessor check
       --recipe ABS --policy ABS --output ABS --resource-runtime ABS
       --workspace ABS --projects ABS --expected-plan-digest SHA256
       --expected-deadline-at ISO [--json]

Read historical predecessor completion evidence for an existing setup using its
exact reviewed plan digest and original persisted supervision deadline.
Observation-only: verified is not dispatch permission, renewed budget, fresh
provider capacity, a production acceptance or an atomic settlement seal.
This command does not prepare, execute, recover, clear stops or change history.
Missing, changed or unresolved evidence stays held. No --execute is supported.
Exit codes: 0 verified/help, 1 held/unavailable, 2 invalid arguments.
`;
const PATHS = ['--recipe', '--policy', '--output', '--resource-runtime', '--workspace', '--projects'];

export async function cmdResourceEngineeringPredecessor(args: string[]): Promise<number> {
  try {
    const parsed = resourceCheckOptions(args, [...PATHS, '--expected-plan-digest', '--expected-deadline-at']);
    if (parsed.help) { console.log(USAGE); return 0; }
    const recipeFile = resourceCheckPath(parsed.values, '--recipe');
    const policyFile = resourceCheckPath(parsed.values, '--policy');
    const paths = { output: resourceCheckPath(parsed.values, '--output'),
      resourceRuntime: resourceCheckPath(parsed.values, '--resource-runtime'),
      workspace: resourceCheckPath(parsed.values, '--workspace'), projectsFile: resourceCheckPath(parsed.values, '--projects') };
    const expectedPlanDigest = parsed.values.get('--expected-plan-digest');
    const expectedDeadlineAt = parsed.values.get('--expected-deadline-at');
    if (expectedPlanDigest === undefined || !/^[a-f0-9]{64}$/.test(expectedPlanDigest)) {
      throw new ResourceCheckUsageError('Expected a SHA256 setup digest');
    }
    if (expectedDeadlineAt === undefined || !Number.isFinite(Date.parse(expectedDeadlineAt)) ||
      new Date(expectedDeadlineAt).toISOString() !== expectedDeadlineAt) {
      throw new ResourceCheckUsageError('Expected the original canonical ISO supervision deadline');
    }
    const [{ readResourceJson }, { checkResourceEngineeringPredecessor }] = await Promise.all([
      import('../core/resources/pool-runtime.js'), import('../core/resources/engineering-predecessor-check.js'),
    ]);
    const result = checkResourceEngineeringPredecessor({ setup: { ...paths,
      recipe: readResourceJson(recipeFile, 128 * 1024), policy: readResourceJson(policyFile, 16 * 1024) },
    expectedPlanDigest, expectedDeadlineAt });
    const serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized) > 64 * 1024) throw new Error('Predecessor report exceeds bound');
    console.log(parsed.json ? serialized : [
      `Engineering predecessor · ${result.status}`,
      `Sampled at: ${result.sampledAt}`,
      `Evidence digest: ${result.evidenceDigest ?? 'unavailable'}`,
      `Reasons: ${result.reasons.join(', ') || 'none observed'}`,
      ...(result.tip ? [`Verified local tip: ${result.tip.enrollmentId} · ${result.tip.commit}`] : []),
      `Continuation observation: ${result.continuation ?? 'unavailable'}`,
      'Observation-only; not dispatch permission, fresh capacity or a renewed budget. No effects executed.',
    ].join('\n'));
    return result.status === 'verified' ? 0 : 1;
  } catch (error) {
    const message = error instanceof ResourceCheckUsageError ? error.message
      : 'Engineering predecessor evidence unavailable; inspect the selected setup and retained ownership records';
    if (args.includes('--json')) console.log(JSON.stringify({ error: message })); else console.error(message);
    return error instanceof ResourceCheckUsageError ? 2 : 1;
  }
}
