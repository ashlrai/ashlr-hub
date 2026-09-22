/**
 * Verse session engine — owns session lifecycle, the durable store, and the
 * one-process-per-turn spawn (detached process group, SIGINT → grace → SIGKILL).
 *
 * The engine never reads secrets and never exposes launcher commands: the
 * seat launch handed to `createSession` is persisted privately in
 * `<id>.launch.json` (0600) and only ever re-read here to build argv.
 *
 * Spawn pattern mirrors src/core/run/engines.ts spawnEngineInner: the child is
 * its own process-group leader (`detached: true`) so cancellation signals the
 * whole group, escalating SIGINT → SIGKILL after a grace period, with a bounded
 * drain so a descendant holding our pipes cannot keep a turn "running" forever.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';

import { scrubSecrets } from '../util/scrub.js';

import { adapterFor, type VerseParsedEvent, type VerseTurnParser } from './adapters/index.js';
import { createVerseSessionStore, type VerseSessionStore } from './session-store.js';
import {
  VERSE_DEFAULT_CONTEXT_WINDOWS,
  VERSE_MAX_TURN_TEXT_BYTES,
  VERSE_MAX_WORKSPACE_ROOTS,
  VERSE_TURN_TIMEOUT_MS,
  type VerseCreateSessionRequest,
  type VerseEngine,
  type VerseEvent,
  type VerseSeat,
  type VerseSession,
  type VerseTurnLaunch,
  type VerseUsage,
} from './types.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type VerseErrorCode =
  | 'VERSE_SESSION_NOT_FOUND'
  | 'VERSE_SESSION_BUSY'
  | 'VERSE_INVALID'
  | 'VERSE_TOO_LARGE';

const VERSE_ERROR_STATUS: Record<VerseErrorCode, 404 | 409 | 400 | 413> = {
  VERSE_SESSION_NOT_FOUND: 404,
  VERSE_SESSION_BUSY: 409,
  VERSE_INVALID: 400,
  VERSE_TOO_LARGE: 413,
};

export class VerseError extends Error {
  readonly code: VerseErrorCode;
  readonly status: 404 | 409 | 400 | 413;

  constructor(code: VerseErrorCode, message: string) {
    super(message);
    this.name = 'VerseError';
    this.code = code;
    this.status = VERSE_ERROR_STATUS[code];
  }
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** What owner B resolves for a seat at session-creation time. Persisted privately, never exported. */
export interface VerseSeatLaunch {
  seat: VerseSeat;
  /** Native-profile launcher argv prefix (node + launcher path) for claude/codex/grok; null for local. */
  launcher: string[] | null;
  /**
   * e.g. http://127.0.0.1:11434 — the Ollama endpoint this seat was
   * DISCOVERED from, and the dispatch endpoint on the default lane.
   */
  ollamaBaseUrl: string;
  /**
   * Where a LOCAL seat's Anthropic client is pointed for DISPATCH, when that
   * is not `ollamaBaseUrl` — i.e. the llama-server lane's normalising proxy.
   *
   * OPTIONAL on purpose. Launch records are persisted per session, so every
   * record written before this field existed has to keep validating; absent
   * means "the Ollama lane", which is what those sessions were created on.
   */
  anthropicBaseUrl?: string;
}

export interface VerseEngineHandle {
  listSessions(): VerseSession[];
  getSession(id: string): VerseSession | null;
  getEvents(id: string, fromSeq?: number): VerseEvent[];
  createSession(req: VerseCreateSessionRequest, launch: VerseSeatLaunch): VerseSession;
  sendTurn(id: string, text: string): { turnId: string; session: VerseSession };
  cancelTurn(id: string): boolean;
  deleteSession(id: string): void;
  renameSession(id: string, title: string): VerseSession;
  /** Replays stored events with `seq > fromSeq`, then delivers live ones. Returns the unsubscribe function. */
  subscribe(id: string, fromSeq: number, listener: (event: VerseEvent) => void): () => void;
  /** Kills running turns and drops listeners. */
  close(): void;
}

export interface VerseEngineOptions {
  /** Store root. Default `~/.ashlr/verse`. */
  root?: string;
  spawn?: typeof nodeSpawn;
  now?: () => Date;
  /** Per-turn wall clock limit. Default VERSE_TURN_TIMEOUT_MS. */
  turnTimeoutMs?: number;
  /** SIGINT → SIGKILL escalation delay. Default 10s. */
  killGraceMs?: number;
}

// ---------------------------------------------------------------------------
// Env containment
// ---------------------------------------------------------------------------

const BASE_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'] as const;

