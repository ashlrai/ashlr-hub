/** Read-only configuration diagnostics. Valid configuration is not authority to execute. */
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { validateResourcePool, validateResourceObservations, type ResourceExclusionReason, type ResourceWorker } from '../resources/pool-policy.js';
import { readResourceJson, resourcePoolStatus } from '../resources/pool-runtime.js';
import { validateResourceBindings } from '../resources/worker.js';
import { validateResourceQuotaRefreshConfig } from '../resources/quota-refresh.js';
import { validateResourceLocalModelConfig } from '../resources/local-model-refresh.js';
import { canonical, digest } from './artifacts.js';
import { checkResourceGenerationWorkspace, validateResourceGenerationRuntime } from './resource-generation.js';

export type ResourceGenerationCheckStage = 'runtime' | 'boundaries' | 'workspace' | 'pool' | 'bindings' |
  'observations' | 'quota-refresh' | 'local-model-refresh' | 'ledger';
export type ResourceGenerationCheckWarning = 'execution-and-account-identity-unverified' | 'campaign-boundaries-unchecked' |
  'duplicate-native-command-across-capacities' | 'quota-refresh-not-configured' | 'local-model-refresh-not-configured' |
  'unknown-quota-opt-in' | 'resource-store-missing';
export interface ResourceGenerationRuntimeWorkerCheck {
  workerId: string;
  provider: ResourceWorker['provider'];
  capacityKey: string;
  transport: 'native-cli' | 'local-chat';
  quotaRefreshConfigured: boolean;
  localModelRefreshConfigured: boolean;
  /** Existing local-evidence preview only; dispatch must repeat all admission checks. */
  eligibility: 'eligible' | 'excluded';
  exclusionReasons: ResourceExclusionReason[];
  warnings: ResourceGenerationCheckWarning[];
}
export interface ResourceGenerationRuntimeCheck {
  schemaVersion: 1;
  status: 'valid' | 'invalid';
  evidenceScope: 'local-configuration-only';
  providerContacted: false;
  poolId: string | null;
  poolDigest: string | null;
  sourceState: 'healthy' | 'missing' | null;
  sampledAt: string | null;
  checks: Array<{ code: ResourceGenerationCheckStage; status: 'passed' | 'failed' | 'not-configured' | 'not-checked' }>;
  workers: ResourceGenerationRuntimeWorkerCheck[];
  warnings: ResourceGenerationCheckWarning[];
}

const STAGES: ResourceGenerationCheckStage[] = ['runtime', 'boundaries', 'workspace', 'pool', 'bindings',
  'observations', 'quota-refresh', 'local-model-refresh', 'ledger'];
function contains(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return difference === '' || difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference);
}

/**
 * Reads only the named private runtime and its explicit files. The three bounded Git
 * queries inspect the same sterile workspace used by generation; no launcher,
 * provider probe, refresh, evaluator, lock, or ledger write is performed here.
 * A campaign and candidate are deliberately absent, so their boundary/digest
 * checks remain execution-time requirements, not implied by this report.
 */
