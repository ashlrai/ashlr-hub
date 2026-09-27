/**
 * 3.14 — no request can freeze the Verse sidecar behind a macOS privacy prompt.
 *
 * #518 found the root cause of the 3.13.0 stall: macOS parks any SYNCHRONOUS
 * fs or child-process call into ~/Desktop, ~/Documents, ~/Downloads (and
 * removable/network volumes) until the operator answers a consent prompt, and
 * the sidecar serves every route from one thread. This file pins the request
 * paths that still reached project folders synchronously:
 *
 *   1. EQUIVALENCE. Every async twin gives exactly the synchronous answer:
 *      git status / origin authority / default branch, the path guard, the
 *      enrollment identity, workspace root rows and store mutations, the
 *      handoff note, the MCP config registry, the Locus probe.
 *   2. THE LOOP STAYS FREE. The real server answers /api/health while
 *      GET /api/verse/workspaces waits on a `git` that takes a second per call
 *      (the shape of a git parked behind a prompt), and a stuck folder check
 *      never stops timers.
 *   3. WHY SPAWN NEEDS A PROBE. A child's cwd is entered inside the spawn call
 *      itself — its failure is known before spawn() returns — so a cwd behind
 *      a pending prompt would park the caller; routes probe the folder first.
 *
 * HOME is relocated per test; nothing here reaches the real ~/.ashlr.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AshlrConfig } from '../src/core/types.js';
import {
  defaultBranch,
  defaultBranchAsync,
  getGitStatus,
  getGitStatusAsync,
  isRepo,
  isRepoAsync,
  resolveGitHubOriginAuthority,
  resolveGitHubOriginAuthorityAsync,
} from '../src/core/git.js';
import {
  canonicalFilesystemPathIdentity,
  canonicalFilesystemPathIdentityAsync,
  isEnrolled,
  isEnrolledAsync,
} from '../src/core/sandbox/policy.js';
import {
  checkGuardedPath,
  checkGuardedPathAsync,
  ENROLLMENT_PHRASING,
  physicalPath,
  physicalPathAsync,
  WORKSPACE_ROOT_PHRASING,
} from '../src/core/verse/path-guard.js';
import {
  createVerseWorkspaceStore,
  describeRoots,
  describeRootsAsync,
  resolveWorkspaceRoots,
  resolveWorkspaceRootsAsync,
  type RootFacts,
} from '../src/core/verse/workspaces.js';
import { buildHandoffPreview, buildHandoffPreviewAsync, defaultGitDiffStat } from '../src/core/verse/session-handoff.js';
import { discoverMcpServers, discoverMcpServersAsync, resetMcpRegistryCache } from '../src/core/mcp-registry.js';
import { locusAgentReport, locusAgentReportAsync, resetLocusAvailabilityCache } from '../src/core/integrations/locus.js';
import { resourceQuotaRefreshLeaseLooksHeld } from '../src/core/resources/quota-refresh-lease.js';
import { resetVerseWorkspaceStore } from '../src/core/verse/verse-api.js';
import type { VerseEvent, VerseSession } from '../src/core/verse/types.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

const REAL_GIT = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync(REAL_GIT, ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

let tmp: string;
let prevHome: string | undefined;
let prevPath: string | undefined;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-async-folder-314-')));
  prevHome = process.env.HOME;
  prevPath = process.env.PATH;
  process.env.HOME = path.join(tmp, 'home');
  fs.mkdirSync(path.join(tmp, 'home', '.ashlr'), { recursive: true, mode: 0o700 });
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevPath === undefined) delete process.env.PATH; else process.env.PATH = prevPath;
  resetVerseWorkspaceStore(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Repos in the shapes the git helpers distinguish. */
