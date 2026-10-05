/**
 * V3.10 integration INT4 — confinement / engines / mirrors / worktrees.
 *
 * Covers the cross-unit requests INT4 implemented:
 *  - B-U2 → U6: an autonomous producer run is assembled by
 *    sandbox/autonomous-run.ts (run dir, overlay, per-run GROK_HOME copy,
 *    hardened profile, same-account write-back, violations, run dir removed);
 *  - B-U7 → U2 / U6: grok-cli under a standing policy execs the pinned binary
 *    directly; the legacy (config opt-in) profile allows the launcher chain
 *    and only the measured grok runtime state; grok NDJSON usage; the
 *    no-diff stall is off for grok; engineModel is `grok-cli:<model>`;
 *  - B-U6 → U2 / worktree owner: daemon git in agent worktrees never runs a
 *    configured program; a run admitted before KILL removes its own worktree;
 *    async removal.
 *
 * Everything runs in the per-worker temp HOME (test/setup/home.ts). The only
 * binaries executed are git, /bin/sh, node (this test runner's) and
 * sandbox-exec; no seat is ever prompted — "grok" is a stand-in script.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ standing: null as null | { grantId: string }, repairChecks:null as null | number }));

vi.mock('../src/core/authority/effective-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/authority/effective-config.js')>();
  return {
    ...actual,
    currentStandingPolicy: () => hoisted.standing as unknown as ReturnType<typeof actual.currentStandingPolicy>,
  };
});

vi.mock('../src/core/run/completeness-gate.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/run/completeness-gate.js')>();
  return {...actual,runCompletenessGate:async (opts:Parameters<typeof actual.runCompletenessGate>[0]) =>
    hoisted.repairChecks===null ? actual.runCompletenessGate(opts) :
      hoisted.repairChecks++===0 ? {pass:false,reason:'fixture requires one confined repair'} : {pass:true}};
});

import type { AshlrConfig, Sandbox } from '../src/core/types.js';
import {
  buildMacosSbplProfile,
  GROK_SEAT_WRITABLE_DIRS,
  nativeSeatConfinement,
} from '../src/core/sandbox/confine.js';
import {
  finishAutonomousSpawn,
  prepareAutonomousSpawn,
  prepareConfinedVerification,
  resolveConfinedExecutable,
} from '../src/core/sandbox/autonomous-run.js';
import {
  __resetGrokCliSeatCacheForTests,
  grokCliDirectCommand,
  grokStreamUsage,
  resolveEngineRegistry,
  resolveGrokCliSeat,
  configForGrokCliSeat,
} from '../src/core/run/engine-registry.js';
import { buildEngineCommand } from '../src/core/run/engines.js';
import { runGoal } from '../src/core/run/orchestrator.js';
import { buildAutonomousEnvOverlay, autonomousVendorIdentityCurrent, commitAutonomousVendorState } from '../src/core/sandbox/autonomous-env.js';
import { engineIdForBin } from '../src/core/policy/local-only.js';
import { prepareResourceNativeProfile } from '../src/core/resources/native-profile.js';
import {
  createSandbox,
  listSandboxes,
  mintOwnSandboxRemovalRight,
  removeSandbox,
  removeSandboxAsync,
  requireVerifiedSandboxGit,
  sandboxDiff,
  SandboxGitVerificationError,
  withDaemonGitHardening,
} from '../src/core/sandbox/worktree.js';
import { setKill } from '../src/core/sandbox/policy.js';
import {
  acquireOutwardMutationFence,
  releaseOutwardMutationFence,
} from '../src/core/sandbox/mutation-fence.js';
import { runEngineSandboxed } from '../src/core/run/sandboxed-engine.js';
import { clearJudgeVerdictCache, judgeProposal, resolveFrontierJudgeClient } from '../src/core/fleet/manager.js';
import { listProposals } from '../src/core/inbox/store.js';
import { makeCfg, withTmpHome } from './helpers/h1-fixture.js';

const DARWIN = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
const SUPPORTS_PROFILES = process.platform !== 'win32' && typeof process.execve === 'function';

let scratch: string[] = [];
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

beforeEach(() => {
  hoisted.standing = null;hoisted.repairChecks = null;
  __resetGrokCliSeatCacheForTests();
});

afterEach(() => {
  hoisted.standing = null;hoisted.repairChecks = null;
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch = [];
  __resetGrokCliSeatCacheForTests();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** A grok auth.json for one account (the shape commitAutonomousVendorState validates). */
function grokAuth(refresh: string, user = 'user-1'): string {
  const claims = { sub: user, principal_id: 'p-1', team_id: 't-1' };
  const jwt = `${b64url({ alg: 'none' })}.${b64url(claims)}.sig`;
  return JSON.stringify({ xai: { user_id: user, principal_id: 'p-1', team_id: 't-1', key: jwt, refresh_token: refresh } });
}

/**
 * Stand-in "grok" (node): does what a confined grok producer would — edits a
 * file in its cwd, writes session state and refreshes its token in GROK_HOME —
 * then probes what the sandbox must deny, and reports as Anthropic-wire NDJSON.
 */
