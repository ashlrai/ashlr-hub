/**
 * scripts/ship-local.mjs — planning logic only.
 *
 * Every machine fact comes from an injected io, so nothing here reads or writes the real
 * ~/.local, /Applications or launchd, and no command is executed: the fake io records calls.
 */
import { describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  APP_PATH,
  APP_BUNDLE_BUILD,
  ENTITLEMENTS,
  KEEP_BACKUPS,
  LOCAL_NETWORK_ATS,
  MIC_USAGE,
  NATIVE_BUILD,
  Refusal,
  backupName,
  codesignArgv,
  ensureSigningIdentity,
  gatherContext,
  parseIdentities,
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
type Step = { links?: {current: string; dest: string}; app?: { steps: Step[]; dest: string; source: string; sourceProof: {path: string} }; id: string; title: string; argv?: string[]; wait?: { kind: string }; versions?: unknown; identity?: string; sign?: { identity: string | null; entitlements: string } };
const HASH = 'F6674FDA4EDE6D75028DA2165382E629553DD6D6';
const INVENTORY = 'a'.repeat(64);

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
    selectedApp: { path: APP_PATH, signer: HASH, inventory: INVENTORY, dev: 1, ino: 2 },
    sourceApp: null,
    listing: {
      'Contents/MacOS': [{ name: 'ashlr', mtimeMs: 10 }, { name: 'ashlr-desktop', mtimeMs: 10 }],
      'Contents/Resources': [{ name: 'public', mtimeMs: 10 }, { name: 'icon.icns', mtimeMs: 10 }],
    } as Record<string, Entry[]>,
    loadedAgents: ['ai.ashlr.anthropic-proxy', 'ai.ashlr.serve'],
    signing: { hash: HASH, name: 'Ashlr Local', valid: true } as { hash: string; name: string; valid: boolean } | null,
    nativeBuildMtime: null as number | null,
    installedNativeMtime: 10 as number | null,
    installedNativeShortVersion: '3.11.1',
    installedNativeBundleVersion: '3.11.1',
    iconBuildMtime: null as number | null,
    installedIconMtime: 10 as number | null,
    ...overrides,
    ...(overrides.appExists === false ? { selectedApp: null } : {}),
  };
}

const flatten = (steps: Step[]): Step[] => steps.flatMap((s) => s.app ? [s, ...s.app.steps] : [s]);
const ids = (steps: Step[]) => flatten(steps).map((s) => s.id);
const step = (steps: Step[], id: string) => flatten(steps).find((s) => s.id === id);

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
    expect(step(steps, 'native-transaction')?.app?.dest).toBe(dest);
  });
});

