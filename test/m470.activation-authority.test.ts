/**
 * M470: the real, gated, auditable operator-authority mechanism built on top
 * of the M461 activation-permit machinery. Covers everything that does NOT
 * require a real built dist/ tree (standing grants, trust-root store, guard
 * functions, audit trail); one-shot permit scope-matching is covered here
 * with an injected runtime context (mirrors m461.activation-permit.test.ts's
 * own pattern) so it does not depend on argv[1]-relative release-tree
 * discovery, which is exercised for real by m461.activation-permit.test.ts.
 */
import { generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DAEMON_ACTIVATION_SCOPE_KEYS,
  EMPTY_DAEMON_ACTIVATION_SCOPE,
  buildDaemonActivationPermitPayload,
  canonicalizeDaemonActivationValue,
  consumeDaemonActivationPermit,
  consumeDaemonActivationPermitForVerification,
  daemonActivationAuthorityStateDigest,
  daemonActivationConfigDigest,
  daemonActivationDiagnosePendingPermitBindings,
  daemonActivationDirPath,
  daemonActivationGrantStatus,
  daemonActivationGrantsPath,
  daemonActivationInit,
  daemonActivationMintOneShotPermit,
  daemonActivationMintStandingGrant,
  daemonActivationPermitPath,
  daemonActivationRevokeGrant,
  daemonActivationRevokeTrustRoot,
  daemonActivationScopeGranted,
  daemonActivationTrustRootStatus,
  daemonActivationTrustRootsPath,
  inspectDaemonActivationPermit,
  inspectDaemonActivationPermitForVerification,
  liveConductorActivationAuthorized,
  loadDaemonActivationTrustRoots,
  signDaemonActivationGrant,
  signDaemonActivationPermit,
  verifyDaemonActivationPermit,
  type DaemonActivationGrantScope,
  type DaemonActivationPermitEnvelope,
  type DaemonActivationRuntimeContext,
  type DaemonActivationTrustRoot,
} from '../src/core/daemon/activation-permit.js';
import { readBuildIdentity } from '../src/core/build-identity.js';
import { acquireDaemonLock, daemonLockPath } from '../src/core/daemon/state.js';
import { assertResidentServiceInstallAuthorized } from '../src/core/daemon/service-install-authority.js';
import { setKill } from '../src/core/sandbox/policy.js';
import { auditDir } from '../src/core/sandbox/audit.js';
import type { AshlrConfig } from '../src/core/types.js';

const originalHomeEnvironment = {
  HOME: process.env['HOME'],
  USERPROFILE: process.env['USERPROFILE'],
  ASHLR_HOME: process.env['ASHLR_HOME'],
};
const homes: string[] = [];

function restoreHomeEnvironment(): void {
  for (const [key, value] of Object.entries(originalHomeEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function isolateHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'ashlr-m470-'));
  homes.push(home);
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  process.env['ASHLR_HOME'] = join(home, '.ashlr');
  return home;
}

