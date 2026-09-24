/**
 * Budget policy — mode defaults, effective per-seat policy, and strict update
 * parsing (V3.10 unit A9).
 *
 * THE MODEL (what a stored policy means)
 *
 *   `policy.mode` picks a column of MODE_DEFAULTS below. `policy.seats` holds
 *   the per-seat policies IN FORCE for that mode, but only for seats the
 *   operator has touched; every other seat gets the mode's default for its
 *   engine. So what the Budget panel shows is exactly what the router uses —
 *   there is no hidden transform layered on top of a slider.
 *
 *   Switching mode (`applyModeSwitch`) re-bases every stored seat on the new
 *   mode's defaults and keeps only the two choices that are not "how much" but
 *   "whether at all": `enabled` and a hard `dailyUsdCap`. A reserve tuned for
 *   `balanced` would be meaningless in `all-in` (which by definition keeps
 *   nothing back), so it is not carried across.
 *
 * DEFAULTS (Mason's decisions, recorded 2026-09-24 — binding):
 *   balanced (default) — Claude keeps 40% of its weekly window for Mason and
 *                        is never touched while its 5-hour window is above 70%
 *                        (protects his live session). Grok 0% reserve. Local
 *                        unlimited. Codex OFF (no usage) until switched on.
 *   all-in             — autonomy may use all available usage (no reserve, no
 *                        session ceiling). Codex stays OFF by default.
 *   reserve            — free local models plus only a small paid cap: every
 *                        paid seat keeps 85% of its binding window back and a
 *                        5-hour ceiling of 50%, and the router ranks local
 *                        first (router.ts).
 *
 * BROWSER-SAFE and PURE: no node: imports, no I/O. The Budget UI imports the
 * defaults from here so the "reset to default" hint can never drift from the
 * server.
 */
import {
  BUDGET_MODES,
  type BudgetMode,
  type BudgetPolicy,
  type BudgetResponse,
  type BudgetUpdateRequest,
  type SeatBudgetPolicy,
} from './types.js';

/** The engines a seat can belong to (mirrors `VerseEngine`, kept local so this file has no verse import). */
export type BudgetEngine = 'claude' | 'codex' | 'grok' | 'local';

export const BUDGET_ENGINES: readonly BudgetEngine[] = ['claude', 'codex', 'grok', 'local'];

/** Same spelling rule the seat catalog and preferences use for seat ids. */
export const BUDGET_SEAT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/;

/** Registry bound — a blast radius for a runaway client, not a UI limit. */
export const BUDGET_MAX_SEATS = 64;

/** Upper bound on a daily USD cap; anything larger is a typo, not a budget. */
export const BUDGET_MAX_DAILY_USD = 10_000;

export const DEFAULT_BUDGET_MODE: BudgetMode = 'balanced';

/** Who a seat is, for the Budget panel (headroom rows carry only the id). */
export interface BudgetSeatInfo {
  seatId: string;
  label: string;
  engine: BudgetEngine;
  /** True for local seats: $0, no provider window. */
  free: boolean;
}

/**
 * The body `GET/POST /api/verse/budget` actually serves: the frozen
 * `BudgetResponse` plus two ADDITIVE fields the panel needs to render a seat
 * it has never stored a policy for. `seats` stays the stored policy (only the
 * seats the operator touched); `effective` is what the router applies to
 * every seat it currently knows.
 */
export interface BudgetView extends BudgetResponse {
  seatInfo: BudgetSeatInfo[];
  effective: Record<string, SeatBudgetPolicy>;
  /** How old a reading may be before autonomy stops spending against it. */
  readingMaxAgeMs: number;
  /** When the seat readings behind `headroom` were sampled. */
  sampledAt: string;
}

/** Per-engine default in one mode; `seatId` is filled in by `defaultSeatPolicy`. */
type EngineDefault = Omit<SeatBudgetPolicy, 'seatId'>;

/**
 * Mode × engine defaults. Frozen so a caller can never mutate the table the
 * whole process reads.
 *
 * Codex is `enabled: false` in every mode on purpose: on 2026-09-24 both Codex
 * accounts were at 100% with resets days away, and Mason turned Codex OFF for
 * autonomy "until usage returns". That is a standing choice, not a function of
 * the mode, so a mode switch must not silently turn it back on.
 */
