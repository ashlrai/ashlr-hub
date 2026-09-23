/**
 * core/verse/verse-api.ts — /api/verse/* routes (owner B).
 *
 * Mounted from src/core/web/api.ts's handleApi() before its 404 fallthrough.
 * Same security posture as every other route there:
 *   - GETs sit behind the read-session boundary in server.ts.
 *   - POSTs are 404 unless ctx.allowDispatch, then passesMutationGate()
 *     (constant-time x-ashlr-token + JSON Content-Type), then readBody()
 *     (64 KB cap; POST /memory alone gets VERSE_MEMORY_BODY_MAX_BYTES).
 *   - Every response goes through sendJson() → sanitizePublicJson().
 *
 * Routes (see docs/VERSE-CONTRACT-V1.md, docs/VERSE-CONTEXT.md for V3.9):
 *   GET  /api/verse/bootstrap                → VerseBootstrap
 *   GET  /api/verse/seats                    → VerseSeatsResponse (pollable)
 *   GET  /api/verse/sessions                 → VerseSession[]
 *   POST /api/verse/sessions                 → VerseSession (201)
 *   GET  /api/verse/sessions/:id             → VerseSessionDetail
 *   POST /api/verse/sessions/:id/turns       → VerseTurnResponse (202)
 *   POST /api/verse/sessions/:id/cancel      → { ok: true }
 *   POST /api/verse/sessions/:id/delete      → { ok: true }
 *   POST /api/verse/sessions/:id/rename      → VerseSession
 *   GET  /api/verse/sessions/:id/events      → SSE (verse-stream.ts)
 *  V3.9 context orchestration — every one of these is ZERO SPEND: none starts
 *  a model call; the only way a token is spent is still POST .../turns.
 *   POST /api/verse/sessions/:id/context-mode    → VerseSession
 *   POST /api/verse/sessions/:id/handoff-preview → VerseHandoffPreview
 *   GET  /api/verse/preferences              → VersePreferences
 *   POST /api/verse/preferences              → VersePreferences
 *   GET  /api/verse/context-fit              → VerseContextFit
 *   GET  /api/verse/search                   → VerseSearchResponse
 *   GET  /api/verse/memory                   → VerseProjectMemory (+ contentSanitized?)
 *   POST /api/verse/memory                   → VerseProjectMemory (+ contentSanitized?)
 *
 * Errors: { error, code? } with VERSE_SESSION_NOT_FOUND 404,
 * VERSE_SESSION_BUSY 409, VERSE_INVALID 400, VERSE_TOO_LARGE 413, and two
 * route-local 409s: VERSE_MODEL_UNAVAILABLE (turns: the session's model is
 * listed but unrunnable on its seat) and VERSE_MEMORY_REDACTED (memory: the
 * content would write redaction placeholders over real values).
 *
 * STRICT BODIES AND QUERIES (V3.9 routes and POST /sessions): an unknown body
 * key or query parameter is a 400, never silently ignored — a misspelt
 * `contextMode` would otherwise create a session in a mode nobody asked for.
 *
 * ENGINE LIFETIME: one engine handle per server process — a module-level
 * lazy singleton (`getVerseEngine()`), with `resetVerseEngine()` for tests to
 * inject a fake or force re-creation under a relocated HOME. The engine
 * module is loaded lazily (dynamic import) so this file has no load-time
 * dependency on it; tests that inject a fake never touch it. The V3.9 service
 * modules keep that property: they report bad input with their own
 * `VerseServiceError` (same `code` vocabulary, mapped by duck type below)
 * rather than importing the engine's `VerseError`.
 *
 * PRIVACY: seat launchers (the native-profile commands) come from seats.ts's
 * private `launches` map and go straight to engine.createSession(). They are
 * never part of any response, log line, or session record this file writes.
 * The same holds for the shared-memory snapshot (`VerseCreateOptions.memory`):
 * its directory and prompt block go into the private launch record only.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../types.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { sanitizePublicJson } from '../util/public-json.js';
import { budgetFor, canonicalModelId, hasExpansiveMode } from './context-math.js';
import { estimateContextFit } from './context-fit.js';
import { checkWorkspaceRootPath, expandHomePrefix } from './path-guard.js';
import {
  loadVersePreferences,
  memoryEnabledFor,
  parseVersePreferencesUpdate,
  seatDefaultMode,
  updateVersePreferences,
} from './preferences.js';
import { prepareProjectMemory, readProjectMemory, writeProjectMemory } from './project-memory.js';
import { discoverProjects } from './projects.js';
import { discoverSeats, refreshSeatTelemetry, type VerseSeatDiscovery } from './seats.js';
import { buildHandoffPreview } from './session-handoff.js';
import { searchSessions } from './session-search.js';
import {
  buildAutonomyScopeView,
  createVerseWorkspaceStore,
  describeRoots,
  rootNotes,
  VerseWorkspaceError,
  type VerseWorkspaceStore,
} from './workspaces.js';
import type { VerseCreateOptions, VerseEngineHandle, VerseSeatLaunch } from './session-engine.js';
import {
  VERSE_CONTEXT_MODES,
  VERSE_MAX_TURN_TEXT_BYTES,
  VERSE_MAX_WORKSPACE_ROOTS,
  VERSE_MEMORY_MAX_BYTES,
  VERSE_ROOT_PRIORITIES,
  type VerseAutonomyScopeView,
  type VerseBootstrap,
  type VerseContextFit,
  type VerseContextMode,
  type VerseCreateSessionRequest,
  type VerseHandoffPreview,
  type VersePreferences,
  type VersePreferencesUpdate,
  type VerseProjectMemory,
  type VerseRootPriority,
  type VerseRootStatus,
  type VerseSearchResponse,
  type VerseSeatsResponse,
  type VerseSession,
  type VerseSessionDetail,
  type VerseSessionRootsResponse,
  type VerseTurnResponse,
  type VerseWorkspace,
  type VerseWorkspacesResponse,
  verseSessionRoots,
} from './types.js';
import { handleVerseEventsSse, VERSE_EVENTS_PATH_RE, VERSE_SESSION_ID_RE } from './verse-stream.js';

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

export const VERSE_API_PREFIX = '/api/verse';

export function isVerseApiPath(path: string): boolean {
  return path === VERSE_API_PREFIX || path.startsWith(`${VERSE_API_PREFIX}/`);
}

export interface VerseApiContext {
  cfg: AshlrConfig;
  token: string;
  allowDispatch: boolean;
  readSession?: { id: string; expiresAt: number };
}

// ---------------------------------------------------------------------------
// Engine singleton
// ---------------------------------------------------------------------------

let engineSingleton: VerseEngineHandle | null = null;
let enginePending: Promise<VerseEngineHandle> | null = null;

/** Return the engine if one has been created in this process (never creates one). */
export function peekVerseEngine(): VerseEngineHandle | null {
  return engineSingleton;
}

/**
 * Lazily create the per-process engine. Root defaults to
 * ~/.ashlr/verse (resolved at first use, so a relocated HOME is honored).
 */
export async function getVerseEngine(): Promise<VerseEngineHandle> {
  if (engineSingleton) return engineSingleton;
  if (!enginePending) {
    enginePending = import('./session-engine.js')
      .then((mod) => {
        const created = mod.createVerseEngine({ root: join(homedir(), '.ashlr', 'verse') });
        engineSingleton = created;
        return created;
      })
      .finally(() => { enginePending = null; });
  }
  return enginePending;
}

/**
 * Test/reset hook: close the current engine (if any) and install `next`
 * (or none, so the next request re-creates one). Also drops the seat cache.
 */
