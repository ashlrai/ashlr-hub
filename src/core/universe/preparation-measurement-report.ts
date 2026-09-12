/** Read-only interpretation of reported measurements, never evaluation acceptance. */
const METHODS = {
  manager: ['manager-open', 'bundle', 'manager-check', 'manager-replay', 'manager-check', 'manager-replay', 'manager-close'],
  successor: ['successor-check', 'successor-metadata', 'successor-bundle', 'successor-metadata'],
} as const;
const LEAF = ['files_1_check', 'files_1_metadata', 'files_4_check', 'files_4_metadata'] as const;
const METRICS = ['correctness_checks', ...LEAF.flatMap(key => [`${key}_processes`, `${key}_blob_processes`]),
  'verification_processes', 'workflow_processes', 'workflow_blob_processes', 'fixture_owned_process_groups'];
const REASONS = ['HARNESS_INITIALIZATION_FAILED', 'FIXTURE_SETUP_FAILED', 'CANDIDATE_STARTUP_FAILED',
  'CANDIDATE_BEHAVIOR_FAILED', 'CANDIDATE_SHUTDOWN_FAILED', 'WORKFLOW_FIXTURE_SETUP_FAILED',
  'WORKFLOW_CANDIDATE_STARTUP_FAILED', 'WORKFLOW_CANDIDATE_BEHAVIOR_FAILED', 'WORKFLOW_CANDIDATE_SHUTDOWN_FAILED',
  'CANDIDATE_CONFINEMENT_UNAVAILABLE', 'PROCESS_SETTLEMENT_UNCONFIRMED'];

export interface PreparationMeasurementRequest {
  id: number;
  method: string;
  processes: number;
  blobProcesses: number;
}
export interface PreparationMeasurementWorkflow {
  name: 'manager' | 'successor';
  processes: number;
  blobProcesses: number;
  requests: PreparationMeasurementRequest[];
}
export interface PreparationMeasurementReport {
  schemaVersion: 1;
  kind: 'preparation-verification-measurement';
  workload: 'preparation-workflows-v1';
  checksPassed: boolean;
  metrics: { correctness_checks: number; [key: string]: number | undefined };
  workflows: PreparationMeasurementWorkflow[];
  diagnostics: Array<{ code: string; message: string }>;
}
export interface PreparationMeasurementSummary {
  reportedChecksSatisfied: boolean;
  correctnessChecks: number;
  leafProcesses: number | null;
  workflowProcesses: number | null;
  workflowBlobProcesses: number | null;
  recordedWorkflowSubtotal: { processes: number; blobProcesses: number } | null;
  fixtureOwnedProcessGroups: number | null;
  workflows: PreparationMeasurementWorkflow[];
  diagnosticCodes: string[];
}

