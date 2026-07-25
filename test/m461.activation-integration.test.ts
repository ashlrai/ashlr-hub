import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AshlrConfig } from '../src/core/types.js';
import { runDaemon, tick } from '../src/core/daemon/loop.js';
import { runConductor } from '../src/core/goals/conductor.js';
import { runSimpleConductor } from '../src/core/simple-conductor.js';

const originalHome = process.env['HOME'];
const originalUserProfile = process.env['USERPROFILE'];
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ashlr-m461-integration-'));
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  delete process.env['ASHLR_IN_DAEMON'];
  delete process.env['ASHLR_IN_SWARM'];
});

afterEach(() => {
  if (originalHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = originalHome;
  if (originalUserProfile === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = originalUserProfile;
  delete process.env['ASHLR_IN_DAEMON'];
  delete process.env['ASHLR_IN_SWARM'];
  rmSync(home, { recursive: true, force: true });
});

describe('M461 core activation integration', () => {
  it('refuses a direct live tick before daemon state or dispatch mutation', async () => {
    const result = await tick({} as AshlrConfig, { dryRun: false });

    expect(result).toMatchObject({
      reason: 'activation-refused',
      itemsConsidered: 0,
      proposalsCreated: 0,
      spentUsd: 0,
    });
    expect(existsSync(join(home, '.ashlr', 'daemon.json'))).toBe(false);
  });

  it('refuses a live one-shot start when repository trust roots are empty', async () => {
    const result = await runDaemon(
      {} as AshlrConfig,
      { once: true, dryRun: false },
    );

    expect(result.running).toBe(false);
    expect(result.startRefusal).toBe('no-trusted-activation-roots');
    expect(existsSync(join(home, '.ashlr', 'daemon.json'))).toBe(false);
  });

  it('refuses resident dry-run shape instead of treating it as observation-only', async () => {
    const result = await runDaemon(
      {} as AshlrConfig,
      { once: false, dryRun: true, maxCycles: 1 },
    );

    expect(result.running).toBe(false);
    expect(result.startRefusal).toBe(
      'activation-permit-cannot-authorize-requested-start-shape',
    );
    expect(existsSync(join(home, '.ashlr', 'daemon.json'))).toBe(false);
  });

  it('keeps the broader goal conductor dormant without separate authority', async () => {
    const result = await runConductor(
      {} as AshlrConfig,
      { once: true, dryRun: false, allowCloud: false },
    );

    expect(result.activationRefused).toBe(true);
    expect(result.goalsAdvanced).toBe(0);
    expect(result.proposalsFiled).toBe(0);
    expect(existsSync(join(home, '.ashlr'))).toBe(false);
  });

  it('keeps the automerging simple conductor dormant without separate authority', async () => {
    const result = await runSimpleConductor(
      {} as AshlrConfig,
      { once: true, dryRun: false, allowCloud: false },
    );

    expect(result.activationRefused).toBe(true);
    expect(result.tasksAttempted).toBe(0);
    expect(result.merged).toBe(0);
    expect(existsSync(join(home, '.ashlr'))).toBe(false);
  });
});
