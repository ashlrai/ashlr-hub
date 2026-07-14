import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  daemonActivityDirectory,
  daemonActivityPath,
  readDaemonActivity,
  writeDaemonActivity,
} from '../src/core/daemon/activity.js';

describe('daemon activity — observational private state', () => {
  const instanceId = '123e4567-e89b-42d3-a456-426614174000';
  let home: string;
  let previousAshlrHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ashlr-daemon-activity-'));
    previousAshlrHome = process.env['ASHLR_HOME'];
    process.env['ASHLR_HOME'] = join(home, '.ashlr');
  });

  afterEach(() => {
    if (previousAshlrHome === undefined) delete process.env['ASHLR_HOME'];
    else process.env['ASHLR_HOME'] = previousAshlrHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('does not create storage while reading a missing source', () => {
    const root = process.env['ASHLR_HOME']!;
    expect(readDaemonActivity()).toEqual({
      sourceState: 'missing', freshness: 'unknown', ownerState: 'unknown',
      activity: null, phaseStartedAt: null, ageMs: null,
    });
    expect(existsSync(root)).toBe(false);
  });

  it('writes a bounded owner-only schema and preserves the phase start across heartbeats', () => {
    const daemonStartedAt = '2026-07-13T05:00:00.000Z';
    const activityPath = daemonActivityPath('2026-07-13');
    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt,
      phase: 'tick',
      now: new Date('2026-07-13T05:00:01.000Z'),
    })).toBe(true);
    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt,
      phase: 'tick',
      now: new Date('2026-07-13T05:00:31.000Z'),
    })).toBe(true);

    const read = readDaemonActivity({ nowMs: Date.parse('2026-07-13T05:00:32.000Z') });
    expect(read).toMatchObject({
      sourceState: 'healthy', freshness: 'fresh', ageMs: 1_000,
      ownerState: process.platform === 'win32' ? 'unknown' : 'alive',
      phaseStartedAt: '2026-07-13T05:00:01.000Z',
    });
    expect(read.activity).toMatchObject({
      schemaVersion: 1,
      authority: 'none',
      instanceId,
      pid: process.pid,
      daemonStartedAt,
      phase: 'tick',
      observedAt: '2026-07-13T05:00:31.000Z',
      activeChildren: null,
    });
    if (process.platform !== 'win32') {
      expect(lstatSync(process.env['ASHLR_HOME']!).mode & 0o777).toBe(0o700);
      expect(lstatSync(daemonActivityDirectory()).mode & 0o777).toBe(0o700);
      expect(lstatSync(activityPath).mode & 0o777).toBe(0o600);
    }
    const rows = readFileSync(activityPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[0]).sort()).toEqual([
      'activeChildren', 'authority', 'daemonStartedAt', 'instanceId', 'observedAt', 'phase',
      'pid', 'processStartRef', 'schemaVersion',
    ]);
    expect(readFileSync(activityPath, 'utf8')).not.toMatch(/prompt|objective|command|stdout|stderr|backend|model|repo|diff|env/i);
  });

  it('records only a bounded child count in post-tick phase and resets phase time', () => {
    const daemonStartedAt = '2026-07-13T05:00:00.000Z';
    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt,
      phase: 'tick',
      now: new Date('2026-07-13T05:00:01.000Z'),
    })).toBe(true);
    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt,
      phase: 'post-tick',
      activeChildren: 2,
      now: new Date('2026-07-13T05:00:10.000Z'),
    })).toBe(true);
    expect(readDaemonActivity({ nowMs: Date.parse('2026-07-13T05:00:11.000Z') })).toMatchObject({
      phaseStartedAt: '2026-07-13T05:00:10.000Z',
      activity: { phase: 'post-tick', activeChildren: 2 },
    });
  });

  it('separates freshness from dead, alive, and unknown ownership', () => {
    const root = process.env['ASHLR_HOME']!;
    mkdirSync(root, { mode: 0o700 });
    mkdirSync(daemonActivityDirectory(), { mode: 0o700 });
    const row = {
      schemaVersion: 1,
      observedAt: '2026-07-13T05:00:31.000Z',
      authority: 'none',
      instanceId,
      pid: 2_147_483_647,
      processStartRef: null,
      daemonStartedAt: '2026-07-13T05:00:00.000Z',
      phase: 'tick',
      activeChildren: null,
    };
    writeFileSync(daemonActivityPath(), `${JSON.stringify(row)}\n`, { mode: 0o600 });
    expect(readDaemonActivity({ nowMs: Date.parse('2026-07-13T05:00:32.000Z') })).toMatchObject({
      sourceState: 'healthy', freshness: 'fresh', ownerState: 'dead',
    });

    row.pid = process.pid;
    writeFileSync(daemonActivityPath(), `${JSON.stringify(row)}\n`, { mode: 0o600 });
    expect(readDaemonActivity({ nowMs: Date.parse('2026-07-13T05:03:00.000Z') })).toMatchObject({
      sourceState: 'healthy', freshness: 'stale', ownerState: 'unknown',
    });
  });

  it('classifies future timestamps instead of clamping them fresh', () => {
    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt: '2026-07-13T05:00:00.000Z',
      phase: 'idle',
      now: new Date('2026-07-13T05:01:00.000Z'),
    })).toBe(true);
    expect(readDaemonActivity({ nowMs: Date.parse('2026-07-13T05:00:00.000Z') }).freshness).toBe('future');
  });

  it('degrades malformed, extra-field, and symlink storage without following it', () => {
    const root = process.env['ASHLR_HOME']!;
    mkdirSync(root, { mode: 0o700 });
    mkdirSync(daemonActivityDirectory(), { mode: 0o700 });
    writeFileSync(daemonActivityPath(), '{"schemaVersion":1,"prompt":"raw"}\n', { mode: 0o600 });
    expect(readDaemonActivity().sourceState).toBe('degraded');
    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt: '2026-07-13T05:00:00.000Z', phase: 'idle',
    })).toBe(false);

    rmSync(daemonActivityPath());
    const target = join(home, 'target.json');
    writeFileSync(target, '{}\n', { mode: 0o600 });
    symlinkSync(target, daemonActivityPath());
    expect(readDaemonActivity().sourceState).toBe('degraded');
    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt: '2026-07-13T05:00:00.000Z', phase: 'idle',
    })).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('{}\n');
  });

  it('retains stopping history instead of deleting the journal', () => {
    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt: '2026-07-13T05:00:00.000Z', phase: 'idle',
    })).toBe(true);
    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt: '2026-07-13T05:00:00.000Z', phase: 'stopping',
    })).toBe(true);
    expect(readDaemonActivity().activity).toMatchObject({ authority: 'none', phase: 'stopping' });
    expect(readFileSync(daemonActivityPath(), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('drops unmodeled raw fields and remains outside authority consumers', () => {
    const unsafe = {
      instanceId,
      daemonStartedAt: '2026-07-13T05:00:00.000Z',
      phase: 'idle' as const,
      prompt: 'SECRET_PROMPT',
      repo: '/private/repo',
      command: ['rm', '-rf'],
      stdout: 'raw output',
      env: { TOKEN: 'secret' },
      backend: 'frontier',
      model: 'private-model',
    };
    expect(writeDaemonActivity(unsafe)).toBe(true);
    const raw = readFileSync(daemonActivityPath(), 'utf8');
    expect(raw).not.toMatch(/SECRET_PROMPT|private\/repo|rm|raw output|TOKEN|frontier|private-model/);

    const statusSource = readFileSync(join(process.cwd(), 'src/core/fleet/status.ts'), 'utf8');
    const readinessBlock = statusSource.match(/function shipReadinessSources[\s\S]*?const guardHealth/)?.[0] ?? '';
    expect(readinessBlock).not.toMatch(/daemon\.activity|tickInProgress|childActivity/);
  });

  it('retains only eight daily partitions under the writer lock', () => {
    for (let day = 1; day <= 9; day++) {
      expect(writeDaemonActivity({
        instanceId,
        daemonStartedAt: '2026-07-01T00:00:00.000Z',
        phase: 'idle',
        now: new Date(`2026-07-${String(day).padStart(2, '0')}T00:00:00.000Z`),
      })).toBe(true);
    }
    const partitions = readdirSync(daemonActivityDirectory()).filter((name) => name.endsWith('.jsonl')).sort();
    expect(partitions).toHaveLength(8);
    expect(partitions[0]).toBe('2026-07-02.jsonl');
    expect(partitions.at(-1)).toBe('2026-07-09.jsonl');
  });
});
