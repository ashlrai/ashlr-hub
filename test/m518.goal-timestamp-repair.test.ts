import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Goal } from '../src/core/types.js';
import { cmdGoals } from '../src/cli/goals.js';
import {
  applyGoalTimestampRepair,
  dryRunGoalTimestampRepair,
} from '../src/core/goals/timestamp-repair.js';
import {
  isValidGoalRecord,
  isValidGoalRecordForTimestampRepair,
} from '../src/core/goals/store.js';
import * as durability from '../src/core/util/durability.js';
import {
  PRIVATE_STORAGE_TEST_CONTROL,
  _setPrivateStorageTestControlForTest,
} from '../src/core/util/private-storage.js';

const originalHome = process.env.HOME;
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';
const T2 = '2026-01-03T00:00:00.000Z';
let tmpHome: string;

function goalDirectory(): string {
  return path.join(tmpHome, '.ashlr', 'goals');
}

function rawDigest(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}

function artifactRoot(): string {
  return path.join(goalDirectory(), '.timestamp-repair-artifacts');
}

function artifactId(kind: 'backup' | 'receipt', planId: string, goalId: string): string {
  return `${kind}-${planId}-${rawDigest(Buffer.from(goalId)).slice(0, 32)}`;
}

function artifactPath(kind: 'backup' | 'receipt', planId: string, goalId: string): string {
  const id = artifactId(kind, planId, goalId);
  return path.join(artifactRoot(), 'records', `${id}.json`);
}

function stagePathForArtifact(recordPath: string, temporary = false): string {
  const artifact = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as { artifactId: string };
  const token = rawDigest(Buffer.from(
    `goal-timestamp-repair-stage:${JSON.stringify(artifact)}`,
  )).slice(0, 32);
  return path.join(
    artifactRoot(), 'staging', `.${artifact.artifactId}.${token}.stage${temporary ? '.tmp' : ''}`,
  );
}

function staleGoal(id = 'repair-me'): Goal {
  return {
    id,
    objective: 'Repair historical generation timestamp',
    project: null,
    status: 'active',
    milestones: [{
      id: `${id}-m0`,
      title: 'Persist later domain evidence',
      detail: 'The milestone is newer than the goal generation.',
      order: 0,
      status: 'pending',
      specId: null,
      swarmId: null,
      proposalId: null,
      createdAt: T1,
      updatedAt: T2,
    }],
    createdAt: T0,
    updatedAt: T0,
  };
}

function writeGoal(goal: Goal, trailingNewline = false): Buffer {
  fs.mkdirSync(goalDirectory(), { recursive: true, mode: 0o700 });
  fs.chmodSync(goalDirectory(), 0o700);
  const raw = Buffer.from(JSON.stringify(goal, null, 2) + (trailingNewline ? '\n' : ''), 'utf8');
  fs.writeFileSync(path.join(goalDirectory(), `${goal.id}.json`), raw, { mode: 0o600 });
  return raw;
}