export const MODE_DEFAULTS: Readonly<Record<BudgetMode, Readonly<Record<BudgetEngine, Readonly<EngineDefault>>>>> =
  Object.freeze({
    'all-in': Object.freeze({
      claude: Object.freeze({ enabled: true, reservePercent: 0 }),
      codex: Object.freeze({ enabled: false, reservePercent: 0 }),
      grok: Object.freeze({ enabled: true, reservePercent: 0 }),
      local: Object.freeze({ enabled: true, reservePercent: 0 }),
    }),
    balanced: Object.freeze({
      claude: Object.freeze({ enabled: true, reservePercent: 40, maxSessionWindowPercent: 70 }),
      codex: Object.freeze({ enabled: false, reservePercent: 40, maxSessionWindowPercent: 70 }),
      grok: Object.freeze({ enabled: true, reservePercent: 0 }),
      local: Object.freeze({ enabled: true, reservePercent: 0 }),
    }),
    reserve: Object.freeze({
      claude: Object.freeze({ enabled: true, reservePercent: 85, maxSessionWindowPercent: 50 }),
      codex: Object.freeze({ enabled: false, reservePercent: 85, maxSessionWindowPercent: 50 }),
      grok: Object.freeze({ enabled: true, reservePercent: 85 }),
      local: Object.freeze({ enabled: true, reservePercent: 0 }),
    }),
  });

/** Plain-language one-liners for the mode control (UI + API `why` text share them). */
export const MODE_DESCRIPTIONS: Readonly<Record<BudgetMode, string>> = Object.freeze({
  'all-in': 'Autonomy may use all available usage on every enabled seat.',
  balanced: 'Autonomy stops at each seat’s reserve, so you keep headroom for your own sessions.',
  reserve: 'Autonomy runs on free local models, plus only a small slice of paid seats.',
});

export function isBudgetMode(value: unknown): value is BudgetMode {
  return typeof value === 'string' && (BUDGET_MODES as readonly string[]).includes(value);
}

/**
 * Which engine a seat id belongs to, when the caller has no seat record.
 *
 * Seat ids are account ids from connections.json (`claude`, `codex-personal`,
 * `grok`) or `local:<tag>` for Ollama. An id that names no known engine is
 * treated as `claude`-class — the most protected default — rather than as
 * free local capacity: guessing "free" for an unknown seat would be the
 * fail-open this module exists to close.
 */
export function engineOfSeatId(seatId: string): BudgetEngine {
  const id = seatId.toLowerCase();
  if (id === 'local' || id.startsWith('local:')) return 'local';
  if (id.startsWith('codex')) return 'codex';
  if (id.startsWith('grok')) return 'grok';
  return 'claude';
}

export function defaultSeatPolicy(mode: BudgetMode, seatId: string, engine: BudgetEngine = engineOfSeatId(seatId)): SeatBudgetPolicy {
  const base = MODE_DEFAULTS[mode][engine];
  const out: SeatBudgetPolicy = { seatId, enabled: base.enabled, reservePercent: base.reservePercent };
  if (base.maxSessionWindowPercent !== undefined) out.maxSessionWindowPercent = base.maxSessionWindowPercent;
  if (base.dailyUsdCap !== undefined) out.dailyUsdCap = base.dailyUsdCap;
  return out;
}

/** The policy the router applies to one seat: the stored one, or the mode default. */
export function effectiveSeatPolicy(policy: BudgetPolicy, seatId: string, engine?: BudgetEngine): SeatBudgetPolicy {
  const stored = policy.seats[seatId];
  if (stored) return { ...stored, seatId };
  return defaultSeatPolicy(policy.mode, seatId, engine ?? engineOfSeatId(seatId));
}

/** The policy a fresh install starts with: balanced, no per-seat deviations. */
export function defaultBudgetPolicy(): BudgetPolicy {
  // Epoch, not "now": nothing was ever decided here, and a timestamp that
  // moves on every read would claim a change that never happened.
  return { mode: DEFAULT_BUDGET_MODE, seats: {}, updatedAt: new Date(0).toISOString() };
}

// ---------------------------------------------------------------------------
// Validation (shared by the store's lenient load and the API's strict update)
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPercent(value: unknown, low = 0): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= low && value <= 100;
}

function isUsd(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= BUDGET_MAX_DAILY_USD;
}

/** Whole percents only: a 40.000001% reserve is noise, and integers diff cleanly. */
function wholePercent(value: number): number {
  return Math.round(value);
}

/** Cents are the finest a USD cap means anything at. */
function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Salvage one stored seat entry, or null when it is unusable. Lenient on
 * purpose (the file is ours but may be hand-edited): an invalid optional field
 * is dropped, an invalid required field drops the entry — which then falls
 * back to the mode default, the conservative outcome.
 */
