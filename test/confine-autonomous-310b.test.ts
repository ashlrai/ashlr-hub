/**
 * V3.10 Track B unit U2 — the forced autonomous confinement profile
 * (src/core/sandbox/confine.ts). Pure: profile text, forcing and helpers.
 * The same profiles are exercised under real sandbox-exec in
 * confine-autonomous-darwin-310b.test.ts.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const standing = vi.hoisted(() => ({ live: false as boolean | 'throw' }));
vi.mock('../src/core/authority/effective-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/authority/effective-config.js')>();
  return {
    ...actual,
    currentStandingPolicy: () => {
      if (standing.live === 'throw') throw new Error('authority state unreadable');
      return standing.live ? ({ v: 1 } as unknown as ReturnType<typeof actual.currentStandingPolicy>) : null;
    },
  };
});

import {
  AUTONOMOUS_DENIED_EXECUTABLES,
  AUTONOMOUS_DENIED_MACH_SERVICES,
  AUTONOMOUS_DENIED_OPERATIONS,
  ConfinementUnsupportedError,
  SANDBOX_EXEC_PATH,
  autonomousConfinementProfile,
  autonomousTripwirePaths,
  autonomousVerificationProfile,
  buildAutonomousSbplProfile,
  buildSandboxLauncher,
  confinementProfileFor,
  isSandboxTripwireKill,
  sandboxViolationsInOutput,
} from '../src/core/sandbox/confine.js';
import { buildAutonomousEnvOverlay } from '../src/core/sandbox/autonomous-env.js';
import type { AshlrConfig } from '../src/core/types.js';

afterEach(() => {
  standing.live = false;
});

function world(engine = 'local-coder') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'confine-auto-')));
  const home = join(root, 'home');
  const worktree = join(home, '.ashlr', 'sandboxes', 'sb1');
  const run = join(root, 'run');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(run, { mode: 0o700 });
  const overlay = buildAutonomousEnvOverlay({ engine, runTmpDir: run, home, seatId: null, path: '/usr/bin:/bin' });
  return { root, home, worktree, run, overlay };
}

describe('forced while a standing policy is live', () => {
  const cfg = { foundry: { confinement: { '*': { mode: 'off' } } } } as unknown as AshlrConfig;

  it('config decides when no standing policy exists (master behaviour)', () => {
    expect(confinementProfileFor('claude', cfg)).toEqual({ mode: 'off' });
    expect(confinementProfileFor('claude', {} as AshlrConfig)).toEqual({ mode: 'off' });
  });

  it('config is ignored while a policy is live — even mode off', () => {
    standing.live = true;
    expect(confinementProfileFor('claude', cfg)).toMatchObject({ mode: 'os', onUnsupported: 'fail', autonomous: true, networkEgress: true });
    expect(confinementProfileFor('local-coder', cfg)).toMatchObject({ autonomous: true, networkEgress: false, loopbackPorts: [11434, 8080] });
  });

  it('confines when the authority state cannot be read', () => {
    standing.live = 'throw';
    expect(confinementProfileFor('grok-cli', cfg)).toMatchObject({ autonomous: true });
  });

  it('gives egress to frontier CLI engines only (unknown engines get none)', () => {
    expect(autonomousConfinementProfile('grok-cli').networkEgress).toBe(true);
    expect(autonomousConfinementProfile('claude-cli').networkEgress).toBe(true);
    expect(autonomousConfinementProfile('codex').networkEgress).toBe(true);
    expect(autonomousConfinementProfile('ashlrcode').networkEgress).toBe(false);
    expect(autonomousConfinementProfile('some-new-engine').networkEgress).toBe(false);
  });
});

describe('buildSandboxLauncher (autonomous)', () => {
  it.runIf(process.platform === 'darwin')('uses the absolute sandbox-exec and the hardened profile', () => {
    const w = world();
    const launcher = buildSandboxLauncher(autonomousConfinementProfile('local-coder'), { worktree: w.worktree, home: w.home, overlay: w.overlay });
    expect(launcher?.bin).toBe(SANDBOX_EXEC_PATH);
    expect(launcher?.prefixArgs[0]).toBe('-p');
    expect(launcher?.prefixArgs[1]).toContain('autonomous profile');
  });

  it('has no fallback: missing overlay or a worktree containing HOME is an error', () => {
    const w = world();
    const profile = autonomousConfinementProfile('local-coder');
    expect(() => buildAutonomousSbplProfile(profile, { worktree: w.worktree, home: w.home })).toThrow(ConfinementUnsupportedError);
    expect(() => buildAutonomousSbplProfile(profile, { worktree: w.root, home: w.home, overlay: w.overlay })).toThrow(/home directory/);
    expect(() => buildAutonomousSbplProfile({ ...profile, loopbackPorts: [70000] }, { worktree: w.worktree, home: w.home, overlay: w.overlay }))
      .toThrow(/loopback port/);
  });
});

describe('the autonomous profile text', () => {
  const lines = (profile: string) => profile.split('\n');
  const indexOf = (profile: string, needle: string) => lines(profile).findIndex((l) => l.includes(needle));

  it('jails reads to the worktree, the run dir and named paths — with ancestors for realpath()', () => {
    const w = world();
    const p = buildAutonomousSbplProfile(autonomousConfinementProfile('local-coder'), { worktree: w.worktree, home: w.home, overlay: w.overlay });
    expect(p).toContain(`(deny file-read* (subpath "${w.home}") (subpath "/Users") (subpath "/Volumes") (subpath "/private/tmp")`);
    expect(p).toMatch(new RegExp(`\\(allow file-read\\* \\(subpath "${w.worktree}"\\) \\(subpath "${w.run}"\\)`));
    expect(p).toContain(`(literal "${w.home}/.ashlr/sandboxes")`);
    expect(indexOf(p, '(allow file-read*')).toBeGreaterThan(indexOf(p, '(deny file-read* (subpath'));
  });

  it('denies every write but the worktree and run dir, and never the worktree .git', () => {
    const w = world();
    const p = buildAutonomousSbplProfile(autonomousConfinementProfile('local-coder'), { worktree: w.worktree, home: w.home, overlay: w.overlay });
    expect(p).toContain('(deny file-write*)');
    expect(p).toContain(`(allow file-write* (subpath "${w.worktree}") (subpath "${w.run}"))`);
    expect(p).toContain(`(deny file-write* (literal "${w.worktree}/.git") (subpath "${w.worktree}/.git"))`);
    expect(indexOf(p, `(literal "${w.worktree}/.git")`)).toBeGreaterThan(indexOf(p, `(allow file-write* (subpath "${w.worktree}")`));
  });

  it('puts the protected paths, tripwires, execs, mach services and operations LAST', () => {
    const w = world();
    const p = buildAutonomousSbplProfile(autonomousConfinementProfile('local-coder'), { worktree: w.worktree, home: w.home, overlay: w.overlay });
    const lastAllow = Math.max(...lines(p).map((l, i) => (l.startsWith('(allow file-') ? i : -1)));
    const tripwire = indexOf(p, '(with send-signal SIGKILL)');
    expect(tripwire).toBeGreaterThan(lastAllow);
    const helperPath = '/usr/local/libexec/ashlr-custody';
    for (const t of autonomousTripwirePaths(w.home).filter((t) => t !== helperPath)) expect(lines(p)[tripwire]).toContain(`"${t}"`);
    // The helper: reading its bytes or writing it trips; a stat does not.
    expect(p).toContain(`(deny file-read-data file-write* (with send-signal SIGKILL) (literal "${helperPath}"))`);
    for (const exe of AUTONOMOUS_DENIED_EXECUTABLES) expect(p).toContain(`(literal "${exe}")`);
    for (const svc of AUTONOMOUS_DENIED_MACH_SERVICES) expect(p).toContain(`(global-name "${svc}")`);
    expect(p).toContain('(global-name-regex #"^com\\.apple\\.securityd")');
    for (const op of AUTONOMOUS_DENIED_OPERATIONS) expect(p).toContain(`(deny ${op})`);
    expect(p).toContain(`(subpath "${w.home}/.ssh")`);
    expect(p).toContain('(deny signal)');
    expect(p).toContain('(allow signal (target same-sandbox))');
  });

  it('local engines: no network except loopback model ports; egress engines: no loopback, no foreign sockets', () => {
    const local = world('local-coder');
    const lp = buildAutonomousSbplProfile(autonomousConfinementProfile('local-coder'), { worktree: local.worktree, home: local.home, overlay: local.overlay });
    expect(lp).toContain('(deny network*)');
    expect(lp).toContain('(allow network-outbound (remote ip "localhost:11434"))');
    expect(lp).toContain('(allow network-outbound (remote ip "localhost:8080"))');
    expect(lp).toContain('(deny network-bind)');

    const grok = world('grok-cli-without-seat');
    const gp = buildAutonomousSbplProfile(autonomousConfinementProfile('grok-cli'), { worktree: grok.worktree, home: grok.home, overlay: grok.overlay });
    expect(gp).not.toContain('(deny network*)');
    expect(gp).toContain('(deny network-outbound (remote ip "localhost:*"))');
    expect(gp).toContain('(deny network-outbound (remote unix-socket))');
    expect(gp).toContain('(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))');
    expect(gp).not.toContain('localhost:11434');
  });

  it('verification runs may serve on loopback — never with egress', () => {
    const w = world();
    const vp = buildAutonomousSbplProfile(autonomousVerificationProfile(), { worktree: w.worktree, home: w.home, overlay: w.overlay });
    expect(vp).toContain('(deny network*)');
    expect(vp).toContain('(allow network-bind (local ip "localhost:*"))');
    expect(vp.indexOf('(allow network-bind (local ip "localhost:*"))')).toBeGreaterThan(vp.indexOf('(deny network-bind)'));
    expect(() => buildAutonomousSbplProfile({ ...autonomousVerificationProfile(), networkEgress: true }, { worktree: w.worktree, home: w.home, overlay: w.overlay }))
      .toThrow(/without network egress/);
    const agent = buildAutonomousSbplProfile(autonomousConfinementProfile('local-coder'), { worktree: w.worktree, home: w.home, overlay: w.overlay });
    expect(agent).not.toContain('(local ip "localhost:*")');
  });

  it('ignores config-supplied extra read paths', () => {
    const w = world();
    const p = buildAutonomousSbplProfile({ ...autonomousConfinementProfile('local-coder'), readAllowed: ['/Users/someone/secrets'] },
      { worktree: w.worktree, home: w.home, overlay: w.overlay });
    expect(p).not.toContain('/Users/someone/secrets');
  });

  it('escapes quotes in paths (no SBPL injection)', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'confine-inj-')));
    const home = join(root, 'home');
    const worktree = join(home, 'wt") (allow file-read* (subpath "/');
    const run = join(root, 'run');
    mkdirSync(worktree, { recursive: true });
    mkdirSync(run, { mode: 0o700 });
    const overlay = buildAutonomousEnvOverlay({ engine: 'local', runTmpDir: run, home, seatId: null });
    const p = buildAutonomousSbplProfile(autonomousConfinementProfile('local'), { worktree, home, overlay });
    expect(p).not.toContain('(allow file-read* (subpath "/")');
    expect(p).toContain('wt\\") (allow file-read* (subpath \\"/');
  });

  it('re-allows the linked worktree git dir read-only (never writable)', () => {
    const w = world();
    const common = join(w.home, '.ashlr', 'fleet', 'mirrors', 'o__r', '.git');
    const gitDir = join(common, 'worktrees', 'sb1');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'commondir'), '../..\n');
    writeFileSync(join(w.worktree, '.git'), `gitdir: ${gitDir}\n`);
    const p = buildAutonomousSbplProfile(autonomousConfinementProfile('local'), { worktree: w.worktree, home: w.home, overlay: w.overlay });
    expect(p).toContain(`(subpath "${common}")`);
    const writeAllow = lines(p).find((l) => l.startsWith('(allow file-write* (subpath'))!;
    expect(writeAllow).not.toContain(common);
  });
});

describe('recognizing violations', () => {
  const home = '/Users/mason';

  it('flags protected-path access and escape tools in agent output, with ~ for the home', () => {
    const out = [
      `cat: ${home}/.ashlr/authority/ledger.jsonl: Operation not permitted`,
      `/bin/sh: line 1: 4242 Killed: 9  cat "${home}/Library/Application Support/ashlr-custody/signing-key.blob"`,
      "sandbox-exec: execvp() of '/usr/bin/security' failed: Operation not permitted",
      "zsh: operation not permitted: /usr/local/libexec/ashlr-custody",
      'npm ERR! EPERM: operation not permitted, open /opt/homebrew/lib/x',
      `ls ${home}/.ashlr/authority`,
    ].join('\n');
    expect(sandboxViolationsInOutput(out, home)).toEqual([
      'access /usr/local/libexec/ashlr-custody',
      'access ~/.ashlr/authority',
      'access ~/Library/Application Support/ashlr-custody',
      'exec /usr/bin/security',
      'exec /usr/local/libexec/ashlr-custody',
    ]);
  });

  it('does not flag ordinary denials (a CLI probing ~/.gitconfig, open for a preview)', () => {
    const out = `warning: unable to access '${home}/.gitconfig': Operation not permitted\nsandbox-exec: execvp() of '/usr/bin/open' failed: Operation not permitted`;
    expect(sandboxViolationsInOutput(out, home)).toEqual([]);
  });

  it('an engine SIGKILL the daemon did not send is a tripwire hit', () => {
    expect(isSandboxTripwireKill({ signal: 'SIGKILL', killedByDaemon: false })).toBe(true);
    expect(isSandboxTripwireKill({ signal: 'SIGKILL', killedByDaemon: true })).toBe(false);
    expect(isSandboxTripwireKill({ signal: 'SIGTERM', killedByDaemon: false })).toBe(false);
    expect(isSandboxTripwireKill({ signal: null, killedByDaemon: false })).toBe(false);
  });
});
