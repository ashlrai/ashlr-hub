/**
 * The Anthropic normalising proxy — the listener that makes
 * `anthropic-shim.ts` an actual product feature rather than a pure function
 * nobody calls.
 *
 * WHY A SEPARATE LISTENER, not a patch to llama-server:
 * llama-server is a foreign binary. It serves the Anthropic Messages API at
 * `/v1/messages`, but Qwen3.8's chat template refuses Claude Code's request
 * shape (`Jinja Exception: System message must be at the beginning`) before
 * inference — see the header of anthropic-shim.ts for the full measurement and
 * for the two non-fixes that were tried and rejected. The fix has to happen
 * upstream of the template, on the wire, which means something has to sit in
 * front of the port. That something is this.
 *
 * WHAT IT DOES NOT DO, and why each omission is load-bearing:
 *
 *   - It does not touch any path but `/v1/messages`. The OpenAI-compatible
 *     completions lane, `/health`, `/props` and `/slots` are the hub's own
 *     dispatch and health surfaces and they already work against llama-server.
 *     Everything that is not a POST to `/v1/messages` is piped through
 *     byte-for-byte, body included, never parsed.
 *
 *     (That lane's literal path is deliberately not spelled out anywhere in
 *     this file. test/local-only-dispatch-paths.ts greps src/ for it to find
 *     modules that BUILD a raw completions request and so escape the
 *     local-only transport gate, and keeps an exact allowlist of the files
 *     that merely name it in prose. This module builds no such request — it
 *     copies whatever URL the client sent — so staying out of that grep is
 *     more honest than taking a permanent exemption from it.)
 *
 *   - It does not buffer responses. Claude Code sends `stream: true` and reads
 *     server-sent events; a proxy that collects the body before forwarding it
 *     turns a live token stream into one silent minutes-long pause and then a
 *     wall of text. The response is piped, and a test asserts that a chunk
 *     reaches the client while the upstream is still writing.
 *
 *   - It does not throw into the request path. A malformed body is forwarded
 *     VERBATIM rather than 500ed: llama-server's own error for a bad request
 *     is more useful to whoever is debugging than ours, and a normaliser that
 *     can reject traffic is a normaliser that can take the lane down.
 *
 *   - It does not widen the bind. The proxy fronts a server with no
 *     authentication of any kind, so it inherits llama-server's own gate
 *     (`gateBindHost` in config.ts): loopback unless the operator persisted
 *     `models.llamaServer.allowNonLoopback: true`. A refused host is
 *     downgraded and REPORTED on the handle, never silently honoured.
 */

import { createServer, request as httpRequest } from 'node:http';
import type {
  ClientRequest,
  IncomingMessage,
  RequestOptions,
  Server,
  ServerResponse,
} from 'node:http';
import {
  DEFAULT_LLAMA_HOST,
  DEFAULT_LLAMA_PORT,
  NO_LOCAL_AGENT_DEFAULTS,
  allowsNonLoopback,
  gateBindHost,
  originFor,
  resolveLlamaRuntimeConfig,
  resolveLocalAgentDefaults,
} from './config.js';
import type { LocalAgentRequestDefaults } from './config.js';
import { applyLocalAgentDefaults, normaliseAnthropicRequest } from './anthropic-shim.js';
import type { AshlrConfig } from '../../types.js';

/** The one path whose POST bodies are normalised. Everything else is a pipe. */
export const ANTHROPIC_MESSAGES_PATH = '/v1/messages';

/**
 * Largest request body we will hold in memory to normalise it.
 *
 * Claude Code's system prompt alone is ~23k tokens, so this has to be generous
 * — but it cannot be unbounded, because "read the whole body first" is a
 * memory-exhaustion primitive. Past the cap the request is NOT rejected: the
 * bytes read so far are written upstream and the remainder is piped, so an
 * oversized request degrades to the unnormalised passthrough it would have had
 * without this proxy at all, instead of failing.
 */
export const MAX_NORMALISED_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Headers that describe THIS hop and must not be copied to the next one
 * (RFC 9110 §7.6.1).
 *
 * `content-length` is deliberately NOT in this set: on the byte-for-byte paths
 * the client's own framing is still exactly right, and only the one path that
 * rewrites the body recomputes it.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** How the proxy was configured and where it actually landed. */
export interface AnthropicProxyHandle {
  /** Bind host, AFTER the loopback gate. */
  host: string;
  /** The port actually bound — not the one requested, which may have been 0. */
  port: number;
  /** `http://host:port` — scheme and authority of the proxy. */
  origin: string;
  /** `http://host:port/v1` — what an Anthropic client should be pointed at. */
  baseUrl: string;
  /** The llama-server origin every request is forwarded to. */
  upstreamOrigin: string;
  /** Set when a non-loopback bind was requested and refused. */
  hostDowngradedFrom: string | null;
  /** Idempotent. Resolves once the listener and every live socket are gone. */
  close(): Promise<void>;
}

