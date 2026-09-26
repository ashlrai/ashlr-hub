/**
 * 3.13 sidecar startup stall: `ashlr verse` must answer GET /verse/ at once,
 * whatever the Apps warm-up (and the login shell under it) is doing.
 *
 * The REAL server boots under a relocated HOME with a throwaway public dir.
 * The Apps warm-up runs the REAL probe runner against a fake "zsh" that hangs
 * and whose background job holds stdout open — the shape of a startup file
 * that never finishes. The page must be served while that probe is pending,
 * and the probe must still come back as a fallback within its timeout, with
 * the hung shell and its job killed.
 *
 * Root cause of the 3.13.0 stall (unified log, 2026-09-26 15:40:38–15:43:34):
 * a macOS privacy (TCC) consent prompt for a protected folder was raised as
 * the probe's zsh sourced a startup file under ~/Desktop, and the sidecar's
 * MAIN thread then touched a project folder there synchronously, parking the
 * whole event loop behind the unanswered dialog. So the page-load route that
 * reads project folders (bootstrap → project discovery) must do that I/O off
 * the loop: a pending directory check must not stop timers or other requests.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startVerseBackgroundServices } from '../src/cli/verse.js';
import type { AshlrConfig } from '../src/core/types.js';
import { createShellRunner, probeLoginPath, type LoginPathResult } from '../src/core/verse/login-path.js';
import { discoverProjects, discoverProjectsAsync } from '../src/core/verse/projects.js';
import { startServer } from '../src/core/web/server.js';

function get(port: number, urlPath: string, timeoutMs: number): Promise<{ status: number; body: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: 'GET', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - started }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end();
  });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function makeConfig(accountsRoot: string): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: 'http://127.0.0.1:1', ollama: 'http://127.0.0.1:1', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
    verse: { accountsRoot },
  } as unknown as AshlrConfig;
}

describe.skipIf(process.platform === 'win32')('ashlr verse startup — /verse/ never waits on the login shell', () => {
  let tmp: string;
  let prevHome: string | undefined;
  let prevPublic: string | undefined;
  const closers: Array<() => Promise<void> | void> = [];

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-stall-313-')));
    prevHome = process.env.HOME;
    prevPublic = process.env.ASHLR_WEB_PUBLIC;
    process.env.HOME = tmp;
    const pub = path.join(tmp, 'public');
    fs.mkdirSync(path.join(pub, 'next'), { recursive: true });
    fs.writeFileSync(path.join(pub, 'next', 'index.html'), '<!doctype html><title>Verse</title>');
    process.env.ASHLR_WEB_PUBLIC = pub;
  });

  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) { try { await close(); } catch { /* ignore */ } }
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevPublic === undefined) delete process.env.ASHLR_WEB_PUBLIC; else process.env.ASHLR_WEB_PUBLIC = prevPublic;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('serves /verse/ while the Apps warm-up is stuck behind a hung login shell, and the probe still falls back in time', async () => {
    // A "zsh" whose startup never finishes: a background job inherits stdout
    // and the shell itself waits on it. Both pids are written down so the
    // test can prove they were killed.
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    const fakeZsh = path.join(bin, 'zsh');
    const pids = path.join(tmp, 'probe.pids');
    fs.writeFileSync(fakeZsh, `#!/bin/sh\nsleep 30 &\necho "$$ $!" > '${pids}'\nwait\n`, { mode: 0o755 });

    const accountsRoot = path.join(tmp, '.ashlr', 'account-connections');
    fs.mkdirSync(accountsRoot, { recursive: true });
    const cfg = makeConfig(accountsRoot);
    const handle = await startServer(cfg, { port: 0, open: false, allowDispatch: true });
    closers.push(() => handle.close());

    let probe: Promise<LoginPathResult> | null = null;
    const services = await startVerseBackgroundServices(cfg, {
      accountServices: false,
      loadClaudeUsage: async () => ({ primeClaudeUsage: async () => {} }),
      loadReasoning: async () => ({ scheduleReasoningMaintenance: () => {}, resetReasoningApiState: () => {} }),
      loadApps: async () => ({
        warmVerseApps: () => {
          probe = probeLoginPath({
            runShell: createShellRunner(),
            env: { SHELL: fakeZsh, PATH: '/usr/bin:/bin' },
            home: tmp,
            isDirectory: () => false,
            timeoutMs: 1_500,
          });
          return probe.then(() => undefined);
        },
      }),
    });
    closers.push(() => services.stop());
    expect(services.started).toContain('apps');
    expect(probe).not.toBeNull();

    // The warm-up is pending (the fake shell is hung) …
    let settled = false;
    void probe!.then(() => { settled = true; });
    for (let i = 0; i < 50 && !fs.existsSync(pids); i++) await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    // … and the page is served anyway, promptly.
    const page = await get(handle.port, '/verse/', 1_000);
    expect(page.status).toBe(200);
    expect(page.body).toContain('<title>Verse</title>');
    expect(page.ms).toBeLessThan(1_000);
    const health = await get(handle.port, '/api/health', 1_000);
    expect(health.status).toBe(200);
    expect(settled).toBe(false);

    // The probe resolves as a fallback within its timeout, and the hung shell
    // and the job holding its stdout are both gone.
    const started = Date.now();
    const result = await probe!;
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(result.source).toBe('fallback');
    expect(result.fallbackReason).toBe('login shell timed out after 1500 ms');
    const [shellPid, jobPid] = fs.readFileSync(pids, 'utf8').trim().split(/\s+/).map(Number);
    await new Promise((r) => setTimeout(r, 50));
    expect(alive(shellPid!)).toBe(false);
    expect(alive(jobPid!)).toBe(false);
  }, 15_000);
});

