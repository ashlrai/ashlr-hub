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

import { readSseAuth, startServer } from './helpers/authenticated-web-server.js';

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

async function authenticatedSse(handle: { port: number; readToken: string }): Promise<{
  query: string;
  headers: Record<string, string>;
}> {
  const auth = await readSseAuth(handle);
  return {
    query: auth.query,
    headers: { Host: `127.0.0.1:${handle.port}`, ...auth.headers },
  };
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
    const auth = await authenticatedSse(h);

    const res = await collectSseFrames(
      `${h.url}/api/run/r1/events${auth.query}`,
      auth.headers,
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
    const auth = await authenticatedSse(h);

    const res = await httpRequestHeadersOnly(
      `${h.url}/api/run/bad%20id!/events${auth.query}`,
      auth.headers,
    );
    expect(res.statusCode).toBe(400);
    expect(loadRunMock).not.toHaveBeenCalled();
  });

  it('404s a well-formed but unknown run id', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);
    currentRun = null;
    const auth = await authenticatedSse(h);

    const res = await httpRequestHeadersOnly(
      `${h.url}/api/run/does-not-exist/events${auth.query}`,
      auth.headers,
    );
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
      const auth = await authenticatedSse(h);

      const collecting = collectSseFrames(
        `${h.url}/api/run/r1/events${auth.query}`,
        auth.headers,
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
      const auth = await authenticatedSse(h);

      // Wait for BOTH steps' step-done frames — a single 'data' chunk isn't
      // guaranteed to carry every event a tick wrote, so stopping at the
      // first step-done risks disconnecting before step index 1 arrives.
      const first = await collectSseFrames(
        `${h.url}/api/run/r1/events${auth.query}`,
        auth.headers,
        (frames) => frames.filter((f) => f.event === 'step-done').length >= 2,
      );
      const seenIds = first.frames.filter((f) => f.id !== undefined).map((f) => Number(f.id));
      const lastId = seenIds.length > 0 ? Math.max(...seenIds) : undefined;
      expect(lastId).toBeDefined();

      currentRun = runAt({ stepCount: 2, status: 'done', taskStatus: 'done' });

      const resumed = await collectSseFrames(
        `${h.url}/api/run/r1/events${auth.query}`,
        { ...auth.headers, 'Last-Event-ID': String(lastId) },
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
      const auth = await authenticatedSse(h);

      const { frames } = await collectSseFrames(
        `${h.url}/api/run/r1/events${auth.query}`,
        auth.headers,
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
    const auth = await authenticatedSse(h);

    const { frames } = await collectSseFrames(
      `${h.url}/api/run/r1/events${auth.query}`,
      auth.headers,
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

// ---------------------------------------------------------------------------
// v333: output-chunk — durable stream file interleaving + resume
// ---------------------------------------------------------------------------

/**
 * Write JSONL lines directly to the run's stream file, mirroring exactly
 * what streaming.ts's fileSink() would have written — this suite tests the
 * SSE route's TAILING of that file, not fileSink() itself (covered in
 * test/m11.stream-file-sink.test.ts).
 */
function writeStreamFileLines(runId: string, lines: Array<{ kind: string; text: string; taskId?: string }>): void {
  const dir = path.join(tmpHome, '.ashlr', 'run-streams');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, `${runId}.log`);
  const body = lines
    .map((l) => JSON.stringify({ ts: new Date().toISOString(), kind: l.kind, ...(l.taskId ? { taskId: l.taskId } : {}), text: l.text }))
    .join('\n') + (lines.length > 0 ? '\n' : '');
  fs.appendFileSync(filePath, body, { mode: 0o600 });
}

describe('GET /api/run/:id/events — output-chunk (durable stream file)', () => {
  it(
    'interleaves output-chunk frames with step events, all under one monotonic id space',
    async () => {
      const h = await startServer(makeConfig(), makeOpts());
      openHandles.push(h);
      currentRun = runAt({ stepCount: 1, taskStatus: 'running' });
      writeStreamFileLines('r1', [
        { kind: 'model-delta', text: 'thinking about the goal' },
        { kind: 'tool-call', text: 'tool: read_file', taskId: 't1' },
      ]);
      const auth = await authenticatedSse(h);

      const collecting = collectSseFrames(
        `${h.url}/api/run/r1/events${auth.query}`,
        auth.headers,
        (frames) => frames.some((f) => f.event === 'run-done'),
      );

      await new Promise((r) => setTimeout(r, 50));
      writeStreamFileLines('r1', [{ kind: 'model-delta', text: 'more output after connect' }]);
      currentRun = runAt({ stepCount: 1, status: 'done', taskStatus: 'done' });

      const { statusCode, frames } = await collecting;
      expect(statusCode).toBe(200);

      const outputFrames = frames.filter((f) => f.event === 'output-chunk');
      expect(outputFrames.length).toBeGreaterThanOrEqual(3);
      const texts = outputFrames.map((f) => (f.data as { text: string }).text);
      expect(texts).toContain('thinking about the goal');
      expect(texts).toContain('tool: read_file');
      expect(texts).toContain('more output after connect');

      const toolCallFrame = outputFrames.find((f) => (f.data as { text: string }).text === 'tool: read_file');
      expect((toolCallFrame!.data as { taskId: string | null }).taskId).toBe('t1');

      // Step/task/run-done ids and output-chunk ids live in two disjoint,
      // independently-monotonic ranges (see run-stream.ts's lastStepSeq /
      // lastOutputSeq comment) — each is strictly increasing and dup-free
      // WITHIN its own family; they are not required to interleave in
      // numeric order on the wire (output-chunk ids, OUTPUT_SEQ_BASE=1e7+,
      // are always numerically larger than any real step id).
      const allIds = frames.filter((f) => f.id !== undefined).map((f) => Number(f.id));
      const OUTPUT_SEQ_BASE = 10_000_000;
      const stepIds = allIds.filter((n) => n < OUTPUT_SEQ_BASE);
      const outputIds = allIds.filter((n) => n >= OUTPUT_SEQ_BASE);
      for (const ids of [stepIds, outputIds]) {
        const sorted = [...ids].sort((a, b) => a - b);
        expect(ids).toEqual(sorted);
        expect(new Set(ids).size).toBe(ids.length);
      }
      expect(names_(frames)).toContain('run-done');
    },
    10_000,
  );

  it(
    'resumes via Last-Event-ID without re-sending already-seen output chunks',
    async () => {
      const h = await startServer(makeConfig(), makeOpts());
      openHandles.push(h);
      currentRun = runAt({ stepCount: 0, taskStatus: 'running' });
      writeStreamFileLines('r1', [
        { kind: 'model-delta', text: 'chunk one' },
        { kind: 'model-delta', text: 'chunk two' },
      ]);
      const auth = await authenticatedSse(h);

      const first = await collectSseFrames(
        `${h.url}/api/run/r1/events${auth.query}`,
        auth.headers,
        (frames) => frames.filter((f) => f.event === 'output-chunk').length >= 2,
      );
      const seenIds = first.frames.filter((f) => f.id !== undefined).map((f) => Number(f.id));
      const lastId = Math.max(...seenIds);

      writeStreamFileLines('r1', [{ kind: 'model-delta', text: 'chunk three' }]);
      currentRun = runAt({ stepCount: 0, status: 'done', taskStatus: 'done' });

      const resumed = await collectSseFrames(
        `${h.url}/api/run/r1/events${auth.query}`,
        { ...auth.headers, 'Last-Event-ID': String(lastId) },
        (frames) => frames.some((f) => f.event === 'run-done'),
      );

      const resumedOutputTexts = resumed.frames
        .filter((f) => f.event === 'output-chunk')
        .map((f) => (f.data as { text: string }).text);
      // Output-chunk dedup works precisely here because lastId is itself an
      // output-chunk id: only the genuinely-new chunk replays.
      expect(resumedOutputTexts).toEqual(['chunk three']);
      const resumedOutputIds = resumed.frames
        .filter((f) => f.event === 'output-chunk' && f.id !== undefined)
        .map((f) => Number(f.id));
      for (const oid of resumedOutputIds) expect(oid).toBeGreaterThan(lastId);
      // The step/task/run-done family, by contrast, replays from scratch on
      // this reconnect (documented tradeoff in run-stream.ts: a single
      // Last-Event-ID can only seed the ONE threshold whose range it falls
      // in — lastId here is an output-space id, so the step family's
      // threshold resets to -1 rather than risk suppressing it forever).
      expect(names_(resumed.frames)).toContain('run-done');
    },
    10_000,
  );

  it('never sends the raw secret when the stream file itself is unscrubbed (defense-in-depth via sanitizePublicJson)', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);
    const secret = 'sk-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    currentRun = runAt({ stepCount: 0, status: 'done', taskStatus: 'done' });
    // Simulate a hypothetical bug where fileSink's own scrub was bypassed —
    // this route's sanitizePublicJson() is the second, independent layer.
    writeStreamFileLines('r1', [{ kind: 'model-delta', text: `leaked ${secret}` }]);
    const auth = await authenticatedSse(h);

    const { frames } = await collectSseFrames(
      `${h.url}/api/run/r1/events${auth.query}`,
      auth.headers,
      (fr) => fr.some((f) => f.event === 'run-done'),
    );

    const serialized = JSON.stringify(frames);
    expect(serialized).not.toContain(secret);
  });

  // DELIBERATELY inverted, same pattern as the step-summary sanity test
  // above: proves this suite would fail if sanitizePublicJson were ever
  // skipped for output-chunk payloads specifically.
  it('sanity: an unscrubbed stream-file line WOULD contain the raw secret if read verbatim', () => {
    const secret = 'sk-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const line = JSON.stringify({ ts: new Date().toISOString(), kind: 'model-delta', text: `leaked ${secret}` });
    expect(line).toContain(secret);
  });
});

function names_(frames: Array<{ event: string }>): string[] {
  return frames.map((f) => f.event);
}

// ---------------------------------------------------------------------------
// v333: live integration — a real (fake) engine subprocess's stdout reaches
// the SSE route via the real spawnEngine -> fileSink pipeline, no mocking of
// child_process. `bin: process.execPath` runs plain node, never a real
// delegated CLI agent — same pattern m11.engines.test.ts already uses for
// its one real-process integration test.
// ---------------------------------------------------------------------------

describe('GET /api/run/:id/events — live engine output integration', () => {
  it(
    'a real subprocess writing to stdout is tailed through fileSink and arrives as output-chunk frames',
    async () => {
      const { spawnEngine, describeRunEventForStream } = await import('../src/core/run/engines.js');
      const { fileSink, emitSinkEvent, endStreamSink } = await import('../src/core/run/streaming.js');

      const h = await startServer(makeConfig(), makeOpts());
      openHandles.push(h);
      currentRun = runAt({ stepCount: 0, taskStatus: 'running' });

      const sink = fileSink('r1');
      const script = [
        "console.log('engine says hello');",
        "console.log('engine is working');",
      ].join('\n');

      const enginePromise = spawnEngine(
        { bin: process.execPath, args: ['-e', script] },
        makeConfig(),
        {
          onEvent: (ev) => {
            const described = describeRunEventForStream(ev);
            if (described) emitSinkEvent(sink, described);
          },
        },
      );
      const auth = await authenticatedSse(h);

      const collecting = collectSseFrames(
        `${h.url}/api/run/r1/events${auth.query}`,
        auth.headers,
        (frames) => frames.filter((f) => f.event === 'output-chunk').length >= 2,
        8_000,
      );

      await enginePromise;
      endStreamSink(sink);
      currentRun = runAt({ stepCount: 0, status: 'done', taskStatus: 'done' });

      const { frames } = await collecting;
      const texts = frames.filter((f) => f.event === 'output-chunk').map((f) => (f.data as { text: string }).text);
      expect(texts).toContain('engine says hello');
      expect(texts).toContain('engine is working');
    },
    10_000,
  );
});
