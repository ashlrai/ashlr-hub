import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { tick } from '../src/core/daemon/loop.js';
import type { AshlrConfig } from '../src/core/types.js';

const originalHome = {
  HOME: process.env['HOME'],
  USERPROFILE: process.env['USERPROFILE'],
  ASHLR_HOME: process.env['ASHLR_HOME'],
};
const homes: string[] = [];

function isolateHome(): void {
  const home = mkdtempSync(join(tmpdir(), 'ashlr-m537-'));
  homes.push(home);
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  process.env['ASHLR_HOME'] = join(home, '.ashlr');
}

function config(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'vscode',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    telemetry: {},
    tools: {},
  };
}

afterEach(() => {
  for (const [key, value] of Object.entries(originalHome)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('M537 daemon tick authority capability', () => {
  it('refuses a forged all-true structural activation scope', async () => {
    isolateHome();

    const result = await tick(config(), {
      dryRun: false,
      activationScope: {
        once: true,
        resident: true,
        residentStanding: false,
        conductor: true,
        automerge: true,
        repair: true,
        deploy: true,
        install: true,
        proposalOnly: true,
      },
    } as Parameters<typeof tick>[1]);

    expect(result).toMatchObject({
      reason: 'activation-refused',
      itemsConsidered: 0,
      proposalsCreated: 0,
      spentUsd: 0,
    });
  });

  it('refuses a serialized lookalike resident tick capability', async () => {
    isolateHome();

    const result = await tick(config(), {
      dryRun: false,
      residentTickCapability: { kind: 'daemon-resident-tick' },
    } as Parameters<typeof tick>[1]);

    expect(result.reason).toBe('activation-refused');
  });
});
