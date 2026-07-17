import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fenceBarrier = vi.hoisted(() => ({
  beforeAcquire: undefined as (() => void) | undefined,
}));

vi.mock('../src/core/sandbox/mutation-fence.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/sandbox/mutation-fence.js')>(),
  acquireOutwardMutationFence: () => {
    fenceBarrier.beforeAcquire?.();
    return { path: 'm410-barrier', token: 'owned', dev: 1, ino: 1 };
  },
  ownsOutwardMutationFence: () => true,
  releaseOutwardMutationFence: () => undefined,
}));

import { killSwitchOn, setKill } from '../src/core/sandbox/policy.js';

const policyModuleUrl = new URL('../src/core/sandbox/policy.ts', import.meta.url).href;
const CHILD_SOURCE = String.raw`
  import { killSwitchOn, setKill } from ${JSON.stringify(policyModuleUrl)};

  const result = setKill(false, { waitMs: 500 });
  process.stdout.write(JSON.stringify({ result, killSwitchOn: killSwitchOn() }));
`;

let home: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousAshlrHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousAshlrHome = process.env.ASHLR_HOME;
  home = join(tmpdir(), `ashlr-m410-${process.pid}-${randomUUID()}`);
  mkdirSync(join(home, '.ashlr'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, '.ashlr', 'KILL'), 'kill switch active\n', { mode: 0o600 });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ASHLR_HOME = join(home, '.ashlr');
  fenceBarrier.beforeAcquire = undefined;
});

afterEach(() => {
  fenceBarrier.beforeAcquire = undefined;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

describe('M410 opposing pause/resume policy race', () => {
  it('rearms after a racing resume so a quiesced successful pause leaves kill active', () => {
    let resumeObservation: unknown;
    fenceBarrier.beforeAcquire = () => {
      fenceBarrier.beforeAcquire = undefined;
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', CHILD_SOURCE],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            ASHLR_HOME: join(home, '.ashlr'),
          },
          encoding: 'utf8',
          timeout: 5_000,
        },
      );
      if (child.error) throw child.error;
      if (child.status !== 0) {
        throw new Error(`resume child failed (${child.status}): ${child.stderr}`);
      }
      resumeObservation = JSON.parse(child.stdout) as unknown;
    };

    const pauseResult = setKill(true, { waitMs: 500 });

    expect(resumeObservation).toEqual({
      result: {
        ok: true,
        changed: true,
        quiesced: true,
        reason: 'kill-cleared',
      },
      killSwitchOn: false,
    });
    expect(pauseResult).toEqual({
      ok: true,
      changed: true,
      quiesced: true,
      reason: 'kill-rearmed',
    });
    expect(killSwitchOn()).toBe(true);
  });
});
