/**
 * M11: streaming.ts — StreamSink type + nullSink / makeCliSink factories.
 *
 * A StreamSink receives live RunStreamEvents from the agent loop and renders
 * them to the terminal. The sink contract:
 *   - NEVER throws to the caller (all errors caught internally).
 *   - NEVER prints secret values (events carry metadata/text only).
 *   - model-delta events render incrementally (process.stdout/stderr.write,
 *     no trailing newline) so the token stream looks live.
 *   - Lifecycle events (task-start, task-done, retry, verify, tool-call, log)
 *     render as full labeled lines with glyphs + color.
 *   - When opts.json === true the human stream goes to STDERR so stdout stays
 *     clean machine JSON.
 *
 * v333: fileSink() — a DURABLE sink. Everything above renders live to a
 * terminal and then is gone; nothing persisted the actual text anywhere
 * (src/core/web/run-stream.ts's header comment traces this gap in detail —
 * RunStep.summary was the finest real, disk-persisted signal, one entry per
 * step boundary, not per model token / engine stdout line). fileSink closes
 * that gap: it appends every event's scrubbed text to a private, size-capped,
 * append-only JSONL file under ~/.ashlr/run-streams/<runId>.log, so the
 * per-run SSE route can tail it and interleave real output with step
 * boundaries. See combineSinks() for how this composes with a caller's own
 * sink (CLI terminal rendering, or nullSink for daemon/web-launched runs)
 * rather than replacing it.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunStreamEvent } from '../types.js';
import { makeColors } from '../../cli/ui.js';
import { scrubSecrets } from '../util/scrub.js';

/**
 * A sink that receives live run events. Lifecycle methods are optional so
 * existing render-only sinks remain simple callables, while buffered sinks can
 * safely drain withheld text on every terminal path. No method may throw.
 */
export interface StreamSink {
  (e: RunStreamEvent): void;
  flush?: () => void;
  end?: () => void;
  error?: (error?: unknown) => void;
}

/** A no-op sink — used when streaming is disabled or in unit tests. */
export function nullSink(): StreamSink {
  return (_e: RunStreamEvent) => { /* intentional no-op */ };
}

/**
 * Emit a RunStreamEvent to a sink, stamping `ts`. Never throws — mirrors the
 * private `emit()` helper in orchestrator.ts for callers (engines.ts /
 * sandboxed-engine.ts consumers) that don't have their own local copy.
 */
export function emitSinkEvent(sink: StreamSink, event: Omit<RunStreamEvent, 'ts'>): void {
  try {
    sink({ ...event, ts: new Date().toISOString() });
  } catch {
    // Sinks must never crash the caller.
  }
}

/**
 * Release only output that a buffered sink has already classified as safe,
 * without closing it. An undecidable look-behind remains buffered so a flush
 * cannot turn one split secret into two independently harmless-looking writes.
 * Never throws.
 */
export function flushStreamSink(sink: StreamSink): void {
  try { sink.flush?.(); } catch { /* sinks never disrupt a run */ }
}

/** Drain buffered output and close the sink. Never throws. */
export function endStreamSink(sink: StreamSink): void {
  try {
    if (sink.end) sink.end();
    else sink.flush?.();
  } catch { /* sinks never disrupt a run */ }
}

/** Drain buffered output on an exceptional terminal path. Never throws. */
export function failStreamSink(sink: StreamSink, error?: unknown): void {
  try {
    if (sink.error) sink.error(error);
    else if (sink.end) sink.end();
    else sink.flush?.();
  } catch { /* sinks never disrupt a run */ }
}

/**
 * Fan an event out to every sink in `sinks`. Each sink is invoked
 * independently inside its own try/catch (nullSink and makeCliSink already
 * never throw, but fileSink writes to disk — one sink's I/O failure must
 * never suppress delivery to the others, e.g. a full disk must not silence
 * the live CLI terminal stream).
 */
export function combineSinks(...sinks: StreamSink[]): StreamSink {
  const live = sinks.filter((s): s is StreamSink => typeof s === 'function');
  if (live.length === 0) return nullSink();
  if (live.length === 1) return live[0]!;
  const combined = ((e: RunStreamEvent): void => {
    for (const s of live) {
      try {
        s(e);
      } catch {
        // One sink's failure must never suppress delivery to the others.
      }
    }
  }) as StreamSink;
  combined.flush = () => { for (const sink of live) flushStreamSink(sink); };
  combined.end = () => { for (const sink of live) endStreamSink(sink); };
  combined.error = (error?: unknown) => { for (const sink of live) failStreamSink(sink, error); };
  return combined;
}