/**
 * Copied from src/core/run/sandboxed-engine.ts (not exported there). Credential-
 * shaped env var names that must never reach the agent subprocess.
 */
const CRED_ENV_DENY =
  /(_|^)(TOKEN|SECRET|KEY|PAT|PASSWORD|PASSWD|CREDENTIALS?|API[_-]?KEY|OAUTH[_-]?TOKEN|CREDS?)$/i;

/**
 * The agent CLIs' own subscription tokens (same exemption as sandboxed-engine).
 * ANTHROPIC_AUTH_TOKEN is required for engine=local (`ollama` placeholder).
 */
const ENGINE_AUTH_ALLOW = new Set(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']);

export function buildTurnEnv(extra: Record<string, string>, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_ENV_KEYS) {
    const value = base[key];
    if (typeof value === 'string') env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value === 'string') env[key] = value;
  }
  for (const key of Object.keys(env)) {
    if (CRED_ENV_DENY.test(key) && !ENGINE_AUTH_ALLOW.has(key)) delete env[key];
  }
  return env;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const DEFAULT_TITLE = 'New chat';
const TITLE_MAX = 120;
const AUTO_TITLE_CHARS = 60;
const DEFAULT_KILL_GRACE_MS = 10_000;
const KILL_DRAIN_MS = 1_000;
const STDERR_TAIL_LINES = 20;
const STDERR_TAIL_CHARS = 2_000;
/** Launcher argv parts shorter than this are too generic to scrub (e.g. `-p`). */
const REDACT_LAUNCHER_MIN_CHARS = 4;
/** Adapter env values shorter than this (`1`, `ollama`) are not path-shaped; scrub only URLs/paths. */
const REDACT_ENV_MIN_CHARS = 8;
const INTERRUPTED_MESSAGE = 'turn interrupted: server restarted';
const INTERRUPTED_LAST_ERROR = 'interrupted by server restart';

type TerminationReason = 'cancelled' | 'timeout' | 'closed';

/** A string that must never reach a durable event, with the placeholder that replaces it. */
interface Redaction {
  value: string;
  label: '[launcher]' | '[env]';
}

interface RunningTurn {
  turnId: string;
  child: ChildProcess;
  pgid: number | null;
  startedAt: number;
  parser: VerseTurnParser;
  stdoutBuf: string;
  stderrTail: string[];
  redactions: Redaction[];
  sawOutput: boolean;
  sawError: boolean;
  termination: TerminationReason | null;
  settled: boolean;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  escalationTimer: ReturnType<typeof setTimeout> | null;
  drainTimer: ReturnType<typeof setTimeout> | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isSeatLaunch(value: unknown): value is VerseSeatLaunch {
  if (!isObject(value)) return false;
  const seat = value['seat'];
  return isObject(seat)
    && typeof seat['id'] === 'string'
    && typeof seat['engine'] === 'string'
    && Array.isArray(seat['models'])
    && (value['launcher'] === null || isStringArray(value['launcher']))
    && typeof value['ollamaBaseUrl'] === 'string'
    // Absent is valid: that is every launch record written before the
    // llama-server lane existed, and it means the Ollama lane.
    && (value['anthropicBaseUrl'] === undefined || typeof value['anthropicBaseUrl'] === 'string');
}

function cloneSession(session: VerseSession): VerseSession {
  return { ...session, usage: { ...session.usage } };
}

function normaliseTitle(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.length > TITLE_MAX ? `${collapsed.slice(0, TITLE_MAX - 1)}…` : collapsed;
}

function autoTitle(text: string): string {
  const firstLine = text.replace(/\s+/g, ' ').trim();
  if (!firstLine) return DEFAULT_TITLE;
  return firstLine.length > AUTO_TITLE_CHARS ? `${firstLine.slice(0, AUTO_TITLE_CHARS).trimEnd()}…` : firstLine;
}

function contextWindowFor(seat: VerseSeat, model: string, engine: VerseEngine): number | null {
  const option = seat.models.find((m) => m.id === model);
  if (option && typeof option.contextWindow === 'number') return option.contextWindow;
  if (typeof seat.contextWindow === 'number') return seat.contextWindow;
  const fallback = VERSE_DEFAULT_CONTEXT_WINDOWS[engine];
  return typeof fallback === 'number' ? fallback : null;
}

function resolveProjectDir(projectPath: unknown): string {
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    throw new VerseError('VERSE_INVALID', 'projectPath is required');
  }
  if (!isAbsolute(projectPath)) {
    throw new VerseError('VERSE_INVALID', 'projectPath must be an absolute path');
  }
  let real: string;
  try {
    real = realpathSync(projectPath);
    if (!statSync(real).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new VerseError('VERSE_INVALID', 'projectPath must be an existing directory');
  }
  return real;
}

/**
 * Resolve the roots a session gets BEYOND its primary.
 *
 * Structural validation only — absolute, real, a directory, deduplicated
 * after realpath so a symlink and its target cannot be granted twice, and
 * capped. The POLICY question (is this directory one Verse may ever name?) is
 * `path-guard.ts`, applied at the API boundary alongside every other
 * request-shaped check; this mirrors `resolveProjectDir`, which has always
 * validated shape here and left policy to its caller.
 *
 * `undefined` in means `[]` out, so a pre-workspace create request produces a
 * record with no `extraRoots` key at all.
 */
function resolveExtraRoots(extraRoots: unknown, primary: string): string[] {
  if (extraRoots === undefined || extraRoots === null) return [];
  if (!Array.isArray(extraRoots)) {
    throw new VerseError('VERSE_INVALID', 'extraRoots must be an array of absolute paths');
  }
  if (extraRoots.length > VERSE_MAX_WORKSPACE_ROOTS - 1) {
    throw new VerseError('VERSE_INVALID', `a session may have at most ${VERSE_MAX_WORKSPACE_ROOTS} roots`);
  }
  const out: string[] = [];
  for (const raw of extraRoots) {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new VerseError('VERSE_INVALID', 'every extra root must be a non-empty absolute path');
    }
    if (!isAbsolute(raw)) {
      throw new VerseError('VERSE_INVALID', `extra root must be an absolute path: ${raw}`);
    }
    let real: string;
    try {
      real = realpathSync(raw);
      if (!statSync(real).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new VerseError('VERSE_INVALID', `extra root must be an existing directory: ${raw}`);
    }
    if (real === primary || out.includes(real)) continue;
    out.push(real);
  }
  return out;
}

function errorCode(err: unknown): string {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code ?? '') : '';
}

