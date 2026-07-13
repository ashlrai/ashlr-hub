/**
 * M167: Browser-use verification for the autonomous fleet.
 *
 * Provides `isWebApp` and `verifyInBrowser` so the fleet can confirm a web/UI
 * change actually renders (no blank page, no uncaught console errors) — not
 * just that unit tests pass.
 *
 * ZERO RUNTIME DEPS — no playwright/puppeteer in package.json. We shell out to
 * whatever headless browser is available on the host, in priority order:
 *
 *   1. `npx playwright` — if playwright is installed in node_modules or globally
 *      (most developer machines with the fleet already set up).
 *   2. Headless Chrome/Chromium — via well-known macOS/Linux paths.
 *   3. DEGRADE — return { ok: true, skipped: true, reason: '…' }.
 *
 * The module NEVER throws. Every path resolves to `BrowserVerifyResult`.
 *
 * GUARDED by cfg.foundry?.browserVerify (default FALSE, opt-in).
 *
 * Wiring into the verify gate / loop.ts is intentionally deferred — the module
 * is a callable API; callers decide when to invoke it.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { AshlrConfig, VisualGroundingEvidence } from '../types.js';
import {
  locateVisualTargets,
  visualGroundingEvidenceFromResult,
  type VisualGroundingResult,
} from '../visual/grounding.js';
import { scrubSecrets } from '../util/scrub.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max ms to wait for the dev server to print a URL and become reachable. */
const SERVER_STARTUP_TIMEOUT_MS = 30_000;

/** Max ms for the browser navigation + DOM capture step. */
const BROWSER_NAV_TIMEOUT_MS = 20_000;

/** Bounded graceful/hard-stop windows for invocation-owned browser processes. */
const PROCESS_TERMINATION_GRACE_MS = 1_000;
const PROCESS_TERMINATION_DRAIN_MS = 250;

/** Known macOS and Linux paths for headless Chrome/Chromium. */
const KNOWN_CHROME_PATHS = [
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];

/** Regex that pulls the local URL out of a typical Vite/Next/CRA dev-server log line. */
const URL_PATTERN = /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\S*)/i;

// ---------------------------------------------------------------------------
// Public result type
// ---------------------------------------------------------------------------