describe('planShip step list', () => {
  it('builds, packs, installs and repoints current in order', () => {
    const steps = planShip(ctx()) as Step[];
    expect(ids(steps).slice(0, 10)).toEqual([
      'aliases-preflight',
      'entitlements-preflight', 'clean-dist', 'build', 'native-quiescence', 'pack-dir', 'pack', 'release-dir', 'extract', 'build-binary',
    ]);
    expect(step(steps, 'entitlements-preflight')?.argv).toEqual(['node', `${REPO}/scripts/check-macos-entitlements.mjs`]);
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
      'native-quiescence', 'native-transaction', 'backup-ashlr', 'install-ashlr', 'backup-public', 'install-public',
      'plist-mic', 'plist-local-network', 'codesign', 'codesign-verify',
    ]));
    expect(step(steps, 'backup-ashlr')?.argv).toEqual([
      'mv', `${APP_PATH}/Contents/MacOS/ashlr`, `${APP_PATH}/Contents/MacOS/ashlr.prev-01234567`,
    ]);
    expect(step(steps, 'backup-public')?.argv).toEqual([
      'mv', `${APP_PATH}/Contents/Resources/public`, `${APP_PATH}/Contents/Resources/public.prev-01234567`,
    ]);
    expect(step(steps, 'install-ashlr')?.argv).toEqual(['cp', '-R', `${REPO}/dist-bin/ashlr`, `${APP_PATH}/Contents/MacOS/ashlr`]);
    expect(step(steps, 'codesign')?.argv).toEqual([
      'codesign', '--force', '--deep', '--sign', HASH, '--entitlements', `${REPO}/${ENTITLEMENTS}`, APP_PATH,
    ]);
    expect(step(steps, 'plist-mic')?.argv).toEqual([
      'plutil', '-replace', 'NSMicrophoneUsageDescription', '-string', MIC_USAGE, `${APP_PATH}/Contents/Info.plist`,
    ]);
    expect(step(steps, 'plist-local-network')?.argv).toEqual([
      'plutil', '-replace', 'NSAppTransportSecurity', '-json', LOCAL_NETWORK_ATS, `${APP_PATH}/Contents/Info.plist`,
    ]);
    // Quit before touching the bundle; sign after the last copy; relaunch last.
    const order = ids(steps);
    expect(order.indexOf('entitlements-preflight')).toBeLessThan(order.indexOf('clean-dist'));
    expect(order.indexOf('native-quiescence')).toBeLessThan(order.indexOf('backup-ashlr'));
    expect(order.indexOf('install-public')).toBeLessThan(order.indexOf('codesign'));
    // The plist is part of what gets signed.
    expect(order.indexOf('plist-mic')).toBeLessThan(order.indexOf('codesign'));
    expect(order.indexOf('plist-local-network')).toBeLessThan(order.indexOf('codesign'));
    expect(ids(steps)).not.toContain('signing-identity');
    expect(step(steps, 'native-transaction')?.app?.dest).toBe(`${HOME}/.local/share/ashlr/releases/${SHA}`);
    expect(order).not.toContain('current'); // pointer commit occurs only inside the verified transaction
    expect(order).not.toContain('app-quit'); // active work is never silently quit
  });

  it('never removes anything but the repo dist/', () => {
    const steps = planShip(ctx({ native: true, nativeBuildMtime: 99 })) as Step[];
    const removals = steps.filter((s) => s.argv?.[0] === 'rm');
    expect(removals.map((s) => s.argv)).toEqual([['rm', '-rf', `${REPO}/dist`]]);
  });

  it('skips the bundle when the app is not installed', () => {
    const steps = planShip(ctx({ appExists: false, listing: {} })) as Step[];
    expect(ids(steps)).toContain('app-absent');
    expect(ids(steps)).not.toContain('entitlements-preflight');
    expect(ids(steps).some((id) => id.startsWith('backup-') || id === 'codesign')).toBe(false);
  });

  it('installs ashlr-desktop only with --native and only when the build is newer', () => {
    expect(ids(planShip(ctx({ nativeBuildMtime: 99 })) as Step[])).not.toContain('install-ashlr-desktop');
    const newer = planShip(ctx({ native: true, nativeBuildMtime: 99 })) as Step[];
    expect(step(newer, 'install-ashlr-desktop')?.argv).toEqual([
      'cp', '-R', `${REPO}/${NATIVE_BUILD}`, `${APP_PATH}/Contents/MacOS/ashlr-desktop`,
    ]);
    expect(step(newer, 'backup-ashlr-desktop')).toBeDefined();
    expect(step(newer, 'plist-short-version')?.argv).toEqual([
      'plutil', '-replace', 'CFBundleShortVersionString', '-string', '3.11.1', `${APP_PATH}/Contents/Info.plist`,
    ]);
    expect(step(newer, 'plist-bundle-version')?.argv).toEqual([
      'plutil', '-replace', 'CFBundleVersion', '-string', '3.11.1', `${APP_PATH}/Contents/Info.plist`,
    ]);
    const order = ids(newer);
    expect(order.indexOf('install-ashlr-desktop')).toBeLessThan(order.indexOf('plist-short-version'));
    expect(order.indexOf('plist-short-version')).toBeLessThan(order.indexOf('plist-bundle-version'));
    expect(order.indexOf('plist-bundle-version')).toBeLessThan(order.indexOf('codesign'));
    const older = planShip(ctx({ native: true, nativeBuildMtime: 5 })) as Step[];
    expect(ids(older)).not.toContain('install-ashlr-desktop');
    expect(ids(older)).not.toContain('plist-short-version');
    expect(ids(older)).not.toContain('plist-bundle-version');
    expect(step(older, 'native-skip')?.title).toMatch(/not newer/);
    const interrupted = planShip(ctx({ native: true, nativeBuildMtime: 5, installedNativeBundleVersion: '0.1.0' })) as Step[];
    expect(ids(interrupted)).toContain('install-ashlr-desktop');
    expect(ids(interrupted)).toContain('plist-short-version');
    expect(ids(interrupted)).toContain('plist-bundle-version');
    const shortVersionDrift = planShip(ctx({ native: true, nativeBuildMtime: 5, installedNativeShortVersion: '0.1.0' })) as Step[];
    expect(ids(shortVersionDrift)).toContain('install-ashlr-desktop');
    const missing = planShip(ctx({ native: true, nativeBuildMtime: null })) as Step[];
    expect(ids(missing)).not.toContain('plist-short-version');
    expect(ids(missing)).not.toContain('plist-bundle-version');
    expect(step(missing, 'native-skip')?.title).toMatch(/missing/);
    const cliOnly = planShip(ctx({ nativeBuildMtime: 99 })) as Step[];
    expect(ids(cliOnly)).not.toContain('plist-short-version');
    expect(ids(cliOnly)).not.toContain('plist-bundle-version');
  });

  it('kickstarts only the launch agents that are loaded', () => {
    const steps = planShip(ctx({ appExists: false, loadedAgents: ['ai.ashlr.serve'] })) as Step[];
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
  const links = new Map<string, string>();
  let now = 0;
  const io = {
    platform: 'darwin', home: HOME, tmp: '/os-tmp', uid: 501, now: NOW, repoRoot: REPO,
    clock: () => now,
    sleep: async (ms: number) => { now += ms; },
    log: (line: string) => logs.push(line),
    exclusiveRenamePreflight: () => {}, renameExclusive: (from: string, to: string) => { calls.push(['exclusive-rename', from, to]); },
    readBoundedFile: () => JSON.stringify({desktopPid: 42, sidecarPid: 43, port: 7777, sidecarPath: `${APP_PATH}/Contents/MacOS/ashlr`}),
    validateLocalPath: () => {}, readCurrentPointer: () => null, restoreCurrentPointer: () => {}, switchCurrentPointer: () => {}, writeInstallJournal: () => {}, readLink: (path: string) => links.get(path) ?? '', linkTargetExists: () => true, createAlias: (path: string, target: string) => {links.set(path, target);}, removeAlias: (path: string) => {links.delete(path);},
    readFile: () => JSON.stringify({ name: '@ashlr/hub', version: '3.11.1' }),
    exists: (path: string) => path === APP_PATH || (calls.some((call) => call[0] === '/usr/bin/open') && path.endsWith('.desktop-sidecar.json')),
    lstat: (path: string) => path.includes('/.local/bin/') ? (links.has(path) ? {dev: 1, ino: 50, isSymbolicLink: true} : null) : ({ dev: 1, ino: 2, size: 1, isFile: path.endsWith('KILL') || path.endsWith('.desktop-sidecar.json'), isDirectory: !path.endsWith('KILL') && !path.endsWith('.desktop-sidecar.json'), isSymbolicLink: false }),
    appInventory: () => INVENTORY,
    executionLeaseCensus: async () => ({ leases: [], unknown: 0, reaped: 0 }),
    makeInstallStage: () => '/Applications/.phantom-install-fixture',
    removeInstallTree: () => {},
    mtime: () => null,
    list: () => [{ name: 'ashlr', mtimeMs: 1 }],
    exec: (cmd: string, argv: string[]) => {
      if (argv.some(value => typeof value !== 'string')) throw new Error('non-string argv');
      calls.push([cmd, ...argv]);
      if (cmd === 'git' && argv[0] === 'rev-parse') return { status: 0, stdout: `${SHA}\n` };
      if (cmd === 'git' && argv[0] === 'status') return { status: 0, stdout: '' };
      if (cmd === 'launchctl' && argv[0] === 'print') return { status: argv[1].endsWith('ai.ashlr.serve') ? 0 : 113, stdout: '' };
      if (cmd === '/bin/ps') return { status: 0, stdout: calls.some((call) => call[0] === '/usr/bin/open') ? `42 1 Wed Oct 7 16:00:00 2026 ${APP_PATH}/Contents/MacOS/ashlr-desktop\n43 42 Wed Oct 7 16:00:00 2026 ${APP_PATH}/Contents/MacOS/ashlr verse --port 7777 --no-open --json` : '' };
      if (cmd === '/usr/sbin/lsof') return {status: 0, stdout: 'p43\nf8\n'};
      if (cmd === '/usr/bin/plutil') return { status: 0, stdout: argv[1] === 'CFBundleIdentifier' ? 'ai.ashlr.desktop' : argv[1] === 'CFBundleExecutable' ? 'ashlr-desktop' : '3.11.1' };
      if (cmd === 'pgrep') return { status: 1, stdout: '' };
      if (cmd === 'security') return { status: 0, stdout: `  1) ${HASH} "Ashlr Local"\n` };
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
        if (cmd === '/usr/bin/plutil') return { status: 0, stdout: argv[1] === 'CFBundleIdentifier' ? 'ai.ashlr.desktop' : 'ashlr-desktop' };
        if (cmd === '/usr/bin/codesign') return {status: 0, stdout: ''};
        if (cmd === 'security') return { status: 0, stdout: `  1) ${HASH} "Ashlr Local"\n     1 identities found\n` };
        return { status: argv[1]?.endsWith('ai.ashlr.serve') ? 0 : 113, stdout: '' };
      },
    });
    const c = gatherContext({ dryRun: true, native: false, allowDirty: false }, io);
    expect(c).toMatchObject({ dirty: true, sha: SHA, version: '3.11.1', appExists: true, loadedAgents: ['ai.ashlr.serve'] });
    expect(c.signing).toEqual({ hash: HASH, name: 'Ashlr Local', valid: true });
    expect(calls.map((c) => c[0])).toEqual(['git', 'git', 'security', '/usr/bin/plutil', '/usr/bin/plutil', '/usr/bin/codesign', 'launchctl', 'launchctl']);
    expect(calls.find((c) => c[0] === 'security')).toEqual(['security', 'find-identity', '-p', 'codesigning']);
    expect(() => planShip(c)).toThrow(/uncommitted/);
  });

  it('reads both installed app versions for a native retry', () => {
    const { io, calls } = fakeIo();
    const originalExec = io.exec;
    io.exec = (cmd: string, argv: string[]) => {
      if (cmd === 'plutil') {
        calls.push([cmd, ...argv]);
        return { status: 0, stdout: argv[1] === 'CFBundleShortVersionString' ? '0.1.0\n' : '3.11.1\n' };
      }
      return originalExec(cmd, argv);
    };
    const native = gatherContext({ dryRun: true, native: true, allowDirty: false }, io);
    expect(native.installedNativeShortVersion).toBe('0.1.0');
    expect(native.installedNativeBundleVersion).toBe('3.11.1');
    expect(calls.filter((call) => call[0] === 'plutil').map((call) => call[2])).toEqual([
      'CFBundleShortVersionString', 'CFBundleVersion',
    ]);
    calls.length = 0;
    gatherContext({ dryRun: true, native: false, allowDirty: false }, io);
    expect(calls.some((call) => call[0] === 'plutil')).toBe(false);
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
    expect(calls.map((c) => c.slice(0, 3).join(' '))).toEqual([
      'node /repo/scripts/check-macos-entitlements.mjs', 'rm -rf /repo/dist', 'npm run build',
    ]);
    expect(logs.at(-1)).toMatch(/step "build" failed/);
  });

  it('stops before signing if an installed native app version cannot be updated', async () => {
    const { io, calls, logs } = fakeIo();
    const originalExec = io.exec;
    io.exec = (cmd: string, argv: string[]) => {
      if (cmd === 'plutil' && argv[1] === 'CFBundleVersion') {
        calls.push([cmd, ...argv]);
        return { status: 1, stdout: '' };
      }
      return originalExec(cmd, argv);
    };
    const steps = planShip(ctx({ native: true, nativeBuildMtime: 99 }));
    expect(await runSteps(steps, io, { dryRun: false })).toBe(1);
    expect(calls.some((call) => call[0] === 'plutil' && call[2] === 'CFBundleShortVersionString')).toBe(true);
    expect(calls.some((call) => call[0] === 'plutil' && call[2] === 'CFBundleVersion')).toBe(true);
    expect(calls.some((call) => call[0] === 'codesign')).toBe(false);
    expect(logs.join('\n')).toMatch(/step "plist-bundle-version" failed/);
  });

  it('completes a full run against the fake io and waits for /verse/', async () => {
    const { io, calls, logs } = fakeIo();
    let polls = 0;
    io.fetchStatus = async () => (++polls < 3 ? null : 200);
    const steps = planShip(gatherContext({ dryRun: false, native: false, allowDirty: false }, io));
    expect(await runSteps(steps, io, { dryRun: false }), logs.join('\n')).toBe(0);
    expect(polls).toBe(4);
    expect(calls.some((c) => c.join(' ') === 'launchctl kickstart -k gui/501/ai.ashlr.serve')).toBe(false);
    expect(logs.join('\n')).toContain('http://127.0.0.1:7777/verse/ → 200');
  });

  it('fails when /verse/ never answers 200', async () => {
    const { io, logs } = fakeIo({ fetchStatus: async () => 502 });
    const steps = planShip(gatherContext({ dryRun: false, native: false, allowDirty: false }, io));
    expect(await runSteps(steps, io, { dryRun: false })).toBe(1);
    expect(logs.join('\n')).toMatch(/owned launch\/health/);
  });
});