/**
 * Fixed-phrase spawn failure text keyed on the errno only. Node's own message
 * (`spawn /path/to/launcher ENOENT`) names the launcher, which must never be
 * written to the event log or reach the API.
 */
function describeSpawnFailure(prefix: string, err: unknown): string {
  const code = errorCode(err) || 'EUNKNOWN';
  const hint = code === 'ENOENT' ? ' (launcher not found)' : code === 'EACCES' ? ' (launcher not executable)' : '';
  return `${prefix}: ${code}${hint}`;
}

/**
 * The private native-profile tree a launcher path sits in.
 *
 * `<abs>/.ashlr/native-profiles/<profile>/launcher.mjs` is registered by the
 * caller, but the PARENT directory is not a substring of it, so a vendor CLI
 * naming its own CODEX_HOME/CLAUDE_CONFIG_DIR tree — e.g.
 * `ENOENT: .../.ashlr/native-profiles/codex-personal/native-state/sessions/…`
 * — passed `redact()` untouched, reached the `error` event, the SSE frame and
 * `GET /api/verse/sessions/:id`, and was persisted to the 0600 session record.
 * `sanitizePublicJson` only rewrites the home prefix to `~`, so what survived
 * on the API path was `~/.ashlr/native-profiles/<profile>/…`: the account
 * identity this whole boundary exists to withhold. The adapters supply no env
 * (`codex.ts`/`grok.ts` return `env: {}`), so nothing else covered it.
 *
 * Ancestors are registered ONLY up to a directory literally named
 * `native-profiles`. A launcher outside that tree registers nothing extra —
 * walking to `/Users` and redacting it out of every stderr line would be a
 * different kind of damage.
 */
const NATIVE_PROFILES_DIR = 'native-profiles';
const MAX_LAUNCHER_ANCESTORS = 8;

function launcherAncestors(part: string): string[] {
  if (!part.includes(sep)) return [];
  const chain: string[] = [];
  let dir = dirname(part);
  for (let depth = 0; depth < MAX_LAUNCHER_ANCESTORS && dir !== dirname(dir); depth += 1) {
    if (dir.length < REDACT_LAUNCHER_MIN_CHARS) break;
    chain.push(dir);
    if (basename(dir) === NATIVE_PROFILES_DIR) return chain;
    dir = dirname(dir);
  }
  return [];
}

/**
 * Everything about a launch that must not leak through a stderr tail: the
 * launcher argv, its private native-profile directories, the spawned binary
 * and path/URL-shaped adapter env values.
 * Longest first so a full path is replaced before any of its parts.
 */
