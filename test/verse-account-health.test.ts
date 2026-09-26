/**
 * V3.10 unit A2 — seat account health (core/verse/account-health.ts,
 * seat-readiness.ts, health-api.ts, and the seats.ts readiness gate).
 *
 * Hermetic: HOME is the per-worker tmp home (test/setup/home.ts); every
 * accounts root, profile, credential file and CLI install dir is a tmp fixture;
 * every status command is an injected fake. No vendor CLI runs, no Terminal
 * opens, no real ~/.ashlr is touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import type { VerseSeat, VerseSeatCapacity, VerseSeatWindow } from '../src/core/verse/types.js';
import type { SeatHealthReport } from '../src/core/verse/health-types.js';
import {
  buildReconnectScript,
  buildSeatHealthReports,
  claudeKeychainService,
  createSeatHealthSweep,
  credentialExpiring,
  getVerseHealthService,
  homeRelative,
  jwtExpiry,
  newestClaudeBuild,
  newestGrokBuild,
  openSeatLogin,
  parseCliVersionOutput,
  parseCodexLoginStatus,
  parseKeychainModifiedAt,
  readCodexCredentialFacts,
  readGrokCredentialFacts,
  readNativeAccounts,
  readNativeProfileManifest,
  seatLoginCommand,
  VERSE_CREDENTIAL_WARN_MS,
  type SeatAccountFacts,
  type SeatHealthProbes,
  type SeatHealthSweepSnapshot,
} from '../src/core/verse/account-health.js';
import { rankSeatAlternatives, seatBlock, seatReadiness, seatReopening } from '../src/core/verse/seat-readiness.js';
import { getSeatReadiness, seatUsability } from '../src/core/verse/seats.js';
import {
  handleHealthApi,
  RECONNECT_COOLDOWN_MS,
  startVerseHealth,
  stopVerseHealth,
} from '../src/core/verse/health-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-09-23T20:00:00.000Z');
let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-seat-health-test-')));
});

afterEach(() => {
  stopVerseHealth();
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

function fakeJwt(payload: Record<string, unknown>): string {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(payload)}.SIGNATURE_SECRET_PART`;
}

function window(id: string, usedPercent: number | null, over: Partial<VerseSeatWindow> = {}): VerseSeatWindow {
  return { id, usedPercent, resetsAt: null, resetDescription: null, limitReached: false, measured: true, ...over };
}

function capacity(over: Partial<VerseSeatCapacity> = {}): VerseSeatCapacity {
  const windows = over.windows ?? [window('primary', 20)];
  return {
    planType: 'pro',
    binding: windows.reduce<VerseSeatWindow | null>((best, w) =>
      w.usedPercent !== null && (best === null || w.usedPercent > (best.usedPercent ?? -1)) ? w : best, null),
    windows,
    credits: null,
    usability: 'ready',
    observedAt: new Date(NOW - 60_000).toISOString(),
    evidenceSource: 'collector',
    notes: [],
    ...over,
  };
}

function seat(id: string, engine: VerseSeat['engine'], over: Partial<VerseSeat> = {}): VerseSeat {
  return {
    id,
    engine,
    label: over.label ?? id,
    accountId: engine === 'local' ? 'local' : id,
    models: [{ id: `${id}-model`, label: 'Model', contextWindow: 200_000 }],
    contextWindow: 200_000,
    health: { state: 'ready', summary: null, windows: [], observedAt: new Date(NOW - 60_000).toISOString() },
    ...(engine === 'local' ? {} : { capacity: capacity() }),
    ...over,
  };
}

function facts(accountId: string, provider: SeatAccountFacts['provider'], over: Partial<SeatAccountFacts> = {}): SeatAccountFacts {
  return {
    accountId,
    provider,
    checkedAt: new Date(NOW - 30_000).toISOString(),
    loggedIn: true,
    probeReason: 'status-login-observed',
    cliVersion: null,
    newest: null,
    profileDirectory: null,
    credential: { expiresAt: null, lastRefreshAt: null, refreshable: null },
    ...over,
  };
}

function snapshot(accounts: SeatAccountFacts[], ollama: Partial<SeatHealthSweepSnapshot['ollama']> = {}): SeatHealthSweepSnapshot {
  return {
    sweptAt: new Date(NOW - 30_000).toISOString(),
    sweeping: false,
    sweeps: 1,
    accounts: new Map(accounts.map((f) => [f.accountId, f])),
    ollama: { baseUrl: 'http://127.0.0.1:11434', reachable: true, version: '0.33.3', checkedAt: new Date(NOW).toISOString(), ...ollama },
  };
}

function reportOf(seats: VerseSeat[], snap: SeatHealthSweepSnapshot, id: string): SeatHealthReport {
  const found = buildSeatHealthReports({ seats, snapshot: snap, now: NOW }).find((r) => r.seatId === id);
  if (!found) throw new Error(`no report for ${id}`);
  return found;
}

/** A prepared native profile on disk: launcher.mjs + profile.json + native-state. */
function makeProfile(name: string, provider: 'claude' | 'codex' | 'grok', executable: string): { command: string[]; directory: string; state: string } {
  const directory = path.join(root, 'native-profiles', name);
  const state = path.join(directory, 'native-state');
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'launcher.mjs'), '// fixture launcher\n');
  fs.writeFileSync(path.join(directory, 'profile.json'), JSON.stringify({
    provider, directory, executable, nativeStatePath: state,
    loginCommand: ['/usr/bin/node', path.join(directory, 'launcher.mjs'), 'SHOULD_NOT_BE_USED'],
  }));
  return { command: ['/usr/bin/node', path.join(directory, 'launcher.mjs')], directory, state };
}

function writeRoster(accountsRoot: string, accounts: Array<{ id: string; label: string; provider: string; command: string[] }>): void {
  fs.mkdirSync(accountsRoot, { recursive: true });
  fs.writeFileSync(path.join(accountsRoot, 'connections.json'), JSON.stringify({ accounts }));
}

function executableFile(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\n');
  fs.chmodSync(file, 0o755);
}

