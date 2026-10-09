import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocked = vi.hoisted(() => ({ spawn: vi.fn(), exec: vi.fn() }));
vi.mock('node:child_process', () => ({
  spawnSync: mocked.spawn,
  execFileSync: mocked.exec,
  execFile: vi.fn(),
}));

import {
  locusAgentReport, locusCiMint, LocusMintError, runWithLocusSessionIfConfigured,
  validateExistingLocusSession, withLocusSession,
} from '../src/core/integrations/locus.js';
import { assertLocusJobDispatch, getLocusJobEnv } from '../src/core/integrations/locus-job-env.js';

let home: string;
const executor = 'a'.repeat(64);
const session = 'ses_012abc';
const future = () => new Date(Date.now() + 60_000).toISOString();
function identity(expires = future()) {
  return {
    session_id: session, binding_alias: 'acme', binding_id: 'binding-acme', tenant: 'acme-tenant',
    expires_at: expires, worker_home: join(home, 'workers', session), seal: 'sealed-acme',
    seal_ok: true, authority_anchor_ok: true, authority: 'delegated', backing_type: 'ci',
    backing_path: join(home, 'sessions', 'ci-012abc.json'), frozen: false, providers: [],
  };
}
function source(info = identity()): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, HOME: '/ambient-home', ANTHROPIC_API_KEY: 'synthetic-unrelated-value',
    LOCUS_HOME: home, LOCUS_SESSION_ID: session, LOCUS_EXECUTOR_CAPABILITY: executor,
    LOCUS_CONTROL_CAPABILITY: 'c'.repeat(64), LOCUS_BINDING: info.binding_alias,
    LOCUS_BINDING_ID: info.binding_id, LOCUS_TENANT: info.tenant, LOCUS_SEAL: info.seal,
    LOCUS_WORKER_HOME: info.worker_home, LOCUS_EXPIRES_AT: info.expires_at, LOCUS_PROVIDERS: '',
  };
}
function mint(info = identity()) {
  const env = source(info);
  delete env.HOME; delete env.ANTHROPIC_API_KEY; delete env.PATH;
  delete env.LOCUS_HOME; delete env.LOCUS_CONTROL_CAPABILITY;
  return {
    session_id: info.session_id, binding: info.binding_alias, binding_id: info.binding_id,
    tenant: info.tenant, expires_at: info.expires_at, seal: info.seal, path: info.backing_path,
    worker_home: info.worker_home, secrets_resolved: false,
    env: env as Record<string, string>,
  };
}
function reply(value: unknown) {
  return { status: 0, stdout: JSON.stringify(value), stderr: '', error: undefined };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'locus-authority-fixture-'));
  // Use the canonical physical tmp path on macOS (/var aliases /private/var).
  home = realpathSync(home);
  mkdirSync(join(home, 'workers', session), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, 'sessions'), { mode: 0o700 });
  writeFileSync(join(home, 'sessions', 'ci-012abc.json'), 'synthetic metadata only', { mode: 0o600 });
  mocked.spawn.mockReset(); mocked.exec.mockReset();
  mocked.exec.mockReturnValue('synthetic-locus');
});
afterEach(() => { vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });

