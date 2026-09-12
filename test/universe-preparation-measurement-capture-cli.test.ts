/** Mocked capture only: no files, subprocesses, evaluators or providers. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { PreparationMeasurementCapture } from '../src/core/universe/preparation-measurement-capture-types.js';

const backend = vi.hoisted(() => ({ capture: vi.fn() }));
const unrelated = vi.hoisted(() => ({ initUniverse: vi.fn(), runUniverse: vi.fn(), readUniverseOverview: vi.fn(), runUniverseDemo: vi.fn(), inspect: vi.fn() }));
vi.mock('../src/core/universe/preparation-measurement-capture.js', () => ({ captureUniversePreparationMeasurement: backend.capture }));
vi.mock('../src/core/universe/index.js', () => unrelated);
vi.mock('../src/cli/universe-demo.js', () => unrelated);
vi.mock('../src/cli/universe-preparation-measurement.js', () => ({ cmdUniversePreparationMeasurement: unrelated.inspect }));
import { cmdUniversePreparationMeasurementCapture } from '../src/cli/universe-preparation-measurement-capture.js';
import { cmdUniverse } from '../src/cli/universe.js';

const args = ['example', '--root', '/private/universes', '--capture', 'baseline-1'];
const methods = [['manager-open', 'bundle', 'manager-check', 'manager-replay', 'manager-check', 'manager-replay', 'manager-close'],
  ['successor-check', 'successor-metadata', 'successor-bundle', 'successor-metadata']];
const stdout = `  ${JSON.stringify({ schemaVersion: 1, kind: 'preparation-verification-measurement', workload: 'preparation-workflows-v1', checksPassed: true,
  metrics: { correctness_checks: 19, verification_processes: 20, workflow_processes: 100, workflow_blob_processes: 10, fixture_owned_process_groups: 4,
    ...Object.fromEntries(['files_1_check', 'files_1_metadata', 'files_4_check', 'files_4_metadata'].flatMap(key => [[`${key}_processes`, 5], [`${key}_blob_processes`, 1]])) },
  workflows: methods.map((list, index) => ({ name: index ? 'successor' : 'manager', processes: index ? 40 : 60, blobProcesses: index ? 4 : 6,
    requests: list.map((method, row) => ({ id: row + 1, method, processes: method === 'manager-close' ? 0 : 10, blobProcesses: method === 'manager-close' ? 0 : 1 })) })), diagnostics: [] })}\n\n`;
function captured(): PreparationMeasurementCapture {
  return { schemaVersion: 1, scope: 'diagnostic-only', state: 'recorded', disposition: 'created',
    intent: { schemaVersion: 1, universeId: 'example', captureId: 'baseline-1', startedAt: '2026-09-12T00:00:00.000Z',
      deadlineAt: '2026-09-12T00:15:00.000Z', timeoutMs: 900_000, manifestDigest: 'a'.repeat(64), comparatorDigest: 'b'.repeat(64),
      artifact: { path: '/PRIVATE/artifact', digest: 'c'.repeat(64), revision: 'd'.repeat(40) },
      evaluator: { id: 'preparation-measurement-v1', digest: 'e'.repeat(64), executableDigest: 'f'.repeat(64),
        command: ['/PRIVATE/executable'], files: [], tools: [], git: { path: '/PRIVATE/git', digest: '0'.repeat(64) } } },
    receipt: { schemaVersion: 1, intentDigest: '1'.repeat(64), finishedAt: '2026-09-12T00:01:00.000Z', durationMs: 60_000,
      outcome: 'captured', reason: null, processGroupSettlement: 'group-exit-confirmed', identityVerified: true,
      report: { stdout, bytes: Buffer.byteLength(stdout), sha256: createHash('sha256').update(stdout).digest('hex'), checksPassed: true } } };
}
function qualifiedCapture(): PreparationMeasurementCapture {
  const value = captured(), report = JSON.parse(stdout);
  report.workload = 'preparation-workflows-v2'; report.metrics.correctness_checks = 23;
  report.qualifications = ['runtime-drift', 'source-drift'].map((name, index) => ({ name, injections: 1,
    processes: 20, blobProcesses: 2, requests: [1, 2].map(id => ({ id,
      method: index ? 'successor-metadata' : 'metadata', processes: 10, blobProcesses: 1 })) }));
  report.metrics.qualification_processes = 40; report.metrics.qualification_blob_processes = 4;
  const text = JSON.stringify(report) + '\n';
  value.receipt!.report = { stdout: text, bytes: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'), checksPassed: true };
  return value;
}
let output: ReturnType<typeof vi.spyOn>, errors: ReturnType<typeof vi.spyOn>, raw: ReturnType<typeof vi.spyOn>;
let signals: { interrupt: Array<(signal: NodeJS.Signals) => void>; terminate: Array<(signal: NodeJS.Signals) => void> };
beforeEach(() => {
  vi.resetAllMocks(); backend.capture.mockResolvedValue(captured());
  output = vi.spyOn(console, 'log').mockImplementation(() => {});
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  raw = vi.spyOn(process.stdout, 'write').mockImplementation((_chunk: unknown, callback?: unknown) => {
    if (typeof callback === 'function') callback(); return true;
  });
  signals = { interrupt: process.listeners('SIGINT'), terminate: process.listeners('SIGTERM') };
});
afterEach(() => {
  expect(process.listeners('SIGINT')).toEqual(signals.interrupt);
  expect(process.listeners('SIGTERM')).toEqual(signals.terminate);
  for (const callback of Object.values(unrelated)) expect(callback).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe('one-shot preparation diagnostic capture CLI', () => {
  it.each([true, false])('identifies recorded v2 qualification separately from capture identity (json=%s)', async json => {
    backend.capture.mockResolvedValue(qualifiedCapture());
    expect(await cmdUniversePreparationMeasurementCapture([...args, ...(json ? ['--json'] : [])])).toBe(0);
    if (json) expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({ scope: 'diagnostic-only',
      identityVerificationScope: 'recorded-attempt-only', report: { workload: 'preparation-workflows-v2',
        qualificationStatus: 'complete', reportedChecksSatisfied: true } });
    else expect(output.mock.calls[0]![0]).toContain('Recorded workload: preparation-workflows-v2 · during-call qualification: complete');
    expect(backend.capture).toHaveBeenCalledOnce();
  });

  it.each([
    [], ['--json'], ['example'], ['example', '--root', '/private'], ['example', '--capture', 'one'],
    ...['relative', '/', '/private/../other', '/private/\nroot', '/private/\u007froot', `/${'x'.repeat(4096)}`].map(root => ['example', '--root', root, '--capture', 'one']),
    ...['../escape', 'UPPER', '-flag', 'x'.repeat(65)].flatMap(id => [[id, ...args.slice(1)], [...args.slice(0, 4), id]]),
    [...args, '--root', '/other'], [...args, '--capture', 'other'], [...args, '--json', '--json'],
    [...args, '--report', '--report'], [...args, '--json', '--report'], [...args, '--report', '--json'],
    [...args, '--output', '/private/output'], [...args, '--timeout-ms', '900000'], [...args, '--evaluator', '/private/code'],
    [...args, '--env', 'SECRET'], [...args, '--help'], ['--help', '--report'], [...args, 'extra'],
  ].map(input => ({ input })))('rejects invalid options before invoking runtime %#', async ({ input }) => {
    expect(await cmdUniversePreparationMeasurementCapture(input)).toBe(2);
    expect(backend.capture).not.toHaveBeenCalled(); expect(raw).not.toHaveBeenCalled();
  });
  it.each(['--help', '-h'])('help %s is nonexecuting and explains the explicit execution boundary', async help => {
    expect(await cmdUniverse(['preparation-measurement-capture', help])).toBe(0);
    expect(backend.capture).not.toHaveBeenCalled(); expect(raw).not.toHaveBeenCalled();
    expect(output.mock.calls[0]![0]).toContain('This executes local fixture');
    expect(output.mock.calls[0]![0]).toContain('Unfinished or uncertain work stays held');
  });
  it('routes exact IDs and root once with a cancellation signal and a metadata-only JSON summary', async () => {
    expect(await cmdUniverse(['preparation-measurement-capture', ...args, '--json'])).toBe(0);
    expect(backend.capture).toHaveBeenCalledExactlyOnceWith({ root: '/private/universes', universeId: 'example', captureId: 'baseline-1', signal: expect.any(AbortSignal) });
    const text = String(output.mock.calls[0]![0]), value = JSON.parse(text);
    expect(value).toMatchObject({ schemaVersion: 1, scope: 'diagnostic-only', state: 'recorded', outcome: 'captured',
      report: { reportedChecksSatisfied: true }, identityVerified: true, identityVerificationScope: 'recorded-attempt-only',
      startedAt: '2026-09-12T00:00:00.000Z', finishedAt: '2026-09-12T00:01:00.000Z', processGroupSettlement: 'group-exit-confirmed' });
    expect(value).not.toHaveProperty('score'); expect(value).not.toHaveProperty('passed');
    expect(text).not.toContain('PRIVATE'); expect(raw).not.toHaveBeenCalled();
  });
  it('keeps default output diagnostic and omits raw report prose and native paths', async () => {
    expect(await cmdUniversePreparationMeasurementCapture(args)).toBe(0);
    const text = String(output.mock.calls[0]![0]); expect(text).toContain('not a score or acceptance evidence');
    expect(text).toContain('Reported checks: satisfied'); expect(text).not.toContain('PRIVATE'); expect(raw).not.toHaveBeenCalled();
    expect(text).toContain('Recorded attempt: 2026-09-12T00:00:00.000Z → 2026-09-12T00:01:00.000Z');
    expect(text).toContain('not current runtime health; replay does not freshly reverify it');
  });
  it('writes retained raw bytes only with --report, including whitespace and no extra newline', async () => {
    expect(await cmdUniversePreparationMeasurementCapture([...args, '--report'])).toBe(0);
    expect(raw).toHaveBeenCalledExactlyOnceWith(stdout, expect.any(Function));
    expect(output).not.toHaveBeenCalled(); expect(errors).not.toHaveBeenCalled();
  });
  it('emits an explicitly requested valid failed report without turning it into success', async () => {
    const result = captured(); result.receipt!.outcome = 'failed'; result.receipt!.reason = 'execution-failed'; result.receipt!.report!.checksPassed = false;
    const failed = JSON.stringify({ ...JSON.parse(stdout), checksPassed: false, diagnostics: [{ code: 'PROCESS_SETTLEMENT_UNCONFIRMED', message: 'PRIVATE_REPORT_TEXT' }] }) + '\n';
    result.receipt!.report = { stdout: failed, bytes: Buffer.byteLength(failed), sha256: createHash('sha256').update(failed).digest('hex'), checksPassed: false };
    backend.capture.mockResolvedValue(result);
    expect(await cmdUniversePreparationMeasurementCapture([...args, '--report'])).toBe(1);
    expect(raw).toHaveBeenCalledExactlyOnceWith(failed, expect.any(Function)); expect(output).not.toHaveBeenCalled();
    raw.mockClear(); output.mockClear();
    expect(await cmdUniversePreparationMeasurementCapture([...args, '--json'])).toBe(1);
    expect(String(output.mock.calls[0]![0])).not.toContain('PRIVATE_REPORT_TEXT'); expect(raw).not.toHaveBeenCalled();
  });
  it('keeps held custody nonzero even when a retained report says checks passed', async () => {
    const result = captured(); result.state = 'held'; backend.capture.mockResolvedValue(result);
    expect(await cmdUniversePreparationMeasurementCapture([...args, '--report'])).toBe(1);
    expect(raw).toHaveBeenCalledExactlyOnceWith(stdout, expect.any(Function));
  });
  it('advertises the effectful capture separately from read-only inspection in Universe help', async () => {
    expect(await cmdUniverse(['help'])).toBe(0); expect(backend.capture).not.toHaveBeenCalled();
    expect(String(output.mock.calls[0]![0])).toContain('preparation-measurement-capture <id>');
    expect(String(output.mock.calls[0]![0])).toContain('Preparation-measurement requires --input instead of --root and never runs work.');
  });
  it.each(['missing', 'held', 'recorded'] as const)('does not fabricate raw report bytes for %s custody without a report', async state => {
    const result = captured(); result.state = state; result.receipt = null; backend.capture.mockResolvedValue(result);
    expect(await cmdUniversePreparationMeasurementCapture([...args, '--report'])).toBe(1);
    expect(raw).not.toHaveBeenCalled(); expect(output).not.toHaveBeenCalled(); expect(errors).toHaveBeenCalledOnce();
  });
  it.each(['held', 'cancelled', 'timed-out', 'failed'] as const)('does not call %s outcome success even if retained checks passed', async outcome => {
    const result = captured(); result.receipt!.outcome = outcome; backend.capture.mockResolvedValue(result);
    expect(await cmdUniversePreparationMeasurementCapture([...args, '--json'])).toBe(1); expect(backend.capture).toHaveBeenCalledOnce();
  });
  it('shows replay metadata without asking the backend for another capture', async () => {
    const result = captured(); result.disposition = 'replayed'; backend.capture.mockResolvedValue(result);
    expect(await cmdUniversePreparationMeasurementCapture([...args, '--json'])).toBe(0);
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toMatchObject({ disposition: 'replayed',
      identityVerificationScope: 'recorded-attempt-only', startedAt: '2026-09-12T00:00:00.000Z', finishedAt: '2026-09-12T00:01:00.000Z' });
    expect(backend.capture).toHaveBeenCalledOnce();
  });
  it.each(['--json', '--report', ''] as const)('sanitizes runtime errors without retries or raw bytes in %s mode', async mode => {
    backend.capture.mockRejectedValue(new Error('/PRIVATE/secret stderr'));
    expect(await cmdUniversePreparationMeasurementCapture([...args, ...(mode ? [mode] : [])])).toBe(1);
    expect(backend.capture).toHaveBeenCalledOnce(); expect(raw).not.toHaveBeenCalled();
    expect([...output.mock.calls, ...errors.mock.calls].flat().join(' ')).not.toContain('PRIVATE');
    if (mode === '--report') expect(output).not.toHaveBeenCalled();
  });
  it.each(['SIGINT', 'SIGTERM'] as const)('forwards %s once and waits for backend settlement before removing handlers', async name => {
    let finish!: (result: PreparationMeasurementCapture) => void, entered!: () => void;
    const ready = new Promise<void>(done => { entered = done; });
    backend.capture.mockImplementation(() => { entered(); return new Promise(done => { finish = done; }); });
    const pending = cmdUniversePreparationMeasurementCapture([...args, '--json']); await ready;
    const prior = name === 'SIGINT' ? signals.interrupt : signals.terminate;
    const handler = process.listeners(name).find(listener => !prior.includes(listener))!; handler(name);
    expect(backend.capture.mock.calls[0]![0].signal.aborted).toBe(true);
    expect(output).not.toHaveBeenCalled();
    const result = captured(); result.receipt!.outcome = 'cancelled'; finish(result);
    expect(await pending).toBe(1); expect(backend.capture).toHaveBeenCalledOnce();
  });
  it('reports raw output failure without repeating the diagnostic invocation', async () => {
    raw.mockImplementation((_chunk: unknown, callback?: unknown) => { if (typeof callback === 'function') callback(new Error('PRIVATE output fault')); return false; });
    expect(await cmdUniversePreparationMeasurementCapture([...args, '--report'])).toBe(1);
    expect(backend.capture).toHaveBeenCalledOnce(); expect(raw).toHaveBeenCalledOnce(); expect(output).not.toHaveBeenCalled();
    expect(String(errors.mock.calls[0]![0])).not.toContain('PRIVATE');
  });
});
