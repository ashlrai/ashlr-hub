/**
 * Tests for the Verse V2 control plane (src/core/verse/control-api.ts) through
 * the REAL server (test/helpers/authenticated-web-server.ts), under a
 * relocated HOME. Real loopback bind → real-io lane.
 *
 * Covers: the /api/verse/control aggregate shape and its freedom from
 * secret-shaped strings, the caps round trip and its rejections, scope
 * enroll/unenroll with the traversal + codex-artifacts refusals, audit
 * capping/filtering, and the full refusal ladder on the most dangerous route
 * in the build — POST /api/verse/daemon.
 *
 * SAFETY: HOME is relocated to a fresh tmp dir per test, so enrollment, the
 * kill switch, the audit trail and config all resolve to an isolated
 * ~/.ashlr. NO daemon is ever actually started: the detached launcher is
 * replaced through setVerseDaemonSpawnerForTest(), and the one test that
 * proves a start is accepted asserts on the recorded call, not on a process.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AshlrConfig, WebServerOptions } from '../src/core/types.js';
import type {
  VerseAuditResponse,
  VerseCaps,
  VerseCapsUpdateResult,
  VerseControlSnapshot,
  VerseDaemonActionResult,
  VerseScope,
  VerseScopeResult,
} from '../src/core/verse/control-types.js';
import type { SafetyReport } from '../src/cli/verify-safety.js';
import { setVerseDaemonSpawnerForTest } from '../src/core/verse/control-api.js';
import { setKill } from '../src/core/sandbox/policy.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeConfig(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    // Port 1 refuses immediately: no provider probe stalls the control build.
    models: { lmstudio: 'http://localhost:1', ollama: 'http://127.0.0.1:1', providerChain: [] },
    telemetry: {},
    tools: {},
  } as unknown as AshlrConfig;
}

interface HttpResult { status: number; body: string; json: unknown }

function request(
  port: number,
  method: string,
  urlPath: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, headers: { Host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
        res.on('end', () => {
          let json: unknown = null;
          try { json = JSON.parse(raw) as unknown; } catch { /* not json */ }
          resolve({ status: res.statusCode ?? 0, body: raw, json });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

let tmpHome: string;
let tmpRepoRoot: string;
let repo: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let cfg: AshlrConfig;
let handles: Array<{ close(): Promise<void> }> = [];
/** Records every daemon launch the routes attempted, instead of spawning one. */
let spawnCalls: Array<{ once: boolean }> = [];

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-verse-control-home-'));
  tmpRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-verse-control-repos-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  repo = fs.mkdtempSync(path.join(tmpRepoRoot, 'repo-'));

  cfg = makeConfig();
  handles = [];
  spawnCalls = [];
  setVerseDaemonSpawnerForTest(({ once }) => {
    spawnCalls.push({ once });
    return { ok: true, pid: 4242, reason: 'spawned' };
  });
});

afterEach(async () => {
  for (const h of handles) { try { await h.close(); } catch { /* ignore */ } }
  handles = [];
  setVerseDaemonSpawnerForTest(null);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRepoRoot, { recursive: true, force: true });
});

async function boot(opts: Partial<WebServerOptions> = {}): Promise<{
  port: number;
  read: Record<string, string>;
  mutate: Record<string, string>;
}> {
  const handle = await startServer(cfg, { port: 0, open: false, allowDispatch: true, ...opts });
  handles.push(handle);
  return {
    port: handle.port,
    read: readAuthHeaders(handle.port),
    mutate: { 'x-ashlr-token': handle.token, 'content-type': 'application/json' },
  };
}

async function enrolRepo(
  port: number,
  mutate: Record<string, string>,
  target = repo,
): Promise<VerseScopeResult> {
  const res = await request(port, 'POST', '/api/verse/scope', mutate, JSON.stringify({
    action: 'enroll', path: target,
  }));
  expect(res.status).toBe(200);
  return res.json as VerseScopeResult;
}