export function resetVerseEngine(next: VerseEngineHandle | null = null): void {
  const prev = engineSingleton;
  engineSingleton = next;
  enginePending = null;
  seatCache = null;
  if (prev && prev !== next) {
    try { prev.close(); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// Seat discovery cache (bounded; bootstrap + create both need it)
// ---------------------------------------------------------------------------

const SEAT_CACHE_MS = 3_000;
let seatCache: { value: VerseSeatDiscovery; expiresAt: number; cfg: AshlrConfig } | null = null;
let seatInFlight: Promise<VerseSeatDiscovery> | null = null;

async function cachedSeats(cfg: AshlrConfig): Promise<VerseSeatDiscovery> {
  const now = Date.now();
  if (seatCache && seatCache.cfg === cfg && now < seatCache.expiresAt) return seatCache.value;
  if (seatInFlight) return seatInFlight;
  seatInFlight = discoverSeats(cfg)
    .then((value) => {
      seatCache = { value, expiresAt: Date.now() + SEAT_CACHE_MS, cfg };
      return value;
    })
    .finally(() => { seatInFlight = null; });
  return seatInFlight;
}

/** Drop the cached seat discovery (after account changes, or in tests). */
export function invalidateVerseSeatCache(): void {
  seatCache = null;
}

// ---------------------------------------------------------------------------
// Workspace registry singleton
// ---------------------------------------------------------------------------

let workspaceStore: VerseWorkspaceStore | null = null;

/**
 * The workspace registry, rooted next to the session store so the two share
 * one 0700 directory and one relocation story. Resolved at FIRST USE, not at
 * module load, so a relocated HOME is honored exactly as `getVerseEngine()`
 * does it.
 */
export function getVerseWorkspaceStore(): VerseWorkspaceStore {
  if (!workspaceStore) {
    workspaceStore = createVerseWorkspaceStore({ root: join(homedir(), '.ashlr', 'verse') });
  }
  return workspaceStore;
}

/** Test hook: drop the memoized store so the next call re-reads under a new HOME. */
export function resetVerseWorkspaceStore(next: VerseWorkspaceStore | null = null): void {
  workspaceStore = next;
}

/**
 * Seats with LIVE telemetry, for every read that a human looks at.
 *
 * `cachedSeats` caches seat IDENTITY — which accounts exist, which Ollama tags
 * are installed — because discovering it costs one HTTP round trip per model.
 * Account TELEMETRY is cheap and changes every collector cycle, so it is
 * recomputed here on every read. Without this split a bootstrap served from a
 * warm cache could hand back the "unknown" health that was captured before the
 * collector's first cycle finished, which is exactly the bug the Resources
 * panel showed all day.
 */
async function liveSeats(cfg: AshlrConfig): Promise<VerseSeatDiscovery> {
  return refreshSeatTelemetry(cfg, await cachedSeats(cfg));
}

// ---------------------------------------------------------------------------
// Sessions digest for the /api/events poll
// ---------------------------------------------------------------------------

/**
 * A cheap, deterministic digest of the session list — the /api/events poll
 * emits `verse-sessions` only when this changes. Empty string when no engine
 * exists yet (nothing to refresh).
 */
export function verseSessionsDigest(): string {
  const engine = engineSingleton;
  if (!engine) return '';
  try {
    return engine
      .listSessions()
      .map((s) => `${s.id}:${s.status}:${s.updatedAt}:${s.turnCount}:${s.title}`)
      .join('|');
  } catch {
    return '';
  }
}

/** Current sessions for the /api/events push (empty when no engine yet). */
export function verseSessionsSnapshot(): VerseSession[] {
  const engine = engineSingleton;
  if (!engine) return [];
  try {
    return engine.listSessions();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

type VerseErrorCode = 'VERSE_SESSION_NOT_FOUND' | 'VERSE_SESSION_BUSY' | 'VERSE_INVALID' | 'VERSE_TOO_LARGE';

const VERSE_ERROR_STATUS: Record<VerseErrorCode, 404 | 409 | 400 | 413> = {
  VERSE_SESSION_NOT_FOUND: 404,
  VERSE_SESSION_BUSY: 409,
  VERSE_INVALID: 400,
  VERSE_TOO_LARGE: 413,
};

function isVerseErrorCode(value: unknown): value is VerseErrorCode {
  return typeof value === 'string' && value in VERSE_ERROR_STATUS;
}

/**
 * Duck-typed (not instanceof) so a VerseError thrown by another module
 * instance — or a test fake — still maps to the contract's status codes.
 */
function sendVerseError(res: ServerResponse, err: unknown): void {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (isVerseErrorCode(code)) {
      const message = err instanceof Error ? err.message : String((err as { message?: unknown }).message ?? code);
      sendJson(res, VERSE_ERROR_STATUS[code], { code, error: message });
      return;
    }
  }
  sendJson(res, 500, { code: 'INTERNAL_ERROR', error: 'internal server error' });
}

function sendInvalid(res: ServerResponse, message: string): void {
  sendJson(res, 400, { code: 'VERSE_INVALID', error: message });
}

// ---------------------------------------------------------------------------
// Body helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * readBody() + JSON.parse with the contract's error shape. Returns null after
 * responding. `maxBytes` is omitted by every route but POST /memory, so each
 * of them keeps readBody's shared 64 KB cap.
 */
async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes?: number,
): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readBody(req, maxBytes);
  } catch {
    sendJson(res, 413, { code: 'VERSE_TOO_LARGE', error: 'request body too large' });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : (JSON.parse(raw) as unknown);
  } catch {
    sendInvalid(res, 'invalid JSON body');
    return null;
  }
  if (!isRecord(parsed)) {
    sendInvalid(res, 'body must be a JSON object');
    return null;
  }
  return parsed;
}

const MAX_TITLE_CHARS = 200;
const MAX_PATH_CHARS = 4096;

/**
 * Respond 400 and return true when `body` carries a key outside `allowed`.
 *
 * Unknown keys are refused rather than ignored for the same reason
 * control-api.ts refuses them: a misspelt field (`contextmode`) that is
 * silently dropped produces a request that "worked" and did something other
 * than what the operator asked for.
 */
function rejectUnknownKeys(
  body: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  res: ServerResponse,
): boolean {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      sendInvalid(res, `unknown key: ${key}`);
      return true;
    }
  }
  return false;
}

/**
 * Parse the query string of a V3.9 GET under the same strictness as a body:
 * an unknown parameter is a 400, and a parameter that is not `repeatable` may
 * appear at most once (two `projectPath`s have no honest meaning). Returns
 * null after responding.
 *
 * The read boundary's `?client=` proof never reaches these routes — only the
 * SSE paths accept it (web/read-session.ts) — so no auth parameter needs to be
 * tolerated here.
 */
function readQuery(
  req: IncomingMessage,
  res: ServerResponse,
  allowed: readonly string[],
  repeatable: readonly string[] = [],
): URLSearchParams | null {
  let params: URLSearchParams;
  try {
    params = new URL(req.url ?? '/', 'http://localhost').searchParams;
  } catch {
    sendInvalid(res, 'invalid query string');
    return null;
  }
  for (const key of new Set(params.keys())) {
    if (!allowed.includes(key)) {
      sendInvalid(res, `unknown query parameter: ${key}`);
      return null;
    }
    if (!repeatable.includes(key) && params.getAll(key).length > 1) {
      sendInvalid(res, `query parameter ${key} may appear only once`);
      return null;
    }
  }
  return params;
}

function isContextMode(value: unknown): value is VerseContextMode {
  return typeof value === 'string' && (VERSE_CONTEXT_MODES as readonly string[]).includes(value);
}

const CONTEXT_MODE_LIST = VERSE_CONTEXT_MODES.join(', ');

/**
 * Validate one project/root path with EXACTLY the rule POST /sessions uses
 * (`checkWorkspaceRootPath`: absolute, an existing directory, never `/`,
 * `$HOME`, `~/.ashlr` or `~/.codex/artifacts`, lexically or through a
 * symlink). Every V3.9 route that takes a path goes through here, so a path
 * that could never be a session root can never be measured, remembered or
 * opted out either.
 *
 * `path` is the `~`-expanded spelling the caller sent (what the engine would
 * receive); `physical` is the resolved one the memory and preference stores
 * key on, so `/tmp/x` and `/private/tmp/x` are one project.
 */
