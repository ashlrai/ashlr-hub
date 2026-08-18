/**
 * Windows support for the M461/M470 activation-authority stores.
 *
 * Historically this file pinned a single behaviour: `win32` was denied
 * outright, unconditionally, everywhere. That denial gate is gone — the
 * underlying store validation (trust roots, standing grants, the once/
 * resident permit) already ran through `assurePrivateStoragePath`
 * (../src/core/util/private-storage.ts), which has had a real Windows DACL
 * adapter (PowerShell + exact current-user+SYSTEM protected ACL, reparse-
 * point rejection on the target and every ancestor up to the ~/.ashlr
 * anchor) since M380/M379. The blanket `activation-permit-v1-unsupported-
 * on-windows` gates in activation-permit.ts were the only thing standing
 * between that adapter and a working Windows activation flow.
 *
 * Two kinds of coverage live here:
 *
 *  - "platform-mocked" tests (no skipIf — run on every CI lane, including
 *    macOS/Linux): force `process.platform = 'win32'` via the shared
 *    `withPlatform` helper. Some also mock `assurePrivateStoragePath` at
 *    its module boundary (the same pattern m380.reconciliation-key-windows
 *    already uses) to prove success semantics that cannot be observed
 *    without a real Windows box. Others deliberately do NOT mock it, to
 *    exercise the real win32 branch of private-storage.ts (which fails
 *    closed for a mundane, honest reason on a Mac: no PowerShell binary at
 *    the expected path). Every property proven this way is proven for the
 *    CONTROL FLOW — that the right calls happen in the right order with
 *    the right fail-closed behavior — not for real NTFS ACL enforcement.
 *
 *  - the `describe.skipIf(process.platform !== 'win32')` block: real,
 *    unmocked, end-to-end lifecycle tests that only ever execute on the
 *    real windows-latest CI lanes this repo already runs (including
 *    "Windows service authority (Server 2022)"). These are the only tests
 *    in the whole suite that prove real NTFS DACL behavior.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { withPlatform } from './helpers/platform.js';

const mocks = vi.hoisted(() => ({ assure: vi.fn() }));
vi.mock('../src/core/util/private-storage.js', () => ({
  assurePrivateStoragePath: mocks.assure,
}));

import {
  consumeDaemonActivationPermit,
  consumeDaemonActivationPermitForVerification,
  consumeGoalConductorActivationPermitForVerification,
  daemonActivationConfigDigest,
  daemonActivationInit,
  daemonActivationMintOneShotPermit,
  daemonActivationMintStandingGrant,
  daemonActivationPermitPath,
  daemonActivationScopeGranted,
  inspectDaemonActivationPermitForVerification,
  loadDaemonActivationTrustRoots,
  type DaemonActivationGrantScope,
  type DaemonActivationRuntimeContext,
  type DaemonActivationTrustRoot,
  EMPTY_DAEMON_ACTIVATION_SCOPE,
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

function scope(overrides: Partial<DaemonActivationGrantScope>): DaemonActivationGrantScope {
  return { ...EMPTY_DAEMON_ACTIVATION_SCOPE, ...overrides };
}

afterEach(() => {
  restoreEnvironment();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  mocks.assure.mockReset();
});

// ---------------------------------------------------------------------------
// Platform-mocked: runs on every CI lane. Proves control flow, not real ACLs.
// ---------------------------------------------------------------------------

describe('Windows activation authority (platform-mocked)', () => {
  it('is no longer a blanket denial: trust-root init + standing-grant lifecycle succeed when the DACL adapter reports safe', () => {
    mocks.assure.mockReturnValue({ ok: true, reason: 'exact-private-dacl' });
    withPlatform('win32', () => {
      isolateHome();
      const init = daemonActivationInit({ label: 'win32-operator' });
      expect(init.ok).toBe(true);
      if (!init.ok) return;
      expect(loadDaemonActivationTrustRoots()).toEqual([
        { keyId: init.keyId, publicKeyPem: init.publicKeyPem },
      ]);

      const minted = daemonActivationMintStandingGrant({
        scope: scope({ residentStanding: true }),
        ttlMs: 60_000,
      });
      expect(minted.ok).toBe(true);
      if (!minted.ok) return;
      expect(daemonActivationScopeGranted('residentStanding')).toMatchObject({ granted: true });
    });
  });

  it('mints a real standing grant and consumes it end-to-end via the production entrypoint when the DACL adapter reports safe', () => {
    // `consumeDaemonActivationPermit`'s residentStanding fast path loads
    // real trust roots from disk and short-circuits BEFORE ever touching
    // release-tree/executable hashing — see its own doc comment for why
    // that's exactly what makes an unattended restart possible. That is
    // what makes it safe to exercise for real here, under a win32 platform
    // override, without needing argv[1]-relative release-tree discovery
    // (which m461.activation-permit.test.ts already exercises for real on
    // POSIX and is orthogonal to what changed in this pass).
    mocks.assure.mockReturnValue({ ok: true, reason: 'exact-private-dacl' });
    withPlatform('win32', () => {
      isolateHome();
      const cfg = config();
      const generated = daemonActivationInit({});
      expect(generated.ok).toBe(true);
      if (!generated.ok) return;

      const minted = daemonActivationMintStandingGrant({
        scope: scope({ residentStanding: true }),
        ttlMs: 60_000,
      });
      expect(minted.ok).toBe(true);
      if (!minted.ok) return;

      const consumption = consumeDaemonActivationPermit(cfg, { once: false, dryRun: false });
      expect(consumption.authorized).toBe(true);
      expect(consumption.grantId).toBe(minted.record.grantId);
      expect(consumption.reason).toContain('resident-standing-activation-authorized');
      expect(existsSync(daemonActivationPermitPath())).toBe(false);
    });
  });

  it('fails closed with a distinct reason when the DACL adapter reports an untrusted ancestor owner — never a silent pass', () => {
    // `assurePrivateDirectory` throws (rather than returning a value) when
    // the adapter denies directory creation/inspection — the same behavior
    // POSIX already has for this exceptional "the store's parent directory
    // is not safely owned" condition; unchanged by this pass, just now
    // reachable on Windows too instead of being masked by the blanket
    // platform denial that used to run first.
    mocks.assure.mockReturnValue({ ok: false, reason: 'untrusted-ancestor-owner' });
    withPlatform('win32', () => {
      isolateHome();
      expect(() => daemonActivationInit({ label: 'hostile-ancestor' }))
        .toThrow('unsafe-private-directory:untrusted-ancestor-owner');
      expect(loadDaemonActivationTrustRoots()).toEqual([]);
    });
  });

  it('fails closed with a distinct reason when the DACL adapter reports a reparse point — the Windows analog of O_NOFOLLOW/ELOOP rejection', () => {
    mocks.assure.mockReturnValue({ ok: false, reason: 'reparse-point' });
    withPlatform('win32', () => {
      isolateHome();
      const cfg = config();
      const key: DaemonActivationTrustRoot = {
        keyId: 'reparse-test-root',
        publicKeyPem: 'irrelevant-not-reached-before-adapter-denial',
      };
      const inspection = inspectDaemonActivationPermitForVerification(
        cfg,
        { once: true, dryRun: false },
        { trustRoots: [key], context: runtimeContext(cfg) },
      );
      expect(inspection.state).not.toBe('ready');
      expect(inspection.commandEligible).toBe(false);

      const consumption = consumeDaemonActivationPermitForVerification(
        cfg,
        { once: true, dryRun: false },
        { trustRoots: [key], context: runtimeContext(cfg) },
      );
      expect(consumption.authorized).toBe(false);
      expect(existsSync(daemonActivationPermitPath())).toBe(false);
    });
  });

  it('fails closed with a distinct reason when the DACL adapter itself is unavailable (real, unmocked win32 branch: no PowerShell on this host)', () => {
    // Deliberately NOT mocked: this exercises the actual win32 branch of
    // assurePrivateStoragePath. With no `SystemRoot` pointing at a real
    // Windows install, `powershellPath()` returns null and the adapter
    // reports `powershell-unavailable` before ever touching the filesystem
    // it was asked to inspect. That failure propagates as a distinct,
    // non-generic reason — never a silent pass.
    withPlatform('win32', () => {
      isolateHome();
      const cfg = config();
      const key: DaemonActivationTrustRoot = {
        keyId: 'adapter-unavailable-root',
        publicKeyPem: 'irrelevant-not-reached-before-adapter-denial',
      };
      const inspection = inspectDaemonActivationPermitForVerification(
        cfg,
        { once: true, dryRun: false },
        { trustRoots: [key], context: runtimeContext(cfg) },
      );
      expect(inspection).toMatchObject({
        state: 'degraded',
        commandEligible: false,
        reason: 'activation-permit-inspection-failed',
      });
      expect(existsSync(daemonActivationPermitPath())).toBe(false);
    });
  });

  it('goal-conductor proposal permits remain denied on Windows (out of scope for this pass)', () => {
    withPlatform('win32', () => {
      isolateHome();
      const cfg = config();
      const key: DaemonActivationTrustRoot = {
        keyId: 'goal-conductor-root',
        publicKeyPem: 'not-read-before-platform-denial',
      };
      const result = consumeGoalConductorActivationPermitForVerification(cfg, {
        goalId: 'g'.repeat(32),
        milestoneId: 'm'.repeat(32),
        goalDigest: 'd'.repeat(64),
        projectPath: '/repo',
      }, { trustRoots: [key] });
      expect(result).toEqual({
        authorized: false,
        reason: 'goal-conductor-activation-v1-unsupported-on-windows',
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Real Windows only. Runs unmocked, only on windows-latest CI.
// ---------------------------------------------------------------------------

describe.skipIf(process.platform !== 'win32')('native Windows activation readiness', () => {
  it('runs a real init -> standing-grant -> once-permit lifecycle against a live NTFS DACL', () => {
    isolateHome();
    const cfg = config();

    const init = daemonActivationInit({ label: 'native-windows-operator' });
    expect(init.ok).toBe(true);
    if (!init.ok) return;
    expect(loadDaemonActivationTrustRoots()).toEqual([
      { keyId: init.keyId, publicKeyPem: init.publicKeyPem },
    ]);

    const minted = daemonActivationMintStandingGrant({
      scope: scope({ residentStanding: true }),
      ttlMs: 60_000,
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(daemonActivationScopeGranted('residentStanding')).toMatchObject({ granted: true });

    const permit = daemonActivationMintOneShotPermit({ cfg, scope: scope({ once: true, proposalOnly: true }) });
    expect(permit.ok).toBe(true);
    if (!permit.ok) return;
    expect(existsSync(daemonActivationPermitPath())).toBe(true);

    const inspection = inspectDaemonActivationPermitForVerification(
      cfg,
      { once: true, dryRun: false },
      { trustRoots: loadDaemonActivationTrustRoots(), context: runtimeContext(cfg) },
    );
    expect(inspection.state).toBe('ready');

    const consumption = consumeDaemonActivationPermitForVerification(
      cfg,
      { once: true, dryRun: false },
      { trustRoots: loadDaemonActivationTrustRoots(), context: runtimeContext(cfg) },
    );
    expect(consumption.authorized).toBe(true);
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
