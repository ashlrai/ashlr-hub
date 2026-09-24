/**
 * `ashlr resources profile repin` — re-point an existing prepared native profile
 * at a different executable. Private temp profiles, a temp HOME and inert native
 * executables only: nothing here signs in, contacts a provider or runs a model.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import {
  chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { cmdResources } from '../src/cli/resources.js';
import {
  prepareResourceNativeProfile, repinResourceNativeProfile, RESOURCE_NATIVE_PROFILE_MANIFEST_KEYS, ResourceNativeProfileRepinError,
  type ResourceNativeProfile, type ResourceNativeProfileRepinOptions,
} from '../src/core/resources/native-profile.js';

// Mockable fs primitives for fault injection. Faults are installed with
// mockImplementation on these vi.fn()s and always passed through to the REAL
// functions (never to the mock itself, which would recurse), then reset to the
// real implementation after every test so no fault can leak into the next one.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeSync: vi.fn(actual.writeSync), renameSync: vi.fn(actual.renameSync) };
});
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
function stopFaults(): void {
  vi.mocked(fs.writeSync).mockImplementation(actualFs.writeSync);
  vi.mocked(fs.renameSync).mockImplementation(actualFs.renameSync);
}

type Provider = 'codex' | 'claude' | 'grok';
const CODEX_FIXED = ['-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"'];

let base: string; let home: string; let oldBinary: string; let newBinary: string; let thirdBinary: string;

/** An inert "native CLI" that only reports which file ran, with what argv and environment. */
function inertBinary(name: string): string {
  const file = join(base, name);
  writeFileSync(file, `#!${realpathSync(process.execPath)}\nconsole.log(JSON.stringify({binary:${JSON.stringify(name)},args:process.argv.slice(2),env:process.env}));\n`,
    { mode: 0o700 });
  return file;
}
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'native-profile-repin-')));
  // HOME isolation: repin must never touch the home directory at all; every
  // test that mutates asserts this temp HOME is still empty afterwards.
  home = join(base, 'home'); mkdirSync(home, { mode: 0o700 });
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home); vi.stubEnv('ASHLR_HOME', join(home, '.ashlr'));
  oldBinary = inertBinary('native-old'); newBinary = inertBinary('native-new'); thirdBinary = inertBinary('native-third');
});
afterEach(() => { stopFaults(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }); });

function prepared(provider: Provider = 'claude', name = `${provider}-a`): ResourceNativeProfile {
  return prepareResourceNativeProfile({ provider, directory: join(base, name), executable: oldBinary });
}
function repin(profile: ResourceNativeProfile, executable: string, extra: Partial<ResourceNativeProfileRepinOptions> = {}) {
  return repinResourceNativeProfile({ directory: profile.directory, executable, ...extra });
}
/** Byte-and-mode snapshot of a tree, used to prove a refusal wrote nothing. */
function tree(path: string): unknown {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return { link: fs.readlinkSync(path) };
  return stat.isDirectory() ? { mode: stat.mode, ino: stat.ino, entries: readdirSync(path).sort().map((name) => [name, tree(join(path, name))]) }
    : { mode: stat.mode, ino: stat.ino, nlink: stat.nlink, bytes: readFileSync(path).toString('base64') };
}
/** Run the profile's generated launcher the way a seat would, and report which inert binary it exec'd. */
function launch(profile: ResourceNativeProfile, args: string[] = ['--help']): { binary: string; args: string[]; env: Record<string, string> } {
  return JSON.parse(execFileSync(profile.command[0]!, [...profile.command.slice(1), ...args], { encoding: 'utf8', timeout: 5000,
    env: { PATH: process.env.PATH, HOME: home, LANG: 'C', ANTHROPIC_API_KEY: 'fixture-not-passed', OPENAI_API_KEY: 'fixture-not-passed' } }));
}
function expectRefusal(action: () => unknown, failure: ResourceNativeProfileRepinError['failure']): ResourceNativeProfileRepinError {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ResourceNativeProfileRepinError);
  const error = caught as ResourceNativeProfileRepinError;
  expect(error.failure).toBe(failure);
  // Fixed text only: never a private path or an OS error string.
  expect(error.message).not.toContain(base); expect(error.message).not.toMatch(/ENOENT|EACCES|EEXIST|errno/);
  return error;
}
function leftoverTemps(profile: ResourceNativeProfile): string[] { return readdirSync(profile.directory).filter((name) => name.endsWith('.repin-tmp')); }
function editInPlace(file: string, edit: (text: string) => string): void {
  // writeFileSync on an existing path keeps the inode, mode and link count, so only the content changes.
  writeFileSync(file, edit(readFileSync(file, 'utf8')));
}

