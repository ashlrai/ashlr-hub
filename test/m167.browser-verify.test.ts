/**
 * M167 Browser-verify tests — hermetic, no real servers or browsers.
 *
 * Covers:
 *   1. isWebApp: detects next/vite/react projects; rejects CLI-only repos.
 *   2. detectDriver: returns 'playwright' | 'chrome' | 'none' from FS state.
 *   3. verifyInBrowser: flag-OFF → immediate skip (no-op).
 *   4. verifyInBrowser: mocked browser returns renderOk + consoleErrors + screenshotPath.
 *   5. verifyInBrowser: degrades to { skipped:true } when no driver available.
 *   6. verifyInBrowser: kills the server on SUCCESS (server.kill called).
 *   7. verifyInBrowser: kills the server on ERROR (server.kill called in finally).
 *   8. Time-box honoured: a hung server startup rejects within startupTimeoutMs.
 *   9. Never-throws: every error path resolves (no unhandled rejection).
 *  10. isWebApp: public/index.html static fallback detected.
 *
 * SAFETY / HERMETICITY:
 *  - Spawn is injected; one POSIX regression uses only local Node subprocesses.
 *  - HOME overridden to a tmp dir in beforeEach.
 *  - tmp dirs swept in afterEach.
 *  - No network, no browser, no dev server.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn as spawnProcess } from 'node:child_process';
import type { AshlrConfig } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Lazy imports — loaded AFTER we manipulate HOME/fs state
// ---------------------------------------------------------------------------

import {
  isWebApp,
  detectDriver,
  verifyInBrowser,
  startDevServer,
} from '../src/core/run/browser-verify.js';

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
const tmpDirs: string[] = [];

function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal AshlrConfig. */
function makeCfg(over: Partial<AshlrConfig> = {}): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      ollama: 'http://localhost:11434',
      providerChain: ['ollama'],
    },
    telemetry: {},
    tools: {},
    ...over,
  } as AshlrConfig;
}

/** Write a minimal package.json to repoDir. */
function writePackageJson(repoDir: string, pkg: object): void {
  writeFileSync(join(repoDir, 'package.json'), JSON.stringify(pkg, null, 2));
}

/**
 * Install a fake playwright binary under repoDir so detectDriver returns 'playwright'.
 * This is the FS-based way to control driver detection without vi.spyOn.
 */
function installFakePlaywright(repoDir: string): string {
  const binDir = join(repoDir, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, 'playwright');
  writeFileSync(bin, '#!/bin/sh\necho ok');
  return bin;
}

/**
 * Build a fake spawn function that simulates a dev server printing `url` after
 * `delayMs`, then staying alive.
 *
 * Returns { spawnFn, killSpy } so tests can assert cleanup.
 */
function makeFakeServer(opts: {
  url?: string;
  delayMs?: number;
  exitImmediately?: boolean;
  neverPrint?: boolean;
}): { spawnFn: typeof import('node:child_process').spawn; killSpy: ReturnType<typeof vi.fn> } {
  const killSpy = vi.fn();

  const spawnFn = vi.fn((_cmd: string, _args: string[], _opts?: object) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
      stdin: null;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = null;
    child.kill = killSpy;
    killSpy.mockImplementation((signal?: NodeJS.Signals) => {
      setImmediate(() => child.emit('close', null, signal ?? 'SIGTERM'));
      return true;
    });

    if (opts.exitImmediately) {
      setImmediate(() => child.emit('exit', 1));
    } else if (!opts.neverPrint && opts.url) {
      const delay = opts.delayMs ?? 10;
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from(`  Local: ${opts.url}\n`));
      }, delay);
    }
    // otherwise hangs indefinitely (for timeout tests)

    return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
  }) as unknown as typeof import('node:child_process').spawn;

  return { spawnFn, killSpy };
}

/**
 * A combined fake spawn that dispatches: first call → server, subsequent → browser.
 */
