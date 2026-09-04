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
import type { AshlrConfig, RunStreamEvent } from '../types.js';
import { makeColors } from '../../cli/ui.js';
import { scrubSecrets } from '../util/scrub.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import {
  acquireLocalStoreLock,
  releaseLocalStoreLock,
  type LocalStoreLock,
} from '../fleet/local-store-lock.js';

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

/** Store-wide bounds prevent many individually-small captures from growing
 * the private observability directory without limit. Oldest files are pruned
 * first whenever either bound is exceeded. */
export const MAX_STREAM_FILES = 256;
export const MAX_STREAM_AGGREGATE_BYTES = 256 * 1024 * 1024;

/** Bound every reader allocation independently of the file-size cap. */
export const MAX_STREAM_READ_BYTES = 256 * 1024;

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

const runOutputStreamClaimBrand = Symbol('ashlr.run-output-stream-claim');

/**
 * In-process, non-serializable authority over one exclusively-created output
 * stream inode. Best-of-N uses this to couple a deterministic candidate id to
 * a fresh stream before any provider dispatch; a caller cannot accidentally
 * adopt an orphan/collided pathname merely by knowing the run id.
 */
export interface RunOutputStreamClaim {
  readonly runId: string;
  readonly filePath: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly [runOutputStreamClaimBrand]: true;
}

const activeRunOutputStreamClaims = new WeakSet<RunOutputStreamClaim>();
const runOutputStreamClaimLocks = new WeakMap<RunOutputStreamClaim, LocalStoreLock>();
const windowsStreamFileAssurance = new Map<string, { dev: bigint; ino: bigint; at: number }>();

