/** Read-only phase observations; no field in this shape attests process liveness. */
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
const timestamp = (v: unknown): v is string => typeof v === 'string' && v.length === 24 && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const nullableTime = (v: unknown) => v === null || timestamp(v);
const orderedTimes = (a: unknown, b: unknown) => nullableTime(a) && nullableTime(b) &&
  (b === null || typeof a === 'string' && typeof b === 'string' && a <= b);
const unique = (rows: Record<string, unknown>[], key: string) => new Set(rows.map(r => r[key])).size === rows.length;

export const engineeringPhaseReasons: Record<string, string> = {
  'phase-evidence-unavailable': 'Execution phase evidence could not be verified.',
  'phase-evidence-changed': 'Execution evidence changed during this read. Refresh for a fresh sample.',
  'phase-evidence-bounds-exceeded': 'Execution evidence exceeds this bounded view.',
};

export function validEngineeringPhaseEvidence(v: unknown): boolean {
  if (!object(v) || !exact(v, ['schemaVersion', 'scope', 'liveness', 'sourceState', 'reason', 'seed', 'runs']) ||
    v.schemaVersion !== 1 || v.scope !== 'recorded-execution-phases' || v.liveness !== 'not-attested' ||
    !Array.isArray(v.runs) || v.runs.length > 4096 || new TextEncoder().encode(JSON.stringify(v)).byteLength > 16 * 1024) return false;
  if (v.sourceState === 'unavailable') return typeof v.reason === 'string' && Object.hasOwn(engineeringPhaseReasons, v.reason) && v.seed === null && v.runs.length === 0;
  if (v.sourceState !== 'available' || v.reason !== null || !object(v.seed) ||
    !exact(v.seed, ['state', 'startedAt', 'finishedAt']) || !orderedTimes(v.seed.startedAt, v.seed.finishedAt)) return false;
  if (v.seed.state === 'unmeasured') { if (v.seed.startedAt !== null || v.seed.finishedAt !== null) return false; }
  else if (v.seed.state === 'intent-recorded') { if (!timestamp(v.seed.startedAt) || v.seed.finishedAt !== null) return false; }
  else if (v.seed.state === 'result-recorded') { if (!timestamp(v.seed.startedAt) || !timestamp(v.seed.finishedAt)) return false; }
  else return false;
  const runs: Record<string, unknown>[] = [];
  for (const run of v.runs) {
    if (!object(run) || !exact(run, ['runId', 'generation', 'state', 'workers', 'evaluators']) || !id(run.runId) ||
      !Number.isSafeInteger(run.generation) || Number(run.generation) < 1 ||
      !['not-recorded', 'running', 'completed', 'interrupted', 'failed'].includes(String(run.state)) ||
      !Array.isArray(run.workers) || run.workers.length > 4096 || !Array.isArray(run.evaluators) || run.evaluators.length > 4096) return false;
    const workers: Record<string, unknown>[] = [], evaluators: Record<string, unknown>[] = [];
    for (const worker of run.workers) {
      if (!object(worker) || !exact(worker, ['variantId', 'taskId', 'state', 'startedAt', 'finishedAt']) || !id(worker.variantId) || !id(worker.taskId) ||
        !['not-recorded', 'unverified', 'reserved', 'completed', 'failed', 'timed-out', 'cancelled', 'uncertain'].includes(String(worker.state)) ||
        !orderedTimes(worker.startedAt, worker.finishedAt)) return false;
      if (['not-recorded', 'unverified'].includes(String(worker.state)) && (worker.startedAt !== null || worker.finishedAt !== null)) return false;
      workers.push(worker);
    }
    for (const evaluator of run.evaluators) {
      if (!object(evaluator) || !exact(evaluator, ['trialId', 'variantId', 'state', 'startedAt', 'finishedAt']) || !id(evaluator.trialId) ||
        !(evaluator.variantId === null || id(evaluator.variantId)) || !timestamp(evaluator.startedAt) ||
        !orderedTimes(evaluator.startedAt, evaluator.finishedAt)) return false;
      if (evaluator.state === 'intent-recorded') { if (evaluator.finishedAt !== null) return false; }
      else if (evaluator.state === 'not-started' || evaluator.state === 'group-exit-confirmed') { if (!timestamp(evaluator.finishedAt)) return false; }
      else return false;
      if (evaluator.variantId !== null && !workers.some(w => w.variantId === evaluator.variantId)) return false;
      evaluators.push(evaluator);
    }
    if (!unique(workers, 'variantId') || !unique(workers, 'taskId') || !unique(evaluators, 'trialId')) return false;
    runs.push(run);
  }
  return unique(runs, 'runId');
}
