import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
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

import type { AshlrConfig } from '../src/core/types.js';
import {
  buildDaemonActivationPermitPayload,
  canonicalizeDaemonActivationValue,
  consumeDaemonActivationPermit,
  consumeDaemonActivationPermitForVerification,
  daemonActivationConfigDigest,
  daemonActivationPermitPath,
  daemonActivationReleaseTreeBinding,
  daemonActivationReceiptPath,
  inspectDaemonActivationPermit,
  inspectDaemonActivationPermitForVerification,
  isDaemonActivationCapability,
  signDaemonActivationPermit,
  verifyDaemonActivationPermit,
  type DaemonActivationPermitEnvelope,
  type DaemonActivationRuntimeContext,
  type DaemonActivationTrustRoot,
} from '../src/core/daemon/activation-permit.js';
import {
  acquireLocalStoreLock,
  releaseLocalStoreLock,
} from '../src/core/fleet/local-store-lock.js';

const originalHomeEnvironment = {
  HOME: process.env['HOME'],
  USERPROFILE: process.env['USERPROFILE'],
  ASHLR_HOME: process.env['ASHLR_HOME'],
};
const homes: string[] = [];

function restoreHomeEnvironment(): void {
  for (const [key, value] of Object.entries(originalHomeEnvironment)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function isolateHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'ashlr-m461-'));
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
    models: {
      lmstudio: '',
      ollama: '',
      providerChain: [],
    },
    telemetry: {},
    tools: {},
  };
}

function digest(label: string): string {
  return Buffer.from(label.padEnd(32, '.')).toString('hex').slice(0, 64);
}