function runOutputStreamLockPath(filePath: string): string {
  return `${filePath}.active.lock`;
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
let dirEnsuredRootIdentity: { dev: bigint; ino: bigint } | undefined;
let dirEnsuredIdentity: { dev: bigint; ino: bigint } | undefined;
const DIR_RECHECK_MS = 60_000;

function ensureRunStreamsDir(): boolean {
  const now = Date.now();
  const dir = runStreamsDir();
  if (dirEnsuredPath === dir && now - dirEnsuredAt < DIR_RECHECK_MS &&
    dirEnsuredRootIdentity && dirEnsuredIdentity) {
    try {
      const root = fs.lstatSync(runStreamsDirRoot(), { bigint: true });
      const current = fs.lstatSync(dir, { bigint: true });
      if (safePrivateStreamDirectory(root) && safePrivateStreamDirectory(current) &&
        root.dev === dirEnsuredRootIdentity.dev && root.ino === dirEnsuredRootIdentity.ino &&
        current.dev === dirEnsuredIdentity.dev && current.ino === dirEnsuredIdentity.ino) return true;
    } catch {
      // Fall through to full assurance.
    }
  }
  const ok = ensureRunStreamsDirUncached();
  if (ok) {
    try {
      const root = fs.lstatSync(runStreamsDirRoot(), { bigint: true });
      const current = fs.lstatSync(dir, { bigint: true });
      dirEnsuredPath = dir;
      dirEnsuredAt = now;
      dirEnsuredRootIdentity = { dev: root.dev, ino: root.ino };
      dirEnsuredIdentity = { dev: current.dev, ino: current.ino };
    } catch {
      dirEnsuredPath = undefined;
      dirEnsuredRootIdentity = undefined;
      dirEnsuredIdentity = undefined;
      return false;
    }
  } else {
    dirEnsuredPath = undefined;
    dirEnsuredRootIdentity = undefined;
    dirEnsuredIdentity = undefined;
  }
  return ok;
}

function ensureRunStreamsDirUncached(): boolean {
  try {
    const root = runStreamsDirRoot();
    const dir = runStreamsDir();
    for (const [candidate, anchor] of [[root, os.homedir()], [dir, root]] as const) {
      let created = false;
      try {
        fs.mkdirSync(candidate, { mode: 0o700 });
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const initial = fs.lstatSync(candidate, { bigint: true });
      if (initial.isSymbolicLink() || !initial.isDirectory()) return false;
      // Windows chmod does not establish a protected DACL. Secure a fresh
      // directory exactly once; never rewrite a permissive pre-existing ACL.
      if (created || process.platform !== 'win32') fs.chmodSync(candidate, 0o700);
      const before = fs.lstatSync(candidate, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink() ||
        before.dev !== initial.dev || before.ino !== initial.ino) return false;
      if (!assurePrivateStoragePath(
        candidate,
        'directory',
        created ? 'secure-created' : 'inspect-existing',
        { anchorPath: anchor },
      ).ok) return false;
      const after = fs.lstatSync(candidate, { bigint: true });
      if (!after.isDirectory() || after.isSymbolicLink() ||
        after.dev !== before.dev || after.ino !== before.ino) return false;
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

let runStreamGcBeforeCapacityUnlinkHook: ((filePath: string) => void) | undefined;

/** Test-only mutation-boundary hook for deterministic GC/claim races. */
export function setRunStreamGcBeforeCapacityUnlinkHookForTests(
  hook?: (filePath: string) => void,
): void {
  if (process.env['NODE_ENV'] !== 'test' && process.env['VITEST'] !== 'true') {
    throw new Error('run stream GC hooks are test-only');
  }
  runStreamGcBeforeCapacityUnlinkHook = hook;
}

/**
 * Delete only while holding the exact activity lock a candidate must acquire
 * before O_EXCL stream creation. Path, parent, root, and inode are revalidated
 * under that lock so enumeration-time observations never authorize unlink.
 */
function pruneStreamFileUnderActivityLock(
  filePath: string,
  expectedFile: Pick<fs.BigIntStats, 'dev' | 'ino'>,
  expectedDirectory: Pick<fs.BigIntStats, 'dev' | 'ino'>,
  expectedRoot: Pick<fs.BigIntStats, 'dev' | 'ino'>,
): boolean {
  const pruneLock = acquireLocalStoreLock(runOutputStreamLockPath(filePath), 0, {
    anchorPath: runStreamsDirRoot(),
    exactPrivateStorage: true,
  });
  if (!pruneLock) return false;
  try {
    const current = fs.lstatSync(filePath, { bigint: true });
    const currentDir = fs.lstatSync(path.dirname(filePath), { bigint: true });
    const currentRoot = fs.lstatSync(path.dirname(path.dirname(filePath)), { bigint: true });
    if (!safePrivateStreamFile(current) ||
      !safePrivateStreamDirectory(currentDir) || !safePrivateStreamDirectory(currentRoot) ||
      !sameStreamFile(current, expectedFile) ||
      !sameStreamFile(currentDir, expectedDirectory) || !sameStreamFile(currentRoot, expectedRoot) ||
      current.dev !== currentDir.dev) return false;
    fs.unlinkSync(filePath);
    writeState.delete(filePath);
    windowsStreamFileAssurance.delete(filePath);
    return true;
  } catch {
    return false;
  } finally {
    releaseLocalStoreLock(pruneLock);
  }
}

/**
 * Best-effort retention sweep: deletes run-stream files whose mtime is older
 * than STREAM_RETENTION_MS. Candidate stream mutations coordinate through a
 * cross-process activity lock; no enumeration-time observation authorizes an
 * unlink. Throttled to at most once per GC_INTERVAL_MS per process (per
 * resolved directory — see lastGcAtDir) so normal chunk writes stay cheap.
 */
export function gcRunStreams(force = false, preserveRunId?: string): void {
  const now = Date.now();
  const dirForThrottle = runStreamsDir();
  if (!force && lastGcAtDir === dirForThrottle && now - lastGcAt < GC_INTERVAL_MS) return;
  lastGcAtDir = dirForThrottle;
  lastGcAt = now;
  try {
    const dir = dirForThrottle;
    if (!fs.existsSync(dir)) return;
    const root = runStreamsDirRoot();
    const rootStat = fs.lstatSync(root, { bigint: true });
    const dirStat = fs.lstatSync(dir, { bigint: true });
    if (!safePrivateStreamDirectory(rootStat) || !safePrivateStreamDirectory(dirStat)) return;
    const preservePath = preserveRunId ? runStreamFilePath(preserveRunId) : undefined;
    const retained: Array<{
      path: string;
      mtimeMs: number;
      size: number;
      dev: bigint;
      ino: bigint;
      protected: boolean;
    }> = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.log')) continue;
      const filePath = path.join(dir, name);
      let inspectionLock: LocalStoreLock | null = null;
      try {
        const protectedTarget = filePath === preservePath;
        // Ordinary streams have no activity lock; avoid creating/probing one
        // per file on every sweep. A candidate acquires its lock before the
        // corresponding stream exists, so an absent lock cannot race into an
        // active claim for this already-enumerated pathname (O_EXCL would
        // refuse that claimant while the file exists).
        if (!protectedTarget && fs.existsSync(runOutputStreamLockPath(filePath))) {
          inspectionLock = acquireLocalStoreLock(runOutputStreamLockPath(filePath), 0, {
            anchorPath: root,
            exactPrivateStorage: true,
          });
        }
        // A held/uninspectable cross-process activity lock fails closed. A
        // candidate may be between exclusive creation and its first write;
        // mtime alone is not proof that the inode is safe to prune.
        const protectedActive = !protectedTarget &&
          fs.existsSync(runOutputStreamLockPath(filePath)) && !inspectionLock;
        if (inspectionLock) {
          releaseLocalStoreLock(inspectionLock);
          inspectionLock = null;
        }
        const stat = fs.lstatSync(filePath, { bigint: true });
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        const expired = now - Number(stat.mtimeMs) > STREAM_RETENTION_MS;
        if (!protectedTarget && !protectedActive && expired &&
          pruneStreamFileUnderActivityLock(filePath, stat, dirStat, rootStat)) {
          // Deleted while holding the same lock required for candidate claim.
        } else {
          retained.push({
            path: filePath,
            mtimeMs: Number(stat.mtimeMs),
            size: Number(stat.size),
            dev: stat.dev,
            ino: stat.ino,
            protected: protectedTarget || protectedActive || expired,
          });
        }
      } catch {
        // Best-effort; one bad entry must never abort the sweep.
      } finally {
        if (inspectionLock) releaseLocalStoreLock(inspectionLock);
      }
    }
    retained.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
    let bytes = retained.reduce((sum, entry) => sum + entry.size, 0);
    let files = retained.length;
    for (const entry of retained) {
      if (files <= MAX_STREAM_FILES && bytes <= MAX_STREAM_AGGREGATE_BYTES) break;
      if (entry.protected) continue;
      runStreamGcBeforeCapacityUnlinkHook?.(entry.path);
      try {
        if (!pruneStreamFileUnderActivityLock(
          entry.path,
          { dev: entry.dev, ino: entry.ino },
          dirStat,
          rootStat,
        )) continue;
        files -= 1;
        bytes -= entry.size;
      } catch {
        // Best-effort; concurrent writers/readers may change an entry.
      }
    }
  } catch {
    // Best-effort; retention is not load-bearing for correctness.
  }
}

/**
 * Add durable output capture only under an exact, typed opt-in. Calling this
 * at every run entry point also performs a retention sweep even
 * when persistence is disabled, so stale captures do not await another write.
 */
export function withOptionalRunOutputPersistence(
  callerSink: StreamSink,
  runId: string,
  cfg: Pick<AshlrConfig, 'foundry'>,
  claim?: RunOutputStreamClaim,
): StreamSink {
  // A claimed candidate stream has already been initialized exclusively. Do
  // not run retention between claim and sink construction: a capacity sweep
  // must never delete that empty inode and let the sink recreate/adopt a
  // different file at the same pathname.
  if (!claim) gcRunStreams(true);
  if (cfg.foundry?.runOutputPersistence?.enabled !== true) {
    // Config is re-read at the runner boundary. If an operator turns the
    // privacy-sensitive feature off after the candidate acquired its claim,
    // retire the unused authority and leave no empty capture behind.
    if (claim) releaseRunOutputStreamClaim(claim);
    return callerSink;
  }
  return combineSinks(callerSink, fileSink(runId, claim));
}

function seedWriteState(filePath: string): StreamWriteState {
  let state = writeState.get(filePath);
  if (state) return state;
  const bytes = inspectStreamFileSize(filePath);
  state = { bytes, truncated: bytes >= MAX_STREAM_FILE_BYTES, seeded: true };
  writeState.set(filePath, state);
  return state;
}

function sameStreamFile(
  left: Pick<fs.BigIntStats, 'dev' | 'ino'>,
  right: Pick<fs.BigIntStats, 'dev' | 'ino'>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function streamClaimMatches(
  claim: RunOutputStreamClaim,
  runId: string,
  filePath: string,
  file?: Pick<fs.BigIntStats, 'dev' | 'ino'>,
): boolean {
  return activeRunOutputStreamClaims.has(claim) &&
    claim[runOutputStreamClaimBrand] === true &&
    claim.runId === runId &&
    claim.filePath === filePath &&
    (!file || (claim.dev === file.dev && claim.ino === file.ino));
}

function safePrivateStreamFile(stat: fs.BigIntStats): boolean {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) return false;
  if (typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) return false;
  return process.platform === 'win32' || (stat.mode & 0o077n) === 0n;
}

function safePrivateStreamDirectory(stat: fs.BigIntStats): boolean {
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  if (typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) return false;
  return process.platform === 'win32' || (stat.mode & 0o077n) === 0n;
}

interface BoundStreamPath {
  file: fs.BigIntStats;
  directory: fs.BigIntStats;
  root: fs.BigIntStats;
}

export interface RunStreamReadIdentity {
  dev: bigint;
  ino: bigint;
}

export interface RunStreamReadChunk {
  bytes: Buffer;
  nextOffset: number;
  identity: RunStreamReadIdentity;
}

let runStreamReadAfterOpenHook: (() => void) | undefined;

/** Test-only race hook. Production callers must never install one. */
export function setRunStreamReadAfterOpenHookForTests(hook?: () => void): void {
  if (process.env['NODE_ENV'] !== 'test' && process.env['VITEST'] !== 'true') {
    throw new Error('run stream read hooks are test-only');
  }
  runStreamReadAfterOpenHook = hook;
}

/**
 * Descriptor-bound, bounded stream read. Opens the final component with
 * O_NOFOLLOW before inspecting it, rejects unsafe/oversized files before any
 * allocation, and re-binds the descriptor, path, parent and private root after
 * the read. Any race or identity change fails closed without advancing offset.
 */
export function readRunStreamChunk(
  runId: string,
  offset: number,
  expected?: RunStreamReadIdentity,
): RunStreamReadChunk | undefined {
  gcRunStreams();
  const filePath = runStreamFilePath(runId);
  if (!filePath || !Number.isSafeInteger(offset) || offset < 0) return undefined;
  let fd: number | undefined;
  try {
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    runStreamReadAfterOpenHook?.();
    const before = bindStreamPath(fd, filePath);
    if (!before || before.file.size > BigInt(MAX_STREAM_FILE_BYTES)) return undefined;
    const identity = { dev: before.file.dev, ino: before.file.ino };
    if (expected && (expected.dev !== identity.dev || expected.ino !== identity.ino)) return undefined;
    if (BigInt(offset) >= before.file.size) {
      const afterEmpty = bindStreamPath(fd, filePath);
      if (!afterEmpty || !sameStreamFile(before.file, afterEmpty.file) ||
        !sameStreamFile(before.directory, afterEmpty.directory) ||
        !sameStreamFile(before.root, afterEmpty.root)) return undefined;
      return { bytes: Buffer.alloc(0), nextOffset: offset, identity };
    }
    const available = Number(before.file.size - BigInt(offset));
    const readLen = Math.min(available, MAX_STREAM_READ_BYTES);
    const bytes = Buffer.alloc(readLen);
    let total = 0;
    while (total < readLen) {
      const read = fs.readSync(fd, bytes, total, readLen - total, offset + total);
      if (read <= 0) return undefined;
      total += read;
    }
    const after = bindStreamPath(fd, filePath);
    if (!after || !sameStreamFile(before.file, after.file) ||
      !sameStreamFile(before.directory, after.directory) ||
      !sameStreamFile(before.root, after.root) || after.file.size > BigInt(MAX_STREAM_FILE_BYTES)) {
      return undefined;
    }
    return { bytes, nextOffset: offset + total, identity };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best-effort */ }
    }
  }
}

function bindStreamPath(
  fd: number,
  filePath: string,
  windowsMode: 'secure-created' | 'inspect-existing' = 'inspect-existing',
): BoundStreamPath | undefined {
  const before = {
    file: fs.fstatSync(fd, { bigint: true }),
    named: fs.lstatSync(filePath, { bigint: true }),
    directory: fs.lstatSync(path.dirname(filePath), { bigint: true }),
    root: fs.lstatSync(path.dirname(path.dirname(filePath)), { bigint: true }),
  };
  if (!safePrivateStreamFile(before.file) || !safePrivateStreamFile(before.named) ||
    !sameStreamFile(before.file, before.named) || !safePrivateStreamDirectory(before.directory) ||
    !safePrivateStreamDirectory(before.root)) return undefined;
  let windowsAssuredAt: number | undefined;
  if (process.platform === 'win32') {
    const cached = windowsStreamFileAssurance.get(filePath);
    const freshCachedIdentity = windowsMode === 'inspect-existing' && cached !== undefined &&
      cached.dev === before.file.dev && cached.ino === before.file.ino &&
      Date.now() - cached.at < DIR_RECHECK_MS;
    if (freshCachedIdentity) {
      windowsAssuredAt = cached.at;
    } else {
      if (!assurePrivateStoragePath(
        filePath,
        'file',
        windowsMode,
        { anchorPath: runStreamsDirRoot() },
      ).ok) return undefined;
      windowsAssuredAt = Date.now();
    }
  }
  const file = fs.fstatSync(fd, { bigint: true });
  const named = fs.lstatSync(filePath, { bigint: true });
  const directory = fs.lstatSync(path.dirname(filePath), { bigint: true });
  const root = fs.lstatSync(path.dirname(path.dirname(filePath)), { bigint: true });
  if (!safePrivateStreamFile(file) || !safePrivateStreamFile(named) ||
    !sameStreamFile(file, named) || !sameStreamFile(before.file, file) ||
    !safePrivateStreamDirectory(directory) || !sameStreamFile(before.directory, directory) ||
    !safePrivateStreamDirectory(root) || !sameStreamFile(before.root, root)) return undefined;
  if (process.platform === 'win32') {
    windowsStreamFileAssurance.set(filePath, {
      dev: file.dev,
      ino: file.ino,
      at: windowsAssuredAt!,
    });
  }
  return { file, directory, root };
}

/**
 * Exclusively create and bind a fresh stream for one candidate attempt.
 * Existing files are always refused, including empty/orphaned files. The
 * returned object is meaningful only in this process and is checked against
 * the originally-created inode on every append.
 */
export function claimRunOutputStream(runId: string): RunOutputStreamClaim | undefined {
  const filePath = runStreamFilePath(runId);
  if (!filePath) return undefined;
  if (!ensureRunStreamsDir()) return undefined;

  let fd: number | undefined;
  let created = false;
  let claimed = false;
  // Acquire intent before retention. This closes the cross-process gap between
  // preserving the target during our sweep and the later O_EXCL: every other
  // pruner must acquire this same lock at its unlink boundary.
  const activityLock = acquireLocalStoreLock(runOutputStreamLockPath(filePath), 0, {
    anchorPath: runStreamsDirRoot(),
    exactPrivateStorage: true,
  });
  if (!activityLock) return undefined;
  try {
    // Keep global retention/cap enforcement on candidate-only workloads while
    // preserving this exact target. A pre-existing orphan remains visible to
    // O_EXCL and is refused, never swept then adopted.
    gcRunStreams(true, runId);
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(
      filePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    created = true;
    fs.fchmodSync(fd, 0o600);
    const bound = bindStreamPath(fd, filePath, 'secure-created');
    if (!bound) return undefined;
    fs.fsyncSync(fd);
    const claim = Object.freeze({
      runId,
      filePath,
      dev: bound.file.dev,
      ino: bound.file.ino,
      [runOutputStreamClaimBrand]: true as const,
    });
    activeRunOutputStreamClaims.add(claim);
    runOutputStreamClaimLocks.set(claim, activityLock);
    writeState.set(filePath, { bytes: 0, truncated: false, seeded: true });
    claimed = true;
    return claim;
  } catch {
    return undefined;
  } finally {
    // A failed claim must not strand a new pathname. Only remove the file
    // when this invocation created it and no active claim was returned.
    if (created && !claimed && fd !== undefined) {
      try {
        const stat = fs.lstatSync(filePath, { bigint: true });
        const opened = fs.fstatSync(fd, { bigint: true });
        if (sameStreamFile(stat, opened)) fs.unlinkSync(filePath);
        windowsStreamFileAssurance.delete(filePath);
      } catch { /* best-effort rollback; an empty orphan remains fail-closed */ }
    }
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best-effort claim closure */ }
    }
    if (!claimed) releaseLocalStoreLock(activityLock);
  }
}

/** Release an unused claim without touching a replaced or externally-mutated path. */
export function releaseRunOutputStreamClaim(claim: RunOutputStreamClaim): void {
  if (!activeRunOutputStreamClaims.delete(claim)) return;
  const activityLock = runOutputStreamClaimLocks.get(claim);
  runOutputStreamClaimLocks.delete(claim);
  let fd: number | undefined;
  try {
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(claim.filePath, fs.constants.O_RDONLY | noFollow);
    const bound = bindStreamPath(fd, claim.filePath);
    if (!bound || !streamClaimMatchesReleased(claim, bound.file) || bound.file.size !== 0n) return;
    fs.unlinkSync(claim.filePath);
    writeState.delete(claim.filePath);
    windowsStreamFileAssurance.delete(claim.filePath);
  } catch {
    // Best-effort rollback. Failure leaves an empty orphan that future claims
    // refuse; it never grants append authority.
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best-effort release closure */ }
    }
    if (activityLock) releaseLocalStoreLock(activityLock);
  }
}

