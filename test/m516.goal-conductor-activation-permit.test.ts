import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { AshlrConfig } from '../src/core/types.js';
import {
  buildDaemonActivationPermitPayload,
  buildGoalConductorActivationPermitPayload,
  canonicalizeDaemonActivationValue,
  consumeGoalConductorActivationPermit,
  consumeGoalConductorActivationPermitForVerification,
  daemonActivationConfigDigest,
  goalConductorActivationPermitPath,
  goalConductorActivationReceiptPath,
  isGoalConductorActivationCapability,
  signDaemonActivationPermit,
  signGoalConductorActivationPermit,
  verifyDaemonActivationPermit,
  verifyGoalConductorActivationPermit,
  type DaemonActivationRuntimeContext,
  type DaemonActivationTrustRoot,
  type GoalConductorActivationContext,
  type GoalConductorActivationPermitEnvelope,
  type GoalConductorActivationTarget,
} from '../src/core/daemon/activation-permit.js';

const originalHome = process.env['HOME'];
const originalUserProfile = process.env['USERPROFILE'];
const homes: string[] = [];

function isolateHome(): string {
  const home = join(tmpdir(), `ashlr-m516-${process.pid}-${homes.length}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  homes.push(home);
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  return home;
}

afterEach(() => {
  if (originalHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = originalHome;
  if (originalUserProfile === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = originalUserProfile;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function cfg(): AshlrConfig {
  return { project: { name: 'm516' } } as unknown as AshlrConfig;
}

function keys(): { privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']; root: DaemonActivationTrustRoot } {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey,
    root: {
      keyId: 'm516-test-root',
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
  };
}

const target: GoalConductorActivationTarget = {
  goalId: 'goal-one',
  milestoneId: 'goal-one-m0',
  goalDigest: 'a'.repeat(64),
  projectPath: '/tmp/enrolled-project',
};

function baseContext(config: AshlrConfig): DaemonActivationRuntimeContext {
  return {
    nowMs: Date.parse('2026-08-16T20:00:00.000Z'),
    configDigest: daemonActivationConfigDigest(config),
    buildIdentity: {
      schemaVersion: 1,
      packageVersion: '3.2.6',
      revision: 'b'.repeat(40),
      dirty: false,
      provenance: 'git',
    },
    executable: { path: '/tmp/node', sha256: 'c'.repeat(64) },
    entrypoint: { path: '/tmp/ashlr', sha256: 'd'.repeat(64) },
    releaseTree: { path: '/tmp/release', sha256: 'e'.repeat(64) },
    authorityStateDigest: 'f'.repeat(64),
    killSwitchOff: true,
    guardHealthHealthy: true,
  };
}

function signedPermit(
  config = cfg(),
  boundTarget = target,
): {
  envelope: GoalConductorActivationPermitEnvelope;
  root: DaemonActivationTrustRoot;
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  context: GoalConductorActivationContext;
} {
  const key = keys();
  const context = { ...baseContext(config), target: boundTarget };
  const payload = buildGoalConductorActivationPermitPayload({
    permitId: '1'.repeat(32),
    nonce: '2'.repeat(64),
    keyId: key.root.keyId,
    issuedAt: new Date(context.nowMs - 1_000).toISOString(),
    expiresAt: new Date(context.nowMs + 60_000).toISOString(),
    context,
  });
  return {
    envelope: signGoalConductorActivationPermit(payload, key.privateKey),
    root: key.root,
    privateKey: key.privateKey,
    context,
  };
}

function installPermit(envelope: GoalConductorActivationPermitEnvelope): void {
  const path = goalConductorActivationPermitPath();
  mkdirSync(dirname(dirname(path)), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(dirname(path)), 0o700);
  chmodSync(dirname(path), 0o700);
  writeFileSync(path, `${canonicalizeDaemonActivationValue(envelope)}\n`, { mode: 0o600 });
}

describe('M516 dormant signed one-shot goal conductor permit', () => {
  it('keeps production roots empty and reads no permit', () => {
    const home = isolateHome();
    expect(consumeGoalConductorActivationPermit(cfg(), target)).toEqual({
      authorized: false,
      reason: 'no-trusted-goal-conductor-activation-roots',
    });
    expect(existsSync(join(home, '.ashlr'))).toBe(false);
    expect(isGoalConductorActivationCapability({
      kind: 'goal-conductor-proposal-once',
      permitId: '1'.repeat(32),
      target,
    }, target)).toBe(false);
  });

  it('cryptographically separates daemon and conductor permit domains', () => {
    const config = cfg();
    const conductor = signedPermit(config);
    expect(verifyDaemonActivationPermit(conductor.envelope, conductor.context, [conductor.root]).reason)
      .toBe('invalid-permit-schema');

    const daemonPayload = buildDaemonActivationPermitPayload({
      permitId: '3'.repeat(32),
      nonce: '4'.repeat(64),
      keyId: conductor.root.keyId,
      issuedAt: new Date(conductor.context.nowMs - 1_000).toISOString(),
      expiresAt: new Date(conductor.context.nowMs + 60_000).toISOString(),
      context: conductor.context,
    });
    const daemon = signDaemonActivationPermit(daemonPayload, conductor.privateKey);
    expect(verifyGoalConductorActivationPermit(daemon, conductor.context, [conductor.root]).reason)
      .toBe('invalid-goal-conductor-permit-schema');
    expect(verifyDaemonActivationPermit(
      { payload: daemonPayload, signature: conductor.envelope.signature },
      conductor.context,
      [conductor.root],
    ).reason).toBe('invalid-permit-signature');
    expect(verifyGoalConductorActivationPermit(
      { payload: conductor.envelope.payload, signature: daemon.signature },
      conductor.context,
      [conductor.root],
    ).reason).toBe('invalid-permit-signature');
  });

  it('binds the exact goal, milestone, project, and goal digest', () => {
    const permit = signedPermit();
    expect(verifyGoalConductorActivationPermit(
      permit.envelope,
      permit.context,
      [permit.root],
    ).ok).toBe(true);
    expect(verifyGoalConductorActivationPermit(
      permit.envelope,
      { ...permit.context, target: { ...target, milestoneId: 'goal-one-m1' } },
      [permit.root],
    ).reason).toBe('goal-conductor-permit-runtime-binding-mismatch');
  });

  it('persists a metadata-only receipt before unlink and denies replay', () => {
    isolateHome();
    const config = cfg();
    const permit = signedPermit(config);
    installPermit(permit.envelope);
    const result = consumeGoalConductorActivationPermitForVerification(config, target, {
      trustRoots: [permit.root],
      context: permit.context,
    });
    expect(result).toMatchObject({
      authorized: true,
      reason: 'goal-conductor-proposal-once-activation-authorized',
      permitId: '1'.repeat(32),
    });
    expect(existsSync(goalConductorActivationPermitPath())).toBe(false);
    const receipt = JSON.parse(readFileSync(goalConductorActivationReceiptPath('1'.repeat(32)), 'utf8')) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      action: 'goal-conductor-proposal-once',
      goalId: target.goalId,
      milestoneId: target.milestoneId,
      goalDigest: target.goalDigest,
      state: 'consumed-before-permit-unlink',
    });
    expect(JSON.stringify(receipt)).not.toContain(permit.envelope.payload.nonce);

    installPermit(permit.envelope);
    expect(consumeGoalConductorActivationPermitForVerification(config, target, {
      trustRoots: [permit.root],
      context: permit.context,
    })).toMatchObject({
      authorized: false,
      reason: 'goal-conductor-permit-already-consumed',
    });
  });

  it('burns authority when interrupted after durable receipt persistence', () => {
    isolateHome();
    const config = cfg();
    const permit = signedPermit(config);
    installPermit(permit.envelope);
    const result = consumeGoalConductorActivationPermitForVerification(config, target, {
      trustRoots: [permit.root],
      context: permit.context,
      afterReceiptPersisted: () => { throw new Error('simulated interruption'); },
    });
    expect(result).toMatchObject({
      authorized: false,
      reason: 'goal-conductor-activation-interrupted-after-durable-receipt',
    });
    expect(existsSync(goalConductorActivationPermitPath())).toBe(true);
    expect(existsSync(goalConductorActivationReceiptPath('1'.repeat(32)))).toBe(true);
  });
});
