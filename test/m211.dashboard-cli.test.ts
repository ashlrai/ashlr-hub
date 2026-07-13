/**
 * M211 dashboard CLI tests — `ashlr dashboard` persistence + launchd plist.
 *
 * Hermetic: HOME relocated per-test; no real launchctl / open calls.
 * - All launchctl exec is intercepted via vi.spyOn on the runCmd export.
 * - openBrowser is intercepted via vi.spyOn so no browser opens.
 * - No actual launchd install happens; no network or browser activity.
 *
 * Coverage:
 *   1. generateServePlist — shape contract (pure, no side effects)
 *   2. installServeAgent — writes plist, calls launchctl load
 *   3. uninstallServeAgent — calls launchctl unload, removes file
 *   4. cmdDashboard default — installs agent + opens browser
 *   5. cmdDashboard --stop — calls uninstall
 *   6. cmdDashboard --status — reads FS state, prints/returns JSON
 *   7. cmdDashboard --json — JSON output contains url + port
 *   8. cmdDashboard --help — returns 0
 *   9. cmdDashboard unknown flag — returns 2
 *  10. CLI registration — case 'dashboard' wired + cmdDashboard exported
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m211-home-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A runCmd mock that always returns ok:true */
function mockRunCmd(overrides: Record<string, { ok: boolean; stderr: string; stdout: string }> = {}) {
  return vi.fn((...args: unknown[]) => {
    const argv = args[0] as string[];
    const key = argv.join(' ');
    for (const [pattern, result] of Object.entries(overrides)) {
      if (key.includes(pattern)) return result;
    }
    return { ok: true, stderr: '', stdout: '' };
  });
}

/** A no-op openBrowser mock */
function mockOpenBrowser() {
  return vi.fn(async () => {});
}

// ---------------------------------------------------------------------------
// 1. generateServePlist — pure shape contract
// ---------------------------------------------------------------------------

describe('generateServePlist', () => {
  it('contains ai.ashlr.serve label', async () => {
    const { generateServePlist } = await import('../src/cli/dashboard.js');
    const plist = generateServePlist({ homeDir: tmpHome });
    expect(plist).toContain('<string>ai.ashlr.serve</string>');
  });

  it('contains port 4317 by default', async () => {
    const { generateServePlist, SERVE_PORT } = await import('../src/cli/dashboard.js');
    const plist = generateServePlist({ homeDir: tmpHome });
    expect(plist).toContain(`<string>${SERVE_PORT}</string>`);
    expect(SERVE_PORT).toBe(4317);
  });

  it('contains RunAtLoad true', async () => {
    const { generateServePlist } = await import('../src/cli/dashboard.js');
    const plist = generateServePlist({ homeDir: tmpHome });
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<true/>');
  });

  it('runs as an interactive service so live dashboard reads are not background-throttled', async () => {
    const { generateServePlist } = await import('../src/cli/dashboard.js');
    const plist = generateServePlist({ homeDir: tmpHome });
    expect(plist).toContain('<key>ProcessType</key>');
    expect(plist).toContain('<string>Interactive</string>');
  });

  it('contains KeepAlive SuccessfulExit false', async () => {
    const { generateServePlist } = await import('../src/cli/dashboard.js');
    const plist = generateServePlist({ homeDir: tmpHome });
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<key>SuccessfulExit</key>');
    expect(plist).toContain('<false/>');
  });

  it('contains StandardOutPath and StandardErrorPath', async () => {
    const { generateServePlist } = await import('../src/cli/dashboard.js');
    const plist = generateServePlist({ homeDir: tmpHome });
    expect(plist).toContain('<key>StandardOutPath</key>');
    expect(plist).toContain('<key>StandardErrorPath</key>');
    expect(plist).toContain(tmpHome);
  });

  it('ProgramArguments uses direct node — no shell launcher', async () => {
    const { generateServePlist } = await import('../src/cli/dashboard.js');
    const plist = generateServePlist({
      homeDir: tmpHome,
      nodePath: '/usr/local/bin/node',
      binPath: '/usr/local/bin/ashlr',
    });
    expect(plist).toContain('<string>/usr/local/bin/node</string>');
    expect(plist).toContain('<string>/usr/local/bin/ashlr</string>');
    expect(plist).toContain('<string>serve</string>');
    // Must NOT use a shell (no /bin/sh or /bin/bash in ProgramArguments)
    expect(plist).not.toContain('<string>/bin/sh</string>');
    expect(plist).not.toContain('<string>/bin/bash</string>');
  });

  it('HOME and PATH are set in EnvironmentVariables', async () => {
    const { generateServePlist } = await import('../src/cli/dashboard.js');
    const plist = generateServePlist({ homeDir: tmpHome });
    expect(plist).toContain('<key>HOME</key>');
    expect(plist).toContain(`<string>${tmpHome}</string>`);
    expect(plist).toContain('<key>PATH</key>');
  });

  it('accepts custom port override', async () => {
    const { generateServePlist } = await import('../src/cli/dashboard.js');
    const plist = generateServePlist({ homeDir: tmpHome, port: 9999 });
    expect(plist).toContain('<string>9999</string>');
  });
});

