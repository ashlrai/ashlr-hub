/** Pure fixed scoring policy. The installed caller owns calibration provenance,
 * fresh filesystem/native proofs and confirmed process settlement before output.
 * This module performs no capture operations or filesystem reads. */
import { posix } from 'node:path';
import { types } from 'node:util';
import { canonical, digest, MAX_ARTIFACT_BYTES, MAX_ARTIFACT_ENTRIES } from './artifacts.js';
import { ownCaptureData } from './preparation-measurement-capture-store.js';
import { parsePreparationMeasurementCalibration, type PreparationMeasurementCalibration } from './preparation-measurement-calibration.js';
import { comparePreparationScenarioVectors, extractPreparationScenarioVector } from './preparation-measurement-comparison.js';
import { parsePreparationMeasurementReport } from './preparation-measurement-report.js';
import type { UniverseDiagnostic } from './types.js';

export const PREPARATION_PROCESS_SCORE_ID = 'preparation-process-score-v1';
const TARGET = 'src/core/resources/engineering-preparation.ts';
export interface PreparationProcessInventoryFile { path: string; executable: boolean; bytes: number; sha256: string }
export interface PreparationProcessInventory { digest: string; files: PreparationProcessInventoryFile[] }
export interface PreparationProcessEvaluation { passed: boolean; score: number; metrics: Record<string, number>; diagnostics?: UniverseDiagnostic[] }
const invalid = (): never => { throw new Error('Invalid preparation process scoring input'); };
function hash(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return invalid(); return value; }
function count(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalid(); return value; }
function array(value: unknown, maximum: number): unknown[] {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return invalid();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid();
    return descriptor.value;
  });
}
function filePath(value: unknown): string {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 4096 ||
      value.includes('\\') || [...value].some(character => {
        const code = character.charCodeAt(0); return code < 32 || code >= 127 && code <= 159;
      }) || posix.isAbsolute(value) || posix.normalize(value) !== value ||
      value.split('/').some(part => !part || ['.', '..', '.git', '.ashlr'].includes(part))) return invalid();
  return value;
}
function inventoryDigest(files: PreparationProcessInventoryFile[]): string {
  return digest(canonical(files.map(file => ({ path: file.path, executable: file.executable, size: file.bytes, digest: file.sha256 }))));
}
/** Validate full file inventory, not merely the declared mutable target. */
export function validatePreparationProcessInventory(input: unknown): PreparationProcessInventory {
  const value = ownCaptureData(input, ['digest', 'files']);
  const files = array(value.files, MAX_ARTIFACT_ENTRIES).map(input => {
    const row = ownCaptureData(input, ['path', 'executable', 'bytes', 'sha256']);
    if (typeof row.executable !== 'boolean') return invalid();
    return { path: filePath(row.path), executable: row.executable, bytes: count(row.bytes), sha256: hash(row.sha256) };
  });
  if (!files.length || files.reduce((total, file) => count(total + file.bytes), 0) > MAX_ARTIFACT_BYTES ||
      files.some((file, index) => index > 0 && files[index - 1]!.path.localeCompare(file.path) >= 0)) return invalid();
  const names = new Set(files.map(file => file.path));
  if (files.some(file => file.path.split('/').slice(0, -1).some((_part, index, parts) => names.has(parts.slice(0, index + 1).join('/'))))) return invalid();
  const actualDigest = inventoryDigest(files);
  if (actualDigest !== hash(value.digest)) return invalid();
  return { digest: actualDigest, files };
}
/** Summarize an already-read artifact snapshot; this helper never reads its path. */
export function summarizePreparationProcessArtifact(input: unknown): PreparationProcessInventory {
  const snapshot = ownCaptureData(input, ['digest', 'entries']);
  let bytes = 0;
  const files = array(snapshot.entries, MAX_ARTIFACT_ENTRIES).map(input => {
    const row = ownCaptureData(input, ['path', 'data', 'executable']);
    if (types.isProxy(row.data) || !Buffer.isBuffer(row.data) || typeof row.executable !== 'boolean') return invalid();
    bytes = count(bytes + row.data.length); if (bytes > MAX_ARTIFACT_BYTES) return invalid();
    return { path: filePath(row.path), executable: row.executable, bytes: row.data.length, sha256: digest(row.data) };
  }).sort((a, b) => a.path.localeCompare(b.path));
  return validatePreparationProcessInventory({ digest: snapshot.digest, files });
}
function workloadData(input: unknown) {
  const row = ownCaptureData(input, ['id', 'evaluatorId', 'digest', 'files', 'node', 'tools', 'git']);
  if (row.id !== 'preparation-workflows-v2' || row.evaluatorId !== 'preparation-measurement-v1') return invalid();
  const pin = (input: unknown) => {
    const row = ownCaptureData(input, ['path', 'sha256']);
    if (typeof row.path !== 'string' || Buffer.byteLength(row.path) > 4096) return invalid();
    return { path: row.path, sha256: hash(row.sha256) };
  };
  return { id: row.id, evaluatorId: row.evaluatorId, digest: hash(row.digest),
    files: array(row.files, 32).map(input => {
      const file = ownCaptureData(input, ['name', 'sha256']);
      if (typeof file.name !== 'string' || Buffer.byteLength(file.name) > 128) return invalid();
      return { name: file.name, sha256: hash(file.sha256) };
    }), node: pin(row.node), tools: array(row.tools, 16).map(pin), git: pin(row.git) };
}