// ---------------------------------------------------------------------------
// v333: fileSink — durable, scrubbed, size-capped per-run output persistence
// ---------------------------------------------------------------------------

/** Mirrors orchestrator.ts's runsDir()/runFilePath() conventions exactly:
 * re-resolved at call time (tests relocate HOME), same id grammar, sibling
 * directory to ~/.ashlr/runs/. */
function runStreamsDirRoot(): string {
  return path.join(os.homedir(), '.ashlr');
}

export function runStreamsDir(): string {
  return path.join(runStreamsDirRoot(), 'run-streams');
}

/** Same grammar as orchestrator.ts's runFilePath() / run-stream.ts's
 * RUN_ID_RE — alphanumeric, hyphen, underscore, dot only; no traversal. */
const STREAM_RUN_ID_RE = /^[\w.-]{1,200}$/;

/** 8MB: within the brief's 5-10MB band. Observability, not a ledger — a
 * generous but bounded ceiling per run. */
export const MAX_STREAM_FILE_BYTES = 8 * 1024 * 1024;

/** Ephemeral observability, not evidence: much shorter than agent-
 * diagnostics.ts's 30-day metadata TTL (agent-diagnostics.ts:34). */
export const STREAM_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/** Written once per file, the moment the size cap is hit; every event after
 * is silently dropped for that runId (never grows past the cap). Exported so
 * the SSE route / tests can recognize it. */
export const STREAM_TRUNCATION_MARKER = '[ashlr] output stream truncated — size cap reached; further output dropped';

/**
 * Maximum raw suffix withheld from disk while waiting for a secret pattern to
 * become decidable across model-token boundaries. The current scrubber's
 * longest minimum recognizable prefix is well below this bound; keeping the
 * window small limits normal streaming latency while preventing per-chunk
 * regex bypasses.
 */
export const STREAM_REDACTION_WINDOW_CHARS = 256;

/** One JSONL record per persisted chunk. `text` has already been scrubbed. */
export interface StoredStreamChunk {
  ts: string;
  kind: RunStreamEvent['kind'];
  taskId?: string;
  text: string;
}

export function runStreamFilePath(runId: string): string | undefined {
  if (!STREAM_RUN_ID_RE.test(runId)) return undefined;
  return path.join(runStreamsDir(), `${runId}.log`);
}

/** Cache "directory verified" so a hot per-chunk path (a model-delta token,
 * an engine stdout line) doesn't pay 4+ syscalls EVERY call — only once per
 * process, rechecked periodically in case the directory was removed out from
 * under a long-lived daemon process. Keyed on the RESOLVED path, not just a
 * boolean: HOME can change within a process (every test in this codebase's
 * suite does exactly this), and a stale cache must never mask a directory
 * that needs creating under a NEW home. */
let dirEnsuredPath: string | undefined;
let dirEnsuredAt = 0;
const DIR_RECHECK_MS = 60_000;

function ensureRunStreamsDir(): boolean {
  const now = Date.now();
  const dir = runStreamsDir();
  if (dirEnsuredPath === dir && now - dirEnsuredAt < DIR_RECHECK_MS) return true;
  const ok = ensureRunStreamsDirUncached();
  if (ok) {
    dirEnsuredPath = dir;
    dirEnsuredAt = now;
  } else {
    dirEnsuredPath = undefined;
  }
  return ok;
}

function ensureRunStreamsDirUncached(): boolean {
  try {
    const root = runStreamsDirRoot();
    const dir = runStreamsDir();
    for (const candidate of [root, dir]) {
      if (!fs.existsSync(candidate)) fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      fs.chmodSync(candidate, 0o700);
    }
    return true;
  } catch {
    return false;
  }
}

/** Per-file (not per-runId) write cursor, kept in-process to avoid an fstat
 * cost on every single chunk. Lost on process restart — reseeded lazily
 * below from the file's actual on-disk size, so a daemon restart mid-run
 * still respects the cap instead of resetting it. Keyed on the RESOLVED
 * path rather than the bare runId: HOME can change within a process (every
 * test in this codebase's suite does exactly this), and two different
 * homes can legitimately reuse the same runId string — keying on path
 * means a stale cache entry can never be read back for the wrong file. */
interface StreamWriteState {
  bytes: number;
  truncated: boolean;
  seeded: boolean;
}
const writeState = new Map<string, StreamWriteState>();

/** Keyed on the RESOLVED run-streams directory, not a bare boolean/timestamp
 *  — same reasoning as dirEnsuredPath above and writeState's per-path keys:
 *  HOME can change within a process (every test in this suite does exactly
 *  this), and a stale throttle from a PREVIOUS home must never suppress a
 *  genuinely due sweep under a NEW home. A bare `let lastGcAt` would let one
 *  process's forced/natural GC on home A silently skip GC on home B for up
 *  to GC_INTERVAL_MS after a HOME swap. */