function makeRepos(): Record<string, string> {
  const base = path.join(tmp, 'repos');
  fs.mkdirSync(base, { recursive: true });
  const upstream = path.join(base, 'upstream.git');
  gitIn(base, 'init', '--bare', '-q', '-b', 'main', upstream);

  const clean = path.join(base, 'clean');
  gitIn(base, 'init', '-q', '-b', 'main', clean);
  fs.writeFileSync(path.join(clean, 'a.txt'), 'a\n');
  gitIn(clean, 'add', '.');
  gitIn(clean, 'commit', '-q', '-m', 'one');
  gitIn(clean, 'remote', 'add', 'origin', 'https://github.com/Example-Org/Some.Repo.git');

  const tracking = path.join(base, 'tracking');
  gitIn(base, 'clone', '-q', upstream, tracking);
  fs.writeFileSync(path.join(tracking, 'b.txt'), 'b\n');
  gitIn(tracking, 'add', '.');
  gitIn(tracking, 'commit', '-q', '-m', 'first');
  gitIn(tracking, 'push', '-q', 'origin', 'HEAD:main');
  gitIn(tracking, 'fetch', '-q', 'origin');
  gitIn(tracking, 'branch', '-q', '--set-upstream-to=origin/main');
  fs.writeFileSync(path.join(tracking, 'c.txt'), 'c\n');
  gitIn(tracking, 'add', '.');
  gitIn(tracking, 'commit', '-q', '-m', 'ahead');
  fs.writeFileSync(path.join(tracking, 'dirty.txt'), 'dirty\n');
  fs.writeFileSync(path.join(tracking, 'b.txt'), 'changed\n');

  const detached = path.join(base, 'detached');
  gitIn(base, 'clone', '-q', clean, detached);
  gitIn(detached, 'checkout', '-q', '--detach');
  gitIn(detached, 'config', 'url.https://example.invalid/.insteadOf', 'https://github.com/');

  const worktree = path.join(base, 'worktree');
  gitIn(clean, 'worktree', 'add', '-q', '-b', 'side', worktree);

  const unborn = path.join(base, 'unborn');
  gitIn(base, 'init', '-q', unborn);

  const plain = path.join(base, 'plain');
  fs.mkdirSync(plain);
  const file = path.join(base, 'file.txt');
  fs.writeFileSync(file, 'not a dir');
  return { clean, tracking, detached, worktree, unborn, plain, file, missing: path.join(base, 'missing') };
}

