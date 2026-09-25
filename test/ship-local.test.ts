/**
 * scripts/ship-local.mjs — planning logic only.
 *
 * Every machine fact comes from an injected io, so nothing here reads or writes the real
 * ~/.local, /Applications or launchd, and no command is executed: the fake io records calls.
 */
import { describe, expect, it } from 'vitest';
import {
  APP_PATH,
  KEEP_BACKUPS,
  NATIVE_BUILD,
  Refusal,
  backupName,
  gatherContext,
  parseArgs,
  planShip,
  rotateBackups,
  runSteps,
  stamp,
  tarballName,
} from '../scripts/ship-local.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const NOW = new Date(2026, 8, 25, 3, 15, 2);
const HOME = '/isolated-home';
const REPO = '/repo';

type Entry = { name: string; mtimeMs: number };
type Step = { id: string; title: string; argv?: string[]; wait?: { kind: string }; versions?: unknown };

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'darwin',
    home: HOME,
    tmp: '/os-tmp',
    uid: 501,
    now: NOW,
    repoRoot: REPO,
    sha: SHA,
    version: '3.11.1',
    packageName: '@ashlr/hub',
    dirty: false,
    allowDirty: false,
    dryRun: false,
    native: false,
    appExists: true,
    listing: {
      'Contents/MacOS': [{ name: 'ashlr', mtimeMs: 10 }, { name: 'ashlr-desktop', mtimeMs: 10 }],
      'Contents/Resources': [{ name: 'public', mtimeMs: 10 }],
    } as Record<string, Entry[]>,
    loadedAgents: ['ai.ashlr.anthropic-proxy', 'ai.ashlr.serve'],
    nativeBuildMtime: null as number | null,
    installedNativeMtime: 10 as number | null,
    ...overrides,
  };
}

const ids = (steps: Step[]) => steps.map((s) => s.id);
const step = (steps: Step[], id: string) => steps.find((s) => s.id === id);

describe('parseArgs', () => {
  it('reads the three flags and rejects anything else', () => {
    expect(parseArgs(['--dry-run', '--native', '--allow-dirty']))
      .toEqual({ dryRun: true, native: true, allowDirty: true, help: false });
    expect(() => parseArgs(['--force'])).toThrow(Refusal);
  });
});

describe('refusals', () => {
  it('refuses on anything but macOS, with a pointer to the manual install', () => {
    expect(() => planShip(ctx({ platform: 'linux' }))).toThrow(/only runs on macOS \(this is linux\)/);
    expect(() => planShip(ctx({ platform: 'linux' }))).toThrow(/RELEASING-LOCALLY/);
  });

  it('refuses a dirty tree unless --allow-dirty', () => {
    expect(() => planShip(ctx({ dirty: true }))).toThrow(Refusal);
    expect(() => planShip(ctx({ dirty: true }))).toThrow(/--allow-dirty/);
  });

  it('with --allow-dirty installs under a -dirty- release id, never the bare sha', () => {
    const steps = planShip(ctx({ dirty: true, allowDirty: true })) as Step[];
    const dest = `${HOME}/.local/share/ashlr/releases/${SHA}-dirty-${stamp(NOW)}`;
    expect(step(steps, 'release-dir')?.argv).toEqual(['mkdir', '-p', dest]);
    expect(step(steps, 'current')?.argv).toEqual(['ln', '-sfn', dest, `${HOME}/.local/share/ashlr/current`]);
  });
});

