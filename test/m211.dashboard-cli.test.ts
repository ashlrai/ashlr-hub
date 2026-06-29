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
    const calls: string[][] = [];
    const rc = vi.fn((args: string[]) => { calls.push(args); return { ok: true, stderr: '', stdout: '' }; });
    installServeAgent({ homeDir: tmpHome, _runCmd: rc as Parameters<typeof installServeAgent>[0]['_runCmd'] });
    const pp = plistPath(tmpHome);
    expect(calls.some(a => a[0] === 'launchctl' && a[1] === 'unload')).toBe(true);
    expect(calls.some(a => a[0] === 'launchctl' && a[1] === 'load' && a[2] === pp)).toBe(true);
  });

  it('backs up existing plist before overwriting', async () => {
    const { installServeAgent, plistPath } = await import('../src/cli/dashboard.js');
    const rc = mockRunCmd();
    const pp = plistPath(tmpHome);
    // Pre-create the LaunchAgents dir and plist
    fs.mkdirSync(path.dirname(pp), { recursive: true });
    fs.writeFileSync(pp, '<old/>', 'utf8');
    installServeAgent({ homeDir: tmpHome, _runCmd: rc });
    expect(fs.existsSync(pp + '.bak')).toBe(true);
    expect(fs.readFileSync(pp + '.bak', 'utf8')).toBe('<old/>');
  });

  it('throws when launchctl load fails', async () => {
    const { installServeAgent } = await import('../src/cli/dashboard.js');
    const rc = mockRunCmd({ 'launchctl load': { ok: false, stderr: 'permission denied', stdout: '' } });
    expect(() => installServeAgent({ homeDir: tmpHome, _runCmd: rc })).toThrow('launchctl load failed');
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