function retireRunOutputStreamClaim(claim: RunOutputStreamClaim): void {
  if (!activeRunOutputStreamClaims.delete(claim)) return;
  const activityLock = runOutputStreamClaimLocks.get(claim);
  runOutputStreamClaimLocks.delete(claim);
  if (activityLock) releaseLocalStoreLock(activityLock);
}

function streamClaimMatchesReleased(
  claim: RunOutputStreamClaim,
  file: Pick<fs.BigIntStats, 'dev' | 'ino'>,
): boolean {
  return claim.dev === file.dev && claim.ino === file.ino;
}

/** Seed the restart-safe byte cap from descriptor-bound metadata, never from a
 * check-then-reopen pathname observation. Unsafe/unreadable existing state is
 * treated as already full so persistence fails closed. */
function inspectStreamFileSize(filePath: string): number {
  let fd: number | undefined;
  try {
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const bound = bindStreamPath(fd, filePath);
    if (!bound || bound.file.size >= BigInt(MAX_STREAM_FILE_BYTES)) return MAX_STREAM_FILE_BYTES;
    return Number(bound.file.size);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : MAX_STREAM_FILE_BYTES;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best-effort stream metadata read */ }
    }
  }
}

/**
 * Open an existing stream file without a prior pathname check, or create it
 * exclusively when absent. O_EXCL closes the absent-to-create race; O_NOFOLLOW
 * rejects a final-component symlink. The caller still binds the resulting
 * descriptor to the named inode before writing, because parent/path replacement
 * can happen independently of the final-component open flags.
 */
