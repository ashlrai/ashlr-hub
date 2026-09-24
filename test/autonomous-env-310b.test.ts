/**
 * V3.10 Track B unit U2 — the autonomous run environment
 * (src/core/sandbox/autonomous-env.ts). Filesystem only, under a temp HOME.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AUTONOMOUS_DENIED_HOME_PATHS,
  applyAutonomousEnvOverlay,
  autonomousEngineClass,
  buildAutonomousEnvOverlay,
  commitAutonomousVendorState,
} from '../src/core/sandbox/autonomous-env.js';
import { CUSTODY_HELPER_PATH, custodyDataDir } from '../src/core/authority/custody-client.js';

function scratch(): { home: string; run: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'autonomous-env-')));
  const home = join(root, 'home');
  const run = join(root, 'run');
  mkdirSync(home, { recursive: true });
  mkdirSync(run, { mode: 0o700 });
  return { home, run };
}

const jwt = (claims: Record<string, string>): string =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

function grokAuth(sub: string, refresh: string, key = jwt({ sub, principal_id: 'p1', team_id: 't1' })): string {
  return JSON.stringify({
    'https://auth.x.ai::client': { user_id: sub, principal_id: 'p1', team_id: 't1', key, refresh_token: refresh, expires_at: 'x' },
  });
}

function grokSeat(home: string): string {
  const state = join(home, '.ashlr', 'native-profiles', 'grok-a', 'native-state');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  chmodSync(state, 0o700);
  writeFileSync(join(state, 'auth.json'), grokAuth('user-1', 'refresh-1'), { mode: 0o600 });
  writeFileSync(join(state, 'config.toml'), '[marketplace]\n', { mode: 0o600 });
  mkdirSync(join(state, 'sessions'));
  writeFileSync(join(state, 'sessions', 'transcript.jsonl'), 'mason private chat\n');
  mkdirSync(join(state, 'hooks'));
  writeFileSync(join(state, 'hooks', 'pre.sh'), '#!/bin/sh\n');
  writeFileSync(join(home, '.ashlr', 'native-profiles', 'grok-a', 'profile.json'),
    JSON.stringify({ provider: 'grok', nativeStatePath: state }), { mode: 0o600 });
  return state;
}

describe('engine classes fail closed', () => {
  it('maps the grant engines and treats anything unknown as local (no egress)', () => {
    expect(autonomousEngineClass('grok-cli')).toBe('grok-cli');
    expect(autonomousEngineClass('claude')).toBe('claude-cli');
    expect(autonomousEngineClass('claude-cli')).toBe('claude-cli');
    expect(autonomousEngineClass('codex')).toBe('codex');
    for (const e of ['local-coder', 'llama-server', 'aw', 'ashlrcode', 'grok', 'nim', 'totally-new-engine']) {
      expect(autonomousEngineClass(e)).toBe('local');
    }
  });
});

describe('buildAutonomousEnvOverlay', () => {
  it('creates private ephemeral homes and points every home/cache variable into the run', () => {
    const { home, run } = scratch();
    const o = buildAutonomousEnvOverlay({ engine: 'local-coder', runTmpDir: run, home, seatId: null, path: '/usr/bin:/bin' });
    for (const key of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
      'npm_config_cache', 'YARN_CACHE_FOLDER', 'BUN_INSTALL_CACHE_DIR', 'PIP_CACHE_DIR', 'GOCACHE', 'GOMODCACHE', 'CARGO_HOME']) {
      const value = o.set[key]!;
      expect(value.startsWith(`${run}/`), key).toBe(true);
      expect(existsSync(value) || key === 'GOPATH', key).toBe(true);
      if (existsSync(value)) expect(statSync(value).mode & 0o777, key).toBe(0o700);
    }
    expect(o.set['GIT_CONFIG_GLOBAL']).toBe('/dev/null');
    expect(o.set['GIT_CONFIG_NOSYSTEM']).toBe('1');
    expect(o.writablePaths).toEqual([run]);
    expect(o.engineClass).toBe('local');
    expect(o.vendorState).toEqual([]);
  });

  it('never puts a secret in `set` and removes known credential variables', () => {
    const { home, run } = scratch();
    const o = buildAutonomousEnvOverlay({ engine: 'claude-cli', runTmpDir: run, home, seatId: 'claude-a', path: '/usr/bin' });
    expect(Object.keys(o.set).some((k) => /TOKEN|SECRET|API_KEY/.test(k) && k !== 'CLAUDE_CODE_OAUTH_TOKEN')).toBe(false);
    expect(o.set['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
    for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'SSH_AUTH_SOCK', 'NODE_OPTIONS', 'GIT_DIR', 'GROK_HOME']) {
      expect(o.unset, k).toContain(k);
    }
    // claude runs as a restricted judge with its own throwaway config dir
    expect(o.set['CLAUDE_CONFIG_DIR']).toBe(join(run, 'claude'));
    expect(o.set['CLAUDE_CODE_RESTRICTED']).toBe('1');
    expect(o.set['CLAUDE_CODE_TMPDIR']).toBe(join(run, 'tmp'));
    expect(o.unset).not.toContain('CLAUDE_CONFIG_DIR');
    expect(o.engineClass).toBe('claude-cli');
  });

  it('denies the custody dir, authority state, native profiles and the helper', () => {
    const { home, run } = scratch();
    const o = buildAutonomousEnvOverlay({ engine: 'local-coder', runTmpDir: run, home, seatId: null });
    expect(o.deniedReadPaths).toContain(custodyDataDir(home));
    for (const rel of ['.ashlr/authority', '.ashlr/activation', '.ashlr/foundry', '.ashlr/native-profiles', 'Library/Keychains', '.ssh']) {
      expect(o.deniedReadPaths).toContain(join(home, rel));
    }
    expect(o.deniedReadPaths).toContain(CUSTODY_HELPER_PATH);
    expect(AUTONOMOUS_DENIED_HOME_PATHS.slice(0, 5)).toEqual([
      'Library/Application Support/ashlr-custody', 'Library/Keychains', '.ashlr/authority', '.ashlr/activation', '.ashlr/foundry',
    ]);
  });

  it('drops PATH entries under HOME except present toolchain bins, and keeps system dirs', () => {
    const { home, run } = scratch();
    mkdirSync(join(home, '.cargo', 'bin'), { recursive: true });
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    const o = buildAutonomousEnvOverlay({
      engine: 'local-coder', runTmpDir: run, home, seatId: null,
      path: `${home}/.local/bin:${home}/.cargo/bin:/opt/homebrew/bin:/usr/bin:relative/bin`,
    });
    const parts = o.set['PATH']!.split(':');
    expect(parts).toContain(join(home, '.cargo', 'bin'));
    expect(parts).not.toContain(join(home, '.local', 'bin'));
    expect(parts).not.toContain('relative/bin');
    expect(parts).toEqual(expect.arrayContaining(['/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']));
    expect(o.readOnlyPaths).toContain(join(home, '.cargo', 'bin'));
    expect(o.readOnlyPaths).not.toContain(join(home, '.bun', 'bin'));
  });

  it('refuses unsafe run dirs and inputs', () => {
    const { home, run } = scratch();
    chmodSync(run, 0o755);
    expect(() => buildAutonomousEnvOverlay({ engine: 'local', runTmpDir: run, home, seatId: null })).toThrow(/0700/);
    chmodSync(run, 0o700);
    const link = `${run}-link`;
    symlinkSync(run, link);
    expect(() => buildAutonomousEnvOverlay({ engine: 'local', runTmpDir: link, home, seatId: null })).toThrow(/canonical/);
    expect(() => buildAutonomousEnvOverlay({ engine: 'local', runTmpDir: 'relative', home, seatId: null })).toThrow(/absolute/);
    expect(() => buildAutonomousEnvOverlay({ engine: 'bad engine', runTmpDir: run, home, seatId: null })).toThrow(/engine/);
    expect(() => buildAutonomousEnvOverlay({ engine: 'local', runTmpDir: run, home, seatId: '../x' })).toThrow(/seat/);
    const inside = join(home, '.ashlr', 'authority', 'run');
    mkdirSync(inside, { recursive: true, mode: 0o700 });
    chmodSync(inside, 0o700);
    expect(() => buildAutonomousEnvOverlay({ engine: 'local', runTmpDir: inside, home, seatId: null })).toThrow(/protected/);
    const wraps = realpathSync(mkdtempSync(join(tmpdir(), 'autonomous-wrap-')));
    chmodSync(wraps, 0o700);
    mkdirSync(join(wraps, 'home'));
    expect(() => buildAutonomousEnvOverlay({ engine: 'local', runTmpDir: wraps, home: join(wraps, 'home'), seatId: null })).toThrow(/contain the home/);
  });

  it('refuses a symlink planted where an ephemeral home goes', () => {
    const { home, run } = scratch();
    symlinkSync(home, join(run, 'home'));
    expect(() => buildAutonomousEnvOverlay({ engine: 'local', runTmpDir: run, home, seatId: null })).toThrow(/plain directory/);
  });

  it('makes named executables readable, never protected ones', () => {
    const { home, run } = scratch();
    const bin = join(home, '.grok', 'downloads', 'grok-1');
    mkdirSync(join(home, '.grok', 'downloads'), { recursive: true });
    writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
    const o = buildAutonomousEnvOverlay({ engine: 'local', runTmpDir: run, home, seatId: null, executables: [bin] });
    expect(o.readOnlyPaths).toContain(bin);
    const hidden = join(home, '.ashlr', 'authority', 'tool');
    mkdirSync(join(home, '.ashlr', 'authority'), { recursive: true });
    writeFileSync(hidden, 'x', { mode: 0o755 });
    const run2 = scratch();
    expect(() => buildAutonomousEnvOverlay({ engine: 'local', runTmpDir: run2.run, home, seatId: null, executables: [hidden] })).toThrow(/protected/);
  });
});

describe('grok / codex state is a per-run snapshot', () => {
  it('copies only the files the CLI needs (0600) and denies the real home', () => {
    const { home, run } = scratch();
    const state = grokSeat(home);
    const o = buildAutonomousEnvOverlay({ engine: 'grok-cli', runTmpDir: run, home, seatId: 'grok-a' });
    const vendor = o.set['GROK_HOME']!;
    expect(vendor).toBe(join(run, 'vendor-home'));
    expect(readFileSync(join(vendor, 'auth.json'), 'utf8')).toBe(grokAuth('user-1', 'refresh-1'));
    expect(lstatSync(join(vendor, 'auth.json')).mode & 0o777).toBe(0o600);
    expect(existsSync(join(vendor, 'config.toml'))).toBe(true);
    expect(existsSync(join(vendor, 'sessions'))).toBe(false);
    expect(existsSync(join(vendor, 'hooks'))).toBe(false);
    expect(o.deniedReadPaths).toContain(realpathSync(state));
    expect(o.vendorState?.[0]).toMatchObject({ envVar: 'GROK_HOME', realHome: realpathSync(state), writeBack: ['auth.json'] });
    expect(o.unset).not.toContain('GROK_HOME');
  });

  it('fails closed without a signed-in seat', () => {
    const { home, run } = scratch();
    expect(() => buildAutonomousEnvOverlay({ engine: 'grok-cli', runTmpDir: run, home, seatId: 'grok-a' })).toThrow(/no pinned GROK_HOME/);
    const state = join(home, 'state');
    mkdirSync(state, { mode: 0o700 });
    chmodSync(state, 0o700);
    const run2 = scratch().run;
    expect(() => buildAutonomousEnvOverlay({ engine: 'grok-cli', runTmpDir: run2, home, seatId: 'grok-a', nativeStatePath: state })).toThrow(/auth\.json/);
  });

  it('writes a refreshed token back only for the same account, and only if nothing else changed it', () => {
    const { home, run } = scratch();
    const state = grokSeat(home);
    const o = buildAutonomousEnvOverlay({ engine: 'grok-cli', runTmpDir: run, home, seatId: 'grok-a' });
    const copy = join(o.set['GROK_HOME']!, 'auth.json');

    expect(commitAutonomousVendorState(o).skipped).toEqual([{ file: join(realpathSync(state), 'auth.json'), reason: 'unchanged' }]);

    writeFileSync(copy, grokAuth('user-1', 'refresh-2'));
    const committed = commitAutonomousVendorState(o);
    expect(committed.committed).toEqual([join(realpathSync(state), 'auth.json')]);
    expect(readFileSync(join(state, 'auth.json'), 'utf8')).toBe(grokAuth('user-1', 'refresh-2'));
    expect(lstatSync(join(state, 'auth.json')).mode & 0o777).toBe(0o600);
  });

  it('refuses a swapped account, a forged identity, a concurrent refresh and garbage', () => {
    const { home, run } = scratch();
    const state = grokSeat(home);
    const o = buildAutonomousEnvOverlay({ engine: 'grok-cli', runTmpDir: run, home, seatId: 'grok-a' });
    const copy = join(o.set['GROK_HOME']!, 'auth.json');
    const real = join(realpathSync(state), 'auth.json');
    const before = readFileSync(real, 'utf8');

    writeFileSync(copy, grokAuth('attacker', 'r'));
    expect(commitAutonomousVendorState(o).skipped[0]!.reason).toMatch(/refused: the account identity changed/);
    // Fields copied from Mason's entry, but the access token is someone else's.
    writeFileSync(copy, grokAuth('user-1', 'r', jwt({ sub: 'attacker', principal_id: 'p1', team_id: 't1' })));
    expect(commitAutonomousVendorState(o).skipped[0]!.reason).toMatch(/different account/);
    writeFileSync(copy, '{not json');
    expect(commitAutonomousVendorState(o).skipped[0]!.reason).toMatch(/refused/);
    expect(readFileSync(real, 'utf8')).toBe(before);

    writeFileSync(copy, grokAuth('user-1', 'refresh-run'));
    writeFileSync(real, grokAuth('user-1', 'refresh-from-masons-session'), { mode: 0o600 });
    expect(commitAutonomousVendorState(o).skipped[0]!.reason).toBe('changed-elsewhere');
    expect(readFileSync(real, 'utf8')).toBe(grokAuth('user-1', 'refresh-from-masons-session'));
  });
});

describe('applyAutonomousEnvOverlay', () => {
  it('drops loader injection and credentials, applies the overlay, keeps unrelated config', () => {
    const { home, run } = scratch();
    const o = buildAutonomousEnvOverlay({ engine: 'local-coder', runTmpDir: run, home, seatId: null, path: '/usr/bin' });
    const env = applyAutonomousEnvOverlay({
      HOME: '/Users/real', DYLD_INSERT_LIBRARIES: '/x.dylib', LD_PRELOAD: '/y.so', GITHUB_TOKEN: 'ghp_x',
      SSH_AUTH_SOCK: '/tmp/agent', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/blocker',
      OLLAMA_HOST: 'http://127.0.0.1:11434',
    }, o);
    expect(env['HOME']).toBe(join(run, 'home'));
    for (const k of ['DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK']) expect(env[k], k).toBeUndefined();
    // The sandboxed engine's pre-push blocker (per-invocation core.hooksPath) survives.
    expect(env['GIT_CONFIG_KEY_0']).toBe('core.hooksPath');
    expect(env['OLLAMA_HOST']).toBe('http://127.0.0.1:11434');
  });
});
