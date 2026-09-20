/**
 * core/verse/control-api.ts — /api/verse/{control,caps,scope,audit,daemon,safety}
 * (owner B, V2). The autonomy CONTROL PLANE for the Verse cockpit.
 *
 * Mounted from src/core/web/api.ts's handleApi() BEFORE the V1 verse handler
 * (which 404s anything it does not recognize) and before the 404 fallthrough.
 * Same security posture as every other route there:
 *   - GETs sit behind the read-session boundary in server.ts.
 *   - POSTs are 404 unless ctx.allowDispatch, then passesMutationGate()
 *     (constant-time x-ashlr-token + JSON Content-Type), then readJsonBody()
 *     (64 KB cap via readBody).
 *   - Bodies are validated key-by-key; UNKNOWN KEYS ARE REJECTED.
 *   - Every response goes through sendJson() → sanitizePublicJson().
 *
 * Routes (see docs/VERSE-CONTRACT-V2.md):
 *   GET  /api/verse/control  → VerseControlSnapshot (the one Autonomy aggregate)
 *   GET  /api/verse/caps     → VerseCaps (the CONFIGURED limits)
 *   POST /api/verse/caps     → VerseCapsUpdateResult (partial, saved, live)
 *   GET  /api/verse/scope    → VerseScope (enrollment registry)
 *   POST /api/verse/scope    → VerseScopeResult (enroll / unenroll)
 *   GET  /api/verse/audit    → VerseAuditResponse (newest first, capped 500)
 *   POST /api/verse/daemon   → VerseDaemonActionResult
 *                              (start / stop / once / pause / resume)
 *   GET  /api/verse/safety   → SafetyReport (`ashlr verify-safety --json`)
 *
 * V2.1 telemetry (owner T, docs/VERSE-TELEMETRY-V2.md) — all GET:
 *   GET  /api/verse/accounts     → VerseAccountsSnapshot (real per-account windows,
 *                                  Codex credits/plan, the BINDING window, collector state)
 *   GET  /api/verse/usage-series → {window, byDay: DailyUsage[], estimated, caveats}
 *   GET  /api/verse/local-models → VerseLocalModelsSnapshot (residency, GPU/CPU
 *                                  split, tool capability, LM Studio availability)
 *
 * ── TWO FOOTGUNS, ENCODED HERE RATHER THAN LEFT TO THE UI ──────────────────
 *
 * 1. THE KILL SWITCH IS AN EMERGENCY STOP, NOT A PAUSE. `~/.ashlr/KILL` also
 *    makes the agent's own `mcp-native` write tools refuse. This module never
 *    engages it (POST /api/fleet/pause remains the only route that does) and
 *    always ships it as `killSwitch` alongside VERSE_KILL_SWITCH_NOTE.
 *    `POST /api/verse/daemon {action:'stop'}` is the ordinary stop — but note
 *    that `stopDaemon()` itself works BY setting the kill switch, so the
 *    result says so out loud instead of implying a narrower blast radius.
 *
 *    V2.1: `{action:'pause'|'resume'}` is the genuinely narrow control. It
 *    writes `~/.ashlr/daemon.paused` (core/daemon/pause.ts), which ONLY the
 *    daemon loop reads — `assertMayMutate`, `mcp-native`, and
 *    `mcp-native-engineer` never consult it, so a paused daemon leaves the
 *    agent's own write tools working. It travels on every daemon result and
 *    on the control aggregate as `pause`, a field distinct from `killSwitch`,
 *    so a client cannot conflate the two scopes even by accident.
 *
 * 2. STARTING THE DAEMON STARTS AN AUTONOMOUS AGENT. `{action:'start'|'once'}`
 *    refuses (409) when the kill switch is engaged, when the enrollment
 *    registry is empty or unreadable (a daemon with no scope is a no-op that
 *    looks like success), and when a daemon is already running. Every attempt
 *    — accepted or refused — is audited.
 *
 * SECURITY: nothing here ever returns, logs, or snapshots a launcher command,
 * a token, or an env value. The daemon spawn returns a pid and nothing else;
 * the daemon lock's `token` field is read for liveness and never serialized.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve as resolvePath, sep } from 'node:path';

import type { AshlrConfig, AuditEntry, DaemonConfig } from '../types.js';
import { loadConfigReadOnly, resolveSubscriptionMaxPercent, saveConfig } from '../config.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { buildControlSnapshot } from '../web/control.js';
import { getFrontierUsageSync } from '../usage/frontier-usage.js';
import { pendingCount } from '../inbox/store.js';
import { readAudit, audit } from '../sandbox/audit.js';
import {
  enroll,
  readEnrollmentRegistry,
  readKillSwitch,
  unenroll,
  type KillSwitchReadResult,
  type PolicyMutationResult,
} from '../sandbox/policy.js';
import { loadDaemonState, readDaemonLockOwner } from '../daemon/state.js';
import {
  pauseDaemon,
  readDaemonPause,
  resumeDaemon,
  type DaemonPauseReadResult,
} from '../daemon/pause.js';
import { buildRollup } from '../observability/rollup.js';
import { expandHomePrefix } from './verse-api.js';
import { buildVerseAccountsSnapshot, getVerseAccountCollector } from './accounts.js';
import { collectVerseLocalModels } from './local-models.js';
import { resolveAccountsRoot, resolveOllamaBaseUrl } from './seats.js';
import {
  VERSE_AUDIT_DEFAULT_LIMIT,
  VERSE_AUDIT_MAX_LIMIT,
  VERSE_AUDIT_MAX_SCAN,
  VERSE_CAPS_BOUNDS,
  VERSE_DAEMON_PAUSE_NOTE,
  VERSE_KILL_SWITCH_NOTE,
  type VerseAuditResponse,
  type VerseAuditResult,
  type VerseCapKey,
  type VerseCaps,
  type VerseCapsUpdate,
  type VerseCapsUpdateResult,
  type VerseControlErrorCode,
  type VerseControlSnapshot,
  type VerseDaemonAction,
  type VerseDaemonActionResult,
  type VerseDaemonPause,
  type VerseDaemonStateProjection,
  type VerseFleetEssentials,
  type VerseFoundryLimit,
  type VerseKillSwitch,
  type VerseScope,
  type VerseScopeResult,
} from './control-types.js';

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

const CONTROL_PREFIX = '/api/verse';

const CONTROL_ROUTES = new Set([
  `${CONTROL_PREFIX}/control`,
  `${CONTROL_PREFIX}/caps`,
  `${CONTROL_PREFIX}/scope`,
  `${CONTROL_PREFIX}/audit`,
  `${CONTROL_PREFIX}/daemon`,
  `${CONTROL_PREFIX}/safety`,
  // V2.1 telemetry (owner T) — all GET, all behind the read session.
  `${CONTROL_PREFIX}/accounts`,
  `${CONTROL_PREFIX}/usage-series`,
  `${CONTROL_PREFIX}/local-models`,
]);

/**
 * True for exactly the nine V2/V2.1 control routes. Anything else under
 * /api/verse/* stays with the V1 session handler.
 */
export function isVerseControlPath(path: string): boolean {
  return CONTROL_ROUTES.has(path);
}