function openStreamAppendFile(filePath: string): { fd: number; created: boolean } {
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const existingFlags = fs.constants.O_APPEND | fs.constants.O_WRONLY | noFollow;
  try {
    return {
      fd: fs.openSync(
        filePath,
        existingFlags | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      ),
      created: true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return { fd: fs.openSync(filePath, existingFlags), created: false };
  }
}

function appendStreamLine(
  filePath: string,
  line: string,
  claim?: RunOutputStreamClaim,
): boolean {
  let fd: number | undefined;
  let created = false;
  let bytesWritten = 0;
  let success = false;
  try {
    if (claim) {
      // Claimed paths are never recreated. If the exclusively-created inode
      // disappeared, this write loses authority and fails closed instead of
      // leaving a fresh orphan at the same pathname.
      const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
      fd = fs.openSync(filePath, fs.constants.O_APPEND | fs.constants.O_WRONLY | noFollow);
    } else {
      ({ fd, created } = openStreamAppendFile(filePath));
      if (created) fs.fchmodSync(fd, 0o600);
    }
    const bound = bindStreamPath(fd, filePath, created ? 'secure-created' : 'inspect-existing');
    if (!bound || (claim && !streamClaimMatches(claim, claim.runId, filePath, bound.file))) return false;

    const bytes = Buffer.from(line, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) return false;
      offset += written;
      bytesWritten += written;
    }

    const after = bindStreamPath(fd, filePath);
    if (!after || !sameStreamFile(bound.file, after.file) ||
      !sameStreamFile(bound.directory, after.directory) ||
      !sameStreamFile(bound.root, after.root)) return false;
    success = true;
    return true;
  } catch {
    return false;
  } finally {
    // A failed first-create before content mutation must not permanently
    // poison the run id. Never unlink after any byte was written, and never
    // unlink a pathname that no longer names our exact empty descriptor.
    if (created && !success && bytesWritten === 0 && fd !== undefined) {
      try {
        const opened = fs.fstatSync(fd, { bigint: true });
        const named = fs.lstatSync(filePath, { bigint: true });
        if (opened.size === 0n && sameStreamFile(opened, named)) {
          fs.unlinkSync(filePath);
          writeState.delete(filePath);
          windowsStreamFileAssurance.delete(filePath);
        }
      } catch { /* best-effort rollback; any survivor remains fail-closed */ }
    }
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
export function fileSink(runId: string, claim?: RunOutputStreamClaim): StreamSink {
  const filePath = runStreamFilePath(runId);
  if (!filePath || (claim && !streamClaimMatches(claim, runId, filePath))) return nullSink();

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
        const markerBytes = Buffer.byteLength(markerLine, 'utf8');
        if (state.bytes + markerBytes <= MAX_STREAM_FILE_BYTES && appendStreamLine(filePath, markerLine, claim)) {
          state.bytes += markerBytes;
        }
        return false;
      }

      if (appendStreamLine(filePath, line, claim)) {
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
        /:\/\/[^:\s/@]*:/.test(text) ||
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
    if (claim) retireRunOutputStreamClaim(claim);
  };
  sink.error = () => {
    try {
      if (!ended && !redactionLocked) finalizePending();
    } catch { /* never throw */ }
    ended = true;
    if (claim) retireRunOutputStreamClaim(claim);
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
