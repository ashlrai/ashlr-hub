import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const core = vi.hoisted(() => ({ superviseUniverseCampaigns: vi.fn() }));
vi.mock('../src/core/universe/campaign-supervisor.js', () => core);
import { cmdUniverseSupervise } from '../src/cli/universe-supervise.js';

function report(status = 'completed') {
  return { schemaVersion: 1, executionScope: 'foreground-explicit-queue', status,
    startedAt: '2026-09-07T12:00:00.000Z', deadlineAt: '2026-09-07T12:01:00.000Z', finishedAt: '2026-09-07T12:00:01.000Z',
    outcomes: [{ campaignId: 'first', status: 'completed', attempted: true, reasonCode: 'campaign-completed', observedState: 'completed' }], transitions: [] };
}
const valid = ['first', '--root', '/private/experiments', '--max-duration-ms', '60000'];
describe('Universe supervision CLI', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    core.superviseUniverseCampaigns.mockResolvedValue(report());
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [], ['first'], ['first', '--root', '/private/experiments'],
    ['../escape', '--root', '/private/experiments', '--max-duration-ms', '60000'],
    [...valid, 'first'], [...valid, '--unknown'], [...valid, '--json', '--json'],
    [...valid, '--max-duration-ms', '60000'], [...valid, '--resource-runtime', 'relative'],
    [...valid, '--resource-runtime', '/private/a/../runtime'], [...valid, '--resource-runtime', '/private/secret\nunsafe'],
    [...valid, '--max-concurrent', '0'], [...valid, '--max-concurrent', '5'],
    [...valid, '--max-concurrent', '1.5'], [...valid, '--max-concurrent', '1e0'],
    [...valid, '--poll-interval-ms', '49'], [...valid, '--poll-interval-ms', '60001'],
    ['first', '--root', '/', '--max-duration-ms', '60000'],
    ['first', '--root', 'relative', '--max-duration-ms', '60000'],
    ['first', '--root', '/private/store/', '--max-duration-ms', '60000'],
    ['first', '--root', '/private/store\u0085hidden', '--max-duration-ms', '60000'],
    ['first', '--root', '/private/store', '--max-duration-ms', '0'],
    ['first', '--root', '/private/store', '--max-duration-ms', '86400001'],
    ['first', '--root', '/private/store', '--max-duration-ms', 'Infinity'],
    ['first', '--root', '/private/store', '--max-duration-ms', '01'],
    [...Array.from({ length: 33 }, (_, i) => `campaign-${i}`), '--root', '/private/store', '--max-duration-ms', '1000'],
  ])('rejects malformed arguments before dispatch %j', async (...args) => {
    expect(await cmdUniverseSupervise(args)).toBe(2);
    expect(core.superviseUniverseCampaigns).not.toHaveBeenCalled();
  });

  it('forwards the explicit queue and validated bounds with one final JSON report', async () => {
    expect(await cmdUniverseSupervise([...valid, 'second', '--max-concurrent', '2', '--poll-interval-ms', '250',
      '--resource-runtime', '/private/runtime.json', '--json'])).toBe(0);
    expect(core.superviseUniverseCampaigns).toHaveBeenCalledExactlyOnceWith(['first', 'second'], {
      root: '/private/experiments', maxDurationMs: 60000, maxConcurrent: 2, pollIntervalMs: 250,
      resourceRuntime: '/private/runtime.json', signal: expect.any(AbortSignal),
    });
    expect(console.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(report(), null, 2));
    expect(console.error).not.toHaveBeenCalled();
  });

  it('uses documented defaults and exposes transitions in text mode', async () => {
    core.superviseUniverseCampaigns.mockImplementation(async (_ids, options) => {
      options.onTransition({ campaignId: 'first', status: 'running', reasonCode: 'dispatched' });
      return report();
    });
    expect(await cmdUniverseSupervise(valid)).toBe(0);
    expect(core.superviseUniverseCampaigns.mock.calls[0]![1]).toMatchObject({ maxConcurrent: 1, pollIntervalMs: 500 });
    expect(console.error).toHaveBeenCalledWith('first · running · dispatched');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Campaign completion is not proof of project success'));
  });

  it.each([['incomplete', 1], ['failed', 1], ['timed-out', 1], ['cancelled', 130]] as const)(
    'does not mark %s as successful queue completion', async (state, exitCode) => {
      core.superviseUniverseCampaigns.mockResolvedValue(report(state));
      expect(await cmdUniverseSupervise([...valid, '--json'])).toBe(exitCode);
    });

  it.each(['SIGINT', 'SIGTERM'] as const)('cancels and awaits the supervisor before removing %s listeners', async (signal) => {
    const before = process.listenerCount(signal); let settled = false;
    core.superviseUniverseCampaigns.mockImplementation(async (_ids, options) => {
      process.emit(signal);
      expect(options.signal.aborted).toBe(true);
      await Promise.resolve(); settled = true; return report('cancelled');
    });
    expect(await cmdUniverseSupervise([...valid, '--json'])).toBe(130);
    expect(settled).toBe(true); expect(process.listenerCount(signal)).toBe(before);
  });

  it('redacts unexpected runtime errors and removes signal listeners', async () => {
    const before = process.listenerCount('SIGTERM');
    core.superviseUniverseCampaigns.mockRejectedValue(new Error('EACCES /private/credential.json'));
    expect(await cmdUniverseSupervise([...valid, '--json'])).toBe(1);
    expect(console.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ error: 'Campaign supervision unavailable; inspect the scoped campaign evidence' }));
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('documents operation without dispatch when help is requested', async () => {
    expect(await cmdUniverseSupervise(['--help'])).toBe(0);
    expect(core.superviseUniverseCampaigns).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No daemon is installed'));
  });

  it('routes through the existing campaign entrypoint', async () => {
    const { cmdUniverseCampaign } = await import('../src/cli/universe-campaign.js');
    expect(await cmdUniverseCampaign(['supervise', ...valid, '--json'])).toBe(0);
    expect(core.superviseUniverseCampaigns).toHaveBeenCalledOnce();
  });
});
