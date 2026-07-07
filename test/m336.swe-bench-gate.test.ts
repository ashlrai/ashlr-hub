/**
 * m336.swe-bench-gate.test.ts — M336 (completes M143): the SWE-bench
 * regression gate.
 *
 * Runs the REAL fixture harness with a stub engine runner (empty diff → the
 * fixture bug stays unresolved) against crafted baselines:
 *  - baseline had the task RESOLVED → this run breaks it → --gate exits 3;
 *  - baseline equally unresolved → no regression → --gate exits 0;
 *  - no baseline at all → gate seeds and passes (0);
 *  - WITHOUT --gate a regression still exits 0 (back-compat);
 *  - bad --baseline path/shape → 1.
 *
 * homedir() is redirected so ~/.ashlr/eval never touches the real home.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const FAKE_HOME = await vi.hoisted(async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m336-home-'));
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => FAKE_HOME };
});

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdSweBench } from '../src/cli/eval-swe-bench.js';

/** Engine runner that never fixes anything (empty diff). */
const noopRunner = async (): Promise<string> => '';

function baselineFile(resolved: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'ashlr-m336-base-'));
  const file = join(dir, 'baseline.json');
  writeFileSync(
    file,
    JSON.stringify({
      id: 'baseline-1',
      ts: new Date(Date.now() - 86_400_000).toISOString(),
      engine: 'local-coder',
      total: 1,
      resolved: resolved ? 1 : 0,
      resolveRate: resolved ? 1 : 0,
      perTask: [{ taskId: 'fix-add-off-by-one', resolved, durationMs: 10 }],
    }),
  );
  return file;
}

beforeEach(() => {
  // wipe the persisted-report dir between tests so loadLastReport is clean
  rmSync(join(FAKE_HOME, '.ashlr'), { recursive: true, force: true });
});

afterAll(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

describe('M336 --gate', () => {
  it('regression vs a resolved baseline → exit 3', async () => {
    const code = await cmdSweBench(
      ['--fixtures', '-n', '1', '--json', '--gate', '--baseline', baselineFile(true)],
      { engineRunner: noopRunner },
    );
    expect(code).toBe(3);
  }, 30_000);

  it('equally-unresolved baseline → no regression → exit 0', async () => {
    const code = await cmdSweBench(
      ['--fixtures', '-n', '1', '--json', '--gate', '--baseline', baselineFile(false)],
      { engineRunner: noopRunner },
    );
    expect(code).toBe(0);
  }, 30_000);

  it('no baseline at all → gate seeds and passes (0)', async () => {
    const code = await cmdSweBench(['--fixtures', '-n', '1', '--json', '--gate'], {
      engineRunner: noopRunner,
    });
    expect(code).toBe(0);
  }, 30_000);

  it('WITHOUT --gate a regression still exits 0 (back-compat)', async () => {
    const code = await cmdSweBench(
      ['--fixtures', '-n', '1', '--json', '--baseline', baselineFile(true)],
      { engineRunner: noopRunner },
    );
    expect(code).toBe(0);
  }, 30_000);

  it('missing baseline file → exit 1; malformed baseline → exit 1', async () => {
    expect(
      await cmdSweBench(['--fixtures', '-n', '1', '--json', '--gate', '--baseline', '/nope/x.json'], {
        engineRunner: noopRunner,
      }),
    ).toBe(1);

    const dir = mkdtempSync(join(tmpdir(), 'ashlr-m336-bad-'));
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ hello: 'world' }));
    expect(
      await cmdSweBench(['--fixtures', '-n', '1', '--json', '--gate', '--baseline', bad], {
        engineRunner: noopRunner,
      }),
    ).toBe(1);
  }, 30_000);

  it('--baseline without a path → usage error 2', async () => {
    expect(await cmdSweBench(['--fixtures', '--gate', '--baseline'], { engineRunner: noopRunner })).toBe(2);
  });
});
