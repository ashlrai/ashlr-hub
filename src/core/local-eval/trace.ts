/**
 * Watching the wire, so a trial that produces no result JSON is still legible.
 *
 * WHY THIS EXISTS. The agent CLI emits its result JSON once, at the end. A
 * trial killed at the wall-clock budget therefore records zero tokens, zero
 * turns and an empty transcript — the harness could say a trial hung, and
 * nothing whatsoever about WHERE. That is the same shape of useless outcome as
 * the false-success problem this harness was built to catch: a verdict nobody
 * can act on.
 *
 * The fix is to stop relying on the end of the run for evidence. This module
 * inserts a proxy between the agent and whatever it was pointed at, and records
 * every request, every byte of every response, and — the fact that turns out to
 * matter — whether a stream ever reached its terminator.
 *
 * A PURE OBSERVER. It forwards bytes, headers and status untouched and adds no
 * timeout of its own. It is deliberately NOT the normalising shim: it composes
 * in front of whatever base URL the run already uses, so switching tracing on
 * cannot change what the model is asked or what the agent receives. An
 * instrument that alters the thing it measures is worse than no instrument.
 *
 * NO ASSUMPTIONS ABOUT BLAME. `diagnoseTimeout` reports what the wire showed
 * and nothing more: a stream still delivering tokens when the clock ran out is
 * reported as exactly that, not as "the model is too slow".
 */

import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { StreamRecord, TimeoutDiagnosis, TrialTrace } from './types.js';

/** A stream that had not finished when the trace was read. */
interface LiveStream {
  readonly seq: number;
  readonly url: string;
  readonly startedAt: number;
  firstByteAt: number | null;
  lastByteAt: number | null;
  bytes: number;
  status: number | null;
  readonly events: Map<string, number>;
  /**
   * The raw capture, as a stream rather than repeated appends.
   *
   * `appendFile` per chunk has no ordering guarantee between concurrent calls,
   * so a busy stream could be written to disk out of order — and a scrambled
   * capture is worse than none, because it reads as evidence.
   */
  capture: WriteStream | null;
}

export interface TraceHandle {
  /** Base URL to hand the agent. Points at this proxy. */
  readonly baseUrl: string;
  /** Read the trace so far. Safe to call while streams are still open. */
  snapshot(): TrialTrace;
  /** Stop listening and drop every in-flight connection. */
  close(): Promise<void>;
}

export interface StartTraceOptions {
  /** Where to forward to — the shim, or llama-server itself. */
  readonly upstream: string;
  /**
   * Directory for the raw capture. Request bodies and response streams are
   * written verbatim, because the summary is a lead and the bytes are the
   * evidence.
   */
  readonly captureDir: string;
  /**
   * A stream that has produced nothing for this long is reported as stalled
   * rather than slow. Generous on purpose: this machine has been seen to take
   * tens of seconds between a prompt and its first token, and calling that a
   * stall would manufacture a bug.
   */
  readonly stallMs?: number;
}

const DEFAULT_STALL_MS = 120_000;

/** Records SSE event names out of a byte stream, tolerating split chunks. */
class EventCounter {
  private tail = '';
  constructor(private readonly counts: Map<string, number>) {}
  push(chunk: Buffer): void {
    this.tail += chunk.toString('utf8');
    for (;;) {
      const nl = this.tail.indexOf('\n');
      if (nl < 0) break;
      const line = this.tail.slice(0, nl);
      this.tail = this.tail.slice(nl + 1);
      const match = /^event:\s*(\S+)/.exec(line);
      if (match?.[1]) this.counts.set(match[1], (this.counts.get(match[1]) ?? 0) + 1);
    }
    // A pathological single line must not grow without bound.
    if (this.tail.length > 64_000) this.tail = this.tail.slice(-1_000);
  }
}

/**
 * Start a tracing proxy in front of `upstream`.
 *
 * Binds an ephemeral port, so any number of trials can trace at once without
 * agreeing on port numbers — which matters because the harness runs trials
 * concurrently by default.
 */