function standInGrokSource(): string {
  return `#!${process.execPath}
const fs = require('fs'); const path = require('path');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const probe = (fn) => { try { fn(); return 'allowed'; } catch (e) { return 'denied:' + (e.code || e.message); } };
const gh = process.env.GROK_HOME;
fs.mkdirSync(path.join(gh, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(gh, 'sessions', 'call.json'), JSON.stringify({ argv: process.argv.slice(2) }));
if (process.argv.includes('--tools=')) {
  // Judge call: answer a verdict, touch nothing else.
  const ship = JSON.stringify({ verdict: 'ship', value: 4, correctness: 4, scope: 1, alignment: 4, rationale: 'fine' });
  out({ type: 'message_start', message: { id: 'j1', model: 'grok-4.7', usage: { input_tokens: 900, output_tokens: 1 } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: ship, usage: { input_tokens: 900, output_tokens: 40 } });
  process.exit(0);
}
fs.mkdirSync(path.join(process.cwd(), 'src'), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), 'src', 'grok-edit.ts'), 'export const editedBy = "grok";\\nexport function double(n: number): number {\\n  return n * 2;\\n}\\n');
fs.mkdirSync(path.join(gh, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(gh, 'sessions', 's1.json'), '{}');
const auth = JSON.parse(fs.readFileSync(path.join(gh, 'auth.json'), 'utf8'));
auth.xai.refresh_token = 'refreshed-token';
fs.writeFileSync(path.join(gh, 'auth.json'), JSON.stringify(auth));
const report = {
  grokHome: gh,
  home: process.env.HOME,
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  readRealState: probe(() => fs.readFileSync(process.env.PROBE_REAL_STATE + '/auth.json')),
  writeRealHome: probe(() => fs.writeFileSync(process.env.PROBE_REAL_HOME + '/escape.txt', 'x')),
  hasXaiKey: 'XAI_API_KEY' in process.env,
};
out({ type: 'message_start', message: { id: 'm1', model: 'grok-4.7', usage: { input_tokens: 100, output_tokens: 1 } } });
out({ type: 'message_delta', usage: { output_tokens: 20 } });
out({ type: 'assistant', message: { id: 'm1', model: 'grok-4.7', content: [{ type: 'text', text: 'step one' }], usage: { input_tokens: 100, output_tokens: 20 } } });
out({ type: 'message_start', message: { id: 'm2', model: 'grok-4.7', usage: { input_tokens: 150, output_tokens: 1 } } });
out({ type: 'message_delta', usage: { output_tokens: 30 } });
out({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'REPORT ' + JSON.stringify(report) }] } });
`;
}

interface Seat {
  base: string;
  accountsRoot: string;
  nativeStatePath: string;
  executable: string;
  command: [string, string];
  cfg: AshlrConfig;
}

function makeSeat(): Seat {
  const base = tempDir('int4-seat-');
  const executable = join(base, 'grok-standin');
  writeFileSync(executable, standInGrokSource(), { mode: 0o700 });
  const accountsRoot = join(base, 'account-connections');
  mkdirSync(accountsRoot, { mode: 0o700 });
  const profiles = join(base, 'native-profiles');
  mkdirSync(profiles, { mode: 0o700 });
  const profile = prepareResourceNativeProfile({ provider: 'grok', directory: join(profiles, 'grok-a'), executable });
  const command = profile.command as [string, string];
  const roster = join(accountsRoot, 'connections.json');
  writeFileSync(roster, JSON.stringify({ schemaVersion: 1, intervalMs: 30_000,
    accounts: [{ id: 'grok-a', provider: 'grok', command, label: 'grok-a' }] }, null, 2), { mode: 0o600 });
  chmodSync(roster, 0o600);
  writeFileSync(join(profile.nativeStatePath, 'auth.json'), grokAuth('original-token'), { mode: 0o600 });
  writeFileSync(join(profile.nativeStatePath, 'config.toml'), 'model = "grok-4.7"\n', { mode: 0o600 });
  const cfg = makeCfg({
    models: { providerChain: [] },
    foundry: {
      completenessGate: false,
      dispatchRetries: 0,
      fleetMcp: false,
      grokCli: { accountsRoot },
    },
  } as unknown as Partial<AshlrConfig>);
  return { base, accountsRoot, nativeStatePath: profile.nativeStatePath, executable, command, cfg };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('grokStreamUsage (B-U7 → U6: producer NDJSON usage)', () => {
  it('prefers the terminal result total', () => {
    const out = [
      JSON.stringify({ type: 'message_start', message: { id: 'a', usage: { input_tokens: 5, output_tokens: 1 } } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'x', usage: { input_tokens: 900, output_tokens: 80 } }),
    ].join('\n');
    expect(grokStreamUsage(out)).toEqual({ tokensIn: 900, tokensOut: 80 });
  });

  it('sums messages once each across events, envelopes and stream_event wrappers', () => {
    const out = [
      'grok: starting (not json)',
      JSON.stringify({ type: 'message_start', message: { id: 'a', usage: { input_tokens: 100, output_tokens: 1 } } }),
      JSON.stringify({ type: 'message_delta', usage: { output_tokens: 20 } }),
      // the same message again as a whole envelope (partial messages on) — not double counted
      JSON.stringify({ type: 'assistant', message: { id: 'a', usage: { input_tokens: 100, output_tokens: 20 } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'b', usage: { input_tokens: 50, output_tokens: 1 } } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 7 } } }),
    ].join('\n');
    expect(grokStreamUsage(out)).toEqual({ tokensIn: 150, tokensOut: 27 });
  });

  it('is null when nothing reports usage', () => {
    expect(grokStreamUsage('plain text\n{"type":"assistant","message":{"content":"hi"}}')).toBeNull();
  });
});

