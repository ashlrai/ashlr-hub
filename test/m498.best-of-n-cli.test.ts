import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ loadConfig: vi.fn() }));

vi.mock('../src/core/config.js', () => ({ loadConfig: mocks.loadConfig }));

import { cmdBestOfN } from '../src/cli/best-of-n.js';

describe('M498 — best-of-N CLI count boundary', () => {
  beforeEach(() => {
    mocks.loadConfig.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['8junk', '1.5', 'Infinity', '0', '-1', '9007199254740992'])(
    'rejects explicit malformed count %s before loading config or model code',
    async (count) => {
      await expect(cmdBestOfN([
        '--repo', '/tmp/example', '--title', 'Bound fan-out', '-n', count,
      ])).resolves.toBe(2);
      expect(mocks.loadConfig).not.toHaveBeenCalled();
    },
  );

  it('rejects a missing explicit count before loading config or model code', async () => {
    await expect(cmdBestOfN([
      '--repo', '/tmp/example', '--title', 'Bound fan-out', '-n',
    ])).resolves.toBe(2);
    expect(mocks.loadConfig).not.toHaveBeenCalled();
  });
});