// ---------------------------------------------------------------------------
// 2. plistPath, outLogPath, errLogPath helpers
// ---------------------------------------------------------------------------

describe('path helpers', () => {
  it('plistPath returns ~/Library/LaunchAgents/ai.ashlr.serve.plist', async () => {
    const { plistPath } = await import('../src/cli/dashboard.js');
    const pp = plistPath(tmpHome);
    expect(pp).toBe(path.join(tmpHome, 'Library', 'LaunchAgents', 'ai.ashlr.serve.plist'));
  });

  it('outLogPath returns ~/.ashlr/serve.launchd.out.log', async () => {
    const { outLogPath } = await import('../src/cli/dashboard.js');
    expect(outLogPath(tmpHome)).toBe(path.join(tmpHome, '.ashlr', 'serve.launchd.out.log'));
  });

  it('errLogPath returns ~/.ashlr/serve.launchd.err.log', async () => {
    const { errLogPath } = await import('../src/cli/dashboard.js');
    expect(errLogPath(tmpHome)).toBe(path.join(tmpHome, '.ashlr', 'serve.launchd.err.log'));
  });
});

// ---------------------------------------------------------------------------
// 3. installServeAgent — writes plist + calls launchctl
// ---------------------------------------------------------------------------

describe('installServeAgent', () => {
  it('writes plist file to ~/Library/LaunchAgents/', async () => {
    const { installServeAgent, plistPath } = await import('../src/cli/dashboard.js');
    const rc = mockRunCmd();
    installServeAgent({ homeDir: tmpHome, _runCmd: rc });
    const pp = plistPath(tmpHome);
    expect(fs.existsSync(pp)).toBe(true);
    const content = fs.readFileSync(pp, 'utf8');
    expect(content).toContain('ai.ashlr.serve');
  });

  it('creates ~/.ashlr directory for logs', async () => {
    const { installServeAgent } = await import('../src/cli/dashboard.js');
    const rc = mockRunCmd();
    installServeAgent({ homeDir: tmpHome, _runCmd: rc });
    expect(fs.existsSync(path.join(tmpHome, '.ashlr'))).toBe(true);
  });

  it('calls launchctl unload then launchctl load', async () => {
    const { installServeAgent, plistPath } = await import('../src/cli/dashboard.js');
    const rc = vi.fn((_args: string[]) => ({ ok: true, stderr: '', stdout: '' }));
    installServeAgent({ homeDir: tmpHome, _runCmd: rc as Parameters<typeof installServeAgent>[0]['_runCmd'] });
    const calls = rc.mock.calls;
    expect(calls.some(([args]) => args[0] === 'launchctl' && args[1] === 'unload')).toBe(true);
    const load = calls.find(([args]) => args[0] === 'launchctl' && args[1] === 'load');
    expect(load?.[0][2]).toBe(plistPath(tmpHome));
  });

  it('atomically replaces the plist and retains a timestamped, versioned rollback copy', async () => {
    const { installServeAgent, plistPath } = await import('../src/cli/dashboard.js');
    const rc = mockRunCmd();
    const pp = plistPath(tmpHome);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T12:34:56.789Z'));
    // Pre-create the LaunchAgents dir and plist
    fs.mkdirSync(path.dirname(pp), { recursive: true });
    fs.writeFileSync(pp, '<old/>', 'utf8');
    installServeAgent({ homeDir: tmpHome, _runCmd: rc });
    const files = fs.readdirSync(path.dirname(pp));
    const rollback = files.find((file) => file.startsWith(`${path.basename(pp)}.rollback.`));
    expect(rollback).toMatch(
      /^ai\.ashlr\.serve\.plist\.rollback\.2026-07-12T12-34-56-789Z\.\d+\.[a-f0-9]{32}$/,
    );
    expect(fs.readFileSync(path.join(path.dirname(pp), rollback!), 'utf8')).toBe('<old/>');
    expect(fs.readFileSync(pp + '.bak', 'utf8')).toBe('<old/>');
    expect(files.some((file) => file.includes('.tmp.'))).toBe(false);
  });

  it('creates a new rollback version without replacing prior rollback copies', async () => {
    const { installServeAgent, plistPath } = await import('../src/cli/dashboard.js');
    const pp = plistPath(tmpHome);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T12:34:56.789Z'));
    fs.mkdirSync(path.dirname(pp), { recursive: true });
    fs.writeFileSync(pp, '<old/>', 'utf8');
    const priorRollback = `${pp}.rollback.2026-07-12T12-34-56-789Z.999.1`;
    fs.writeFileSync(priorRollback, '<older/>', 'utf8');

    installServeAgent({ homeDir: tmpHome, _runCmd: mockRunCmd() });

    const rollbacks = fs.readdirSync(path.dirname(pp))
      .filter((file) => file.startsWith(`${path.basename(pp)}.rollback.`));
    expect(fs.readFileSync(priorRollback, 'utf8')).toBe('<older/>');
    expect(rollbacks).toHaveLength(2);
    const currentRollback = rollbacks.find((file) => file !== path.basename(priorRollback));
    expect(fs.readFileSync(path.join(path.dirname(pp), currentRollback!), 'utf8')).toBe('<old/>');
  });

  it('restores and reloads the exact prior plist when loading the replacement fails', async () => {
    const { installServeAgent, plistPath } = await import('../src/cli/dashboard.js');
    const pp = plistPath(tmpHome);
    const prior = Buffer.from([0x3c, 0x6f, 0x6c, 0x64, 0x2f, 0x3e, 0x0a]);
    fs.mkdirSync(path.dirname(pp), { recursive: true });
    fs.writeFileSync(pp, prior);
    const calls: string[][] = [];
    let loadCount = 0;
    const rc = vi.fn((args: string[]) => {
      calls.push(args);
      if (args[1] === 'load' && loadCount++ === 0) {
        return { ok: false, stderr: 'new definition rejected', stdout: '' };
      }
      return { ok: true, stderr: '', stdout: '' };
    });

    expect(() => installServeAgent({ homeDir: tmpHome, _runCmd: rc })).toThrow(
      'prior plist was restored and reloaded from',
    );
    expect(fs.readFileSync(pp)).toEqual(prior);
    expect(calls.map((args) => args[1])).toEqual(['unload', 'load', 'unload', 'load']);
    expect(fs.readdirSync(path.dirname(pp)).some((file) => file.includes('.tmp'))).toBe(false);
  });

  it('removes the replacement when loading a fresh install fails', async () => {
    const { installServeAgent, plistPath } = await import('../src/cli/dashboard.js');
    const pp = plistPath(tmpHome);
    const rc = mockRunCmd({
      'launchctl load': { ok: false, stderr: 'permission denied', stdout: '' },
    });

    expect(() => installServeAgent({ homeDir: tmpHome, _runCmd: rc })).toThrow(
      'launchctl load failed: permission denied; first-install plist was removed',
    );
    expect(fs.existsSync(pp)).toBe(false);
    expect(rc).toHaveBeenCalledTimes(3);
  });

  it('treats launchctl zero-exit error output as a load failure', async () => {
    const { installServeAgent, plistPath } = await import('../src/cli/dashboard.js');
    const pp = plistPath(tmpHome);
    const rc = mockRunCmd({
      'launchctl load': {
        ok: true,
        stderr: 'Load failed: 5: Input/output error',
        stdout: '',
      },
    });

    expect(() => installServeAgent({ homeDir: tmpHome, _runCmd: rc })).toThrow(
      'launchctl load failed: Load failed: 5: Input/output error',
    );
    expect(fs.existsSync(pp)).toBe(false);
  });

  it('reports both load failures when the prior plist cannot be reloaded', async () => {
    const { installServeAgent, plistPath } = await import('../src/cli/dashboard.js');
    const pp = plistPath(tmpHome);
    fs.mkdirSync(path.dirname(pp), { recursive: true });
    fs.writeFileSync(pp, '<old/>', 'utf8');
    let loadCount = 0;
    const rc = vi.fn((args: string[]) => {
      if (args[1] !== 'load') return { ok: true, stderr: '', stdout: '' };
      loadCount++;
      return loadCount === 1
        ? { ok: false, stderr: 'new load failed', stdout: '' }
        : { ok: false, stderr: 'old reload failed', stdout: '' };
    });

    expect(() => installServeAgent({ homeDir: tmpHome, _runCmd: rc })).toThrow(
      'launchctl load failed: new load failed; prior plist was restored but rollback reload failed: old reload failed',
    );
    expect(fs.readFileSync(pp, 'utf8')).toBe('<old/>');
  });

  it('rejects symlinked active and fixed backup targets without touching their referents', async () => {
    const { installServeAgent, plistPath } = await import('../src/cli/dashboard.js');
    const pp = plistPath(tmpHome);
    const outside = path.join(tmpHome, 'outside.plist');
    fs.mkdirSync(path.dirname(pp), { recursive: true });
    fs.writeFileSync(outside, 'outside');
    fs.symlinkSync(outside, pp);

    expect(() => installServeAgent({ homeDir: tmpHome, _runCmd: mockRunCmd() })).toThrow(
      'unsafe active plist',
    );
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside');

    fs.unlinkSync(pp);
    fs.writeFileSync(pp, 'prior');
    fs.symlinkSync(outside, `${pp}.bak`);
    expect(() => installServeAgent({ homeDir: tmpHome, _runCmd: mockRunCmd() })).toThrow(
      'unsafe plist backup',
    );
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside');
    expect(fs.readFileSync(pp, 'utf8')).toBe('prior');
  });

  it('restores exact bytes while constraining prior modes to owner read/write', async () => {
    const { installServeAgent, plistPath } = await import('../src/cli/dashboard.js');
    const pp = plistPath(tmpHome);
    const prior = Buffer.from([0x00, 0x3c, 0x70, 0x6c, 0x69, 0x73, 0x74, 0xff]);
    fs.mkdirSync(path.dirname(pp), { recursive: true });
    fs.writeFileSync(pp, prior, { mode: 0o640 });
    fs.chmodSync(pp, 0o640);
    let loads = 0;
    const rc = vi.fn((args: string[]) => args[1] === 'load' && loads++ === 0
      ? { ok: false, stderr: 'rejected', stdout: '' }
      : { ok: true, stderr: '', stdout: '' });

    expect(() => installServeAgent({ homeDir: tmpHome, _runCmd: rc })).toThrow('restored and reloaded');
    expect(fs.readFileSync(pp)).toEqual(prior);
    expect(fs.statSync(pp).mode & 0o777).toBe(0o600);
    expect(fs.statSync(`${pp}.bak`).mode & 0o777).toBe(0o600);
  });

  it('enforces mode 0600 for a first install', async () => {
    const { installServeAgent, plistPath } = await import('../src/cli/dashboard.js');
    const pp = plistPath(tmpHome);
    installServeAgent({ homeDir: tmpHome, _runCmd: mockRunCmd() });
    expect(fs.statSync(pp).mode & 0o777).toBe(0o600);
  });

  it('rejects a symlinked parent component beneath the trusted home', async () => {
    const { installServeAgent } = await import('../src/cli/dashboard.js');
    const outside = path.join(tmpHome, 'redirected-launch-agents');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(tmpHome, 'Library'));

    expect(() => installServeAgent({ homeDir: tmpHome, _runCmd: mockRunCmd() })).toThrow(
      'unsafe launchd plist parent component',
    );
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('rejects a symlinked lock parent beneath the trusted home', async () => {
    const { installServeAgent } = await import('../src/cli/dashboard.js');
    const outside = path.join(tmpHome, 'redirected-locks');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(tmpHome, '.ashlr'));

    expect(() => installServeAgent({ homeDir: tmpHome, _runCmd: mockRunCmd() })).toThrow(
      'unsafe launchd plist parent component',
    );
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('does not restore disk state when the compensating unload fails', async () => {
    const { installServeAgent, plistPath } = await import('../src/cli/dashboard.js');
    const pp = plistPath(tmpHome);
    let unloads = 0;
    const rc = vi.fn((args: string[]) => {
      if (args[1] === 'load') return { ok: false, stderr: 'load rejected', stdout: '' };
      if (args[1] === 'unload' && unloads++ > 0) {
        return { ok: false, stderr: 'job still active', stdout: '' };
      }
      return { ok: true, stderr: '', stdout: '' };
    });

    expect(() => installServeAgent({ homeDir: tmpHome, _runCmd: rc })).toThrow(
      'compensating unload failed: job still active',
    );
    expect(fs.existsSync(pp)).toBe(true);
  });

  it('refuses to load a plist replaced during the initial unload', async () => {
    const { installServeAgent, plistPath } = await import('../src/cli/dashboard.js');
    const pp = plistPath(tmpHome);
    const outside = path.join(tmpHome, 'malicious.plist');
    fs.writeFileSync(outside, 'MALICIOUS');
    let loads = 0;
    const rc = vi.fn((args: string[]) => {
      if (args[1] === 'unload') {
        fs.unlinkSync(pp);
        fs.symlinkSync(outside, pp);
      } else if (args[1] === 'load') {
        loads++;
      }
      return { ok: true, stderr: '', stdout: '' };
    });

    expect(() => installServeAgent({ homeDir: tmpHome, _runCmd: rc })).toThrow(
      'unsafe installed plist',
    );
    expect(loads).toBe(0);
    expect(fs.readFileSync(outside, 'utf8')).toBe('MALICIOUS');
  });

  it('compensates when the plist is replaced while launchctl is loading it', async () => {
    const { installServeAgent, plistPath } = await import('../src/cli/dashboard.js');
    const pp = plistPath(tmpHome);
    const outside = path.join(tmpHome, 'malicious-after-load.plist');
    fs.writeFileSync(outside, 'MALICIOUS');
    const calls: string[] = [];
    const rc = vi.fn((args: string[]) => {
      calls.push(args[1]!);
      if (args[1] === 'load') {
        fs.unlinkSync(pp);
        fs.symlinkSync(outside, pp);
      }
      return { ok: true, stderr: '', stdout: '' };
    });

    expect(() => installServeAgent({ homeDir: tmpHome, _runCmd: rc })).toThrow(
      'active plist changed during launchctl load',
    );
    expect(calls).toEqual(['unload', 'load', 'unload']);
    expect(fs.readFileSync(outside, 'utf8')).toBe('MALICIOUS');
  });

  it('serializes nested transactions for the same plist', async () => {
    const { installLaunchdPlistTransaction } = await import('../src/core/daemon/launchd-plist-transaction.js');
    const pp = path.join(tmpHome, 'Library', 'LaunchAgents', 'nested.plist');
    const lockDir = path.join(tmpHome, '.ashlr', 'locks');
    let nestedError = '';

    installLaunchdPlistTransaction({
      plistPath: pp,
      trustedRoot: tmpHome,
      content: 'outer',
      lockDir,
      lockWaitMs: 20,
      unload: () => ({ ok: true, stderr: '' }),
      load: () => {
        try {
          installLaunchdPlistTransaction({
            plistPath: pp,
            trustedRoot: tmpHome,
            content: 'nested',
            lockDir,
            lockWaitMs: 20,
            unload: () => ({ ok: true, stderr: '' }),
            load: () => ({ ok: true, stderr: '' }),
          });
        } catch (error) {
          nestedError = error instanceof Error ? error.message : String(error);
        }
        return { ok: true, stderr: '' };
      },
    });

    expect(nestedError).toContain('could not acquire launchd plist transaction lock');
    expect(fs.readFileSync(pp, 'utf8')).toBe('outer');
  });

  it('does not remove an interleaved replacement it no longer owns', async () => {
    const { installLaunchdPlistTransaction } = await import('../src/core/daemon/launchd-plist-transaction.js');
    const pp = path.join(tmpHome, 'Library', 'LaunchAgents', 'ownership.plist');
    const calls: string[] = [];

    expect(() => installLaunchdPlistTransaction({
      plistPath: pp,
      trustedRoot: tmpHome,
      content: 'transaction-owned',
      lockDir: path.join(tmpHome, '.ashlr', 'locks'),
      unload: () => { calls.push('unload'); return { ok: true, stderr: '' }; },
      load: () => {
        calls.push('load');
        const interloper = `${pp}.interloper`;
        fs.writeFileSync(interloper, 'interleaved', { mode: 0o600 });
        fs.renameSync(interloper, pp);
        return { ok: false, stderr: 'uncertain load', stdout: '' };
      },
    })).toThrow('transaction no longer owns');

    expect(calls).toEqual(['unload', 'load', 'unload']);
    expect(fs.readFileSync(pp, 'utf8')).toBe('interleaved');
  });

  it('serializes removal against installation for the same plist', async () => {
    const {
      installLaunchdPlistTransaction,
      removeLaunchdPlistTransaction,
    } = await import('../src/core/daemon/launchd-plist-transaction.js');
    const pp = path.join(tmpHome, 'Library', 'LaunchAgents', 'shared-lock.plist');
    const lockDir = path.join(tmpHome, '.ashlr', 'locks');
    let removalError = '';

    installLaunchdPlistTransaction({
      plistPath: pp,
      trustedRoot: tmpHome,
      content: 'installed',
      lockDir,
      unload: () => ({ ok: true, stderr: '' }),
      load: () => {
        try {
          removeLaunchdPlistTransaction({
            plistPath: pp,
            trustedRoot: tmpHome,
            lockDir,
            lockWaitMs: 20,
            unload: () => ({ ok: true, stderr: '' }),
          });
        } catch (error) {
          removalError = error instanceof Error ? error.message : String(error);
        }
        return { ok: true, stderr: '' };
      },
    });

    expect(removalError).toContain('could not acquire launchd plist transaction lock');
    expect(fs.readFileSync(pp, 'utf8')).toBe('installed');
  });

  it('caps rollback retention at five without following rollback symlinks', async () => {
    const { installServeAgent, plistPath } = await import('../src/cli/dashboard.js');
    const pp = plistPath(tmpHome);
    const outside = path.join(tmpHome, 'retention-outside');
    fs.mkdirSync(path.dirname(pp), { recursive: true });
    fs.writeFileSync(pp, 'current');
    fs.writeFileSync(outside, 'keep');
    for (let index = 0; index < 7; index++) {
      const rollback = `${pp}.rollback.2026-01-0${index + 1}T00-00-00-000Z.1.${String(index).padStart(32, '0')}`;
      if (index === 0) fs.symlinkSync(outside, rollback);
      else fs.writeFileSync(rollback, `old-${index}`);
      const when = new Date(2026, 0, index + 1);
      fs.lutimesSync(rollback, when, when);
    }
    for (let index = 0; index < 6; index++) {
      fs.mkdirSync(`${pp}.rollback.hostile-directory-${index}`);
    }

    installServeAgent({ homeDir: tmpHome, _runCmd: mockRunCmd() });

    const rollbacks = fs.readdirSync(path.dirname(pp))
      .filter((name) => name.startsWith(`${path.basename(pp)}.rollback.`))
      .filter((name) => {
        const filePath = path.join(path.dirname(pp), name);
        return fs.lstatSync(filePath).isFile() && fs.statSync(filePath).size > 0;
      });
    expect(rollbacks).toHaveLength(5);
    expect(fs.existsSync(`${pp}.rollback.hostile-directory-0`)).toBe(true);
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
  });
});

describe('servePlistNeedsUpgrade', () => {
  it('detects and upgrades an installed Background service definition', async () => {
    const { generateServePlist, plistPath, servePlistNeedsUpgrade } = await import('../src/cli/dashboard.js');
    const pp = plistPath(tmpHome);
    fs.mkdirSync(path.dirname(pp), { recursive: true });
    const desired = generateServePlist({ homeDir: tmpHome });
    fs.writeFileSync(pp, desired.replace('<string>Interactive</string>', '<string>Background</string>'));
    expect(servePlistNeedsUpgrade({ homeDir: tmpHome })).toBe(true);
    fs.writeFileSync(pp, desired);
    expect(servePlistNeedsUpgrade({ homeDir: tmpHome })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. uninstallServeAgent
// ---------------------------------------------------------------------------

describe('uninstallServeAgent', () => {
  it('calls launchctl unload', async () => {
    const { uninstallServeAgent } = await import('../src/cli/dashboard.js');
    const calls: string[][] = [];
    const rc = vi.fn((args: string[]) => { calls.push(args); return { ok: true, stderr: '', stdout: '' }; });
    uninstallServeAgent({ homeDir: tmpHome, _runCmd: rc as Parameters<typeof uninstallServeAgent>[0]['_runCmd'] });
    expect(calls.some(a => a[0] === 'launchctl' && a[1] === 'unload')).toBe(true);
  });

  it('removes plist file if it exists', async () => {
    const { uninstallServeAgent, plistPath } = await import('../src/cli/dashboard.js');
    const rc = mockRunCmd();
    const pp = plistPath(tmpHome);
    fs.mkdirSync(path.dirname(pp), { recursive: true });
    fs.writeFileSync(pp, 'content', 'utf8');
    uninstallServeAgent({ homeDir: tmpHome, _runCmd: rc });
    expect(fs.existsSync(pp)).toBe(false);
  });

  it('does not throw when plist does not exist', async () => {
    const { uninstallServeAgent } = await import('../src/cli/dashboard.js');
    const rc = mockRunCmd();
    expect(() => uninstallServeAgent({ homeDir: tmpHome, _runCmd: rc })).not.toThrow();
  });

  it('retains the plist when launchctl cannot confirm unload', async () => {
    const { uninstallServeAgent, plistPath } = await import('../src/cli/dashboard.js');
    const pp = plistPath(tmpHome);
    fs.mkdirSync(path.dirname(pp), { recursive: true });
    fs.writeFileSync(pp, 'content', { mode: 0o600 });
    const rc = mockRunCmd({
      'launchctl unload': {
        ok: true,
        stderr: 'Unload failed: 5: Input/output error',
        stdout: '',
      },
    });

    expect(() => uninstallServeAgent({ homeDir: tmpHome, _runCmd: rc })).toThrow(
      'launchctl unload failed: Unload failed: 5: Input/output error; plist retained',
    );
    expect(fs.readFileSync(pp, 'utf8')).toBe('content');
  });
});

// ---------------------------------------------------------------------------
// 5. cmdDashboard on non-darwin platform (skip launchd, use serve fallback)
//    We test the --status / --json / --help / unknown-flag paths universally.
// ---------------------------------------------------------------------------

describe('cmdDashboard --status', () => {
  it('returns 0 and prints status', async () => {
    const { cmdDashboard } = await import('../src/cli/dashboard.js');
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    try {
      const code = await cmdDashboard(['--status']);
      expect(code).toBe(0);
    } finally {
      console.log = origLog;
    }
  });

  it('--status --json returns 0 and JSON with required fields', async () => {
    const { cmdDashboard } = await import('../src/cli/dashboard.js');
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    try {
      const code = await cmdDashboard(['--status', '--json']);
      expect(code).toBe(0);
      const out = JSON.parse(logs.join(''));
      expect(out).toMatchObject({
        installed: expect.any(Boolean),
        running: expect.any(Boolean),
        plistPath: expect.any(String),
        url: expect.stringContaining('127.0.0.1'),
        port: 4317,
        label: 'ai.ashlr.serve',
      });
    } finally {
      console.log = origLog;
    }
  });
});

describe('cmdDashboard --help', () => {
  it('returns 0', async () => {
    const { cmdDashboard } = await import('../src/cli/dashboard.js');
    const origLog = console.log;
    console.log = () => {};
    try {
      const code = await cmdDashboard(['--help']);
      expect(code).toBe(0);
    } finally {
      console.log = origLog;
    }
  });
});

describe('cmdDashboard unknown flag', () => {
  it('returns 2', async () => {
    const { cmdDashboard } = await import('../src/cli/dashboard.js');
    const origErr = console.error;
    console.error = () => {};
    try {
      const code = await cmdDashboard(['--unknown-xyz']);
      expect(code).toBe(2);
    } finally {
      console.error = origErr;
    }
  });
});

// ---------------------------------------------------------------------------
// 6. cmdDashboard on macOS: default open path (mock platform + runCmd + open)
// ---------------------------------------------------------------------------

describe('cmdDashboard default (macOS, mocked)', () => {
  it('calls installServeAgent (launchctl) and openBrowser, returns 0', async () => {
    // Only run on macOS (or when mocked platform allows)
    if (process.platform !== 'darwin') {
      // On non-darwin, the command falls back to cmdServe --open which we don't
      // want to spawn here. Skip the install path test on non-darwin.
      return;
    }

    const dashboard = await import('../src/cli/dashboard.js');
    const rc = mockRunCmd();
    const ob = mockOpenBrowser();

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };

    let code: number;
    try {
      code = await dashboard.cmdDashboard([], { _runCmd: rc, _openBrowser: ob });
    } finally {
      console.log = origLog;
    }

    expect(code).toBe(0);
    expect(ob).toHaveBeenCalledWith(expect.stringContaining('127.0.0.1:4317'));
  });

  it('--json returns JSON with url, port, label', async () => {
    if (process.platform !== 'darwin') return;

    const dashboard = await import('../src/cli/dashboard.js');
    const rc = mockRunCmd();
    const ob = mockOpenBrowser();

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };

    let code: number;
    try {
      code = await dashboard.cmdDashboard(['--json'], { _runCmd: rc, _openBrowser: ob });
    } finally {
      console.log = origLog;
    }

    expect(code).toBe(0);
    const out = JSON.parse(logs.join(''));
    expect(out.port).toBe(4317);
    expect(out.url).toContain('127.0.0.1');
    expect(out.label).toBe('ai.ashlr.serve');
  });
});

describe('cmdDashboard --stop (macOS, mocked)', () => {
  it('calls launchctl unload and returns 0', async () => {
    if (process.platform !== 'darwin') return;

    const dashboard = await import('../src/cli/dashboard.js');
    const calls: string[][] = [];
    const rc = vi.fn((args: string[]) => { calls.push(args); return { ok: true, stderr: '', stdout: '' }; });

    const origLog = console.log;
    console.log = () => {};
    let code: number;
    try {
      code = await dashboard.cmdDashboard(['--stop'], {
        _runCmd: rc as Parameters<typeof dashboard.cmdDashboard>[1]['_runCmd'],
      });
    } finally {
      console.log = origLog;
    }

    expect(code).toBe(0);
    expect(calls.some(a => a[0] === 'launchctl' && a[1] === 'unload')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. CLI registration
// ---------------------------------------------------------------------------

describe('CLI registration', () => {
  it("src/cli/index.ts contains case 'dashboard'", () => {
    const src = fs.readFileSync(path.resolve('src/cli/index.ts'), 'utf8');
    expect(src).toContain("case 'dashboard'");
  });

  it('src/cli/index.ts loadDashboardCmd picks cmdDashboard from dashboard.js', () => {
    const src = fs.readFileSync(path.resolve('src/cli/index.ts'), 'utf8');
    expect(src).toContain("import('./dashboard.js'");
    expect(src).toContain('cmdDashboard');
  });

  it('cmdDashboard is exported from src/cli/dashboard.ts', async () => {
    const mod = await import('../src/cli/dashboard.js') as Record<string, unknown>;
    expect(typeof mod.cmdDashboard).toBe('function');
  });

  it('SERVE_PORT is exported and equals 4317', async () => {
    const { SERVE_PORT } = await import('../src/cli/dashboard.js');
    expect(SERVE_PORT).toBe(4317);
  });
});
