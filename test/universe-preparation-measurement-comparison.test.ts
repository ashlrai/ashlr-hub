import { describe, expect, it, vi } from 'vitest';
import { comparePreparationMeasurements, comparePreparationScenarioVectors, extractPreparationScenarioVector,
  PREPARATION_SCENARIO_KEYS } from '../src/core/universe/preparation-measurement-comparison.js';
import { parsePreparationMeasurementReport, type PreparationMeasurementReport } from '../src/core/universe/preparation-measurement-report.js';

const leaves = ['files_1_check', 'files_1_metadata', 'files_4_check', 'files_4_metadata'];
function report(): PreparationMeasurementReport {
  const workflows: PreparationMeasurementReport['workflows'] = [
    { name: 'manager', processes: 70, blobProcesses: 14,
      requests: ['manager-open', 'bundle', 'manager-check', 'manager-replay', 'manager-check', 'manager-replay', 'manager-close']
        .map((method, index) => ({ id: index + 1, method, processes: 10, blobProcesses: 2 })) },
    { name: 'successor', processes: 40, blobProcesses: 8,
      requests: ['successor-check', 'successor-metadata', 'successor-bundle', 'successor-metadata']
        .map((method, index) => ({ id: index + 1, method, processes: 10, blobProcesses: 2 })) },
  ];
  return { schemaVersion: 1, kind: 'preparation-verification-measurement', workload: 'preparation-workflows-v1', checksPassed: true,
    metrics: { correctness_checks: 19, ...Object.fromEntries(leaves.flatMap(key => [[`${key}_processes`, 10], [`${key}_blob_processes`, 2]])),
      verification_processes: 40, workflow_processes: 110, workflow_blob_processes: 22, fixture_owned_process_groups: 500 },
    workflows, diagnostics: [] };
}
function json(value = report()): string {
  // Recompute only legitimate aggregates; malformed-input cases edit the final text/object afterwards.
  value.metrics.verification_processes = leaves.reduce((sum, key) => sum + value.metrics[`${key}_processes`]!, 0);
  for (const workflow of value.workflows) {
    workflow.processes = workflow.requests.reduce((sum, row) => sum + row.processes, 0);
    workflow.blobProcesses = workflow.requests.reduce((sum, row) => sum + row.blobProcesses, 0);
  }
  value.metrics.workflow_processes = value.workflows.reduce((sum, row) => sum + row.processes, 0);
  value.metrics.workflow_blob_processes = value.workflows.reduce((sum, row) => sum + row.blobProcesses, 0);
  return JSON.stringify(value);
}
function partial(): string {
  return JSON.stringify({ ...report(), checksPassed: false, metrics: { correctness_checks: 15 }, workflows: report().workflows.slice(0, 1),
    diagnostics: [{ code: 'WORKFLOW_CANDIDATE_STARTUP_FAILED', message: 'Private fixture detail never copied' }] });
}
const vector = () => extractPreparationScenarioVector(json());
describe('fixed preparation scenario extraction', () => {
  it('has exactly fifteen stable ordered region keys, including repeated methods by ordinal', () => {
    const result = vector();
    expect(result.map(row => row.key)).toEqual([
      'leaf/files_1_check', 'leaf/files_1_metadata', 'leaf/files_4_check', 'leaf/files_4_metadata',
      'workflow/manager/1/manager-open', 'workflow/manager/2/bundle', 'workflow/manager/3/manager-check',
      'workflow/manager/4/manager-replay', 'workflow/manager/5/manager-check', 'workflow/manager/6/manager-replay',
      'workflow/manager/7/manager-close', 'workflow/successor/1/successor-check', 'workflow/successor/2/successor-metadata',
      'workflow/successor/3/successor-bundle', 'workflow/successor/4/successor-metadata',
    ]);
    expect(result.map(row => row.key)).toEqual(PREPARATION_SCENARIO_KEYS);
    expect(Object.isFrozen(PREPARATION_SCENARIO_KEYS)).toBe(true);
    expect(result.every(row => row.processes === 10 && row.blobProcesses === 2)).toBe(true);
  });
  it('returns independent data and never modifies report bytes', () => {
    const bytes = json(), first = extractPreparationScenarioVector(bytes);
    first[0]!.processes = 123; first.reverse();
    expect(extractPreparationScenarioVector(bytes)).toEqual(vector()); expect(bytes).toBe(json());
  });
  it('refuses failed/partial extraction without forwarding diagnostic prose', () => {
    expect(() => extractPreparationScenarioVector(partial())).toThrow(/^Invalid preparation measurement comparison$/);
  });
});
describe('diagnostic comparison arithmetic', () => {
  it('equality is unchanged, with no score or acceptance authority', () => {
    const result = comparePreparationMeasurements(json(), json());
    expect(result).toMatchObject({ scope: 'diagnostic-only', comparable: true, reason: null, result: 'unchanged', improved: false,
      processTotal: { baseline: 150, candidate: 150, delta: 0 }, regressions: [] });
    expect(result.regions).toHaveLength(15);
    for (const key of ['score', 'passed', 'accepted', 'identityVerified']) expect(result).not.toHaveProperty(key);
  });
  it('counts each process region once, never blob subtotals or fixture groups', () => {
    const candidate = report(); candidate.metrics.fixture_owned_process_groups = 999_999;
    expect(comparePreparationMeasurements(json(), json(candidate)).processTotal.candidate).toBe(150);
  });
  it('reports a strict process reduction without any regional regression', () => {
    const candidate = report(); candidate.metrics.files_4_check_processes = 4; candidate.metrics.files_4_check_blob_processes = 1;
    candidate.workflows[1]!.requests[2]!.processes = 5;
    const result = comparePreparationMeasurements(json(), json(candidate));
    expect(result).toMatchObject({ result: 'improved', improved: true, processTotal: { baseline: 150, candidate: 139, delta: -11 }, regressions: [] });
    expect(result.regions[2]).toMatchObject({ processDelta: -6, blobProcessDelta: -1 });
  });
  it('a process regression dominates a larger aggregate gain elsewhere', () => {
    const candidate = report(); candidate.metrics.files_1_check_processes = 2; candidate.workflows[0]!.requests[0]!.processes = 11;
    const result = comparePreparationMeasurements(json(), json(candidate));
    expect(result).toMatchObject({ result: 'regressed', improved: false, processTotal: { delta: -7 } });
    expect(result.regressions.map(row => row.key)).toEqual(['workflow/manager/1/manager-open']);
  });
  it('a blob-only regression also prevents improvement', () => {
    const candidate = report(); candidate.metrics.files_1_check_processes = 2; candidate.workflows[1]!.requests[0]!.blobProcesses = 3;
    const result = comparePreparationMeasurements(json(), json(candidate));
    expect(result).toMatchObject({ result: 'regressed', improved: false, processTotal: { delta: -8 } });
    expect(result.regressions[0]).toMatchObject({ processDelta: 0, blobProcessDelta: 1 });
  });
  it('blob reductions alone do not claim a process improvement', () => {
    const candidate = report(); candidate.metrics.files_1_check_blob_processes = 1;
    expect(comparePreparationMeasurements(json(), json(candidate))).toMatchObject({ result: 'unchanged', improved: false, regressions: [] });
  });
  it('a total increase reports positive deltas', () => {
    const candidate = report(); candidate.metrics.files_1_check_processes = 11;
    expect(comparePreparationMeasurements(json(), json(candidate))).toMatchObject({ result: 'regressed', processTotal: { delta: 1 } });
  });
  it.each(['baseline', 'candidate', 'both'] as const)('keeps partial %s totals unknown', side => {
    const result = comparePreparationMeasurements(side !== 'candidate' ? partial() : json(), side !== 'baseline' ? partial() : json());
    expect(result).toMatchObject({ comparable: false, reason: `${side}-checks-not-satisfied`, result: 'not-comparable', improved: false,
      processTotal: { baseline: side !== 'candidate' ? null : 150, candidate: side !== 'baseline' ? null : 150, delta: null }, regions: [], regressions: [] });
    expect(JSON.stringify(result)).not.toContain('Private fixture');
  });
  it('retains full reported totals after settlement failure without comparing or improving', () => {
    const candidate = report(); candidate.checksPassed = false;
    candidate.diagnostics = [{ code: 'PROCESS_SETTLEMENT_UNCONFIRMED', message: 'Private activity detail' }];
    const result = comparePreparationMeasurements(json(), json(candidate));
    expect(result).toMatchObject({ comparable: false, result: 'not-comparable', processTotal: { baseline: 150, candidate: 150, delta: null } });
    expect(() => extractPreparationScenarioVector(json(candidate))).toThrow();
  });
  it('accepts the exact safe-integer sum boundary', () => {
    const baseline = report(); baseline.metrics.files_1_check_processes = Number.MAX_SAFE_INTEGER - 140;
    const result = comparePreparationMeasurements(json(baseline), json());
    expect(result.processTotal.baseline).toBe(Number.MAX_SAFE_INTEGER); expect(Number.isSafeInteger(result.processTotal.delta)).toBe(true);
  });
  it('refuses cross-subtotal overflow even if the existing report parser accepts each subtotal', () => {
    const baseline = report(); baseline.metrics.files_1_check_processes = Number.MAX_SAFE_INTEGER - 139;
    const bytes = json(baseline); expect(() => parsePreparationMeasurementReport(bytes)).not.toThrow();
    expect(() => extractPreparationScenarioVector(bytes)).toThrow(/^Invalid preparation measurement comparison$/);
    expect(() => comparePreparationMeasurements(bytes, json())).toThrow(/^Invalid preparation measurement comparison$/);
  });
});
describe('malformed report refusal', () => {
  it.each(['', 'null', '{}', '{"passed":true,"score":0}', json() + ' '.repeat(24 * 1024)])('rejects invalid bounded input #%#', bytes => {
    expect(() => comparePreparationMeasurements(json(), bytes)).toThrow(/^Invalid preparation measurement comparison$/);
  });
  it.each([
    ['extra field', (value: Record<string, unknown>) => { value.accepted = true; }],
    ['wrong workload', (value: Record<string, unknown>) => { value.workload = 'other'; }],
    ['missing field', (value: Record<string, unknown>) => { delete value.workflows; }],
    ['wrong count', (value: Record<string, unknown>) => { (value.metrics as Record<string, unknown>).correctness_checks = 18; }],
    ['negative', (value: Record<string, unknown>) => { (value.metrics as Record<string, unknown>).files_1_check_processes = -1; }],
    ['nonfinite', (value: Record<string, unknown>) => { (value.metrics as Record<string, unknown>).files_1_check_processes = Infinity; }],
    ['duplicate request', (value: Record<string, unknown>) => { (value as unknown as PreparationMeasurementReport).workflows[0]!.requests[1]!.id = 1; }],
    ['method mismatch', (value: Record<string, unknown>) => { (value as unknown as PreparationMeasurementReport).workflows[0]!.requests[0]!.method = 'bundle'; }],
  ] as const)('rejects %s', (_name, change) => {
    const value = JSON.parse(json()) as Record<string, unknown>; change(value);
    expect(() => comparePreparationMeasurements(JSON.stringify(value), json())).toThrow(/^Invalid preparation measurement comparison$/);
  });
  it('does not coerce non-string inputs or invoke toJSON', () => {
    const callback = vi.fn(); const input = { toString: callback, toJSON: callback };
    expect(() => extractPreparationScenarioVector(input as unknown as string)).toThrow(); expect(callback).not.toHaveBeenCalled();
  });
});
describe('direct calibration vector boundary', () => {
  it('matches the report comparison exactly and detaches all input data', () => {
    const baseline = vector(), candidate = vector(); candidate[0]!.processes = 3;
    const result = comparePreparationScenarioVectors(baseline, candidate);
    expect(result.processTotal).toEqual({ baseline: 150, candidate: 143, delta: -7 });
    candidate[0]!.processes = 100; expect(result.regions[0]!.candidateProcesses).toBe(3);
  });
  it.each(['short', 'extra', 'reordered', 'sparse', 'extra-key', 'wrong-key', 'blob-over-process', 'negative', 'fraction', 'unsafe', 'zero-leaf', 'zero-healthy'])('rejects %s vector', kind => {
    const input = vector();
    if (kind === 'short') input.pop();
    if (kind === 'extra') input.push(input[0]!);
    if (kind === 'reordered') input.reverse();
    if (kind === 'sparse') delete input[0];
    if (kind === 'extra-key') Object.assign(input[0]!, { accepted: true });
    if (kind === 'wrong-key') input[0]!.key = 'leaf/unknown';
    if (kind === 'blob-over-process') input[0]!.blobProcesses = 11;
    if (kind === 'negative') input[0]!.processes = -1;
    if (kind === 'fraction') input[0]!.processes = 2.5;
    if (kind === 'unsafe') input[0]!.processes = Number.MAX_SAFE_INTEGER + 1;
    if (kind === 'zero-leaf') input[0]!.blobProcesses = 0;
    if (kind === 'zero-healthy') Object.assign(input[4]!, { processes: 0, blobProcesses: 0 });
    expect(() => comparePreparationScenarioVectors(vector(), input)).toThrow(/^Invalid preparation measurement comparison$/);
  });
  it('accepts zero counts in refusal/close regions', () => {
    const input = vector(); for (const index of [8, 9, 10, 14]) Object.assign(input[index]!, { processes: 0, blobProcesses: 0 });
    expect(comparePreparationScenarioVectors(vector(), input).improved).toBe(true);
  });
  it.each(['array-getter', 'row-getter', 'array-proxy', 'row-proxy', 'prototype', 'symbol', 'hidden', 'toJSON'])('rejects %s without invoking code', kind => {
    const callback = vi.fn(), input = vector(); let value: unknown = input;
    if (kind === 'array-getter') Object.defineProperty(input, '0', { enumerable: true, get: callback });
    if (kind === 'row-getter') Object.defineProperty(input[0]!, 'processes', { enumerable: true, get: callback });
    if (kind === 'array-proxy') value = new Proxy(input, { ownKeys: callback });
    if (kind === 'row-proxy') input[0] = new Proxy(input[0]!, { ownKeys: callback });
    if (kind === 'prototype') Object.setPrototypeOf(input[0]!, { inherited: 1 });
    if (kind === 'symbol') Object.assign(input[0]!, { [Symbol('extra')]: 1 });
    if (kind === 'hidden') Object.defineProperty(input[0]!, 'processes', { value: 10, enumerable: false });
    if (kind === 'toJSON') Object.assign(input[0]!, { toJSON: callback });
    expect(() => comparePreparationScenarioVectors(value, vector())).toThrow(); expect(callback).not.toHaveBeenCalled();
  });
  it('refuses total overflow before constructing deltas', () => {
    const input = vector(); input[0]!.processes = Number.MAX_SAFE_INTEGER;
    expect(() => comparePreparationScenarioVectors(input, vector())).toThrow();
  });
  it('redacts refusal of a revoked array proxy', () => {
    const input = Proxy.revocable(vector(), {}); input.revoke();
    expect(() => comparePreparationScenarioVectors(input.proxy, vector())).toThrow(/^Invalid preparation measurement comparison$/);
  });
});
