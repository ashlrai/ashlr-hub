/**
 * Resident runtime under the operator's standing grant (docs/RESIDENT-RUNTIME.md).
 *
 *   - the admission verdict: blocked without an active grant (none / unsigned /
 *     expired / revoked), a dirty or unknown build, a non-compiled release or
 *     a non-mac host; waiting-on-you for Stop and the switch; admitted only
 *     when everything holds
 *   - agents cannot start it: agent / daemon / swarm env markers, a redirected
 *     HOME or no TTY refuse the mint even under an active grant
 *   - the capability is single-use, unforgeable, and lowering (Stop, revoke)
 *     between mint and claim wins
 *   - the service install path claims it before ANY effect; the legacy
 *     install / ensureRunning stay denied
 *   - the plist budget derives from config, and drift is detected
 *
 * The compiled trust roots are replaced by a test root through module mocking
 * (production code has no hook that could add one); host / surface /
 * confinement / build identity probes are faked; the grant, ledger, clamp and
 * capability code is real, in a temporary HOME. No launchctl ever runs.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({
  confinement: true,
  packageRoot: '/test/release' as string | null,
  build: { schemaVersion: 1, packageVersion: '3.12.0', revision: 'f'.repeat(40), dirty: false, provenance: 'git' } as {
    schemaVersion: 1; packageVersion: string | null; revision: string | null; dirty: boolean | null; provenance: 'git' | 'github-actions' | 'unavailable';
  },
}));

// Pass-through spies: the private-storage checks legitimately read ACLs with
// `ls`; a launchctl call is what must never happen before a claim.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFileSync = vi.fn(actual.execFileSync);
  const spawnSync = vi.fn(actual.spawnSync);
  return { ...actual, default: { ...actual, execFileSync, spawnSync }, execFileSync, spawnSync };
});

function launchctlCalls(): unknown[][] {
  const calls = [
    ...vi.mocked(childProcess.execFileSync).mock.calls,
    ...vi.mocked(childProcess.spawnSync).mock.calls,
  ] as unknown[][];
  return calls.filter((call) => JSON.stringify(call).includes('launchctl'));
}

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  // The operator check compares $HOME with the password-database home; the
  // test HOME is a temp dir, so the "password database" follows it.
  const userInfo = ((...args: Parameters<typeof actual.userInfo>) => ({ ...actual.userInfo(...args), homedir: process.env['HOME'] ?? '' })) as typeof actual.userInfo;
  return { ...actual, default: { ...actual, userInfo }, userInfo };
});

vi.mock('../src/core/authority/trust-roots.js', async () => {
  const helpers = await import('./helpers/authority-310b.js');
  return { STANDING_GRANT_TRUST_ROOTS: Object.freeze([helpers.TEST_ROOT]), BURNED_KEY_IDS: Object.freeze(['mason-workstation']) };
});

vi.mock('../src/core/authority/surface.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/core/authority/surface.js')>();
  return {
    ...original,
    currentHostBinding: () => 'a'.repeat(64),
    confinementAvailable: () => (probe.confinement ? { ok: true } : { ok: false, reason: 'no sandbox in this test' }),
    runningPackageRoot: () => probe.packageRoot,
    verifyAuthoritySurface: (target: 'running' | 'installed') => ({
      ok: true, target, packageRoot: '/test/release', digest: 'b'.repeat(64), fileCount: 1, checkedAt: new Date().toISOString(),
    }),
  };
});

vi.mock('../src/core/build-identity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/build-identity.js')>()),
  readBuildIdentity: () => ({ ...probe.build }),
}));

vi.mock('../src/core/fleet/host-merge.js', () => ({
  revokeArmedHostMerges: () => ({ revoked: 0, failed: [] }),
}));

// The launchd transaction and the lifecycle fence are the only effects of an
// admitted install; both are observed, never executed.
const launchd = vi.hoisted(() => ({ installs: [] as { plistPath: string; content: string }[] }));
vi.mock('../src/core/daemon/launchd-plist-transaction.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/daemon/launchd-plist-transaction.js')>()),
  installLaunchdPlistTransaction: (opts: { plistPath: string; content: string }) => {
    launchd.installs.push({ plistPath: opts.plistPath, content: opts.content });
  },
}));
vi.mock('../src/core/daemon/service-lifecycle-fence.js', () => ({
  acquireDaemonServiceLifecycleFence: () => ({ token: 'test' }),
  releaseDaemonServiceLifecycleFence: () => undefined,
}));

import * as childProcess from 'node:child_process';
import { invalidateStandingPolicyCache, requestAutonomySwitch } from '../src/core/authority/effective-config.js';
import { resetLedgerCachesForTest } from '../src/core/authority/ledger.js';
import {
  NON_OPERATOR_ENV_MARKERS,
  claimResidentServiceCapability,
  evaluateResidentAdmission,
  mintResidentServiceCapability,
  observeResidentAdmission,
  operatorContextRefusal,
  plistBudgetUsd,
  residentPlistState,
  trustedResidentBuildIdentity,
  type ResidentAdmissionInput,
} from '../src/core/authority/resident.js';
import { installStandingGrant, installedGrantPath } from '../src/core/authority/standing-grant.js';
import { revokeStanding, stopAutonomy } from '../src/core/authority/clamp.js';
import * as service from '../src/core/daemon/service.js';
import { daemonServiceInstallOptions } from '../src/core/daemon/service-config.js';
import type { StandingGrantV1 } from '../src/core/authority/types.js';
import { STRANGER_PRIVATE_KEY, makeGrant, signGrant, withTempHome } from './helpers/authority-310b.js';

let home: string;
let restoreHome: () => void;
const savedEnv: Record<string, string | undefined> = {};
const savedTTY = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };

function setTTY(stdin: boolean, stdout: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: stdin, configurable: true, writable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: stdout, configurable: true, writable: true });
}

beforeEach(() => {
  ({ home, restore: restoreHome } = withTempHome('resident-admission-'));
  // The suite itself may run inside an agent shell (CLAUDECODE, AI_AGENT, …);
  // the operator scenarios start from a clean terminal environment.
  for (const marker of NON_OPERATOR_ENV_MARKERS) {
    savedEnv[marker] = process.env[marker];
    delete process.env[marker];
  }
  setTTY(true, true);
  probe.confinement = true;
  probe.packageRoot = '/test/release';
  probe.build = { schemaVersion: 1, packageVersion: '3.12.0', revision: 'f'.repeat(40), dirty: false, provenance: 'git' };
  launchd.installs = [];
  vi.mocked(childProcess.execFileSync).mockClear();
  vi.mocked(childProcess.spawnSync).mockClear();
  resetLedgerCachesForTest();
  invalidateStandingPolicyCache();
});

afterEach(() => {
  for (const marker of NON_OPERATOR_ENV_MARKERS) {
    if (savedEnv[marker] === undefined) delete process.env[marker];
    else process.env[marker] = savedEnv[marker];
  }
  setTTY(savedTTY.stdin === true, savedTTY.stdout === true);
  resetLedgerCachesForTest();
  invalidateStandingPolicyCache();
  restoreHome();
});

function install(grant: StandingGrantV1 = makeGrant()): void {
  const result = installStandingGrant(signGrant(grant), { surface: 'running' });
  if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
}

function goAutonomous(): void {
  const result = requestAutonomySwitch('autonomous', 'mason', 'test');
  if (!result.ok) throw new Error(result.reason);
}

function liveGrant(): void {
  install();
  goAutonomous();
}

const residentOpts = () => ({ platform: 'darwin' as const, homeDir: home, nodePath: '/usr/local/bin/node', binPath: '/test/release/bin/ashlr' });

describe('evaluateResidentAdmission (pure)', () => {
  const base = (over: Partial<ResidentAdmissionInput> = {}, ev: Partial<ResidentAdmissionInput['evaluation']> = {}): ResidentAdmissionInput => ({
    platform: 'darwin',
    packageRoot: '/rel',
    buildIdentity: { schemaVersion: 1, packageVersion: '3.12.0', revision: 'a'.repeat(40), dirty: false, provenance: 'git' },
    evaluation: {
      grantState: 'active', grantReason: null, grant: makeGrant(), kill: false, effectiveSwitch: 'autonomous', switch: 'autonomous', inactiveReason: null,
      policy: { grantId: makeGrant().grantId } as never,
      ...ev,
    },
    ...over,
  });

  it('admits only when every condition holds', () => {
    expect(evaluateResidentAdmission(base())).toMatchObject({ ok: true, code: 'admitted', status: 'admitted', grantSeq: 1 });
  });

  it('blocks a non-mac host, a source run, a dirty or unknown build', () => {
    expect(evaluateResidentAdmission(base({ platform: 'linux' }))).toMatchObject({ ok: false, code: 'unsupported-platform', status: 'blocked' });
    expect(evaluateResidentAdmission(base({ packageRoot: null }))).toMatchObject({ ok: false, code: 'not-compiled-release', status: 'blocked' });
    const dirty = evaluateResidentAdmission(base({ buildIdentity: { schemaVersion: 1, packageVersion: '3.12.0', revision: 'a'.repeat(40), dirty: true, provenance: 'git' } }));
    expect(dirty).toMatchObject({ ok: false, code: 'build-identity-untrusted', status: 'blocked' });
    expect(dirty.reason).toMatch(/dirty working tree/);
    expect(evaluateResidentAdmission(base({ buildIdentity: { schemaVersion: 1, packageVersion: null, revision: null, dirty: null, provenance: 'unavailable' } })))
      .toMatchObject({ ok: false, code: 'build-identity-untrusted' });
  });

  it('blocks every inactive grant state and names `ashlr authority grant`', () => {
    for (const grantState of ['none', 'invalid', 'expired', 'revoked', 'paused'] as const) {
      expect(evaluateResidentAdmission(base({}, { grantState, grant: null, grantReason: `grant is ${grantState}` })))
        .toMatchObject({ ok: false, code: 'grant-inactive', status: 'blocked', command: 'ashlr authority grant' });
    }
  });

  it('Stop and the switch are waiting-on-you with the exact command; no confinement is blocked', () => {
    expect(evaluateResidentAdmission(base({}, { kill: true, effectiveSwitch: 'off', policy: null })))
      .toMatchObject({ ok: false, code: 'stopped', status: 'waiting-on-you', command: 'ashlr authority clear-stop' });
    expect(evaluateResidentAdmission(base({}, { switch: 'off', effectiveSwitch: 'off', policy: null })))
      .toMatchObject({ ok: false, code: 'switch-off', status: 'waiting-on-you', command: 'ashlr authority switch autonomous' });
    expect(evaluateResidentAdmission(base({}, { effectiveSwitch: 'off', policy: null, inactiveReason: 'No OS confinement: x' })))
      .toMatchObject({ ok: false, code: 'policy-unavailable', status: 'blocked', reason: 'No OS confinement: x' });
  });

  it('trusts git builds only from a clean tree, and CI builds with a revision', () => {
    expect(trustedResidentBuildIdentity({ schemaVersion: 1, packageVersion: 'x', revision: 'a'.repeat(40), dirty: false, provenance: 'git' })).toBe(true);
    expect(trustedResidentBuildIdentity({ schemaVersion: 1, packageVersion: 'x', revision: 'a'.repeat(40), dirty: null, provenance: 'git' })).toBe(false);
    expect(trustedResidentBuildIdentity({ schemaVersion: 1, packageVersion: 'x', revision: 'a'.repeat(40), dirty: null, provenance: 'github-actions' })).toBe(true);
  });
});

describe('agents cannot start the resident service', () => {
  const ctx = (env: Record<string, string>, tty = true) => ({ stdinTTY: tty, stdoutTTY: tty, env: { HOME: '/Users/mason', ...env }, passwdHome: '/Users/mason' });

  it('refuses every agent / daemon / swarm marker, a redirected HOME and a missing TTY', () => {
    expect(operatorContextRefusal(ctx({}))).toBeNull();
    for (const marker of NON_OPERATOR_ENV_MARKERS) {
      expect(operatorContextRefusal(ctx({ [marker]: '1' }))).toMatch(new RegExp(`^${marker} is set`));
    }
    expect(operatorContextRefusal(ctx({ HOME: '/private/var/folders/run/home' }))).toMatch(/HOME is not your login home/);
    expect(operatorContextRefusal(ctx({}, false))).toMatch(/not an interactive terminal/);
  });

  it('an agent shell cannot mint even while a grant is live', () => {
    liveGrant();
    expect(observeResidentAdmission().admission.ok).toBe(true);
    process.env['CLAUDECODE'] = '1';
    const minted = mintResidentServiceCapability();
    expect(minted).toMatchObject({ ok: false });
    if (!minted.ok) expect(minted.reason).toMatch(/CLAUDECODE is set/);
    delete process.env['CLAUDECODE'];
    process.env['ASHLR_IN_DAEMON'] = '1';
    expect(mintResidentServiceCapability().ok).toBe(false);
    delete process.env['ASHLR_IN_DAEMON'];
    setTTY(false, true);
    expect(mintResidentServiceCapability().ok).toBe(false);
  });

  it('nothing an agent can reach extends authority: minting never writes a grant or raises the switch', () => {
    liveGrant();
    const before = readdirSync(join(home, '.ashlr', 'authority')).sort();
    const minted = mintResidentServiceCapability();
    expect(minted.ok).toBe(true);
    expect(readdirSync(join(home, '.ashlr', 'authority')).sort()).toEqual(before);
  });
});

describe('the grant decides (real verification)', () => {
  it('no grant, an unsigned grant, an expired grant and a revoked grant all refuse', () => {
    expect(mintResidentServiceCapability()).toMatchObject({ ok: false, admission: { code: 'grant-inactive' } });

    // Signed by a key that is not a compiled root.
    mkdirSync(join(home, '.ashlr', 'authority'), { recursive: true });
    writeFileSync(installedGrantPath(), `${JSON.stringify(signGrant(makeGrant(), STRANGER_PRIVATE_KEY))}\n`);
    invalidateStandingPolicyCache();
    expect(mintResidentServiceCapability()).toMatchObject({ ok: false, admission: { code: 'grant-inactive' } });
  });

  it('an expired grant refuses', () => {
    liveGrant();
    const expiresAt = Date.parse(makeGrant().expiresAt);
    expect(mintResidentServiceCapability({ nowMs: expiresAt + 1_000 })).toMatchObject({ ok: false, admission: { code: 'grant-inactive' } });
  });

  it('a revoked grant refuses', () => {
    liveGrant();
    revokeStanding({ actor: 'mason', reason: 'test' });
    invalidateStandingPolicyCache();
    expect(mintResidentServiceCapability()).toMatchObject({ ok: false, admission: { code: 'grant-inactive' } });
  });

  it('a dirty build refuses even under a live grant', () => {
    liveGrant();
    probe.build = { ...probe.build, dirty: true };
    expect(mintResidentServiceCapability()).toMatchObject({ ok: false, admission: { code: 'build-identity-untrusted' } });
  });

  it('Stop refuses the mint', () => {
    liveGrant();
    stopAutonomy({ actor: 'mason', reason: 'test' });
    expect(mintResidentServiceCapability()).toMatchObject({ ok: false, admission: { code: 'stopped', status: 'waiting-on-you' } });
  });
});

describe('the capability', () => {
  it('is single-use and cannot be forged', () => {
    liveGrant();
    const minted = mintResidentServiceCapability();
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const forged = { ...minted.capability };
    expect(claimResidentServiceCapability(forged)).toBe(false);
    expect(claimResidentServiceCapability(null)).toBe(false);
    expect(claimResidentServiceCapability(minted.capability)).toBe(true);
    expect(claimResidentServiceCapability(minted.capability)).toBe(false);
  });

  it('Stop (KILL) between mint and claim wins', () => {
    liveGrant();
    const minted = mintResidentServiceCapability();
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    stopAutonomy({ actor: 'mason', reason: 'test' });
    expect(claimResidentServiceCapability(minted.capability)).toBe(false);
  });

  it('goes stale after its short TTL', () => {
    liveGrant();
    const minted = mintResidentServiceCapability({ nowMs: Date.now() - 120_000 });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(claimResidentServiceCapability(minted.capability)).toBe(false);
  });
});

describe('the service install path', () => {
  it('refuses anything but a minted capability before any file, lock or process effect', async () => {
    for (const bogus of [undefined, null, {}, { kind: 'resident-service', capabilityId: 'x', grantId: makeGrant().grantId }]) {
      await expect(service.installResidentService(residentOpts(), bogus)).rejects.toThrow(service.RESIDENT_SERVICE_CAPABILITY_REFUSAL);
    }
    expect(existsSync(join(home, 'Library'))).toBe(false);
    expect(launchd.installs).toEqual([]);
    expect(launchctlCalls()).toEqual([]);
  });

  it('keeps the legacy install and ensureRunning denied', async () => {
    liveGrant();
    await expect(service.install(residentOpts())).rejects.toThrow('resident service install/reinstall/repair/restart authority is unavailable');
    await expect(service.ensureRunning(residentOpts())).rejects.toThrow('resident service install/reinstall/repair/restart authority is unavailable');
    expect(launchd.installs).toEqual([]);
  });

  it('with a minted capability runs the launchd transaction once, with the budget from config', async () => {
    liveGrant();
    const minted = mintResidentServiceCapability();
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const opts = { ...daemonServiceInstallOptions({ daemon: { dailyBudgetUsd: 42, intervalMs: 600_000, parallel: 2 } }, { autostart: true }), ...residentOpts() };
    await service.installResidentService(opts, minted.capability);
    expect(launchd.installs).toHaveLength(1);
    expect(launchd.installs[0]!.plistPath).toBe(join(home, 'Library', 'LaunchAgents', 'ai.ashlr.daemon.plist'));
    expect(plistBudgetUsd(launchd.installs[0]!.content)).toBe(42);
    expect(launchd.installs[0]!.content).toContain('<string>600000</string>');
    // Single use: the same capability cannot restart it again.
    await expect(service.installResidentService(opts, minted.capability)).rejects.toThrow(service.RESIDENT_SERVICE_CAPABILITY_REFUSAL);
    expect(launchd.installs).toHaveLength(1);
  });

  it('refuses a non-mac platform even with a capability', async () => {
    liveGrant();
    const minted = mintResidentServiceCapability();
    if (!minted.ok) throw new Error(minted.reason);
    await expect(service.installResidentService({ ...residentOpts(), platform: 'linux' }, minted.capability)).rejects.toThrow(/macOS-only/);
    expect(launchd.installs).toEqual([]);
  });
});

describe('plist budget derives from config', () => {
  it('regenerates --budget from daemon.dailyBudgetUsd and detects drift', () => {
    const at = (budget: number) => service.generateServiceDefinition({
      ...daemonServiceInstallOptions({ daemon: { dailyBudgetUsd: budget } }, { autostart: true }),
      ...residentOpts(),
    }).content;
    expect(plistBudgetUsd(at(50))).toBe(50);
    expect(plistBudgetUsd(at(12.5))).toBe(12.5);
    expect(residentPlistState(at(50), at(50))).toBe('current');
    expect(residentPlistState(at(50), at(20))).toBe('drifted');
    expect(residentPlistState(null, at(20))).toBe('absent');
    expect(residentPlistState(undefined, at(20))).toBe('unknown');
    expect(residentPlistState(at(50), null)).toBe('unknown');
    expect(plistBudgetUsd(null)).toBeNull();
  });
});
