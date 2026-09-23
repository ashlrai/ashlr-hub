/**
 * Tests for the tracing proxy and the timeout diagnosis.
 *
 * WHY THESE MATTER. The tracer exists so a trial killed by the clock can still
 * say what it was doing. That claim is only worth anything if the tracer is
 * itself trustworthy on two counts, and both are checked here:
 *
 *   1. IT MUST NOT CHANGE WHAT IT MEASURES. A proxy that reorders, buffers or
 *      truncates the stream would make every number downstream of it a
 *      measurement of the instrument. The first test replays a byte-for-byte
 *      comparison through it.
 *   2. IT MUST NOT GUESS. Each diagnosis names a different thing to go and fix,
 *      so the tests include the NEGATIVE cases: a stalled stream must not be
 *      reported as generating, and a clean run of completed turns must not be
 *      reported as a server problem. A classifier that only ever confirms the
 *      hypothesis it was written for is the failure this whole lane exists to
 *      catch, pointed at itself.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnoseTimeout, startTrace, type TraceHandle } from '../src/core/local-eval/trace.js';
import type { OpenStreamRecord, StreamRecord, TrialTrace } from '../src/core/local-eval/types.js';

const TERMINATED_SSE =
  'event: message_start\ndata: {"type":"message_start"}\n\n'
  + 'event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n'
  + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

/** An upstream we control, so the tracer is tested against known bytes. */
function fakeUpstream(handler: (body: string, res: import('node:http').ServerResponse) => void): Promise<{ origin: string; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += String(c); });
      req.on('end', () => handler(body, res));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ origin: `http://127.0.0.1:${port}`, server });
    });
  });
}

const open = (over: Partial<OpenStreamRecord>): OpenStreamRecord => ({
  seq: 1, url: '/v1/messages', status: 200, bytes: 1_000, events: { content_block_delta: 10 },
  openForMs: 900_000, sinceLastByteMs: 100, waitedForFirstByteMs: 500, ...over,
});

const done = (over: Partial<StreamRecord>): StreamRecord => ({
  seq: 0, url: '/v1/messages', status: 200, ended: 'upstream-end', bytes: 100,
  events: { message_start: 1, message_stop: 1 }, sawTerminator: true, upstreamComplete: true,
  waitedForFirstByteMs: 10, idleAtEndMs: 0, durationMs: 1_000, ...over,
});

const trace = (over: Partial<TrialTrace>): TrialTrace => ({
  captureDir: '/tmp/none', requests: 1, streams: [], openStreams: [], stallMs: 120_000, ...over,
});

