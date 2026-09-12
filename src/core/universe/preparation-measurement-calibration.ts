import { isAbsolute, posix, resolve } from 'node:path';
import { types } from 'node:util';
import { canonical, digest, MAX_ARTIFACT_BYTES, MAX_ARTIFACT_ENTRIES, readArtifactSnapshot } from './artifacts.js';
import { ownCaptureData, preparationCaptureDirectory, projectPreparationCapture, readPreparationCaptureRecords,
  validatePreparationMeasurementCaptureRequest } from './preparation-measurement-capture-store.js';
import { extractPreparationScenarioVector, PREPARATION_SCENARIO_KEYS } from './preparation-measurement-comparison.js';
import type { PreparationMeasurementCaptureIntent } from './preparation-measurement-capture-types.js';
import { parsePreparationMeasurementReport, type PreparationMeasurementWorkload } from './preparation-measurement-report.js';

const TARGET = 'src/core/resources/engineering-preparation.ts';
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const MAX_PREPARATION_CALIBRATION_BYTES = 2 * 1024 * 1024;
export const PREPARATION_CALIBRATION_IMPLEMENTATION_FILES = Object.freeze(['preparation-bridge.mjs', 'preparation-verification-activity.mjs',
  'preparation-verification-child.mjs', 'preparation-verification-controller.mjs', 'preparation-verification-fixtures.mjs',
  'preparation-verification-native.mjs', 'preparation-verification-protocol.mjs', 'preparation-verification-tool.mjs',
  'preparation-verification.mjs'] as const);
export interface PreparationMeasurementCalibrationRequest {
  root: string; universeId: string; captureIds: [string, string, string]; expectedSourceDigest: string;
}
export interface PreparationCalibrationPin { path: string; sha256: string }
export interface PreparationCalibrationScenario { key: string; processes: number; blobProcesses: number }
export interface PreparationMeasurementCalibration {
  schemaVersion: 1; kind: 'preparation-measurement-calibration'; scope: 'diagnostic-only';
  universeId: string; manifestDigest: string; comparatorDigest: string;
  baseline: { artifactDigest: string; revision: string; source: PreparationCalibrationPin;
    files: Array<{ path: string; executable: boolean; bytes: number; sha256: string }> };
  workload: { id: PreparationMeasurementWorkload; evaluatorId: 'preparation-measurement-v1'; digest: string;
    files: Array<{ name: string; sha256: string }>; node: PreparationCalibrationPin;
    tools: PreparationCalibrationPin[]; git: PreparationCalibrationPin };
  provenance: Array<{ captureId: string; intentDigest: string; receiptDigest: string; reportDigest: string;
    reportBytes: number; startedAt: string; finishedAt: string }>;
  scenarios: PreparationCalibrationScenario[];
  totalProcesses: number;
}

