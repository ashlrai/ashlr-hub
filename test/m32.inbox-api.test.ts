/**
 * M32 — web inbox approval surface: POST /api/inbox/:id/approve|reject and
 * GET /api/inbox/:id, plus the SSE inbox/daemon events and the additive
 * snapshot.dispatchEnabled field.
 *
 * Invariants under test (CONTRACT-M32):
 *   - The mutation routes DO NOT EXIST (404) without --allow-dispatch.
 *   - Wrong/missing token → 401; wrong Content-Type → 415; non-pending → 409.
 *   - Reject persists 'rejected'; approve routes through applyProposal (a
 *     repo:null 'note' applies as a no-op record).
 *
 * Hermetic: tmp HOME (h1-fixture), real ephemeral server on 127.0.0.1.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';

import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';
import { startServer } from '../src/core/web/server.js';
import { createProposal, loadProposal } from '../src/core/inbox/store.js';
import { hashDiff, signProvenance } from '../src/core/foundry/provenance.js';
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

function request(
  method: string,
  url: string,
  port: number,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method,
        headers: { Host: `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function makeNote(title = 'web approval test'): string {
  return createProposal({
    repo: null,
    origin: 'manual',
    kind: 'note',
    title,
    summary: 'created by m32 inbox-api test',
  }).id;
}

const SECRET_VALUE = 'abcdefghijklmnopqrstuvwxyz1234567890';
const SECRET_ASSIGNMENT = `secret_key = "${SECRET_VALUE}"`;

function makeSecretDiff(): string {
  return [
    'diff --git a/web.ts b/web.ts',
    '--- a/web.ts',
    '+++ b/web.ts',
    '@@ -1 +1 @@',
    `+const ${SECRET_ASSIGNMENT};`,
    '+console.log("api review context survives");',
    '',
  ].join('\n');
}

function makeSecretPatch(title = `api detail ${SECRET_ASSIGNMENT}`): string {
  const repo = fx.makeRepo();
  const diff = makeSecretDiff();
  const diffHash = hashDiff(diff);
  return createProposal({
    repo: repo.dir,
    origin: 'manual',
    kind: 'patch',
    title,
    summary: `created with password = "swordfish"`,
    diff,
    diffHash,
    provenanceSig: signProvenance('codex:gpt-5.5', 'frontier', diffHash),
    engineModel: 'codex:gpt-5.5',
    engineTier: 'frontier',
  }).id;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

describe('mutation routes do not exist without --allow-dispatch', () => {
  it('POST approve/reject return 404 with dispatch off (even with any token)', async () => {
    const id = makeNote();
    const h = await startServer(makeCfg(), makeOpts({ allowDispatch: false }));
    openHandles.push(h);
    for (const action of ['approve', 'reject']) {
      const res = await request(
        'POST', `${h.url}/api/inbox/${id}/${action}`, h.port,
        { ...JSON_HEADERS, 'x-ashlr-token': h.token }, '{}',
      );
      expect(res.statusCode).toBe(404);
    }
    // The proposal is untouched.
    expect(loadProposal(id)!.status).toBe('pending');
  });
});

describe('token + content-type gates (dispatch on)', () => {
  it('401 on wrong token; 415 on wrong content-type', async () => {
    const id = makeNote();
    const h = await startServer(makeCfg(), makeOpts({ allowDispatch: true }));
    openHandles.push(h);

    const wrongToken = await request(
      'POST', `${h.url}/api/inbox/${id}/reject`, h.port,
      { ...JSON_HEADERS, 'x-ashlr-token': 'not-the-token' }, '{}',
    );
    expect(wrongToken.statusCode).toBe(401);

    const wrongType = await request(
      'POST', `${h.url}/api/inbox/${id}/reject`, h.port,
      { 'Content-Type': 'text/plain', 'x-ashlr-token': h.token }, '{}',
    );
    expect(wrongType.statusCode).toBe(415);

    expect(loadProposal(id)!.status).toBe('pending');
  });
});

describe('reject + approve flows', () => {
  it('reject persists rejected and applies nothing', async () => {
    const id = makeNote();
    const h = await startServer(makeCfg(), makeOpts({ allowDispatch: true }));
    openHandles.push(h);

    const res = await request(
      'POST', `${h.url}/api/inbox/${id}/reject`, h.port,
      { ...JSON_HEADERS, 'x-ashlr-token': h.token }, '{}',
    );
    expect(res.statusCode).toBe(200);
    expect(loadProposal(id)!.status).toBe('rejected');
  });

  it('approve routes a note proposal through applyProposal', async () => {
    const id = makeNote();
    const h = await startServer(makeCfg(), makeOpts({ allowDispatch: true }));
    openHandles.push(h);

    const res = await request(
      'POST', `${h.url}/api/inbox/${id}/approve`, h.port,
      { ...JSON_HEADERS, 'x-ashlr-token': h.token }, '{}',
    );
    const result = JSON.parse(res.body) as { ok: boolean; status: string };
    expect(res.statusCode).toBe(200);
    expect(result.ok).toBe(true);
    expect(loadProposal(id)!.status).toBe('applied');
  });

  it('409 when the proposal is not pending', async () => {
    const id = makeNote();
    const h = await startServer(makeCfg(), makeOpts({ allowDispatch: true }));
    openHandles.push(h);

    await request(
      'POST', `${h.url}/api/inbox/${id}/reject`, h.port,
      { ...JSON_HEADERS, 'x-ashlr-token': h.token }, '{}',
    );
    const again = await request(
      'POST', `${h.url}/api/inbox/${id}/approve`, h.port,
      { ...JSON_HEADERS, 'x-ashlr-token': h.token }, '{}',
    );
    expect(again.statusCode).toBe(409);
  });
});

describe('detail route + snapshot flag', () => {
  it('GET /api/inbox/:id returns the full proposal; 404 on unknown', async () => {
    const id = makeNote('detail test');
    const h = await startServer(makeCfg(), makeOpts());
    openHandles.push(h);

    const res = await request('GET', `${h.url}/api/inbox/${id}`, h.port);
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as { title: string }).title).toBe('detail test');

    const missing = await request('GET', `${h.url}/api/inbox/nope-123`, h.port);
    expect(missing.statusCode).toBe(404);
  });

  it('GET inbox routes return scrubbed proposal text and reviewable redacted diffs', async () => {
    const id = makeSecretPatch();
    const h = await startServer(makeCfg(), makeOpts());
    openHandles.push(h);

    const detail = await request('GET', `${h.url}/api/inbox/${id}`, h.port);
    expect(detail.statusCode).toBe(200);
    expect(detail.body).not.toContain(SECRET_VALUE);
    expect(detail.body).not.toContain('swordfish');

    const proposal = JSON.parse(detail.body) as {
      title: string;
      summary: string;
      diff: string;
      diffHash?: string;
      provenanceSig?: string;
    };
    expect(proposal.title).toContain('[REDACTED]');
    expect(proposal.summary).toContain('[REDACTED]');
    expect(proposal.diff).toContain('diff --git a/web.ts b/web.ts');
    expect(proposal.diff).toContain('api review context survives');
    expect(proposal.diff).toContain('[REDACTED]');
    expect(proposal.diffHash).toBeUndefined();
    expect(proposal.provenanceSig).toBeUndefined();

    const list = await request('GET', `${h.url}/api/inbox`, h.port);
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(SECRET_VALUE);
    expect(list.body).not.toContain('swordfish');
    const listed = (JSON.parse(list.body) as { proposals: Array<{ id: string; diff?: string; diffHash?: string }> })
      .proposals.find((item) => item.id === id);
    expect(listed).toBeDefined();
    expect(listed!.diff).toContain('api review context survives');
    expect(listed!.diff).toContain('[REDACTED]');
    expect(listed!.diffHash).toBeUndefined();
  });

  it('snapshot reports dispatchEnabled truthfully', async () => {
    const off = await startServer(makeCfg(), makeOpts({ allowDispatch: false }));
    openHandles.push(off);
    const resOff = await request('GET', `${off.url}/api/snapshot`, off.port);
    expect((JSON.parse(resOff.body) as { dispatchEnabled: boolean }).dispatchEnabled).toBe(false);

    const on = await startServer(makeCfg(), makeOpts({ allowDispatch: true }));
    openHandles.push(on);
    const resOn = await request('GET', `${on.url}/api/snapshot`, on.port);
    expect((JSON.parse(resOn.body) as { dispatchEnabled: boolean }).dispatchEnabled).toBe(true);
    // Two servers + two full /api/snapshot builds. On a dev machine with an
    // active portfolio (modules that captured ~/.ashlr at load-time scan the real
    // tree) this legitimately exceeds the 5s default — give it a realistic budget.
  }, 30_000);
});

describe('SSE inbox + daemon events', () => {
  it('the event stream carries named inbox and daemon frames', async () => {
    makeNote('sse test');
    const h = await startServer(makeCfg(), makeOpts());
    openHandles.push(h);

    const frames = await new Promise<string>((resolve, reject) => {
      const req = http.get(
        { hostname: '127.0.0.1', port: h.port, path: '/api/events', headers: { Host: `127.0.0.1:${h.port}` } },
        (res) => {
          let data = '';
          res.on('data', (c: Buffer) => {
            data += c.toString();
            // The initial emitUpdate sends all four named events at once.
            if (data.includes('event: inbox') && data.includes('event: daemon')) {
              res.destroy();
              resolve(data);
            }
          });
          res.on('error', () => resolve(data));
        },
      );
      req.on('error', reject);
      setTimeout(() => resolve(''), 5_000).unref();
    });

    expect(frames).toContain('event: inbox');
    expect(frames).toContain('event: daemon');
    expect(frames).toContain('sse test');
    // Metadata only — the inbox event never carries a diff field.
    const inboxLine = frames.split('\n').find((l, i, all) => all[i - 1] === 'event: inbox' && l.startsWith('data:'));
    expect(inboxLine ?? '').not.toContain('"diff"');
  });
});
