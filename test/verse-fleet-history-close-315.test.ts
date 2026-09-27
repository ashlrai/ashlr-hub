/**
 * 3.15 integration: `ashlr verse` did not exit after SIGINT/SIGTERM once the Fleet surface
 * had loaded — the fleet-history service's scorecard worker (a worker thread, created on
 * the first GET /api/verse/fleet/history) was never closed, and its MessagePort kept the
 * event loop alive. The web server's close() now calls closeFleetHistoryService().
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  closeFleetHistoryService,
  getFleetHistoryService,
  resetFleetHistoryServiceForTests,
  type FleetHistoryService,
} from '../src/core/verse/fleet-history.js';

afterEach(async () => { await resetFleetHistoryServiceForTests(null); });

function fakeService(close: () => Promise<void>): FleetHistoryService {
  return { get: vi.fn(), getPayload: vi.fn(), close } as unknown as FleetHistoryService;
}

describe('closeFleetHistoryService', () => {
  it('closes the live service once, and a later request gets a fresh one', async () => {
    const close = vi.fn(async () => {});
    const service = fakeService(close);
    await resetFleetHistoryServiceForTests(service);
    expect(getFleetHistoryService()).toBe(service);
    await closeFleetHistoryService();
    await closeFleetHistoryService();
    expect(close).toHaveBeenCalledTimes(1);
    expect(getFleetHistoryService()).not.toBe(service);
  });

  it('never creates a service just to close it, and swallows a failing close', async () => {
    await expect(closeFleetHistoryService()).resolves.toBeUndefined();
    await resetFleetHistoryServiceForTests(fakeService(async () => { throw new Error('worker gone'); }));
    await expect(closeFleetHistoryService()).resolves.toBeUndefined();
  });

  it('the web server closes it on shutdown', () => {
    const server = readFileSync(join(__dirname, '..', 'src', 'core', 'web', 'server.ts'), 'utf8');
    const close = server.slice(server.indexOf('async close(): Promise<void> {'));
    expect(close).toContain("import('../verse/fleet-history.js')");
    expect(close).toContain('closeFleetHistoryService()');
  });
});