describe('async twins give exactly the synchronous answer', () => {
  it('git: status, origin authority, default branch, isRepo', async () => {
    const repos = makeRepos();
    for (const [name, repo] of Object.entries(repos)) {
      expect(await isRepoAsync(repo), name).toBe(isRepo(repo));
      expect(await getGitStatusAsync(repo), name).toEqual(getGitStatus(repo));
      expect(await resolveGitHubOriginAuthorityAsync(repo), name).toBe(resolveGitHubOriginAuthority(repo));
      expect(await defaultBranchAsync(repo), name).toBe(defaultBranch(repo));
    }
    // The shapes really differ, so the comparison above means something.
    expect(getGitStatus(repos.tracking!)).toMatchObject({ branch: 'main', ahead: 1, behind: 0 });
    expect(getGitStatus(repos.tracking!)!.dirty).toBeGreaterThanOrEqual(2);
    expect(getGitStatus(repos.detached!)!.branch).toBe('HEAD');
    expect(resolveGitHubOriginAuthority(repos.clean!)).toBe('example-org/some.repo');
    expect(resolveGitHubOriginAuthority(repos.detached!)).toBeNull(); // insteadOf rule: fail closed
    expect(getGitStatus(repos.plain!)).toBeNull();
    expect(getGitStatus(repos.worktree!)!.branch).toBe('side');
  });

  it('the path guard: every refusal and every answer, both phrasings', async () => {
    const home = process.env.HOME!;
    const dir = path.join(tmp, 'project');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(tmp, 'a-file'), 'x');
    fs.symlinkSync(dir, path.join(tmp, 'link-to-project'));
    fs.symlinkSync(path.join(home, '.ashlr'), path.join(tmp, 'link-to-ashlr'));
    const cases = [
      '', 'relative/path', `${dir}\0x`, `/${'a'.repeat(5000)}`, '/', home, path.dirname(home),
      path.join(home, '.ashlr'), path.join(home, '.ashlr', 'x'), path.join(home, '.codex', 'artifacts', 'y'),
      dir, `${dir}/`, path.join(tmp, 'link-to-project'), path.join(tmp, 'link-to-ashlr'),
      path.join(tmp, 'a-file'), path.join(tmp, 'nope'), '~', '~/somewhere',
    ];
    for (const raw of cases) {
      for (const requireDirectory of [true, false]) {
        for (const phrasing of [ENROLLMENT_PHRASING, WORKSPACE_ROOT_PHRASING]) {
          const opts = { requireDirectory, phrasing };
          expect(await checkGuardedPathAsync(raw, opts), `${raw} ${requireDirectory}`).toEqual(checkGuardedPath(raw, opts));
        }
      }
      expect(await physicalPathAsync(raw || '/nonexistent')).toBe(physicalPath(raw || '/nonexistent'));
    }
  });

  it('the enrollment identity and isEnrolled', async () => {
    const dir = path.join(tmp, 'id');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'f'), 'x');
    fs.symlinkSync(path.join(dir, 'sub'), path.join(dir, 'link'));
    const cases = [
      dir, `${dir}/sub`, `${dir}/link`, `${dir}/missing`, `${dir}/missing/deeper`, `${dir}/f/under-a-file`,
      `${dir}/link/missing`, 'relative', '/', `${dir}/sub/../f`,
    ];
    for (const value of cases) {
      for (const foldWindowsCase of [true, false]) {
        expect(await canonicalFilesystemPathIdentityAsync(value, { foldWindowsCase }), value)
          .toBe(canonicalFilesystemPathIdentity(value, { foldWindowsCase }));
      }
      expect(await isEnrolledAsync(value), value).toBe(isEnrolled(value));
    }
  });

  it('workspace root rows, root resolution and the store mutations', async () => {
    const repos = makeRepos();
    const roots = [repos.tracking!, repos.plain!, repos.missing!, repos.clean!, repos.tracking!];
    for (const engine of [undefined, 'claude', 'grok']) {
      const opts = engine === undefined ? {} : { engine };
      expect(await describeRootsAsync(roots, opts)).toEqual(describeRoots(roots, opts));
    }

    // A path listed twice (or shared across workspaces through `memo`) is examined once.
    let checks = 0;
    const memo = new Map<string, Promise<RootFacts>>();
    const counting = { isDirectory: async () => { checks += 1; return true; }, isEnrolled: async () => false, gitIdentity: async () => null };
    await describeRootsAsync([repos.plain!, repos.plain!], { memo }, counting);
    await describeRootsAsync([repos.plain!], { memo }, counting);
    expect(checks).toBe(1);

    const valid = [repos.clean!, `${repos.clean!}/`, repos.plain!];
    expect(await resolveWorkspaceRootsAsync(valid)).toEqual(resolveWorkspaceRoots(valid));
    for (const bad of [[], [repos.missing!], [repos.file!], [process.env.HOME!], new Array(9).fill(repos.plain!)]) {
      const sync = (() => { try { return resolveWorkspaceRoots(bad); } catch (e) { return (e as Error).message; } })();
      const asyncAnswer = await resolveWorkspaceRootsAsync(bad).catch((e: Error) => e.message);
      expect(asyncAnswer).toEqual(sync);
    }

    const fixed = () => new Date('2026-09-26T00:00:00.000Z');
    const syncStore = createVerseWorkspaceStore({ root: path.join(tmp, 'ws-sync'), now: fixed });
    const asyncStore = createVerseWorkspaceStore({ root: path.join(tmp, 'ws-async'), now: fixed });
    const a = syncStore.create('Pair', [repos.clean!, repos.plain!], true);
    const b = await asyncStore.createAsync('Pair', [repos.clean!, repos.plain!], true);
    expect({ ...b, id: a.id }).toEqual(a);
    const errorOf = async (work: () => unknown): Promise<string> => {
      try { await work(); return 'no error'; } catch (e) { return (e as Error).message; }
    };
    expect(await errorOf(() => asyncStore.createAsync('  ', [repos.clean!]))).toBe(await errorOf(() => syncStore.create('  ', [repos.clean!])));
    expect(await errorOf(() => asyncStore.createAsync('X', [repos.missing!]))).toBe(await errorOf(() => syncStore.create('X', [repos.missing!])));
    expect(await errorOf(() => asyncStore.updateAsync('nope', { roots: [repos.missing!] })))
      .toBe(await errorOf(() => syncStore.update('nope', { roots: [repos.missing!] })));
    expect(await errorOf(() => asyncStore.updateAsync(b.id, { name: '', roots: [repos.missing!] })))
      .toBe(await errorOf(() => syncStore.update(a.id, { name: '', roots: [repos.missing!] })));
    const ua = syncStore.update(a.id, { roots: [repos.tracking!], section: false });
    const ub = await asyncStore.updateAsync(b.id, { roots: [repos.tracking!], section: false });
    expect({ ...ub, id: ua.id }).toEqual(ua);
    expect(await asyncStore.setPriorityAsync(repos.clean!, 'high')).toEqual(syncStore.setPriority(repos.clean!, 'high'));
    expect(await errorOf(() => asyncStore.setPriorityAsync(repos.missing!, 'high')))
      .toBe(await errorOf(() => syncStore.setPriority(repos.missing!, 'high')));
  });

  it('the handoff note (git diff --stat per root)', async () => {
    const repos = makeRepos();
    const session = {
      id: 'src-1', title: 'T', projectPath: repos.tracking!, extraRoots: [repos.plain!, repos.clean!],
      engine: 'claude', accountId: 'a', seatId: 'a', model: 'm', nativeSessionId: 'n',
      createdAt: '2026-09-20T10:00:00.000Z', updatedAt: '2026-09-20T10:00:00.000Z', status: 'idle', turnCount: 1,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0, contextWindow: null },
      lastError: null,
    } as unknown as VerseSession;
    const events = [{ seq: 1, at: '2026-09-20T10:00:00.000Z', turnId: 't', type: 'user', text: 'do the thing' }] as unknown as VerseEvent[];
    expect(defaultGitDiffStat(repos.tracking!)).toContain('b.txt');
    expect(await buildHandoffPreviewAsync(session, events, { focus: 'x' })).toEqual(buildHandoffPreview(session, events, { focus: 'x' }));
    // An injected stat keeps the synchronous path, unchanged.
    const injected = { gitDiffStat: () => 'stat' };
    expect(await buildHandoffPreviewAsync(session, events, injected)).toEqual(buildHandoffPreview(session, events, injected));
  });

  it('the MCP config registry: same servers, and an unchanged file is not re-parsed', async () => {
    resetMcpRegistryCache();
    const files = [path.join(tmp, 'claude.json'), path.join(tmp, 'settings.json'), path.join(tmp, 'broken.json'), path.join(tmp, 'absent.json')];
    fs.writeFileSync(files[0]!, JSON.stringify({
      mcpServers: { one: { command: 'a', args: ['1'], env: { K: 'v' } } },
      projects: { '/p': { mcpServers: { two: { command: 'b', args: [] } } } },
    }));
    fs.writeFileSync(files[1]!, JSON.stringify({ mcpServers: { one: { command: 'shadowed', args: [] }, three: { command: 'c' } } }));
    fs.writeFileSync(files[2]!, '{nope');
    expect(await discoverMcpServersAsync(files)).toEqual(discoverMcpServers(files));
    const cached = await discoverMcpServersAsync(files);
    expect(cached).toEqual(discoverMcpServers(files));
    // A caller mutating its copy never poisons the cache.
    cached.servers[0]!.args.push('mutated');
    expect(await discoverMcpServersAsync(files)).toEqual(discoverMcpServers(files));
    // A changed file is read again.
    fs.writeFileSync(files[1]!, JSON.stringify({ mcpServers: { four: { command: 'd', args: ['x', 'y'] } } }));
    expect(await discoverMcpServersAsync(files)).toEqual(discoverMcpServers(files));
    expect((await discoverMcpServersAsync(files)).servers.map((s) => s.name)).toContain('four');
  });

  it.skipIf(process.platform === 'win32')('the Locus probe: report, failure and missing binary', async () => {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    const locus = path.join(bin, 'locus');
    const report = JSON.stringify({ ready: true, status: 'ready', status_oneline: 'locus ok', next_steps: [] });
    for (const script of [
      `#!/bin/sh\necho '${report}'\n`,
      '#!/bin/sh\necho "not pinned" >&2\nexit 2\n',
      '#!/bin/sh\necho "{broken"\n',
    ]) {
      fs.writeFileSync(locus, script, { mode: 0o755 });
      process.env.PATH = `${bin}:/usr/bin:/bin`;
      resetLocusAvailabilityCache();
      expect(await locusAgentReportAsync()).toEqual(locusAgentReport());
    }
    fs.rmSync(locus);
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    resetLocusAvailabilityCache();
    expect(await locusAgentReportAsync()).toEqual(locusAgentReport());
    expect((await locusAgentReportAsync()).available).toBe(false);
  });
});

