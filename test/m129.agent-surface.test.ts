/**
 * M129 — agent-readable fleet surface.
 *
 * Tests:
 *  1. Each new tool (ashlr_fleet_status, ashlr_scorecard, ashlr_oversight,
 *     ashlr_routing) is registered with safety:'read'.
 *  2. Each tool's handler returns the expected top-level shape from empty stores.
 *  3. None of the tools throw on empty/missing data.
 *  4. GET /api/fleet-state returns the combined JSON envelope.
 *  5. Contract count: total native tools is now 21.
 *
 * Hermetic: every test runs under an isolated tmp HOME (h1-fixture); no real
 * ~/.ashlr is ever touched, no network, no downstream MCP servers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';
import {
  nativeToolDefs,
  callNativeTool,
} from '../src/core/mcp-native.js';
import { handleApi } from '../src/core/web/api.js';
import { recordAgentAction } from '../src/core/fleet/agent-action-ledger.js';

let fx: H1Fixture;

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resultText(r: { content: { type: 'text'; text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

function resultJson(r: { content: { type: 'text'; text: string }[] }): unknown {
  return JSON.parse(resultText(r));
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

describe('M129 native tool registration', () => {
  it('total native tool count is now 21', () => {
    expect(nativeToolDefs()).toHaveLength(21);
  });

  const newTools = ['ashlr_fleet_status', 'ashlr_scorecard', 'ashlr_oversight', 'ashlr_routing'];

  for (const name of newTools) {
    it(`${name} is registered as safety:'read'`, () => {
      const def = nativeToolDefs().find((t) => t.name === name);
      expect(def).toBeTruthy();
      expect(def!.safety).toBe('read');
    });
  }
});

// ---------------------------------------------------------------------------
// ashlr_fleet_status
// ---------------------------------------------------------------------------

describe('ashlr_fleet_status', () => {
  it('returns expected top-level shape on empty stores', async () => {
    const r = await callNativeTool('ashlr_fleet_status', {});
    expect(r.isError).toBeUndefined();
    const payload = resultJson(r) as Record<string, unknown>;
    expect(typeof payload['running']).toBe('boolean');
    expect(typeof payload['todaySpentUsd']).toBe('number');
    expect(typeof payload['itemsProcessed']).toBe('number');
    expect(typeof payload['pendingProposals']).toBe('number');
    expect(Array.isArray(payload['recentTicks'])).toBe(true);
    expect(typeof payload['digest']).toBe('object');
  });

  it('never throws on empty daemon state', async () => {
    const r = await callNativeTool('ashlr_fleet_status', {});
    expect(r.isError).toBeUndefined();
  });

  it('digest section has expected keys', async () => {
    const r = await callNativeTool('ashlr_fleet_status', {});
    const payload = resultJson(r) as Record<string, unknown>;
    const digest = payload['digest'] as Record<string, unknown>;
    expect(typeof digest['totalProposed']).toBe('number');
    expect(typeof digest['totalAutoMerged']).toBe('number');
    expect(typeof digest['totalDeclined']).toBe('number');
    expect(Array.isArray(digest['repos'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ashlr_scorecard
// ---------------------------------------------------------------------------

describe('ashlr_scorecard', () => {
  it('returns QualityMetrics shape with default window', async () => {
    const r = await callNativeTool('ashlr_scorecard', {});
    expect(r.isError).toBeUndefined();
    const payload = resultJson(r) as Record<string, unknown>;
    expect(typeof payload['window']).toBe('string');
    expect(typeof payload['proposalsCreated']).toBe('number');
    expect(typeof payload['merged']).toBe('number');
    expect(typeof payload['acceptRate']).toBe('number');
    expect(typeof payload['byEngine']).toBe('object');
    expect(typeof payload['byRepo']).toBe('object');
  });

  it('accepts window param: 30d', async () => {
    const r = await callNativeTool('ashlr_scorecard', { window: '30d' });
    expect(r.isError).toBeUndefined();
    const payload = resultJson(r) as Record<string, unknown>;
    expect(payload['window']).toBe('30d');
  });

  it('accepts window param: all', async () => {
    const r = await callNativeTool('ashlr_scorecard', { window: 'all' });
    expect(r.isError).toBeUndefined();
    const payload = resultJson(r) as Record<string, unknown>;
    expect(payload['window']).toBe('all');
  });

  it('rejects invalid window value', async () => {
    const r = await callNativeTool('ashlr_scorecard', { window: '90d' });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toContain('must be one of');
  });

  it('never throws on empty stores', async () => {
    const r = await callNativeTool('ashlr_scorecard', { window: '7d' });
    expect(r.isError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ashlr_oversight
// ---------------------------------------------------------------------------

describe('ashlr_oversight', () => {
  it('returns OversightSnapshot shape on empty stores', async () => {
    const r = await callNativeTool('ashlr_oversight', {});
    expect(r.isError).toBeUndefined();
    const payload = resultJson(r) as Record<string, unknown>;
    expect(typeof payload['generatedAt']).toBe('string');
    expect(typeof payload['scorecard']).toBe('object');
    expect(typeof payload['goals']).toBe('object');
    // manager and vision may be null when no reports exist
    expect('manager' in payload).toBe(true);
    expect('vision' in payload).toBe(true);
  });

  it('goals section has active/done/progressPct', async () => {
    const r = await callNativeTool('ashlr_oversight', {});
    const payload = resultJson(r) as Record<string, unknown>;
    const goals = payload['goals'] as Record<string, unknown>;
    expect(typeof goals['active']).toBe('number');
    expect(typeof goals['done']).toBe('number');
    expect(typeof goals['progressPct']).toBe('number');
  });

  it('never throws on missing manager/vision dirs', async () => {
    const r = await callNativeTool('ashlr_oversight', {});
    expect(r.isError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ashlr_routing
// ---------------------------------------------------------------------------

describe('ashlr_routing', () => {
  it('returns { recent, modelSplit } (empty ok) on empty decisions ledger', async () => {
    const r = await callNativeTool('ashlr_routing', {});
    expect(r.isError).toBeUndefined();
    const payload = resultJson(r) as { recent: unknown[]; modelSplit: Record<string, number> };
    expect(Array.isArray(payload.recent)).toBe(true);
    expect(typeof payload.modelSplit).toBe('object');
  });

  it('never throws on missing decisions dir', async () => {
    const r = await callNativeTool('ashlr_routing', {});
    expect(r.isError).toBeUndefined();
  });

  it('respects limit argument', async () => {
    const r = await callNativeTool('ashlr_routing', { limit: 5 });
    expect(r.isError).toBeUndefined();
    const payload = resultJson(r) as { recent: unknown[]; modelSplit: Record<string, number> };
    expect(payload.recent.length).toBeLessThanOrEqual(5);
  });

  it('rejects non-number limit', async () => {
    const r = await callNativeTool('ashlr_routing', { limit: 'ten' });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toContain('"limit" must be a number');
  });
});

// ---------------------------------------------------------------------------
// GET /api/fleet-state
// ---------------------------------------------------------------------------

describe('GET /api/fleet-state', () => {
  /** Build a minimal mock request for GET /api/fleet-state. */
  function makeReq(): IncomingMessage {
    return {
      url: '/api/fleet-state',
      method: 'GET',
      headers: {},
      on: () => undefined,
    } as unknown as IncomingMessage;
  }

  /** Capture sendJson output from handleApi. */
  function makeRes(): { res: ServerResponse; status: () => number; body: () => unknown } {
    let capturedStatus = 0;
    let capturedBody: unknown = null;
    const res = {
      headersSent: false,
      writeHead(status: number) {
        capturedStatus = status;
      },
      end(payload: string) {
        try { capturedBody = JSON.parse(payload); } catch { capturedBody = payload; }
      },
    } as unknown as ServerResponse;
    return {
      res,
      status: () => capturedStatus,
      body: () => capturedBody,
    };
  }

  it('returns 200 with the combined fleet-state envelope', async () => {
    const prevAshlrHome = process.env.ASHLR_HOME;
    let handled = false;
    const cfg = makeCfg();
    const { res, status, body } = makeRes();
    try {
      process.env.ASHLR_HOME = fx.ashlrDir;
      recordAgentAction({
        schemaVersion: 1,
        ts: new Date().toISOString(),
        machineId: 'm129',
        actor: 'daemon',
        kind: 'dispatch',
        outcome: 'proposal-created',
        action: 'daemon:dispatch',
        summary: 'codex proposal-created for API surface test',
        repo: '/repo/alpha',
        itemId: 'item-a',
        source: 'goal',
        proposalId: 'prop-a',
        backend: 'codex',
        tier: 'frontier',
        model: 'gpt-5.5',
      });
      handled = await handleApi(makeReq(), res, cfg, { token: 'test', allowDispatch: false });
    } finally {
      if (prevAshlrHome === undefined) delete process.env.ASHLR_HOME;
      else process.env.ASHLR_HOME = prevAshlrHome;
    }

    expect(handled).toBe(true);
    expect(status()).toBe(200);

    const payload = body() as Record<string, unknown>;
    expect(typeof payload['generatedAt']).toBe('string');
    // Each section is present (may be null if degrade path fires, but key exists)
    expect('daemon' in payload).toBe(true);
    expect('scorecard' in payload).toBe(true);
    expect('oversight' in payload).toBe(true);
    expect('routing' in payload).toBe(true);
    expect('workspace' in payload).toBe(true);
    const workspace = payload['workspace'] as { eventCount?: number; recentActions?: unknown[] };
    expect(workspace.eventCount).toBe(1);
    expect(Array.isArray(workspace.recentActions)).toBe(true);
  });

  it('routing section has recent array and modelSplit object', async () => {
    const cfg = makeCfg();
    const { res, body } = makeRes();
    await handleApi(makeReq(), res, cfg, { token: 'test', allowDispatch: false });
    const payload = body() as Record<string, unknown>;
    const routing = payload['routing'] as { recent: unknown[]; modelSplit: Record<string, number> };
    expect(Array.isArray(routing.recent)).toBe(true);
    expect(typeof routing.modelSplit).toBe('object');
  });

  it('does not require auth token (read-only endpoint)', async () => {
    const cfg = makeCfg();
    const { res, status } = makeRes();
    // No token header — should still return 200
    await handleApi(makeReq(), res, cfg, { token: '', allowDispatch: false });
    expect(status()).toBe(200);
  });
});
