/**
 * M33 — `ashlr update` channel awareness (src/cli/update.ts detectChannel).
 *
 * Whole command contracts use mocked npm/service operations; no network or
 * installation occurs. The running package keeps its finite identity.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { sep } from 'node:path';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), read: vi.fn(), service: vi.fn(), dashboard: vi.fn(), authorize: vi.fn() }));
vi.mock('node:child_process', async () => ({ ...await vi.importActual<typeof import('node:child_process')>('node:child_process'), spawnSync: mocks.spawn }));
vi.mock('node:fs', async () => ({ ...await vi.importActual<typeof import('node:fs')>('node:fs'), readFileSync: mocks.read }));
vi.mock('../src/core/daemon/service.js', () => ({ serviceStatus: mocks.service }));
vi.mock('../src/cli/dashboard.js', () => ({ queryServeService: mocks.dashboard }));
vi.mock('../src/core/daemon/service-install-authority.js', () => ({ assertResidentServiceInstallAuthorized: mocks.authorize }));

import { cmdUpdate, detectChannel, resolveNpmUpdateIdentity } from '../src/cli/update.js';

let output = '';
let errors = '';

beforeEach(() => {
  expect.hasAssertions();
  vi.clearAllMocks();
  output = ''; errors = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { errors += String(chunk); return true; });
  mocks.read.mockReturnValue(JSON.stringify({ name: '@ashlr/hub', version: '3.25.3' }));
  mocks.service.mockReturnValue({ running: false, registrationState: 'absent' });
  mocks.dashboard.mockReturnValue({ running: false, registrationState: 'absent' });
  mocks.authorize.mockImplementation(() => { throw new Error('service mutation refused'); });
  mocks.spawn.mockImplementation((command: string, args: string[]) => {
    if (command === 'npm' && args[0] === 'view') return { status: 0, stdout: '3.25.4\n' };
    if (command === 'npm' && args[0] === 'install') return { status: 0, stdout: '' };
    throw new Error('unexpected subprocess');
  });
});

afterEach(() => { vi.restoreAllMocks(); });

describe('detectChannel', () => {
  it('reports git for a repo checkout path', () => {
    const url = pathToFileURL(['', 'Users', 'dev', 'ashlr-hub', 'dist', 'cli', 'update.js'].join(sep)).href;
    expect(detectChannel(url)).toBe('git');
  });

  it('reports npm for a node_modules install (global or local)', () => {
    const globalUrl = pathToFileURL(
      ['', 'usr', 'local', 'lib', 'node_modules', '@ashlr', 'hub', 'dist', 'cli', 'update.js'].join(sep),
    ).href;
    expect(detectChannel(globalUrl)).toBe('npm');

    const localUrl = pathToFileURL(
      ['', 'Users', 'dev', 'proj', 'node_modules', '@ashlr', 'hub', 'dist', 'cli', 'update.js'].join(sep),
    ).href;
    expect(detectChannel(localUrl)).toBe('npm');
  });

  it('defaults to this module location (a git checkout in the test env)', () => {
    expect(detectChannel()).toBe('git');
  });

  it('detects canonical global and local installs without changing the channel', () => {
    for (const prefix of [['', 'usr', 'local', 'lib'], ['', 'Users', 'dev', 'proj']]) {
      expect(detectChannel(pathToFileURL([...prefix, 'node_modules', '@ashlr', 'phantom', 'dist', 'cli', 'update.js'].join(sep)).href)).toBe('npm');
    }
  });
});

describe('closed npm package identity', () => {
  it.each(['hub', 'phantom'])('accepts the matching %s installed namespace', leaf => {
    const name = `@ashlr/${leaf}`;
    const identity = resolveNpmUpdateIdentity({ name, version: '3.25.3' }, ['', 'usr', 'lib', 'node_modules', '@ashlr', leaf].join(sep));
    expect(identity.profile.packageName).toBe(name);
    expect(identity.version).toBe('3.25.3');
    expect(identity.profile.binName).toBe('ashlr');
  });

  it.each(['hub', 'phantom'])('accepts an explicit npm channel from an owned %s source package', leaf => {
    expect(resolveNpmUpdateIdentity({ name: `@ashlr/${leaf}` }, ['', 'work', 'checkout'].join(sep)).version).toBeNull();
  });

  it.each([null, [], {}, { name: 'phantom' }, { name: '@other/phantom' }, { name: '@ashlr/hub@latest' }, Object.create({ name: '@ashlr/hub' })])('refuses unsupported metadata %#', metadata => {
    expect(() => resolveNpmUpdateIdentity(metadata, ['', 'work', 'checkout'].join(sep))).toThrow();
  });

  it.each([
    ['@ashlr/hub', ['@ashlr', 'phantom']], ['@ashlr/phantom', ['@ashlr', 'hub']],
    ['@ashlr/phantom', ['@other', 'phantom']], ['@ashlr/hub', ['@ashlr', 'hub', 'nested']],
  ])('refuses a mixed installed package tuple %#', (name, suffix) => {
    expect(() => resolveNpmUpdateIdentity({ name }, ['', 'work', 'node_modules', ...suffix].join(sep))).toThrow();
  });
});

describe('npm channel command fidelity', () => {
  it('shows phm update as primary help with the compatible alias and no effects', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(line => { lines.push(String(line)); });
    expect(await cmdUpdate(['--help'])).toBe(0);
    expect(lines.join('\n')).toContain('phm update');
    expect(lines.join('\n')).toContain('Compatible alias: ashlr update');
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.each(['@ashlr/hub', '@ashlr/phantom'])('checks only the running %s package', async name => {
    mocks.read.mockReturnValue(JSON.stringify({ name, version: '3.25.3' }));
    expect(await cmdUpdate(['--channel', 'npm', '--check', '--json', '--yes'])).toBe(0);
    expect(mocks.spawn.mock.calls).toHaveLength(1);
    expect(mocks.spawn.mock.calls[0]?.slice(0, 2)).toEqual(['npm', ['view', name, 'version']]);
    expect(mocks.spawn.mock.calls[0]?.[2]).toMatchObject({ timeout: 10_000 });
    expect(JSON.parse(output)).toMatchObject({ updated: false, versionLocal: '3.25.3', versionLatest: '3.25.4' });
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it.each(['@ashlr/hub', '@ashlr/phantom'])('prints %s advice without confirmation or installing', async name => {
    mocks.read.mockReturnValue(JSON.stringify({ name, version: '3.25.3' }));
    expect(await cmdUpdate(['--channel', 'npm'])).toBe(0);
    expect(output).toContain(`npm install -g ${name}@latest`);
    expect(output).toContain('phm update --yes');
    expect(mocks.spawn.mock.calls).toHaveLength(1);
  });

  it.each(['@ashlr/hub', '@ashlr/phantom'])('installs only %s with explicit confirmation and a fresh identity', async name => {
    mocks.read.mockReturnValue(JSON.stringify({ name, version: '3.25.3' }));
    expect(await cmdUpdate(['--channel', 'npm', '--yes'])).toBe(0);
    expect(mocks.spawn.mock.calls.map(call => call.slice(0, 2))).toEqual([
      ['npm', ['view', name, 'version']], ['npm', ['install', '-g', `${name}@latest`]],
    ]);
    expect(mocks.spawn.mock.calls[1]?.[2]).toMatchObject({ timeout: 300_000, stdio: 'inherit' });
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it.each(['@ashlr/hub', '@ashlr/phantom'])('keeps %s up-to-date checks read-only', async name => {
    mocks.read.mockReturnValue(JSON.stringify({ name, version: '3.25.4' }));
    expect(await cmdUpdate(['--channel', 'npm', '--yes', '--json'])).toBe(0);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(output)).toMatchObject({ upToDate: true, updated: false });
  });

  it('keeps an offline registry unknown and never installs', async () => {
    mocks.spawn.mockReturnValue({ status: 1, stdout: '' });
    expect(await cmdUpdate(['--channel', 'npm', '--yes', '--json'])).toBe(0);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(output)).toMatchObject({ versionLatest: null, upToDate: null, updated: false });
  });

  it.each(['not JSON', 'null', '[]', '{}', '{"name":"@other/phantom"}'])('refuses invalid own metadata before any effect %#', async raw => {
    mocks.read.mockReturnValue(raw);
    expect(await cmdUpdate(['--channel', 'npm', '--yes', '--json'])).toBe(1);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled();
    expect(mocks.dashboard).not.toHaveBeenCalled();
    expect(JSON.parse(output)).toMatchObject({ updated: false, error: 'npm-package-identity-unavailable' });
    expect(errors).not.toContain(raw);
  });

  it('refuses unreadable metadata before provider or install calls', async () => {
    mocks.read.mockImplementation(() => { throw new Error('private path detail'); });
    expect(await cmdUpdate(['--channel', 'npm', '--check', '--json'])).toBe(1);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(errors).not.toContain('private path detail');
  });

  it.each([
    { name: '@ashlr/phantom', version: '3.25.3' }, { name: '@ashlr/hub', version: '3.25.4' },
    { name: '@other/phantom', version: '3.25.3' },
  ])('refuses metadata drift after checking but before installing %#', async changed => {
    mocks.read.mockReturnValueOnce(JSON.stringify({ name: '@ashlr/hub', version: '3.25.3' })).mockReturnValueOnce(JSON.stringify(changed));
    expect(await cmdUpdate(['--channel', 'npm', '--yes'])).toBe(1);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(output).toContain('package identity is unsupported, inconsistent or changed');
  });

  it('preserves the existing service mutation restriction before npm contact', async () => {
    mocks.service.mockReturnValue({ running: true, registrationState: 'present' });
    expect(await cmdUpdate(['--channel', 'npm', '--yes'])).toBe(1);
    expect(mocks.authorize).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
