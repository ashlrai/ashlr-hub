import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServiceStatusResult } from '../src/core/daemon/service.js';
import {
  daemonStateResolutionIntentPath,
  daemonStateResolutionReceiptPath,
  daemonStateResolutionRetiredMarkerPath,
  executeDaemonStateQuarantine,
  executeDaemonStateResolution,
  prepareDaemonStateAtomicQuarantineEvidence,
  previewDaemonStateQuarantine,
  previewDaemonStateResolution,
  type DaemonStateRecoveryRuntime,
  type DaemonStateResolutionPlan,
  type DaemonStateResolutionRuntime,
} from '../src/core/daemon/state-recovery.js';
import {
  daemonStatePath,
  daemonStateRecoveryMarkerPath,
  freshDaemonState,
  loadDaemonStateStrict,
} from '../src/core/daemon/state.js';
import { canonicalizeDaemonActivationValue } from '../src/core/daemon/activation-permit.js';
import { provenanceKeyPath } from '../src/core/foundry/provenance.js';
import { readDaemonHealth } from '../src/core/readiness.js';
import { diagnoseGuardHealth } from '../src/core/daemon/guard-health.js';

const QUARANTINE_PLAN_ID = '11111111-1111-4111-8111-111111111111';
const RESOLUTION_PLAN_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-08-10T12:00:00.000Z');
const originalHome = process.env['HOME'];
const originalUserProfile = process.env['USERPROFILE'];
let tmpHome: string;

function inactiveService(overrides: Partial<ServiceStatusResult> = {}): ServiceStatusResult {
  return {
    registrationState: 'present',
    installed: true,
    running: false,
    runtimeState: 'stopped',
    platformSpec: 'launchd',
    ...overrides,
  };
}

function quarantineRuntime(
  overrides: Partial<DaemonStateRecoveryRuntime> = {},
): DaemonStateRecoveryRuntime {
  return {
    now: () => NOW,
    randomId: () => QUARANTINE_PLAN_ID,
    serviceStatus: () => inactiveService(),
    prepareAtomicQuarantineEvidence: prepareDaemonStateAtomicQuarantineEvidence,
    ...overrides,
  };
}