export function sanitizeSeatPolicy(seatId: string, raw: unknown): SeatBudgetPolicy | null {
  if (!BUDGET_SEAT_ID_RE.test(seatId) || !isObject(raw)) return null;
  if (typeof raw['enabled'] !== 'boolean' || !isPercent(raw['reservePercent'])) return null;
  const out: SeatBudgetPolicy = {
    seatId,
    enabled: raw['enabled'],
    reservePercent: wholePercent(raw['reservePercent']),
  };
  if (isPercent(raw['maxSessionWindowPercent'], 1)) {
    out.maxSessionWindowPercent = wholePercent(raw['maxSessionWindowPercent']);
  }
  if (isUsd(raw['dailyUsdCap'])) out.dailyUsdCap = cents(raw['dailyUsdCap']);
  return out;
}

/** Field-by-field salvage of a whole stored policy. Never throws. */
export function sanitizeBudgetPolicy(raw: unknown): BudgetPolicy {
  const out = defaultBudgetPolicy();
  if (!isObject(raw)) return out;
  if (isBudgetMode(raw['mode'])) out.mode = raw['mode'];
  const updatedAt = raw['updatedAt'];
  if (typeof updatedAt === 'string' && Number.isFinite(Date.parse(updatedAt))) {
    out.updatedAt = new Date(Date.parse(updatedAt)).toISOString();
  }
  const seats = raw['seats'];
  if (isObject(seats)) {
    let kept = 0;
    for (const seatId of Object.keys(seats).sort()) {
      if (kept >= BUDGET_MAX_SEATS) break;
      const entry = sanitizeSeatPolicy(seatId, seats[seatId]);
      if (!entry) continue;
      out.seats[seatId] = entry;
      kept += 1;
    }
  }
  return out;
}

/** The error the budget module throws for a bad request (duck-typed by `code`, like VerseServiceError). */
export class BudgetPolicyError extends Error {
  readonly code: 'VERSE_INVALID' | 'VERSE_TOO_LARGE';
  readonly status: 400 | 413;

  constructor(code: 'VERSE_INVALID' | 'VERSE_TOO_LARGE', message: string) {
    super(message);
    this.name = 'BudgetPolicyError';
    this.code = code;
    this.status = code === 'VERSE_TOO_LARGE' ? 413 : 400;
  }
}

/**
 * A validated per-seat patch. `null` on an optional field means "clear it"
 * (JSON has no `undefined`): `maxSessionWindowPercent: null` removes the
 * session ceiling, `dailyUsdCap: null` removes the cap.
 */
export interface SeatPolicyPatch {
  enabled?: boolean;
  reservePercent?: number;
  maxSessionWindowPercent?: number | null;
  dailyUsdCap?: number | null;
}

export type ParsedBudgetUpdate =
  | { kind: 'mode'; mode: BudgetMode }
  | { kind: 'seat'; seatId: string; patch: SeatPolicyPatch };

const SEAT_PATCH_KEYS: ReadonlySet<string> = new Set([
  'enabled',
  'reservePercent',
  'maxSessionWindowPercent',
  'dailyUsdCap',
]);

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/**
 * Validate a POST body against EXACTLY one `BudgetUpdateRequest` form, so a
 * body can never change more than the operator clicked. Unknown keys are
 * refused (a misspelt `reservepercent` silently dropped would "succeed" and
 * change nothing).
 */
