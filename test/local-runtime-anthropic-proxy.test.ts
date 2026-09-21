/**
 * The Anthropic normalising proxy (src/core/local-runtime/llama/anthropic-proxy.ts).
 *
 * Unlike test/local-runtime-llama.test.ts, this file binds REAL loopback
 * sockets — two of them per test, a stub standing in for llama-server and the
 * proxy in front of it. There is no way to pin "the body llama-server actually
 * received" or "the client saw a chunk before the stream ended" without a
 * socket, and those two facts are the entire product here. No llama-server is
 * started and no model is loaded.
 *
 * What is pinned, in the order it would hurt to get wrong:
 *
 *   - the shim runs on POST /v1/messages, and ONLY there. A normaliser that
 *     leaked onto /v1/chat/completions would silently rewrite the
 *     OpenAI-compatible lane that already works.
 *   - responses stream. This is proved causally, not by timing: the stub
 *     refuses to write its second chunk until the client confirms it received
 *     the first, so a buffering proxy deadlocks instead of passing.
 *   - a malformed body is forwarded verbatim. The alternative — 500ing — makes
 *     the proxy a new source of failure for requests llama-server could have
 *     answered, or at least explained better than we can.
 *   - content-length is recomputed. The shim changes the body's length, and a
 *     stale length is a truncated prompt or a hung socket, never a clean error.
 *   - the bind stays on loopback. Neither this proxy nor llama-server behind it
 *     has any authentication at all.
 *   - close() actually releases the port and is idempotent.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { connect } from 'node:net';

import {
  gateBindHost,
  isLoopbackHost,
  resolveLocalAnthropicBaseUrl,
} from '../src/core/local-runtime/llama/config.js';
import {
  anthropicProxyHandle,
  ensureAnthropicProxy,
  isMessagesPost,
  normaliseMessagesBody,
  startAnthropicProxy,
  stopAnthropicProxy,
  type AnthropicProxyHandle,
} from '../src/core/local-runtime/llama/anthropic-proxy.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Upstream {
  origin: string;
  /** Every request the stub saw, with its raw (unparsed) body bytes. */
  seen: { method: string; url: string; headers: NodeJS.Dict<string | string[]>; body: Buffer }[];
  close(): Promise<void>;
}

type UpstreamHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
) => void | Promise<void>;

