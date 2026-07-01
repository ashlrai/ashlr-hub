/**
 * DaemonServiceManager — M93
 *
 * Cross-platform OS service registration for the ashlr daemon.
 * Supports macOS (launchd), Linux (systemd --user), and Windows (schtasks).
 *
 * DESIGN CONTRACT:
 *  - install() / uninstall() are the ONLY side-effectful entry points.
 *  - generateServiceDefinition() / buildRegisterCommand() / buildUnregisterCommand()
 *    are pure and fully testable with a mocked process.platform.
 *  - serviceStatus() queries the OS but never throws.
 *  - Every file write is idempotent; an existing file is backed up before overwrite.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Types (local — do NOT add to types.ts per file-ownership constraints)
// ---------------------------------------------------------------------------

export type Platform = 'darwin' | 'linux' | 'win32';
export type PlatformSpec = 'launchd' | 'systemd' | 'schtasks' | 'unknown';

export interface ServiceInstallOptions {
  /** Override node executable path (default: process.execPath). */
  nodePath?: string;
  /** Override absolute path to bin/ashlr (default: resolved from __dirname). */
  binPath?: string;
  /** Daily budget in USD passed to `daemon start --budget`. */
  budget?: number;
  /** Interval in ms passed to `daemon start --interval`. */
  intervalMs?: number;
  /** Crash restart throttle in seconds (default: 30). Independent of intervalMs. */
  restartSec?: number;
  /** Parallelism passed to `daemon start --parallel`. */
  parallel?: number;
  /** Register the service to auto-start on login/boot (default: true). */
  autostart?: boolean;
  /** Override HOME directory (useful in tests). */
  homeDir?: string;
  /** Override process.platform for generation (useful in tests). */
  platform?: Platform;
  /**
   * Wrap the daemon process with `caffeinate -i -s` on macOS so the job keeps
   * running while the lid is closed and the machine is idle (prevents both idle
   * sleep and system sleep while on AC power).
   *
   * Default: false.  Set to true for `ashlr worker` installs.
   *
   * Linux / Windows: documented caveat only — caffeinate is macOS-specific.
   * On battery, macOS may still sleep regardless of this flag.
   */
  keepAwake?: boolean;
}