describe('planShip step list', () => {
  it('builds, packs, installs and repoints current in order', () => {
    const steps = planShip(ctx()) as Step[];
    expect(ids(steps).slice(0, 8)).toEqual([
      'clean-dist', 'build', 'pack-dir', 'pack', 'release-dir', 'extract', 'current', 'build-binary',
    ]);
    expect(step(steps, 'clean-dist')?.argv).toEqual(['rm', '-rf', `${REPO}/dist`]);
    expect(step(steps, 'pack')?.argv).toEqual(['npm', 'pack', '--ignore-scripts', '--pack-destination', '/os-tmp/ashlr-ship-01234567']);
    expect(step(steps, 'extract')?.argv).toEqual([
      'tar', '-xzf', '/os-tmp/ashlr-ship-01234567/ashlr-hub-3.11.1.tgz',
      '-C', `${HOME}/.local/share/ashlr/releases/${SHA}`, '--strip-components=1',
    ]);
  });

  it('never writes outside the repo, OS temp, the isolated home, or the app bundle', () => {
    const steps = planShip(ctx({ native: true, nativeBuildMtime: 99 })) as Step[];
    const allowed = [REPO, '/os-tmp', HOME, APP_PATH];
    for (const s of steps) {
      for (const arg of s.argv ?? []) {
        if (arg.startsWith('/')) expect(allowed.some((root) => arg.startsWith(root)), `${s.id}: ${arg}`).toBe(true);
      }
    }
  });

  it('replaces the app sidecar and public dir, backing each up as *.prev-<short sha>', () => {
    const steps = planShip(ctx()) as Step[];
    expect(ids(steps)).toEqual(expect.arrayContaining([
      'app-quit', 'app-wait-quit', 'backup-ashlr', 'install-ashlr', 'backup-public', 'install-public',
      'codesign', 'codesign-verify', 'app-launch',
    ]));
    expect(step(steps, 'backup-ashlr')?.argv).toEqual([
      'mv', `${APP_PATH}/Contents/MacOS/ashlr`, `${APP_PATH}/Contents/MacOS/ashlr.prev-01234567`,
    ]);
    expect(step(steps, 'backup-public')?.argv).toEqual([
      'mv', `${APP_PATH}/Contents/Resources/public`, `${APP_PATH}/Contents/Resources/public.prev-01234567`,
    ]);
    expect(step(steps, 'install-ashlr')?.argv).toEqual(['cp', '-R', `${REPO}/dist-bin/ashlr`, `${APP_PATH}/Contents/MacOS/ashlr`]);
    expect(step(steps, 'codesign')?.argv).toEqual(['codesign', '--force', '--deep', '--sign', '-', APP_PATH]);
    // Quit before touching the bundle; sign after the last copy; relaunch last.
    const order = ids(steps);
    expect(order.indexOf('app-wait-quit')).toBeLessThan(order.indexOf('backup-ashlr'));
    expect(order.indexOf('install-public')).toBeLessThan(order.indexOf('codesign'));
    expect(order.indexOf('codesign-verify')).toBeLessThan(order.indexOf('app-launch'));
  });

  it('never removes anything but the repo dist/', () => {
    const steps = planShip(ctx({ native: true, nativeBuildMtime: 99 })) as Step[];
    const removals = steps.filter((s) => s.argv?.[0] === 'rm');
    expect(removals.map((s) => s.argv)).toEqual([['rm', '-rf', `${REPO}/dist`]]);
  });

  it('skips the bundle when the app is not installed', () => {
    const steps = planShip(ctx({ appExists: false, listing: {} })) as Step[];
    expect(ids(steps)).toContain('app-absent');
    expect(ids(steps).some((id) => id.startsWith('backup-') || id === 'codesign')).toBe(false);
  });

  it('installs ashlr-desktop only with --native and only when the build is newer', () => {
    expect(ids(planShip(ctx({ nativeBuildMtime: 99 })) as Step[])).not.toContain('install-ashlr-desktop');
    const newer = planShip(ctx({ native: true, nativeBuildMtime: 99 })) as Step[];
    expect(step(newer, 'install-ashlr-desktop')?.argv).toEqual([
      'cp', '-R', `${REPO}/${NATIVE_BUILD}`, `${APP_PATH}/Contents/MacOS/ashlr-desktop`,
    ]);
    expect(step(newer, 'backup-ashlr-desktop')).toBeDefined();
    const older = planShip(ctx({ native: true, nativeBuildMtime: 5 })) as Step[];
    expect(ids(older)).not.toContain('install-ashlr-desktop');
    expect(step(older, 'native-skip')?.title).toMatch(/not newer/);
    const missing = planShip(ctx({ native: true, nativeBuildMtime: null })) as Step[];
    expect(step(missing, 'native-skip')?.title).toMatch(/missing/);
  });

  it('kickstarts only the launch agents that are loaded', () => {
    const steps = planShip(ctx({ loadedAgents: ['ai.ashlr.serve'] })) as Step[];
    expect(step(steps, 'kickstart-ai.ashlr.serve')?.argv).toEqual(['launchctl', 'kickstart', '-k', 'gui/501/ai.ashlr.serve']);
    expect(step(steps, 'kickstart-ai.ashlr.anthropic-proxy')?.argv).toBeUndefined();
  });

  it('ends by waiting for /verse/ and printing versions', () => {
    const steps = planShip(ctx()) as Step[];
    expect(ids(steps).slice(-2)).toEqual(['verse-up', 'versions']);
    expect(step(steps, 'verse-up')?.wait).toMatchObject({ kind: 'http-200', url: 'http://127.0.0.1:7777/verse/' });
  });
});

