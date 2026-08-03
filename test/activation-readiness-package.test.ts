import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { AshlrConfig } from '../src/core/types.js';

const originalHomeEnvironment = {
  HOME: process.env['HOME'],
  USERPROFILE: process.env['USERPROFILE'],
  ASHLR_HOME: process.env['ASHLR_HOME'],
};
const homes: string[] = [];

function restoreEnvironment(): void {
  for (const [key, value] of Object.entries(originalHomeEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function isolateHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'ashlr-m462-package-'));
  homes.push(home);
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  process.env['ASHLR_HOME'] = join(home, '.ashlr');
  return home;
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
    models: {
      lmstudio: '',
      ollama: '',
      providerChain: [],
    },
    telemetry: {},
    tools: {},
  };
}

afterEach(() => {
  restoreEnvironment();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('compiled activation-readiness surface', () => {
  it('projects fail-closed activation through dist, the CLI, and copied dashboard assets', async () => {
    const home = isolateHome();
    const distStatusPath = join(process.cwd(), 'dist', 'core', 'fleet', 'status.js');
    const distCliPath = join(process.cwd(), 'dist', 'cli', 'index.js');
    const binPath = join(process.cwd(), 'bin', 'ashlr');
    const distDashboardPath = join(process.cwd(), 'dist', 'core', 'web', 'public', 'app.js');
    expect(existsSync(distStatusPath)).toBe(true);
    expect(existsSync(distCliPath)).toBe(true);
    expect(existsSync(binPath)).toBe(true);
    expect(existsSync(distDashboardPath)).toBe(true);

    const module = await import(pathToFileURL(distStatusPath).href) as {
      buildFleetStatus(cfg: AshlrConfig): Promise<{
        daemon: {
          activation?: {
            authority: string;
            commandEligible: boolean;
            repairAuthorized: boolean;
          };
        };
      }>;
    };
    const status = await module.buildFleetStatus(config());
    expect(status.daemon.activation).toMatchObject({
      authority: 'observation-only',
      commandEligible: false,
      repairAuthorized: false,
    });

    const configDir = join(home, '.ashlr');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), `${JSON.stringify(config())}\n`, 'utf8');
    const cli = spawnSync(process.execPath, [binPath, 'fleet', 'status', '--json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ASHLR_HOME: configDir,
      },
      timeout: 60_000,
    });
    expect(cli.error).toBeUndefined();
    expect(cli.status, cli.stderr).toBe(0);
    const cliStatus = JSON.parse(cli.stdout) as {
      daemon?: {
        activation?: {
          authority?: string;
          commandEligible?: boolean;
          installAuthorized?: boolean;
        };
      };
    };
    expect(cliStatus.daemon?.activation).toMatchObject({
      authority: 'observation-only',
      commandEligible: false,
      installAuthorized: false,
    });

    const dashboard = readFileSync(distDashboardPath, 'utf8');
    expect(dashboard).toContain('Inspect Fleet Status for activation authority.');
    expect(dashboard).toContain('Daemon activation may be blocked; inspect Fleet Status.');
    expect(dashboard).not.toContain('Start the daemon with `ashlr daemon start`.');
    expect(dashboard).not.toContain("apiPost('/api/daemon/service/repair'");
  });
});
