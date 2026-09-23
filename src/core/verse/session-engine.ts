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
 * published wrappers) at the top of `startTurn` — see `verseSeatPermitted`.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
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
  reconcileAutoCompactAt,
} from './context-math.js';
import { claudeModelOptions } from './model-windows.js';
import { createVerseSessionStore, type VerseSessionStore } from './session-store.js';
import {
  VERSE_CONTEXT_MODES,
  VERSE_DEFAULT_CONTEXT_WINDOWS,
  VERSE_MAX_TURN_TEXT_BYTES,
  VERSE_MAX_WORKSPACE_ROOTS,
  VERSE_TURN_TIMEOUT_MS,
  type VerseContextMode,
  type VerseCreateSessionRequest,
  type VerseEngine,
  type VerseEvent,
  type VerseModelOption,
  type VerseSeat,
  type VerseSession,
  type VerseTurnLaunch,
  type VerseUsage,
  type VerseWindowSource,
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

/** Whether an option was built by the V3.9 catalog (it states its budgets), rather than read from an older launch snapshot. */
function hasCatalogBudgets(option: VerseModelOption): boolean {
  return option.autoCompactAt !== undefined || option.expansive !== undefined || option.windowSource !== undefined;
}

/**
 * The option whose budgets govern a session's readings.
 *
 * Normally the seat's own option. The exception is a CLAUDE launch snapshot
 * written before 3.9: its options carry only the old flat 200k window and no
 * budgets, yet the claude adapter now launches those sessions with the budget
 * from the verified per-model table (model-windows.ts). The engine reads the
 * same table so the compaction point it records is the one the CLI was
 * actually told — two sources of truth for one flag would drift.
 *
 * Codex/grok/local older snapshots are left as they are: their windows come
 * from per-seat catalogs Verse cannot reconstruct after the fact, and the
 * first runtime reading corrects them anyway.
 */
function effectiveModelOption(seat: VerseSeat, model: string, engine: VerseEngine): VerseModelOption | null {
  const option = findModelOption(seat, model);
  if (engine !== 'claude' || (option && hasCatalogBudgets(option))) return option;
  const wanted = canonicalModelId(option?.id ?? model);
  const known = claudeModelOptions(null).find((m) => m.id === wanted);
  if (!known) return option;
  // Keep the snapshot's identity; take only the budgets from the table.
  return { ...known, id: option?.id ?? model, label: option?.label ?? known.label, unavailableReason: null };
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
    if (turn.pollTimer !== null) clearInterval(turn.pollTimer);
    turn.pollTimer = null;
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
  function applyEvents(id: string, turn: RunningTurn, events: VerseParsedEvent[], untilSettled = false): void {
    const session = store.get(id);
    // No record, no events: appending would re-create the log of a session
    // that is gone, and `save` its record — a deleted chat back as an orphan.
    if (!session) return;
    for (const event of events) {
      if (untilSettled && turn.settled) return;
      if (event.type === 'error') turn.sawError = true;
      const enriched = applyUsage(session, turn.option, event, turn.turnId);
      if (enriched === null) continue;
      emit(id, enriched);
      // Deleted by a subscriber of the event just emitted: neither `save` nor
      // the rest of the batch may write the record or log back.
      if (store.get(id) !== session) return;
      if (SESSION_MUTATING_EVENTS.has(event.type)) save(session);
    }
  }

  function handleParsed(id: string, turn: RunningTurn, events: VerseParsedEvent[]): void {
    if (events.length === 0) return;
    turn.sawOutput = true;
    applyEvents(id, turn, events);
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

    detachChild(turn);
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

    // Live meter for CLIs that only record exact occupancy in their own files.
    // Unref'd so a poll never keeps the process alive; cleared in finalize.
    if (typeof adapter.pollTelemetry === 'function') {
      turn.pollTimer = setInterval(() => {
        if (turn.settled) return;
        runTelemetryHook(id, turn, 'pollTelemetry');
      }, telemetryPollMs);
      if (turn.pollTimer.unref) turn.pollTimer.unref();
    }
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

      // Context mode. Absent = standard (and no key on the record, exactly
      // like every record written before modes existed). Standard always
      // exists — it is the CLI's own behaviour, known or estimated — but a
      // mode the model has no budget for is refused, never faked.
      let contextMode: VerseContextMode | undefined;
      if (req.contextMode !== undefined) {
        if (!isContextMode(req.contextMode)) {
          throw new VerseError('VERSE_INVALID', `contextMode must be one of: ${VERSE_CONTEXT_MODES.join(', ')}`);
        }
        contextMode = req.contextMode;
      }
      const budgetOption = effectiveModelOption(seat, model, engine);
      if (contextMode !== undefined && contextMode !== 'standard' && !budgetFor(budgetOption, contextMode)) {
        throw new VerseError('VERSE_INVALID', `model ${model} has no ${contextMode} context mode on seat ${seat.id}`);
      }
      const budget = sessionBudgetFor(seat, budgetOption, contextMode ?? 'standard', engine);

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
        ...(contextMode !== undefined ? { contextMode } : {}),
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
      startTurn(session, turnId, launch, turnLaunch, redactionsFor(launch, turnLaunch));
      return { turnId, session: cloneSession(store.get(id) ?? session) };
    },

    setContextMode(id: string, mode: VerseContextMode): VerseSession {
      if (closed) throw new VerseError('VERSE_INVALID', 'verse engine is closed');
      const session = require(id);
      if (!isContextMode(mode)) {
        throw new VerseError('VERSE_INVALID', `mode must be one of: ${VERSE_CONTEXT_MODES.join(', ')}`);
      }
      if (running.has(id)) {
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
      // One `context` event so every open client redraws the meter against the
      // new budget; occupancy itself is unchanged.
      emit(id, {
        type: 'context',
        turnId: null,
        contextTokens: Math.max(0, Math.floor(session.usage.contextTokens || 0)),
        contextWindow: session.usage.contextWindow,
        exact: session.usage.contextTokensExact !== false,
        autoCompactAt: session.usage.autoCompactAt ?? null,
      });
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
