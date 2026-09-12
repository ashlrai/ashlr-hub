/** Pure authoring tests: real capture codec/projection, inert storage and artifact snapshots. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImmutablePrivateRecordStoreConfig } from '../src/core/util/immutable-private-record-store.js';
import type { PreparationCaptureRecord } from '../src/core/universe/preparation-measurement-capture-store.js';
import type { PreparationMeasurementCaptureIntent } from '../src/core/universe/preparation-measurement-capture-types.js';
const io = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), snapshot: vi.fn(), inspect: vi.fn((path: string) => path) }));
vi.mock('../src/core/util/immutable-private-record-store.js', () => ({ readImmutablePrivateRecords: io.read, writeImmutablePrivateRecord: io.write }));
vi.mock('../src/core/universe/artifacts.js', async original => ({ ...await original<object>(),
  inspectPrivateDirectory: io.inspect, readArtifactSnapshot: io.snapshot }));
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { calibratePreparationMeasurements, parsePreparationMeasurementCalibration, MAX_PREPARATION_CALIBRATION_BYTES,
  PREPARATION_CALIBRATION_IMPLEMENTATION_FILES,
  type PreparationMeasurementCalibration, type PreparationMeasurementCalibrationRequest } from '../src/core/universe/preparation-measurement-calibration.js';

const TARGET = 'src/core/resources/engineering-preparation.ts';
const root = '/private/calibration'; const directory = `${root}/universes/baseline`;
const request: PreparationMeasurementCalibrationRequest = { root, universeId: 'baseline', captureIds: ['first', 'second', 'third'], expectedSourceDigest: digest('baseline source') };
let rows: PreparationCaptureRecord[];
function report() {
  const manager = ['manager-open', 'bundle', 'manager-check', 'manager-replay', 'manager-check', 'manager-replay', 'manager-close'];
  const successor = ['successor-check', 'successor-metadata', 'successor-bundle', 'successor-metadata'];
  const workflows = [manager, successor].map((methods, index) => {
    const requests = methods.map((method, index) => ({ id: index + 1, method, processes: method === 'manager-close' ? 0 : 1, blobProcesses: 0 }));
    return { name: index ? 'successor' : 'manager', processes: requests.reduce((sum, row) => sum + row.processes, 0), blobProcesses: 0, requests };
  });
  return { schemaVersion: 1, kind: 'preparation-verification-measurement', workload: 'preparation-workflows-v1', checksPassed: true,
    metrics: { correctness_checks: 19, ...Object.fromEntries(['files_1_check', 'files_1_metadata', 'files_4_check', 'files_4_metadata']
      .flatMap(key => [[`${key}_processes`, 3], [`${key}_blob_processes`, 1]])), verification_processes: 12,
      workflow_processes: 10, workflow_blob_processes: 0, fixture_owned_process_groups: 5 }, workflows, diagnostics: [] };
}
function artifact() {
  const entries = [{ path: 'README.md', executable: false, data: Buffer.from('fixed supporting file') },
    { path: TARGET, executable: false, data: Buffer.from('baseline source') }].sort((a, b) => a.path.localeCompare(b.path));
  return { entries, digest: digest(canonical(entries.map(entry => ({ path: entry.path, executable: entry.executable,
    size: entry.data.length, digest: digest(entry.data) })))) };
}
function refresh() {
  for (const row of rows.filter(row => row.kind === 'receipt')) {
    row.intent = structuredClone(rows.find(parent => parent.kind === 'intent' && parent.intent.captureId === row.intent.captureId)!.intent);
    row.receipt!.intentDigest = digest(canonical(row.intent));
    if (row.receipt?.report) {
      row.receipt.report.sha256 = digest(row.receipt.report.stdout); row.receipt.report.bytes = Buffer.byteLength(row.receipt.report.stdout);
    }
  }
}
function author() { return calibratePreparationMeasurements(request); }
function parse(value: unknown) { return parsePreparationMeasurementCalibration(JSON.stringify(value)); }
beforeEach(() => {
  vi.clearAllMocks(); rows = [];
  for (const [index, captureId] of request.captureIds.entries()) {
    const git = { path: '/Library/Developer/CommandLineTools/usr/bin/git', digest: 'a'.repeat(64) };
    const intent: PreparationMeasurementCaptureIntent = { schemaVersion: 1, captureId, universeId: 'baseline',
      startedAt: `2026-09-12T00:00:0${index}.000Z`, deadlineAt: `2026-09-12T00:00:0${index + 1}.000Z`, timeoutMs: 1000,
      manifestDigest: 'b'.repeat(64), comparatorDigest: 'c'.repeat(64), artifact: { path: `${directory}/seed`, digest: artifact().digest, revision: 'd'.repeat(40) },
      evaluator: { id: 'preparation-measurement-v1', digest: 'e'.repeat(64), executableDigest: 'f'.repeat(64),
        command: ['/private/node', '--no-addons', '/private/installed/preparation-verification.mjs'],
        files: PREPARATION_CALIBRATION_IMPLEMENTATION_FILES.map(name => ({ name, path: `/private/installed/${name}`, digest: 'a'.repeat(64) })),
        tools: [git], git } };
    const stdout = JSON.stringify(report()) + '\n';
    rows.push({ id: `${captureId}.intent`, kind: 'intent', intent, receipt: null },
      { id: `${captureId}.receipt`, kind: 'receipt', intent: structuredClone(intent), receipt: {
        schemaVersion: 1, intentDigest: digest(canonical(intent)), finishedAt: `2026-09-12T00:00:0${index}.500Z`, durationMs: 500,
        outcome: 'captured', reason: null, identityVerified: true, processGroupSettlement: 'group-exit-confirmed',
        report: { stdout, bytes: Buffer.byteLength(stdout), sha256: digest(stdout), checksPassed: true } } });
  }
  io.snapshot.mockImplementation(artifact);
  io.read.mockImplementation((config: ImmutablePrivateRecordStoreConfig<PreparationCaptureRecord>) => {
    const records = rows.map(row => config.codecForRead()!.parse(JSON.parse(JSON.stringify(row))));
    return { records: records.filter(Boolean), sourcePresent: true, sourceState: records.includes(null) ? 'degraded' : 'healthy', complete: !records.includes(null) };
  });
});

describe('read-only preparation calibration authoring', () => {
  it('creates a deterministic 15-region descriptor from three unique successful attempts with identical report bytes', () => {
    const value = author();
    expect(value).toMatchObject({ scope: 'diagnostic-only', totalProcesses: 22, baseline: { artifactDigest: artifact().digest,
      source: { path: TARGET, sha256: request.expectedSourceDigest } }, workload: { node: { path: '/private/node', sha256: 'f'.repeat(64) } } });
    expect(value.scenarios).toHaveLength(15); expect(value.provenance).toHaveLength(3);
    expect(new Set(value.provenance.map(row => row.reportDigest)).size).toBe(1);
    expect(new Set(value.provenance.map(row => row.intentDigest)).size).toBe(3);
    expect(value.baseline.files).toHaveLength(2); expect(JSON.stringify(value)).not.toContain('/private/installed');
    expect(JSON.stringify(value)).not.toContain(root); expect(value).not.toHaveProperty('score');
    expect(value).not.toHaveProperty('accepted'); expect(parse(value)).toEqual(value);
    expect(calibratePreparationMeasurements({ ...request, captureIds: ['third', 'first', 'second'] })).toEqual(value);
    expect(author()).toEqual(value); expect(io.write).not.toHaveBeenCalled();
    expect(io.snapshot).toHaveBeenCalledWith(`${directory}/seed`);
  });
  it.each([['first', 'first', 'third'], ['first', 'second'], ['first', 'second', 'third', 'fourth'], ['first', 'second', 'missing']].map(ids => ({ ids })))('refuses repeated, missing or incorrectly bounded capture IDs $ids', ({ ids }) => {
    expect(() => calibratePreparationMeasurements({ ...request, captureIds: ids as PreparationMeasurementCalibrationRequest['captureIds'] })).toThrow();
    expect(io.write).not.toHaveBeenCalled();
  });
  it.each(['manifest', 'comparator', 'revision', 'artifact', 'workload', 'node', 'tool', 'installed-path'] as const)('refuses differing %s pins', key => {
    const intent = rows[2]!.intent;
    if (key === 'manifest') intent.manifestDigest = '1'.repeat(64);
    if (key === 'comparator') intent.comparatorDigest = '1'.repeat(64);
    if (key === 'revision') intent.artifact.revision = '1'.repeat(40);
    if (key === 'artifact') intent.artifact.digest = '1'.repeat(64);
    if (key === 'workload') intent.evaluator.digest = '1'.repeat(64);
    if (key === 'node') intent.evaluator.executableDigest = '1'.repeat(64);
    if (key === 'tool') { intent.evaluator.tools[0]!.digest = '1'.repeat(64); intent.evaluator.git.digest = '1'.repeat(64); }
    if (key === 'installed-path') intent.evaluator.files[0]!.path = '/different/preparation-verification.mjs';
    refresh(); expect(author).toThrow(); expect(io.snapshot).not.toHaveBeenCalled();
  });
  it.each(['held', 'failed', 'unverified', 'missing-receipt', 'bad-report-hash'] as const)('refuses %s capture evidence', kind => {
    const receipt = rows[1]!.receipt!;
    if (kind === 'held') { receipt.outcome = 'held'; receipt.reason = 'settlement-unconfirmed'; receipt.processGroupSettlement = 'unconfirmed'; }
    if (kind === 'failed') { receipt.outcome = 'failed'; receipt.reason = 'execution-failed'; }
    if (kind === 'unverified') receipt.identityVerified = false;
    if (kind === 'missing-receipt') rows.splice(1, 1);
    if (kind === 'bad-report-hash') receipt.report!.sha256 = '1'.repeat(64);
    expect(author).toThrow(); expect(io.snapshot).not.toHaveBeenCalled();
  });
  it.each(['processes', 'blobs'])('refuses per-region %s drift even when total processes agree', kind => {
    const changed = report();
    if (kind === 'processes') {
      // Keep healthy requests positive and the workflow total unchanged.
      changed.workflows[0]!.requests[1]!.processes = 2;
      changed.workflows[0]!.requests[4]!.processes = 0;
    } else { Object.assign(changed.metrics, { files_1_check_blob_processes: 2 }); }
    rows[1]!.receipt!.report!.stdout = JSON.stringify(changed); refresh();
    expect(author).toThrow();
  });
  it('refuses source digest mismatch, full artifact drift, and target absence', () => {
    expect(() => calibratePreparationMeasurements({ ...request, expectedSourceDigest: '0'.repeat(64) })).toThrow();
    io.snapshot.mockReturnValueOnce({ ...artifact(), digest: '0'.repeat(64) }); expect(author).toThrow();
    io.snapshot.mockReturnValueOnce({ digest: artifact().digest, entries: [] }); expect(author).toThrow();
  });
  it('refuses journal replacement while reading the frozen artifact', () => {
    io.snapshot.mockImplementationOnce(() => { rows[1]!.receipt!.durationMs++; return artifact(); });
    expect(author).toThrow(); expect(io.write).not.toHaveBeenCalled();
  });
  it.each(['accessor', 'proxy', 'extra', 'array-accessor'] as const)('rejects hostile request %s before reading storage', kind => {
    let input: unknown = { ...request };
    if (kind === 'accessor') Object.defineProperty(input, 'root', { enumerable: true, get() { throw new Error('Getter executed'); } });
    if (kind === 'proxy') input = new Proxy(request, { ownKeys() { throw new Error('Proxy executed'); } });
    if (kind === 'extra') input = { ...request, execute: true };
    if (kind === 'array-accessor') { const ids = [...request.captureIds]; Object.defineProperty(ids, 0, { get() { throw new Error('Getter executed'); } }); input = { ...request, captureIds: ids }; }
    expect(() => calibratePreparationMeasurements(input as PreparationMeasurementCalibrationRequest)).toThrow(/calibration/);
    expect(io.read).not.toHaveBeenCalled();
  });
  it('refuses a revoked capture-ID proxy with the fixed domain error before storage', () => {
    const { proxy, revoke } = Proxy.revocable([...request.captureIds], {}); revoke();
    expect(() => calibratePreparationMeasurements({ ...request, captureIds: proxy as PreparationMeasurementCalibrationRequest['captureIds'] }))
      .toThrow('Preparation measurement calibration unavailable or invalid');
    expect(io.read).not.toHaveBeenCalled();
  });
});

describe('strict diagnostic calibration descriptor parser', () => {
  it('freezes the shared implementation allowlist against caller mutation', () => {
    expect(Object.isFrozen(PREPARATION_CALIBRATION_IMPLEMENTATION_FILES)).toBe(true);
    expect(() => Reflect.set(PREPARATION_CALIBRATION_IMPLEMENTATION_FILES, '0', 'arbitrary.mjs')).not.toThrow();
    expect(PREPARATION_CALIBRATION_IMPLEMENTATION_FILES[0]).toBe('preparation-bridge.mjs');
  });
  it.each(['extra', 'scope', 'inventory-digest', 'source', 'path', 'executable', 'inventory-bytes', 'duplicate-provenance',
    'duplicate-intent', 'region-key', 'region-total', 'blob-overflow', 'integer-overflow', 'missing-region', 'tool'] as const)('rejects %s corruption', kind => {
    const value = author();
    if (kind === 'extra') Object.assign(value, { accepted: true });
    if (kind === 'scope') Object.assign(value, { scope: 'accepted' });
    if (kind === 'inventory-digest') value.baseline.artifactDigest = '0'.repeat(64);
    if (kind === 'source') value.baseline.source.sha256 = '0'.repeat(64);
    if (kind === 'path') value.baseline.files[0]!.path = '../secret';
    if (kind === 'executable') value.baseline.files[0]!.executable = true;
    if (kind === 'inventory-bytes') value.baseline.files[0]!.bytes = 65 * 1024 * 1024;
    if (kind === 'duplicate-provenance') value.provenance[1]!.captureId = value.provenance[0]!.captureId;
    if (kind === 'duplicate-intent') value.provenance[1]!.intentDigest = value.provenance[0]!.intentDigest;
    if (kind === 'region-key') value.scenarios[0]!.key = 'arbitrary';
    if (kind === 'region-total') value.totalProcesses++;
    if (kind === 'blob-overflow') value.scenarios[0]!.blobProcesses = 9;
    if (kind === 'integer-overflow') value.scenarios[0]!.processes = Number.MAX_SAFE_INTEGER;
    if (kind === 'missing-region') value.scenarios.pop();
    if (kind === 'tool') value.workload.git.sha256 = '0'.repeat(64);
    expect(() => parse(value)).toThrow();
  });
  it('bounds raw input and rejects non-JSON/string inputs without conversion', () => {
    expect(() => parsePreparationMeasurementCalibration(' '.repeat(MAX_PREPARATION_CALIBRATION_BYTES + 1))).toThrow();
    expect(() => parsePreparationMeasurementCalibration('{')).toThrow();
    expect(() => parsePreparationMeasurementCalibration({ toString() { throw new Error('Conversion executed'); } } as unknown as string)).toThrow(/calibration/);
  });
  it('returns detached data and does not imply that arbitrary parsed descriptors have trusted provenance', () => {
    const value: PreparationMeasurementCalibration = author(), decoded = parse(value);
    decoded.provenance[0]!.receiptDigest = '0'.repeat(64);
    expect(value.provenance[0]!.receiptDigest).not.toBe(decoded.provenance[0]!.receiptDigest);
    expect(parse(decoded).scope).toBe('diagnostic-only');
  });
});
