/** Mocked descriptor I/O only; the real report parser remains in the path. */
import type { Stats } from 'node:fs';
import { constants } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  lstatSync: vi.fn<(path: string) => Stats>(), fstatSync: vi.fn<(fd: number) => Stats>(),
  openSync: vi.fn<(path: string, flags: number) => number>(), closeSync: vi.fn<(fd: number) => void>(),
  readSync: vi.fn<(fd: number, buffer: Buffer, offset: number, length: number, position: number) => number>(),
}));
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), ...io }));
import { cmdUniversePreparationMeasurement, readPreparationEvidenceFile } from '../src/cli/universe-preparation-measurement.js';

const input = '/fixture/report.json', limit = 24 * 1024;
function complete() {
  const methods = [['manager-open', 'bundle', 'manager-check', 'manager-replay', 'manager-check', 'manager-replay', 'manager-close'],
    ['successor-check', 'successor-metadata', 'successor-bundle', 'successor-metadata']];
  const workflows = methods.map((list, index) => ({ name: index ? 'successor' : 'manager', processes: index ? 40 : 60, blobProcesses: index ? 4 : 6,
    requests: list.map((method, row) => ({ id: row + 1, method, processes: method === 'manager-close' ? 0 : 10, blobProcesses: method === 'manager-close' ? 0 : 1 })) }));
  return { schemaVersion: 1, kind: 'preparation-verification-measurement', workload: 'preparation-workflows-v1', checksPassed: true,
    metrics: { correctness_checks: 19, verification_processes: 20, workflow_processes: 100, workflow_blob_processes: 10, fixture_owned_process_groups: 4,
      ...Object.fromEntries(['files_1_check', 'files_1_metadata', 'files_4_check', 'files_4_metadata'].flatMap(key => [[`${key}_processes`, 5], [`${key}_blob_processes`, 1]])) },
    workflows, diagnostics: [] };
}
function partial() {
  return { ...complete(), checksPassed: false, metrics: { correctness_checks: 15 }, workflows: complete().workflows.slice(0, 1),
    diagnostics: [{ code: 'WORKFLOW_CANDIDATE_STARTUP_FAILED', message: 'PRIVATE_REPORT_MESSAGE' }] };
}
function qualified() {
  const qualifications = ['runtime-drift', 'source-drift'].map((name, index) => ({ name, injections: 1,
    processes: 20, blobProcesses: 2, requests: [1, 2].map(id => ({ id,
      method: index ? 'successor-metadata' : 'metadata', processes: 10, blobProcesses: 1 })) }));
  return { ...complete(), workload: 'preparation-workflows-v2', qualifications,
    metrics: { ...complete().metrics, correctness_checks: 23, qualification_processes: 40, qualification_blob_processes: 4 } };
}
let bytes: Buffer;
const stat = (changes: Partial<Stats> = {}): Stats => ({ dev: 1, ino: 2, size: bytes.length, mtimeMs: 3, ctimeMs: 4,
  isFile: () => true, isSymbolicLink: () => false, ...changes }) as Stats;