describe('startTrace', () => {
  const handles: TraceHandle[] = [];
  const servers: Server[] = [];
  afterEach(async () => {
    for (const h of handles.splice(0)) await h.close();
    for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(null)));
  });

  it('forwards the request and the response body untouched', async () => {
    const upstream = await fakeUpstream((body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`${TERMINATED_SSE}received:${body}`);
    });
    servers.push(upstream.server);
    const handle = await startTrace({
      upstream: upstream.origin,
      captureDir: mkdtempSync(join(tmpdir(), 'trace-')),
    });
    handles.push(handle);

    const sent = JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] });
    const res = await fetch(`${handle.baseUrl}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: sent,
    });
    const text = await res.text();

    expect(res.status).toBe(200);
    // The whole point: what the agent receives is what the server sent.
    expect(text).toBe(`${TERMINATED_SSE}received:${sent}`);

    const snapshot = handle.snapshot();
    expect(snapshot.streams).toHaveLength(1);
    expect(snapshot.streams[0]!.sawTerminator).toBe(true);
    expect(snapshot.streams[0]!.events['content_block_delta']).toBe(1);
  });

  it('records a stream that closed without a terminator as exactly that', async () => {
    const upstream = await fakeUpstream((_body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // A turn the server considers finished, with no `message_stop`.
      res.end('event: message_start\ndata: {}\n\nevent: content_block_delta\ndata: {}\n\n');
    });
    servers.push(upstream.server);
    const handle = await startTrace({
      upstream: upstream.origin,
      captureDir: mkdtempSync(join(tmpdir(), 'trace-')),
    });
    handles.push(handle);

    await (await fetch(`${handle.baseUrl}/v1/messages`, { method: 'POST', body: '{}' })).text();

    const snapshot = handle.snapshot();
    expect(snapshot.streams[0]!.sawTerminator).toBe(false);
    expect(snapshot.streams[0]!.ended).toBe('upstream-end');
    expect(diagnoseTimeout(snapshot).kind).toBe('stream-ended-without-terminator');
  });

  it('keeps the raw bytes, because a summary is a lead and the capture is the evidence', async () => {
    const upstream = await fakeUpstream((_body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(TERMINATED_SSE);
    });
    servers.push(upstream.server);
    const captureDir = mkdtempSync(join(tmpdir(), 'trace-'));
    const handle = await startTrace({ upstream: upstream.origin, captureDir });
    handles.push(handle);

    await (await fetch(`${handle.baseUrl}/v1/messages`, { method: 'POST', body: '{"a":1}' })).text();
    // `close` is the flush point: until it resolves the capture may be partial.
    await handles.pop()!.close();

    const files = readdirSync(captureDir);
    expect(files).toContain('req-0000.json');
    expect(files).toContain('res-0000.sse');
    expect(readFileSync(join(captureDir, 'req-0000.json'), 'utf8')).toBe('{"a":1}');
    expect(readFileSync(join(captureDir, 'res-0000.sse'), 'utf8')).toBe(TERMINATED_SSE);
  });

  // REGRESSION. The first cut returned the live array by reference, so a
  // snapshot taken at the kill gained the very stream it was about as soon as
  // the proxy closed — and the report then listed one stream as both in flight
  // and complete, with the truncated turn counted in the turn-duration stats.
  it('returns a snapshot that later streams cannot change', async () => {
    const upstream = await fakeUpstream((_body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(TERMINATED_SSE);
    });
    servers.push(upstream.server);
    const handle = await startTrace({
      upstream: upstream.origin, captureDir: mkdtempSync(join(tmpdir(), 'trace-')),
    });
    handles.push(handle);

    await (await fetch(`${handle.baseUrl}/v1/messages`, { method: 'POST', body: '{}' })).text();
    const early = handle.snapshot();
    expect(early.streams).toHaveLength(1);

    await (await fetch(`${handle.baseUrl}/v1/messages`, { method: 'POST', body: '{}' })).text();
    expect(early.streams).toHaveLength(1);
    expect(handle.snapshot().streams).toHaveLength(2);
  });

  it('shows a stream still in flight, with how long since its last byte', async () => {
    let held: import('node:http').ServerResponse | null = null;
    const upstream = await fakeUpstream((_body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: content_block_delta\ndata: {}\n\n');
      held = res; // deliberately never ended
    });
    servers.push(upstream.server);
    const handle = await startTrace({
      upstream: upstream.origin,
      captureDir: mkdtempSync(join(tmpdir(), 'trace-')),
    });
    handles.push(handle);

    const controller = new AbortController();
    void fetch(`${handle.baseUrl}/v1/messages`, { method: 'POST', body: '{}', signal: controller.signal })
      .then((r) => r.body?.getReader().read())
      .catch(() => undefined);
    await new Promise((r) => setTimeout(r, 250));

    const snapshot = handle.snapshot();
    expect(snapshot.openStreams).toHaveLength(1);
    expect(snapshot.openStreams[0]!.bytes).toBeGreaterThan(0);
    expect(snapshot.openStreams[0]!.sinceLastByteMs).not.toBeNull();
    controller.abort();
    held?.end();
  });
});

describe('diagnoseTimeout', () => {
  it('reports a stream that was still delivering tokens as generating', () => {
    const verdict = diagnoseTimeout(trace({ openStreams: [open({ sinceLastByteMs: 200 })] }));
    expect(verdict.kind).toBe('generating-at-cutoff');
    expect(verdict.seq).toBe(1);
  });

  // NEGATIVE CONTROL. The hypothesis this module was written to test is that
  // the model runs long. A classifier that answered `generating-at-cutoff` for
  // a silent socket would confirm that hypothesis whatever the truth was.
  it('does not call a silent socket generating', () => {
    const verdict = diagnoseTimeout(trace({ openStreams: [open({ sinceLastByteMs: 400_000 })] }));
    expect(verdict.kind).toBe('stream-stalled');
  });

  it('separates a request that never produced a byte from one that went quiet', () => {
    expect(diagnoseTimeout(trace({ openStreams: [open({ sinceLastByteMs: null, bytes: 0 })] })).kind)
      .toBe('no-first-token');
  });

  it('prefers a live stream over a stale one, because the live one explains the rest', () => {
    const verdict = diagnoseTimeout(trace({
      openStreams: [open({ seq: 1, sinceLastByteMs: 400_000 }), open({ seq: 2, sinceLastByteMs: 50 })],
    }));
    expect(verdict.kind).toBe('generating-at-cutoff');
    expect(verdict.seq).toBe(2);
  });

  it('blames the client when every stream finished cleanly', () => {
    const verdict = diagnoseTimeout(trace({ streams: [done({}), done({ seq: 1 })] }));
    expect(verdict.kind).toBe('idle-between-turns');
  });

  // NEGATIVE CONTROL. The CLI opens a warm-up completion and cancels it after
  // about a second. A cancelled turn cannot carry a terminator, so reading one
  // as a missing terminator would blame the runtime for the client's choice.
  it('does not blame the server for a turn the agent cancelled', () => {
    const cancelled = done({ seq: 0, ended: 'client-closed', sawTerminator: false, bytes: 1_412 });
    expect(diagnoseTimeout(trace({ streams: [cancelled] })).kind)
      .toBe('no-request-reached-the-model');
    expect(diagnoseTimeout(trace({ streams: [done({ seq: 1 }), cancelled] })).kind)
      .toBe('idle-between-turns');
  });

  it('names a missing terminator when the last completed stream had none', () => {
    const verdict = diagnoseTimeout(trace({ streams: [done({ sawTerminator: false })] }));
    expect(verdict.kind).toBe('stream-ended-without-terminator');
  });

  it('says so when the agent never reached the runtime at all', () => {
    expect(diagnoseTimeout(trace({ requests: 0 })).kind).toBe('no-request-reached-the-model');
  });

  // NEGATIVE CONTROL. The CLI probes `/api/hello` and calls `count_tokens`
  // against the same base URL, and neither is an SSE turn. A first cut of this
  // module counted them, and reported a missing terminator on every timeout it
  // was shown — a diagnosis that always fires is no diagnosis.
  it('ignores the CLI probes that are not completion turns', () => {
    const probe = done({ seq: 0, url: '/api/hello', status: 404, bytes: 0, events: {}, sawTerminator: false });
    const countTokens = done({ seq: 1, url: '/v1/messages/count_tokens', events: {}, sawTerminator: false });
    expect(diagnoseTimeout(trace({ streams: [probe, countTokens] })).kind)
      .toBe('no-request-reached-the-model');
    expect(diagnoseTimeout(trace({ streams: [done({ seq: 0 }), probe] })).kind)
      .toBe('idle-between-turns');
  });
});