function invalid(): never { throw new Error('Invalid preparation measurement report'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
function sum(values: number[]): number {
  return values.reduce((total, value) => count(total + value), 0);
}
function workflow(input: unknown, index: number): PreparationMeasurementWorkflow {
  const row = object(input);
  exact(row, ['name', 'processes', 'blobProcesses', 'requests']);
  const name = index === 0 ? 'manager' : 'successor';
  if (row.name !== name || !Array.isArray(row.requests) || row.requests.length !== METHODS[name].length) invalid();
  const requests = row.requests.map((input, index) => {
    const request = object(input); exact(request, ['id', 'method', 'processes', 'blobProcesses']);
    if (request.id !== index + 1 || request.method !== METHODS[name][index]) invalid();
    const processes = count(request.processes), blobProcesses = count(request.blobProcesses);
    if (blobProcesses > processes || (index < (name === 'manager' ? 4 : 3) && processes === 0)) invalid();
    return { id: index + 1, method: request.method as string, processes, blobProcesses };
  });
  const processes = count(row.processes), blobProcesses = count(row.blobProcesses);
  if (processes !== sum(requests.map(row => row.processes)) || blobProcesses !== sum(requests.map(row => row.blobProcesses))) invalid();
  return { name, processes, blobProcesses, requests };
}

/** Installed workload JSON only; legacy pre-initialization envelopes are unsupported.
 * Does not attest its author, runtime, process settlement or score. */
export function parsePreparationMeasurementReport(input: string): PreparationMeasurementReport {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > 24 * 1024) invalid();
  let decoded: unknown;
  try { decoded = JSON.parse(input); } catch { invalid(); }
  const row = object(decoded);
  exact(row, ['schemaVersion', 'kind', 'workload', 'checksPassed', 'metrics', 'workflows', 'diagnostics']);
  if (row.schemaVersion !== 1 || row.kind !== 'preparation-verification-measurement' ||
    row.workload !== 'preparation-workflows-v1' || typeof row.checksPassed !== 'boolean' ||
    !Array.isArray(row.workflows) || row.workflows.length > 2 || !Array.isArray(row.diagnostics)) invalid();
  const workflows = row.workflows.map(workflow);
  const rawMetrics = object(row.metrics);
  const full = Object.keys(rawMetrics).length !== 1;
  exact(rawMetrics, full ? METRICS : ['correctness_checks']);
  const metrics = Object.fromEntries(Object.entries(rawMetrics).map(([key, value]) => [key, count(value)])) as PreparationMeasurementReport['metrics'];
  if (metrics.correctness_checks > 19 || (workflows.length >= 1 && metrics.correctness_checks < 15) ||
    (workflows.length === 2 && metrics.correctness_checks !== 19)) invalid();
  const diagnostics = row.diagnostics.map(input => {
    const diagnostic = object(input); exact(diagnostic, ['code', 'message']);
    if (typeof diagnostic.code !== 'string' || !REASONS.includes(diagnostic.code) ||
      typeof diagnostic.message !== 'string' || Buffer.byteLength(diagnostic.message, 'utf8') > 1024 ||
      [...diagnostic.message].some(character => {
        const code = character.charCodeAt(0); return code < 32 || code >= 127 && code <= 159;
      })) invalid();
    return { code: diagnostic.code, message: diagnostic.message };
  });
  if (row.checksPassed ? diagnostics.length !== 0 || !full : diagnostics.length !== 1) invalid();
  if (full) {
    if (metrics.correctness_checks !== 19 || workflows.length !== 2 ||
      (!row.checksPassed && diagnostics[0]?.code !== 'PROCESS_SETTLEMENT_UNCONFIRMED')) invalid();
    for (const key of LEAF) if (metrics[`${key}_processes`] === 0 || metrics[`${key}_blob_processes`] === 0 ||
      metrics[`${key}_blob_processes`]! > metrics[`${key}_processes`]!) invalid();
    if (metrics.verification_processes !== sum(LEAF.map(key => metrics[`${key}_processes`]!)) ||
      metrics.workflow_processes !== sum(workflows.map(row => row.processes)) ||
      metrics.workflow_blob_processes !== sum(workflows.map(row => row.blobProcesses))) invalid();
  }
  // Check subtotal overflow even when a failed report omits aggregate metrics.
  sum(workflows.map(row => row.processes)); sum(workflows.map(row => row.blobProcesses));
  return { schemaVersion: 1, kind: 'preparation-verification-measurement', workload: 'preparation-workflows-v1',
    checksPassed: row.checksPassed, metrics, workflows, diagnostics };
}

/** Missing emitted totals remain unknown; completed rows provide only a labelled subtotal. */
export function summarizePreparationMeasurementReport(report: PreparationMeasurementReport): PreparationMeasurementSummary {
  return { reportedChecksSatisfied: report.checksPassed, correctnessChecks: report.metrics.correctness_checks,
    leafProcesses: report.metrics.verification_processes ?? null,
    workflowProcesses: report.metrics.workflow_processes ?? null,
    workflowBlobProcesses: report.metrics.workflow_blob_processes ?? null,
    recordedWorkflowSubtotal: report.workflows.length ? {
      processes: sum(report.workflows.map(row => row.processes)), blobProcesses: sum(report.workflows.map(row => row.blobProcesses)),
    } : null,
    fixtureOwnedProcessGroups: report.metrics.fixture_owned_process_groups ?? null,
    workflows: report.workflows.map(row => ({ ...row, requests: row.requests.map(request => ({ ...request })) })),
    diagnosticCodes: report.diagnostics.map(row => row.code) };
}