describe.skipIf(process.platform === 'win32' || typeof process.execve !== 'function')('native profile repin', () => {
  it('pins prepare\'s manifest shape to the key list repin validates, so the two cannot drift silently', () => {
    for (const provider of ['codex', 'claude', 'grok'] as const) {
      const profile = prepared(provider);
      expect(Object.keys(JSON.parse(readFileSync(profile.manifestPath, 'utf8')))).toEqual([...RESOURCE_NATIVE_PROFILE_MANIFEST_KEYS]);
    }
  });

  it.each(['codex', 'claude', 'grok'] as const)('re-points a %s launcher at the new executable and changes nothing else', (provider) => {
    const profile = prepared(provider);
    const before = { launcher: readFileSync(profile.launcherPath, 'utf8'), manifest: readFileSync(profile.manifestPath, 'utf8'),
      command: readFileSync(profile.commandPath, 'utf8') };
    const directoryIno = lstatSync(profile.directory).ino; const stateTree = tree(profile.nativeStatePath);
    const ranBefore = launch(profile);
    expect(ranBefore.binary).toBe('native-old');

    const report = repin(profile, newBinary);
    expect(report).toEqual({
      schemaVersion: 1, scope: 'native-profile-repin', status: 'repinned', authentication: 'not-checked', provider, directory: profile.directory,
      previousExecutable: oldBinary, executable: newBinary, launcherPath: profile.launcherPath, manifestPath: profile.manifestPath,
      commandPath: profile.commandPath, resumed: false,
      backups: { launcherPath: `${profile.launcherPath}.prev`, manifestPath: `${profile.manifestPath}.prev`, commandPath: `${profile.commandPath}.prev` },
    });

    // The launcher now execs the new file, with the SAME fixed argv and pinned environment.
    const ranAfter = launch(profile);
    expect(ranAfter.binary).toBe('native-new');
    expect(ranAfter.args).toEqual(ranBefore.args);
    expect(ranAfter.args).toEqual(provider === 'codex' ? [...CODEX_FIXED, '--help'] : ['--help']);
    for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_CONFIG_DIR', 'GROK_HOME', 'DISABLE_UPDATES']) expect(ranAfter.env[key]).toBe(ranBefore.env[key]);
    expect(ranAfter.env).not.toHaveProperty('ANTHROPIC_API_KEY'); expect(ranAfter.env).not.toHaveProperty('OPENAI_API_KEY');

    // launcher.mjs: exactly one line differs, and only by the executable.
    const launcherAfter = readFileSync(profile.launcherPath, 'utf8');
    const beforeLines = before.launcher.split('\n'); const afterLines = launcherAfter.split('\n');
    expect(afterLines).toHaveLength(beforeLines.length);
    const changed = afterLines.flatMap((line, index) => line === beforeLines[index] ? [] : [index]);
    expect(changed).toHaveLength(1);
    expect(afterLines[changed[0]!]).toBe(beforeLines[changed[0]!]!.replace(JSON.stringify(oldBinary), JSON.stringify(newBinary)));
    // profile.json: the same document with only `executable` replaced, still rendered exactly as prepare renders it.
    const manifestAfter = readFileSync(profile.manifestPath, 'utf8');
    expect(manifestAfter).toBe(`${JSON.stringify({ ...JSON.parse(before.manifest), executable: newBinary }, null, 2)}\n`);
    expect(JSON.parse(manifestAfter)).toEqual({ ...profile, executable: newBinary });
    // command.json names node + launcher, never the native executable: byte-identical.
    expect(readFileSync(profile.commandPath, 'utf8')).toBe(before.command);

    // Backups are exact copies of the previous triple, private, and never hard links.
    expect(readFileSync(`${profile.launcherPath}.prev`, 'utf8')).toBe(before.launcher);
    expect(readFileSync(`${profile.manifestPath}.prev`, 'utf8')).toBe(before.manifest);
    expect(readFileSync(`${profile.commandPath}.prev`, 'utf8')).toBe(before.command);
    for (const file of [profile.launcherPath, profile.manifestPath, profile.commandPath, ...Object.values(report.backups!)]) {
      const stat = lstatSync(file); expect(stat.mode & 0o777).toBe(0o600); expect(stat.nlink).toBe(1); expect(stat.isFile()).toBe(true);
    }
    expect(readdirSync(profile.directory).sort()).toEqual([...(provider === 'claude' ? ['anthropic-state'] : []), 'command.json', 'command.json.prev',
      'launcher.mjs', 'launcher.mjs.prev', 'native-state', 'profile.json', 'profile.json.prev']);
    expect(lstatSync(profile.directory).ino).toBe(directoryIno);
    expect(tree(profile.nativeStatePath)).toEqual(stateTree);
    expect(readdirSync(home)).toEqual([]);
  });

  it('dry run validates and reports the change without writing a byte', () => {
    const profile = prepared(); const before = tree(profile.directory);
    const report = repin(profile, newBinary, { dryRun: true });
    expect(report).toMatchObject({ status: 'would-repin', previousExecutable: oldBinary, executable: newBinary, backups: null, resumed: false });
    expect(tree(profile.directory)).toEqual(before);
    expect(launch(profile).binary).toBe('native-old');
  });

  it('is idempotent: repinning to the current executable writes nothing, not even backups', () => {
    const profile = prepared(); const before = tree(profile.directory);
    expect(repin(profile, oldBinary)).toMatchObject({ status: 'unchanged', previousExecutable: oldBinary, executable: oldBinary, backups: null });
    expect(repin(profile, oldBinary, { dryRun: true })).toMatchObject({ status: 'unchanged', backups: null });
    expect(tree(profile.directory)).toEqual(before);
    repin(profile, newBinary); const repinned = tree(profile.directory);
    expect(repin(profile, newBinary)).toMatchObject({ status: 'unchanged', previousExecutable: newBinary, executable: newBinary });
    expect(tree(profile.directory)).toEqual(repinned);
  });

  it('a second repin replaces the backups with the state it moved away from, and can move back', () => {
    const profile = prepared('codex'); const original = readFileSync(profile.launcherPath, 'utf8');
    repin(profile, newBinary); const intermediate = { launcher: readFileSync(profile.launcherPath, 'utf8'), manifest: readFileSync(profile.manifestPath, 'utf8') };
    expect(repin(profile, oldBinary)).toMatchObject({ status: 'repinned', previousExecutable: newBinary, executable: oldBinary });
    expect(readFileSync(`${profile.launcherPath}.prev`, 'utf8')).toBe(intermediate.launcher);
    expect(readFileSync(`${profile.manifestPath}.prev`, 'utf8')).toBe(intermediate.manifest);
    // Moving back restores the originally generated bytes exactly.
    expect(readFileSync(profile.launcherPath, 'utf8')).toBe(original);
    expect(launch(profile).binary).toBe('native-old');
  });

  it('preserves an older launcher template byte-for-byte instead of regenerating it', () => {
    // The live claude-a profile predates the Grok branch in the template. Repin
    // must move its pin without "upgrading" any other line of operator-owned code.
    const profile = prepared('claude');
    editInPlace(profile.launcherPath, (text) => text.replace(
      /\}else if\(profile\.provider==='grok'\)\{\n {4}\/\/ The caller supplies --no-auto-update for login\/metadata; do not duplicate it\.\n {4}env\.GROK_HOME=profile\.nativeStatePath;\n/, '}else{\n')
      .replace("  }else{\n  }else{\n", '  }else{\n'));
    const olderTemplate = readFileSync(profile.launcherPath, 'utf8');
    expect(olderTemplate).not.toContain('GROK_HOME'); expect(launch(profile).binary).toBe('native-old');
    repin(profile, newBinary);
    expect(readFileSync(profile.launcherPath, 'utf8')).toBe(olderTemplate.replace(JSON.stringify(oldBinary), JSON.stringify(newBinary)));
    expect(launch(profile).binary).toBe('native-new');
  });

  describe('refuses before writing anything', () => {
    it.each(['missing', 'symlink', 'not-executable', 'group-writable', 'directory'] as const)('a %s executable', (kind) => {
      const profile = prepared(); const before = tree(profile.directory);
      const target = join(base, `target-${kind}`);
      if (kind === 'symlink') symlinkSync(newBinary, target);
      if (kind === 'not-executable') writeFileSync(target, '#!/bin/sh\n', { mode: 0o600 });
      if (kind === 'group-writable') { writeFileSync(target, '#!/bin/sh\n', { mode: 0o700 }); chmodSync(target, 0o720); }
      if (kind === 'directory') mkdirSync(target, { mode: 0o700 });
      expectRefusal(() => repin(profile, target), 'invalid');
      expect(tree(profile.directory)).toEqual(before);
    });

    it.each(['relative', 'noncanonical', 'control', 'root', 'extra', 'provider', 'accessor', 'dry-run-type', 'missing-executable', 'array'] as const)(
      'malformed %s options without invoking accessors', (kind) => {
        const profile = prepared(); const before = tree(base);
        const valid = { directory: profile.directory, executable: newBinary };
        const options: unknown = kind === 'relative' ? { ...valid, directory: 'claude-a' }
          : kind === 'noncanonical' ? { ...valid, directory: `${base}/../${profile.directory}` }
            : kind === 'control' ? { ...valid, executable: `${newBinary}\n` }
              : kind === 'root' ? { ...valid, directory: '/' }
                : kind === 'extra' ? { ...valid, credentials: 'must-not-read' }
                  : kind === 'provider' ? { ...valid, provider: 'codex' }
                    : kind === 'accessor' ? Object.defineProperty({ ...valid }, 'executable', { enumerable: true, get() { throw new Error('must not invoke'); } })
                      : kind === 'dry-run-type' ? { ...valid, dryRun: 'yes' }
                        : kind === 'missing-executable' ? { directory: profile.directory } : [valid];
        expectRefusal(() => repinResourceNativeProfile(options as ResourceNativeProfileRepinOptions), 'invalid');
        expect(tree(base)).toEqual(before);
      });

    it.each(['missing', 'public', 'symlink', 'public-parent', 'not-a-profile'] as const)('a %s profile directory', (kind) => {
      const profile = prepared(); let directory = profile.directory;
      if (kind === 'missing') directory = join(base, 'never-prepared');
      if (kind === 'public') chmodSync(profile.directory, 0o755);
      if (kind === 'symlink') { directory = join(base, 'linked-profile'); symlinkSync(profile.directory, directory); }
      if (kind === 'public-parent') chmodSync(base, 0o755);
      if (kind === 'not-a-profile') { directory = join(base, 'empty-private'); mkdirSync(directory, { mode: 0o700 }); }
      try {
        const before = tree(profile.directory);
        expectRefusal(() => repinResourceNativeProfile({ directory, executable: newBinary }), 'invalid');
        expect(tree(profile.directory)).toEqual(before);
      } finally { chmodSync(base, 0o700); chmodSync(profile.directory, 0o700); }
    });

    it.each(['launcher-mode', 'launcher-hardlink', 'manifest-symlink', 'command-missing', 'manifest-oversized'] as const)('an unsafe profile file (%s)', (kind) => {
      const profile = prepared();
      if (kind === 'launcher-mode') chmodSync(profile.launcherPath, 0o644);
      if (kind === 'launcher-hardlink') linkSync(profile.launcherPath, join(base, 'second-name'));
      if (kind === 'manifest-symlink') {
        const moved = join(base, 'moved-profile.json'); renameSync(profile.manifestPath, moved); symlinkSync(moved, profile.manifestPath);
      }
      if (kind === 'command-missing') rmSync(profile.commandPath);
      if (kind === 'manifest-oversized') editInPlace(profile.manifestPath, (text) => text + ' '.repeat(70 * 1024));
      const before = tree(profile.directory);
      expectRefusal(() => repin(profile, newBinary), 'invalid');
      expect(tree(profile.directory)).toEqual(before);
    });

    it.each(['.prev symlink', '.prev directory', '.prev hard link'] as const)('an existing backup slot that a rename should not replace (%s)', (kind) => {
      const profile = prepared(); const slot = `${profile.manifestPath}.prev`;
      if (kind === '.prev symlink') symlinkSync(join(base, 'elsewhere'), slot);
      if (kind === '.prev directory') mkdirSync(slot, { mode: 0o700 });
      if (kind === '.prev hard link') { writeFileSync(slot, 'kept', { mode: 0o600 }); linkSync(slot, join(base, 'other-name')); }
      const before = tree(profile.directory);
      expectRefusal(() => repin(profile, newBinary), 'invalid');
      expectRefusal(() => repin(profile, newBinary, { dryRun: true }), 'invalid');
      expect(tree(profile.directory)).toEqual(before);
    });

    const tamper: Record<string, (profile: ResourceNativeProfile) => void> = {
      'reformatted profile.json': (profile) => editInPlace(profile.manifestPath, (text) => `${JSON.stringify(JSON.parse(text))}\n`),
      'extra profile.json key': (profile) => editInPlace(profile.manifestPath, (text) => `${JSON.stringify({ ...JSON.parse(text), note: 'x' }, null, 2)}\n`),
      'provider changed in profile.json': (profile) => editInPlace(profile.manifestPath, (text) => text.replace('"provider": "claude"', '"provider": "codex"')),
      'status changed in profile.json': (profile) => editInPlace(profile.manifestPath, (text) => text.replace('"status": "prepared"', '"status": "repinned"')),
      'command.json disagrees': (profile) => editInPlace(profile.commandPath, (text) => text.replace('launcher.mjs', 'other.mjs')),
      'launcher header edited': (profile) => editInPlace(profile.launcherPath, (text) => text.replace('// Generated private', '// Edited private')),
      'launcher profile line reformatted': (profile) => editInPlace(profile.launcherPath, (text) => text.replace('const profile={"provider"', 'const profile={ "provider"')),
      'launcher profile line duplicated': (profile) => editInPlace(profile.launcherPath, (text) => text.replace(/^(const profile=.*)$/m, '$1\n$1')),
      'launcher points at another state dir': (profile) => editInPlace(profile.launcherPath, (text) => text.replace('"nativeStatePath":"', '"nativeStatePath":"/elsewhere')),
      'hand-repinned launcher (executables disagree)': (profile) => editInPlace(profile.launcherPath, (text) => text.replace(JSON.stringify(oldBinary), JSON.stringify(thirdBinary))),
      'native-state recreated (launcher would refuse to run)': (profile) => { rmSync(profile.nativeStatePath, { recursive: true }); mkdirSync(profile.nativeStatePath, { mode: 0o700 }); },
    };
    it.each(Object.keys(tamper))('a profile that is not prepare\'s unmodified output: %s', (kind) => {
      const profile = prepared(); tamper[kind]!(profile); const before = tree(profile.directory);
      expectRefusal(() => repin(profile, newBinary), 'inconsistent');
      expectRefusal(() => repin(profile, newBinary, { dryRun: true }), 'inconsistent');
      expect(tree(profile.directory)).toEqual(before);
    });

    it('a profile directory moved away from the path it was prepared at', () => {
      const profile = prepared(); const moved = join(base, 'moved'); renameSync(profile.directory, moved); const before = tree(moved);
      expectRefusal(() => repinResourceNativeProfile({ directory: moved, executable: newBinary }), 'inconsistent');
      expect(tree(moved)).toEqual(before);
    });
  });

  describe('failure and recovery', () => {
    const failNthCall = (method: 'writeSync' | 'renameSync', n: number): void => {
      const real = actualFs[method] as (...args: unknown[]) => unknown; let calls = 0;
      vi.mocked(fs[method]).mockImplementation(((...args: unknown[]) => {
        calls += 1; if (calls === n) throw new Error(`private-error:${base}`);
        return Reflect.apply(real, actualFs, args);
      }) as never);
    };

    it('a write failure before the launcher moves leaves the profile running its previous executable', () => {
      const profile = prepared(); const launcher = readFileSync(profile.launcherPath); const manifest = readFileSync(profile.manifestPath);
      failNthCall('writeSync', 1);
      expectRefusal(() => repin(profile, newBinary), 'failed-unchanged');
      stopFaults();
      expect(readFileSync(profile.launcherPath)).toEqual(launcher); expect(readFileSync(profile.manifestPath)).toEqual(manifest);
      expect(leftoverTemps(profile)).toEqual([]);
      expect(launch(profile).binary).toBe('native-old');
      // Nothing is wedged: the same repin simply succeeds next time.
      expect(repin(profile, newBinary).status).toBe('repinned'); expect(launch(profile).binary).toBe('native-new');
    });

    it('refuses to publish over a launcher that changed after it was validated', () => {
      const profile = prepared();
      // The 4th write is the new launcher's temp file (after the three backups):
      // an owner edit lands in launcher.mjs just before its rename.
      let calls = 0;
      vi.mocked(fs.writeSync).mockImplementation(((...args: Parameters<typeof fs.writeSync>) => {
        calls += 1; if (calls === 4) actualFs.appendFileSync(profile.launcherPath, '// concurrent owner edit\n');
        return Reflect.apply(actualFs.writeSync, actualFs, args);
      }) as typeof fs.writeSync);
      expectRefusal(() => repin(profile, newBinary), 'failed-unchanged');
      stopFaults();
      expect(readFileSync(profile.launcherPath, 'utf8')).toMatch(/\/\/ concurrent owner edit\n$/);
      expect(readFileSync(profile.launcherPath, 'utf8')).toContain(JSON.stringify(oldBinary));
      expect(leftoverTemps(profile)).toEqual([]);
    });

    it('an interruption between the launcher and profile.json is finished by rerunning the same repin', () => {
      const profile = prepared('claude');
      const original = { launcher: readFileSync(profile.launcherPath, 'utf8'), manifest: readFileSync(profile.manifestPath, 'utf8'),
        command: readFileSync(profile.commandPath, 'utf8') };
      // Renames: 3 backups, then launcher.mjs, then profile.json — fail the 5th.
      failNthCall('renameSync', 5);
      expectRefusal(() => repin(profile, newBinary), 'failed-partial');
      stopFaults();
      expect(leftoverTemps(profile)).toEqual([]);
      // Torn but safe: the launcher (what actually runs) already moved; the manifest has not.
      expect(launch(profile).binary).toBe('native-new');
      expect(readFileSync(profile.manifestPath, 'utf8')).toBe(original.manifest);

      // Moving somewhere else from a torn state is refused rather than guessed.
      expectRefusal(() => repin(profile, thirdBinary), 'inconsistent');
      expect(repin(profile, newBinary, { dryRun: true })).toMatchObject({ status: 'would-repin', resumed: true, backups: null });

      const finished = repin(profile, newBinary);
      expect(finished).toMatchObject({ status: 'repinned', resumed: true, previousExecutable: oldBinary, executable: newBinary });
      expect(readFileSync(profile.manifestPath, 'utf8')).toBe(`${JSON.stringify({ ...JSON.parse(original.manifest), executable: newBinary }, null, 2)}\n`);
      // The backups still hold the true pre-repin triple, not the torn state.
      expect(readFileSync(`${profile.launcherPath}.prev`, 'utf8')).toBe(original.launcher);
      expect(readFileSync(`${profile.manifestPath}.prev`, 'utf8')).toBe(original.manifest);
      expect(readFileSync(`${profile.commandPath}.prev`, 'utf8')).toBe(original.command);
      expect(repin(profile, newBinary).status).toBe('unchanged');
      expect(readdirSync(home)).toEqual([]);
    });

    it('does not "finish" a torn state whose backups do not prove it', () => {
      const profile = prepared();
      failNthCall('renameSync', 5); expectRefusal(() => repin(profile, newBinary), 'failed-partial'); stopFaults();
      editInPlace(`${profile.manifestPath}.prev`, (text) => text.replace('"status": "prepared"', '"status": "edited"'));
      const before = tree(profile.directory);
      expectRefusal(() => repin(profile, newBinary), 'inconsistent');
      expect(tree(profile.directory)).toEqual(before);
    });
  });

  describe('CLI: ashlr resources profile repin', () => {
    let out: MockInstance<typeof console.log>; let err: MockInstance<typeof console.error>;
    beforeEach(() => { out = vi.spyOn(console, 'log').mockImplementation(() => {}); err = vi.spyOn(console, 'error').mockImplementation(() => {}); });
    const printed = (): string => out.mock.calls.map((call) => String(call[0])).join('\n');

    it('repins with --json and reports the backups', async () => {
      const profile = prepared('grok');
      expect(await cmdResources(['profile', 'repin', '--directory', profile.directory, '--executable', newBinary, '--json'])).toBe(0);
      expect(JSON.parse(printed())).toMatchObject({ scope: 'native-profile-repin', status: 'repinned', provider: 'grok', previousExecutable: oldBinary,
        executable: newBinary, backups: { launcherPath: `${profile.launcherPath}.prev` } });
      expect(launch(profile).binary).toBe('native-new'); expect(err).not.toHaveBeenCalled();
    });

    it('prints a human summary that says what moved and that nothing was executed', async () => {
      const profile = prepared();
      expect(await cmdResources(['profile', 'repin', '--directory', profile.directory, '--executable', newBinary])).toBe(0);
      const text = printed();
      expect(text).toContain('Native profile · claude · repinned · authentication not checked');
      expect(text).toContain(`Executable: ${oldBinary} -> ${newBinary}`);
      expect(text).toContain('Previous files kept:'); expect(text).toContain('Nothing was executed.');
      expect(text).toContain('ashlr resources launcher check --provider claude');
    });

    it('--dry-run writes nothing; repeating an applied repin says already pinned', async () => {
      const profile = prepared(); const before = tree(profile.directory);
      expect(await cmdResources(['profile', 'repin', '--dry-run', '--directory', profile.directory, '--executable', newBinary])).toBe(0);
      expect(printed()).toContain('dry run · would repin'); expect(printed()).toContain('Nothing was written.');
      expect(tree(profile.directory)).toEqual(before);
      out.mockClear();
      expect(await cmdResources(['profile', 'repin', '--directory', profile.directory, '--executable', oldBinary])).toBe(0);
      expect(printed()).toContain('already pinned · nothing written');
      expect(tree(profile.directory)).toEqual(before);
    });

    it.each([
      [['repin']], [['repin', '--directory', '/private/x']], [['repin', '--executable', '/private/x']],
      [['repin', '--directory', 'relative', '--executable', '/private/x']],
      [['repin', '--directory', '/private/../x', '--executable', '/private/x']],
      [['repin', '--directory', '/private/x', '--executable', '/private/x', '--dry-run', '--dry-run']],
      [['repin', '--directory', '/private/x', '--executable', '/private/x', '--force']],
      [['prepare', '--provider', 'codex', '--directory', '/private/x', '--executable', '/private/x', '--dry-run']],
      [['repin', '--help']], [['unpin', '--directory', '/private/x', '--executable', '/private/x']],
    ])('rejects malformed arguments %j with exit 2', async (input) => {
      expect(await cmdResources(['profile', ...input, '--json'])).toBe(2);
      expect(JSON.parse(printed())).toHaveProperty('error');
    });

    it('refuses --provider: repin keeps the profile provider', async () => {
      const profile = prepared(); const before = tree(profile.directory);
      expect(await cmdResources(['profile', 'repin', '--provider', 'codex', '--directory', profile.directory, '--executable', newBinary, '--json'])).toBe(2);
      expect(JSON.parse(printed())).toEqual({ error: 'repin keeps the profile provider; --provider is not accepted' });
      expect(tree(profile.directory)).toEqual(before);
    });

    it('surfaces the fixed, path-free failure text and exits 1', async () => {
      const profile = prepared(); editInPlace(profile.manifestPath, (text) => `${JSON.stringify(JSON.parse(text))}\n`);
      expect(await cmdResources(['profile', 'repin', '--directory', profile.directory, '--executable', newBinary, '--json'])).toBe(1);
      expect(JSON.parse(printed())).toEqual({ error: new ResourceNativeProfileRepinError('inconsistent').message });
      expect(printed()).not.toContain(base);
      expect(await cmdResources(['profile', 'repin', '--directory', profile.directory, '--executable', newBinary])).toBe(1);
      expect(String(err.mock.calls.at(-1)?.[0])).toContain('nothing was written'); expect(String(err.mock.calls.at(-1)?.[0])).not.toContain(base);
    });

    it('documents repin in the profile help', async () => {
      expect(await cmdResources(['profile', '--help'])).toBe(0);
      const help = printed();
      expect(help).toContain('ashlr resources profile repin --directory EXISTING_ABS --executable ABS');
      expect(help).toContain('--dry-run');
      expect(help).toMatch(/launcher\.mjs\.prev, profile\.json\.prev and command\.json\.prev/);
    });
  });
});
