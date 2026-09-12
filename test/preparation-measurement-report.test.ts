import { describe, expect, it } from 'vitest';
import { parsePreparationMeasurementReport, summarizePreparationMeasurementReport } from '../src/core/universe/preparation-measurement-report.js';

function fixture() {
  const workflows = [
    { name: 'manager', methods: ['manager-open', 'bundle', 'manager-check', 'manager-replay', 'manager-check', 'manager-replay', 'manager-close'] },
    { name: 'successor', methods: ['successor-check', 'successor-metadata', 'successor-bundle', 'successor-metadata'] },
  ].map(({ name, methods }) => ({ name, processes: methods.length, blobProcesses: methods.length,
    requests: methods.map((method, index) => ({ id: index + 1, method, processes: 1, blobProcesses: 1 })) }));
  return { schemaVersion: 1, kind: 'preparation-verification-measurement', workload: 'preparation-workflows-v1',
    checksPassed: true, workflows, metrics: { correctness_checks: 19, verification_processes: 4,
      workflow_processes: 11, workflow_blob_processes: 11, fixture_owned_process_groups: 4,
      files_1_check_processes: 1, files_1_check_blob_processes: 1, files_1_metadata_processes: 1, files_1_metadata_blob_processes: 1,
      files_4_check_processes: 1, files_4_check_blob_processes: 1, files_4_metadata_processes: 1, files_4_metadata_blob_processes: 1,
    } as Record<string, number>, diagnostics: [] as Array<{ code: string; message: string }> };
}
const parse = (value: unknown) => parsePreparationMeasurementReport(JSON.stringify(value));
function failed() {
  const value = fixture(); value.checksPassed = false;
  value.diagnostics = [{ code: 'WORKFLOW_CANDIDATE_BEHAVIOR_FAILED', message: 'Fixed workload refused.' }];
  value.metrics = { correctness_checks: 16 }; value.workflows = value.workflows.slice(0, 1);
  return value;
}

