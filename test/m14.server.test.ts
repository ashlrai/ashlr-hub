/**
 * M14 server tests — hermetic.
 *
 * Tests startServer() from src/core/web/server.ts:
 *   - Binds to 127.0.0.1 ONLY (never 0.0.0.0).
 *   - Returns a WebServerHandle with port, token, url, and close().
 *   - Token is a non-empty string (hex, crypto-generated).
 *   - url is http://127.0.0.1:<port>.
 *   - A request with a non-localhost Host header gets 403 (DNS-rebinding guard).
 *   - A request with a valid localhost Host header proceeds (does not 403).
 *   - close() stops the server (subsequent requests fail / server is closed).
 *   - Multiple requests to the same server work correctly.
 *
 * Uses a real ephemeral server on port 0 so the OS picks a free port.
 * All data-source modules are mocked so no real ~/.ashlr I/O occurs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as path from 'node:path';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import type { AshlrConfig, WebServerOptions } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Module mocks — prevent real I/O from data-source modules
// ---------------------------------------------------------------------------

vi.mock('../src/core/dashboard.js', () => ({
  buildSnapshot: vi.fn(async () => ({
    generatedAt: new Date().toISOString(),
    repos: { total: 0, dirty: 0, stale: 0 },
    tools: { installed: 0, total: 0 },
    activity: { sessions: 0, tokens: 0, estCostUsd: 0, commits: 0 },
    runs: [],
    swarms: [],
    mcp: [],
    genome: { entries: 0, projects: 0 },
  })),
}));

vi.mock('../src/core/run/orchestrator.js', () => ({
  listRuns: vi.fn(() => []),
  loadRun: vi.fn(() => null),
  runGoal: vi.fn(async () => ({})),
}));

vi.mock('../src/core/swarm/store.js', () => ({
  listSwarms: vi.fn(() => []),
  loadSwarm: vi.fn(() => null),
}));

vi.mock('../src/core/observability/rollup.js', () => ({
  buildRollup: vi.fn(() => ({
    window: '7d',
    since: new Date().toISOString(),
    totals: { tokensIn: 0, tokensOut: 0, estCostUsd: 0, sessions: 0, commits: 0 },
    byProject: [],
    byDay: [],
    byModel: [],
    budget: { level: 'ok', window: '7d', spentUsd: 0, capUsd: null, spentTokens: 0, capTokens: null, message: 'ok' },
  })),
}));

vi.mock('../src/core/genome/store.js', () => ({
  loadGenome: vi.fn(() => []),
  genomeHealth: vi.fn(async () => ({
    totalEntries: 0, projects: 0, hubEntries: 0, sizeBytes: 0,
    lastLearnedAt: null, embeddingsAvailable: false,
  })),
}));

vi.mock('../src/core/genome/recall.js', () => ({
  recall: vi.fn(async () => []),
}));

vi.mock('../src/cli/run.js', () => ({
  cmdRun: vi.fn(async () => 0),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { startServer, assetsDir } from '../src/core/web/server.js';
import { runGoal } from '../src/core/run/orchestrator.js';
import { enroll } from '../src/core/sandbox/policy.js';
import { auditDir } from '../src/core/sandbox/audit.js';
import { createProposal, loadProposal } from '../src/core/inbox/store.js';

// ---------------------------------------------------------------------------
// Config fixture
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
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['ollama'],
    },
    telemetry: {},
    tools: {},
  };
}

function makeOpts(overrides: Partial<WebServerOptions> = {}): WebServerOptions {
  return {
    port: 0,         // 0 = let OS pick a free port
    open: false,
    allowDispatch: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// HTTP helper: make a GET request and return { statusCode, body }
// ---------------------------------------------------------------------------

function httpGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function httpPost(
  url: string,
  port: number,
  token: string,
  idempotencyKey: string,
  body: unknown,
): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const encoded = JSON.stringify(body);
    const req = http.request({
      hostname: parsed.hostname,
      port: Number(parsed.port),
      path: parsed.pathname,
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${port}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(encoded),
        'x-ashlr-token': token,
        'x-ashlr-idempotency-key': idempotencyKey,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({
        statusCode: res.statusCode ?? 0,
        body: data,
        headers: res.headers,
      }));
    });
    req.on('error', reject);
    req.end(encoded);
  });
}

// ---------------------------------------------------------------------------
// Track open handles for cleanup
// ---------------------------------------------------------------------------

let openHandles: Array<{ close(): Promise<void> }> = [];
let serverTestHome = '';
let previousHome: string | undefined;
let previousUserProfile: string | undefined;

beforeEach(() => {
  openHandles = [];
  serverTestHome = mkdtempSync(path.join(tmpdir(), 'ashlr-m14-server-'));
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = serverTestHome;
  process.env.USERPROFILE = serverTestHome;
});

afterEach(async () => {
  // Ensure every server opened in a test is closed even if the test throws
  for (const h of openHandles) {
    try { await h.close(); } catch { /* ignore */ }
  }
  openHandles = [];
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  rmSync(serverTestHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// startServer — basic shape
// ---------------------------------------------------------------------------

describe('startServer — handle shape', () => {
  it('resolves to an object with port, token, url, and close', async () => {
    const handle = await startServer(makeConfig(), makeOpts());
    openHandles.push(handle);

    expect(typeof handle.port).toBe('number');
    expect(typeof handle.token).toBe('string');
    expect(typeof handle.url).toBe('string');
    expect(typeof handle.close).toBe('function');
  });

  it('port is a positive integer', async () => {
    const handle = await startServer(makeConfig(), makeOpts());
    openHandles.push(handle);

    expect(handle.port).toBeGreaterThan(0);
    expect(Number.isInteger(handle.port)).toBe(true);
  });

  it('token is a non-empty string (crypto-generated hex)', async () => {
    const handle = await startServer(makeConfig(), makeOpts());
    openHandles.push(handle);

    expect(handle.token.length).toBeGreaterThan(0);
    // Token should only contain hex characters (randomBytes hex)
    expect(handle.token).toMatch(/^[0-9a-f]+$/i);
  });

  it('url is http://127.0.0.1:<port>', async () => {
    const handle = await startServer(makeConfig(), makeOpts());
    openHandles.push(handle);

    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}`);
  });

  it('each server gets a distinct token (entropy)', async () => {
    const h1 = await startServer(makeConfig(), makeOpts());
    const h2 = await startServer(makeConfig(), makeOpts());
    openHandles.push(h1, h2);

    expect(h1.token).not.toBe(h2.token);
  });
});

// ---------------------------------------------------------------------------
// startServer — binds on 127.0.0.1
// ---------------------------------------------------------------------------

describe('startServer — 127.0.0.1 binding', () => {
  it('server responds on 127.0.0.1:<port>', async () => {
    const handle = await startServer(makeConfig(), makeOpts());
    openHandles.push(handle);

    // A valid localhost request should get some non-connection-refused response
    const result = await httpGet(handle.url + '/api/snapshot', {
      Host: `127.0.0.1:${handle.port}`,
    });
    expect(result.statusCode).toBeGreaterThan(0);
    expect(result.statusCode).not.toBe(0);
  });

  it('assetsDir() returns an absolute path', () => {
    const dir = assetsDir();
    expect(typeof dir).toBe('string');
    // Use path.isAbsolute so the assertion holds on Windows (C:\...) too.
    expect(path.isAbsolute(dir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Security: Host-header allowlist (anti DNS-rebinding)
// ---------------------------------------------------------------------------

describe('startServer — Host-header DNS-rebinding guard', () => {
  it('returns 403 when Host header is a foreign domain', async () => {
    const handle = await startServer(makeConfig(), makeOpts());
    openHandles.push(handle);

    const result = await httpGet(handle.url + '/api/snapshot', {
      Host: 'evil.attacker.com',
    });
    expect(result.statusCode).toBe(403);
  });

  it('returns 403 when Host header is a lookalike subdomain', async () => {
    const handle = await startServer(makeConfig(), makeOpts());
    openHandles.push(handle);

    const result = await httpGet(handle.url + '/api/snapshot', {
      Host: '127.0.0.1.evil.com',
    });
    expect(result.statusCode).toBe(403);
  });

  it('returns 403 when Host header targets a different IP', async () => {
    const handle = await startServer(makeConfig(), makeOpts());
    openHandles.push(handle);

    const result = await httpGet(handle.url + '/api/snapshot', {
      Host: '10.0.0.1',
    });
    expect(result.statusCode).toBe(403);
  });

  it('does NOT return 403 for Host: 127.0.0.1:<port>', async () => {
    const handle = await startServer(makeConfig(), makeOpts());
    openHandles.push(handle);

    const result = await httpGet(handle.url + '/api/snapshot', {
      Host: `127.0.0.1:${handle.port}`,
    });
    // Should be 200 (not 403)
    expect(result.statusCode).not.toBe(403);
    expect(result.statusCode).toBe(200);
  });

  it('does NOT return 403 for Host: localhost:<port>', async () => {
    const handle = await startServer(makeConfig(), makeOpts());
    openHandles.push(handle);

    const result = await httpGet(handle.url + '/api/snapshot', {
      Host: `localhost:${handle.port}`,
    });
    expect(result.statusCode).not.toBe(403);
    expect(result.statusCode).toBe(200);
  });

  it('does NOT return 403 for Host: localhost (no port)', async () => {
    const handle = await startServer(makeConfig(), makeOpts());
    openHandles.push(handle);

    const result = await httpGet(handle.url + '/api/snapshot', {
      Host: 'localhost',
    });
    expect(result.statusCode).not.toBe(403);
  });

  it('does NOT return 403 for Host: 127.0.0.1 (no port)', async () => {
    const handle = await startServer(makeConfig(), makeOpts());
    openHandles.push(handle);

    const result = await httpGet(handle.url + '/api/snapshot', {
      Host: '127.0.0.1',
    });
    expect(result.statusCode).not.toBe(403);
  });

  it('403 response body does not leak server internals', async () => {
    const handle = await startServer(makeConfig(), makeOpts());
    openHandles.push(handle);

    const result = await httpGet(handle.url + '/api/snapshot', {
      Host: 'evil.attacker.com',
    });
    expect(result.statusCode).toBe(403);
    // Body should be short and not include stack traces or internal paths
    expect(result.body.length).toBeLessThan(200);
    expect(result.body).not.toContain('Error:');
    expect(result.body).not.toContain('at ');
  });
});

// ---------------------------------------------------------------------------
// close() — clean shutdown
// ---------------------------------------------------------------------------

describe('startServer — close()', () => {
  it('close() resolves without throwing', async () => {
    const handle = await startServer(makeConfig(), makeOpts());
    await expect(handle.close()).resolves.not.toThrow();
  });

  it('close() is idempotent (calling twice does not throw)', async () => {
    const handle = await startServer(makeConfig(), makeOpts());
    await handle.close();
    await expect(handle.close()).resolves.not.toThrow();
  });

  it('after close(), connection to the server is refused or times out', async () => {
    const handle = await startServer(makeConfig(), makeOpts());
    const { port } = handle;
    await handle.close();

    // After close, connection should be refused (ECONNREFUSED)
    await expect(
      httpGet(`http://127.0.0.1:${port}/api/snapshot`, {
        Host: `127.0.0.1:${port}`,
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Security invariant: no secrets in any response
// ---------------------------------------------------------------------------

describe('startServer — no secrets in responses', () => {
  it('snapshot response does not contain the session token', async () => {
    const handle = await startServer(makeConfig(), makeOpts());
    openHandles.push(handle);

    const result = await httpGet(handle.url + '/api/snapshot', {
      Host: `127.0.0.1:${handle.port}`,
    });
    expect(result.body).not.toContain(handle.token);
  });
});

describe('startServer — scoped mutation authority', () => {
  it('enforces operator and approver roles through real server sessions', async () => {
    const operator = await startServer(makeConfig(), makeOpts({
      allowDispatch: true,
      mutationRole: 'operator',
    }));
    const approver = await startServer(makeConfig(), makeOpts({
      allowDispatch: true,
      mutationRole: 'approver',
    }));
    openHandles.push(operator, approver);

    const operatorApproval = await httpPost(
      `${operator.url}/api/inbox/missing/approve`, operator.port, operator.token,
      'm14-server-operator-denied', {},
    );
    const approverDispatch = await httpPost(
      `${approver.url}/api/run`, approver.port, approver.token,
      'm14-server-approver-denied', { goal: 'must not run' },
    );

    expect(operatorApproval.statusCode).toBe(403);
    expect(approverDispatch.statusCode).toBe(403);
  });

  it('executes a caller idempotency key once and returns its completion on replay', async () => {
    vi.mocked(runGoal).mockClear();
    vi.mocked(runGoal).mockResolvedValue({
      id: 'run-once', status: 'completed', goal: 'execute once', usage: {},
    } as never);
    const handle = await startServer(makeConfig(), makeOpts({
      allowDispatch: true,
      mutationRole: 'operator',
    }));
    openHandles.push(handle);
    const key = 'm14-server-execute-once';

    const first = await httpPost(
      `${handle.url}/api/run`, handle.port, handle.token, key, { goal: 'execute once' },
    );
    const replay = await httpPost(
      `${handle.url}/api/run`, handle.port, handle.token, key, { goal: 'execute once' },
    );
    const conflict = await httpPost(
      `${handle.url}/api/run`, handle.port, handle.token, key, { goal: 'different mutation' },
    );

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(JSON.parse(replay.body)).toEqual({
      idempotency: {
        replayed: true,
        state: 'completed',
        outcome: 'succeeded',
        status: 200,
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(vi.mocked(runGoal)).toHaveBeenCalledTimes(1);
  });

  it('reconciles an exact completion after a server restart with a new token', async () => {
    vi.mocked(runGoal).mockClear();
    vi.mocked(runGoal).mockResolvedValue({
      id: 'restart-run', status: 'completed', goal: 'survive restart', usage: {},
    } as never);
    const firstServer = await startServer(makeConfig(), makeOpts({
      allowDispatch: true,
      mutationRole: 'operator',
    }));
    openHandles.push(firstServer);
    const key = 'm14-server-restart-replay';
    const first = await httpPost(
      `${firstServer.url}/api/run`, firstServer.port, firstServer.token, key,
      { goal: 'survive restart', secret: 'must-not-be-replayed' },
    );
    expect(first.statusCode).toBe(200);
    await firstServer.close();

    const restarted = await startServer(makeConfig(), makeOpts({
      allowDispatch: true,
      mutationRole: 'operator',
    }));
    openHandles.push(restarted);
    expect(restarted.token).not.toBe(firstServer.token);
    const replay = await httpPost(
      `${restarted.url}/api/run`, restarted.port, restarted.token, key,
      { goal: 'survive restart', secret: 'must-not-be-replayed' },
    );

    expect(replay.statusCode).toBe(200);
    expect(JSON.parse(replay.body)).toEqual({
      idempotency: {
        replayed: true,
        state: 'completed',
        outcome: 'succeeded',
        status: 200,
      },
    });
    expect(replay.body).not.toContain('must-not-be-replayed');
    expect(vi.mocked(runGoal)).toHaveBeenCalledTimes(1);
  });

  it('replays completed policy and proposal mutations without duplicate effects', async () => {
    const handle = await startServer(makeConfig(), makeOpts({
      allowDispatch: true,
      mutationRole: 'owner',
    }));
    openHandles.push(handle);

    const pauseKey = 'm14-server-pause-once';
    const pause = await httpPost(
      `${handle.url}/api/fleet/pause`, handle.port, handle.token, pauseKey, {},
    );
    const pauseReplay = await httpPost(
      `${handle.url}/api/fleet/pause`, handle.port, handle.token, pauseKey, {},
    );
    expect(pause.statusCode).toBe(200);
    expect(pauseReplay.statusCode).toBe(200);
    expect(JSON.parse(pauseReplay.body)).toMatchObject({
      idempotency: { replayed: true, state: 'completed', outcome: 'succeeded' },
    });

    const proposal = createProposal({
      repo: null,
      origin: 'manual',
      kind: 'note',
      title: 'real-server apply once',
      summary: 'idempotency regression',
    });
    const applyKey = 'm14-server-apply-once';
    const applied = await httpPost(
      `${handle.url}/api/inbox/${proposal.id}/approve`,
      handle.port, handle.token, applyKey, {},
    );
    const applyReplay = await httpPost(
      `${handle.url}/api/inbox/${proposal.id}/approve`,
      handle.port, handle.token, applyKey, {},
    );
    expect(applied.statusCode).toBe(200);
    expect(applyReplay.statusCode).toBe(200);
    expect(JSON.parse(applyReplay.body)).toMatchObject({
      idempotency: { replayed: true, state: 'completed', outcome: 'succeeded', status: 200 },
    });
    expect(loadProposal(proposal.id)?.status).toBe('applied');
  });

  it.runIf(process.platform !== 'win32')('rejects a physical symlink escape through the real server', async () => {
    const repo = path.join(serverTestHome, 'repo');
    const outside = path.join(serverTestHome, 'outside.txt');
    mkdirSync(repo);
    writeFileSync(outside, 'outside');
    symlinkSync(outside, path.join(repo, 'escape.txt'));
    expect(enroll(repo).ok).toBe(true);
    const handle = await startServer(makeConfig(), makeOpts({
      allowDispatch: true,
      mutationRole: 'operator',
      requireMutationAuditReceipts: false,
    }));
    openHandles.push(handle);

    const response = await httpPost(
      `${handle.url}/api/open`, handle.port, handle.token,
      'm14-server-symlink-escape', { repo, file: 'escape.txt', action: 'editor' },
    );

    expect(response.statusCode).toBe(403);
  });

  it.runIf(process.platform !== 'win32')('fails closed through the real server when audit append is unsafe', async () => {
    vi.mocked(runGoal).mockClear();
    mkdirSync(auditDir(), { recursive: true, mode: 0o700 });
    chmodSync(path.join(serverTestHome, '.ashlr'), 0o700);
    chmodSync(auditDir(), 0o700);
    const outside = path.join(serverTestHome, 'audit-target');
    writeFileSync(outside, 'sentinel\n', { mode: 0o600 });
    symlinkSync(outside, path.join(auditDir(), `${new Date().toISOString().slice(0, 10)}.jsonl`));
    const handle = await startServer(makeConfig(), makeOpts({
      allowDispatch: true,
      mutationRole: 'operator',
    }));
    openHandles.push(handle);

    const response = await httpPost(
      `${handle.url}/api/run`, handle.port, handle.token,
      'm14-server-audit-failure', { goal: 'must not run' },
    );

    expect(response.statusCode).toBe(503);
    expect(vi.mocked(runGoal)).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== 'win32')('persists terminal state when completion audit fails after the effect', async () => {
    vi.mocked(runGoal).mockClear();
    const outside = path.join(serverTestHome, 'post-effect-audit-target');
    writeFileSync(outside, 'sentinel\n', { mode: 0o600 });
    vi.mocked(runGoal).mockImplementationOnce(async () => {
      const daily = path.join(auditDir(), `${new Date().toISOString().slice(0, 10)}.jsonl`);
      rmSync(daily, { force: true });
      symlinkSync(outside, daily);
      return {
        id: 'audit-degraded-run',
        status: 'completed',
        goal: 'effect already happened',
        usage: {},
      } as never;
    });
    const handle = await startServer(makeConfig(), makeOpts({
      allowDispatch: true,
      mutationRole: 'operator',
    }));
    openHandles.push(handle);
    const key = 'm14-server-post-effect-audit-failure';
    const first = await httpPost(
      `${handle.url}/api/run`, handle.port, handle.token, key,
      { goal: 'effect already happened' },
    );
    const replay = await httpPost(
      `${handle.url}/api/run`, handle.port, handle.token, key,
      { goal: 'effect already happened' },
    );

    expect(first.statusCode).toBe(200);
    expect(first.headers['x-ashlr-audit-degraded']).toBe('completion-receipt-unavailable');
    expect(replay.statusCode).toBe(200);
    expect(JSON.parse(replay.body)).toMatchObject({
      idempotency: { replayed: true, state: 'completed', outcome: 'succeeded' },
    });
    expect(vi.mocked(runGoal)).toHaveBeenCalledTimes(1);
    expect(readFileSync(outside, 'utf8')).toBe('sentinel\n');
  });
});