describe('actual Phantom Locus adapter live session contract', () => {
  it('internal Locus probes use private job identity without ambient credential or control authority', async () => {
    const info = identity(); mocked.spawn.mockReturnValue(reply(info));
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-ambient-key');
    try {
      await runWithLocusSessionIfConfigured(() => {
        locusAgentReport();
        const options = mocked.spawn.mock.calls.at(-1)?.[2];
        expect(options.env.LOCUS_SESSION_ID).toBe(session);
        expect(options.env.HOME).toBe(info.worker_home);
        expect(options.env.LOCUS_EXECUTOR_CAPABILITY).toBe(executor);
        expect(options.env.LOCUS_CONTROL_CAPABILITY).toBeUndefined();
        expect(options.env.OPENAI_API_KEY).toBeUndefined();
      }, { env: source(info) });
    } finally { vi.unstubAllEnvs(); }
  });
  it.each(['worker', 'workers', 'backing', 'gh', 'aws'])('refuses a %s symlink before callback', async kind => {
    const info = identity(); mocked.spawn.mockReturnValue(reply(info));
    const outside = mkdtempSync(join(tmpdir(), 'locus-outside-fixture-'));
    try {
      const path = kind === 'worker' ? info.worker_home : kind === 'workers' ? join(home, 'workers') :
        kind === 'backing' ? info.backing_path : join(info.worker_home, kind);
      rmSync(path, { recursive: true, force: true });
      symlinkSync(outside, path);
      const callback = vi.fn();
      await expect(runWithLocusSessionIfConfigured(callback, { env: source(info) })).rejects.toThrow(/containment/);
      expect(callback).not.toHaveBeenCalled();
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  it('refuses other-writable worker storage', () => {
    const info = identity(); mocked.spawn.mockReturnValue(reply(info));
    chmodSync(info.worker_home, 0o777);
    expect(() => validateExistingLocusSession(source(info))).toThrow(/ownership/);
  });

  it('rechecks worker containment immediately before dispatch', async () => {
    const info = identity(); mocked.spawn.mockReturnValue(reply(info));
    await runWithLocusSessionIfConfigured(() => {
      rmSync(info.worker_home, { recursive: true });
      symlinkSync(home, info.worker_home);
      expect(() => assertLocusJobDispatch()).toThrow(/containment/);
    }, { env: source(info) });
  });
  it('accepts the released mint executor field, verifies identity and isolates the callback', async () => {
    const info = identity();
    mocked.spawn.mockImplementation((_bin, args) => reply(args[0] === 'ci' ? mint(info) : info));
    const ambient = { ...process.env };
    await withLocusSession('acme', handle => {
      expect(handle.env.LOCUS_EXECUTOR_CAPABILITY).toBe(executor);
      expect(handle.env.LOCUS_CONTROL_CAPABILITY).toBeUndefined();
      expect(handle.env.HOME).toBe(info.worker_home);
      expect(handle.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(Object.isFrozen(handle.env)).toBe(true);
      expect(getLocusJobEnv().LOCUS_SESSION_ID).toBe(session);
      expect(process.env).toEqual(ambient);
      assertLocusJobDispatch();
    }, { home, env: { PATH: process.env.PATH } });
    expect(mocked.spawn.mock.calls.filter(call => call[1][0] === 'whoami')).toHaveLength(3);
    expect(process.env).toEqual(ambient);
  });

  it('an inherited session returns a verified handle without reminting', async () => {
    const info = identity(); mocked.spawn.mockReturnValue(reply(info));
    await runWithLocusSessionIfConfigured(handle => {
      expect(handle?.binding).toBe('acme');
      expect(handle?.env.HOME).toBe(info.worker_home);
    }, { env: source(info) });
    expect(mocked.spawn.mock.calls.every(call => call[1][0] === 'whoami')).toBe(true);
  });

  it.each([
    ['expired', { expires_at: '2000-01-01T00:00:00Z' }],
    ['restarted authority', { authority_anchor_ok: false }],
    ['invalid seal', { seal_ok: false }],
    ['frozen', { frozen: true }],
    ['operator backing', { authority: 'operator', backing_type: 'operator' }],
    ['cross-session backing', { backing_path: '/tmp/another-session.json' }],
    ['cross-tenant worker', { worker_home: '/tmp/another-worker' }],
    ['malformed providers', { providers: 'not-an-array' }],
  ])('refuses %s before callback execution', async (_label, drift) => {
    const info = identity(); mocked.spawn.mockReturnValue(reply({ ...info, ...drift }));
    const callback = vi.fn();
    await expect(runWithLocusSessionIfConfigured(callback, { env: source(info) })).rejects.toThrow(LocusMintError);
    expect(callback).not.toHaveBeenCalled();
  });

  it.each(['LOCUS_BINDING', 'LOCUS_BINDING_ID', 'LOCUS_TENANT', 'LOCUS_SEAL', 'LOCUS_WORKER_HOME', 'LOCUS_PROVIDERS'])('refuses mismatched inherited %s', key => {
    const info = identity(); mocked.spawn.mockReturnValue(reply(info));
    expect(() => validateExistingLocusSession({ ...source(info), [key]: 'different' })).toThrow(/labels/);
  });

  it('rejects mismatched mint identity before live probing or callback', () => {
    const result = mint(); result.env.LOCUS_TENANT = 'another-tenant';
    mocked.spawn.mockReturnValue(reply(result));
    expect(() => locusCiMint('acme', { home })).toThrow(/identity labels/);
    expect(mocked.spawn).toHaveBeenCalledTimes(1);
  });

  it('does not retain arbitrary top-level mint output fields', () => {
    mocked.spawn.mockReturnValue(reply({ ...mint(), unreviewed_private_field: 'synthetic-value' }));
    expect(locusCiMint('acme', { home })).not.toHaveProperty('unreviewed_private_field');
  });

  it('does not surface untrusted subprocess output in failures', () => {
    mocked.spawn.mockReturnValue({ status: 1, stdout: 'synthetic-private-authority', stderr: 'synthetic-private-authority' });
    expect(() => locusCiMint('acme', { home })).toThrow('ci mint command failed');
  });

  it('rechecks authority at dispatch after an await and refuses an expired lease', async () => {
    const info = identity(); let expired = false;
    mocked.spawn.mockImplementation(() => reply(expired ? { ...info, expires_at: '2000-01-01T00:00:00Z' } : info));
    await runWithLocusSessionIfConfigured(async () => {
      await Promise.resolve(); expired = true;
      expect(() => assertLocusJobDispatch()).toThrow(/expiry/);
    }, { env: source(info) });
  });
});
