import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock('../src/core/resources/spark-enrollment-files.js', () => ({ prepareResourceSparkEnrollmentFiles: mocks.prepare }));
import { cmdResourceSparkEnrollment } from '../src/cli/resource-spark-enrollment.js';
import { cmdResourcePool } from '../src/cli/resource-pool.js';
const args = ['--pool', '/private/pool.json', '--bindings', '/private/bindings.json', '--quota-config', '/private/quota.json',
  '--general-worker', 'general', '--spark-worker', 'spark', '--output', '/private/proposal'];
const report = { status: 'prepared', manifestPath: '/private/proposal/manifest.json', fromPoolDigest: 'a'.repeat(64),
  toPoolDigest: 'b'.repeat(64), ledgerChanged: false, quotaRefreshed: false, accountUnpaused: false, generalReservationApplied: false };
let output: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks(); mocks.prepare.mockReturnValue(report);
  output = vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
describe('offline Spark proposal CLI', () => {
  it('routes preparation with exact explicit paths and no process signal ownership', async () => {
    const signals = [process.listeners('SIGINT'), process.listeners('SIGTERM')];
    expect(await cmdResourcePool(['spark', 'prepare', ...args, '--json'])).toBe(0);
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith({ poolPath: '/private/pool.json', bindingsPath: '/private/bindings.json',
      quotaConfigPath: '/private/quota.json', generalWorkerId: 'general', sparkWorkerId: 'spark', output: '/private/proposal' });
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(report);
    expect([process.listeners('SIGINT'), process.listeners('SIGTERM')]).toEqual(signals);
  });
  it.each(['--help', '-h'])('help %s has no file effects', async help => {
    expect(await cmdResourcePool(['spark', help])).toBe(0); expect(mocks.prepare).not.toHaveBeenCalled();
    expect(output.mock.calls[0]![0]).toContain('ONE descriptor, not a replacement policy');
    expect(output.mock.calls[0]![0]).toContain('does not enroll workers');
  });
  it.each([
    [], ['apply', ...args], ['prepare'], ['prepare', ...args, '--execute'], ['prepare', ...args, '--json', '--json'],
    ['prepare', ...args, '--general-worker', 'different'],
    ...['--pool', '--bindings', '--quota-config', '--general-worker', '--spark-worker', '--output'].map(flag => {
      const at = args.indexOf(flag); return ['prepare', ...args.filter((_, i) => i !== at && i !== at + 1)];
    }),
    ...['/', 'relative', '/private/../other', '/private/\u0001', 'x'.repeat(4097)].map(value =>
      ['prepare', ...args.map(arg => arg === '/private/proposal' ? value : arg)]),
    ...['general', 'bad id', 'UPPER'].map(value => ['prepare', ...args.map(arg => arg === 'spark' ? value : arg)]),
  ].map(input => ({ input })))('rejects invalid input before preparation %#', async ({ input }) => {
    expect(await cmdResourceSparkEnrollment(input)).toBe(2); expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it('redacts private failure details and never retries partial publication', async () => {
    mocks.prepare.mockImplementation(() => { throw new Error('/private/secret-launcher-and-account-hint'); });
    expect(await cmdResourceSparkEnrollment(['prepare', ...args, '--json'])).toBe(1);
    expect(mocks.prepare).toHaveBeenCalledOnce(); expect(output).toHaveBeenCalledOnce();
    expect(output.mock.calls[0]![0]).not.toContain('secret-launcher');
    expect(output.mock.calls[0]![0]).toContain('preserve any incomplete output');
  });
  it('does not represent a proposal as account activation', async () => {
    expect(await cmdResourceSparkEnrollment(['prepare', ...args])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('General reservation is proposed, not applied');
    expect(output.mock.calls[0]![0]).toContain('No quota refresh or provider activation');
  });
});
