import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/daemon/service.js', () => ({
  install: vi.fn(),
  uninstall: vi.fn(),
  ensureRunning: vi.fn(),
  serviceStatus: () => ({
    registrationState: 'absent',
    installed: false,
    running: false,
    runtimeState: 'stopped',
    platformSpec: 'launchd',
  }),
}));

import { cmdDaemon } from '../src/cli/daemon.js';
import * as service from '../src/core/daemon/service.js';
import {
  daemonStatePath,
  daemonStateRecoveryMarkerPath,
} from '../src/core/daemon/state.js';

const originalHome = process.env['HOME'];
const originalUserProfile = process.env['USERPROFILE'];
let tmpHome: string;

function malformedState(): Buffer {
  return Buffer.from(`${JSON.stringify({
    running: false,
    pid: null,
    startedAt: null,
    lastTickAt: null,
    todayDate: '2026-08-09',
    todaySpentUsd: 3.25,
    itemsProcessed: 7,
    ticks: [],
    spendGuardAccounting: {
      accountingId: '22222222-2222-4222-8222-222222222222',
      budgetDay: '2026-08-09',
      budgetExhausted: false,
      legacySpentUsd: 3.25,
    },
  }, null, 2)}\n`);
}

async function captureJson(args: string[]): Promise<{ code: number; value: Record<string, unknown> }> {
  const lines: string[] = [];
  const output = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
    lines.push(String(value ?? ''));
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const code = await cmdDaemon(args);
    return { code, value: JSON.parse(lines.join('\n')) as Record<string, unknown> };
  } finally {
    output.mockRestore();
    error.mockRestore();
  }
}

async function captureCode(args: string[]): Promise<number> {
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    return await cmdDaemon(args);
  } finally {
    output.mockRestore();
    error.mockRestore();
  }
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-recover-state-cli-'));
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

describe('daemon recover-state production CLI filesystem wiring', () => {
  it('requires argv-only repeated resolution authorization flags exactly once', async () => {
    const digest = 'a'.repeat(64);
    expect(await captureCode([
      'resolve-state', '--execute', '--plan-id', '33333333-3333-4333-8333-333333333333',
      '--plan-sha256', digest, '--authorize', digest,
    ])).toBe(2);
    expect(await captureCode([
      'resolve-state', '--execute', '--plan-id', '33333333-3333-4333-8333-333333333333',
      '--plan-sha256', digest, '--authorize', digest, '--authorize', digest, '--confirm', digest,
    ])).toBe(2);
    expect(await captureCode([
      'resolve-state', '--dry-run', '--execute', '--quarantine-plan-id',
      '11111111-1111-4111-8111-111111111111', '--quarantine-receipt-sha256', digest,
    ])).toBe(2);
  });

  it.runIf(process.platform !== 'win32')('executes an authorized plan through the real evidence supplier', async () => {
    const bytes = malformedState();
    fs.mkdirSync(path.dirname(daemonStatePath()), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(daemonStatePath()), 0o700);
    fs.writeFileSync(daemonStatePath(), bytes, { mode: 0o600 });
    const expectedSha256 = createHash('sha256').update(bytes).digest('hex');

    const preview = await captureJson([
      'recover-state', '--dry-run', '--expected-sha256', expectedSha256, '--json',
    ]);
    expect(preview.code).toBe(0);
    expect(preview.value['ok']).toBe(true);
    const plan = preview.value['plan'] as { planId: string; planDigest: string };

    const execution = await captureJson([
      'recover-state', '--execute', '--plan-id', plan.planId,
      '--plan-sha256', plan.planDigest, '--authorize', plan.planDigest, '--json',
    ]);

    expect(execution.code).toBe(0);
    expect(execution.value['ok']).toBe(true);
    expect(fs.readFileSync(daemonStatePath())).toEqual(bytes);
    const quarantinePath = execution.value['quarantinePath'] as string;
    expect(fs.readFileSync(quarantinePath)).toEqual(bytes);
    expect(fs.lstatSync(quarantinePath).nlink).toBe(2);
    expect(fs.lstatSync(quarantinePath).ino).toBe(fs.lstatSync(daemonStatePath()).ino);
  });

  it.runIf(process.platform !== 'win32')('resolves an exact quarantine through the distinct production CLI flow', async () => {
    const bytes = malformedState();
    fs.mkdirSync(path.dirname(daemonStatePath()), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(daemonStatePath()), 0o700);
    fs.writeFileSync(daemonStatePath(), bytes, { mode: 0o600 });
    const expectedSha256 = createHash('sha256').update(bytes).digest('hex');
    const quarantinePreview = await captureJson([
      'recover-state', '--dry-run', '--expected-sha256', expectedSha256, '--json',
    ]);
    const quarantinePlan = quarantinePreview.value['plan'] as { planId: string; planDigest: string };
    const quarantine = await captureJson([
      'recover-state', '--execute', '--plan-id', quarantinePlan.planId,
      '--plan-sha256', quarantinePlan.planDigest, '--authorize', quarantinePlan.planDigest, '--json',
    ]);
    expect(quarantine.code).toBe(0);
    const quarantineReceipt = quarantine.value['receipt'] as { receiptDigest: string };
    const quarantinePath = quarantine.value['quarantinePath'] as string;

    const resolutionPreview = await captureJson([
      'resolve-state', '--dry-run', '--quarantine-plan-id', quarantinePlan.planId,
      '--quarantine-receipt-sha256', quarantineReceipt.receiptDigest, '--json',
    ]);
    expect(resolutionPreview.code).toBe(0);
    const resolutionPlan = resolutionPreview.value['plan'] as {
      planId: string;
      planDigest: string;
      freshStateCanonicalBase64: string;
    };
    const resolution = await captureJson([
      'resolve-state', '--execute', '--plan-id', resolutionPlan.planId,
      '--plan-sha256', resolutionPlan.planDigest, '--authorize', resolutionPlan.planDigest,
      '--confirm', resolutionPlan.planDigest, '--json',
    ]);

    expect(resolution.code).toBe(0);
    expect(resolution.value['ok']).toBe(true);
    expect(fs.readFileSync(daemonStatePath())).toEqual(
      Buffer.from(resolutionPlan.freshStateCanonicalBase64, 'base64'),
    );
    expect(fs.readFileSync(quarantinePath)).toEqual(bytes);
    expect(fs.lstatSync(quarantinePath).nlink).toBe(1);
    expect(fs.existsSync(daemonStateRecoveryMarkerPath())).toBe(false);
    expect(fs.existsSync(resolution.value['receiptPath'] as string)).toBe(true);
    expect(fs.existsSync(resolution.value['retiredMarkerPath'] as string)).toBe(true);
    expect(service.install).not.toHaveBeenCalled();
    expect(service.ensureRunning).not.toHaveBeenCalled();
  });
});
