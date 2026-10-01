import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { loadConfig, runSwarm } = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  runSwarm: vi.fn(),
}));
vi.mock('../src/core/config.js', () => ({ loadConfig }));
vi.mock('../src/core/swarm/runner.js', () => ({ runSwarm }));
vi.mock('../src/core/run/streaming.js', () => ({ makeCliSink: () => () => {} }));

import { cmdSwarm } from '../src/cli/swarm.js';

beforeEach(() => {
  vi.stubEnv('ASHLR_IN_SWARM', '');
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  loadConfig.mockReset().mockReturnValue({ version: 1 });
  runSwarm.mockReset().mockResolvedValue({ id: 'mock-swarm', status: 'done' });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('swarm BUILD parallel CLI preference', () => {
  it.each(['17.5', '17junk', '0', '-1', '9007199254740992', 'Infinity', 'NaN', '1e2', ' 17', ''])(
    'refuses %j before config or swarm dispatch', async (raw) => {
      expect(await cmdSwarm(['build independent modules', '--parallel', raw, '--json'])).toBe(2);
      expect(loadConfig).not.toHaveBeenCalled();
      expect(runSwarm).not.toHaveBeenCalled();
      expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('positive safe integer'));
    },
  );

  it('refuses a missing preference before dispatch', async () => {
    expect(await cmdSwarm(['build independent modules', '--parallel'])).toBe(2);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(runSwarm).not.toHaveBeenCalled();
  });

  it.each([9, 17, Number.MAX_SAFE_INTEGER])('passes valid %s unchanged without widening cloud authority', async (parallel) => {
    expect(await cmdSwarm(['build independent modules', '--parallel', String(parallel), '--json'])).toBe(0);
    expect(runSwarm).toHaveBeenCalledOnce();
    expect(runSwarm.mock.calls[0]?.[2]).toMatchObject({ parallel, allowCloud: false, background: false });
  });
});