let lastGcAtDir: string | undefined;
let lastGcAt = 0;
const GC_INTERVAL_MS = 10 * 60 * 1_000;

/**
 * Best-effort retention sweep: deletes run-stream files whose mtime is older
 * than STREAM_RETENTION_MS. Mirrors agent-diagnostics.ts's opportunistic-on-
 * write GC (maintainPrivateStore), deliberately without its multi-process
 * locking — this data is disposable observability, not an audit trail, so a
 * best-effort single-process sweep is enough. Throttled to at most once per
 * GC_INTERVAL_MS per process (per resolved directory — see lastGcAtDir) so
 * normal chunk writes stay cheap.
 */
export function gcRunStreams(force = false): void {
  const now = Date.now();
  const dirForThrottle = runStreamsDir();
  if (!force && lastGcAtDir === dirForThrottle && now - lastGcAt < GC_INTERVAL_MS) return;
  lastGcAtDir = dirForThrottle;
  lastGcAt = now;
  try {
    const dir = dirForThrottle;
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.log')) continue;
      const filePath = path.join(dir, name);
      try {
        const stat = fs.lstatSync(filePath);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        if (now - stat.mtimeMs > STREAM_RETENTION_MS) {
          fs.unlinkSync(filePath);
          writeState.delete(filePath);
        }
      } catch {
        // Best-effort; one bad entry must never abort the sweep.
      }
    }
  } catch {
    // Best-effort; retention is not load-bearing for correctness.
  }
}

function seedWriteState(filePath: string): StreamWriteState {
  let state = writeState.get(filePath);
  if (state) return state;
  let bytes = 0;
  try {
    bytes = fs.statSync(filePath).size;
  } catch {
    bytes = 0;
  }
  state = { bytes, truncated: bytes >= MAX_STREAM_FILE_BYTES, seeded: true };
  writeState.set(filePath, state);
  return state;
}

function appendStreamLine(filePath: string, line: string): boolean {
  let fd: number | undefined;
  try {
    if (fs.existsSync(filePath)) {
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) return false;
    }
    fd = fs.openSync(filePath, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeSync(fd, line, undefined, 'utf8');
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best-effort */ }
    }
  }
}

/**
 * Build a StreamSink that appends this run's live output to a durable,
 * scrubbed, size-capped JSONL file — `~/.ashlr/run-streams/<runId>.log`
 * (dir 0700, file 0600). Every event's text passes through scrubSecrets()
 * BEFORE it touches disk: engine stdout can echo env vars / tokens, and a
 * scrubbed-at-rest file is the only acceptable design for something the SSE
 * route later serves back over HTTP.
 *
 * Cheap when idle (no timers, no fd kept open across calls). A small bounded
 * raw suffix stays in memory so secret patterns split across event/token
 * boundaries are classified before any constituent bytes reach disk. A
 * nonterminal flush releases only already-classified safe prefixes; end/error
 * finalize the undecidable suffix. Once a secret introducer or complete match
 * is observed, the sink fails closed for the rest of the run: it persists one
 * redaction marker and drops subsequent text. This deliberately trades the
 * remainder of a secret-bearing diagnostic stream for the guarantee that an
 * arbitrarily long value cannot leak after its identifying prefix was removed.
 * Skips events with no meaningful text. Never throws.
 */
