/** Diagnostic arithmetic only. Reports and vectors do not attest identity,
 * execution custody, candidate acceptance, or an Evaluation score. */
import { types } from 'node:util';
import { parsePreparationMeasurementReport, type PreparationMeasurementReport } from './preparation-measurement-report.js';

const LEAVES = ['files_1_check', 'files_1_metadata', 'files_4_check', 'files_4_metadata'] as const;
const WORKFLOWS = {
  manager: ['manager-open', 'bundle', 'manager-check', 'manager-replay', 'manager-check', 'manager-replay', 'manager-close'],
  successor: ['successor-check', 'successor-metadata', 'successor-bundle', 'successor-metadata'],
} as const;
export const PREPARATION_SCENARIO_KEYS: readonly string[] = Object.freeze([
  ...LEAVES.map(key => `leaf/${key}`),
  ...Object.entries(WORKFLOWS).flatMap(([name, methods]) => methods.map((method, index) => `workflow/${name}/${index + 1}/${method}`)),
]);
export interface PreparationScenarioCount { key: string; processes: number; blobProcesses: number }
export interface PreparationScenarioDelta {
  key: string;
  baselineProcesses: number;
  candidateProcesses: number;
  /** Candidate minus baseline; positive values are regressions. */
  processDelta: number;
  baselineBlobProcesses: number;
  candidateBlobProcesses: number;
  blobProcessDelta: number;
}
export interface PreparationMeasurementComparison {
  schemaVersion: 1;
  scope: 'diagnostic-only';
  comparable: boolean;
  reason: 'baseline-checks-not-satisfied' | 'candidate-checks-not-satisfied' | 'both-checks-not-satisfied' | null;
  result: 'improved' | 'unchanged' | 'regressed' | 'not-comparable';
  improved: boolean;
  /** Sum of the 15 named regions only, never blob subtotals or fixture groups. */
  processTotal: { baseline: number | null; candidate: number | null; delta: number | null };
  regions: PreparationScenarioDelta[];
  regressions: PreparationScenarioDelta[];
}
function invalid(): never { throw new Error('Invalid preparation measurement comparison'); }
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
function sum(values: number[]): number { return values.reduce((total, value) => count(total + value), 0); }
function readReport(input: string): PreparationMeasurementReport {
  try { return parsePreparationMeasurementReport(input); } catch { invalid(); }
}
function complete(report: PreparationMeasurementReport): boolean {
  return report.checksPassed && report.metrics.correctness_checks === 19 && report.workflows.length === 2;
}
function vector(report: PreparationMeasurementReport): PreparationScenarioCount[] {
  if (!complete(report)) invalid();
  return validateVector([
    ...LEAVES.map(key => ({ key: `leaf/${key}`, processes: report.metrics[`${key}_processes`]!, blobProcesses: report.metrics[`${key}_blob_processes`]! })),
    ...report.workflows.flatMap(workflow => workflow.requests.map(request => ({
      key: `workflow/${workflow.name}/${request.id}/${request.method}`, processes: request.processes, blobProcesses: request.blobProcesses,
    }))),
  ]);
}
function validateVector(input: unknown): PreparationScenarioCount[] {
  if (types.isProxy(input) || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype ||
    input.length !== PREPARATION_SCENARIO_KEYS.length || Reflect.ownKeys(input).length !== input.length + 1) invalid();
  const rows = PREPARATION_SCENARIO_KEYS.map((key, index) => {
    const entry = Object.getOwnPropertyDescriptor(input, String(index));
    if (!entry?.enumerable || !Object.hasOwn(entry, 'value')) invalid();
    const value: unknown = entry.value;
    if (!value || typeof value !== 'object' || types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== 3) invalid();
    const fields = Object.getOwnPropertyDescriptors(value);
    if (['key', 'processes', 'blobProcesses'].some(name => !fields[name]?.enumerable || !Object.hasOwn(fields[name]!, 'value'))) invalid();
    const processes = count(fields.processes!.value), blobProcesses = count(fields.blobProcesses!.value);
    if (fields.key!.value !== key || blobProcesses > processes || index < 4 && blobProcesses === 0 ||
      (index < 8 || index >= 11 && index < 14) && processes === 0) invalid();
    return { key, processes, blobProcesses };
  });
  sum(rows.map(row => row.processes));
  return rows;
}
/** Strict installed-workload JSON; only full passing reports yield a vector. */
export function extractPreparationScenarioVector(report: string): PreparationScenarioCount[] {
  return vector(readReport(report));
}
/** Useful for a separately validated calibration descriptor. This validates
 * counts and topology, not the provenance of either supplied vector. */
export function comparePreparationScenarioVectors(baselineVector: unknown, candidateVector: unknown): PreparationMeasurementComparison {
  const baseline = validateVector(baselineVector), candidate = validateVector(candidateVector);
  const regions = baseline.map((row, index): PreparationScenarioDelta => ({
    key: row.key, baselineProcesses: row.processes, candidateProcesses: candidate[index]!.processes,
    processDelta: candidate[index]!.processes - row.processes,
    baselineBlobProcesses: row.blobProcesses, candidateBlobProcesses: candidate[index]!.blobProcesses,
    blobProcessDelta: candidate[index]!.blobProcesses - row.blobProcesses,
  }));
  const baselineTotal = sum(baseline.map(row => row.processes)), candidateTotal = sum(candidate.map(row => row.processes));
  const regressions = regions.filter(row => row.processDelta > 0 || row.blobProcessDelta > 0);
  const improved = regressions.length === 0 && candidateTotal < baselineTotal;
  return { schemaVersion: 1, scope: 'diagnostic-only', comparable: true, reason: null,
    result: regressions.length ? 'regressed' : improved ? 'improved' : 'unchanged', improved,
    processTotal: { baseline: baselineTotal, candidate: candidateTotal, delta: candidateTotal - baselineTotal },
    regions, regressions };
}
function reportedTotal(report: PreparationMeasurementReport): number | null {
  const leaf = report.metrics.verification_processes, workflow = report.metrics.workflow_processes;
  return leaf === undefined || workflow === undefined ? null : sum([leaf, workflow]);
}
/** Valid failed/partial reports remain diagnostic observations, with unknown
 * totals represented as null. Malformed reports and arithmetic overflow refuse. */
export function comparePreparationMeasurements(baselineReport: string, candidateReport: string): PreparationMeasurementComparison {
  const baseline = readReport(baselineReport), candidate = readReport(candidateReport);
  const baselineTotal = reportedTotal(baseline), candidateTotal = reportedTotal(candidate);
  if (!complete(baseline) || !complete(candidate)) return {
    schemaVersion: 1, scope: 'diagnostic-only', comparable: false,
    reason: !complete(baseline) && !complete(candidate) ? 'both-checks-not-satisfied' :
      !complete(baseline) ? 'baseline-checks-not-satisfied' : 'candidate-checks-not-satisfied',
    result: 'not-comparable', improved: false,
    processTotal: { baseline: baselineTotal, candidate: candidateTotal, delta: null }, regions: [], regressions: [],
  };
  return comparePreparationScenarioVectors(vector(baseline), vector(candidate));
}