export function parseBudgetUpdate(value: unknown): ParsedBudgetUpdate {
  if (!isObject(value)) throw new BudgetPolicyError('VERSE_INVALID', 'budget update must be a JSON object');

  if (sameKeys(value, ['mode'])) {
    if (!isBudgetMode(value['mode'])) {
      throw new BudgetPolicyError('VERSE_INVALID', `mode must be one of: ${BUDGET_MODES.join(', ')}`);
    }
    return { kind: 'mode', mode: value['mode'] };
  }

  if (sameKeys(value, ['seatId', 'policy'])) {
    const seatId = value['seatId'];
    if (typeof seatId !== 'string' || !BUDGET_SEAT_ID_RE.test(seatId)) {
      throw new BudgetPolicyError('VERSE_INVALID', 'seatId must be a seat id');
    }
    const policy = value['policy'];
    if (!isObject(policy)) throw new BudgetPolicyError('VERSE_INVALID', 'policy must be an object');
    const keys = Object.keys(policy);
    if (keys.length === 0) throw new BudgetPolicyError('VERSE_INVALID', 'policy must change at least one field');
    for (const key of keys) {
      if (!SEAT_PATCH_KEYS.has(key)) throw new BudgetPolicyError('VERSE_INVALID', `unknown policy key: ${key}`);
    }
    const patch: SeatPolicyPatch = {};
    if ('enabled' in policy) {
      if (typeof policy['enabled'] !== 'boolean') throw new BudgetPolicyError('VERSE_INVALID', 'enabled must be a boolean');
      patch.enabled = policy['enabled'];
    }
    if ('reservePercent' in policy) {
      if (!isPercent(policy['reservePercent'])) {
        throw new BudgetPolicyError('VERSE_INVALID', 'reservePercent must be a number from 0 to 100');
      }
      patch.reservePercent = wholePercent(policy['reservePercent']);
    }
    if ('maxSessionWindowPercent' in policy) {
      const v = policy['maxSessionWindowPercent'];
      if (v !== null && !isPercent(v, 1)) {
        throw new BudgetPolicyError('VERSE_INVALID', 'maxSessionWindowPercent must be a number from 1 to 100, or null');
      }
      patch.maxSessionWindowPercent = v === null ? null : wholePercent(v);
    }
    if ('dailyUsdCap' in policy) {
      const v = policy['dailyUsdCap'];
      if (v !== null && !isUsd(v)) {
        throw new BudgetPolicyError('VERSE_INVALID', `dailyUsdCap must be a number from 0 to ${BUDGET_MAX_DAILY_USD}, or null`);
      }
      patch.dailyUsdCap = v === null ? null : cents(v);
    }
    return { kind: 'seat', seatId, patch };
  }

  throw new BudgetPolicyError('VERSE_INVALID', 'budget update must be exactly one of {mode} or {seatId, policy}');
}

/**
 * Re-base every stored seat on `mode`'s defaults, keeping `enabled` and a hard
 * `dailyUsdCap` (see the file header for why reserves are not carried).
 */
export function applyModeSwitch(
  policy: BudgetPolicy,
  mode: BudgetMode,
  nowIso: string,
  engineOf?: (seatId: string) => BudgetEngine | undefined,
): BudgetPolicy {
  const seats: Record<string, SeatBudgetPolicy> = {};
  for (const seatId of Object.keys(policy.seats).sort()) {
    const stored = policy.seats[seatId]!;
    const next = defaultSeatPolicy(mode, seatId, engineOf?.(seatId) ?? engineOfSeatId(seatId));
    next.enabled = stored.enabled;
    if (stored.dailyUsdCap !== undefined) next.dailyUsdCap = stored.dailyUsdCap;
    seats[seatId] = next;
  }
  return { mode, seats, updatedAt: nowIso };
}

/** Apply one validated per-seat patch on top of the seat's effective policy. */
export function applySeatPatch(
  policy: BudgetPolicy,
  seatId: string,
  patch: SeatPolicyPatch,
  nowIso: string,
  engine?: BudgetEngine,
): BudgetPolicy {
  if (!(seatId in policy.seats) && Object.keys(policy.seats).length >= BUDGET_MAX_SEATS) {
    throw new BudgetPolicyError('VERSE_TOO_LARGE', `at most ${BUDGET_MAX_SEATS} seats can carry a budget policy`);
  }
  const next = effectiveSeatPolicy(policy, seatId, engine);
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.reservePercent !== undefined) next.reservePercent = patch.reservePercent;
  if (patch.maxSessionWindowPercent !== undefined) {
    if (patch.maxSessionWindowPercent === null) delete next.maxSessionWindowPercent;
    else next.maxSessionWindowPercent = patch.maxSessionWindowPercent;
  }
  if (patch.dailyUsdCap !== undefined) {
    if (patch.dailyUsdCap === null) delete next.dailyUsdCap;
    else next.dailyUsdCap = patch.dailyUsdCap;
  }
  const seats: Record<string, SeatBudgetPolicy> = { ...policy.seats, [seatId]: next };
  const sorted: Record<string, SeatBudgetPolicy> = {};
  for (const id of Object.keys(seats).sort()) sorted[id] = seats[id]!;
  return { mode: policy.mode, seats: sorted, updatedAt: nowIso };
}

/** Apply exactly one update form. Pure — the caller persists. */
export function applyBudgetUpdate(
  policy: BudgetPolicy,
  update: BudgetUpdateRequest | ParsedBudgetUpdate,
  nowIso: string,
  engineOf?: (seatId: string) => BudgetEngine | undefined,
): BudgetPolicy {
  const parsed: ParsedBudgetUpdate = 'kind' in update ? update : parseBudgetUpdate(update);
  if (parsed.kind === 'mode') return applyModeSwitch(policy, parsed.mode, nowIso, engineOf);
  return applySeatPatch(policy, parsed.seatId, parsed.patch, nowIso, engineOf?.(parsed.seatId));
}