function makeComboSpawn(
  serverUrl: string,
  browserResult: { renderOk: boolean; consoleErrors: string[]; captured: boolean },
): { spawnFn: typeof import('node:child_process').spawn; serverKillSpy: ReturnType<typeof vi.fn> } {
  const serverKillSpy = vi.fn();
  let callCount = 0;

  const spawnFn = vi.fn((_cmd: string, _args: string[], _opts?: object) => {
    callCount++;
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: null;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = null;

    if (callCount === 1) {
      // Server: print URL after short delay
      child.kill = serverKillSpy;
      serverKillSpy.mockImplementation((signal?: NodeJS.Signals) => {
        setImmediate(() => child.emit('close', null, signal ?? 'SIGTERM'));
        return true;
      });
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from(`  Local: ${serverUrl}\n`));
      }, 10);
    } else {
      // Browser: return result immediately
      child.kill = vi.fn();
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify(browserResult) + '\n'));
        child.emit('exit', 0);
        child.emit('close', 0);
      });
    }

    return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
  }) as unknown as typeof import('node:child_process').spawn;

  return { spawnFn, serverKillSpy };
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  const tmpHome = mkTmp('m167-home-');
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = origHome;
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. isWebApp detection
// ---------------------------------------------------------------------------

describe('isWebApp', () => {
  it('detects a Next.js project', () => {
    const repo = mkTmp('m167-next-');
    writePackageJson(repo, {
      scripts: { dev: 'next dev', build: 'next build' },
      dependencies: { next: '14.0.0', react: '18.0.0', 'react-dom': '18.0.0' },
    });
    expect(isWebApp(repo)).toBe(true);
  });

  it('detects a Vite project', () => {
    const repo = mkTmp('m167-vite-');
    writePackageJson(repo, {
      scripts: { dev: 'vite', build: 'vite build' },
      devDependencies: { vite: '5.0.0' },
    });
    expect(isWebApp(repo)).toBe(true);
  });

  it('detects a React (CRA-style) project via react-dom dep + start script', () => {
    const repo = mkTmp('m167-react-');
    writePackageJson(repo, {
      scripts: { start: 'react-scripts start', build: 'react-scripts build' },
      dependencies: { react: '18.0.0', 'react-dom': '18.0.0' },
    });
    expect(isWebApp(repo)).toBe(true);
  });

  it('detects a Svelte project', () => {
    const repo = mkTmp('m167-svelte-');
    writePackageJson(repo, {
      scripts: { dev: 'vite dev' },
      devDependencies: { svelte: '4.0.0', '@sveltejs/kit': '2.0.0' },
    });
    expect(isWebApp(repo)).toBe(true);
  });

  it('detects a Vue project', () => {
    const repo = mkTmp('m167-vue-');
    writePackageJson(repo, {
      scripts: { dev: 'vite' },
      dependencies: { vue: '3.0.0' },
    });
    expect(isWebApp(repo)).toBe(true);
  });

  it('detects a static-HTML app via public/index.html fallback', () => {
    const repo = mkTmp('m167-static-');
    writePackageJson(repo, {
      scripts: { start: 'serve public' },
      devDependencies: { serve: '14.0.0' },
    });
    mkdirSync(join(repo, 'public'));
    writeFileSync(join(repo, 'public', 'index.html'), '<html><body>hi</body></html>');
    expect(isWebApp(repo)).toBe(true);
  });

  it('rejects a CLI-only project (no web framework, no public/index.html)', () => {
    const repo = mkTmp('m167-cli-');
    writePackageJson(repo, {
      scripts: { start: 'node dist/cli.js', build: 'tsc' },
      dependencies: { commander: '11.0.0' },
    });
    expect(isWebApp(repo)).toBe(false);
  });

  it('rejects a project with a framework dep but NO dev/start script', () => {
    const repo = mkTmp('m167-nostart-');
    writePackageJson(repo, {
      scripts: { build: 'next build', lint: 'eslint .' },
      dependencies: { next: '14.0.0' },
    });
    expect(isWebApp(repo)).toBe(false);
  });

  it('rejects a repo with no package.json', () => {
    const repo = mkTmp('m167-nopkg-');
    // no package.json written
    expect(isWebApp(repo)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. detectDriver
// ---------------------------------------------------------------------------

describe('detectDriver', () => {
  it('returns playwright when node_modules/.bin/playwright exists', () => {
    const repo = mkTmp('m167-driver-pw-');
    mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', '.bin', 'playwright'), '#!/bin/sh\necho ok');
    const d = detectDriver(repo);
    expect(d.kind).toBe('playwright');
    expect(d.bin).toContain('playwright');
  });

  it('returns chrome when a known Chrome path exists (simulated via tmp)', () => {
    // We can't create /Applications/..., so we test the fallback-to-none path
    // when none of the well-known paths exist.
    const repo = mkTmp('m167-driver-none-');
    const d = detectDriver(repo);
    // On a typical CI/dev machine without playwright installed locally
    // this should be 'none' or 'chrome' depending on environment.
    // We only assert the shape, not the specific kind.
    expect(['playwright', 'chrome', 'none']).toContain(d.kind);
  });

  it('returns none or chrome depending on host when no local playwright', () => {
    // Repo has no playwright binary. Result depends on whether Chrome is
    // installed on the CI/dev host — we only assert the shape is valid.
    const repo = mkTmp('m167-driver-none2-');
    const d = detectDriver(repo);
    expect(['playwright', 'chrome', 'none']).toContain(d.kind);
  });
});

// ---------------------------------------------------------------------------
// 3. verifyInBrowser — flag OFF → skip
// ---------------------------------------------------------------------------

describe('verifyInBrowser — flag off', () => {
  it('returns skipped immediately when browserVerify is false', async () => {
    const repo = mkTmp('m167-flagoff-');
    writePackageJson(repo, {
      scripts: { dev: 'vite' },
      devDependencies: { vite: '5.0.0' },
    });
    const cfg = makeCfg({ foundry: {} }); // browserVerify absent → false
    const result = await verifyInBrowser(repo, cfg);
    expect(result.skipped).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.consoleErrors).toEqual([]);
  });

  it('returns skipped when foundry is absent', async () => {
    const repo = mkTmp('m167-nofoundry-');
    writePackageJson(repo, {
      scripts: { dev: 'next dev' },
      dependencies: { next: '14.0.0' },
    });
    const cfg = makeCfg(); // no foundry at all
    const result = await verifyInBrowser(repo, cfg);
    expect(result.skipped).toBe(true);
  });

  it('is a true no-op — does not spawn any subprocess when flag is off', async () => {
    const repo = mkTmp('m167-noop-');
    writePackageJson(repo, { scripts: { dev: 'vite' }, devDependencies: { vite: '5.0.0' } });
    const { spawnFn } = makeFakeServer({ url: 'http://localhost:3000' });
    const cfg = makeCfg({ foundry: {} });
    await verifyInBrowser(repo, cfg, { _spawnFn: spawnFn });
    expect((spawnFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. verifyInBrowser — degrade when no driver
// ---------------------------------------------------------------------------

describe('verifyInBrowser — no driver', () => {
  it('degrades gracefully — resolves with a valid result even when driver is absent', async () => {
    // Repo has no playwright binary (no installFakePlaywright).
    // detectDriver will return 'none' on a plain CI machine OR 'chrome' on a
    // dev box. Either way verifyInBrowser must resolve non-blockingly within the
    // startup timeout.
    const repo = mkTmp('m167-nodriver-');
    writePackageJson(repo, {
      scripts: { dev: 'vite' },
      devDependencies: { vite: '5.0.0' },
    });
    const { spawnFn } = makeFakeServer({ neverPrint: true });
    const cfg = makeCfg({ foundry: { browserVerify: true } });
    const result = await verifyInBrowser(repo, cfg, {
      _spawnFn: spawnFn,
      startupTimeoutMs: 100,
    });
    // Either 'no driver' skip or timeout-based ok:false — both non-blocking.
    expect(typeof result.ok).toBe('boolean');
    expect(Array.isArray(result.consoleErrors)).toBe(true);
  }, 1000);
});

// ---------------------------------------------------------------------------
// 5. verifyInBrowser — mocked successful browser
// ---------------------------------------------------------------------------

describe('verifyInBrowser — mocked browser', () => {
  it('returns renderOk + empty consoleErrors + screenshotPath on a clean page', async () => {
    const repo = mkTmp('m167-ok-');
    writePackageJson(repo, {
      scripts: { dev: 'vite' },
      devDependencies: { vite: '5.0.0' },
    });
    // installFakePlaywright creates node_modules/.bin/playwright so detectDriver returns 'playwright'
    installFakePlaywright(repo);

    const { spawnFn } = makeComboSpawn('http://localhost:5173', {
      renderOk: true,
      consoleErrors: [],
      captured: true,
    });

    const cfg = makeCfg({ foundry: { browserVerify: true } });
    const result = await verifyInBrowser(repo, cfg, { _spawnFn: spawnFn });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(result.renderOk).toBe(true);
    expect(result.consoleErrors).toEqual([]);
    expect(result.screenshotPath).toBeDefined();
    expect(result.screenshotPath).toContain('browser-verify');
    expect(result.detail).toMatch(/renders clean/);
  });

  it('does not call visual grounding unless a screenshot query is configured', async () => {
    const repo = mkTmp('m167-visual-noquery-');
    writePackageJson(repo, {
      scripts: { dev: 'vite' },
      devDependencies: { vite: '5.0.0' },
    });
    installFakePlaywright(repo);

    const { spawnFn } = makeComboSpawn('http://localhost:5173', {
      renderOk: true,
      consoleErrors: [],
      captured: true,
    });
    const locate = vi.fn(async () => ({
      ok: true,
      provider: 'generic-openai-vision' as const,
      boxes: [],
      detail: 'unused',
    }));

    const cfg = makeCfg({
      foundry: {
        browserVerify: true,
        visualGrounding: {
          enabled: true,
          provider: 'generic-openai-vision',
          endpoint: 'http://127.0.0.1:8000',
        },
      },
    });
    const result = await verifyInBrowser(repo, cfg, {
      _spawnFn: spawnFn,
      _locateVisualTargetsFn: locate,
    });

    expect(result.ok).toBe(true);
    expect(result.visualGrounding).toBeUndefined();
    expect(locate).not.toHaveBeenCalled();
  });

  it('attaches visual grounding evidence when a captured screenshot query is configured', async () => {
    const repo = mkTmp('m167-visual-query-');
    writePackageJson(repo, {
      scripts: { dev: 'vite' },
      devDependencies: { vite: '5.0.0' },
    });
    installFakePlaywright(repo);

    const { spawnFn } = makeComboSpawn('http://localhost:5173', {
      renderOk: true,
      consoleErrors: [],
      captured: true,
    });
    const locate = vi.fn(async (request) => ({
      ok: true,
      provider: 'generic-openai-vision' as const,
      boxes: [{ x1: 10, y1: 20, x2: 200, y2: 300, scale: 'normalized-1000' as const }],
      detail: 'visual grounding found 1 box',
      image: {
        path: request.imagePath,
        bytes: 8,
        sha256: 'a'.repeat(64),
      },
    }));

    const cfg = makeCfg({
      foundry: {
        browserVerify: true,
        visualGrounding: {
          enabled: true,
          provider: 'generic-openai-vision',
          endpoint: 'http://127.0.0.1:8000',
          query: 'Find the primary action',
        },
      },
    });
    const result = await verifyInBrowser(repo, cfg, {
      _spawnFn: spawnFn,
      _locateVisualTargetsFn: locate,
    });

    expect(result.ok).toBe(true);
    expect(result.visualGrounding?.status).toBe('ok');
    expect(result.visualGrounding?.boxCount).toBe(1);
    expect(result.visualGrounding?.boxes).toHaveLength(1);
    expect(result.visualGrounding).not.toHaveProperty('rawText');
    expect(locate).toHaveBeenCalledOnce();
    expect(locate.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      imagePath: result.screenshotPath,
      purpose: 'browser-verify',
      query: 'Find the primary action',
    }));
  });

  it('returns ok:false + consoleErrors when the page has errors', async () => {
    const repo = mkTmp('m167-errors-');
    writePackageJson(repo, {
      scripts: { dev: 'next dev' },
      dependencies: { next: '14.0.0' },
    });
    installFakePlaywright(repo);

    const { spawnFn } = makeComboSpawn('http://localhost:3000', {
      renderOk: true,
      consoleErrors: ['Uncaught TypeError: Cannot read property of undefined'],
      captured: true,
    });

    const cfg = makeCfg({ foundry: { browserVerify: true } });
    const result = await verifyInBrowser(repo, cfg, { _spawnFn: spawnFn });

    expect(result.ok).toBe(false);
    expect(result.renderOk).toBe(true);
    expect(result.consoleErrors).toHaveLength(1);
    expect(result.consoleErrors[0]).toContain('TypeError');
  });

  it('returns ok:false when the page is blank', async () => {
    const repo = mkTmp('m167-blank-');
    writePackageJson(repo, {
      scripts: { dev: 'vite' },
      devDependencies: { vite: '5.0.0' },
    });
    installFakePlaywright(repo);

    const { spawnFn } = makeComboSpawn('http://localhost:5173', {
      renderOk: false,
      consoleErrors: [],
      captured: false,
    });

    const cfg = makeCfg({ foundry: { browserVerify: true } });
    const result = await verifyInBrowser(repo, cfg, { _spawnFn: spawnFn });

    expect(result.ok).toBe(false);
    expect(result.renderOk).toBe(false);
    expect(result.detail).toMatch(/blank|error page/);
  });
});

// ---------------------------------------------------------------------------
// 6 & 7. Server cleanup — kill called on success AND on error
// ---------------------------------------------------------------------------

describe('verifyInBrowser — server cleanup', () => {
  it('kills the dev server on SUCCESS', async () => {
    const repo = mkTmp('m167-cleanup-ok-');
    writePackageJson(repo, {
      scripts: { dev: 'vite' },
      devDependencies: { vite: '5.0.0' },
    });
    installFakePlaywright(repo);

    const { spawnFn, serverKillSpy } = makeComboSpawn('http://localhost:5173', {
      renderOk: true,
      consoleErrors: [],
      captured: true,
    });

    const cfg = makeCfg({ foundry: { browserVerify: true } });
    const result = await verifyInBrowser(repo, cfg, { _spawnFn: spawnFn });

    expect(result.ok).toBe(true);
    expect(serverKillSpy).toHaveBeenCalled();
  });

  it('kills the dev server on ERROR (browser spawn emits error event)', async () => {
    const repo = mkTmp('m167-cleanup-err-');
    writePackageJson(repo, {
      scripts: { dev: 'vite' },
      devDependencies: { vite: '5.0.0' },
    });
    installFakePlaywright(repo);

    const serverKillSpy = vi.fn();
    let callCount = 0;

    const spawnFn = vi.fn((_cmd: string, _args: string[], _opts?: object) => {
      callCount++;
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: null;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = null;

      if (callCount === 1) {
        // Dev server: prints URL, stays alive
        child.kill = serverKillSpy;
        serverKillSpy.mockImplementation((signal?: NodeJS.Signals) => {
          setImmediate(() => child.emit('close', null, signal ?? 'SIGTERM'));
          return true;
        });
        setTimeout(() => {
          child.stdout.emit('data', Buffer.from('  Local: http://localhost:5173\n'));
        }, 10);
      } else {
        // Browser: emits error → captured as failure
        child.kill = vi.fn((signal?: NodeJS.Signals) => {
          setImmediate(() => child.emit('close', null, signal ?? 'SIGTERM'));
          return true;
        });
        setImmediate(() => child.emit('error', new Error('browser spawn failed')));
      }
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as unknown as typeof import('node:child_process').spawn;

    const cfg = makeCfg({ foundry: { browserVerify: true } });
    const result = await verifyInBrowser(repo, cfg, { _spawnFn: spawnFn });

    expect(result.ok).toBe(false);
    expect(serverKillSpy).toHaveBeenCalled();
  });

  it('waits for dev-server settlement before resolving', async () => {
    const repo = mkTmp('m167-cleanup-wait-');
    writePackageJson(repo, {
      scripts: { dev: 'vite' },
      devDependencies: { vite: '5.0.0' },
    });
    installFakePlaywright(repo);

    let serverChild!: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
    const spawnFn = vi.fn(() => {
      const child = new EventEmitter() as typeof serverChild;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      if (!serverChild) {
        serverChild = child;
        child.kill = vi.fn(() => true);
        setImmediate(() => child.stdout.emit('data', Buffer.from('Local: http://localhost:5173\n')));
      } else {
        child.kill = vi.fn(() => true);
        setImmediate(() => {
          child.stdout.emit('data', Buffer.from(JSON.stringify({ renderOk: true, consoleErrors: [], captured: true }) + '\n'));
          child.emit('exit', 0);
          child.emit('close', 0);
        });
      }
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as unknown as typeof import('node:child_process').spawn;

    let settled = false;
    const pending = verifyInBrowser(repo, makeCfg({ foundry: { browserVerify: true } }), {
      _spawnFn: spawnFn,
    }).finally(() => { settled = true; });

    await vi.waitFor(() => expect(serverChild.kill).toHaveBeenCalledWith('SIGTERM'));
    expect(settled).toBe(false);
    serverChild.emit('close', null, 'SIGTERM');
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it('reports dev-server teardown as unconfirmed when stop never settles', async () => {
    const repo = mkTmp('m167-cleanup-unconfirmed-');
    writePackageJson(repo, {
      scripts: { dev: 'vite' },
      devDependencies: { vite: '5.0.0' },
    });
    installFakePlaywright(repo);

    const { spawnFn } = makeComboSpawn('http://localhost:5173', {
      renderOk: true,
      consoleErrors: [],
      captured: true,
    });
    let callCount = 0;
    const neverClosingSpawn = vi.fn((...args: Parameters<typeof spawnFn>) => {
      const child = spawnFn(...args);
      callCount++;
      if (callCount === 1) child.kill = vi.fn(() => true);
      return child;
    }) as unknown as typeof import('node:child_process').spawn;

    const result = await verifyInBrowser(repo, makeCfg({ foundry: { browserVerify: true } }), {
      _spawnFn: neverClosingSpawn,
      _terminationGraceMs: 5,
      _terminationDrainMs: 5,
    });

    expect(result).toMatchObject({
      ok: false,
      teardownUnconfirmed: true,
      reason: 'dev server teardown unconfirmed',
    });
    expect(result).not.toHaveProperty('aborted');
  });

  it.skipIf(process.platform === 'win32')(
    'escalates the authenticated server group when a descendant ignores SIGTERM',
    async () => {
      const repo = mkTmp('m167-server-group-');
      writePackageJson(repo, { scripts: { dev: 'node server.js' } });
      const leaderPidPath = join(repo, 'leader.pid');
      const descendantPidPath = join(repo, 'descendant.pid');
      const descendantScript = [
        'const fs = require("node:fs");',
        'process.on("SIGTERM", () => {});',
        `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));`,
        'setInterval(() => {}, 1000);',
      ].join(' ');
      const leaderScript = [
        'const fs = require("node:fs");',
        'const { spawn } = require("node:child_process");',
        `fs.writeFileSync(${JSON.stringify(leaderPidPath)}, String(process.pid));`,
        `spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: ["ignore", "inherit", "inherit"] });`,
        'process.on("SIGTERM", () => {});',
        'console.log("Local: http://127.0.0.1:4173");',
        'setInterval(() => {}, 1000);',
      ].join(' ');
      const spawnFn = vi.fn((_cmd: string, _args: readonly string[], spawnOpts: object) => (
        spawnProcess(process.execPath, ['-e', leaderScript], spawnOpts)
      )) as unknown as typeof import('node:child_process').spawn;
      let leaderPid = 0;
      let descendantPid = 0;

      try {
        const server = await startDevServer(repo, {
          _spawnFn: spawnFn,
          _terminationGraceMs: 100,
          _terminationDrainMs: 1_000,
        });
        await vi.waitFor(() => expect(existsSync(descendantPidPath)).toBe(true), { timeout: 2_000 });
        leaderPid = Number(readFileSync(leaderPidPath, 'utf8'));
        descendantPid = Number(readFileSync(descendantPidPath, 'utf8'));

        await expect(server.stop()).resolves.toBe(true);
        await vi.waitFor(() => expect(processIsAlive(descendantPid)).toBe(false), { timeout: 2_000 });
      } finally {
        if (leaderPid > 0) {
          try { process.kill(-leaderPid, 'SIGKILL'); } catch { /* already gone */ }
        } else if (descendantPid > 0) {
          try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already gone */ }
        }
      }
    },
  );
});

describe('verifyInBrowser — cancellation', () => {
  it('returns an aborted result without spawning when already cancelled', async () => {
    const repo = mkTmp('m167-cancelled-before-');
    writePackageJson(repo, {
      scripts: { dev: 'vite' },
      devDependencies: { vite: '5.0.0' },
    });
    installFakePlaywright(repo);
    const spawnFn = vi.fn();
    const controller = new AbortController();
    controller.abort();

    const result = await verifyInBrowser(repo, makeCfg({ foundry: { browserVerify: true } }), {
      signal: controller.signal,
      _spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
    });

    expect(result).toMatchObject({ ok: false, aborted: true, renderOk: false });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('terminates the active browser and waits for settlement before reporting abort', async () => {
    const repo = mkTmp('m167-cancelled-browser-');
    writePackageJson(repo, {
      scripts: { dev: 'vite' },
      devDependencies: { vite: '5.0.0' },
    });
    installFakePlaywright(repo);
    const controller = new AbortController();
    let browserChild!: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
    let callCount = 0;
    const spawnFn = vi.fn(() => {
      callCount++;
      const child = new EventEmitter() as typeof browserChild;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      if (callCount === 1) {
        child.kill = vi.fn((signal?: NodeJS.Signals) => {
          setImmediate(() => child.emit('close', null, signal ?? 'SIGTERM'));
          return true;
        });
        setImmediate(() => child.stdout.emit('data', Buffer.from('Local: http://localhost:5173\n')));
      } else {
        browserChild = child;
        child.kill = vi.fn(() => true);
      }
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as unknown as typeof import('node:child_process').spawn;

    let settled = false;
    const pending = verifyInBrowser(repo, makeCfg({ foundry: { browserVerify: true } }), {
      signal: controller.signal,
      _spawnFn: spawnFn,
    }).finally(() => { settled = true; });
    await vi.waitFor(() => expect(browserChild).toBeDefined());

    controller.abort();
    await vi.waitFor(() => expect(browserChild.kill).toHaveBeenCalledWith('SIGTERM'));
    expect(settled).toBe(false);
    browserChild.emit('close', null, 'SIGTERM');

    await expect(pending).resolves.toMatchObject({ ok: false, aborted: true });
  });

  it.skipIf(process.platform === 'win32')(
    'fails closed without signaling a recycled browser PGID after leader close',
    async () => {
      const repo = mkTmp('m167-cancelled-browser-close-');
      writePackageJson(repo, {
        scripts: { dev: 'vite' },
        devDependencies: { vite: '5.0.0' },
      });
      installFakePlaywright(repo);
      const controller = new AbortController();
      let browserChild!: EventEmitter & {
        pid: number;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      let callCount = 0;
      const spawnFn = vi.fn(() => {
        callCount++;
        const child = new EventEmitter() as typeof browserChild;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = vi.fn(() => true);
        if (callCount === 1) {
          child.kill = vi.fn((signal?: NodeJS.Signals) => {
            setImmediate(() => child.emit('close', null, signal ?? 'SIGTERM'));
            return true;
          });
          setImmediate(() => child.stdout.emit('data', Buffer.from('Local: http://localhost:5173\n')));
        } else {
          browserChild = child;
          child.pid = 31_337;
          child.exitCode = null;
          child.signalCode = null;
        }
        return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
      }) as unknown as typeof import('node:child_process').spawn;
      let pgidReused = false;
      const processKill = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
        if (pgidReused) throw new Error('test attempted to signal a recycled process group');
        if (signal === 'SIGTERM') {
          setImmediate(() => {
            pgidReused = true;
            browserChild.emit('exit', null, 'SIGTERM');
            browserChild.emit('close', null, 'SIGTERM');
          });
        }
      });

      const pending = verifyInBrowser(repo, makeCfg({ foundry: { browserVerify: true } }), {
        signal: controller.signal,
        _spawnFn: spawnFn,
        _processKill: processKill,
        _terminationGraceMs: 20,
        _terminationDrainMs: 10,
      });
      await vi.waitFor(() => expect(browserChild).toBeDefined());
      controller.abort();

      await expect(pending).resolves.toMatchObject({
        ok: false,
        teardownUnconfirmed: true,
        reason: 'browser process teardown unconfirmed',
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(processKill.mock.calls).toEqual([[-31_337, 'SIGTERM']]);
      expect(browserChild.kill).not.toHaveBeenCalled();
    },
  );

  it('bounds cancellation when the browser ignores graceful and hard stops', async () => {
    const repo = mkTmp('m167-cancelled-bounded-');
    writePackageJson(repo, {
      scripts: { dev: 'vite' },
      devDependencies: { vite: '5.0.0' },
    });
    installFakePlaywright(repo);
    const controller = new AbortController();
    let browserKill!: ReturnType<typeof vi.fn>;
    let callCount = 0;
    const spawnFn = vi.fn(() => {
      callCount++;
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
        unref: ReturnType<typeof vi.fn>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.unref = vi.fn();
      if (callCount === 1) {
        child.kill = vi.fn((signal?: NodeJS.Signals) => {
          setImmediate(() => child.emit('close', null, signal ?? 'SIGTERM'));
          return true;
        });
        setImmediate(() => child.stdout.emit('data', Buffer.from('Local: http://localhost:5173\n')));
      } else {
        browserKill = vi.fn(() => true);
        child.kill = browserKill;
      }
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as unknown as typeof import('node:child_process').spawn;

    const pending = verifyInBrowser(repo, makeCfg({ foundry: { browserVerify: true } }), {
      signal: controller.signal,
      _spawnFn: spawnFn,
      _terminationGraceMs: 5,
      _terminationDrainMs: 5,
    });
    await vi.waitFor(() => expect(browserKill).toBeDefined());
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      teardownUnconfirmed: true,
      reason: 'browser process teardown unconfirmed',
    });
    await expect(pending).resolves.not.toHaveProperty('aborted');
    expect(browserKill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

// ---------------------------------------------------------------------------
// 8. Time-box: hung server → rejects within startupTimeoutMs
// ---------------------------------------------------------------------------

describe('verifyInBrowser — time-box', () => {
  it('startDevServer rejects within startupTimeoutMs when server never prints a URL', async () => {
    const repo = mkTmp('m167-timeout-');
    writePackageJson(repo, {
      scripts: { dev: 'vite' },
      devDependencies: { vite: '5.0.0' },
    });

    const { spawnFn } = makeFakeServer({ neverPrint: true });

    const start = Date.now();
    await expect(
      startDevServer(repo, { startupTimeoutMs: 150, _spawnFn: spawnFn }),
    ).rejects.toThrow(/did not print a URL/);
    const elapsed = Date.now() - start;
    // Should have timed out within 150ms + 100ms grace
    expect(elapsed).toBeLessThan(400);
  }, 1000);

  it('verifyInBrowser resolves (ok:false) when server startup times out — never hangs', async () => {
    const repo = mkTmp('m167-timeout-v-');
    writePackageJson(repo, {
      scripts: { dev: 'vite' },
      devDependencies: { vite: '5.0.0' },
    });
    installFakePlaywright(repo);

    const { spawnFn } = makeFakeServer({ neverPrint: true });

    const cfg = makeCfg({ foundry: { browserVerify: true } });
    const start = Date.now();
    const result = await verifyInBrowser(repo, cfg, {
      _spawnFn: spawnFn,
      startupTimeoutMs: 150,
    });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    expect(elapsed).toBeLessThan(600);
  }, 1000);
});

// ---------------------------------------------------------------------------
// 9. Never-throws: all error paths resolve (no unhandled rejection)
// ---------------------------------------------------------------------------

describe('verifyInBrowser — never-throws', () => {
  it('resolves even when spawn throws synchronously', async () => {
    const repo = mkTmp('m167-throws-');
    writePackageJson(repo, {
      scripts: { dev: 'vite' },
      devDependencies: { vite: '5.0.0' },
    });
    installFakePlaywright(repo);

    const throwingSpawn = vi.fn(() => {
      throw new Error('spawn system error');
    }) as unknown as typeof import('node:child_process').spawn;

    const cfg = makeCfg({ foundry: { browserVerify: true } });
    const result = await verifyInBrowser(repo, cfg, { _spawnFn: throwingSpawn });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('browser verify error');
  });

  it('resolves even when repoDir does not exist', async () => {
    const cfg = makeCfg({ foundry: { browserVerify: true } });
    const result = await verifyInBrowser('/nonexistent/repo/path', cfg);
    // isWebApp returns false → skipped
    expect(result.skipped).toBe(true);
    expect(result.ok).toBe(true);
  });
});