/** A loopback stand-in for llama-server that records exactly what it received. */
async function startUpstream(handler?: UpstreamHandler): Promise<Upstream> {
  const seen: Upstream['seen'] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
      });
      if (handler) {
        void Promise.resolve(handler(req, res, body)).catch(() => {
          if (!res.writableEnded) res.end();
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no upstream port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

interface Reply {
  status: number;
  headers: NodeJS.Dict<string | string[]>;
  body: string;
}

/** POST/GET through the proxy, collecting the whole response. */
function call(
  handle: AnthropicProxyHandle,
  path: string,
  options: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  return new Promise<Reply>((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: handle.host,
        port: handle.port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** A promise plus the function that settles it — for the streaming handshake. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Reject rather than hang, so a buffering proxy fails legibly. */
function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms).unref(),
    ),
  ]);
}

/** The exact shape captured from a real Claude Code request. */
const CLAUDE_CODE_BODY = {
  model: 'local',
  stream: true,
  system: [{ type: 'text', text: 'outer system' }],
  messages: [
    { role: 'user', content: 'do the thing' },
    { role: 'system', content: [{ type: 'text', text: 'inner system' }] },
  ],
};

const started: { upstream?: Upstream; proxy?: AnthropicProxyHandle } = {};

afterEach(async () => {
  await started.proxy?.close();
  await started.upstream?.close();
  await stopAnthropicProxy();
  delete started.proxy;
  delete started.upstream;
});

/** Bring up a stub llama-server and a proxy pointed at it. */
async function fixture(handler?: UpstreamHandler): Promise<{
  upstream: Upstream;
  proxy: AnthropicProxyHandle;
}> {
  const upstream = await startUpstream(handler);
  const proxy = await startAnthropicProxy({
    host: '127.0.0.1',
    port: 0,
    upstreamOrigin: upstream.origin,
  });
  started.upstream = upstream;
  started.proxy = proxy;
  return { upstream, proxy };
}

// ---------------------------------------------------------------------------

describe('anthropic proxy — normalisation on /v1/messages', () => {
  it('hoists the system turn Claude Code puts second, before llama-server sees it', async () => {
    const { upstream, proxy } = await fixture();

    const reply = await call(proxy, '/v1/messages', {
      method: 'POST',
      body: JSON.stringify(CLAUDE_CODE_BODY),
      headers: { 'content-type': 'application/json' },
    });
    expect(reply.status).toBe(200);

    const received = JSON.parse(upstream.seen[0]?.body.toString('utf8') ?? '{}') as {
      system: { text: string }[];
      messages: { role: string }[];
      stream: boolean;
    };
    // This is the whole feature: Qwen3.8's template refuses a system role that
    // is not first, so what reaches llama-server must have none left.
    expect(received.messages.map((m) => m.role)).toEqual(['user']);
    expect(received.system.map((b) => b.text)).toEqual(['outer system', 'inner system']);
    // Every other field survives untouched — the shim is not a filter.
    expect(received.stream).toBe(true);
  });

  it('recomputes content-length instead of forwarding the original', async () => {
    const { upstream, proxy } = await fixture();
    const raw = JSON.stringify(CLAUDE_CODE_BODY);

    await call(proxy, '/v1/messages', {
      method: 'POST',
      body: raw,
      headers: { 'content-type': 'application/json', 'content-length': String(raw.length) },
    });

    const entry = upstream.seen[0];
    const forwarded = entry?.headers['content-length'];
    // A stale length here is the nastiest failure available: llama-server
    // either truncates the prompt or waits forever for bytes never coming.
    expect(forwarded).toBe(String(entry?.body.length));
    expect(forwarded).not.toBe(String(raw.length));
  });

  it('forwards a request that already complies byte-for-byte', async () => {
    const { upstream, proxy } = await fixture();
    // Deliberately odd spacing and key order: re-serialising would change both,
    // and there is no reason to rewrite a request that needs nothing.
    const raw = '{"messages":[{"role":"user","content":"hi"}],  "model":"local"}';

    await call(proxy, '/v1/messages', {
      method: 'POST',
      body: raw,
      headers: { 'content-type': 'application/json' },
    });

    expect(upstream.seen[0]?.body.toString('utf8')).toBe(raw);
  });

  it('carries the method, path, query and headers through unchanged', async () => {
    const { upstream, proxy } = await fixture();

    await call(proxy, '/v1/messages?beta=true', {
      method: 'POST',
      body: JSON.stringify(CLAUDE_CODE_BODY),
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    });

    expect(upstream.seen[0]?.method).toBe('POST');
    expect(upstream.seen[0]?.url).toBe('/v1/messages?beta=true');
    // Auth and version headers are the client's; the proxy is not a gateway.
    expect(upstream.seen[0]?.headers['anthropic-version']).toBe('2023-06-01');
  });
});

describe('anthropic proxy — everything else is a pipe', () => {
  it('leaves a POST on the OpenAI-compatible path completely alone', async () => {
    const { upstream, proxy } = await fixture();
    // The SAME body the shim would rewrite on /v1/messages. If normalisation
    // ever leaks onto this path it silently changes the lane that already
    // works, which is the regression this test exists for.
    const raw = JSON.stringify(CLAUDE_CODE_BODY);

    await call(proxy, '/v1/chat/completions', {
      method: 'POST',
      body: raw,
      headers: { 'content-type': 'application/json' },
    });

    expect(upstream.seen[0]?.url).toBe('/v1/chat/completions');
    expect(upstream.seen[0]?.body.toString('utf8')).toBe(raw);
  });

  it('leaves a GET on /v1/messages alone (only POST bodies are rewritten)', async () => {
    const { upstream, proxy } = await fixture();
    await call(proxy, '/v1/messages');
    expect(upstream.seen[0]?.method).toBe('GET');
    expect(upstream.seen[0]?.body.length).toBe(0);
  });

  it('pipes the health and capacity endpoints the rest of the hub depends on', async () => {
    const { upstream, proxy } = await fixture((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-stub': req.url ?? '' });
      res.end(JSON.stringify({ total_slots: 4 }));
    });

    for (const path of ['/health', '/props', '/slots']) {
      const reply = await call(proxy, path);
      expect(reply.status).toBe(200);
      expect(reply.headers['x-stub']).toBe(path);
      expect(reply.body).toBe('{"total_slots":4}');
    }
    expect(upstream.seen.map((entry) => entry.url)).toEqual(['/health', '/props', '/slots']);
  });

  it('returns the upstream status and headers rather than inventing its own', async () => {
    const { proxy } = await fixture((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' });
      res.end('{"type":"error"}');
    });

    const reply = await call(proxy, '/v1/messages', { method: 'POST', body: '{}' });
    expect(reply.status).toBe(429);
    expect(reply.headers['retry-after']).toBe('3');
    expect(reply.body).toBe('{"type":"error"}');
  });
});

describe('anthropic proxy — streaming', () => {
  it('delivers a chunk to the client while the upstream is still writing', async () => {
    // A CAUSAL proof rather than a timing one. The stub will not write its
    // second frame until the client says it received the first, so a proxy
    // that buffers the body deadlocks and this test fails on the deadline
    // instead of passing by accident on a fast machine.
    const clientGotFirst = deferred<void>();

    const { proxy } = await fixture(async (_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      await withDeadline(clientGotFirst.promise, 4_000, 'the client to receive frame 1');
      res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      res.end();
    });

    const frames: string[] = [];
    const finished = deferred<void>();

    const req = httpRequest(
      {
        hostname: proxy.host,
        port: proxy.port,
        path: '/v1/messages',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        expect(res.headers['content-type']).toBe('text/event-stream');
        res.on('data', (chunk: Buffer) => {
          frames.push(chunk.toString('utf8'));
          // Unblocks the upstream. Reaching here at all is the assertion.
          clientGotFirst.resolve();
        });
        res.on('end', () => finished.resolve());
      },
    );
    req.end(JSON.stringify({ ...CLAUDE_CODE_BODY, stream: true }));

    await withDeadline(finished.promise, 8_000, 'the stream to finish');

    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames.join('')).toContain('message_start');
    expect(frames.join('')).toContain('message_stop');
  });
});

