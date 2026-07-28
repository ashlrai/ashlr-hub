/**
 * DaemonServiceManager — M93
 *
 * Cross-platform OS service registration for the ashlr daemon.
 * Supports macOS (launchd), Linux (systemd --user), and Windows (schtasks).
 *
 * DESIGN CONTRACT:
 *  - install(), uninstall(), and ensureRunning() are side-effectful entry points.
 *  - generateServiceDefinition() / buildRegisterCommand() / buildUnregisterCommand()
 *    are pure and fully testable with a mocked process.platform.
 *  - serviceStatus() queries the OS but never throws.
 *  - Every file write is idempotent; an existing file is backed up before overwrite.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildToolPath } from '../run/tool-path.js';
import { fsyncDirectory } from '../util/durability.js';
import {
  installLaunchdPlistTransaction,
  removeLaunchdPlistTransaction,
  withServiceFileTransactionLock,
  type LaunchdInstallPhase,
} from './launchd-plist-transaction.js';
import { validateWindowsFileAuthority } from './windows-file-authority.js';
import {
  WINDOWS_TASK_CREATE_SCRIPT,
  WINDOWS_TASK_RESTORE_SCRIPT,
  WINDOWS_TASK_RUN_SCRIPT,
  WINDOWS_TASK_SNAPSHOT_SCRIPT,
  WINDOWS_TASK_STOP_DELETE_SCRIPT,
  windowsPowerShellPath,
} from './windows-task-scripts.js';

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
  /** Exact native launchd command expected from a loaded generated plist. */
  launchdRuntime?: {
    program: string;
    arguments: string[];
  };
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
  const runtimeArguments = o.keepAwake
    ? ['caffeinate', '-i', '-s', o.nodePath, o.binPath]
    : [o.nodePath, o.binPath];
  runtimeArguments.push(
    'daemon',
    'start',
    '--budget',
    String(o.budget),
    '--interval',
    String(o.intervalMs),
    '--parallel',
    String(o.parallel),
  );
  const programArgs = runtimeArguments.map((argument) => `\t\t<string>${argument}</string>`);

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
    launchdRuntime: {
      program: runtimeArguments[0]!,
      arguments: runtimeArguments,
    },
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
    '/IT',
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

