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
import {
  acquireDaemonServiceLifecycleFence,
  releaseDaemonServiceLifecycleFence,
} from '../src/core/daemon/service-lifecycle-fence.js';
import { fsyncDirectory } from '../src/core/util/durability.js';

const QUARANTINE_PLAN_ID = '11111111-1111-4111-8111-111111111111';
const RESOLUTION_PLAN_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-08-10T12:00:00.000Z');
const originalHome = process.env['HOME'];
const originalUserProfile = process.env['USERPROFILE'];
let tmpHome: string;

function inactiveService(overrides: Partial<ServiceStatusResult> = {}): ServiceStatusResult {
  return {
    registrationState: 'absent',
    installed: false,
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
    dailyBudgetUsd: () => 10,
    ...overrides,
  };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function malformedState(overrides: Record<string, unknown> = {}): Buffer {
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
    ...overrides,
  }, null, 2)}\n`);
}

function resolvedState() {
  return {
    ...freshDaemonState(),
    todayDate: '2026-08-10',
    todaySpentUsd: 10,
    spendGuardAccounting: {
      budgetDay: '2026-08-10',
      accountingId: RESOLUTION_PLAN_ID,
      budgetExhausted: true,
    },
  };
}

function resolvedBytes(): Buffer {
  return Buffer.from(`${canonicalizeDaemonActivationValue(resolvedState())}\n`, 'utf8');
}

function writeMalformedState(bytes = malformedState()): Buffer {
  fs.mkdirSync(path.dirname(daemonStatePath()), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(daemonStatePath()), 0o700);
  fs.writeFileSync(daemonStatePath(), bytes, { mode: 0o600 });
  return bytes;
}

function seedQuarantine(bytes = malformedState()): {
  bytes: Buffer;
  quarantinePath: string;
  receiptDigest: string;
} {
  writeMalformedState(bytes);
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

function previewResolution(
  receiptDigest: string,
  runtime = resolutionRuntime(),
): DaemonStateResolutionPlan {
  const preview = previewDaemonStateResolution({
    quarantinePlanId: QUARANTINE_PLAN_ID,
    quarantineReceiptDigest: receiptDigest,
  }, runtime);
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
      freshStateSha256: sha256(resolvedBytes()),
      freshStateSizeBytes: resolvedBytes().length,
      requiredServiceActivity: 'inactive',
      requiredSupervisorRegistration: 'absent',
      authority: {
        dryRunFirst: true,
        repeatedAuthorizationRequired: true,
        exactDestinationReplacementAllowed: true,
        quarantineMutationAllowed: false,
        exactMarkerRetirementAllowed: true,
        serviceMutationAllowed: false,
      },
    });
    expect(Buffer.from(plan.freshStateCanonicalBase64, 'base64')).toEqual(resolvedBytes());
    expect(JSON.parse(Buffer.from(plan.derivedAccountingCanonicalBase64, 'base64').toString('utf8'))).toMatchObject({
      budgetDay: '2026-08-10',
      configuredDailyBudgetUsd: 10,
      sourceBudgetDay: '2026-08-10',
      sourceSpentUsd: 8.5,
      sourceAccounting: 'malformed',
      disposition: 'same-day-exhausted',
      resolvedSpentUsd: 10,
      budgetExhausted: true,
    });
    expect(plan.derivedAccountingSha256).toBe(sha256(
      Buffer.from(plan.derivedAccountingCanonicalBase64, 'base64'),
    ));
    expect(fs.readFileSync(daemonStatePath())).toEqual(seeded.bytes);
    expect(fs.lstatSync(daemonStatePath()).ino).toBe(sourceBefore.ino);
    expect(fs.readFileSync(daemonStateRecoveryMarkerPath())).toEqual(markerBefore);
    expect(fs.existsSync(daemonStateResolutionIntentPath(plan.planId))).toBe(false);
  });

  it('preserves higher current-day spend and resets only a proven prior UTC day', () => {
    const current = seedQuarantine(malformedState({
      todaySpentUsd: 12.25,
      itemsProcessed: -1,
    }));
    const currentPlan = previewResolution(current.receiptDigest);
    expect(JSON.parse(Buffer.from(currentPlan.freshStateCanonicalBase64, 'base64').toString('utf8')))
      .toMatchObject({ todayDate: '2026-08-10', todaySpentUsd: 12.25 });

    fs.rmSync(tmpHome, { recursive: true, force: true });
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-state-resolution-prior-day-'));
    fs.chmodSync(tmpHome, 0o700);
    process.env['HOME'] = tmpHome;
    process.env['USERPROFILE'] = tmpHome;
    const prior = seedQuarantine(malformedState({
      todayDate: '2026-08-09',
      todaySpentUsd: 99,
      pid: 'invalid',
      spendGuardAccounting: undefined,
    }));
    const priorPlan = previewResolution(prior.receiptDigest);
    expect(JSON.parse(Buffer.from(priorPlan.derivedAccountingCanonicalBase64, 'base64').toString('utf8')))
      .toMatchObject({ disposition: 'prior-day-reset', sourceSpentUsd: 99, resolvedSpentUsd: 0 });
    expect(JSON.parse(Buffer.from(priorPlan.freshStateCanonicalBase64, 'base64').toString('utf8')))
      .toEqual({
        itemsProcessed: 0,
        lastTickAt: null,
        pid: null,
        running: false,
        startedAt: null,
        ticks: [],
        todayDate: '2026-08-10',
        todaySpentUsd: 0,
      });
  });

  it('exhausts the configured day for malformed, future, or negative accounting authority', () => {
    const attacks = [
      { todayDate: 'not-a-day', todaySpentUsd: 2 },
      { todayDate: '2026-08-11', todaySpentUsd: 2 },
      { todayDate: '2026-08-10', todaySpentUsd: -1 },
      { todayDate: '2026-08-09', todaySpentUsd: 2 },
    ];
    for (const [index, attack] of attacks.entries()) {
      if (index > 0) {
        fs.rmSync(tmpHome, { recursive: true, force: true });
        tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-state-resolution-accounting-attack-'));
        fs.chmodSync(tmpHome, 0o700);
        process.env['HOME'] = tmpHome;
        process.env['USERPROFILE'] = tmpHome;
      }
      const seeded = seedQuarantine(malformedState(attack));
      const plan = previewResolution(seeded.receiptDigest);
      expect(JSON.parse(Buffer.from(plan.derivedAccountingCanonicalBase64, 'base64').toString('utf8')))
        .toMatchObject({ disposition: 'ambiguous-exhausted', resolvedSpentUsd: 10, budgetExhausted: true });
      expect(JSON.parse(Buffer.from(plan.freshStateCanonicalBase64, 'base64').toString('utf8')))
        .toMatchObject({
          todayDate: '2026-08-10',
          todaySpentUsd: 10,
          spendGuardAccounting: { budgetExhausted: true },
        });
    }
  });

  it('refuses stale accounting derivations after a budget change or UTC rollover', () => {
    const seeded = seedQuarantine();
    const plan = previewResolution(seeded.receiptDigest);
    expect(executeDaemonStateResolution(executeInput(plan), resolutionRuntime({ dailyBudgetUsd: () => 20 })))
      .toMatchObject({ ok: false, reason: 'accounting-state-unknown' });
    expect(executeDaemonStateResolution(executeInput(plan), resolutionRuntime({
      now: () => new Date('2026-08-11T00:00:00.000Z'),
    }))).toMatchObject({ ok: false, reason: 'accounting-state-unknown' });
    expect(fs.existsSync(daemonStateResolutionIntentPath(plan.planId))).toBe(false);
    expect(fs.readFileSync(daemonStatePath())).toEqual(seeded.bytes);
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
    expect(executed.receipt).toMatchObject({
      derivedAccountingCanonicalBase64: plan.derivedAccountingCanonicalBase64,
      derivedAccountingSha256: plan.derivedAccountingSha256,
      derivedAccountingSizeBytes: plan.derivedAccountingSizeBytes,
      supervisorObservationCanonicalBase64: plan.supervisorObservationCanonicalBase64,
      supervisorObservationSha256: plan.supervisorObservationSha256,
      supervisorObservationSizeBytes: plan.supervisorObservationSizeBytes,
    });
    expect(fs.readFileSync(daemonStatePath())).toEqual(resolvedBytes());
    expect(fs.lstatSync(daemonStatePath()).ino).not.toBe(evidenceInode);
    expect(fs.readFileSync(seeded.quarantinePath)).toEqual(seeded.bytes);
    expect(fs.lstatSync(seeded.quarantinePath).ino).toBe(evidenceInode);
    expect(fs.lstatSync(seeded.quarantinePath).nlink).toBe(1);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('preserve\n');
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(false);
    expect(fs.existsSync(executed.receiptPath)).toBe(true);
    expect(fs.existsSync(executed.retiredMarkerPath)).toBe(true);
    expect(loadDaemonStateStrict()).toEqual({ ok: true, state: resolvedState(), fresh: false });
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

  it('refuses stopped but registered launchd, systemd, and Windows supervisors', () => {
    for (const platformSpec of ['launchd', 'systemd', 'schtasks'] as const) {
      const seeded = seedQuarantine();
      expect(previewDaemonStateResolution({
        quarantinePlanId: QUARANTINE_PLAN_ID,
        quarantineReceiptDigest: seeded.receiptDigest,
      }, resolutionRuntime({
        serviceStatus: () => inactiveService({
          registrationState: 'present',
          installed: true,
          runtimeState: platformSpec === 'schtasks' ? 'ready' : 'stopped',
          platformSpec,
        }),
      }))).toMatchObject({ ok: false, reason: 'supervisor-registered' });
      fs.rmSync(tmpHome, { recursive: true, force: true });
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-state-resolution-supervisor-'));
      fs.chmodSync(tmpHome, 0o700);
      process.env['HOME'] = tmpHome;
      process.env['USERPROFILE'] = tmpHome;
    }
  });

  it('blocks supervisor registration races between staged intent, retry, and final marker retirement', () => {
    const seeded = seedQuarantine();
    const plan = previewResolution(seeded.receiptDigest);
    let registered = false;
    const status = () => registered
      ? inactiveService({ registrationState: 'present', installed: true, runtimeState: 'ready' })
      : inactiveService();
    const stagedRace = executeDaemonStateResolution(executeInput(plan), resolutionRuntime({
      serviceStatus: status,
      afterIntentStage: () => { registered = true; },
    }));
    expect(stagedRace).toMatchObject({ ok: false, reason: 'supervisor-registered' });
    expect(fs.existsSync(daemonStateResolutionIntentPath(plan.planId))).toBe(false);
    expect(executeDaemonStateResolution(executeInput(plan), resolutionRuntime({ serviceStatus: status })))
      .toMatchObject({ ok: false, reason: 'supervisor-registered' });
    registered = false;
    expect(executeDaemonStateResolution(executeInput(plan), resolutionRuntime({ serviceStatus: status })))
      .toMatchObject({ ok: true });

    fs.rmSync(tmpHome, { recursive: true, force: true });
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-state-resolution-supervisor-final-'));
    fs.chmodSync(tmpHome, 0o700);
    process.env['HOME'] = tmpHome;
    process.env['USERPROFILE'] = tmpHome;
    const finalSeeded = seedQuarantine();
    const finalPlan = previewResolution(finalSeeded.receiptDigest);
    registered = false;
    expect(executeDaemonStateResolution(executeInput(finalPlan), resolutionRuntime({
      serviceStatus: status,
      beforeMarkerRetirement: () => { registered = true; },
    }))).toMatchObject({ ok: false, reason: 'supervisor-registered' });
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(true);
    expect(fs.existsSync(daemonStateResolutionReceiptPath(finalPlan.planId))).toBe(true);
    expect(executeDaemonStateResolution(executeInput(finalPlan), resolutionRuntime({ serviceStatus: status })))
      .toMatchObject({ ok: false, reason: 'supervisor-registered' });
    registered = false;
    expect(executeDaemonStateResolution(executeInput(finalPlan), resolutionRuntime({ serviceStatus: status })))
      .toMatchObject({ ok: true, resumed: true });
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

  it('rechecks plan expiry immediately before publishing the durable intent', () => {
    const seeded = seedQuarantine();
    const plan = previewResolution(seeded.receiptDigest);
    let now = NOW;
    const result = executeDaemonStateResolution(executeInput(plan), resolutionRuntime({
      now: () => now,
      afterIntentStage: () => { now = new Date(plan.expiresAt); },
    }));

    expect(result).toMatchObject({ ok: false, reason: 'plan-expired' });
    expect(fs.existsSync(daemonStateResolutionIntentPath(plan.planId))).toBe(false);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(true);
    expect(fs.readFileSync(daemonStatePath())).toEqual(seeded.bytes);
  });

  it('holds the service lifecycle fence through the final uncached supervisor observation', () => {
    const seeded = seedQuarantine();
    const plan = previewResolution(seeded.receiptDigest);
    let competingFenceAcquired = true;
    let observations = 0;
    const result = executeDaemonStateResolution(executeInput(plan), resolutionRuntime({
      serviceStatus: () => {
        observations += 1;
        return inactiveService();
      },
      afterLifecycleFenceAcquire: () => {
        const competing = acquireDaemonServiceLifecycleFence(tmpHome, 0);
        competingFenceAcquired = competing !== null;
        releaseDaemonServiceLifecycleFence(competing);
      },
    }));

    expect(result).toMatchObject({ ok: true });
    expect(competingFenceAcquired).toBe(false);
    expect(observations).toBeGreaterThan(1);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(false);
  });

  it('refuses marker retirement when registration appears after the lifecycle fence is held', () => {
    const seeded = seedQuarantine();
    const plan = previewResolution(seeded.receiptDigest);
    let registered = false;
    const result = executeDaemonStateResolution(executeInput(plan), resolutionRuntime({
      serviceStatus: () => registered
        ? inactiveService({ registrationState: 'present', installed: true, runtimeState: 'ready' })
        : inactiveService(),
      afterLifecycleFenceAcquire: () => { registered = true; },
    }));

    expect(result).toMatchObject({ ok: false, reason: 'supervisor-registered' });
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(true);
    expect(fs.existsSync(daemonStateResolutionReceiptPath(plan.planId))).toBe(true);
    expect(fs.readFileSync(daemonStatePath())).toEqual(resolvedBytes());
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

  it('resumes a durably staged intent and recovers a torn final intent before effects', () => {
    const seeded = seedQuarantine();
    const plan = previewResolution(seeded.receiptDigest);
    const staged = executeDaemonStateResolution(executeInput(plan), resolutionRuntime({
      afterIntentStage: () => { throw new Error('crash after intent stage'); },
    }));
    expect(staged).toMatchObject({ ok: false, reason: 'resolution-intent-conflict' });
    expect(fs.existsSync(daemonStateResolutionIntentPath(plan.planId))).toBe(false);
    expect(executeDaemonStateResolution(executeInput(plan), resolutionRuntime()))
      .toMatchObject({ ok: true, resumed: true });

    fs.rmSync(tmpHome, { recursive: true, force: true });
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-state-resolution-torn-intent-'));
    fs.chmodSync(tmpHome, 0o700);
    process.env['HOME'] = tmpHome;
    process.env['USERPROFILE'] = tmpHome;
    const tornSeeded = seedQuarantine();
    const tornPlan = previewResolution(tornSeeded.receiptDigest);
    const intentPath = daemonStateResolutionIntentPath(tornPlan.planId);
    fs.mkdirSync(path.dirname(intentPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(intentPath, '{"schemaVersion":1', { mode: 0o600 });
    expect(executeDaemonStateResolution(executeInput(tornPlan), resolutionRuntime()))
      .toMatchObject({ ok: true });
    expect(fs.readFileSync(tornSeeded.quarantinePath)).toEqual(tornSeeded.bytes);
  });

  it('preserves a valid conflicting intent instead of overwriting it', () => {
    const seeded = seedQuarantine();
    const firstPlanId = '33333333-3333-4333-8333-333333333333';
    const secondPlanId = '44444444-4444-4444-8444-444444444444';
    const first = previewResolution(seeded.receiptDigest, resolutionRuntime({ randomId: () => firstPlanId }));
    const second = previewResolution(seeded.receiptDigest, resolutionRuntime({ randomId: () => secondPlanId }));
    expect(executeDaemonStateResolution(executeInput(first), resolutionRuntime({
      randomId: () => firstPlanId,
      beforeStatePublish: () => { throw new Error('pause after first intent'); },
    }))).toMatchObject({ ok: false, reason: 'state-publication-failed' });
    const firstIntent = fs.readFileSync(daemonStateResolutionIntentPath(first.planId));
    fs.writeFileSync(daemonStateResolutionIntentPath(second.planId), firstIntent, { mode: 0o600 });
    expect(executeDaemonStateResolution(executeInput(second), resolutionRuntime({ randomId: () => secondPlanId })))
      .toMatchObject({ ok: false, reason: 'resolution-intent-conflict' });
    expect(fs.readFileSync(daemonStateResolutionIntentPath(second.planId))).toEqual(firstIntent);
    expect(fs.readFileSync(daemonStatePath())).toEqual(seeded.bytes);
  });

  it('repairs a crash or short-written deterministic state temp but preserves complete conflicts', () => {
    const seeded = seedQuarantine();
    const plan = previewResolution(seeded.receiptDigest);
    const stateTempPath = path.join(
      path.dirname(daemonStatePath()),
      `.${path.basename(daemonStatePath())}.resolution.${plan.planId}.${plan.freshStateSha256}.tmp`,
    );
    fs.writeFileSync(stateTempPath, Buffer.from(plan.freshStateCanonicalBase64, 'base64').subarray(0, 17), { mode: 0o600 });
    expect(executeDaemonStateResolution(executeInput(plan), resolutionRuntime())).toMatchObject({ ok: true });

    fs.rmSync(tmpHome, { recursive: true, force: true });
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-state-resolution-temp-conflict-'));
    fs.chmodSync(tmpHome, 0o700);
    process.env['HOME'] = tmpHome;
    process.env['USERPROFILE'] = tmpHome;
    const conflictSeeded = seedQuarantine();
    const conflictPlan = previewResolution(conflictSeeded.receiptDigest);
    const conflictPath = path.join(
      path.dirname(daemonStatePath()),
      `.${path.basename(daemonStatePath())}.resolution.${conflictPlan.planId}.${conflictPlan.freshStateSha256}.tmp`,
    );
    const conflict = Buffer.alloc(Buffer.from(conflictPlan.freshStateCanonicalBase64, 'base64').length, 0x78);
    fs.writeFileSync(conflictPath, conflict, { mode: 0o600 });
    expect(executeDaemonStateResolution(executeInput(conflictPlan), resolutionRuntime()))
      .toMatchObject({ ok: false, reason: 'state-publication-failed' });
    expect(fs.readFileSync(conflictPath)).toEqual(conflict);
    expect(fs.readFileSync(daemonStatePath())).toEqual(conflictSeeded.bytes);
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
      expect(fs.readFileSync(daemonStatePath())).toEqual(resolvedBytes());
      expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(false);
      expect(fs.existsSync(daemonStateResolutionRetiredMarkerPath(plan.planId))).toBe(true);
    }
  });

  it('re-durabilizes an intent left visible by a failed publication sync before executing it', () => {
    const seeded = seedQuarantine();
    const plan = previewResolution(seeded.receiptDigest);
    const intentPath = daemonStateResolutionIntentPath(plan.planId);
    const intentDirectory = path.dirname(intentPath);
    let publicationSyncFailed = false;

    const interrupted = executeDaemonStateResolution(executeInput(plan), resolutionRuntime({
      syncRecordDirectory: (directory) => {
        if (directory === intentDirectory && !publicationSyncFailed) {
          publicationSyncFailed = true;
          throw new Error('simulated intent directory fsync failure after link');
        }
        fsyncDirectory(directory);
      },
    }));

    expect(interrupted).toMatchObject({ ok: false, reason: 'resolution-intent-conflict' });
    expect(fs.existsSync(intentPath)).toBe(true);
    expect(fs.readFileSync(daemonStatePath())).toEqual(seeded.bytes);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(true);

    let retrySyncs = 0;
    const resumed = executeDaemonStateResolution(executeInput(plan), resolutionRuntime({
      syncRecordDirectory: (directory) => {
        if (directory === intentDirectory) retrySyncs += 1;
        fsyncDirectory(directory);
      },
    }));
    expect(resumed).toMatchObject({ ok: true, resumed: true });
    expect(retrySyncs).toBeGreaterThanOrEqual(1);
  });

  it('refuses to reuse an exact existing intent when its parent cannot be re-synchronized', () => {
    const seeded = seedQuarantine();
    const plan = previewResolution(seeded.receiptDigest);
    const intentPath = daemonStateResolutionIntentPath(plan.planId);
    const intentDirectory = path.dirname(intentPath);
    expect(executeDaemonStateResolution(executeInput(plan), resolutionRuntime({
      beforeStatePublish: () => { throw new Error('pause after durable intent'); },
    }))).toMatchObject({ ok: false, reason: 'state-publication-failed' });
    expect(fs.existsSync(intentPath)).toBe(true);

    const refused = executeDaemonStateResolution(executeInput(plan), resolutionRuntime({
      syncRecordDirectory: (directory) => {
        if (directory === intentDirectory) {
          throw new Error('simulated existing intent directory fsync failure');
        }
        fsyncDirectory(directory);
      },
    }));
    expect(refused).toMatchObject({ ok: false, reason: 'resolution-intent-conflict' });
    expect(fs.readFileSync(daemonStatePath())).toEqual(seeded.bytes);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(true);
  });

  it('re-durabilizes an exact receipt before retry without publishing state twice', () => {
    const seeded = seedQuarantine();
    const plan = previewResolution(seeded.receiptDigest);
    const receiptPath = daemonStateResolutionReceiptPath(plan.planId);
    const receiptDirectory = path.dirname(receiptPath);
    let publicationSyncFailed = false;

    const interrupted = executeDaemonStateResolution(executeInput(plan), resolutionRuntime({
      syncRecordDirectory: (directory) => {
        if (directory === receiptDirectory && !publicationSyncFailed) {
          publicationSyncFailed = true;
          throw new Error('simulated receipt directory fsync failure after link');
        }
        fsyncDirectory(directory);
      },
    }));

    expect(interrupted).toMatchObject({ ok: false, reason: 'receipt-write-failed' });
    expect(fs.existsSync(receiptPath)).toBe(true);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(true);
    const stateInodeAfterFirstPublication = fs.lstatSync(daemonStatePath()).ino;
    const receiptInodeAfterFirstPublication = fs.lstatSync(receiptPath).ino;

    let retrySyncs = 0;
    const resumed = executeDaemonStateResolution(executeInput(plan), resolutionRuntime({
      syncRecordDirectory: (directory) => {
        if (directory === receiptDirectory) retrySyncs += 1;
        fsyncDirectory(directory);
      },
    }));
    expect(resumed).toMatchObject({ ok: true, resumed: true });
    expect(retrySyncs).toBeGreaterThanOrEqual(1);
    expect(fs.lstatSync(daemonStatePath()).ino).toBe(stateInodeAfterFirstPublication);
    expect(fs.lstatSync(receiptPath).ino).toBe(receiptInodeAfterFirstPublication);
  });

  it('refuses to reuse an exact existing receipt when its parent cannot be re-synchronized', () => {
    const seeded = seedQuarantine();
    const plan = previewResolution(seeded.receiptDigest);
    const receiptPath = daemonStateResolutionReceiptPath(plan.planId);
    const receiptDirectory = path.dirname(receiptPath);
    expect(executeDaemonStateResolution(executeInput(plan), resolutionRuntime({
      afterReceiptPublish: () => { throw new Error('pause after durable receipt'); },
    }))).toMatchObject({ ok: false, reason: 'receipt-write-failed' });
    const stateInodeBeforeRetry = fs.lstatSync(daemonStatePath()).ino;

    const refused = executeDaemonStateResolution(executeInput(plan), resolutionRuntime({
      syncRecordDirectory: (directory) => {
        if (directory === receiptDirectory) {
          throw new Error('simulated existing receipt directory fsync failure');
        }
        fsyncDirectory(directory);
      },
    }));
    expect(refused).toMatchObject({ ok: false, reason: 'receipt-write-failed' });
    expect(fs.lstatSync(daemonStatePath()).ino).toBe(stateInodeBeforeRetry);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(true);
  });

  it('re-durabilizes a retired marker left visible by a failed link sync before retry', () => {
    const seeded = seedQuarantine();
    const plan = previewResolution(seeded.receiptDigest);
    const retiredMarkerPath = daemonStateResolutionRetiredMarkerPath(plan.planId);
    const retiredMarkerDirectory = path.dirname(retiredMarkerPath);
    let publicationSyncFailed = false;

    const interrupted = executeDaemonStateResolution(executeInput(plan), resolutionRuntime({
      syncRecordDirectory: (directory) => {
        if (directory === retiredMarkerDirectory && !publicationSyncFailed) {
          publicationSyncFailed = true;
          throw new Error('simulated retired marker directory fsync failure after link');
        }
        fsyncDirectory(directory);
      },
    }));

    expect(interrupted).toMatchObject({ ok: false, reason: 'marker-retirement-failed' });
    expect(fs.existsSync(retiredMarkerPath)).toBe(true);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(true);
    const stateInodeAfterFirstPublication = fs.lstatSync(daemonStatePath()).ino;
    const receiptInodeAfterFirstPublication = fs.lstatSync(daemonStateResolutionReceiptPath(plan.planId)).ino;

    let retrySyncs = 0;
    const resumed = executeDaemonStateResolution(executeInput(plan), resolutionRuntime({
      syncRecordDirectory: (directory) => {
        if (directory === retiredMarkerDirectory) retrySyncs += 1;
        fsyncDirectory(directory);
      },
    }));
    expect(resumed).toMatchObject({ ok: true, resumed: true });
    expect(retrySyncs).toBeGreaterThanOrEqual(1);
    expect(fs.lstatSync(daemonStatePath()).ino).toBe(stateInodeAfterFirstPublication);
    expect(fs.lstatSync(daemonStateResolutionReceiptPath(plan.planId)).ino)
      .toBe(receiptInodeAfterFirstPublication);
  });

  it('keeps the active marker when the retired-marker durability barrier fails before unlink', () => {
    const seeded = seedQuarantine();
    const plan = previewResolution(seeded.receiptDigest);
    const retiredMarkerPath = daemonStateResolutionRetiredMarkerPath(plan.planId);
    const retiredMarkerDirectory = path.dirname(retiredMarkerPath);
    let retirementValidated = false;
    let blockedBeforeUnlink = false;

    const interrupted = executeDaemonStateResolution(executeInput(plan), resolutionRuntime({
      beforeMarkerRetirement: () => { retirementValidated = true; },
      syncRecordDirectory: (directory) => {
        if (directory === retiredMarkerDirectory && retirementValidated) {
          blockedBeforeUnlink = true;
          throw new Error('simulated crash-consistency barrier failure');
        }
        fsyncDirectory(directory);
      },
    }));

    expect(interrupted).toMatchObject({ ok: false, reason: 'marker-retirement-failed' });
    expect(blockedBeforeUnlink).toBe(true);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(true);
    expect(fs.existsSync(retiredMarkerPath)).toBe(true);
    const stateInodeBeforeRetry = fs.lstatSync(daemonStatePath()).ino;
    const receiptInodeBeforeRetry = fs.lstatSync(daemonStateResolutionReceiptPath(plan.planId)).ino;

    expect(executeDaemonStateResolution(executeInput(plan), resolutionRuntime()))
      .toMatchObject({ ok: true, resumed: true });
    expect(fs.lstatSync(daemonStatePath()).ino).toBe(stateInodeBeforeRetry);
    expect(fs.lstatSync(daemonStateResolutionReceiptPath(plan.planId)).ino).toBe(receiptInodeBeforeRetry);
  });

  it('fails closed when an existing retired marker cannot be re-synchronized', () => {
    const seeded = seedQuarantine();
    const plan = previewResolution(seeded.receiptDigest);
    const retiredMarkerPath = daemonStateResolutionRetiredMarkerPath(plan.planId);
    const retiredMarkerDirectory = path.dirname(retiredMarkerPath);
    expect(executeDaemonStateResolution(executeInput(plan), resolutionRuntime({
      beforeMarkerRetirement: () => { throw new Error('pause after durable retired marker'); },
    }))).toMatchObject({ ok: false, reason: 'marker-retirement-failed' });
    expect(fs.existsSync(retiredMarkerPath)).toBe(true);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(true);

    const refused = executeDaemonStateResolution(executeInput(plan), resolutionRuntime({
      syncRecordDirectory: (directory) => {
        if (directory === retiredMarkerDirectory) {
          throw new Error('simulated existing retired marker directory fsync failure');
        }
        fsyncDirectory(directory);
      },
    }));
    expect(refused).toMatchObject({ ok: false, reason: 'recovery-marker-conflict' });
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(true);
    expect(fs.existsSync(retiredMarkerPath)).toBe(true);
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
    expect(fs.readFileSync(daemonStatePath())).toEqual(resolvedBytes());
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
    expect(fs.readFileSync(daemonStatePath())).toEqual(resolvedBytes());
    expect(fs.readFileSync(seeded.quarantinePath)).toEqual(seeded.bytes);
  });
});