function config(label = 'default'): AshlrConfig {
  return {
    version: 1,
    roots: [`/${label}`],
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

function digest(label: string): string {
  return Buffer.from(label.padEnd(32, '.')).toString('hex').slice(0, 64);
}

function runtimeContext(cfg: AshlrConfig, nowMs = Date.UTC(2026, 6, 25, 12)): DaemonActivationRuntimeContext {
  return {
    nowMs,
    configDigest: daemonActivationConfigDigest(cfg),
    buildIdentity: {
      schemaVersion: 1,
      packageVersion: '3.1.0',
      revision: 'a'.repeat(40),
      dirty: false,
      provenance: 'git',
    },
    executable: { path: '/opt/ashlr/node', sha256: digest('executable') },
    entrypoint: { path: '/opt/ashlr/dist/cli/index.js', sha256: digest('entrypoint') },
    releaseTree: { path: '/opt/ashlr', sha256: digest('release-tree') },
    authorityStateDigest: digest('authority-state'),
    killSwitchOff: true,
    guardHealthHealthy: true,
  };
}

function scope(overrides: Partial<DaemonActivationGrantScope>): DaemonActivationGrantScope {
  return { ...EMPTY_DAEMON_ACTIVATION_SCOPE, ...overrides };
}

function testKeypair(): { privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']; root: DaemonActivationTrustRoot } {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey,
    root: {
      keyId: 'm470-test-root',
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
  };
}

/** Pins a signed envelope at the real permit path, exactly like an operator's `activation grant` would. */
function installPermit(envelope: DaemonActivationPermitEnvelope): string {
  const path = daemonActivationPermitPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(dirname(path)), 0o700);
  chmodSync(dirname(path), 0o700);
  writeFileSync(path, `${canonicalizeDaemonActivationValue(envelope)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function latestAuditSummaries(action: string): string[] {
  const dir = auditDir();
  if (!existsSync(dir)) return [];
  const lines: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    lines.push(...readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean));
  }
  return lines
    .map((line) => JSON.parse(line) as { action: string; summary: string; result: string })
    .filter((entry) => entry.action === action)
    .map((entry) => `${entry.result}:${entry.summary}`);
}

afterEach(() => {
  restoreHomeEnvironment();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('M470 activation authority — trust-root store', () => {
  it('defaults to zero trust roots and identical denial when nothing was ever initialized', () => {
    isolateHome();
    expect(loadDaemonActivationTrustRoots()).toEqual([]);
    expect(daemonActivationTrustRootStatus()).toEqual({ ok: true, records: [] });
  });

  it('init registers exactly one active trust root and grants nothing by itself', () => {
    isolateHome();
    const result = daemonActivationInit({ label: 'test-operator' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rotated).toBe(false);
    expect(result.keyId.length).toBeGreaterThan(0);

    expect(loadDaemonActivationTrustRoots()).toEqual([{ keyId: result.keyId, publicKeyPem: result.publicKeyPem }]);

    for (const key of DAEMON_ACTIVATION_SCOPE_KEYS) {
      if (key === 'once' || key === 'resident') continue;
      expect(daemonActivationScopeGranted(key).granted).toBe(false);
    }
    expect(latestAuditSummaries('daemon-activation:init').length).toBeGreaterThan(0);
  });

  it('refuses to silently clobber an existing trust root without --force', () => {
    isolateHome();
    daemonActivationInit({});
    expect(daemonActivationInit({})).toEqual({ ok: false, reason: 'trust-root-already-initialized' });
  });

  it('rotation with --force ADDS a new root and keeps the old one active', () => {
    isolateHome();
    const first = daemonActivationInit({ label: 'first' });
    const second = daemonActivationInit({ label: 'second', force: true });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.rotated).toBe(true);
    expect(second.keyId).not.toBe(first.keyId);
    expect(loadDaemonActivationTrustRoots().map((r) => r.keyId).sort())
      .toEqual([first.keyId, second.keyId].sort());
  });

  it('fails closed to zero roots when the store file has unsafe (world-readable) permissions', () => {
    isolateHome();
    expect(daemonActivationInit({}).ok).toBe(true);
    expect(loadDaemonActivationTrustRoots().length).toBe(1);

    chmodSync(daemonActivationTrustRootsPath(), 0o644);
    expect(loadDaemonActivationTrustRoots()).toEqual([]);
    expect(daemonActivationTrustRootStatus()).toMatchObject({ ok: false });
  });

  it('fails closed when the operator directory itself is unsafe (group-writable)', () => {
    isolateHome();
    daemonActivationInit({});
    expect(loadDaemonActivationTrustRoots().length).toBe(1);

    chmodSync(daemonActivationDirPath(), 0o770);
    expect(loadDaemonActivationTrustRoots()).toEqual([]);
    chmodSync(daemonActivationDirPath(), 0o700);
  });

  it('revoking a trust root immediately empties the active set and is idempotent', () => {
    isolateHome();
    const result = daemonActivationInit({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(loadDaemonActivationTrustRoots().length).toBe(1);

    expect(daemonActivationRevokeTrustRoot(result.keyId)).toEqual({ ok: true });
    expect(loadDaemonActivationTrustRoots()).toEqual([]);

    const status = daemonActivationTrustRootStatus();
    expect(status.ok && status.records[0]?.revokedAt).not.toBeNull();

    expect(daemonActivationRevokeTrustRoot(result.keyId)).toEqual({ ok: true });
    expect(daemonActivationRevokeTrustRoot('nonexistent-key-id')).toEqual({
      ok: false,
      reason: 'trust-root-not-found',
    });
  });
});

describe('M470 activation authority — standing grants (conductor/install/automerge/repair/deploy)', () => {
  it('denies every standing scope by default, with the exact pre-M470 reason for conductor/install', () => {
    isolateHome();
    expect(liveConductorActivationAuthorized()).toBe(false);
    expect(() => assertResidentServiceInstallAuthorized()).toThrow(
      'resident service install/reinstall/repair/restart authority is unavailable',
    );
    expect(daemonActivationScopeGranted('conductor')).toMatchObject({
      granted: false,
      reason: 'no-trusted-activation-roots',
    });
  });

  it('grants exactly the requested scope, nothing more, once a trust root exists', () => {
    isolateHome();
    daemonActivationInit({});
    expect(daemonActivationMintStandingGrant({ scope: scope({ conductor: true }), ttlMs: 60_000 }).ok).toBe(true);

    expect(daemonActivationScopeGranted('conductor').granted).toBe(true);
    expect(liveConductorActivationAuthorized()).toBe(true);
    expect(daemonActivationScopeGranted('install').granted).toBe(false);
    expect(daemonActivationScopeGranted('automerge').granted).toBe(false);
    expect(() => assertResidentServiceInstallAuthorized()).toThrow();
  });

  it('grants install independently and it gates assertResidentServiceInstallAuthorized', () => {
    isolateHome();
    daemonActivationInit({});
    daemonActivationMintStandingGrant({ scope: scope({ install: true }), ttlMs: 60_000 });
    expect(() => assertResidentServiceInstallAuthorized()).not.toThrow();
    expect(liveConductorActivationAuthorized()).toBe(false);
  });

  it('revoking a standing grant denies immediately', () => {
    isolateHome();
    daemonActivationInit({});
    const minted = daemonActivationMintStandingGrant({ scope: scope({ conductor: true }), ttlMs: 60_000 });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(liveConductorActivationAuthorized()).toBe(true);

    expect(daemonActivationRevokeGrant(minted.record.grantId)).toEqual({ ok: true });
    expect(liveConductorActivationAuthorized()).toBe(false);
    expect(daemonActivationRevokeGrant('0'.repeat(32))).toEqual({ ok: false, reason: 'grant-not-found' });
  });

  it('revoking the signing trust root denies every grant it signed, immediately', () => {
    isolateHome();
    const init = daemonActivationInit({});
    expect(init.ok).toBe(true);
    if (!init.ok) return;
    daemonActivationMintStandingGrant({ scope: scope({ conductor: true, install: true }), ttlMs: 60_000 });
    expect(liveConductorActivationAuthorized()).toBe(true);

    daemonActivationRevokeTrustRoot(init.keyId);
    expect(liveConductorActivationAuthorized()).toBe(false);
    expect(() => assertResidentServiceInstallAuthorized()).toThrow();
  });

  it('denies an expired standing grant', async () => {
    isolateHome();
    daemonActivationInit({});
    expect(daemonActivationMintStandingGrant({ scope: scope({ conductor: true }), ttlMs: 400 }).ok).toBe(true);
    expect(liveConductorActivationAuthorized()).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(liveConductorActivationAuthorized()).toBe(false);
    expect(daemonActivationScopeGranted('conductor').reason).toBe('no-matching-standing-grant');
  });

  it('refuses a ttl beyond the 30-day hard cap and a non-positive ttl', () => {
    isolateHome();
    daemonActivationInit({});
    expect(daemonActivationMintStandingGrant({ scope: scope({ conductor: true }), ttlMs: 31 * 24 * 60 * 60 * 1000 }))
      .toEqual({ ok: false, reason: 'invalid-grant-ttl' });
    expect(daemonActivationMintStandingGrant({ scope: scope({ conductor: true }), ttlMs: 0 }))
      .toEqual({ ok: false, reason: 'invalid-grant-ttl' });
  });

  it('fails closed when the grants store file has unsafe permissions', () => {
    isolateHome();
    daemonActivationInit({});
    daemonActivationMintStandingGrant({ scope: scope({ conductor: true }), ttlMs: 60_000 });
    expect(liveConductorActivationAuthorized()).toBe(true);

    chmodSync(daemonActivationGrantsPath(), 0o644);
    expect(liveConductorActivationAuthorized()).toBe(false);
    expect(daemonActivationGrantStatus()).toMatchObject({ ok: false });
  });

  it('denies standing scopes while the kill switch is on', () => {
    isolateHome();
    daemonActivationInit({});
    daemonActivationMintStandingGrant({ scope: scope({ conductor: true }), ttlMs: 60_000 });
    expect(liveConductorActivationAuthorized()).toBe(true);

    setKill(true);
    expect(daemonActivationScopeGranted('conductor')).toMatchObject({ granted: false, reason: 'kill-switch-is-on' });
    setKill(false);
  });

  it('writes an audit row for every grant, denial, and consult', () => {
    isolateHome();
    daemonActivationInit({});
    daemonActivationMintStandingGrant({ scope: scope({ conductor: true }), ttlMs: 60_000 });
    liveConductorActivationAuthorized();
    expect(() => assertResidentServiceInstallAuthorized()).toThrow();

    expect(latestAuditSummaries('daemon-activation:grant').length).toBeGreaterThan(0);
    expect(latestAuditSummaries('daemon-activation:conductor-check').some((s) => s.startsWith('ok:'))).toBe(true);
    expect(latestAuditSummaries('daemon-activation:install-check').some((s) => s.startsWith('refused:'))).toBe(true);
  });
});

describe('M470 activation authority — standing residentStanding grant (unattended resident restart)', () => {
  it('denies resident with no residentStanding grant, falling back to the (also absent) one-shot permit', () => {
    isolateHome();
    daemonActivationInit({});
    const result = consumeDaemonActivationPermit(config('no-grant'), { once: false, dryRun: false });
    expect(result.authorized).toBe(false);
    expect(result.scope).toBeUndefined();
    expect(result.grantId).toBeUndefined();
    expect(latestAuditSummaries('daemon-activation:resident-standing-check').some((s) => s.startsWith('refused:'))).toBe(true);
  });

  it('authorizes resident via a valid standing residentStanding grant, touching no one-shot permit', () => {
    isolateHome();
    daemonActivationInit({});
    const minted = daemonActivationMintStandingGrant({
      scope: scope({ residentStanding: true, automerge: true }),
      ttlMs: 60_000,
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    const result = consumeDaemonActivationPermit(config('standing-resident'), { once: false, dryRun: false });
    expect(result.authorized).toBe(true);
    expect(result.grantId).toBe(minted.record.grantId);
    expect(result.scope).toEqual(minted.record.scope);
    expect(result.capability).toBeUndefined();
    expect(existsSync(daemonActivationPermitPath())).toBe(false);
    expect(latestAuditSummaries('daemon-activation:consume').some((s) =>
      s === `ok:daemon activation consume authorized: resident-standing-activation-authorized:${minted.record.grantId}`,
    )).toBe(true);
  });

  it('denies once the standing residentStanding grant expires', async () => {
    isolateHome();
    daemonActivationInit({});
    daemonActivationMintStandingGrant({ scope: scope({ residentStanding: true }), ttlMs: 400 });
    expect(consumeDaemonActivationPermit(config('expiring'), { once: false, dryRun: false }).authorized).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 700));
    const result = consumeDaemonActivationPermit(config('expiring'), { once: false, dryRun: false });
    expect(result.authorized).toBe(false);
    expect(result.scope).toBeUndefined();
  });

  it('denies immediately once the standing residentStanding grant is revoked', () => {
    isolateHome();
    daemonActivationInit({});
    const minted = daemonActivationMintStandingGrant({ scope: scope({ residentStanding: true }), ttlMs: 60_000 });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(consumeDaemonActivationPermit(config('revoke-test'), { once: false, dryRun: false }).authorized).toBe(true);

    expect(daemonActivationRevokeGrant(minted.record.grantId)).toEqual({ ok: true });
    const result = consumeDaemonActivationPermit(config('revoke-test'), { once: false, dryRun: false });
    expect(result.authorized).toBe(false);
    expect(result.scope).toBeUndefined();
  });

  it('denies resident regardless of a valid residentStanding grant while the kill switch is on', () => {
    isolateHome();
    daemonActivationInit({});
    daemonActivationMintStandingGrant({ scope: scope({ residentStanding: true }), ttlMs: 60_000 });
    expect(daemonActivationScopeGranted('residentStanding')).toMatchObject({ granted: true });

    setKill(true);
    expect(daemonActivationScopeGranted('residentStanding')).toMatchObject({ granted: false, reason: 'kill-switch-is-on' });
    const result = consumeDaemonActivationPermit(config('kill-switch'), { once: false, dryRun: false });
    expect(result.authorized).toBe(false);
    setKill(false);
  });

  it('never authorizes --once, no matter how broad the residentStanding grant scope is', () => {
    isolateHome();
    daemonActivationInit({});
    daemonActivationMintStandingGrant({
      scope: scope({ residentStanding: true, automerge: true, repair: true, deploy: true }),
      ttlMs: 60_000,
    });

    const result = consumeDaemonActivationPermit(config('once-unaffected'), { once: true, dryRun: false });
    expect(result.authorized).toBe(false);
    expect(result.scope).toBeUndefined();
  });

  it('backward compat: a standing grant signed BEFORE residentStanding existed still loads, still authorizes its original scopes, and correctly denies residentStanding', () => {
    // Reproduces exactly what happened on a real, already-in-use machine:
    // a conductor+install grant minted before this change existed, then the
    // binary upgrades and `DAEMON_ACTIVATION_SCOPE_KEYS` gains
    // `residentStanding`. hasExactKeys-based validation would make
    // loadGrantStore() reject this ENTIRE record — and loadGrantStore fails
    // the WHOLE STORE on any one invalid record, so a strict check here
    // would silently deny every OTHER still-valid grant too, not just the
    // new capability.
    isolateHome();
    const home = process.env['HOME']!;
    const key = testKeypair();
    const nowIso = new Date().toISOString();

    mkdirSync(daemonActivationDirPath(), { recursive: true, mode: 0o700 });
    const trustRoot = {
      keyId: key.root.keyId,
      publicKeyPem: key.root.publicKeyPem,
      createdAt: nowIso,
      revokedAt: null,
      label: 'pre-upgrade-operator',
    };
    writeFileSync(
      daemonActivationTrustRootsPath(),
      `${canonicalizeDaemonActivationValue([trustRoot])}\n`,
      { mode: 0o600 },
    );

    // The OLD-shape scope: exactly the 8 keys that existed before
    // `residentStanding` was added — not built via `scope()`/spreading
    // EMPTY_DAEMON_ACTIVATION_SCOPE, on purpose, to faithfully reproduce
    // what an older binary actually signed onto disk.
    const oldScope = {
      once: false,
      resident: false,
      conductor: true,
      automerge: false,
      repair: false,
      deploy: false,
      install: true,
      proposalOnly: false,
    } as unknown as DaemonActivationGrantScope;
    const oldRecord = signDaemonActivationGrant({
      grantId: 'a'.repeat(32),
      keyId: key.root.keyId,
      issuedAt: nowIso,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scope: oldScope,
      privateKey: key.privateKey,
    });
    writeFileSync(
      daemonActivationGrantsPath(),
      `${canonicalizeDaemonActivationValue([oldRecord])}\n`,
      { mode: 0o600 },
    );
    chmodSync(home, 0o700);

    expect(daemonActivationGrantStatus()).toMatchObject({ ok: true });
    expect(daemonActivationScopeGranted('conductor')).toMatchObject({ granted: true });
    expect(daemonActivationScopeGranted('install')).toMatchObject({ granted: true });
    // Missing (not merely false) on the old record — must read as denied,
    // never as silently trusted.
    expect(daemonActivationScopeGranted('residentStanding')).toMatchObject({ granted: false });
    expect(consumeDaemonActivationPermit(config('pre-upgrade'), { once: false, dryRun: false }).authorized)
      .toBe(false);
  });

  it('status reports resident readiness cleanly via a standing grant even when a stale/unreadable one-shot permit file is present', () => {
    isolateHome();
    daemonActivationInit({});
    const cfg = config('stale-permit-status');

    // A stale, empty (0-byte) one-shot permit file — the same category of
    // "corrupt pending permit" that used to make `ashlr activation status`
    // show `resident: degraded (activation-permit-inspection-failed)` no
    // matter what else was granted.
    const permitPath = daemonActivationPermitPath();
    mkdirSync(dirname(permitPath), { recursive: true, mode: 0o700 });
    writeFileSync(permitPath, '', { mode: 0o600 });

    const withoutStanding = inspectDaemonActivationPermit(cfg, { once: false, dryRun: false });
    expect(withoutStanding).toMatchObject({
      state: 'degraded',
      reason: 'activation-permit-inspection-failed',
      residentStandingAuthorized: false,
    });

    daemonActivationMintStandingGrant({ scope: scope({ residentStanding: true }), ttlMs: 60_000 });

    const withStanding = inspectDaemonActivationPermit(cfg, { once: false, dryRun: false });
    expect(withStanding).toMatchObject({
      state: 'ready',
      commandEligible: true,
      reason: 'ready-via-standing-resident-grant',
      residentAuthorized: true,
      residentStandingAuthorized: true,
    });

    // The stale one-shot permit is left completely alone — the standing-grant
    // path never opens, reads, or unlinks it.
    expect(existsSync(permitPath)).toBe(true);
  });

  it('preserves valid resident-standing authority when one-shot inspection is blocked', () => {
    isolateHome();
    daemonActivationInit({});
    const cfg = config('independent-status-shapes');
    daemonActivationMintStandingGrant({ scope: scope({ residentStanding: true }), ttlMs: 60_000 });

    const oneShot = inspectDaemonActivationPermit(cfg, { once: true, dryRun: false });

    expect(oneShot).toMatchObject({
      requestedShape: 'proposal-once',
      state: 'degraded',
      commandEligible: false,
      reason: 'activation-permit-inspection-failed',
      residentStandingAuthorized: true,
      residentAuthorized: false,
    });
  });
});

describe('M470 activation authority — daemonActivationMintOneShotPermit pre-flight', () => {
  it('refuses to mint with no trust root', () => {
    isolateHome();
    expect(daemonActivationMintOneShotPermit({ cfg: config(), scope: scope({ once: true, proposalOnly: true }) }))
      .toEqual({ ok: false, reason: 'no-trusted-activation-roots' });
  });

  it('refuses to mint when a permit is already pending', () => {
    isolateHome();
    const key = testKeypair();
    daemonActivationInit({});
    const cfg = config('pending');
    const runtime = runtimeContext(cfg);
    const payload = buildDaemonActivationPermitPayload({
      permitId: '9'.repeat(32),
      nonce: '8'.repeat(64),
      keyId: key.root.keyId,
      issuedAt: new Date(runtime.nowMs).toISOString(),
      expiresAt: new Date(runtime.nowMs + 60_000).toISOString(),
      scope: scope({ once: true, proposalOnly: true }),
      context: runtime,
    });
    installPermit(signDaemonActivationPermit(payload, key.privateKey));

    expect(daemonActivationMintOneShotPermit({ cfg, scope: scope({ once: true, proposalOnly: true }) }))
      .toEqual({ ok: false, reason: 'activation-permit-already-pending' });
  });
});

describe('M470 activation authority — one-shot permit scope matching (injected context)', () => {
  it('denies a resident request against a permit scoped once-only (never grants more than signed)', () => {
    isolateHome();
    const cfg = config('scope-once-only');
    const runtime = runtimeContext(cfg);
    const key = testKeypair();
    const payload = buildDaemonActivationPermitPayload({
      permitId: '3'.repeat(32),
      nonce: '4'.repeat(64),
      keyId: key.root.keyId,
      issuedAt: new Date(runtime.nowMs - 1_000).toISOString(),
      expiresAt: new Date(runtime.nowMs + 60_000).toISOString(),
      scope: scope({ once: true, proposalOnly: true }),
      context: runtime,
    });
    installPermit(signDaemonActivationPermit(payload, key.privateKey));

    const residentInspection = inspectDaemonActivationPermitForVerification(
      cfg,
      { once: false, dryRun: false },
      { trustRoots: [key.root], context: runtime },
    );
    expect(residentInspection).toMatchObject({
      state: 'blocked',
      commandEligible: false,
      requestedShape: 'resident',
      residentAuthorized: false,
      reason: 'activation-permit-scope-does-not-grant-requested-shape',
    });

    // The SAME permit, requested as `once`, is still fully valid.
    const onceInspection = inspectDaemonActivationPermitForVerification(
      cfg,
      { once: true, dryRun: false },
      { trustRoots: [key.root], context: runtime },
    );
    expect(onceInspection).toMatchObject({ state: 'ready', commandEligible: true, requestedShape: 'proposal-once' });
  });

  it('authorizes resident, and only resident, when the resident scope was explicitly granted', () => {
    isolateHome();
    const cfg = config('scope-resident');
    const runtime = runtimeContext(cfg);
    const key = testKeypair();
    const payload = buildDaemonActivationPermitPayload({
      permitId: '5'.repeat(32),
      nonce: '6'.repeat(64),
      keyId: key.root.keyId,
      issuedAt: new Date(runtime.nowMs - 1_000).toISOString(),
      expiresAt: new Date(runtime.nowMs + 60_000).toISOString(),
      scope: scope({ resident: true }),
      context: runtime,
    });
    installPermit(signDaemonActivationPermit(payload, key.privateKey));

    const onceInspection = inspectDaemonActivationPermitForVerification(
      cfg,
      { once: true, dryRun: false },
      { trustRoots: [key.root], context: runtime },
    );
    expect(onceInspection).toMatchObject({
      state: 'blocked',
      reason: 'activation-permit-scope-does-not-grant-requested-shape',
      residentAuthorized: true,
    });

    const consumption = consumeDaemonActivationPermitForVerification(
      cfg,
      { once: false, dryRun: false },
      { trustRoots: [key.root], context: runtime },
    );
    expect(consumption.authorized).toBe(true);
    expect(consumption.reason).toBe('resident-activation-authorized');
    // ForVerification deliberately never mints a capability (mayMintCapability=false) —
    // see the "durably writes metadata-only receipt" test in m461 for the same invariant.
    expect(consumption.capability).toBeUndefined();
    // Single-use: a second consumption attempt (permit already unlinked) is denied.
    expect(consumeDaemonActivationPermitForVerification(
      cfg,
      { once: false, dryRun: false },
      { trustRoots: [key.root], context: runtime },
    ).authorized).toBe(false);
  });
});

describe('M470 regression — permit-runtime-binding-mismatch on every daemon start', () => {
  // Root cause: authorityStateDigest included ~/.ashlr's own directory mtime.
  // acquireDaemonLock() (src/core/daemon/state.ts) creates ~/.ashlr/daemon.lock
  // — a brand-new direct child of ~/.ashlr — BEFORE runDaemon() ever calls
  // consumeDaemonActivationPermit(). Creating that file bumps ~/.ashlr's own
  // mtime, so every permit's signed authorityStateDigest (computed at mint
  // time, before any lock existed) was guaranteed to mismatch the recomputed
  // one at consume time (computed after the daemon's own lock acquisition) —
  // 100% reproducibly, unrelated to git/dist/node_modules state.

  it('daemonActivationAuthorityStateDigest is stable across ~/.ashlr child churn (e.g. a lock file appearing)', () => {
    const home = isolateHome();
    mkdirSync(join(home, '.ashlr'), { recursive: true, mode: 0o700 });

    const before = daemonActivationAuthorityStateDigest();

    // Exactly what acquireDaemonLock()'s writeNewLock() does: O_CREAT|O_EXCL
    // a brand-new direct child of ~/.ashlr.
    writeFileSync(join(home, '.ashlr', 'daemon.lock'), 'probe', { flag: 'wx' });
    const afterCreate = daemonActivationAuthorityStateDigest();
    expect(afterCreate).toBe(before);

    // And the reclaim path (unlink + recreate on a stale lock) churns it too.
    rmSync(join(home, '.ashlr', 'daemon.lock'));
    writeFileSync(join(home, '.ashlr', 'daemon.lock'), 'probe-2', { flag: 'wx' });
    const afterReclaim = daemonActivationAuthorityStateDigest();
    expect(afterReclaim).toBe(before);
  });

  it('verifyDaemonActivationPermit reports exactly which binding field(s) differ, not just an opaque yes/no', () => {
    const cfg = config('diagnose-mismatch');
    const runtime = runtimeContext(cfg);
    const key = testKeypair();
    const payload = buildDaemonActivationPermitPayload({
      permitId: '7'.repeat(32),
      nonce: '8'.repeat(64),
      keyId: key.root.keyId,
      issuedAt: new Date(runtime.nowMs - 1_000).toISOString(),
      expiresAt: new Date(runtime.nowMs + 60_000).toISOString(),
      scope: scope({ once: true, proposalOnly: true }),
      context: runtime,
    });
    const envelope = signDaemonActivationPermit(payload, key.privateKey);

    // Only `entrypoint` differs at consume time — everything else matches.
    const driftedEntrypoint = {
      ...runtime,
      entrypoint: { ...runtime.entrypoint, sha256: digest('drifted-entrypoint') },
    };
    const onlyEntrypoint = verifyDaemonActivationPermit(envelope, driftedEntrypoint, [key.root]);
    expect(onlyEntrypoint.reason).toBe('permit-runtime-binding-mismatch');
    expect(onlyEntrypoint.mismatchedBindings).toEqual(['entrypoint']);

    // Two fields differ — both, and only both, are reported.
    const twoFieldsDrifted = {
      ...runtime,
      entrypoint: { ...runtime.entrypoint, sha256: digest('drifted-entrypoint') },
      authorityStateDigest: digest('drifted-authority-state'),
    };
    const twoMismatches = verifyDaemonActivationPermit(envelope, twoFieldsDrifted, [key.root]);
    expect(twoMismatches.reason).toBe('permit-runtime-binding-mismatch');
    expect([...twoMismatches.mismatchedBindings!].sort()).toEqual(['authorityStateDigest', 'entrypoint']);

    // A fully matching context reports no mismatch at all.
    const matching = verifyDaemonActivationPermit(envelope, runtime, [key.root]);
    expect(matching.ok).toBe(true);
    expect(matching.mismatchedBindings).toBeUndefined();
  });

  // Faithful end-to-end reproduction of the operator's exact report: mint a
  // real permit, then acquire the REAL daemon lock (exactly what runDaemon()
  // does before it ever calls consumeDaemonActivationPermit), then consume.
  // This exercises the actual collectRuntimeContext() → file-hashing →
  // release-tree-walk path, so it only runs against a clean, built tree
  // (same precondition `daemon start` itself has); it is the test that would
  // have caught this exact regression.
  const buildIsCleanAndTrusted = (() => {
    try {
      return readBuildIdentity().dirty === false;
    } catch {
      return false;
    }
  })();

  it.skipIf(!buildIsCleanAndTrusted)(
    'mints and consumes a once permit end-to-end after the real daemon lock has churned ~/.ashlr',
    () => {
      const home = isolateHome();
      mkdirSync(join(home, '.ashlr'), { recursive: true, mode: 0o700 });
      expect(daemonActivationInit({}).ok).toBe(true);

      const mint = daemonActivationMintOneShotPermit({
        cfg: config('e2e-mint-consume'),
        scope: scope({ once: true, proposalOnly: true }),
      });
      expect(mint).toMatchObject({ ok: true });
      if (!mint.ok) return;
      expect(existsSync(mint.permitPath)).toBe(true);

      // Exactly what runDaemon() does before it ever reaches
      // consumeDaemonActivationPermit(): acquire the daemon singleton lock,
      // which creates ~/.ashlr/daemon.lock, a brand-new direct child of
      // ~/.ashlr.
      const lock = acquireDaemonLock();
      expect(lock.acquired).toBe(true);
      expect(existsSync(daemonLockPath())).toBe(true);

      const diagnosis = daemonActivationDiagnosePendingPermitBindings(config('e2e-mint-consume'));
      expect(diagnosis).toMatchObject({ ok: true, reason: 'bindings-match' });

      const result = consumeDaemonActivationPermit(config('e2e-mint-consume'), { once: true, dryRun: false });
      expect(result).toMatchObject({
        authorized: true,
        reason: 'proposal-once-activation-authorized',
      });
      expect(existsSync(mint.permitPath)).toBe(false);
    },
  );
});
