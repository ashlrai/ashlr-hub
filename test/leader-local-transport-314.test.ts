/**
 * 3.14 — the local Leader transport, against a real loopback HTTP server
 * (real-io lane: it binds a port).
 *
 * On 2026-09-26 the 06:30 memo failed with "fetch failed" at 5m2s: the
 * request was `stream: false`, so the server sent no headers until the whole
 * memo was decoded (~3 tok/s on a 27B), and Node's fetch gives up after 300 s
 * without headers. The transport now streams, so the per-attempt timeout is
 * the only wall-clock limit; it also caps the requested context (num_ctx).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LEADER_SYSTEM_PROMPT } from '../src/core/vision/leader.js';
import { LeaderTimeoutError, ollamaLeaderTransport } from '../src/core/vision/leader-seat.js';

// ---------------------------------------------------------------------------
// 5. The local transport
// ---------------------------------------------------------------------------

describe('ollamaLeaderTransport (streamed, context-capped)', () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  async function serve(handler: (body: Record<string, unknown>, res: import('node:http').ServerResponse) => void): Promise<string> {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
      req.on('end', () => handler(JSON.parse(raw) as Record<string, unknown>, res));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  it('streams: headers arrive at once, chunks are concatenated; num_ctx and num_predict are sent', async () => {
    let seen: Record<string, unknown> = {};
    const base = await serve((body, res) => {
      seen = body;
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ message: { content: '{"a":' } })}\n`);
      setTimeout(() => {
        res.write(`${JSON.stringify({ message: { content: '1}' } })}\n`);
        res.end(`${JSON.stringify({ done: true })}\n`);
      }, 20);
    });
    const out = await ollamaLeaderTransport(base, 'gpt-oss:20b', undefined, 5_000, { maxOutputTokens: 1_024, contextTokens: 12_288 })('S', 'U');
    expect(out).toBe('{"a":1}');
    expect(seen).toMatchObject({ model: 'gpt-oss:20b', stream: true, format: 'json', options: { num_predict: 1_024, num_ctx: 12_288 } });
  });

  it('a stream error line and the per-attempt timeout are reported as such', async () => {
    const base = await serve((_b, res) => {
      res.writeHead(200);
      res.end(`${JSON.stringify({ error: 'model requires more system memory' })}\n`);
    });
    await expect(ollamaLeaderTransport(base, 'm', undefined, 5_000)('S', 'U')).rejects.toThrow(/ollama: model requires more system memory/);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    const slow = await serve((_b, res) => { res.writeHead(200); res.write('\n'); /* never ends */ });
    await expect(ollamaLeaderTransport(slow, 'm', undefined, 150)('S', 'U')).rejects.toBeInstanceOf(LeaderTimeoutError);
  });

  it.each([
    ['content without completion', `${JSON.stringify({ message: { content: '{"a":1}' } })}\n`, 'incomplete'],
    ['done false only', `${JSON.stringify({ message: { content: '{"a":1}' }, done: false })}\n`, 'incomplete'],
    ['empty response', '', 'incomplete'],
    ['malformed middle record', `{broken}\n${JSON.stringify({ message: { content: '{"a":1}' }, done: true })}\n`, 'malformed'],
    ['torn final record', `${JSON.stringify({ message: { content: '{"a":1}' } })}\n{"done":`, 'malformed'],
    ['array record', `[]\n${JSON.stringify({ done: true })}\n`, 'malformed'],
    ['null record', `null\n${JSON.stringify({ done: true })}\n`, 'malformed'],
    ['scalar record', `1\n${JSON.stringify({ done: true })}\n`, 'malformed'],
    ['nonboolean completion', `${JSON.stringify({ message: { content: '{"a":1}' }, done: 'true' })}\n`, 'malformed'],
    ['content after completion', `${JSON.stringify({ done: true })}\n${JSON.stringify({ message: { content: '{"a":1}' } })}\n`, 'malformed'],
  ])('rejects %s before returning a partial memo', async (_name, payload, reason) => {
    const base = await serve((_body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(payload);
    });
    await expect(ollamaLeaderTransport(base, 'm', undefined, 5_000)('S', 'U'))
      .rejects.toThrow(`ollama: ${reason} response stream`);
  });

  it('preserves fragmented UTF8/JSON, CRLF/blank records and final content without LF', async () => {
    const payload = Buffer.from(` \r\n${JSON.stringify({ message: { content: 'a😀' } })}\r\n\n${JSON.stringify({ message: { content: 'b' }, done: true, eval_count: 3 })}`);
    const unicode = payload.indexOf(Buffer.from('😀'));
    const base = await serve((_body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(payload.subarray(0, unicode + 1));
      setTimeout(() => {
        res.write(payload.subarray(unicode + 1, unicode + 3));
        res.end(payload.subarray(unicode + 3));
      }, 20);
    });
    await expect(ollamaLeaderTransport(base, 'm', undefined, 5_000)('S', 'U')).resolves.toBe('a😀b');
  });

  it('accepts blank records after completion', async () => {
    const base = await serve((_body, res) => {
      res.writeHead(200);
      res.end(`${JSON.stringify({ message: { content: 'ok' }, done: true })}\n \r\n`);
    });
    await expect(ollamaLeaderTransport(base, 'm', undefined, 5_000)('S', 'U')).resolves.toBe('ok');
  });

  it.each(['pending', 'rejected', 'throws'] as const)('cleanup %s cannot hang or replace the framing error', async (kind) => {
    // Exercise the actual transport with controlled reader cleanup: awaiting
    // the never-settling cancellation would hang beyond the caller's timer.
    const cancel = vi.fn((): Promise<void> => {
      if (kind === 'throws') throw new Error('cleanup-private-detail');
      return kind === 'pending' ? new Promise(() => {}) : Promise.reject(new Error('cleanup-private-detail'));
    });
    const releaseLock = vi.fn(() => { throw new Error('release-private-detail'); });
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('{broken}\n') })
      .mockResolvedValueOnce({ done: true });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    } as unknown as Response);
    try {
      await expect(ollamaLeaderTransport('http://127.0.0.1:11434', 'm', undefined, 5_000)('S', 'U'))
        .rejects.toThrow('ollama: malformed response stream');
      expect(cancel).toHaveBeenCalledOnce();
      expect(releaseLock).toHaveBeenCalledOnce();
    } finally {
      fetch.mockRestore();
    }
  });

  it('the system prompt is unchanged by 3.14', () => {
    expect(LEADER_SYSTEM_PROMPT).toMatch(/You are the Leader/);
  });
});
