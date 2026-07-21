/**
 * M443 -- daemon install help is a read-only CLI contract.
 *
 * The service module is mocked so a regression that reaches install or service
 * status is immediately visible without ever touching launchd/systemd.
 */

import { describe, expect, it, vi } from 'vitest';

const install = vi.fn();
const ensureRunning = vi.fn();
const serviceStatus = vi.fn();

vi.mock('../src/core/daemon/service.js', () => ({
  install,
  ensureRunning,
  serviceStatus,
  uninstall: vi.fn(),
}));

import { cmdDaemon } from '../src/cli/daemon.js';

async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  let out = '';
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out += `${args.map(String).join(' ')}\n`;
  });
  try {
    return { code: await fn(), out };
  } finally {
    logSpy.mockRestore();
  }
}

describe('M443 daemon install help', () => {
  it.each([['--help'], ['-h'], ['help']])('prints help without mutating for %s', async (helpFlag) => {
    const { code, out } = await captureStdout(() => cmdDaemon(['install', helpFlag]));

    expect(code).toBe(0);
    expect(out).toContain('Usage: ashlr daemon install [--no-autostart]');
    expect(install).not.toHaveBeenCalled();
    expect(ensureRunning).not.toHaveBeenCalled();
    expect(serviceStatus).not.toHaveBeenCalled();
  });
});