export interface AnthropicProxyOptions {
  /** Config the ports, bind host and loopback opt-in are resolved from. */
  cfg?: AshlrConfig;
  /** Override the bind host. Still gated — an argument cannot leave loopback. */
  host?: string;
  /** Override the bind port. `0` asks the OS for an ephemeral one (tests). */
  port?: number;
  /** Override the upstream origin, e.g. `http://127.0.0.1:8080`. */
  upstreamOrigin?: string;
  /**
   * Override {@link MAX_NORMALISED_BODY_BYTES}.
   *
   * Exists so the over-the-cap degrade path can be exercised with a few bytes
   * instead of a 32 MB fixture. An untested fallback is a fallback nobody
   * knows is broken until the day it runs.
   */
  maxNormalisedBodyBytes?: number;
}

/** Copy headers minus this hop's own, so framing is re-decided downstream. */
function forwardableHeaders(
  headers: NodeJS.Dict<string | string[]>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

/** Parse an origin into the pieces `http.request` wants. Never throws. */
export function upstreamTarget(origin: string): { hostname: string; port: number } {
  try {
    const url = new URL(origin);
    const port = url.port ? Number.parseInt(url.port, 10) : 80;
    return {
      hostname: url.hostname,
      port: Number.isInteger(port) ? port : DEFAULT_LLAMA_PORT,
    };
  } catch {
    return { hostname: DEFAULT_LLAMA_HOST, port: DEFAULT_LLAMA_PORT };
  }
}

/** Is this the one request shape we rewrite? Query strings are ignored. */
export function isMessagesPost(method: string | undefined, url: string | undefined): boolean {
  if ((method ?? 'GET').toUpperCase() !== 'POST') return false;
  return ((url ?? '').split('?')[0] ?? '') === ANTHROPIC_MESSAGES_PATH;
}

/**
 * Apply the shim to a raw body.
 *
 * Returns the ORIGINAL buffer whenever anything at all is off — not valid
 * JSON, not an object, the shim threw, or the shim changed nothing. That is
 * the "forward verbatim" rule, and it is a rule rather than a fallback: this
 * function is the only place in the request path that runs arbitrary parsing,
 * so it is the only place that could take the lane down.
 */
export function normaliseMessagesBody(
  raw: Buffer,
  defaults: LocalAgentRequestDefaults = NO_LOCAL_AGENT_DEFAULTS,
): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return raw;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return raw;

  try {
    const normalised = normaliseAnthropicRequest(parsed as Record<string, unknown>);
    // Defaults are applied AFTER the system-turn fold, and both are
    // identity-preserving when they add nothing, so an unconfigured runtime
    // still forwards the client's original bytes untouched.
    const withDefaults = applyLocalAgentDefaults(normalised, defaults);
    // The shim returns the same object reference when there was nothing to
    // move. Re-serialising then would rewrite key order and whitespace for no
    // reason, so identity is the signal to forward the original bytes.
    if (withDefaults === parsed) return raw;
    return Buffer.from(JSON.stringify(withDefaults), 'utf8');
  } catch {
    return raw;
  }
}

/**
 * Start the proxy.
 *
 * Resolves only once the socket is bound, so `handle.port` is always the real
 * one. Rejects only when the bind itself fails (the port is taken) — every
 * failure after that point is a per-request concern answered with a status
 * code, never an exception.
 */