function guardRoot(
  raw: unknown,
  field: string,
): { ok: true; path: string; physical: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > MAX_PATH_CHARS) {
    return { ok: false, error: `${field} is required` };
  }
  const trimmed = raw.trim();
  const check = checkWorkspaceRootPath(trimmed);
  if (!check.ok) return { ok: false, error: check.error };
  return { ok: true, path: expandHomePrefix(trimmed), physical: check.path };
}

/**
 * sanitizePublicJson() rewrites the home directory as `~` on every outbound
 * payload, so a project path the UI read from bootstrap comes back as
 * `~/...`. Expand it here so round-trips validate against the real path.
 *
 * Defined in `path-guard.ts` (the deny-root checker needs it before anything
 * else runs) and re-exported here, which is the import path every existing
 * caller and test already uses.
 */
export { expandHomePrefix };

/**
 * Validate the shared half of a create request (seat, model, title).
 * Returns null after responding.
 */
function parseSeatFields(
  body: Record<string, unknown>,
  res: ServerResponse,
): { seatId: string; model?: string; title?: string } | null {
  const seatId = body['seatId'];
  const model = body['model'];
  const title = body['title'];
  if (typeof seatId !== 'string' || seatId.trim().length === 0) {
    sendInvalid(res, 'seatId is required');
    return null;
  }
  if (model !== undefined && (typeof model !== 'string' || model.length === 0)) {
    sendInvalid(res, 'model must be a non-empty string');
    return null;
  }
  if (title !== undefined && (typeof title !== 'string' || title.length > MAX_TITLE_CHARS)) {
    sendInvalid(res, `title must be a string of at most ${MAX_TITLE_CHARS} characters`);
    return null;
  }
  const out: { seatId: string; model?: string; title?: string } = { seatId: seatId.trim() };
  // Canonicalised, never refused, when it is a retired alias: a client that
  // remembered `claude-opus-5.5` from an older session (the per-project seat
  // memory does exactly that) means the model the label promised, and the
  // canonical id is what the seat catalog lists — and what the CLI resolves.
  if (typeof model === 'string') out.model = canonicalModelId(model);
  if (typeof title === 'string' && title.trim().length > 0) out.title = title.trim();
  return out;
}

/**
 * Keys POST /api/verse/sessions accepts. `workspaceName` is deliberately
 * absent: it is SERVER-FILLED from the registry (types.ts), and is refused
 * with its own message below rather than as an unknown key.
 */
const CREATE_SESSION_KEYS: ReadonlySet<string> = new Set([
  'projectPath',
  'seatId',
  'model',
  'title',
  'extraRoots',
  'workspaceId',
  'contextMode',
  'handoffFromSessionId',
]);

/**
 * The V3.9 half of a create request: an EXPLICIT context mode and the handoff
 * source id. Both are only shape-checked here — whether the mode exists for
 * the chosen model, and whether the source session exists, are decided once
 * the seat and engine are in hand (`resolveCreation`). Returns null after
 * responding.
 */
function parseContextFields(
  body: Record<string, unknown>,
  res: ServerResponse,
): { contextMode?: VerseContextMode; handoffFromSessionId?: string } | null {
  const contextMode = body['contextMode'];
  const handoffFrom = body['handoffFromSessionId'];
  if (contextMode !== undefined && !isContextMode(contextMode)) {
    sendInvalid(res, `contextMode must be one of: ${CONTEXT_MODE_LIST}`);
    return null;
  }
  if (handoffFrom !== undefined && (typeof handoffFrom !== 'string' || !VERSE_SESSION_ID_RE.test(handoffFrom))) {
    sendInvalid(res, 'handoffFromSessionId must be a session id');
    return null;
  }
  return {
    ...(contextMode !== undefined ? { contextMode } : {}),
    ...(typeof handoffFrom === 'string' ? { handoffFromSessionId: handoffFrom } : {}),
  };
}

/**
 * Parse a create request in either of its two spellings.
 *
 * `workspaceId` and the path spelling are MUTUALLY EXCLUSIVE and the mix is
 * rejected rather than resolved: silently preferring one would mean the
 * operator's stated roots and the session's actual roots could differ, and
 * that difference is exactly what a workspace exists to make legible.
 *
 * Every path — primary and extra alike — goes through the same deny-root
 * guard the enrollment registry uses, so `~/.ashlr` (provider tokens, the
 * KILL sentinel, the 0600 launcher records) can never become a session root.
 */
function parseCreateRequest(
  body: Record<string, unknown>,
  res: ServerResponse,
  store: VerseWorkspaceStore,
): VerseCreateSessionRequest | null {
  if (body['workspaceName'] !== undefined) {
    sendInvalid(res, 'workspaceName is filled in by the server from workspaceId; do not send it');
    return null;
  }
  if (rejectUnknownKeys(body, CREATE_SESSION_KEYS, res)) return null;
  const seatFields = parseSeatFields(body, res);
  if (!seatFields) return null;
  const contextFields = parseContextFields(body, res);
  if (!contextFields) return null;

  const workspaceId = body['workspaceId'];
  const projectPath = body['projectPath'];
  const extraRoots = body['extraRoots'];

  if (workspaceId !== undefined) {
    if (typeof workspaceId !== 'string' || workspaceId.trim().length === 0) {
      sendInvalid(res, 'workspaceId must be a non-empty string');
      return null;
    }
    if (projectPath !== undefined || extraRoots !== undefined) {
      sendInvalid(res, 'send workspaceId or projectPath/extraRoots, not both');
      return null;
    }
    const workspace = store.get(workspaceId.trim());
    if (!workspace) {
      sendInvalid(res, `unknown workspace: ${workspaceId.trim()}`);
      return null;
    }
    const primary = workspace.roots.find((r) => r.primary) ?? workspace.roots[0];
    if (!primary) {
      sendInvalid(res, `workspace ${workspace.name} has no roots`);
      return null;
    }
    const rest = workspace.roots.filter((r) => r.path !== primary.path).map((r) => r.path);
    return {
      projectPath: primary.path,
      ...(rest.length > 0 ? { extraRoots: rest } : {}),
      workspaceId: workspace.id,
      // Read from the registry, never from the body.
      workspaceName: workspace.name,
      ...seatFields,
      ...contextFields,
    };
  }

  if (typeof projectPath !== 'string' || projectPath.trim().length === 0 || projectPath.length > MAX_PATH_CHARS) {
    sendInvalid(res, 'projectPath is required');
    return null;
  }
  // GUARD ONLY — the checked value is deliberately discarded.
  //
  // `checkWorkspaceRootPath` returns the PHYSICAL path, and substituting it
  // here would change what the engine receives (`/var/…` → `/private/var/…`
  // on macOS) for every single-root chat that has ever worked. The engine
  // already realpaths in `resolveProjectDir`, so the stored record is
  // identical either way; what this call adds is the deny-root refusal, and
  // that is all it should add.
  const primaryCheck = checkWorkspaceRootPath(projectPath.trim());
  if (!primaryCheck.ok) {
    sendInvalid(res, primaryCheck.error);
    return null;
  }
  const primary = expandHomePrefix(projectPath.trim());

  const resolvedExtras: string[] = [];
  if (extraRoots !== undefined) {
    if (!Array.isArray(extraRoots)) {
      sendInvalid(res, 'extraRoots must be an array of absolute paths');
      return null;
    }
    if (extraRoots.length > VERSE_MAX_WORKSPACE_ROOTS - 1) {
      sendInvalid(res, `a session may have at most ${VERSE_MAX_WORKSPACE_ROOTS} roots`);
      return null;
    }
    for (const raw of extraRoots) {
      if (typeof raw !== 'string' || raw.length > MAX_PATH_CHARS) {
        sendInvalid(res, 'every extra root must be an absolute path');
        return null;
      }
      const check = checkWorkspaceRootPath(raw.trim());
      if (!check.ok) {
        sendInvalid(res, check.error);
        return null;
      }
      // Same rule as the primary: guard here, canonicalise in the engine.
      // `resolveExtraRoots` realpaths every entry, drops the one equal to the
      // primary and deduplicates — so a symlink and its target collapse to
      // one root there rather than being granted twice.
      const expanded = expandHomePrefix(raw.trim());
      if (!resolvedExtras.includes(expanded)) resolvedExtras.push(expanded);
    }
  }

  return {
    projectPath: primary,
    ...(resolvedExtras.length > 0 ? { extraRoots: resolvedExtras } : {}),
    ...seatFields,
    ...contextFields,
  };
}

