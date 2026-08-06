import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServiceStatusResult } from '../src/core/daemon/service.js';
import {
  daemonLockPath,
  daemonStatePath,
  daemonStateRecoveryMarkerPath,
  loadDaemonStateStrict,
} from '../src/core/daemon/state.js';
import {
  daemonStateRecoveryPlanPath,
  daemonStateRecoveryReceiptPath,
  executeDaemonStateQuarantine,
  prepareDaemonStateAtomicQuarantineEvidence,
  previewDaemonStateQuarantine,
  type DaemonStateAtomicEvidenceFilesystem,
  type DaemonStateRecoveryRuntime,
  type SourceGeneration,
} from '../src/core/daemon/state-recovery.js';
import { canonicalizeDaemonActivationValue } from '../src/core/daemon/activation-permit.js';
import { readDaemonHealth } from '../src/core/readiness.js';

const originalHome = process.env['HOME'];
const originalUserProfile = process.env['USERPROFILE'];
const PLAN_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-08-06T18:00:00.000Z');
const EVIDENCE_TEST_PLATFORM: NodeJS.Platform = process.platform === 'win32' ? 'linux' : process.platform;

let tmpHome: string;

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

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

function runtime(overrides: Partial<DaemonStateRecoveryRuntime> = {}): DaemonStateRecoveryRuntime {
  return {
    now: () => NOW,
    randomId: () => PLAN_ID,
    serviceStatus: () => inactiveService(),
    prepareAtomicQuarantineEvidence: (input) => prepareDaemonStateAtomicQuarantineEvidence(input, {
      platform: EVIDENCE_TEST_PLATFORM,
      lstat: (filePath) => fs.lstatSync(filePath, { bigint: true }),
      link: fs.linkSync,
      syncDirectory: process.platform === 'win32' ? () => undefined : fsyncTestDirectory,
    }),
    ...overrides,
  };
}

function fsyncTestDirectory(directoryPath: string): void {
  const descriptor = fs.openSync(directoryPath, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function malformedState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    running: false,
    pid: null,
    startedAt: null,
    lastTickAt: null,
    todayDate: '2026-08-06',
    todaySpentUsd: 3.25,
    itemsProcessed: 7,
    ticks: [],
    spendGuardAccounting: {
      accountingId: '22222222-2222-4222-8222-222222222222',
      budgetDay: '2026-08-06',
      budgetExhausted: false,
      legacySpentUsd: 3.25,
    },
    ...overrides,
  };
}

