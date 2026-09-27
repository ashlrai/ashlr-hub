/**
 * scripts/ship-local.mjs — planning logic only.
 *
 * Every machine fact comes from an injected io, so nothing here reads or writes the real
 * ~/.local, /Applications or launchd, and no command is executed: the fake io records calls.
 */
import { describe, expect, it } from 'vitest';
import {
  APP_PATH,
  ENTITLEMENTS,
  KEEP_BACKUPS,
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
type Step = { id: string; title: string; argv?: string[]; wait?: { kind: string }; versions?: unknown; identity?: string; sign?: { identity: string | null; entitlements: string } };
const HASH = 'F6674FDA4EDE6D75028DA2165382E629553DD6D6';

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
      'Contents/Resources': [{ name: 'public', mtimeMs: 10 }, { name: 'icon.icns', mtimeMs: 10 }],
    } as Record<string, Entry[]>,
    loadedAgents: ['ai.ashlr.anthropic-proxy', 'ai.ashlr.serve'],
    signing: { hash: HASH, name: 'Ashlr Local', valid: true } as { hash: string; name: string; valid: boolean } | null,
    nativeBuildMtime: null as number | null,
    installedNativeMtime: 10 as number | null,
    iconBuildMtime: null as number | null,
    installedIconMtime: 10 as number | null,
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
      'plist-mic', 'codesign', 'codesign-verify', 'app-launch',
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
    // Quit before touching the bundle; sign after the last copy; relaunch last.
    const order = ids(steps);
    expect(order.indexOf('app-wait-quit')).toBeLessThan(order.indexOf('backup-ashlr'));
    expect(order.indexOf('install-public')).toBeLessThan(order.indexOf('codesign'));
    // The plist is part of what gets signed.
    expect(order.indexOf('plist-mic')).toBeLessThan(order.indexOf('codesign'));
    expect(ids(steps)).not.toContain('signing-identity');
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
        if (cmd === 'security') return { status: 0, stdout: `  1) ${HASH} "Ashlr Local"\n     1 identities found\n` };
        return { status: argv[1]?.endsWith('ai.ashlr.serve') ? 0 : 113, stdout: '' };
      },
    });
    const c = gatherContext({ dryRun: true, native: false, allowDirty: false }, io);
    expect(c).toMatchObject({ dirty: true, sha: SHA, version: '3.11.1', appExists: true, loadedAgents: ['ai.ashlr.serve'] });
    expect(c.signing).toEqual({ hash: HASH, name: 'Ashlr Local', valid: true });
    expect(calls.map((c) => c[0])).toEqual(['git', 'git', 'security', 'launchctl', 'launchctl']);
    expect(calls.find((c) => c[0] === 'security')).toEqual(['security', 'find-identity', '-p', 'codesigning']);
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

  it('plans the one-time identity step before signing when there is no trusted identity', () => {
    for (const signing of [null, { hash: HASH, name: 'Ashlr Local', valid: false }]) {
      const steps = planShip(ctx({ signing })) as Step[];
      const order = ids(steps);
      expect(order.indexOf('signing-identity')).toBeGreaterThan(-1);
      expect(order.indexOf('signing-identity')).toBeLessThan(order.indexOf('codesign'));
      expect(step(steps, 'codesign')?.sign).toEqual({ identity: null, entitlements: `${REPO}/${ENTITLEMENTS}` });
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

  it('runSteps signs with the freshly made identity, or ad-hoc with a loud warning', async () => {
    for (const makes of [true, false]) {
      let trusted = false;
      const { io: base, calls } = fakeIo();
      const logs: string[] = [];
      const io = {
        ...base,
        log: (line: string) => logs.push(line),
        mkdtemp: () => '/os-tmp/ashlr-sign-1',
        writeFile: () => {},
        removeDir: () => {},
        exec: (cmd: string, argv: string[]) => {
          calls.push([cmd, ...argv]);
          if (argv[0] === 'find-identity') return { status: 0, stdout: trusted ? `  1) ${HASH} "Ashlr Local"\n` : '' };
          if (argv[0] === 'add-trusted-cert') {
            trusted = makes;
            return { status: makes ? 0 : 1, stdout: '' };
          }
          return base.exec(cmd, argv);
        },
      };
      const steps = planShip(ctx({ signing: null })) as Step[];
      calls.length = 0;
      expect(await runSteps(steps, io, { dryRun: false })).toBe(0);
      const sign = calls.find((c) => c[0] === 'codesign' && c[1] === '--force')!;
      expect(sign[4]).toBe(makes ? HASH : '-');
      expect(sign).toContain('--entitlements');
      if (!makes) expect(logs.join('\n')).toMatch(/WARNING — signing ad-hoc/);
    }
  });
});
