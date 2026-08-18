/**
 * `ashlr dashboard` — M211 fleet dashboard status and existing-service client.
 *
 * Opens an already-running ai.ashlr.serve LaunchAgent. Resident installation,
 * repair, and restart are withheld in this release; foreground serving remains
 * available through `ashlr serve --open`.
 *
 * Subcommands / flags:
 *   ashlr dashboard              # open an existing service
 *   ashlr dashboard --stop       # unload the LaunchAgent
 *   ashlr dashboard --status     # print service state (json with --json)
 *
 * Plist details:
 *   Label:       ai.ashlr.serve
 *   Port:        4317 (STABLE; avoids conflict with daemon on 7777)
 *   RunAtLoad:   true
 *   KeepAlive:   { SuccessfulExit: false }
 *   ProgramArgs: [node, bin/ashlr, serve, --port, 4317]
 *   Logs:        ~/.ashlr/serve.launchd.{out,err}.log
 *
 * The dormant installer retains its transactional implementation for a future
 * release that explicitly restores resident authority.
 *
 * Non-macOS: the plist installation step is skipped with a warning; the
 * command falls back to starting serve in the foreground (same as `ashlr serve
 * --open`).
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { makeColors, isTty } from './ui.js';
import {
  installLaunchdPlistTransaction,
  removeLaunchdPlistTransaction,
} from '../core/daemon/launchd-plist-transaction.js';
import { assertResidentServiceInstallAuthorized } from '../core/daemon/service-install-authority.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SERVE_PORT = 4317;
const PLIST_LABEL = 'ai.ashlr.serve';
const PLIST_FILENAME = 'ai.ashlr.serve.plist';

// ---------------------------------------------------------------------------
// Path helpers (exported for test injection)
// ---------------------------------------------------------------------------

export function plistPath(homeDir?: string): string {
  const home = homeDir ?? os.homedir();
  return path.join(home, 'Library', 'LaunchAgents', PLIST_FILENAME);
}

export function outLogPath(homeDir?: string): string {
  const home = homeDir ?? os.homedir();
  return path.join(home, '.ashlr', 'serve.launchd.out.log');
}

export function errLogPath(homeDir?: string): string {
  const home = homeDir ?? os.homedir();
  return path.join(home, '.ashlr', 'serve.launchd.err.log');
}

/**
 * Resolve the absolute path to `bin/ashlr` relative to this file.
 * Works from src/ (tsx / ts-node) and dist/ (compiled).
 */
export function resolveBinPath(): string {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
  return path.join(repoRoot, 'bin', 'ashlr');
}

// ---------------------------------------------------------------------------
// Plist generation (pure — no side effects)
// ---------------------------------------------------------------------------