function resolutionRuntime(
  overrides: Partial<DaemonStateResolutionRuntime> = {},
): DaemonStateResolutionRuntime {
  return {
    now: () => NOW,
    randomId: () => RESOLUTION_PLAN_ID,
    serviceStatus: () => inactiveService(),
    ...overrides,
  };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function malformedState(): Buffer {
  return Buffer.from(`${JSON.stringify({
    running: false,
    pid: null,
    startedAt: null,
    lastTickAt: null,
    todayDate: '2026-08-10',
    todaySpentUsd: 8.5,
    itemsProcessed: 9,
    ticks: [],
    spendGuardAccounting: {
      accountingId: '22222222-2222-4222-8222-222222222222',
      budgetDay: '2026-08-10',
      unexpected: true,
    },
  }, null, 2)}\n`);
}

function freshBytes(): Buffer {
  return Buffer.from(`${canonicalizeDaemonActivationValue(freshDaemonState())}\n`, 'utf8');
}

function writeMalformedState(): Buffer {
  const bytes = malformedState();
  fs.mkdirSync(path.dirname(daemonStatePath()), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(daemonStatePath()), 0o700);
  fs.writeFileSync(daemonStatePath(), bytes, { mode: 0o600 });
  return bytes;
}

function seedQuarantine(): {
  bytes: Buffer;
  quarantinePath: string;
  receiptDigest: string;
} {
  const bytes = writeMalformedState();
  const preview = previewDaemonStateQuarantine(sha256(bytes), quarantineRuntime());
  expect(preview).toMatchObject({ ok: true });
  if (!preview.ok) throw new Error(preview.detail);
  const executed = executeDaemonStateQuarantine({
    planId: preview.plan.planId,
    planDigest: preview.plan.planDigest,
    operatorAuthorization: preview.plan.planDigest,
  }, quarantineRuntime());
  expect(executed).toMatchObject({ ok: true });
  if (!executed.ok) throw new Error(executed.detail);
  return {
    bytes,
    quarantinePath: executed.quarantinePath,
    receiptDigest: executed.receipt.receiptDigest,
  };
}

function previewResolution(receiptDigest: string): DaemonStateResolutionPlan {
  const preview = previewDaemonStateResolution({
    quarantinePlanId: QUARANTINE_PLAN_ID,
    quarantineReceiptDigest: receiptDigest,
  }, resolutionRuntime());
  expect(preview).toMatchObject({ ok: true });
  if (!preview.ok) throw new Error(preview.detail);
  return preview.plan;
}

function executeInput(plan: DaemonStateResolutionPlan) {
  return {
    planId: plan.planId,
    planDigest: plan.planDigest,
    operatorAuthorization: plan.planDigest,
    operatorConfirmation: plan.planDigest,
  };
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-state-resolution-'));
  fs.chmodSync(tmpHome, 0o700);
  process.env['HOME'] = tmpHome;
  process.env['USERPROFILE'] = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = originalHome;
  if (originalUserProfile === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = originalUserProfile;
});

describe.runIf(process.platform !== 'win32')('daemon state resolution protocol', () => {
  it('persists a signed dry-run plan bound to the exact quarantine chain and canonical fresh bytes', () => {
    const seeded = seedQuarantine();
    const sourceBefore = fs.lstatSync(daemonStatePath());
    const markerBefore = fs.readFileSync(daemonStateRecoveryMarkerPath());
    const plan = previewResolution(seeded.receiptDigest);

    expect(plan).toMatchObject({
      quarantinePlanId: QUARANTINE_PLAN_ID,
      quarantineReceiptDigest: seeded.receiptDigest,
      sourceSha256: sha256(seeded.bytes),
      quarantineSha256: sha256(seeded.bytes),
      freshStateSha256: sha256(freshBytes()),
      freshStateSizeBytes: freshBytes().length,
      requiredServiceActivity: 'inactive',
      authority: {
        dryRunFirst: true,
        repeatedAuthorizationRequired: true,
        exactDestinationReplacementAllowed: true,
        quarantineMutationAllowed: false,
        exactMarkerRetirementAllowed: true,
        serviceMutationAllowed: false,
      },
    });
    expect(Buffer.from(plan.freshStateCanonicalBase64, 'base64')).toEqual(freshBytes());
    expect(fs.readFileSync(daemonStatePath())).toEqual(seeded.bytes);
    expect(fs.lstatSync(daemonStatePath()).ino).toBe(sourceBefore.ino);
    expect(fs.readFileSync(daemonStateRecoveryMarkerPath())).toEqual(markerBefore);
    expect(fs.existsSync(daemonStateResolutionIntentPath(plan.planId))).toBe(false);
  });

  it('atomically replaces only daemon.json, preserves evidence, publishes a receipt, and retires the exact marker', () => {
    const seeded = seedQuarantine();
    const evidenceInode = fs.lstatSync(seeded.quarantinePath).ino;
    const sentinel = path.join(tmpHome, '.ashlr', 'sentinel.txt');
    fs.writeFileSync(sentinel, 'preserve\n', { mode: 0o600 });
    const plan = previewResolution(seeded.receiptDigest);

    const executed = executeDaemonStateResolution(executeInput(plan), resolutionRuntime());

    expect(executed).toMatchObject({ ok: true, resumed: false });
    if (!executed.ok) return;
    expect(fs.readFileSync(daemonStatePath())).toEqual(freshBytes());
    expect(fs.lstatSync(daemonStatePath()).ino).not.toBe(evidenceInode);
    expect(fs.readFileSync(seeded.quarantinePath)).toEqual(seeded.bytes);
    expect(fs.lstatSync(seeded.quarantinePath).ino).toBe(evidenceInode);
    expect(fs.lstatSync(seeded.quarantinePath).nlink).toBe(1);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('preserve\n');
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(false);
    expect(fs.existsSync(executed.receiptPath)).toBe(true);
    expect(fs.existsSync(executed.retiredMarkerPath)).toBe(true);
    expect(loadDaemonStateStrict()).toEqual({ ok: true, state: freshDaemonState(), fresh: false });
    expect(readDaemonHealth()).toMatchObject({
      running: false,
      recoveryBlocked: false,
      recoveryReason: null,
    });
    expect(diagnoseGuardHealth().blocks.map((block) => block.id)).not.toContain('daemon-state-malformed');
  });

  it('requires both exact authorizations before publishing an execution intent', () => {
    const seeded = seedQuarantine();
    const plan = previewResolution(seeded.receiptDigest);
    const missing = executeDaemonStateResolution({
      ...executeInput(plan),
      operatorConfirmation: '',
    }, resolutionRuntime());
    const mismatch = executeDaemonStateResolution({
      ...executeInput(plan),
      operatorConfirmation: '0'.repeat(64),
    }, resolutionRuntime());

    expect(missing).toMatchObject({ ok: false, reason: 'authorization-required' });
    expect(mismatch).toMatchObject({ ok: false, reason: 'authorization-mismatch' });
    expect(fs.existsSync(daemonStateResolutionIntentPath(plan.planId))).toBe(false);
    expect(fs.readFileSync(daemonStatePath())).toEqual(seeded.bytes);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(true);
  });

  it('fails closed for active or unknown service state at preview and execution', () => {
    const seeded = seedQuarantine();
    expect(previewDaemonStateResolution({
      quarantinePlanId: QUARANTINE_PLAN_ID,
      quarantineReceiptDigest: seeded.receiptDigest,
    }, resolutionRuntime({ serviceStatus: () => inactiveService({ running: true, runtimeState: 'running' }) })))
      .toMatchObject({ ok: false, reason: 'service-active' });
    const plan = previewResolution(seeded.receiptDigest);
    expect(executeDaemonStateResolution(executeInput(plan), resolutionRuntime({
      serviceStatus: () => inactiveService({ runtimeState: 'unknown' }),
    }))).toMatchObject({ ok: false, reason: 'service-state-unknown' });
    expect(fs.existsSync(daemonStateResolutionIntentPath(plan.planId))).toBe(false);
    expect(fs.readFileSync(daemonStatePath())).toEqual(seeded.bytes);
  });

  it('refuses Windows execution before intent, state, receipt, or marker mutation', () => {
    const seeded = seedQuarantine();
    const plan = previewResolution(seeded.receiptDigest);
    const marker = fs.readFileSync(daemonStateRecoveryMarkerPath());

    const result = executeDaemonStateResolution(executeInput(plan), resolutionRuntime({ platform: 'win32' }));

    expect(result).toMatchObject({ ok: false, reason: 'atomic-replacement-unavailable' });
    expect(fs.existsSync(daemonStateResolutionIntentPath(plan.planId))).toBe(false);
    expect(fs.existsSync(daemonStateResolutionReceiptPath(plan.planId))).toBe(false);
    expect(fs.readFileSync(daemonStatePath())).toEqual(seeded.bytes);
    expect(fs.readFileSync(daemonStateRecoveryMarkerPath())).toEqual(marker);
  });

  it('refuses an expired unconsumed plan but resumes an authorized intent after expiry', () => {
    const seeded = seedQuarantine();
    const plan = previewResolution(seeded.receiptDigest);
    const expired = new Date(NOW.getTime() + 11 * 60_000);
    expect(executeDaemonStateResolution(executeInput(plan), resolutionRuntime({ now: () => expired })))
      .toMatchObject({ ok: false, reason: 'plan-expired' });
    expect(fs.existsSync(daemonStateResolutionIntentPath(plan.planId))).toBe(false);

    const interrupted = executeDaemonStateResolution(executeInput(plan), resolutionRuntime({
      beforeStatePublish: () => { throw new Error('stop after intent'); },
    }));
    expect(interrupted).toMatchObject({ ok: false, reason: 'state-publication-failed' });
    expect(fs.existsSync(daemonStateResolutionIntentPath(plan.planId))).toBe(true);
    const resumed = executeDaemonStateResolution(executeInput(plan), resolutionRuntime({ now: () => expired }));
    expect(resumed).toMatchObject({ ok: true, resumed: true });
  });

  it('fails closed on signer rotation, source drift, marker drift, and quarantine ACL drift', () => {
    const cases: Array<(seeded: ReturnType<typeof seedQuarantine>, plan: DaemonStateResolutionPlan) => void> = [
      () => {
        fs.writeFileSync(provenanceKeyPath(), Buffer.alloc(32, 7), { mode: 0o600 });
        fs.chmodSync(provenanceKeyPath(), 0o600);
      },
      () => {
        fs.renameSync(daemonStatePath(), `${daemonStatePath()}.displaced`);
        fs.writeFileSync(daemonStatePath(), Buffer.from('{"running":false}\n'), { mode: 0o600 });
      },
      () => {
        fs.unlinkSync(daemonStateRecoveryMarkerPath());
        fs.writeFileSync(daemonStateRecoveryMarkerPath(), '{"forged":true}\n', { mode: 0o600 });
      },
      (seeded) => {
        fs.chmodSync(path.dirname(seeded.quarantinePath), 0o755);
      },
    ];
    const expectedReasons = [
      'plan-tampered',
      'resolution-state-conflict',
      'recovery-marker-conflict',
      'quarantine-evidence-drift',
    ];
    for (const [index, mutate] of cases.entries()) {
      if (index > 0) {
        fs.rmSync(tmpHome, { recursive: true, force: true });
        tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-state-resolution-case-'));
        fs.chmodSync(tmpHome, 0o700);
        process.env['HOME'] = tmpHome;
        process.env['USERPROFILE'] = tmpHome;
      }
      const seeded = seedQuarantine();
      const plan = previewResolution(seeded.receiptDigest);
      mutate(seeded, plan);
      expect(executeDaemonStateResolution(executeInput(plan), resolutionRuntime()))
        .toMatchObject({ ok: false, reason: expectedReasons[index] });
      expect(fs.existsSync(daemonStateResolutionIntentPath(plan.planId))).toBe(false);
    }
  });

  it('detects a destination race after staging without overwriting the raced state', () => {
    const seeded = seedQuarantine();
    const plan = previewResolution(seeded.receiptDigest);
    const raced = Buffer.from('{"raced":true}\n');
    const result = executeDaemonStateResolution(executeInput(plan), resolutionRuntime({
      beforeStatePublish: () => {
        fs.renameSync(daemonStatePath(), `${daemonStatePath()}.displaced`);
        fs.writeFileSync(daemonStatePath(), raced, { mode: 0o600 });
      },
    }));

    expect(result).toMatchObject({ ok: false, reason: 'resolution-state-conflict' });
    expect(fs.readFileSync(daemonStatePath())).toEqual(raced);
    expect(fs.readFileSync(seeded.quarantinePath)).toEqual(seeded.bytes);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(true);
  });

  it('rechecks service and lock ownership immediately before state publication', () => {
    const seeded = seedQuarantine();
    const plan = previewResolution(seeded.receiptDigest);
    let active = false;
    const serviceRace = executeDaemonStateResolution(executeInput(plan), resolutionRuntime({
      serviceStatus: () => active
        ? inactiveService({ running: true, runtimeState: 'running' })
        : inactiveService(),
      beforeStatePublish: () => { active = true; },
    }));
    expect(serviceRace).toMatchObject({ ok: false, reason: 'service-active' });
    expect(fs.readFileSync(daemonStatePath())).toEqual(seeded.bytes);

    const recoveryLockPath = path.join(
      tmpHome,
      '.ashlr',
      'control',
      'daemon-state-recovery',
      'locks',
      'quarantine.lock',
    );
    const lockRace = executeDaemonStateResolution(executeInput(plan), resolutionRuntime({
      beforeStatePublish: () => { fs.rmSync(recoveryLockPath, { force: true }); },
    }));
    expect(lockRace).toMatchObject({ ok: false, reason: 'recovery-lock-unavailable' });
    expect(fs.readFileSync(daemonStatePath())).toEqual(seeded.bytes);
  });

  it('resumes after crashes following state publication, receipt publication, and marker retirement staging', { timeout: 15_000 }, () => {
    const crashHooks: Array<Partial<DaemonStateResolutionRuntime>> = [
      { afterStatePublish: () => { throw new Error('crash after state'); } },
      { afterReceiptStage: () => { throw new Error('crash after receipt staging'); } },
      { afterReceiptPublish: () => { throw new Error('crash after receipt'); } },
      { beforeMarkerRetirement: () => { throw new Error('crash before marker unlink'); } },
    ];
    for (const [index, hooks] of crashHooks.entries()) {
      if (index > 0) {
        fs.rmSync(tmpHome, { recursive: true, force: true });
        tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-state-resolution-crash-'));
        fs.chmodSync(tmpHome, 0o700);
        process.env['HOME'] = tmpHome;
        process.env['USERPROFILE'] = tmpHome;
      }
      const seeded = seedQuarantine();
      const plan = previewResolution(seeded.receiptDigest);
      const interrupted = executeDaemonStateResolution(executeInput(plan), resolutionRuntime(hooks));
      expect(interrupted.ok).toBe(false);
      expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(true);
      expect(fs.readFileSync(seeded.quarantinePath)).toEqual(seeded.bytes);

      const resumed = executeDaemonStateResolution(executeInput(plan), resolutionRuntime());
      expect(resumed).toMatchObject({ ok: true, resumed: true });
      expect(fs.readFileSync(daemonStatePath())).toEqual(freshBytes());
      expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(false);
      expect(fs.existsSync(daemonStateResolutionRetiredMarkerPath(plan.planId))).toBe(true);
    }
  });

  it('never retires a replacement marker raced in after receipt publication', () => {
    const seeded = seedQuarantine();
    const plan = previewResolution(seeded.receiptDigest);
    const replacement = Buffer.from('{"replacement":true}\n');
    const result = executeDaemonStateResolution(executeInput(plan), resolutionRuntime({
      beforeMarkerRetirement: () => {
        fs.unlinkSync(daemonStateRecoveryMarkerPath());
        fs.writeFileSync(daemonStateRecoveryMarkerPath(), replacement, { mode: 0o600 });
      },
    }));

    expect(result).toMatchObject({ ok: false, reason: 'marker-retirement-failed' });
    expect(fs.readFileSync(daemonStateRecoveryMarkerPath())).toEqual(replacement);
    expect(fs.readFileSync(daemonStatePath())).toEqual(freshBytes());
    expect(fs.readFileSync(seeded.quarantinePath)).toEqual(seeded.bytes);
    expect(fs.existsSync(daemonStateResolutionReceiptPath(plan.planId))).toBe(true);
  });

  it('refuses fresh-state or evidence hard-link drift after the signed receipt', () => {
    for (const target of ['state', 'evidence'] as const) {
      if (target === 'evidence') {
        fs.rmSync(tmpHome, { recursive: true, force: true });
        tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-state-resolution-link-'));
        fs.chmodSync(tmpHome, 0o700);
        process.env['HOME'] = tmpHome;
        process.env['USERPROFILE'] = tmpHome;
      }
      const seeded = seedQuarantine();
      const plan = previewResolution(seeded.receiptDigest);
      expect(executeDaemonStateResolution(executeInput(plan), resolutionRuntime({
        afterReceiptPublish: () => { throw new Error('pause with receipt'); },
      }))).toMatchObject({ ok: false, reason: 'receipt-write-failed' });
      const source = target === 'state' ? daemonStatePath() : seeded.quarantinePath;
      fs.linkSync(source, `${source}.unexpected-link`);

      expect(executeDaemonStateResolution(executeInput(plan), resolutionRuntime()))
        .toMatchObject({ ok: false, reason: 'resolution-state-conflict' });
      expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(true);
    }
  });

  it('is idempotently resumable after completion and refuses a forged terminal receipt', () => {
    const seeded = seedQuarantine();
    const plan = previewResolution(seeded.receiptDigest);
    expect(executeDaemonStateResolution(executeInput(plan), resolutionRuntime())).toMatchObject({ ok: true });
    expect(executeDaemonStateResolution(executeInput(plan), resolutionRuntime()))
      .toMatchObject({ ok: true, resumed: true });

    fs.writeFileSync(daemonStateResolutionReceiptPath(plan.planId), '{"forged":true}\n', { mode: 0o600 });
    expect(executeDaemonStateResolution(executeInput(plan), resolutionRuntime()))
      .toMatchObject({ ok: false, reason: 'receipt-write-failed' });
    expect(fs.readFileSync(daemonStatePath())).toEqual(freshBytes());
    expect(fs.readFileSync(seeded.quarantinePath)).toEqual(seeded.bytes);
  });
});