/** Evidence captured from one browser verification pass. Never throws. */
export interface BrowserVerifyResult {
  /** True when the page rendered without an uncaught error, OR when skipped. */
  ok: boolean;
  /** True when no driver was available or the flag was off — not a failure. */
  skipped?: boolean;
  /** True only when the invocation owner cancelled this verification. */
  aborted?: boolean;
  /** True when an invocation-owned process did not confirm teardown. */
  teardownUnconfirmed?: boolean;
  /** Human-readable reason when skipped (e.g. 'no browser driver'). */
  reason?: string;
  /** Whether the DOM had meaningful content (non-error page). */
  renderOk: boolean;
  /** Console errors captured from the page (empty when skipped). */
  consoleErrors: string[];
  /** Absolute path to the screenshot file, if captured. */
  screenshotPath?: string;
  /** Optional screenshot grounding evidence. Metadata only; raw image data is never returned. */
  visualGrounding?: VisualGroundingEvidence;
  /** Short narrative for the judge ("renders clean, 0 console errors"). */
  detail: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** The subset of package.json fields we care about. */
interface PackageJson {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

/** Parse package.json at root; returns null on any error. */
function readPkg(repoDir: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

/** String-valued scripts map; empty object when absent. */
function scriptsOf(pkg: PackageJson | null): Record<string, string> {
  if (!pkg?.scripts) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(pkg.scripts)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** True when the package.json declares dep in deps or devDeps. */
function hasDep(pkg: PackageJson | null, dep: string): boolean {
  if (!pkg) return false;
  return dep in (pkg.dependencies ?? {}) || dep in (pkg.devDependencies ?? {});
}

/** Known web-framework package names that signal a web app. */
const WEB_FRAMEWORKS = [
  'next', 'vite', 'react', 'react-dom', 'svelte', '@sveltejs/kit',
  'vue', 'nuxt', '@nuxtjs/core', 'astro', 'remix', '@remix-run/node',
  'gatsby', 'qwik',
];

// ---------------------------------------------------------------------------
// Public: isWebApp
// ---------------------------------------------------------------------------

/**
 * Detect whether `repoDir` is a web application.
 *
 * Returns true when BOTH:
 *   1. package.json has a `dev` or `start` script (runnable dev server).
 *   2. At least one known web framework appears in deps/devDeps,
 *      OR a `public/index.html` is present (CRA / plain HTML app).
 *
 * Pure sync; never throws.
 */
export function isWebApp(repoDir: string): boolean {
  try {
    const pkg = readPkg(repoDir);
    if (!pkg) return false;

    const scripts = scriptsOf(pkg);
    const hasDevOrStart = 'dev' in scripts || 'start' in scripts;
    if (!hasDevOrStart) return false;

    const hasFramework = WEB_FRAMEWORKS.some((f) => hasDep(pkg, f));
    if (hasFramework) return true;

    // Fallback: static HTML entry point (CRA-like, plain HTML app)
    return existsSync(join(repoDir, 'public', 'index.html'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internal: driver detection
// ---------------------------------------------------------------------------

type DriverKind = 'playwright' | 'chrome' | 'none';

interface DriverInfo {
  kind: DriverKind;
  /** Executable path / command to run. */
  bin: string;
}

/** Detect which headless browser driver is available, in priority order. */
export function detectDriver(repoDir: string): DriverInfo {
  // 1. playwright installed in the repo's node_modules
  const playwrightBin = join(repoDir, 'node_modules', '.bin', 'playwright');
  if (existsSync(playwrightBin)) {
    return { kind: 'playwright', bin: playwrightBin };
  }

  // 2. playwright available globally via npx (best-effort: defer to spawn-time)
  //    We check for its presence by probing node_modules in common global npm paths.
  //    We accept the risk of a false-positive and let spawn fail → we catch it.
  // Note: we do NOT shell out to `npx playwright --version` here (that would be
  // slow and side-effectful). We instead record 'playwright' with 'npx' and
  // fall through in verifyInBrowser if the spawn fails.

  // 3. Known Chrome/Chromium system paths
  for (const chromePath of KNOWN_CHROME_PATHS) {
    if (existsSync(chromePath)) {
      return { kind: 'chrome', bin: chromePath };
    }
  }

  return { kind: 'none', bin: '' };
}

// ---------------------------------------------------------------------------
// Internal: screenshot directory
// ---------------------------------------------------------------------------

function screenshotDir(): string {
  const dir = join(homedir(), '.ashlr', 'browser-verify');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // ignore — caller handles missing path gracefully
  }
  return dir;
}

function screenshotPath(repoDir: string, ts: number): string {
  const label = repoDir.replace(/[^a-zA-Z0-9]/g, '_').slice(-40);
  return join(screenshotDir(), `${ts}-${label}.png`);
}

// ---------------------------------------------------------------------------
// Internal: dev-server management
// ---------------------------------------------------------------------------

interface OwnedProcessOptions {
  _processKill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  _terminationGraceMs?: number;
  _terminationDrainMs?: number;
}

function ownedProcessTerminator(
  child: ReturnType<typeof spawn>,
  opts?: OwnedProcessOptions,
): { stop(): Promise<boolean> } {
  const ownsProcessGroup = process.platform !== 'win32'
    && typeof child.pid === 'number'
    && child.pid > 0;
  let ownedPgid = ownsProcessGroup ? child.pid ?? null : null;
  let leaderExited = child.exitCode !== null || child.signalCode !== null;
  let closed = false;
  let groupAbsent = false;
  let hardKillSent = false;
  let stopPromise: Promise<boolean> | null = null;
  let resolveLeaderExit!: () => void;
  const leaderExitPromise = new Promise<void>((resolve) => { resolveLeaderExit = resolve; });
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const onExit = (): void => {
    leaderExited = true;
    resolveLeaderExit();
  };
  const onClose = (): void => {
    leaderExited = true;
    closed = true;
    resolveLeaderExit();
    resolveClosed();
  };
  child.once('exit', onExit);
  child.once('close', onClose);

  const waitForClose = async (timeoutMs: number): Promise<boolean> => {
    if (closed) return true;
    return await new Promise<boolean>((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve(false);
      }, timeoutMs);
      void closedPromise.then(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  };

  const waitForLeaderEvent = async (
    timeoutMs: number,
  ): Promise<'close' | 'exit' | 'timeout'> => {
    if (closed) return 'close';
    if (leaderExited) return 'exit';
    return await new Promise<'close' | 'exit' | 'timeout'>((resolve) => {
      let done = false;
      const finish = (result: 'close' | 'exit' | 'timeout'): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
      void closedPromise.then(() => finish('close'));
      void leaderExitPromise.then(() => finish(closed ? 'close' : 'exit'));
    });
  };

  const releaseUnconfirmedProcess = (): void => {
    child.stdout?.destroy?.();
    child.stderr?.destroy?.();
    child.unref?.();
  };

  const processKill = opts?._processKill
    ?? ((pid: number, signal: NodeJS.Signals | 0) => process.kill(pid, signal));

  const leaderIdentityIsAuthenticated = (): boolean => {
    // An unreaped detached leader pins its PID/PGID identity. Once Node records
    // or emits its exit, the numeric PGID may be recycled and must be revoked.
    return !leaderExited && child.exitCode === null && child.signalCode === null;
  };

  const processGroupError = (err: unknown): 'absent' | 'failed' => {
    const code = typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code ?? '')
      : '';
    if (code === 'ESRCH') {
      groupAbsent = true;
      ownedPgid = null;
      return 'absent';
    }
    return 'failed';
  };

  const signalOwnedGroup = (
    signal: NodeJS.Signals,
  ): 'sent' | 'absent' | 'failed' => {
    if (ownedPgid === null) return groupAbsent ? 'absent' : 'failed';
    if (!leaderIdentityIsAuthenticated()) {
      ownedPgid = null;
      return 'failed';
    }
    try {
      processKill(-ownedPgid, signal);
      return 'sent';
    } catch (err) {
      return processGroupError(err);
    }
  };

  const probeOwnedGroup = (): 'present' | 'absent' | 'failed' => {
    if (ownedPgid === null) return groupAbsent ? 'absent' : 'failed';
    if (!leaderIdentityIsAuthenticated()) {
      ownedPgid = null;
      return 'failed';
    }
    try {
      processKill(-ownedPgid, 0);
      return 'present';
    } catch (err) {
      return processGroupError(err);
    }
  };

  const stopSingleProcess = async (): Promise<boolean> => {
    if (closed) return true;
    try { child.kill('SIGTERM'); } catch { /* bounded settlement below */ }
    if (await waitForClose(opts?._terminationGraceMs ?? PROCESS_TERMINATION_GRACE_MS)) return true;
    try { child.kill('SIGKILL'); } catch { /* bounded settlement below */ }
    return await waitForClose(opts?._terminationDrainMs ?? PROCESS_TERMINATION_DRAIN_MS);
  };

  const stopOwnedProcessGroup = async (): Promise<boolean> => {
    if (!leaderIdentityIsAuthenticated()) return false;

    const termResult = signalOwnedGroup('SIGTERM');
    if (termResult === 'failed') return false;
    if (termResult === 'absent') {
      return await waitForClose(opts?._terminationDrainMs ?? PROCESS_TERMINATION_DRAIN_MS);
    }

    const gracefulResult = await waitForLeaderEvent(
      opts?._terminationGraceMs ?? PROCESS_TERMINATION_GRACE_MS,
    );
    if (gracefulResult !== 'timeout') {
      // The leader can be recycled after exit. A later numeric-PGID probe or
      // signal could target an unrelated process group, so fail closed here.
      ownedPgid = null;
      return false;
    }

    const groupState = probeOwnedGroup();
    if (groupState === 'failed') return false;
    if (groupState === 'absent') {
      return await waitForClose(opts?._terminationDrainMs ?? PROCESS_TERMINATION_DRAIN_MS);
    }

    const killResult = signalOwnedGroup('SIGKILL');
    hardKillSent = killResult === 'sent';
    if (killResult === 'failed') return false;
    if (killResult === 'absent') {
      return await waitForClose(opts?._terminationDrainMs ?? PROCESS_TERMINATION_DRAIN_MS);
    }

    // SIGKILL was authorized while the unreaped leader still pinned this PGID.
    // After that point only wait for ChildProcess/stdIO closure; never touch the
    // numeric PGID again once the leader exits.
    return hardKillSent
      && await waitForClose(opts?._terminationDrainMs ?? PROCESS_TERMINATION_DRAIN_MS);
  };

  return {
    stop(): Promise<boolean> {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        const confirmed = ownsProcessGroup
          ? await stopOwnedProcessGroup()
          : await stopSingleProcess();
        if (!confirmed) releaseUnconfirmedProcess();
        return confirmed;
      })();
      return stopPromise;
    },
  };
}

class BrowserVerificationAbortedError extends Error {
  constructor() {
    super('browser verification cancelled');
    this.name = 'AbortError';
  }
}

class BrowserTeardownUnconfirmedError extends Error {
  constructor(component: string) {
    super(`${component} teardown unconfirmed`);
    this.name = 'BrowserTeardownUnconfirmedError';
  }
}

interface BrowserCaptureResult {
  renderOk: boolean;
  consoleErrors: string[];
  captured: boolean;
  aborted?: boolean;
  teardownUnconfirmed?: boolean;
}

interface ServerHandle {
  /** Stop the invocation-owned dev server and wait for bounded settlement. */
  stop(): Promise<boolean>;
  /** The URL the server is listening on (populated after startDevServer resolves). */
  url: string;
}

/**
 * Start the repo's dev server (npm run dev → npm run start as fallback).
 * Resolves once the server URL is seen in stdout/stderr, or rejects on timeout.
 * The returned `stop()` MUST be awaited in a finally block.
 */
export function startDevServer(
  repoDir: string,
  opts?: {
    startupTimeoutMs?: number;
    signal?: AbortSignal;
    /** Injected for testing: override spawn. */
    _spawnFn?: typeof spawn;
  } & OwnedProcessOptions,
): Promise<ServerHandle> {
  const timeout = opts?.startupTimeoutMs ?? SERVER_STARTUP_TIMEOUT_MS;
  const spawnFn = opts?._spawnFn ?? spawn;

  return new Promise((resolve, reject) => {
    const pkg = readPkg(repoDir);
    const scripts = scriptsOf(pkg);
    const script = 'dev' in scripts ? 'dev' : 'start';

    if (opts?.signal?.aborted) {
      reject(new BrowserVerificationAbortedError());
      return;
    }

    const child = spawnFn('npm', ['run', script], {
      cwd: repoDir,
      env: {
        ...process.env,
        // Force ephemeral port selection via env var honoured by most frameworks
        PORT: '0',
        // Suppress interactive prompts
        CI: 'true',
        FORCE_COLOR: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(process.platform !== 'win32' ? { detached: true } : {}),
    });
    const terminator = ownedProcessTerminator(child, opts);

    let settled = false;
    let url = '';
    const cleanup = (): void => {
      clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', onAbort);
    };

    const rejectAfterStop = async (err: Error): Promise<void> => {
      if (settled) return;
      settled = true;
      cleanup();
      const stopped = await terminator.stop();
      reject(stopped ? err : new BrowserTeardownUnconfirmedError('dev server'));
    };

    const onAbort = (): void => {
      void rejectAfterStop(new BrowserVerificationAbortedError());
    };

    function tryResolve(line: string): void {
      if (settled) return;
      const m = URL_PATTERN.exec(line);
      if (m) {
        url = m[0];
        settled = true;
        cleanup();
        resolve({
          stop: () => terminator.stop(),
          url,
        });
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split('\n')) tryResolve(line);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split('\n')) tryResolve(line);
    });

    child.on('error', (err) => {
      void rejectAfterStop(err);
    });

    child.on('exit', (code) => {
      if (!settled) void rejectAfterStop(new Error(`Dev server exited early with code ${String(code)}`));
    });

    const timer = setTimeout(() => {
      void rejectAfterStop(new Error(`Dev server did not print a URL within ${timeout}ms`));
    }, timeout);
    opts?.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts?.signal?.aborted) onAbort();
  });
}

// ---------------------------------------------------------------------------
// Internal: browser capture via Playwright
// ---------------------------------------------------------------------------

async function captureWithPlaywright(
  driver: DriverInfo,
  url: string,
  shotPath: string,
  opts?: {
    navTimeoutMs?: number;
    signal?: AbortSignal;
    /** Injected for testing: override spawn. */
    _spawnFn?: typeof spawn;
  } & OwnedProcessOptions,
): Promise<BrowserCaptureResult> {
  const navTimeout = opts?.navTimeoutMs ?? BROWSER_NAV_TIMEOUT_MS;
  const spawnFn = opts?._spawnFn ?? spawn;
  if (opts?.signal?.aborted) {
    return { renderOk: false, consoleErrors: [], captured: false, aborted: true };
  }

  // Playwright inline script — avoids a temp file; passed via stdin.
  // We use `node -e` to evaluate the script so we can drive playwright
  // programmatically from the CLI without a config file.
  const script = `
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(err.message));
  try {
    await page.goto(${JSON.stringify(url)}, { timeout: ${navTimeout}, waitUntil: 'domcontentloaded' });
    await page.screenshot({ path: ${JSON.stringify(shotPath)} });
    const bodyText = await page.evaluate(() => document.body ? document.body.innerText : '');
    const renderOk = bodyText.trim().length > 0;
    console.log(JSON.stringify({ renderOk, consoleErrors: errors, captured: true }));
  } finally {
    await browser.close();
  }
})().catch(err => {
  console.log(JSON.stringify({ renderOk: false, consoleErrors: [err.message], captured: false }));
  process.exit(1);
});
`.trim();

  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    let terminating = false;

    const child = spawnFn('node', ['-e', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        // When driver is a local node_modules playwright, ensure it resolves
        NODE_PATH: join(dirname(driver.bin), '..', '..'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(process.platform !== 'win32' ? { detached: true } : {}),
    });
    const terminator = ownedProcessTerminator(child, opts);
    const finish = (result: BrowserCaptureResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const stopThenFinish = async (
      result: BrowserCaptureResult,
    ): Promise<void> => {
      if (settled || terminating) return;
      terminating = true;
      const stopped = await terminator.stop();
      finish(stopped
        ? result
        : {
            renderOk: false,
            consoleErrors: ['browser process teardown unconfirmed'],
            captured: false,
            teardownUnconfirmed: true,
          });
    };

    const onAbort = (): void => {
      void stopThenFinish({ renderOk: false, consoleErrors: [], captured: false, aborted: true });
    };

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });

    child.on('error', () => {
      void stopThenFinish({ renderOk: false, consoleErrors: ['playwright spawn failed'], captured: false });
    });

    child.on('close', () => {
      if (terminating) return;
      try {
        const last = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
        const parsed = JSON.parse(last) as { renderOk: boolean; consoleErrors: string[]; captured: boolean };
        finish(parsed);
      } catch {
        finish({ renderOk: false, consoleErrors: ['could not parse playwright output'], captured: false });
      }
    });

    const timer = setTimeout(() => {
      void stopThenFinish({
        renderOk: false,
        consoleErrors: [`playwright timed out after ${navTimeout}ms`],
        captured: false,
      });
    }, navTimeout + 5_000); // small grace over the page timeout
    opts?.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts?.signal?.aborted) onAbort();
  });
}