function writeState(value: unknown): Buffer {
  const ashlr = path.join(tmpHome, '.ashlr');
  fs.mkdirSync(ashlr, { recursive: true, mode: 0o700 });
  fs.chmodSync(ashlr, 0o700);
  const bytes = Buffer.from(typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  fs.writeFileSync(daemonStatePath(), bytes, { mode: 0o600 });
  fs.chmodSync(daemonStatePath(), 0o600);
  return bytes;
}

function preview(bytes: Buffer, overrides: Partial<DaemonStateRecoveryRuntime> = {}) {
  return previewDaemonStateQuarantine(sha256(bytes), runtime(overrides));
}

function seedRelocatedRecovery(
  planned: Extract<ReturnType<typeof preview>, { ok: true }>,
): { input: { planId: string; planDigest: string; operatorAuthorization: string }; quarantinePath: string } {
  const input = {
    planId: planned.plan.planId,
    planDigest: planned.plan.planDigest,
    operatorAuthorization: planned.plan.planDigest,
  };
  expect(executeDaemonStateQuarantine(input, runtime({
    afterQuarantine: () => { throw new Error('seed relocated recovery'); },
  }))).toMatchObject({
    ok: false,
    reason: 'quarantine-failed',
  });
  const quarantinePath = path.join(
    tmpHome,
    '.ashlr',
    'quarantine',
    'daemon-state',
    planned.plan.quarantineFileName,
  );
  return { input, quarantinePath };
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-state-quarantine-'));
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

function generationOf(filePath: string): SourceGeneration {
  const stat = fs.lstatSync(filePath, { bigint: true });
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    modifiedNs: stat.mtimeNs.toString(),
    changedNs: stat.ctimeNs.toString(),
    bornNs: stat.birthtimeNs.toString(),
  };
}

function relocationInput(bytes: Buffer, destination: string) {
  return {
    sourcePath: daemonStatePath(),
    quarantinePath: destination,
    expectedSourceSha256: sha256(bytes),
    expectedSourceGeneration: generationOf(daemonStatePath()),
  };
}

describe('production daemon-state atomic quarantine evidence capability', () => {
  it.runIf(process.platform !== 'win32')('publishes only the planned inode to an absent same-device destination', () => {
    const bytes = writeState(malformedState());
    const destination = path.join(tmpHome, '.ashlr', 'quarantine', 'daemon-state', 'evidence.json');
    const prepared = prepareDaemonStateAtomicQuarantineEvidence(relocationInput(bytes, destination));

    expect(prepared).not.toBeNull();
    prepared!.publish();

    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.readFileSync(destination)).toEqual(bytes);
    expect(fs.lstatSync(destination).nlink).toBe(2);
    expect(fs.lstatSync(destination).ino).toBe(fs.lstatSync(daemonStatePath()).ino);
    expect(() => prepared!.publish()).toThrow('already-consumed');
  });

  it.runIf(process.platform !== 'win32')('refuses when the source generation changes after preparation', () => {
    const bytes = writeState(malformedState());
    const destination = path.join(tmpHome, '.ashlr', 'quarantine', 'daemon-state', 'evidence.json');
    const prepared = prepareDaemonStateAtomicQuarantineEvidence(relocationInput(bytes, destination));
    const displaced = `${daemonStatePath()}.planned`;
    fs.renameSync(daemonStatePath(), displaced);
    fs.writeFileSync(daemonStatePath(), 'replacement-must-survive\n', { mode: 0o600 });

    expect(() => prepared!.publish()).toThrow('source-or-destination-changed');
    expect(fs.readFileSync(daemonStatePath(), 'utf8')).toBe('replacement-must-survive\n');
    expect(fs.readFileSync(displaced)).toEqual(bytes);
    expect(fs.existsSync(destination)).toBe(false);
  });

  it('never clobbers a destination raced in at hard-link publication', () => {
    const bytes = writeState(malformedState());
    const destination = path.join(tmpHome, '.ashlr', 'quarantine', 'daemon-state', 'evidence.json');
    let raced = false;
    const filesystem: DaemonStateAtomicEvidenceFilesystem = {
      platform: EVIDENCE_TEST_PLATFORM,
      lstat: (filePath) => fs.lstatSync(filePath, { bigint: true }),
      link: (sourcePath, destinationPath) => {
        raced = true;
        fs.writeFileSync(destinationPath, 'raced-destination-must-survive\n', { mode: 0o600 });
        fs.linkSync(sourcePath, destinationPath);
      },
      syncDirectory: () => undefined,
    };
    const prepared = prepareDaemonStateAtomicQuarantineEvidence(relocationInput(bytes, destination), filesystem);

    expect(() => prepared!.publish()).toThrow();
    expect(raced).toBe(true);
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.readFileSync(destination, 'utf8')).toBe('raced-destination-must-survive\n');
  });

  it('preserves a replacement raced in after evidence linking', () => {
    const bytes = writeState(malformedState());
    const destination = path.join(tmpHome, '.ashlr', 'quarantine', 'daemon-state', 'evidence.json');
    const displaced = `${daemonStatePath()}.planned`;
    const filesystem: DaemonStateAtomicEvidenceFilesystem = {
      platform: EVIDENCE_TEST_PLATFORM,
      lstat: (filePath) => fs.lstatSync(filePath, { bigint: true }),
      link: (sourcePath, destinationPath) => {
        fs.linkSync(sourcePath, destinationPath);
        fs.renameSync(sourcePath, displaced);
        fs.writeFileSync(sourcePath, 'replacement-must-survive\n', { mode: 0o600 });
      },
      syncDirectory: () => undefined,
    };
    const prepared = prepareDaemonStateAtomicQuarantineEvidence(relocationInput(bytes, destination), filesystem);

    expect(() => prepared!.publish()).toThrow();
    expect(fs.readFileSync(daemonStatePath(), 'utf8')).toBe('replacement-must-survive\n');
    expect(fs.readFileSync(destination)).toEqual(bytes);
    expect(fs.readFileSync(displaced)).toEqual(bytes);
  });

  it('refuses a cross-device destination before publishing or unlinking', () => {
    const bytes = writeState(malformedState());
    const destination = path.join(tmpHome, '.ashlr', 'quarantine', 'daemon-state', 'evidence.json');
    const quarantineParent = path.dirname(destination);
    let linkCalled = false;
    const filesystem: DaemonStateAtomicEvidenceFilesystem = {
      platform: EVIDENCE_TEST_PLATFORM,
      lstat: (filePath) => {
        const stat = fs.lstatSync(filePath, { bigint: true });
        if (filePath !== quarantineParent) return stat;
        return new Proxy(stat, {
          get(target, property) {
            if (property === 'dev') return target.dev + 1n;
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
      link: () => { linkCalled = true; },
      syncDirectory: () => undefined,
    };

    expect(prepareDaemonStateAtomicQuarantineEvidence(relocationInput(bytes, destination), filesystem)).toBeNull();
    expect(linkCalled).toBe(false);
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.existsSync(destination)).toBe(false);
  });

  it('makes execute explicitly unavailable on Windows before evidence publication', () => {
    const bytes = writeState(malformedState());
    const destination = path.join(tmpHome, '.ashlr', 'quarantine', 'daemon-state', 'evidence.json');
    let linkCalled = false;
    const filesystem: DaemonStateAtomicEvidenceFilesystem = {
      platform: 'win32',
      lstat: (filePath) => fs.lstatSync(filePath, { bigint: true }),
      link: () => { linkCalled = true; },
      syncDirectory: () => undefined,
    };

    expect(prepareDaemonStateAtomicQuarantineEvidence(relocationInput(bytes, destination), filesystem)).toBeNull();
    expect(linkCalled).toBe(false);
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.existsSync(destination)).toBe(false);
  });
});

describe('daemon state quarantine dry-run plan', () => {
  it('binds an immutable plan to the exact source without changing daemon.json', () => {
    const bytes = writeState(malformedState());
    const result = preview(bytes);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toMatchObject({
      planId: PLAN_ID,
      expectedSourceSha256: sha256(bytes),
      issueCodes: ['spend-accounting-keys-invalid'],
      authority: {
        dryRunFirst: true,
        operatorAuthorizationRequired: true,
        operatorIdentityAuthenticated: false,
        sourceMutationAllowed: false,
        serviceMutationAllowed: false,
        serviceStartAllowed: false,
        serviceRestartAllowed: false,
        serviceInstallAllowed: false,
      },
    });
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.existsSync(result.planPath)).toBe(true);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(false);
  });

  it('refuses source drift and persists no plan', () => {
    const bytes = writeState(malformedState());
    const result = previewDaemonStateQuarantine('a'.repeat(64), runtime());

    expect(result).toMatchObject({ ok: false, reason: 'source-drift' });
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.existsSync(daemonStateRecoveryPlanPath(PLAN_ID))).toBe(false);
  });

  it('refuses a running source and an active resident service', () => {
    const runningBytes = writeState(malformedState({ running: true }));
    expect(preview(runningBytes)).toMatchObject({
      ok: false,
      reason: 'source-running-not-proven-stopped',
    });

    writeState(malformedState());
    const stoppedBytes = fs.readFileSync(daemonStatePath());
    expect(preview(stoppedBytes, {
      serviceStatus: () => inactiveService({ running: true, runtimeState: 'running' }),
    })).toMatchObject({ ok: false, reason: 'service-active' });
    expect(preview(stoppedBytes, {
      serviceStatus: () => inactiveService({ registrationState: 'unknown', runtimeState: 'unknown' }),
    })).toMatchObject({ ok: false, reason: 'service-state-unknown' });
  });

  it('refuses unknown or nonrecoverable diagnostics', () => {
    const bytes = writeState('{not-json');
    expect(preview(bytes)).toMatchObject({
      ok: false,
      reason: 'unknown-or-nonrecoverable-issue-code',
    });
  });

  it.runIf(process.platform !== 'win32')('refuses symlinks and group-writable source storage', () => {
    const ashlr = path.join(tmpHome, '.ashlr');
    fs.mkdirSync(ashlr, { recursive: true, mode: 0o700 });
    const target = path.join(tmpHome, 'source.json');
    const bytes = Buffer.from(`${JSON.stringify(malformedState())}\n`);
    fs.writeFileSync(target, bytes, { mode: 0o600 });
    fs.symlinkSync(target, daemonStatePath());
    expect(preview(bytes)).toMatchObject({ ok: false, reason: 'source-unsafe' });

    fs.unlinkSync(daemonStatePath());
    writeState(malformedState());
    fs.chmodSync(daemonStatePath(), 0o660);
    expect(preview(fs.readFileSync(daemonStatePath()))).toMatchObject({
      ok: false,
      reason: 'source-unsafe',
    });
  });
});