function redactionsFor(seatLaunch: VerseSeatLaunch, turnLaunch: VerseTurnLaunch | null): Redaction[] {
  const out = new Map<string, Redaction['label']>();
  for (const part of seatLaunch.launcher ?? []) {
    if (part.length >= REDACT_LAUNCHER_MIN_CHARS) out.set(part, '[launcher]');
    for (const dir of launcherAncestors(part)) {
      if (!out.has(dir)) out.set(dir, '[launcher]');
    }
  }
  if (turnLaunch) {
    const bin = turnLaunch.argv[0];
    if (bin && bin.length >= REDACT_LAUNCHER_MIN_CHARS) out.set(bin, '[launcher]');
    for (const value of Object.values(turnLaunch.env)) {
      if (value.length >= REDACT_ENV_MIN_CHARS && !out.has(value)) out.set(value, '[env]');
    }
  }
  return [...out.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => b.value.length - a.value.length);
}

function redact(text: string, redactions: Redaction[]): string {
  let out = text;
  for (const { value, label } of redactions) {
    if (out.includes(value)) out = out.split(value).join(label);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export function createVerseEngine(opts: VerseEngineOptions = {}): VerseEngineHandle {
  const root = opts.root ?? join(homedir(), '.ashlr', 'verse');
  const spawn = opts.spawn ?? nodeSpawn;
  const now = opts.now ?? (() => new Date());
  const turnTimeoutMs = opts.turnTimeoutMs ?? VERSE_TURN_TIMEOUT_MS;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const store: VerseSessionStore = createVerseSessionStore(root);
  const running = new Map<string, RunningTurn>();
  const listeners = new Map<string, Set<(event: VerseEvent) => void>>();
  let closed = false;

  function nowIso(): string {
    return now().toISOString();
  }

  function require(id: string): VerseSession {
    if (typeof id !== 'string') throw new VerseError('VERSE_SESSION_NOT_FOUND', 'session not found');
    const session = store.get(id);
    if (!session) throw new VerseError('VERSE_SESSION_NOT_FOUND', `session not found: ${id}`);
    return session;
  }

  function emit(id: string, event: VerseParsedEvent): VerseEvent {
    const stored = store.appendEvent(id, event, nowIso());
    const subs = listeners.get(id);
    if (subs) {
      for (const listener of [...subs]) {
        try { listener(stored); } catch { /* a bad listener never breaks the turn */ }
      }
    }
    return stored;
  }

  function save(session: VerseSession): VerseSession {
    session.updatedAt = nowIso();
    store.save(session);
    return session;
  }

  /**
   * A record left `running` with no live process (the server crashed, was
   * killed, or lost power mid-turn) would otherwise be busy forever: sendTurn
   * 409s and cancelTurn has nothing to kill. Settle it the way every other
   * exit path does — `error` + `turn-done ok:false` for the dangling turn —
   * so the transcript closes and the session is usable again.
   */
  function reconcileInterrupted(session: VerseSession): void {
    let orphanTurnId: string | null = null;
    for (const event of store.readEvents(session.id)) {
      if (event.type === 'user-message' || event.type === 'turn-started') orphanTurnId = event.turnId;
      else if ((event.type === 'turn-done' || event.type === 'cancelled') && event.turnId === orphanTurnId) orphanTurnId = null;
    }
    emit(session.id, { type: 'error', turnId: orphanTurnId, message: INTERRUPTED_MESSAGE });
    if (orphanTurnId) {
      emit(session.id, {
        type: 'turn-done',
        turnId: orphanTurnId,
        ok: false,
        nativeSessionId: session.nativeSessionId,
        durationMs: 0,
      });
    }
    session.status = 'error';
    session.lastError = INTERRUPTED_LAST_ERROR;
    save(session);
  }

  for (const session of store.list()) {
    if (session.status === 'running') reconcileInterrupted(session);
  }

  // ---- process-group signalling -------------------------------------------

  function signalGroup(turn: RunningTurn, signal: NodeJS.Signals): void {
    const { child, pgid } = turn;
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (pgid !== null) {
      try {
        process.kill(-pgid, signal);
        return;
      } catch (err) {
        if (errorCode(err) === 'ESRCH') return;
        // Fall through to a direct kill of the leader.
      }
    }
    try { child.kill(signal); } catch { /* already gone */ }
  }

  function clearTimers(turn: RunningTurn): void {
    for (const key of ['timeoutTimer', 'escalationTimer', 'drainTimer'] as const) {
      const timer = turn[key];
      if (timer !== null) clearTimeout(timer);
      turn[key] = null;
    }
  }

  function beginDrain(id: string, turn: RunningTurn): void {
    if (turn.settled || turn.drainTimer !== null) return;
    turn.drainTimer = setTimeout(() => {
      turn.drainTimer = null;
      // A descendant may still hold our pipes; stop waiting on them.
      turn.child.stdout?.destroy();
      turn.child.stderr?.destroy();
      finalize(id, turn, turn.child.exitCode);
    }, KILL_DRAIN_MS);
  }

  function requestTermination(id: string, turn: RunningTurn, reason: TerminationReason): void {
    if (turn.settled || turn.termination !== null) return;
    turn.termination = reason;
    if (turn.timeoutTimer !== null) { clearTimeout(turn.timeoutTimer); turn.timeoutTimer = null; }
    if (reason === 'closed') {
      signalGroup(turn, 'SIGKILL');
      beginDrain(id, turn);
      return;
    }
    signalGroup(turn, 'SIGINT');
    turn.escalationTimer = setTimeout(() => {
      turn.escalationTimer = null;
      signalGroup(turn, 'SIGKILL');
      beginDrain(id, turn);
    }, killGraceMs);
  }

  // ---- turn completion ----------------------------------------------------

  function applyUsage(session: VerseSession, event: VerseParsedEvent): VerseParsedEvent {
    if (event.type !== 'usage') return event;
    const window = session.usage.contextWindow;
    // Adapters report the vendor's own figure; codex only exposes the turn
    // total (an upper bound on the live prompt), so never let the meter
    // exceed the window it is measured against.
    const contextTokens = window !== null ? Math.min(event.usage.contextTokens, window) : event.usage.contextTokens;
    const u: VerseUsage = { ...event.usage, contextTokens, contextWindow: window };
    session.usage = {
      inputTokens: session.usage.inputTokens + u.inputTokens,
      outputTokens: session.usage.outputTokens + u.outputTokens,
      cacheReadTokens: session.usage.cacheReadTokens + u.cacheReadTokens,
      cacheCreationTokens: session.usage.cacheCreationTokens + u.cacheCreationTokens,
      contextTokens: u.contextTokens,
      contextWindow: session.usage.contextWindow,
    };
    return { ...event, usage: u };
  }

  function handleParsed(id: string, turn: RunningTurn, events: VerseParsedEvent[]): void {
    if (events.length === 0) return;
    turn.sawOutput = true;
    const session = store.get(id);
    for (const event of events) {
      if (event.type === 'error') turn.sawError = true;
      const enriched = session ? applyUsage(session, event) : event;
      emit(id, enriched);
      if (session && event.type === 'usage') save(session);
    }
  }

  function pushLine(id: string, turn: RunningTurn, line: string): void {
    if (turn.settled) return;
    let events: VerseParsedEvent[];
    try { events = turn.parser.push(line); } catch { events = []; }
    if (turn.termination !== null) {
      // We signalled this process ourselves (Stop / timeout / shutdown). The
      // vendor CLI then reports the interruption as a failure; that is not an
      // error the operator caused, so keep the stream clean: `cancelled` +
      // `turn-done ok:false` are the record of what happened.
      events = events.filter((event) =>
        event.type !== 'error' &&
        !(event.type === 'assistant-message' && event.text.trim() === '[Request interrupted by user]'));
    }
    handleParsed(id, turn, events);
  }

  function finalize(id: string, turn: RunningTurn, exitCode: number | null): void {
    if (turn.settled) return;
    turn.settled = true;
    clearTimers(turn);
    running.delete(id);

    if (turn.stdoutBuf.trim()) {
      const rest = turn.stdoutBuf;
      turn.stdoutBuf = '';
      turn.settled = false;
      pushLine(id, turn, rest);
      turn.settled = true;
    }

    let finished: VerseParsedEvent[];
    try { finished = turn.parser.finish(exitCode); } catch { finished = []; }
    // Suppress the parser's generic non-zero-exit error when we caused the exit.
    if (turn.termination !== null) finished = finished.filter((event) => event.type !== 'error');
    handleParsed(id, turn, finished);

    const session = store.get(id);
    let ok = exitCode === 0 && !turn.sawError;
    let lastError: string | null = null;
    // Stop is a normal action, not a failure: the session returns to idle
    // and the `cancelled` event is the only record of it.
    const stopped = turn.termination === 'cancelled' || turn.termination === 'closed';

    if (stopped) {
      ok = false;
      emit(id, { type: 'cancelled', turnId: turn.turnId });
    } else if (turn.termination === 'timeout') {
      ok = false;
      lastError = `turn timed out after ${turnTimeoutMs}ms`;
      emit(id, { type: 'error', turnId: turn.turnId, message: lastError });
    } else if (!ok) {
      // The tail is scrubbed of the launcher/binary/env before it is durable.
      // `scrubSecrets` runs too, because this string is persisted to the 0600
      // session record as well as emitted: on the API path `sanitizePublicJson`
      // would scrub a forwarded CLAUDE_CODE_OAUTH_TOKEN, on the disk path
      // nothing did.
      const tail = scrubSecrets(redact(turn.stderrTail.join('\n'), turn.redactions)).trim().slice(-STDERR_TAIL_CHARS);
      lastError = exitCode === null
        ? 'process ended without an exit code'
        : `process exited with code ${exitCode}`;
      if (!turn.sawError) {
        emit(id, { type: 'error', turnId: turn.turnId, message: tail ? `${lastError}: ${tail}` : lastError });
      }
    }

    const nativeFromOutput = turn.parser.nativeSessionId();
    const nativeSessionId = nativeFromOutput ?? session?.nativeSessionId ?? null;
    emit(id, {
      type: 'turn-done',
      turnId: turn.turnId,
      ok,
      nativeSessionId,
      durationMs: Math.max(0, Date.now() - turn.startedAt),
    });

    if (session) {
      if (nativeFromOutput && !session.nativeSessionId) session.nativeSessionId = nativeFromOutput;
      // Count the turn once the CLI engaged: a resumed conversation exists on
      // the vendor side even when the turn was cancelled part-way.
      if (ok || turn.sawOutput) session.turnCount += 1;
      session.status = ok || stopped ? 'idle' : 'error';
      session.lastError = ok || stopped ? null : (lastError ?? session.lastError ?? 'turn failed');
      save(session);
    }

    turn.child.removeAllListeners();
    turn.child.on('error', () => { /* late errors after settlement are noise */ });
    turn.child.stdout?.removeAllListeners();
    turn.child.stderr?.removeAllListeners();
    if (typeof turn.child.unref === 'function') turn.child.unref();
  }

  // ---- spawn ----------------------------------------------------------------

  function startTurn(session: VerseSession, turnId: string, launch: VerseTurnLaunch, redactions: Redaction[]): void {
    const id = session.id;
    const adapter = adapterFor(session.engine);
    const parser = adapter.createParser(turnId);
    const env = buildTurnEnv(launch.env);
    const [bin, ...args] = launch.argv;
    const detached = process.platform !== 'win32';

    let child: ChildProcess;
    try {
      child = spawn(bin, args, {
        cwd: launch.cwd,
        env,
        stdio: [launch.stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        ...(detached ? { detached: true } : {}),
      });
    } catch (err) {
      // Never `err.message`: Node's text names the launcher path.
      const message = describeSpawnFailure(`failed to start ${session.engine}`, err);
      emit(id, { type: 'error', turnId, message });
      emit(id, { type: 'turn-done', turnId, ok: false, nativeSessionId: session.nativeSessionId, durationMs: 0 });
      session.status = 'error';
      session.lastError = message;
      save(session);
      return;
    }

    const turn: RunningTurn = {
      turnId,
      child,
      pgid: detached && typeof child.pid === 'number' && child.pid > 0 ? child.pid : null,
      startedAt: Date.now(),
      parser,
      stdoutBuf: '',
      stderrTail: [],
      redactions,
      sawOutput: false,
      sawError: false,
      termination: null,
      settled: false,
      timeoutTimer: null,
      escalationTimer: null,
      drainTimer: null,
    };
    running.set(id, turn);
    emit(id, { type: 'turn-started', turnId, pid: typeof child.pid === 'number' ? child.pid : null });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string | Buffer) => {
      turn.stdoutBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let nl: number;
      while ((nl = turn.stdoutBuf.indexOf('\n')) !== -1) {
        const line = turn.stdoutBuf.slice(0, nl);
        turn.stdoutBuf = turn.stdoutBuf.slice(nl + 1);
        pushLine(id, turn, line);
      }
    });

    let stderrBuf = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string | Buffer) => {
      stderrBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let nl: number;
      while ((nl = stderrBuf.indexOf('\n')) !== -1) {
        const line = stderrBuf.slice(0, nl).trimEnd();
        stderrBuf = stderrBuf.slice(nl + 1);
        if (!line) continue;
        turn.stderrTail.push(line);
        if (turn.stderrTail.length > STDERR_TAIL_LINES) turn.stderrTail.shift();
      }
    });

    child.on('error', (err: Error) => {
      if (turn.settled) return;
      turn.sawError = true;
      // Async spawn failures (ENOENT) carry the launcher path in err.message; keep the errno only.
      emit(id, { type: 'error', turnId, message: describeSpawnFailure(`${session.engine} process error`, err) });
      // Spawn failures (ENOENT) never fire 'close' with a code; settle now.
      if (child.pid === undefined) finalize(id, turn, null);
    });

    child.on('close', (code) => {
      if (stderrBuf.trim()) turn.stderrTail.push(stderrBuf.trimEnd());
      finalize(id, turn, code);
    });

    if (launch.stdin !== null && child.stdin) {
      child.stdin.on('error', () => { /* EPIPE when the CLI exits early */ });
      child.stdin.end(launch.stdin);
    }

    turn.timeoutTimer = setTimeout(() => {
      turn.timeoutTimer = null;
      requestTermination(id, turn, 'timeout');
    }, turnTimeoutMs);
    if (turn.timeoutTimer.unref) turn.timeoutTimer.unref();
  }

  // ---- handle -----------------------------------------------------------------

  return {
    listSessions(): VerseSession[] {
      return store.list()
        .map(cloneSession)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    },

    getSession(id: string): VerseSession | null {
      const session = typeof id === 'string' ? store.get(id) : null;
      return session ? cloneSession(session) : null;
    },

    getEvents(id: string, fromSeq = 0): VerseEvent[] {
      require(id);
      return store.readEvents(id, fromSeq);
    },

    createSession(req: VerseCreateSessionRequest, launch: VerseSeatLaunch): VerseSession {
      if (closed) throw new VerseError('VERSE_INVALID', 'verse engine is closed');
      if (!isObject(req)) throw new VerseError('VERSE_INVALID', 'request body must be an object');
      if (!isSeatLaunch(launch)) throw new VerseError('VERSE_INVALID', 'seat launch is malformed');
      const projectPath = resolveProjectDir(req.projectPath);
      const extraRoots = resolveExtraRoots(req.extraRoots, projectPath);
      if (req.workspaceId !== undefined && typeof req.workspaceId !== 'string') {
        throw new VerseError('VERSE_INVALID', 'workspaceId must be a string');
      }
      const seat = launch.seat;
      if (typeof req.seatId !== 'string' || req.seatId !== seat.id) {
        throw new VerseError('VERSE_INVALID', `unknown seat: ${String(req.seatId)}`);
      }
      const engine = seat.engine;
      if (engine !== 'local' && (!launch.launcher || launch.launcher.length === 0)) {
        throw new VerseError('VERSE_INVALID', `seat ${seat.id} has no launcher`);
      }
      const model = typeof req.model === 'string' && req.model.trim() ? req.model.trim() : seat.models[0]?.id;
      if (!model) throw new VerseError('VERSE_INVALID', `seat ${seat.id} has no models`);
      if (!seat.models.some((m) => m.id === model)) {
        throw new VerseError('VERSE_INVALID', `model ${model} is not available on seat ${seat.id}`);
      }
      if (req.title !== undefined && typeof req.title !== 'string') {
        throw new VerseError('VERSE_INVALID', 'title must be a string');
      }
      const title = req.title ? normaliseTitle(req.title) : '';
      const at = nowIso();
      const session: VerseSession = {
        id: randomUUID(),
        title: title || DEFAULT_TITLE,
        projectPath,
        // Spread-only-when-present, so a single-root chat writes a record that
        // is byte-identical to what it would have written before workspaces
        // existed. Nothing has to migrate because nothing changed shape.
        ...(extraRoots.length > 0 ? { extraRoots } : {}),
        ...(typeof req.workspaceId === 'string' && req.workspaceId.length > 0
          ? { workspaceId: req.workspaceId }
          : {}),
        ...(typeof req.workspaceName === 'string' && req.workspaceName.length > 0
          ? { workspaceName: req.workspaceName }
          : {}),
        engine,
        accountId: seat.accountId,
        seatId: seat.id,
        model,
        nativeSessionId: engine === 'codex' ? null : randomUUID(),
        createdAt: at,
        updatedAt: at,
        status: 'idle',
        turnCount: 0,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextTokens: 0,
          contextWindow: contextWindowFor(seat, model, engine),
        },
        lastError: null,
      };
      store.save(session);
      store.saveLaunch(session.id, {
        seat: launch.seat,
        launcher: launch.launcher ? [...launch.launcher] : null,
        ollamaBaseUrl: launch.ollamaBaseUrl,
        // Pinned at CREATION time, deliberately: a session that started on one
        // lane keeps resuming on it, rather than silently changing endpoint
        // mid-conversation because config moved underneath it.
        ...(typeof launch.anthropicBaseUrl === 'string' && launch.anthropicBaseUrl.length > 0
          ? { anthropicBaseUrl: launch.anthropicBaseUrl }
          : {}),
      } satisfies VerseSeatLaunch);
      return cloneSession(session);
    },

    sendTurn(id: string, text: string): { turnId: string; session: VerseSession } {
      if (closed) throw new VerseError('VERSE_INVALID', 'verse engine is closed');
      const session = require(id);
      if (typeof text !== 'string' || !text.trim()) throw new VerseError('VERSE_INVALID', 'text is required');
      if (Buffer.byteLength(text, 'utf8') > VERSE_MAX_TURN_TEXT_BYTES) {
        throw new VerseError('VERSE_TOO_LARGE', `text exceeds ${VERSE_MAX_TURN_TEXT_BYTES} bytes`);
      }
      if (running.has(id)) {
        throw new VerseError('VERSE_SESSION_BUSY', 'a turn is already running');
      }
      // `running` on disk with no live process is stale (see reconcileInterrupted), not busy.
      if (session.status === 'running') reconcileInterrupted(session);
      const launch = store.loadLaunch(id);
      if (!isSeatLaunch(launch)) {
        throw new VerseError('VERSE_INVALID', 'session launch record is missing or unreadable');
      }

      const turnId = randomUUID();
      if (session.turnCount === 0 && session.title === DEFAULT_TITLE) session.title = autoTitle(text);
      emit(id, { type: 'user-message', turnId, text });
      session.status = 'running';
      session.lastError = null;
      save(session);

      let turnLaunch: VerseTurnLaunch;
      try {
        turnLaunch = adapterFor(session.engine).buildLaunch(session, text, launch);
      } catch (err) {
        const message = redact(err instanceof Error ? err.message : String(err), redactionsFor(launch, null));
        emit(id, { type: 'error', turnId, message });
        emit(id, { type: 'turn-done', turnId, ok: false, nativeSessionId: session.nativeSessionId, durationMs: 0 });
        session.status = 'error';
        session.lastError = message;
        save(session);
        return { turnId, session: cloneSession(session) };
      }
      startTurn(session, turnId, turnLaunch, redactionsFor(launch, turnLaunch));
      return { turnId, session: cloneSession(store.get(id) ?? session) };
    },

    cancelTurn(id: string): boolean {
      require(id);
      const turn = running.get(id);
      if (!turn || turn.settled) return false;
      requestTermination(id, turn, 'cancelled');
      return true;
    },

    deleteSession(id: string): void {
      require(id);
      const turn = running.get(id);
      if (turn && !turn.settled) {
        // Kill hard and settle synchronously so the files can go now.
        turn.termination = 'closed';
        signalGroup(turn, 'SIGKILL');
        finalize(id, turn, null);
      }
      listeners.delete(id);
      store.remove(id);
    },

    renameSession(id: string, title: string): VerseSession {
      const session = require(id);
      if (typeof title !== 'string') throw new VerseError('VERSE_INVALID', 'title must be a string');
      const normalised = normaliseTitle(title);
      if (!normalised) throw new VerseError('VERSE_INVALID', 'title must not be empty');
      session.title = normalised;
      save(session);
      return cloneSession(session);
    },

    subscribe(id: string, fromSeq: number, listener: (event: VerseEvent) => void): () => void {
      require(id);
      let subs = listeners.get(id);
      if (!subs) {
        subs = new Set();
        listeners.set(id, subs);
      }
      // Register before replay so nothing appended during replay is lost;
      // replay filters by seq so nothing is delivered twice.
      let replayed = 0;
      const live: VerseEvent[] = [];
      let replaying = true;
      const gate = (event: VerseEvent): void => {
        if (replaying) { live.push(event); return; }
        listener(event);
      };
      subs.add(gate);
      for (const event of store.readEvents(id, fromSeq)) {
        replayed = event.seq;
        listener(event);
      }
      replaying = false;
      for (const event of live) if (event.seq > replayed) listener(event);
      return () => {
        const current = listeners.get(id);
        if (!current) return;
        current.delete(gate);
        if (current.size === 0) listeners.delete(id);
      };
    },

    close(): void {
      closed = true;
      for (const [id, turn] of [...running.entries()]) {
        turn.termination = 'closed';
        signalGroup(turn, 'SIGKILL');
        finalize(id, turn, null);
      }
      listeners.clear();
    },
  };
}
