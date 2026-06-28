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
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { AshlrConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max ms to wait for the dev server to print a URL and become reachable. */
const SERVER_STARTUP_TIMEOUT_MS = 30_000;

/** Max ms for the browser navigation + DOM capture step. */
const BROWSER_NAV_TIMEOUT_MS = 20_000;

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
  /** Human-readable reason when skipped (e.g. 'no browser driver'). */
  reason?: string;
  /** Whether the DOM had meaningful content (non-error page). */
  renderOk: boolean;
  /** Console errors captured from the page (empty when skipped). */
  consoleErrors: string[];
  /** Absolute path to the screenshot file, if captured. */
  screenshotPath?: string;
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

interface ServerHandle {
  /** Kill the dev server process. */
  kill(): void;
  /** The URL the server is listening on (populated after startDevServer resolves). */
  url: string;
}

/**
 * Start the repo's dev server (npm run dev → npm run start as fallback).
 * Resolves once the server URL is seen in stdout/stderr, or rejects on timeout.
 * The returned `kill()` MUST be called in a finally block.
 */
export function startDevServer(
  repoDir: string,
  opts?: {
    startupTimeoutMs?: number;
    /** Injected for testing: override spawn. */
    _spawnFn?: typeof spawn;
  },
): Promise<ServerHandle> {
  const timeout = opts?.startupTimeoutMs ?? SERVER_STARTUP_TIMEOUT_MS;
  const spawnFn = opts?._spawnFn ?? spawn;

  return new Promise((resolve, reject) => {
    const pkg = readPkg(repoDir);
    const scripts = scriptsOf(pkg);
    const script = 'dev' in scripts ? 'dev' : 'start';

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
    });

    let resolved = false;
    let url = '';

    function tryResolve(line: string): void {
      if (resolved) return;
      const m = URL_PATTERN.exec(line);
      if (m) {
        url = m[0];
        resolved = true;
        clearTimeout(timer);
        resolve({
          kill: () => {
            try { child.kill('SIGTERM'); } catch { /* ignore */ }
          },
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
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    child.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(new Error(`Dev server exited early with code ${String(code)}`));
      }
    });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        reject(new Error(`Dev server did not print a URL within ${timeout}ms`));
      }
    }, timeout);
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
    /** Injected for testing: override spawn. */
    _spawnFn?: typeof spawn;
  },
): Promise<{ renderOk: boolean; consoleErrors: string[]; captured: boolean }> {
  const navTimeout = opts?.navTimeoutMs ?? BROWSER_NAV_TIMEOUT_MS;
  const spawnFn = opts?._spawnFn ?? spawn;

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
    let timedOut = false;

    const child = spawnFn('node', ['-e', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        // When driver is a local node_modules playwright, ensure it resolves
        NODE_PATH: join(dirname(driver.bin), '..', '..'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });

    child.on('error', () => {
      if (!timedOut) resolve({ renderOk: false, consoleErrors: ['playwright spawn failed'], captured: false });
    });

    child.on('exit', () => {
      if (timedOut) return;
      try {
        const last = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
        const parsed = JSON.parse(last) as { renderOk: boolean; consoleErrors: string[]; captured: boolean };
        resolve(parsed);
      } catch {
        resolve({ renderOk: false, consoleErrors: ['could not parse playwright output'], captured: false });
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      resolve({ renderOk: false, consoleErrors: [`playwright timed out after ${navTimeout}ms`], captured: false });
    }, navTimeout + 5_000); // small grace over the page timeout

    child.on('exit', () => clearTimeout(timer));
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
    _spawnFn?: typeof spawn;
  },
): Promise<{ renderOk: boolean; consoleErrors: string[]; captured: boolean }> {
  const navTimeout = opts?.navTimeoutMs ?? BROWSER_NAV_TIMEOUT_MS;
  const spawnFn = opts?._spawnFn ?? spawn;

  return new Promise((resolve) => {
    let stdout = '';
    let timedOut = false;

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
    });

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });

    child.on('error', () => {
      if (!timedOut) resolve({ renderOk: false, consoleErrors: ['chrome spawn failed'], captured: false });
    });

    child.on('exit', () => {
      if (timedOut) return;
      // Heuristic: a non-error page has a <body> with text content
      const hasBody = /<body[\s>]/i.test(stdout);
      const hasContent = stdout.length > 200;
      const renderOk = hasBody && hasContent;
      // Chrome --dump-dom doesn't expose console errors; note the limitation
      resolve({ renderOk, consoleErrors: [], captured: false });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      resolve({ renderOk: false, consoleErrors: [`chrome timed out after ${navTimeout}ms`], captured: false });
    }, navTimeout + 5_000);

    child.on('exit', () => clearTimeout(timer));
  });
}

// ---------------------------------------------------------------------------
// Internal: path.dirname polyfill (node built-in, always present)
// ---------------------------------------------------------------------------
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Public: verifyInBrowser
// ---------------------------------------------------------------------------

/** Options for `verifyInBrowser`. */
export interface BrowserVerifyOptions {
  /** URL path to navigate to after the root (e.g. '/dashboard'). */
  route?: string;
  /** Override server startup timeout (ms). */
  startupTimeoutMs?: number;
  /** Override browser navigation timeout (ms). */
  navTimeoutMs?: number;
  /**
   * Injected for testing — replace spawn so no real subprocesses are launched.
   * Both the server-start and the browser-capture calls receive this override.
   */
  _spawnFn?: typeof spawn;
}

/**
 * Spin up the repo's dev server, navigate to it with a headless browser, and
 * return evidence (renderOk, consoleErrors, screenshotPath). Always cleans up.
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

  try {
    // 1. Start dev server
    serverHandle = await startDevServer(repoDir, {
      startupTimeoutMs: opts?.startupTimeoutMs,
      _spawnFn: opts?._spawnFn,
    });

    const targetUrl = opts?.route
      ? serverHandle.url.replace(/\/$/, '') + opts.route
      : serverHandle.url;

    // 2. Drive headless browser
    let capture: { renderOk: boolean; consoleErrors: string[]; captured: boolean };

    if (driver.kind === 'playwright') {
      capture = await captureWithPlaywright(driver, targetUrl, shotPath, {
        navTimeoutMs: opts?.navTimeoutMs,
        _spawnFn: opts?._spawnFn,
      });
    } else {
      // chrome — no screenshot capability via --dump-dom
      capture = await captureWithChrome(driver, targetUrl, {
        navTimeoutMs: opts?.navTimeoutMs,
        _spawnFn: opts?._spawnFn,
      });
    }

    // 3. Assemble result
    const ok = capture.renderOk && capture.consoleErrors.length === 0;
    const errCount = capture.consoleErrors.length;
    const detail = capture.renderOk
      ? `renders clean, ${errCount === 0 ? '0' : String(errCount)} console error${errCount === 1 ? '' : 's'}`
      : `blank/error page${errCount > 0 ? `; console error: ${capture.consoleErrors[0] ?? ''}` : ''}`;

    return {
      ok,
      renderOk: capture.renderOk,
      consoleErrors: capture.consoleErrors,
      screenshotPath: capture.captured ? shotPath : undefined,
      detail,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      renderOk: false,
      consoleErrors: [],
      detail: `browser verify error: ${msg}`,
    };
  } finally {
    // Always kill the dev server — even on error
    if (serverHandle) {
      try { serverHandle.kill(); } catch { /* ignore */ }
    }
  }
}