describe('the app icon (3.11.3)', () => {
  it('--native installs a newer icon.icns, backs up the old one, and touches the bundle', () => {
    const steps = planShip(ctx({ native: true, iconBuildMtime: 99 })) as Step[];
    expect(ids(steps)).toEqual(expect.arrayContaining(['backup-icon.icns', 'install-icon.icns', 'touch-app']));
    expect(step(steps, 'install-icon.icns')!.argv).toEqual(['cp', '-R', `${REPO}/desktop/src-tauri/icons/icon.icns`, `${APP_PATH}/Contents/Resources/icon.icns`]);
    expect(ids(steps).indexOf('touch-app')).toBeGreaterThan(ids(steps).indexOf('codesign'));
  });

  it('leaves the icon alone without --native or when it is not newer', () => {
    expect(ids(planShip(ctx({ iconBuildMtime: 99 })) as Step[])).not.toContain('install-icon.icns');
    expect(ids(planShip(ctx({ native: true, iconBuildMtime: 5 })) as Step[])).not.toContain('install-icon.icns');
    expect(ids(planShip(ctx({ native: true, iconBuildMtime: 5 })) as Step[])).not.toContain('touch-app');
  });
});

describe('stable local code signing (dictation keeps its microphone grant)', () => {
  it('parses the keychain listing, telling trusted from untrusted', () => {
    expect(parseIdentities([
      `  1) ${HASH} "Ashlr Local" (CSSMERR_TP_NOT_TRUSTED)`,
      '  2) 0000000000000000000000000000000000000001 "Apple Development: Mason (X)"',
      '     2 identities found',
    ].join('\n'))).toEqual([
      { hash: HASH, name: 'Ashlr Local', valid: false },
      { hash: '0000000000000000000000000000000000000001', name: 'Apple Development: Mason (X)', valid: true },
    ]);
    expect(parseIdentities('0 identities found')).toEqual([]);
  });

  it('signs with the identity and the entitlements; ad-hoc only as the named fallback', () => {
    expect(codesignArgv(HASH, '/e.plist')).toEqual(['codesign', '--force', '--deep', '--sign', HASH, '--entitlements', '/e.plist', APP_PATH]);
    expect(codesignArgv(null, '/e.plist')).toEqual(['codesign', '--force', '--deep', '--sign', '-', '--entitlements', '/e.plist', APP_PATH]);
  });

  it('refuses native updates without the existing valid signer instead of changing code identity', () => {
    for (const signing of [null, { hash: HASH, name: 'Ashlr Local', valid: false }]) {
      expect(() => planShip(ctx({ signing }))).toThrow(/existing valid Ashlr Local/);
    }
  });

  function signingIo(script: (cmd: string, argv: string[]) => { status: number; stdout: string } | undefined) {
    const calls: string[][] = [];
    const logs: string[] = [];
    const files = new Map<string, string>();
    const removed: string[] = [];
    const io = {
      home: HOME,
      log: (line: string) => logs.push(line),
      mkdtemp: (prefix: string) => `/os-tmp/${prefix}xyz`,
      writeFile: (path: string, text: string) => files.set(path, text),
      removeDir: (dir: string) => removed.push(dir),
      exec: (cmd: string, argv: string[]) => {
        calls.push([cmd, ...argv]);
        return script(cmd, argv) ?? { status: 0, stdout: '' };
      },
    };
    return { io, calls, logs, files, removed };
  }

  it('returns an existing trusted identity without touching the keychain', () => {
    const { io, calls } = signingIo(() => ({ status: 0, stdout: `  1) ${HASH} "Ashlr Local"\n` }));
    expect(ensureSigningIdentity(io)).toBe(HASH);
    expect(calls).toEqual([['security', 'find-identity', '-p', 'codesigning']]);
  });

  it('creates, imports and trusts a missing identity, then removes the key material', () => {
    let trusted = false;
    const { io, calls, files, removed } = signingIo((cmd, argv) => {
      if (cmd === 'security' && argv[0] === 'find-identity') {
        return { status: 0, stdout: trusted ? `  1) ${HASH} "Ashlr Local"\n` : '     0 identities found\n' };
      }
      if (cmd === 'security' && argv[0] === 'add-trusted-cert') trusted = true;
      return undefined;
    });
    expect(ensureSigningIdentity(io)).toBe(HASH);
    const cmds = calls.map((c) => `${c[0]} ${c[1]}`);
    expect(cmds).toEqual([
      'security find-identity',
      '/usr/bin/openssl req',
      '/usr/bin/openssl pkcs12',
      'security import',
      'security add-trusted-cert',
      'security find-identity',
    ]);
    const req = calls[1]!;
    expect(req).toEqual(expect.arrayContaining(['-x509', '-extensions', 'ext']));
    expect([...files.values()][0]).toContain('extendedKeyUsage = critical,codeSigning');
    const trust = calls.find((c) => c[1] === 'add-trusted-cert')!;
    expect(trust).toEqual(['security', 'add-trusted-cert', '-r', 'trustRoot', '-p', 'codeSign', '-k', `${HOME}/Library/Keychains/login.keychain-db`, '/os-tmp/ashlr-sign-xyz/cert.pem']);
    const imp = calls.find((c) => c[1] === 'import')!;
    expect(imp).toEqual(expect.arrayContaining(['-T', '/usr/bin/codesign', '-k', `${HOME}/Library/Keychains/login.keychain-db`]));
    expect(removed).toEqual(['/os-tmp/ashlr-sign-xyz']);
  });

  it('trusts an existing-but-untrusted identity instead of making a second one', () => {
    let trusted = false;
    const { io, calls } = signingIo((cmd, argv) => {
      if (argv[0] === 'find-identity') return { status: 0, stdout: `  1) ${HASH} "Ashlr Local"${trusted ? '' : ' (CSSMERR_TP_NOT_TRUSTED)'}\n` };
      if (argv[0] === 'find-certificate') return { status: 0, stdout: '-----BEGIN CERTIFICATE-----\nMII\n-----END CERTIFICATE-----\n' };
      if (argv[0] === 'add-trusted-cert') trusted = true;
      return undefined;
    });
    expect(ensureSigningIdentity(io)).toBe(HASH);
    expect(calls.some((c) => c[0] === '/usr/bin/openssl')).toBe(false);
  });

  it('a cancelled trust prompt falls back: null, and the temp dir is still removed', () => {
    const { io, logs, removed } = signingIo((cmd, argv) => {
      if (argv[0] === 'find-identity') return { status: 0, stdout: '' };
      if (argv[0] === 'add-trusted-cert') return { status: 1, stdout: '' };
      return undefined;
    });
    expect(ensureSigningIdentity(io)).toBeNull();
    expect(logs.at(-1)).toMatch(/not trusted for code signing/);
    expect(removed).toHaveLength(1);
  });

  it('uses the exact valid signer during staged native maintenance without identity creation', async () => {
    const {io, calls} = fakeIo();
    expect(await runSteps(planShip(ctx()), io, {dryRun: false}), calls.map(c => c.join(' ')).join('\n')).toBe(0);
    expect(calls.some((c) => c[0] === 'security' && c[1] === 'add-trusted-cert')).toBe(false);
    for (const c of calls.filter((c) => c.includes('--sign'))) expect(c[c.indexOf('--sign') + 1]).toBe(HASH);
  });
});