describe('explicitly authorized one-use quarantine', () => {
  it('requires authorization and atomically quarantines exact authorized evidence', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    expect(executeDaemonStateQuarantine({
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: '',
    }, runtime())).toMatchObject({ ok: false, reason: 'authorization-required' });
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);

    const input = {
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    };
    const executed = executeDaemonStateQuarantine(input, runtime());
    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.readFileSync(executed.quarantinePath)).toEqual(bytes);
    expect(fs.lstatSync(daemonStatePath()).ino).toBe(fs.lstatSync(executed.quarantinePath).ino);
    expect(fs.lstatSync(executed.quarantinePath).nlink).toBe(2);
    expect(executed.receipt).toMatchObject({
      planDigest: planned.plan.planDigest,
      sourceSha256: sha256(bytes),
      quarantineSha256: sha256(bytes),
      sourceBytesPreserved: true,
      daemonStateBlockedPendingResolution: true,
      operatorAuthorizationPresented: true,
      operatorIdentityAuthenticated: false,
      serviceMutationPerformed: false,
      serviceStartPerformed: false,
      serviceRestartPerformed: false,
      serviceInstallPerformed: false,
    });
    expect(executed.receipt.previousDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(executed.receipt.receiptDigest).toMatch(/^[a-f0-9]{64}$/u);
    const persistedReceipt = JSON.parse(fs.readFileSync(executed.receiptPath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(persistedReceipt).sort()).toEqual([
      'completedAt', 'daemonStateBlockedPendingResolution', 'kind', 'operation',
      'operatorAuthorizationPresented', 'operatorIdentityAuthenticated', 'planDigest', 'planId',
      'previousDigest', 'quarantineFileName', 'quarantineSha256', 'receiptDigest', 'schemaVersion',
      'serviceInstallPerformed', 'serviceMutationPerformed', 'serviceRestartPerformed',
      'serviceStartPerformed', 'signature', 'signatureAlgorithm', 'signingKeyId', 'sourceBytesPreserved',
      'sourceSha256', 'sourceSizeBytes',
    ].sort());
    expect(loadDaemonStateStrict()).toMatchObject({
      ok: false,
      diagnostic: { issueCodes: ['state-recovery-in-progress'] },
    });
  });

  it('leaves source unchanged and publishes no blocker when atomic evidence is unavailable', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const input = {
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    };
    const unavailable = runtime({ prepareAtomicQuarantineEvidence: () => null });

    expect(executeDaemonStateQuarantine(input, unavailable)).toMatchObject({
      ok: false,
      reason: 'atomic-evidence-unavailable',
    });
    expect(executeDaemonStateQuarantine(input, unavailable)).toMatchObject({
      ok: false,
      reason: 'atomic-evidence-unavailable',
    });
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(false);
    expect(fs.existsSync(daemonStateRecoveryReceiptPath(PLAN_ID))).toBe(false);
    expect(fs.existsSync(path.join(
      tmpHome,
      '.ashlr',
      'quarantine',
      'daemon-state',
      planned.plan.quarantineFileName,
    ))).toBe(false);
  });

  it('refuses Windows execute before publishing a marker or quarantine evidence', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const filesystem: DaemonStateAtomicEvidenceFilesystem = {
      platform: 'win32',
      lstat: (filePath) => fs.lstatSync(filePath, { bigint: true }),
      link: fs.linkSync,
      syncDirectory: () => undefined,
    };

    const result = executeDaemonStateQuarantine({
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    }, runtime({
      prepareAtomicQuarantineEvidence: (input) =>
        prepareDaemonStateAtomicQuarantineEvidence(input, filesystem),
    }));

    expect(result).toMatchObject({ ok: false, reason: 'atomic-evidence-unavailable' });
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(false);
    expect(fs.existsSync(path.join(
      tmpHome,
      '.ashlr',
      'quarantine',
      'daemon-state',
      planned.plan.quarantineFileName,
    ))).toBe(false);
  });

  it('leaves source unchanged and publishes no blocker when relocation preparation crashes', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    expect(executeDaemonStateQuarantine({
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    }, runtime({
      prepareAtomicQuarantineEvidence: () => { throw new Error('evidence preparation failed'); },
    }))).toMatchObject({ ok: false, reason: 'unsafe-recovery-storage' });
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(false);
    expect(fs.existsSync(daemonStateRecoveryReceiptPath(PLAN_ID))).toBe(false);
  });

  it('refuses execution when the source changed after dry-run', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    writeState(malformedState({ todaySpentUsd: 4.25 }));

    expect(executeDaemonStateQuarantine({
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    }, runtime())).toMatchObject({ ok: false, reason: 'source-drift' });
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(false);
  });

  it('revalidates service activity before intent and leaves no blocking marker on refusal', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    let observations = 0;
    const result = executeDaemonStateQuarantine({
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    }, runtime({
      serviceStatus: () => {
        observations += 1;
        return observations === 1
          ? inactiveService()
          : inactiveService({ running: true, runtimeState: 'running' });
      },
    }));

    expect(result).toMatchObject({ ok: false, reason: 'service-active' });
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(false);
    expect(loadDaemonStateStrict()).toMatchObject({
      ok: false,
      diagnostic: { issueCodes: ['spend-accounting-keys-invalid'] },
    });
  });

  it('refuses a replacement live-state generation without moving or deleting it', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    let replacement = Buffer.alloc(0);
    const result = executeDaemonStateQuarantine({
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    }, runtime({
      beforeQuarantine: () => {
        fs.unlinkSync(daemonStatePath());
        replacement = writeState(malformedState({ running: true, pid: process.pid }));
      },
    }));

    expect(result).toMatchObject({ ok: false, reason: 'source-drift' });
    expect(fs.readFileSync(daemonStatePath())).toEqual(replacement);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(false);
    expect(fs.existsSync(path.join(
      tmpHome,
      '.ashlr',
      'quarantine',
      'daemon-state',
      planned.plan.quarantineFileName,
    ))).toBe(false);
  });

  it('rejects an identical-byte replacement inode from an older preview', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    fs.unlinkSync(daemonStatePath());
    fs.writeFileSync(daemonStatePath(), bytes, { mode: 0o600 });
    fs.chmodSync(daemonStatePath(), 0o600);

    const result = executeDaemonStateQuarantine({
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    }, runtime());

    expect(result).toMatchObject({ ok: false, reason: 'source-drift' });
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(false);
  });

  it('preserves a replacement raced in after final source validation', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    let observations = 0;
    const result = executeDaemonStateQuarantine({
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    }, runtime({
      serviceStatus: () => {
        observations += 1;
        if (observations === 2) {
          fs.unlinkSync(daemonStatePath());
          fs.writeFileSync(daemonStatePath(), bytes, { mode: 0o600 });
          fs.chmodSync(daemonStatePath(), 0o600);
        }
        return inactiveService();
      },
    }));

    expect(result).toMatchObject({ ok: false, reason: 'source-drift' });
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(false);
    expect(fs.existsSync(path.join(
      tmpHome,
      '.ashlr',
      'quarantine',
      'daemon-state',
      planned.plan.quarantineFileName,
    ))).toBe(false);
  });

  it('never overwrites a quarantine destination that appears before relocation', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const quarantinePath = path.join(
      tmpHome,
      '.ashlr',
      'quarantine',
      'daemon-state',
      planned.plan.quarantineFileName,
    );
    fs.mkdirSync(path.dirname(quarantinePath), { recursive: true, mode: 0o700 });
    const existingEvidence = Buffer.from('do-not-replace\n');
    fs.writeFileSync(quarantinePath, existingEvidence, { mode: 0o600 });

    const result = executeDaemonStateQuarantine({
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    }, runtime());

    expect(result).toMatchObject({ ok: false, reason: 'quarantine-destination-conflict' });
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.readFileSync(quarantinePath)).toEqual(existingEvidence);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('refuses a quarantine-parent symlink swap before relocation', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const quarantinePath = path.join(
      tmpHome,
      '.ashlr',
      'quarantine',
      'daemon-state',
      planned.plan.quarantineFileName,
    );
    const quarantineParent = path.dirname(quarantinePath);
    const displacedParent = `${quarantineParent}.displaced`;
    const escapedParent = path.join(tmpHome, 'escaped-quarantine');
    let relocateCalled = false;

    const result = executeDaemonStateQuarantine({
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    }, runtime({
      prepareAtomicQuarantineEvidence: ({ sourcePath, quarantinePath: destination }) => ({
        publish: () => {
          relocateCalled = true;
          fs.linkSync(sourcePath, destination);
        },
      }),
      afterIntent: () => {
        fs.mkdirSync(escapedParent, { mode: 0o700 });
        fs.renameSync(quarantineParent, displacedParent);
        fs.symlinkSync(escapedParent, quarantineParent);
      },
    }));

    expect(result).toMatchObject({ ok: false, reason: 'unsafe-recovery-storage' });
    expect(relocateCalled).toBe(false);
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.existsSync(path.join(escapedParent, path.basename(quarantinePath)))).toBe(false);
    expect(fs.existsSync(path.join(displacedParent, path.basename(quarantinePath)))).toBe(false);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(true);
  });

  it('preserves an authenticated intent when a post-marker failure cannot be cleaned atomically', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    const result = executeDaemonStateQuarantine({
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    }, runtime({ afterIntent: () => { throw new Error('simulated post-marker failure'); } }));

    expect(result).toMatchObject({ ok: false, reason: 'quarantine-failed' });
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(true);
  });

  it('reuses a complete private marker temp after a crash before no-clobber publication', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const input = {
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    };

    expect(executeDaemonStateQuarantine(input, runtime({
      beforeMarkerPublish: () => { throw new Error('simulated marker publication crash'); },
    }))).toMatchObject({ ok: false, reason: 'recovery-marker-conflict' });
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(false);
    const privateTemps = fs.readdirSync(path.dirname(daemonStateRecoveryMarkerPath()))
      .filter((name) => name.endsWith('.tmp'));
    expect(privateTemps).toHaveLength(1);

    expect(executeDaemonStateQuarantine(input, runtime())).toMatchObject({ ok: true });
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(true);
  });

  it('never clobbers a marker pathname raced in before publication', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const racedMarker = Buffer.from('raced-marker-must-survive\n');

    expect(executeDaemonStateQuarantine({
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    }, runtime({
      beforeMarkerPublish: () => {
        fs.writeFileSync(daemonStateRecoveryMarkerPath(), racedMarker, { mode: 0o600 });
      },
    }))).toMatchObject({ ok: false, reason: 'recovery-marker-conflict' });
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.readFileSync(daemonStateRecoveryMarkerPath())).toEqual(racedMarker);
    expect(fs.existsSync(daemonStateRecoveryReceiptPath(PLAN_ID))).toBe(false);
  });

  it('retires an invalid abandoned marker temp and retries from authenticated bytes', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const markerDirectory = path.dirname(daemonStateRecoveryMarkerPath());
    fs.mkdirSync(markerDirectory, { recursive: true, mode: 0o700 });
    const abandonedTemp = path.join(markerDirectory, `.active.json.${PLAN_ID}.interrupted.tmp`);
    fs.writeFileSync(abandonedTemp, '{', { mode: 0o600 });

    expect(executeDaemonStateQuarantine({
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    }, runtime())).toMatchObject({ ok: true });
    expect(fs.existsSync(abandonedTemp)).toBe(false);
    expect(fs.readdirSync(path.join(
      tmpHome,
      '.ashlr',
      'control',
      'daemon-state-recovery',
      'abandoned',
      'marker-temp',
      PLAN_ID,
    ))).toHaveLength(1);
  });

  it('retires a safe partial final marker without accepting it as authority', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const markerPath = daemonStateRecoveryMarkerPath();
    fs.mkdirSync(path.dirname(markerPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(markerPath, '{"kind":', { mode: 0o600 });

    const result = executeDaemonStateQuarantine({
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    }, runtime());
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.receipt.previousDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(fs.readFileSync(markerPath, 'utf8')).toContain('daemon-state-quarantine-intent');
  });

  it.runIf(process.platform !== 'win32')('never retires or accepts a hard-linked forged final marker', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const markerPath = daemonStateRecoveryMarkerPath();
    const forged = path.join(tmpHome, 'forged-marker');
    fs.mkdirSync(path.dirname(markerPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(forged, '{"kind":"forged"}\n', { mode: 0o600 });
    fs.linkSync(forged, markerPath);

    expect(executeDaemonStateQuarantine({
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    }, runtime())).toMatchObject({ ok: false, reason: 'recovery-marker-conflict' });
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.readFileSync(markerPath, 'utf8')).toBe('{"kind":"forged"}\n');
    expect(fs.statSync(markerPath).nlink).toBe(2);
    expect(readDaemonHealth()).toMatchObject({
      recoveryBlocked: true,
      recoveryReason: 'daemon state recovery marker storage is unsafe',
    });
  });

  it('never deletes a replacement raced into the recovery-marker pathname', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const replacement = Buffer.from('replacement-marker-must-survive\n');

    const result = executeDaemonStateQuarantine({
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    }, runtime({
      afterIntent: () => {
        fs.unlinkSync(daemonStateRecoveryMarkerPath());
        fs.writeFileSync(daemonStateRecoveryMarkerPath(), replacement, { mode: 0o600 });
        throw new Error('simulated marker replacement race');
      },
    }));

    expect(result).toMatchObject({ ok: false, reason: 'quarantine-failed' });
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.readFileSync(daemonStateRecoveryMarkerPath())).toEqual(replacement);
  });

  it('expires a recovered pre-relocation intent while preserving its blocker', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    let authenticatedMarker = Buffer.alloc(0);
    const input = {
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    };

    expect(executeDaemonStateQuarantine(input, runtime({
      afterIntent: () => {
        authenticatedMarker = fs.readFileSync(daemonStateRecoveryMarkerPath());
        throw new Error('simulated process loss');
      },
    }))).toMatchObject({ ok: false, reason: 'quarantine-failed' });
    fs.writeFileSync(daemonStateRecoveryMarkerPath(), authenticatedMarker, { mode: 0o600 });
    fs.chmodSync(daemonStateRecoveryMarkerPath(), 0o600);

    const expired = executeDaemonStateQuarantine(input, runtime({
      now: () => new Date(NOW.getTime() + 10 * 60 * 1_000),
    }));

    expect(expired).toMatchObject({ ok: false, reason: 'plan-expired' });
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(true);
  });

  it('preserves a recovered pre-relocation intent when the source generation drifted', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    let authenticatedMarker = Buffer.alloc(0);
    const input = {
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    };
    expect(executeDaemonStateQuarantine(input, runtime({
      afterIntent: () => {
        authenticatedMarker = fs.readFileSync(daemonStateRecoveryMarkerPath());
        throw new Error('simulated process loss');
      },
    }))).toMatchObject({ ok: false, reason: 'quarantine-failed' });
    fs.writeFileSync(daemonStateRecoveryMarkerPath(), authenticatedMarker, { mode: 0o600 });
    fs.chmodSync(daemonStateRecoveryMarkerPath(), 0o600);
    fs.unlinkSync(daemonStatePath());
    const replacement = writeState(malformedState());

    expect(executeDaemonStateQuarantine(input, runtime())).toMatchObject({ ok: false, reason: 'source-drift' });
    expect(fs.readFileSync(daemonStatePath())).toEqual(replacement);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(true);
  });

  it('expires an unused plan after its bounded authorization window', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    const result = executeDaemonStateQuarantine({
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    }, runtime({ now: () => new Date(NOW.getTime() + 10 * 60 * 1_000) }));

    expect(result).toMatchObject({ ok: false, reason: 'plan-expired' });
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(false);
  });

  it('cannot publish a marker when authorization expires after private staging', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    let observedNow = NOW;

    const result = executeDaemonStateQuarantine({
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    }, runtime({
      now: () => observedNow,
      beforeMarkerPublish: () => {
        observedNow = new Date(NOW.getTime() + 10 * 60 * 1_000);
      },
    }));

    expect(result).toMatchObject({ ok: false, reason: 'plan-expired' });
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(false);
  });

  it('cannot newly relocate source when authorization expires after marker publication', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    let observedNow = NOW;

    const result = executeDaemonStateQuarantine({
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    }, runtime({
      now: () => observedNow,
      afterIntent: () => {
        observedNow = new Date(NOW.getTime() + 10 * 60 * 1_000);
      },
    }));

    expect(result).toMatchObject({ ok: false, reason: 'plan-expired' });
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(true);
    expect(fs.existsSync(daemonStateRecoveryReceiptPath(PLAN_ID))).toBe(false);
  });


  it('rejects a local clock before plan creation beyond the bounded skew', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    expect(executeDaemonStateQuarantine({
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    }, runtime({ now: () => new Date(NOW.getTime() - 30_001) }))).toMatchObject({
      ok: false,
      reason: 'plan-not-yet-valid',
    });
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(false);
  });

  it('rejects a forged plan even when its public digest and authorization are recomputed', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const persisted = JSON.parse(fs.readFileSync(planned.planPath, 'utf8')) as Record<string, unknown>;
    persisted['expiresAt'] = new Date(NOW.getTime() + 5 * 60 * 1_000).toISOString();
    const { planDigest: _planDigest, signature: _signature, ...digestPayload } = persisted;
    const forgedDigest = sha256(
      `ashlr:daemon-state-quarantine-plan:v1\n${canonicalizeDaemonActivationValue(digestPayload)}`,
    );
    persisted['planDigest'] = forgedDigest;
    fs.writeFileSync(planned.planPath, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
    fs.chmodSync(planned.planPath, 0o600);

    expect(executeDaemonStateQuarantine({
      planId: planned.plan.planId,
      planDigest: forgedDigest,
      operatorAuthorization: forgedDigest,
    }, runtime())).toMatchObject({ ok: false, reason: 'plan-tampered' });
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(false);
  });

  it('reconciles a crash after evidence linking and consumes the plan once', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const { input } = seedRelocatedRecovery(planned);

    expect(executeDaemonStateQuarantine(input, runtime({
      afterQuarantine: () => { throw new Error('simulated interruption'); },
    }))).toMatchObject({ ok: false, reason: 'quarantine-failed' });
    const quarantinePath = path.join(
      tmpHome,
      '.ashlr',
      'quarantine',
      'daemon-state',
      planned.plan.quarantineFileName,
    );
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.readFileSync(quarantinePath)).toEqual(bytes);
    expect(fs.lstatSync(daemonStatePath()).ino).toBe(fs.lstatSync(quarantinePath).ino);
    expect(fs.lstatSync(quarantinePath).nlink).toBe(2);
    expect(fs.existsSync(daemonStateRecoveryReceiptPath(PLAN_ID))).toBe(false);

    const resumed = executeDaemonStateQuarantine(input, runtime());
    expect(resumed).toMatchObject({ ok: true, resumed: true });
    expect(executeDaemonStateQuarantine(input, runtime())).toMatchObject({
      ok: false,
      reason: 'plan-already-consumed',
    });
  });

  it('reconciles the exact crash state after link publication but before directory sync', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const input = {
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    };
    const crashFilesystem: DaemonStateAtomicEvidenceFilesystem = {
      platform: EVIDENCE_TEST_PLATFORM,
      lstat: (filePath) => fs.lstatSync(filePath, { bigint: true }),
      link: fs.linkSync,
      syncDirectory: () => { throw new Error('simulated crash after link publication'); },
    };

    expect(executeDaemonStateQuarantine(input, runtime({
      prepareAtomicQuarantineEvidence: (evidenceInput) =>
        prepareDaemonStateAtomicQuarantineEvidence(evidenceInput, crashFilesystem),
    }))).toMatchObject({ ok: false, reason: 'quarantine-failed' });

    const quarantinePath = path.join(
      tmpHome,
      '.ashlr',
      'quarantine',
      'daemon-state',
      planned.plan.quarantineFileName,
    );
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(true);
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.readFileSync(quarantinePath)).toEqual(bytes);
    expect(fs.lstatSync(daemonStatePath()).ino).toBe(fs.lstatSync(quarantinePath).ino);
    expect(fs.lstatSync(quarantinePath).nlink).toBe(2);

    expect(executeDaemonStateQuarantine(input, runtime())).toMatchObject({ ok: true, resumed: true });
  });

  it('does not complete an already-relocated recovery after authorization expiry', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const { input } = seedRelocatedRecovery(planned);

    expect(executeDaemonStateQuarantine(input, runtime({
      now: () => new Date(NOW.getTime() + 10 * 60 * 1_000),
    }))).toMatchObject({ ok: false, reason: 'plan-expired' });
    expect(fs.existsSync(daemonStateRecoveryReceiptPath(PLAN_ID))).toBe(false);
  });

  it('checks expiry immediately before terminal receipt staging', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const { input } = seedRelocatedRecovery(planned);
    let observedNow = NOW;

    expect(executeDaemonStateQuarantine(input, runtime({
      now: () => observedNow,
      beforeTerminalWrite: () => {
        observedNow = new Date(NOW.getTime() + 10 * 60 * 1_000);
      },
    }))).toMatchObject({ ok: false, reason: 'plan-expired' });
    expect(fs.existsSync(daemonStateRecoveryReceiptPath(PLAN_ID))).toBe(false);
  });

  it('checks expiry immediately before no-clobber receipt publication', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const { input } = seedRelocatedRecovery(planned);
    let observedNow = NOW;

    expect(executeDaemonStateQuarantine(input, runtime({
      now: () => observedNow,
      beforeReceiptPublish: () => {
        observedNow = new Date(NOW.getTime() + 10 * 60 * 1_000);
      },
    }))).toMatchObject({ ok: false, reason: 'plan-expired' });
    expect(fs.existsSync(daemonStateRecoveryReceiptPath(PLAN_ID))).toBe(false);
    expect(fs.readdirSync(path.dirname(daemonStateRecoveryReceiptPath(PLAN_ID)))
      .some((name) => name.endsWith('.tmp'))).toBe(true);
  });

  it('keeps a fully completed receipt replayable after authorization expiry', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const input = {
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    };
    expect(executeDaemonStateQuarantine(input, runtime())).toMatchObject({ ok: true });

    expect(executeDaemonStateQuarantine(input, runtime({
      now: () => new Date(NOW.getTime() + 10 * 60 * 1_000),
    }))).toMatchObject({ ok: false, reason: 'plan-already-consumed' });
  });

  it('does not treat an invalid partial final receipt as plan consumption', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const receiptPath = daemonStateRecoveryReceiptPath(PLAN_ID);
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(receiptPath, '{"kind":', { mode: 0o600 });

    const result = executeDaemonStateQuarantine({
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    }, runtime());
    expect(result).toMatchObject({ ok: false, reason: 'receipt-write-failed' });
    if (!result.ok) expect(result.detail).toContain('not considered consumed');
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('rejects a dangling receipt symlink before source relocation', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const receiptPath = daemonStateRecoveryReceiptPath(PLAN_ID);
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
    fs.symlinkSync(path.join(tmpHome, 'missing-receipt-target'), receiptPath);

    expect(executeDaemonStateQuarantine({
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    }, runtime())).toMatchObject({ ok: false, reason: 'receipt-write-failed' });
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(false);
    expect(fs.lstatSync(receiptPath).isSymbolicLink()).toBe(true);
  });

  it('retires incomplete private receipt temps and publishes a complete receipt atomically', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const receiptPath = daemonStateRecoveryReceiptPath(PLAN_ID);
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
    const interruptedTemp = path.join(
      path.dirname(receiptPath),
      `.${path.basename(receiptPath)}.${PLAN_ID}.interrupted.tmp`,
    );
    fs.writeFileSync(interruptedTemp, '{', { mode: 0o600 });
    const { input } = seedRelocatedRecovery(planned);

    const result = executeDaemonStateQuarantine(input, runtime());
    expect(result).toMatchObject({ ok: true, resumed: true });
    expect(fs.readFileSync(receiptPath, 'utf8')).toContain('daemon-state-quarantine-receipt');
    expect(fs.existsSync(interruptedTemp)).toBe(false);
  });

  it('refuses terminal staging after recovery-lock loss on an already-relocated recovery', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const { input } = seedRelocatedRecovery(planned);
    const recoveryLock = path.join(tmpHome, '.ashlr', 'control', 'daemon-state-recovery', 'locks', 'quarantine.lock');

    const result = executeDaemonStateQuarantine(input, runtime({
      beforeTerminalWrite: () => fs.unlinkSync(recoveryLock),
    }));
    expect(result).toMatchObject({ ok: false, reason: 'recovery-lock-unavailable' });
    expect(fs.existsSync(daemonStateRecoveryReceiptPath(PLAN_ID))).toBe(false);
  });

  it('leaves only a private temp when recovery-lock ownership is lost before marker publication', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const recoveryLock = path.join(tmpHome, '.ashlr', 'control', 'daemon-state-recovery', 'locks', 'quarantine.lock');

    expect(executeDaemonStateQuarantine({
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    }, runtime({
      beforeMarkerPublish: () => fs.unlinkSync(recoveryLock),
    }))).toMatchObject({ ok: false, reason: 'recovery-lock-unavailable' });
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(false);
    expect(fs.readdirSync(path.dirname(daemonStateRecoveryMarkerPath()))
      .some((name) => name.endsWith('.tmp'))).toBe(true);
  });

  it('refuses terminal staging after daemon-lock loss on an already-relocated recovery', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const { input } = seedRelocatedRecovery(planned);

    const result = executeDaemonStateQuarantine(input, runtime({
      beforeTerminalWrite: () => fs.unlinkSync(daemonLockPath()),
    }));
    expect(result).toMatchObject({ ok: false, reason: 'daemon-lock-unavailable' });
    expect(fs.existsSync(daemonStateRecoveryReceiptPath(PLAN_ID))).toBe(false);
  });

  it('leaves a staged receipt temp uncommitted when lock ownership is lost before publication', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const { input } = seedRelocatedRecovery(planned);
    const receiptPath = daemonStateRecoveryReceiptPath(PLAN_ID);
    const recoveryLock = path.join(tmpHome, '.ashlr', 'control', 'daemon-state-recovery', 'locks', 'quarantine.lock');

    const interrupted = executeDaemonStateQuarantine(input, runtime({
      beforeReceiptPublish: () => fs.unlinkSync(recoveryLock),
    }));
    expect(interrupted).toMatchObject({ ok: false, reason: 'recovery-lock-unavailable' });
    expect(fs.existsSync(receiptPath)).toBe(false);
    expect(fs.readdirSync(path.dirname(receiptPath)).some((name) => name.endsWith('.tmp'))).toBe(true);

    expect(executeDaemonStateQuarantine(input, runtime())).toMatchObject({ ok: true, resumed: true });
  });

  it('rejects a forged receipt even when its public digest is recomputed', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const { input } = seedRelocatedRecovery(planned);
    expect(executeDaemonStateQuarantine(input, runtime()).ok).toBe(true);
    const receiptPath = daemonStateRecoveryReceiptPath(PLAN_ID);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    receipt['completedAt'] = '2099-01-01T00:00:00.000Z';
    const { receiptDigest: _receiptDigest, signature: _signature, ...digestPayload } = receipt;
    receipt['receiptDigest'] = sha256(
      `ashlr:daemon-state-quarantine-receipt:v1\n${canonicalizeDaemonActivationValue(digestPayload)}`,
    );
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    fs.chmodSync(receiptPath, 0o600);

    const replay = executeDaemonStateQuarantine(input, runtime());
    expect(replay).toMatchObject({ ok: false, reason: 'receipt-write-failed' });
    if (!replay.ok) expect(replay.detail).toContain('not considered consumed');
  });

  it('does not consume a different plan id from a copied authenticated receipt', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const input = {
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    };
    expect(executeDaemonStateQuarantine(input, runtime())).toMatchObject({ ok: true });
    const differentPlanId = '33333333-3333-4333-8333-333333333333';
    const copiedReceiptPath = daemonStateRecoveryReceiptPath(differentPlanId);
    fs.copyFileSync(daemonStateRecoveryReceiptPath(PLAN_ID), copiedReceiptPath);

    expect(executeDaemonStateQuarantine({
      planId: differentPlanId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    }, runtime())).toMatchObject({ ok: false, reason: 'receipt-write-failed' });
  });

  it('surfaces an active recovery marker as degraded readiness', () => {
    const bytes = writeState(malformedState());
    const planned = preview(bytes);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const input = {
      planId: planned.plan.planId,
      planDigest: planned.plan.planDigest,
      operatorAuthorization: planned.plan.planDigest,
    };
    expect(executeDaemonStateQuarantine(input, runtime({
      afterIntent: () => { throw new Error('leave authenticated intent active'); },
    }))).toMatchObject({
      ok: false,
      reason: 'quarantine-failed',
    });

    expect(readDaemonHealth()).toMatchObject({
      running: false,
      recoveryBlocked: true,
      recoveryReason: 'daemon state recovery marker is pending resolution',
    });
  });

  it('surfaces malformed daemon state as blocked health without a recovery marker', () => {
    writeState('{not-json');

    expect(readDaemonHealth()).toMatchObject({
      running: false,
      recoveryBlocked: true,
      recoveryReason: expect.stringContaining('daemon state is malformed'),
    });
  });

  it.runIf(process.platform !== 'win32')('treats a dangling recovery-marker symlink as degraded readiness', () => {
    const markerPath = daemonStateRecoveryMarkerPath();
    fs.mkdirSync(path.dirname(markerPath), { recursive: true, mode: 0o700 });
    fs.symlinkSync(path.join(tmpHome, 'missing-marker-target'), markerPath);

    expect(readDaemonHealth()).toMatchObject({
      recoveryBlocked: true,
      recoveryReason: 'daemon state recovery marker storage is unsafe',
    });
  });
});