describe('anthropic proxy — malformed input never becomes a proxy failure', () => {
  it('forwards a body that is not JSON verbatim', async () => {
    const { upstream, proxy } = await fixture((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":"upstream said so"}');
    });

    const raw = '{"messages": [ this is not json';
    const reply = await call(proxy, '/v1/messages', {
      method: 'POST',
      body: raw,
      headers: { 'content-type': 'application/json' },
    });

    expect(upstream.seen[0]?.body.toString('utf8')).toBe(raw);
    // llama-server's own complaint reaches the caller. A 500 minted here would
    // replace a specific upstream error with a vague one of ours.
    expect(reply.status).toBe(400);
    expect(reply.body).toBe('{"error":"upstream said so"}');
  });

  it.each([
    ['empty', ''],
    ['a bare JSON array', '[1,2,3]'],
    ['a JSON string', '"just a string"'],
    ['binary junk', ' '],
  ])('forwards %s verbatim', async (_label, raw) => {
    const { upstream, proxy } = await fixture();
    await call(proxy, '/v1/messages', { method: 'POST', body: raw });
    expect(upstream.seen[0]?.body.toString('utf8')).toBe(raw);
  });

  it('degrades an over-the-cap body to an unnormalised pipe instead of failing', async () => {
    const upstream = await startUpstream();
    started.upstream = upstream;
    // The cap is 32 MB in production. Shrinking it here is the only way to
    // exercise the degrade path at all — an untested fallback is one nobody
    // discovers is broken until the day it runs.
    const proxy = await startAnthropicProxy({
      host: '127.0.0.1',
      port: 0,
      upstreamOrigin: upstream.origin,
      maxNormalisedBodyBytes: 64,
    });
    started.proxy = proxy;

    // Well over 64 bytes, and exactly the shape the shim would otherwise
    // rewrite — so "arrived unchanged" can only mean the cap took effect.
    const raw = JSON.stringify({
      ...CLAUDE_CODE_BODY,
      padding: 'x'.repeat(4096),
    });
    expect(raw.length).toBeGreaterThan(64);

    const reply = await call(proxy, '/v1/messages', {
      method: 'POST',
      body: raw,
      headers: { 'content-type': 'application/json' },
    });

    expect(reply.status).toBe(200);
    // Every byte, in order, and none of them rewritten: an oversized request
    // degrades to the passthrough it would have had with no proxy at all.
    expect(upstream.seen[0]?.body.toString('utf8')).toBe(raw);
  });

  it('normaliseMessagesBody returns the identical buffer when it cannot help', () => {
    // Pinned at the pure level too: this is the one function in the request
    // path that parses attacker-shaped input, so "never throws" is a property
    // worth asserting without a socket in the way.
    for (const raw of ['', 'null', '[]', '"s"', '{oops', '{"messages":"not-an-array"}']) {
      const buffer = Buffer.from(raw, 'utf8');
      expect(normaliseMessagesBody(buffer)).toBe(buffer);
    }
  });

  it('answers 502 rather than hanging when llama-server is not there', async () => {
    const upstream = await startUpstream();
    const origin = upstream.origin;
    await upstream.close();

    const proxy = await startAnthropicProxy({
      host: '127.0.0.1',
      port: 0,
      upstreamOrigin: origin,
    });
    started.proxy = proxy;

    const reply = await call(proxy, '/v1/messages', { method: 'POST', body: '{}' });
    expect(reply.status).toBe(502);
    expect(reply.body).toContain('anthropic-proxy');
  });

  it('classifies the request shape without touching the network', () => {
    expect(isMessagesPost('POST', '/v1/messages')).toBe(true);
    expect(isMessagesPost('post', '/v1/messages?beta=true')).toBe(true);
    expect(isMessagesPost('GET', '/v1/messages')).toBe(false);
    expect(isMessagesPost('POST', '/v1/chat/completions')).toBe(false);
    expect(isMessagesPost('POST', '/v1/messages/count_tokens')).toBe(false);
    expect(isMessagesPost(undefined, undefined)).toBe(false);
  });
});

