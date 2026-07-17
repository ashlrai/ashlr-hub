import { afterEach, describe, expect, it, vi } from 'vitest';

const loopMocks = vi.hoisted(() => ({
  stopDaemon: vi.fn(),
}));

vi.mock('../src/core/daemon/loop.js', () => ({
  runDaemon: vi.fn(),
  stopDaemon: loopMocks.stopDaemon,
}));

import { cmdDaemon } from '../src/cli/daemon.js';

afterEach(() => {
  vi.restoreAllMocks();
  loopMocks.stopDaemon.mockReset();
});

describe('M406 daemon stop quiescence', () => {
  it('returns nonzero without false-green success when shutdown is not quiesced', async () => {
    loopMocks.stopDaemon.mockReturnValue({
      ok: false,
      changed: true,
      quiesced: false,
      reason: 'kill armed; an outward mutation has not quiesced',
    });
    const logs: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.join(' ')));

    await expect(cmdDaemon(['stop'])).resolves.toBe(1);

    expect(errors.join('\n')).toMatch(/could not confirm quiescence/i);
    expect(logs.join('\n')).not.toMatch(/daemon stop requested/i);
  });

  it('preserves success when shutdown is quiesced', async () => {
    loopMocks.stopDaemon.mockReturnValue({
      ok: true,
      changed: true,
      quiesced: true,
      reason: 'kill armed; outward mutations quiesced',
    });
    const logs: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.join(' ')));

    await expect(cmdDaemon(['stop'])).resolves.toBe(0);

    expect(logs.join('\n')).toMatch(/daemon stop requested/i);
    expect(errors).toHaveLength(0);
  });
});
