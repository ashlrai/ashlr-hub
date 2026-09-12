/** Synthetic policy inputs only: no calibration provenance or native scoring claimed. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), snapshot: vi.fn() }));
vi.mock('../src/core/util/immutable-private-record-store.js', async original => ({ ...await original<object>(),
  readImmutablePrivateRecords: io.read, writeImmutablePrivateRecord: io.write }));
vi.mock('../src/core/universe/artifacts.js', async original => ({ ...await original<object>(), readArtifactSnapshot: io.snapshot }));
import { canonical, digest, MAX_ARTIFACT_BYTES } from '../src/core/universe/artifacts.js';
import { parseEvaluation } from '../src/core/universe/store.js';
import { PREPARATION_CALIBRATION_IMPLEMENTATION_FILES, parsePreparationMeasurementCalibration } from '../src/core/universe/preparation-measurement-calibration.js';
import { extractPreparationScenarioVector } from '../src/core/universe/preparation-measurement-comparison.js';
import { scorePreparationProcesses, summarizePreparationProcessArtifact, validatePreparationProcessInventory, assertPreparationProcessScope,
  type PreparationProcessInventory } from '../src/core/universe/preparation-process-score.js';
const TARGET = 'src/core/resources/engineering-preparation.ts';
function snapshot(source = 'baseline') {
  const entries = [{ path: 'README.md', data: Buffer.from('fixed'), executable: false },
    { path: TARGET, data: Buffer.from(source), executable: true }];
  return { entries, digest: digest(canonical(entries.map(row => ({ path: row.path, executable: row.executable,
    size: row.data.length, digest: digest(row.data) })))) };
}
function inventory(source = 'baseline') { return summarizePreparationProcessArtifact(snapshot(source)); }
function rehash(value: PreparationProcessInventory) {
  value.digest = digest(canonical(value.files.map(row => ({ path: row.path, executable: row.executable, size: row.bytes, digest: row.sha256 }))));
  return value;
}
function report() {
  const methods = [['manager-open', 'bundle', 'manager-check', 'manager-replay', 'manager-check', 'manager-replay', 'manager-close'],
    ['successor-check', 'successor-metadata', 'successor-bundle', 'successor-metadata']];
  const workflows = methods.map((methods, index) => ({ name: index ? 'successor' : 'manager', processes: methods.length * 10, blobProcesses: methods.length * 2,
    requests: methods.map((method, index) => ({ id: index + 1, method, processes: 10, blobProcesses: 2 })) }));
  const qualifications = ['runtime-drift', 'source-drift'].map((name, index) => ({ name, processes: 20, blobProcesses: 4, injections: 1,
    requests: [1, 2].map(id => ({ id, method: index ? 'successor-metadata' : 'metadata', processes: 10, blobProcesses: 2 })) }));
  return { schemaVersion: 1, kind: 'preparation-verification-measurement', workload: 'preparation-workflows-v2', checksPassed: true,
    workflows, qualifications, diagnostics: [] as Array<{ code: string; message: string }>, metrics: {
      correctness_checks: 23, verification_processes: 40, workflow_processes: 110, workflow_blob_processes: 22,
      fixture_owned_process_groups: 9, qualification_processes: 40, qualification_blob_processes: 8,
      ...Object.fromEntries(['files_1_check', 'files_1_metadata', 'files_4_check', 'files_4_metadata']
        .flatMap(key => [[`${key}_processes`, 10], [`${key}_blob_processes`, 2]])),
    } as Record<string, number> };
}
function fixture() {
  const baseline = inventory(), value = report();
  const git = { path: '/Library/Developer/CommandLineTools/usr/bin/git', sha256: digest('git') };
  const workload = { id: 'preparation-workflows-v2', evaluatorId: 'preparation-measurement-v1', digest: digest('installed'),
    files: PREPARATION_CALIBRATION_IMPLEMENTATION_FILES.map(name => ({ name, sha256: digest(name) })),
    node: { path: '/private/node', sha256: digest('node') }, tools: [git], git };
  const calibration = { schemaVersion: 1, kind: 'preparation-measurement-calibration', scope: 'diagnostic-only', universeId: 'baseline',
    manifestDigest: digest('manifest'), comparatorDigest: digest('comparator'), workload,
    baseline: { artifactDigest: baseline.digest, revision: 'a'.repeat(40), source: { path: TARGET, sha256: digest('baseline') }, files: baseline.files },
    provenance: ['a', 'b', 'c'].map(id => ({ captureId: id, intentDigest: digest(`${id} intent`), receiptDigest: digest(`${id} receipt`),
      reportDigest: digest(JSON.stringify(value)), reportBytes: Buffer.byteLength(JSON.stringify(value)),
      startedAt: '2026-09-12T00:00:00.000Z', finishedAt: '2026-09-12T00:00:01.000Z' })),
    scenarios: extractPreparationScenarioVector(JSON.stringify(value)), totalProcesses: 150 };
  const request = { calibrationJson: JSON.stringify(calibration), reportJson: JSON.stringify(value), workload: structuredClone(workload),
    candidateBefore: inventory('candidate'), candidateAfter: inventory('candidate') };
  expect(parsePreparationMeasurementCalibration(request.calibrationJson).totalProcesses).toBe(150);
  return { request, calibration, report: value };
}
function failed(value: unknown) {
  const result = scorePreparationProcesses(value);
  expect(result).toMatchObject({ passed: false, score: 0, metrics: {}, diagnostics: [{ message: 'Fixed preparation scoring requirements were not satisfied.' }] });
  expect(result.diagnostics).toHaveLength(1);
  expect(parseEvaluation(JSON.stringify(result))).toEqual(result);
  return result;
}
beforeEach(() => { vi.clearAllMocks(); });
describe('fixed preparation process scoring policy', () => {
  it('passes baseline equality without claiming improvement and excludes qualification/setup/blob double counts', () => {
    const f = fixture(); f.request.candidateBefore = inventory(); f.request.candidateAfter = inventory();
    const result = scorePreparationProcesses(f.request);
    expect(result).toEqual({ passed: true, score: 150, metrics: { preparation_processes: 150, baseline_processes: 150,
      candidate_processes: 150, process_delta: 0, improved: 0 } });
    expect(parseEvaluation(JSON.stringify(result))).toEqual(result);
    expect(io.read).not.toHaveBeenCalled(); expect(io.write).not.toHaveBeenCalled(); expect(io.snapshot).not.toHaveBeenCalled();
  });
  it('passes a target-only improvement', () => {
    const f = fixture(); f.report.metrics.files_4_check_processes -= 3; f.report.metrics.verification_processes -= 3;
    f.request.reportJson = JSON.stringify(f.report);
    expect(scorePreparationProcesses(f.request)).toMatchObject({ passed: true, score: 147, metrics: { preparation_processes: 147, improved: 1 } });
  });
  it.each(['fewer-processes', 'more-processes', 'fewer-blobs', 'more-blobs', 'same-total'])('refuses unchanged baseline %s vector drift', kind => {
    const f = fixture(); f.request.candidateBefore = inventory(); f.request.candidateAfter = inventory();
    if (kind === 'fewer-processes') { f.report.metrics.files_4_check_processes -= 3; f.report.metrics.verification_processes -= 3; }
    if (kind === 'more-processes') { f.report.metrics.files_4_check_processes++; f.report.metrics.verification_processes++; }
    if (kind === 'fewer-blobs') f.report.metrics.files_4_check_blob_processes--;
    if (kind === 'more-blobs') f.report.metrics.files_4_check_blob_processes++;
    if (kind === 'same-total') { f.report.metrics.files_4_check_processes--; f.report.metrics.files_4_metadata_processes++; }
    f.request.reportJson = JSON.stringify(f.report);
    // Prove these are complete valid reports, not generic malformed refusals.
    expect(extractPreparationScenarioVector(f.request.reportJson)).toHaveLength(15);
    expect(failed(f.request).diagnostics![0]!.code).toBe('PREPARATION_SCORE_BASELINE_DRIFT');
  });
  it.each([[0, 'processes'], [0, 'blobProcesses'], [1, 'processes'], [1, 'blobProcesses']] as const)(
    'refuses unchanged baseline workflow%s %s savings with internally consistent totals', (index, field) => {
      const f = fixture(); f.request.candidateBefore = inventory(); f.request.candidateAfter = inventory();
      const workflow = f.report.workflows[index]!;
      workflow.requests[0]![field]--; workflow[field]--;
      f.report.metrics[field === 'processes' ? 'workflow_processes' : 'workflow_blob_processes']--;
      f.request.reportJson = JSON.stringify(f.report);
      expect(extractPreparationScenarioVector(f.request.reportJson)).toHaveLength(15);
      expect(failed(f.request).diagnostics![0]!.code).toBe('PREPARATION_SCORE_BASELINE_DRIFT');
    });
  it.each(Array.from({ length: 15 }, (_, index) => index))('refuses process regression in region%s despite aggregate savings', index => {
    const f = fixture();
    // Increase baseline in a different region to create a lower aggregate candidate.
    f.calibration.scenarios[(index + 1) % 15]!.processes += 20; f.calibration.totalProcesses += 20;
    f.calibration.scenarios[index]!.processes = 9;
    f.calibration.totalProcesses--;
    f.request.calibrationJson = JSON.stringify(f.calibration);
    expect(failed(f.request).diagnostics![0]!.code).toBe('PREPARATION_SCORE_REGRESSION');
  });
  it.each(Array.from({ length: 15 }, (_, index) => index))('refuses blob regression in region%s independently of total launches', index => {
    const f = fixture(); f.calibration.scenarios[index]!.blobProcesses = 1;
    f.request.calibrationJson = JSON.stringify(f.calibration);
    expect(failed(f.request).diagnostics![0]!.code).toBe('PREPARATION_SCORE_REGRESSION');
  });
  it.each(['partial', 'failed', 'missing-pair', 'reordered-pairs', 'zero-injection', 'bad-method', 'wrong-total', 'overflow', 'v1'])(
    'refuses %s diagnostic evidence', kind => {
      const f = fixture();
      if (kind === 'partial') { f.report.metrics = { correctness_checks: 19 }; f.report.qualifications = []; f.report.checksPassed = false;
        f.report.diagnostics = [{ code: 'CANDIDATE_QUALIFICATION_FAILED', message: 'Refused' }]; }
      if (kind === 'failed') { f.report.checksPassed = false; f.report.diagnostics = [{ code: 'PROCESS_SETTLEMENT_UNCONFIRMED', message: 'Unconfirmed' }]; }
      if (kind === 'missing-pair') f.report.qualifications.pop();
      if (kind === 'reordered-pairs') f.report.qualifications.reverse();
      if (kind === 'zero-injection') f.report.qualifications[0]!.injections = 0;
      if (kind === 'bad-method') f.report.qualifications[0]!.requests[1]!.method = 'check';
      if (kind === 'wrong-total') f.report.metrics.workflow_processes++;
      if (kind === 'overflow') { f.report.metrics.files_1_check_processes = Number.MAX_SAFE_INTEGER; f.report.metrics.files_4_check_processes = Number.MAX_SAFE_INTEGER; }
      if (kind === 'v1') f.report.workload = 'preparation-workflows-v1';
      f.request.reportJson = JSON.stringify(f.report); failed(f.request);
    });
  it.each(['aggregate', 'file', 'node', 'git', 'tool', 'version'])('refuses current %s workload drift', kind => {
    const f = fixture();
    if (kind === 'aggregate') f.request.workload.digest = digest('changed');
    if (kind === 'file') f.request.workload.files[0]!.sha256 = digest('changed');
    if (kind === 'node') f.request.workload.node.sha256 = digest('changed');
    if (kind === 'git') f.request.workload.git.sha256 = digest('changed');
    if (kind === 'tool') f.request.workload.tools[0]!.path = '/other/tool';
    if (kind === 'version') f.request.workload.id = 'preparation-workflows-v1';
    expect(failed(f.request).diagnostics![0]!.code).toBe('PREPARATION_SCORE_WORKLOAD_MISMATCH');
  });
  it.each(['extra-file', 'missing-file', 'support-content', 'support-mode', 'target-mode', 'changed-during-run'])(
    'refuses %s artifact scope', kind => {
      const f = fixture(), before = f.request.candidateBefore;
      if (kind === 'extra-file') before.files.push({ path: 'zzz', executable: false, bytes: 1, sha256: digest('z') });
      if (kind === 'missing-file') before.files.shift();
      if (kind === 'support-content') before.files[0]!.sha256 = digest('other');
      if (kind === 'support-mode') before.files[0]!.executable = true;
      if (kind === 'target-mode') before.files[1]!.executable = false;
      rehash(before); f.request.candidateAfter = structuredClone(before);
      if (kind === 'changed-during-run') f.request.candidateAfter = inventory('later');
      failed(f.request);
    });
  it.each(['invalid-json', 'v1', 'missing-provenance', 'wrong-total', 'wrong-inventory-digest', 'oversized'])(
    'refuses %s calibration', kind => {
      const f = fixture();
      if (kind === 'v1') f.calibration.workload.id = 'preparation-workflows-v1';
      if (kind === 'missing-provenance') f.calibration.provenance.pop();
      if (kind === 'wrong-total') f.calibration.totalProcesses++;
      if (kind === 'wrong-inventory-digest') f.calibration.baseline.artifactDigest = digest('wrong');
      f.request.calibrationJson = kind === 'invalid-json' ? 'invalid private text' : kind === 'oversized' ? ' '.repeat(2 * 1024 * 1024 + 1) : JSON.stringify(f.calibration);
      failed(f.request);
    });
  it('rejects accessors, toJSON, proxies and revoked proxies without invoking caller code or leaking errors', () => {
    const f = fixture(), getter = vi.fn(() => { throw new Error('/private/secret'); });
    const value = { ...f.request }; Object.defineProperty(value, 'reportJson', { get: getter }); failed(value);
    failed({ ...f.request, toJSON: getter }); failed(new Proxy(f.request, { get: getter }));
    const revoked = Proxy.revocable(f.request, {}); revoked.revoke(); failed(revoked.proxy);
    Object.defineProperty(f.request.workload.files[0]!, 'name', { get: getter }); failed(f.request);
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('pure preparation inventory summary', () => {
  it('checks complete target-only scope before dispatch without reading a report or filesystem', () => {
    const f = fixture();
    expect(() => assertPreparationProcessScope(f.request.calibrationJson, f.request.candidateBefore)).not.toThrow();
    f.request.candidateBefore.files[0]!.sha256 = digest('different support file'); rehash(f.request.candidateBefore);
    expect(() => assertPreparationProcessScope(f.request.calibrationJson, f.request.candidateBefore)).toThrow();
    expect(io.read).not.toHaveBeenCalled(); expect(io.write).not.toHaveBeenCalled(); expect(io.snapshot).not.toHaveBeenCalled();
  });
  it.each(['calibration', 'v1', 'inventory', 'mode'])('fails early on invalid scope %s', kind => {
    const f = fixture();
    if (kind === 'calibration') f.request.calibrationJson = 'not-json';
    if (kind === 'v1') { f.calibration.workload.id = 'preparation-workflows-v1'; f.request.calibrationJson = JSON.stringify(f.calibration); }
    if (kind === 'inventory') f.request.candidateBefore.digest = digest('wrong');
    if (kind === 'mode') { f.request.candidateBefore.files[1]!.executable = false; rehash(f.request.candidateBefore); }
    expect(() => assertPreparationProcessScope(f.request.calibrationJson, f.request.candidateBefore)).toThrow();
  });
  it('matches existing artifact digest without reading files and returns detached data', () => {
    const raw = snapshot(), value = summarizePreparationProcessArtifact(raw);
    expect(value.digest).toBe(raw.digest); expect(value.files[1]!.sha256).toBe(digest('baseline'));
    value.files[1]!.path = 'changed'; expect(raw.entries[1]!.path).toBe(TARGET);
    expect(io.snapshot).not.toHaveBeenCalled();
  });
  it.each(['hash', 'duplicate', 'unsorted', 'traversal', 'absolute', 'git', 'backslash', 'ancestor-file', 'size', 'sparse', 'extra', 'symbol', 'nonfinite'])(
    'rejects %s inventory corruption', kind => {
      const value = inventory();
      if (kind === 'hash') value.digest = digest('bad');
      if (kind === 'duplicate') value.files[1] = { ...value.files[0]! };
      if (kind === 'unsorted') value.files.reverse();
      if (kind === 'traversal') value.files[0]!.path = '../outside';
      if (kind === 'absolute') value.files[0]!.path = '/outside';
      if (kind === 'git') value.files[0]!.path = '.git/config';
      if (kind === 'backslash') value.files[0]!.path = 'a\\b';
      if (kind === 'ancestor-file') value.files[0]!.path = 'src';
      if (kind === 'size') value.files[0]!.bytes = MAX_ARTIFACT_BYTES + 1;
      if (kind === 'sparse') delete value.files[0];
      if (kind === 'extra') Object.assign(value.files[0]!, { extra: true });
      if (kind === 'symbol') Object.assign(value, { [Symbol('extra')]: true });
      if (kind === 'nonfinite') value.files[0]!.bytes = Infinity;
      if (kind !== 'hash' && kind !== 'sparse') rehash(value);
      expect(() => validatePreparationProcessInventory(value)).toThrow();
    });
});