describe('anthropic proxy — the loopback guard', () => {
  it('refuses a non-loopback bind without the persisted opt-in, and says so', async () => {
    const upstream = await startUpstream();
    started.upstream = upstream;
    const proxy = await startAnthropicProxy({
      host: '0.0.0.0',
      port: 0,
      upstreamOrigin: upstream.origin,
    });
    started.proxy = proxy;

    // Neither this proxy nor llama-server behind it authenticates anything, so
    // a function argument must never be able to put it on the LAN.
    expect(proxy.host).toBe('127.0.0.1');
    expect(proxy.hostDowngradedFrom).toBe('0.0.0.0');
    expect(isLoopbackHost(proxy.host)).toBe(true);
    expect(proxy.baseUrl.startsWith('http://127.0.0.1:')).toBe(true);
  });

  it('gateBindHost is the single rule, and only the persisted opt-in opens it', () => {
    // Asserted purely: the honoured branch would otherwise mean binding a real
    // LAN socket in CI, which is exactly the thing this rule is about.
    expect(gateBindHost('0.0.0.0', false)).toEqual({
      host: '127.0.0.1',
      downgradedFrom: '0.0.0.0',
    });
    expect(gateBindHost('10.0.0.4', false).host).toBe('127.0.0.1');
    expect(gateBindHost('0.0.0.0', true)).toEqual({ host: '0.0.0.0', downgradedFrom: null });
    for (const loopback of ['127.0.0.1', 'localhost', '::1']) {
      expect(gateBindHost(loopback, false)).toEqual({ host: loopback, downgradedFrom: null });
    }
  });

  it('points the Anthropic base URL at the proxy port, not at llama-server', () => {
    const cfg = {
      models: { llamaServer: { host: '127.0.0.1', port: 8080, anthropicPort: 9911 } },
    } as never;
    expect(resolveLocalAnthropicBaseUrl(cfg)).toBe('http://127.0.0.1:9911/v1');
  });

  it('lets the operator override the Anthropic base URL outright', () => {
    const cfg = {
      models: { llamaServer: { anthropicBaseUrl: 'http://127.0.0.1:7000/v1', anthropicPort: 9911 } },
    } as never;
    expect(resolveLocalAnthropicBaseUrl(cfg)).toBe('http://127.0.0.1:7000/v1');
  });
});

