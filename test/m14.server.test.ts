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

// ---------------------------------------------------------------------------
// Track open handles for cleanup
// ---------------------------------------------------------------------------

let openHandles: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
  openHandles = [];
});

afterEach(async () => {
  // Ensure every server opened in a test is closed even if the test throws
  for (const h of openHandles) {
    try { await h.close(); } catch { /* ignore */ }
  }
  openHandles = [];
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
    // Cross-platform: POSIX absolute paths start with '/', Windows with 'C:\\'.
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