/** Normalize verified capture pins without carrying installed bundle directory locations. */
export function preparationCalibrationWorkload(input: PreparationMeasurementCaptureIntent['evaluator'],
  version: PreparationMeasurementWorkload = 'preparation-workflows-v1'): PreparationMeasurementCalibration['workload'] {
  if (version !== 'preparation-workflows-v1' && version !== 'preparation-workflows-v2') return fail();
  const evaluator = own(input, ['id', 'digest', 'executableDigest', 'command', 'files', 'tools', 'git']);
  if (evaluator.id !== 'preparation-measurement-v1') return fail();
  const command = list(evaluator.command, 8).map(text);
  const normalizePin = (input: unknown) => { const value = own(input, ['path', 'digest']); return pin({ path: value.path, sha256: value.digest }); };
  const files = list(evaluator.files, 32).map(input => {
    const file = own(input, ['name', 'path', 'digest']); const path = text(file.path);
    if (!isAbsolute(path) || resolve(path) !== path) return fail();
    return { name: text(file.name), path, sha256: hash(file.digest) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  if (canonical(files.map(file => file.name)) !== canonical(PREPARATION_CALIBRATION_IMPLEMENTATION_FILES)) return fail();
  // The aggregate registry digest binds code/native bytes, not caller argv.
  // Check the installed command contract before dropping relocation-only paths.
  if (command.length !== 5 || command[1] !== '--experimental-vm-modules' || command[2] !== '--no-warnings' ||
    command[3] !== files.find(file => file.name === 'preparation-verification.mjs')!.path ||
    command[4] !== files.find(file => file.name === 'preparation-bridge.mjs')!.path) return fail();
  return { id: version, evaluatorId: 'preparation-measurement-v1', digest: hash(evaluator.digest),
    files: files.map(({ name, sha256 }) => ({ name, sha256 })),
    node: pin({ path: command[0], sha256: evaluator.executableDigest }),
    tools: list(evaluator.tools, 16).map(normalizePin).sort((a, b) => a.path.localeCompare(b.path)), git: normalizePin(evaluator.git) };
}
const fail = (): never => { throw new Error('Preparation measurement calibration unavailable or invalid'); };
function own(value: unknown, keys: string[]): Record<string, unknown> {
  try { return ownCaptureData(value, keys); } catch { return fail(); }
}
function list(value: unknown, maximum: number): unknown[] {
  if (types.isProxy(value) || !Array.isArray(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return fail();
  return Array.from({ length: value.length }, (_, index) => {
    const property = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (!property?.enumerable || !Object.hasOwn(property, 'value')) return fail();
    return property.value;
  });
}
function hash(value: unknown): string { if (typeof value !== 'string' || !HASH.test(value)) return fail(); return value; }
function count(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fail(); return value; }
function sum(values: number[]): number { return values.reduce((total, value) => count(total + value), 0); }
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 4096 || [...value].some(character => {
    const code = character.charCodeAt(0); return code < 32 || code >= 127 && code <= 159;
  })) return fail();
  return value;
}
function timestamp(value: unknown): string {
  const result = text(value);
  if (result.length !== 24 || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) return fail();
  return result;
}
function pin(value: unknown): PreparationCalibrationPin {
  const row = own(value, ['path', 'sha256']); const path = text(row.path);
  if (!isAbsolute(path) || resolve(path) !== path) return fail();
  return { path, sha256: hash(row.sha256) };
}
function ordered(values: string[]): void {
  if (new Set(values).size !== values.length || values.some((value, index) => index > 0 && values[index - 1]!.localeCompare(value) >= 0)) fail();
}

/** Pure schema/integrity validation; parsing is not proof that a descriptor was authored by this host. */
export function parsePreparationMeasurementCalibration(input: string): PreparationMeasurementCalibration {
  if (typeof input !== 'string' || Buffer.byteLength(input) > MAX_PREPARATION_CALIBRATION_BYTES) return fail();
  let decoded: unknown; try { decoded = JSON.parse(input); } catch { return fail(); }
  const row = own(decoded, ['schemaVersion', 'kind', 'scope', 'universeId', 'manifestDigest', 'comparatorDigest',
    'baseline', 'workload', 'provenance', 'scenarios', 'totalProcesses']);
  if (row.schemaVersion !== 1 || row.kind !== 'preparation-measurement-calibration' || row.scope !== 'diagnostic-only' ||
    typeof row.universeId !== 'string' || !ID.test(row.universeId)) return fail();
  const baseline = own(row.baseline, ['artifactDigest', 'revision', 'source', 'files']);
  const source = own(baseline.source, ['path', 'sha256']);
  if (source.path !== TARGET || typeof baseline.revision !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseline.revision)) return fail();
  const files = list(baseline.files, MAX_ARTIFACT_ENTRIES).map(input => {
    const file = own(input, ['path', 'executable', 'bytes', 'sha256']), path = text(file.path);
    if (posix.isAbsolute(path) || path.includes('\\') || posix.normalize(path) !== path || path.split('/').some(part => !part || ['..', '.', '.git', '.ashlr'].includes(part)) ||
      typeof file.executable !== 'boolean') return fail();
    return { path, executable: file.executable, bytes: count(file.bytes), sha256: hash(file.sha256) };
  });
  ordered(files.map(file => file.path));
  if (!files.length || sum(files.map(file => file.bytes)) > MAX_ARTIFACT_BYTES ||
    files.find(file => file.path === TARGET)?.sha256 !== hash(source.sha256) ||
    digest(canonical(files.map(file => ({ path: file.path, executable: file.executable, size: file.bytes, digest: file.sha256 })))) !== hash(baseline.artifactDigest)) return fail();
  const workload = own(row.workload, ['id', 'evaluatorId', 'digest', 'files', 'node', 'tools', 'git']);
  if ((workload.id !== 'preparation-workflows-v1' && workload.id !== 'preparation-workflows-v2') || workload.evaluatorId !== 'preparation-measurement-v1') return fail();
  const implementation = list(workload.files, 32).map(input => {
    const file = own(input, ['name', 'sha256']);
    if (typeof file.name !== 'string' || !/^[a-z0-9-]+\.mjs$/.test(file.name)) return fail();
    return { name: file.name, sha256: hash(file.sha256) };
  });
  ordered(implementation.map(file => file.name));
  if (canonical(implementation.map(file => file.name)) !== canonical(PREPARATION_CALIBRATION_IMPLEMENTATION_FILES)) return fail();
  const tools = list(workload.tools, 16).map(pin), git = pin(workload.git); ordered(tools.map(tool => tool.path));
  if (!implementation.length || !tools.some(tool => canonical(tool) === canonical(git))) return fail();
  const provenance = list(row.provenance, 3).map(input => {
    const item = own(input, ['captureId', 'intentDigest', 'receiptDigest', 'reportDigest', 'reportBytes', 'startedAt', 'finishedAt']);
    if (typeof item.captureId !== 'string' || !ID.test(item.captureId)) return fail();
    const startedAt = timestamp(item.startedAt), finishedAt = timestamp(item.finishedAt), reportBytes = count(item.reportBytes);
    if (finishedAt < startedAt || reportBytes < 1 || reportBytes > 24 * 1024) return fail();
    return { captureId: item.captureId, intentDigest: hash(item.intentDigest), receiptDigest: hash(item.receiptDigest),
      reportDigest: hash(item.reportDigest), reportBytes, startedAt, finishedAt };
  });
  ordered(provenance.map(item => item.captureId));
  if (provenance.length !== 3 || new Set(provenance.map(item => item.intentDigest)).size !== 3 ||
    new Set(provenance.map(item => item.receiptDigest)).size !== 3) return fail();
  const scenarios = list(row.scenarios, 15).map((input, index) => {
    const item = own(input, ['key', 'processes', 'blobProcesses']);
    if (item.key !== PREPARATION_SCENARIO_KEYS[index]) return fail();
    const processes = count(item.processes), blobProcesses = count(item.blobProcesses);
    if (blobProcesses > processes || (index < 4 && (!processes || !blobProcesses)) ||
      ([4, 5, 6, 7, 11, 12, 13].includes(index) && !processes)) return fail();
    return { key: item.key as string, processes, blobProcesses };
  });
  if (scenarios.length !== 15 || count(row.totalProcesses) !== sum(scenarios.map(item => item.processes))) return fail();
  return { schemaVersion: 1, kind: 'preparation-measurement-calibration', scope: 'diagnostic-only', universeId: row.universeId,
    manifestDigest: hash(row.manifestDigest), comparatorDigest: hash(row.comparatorDigest),
    baseline: { artifactDigest: hash(baseline.artifactDigest), revision: baseline.revision, source: { path: TARGET, sha256: hash(source.sha256) }, files },
    workload: { id: workload.id, evaluatorId: 'preparation-measurement-v1', digest: hash(workload.digest),
      files: implementation, node: pin(workload.node), tools, git }, provenance, scenarios, totalProcesses: count(row.totalProcesses) };
}

/** Three historical capture attempts, not three reads/replays and not accepted optimization evidence. */
export function calibratePreparationMeasurements(input: PreparationMeasurementCalibrationRequest): PreparationMeasurementCalibration {
  const value = own(input, ['root', 'universeId', 'captureIds', 'expectedSourceDigest']);
  const ids = list(value.captureIds, 3);
  if (ids.length !== 3 || new Set(ids).size !== 3) return fail();
  const expectedSourceDigest = hash(value.expectedSourceDigest);
  const requests = ids.map(captureId => validatePreparationMeasurementCaptureRequest({ root: value.root, universeId: value.universeId, captureId }));
  const directory = preparationCaptureDirectory(requests[0]!);
  const records = readPreparationCaptureRecords(directory);
  const selected = requests.map(request => {
    const capture = projectPreparationCapture(records, request.captureId), { intent, receipt } = capture;
    if (!intent || !receipt || capture.state !== 'recorded' || receipt.outcome !== 'captured' || receipt.reason !== null ||
      !receipt.identityVerified || receipt.processGroupSettlement !== 'group-exit-confirmed' || !receipt.report?.checksPassed) return fail();
    const scenarios = extractPreparationScenarioVector(receipt.report.stdout);
    const version = parsePreparationMeasurementReport(receipt.report.stdout).workload;
    return { intent, receipt, report: receipt.report, scenarios, version };
  });
  const first = selected[0]!;
  const identity = (item: typeof first) => ({ manifestDigest: item.intent.manifestDigest, comparatorDigest: item.intent.comparatorDigest,
    artifact: item.intent.artifact, evaluator: item.intent.evaluator });
  if (selected.some(item => item.version !== first.version || canonical(identity(item)) !== canonical(identity(first)) || canonical(item.scenarios) !== canonical(first.scenarios))) return fail();
  const snapshot = readArtifactSnapshot(first.intent.artifact.path);
  const target = snapshot.entries.find(entry => entry.path === TARGET);
  if (snapshot.digest !== first.intent.artifact.digest || !target || digest(target.data) !== expectedSourceDigest) return fail();
  // Read again after the bounded artifact walk: do not combine two different journal observations.
  if (canonical(readPreparationCaptureRecords(directory)) !== canonical(records)) return fail();
  const descriptor: PreparationMeasurementCalibration = { schemaVersion: 1, kind: 'preparation-measurement-calibration', scope: 'diagnostic-only',
    universeId: first.intent.universeId, manifestDigest: first.intent.manifestDigest, comparatorDigest: first.intent.comparatorDigest,
    baseline: { artifactDigest: snapshot.digest, revision: first.intent.artifact.revision,
      source: { path: TARGET, sha256: expectedSourceDigest }, files: snapshot.entries.map(entry => ({ path: entry.path,
        executable: entry.executable, bytes: entry.data.length, sha256: digest(entry.data) })).sort((a, b) => a.path.localeCompare(b.path)) },
    workload: preparationCalibrationWorkload(first.intent.evaluator, first.version),
    provenance: selected.map(item => ({ captureId: item.intent.captureId, intentDigest: digest(canonical(item.intent)),
      receiptDigest: digest(canonical(item.receipt)), reportDigest: item.report.sha256, reportBytes: item.report.bytes,
      startedAt: item.intent.startedAt, finishedAt: item.receipt.finishedAt })).sort((a, b) => a.captureId.localeCompare(b.captureId)),
    scenarios: first.scenarios, totalProcesses: sum(first.scenarios.map(item => item.processes)) };
  return parsePreparationMeasurementCalibration(canonical(descriptor));
}