describe('withDaemonGitHardening (B-U6 → U2: hooks / fsmonitor off)', () => {
  it('appends the forced config after existing well-formed entries', () => {
    const env = withDaemonGitHardening({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/tmp/blocker' });
    expect(env.GIT_CONFIG_KEY_0).toBe('core.hooksPath');
    const pairs = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
    // Ours come last, so they win over the inherited hooksPath.
    const lastHooks = pairs.filter(([k]) => k === 'core.hooksPath').pop();
    expect(lastHooks?.[1]).toBe(process.platform === 'win32' ? 'NUL' : '/dev/null');
    expect(pairs).toContainEqual(['core.fsmonitor', 'false']);
  });

  it('replaces a malformed count instead of trusting it', () => {
    const env = withDaemonGitHardening({ GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'x.y', GIT_CONFIG_VALUE_0: '1' });
    expect(env.GIT_CONFIG_KEY_0).toBe('core.hooksPath');
    expect(Object.keys(env).filter((k) => k.startsWith('GIT_CONFIG_KEY_'))).toHaveLength(Number(env.GIT_CONFIG_COUNT));
  });
});

describe('nativeSeatConfinement (B-U7 → U2: the legacy profile and the grok seat)', () => {
  const launch = { command: ['/usr/bin/true', '/seat/grok-a/launcher.mjs'] as [string, string], nativeStatePath: '/seat/grok-a/native-state', executable: '/usr/bin/true' };

  it('allows the launcher chain to read and only the measured runtime state to be written', () => {
    const seat = nativeSeatConfinement(launch, '/seat');
    expect(seat.readPaths).toContain('/seat/grok-a');
    expect(seat.writeSubpaths).toEqual(GROK_SEAT_WRITABLE_DIRS.map((d) => `/seat/grok-a/native-state/${d}`));
    const re = new RegExp(seat.writeRegex!);
    for (const ok of ['auth.json', 'auth.json.lock', 'active_sessions.json', 'worktrees.db', 'worktrees.db-journal', 'models_cache.json', 'leader.lock.sock', 'config.toml.tmp.42']) {
      expect(re.test(`/seat/grok-a/native-state/${ok}`), ok).toBe(true);
    }
    for (const no of ['config.toml', 'agent_id', 'vendor/rg-15.0.0-override', 'bundled/manifest.json', 'README.md', 'sessions/x']) {
      expect(re.test(`/seat/grok-a/native-state/${no}`), no).toBe(false);
    }
  });

  it('emits the seat rules into the M52 profile', () => {
    const profile = buildMacosSbplProfile({ mode: 'os' }, { worktree: '/w', home: '/seat', env: { HOME: '/seat' }, nativeSeat: nativeSeatConfinement(launch, '/seat') });
    expect(profile).toContain('(subpath "/seat/grok-a")');
    expect(profile).toContain('(allow file-write* (regex #"^/seat/grok-a/native-state/(auth\\.json');
    expect(profile).toContain('(allow file-read-metadata');
  });
});

// ---------------------------------------------------------------------------
// Real sandbox-exec
// ---------------------------------------------------------------------------

describe.runIf(DARWIN)('legacy M52 profile with a native seat under real sandbox-exec', () => {
  it('reads the launcher, writes runtime state, never config / vendor code / HOME', () => {
    const root = tempDir('int4-legacy-');
    const home = join(root, 'home');
    const profileDir = join(home, '.ashlr', 'native-profiles', 'grok-a');
    const state = join(profileDir, 'native-state');
    const worktree = join(home, '.ashlr', 'sandboxes', 'sb', 'worktree');
    mkdirSync(join(state, 'vendor'), { recursive: true, mode: 0o700 });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(profileDir, 'launcher.mjs'), '// launcher\n');
    writeFileSync(join(state, 'config.toml'), 'x = 1\n');
    writeFileSync(join(home, 'secret.txt'), 'secret\n');
    const seat = nativeSeatConfinement({ command: ['/usr/bin/true', join(profileDir, 'launcher.mjs')], nativeStatePath: state, executable: '/usr/bin/true' }, home);
    const profile = buildMacosSbplProfile({ mode: 'os' }, { worktree, home, env: { HOME: home, TMPDIR: join(root, 'tmp') }, nativeSeat: seat });
    const script = [
      'r() { if eval "$1" >/dev/null 2>&1; then echo "$2=ok"; else echo "$2=denied"; fi; }',
      `r 'cat "${profileDir}/launcher.mjs"' readLauncher`,
      `r 'echo t > "${state}/auth.json"' writeAuth`,
      `r 'mkdir -p "${state}/sessions" && echo s > "${state}/sessions/s1"' writeSession`,
      `r 'echo t > "${state}/worktrees.db-journal"' writeDbJournal`,
      `r 'echo x > "${state}/config.toml"' writeConfig`,
      `r 'echo x > "${state}/vendor/rg"' writeVendor`,
      `r 'cat "${home}/secret.txt"' readSecret`,
    ].join('\n');
    const r = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', script], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, timeout: 20_000 });
    expect(r.stderr).toBe('');
    const result = Object.fromEntries(r.stdout.trim().split('\n').map((l) => l.split('=')));
    expect(result).toEqual({
      readLauncher: 'ok',
      writeAuth: 'ok',
      writeSession: 'ok',
      writeDbJournal: 'ok',
      writeConfig: 'denied',
      writeVendor: 'denied',
      readSecret: 'denied',
    });
  });
});

describe.runIf(DARWIN && SUPPORTS_PROFILES)('autonomous grok-cli spawn (prepareAutonomousSpawn) under real sandbox-exec', () => {
  it('direct exec of the pinned binary with a per-run GROK_HOME; token written back; run dir removed', () => {
    const seat = makeSeat();
    const cfg = seat.cfg;
    const resolved = resolveEngineRegistry(cfg)['grok-cli']!;
    // The pinned binary is claimed, so local-only classifies the direct exec as grok-cli (metered).
    expect(resolved.bins).toContain(seat.executable);
    expect(engineIdForBin(seat.executable, cfg)).toBe('grok-cli');

    const launcherCmd = { bin: seat.command[0], args: [seat.command[1], '--no-auto-update', '--model', 'grok-4.7'] };
    const direct = grokCliDirectCommand(launcherCmd, cfg)!;
    expect(direct.cmd).toEqual({ bin: seat.executable, args: ['--no-auto-update', '--model', 'grok-4.7'] });
    expect(grokCliDirectCommand({ bin: '/usr/bin/env', args: [seat.command[1]] }, cfg)).toBeNull();

    const home = realpathSync(process.env.HOME!);
    const worktree = join(home, '.ashlr', 'sandboxes', 'int4-direct');
    mkdirSync(worktree, { recursive: true });
    const spawnPrep = prepareAutonomousSpawn({
      engine: 'grok-cli',
      worktree,
      baseEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin', XAI_API_KEY: 'must-not-pass', PROBE_REAL_STATE: seat.nativeStatePath, PROBE_REAL_HOME: home },
      bin: direct.cmd.bin,
      seatId: direct.seatId,
      nativeStatePath: direct.nativeStatePath,
    });
    expect(spawnPrep.env['GROK_HOME']).not.toBe(seat.nativeStatePath);
    expect(spawnPrep.env['GROK_HOME']!.startsWith(spawnPrep.runDir)).toBe(true);
    expect(spawnPrep.env['XAI_API_KEY']).toBeUndefined();
    const r = spawnSync(spawnPrep.launcher.bin, [...spawnPrep.launcher.prefixArgs, spawnPrep.bin, ...direct.cmd.args], {
      cwd: worktree, env: spawnPrep.env, encoding: 'utf8', timeout: 30_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const reportLine = r.stdout.split('\n').find((l) => l.includes('REPORT '))!;
    const report = JSON.parse(JSON.parse(reportLine).message.content[0].text.slice('REPORT '.length));
    expect(report.argv).toEqual(['--no-auto-update', '--model', 'grok-4.7']);
    expect(report.readRealState).toMatch(/^denied/);
    expect(report.writeRealHome).toMatch(/^denied/);
    expect(report.hasXaiKey).toBe(false);
    expect(readFileSync(join(worktree, 'src', 'grok-edit.ts'), 'utf8')).toContain('editedBy = "grok"');
    expect(grokStreamUsage(r.stdout)).toEqual({ tokensIn: 250, tokensOut: 50 });

    const finished = finishAutonomousSpawn(spawnPrep, { output: r.stdout + r.stderr });
    expect(finished.violations).toEqual([]);
    // Same account, refreshed token → written back to the seat's real vendor home.
    expect(finished.vendor.committed).toEqual([join(realpathSync(seat.nativeStatePath), 'auth.json')]);
    expect(JSON.parse(readFileSync(join(seat.nativeStatePath, 'auth.json'), 'utf8')).xai.refresh_token).toBe('refreshed-token');
    // Session state stayed in the (now deleted) per-run copy, never the real home.
    expect(existsSync(join(seat.nativeStatePath, 'sessions'))).toBe(false);
    expect(existsSync(spawnPrep.runDir)).toBe(false);
  });

  it('a tripwire read is reported as a violation', () => {
    const home = realpathSync(process.env.HOME!);
    const worktree = join(home, '.ashlr', 'sandboxes', 'int4-tripwire');
    mkdirSync(worktree, { recursive: true });
    mkdirSync(join(home, '.ashlr', 'authority'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, '.ashlr', 'authority', 'ledger.jsonl'), '{}\n');
    const prep = prepareAutonomousSpawn({ engine: 'local', worktree, baseEnv: { PATH: '/usr/bin:/bin' }, bin: '/bin/sh' });
    const r = spawnSync(prep.launcher.bin, [...prep.launcher.prefixArgs, '/bin/sh', '-c', `/bin/cat "${home}/.ashlr/authority/ledger.jsonl" 2>&1; echo "cat: ${home}/.ashlr/authority/ledger.jsonl: Killed: 9 status=$?"`], {
      cwd: worktree, env: prep.env, encoding: 'utf8', timeout: 20_000,
    });
    expect(r.stdout).toContain('status=137');
    const finished = finishAutonomousSpawn(prep, { output: r.stdout });
    expect(finished.violations).toContain('access ~/.ashlr/authority');
  });

  it('resolves a node_modules script to its package and the node prefix only when jailed', () => {
    const exe = resolveConfinedExecutable('/bin/sh', '/usr/bin:/bin', realpathSync(process.env.HOME!));
    expect(exe.bin).toBe('/bin/sh');
    expect(exe.pathPrepend).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// worktree.ts — daemon git on agent trees, KILL, async removal
// ---------------------------------------------------------------------------

describe('worktree.ts daemon git on agent-touched trees', () => {
  it('never runs a planted hook, fsmonitor or filter driver during create + capture', async () => {
    await withTmpHome(async (fx) => {
      const repo = fx.makeRepo();
      repo.enroll();
      const marker = join(fx.home, 'PWNED');
      const payload = join(fx.home, 'payload.sh');
      writeFileSync(payload, `#!/bin/sh\necho "$0 $*" >> "${marker}"\ncat\n`, { mode: 0o755 });
      // Planted in the SOURCE repo's config — which a linked worktree shares.
      git(repo.dir, ['config', 'core.fsmonitor', payload]);
      git(repo.dir, ['config', 'filter.evil.clean', payload]);
      git(repo.dir, ['config', 'filter.evil.smudge', payload]);
      git(repo.dir, ['config', 'diff.evil.textconv', payload]);
      mkdirSync(join(repo.dir, '.git', 'hooks'), { recursive: true });
      for (const hook of ['post-checkout', 'pre-commit', 'post-index-change', 'reference-transaction']) {
        writeFileSync(join(repo.dir, '.git', 'hooks', hook), `#!/bin/sh\necho ${hook} >> "${marker}"\n`, { mode: 0o755 });
      }
      const sb = createSandbox(repo.dir, { allowAnyRepo: true });
      try {
        // The agent writes attributes routing everything through the planted drivers.
        writeFileSync(join(sb.worktreePath, '.gitattributes'), '* filter=evil diff=evil\n');
        writeFileSync(join(sb.worktreePath, 'new.txt'), 'agent file\n');
        requireVerifiedSandboxGit(sb.id);
        const diff = sandboxDiff(sb);
        expect(diff.files).toBe(2);
        expect(diff.patch).toContain('+agent file');
        expect(existsSync(marker) ? readFileSync(marker, 'utf8') : '').toBe('');
      } finally {
        await removeSandboxAsync(sb);
      }
      expect(existsSync(marker) ? readFileSync(marker, 'utf8') : '').toBe('');
    });
  });

  it('an autonomous capture refuses a .git the daemon did not create', async () => {
    await withTmpHome(async (fx) => {
      const repo = fx.makeRepo();
      repo.enroll();
      const sb = createSandbox(repo.dir, { allowAnyRepo: true });
      try {
        const decoy = fx.makeRepo();
        writeFileSync(join(sb.worktreePath, '.git'), `gitdir: ${join(decoy.dir, '.git')}\n`);
        requireVerifiedSandboxGit(sb.id);
        expect(() => sandboxDiff(sb)).toThrow(SandboxGitVerificationError);
        // Legacy (non-autonomous) runs keep working, still hardened.
        requireVerifiedSandboxGit(sb.id, false);
        expect(() => sandboxDiff(sb)).not.toThrow();
      } finally {
        removeSandbox(sb);
      }
    });
  });
});

describe('worktree.ts: a run admitted before KILL removes its own worktree (B-U6 request 6)', () => {
  it('removes with the right minted at admission, refuses without it, and never for another sandbox', async () => {
    await withTmpHome(async (fx) => {
      const repo = fx.makeRepo();
      repo.enroll();
      const mine = createSandbox(repo.dir, { allowAnyRepo: true });
      const other = createSandbox(repo.dir, { allowAnyRepo: true });
      const fence = acquireOutwardMutationFence();
      const right = mintOwnSandboxRemovalRight(fence, mine);
      releaseOutwardMutationFence(fence);
      expect(right).not.toBeNull();
      try {
        expect(setKill(true, { waitMs: 500 })).toMatchObject({ ok: true });
        // A forged right (same shape, not minted) and another sandbox's removal are refused.
        const forged = { sandboxId: mine.id, pid: process.pid } as unknown as typeof right;
        expect(await removeSandboxAsync(mine, { ownRemovalRight: forged })).toMatchObject({ status: 'unavailable' });
        expect(await removeSandboxAsync(other, { ownRemovalRight: right })).toMatchObject({ status: 'unavailable' });
        expect(await removeSandboxAsync(mine, { ownRemovalRight: right })).toMatchObject({ status: 'complete' });
        expect(listSandboxes().map((s: Sandbox) => s.id)).toEqual([other.id]);
        // No right can be minted while KILL is armed.
        const again = acquireOutwardMutationFence();
        expect(mintOwnSandboxRemovalRight(again, other)).toBeNull();
        releaseOutwardMutationFence(again);
      } finally {
        setKill(false, { waitMs: 500 });
      }
      expect(await removeSandboxAsync(other)).toMatchObject({ status: 'complete' });
      expect(listSandboxes()).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// End to end: an autonomous grok-cli producer through runEngineSandboxed
// ---------------------------------------------------------------------------

describe.runIf(DARWIN && SUPPORTS_PROFILES)('runEngineSandboxed: autonomous grok-cli producer (standing policy live)', () => {
  it.each([false, true, 'repair'] as const)('runs confined with selected-account binding=%s, records model/usage and cleans up', async (bound) => {
    await withTmpHome(async (fx) => {
      const previousAllowAnyRepo = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
      const previousTmpdir = process.env.TMPDIR;
      process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
      try {
        const seat = makeSeat();
        let selectedHome = seat.nativeStatePath;
        if (bound) {
          const b = prepareResourceNativeProfile({ provider: 'grok', directory: join(seat.base, 'native-profiles', 'grok-b'), executable: seat.executable });
          writeFileSync(join(b.nativeStatePath, 'auth.json'), grokAuth('b-original', 'user-b'), { mode: 0o600 });
          writeFileSync(join(seat.accountsRoot, 'connections.json'), JSON.stringify({ schemaVersion: 1, accounts: [
            { id: 'grok-a', provider: 'grok', command: seat.command },
            { id: 'grok-b', provider: 'grok', command: b.command },
          ] }), { mode: 0o600 });
          seat.cfg.foundry!.grokCli = { accountsRoot: seat.accountsRoot, seat: 'grok-a' };
          selectedHome = b.nativeStatePath;
        }
        const repo = fx.makeRepo();
        repo.enroll();
        if (bound==='repair') {
          hoisted.repairChecks = 0;
          seat.cfg.foundry!.completenessGate = true;
          seat.cfg.foundry!.verifyToGreen = {enabled:true,maxIterations:1,perRunTimeoutMs:10_000};
        }
        hoisted.standing = { grantId: 'grant-int4' };
        // Other shards can create ashlr-run-* under the system temp root while
        // this test runs. Scope the cleanup assertion to this fixture's runs.
        const runTmp = join(fx.home, 'run-tmp');
        mkdirSync(runTmp, { mode: 0o700 });
        process.env.TMPDIR = runTmp;
        const beforeTmp = readdirSync(realpathSync(tmpdir())).filter((n) => n.startsWith('ashlr-run-'));
        const admission = vi.fn(() => true);
        const result = await runEngineSandboxed('grok-cli' as never, 'edit a file', seat.cfg, { sourceRepo: repo.dir, propose: true, ...(bound ? { seatId: 'grok-b', selectedGrokAdmission:admission } : {}) });
        expect(admission).toHaveBeenCalledTimes(bound==='repair' ? 3 : bound ? 1 : 0);
        hoisted.standing = null;hoisted.repairChecks = null;
        expect(result.state.engineModel).toBe('grok-cli:grok-4.7');
        expect(result.state.usage).toMatchObject({ tokensIn:bound==='repair' ? 500 : 250, tokensOut:bound==='repair' ? 100 : 50 });
        if (bound==='repair') expect(result.state.runEventSummary?.actionCounts?.verifyRepairAttempts).toBe(1);
        expect(result.proposalOutcome, JSON.stringify({ outcome: result.proposalOutcome, result: result.state.result })).toMatchObject({ kind: 'filed' });
        const proposals = listProposals();
        expect(proposals).toHaveLength(1);
        expect(proposals[0]!.diff).toContain('+export const editedBy = "grok";');
        expect(proposals[0]!.engineModel).toBe('grok-cli:grok-4.7');
        // The token refresh reached the seat's real home; its session state did not.
        expect(JSON.parse(readFileSync(join(selectedHome, 'auth.json'), 'utf8')).xai.refresh_token).toBe('refreshed-token');
        if (bound) {
          expect(JSON.parse(readFileSync(join(selectedHome, 'auth.json'), 'utf8')).xai.user_id).toBe('user-b');
          expect(JSON.parse(readFileSync(join(seat.nativeStatePath, 'auth.json'), 'utf8')).xai.refresh_token).toBe('original-token');
        }
        expect(existsSync(join(seat.nativeStatePath, 'sessions'))).toBe(false);
        // Run dir and sandbox are gone.
        const afterTmp = readdirSync(realpathSync(tmpdir())).filter((n) => n.startsWith('ashlr-run-'));
        expect(afterTmp.filter((n) => !beforeTmp.includes(n))).toEqual([]);
        expect(listSandboxes()).toEqual([]);
      } finally {
        hoisted.standing = null;hoisted.repairChecks = null;
        if (previousTmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmpdir;
        if (previousAllowAnyRepo === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
        else process.env.ASHLR_TEST_ALLOW_ANY_REPO = previousAllowAnyRepo;
      }
    });
  });

  it('rechecks the selected account after a genuine transient attempt and refuses its retry', async () => {
    await withTmpHome(async fx => {
      const previous = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
      process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
      const seat = makeSeat();const repo = fx.makeRepo();repo.enroll();
      writeFileSync(seat.executable,`#!${process.execPath}\nprocess.stdout.write('network error\\n');process.exit(1);\n`,{mode:0o700});
      seat.cfg.foundry!.dispatchRetries = 1;
      hoisted.standing = {grantId:'grant-int4'};
      let attempts = 0;
      const admission = vi.fn(() => attempts++===0);
      try {
        const result = await runEngineSandboxed('grok-cli','refuse the second spawn',seat.cfg,{sourceRepo:repo.dir,seatId:'grok-a',selectedGrokAdmission:admission});
        expect(admission).toHaveBeenCalledTimes(2);
        expect(result.state.runEventSummary?.actionCounts).toMatchObject({spawnAttempts:1,transientRetries:1});
        expect(result.state.result).toContain('selected Grok account authority, profile or identity changed');
        expect(listProposals()).toHaveLength(0);expect(listSandboxes()).toHaveLength(0);
      } finally {
        hoisted.standing = null;
        if (previous===undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
        else process.env.ASHLR_TEST_ALLOW_ANY_REPO = previous;
      }
    });
  });

  it.each(['revoked', 'unreadable', 'profile-replaced', 'identity-replaced', 'grant-ended-before-confinement'] as const)(
    'refuses selected-account %s at the final post-setup fence without spawning or falling back', async kind => {
      await withTmpHome(async fx => {
        const previousAllowAnyRepo = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
        process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
        const seat = makeSeat();
        const repo = fx.makeRepo();repo.enroll();
        hoisted.standing = kind==='grant-ended-before-confinement' ? null : {grantId:'grant-int4'};
        const admission = vi.fn(() => {
          if (kind==='unreadable') throw new Error('fixture unavailable');
          if (kind==='profile-replaced') writeFileSync(seat.command[1], '#!/bin/sh\nexit 0\n', {mode:0o700});
          if (kind==='identity-replaced') writeFileSync(join(seat.nativeStatePath,'auth.json'),grokAuth('other-token','other-user'),{mode:0o600});
          return kind!=='revoked';
        });
        try {
          const result = await runEngineSandboxed('grok-cli','should never edit',seat.cfg,{sourceRepo:repo.dir,seatId:'grok-a',selectedGrokAdmission:admission});
          expect(admission).toHaveBeenCalledTimes(kind==='grant-ended-before-confinement' ? 0 : 1);
          expect(result.state.runEventSummary?.actionCounts?.spawnAttempts ?? 0).toBe(0);
          expect(result.state.result).toContain(kind==='grant-ended-before-confinement' ? 'standing authority no longer supports autonomous confinement' : 'selected Grok account authority, profile or identity changed');
          expect(result.state.usage.tokensIn).toBe(0);
          expect(listProposals()).toHaveLength(0);
          expect(listSandboxes()).toHaveLength(0);
          expect(existsSync(join(seat.nativeStatePath,'sessions'))).toBe(false);
        } finally {
          hoisted.standing = null;hoisted.repairChecks = null;
          if (previousAllowAnyRepo===undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
          else process.env.ASHLR_TEST_ALLOW_ANY_REPO = previousAllowAnyRepo;
        }
      });
    },
  );

  it('refuses a Claude producer without selected native-profile proof under a standing policy', async () => {
    await withTmpHome(async (fx) => {
      const previousAllowAnyRepo = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
      process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
      try {
        const repo = fx.makeRepo();
        repo.enroll();
        hoisted.standing = { grantId: 'grant-int4' };
        const result = await runEngineSandboxed('claude', 'edit a file', makeCfg({ models: { providerChain: [] }, foundry: { fleetMcp: false, completenessGate: false } } as unknown as Partial<AshlrConfig>), { sourceRepo: repo.dir, propose: true });
        expect(result.proposalOutcome).toMatchObject({ kind: 'engine-unsupported' });
        expect(result.proposalOutcome?.reason).toBe('Claude producers require a selected native profile, current host authority and fresh native account/credit-protection proof');
        expect(listSandboxes()).toEqual([]);
      } finally {
        hoisted.standing = null;hoisted.repairChecks = null;
        if (previousAllowAnyRepo === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
        else process.env.ASHLR_TEST_ALLOW_ANY_REPO = previousAllowAnyRepo;
      }
    });
  });
});

describe.runIf(DARWIN && SUPPORTS_PROFILES)('judge calls under a standing policy (B-U2 → U7)', () => {
  it('a grok-cli judge runs confined on a per-run GROK_HOME copy and still returns a considered verdict', async () => {
    const seat = makeSeat();
    clearJudgeVerdictCache();
    hoisted.standing = { grantId: 'grant-int4' };
    try {
      const client = resolveFrontierJudgeClient(seat.cfg, { producerModel: 'local-coder:qwen3', requireIndependent: true })!;
      expect(client.model).toBe('grok-cli:grok-4.7');
      const verdict = await judgeProposal({
        id: 'prop-int4-judge',
        repo: '/nonexistent/int4-repo',
        origin: 'backlog',
        kind: 'patch',
        title: 'int4 judge fixture',
        summary: 'a small change',
        status: 'pending',
        createdAt: '2026-09-24T00:00:00.000Z',
        diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n',
        engineModel: 'local-coder:qwen3.8:27b-ctx64k',
        engineTier: 'mid',
      } as never, {} as AshlrConfig, client, { recordTrace: false });
      expect(verdict).toMatchObject({ considered: true, verdict: 'ship' });
      expect(client.stats).toMatchObject({ model: 'grok-cli:grok-4.7', tokensIn: 900, tokensOut: 40 });
      // Unconfined, the stand-in would have written sessions/ into the seat's REAL
      // GROK_HOME; confined, it wrote into the per-run copy, now deleted.
      expect(existsSync(join(seat.nativeStatePath, 'sessions'))).toBe(false);
    } finally {
      hoisted.standing = null;hoisted.repairChecks = null;
    }
  });
});

describe.runIf(DARWIN)('prepareConfinedVerification (B-U3 → U2: G3 on agent code)', () => {
  it('the suite writes its worktree, reads its read-only extras, and nothing else of HOME', () => {
    const home = realpathSync(process.env.HOME!);
    const worktree = join(home, '.ashlr', 'tmp', 'vwt-int4');
    const mirrorModules = join(home, '.ashlr', 'fleet', 'mirrors', 'acme__app', 'node_modules');
    mkdirSync(worktree, { recursive: true });
    mkdirSync(mirrorModules, { recursive: true });
    writeFileSync(join(mirrorModules, 'dep.js'), 'module.exports = 1;\n');
    mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'secret\n');
    const v = prepareConfinedVerification({ worktree, baseEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin', GITHUB_TOKEN: 'must-not-pass' }, readOnly: [mirrorModules] });
    try {
      expect(v.env['GITHUB_TOKEN']).toBeUndefined();
      const script = [
        'r() { if eval "$1" >/dev/null 2>&1; then echo "$2=ok"; else echo "$2=denied"; fi; }',
        `r 'echo t > out.txt' writeWorktree`,
        `r 'cat "${mirrorModules}/dep.js"' readModules`,
        `r 'echo x > "${mirrorModules}/dep.js"' writeModules`,
        `r 'cat "${home}/.ssh/id_ed25519"' readSsh`,
        `r 'node -e 0' node`,
      ].join('\n');
      const r = spawnSync(v.prefix[0]!, [...v.prefix.slice(1), '/bin/sh', '-c', script], { cwd: worktree, env: v.env, encoding: 'utf8', timeout: 30_000 });
      const result = Object.fromEntries(r.stdout.trim().split('\n').map((l) => l.split('=')));
      expect(result).toEqual({ writeWorktree: 'ok', readModules: 'ok', writeModules: 'denied', readSsh: 'denied', node: 'ok' });
    } finally {
      v.dispose();
    }
    expect(existsSync(v.runDir)).toBe(false);
  });
});


describe.runIf(SUPPORTS_PROFILES)('selected Grok native account binding without provider calls', () => {
  function twoSeats() {
    const a = makeSeat();
    const b = prepareResourceNativeProfile({ provider: 'grok', directory: join(a.base, 'native-profiles', 'grok-b'), executable: a.executable });
    const auth = JSON.parse(grokAuth('b-original'));
    auth.xai.user_id = 'user-b';
    auth.xai.key = `${b64url({ alg: 'none' })}.${b64url({ sub: 'user-b', principal_id: 'p-1', team_id: 't-1' })}.sig`;
    writeFileSync(join(b.nativeStatePath, 'auth.json'), JSON.stringify(auth), { mode: 0o600 });
    writeFileSync(join(a.accountsRoot, 'connections.json'), JSON.stringify({ schemaVersion: 1, accounts: [
      { id: 'grok-a', provider: 'grok', command: a.command },
      { id: 'grok-b', provider: 'grok', command: b.command },
    ] }), { mode: 0o600 });
    a.cfg.foundry!.grokCli = { accountsRoot: a.accountsRoot, seat: 'grok-a' };
    return { a, b };
  }

  it('uses B despite configured A and writes refresh only back to B', () => {
    const { a, b } = twoSeats();
    const cfg = configForGrokCliSeat(a.cfg, 'grok-b');
    expect(a.cfg.foundry!.grokCli).toMatchObject({ seat: 'grok-a' });
    expect(resolveGrokCliSeat(a.cfg).ok).toBe(true);
    const command = buildEngineCommand('grok-cli', 'fixture goal', cfg, { autonomous: true, seatId: 'grok-b' })!;
    expect(command.args[0]).toBe(b.launcherPath);
    expect(grokCliDirectCommand(command, cfg, 'grok-a')).toBeNull();
    const direct = grokCliDirectCommand(command, cfg, 'grok-b')!;
    expect(direct).toMatchObject({ seatId: 'grok-b', nativeStatePath: b.nativeStatePath });
    const root = tempDir('int4-bound-overlay-');const home = join(root, 'home');const run = join(root, 'run');
    mkdirSync(home, { mode: 0o700 });mkdirSync(run, { mode: 0o700 });
    const overlay = buildAutonomousEnvOverlay({ engine: 'grok-cli', home, runTmpDir: run, seatId: direct.seatId, nativeStatePath: direct.nativeStatePath });
    expect(autonomousVendorIdentityCurrent(overlay)).toBe(true);
    const copied = JSON.parse(readFileSync(join(overlay.set.GROK_HOME!, 'auth.json'), 'utf8'));
    expect(copied.xai.user_id).toBe('user-b');copied.xai.refresh_token = 'b-refreshed';
    writeFileSync(join(overlay.set.GROK_HOME!, 'auth.json'), JSON.stringify(copied));
    expect(autonomousVendorIdentityCurrent(overlay)).toBe(true);
    expect(commitAutonomousVendorState(overlay).committed).toEqual([join(b.nativeStatePath, 'auth.json')]);
    expect(JSON.parse(readFileSync(join(a.nativeStatePath, 'auth.json'), 'utf8')).xai.refresh_token).toBe('original-token');
  });

  it.each(['missing', 'wrong-provider', 'changed-launcher'] as const)('refuses %s selected profile without choosing configured A', (kind) => {
    const { a, b } = twoSeats();
    // Warm discovery cache, then change the explicit profile: execution must reread.
    expect(resolveGrokCliSeat(configForGrokCliSeat(a.cfg, 'grok-b')).ok).toBe(true);
    const selected = kind === 'missing' ? 'missing-seat' : 'grok-b';
    if (kind === 'wrong-provider') {
      const p = join(a.accountsRoot, 'connections.json');const roster = JSON.parse(readFileSync(p, 'utf8'));
      roster.accounts[1].provider = 'codex';writeFileSync(p, JSON.stringify(roster));
    }
    if (kind === 'changed-launcher') writeFileSync(b.launcherPath, readFileSync(b.launcherPath, 'utf8') + '\n// changed');
    expect(buildEngineCommand('grok-cli', 'fixture', a.cfg, { seatId: selected })).toBeNull();
    expect(resolveGrokCliSeat(a.cfg, undefined, selected).ok).toBe(false);
  });

  it('refuses a profile race between command construction and direct execution', () => {
    const { a, b } = twoSeats();const command = buildEngineCommand('grok-cli', 'fixture', a.cfg, { seatId: 'grok-b' })!;
    rmSync(b.directory, { recursive: true });
    expect(grokCliDirectCommand(command, a.cfg, 'grok-b')).toBeNull();
  });

  it('refuses explicit missing-account run before builtin fallback', async () => {
    const { a } = twoSeats();
    await expect(runGoal('fixture never execute', a.cfg, { engine: 'grok-cli', seatId: 'missing-account', requireSandbox: true }))
      .rejects.toThrow(/default-account and builtin fallback refused/);
  });
});
