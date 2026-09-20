/**
 * test/verse-daemon-pause.test.ts — the DAEMON-SCOPED pause.
 *
 * The thing being proved here is a SEPARATION, so every group tests it from a
 * different side:
 *
 *  A. pause.ts itself — round trip, idempotence, sentinel mode/shape, and the
 *     fail-safe reads (missing = running; malformed/unsafe = paused).
 *  B. The loop honours it — a paused daemon's tick refuses to dispatch with
 *     reason 'daemon-paused', while `assertMayMutate` (the gate mcp-native and
 *     mcp-native-engineer call) still PASSES. An engaged KILL blocks both.
 *     This is the whole point of the module: "stop the loop" must stop the
 *     loop and nothing else.
 *  C. The route — pause/resume round-trip through the real server with audit
 *     entries, refusals without dispatch or without the token, and the start
 *     refusal while paused.
 *  D. Structural — nothing in the write-tool path even IMPORTS pause.js, read
 *     off the source. A behavioural test proves today's wiring; this one
 *     prevents someone from wiring it in tomorrow.
 *
 * SAFETY. Every test runs under a relocated HOME (h1-fixture for A/B, an
 * explicit tmp HOME for C), so `~/.ashlr/KILL`, `~/.ashlr/daemon.paused`, the
 * enrollment registry and the audit trail all resolve inside a throwaway
 * directory. The REAL `~/.ashlr/KILL` is never created, read, or removed —
 * it is currently engaged on this machine and must stay exactly as it is.
 * No daemon is ever spawned: the detached launcher is replaced through
 * `setVerseDaemonSpawnerForTest`, and the tick is driven directly in dry-run.
 *
 * Real loopback bind in group C → this file is in the real-io lane
 * (`test/config/realio-lane-membership.mjs`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AshlrConfig, WebServerOptions } from '../src/core/types.js';
import type {
  VerseAuditResponse,
  VerseControlSnapshot,
  VerseDaemonActionResult,
  VerseScopeResult,
} from '../src/core/verse/control-types.js';
import {
  daemonPausePath,
  daemonPaused,
  pauseDaemon,
  readDaemonPause,
  resumeDaemon,
  setDaemonPause,
} from '../src/core/daemon/pause.js';
// Only assertMayMutate is imported from policy: the kill switch is driven
// exclusively through `fixture.setKill`, which is bound to the tmp HOME and
// cleared by cleanup(). Nothing in this file may create or remove the real
// ~/.ashlr/KILL, which is engaged on this machine and must stay that way.
import { assertMayMutate } from '../src/core/sandbox/policy.js';
import { readAudit } from '../src/core/sandbox/audit.js';
import { setVerseDaemonSpawnerForTest } from '../src/core/verse/control-api.js';
import { makeCfg, makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

// ===========================================================================
// Group A — pause.ts
// ===========================================================================

describe('daemon pause sentinel', () => {
  let fixture: H1Fixture;

  beforeEach(() => {
    fixture = makeFixture();
  });

  afterEach(() => {
    // cleanup() clears the kill switch and restores the real HOME. The pause
    // sentinel lives inside the tmp HOME, which is rm -rf'd with it.
    fixture.cleanup();
  });

  it('is a file of its own, NOT ~/.ashlr/KILL', () => {
    expect(daemonPausePath()).toBe(path.join(fixture.ashlrDir, 'daemon.paused'));
    expect(daemonPausePath().endsWith('KILL')).toBe(false);

    pauseDaemon('cli');
    // The pause must never create the global sentinel as a side effect.
    expect(fs.existsSync(path.join(fixture.ashlrDir, 'KILL'))).toBe(false);
  });

  it('reads as running when the sentinel is absent — proven, not assumed', () => {
    const read = readDaemonPause();
    expect(read.state).toBe('running');
    expect(read.sourceState).toBe('healthy');
    expect(read.reason).toBe('missing');
    expect(read.record).toBeNull();
    expect(daemonPaused()).toBe(false);
  });

  it('round-trips pause → resume and records who and when', () => {
    const before = Date.now();
    const paused = pauseDaemon('verse-control-plane');
    expect(paused.ok).toBe(true);
    expect(paused.changed).toBe(true);
    expect(paused.reason).toBe('paused');
    expect(paused.state.state).toBe('paused');
    expect(daemonPaused()).toBe(true);

    const record = readDaemonPause().record;
    expect(record?.by).toBe('verse-control-plane');
    expect(Date.parse(record?.pausedAt ?? '')).toBeGreaterThanOrEqual(before - 1000);

    const resumed = resumeDaemon('cli');
    expect(resumed.ok).toBe(true);
    expect(resumed.changed).toBe(true);
    expect(resumed.reason).toBe('resumed');
    expect(resumed.state.state).toBe('running');
    expect(daemonPaused()).toBe(false);
    expect(fs.existsSync(daemonPausePath())).toBe(false);
  });

  it('is idempotent in both directions', () => {
    expect(pauseDaemon('cli').changed).toBe(true);
    const again = pauseDaemon('cli');
    expect(again.ok).toBe(true);
    expect(again.changed).toBe(false);
    expect(again.reason).toBe('already-paused');

    expect(resumeDaemon('cli').changed).toBe(true);
    const twice = resumeDaemon('cli');
    expect(twice.ok).toBe(true);
    expect(twice.changed).toBe(false);
    expect(twice.reason).toBe('already-running');
  });

  it('writes a 0600 metadata-only body — no token, argv, path, or env', () => {
    pauseDaemon('cli');
    const stat = fs.lstatSync(daemonPausePath());
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600);

    const raw = fs.readFileSync(daemonPausePath(), 'utf8');
    expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual(['by', 'pausedAt']);
    // Nothing secret-shaped, and no absolute path to leak a home layout.
    expect(raw).not.toMatch(/token|bearer|argv|launcher|env|[A-Za-z0-9+/]{40,}/i);
    expect(raw).not.toContain(fixture.home);
  });

  it('FAILS SAFE: a malformed sentinel reads as paused, never as running', () => {
    fs.mkdirSync(fixture.ashlrDir, { recursive: true });
    fs.writeFileSync(daemonPausePath(), 'not json at all\n', { mode: 0o600 });

    const read = readDaemonPause();
    expect(read.state).toBe('unknown');
    expect(read.sourceState).toBe('degraded');
    expect(read.reason).toBe('malformed');
    expect(read.record).toBeNull();
    // The projection every caller uses must point AWAY from running.
    expect(daemonPaused()).toBe(true);
  });

  it('FAILS SAFE on a well-formed body with a bogus actor or timestamp', () => {
    fs.mkdirSync(fixture.ashlrDir, { recursive: true });
    for (const body of [
      { by: 'somebody-else', pausedAt: new Date().toISOString() },
      { by: 'cli', pausedAt: 'not-a-date' },
      { by: 'cli', pausedAt: new Date().toISOString(), extra: 1 },
    ]) {
      fs.writeFileSync(daemonPausePath(), JSON.stringify(body), { mode: 0o600 });
      expect(readDaemonPause().state, JSON.stringify(body)).toBe('unknown');
      expect(daemonPaused()).toBe(true);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'FAILS SAFE: a group-writable sentinel is not trusted as a pause record',
    () => {
      pauseDaemon('cli');
      fs.chmodSync(daemonPausePath(), 0o666);
      const read = readDaemonPause();
      expect(read.state).toBe('unknown');
      expect(read.reason).toBe('unsafe');
      expect(daemonPaused()).toBe(true);
    },
  );

  it('resuming out of a malformed sentinel clears it', () => {
    fs.mkdirSync(fixture.ashlrDir, { recursive: true });
    fs.writeFileSync(daemonPausePath(), '{', { mode: 0o600 });
    const resumed = setDaemonPause(false, { by: 'cli' });
    expect(resumed.ok).toBe(true);
    expect(resumed.state.state).toBe('running');
    expect(daemonPaused()).toBe(false);
  });

  it('audits every pause and resume, idempotent calls included', () => {
    pauseDaemon('cli');
    pauseDaemon('cli');
    resumeDaemon('verse-control-plane');

    const actions = readAudit(50).map((e) => e.action);
    expect(actions.filter((a) => a === 'daemon:pause').length).toBe(2);
    expect(actions).toContain('daemon:resume');

    const paused = readAudit(50).find((e) => e.action === 'daemon:pause');
    // The audit line must say what the pause did NOT do, or it reads like a kill.
    expect(paused?.summary).toContain('kill switch is untouched');
  });
});

// ===========================================================================
// Group B — the separation: pause halts dispatch, KILL halts everything
// ===========================================================================

describe('pause stops the loop without stopping the write tools', () => {
  let fixture: H1Fixture;
  let repo: ReturnType<H1Fixture['makeRepo']>;
  let cfg: AshlrConfig;

  beforeEach(() => {
    fixture = makeFixture();
    repo = fixture.makeRepo();
    repo.enroll();
    cfg = makeCfg();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  /**
   * One dry-run tick. Dry-run skips the activation-capability gate without
   * skipping the kill/pause gate (both sit in the same §1 short-circuit), so
   * this reaches exactly the branch under test and can never dispatch.
   */
  async function oneTick(): Promise<{ reason: string; proposalsCreated: number }> {
    const { tick } = await import('../src/core/daemon/loop.js');
    const result = await tick(cfg, { dryRun: true });
    return { reason: result.reason, proposalsCreated: result.proposalsCreated };
  }

  it('baseline: neither sentinel set — the tick is not refused for either reason', async () => {
    const result = await oneTick();
    expect(result.reason).not.toBe('kill-switch');
    expect(result.reason).not.toBe('daemon-paused');
    expect(() => assertMayMutate(repo.dir)).not.toThrow();
  });

  it('PAUSED: the tick refuses with daemon-paused AND assertMayMutate still passes', async () => {
    expect(pauseDaemon('cli').ok).toBe(true);

    const result = await oneTick();
    expect(result.reason).toBe('daemon-paused');
    expect(result.proposalsCreated).toBe(0);

    // THE POINT OF THE WHOLE MODULE. assertMayMutate is the gate
    // mcp-native / mcp-native-engineer call before every write; a pause must
    // leave it open, or "stop the loop" has disarmed the operator's own tools
    // exactly as `stopDaemon()` does.
    expect(() => assertMayMutate(repo.dir)).not.toThrow();
    // And the global sentinel was never created.
    expect(fs.existsSync(path.join(fixture.ashlrDir, 'KILL'))).toBe(false);
  });

  it('KILLED: the tick refuses with kill-switch AND assertMayMutate throws', async () => {
    fixture.setKill(true);

    const result = await oneTick();
    expect(result.reason).toBe('kill-switch');
    expect(() => assertMayMutate(repo.dir)).toThrow(/kill switch is ON/i);

    fixture.setKill(false);
    expect(() => assertMayMutate(repo.dir)).not.toThrow();
  });

  it('KILL wins the label when both are engaged — the wider fact is reported', async () => {
    pauseDaemon('cli');
    fixture.setKill(true);

    expect((await oneTick()).reason).toBe('kill-switch');
    expect(() => assertMayMutate(repo.dir)).toThrow();

    fixture.setKill(false);
    expect((await oneTick()).reason).toBe('daemon-paused');
    expect(() => assertMayMutate(repo.dir)).not.toThrow();
  });

  it('a MALFORMED sentinel refuses the tick and still leaves writes alone', async () => {
    fs.mkdirSync(fixture.ashlrDir, { recursive: true });
    fs.writeFileSync(daemonPausePath(), 'garbage', { mode: 0o600 });

    expect((await oneTick()).reason).toBe('daemon-paused');
    // Failing closed on DISPATCH must not fail closed on the operator's tools:
    // an unreadable pause file is not evidence that writing is unsafe.
    expect(() => assertMayMutate(repo.dir)).not.toThrow();
  });

  it('resuming lets the tick proceed again, with no restart', async () => {
    pauseDaemon('cli');
    expect((await oneTick()).reason).toBe('daemon-paused');
    resumeDaemon('cli');
    expect((await oneTick()).reason).not.toBe('daemon-paused');
  });

  it('records the refusal on the audit trail as a pause, not as a kill', async () => {
    pauseDaemon('cli');
    await oneTick();
    const summary = readAudit(50).find((e) => e.action === 'daemon:tick')?.summary ?? '';
    expect(summary).toContain('paused');
    expect(summary).not.toContain('kill switch is ON');
  });
});

