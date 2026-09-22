/** Real private files and custody decoder; journal contents are synthetic, not native measurement evidence. */
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreparationMeasurementCaptureIntent, PreparationMeasurementCaptureReceipt } from '../src/core/universe/preparation-measurement-capture-types.js';

const interception = vi.hoisted(() => ({ afterSnapshot: undefined as undefined | (() => void) }));
vi.mock('../src/core/universe/artifacts.js', async original => {
  const actual = await original<typeof import('../src/core/universe/artifacts.js')>();
  return { ...actual, readArtifactSnapshot: (...args: Parameters<typeof actual.readArtifactSnapshot>) => {
    const value = actual.readArtifactSnapshot(...args);
    const effect = interception.afterSnapshot;
    interception.afterSnapshot = undefined;
    effect?.();
    return value;
  } };
});

import { canonical, digest, readArtifactSnapshot } from '../src/core/universe/artifacts.js';
import { calibratePreparationMeasurements, PREPARATION_CALIBRATION_IMPLEMENTATION_FILES } from '../src/core/universe/preparation-measurement-calibration.js';
import { compareCapturedPreparationMeasurement } from '../src/core/universe/preparation-measurement-candidate-comparison.js';
import { writePreparationCaptureRecord } from '../src/core/universe/preparation-measurement-capture-store.js';
import { cmdUniversePreparationMeasurementCalibrate } from '../src/cli/universe-preparation-measurement-calibrate.js';
import { cmdUniversePreparationMeasurementCompare } from '../src/cli/universe-preparation-measurement-compare.js';

const TARGET = 'src/core/resources/engineering-preparation.ts';
const METHODS = { manager: ['manager-open', 'bundle', 'manager-check', 'manager-replay', 'manager-check', 'manager-replay', 'manager-close'],
  successor: ['successor-check', 'successor-metadata', 'successor-bundle', 'successor-metadata'] };