export interface ServiceStatusResult {
  installed: boolean;
  running: boolean;
  platformSpec: PlatformSpec;
  serviceFilePath?: string;
  errorLog?: string;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to `bin/ashlr` relative to this file's location.
 * Works from both src/ (ts-node / tsx) and dist/ (compiled).
 */
function resolveBinPath(): string {
  // __dirname is src/core/daemon/ or dist/core/daemon/
  // bin/ashlr is always at <repo-root>/bin/ashlr
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
  return path.join(repoRoot, 'bin', 'ashlr');
}

function resolveHome(homeDir?: string): string {
  return homeDir ?? os.homedir();
}

// ---------------------------------------------------------------------------
// Service-file generation (pure — no side effects, fully testable)
// ---------------------------------------------------------------------------

export interface ServiceDefinition {
  /** Absolute path where the service file should be written. */
  filePath: string;
  /** File content (plist XML / unit file / command string). */
  content: string;
  /** The register command and its args (exec-safe — no shell). */
  registerArgs: string[];
  /** The unregister command and its args. */
  unregisterArgs: string[];
  /** How to unload (may differ from unregister on some platforms). */
  unloadArgs?: string[];
}

export function generateServiceDefinition(opts: ServiceInstallOptions = {}): ServiceDefinition {
  const platform = (opts.platform ?? process.platform) as Platform;
  const nodePath = opts.nodePath ?? process.execPath;
  const binPath = opts.binPath ?? resolveBinPath();
  const home = resolveHome(opts.homeDir);
  const configDir = path.join(home, '.ashlr');

  const budget = opts.budget ?? 5;
  const intervalMs = opts.intervalMs ?? 1_800_000;
  const restartSec = Number.isFinite(opts.restartSec) && opts.restartSec !== undefined
    ? Math.max(5, Math.floor(opts.restartSec))
    : 30;
  const parallel = opts.parallel ?? 1;
  const keepAwake = opts.keepAwake ?? false;

  switch (platform) {
    case 'darwin':
      return buildLaunchdDefinition({ nodePath, binPath, home, configDir, budget, intervalMs, restartSec, parallel, keepAwake });
    case 'linux':
      return buildSystemdDefinition({ nodePath, binPath, home, configDir, budget, intervalMs, restartSec, parallel });
    case 'win32':
      return buildSchtasksDefinition({ nodePath, binPath, home, configDir, budget, intervalMs, restartSec, parallel });
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

// ---------------------------------------------------------------------------
// macOS — launchd
// ---------------------------------------------------------------------------

interface BuildOpts {
  nodePath: string;
  binPath: string;
  home: string;
  configDir: string;
  budget: number;
  intervalMs: number;
  restartSec: number;
  parallel: number;
  /** Wrap ProgramArguments with caffeinate -i -s (macOS only). */
  keepAwake?: boolean;
}

function buildLaunchdDefinition(o: BuildOpts): ServiceDefinition {
  const plistPath = path.join(o.home, 'Library', 'LaunchAgents', 'ai.ashlr.daemon.plist');
  const outLog = path.join(o.configDir, 'daemon.launchd.out.log');
  const errLog = path.join(o.configDir, 'daemon.launchd.err.log');

  // PATH that mirrors the hand-crafted plist
  const pathEnv = [
    path.join(o.home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':');

  // When keepAwake is set, prepend `caffeinate -i -s --` so launchd keeps the
  // daemon alive through idle + system sleep while on AC power (lid-closed use).
  // caffeinate's `-i` flag prevents idle sleep; `-s` prevents system sleep on AC.
  // On battery, macOS may still sleep — the user must keep the Mac plugged in.
  const programArgs = o.keepAwake
    ? [
        '\t\t<string>caffeinate</string>',
        '\t\t<string>-i</string>',
        '\t\t<string>-s</string>',
        `\t\t<string>${o.nodePath}</string>`,
        `\t\t<string>${o.binPath}</string>`,
      ]
    : [
        `\t\t<string>${o.nodePath}</string>`,
        `\t\t<string>${o.binPath}</string>`,
      ];

  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>ai.ashlr.daemon</string>
\t<key>ProcessType</key>
\t<string>Background</string>
\t<key>ProgramArguments</key>
\t<array>
${programArgs.join('\n')}
\t\t<string>daemon</string>
\t\t<string>start</string>
\t\t<string>--budget</string>
\t\t<string>${o.budget}</string>
\t\t<string>--interval</string>
\t\t<string>${o.intervalMs}</string>
\t\t<string>--parallel</string>
\t\t<string>${o.parallel}</string>
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>HOME</key>
\t\t<string>${o.home}</string>
\t\t<key>PATH</key>
\t\t<string>${pathEnv}</string>
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>ThrottleInterval</key>
\t<integer>${o.restartSec}</integer>
\t<key>StandardOutPath</key>
\t<string>${outLog}</string>
\t<key>StandardErrorPath</key>
\t<string>${errLog}</string>
</dict>
</plist>
`;

  return {
    filePath: plistPath,
    content,
    registerArgs: ['launchctl', 'load', plistPath],
    unregisterArgs: ['launchctl', 'unload', plistPath],
  };
}

// ---------------------------------------------------------------------------
// Linux — systemd --user
// ---------------------------------------------------------------------------

function buildSystemdDefinition(o: BuildOpts): ServiceDefinition {
  const unitDir = path.join(o.home, '.config', 'systemd', 'user');
  const unitPath = path.join(unitDir, 'ashlr-daemon.service');
  const outLog = path.join(o.configDir, 'daemon.systemd.log');

  const content = `[Unit]
Description=ashlr autonomous daemon
After=network.target

[Service]
Type=simple
ExecStart=${o.nodePath} ${o.binPath} daemon start --budget ${o.budget} --interval ${o.intervalMs} --parallel ${o.parallel}
Restart=always
RestartSec=${o.restartSec}
Environment=HOME=${o.home}
StandardOutput=append:${outLog}
StandardError=append:${outLog}

[Install]
WantedBy=default.target
`;

  return {
    filePath: unitPath,
    content,
    // daemon-reload then enable --now (best-effort; handled in install())
    registerArgs: ['systemctl', '--user', 'enable', '--now', 'ashlr-daemon'],
    unregisterArgs: ['systemctl', '--user', 'disable', '--now', 'ashlr-daemon'],
  };
}

// ---------------------------------------------------------------------------
// Windows — schtasks
// ---------------------------------------------------------------------------

function buildSchtasksDefinition(o: BuildOpts): ServiceDefinition {
  // On Windows, write a tiny launcher .cmd to a known location.
  const startupDir = path.join(o.home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const cmdPath = path.join(startupDir, 'ashlr-daemon.cmd');

  // schtasks /Create args (exec-safe array — no shell expansion)
  const taskArgs = [
    'schtasks',
    '/Create',
    '/TN', 'AshlrDaemon',
    '/TR', `"${o.nodePath}" "${o.binPath}" daemon start --budget ${o.budget} --interval ${o.intervalMs} --parallel ${o.parallel}`,
    '/SC', 'ONLOGON',
    '/RL', 'LIMITED',
    '/F',  // force overwrite if exists
  ];

  const content = `@echo off\r\n"${o.nodePath}" "${o.binPath}" daemon start --budget ${o.budget} --interval ${o.intervalMs} --parallel ${o.parallel}\r\n`;

  return {
    filePath: cmdPath,
    content,
    registerArgs: taskArgs,
    unregisterArgs: ['schtasks', '/Delete', '/TN', 'AshlrDaemon', '/F'],
  };
}

// ---------------------------------------------------------------------------
// File write helper (idempotent + backup)
// ---------------------------------------------------------------------------

function writeServiceFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Backup existing file
  if (fs.existsSync(filePath)) {
    const backup = filePath + '.bak';
    fs.copyFileSync(filePath, backup);
  }
  fs.writeFileSync(filePath, content, { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// Register / unregister helpers (side-effectful; exec is mocked in tests)
// ---------------------------------------------------------------------------

/**
 * Run a command exec-safely (no shell). Returns { ok, stderr }.
 * Never throws — captures errors into the return value.
 */
function runCmd(args: string[]): { ok: boolean; stderr: string } {
  const [cmd, ...rest] = args;
  if (!cmd) return { ok: false, stderr: 'empty command' };
  try {
    const result = spawnSync(cmd, rest, { encoding: 'utf8', timeout: 15_000 });
    const ok = result.status === 0 && !result.error;
    return { ok, stderr: result.stderr ?? result.error?.message ?? '' };
  } catch (e) {
    return { ok: false, stderr: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Install and register the ashlr daemon as an OS service.
 *
 * Idempotent: backs up any existing service file, writes fresh, then loads.
 * On Linux: runs `systemctl --user daemon-reload` first; if systemctl is
 * absent, writes the unit and prints manual instructions.
 * On Windows: registers via schtasks; best-effort.
 */
export async function install(opts: ServiceInstallOptions = {}): Promise<void> {
  const platform = (opts.platform ?? process.platform) as Platform;
  const def = generateServiceDefinition(opts);

  writeServiceFile(def.filePath, def.content);

  if (platform === 'darwin') {
    // Unload first (ignore errors — may not be loaded)
    runCmd(['launchctl', 'unload', def.filePath]);
    const { ok, stderr } = runCmd(def.registerArgs);
    if (!ok) {
      throw new Error(`launchctl load failed: ${stderr}`);
    }
  } else if (platform === 'linux') {
    // daemon-reload first
    runCmd(['systemctl', '--user', 'daemon-reload']);
    const { ok, stderr } = runCmd(def.registerArgs);
    if (!ok) {
      // systemctl may be absent in containers / minimal environments
      console.warn(
        `[ashlr] systemctl not available or failed (${stderr.trim() || 'exit non-zero'}).\n` +
        `Unit written to ${def.filePath}\n` +
        `Enable manually:\n` +
        `  systemctl --user daemon-reload\n` +
        `  systemctl --user enable --now ashlr-daemon`,
      );
    }
  } else if (platform === 'win32') {
    const { ok, stderr } = runCmd(def.registerArgs);
    if (!ok) {
      console.warn(
        `[ashlr] schtasks registration failed (${stderr.trim() || 'exit non-zero'}).\n` +
        `Startup script written to ${def.filePath}\n` +
        `Register manually: ${def.registerArgs.join(' ')}`,
      );
    }
  }
}

/**
 * Unload and remove the OS service registration.
 * Never throws — best-effort on each step.
 */
export async function uninstall(opts: ServiceInstallOptions = {}): Promise<void> {
  const platform = (opts.platform ?? process.platform) as Platform;
  const def = generateServiceDefinition(opts);

  runCmd(def.unregisterArgs);

  // Additional unload step for launchd
  if (platform === 'darwin' && def.unloadArgs) {
    runCmd(def.unloadArgs);
  }

  if (fs.existsSync(def.filePath)) {
    fs.unlinkSync(def.filePath);
  }
}

/**
 * Query the OS for current service state.
 * Never throws — degrades to { installed: false, running: false } on errors.
 */
export function serviceStatus(opts: ServiceInstallOptions = {}): ServiceStatusResult {
  const platform = (opts.platform ?? process.platform) as Platform;
  const def = generateServiceDefinition(opts);
  const installed = fs.existsSync(def.filePath);

  if (platform === 'darwin') {
    return queryLaunchd(def.filePath, installed);
  } else if (platform === 'linux') {
    return querySystemd(def.filePath, installed);
  } else if (platform === 'win32') {
    return querySchtasks(def.filePath, installed);
  }
  return { installed, running: false, platformSpec: 'unknown', serviceFilePath: def.filePath };
}

function queryLaunchd(filePath: string, installed: boolean): ServiceStatusResult {
  try {
    const result = spawnSync('launchctl', ['list', 'ai.ashlr.daemon'], { encoding: 'utf8', timeout: 5_000 });
    const running = result.status === 0 && !!result.stdout && !result.stdout.includes('"PID" = 0');
    return { installed, running, platformSpec: 'launchd', serviceFilePath: filePath };
  } catch {
    return { installed, running: false, platformSpec: 'launchd', serviceFilePath: filePath };
  }
}

function querySystemd(filePath: string, installed: boolean): ServiceStatusResult {
  try {
    const result = spawnSync('systemctl', ['--user', 'is-active', 'ashlr-daemon'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    const running = result.status === 0 && result.stdout.trim() === 'active';
    return { installed, running, platformSpec: 'systemd', serviceFilePath: filePath };
  } catch {
    return { installed, running: false, platformSpec: 'systemd', serviceFilePath: filePath };
  }
}

function querySchtasks(filePath: string, installed: boolean): ServiceStatusResult {
  try {
    const result = spawnSync('schtasks', ['/Query', '/TN', 'AshlrDaemon', '/FO', 'CSV'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    const running = result.status === 0 && result.stdout.includes('AshlrDaemon');
    return { installed, running, platformSpec: 'schtasks', serviceFilePath: filePath };
  } catch {
    return { installed, running: false, platformSpec: 'schtasks', serviceFilePath: filePath };
  }
}

// ---------------------------------------------------------------------------
// Re-export execFileSync for test stubbing surface (lets tests vi.mock this module)
// ---------------------------------------------------------------------------
export { execFileSync };