export interface VerseControlApiContext {
  cfg: AshlrConfig;
  token: string;
  allowDispatch: boolean;
  readSession?: { id: string; expiresAt: number };
}

// ---------------------------------------------------------------------------
// Error + body helpers (mirrors verse-api.ts so both halves behave identically)
// ---------------------------------------------------------------------------

const ERROR_STATUS: Record<VerseControlErrorCode, 400 | 409 | 413 | 503> = {
  VERSE_INVALID: 400,
  VERSE_REFUSED: 409,
  VERSE_TOO_LARGE: 413,
  VERSE_UNAVAILABLE: 503,
};

function sendError(res: ServerResponse, code: VerseControlErrorCode, error: string): void {
  sendJson(res, ERROR_STATUS[code], { code, error });
}

function sendInvalid(res: ServerResponse, error: string): void {
  sendError(res, 'VERSE_INVALID', error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** readBody() + JSON.parse with the contract's error shape. Null after responding. */
async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendError(res, 'VERSE_TOO_LARGE', 'request body too large');
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

/** Read one query parameter off a request URL. Never throws. */
function queryParam(req: IncomingMessage, name: string): string | null {
  try {
    const value = new URL(req.url ?? '/', 'http://localhost').searchParams.get(name);
    return value === null || value.length === 0 ? null : value;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Kill switch projection
// ---------------------------------------------------------------------------

/**
 * Project the policy layer's kill-switch read for transport. Drops the
 * sentinel path (machine-local detail the cockpit has no use for) and always
 * carries the blast-radius note, so no caller can render the state without it.
 */
export function projectKillSwitch(read: KillSwitchReadResult): VerseKillSwitch {
  return {
    state: read.state,
    sourceState: read.sourceState,
    reason: read.reason,
    note: VERSE_KILL_SWITCH_NOTE,
  };
}

function currentKillSwitch(): VerseKillSwitch {
  try {
    return projectKillSwitch(readKillSwitch());
  } catch {
    return {
      state: 'unknown',
      sourceState: 'degraded',
      reason: 'uninspectable',
      note: VERSE_KILL_SWITCH_NOTE,
    };
  }
}

// ---------------------------------------------------------------------------
// Daemon pause projection (the NARROW stop)
// ---------------------------------------------------------------------------

/**
 * Project the daemon-scoped pause read for transport. Drops the sentinel path
 * (machine-local) exactly as the kill-switch projection does, and always
 * carries the narrow-blast-radius note so no surface can render "paused"
 * without also saying what stays working.
 */
export function projectDaemonPause(read: DaemonPauseReadResult): VerseDaemonPause {
  return {
    state: read.state,
    sourceState: read.sourceState,
    reason: read.reason,
    pausedAt: read.record?.pausedAt ?? null,
    by: read.record?.by ?? null,
    note: VERSE_DAEMON_PAUSE_NOTE,
  };
}

/**
 * The current pause state, degrading to `unknown` rather than to `running`.
 * FAIL SAFE in the same direction as the daemon itself: the loop treats an
 * unreadable sentinel as paused, so the cockpit must never claim otherwise.
 */
function currentDaemonPause(): VerseDaemonPause {
  try {
    return projectDaemonPause(readDaemonPause());
  } catch {
    return {
      state: 'unknown',
      sourceState: 'degraded',
      reason: 'uninspectable',
      pausedAt: null,
      by: null,
      note: VERSE_DAEMON_PAUSE_NOTE,
    };
  }
}

// ---------------------------------------------------------------------------
// Caps — read
// ---------------------------------------------------------------------------

/**
 * Built-in daemon defaults. These MIRROR `DEFAULTS` in core/daemon/loop.ts —
 * the values the daemon actually falls back to when config omits a key. They
 * are duplicated rather than imported because importing loop.ts here would
 * pull the entire dispatch chain into the web server's module graph.
 * `verse-caps.test.ts` asserts they stay in sync with loop.ts's literal.
 */
export const VERSE_CAPS_DEFAULTS: Pick<
  DaemonConfig,
  'dailyBudgetUsd' | 'perTickItems' | 'parallel' | 'intervalMs'
> = {
  dailyBudgetUsd: 1.0,
  perTickItems: 3,
  parallel: 2,
  intervalMs: 5 * 60_000,
};

function finitePositive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Project the CONFIGURED autonomy limits out of a config object.
 *
 * `defaulted` names every key whose value is a built-in default rather than
 * something on disk — the cockpit shows "$1.00/day (default)" instead of
 * implying the operator chose it.
 */
export function readVerseCaps(cfg: AshlrConfig): VerseCaps {
  const daemon = cfg.daemon ?? {};
  const defaulted: VerseCapKey[] = [];

  const scalar = (key: 'dailyBudgetUsd' | 'perTickItems' | 'parallel' | 'intervalMs'): number => {
    const configured = finitePositive(daemon[key]);
    if (configured === null) {
      defaulted.push(key);
      return VERSE_CAPS_DEFAULTS[key];
    }
    return configured;
  };

  const dailyBudgetUsd = scalar('dailyBudgetUsd');
  const perTickItems = scalar('perTickItems');
  const parallel = scalar('parallel');
  const intervalMs = scalar('intervalMs');

  const mode: 'batch' | 'continuous' = daemon.mode === 'continuous' ? 'continuous' : 'batch';
  if (daemon.mode !== 'batch' && daemon.mode !== 'continuous') defaulted.push('mode');

  const maxConcurrent = finitePositive(daemon.maxConcurrent);
  if (maxConcurrent === null) defaulted.push('maxConcurrent');

  const concurrency = {
    local: finitePositive(daemon.concurrency?.local),
    cloud: finitePositive(daemon.concurrency?.cloud),
    total: finitePositive(daemon.concurrency?.total),
  };
  if (concurrency.local === null && concurrency.cloud === null && concurrency.total === null) {
    defaulted.push('concurrency');
  }

  const rawSubscription = cfg.foundry?.subscriptionMaxPercent;
  const subscriptionMaxPercent = resolveSubscriptionMaxPercent(cfg);
  if (typeof rawSubscription !== 'number' || !Number.isFinite(rawSubscription)) {
    defaulted.push('subscriptionMaxPercent');
  }

  const foundryLimits = readFoundryLimits(cfg);
  if (foundryLimits.length === 0) defaulted.push('foundryLimits');

  defaulted.sort();
  return {
    dailyBudgetUsd,
    perTickItems,
    parallel,
    intervalMs,
    mode,
    maxConcurrent,
    concurrency,
    subscriptionMaxPercent,
    foundryLimits,
    defaulted,
  };
}

/** Flatten `cfg.foundry.limits` into a sorted, transportable array. */
function readFoundryLimits(cfg: AshlrConfig): VerseFoundryLimit[] {
  const limits = cfg.foundry?.limits;
  if (!limits || typeof limits !== 'object') return [];
  const out: VerseFoundryLimit[] = [];
  for (const [engine, entry] of Object.entries(limits)) {
    if (!entry || typeof entry !== 'object') continue;
    const window = (entry as { window?: unknown }).window;
    const max = finitePositive((entry as { max?: unknown }).max);
    if (typeof window !== 'string' || max === null) continue;
    out.push({ engine, window, max });
  }
  out.sort((a, b) => a.engine.localeCompare(b.engine));
  return out;
}

// ---------------------------------------------------------------------------
// Caps — validate
// ---------------------------------------------------------------------------

const CAP_KEYS = new Set<string>([
  'dailyBudgetUsd',
  'perTickItems',
  'parallel',
  'intervalMs',
  'mode',
  'maxConcurrent',
  'concurrency',
  'subscriptionMaxPercent',
  'foundryLimits',
]);

const CONCURRENCY_KEYS = new Set<string>(['local', 'cloud', 'total']);
const FOUNDRY_LIMIT_KEYS = new Set<string>(['engine', 'window', 'max']);

/** Max entries a single foundryLimits update may carry (bounds the write). */
const MAX_FOUNDRY_LIMIT_ENTRIES = 32;
/** Max length of an engine id / window label in an update. */
const MAX_LABEL_CHARS = 64;
/**
 * `foundryLimits[].engine` becomes an OBJECT KEY in `foundry.limits`. These
 * three spellings do not behave like keys on a normal object literal:
 * `__proto__` hits Object.prototype's setter (the write vanishes while the
 * route still reports it applied), and `constructor`/`prototype` persist as
 * junk the config schema never expected. `applyVerseCapsUpdate` builds its
 * merge map with a null prototype as well — this list is the honest 400 so
 * the caller is told the write was refused instead of silently losing it.
 */
const FORBIDDEN_ENGINE_KEYS = new Set<string>(['__proto__', 'constructor', 'prototype']);

export type VerseCapsParse =
  | { ok: true; update: VerseCapsUpdate }
  | { ok: false; error: string };

function bounded(
  value: unknown,
  key: string,
  bounds: { min: number; max: number },
  integer: boolean,
): number | string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `${key} must be a finite number`;
  }
  if (integer && !Number.isInteger(value)) {
    return `${key} must be an integer`;
  }
  if (value < bounds.min || value > bounds.max) {
    return `${key} must be between ${bounds.min} and ${bounds.max}`;
  }
  return value;
}

/**
 * Validate a POST /api/verse/caps body key-by-key. Unknown keys are a hard
 * rejection (not a silent drop) so a typo in a cap name can never read as a
 * successful save of a limit that was never applied.
 */
export function parseVerseCapsUpdate(body: Record<string, unknown>): VerseCapsParse {
  for (const key of Object.keys(body)) {
    if (!CAP_KEYS.has(key)) return { ok: false, error: `unknown key: ${key}` };
  }
  if (Object.keys(body).length === 0) {
    return { ok: false, error: 'body must contain at least one cap to update' };
  }

  const update: VerseCapsUpdate = {};

  const numeric = (
    key: 'dailyBudgetUsd' | 'perTickItems' | 'parallel' | 'intervalMs' | 'maxConcurrent' | 'subscriptionMaxPercent',
    bounds: { min: number; max: number },
    integer: boolean,
  ): string | null => {
    if (!(key in body)) return null;
    const result = bounded(body[key], key, bounds, integer);
    if (typeof result === 'string') return result;
    update[key] = result;
    return null;
  };

  const errors = [
    numeric('dailyBudgetUsd', VERSE_CAPS_BOUNDS.dailyBudgetUsd, false),
    numeric('perTickItems', VERSE_CAPS_BOUNDS.perTickItems, true),
    numeric('parallel', VERSE_CAPS_BOUNDS.parallel, true),
    numeric('intervalMs', VERSE_CAPS_BOUNDS.intervalMs, true),
    numeric('maxConcurrent', VERSE_CAPS_BOUNDS.maxConcurrent, true),
    numeric('subscriptionMaxPercent', VERSE_CAPS_BOUNDS.subscriptionMaxPercent, true),
  ].find((e) => e !== null);
  if (errors) return { ok: false, error: errors };

  if ('mode' in body) {
    const mode = body['mode'];
    if (mode !== 'batch' && mode !== 'continuous') {
      return { ok: false, error: "mode must be 'batch' or 'continuous'" };
    }
    update.mode = mode;
  }

  if ('concurrency' in body) {
    const raw = body['concurrency'];
    if (!isRecord(raw)) return { ok: false, error: 'concurrency must be an object' };
    for (const key of Object.keys(raw)) {
      if (!CONCURRENCY_KEYS.has(key)) {
        return { ok: false, error: `unknown key: concurrency.${key}` };
      }
    }
    if (Object.keys(raw).length === 0) {
      return { ok: false, error: 'concurrency must name at least one tier' };
    }
    const concurrency: { local?: number; cloud?: number; total?: number } = {};
    for (const key of ['local', 'cloud', 'total'] as const) {
      if (!(key in raw)) continue;
      const result = bounded(raw[key], `concurrency.${key}`, VERSE_CAPS_BOUNDS.concurrency, true);
      if (typeof result === 'string') return { ok: false, error: result };
      concurrency[key] = result;
    }
    update.concurrency = concurrency;
  }

  if ('foundryLimits' in body) {
    const raw = body['foundryLimits'];
    if (!Array.isArray(raw)) return { ok: false, error: 'foundryLimits must be an array' };
    if (raw.length > MAX_FOUNDRY_LIMIT_ENTRIES) {
      return { ok: false, error: `foundryLimits accepts at most ${MAX_FOUNDRY_LIMIT_ENTRIES} entries` };
    }
    const limits: VerseFoundryLimit[] = [];
    const seen = new Set<string>();
    for (const entry of raw) {
      if (!isRecord(entry)) return { ok: false, error: 'foundryLimits entries must be objects' };
      for (const key of Object.keys(entry)) {
        if (!FOUNDRY_LIMIT_KEYS.has(key)) {
          return { ok: false, error: `unknown key: foundryLimits.${key}` };
        }
      }
      const engine = entry['engine'];
      const window = entry['window'];
      if (typeof engine !== 'string' || engine.length === 0 || engine.length > MAX_LABEL_CHARS) {
        return { ok: false, error: 'foundryLimits[].engine must be a non-empty string' };
      }
      if (FORBIDDEN_ENGINE_KEYS.has(engine)) {
        return { ok: false, error: `foundryLimits[].engine must not be '${engine}'` };
      }
      if (typeof window !== 'string' || window.length === 0 || window.length > MAX_LABEL_CHARS) {
        return { ok: false, error: 'foundryLimits[].window must be a non-empty string' };
      }
      const max = bounded(entry['max'], 'foundryLimits[].max', VERSE_CAPS_BOUNDS.foundryLimitMax, true);
      if (typeof max === 'string') return { ok: false, error: max };
      if (seen.has(engine)) {
        return { ok: false, error: `foundryLimits names ${engine} more than once` };
      }
      seen.add(engine);
      limits.push({ engine, window, max });
    }
    update.foundryLimits = limits;
  }

  return { ok: true, update };
}

// ---------------------------------------------------------------------------
// Caps — apply
// ---------------------------------------------------------------------------

/**
 * Merge a validated update into `cfg`, returning a NEW config plus the keys
 * that actually changed. Pure: it neither reads nor writes the filesystem.
 * `foundryLimits` merges per engine — engines the request did not name keep
 * their existing limit.
 */
export function applyVerseCapsUpdate(
  cfg: AshlrConfig,
  update: VerseCapsUpdate,
): { cfg: AshlrConfig; applied: VerseCapKey[] } {
  const before = readVerseCaps(cfg);
  const daemon: Partial<DaemonConfig> = { ...(cfg.daemon ?? {}) };
  const applied: VerseCapKey[] = [];

  for (const key of ['dailyBudgetUsd', 'perTickItems', 'parallel', 'intervalMs'] as const) {
    const value = update[key];
    if (value === undefined) continue;
    daemon[key] = value;
    if (before[key] !== value || before.defaulted.includes(key)) applied.push(key);
  }
  if (update.mode !== undefined) {
    daemon.mode = update.mode;
    if (before.mode !== update.mode || before.defaulted.includes('mode')) applied.push('mode');
  }
  if (update.maxConcurrent !== undefined) {
    daemon.maxConcurrent = update.maxConcurrent;
    if (before.maxConcurrent !== update.maxConcurrent) applied.push('maxConcurrent');
  }
  if (update.concurrency !== undefined) {
    const next = { ...(daemon.concurrency ?? {}) };
    let changed = false;
    for (const key of ['local', 'cloud', 'total'] as const) {
      const value = update.concurrency[key];
      if (value === undefined) continue;
      if (next[key] !== value) changed = true;
      next[key] = value;
    }
    daemon.concurrency = next;
    if (changed) applied.push('concurrency');
  }

  let foundry = cfg.foundry;
  if (update.subscriptionMaxPercent !== undefined) {
    foundry = { ...(foundry ?? {}), subscriptionMaxPercent: update.subscriptionMaxPercent };
    if (before.subscriptionMaxPercent !== update.subscriptionMaxPercent) {
      applied.push('subscriptionMaxPercent');
    }
  }
  if (update.foundryLimits !== undefined) {
    // Null prototype on purpose: the engine id is attacker-shaped input used
    // as an object key. On a normal literal, `merged['__proto__'] = …` hits
    // Object.prototype's setter and the write silently vanishes while the
    // route reports it applied. parseVerseCapsUpdate already 400s the three
    // dangerous spellings; this is the second lock on the same door.
    const merged: Record<string, { window: string; max: number }> = Object.assign(
      Object.create(null) as Record<string, { window: string; max: number }>,
      (foundry?.limits ?? {}) as Record<string, { window: string; max: number }>,
    );
    let changed = false;
    for (const limit of update.foundryLimits) {
      const existing = merged[limit.engine];
      if (!existing || existing.window !== limit.window || existing.max !== limit.max) changed = true;
      merged[limit.engine] = { window: limit.window, max: limit.max };
    }
    foundry = {
      ...(foundry ?? {}),
      limits: merged as NonNullable<AshlrConfig['foundry']>['limits'],
    };
    if (changed) applied.push('foundryLimits');
  }

  const next: AshlrConfig = { ...cfg, daemon };
  if (foundry !== cfg.foundry) next.foundry = foundry;
  return { cfg: next, applied };
}

/**
 * Read the config from disk, falling back to the server's in-memory copy when
 * the file cannot be read. Caps are read fresh on every request because the
 * daemon re-reads the file each tick — the FILE is the truth the daemon obeys,
 * not whatever this server loaded at boot.
 */
function freshConfig(fallback: AshlrConfig): AshlrConfig {
  try {
    return loadConfigReadOnly();
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Scope — enrollment registry
// ---------------------------------------------------------------------------

/** Read the enrollment registry as the cockpit's scope view. Never throws. */
export function readVerseScope(): VerseScope {
  let snapshot;
  try {
    snapshot = readEnrollmentRegistry();
  } catch {
    return { repos: [], degradedReason: 'unreadable-registry' };
  }
  if (snapshot.state === 'degraded') {
    return { repos: [], degradedReason: snapshot.reason };
  }
  return {
    repos: snapshot.repos.map((path) => ({
      path,
      name: basename(path) || path,
      exists: isDirectory(path),
    })),
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Fully resolved physical path, or null when it cannot be resolved. */
function physicalPath(path: string): string | null {
  try {
    return existsSync(path) ? realpathSync.native(path) : null;
  } catch {
    return null;
  }
}

function isUnder(path: string, root: string): boolean {
  const r = resolvePath(root);
  const p = resolvePath(path);
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** Longest path a scope request may carry. */
const MAX_SCOPE_PATH_CHARS = 4096;

export type VerseScopePathCheck =
  | { ok: true; path: string }
  | { ok: false; error: string };

/**
 * A directory autonomous scope may never cover, and how far the ban reaches.
 *
 *  - `exact`    — only the root itself (the filesystem root: everything is
 *                 "under" it, so containment would reject every path).
 *  - `ancestor` — the root itself, plus any directory that CONTAINS it. The
 *                 home directory: ordinary repos live inside it, so being
 *                 under it is fine, but enrolling `/Users` (which would drag
 *                 the whole home in) is not.
 *  - `both`     — the root itself, anything under it, and anything containing
 *                 it. Used for the two control directories.
 */
interface ScopeDenyRoot {
  path: string;
  label: string;
  reach: 'exact' | 'ancestor' | 'both';
}

/**
 * The roots autonomous scope must never cover, most-meaningful message first.
 *
 * `~/.ashlr` is the agent's own control directory: config.json (which can hold
 * provider tokens in plaintext), enrollment.json, the KILL sentinel, and the
 * private 0600 `verse/*.launch.json` launcher records. `isEnrolled()` is the
 * gate on the mcp-native write tools, so enrolling it would hand those tools
 * the very files that bound them.
 *
 * Re-resolved from `homedir()` on every call so a relocated HOME (tests, a
 * moved home dir) is honored — the same rule config.ts follows.
 */
function scopeDenyRoots(artifactsRoot: string): ScopeDenyRoot[] {
  const home = resolvePath(homedir());
  return [
    { path: resolvePath(sep), label: 'the filesystem root', reach: 'exact' },
    { path: home, label: 'your home directory', reach: 'ancestor' },
    { path: join(home, '.ashlr'), label: '~/.ashlr', reach: 'both' },
    { path: artifactsRoot, label: '~/.codex/artifacts', reach: 'both' },
  ];
}

/**
 * First deny rule `candidate` trips, or null. `verb` distinguishes the lexical
 * pass ("is under") from the physical one ("resolves under") so the operator
 * can tell a plain path from a symlink escape.
 */
function deniedScopeRoot(
  candidate: string,
  roots: readonly ScopeDenyRoot[],
  verb: 'is' | 'resolves',
): string | null {
  for (const root of roots) {
    if (candidate === root.path) {
      return `${root.label} cannot be enrolled as autonomous scope`;
    }
    if (root.reach === 'both' && isUnder(candidate, root.path)) {
      return `path ${verb === 'is' ? 'is' : 'resolves'} under ${root.label} and cannot be enrolled`;
    }
    if (root.reach !== 'exact' && isUnder(root.path, candidate)) {
      return `path contains ${root.label} and cannot be enrolled`;
    }
  }
  return null;
}

/**
 * Validate a scope path before it reaches the enrollment registry.
 *
 * Rejects: relative paths, NUL bytes, over-long paths, and anything that
 * resolves — LEXICALLY OR PHYSICALLY — into (or around) one of the forbidden
 * roots above: `~/.codex/artifacts` (codex's scratch checkouts), `~/.ashlr`
 * (the agent's own control directory), the home directory itself, and the
 * filesystem root. Checking both spellings is the symlink-escape guard: a
 * symlink whose target sits inside a forbidden root is rejected even though
 * its own path looks innocent.
 *
 * `requireDirectory` is true for enroll (you cannot take scope over something
 * that is not there) and false for unenroll (a repo deleted from disk must
 * still be removable from the registry).
 */
export function checkVerseScopePath(
  raw: string,
  opts: { requireDirectory: boolean; artifactsRoot?: string },
): VerseScopePathCheck {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, error: 'path is required' };
  }
  if (raw.length > MAX_SCOPE_PATH_CHARS) {
    return { ok: false, error: `path must be at most ${MAX_SCOPE_PATH_CHARS} characters` };
  }
  if (raw.includes('\0')) {
    return { ok: false, error: 'path must not contain NUL bytes' };
  }
  // sanitizePublicJson rewrites $HOME as `~` on the way out, so a path the UI
  // read back from us comes in with that spelling. Expand it before checking.
  const expanded = expandHomePrefix(raw);
  if (!isAbsolute(expanded)) {
    return { ok: false, error: 'path must be absolute' };
  }

  const lexical = resolvePath(expanded);
  const artifactsRoot = opts.artifactsRoot ?? join(homedir(), '.codex', 'artifacts');
  const lexicalRoots = scopeDenyRoots(artifactsRoot);
  const lexicalDenial = deniedScopeRoot(lexical, lexicalRoots, 'is');
  if (lexicalDenial !== null) return { ok: false, error: lexicalDenial };

  // Physical identity: resolves symlinks, so an escape into a forbidden root
  // is caught even when the spelling hides it. Both sides are resolved — the
  // home directory itself can sit behind a symlink (macOS /var → /private/var),
  // and comparing a resolved path against an unresolved root would miss.
  const physical = physicalPath(lexical);
  if (physical !== null) {
    const physicalRoots = lexicalRoots.map((root) => ({
      ...root,
      path: physicalPath(root.path) ?? root.path,
    }));
    const physicalDenial = deniedScopeRoot(physical, physicalRoots, 'resolves');
    if (physicalDenial !== null) return { ok: false, error: physicalDenial };
  }

  if (opts.requireDirectory && !isDirectory(lexical)) {
    return { ok: false, error: 'path must be an existing directory' };
  }
  // Return the PHYSICAL path when one exists: that is what enroll() stores in
  // the registry, so the mutation result and the scope listing agree and the
  // UI never has to reconcile two spellings of the same repo. A path that is
  // gone (unenroll) keeps its lexical spelling — unenroll() matches both.
  return { ok: true, path: physical ?? lexical };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

const AUDIT_RESULTS = new Set<string>(['ok', 'refused', 'error']);
/** Max length of the `action` filter (it is a substring match, not a regex). */
const MAX_AUDIT_FILTER_CHARS = 128;

export type VerseAuditQuery =
  | { ok: true; limit: number; action: string | null; result: VerseAuditResult | null }
  | { ok: false; error: string };

/** Validate the GET /api/verse/audit query string. */
export function parseVerseAuditQuery(raw: {
  limit: string | null;
  action: string | null;
  result: string | null;
}): VerseAuditQuery {
  let limit = VERSE_AUDIT_DEFAULT_LIMIT;
  if (raw.limit !== null) {
    const parsed = Number(raw.limit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return { ok: false, error: 'limit must be a positive integer' };
    }
    limit = Math.min(parsed, VERSE_AUDIT_MAX_LIMIT);
  }
  if (raw.action !== null && raw.action.length > MAX_AUDIT_FILTER_CHARS) {
    return { ok: false, error: `action filter must be at most ${MAX_AUDIT_FILTER_CHARS} characters` };
  }
  if (raw.result !== null && !AUDIT_RESULTS.has(raw.result)) {
    return { ok: false, error: "result must be one of: ok, refused, error" };
  }
  return {
    ok: true,
    limit,
    action: raw.action,
    result: raw.result === null ? null : (raw.result as VerseAuditResult),
  };
}

/**
 * Read the audit trail, newest first, filtered and capped.
 *
 * A filtered query has to scan past non-matching entries to fill `limit`, so
 * the scan itself is bounded by VERSE_AUDIT_MAX_SCAN and the response reports
 * `truncated` honestly rather than implying it reached the end of history.
 */
export function readVerseAudit(query: {
  limit: number;
  action: string | null;
  result: VerseAuditResult | null;
}): VerseAuditResponse {
  const filtering = query.action !== null || query.result !== null;
  const scanLimit = filtering ? VERSE_AUDIT_MAX_SCAN : query.limit;

  let raw: AuditEntry[];
  try {
    raw = readAudit(scanLimit);
  } catch {
    raw = [];
  }

  const needle = query.action === null ? null : query.action.toLowerCase();
  const entries = raw
    .filter((entry) => {
      if (query.result !== null && entry.result !== query.result) return false;
      if (needle !== null && !String(entry.action ?? '').toLowerCase().includes(needle)) return false;
      return true;
    })
    .slice(0, query.limit);

  return {
    entries,
    limit: query.limit,
    filter: { action: query.action, result: query.result },
    scanned: raw.length,
    truncated: raw.length >= scanLimit,
  };
}

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

const DAEMON_ACTIONS = new Set<string>(['start', 'stop', 'once', 'pause', 'resume']);

/** Signature of the detached launcher, so tests can substitute a recorder. */
export type VerseDaemonSpawner = (opts: { once: boolean }) => {
  ok: boolean;
  pid: number | null;
  reason: string;
};

let spawnerOverride: VerseDaemonSpawner | null = null;

/**
 * TEST SEAM: replace the detached `ashlr daemon start` launcher (pass null to
 * restore the real one). Route tests must never actually start an autonomous
 * agent, so every accepted-start assertion goes through this.
 */
export function setVerseDaemonSpawnerForTest(next: VerseDaemonSpawner | null): void {
  spawnerOverride = next;
}

async function spawnDaemon(once: boolean): Promise<{ ok: boolean; pid: number | null; reason: string }> {
  if (spawnerOverride) return spawnerOverride({ once });
  const { spawnDetachedDaemonStart } = await import('../../cli/daemon.js');
  return spawnDetachedDaemonStart({ once });
}

/** Non-secret projection of the persisted daemon state. Never throws. */
export function projectDaemonState(): VerseDaemonStateProjection {
  try {
    const state = loadDaemonState();
    return {
      running: state.running === true,
      pid: typeof state.pid === 'number' ? state.pid : null,
      startedAt: state.startedAt ?? null,
      lastTickAt: state.lastTickAt ?? null,
      todayDate: state.todayDate ?? null,
      todaySpentUsd: typeof state.todaySpentUsd === 'number' ? state.todaySpentUsd : 0,
      itemsProcessed: typeof state.itemsProcessed === 'number' ? state.itemsProcessed : 0,
    };
  } catch {
    return {
      running: false,
      pid: null,
      startedAt: null,
      lastTickAt: null,
      todayDate: null,
      todaySpentUsd: 0,
      itemsProcessed: 0,
    };
  }
}

/**
 * True when a daemon process currently holds the singleton lock.
 * Reads ONLY the owner's pid for a liveness probe — the lock record also
 * carries a token, which is never read out of this function.
 */
function daemonLockHeld(): boolean {
  try {
    const owner = readDaemonLockOwner();
    if (!owner || !Number.isFinite(owner.pid) || owner.pid <= 0) return false;
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException)?.code !== 'ESRCH';
    }
  } catch {
    return false;
  }
}

function auditDaemonAction(action: VerseDaemonAction, summary: string, ok: boolean): void {
  try {
    audit({
      action: `verse:daemon:${action}`,
      repo: null,
      sandboxId: null,
      summary,
      result: ok ? 'ok' : 'refused',
    });
  } catch {
    // audit() already swallows its own errors; this guard covers a thrown path().
  }
}

function daemonResult(
  action: VerseDaemonAction,
  ok: boolean,
  note: string,
  spawn: { spawned: boolean; pid: number | null } = { spawned: false, pid: null },
): VerseDaemonActionResult {
  return {
    ok,
    action,
    spawned: spawn.spawned,
    pid: spawn.pid,
    state: projectDaemonState(),
    killSwitch: currentKillSwitch(),
    pause: currentDaemonPause(),
    note,
  };
}

/**
 * Run one daemon lifecycle action. Exported so `verse-control-api.test.ts` can
 * exercise the refusal ladder without an HTTP round trip.
 *
 * REFUSAL LADDER for start/once, in order:
 *   1. kill switch engaged (or uninspectable) → refuse
 *   2. enrollment registry empty or degraded  → refuse
 *   3. a daemon already holds the lock        → refuse
 * Every outcome, accepted or refused, is audited.
 *
 * 'pause' and 'resume' sit ABOVE that ladder deliberately. Pausing needs no
 * scope, no clear kill switch, and no running daemon — a pause that refused
 * because the loop happened to be between ticks would be a pause the operator
 * cannot trust. Resuming is likewise always allowed: it clears one sentinel
 * and starts nothing, so the start ladder still applies when they press Start.
 */
export async function runVerseDaemonAction(
  action: VerseDaemonAction,
): Promise<{ status: 200 | 409 | 500; body: VerseDaemonActionResult }> {
  if (action === 'pause' || action === 'resume') {
    const on = action === 'pause';
    const mutation = on
      ? pauseDaemon('verse-control-plane')
      : resumeDaemon('verse-control-plane');
    const note = mutation.ok
      ? on
        ? (mutation.changed
            ? 'Autonomous dispatch paused. Your own write tools are unaffected — the global kill switch was not touched. Resume restores the loop without a restart.'
            : 'Already paused. Autonomous dispatch was halted; the global kill switch is not engaged.')
        : (mutation.changed
            ? 'Autonomous dispatch resumed. A running loop picks up on its next cycle; a stopped one still needs Start.'
            : 'Already running. Autonomous dispatch was not paused.')
      : `Could not ${action} autonomous dispatch (${mutation.reason}). The daemon is treated as PAUSED until the sentinel reads cleanly.`;
    auditDaemonAction(
      action,
      `verse control plane requested daemon ${action}: ${mutation.reason}`,
      mutation.ok,
    );
    return {
      status: mutation.ok ? 200 : 500,
      body: daemonResult(action, mutation.ok, note),
    };
  }

  if (action === 'stop') {
    const { stopDaemon } = await import('../daemon/loop.js');
    const mutation = stopDaemon();
    const ok = mutation === undefined || (mutation.ok && mutation.quiesced);
    const reason = mutation === undefined ? 'stop requested' : mutation.reason;
    // HONEST: stopDaemon() works BY engaging the global kill switch, which
    // also refuses the agent's own write tools. Saying "stopped" without
    // saying that would misrepresent the blast radius.
    const note = ok
      ? 'Daemon stop requested. This sets the global kill switch, which also refuses the agent\'s own write tools until it is cleared. Pause is the narrower halt if you only meant to stop the loop.'
      : `Daemon stop could not confirm quiescence: ${reason}`;
    auditDaemonAction('stop', `verse control plane requested daemon stop: ${reason}`, ok);
    return { status: ok ? 200 : 409, body: daemonResult('stop', ok, note) };
  }

  const kill = currentKillSwitch();
  if (kill.state !== 'inactive') {
    const note = kill.state === 'active'
      ? 'Refused: the global kill switch is engaged. Clear it before starting the loop.'
      : `Refused: the kill switch state could not be read (${kill.reason}); failing closed.`;
    auditDaemonAction(action, `verse control plane refused daemon ${action}: kill switch ${kill.state}`, false);
    return { status: 409, body: daemonResult(action, false, note) };
  }

  // A paused daemon that is told to start would spawn, park, and report
  // success — a loop that looks running and does nothing. Refuse and name the
  // one-click fix instead, the same way the empty-scope refusal does.
  const pause = currentDaemonPause();
  if (pause.state !== 'running') {
    const note = pause.state === 'paused'
      ? 'Refused: autonomous dispatch is paused. Resume first — the loop would start and immediately park.'
      : `Refused: the pause sentinel could not be read (${pause.reason}); the daemon is treated as paused, so this fails closed.`;
    auditDaemonAction(action, `verse control plane refused daemon ${action}: dispatch ${pause.state}`, false);
    return { status: 409, body: daemonResult(action, false, note) };
  }

  const scope = readVerseScope();
  if (scope.degradedReason !== undefined) {
    const note = `Refused: the enrollment registry could not be read (${scope.degradedReason}).`;
    auditDaemonAction(action, `verse control plane refused daemon ${action}: enrollment ${scope.degradedReason}`, false);
    return { status: 409, body: daemonResult(action, false, note) };
  }
  if (scope.repos.length === 0) {
    const note =
      'Refused: no repositories are enrolled, so the loop would do nothing. Add scope first.';
    auditDaemonAction(action, `verse control plane refused daemon ${action}: enrollment registry empty`, false);
    return { status: 409, body: daemonResult(action, false, note) };
  }

  if (daemonLockHeld()) {
    const note = 'Refused: a daemon already holds the singleton lock.';
    auditDaemonAction(action, `verse control plane refused daemon ${action}: singleton lock held`, false);
    return { status: 409, body: daemonResult(action, false, note) };
  }

  const spawned = await spawnDaemon(action === 'once');
  if (!spawned.ok) {
    const note = `Could not launch the daemon (${spawned.reason}).`;
    auditDaemonAction(action, `verse control plane daemon ${action} failed: ${spawned.reason}`, false);
    return { status: spawned.reason === 'reentrancy-refused' ? 409 : 500, body: daemonResult(action, false, note) };
  }

  const note = action === 'once'
    ? 'Single tick launched. It proposes only: every result lands in the approval inbox.'
    : 'Autonomous loop launched. It proposes only: every result lands in the approval inbox.';
  auditDaemonAction(action, `verse control plane launched daemon ${action} (pid ${spawned.pid ?? 0})`, true);
  return {
    status: 200,
    body: daemonResult(action, true, note, { spawned: true, pid: spawned.pid }),
  };
}

// ---------------------------------------------------------------------------
// Control aggregate
// ---------------------------------------------------------------------------

function projectFleetEssentials(
  control: Awaited<ReturnType<typeof buildControlSnapshot>>,
): VerseFleetEssentials {
  const service = control.daemon.service;
  return {
    directionMode: control.daemon.activeDirectionMode ?? null,
    directionAt: control.daemon.activeDirectionAt ?? null,
    directionReason: control.daemon.activeDirectionReason ?? null,
    autonomyControlLoop: control.daemon.autonomyControlLoop === true,
    autonomyControlMode: String(control.daemon.autonomyControlMode ?? 'disabled'),
    service: {
      registrationState: service?.registrationState ?? 'unknown',
      installed: service?.installed === true,
      running: service?.running === true,
      runtimeState: service?.runtimeState ?? null,
    },
    freshness: {
      stale: control.fleetFreshness?.stale === true,
      ageMs: typeof control.fleetFreshness?.ageMs === 'number' ? control.fleetFreshness.ageMs : 0,
    },
  };
}

/**
 * Build the Autonomy view's single aggregate.
 *
 * Every field is a PROJECTION of a snapshot the hub already computes —
 * buildControlSnapshot (which itself reuses the shared fleet-status cache),
 * getFrontierUsageSync, pendingCount, the enrollment registry, the kill
 * switch, and the config. Nothing here recomputes fleet status or re-walks a
 * repo. Every section degrades independently: a failure in one never blanks
 * the rest.
 */
export async function buildVerseControlSnapshot(
  cfg: AshlrConfig,
  opts: { dispatchEnabled: boolean },
): Promise<VerseControlSnapshot> {
  const config = freshConfig(cfg);
  const caps = readVerseCaps(config);

  let control: Awaited<ReturnType<typeof buildControlSnapshot>> | null = null;
  try {
    control = await buildControlSnapshot(config);
  } catch {
    control = null;
  }

  let pending = 0;
  try {
    pending = pendingCount();
  } catch {
    pending = 0;
  }

  let quota: VerseControlSnapshot['quota'] = [];
  try {
    quota = getFrontierUsageSync(config).engines;
  } catch {
    quota = [];
  }

  const daemonState = projectDaemonState();
  const observation = control?.daemonObservation ?? {
    observedAt: new Date().toISOString(),
    runtimeState: 'unknown' as const,
    sourceQuality: { sourceState: 'degraded', complete: false, reason: 'unavailable' } as
      VerseControlSnapshot['daemon']['sourceQuality'],
    running: null,
    pid: null,
    startedAt: null,
    lastTickAt: null,
    todayDate: null,
    todaySpentUsd: null,
    itemsProcessed: null,
    ticks: null,
  };

  return {
    generatedAt: new Date().toISOString(),
    daemon: observation,
    fleet: control
      ? projectFleetEssentials(control)
      : {
          directionMode: null,
          directionAt: null,
          directionReason: null,
          autonomyControlLoop: false,
          autonomyControlMode: 'disabled',
          service: { registrationState: 'unknown', installed: false, running: false, runtimeState: null },
          freshness: { stale: true, ageMs: 0 },
        },
    caps,
    scope: readVerseScope(),
    killSwitch: currentKillSwitch(),
    // Its OWN field, never merged into killSwitch: the two sentinels have
    // different blast radii and the cockpit exists to tell them apart.
    pause: currentDaemonPause(),
    pendingApprovals: pending,
    spend: {
      // HONEST: null when the ledger could not be read — never a reassuring 0.
      todayUsd: observation.todaySpentUsd ?? (daemonState.todayDate === null ? null : daemonState.todaySpentUsd),
      todayDate: observation.todayDate ?? daemonState.todayDate,
      dailyBudgetUsd: caps.dailyBudgetUsd,
    },
    quota,
    dispatchEnabled: opts.dispatchEnabled,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Guard shared by every POST here: dispatch off ⇒ the route does not exist
 * (404, never 401 — an unauthenticated caller learns nothing about which
 * mutating routes this server has), then the shared mutation gate.
 * Returns false when a response was already written.
 */
function passesPostGate(
  ctx: VerseControlApiContext,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (!ctx.allowDispatch) {
    sendJson(res, 404, { error: 'not found' });
    return false;
  }
  return passesMutationGate(req, res, ctx.token);
}

/**
 * Handle one V2 Verse control request. Returns true when a response was
 * written (including errors); false when `path` is not one of these routes.
 */
export async function handleVerseControlApi(
  ctx: VerseControlApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
): Promise<boolean> {
  if (!isVerseControlPath(path)) return false;

  try {
    // ── GET /api/verse/control ───────────────────────────────────────────
    if (path === `${CONTROL_PREFIX}/control`) {
      if (method !== 'GET') {
        sendJson(res, 404, { error: `not found: ${method} ${path}` });
        return true;
      }
      sendJson(res, 200, await buildVerseControlSnapshot(ctx.cfg, {
        dispatchEnabled: ctx.allowDispatch,
      }));
      return true;
    }

    // ── /api/verse/caps ──────────────────────────────────────────────────
    if (path === `${CONTROL_PREFIX}/caps`) {
      if (method === 'GET') {
        sendJson(res, 200, readVerseCaps(freshConfig(ctx.cfg)));
        return true;
      }
      if (method === 'POST') {
        if (!passesPostGate(ctx, req, res)) return true;
        const body = await readJsonBody(req, res);
        if (!body) return true;
        const parsed = parseVerseCapsUpdate(body);
        if (!parsed.ok) {
          sendInvalid(res, parsed.error);
          return true;
        }
        const current = freshConfig(ctx.cfg);
        const { cfg: next, applied } = applyVerseCapsUpdate(current, parsed.update);
        try {
          saveConfig(next);
        } catch (err) {
          sendError(
            res,
            'VERSE_UNAVAILABLE',
            `could not persist config: ${err instanceof Error ? err.message : 'unknown error'}`,
          );
          return true;
        }
        const result: VerseCapsUpdateResult = {
          ok: true,
          applied,
          live: true,
          // Re-read from disk so the client sees exactly what was persisted.
          caps: readVerseCaps(freshConfig(next)),
        };
        sendJson(res, 200, result);
        return true;
      }
      sendJson(res, 404, { error: `not found: ${method} ${path}` });
      return true;
    }

    // ── /api/verse/scope ─────────────────────────────────────────────────
    if (path === `${CONTROL_PREFIX}/scope`) {
      if (method === 'GET') {
        sendJson(res, 200, readVerseScope());
        return true;
      }
      if (method === 'POST') {
        if (!passesPostGate(ctx, req, res)) return true;
        const body = await readJsonBody(req, res);
        if (!body) return true;
        for (const key of Object.keys(body)) {
          if (key !== 'action' && key !== 'path') {
            sendInvalid(res, `unknown key: ${key}`);
            return true;
          }
        }
        const action = body['action'];
        if (action !== 'enroll' && action !== 'unenroll') {
          sendInvalid(res, "action must be 'enroll' or 'unenroll'");
          return true;
        }
        const rawPath = body['path'];
        if (typeof rawPath !== 'string') {
          sendInvalid(res, 'path is required');
          return true;
        }
        const check = checkVerseScopePath(rawPath, { requireDirectory: action === 'enroll' });
        if (!check.ok) {
          sendInvalid(res, check.error);
          return true;
        }
        const mutation: PolicyMutationResult =
          action === 'enroll' ? enroll(check.path) : unenroll(check.path);
        const result: VerseScopeResult = {
          ok: mutation.ok,
          action,
          path: check.path,
          changed: mutation.changed,
          reason: mutation.reason,
          scope: readVerseScope(),
        };
        // enroll()/unenroll() audit themselves; a refusal is a 409, not a 500.
        sendJson(res, mutation.ok ? 200 : 409, result);
        return true;
      }
      sendJson(res, 404, { error: `not found: ${method} ${path}` });
      return true;
    }

    // ── GET /api/verse/audit ─────────────────────────────────────────────
    if (path === `${CONTROL_PREFIX}/audit`) {
      if (method !== 'GET') {
        sendJson(res, 404, { error: `not found: ${method} ${path}` });
        return true;
      }
      const query = parseVerseAuditQuery({
        limit: queryParam(req, 'limit'),
        action: queryParam(req, 'action'),
        result: queryParam(req, 'result'),
      });
      if (!query.ok) {
        sendInvalid(res, query.error);
        return true;
      }
      sendJson(res, 200, readVerseAudit(query));
      return true;
    }

    // ── POST /api/verse/daemon ───────────────────────────────────────────
    if (path === `${CONTROL_PREFIX}/daemon`) {
      if (method !== 'POST') {
        sendJson(res, 404, { error: `not found: ${method} ${path}` });
        return true;
      }
      if (!passesPostGate(ctx, req, res)) return true;
      const body = await readJsonBody(req, res);
      if (!body) return true;
      for (const key of Object.keys(body)) {
        if (key !== 'action') {
          sendInvalid(res, `unknown key: ${key}`);
          return true;
        }
      }
      const action = body['action'];
      if (typeof action !== 'string' || !DAEMON_ACTIONS.has(action)) {
        sendInvalid(res, 'action must be one of: start, stop, once, pause, resume');
        return true;
      }
      const outcome = await runVerseDaemonAction(action as VerseDaemonAction);
      sendJson(res, outcome.status, outcome.body);
      return true;
    }

    // ── GET /api/verse/safety ────────────────────────────────────────────
    if (path === `${CONTROL_PREFIX}/safety`) {
      if (method !== 'GET') {
        sendJson(res, 404, { error: `not found: ${method} ${path}` });
        return true;
      }
      // Reuse the CLI's callable checker rather than shelling out to
      // `ashlr verify-safety --json`. Imported lazily so the web server does
      // not pay for the CLI module graph on every boot.
      const { runSafetyChecks } = await import('../../cli/verify-safety.js');
      sendJson(res, 200, runSafetyChecks());
      return true;
    }

    // ── GET /api/verse/accounts ──────────────────────────────────────────
    //
    // Real per-account subscription telemetry. Every probe behind it is
    // metadata-only: ZERO tokens, ZERO paid quota. When this server owns the
    // native metadata lease the records are live; when `ashlr resource-console`
    // owns it, the body says so and carries read-only shared evidence instead
    // of pretending to be fresh.
    //
    // SECURITY: `buildVerseAccountsSnapshot` builds each record field by field
    // from connections.json's id/label/provider only — no launcher command, no
    // env, no token, and console-startup.json is never opened.
    if (path === `${CONTROL_PREFIX}/accounts`) {
      if (method !== 'GET') {
        sendJson(res, 404, { error: `not found: ${method} ${path}` });
        return true;
      }
      sendJson(res, 200, buildVerseAccountsSnapshot({
        accountsRoot: resolveAccountsRoot(ctx.cfg),
        collector: getVerseAccountCollector(),
      }));
      return true;
    }

    // ── GET /api/verse/usage-series?window=7d|30d ────────────────────────
    //
    // `buildRollup(window, cfg).byDay` is one synchronous call away and EVERY
    // current consumer computes it and throws it away (control.ts keeps only
    // totals, frontier-usage.ts only byModel). This exposes it.
    //
    // Honesty: `estCostUsd` is ESTIMATED from a static price table, not billed,
    // and Codex `cacheRead`/`cacheWrite` are hardcoded 0 upstream — so its cache
    // economics are not comparable to Claude's. Both are stated in the body
    // rather than left for the chart to imply.
    if (path === `${CONTROL_PREFIX}/usage-series`) {
      if (method !== 'GET') {
        sendJson(res, 404, { error: `not found: ${method} ${path}` });
        return true;
      }
      const raw = queryParam(req, 'window');
      if (raw !== null && raw !== '7d' && raw !== '30d') {
        sendInvalid(res, "window must be '7d' or '30d'");
        return true;
      }
      const window: '7d' | '30d' = raw === '30d' ? '30d' : '7d';
      let byDay: ReturnType<typeof buildRollup>['byDay'] = [];
      try {
        byDay = buildRollup(window, freshConfig(ctx.cfg)).byDay;
      } catch {
        // Partial or unreadable usage data yields an empty series, never a throw.
        byDay = [];
      }
      sendJson(res, 200, {
        window,
        byDay,
        estimated: true,
        caveats: [
          'estCostUsd is estimated from a static price table, not a billed amount.',
          'Codex cacheRead/cacheWrite are recorded as 0 upstream; its cache economics are not comparable to Claude\'s.',
        ],
      });
      return true;
    }

    // ── GET /api/verse/local-models ──────────────────────────────────────
    //
    // Local availability is the local analogue of a subscription meter: what is
    // resident now, how it is split across GPU/CPU, and — first-class — whether
    // the model supports `tools` at all, because one that does not cannot drive
    // an agentic session no matter how much memory is free.
    if (path === `${CONTROL_PREFIX}/local-models`) {
      if (method !== 'GET') {
        sendJson(res, 404, { error: `not found: ${method} ${path}` });
        return true;
      }
      sendJson(res, 200, await collectVerseLocalModels({
        ollamaBaseUrl: resolveOllamaBaseUrl(ctx.cfg),
        ...(typeof ctx.cfg.models?.lmstudio === 'string' && ctx.cfg.models.lmstudio.length > 0
          ? { lmStudioBaseUrl: ctx.cfg.models.lmstudio }
          : {}),
      }));
      return true;
    }

    sendJson(res, 404, { error: `not found: ${method} ${path}` });
    return true;
  } catch {
    if (!res.headersSent) {
      sendJson(res, 500, { code: 'INTERNAL_ERROR', error: 'internal server error' });
    } else if (!res.writableEnded) {
      try { res.end(); } catch { /* already gone */ }
    }
    return true;
  }
}