describe('backup naming and rotation', () => {
  it('names a backup <name>.prev-<short>, adding a time when that name is taken', () => {
    expect(backupName('ashlr', '01234567', ['ashlr'], NOW)).toBe('ashlr.prev-01234567');
    expect(backupName('ashlr', '01234567', ['ashlr', 'ashlr.prev-01234567'], NOW))
      .toBe('ashlr.prev-01234567-20260925-031502');
  });

  it('keeps the newest backups by mtime, counting the one being created', () => {
    const existing = [
      { name: 'ashlr', mtimeMs: 50 },
      { name: 'ashlr.prev-aaaa', mtimeMs: 1 },
      { name: 'ashlr.prev-bbbb', mtimeMs: 4 },
      { name: 'ashlr.prev-cccc', mtimeMs: 3 },
      { name: 'ashlr.prev-dddd', mtimeMs: 2 },
      { name: 'ashlr-desktop.prev-eeee', mtimeMs: 0 },
    ];
    expect(rotateBackups('ashlr', existing, { creating: true })).toEqual({
      keep: ['ashlr.prev-bbbb', 'ashlr.prev-cccc'],
      trash: ['ashlr.prev-dddd', 'ashlr.prev-aaaa'],
    });
    expect(rotateBackups('ashlr', existing, { creating: false }).keep).toHaveLength(KEEP_BACKUPS);
    expect(rotateBackups('public', existing, { creating: true })).toEqual({ keep: [], trash: [] });
  });

  it('moves old backups into a dated ~/.Trash folder with mv, never rm', () => {
    const listing = {
      'Contents/MacOS': [
        { name: 'ashlr', mtimeMs: 50 },
        { name: 'ashlr.prev-old1', mtimeMs: 1 },
        { name: 'ashlr.prev-old2', mtimeMs: 2 },
        { name: 'ashlr.prev-old3', mtimeMs: 3 },
      ],
      'Contents/Resources': [{ name: 'public', mtimeMs: 50 }, { name: 'public.prev-old1', mtimeMs: 1 }],
    };
    const steps = planShip(ctx({ listing })) as Step[];
    const trash = `${HOME}/.Trash/ashlr-app-backups-20260925-031502`;
    expect(step(steps, 'trash-dir')?.argv).toEqual(['mkdir', '-p', trash]);
    expect(step(steps, 'rotate-backups')?.argv).toEqual(['mv', `${APP_PATH}/Contents/MacOS/ashlr.prev-old1`, trash]);
    const order = ids(steps);
    expect(order.indexOf('rotate-backups')).toBeLessThan(order.indexOf('codesign'));
  });

  it('plans no trash step when there is nothing to rotate', () => {
    expect(ids(planShip(ctx()) as Step[])).not.toContain('rotate-backups');
  });
});

describe('tarballName', () => {
  it('matches npm pack naming for the scoped package', () => {
    expect(tarballName('@ashlr/hub', '3.11.1')).toBe('ashlr-hub-3.11.1.tgz');
  });
});