function runCmd(args: string[], input?: string, timeoutMs = 15_000): CommandResult {
  const [cmd, ...rest] = args;
  if (!cmd) return { ok: false, stdout: '', stderr: 'empty command' };
  try {
    const result = spawnSync(cmd, rest, {
      encoding: 'utf8',
      timeout: timeoutMs,
      ...(input === undefined ? {} : { input }),
    });
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

export interface LaunchdRuntimeState {
  loaded: boolean;
  pid?: number;
}

interface LaunchdRuntimeReadOptions {
  expectedPath?: string;
  expectedProgram?: string;
  expectedArguments?: readonly string[];
  timeoutMs?: number;
}

export function parseExactLaunchdPrintRuntime(
  output: string,
  serviceTarget: string,
  expectedPath: string,
  expectedProgram: string,
  expectedArguments: readonly string[],
): LaunchdRuntimeState | null {
  const lines = output.trimEnd().split(/\r?\n/);
  if (lines[0] !== `${serviceTarget} = {` || lines.at(-1)?.trim() !== '}') return null;

  const values = (field: string): string[] => {
    const prefix = `\t${field} = `;
    return lines
      .filter((line) => line.startsWith(prefix))
      .map((line) => line.slice(prefix.length).trim());
  };
  const paths = values('path');
  const programs = values('program');
  const states = values('state');
  const pids = values('pid');
  const argumentsBlocks = lines
    .map((line, index) => line === '\targuments = {' ? index : -1)
    .filter((index) => index >= 0);
  if (argumentsBlocks.length !== 1) return null;
  const argumentsStart = argumentsBlocks[0]!;
  const argumentsEnd = argumentsStart < 0
    ? -1
    : lines.indexOf('\t}', argumentsStart + 1);
  if (argumentsStart < 0 || argumentsEnd < 0) return null;
  const launchdArguments = lines.slice(argumentsStart + 1, argumentsEnd);
  if (launchdArguments.some((line) => !line.startsWith('\t\t'))) return null;
  const parsedArguments = launchdArguments.map((line) => line.slice(2));
  if (
    paths.length !== 1
    || paths[0] !== expectedPath
    || programs.length !== 1
    || programs[0] !== expectedProgram
    || JSON.stringify(parsedArguments) !== JSON.stringify(expectedArguments)
    || states.length !== 1
    || pids.length > 1
  ) {
    return null;
  }

  const state = states[0];
  const pid = pids[0] && /^\d+$/.test(pids[0]) ? Number(pids[0]) : undefined;
  if (pids.length === 1 && (!pid || !Number.isSafeInteger(pid))) return null;
  if (state === 'running') return pid ? { loaded: true, pid } : null;
  if (!new Set(['waiting', 'not running', 'exited', 'stopped']).has(state) || pid !== undefined) {
    return null;
  }
  return { loaded: true };
}

function readLaunchdRuntimeState(
  serviceTarget: string,
  options: LaunchdRuntimeReadOptions = {},
): LaunchdRuntimeState {
  const result = runCmd(
    ['launchctl', 'print', serviceTarget],
    undefined,
    options.timeoutMs ?? 15_000,
  );
  if (result.ok) {
    const strictContractRequested = options.expectedPath !== undefined
      || options.expectedProgram !== undefined
      || options.expectedArguments !== undefined;
    if (strictContractRequested) {
      if (
        options.expectedPath === undefined
        || options.expectedProgram === undefined
        || options.expectedArguments === undefined
      ) {
        throw new Error(`launchctl print ${serviceTarget} strict contract is incomplete`);
      }
      const exact = result.stderr.trim() === ''
        ? parseExactLaunchdPrintRuntime(
            result.stdout,
            serviceTarget,
            options.expectedPath,
            options.expectedProgram,
            options.expectedArguments,
          )
        : null;
      if (!exact) {
        throw new Error(`launchctl print ${serviceTarget} returned an unrecognized native state`);
      }
      return exact;
    }
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
  fragmentPath?: string;
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
  if (isMissing) return { present: false, active: false, enabled: false };
  const fragment = runCmd([
    'systemctl',
    '--user',
    'show',
    'ashlr-daemon',
    '--property=FragmentPath',
    '--value',
  ]);
  const fragmentPath = fragment.stdout.trim();
  if (!fragment.ok || !path.isAbsolute(fragmentPath) || fragmentPath !== fragment.stdout.replace(/\r?\n$/, '')) {
    throw commandError('systemd FragmentPath query', fragment);
  }
  return { present: true, active: isActive, enabled: isEnabled, fragmentPath };
}

function parseSystemdRecoveryState(state: unknown): SystemdActivationState | undefined {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return undefined;
  const value = state as Record<string, unknown>;
  if (typeof value.present !== 'boolean' || typeof value.active !== 'boolean' || typeof value.enabled !== 'boolean') {
    return undefined;
  }
  if (Object.keys(value).some((key) => !['present', 'active', 'enabled', 'fragmentPath'].includes(key))) return undefined;
  if (!value.present && (value.active || value.enabled)) return undefined;
  if (!value.present) {
    return value.fragmentPath === undefined
      ? { present: false, active: false, enabled: false }
      : undefined;
  }
  if (typeof value.fragmentPath !== 'string' || !path.isAbsolute(value.fragmentPath)) return undefined;
  return {
    present: true,
    active: value.active,
    enabled: value.enabled,
    fragmentPath: value.fragmentPath,
  };
}

function verifySystemdState(expected: SystemdActivationState): CommandResult {
  try {
    const actual = readSystemdActivationState();
    return actual.present === expected.present &&
      actual.active === expected.active &&
      actual.enabled === expected.enabled &&
      actual.fragmentPath === expected.fragmentPath
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
type WindowsTaskSecurityScope = 'owner-group-dacl';
const MAX_WINDOWS_TASK_XML_BYTES = 256 * 1024;
const MAX_WINDOWS_TASK_SECURITY_DESCRIPTOR_BYTES = 64 * 1024;
const WINDOWS_TASK_SECURITY_SCOPE: WindowsTaskSecurityScope = 'owner-group-dacl';

interface WindowsActivationState {
  present: boolean;
  state?: WindowsTaskState;
  legacyLauncher: boolean;
  taskXmlBase64?: string;
  taskXmlSha256?: string;
  taskSecurityDescriptorBase64?: string;
  taskSecurityDescriptorSha256?: string;
  taskSecurityScope?: WindowsTaskSecurityScope;
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
    windowsPowerShellPath(),
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    WINDOWS_TASK_STATE_SCRIPT,
  ]);
  if (!result.ok) throw commandError('PowerShell Task Scheduler state query', result);
  const token = result.stdout.trim();
  if (token === 'absent') return { present: false };
  const state = windowsTaskStateFromToken(token);
  if (!state) throw new Error(`PowerShell Task Scheduler state query returned unknown state ${JSON.stringify(token)}`);
  return { present: true, state };
}

function windowsTaskStateFromToken(token: string): WindowsTaskState | undefined {
  return ({
    '1': 'disabled',
    '2': 'queued',
    '3': 'ready',
    '4': 'running',
  } as const)[token];
}

function decodeCanonicalBase64(
  value: unknown,
  maxBytes: number,
  label: string,
): { base64: string; sha256: string } {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(maxBytes / 3) * 4) {
    throw new Error(`invalid ${label}`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.length > maxBytes || bytes.toString('base64') !== value) {
    throw new Error(`invalid ${label}`);
  }
  return {
    base64: value,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function readWindowsTaskSnapshot(expectedLauncherPath: string):
  | { present: false }
  | {
      present: true;
      state: WindowsTaskState;
      taskXmlBase64: string;
      taskXmlSha256: string;
      taskSecurityDescriptorBase64: string;
      taskSecurityDescriptorSha256: string;
      taskSecurityScope: WindowsTaskSecurityScope;
    } {
  if (!path.isAbsolute(expectedLauncherPath)) {
    throw new Error('expected Task Scheduler launcher path must be absolute');
  }
  const result = runCmd([
    windowsPowerShellPath(),
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    WINDOWS_TASK_SNAPSHOT_SCRIPT,
  ], JSON.stringify({ expectedLauncherPath }));
  if (!result.ok) {
    throw new Error(`PowerShell Task Scheduler snapshot failed: ${result.stderr.trim() || 'exit non-zero'}`);
  }
  if (result.stdout === 'absent') return { present: false };
  if (Buffer.byteLength(result.stdout, 'utf8') > (
    MAX_WINDOWS_TASK_XML_BYTES + MAX_WINDOWS_TASK_SECURITY_DESCRIPTOR_BYTES
  ) * 2) {
    throw new Error('PowerShell Task Scheduler snapshot exceeded output limit');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error('PowerShell Task Scheduler snapshot returned invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('PowerShell Task Scheduler snapshot returned invalid shape');
  }
  const value = parsed as Record<string, unknown>;
  if (
    Object.keys(value).join(',') !==
      'state,taskXmlBase64,taskSecurityDescriptorBase64' ||
    typeof value.state !== 'string'
  ) {
    throw new Error('PowerShell Task Scheduler snapshot returned invalid shape');
  }
  const state = windowsTaskStateFromToken(value.state);
  if (!state || result.stdout !== JSON.stringify({
    state: value.state,
    taskXmlBase64: value.taskXmlBase64,
    taskSecurityDescriptorBase64: value.taskSecurityDescriptorBase64,
  })) {
    throw new Error('PowerShell Task Scheduler snapshot returned noncanonical output');
  }
  const xml = decodeCanonicalBase64(
    value.taskXmlBase64,
    MAX_WINDOWS_TASK_XML_BYTES,
    'Task Scheduler XML snapshot',
  );
  const security = decodeCanonicalBase64(
    value.taskSecurityDescriptorBase64,
    MAX_WINDOWS_TASK_SECURITY_DESCRIPTOR_BYTES,
    'Task Scheduler security descriptor snapshot',
  );
  return {
    present: true,
    state,
    taskXmlBase64: xml.base64,
    taskXmlSha256: xml.sha256,
    taskSecurityDescriptorBase64: security.base64,
    taskSecurityDescriptorSha256: security.sha256,
    taskSecurityScope: WINDOWS_TASK_SECURITY_SCOPE,
  };
}

function parseWindowsRecoveryState(state: unknown): WindowsActivationState | undefined {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return undefined;
  const value = state as Record<string, unknown>;
  if (typeof value.present !== 'boolean' || typeof value.legacyLauncher !== 'boolean') return undefined;
  const keys = Object.keys(value).join(',');
  if (!value.present) {
    if (keys !== 'present,legacyLauncher') return undefined;
    return value.state === undefined &&
      value.taskXmlBase64 === undefined &&
      value.taskXmlSha256 === undefined &&
      value.taskSecurityDescriptorBase64 === undefined &&
      value.taskSecurityDescriptorSha256 === undefined
      ? { present: false, legacyLauncher: value.legacyLauncher }
      : undefined;
  }
  if (
    keys !==
    'present,state,legacyLauncher,taskXmlBase64,taskXmlSha256,' +
      'taskSecurityDescriptorBase64,taskSecurityDescriptorSha256,taskSecurityScope'
  ) return undefined;
  if (!['disabled', 'queued', 'ready', 'running'].includes(String(value.state))) return undefined;
  if (
    typeof value.taskXmlSha256 !== 'string' ||
    typeof value.taskSecurityDescriptorSha256 !== 'string' ||
    value.taskSecurityScope !== WINDOWS_TASK_SECURITY_SCOPE
  ) return undefined;
  try {
    const xml = decodeCanonicalBase64(
      value.taskXmlBase64,
      MAX_WINDOWS_TASK_XML_BYTES,
      'persisted Task Scheduler XML snapshot',
    );
    const security = decodeCanonicalBase64(
      value.taskSecurityDescriptorBase64,
      MAX_WINDOWS_TASK_SECURITY_DESCRIPTOR_BYTES,
      'persisted Task Scheduler security descriptor snapshot',
    );
    if (
      xml.sha256 !== value.taskXmlSha256 ||
      security.sha256 !== value.taskSecurityDescriptorSha256
    ) return undefined;
    return {
      present: true,
      state: value.state as WindowsTaskState,
      legacyLauncher: value.legacyLauncher,
      taskXmlBase64: xml.base64,
      taskXmlSha256: xml.sha256,
      taskSecurityDescriptorBase64: security.base64,
      taskSecurityDescriptorSha256: security.sha256,
      taskSecurityScope: WINDOWS_TASK_SECURITY_SCOPE,
    };
  } catch {
    return undefined;
  }
}

function stopAndDeleteWindowsTask(
  expected: WindowsActivationState,
  expectedLauncherPath: string,
): CommandResult {
  try {
    if (!expected.present) {
      return readWindowsTaskState().present
        ? { ok: false, stdout: '', stderr: 'unexpected AshlrDaemon task exists before removal' }
        : { ok: true, stdout: '', stderr: '' };
    }
    if (
      !expected.taskXmlSha256 ||
      !expected.taskSecurityDescriptorSha256 ||
      expected.taskSecurityScope !== WINDOWS_TASK_SECURITY_SCOPE
    ) {
      return { ok: false, stdout: '', stderr: 'exact Task Scheduler removal authority is unavailable' };
    }
    const deleted = runCmd([
      windowsPowerShellPath(),
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_TASK_STOP_DELETE_SCRIPT,
    ], JSON.stringify({
      expectedLauncherPath,
      taskSecurityDescriptorSha256: expected.taskSecurityDescriptorSha256,
      taskXmlSha256: expected.taskXmlSha256,
    }));
    return deleted.ok && deleted.stdout === 'deleted'
      ? { ok: true, stdout: '', stderr: '' }
      : {
          ok: false,
          stdout: '',
          stderr: deleted.stderr.trim() || 'Task Scheduler authority-bound removal failed',
        };
  } catch (error) {
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
}

function runWindowsTask(expectedLauncherPath: string): CommandResult {
  try {
    if (!path.isAbsolute(expectedLauncherPath)) {
      return { ok: false, stdout: '', stderr: 'expected Task Scheduler launcher path must be absolute' };
    }
    const started = runCmd([
      windowsPowerShellPath(),
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_TASK_RUN_SCRIPT,
    ], JSON.stringify({ expectedLauncherPath }));
    return started.ok && started.stdout === 'started'
      ? { ok: true, stdout: '', stderr: '' }
      : {
          ok: false,
          stdout: '',
          stderr: started.stderr.trim() || 'Task Scheduler authority-bound activation failed',
        };
  } catch (error) {
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
}

function verifyWindowsState(
  expected: WindowsActivationState,
  expectedLauncherPath: string,
): CommandResult {
  try {
    const expectedHasSnapshot = expected.present && expected.taskXmlBase64 !== undefined;
    const actual = expected.present
      ? readWindowsTaskSnapshot(expectedLauncherPath)
      : readWindowsTaskState();
    if (!expected.present) {
      return !actual.present
        ? { ok: true, stdout: '', stderr: '' }
        : { ok: false, stdout: '', stderr: `Task Scheduler state=${actual.state}; expected absent` };
    }
    if (!actual.present) return { ok: false, stdout: '', stderr: 'Task Scheduler task is absent' };
    const activeMatches = expected.state === 'queued' && actual.state === 'running';
    if (actual.state !== expected.state && !activeMatches) {
      return { ok: false, stdout: '', stderr: `Task Scheduler state=${actual.state}; expected ${expected.state}` };
    }
    if (expectedHasSnapshot) {
      const snapshot = actual as Extract<ReturnType<typeof readWindowsTaskSnapshot>, { present: true }>;
      if (
        snapshot.taskXmlBase64 !== expected.taskXmlBase64 ||
        snapshot.taskXmlSha256 !== expected.taskXmlSha256 ||
        snapshot.taskSecurityDescriptorBase64 !== expected.taskSecurityDescriptorBase64 ||
        snapshot.taskSecurityDescriptorSha256 !== expected.taskSecurityDescriptorSha256 ||
        snapshot.taskSecurityScope !== expected.taskSecurityScope
      ) {
        return { ok: false, stdout: '', stderr: 'Task Scheduler definition snapshot mismatch' };
      }
    }
    return { ok: true, stdout: '', stderr: '' };
  } catch (error) {
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
}

function restoreWindowsTaskDefinition(
  expected: WindowsActivationState,
  expectedLauncherPath: string,
): CommandResult {
  if (
    !expected.present ||
    !expected.taskXmlBase64 ||
    !expected.taskXmlSha256 ||
    !expected.taskSecurityDescriptorBase64 ||
    !expected.taskSecurityDescriptorSha256 ||
    expected.taskSecurityScope !== WINDOWS_TASK_SECURITY_SCOPE
  ) {
    return { ok: false, stdout: '', stderr: 'exact prior Task Scheduler definition is unavailable' };
  }
  try {
    const parsed = parseWindowsRecoveryState(expected);
    if (!parsed?.present) {
      return { ok: false, stdout: '', stderr: 'exact prior Task Scheduler definition is invalid' };
    }
    const restored = runCmd([
      windowsPowerShellPath(),
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_TASK_RESTORE_SCRIPT,
    ], JSON.stringify({
      expectedLauncherPath,
      taskXmlBase64: parsed.taskXmlBase64,
      taskSecurityDescriptorBase64: parsed.taskSecurityDescriptorBase64,
    }));
    if (!restored.ok || restored.stdout !== 'restored') {
      return {
        ok: false,
        stdout: '',
        stderr: restored.stderr.trim() || 'Task Scheduler exact definition restore failed',
      };
    }
    if (expected.state === 'running' || expected.state === 'queued') {
      const started = runWindowsTask(expectedLauncherPath);
      if (!started.ok) return started;
    }
    return verifyWindowsState(parsed, expectedLauncherPath);
  } catch (error) {
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
}

function applyWindowsState(def: ServiceDefinition, expected: WindowsActivationState): CommandResult {
  if (!expected.present) return verifyWindowsState(expected, def.filePath);
  if (expected.taskXmlBase64 !== undefined) {
    return restoreWindowsTaskDefinition(expected, def.filePath);
  }
  const created = runCmd([
    windowsPowerShellPath(),
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    WINDOWS_TASK_CREATE_SCRIPT,
  ], JSON.stringify({ expectedLauncherPath: def.filePath }));
  if (!created.ok || created.stdout !== 'created') {
    return {
      ok: false,
      stdout: '',
      stderr: created.stderr.trim() || 'Task Scheduler strict definition creation failed',
    };
  }
  if (expected.state === 'disabled') {
    const disabled = runCmd(['schtasks', '/Change', '/TN', 'AshlrDaemon', '/DISABLE']);
    if (!disabled.ok) return disabled;
  } else if (expected.state === 'running' || expected.state === 'queued') {
    const started = runWindowsTask(def.filePath);
    if (!started.ok) return started;
  }
  return verifyWindowsState(expected, def.filePath);
}

function legacyWindowsLauncherPaths(home: string, destinationDir: string): { legacy: string; archived: string } {
  const legacy = path.join(
    home,
    'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
    'ashlr-daemon.cmd',
  );
  return { legacy, archived: path.join(destinationDir, 'ashlr-daemon.startup-legacy.cmd.disabled') };
}

function lstatOptional(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function safePathParentsExist(rootPath: string, filePath: string, label: string): boolean {
  const root = path.resolve(rootPath);
  const target = path.resolve(filePath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain below ${root}`);
  }
  let current = root;
  for (const component of relative.split(path.sep).slice(0, -1)) {
    const stat = lstatOptional(current);
    if (!stat) return false;
    validateSafePathParent(root, current, stat, label);
    current = path.join(current, component);
  }
  const parent = lstatOptional(current);
  if (!parent) return false;
  validateSafePathParent(root, current, parent, label);
  return true;
}

function validateSafePathParent(
  root: string,
  current: string,
  stat: fs.Stats,
  label: string,
): void {
  const owned = typeof process.getuid !== 'function' || stat.uid === process.getuid();
  const safeMode = process.platform === 'win32' || (stat.mode & 0o022) === 0;
  if (stat.isSymbolicLink() || !stat.isDirectory() || !owned || !safeMode) {
    throw new Error(`unsafe ${label} parent component ${current}`);
  }
  if (process.platform === 'win32') {
    const authority = validateWindowsFileAuthority(current, 'directory', { anchorPath: root });
    if (!authority.ok) throw new Error(`unsafe ${label} parent authority: ${authority.reason}`);
  }
}

function assertSafePathParents(rootPath: string, filePath: string, label: string): void {
  if (!safePathParentsExist(rootPath, filePath, label)) {
    throw new Error(`${label} parent path is missing`);
  }
}

function inspectSafePathLeaf(
  rootPath: string,
  filePath: string,
  label: string,
): fs.Stats | undefined {
  return safePathParentsExist(rootPath, filePath, label)
    ? lstatOptional(filePath)
    : undefined;
}

function fsyncDirectoryFor(filePath: string, expected: Pick<fs.Stats, 'dev' | 'ino'>): void {
  fsyncDirectory(path.dirname(filePath), {
    expectedIdentity: {
      dev: BigInt(expected.dev),
      ino: BigInt(expected.ino),
    },
  });
}

function validateLegacyWindowsLauncher(home: string, filePath: string, label: string): void {
  const stat = fs.lstatSync(filePath);
  const owned = typeof process.getuid !== 'function' || stat.uid === process.getuid();
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || !owned) {
    throw new Error(`unsafe ${label}: expected a regular, singly-linked owned file at ${filePath}`);
  }
  if (process.platform === 'win32') {
    const authority = validateWindowsFileAuthority(filePath, 'file', { anchorPath: home });
    if (!authority.ok) throw new Error(`unsafe ${label} authority: ${authority.reason}`);
  }
}

function inspectLegacyWindowsLauncher(home: string, destinationDir: string): boolean {
  const { legacy, archived } = legacyWindowsLauncherPaths(home, destinationDir);
  const legacyStat = inspectSafePathLeaf(home, legacy, 'legacy Windows launcher');
  const archivedStat = inspectSafePathLeaf(home, archived, 'legacy Windows launcher archive');
  if (archivedStat) throw new Error(`legacy Windows launcher archive already exists at ${archived}`);
  if (!legacyStat) return false;
  validateLegacyWindowsLauncher(home, legacy, 'legacy Windows launcher');
  return true;
}

function archiveLegacyWindowsLauncher(home: string, destinationDir: string, expected: boolean): CommandResult {
  try {
    if (!expected) return { ok: true, stdout: '', stderr: '' };
    const { legacy, archived } = legacyWindowsLauncherPaths(home, destinationDir);
    const legacyStat = inspectSafePathLeaf(home, legacy, 'legacy Windows launcher');
    const archivedStat = inspectSafePathLeaf(home, archived, 'legacy Windows launcher archive');
    if (legacyStat) {
      if (!safePathParentsExist(home, archived, 'legacy Windows launcher archive')) {
        throw new Error('legacy Windows launcher archive parent path is missing');
      }
      validateLegacyWindowsLauncher(home, legacy, 'legacy Windows launcher');
      if (archivedStat) throw new Error(`legacy Windows launcher archive already exists at ${archived}`);
      const legacyParent = fs.lstatSync(path.dirname(legacy));
      const archivedParent = fs.lstatSync(path.dirname(archived));
      fs.renameSync(legacy, archived);
      fsyncDirectoryFor(legacy, legacyParent);
      fsyncDirectoryFor(archived, archivedParent);
      return { ok: true, stdout: '', stderr: '' };
    }
    if (!archivedStat) throw new Error('legacy Windows launcher disappeared during transaction');
    validateLegacyWindowsLauncher(home, archived, 'archived legacy Windows launcher');
    return { ok: true, stdout: '', stderr: '' };
  } catch (error) {
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
}

function restoreLegacyWindowsLauncher(home: string, destinationDir: string, expected: boolean): CommandResult {
  try {
    if (!expected) return verifyLegacyWindowsLauncherAbsent(home, destinationDir);
    const { legacy, archived } = legacyWindowsLauncherPaths(home, destinationDir);
    const legacyStat = inspectSafePathLeaf(home, legacy, 'legacy Windows launcher');
    const archivedStat = inspectSafePathLeaf(home, archived, 'archived legacy Windows launcher');
    if (legacyStat) {
      validateLegacyWindowsLauncher(home, legacy, 'legacy Windows launcher');
      if (archivedStat) throw new Error('both legacy Windows launcher paths exist during recovery');
      return { ok: true, stdout: '', stderr: '' };
    }
    if (!archivedStat) throw new Error('archived legacy Windows launcher is missing during recovery');
    assertSafePathParents(home, legacy, 'legacy Windows launcher');
    validateLegacyWindowsLauncher(home, archived, 'archived legacy Windows launcher');
    const archivedParent = fs.lstatSync(path.dirname(archived));
    const legacyParent = fs.lstatSync(path.dirname(legacy));
    fs.renameSync(archived, legacy);
    fsyncDirectoryFor(archived, archivedParent);
    fsyncDirectoryFor(legacy, legacyParent);
    return { ok: true, stdout: '', stderr: '' };
  } catch (error) {
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
}

function verifyLegacyWindowsLauncherAbsent(home: string, destinationDir: string): CommandResult {
  try {
    const { legacy, archived } = legacyWindowsLauncherPaths(home, destinationDir);
    const legacyStat = inspectSafePathLeaf(home, legacy, 'legacy Windows launcher');
    const archivedStat = inspectSafePathLeaf(home, archived, 'legacy Windows launcher archive');
    if (legacyStat) {
      return { ok: false, stdout: '', stderr: 'legacy Windows Startup launcher remains present' };
    }
    if (archivedStat) {
      validateLegacyWindowsLauncher(home, archived, 'archived legacy Windows launcher');
    }
    return { ok: true, stdout: '', stderr: '' };
  } catch (error) {
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
}

function validateWindowsRecoveryLauncherState(
  home: string,
  destinationDir: string,
  state: WindowsActivationState,
): CommandResult {
  try {
    const { legacy, archived } = legacyWindowsLauncherPaths(home, destinationDir);
    const legacyStat = inspectSafePathLeaf(home, legacy, 'legacy Windows launcher');
    const archivedStat = inspectSafePathLeaf(home, archived, 'archived legacy Windows launcher');
    if (!state.legacyLauncher) {
      if (legacyStat || archivedStat) {
        throw new Error('unexpected legacy Windows launcher exists during recovery');
      }
      return { ok: true, stdout: '', stderr: '' };
    }
    if (Boolean(legacyStat) === Boolean(archivedStat)) {
      throw new Error('recovery requires exactly one trusted legacy Windows launcher');
    }
    if (legacyStat) {
      validateLegacyWindowsLauncher(home, legacy, 'legacy Windows launcher');
    } else {
      validateLegacyWindowsLauncher(home, archived, 'archived legacy Windows launcher');
    }
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
  const legacy = restoreLegacyWindowsLauncher(home, path.dirname(def.filePath), state.legacyLauncher);
  if (!legacy.ok) return legacy;
  if (state.present) {
    try {
      const current = readWindowsTaskSnapshot(def.filePath);
      if (current.present) {
        const exactDefinition = verifyWindowsState(
          { ...state, state: current.state },
          def.filePath,
        );
        if (!exactDefinition.ok) return exactDefinition;
        const exactState = verifyWindowsState(state, def.filePath);
        if (exactState.ok) return exactState;
        if (
          (state.state === 'running' || state.state === 'queued') &&
          current.state === 'ready'
        ) {
          const started = runWindowsTask(def.filePath);
          if (!started.ok) return started;
        }
        return verifyWindowsState(state, def.filePath);
      }
    } catch (error) {
      return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
    }
  }
  const task = applyWindowsState(def, state);
  if (task.ok && legacy.ok) return task;
  return {
    ok: false,
    stdout: '',
    stderr: [task.ok ? '' : task.stderr, legacy.ok ? '' : legacy.stderr].filter(Boolean).join('; '),
  };
}

function recoverWindowsTransactionUnload(
  def: ServiceDefinition,
  prior: WindowsActivationState,
  desired: WindowsActivationState,
  phase: LaunchdInstallPhase,
): CommandResult {
  try {
    const current = readWindowsTaskSnapshot(def.filePath);
    if (!current.present) {
      if (prior.present && phase === 'prepared') {
        return { ok: false, stdout: '', stderr: 'prior Task Scheduler task disappeared before recovery stop' };
      }
      return { ok: true, stdout: '', stderr: '' };
    }

    if (prior.present) {
      const priorMatches = verifyWindowsState(
        { ...prior, state: current.state },
        def.filePath,
      );
      if (priorMatches.ok) return stopAndDeleteWindowsTask(prior, def.filePath);
    }

    if ((phase === 'activating' || phase === 'activated') && desired.present) {
      const desiredMatches = verifyWindowsState(
        { ...desired, state: current.state },
        def.filePath,
      );
      if (!desiredMatches.ok) return desiredMatches;
      return stopAndDeleteWindowsTask({
        present: true,
        state: current.state,
        legacyLauncher: false,
        taskXmlBase64: current.taskXmlBase64,
        taskXmlSha256: current.taskXmlSha256,
        taskSecurityDescriptorBase64: current.taskSecurityDescriptorBase64,
        taskSecurityDescriptorSha256: current.taskSecurityDescriptorSha256,
        taskSecurityScope: current.taskSecurityScope,
      }, def.filePath);
    }

    return {
      ok: false,
      stdout: '',
      stderr: `unexpected Task Scheduler task during install recovery phase ${phase}`,
    };
  } catch (error) {
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
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
      validateRecovery: (state) => parseLaunchdRecoveryState(state)
        ? { ok: true, stdout: '', stderr: '' }
        : { ok: false, stdout: '', stderr: 'invalid persisted launchd activation state' },
    });
  } else if (platform === 'linux') {
    const home = resolveHome(opts.homeDir);
    let priorActivation: SystemdActivationState | undefined;
    const desired = {
      present: true,
      active: autostart,
      enabled: autostart,
      fragmentPath: def.filePath,
    };
    installLaunchdPlistTransaction({
      plistPath: def.filePath,
      trustedRoot: home,
      content: def.content,
      lockDir: path.join(home, '.ashlr', 'locks'),
      operationLabel: 'systemd',
      preflight: ({ hasPrior }) => {
        try {
          const state = readSystemdActivationState();
          if (state.present !== hasPrior) {
            return {
              ok: false,
              stdout: '',
              stderr: 'systemd manager and trusted service-file presence disagree',
            };
          }
          if (state.present && state.fragmentPath !== def.filePath) {
            return {
              ok: false,
              stdout: '',
              stderr: 'systemd FragmentPath does not match the trusted service file',
            };
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
          return verifySystemdState({
            present: true,
            active: false,
            enabled: false,
            fragmentPath: current.fragmentPath,
          });
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
      validateRecovery: (state) => parseSystemdRecoveryState(state)
        ? { ok: true, stdout: '', stderr: '' }
        : { ok: false, stdout: '', stderr: 'invalid persisted systemd activation state' },
    });
  } else if (platform === 'win32') {
    const home = resolveHome(opts.homeDir);
    let priorActivation: WindowsActivationState | undefined;
    let persistedRecoveryActivation: WindowsActivationState | undefined;
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
          const task = readWindowsTaskSnapshot(def.filePath);
          if (task.present && !hasPrior) {
            return { ok: false, stdout: '', stderr: 'refusing to replace registered AshlrDaemon task without a trusted prior launcher' };
          }
          priorActivation = task.present
            ? {
                present: true,
                state: task.state,
                legacyLauncher: inspectLegacyWindowsLauncher(home, path.dirname(def.filePath)),
                taskXmlBase64: task.taskXmlBase64,
                taskXmlSha256: task.taskXmlSha256,
                taskSecurityDescriptorBase64: task.taskSecurityDescriptorBase64,
                taskSecurityDescriptorSha256: task.taskSecurityDescriptorSha256,
                taskSecurityScope: task.taskSecurityScope,
              }
            : {
                present: false,
                legacyLauncher: inspectLegacyWindowsLauncher(home, path.dirname(def.filePath)),
              };
          return { ok: true, stdout: '', stderr: '', recoveryState: priorActivation };
        } catch (error) {
          return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
        }
      },
      unload: () => {
        const activation = priorActivation ?? persistedRecoveryActivation;
        if (!activation) {
          return { ok: false, stdout: '', stderr: 'Windows activation authority is unavailable' };
        }
        const authority = validateWindowsRecoveryLauncherState(
          home,
          path.dirname(def.filePath),
          activation,
        );
        if (!authority.ok) return authority;
        const archived = archiveLegacyWindowsLauncher(
          home,
          path.dirname(def.filePath),
          activation.legacyLauncher,
        );
        if (!archived.ok) return archived;
        return stopAndDeleteWindowsTask(activation, def.filePath);
      },
      recoverUnload: (state, phase) => {
        const activation = parseWindowsRecoveryState(state);
        return activation
          ? recoverWindowsTransactionUnload(def, activation, desired, phase)
          : { ok: false, stdout: '', stderr: 'invalid persisted Windows activation state' };
      },
      load: () => autostart
        ? applyWindowsState(def, desired)
        : verifyWindowsState(desired, def.filePath),
      verify: () => {
        const task = verifyWindowsState(desired, def.filePath);
        if (!task.ok) return task;
        return verifyLegacyWindowsLauncherAbsent(home, path.dirname(def.filePath));
      },
      rollback: () => priorActivation
        ? restoreWindowsState(def, home, priorActivation)
        : { ok: false, stdout: '', stderr: 'Windows activation preflight state is unavailable' },
      recover: (state) => {
        const activation = parseWindowsRecoveryState(state);
        return activation
          ? restoreWindowsState(def, home, activation)
          : { ok: false, stdout: '', stderr: 'invalid persisted Windows activation state' };
      },
      validateRecovery: (state) => {
        const activation = parseWindowsRecoveryState(state);
        if (!activation) {
          return { ok: false, stdout: '', stderr: 'invalid persisted Windows activation state' };
        }
        const authority = validateWindowsRecoveryLauncherState(
          home,
          path.dirname(def.filePath),
          activation,
        );
        if (!authority.ok) return authority;
        persistedRecoveryActivation = activation;
        return { ok: true, stdout: '', stderr: '' };
      },
    });
  }
  clearServiceStatusCache();
}

/**
 * Unload and remove the OS service registration.
 * Fails closed when the manager and service file cannot be removed together.
 */
export async function uninstall(opts: ServiceInstallOptions = {}): Promise<void> {
  const platform = (opts.platform ?? process.platform) as Platform;
  const def = generateServiceDefinition(opts);

  try {
  if (platform === 'darwin') {
    const home = resolveHome(opts.homeDir);
    const uid = typeof process.getuid === 'function' ? process.getuid() : os.userInfo().uid;
    const domainTarget = `gui/${uid}`;
    const label = 'ai.ashlr.daemon';
    const serviceTarget = `${domainTarget}/${label}`;
    let priorActivation: { loaded: boolean; disabled: boolean } | undefined;
    removeLaunchdPlistTransaction({
      plistPath: def.filePath,
      trustedRoot: home,
      lockDir: path.join(home, '.ashlr', 'locks'),
      preflight: ({ hasPrior }) => {
        try {
          const runtime = readLaunchdRuntimeState(serviceTarget);
          if (runtime.loaded && !hasPrior) {
            return {
              ok: false,
              stdout: '',
              stderr: `refusing to remove loaded ${serviceTarget} without a trusted prior plist`,
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
      validateRecovery: (state) => parseLaunchdRecoveryState(state)
        ? { ok: true, stdout: '', stderr: '' }
        : { ok: false, stdout: '', stderr: 'invalid persisted launchd activation state' },
      recoverAfterFailedRemove: () => priorActivation
        ? restoreLaunchdActivation(
            domainTarget,
            serviceTarget,
            label,
            def.filePath,
            priorActivation.loaded,
            priorActivation.disabled,
          )
        : { ok: false, stdout: '', stderr: 'launchd pre-uninstall activation state is unavailable' },
    });
  } else if (platform === 'linux') {
    const home = resolveHome(opts.homeDir);
    let priorActivation: SystemdActivationState | undefined;
    removeLaunchdPlistTransaction({
      plistPath: def.filePath,
      trustedRoot: home,
      lockDir: path.join(home, '.ashlr', 'locks'),
      operationLabel: 'systemd',
      preflight: ({ hasPrior }) => {
        try {
          const state = readSystemdActivationState();
          if (state.present !== hasPrior) {
            return {
              ok: false,
              stdout: '',
              stderr: 'systemd manager and trusted service-file presence disagree',
            };
          }
          if (state.present && state.fragmentPath !== def.filePath) {
            return {
              ok: false,
              stdout: '',
              stderr: 'systemd FragmentPath does not match the trusted service file',
            };
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
          if (!current.present) {
            return fs.existsSync(def.filePath)
              ? { ok: false, stdout: '', stderr: 'systemd manager does not own the trusted service file' }
              : { ok: true, stdout: '', stderr: '' };
          }
          if (current.fragmentPath !== def.filePath) {
            return { ok: false, stdout: '', stderr: 'systemd FragmentPath does not match the trusted service file' };
          }
          const disabled = runCmd(def.unregisterArgs);
          if (!disabled.ok) return disabled;
          return verifySystemdState({
            present: true,
            active: false,
            enabled: false,
            fragmentPath: def.filePath,
          });
        } catch (error) {
          return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
        }
      },
      afterRemove: () => {
        const reloaded = runCmd(['systemctl', '--user', 'daemon-reload']);
        return reloaded.ok
          ? verifySystemdState({ present: false, active: false, enabled: false })
          : reloaded;
      },
      recover: (state) => {
        const activation = parseSystemdRecoveryState(state);
        return activation
          ? applySystemdState(activation)
          : { ok: false, stdout: '', stderr: 'invalid persisted systemd activation state' };
      },
      validateRecovery: (state) => parseSystemdRecoveryState(state)
        ? { ok: true, stdout: '', stderr: '' }
        : { ok: false, stdout: '', stderr: 'invalid persisted systemd activation state' },
      recoverAfterFailedRemove: () => priorActivation
        ? applySystemdState(priorActivation)
        : {
            ok: false,
            stdout: '',
            stderr: 'systemd pre-uninstall activation state is unavailable',
          },
    });
  } else if (platform === 'win32') {
    const home = resolveHome(opts.homeDir);
    let priorActivation: WindowsActivationState | undefined;
    let persistedRecoveryActivation: WindowsActivationState | undefined;
    removeLaunchdPlistTransaction({
      plistPath: def.filePath,
      trustedRoot: home,
      lockDir: path.join(home, '.ashlr', 'locks'),
      operationLabel: 'Task Scheduler',
      preflight: ({ hasPrior }) => {
        try {
          const task = readWindowsTaskSnapshot(def.filePath);
          if (task.present !== hasPrior) {
            return {
              ok: false,
              stdout: '',
              stderr: 'Task Scheduler manager and trusted launcher presence disagree',
            };
          }
          priorActivation = task.present
            ? {
                present: true,
                state: task.state,
                legacyLauncher: inspectLegacyWindowsLauncher(home, path.dirname(def.filePath)),
                taskXmlBase64: task.taskXmlBase64,
                taskXmlSha256: task.taskXmlSha256,
                taskSecurityDescriptorBase64: task.taskSecurityDescriptorBase64,
                taskSecurityDescriptorSha256: task.taskSecurityDescriptorSha256,
                taskSecurityScope: task.taskSecurityScope,
              }
            : {
                present: false,
                legacyLauncher: inspectLegacyWindowsLauncher(home, path.dirname(def.filePath)),
              };
          return { ok: true, stdout: '', stderr: '', recoveryState: priorActivation };
        } catch (error) {
          return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
        }
      },
      unload: () => {
        const activation = priorActivation ?? persistedRecoveryActivation;
        if (!activation) {
          return { ok: false, stdout: '', stderr: 'Windows activation authority is unavailable' };
        }
        const authority = validateWindowsRecoveryLauncherState(
          home,
          path.dirname(def.filePath),
          activation,
        );
        if (!authority.ok) return authority;
        const archived = archiveLegacyWindowsLauncher(
          home,
          path.dirname(def.filePath),
          activation.legacyLauncher,
        );
        if (!archived.ok) return archived;
        return stopAndDeleteWindowsTask(activation, def.filePath);
      },
      recoverUnload: (state, phase) => {
        const activation = parseWindowsRecoveryState(state);
        return activation
          ? recoverWindowsTransactionUnload(
              def,
              activation,
              { present: false, legacyLauncher: false },
              phase,
            )
          : { ok: false, stdout: '', stderr: 'invalid persisted Windows activation state' };
      },
      afterRemove: () => {
        const task = verifyWindowsState(
          { present: false, legacyLauncher: false },
          def.filePath,
        );
        if (!task.ok) return task;
        return verifyLegacyWindowsLauncherAbsent(home, path.dirname(def.filePath));
      },
      recover: (state) => {
        const activation = parseWindowsRecoveryState(state);
        return activation
          ? restoreWindowsState(def, home, activation)
          : { ok: false, stdout: '', stderr: 'invalid persisted Windows activation state' };
      },
      validateRecovery: (state) => {
        const activation = parseWindowsRecoveryState(state);
        if (!activation) {
          return { ok: false, stdout: '', stderr: 'invalid persisted Windows activation state' };
        }
        const authority = validateWindowsRecoveryLauncherState(
          home,
          path.dirname(def.filePath),
          activation,
        );
        if (!authority.ok) return authority;
        persistedRecoveryActivation = activation;
        return { ok: true, stdout: '', stderr: '' };
      },
      recoverAfterFailedRemove: () => priorActivation
        ? restoreWindowsState(def, home, priorActivation)
        : { ok: false, stdout: '', stderr: 'Windows pre-uninstall activation state is unavailable' },
    });
  }
  } finally {
    clearServiceStatusCache();
  }
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
  if (platform === 'darwin' && before.runtimeState !== 'ready') return before;
  const home = resolveHome(opts.homeDir);
  const def = generateServiceDefinition(opts);
  return withServiceFileTransactionLock({
    filePath: def.filePath,
    trustedRoot: home,
    lockDir: path.join(home, '.ashlr', 'locks'),
  }, () => {
    const locked = serviceStatus(opts);
    if (!locked.installed || locked.running) return locked;
    if (platform === 'win32' && locked.runtimeState !== 'ready') return locked;
    if (platform === 'darwin' && locked.runtimeState !== 'ready') return locked;
    if (platform === 'darwin') {
      const uid = typeof process.getuid === 'function' ? process.getuid() : os.userInfo().uid;
      const started = runCmd(['launchctl', 'kickstart', `gui/${uid}/ai.ashlr.daemon`]);
      if (!started.ok || started.stderr.trim() !== '') return locked;
    } else if (platform === 'linux') {
      try {
        const state = readSystemdActivationState();
        if (!state.present || state.fragmentPath !== def.filePath || state.active) return locked;
      } catch {
        return locked;
      }
      runCmd(['systemctl', '--user', 'start', 'ashlr-daemon']);
    } else if (platform === 'win32') {
      try {
        assertSafePathParents(home, def.filePath, 'Windows service launcher');
        validateLegacyWindowsLauncher(home, def.filePath, 'Windows service launcher');
        const started = runWindowsTask(def.filePath);
        if (!started.ok) return locked;
      } catch {
        return locked;
      }
    }

    clearServiceStatusCache();
    return serviceStatus(opts);
  });
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
    return queryLaunchd(def, installed);
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

function queryLaunchd(definition: ServiceDefinition, installed: boolean): ServiceStatusResult {
  const filePath = definition.filePath;
  const uid = typeof process.getuid === 'function' ? process.getuid() : os.userInfo().uid;
  const serviceTarget = `gui/${uid}/ai.ashlr.daemon`;
  try {
    if (!definition.launchdRuntime) throw new Error('launchd runtime contract is unavailable');
    const runtime = readLaunchdRuntimeState(serviceTarget, {
      expectedPath: filePath,
      expectedProgram: definition.launchdRuntime.program,
      expectedArguments: definition.launchdRuntime.arguments,
      timeoutMs: 5_000,
    });
    return {
      installed,
      running: runtime.pid !== undefined,
      runtimeState: runtime.pid !== undefined
        ? 'running'
        : runtime.loaded
          ? 'ready'
          : 'stopped',
      platformSpec: 'launchd',
      serviceFilePath: filePath,
    };
  } catch {
    return {
      installed,
      running: false,
      runtimeState: 'unknown',
      platformSpec: 'launchd',
      serviceFilePath: filePath,
    };
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
    return {
      installed,
      running: false,
      runtimeState: task.state,
      platformSpec: 'schtasks',
      serviceFilePath: filePath,
    };
  } catch {
    return { installed, running: false, runtimeState: 'unknown', platformSpec: 'schtasks', serviceFilePath: filePath };
  }
}

// ---------------------------------------------------------------------------
// Re-export execFileSync for test stubbing surface (lets tests vi.mock this module)
// ---------------------------------------------------------------------------
export { execFileSync };