/**
 * Everything POST /sessions resolves SERVER-SIDE before the engine sees the
 * request: the context mode (explicit, else the seat's preference), the
 * handoff provenance, and the shared-memory snapshot. Returns null after
 * responding.
 *
 * ORDER MATTERS. Every refusal below happens BEFORE `prepareProjectMemory`,
 * which creates the project's private memory directory — a request that is
 * going to be refused must not leave one behind. The engine re-validates the
 * model and mode (it is the authority and also serves non-HTTP callers); these
 * checks exist so the refusal comes first and carries a precise message.
 */
function resolveCreation(
  create: VerseCreateSessionRequest,
  launch: VerseSeatLaunch,
  engine: VerseEngineHandle,
  res: ServerResponse,
): { request: VerseCreateSessionRequest; options: VerseCreateOptions } | null {
  const seat = launch.seat;
  // Never forwarded: the engine takes provenance from `options.handoffFrom`,
  // which is resolved from the store below, never from the body.
  const { handoffFromSessionId, ...request } = create;

  // 1. Handoff source — the TITLE is read from the store, so a session can
  //    never be labelled "Continued from <anything the client chose>".
  let handoffFrom: { sessionId: string; title: string } | null = null;
  if (handoffFromSessionId !== undefined) {
    const source = engine.getSession(handoffFromSessionId);
    if (!source) {
      sendInvalid(res, `handoff source session not found: ${handoffFromSessionId}`);
      return null;
    }
    handoffFrom = { sessionId: source.id, title: source.title };
  }

  // 2. The model this session will run: the requested one, else the seat's
  //    first RUNNABLE model — the same default the engine applies, so a
  //    listed-but-unavailable model (one the pinned CLI is too old for) is
  //    never picked silently.
  if (seat.models.length === 0) {
    sendInvalid(res, `seat ${seat.id} has no models`);
    return null;
  }
  const modelId = request.model ?? seat.models.find((m) => !m.unavailableReason?.trim())?.id;
  if (!modelId) {
    sendInvalid(res, `seat ${seat.id} has no runnable models`);
    return null;
  }
  const option = seat.models.find((m) => m.id === modelId);
  if (!option) {
    sendInvalid(res, `model ${modelId} is not available on seat ${seat.id}`);
    return null;
  }
  if (typeof option.unavailableReason === 'string' && option.unavailableReason.trim().length > 0) {
    sendInvalid(res, `model ${modelId} cannot run on seat ${seat.id}: ${option.unavailableReason.trim()}`);
    return null;
  }

  // 3. Context mode. An EXPLICIT mode the model has no budget for is refused;
  //    a PREFERRED one is only a default, so it quietly yields to `standard`
  //    rather than failing a request that never named a mode. `standard` is
  //    left absent so the record keeps its pre-3.9 shape. (Loading
  //    preferences is total — a missing or mangled file reads as defaults.)
  const prefs = loadVersePreferences();
  if (request.contextMode !== undefined) {
    if (request.contextMode !== 'standard' && budgetFor(option, request.contextMode) === null) {
      sendInvalid(res, `model ${modelId} has no ${request.contextMode} context mode on seat ${seat.id}`);
      return null;
    }
  } else {
    const preferred = seatDefaultMode(prefs, seat.id);
    if (preferred !== 'standard' && budgetFor(option, preferred) !== null) request.contextMode = preferred;
  }

  // 4. Shared project memory, snapshotted now and pinned for the session's
  //    life. Grok can reach only its `--cwd`, so it is offered the memory
  //    read-only (the block says so); every other engine can be granted the
  //    directory. A failure to prepare it never blocks the chat.
  //
  //    `memory` is ALWAYS passed: a snapshot, or `null` for "decided off"
  //    (disabled by preference, or it could not be prepared). The engine
  //    records `null` as `memoryEnabled: false`, so the record says exactly
  //    what the session was given rather than leaving it unknown — absent is
  //    reserved for callers that never decided (pre-3.9 records).
  let memory: VerseCreateOptions['memory'] = null;
  if (memoryEnabledFor(prefs, request.projectPath)) {
    try {
      memory = prepareProjectMemory(request.projectPath, { writable: seat.engine !== 'grok' });
    } catch {
      memory = null;
    }
  }

  return {
    request,
    options: {
      memory,
      ...(handoffFrom ? { handoffFrom } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Workspace routes
// ---------------------------------------------------------------------------

/** A `VerseWorkspaceError` carries the contract's 400; anything else rethrows. */
function sendWorkspaceError(res: ServerResponse, err: unknown): boolean {
  if (err instanceof VerseWorkspaceError) {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: err.message });
    return true;
  }
  throw err;
}

function parseRootsField(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.length > VERSE_MAX_WORKSPACE_ROOTS) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0 || entry.length > MAX_PATH_CHARS) return null;
    out.push(entry.trim());
  }
  return out;
}

function isRootPriority(value: unknown): value is VerseRootPriority {
  return typeof value === 'string' && (VERSE_ROOT_PRIORITIES as readonly string[]).includes(value);
}

/** Workspaces + their live per-root facts + priorities, in one read. */
function workspacesResponse(store: VerseWorkspaceStore): VerseWorkspacesResponse {
  const workspaces: VerseWorkspace[] = store.list();
  const status: Record<string, VerseRootStatus[]> = {};
  for (const workspace of workspaces) {
    status[workspace.id] = describeRoots(workspace.roots.map((r) => r.path));
  }
  return {
    workspaces,
    status,
    priorities: store.priorities(),
    focusSectionId: store.focusSectionId(),
  };
}

/**
 * `/api/verse/workspaces[...]`.
 *
 * GETs are readable like every other Verse GET. Every mutation is a POST
 * behind `allowDispatch` + `passesMutationGate`, the same gate the session
 * routes use — a workspace decides what an agent can write to, so it is a
 * control-plane change, not a preference.
 */