// Native migration effects remain wholly private/injected: no actual app, process, lease or signer is contacted.
import { LEGACY_APP_PATH, inspectLocalApp, selectLocalApp, requireLocalQuiescence, installLocalApp, launchedAppIsOwned, inspectLocalAliases, createLocalAliases, removeCreatedAliases, exclusiveRenameAvailable, renamePathExclusive, ownedReleaseTarget, inspectCurrentPointer, switchLocalCurrentPointer } from '../scripts/local-app-transaction.mjs';

function appIo(installed: string[] = [LEGACY_APP_PATH]) {
  const bundles = new Map(installed.map((path) => [path, { inventory: INVENTORY, ino: 2 }]));
  const calls: string[][] = [];
  let unknown = 0;
  let processes = '';
  let kill = true;
  let conflict = false;
  let archiveBad = false;
  const io = {
    home: HOME, repoRoot: REPO, log: () => {}, exclusiveRenamePreflight: () => {}, writeInstallJournal: () => {}, readBoundedFile: () => '',
    exists: (path: string) => bundles.has(path),
    readFile: () => '',
    lstat: (path: string) => path.endsWith('KILL') ? (kill ? { isFile: true, isSymbolicLink: false } : null) : { isDirectory: true, isSymbolicLink: false, dev: 1, ino: bundles.get(path)?.ino ?? 3 },
    appInventory: (path: string) => archiveBad && path.includes('archive-check') ? 'b'.repeat(64) : bundles.get(path)?.inventory ?? INVENTORY,
    executionLeaseCensus: async () => ({ leases: [], unknown, reaped: 0 }),
    makeInstallStage: () => '/Applications/.phantom-install-test',
    removeInstallTree: (path: string) => { calls.push(['cleanup', path]); bundles.delete(path); },
    renameExclusive: (from: string, to: string, expected: {dev: number; ino: number}) => {
      calls.push(['exclusive-rename', from, to]);
      const record = bundles.get(from);
      if ((conflict && from.endsWith('/Phantom.app')) || !record || bundles.has(to) || expected.dev !== 1 || expected.ino !== record.ino) throw new Error('exclusive rename refused');
      bundles.delete(from); bundles.set(to, record);
    },
    exec: (cmd: string, argv: string[]) => {
      if (argv.some(value => typeof value !== 'string')) throw new Error('non-string argv');
      calls.push([cmd, ...argv]);
      if (cmd === '/bin/ps') return { status: 0, stdout: processes };
      if (cmd === '/usr/bin/plutil' && argv[0] === '-extract') return { status: 0, stdout: argv[1] === 'CFBundleIdentifier' ? 'ai.ashlr.desktop' : argv[1] === 'CFBundleExecutable' ? 'ashlr-desktop' : '3.11.1' };
      if (cmd === '/usr/bin/ditto' && argv.length === 2) bundles.set(argv[1]!, { ...bundles.get(argv[0]!)!, ino: 3 });
      if (cmd === '/usr/bin/ditto' && argv[0] === '-x') bundles.set(`${argv[3]}/${installed[0]?.split('/').at(-1)}`, { inventory: INVENTORY, ino: 3 });
      if (cmd === '/bin/mv') {
        if (conflict && argv[0]?.endsWith('/Phantom.app')) return { status: 1, stdout: '' };
        const record = bundles.get(argv[0]!);
        if (!record || bundles.has(argv[1]!)) return { status: 1, stdout: '' };
        bundles.delete(argv[0]!); bundles.set(argv[1]!, record);
      }
      return { status: 0, stdout: '' };
    },
  };
  return { io, bundles, calls, unknown: (n: number) => { unknown = n; }, processes: (s: string) => { processes = s; }, kill: (on: boolean) => { kill = on; }, refuseSwitch: () => { conflict = true; }, badArchive: () => { archiveBad = true; } };
}

const nativeInput = (selected: ReturnType<typeof selectLocalApp>) => ({ selected, source: selected?.path ?? `${REPO}/${APP_BUNDLE_BUILD}`, sourceProof: selected, signer: HASH, version: '3.11.1', native: true, entitlements: `${REPO}/${ENTITLEMENTS}`, prepare: async () => {}, health: async () => true });

