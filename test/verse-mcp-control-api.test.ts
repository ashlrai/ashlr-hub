/**
 * Tests for src/core/verse/mcp-control-api.ts — the HTTP surface.
 *
 * What is proven here:
 *
 *   1. THE GATE IS ON EVERY MUTATING ROUTE, including `cli-probe`, which is a
 *      POST precisely because it spawns provider CLIs. Without
 *      `--allow-dispatch` the routes 404 (they do not exist); with dispatch
 *      but no token they 401; with a token but the wrong content type, 415.
 *   2. `apply` demands BOTH an explicit `confirm: true` and the digest. The
 *      "one-click install" shape is not reachable through the wire.
 *   3. Unknown body keys are rejected rather than ignored.
 *   4. The two GETs are genuinely free — they answer without a token.
 *   5. A refusal is a 409 carrying the full result body, matching the
 *      convention `VerseScopeResult` established and the web client reads.
 *
 * Hermetic: an in-memory request/response pair, an explicit tmp accounts root,
 * no socket bind and no subprocess — so this belongs in the fast unit lane.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import type { AshlrConfig } from '../src/core/types.js';
import {
  handleVerseMcpApi,
  isVerseMcpPath,
  verseMcpSeatInputs,
  type VerseMcpApiContext,
} from '../src/core/verse/mcp-control-api.js';

const TOKEN = 'test-token-0123456789';

let home: string;
let accountsRoot: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ashlr-mcp-api-'));
  accountsRoot = join(home, 'account-connections');
  mkdirSync(accountsRoot, { recursive: true });
  writeFileSync(join(accountsRoot, 'connections.json'), JSON.stringify({
    schemaVersion: 1,
    accounts: [{ id: 'claude', label: 'Claude Code', provider: 'claude', command: ['/usr/bin/node', '/p/launcher.mjs'] }],
  }));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

interface Captured { status: number; body: unknown }

/** Minimal in-memory request/response pair — no socket, no server. */
async function call(
  method: string,
  path: string,
  options: { token?: string; contentType?: string; body?: unknown; allowDispatch?: boolean } = {},
): Promise<Captured> {
  const payload = options.body === undefined ? '' : JSON.stringify(options.body);
  const req = Readable.from([payload]) as unknown as IncomingMessage;
  (req as { headers: Record<string, string> }).headers = {
    ...(options.token !== undefined ? { 'x-ashlr-token': options.token } : {}),
    ...(options.contentType !== undefined ? { 'content-type': options.contentType } : {}),
  };
  (req as { url?: string }).url = path;
  (req as { method?: string }).method = method;

  let captured: Captured = { status: 0, body: null };
  const res = {
    headersSent: false,
    writeHead(status: number) { captured = { ...captured, status }; return res; },
    end(chunk?: string) {
      captured = { ...captured, body: chunk === undefined || chunk === '' ? null : JSON.parse(chunk) as unknown };
      return res;
    },
  } as unknown as ServerResponse;

  const ctx: VerseMcpApiContext = {
    cfg: {} as AshlrConfig,
    token: TOKEN,
    allowDispatch: options.allowDispatch ?? true,
    accountsRoot,
  };

  const handled = await handleVerseMcpApi(ctx, req, res, path, method);
  expect(handled).toBe(true);
  return captured;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe('isVerseMcpPath', () => {
  it('matches exactly the five routes', () => {
    for (const path of [
      '/api/verse/mcp',
      '/api/verse/mcp/cli-health',
      '/api/verse/mcp/cli-probe',
      '/api/verse/mcp/proposal',
      '/api/verse/mcp/apply',
    ]) {
      expect(isVerseMcpPath(path), path).toBe(true);
    }
  });

  it('does not swallow neighbouring verse routes', () => {
    for (const path of ['/api/verse/control', '/api/verse/accounts', '/api/verse/mcp/', '/api/verse/mcpx']) {
      expect(isVerseMcpPath(path), path).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The free reads
// ---------------------------------------------------------------------------

describe('the two GETs are free', () => {
  it('serves the per-seat view without a mutation token', async () => {
    const res = await call('GET', '/api/verse/mcp');
    expect(res.status).toBe(200);
    const body = res.body as { seats: Array<{ seatId: string; reason: string }> };
    const claude = body.seats.find((s) => s.seatId === 'claude');
    expect(claude?.reason).toBe('mcp-seat-isolated-by-adapter');
  });

  it('serves CLI health without a mutation token', async () => {
    const res = await call('GET', '/api/verse/mcp/cli-health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('driftDetected');
    expect(res.body).toHaveProperty('accounts');
  });

  it('404s a wrong method on a read route', async () => {
    expect((await call('DELETE', '/api/verse/mcp')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe('every mutating route is behind the same gate', () => {
  const mutating = ['/api/verse/mcp/cli-probe', '/api/verse/mcp/proposal', '/api/verse/mcp/apply'];

  it('404s when the server was started without --allow-dispatch', async () => {
    for (const path of mutating) {
      const res = await call('POST', path, {
        allowDispatch: false, token: TOKEN, contentType: 'application/json', body: {},
      });
      expect(res.status, path).toBe(404);
    }
  });

  it('401s without the token', async () => {
    for (const path of mutating) {
      const res = await call('POST', path, { contentType: 'application/json', body: {} });
      expect(res.status, path).toBe(401);
    }
  });

  it('401s on a wrong token', async () => {
    for (const path of mutating) {
      const res = await call('POST', path, { token: 'wrong', contentType: 'application/json', body: {} });
      expect(res.status, path).toBe(401);
    }
  });

  it('415s without a JSON content type', async () => {
    for (const path of mutating) {
      const res = await call('POST', path, { token: TOKEN, contentType: 'text/plain', body: {} });
      expect(res.status, path).toBe(415);
    }
  });

  it('the version probe is a POST, not a GET — it spawns', async () => {
    expect((await call('GET', '/api/verse/mcp/cli-probe')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Proposal / apply over the wire
// ---------------------------------------------------------------------------

const SERVER = { name: 'weather', command: '/usr/local/bin/weather-mcp', args: ['--serve'] };

function post(path: string, body: unknown) {
  return call('POST', path, { token: TOKEN, contentType: 'application/json', body });
}

describe('proposal and apply', () => {
  it('rejects an unknown body key rather than ignoring it', async () => {
    const res = await post('/api/verse/mcp/proposal', { target: 'hub', server: SERVER, force: true });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain('unknown key');
  });

  it('requires target and server', async () => {
    expect((await post('/api/verse/mcp/proposal', { server: SERVER })).status).toBe(400);
    expect((await post('/api/verse/mcp/proposal', { target: 'hub' })).status).toBe(400);
  });

  it('refuses apply without confirm, even with a valid digest', async () => {
    const proposal = await post('/api/verse/mcp/proposal', { target: 'hub', server: SERVER });
    expect(proposal.status).toBe(200);
    const digest = (proposal.body as { digest: string }).digest;

    const res = await post('/api/verse/mcp/apply', { target: 'hub', server: SERVER, digest });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain('confirm must be true');
  });

  it('refuses apply without a digest, even with confirm', async () => {
    const res = await post('/api/verse/mcp/apply', { target: 'hub', server: SERVER, confirm: true });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain('digest is required');
  });

  it('answers a refusal as a 409 carrying the full result body', async () => {
    const res = await post('/api/verse/mcp/proposal', { target: 'nowhere', server: SERVER });
    expect(res.status).toBe(409);
    const body = res.body as { ok: boolean; refusal: string; note: string };
    expect(body.ok).toBe(false);
    expect(body.refusal).toBe('mcp-target-unknown');
    // The convention the web client depends on: a `note` is always present.
    expect(typeof body.note).toBe('string');
  });

  it('a proposal response discloses the command and redacts the env', async () => {
    const res = await post('/api/verse/mcp/proposal', {
      target: 'hub',
      server: { ...SERVER, env: { KEY: 'REDACTION-CANARY-B' } },
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('REDACTION-CANARY-B');
    const body = res.body as { server: { command: string; env: Record<string, string> } };
    expect(body.server.command).toBe('/usr/local/bin/weather-mcp');
    expect(body.server.env).toEqual({ KEY: '<set>' });
  });
});

// ---------------------------------------------------------------------------
// Seat inputs
// ---------------------------------------------------------------------------

describe('verseMcpSeatInputs', () => {
  it('lists one row per account plus one collapsed local row', () => {
    const seats = verseMcpSeatInputs(accountsRoot);
    expect(seats.map((s) => s.id)).toEqual(['claude', 'local']);
    expect(seats.find((s) => s.id === 'local')?.engine).toBe('local');
  });
});