let root: string;
const privateDir = (path: string) => mkdirSync(path, { recursive: true, mode: 0o700 });
function report(delta = 0, version: 1 | 2 = 1): string {
  const workflows = Object.entries(METHODS).map(([name, methods]) => ({ name, processes: methods.length * 10, blobProcesses: methods.length * 2,
    requests: methods.map((method, index) => ({ id: index + 1, method, processes: 10, blobProcesses: 2 })) }));
  const qualifications = ['runtime-drift', 'source-drift'].map((name, index) => ({ name, processes: 20, blobProcesses: 4,
    injections: 1, requests: [1, 2].map(id => ({ id, method: index ? 'successor-metadata' : 'metadata', processes: 10, blobProcesses: 2 })) }));
  return canonical({ schemaVersion: 1, kind: 'preparation-verification-measurement', workload: `preparation-workflows-v${version}`, checksPassed: true,
    ...(version === 2 ? { qualifications } : {}),
    metrics: { correctness_checks: version === 2 ? 23 : 19, files_1_check_processes: 10 + delta, files_1_check_blob_processes: 2,
      files_1_metadata_processes: 10, files_1_metadata_blob_processes: 2, files_4_check_processes: 10, files_4_check_blob_processes: 2,
      files_4_metadata_processes: 10, files_4_metadata_blob_processes: 2, verification_processes: 40 + delta,
      workflow_processes: 110, workflow_blob_processes: 22, fixture_owned_process_groups: 7,
      ...(version === 2 ? { qualification_processes: 40, qualification_blob_processes: 8 } : {}) }, workflows, diagnostics: [] });
}
function evaluator(): PreparationMeasurementCaptureIntent['evaluator'] {
  const git = { path: '/Library/Developer/CommandLineTools/usr/bin/git', digest: digest('git') };
  return { id: 'preparation-measurement-v1', digest: digest('installed aggregate'), executableDigest: digest('node'),
    command: ['/private/node', '--experimental-vm-modules', '--no-warnings', '/private/installed/preparation-verification.mjs', '/private/installed/preparation-bridge.mjs'],
    files: PREPARATION_CALIBRATION_IMPLEMENTATION_FILES.map(name => ({ name, path: `/private/installed/${name}`, digest: digest(name) })),
    tools: [git, ...['/bin/ls', '/bin/ps', '/usr/bin/sandbox-exec'].map(path => ({ path, digest: digest(path) }))], git };
}
function writeCapture(universeId: string, captureId: string, delta = 0, actualWriter = false, version: 1 | 2 = 1) {
  const directory = join(root, 'universes', universeId), seed = join(directory, 'seed');
  const records = join(directory, 'preparation-measurements', 'records'); privateDir(records);
  privateDir(join(directory, 'preparation-measurements', 'staging'));
  const intent: PreparationMeasurementCaptureIntent = { schemaVersion: 1, captureId, universeId,
    startedAt: '2026-09-12T12:00:00.000Z', deadlineAt: '2026-09-12T12:01:00.000Z', timeoutMs: 60000,
    manifestDigest: digest(`${universeId} manifest`), comparatorDigest: digest(`${universeId} comparator`),
    artifact: { path: seed, digest: readArtifactSnapshot(seed).digest, revision: 'a'.repeat(40) }, evaluator: evaluator() };
  const stdout = report(delta, version);
  const receipt: PreparationMeasurementCaptureReceipt = { schemaVersion: 1, intentDigest: digest(canonical(intent)),
    finishedAt: '2026-09-12T12:00:10.000Z', durationMs: 10000, outcome: 'captured', reason: null,
    processGroupSettlement: 'group-exit-confirmed', identityVerified: true,
    report: { stdout, sha256: digest(stdout), bytes: Buffer.byteLength(stdout), checksPassed: true } };
  let published = false;
  const save = () => {
    const intentRow = { id: `${captureId}.intent`, kind: 'intent' as const, intent, receipt: null };
    const receiptRow = { id: `${captureId}.receipt`, kind: 'receipt' as const, intent, receipt };
    if (!published && actualWriter) {
      // Real immutable publication for initial synthetic evidence. Later writes
      // deliberately simulate corrupted or different historical fixture inputs.
      writePreparationCaptureRecord(directory, intentRow, () => undefined);
      writePreparationCaptureRecord(directory, receiptRow, () => undefined);
      published = true;
    } else {
      writeFileSync(join(records, `${captureId}.intent.json`), `${canonical(intentRow)}\n`, { mode: 0o600 });
      writeFileSync(join(records, `${captureId}.receipt.json`), `${canonical(receiptRow)}\n`, { mode: 0o600 });
    }
  };
  save();
  return { intent, receipt, save, directory, seed, records };
}
function seed(id: string, source = 'baseline', extra = 'unchanged') {
  const path = join(root, 'universes', id, 'seed'); privateDir(join(path, dirname(TARGET)));
  writeFileSync(join(path, TARGET), source, { mode: 0o600 });
  writeFileSync(join(path, 'fixed.txt'), extra, { mode: 0o600 });
  return path;
}
function fixture(delta = -1, actualWriter = false, baselineVersion: 1 | 2 = 1, candidateVersion: 1 | 2 = baselineVersion) {
  seed('baseline');
  for (const id of ['a', 'b', 'c']) writeCapture('baseline', id, 0, actualWriter, baselineVersion);
  const calibration = canonical(calibratePreparationMeasurements({ root, universeId: 'baseline', captureIds: ['c', 'a', 'b'], expectedSourceDigest: digest('baseline') }));
  seed('candidate', 'candidate');
  const capture = writeCapture('candidate', 'candidate', delta, actualWriter, candidateVersion);
  const request = { root, universeId: 'candidate', captureId: 'candidate', calibration };
  return { capture, request };
}
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-comparison-'))); interception.afterSnapshot = undefined; });
afterEach(() => { vi.restoreAllMocks(); interception.afterSnapshot = undefined; rmSync(root, { recursive: true, force: true }); });

