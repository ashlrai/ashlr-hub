import { checkResourceGenerationRuntime, type ResourceGenerationCheckStage } from './resource-runtime-check.js';

export type ResourceAdmissionPreflightReason = `resource-runtime-invalid:${ResourceGenerationCheckStage}` | 'resource-runtime-check-failed';

const STAGES: readonly ResourceGenerationCheckStage[] = ['runtime', 'boundaries', 'workspace', 'pool', 'bindings',
  'observations', 'quota-refresh', 'local-model-refresh', 'ledger'];

/**
 * One read-only configuration check per foreground invocation, called lazily at
 * resource admission. A valid report grants no execution authority or capacity:
 * worker admission still repeats its configuration, identity and quota checks.
 */
export function resourceAdmissionPreflight(resourceRuntime: string, expectedRuntimeDigest?: string): () => ResourceAdmissionPreflightReason | null {
  let checked = false;
  let reason: ResourceAdmissionPreflightReason | null = null;
  return () => {
    // Pinned hosts recheck at admission; an earlier valid file is not evidence
    // that the configured ledger and transport still match this enrollment.
    if (checked && expectedRuntimeDigest === undefined) return reason;
    checked = true;
    try {
      const report = checkResourceGenerationRuntime({ resourceRuntime,
        ...(expectedRuntimeDigest === undefined ? {} : { expectedRuntimeDigest }) });
      if (report.status === 'valid') return null;
      const stage = report.checks.find((check) => check.status === 'failed' && STAGES.includes(check.code))?.code;
      reason = stage ? `resource-runtime-invalid:${stage}` : 'resource-runtime-check-failed';
    } catch { reason = 'resource-runtime-check-failed'; }
    return reason;
  };
}
