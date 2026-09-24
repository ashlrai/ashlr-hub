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
 *
 * CONTEXT (V3.9, docs/VERSE-CONTEXT.md). The engine is the one place a
 * session's context budget is decided and kept current:
 *   - at creation, from the seat's model option and the session's mode
 *     (`budgetFor`), recorded on `usage` with where the window came from;
 *   - on every reading, a window the CLI reports at runtime WINS over the
 *     catalog (a 1M Claude model the CLI clamps to 200k is a 200k session),
 *     and the compaction point is recomputed for it (`reconcileAutoCompactAt`);
 *   - `context` / `compaction` events replace occupancy and count compactions;
 *   - adapters that can only see exact occupancy in the CLI's own files
 *     (codex rollouts) get bounded telemetry hooks: polled while the turn
 *     runs, and called once after the parser has flushed.
 * None of this spends: it reads what the CLI already reported or wrote.
 *
 * LOCAL-ONLY. Because the spawn is raw rather than routed through
 * `run/engines.spawnEngine`, this module is a SECOND subprocess funnel and none
 * of the daemon's gates cover it. It therefore carries its own call to the one
 * shared predicate (`policy/local-only.decidePermission`, reached through its
 * published wrappers) at the top of `startTurn` — see `verseSeatPermitted` —
 * and (V3.10) re-asks it while a turn runs, so switching Local-only on stops a
 * vendor turn already in flight.
 *
 * RELIABILITY (V3.10, r2/reliability.md):
 *   - TRANSIENT events (thinking-delta, thinking-progress, progress, status)
 *     are fanned out to live listeners only, stamped with the last PERSISTED
 *     seq, and never reach the log (`emitTransient`).
 *   - At turn end the log is compacted: delta runs folded into what the
 *     transcript renders, whole turns archived past the cap (session-store).
 *   - Every storage write is contained: a failed append stops the turn with a
 *     `storage` error instead of throwing out of a stdout listener (which was
 *     an uncaught exception that took the whole server down).
 *   - Launched process groups are recorded in `running.json`; the next engine
 *     reaps the ones a crashed server left running (process-registry.ts).
 *   - A turn whose native conversation vanished (`native-thread-missing`) or
 *     whose native id is locked (`session-in-use`) is retried ONCE on a new
 *     native session seeded with the handoff note, recorded as `recovered`.
 *   - A no-output watchdog posts a `status` notice after 3 minutes of silence
 *     (the turn keeps running; Stop is the operator's call).
 *   - Local seats get a <100 ms endpoint preflight, so a dead Ollama fails the
 *     turn at once instead of spinning through the CLI's retry loop.
 *   - A readiness gate (account-health's `getSeatReadiness`) refuses a turn on
 *     a signed-out or exhausted seat with 409 + ranked alternatives.
 *   - Only PERSISTED events count as "the CLI engaged" (turnCount); a batch of
 *     transient retry/progress notices does not.
 *   - `onSessionChange` announces status/title/turnCount changes (turn start
 *     and end included) so the sidebar is pushed instead of polled.
 *   - `close` and `interruptAll` deliver pending reasoning taps and flush the
 *     reasoning store before the process goes away.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';

import { loadConfigReadOnly } from '../config.js';
import {
  endpointPermitted,
  enginePermitted,
  type LocalOnlyVerdict,
} from '../policy/local-only.js';
import type { AshlrConfig } from '../types.js';
import { scrubSecrets } from '../util/scrub.js';

import { classifyVerseCliError } from './adapters/claude.js';
import {
  adapterFor as defaultAdapterFor,
  VERSE_TELEMETRY_POLL_MS,
  type VerseAdapter,
  type VerseAdapterTurnContext,
  type VerseParsedEvent,
  type VerseTurnParser,
} from './adapters/index.js';
import {
  budgetFor,
  canonicalModelId,
  claudeAutoCompactAt,
  claudeAutocompactFlag,
  CODEX_EFFECTIVE_WINDOW_PERCENT,
  codexAutoCompactAt,
  grokAutoCompactAt,
  hasExpansiveMode,
  reconcileAutoCompactAt,
} from './context-math.js';
import type { SeatReadiness } from './health-types.js';
import { legacyModelOptionFallback } from './model-windows.js';
import {
  argvMarkers,
  createProcessRegistry,
  type ProcessRegistryOptions,
  type VerseProcessRegistry,
} from './process-registry.js';
import { stripUnsafeControlChars } from './project-memory.js';
import { buildHandoffPreview } from './session-handoff.js';
import { createVerseSessionStore, isVerseWindowSource, type VerseSessionStore } from './session-store.js';
import {
  isTransientVerseEvent,
  VERSE_CONTEXT_MODES,
  VERSE_DEFAULT_CONTEXT_WINDOWS,
  VERSE_ERROR_CODES,
  VERSE_MAX_TURN_TEXT_BYTES,
  VERSE_MAX_WORKSPACE_ROOTS,
  VERSE_TURN_TIMEOUT_MS,
  type VerseContextMode,
  type VerseCreateSessionRequest,
  type VerseEngine,
  type VerseErrorCode as VerseEventErrorCode,
  type VerseEvent,
  type VerseModelOption,
  type VerseRecoveryHow,
  type VerseSeat,
  type VerseSession,
  type VerseTurnLaunch,
  type VerseUsage,
  type VerseWindowSource,
} from './types.js';
import { appendVerseLog, type VerseLogLevel } from './verse-log.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type VerseErrorCode =
  | 'VERSE_SESSION_NOT_FOUND'
  | 'VERSE_SESSION_BUSY'
  | 'VERSE_INVALID'
  | 'VERSE_TOO_LARGE'
  /** V3.10. The seat's readiness gate refused the turn; `readiness` carries the alternatives. */
  | 'VERSE_SEAT_NOT_READY';

const VERSE_ERROR_STATUS: Record<VerseErrorCode, 404 | 409 | 400 | 413> = {
  VERSE_SESSION_NOT_FOUND: 404,
  VERSE_SESSION_BUSY: 409,
  VERSE_INVALID: 400,
  VERSE_TOO_LARGE: 413,
  VERSE_SEAT_NOT_READY: 409,
};

export class VerseError extends Error {
  readonly code: VerseErrorCode;
  readonly status: 404 | 409 | 400 | 413;
  /** Present only on VERSE_SEAT_NOT_READY. */
  readonly readiness?: SeatReadiness;

  constructor(code: VerseErrorCode, message: string, extra: { readiness?: SeatReadiness } = {}) {
    super(message);
    this.name = 'VerseError';
    this.code = code;
    this.status = VERSE_ERROR_STATUS[code];
    if (extra.readiness) this.readiness = extra.readiness;
  }
}

/**
 * V3.10. The HTTP answer for a readiness refusal, in the frozen
 * `SeatNotReadyResponse` shape (health-types.ts), for the API layer's error
 * mapper: `{ status: 409, body: { error, code: 'seat-not-ready', readiness } }`.
 * Null for any other error. Duck-typed like the API's own mapper, so an error
 * from another module instance still maps.
 */
export function seatNotReadyResponse(err: unknown): { status: 409; body: { error: string; code: 'seat-not-ready'; readiness: SeatReadiness } } | null {
  if (!isObject(err) && !(err instanceof Error)) return null;
  const e = err as { code?: unknown; message?: unknown; readiness?: unknown };
  if (e.code !== 'VERSE_SEAT_NOT_READY' || !isReadiness(e.readiness)) return null;
  return {
    status: 409,
    body: {
      error: typeof e.message === 'string' ? e.message : `seat ${e.readiness.seatId} is not ready`,
      code: 'seat-not-ready',
      readiness: e.readiness,
    },
  };
}

function isReadiness(value: unknown): value is SeatReadiness {
  return isObject(value)
    && typeof value['seatId'] === 'string'
    && typeof value['ready'] === 'boolean'
    && (value['reason'] === null || typeof value['reason'] === 'string')
    && Array.isArray(value['alternatives'])
    && value['alternatives'].every((alt) => typeof alt === 'string');
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
  /**
   * V3.9 ADDITIVE. Shared project memory offered to this session, SNAPSHOTTED
   * at creation: `dir` is the private memory directory, `block` the exact text
   * appended to the CLI's system prompt on EVERY turn. Pinned rather than
   * re-rendered per turn so the prompt prefix stays byte-identical and the
   * provider's prompt cache survives; agents read the live file from `dir`.
   * Absent = memory off for this session (and on every older record).
   */
  memory?: { dir: string; block: string; writable: boolean };
}

/** V3.9 — creation-time extras the API resolves (preferences, provenance); never read off a request body. */
export interface VerseCreateOptions {
  memory?: { dir: string; block: string; writable: boolean } | null;
  handoffFrom?: { sessionId: string; title: string } | null;
}

export interface VerseEngineHandle {
  listSessions(): VerseSession[];
  getSession(id: string): VerseSession | null;
  getEvents(id: string, fromSeq?: number): VerseEvent[];
  /**
   * `opts` carries what the API resolved server-side (memory snapshot, handoff
   * provenance). Omitted by every pre-3.9 caller, whose records then carry no
   * memory or handoff keys at all.
   */
  createSession(req: VerseCreateSessionRequest, launch: VerseSeatLaunch, opts?: VerseCreateOptions): VerseSession;
  sendTurn(id: string, text: string): { turnId: string; session: VerseSession };
  /**
   * V3.9. Switch the session's context budget. Takes effect from the NEXT turn
   * (it only changes CLI flags, never prompt content, so the cache survives).
   * Refused while a turn runs — that turn was launched with the old flags and
   * its readings must be measured against them — and for a mode the model has
   * no budget for.
   */
  setContextMode(id: string, mode: VerseContextMode): VerseSession;
  /**
   * V3.9. Re-read a LOCAL session's window from the seat's LIVE option (the
   * API calls this before each turn with the option discovery resolves now).
   *
   * Local windows are the runtime's allocation — the dispatch lane, the pinned
   * `num_ctx`, what `/api/ps` has resident — and change after a chat is
   * created; a pre-3.9 record may even hold a window the old discovery got
   * wrong (262,144 stored for a `-ctx64k` tag that serves 65,536). The CLI is
   * told `usage.contextWindow` (`CLAUDE_CODE_MAX_CONTEXT_TOKENS`) and the meter
   * draws the same field, so correcting it HERE, before the launch, keeps what
   * the CLI compacts against and what the operator sees one number.
   *
   * Writes (and emits one `context` event) only when window, compaction point
   * or source actually changed. A no-op for any other engine, and for an
   * option with no window. Refused while a turn runs (its CLI was launched
   * with the old window) and for an option naming a different model.
   */
  refreshLocalWindow(id: string, option: VerseModelOption): VerseSession;
  cancelTurn(id: string): boolean;
  deleteSession(id: string): void;
  renameSession(id: string, title: string): VerseSession;
  /**
   * Replays stored events with `seq > fromSeq`, then delivers live ones —
   * persisted AND transient (V3.10). A transient event carries the last
   * persisted seq and is never replayed. Returns the unsubscribe function.
   */
  subscribe(id: string, fromSeq: number, listener: (event: VerseEvent) => void): () => void;
  /** Kills running turns and drops listeners. */
  close(): void;
  /**
   * V3.10 crash path. SIGKILL every running turn's process group and settle
   * each turn SYNCHRONOUSLY as failed (`turn interrupted: <reason>`), so the
   * log and records are closed out before the process exits. Returns how many
   * turns were interrupted. The engine stays usable (unlike `close`).
   * Optional on the interface so test fakes and older handles still conform.
   */
  interruptAll?(reason: string): number;
}

/** V3.10. Result of the local-endpoint preflight. */
export type VersePreflightResult =
  | { ok: true; ms: number }
  /** The endpoint did not answer within the budget; the turn proceeds with a notice. */
  | { ok: 'slow'; ms: number }
  | { ok: false; ms: number; reason: string };

/** Errnos that prove nothing is listening; anything else (a timeout) is not proof. */
const PREFLIGHT_DEAD_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EAI_AGAIN']);
export const VERSE_PREFLIGHT_TIMEOUT_MS = 1_500;

/**
 * V3.10. Is anything listening at a local seat's dispatch address? A bare TCP
 * connect: it works for both lanes (Ollama and the llama-server proxy, which
 * share no HTTP route), costs < 1 ms on loopback, and sends nothing. Only a
 * definite refusal fails the turn — a slow answer is reported, not fatal.
 */
export function preflightLocalEndpoint(url: string, timeoutMs = VERSE_PREFLIGHT_TIMEOUT_MS): Promise<VersePreflightResult> {
  const started = Date.now();
  let host: string;
  let port: number;
  try {
    const parsed = new URL(url);
    host = parsed.hostname.replace(/^\[|\]$/g, '');
    port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return Promise.resolve({ ok: false, ms: 0, reason: 'the local endpoint address is not a valid URL' });
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: VersePreflightResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const socket = netConnect({ host, port });
    const timer = setTimeout(() => finish({ ok: 'slow', ms: Date.now() - started }), timeoutMs);
    socket.once('connect', () => finish({ ok: true, ms: Date.now() - started }));
    socket.once('error', (err: NodeJS.ErrnoException) => {
      const code = err.code ?? 'EUNKNOWN';
      finish(PREFLIGHT_DEAD_CODES.has(code)
        ? { ok: false, ms: Date.now() - started, reason: `nothing is listening at ${host}:${port} (${code})` }
        : { ok: 'slow', ms: Date.now() - started });
    });
  });
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
  /**
   * Read the operator config that the local-only gate consults.
   *
   * Called ONCE PER TURN rather than once at construction, deliberately: the
   * cockpit's Local-only switch writes `~/.ashlr/config.json` while this engine
   * is already live, and a mode read at startup would leave the switch looking
   * like it did nothing until a restart. `undefined` means "no config in hand",
   * which the policy answers from env + its process latch — i.e. toward refusal.
   *
   * Default: `loadConfigReadOnly()`, which never creates, seeds or writes the
   * file. The config is the user's; this module only ever reads it.
   */
  loadConfig?: () => AshlrConfig | undefined;
  /** Adapter resolver. Default: `adapters/index.adapterFor`. A test seam, like `spawn`. */
  adapterFor?: (engine: VerseEngine) => VerseAdapter;
  /** Telemetry poll interval for adapters with `pollTelemetry`. Default VERSE_TELEMETRY_POLL_MS. */
  telemetryPollMs?: number;
  /**
   * V3.10 readiness gate. `null` disables it. Default: account-health's
   * `getSeatReadiness` from seats.ts, resolved lazily (the gate is open until
   * it loads — an unknown readiness never refuses). Must be SYNCHRONOUS: the
   * refusal is the HTTP answer (409) to the turn request. A seat is refused
   * only on an explicit `ready: false`.
   */
  readiness?: ((seatId: string) => SeatReadiness | null | undefined) | null;
  /**
   * V3.10 local-seat endpoint preflight, run in parallel with the spawn; a
   * definite refusal stops the turn. `null` disables it. Default
   * `preflightLocalEndpoint`.
   */
  preflight?: ((url: string) => Promise<VersePreflightResult>) | null;
  /** V3.10 no-output watchdog threshold. Default 3 minutes. */
  watchdogMs?: number;
  /** V3.10 how often a running turn is checked (watchdog + live local-only). Default 30 s. */
  watchdogPollMs?: number;
  /** V3.10 orphan registry (`<root>/running.json`). `false` disables it. */
  processRegistry?: ProcessRegistryOptions | false;
  /**
   * V3.10 reasoning tap: called (deferred, in order, never inside the turn's
   * I/O path) with EVERY persisted event and a snapshot of its session — the
   * reasoning store needs the whole turn (user message, tool calls, outcome)
   * around each thinking block, not just the blocks. Transient events are
   * never tapped. `null` disables it. Default: the reasoning store's
   * `recordVerseReasoning` (core/reasoning/ingest-verse.ts), resolved lazily
   * — absent module = no tap.
   */
  reasoningTap?: ((event: VerseEvent, session: VerseSession) => void) | null;
  /**
   * V3.10 flush for the reasoning tap's write batches, called by `close()`
   * and `interruptAll()` after every tap still pending has been delivered.
   * The reasoning store batches live steps (250 ms / 64 steps), so without
   * this a crash or shutdown drops the tail of the last turn's reasoning —
   * exactly the turn that was running when things went wrong. `null`
   * disables it. Default: the reasoning store's `flushVerseReasoning`,
   * resolved lazily with the default tap (only when `reasoningTap` is left
   * undefined — an injected tap brings its own flush or none).
   */
  reasoningFlush?: (() => void) | null;
  /**
   * V3.10 session-list hook: called with the session id whenever a session's
   * status, title or turn count changes, and when a session is created or
   * deleted — the fields the sidebar lists. Turn start and end happen inside
   * the engine with no HTTP request to mark them, so without this the sidebar
   * learns of them only on the next /api/events poll tick. Called
   * synchronously from the write path: it must be cheap and must not throw
   * (a throw is logged and swallowed). Default: none.
   */
  onSessionChange?: ((sessionId: string) => void) | null;
  /** V3.10 retry a turn once on a new native session when the old one is lost. Default true. */
  recoverNativeThreads?: boolean;
  /** V3.10 diagnostic sink. Default: `<root>/verse.log` (verse-log.ts). */
  log?: (level: VerseLogLevel, message: string) => void;
}

// ---------------------------------------------------------------------------
// Local-only
// ---------------------------------------------------------------------------

/**
 * Is this SEAT permitted to run a turn right now?
 *
 * NOT a second policy predicate — that is the point. Both branches delegate to
 * `decidePermission()` through its published wrappers, so "local" means here
 * exactly what it means at the daemon's chokepoints. This function contributes
 * only the mapping from a Verse seat to a subject the predicate understands:
 *
 *   claude / codex / grok — a Verse engine id IS the registry engine id, so
 *     `enginePermitted` classifies it directly (cli-agent → cloud for claude and
 *     codex, api-model at api.x.ai → cloud for grok).
 *
 *   local — a local seat is discovered from a serving runtime and has no
 *     registry engine to name, so the ENDPOINT it dispatches to is the truth
 *     and `endpointPermitted` classifies that. A loopback runtime (the default,
 *     and every local seat today) is permitted exactly as before. One repointed
 *     at a remote inference host is refused, because that one would spend — the
 *     same rule the raw-transport sites apply to `cfg.foundry.ollamaBaseUrl`.
 */
export function verseSeatPermitted(
  engine: VerseEngine,
  launch: VerseSeatLaunch,
  cfg: AshlrConfig | undefined,
): LocalOnlyVerdict {
  if (engine === 'local') {
    const dispatchUrl = launch.anthropicBaseUrl?.trim() || launch.ollamaBaseUrl;
    return endpointPermitted(dispatchUrl, cfg);
  }
  return enginePermitted(engine, cfg);
}

/** Read the live config for the gate. A config we cannot read is not an excuse to dispatch. */
function readConfigForPolicy(): AshlrConfig | undefined {
  try {
    return loadConfigReadOnly();
  } catch {
    // undefined → the policy falls back to env + latch, which errs toward refusal.
    return undefined;
  }
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
const DEFAULT_WATCHDOG_MS = 3 * 60_000;
const DEFAULT_WATCHDOG_POLL_MS = 30_000;
/** Module the default reasoning tap is loaded from (A7). A variable, so a missing module is a runtime miss, not a build error. */
const REASONING_INGEST_MODULE = '../reasoning/ingest-verse.js';

/**
 * Fallback classification of vendor failure text, for when the adapter did
 * not set `error.code` itself (and for a stderr-only failure — claude's
 * "already in use" never reaches stdout, so no parser can see it).
 *
 * DELEGATES to the adapters' `classifyVerseCliError` (adapters/claude.ts)
 * rather than keeping a second phrase list here: the two lists had already
 * drifted — grok's "No session found with id …" was recognised by the
 * adapters but not by this fallback, so a grok thread lost between turns
 * failed for good instead of recovering on a new native session. One list,
 * captured from the real binaries, is the only way the engine and the
 * parsers agree on what is recoverable.
 */
export function classifyVerseFailure(text: string): VerseEventErrorCode | null {
  return classifyVerseCliError(text);
}

function knownErrorCode(value: unknown): VerseEventErrorCode | null {
  return typeof value === 'string' && (VERSE_ERROR_CODES as readonly string[]).includes(value)
    ? value as VerseEventErrorCode
    : null;
}

/**
 * Why the ENGINE ended a turn. `cancelled`/`closed` are Stop (not failures);
 * the rest are failures with an engine-authored message:
 *   timeout      the wall-clock limit;
 *   policy       Local-only was switched on while a vendor turn ran;
 *   storage      the session log could not be written;
 *   interrupted  the server is going down (crash handler);
 *   preflight    a local seat's endpoint refused the connection.
 */
type TerminationReason = 'cancelled' | 'timeout' | 'closed' | 'policy' | 'storage' | 'interrupted' | 'preflight';

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
  adapter: VerseAdapter;
  /** The model option whose budgets govern this turn's readings (see `effectiveModelOption`). */
  option: VerseModelOption | null;
  /** Context handed to the adapter's telemetry hooks; `state` persists across calls. */
  hookCtx: VerseAdapterTurnContext;
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
  pollTimer: ReturnType<typeof setInterval> | null;
  /** V3.10 watchdog + live local-only check. */
  watchTimer: ReturnType<typeof setInterval> | null;
  /** Epoch ms of the last stdout/stderr byte. */
  lastOutputAt: number;
  /** The watchdog already warned about the current silence. */
  watchdogWarned: boolean;
  /** The failure the CLI reported that a new native session can fix. */
  recoverable: VerseEventErrorCode | null;
  /** The seat launch this turn was started from (live local-only re-check, recovery). */
  seatLaunch: VerseSeatLaunch;
  /** The operator's text for this turn (a recovery re-sends it). */
  text: string;
  /** Seq of this turn's `user-message` (events before it seed a recovery's handoff). */
  userSeq: number;
  /** This attempt IS the one recovery; it never recovers again. */
  isRecovery: boolean;
  /** Engine-authored failure text for policy / storage / interrupted terminations. */
  terminationMessage: string | null;
}


function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Upper bound on a memory block accepted into a launch record. The block U5
 * renders is ≤ 6 KB; this is a sanity cap so a malformed caller cannot pin an
 * arbitrarily large string into every turn's system prompt.
 */
const MEMORY_BLOCK_MAX_BYTES = 16 * 1024;

type SessionMemory = NonNullable<VerseSeatLaunch['memory']>;

function isSessionMemory(value: unknown): value is SessionMemory {
  return isObject(value)
    && typeof value['dir'] === 'string' && value['dir'].length > 0 && isAbsolute(value['dir'])
    && typeof value['block'] === 'string'
    && Buffer.byteLength(value['block'], 'utf8') <= MEMORY_BLOCK_MAX_BYTES
    && typeof value['writable'] === 'boolean';
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
    && (value['anthropicBaseUrl'] === undefined || typeof value['anthropicBaseUrl'] === 'string')
    // Absent is valid (memory off, or a pre-3.9 record). PRESENT but malformed
    // is not: a half-formed memory snapshot would feed a bogus `--add-dir`.
    && (value['memory'] === undefined || isSessionMemory(value['memory']));
}

function cloneSession(session: VerseSession): VerseSession {
  return {
    ...session,
    usage: { ...session.usage },
    ...(session.handoffFrom ? { handoffFrom: { ...session.handoffFrom } } : {}),
  };
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

// ---- context budgets (V3.9) -------------------------------------------------

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/** A counter delta from an adapter; anything non-numeric counts as zero rather than poisoning a total. */
function tokenDelta(value: unknown): number {
  return nonNegativeInt(value) ?? 0;
}

function isContextMode(value: unknown): value is VerseContextMode {
  return typeof value === 'string' && (VERSE_CONTEXT_MODES as readonly string[]).includes(value);
}

/**
 * The seat's option for a session model: exact id first, then by canonical id
 * so a request (or record) naming the retired alias `claude-opus-5.5` finds a
 * seat that lists `claude-opus-5-5`, and vice versa.
 */
function findModelOption(seat: VerseSeat, model: string): VerseModelOption | null {
  const exact = seat.models.find((m) => m.id === model);
  if (exact) return exact;
  const wanted = canonicalModelId(model);
  return seat.models.find((m) => canonicalModelId(m.id) === wanted) ?? null;
}

/**
 * The option whose budgets govern a session's readings.
 *
 * Normally the seat's own option. The exception is a launch snapshot written
 * before 3.9: its options carry one flat window and no budgets, yet the live
 * seat the web UI reads (and the claude/codex adapters, which build the CLI
 * flags) take that model's budgets from the documented builders in
 * model-windows.ts. `legacyModelOptionFallback` is that ONE rule, shared with
 * the adapters, so the mode the UI offers is the mode this engine accepts and
 * the compaction point recorded is the one the CLI was told — two sources of
 * truth for one flag would drift (it did: a 3.8 codex chat was offered
 * Expansive and then refused it with a 400).
 *
 * Local snapshots are left as they are: a local window is the runtime's
 * allocation, which `refreshLocalWindow` re-reads from live discovery.
 */
function effectiveModelOption(seat: VerseSeat, model: string, engine: VerseEngine): VerseModelOption | null {
  return legacyModelOptionFallback(engine, model, findModelOption(seat, model));
}

/**
 * The compaction point each CLI itself uses for a window Verse only knows as
 * a named default. Applied ONLY to `VERSE_DEFAULT_CONTEXT_WINDOWS`, which are
 * the very figures those CLIs assume for an unknown model — so the formula
 * over them is still the CLI's, not a guess of ours.
 */
function defaultWindowAutoCompactAt(engine: VerseEngine, window: number, maxOutputTokens: number | null): number | null {
  switch (engine) {
    case 'claude':
    case 'local':
      return claudeAutoCompactAt(window, maxOutputTokens);
    case 'codex':
      return codexAutoCompactAt(Math.round((window * 100) / CODEX_EFFECTIVE_WINDOW_PERCENT));
    case 'grok':
      return grokAutoCompactAt(window);
    default:
      return null;
  }
}

interface SessionBudget {
  contextWindow: number | null;
  autoCompactAt: number | null;
  source: VerseWindowSource;
}

/**
 * A session's budget in a mode: the model option's budget (`budgetFor`), else
 * the seat's default-model window, else the engine's named default. Only the
 * option path carries a real source; everything past it is `fallback`, which
 * the UI draws as an estimate.
 */
function sessionBudgetFor(
  seat: VerseSeat,
  option: VerseModelOption | null,
  mode: VerseContextMode,
  engine: VerseEngine,
): SessionBudget {
  const budget = budgetFor(option, mode);
  if (budget) {
    return {
      contextWindow: budget.contextWindow,
      autoCompactAt: budget.autoCompactAt,
      source: option?.windowSource ?? 'fallback',
    };
  }
  // A seat-level window is the DEFAULT model's; it says nothing about this
  // model's compaction point, so none is claimed.
  const seatWindow = positiveInt(seat.contextWindow);
  if (seatWindow !== null) return { contextWindow: seatWindow, autoCompactAt: null, source: 'fallback' };
  const fallback = positiveInt(VERSE_DEFAULT_CONTEXT_WINDOWS[engine]);
  if (fallback === null) return { contextWindow: null, autoCompactAt: null, source: 'fallback' };
  return {
    contextWindow: fallback,
    autoCompactAt: defaultWindowAutoCompactAt(engine, fallback, option?.maxOutputTokens ?? null),
    source: 'fallback',
  };
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
  const loadCfg = opts.loadConfig ?? readConfigForPolicy;
  const adapterFor = opts.adapterFor ?? defaultAdapterFor;
  const telemetryPollMs = positiveInt(opts.telemetryPollMs) ?? VERSE_TELEMETRY_POLL_MS;
  const watchdogMs = positiveInt(opts.watchdogMs) ?? DEFAULT_WATCHDOG_MS;
  const watchdogPollMs = positiveInt(opts.watchdogPollMs) ?? DEFAULT_WATCHDOG_POLL_MS;
  const recoverNativeThreads = opts.recoverNativeThreads !== false;
  const preflight = opts.preflight === undefined ? preflightLocalEndpoint : opts.preflight;
  const log = opts.log ?? ((level: VerseLogLevel, message: string): void => { appendVerseLog(level, message, { root }); });
  const store: VerseSessionStore = createVerseSessionStore(root);
  const running = new Map<string, RunningTurn>();
  const listeners = new Map<string, Set<(event: VerseEvent) => void>>();
  /** Sessions whose log write already failed this turn (one notice, not one per event). */
  const storageFailed = new Set<string>();
  /** Reasoning taps waiting for the next drain (see `tapReasoning`). */
  const pendingTaps: Array<() => void> = [];
  let tapDrainScheduled = false;
  /**
   * The last `status|title|turnCount` each session was announced with (see
   * `noteListing`), so the list hook fires on a change the sidebar can show
   * and not on every usage reading that also saves the record.
   */
  const listingKeys = new Map<string, string>();
  let closed = false;

  // ---- lazily-bound collaborators (V3.10) ----------------------------------
  //
  // Both live in modules built by other units and loaded at runtime, so this
  // engine never has a hard import edge on them: account health (seats.ts)
  // and the reasoning store. Until they resolve, the gate is open and the tap
  // is off — neither may ever block or fail a turn.
  let readiness: ((seatId: string) => unknown) | null = opts.readiness ?? null;
  if (opts.readiness === undefined) {
    void import('./seats.js')
      .then((mod) => {
        const fn = (mod as unknown as Record<string, unknown>)['getSeatReadiness'];
        if (typeof fn === 'function' && readiness === null) readiness = fn as (seatId: string) => unknown;
      })
      .catch(() => { /* no account health: the gate stays open */ });
  }
  let reasoningTap: ((event: VerseEvent, session: VerseSession) => void) | null = opts.reasoningTap ?? null;
  let reasoningFlush: (() => void) | null = opts.reasoningFlush ?? null;
  if (opts.reasoningTap === undefined) {
    const specifier: string = REASONING_INGEST_MODULE;
    void (import(specifier) as Promise<unknown>)
      .then((mod) => {
        const fn = isObject(mod) ? mod['recordVerseReasoning'] : undefined;
        if (typeof fn === 'function' && reasoningTap === null) reasoningTap = fn as (event: VerseEvent, session: VerseSession) => void;
        const flush = isObject(mod) ? mod['flushVerseReasoning'] : undefined;
        if (opts.reasoningFlush === undefined && typeof flush === 'function' && reasoningFlush === null) {
          reasoningFlush = flush as () => void;
        }
      })
      .catch(() => { /* reasoning store not present: no tap */ });
  }
  const onSessionChange = opts.onSessionChange ?? null;

  const registry: VerseProcessRegistry | null = opts.processRegistry === false
    ? null
    : createProcessRegistry(root, { log, ...(opts.processRegistry ?? {}) });

  function nowIso(): string {
    return now().toISOString();
  }

  function require(id: string): VerseSession {
    if (typeof id !== 'string') throw new VerseError('VERSE_SESSION_NOT_FOUND', 'session not found');
    const session = store.get(id);
    if (!session) throw new VerseError('VERSE_SESSION_NOT_FOUND', `session not found: ${id}`);
    materializeLegacyMode(session);
    return session;
  }

  /**
   * A CLAUDE record written before 3.9 has no `contextMode` and no
   * `usage.contextWindowSource` (neither key existed). 3.8 launched it with no
   * `--autocompact`, so on a 1M model the CLI ran its native window and
   * compacted near 967k. Reading "absent" as `standard` would start passing
   * `--autocompact 400000` on the first turn after the upgrade — and a chat
   * already holding 400k–967k would be compacted by the CLI before it answered:
   * an unrequested, paid summarisation of the whole context, with nothing on
   * screen to warn about it (3.8 stored occupancy CLAMPED at its 200k catalog
   * window, so the meter could not know either).
   *
   * So such a record keeps what it had: `expansive` (the CLI's `auto`) when its
   * model has an expansive budget, with that budget recorded on `usage` so the
   * meter draws the compaction point the CLI will actually use. It is written
   * to disk ONCE, the first time the session is touched (engine load, get,
   * list, a turn, a mode switch) — from then on it is an ordinary expansive
   * session the operator can switch to standard like any other.
   *
   * Left alone: a model with no expansive budget (a 200k model's standard IS
   * the CLI's `auto`), codex/grok/local (their standard is their native
   * behaviour), a record that already names a mode, and a record carrying a
   * window source (written by 3.9 code, which knew what it chose). The stored
   * occupancy is NOT touched: it may be 3.8's clamped figure, but the first
   * turn's reading replaces it, and with the native compaction point restored
   * nothing compacts that would not have under 3.8.
   *
   * Written with `store.save`, not `save`: a migration is not activity, and
   * bumping `updatedAt` would reorder every old chat to the top of the list.
   */
  function materializeLegacyMode(session: VerseSession): void {
    if (session.engine !== 'claude' || session.contextMode !== undefined) return;
    if (!isObject(session.usage) || session.usage.contextWindowSource !== undefined) return;
    const launch = store.loadLaunch(session.id);
    if (!isSeatLaunch(launch)) return;
    const option = effectiveModelOption(launch.seat, session.model, session.engine);
    if (!hasExpansiveMode(option)) return;
    const budget = sessionBudgetFor(launch.seat, option, 'expansive', session.engine);
    session.contextMode = 'expansive';
    session.usage.contextWindow = budget.contextWindow;
    session.usage.contextWindowSource = budget.source;
    session.usage.autoCompactAt = budget.autoCompactAt;
    store.save(session);
  }

  /**
   * Handoff provenance. The API hands the resolved source in `opts`; a bare
   * `req.handoffFromSessionId` is accepted too. Either way the SOURCE RECORD
   * in this store is the authority for the title — never a caller's string —
   * and a source that does not exist is refused rather than pinned.
   */
  function resolveHandoffSource(
    req: VerseCreateSessionRequest,
    opts: VerseCreateOptions,
  ): { sessionId: string; title: string } | null {
    const fromOpts = opts.handoffFrom;
    if (fromOpts !== undefined && fromOpts !== null
      && !(isObject(fromOpts) && typeof fromOpts.sessionId === 'string' && typeof fromOpts.title === 'string')) {
      throw new VerseError('VERSE_INVALID', 'handoff source is malformed');
    }
    const fromReq = req.handoffFromSessionId;
    if (fromReq !== undefined && typeof fromReq !== 'string') {
      throw new VerseError('VERSE_INVALID', 'handoffFromSessionId must be a string');
    }
    const optsId = fromOpts ? fromOpts.sessionId : undefined;
    if (optsId !== undefined && fromReq !== undefined && optsId !== fromReq) {
      throw new VerseError('VERSE_INVALID', 'handoff source does not match handoffFromSessionId');
    }
    const sourceId = optsId ?? fromReq;
    if (sourceId === undefined) return null;
    const source = store.get(sourceId);
    if (!source) throw new VerseError('VERSE_INVALID', `handoff source session not found: ${sourceId}`);
    return { sessionId: source.id, title: source.title };
  }

  function fanOut(id: string, event: VerseEvent): void {
    const subs = listeners.get(id);
    if (!subs) return;
    for (const listener of [...subs]) {
      try { listener(event); } catch { /* a bad listener never breaks the turn */ }
    }
  }

  /**
   * Live-only delivery. The seq is the last PERSISTED one (the counter does
   * not move), so the stored log stays the single source of seqs and a
   * restart can never reissue a seq a client already saw; verse-stream omits
   * the SSE `id:` line for these, so a resume cursor never points at one.
   */
  function emitTransient(id: string, event: VerseParsedEvent): void {
    if (!listeners.get(id)?.size) return;
    let seq = 0;
    try { seq = store.lastSeq(id); } catch { seq = 0; }
    fanOut(id, { ...event, seq, at: nowIso() } as VerseEvent);
  }

  /**
   * Persist + fan out. Returns null when the event was transient (delivered
   * live only) or could not be written — a storage failure is CONTAINED here:
   * it is reported, the running turn is stopped, and nothing is thrown into
   * the stdout listener / timer that called us.
   */
  function emit(id: string, event: VerseParsedEvent): VerseEvent | null {
    if (isTransientVerseEvent(event as VerseEvent)) {
      emitTransient(id, event);
      return null;
    }
    let stored: VerseEvent;
    try {
      stored = store.appendEvent(id, event, nowIso());
    } catch (err) {
      onStorageFailure(id, err, event);
      return null;
    }
    fanOut(id, stored);
    if (reasoningTap) tapReasoning(id, stored);
    return stored;
  }

  function tapReasoning(id: string, event: VerseEvent): void {
    const tap = reasoningTap;
    const session = store.get(id);
    if (!tap || !session) return;
    const snapshot = cloneSession(session);
    // Deferred: the reasoning store does its own file I/O and must never add
    // latency to (or throw into) the turn's stdout path. QUEUED (one drain per
    // tick, in order) rather than one setImmediate per event, so the crash and
    // shutdown paths can deliver what is still pending SYNCHRONOUSLY
    // (`drainReasoningTaps`) — a process about to exit never reaches the next
    // tick, and the turn it interrupts is the one worth keeping.
    pendingTaps.push(() => {
      try { tap(event, snapshot); } catch (err) {
        log('warn', `reasoning tap failed for session ${id}: ${errorCode(err) || (err instanceof Error ? err.name : 'error')}`);
      }
    });
    if (!tapDrainScheduled) {
      tapDrainScheduled = true;
      setImmediate(drainReasoningTaps);
    }
  }

  function drainReasoningTaps(): void {
    tapDrainScheduled = false;
    // Spliced first: a tap that (indirectly) queues another is delivered on
    // the next drain, never re-entrantly inside this loop.
    for (const run of pendingTaps.splice(0)) run();
  }

  /**
   * Deliver every queued tap, then flush the reasoning store's own batches.
   * Crash/shutdown only; never throws (the process is on its way out).
   */
  function flushReasoning(): void {
    try { drainReasoningTaps(); } catch { /* each tap already guards itself */ }
    const flush = reasoningFlush;
    if (!flush) return;
    try { flush(); } catch (err) {
      log('warn', `reasoning flush failed: ${errorCode(err) || (err instanceof Error ? err.name : 'error')}`);
    }
  }

  function onStorageFailure(id: string, err: unknown, event: VerseParsedEvent): void {
    const code = errorCode(err) || 'EIO';
    const message = `storage error (${code}): this session's log could not be written, so the turn was stopped`;
    if (storageFailed.has(id)) return;
    storageFailed.add(id);
    log('error', `session ${id}: event log write failed (${code}) on a ${event.type} event; stopping its turn`);
    const session = store.get(id);
    if (session) {
      session.status = 'error';
      session.lastError = message;
      try { store.save(session); } catch { /* the same disk; the in-memory record still says error */ }
      noteListing(session);
    }
    // Live-only notice (it could not be stored). Carries the last persisted
    // seq, like a transient event, so it never becomes a resume cursor.
    let seq = 0;
    try { seq = store.lastSeq(id); } catch { seq = 0; }
    const turnId = 'turnId' in event && typeof event.turnId === 'string' ? event.turnId : null;
    fanOut(id, { seq, at: nowIso(), type: 'error', turnId, message, code: 'storage' });
    const turn = running.get(id);
    if (turn && !turn.settled && turn.termination === null) {
      turn.terminationMessage = message;
      requestTermination(id, turn, 'storage');
    }
  }

  /**
   * Write the record. A failure is logged, not thrown: the in-memory record
   * (which every read serves) is already updated, and throwing here would
   * escape from a child-process `close` handler as an uncaught exception.
   */
  function save(session: VerseSession): VerseSession {
    session.updatedAt = nowIso();
    try {
      store.save(session);
    } catch (err) {
      log('error', `session ${session.id}: record write failed (${errorCode(err) || 'EIO'})`);
    }
    // Announced even when the write failed: every read serves the in-memory
    // record, so that is what the sidebar will show.
    noteListing(session);
    return session;
  }

  /**
   * Fire `onSessionChange` when a field the session list shows (status,
   * title, turn count) differs from what was last announced. Usage and
   * context readings save the record many times per turn; announcing each
   * would push the whole list to every open tab for nothing. A session's
   * first save in this process always announces (nothing to compare with),
   * which costs at most one extra coalesced push.
   */
  function noteListing(session: VerseSession): void {
    if (!onSessionChange) return;
    const key = `${session.status}\u0000${session.title}\u0000${session.turnCount}`;
    if (listingKeys.get(session.id) === key) return;
    listingKeys.set(session.id, key);
    announce(session.id);
  }

  function announce(id: string): void {
    const hook = onSessionChange;
    if (!hook) return;
    try { hook(id); } catch (err) {
      log('warn', `session-change hook failed for session ${id}: ${errorCode(err) || (err instanceof Error ? err.name : 'error')}`);
    }
  }

  /** Fold / cap the log after a turn settles. Best effort; the log is untouched on failure. */
  function compactLog(id: string): void {
    try {
      const result = store.compactEvents(id);
      if (result.archived > 0) {
        log('info', `session ${id}: event log passed its cap; ${result.archived} events of whole turns moved to the archive`);
      }
    } catch (err) {
      log('warn', `session ${id}: event log compaction failed (${errorCode(err) || 'EIO'}); the log is unchanged`);
    }
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
    compactLog(session.id);
  }

  // Orphans FIRST: a turn's process group a dead server left behind is
  // stopped before its session is settled as interrupted.
  if (registry) {
    try {
      registry.reapOrphans();
    } catch (err) {
      log('error', `orphan reaping failed: ${errorCode(err) || (err instanceof Error ? err.name : 'error')}`);
    }
  }

  for (const session of store.list()) {
    materializeLegacyMode(session);
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
    if (turn.pollTimer !== null) clearInterval(turn.pollTimer);
    turn.pollTimer = null;
    if (turn.watchTimer !== null) clearInterval(turn.watchTimer);
    turn.watchTimer = null;
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

  /**
   * A window the CLI reported for this call WINS over the catalog: Claude Code
   * clamps a 1M model to 200k when long-context credit runs out, and codex
   * measures against whatever `model_context_window` it was launched with.
   * The compaction point is recomputed for the window actually in force, with
   * the `--autocompact` value this seat's adapter passes for the mode.
   *
   * LOCAL is exempt: Verse TELLS that CLI its window
   * (`CLAUDE_CODE_MAX_CONTEXT_TOKENS`), so the figure it echoes back is ours,
   * and the CLI's own guess for an unknown model id (200k) would be wrong.
   */
  function applyRuntimeWindow(session: VerseSession, option: VerseModelOption | null, reported: unknown): void {
    if (session.engine === 'local') return;
    const runtimeWindow = positiveInt(reported);
    if (runtimeWindow === null) return;
    const mode = session.contextMode ?? 'standard';
    session.usage.contextWindow = runtimeWindow;
    session.usage.contextWindowSource = 'runtime';
    session.usage.autoCompactAt = reconcileAutoCompactAt({
      engine: session.engine,
      runtimeWindow,
      budget: budgetFor(option, mode),
      autocompactWindow: session.engine === 'claude' ? claudeAutocompactFlag(option, mode) : null,
      maxOutputTokens: option?.maxOutputTokens ?? null,
    });
  }

  /**
   * One `context` event after the budget changed BETWEEN turns (a mode switch,
   * a local window refreshed from discovery), so every open client redraws the
   * meter against it; occupancy itself is unchanged. It names the budget's
   * source: a catalog figure must never be drawn as a CLI measurement.
   */
  function emitBudgetChange(id: string, session: VerseSession): void {
    emit(id, {
      type: 'context',
      turnId: null,
      contextTokens: Math.max(0, Math.floor(session.usage.contextTokens || 0)),
      contextWindow: session.usage.contextWindow,
      exact: session.usage.contextTokensExact !== false,
      autoCompactAt: session.usage.autoCompactAt ?? null,
      ...(session.usage.contextWindowSource !== undefined
        ? { contextWindowSource: session.usage.contextWindowSource }
        : {}),
    });
  }

  /** Absent means exact, so an exact reading REMOVES the flag rather than writing `true`. */
  function setExactness(usage: VerseUsage, exact: boolean): void {
    if (exact) delete usage.contextTokensExact;
    else usage.contextTokensExact = false;
  }

  /** The optional V3.9 usage keys, copied only when the session record has them. */
  function contextFields(usage: VerseUsage): Pick<VerseUsage, 'contextWindowSource' | 'autoCompactAt' | 'contextTokensExact'> {
    return {
      ...(usage.contextWindowSource !== undefined ? { contextWindowSource: usage.contextWindowSource } : {}),
      ...(usage.autoCompactAt !== undefined ? { autoCompactAt: usage.autoCompactAt } : {}),
      ...(usage.contextTokensExact === false ? { contextTokensExact: false } : {}),
    };
  }

  /**
   * Fold one parsed event into the session and return the event as it is to
   * be stored — or null to drop it (a malformed context reading must never
   * reach the log, where the store would skip it on read and the seq it took
   * would be reused after a restart).
   *
   *  usage      — counters are summed; `contextTokens` is REPLACED and stored
   *               UNCLAMPED (a reading past the window is information: the CLI
   *               is about to compact or overflow; only the UI decides how to
   *               draw it). The stored event carries the window in force and,
   *               when the session has resolved them, its window source,
   *               compaction point and (only when false) exactness — so a
   *               client redraws the meter from the frame alone instead of
   *               waiting for a session refresh.
   *               A ZERO-COUNT frame is still a reading: a manual `/compact`
   *               turn makes no model call (`result.usage` is all zeros) and
   *               its `contextTokens` is the CLI's post-compaction size, which
   *               must replace the pre-compaction occupancy. Only a frame with
   *               NO numeric `contextTokens` leaves occupancy as it was — that
   *               is "no reading", and zero would be an invented one.
   *  context    — a non-summed occupancy reading (codex rollout). Replaces
   *               `contextTokens`; the engine fills `autoCompactAt`.
   *  compaction — counted on the session; counts normalised to number|null.
   *
   * Every telemetry type is rebuilt from its known fields rather than spread:
   * a stray key from an adapter (or a value JSON cannot encode) never reaches
   * the durable log, where a failed `JSON.stringify` inside a poll timer would
   * be an uncaught exception.
   */
  function applyUsage(
    session: VerseSession,
    option: VerseModelOption | null,
    event: VerseParsedEvent,
    fallbackTurnId: string,
  ): VerseParsedEvent | null {
    switch (event.type) {
      case 'usage': {
        const reported = isObject(event.usage) ? event.usage : ({} as Partial<VerseUsage>);
        applyRuntimeWindow(session, option, reported.contextWindow);
        const previous = session.usage;
        const reading = nonNegativeInt(reported.contextTokens);
        const next: VerseUsage = {
          inputTokens: previous.inputTokens + tokenDelta(reported.inputTokens),
          outputTokens: previous.outputTokens + tokenDelta(reported.outputTokens),
          cacheReadTokens: previous.cacheReadTokens + tokenDelta(reported.cacheReadTokens),
          cacheCreationTokens: previous.cacheCreationTokens + tokenDelta(reported.cacheCreationTokens),
          contextTokens: reading ?? previous.contextTokens,
          contextWindow: previous.contextWindow,
          ...contextFields(previous),
        };
        // Exactness describes a reading; with none, the previous one's stands.
        if (reading !== null) setExactness(next, reported.contextTokensExact !== false);
        session.usage = next;
        return {
          type: 'usage',
          turnId: typeof event.turnId === 'string' ? event.turnId : fallbackTurnId,
          usage: {
            inputTokens: tokenDelta(reported.inputTokens),
            outputTokens: tokenDelta(reported.outputTokens),
            cacheReadTokens: tokenDelta(reported.cacheReadTokens),
            cacheCreationTokens: tokenDelta(reported.cacheCreationTokens),
            contextTokens: next.contextTokens,
            contextWindow: next.contextWindow,
            ...contextFields(next),
          },
        };
      }
      case 'context': {
        const tokens = nonNegativeInt(event.contextTokens);
        if (tokens === null) return null;
        applyRuntimeWindow(session, option, event.contextWindow);
        const exact = event.exact !== false;
        session.usage.contextTokens = tokens;
        setExactness(session.usage, exact);
        return {
          type: 'context',
          turnId: typeof event.turnId === 'string' ? event.turnId : null,
          contextTokens: tokens,
          // The window IN FORCE, never null when the session knows one: a
          // client that replaces its window from this event must not lose it
          // because the adapter had no window to report.
          contextWindow: session.usage.contextWindow,
          exact,
          autoCompactAt: session.usage.autoCompactAt ?? null,
          // ...and WHERE that window came from. When the adapter reported
          // none, the window in force is still the catalog's, and a client
          // must not relabel it as a CLI measurement.
          ...(session.usage.contextWindowSource !== undefined
            ? { contextWindowSource: session.usage.contextWindowSource }
            : {}),
        };
      }
      case 'compaction': {
        session.compactionCount = (session.compactionCount ?? 0) + 1;
        return {
          type: 'compaction',
          turnId: typeof event.turnId === 'string' ? event.turnId : null,
          trigger: event.trigger === 'manual' ? 'manual' : 'auto',
          preTokens: nonNegativeInt(event.preTokens),
          postTokens: nonNegativeInt(event.postTokens),
          durationMs: nonNegativeInt(event.durationMs),
        };
      }
      default:
        return event;
    }
  }

  /** Event types whose application changes the session record. */
  const SESSION_MUTATING_EVENTS = new Set<VerseEvent['type']>(['usage', 'context', 'compaction']);

  /**
   * Telemetry hooks may only contribute readings. An `error` or `turn-done`
   * from a hook would let a best-effort file read decide whether a turn
   * failed, which only the CLI's own output and exit code may do.
   */
  const TELEMETRY_EVENTS = new Set<VerseEvent['type']>(['usage', 'context', 'compaction']);

  /**
   * `untilSettled` (the live poll): stop as soon as the turn settles. `emit`
   * runs subscriber callbacks synchronously, so a subscriber that stops or
   * deletes the session can settle the turn in the middle of this loop; the
   * rest of a poll's readings would then land AFTER `turn-done`. The parser's
   * final flush and `afterTurn` deliberately run while settled, so they omit it.
   */
  function applyEvents(
    id: string,
    turn: RunningTurn,
    events: VerseParsedEvent[],
    untilSettled = false,
    countsAsOutput = false,
  ): void {
    const session = store.get(id);
    // No record, no events: appending would re-create the log of a session
    // that is gone, and `save` its record — a deleted chat back as an orphan.
    if (!session) return;
    for (let event of events) {
      if (untilSettled && turn.settled) return;
      if (isTransientVerseEvent(event as VerseEvent)) {
        emitTransient(id, event);
        continue;
      }
      if (event.type === 'error') {
        turn.sawError = true;
        // The adapter's code wins; otherwise recognise the CLI's own phrase,
        // and stamp the code on the stored event so the UI can act on it.
        const code = knownErrorCode(event.code) ?? classifyVerseFailure(event.message);
        if (code) {
          turn.recoverable = code;
          if (event.code !== code) event = { ...event, code };
        }
      }
      const enriched = applyUsage(session, turn.option, event, turn.turnId);
      if (enriched === null) continue;
      const stored = emit(id, enriched);
      if (countsAsOutput && stored !== null) turn.sawOutput = true;
      // Deleted by a subscriber of the event just emitted: neither `save` nor
      // the rest of the batch may write the record or log back.
      if (store.get(id) !== session) return;
      if (SESSION_MUTATING_EVENTS.has(event.type)) save(session);
    }
  }

  /**
   * `sawOutput` ("the CLI engaged, count the turn") is set only by an event
   * that was PERSISTED. Since 3.10 a batch can be all transient — progress
   * ticks, `status` retry notices, thinking deltas — and a turn that produced
   * nothing but "retrying (1/10)" before failing has not created anything on
   * the vendor side worth a turnCount; counting it would make the next launch
   * `--resume` a conversation that never existed.
   */
  function handleParsed(id: string, turn: RunningTurn, events: VerseParsedEvent[]): void {
    if (events.length === 0) return;
    applyEvents(id, turn, events, false, true);
  }

  /**
   * Run one telemetry hook. Hooks read the CLI's own files; they are bounded
   * and synchronous by contract, but a hook that throws, returns garbage or
   * returns a non-telemetry event is contained here — telemetry is never
   * allowed to break, fail or extend a turn.
   *
   * The WHOLE body is guarded, not just the hook call: the poll runs from a
   * timer, where anything thrown (a store write failing, a subscriber's
   * callback) would be an uncaught exception in the server process rather
   * than a failed turn.
   */
  function runTelemetryHook(id: string, turn: RunningTurn, hook: 'pollTelemetry' | 'afterTurn'): void {
    try {
      const fn = turn.adapter[hook];
      if (typeof fn !== 'function') return;
      const current = store.get(id);
      if (!current) return;
      const ctx = turn.hookCtx;
      ctx.session = cloneSession(current);
      let observed: string | null = null;
      try { observed = turn.parser.nativeSessionId(); } catch { observed = null; }
      ctx.nativeSessionId = observed ?? current.nativeSessionId;
      let produced: unknown;
      try { produced = fn.call(turn.adapter, ctx); } catch { return; }
      if (!Array.isArray(produced)) return;
      const events = produced.filter((event): event is VerseParsedEvent =>
        isObject(event) && typeof event['type'] === 'string' && TELEMETRY_EVENTS.has(event['type'] as VerseEvent['type']));
      if (events.length > 0) applyEvents(id, turn, events, hook === 'pollTelemetry');
    } catch {
      // Best effort by design; the turn's own outcome is decided elsewhere.
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
    registry?.remove(id, turn.turnId);

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

    // After the parser flushed (so its own usage is already applied and a
    // file-based reading REPLACES it rather than being overwritten by it), and
    // before `turn-done`, so every client sees the final occupancy and any
    // compaction as part of the turn. Runs for stopped turns too: a turn that
    // was cancelled part-way can still have compacted. Skipped only when the
    // process never existed (async spawn failure, no pid): it wrote nothing,
    // and a file read then could only find some OTHER run's records.
    if (turn.child.pid !== undefined) runTelemetryHook(id, turn, 'afterTurn');

    const session = store.get(id);
    if (!session) {
      // Deleted while settling (a subscriber of one of the events above
      // removed the chat). Its subscribers went with it; a close-out written
      // now would only re-create the log of a chat that no longer exists.
      detachChild(turn);
      return;
    }
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
    } else if (turn.termination !== null) {
      // policy / storage / interrupted: the engine ended it, with its own words.
      ok = false;
      lastError = turn.terminationMessage ?? `turn stopped (${turn.termination})`;
      emit(id, { type: 'error', turnId: turn.turnId, message: lastError });
    } else if (!ok) {
      // The tail is scrubbed of the launcher/binary/env before it is durable.
      // `scrubSecrets` runs too, because this string is persisted to the 0600
      // session record as well as emitted: on the API path `sanitizePublicJson`
      // would scrub a forwarded CLAUDE_CODE_OAUTH_TOKEN, on the disk path
      // nothing did.
      const tail = scrubSecrets(redact(turn.stderrTail.join('\n'), turn.redactions)).trim().slice(-STDERR_TAIL_CHARS);
      const code = turn.recoverable ?? (tail ? classifyVerseFailure(tail) : null);
      // A lost / locked native conversation: one retry on a fresh native
      // session, inside the SAME turn. On success nothing below runs for
      // this attempt — the retry's own finalize closes the turn.
      if (code && recoverNativeThreads && !turn.isRecovery && !closed && attemptRecovery(id, turn, session, code)) {
        detachChild(turn);
        return;
      }
      lastError = exitCode === null
        ? 'process ended without an exit code'
        : `process exited with code ${exitCode}`;
      if (!turn.sawError) {
        emit(id, {
          type: 'error',
          turnId: turn.turnId,
          message: tail ? `${lastError}: ${tail}` : lastError,
          ...(code ? { code } : {}),
        });
      }
    }

    const nativeFromOutput = turn.parser.nativeSessionId();
    const nativeSessionId = nativeFromOutput ?? session.nativeSessionId ?? null;
    // Same rule for a subscriber of the close-out events themselves.
    const alive = (): boolean => store.get(id) === session;
    if (alive()) {
      emit(id, {
        type: 'turn-done',
        turnId: turn.turnId,
        ok,
        nativeSessionId,
        durationMs: Math.max(0, Date.now() - turn.startedAt),
      });
    }
    if (!alive()) {
      detachChild(turn);
      return;
    }

    if (nativeFromOutput && !session.nativeSessionId) session.nativeSessionId = nativeFromOutput;
    // Count the turn once the CLI engaged: a resumed conversation exists on
    // the vendor side even when the turn was cancelled part-way.
    if (ok || turn.sawOutput) session.turnCount += 1;
    session.status = ok || stopped ? 'idle' : 'error';
    session.lastError = ok || stopped ? null : (lastError ?? session.lastError ?? 'turn failed');
    save(session);
    compactLog(id);

    detachChild(turn);
  }

  /**
   * Retry a failed turn ONCE on a new native session.
   *
   * The vendor conversation is gone (`native-thread-missing`: Claude deletes
   * transcripts after 30 idle days, a codex rollout was pruned) or its id is
   * locked (`session-in-use`: a Stop before the first reply left the id
   * claimed). Both used to break the chat for good. Instead: mint a fresh
   * native id, and — when the chat has history — seed the retry with the
   * deterministic handoff note built from this session's own log (zero
   * spend, no git subprocess), followed by the operator's text. A `recovered`
   * event records it. The adapter is handed the session with turnCount 0, so
   * every CLI starts a NEW conversation (`--session-id` / fresh `exec`).
   *
   * Returns false (and changes nothing) when a retry cannot be launched; the
   * caller then reports the original failure.
   */
  function attemptRecovery(id: string, turn: RunningTurn, session: VerseSession, code: VerseEventErrorCode): boolean {
    try {
      const prior = store.readEvents(id).filter((event) => event.seq < turn.userSeq);
      const hadConversation = prior.some((event) => event.type === 'assistant-message'
        || (event.type === 'turn-done' && event.ok));
      let how: VerseRecoveryHow = 'new-native-session';
      let text = turn.text;
      if (hadConversation) {
        try {
          const note = buildHandoffPreview(session, prior, { gitDiffStat: () => null }).text;
          const seeded = `${note}\n\n---\n\n${turn.text}`;
          if (Buffer.byteLength(seeded, 'utf8') <= VERSE_MAX_TURN_TEXT_BYTES) {
            text = seeded;
            how = 'handoff';
          }
        } catch {
          // No note: a bare new session still beats a dead chat.
        }
      }
      const nativeSessionId = session.engine === 'codex' ? null : randomUUID();
      const fresh: VerseSession = { ...cloneSession(session), nativeSessionId, turnCount: 0 };
      const turnLaunch = adapterFor(session.engine).buildLaunch(fresh, text, turn.seatLaunch);
      const lost = code === 'native-thread-missing'
        ? 'the native conversation no longer exists'
        : 'the native session id was locked';
      emit(id, {
        type: 'recovered',
        turnId: turn.turnId,
        how,
        message: how === 'handoff'
          ? `${lost}; retried on a new native session seeded with a handoff note from this chat`
          : `${lost}; retried on a new native session`,
      });
      session.nativeSessionId = nativeSessionId;
      save(session);
      log('warn', `session ${id}: ${code}; recovered on a new native session (${how})`);
      startTurn(session, turn.turnId, turn.seatLaunch, turnLaunch, redactionsFor(turn.seatLaunch, turnLaunch), {
        text: turn.text,
        userSeq: turn.userSeq,
        isRecovery: true,
      });
      return true;
    } catch (err) {
      log('warn', `session ${id}: recovery from ${code} could not start (${errorCode(err) || (err instanceof Error ? err.name : 'error')})`);
      return false;
    }
  }

  function detachChild(turn: RunningTurn): void {
    turn.child.removeAllListeners();
    turn.child.on('error', () => { /* late errors after settlement are noise */ });
    turn.child.stdout?.removeAllListeners();
    turn.child.stderr?.removeAllListeners();
    if (typeof turn.child.unref === 'function') turn.child.unref();
  }

  // ---- spawn ----------------------------------------------------------------

  function startTurn(
    session: VerseSession,
    turnId: string,
    seatLaunch: VerseSeatLaunch,
    launch: VerseTurnLaunch,
    redactions: Redaction[],
    turnCtx: { text: string; userSeq: number; isRecovery: boolean },
  ): void {
    const id = session.id;

    // ---- LOCAL-ONLY: the last gate before a vendor process exists ----------
    //
    // The cockpit's Local-only panel tells the operator that nothing can spend
    // money while the mode is on. That claim is only true if the refusal lands
    // HERE — before the spawn — because an interactive turn bypasses
    // `run/engines.spawnEngine` and every gate the daemon path carries.
    //
    // Reported as an ordinary failed turn (`error` then `turn-done`) rather
    // than thrown: the refusal has to be legible in the session the person is
    // looking at. A silent no-op, or an exception escaping into the control
    // API, both read as a broken app rather than a policy doing its job. The
    // reason is the policy's OWN sentence, quoted verbatim — it already names
    // the seat, how the mode resolved, and how to turn it off.
    const verdict = verseSeatPermitted(session.engine, seatLaunch, loadCfg());
    if (!verdict.permitted) {
      const message = verdict.reason ?? 'local-only: refused';
      emit(id, { type: 'error', turnId, message });
      emit(id, {
        type: 'turn-done',
        turnId,
        ok: false,
        nativeSessionId: session.nativeSessionId,
        durationMs: 0,
      });
      session.status = 'error';
      session.lastError = message;
      save(session);
      return;
    }

    const adapter = adapterFor(session.engine);
    const parser = adapter.createParser(turnId);
    const option = effectiveModelOption(seatLaunch.seat, session.model, session.engine);
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

    const startedAt = Date.now();
    const turn: RunningTurn = {
      turnId,
      child,
      pgid: detached && typeof child.pid === 'number' && child.pid > 0 ? child.pid : null,
      startedAt,
      parser,
      adapter,
      option,
      hookCtx: {
        session: cloneSession(session),
        launch: seatLaunch,
        turnId,
        startedAt,
        nativeSessionId: session.nativeSessionId,
        parser,
        state: {},
      },
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
      pollTimer: null,
      watchTimer: null,
      lastOutputAt: startedAt,
      watchdogWarned: false,
      recoverable: null,
      seatLaunch,
      text: turnCtx.text,
      userSeq: turnCtx.userSeq,
      isRecovery: turnCtx.isRecovery,
      terminationMessage: null,
    };
    running.set(id, turn);
    if (registry && turn.pgid !== null && typeof child.pid === 'number') {
      registry.add({
        sessionId: id,
        turnId,
        pid: child.pid,
        pgid: turn.pgid,
        markers: argvMarkers(launch.argv, session.engine === 'local' ? 'claude' : session.engine),
        spawnedAt: startedAt,
      });
    }
    emit(id, { type: 'turn-started', turnId, pid: typeof child.pid === 'number' ? child.pid : null });

    const sawBytes = (): void => {
      turn.lastOutputAt = Date.now();
      turn.watchdogWarned = false;
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string | Buffer) => {
      sawBytes();
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
      sawBytes();
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

    // Live meter for CLIs that only record exact occupancy in their own files.
    // Unref'd so a poll never keeps the process alive; cleared in finalize.
    if (typeof adapter.pollTelemetry === 'function') {
      turn.pollTimer = setInterval(() => {
        if (turn.settled) return;
        runTelemetryHook(id, turn, 'pollTelemetry');
      }, telemetryPollMs);
      if (turn.pollTimer.unref) turn.pollTimer.unref();
    }

    const engineId = session.engine;
    turn.watchTimer = setInterval(() => watchTurn(id, turn, engineId), watchdogPollMs);
    if (turn.watchTimer.unref) turn.watchTimer.unref();

    if (engineId === 'local' && preflight !== null && !turnCtx.isRecovery) preflightTurn(id, turn, seatLaunch);
  }

  /**
   * LOCAL preflight, in PARALLEL with the spawn (never in front of it: a
   * local turn gains no latency, and the spawn stays synchronous with the
   * request). Runs only after the local-only gate admitted the seat, so a
   * refused remote endpoint is never even connected to. A definite refusal
   * (nothing listening) stops the turn with a plain sentence at once —
   * without it the CLI sits in its own retry loop for minutes with nothing
   * on screen (r2/reliability.md #7). A slow answer only posts a notice.
   */
  function preflightTurn(id: string, turn: RunningTurn, seatLaunch: VerseSeatLaunch): void {
    const url = seatLaunch.anthropicBaseUrl?.trim() || seatLaunch.ollamaBaseUrl;
    let check: Promise<VersePreflightResult>;
    try {
      check = (preflight as (url: string) => Promise<VersePreflightResult>)(url);
    } catch {
      return;
    }
    void check.then((result) => {
      if (turn.settled || turn.termination !== null) return;
      if (result.ok === false) {
        turn.terminationMessage = `local model server unreachable: ${result.reason}. Start it (e.g. \`ollama serve\`) and send again.`;
        log('warn', `session ${id}: local preflight failed in ${result.ms}ms: ${result.reason}`);
        requestTermination(id, turn, 'preflight');
        return;
      }
      if (result.ok === 'slow') {
        emitTransient(id, {
          type: 'status',
          turnId: turn.turnId,
          kind: 'preflight',
          message: 'The local model server is slow to answer; the turn is running anyway.',
        });
      }
    }, () => { /* an unknown answer is not a refusal */ });
  }

  /**
   * Periodic check of a running turn (every `watchdogPollMs`):
   *  - LOCAL-ONLY, live. The gate at spawn is not enough: the operator can
   *    switch the mode on while a vendor turn is already spending. The same
   *    predicate is re-asked; a refusal stops the turn with the policy's own
   *    sentence.
   *  - NO-OUTPUT WATCHDOG. After `watchdogMs` without a byte on stdout or
   *    stderr, one `status` notice (transient) says so. The turn keeps
   *    running — a long tool call is legitimate; Stop is the operator's call.
   * Wrapped whole: this runs from a timer, where a throw is process-fatal.
   */
  function watchTurn(id: string, turn: RunningTurn, engineId: VerseEngine): void {
    try {
      if (turn.settled || turn.termination !== null) return;
      const verdict = verseSeatPermitted(engineId, turn.seatLaunch, loadCfg());
      if (!verdict.permitted) {
        turn.terminationMessage = verdict.reason ?? 'local-only: refused';
        log('warn', `session ${id}: local-only switched on during a vendor turn; stopping it`);
        requestTermination(id, turn, 'policy');
        return;
      }
      const silentMs = Date.now() - turn.lastOutputAt;
      if (silentMs >= watchdogMs && !turn.watchdogWarned) {
        turn.watchdogWarned = true;
        const minutes = Math.max(1, Math.round(silentMs / 60_000));
        emitTransient(id, {
          type: 'status',
          turnId: turn.turnId,
          kind: 'watchdog',
          message: `No output for ${minutes} min — the turn is still running. Stop it if it looks stuck.`,
        });
      }
    } catch {
      // Best effort: a failed check never ends a turn.
    }
  }

  function isBusy(id: string): boolean {
    return running.has(id);
  }

  /** Throws VERSE_SEAT_NOT_READY on an explicit refusal; admits on anything else. */
  function admitSeat(seatId: string): void {
    const fn = readiness;
    if (!fn) return;
    let verdict: unknown;
    try {
      verdict = fn(seatId);
    } catch (err) {
      log('warn', `readiness check for seat ${seatId} threw (${err instanceof Error ? err.name : 'error'}); admitting`);
      return;
    }
    // An async answer cannot become this request's 409; unknown → admit.
    if (isObject(verdict) && typeof verdict['then'] === 'function') return;
    if (!isReadiness(verdict) || verdict.ready) return;
    const reason = verdict.reason?.trim() || `seat ${seatId} is not ready`;
    throw new VerseError('VERSE_SEAT_NOT_READY', scrubSecrets(reason), {
      readiness: { seatId: verdict.seatId, ready: false, reason: scrubSecrets(reason), alternatives: [...verdict.alternatives] },
    });
  }

  // ---- handle -----------------------------------------------------------------

  return {
    listSessions(): VerseSession[] {
      const sessions = store.list();
      // Normally a no-op (the startup pass already ran); covers a record that
      // reached the store after this engine started.
      for (const session of sessions) materializeLegacyMode(session);
      return sessions
        .map(cloneSession)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    },

    getSession(id: string): VerseSession | null {
      const session = typeof id === 'string' ? store.get(id) : null;
      if (!session) return null;
      materializeLegacyMode(session);
      return cloneSession(session);
    },

    getEvents(id: string, fromSeq = 0): VerseEvent[] {
      require(id);
      return store.readEvents(id, fromSeq);
    },

    createSession(req: VerseCreateSessionRequest, launch: VerseSeatLaunch, opts: VerseCreateOptions = {}): VerseSession {
      if (closed) throw new VerseError('VERSE_INVALID', 'verse engine is closed');
      if (!isObject(req)) throw new VerseError('VERSE_INVALID', 'request body must be an object');
      if (!isSeatLaunch(launch)) throw new VerseError('VERSE_INVALID', 'seat launch is malformed');
      if (!isObject(opts)) throw new VerseError('VERSE_INVALID', 'create options must be an object');
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

      // Model. An explicit request may name the retired alias; the record
      // stores the id the SEAT lists, so new sessions carry the canonical id.
      // The default is the first RUNNABLE model — a listed-but-unavailable
      // model (e.g. one the pinned CLI is too old for) is never picked silently.
      let option: VerseModelOption | null;
      if (typeof req.model === 'string' && req.model.trim()) {
        const requested = req.model.trim();
        option = findModelOption(seat, requested);
        if (!option) throw new VerseError('VERSE_INVALID', `model ${requested} is not available on seat ${seat.id}`);
      } else {
        if (seat.models.length === 0) throw new VerseError('VERSE_INVALID', `seat ${seat.id} has no models`);
        option = seat.models.find((m) => !m.unavailableReason) ?? null;
        if (!option) throw new VerseError('VERSE_INVALID', `seat ${seat.id} has no runnable models`);
      }
      if (typeof option.unavailableReason === 'string' && option.unavailableReason.trim()) {
        throw new VerseError('VERSE_INVALID', `model ${option.id} is unavailable on seat ${seat.id}: ${option.unavailableReason.trim()}`);
      }
      const model = option.id;

      // Context mode. A request without one gets `standard`. Standard always
      // exists — it is the CLI's own behaviour, known or estimated — but a
      // mode the model has no budget for is refused, never faked.
      let contextMode: VerseContextMode = 'standard';
      if (req.contextMode !== undefined) {
        if (!isContextMode(req.contextMode)) {
          throw new VerseError('VERSE_INVALID', `contextMode must be one of: ${VERSE_CONTEXT_MODES.join(', ')}`);
        }
        contextMode = req.contextMode;
      }
      const budgetOption = effectiveModelOption(seat, model, engine);
      if (contextMode !== 'standard' && !budgetFor(budgetOption, contextMode)) {
        throw new VerseError('VERSE_INVALID', `model ${model} has no ${contextMode} context mode on seat ${seat.id}`);
      }
      const budget = sessionBudgetFor(seat, budgetOption, contextMode, engine);

      if (req.title !== undefined && typeof req.title !== 'string') {
        throw new VerseError('VERSE_INVALID', 'title must be a string');
      }

      // Memory: `undefined` = the caller did not decide (pre-3.9) → no key;
      // `null` = decided OFF → `memoryEnabled: false`; a snapshot → pinned.
      let memory: SessionMemory | null | undefined;
      if (opts.memory !== undefined && opts.memory !== null) {
        if (!isSessionMemory(opts.memory)) throw new VerseError('VERSE_INVALID', 'memory snapshot is malformed');
        memory = { dir: opts.memory.dir, block: opts.memory.block, writable: opts.memory.writable };
      } else {
        memory = opts.memory;
      }

      const handoffFrom = resolveHandoffSource(req, opts);

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
          contextWindow: budget.contextWindow,
          contextWindowSource: budget.source,
          autoCompactAt: budget.autoCompactAt,
        },
        lastError: null,
        // ALWAYS written, even for `standard`: from 3.9 on, a record with no
        // `contextMode` key is by definition one created before modes existed
        // (see `materializeLegacyMode`), and that inference is only sound if
        // no new record ever omits the key.
        contextMode,
        ...(handoffFrom ? { handoffFrom } : {}),
        ...(memory !== undefined ? { memoryEnabled: memory !== null } : {}),
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
        // Pinned for the same reason, and so the block sent every turn is the
        // same bytes every turn (prompt-cache stable).
        ...(memory ? { memory } : {}),
      } satisfies VerseSeatLaunch);
      // After the launch record: a listener that reacts by reading the new
      // session finds it complete.
      noteListing(session);
      return cloneSession(session);
    },

    sendTurn(id: string, text: string): { turnId: string; session: VerseSession } {
      if (closed) throw new VerseError('VERSE_INVALID', 'verse engine is closed');
      const session = require(id);
      if (typeof text !== 'string' || !text.trim()) throw new VerseError('VERSE_INVALID', 'text is required');
      if (Buffer.byteLength(text, 'utf8') > VERSE_MAX_TURN_TEXT_BYTES) {
        throw new VerseError('VERSE_TOO_LARGE', `text exceeds ${VERSE_MAX_TURN_TEXT_BYTES} bytes`);
      }
      if (isBusy(id)) {
        throw new VerseError('VERSE_SESSION_BUSY', 'a turn is already running');
      }
      // `running` on disk with no live process is stale (see reconcileInterrupted), not busy.
      if (session.status === 'running') reconcileInterrupted(session);
      const launch = store.loadLaunch(id);
      if (!isSeatLaunch(launch)) {
        throw new VerseError('VERSE_INVALID', 'session launch record is missing or unreadable');
      }
      // READINESS GATE (V3.10). Before anything is recorded: a refused turn
      // leaves no trace in the chat — the 409 (with ranked alternatives) is
      // the whole answer. Only an explicit `ready: false` refuses; a seat
      // account health knows nothing about is admitted.
      admitSeat(session.seatId);
      // A memory snapshot pinned before control characters were stripped can
      // hold a NUL, which no OS accepts inside an argv entry — the session
      // could never start again. Repair the in-memory copy for this launch;
      // the pinned record stays as written (it is the provenance).
      if (launch.memory && launch.memory.block !== stripUnsafeControlChars(launch.memory.block)) {
        launch.memory = { ...launch.memory, block: stripUnsafeControlChars(launch.memory.block) };
      }

      const turnId = randomUUID();
      if (session.turnCount === 0 && session.title === DEFAULT_TITLE) session.title = autoTitle(text);
      storageFailed.delete(id);
      const userMessage = emit(id, { type: 'user-message', turnId, text });
      if (!userMessage) {
        // The log cannot be written (onStorageFailure already recorded it):
        // a turn nobody can ever see must not spend.
        throw new Error('verse session log could not be written');
      }
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
      startTurn(session, turnId, launch, turnLaunch, redactionsFor(launch, turnLaunch), {
        text,
        userSeq: userMessage.seq,
        isRecovery: false,
      });
      return { turnId, session: cloneSession(store.get(id) ?? session) };
    },

    setContextMode(id: string, mode: VerseContextMode): VerseSession {
      if (closed) throw new VerseError('VERSE_INVALID', 'verse engine is closed');
      const session = require(id);
      if (!isContextMode(mode)) {
        throw new VerseError('VERSE_INVALID', `mode must be one of: ${VERSE_CONTEXT_MODES.join(', ')}`);
      }
      if (isBusy(id)) {
        throw new VerseError('VERSE_SESSION_BUSY', 'the context mode can change between turns; wait for this turn to finish or stop it');
      }
      const launch = store.loadLaunch(id);
      if (!isSeatLaunch(launch)) {
        throw new VerseError('VERSE_INVALID', 'session launch record is missing or unreadable');
      }
      const option = effectiveModelOption(launch.seat, session.model, session.engine);
      if (mode !== 'standard' && !budgetFor(option, mode)) {
        throw new VerseError('VERSE_INVALID', `model ${session.model} has no ${mode} context mode on seat ${session.seatId}`);
      }
      if ((session.contextMode ?? 'standard') === mode) return cloneSession(session);

      session.contextMode = mode;
      const runtimeWindow = session.usage.contextWindowSource === 'runtime' ? positiveInt(session.usage.contextWindow) : null;
      if (runtimeWindow !== null && session.engine === 'claude') {
        // Claude's window is a property of the MODEL (the CLI reported it);
        // the mode only moves the `--autocompact` point. Keep the measured
        // window and recompute where it now compacts.
        applyRuntimeWindow(session, option, runtimeWindow);
      } else {
        // Codex's window IS the mode (`-c model_context_window=…`), so a
        // previous runtime reading describes the old mode. Show the new
        // budget until the next turn reports its own.
        const budget = sessionBudgetFor(launch.seat, option, mode, session.engine);
        session.usage.contextWindow = budget.contextWindow;
        session.usage.contextWindowSource = budget.source;
        session.usage.autoCompactAt = budget.autoCompactAt;
      }
      save(session);
      emitBudgetChange(id, session);
      return cloneSession(session);
    },

    refreshLocalWindow(id: string, option: VerseModelOption): VerseSession {
      if (closed) throw new VerseError('VERSE_INVALID', 'verse engine is closed');
      const session = require(id);
      if (session.engine !== 'local') return cloneSession(session);
      if (isBusy(id)) {
        throw new VerseError('VERSE_SESSION_BUSY', 'the window can change between turns; wait for this turn to finish or stop it');
      }
      if (!isObject(option) || typeof option.id !== 'string' || canonicalModelId(option.id) !== canonicalModelId(session.model)) {
        throw new VerseError('VERSE_INVALID', `live option does not describe model ${session.model}`);
      }
      // A live option with no usable window is "no reading" — keep the stored
      // one rather than erase the only window the CLI can be told.
      const budget = budgetFor(option, 'standard');
      if (!budget) return cloneSession(session);
      // The caller's option is data: an unknown source would make the record
      // fail validation on its next read, so it is recorded as a fallback.
      const source: VerseWindowSource = isVerseWindowSource(option.windowSource) ? option.windowSource : 'fallback';
      const usage = session.usage;
      if (usage.contextWindow === budget.contextWindow
        && (usage.autoCompactAt ?? null) === budget.autoCompactAt
        && usage.contextWindowSource === source) {
        return cloneSession(session);
      }
      usage.contextWindow = budget.contextWindow;
      usage.autoCompactAt = budget.autoCompactAt;
      usage.contextWindowSource = source;
      save(session);
      emitBudgetChange(id, session);
      return cloneSession(session);
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
      listingKeys.delete(id);
      announce(id);
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
      // After the turns settle (their close-out events are tapped too), before
      // the store goes: shutdown is the last chance to write them.
      flushReasoning();
      listeners.clear();
      store.close();
    },

    interruptAll(reason: string): number {
      const why = typeof reason === 'string' && reason.trim() ? reason.trim() : 'server stopping';
      const message = `turn interrupted: ${why}`;
      let count = 0;
      for (const [id, turn] of [...running.entries()]) {
        if (turn.settled) continue;
        turn.termination = 'interrupted';
        turn.terminationMessage = message;
        signalGroup(turn, 'SIGKILL');
        finalize(id, turn, null);
        count += 1;
      }
      if (count > 0) log('error', `${count} running turn(s) interrupted: ${why}`);
      // The crash path exits right after this returns, so nothing deferred
      // would ever run: deliver pending taps and flush the store's batch now.
      flushReasoning();
      return count;
    },
  };
}
