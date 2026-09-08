/** Fresh private profile fixtures and inert native executables only. */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareResourceNativeProfile, type ResourceNativeProfileOptions } from '../src/core/resources/native-profile.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeSync: vi.fn(actual.writeSync) };
});

let base: string; let binary: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'native-profile-'))); binary = join(base, 'inert-native');
  writeFileSync(binary, `#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),pid:process.pid,env:process.env}));`, { mode: 0o700 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }); });
const options = (provider: 'codex' | 'claude' = 'codex'): ResourceNativeProfileOptions => ({ provider, directory: join(base, 'new-profile'), executable: binary });
function tree(path: string): unknown {
  const stat = lstatSync(path);
  return stat.isDirectory() ? { mode: stat.mode, entries: readdirSync(path).sort().map((name) => [name, tree(join(path, name))]) }
    : { mode: stat.mode, bytes: readFileSync(path).toString('base64') };
}

describe.skipIf(process.platform === 'win32' || typeof process.execve !== 'function')('native profile preparation', () => {
  it.each(['codex', 'claude'] as const)('prepares %s private files and unauthenticated locators without invoking anything', (provider) => {
    const before = readFileSync(binary); const profile = prepareResourceNativeProfile(options(provider));
    expect(profile).toMatchObject({ schemaVersion: 1, scope: 'native-profile-preparation', status: 'prepared', authentication: 'not-checked', provider });
    expect(JSON.parse(readFileSync(profile.manifestPath, 'utf8'))).toEqual(profile);
    expect(JSON.parse(readFileSync(profile.commandPath, 'utf8'))).toEqual([realpathSync(process.execPath), profile.launcherPath]);
    expect(profile.loginCommand).toEqual([...profile.command, ...(provider === 'codex' ? ['login'] : ['auth', 'login', '--claudeai'])]);
    expect(readdirSync(profile.nativeStatePath)).toEqual([]);
    if (profile.anthropicStatePath) expect(readdirSync(profile.anthropicStatePath)).toEqual([]);
    expect(readdirSync(profile.directory).sort()).toEqual([...(provider === 'claude' ? ['anthropic-state'] : []), 'command.json', 'launcher.mjs', 'native-state', 'profile.json']);
    for (const file of [profile.commandPath, profile.launcherPath, profile.manifestPath]) {
      expect(lstatSync(file).mode & 0o777).toBe(0o600); expect(lstatSync(file).nlink).toBe(1);
    }
    expect(lstatSync(profile.directory).mode & 0o777).toBe(0o700); expect(lstatSync(profile.nativeStatePath).mode & 0o777).toBe(0o700);
    expect(readFileSync(binary)).toEqual(before);
  });
  it('makes two Codex profiles independent storage locations, never implicit account identity proof', () => {
    const first = prepareResourceNativeProfile(options()); const second = prepareResourceNativeProfile({ ...options(), directory: join(base, 'second') });
    expect(first.nativeStatePath).not.toBe(second.nativeStatePath); expect(first.authentication).toBe('not-checked');
    expect(second.authentication).toBe('not-checked'); expect(readFileSync(first.launcherPath)).not.toEqual(readFileSync(second.launcherPath));
  });
  it.each(['codex', 'claude'] as const)('forwards %s help through execve with fixed state and no ambient billing selectors', (provider) => {
    const profile = prepareResourceNativeProfile(options(provider)); const before = tree(profile.directory);
    const result = JSON.parse(execFileSync(profile.command[0]!, [...profile.command.slice(1), '--help'], { encoding: 'utf8', timeout: 5000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', OPENAI_API_KEY: 'fixture-not-passed', ANTHROPIC_API_KEY: 'fixture-not-passed',
        CODEX_HOME: '/fixture/ambient-codex', CLAUDE_CONFIG_DIR: '/fixture/ambient-claude', ANTHROPIC_CONFIG_DIR: '/fixture/ambient-anthropic',
        HTTPS_PROXY: 'fixture-not-passed', EXTRA_SETTING: 'fixture-not-passed' } }));
    expect(result.args).toEqual(provider === 'codex'
      ? ['-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"', '--help'] : ['--help']);
    expect(result.env.HOME).toBe(process.env.HOME); expect(result.env.PATH).toBe(process.env.PATH);
    for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'HTTPS_PROXY', 'EXTRA_SETTING']) expect(result.env).not.toHaveProperty(key);
    if (provider === 'codex') { expect(result.env.CODEX_HOME).toBe(profile.nativeStatePath); expect(result.env).not.toHaveProperty('CLAUDE_CONFIG_DIR'); }
    else {
      expect(result.env.CLAUDE_CONFIG_DIR).toBe(profile.nativeStatePath); expect(result.env.ANTHROPIC_CONFIG_DIR).toBe(profile.anthropicStatePath);
      expect(result.env.DISABLE_UPDATES).toBe('1'); expect(result.env).not.toHaveProperty('CODEX_HOME');
    }
    expect(tree(profile.directory)).toEqual(before);
  });
  it.each([
    ['-c', 'cli_auth_credentials_store="keyring"'], ['--config', 'forced_login_method="api"'],
    ['--config=cli_auth_credentials_store="keyring"'], ['-cforced_login_method="api"'],
    ['-c', ' "cli_auth_credentials_store" = "auto"'], ['--config', "'forced_login_method' = 'api'"],
    ['--config', '"forced_login_\\u006dethod" = "api"'], ['-c', '"cli_auth_\\u0063redentials_store" = "keyring"'],
    ['-c=cli_auth_credentials_store="keyring"'],
    ['-c', '"ordinary_key"=true'], ['--config', 'analytics . enabled=false'], ['-c', 'invalid-assignment'],
  ])('refuses exact profile authentication overrides %# before native contact', (...args: string[]) => {
    const profile = prepareResourceNativeProfile(options());
    const result = spawnSync(profile.command[0]!, [...profile.command.slice(1), ...args, '--help'], { encoding: 'utf8', timeout: 5000 });
    expect(result.status).toBe(126); expect(result.stdout).toBe(''); expect(result.stderr).toBe('Native profile launcher unavailable or conflicting authentication override\n');
    expect(result.stderr).not.toContain(base);
  });
  it('retains Hub native app-server analytics flags', () => {
    const profile = prepareResourceNativeProfile(options()); const args = ['app-server', '--stdio', '-c', 'analytics.enabled=false'];
    const result = JSON.parse(execFileSync(profile.command[0]!, [...profile.command.slice(1), ...args], { encoding: 'utf8', timeout: 5000 }));
    expect(result.args.slice(4)).toEqual(args);
  });
  it.each(['directory', 'file', 'symlink'] as const)('does not reuse or overwrite an existing %s target', (kind) => {
    const config = options();
    if (kind === 'directory') { mkdirSync(config.directory, { mode: 0o700 }); writeFileSync(join(config.directory, 'keep.txt'), 'keep'); }
    if (kind === 'file') writeFileSync(config.directory, 'keep');
    if (kind === 'symlink') symlinkSync(binary, config.directory);
    const before = kind === 'symlink' ? readFileSync(binary) : tree(config.directory);
    expect(() => prepareResourceNativeProfile(config)).toThrow('must be new');
    expect(kind === 'symlink' ? readFileSync(binary) : tree(config.directory)).toEqual(before);
  });
  it.each(['missing', 'public', 'symlink'] as const)('refuses a %s parent without changing it', (kind) => {
    const parent = join(base, 'parent'); if (kind === 'public') mkdirSync(parent, { mode: 0o755 });
    if (kind === 'symlink') symlinkSync(base, parent);
    expect(() => prepareResourceNativeProfile({ ...options(), directory: join(parent, 'profile') })).toThrow('Invalid native profile');
    expect(existsSync(join(parent, 'profile'))).toBe(false);
  });
  it.each(['relative', 'noncanonical', 'control', 'root', 'unsupported', 'extra', 'accessor'] as const)('rejects %s inputs before mutation', (kind) => {
    const config: unknown = kind === 'relative' ? { ...options(), directory: 'relative' }
      : kind === 'noncanonical' ? { ...options(), directory: `${base}/../profile` }
      : kind === 'control' ? { ...options(), directory: `${base}/bad\nname` }
      : kind === 'root' ? { ...options(), directory: '/' }
      : kind === 'unsupported' ? { ...options(), provider: 'grok' }
      : kind === 'extra' ? { ...options(), credentials: 'must-not-read' }
      : Object.defineProperty({ ...options() }, 'provider', { get() { throw new Error('must not invoke'); } });
    const before = tree(base); expect(() => prepareResourceNativeProfile(config as ResourceNativeProfileOptions)).toThrow('Invalid native profile');
    expect(tree(base)).toEqual(before);
  });
  it.each(['missing', 'symlink', 'not-executable', 'writable'] as const)('rejects %s native executable', (kind) => {
    if (kind === 'missing') rmSync(binary);
    if (kind === 'symlink') { const target = join(base, 'actual'); writeFileSync(target, 'inert', { mode: 0o700 }); rmSync(binary); symlinkSync(target, binary); }
    if (kind === 'not-executable') chmodSync(binary, 0o600);
    if (kind === 'writable') chmodSync(binary, 0o722);
    expect(() => prepareResourceNativeProfile(options())).toThrow('Invalid native profile'); expect(existsSync(options().directory)).toBe(false);
  });
  it('refuses unsupported Node execution primitives before creating files', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'execve')!;
    Object.defineProperty(process, 'execve', { ...descriptor, value: undefined });
    try {
      expect(() => prepareResourceNativeProfile(options())).toThrow('Invalid native profile');
      expect(existsSync(options().directory)).toBe(false);
    } finally { Object.defineProperty(process, 'execve', descriptor); }
  });
  it('keeps a partial directory after an exclusive file write failure, never claiming prepared', () => {
    const original = fs.writeSync; let fail = true;
    vi.spyOn(fs, 'writeSync').mockImplementation(((...args: Parameters<typeof fs.writeSync>) => {
      if (fail) { fail = false; throw new Error(`private-error:${base}`); }
      return Reflect.apply(original, fs, args);
    }) as typeof fs.writeSync);
    expect(() => prepareResourceNativeProfile(options())).toThrow('partial directory remains');
    expect(existsSync(options().directory)).toBe(true); expect(existsSync(join(options().directory, 'profile.json'))).toBe(false);
  });
});