export async function startTrace(opts: StartTraceOptions): Promise<TraceHandle> {
  const upstream = new URL(opts.upstream);
  const stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
  await mkdir(opts.captureDir, { recursive: true });
  const journal = join(opts.captureDir, 'wire.jsonl');

  const finished: StreamRecord[] = [];
  const live = new Map<number, LiveStream>();
  const sockets = new Set<import('node:net').Socket>();
  /** Writes still in flight. `close()` waits on them so the capture is whole. */
  const pending = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>): void => {
    const settled = p.catch(() => undefined);
    pending.add(settled);
    void settled.finally(() => pending.delete(settled));
  };
  let seq = 0;

  // One stream, not repeated appends: concurrent `appendFile` calls have no
  // ordering guarantee, and a journal whose lines interleave is not forensics.
  // Errors are swallowed — a write failure must never take down the run this is
  // only observing.
  const log = createWriteStream(journal, { flags: 'a' });
  log.on('error', () => undefined);
  const note = (entry: Record<string, unknown>): void => {
    log.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  };

  const settle = (state: LiveStream, how: StreamRecord['ended'], upstreamComplete: boolean): void => {
    if (!live.delete(state.seq)) return;
    const capture = state.capture;
    state.capture = null;
    if (capture) {
      track(new Promise<void>((resolve) => { capture.end(() => resolve()); }));
    }
    const record: StreamRecord = {
      seq: state.seq,
      url: state.url,
      status: state.status,
      ended: how,
      bytes: state.bytes,
      events: Object.fromEntries(state.events),
      sawTerminator: (state.events.get('message_stop') ?? 0) > 0,
      upstreamComplete,
      waitedForFirstByteMs: state.firstByteAt === null ? null : state.firstByteAt - state.startedAt,
      idleAtEndMs: state.lastByteAt === null ? null : Date.now() - state.lastByteAt,
      durationMs: Date.now() - state.startedAt,
    };
    finished.push(record);
    note({ kind: 'stream-end', ...record });
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const index = seq;
      seq += 1;
      const tag = String(index).padStart(4, '0');
      const body = Buffer.concat(chunks);
      const state: LiveStream = {
        seq: index, url: req.url ?? '', startedAt: Date.now(),
        firstByteAt: null, lastByteAt: null, bytes: 0, status: null, events: new Map(),
        capture: null,
      };
      live.set(index, state);

      if (body.length > 0) track(writeFile(join(opts.captureDir, `req-${tag}.json`), body));
      note({ kind: 'request', seq: index, method: req.method, url: req.url, bytes: body.length });

      const headers: Record<string, string | number> = { 'content-type': 'application/json' };
      if (typeof req.headers.accept === 'string') headers['accept'] = req.headers.accept;
      if (body.length > 0) headers['content-length'] = body.length;

      const forwarded = httpRequest({
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        path: req.url,
        method: req.method,
        headers,
      }, (up) => {
        state.status = up.statusCode ?? null;
        note({ kind: 'response-head', seq: index, status: up.statusCode,
               waitedMs: Date.now() - state.startedAt });
        res.writeHead(up.statusCode ?? 502, {
          'content-type': String(up.headers['content-type'] ?? 'application/json'),
        });
        const counter = new EventCounter(state.events);
        state.capture = createWriteStream(join(opts.captureDir, `res-${tag}.sse`));
        state.capture.on('error', () => undefined);
        up.on('data', (chunk: Buffer) => {
          const now = Date.now();
          if (state.firstByteAt === null) state.firstByteAt = now;
          state.lastByteAt = now;
          state.bytes += chunk.length;
          counter.push(chunk);
          state.capture?.write(chunk);
          res.write(chunk);
        });
        up.on('end', () => { settle(state, 'upstream-end', up.complete); res.end(); });
        up.on('aborted', () => { settle(state, 'upstream-aborted', false); res.destroy(); });
        up.on('error', (err) => {
          note({ kind: 'upstream-error', seq: index, error: String(err) });
          settle(state, 'upstream-error', false);
          res.destroy();
        });
      });

      forwarded.on('error', (err) => {
        note({ kind: 'connect-error', seq: index, error: String(err) });
        settle(state, 'upstream-error', false);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      });

      // The agent hanging up first is itself evidence — it is how a client-side
      // give-up is told apart from a server that stopped writing.
      res.on('close', () => {
        if (live.has(index)) {
          settle(state, 'client-closed', false);
          forwarded.destroy();
        }
      });

      if (body.length > 0) forwarded.end(body); else forwarded.end();
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    snapshot: () => buildTrace({ finished, live, stallMs, captureDir: opts.captureDir }),
    close: async () => {
      for (const state of [...live.values()]) settle(state, 'client-closed', false);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
      // The capture is the evidence, so it is flushed before the handle is
      // considered closed — a caller that reads it next must find it whole.
      await Promise.allSettled([...pending]);
      await new Promise<void>((resolve) => log.end(() => resolve()));
    },
  };
}

