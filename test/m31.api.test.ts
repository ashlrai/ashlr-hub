/**
 * M31 — web API additions: read-only GET /api/orient, /api/health,
 * /api/backlog, /api/impact.
 *
 * Exercised through the real ephemeral server (startServer) under an isolated
 * tmp HOME. Asserts the routes are READ-ONLY (no POST variants exist) and
 * never expose secret values.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';
import { startServer } from '../src/core/web/server.js';
import type { WebServerOptions, WorkItem } from '../src/core/types.js';

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
): Promise<{ statusCode: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method,
        headers: { Host: `127.0.0.1:${port}` },
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            body: data,
            contentType: String(res.headers['content-type'] ?? ''),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('M31 read-only API routes', () => {
  it('GET /api/orient returns 200 with an OrientResult shape', async () => {
    const h = await startServer(makeCfg(), makeOpts());
    openHandles.push(h);
    const res = await request('GET', `${h.url}/api/orient`, h.port);
    expect(res.statusCode).toBe(200);
    expect(res.contentType).toContain('application/json');
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(typeof body['generatedAt']).toBe('string');
    expect(Array.isArray(body['genomeHits'])).toBe(true);
    expect(Array.isArray(body['backlogItems'])).toBe(true);
    expect(typeof body['pendingProposals']).toBe('number');
  });

  it('GET /api/orient?repo= scopes the orientation', async () => {
    const otherRepo = join(fx.home, 'other-repo');
    mkdirSync(join(fx.ashlrDir), { recursive: true });
    mkdirSync(otherRepo, { recursive: true });
    const scopedItem: WorkItem = {
      id: `${fx.home}:goal:scoped`,
      repo: fx.home,
      source: 'goal',
      title: 'Scoped orientation item',
      detail: 'Only this repo should show up.',
      value: 4,
      effort: 1,
      score: 4,
      tags: ['test'],
      ts: new Date().toISOString(),
    };
    const otherItem: WorkItem = {
      ...scopedItem,
      id: `${otherRepo}:goal:other`,
      repo: otherRepo,
      title: 'Other repo item',
    };
    writeFileSync(
      join(fx.ashlrDir, 'backlog.json'),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        repos: [fx.home, otherRepo],
        items: [scopedItem, otherItem],
      }),
      'utf8',
    );
    const h = await startServer(makeCfg(), makeOpts());
    openHandles.push(h);
    const res = await request('GET', `${h.url}/api/orient?repo=${encodeURIComponent(fx.home)}`, h.port);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body['repo']).toBe('~');
    expect(body['backlogItems']).toEqual([
      expect.objectContaining({ title: scopedItem.title }),
    ]);
  });

  it('GET /api/health returns null when no report is persisted', async () => {
    const h = await startServer(makeCfg(), makeOpts());
    openHandles.push(h);
    const res = await request('GET', `${h.url}/api/health`, h.port);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toBeNull();
  });

  it('GET /api/backlog returns null when no backlog is persisted', async () => {
    const h = await startServer(makeCfg(), makeOpts());
    openHandles.push(h);
    const res = await request('GET', `${h.url}/api/backlog`, h.port);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toBeNull();
  });

  it('GET /api/impact requires a target param (400 without)', async () => {
    const h = await startServer(makeCfg(), makeOpts());
    openHandles.push(h);
    const res = await request('GET', `${h.url}/api/impact`, h.port);
    expect(res.statusCode).toBe(400);
  });

  it('GET /api/impact?target= returns an ImpactResult shape', async () => {
    const h = await startServer(makeCfg(), makeOpts());
    openHandles.push(h);
    const res = await request('GET', `${h.url}/api/impact?target=index.ts`, h.port);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body['target']).toBe('index.ts');
    expect(Array.isArray(body['references'])).toBe(true);
    expect(Array.isArray(body['dependents'])).toBe(true);
  });

  it('the M31 routes are READ-ONLY — POST returns 404', async () => {
    const h = await startServer(makeCfg(), makeOpts());
    openHandles.push(h);
    for (const path of ['/api/orient', '/api/health', '/api/backlog', '/api/impact']) {
      const res = await request('POST', `${h.url}${path}`, h.port);
      expect(res.statusCode).toBe(404);
    }
  });
});
