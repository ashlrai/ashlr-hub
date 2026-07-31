import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serviceActivity } from '../src/core/daemon/service-activity.js';
import { ensureRunning, install } from '../src/core/daemon/service.js';

describe('resident service production admission', () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { force: true, recursive: true });
  });

  it('refuses installation before creating or activating a service', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ashlr-resident-admission-'));
    homes.push(home);

    await expect(install({
      platform: 'darwin',
      homeDir: home,
      nodePath: process.execPath,
      binPath: join(home, 'bin', 'ashlr'),
    })).rejects.toThrow('externally authenticated resident activation authority is unavailable');

    expect(await ensureRunning({ platform: 'darwin', homeDir: home })).toMatchObject({
      installed: false,
      running: false,
      productionReady: false,
      residentActivationAuthorized: false,
      residentActivationBlocker: 'resident-activation-authority-unavailable',
    });
  });

  it('does not label a scheduler process as functional without resident authority', () => {
    expect(serviceActivity({
      running: true,
      platformSpec: 'launchd',
      residentActivationAuthorized: false,
    })).toBe('blocked');
  });
});