function buildTrace(args: {
  finished: readonly StreamRecord[];
  live: ReadonlyMap<number, LiveStream>;
  stallMs: number;
  captureDir: string;
}): TrialTrace {
  const now = Date.now();
  const openStreams = [...args.live.values()].map((s) => ({
    seq: s.seq,
    url: s.url,
    status: s.status,
    bytes: s.bytes,
    events: Object.fromEntries(s.events),
    openForMs: now - s.startedAt,
    sinceLastByteMs: s.lastByteAt === null ? null : now - s.lastByteAt,
    waitedForFirstByteMs: s.firstByteAt === null ? null : s.firstByteAt - s.startedAt,
  }));
  return {
    captureDir: args.captureDir,
    requests: args.finished.length + openStreams.length,
    streams: args.finished,
    openStreams,
    stallMs: args.stallMs,
  };
}

/**
 * Name what the wire was doing when the clock ran out.
 *
 * READ IN ORDER. The first cause that fits wins, because these are not
 * independent: a stream still open explains everything downstream of it, and
 * reporting a stale earlier stream instead would point at the wrong thing.
 */
export function diagnoseTimeout(trace: TrialTrace): TimeoutDiagnosis {
  const stalled = trace.openStreams.filter(
    (s) => s.sinceLastByteMs === null || s.sinceLastByteMs >= trace.stallMs);
  const flowing = trace.openStreams.filter(
    (s) => s.sinceLastByteMs !== null && s.sinceLastByteMs < trace.stallMs);

  if (flowing.length > 0) {
    const worst = flowing.reduce((a, b) => (a.openForMs >= b.openForMs ? a : b));
    return {
      kind: 'generating-at-cutoff',
      detail: `request #${worst.seq} was still streaming when the budget expired: `
        + `${Math.round(worst.openForMs / 1000)}s open, ${worst.bytes} bytes, `
        + `last token ${Math.round((worst.sinceLastByteMs ?? 0) / 1000)}s before the kill`,
      seq: worst.seq,
    };
  }

  if (stalled.length > 0) {
    const worst = stalled.reduce((a, b) => (a.openForMs >= b.openForMs ? a : b));
    const never = worst.sinceLastByteMs === null;
    return {
      kind: never ? 'no-first-token' : 'stream-stalled',
      detail: never
        ? `request #${worst.seq} was accepted${worst.status === null ? ' but never answered' : ` with status ${worst.status}`} `
          + `and produced no bytes in ${Math.round(worst.openForMs / 1000)}s`
        : `request #${worst.seq} stopped producing bytes `
          + `${Math.round((worst.sinceLastByteMs ?? 0) / 1000)}s before the kill and was never closed `
          + `(${worst.bytes} bytes, events ${JSON.stringify(worst.events)})`,
      seq: worst.seq,
    };
  }

  // Only completion streams are evidence. The CLI also issues a connectivity
  // probe and a token count against the same base URL, and both close without
  // a `message_stop` because neither is an SSE turn. Counting those would
  // report a missing terminator on every single timeout — a diagnosis that
  // fires always is worth exactly as much as no diagnosis at all.
  const turns = trace.streams.filter((s) => (s.events['message_start'] ?? 0) > 0);
  const last = turns[turns.length - 1];
  if (!last) {
    return {
      kind: 'no-request-reached-the-model',
      detail: `the agent never sent a completion request (${trace.requests} non-streaming request(s) seen) `
        + '— the hang is on the client side of the proxy',
      seq: null,
    };
  }
  if (!last.sawTerminator) {
    return {
      kind: 'stream-ended-without-terminator',
      detail: `request #${last.seq} closed (${last.ended}) after ${last.bytes} bytes without a message_stop; `
        + 'the agent was left waiting on a turn the server considered finished',
      seq: last.seq,
    };
  }
  return {
    kind: 'idle-between-turns',
    detail: `every request completed — ${turns.length} turn(s), the last one terminated cleanly `
      + `${Math.round(last.durationMs / 1000)}s long — and the agent then stopped without sending another`,
    seq: last.seq,
  };
}