function context(cfg: AshlrConfig, nowMs = Date.UTC(2026, 6, 25, 12)): DaemonActivationRuntimeContext {
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

function keys(): {
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  root: DaemonActivationTrustRoot;
} {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey,
    root: {
      keyId: 'm461-test-root',
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
  };
}

function signedPermit(
  cfg: AshlrConfig,
  runtime: DaemonActivationRuntimeContext,
  key = keys(),
): { envelope: DaemonActivationPermitEnvelope; root: DaemonActivationTrustRoot } {
  const payload = buildDaemonActivationPermitPayload({
    permitId: '1'.repeat(32),
    nonce: '2'.repeat(64),
    keyId: key.root.keyId,
    issuedAt: new Date(runtime.nowMs - 1_000).toISOString(),
    expiresAt: new Date(runtime.nowMs + 60_000).toISOString(),
    context: { ...runtime, configDigest: daemonActivationConfigDigest(cfg) },
  });
  return {
    envelope: signDaemonActivationPermit(payload, key.privateKey),
    root: key.root,
  };
}

function installPermit(envelope: DaemonActivationPermitEnvelope): string {
  const path = daemonActivationPermitPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(dirname(path)), 0o700);
  chmodSync(dirname(path), 0o700);
  writeFileSync(path, `${canonicalizeDaemonActivationValue(envelope)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

afterEach(() => {
  restoreHomeEnvironment();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/**
 * M470: every consume attempt (authorized or refused) now writes one audit
 * row via ../sandbox/audit.js, which lazily creates ~/.ashlr/audit/ on first
 * write. That is the intended, minimal, append-only side effect the M470
 * audit-trail requirement asks for. This asserts no AUTHORITY OR SERVICE
 * state was written — only (at most) the audit trail — which is a strictly
 * more precise check than the old "nothing under ~/.ashlr at all".
 */
function expectOnlyAuditTrailWritten(home: string): void {
  if (!existsSync(join(home, '.ashlr'))) return;
  expect(readdirSync(join(home, '.ashlr'))).toEqual(['audit']);
}

describe('M461 bounded daemon activation permit', () => {
  it('isolates activation files and exactly restores every home variable', () => {
    const home = isolateHome();

    expect(daemonActivationPermitPath()).toBe(
      join(home, '.ashlr', 'control', 'daemon-activation-permit.json'),
    );
    expect(daemonActivationReceiptPath('1'.repeat(32))).toBe(
      join(home, '.ashlr', 'control', 'activation-receipts', `${'1'.repeat(32)}.json`),
    );

    restoreHomeEnvironment();
    expect(process.env['HOME']).toBe(originalHomeEnvironment.HOME);
    expect(process.env['USERPROFILE']).toBe(originalHomeEnvironment.USERPROFILE);
    expect(process.env['ASHLR_HOME']).toBe(originalHomeEnvironment.ASHLR_HOME);
  });

  it('refuses activation inspection on Windows even with an injected trust root', () => {
    isolateHome();
    const cfg = config('windows');
    const key = keys();
    const result = inspectDaemonActivationPermitForVerification(
      cfg,
      { once: true, dryRun: false },
      {
        trustRoots: [key.root],
        context: context(cfg),
        platform: 'win32',
      },
    );

    expect(result).toMatchObject({
      authority: 'observation-only',
      state: 'blocked',
      commandEligible: false,
      trustRootCount: 1,
      residentAuthorized: false,
      installAuthorized: false,
      repairAuthorized: false,
      reason: 'activation-permit-v1-unsupported-on-windows',
    });
    expect(existsSync(daemonActivationPermitPath())).toBe(false);
  });

  it('requires no permit and creates no capability for a once dry run', () => {
    const home = isolateHome();
    const result = consumeDaemonActivationPermit(config(), { once: true, dryRun: true });

    expect(result).toEqual({
      authorized: true,
      required: false,
      reason: 'dry-run-once-does-not-require-activation-permit',
    });
    // The dry-run-once bypass is a total no-op (no permit was even eligible
    // to be read) — nothing is audited for it, unlike a real consume attempt.
    expect(existsSync(join(home, '.ashlr'))).toBe(false);
  });

  it.each([
    [{ once: false, dryRun: true }, 'resident dry-run'],
    [{ once: true, dryRun: false, drain: true }, 'drain'],
    [{ once: true, dryRun: false, drainLimit: 1 }, 'drain limit'],
  ])('refuses %s authority before reading a permit (%s)', (opts) => {
    isolateHome();
    const result = consumeDaemonActivationPermit(config(), opts);

    expect(result.authorized).toBe(false);
    expect(result.required).toBe(true);
    expect(result.reason).toBe('activation-permit-cannot-authorize-requested-start-shape');
    expect(result.capability).toBeUndefined();
  });

  // M470: {once:false, dryRun:false} (a real resident start request) is now a
  // structurally SUPPORTED shape — resident becomes authorizable once the
  // `resident` scope is explicitly granted (see m470.activation-authority.test.ts).
  // With the default empty trust-root store it still ends up denied — just via
  // the real "no roots" path instead of the old blanket shape denial, which is
  // the whole point of making resident real. Default behavior (denied) holds.
  it('refuses resident authority with no trust roots via the real no-roots reason', () => {
    isolateHome();
    const result = consumeDaemonActivationPermit(config(), { once: false, dryRun: false });

    expect(result).toEqual({
      authorized: false,
      required: true,
      reason: 'no-trusted-activation-roots',
    });
  });

  it('keeps production trust roots empty and rejects forged capabilities', () => {
    isolateHome();
    const forged = { kind: 'proposal-once', permitId: '1'.repeat(32) };
    const result = consumeDaemonActivationPermit(config(), { once: true, dryRun: false });

    expect(result).toEqual({
      authorized: false,
      required: true,
      reason: 'no-trusted-activation-roots',
    });
    expect(inspectDaemonActivationPermit(config(), { once: true, dryRun: false })).toEqual({
      schemaVersion: 1,
      policyVersion: 'm461-proposal-once-v1',
      authority: 'observation-only',
      sourceState: 'healthy',
      state: 'blocked',
      commandEligible: false,
      requestedShape: 'proposal-once',
      trustRootCount: 0,
      residentAuthorized: false,
      residentStandingAuthorized: false,
      installAuthorized: false,
      repairAuthorized: false,
      reason: 'no-trusted-activation-roots',
    });
    expectOnlyAuditTrailWritten(process.env['HOME']!);
    expect(isDaemonActivationCapability(forged)).toBe(false);
    expect(isDaemonActivationCapability(Object.freeze(forged))).toBe(false);
  });

  it('inspects an exact candidate without consuming or minting authority', () => {
    isolateHome();
    const cfg = config('inspect');
    const runtime = context(cfg);
    const permit = signedPermit(cfg, runtime);
    const permitPath = installPermit(permit.envelope);
    const before = readFileSync(permitPath, 'utf8');

    const result = inspectDaemonActivationPermitForVerification(
      cfg,
      { once: true, dryRun: false },
      { trustRoots: [permit.root], context: runtime },
    );

    expect(result).toEqual({
      schemaVersion: 1,
      policyVersion: 'm461-proposal-once-v1',
      authority: 'observation-only',
      sourceState: 'healthy',
      state: 'ready',
      commandEligible: true,
      requestedShape: 'proposal-once',
      trustRootCount: 1,
      residentAuthorized: false,
      residentStandingAuthorized: false,
      installAuthorized: false,
      repairAuthorized: false,
      reason: 'valid-proposal-once-permit',
    });
    expect(readFileSync(permitPath, 'utf8')).toBe(before);
    expect(existsSync(daemonActivationReceiptPath('1'.repeat(32)))).toBe(false);
  });

  it('signs deterministic canonical payload bytes with Ed25519', () => {
    const cfg = config();
    const runtime = context(cfg);
    const key = keys();
    const first = signedPermit(cfg, runtime, key);
    const second = signedPermit(cfg, runtime, key);

    expect(first.envelope.signature).toBe(second.envelope.signature);
    expect(canonicalizeDaemonActivationValue({ z: 1, a: 2 }))
      .toBe(canonicalizeDaemonActivationValue({ a: 2, z: 1 }));
    expect(verifyDaemonActivationPermit(first.envelope, runtime, [key.root])).toMatchObject({
      ok: true,
      reason: 'valid-proposal-once-permit',
      permitId: '1'.repeat(32),
    });
    const undomained = {
      payload: first.envelope.payload,
      signature: signBytes(
        null,
        Buffer.from(canonicalizeDaemonActivationValue(first.envelope.payload)),
        key.privateKey,
      ).toString('base64'),
    };
    expect(verifyDaemonActivationPermit(undomained, runtime, [key.root]).reason)
      .toBe('invalid-permit-signature');
  });

  it('rejects extra authority, stale time, unhealthy guards, and binding drift', () => {
    const cfg = config();
    const runtime = context(cfg);
    const key = keys();
    const valid = signedPermit(cfg, runtime, key).envelope;

    const withExtraAuthority = structuredClone(valid) as unknown as {
      payload: Record<string, unknown>;
      signature: string;
    };
    withExtraAuthority.payload['scope'] = {
      ...(withExtraAuthority.payload['scope'] as Record<string, unknown>),
      deployAny: true,
    };
    expect(verifyDaemonActivationPermit(withExtraAuthority, runtime, [key.root]).reason)
      .toBe('invalid-permit-schema');

    expect(verifyDaemonActivationPermit(valid, { ...runtime, nowMs: runtime.nowMs + 120_000 }, [key.root]).reason)
      .toBe('permit-expired');
    expect(verifyDaemonActivationPermit(valid, { ...runtime, killSwitchOff: false }, [key.root]).reason)
      .toBe('kill-switch-is-on');
    expect(verifyDaemonActivationPermit(valid, { ...runtime, guardHealthHealthy: false }, [key.root]).reason)
      .toBe('guard-health-degraded');
    expect(verifyDaemonActivationPermit(valid, {
      ...runtime,
      executable: { ...runtime.executable, sha256: digest('changed') },
    }, [key.root]).reason).toBe('permit-runtime-binding-mismatch');
    expect(verifyDaemonActivationPermit(valid, {
      ...runtime,
      releaseTree: { ...runtime.releaseTree, sha256: digest('changed-release-tree') },
    }, [key.root]).reason).toBe('permit-runtime-binding-mismatch');
    expect(verifyDaemonActivationPermit(valid, {
      ...runtime,
      authorityStateDigest: digest('changed-authority-state'),
    }, [key.root]).reason).toBe('permit-runtime-binding-mismatch');
    expect(verifyDaemonActivationPermit(valid, { ...runtime, nowMs: Number.NaN }, [key.root]).reason)
      .toBe('invalid-runtime-activation-context');
  });

  it('changes the release-tree binding when an imported dist module is substituted', () => {
    const root = join(isolateHome(), 'release');
    mkdirSync(join(root, 'bin'), { recursive: true });
    mkdirSync(join(root, 'dist', 'cli'), { recursive: true });
    mkdirSync(join(root, 'dist', 'core'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"name":"@ashlr/hub"}\n');
    writeFileSync(join(root, 'bin', 'ashlr'), '#!/usr/bin/env node\n');
    writeFileSync(join(root, 'dist', 'cli', 'index.js'), 'import "../core/loop.js";\n');
    const loopPath = join(root, 'dist', 'core', 'loop.js');
    writeFileSync(loopPath, 'export const policy = "proposal-only";\n');

    const before = daemonActivationReleaseTreeBinding(join(root, 'bin', 'ashlr'));
    writeFileSync(loopPath, 'export const policy = "automerge";\n');
    const after = daemonActivationReleaseTreeBinding(join(root, 'bin', 'ashlr'));

    expect(after.path).toBe(before.path);
    expect(after.sha256).not.toBe(before.sha256);
  });

  it('rejects unavailable, revisionless, and dirty build identities even when signed', () => {
    const cfg = config();
    const runtime = context(cfg);
    const key = keys();
    const valid = signedPermit(cfg, runtime, key).envelope;
    const invalidIdentities: Record<string, unknown>[] = [
      {
        schemaVersion: 1,
        packageVersion: '3.1.0',
        revision: null,
        dirty: null,
        provenance: 'unavailable',
      },
      {
        schemaVersion: 1,
        packageVersion: '3.1.0',
        dirty: false,
        provenance: 'git',
      },
      {
        schemaVersion: 1,
        packageVersion: '3.1.0',
        revision: 'a'.repeat(40),
        dirty: true,
        provenance: 'git',
      },
    ];

    for (const buildIdentity of invalidIdentities) {
      const payload = structuredClone(valid.payload) as unknown as Record<string, unknown>;
      const bindings = payload['bindings'] as Record<string, unknown>;
      bindings['buildIdentity'] = buildIdentity;
      const canonical = canonicalizeDaemonActivationValue(payload);
      const envelope = {
        payload,
        signature: signBytes(null, Buffer.from(canonical), key.privateKey).toString('base64'),
      };
      expect(verifyDaemonActivationPermit(envelope, runtime, [key.root]).reason)
        .toBe('invalid-permit-schema');
    }

    for (const buildIdentity of invalidIdentities) {
      expect(verifyDaemonActivationPermit(valid, {
        ...runtime,
        buildIdentity: buildIdentity as unknown as DaemonActivationRuntimeContext['buildIdentity'],
      }, [key.root]).reason).toBe('runtime-build-identity-untrusted');
    }
  });

  it('rejects permit validity windows longer than two minutes', () => {
    const cfg = config();
    const runtime = context(cfg);
    const key = keys();
    const payload = buildDaemonActivationPermitPayload({
      permitId: '1'.repeat(32),
      nonce: '2'.repeat(64),
      keyId: key.root.keyId,
      issuedAt: new Date(runtime.nowMs - 1_000).toISOString(),
      expiresAt: new Date(runtime.nowMs + 120_000).toISOString(),
      context: runtime,
    });
    const envelope = signDaemonActivationPermit(payload, key.privateKey);

    expect(verifyDaemonActivationPermit(envelope, runtime, [key.root]).reason)
      .toBe('invalid-permit-validity-window');
  });

  it('durably writes metadata-only receipt before unlink and denies replay', () => {
    isolateHome();
    const cfg = config();
    const runtime = context(cfg);
    const permit = signedPermit(cfg, runtime);
    const permitPath = installPermit(permit.envelope);

    const first = consumeDaemonActivationPermitForVerification(
      cfg,
      { once: true, dryRun: false },
      { trustRoots: [permit.root], context: runtime },
    );

    expect(first.authorized).toBe(true);
    expect(first.capability).toBeUndefined();
    expect(existsSync(permitPath)).toBe(false);
    expect(first.receiptPath).toBe(daemonActivationReceiptPath('1'.repeat(32)));
    const receipt = JSON.parse(readFileSync(first.receiptPath!, 'utf8')) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      state: 'consumed-before-permit-unlink',
      permitId: '1'.repeat(32),
      keyId: 'm461-test-root',
      configDigest: runtime.configDigest,
      buildRevision: runtime.buildIdentity.revision,
    });
    expect(Object.keys(receipt).sort()).toEqual([
      'buildRevision',
      'configDigest',
      'consumedAt',
      'keyId',
      'nonceDigest',
      'payloadDigest',
      'permitId',
      'schemaVersion',
      'state',
    ]);
    expect(JSON.stringify(receipt)).not.toContain(permit.envelope.payload.nonce);
    expect(isDaemonActivationCapability(first.capability)).toBe(false);

    installPermit(permit.envelope);
    const replay = consumeDaemonActivationPermitForVerification(
      cfg,
      { once: true, dryRun: false },
      { trustRoots: [permit.root], context: runtime },
    );
    expect(replay).toMatchObject({
      authorized: false,
      required: true,
      reason: 'activation-permit-already-consumed',
      permitId: '1'.repeat(32),
    });
  });

  it('rejects a signed envelope when its file encoding is not canonical', () => {
    isolateHome();
    const cfg = config('noncanonical');
    const runtime = context(cfg);
    const permit = signedPermit(cfg, runtime);
    const permitPath = daemonActivationPermitPath();
    mkdirSync(dirname(permitPath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(dirname(permitPath)), 0o700);
    chmodSync(dirname(permitPath), 0o700);
    writeFileSync(permitPath, `${JSON.stringify(permit.envelope, null, 2)}\n`, { mode: 0o600 });

    const result = consumeDaemonActivationPermitForVerification(
      cfg,
      { once: true, dryRun: false },
      { trustRoots: [permit.root], context: runtime },
    );

    expect(result.reason).toBe('noncanonical-permit-encoding');
    expect(inspectDaemonActivationPermitForVerification(
      cfg,
      { once: true, dryRun: false },
      { trustRoots: [permit.root], context: runtime },
    )).toMatchObject({
      authority: 'observation-only',
      sourceState: 'degraded',
      state: 'degraded',
      commandEligible: false,
      reason: 'noncanonical-permit-encoding',
    });
    expect(existsSync(permitPath)).toBe(true);
  });

  it('burns authority fail-closed when interrupted after the durable receipt', () => {
    isolateHome();
    const cfg = config('crash');
    const runtime = context(cfg);
    const permit = signedPermit(cfg, runtime);
    const permitPath = installPermit(permit.envelope);

    const interrupted = consumeDaemonActivationPermitForVerification(
      cfg,
      { once: true, dryRun: false },
      {
        trustRoots: [permit.root],
        context: runtime,
        afterReceiptPersisted: () => {
          throw new Error('simulated crash boundary');
        },
      },
    );
    expect(interrupted).toMatchObject({
      authorized: false,
      reason: 'activation-interrupted-after-durable-receipt',
    });
    expect(existsSync(permitPath)).toBe(true);
    expect(existsSync(daemonActivationReceiptPath('1'.repeat(32)))).toBe(true);
    expect(inspectDaemonActivationPermitForVerification(
      cfg,
      { once: true, dryRun: false },
      { trustRoots: [permit.root], context: runtime },
    )).toMatchObject({
      authority: 'observation-only',
      state: 'blocked',
      commandEligible: false,
      reason: 'activation-permit-already-consumed',
    });

    const retry = consumeDaemonActivationPermitForVerification(
      cfg,
      { once: true, dryRun: false },
      { trustRoots: [permit.root], context: runtime },
    );
    expect(retry.reason).toBe('activation-permit-already-consumed');
    expect(retry.authorized).toBe(false);
  });

  it('denies a concurrent consumer while the fixed-path consumption lock is held', () => {
    const home = isolateHome();
    const cfg = config('concurrency');
    const runtime = context(cfg);
    const permit = signedPermit(cfg, runtime);
    installPermit(permit.envelope);
    const lockPath = join(home, '.ashlr', 'control', 'daemon-activation-permit.lock');
    const lock = acquireLocalStoreLock(lockPath, 0, {
      anchorPath: home,
      exactPrivateStorage: true,
    });
    expect(lock).not.toBeNull();

    try {
      const result = consumeDaemonActivationPermitForVerification(
        cfg,
        { once: true, dryRun: false },
        { trustRoots: [permit.root], context: runtime },
      );
      expect(result).toEqual({
        authorized: false,
        required: true,
        reason: 'activation-permit-lock-unavailable',
      });
    } finally {
      expect(releaseLocalStoreLock(lock)).toBe(true);
    }
  }, 10_000);

  it('fails closed on config drift and never persists raw config values', () => {
    isolateHome();
    const signedConfig = config('signed-secret-marker');
    const runtime = context(signedConfig);
    const permit = signedPermit(signedConfig, runtime);
    installPermit(permit.envelope);

    const result = consumeDaemonActivationPermitForVerification(
      config('runtime-secret-marker'),
      { once: true, dryRun: false },
      { trustRoots: [permit.root], context: runtime },
    );
    expect(result).toMatchObject({
      authorized: false,
      required: true,
      reason: 'runtime-config-digest-mismatch',
    });
    expect(existsSync(daemonActivationReceiptPath('1'.repeat(32)))).toBe(false);
  });
});