function snapshotTree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!fs.existsSync(root)) return result;
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) visit(absolute);
      else result[relative] = fs.readFileSync(absolute).toString('base64');
    }
  };
  visit(root);
  return result;
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m518-goal-repair-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('M518 deterministic goal timestamp repair', () => {
  it('derives updatedAt only from goal-domain timestamps and dry-run changes no bytes', () => {
    writeGoal(staleGoal());
    const before = snapshotTree(tmpHome);

    const first = dryRunGoalTimestampRepair();
    const second = dryRunGoalTimestampRepair();

    expect(first).toEqual(second);
    expect(first).toMatchObject({ mode: 'dry-run', scannedGoals: 1, repairableGoals: 1 });
    expect(first.entries[0]).toMatchObject({
      goalId: 'repair-me',
      previousUpdatedAt: T0,
      derivedUpdatedAt: T2,
      repairRequired: true,
    });
    expect(first.planId).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshotTree(tmpHome)).toEqual(before);
  });

  it('refuses a mismatched exact plan before creating repair artifacts', () => {
    writeGoal(staleGoal());
    const before = snapshotTree(tmpHome);

    expect(() => applyGoalTimestampRepair('0'.repeat(64))).toThrow(/does not match/i);

    expect(snapshotTree(tmpHome)).toEqual(before);
    expect(fs.existsSync(artifactRoot())).toBe(false);
  });

  it('applies only updatedAt and stores exact immutable private plan, backup, and receipt', () => {
    const original = writeGoal(staleGoal());
    const dryRun = dryRunGoalTimestampRepair();

    const result = applyGoalTimestampRepair(dryRun.planId);

    expect(result).toMatchObject({
      mode: 'apply',
      repairedGoals: 1,
      alreadyAppliedGoals: 0,
      receiptCount: 1,
    });
    const installedRaw = fs.readFileSync(path.join(goalDirectory(), 'repair-me.json'));
    expect(installedRaw.subarray(0, original.indexOf(Buffer.from(JSON.stringify(T0)))))
      .toEqual(original.subarray(0, original.indexOf(Buffer.from(JSON.stringify(T0)))));
    expect(installedRaw.at(-1)).not.toBe(0x0a);
    const installed = JSON.parse(installedRaw.toString('utf8')) as Goal;
    expect(installed).toEqual({ ...staleGoal(), updatedAt: T2 });
    expect(rawDigest(installedRaw)).toBe(dryRun.entries[0]!.afterDigest);

    const backup = artifactPath('backup', dryRun.planId, 'repair-me');
    const receipt = artifactPath('receipt', dryRun.planId, 'repair-me');
    const storedBackup = JSON.parse(fs.readFileSync(backup, 'utf8')) as { rawBase64: string };
    expect(Buffer.from(storedBackup.rawBase64, 'base64')).toEqual(original);
    expect(JSON.parse(fs.readFileSync(receipt, 'utf8'))).toMatchObject({
      planId: dryRun.planId,
      goalId: 'repair-me',
      beforeDigest: rawDigest(original),
      afterDigest: rawDigest(installedRaw),
      derivedUpdatedAt: T2,
    });
    if (process.platform !== 'win32') {
      expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
      expect(fs.statSync(receipt).mode & 0o777).toBe(0o600);
      expect(fs.statSync(artifactRoot()).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(artifactRoot(), 'records')).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(artifactRoot(), 'staging')).mode & 0o777).toBe(0o700);
    }
  });

  it('resumes idempotently from after-state without rewriting the goal or backup', () => {
    writeGoal(staleGoal());
    const plan = dryRunGoalTimestampRepair();
    applyGoalTimestampRepair(plan.planId);
    const goalPath = path.join(goalDirectory(), 'repair-me.json');
    const backupPath = artifactPath('backup', plan.planId, 'repair-me');
    const goalBefore = fs.readFileSync(goalPath);
    const backupBefore = fs.readFileSync(backupPath);

    const resumed = applyGoalTimestampRepair(plan.planId);

    expect(resumed).toMatchObject({ repairedGoals: 0, alreadyAppliedGoals: 1, receiptCount: 1 });
    expect(fs.readFileSync(goalPath)).toEqual(goalBefore);
    expect(fs.readFileSync(backupPath)).toEqual(backupBefore);
  });

  it('refuses the full set when any goal file is malformed and makes no changes', () => {
    writeGoal(staleGoal());
    fs.writeFileSync(path.join(goalDirectory(), 'corrupt.json'), '{broken', { mode: 0o600 });
    const before = snapshotTree(tmpHome);

    expect(() => dryRunGoalTimestampRepair()).toThrow(/not valid JSON/i);

    expect(snapshotTree(tmpHome)).toEqual(before);
  });

  it('binds apply to every source byte, including goals that need no repair', () => {
    writeGoal(staleGoal());
    const stable = staleGoal('stable-goal');
    stable.updatedAt = T2;
    writeGoal(stable);
    const plan = dryRunGoalTimestampRepair();
    stable.objective = 'Changed after planning';
    writeGoal(stable);
    const before = snapshotTree(tmpHome);

    expect(() => applyGoalTimestampRepair(plan.planId)).toThrow(/does not match/i);

    expect(snapshotTree(tmpHome)).toEqual(before);
  });

  it('refuses symlinked goal records during complete-set preflight', () => {
    const source = path.join(tmpHome, 'outside.json');
    fs.mkdirSync(goalDirectory(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(source, JSON.stringify(staleGoal('linked-goal')), { mode: 0o600 });
    fs.symlinkSync(source, path.join(goalDirectory(), 'linked-goal.json'));

    expect(() => dryRunGoalTimestampRepair()).toThrow(/unsafe|ACL custody refused/i);
    expect(fs.readFileSync(source, 'utf8')).toContain('linked-goal');
  });

  it('admits the live-shaped 22-goal set with only three legacy top-level timestamp regressions', () => {
    for (let index = 0; index < 22; index += 1) {
      const goal = staleGoal(`live-goal-${index.toString().padStart(2, '0')}`);
      goal.milestones = [];
      goal.status = 'planning';
      goal.createdAt = T1;
      goal.updatedAt = index < 3 ? T0 : T1;
      writeGoal(goal);
    }
    if (process.platform !== 'win32') {
      fs.chmodSync(path.join(tmpHome, '.ashlr'), 0o755);
      fs.chmodSync(goalDirectory(), 0o755);
      for (const file of fs.readdirSync(goalDirectory())) {
        if (file.endsWith('.json')) fs.chmodSync(path.join(goalDirectory(), file), 0o644);
      }
    }

    const preview = dryRunGoalTimestampRepair();

    expect(preview).toMatchObject({ scannedGoals: 22, repairableGoals: 3 });
    expect(preview.entries.filter((entry) => entry.repairRequired).map((entry) => entry.goalId))
      .toEqual(['live-goal-00', 'live-goal-01', 'live-goal-02']);
    const applied = applyGoalTimestampRepair(preview.planId);
    expect(applied).toMatchObject({ repairedGoals: 3, alreadyAppliedGoals: 0 });
    for (let index = 0; index < 3; index += 1) {
      const installed = JSON.parse(fs.readFileSync(
        path.join(goalDirectory(), `live-goal-0${index}.json`), 'utf8',
      )) as Goal;
      expect(installed.updatedAt).toBe(T1);
      expect(isValidGoalRecord(installed)).toBe(true);
    }
  });

  it('preserves exact live-shaped bytes outside the sole top-level timestamp token', () => {
    const fixtures = [
      {
        file: 'add-real-time-pypi-npm-advisory-cross-referencin-d3c6aa.json',
        updatedAt: '2026-06-30T00:45:54.186Z',
        sha256: '4d382645fe1872a37d96d55f877c305cfc7b2e6af1ff281bfcc8de687d7221c5',
      },
      {
        file: 'build-a-fleet-intelligence-layer-that-records-ev-08d127.json',
        updatedAt: '2026-06-30T00:37:10.099Z',
        sha256: '072a2f4d69d60905c456c4987b34215b9a01703c2453f5ca094d85f21a27ee7e',
      },
      {
        file: 'visionquality-gate-robustness-false-positive-mer-c9c62c.json',
        updatedAt: '2026-06-29T04:27:47.848Z',
        sha256: '277098edfc0f0946f144ef988466583d5f5e72324002c81db585b8252b320c70',
      },
    ] as const;
    const originals = new Map<string, Buffer>();
    fs.mkdirSync(goalDirectory(), { recursive: true, mode: 0o700 });
    for (const fixture of fixtures) {
      const encoded = fs.readFileSync(
        path.join(process.cwd(), 'test', 'fixtures', 'm518', `${fixture.file}.b64`),
        'utf8',
      ).trim();
      const raw = Buffer.from(encoded, 'base64');
      expect(raw.toString('base64')).toBe(encoded);
      expect(raw.at(-1)).not.toBe(0x0a);
      originals.set(fixture.file, raw);
      fs.writeFileSync(path.join(goalDirectory(), fixture.file), raw, { mode: 0o600 });
    }

    const preview = dryRunGoalTimestampRepair();
    expect(preview).toMatchObject({ scannedGoals: 3, repairableGoals: 3 });
    expect(applyGoalTimestampRepair(preview.planId)).toMatchObject({ repairedGoals: 3 });

    const oldToken = Buffer.from(JSON.stringify('1970-01-01T00:00:00.000Z'));
    for (const fixture of fixtures) {
      const before = originals.get(fixture.file)!;
      const after = fs.readFileSync(path.join(goalDirectory(), fixture.file));
      const start = before.lastIndexOf(oldToken);
      const newToken = Buffer.from(JSON.stringify(fixture.updatedAt));
      expect(start).toBeGreaterThanOrEqual(0);
      expect(after.subarray(0, start)).toEqual(before.subarray(0, start));
      expect(after.subarray(start, start + newToken.length)).toEqual(newToken);
      expect(after.subarray(start + newToken.length)).toEqual(before.subarray(start + oldToken.length));
      expect(rawDigest(after)).toBe(fixture.sha256);
      expect(after.at(-1)).not.toBe(0x0a);
    }
  });

  it('lexes escaped top-level keys without confusing nested strings or braces', () => {
    const goal = {
      ...staleGoal('escaped-top-level'),
      extra: { updatedAt: T0, text: 'a brace } and an escaped quote " remain data' },
    };
    let raw = Buffer.from(JSON.stringify(goal), 'utf8');
    const key = Buffer.from('"updatedAt"');
    const extraKey = raw.indexOf(Buffer.from('"extra"'));
    const topKey = raw.lastIndexOf(key, extraKey);
    expect(topKey).toBeGreaterThanOrEqual(0);
    raw = Buffer.concat([
      raw.subarray(0, topKey),
      Buffer.from('"updated\\u0041t"'),
      raw.subarray(topKey + key.length),
    ]);
    fs.mkdirSync(goalDirectory(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(goalDirectory(), 'escaped-top-level.json'), raw, { mode: 0o600 });
    const preview = dryRunGoalTimestampRepair();

    expect(applyGoalTimestampRepair(preview.planId)).toMatchObject({ repairedGoals: 1 });
    const installed = fs.readFileSync(path.join(goalDirectory(), 'escaped-top-level.json'));
    expect(installed.includes(Buffer.from('"updatedAt":"2026-01-01T00:00:00.000Z"'))).toBe(true);
    expect(installed.includes(Buffer.from('"updated\\u0041t":"2026-01-03T00:00:00.000Z"'))).toBe(true);
    expect(installed.includes(Buffer.from('a brace } and an escaped quote'))).toBe(true);
  });

  it('refuses duplicate top-level updatedAt properties even when JSON.parse would accept them', () => {
    const original = JSON.stringify(staleGoal('duplicate-updated-at'));
    const raw = `${original.slice(0, -1)},"updatedAt":${JSON.stringify(T0)}}`;
    fs.mkdirSync(goalDirectory(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(goalDirectory(), 'duplicate-updated-at.json'), raw, { mode: 0o600 });

    expect(() => dryRunGoalTimestampRepair()).toThrow(/exactly one top-level updatedAt.*found 2/i);
    expect(fs.existsSync(artifactRoot())).toBe(false);
  });

  it('relaxes no invariant except top-level updatedAt ordering', () => {
    const legacy = staleGoal('legacy-order-only');
    legacy.createdAt = T1;
    legacy.updatedAt = T0;
    legacy.milestones = [];
    legacy.status = 'planning';
    expect(isValidGoalRecord(legacy)).toBe(false);
    expect(isValidGoalRecordForTimestampRepair(legacy)).toBe(true);

    const malformed = staleGoal('invalid-milestone');
    malformed.updatedAt = '2025-01-01T00:00:00.000Z';
    malformed.milestones[0]!.status = 'not-a-status' as never;
    writeGoal(malformed);

    expect(() => dryRunGoalTimestampRepair()).toThrow(/structurally invalid/i);
    expect(fs.existsSync(artifactRoot())).toBe(false);
  });

  it('keeps every descriptor read bounded and rejects over-cap or multiply-linked sources', () => {
    fs.mkdirSync(goalDirectory(), { recursive: true, mode: 0o700 });
    const oversized = path.join(goalDirectory(), 'oversized.json');
    fs.writeFileSync(oversized, Buffer.alloc((256 * 1024) + 1, 0x20), { mode: 0o600 });
    expect(() => dryRunGoalTimestampRepair()).toThrow(/unsafe or oversized/i);

    fs.unlinkSync(oversized);
    const original = writeGoal(staleGoal('linked-twice'));
    expect(original.length).toBeGreaterThan(0);
    fs.linkSync(
      path.join(goalDirectory(), 'linked-twice.json'),
      path.join(tmpHome, 'second-link.json'),
    );
    expect(() => dryRunGoalTimestampRepair()).toThrow(/unsafe or oversized/i);
  });

  it('rejects a symlink in the source ancestry without following it', () => {
    const redirected = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m518-redirect-'));
    try {
      fs.mkdirSync(path.join(redirected, 'goals'), { recursive: true, mode: 0o700 });
      fs.symlinkSync(redirected, path.join(tmpHome, '.ashlr'), process.platform === 'win32' ? 'junction' : 'dir');

      expect(() => dryRunGoalTimestampRepair()).toThrow(/ancestry is unsafe/i);
    } finally {
      fs.rmSync(redirected, { recursive: true, force: true });
    }
  });

  it('rejects a dangling source-ancestry symlink instead of reporting healthy empty', () => {
    fs.symlinkSync(
      path.join(tmpHome, 'does-not-exist'),
      path.join(tmpHome, '.ashlr'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(() => dryRunGoalTimestampRepair()).toThrow(/ancestry is unsafe/i);
    expect(fs.existsSync(artifactRoot())).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'accepts live-compatible 0755/0644 sources but rejects group-writable ancestry and files',
    () => {
      writeGoal(staleGoal());
      fs.chmodSync(path.join(tmpHome, '.ashlr'), 0o755);
      fs.chmodSync(goalDirectory(), 0o755);
      fs.chmodSync(path.join(goalDirectory(), 'repair-me.json'), 0o644);
      expect(dryRunGoalTimestampRepair()).toMatchObject({ scannedGoals: 1, repairableGoals: 1 });

      fs.chmodSync(path.join(goalDirectory(), 'repair-me.json'), 0o664);
      expect(() => dryRunGoalTimestampRepair()).toThrow(/unsafe or oversized/i);
      fs.chmodSync(path.join(goalDirectory(), 'repair-me.json'), 0o644);
      fs.chmodSync(goalDirectory(), 0o775);
      expect(() => dryRunGoalTimestampRepair()).toThrow(/ancestry is unsafe/i);
    },
  );

  it('fails closed before planning or writing when the platform is unsupported', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    expect(() => dryRunGoalTimestampRepair()).toThrow(/unsupported on platform win32/i);
    expect(() => applyGoalTimestampRepair('0'.repeat(64))).toThrow(/unsupported on platform win32/i);
    expect(fs.existsSync(path.join(tmpHome, '.ashlr'))).toBe(false);
    platform.mockRestore();
  });

  it('rejects a Darwin source ACL that grants an untrusted writer custody', () => {
    writeGoal(staleGoal());
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, {
      runner: (invocation) => ({
        status: 0,
        stdout: [
          ...invocation.args.slice(1).map(() => 'drwx------ 1 owner group 0 Jan 1 00:00 path'),
          ' 0: group:everyone allow write_data',
        ].join('\n') + '\n',
      }),
    });
    try {
      expect(() => dryRunGoalTimestampRepair()).toThrow(/ACL custody refused/i);
      expect(fs.existsSync(artifactRoot())).toBe(false);
    } finally {
      _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, undefined);
      platform.mockRestore();
    }
  });

  it.each([
    ['publish temporary', true, false],
    ['fsync after target link', false, true],
    ['unlink final stage', false, true],
  ] as const)('recovers an immutable receipt after a simulated %s crash', (_label, temporary, linked) => {
    writeGoal(staleGoal());
    const plan = dryRunGoalTimestampRepair();
    applyGoalTimestampRepair(plan.planId);
    const target = artifactPath('receipt', plan.planId, 'repair-me');
    const stage = stagePathForArtifact(target, temporary);
    if (linked) {
      fs.linkSync(target, stage);
    } else {
      const raw = fs.readFileSync(target);
      fs.unlinkSync(target);
      fs.writeFileSync(stage, raw, { mode: 0o600 });
    }

    const resumed = applyGoalTimestampRepair(plan.planId);

    expect(resumed).toMatchObject({ repairedGoals: 0, alreadyAppliedGoals: 1, receiptCount: 1 });
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(stage)).toBe(false);
    if (process.platform !== 'win32') expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it.runIf(process.platform !== 'win32')(
    'preserves and recovers the immutable stage when publication directory fsync fails',
    () => {
      writeGoal(staleGoal());
      const plan = dryRunGoalTimestampRepair();
      const realFsync = durability.fsyncDirectory;
      const fsync = vi.spyOn(durability, 'fsyncDirectory').mockImplementation((target) => {
        if (target === path.join(artifactRoot(), 'records')) {
          throw new Error('simulated repair artifact publish fsync failure');
        }
        return realFsync(target);
      });

      expect(() => applyGoalTimestampRepair(plan.planId)).toThrow(/artifact persistence failed/i);
      expect(fs.readdirSync(path.join(artifactRoot(), 'records'))).toHaveLength(1);
      expect(fs.readdirSync(path.join(artifactRoot(), 'staging'))).toHaveLength(1);

      fsync.mockRestore();
      expect(applyGoalTimestampRepair(plan.planId)).toMatchObject({
        repairedGoals: 1,
        alreadyAppliedGoals: 0,
      });
      expect(fs.readdirSync(path.join(artifactRoot(), 'staging'))).toEqual([]);
    },
  );
});

describe('M518 goals CLI authority boundary', () => {
  it('requires exactly one repair mode and an exact apply plan id', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(await cmdGoals(['repair-timestamps', '--json'])).toBe(2);
    expect(await cmdGoals(['repair-timestamps', '--dry-run', '--apply', '--json'])).toBe(2);
    expect(await cmdGoals(['repair-timestamps', '--apply', '--json'])).toBe(2);
    expect(stderr).toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpHome, '.ashlr'))).toBe(false);
  }, 15_000);

  it('emits a dry-run plan and applies only the exact echoed plan', async () => {
    writeGoal(staleGoal());
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(await cmdGoals(['repair-timestamps', '--dry-run', '--json'])).toBe(0);
    const preview = JSON.parse(stdout) as { planId: string; mode: string };
    expect(preview.mode).toBe('dry-run');
    stdout = '';
    expect(await cmdGoals([
      'repair-timestamps', '--apply', '--plan-id', preview.planId, '--json',
    ])).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ mode: 'apply', repairedGoals: 1 });
  });
});