describe('anthropic proxy — shutdown', () => {
  /** Can anything still accept a TCP connection here? */
  function portAccepts(host: string, port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const socket = connect({ host, port });
      const settle = (accepted: boolean): void => {
        socket.destroy();
        resolve(accepted);
      };
      socket.once('connect', () => settle(true));
      socket.once('error', () => settle(false));
      socket.setTimeout(1_000, () => settle(false));
    });
  }

  it('does not hold the event loop open, so a one-shot CLI still exits', async () => {
    // REGRESSION, and it was a real one: a listening socket is a ref'd handle.
    // `ashlr local-runtime start` sets process.exitCode and lets Node exit when
    // the loop empties, so an un-unref'd proxy meant the command never returned
    // to the shell. Measured before the fix: a process that started the proxy
    // and then did nothing was still alive 8 seconds later.
    //
    // `getActiveResourcesInfo()` lists only the handles currently KEEPING the
    // loop alive, so the delta across start is the whole assertion — counting
    // absolutely would trip over vitest's own sockets and the upstream stub.
    const listeners = (): number =>
      process.getActiveResourcesInfo().filter((kind) => kind === 'TCPServerWrap').length;

    const before = listeners();
    const upstream = await startUpstream();
    started.upstream = upstream;
    const afterUpstream = listeners();

    // Self-check FIRST. The stub is an ordinary ref'd listener, so if this
    // delta is not 1 the metric has stopped measuring what this test thinks it
    // measures and the real assertion below would pass vacuously — which is
    // exactly how this test failed on its first run.
    expect(afterUpstream - before).toBe(1);

    const proxy = await startAnthropicProxy({
      host: '127.0.0.1',
      port: 0,
      upstreamOrigin: upstream.origin,
    });
    started.proxy = proxy;

    // The real assertion: the proxy holds the loop open by exactly nothing.
    expect(listeners() - afterUpstream).toBe(0);
    // ...while genuinely listening.
    expect(await portAccepts(proxy.host, proxy.port)).toBe(true);
    expect(proxy.holdsProcessOpen).toBe(false);
  });

  it('holds the loop open ONLY for the dedicated host process', async () => {
    // The one documented exception to the unref rule above, and the pair has to
    // be tested together or the next person reads the two comments and picks
    // whichever they like.
    //
    // proxy-host.ts is a process whose entire reason to exist IS this listener:
    // there, an unref'd socket means Node sees an empty event loop and exits
    // before serving a single request — the exact inverse of the bug unref was
    // added to fix. Everywhere else the default must stay, so that a one-shot
    // CLI still returns to the shell.
    const listeners = (): number =>
      process.getActiveResourcesInfo().filter((kind) => kind === 'TCPServerWrap').length;

    const upstream = await startUpstream();
    started.upstream = upstream;
    const before = listeners();

    const proxy = await startAnthropicProxy({
      host: '127.0.0.1',
      port: 0,
      upstreamOrigin: upstream.origin,
      holdProcessOpen: true,
    });
    started.proxy = proxy;

    expect(proxy.holdsProcessOpen).toBe(true);
    expect(listeners() - before).toBe(1);
    expect(await portAccepts(proxy.host, proxy.port)).toBe(true);

    // And it still lets go on close, or the host process could never exit on
    // SIGTERM and `stop` would have to escalate to SIGKILL every time.
    await proxy.close();
    expect(listeners() - before).toBe(0);
    expect(await portAccepts(proxy.host, proxy.port)).toBe(false);
  });

  it('releases the port and is idempotent', async () => {
    const upstream = await startUpstream();
    started.upstream = upstream;
    const proxy = await startAnthropicProxy({
      host: '127.0.0.1',
      port: 0,
      upstreamOrigin: upstream.origin,
    });

    expect(await portAccepts(proxy.host, proxy.port)).toBe(true);

    await proxy.close();
    // A listener left alive past close() is a port that answers Claude Code's
    // requests with 502s forever, and nothing would report it.
    expect(await portAccepts(proxy.host, proxy.port)).toBe(false);

    // Twice is a no-op, not a crash: `stop` runs on paths that may already have
    // released it.
    await expect(proxy.close()).resolves.toBeUndefined();
  });

  it('cuts a live stream instead of waiting for a client that never goes idle', async () => {
    // `server.close()` alone waits for keep-alive sockets. An SSE response
    // never goes idle, so without closeAllConnections this hangs forever —
    // which is a leaked listener wearing a different hat.
    const { proxy } = await fixture(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: open\n\n');
      await new Promise<void>((resolve) => setTimeout(resolve, 30_000).unref());
    });

    const opened = deferred<void>();
    const req = httpRequest(
      {
        hostname: proxy.host,
        port: proxy.port,
        path: '/v1/messages',
        method: 'POST',
      },
      (res) => {
        res.on('data', () => opened.resolve());
        res.on('error', () => undefined);
      },
    );
    req.on('error', () => undefined);
    req.end('{}');

    await withDeadline(opened.promise, 4_000, 'the stream to open');
    await withDeadline(proxy.close(), 4_000, 'close() to return with a stream open');
    expect(await portAccepts(proxy.host, proxy.port)).toBe(false);
  });

  it('ensure/stop keep exactly one proxy per process', async () => {
    const upstream = await startUpstream();
    started.upstream = upstream;

    expect(anthropicProxyHandle()).toBeNull();

    const first = await ensureAnthropicProxy({
      host: '127.0.0.1',
      port: 0,
      upstreamOrigin: upstream.origin,
    });
    expect('handle' in first).toBe(true);
    if (!('handle' in first)) return;

    // A second ensure must not bind a second socket — `start` is idempotent and
    // callers re-run it freely.
    const second = await ensureAnthropicProxy({ host: '127.0.0.1', port: 0 });
    expect('handle' in second && second.handle).toBe(first.handle);
    expect(anthropicProxyHandle()).toBe(first.handle);

    expect(await stopAnthropicProxy()).toBe(true);
    expect(anthropicProxyHandle()).toBeNull();
    expect(await portAccepts(first.handle.host, first.handle.port)).toBe(false);
    // Stopping what is already stopped is a no-op, never an error.
    expect(await stopAnthropicProxy()).toBe(false);
  });

  it('reports a bind failure rather than throwing out of ensure', async () => {
    const upstream = await startUpstream();
    started.upstream = upstream;

    const blocker = await startAnthropicProxy({
      host: '127.0.0.1',
      port: 0,
      upstreamOrigin: upstream.origin,
    });
    started.proxy = blocker;

    // llama-server serving correctly must stay a success even when the lane in
    // front of it cannot bind, so this is a value and not an exception.
    const result = await ensureAnthropicProxy({
      host: '127.0.0.1',
      port: blocker.port,
      upstreamOrigin: upstream.origin,
    });
    expect('error' in result).toBe(true);
    expect(anthropicProxyHandle()).toBeNull();
  });
});
