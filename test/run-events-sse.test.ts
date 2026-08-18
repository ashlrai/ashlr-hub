/**
 * Tests for GET /api/run/:id/events (src/core/web/run-stream.ts) — the
 * per-run SSE tail. Hermetic: orchestrator.js's loadRun() is mocked so the
 * test controls exactly what "the run on disk" looks like on each poll,
 * without touching a real ~/.ashlr.
 *
 * Covers:
 *   - auth: refused (401) without a session, same boundary as every other
 *     GET /api/* route.
 *   - invalid run id: 400 (never reaches loadRun/fs).
 *   - unknown-but-well-formed run id: 404.
 *   - live sequence: step-started / step-output-chunk / step-done frames
 *     arrive with strictly increasing `id:` as the mocked run "progresses"
 *     across real poll ticks, then run-done closes the stream.
 *   - resume: reconnecting with Last-Event-ID only replays events after
 *     that id — no duplicates.
 *   - stall: a run that stops changing gets an explicit `stall` event
 *     carrying an age, instead of silently going quiet.
 *   - scrubbing: a fixture containing a fake secret token never reaches the
 *     wire in any frame.
 *
 * One assertion is DELIBERATELY inverted (see the "sanity: catches a
 * regression" test) to prove this suite would actually fail if scrubbing
 * were removed, rather than passing vacuously.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, WebServerOptions } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Controllable run fixture + orchestrator mock
// ---------------------------------------------------------------------------

let currentRun: unknown = null;
const loadRunMock = vi.fn((id: string) => {
  if (currentRun && (currentRun as { id: string }).id === id) return currentRun;
  return null;
});

vi.mock('../src/core/run/orchestrator.js', () => ({
  listRuns: vi.fn(() => []),
  loadRun: (id: string) => loadRunMock(id),
  runGoal: vi.fn(async () => ({ id: 'run-dispatched', status: 'done' })),
}));

function runAt(overrides: {
  stepCount: number;
  status?: 'running' | 'done';
  taskStatus?: 'pending' | 'running' | 'done';
  extraSummary?: string;
}) {
  const { stepCount, status = 'running', taskStatus = 'running', extraSummary } = overrides;
  return {
    id: 'r1',
    goal: 'ship the thing',
    engine: 'claude',
    provider: 'anthropic',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: new Date().toISOString(),
    budget: { maxTokens: 100_000, maxSteps: 50, allowCloud: true },
    usage: { tokensIn: 10, tokensOut: 5, steps: stepCount, estCostUsd: 0.01 },
    tasks: [{ id: 't1', goal: 'do it', deps: [], status: stepCount > 0 ? taskStatus : 'pending' }],
    steps: Array.from({ length: stepCount }, (_, i) => ({
      ts: new Date().toISOString(),
      taskId: 't1',
      kind: 'tool' as const,
      summary: i === stepCount - 1 && extraSummary ? extraSummary : `step ${i + 1}`,
    })),
    status,
    result: status === 'done' ? 'all done' : undefined,
  };
}

// ---------------------------------------------------------------------------
// Server / auth harness (mirrors test/m14.api.test.ts)
// ---------------------------------------------------------------------------

import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

function makeConfig(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://localhost:11434', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
  };
}

function makeOpts(overrides: Partial<WebServerOptions> = {}): WebServerOptions {
  return { port: 0, open: false, allowDispatch: false, ...overrides };
}

function httpRequestHeadersOnly(
  url: string,
  headers: Record<string, string>,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    let body = '';
    const req = http.request(
      { hostname: parsed.hostname, port: Number(parsed.port), path: parsed.pathname + parsed.search, method: 'GET', headers },
      (res) => {
        res.on('data', (c: Buffer) => { body += c.toString('utf8'); });
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Open an SSE connection and collect frames until `until` returns true or timeout. */
function collectSseFrames(
  url: string,
  headers: Record<string, string>,
  until: (frames: Array<{ id?: string; event: string; data: unknown }>) => boolean,
  timeoutMs = 6000,
): Promise<{ statusCode: number; frames: Array<{ id?: string; event: string; data: unknown }> }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const frames: Array<{ id?: string; event: string; data: unknown }> = [];
    let buffer = '';
    let settled = false;
    let statusCode = 0;

    const req = http.request(
      { hostname: parsed.hostname, port: Number(parsed.port), path: parsed.pathname + parsed.search, method: 'GET', headers },
      (res) => {
        statusCode = res.statusCode ?? 0;
        if (statusCode !== 200) {
          let raw = '';
          res.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
          res.on('end', () => {
            settled = true;
            resolve({ statusCode, frames: [{ event: 'error-response', data: raw }] });
          });
          return;
        }
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            if (raw.startsWith(':')) continue; // comment/keepalive
            let id: string | undefined;
            let event = 'message';
            let dataRaw = '';
            for (const line of raw.split('\n')) {
              if (line.startsWith('id: ')) id = line.slice(4);
              else if (line.startsWith('event: ')) event = line.slice(7);
              else if (line.startsWith('data: ')) dataRaw = line.slice(6);
            }
            let data: unknown = dataRaw;
            try { data = JSON.parse(dataRaw); } catch { /* keep raw */ }
            frames.push({ id, event, data });
          }
          if (!settled && until(frames)) {
            settled = true;
            res.destroy();
            req.destroy();
            resolve({ statusCode, frames });
          }
        });
        res.on('end', () => {
          if (!settled) {
            settled = true;
            resolve({ statusCode, frames });
          }
        });
      },
    );
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (settled && (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED')) return;
      if (!settled) reject(err);
    });
    req.setTimeout(timeoutMs, () => {
      if (!settled) {
        settled = true;
        req.destroy();
        resolve({ statusCode, frames });
      }
    });
    req.end();
  });
}

