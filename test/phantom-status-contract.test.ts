/** Synthetic fixtures for the values-free Secrets v0.7.9 status contract. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'node:child_process';
import { resolve } from 'node:path';

const { spawnSync } = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync }));

import {
  buildPhantomCapabilitySnapshot,
  getCachedFleetPhantomStatus,
  getPhantomStatus,
  resetPhantomStatusCache,
} from '../src/core/phantom.js';

function report(initialized = true) {
  return {
    schema_version: 1,
    initialized,
    inspection: 'metadata-only',
    managed_dotenv: { inspected: false },
    vault: { inspected: false },
    proxy: { lifecycle_lock: initialized ? 'missing' : 'not-inspected', listener_authenticated: false },
    issues: initialized ? [] : ['config-missing'],
  };
}

function result(stdout: string, status: number | null = 0, stderr = '', error?: Error): SpawnSyncReturns<string> {
  return { pid: 1, output: [], stdout, stderr, status, signal: null, error };
}

function installMock(statusResult = result(JSON.stringify(report())), names: unknown = ['OPENAI_API_KEY']) {
  spawnSync.mockImplementation((_bin: string, args: string[]) => {
    if (args[0] === '--version') return result('phantom 0.7.9\n');
    if (args[0] === 'status') return statusResult;
    if (args[0] === 'list') return result(JSON.stringify(names));
    if (args[0] === '--help') return result('Commands:\n  status\n  list\n  exec\n  mcp\n\nOptions:\n');
    throw new Error('unexpected command');
  });
}

beforeEach(() => {
  spawnSync.mockReset();
  resetPhantomStatusCache();
  installMock();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Secrets schema v1 observations', () => {
  it('accepts configured metadata without inventing injection or listener readiness', () => {
    const observed = getPhantomStatus();
    expect(observed.initialized).toBe(true);
    expect(observed.error).toBeUndefined();
    expect(observed.secretNames).toEqual(['OPENAI_API_KEY']);
    expect(observed.capability.modes.childEnvInjectionAvailable).toBe(false);
    expect(observed.capability.modes.mcpServerAvailable).toBe(true);
  });

  it('accepts a successful uninitialized report and never lists vault metadata', () => {
    installMock(result(JSON.stringify(report(false))));
    const observed = getPhantomStatus();
    expect(observed.initialized).toBe(false);
    expect(observed.error).toBeUndefined();
    expect(observed.secretNames).toEqual([]);
    expect(spawnSync.mock.calls.map((call) => call[1])).not.toContainEqual(['list', '--json']);
  });

  it.each(['config-unreadable', 'config-invalid'])('keeps %s distinct from a missing config', (issue) => {
    const fixture = report(false);
    fixture.issues = [issue];
    installMock(result(JSON.stringify(fixture)));
    const observed = getPhantomStatus();
    expect(observed).toMatchObject({ initialized: false, error: 'status-config-unavailable', secretNames: [] });
    expect(observed.capability.modes.childEnvInjectionAvailable).toBe(false);
    expect(spawnSync.mock.calls.map((call) => call[1])).not.toContainEqual(['list', '--json']);
  });

  it('preserves valid configured metadata when only lifecycle lock inspection fails', () => {
    const fixture = report();
    fixture.proxy.lifecycle_lock = 'unknown';
    fixture.issues = ['proxy-lock-unavailable'];
    installMock(result(JSON.stringify(fixture)));
    const observed = getPhantomStatus();
    expect(observed.initialized).toBe(true);
    expect(observed.error).toBeUndefined();
    expect(observed.capability.modes.childEnvInjectionAvailable).toBe(false);
  });

  it.each(['not-inspected', 'missing', 'available', 'held', 'unknown'])('does not enable injection for lifecycle lock %s', (lock) => {
    const fixture = report();
    fixture.proxy.lifecycle_lock = lock;
    installMock(result(JSON.stringify(fixture)));
    expect(getPhantomStatus().capability.modes.childEnvInjectionAvailable).toBe(false);
  });

  const unsupported: Array<[string, unknown]> = [
    ['missing schema version', { initialized: true }],
    ['unsupported schema version', { ...report(), schema_version: 2 }],
    ['string schema version', { ...report(), schema_version: '1' }],
    ['missing initialization', { ...report(), initialized: undefined }],
    ['string initialization', { ...report(), initialized: 'true' }],
    ['count heuristic', { secretCount: 3 }],
    ['legacy nested vault', { vault: { initialized: true } }],
    ['legacy ready message', { status: 'ready' }],
    ['non-metadata inspection', { ...report(), inspection: 'vault' }],
    ['inspected dotenv', { ...report(), managed_dotenv: { inspected: true } }],
    ['inspected vault', { ...report(), vault: { inspected: true } }],
    ['authenticated listener', { ...report(), proxy: { lifecycle_lock: 'held', listener_authenticated: true } }],
    ['unknown lock state', { ...report(), proxy: { lifecycle_lock: 'running', listener_authenticated: false } }],
    ['object lock state', { ...report(), proxy: { lifecycle_lock: { toString: null, valueOf: null }, listener_authenticated: false } }],
    ['missing issues', { ...report(), issues: undefined }],
    ['non-array issues', { ...report(), issues: 'config-missing' }],
    ['unknown issue', { ...report(), issues: ['raw error: SECRET_OBSERVATION_SENTINEL'] }],
    ['oversized issues', { ...report(), issues: Array(5).fill('config-missing') }],
    ['extra top-level field', { ...report(), token: 'SECRET_OBSERVATION_SENTINEL' }],
    ['extra vault field', { ...report(), vault: { inspected: false, token: 'SECRET_OBSERVATION_SENTINEL' } }],
    ['null report', null],
    ['array report', [report()]],
  ];

  it.each(unsupported)('rejects %s as unknown with a fixed error code', (_label, fixture) => {
    installMock(result(JSON.stringify(fixture)));
    const observed = getPhantomStatus();
    expect(observed.initialized).toBe(false);
    expect(observed.error).toBe('status-contract-unsupported');
    expect(observed.secretNames).toEqual([]);
    expect(JSON.stringify(observed)).not.toContain('SECRET_OBSERVATION_SENTINEL');
    expect(spawnSync.mock.calls.map((call) => call[1])).not.toContainEqual(['list', '--json']);
  });

  it.each(['', 'Phantom is initialized\nvault: ~/.phantom', 'proxy running', '{malformed'])('rejects legacy or malformed text %j', (text) => {
    installMock(result(text));
    expect(getPhantomStatus()).toMatchObject({ initialized: false, error: 'status-contract-unsupported' });
  });

  it.each([1, 2, null])('rejects valid JSON when status exit is %s', (exit) => {
    installMock(result(JSON.stringify(report()), exit, 'SECRET_OBSERVATION_SENTINEL'));
    const observed = getPhantomStatus();
    expect(observed).toMatchObject({ initialized: false, error: 'status-unavailable', secretNames: [] });
    expect(JSON.stringify(observed)).not.toContain('SECRET_OBSERVATION_SENTINEL');
  });

  it('never treats stderr as status JSON or exposes spawn error details', () => {
    installMock(result('', 0, JSON.stringify(report())));
    expect(getPhantomStatus().error).toBe('status-contract-unsupported');
    installMock(result('', null, '', new Error('SECRET_OBSERVATION_SENTINEL')));
    expect(getPhantomStatus().error).toBe('status-unavailable');
    expect(JSON.stringify(getPhantomStatus())).not.toContain('SECRET_OBSERVATION_SENTINEL');
  });

  it('does not expose unrecognized version output', () => {
    const impl = spawnSync.getMockImplementation()!;
    spawnSync.mockImplementation((bin, args, options) => args[0] === '--version'
      ? result('SECRET_OBSERVATION_SENTINEL')
      : impl(bin, args, options));
    const observed = getPhantomStatus();
    expect(observed.version).toBeNull();
    expect(JSON.stringify(observed)).not.toContain('SECRET_OBSERVATION_SENTINEL');
  });

  it('does not infer MCP availability from binary installation alone', () => {
    const observed = buildPhantomCapabilitySnapshot({ installed: true, initialized: true, secretNames: [] });
    expect(observed.modes.mcpServerAvailable).toBe(false);
    expect(observed.modes.childEnvInjectionAvailable).toBe(false);
    const unknownCommands = buildPhantomCapabilitySnapshot({
      installed: true, initialized: true, secretNames: [],
      commands: { commandsKnown: false, setupAvailable: false, execAvailable: false, mcpAvailable: true, agentAvailable: false },
    });
    expect(unknownCommands.modes.mcpServerAvailable).toBe(false);
  });

  it('bounds subprocess output and uses one resolved project cwd for every command', () => {
    getPhantomStatus({ cwd: './synthetic-project', timeoutMs: 125 });
    for (const call of spawnSync.mock.calls) {
      const options = call[2] as SpawnSyncOptionsWithStringEncoding;
      expect(options.cwd).toBe(resolve('./synthetic-project'));
      expect(options.timeout).toBe(125);
      expect(options.maxBuffer).toBe(1_048_576);
    }
    expect(spawnSync.mock.calls.map((call) => call[1])).toEqual([
      ['--version'], ['--version'], ['status', '--json'], ['list', '--json'], ['--help'],
    ]);
  });

  it('bounds returned names and count without retaining unknown list fields', () => {
    installMock(result(JSON.stringify(report())), Array.from({ length: 10_002 }, (_, i) => ({
      name: `KEY_${i}`, value: 'SECRET_OBSERVATION_SENTINEL',
    })));
    const observed = getPhantomStatus();
    expect(observed.secretNames).toHaveLength(10_000);
    expect(observed.capability.secretCount).toBe(10_000);
    expect(observed.secretNames).not.toContain('KEY_10000');
    expect(JSON.stringify(observed)).not.toContain('SECRET_OBSERVATION_SENTINEL');
  });
});

describe('Secrets cache project isolation', () => {
  it('reuses observations only for the same resolved explicit cwd', () => {
    const first = getCachedFleetPhantomStatus({ cwd: '/synthetic/project-a', nowMs: 1_000 });
    const same = getCachedFleetPhantomStatus({ cwd: '/synthetic/project-a/.', nowMs: 1_100 });
    expect(same).toBe(first);
    expect(spawnSync).toHaveBeenCalledTimes(5);
    installMock(result(JSON.stringify(report(false))));
    const other = getCachedFleetPhantomStatus({ cwd: '/synthetic/project-b', nowMs: 1_200 });
    expect(other).not.toBe(first);
    expect(other.initialized).toBe(false);
    expect(spawnSync).toHaveBeenCalledTimes(9);
  });

  it('invalidates when the implicit process cwd changes', () => {
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/synthetic/project-a');
    const first = getCachedFleetPhantomStatus({ nowMs: 1_000 });
    cwd.mockReturnValue('/synthetic/project-b');
    const other = getCachedFleetPhantomStatus({ nowMs: 1_100 });
    expect(other).not.toBe(first);
    expect(spawnSync).toHaveBeenCalledTimes(10);
  });

  it('fails gracefully when the implicit cwd is unavailable', () => {
    vi.spyOn(process, 'cwd').mockImplementation(() => { throw new Error('SECRET_OBSERVATION_SENTINEL'); });
    const observed = getCachedFleetPhantomStatus();
    expect(observed).toMatchObject({ initialized: false, error: 'status-unavailable' });
    expect(spawnSync).not.toHaveBeenCalled();
    expect(JSON.stringify(observed)).not.toContain('SECRET_OBSERVATION_SENTINEL');
  });

  it('does not include process secret values in the cache identity', () => {
    const first = getCachedFleetPhantomStatus({ nowMs: 1_000 });
    vi.stubEnv('PHANTOM_PROXY_TOKEN', 'SECRET_OBSERVATION_SENTINEL');
    vi.stubEnv('PHANTOM_VAULT_PASSPHRASE', 'SECRET_OBSERVATION_SENTINEL');
    const same = getCachedFleetPhantomStatus({ nowMs: 1_100 });
    expect(same).toBe(first);
    expect(spawnSync).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(same)).not.toContain('SECRET_OBSERVATION_SENTINEL');
  });
});
