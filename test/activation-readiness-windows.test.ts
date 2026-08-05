import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  consumeDaemonActivationPermitForVerification,
  daemonActivationConfigDigest,
  daemonActivationPermitPath,
  inspectDaemonActivationPermitForVerification,
  type DaemonActivationRuntimeContext,
  type DaemonActivationTrustRoot,
} from '../src/core/daemon/activation-permit.js';
import { buildFleetStatus } from '../src/core/fleet/status.js';
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
  const home = mkdtempSync(join(tmpdir(), 'ashlr-activation-windows-'));
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

function runtimeContext(cfg: AshlrConfig): DaemonActivationRuntimeContext {
  const binding = { path: 'C:\\ashlr\\runtime', sha256: 'a'.repeat(64) };
  return {
    nowMs: Date.UTC(2026, 6, 25, 12),
    configDigest: daemonActivationConfigDigest(cfg),
    buildIdentity: {
      schemaVersion: 1,
      packageVersion: '3.1.0',
      revision: 'b'.repeat(40),
      dirty: false,
      provenance: 'git',
    },
    executable: binding,
    entrypoint: binding,
    releaseTree: binding,
    authorityStateDigest: 'c'.repeat(64),
    killSwitchOff: true,
    guardHealthHealthy: true,
  };
}

afterEach(() => {
  restoreEnvironment();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'win32')('native Windows activation readiness', () => {
  it('refuses inspection and consumption before activation filesystem mutation', () => {
    isolateHome();
    const cfg = config();
    const root: DaemonActivationTrustRoot = {
      keyId: 'native-windows-root',
      publicKeyPem: 'not-read-before-platform-denial',
    };
    const options = {
      trustRoots: [root],
      context: runtimeContext(cfg),
    };

    const inspection = inspectDaemonActivationPermitForVerification(
      cfg,
      { once: true, dryRun: false },
      options,
    );
    const consumption = consumeDaemonActivationPermitForVerification(
      cfg,
      { once: true, dryRun: false },
      options,
    );

    expect(inspection).toMatchObject({
      state: 'blocked',
      commandEligible: false,
      reason: 'activation-permit-v1-unsupported-on-windows',
    });
    expect(consumption).toMatchObject({
      authorized: false,
      required: true,
      reason: 'activation-permit-v1-unsupported-on-windows',
    });
    expect(existsSync(daemonActivationPermitPath())).toBe(false);
  });

  it('projects only read-only stopped-daemon commands without production roots', async () => {
    isolateHome();

    const status = await buildFleetStatus(config());
    const commands = status.nextActions?.flatMap((action) => action.commands ?? []) ?? [];

    expect(status.daemon.activation).toMatchObject({
      authority: 'observation-only',
      commandEligible: false,
      residentAuthorized: false,
      installAuthorized: false,
      repairAuthorized: false,
    });
    expect(status.nextActions?.find((action) => action.id === 'inspect-daemon-activation'))
      .toBeDefined();
    expect(commands.some((command) =>
      command.argv.join(' ') === 'ashlr daemon start'
      || command.argv.join(' ') === 'ashlr daemon start --once'
      || command.argv.join(' ') === 'ashlr daemon install'
      || command.endpointPath === '/api/daemon/service/repair'
    )).toBe(false);
  });
});
