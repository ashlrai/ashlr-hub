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
import { buildToolPath } from '../run/tool-path.js';
import { installLaunchdPlistTransaction, removeLaunchdPlistTransaction } from './launchd-plist-transaction.js';

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
  /** Exact runtime authority when the platform exposes one without localized text. */
  runtimeState?: 'running' | 'queued' | 'ready' | 'disabled' | 'stopped' | 'unknown';
  platformSpec: PlatformSpec;
  serviceFilePath?: string;
  errorLog?: string;
}

interface CachedServiceStatusEntry {
  key: string;
  expiresAt: number;
  status: ServiceStatusResult;
}

let cachedServiceStatus: CachedServiceStatusEntry | null = null;

function clearServiceStatusCache(): void {
  cachedServiceStatus = null;
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

  // PATH that mirrors common developer shells without requiring a login shell.
  const pathEnv = buildToolPath({ home: o.home, basePath: '' });
  const uid = typeof process.getuid === 'function' ? process.getuid() : os.userInfo().uid;
  const domainTarget = `gui/${uid}`;
  const serviceTarget = `${domainTarget}/ai.ashlr.daemon`;

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
    registerArgs: ['launchctl', 'bootstrap', domainTarget, plistPath],
    unregisterArgs: ['launchctl', 'bootout', serviceTarget],
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
Environment=PATH=${buildToolPath({ home: o.home, basePath: '' })}
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
  // Task Scheduler owns activation. Keeping the launcher outside Startup is
  // essential: otherwise --no-autostart would still run it at next login.
  const cmdPath = path.join(o.configDir, 'services', 'ashlr-daemon.cmd');

  // schtasks /Create args (exec-safe array — no shell expansion)
  const taskArgs = [
    'schtasks',
    '/Create',
    '/TN', 'AshlrDaemon',
    '/TR', `"${cmdPath}"`,
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
// Register / unregister helpers (side-effectful; exec is mocked in tests)
// ---------------------------------------------------------------------------

/**
 * Run a command exec-safely (no shell) and retain output for postcondition checks.
 * Never throws — captures errors into the return value.
 */
interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runCmd(args: string[]): CommandResult {
  const [cmd, ...rest] = args;
  if (!cmd) return { ok: false, stdout: '', stderr: 'empty command' };
  try {
    const result = spawnSync(cmd, rest, { encoding: 'utf8', timeout: 15_000 });
    const ok = result.status === 0 && !result.error;
    return {
      ok,
      stdout: result.stdout ?? '',
      stderr: result.stderr || result.error?.message || '',
    };
  } catch (e) {
    return { ok: false, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
  }
}

function commandError(label: string, result: CommandResult): Error {
  return new Error(`${label} failed: ${result.stderr.trim() || result.stdout.trim() || 'exit non-zero'}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function launchdAbsent(result: CommandResult): boolean {
  const output = `${result.stdout}\n${result.stderr}`;
  return !result.ok && /(?:could not find (?:specified )?service|service .* not found|no such process|not loaded)/i.test(output);
}

interface LaunchdRuntimeState {
  loaded: boolean;
  pid?: number;
}

function readLaunchdRuntimeState(serviceTarget: string): LaunchdRuntimeState {
  const result = runCmd(['launchctl', 'print', serviceTarget]);
  if (result.ok) {
    const pidMatch = result.stdout.match(/(?:^|\s)"?pid"?\s*=\s*(\d+)/im);
    const pid = pidMatch?.[1] ? Number(pidMatch[1]) : undefined;
    return { loaded: true, ...(pid && pid > 0 ? { pid } : {}) };
  }
  if (launchdAbsent(result)) return { loaded: false };
  throw commandError(`launchctl print ${serviceTarget}`, result);
}

function launchdLoaded(serviceTarget: string): boolean {
  return readLaunchdRuntimeState(serviceTarget).loaded;
}

function launchdDisabled(domainTarget: string, label: string): boolean {
  const result = runCmd(['launchctl', 'print-disabled', domainTarget]);
  if (!result.ok) throw commandError(`launchctl print-disabled ${domainTarget}`, result);
  const matches = [...result.stdout.matchAll(
    new RegExp(`"${escapeRegExp(label)}"\\s*=>\\s*(enabled|disabled)(?:\\s|$)`, 'g'),
  )];
  if (matches.length !== 1 || !matches[0]?.[1]) {
    throw new Error(`launchctl print-disabled did not contain exactly one native state for ${label}`);
  }
  return matches[0][1] === 'disabled';
}

function setLaunchdDisabled(serviceTarget: string, domainTarget: string, label: string, disabled: boolean): CommandResult {
  const changed = runCmd(['launchctl', disabled ? 'disable' : 'enable', serviceTarget]);
  if (!changed.ok || /failed:/im.test(changed.stderr)) return { ...changed, ok: false };
  try {
    const actual = launchdDisabled(domainTarget, label);
    return actual === disabled
      ? changed
      : { ok: false, stdout: '', stderr: `disabled state is ${actual}; expected ${disabled}` };
  } catch (error) {
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
}

function stopLaunchdService(serviceTarget: string): CommandResult {
  let before: LaunchdRuntimeState;
  try {
    before = readLaunchdRuntimeState(serviceTarget);
  } catch (error) {
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }

  const stopped = runCmd(['launchctl', 'bootout', '--wait', serviceTarget]);
  if (stopped.ok && /(?:boot-?out|unload) failed:/im.test(stopped.stderr)) return { ...stopped, ok: false };
  if (!stopped.ok && !launchdAbsent(stopped)) return stopped;
  try {
    if (launchdLoaded(serviceTarget)) {
      return { ok: false, stdout: '', stderr: `${serviceTarget} remains loaded after bootout --wait` };
    }
  } catch (error) {
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }

  if (before.pid) {
    const processProbe = runCmd(['/bin/kill', '-0', String(before.pid)]);
    if (processProbe.ok) {
      return { ok: false, stdout: '', stderr: `prior launchd PID ${before.pid} remains alive after bootout --wait` };
    }
    if (!/(?:no such process|not found)/i.test(`${processProbe.stdout}\n${processProbe.stderr}`)) {
      return {
        ok: false,
        stdout: '',
        stderr: `could not prove prior launchd PID ${before.pid} exited: ` +
          `${processProbe.stderr.trim() || processProbe.stdout.trim() || 'exit non-zero'}`,
      };
    }
  }
  return { ok: true, stdout: '', stderr: '' };
}

function loadLaunchdService(domainTarget: string, serviceTarget: string, plistPath: string): CommandResult {
  const loaded = runCmd(['launchctl', 'bootstrap', domainTarget, plistPath]);
  if (!loaded.ok || /(?:bootstrap|load) failed:/im.test(loaded.stderr)) return { ...loaded, ok: false };
  try {
    return launchdLoaded(serviceTarget)
      ? loaded
      : { ok: false, stdout: '', stderr: `${serviceTarget} is absent after bootstrap` };
  } catch (error) {
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
}

function restoreLaunchdActivation(
  domainTarget: string,
  serviceTarget: string,
  label: string,
  plistPath: string,
  loaded: boolean,
  disabled: boolean,
): CommandResult {
  if (!loaded) {
    const state = setLaunchdDisabled(serviceTarget, domainTarget, label, disabled);
    if (!state.ok) return state;
    return stopLaunchdService(serviceTarget);
  }
  try {
    if (!launchdLoaded(serviceTarget)) {
      const temporarilyEnabled = setLaunchdDisabled(serviceTarget, domainTarget, label, false);
      if (!temporarilyEnabled.ok) return temporarilyEnabled;
      const restored = loadLaunchdService(domainTarget, serviceTarget, plistPath);
      if (!restored.ok) return restored;
    }
    const finalDisabledState = setLaunchdDisabled(serviceTarget, domainTarget, label, disabled);
    if (!finalDisabledState.ok) return finalDisabledState;
    return launchdLoaded(serviceTarget)
      ? finalDisabledState
      : { ok: false, stdout: '', stderr: `${serviceTarget} did not remain loaded while restoring disabled=${disabled}` };
  } catch (error) {
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
}

function parseLaunchdRecoveryState(state: unknown): { loaded: boolean; disabled: boolean } | undefined {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return undefined;
  const value = state as Record<string, unknown>;
  if (typeof value.loaded !== 'boolean' || typeof value.disabled !== 'boolean') return undefined;
  if (Object.keys(value).some((key) => key !== 'loaded' && key !== 'disabled')) return undefined;
  return { loaded: value.loaded, disabled: value.disabled };
}

interface SystemdActivationState {
  present: boolean;
  active: boolean;
  enabled: boolean;
}

function readSystemdActivationState(): SystemdActivationState {
  const active = runCmd(['systemctl', '--user', 'is-active', 'ashlr-daemon']);
  const activeToken = active.stdout.trim();
  const isActive = active.ok && activeToken === 'active';
  const isInactive = !active.ok && activeToken === 'inactive';
  if (!isActive && !isInactive) throw commandError('systemd active-state query', active);

  const enabled = runCmd(['systemctl', '--user', 'is-enabled', 'ashlr-daemon']);
  const enabledToken = enabled.stdout.trim();
  const isEnabled = enabled.ok && enabledToken === 'enabled';
  const isDisabled = !enabled.ok && enabledToken === 'disabled';
  const isMissing = !enabled.ok && enabledToken === 'not-found';
  if (!isEnabled && !isDisabled && !isMissing) throw commandError('systemd enabled-state query', enabled);
  if (isMissing && isActive) throw new Error('systemd reported an active unit with no registered definition');
  return { present: !isMissing, active: isActive, enabled: isEnabled };
}

function parseSystemdRecoveryState(state: unknown): SystemdActivationState | undefined {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return undefined;
  const value = state as Record<string, unknown>;
  if (typeof value.present !== 'boolean' || typeof value.active !== 'boolean' || typeof value.enabled !== 'boolean') {
    return undefined;
  }
  if (Object.keys(value).some((key) => !['present', 'active', 'enabled'].includes(key))) return undefined;
  if (!value.present && (value.active || value.enabled)) return undefined;
  return { present: value.present, active: value.active, enabled: value.enabled };
}

function verifySystemdState(expected: SystemdActivationState): CommandResult {
  try {
    const actual = readSystemdActivationState();
    return actual.present === expected.present && actual.active === expected.active && actual.enabled === expected.enabled
      ? { ok: true, stdout: '', stderr: '' }
      : { ok: false, stdout: '', stderr: `state=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}` };
  } catch (error) {
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
}

function applySystemdState(expected: SystemdActivationState): CommandResult {
  const reloaded = runCmd(['systemctl', '--user', 'daemon-reload']);
  if (!reloaded.ok) return reloaded;
  if (!expected.present) return verifySystemdState(expected);

  const enabled = runCmd(['systemctl', '--user', expected.enabled ? 'enable' : 'disable', 'ashlr-daemon']);
  if (!enabled.ok) return enabled;
  const active = runCmd(['systemctl', '--user', expected.active ? 'start' : 'stop', 'ashlr-daemon']);
  if (!active.ok) return active;
  return verifySystemdState(expected);
}

type WindowsTaskState = 'disabled' | 'queued' | 'ready' | 'running';

interface WindowsActivationState {
  present: boolean;
  state?: WindowsTaskState;
  legacyLauncher: boolean;
}

const WINDOWS_TASK_STATE_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$tasks=@(Get-ScheduledTask -ErrorAction Stop | Where-Object {$_.TaskName -ceq 'AshlrDaemon' -and $_.TaskPath -ceq '\\'})",
  "if($tasks.Count -eq 0){[Console]::Out.Write('absent');exit 0}",
  "if($tasks.Count -ne 1){throw 'ambiguous AshlrDaemon task authority'}",
  "[Console]::Out.Write(([int]$tasks[0].State).ToString([Globalization.CultureInfo]::InvariantCulture))",
].join(';');

function readWindowsTaskState(): { present: false } | { present: true; state: WindowsTaskState } {
  const result = runCmd([
    'powershell.exe',
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    WINDOWS_TASK_STATE_SCRIPT,
  ]);
  if (!result.ok) throw commandError('PowerShell Task Scheduler state query', result);
  const token = result.stdout.trim();
  if (token === 'absent') return { present: false };
  const states: Record<string, WindowsTaskState> = {
    '1': 'disabled',
    '2': 'queued',
    '3': 'ready',
    '4': 'running',
  };
  const state = states[token];
  if (!state) throw new Error(`PowerShell Task Scheduler state query returned unknown state ${JSON.stringify(token)}`);
  return { present: true, state };
}

function parseWindowsRecoveryState(state: unknown): WindowsActivationState | undefined {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return undefined;
  const value = state as Record<string, unknown>;
  if (typeof value.present !== 'boolean' || typeof value.legacyLauncher !== 'boolean') return undefined;
  if (Object.keys(value).some((key) => !['present', 'state', 'legacyLauncher'].includes(key))) return undefined;
  if (!value.present) {
    return value.state === undefined ? { present: false, legacyLauncher: value.legacyLauncher } : undefined;
  }
  if (!['disabled', 'queued', 'ready', 'running'].includes(String(value.state))) return undefined;
  return { present: true, state: value.state as WindowsTaskState, legacyLauncher: value.legacyLauncher };
}

function stopAndDeleteWindowsTask(): CommandResult {
  try {
    const before = readWindowsTaskState();
    if (!before.present) return { ok: true, stdout: '', stderr: '' };
    if (before.state === 'running' || before.state === 'queued') {
      const ended = runCmd(['schtasks', '/End', '/TN', 'AshlrDaemon']);
      if (!ended.ok) return ended;
      const stopped = readWindowsTaskState();
      if (!stopped.present || (stopped.state !== 'ready' && stopped.state !== 'disabled')) {
        return { ok: false, stdout: '', stderr: 'Task Scheduler could not prove AshlrDaemon stopped before deletion' };
      }
    }
    const deleted = runCmd(['schtasks', '/Delete', '/TN', 'AshlrDaemon', '/F']);
    if (!deleted.ok) return deleted;
    return readWindowsTaskState().present
      ? { ok: false, stdout: '', stderr: 'Task Scheduler deletion verification found AshlrDaemon still registered' }
      : { ok: true, stdout: '', stderr: '' };
  } catch (error) {
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
}

function verifyWindowsState(expected: WindowsActivationState): CommandResult {
  try {
    const actual = readWindowsTaskState();
    if (!expected.present) {
      return !actual.present
        ? { ok: true, stdout: '', stderr: '' }
        : { ok: false, stdout: '', stderr: `Task Scheduler state=${actual.state}; expected absent` };
    }
    if (!actual.present) return { ok: false, stdout: '', stderr: 'Task Scheduler task is absent' };
    const activeMatches = (expected.state === 'running' || expected.state === 'queued') &&
      (actual.state === 'running' || actual.state === 'queued');
    return actual.state === expected.state || activeMatches
      ? { ok: true, stdout: '', stderr: '' }
      : { ok: false, stdout: '', stderr: `Task Scheduler state=${actual.state}; expected ${expected.state}` };
  } catch (error) {
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
}

function applyWindowsState(def: ServiceDefinition, expected: WindowsActivationState): CommandResult {
  if (!expected.present) return verifyWindowsState(expected);
  const created = runCmd(def.registerArgs);
  if (!created.ok) return created;
  if (expected.state === 'disabled') {
    const disabled = runCmd(['schtasks', '/Change', '/TN', 'AshlrDaemon', '/DISABLE']);
    if (!disabled.ok) return disabled;
  } else if (expected.state === 'running' || expected.state === 'queued') {
    const started = runCmd(['schtasks', '/Run', '/TN', 'AshlrDaemon']);
    if (!started.ok) return started;
  }
  return verifyWindowsState(expected);
}

function legacyWindowsLauncherPaths(home: string, destinationDir: string): { legacy: string; archived: string } {
  const legacy = path.join(
    home,
    'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
    'ashlr-daemon.cmd',
  );
  return { legacy, archived: path.join(destinationDir, 'ashlr-daemon.startup-legacy.cmd.disabled') };
}

function assertSafePathParents(rootPath: string, filePath: string, label: string): void {
  const root = path.resolve(rootPath);
  const target = path.resolve(filePath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain below ${root}`);
  }
  let current = root;
  for (const component of relative.split(path.sep).slice(0, -1)) {
    const stat = fs.lstatSync(current);
    const owned = typeof process.getuid !== 'function' || stat.uid === process.getuid();
    const safeMode = process.platform === 'win32' || (stat.mode & 0o022) === 0;
    if (stat.isSymbolicLink() || !stat.isDirectory() || !owned || !safeMode) {
      throw new Error(`unsafe ${label} parent component ${current}`);
    }
    current = path.join(current, component);
  }
  const parent = fs.lstatSync(current);
  const owned = typeof process.getuid !== 'function' || parent.uid === process.getuid();
  const safeMode = process.platform === 'win32' || (parent.mode & 0o022) === 0;
  if (parent.isSymbolicLink() || !parent.isDirectory() || !owned || !safeMode) {
    throw new Error(`unsafe ${label} parent component ${current}`);
  }
}

function fsyncDirectoryFor(filePath: string): void {
  const fd = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function validateLegacyWindowsLauncher(filePath: string, label: string): void {
  const stat = fs.lstatSync(filePath);
  const owned = typeof process.getuid !== 'function' || stat.uid === process.getuid();
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || !owned) {
    throw new Error(`unsafe ${label}: expected a regular, singly-linked owned file at ${filePath}`);
  }
}

function inspectLegacyWindowsLauncher(home: string, destinationDir: string): boolean {
  const { legacy, archived } = legacyWindowsLauncherPaths(home, destinationDir);
  if (!fs.existsSync(legacy)) return false;
  assertSafePathParents(home, legacy, 'legacy Windows launcher');
  assertSafePathParents(home, archived, 'legacy Windows launcher archive');
  validateLegacyWindowsLauncher(legacy, 'legacy Windows launcher');
  if (fs.existsSync(archived)) throw new Error(`legacy Windows launcher archive already exists at ${archived}`);
  return true;
}

function archiveLegacyWindowsLauncher(home: string, destinationDir: string, expected: boolean): CommandResult {
  try {
    if (!expected) return { ok: true, stdout: '', stderr: '' };
    const { legacy, archived } = legacyWindowsLauncherPaths(home, destinationDir);
    if (fs.existsSync(legacy)) {
      assertSafePathParents(home, legacy, 'legacy Windows launcher');
      assertSafePathParents(home, archived, 'legacy Windows launcher archive');
      validateLegacyWindowsLauncher(legacy, 'legacy Windows launcher');
      if (fs.existsSync(archived)) throw new Error(`legacy Windows launcher archive already exists at ${archived}`);
      fs.renameSync(legacy, archived);
      fsyncDirectoryFor(legacy);
      fsyncDirectoryFor(archived);
      return { ok: true, stdout: '', stderr: '' };
    }
    if (!fs.existsSync(archived)) throw new Error('legacy Windows launcher disappeared during transaction');
    validateLegacyWindowsLauncher(archived, 'archived legacy Windows launcher');
    return { ok: true, stdout: '', stderr: '' };
  } catch (error) {
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
}

function restoreLegacyWindowsLauncher(home: string, destinationDir: string, expected: boolean): CommandResult {
  try {
    if (!expected) return { ok: true, stdout: '', stderr: '' };
    const { legacy, archived } = legacyWindowsLauncherPaths(home, destinationDir);
    if (fs.existsSync(legacy)) {
      assertSafePathParents(home, legacy, 'legacy Windows launcher');
      validateLegacyWindowsLauncher(legacy, 'legacy Windows launcher');
      if (fs.existsSync(archived)) throw new Error('both legacy Windows launcher paths exist during recovery');
      return { ok: true, stdout: '', stderr: '' };
    }
    assertSafePathParents(home, archived, 'archived legacy Windows launcher');
    assertSafePathParents(home, legacy, 'legacy Windows launcher');
    validateLegacyWindowsLauncher(archived, 'archived legacy Windows launcher');
    fs.renameSync(archived, legacy);
    fsyncDirectoryFor(archived);
    fsyncDirectoryFor(legacy);
    return { ok: true, stdout: '', stderr: '' };
  } catch (error) {
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
}

function restoreWindowsState(
  def: ServiceDefinition,
  home: string,
  state: WindowsActivationState,
): CommandResult {
  const task = applyWindowsState(def, state);
  const legacy = restoreLegacyWindowsLauncher(home, path.dirname(def.filePath), state.legacyLauncher);
  if (task.ok && legacy.ok) return task;
  return {
    ok: false,
    stdout: '',
    stderr: [task.ok ? '' : task.stderr, legacy.ok ? '' : legacy.stderr].filter(Boolean).join('; '),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Install and register the ashlr daemon as an OS service.
 *
 * Idempotent: backs up any existing service file, writes fresh, then loads.
 * Every platform verifies the requested activation state before returning.
 * Missing service managers, permission failures, and ambiguous status output
 * fail closed so callers cannot mistake a partial install for success.
 */
export async function install(opts: ServiceInstallOptions = {}): Promise<void> {
  const platform = (opts.platform ?? process.platform) as Platform;
  const def = generateServiceDefinition(opts);
  const autostart = opts.autostart !== false;

  if (platform === 'darwin') {
    const home = resolveHome(opts.homeDir);
    const uid = typeof process.getuid === 'function' ? process.getuid() : os.userInfo().uid;
    const domainTarget = `gui/${uid}`;
    const label = 'ai.ashlr.daemon';
    const serviceTarget = `${domainTarget}/${label}`;
    let priorActivation: { loaded: boolean; disabled: boolean } | undefined;
    installLaunchdPlistTransaction({
      plistPath: def.filePath,
      trustedRoot: home,
      content: def.content,
      lockDir: path.join(home, '.ashlr', 'locks'),
      preflight: ({ hasPrior }) => {
        try {
          const runtime = readLaunchdRuntimeState(serviceTarget);
          if (runtime.loaded && !hasPrior) {
            return {
              ok: false,
              stdout: '',
              stderr: `refusing to replace loaded ${serviceTarget} without a trusted prior plist`,
            };
          }
          priorActivation = {
            loaded: runtime.loaded,
            disabled: launchdDisabled(domainTarget, label),
          };
          return { ok: true, stdout: '', stderr: '', recoveryState: priorActivation };
        } catch (error) {
          return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
        }
      },
      unload: () => stopLaunchdService(serviceTarget),
      load: () => {
        const state = setLaunchdDisabled(serviceTarget, domainTarget, label, !autostart);
        if (!state.ok || !autostart) return state;
        return loadLaunchdService(domainTarget, serviceTarget, def.filePath);
      },
      verify: () => {
        try {
          const disabled = launchdDisabled(domainTarget, label);
          const loaded = launchdLoaded(serviceTarget);
          return disabled === !autostart && loaded === autostart
            ? { ok: true, stdout: '', stderr: '' }
            : {
                ok: false,
                stdout: '',
                stderr: `launchd state loaded=${loaded} disabled=${disabled}; ` +
                  `expected loaded=${autostart} disabled=${!autostart}`,
              };
        } catch (error) {
          return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
        }
      },
      rollback: () => {
        if (!priorActivation) {
          return { ok: false, stdout: '', stderr: 'launchd activation preflight state is unavailable' };
        }
        return restoreLaunchdActivation(
          domainTarget,
          serviceTarget,
          label,
          def.filePath,
          priorActivation.loaded,
          priorActivation.disabled,
        );
      },
      recover: (state) => {
        const activation = parseLaunchdRecoveryState(state);
        if (!activation) {
          return { ok: false, stdout: '', stderr: 'invalid persisted launchd activation state' };
        }
        return restoreLaunchdActivation(
          domainTarget,
          serviceTarget,
          label,
          def.filePath,
          activation.loaded,
          activation.disabled,
        );
      },
    });
  } else if (platform === 'linux') {
    const home = resolveHome(opts.homeDir);
    let priorActivation: SystemdActivationState | undefined;
    const desired = { present: true, active: autostart, enabled: autostart };
    installLaunchdPlistTransaction({
      plistPath: def.filePath,
      trustedRoot: home,
      content: def.content,
      lockDir: path.join(home, '.ashlr', 'locks'),
      operationLabel: 'systemd',
      preflight: ({ hasPrior }) => {
        try {
          const state = readSystemdActivationState();
          if (state.present && !hasPrior) {
            return { ok: false, stdout: '', stderr: 'refusing to replace registered systemd unit without a trusted prior file' };
          }
          priorActivation = state;
          return { ok: true, stdout: '', stderr: '', recoveryState: state };
        } catch (error) {
          return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
        }
      },
      unload: () => {
        try {
          const current = readSystemdActivationState();
          if (!current.present) return { ok: true, stdout: '', stderr: '' };
          const disabled = runCmd(['systemctl', '--user', 'disable', '--now', 'ashlr-daemon']);
          if (!disabled.ok) return disabled;
          return verifySystemdState({ present: true, active: false, enabled: false });
        } catch (error) {
          return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
        }
      },
      load: () => {
        const reloaded = runCmd(['systemctl', '--user', 'daemon-reload']);
        if (!reloaded.ok) return reloaded;
        const changed = runCmd(autostart ? def.registerArgs : def.unregisterArgs);
        if (!changed.ok) return changed;
        return verifySystemdState(desired);
      },
      verify: () => verifySystemdState(desired),
      rollback: () => priorActivation
        ? applySystemdState(priorActivation)
        : { ok: false, stdout: '', stderr: 'systemd activation preflight state is unavailable' },
      recover: (state) => {
        const activation = parseSystemdRecoveryState(state);
        return activation
          ? applySystemdState(activation)
          : { ok: false, stdout: '', stderr: 'invalid persisted systemd activation state' };
      },
    });
  } else if (platform === 'win32') {
    const home = resolveHome(opts.homeDir);
    let priorActivation: WindowsActivationState | undefined;
    const desired: WindowsActivationState = autostart
      ? { present: true, state: 'ready', legacyLauncher: false }
      : { present: false, legacyLauncher: false };
    installLaunchdPlistTransaction({
      plistPath: def.filePath,
      trustedRoot: home,
      content: def.content,
      lockDir: path.join(home, '.ashlr', 'locks'),
      operationLabel: 'Task Scheduler',
      preflight: ({ hasPrior }) => {
        try {
          const task = readWindowsTaskState();
          if (task.present && !hasPrior) {
            return { ok: false, stdout: '', stderr: 'refusing to replace registered AshlrDaemon task without a trusted prior launcher' };
          }
          priorActivation = {
            ...task,
            legacyLauncher: inspectLegacyWindowsLauncher(home, path.dirname(def.filePath)),
          };
          return { ok: true, stdout: '', stderr: '', recoveryState: priorActivation };
        } catch (error) {
          return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
        }
      },
      unload: () => {
        const { legacy, archived: archive } = legacyWindowsLauncherPaths(home, path.dirname(def.filePath));
        const shouldArchive = priorActivation?.legacyLauncher ?? (fs.existsSync(legacy) || fs.existsSync(archive));
        const archived = archiveLegacyWindowsLauncher(home, path.dirname(def.filePath), shouldArchive);
        if (!archived.ok) return archived;
        return stopAndDeleteWindowsTask();
      },
      load: () => autostart ? applyWindowsState(def, desired) : verifyWindowsState(desired),
      verify: () => verifyWindowsState(desired),
      rollback: () => priorActivation
        ? restoreWindowsState(def, home, priorActivation)
        : { ok: false, stdout: '', stderr: 'Windows activation preflight state is unavailable' },
      recover: (state) => {
        const activation = parseWindowsRecoveryState(state);
        return activation
          ? restoreWindowsState(def, home, activation)
          : { ok: false, stdout: '', stderr: 'invalid persisted Windows activation state' };
      },
    });
  }
  clearServiceStatusCache();
}

/**
 * Unload and remove the OS service registration.
 * Never throws — best-effort on each step.
 */
export async function uninstall(opts: ServiceInstallOptions = {}): Promise<void> {
  const platform = (opts.platform ?? process.platform) as Platform;
  const def = generateServiceDefinition(opts);

  if (platform === 'darwin') {
    const home = resolveHome(opts.homeDir);
    const uid = typeof process.getuid === 'function' ? process.getuid() : os.userInfo().uid;
    const serviceTarget = `gui/${uid}/ai.ashlr.daemon`;
    try {
      removeLaunchdPlistTransaction({
        plistPath: def.filePath,
        trustedRoot: home,
        lockDir: path.join(home, '.ashlr', 'locks'),
        unload: () => stopLaunchdService(serviceTarget),
      });
    } catch { /* uninstall remains best-effort */ }
  } else {
    runCmd(def.unregisterArgs);
    if (fs.existsSync(def.filePath)) fs.unlinkSync(def.filePath);
  }
  clearServiceStatusCache();
}

/**
 * Best-effort service activation for already-installed daemon services.
 *
 * This intentionally does not install a missing service and does not change the
 * daemon kill switch. It closes the common gap where a service was loaded while
 * the fleet was paused, exited cleanly, and then needed a kick after resume.
 */
export async function ensureRunning(opts: ServiceInstallOptions = {}): Promise<ServiceStatusResult> {
  const before = serviceStatus(opts);
  if (!before.installed || before.running) return before;

  const platform = (opts.platform ?? process.platform) as Platform;
  if (platform === 'win32' && before.runtimeState !== 'ready') return before;
  if (platform === 'darwin') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : os.userInfo().uid;
    runCmd(['launchctl', 'kickstart', '-k', `gui/${uid}/ai.ashlr.daemon`]);
  } else if (platform === 'linux') {
    runCmd(['systemctl', '--user', 'start', 'ashlr-daemon']);
  } else if (platform === 'win32') {
    runCmd(['schtasks', '/Run', '/TN', 'AshlrDaemon']);
  }

  clearServiceStatusCache();
  return serviceStatus(opts);
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

export function serviceStatusCached(
  opts: ServiceInstallOptions = {},
  cacheMs = 15_000,
): ServiceStatusResult {
  const key = JSON.stringify({
    platform: opts.platform ?? process.platform,
    homeDir: opts.homeDir ?? null,
    nodePath: opts.nodePath ?? null,
    binPath: opts.binPath ?? null,
    budget: opts.budget ?? null,
    intervalMs: opts.intervalMs ?? null,
    parallel: opts.parallel ?? null,
    keepAwake: opts.keepAwake ?? null,
  });
  const now = Date.now();
  if (cachedServiceStatus && cachedServiceStatus.key === key && cachedServiceStatus.expiresAt > now) {
    return cachedServiceStatus.status;
  }
  const status = serviceStatus(opts);
  cachedServiceStatus = {
    key,
    expiresAt: now + Math.max(0, cacheMs),
    status,
  };
  return status;
}

function queryLaunchd(filePath: string, installed: boolean): ServiceStatusResult {
  try {
    const result = spawnSync('launchctl', ['list', 'ai.ashlr.daemon'], { encoding: 'utf8', timeout: 5_000 });
    const pidMatch = result.stdout.match(/"PID"\s*=\s*(\d+)/);
    const pid = pidMatch ? Number(pidMatch[1]) : 0;
    const running = result.status === 0 && Number.isFinite(pid) && pid > 0;
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
    const task = readWindowsTaskState();
    if (!task.present) {
      return { installed, running: false, runtimeState: 'stopped', platformSpec: 'schtasks', serviceFilePath: filePath };
    }
    const running = task.state === 'running' || task.state === 'queued';
    return { installed, running, runtimeState: task.state, platformSpec: 'schtasks', serviceFilePath: filePath };
  } catch {
    return { installed, running: false, runtimeState: 'unknown', platformSpec: 'schtasks', serviceFilePath: filePath };
  }
}

// ---------------------------------------------------------------------------
// Re-export execFileSync for test stubbing surface (lets tests vi.mock this module)
// ---------------------------------------------------------------------------
export { execFileSync };