describe('identity-bound Phantom native migration', () => {
  it.each([LEGACY_APP_PATH, APP_PATH])('selects only the single verified %s installation', (path) => {
    const { io, calls } = appIo([path]);
    expect(selectLocalApp(HASH, io)?.path).toBe(path);
    expect(calls).toContainEqual(['/usr/bin/codesign', '--verify', '--deep', '--strict', `-R=identifier "ai.ashlr.desktop" and certificate leaf = H"${HASH}"`, path]);
  });
  it('keeps absent state explicit and refuses both names before reading either app', () => {
    expect(selectLocalApp(HASH, appIo([]).io)).toBeNull();
    const { io, calls } = appIo([APP_PATH, LEGACY_APP_PATH]);
    expect(() => selectLocalApp(HASH, io)).toThrow(/both/); expect(calls).toEqual([]);
  });
  it('refuses invalid signing identity, symlinks, unrelated bundle IDs and executable names', () => {
    const f = appIo(); expect(() => selectLocalApp(null, f.io)).toThrow(/signing identity/);
    expect(() => inspectLocalApp(LEGACY_APP_PATH, HASH, { ...f.io, lstat: () => ({ isDirectory: true, isSymbolicLink: true }) })).toThrow(/regular app/);
    for (const key of ['CFBundleIdentifier', 'CFBundleExecutable']) {
      const exec = f.io.exec;
      const io = { ...f.io, exec: (cmd: string, argv: string[]) => cmd === '/usr/bin/plutil' && argv[1] === key ? { status: 0, stdout: 'unrelated' } : exec(cmd, argv) };
      expect(() => inspectLocalApp(LEGACY_APP_PATH, HASH, io)).toThrow(/unsupported/);
    }
  });
  it('refuses unsigned/other-signer bundles and changed inventory before preparation', async () => {
    const f = appIo(); const selected = selectLocalApp(HASH, f.io);
    expect(() => inspectLocalApp(LEGACY_APP_PATH, HASH, { ...f.io, exec: () => ({ status: 1, stdout: '' }) })).toThrow(/failed/);
    f.bundles.get(LEGACY_APP_PATH)!.inventory = 'b'.repeat(64);
    await expect(installLocalApp(nativeInput(selected), f.io)).rejects.toThrow(/changed/);
    expect(f.calls.some((c) => c[0] === 'exclusive-rename')).toBe(false);
  });
  it('requires prior Stop, known drained leases, complete process records and closed native/sidecar', async () => {
    const f = appIo(); f.kill(false); await expect(requireLocalQuiescence(f.io)).rejects.toThrow(/Stop/);
    f.kill(true); f.unknown(1); await expect(requireLocalQuiescence(f.io)).rejects.toThrow(/leases/);
    f.unknown(0); f.processes('unparseable'); await expect(requireLocalQuiescence(f.io)).rejects.toThrow(/unrecognized/);
    for (const path of [APP_PATH, LEGACY_APP_PATH]) {
      f.processes(` 42 1 Wed Oct 7 16:00:00 2026 ${path}/Contents/MacOS/ashlr verse --port 7777`);
      await expect(requireLocalQuiescence(f.io)).rejects.toThrow(/still running/);
    }
    f.processes(''); await expect(requireLocalQuiescence(f.io)).resolves.toBeUndefined();
    expect(f.calls.some((c) => ['kill', 'osascript', 'launchctl'].includes(c[0]!))).toBe(false);
  });
  it.each([LEGACY_APP_PATH, APP_PATH])('stages and verifies before switching %s, retaining only a compressed rollback artifact', async (path) => {
    const f = appIo([path]); const selected = selectLocalApp(HASH, f.io);
    const result = await installLocalApp(nativeInput(selected), f.io);
    expect(result).toEqual({ app: APP_PATH, rollbackArchive: '/Applications/.phantom-install-test/previous-app.zip' });
    expect([...f.bundles.keys()].filter((p) => [APP_PATH, LEGACY_APP_PATH].includes(p))).toEqual([APP_PATH]);
    const firstMove = f.calls.findIndex((c) => c[0] === 'exclusive-rename');
    expect(f.calls.slice(0, firstMove).some((c) => c[0] === '/usr/bin/codesign' && c.includes('--strict'))).toBe(true);
    expect(f.calls.slice(0, firstMove).some((c) => c[0] === '/usr/bin/ditto' && c.includes('-x'))).toBe(true);
    expect(f.calls.some((c) => c[0] === '/usr/bin/open' && c[1] === APP_PATH)).toBe(true);
    expect(f.calls.some((c) => c[0] === 'cleanup' && c[1]?.endsWith('retired-bundle'))).toBe(true);
    expect(f.calls.some((c) => c[0] === 'cleanup' && c[1]?.endsWith('.zip'))).toBe(false);
  });
  it('keeps authenticated update bytes unchanged and never prepares, rewrites or signs them', async () => {
    const f = appIo(); const selected = selectLocalApp(HASH, f.io); const original = f.io.exec;
    const exec = (cmd: string, argv: string[]) => cmd === '/usr/bin/plutil' && argv[0] === '-extract' && ['CFBundleName', 'CFBundleDisplayName'].includes(argv[1]!)
      ? {status: 0, stdout: 'Phantom'} : original(cmd, argv);
    const prepare = vi.fn(); const beforeSwitch = vi.fn();
    await installLocalApp({...nativeInput(selected), preserveSigned: true, prepare, beforeSwitch}, {...f.io, exec});
    expect(prepare).not.toHaveBeenCalled(); expect(beforeSwitch).toHaveBeenCalledOnce();
    expect(f.calls.some(call => call[0] === '/usr/bin/codesign' && call.includes('--force'))).toBe(false);
    expect(f.calls.some(call => call[0] === '/usr/bin/plutil' && call.includes('-replace'))).toBe(false);
    expect(f.bundles.get(APP_PATH)?.inventory).toBe(INVENTORY);
  });
  it('refuses signed display identity and fresh admission failures before changing the active app', async () => {
    for (const display of ['Unrelated', 'Phantom']) {
      const f = appIo(); const selected = selectLocalApp(HASH, f.io); const original = f.io.exec;
      const exec = (cmd: string, argv: string[]) => cmd === '/usr/bin/plutil' && argv[0] === '-extract' && ['CFBundleName', 'CFBundleDisplayName'].includes(argv[1]!)
        ? {status: 0, stdout: display} : original(cmd, argv);
      await expect(installLocalApp({...nativeInput(selected), preserveSigned: true,
        beforeSwitch: async () => {throw new Error('grant revoked');}}, {...f.io, exec})).rejects.toThrow();
      expect(f.calls.some(call => call[0] === 'exclusive-rename')).toBe(false);
      expect(f.bundles.has(LEGACY_APP_PATH)).toBe(true);
    }
  });
  it('restores the original app when the final pointer guard refuses before pointer publication', async () => {
    const f=appIo(),selected=selectLocalApp(HASH,f.io);const phases:string[]=[];const previous={target:'/owned/previous',ino:17};const current=previous;
    const rollback=vi.fn(async()=>{if(JSON.stringify(current)!==JSON.stringify(previous))throw new Error('pointer recovery unknown');});
    await expect(installLocalApp({...nativeInput(selected),beforeSwitch:async()=>{},commitPointer:async()=>{throw new Error('candidate changed during app checks');},rollbackPointer:rollback},
      {...f.io,writeInstallJournal:(_owner:string,value:{phase:string})=>phases.push(value.phase)})).rejects.toThrow('candidate changed');
    expect(rollback).toHaveBeenCalledOnce();expect(current).toEqual(previous);expect(phases.at(-1)).toBe('rolled-back');
    expect(f.bundles.has(LEGACY_APP_PATH)).toBe(true);expect(f.bundles.has(APP_PATH)).toBe(false);
  });
  it('refuses a mismatched archive before changing the active app', async () => {
    const f = appIo(); const selected = selectLocalApp(HASH, f.io); f.badArchive();
    await expect(installLocalApp(nativeInput(selected), f.io)).rejects.toThrow(/archive/);
    expect(f.bundles.has(LEGACY_APP_PATH)).toBe(true); expect(f.calls.some((c) => c[0] === 'exclusive-rename')).toBe(false);
  });
  it('restores the original full app if the switch or settled launch acceptance fails', async () => {
    for (const switchFailure of [true, false]) {
      const f = appIo(); const selected = selectLocalApp(HASH, f.io); if (switchFailure) f.refuseSwitch();
      await expect(installLocalApp({ ...nativeInput(selected), health: async () => false }, f.io)).rejects.toThrow();
      expect(f.bundles.has(LEGACY_APP_PATH)).toBe(true); expect(f.bundles.has(APP_PATH)).toBe(false);
      expect(f.bundles.get(LEGACY_APP_PATH)?.inventory).toBe(INVENTORY);
    }
  });
  it('holds rollback rather than moving a replacement that has become active', async () => {
    const f = appIo(); const selected = selectLocalApp(HASH, f.io);
    await expect(installLocalApp({ ...nativeInput(selected), health: async () => { f.processes(` 42 1 Wed Oct 7 16:00:00 2026 ${APP_PATH}/Contents/MacOS/ashlr-desktop`); return false; } }, f.io)).rejects.toThrow(/health/);
    expect(f.bundles.has(APP_PATH)).toBe(true); expect(f.bundles.has('/Applications/.phantom-install-test/retired-bundle')).toBe(true);
  });
});