describe('captured preparation candidate comparison', () => {
  it.each([1, 2] as const)('connects real calibration CLI output to real captured-comparison CLI using synthetic v%s immutable journals', async version => {
    // Real private publication and decoding; these fixed counts/qualification
    // rows are synthetic fixtures, not three native baseline measurements.
    const { capture } = fixture(-1, true, version);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdUniversePreparationMeasurementCalibrate(['baseline', '--root', root, '--capture', 'a', '--capture', 'b', '--capture', 'c',
      '--expected-source-digest', digest('baseline'), '--json'])).toBe(0);
    expect(output).toHaveBeenCalledOnce();
    const descriptor = String(output.mock.calls[0]![0]);
    expect(JSON.parse(descriptor)).toMatchObject({ kind: 'preparation-measurement-calibration', scope: 'diagnostic-only',
      workload: { id: `preparation-workflows-v${version}` }, totalProcesses: 150 });
    const file = join(root, 'calibration.json'); writeFileSync(file, descriptor, { mode: 0o600 });
    const before = readdirSync(capture.records).map(name => readFileSync(join(capture.records, name), 'utf8'));
    output.mockClear();
    expect(await cmdUniversePreparationMeasurementCompare(['candidate', '--root', root, '--capture', 'candidate', '--calibration', file, '--json'])).toBe(0);
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toMatchObject({ scope: 'diagnostic-only', result: 'improved',
      calibrationAuthority: 'caller-supplied-diagnostic-input', evidence: { targetOnlyDifference: true },
      comparison: { processTotal: { baseline: 150, candidate: 149, delta: -1 } } });
    expect(JSON.stringify(output.mock.calls)).not.toContain(root);
    expect(readFileSync(file, 'utf8')).toBe(descriptor);
    expect(readdirSync(capture.records).map(name => readFileSync(join(capture.records, name), 'utf8'))).toEqual(before);
    expect(errors).not.toHaveBeenCalled();
  });
  it('refuses a v1 captured candidate against a v2 calibration through the real CLI without changing evidence', async () => {
    const { request, capture } = fixture(-1, true, 2, 1);
    const file = join(root, 'qualified-calibration.json'); writeFileSync(file, request.calibration, { mode: 0o600 });
    const before = readdirSync(capture.records).map(name => readFileSync(join(capture.records, name), 'utf8'));
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdUniversePreparationMeasurementCompare(['candidate', '--root', root, '--capture', 'candidate', '--calibration', file, '--json'])).toBe(1);
    expect(output).toHaveBeenCalledOnce();
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toMatchObject({ scope: 'diagnostic-only', result: 'not-comparable',
      reason: 'workload-mismatch', comparison: null, evidence: null });
    expect(readFileSync(file, 'utf8')).toBe(request.calibration);
    expect(readdirSync(capture.records).map(name => readFileSync(join(capture.records, name), 'utf8'))).toEqual(before);
  });
  it.each([[-1, 'improved'], [0, 'unchanged'], [1, 'regressed']] as const)('compares full inventory and real journal for delta %s', (delta, result) => {
    const { request, capture } = fixture(delta);
    const before = readdirSync(capture.records).map(name => readFileSync(join(capture.records, name), 'utf8'));
    const value = compareCapturedPreparationMeasurement(request);
    expect(value).toMatchObject({ scope: 'diagnostic-only', calibrationAuthority: 'caller-supplied-diagnostic-input', result, reason: null,
      identityVerificationScope: 'recorded-attempt-and-current-seed', evidence: { fileCount: 2, targetOnlyDifference: true, targetChanged: true },
      comparison: { processTotal: { baseline: 150, candidate: 150 + delta, delta } } });
    expect(JSON.stringify(value)).not.toContain(root);
    for (const key of ['score', 'passed', 'accepted', 'delivery']) expect(value).not.toHaveProperty(key);
    expect(readdirSync(capture.records).map(name => readFileSync(join(capture.records, name), 'utf8'))).toEqual(before);
    expect(value.comparison!.regions).toHaveLength(15);
  });
  it('permits relocated bundle file paths with the same aggregate and native identities', () => {
    const { request, capture } = fixture();
    for (const file of capture.intent.evaluator.files) file.path = file.path.replace('/installed/', '/relocated/');
    capture.intent.evaluator.command = capture.intent.evaluator.command.map(arg => arg.replace('/installed/', '/relocated/'));
    capture.receipt.intentDigest = digest(canonical(capture.intent)); capture.save();
    expect(compareCapturedPreparationMeasurement(request).result).toBe('improved');
  });
  it.each(['aggregate', 'node', 'git', 'tool', 'implementation', 'missing-file', 'command-flag', 'command-entry', 'extra-tool'] as const)('refuses changed %s identity', kind => {
    const { request, capture } = fixture(), selected = capture.intent.evaluator;
    if (kind === 'aggregate') selected.digest = digest('changed');
    if (kind === 'node') selected.executableDigest = digest('changed');
    if (kind === 'git') { selected.git.digest = digest('changed'); selected.tools[0]!.digest = selected.git.digest; }
    if (kind === 'tool') selected.tools[1]!.digest = digest('changed');
    if (kind === 'implementation') selected.files[0]!.digest = digest('changed');
    if (kind === 'missing-file') selected.files.pop();
    if (kind === 'command-flag') selected.command[1] = '--inspect';
    if (kind === 'command-entry') selected.command[3] = '/private/other.mjs';
    if (kind === 'extra-tool') selected.tools.push({ path: '/private/other-tool', digest: digest('other-tool') });
    capture.receipt.intentDigest = digest(canonical(capture.intent)); capture.save();
    expect(compareCapturedPreparationMeasurement(request)).toMatchObject({ result: 'not-comparable', reason: 'workload-mismatch', evidence: null });
  });
  it.each(['extra', 'removed', 'changed', 'executable', 'target-mode'] as const)('refuses out-of-scope %s difference despite valid capture', kind => {
    const { request, capture } = fixture();
    if (kind === 'extra') writeFileSync(join(capture.seed, 'extra.txt'), 'extra');
    if (kind === 'removed') rmSync(join(capture.seed, 'fixed.txt'));
    if (kind === 'changed') writeFileSync(join(capture.seed, 'fixed.txt'), 'changed');
    if (kind === 'executable') chmodSync(join(capture.seed, 'fixed.txt'), 0o700);
    if (kind === 'target-mode') chmodSync(join(capture.seed, TARGET), 0o700);
    capture.intent.artifact.digest = readArtifactSnapshot(capture.seed).digest;
    capture.receipt.intentDigest = digest(canonical(capture.intent)); capture.save();
    expect(compareCapturedPreparationMeasurement(request)).toMatchObject({ result: 'not-comparable', reason: 'scope-mismatch', identityVerificationScope: null });
  });
  it.each(['symlink', 'hardlink', 'bytes'] as const)('refuses current seed %s drift', kind => {
    const { request, capture } = fixture();
    if (kind === 'symlink') symlinkSync(join(capture.seed, 'fixed.txt'), join(capture.seed, 'link'));
    if (kind === 'hardlink') linkSync(join(capture.seed, 'fixed.txt'), join(capture.seed, 'link'));
    if (kind === 'bytes') writeFileSync(join(capture.seed, TARGET), 'new bytes after capture');
    expect(compareCapturedPreparationMeasurement(request)).toMatchObject({ result: 'not-comparable', reason: 'artifact-changed', evidence: null });
  });
  it.each(['report-hash', 'intent-binding', 'settlement-array', 'identity', 'held', 'missing', 'unsafe-mode'] as const)('refuses malformed or ineligible %s capture', kind => {
    const { request, capture } = fixture();
    if (kind === 'report-hash') capture.receipt.report!.sha256 = digest('forged');
    if (kind === 'intent-binding') capture.receipt.intentDigest = digest('forged');
    if (kind === 'settlement-array') Object.assign(capture.receipt, { processGroupSettlement: ['group-exit-confirmed'] });
    if (kind === 'identity') capture.receipt.identityVerified = false;
    if (kind === 'held') Object.assign(capture.receipt, { outcome: 'held', reason: 'settlement-unconfirmed', processGroupSettlement: 'unconfirmed', identityVerified: false });
    capture.save();
    if (kind === 'missing') rmSync(join(capture.records, 'candidate.receipt.json'));
    if (kind === 'unsafe-mode') chmodSync(join(capture.records, 'candidate.receipt.json'), 0o644);
    expect(compareCapturedPreparationMeasurement(request)).toMatchObject({ result: 'not-comparable', evidence: null, comparison: null, identityVerificationScope: null });
  });
  it('refuses forged descriptor inventory hashes without borrowing capture authority', () => {
    const { request } = fixture();
    const descriptor = JSON.parse(request.calibration); descriptor.baseline.files[0].sha256 = digest('forged');
    expect(compareCapturedPreparationMeasurement({ ...request, calibration: JSON.stringify(descriptor) })).toMatchObject({ result: 'not-comparable', reason: 'invalid-calibration' });
  });
  it.each(['journal', 'seed'] as const)('refuses %s mutation during the inventory read', kind => {
    const { request, capture } = fixture();
    interception.afterSnapshot = () => {
      if (kind === 'journal') { capture.receipt.durationMs += 1; capture.save(); }
      else writeFileSync(join(capture.seed, TARGET), 'changed during read');
    };
    expect(compareCapturedPreparationMeasurement(request)).toMatchObject({ result: 'not-comparable', reason: 'evidence-changed' });
  });
  it('rejects accessor inputs without evaluating them', () => {
    const getter = vi.fn(() => root);
    const input = Object.defineProperty({ universeId: 'candidate', captureId: 'candidate', calibration: '{}' }, 'root', { enumerable: true, get: getter });
    expect(() => compareCapturedPreparationMeasurement(input as Parameters<typeof compareCapturedPreparationMeasurement>[0])).toThrow('Invalid captured preparation comparison request');
    expect(getter).not.toHaveBeenCalled();
  });
});
