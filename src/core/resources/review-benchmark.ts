/** Fixed read-only review calibration. Never executes model text or certifies accepted changes. */
import { lstatSync, realpathSync } from 'node:fs';
import { canonical, digest } from '../universe/artifacts.js';
import { verifyOllamaModelIdentity, type OllamaModelIdentity } from '../run/ollama-identity.js';
import { validateResourcePool, validateResourceObservations, type ResourceObservation, type ResourcePool } from './pool-policy.js';
import { resourcePoolStatus, runResourceTask, validateResourceTask, type ResourceTaskReceipt } from './pool-runtime.js';
import { validateResourceBindings, type ResourceBinding } from './worker.js';

const CASES = [
  { id: 'zero-value', question: `Review this JavaScript function:
function reading(value) { if (!value) return null; return Number(value); }
Return one JSON object with exactly these keys:
zero: result of reading(0)
stringZero: result of reading("0")
empty: result of reading("")
fix: choose "nullish-check" or "no-change" to preserve numeric zero while rejecting null/undefined.`,
  expected: { zero: null, stringZero: 0, empty: null, fix: 'nullish-check' } },
  { id: 'page-boundary', question: `Review this JavaScript function:
function page(items, index, size) { return items.slice(index * size, index * size + size - 1); }
Assume page indices start at zero. Return one JSON object with exactly these keys:
first: result of page([10,20,30,40,50], 0, 2)
second: result of page([10,20,30,40,50], 1, 2)
last: result of page([10,20,30,40,50], 2, 2)
fix: choose "remove-minus-one" or "no-change" for full pages of size items.`,
  expected: { first: [10], second: [30], last: [50], fix: 'remove-minus-one' } },
  { id: 'shared-array', question: `Review this JavaScript code:
const source = [1, 2];
function append(xs, value) { const result = xs; result.push(value); return result; }
const result = append(source, 3);
Return one JSON object with exactly these keys:
source: final value of source
result: final value of result
sameReference: value of source === result
fix: choose "copy-before-push" or "no-change" if append must not mutate its input.`,
  expected: { source: [1, 2, 3], result: [1, 2, 3], sameReference: true, fix: 'copy-before-push' } },
] as const;
const INSTRUCTION = 'Analyze only the code supplied below. Do not use tools or read workspace files. Return raw JSON only, without markdown or commentary.\n\n';
export const RESOURCE_REVIEW_SUITE = Object.freeze({ id: 'review-calibration-v1', digest: digest(canonical({ instruction: INSTRUCTION, cases: CASES })),
  cases: Object.freeze(CASES.map(({ id, question }) => Object.freeze({ id, prompt: INSTRUCTION + question }))) });

export interface ResourceReviewEvaluation {
  checksPassed: number; checksTotal: number; passed: boolean;
  /** Fixed check names only, in suite order; never model-provided keys or values. */
  failedChecks: string[];
  reason: 'matched' | 'answer-mismatch' | 'invalid-json-contract';
}
export function evaluateResourceReview(caseId: string, output: string): ResourceReviewEvaluation {
  const test = CASES.find((row) => row.id === caseId);
  if (!test) throw new Error('Unknown resource review case');
  const keys = Object.keys(test.expected); const invalid = { checksPassed: 0, checksTotal: keys.length, passed: false,
    failedChecks: keys, reason: 'invalid-json-contract' as const };
  if (typeof output !== 'string' || Buffer.byteLength(output) > 16_384) return invalid;
  try {
    const answer: unknown = JSON.parse(output);
    if (!answer || typeof answer !== 'object' || Array.isArray(answer) ||
        Object.keys(answer).length !== keys.length || !keys.every((key) => Object.hasOwn(answer, key))) return invalid;
    const failedChecks = keys.filter((key) => canonical((answer as Record<string, unknown>)[key]) !==
      canonical((test.expected as Record<string, unknown>)[key]));
    const checksPassed = keys.length - failedChecks.length;
    return { checksPassed, checksTotal: keys.length, passed: checksPassed === keys.length,
      failedChecks, reason: checksPassed === keys.length ? 'matched' : 'answer-mismatch' };
  } catch { return invalid; }
}

export interface ResourceReviewReport {
  schemaVersion: 1; kind: 'resource-review-calibration'; runId: string; suiteId: string; suiteDigest: string;
  workloadDigest: string; poolDigest: string; workerId: string; provider: string; model: string;
  modelIdentity: OllamaModelIdentity | null; modelIdentityScope: 'ollama-inventory-before-each-task' | 'configured-native-model-only';
  startedAt: string; finishedAt: string; status: 'completed' | 'stopped'; stopReason: string | null;
  expectedCases: number; evaluatedCases: number; passedCases: number; score: number | null;
  verifiedAccepted: false; routingChanged: false;
  trials: Array<{ caseId: string; repeat: number; taskId: string; receipt: ResourceTaskReceipt | null;
    evaluation: ResourceReviewEvaluation | null; reason: string }>;
}

