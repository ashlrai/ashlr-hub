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
    registrationState: 'present',
    installed: true,
    running: false,
    runtimeState: 'stopped',
    platformSpec: 'launchd',
  }),
}));

import { cmdDaemon } from '../src/cli/daemon.js';
import { daemonStatePath } from '../src/core/daemon/state.js';

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
});