describe('the event loop stays free while project folders are slow', () => {
  function get(port: number, urlPath: string, headers: Record<string, string>): Promise<{ status: number; body: string; ms: number }> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: 'GET', headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - started }));
      });
      req.setTimeout(20_000, () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });
  }

  it.skipIf(process.platform === 'win32')('GET /api/verse/workspaces waits on a slow git; /api/health does not wait on it', async () => {
    const repos = makeRepos();
    // Workspaces are created with the REAL git on PATH, and the synchronous
    // answer is taken as the reference before git becomes slow.
    const store = createVerseWorkspaceStore();
    const ws = store.create('Slow', [repos.tracking!, repos.plain!]);
    const reference = describeRoots(ws.roots.map((r) => r.path));

    // Every git call now takes a second — a git parked behind a prompt.
    const bin = path.join(tmp, 'slow-bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nsleep 1\nexec '${REAL_GIT}' "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${prevPath ?? '/usr/bin:/bin'}`;
    resetVerseWorkspaceStore(null);

    const cfg = {
      version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [],
      models: { lmstudio: 'http://127.0.0.1:1', ollama: 'http://127.0.0.1:1', providerChain: ['ollama'] },
      telemetry: {}, tools: {},
    } as unknown as AshlrConfig;
    const handle = await startServer(cfg, { port: 0, open: false, allowDispatch: true });
    try {
      const auth = readAuthHeaders(handle.port);
      const workspaces = get(handle.port, '/api/verse/workspaces', auth);
      await new Promise((r) => setTimeout(r, 150)); // the first git calls are in flight
      const health = await get(handle.port, '/api/health', auth);
      expect(health.status).toBe(200);
      expect(health.ms).toBeLessThan(700);
      const slow = await workspaces;
      expect(slow.status).toBe(200);
      expect(slow.ms).toBeGreaterThan(health.ms);
      const body = JSON.parse(slow.body) as { status: Record<string, unknown> };
      // Same rows as the synchronous describeRoots, through sanitizePublicJson's `~`.
      const home = process.env.HOME!;
      expect(JSON.parse(JSON.stringify(body.status[ws.id]).replaceAll('~', home))).toEqual(JSON.parse(JSON.stringify(reference)));
    } finally {
      await handle.close();
    }
  }, 30_000);

  it('a stuck folder check never stops timers (describeRootsAsync)', async () => {
    let release!: (value: boolean) => void;
    const stuck = new Promise<boolean>((resolve) => { release = resolve; });
    let settled = false;
    const rows = describeRootsAsync(['/guarded/project'], {}, {
      isDirectory: () => stuck,
      isEnrolled: async () => false,
      gitIdentity: async () => null,
    }).then((r) => { settled = true; return r; });
    const fired = await new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 20));
    expect(fired).toBe(true);
    expect(settled).toBe(false);
    release(true);
    expect((await rows)[0]).toMatchObject({ path: '/guarded/project', exists: true, primary: true });
  });
});