// ===========================================================================
// Group C — POST /api/verse/daemon {pause,resume}
// ===========================================================================

function makeServerConfig(): AshlrConfig {
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

describe('POST /api/verse/daemon {action:pause|resume}', () => {
  let tmpHome: string;
  let tmpRepoRoot: string;
  let repo: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  let cfg: AshlrConfig;
  let handles: Array<{ close(): Promise<void> }> = [];
  let spawnCalls: Array<{ once: boolean }> = [];

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-verse-pause-home-'));
    tmpRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-verse-pause-repos-'));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    repo = fs.mkdtempSync(path.join(tmpRepoRoot, 'repo-'));

    cfg = makeServerConfig();
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

  async function daemonAction(
    port: number,
    mutate: Record<string, string>,
    action: string,
  ): Promise<HttpResult> {
    return request(port, 'POST', '/api/verse/daemon', mutate, JSON.stringify({ action }));
  }

  it('round-trips pause → resume and reports the state on every response', async () => {
    const { port, mutate } = await boot();

    const paused = await daemonAction(port, mutate, 'pause');
    expect(paused.status).toBe(200);
    const pausedBody = paused.json as VerseDaemonActionResult;
    expect(pausedBody.ok).toBe(true);
    expect(pausedBody.action).toBe('pause');
    expect(pausedBody.spawned).toBe(false);
    expect(pausedBody.pause.state).toBe('paused');
    expect(pausedBody.pause.by).toBe('verse-control-plane');
    expect(pausedBody.note).toContain('write tools are unaffected');
    // The narrow stop must NOT have engaged the wide one.
    expect(pausedBody.killSwitch.state).toBe('inactive');
    expect(fs.existsSync(path.join(tmpHome, '.ashlr', 'KILL'))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, '.ashlr', 'daemon.paused'))).toBe(true);

    const resumed = await daemonAction(port, mutate, 'resume');
    expect(resumed.status).toBe(200);
    const resumedBody = resumed.json as VerseDaemonActionResult;
    expect(resumedBody.ok).toBe(true);
    expect(resumedBody.pause.state).toBe('running');
    expect(fs.existsSync(path.join(tmpHome, '.ashlr', 'daemon.paused'))).toBe(false);
    expect(spawnCalls).toEqual([]);
  });

  it('is idempotent over HTTP and says so instead of failing', async () => {
    const { port, mutate } = await boot();
    await daemonAction(port, mutate, 'pause');
    const again = await daemonAction(port, mutate, 'pause');
    expect(again.status).toBe(200);
    expect((again.json as VerseDaemonActionResult).note).toContain('Already paused');
  });

  it('audits both the pause and the resume', async () => {
    const { port, read, mutate } = await boot();
    await daemonAction(port, mutate, 'pause');
    await daemonAction(port, mutate, 'resume');

    const trail = (await request(port, 'GET', '/api/verse/audit?action=verse:daemon', read))
      .json as VerseAuditResponse;
    const actions = trail.entries.map((e) => e.action);
    expect(actions).toContain('verse:daemon:pause');
    expect(actions).toContain('verse:daemon:resume');
    expect(trail.entries.find((e) => e.action === 'verse:daemon:pause')?.result).toBe('ok');
  });

  it('carries the pause on GET /api/verse/control as its OWN field', async () => {
    const { port, read, mutate } = await boot();

    const before = (await request(port, 'GET', '/api/verse/control', read)).json as VerseControlSnapshot;
    expect(before.pause.state).toBe('running');
    expect(before.killSwitch.state).toBe('inactive');
    expect(before.pause.note).toContain('Pause');

    await daemonAction(port, mutate, 'pause');
    const after = (await request(port, 'GET', '/api/verse/control', read)).json as VerseControlSnapshot;
    expect(after.pause.state).toBe('paused');
    // Distinct fields, distinct facts: pausing must not move the kill switch.
    expect(after.killSwitch.state).toBe('inactive');
  });

  it('refuses without the mutation token and 404s when dispatch is off', async () => {
    const { port } = await boot();
    const noToken = await request(
      port, 'POST', '/api/verse/daemon',
      { 'content-type': 'application/json' },
      JSON.stringify({ action: 'pause' }),
    );
    expect(noToken.status).toBe(401);

    const off = await boot({ allowDispatch: false });
    const res = await daemonAction(off.port, off.mutate, 'pause');
    expect(res.status).toBe(404);

    // Neither refusal may have written the sentinel.
    expect(fs.existsSync(path.join(tmpHome, '.ashlr', 'daemon.paused'))).toBe(false);
  });

  it('still rejects an unknown action and unknown body keys', async () => {
    const { port, mutate } = await boot();
    for (const body of [{ action: 'halt' }, { action: 'unpause' }, {}, { action: 'pause', force: true }]) {
      const res = await request(port, 'POST', '/api/verse/daemon', mutate, JSON.stringify(body));
      expect(res.status, `expected 400 for ${JSON.stringify(body)}`).toBe(400);
    }
    expect(fs.existsSync(path.join(tmpHome, '.ashlr', 'daemon.paused'))).toBe(false);
  });

  it('refuses to start or tick while paused, and names the fix', async () => {
    const { port, mutate } = await boot();
    const enrolled = await request(port, 'POST', '/api/verse/scope', mutate, JSON.stringify({
      action: 'enroll', path: repo,
    }));
    expect((enrolled.json as VerseScopeResult).ok).toBe(true);

    await daemonAction(port, mutate, 'pause');

    for (const action of ['start', 'once']) {
      const res = await daemonAction(port, mutate, action);
      expect(res.status, `expected 409 for ${action}`).toBe(409);
      const body = res.json as VerseDaemonActionResult;
      expect(body.ok).toBe(false);
      expect(body.note).toContain('Resume first');
    }
    // Nothing was launched — a parked loop must not be spawned at all.
    expect(spawnCalls).toEqual([]);

    await daemonAction(port, mutate, 'resume');
    const started = await daemonAction(port, mutate, 'start');
    expect(started.status).toBe(200);
    expect(spawnCalls).toEqual([{ once: false }]);
  });

  it('pauses even with no enrolled scope and no running loop', async () => {
    // A pause that required scope or a live daemon would be a pause the
    // operator cannot trust in the moment they most want it.
    const { port, mutate } = await boot();
    const res = await daemonAction(port, mutate, 'pause');
    expect(res.status).toBe(200);
    expect((res.json as VerseDaemonActionResult).pause.state).toBe('paused');
  });

  it('never returns a sentinel path, launcher command, or token', async () => {
    const { port, read, mutate } = await boot();
    const paused = await daemonAction(port, mutate, 'pause');
    const snapshot = await request(port, 'GET', '/api/verse/control', read);

    for (const payload of [paused.body, snapshot.body]) {
      expect(payload).not.toContain(tmpHome);
      expect(payload).not.toMatch(/daemon\.paused/);
      expect(payload).not.toMatch(/"(argv|env|command|launcher|token)"/);
      expect(payload).not.toMatch(/native-profiles|launcher\.mjs/);
    }
  });

  it('stop still engages the kill switch and now points at pause', async () => {
    // Unchanged behaviour, re-asserted: `stopDaemon()` is still setKill(true),
    // so the response must keep saying so — the narrow control does not make
    // the wide one narrower.
    const { port, mutate } = await boot();
    const res = await daemonAction(port, mutate, 'stop');
    expect(res.status).toBe(200);
    const body = res.json as VerseDaemonActionResult;
    expect(body.note).toContain('global kill switch');
    expect(body.note).toContain('Pause');
    expect(body.killSwitch.state).toBe('active');
    expect(fs.existsSync(path.join(tmpHome, '.ashlr', 'KILL'))).toBe(true);
  });
});

// ===========================================================================
// Group D — structural: the write-tool path must never learn about the pause
// ===========================================================================

describe('the pause sentinel is scoped to the daemon by construction', () => {
  const root = path.join(__dirname, '..');

  /**
   * The behavioural tests above prove that TODAY's write path ignores the
   * pause. This one keeps it that way: if anyone imports daemon/pause.js into
   * the mutation gate or either mcp-native surface, the narrow stop silently
   * becomes a second kill switch and group B would be the only thing standing
   * between that and a shipped regression.
   */
  it.each([
    'src/core/sandbox/policy.ts',
    'src/core/mcp-native.ts',
    'src/core/mcp-native-engineer.ts',
  ])('%s does not import daemon/pause.js', (rel) => {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    expect(source).not.toMatch(/daemon\/pause\.js/);
    expect(source).not.toMatch(/daemon\.paused/);
    expect(source).not.toMatch(/\bdaemonPaused\b/);
  });

  it('the daemon loop DOES consult it', () => {
    const source = fs.readFileSync(path.join(root, 'src/core/daemon/loop.ts'), 'utf8');
    expect(source).toMatch(/from '\.\/pause\.js'/);
    expect(source).toMatch(/\bdaemonPaused\(\)/);
  });
});