function fakeProbes(over: Partial<SeatHealthProbes> = {}): SeatHealthProbes & { calls: string[] } {
  const calls: string[] = [];
  const probes: SeatHealthProbes = {
    claudeLogin: async () => { calls.push('claude'); return { loggedIn: true, reason: 'status-login-observed' }; },
    codexLogin: async () => { calls.push('codex'); return { loggedIn: true, reason: 'status-login-observed' }; },
    grokLogin: async () => { calls.push('grok'); return { loggedIn: true, reason: 'probe-observed' }; },
    claudeKeychainRefreshedAt: async () => { calls.push('keychain'); return '2026-09-23T21:00:52.000Z'; },
    cliVersion: async () => { calls.push('version'); return null; },
    ollamaVersion: async () => { calls.push('ollama'); return '0.33.3'; },
    ...over,
  };
  return Object.assign(probes, { calls });
}

// ---------------------------------------------------------------------------
// Credential timestamps — never the credential
// ---------------------------------------------------------------------------

describe('credential facts are timestamps only', () => {
  it('reads codex last_refresh and the access token exp, and returns no token material', () => {
    const state = path.join(root, 'codex-state');
    fs.mkdirSync(state);
    const access = fakeJwt({ exp: Date.parse('2026-09-30T05:23:57Z') / 1000, secret: 'ACCESS_PAYLOAD_SECRET' });
    fs.writeFileSync(path.join(state, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt', OPENAI_API_KEY: null,
      tokens: { id_token: fakeJwt({ exp: 1 }), access_token: access, refresh_token: 'REFRESH_SECRET', account_id: 'ACCOUNT_SECRET' },
      last_refresh: '2026-09-20T05:23:57.209696Z',
    }));
    const out = readCodexCredentialFacts(state);
    expect(out).toEqual({ expiresAt: '2026-09-30T05:23:57.000Z', lastRefreshAt: '2026-09-20T05:23:57.209Z', refreshable: true });
    expect(JSON.stringify(out)).not.toMatch(/SECRET|eyJ/);
  });

  it('reads grok expires_at/create_time from the newest issuer entry and whether it can refresh', () => {
    const state = path.join(root, 'grok-state');
    fs.mkdirSync(state);
    fs.writeFileSync(path.join(state, 'auth.json'), JSON.stringify({
      'https://auth.x.ai::old': { key: fakeJwt({ exp: 1 }), create_time: '2026-09-01T00:00:00Z', expires_at: '2026-09-01T06:00:00Z' },
      'https://auth.x.ai::new': { key: fakeJwt({ exp: 2 }), create_time: '2026-09-23T21:00:51.758457Z',
        expires_at: '2026-09-24T03:00:51.758457Z', refresh_token: 'REFRESH_SECRET', email: 'PRIVATE_EMAIL' },
    }));
    const out = readGrokCredentialFacts(state);
    expect(out).toEqual({ expiresAt: '2026-09-24T03:00:51.758Z', lastRefreshAt: '2026-09-23T21:00:51.758Z', refreshable: true });
    expect(JSON.stringify(out)).not.toMatch(/SECRET|PRIVATE/);
  });

  it('is unknown (all null), never zero, for missing, oversized or malformed files', () => {
    const empty = { expiresAt: null, lastRefreshAt: null, refreshable: null };
    expect(readCodexCredentialFacts(path.join(root, 'nope'))).toEqual(empty);
    const state = path.join(root, 'bad');
    fs.mkdirSync(state);
    fs.writeFileSync(path.join(state, 'auth.json'), '{not json');
    expect(readCodexCredentialFacts(state)).toEqual(empty);
    expect(readGrokCredentialFacts(state)).toEqual(empty);
    fs.writeFileSync(path.join(state, 'auth.json'), 'x'.repeat(300 * 1024));
    expect(readCodexCredentialFacts(state)).toEqual(empty);
  });

  it('decodes only a well-formed JWT exp', () => {
    expect(jwtExpiry(fakeJwt({ exp: 1_800_000_000 }))).toBe(new Date(1_800_000_000 * 1000).toISOString());
    for (const bad of [null, 7, 'a.b', 'a.b.c', fakeJwt({ exp: 'soon' }), fakeJwt({ exp: -1 }), fakeJwt({})]) {
      expect(jwtExpiry(bad)).toBeNull();
    }
  });

  it('names the Claude keychain item as sha256(config dir)[:8] and reads only mdat', () => {
    const dir = '/Users/example/.ashlr/native-profiles/claude-a/native-state';
    const hash = createHash('sha256').update(dir).digest('hex').slice(0, 8);
    expect(claudeKeychainService(dir)).toBe(`Claude Code-credentials-${hash}`);
    const output = [
      'keychain: "/Users/example/Library/Keychains/login.keychain-db"',
      'attributes:',
      '    "acct"<blob>="PRIVATE_ACCOUNT"',
      '    "cdat"<timedate>=0x32303236303930383230333131365A00  "20260908203116Z\\000"',
      '    "mdat"<timedate>=0x32303236303932333231303035325A00  "20260923210052Z\\000"',
    ].join('\n');
    expect(parseKeychainModifiedAt(output)).toBe('2026-09-23T21:00:52.000Z');
    expect(parseKeychainModifiedAt('no attributes')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Status output + installed builds
// ---------------------------------------------------------------------------

describe('status parsing and installed builds', () => {
  it('parses codex login status by its leading words only', () => {
    expect(parseCodexLoginStatus('Logged in using ChatGPT\n', '', 0)).toBe(true);
    expect(parseCodexLoginStatus('', 'Not logged in\n', 1)).toBe(false);
    expect(parseCodexLoginStatus('Not logged in', '', 1)).toBe(false);
    expect(parseCodexLoginStatus('Logged in using ChatGPT', '', 2)).toBeNull();
    expect(parseCodexLoginStatus('error: config', '', 1)).toBeNull();
  });

  it('parses a version out of --version output', () => {
    expect(parseCliVersionOutput('codex-cli 0.155.0-alpha.9.2\n')).toBe('0.155.0-alpha.9.2');
    expect(parseCliVersionOutput('2.1.280 (Claude Code)')).toBe('2.1.280');
    expect(parseCliVersionOutput('nothing')).toBeNull();
  });

  it('finds the newest grok download and skips the unversioned one', () => {
    const downloads = path.join(root, 'grok-downloads');
    executableFile(path.join(downloads, 'grok-0.2.106-macos-aarch64'));
    executableFile(path.join(downloads, 'grok-0.2.118-macos-aarch64'));
    executableFile(path.join(downloads, 'grok-macos-aarch64'));
    fs.writeFileSync(path.join(downloads, 'grok-0.9.0-macos-aarch64.partial'), '');
    expect(newestGrokBuild(downloads)).toEqual({ version: '0.2.118', executable: path.join(downloads, 'grok-0.2.118-macos-aarch64') });
    expect(newestGrokBuild(path.join(root, 'missing'))).toBeNull();
  });

  it('finds the newest claude version file', () => {
    const versions = path.join(root, 'claude-versions');
    for (const v of ['2.1.243', '2.1.280', '2.1.257']) executableFile(path.join(versions, v));
    fs.writeFileSync(path.join(versions, '2.1.999.lock'), '');
    expect(newestClaudeBuild(versions)).toEqual({ version: '2.1.280', executable: path.join(versions, '2.1.280') });
  });
});

// ---------------------------------------------------------------------------
// Roster + profile
// ---------------------------------------------------------------------------

describe('roster and profile', () => {
  it('reads the account roster with launchers, skipping malformed rows', () => {
    const accountsRoot = path.join(root, 'accounts');
    writeRoster(accountsRoot, [
      { id: 'claude', label: 'Claude Code', provider: 'claude', command: ['/n', '/l.mjs'] },
      { id: 'claude', label: 'dupe', provider: 'claude', command: ['/n'] },
      { id: 'x', label: 'bad provider', provider: 'gemini', command: ['/n'] },
      { id: 'y', label: 'no command', provider: 'codex', command: [] },
    ]);
    expect(readNativeAccounts(accountsRoot)).toEqual([{ id: 'claude', label: 'Claude Code', provider: 'claude', command: ['/n', '/l.mjs'] }]);
    expect(readNativeAccounts(path.join(root, 'missing'))).toEqual([]);
  });

  it('reads a profile manifest and refuses one for another provider', () => {
    const profile = makeProfile('codex-a', 'codex', '/opt/codex');
    expect(readNativeProfileManifest(profile.command, 'codex')).toEqual({
      directory: profile.directory, nativeStatePath: profile.state, executable: '/opt/codex',
    });
    expect(readNativeProfileManifest(profile.command, 'grok')).toBeNull();
    expect(readNativeProfileManifest(['/usr/bin/node', 'relative/launcher.mjs'], 'codex')).toBeNull();
  });

  it('builds the login argv from the launcher, never from profile.json', () => {
    const profile = makeProfile('claude-a', 'claude', '/opt/claude');
    expect(seatLoginCommand({ command: profile.command, provider: 'claude' })).toEqual([...profile.command, 'auth', 'login', '--claudeai']);
    expect(seatLoginCommand({ command: profile.command, provider: 'codex' })).toEqual([...profile.command, 'login']);
    expect(seatLoginCommand({ command: profile.command, provider: 'grok' })).toEqual([...profile.command, '--no-auto-update', 'login', '--oauth']);
  });
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

describe('buildSeatHealthReports', () => {
  it('reports a signed-in seat with nothing wrong as connected, with no reasons', () => {
    const seats = [seat('claude', 'claude', { cliVersion: '2.1.280' })];
    const report = reportOf(seats, snapshot([facts('claude', 'claude', { cliVersion: '2.1.280',
      newest: { version: '2.1.280', executable: '/v/2.1.280' } })]), 'claude');
    expect(report).toMatchObject({ connection: 'connected', reasons: [], fix: { kind: 'none' }, cliVersion: '2.1.280',
      newestCliVersion: '2.1.280', resetAt: null, engine: 'claude' });
    expect(report.checkedAt).toBe(new Date(NOW).toISOString());
  });

  it('flags a sweep sign-out as signed-out with a reauth fix that withholds the launcher', () => {
    const report = reportOf([seat('codex-personal', 'codex')], snapshot([facts('codex-personal', 'codex', {
      loggedIn: false, probeReason: 'status-not-logged-in', checkedAt: new Date(NOW - 1000).toISOString() })]), 'codex-personal');
    expect(report.connection).toBe('signed-out');
    expect(report.fix).toEqual({ kind: 'reauth' });
    expect(report.reasons[0]).toContain('not signed in');
  });

  it('lets the NEWER witness win when the sweep and the live collector disagree', () => {
    // Collector saw signed-out 5 min ago; the sweep saw signed-in 30 s ago → connected.
    const liveOut = seat('claude', 'claude', {
      health: { state: 'unavailable', summary: null, windows: [], observedAt: new Date(NOW - 300_000).toISOString() },
      capacity: capacity({ usability: 'signed-out', observedAt: new Date(NOW - 300_000).toISOString(), windows: [] }),
    });
    expect(reportOf([liveOut], snapshot([facts('claude', 'claude')]), 'claude').connection).toBe('connected');
    // Sweep saw signed-out 10 min ago; the collector read windows 1 min ago → connected.
    const liveIn = seat('claude', 'claude');
    const stale = facts('claude', 'claude', { loggedIn: false, checkedAt: new Date(NOW - 600_000).toISOString() });
    expect(reportOf([liveIn], snapshot([stale]), 'claude').connection).toBe('connected');
    // The collector's sign-out is newer than the sweep's sign-in → signed-out.
    const liveOutNew = seat('grok', 'grok', {
      health: { state: 'unavailable', summary: null, windows: [], observedAt: new Date(NOW - 5_000).toISOString() },
      capacity: capacity({ usability: 'signed-out', observedAt: new Date(NOW - 5_000).toISOString(), windows: [] }),
    });
    expect(reportOf([liveOutNew], snapshot([facts('grok', 'grok')]), 'grok').connection).toBe('signed-out');
  });

  it('reports an exhausted codex seat with the time it actually reopens (its LATEST spent-window reset) and a wait fix', () => {
    // Both windows are at 100, so `binding` is the FIRST (the earlier reset).
    // The seat is still spent at 18:25 — it reopens only when the secondary
    // window resets too, which is what Accounts and Fleet say.
    const spent = [
      window('codex_primary', 100, { limitReached: true, measured: false, resetsAt: '2026-09-25T18:25:00.000Z' }),
      window('codex_secondary', 100, { resetsAt: '2026-09-26T00:00:00.000Z' }),
    ];
    const s = seat('codex-personal', 'codex', { capacity: capacity({ windows: spent, usability: 'exhausted' }) });
    expect(s.capacity?.binding?.id).toBe('codex_primary');
    const report = reportOf([s], snapshot([facts('codex-personal', 'codex')]), 'codex-personal');
    expect(report.connection).toBe('exhausted');
    expect(report.fix).toEqual({ kind: 'wait' });
    expect(report.resetAt).toBe('2026-09-26T00:00:00.000Z');
  });

  it('picks the latest spent reset regardless of provider order, and ignores windows that are not spent', () => {
    const windows = [
      window('codex_secondary', 100, { resetsAt: '2026-09-30T00:00:00.000Z' }),
      window('codex_primary', 100, { limitReached: true, measured: false, resetsAt: '2026-09-25T18:25:00.000Z' }),
      // Not spent: its later reset must not delay the answer.
      window('codex_other', 40, { resetsAt: '2026-10-09T00:00:00.000Z' }),
    ];
    const s = seat('codex-personal', 'codex', { capacity: capacity({ windows, usability: 'exhausted' }) });
    const report = reportOf([s], snapshot([facts('codex-personal', 'codex')]), 'codex-personal');
    expect(report.resetAt).toBe('2026-09-30T00:00:00.000Z');
    expect(seatBlock(s, null, NOW)?.resetAt).toBe('2026-09-30T00:00:00.000Z');
  });

  it('gives no reset instant when any spent window only has provider prose, and shows that prose', () => {
    const windows = [
      window('five_hour', 100, { resetsAt: '2026-09-25T18:25:00.000Z' }),
      window('seven_day', 100, { resetDescription: 'resets Sep 30 at 7pm (America/New_York)' }),
    ];
    const s = seat('claude', 'claude', { capacity: capacity({ windows, usability: 'exhausted' }) });
    const report = reportOf([s], snapshot([facts('claude', 'claude')]), 'claude');
    expect(report.resetAt).toBeNull();
    expect(report.reasons[0]).toContain('resets Sep 30 at 7pm (America/New_York)');
    expect(seatBlock(s, null, NOW)).toMatchObject({ resetAt: null,
      reason: 'claude is out of usage — resets Sep 30 at 7pm (America/New_York).' });
  });

  it('seatReopening: no capacity, nothing spent, a flagged denial and an unparseable reset', () => {
    expect(seatReopening(null)).toEqual({ resetAt: null, resetDescription: null });
    expect(seatReopening(undefined)).toEqual({ resetAt: null, resetDescription: null });
    // Nothing spent: the binding window's own reset, as before.
    const open = capacity({ windows: [
      window('five_hour', 30, { resetsAt: '2026-09-25T18:25:00.000Z' }),
      window('seven_day', 70, { resetsAt: '2026-09-30T00:00:00.000Z' }),
    ] });
    expect(seatReopening(open)).toEqual({ resetAt: '2026-09-30T00:00:00.000Z', resetDescription: null });
    // A Codex denial flag is spent whatever its percent reads; the open window does not count.
    const flagged = capacity({ windows: [
      window('codex_primary', 60, { limitReached: true, resetsAt: '2026-09-25T18:25:00.000Z' }),
      window('codex_secondary', 40, { resetsAt: '2026-10-01T00:00:00.000Z' }),
    ] });
    expect(seatReopening(flagged).resetAt).toBe('2026-09-25T18:25:00.000Z');
    // A garbage instant on a spent window is unknown, never a guess.
    const garbled = capacity({ windows: [
      window('codex_primary', 100, { resetsAt: '2026-09-25T18:25:00.000Z' }),
      window('codex_secondary', 100, { resetsAt: 'soon' }),
    ] });
    expect(seatReopening(garbled)).toEqual({ resetAt: null, resetDescription: null });
  });

  it('keeps Claude prose resets verbatim and never invents a reset instant', () => {
    const spent = [window('seven_day', 100, { resetDescription: 'resets Sep 25 at 7pm (America/New_York)' })];
    const s = seat('claude', 'claude', { capacity: capacity({ windows: spent, usability: 'exhausted' }) });
    const report = reportOf([s], snapshot([facts('claude', 'claude')]), 'claude');
    expect(report.connection).toBe('exhausted');
    expect(report.resetAt).toBeNull();
    expect(report.reasons[0]).toContain('resets Sep 25 at 7pm (America/New_York)');
  });

  it('warns about an expiring codex credential but not about grok’s self-refreshing six-hour key', () => {
    const soon = new Date(NOW + VERSE_CREDENTIAL_WARN_MS - 3_600_000).toISOString();
    const codex = facts('codex-personal', 'codex', { credential: { expiresAt: soon, lastRefreshAt: '2026-09-15T00:00:00Z', refreshable: true } });
    const codexReport = reportOf([seat('codex-personal', 'codex')], snapshot([codex]), 'codex-personal');
    expect(codexReport.connection).toBe('expiring');
    expect(codexReport.fix).toEqual({ kind: 'reauth' });
    expect(codexReport.credentialExpiresAt).toBe(soon);
    expect(codexReport.lastRefreshAt).toBe('2026-09-15T00:00:00Z');

    const grokKey = new Date(NOW + 3 * 3_600_000).toISOString();
    const refreshing = facts('grok', 'grok', { credential: { expiresAt: grokKey, lastRefreshAt: null, refreshable: true } });
    expect(reportOf([seat('grok', 'grok')], snapshot([refreshing]), 'grok').connection).toBe('connected');
    const stuck = facts('grok', 'grok', { credential: { expiresAt: grokKey, lastRefreshAt: null, refreshable: false } });
    expect(reportOf([seat('grok', 'grok')], snapshot([stuck]), 'grok').connection).toBe('expiring');
    expect(credentialExpiring('claude', { expiresAt: grokKey, lastRefreshAt: null, refreshable: false }, NOW)).toBe(false);
  });

  it('reports binary skew with a copyable, home-relative repin command and warns about floating installs', () => {
    const home = os.homedir();
    const f = facts('codex-personal', 'codex', {
      cliVersion: '0.136.0',
      newest: { version: '0.155.0-alpha.9.2', executable: '/Applications/ChatGPT.app/Contents/Resources/codex' },
      profileDirectory: path.join(home, '.ashlr', 'native-profiles', 'codex-a'),
    });
    const report = reportOf([seat('codex-personal', 'codex')], snapshot([f]), 'codex-personal');
    expect(report.connection).toBe('binary-skew');
    expect(report.fix).toEqual({ kind: 'repin', command: ['ashlr', 'resources', 'profile', 'repin',
      '--directory', '~/.ashlr/native-profiles/codex-a', '--executable', '/Applications/ChatGPT.app/Contents/Resources/codex'] });
    expect(report.reasons.join(' ')).toContain('updater replaces it');
    expect(homeRelative(path.join(home, 'x', 'y'))).toBe('~/x/y');
  });

  it('ranks signed-out above exhausted above expiring above skew', () => {
    const s = seat('codex-personal', 'codex', { capacity: capacity({ windows: [window('p', 100)], usability: 'exhausted' }) });
    const everything = facts('codex-personal', 'codex', {
      loggedIn: false,
      credential: { expiresAt: new Date(NOW + 1000).toISOString(), lastRefreshAt: null, refreshable: true },
      cliVersion: '0.1.0', newest: { version: '0.2.0', executable: '/x/codex' },
    });
    expect(reportOf([s], snapshot([everything]), 'codex-personal').connection).toBe('signed-out');
    expect(reportOf([s], snapshot([{ ...everything, loggedIn: true }]), 'codex-personal').connection).toBe('exhausted');
    const fresh = seat('codex-personal', 'codex');
    expect(reportOf([fresh], snapshot([{ ...everything, loggedIn: true }]), 'codex-personal').connection).toBe('expiring');
  });

  it('is unknown — not connected — when nothing has witnessed a sign-in', () => {
    const blind = seat('grok', 'grok', {
      health: { state: 'unknown', summary: null, windows: [], observedAt: null },
      capacity: capacity({ windows: [], usability: 'unknown', observedAt: null, evidenceSource: 'none' }),
    });
    const never = reportOf([blind], snapshot([]), 'grok');
    expect(never.connection).toBe('unknown');
    expect(never.reasons[0]).toContain('has not reached this seat');
    const timedOut = reportOf([blind], snapshot([facts('grok', 'grok', { loggedIn: null, probeReason: 'probe-timed-out' })]), 'grok');
    expect(timedOut.connection).toBe('unknown');
    expect(timedOut.reasons[0]).toContain('timed out');
  });

  it('reports local seats from the Ollama check only', () => {
    const local = seat('local:qwen3.8:27b', 'local');
    expect(reportOf([local], snapshot([]), local.id)).toMatchObject({ connection: 'connected', reasons: [], cliVersion: null });
    const down = reportOf([local], snapshot([], { reachable: false }), local.id);
    expect(down.connection).toBe('unknown');
    expect(down.reasons[0]).toContain('Ollama is not answering');
    expect(reportOf([local], snapshot([], { reachable: null, checkedAt: null }), local.id)).toMatchObject({ connection: 'unknown', reasons: [] });
  });
});

// ---------------------------------------------------------------------------
// Usability: keep Codex's limitReached
// ---------------------------------------------------------------------------

describe('seatUsability keeps Codex limitReached', () => {
  const base = { state: 'observed' as const, credits: null };
  it('treats a surviving Codex limit flag as exhaustion even beside a window with headroom', () => {
    const windows = [
      { id: 'codex_primary', usedPercent: 100, resetsAt: null, nativeReport: null, limitReached: true, measured: false },
      { id: 'codex_secondary', usedPercent: 40, resetsAt: null, nativeReport: null, limitReached: false, measured: true },
    ];
    const binding = { id: 'codex_primary', usedPercent: 100, limitReached: true };
    expect(seatUsability({ ...base, provider: 'codex', windows, binding })).toBe('exhausted');
    // Credits are spendable past the window.
    expect(seatUsability({ ...base, provider: 'codex', windows, binding,
      credits: { hasCredits: true, unlimited: false, balance: '12.5' } })).toBe('tight');
    // Claude's per-model window stays "tight": a spent window is not a spent account.
    expect(seatUsability({ ...base, provider: 'claude', windows, binding })).toBe('tight');
  });
});

// ---------------------------------------------------------------------------
// Readiness + alternatives
// ---------------------------------------------------------------------------

describe('seat readiness', () => {
  const roster = (): VerseSeat[] => [
    seat('codex-personal', 'codex', { label: 'Personal Codex', capacity: capacity({ usability: 'exhausted',
      windows: [window('codex_primary', 100, { resetsAt: '2026-09-25T18:25:00.000Z' })] }) }),
    seat('claude', 'claude', { label: 'Claude Code', capacity: capacity({ usability: 'tight', windows: [window('five_hour', 92)] }) }),
    seat('local:qwen', 'local', { label: 'Qwen (local)' }),
    seat('grok', 'grok', { label: 'Grok', capacity: capacity({ usability: 'ready', windows: [window('grok_weekly', 30)] }) }),
    seat('codex-cmp', 'codex', { label: 'CMP Codex', capacity: capacity({ usability: 'ready', windows: [window('codex_primary', 60)] }) }),
    seat('no-models', 'codex', { models: [{ id: 'm', label: 'M', contextWindow: 1, unavailableReason: 'needs newer CLI' }] }),
    seat('unreachable', 'claude', { health: { state: 'unavailable', summary: 'down', windows: [], observedAt: null } }),
  ];

  it('refuses an exhausted seat with a reset and ranks alternatives: same engine, headroom, then tight, then local', () => {
    const readiness = seatReadiness('codex-personal', roster(), null, NOW);
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toMatch(/^Personal Codex is out of usage — resets /);
    expect(readiness.alternatives).toEqual(['codex-cmp', 'grok', 'claude', 'local:qwen']);
  });

  it('refuses a signed-out seat from its health report', () => {
    const reports: SeatHealthReport[] = [{ seatId: 'grok', engine: 'grok', connection: 'signed-out', checkedAt: '', cliVersion: null,
      newestCliVersion: null, credentialExpiresAt: null, lastRefreshAt: null, resetAt: null, reasons: [], fix: { kind: 'reauth' } }];
    const readiness = seatReadiness('grok', roster(), reports, NOW);
    expect(readiness).toMatchObject({ ready: false, reason: 'Grok is signed out — reconnect it to use this seat.' });
    expect(readiness.alternatives).not.toContain('grok');
    expect(readiness.alternatives).not.toContain('codex-personal');
  });

  it('never refuses on warnings or on no evidence, and knows nothing about a missing seat', () => {
    for (const connection of ['unknown', 'expiring', 'binary-skew', 'connected'] as const) {
      const reports: SeatHealthReport[] = [{ seatId: 'grok', engine: 'grok', connection, checkedAt: '', cliVersion: null,
        newestCliVersion: null, credentialExpiresAt: null, lastRefreshAt: null, resetAt: null, reasons: ['x'], fix: { kind: 'none' } }];
      expect(seatReadiness('grok', roster(), reports, NOW).ready, connection).toBe(true);
    }
    expect(seatReadiness('ghost', roster(), null, NOW)).toEqual({ seatId: 'ghost', ready: true, reason: null, alternatives: [] });
  });

  it('does not offer a local seat while Ollama is not answering', () => {
    const reports: SeatHealthReport[] = [{ seatId: 'local:qwen', engine: 'local', connection: 'unknown', checkedAt: '', cliVersion: null,
      newestCliVersion: null, credentialExpiresAt: null, lastRefreshAt: null, resetAt: null,
      reasons: ['Ollama is not answering'], fix: { kind: 'none' } }];
    expect(rankSeatAlternatives('codex-personal', roster(), reports, NOW)).not.toContain('local:qwen');
  });

  it('uses the seat’s own capacity when no report exists, including the Claude prose reset', () => {
    const claude = seat('claude', 'claude', { label: 'Claude Code', capacity: capacity({ usability: 'exhausted',
      windows: [window('seven_day', 100, { resetDescription: 'resets Sep 25 at 7pm (America/New_York)' })] }) });
    expect(seatBlock(claude, null, NOW)?.reason).toBe('Claude Code is out of usage — resets Sep 25 at 7pm (America/New_York).');
    expect(seatBlock(seat('local:x', 'local'), null, NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

describe('createSeatHealthSweep', () => {
  function rosterOnDisk(): { accountsRoot: string; claudeVersions: string; grokDownloads: string } {
    const accountsRoot = path.join(root, 'accounts');
    const claudeVersions = path.join(root, 'claude-versions');
    const grokDownloads = path.join(root, 'grok-downloads');
    executableFile(path.join(claudeVersions, '2.1.257'));
    executableFile(path.join(claudeVersions, '2.1.280'));
    executableFile(path.join(grokDownloads, 'grok-0.2.118-macos-aarch64'));
    const claude = makeProfile('claude-a', 'claude', path.join(claudeVersions, '2.1.257'));
    const codex = makeProfile('codex-a', 'codex', path.join(root, 'codex-bin', 'codex'));
    executableFile(path.join(root, 'codex-bin', 'codex'));
    const grok = makeProfile('grok-a', 'grok', path.join(grokDownloads, 'grok-0.2.118-macos-aarch64'));
    fs.writeFileSync(path.join(codex.state, 'auth.json'), JSON.stringify({
      tokens: { access_token: fakeJwt({ exp: Date.parse('2026-09-30T05:23:57Z') / 1000 }), refresh_token: 'REFRESH_SECRET' },
      last_refresh: '2026-09-20T05:23:57Z',
    }));
    writeRoster(accountsRoot, [
      { id: 'claude', label: 'Claude Code', provider: 'claude', command: claude.command },
      { id: 'codex-personal', label: 'Personal Codex', provider: 'codex', command: codex.command },
      { id: 'grok', label: 'Grok', provider: 'grok', command: grok.command },
    ]);
    return { accountsRoot, claudeVersions, grokDownloads };
  }

  it('runs one status command per account, one at a time, and records timestamps and builds', async () => {
    const { accountsRoot, claudeVersions, grokDownloads } = rosterOnDisk();
    let active = 0;
    let peak = 0;
    const serial = <T>(value: T) => async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return value;
    };
    const cwds: string[] = [];
    const probes = fakeProbes({
      claudeLogin: async (_c, cwd) => { cwds.push(cwd); return serial({ loggedIn: true, reason: 'status-login-observed' })(); },
      codexLogin: serial({ loggedIn: false, reason: 'status-not-logged-in' }),
      grokLogin: serial({ loggedIn: true, reason: 'probe-observed' }),
      cliVersion: async () => '0.155.0',
    });
    const sweep = createSeatHealthSweep({ accountsRoot, ollamaBaseUrl: 'http://127.0.0.1:1', probes,
      claudeVersionsRoot: claudeVersions, grokDownloadsRoot: grokDownloads, codexCandidates: () => [path.join(root, 'codex-bin', 'codex')] });
    const snap = await sweep.sweep();
    expect(peak).toBe(1);
    expect(snap.sweeps).toBe(1);
    const claude = snap.accounts.get('claude')!;
    expect(claude).toMatchObject({ loggedIn: true, cliVersion: '2.1.257', newest: { version: '2.1.280' } });
    expect(claude.credential.lastRefreshAt).toBe('2026-09-23T21:00:52.000Z');
    const codex = snap.accounts.get('codex-personal')!;
    expect(codex).toMatchObject({ loggedIn: false, probeReason: 'status-not-logged-in', cliVersion: '0.155.0' });
    expect(codex.credential).toEqual({ expiresAt: '2026-09-30T05:23:57.000Z', lastRefreshAt: '2026-09-20T05:23:57.000Z', refreshable: true });
    expect(snap.accounts.get('grok')).toMatchObject({ loggedIn: true, cliVersion: '0.2.118', newest: { version: '0.2.118' } });
    expect(snap.ollama).toMatchObject({ reachable: true, version: '0.33.3' });
    // The private scratch cwd was fresh, 0700 and is gone afterwards.
    expect(cwds).toHaveLength(1);
    expect(fs.existsSync(cwds[0]!)).toBe(false);
    expect(JSON.stringify([...snap.accounts.values()])).not.toContain('REFRESH_SECRET');
  });

  it('turns a throwing probe into "no answer" and drops accounts removed from the roster', async () => {
    const { accountsRoot } = rosterOnDisk();
    const probes = fakeProbes({ grokLogin: async () => { throw new Error('boom /Users/secret/path'); } });
    const sweep = createSeatHealthSweep({ accountsRoot, ollamaBaseUrl: 'http://x', probes, codexCandidates: () => [] });
    const first = await sweep.sweep();
    expect(first.accounts.get('grok')).toMatchObject({ loggedIn: null, probeReason: 'status-process-failed' });
    writeRoster(accountsRoot, []);
    const second = await sweep.sweep();
    expect(second.accounts.size).toBe(0);
    expect(second.sweeps).toBe(2);
  });

  it('sweeps on its own cadence with nobody asking, joins overlapping calls, and stops cleanly', async () => {
    vi.useFakeTimers();
    const { accountsRoot } = rosterOnDisk();
    const probes = fakeProbes();
    const sweep = createSeatHealthSweep({ accountsRoot, ollamaBaseUrl: 'http://x', probes, intervalMs: 600_000,
      initialDelayMs: 1_000, codexCandidates: () => [] });
    sweep.start();
    sweep.start(); // idempotent
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(sweep.snapshot().sweeps).toBe(1));
    await vi.advanceTimersByTimeAsync(600_000);
    await vi.waitFor(() => expect(sweep.snapshot().sweeps).toBe(2));
    const a = sweep.sweep();
    const b = sweep.sweep();
    expect(a).toBe(b);
    await a;
    sweep.stop();
    const after = sweep.snapshot().sweeps;
    await vi.advanceTimersByTimeAsync(3 * 600_000);
    expect(sweep.snapshot().sweeps).toBe(after);
  });
});

// ---------------------------------------------------------------------------
// Reconnect
// ---------------------------------------------------------------------------

describe('reconnect', () => {
  it('writes a self-deleting, fully quoted script that execs the seat login', () => {
    const script = buildReconnectScript(['/usr/bin/node', "/Users/o'neil/launcher.mjs", 'auth', 'login', '--claudeai'], "Mason's $(Claude)\u0007");
    expect(script.split('\n')[0]).toBe('#!/bin/sh');
    expect(script).toContain('rm -f -- "$0"');
    expect(script).toContain(`exec '/usr/bin/node' '/Users/o'\\''neil/launcher.mjs' 'auth' 'login' '--claudeai'`);
    // The label is quoted: $(…) is printed, never executed; control chars are dropped.
    expect(script).toContain("'Ashlr Verse: signing in Mason'\\''s $(Claude). Follow the prompts; Verse never sees your credentials.'");
    expect(script).not.toContain('\u0007');
  });

  it('writes the script 0700 in a 0700 dir and hands it to Terminal; refuses off macOS', async () => {
    const opened: string[] = [];
    const dir = path.join(root, 'health');
    const account = { id: 'claude', label: 'Claude Code', provider: 'claude' as const, command: ['/usr/bin/node', '/p/launcher.mjs'] };
    await openSeatLogin({ account, dir, platform: 'darwin', open: async (file) => { opened.push(file); } });
    expect(opened).toHaveLength(1);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(opened[0]!).mode & 0o777).toBe(0o700);
    expect(path.basename(opened[0]!)).toMatch(/^reconnect-claude-[0-9a-f]{8}\.command$/);
    expect(fs.readFileSync(opened[0]!, 'utf8')).toContain("exec '/usr/bin/node' '/p/launcher.mjs' 'auth' 'login' '--claudeai'");
    await expect(openSeatLogin({ account, dir, platform: 'linux', open: async () => {} })).rejects.toThrow(/macOS only/);
  });
});

// ---------------------------------------------------------------------------
// The API module + the engine gate
// ---------------------------------------------------------------------------

function cfg(): AshlrConfig {
  return {
    version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [],
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://127.0.0.1:1', providerChain: ['ollama'] },
    telemetry: {}, tools: {},
  } as AshlrConfig;
}

interface Captured { status: number; body: unknown }

function call(
  ctx: VerseApiContext,
  method: string,
  urlPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ handled: boolean; res: Captured }> {
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  (req as { method?: string }).method = method;
  (req as { url?: string }).url = urlPath;
  (req as { headers: Record<string, string> }).headers = {
    'x-ashlr-token': ctx.token, 'content-type': 'application/json', ...headers,
  };
  const captured: Captured = { status: 0, body: undefined };
  const state = { headersSent: false };
  const res = {
    get headersSent() { return state.headersSent; },
    writeHead(status: number) { captured.status = status; state.headersSent = true; return res; },
    end(payload?: string) { captured.body = payload ? JSON.parse(payload) : undefined; return res; },
  } as unknown as ServerResponse;
  const done = handleHealthApi(ctx, req, res, urlPath, method);
  (req as unknown as PassThrough).end(body === undefined ? '' : JSON.stringify(body));
  return done.then((handled) => ({ handled, res: captured }));
}

describe('handleHealthApi + getSeatReadiness', () => {
  function setup(probeOver: Partial<SeatHealthProbes> = {}) {
    const accountsRoot = path.join(root, 'accounts');
    const claude = makeProfile('claude-a', 'claude', '/nonexistent/claude/2.1.280');
    const codex = makeProfile('codex-a', 'codex', '/nonexistent/codex');
    fs.writeFileSync(path.join(codex.state, 'auth.json'), JSON.stringify({
      tokens: { access_token: fakeJwt({ exp: 1_900_000_000 }), refresh_token: 'REFRESH_SECRET' }, last_refresh: '2026-09-20T05:23:57Z',
    }));
    writeRoster(accountsRoot, [
      { id: 'claude', label: 'Claude Code', provider: 'claude', command: claude.command },
      { id: 'codex-personal', label: 'Personal Codex', provider: 'codex', command: codex.command },
    ]);
    const seats: VerseSeat[] = [
      seat('claude', 'claude', { label: 'Claude Code' }),
      seat('codex-personal', 'codex', { label: 'Personal Codex' }),
      seat('local:qwen', 'local', { label: 'Qwen (local)' }),
    ];
    const opened: string[] = [];
    const probes = fakeProbes({ claudeLogin: async () => ({ loggedIn: false, reason: 'status-not-logged-in' }), ...probeOver });
    const ctx: VerseApiContext = { cfg: cfg(), token: 'TOKEN', allowDispatch: true };
    startVerseHealth(ctx.cfg, {
      accountsRoot, probes, initialDelayMs: 60_000, codexCandidates: () => [],
      claudeVersionsRoot: path.join(root, 'no-versions'), grokDownloadsRoot: path.join(root, 'no-grok'),
      discover: async () => ({ seats, launches: new Map(), localRuntime: { ollama: { reachable: true, baseUrl: 'http://x', models: [] } } }),
      openLogin: async (file) => { opened.push(file); },
      platform: 'darwin',
      reconnectDir: path.join(root, 'reconnect'),
    });
    return { ctx, opened, claude };
  }

  it('fails open before any health service exists', () => {
    stopVerseHealth();
    expect(getVerseHealthService()).toBeNull();
    expect(getSeatReadiness('claude')).toEqual({ seatId: 'claude', ready: true, reason: null, alternatives: [] });
  });

  it('GET returns one report per seat, sanitized, with no launcher or credential material', async () => {
    const { ctx, claude } = setup();
    await getVerseHealthService()!.sweep.sweep();
    const { handled, res } = await call(ctx, 'GET', '/api/verse/health');
    expect(handled).toBe(true);
    expect(res.status).toBe(200);
    const body = res.body as { checkedAt: string; seats: SeatHealthReport[] };
    expect(body.seats.map((r) => [r.seatId, r.connection])).toEqual([
      ['claude', 'signed-out'], ['codex-personal', 'connected'], ['local:qwen', 'connected'],
    ]);
    const text = JSON.stringify(body);
    expect(text).not.toContain(claude.command[1]!);
    expect(text).not.toContain('launcher.mjs');
    expect(text).not.toMatch(/REFRESH_SECRET|eyJ/);
  });

  it('gates the engine: a signed-out seat is refused with ranked alternatives', async () => {
    setup();
    await getVerseHealthService()!.sweep.sweep();
    // The discovery promise resolves on the microtask queue.
    await vi.waitFor(() => expect(getVerseHealthService()!.current().seats.length).toBe(3));
    const readiness = getSeatReadiness('claude');
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toContain('signed out');
    expect(readiness.alternatives[0]).toBe('codex-personal');
    expect(getSeatReadiness('codex-personal').ready).toBe(true);
  });

  it('answers only its own paths', async () => {
    const { ctx } = setup();
    expect((await call(ctx, 'GET', '/api/verse/seats')).handled).toBe(false);
    expect((await call(ctx, 'GET', '/api/verse/healthz')).handled).toBe(false);
    expect((await call(ctx, 'GET', '/api/verse/health/other')).res.status).toBe(404);
    expect((await call(ctx, 'POST', '/api/verse/health', {})).res.status).toBe(405);
    expect((await call(ctx, 'GET', '/api/verse/health/reconnect')).res.status).toBe(405);
  });

  it('reconnect: gated, validated, opens the seat login once per cooldown', async () => {
    const { ctx, opened } = setup();
    expect((await call({ ...ctx, allowDispatch: false }, 'POST', '/api/verse/health/reconnect', { seatId: 'claude' })).res.status).toBe(404);
    expect((await call(ctx, 'POST', '/api/verse/health/reconnect', { seatId: 'claude' }, { 'x-ashlr-token': 'wrong' })).res.status).toBe(401);
    expect((await call(ctx, 'POST', '/api/verse/health/reconnect', { seatId: 'claude', extra: 1 })).res.status).toBe(400);
    expect((await call(ctx, 'POST', '/api/verse/health/reconnect', { seatId: '' })).res.status).toBe(400);
    expect((await call(ctx, 'POST', '/api/verse/health/reconnect', { seatId: 'local:qwen' })).res.status).toBe(404);

    const ok = await call(ctx, 'POST', '/api/verse/health/reconnect', { seatId: 'claude' });
    expect(ok.res).toEqual({ status: 202, body: { ok: true, seatId: 'claude' } });
    expect(opened).toHaveLength(1);
    expect(fs.readFileSync(opened[0]!, 'utf8')).toMatch(/exec '\/usr\/bin\/node' '.*launcher\.mjs' 'auth' 'login' '--claudeai'/);
    expect(JSON.stringify(ok.res.body)).not.toContain('launcher');

    const again = await call(ctx, 'POST', '/api/verse/health/reconnect', { seatId: 'claude' });
    expect(again.res.status).toBe(429);
    expect(opened).toHaveLength(1);
    expect(RECONNECT_COOLDOWN_MS).toBeGreaterThanOrEqual(5_000);
  });

  it('refresh runs a sweep now and returns the fresh reports', async () => {
    let claudeCalls = 0;
    const { ctx } = setup({ claudeLogin: async () => { claudeCalls += 1; return { loggedIn: true, reason: 'status-login-observed' }; } });
    const { res } = await call(ctx, 'POST', '/api/verse/health/refresh', {});
    expect(res.status).toBe(200);
    expect(claudeCalls).toBe(1);
    const body = res.body as { seats: SeatHealthReport[] };
    expect(body.seats.find((r) => r.seatId === 'claude')?.connection).toBe('connected');
    // A second refresh inside the minimum gap reuses the sweep it just ran.
    await call(ctx, 'POST', '/api/verse/health/refresh', {});
    expect(claudeCalls).toBe(1);
  });
});