export function checkResourceGenerationRuntime(options: { resourceRuntime: string }): ResourceGenerationRuntimeCheck {
  const result: ResourceGenerationRuntimeCheck = { schemaVersion: 1, status: 'invalid', evidenceScope: 'local-configuration-only',
    providerContacted: false, poolId: null, poolDigest: null, sourceState: null, sampledAt: null,
    checks: STAGES.map((code) => ({ code, status: 'not-checked' })), workers: [],
    warnings: ['execution-and-account-identity-unverified', 'campaign-boundaries-unchecked'] };
  let current: ResourceGenerationCheckStage = 'runtime';
  const check = <T>(stage: ResourceGenerationCheckStage, action: () => T): T => {
    current = stage;
    const value = action();
    result.checks.find((row) => row.code === stage)!.status = 'passed';
    return value;
  };
  try {
    const runtime = check('runtime', () => validateResourceGenerationRuntime(readResourceJson(options.resourceRuntime)));
    check('boundaries', () => {
      if (contains(runtime.workspace, runtime.root) || contains(runtime.root, runtime.workspace) ||
        realpathSync(dirname(runtime.root)) !== dirname(runtime.root)) throw new Error();
      for (const file of [options.resourceRuntime, runtime.poolPath, runtime.bindingsPath, runtime.observationsPath,
        ...(runtime.quotaConfigPath ? [runtime.quotaConfigPath] : []),
        ...(runtime.localModelConfigPath ? [runtime.localModelConfigPath] : [])]) {
        if (contains(runtime.workspace, file)) throw new Error();
      }
    });
    check('workspace', () => {
      const started = performance.now();
      checkResourceGenerationWorkspace(runtime.workspace, () => {
        const remaining = Math.floor(10_000 - (performance.now() - started));
        if (remaining < 1) throw new Error();
        return remaining;
      });
    });
    const pool = check('pool', () => validateResourcePool(readResourceJson(runtime.poolPath)));
    const bindings = check('bindings', () => validateResourceBindings(readResourceJson(runtime.bindingsPath), pool));
    const observations = check('observations', () => validateResourceObservations(readResourceJson(runtime.observationsPath), pool));
    const quota = runtime.quotaConfigPath ? check('quota-refresh', () =>
      validateResourceQuotaRefreshConfig(readResourceJson(runtime.quotaConfigPath!), pool, bindings)) : null;
    if (!quota) result.checks.find((row) => row.code === 'quota-refresh')!.status = 'not-configured';
    const local = runtime.localModelConfigPath ? check('local-model-refresh', () =>
      validateResourceLocalModelConfig(readResourceJson(runtime.localModelConfigPath!), pool, bindings)) : null;
    if (!local) result.checks.find((row) => row.code === 'local-model-refresh')!.status = 'not-configured';
    const snapshot = check('ledger', () => resourcePoolStatus(runtime.root, pool, bindings, observations));
    const workers: ResourceGenerationRuntimeWorkerCheck[] = pool.workers.map((worker) => {
      const binding = bindings.find((row) => row.workerId === worker.id)!;
      const quotaRefreshConfigured = quota?.workers.some((row) => row.workerId === worker.id) ?? false;
      const localModelRefreshConfigured = local?.workers.some((row) => row.workerId === worker.id) ?? false;
      const warnings: ResourceGenerationCheckWarning[] = [];
      if (worker.provider !== 'local' && !quotaRefreshConfigured) warnings.push('quota-refresh-not-configured');
      if (worker.provider === 'local' && !localModelRefreshConfigured) warnings.push('local-model-refresh-not-configured');
      if (worker.provider !== 'local' && worker.allowUnknownQuota) warnings.push('unknown-quota-opt-in');
      if (binding.kind === 'native-cli' && bindings.some((other) => other.kind === 'native-cli' &&
        other.capacityKey !== binding.capacityKey && canonical(other.command) === canonical(binding.command))) {
        warnings.push('duplicate-native-command-across-capacities');
      }
      return { workerId: worker.id, provider: worker.provider, capacityKey: binding.capacityKey, transport: binding.kind,
        quotaRefreshConfigured, localModelRefreshConfigured,
        eligibility: snapshot.plan.candidates.some((row) => row.workerId === worker.id) ? 'eligible' : 'excluded',
        exclusionReasons: snapshot.plan.exclusions.find((row) => row.workerId === worker.id)?.reasons ?? [], warnings };
    });
    result.status = 'valid'; result.poolId = pool.id; result.poolDigest = digest(canonical({ pool, bindings }));
    result.sourceState = snapshot.sourceState; result.sampledAt = snapshot.plan.sampledAt; result.workers = workers;
    if (snapshot.sourceState === 'missing') result.warnings.push('resource-store-missing');
  } catch {
    // Raw parser, filesystem, Git and ledger errors can contain private paths or
    // native configuration. Emit only the fixed failing stage and no partial roster.
    result.checks.find((row) => row.code === current)!.status = 'failed';
  }
  return result;
}