describe('native migration admission and rollback boundaries', () => {
  it('does not query a signer for an absent CLI-only installation', () => {
    const f = fakeIo({exists: () => false});
    expect(gatherContext({dryRun: true, native: false, allowDirty: false}, f.io).signing).toBeNull();
    expect(f.calls.some(c => c[0] === 'security')).toBe(false);
  });
  it('refuses active leases and unreadable or still-live ownership records without stopping anything', async () => {
    const f = appIo();
    await expect(requireLocalQuiescence({...f.io, executionLeaseCensus: async () => ({leases: [{}], unknown: 0})})).rejects.toThrow(/leases/);
    const record = `${HOME}/.ashlr/.desktop-sidecar.json`;
    const io = {...f.io, exists: (path: string) => path === record, lstat: (path: string) => path === record ? {isFile: true, size: 200, isSymbolicLink: false} : f.io.lstat(path), readBoundedFile: () => '{bad'};
    await expect(requireLocalQuiescence(io)).rejects.toThrow(/record is invalid/);
    io.readBoundedFile = () => JSON.stringify({desktopPid: 52, sidecarPid: 53, port: 7777, sidecarPath: `${APP_PATH}/Contents/MacOS/ashlr`});
    f.processes('52 1 Wed Oct 7 16:00:00 2026 /unrelated/process');
    await expect(requireLocalQuiescence(io)).rejects.toThrow(/live or uncertain/);
  });
  it('accepts health only for the exact parented native/sidecar processes and owned listener', () => {
    const f = appIo(); const record = `${HOME}/.ashlr/.desktop-sidecar.json`;
    const io = {...f.io, exists: (path: string) => path === record, lstat: () => ({isFile: true, size: 200, isSymbolicLink: false}), readBoundedFile: () => JSON.stringify({desktopPid: 52, sidecarPid: 53, port: 7777, sidecarPath: `${APP_PATH}/Contents/MacOS/ashlr`})};
    expect(launchedAppIsOwned(io)).toBe(false);
    f.processes(`52 1 Wed Oct 7 16:00:00 2026 ${APP_PATH}/Contents/MacOS/ashlr-desktop\n53 52 Wed Oct 7 16:00:00 2026 ${APP_PATH}/Contents/MacOS/ashlr verse --port 7777 --no-open --json`);
    const exec = io.exec;
    io.exec = (cmd: string, argv: string[]) => cmd === '/usr/sbin/lsof' ? {status: 0, stdout: 'p53\nf8\n'} : exec(cmd, argv);
    expect(launchedAppIsOwned(io)).toBe(true);
    io.exec = (cmd: string, argv: string[]) => cmd === '/usr/sbin/lsof' ? {status: 0, stdout: 'p99\n'} : exec(cmd, argv);
    expect(launchedAppIsOwned(io)).toBe(false);
    f.processes(`52 1 Wed Oct 7 16:00:00 2026 ${APP_PATH}/Contents/MacOS/ashlr-desktop\n53 99 Wed Oct 7 16:00:00 2026 ${APP_PATH}/Contents/MacOS/ashlr verse --port 7777 --no-open --json`);
    expect(launchedAppIsOwned(io)).toBe(false);
  });
  it('accepts only the native fixed remote config with required private token handoff', () => {
    const f = appIo(); const record = `${HOME}/.ashlr/.desktop-sidecar.json`;
    const sidecar = `${APP_PATH}/Contents/MacOS/ashlr`, base = `${sidecar} verse --port 7777 --no-open --json`;
    const remote = `--remote-config ${HOME}/.ashlr/verse-remote.json --desktop-token-handoff`;
    const io = {...f.io, exists: (path: string) => path === record, lstat: () => ({isFile: true, size: 200, isSymbolicLink: false}), readBoundedFile: () => JSON.stringify({desktopPid: 52, sidecarPid: 53, port: 7777, sidecarPath: sidecar})};
    const exec = io.exec;
    io.exec = (cmd: string, argv: string[]) => cmd === '/usr/sbin/lsof' ? {status: 0, stdout: 'p53\nf8\n'} : exec(cmd, argv);
    const processes = (args: string, parent = 52) => f.processes(`52 1 Wed Oct 7 16:00:00 2026 ${APP_PATH}/Contents/MacOS/ashlr-desktop\n53 ${parent} Wed Oct 7 16:00:00 2026 ${args}`);
    processes(`${base} ${remote}`); expect(launchedAppIsOwned(io)).toBe(true);
    for (const args of [
      `${base} --remote-config /unrelated/verse-remote.json --desktop-token-handoff`,
      `${base} --remote-config ${HOME}/.ashlr/verse-remote.json`,
      `${base} --desktop-token-handoff`,
      `${base} --desktop-token-handoff --remote-config ${HOME}/.ashlr/verse-remote.json`,
      `${base} ${remote} extra`, `${base} ${remote} --desktop-token-handoff`,
    ]) {processes(args); expect(launchedAppIsOwned(io)).toBe(false);}
    processes(`${base} ${remote}`, 99); expect(launchedAppIsOwned(io)).toBe(false);
    processes(`${base} ${remote}`);
    io.exec = (cmd: string, argv: string[]) => cmd === '/usr/sbin/lsof' ? {status: 0, stdout: 'p99\n'} : exec(cmd, argv);
    expect(launchedAppIsOwned(io)).toBe(false);
  });
  it('requires actual lsof process/file records belonging only to the selected sidecar', () => {
    const f = appIo(); const record = `${HOME}/.ashlr/.desktop-sidecar.json`;
    const sidecar = `${APP_PATH}/Contents/MacOS/ashlr`;
    const io = {...f.io, exists: (path: string) => path === record, lstat: () => ({isFile: true, size: 200, isSymbolicLink: false}), readBoundedFile: () => JSON.stringify({desktopPid: 52, sidecarPid: 53, port: 7777, sidecarPath: sidecar})};
    f.processes(`52 1 Wed Oct 7 16:00:00 2026 ${APP_PATH}/Contents/MacOS/ashlr-desktop\n53 52 Wed Oct 7 16:00:00 2026 ${sidecar} verse --port 7777 --no-open --json`);
    const exec = io.exec;
    for (const stdout of ['p53\nf8\n', 'p53\nf8\nf9', 'p53\nf0\n']) {
      io.exec = (cmd: string, argv: string[]) => cmd === '/usr/sbin/lsof' ? {status: 0, stdout} : exec(cmd, argv);
      expect(launchedAppIsOwned(io)).toBe(true);
    }
    for (const stdout of ['', 'p53\n', 'p99\nf8\n', 'f8\np53\n', 'p53\nf8\np99\nf9\n', 'p53\nf8\np53\nf9\n', 'p53\nf8\nxunknown\n', 'p53\nf8\n\n', 'p53\n\nf8\n', 'p53\nfcwd\n', 'p53\nf8junk\n']) {
      io.exec = (cmd: string, argv: string[]) => cmd === '/usr/sbin/lsof' ? {status: 0, stdout} : exec(cmd, argv);
      expect(launchedAppIsOwned(io)).toBe(false);
    }
    io.exec = (cmd: string, argv: string[]) => cmd === '/usr/sbin/lsof' ? {status: 1, stdout: 'p53\nf8\n'} : exec(cmd, argv);
    expect(launchedAppIsOwned(io)).toBe(false);
  });
  it('installs from the verified native source when neither app exists', async () => {
    const f = appIo([]); const source = `${REPO}/${APP_BUNDLE_BUILD}`;
    f.bundles.set(source, {inventory: INVENTORY, ino: 2});
    const proof = inspectLocalApp(source, HASH, f.io);
    expect(await installLocalApp({...nativeInput(null), sourceProof: proof}, f.io)).toEqual({app: APP_PATH, rollbackArchive: null});
    expect(f.bundles.has(APP_PATH)).toBe(true);
  });
  it('switches the CLI pointer before launch and rolls it back on a settled failure', async () => {
    const f = appIo(); const selected = selectLocalApp(HASH, f.io); const events: string[] = [];
    const exec = f.io.exec;
    f.io.exec = (cmd: string, argv: string[]) => { if (cmd === '/usr/bin/open') events.push('open'); return exec(cmd, argv); };
    await expect(installLocalApp({...nativeInput(selected), commitPointer: async () => {events.push('pointer');}, rollbackPointer: async () => {events.push('restore-pointer');}, health: async () => false}, f.io)).rejects.toThrow(/health/);
    expect(events).toEqual(['pointer', 'open', 'restore-pointer']);
    expect(f.bundles.has(LEGACY_APP_PATH)).toBe(true);
  });
});