describe('project discovery for the page-load route never parks the event loop', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-projects-313-'))); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('gives exactly the synchronous answer: order, de-duplication, enrolled flag, filters', async () => {
    const a = path.join(tmp, 'a'); const b = path.join(tmp, 'b'); const c = path.join(tmp, 'c');
    const artifacts = path.join(tmp, 'artifacts'); const scratch = path.join(artifacts, 'x');
    for (const d of [a, b, c, scratch]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'file'), 'not a dir');
    const enrollment = path.join(tmp, 'enrollment.json');
    fs.writeFileSync(enrollment, JSON.stringify({ repos: [b, path.join(tmp, 'gone'), a, b, '', scratch] }));
    const sessions = [c, a, `${c}/`, path.join(tmp, 'file'), ''].map((projectPath) => ({ projectPath }));
    const opts = { enrollmentPath: enrollment, sessions, artifactsRoot: artifacts };

    const sync = discoverProjects(opts);
    const asyncAnswer = await discoverProjectsAsync(opts);
    expect(asyncAnswer).toEqual(sync);
    expect(asyncAnswer.map((p) => [path.basename(p.path), p.enrolled])).toEqual([['b', true], ['a', true], ['c', false]]);

    // A missing or malformed registry is "no enrolled repos", as before.
    fs.writeFileSync(enrollment, '{not json');
    expect(await discoverProjectsAsync(opts)).toEqual(discoverProjects(opts));
    const none = { ...opts, enrollmentPath: path.join(tmp, 'none.json') };
    expect(await discoverProjectsAsync(none)).toEqual(discoverProjects(none));
  });

  it('keeps timers and other work running while a directory check is stuck (a pending consent prompt)', async () => {
    const enrollment = path.join(tmp, 'enrollment.json');
    fs.writeFileSync(enrollment, JSON.stringify({ repos: [path.join(tmp, 'guarded')] }));
    let release!: (value: boolean) => void;
    const stuck = new Promise<boolean>((resolve) => { release = resolve; });
    let settled = false;
    const discovery = discoverProjectsAsync({
      enrollmentPath: enrollment,
      sessions: [],
      artifactsRoot: path.join(tmp, 'artifacts'),
      isDirectory: () => stuck,
    }).then((projects) => { settled = true; return projects; });

    // The loop is free: a timer fires while the check is still pending.
    const fired = await new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 20));
    expect(fired).toBe(true);
    expect(settled).toBe(false);

    release(true);
    expect(await discovery).toEqual([{ path: path.join(tmp, 'guarded'), name: 'guarded', enrolled: true }]);
  });

  it('treats a check that rejects as "not a directory" (never throws)', async () => {
    const enrollment = path.join(tmp, 'enrollment.json');
    fs.writeFileSync(enrollment, JSON.stringify({ repos: [path.join(tmp, 'x')] }));
    await expect(discoverProjectsAsync({
      enrollmentPath: enrollment,
      isDirectory: () => Promise.reject(new Error('EPERM')),
    })).resolves.toEqual([]);
  });
});
