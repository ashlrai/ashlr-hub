import { resourceCheckOptions, resourceCheckPath, ResourceCheckUsageError } from './resource-check-options.js';

const USAGE = `usage: ashlr resources pool evolve check|apply --root ABS --workspace ABS
       --pool ABS --bindings ABS --next-pool ABS --next-bindings ABS
       [--expected-plan-digest SHA256] [--json]

Upgrade an existing shared ledger without resetting usage or conversation history.
check is read-only. apply requires the exact --expected-plan-digest from a prior
check and a stopped console. Existing workers and account bindings cannot be
removed or remapped; supported quota annotations and additive workers are checked
against the existing account capacity, reserve and task limits.

Old receipts and transcript identities retain their original configuration.
Account pauses and allocation revisions are preserved, not cleared. An account-
wide pause still covers new aliases; adding Spark does not itself authorize use.
No credentials, provider calls, quota refresh, services or engineering launch.
Pool/binding input files are never rewritten. After a completed upgrade, use the
reviewed next configuration when starting the console. Old engineering/runtime
pins are not silently upgraded. The upgrade supplies no fresh quota evidence and
does not widen an existing explicit unknown-quota policy.
Previously queued tasks keep their original routing and remain held for explicit
cancellation/re-enrollment; their IDs are listed in the plan. New work uses the
new pool. Retained conversations can be continued as new, explicitly scoped work.

An interrupted apply must be inspected and explicitly resumed with the SAME
inputs and digest. Do not delete upgrade records or start from an empty ledger.
Older binaries cannot read the upgraded ledger. Keep the current source build.
Exit codes: 0 planned/applied/help, 1 unavailable/conflict, 2 invalid arguments.
`;
const PATHS = ['--root', '--workspace', '--pool', '--bindings', '--next-pool', '--next-bindings'];
const HASH = /^[a-f0-9]{64}$/;

export async function cmdResourcePoolEvolution(args: string[]): Promise<number> {
  let failureCode: ((error: unknown) => string | undefined) | undefined;
  try {
    if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
    const action = args[0];
    if (action !== 'check' && action !== 'apply') throw new ResourceCheckUsageError('Expected evolve check or apply');
    const parsed = resourceCheckOptions(['check', ...args.slice(1)], [...PATHS, '--expected-plan-digest']);
    const paths = Object.fromEntries(PATHS.map(key => [key, resourceCheckPath(parsed.values, key)]));
    const expectedPlanDigest = parsed.values.get('--expected-plan-digest');
    if (action === 'apply' ? !expectedPlanDigest || !HASH.test(expectedPlanDigest) : expectedPlanDigest !== undefined) {
      throw new ResourceCheckUsageError('Only apply requires an exact --expected-plan-digest');
    }
    const [{ readResourceJson }, backend] = await Promise.all([
      import('../core/resources/pool-runtime.js'), import('../core/resources/pool-evolution.js'),
    ]);
    failureCode = error => error instanceof backend.ResourcePoolEvolutionError ? error.code : undefined;
    const input = { root: paths['--root']!, workspace: paths['--workspace']!,
      pool: readResourceJson(paths['--pool']!, 256 * 1024), bindings: readResourceJson(paths['--bindings']!, 1024 * 1024),
      nextPool: readResourceJson(paths['--next-pool']!, 256 * 1024), nextBindings: readResourceJson(paths['--next-bindings']!, 1024 * 1024) };
    // Apply owns all fresh validation and explicit crash recovery. Do not prepend
    // a new check that would replace the operator's original migration identity.
    const report = action === 'check' ? backend.checkResourcePoolEvolution(input)
      : backend.applyResourcePoolEvolution({ ...input, expectedPlanDigest: expectedPlanDigest! });
    const encoded = JSON.stringify(report);
    if (Buffer.byteLength(encoded) > 256 * 1024) throw new Error('Pool evolution report exceeds bound');
    console.log(parsed.json ? encoded : [
      `Resource pool evolution · ${report.status}`,
      `Plan digest: ${report.planDigest}`,
      `Previous pool: ${report.fromPoolDigest}`,
      `Next pool: ${report.toPoolDigest}`,
      `Preserved receipts: ${report.preservedReceiptCount} · console jobs: ${report.preservedJobCount}`,
      `Added workers: ${report.addedWorkerIds.join(', ') || 'none'}`,
      `Quota annotations: ${report.annotatedWorkerIds.join(', ') || 'none'}`,
      `Queued tasks held for re-enrollment: ${report.heldQueuedIds.join(', ') || 'none'}`,
      action === 'check' ? 'Check only: no state or ownership changed.' : 'Ledger upgraded locally; inputs and account policy preserved.',
      'No console, provider or collector started. This is not account commissioning or engineering acceptance.',
    ].join('\n'));
    return 0;
  } catch (error) {
    const code = failureCode?.(error);
    const message = error instanceof ResourceCheckUsageError ? error.message
      : code ? `Pool evolution held: ${code}; inspect the selected inputs and preserve history`
        : 'Pool evolution unavailable; inspect the selected inputs and any incomplete upgrade without deleting history';
    if (args.includes('--json')) console.log(JSON.stringify({ error: message, ...(code ? { code } : {}) })); else console.error(message);
    return error instanceof ResourceCheckUsageError ? 2 : 1;
  }
}