describe('why a spawn in a project folder is probed first', () => {
  it.skipIf(process.platform === 'win32')('the cwd is entered inside the spawn call: its failure is known before spawn() returns', async () => {
    // No pid: the chdir already failed, synchronously, inside spawn(). A chdir
    // held by a pending privacy prompt would hold spawn() — and the event loop
    // with it — the same way. (Bun.spawn behaves alike: it throws ENOENT
    // synchronously.) Hence probeFolderAccess before any spawn with such a cwd,
    // and `git -C <dir>` with a neutral cwd where git allows it.
    const child = spawn('/bin/echo', ['x'], { cwd: path.join(tmp, 'does-not-exist') });
    expect(child.pid).toBeUndefined();
    await new Promise<void>((resolve) => child.on('error', () => resolve()));
  });
});

describe('the account lease retry skips an attempt it would lose', () => {
  it('reads the lock owner without the lock machinery: live foreign owner → held; own pid, dead pid, no lock → not', async () => {
    const root = path.join(tmp, 'ledger');
    fs.mkdirSync(root, { mode: 0o700 });
    const lock = path.join(root, '.resource-quota-refresh.lock');
    expect(await resourceQuotaRefreshLeaseLooksHeld(root)).toBe(false);
    const sleeper = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: sleeper.pid, token: 't' }), { mode: 0o600 });
      expect(await resourceQuotaRefreshLeaseLooksHeld(root)).toBe(true);
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 't' }), { mode: 0o600 });
      expect(await resourceQuotaRefreshLeaseLooksHeld(root)).toBe(false);
    } finally {
      sleeper.kill('SIGKILL');
    }
    await new Promise((r) => sleeper.once('exit', r));
    fs.writeFileSync(lock, JSON.stringify({ pid: sleeper.pid, token: 't' }), { mode: 0o600 });
    expect(await resourceQuotaRefreshLeaseLooksHeld(root)).toBe(false);
    fs.writeFileSync(lock, 'garbage');
    expect(await resourceQuotaRefreshLeaseLooksHeld(root)).toBe(false);
  });
});