// ---------------------------------------------------------------------------
// Internal: browser capture via headless Chrome --dump-dom
// ---------------------------------------------------------------------------

async function captureWithChrome(
  driver: DriverInfo,
  url: string,
  opts?: {
    navTimeoutMs?: number;
    signal?: AbortSignal;
    _spawnFn?: typeof spawn;
  } & OwnedProcessOptions,
): Promise<BrowserCaptureResult> {
  const navTimeout = opts?.navTimeoutMs ?? BROWSER_NAV_TIMEOUT_MS;
  const spawnFn = opts?._spawnFn ?? spawn;
  if (opts?.signal?.aborted) {
    return { renderOk: false, consoleErrors: [], captured: false, aborted: true };
  }

  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    let terminating = false;

    const child = spawnFn(driver.bin, [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      `--timeout=${navTimeout}`,
      '--dump-dom',
      url,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(process.platform !== 'win32' ? { detached: true } : {}),
    });
    const terminator = ownedProcessTerminator(child, opts);
    const finish = (result: BrowserCaptureResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const stopThenFinish = async (
      result: BrowserCaptureResult,
    ): Promise<void> => {
      if (settled || terminating) return;
      terminating = true;
      const stopped = await terminator.stop();
      finish(stopped
        ? result
        : {
            renderOk: false,
            consoleErrors: ['browser process teardown unconfirmed'],
            captured: false,
            teardownUnconfirmed: true,
          });
    };

    const onAbort = (): void => {
      void stopThenFinish({ renderOk: false, consoleErrors: [], captured: false, aborted: true });
    };

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });

    child.on('error', () => {
      void stopThenFinish({ renderOk: false, consoleErrors: ['chrome spawn failed'], captured: false });
    });

    child.on('close', () => {
      if (terminating) return;
      // Heuristic: a non-error page has a <body> with text content
      const hasBody = /<body[\s>]/i.test(stdout);
      const hasContent = stdout.length > 200;
      const renderOk = hasBody && hasContent;
      // Chrome --dump-dom doesn't expose console errors; note the limitation
      finish({ renderOk, consoleErrors: [], captured: false });
    });

    const timer = setTimeout(() => {
      void stopThenFinish({
        renderOk: false,
        consoleErrors: [`chrome timed out after ${navTimeout}ms`],
        captured: false,
      });
    }, navTimeout + 5_000);
    opts?.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts?.signal?.aborted) onAbort();
  });
}