let output: ReturnType<typeof vi.spyOn>, errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks(); bytes = Buffer.from(JSON.stringify(complete()));
  io.lstatSync.mockImplementation(() => stat()); io.fstatSync.mockImplementation(() => stat()); io.openSync.mockReturnValue(7);
  io.readSync.mockImplementation((_fd, buffer, offset, length, position) => {
    const count = Math.min(length, Math.max(0, bytes.length - position)); bytes.copy(buffer, offset, position, position + count); return count;
  });
  output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('read-only preparation measurement CLI', () => {
  it('labels historical v1 as lacking during-call qualification rather than silently upgrading it', async () => {
    expect(await cmdUniversePreparationMeasurement(['--input', input, '--json'])).toBe(0);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({ workload: 'preparation-workflows-v1',
      qualificationStatus: 'not-in-workload', qualifications: [], qualificationProcesses: null, qualificationBlobProcesses: null });
  });

  it.each([true, false])('exposes v2 qualification without changing old totals (json=%s)', async json => {
    bytes = Buffer.from(JSON.stringify(qualified()));
    expect(await cmdUniversePreparationMeasurement(['--input', input, ...(json ? ['--json'] : [])])).toBe(0);
    if (json) expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({ workload: 'preparation-workflows-v2',
      qualificationStatus: 'complete', correctnessChecks: 23, qualificationProcesses: 40, qualificationBlobProcesses: 4,
      leafProcesses: 20, workflowProcesses: 100, qualifications: [{ name: 'runtime-drift' }, { name: 'source-drift' }] });
    else {
      expect(output.mock.calls[0]![0]).toContain('During-call qualification: complete');
      expect(output.mock.calls[0]![0]).toContain('Qualification broker processes (excluded from comparison total): 40');
      expect(output.mock.calls[0]![0]).toContain('Qualification source-drift: 1 observed mutation');
    }
  });

  it('keeps partially qualified failures incomplete with unknown aggregate qualification counts', async () => {
    bytes = Buffer.from(JSON.stringify({ ...qualified(), checksPassed: false, qualifications: qualified().qualifications.slice(0, 1),
      metrics: { correctness_checks: 21 }, diagnostics: [{ code: 'CANDIDATE_QUALIFICATION_FAILED', message: 'PRIVATE_QUALIFICATION_DETAIL' }] }));
    expect(await cmdUniversePreparationMeasurement(['--input', input, '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({ qualificationStatus: 'incomplete',
      qualificationProcesses: null, qualificationBlobProcesses: null, qualifications: [{ name: 'runtime-drift' }],
      diagnosticCodes: ['CANDIDATE_QUALIFICATION_FAILED'] });
    expect(output.mock.calls[0]![0]).not.toContain('PRIVATE_QUALIFICATION_DETAIL');
  });

  it('reuses the bounded reader for a larger calibration descriptor without changing report limits', () => {
    bytes = Buffer.alloc(2 * 1024 * 1024, 32);
    expect(readPreparationEvidenceFile(input, 2 * 1024 * 1024)).toHaveLength(2 * 1024 * 1024);
    expect(io.readSync.mock.calls.at(-1)![4]).toBe(2 * 1024 * 1024);
    expect(io.closeSync).toHaveBeenCalledExactlyOnceWith(7);
  });

  it.each([0, -1, Number.NaN, 2 * 1024 * 1024 + 1])('rejects unsupported evidence byte cap %j before I/O', maximum => {
    expect(() => readPreparationEvidenceFile(input, maximum)).toThrow('Invalid evidence limit');
    for (const mock of Object.values(io)) expect(mock).not.toHaveBeenCalled();
  });

  it.each([
    [], ['--json'], ['report.json'], ['--input'], ['--input', '--json'], ['--input', 'relative.json'], ['--input', '/'],
    ['--input', '/fixture/../report.json'], ['--input', '/fixture/\nreport'], ['--input', `/${'x'.repeat(4096)}`],
    ['--input', input, '--input', input], ['--input', input, '--json', '--json'], ['--input', input, '--root', '/private'],
    ['--input', input, 'extra'], ['--input=report.json'], ['--help', '--unknown'], ['--help', '--input', input],
  ])('rejects invalid arguments before file I/O: %j', async (...args) => {
    expect(await cmdUniversePreparationMeasurement(args)).toBe(2);
    for (const mock of Object.values(io)) expect(mock).not.toHaveBeenCalled();
  });

  it.each(['--help', '-h'])('prints standalone %s without reading files', async flag => {
    expect(await cmdUniversePreparationMeasurement([flag])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('Diagnostic only');
    for (const mock of Object.values(io)) expect(mock).not.toHaveBeenCalled();
  });

  it('reports validated JSON without inventing acceptance or adding blob counts', async () => {
    expect(await cmdUniversePreparationMeasurement(['--input', input, '--json'])).toBe(0);
    const result = JSON.parse(output.mock.calls[0]![0] as string);
    expect(result).toMatchObject({ scope: 'diagnostic-only', reportedChecksSatisfied: true, correctnessChecks: 19,
      leafProcesses: 20, workflowProcesses: 100, workflowBlobProcesses: 10, fixtureOwnedProcessGroups: 4 });
    expect(result).not.toHaveProperty('score'); expect(result).not.toHaveProperty('passed');
    expect(io.openSync).toHaveBeenCalledExactlyOnceWith(input, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    expect(io.closeSync).toHaveBeenCalledExactlyOnceWith(7);
    expect(io.readSync.mock.calls.at(-1)![4]).toBe(bytes.length); // Explicit EOF read.
  });

  it('keeps missing totals unknown and omits private diagnostic prose', async () => {
    bytes = Buffer.from(JSON.stringify(partial()));
    expect(await cmdUniversePreparationMeasurement(['--json', '--input', input])).toBe(1);
    const text = output.mock.calls[0]![0] as string, result = JSON.parse(text);
    expect(result).toMatchObject({ reportedChecksSatisfied: false, correctnessChecks: 15, leafProcesses: null,
      workflowProcesses: null, workflowBlobProcesses: null, fixtureOwnedProcessGroups: null,
      recordedWorkflowSubtotal: { processes: 60, blobProcesses: 6 }, diagnosticCodes: ['WORKFLOW_CANDIDATE_STARTUP_FAILED'] });
    expect(text).not.toContain('PRIVATE_REPORT_MESSAGE');
  });

  it('renders truthful human labels and fixed diagnostic codes only', async () => {
    bytes = Buffer.from(JSON.stringify(partial()));
    expect(await cmdUniversePreparationMeasurement(['--input', input])).toBe(1);
    const text = output.mock.calls[0]![0] as string;
    for (const label of ['Reported checks: not satisfied', 'Workflow broker processes: unknown', 'subset, not added',
      'Fixture-owned process groups (separate): unknown', '1. manager-open', 'WORKFLOW_CANDIDATE_STARTUP_FAILED']) expect(text).toContain(label);
    expect(text).not.toContain('PRIVATE_REPORT_MESSAGE'); expect(errors).not.toHaveBeenCalled();
  });

  it.each([{ size: 0 }, { size: limit + 1 }, { size: Number.NaN }, { isFile: () => false }, { isSymbolicLink: () => true }])(
    'refuses unsafe initial file metadata: %j', async changes => {
      io.lstatSync.mockReturnValue(stat(changes));
      expect(await cmdUniversePreparationMeasurement(['--input', input])).toBe(1);
      expect(io.openSync).not.toHaveBeenCalled(); expect(io.closeSync).not.toHaveBeenCalled();
    });

  it.each(['open', 'read', 'close'] as const)('sanitizes %s failure and closes opened descriptors', async stage => {
    const failure = () => { throw new Error('PRIVATE_FS_ERROR /private/path'); };
    if (stage === 'open') io.openSync.mockImplementation(failure);
    if (stage === 'read') io.readSync.mockImplementation(failure);
    if (stage === 'close') io.closeSync.mockImplementation(failure);
    expect(await cmdUniversePreparationMeasurement(['--input', input, '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ scope: 'diagnostic-only', error: 'REPORT_UNAVAILABLE' });
    expect(io.closeSync).toHaveBeenCalledTimes(stage === 'open' ? 0 : 1);
  });

  it.each(['before', 'after', 'path'] as const)('refuses identity drift %s descriptor read', async stage => {
    if (stage === 'before') io.fstatSync.mockReturnValue(stat({ ino: 9 }));
    if (stage === 'after') io.fstatSync.mockReturnValueOnce(stat()).mockReturnValue(stat({ ctimeMs: 9 }));
    if (stage === 'path') io.lstatSync.mockReturnValueOnce(stat()).mockReturnValue(stat({ ino: 9 }));
    expect(await cmdUniversePreparationMeasurement(['--input', input])).toBe(1);
    expect(io.closeSync).toHaveBeenCalledExactlyOnceWith(7);
  });

  it('handles partial reads without truncation or repeated bytes', async () => {
    io.readSync.mockImplementation((_fd, buffer, offset, length, position) => {
      const count = Math.min(7, length, bytes.length - position); bytes.copy(buffer, offset, position, position + count); return count;
    });
    expect(await cmdUniversePreparationMeasurement(['--input', input])).toBe(0);
    expect(io.readSync.mock.calls.length).toBeGreaterThan(2);
  });

  it('accepts exactly the byte cap while still checking EOF', async () => {
    bytes = Buffer.concat([bytes, Buffer.alloc(limit - bytes.length, 32)]);
    expect(await cmdUniversePreparationMeasurement(['--input', input])).toBe(0);
    expect(io.readSync.mock.calls.at(-1)![4]).toBe(limit);
    expect(io.closeSync).toHaveBeenCalledExactlyOnceWith(7);
  });

  it('refuses a short read even when later metadata still claims the original size', async () => {
    const before = stat(); io.lstatSync.mockReturnValue(before); io.fstatSync.mockReturnValue(before);
    bytes = bytes.subarray(0, bytes.length - 1);
    expect(await cmdUniversePreparationMeasurement(['--input', input])).toBe(1);
    expect(io.closeSync).toHaveBeenCalledExactlyOnceWith(7);
  });

  it.each([-1, Number.NaN, limit + 2])('refuses an unusable descriptor count %j', async count => {
    io.readSync.mockReturnValue(count);
    expect(await cmdUniversePreparationMeasurement(['--input', input])).toBe(1);
    expect(io.readSync).toHaveBeenCalledTimes(1); expect(io.closeSync).toHaveBeenCalledExactlyOnceWith(7);
  });

  it('bounds bytes independently of initial metadata, reading at most cap plus one', async () => {
    const before = stat(); io.lstatSync.mockReturnValue(before); io.fstatSync.mockReturnValue(before);
    bytes = Buffer.alloc(limit + 100, 32);
    expect(await cmdUniversePreparationMeasurement(['--input', input])).toBe(1);
    expect(io.readSync).toHaveBeenCalledTimes(1);
    expect(io.readSync.mock.calls[0]![1]).toHaveLength(limit + 1);
    expect(io.closeSync).toHaveBeenCalledExactlyOnceWith(7);
  });

  it.each([Buffer.from('{'), Buffer.from([0xc3, 0x28]), Buffer.from('{"passed":true,"score":1}')])('rejects malformed report bytes', async value => {
    bytes = value;
    expect(await cmdUniversePreparationMeasurement(['--input', input, '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string).error).toBe('REPORT_UNAVAILABLE');
    expect(io.closeSync).toHaveBeenCalledExactlyOnceWith(7);
  });
});
