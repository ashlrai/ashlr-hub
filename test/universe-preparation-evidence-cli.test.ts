import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ calibrate: vi.fn(), compare: vi.fn(), read: vi.fn() }));
vi.mock('../src/core/universe/preparation-measurement-calibration.js', () => ({
  calibratePreparationMeasurements: backend.calibrate, MAX_PREPARATION_CALIBRATION_BYTES: 2 * 1024 * 1024,
}));
vi.mock('../src/core/universe/preparation-measurement-candidate-comparison.js', () => ({ compareCapturedPreparationMeasurement: backend.compare }));
vi.mock('../src/cli/universe-preparation-measurement.js', () => ({ readPreparationEvidenceFile: backend.read }));
import { cmdUniversePreparationMeasurementCalibrate as calibrate } from '../src/cli/universe-preparation-measurement-calibrate.js';
import { cmdUniversePreparationMeasurementCompare as compare } from '../src/cli/universe-preparation-measurement-compare.js';

const hash = 'a'.repeat(64);
const calibrationArgs = ['baseline', '--root', '/private/universe', '--capture', 'one', '--capture', 'two', '--capture', 'three', '--expected-source-digest', hash];
const comparisonArgs = ['candidate', '--root', '/private/universe', '--capture', 'candidate-one', '--calibration', '/private/calibration.json'];
let output: ReturnType<typeof vi.spyOn>, errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks();
  output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  backend.calibrate.mockReturnValue({ schemaVersion: 1, scope: 'diagnostic-only', totalProcesses: 120 });
  backend.read.mockReturnValue('{"retained":"descriptor"}');
  backend.compare.mockReturnValue({ schemaVersion: 1, scope: 'diagnostic-only', result: 'improved' });
});
afterEach(() => vi.restoreAllMocks());

describe('preparation calibration and captured comparison CLI', () => {
  it.each(['--help', '-h'])('standalone %s never reads or calibrates', async help => {
    expect(await calibrate([help])).toBe(0); expect(await compare([help])).toBe(0);
    for (const mock of Object.values(backend)) expect(mock).not.toHaveBeenCalled();
    expect(output.mock.calls.flat().join('\n')).toContain('Diagnostic only');
  });

  it.each([
    [], ['--json'], ['baseline'], ['../escape'], ['--help', '--json'],
    [...calibrationArgs, '--capture', 'four'], [...calibrationArgs, '--json', '--json'],
    [...calibrationArgs, '--calibration', '/private/file'],
    calibrationArgs.map(value => value === 'two' ? 'one' : value),
    calibrationArgs.map(value => value === hash ? hash.toUpperCase() : value),
    calibrationArgs.map(value => value === hash ? 'a'.repeat(63) : value),
    calibrationArgs.map(value => value === '/private/universe' ? 'relative' : value),
    calibrationArgs.map(value => value === '/private/universe' ? '/' : value),
    calibrationArgs.map(value => value === '/private/universe' ? '/private/../universe' : value),
    calibrationArgs.map(value => value === 'one' ? 'one\nsecret' : value),
  ])('rejects calibration options before I/O: %j', async (...args) => {
    expect(await calibrate(args)).toBe(2);
    for (const mock of Object.values(backend)) expect(mock).not.toHaveBeenCalled();
  });

  it.each([
    [], ['candidate'], ['--help', '--bad'], [...comparisonArgs, '--capture', 'two'],
    [...comparisonArgs, '--json', '--json'], [...comparisonArgs, '--root', '/another'],
    [...comparisonArgs, '--expected-source-digest', hash], [...comparisonArgs, '--report'],
    comparisonArgs.map(value => value === '/private/calibration.json' ? 'relative.json' : value),
    comparisonArgs.map(value => value === '/private/calibration.json' ? '/' : value),
    comparisonArgs.map(value => value === '/private/calibration.json' ? '/private/\nsecret' : value),
    comparisonArgs.map(value => value === '/private/calibration.json' ? `/${'a'.repeat(4096)}` : value),
  ])('rejects comparison options before I/O: %j', async (...args) => {
    expect(await compare(args)).toBe(2);
    for (const mock of Object.values(backend)) expect(mock).not.toHaveBeenCalled();
  });

  it('emits the exact backend calibration descriptor without execution', async () => {
    expect(await calibrate([...calibrationArgs, '--json'])).toBe(0);
    expect(backend.calibrate).toHaveBeenCalledExactlyOnceWith({ root: '/private/universe', universeId: 'baseline',
      captureIds: ['one', 'two', 'three'], expectedSourceDigest: hash });
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(backend.calibrate.mock.results[0]!.value);
    expect(backend.read).not.toHaveBeenCalled(); expect(backend.compare).not.toHaveBeenCalled();
  });

  it.each(['improved', 'unchanged', 'regressed', 'not-comparable'])('maps %s comparison to a truthful diagnostic exit', async result => {
    backend.compare.mockReturnValue({ scope: 'diagnostic-only', result });
    expect(await compare([...comparisonArgs, '--json'])).toBe(['improved', 'unchanged'].includes(result) ? 0 : 1);
    expect(backend.read).toHaveBeenCalledExactlyOnceWith('/private/calibration.json', 2 * 1024 * 1024);
    expect(backend.compare).toHaveBeenCalledExactlyOnceWith({ root: '/private/universe', universeId: 'candidate',
      captureId: 'candidate-one', calibration: '{"retained":"descriptor"}' });
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ scope: 'diagnostic-only', result });
    expect(backend.calibrate).not.toHaveBeenCalled();
  });

  it.each(['calibrate', 'read', 'compare'] as const)('redacts %s errors with no retry or fallback', async stage => {
    backend[stage].mockImplementation(() => { throw new Error('PRIVATE /secret/token'); });
    expect(await (stage === 'calibrate' ? calibrate([...calibrationArgs, '--json']) : compare([...comparisonArgs, '--json']))).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ scope: 'diagnostic-only', error: 'EVIDENCE_UNAVAILABLE' });
    expect(backend[stage]).toHaveBeenCalledTimes(1);
    if (stage === 'read') expect(backend.compare).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it('uses human output that distinguishes diagnostic input from acceptance', async () => {
    expect(await calibrate(calibrationArgs)).toBe(0); expect(await compare(comparisonArgs)).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('not installed scoring authority');
    expect(output.mock.calls[1]![0]).toContain('not acceptance or delivery authority');
  });

  it('prints closed JSON argument errors without backend access', async () => {
    expect(await calibrate(['--json'])).toBe(2); expect(await compare(['--json'])).toBe(2);
    for (const call of output.mock.calls) expect(JSON.parse(call[0] as string)).toEqual({ scope: 'diagnostic-only', error: 'INVALID_ARGUMENTS' });
    for (const mock of Object.values(backend)) expect(mock).not.toHaveBeenCalled();
  });
});