function assertScope(calibration: PreparationMeasurementCalibration, inventory: PreparationProcessInventory): void {
  if (!inventory.files.some(file => file.path === TARGET) || inventory.files.length !== calibration.baseline.files.length || inventory.files.some((file, index) => {
    const baseline = calibration.baseline.files[index]!;
    return file.path !== baseline.path || file.executable !== baseline.executable || file.path !== TARGET && canonical(file) !== canonical(baseline);
  })) invalid();
}
/** Early pure scope refusal before the installed caller spends native work. */
export function assertPreparationProcessScope(calibrationJson: unknown, inventory: unknown): void {
  if (typeof calibrationJson !== 'string') return invalid();
  const calibration = parsePreparationMeasurementCalibration(calibrationJson);
  if (calibration.workload.id !== 'preparation-workflows-v2') return invalid();
  assertScope(calibration, validatePreparationProcessInventory(inventory));
}

/** Produces provisional Evaluation data, never authenticates caller claims.
 * Score is the integer sum of 15 measured regions: no setup/qualification costs
 * and no double-counting blob subtotals. Equality passes, but is not improvement. */
export function scorePreparationProcesses(input: unknown): PreparationProcessEvaluation {
  let reason = 'INPUT_INVALID';
  const refused = (): PreparationProcessEvaluation => ({ passed: false, score: 0, metrics: {},
    diagnostics: [{ code: `PREPARATION_SCORE_${reason}`, message: 'Fixed preparation scoring requirements were not satisfied.' }] });
  try {
    const options = ownCaptureData(input, ['calibrationJson', 'reportJson', 'workload', 'candidateBefore', 'candidateAfter']);
    if (typeof options.calibrationJson !== 'string' || typeof options.reportJson !== 'string') return refused();
    reason = 'CALIBRATION_INVALID';
    const calibration = parsePreparationMeasurementCalibration(options.calibrationJson);
    if (calibration.workload.id !== 'preparation-workflows-v2') return refused();
    reason = 'REPORT_INVALID';
    const report = parsePreparationMeasurementReport(options.reportJson);
    reason = 'QUALIFICATION_REQUIRED';
    if (report.workload !== 'preparation-workflows-v2' || !report.checksPassed || report.metrics.correctness_checks !== 23 ||
        report.qualifications?.length !== 2) return refused();
    const candidate = extractPreparationScenarioVector(options.reportJson);
    reason = 'WORKLOAD_MISMATCH';
    const workload = workloadData(options.workload);
    if (canonical(workload) !== canonical(calibration.workload)) return refused();
    reason = 'ARTIFACT_INVALID';
    const before = validatePreparationProcessInventory(options.candidateBefore), after = validatePreparationProcessInventory(options.candidateAfter);
    reason = 'ARTIFACT_CHANGED';
    if (canonical(before) !== canonical(after)) return refused();
    reason = 'SCOPE_MISMATCH';
    assertScope(calibration, before);
    // Identical baseline bytes must reproduce the three-run calibration vector;
    // count drift without a code change is not a candidate improvement.
    reason = 'BASELINE_DRIFT';
    if (before.digest === calibration.baseline.artifactDigest && canonical(candidate) !== canonical(calibration.scenarios)) return refused();
    reason = 'REGRESSION';
    const comparison = comparePreparationScenarioVectors(calibration.scenarios, candidate);
    if (comparison.regressions.length || comparison.processTotal.candidate === null) return refused();
    return { passed: true, score: comparison.processTotal.candidate, metrics: {
      preparation_processes: comparison.processTotal.candidate,
      baseline_processes: calibration.totalProcesses, candidate_processes: comparison.processTotal.candidate,
      process_delta: comparison.processTotal.delta!, improved: comparison.improved ? 1 : 0,
    } };
  } catch { return refused(); }
}