describe('local Workbench alias admission', () => {
  function aliasIo() {
    const entries = new Map<string, {target: string; dev: number; ino: number; isSymbolicLink: boolean}>();
    const target = `${HOME}/.local/share/ashlr/current/bin/ashlr`;
    let next = 10;
    const io = {home: HOME, validateLocalPath: () => {}, lstat: (path: string) => entries.get(path) ?? null, readLink: (path: string) => entries.get(path)?.target, linkTargetExists: () => true,
      createAlias: (path: string, dest: string) => {if (entries.has(path)) throw new Error('EEXIST'); entries.set(path, {target: dest, dev: 1, ino: next++, isSymbolicLink: true});},
      removeAlias: (path: string) => {entries.delete(path);}};
    return {entries, target, io};
  }
  it('creates only missing phm/ashlr links, preserves owned links and never selects phantom', () => {
    const f = aliasIo(); const existing = {target: f.target, dev: 1, ino: 2, isSymbolicLink: true};
    f.entries.set(`${HOME}/.local/bin/ashlr`, existing);
    f.entries.set(`${HOME}/.local/bin/phantom`, {target: '/secrets/phantom', dev: 1, ino: 3, isSymbolicLink: true});
    const created = createLocalAliases(inspectLocalAliases(f.io), f.io);
    expect(created.map(a => a.path)).toEqual([`${HOME}/.local/bin/phm`]);
    expect(f.entries.get(`${HOME}/.local/bin/ashlr`)).toBe(existing);
    expect(f.entries.get(`${HOME}/.local/bin/phantom`)?.target).toBe('/secrets/phantom');
    removeCreatedAliases(created, f.io);
    expect(f.entries.has(`${HOME}/.local/bin/phm`)).toBe(false);
    expect(f.entries.get(`${HOME}/.local/bin/ashlr`)).toBe(existing);
  });
  it('refuses foreign files, unrelated/dangling links and appearances after preflight', () => {
    for (const [symbolic, target, reachable] of [[false, '', true], [true, '/foreign/tool', true], [true, `${HOME}/.local/share/ashlr/current/bin/ashlr`, false]] as const) {
      const f = aliasIo(); f.entries.set(`${HOME}/.local/bin/phm`, {target, dev: 1, ino: 2, isSymbolicLink: symbolic});
      expect(() => inspectLocalAliases({...f.io, linkTargetExists: () => reachable})).toThrow(/owned, reachable/);
      expect(f.entries.has(`${HOME}/.local/bin/ashlr`)).toBe(false);
    }
    const f = aliasIo(); const plan = inspectLocalAliases(f.io);
    f.entries.set(plan[1]!.path, {target: '/foreign/tool', dev: 1, ino: 2, isSymbolicLink: true});
    expect(() => createLocalAliases(plan, f.io)).toThrow(/appeared/);
    expect(f.entries.has(plan[0]!.path)).toBe(false); // exclusive first create is rolled back
  });
  it('never deletes a created alias whose inode changed before rollback', () => {
    const f = aliasIo(); const created = createLocalAliases(inspectLocalAliases(f.io), f.io);
    f.entries.get(created[0]!.path)!.ino = 99;
    expect(() => removeCreatedAliases(created, f.io)).toThrow(/rollback held/);
    expect(f.entries.has(created[0]!.path)).toBe(true);
  });
});