export function generateServePlist(opts: {
  nodePath?: string;
  binPath?: string;
  homeDir?: string;
  port?: number;
}): string {
  const nodePath = opts.nodePath ?? process.execPath;
  const binPath = opts.binPath ?? resolveBinPath();
  const home = opts.homeDir ?? os.homedir();
  const port = opts.port ?? SERVE_PORT;

  const outLog = outLogPath(home);
  const errLog = errLogPath(home);

  // Build a minimal PATH that avoids the Desktop EPERM class. We deliberately
  // do NOT inherit a shell's PATH (which would require launching a shell) but
  // instead enumerate well-known locations. Using node directly in
  // ProgramArguments avoids the need for a shell entirely.
  const pathEnv = [
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${PLIST_LABEL}</string>
\t<key>ProcessType</key>
\t<string>Interactive</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${nodePath}</string>
\t\t<string>${binPath}</string>
\t\t<string>serve</string>
\t\t<string>--port</string>
\t\t<string>${port}</string>
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>HOME</key>
\t\t<string>${home}</string>
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
\t<integer>5</integer>
\t<key>StandardOutPath</key>
\t<string>${outLog}</string>
\t<key>StandardErrorPath</key>
\t<string>${errLog}</string>
</dict>
</plist>
`;
}

// ---------------------------------------------------------------------------
// launchctl helpers (side-effectful; mocked in tests via spawnSync injection)
// ---------------------------------------------------------------------------

export interface RunResult {
  ok: boolean;
  stderr: string;
  stdout: string;
}

/**
 * Thin wrapper around spawnSync — exported so tests can override it via
 * vi.spyOn(dashboard, 'runCmd').
 */
export function runCmd(args: string[]): RunResult {
  const [cmd, ...rest] = args;
  if (!cmd) return { ok: false, stderr: 'empty command', stdout: '' };
  try {
    const r = spawnSync(cmd, rest, { encoding: 'utf8', timeout: 15_000 });
    return {
      ok: r.status === 0 && !r.error,
      stderr: r.stderr ?? r.error?.message ?? '',
      stdout: r.stdout ?? '',
    };
  } catch (e) {
    return { ok: false, stderr: e instanceof Error ? e.message : String(e), stdout: '' };
  }
}

function launchdServiceAbsent(result: RunResult): boolean {
  return !result.ok &&
    /(?:could not find (?:specified )?service|service .* not found|no such process|not loaded)/i
      .test(`${result.stdout}\n${result.stderr}`);
}

function restoreServeActivation(
  exec: typeof runCmd,
  pp: string,
  loaded: boolean,
): RunResult {
  const before = exec(['launchctl', 'list', PLIST_LABEL]);
  const beforeLoaded = before.ok;
  if (!before.ok && !launchdServiceAbsent(before)) return before;
  if (beforeLoaded === loaded) return { ok: true, stdout: '', stderr: '' };

  const result = exec(['launchctl', loaded ? 'load' : 'unload', pp]);
  const commandResult = loaded
    ? { ...result, ok: result.ok && !/^Load failed:/im.test(result.stderr) }
    : launchdServiceAbsent(result)
      ? { ok: true, stdout: '', stderr: '' }
      : { ...result, ok: result.ok && !/^Unload failed:/im.test(result.stderr) };
  if (!commandResult.ok) return commandResult;

  const after = exec(['launchctl', 'list', PLIST_LABEL]);
  const afterLoaded = after.ok;
  if (!after.ok && !launchdServiceAbsent(after)) return after;
  if (afterLoaded !== loaded) {
    return {
      ok: false,
      stdout: after.stdout,
      stderr: `launchctl did not reach expected ${loaded ? 'loaded' : 'unloaded'} state`,
    };
  }
  return { ok: true, stdout: after.stdout, stderr: '' };
}

/**
 * Open URL in the default browser — detached so the CLI doesn't wait.
 * Exported for mocking in tests.
 */
export async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  const child = spawn(cmd, [url], {
    detached: true,
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  child.unref();
}

// ---------------------------------------------------------------------------
// Service status query
// ---------------------------------------------------------------------------

export interface ServeServiceStatus {
  registrationState: 'present' | 'absent' | 'unknown';
  installed: boolean;
  running: boolean;
  plistPath: string;
}

export function queryServeService(homeDir?: string): ServeServiceStatus {
  const pp = plistPath(homeDir);
  const installed = fs.existsSync(pp);

  if (process.platform !== 'darwin') {
    return {
      registrationState: installed ? 'present' : 'absent',
      installed,
      running: false,
      plistPath: pp,
    };
  }

  try {
    const r = spawnSync('launchctl', ['list', PLIST_LABEL], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    // launchctl list returns 0 and prints the job dict when it is loaded.
    // The PID key is > 0 when the process is actually running.
    const loaded = r.status === 0 && !!r.stdout;
    if (!loaded && !launchdServiceAbsent({
      ok: false,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? r.error?.message ?? '',
    })) {
      return { registrationState: 'unknown', installed: false, running: false, plistPath: pp };
    }
    const running = loaded && !r.stdout.includes('"PID" = 0') && !r.stdout.includes('"PID" = -1');
    const registrationState = installed || loaded ? 'present' : 'absent';
    return { registrationState, installed: registrationState === 'present', running, plistPath: pp };
  } catch {
    return { registrationState: 'unknown', installed: false, running: false, plistPath: pp };
  }
}

// ---------------------------------------------------------------------------
// Install / unload
// ---------------------------------------------------------------------------

/**
 * Write the plist to ~/Library/LaunchAgents/ and load it via launchctl.
 * Idempotent: atomically replaces the plist, unloads first (ignore errors),
 * then loads. If loading fails, restores and reloads the prior plist.
 *
 * @throws on write failure or launchctl load failure.
 */
export function installServeAgent(opts: {
  nodePath?: string;
  binPath?: string;
  homeDir?: string;
  port?: number;
  /** Override runCmd for testing */
  _runCmd?: typeof runCmd;
}): void {
  assertResidentServiceInstallAuthorized();
  const exec = opts._runCmd ?? runCmd;
  const home = opts.homeDir ?? os.homedir();
  const pp = plistPath(home);

  // Ensure log dir exists
  const logDir = path.join(home, '.ashlr');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const content = generateServePlist(opts);
  let priorLoaded: boolean | undefined;
  installLaunchdPlistTransaction({
    plistPath: pp,
    trustedRoot: home,
    content,
    lockDir: path.join(home, '.ashlr', 'locks'),
    preflight: ({ hasPrior }) => {
      const listed = exec(['launchctl', 'list', PLIST_LABEL]);
      if (!listed.ok && !launchdServiceAbsent(listed)) return listed;
      priorLoaded = listed.ok;
      if (priorLoaded && !hasPrior) {
        return {
          ok: false,
          stdout: '',
          stderr: 'refusing to replace loaded serve agent without a trusted prior plist',
        };
      }
      return {
        ok: true,
        stdout: '',
        stderr: '',
        recoveryState: { loaded: priorLoaded },
      };
    },
    unload: () => restoreServeActivation(exec, pp, false),
    load: () => restoreServeActivation(exec, pp, true),
    verify: () => restoreServeActivation(exec, pp, true),
    rollback: () => priorLoaded === undefined
      ? { ok: false, stdout: '', stderr: 'serve activation preflight state is unavailable' }
      : restoreServeActivation(exec, pp, priorLoaded),
    recoverUnload: () => restoreServeActivation(exec, pp, false),
    recover: (state) => {
      if (
        !state ||
        typeof state !== 'object' ||
        Array.isArray(state) ||
        typeof (state as { loaded?: unknown }).loaded !== 'boolean' ||
        Object.keys(state).some((key) => key !== 'loaded')
      ) {
        return { ok: false, stdout: '', stderr: 'invalid persisted serve activation state' };
      }
      return restoreServeActivation(exec, pp, (state as { loaded: boolean }).loaded);
    },
    validateRecovery: (state) => (
      state &&
      typeof state === 'object' &&
      !Array.isArray(state) &&
      typeof (state as { loaded?: unknown }).loaded === 'boolean' &&
      Object.keys(state).every((key) => key === 'loaded')
    )
      ? { ok: true, stdout: '', stderr: '' }
      : { ok: false, stdout: '', stderr: 'invalid persisted serve activation state' },
  });
}

export function servePlistNeedsUpgrade(opts: {
  nodePath?: string;
  binPath?: string;
  homeDir?: string;
  port?: number;
}): boolean {
  const pp = plistPath(opts.homeDir);
  try {
    return fs.readFileSync(pp, 'utf8') !== generateServePlist(opts);
  } catch {
    return true;
  }
}

/**
 * Unload and remove the serve LaunchAgent.
 */
export function uninstallServeAgent(opts: {
  homeDir?: string;
  _runCmd?: typeof runCmd;
}): void {
  const exec = opts._runCmd ?? runCmd;
  const home = opts.homeDir ?? os.homedir();
  const pp = plistPath(opts.homeDir);
  let priorLoaded: boolean | undefined;
  removeLaunchdPlistTransaction({
    plistPath: pp,
    trustedRoot: home,
    lockDir: path.join(home, '.ashlr', 'locks'),
    preflight: ({ hasPrior }) => {
      const listed = exec(['launchctl', 'list', PLIST_LABEL]);
      if (!listed.ok && !launchdServiceAbsent(listed)) return listed;
      priorLoaded = listed.ok;
      if (priorLoaded && !hasPrior) {
        return {
          ok: false,
          stdout: '',
          stderr: 'refusing to remove loaded serve agent without a trusted prior plist',
        };
      }
      return {
        ok: true,
        stdout: '',
        stderr: '',
        recoveryState: { loaded: priorLoaded },
      };
    },
    unload: () => restoreServeActivation(exec, pp, false),
    afterRemove: () => restoreServeActivation(exec, pp, false),
    load: () => restoreServeActivation(exec, pp, true),
    recover: (state) => {
      if (
        !state ||
        typeof state !== 'object' ||
        Array.isArray(state) ||
        typeof (state as { loaded?: unknown }).loaded !== 'boolean' ||
        Object.keys(state).some((key) => key !== 'loaded')
      ) {
        return { ok: false, stdout: '', stderr: 'invalid persisted serve activation state' };
      }
      return restoreServeActivation(exec, pp, (state as { loaded: boolean }).loaded);
    },
    validateRecovery: (state) => (
      state &&
      typeof state === 'object' &&
      !Array.isArray(state) &&
      typeof (state as { loaded?: unknown }).loaded === 'boolean' &&
      Object.keys(state).every((key) => key === 'loaded')
    )
      ? { ok: true, stdout: '', stderr: '' }
      : { ok: false, stdout: '', stderr: 'invalid persisted serve activation state' },
    recoverAfterFailedRemove: () => priorLoaded === undefined
      ? { ok: false, stdout: '', stderr: 'serve activation preflight state is unavailable' }
      : restoreServeActivation(exec, pp, priorLoaded),
  });
}

// ---------------------------------------------------------------------------
// Ensure-running helper (idempotent install + start)
// ---------------------------------------------------------------------------

/**
 * Ensure the serve LaunchAgent is installed and running.
 * Returns the URL to open.
 */
async function ensureRunning(opts: {
  homeDir?: string;
  _runCmd?: typeof runCmd;
  _queryServeService?: typeof queryServeService;
}): Promise<{ url: string; installed: boolean }> {
  const home = opts.homeDir ?? os.homedir();
  const url = `http://127.0.0.1:${SERVE_PORT}`;
  const status = (opts._queryServeService ?? queryServeService)(home);
  const needsUpgrade = servePlistNeedsUpgrade({ homeDir: home });

  if (!status.installed || !status.running || needsUpgrade) {
    // Install (or re-install) and load
    installServeAgent({
      homeDir: home,
      _runCmd: opts._runCmd,
    });
    return { url, installed: true };
  }

  return { url, installed: false };
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function cmdDashboardOpen(
  args: string[],
  deps: {
    _runCmd?: typeof runCmd;
    _openBrowser?: typeof openBrowser;
    _queryServeService?: typeof queryServeService;
  },
): Promise<number> {
  const col = makeColors(isTty());
  const openBrowserFn = deps._openBrowser ?? openBrowser;

  let json = false;
  for (const a of args) {
    if (a === '--json') { json = true; }
    else if (a === '--help' || a === '-h') { printUsage(); return 0; }
    else if (a.startsWith('-') && a !== '--stop' && a !== '--status') {
      console.error(col.red('error: ') + `Unknown flag: ${a}`);
      return 2;
    }
  }

  if (process.platform !== 'darwin') {
    if (!json) {
      console.log(col.dim('  Note: launchd persistence is macOS-only. Starting serve in foreground.'));
    }
    // Fall back to cmdServe --open for non-macOS
    try {
      const { cmdServe } = await import('./serve.js') as { cmdServe: (a: string[]) => Promise<number> };
      return cmdServe(['--port', String(SERVE_PORT), '--open']);
    } catch (e) {
      console.error(col.red('error: ') + String(e));
      return 1;
    }
  }

  let url: string;
  try {
    const result = await ensureRunning({
      _runCmd: deps._runCmd,
      _queryServeService: deps._queryServeService,
    });
    url = result.url;
    if (!json && result.installed) {
      console.log('');
      console.log(col.green('  ✓ ') + col.bold('ai.ashlr.serve') + col.dim(' installed and loaded'));
      console.log(col.dim('    Survives reboot. Stop with `ashlr dashboard --stop`.'));
    }
  } catch (err) {
    console.error(
      col.red('error: ')
      + `Persistent dashboard unavailable: ${String(err)}. Use \`ashlr serve --open\` in the foreground.`,
    );
    return 1;
  }
  const consoleUrl = `${url.replace(/\/$/, '')}/next/`;

  if (json) {
    console.log(JSON.stringify({ url, consoleUrl, port: SERVE_PORT, label: PLIST_LABEL }));
  } else {
    console.log('');
    console.log(col.bold('  ashlr dashboard') + col.dim(' — fleet web dashboard'));
    console.log('');
    console.log(`  ${col.green('✓')} ${col.cyan(consoleUrl)}`);
    console.log(`  ${col.dim('Opening in your browser…')}`);
    console.log('');
  }

  try {
    await openBrowserFn(consoleUrl);
  } catch {
    if (!json) {
      console.error(col.dim(`  Could not open browser automatically. Navigate to ${consoleUrl}`));
    }
  }

  return 0;
}

async function cmdDashboardStop(opts: { _runCmd?: typeof runCmd }): Promise<number> {
  const col = makeColors(isTty());

  if (process.platform !== 'darwin') {
    console.error(col.dim('  Note: launchd is macOS-only. Stop the serve process manually.'));
    return 0;
  }

  try {
    uninstallServeAgent({ _runCmd: opts._runCmd });
  } catch (e) {
    console.error(col.red('error: ') + String(e));
    return 1;
  }

  console.log('');
  console.log(col.green('  ✓ ') + col.bold('ai.ashlr.serve') + col.dim(' unloaded and removed'));
  console.log('');
  return 0;
}

function cmdDashboardStatus(args: string[]): number {
  const col = makeColors(isTty());
  const json = args.includes('--json');

  const status = queryServeService();
  const url = `http://127.0.0.1:${SERVE_PORT}`;

  if (json) {
    console.log(JSON.stringify({
      installed: status.installed,
      registrationState: status.registrationState,
      running: status.running,
      plistPath: status.plistPath,
      url,
      port: SERVE_PORT,
      label: PLIST_LABEL,
    }, null, 2));
    return 0;
  }

  console.log('');
  console.log(col.bold('  ashlr dashboard status'));
  console.log('');
  console.log('  ' + col.bold('installed:  ') + (status.installed ? col.green('yes') : col.dim('no')));
  console.log('  ' + col.bold('registered: ') + col.dim(status.registrationState));
  console.log('  ' + col.bold('running:    ') + (status.running ? col.green('yes') : col.dim('no')));
  console.log('  ' + col.bold('url:        ') + col.dim(url));
  console.log('  ' + col.bold('plist:      ') + col.dim(status.plistPath));
  console.log('');

  if (!status.installed) {
    console.log(col.dim('  Resident install is unavailable; run `ashlr serve --open` in the foreground.'));
    console.log('');
  } else if (!status.running) {
    console.log(col.dim('  Installed but not running. Restart authority is unavailable; status and stop remain available.'));
    console.log('');
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * `ashlr dashboard [--stop | --status] [--json]`
 *
 * @param args    Raw CLI args after "dashboard"
 * @param _deps   Injected dependencies (for testing — launchctl + browser mocks)
 */
export async function cmdDashboard(
  args: string[],
  _deps: {
    _runCmd?: typeof runCmd;
    _openBrowser?: typeof openBrowser;
    _queryServeService?: typeof queryServeService;
  } = {},
): Promise<number> {
  const col = makeColors(isTty());

  if (args.includes('--stop')) {
    return cmdDashboardStop({ _runCmd: _deps._runCmd });
  }

  if (args.includes('--status')) {
    return cmdDashboardStatus(args);
  }

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return 0;
  }

  // Unknown flags
  for (const a of args) {
    if (a.startsWith('-') && !['--json'].includes(a)) {
      console.error(col.red('error: ') + `Unknown flag: ${a}`);
      console.error(col.dim('Run `ashlr dashboard --help` for usage.'));
      return 2;
    }
  }

  return cmdDashboardOpen(args, _deps);
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  const col = makeColors(isTty());
  console.log('');
  console.log(col.bold('  ashlr dashboard') + col.dim(' [--stop | --status | --json]'));
  console.log('');
  console.log('  Open an existing fleet dashboard service in your default browser.');
  console.log('  Resident install/restart is unavailable; use `ashlr serve --open` for a new session.');
  console.log('');
  console.log('  ' + col.bold('Subcommands / flags:'));
  console.log(`    ${col.cyan('(none)')}            Open an existing service`);
  console.log(`    ${col.cyan('--stop')}            Unload and remove the LaunchAgent`);
  console.log(`    ${col.cyan('--status')}          Print service state`);
  console.log(`    ${col.cyan('--json')}            Machine-readable output`);
  console.log('');
  console.log('  ' + col.bold('Persistence:'));
  console.log(col.dim('    macOS LaunchAgent: ~/Library/LaunchAgents/ai.ashlr.serve.plist'));
  console.log(col.dim('    Label: ai.ashlr.serve  ·  Port: 4317  ·  RunAtLoad: true  ·  KeepAlive: true'));
  console.log(col.dim('    Logs:  ~/.ashlr/serve.launchd.{out,err}.log'));
  console.log('');
  console.log('  ' + col.bold('Menu-bar glance (SwiftBar/xbar):'));
  console.log(col.dim('    Install: copy scripts/ashlr-menubar.1m.sh to your SwiftBar plugin dir.'));
  console.log(col.dim('    Displays fleet status + frontier usage in the macOS menu bar.'));
  console.log('');
}