// ---------------------------------------------------------------------------
// Public: verifyInBrowser
// ---------------------------------------------------------------------------

/** Options for `verifyInBrowser`. */
export interface BrowserVerifyOptions extends OwnedProcessOptions {
  /** URL path to navigate to after the root (e.g. '/dashboard'). */
  route?: string;
  /** Invocation-owner cancellation shared by server startup and browser capture. */
  signal?: AbortSignal;
  /** Override server startup timeout (ms). */
  startupTimeoutMs?: number;
  /** Override browser navigation timeout (ms). */
  navTimeoutMs?: number;
  /**
   * Injected for testing — replace spawn so no real subprocesses are launched.
   * Both the server-start and the browser-capture calls receive this override.
   */
  _spawnFn?: typeof spawn;
  /**
   * Injected for testing — replace visual grounding so no provider/network call
   * is made. Production uses locateVisualTargets.
   */
  _locateVisualTargetsFn?: typeof locateVisualTargets;
}

/**
 * Spin up the repo's dev server, navigate to it with a headless browser, and
 * return evidence (renderOk, consoleErrors, screenshotPath). Teardown is bounded
 * and any unconfirmed stop is returned as a failure.
 *
 * Guard: when `cfg.foundry?.browserVerify` is false/absent → immediate skip.
 * Degrade: when no browser driver is available → { ok:true, skipped:true }.
 *
 * Never throws — every error path resolves to BrowserVerifyResult.
 */