// ---------------------------------------------------------------------------
// GET /api/verse/control
// ---------------------------------------------------------------------------

describe('GET /api/verse/control', () => {
  it('returns the full aggregate with honest empty/unknown states', async () => {
    const { port, read } = await boot();
    const res = await request(port, 'GET', '/api/verse/control', read);
    expect(res.status).toBe(200);

    const body = res.json as VerseControlSnapshot;
    // 'pause' joined the aggregate in V2.1 as a field of its OWN, next to but
    // never merged into 'killSwitch' — the two sentinels have different blast
    // radii and this payload is what lets the cockpit tell them apart.
    expect(Object.keys(body).sort()).toEqual([
      'caps', 'daemon', 'dispatchEnabled', 'fleet', 'generatedAt',
      'killSwitch', 'pause', 'pendingApprovals', 'quota', 'scope', 'spend',
    ]);

    expect(body.dispatchEnabled).toBe(true);
    // Nothing enrolled: the daemon would do nothing, and the payload says so
    // by being empty with NO degradedReason (that is the valid default state).
    expect(body.scope.repos).toEqual([]);
    expect(body.scope.degradedReason).toBeUndefined();
    // The daemon observation is a real verdict, never invented: with a fresh
    // ledger under this HOME it reads 'stopped', and it is only ever 'unknown'
    // when the sources genuinely disagree or cannot be read.
    expect(['stopped', 'unknown']).toContain(body.daemon.runtimeState);
    // Spend tracks the observation: a number when the ledger is readable,
    // null when it is not — never a reassuring zero standing in for unknown.
    expect(body.spend.todayUsd).toBe(body.daemon.todaySpentUsd);
    expect(body.spend.dailyBudgetUsd).toBe(1);
    expect(body.pendingApprovals).toBe(0);
    expect(body.killSwitch.state).toBe('inactive');
    // The blast-radius warning travels WITH the state, never separately.
    expect(body.killSwitch.note).toContain('Emergency stop');
    expect(body.killSwitch.note).toContain('write tools');
    expect(Array.isArray(body.quota)).toBe(true);
  });

  it('contains no secret-shaped strings, launcher commands, or server tokens', async () => {
    const handle = await startServer(cfg, { port: 0, open: false, allowDispatch: true });
    handles.push(handle);
    const res = await request(handle.port, 'GET', '/api/verse/control', readAuthHeaders(handle.port));
    expect(res.status).toBe(200);

    const raw = res.body;
    // This server's own credentials must not echo back in a read payload.
    expect(raw).not.toContain(handle.token);
    expect(raw).not.toContain(handle.readToken);
    // No token-shaped blobs, no credential key names, no argv.
    expect(raw).not.toMatch(/[A-Fa-f0-9]{32,}/);
    expect(raw).not.toMatch(/\b(bearer|sk-[A-Za-z0-9]|api[_-]?key|password|secret)\b/i);
    for (const key of ['"token"', '"command"', '"argv"', '"env"', '"launcher"']) {
      expect(raw, `control payload must not carry ${key}`).not.toContain(key);
    }
  });

  it('reflects the kill switch and the enrolled scope once they change', async () => {
    const { port, read, mutate } = await boot();
    await enrolRepo(port, mutate);
    expect(setKill(true).ok).toBe(true);

    const body = (await request(port, 'GET', '/api/verse/control', read)).json as VerseControlSnapshot;
    expect(body.killSwitch.state).toBe('active');
    expect(body.scope.repos.map((r) => r.name)).toEqual([path.basename(repo)]);
    expect(body.scope.repos[0]?.exists).toBe(true);
  });

  it('is not served without the read boundary', async () => {
    const { port } = await boot();
    const res = await request(port, 'GET', '/api/verse/control');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET/POST /api/verse/caps
// ---------------------------------------------------------------------------

describe('/api/verse/caps', () => {
  it('exposes the configured caps that no route surfaced before', async () => {
    const { port, read } = await boot();
    const res = await request(port, 'GET', '/api/verse/caps', read);
    expect(res.status).toBe(200);

    const caps = res.json as VerseCaps;
    expect(Object.keys(caps).sort()).toEqual([
      'concurrency', 'dailyBudgetUsd', 'defaulted', 'foundryLimits', 'intervalMs',
      'maxConcurrent', 'mode', 'parallel', 'perTickItems', 'subscriptionMaxPercent',
    ]);
    expect(caps.dailyBudgetUsd).toBe(1);
    expect(caps.subscriptionMaxPercent).toBe(90);
    expect(caps.defaulted).toContain('dailyBudgetUsd');
  });

  it('persists a partial update, says it is live, and reads back changed', async () => {
    const { port, read, mutate } = await boot();
    const res = await request(port, 'POST', '/api/verse/caps', mutate, JSON.stringify({
      dailyBudgetUsd: 20, perTickItems: 5, subscriptionMaxPercent: 70,
    }));
    expect(res.status).toBe(200);

    const result = res.json as VerseCapsUpdateResult;
    expect(result.ok).toBe(true);
    expect(result.live).toBe(true);
    expect(result.applied.sort()).toEqual(['dailyBudgetUsd', 'perTickItems', 'subscriptionMaxPercent']);
    expect(result.caps.dailyBudgetUsd).toBe(20);

    const after = (await request(port, 'GET', '/api/verse/caps', read)).json as VerseCaps;
    expect(after.dailyBudgetUsd).toBe(20);
    expect(after.perTickItems).toBe(5);
    expect(after.subscriptionMaxPercent).toBe(70);
    // Untouched caps stay on their defaults, still flagged as such.
    expect(after.parallel).toBe(2);
    expect(after.defaulted).toContain('parallel');
    expect(after.defaulted).not.toContain('dailyBudgetUsd');

    // The write landed in the isolated HOME, not the real ~/.ashlr.
    expect(fs.existsSync(path.join(tmpHome, '.ashlr', 'config.json'))).toBe(true);
  });

  it('rejects unknown keys and out-of-range values without writing anything', async () => {
    const { port, read, mutate } = await boot();

    const unknown = await request(port, 'POST', '/api/verse/caps', mutate, JSON.stringify({ budget: 5 }));
    expect(unknown.status).toBe(400);
    expect((unknown.json as { code: string }).code).toBe('VERSE_INVALID');
    expect((unknown.json as { error: string }).error).toContain('unknown key: budget');

    for (const body of [
      { dailyBudgetUsd: 1001 },
      { perTickItems: 0 },
      { parallel: 17 },
      { intervalMs: 1000 },
      { maxConcurrent: 33 },
      { concurrency: { local: 33 } },
      { subscriptionMaxPercent: 0 },
      { foundryLimits: [{ engine: 'claude', window: '5h', max: -1 }] },
      { mode: 'turbo' },
    ]) {
      const res = await request(port, 'POST', '/api/verse/caps', mutate, JSON.stringify(body));
      expect(res.status, `expected 400 for ${JSON.stringify(body)}`).toBe(400);
    }

    const after = (await request(port, 'GET', '/api/verse/caps', read)).json as VerseCaps;
    expect(after.dailyBudgetUsd).toBe(1);
    expect(after.defaulted).toContain('dailyBudgetUsd');
  });

  it('rejects a malformed body and a non-JSON content type', async () => {
    const { port, mutate } = await boot();
    expect((await request(port, 'POST', '/api/verse/caps', mutate, 'not json')).status).toBe(400);
    expect((await request(port, 'POST', '/api/verse/caps', mutate, '[]')).status).toBe(400);
    const wrongType = await request(
      port, 'POST', '/api/verse/caps',
      { ...mutate, 'content-type': 'text/plain' },
      '{}',
    );
    expect(wrongType.status).toBe(415);
  });

  it('is 401 without the mutation token and 404 when dispatch is off', async () => {
    const { port } = await boot();
    const noToken = await request(port, 'POST', '/api/verse/caps', { 'content-type': 'application/json' }, '{}');
    expect(noToken.status).toBe(401);

    const off = await boot({ allowDispatch: false });
    const res = await request(off.port, 'POST', '/api/verse/caps', off.mutate, JSON.stringify({ dailyBudgetUsd: 5 }));
    // 404, not 401: an unauthenticated caller learns nothing about which
    // mutating routes this server has.
    expect(res.status).toBe(404);
    // The READ side still works with dispatch off.
    expect((await request(off.port, 'GET', '/api/verse/caps', off.read)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET/POST /api/verse/scope
// ---------------------------------------------------------------------------

describe('/api/verse/scope', () => {
  it('enrolls, lists, and unenrolls a repository', async () => {
    const { port, read, mutate } = await boot();

    const empty = (await request(port, 'GET', '/api/verse/scope', read)).json as VerseScope;
    expect(empty.repos).toEqual([]);
    expect(empty.degradedReason).toBeUndefined();

    const enrolled = await enrolRepo(port, mutate);
    expect(enrolled.ok).toBe(true);
    expect(enrolled.changed).toBe(true);
    expect(enrolled.scope.repos).toHaveLength(1);
    expect(enrolled.scope.repos[0]?.exists).toBe(true);

    // Idempotent: a second enroll is ok but not a change.
    const again = await enrolRepo(port, mutate);
    expect(again.ok).toBe(true);
    expect(again.changed).toBe(false);

    const removed = await request(port, 'POST', '/api/verse/scope', mutate, JSON.stringify({
      action: 'unenroll', path: repo,
    }));
    expect(removed.status).toBe(200);
    expect((removed.json as VerseScopeResult).changed).toBe(true);
    expect((removed.json as VerseScopeResult).scope.repos).toEqual([]);
  });

  it('reports a registry entry whose directory is gone as exists:false', async () => {
    const { port, read, mutate } = await boot();
    const doomed = fs.mkdtempSync(path.join(tmpRepoRoot, 'doomed-'));
    await enrolRepo(port, mutate, doomed);
    fs.rmSync(doomed, { recursive: true, force: true });

    const scope = (await request(port, 'GET', '/api/verse/scope', read)).json as VerseScope;
    expect(scope.repos).toHaveLength(1);
    expect(scope.repos[0]?.exists).toBe(false);
  });

  it('still unenrolls a repository that has been deleted from disk', async () => {
    const { port, mutate } = await boot();
    const doomed = fs.mkdtempSync(path.join(tmpRepoRoot, 'doomed-'));
    await enrolRepo(port, mutate, doomed);
    fs.rmSync(doomed, { recursive: true, force: true });

    const res = await request(port, 'POST', '/api/verse/scope', mutate, JSON.stringify({
      action: 'unenroll', path: doomed,
    }));
    expect(res.status).toBe(200);
    expect((res.json as VerseScopeResult).scope.repos).toEqual([]);
  });

  it('refuses anything under ~/.codex/artifacts, including via symlink and traversal', async () => {
    const { port, read, mutate } = await boot();
    const artifacts = path.join(tmpHome, '.codex', 'artifacts');
    const inside = path.join(artifacts, 'scratch');
    fs.mkdirSync(inside, { recursive: true });
    const disguised = path.join(tmpRepoRoot, 'disguised');
    fs.symlinkSync(inside, disguised, 'dir');

    for (const candidate of [
      inside,
      artifacts,
      path.join(tmpHome, 'x', '..', '.codex', 'artifacts', 'scratch'),
      disguised,
    ]) {
      const res = await request(port, 'POST', '/api/verse/scope', mutate, JSON.stringify({
        action: 'enroll', path: candidate,
      }));
      expect(res.status, `expected 400 for ${candidate}`).toBe(400);
      expect((res.json as { error: string }).error).toContain('.codex/artifacts');
    }

    const scope = (await request(port, 'GET', '/api/verse/scope', read)).json as VerseScope;
    expect(scope.repos).toEqual([]);
  });

  it('refuses relative paths, missing directories, files, and unknown keys', async () => {
    const { port, mutate } = await boot();
    const file = path.join(tmpRepoRoot, 'a-file');
    fs.writeFileSync(file, 'x');

    const cases: Array<[Record<string, unknown>, string]> = [
      [{ action: 'enroll', path: 'relative/repo' }, 'absolute'],
      [{ action: 'enroll', path: path.join(tmpRepoRoot, 'nope') }, 'existing directory'],
      [{ action: 'enroll', path: file }, 'existing directory'],
      [{ action: 'enroll' }, 'path is required'],
      [{ action: 'pause', path: repo }, 'enroll'],
      [{ action: 'enroll', path: repo, force: true }, 'unknown key: force'],
    ];
    for (const [body, needle] of cases) {
      const res = await request(port, 'POST', '/api/verse/scope', mutate, JSON.stringify(body));
      expect(res.status, `expected 400 for ${JSON.stringify(body)}`).toBe(400);
      expect((res.json as { error: string }).error).toContain(needle);
    }
  });

  it('is 401 without the mutation token and 404 when dispatch is off', async () => {
    const { port } = await boot();
    const noToken = await request(
      port, 'POST', '/api/verse/scope',
      { 'content-type': 'application/json' },
      JSON.stringify({ action: 'enroll', path: repo }),
    );
    expect(noToken.status).toBe(401);

    const off = await boot({ allowDispatch: false });
    const res = await request(off.port, 'POST', '/api/verse/scope', off.mutate, JSON.stringify({
      action: 'enroll', path: repo,
    }));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/verse/audit
// ---------------------------------------------------------------------------

describe('GET /api/verse/audit', () => {
  it('returns the trail newest-first and caps it at the requested limit', async () => {
    const { port, read, mutate } = await boot();
    const extra = fs.mkdtempSync(path.join(tmpRepoRoot, 'second-'));
    await enrolRepo(port, mutate);
    await enrolRepo(port, mutate, extra);

    const all = (await request(port, 'GET', '/api/verse/audit', read)).json as VerseAuditResponse;
    expect(all.entries.length).toBeGreaterThanOrEqual(2);
    expect(all.limit).toBe(100);
    expect(all.filter).toEqual({ action: null, result: null });
    // Newest first. The registry (and therefore the audit line) records the
    // physical path, which on macOS differs from the tmpdir spelling.
    expect(all.entries[0]?.action).toBe('enroll:add');
    expect(all.entries[0]?.repo).toBe(fs.realpathSync.native(extra));

    const one = (await request(port, 'GET', '/api/verse/audit?limit=1', read)).json as VerseAuditResponse;
    expect(one.entries).toHaveLength(1);
    expect(one.limit).toBe(1);
  });

  it('clamps limit to the 500 ceiling and rejects a bad limit', async () => {
    const { port, read } = await boot();
    const clamped = (await request(port, 'GET', '/api/verse/audit?limit=99999', read)).json as VerseAuditResponse;
    expect(clamped.limit).toBe(500);

    for (const bad of ['0', '-3', 'abc', '2.5']) {
      const res = await request(port, 'GET', `/api/verse/audit?limit=${bad}`, read);
      expect(res.status, `expected 400 for limit=${bad}`).toBe(400);
    }
  });

  it('filters by action substring and by result, and rejects an unknown result', async () => {
    const { port, read, mutate } = await boot();
    await enrolRepo(port, mutate);
    await request(port, 'POST', '/api/verse/scope', mutate, JSON.stringify({
      action: 'unenroll', path: repo,
    }));

    const adds = (await request(port, 'GET', '/api/verse/audit?action=enroll:add', read)).json as VerseAuditResponse;
    expect(adds.entries.length).toBeGreaterThan(0);
    expect(adds.entries.every((e) => e.action === 'enroll:add')).toBe(true);
    expect(adds.filter.action).toBe('enroll:add');

    const ok = (await request(port, 'GET', '/api/verse/audit?result=ok', read)).json as VerseAuditResponse;
    expect(ok.entries.every((e) => e.result === 'ok')).toBe(true);

    const none = (await request(port, 'GET', '/api/verse/audit?action=nothing-matches-this', read))
      .json as VerseAuditResponse;
    expect(none.entries).toEqual([]);

    const bad = await request(port, 'GET', '/api/verse/audit?result=maybe', read);
    expect(bad.status).toBe(400);
  });

  it('returns an empty trail rather than failing when nothing has been audited', async () => {
    const { port, read } = await boot();
    const res = await request(port, 'GET', '/api/verse/audit', read);
    expect(res.status).toBe(200);
    expect((res.json as VerseAuditResponse).entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/verse/daemon — the refusal ladder
// ---------------------------------------------------------------------------

describe('POST /api/verse/daemon', () => {
  it('is 401 without the mutation token and 404 when dispatch is off', async () => {
    const { port } = await boot();
    const noToken = await request(
      port, 'POST', '/api/verse/daemon',
      { 'content-type': 'application/json' },
      JSON.stringify({ action: 'start' }),
    );
    expect(noToken.status).toBe(401);

    const off = await boot({ allowDispatch: false });
    const res = await request(off.port, 'POST', '/api/verse/daemon', off.mutate, JSON.stringify({
      action: 'start',
    }));
    expect(res.status).toBe(404);

    // Nothing was launched on either path.
    expect(spawnCalls).toEqual([]);
  });

  it('rejects an unknown action and unknown body keys', async () => {
    const { port, mutate } = await boot();
    // 'pause' used to belong here — it is now a REAL action (the daemon-scoped
    // halt added in V2.1, covered by test/verse-daemon-pause.test.ts), so the
    // unknown-action probe uses words the route still does not accept.
    for (const body of [{ action: 'halt' }, { action: 'restart' }, {}, { action: 'start', force: true }]) {
      const res = await request(port, 'POST', '/api/verse/daemon', mutate, JSON.stringify(body));
      expect(res.status, `expected 400 for ${JSON.stringify(body)}`).toBe(400);
    }
    expect(spawnCalls).toEqual([]);
  });

  it('refuses to start with an EMPTY enrollment registry', async () => {
    const { port, mutate } = await boot();
    const res = await request(port, 'POST', '/api/verse/daemon', mutate, JSON.stringify({ action: 'start' }));
    expect(res.status).toBe(409);

    const body = res.json as VerseDaemonActionResult;
    expect(body.ok).toBe(false);
    expect(body.spawned).toBe(false);
    // A daemon with no scope is a no-op that would look like success.
    expect(body.note).toContain('no repositories are enrolled');
    expect(spawnCalls).toEqual([]);
  });

  it('refuses to start while the kill switch is engaged', async () => {
    const { port, mutate } = await boot();
    await enrolRepo(port, mutate);
    expect(setKill(true).ok).toBe(true);

    for (const action of ['start', 'once']) {
      const res = await request(port, 'POST', '/api/verse/daemon', mutate, JSON.stringify({ action }));
      expect(res.status, `expected 409 for ${action}`).toBe(409);
      const body = res.json as VerseDaemonActionResult;
      expect(body.ok).toBe(false);
      expect(body.note).toContain('kill switch is engaged');
      expect(body.killSwitch.state).toBe('active');
      expect(body.killSwitch.note).toContain('Emergency stop');
    }
    expect(spawnCalls).toEqual([]);
  });

  it('launches the loop detached once scope exists and the kill switch is clear', async () => {
    const { port, read, mutate } = await boot();
    await enrolRepo(port, mutate);

    const res = await request(port, 'POST', '/api/verse/daemon', mutate, JSON.stringify({ action: 'start' }));
    expect(res.status).toBe(200);

    const body = res.json as VerseDaemonActionResult;
    expect(body.ok).toBe(true);
    expect(body.action).toBe('start');
    expect(body.spawned).toBe(true);
    expect(body.pid).toBe(4242);
    expect(body.note).toContain('proposes only');
    expect(spawnCalls).toEqual([{ once: false }]);

    // The launch carries a pid and nothing else — no argv, env, or launcher path.
    expect(res.body).not.toMatch(/"(argv|env|command|launcher)"/);

    // The attempt is on the audit trail.
    const trail = (await request(port, 'GET', '/api/verse/audit?action=verse:daemon', read))
      .json as VerseAuditResponse;
    expect(trail.entries.some((e) => e.action === 'verse:daemon:start' && e.result === 'ok')).toBe(true);
  });

  it("runs a single tick for action 'once'", async () => {
    const { port, mutate } = await boot();
    await enrolRepo(port, mutate);
    const res = await request(port, 'POST', '/api/verse/daemon', mutate, JSON.stringify({ action: 'once' }));
    expect(res.status).toBe(200);
    expect((res.json as VerseDaemonActionResult).action).toBe('once');
    expect(spawnCalls).toEqual([{ once: true }]);
  });

  it('audits a refusal, not only an accepted start', async () => {
    const { port, read, mutate } = await boot();
    await request(port, 'POST', '/api/verse/daemon', mutate, JSON.stringify({ action: 'start' }));

    const trail = (await request(port, 'GET', '/api/verse/audit?action=verse:daemon', read))
      .json as VerseAuditResponse;
    const refusal = trail.entries.find((e) => e.action === 'verse:daemon:start');
    expect(refusal?.result).toBe('refused');
    expect(refusal?.summary).toContain('enrollment registry empty');
  });

  it("stop says out loud that it engages the global kill switch", async () => {
    const { port, mutate } = await boot();
    const res = await request(port, 'POST', '/api/verse/daemon', mutate, JSON.stringify({ action: 'stop' }));
    expect(res.status).toBe(200);

    const body = res.json as VerseDaemonActionResult;
    expect(body.ok).toBe(true);
    expect(body.spawned).toBe(false);
    // stopDaemon() works BY setting the kill switch — the response must not
    // imply a narrower blast radius than it has.
    expect(body.note).toContain('global kill switch');
    expect(body.killSwitch.state).toBe('active');
    expect(fs.existsSync(path.join(tmpHome, '.ashlr', 'KILL'))).toBe(true);
  });

  it('is 404 for GET (this route only accepts POST)', async () => {
    const { port, read } = await boot();
    expect((await request(port, 'GET', '/api/verse/daemon', read)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/verse/safety
// ---------------------------------------------------------------------------

describe('GET /api/verse/safety', () => {
  it('returns the verify-safety report from the callable checker', async () => {
    const { port, read } = await boot();
    const res = await request(port, 'GET', '/api/verse/safety', read);
    expect(res.status).toBe(200);

    const report = res.json as SafetyReport;
    expect(typeof report.ok).toBe('boolean');
    expect(Array.isArray(report.checks)).toBe(true);
    expect(report.checks.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        'enrollment-default-empty',
        'kill-switch-precedence',
        'daemon-no-primitive',
        'scrub-patterns-match',
        'provider-cloud-gate',
      ]),
    );
    for (const check of report.checks) {
      expect(Object.keys(check).sort()).toEqual(['detail', 'id', 'label', 'pass']);
    }
  });

  it('is not served without the read boundary', async () => {
    const { port } = await boot();
    expect((await request(port, 'GET', '/api/verse/safety')).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// V1 routes must still be reachable past the V2 mount
// ---------------------------------------------------------------------------

describe('V1 verse routes', () => {
  it('still resolve after the control plane is mounted ahead of them', async () => {
    const { port, read } = await boot();
    // The V2 handler matches only its six exact paths; everything else falls
    // through to the V1 session handler.
    expect((await request(port, 'GET', '/api/verse/sessions', read)).status).toBe(200);
    expect((await request(port, 'GET', '/api/verse/nonsense', read)).status).toBe(404);
  });
});
