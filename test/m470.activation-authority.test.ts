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
  consumeDaemonActivationPermitForVerification,
  daemonActivationConfigDigest,
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
  inspectDaemonActivationPermitForVerification,
  liveConductorActivationAuthorized,
  loadDaemonActivationTrustRoots,
  signDaemonActivationPermit,
  type DaemonActivationGrantScope,
  type DaemonActivationPermitEnvelope,
  type DaemonActivationRuntimeContext,
  type DaemonActivationTrustRoot,
} from '../src/core/daemon/activation-permit.js';
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