function fakeIo(overrides: Record<string, unknown> = {}) {
  const calls: string[][] = [];
  const logs: string[] = [];
  let now = 0;
  const io = {
    platform: 'darwin', home: HOME, tmp: '/os-tmp', uid: 501, now: NOW, repoRoot: REPO,
    clock: () => now,
    sleep: async (ms: number) => { now += ms; },
    log: (line: string) => logs.push(line),
    readFile: () => JSON.stringify({ name: '@ashlr/hub', version: '3.11.1' }),
    exists: (path: string) => path === APP_PATH,
    mtime: () => null,
    list: () => [{ name: 'ashlr', mtimeMs: 1 }],
    exec: (cmd: string, argv: string[]) => {
      calls.push([cmd, ...argv]);
      if (cmd === 'git' && argv[0] === 'rev-parse') return { status: 0, stdout: `${SHA}\n` };
      if (cmd === 'git' && argv[0] === 'status') return { status: 0, stdout: '' };
      if (cmd === 'launchctl' && argv[0] === 'print') return { status: argv[1].endsWith('ai.ashlr.serve') ? 0 : 113, stdout: '' };
      if (cmd === 'pgrep') return { status: 1, stdout: '' };
      return { status: 0, stdout: 'ashlr 3.11.1\n' };
    },
    fetchStatus: async () => 200,
    ...overrides,
  };
  return { io, calls, logs };
}

describe('gatherContext', () => {
  it('reads facts only through io, detecting dirt, the app and loaded agents', () => {
    const { io, calls } = fakeIo({
      exec: (cmd: string, argv: string[]) => {
        calls.push([cmd, ...argv]);
        if (cmd === 'git' && argv[0] === 'status') return { status: 0, stdout: ' M src/x.ts\n' };
        if (cmd === 'git') return { status: 0, stdout: `${SHA}\n` };
        return { status: argv[1]?.endsWith('ai.ashlr.serve') ? 0 : 113, stdout: '' };
      },
    });
    const c = gatherContext({ dryRun: true, native: false, allowDirty: false }, io);
    expect(c).toMatchObject({ dirty: true, sha: SHA, version: '3.11.1', appExists: true, loadedAgents: ['ai.ashlr.serve'] });
    expect(calls.map((c) => c[0])).toEqual(['git', 'git', 'launchctl', 'launchctl']);
    expect(() => planShip(c)).toThrow(/uncommitted/);
  });
});

describe('runSteps', () => {
  it('--dry-run prints every step and executes nothing', async () => {
    const { io, calls, logs } = fakeIo();
    const steps = planShip(gatherContext({ dryRun: true, native: false, allowDirty: false }, io));
    calls.length = 0;
    expect(await runSteps(steps, io, { dryRun: true })).toBe(0);
    expect(calls).toEqual([]);
    expect(logs.filter((l) => /^\s*\d+\. /.test(l))).toHaveLength(steps.length);
    expect(logs.join('\n')).toContain('$ npm pack --ignore-scripts');
  });

  it('runs commands in order and stops at the first failure', async () => {
    const { io, calls, logs } = fakeIo();
    const steps = planShip(gatherContext({ dryRun: false, native: false, allowDirty: false }, io));
    calls.length = 0;
    io.exec = (cmd: string, argv: string[]) => {
      calls.push([cmd, ...argv]);
      return { status: cmd === 'npm' && argv[1] === 'build' ? 2 : 0, stdout: '' };
    };
    expect(await runSteps(steps, io, { dryRun: false })).toBe(1);
    expect(calls.map((c) => c.slice(0, 3).join(' '))).toEqual(['rm -rf /repo/dist', 'npm run build']);
    expect(logs.at(-1)).toMatch(/step "build" failed/);
  });

  it('completes a full run against the fake io and waits for /verse/', async () => {
    const { io, calls, logs } = fakeIo();
    let polls = 0;
    io.fetchStatus = async () => (++polls < 3 ? null : 200);
    const steps = planShip(gatherContext({ dryRun: false, native: false, allowDirty: false }, io));
    expect(await runSteps(steps, io, { dryRun: false })).toBe(0);
    expect(polls).toBe(3);
    expect(calls.some((c) => c.join(' ') === 'launchctl kickstart -k gui/501/ai.ashlr.serve')).toBe(true);
    expect(logs.join('\n')).toContain('http://127.0.0.1:7777/verse/ → 200');
  });

  it('fails when /verse/ never answers 200', async () => {
    const { io, logs } = fakeIo({ fetchStatus: async () => 502 });
    const steps = planShip(gatherContext({ dryRun: false, native: false, allowDirty: false }, io));
    expect(await runSteps(steps, io, { dryRun: false })).toBe(1);
    expect(logs.at(-1)).toMatch(/answered 502/);
  });
});