async function handleWorkspaces(
  ctx: VerseApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
): Promise<boolean> {
  const store = getVerseWorkspaceStore();
  const prefix = `${VERSE_API_PREFIX}/workspaces`;

  if (path === prefix && method === 'GET') {
    sendJson(res, 200, workspacesResponse(store));
    return true;
  }

  if (method !== 'POST') {
    sendJson(res, 404, { error: `not found: ${method} ${path}` });
    return true;
  }
  if (!ctx.allowDispatch) {
    sendJson(res, 404, { error: 'not found' });
    return true;
  }
  if (!passesMutationGate(req, res, ctx.token)) return true;
  const body = await readJsonBody(req, res);
  if (!body) return true;

  try {
    // POST /api/verse/workspaces — create
    if (path === prefix) {
      const roots = parseRootsField(body['roots']);
      if (!roots) {
        sendInvalid(res, `roots must be 1-${VERSE_MAX_WORKSPACE_ROOTS} absolute paths`);
        return true;
      }
      const created = store.create(String(body['name'] ?? ''), roots, body['section'] === true);
      sendJson(res, 201, created);
      return true;
    }

    const rest = path.slice(`${prefix}/`.length).split('/');

    // POST /api/verse/workspaces/priority — rank one repo
    if (rest.length === 1 && rest[0] === 'priority') {
      const target = body['path'];
      const priority = body['priority'];
      if (typeof target !== 'string' || target.trim().length === 0 || target.length > MAX_PATH_CHARS) {
        sendInvalid(res, 'path is required');
        return true;
      }
      if (!isRootPriority(priority)) {
        sendInvalid(res, `priority must be one of ${VERSE_ROOT_PRIORITIES.join(', ')}`);
        return true;
      }
      const priorities = store.setPriority(target.trim(), priority);
      // Echo the ranked scope so the caller sees the ORDER it just changed,
      // and sees that ranking did not widen it.
      sendJson(res, 200, { ok: true, priorities, scope: buildAutonomyScopeView(store) });
      return true;
    }

    // POST /api/verse/workspaces/focus — focus one section, or clear it
    if (rest.length === 1 && rest[0] === 'focus') {
      const sectionId = body['sectionId'];
      if (sectionId !== null && (typeof sectionId !== 'string' || sectionId.trim().length === 0)) {
        sendInvalid(res, 'sectionId must be a workspace id or null');
        return true;
      }
      const focusSectionId = store.setFocusSection(sectionId === null ? null : sectionId.trim());
      sendJson(res, 200, { ok: true, focusSectionId, scope: buildAutonomyScopeView(store) });
      return true;
    }

    // POST /api/verse/workspaces/:id/(update|delete)
    const id = rest[0] ?? '';
    const action = rest[1] ?? '';
    if (!id || rest.length !== 2) {
      sendJson(res, 404, { error: `not found: ${method} ${path}` });
      return true;
    }

    if (action === 'delete') {
      if (!store.remove(id)) {
        sendJson(res, 404, { code: 'VERSE_SESSION_NOT_FOUND', error: `workspace not found: ${id}` });
        return true;
      }
      // Sessions already created from this workspace keep their PINNED roots
      // — deleting the definition never narrows or widens a live chat.
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (action !== 'update') {
      sendJson(res, 404, { error: `not found: ${method} ${path}` });
      return true;
    }

    const patch: { name?: string; roots?: string[]; section?: boolean } = {};
    if (body['name'] !== undefined) {
      if (typeof body['name'] !== 'string') {
        sendInvalid(res, 'name must be a string');
        return true;
      }
      patch.name = body['name'];
    }
    if (body['roots'] !== undefined) {
      const roots = parseRootsField(body['roots']);
      if (!roots) {
        sendInvalid(res, `roots must be 1-${VERSE_MAX_WORKSPACE_ROOTS} absolute paths`);
        return true;
      }
      patch.roots = roots;
    }
    if (body['section'] !== undefined) patch.section = body['section'] === true;
    sendJson(res, 200, store.update(id, patch));
    return true;
  } catch (err) {
    return sendWorkspaceError(res, err);
  }
}

// ---------------------------------------------------------------------------
// V3.9 context routes — preferences, context-fit, search, memory
// ---------------------------------------------------------------------------

/** The four top-level V3.9 routes, by the segment after `/api/verse/`. */
type ContextRoute = 'preferences' | 'context-fit' | 'search' | 'memory';

const CONTEXT_ROUTE_METHODS: Readonly<Record<ContextRoute, readonly string[]>> = {
  preferences: ['GET', 'POST'],
  'context-fit': ['GET'],
  search: ['GET'],
  memory: ['GET', 'POST'],
};

function contextRouteOf(path: string): ContextRoute | null {
  const segment = path.slice(`${VERSE_API_PREFIX}/`.length);
  return Object.prototype.hasOwnProperty.call(CONTEXT_ROUTE_METHODS, segment) ? (segment as ContextRoute) : null;
}

/**
 * Every key any `VersePreferencesUpdate` form may carry. Which COMBINATION is
 * valid is decided by preferences.ts's own parser, so the API and the store
 * can never disagree about what a well-formed update is.
 */
const PREFERENCES_KEYS: ReadonlySet<string> = new Set(['seatId', 'contextMode', 'memoryEnabled', 'projectPath']);
const MEMORY_WRITE_KEYS: ReadonlySet<string> = new Set(['projectPath', 'content']);
const CONTEXT_MODE_KEYS: ReadonlySet<string> = new Set(['mode']);
const HANDOFF_PREVIEW_KEYS: ReadonlySet<string> = new Set(['includeLastAssistant', 'focus']);

/** Every POST /api/verse/sessions/:id/<action>; anything else is a 404. */
const SESSION_POST_ACTIONS: ReadonlySet<string> = new Set([
  'turns',
  'cancel',
  'delete',
  'rename',
  'context-mode',
  'handoff-preview',
]);

/**
 * The gate every POST in this file sits behind, in the same order: 404 unless
 * the server allows dispatch, then the constant-time mutation token + JSON
 * Content-Type, then the body cap (64 KB unless `maxBytes` raises it for the
 * one route that needs more). Null after responding.
 */
async function readMutationBody(
  ctx: VerseApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes?: number,
): Promise<Record<string, unknown> | null> {
  if (!ctx.allowDispatch) {
    sendJson(res, 404, { error: 'not found' });
    return null;
  }
  if (!passesMutationGate(req, res, ctx.token)) return null;
  return readJsonBody(req, res, maxBytes);
}

/**
 * The body cap for POST /api/verse/memory ONLY.
 *
 * The memory file may be VERSE_MEMORY_MAX_BYTES of content, and JSON escaping
 * can roughly double that (every `"`, `\` and newline becomes two bytes; a
 * control character becomes six, but a memory file is prose). Under the shared
 * 65,536-byte cap a file anywhere near the documented limit could never be
 * saved: 64 KiB of content made a 65,711-byte body. 2× plus 8 KiB for the
 * envelope (`projectPath`, keys) admits any realistic file at the limit while
 * staying a bounded, small read. The CONTENT itself is still held to
 * VERSE_MEMORY_MAX_BYTES (413) after parsing.
 */
export const VERSE_MEMORY_BODY_MAX_BYTES = 2 * VERSE_MEMORY_MAX_BYTES + 8 * 1024;

// ── Memory round-trip honesty ─────────────────────────────────────────────
//
// Every response goes through sendJson() → sanitizePublicJson(), which rewrites
// the home directory as `~` and replaces secret-shaped strings with
// scrubSecrets()' marker. For most payloads that is pure hygiene; for
// `VerseProjectMemory.content` it is a lossy view of a file the operator can
// EDIT AND SAVE BACK. The sanitizer has no per-field opt-out, and adding one
// would mean serving raw secrets to the browser, so the view stays sanitized
// and the API is honest about it instead:
//
//   - GET/POST responses carry `contentSanitized: true` whenever the content
//     the client receives differs from the bytes on disk (absent otherwise, so
//     the wire shape is unchanged for the common case). The editor can say so
//     before the operator saves.
//   - POST refuses (409 VERSE_MEMORY_REDACTED) content with MORE redaction
//     markers than the file on disk — i.e. a save that would overwrite real
//     values with placeholders. The `~` rewrite is NOT refused: `~/x` still
//     names the same path for every reader of MEMORY.md, the flag discloses it,
//     and refusing it would make any memory that mentions a home path unsavable.

/** The placeholder scrubSecrets() (src/core/util/scrub.ts) writes in every rule. */
const SCRUB_REDACTION_MARKER = '[REDACTED]';

function countRedactionMarkers(text: string): number {
  return text.split(SCRUB_REDACTION_MARKER).length - 1;
}

function flagSanitizedMemory(memory: VerseProjectMemory): VerseProjectMemory {
  // The exact transform sendJson() is about to apply, so the flag is true iff
  // the client will receive something other than the file's bytes. Spread
  // only when set: an unsanitized memory keeps the pre-flag response shape.
  return sanitizePublicJson(memory.content) === memory.content ? memory : { ...memory, contentSanitized: true };
}

/**
 * `/api/verse/{preferences,context-fit,search,memory}`.
 *
 * NOTHING HERE SPENDS. Preferences and memory are private files under
 * ~/.ashlr/verse; context-fit runs `git ls-files` and stats; search reads the
 * durable event logs. None of them reaches a model, so none of them needs —
 * or bypasses — the local-only gate, which stays exactly where it was: at the
 * top of the engine's `startTurn`.
 *
 * Service modules report bad input as `VerseServiceError` (VERSE_INVALID →
 * 400, VERSE_TOO_LARGE → 413); those propagate to `handleVerseApi`'s catch
 * and reach the client through its shared, duck-typed `sendVerseError`.
 */
async function handleContextRoutes(
  ctx: VerseApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  route: ContextRoute,
): Promise<boolean> {
  if (!CONTEXT_ROUTE_METHODS[route].includes(method)) {
    sendJson(res, 404, { error: `not found: ${method} ${path}` });
    return true;
  }

  switch (route) {
    // ── /api/verse/preferences ───────────────────────────────────────────
    case 'preferences': {
      if (method === 'GET') {
        if (!readQuery(req, res, [])) return true;
        const body: VersePreferences = loadVersePreferences();
        sendJson(res, 200, body);
        return true;
      }
      const body = await readMutationBody(ctx, req, res);
      if (!body) return true;
      if (rejectUnknownKeys(body, PREFERENCES_KEYS, res)) return true;
      // Exactly one form, every value typed; throws VERSE_INVALID (400).
      parseVersePreferencesUpdate(body);
      let update = body as unknown as VersePreferencesUpdate;

      if ('seatId' in update) {
        // Setting a NON-default mode must name a seat that exists and has at
        // least one runnable model with a real budget for it — otherwise the
        // preference could never take effect and the dialog would show a
        // default the server silently ignores. Resetting to `standard` only
        // removes an entry, so it is allowed for a seat that is not currently
        // discovered (a local seat while Ollama is down).
        const { seatId, contextMode } = update;
        if (contextMode !== 'standard') {
          const discovery = await cachedSeats(ctx.cfg);
          const seat = discovery.seats.find((s) => s.id === seatId);
          if (!seat) {
            sendInvalid(res, `unknown seat: ${seatId}`);
            return true;
          }
          const supports = seat.models.some(
            (m) => !m.unavailableReason && budgetFor(m, contextMode) !== null
              && (contextMode !== 'expansive' || hasExpansiveMode(m)),
          );
          if (!supports) {
            sendInvalid(res, `seat ${seat.id} has no model with a ${contextMode} context mode`);
            return true;
          }
        }
      } else if ('projectPath' in update) {
        // The same path rule a session root obeys, and the PHYSICAL spelling
        // the store keys opt-outs on.
        const guard = guardRoot(update.projectPath, 'projectPath');
        if (!guard.ok) {
          sendInvalid(res, guard.error);
          return true;
        }
        update = { projectPath: guard.physical, memoryEnabled: update.memoryEnabled };
      }
      const stored: VersePreferences = updateVersePreferences(update);
      sendJson(res, 200, stored);
      return true;
    }

    // ── GET /api/verse/context-fit ───────────────────────────────────────
    // ?workspaceId=<id>  |  ?projectPath=<abs>[&extraRoots=<abs>]…
    // `extraRoots` REPEATS rather than being comma-joined: a comma is legal
    // in a path, a repeated parameter is unambiguous.
    case 'context-fit': {
      const params = readQuery(req, res, ['workspaceId', 'projectPath', 'extraRoots'], ['extraRoots']);
      if (!params) return true;
      const workspaceId = params.get('workspaceId');
      const projectPath = params.get('projectPath');
      const extraRoots = params.getAll('extraRoots');

      let candidates: string[];
      if (workspaceId !== null) {
        // Never mixed — the same rule POST /sessions applies, for the same
        // reason: the roots measured must be the roots the operator named.
        if (projectPath !== null || extraRoots.length > 0) {
          sendInvalid(res, 'send workspaceId or projectPath/extraRoots, not both');
          return true;
        }
        const id = workspaceId.trim();
        if (id.length === 0) {
          sendInvalid(res, 'workspaceId must be a non-empty string');
          return true;
        }
        const workspace = getVerseWorkspaceStore().get(id);
        if (!workspace) {
          sendInvalid(res, `unknown workspace: ${id}`);
          return true;
        }
        const primary = workspace.roots.find((r) => r.primary) ?? workspace.roots[0];
        if (!primary) {
          sendInvalid(res, `workspace ${workspace.name} has no roots`);
          return true;
        }
        candidates = [primary.path, ...workspace.roots.filter((r) => r.path !== primary.path).map((r) => r.path)];
      } else {
        if (projectPath === null) {
          sendInvalid(res, 'workspaceId or projectPath is required');
          return true;
        }
        if (extraRoots.length > VERSE_MAX_WORKSPACE_ROOTS - 1) {
          sendInvalid(res, `a session may have at most ${VERSE_MAX_WORKSPACE_ROOTS} roots`);
          return true;
        }
        candidates = [projectPath, ...extraRoots];
      }

      // Workspace roots are re-checked too: they were valid when saved, but a
      // root deleted since would otherwise be measured as zero tokens and the
      // badge would say "fits" about code that is not there. Duplicates (a
      // symlink and its target) are measured once.
      const roots: string[] = [];
      const seen = new Set<string>();
      for (const [index, candidate] of candidates.entries()) {
        const guard = guardRoot(candidate, index === 0 ? 'projectPath' : 'extraRoots entry');
        if (!guard.ok) {
          sendInvalid(res, guard.error);
          return true;
        }
        if (seen.has(guard.physical)) continue;
        seen.add(guard.physical);
        roots.push(guard.path);
      }
      const fit: VerseContextFit = await estimateContextFit(roots);
      sendJson(res, 200, fit);
      return true;
    }

    // ── GET /api/verse/search?q=&limit= ──────────────────────────────────
    case 'search': {
      const params = readQuery(req, res, ['q', 'limit']);
      if (!params) return true;
      const q = params.get('q');
      if (q === null || q.trim().length === 0) {
        sendInvalid(res, 'q is required');
        return true;
      }
      const rawLimit = params.get('limit');
      let limit: number | undefined;
      if (rawLimit !== null) {
        // Positive integer or 400, then CLAMPED by the service to its maximum
        // — the same convention GET /api/verse/audit follows.
        if (!/^\d{1,9}$/.test(rawLimit) || Number(rawLimit) < 1) {
          sendInvalid(res, 'limit must be a positive integer');
          return true;
        }
        limit = Number(rawLimit);
      }
      const engine = await getVerseEngine();
      const result: VerseSearchResponse = searchSessions({
        sessions: engine.listSessions(),
        readEvents: (id) => engine.getEvents(id),
        query: q.trim(),
        ...(limit !== undefined ? { limit } : {}),
      });
      sendJson(res, 200, result);
      return true;
    }

    // ── /api/verse/memory ────────────────────────────────────────────────
    case 'memory': {
      if (method === 'GET') {
        const params = readQuery(req, res, ['projectPath']);
        if (!params) return true;
        const guard = guardRoot(params.get('projectPath'), 'projectPath');
        if (!guard.ok) {
          sendInvalid(res, guard.error);
          return true;
        }
        // `enabled` is what a NEW session on this project would be offered;
        // sessions already running keep what they were created with.
        const memory: VerseProjectMemory = readProjectMemory(
          guard.physical,
          memoryEnabledFor(loadVersePreferences(), guard.physical),
        );
        sendJson(res, 200, flagSanitizedMemory(memory));
        return true;
      }
      const body = await readMutationBody(ctx, req, res, VERSE_MEMORY_BODY_MAX_BYTES);
      if (!body) return true;
      if (rejectUnknownKeys(body, MEMORY_WRITE_KEYS, res)) return true;
      const guard = guardRoot(body['projectPath'], 'projectPath');
      if (!guard.ok) {
        sendInvalid(res, guard.error);
        return true;
      }
      const content = body['content'];
      if (typeof content !== 'string') {
        sendInvalid(res, 'content must be a string ("" clears the memory)');
        return true;
      }
      if (Buffer.byteLength(content, 'utf8') > VERSE_MEMORY_MAX_BYTES) {
        sendJson(res, 413, { code: 'VERSE_TOO_LARGE', error: `content exceeds ${VERSE_MEMORY_MAX_BYTES} bytes` });
        return true;
      }
      // A save must not write the sanitizer's placeholders over the secrets
      // they stand for. Only an INCREASE is refused: a file that already holds
      // the literal marker (an agent quoting a scrubbed log) stays editable.
      const onDisk = readProjectMemory(guard.physical, false).content;
      if (countRedactionMarkers(content) > countRedactionMarkers(onDisk)) {
        sendJson(res, 409, {
          code: 'VERSE_MEMORY_REDACTED',
          error:
            `content contains ${SCRUB_REDACTION_MARKER} placeholders that stand in for secret-looking text in MEMORY.md; `
            + 'saving would replace the real values. Remove the placeholders, or edit MEMORY.md directly.',
        });
        return true;
      }
      // Allowed whether or not memory is enabled for the project: it is the
      // operator's own file, and clearing it must always work.
      const written: VerseProjectMemory = writeProjectMemory(guard.physical, content);
      sendJson(res, 200, flagSanitizedMemory(written));
      return true;
    }

    default: {
      const never: never = route;
      sendJson(res, 404, { error: `not found: ${method} ${String(never)}` });
      return true;
    }
  }
}

// ---------------------------------------------------------------------------
// Turn-time model check
// ---------------------------------------------------------------------------

/**
 * Why the session's model cannot run on its seat RIGHT NOW, or null to let the
 * turn proceed.
 *
 * Create refuses an unavailable model, but a session outlives the check: a
 * chat created on `claude-opus-5.5` before its seat was pinned to a CLI that
 * predates the model (2.1.257 < 2.1.280) is stored with that id and would
 * otherwise start a CLI that rejects it — a spawned process and a confusing
 * native error instead of the seat's own one-line reason. The model id is
 * canonicalised first, so a retired dotted alias finds its option.
 *
 * Deliberately permissive: only a CURRENT seat that LISTS the model with a
 * non-empty `unavailableReason` blocks. Discovery failing, the seat being gone
 * or the model not being listed at all keeps today's behaviour — the engine
 * starts the turn and reports whatever happens — because this is a fail-fast
 * convenience, not a new gate, and a flaky discovery must never lock a chat.
 */
async function unrunnableModelReason(cfg: AshlrConfig, session: VerseSession | null): Promise<string | null> {
  if (!session) return null; // sendTurn owns the 404
  let discovery: VerseSeatDiscovery;
  try {
    discovery = await cachedSeats(cfg);
  } catch {
    return null;
  }
  const seat = discovery.seats.find((s) => s.id === session.seatId);
  if (!seat) return null;
  const modelId = canonicalModelId(session.model);
  const reason = seat.models.find((m) => m.id === modelId)?.unavailableReason?.trim();
  if (!reason) return null;
  return `model ${modelId} cannot run on seat ${seat.id}: ${reason}`;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle one /api/verse/* request. Returns true when a response was written
 * (including error responses); false when `path` is not a verse route so
 * handleApi can continue to its own 404.
 */
export async function handleVerseApi(
  ctx: VerseApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
): Promise<boolean> {
  if (!isVerseApiPath(path)) return false;

  try {
    // ── GET /api/verse/bootstrap ─────────────────────────────────────────
    if (path === `${VERSE_API_PREFIX}/bootstrap` && method === 'GET') {
      const engine = await getVerseEngine();
      const discovery = await liveSeats(ctx.cfg);
      const sessions = engine.listSessions();
      const body: VerseBootstrap = {
        seats: discovery.seats,
        projects: discoverProjects({ sessions }),
        sessions,
        // NOT `workspaces`. Bootstrap's key set is asserted exactly by
        // test/verse-api.test.ts (the no-launcher-leak shape guard), and the
        // dialog wants `status` and `priorities` alongside the list anyway —
        // which only GET /api/verse/workspaces carries. Adding a key here
        // would have bought a round trip at the price of the frozen shape.
        dispatchEnabled: ctx.allowDispatch,
        localRuntime: discovery.localRuntime,
      };
      sendJson(res, 200, body);
      return true;
    }

    // ── GET /api/verse/seats ─────────────────────────────────────────────
    // The seat half of bootstrap, on its own so a client can POLL it. Bootstrap
    // is read once at mount; a user who opened the app before the account
    // collector's first cycle finished would otherwise keep a seat list that
    // says "unknown" forever, with no way to learn otherwise short of a reload.
    if (path === `${VERSE_API_PREFIX}/seats` && method === 'GET') {
      const discovery = await liveSeats(ctx.cfg);
      const body: VerseSeatsResponse = {
        sampledAt: new Date().toISOString(),
        seats: discovery.seats,
        localRuntime: discovery.localRuntime,
      };
      sendJson(res, 200, body);
      return true;
    }

    // ── /api/verse/workspaces ────────────────────────────────────────────
    // A workspace is NOT enrollment and cannot become it: nothing under this
    // prefix touches ~/.ashlr/enrollment.json. Mutations sit behind the same
    // dispatch gate as every other POST here.
    if (path === `${VERSE_API_PREFIX}/workspaces` || path.startsWith(`${VERSE_API_PREFIX}/workspaces/`)) {
      return handleWorkspaces(ctx, req, res, path, method);
    }

    // ── /api/verse/autonomy-scope ────────────────────────────────────────
    // Enrolled repos, ORDERED by section focus and priority. Read-only, and
    // derived by intersecting sections with the enrollment registry — so it
    // is always a subset of what the autonomous lane already reaches.
    if (path === `${VERSE_API_PREFIX}/autonomy-scope` && method === 'GET') {
      const view: VerseAutonomyScopeView = buildAutonomyScopeView(getVerseWorkspaceStore());
      sendJson(res, 200, view);
      return true;
    }

    // ── /api/verse/{preferences,context-fit,search,memory} (V3.9) ────────
    // AWAITED, not returned: a rejection must land in this function's catch
    // (which maps VERSE_INVALID → 400, VERSE_TOO_LARGE → 413) rather than
    // escape to handleApi's generic 500.
    const contextRoute = contextRouteOf(path);
    if (contextRoute !== null) {
      return await handleContextRoutes(ctx, req, res, path, method, contextRoute);
    }

    // ── /api/verse/sessions ──────────────────────────────────────────────
    if (path === `${VERSE_API_PREFIX}/sessions`) {
      if (method === 'GET') {
        const engine = await getVerseEngine();
        sendJson(res, 200, engine.listSessions());
        return true;
      }
      if (method === 'POST') {
        const body = await readMutationBody(ctx, req, res);
        if (!body) return true;
        const create = parseCreateRequest(body, res, getVerseWorkspaceStore());
        if (!create) return true;
        const discovery = await cachedSeats(ctx.cfg);
        const launch = discovery.launches.get(create.seatId);
        if (!launch) {
          sendInvalid(res, `unknown seat: ${create.seatId}`);
          return true;
        }
        const engine = await getVerseEngine();
        const resolved = resolveCreation(create, launch, engine, res);
        if (!resolved) return true;
        const session = engine.createSession(resolved.request, launch, resolved.options);
        sendJson(res, 201, session);
        return true;
      }
      sendJson(res, 404, { error: `not found: ${method} ${path}` });
      return true;
    }

    // ── GET /api/verse/sessions/:id/events (SSE) ─────────────────────────
    const eventsMatch = VERSE_EVENTS_PATH_RE.exec(path);
    if (eventsMatch && method === 'GET') {
      if (!ctx.readSession || ctx.readSession.expiresAt <= Date.now()) {
        sendJson(res, 401, { code: 'SESSION_REQUIRED', error: 'valid read session required' });
        return true;
      }
      const engine = await getVerseEngine();
      handleVerseEventsSse(req, res, engine, eventsMatch[1] ?? '', ctx.readSession);
      return true;
    }

    // ── /api/verse/sessions/:id[/action] ─────────────────────────────────
    const sessionsPrefix = `${VERSE_API_PREFIX}/sessions/`;
    if (path.startsWith(sessionsPrefix)) {
      const parts = path.slice(sessionsPrefix.length).split('/');
      const id = parts[0] ?? '';
      const action = parts[1] ?? '';
      if (!id || parts.length > 2) {
        sendJson(res, 404, { error: `not found: ${method} ${path}` });
        return true;
      }
      if (!VERSE_SESSION_ID_RE.test(id)) {
        sendInvalid(res, 'invalid session id');
        return true;
      }

      // GET /api/verse/sessions/:id/roots
      //
      // Per-root identity for the session: branch, dirty state and remote for
      // each root, whether the engine can actually reach it, and whether the
      // autonomous lane would. Computed live rather than stored, because a
      // branch recorded at session creation would be wrong by the next commit.
      if (method === 'GET' && action === 'roots') {
        const engine = await getVerseEngine();
        const session = engine.getSession(id);
        if (!session) {
          sendJson(res, 404, { code: 'VERSE_SESSION_NOT_FOUND', error: `session not found: ${id}` });
          return true;
        }
        const roots: VerseRootStatus[] = describeRoots(verseSessionRoots(session), { engine: session.engine });
        const body: VerseSessionRootsResponse = {
          sessionId: session.id,
          workspaceId: session.workspaceId ?? null,
          workspaceName: session.workspaceName ?? null,
          roots,
          notes: rootNotes(roots, session.engine),
        };
        sendJson(res, 200, body);
        return true;
      }

      // GET /api/verse/sessions/:id
      if (method === 'GET' && action === '') {
        const engine = await getVerseEngine();
        const session = engine.getSession(id);
        if (!session) {
          sendJson(res, 404, { code: 'VERSE_SESSION_NOT_FOUND', error: `session not found: ${id}` });
          return true;
        }
        const detail: VerseSessionDetail = { session, events: engine.getEvents(id) };
        sendJson(res, 200, detail);
        return true;
      }

      if (method !== 'POST' || !SESSION_POST_ACTIONS.has(action)) {
        sendJson(res, 404, { error: `not found: ${method} ${path}` });
        return true;
      }
      const body = await readMutationBody(ctx, req, res);
      if (!body) return true;
      const engine = await getVerseEngine();

      // POST /api/verse/sessions/:id/context-mode {mode}
      //
      // Changes CLI FLAGS from the next turn on, never prompt content, so the
      // provider cache survives the switch. The engine is the authority on
      // whether the model has a budget for the mode (VERSE_INVALID) and
      // refuses a switch while a turn runs (VERSE_SESSION_BUSY).
      if (action === 'context-mode') {
        if (rejectUnknownKeys(body, CONTEXT_MODE_KEYS, res)) return true;
        const mode = body['mode'];
        if (!isContextMode(mode)) {
          sendInvalid(res, `mode must be one of: ${CONTEXT_MODE_LIST}`);
          return true;
        }
        if (!engine.getSession(id)) {
          sendJson(res, 404, { code: 'VERSE_SESSION_NOT_FOUND', error: `session not found: ${id}` });
          return true;
        }
        const updated: VerseSession = engine.setContextMode(id, mode);
        sendJson(res, 200, updated);
        return true;
      }

      // POST /api/verse/sessions/:id/handoff-preview {includeLastAssistant?, focus?}
      //
      // A POST although it changes nothing, because building it runs
      // `git diff --stat` in every root — a subprocess, so it sits behind the
      // same gate as every other route that starts one. ZERO SPEND: the text
      // is assembled from the event log; the new session's first turn is
      // spent only when the operator presses send on it.
      if (action === 'handoff-preview') {
        if (rejectUnknownKeys(body, HANDOFF_PREVIEW_KEYS, res)) return true;
        const includeLastAssistant = body['includeLastAssistant'];
        const focus = body['focus'];
        if (includeLastAssistant !== undefined && typeof includeLastAssistant !== 'boolean') {
          sendInvalid(res, 'includeLastAssistant must be a boolean');
          return true;
        }
        // Its LENGTH (≤ 500 after trimming) is session-handoff.ts's rule and is
        // enforced there, so the API and the builder cannot disagree.
        if (focus !== undefined && typeof focus !== 'string') {
          sendInvalid(res, 'focus must be a string');
          return true;
        }
        const session = engine.getSession(id);
        if (!session) {
          sendJson(res, 404, { code: 'VERSE_SESSION_NOT_FOUND', error: `session not found: ${id}` });
          return true;
        }
        const focusLine = typeof focus === 'string' ? focus.trim() : '';
        const preview: VerseHandoffPreview = buildHandoffPreview(session, engine.getEvents(id), {
          ...(includeLastAssistant === true ? { includeLastAssistant: true } : {}),
          ...(focusLine.length > 0 ? { focus: focusLine } : {}),
        });
        sendJson(res, 200, preview);
        return true;
      }

      if (action === 'turns') {
        const text = body['text'];
        if (typeof text !== 'string' || text.trim().length === 0) {
          sendInvalid(res, 'text is required');
          return true;
        }
        if (Buffer.byteLength(text, 'utf8') > VERSE_MAX_TURN_TEXT_BYTES) {
          sendJson(res, 413, { code: 'VERSE_TOO_LARGE', error: `text exceeds ${VERSE_MAX_TURN_TEXT_BYTES} bytes` });
          return true;
        }
        const unavailable = await unrunnableModelReason(ctx.cfg, engine.getSession(id));
        if (unavailable !== null) {
          sendJson(res, 409, { code: 'VERSE_MODEL_UNAVAILABLE', error: unavailable });
          return true;
        }
        const result: VerseTurnResponse = engine.sendTurn(id, text);
        sendJson(res, 202, result);
        return true;
      }

      if (action === 'cancel') {
        if (!engine.getSession(id)) {
          sendJson(res, 404, { code: 'VERSE_SESSION_NOT_FOUND', error: `session not found: ${id}` });
          return true;
        }
        const cancelled = engine.cancelTurn(id);
        sendJson(res, 200, { ok: true, cancelled });
        return true;
      }

      if (action === 'delete') {
        if (!engine.getSession(id)) {
          sendJson(res, 404, { code: 'VERSE_SESSION_NOT_FOUND', error: `session not found: ${id}` });
          return true;
        }
        engine.deleteSession(id);
        sendJson(res, 200, { ok: true });
        return true;
      }

      // rename
      const title = body['title'];
      if (typeof title !== 'string' || title.trim().length === 0 || title.length > MAX_TITLE_CHARS) {
        sendInvalid(res, `title must be 1-${MAX_TITLE_CHARS} characters`);
        return true;
      }
      sendJson(res, 200, engine.renameSession(id, title.trim()));
      return true;
    }

    sendJson(res, 404, { error: `not found: ${method} ${path}` });
    return true;
  } catch (err) {
    if (!res.headersSent) sendVerseError(res, err);
    else if (!res.writableEnded) {
      try { res.end(); } catch { /* already gone */ }
    }
    return true;
  }
}