describe('preparation measurement report', () => {
  it('summarizes emitted counts without an acceptance or provenance field', () => {
    const summary = summarizePreparationMeasurementReport(parse(fixture()));
    expect(summary).toMatchObject({ reportedChecksSatisfied: true, correctnessChecks: 19, leafProcesses: 4,
      workflowProcesses: 11, workflowBlobProcesses: 11, fixtureOwnedProcessGroups: 4,
      recordedWorkflowSubtotal: { processes: 11, blobProcesses: 11 }, diagnosticCodes: [] });
    expect(summary).not.toHaveProperty('passed'); expect(summary).not.toHaveProperty('score');
  });
  it('retains completed workflow rows but leaves missing failure aggregates unknown', () => {
    expect(summarizePreparationMeasurementReport(parse(failed()))).toMatchObject({ reportedChecksSatisfied: false,
      correctnessChecks: 16, leafProcesses: null, workflowProcesses: null, workflowBlobProcesses: null,
      fixtureOwnedProcessGroups: null, recordedWorkflowSubtotal: { processes: 7, blobProcesses: 7 } });
  });
  it('does not turn an absent workflow into a zero subtotal', () => {
    const value = failed(); value.workflows = []; value.metrics.correctness_checks = 0;
    expect(summarizePreparationMeasurementReport(parse(value)).recordedWorkflowSubtotal).toBeNull();
  });
  it('retains full measurements after post-completion settlement failure', () => {
    const value = fixture(); value.checksPassed = false;
    value.diagnostics = [{ code: 'PROCESS_SETTLEMENT_UNCONFIRMED', message: 'Owned process settlement remains unconfirmed.' }];
    expect(summarizePreparationMeasurementReport(parse(value))).toMatchObject({ reportedChecksSatisfied: false,
      workflowProcesses: 11, diagnosticCodes: ['PROCESS_SETTLEMENT_UNCONFIRMED'] });
  });
  it('preserves an explicitly recorded zero rather than making it unknown', () => {
    const value = fixture(); value.metrics.fixture_owned_process_groups = 0;
    expect(summarizePreparationMeasurementReport(parse(value)).fixtureOwnedProcessGroups).toBe(0);
  });
  it.each(['files_1_check', 'files_1_metadata', 'files_4_check', 'files_4_metadata'])('rejects zero healthy leaf counts for %s', key => {
    for (const suffix of ['processes', 'blob_processes']) {
      const value = fixture(); value.metrics[`${key}_${suffix}`] = 0;
      if (suffix === 'processes') { value.metrics[`${key}_blob_processes`] = 0; value.metrics.verification_processes--; }
      expect(() => parse(value)).toThrow('Invalid preparation measurement report');
    }
  });
  it.each([[0, 0], [0, 1], [0, 2], [0, 3], [1, 0], [1, 1], [1, 2]])('rejects zero healthy workflow counts %s:%s', (workflow, request) => {
    const value = fixture(); const row = value.workflows[workflow]!;
    row.requests[request]!.processes = 0; row.requests[request]!.blobProcesses = 0;
    row.processes--; row.blobProcesses--; value.metrics.workflow_processes--; value.metrics.workflow_blob_processes--;
    expect(() => parse(value)).toThrow('Invalid preparation measurement report');
    value.checksPassed = false; value.metrics = { correctness_checks: 19 }; value.diagnostics = failed().diagnostics;
    expect(() => parse(value)).toThrow('Invalid preparation measurement report');
  });
  it('permits zero refusal counts and nonzero manager-close counts as emitted schema allows', () => {
    const value = fixture();
    for (const [workflow, request] of [[0, 4], [0, 5], [1, 3]]) {
      const row = value.workflows[workflow]!; row.requests[request]!.processes = 0; row.requests[request]!.blobProcesses = 0;
      row.processes--; row.blobProcesses--; value.metrics.workflow_processes--; value.metrics.workflow_blob_processes--;
    }
    expect(parse(value).workflows[0]!.requests[6]!.processes).toBe(1);
  });
  it('does not interpret the legacy pre-initialization envelope as an installed workflow report', () => {
    expect(() => parse({ schemaVersion: 1, kind: 'preparation-verification-measurement', checksPassed: false,
      metrics: { correctness_checks: 0 }, diagnostics: [{ code: 'HARNESS_INITIALIZATION_FAILED', message: 'Initialization failed.' }] }))
      .toThrow('Invalid preparation measurement report');
  });
  it('copies workflow data when summarizing', () => {
    const value = parse(fixture()); const summary = summarizePreparationMeasurementReport(value);
    summary.workflows[0]!.requests[0]!.processes = 99;
    expect(value.workflows[0]!.requests[0]!.processes).toBe(1);
  });
  it.each(['passed', 'score', 'privateOutput'])('refuses unexpected envelope field %s', key => {
    expect(() => parse({ ...fixture(), [key]: 1 })).toThrow('Invalid preparation measurement report');
  });
  it.each([
    (v: ReturnType<typeof fixture>) => { v.schemaVersion = 2; },
    (v: ReturnType<typeof fixture>) => { v.workload = 'preparation-leaf-v1'; },
    (v: ReturnType<typeof fixture>) => { v.workflows.reverse(); },
    (v: ReturnType<typeof fixture>) => { v.workflows[0]!.requests[0]!.id = 2; },
    (v: ReturnType<typeof fixture>) => { v.workflows[0]!.requests[0]!.method = 'prepare'; },
    (v: ReturnType<typeof fixture>) => { v.workflows[0]!.requests.pop(); },
    (v: ReturnType<typeof fixture>) => { v.workflows[0]!.processes++; },
    (v: ReturnType<typeof fixture>) => { v.workflows[0]!.requests[0]!.blobProcesses = 2; },
    (v: ReturnType<typeof fixture>) => { v.metrics.workflow_processes++; },
    (v: ReturnType<typeof fixture>) => { v.metrics.verification_processes++; },
    (v: ReturnType<typeof fixture>) => { v.metrics.files_1_check_blob_processes = 2; },
    (v: ReturnType<typeof fixture>) => { v.metrics.correctness_checks = 18; },
    (v: ReturnType<typeof fixture>) => { v.metrics.extra = 1; },
    (v: ReturnType<typeof fixture>) => { v.metrics.workflow_processes = -1; },
    (v: ReturnType<typeof fixture>) => { v.metrics.workflow_processes = 1.5; },
    (v: ReturnType<typeof fixture>) => { v.metrics.workflow_processes = Number.MAX_SAFE_INTEGER + 1; },
    (v: ReturnType<typeof fixture>) => { v.checksPassed = false; },
  ])('rejects malformed structure, attribution or counters %#', mutate => {
    const value = fixture(); mutate(value); expect(() => parse(value)).toThrow('Invalid preparation measurement report');
  });
  it('rejects overflow while summing individually valid request counts', () => {
    const value = failed(); value.workflows[0]!.requests.forEach(row => { row.processes = Number.MAX_SAFE_INTEGER; });
    expect(() => parse(value)).toThrow('Invalid preparation measurement report');
  });
  it('rejects cross-workflow subtotal overflow even without emitted totals', () => {
    const value = failed(); value.workflows = fixture().workflows; value.metrics.correctness_checks = 19;
    for (const row of value.workflows) {
      row.requests.forEach(request => { request.processes = 1; request.blobProcesses = 0; });
      row.requests[0]!.processes = Number.MAX_SAFE_INTEGER - row.requests.length + 1;
      row.processes = Number.MAX_SAFE_INTEGER; row.blobProcesses = 0;
    }
    expect(() => parse(value)).toThrow('Invalid preparation measurement report');
  });
  it.each(['arbitrary-private-error', '\u001b[31m'])('refuses unknown or unsafe diagnostics %s', text => {
    const value = failed(); value.diagnostics[0] = { code: text, message: text };
    expect(() => parse(value)).toThrow('Invalid preparation measurement report');
  });
  it('refuses control characters in otherwise known diagnostic messages', () => {
    const value = failed(); value.diagnostics[0]!.message = '\u001b[31mprivate';
    expect(() => parse(value)).toThrow('Invalid preparation measurement report');
  });
  it('refuses full retained metrics on an ordinary early failure', () => {
    const value = fixture(); value.checksPassed = false; value.diagnostics = failed().diagnostics;
    expect(() => parse(value)).toThrow('Invalid preparation measurement report');
  });
  it.each(['', '{', 'null', '[]', ' '.repeat(24 * 1024 + 1), '{"__proto__":{}}'])('rejects invalid or oversized input %#', text => {
    expect(() => parsePreparationMeasurementReport(text)).toThrow('Invalid preparation measurement report');
  });
});