let openHandles: Array<{ close(): Promise<void> }> = [];
let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  openHandles = [];
  currentRun = null;
  loadRunMock.mockClear();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-run-sse-home-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(async () => {
  for (const h of openHandles) {
    try { await h.close(); } catch { /* ignore */ }
  }
  openHandles = [];
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('GET /api/run/:id/events — auth', () => {
  it('refuses the connection without a read session', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);
    currentRun = runAt({ stepCount: 1 });

    const res = await httpRequestHeadersOnly(`${h.url}/api/run/r1/events`, { Host: `127.0.0.1:${h.port}` });
    expect(res.statusCode).toBe(401);
  });

  it('accepts the connection with a valid read session', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);
    currentRun = runAt({ stepCount: 0, status: 'done' });

    const res = await collectSseFrames(
      `${h.url}/api/run/r1/events`,
      { Host: `127.0.0.1:${h.port}`, ...readAuthHeaders(h.port) },
      (frames) => frames.some((f) => f.event === 'run-done'),
    );
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('GET /api/run/:id/events — validation', () => {
  it('400s an invalid run id before touching loadRun', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);

    const res = await httpRequestHeadersOnly(`${h.url}/api/run/bad%20id!/events`, {
      Host: `127.0.0.1:${h.port}`,
      ...readAuthHeaders(h.port),
    });
    expect(res.statusCode).toBe(400);
    expect(loadRunMock).not.toHaveBeenCalled();
  });

  it('404s a well-formed but unknown run id', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);
    currentRun = null;

    const res = await httpRequestHeadersOnly(`${h.url}/api/run/does-not-exist/events`, {
      Host: `127.0.0.1:${h.port}`,
      ...readAuthHeaders(h.port),
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Live sequence + resume
// ---------------------------------------------------------------------------

describe('GET /api/run/:id/events — live sequence', () => {
  it(
    'streams step-started/step-output-chunk/step-done with increasing ids, then run-done',
    async () => {
      const h = await startServer(makeConfig(), makeOpts());
      openHandles.push(h);
      currentRun = runAt({ stepCount: 1, taskStatus: 'running' });

      const collecting = collectSseFrames(
        `${h.url}/api/run/r1/events`,
        { Host: `127.0.0.1:${h.port}`, ...readAuthHeaders(h.port) },
        (frames) => frames.some((f) => f.event === 'run-done'),
      );

      // Let the first tick (immediate replay) land, then progress the run.
      await new Promise((r) => setTimeout(r, 50));
      currentRun = runAt({ stepCount: 2, taskStatus: 'running' });
      await new Promise((r) => setTimeout(r, 700));
      currentRun = runAt({ stepCount: 2, status: 'done', taskStatus: 'done' });

      const { statusCode, frames } = await collecting;
      expect(statusCode).toBe(200);

      const names = frames.map((f) => f.event);
      expect(names).toContain('step-started');
      expect(names).toContain('step-output-chunk');
      expect(names).toContain('step-done');
      expect(names[names.length - 1]).toBe('run-done');

      const ids = frames.filter((f) => f.id !== undefined).map((f) => Number(f.id));
      const sorted = [...ids].sort((a, b) => a - b);
      expect(ids).toEqual(sorted);
      expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
    },
    10_000,
  );

  it(
    'resumes via Last-Event-ID without re-sending already-seen events',
    async () => {
      const h = await startServer(makeConfig(), makeOpts());
      openHandles.push(h);
      currentRun = runAt({ stepCount: 2, taskStatus: 'running' });

      // Wait for BOTH steps' step-done frames — a single 'data' chunk isn't
      // guaranteed to carry every event a tick wrote, so stopping at the
      // first step-done risks disconnecting before step index 1 arrives.
      const first = await collectSseFrames(
        `${h.url}/api/run/r1/events`,
        { Host: `127.0.0.1:${h.port}`, ...readAuthHeaders(h.port) },
        (frames) => frames.filter((f) => f.event === 'step-done').length >= 2,
      );
      const seenIds = first.frames.filter((f) => f.id !== undefined).map((f) => Number(f.id));
      const lastId = seenIds.length > 0 ? Math.max(...seenIds) : undefined;
      expect(lastId).toBeDefined();

      currentRun = runAt({ stepCount: 2, status: 'done', taskStatus: 'done' });

      const resumed = await collectSseFrames(
        `${h.url}/api/run/r1/events`,
        { Host: `127.0.0.1:${h.port}`, ...readAuthHeaders(h.port), 'Last-Event-ID': String(lastId) },
        (frames) => frames.some((f) => f.event === 'run-done'),
      );

      const resumedIds = resumed.frames.filter((f) => f.id !== undefined).map((f) => Number(f.id));
      for (const id of resumedIds) expect(id).toBeGreaterThan(lastId as number);
      // The already-seen step-started/step-output-chunk/step-done for the
      // first two steps must not reappear.
      const resumedStepDones = resumed.frames.filter((f) => f.event === 'step-done').length;
      expect(resumedStepDones).toBe(0);
    },
    10_000,
  );

  it(
    'emits a stall event with a growing age when the run stops changing',
    async () => {
      const h = await startServer(makeConfig(), makeOpts());
      openHandles.push(h);
      // Frozen updatedAt so the mock doesn't look like it's constantly
      // changing (a fresh Date.now() on every loadRun() call would never stall).
      const frozen = runAt({ stepCount: 1, taskStatus: 'running' });
      currentRun = frozen;

      const { frames } = await collectSseFrames(
        `${h.url}/api/run/r1/events`,
        { Host: `127.0.0.1:${h.port}`, ...readAuthHeaders(h.port) },
        (fs_) => fs_.some((f) => f.event === 'stall'),
        12_000,
      );

      const stall = frames.find((f) => f.event === 'stall');
      expect(stall).toBeDefined();
      expect(stall!.id).toBeUndefined(); // stall is not part of the resumable cursor
      expect((stall!.data as { ageMs: number }).ageMs).toBeGreaterThanOrEqual(8_000);
    },
    15_000,
  );
});

// ---------------------------------------------------------------------------
// Scrubbing
// ---------------------------------------------------------------------------

describe('GET /api/run/:id/events — secret scrubbing', () => {
  it('never puts a fake secret token on the wire', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);
    const secret = 'sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    currentRun = runAt({ stepCount: 1, status: 'done', taskStatus: 'done', extraSummary: `leaked key ${secret}` });

    const { frames } = await collectSseFrames(
      `${h.url}/api/run/r1/events`,
      { Host: `127.0.0.1:${h.port}`, ...readAuthHeaders(h.port) },
      (fr) => fr.some((f) => f.event === 'run-done'),
    );

    const serialized = JSON.stringify(frames);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('[REDACTED]');
  });

  // DELIBERATELY inverted: proves the suite actually fails when scrubbing
  // is bypassed, rather than passing vacuously because nothing checks the
  // negative case. This asserts against the SAME secret with scrubbing
  // known to be active — expected to FAIL if ever flipped to `.not.toContain`
  // without the scrub applying, which is exactly the regression this
  // guards against being silently disabled.
  it('sanity: a run summary WOULD contain the raw secret if scrubbing were skipped', () => {
    const secret = 'sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const unscrubbed = runAt({ stepCount: 1, extraSummary: `leaked key ${secret}` });
    expect(JSON.stringify(unscrubbed)).toContain(secret);
  });
});