describe('exact installer orchestration', () => {
  it('holds the entire transaction when a renamed current pointer cannot be verified', async () => {
    for (const failure of ['read', 'missing', 'cleanup'] as const) {
      const f = appIo(); const selected = selectLocalApp(HASH, f.io);
      const previous = {target: `${HOME}/.local/share/ashlr/releases/${SHA}`, dev: 1, ino: 85};
      const dest = `${HOME}/.local/share/ashlr/releases/${'f'.repeat(40)}`;
      const records: {phase: string; previousCurrent: unknown}[] = [];
      let renamed = false; let restored = false; let temporary = false;
      const io = {...f.io, readCurrentPointer: () => previous,
        switchCurrentPointer: (path: string, before: unknown, target: string) => switchLocalCurrentPointer(path, before, target, `${path}.temporary`, {
          readCurrentPointer: () => {if (!renamed) return previous; if (failure === 'missing') return null; if (failure === 'cleanup') return {...previous, target}; throw new Error('ownership read failed');},
          createLink: () => {temporary = true;}, rename: () => {renamed = true; temporary = false;}, exists: () => {if (renamed && failure === 'cleanup') throw new Error('cleanup read failed'); return temporary;}, unlink: () => {temporary = false;}}),
        restoreCurrentPointer: () => {restored = true;}, writeInstallJournal: (_dir: string, record: typeof records[number]) => {records.push(record);}};
      expect(await runSteps([{id: 'native-transaction', title: 'guarded migration', app: {...nativeInput(selected), current: `${HOME}/.local/share/ashlr/current`, dest, steps: []}}], io, {dryRun: false})).toBe(1);
      expect(renamed).toBe(true); expect(restored).toBe(false); expect(temporary).toBe(false);
      expect(records.at(-1)).toEqual(expect.objectContaining({phase: 'rollback-held', previousCurrent: previous}));
      expect(records.some(record => record.phase === 'rolled-back' || record.phase === 'accepted')).toBe(false);
      expect(f.bundles.has(APP_PATH)).toBe(true);
      expect(f.bundles.has('/Applications/.phantom-install-test/retired-bundle')).toBe(true);
      expect(f.bundles.has(LEGACY_APP_PATH)).toBe(false);
      expect(f.calls.some(call => call[0] === '/usr/bin/open')).toBe(false);
    }
  });
  it('passes actual source strings and immutable proofs for both existing and first native installs', async () => {
    for (const existing of [true, false]) {
      const proof = {path: existing ? APP_PATH : `${REPO}/${APP_BUNDLE_BUILD}`, signer: HASH, inventory: INVENTORY, dev: 1, ino: 2};
      const c = ctx(existing ? {} : {appExists: false, sourceApp: proof, native: true});
      const planned = step(planShip(c), 'native-transaction')!;
      expect(planned.app?.source).toBe(proof.path);
      expect(planned.app?.sourceProof).toEqual(proof);
      const f = fakeIo({exists: (path: string) => existing ? path === APP_PATH || path.endsWith('.desktop-sidecar.json') : path.endsWith('.desktop-sidecar.json')});
      // Prelaunch record is absent; a real record appears only after the injected open.
      f.io.exists = (path: string) => path === APP_PATH && existing || path.endsWith('.desktop-sidecar.json') && f.calls.some(call => call[0] === '/usr/bin/open');
      expect(await runSteps(planShip(c), f.io, {dryRun: false}), f.logs.join('\n')).toBe(0);
      const copied = f.calls.find(call => call[0] === '/usr/bin/ditto' && call.length === 3)!;
      expect(copied).toEqual(['/usr/bin/ditto', proof.path, '/Applications/.phantom-install-fixture/Phantom.app']);
      expect(f.calls.every(call => call.every(value => typeof value === 'string'))).toBe(true);
    }
  });
  it('records the actual previous current target/identity in the held recovery journal', async () => {
    const f = appIo(); const selected = selectLocalApp(HASH, f.io); const previous = {target: `${HOME}/.local/share/ashlr/releases/${SHA}`, dev: 1, ino: 85}; const records: unknown[] = [];
    await installLocalApp({...nativeInput(selected), previousCurrent: previous}, {...f.io, writeInstallJournal: (_dir: string, record: unknown) => {records.push(record);}});
    expect(records).toEqual(expect.arrayContaining([expect.objectContaining({phase: 'accepted', previousCurrent: previous})]));
  });
  it('preserves an unknown destination appearing immediately before the exclusive switch', async () => {
    const f = appIo(); const selected = selectLocalApp(HASH, f.io);
    const unknown = {inventory: 'b'.repeat(64), ino: 99};
    const io = {...f.io, writeInstallJournal: (_dir: string, record: {phase: string}) => {if (record.phase === 'verified') f.bundles.set(APP_PATH, unknown);}};
    await expect(installLocalApp(nativeInput(selected), io)).rejects.toThrow(/exclusive/);
    expect(f.bundles.get(APP_PATH)).toBe(unknown);
    expect(f.bundles.get(LEGACY_APP_PATH)?.inventory).toBe(INVENTORY);
    expect(f.calls.some(call => call[0] === '/usr/bin/open')).toBe(false);
  });
  it('holds rollback if replacement identity changed instead of moving unrelated code', async () => {
    const f = appIo(); const selected = selectLocalApp(HASH, f.io);
    const phases: string[] = [];
    await expect(installLocalApp({...nativeInput(selected), health: async () => {f.bundles.get(APP_PATH)!.ino = 99; return false;}}, {...f.io, writeInstallJournal: (_dir: string, record: {phase: string}) => {phases.push(record.phase);}})).rejects.toThrow(/identity changed/);
    expect(f.bundles.get(APP_PATH)?.ino).toBe(99);
    expect(f.bundles.has('/Applications/.phantom-install-test/retired-bundle')).toBe(true);
    expect(phases.at(-1)).toBe('rollback-held');
  });
  it('accepts only supported owned current release names; never escaping or unrelated targets', () => {
    const target = `${HOME}/.local/share/ashlr/releases/${SHA}`;
    expect(ownedReleaseTarget(HOME, target)).toBe(target);
    expect(ownedReleaseTarget(HOME, `${target}-dirty-20261007-180000`)).toBe(`${target}-dirty-20261007-180000`);
    for (const value of ['/foreign/release', `${target}/../foreign`, `${HOME}/.local/share/ashlr/releases/latest`, `${target}/nested`]) expect(() => ownedReleaseTarget(HOME, value)).toThrow(/supported owned/);
  });
});

describe.skipIf(process.platform !== 'darwin')('real macOS exclusive rename in private scratch only', () => {
  it('never nests into or replaces an existing destination and refuses changed source identity', () => {
    exclusiveRenameAvailable();
    const root = mkdtempSync(join(tmpdir(), 'phantom-exclusive-rename-'));
    try {
      const source = join(root, 'source'); const target = join(root, 'target');
      mkdirSync(source); mkdirSync(target); writeFileSync(join(source, 'owned'), 'original'); writeFileSync(join(target, 'foreign'), 'preserve');
      const proof = lstatSync(source);
      expect(() => renamePathExclusive(source, target, proof)).toThrow(/exclusive move refused/);
      expect(existsSync(join(source, 'owned'))).toBe(true);
      expect(existsSync(join(target, 'foreign'))).toBe(true);
      expect(existsSync(join(target, 'source'))).toBe(false);
      rmSync(target, {recursive: true});
      expect(() => renamePathExclusive(source, target, {...proof, ino: proof.ino + 1})).toThrow(/exclusive move refused/);
      expect(existsSync(source)).toBe(true);
      renamePathExclusive(source, target, proof);
      expect(existsSync(source)).toBe(false);
      expect(lstatSync(target).ino).toBe(proof.ino);
      renamePathExclusive(target, source, lstatSync(target));
      expect(existsSync(join(source, 'owned'))).toBe(true);
    } finally {rmSync(root, {recursive: true, force: true});}
  });
});


describe('current release pointer observation', () => {
  it('distinguishes initial absence from missing package/launcher or a disappearing present pointer', () => {
    const path = `${HOME}/.local/share/ashlr/current`; const target = `${HOME}/.local/share/ashlr/releases/${SHA}`;
    const stat = {dev: 1, ino: 80, ctimeMs: 10, birthtimeMs: 1, isSymbolicLink: true};
    const io = {home: HOME, repoRoot: REPO, validateLocalPath: () => {}, lstat: () => stat as typeof stat | null,
      readLink: () => target, readBoundedFile: (file: string) => file.endsWith('package.json') ? JSON.stringify({name: '@ashlr/hub', version: '3.25.0'}) : 'canonical launcher'};
    expect(inspectCurrentPointer(path, {...io, lstat: () => null})).toBeNull();
    expect(inspectCurrentPointer(path, io)).toEqual({target, dev: 1, ino: 80, ctimeMs: 10, birthtimeMs: 1});
    for (const name of ['@ashlr/hub', '@ashlr/phantom']) expect(inspectCurrentPointer(path, {...io, readBoundedFile: (file: string) => file.endsWith('package.json') ? JSON.stringify({name, version: '3.25.0'}) : io.readBoundedFile(file)})).toEqual({target, dev: 1, ino: 80, ctimeMs: 10, birthtimeMs: 1});
    for (const name of ['@other/phantom', '@ashlr/phantom-beta', 'ashlr']) expect(() => inspectCurrentPointer(path, {...io, readBoundedFile: (file: string) => file.endsWith('package.json') ? JSON.stringify({name, version: '3.25.0'}) : io.readBoundedFile(file)})).toThrow(/present current release/);
    for (const suffix of ['package.json', '/bin/ashlr']) {
      expect(() => inspectCurrentPointer(path, {...io, readBoundedFile: (file: string) => {
        if (file.startsWith(target) && file.endsWith(suffix)) throw Object.assign(new Error('missing'), {code: 'ENOENT'});
        return io.readBoundedFile(file);
      }})).toThrow(/present current release/);
    }
    let reads = 0;
    expect(() => inspectCurrentPointer(path, {...io, lstat: () => ++reads === 1 ? stat : null})).toThrow(/present current release/);
    expect(() => inspectCurrentPointer(path, {...io, readLink: () => {throw Object.assign(new Error('missing'), {code: 'ENOENT'});}})).toThrow(/present current release/);
    expect(() => inspectCurrentPointer(path, {...io, readBoundedFile: (file: string) => file === `${target}/bin/ashlr` ? 'foreign launcher' : io.readBoundedFile(file)})).toThrow(/present current release/);
    expect(() => inspectCurrentPointer(path, {...io, lstat: () => ({...stat, isSymbolicLink: false})})).toThrow(/present current release/);
  });
});