export async function runResourceReviewBenchmark(options: { root: string; pool: ResourcePool; bindings: ResourceBinding[];
  observations: ResourceObservation[]; workerId: string; runId: string; cwd: string; repeats?: number;
  timeoutMs?: number; maxOutputTokens?: number; expectedModelDigest?: string; signal?: AbortSignal }): Promise<ResourceReviewReport> {
  // One report belongs to one immutable enrollment, store and cancellation
  // signal. Caller-owned options may change while inventory/worker I/O awaits.
  const { root, cwd, workerId, runId, expectedModelDigest, signal } = options;
  const pool = validateResourcePool(options.pool); const bindings = validateResourceBindings(options.bindings, pool);
  const observations = validateResourceObservations(options.observations, pool);
  const worker = pool.workers.find((row) => row.id === workerId);
  const binding = bindings.find((row) => row.workerId === workerId);
  const repeats = options.repeats ?? 1; const timeoutMs = options.timeoutMs ?? 120_000; const maxOutputTokens = options.maxOutputTokens ?? 512;
  if (!worker || !binding || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(runId) ||
      !Number.isSafeInteger(repeats) || repeats < 1 || repeats > 3 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000 ||
      !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 64 || maxOutputTokens > 2_048 ||
      realpathSync(cwd) !== cwd || !lstatSync(cwd).isDirectory()) throw new Error('Invalid benchmark scope or limits');
  if (binding.kind === 'local-chat' ? !/^sha256:[a-f0-9]{64}$/.test(expectedModelDigest ?? '') : expectedModelDigest !== undefined) {
    throw new Error('Local calibration requires an exact Ollama model digest; native workers cannot attest an Ollama digest');
  }
  const workloadDigest = digest(canonical({ suite: RESOURCE_REVIEW_SUITE.digest, repeats, timeoutMs, maxOutputTokens, mode: 'read-only' }));
  const trials = Array.from({ length: repeats }, (_, repeat) => RESOURCE_REVIEW_SUITE.cases.map((test) => ({ test, repeat: repeat + 1,
    task: validateResourceTask({ schemaVersion: 1, id: `bench-${digest(canonical({ run: runId, worker: worker.id, repeat, test: test.id })).slice(0, 48)}`,
      allowedWorkerIds: [worker.id], prompt: test.prompt, cwd, timeoutMs, maxOutputTokens, mode: 'read-only' }) }))).flat();
  if (signal?.aborted) throw new Error('Benchmark cancelled before admission');
  const existing = resourcePoolStatus(root, pool, bindings, observations);
  const ids = new Set(trials.map((row) => row.task.id));
  if (existing.attempts.some((row) => ids.has(row.id))) throw new Error('Benchmark run identity already recorded; use a new run ID');
  const startedAt = new Date().toISOString();
  const report: ResourceReviewReport = { schemaVersion: 1, kind: 'resource-review-calibration', runId,
    suiteId: RESOURCE_REVIEW_SUITE.id, suiteDigest: RESOURCE_REVIEW_SUITE.digest, workloadDigest,
    poolDigest: digest(canonical({ pool, bindings })), workerId: worker.id, provider: worker.provider, model: worker.model,
    modelIdentity: null, modelIdentityScope: binding.kind === 'local-chat' ? 'ollama-inventory-before-each-task' : 'configured-native-model-only',
    startedAt, finishedAt: startedAt, status: 'stopped', stopReason: null, expectedCases: trials.length, evaluatedCases: 0,
    passedCases: 0, score: null, verifiedAccepted: false, routingChanged: false, trials: [] };
  for (const trial of trials) {
    if (signal?.aborted) { report.stopReason = 'cancelled'; break; }
    if (binding.kind === 'local-chat') {
      const verified = await verifyOllamaModelIdentity({ baseUrl: binding.endpoint, model: worker.model,
        expectedDigest: expectedModelDigest!, signal });
      if (!verified.ok) { report.stopReason = `model-identity-${verified.reason}`; break; }
      report.modelIdentity = verified.identity;
    }
    try {
      const result = await runResourceTask({ root, pool, bindings, observations, task: trial.task, signal });
      const evaluation = !result.replayed && result.receipt?.status === 'completed' && result.output !== null
        ? evaluateResourceReview(trial.test.id, result.output) : null;
      const reason = result.replayed ? 'recorded-output-unavailable' : evaluation?.reason ?? result.receipt?.reason ?? 'no-capacity';
      report.trials.push({ caseId: trial.test.id, repeat: trial.repeat, taskId: trial.task.id, receipt: result.receipt, evaluation, reason });
      if (!evaluation) { report.stopReason = reason; break; }
      report.evaluatedCases++; if (evaluation.passed) report.passedCases++;
    } catch {
      // A settlement error does not prove the worker stopped. Never retry or
      // label the missing durable result as a model failure.
      report.stopReason = 'dispatch-or-settlement-unavailable';
      report.trials.push({ caseId: trial.test.id, repeat: trial.repeat, taskId: trial.task.id, receipt: null,
        evaluation: null, reason: report.stopReason }); break;
    }
  }
  if (report.evaluatedCases === report.expectedCases) { report.status = 'completed'; report.score = report.passedCases / report.expectedCases; }
  report.finishedAt = new Date(Math.max(Date.now(), Date.parse(startedAt))).toISOString();
  return report;
}
