/**
 * GET /api/inbox history filtering (?status=&since=&limit=) and the
 * decisions-ledger join on GET /api/inbox/:id (`decisionEvidence`), added
 * alongside the inbox proposal-review operator-console view.
 *
 * Invariants under test:
 *   - No query params at all -> byte-identical to the pre-existing
 *     pending-only response (see m32.inbox-api.test.ts for that contract).
 *   - `?status=` is validated against the fixed set; invalid -> 400.
 *   - `?since=` is parsed strictly (Date.parse); invalid -> 400.
 *   - `?limit=` must be a positive integer; invalid -> 400. Explicit limits
 *     are honored (bounded), and the response reports `total`/`truncated`.
 *   - `?status=rejected`/`?status=all` actually returns non-pending
 *     proposals — the whole point: the web surface could only ever return
 *     pending before this.
 *   - GET /api/inbox/:id's `decisionEvidence` reflects the real decisions
 *     ledger: 'missing' sourceState when no ledger exists yet, and a
 *     recorded judge-parse-failure round-trips with its distinct
 *     `judgeReasonCode` — never conflated with a real `judge-review`.
 *
 * Hermetic: tmp HOME (h1-fixture), real ephemeral server on 127.0.0.1.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';

import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';
import { createProposal, setStatus } from '../src/core/inbox/store.js';
import { recordDecision } from '../src/core/fleet/decisions-ledger.js';
import type { WebServerOptions } from '../src/core/types.js';

let fx: H1Fixture;
let openHandles: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
  openHandles = [];
});

afterEach(async () => {
  for (const h of openHandles) {
    try { await h.close(); } catch { /* ignore */ }
  }
  openHandles = [];
  fx.cleanup();
});

function makeOpts(overrides: Partial<WebServerOptions> = {}): WebServerOptions {
  return { port: 0, open: false, allowDispatch: false, ...overrides };
}

function request(method: string, url: string, port: number, headers: Record<string, string> = {}): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method,
        headers: { Host: `127.0.0.1:${port}`, ...(method === 'GET' ? readAuthHeaders(port) : {}), ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function makeNote(title: string): string {
  return createProposal({ repo: null, origin: 'manual', kind: 'note', title, summary: 'inbox history test fixture' }).id;
}

describe('GET /api/inbox — history filtering', () => {
  it('no query params: byte-identical shape to the original pending-only response', async () => {
    makeNote('still pending');
    const h = await startServer(makeCfg(), makeOpts());
    openHandles.push(h);

    const res = await request('GET', `${h.url}/api/inbox`, h.port);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { pending: number; proposals: Array<{ status: string }> };
    expect(body.pending).toBe(1);
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]!.status).toBe('pending');
  });

  it('rejects an invalid ?status= with 400 and lists the valid set', async () => {
    const h = await startServer(makeCfg(), makeOpts());
    openHandles.push(h);
    const res = await request('GET', `${h.url}/api/inbox?status=bogus`, h.port);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('status must be one of');
  });

  it('rejects an unparseable ?since= with 400', async () => {
    const h = await startServer(makeCfg(), makeOpts());
    openHandles.push(h);
    const res = await request('GET', `${h.url}/api/inbox?since=not-a-date`, h.port);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('since must be');
  });

  it('rejects a non-positive-integer ?limit= with 400', async () => {
    const h = await startServer(makeCfg(), makeOpts());
    openHandles.push(h);
    for (const bad of ['0', '-1', 'abc', '1.5']) {
      const res = await request('GET', `${h.url}/api/inbox?limit=${bad}`, h.port);
      expect(res.statusCode).toBe(400);
    }
  });

  it('?status=rejected actually returns rejected proposals — the whole point of this change', async () => {
    const rejectedId = makeNote('will be rejected');
    makeNote('stays pending');
    expect(setStatus(rejectedId, 'rejected')).toBe(true);

    const h = await startServer(makeCfg(), makeOpts());
    openHandles.push(h);

    const res = await request('GET', `${h.url}/api/inbox?status=rejected`, h.port);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { proposals: Array<{ id: string; status: string }>; total: number; filters: unknown };
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]!.id).toBe(rejectedId);
    expect(body.proposals[0]!.status).toBe('rejected');
    expect(body.total).toBe(2); // total across all statuses, not just the filtered set
    expect(body.filters).toEqual({ status: 'rejected', since: null, limit: null });
  });

  it('?status=all returns every status, and an explicit ?limit= caps + reports truncated', async () => {
    const rejectedId = makeNote('a');
    makeNote('b');
    makeNote('c');
    expect(setStatus(rejectedId, 'rejected')).toBe(true);

    const h = await startServer(makeCfg(), makeOpts());
    openHandles.push(h);

    const all = await request('GET', `${h.url}/api/inbox?status=all`, h.port);
    const allBody = JSON.parse(all.body) as { proposals: unknown[]; total: number; truncated: boolean };
    expect(allBody.proposals).toHaveLength(3);
    expect(allBody.total).toBe(3);
    expect(allBody.truncated).toBe(false);

    const capped = await request('GET', `${h.url}/api/inbox?status=all&limit=2`, h.port);
    const cappedBody = JSON.parse(capped.body) as { proposals: unknown[]; truncated: boolean; filters: { limit: number | null } };
    expect(cappedBody.proposals).toHaveLength(2);
    expect(cappedBody.truncated).toBe(true);
    expect(cappedBody.filters.limit).toBe(2);
  });
});

describe('GET /api/inbox/:id — decisionEvidence join', () => {
  it('reports sourceState "missing" when no decisions ledger exists yet, never invents a verdict', async () => {
    const id = makeNote('no ledger yet');
    const h = await startServer(makeCfg(), makeOpts());
    openHandles.push(h);

    const res = await request('GET', `${h.url}/api/inbox/${id}`, h.port);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      decisionEvidence: { sourceQuality: { sourceState: string; complete: boolean }; decisions: unknown[] };
    };
    expect(body.decisionEvidence.sourceQuality.sourceState).toBe('missing');
    expect(body.decisionEvidence.decisions).toEqual([]);
  });

  it('surfaces a recorded judge-parse-failure with its own distinct judgeReasonCode, not folded into judge-review', async () => {
    const id = makeNote('judged with an infra failure');
    recordDecision({
      ts: new Date().toISOString(),
      proposalId: id,
      action: 'judged',
      verdict: 'review',
      detail: 'judge-parse-failure',
    });

    const h = await startServer(makeCfg(), makeOpts());
    openHandles.push(h);

    const res = await request('GET', `${h.url}/api/inbox/${id}`, h.port);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      decisionEvidence: {
        sourceQuality: { sourceState: string; complete: boolean };
        decisions: Array<{ action: string; judgeReasonCode?: string; judgeRationaleState?: string }>;
      };
    };
    expect(body.decisionEvidence.sourceQuality).toEqual({ sourceState: 'healthy', complete: true });
    expect(body.decisionEvidence.decisions).toHaveLength(1);
    const decision = body.decisionEvidence.decisions[0]!;
    expect(decision.judgeReasonCode).toBe('judge-parse-failure');
    expect(decision.judgeReasonCode).not.toBe('judge-review');
    expect(decision.judgeRationaleState).toBe('not-persisted');
  });
});