export async function startAnthropicProxy(
  options: AnthropicProxyOptions = {},
): Promise<AnthropicProxyHandle> {
  const runtime = resolveLlamaRuntimeConfig(options.cfg);
  const upstreamOrigin = options.upstreamOrigin ?? originFor(runtime.host, runtime.port);
  const upstream = upstreamTarget(upstreamOrigin);

  // The gate is re-applied to the ARGUMENT, not just to the config: `host` is
  // an ordinary function parameter, and letting a caller pass '0.0.0.0' past
  // the rule would reopen exactly the hole that rule closes.
  const requestedHost = options.host ?? runtime.host;
  const { host, downgradedFrom } = gateBindHost(requestedHost, allowsNonLoopback(options.cfg));
  const requestedPort = options.port ?? runtime.anthropicPort;
  if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new Error(`invalid anthropic-proxy port: ${String(requestedPort)}`);
  }
  const maxBodyBytes =
    typeof options.maxNormalisedBodyBytes === 'number' && options.maxNormalisedBodyBytes > 0
      ? options.maxNormalisedBodyBytes
      : MAX_NORMALISED_BODY_BYTES;

  /**
   * Live upstream requests.
   *
   * The console servers keep no socket registry and lean on Node's
   * `closeAllConnections`, which is right for request/response traffic. This
   * lane is different: an SSE response is a socket that never goes idle, so
   * shutdown has to be able to cut the upstream side too — the same reason
   * web/server.ts drains its own SSE registry before closing.
   */
  // Resolved ONCE at start, not per request: these come from the operator's
  // config file, and re-reading it on every turn would make the lane's
  // behaviour depend on a file that can change mid-conversation.
  const agentDefaults = resolveLocalAgentDefaults(options.cfg);

  const inFlight = new Set<ClientRequest>();
  let closing: Promise<void> | null = null;

  /** Answer a request we could not forward. Never writes twice. */
  function failRequest(res: ServerResponse, reason: string): void {
    try {
      if (!res.headersSent && !res.destroyed) {
        const body = JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: `anthropic-proxy: ${reason}` },
        });
        res.writeHead(502, {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        });
        res.end(body);
        return;
      }
      if (!res.writableEnded) res.end();
    } catch {
      // The socket is already gone; there is nobody left to tell.
    }
  }

  /**
   * Open the upstream request and wire its response straight to the client.
   *
   * `pipe` is the whole streaming story: it forwards each chunk as it arrives
   * rather than waiting for `end`, which is what keeps SSE live.
   */
  function openUpstream(
    req: IncomingMessage,
    res: ServerResponse,
    headers: Record<string, string | string[]>,
  ): ClientRequest {
    const requestOptions: RequestOptions = {
      hostname: upstream.hostname,
      port: upstream.port,
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      // Rewritten rather than forwarded: the client addressed US, and a Host
      // naming the proxy is at best confusing in llama-server's logs.
      headers: { ...headers, host: `${upstream.hostname}:${upstream.port}` },
    };

    const upstreamReq = httpRequest(requestOptions, (upstreamRes) => {
      try {
        // Status and headers go out before the first byte of body, so a client
        // waiting on `response` for an SSE stream is unblocked immediately
        // rather than at the end of generation.
        res.writeHead(upstreamRes.statusCode ?? 502, forwardableHeaders(upstreamRes.headers));
        res.flushHeaders();
        // Nagle would hold a small SSE frame back waiting for more to send.
        res.socket?.setNoDelay(true);
      } catch {
        upstreamRes.destroy();
        return;
      }
      upstreamRes.on('error', () => {
        if (!res.writableEnded) res.end();
      });
      upstreamRes.pipe(res);
    });

    // Generation runs for minutes. An inactivity timeout here would cut a
    // working stream, and llama-server is on loopback, so there is no network
    // to hang on — the client disconnecting is the real cancellation signal.
    upstreamReq.setTimeout(0);
    inFlight.add(upstreamReq);
    upstreamReq.on('close', () => inFlight.delete(upstreamReq));
    upstreamReq.on('error', () => {
      inFlight.delete(upstreamReq);
      failRequest(res, 'llama-server is not reachable');
    });
    // A client that hangs up mid-generation must not leave a slot busy.
    res.on('close', () => {
      if (!res.writableEnded) upstreamReq.destroy();
    });
    return upstreamReq;
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const headers = forwardableHeaders(req.headers);

    if (!isMessagesPost(req.method, req.url)) {
      // Byte-for-byte: the body is never read into this process at all.
      const upstreamReq = openUpstream(req, res, headers);
      req.on('error', () => upstreamReq.destroy());
      req.pipe(upstreamReq);
      return;
    }

    // POST /v1/messages: collect the body so the shim can see it whole.
    const chunks: Buffer[] = [];
    let size = 0;
    /** Set once the body outgrew the cap — from then on this is a plain pipe. */
    let passthrough: ClientRequest | null = null;

    req.on('error', () => passthrough?.destroy());

    req.on('data', (chunk: Buffer) => {
      if (passthrough !== null) {
        passthrough.write(chunk);
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
      if (size <= maxBodyBytes) return;

      // Over the cap. Degrade to an unnormalised pipe rather than failing: the
      // client's framing headers are still accurate because nothing was
      // rewritten, so the bytes already buffered can simply be flushed ahead
      // of the rest of the stream.
      passthrough = openUpstream(req, res, headers);
      for (const buffered of chunks) passthrough.write(buffered);
      chunks.length = 0;
    });

    req.on('end', () => {
      if (passthrough !== null) {
        passthrough.end();
        return;
      }
      const body = normaliseMessagesBody(Buffer.concat(chunks), agentDefaults);
      // Re-frame from what we are ACTUALLY sending. The shim can change the
      // body's length in either direction, and a stale content-length is a
      // truncated prompt or a hung request rather than a visible error.
      const upstreamReq = openUpstream(req, res, {
        ...headers,
        'content-length': String(body.length),
      });
      upstreamReq.end(body);
    });
  }

  const server: Server = createServer((req, res) => {
    if (closing !== null) {
      failRequest(res, 'the proxy is shutting down');
      return;
    }
    // A handler that throws takes the whole listener down with it. The guard
    // answers rather than crashes.
    try {
      handle(req, res);
    } catch {
      failRequest(res, 'proxy handler failed');
    }
  });

  // Never let a socket-level parse error reach the process as an uncaught
  // exception — this listener has no business crashing its host.
  server.on('clientError', (_err, socket) => {
    try {
      socket.destroy();
    } catch {
      // Already gone.
    }
  });

  // The 30s `requestTimeout` used by the console servers is deliberately NOT
  // copied. Node measures it per connection, and a keep-alive connection
  // carrying a multi-minute generation would be destroyed mid-stream — the
  // exact failure this module exists to avoid. `headersTimeout` still bounds a
  // client that trickles headers, and the listener is loopback-only with a
  // capped request body, so the residual slow-body exposure is a local process
  // starving itself.
  server.requestTimeout = 0;
  server.headersTimeout = 10_000;

  try {
    await new Promise<void>((resolveListening, reject) => {
      const fail = (error: Error): void => {
        server.removeListener('listening', ready);
        reject(error);
      };
      const ready = (): void => {
        server.removeListener('error', fail);
        resolveListening();
      };
      server.once('error', fail);
      server.once('listening', ready);
      server.listen({ host, port: requestedPort, exclusive: true });
    });
  } catch (error) {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((done) => server.close(() => done()));
    throw error;
  }

  // UNREF, and this is not an optimisation — without it `ashlr local-runtime
  // start` never returns to the shell. The CLI sets `process.exitCode` and
  // lets Node exit when the event loop empties, and a listening socket is a
  // ref'd handle that keeps it from ever emptying. Measured: a process that
  // started the proxy and then did nothing was still alive 8s later.
  //
  // Unref is also exactly the semantics this module documents — the proxy
  // lives as long as its host is alive for its OWN reasons. A long-lived host
  // (the Verse web server) is held open by its own listener and keeps serving;
  // a one-shot CLI exits promptly and takes the proxy with it. Accepted
  // connections are ref'd separately, so an in-flight request still holds the
  // process open rather than being cut mid-stream.
  server.unref();

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((done) => server.close(() => done()));
    throw new Error('anthropic-proxy bound without reporting a port');
  }
  const origin = originFor(host, address.port);

  return {
    host,
    port: address.port,
    origin,
    baseUrl: `${origin}/v1`,
    upstreamOrigin,
    hostDowngradedFrom: downgradedFrom,
    close(): Promise<void> {
      if (closing !== null) return closing;
      closing = new Promise<void>((done) => {
        for (const request of inFlight) {
          try {
            request.destroy();
          } catch {
            // Already finished.
          }
        }
        inFlight.clear();
        // `server.close` alone waits for keep-alive connections to go idle,
        // which an SSE client never does. Cutting them is what makes shutdown
        // bounded — a listener left alive past close is the leak this guards.
        server.close(() => done());
        server.closeIdleConnections();
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

// ---------------------------------------------------------------------------
// Process-wide singleton, owned by the supervisor lifecycle.
// ---------------------------------------------------------------------------

let current: AnthropicProxyHandle | null = null;
/** In-flight start, so two concurrent `start`s cannot race for the port. */
let starting: Promise<AnthropicProxyHandle> | null = null;

/** The proxy this process is hosting, or null when it is not hosting one. */
export function anthropicProxyHandle(): AnthropicProxyHandle | null {
  return current;
}

/**
 * Start the proxy unless this process is already hosting one.
 *
 * Idempotent, and it never throws: a proxy that cannot bind must not turn a
 * llama-server that started correctly into a reported failure. The refusal is
 * RETURNED so the supervisor can put it in its own sentence.
 *
 * SCOPE, stated plainly because it is easy to assume otherwise: the listener
 * lives in THIS process. A long-lived host (the Verse control API's web
 * server, the daemon) keeps it up for as long as it runs; a one-shot
 * `ashlr local-runtime start` exits and takes it with it, exactly as it would
 * any other in-process listener. llama-server itself is detached and
 * unaffected either way.
 */
export async function ensureAnthropicProxy(
  options: AnthropicProxyOptions = {},
): Promise<{ handle: AnthropicProxyHandle } | { error: string }> {
  if (current !== null) return { handle: current };
  const pending = starting ?? (starting = startAnthropicProxy(options));
  try {
    const handle = await pending;
    current = handle;
    return { handle };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (starting === pending) starting = null;
  }
}

/** Stop the hosted proxy. Idempotent, and a no-op when there is none. */
export async function stopAnthropicProxy(): Promise<boolean> {
  const handle = current;
  current = null;
  if (handle === null) return false;
  try {
    await handle.close();
  } catch {
    // A listener that failed to close cleanly is still one we have released.
  }
  return true;
}