export function fileSink(runId: string): StreamSink {
  const filePath = runStreamFilePath(runId);
  if (!filePath) return nullSink();

  interface PendingChunk {
    event: RunStreamEvent;
    text: string;
  }

  const pending: PendingChunk[] = [];
  let pendingChars = 0;
  let ended = false;
  let redactionLocked = false;

  const writeRecord = (event: RunStreamEvent, text: string): boolean => {
    try {
      if (text.length === 0) return false;

      gcRunStreams();
      if (!ensureRunStreamsDir()) return false;

      const state = seedWriteState(filePath);
      if (state.truncated) return false;

      const record: StoredStreamChunk = {
        ts: event.ts,
        kind: event.kind,
        ...(event.taskId ? { taskId: event.taskId } : {}),
        text,
      };
      const line = `${JSON.stringify(record)}\n`;
      const lineBytes = Buffer.byteLength(line, 'utf8');

      if (state.bytes + lineBytes > MAX_STREAM_FILE_BYTES) {
        state.truncated = true;
        const marker: StoredStreamChunk = { ts: event.ts, kind: 'log', text: STREAM_TRUNCATION_MARKER };
        const markerLine = `${JSON.stringify(marker)}\n`;
        if (appendStreamLine(filePath, markerLine)) {
          state.bytes += Buffer.byteLength(markerLine, 'utf8');
        }
        return false;
      }

      if (appendStreamLine(filePath, line)) {
        state.bytes += lineBytes;
        return true;
      }
      return false;
    } catch {
      return false;
    }
  };

  const pendingText = (): string => pending.map((chunk) => chunk.text).join('');

  /**
   * Recognize a secret-bearing construct as soon as its identifying prefix is
   * available. Some canonical scrubber patterns (URL credentials, key=value,
   * PEM blocks) have unbounded values, so waiting for a complete regex match
   * before releasing a fixed-size prefix would eventually cut the introducer
   * away from its tail. False positives are intentionally fail-closed because
   * this is a private observability stream, not the operator's live UI.
   */
  const containsSecretIntroducer = (text: string): boolean => {
    try {
      return /-----BEGIN[ A-Z-]*$/i.test(text) ||
        /-----BEGIN[ A-Z]*PRIVATE KEY-----/i.test(text) ||
        /\bsk-/i.test(text) ||
        /\bgh[poursa]_/i.test(text) ||
        /\bgithub_pat_/i.test(text) ||
        /\b(?:Bearer|Token|Authorization)\s+/i.test(text) ||
        /\b(?:api[_-]?key|api[_-]?token|secret|secret[_-]?key|token|password|passwd|pwd|auth|credential|client[_-]?secret|private[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|connection[_-]?string|conn[_-]?str|_?auth[_-]?token|ASHLR_[A-Z_]+)(?:\s*[=:]|\s*$)/i.test(text) ||
        /\bxox[baprs]-/i.test(text) ||
        /\bAKIA[0-9A-Z]*/.test(text) ||
        /\beyJ[A-Za-z0-9_-]*\./.test(text) ||
        /\b(?:glpat-|hf_|npm_|AIza)/i.test(text) ||
        /:\/\/[^:\s/@]+:/.test(text) ||
        // Bound otherwise-unbounded URL userinfo candidates before their
        // credential-separating colon arrives. Ordinary hostnames stay live;
        // implausibly long authority tokens fail closed.
        /:\/\/[^/\s@]{128,}$/.test(text);
    } catch {
      return true;
    }
  };

  const clearPending = (): void => {
    pending.length = 0;
    pendingChars = 0;
  };

  const pendingIsSensitive = (raw: string): boolean =>
    containsSecretIntroducer(raw) || scrubSecrets(raw) !== raw;

  const lockRedacted = (): void => {
    const first = pending[0];
    if (first) writeRecord(first.event, '[REDACTED]');
    clearPending();
    redactionLocked = true;
  };

  const dropPrefix = (count: number): void => {
    let remaining = Math.max(0, count);
    while (remaining > 0 && pending.length > 0) {
      const first = pending[0]!;
      if (first.text.length <= remaining) {
        remaining -= first.text.length;
        pendingChars -= first.text.length;
        pending.shift();
      } else {
        first.text = first.text.slice(remaining);
        pendingChars -= remaining;
        remaining = 0;
      }
    }
  };

  const writeRawPrefix = (count: number): void => {
    let remaining = Math.max(0, count);
    while (remaining > 0 && pending.length > 0) {
      const first = pending[0]!;
      const take = Math.min(first.text.length, remaining);
      const text = first.text.slice(0, take);
      // Defense in depth: the combined pending text was already classified,
      // but every actual disk write still traverses the canonical scrubber.
      writeRecord(first.event, scrubSecrets(text));
      dropPrefix(take);
      remaining -= take;
    }
  };

  const drainBoundedPrefix = (): void => {
    if (pendingChars === 0) return;
    const raw = pendingText();
    if (pendingIsSensitive(raw)) {
      // Never retain a raw suffix from a matched region: doing so severs the
      // identifying prefix and makes a later flush see only harmless-looking
      // secret tail bytes. Clear the entire pending region and suppress all
      // continuation, which is bounded regardless of value length.
      lockRedacted();
      return;
    }
    if (pendingChars <= STREAM_REDACTION_WINDOW_CHARS) return;
    const count = pendingChars - STREAM_REDACTION_WINDOW_CHARS;
    writeRawPrefix(count);
  };

  const finalizePending = (): void => {
    if (pendingChars === 0) return;
    const raw = pendingText();
    if (pendingIsSensitive(raw)) lockRedacted();
    else writeRawPrefix(pendingChars);
  };

  const sink = ((e: RunStreamEvent): void => {
    try {
      if (ended) return;
      const text = typeof e.text === 'string' ? e.text : '';
      if (text.length === 0) return;
      if (redactionLocked) return;

      pending.push({ event: e, text });
      pendingChars += text.length;
      drainBoundedPrefix();
    } catch {
      // StreamSink contract: never throw to the caller.
    }
  }) as StreamSink;

  sink.flush = () => {
    try {
      // Deliberately retain the final undecidable window. `flush` is
      // nonterminal and must not erase cross-chunk redaction state.
      if (!ended && !redactionLocked) drainBoundedPrefix();
    } catch { /* never throw */ }
  };
  sink.end = () => {
    try {
      if (!ended && !redactionLocked) finalizePending();
    } catch { /* never throw */ }
    ended = true;
  };
  sink.error = () => {
    try {
      if (!ended && !redactionLocked) finalizePending();
    } catch { /* never throw */ }
    ended = true;
  };
  return sink;
}

/**
 * Build a CLI sink that renders a live, readable stream.
 *
 * - opts.json === true  → human lines go to STDERR (stdout stays clean JSON).
 * - opts.json === false → lines go to STDERR when isTTY, else STDOUT.
 *
 * model-delta events are written inline (no newline) so the token stream looks
 * continuous. All other event kinds start on their own labeled line.
 */
export function makeCliSink(opts: { json: boolean }): StreamSink {
  // Choose the output stream: always STDERR when json mode so stdout is clean.
  const out = opts.json ? process.stderr : process.stderr;
  const isTty = out.isTTY === true;
  const col = makeColors(isTty);

  // Track whether we're mid-line on a model-delta run (so we know when to
  // emit a leading newline before a lifecycle label).
  let midDelta = false;

  function write(s: string): void {
    try { out.write(s); } catch { /* never throw */ }
  }

  function writeln(s: string): void {
    // If we were streaming model deltas inline, break to a new line first.
    if (midDelta) {
      write('\n');
      midDelta = false;
    }
    write(s + '\n');
  }

  function taskTag(taskId: string | undefined): string {
    return taskId ? col.gray(`[${taskId}] `) : '';
  }

  return function sink(e: RunStreamEvent): void {
    try {
      switch (e.kind) {
        case 'task-start': {
          const tag = taskTag(e.taskId);
          writeln(`${col.cyan('▶')} ${tag}${col.bold(e.text ?? 'task starting')}`);
          break;
        }

        case 'model-delta': {
          // Inline write — no newline. May be empty string; skip.
          const chunk = e.text ?? '';
          if (chunk.length > 0) {
            write(chunk);
            midDelta = true;
          }
          break;
        }

        case 'tool-call': {
          const tag = taskTag(e.taskId);
          const name = e.text ?? (typeof e.data === 'object' && e.data !== null
            ? String((e.data as Record<string, unknown>)['name'] ?? 'tool')
            : 'tool');
          writeln(`${col.magenta('⚙')} ${tag}${col.dim('tool:')} ${col.magenta(name)}`);
          break;
        }

        case 'task-done': {
          const tag = taskTag(e.taskId);
          writeln(`${col.green('✓')} ${tag}${col.bold(e.text ?? 'done')}`);
          break;
        }

        case 'retry': {
          const tag = taskTag(e.taskId);
          writeln(`${col.yellow('↺')} ${tag}${col.yellow(e.text ?? 'retrying')}`);
          break;
        }

        case 'verify': {
          const tag = taskTag(e.taskId);
          // data may be a VerifyVerdict: { ok, reason, method }
          const verdict = (typeof e.data === 'object' && e.data !== null)
            ? e.data as { ok?: boolean; reason?: string; method?: string }
            : null;
          const ok = verdict?.ok ?? true;
          const reason = verdict?.reason ?? e.text ?? '';
          const method = verdict?.method ? col.dim(` (${verdict.method})`) : '';
          if (ok) {
            writeln(`${col.green('✔')} ${tag}${col.green('verify ok')}${method}${reason ? ': ' + reason : ''}`);
          } else {
            writeln(`${col.yellow('✘')} ${tag}${col.yellow('verify fail')}${method}${reason ? ': ' + reason : ''}`);
          }
          break;
        }

        case 'log': {
          const tag = taskTag(e.taskId);
          writeln(`${col.gray('·')} ${tag}${col.dim(e.text ?? '')}`);
          break;
        }

        default: {
          // Unknown future event kinds: silently ignore to stay forward-compatible.
          break;
        }
      }
    } catch {
      // Contract: never throw to caller regardless of render errors.
    }
  };
}