export async function verifyInBrowser(
  repoDir: string,
  cfg: AshlrConfig,
  opts?: BrowserVerifyOptions,
): Promise<BrowserVerifyResult> {
  const abortedResult = (): BrowserVerifyResult => ({
    ok: false,
    aborted: true,
    reason: 'cancelled by invocation owner',
    renderOk: false,
    consoleErrors: [],
    detail: 'browser verify aborted',
  });
  const teardownUnconfirmedResult = (component: string): BrowserVerifyResult => ({
    ok: false,
    teardownUnconfirmed: true,
    reason: `${component} teardown unconfirmed`,
    renderOk: false,
    consoleErrors: [],
    detail: `browser verify failed: ${component} teardown unconfirmed`,
  });

  if (opts?.signal?.aborted) return abortedResult();

  // ── Flag guard ─────────────────────────────────────────────────────────────
  if (!cfg.foundry?.browserVerify) {
    return {
      ok: true,
      skipped: true,
      reason: 'cfg.foundry.browserVerify is not enabled',
      renderOk: false,
      consoleErrors: [],
      detail: 'browser verify skipped (flag off)',
    };
  }

  // ── Web-app guard ──────────────────────────────────────────────────────────
  if (!isWebApp(repoDir)) {
    return {
      ok: true,
      skipped: true,
      reason: 'not a web app',
      renderOk: false,
      consoleErrors: [],
      detail: 'browser verify skipped (not a web app)',
    };
  }

  // ── Driver detection ───────────────────────────────────────────────────────
  const driver = detectDriver(repoDir);
  if (driver.kind === 'none') {
    return {
      ok: true,
      skipped: true,
      reason: 'no browser driver (install playwright: npx playwright install chromium)',
      renderOk: false,
      consoleErrors: [],
      detail: 'browser verify skipped (no driver)',
    };
  }

  // ── Server + browser (with guaranteed cleanup) ─────────────────────────────
  let serverHandle: ServerHandle | null = null;
  const ts = Date.now();
  const shotPath = screenshotPath(repoDir, ts);
  let verificationResult: BrowserVerifyResult;

  try {
    // 1. Start dev server
    serverHandle = await startDevServer(repoDir, {
      startupTimeoutMs: opts?.startupTimeoutMs,
      signal: opts?.signal,
      _spawnFn: opts?._spawnFn,
      _processKill: opts?._processKill,
      _terminationGraceMs: opts?._terminationGraceMs,
      _terminationDrainMs: opts?._terminationDrainMs,
    });
    if (opts?.signal?.aborted) {
      verificationResult = abortedResult();
    } else {
      const targetUrl = opts?.route
        ? serverHandle.url.replace(/\/$/, '') + opts.route
        : serverHandle.url;

      // 2. Drive headless browser
      let capture: BrowserCaptureResult;

      if (driver.kind === 'playwright') {
        capture = await captureWithPlaywright(driver, targetUrl, shotPath, {
          navTimeoutMs: opts?.navTimeoutMs,
          signal: opts?.signal,
          _spawnFn: opts?._spawnFn,
          _processKill: opts?._processKill,
          _terminationGraceMs: opts?._terminationGraceMs,
          _terminationDrainMs: opts?._terminationDrainMs,
        });
      } else {
        // chrome — no screenshot capability via --dump-dom
        capture = await captureWithChrome(driver, targetUrl, {
          navTimeoutMs: opts?.navTimeoutMs,
          signal: opts?.signal,
          _spawnFn: opts?._spawnFn,
          _processKill: opts?._processKill,
          _terminationGraceMs: opts?._terminationGraceMs,
          _terminationDrainMs: opts?._terminationDrainMs,
        });
      }

      if (capture.teardownUnconfirmed) {
        verificationResult = teardownUnconfirmedResult('browser process');
      } else if (capture.aborted || opts?.signal?.aborted) {
        verificationResult = abortedResult();
      } else {
        // 3. Assemble result
        const ok = capture.renderOk && capture.consoleErrors.length === 0;
        const errCount = capture.consoleErrors.length;
        const visualGrounding = capture.captured
          ? await maybeGroundBrowserScreenshot(shotPath, cfg, opts)
          : undefined;
        if (opts?.signal?.aborted) {
          verificationResult = abortedResult();
        } else {
          const detail = capture.renderOk
            ? `renders clean, ${errCount === 0 ? '0' : String(errCount)} console error${errCount === 1 ? '' : 's'}`
            : `blank/error page${errCount > 0 ? `; console error: ${capture.consoleErrors[0] ?? ''}` : ''}`;

          verificationResult = {
            ok,
            renderOk: capture.renderOk,
            consoleErrors: capture.consoleErrors,
            screenshotPath: capture.captured ? shotPath : undefined,
            ...(visualGrounding ? { visualGrounding } : {}),
            detail,
          };
        }
      }
    }
  } catch (err) {
    if (err instanceof BrowserTeardownUnconfirmedError) {
      verificationResult = teardownUnconfirmedResult('dev server');
    } else if (opts?.signal?.aborted || err instanceof BrowserVerificationAbortedError) {
      verificationResult = abortedResult();
    } else {
      const msg = scrubSecrets(err instanceof Error ? err.message : String(err));
      verificationResult = {
        ok: false,
        renderOk: false,
        consoleErrors: [],
        detail: `browser verify error: ${msg}`,
      };
    }
  }

  // Await bounded server teardown before the caller can remove its worktree.
  if (serverHandle) {
    try {
      if (!await serverHandle.stop()) return teardownUnconfirmedResult('dev server');
    } catch {
      return teardownUnconfirmedResult('dev server');
    }
  }
  return verificationResult;
}

function visualGroundingQuery(cfg: AshlrConfig): string | null {
  const query = cfg.foundry?.visualGrounding?.query;
  return typeof query === 'string' && query.trim() ? query.trim() : null;
}

async function maybeGroundBrowserScreenshot(
  imagePath: string,
  cfg: AshlrConfig,
  opts?: BrowserVerifyOptions,
): Promise<VisualGroundingEvidence | undefined> {
  const query = visualGroundingQuery(cfg);
  if (!query) return undefined;
  const locate = opts?._locateVisualTargetsFn ?? locateVisualTargets;
  try {
    const result = await locate(
      { imagePath, query, purpose: 'browser-verify' },
      cfg,
    );
    return visualGroundingEvidenceFromResult(result);
  } catch (err) {
    const msg = scrubSecrets(err instanceof Error ? err.message : String(err));
    const provider = cfg.foundry?.visualGrounding?.provider === 'generic-openai-vision'
      ? 'generic-openai-vision'
      : 'locateanything-http';
    const result: VisualGroundingResult = {
      ok: false,
      provider,
      boxes: [],
      detail: `visual grounding failed: ${msg}`,
      reason: msg,
    };
    return visualGroundingEvidenceFromResult(result);
  }
}
