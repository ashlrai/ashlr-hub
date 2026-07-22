import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
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
  selectDaemonActivityNativeMode,
  writeDaemonActivity,
} from '../src/core/daemon/activity.js';

describe('daemon activity — observational private state', () => {
  const instanceId = '123e4567-e89b-42d3-a456-426614174000';
  let home: string;
  let previousAshlrHome: string | undefined;

  function activityRow(observedAt: string, phase: 'tick' | 'idle' = 'tick') {
    return {
      schemaVersion: 1,
      observedAt,
      authority: 'none',
      instanceId,
      pid: process.pid,
      processStartRef: null,
      daemonStartedAt: '2026-07-13T05:00:00.000Z',
      phase,
      activeChildren: null,
    };
  }

  function createActivityStorage(): void {
    mkdirSync(process.env['ASHLR_HOME']!, { mode: 0o700 });
    mkdirSync(daemonActivityDirectory(), { mode: 0o700 });
  }

  function stagingPath(
    day: string,
    index: number,
    content: string,
    suffix = '123e4567-e89b-42d3-a456-426614174001',
  ): string {
    const digest = createHash('sha256').update(content).digest('hex');
    return join(
      daemonActivityDirectory(),
      `.activity-stage-${day}-${String(index).padStart(4, '0')}-${suffix}-${digest}.tmp`,
    );
  }

  function intentPath(day: string, index: number, content: string): string {
    const digest = createHash('sha256').update(content).digest('hex');
    return join(
      daemonActivityDirectory(),
      `.activity-intent-${day}-${String(index).padStart(4, '0')}-123e4567-e89b-42d3-a456-426614174001-${digest}.tmp`,
    );
  }

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
      sourceState: 'missing', complete: false, ownerHorizonComplete: false,
      durability: 'crash-durable', freshness: 'unknown', ownerState: 'unknown',
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
    writeFileSync(daemonActivityPath('2026-07-13'), `${JSON.stringify(row)}\n`, { mode: 0o600 });
    expect(readDaemonActivity({ nowMs: Date.parse('2026-07-13T05:00:32.000Z') })).toMatchObject({
      sourceState: 'sampled', complete: false, freshness: 'fresh', ownerState: 'dead',
    });

    row.pid = process.pid;
    writeFileSync(daemonActivityPath('2026-07-13'), `${JSON.stringify(row)}\n`, { mode: 0o600 });
    expect(readDaemonActivity({ nowMs: Date.parse('2026-07-13T05:03:00.000Z') })).toMatchObject({
      sourceState: 'sampled', complete: false, freshness: 'stale', ownerState: 'unknown',
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
    const loopSource = readFileSync(join(process.cwd(), 'src/core/daemon/loop.ts'), 'utf8');
    const staleProof = loopSource.match(/function staleResidentProof[\s\S]*?^}/m)?.[0] ?? '';
    expect(staleProof).not.toMatch(/readDaemonActivity|activity\.complete|ownerState/);
    expect(staleProof).toMatch(/metadata-only heartbeats can never authorize takeover/);
    expect(readFileSync(join(process.cwd(), 'src/core/daemon/activity.ts'), 'utf8')).not.toMatch(/unlinkSync/);
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
    const retired = readdirSync(daemonActivityDirectory()).filter((name) => name.startsWith('.activity-retired-'));
    expect(retired).toHaveLength(0);
    expect(retired.every((name) => lstatSync(join(daemonActivityDirectory(), name)).size === 0)).toBe(true);
    expect(readDaemonActivity({ nowMs: Date.parse('2026-07-09T00:00:01.000Z') })).toMatchObject({
      sourceState: 'sampled',
      complete: false,
      ownerHorizonComplete: false,
      durability: 'crash-durable',
      freshness: 'fresh',
      activity: { observedAt: '2026-07-09T00:00:00.000Z' },
    });
    const retention = readFileSync(join(daemonActivityDirectory(), '.activity-retention-v1.json'), 'utf8');
    expect(retention).not.toMatch(/prompt|objective|command|stdout|stderr|backend|model|repo|diff|env/i);
    expect(JSON.parse(retention)).toMatchObject({
      schemaVersion: 1,
      authority: 'none',
      truncated: true,
      firstRemovedPartition: '2026-07-01.jsonl',
      removedThrough: '2026-07-01T00:00:00.000Z',
    });
    const tampered = JSON.parse(retention);
    tampered.removedThrough = '2026-07-01T00:00:00.001Z';
    writeFileSync(
      join(daemonActivityDirectory(), '.activity-retention-v1.json'),
      `${JSON.stringify(tampered)}\n`,
      { mode: 0o600 },
    );
    expect(readDaemonActivity().sourceState).toBe('degraded');
  });

  it('keeps lifetime history sampled when the retention marker and key are deleted', () => {
    for (let day = 1; day <= 9; day++) {
      expect(writeDaemonActivity({
        instanceId,
        daemonStartedAt: '2026-07-01T00:00:00.000Z',
        phase: 'idle',
        now: new Date(`2026-07-${String(day).padStart(2, '0')}T00:00:00.000Z`),
      })).toBe(true);
    }
    const anchor = join(daemonActivityDirectory(), '.activity-truncated-v1');
    expect(existsSync(anchor)).toBe(true);
    expect(lstatSync(anchor).size).toBe(0);
    rmSync(join(daemonActivityDirectory(), '.activity-retention-v1.json'));
    rmSync(join(daemonActivityDirectory(), '.activity-auth-key'));
    rmSync(anchor);

    expect(readDaemonActivity({ nowMs: Date.parse('2026-07-09T00:00:01.000Z') })).toMatchObject({
      sourceState: 'sampled',
      complete: false,
      ownerHorizonComplete: false,
      activity: { observedAt: '2026-07-09T00:00:00.000Z' },
    });
  });

  it('requires intact authenticated genesis and continuity for first-ever lifetime completeness', () => {
    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt: '2026-07-13T05:00:00.000Z',
      phase: 'idle',
      now: new Date('2026-07-13T05:00:01.000Z'),
    })).toBe(true);
    expect(readDaemonActivity({ nowMs: Date.parse('2026-07-13T05:00:02.000Z') })).toMatchObject({
      sourceState: 'healthy', complete: true,
    });

    rmSync(join(daemonActivityDirectory(), '.activity-genesis-v1.json'));
    expect(readDaemonActivity({ nowMs: Date.parse('2026-07-13T05:00:02.000Z') })).toMatchObject({
      sourceState: 'sampled', complete: false,
    });
    for (const name of readdirSync(daemonActivityDirectory())) {
      if (name.startsWith('.activity-continuity-v1.')) rmSync(join(daemonActivityDirectory(), name));
    }
    expect(readDaemonActivity({ nowMs: Date.parse('2026-07-13T05:00:02.000Z') })).toMatchObject({
      sourceState: 'sampled', complete: false,
    });
  });

  it('uses bounded authenticated append state across more than 4,096 heartbeats', () => {
    const startedAt = '2026-07-13T05:00:00.000Z';
    const baseMs = Date.parse(startedAt);
    for (let index = 0; index < 4_097; index++) {
      expect(writeDaemonActivity({
        instanceId,
        daemonStartedAt: startedAt,
        phase: 'idle',
        now: new Date(baseMs + index + 1),
      }), `heartbeat ${index}`).toBe(true);
    }

    const retired = readdirSync(daemonActivityDirectory())
      .filter((name) => name.startsWith('.activity-retired-'));
    expect(retired).toHaveLength(0);
    expect(readdirSync(daemonActivityDirectory()).filter((name) =>
      name.startsWith('.activity-continuity-v1.'))).toHaveLength(2);
    expect(readFileSync(daemonActivityPath('2026-07-13'), 'utf8').trim().split('\n')).toHaveLength(4_097);
  }, 300_000);

  it('bounds rollover state across 4,097 daily owners and never restores lifetime completeness', () => {
    const baseMs = Date.parse('2010-01-01T00:00:00.000Z');
    for (let index = 0; index < 4_097; index++) {
      const observedAt = new Date(baseMs + index * 86_400_000).toISOString();
      const owner = `123e4567-e89b-42d3-a456-${index.toString(16).padStart(12, '0')}`;
      expect(writeDaemonActivity({
        instanceId: owner,
        daemonStartedAt: observedAt,
        phase: 'idle',
        now: new Date(observedAt),
      }), `rollover ${index}`).toBe(true);
    }

    const names = readdirSync(daemonActivityDirectory());
    expect(names.filter((name) => name.endsWith('.jsonl'))).toHaveLength(8);
    expect(names.filter((name) => name.startsWith('.activity-retired-'))).toHaveLength(0);
    expect(names.filter((name) => name.startsWith('.activity-continuity-v1.'))).toHaveLength(2);
    expect(names.filter((name) => name.startsWith('.activity-')).length).toBeLessThanOrEqual(7);

    rmSync(join(daemonActivityDirectory(), '.activity-retention-v1.json'));
    rmSync(join(daemonActivityDirectory(), '.activity-auth-key'));
    rmSync(join(daemonActivityDirectory(), '.activity-truncated-v1'));
    const nowMs = baseMs + 4_096 * 86_400_000 + 1_000;
    expect(readDaemonActivity({ nowMs })).toMatchObject({
      sourceState: 'sampled', complete: false, ownerHorizonComplete: true,
    });

    rmSync(join(daemonActivityDirectory(), '.activity-genesis-v1.json'));
    for (const name of readdirSync(daemonActivityDirectory())) {
      if (name.startsWith('.activity-continuity-v1.')) rmSync(join(daemonActivityDirectory(), name));
    }
    expect(readDaemonActivity({ nowMs })).toMatchObject({
      sourceState: 'sampled', complete: false, ownerHorizonComplete: true,
    });
  }, 420_000);

  it('recovers a torn ordinary append from its durable pre-length intent', () => {
    createActivityStorage();
    const path = daemonActivityPath('2026-07-13');
    const first = `${JSON.stringify(activityRow('2026-07-13T05:00:01.000Z'))}\n`;
    const torn = `${JSON.stringify(activityRow('2026-07-13T05:00:02.000Z', 'idle'))}\n`;
    writeFileSync(path, first, { mode: 0o600 });
    const digest = createHash('sha256').update(torn).digest('hex');
    const intent = join(
      daemonActivityDirectory(),
      `.activity-append-2026-07-13-0000-123e4567-e89b-42d3-a456-426614174001-${Buffer.byteLength(first)}-${Buffer.byteLength(torn)}-${digest}.tmp`,
    );
    writeFileSync(intent, '', { mode: 0o600 });
    writeFileSync(path, `${first}${torn.slice(0, 47)}`, { mode: 0o600 });

    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt: '2026-07-13T05:00:00.000Z',
      phase: 'idle',
      now: new Date('2026-07-13T05:00:03.000Z'),
    })).toBe(true);

    const rows = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows.map((row) => row.observedAt)).toEqual([
      '2026-07-13T05:00:01.000Z',
      '2026-07-13T05:00:03.000Z',
    ]);
    expect(existsSync(intent)).toBe(false);
  });

  it('replays a torn authenticated append exactly once before accepting later activity', () => {
    const startedAt = '2026-07-13T05:00:00.000Z';
    expect(writeDaemonActivity({
      instanceId, daemonStartedAt: startedAt, phase: 'idle',
      now: new Date('2026-07-13T05:00:01.000Z'),
    })).toBe(true);
    const first = readFileSync(daemonActivityPath('2026-07-13'), 'utf8');
    expect(writeDaemonActivity({
      instanceId, daemonStartedAt: startedAt, phase: 'idle',
      now: new Date('2026-07-13T05:00:02.000Z'),
    })).toBe(true);
    const complete = readFileSync(daemonActivityPath('2026-07-13'), 'utf8');
    const second = complete.slice(first.length);
    writeFileSync(daemonActivityPath('2026-07-13'), `${first}${second.slice(0, 53)}`, { mode: 0o600 });

    expect(writeDaemonActivity({
      instanceId, daemonStartedAt: startedAt, phase: 'idle',
      now: new Date('2026-07-13T05:00:03.000Z'),
    })).toBe(true);
    expect(readFileSync(daemonActivityPath('2026-07-13'), 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line).observedAt)).toEqual([
        '2026-07-13T05:00:01.000Z',
        '2026-07-13T05:00:02.000Z',
        '2026-07-13T05:00:03.000Z',
      ]);
    expect(readDaemonActivity({ nowMs: Date.parse('2026-07-13T05:00:04.000Z') })).toMatchObject({
      sourceState: 'healthy', complete: true,
      activity: { observedAt: '2026-07-13T05:00:03.000Z' },
    });
  });

  it('replays a torn authenticated first publish without inventing or dropping its row', () => {
    const startedAt = '2026-07-13T05:00:00.000Z';
    expect(writeDaemonActivity({
      instanceId, daemonStartedAt: startedAt, phase: 'idle',
      now: new Date('2026-07-13T05:00:01.000Z'),
    })).toBe(true);
    const complete = readFileSync(daemonActivityPath('2026-07-13'), 'utf8');
    writeFileSync(daemonActivityPath('2026-07-13'), complete.slice(0, 61), { mode: 0o600 });

    expect(writeDaemonActivity({
      instanceId, daemonStartedAt: startedAt, phase: 'idle',
      now: new Date('2026-07-13T05:00:02.000Z'),
    })).toBe(true);
    expect(readFileSync(daemonActivityPath('2026-07-13'), 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line).observedAt)).toEqual([
        '2026-07-13T05:00:01.000Z',
        '2026-07-13T05:00:02.000Z',
      ]);
    expect(readDaemonActivity({ nowMs: Date.parse('2026-07-13T05:00:03.000Z') })).toMatchObject({
      sourceState: 'healthy', complete: true,
    });
  });

  it('repairs an interrupted truncation anchor before retiring intact history', () => {
    createActivityStorage();
    for (let day = 1; day <= 9; day++) {
      writeFileSync(
        daemonActivityPath(`2026-07-${String(day).padStart(2, '0')}`),
        `${JSON.stringify({
          ...activityRow(`2026-07-${String(day).padStart(2, '0')}T05:00:00.000Z`, 'idle'),
          daemonStartedAt: '2026-07-01T00:00:00.000Z',
        })}\n`,
        { mode: 0o600 },
      );
    }
    writeFileSync(join(daemonActivityDirectory(), '.activity-retention-v1.json'), '{"schemaVersion":', {
      mode: 0o600,
    });

    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt: '2026-07-01T00:00:00.000Z',
      phase: 'idle',
      now: new Date('2026-07-09T05:00:01.000Z'),
    })).toBe(true);
    expect(readdirSync(daemonActivityDirectory()).filter((name) => name.endsWith('.jsonl'))).toHaveLength(8);
    expect(readDaemonActivity({ nowMs: Date.parse('2026-07-09T05:00:02.000Z') })).toMatchObject({
      sourceState: 'sampled', complete: false, activity: { observedAt: '2026-07-09T05:00:01.000Z' },
    });
  });

  it('selects observational Windows storage and publishes without retention authority', () => {
    expect(selectDaemonActivityNativeMode('linux')).toBe('crash-durable');
    expect(selectDaemonActivityNativeMode('win32')).toBe('observational');
    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt: '2026-07-13T05:00:00.000Z',
      phase: 'idle',
      now: new Date('2026-07-13T05:00:01.000Z'),
      runtime: { platform: 'win32', directoryDurability: 'unproven' },
    })).toBe(true);
    expect(readDaemonActivity({
      nowMs: Date.parse('2026-07-13T05:00:02.000Z'),
      platform: 'win32',
    })).toMatchObject({
      sourceState: 'sampled', complete: false, durability: 'observational', freshness: 'fresh',
    });
    for (let offset = 1; offset < 9; offset++) {
      expect(writeDaemonActivity({
        instanceId,
        daemonStartedAt: '2026-07-13T05:00:00.000Z',
        phase: 'idle',
        now: new Date(Date.parse('2026-07-13T05:00:01.000Z') + offset * 86_400_000),
        runtime: { platform: 'win32', directoryDurability: 'unproven' },
      })).toBe(true);
    }
    expect(readdirSync(daemonActivityDirectory()).filter((name) => name.endsWith('.jsonl'))).toHaveLength(9);
    expect(existsSync(join(daemonActivityDirectory(), '.activity-retention-v1.json'))).toBe(false);
  });

  it('never prunes Windows-selected storage even when directory fsync succeeds', () => {
    for (let day = 1; day <= 9; day++) {
      expect(writeDaemonActivity({
        instanceId,
        daemonStartedAt: '2026-07-01T00:00:00.000Z',
        phase: 'idle',
        now: new Date(`2026-07-${String(day).padStart(2, '0')}T00:00:00.000Z`),
        runtime: { platform: 'win32' },
      })).toBe(true);
    }

    expect(readdirSync(daemonActivityDirectory()).filter((name) => name.endsWith('.jsonl'))).toHaveLength(9);
    expect(existsSync(join(daemonActivityDirectory(), '.activity-retention-v1.json'))).toBe(false);
    expect(existsSync(join(daemonActivityDirectory(), '.activity-truncated-v1'))).toBe(false);
  });

  it('refuses inherited durable create intents in Windows mode without pruning history', () => {
    createActivityStorage();
    for (let day = 1; day <= 9; day++) {
      const observedAt = `2026-07-${String(day).padStart(2, '0')}T00:00:00.000Z`;
      writeFileSync(
        daemonActivityPath(observedAt.slice(0, 10)),
        `${JSON.stringify({
          ...activityRow(observedAt, 'idle'),
          daemonStartedAt: '2026-07-01T00:00:00.000Z',
        })}\n`,
        { mode: 0o600 },
      );
    }
    const intended = `${JSON.stringify({
      ...activityRow('2026-07-10T00:00:00.000Z', 'idle'),
      daemonStartedAt: '2026-07-01T00:00:00.000Z',
    })}\n`;
    writeFileSync(intentPath('2026-07-10', 0, intended), '', { mode: 0o600 });
    writeFileSync(daemonActivityPath('2026-07-10'), intended, { mode: 0o600 });

    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt: '2026-07-01T00:00:00.000Z',
      phase: 'idle',
      now: new Date('2026-07-10T00:00:01.000Z'),
      runtime: { platform: 'win32' },
    })).toBe(false);
    expect(readdirSync(daemonActivityDirectory()).filter((name) => name.endsWith('.jsonl'))).toHaveLength(10);
    expect(existsSync(join(daemonActivityDirectory(), '.activity-retention-v1.json'))).toBe(false);
  });

  it('repairs an observational torn tail even when its directory intent was not durable', () => {
    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt: '2026-07-13T05:00:00.000Z',
      phase: 'idle',
      now: new Date('2026-07-13T05:00:01.000Z'),
      runtime: { platform: 'win32', directoryDurability: 'unproven' },
    })).toBe(true);
    const path = daemonActivityPath('2026-07-13');
    const intact = readFileSync(path, 'utf8');
    const torn = `${JSON.stringify(activityRow('2026-07-13T05:00:02.000Z', 'idle'))}\n`;
    writeFileSync(path, `${intact}${torn.slice(0, 53)}`, { mode: 0o600 });

    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt: '2026-07-13T05:00:00.000Z',
      phase: 'idle',
      now: new Date('2026-07-13T05:00:03.000Z'),
      runtime: { platform: 'win32', directoryDurability: 'unproven' },
    })).toBe(true);
    expect(readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line).observedAt)).toEqual([
      '2026-07-13T05:00:01.000Z',
      '2026-07-13T05:00:03.000Z',
    ]);
  });

  it('quarantines a torn first observational partition and permits the next write', () => {
    createActivityStorage();
    const path = daemonActivityPath('2026-07-13');
    writeFileSync(path, JSON.stringify(activityRow('2026-07-13T05:00:01.000Z')).slice(0, 47), {
      mode: 0o600,
    });

    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt: '2026-07-13T05:00:00.000Z',
      phase: 'idle',
      now: new Date('2026-07-13T05:00:02.000Z'),
      runtime: { platform: 'win32', directoryDurability: 'unproven' },
    })).toBe(true);

    expect(readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line).observedAt))
      .toEqual(['2026-07-13T05:00:02.000Z']);
    const retired = readdirSync(daemonActivityDirectory())
      .filter((name) => name.startsWith('.activity-retired-'));
    expect(retired).toHaveLength(1);
    expect(lstatSync(join(daemonActivityDirectory(), retired[0]!)).size).toBe(0);
  });

  it('quarantines a torn new observational partition without losing prior history', () => {
    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt: '2026-07-13T05:00:00.000Z',
      phase: 'idle',
      now: new Date('2026-07-13T05:00:01.000Z'),
      runtime: { platform: 'win32', directoryDurability: 'unproven' },
    })).toBe(true);
    const trailing = daemonActivityPath('2026-07-14');
    writeFileSync(trailing, JSON.stringify(activityRow('2026-07-14T05:00:01.000Z')).slice(0, 63), {
      mode: 0o600,
    });

    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt: '2026-07-13T05:00:00.000Z',
      phase: 'idle',
      now: new Date('2026-07-14T05:00:02.000Z'),
      runtime: { platform: 'win32', directoryDurability: 'unproven' },
    })).toBe(true);

    expect(readFileSync(daemonActivityPath('2026-07-13'), 'utf8'))
      .toContain('"observedAt":"2026-07-13T05:00:01.000Z"');
    expect(readFileSync(trailing, 'utf8').trim().split('\n').map((line) => JSON.parse(line).observedAt))
      .toEqual(['2026-07-14T05:00:02.000Z']);
  });

  it('rolls a saturated legacy partition into a numbered segment without losing freshness', () => {
    createActivityStorage();
    const legacyPath = daemonActivityPath('2026-07-13');
    const saturated = `${Array.from({ length: 5_000 }, () =>
      JSON.stringify(activityRow('2026-07-13T05:00:01.000Z'))).join('\n')}\n`;
    writeFileSync(legacyPath, saturated, { mode: 0o600 });

    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt: '2026-07-13T05:00:00.000Z',
      phase: 'tick',
      now: new Date('2026-07-13T05:00:31.000Z'),
    })).toBe(true);

    expect(readdirSync(daemonActivityDirectory()).filter((name) => name.endsWith('.jsonl')).sort()).toEqual([
      '2026-07-13.0001.jsonl',
      '2026-07-13.jsonl',
    ]);
    expect(readFileSync(legacyPath, 'utf8').trim().split('\n')).toHaveLength(5_000);
    expect(readFileSync(join(daemonActivityDirectory(), '2026-07-13.0001.jsonl'), 'utf8').trim().split('\n'))
      .toHaveLength(1);
    expect(readDaemonActivity({ nowMs: Date.parse('2026-07-13T05:00:32.000Z') })).toMatchObject({
      sourceState: 'sampled',
      complete: false,
      freshness: 'fresh',
      phaseStartedAt: null,
      activity: { observedAt: '2026-07-13T05:00:31.000Z', phase: 'tick' },
    });
  });

  it('fails closed when an interrupted rollover leaves a partial newest segment', () => {
    createActivityStorage();
    writeFileSync(
      daemonActivityPath('2026-07-13'),
      `${JSON.stringify(activityRow('2026-07-13T05:00:01.000Z'))}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      join(daemonActivityDirectory(), '2026-07-13.0001.jsonl'),
      JSON.stringify(activityRow('2026-07-13T05:00:31.000Z')).slice(0, 80),
      { mode: 0o600 },
    );

    expect(readDaemonActivity({ nowMs: Date.parse('2026-07-13T05:00:32.000Z') })).toEqual({
      sourceState: 'degraded', complete: false, ownerHorizonComplete: false,
      durability: 'crash-durable', freshness: 'unknown', ownerState: 'unknown',
      activity: null, phaseStartedAt: null, ageMs: null,
    });
    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt: '2026-07-13T05:00:00.000Z',
      phase: 'idle',
      now: new Date('2026-07-13T05:00:32.000Z'),
    })).toBe(false);
  });

  it('withholds a valid newest heartbeat when any retained segment is malformed', () => {
    createActivityStorage();
    writeFileSync(daemonActivityPath('2026-07-13'), '{"schemaVersion":1,"prompt":"raw"}\n', { mode: 0o600 });
    writeFileSync(
      join(daemonActivityDirectory(), '2026-07-13.0001.jsonl'),
      `${JSON.stringify(activityRow('2026-07-13T05:00:31.000Z', 'idle'))}\n`,
      { mode: 0o600 },
    );

    expect(readDaemonActivity({ nowMs: Date.parse('2026-07-13T05:00:32.000Z') })).toMatchObject({
      sourceState: 'degraded',
      freshness: 'unknown',
      activity: null,
    });
  });

  it('bounds same-day segment retention while keeping the newest segment readable', () => {
    createActivityStorage();
    for (let index = 0; index < 8; index++) {
      const name = index === 0
        ? '2026-07-13.jsonl'
        : `2026-07-13.${String(index).padStart(4, '0')}.jsonl`;
      const observedAt = `2026-07-13T05:00:${String(index).padStart(2, '0')}.000Z`;
      const rows = index === 7
        ? Array.from({ length: 5_000 }, () => JSON.stringify(activityRow(observedAt)))
        : [JSON.stringify(activityRow(observedAt))];
      writeFileSync(join(daemonActivityDirectory(), name), `${rows.join('\n')}\n`, { mode: 0o600 });
    }

    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt: '2026-07-13T05:00:00.000Z',
      phase: 'idle',
      now: new Date('2026-07-13T05:00:08.000Z'),
    })).toBe(true);

    const partitions = readdirSync(daemonActivityDirectory()).filter((name) => name.endsWith('.jsonl')).sort();
    expect(partitions).toHaveLength(8);
    expect(partitions).not.toContain('2026-07-13.jsonl');
    expect(partitions).toContain('2026-07-13.0008.jsonl');
    expect(readDaemonActivity({ nowMs: Date.parse('2026-07-13T05:00:09.000Z') })).toMatchObject({
      sourceState: 'sampled',
      complete: false,
      freshness: 'fresh',
      activity: { observedAt: '2026-07-13T05:00:08.000Z', phase: 'idle' },
    });
  });

  it('fails pruning closed when the selected partition identity has another link', () => {
    createActivityStorage();
    for (let day = 13; day <= 20; day++) {
      writeFileSync(
        daemonActivityPath(`2026-07-${String(day).padStart(2, '0')}`),
        `${JSON.stringify(activityRow(`2026-07-${String(day).padStart(2, '0')}T05:00:00.000Z`, 'idle'))}\n`,
        { mode: 0o600 },
      );
    }
    const oldest = daemonActivityPath('2026-07-13');
    const external = join(home, 'external-hard-link');
    const oldestBytes = readFileSync(oldest, 'utf8');
    linkSync(oldest, external);

    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt: '2026-07-13T05:00:00.000Z',
      phase: 'idle',
      now: new Date('2026-07-21T05:00:00.000Z'),
    })).toBe(false);
    expect(readFileSync(oldest, 'utf8')).toBe(oldestBytes);
    expect(readFileSync(external, 'utf8')).toBe(oldestBytes);
    expect(lstatSync(oldest).nlink).toBe(2);
  });

  it('cleans an incomplete unpublished stage and retries rollover transactionally', () => {
    createActivityStorage();
    const legacyPath = daemonActivityPath('2026-07-13');
    const saturated = `${Array.from({ length: 5_000 }, () =>
      JSON.stringify(activityRow('2026-07-13T05:00:01.000Z'))).join('\n')}\n`;
    writeFileSync(legacyPath, saturated, { mode: 0o600 });
    const interruptedContent = '{"schemaVersion":1';
    const interruptedStage = stagingPath('2026-07-13', 1, interruptedContent);
    writeFileSync(interruptedStage, interruptedContent, { mode: 0o600 });

    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt: '2026-07-13T05:00:00.000Z',
      phase: 'idle',
      now: new Date('2026-07-13T05:00:31.000Z'),
    })).toBe(true);

    expect(existsSync(interruptedStage)).toBe(false);
    expect(readFileSync(legacyPath, 'utf8').trim().split('\n')).toHaveLength(5_000);
    expect(readFileSync(join(daemonActivityDirectory(), '2026-07-13.0001.jsonl'), 'utf8'))
      .toContain('"observedAt":"2026-07-13T05:00:31.000Z"');
    const internals = readdirSync(daemonActivityDirectory()).filter((name) => name.startsWith('.activity-'));
    expect(internals.some((name) => name.startsWith('.activity-stage-') ||
      name.startsWith('.activity-intent-') || name.startsWith('.activity-delete-'))).toBe(false);
    expect(internals.filter((name) => name.startsWith('.activity-retired-'))
      .every((name) => lstatSync(join(daemonActivityDirectory(), name)).size === 0)).toBe(true);
  });

  it('finishes a valid intent transaction before pruning and preserves the new row', () => {
    createActivityStorage();
    for (let index = 0; index < 8; index++) {
      const name = index === 0
        ? '2026-07-13.jsonl'
        : `2026-07-13.${String(index).padStart(4, '0')}.jsonl`;
      writeFileSync(
        join(daemonActivityDirectory(), name),
        `${JSON.stringify(activityRow(`2026-07-13T05:00:0${index}.000Z`, 'idle'))}\n`,
        { mode: 0o600 },
      );
    }
    const stagedRow = `${JSON.stringify(activityRow('2026-07-13T05:00:08.000Z', 'idle'))}\n`;
    const intent = intentPath('2026-07-13', 8, stagedRow);
    const target = join(daemonActivityDirectory(), '2026-07-13.0008.jsonl');
    writeFileSync(intent, '', { mode: 0o600 });
    writeFileSync(target, stagedRow, { mode: 0o600 });

    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt: '2026-07-13T05:00:00.000Z',
      phase: 'idle',
      now: new Date('2026-07-13T05:00:09.000Z'),
    })).toBe(true);

    const partitions = readdirSync(daemonActivityDirectory()).filter((name) => name.endsWith('.jsonl')).sort();
    expect(partitions).toHaveLength(8);
    expect(partitions).not.toContain('2026-07-13.jsonl');
    expect(existsSync(intent)).toBe(false);
    expect(lstatSync(target).nlink).toBe(1);
    expect(readFileSync(target, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('migrates a valid hard-linked legacy transaction without unlinking either pathname', () => {
    createActivityStorage();
    for (let index = 0; index < 8; index++) {
      const name = index === 0
        ? '2026-07-13.jsonl'
        : `2026-07-13.${String(index).padStart(4, '0')}.jsonl`;
      writeFileSync(
        join(daemonActivityDirectory(), name),
        `${JSON.stringify(activityRow(`2026-07-13T05:00:0${index}.000Z`, 'idle'))}\n`,
        { mode: 0o600 },
      );
    }
    const stagedRow = `${JSON.stringify(activityRow('2026-07-13T05:00:08.000Z', 'idle'))}\n`;
    const stage = stagingPath('2026-07-13', 8, stagedRow);
    const target = join(daemonActivityDirectory(), '2026-07-13.0008.jsonl');
    writeFileSync(stage, stagedRow, { mode: 0o600 });
    linkSync(stage, target);

    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt: '2026-07-13T05:00:00.000Z',
      phase: 'idle',
      now: new Date('2026-07-13T05:00:09.000Z'),
    })).toBe(true);

    expect(lstatSync(stage).size).toBe(0);
    expect(lstatSync(stage).nlink).toBe(2);
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(daemonActivityDirectory(), '2026-07-13.0007.jsonl'), 'utf8'))
      .toContain('"observedAt":"2026-07-13T05:00:09.000Z"');
    expect(readdirSync(daemonActivityDirectory()).filter((name) => name.endsWith('.jsonl'))).toHaveLength(8);
  });

  it('never accepts or removes a partial hard-linked legacy segment', () => {
    createActivityStorage();
    writeFileSync(
      daemonActivityPath('2026-07-13'),
      `${JSON.stringify(activityRow('2026-07-13T05:00:01.000Z'))}\n`,
      { mode: 0o600 },
    );
    const partialRow = '{"schemaVersion":1';
    const stage = stagingPath('2026-07-13', 1, partialRow);
    const target = join(daemonActivityDirectory(), '2026-07-13.0001.jsonl');
    writeFileSync(stage, partialRow, { mode: 0o600 });
    linkSync(stage, target);

    expect(readDaemonActivity().sourceState).toBe('degraded');
    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt: '2026-07-13T05:00:00.000Z',
      phase: 'idle',
      now: new Date('2026-07-13T05:00:31.000Z'),
    })).toBe(false);
    expect(existsSync(stage)).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(lstatSync(target).nlink).toBe(2);
  });

  it('retires a torn intent target and retries without preserving partial bytes', () => {
    createActivityStorage();
    const prior = `${JSON.stringify(activityRow('2026-07-13T05:00:01.000Z'))}\n`;
    writeFileSync(daemonActivityPath('2026-07-13'), prior, { mode: 0o600 });
    const intended = `${JSON.stringify(activityRow('2026-07-14T05:00:01.000Z', 'idle'))}\n`;
    const intent = intentPath('2026-07-14', 0, intended);
    const target = daemonActivityPath('2026-07-14');
    writeFileSync(intent, '', { mode: 0o600 });
    writeFileSync(target, intended.slice(0, 80), { mode: 0o600 });

    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt: '2026-07-13T05:00:00.000Z',
      phase: 'idle',
      now: new Date('2026-07-14T05:00:02.000Z'),
    })).toBe(true);

    expect(readFileSync(target, 'utf8')).toContain('"observedAt":"2026-07-14T05:00:02.000Z"');
    const retired = readdirSync(daemonActivityDirectory())
      .filter((name) => name.startsWith('.activity-retired-'));
    expect(retired.length).toBeGreaterThanOrEqual(2);
    expect(retired.every((name) => lstatSync(join(daemonActivityDirectory(), name)).size === 0)).toBe(true);
  });

  it('erases but never unlinks a verified legacy deletion tombstone', () => {
    createActivityStorage();
    const tombstone = join(
      daemonActivityDirectory(),
      '.activity-delete-123e4567-e89b-42d3-a456-426614174002.tmp',
    );
    writeFileSync(tombstone, `${JSON.stringify(activityRow('2026-07-13T05:00:00.000Z'))}\n`, { mode: 0o600 });

    expect(writeDaemonActivity({
      instanceId,
      daemonStartedAt: '2026-07-13T05:00:00.000Z',
      phase: 'idle',
      now: new Date('2026-07-13T05:00:01.000Z'),
    })).toBe(true);
    expect(existsSync(tombstone)).toBe(true);
    expect(lstatSync(tombstone).size).toBe(0);
    expect(readDaemonActivity({ nowMs: Date.parse('2026-07-13T05:00:02.000Z') })).toMatchObject({
      sourceState: 'healthy',
      activity: { observedAt: '2026-07-13T05:00:01.000Z' },
    });
  });

  it('rejects internal segment gaps while allowing a pruned leading suffix', () => {
    createActivityStorage();
    writeFileSync(
      daemonActivityPath('2026-07-13'),
      `${JSON.stringify(activityRow('2026-07-13T05:00:01.000Z'))}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      join(daemonActivityDirectory(), '2026-07-13.0002.jsonl'),
      `${JSON.stringify(activityRow('2026-07-13T05:00:02.000Z'))}\n`,
      { mode: 0o600 },
    );
    expect(readDaemonActivity().sourceState).toBe('degraded');

    rmSync(daemonActivityPath('2026-07-13'));
    expect(readDaemonActivity({ nowMs: Date.parse('2026-07-13T05:00:03.000Z') })).toMatchObject({
      sourceState: 'sampled',
      complete: false,
      activity: { observedAt: '2026-07-13T05:00:02.000Z' },
    });
  });

  it('binds every validated row to its partition day', () => {
    createActivityStorage();
    writeFileSync(
      daemonActivityPath('2026-07-13'),
      `${JSON.stringify(activityRow('2026-08-01T05:00:01.000Z'))}\n`,
      { mode: 0o600 },
    );

    expect(readDaemonActivity({ nowMs: Date.parse('2026-08-01T05:00:02.000Z') })).toEqual({
      sourceState: 'degraded', complete: false, ownerHorizonComplete: false,
      durability: 'crash-durable', freshness: 'unknown', ownerState: 'unknown',
      activity: null, phaseStartedAt: null, ageMs: null,
    });
  });

  it('marks bounded reverse parsing sampled and degrades corruption inside the relevant tail', () => {
    createActivityStorage();
    const validRows = Array.from({ length: 599 }, (_, index) => JSON.stringify(activityRow(
      `2026-07-13T05:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
      'idle',
    )));
    writeFileSync(
      daemonActivityPath('2026-07-13'),
      `${['{"truncated":true}', ...validRows].join('\n')}\n`,
      { mode: 0o600 },
    );

    expect(readDaemonActivity({ nowMs: Date.parse('2026-07-13T05:10:00.000Z') })).toMatchObject({
      sourceState: 'sampled',
      complete: false,
      phaseStartedAt: null,
      activity: { observedAt: '2026-07-13T05:09:58.000Z' },
    });

    validRows[validRows.length - 10] = '{"truncated":true}';
    writeFileSync(
      daemonActivityPath('2026-07-13'),
      `${['{"truncated":true}', ...validRows].join('\n')}\n`,
      { mode: 0o600 },
    );
    expect(readDaemonActivity().sourceState).toBe('degraded');
  });
});
