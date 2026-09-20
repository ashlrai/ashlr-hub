/**
 * routes/verse/usage/usage-contract.ts
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │  INTEGRATION — RECONCILED AGAINST OWNER T'S REAL ROUTES (V2.1)        │
 * │                                                                       │
 * │    GET /api/verse/accounts      → VerseAccountsSnapshot               │
 * │    GET /api/verse/usage-series  → {window, byDay, estimated, caveats} │
 * │    GET /api/verse/local-models  → VerseLocalModelsSnapshot            │
 * │                                                                       │
 * │  T's types now exist and are imported below as the WIRE shapes. The    │
 * │  interfaces in this file are no longer stand-ins for them: they are    │
 * │  the DISPLAY shapes this section renders, and they differ from the     │
 * │  wire on purpose in three places the seam actually required —          │
 * │                                                                       │
 * │   1. local-models arrives as TWO runtime reports (ollama, lmStudio)    │
 * │      plus a `machine` budget. This section shows one list of models    │
 * │      against one budget, so `projectLocalModels` flattens them.        │
 * │   2. usage-series arrives as `{byDay}`, not `{days}` (T's documented   │
 * │      deviation 1). The projector reads `byDay` and still accepts       │
 * │      `days`/a bare array so an older server degrades rather than dies. │
 * │   3. `unsupported` is not a wire field. T reports the version-pin      │
 * │      failure in `reason` as the verbatim probe code, so it is DERIVED  │
 * │      here from that code plus T's exported pin constant rather than    │
 * │      being added to T's contract late in the run.                      │
 * │                                                                       │
 * │  The `WIRE_*_KEYS` blocks below are the executable seam contract:      │
 * │  every canonical field name this module reads is pinned to `keyof` the │
 * │  corresponding core type, so a rename in src/core/verse breaks THIS    │
 * │  build instead of silently degrading the panel to "unknown" at run     │
 * │  time — which is exactly how this seam was broken when integration     │
 * │  started.                                                              │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * Why every read goes through a structural narrower instead of a cast:
 *
 *  - This section must render correctly against a server that does NOT have
 *    T's routes (404) and against one that has an earlier spelling of them.
 *    A cast would turn a field-name drift into `undefined.something` at
 *    render time; a narrower turns it into an honest "unknown" with a reason.
 *  - Nothing here is ever coerced. A missing percentage stays `null`, never
 *    0 — `usedPercent: 0` and "no reading" are different facts and the UI
 *    draws them differently (docs/VERSE-TELEMETRY-V2.md, closing rules).
 *
 * SECURITY (docs/VERSE-CONTRACT-V2.md ground rules): a native-profile
 * launcher command must never reach a surface. `sanitizeCommand` below is a
 * client-side backstop on top of the server's own stripping — if a payload
 * ever carries a launcher path, this module drops it rather than printing it.
 *
 * Pure: no React, no I/O.
 */
// EVERY import from src/core here MUST be type-only.
//
// `core/verse/accounts.ts` is the server's collector: it pulls node:fs,
// node:child_process, the quota lease and the connection monitor. A VALUE
// import of even a one-word constant from it drags that entire graph into the
// browser bundle — `vite build` externalizes the node built-ins and the build
// fails. Type-only imports are erased, so the seam guards below cost nothing
// at runtime. The two constants this module needs are therefore re-declared
// locally and PINNED TO CORE'S LITERAL TYPES (see below), which gives the same
// drift protection with no emitted import.
import type {
  VerseAccountRecord,
  VerseAccountWindow,
  VerseAccountsCollectorStatus,
  VerseAccountsSnapshot,
  VerseCodexCredits,
} from '../../../../core/verse/accounts.js';
import type {
  VerseLocalModel,
  VerseLocalModelsSnapshot,
  VerseLocalRuntimeReport,
} from '../../../../core/verse/local-models.js';
import type { DailyUsage as CoreDailyUsage } from '../../../../core/types.js';

// ---------------------------------------------------------------------------
// Seam contract — compile-time only, zero runtime cost.
//
// Each entry pins a field name this module reads off the wire to `keyof` the
// core type that produces it. Renaming a field in src/core/verse now fails
// `npm run typecheck:web` here, at the seam, rather than turning a live panel
// into a silent "unknown".
// ---------------------------------------------------------------------------

const WIRE_ACCOUNT_KEYS = {
  id: 'id',
  label: 'label',
  provider: 'provider',
  state: 'state',
  authentication: 'authentication',
  planType: 'planType',
  observedAt: 'observedAt',
  windows: 'windows',
  binding: 'binding',
  credits: 'credits',
  reason: 'reason',
  notes: 'notes',
} as const satisfies Record<string, keyof VerseAccountRecord>;

const WIRE_WINDOW_KEYS = {
  id: 'id',
  usedPercent: 'usedPercent',
  resetsAt: 'resetsAt',
  nativeReport: 'nativeReport',
  limitReached: 'limitReached',
} as const satisfies Record<string, keyof VerseAccountWindow>;

const WIRE_CREDITS_KEYS = {
  hasCredits: 'hasCredits',
  unlimited: 'unlimited',
  balance: 'balance',
} as const satisfies Record<string, keyof VerseCodexCredits>;

const WIRE_ACCOUNTS_SNAPSHOT_KEYS = {
  sampledAt: 'sampledAt',
  refreshing: 'refreshing',
  accounts: 'accounts',
  collector: 'collector',
  notes: 'notes',
} as const satisfies Record<string, keyof VerseAccountsSnapshot>;

const WIRE_COLLECTOR_KEYS = {
  owner: 'owner',
  note: 'note',
} as const satisfies Record<string, keyof VerseAccountsCollectorStatus>;

const WIRE_LOCAL_SNAPSHOT_KEYS = {
  machine: 'machine',
  ollama: 'ollama',
  lmStudio: 'lmStudio',
} as const satisfies Record<string, keyof VerseLocalModelsSnapshot>;

const WIRE_LOCAL_RUNTIME_KEYS = {
  reachable: 'reachable',
  models: 'models',
  reason: 'reason',
} as const satisfies Record<string, keyof VerseLocalRuntimeReport>;

const WIRE_LOCAL_MODEL_KEYS = {
  id: 'id',
  label: 'label',
  state: 'state',
  sizeBytes: 'sizeBytes',
  sizeVramBytes: 'sizeVramBytes',
  expiresAt: 'expiresAt',
  contextLength: 'contextLength',
  nativeContextLength: 'nativeContextLength',
  parameterSize: 'parameterSize',
  quantization: 'quantization',
  capabilities: 'capabilities',
  supportsTools: 'supportsTools',
} as const satisfies Record<string, keyof VerseLocalModel>;

/**
 * Claude's version-pin constants, re-declared rather than imported.
 *
 * The annotations are the drift guard: `typeof import(...)` is a TYPE position,
 * so it is erased at build time, but it resolves to core's literal type
 * (`'2.1.257'`, `'usage-version-unsupported'`). Change either constant in
 * `core/verse/accounts.ts` and this file stops compiling — the same protection
 * a value import would give, without pulling node:fs into the browser.
 */
type CoreAccountsModule = typeof import('../../../../core/verse/accounts.js');

export const CLAUDE_VERSION_REASON: CoreAccountsModule['VERSE_CLAUDE_VERSION_REASON'] =
  'usage-version-unsupported';

export const CLAUDE_USAGE_PINNED_VERSION: CoreAccountsModule['VERSE_CLAUDE_USAGE_PINNED_VERSION'] =
  '2.1.257';

/** `byDay` is the wire key (T's deviation 1); `DailyUsage` below mirrors core. */
const WIRE_DAILY_USAGE_KEYS = {
  day: 'day',
  tokensIn: 'tokensIn',
  tokensOut: 'tokensOut',
  estCostUsd: 'estCostUsd',
  sessions: 'sessions',
  cacheRead: 'cacheRead',
  cacheWrite: 'cacheWrite',
  cacheHitRate: 'cacheHitRate',
} as const satisfies Record<string, keyof CoreDailyUsage>;

// Referenced so the guards are not dead code under `noUnusedLocals`.
export const WIRE_CONTRACT_KEYS = {
  account: WIRE_ACCOUNT_KEYS,
  window: WIRE_WINDOW_KEYS,
  credits: WIRE_CREDITS_KEYS,
  accountsSnapshot: WIRE_ACCOUNTS_SNAPSHOT_KEYS,
  collector: WIRE_COLLECTOR_KEYS,
  localSnapshot: WIRE_LOCAL_SNAPSHOT_KEYS,
  localRuntime: WIRE_LOCAL_RUNTIME_KEYS,
  localModel: WIRE_LOCAL_MODEL_KEYS,
  dailyUsage: WIRE_DAILY_USAGE_KEYS,
} as const;

// ---------------------------------------------------------------------------
// GET /api/verse/accounts
// ---------------------------------------------------------------------------

/** Provider ids this surface knows how to describe. */
export type AccountProvider = 'claude' | 'codex' | 'grok';

/**
 * One quota window on an account.
 *
 * `resetsAt` is an ISO string when the provider gave a real timestamp (Codex
 * publishes an epoch the server normalizes). Claude's is STRUCTURALLY always
 * null and the human sentence lives in `nativeReport.resetDescription`, which
 * is rendered verbatim and never turned into a countdown.
 */
export interface AccountWindow {
  id: string;
  /** Human label when the server supplies one; otherwise `id` is shown. */
  label: string | null;
  /** 0–100. `null` is "no reading", never 0. */
  usedPercent: number | null;
  /** ISO 8601, or null. */
  resetsAt: string | null;
  /** Verbatim provider prose, e.g. "resets Sep 25 at 7pm (America/New_York)". */
  resetDescription: string | null;
  /**
   * True when the provider signalled `rateLimitReachedType` — the upstream
   * writes the SENTINEL 100, which is a flag, not a measurement. Rendered as
   * "limit reached", never as "100% used".
   */
  limitReached: boolean;
}

/**
 * Codex credits. Independent of the window: a 100%-used week with a spendable
 * balance is NOT blocked, and this surface must not say it is.
 */
export interface AccountCredits {
  hasCredits: boolean;
  unlimited: boolean;
  /** Raw decimal string from the provider, kept verbatim for the title text. */
  balance: string | null;
  /** `balance` parsed, or null when it was absent/unparseable. */
  balanceValue: number | null;
}

export interface Account {
  id: string;
  label: string;
  provider: AccountProvider;
  state: 'checking' | 'observed' | 'signed-out' | 'unavailable';
  authentication: 'signed-in' | 'signed-out' | 'unknown';
  planType: string | null;
  observedAt: string | null;
  windows: AccountWindow[];
  /**
   * The server's computed binding window (highest used percent). Kept as its
   * own field rather than recomputed blindly, but `accounts-model.ts` verifies
   * it against `windows` and falls back to computing it when absent.
   */
  binding: AccountWindow | null;
  credits: AccountCredits | null;
  /** Plain-language reason for a non-observed state. */
  reason: string | null;
  /**
   * Present when a probe failed CLOSED on a version pin (Claude's probe is
   * pinned to a specific Claude Code build). The fix is a one-line constant
   * bump, so the UI names it instead of showing a silent "unknown".
   */
  unsupported: { code: string; pinnedVersion: string | null } | null;
  /** Already sanitized — see `sanitizeCommand`. Null when nothing safe to show. */
  reconnectCommand: string | null;
  /**
   * The server's plain-language facts for this account (`VerseAccountRecord.
   * notes`). Grok's "reconnect through `ashlr resources`, profile path withheld
   * on purpose" lives here, which is why this surface shows notes rather than
   * only the machine-readable `reason`.
   */
  notes: string[];
}

export interface AccountsSnapshot {
  sampledAt: string | null;
  refreshing: boolean;
  accounts: Account[];
  /**
   * Set when another collector process owns the quota-refresh lease, so these
   * readings are read-only and may be staler than this server's poll interval.
   */
  collectorNote: string | null;
}

// ---------------------------------------------------------------------------
// GET /api/verse/usage-series?window=7d|30d
// ---------------------------------------------------------------------------

export type SeriesWindow = '7d' | '30d';

/** `buildRollup(window, cfg).byDay` — see docs/VERSE-TELEMETRY-V2.md. */
export interface DailyUsage {
  /** YYYY-MM-DD. */
  day: string;
  tokensIn: number;
  tokensOut: number;
  /** ESTIMATED from a static price table. Never a billed figure. */
  estCostUsd: number;
  sessions: number;
  /** Optional: absent means the rollup carried no cache columns for that day. */
  cacheRead: number | null;
  cacheWrite: number | null;
  /** 0–1 fraction, or null. */
  cacheHitRate: number | null;
}

export interface UsageSeries {
  window: SeriesWindow;
  days: DailyUsage[];
  generatedAt: string | null;
}

// ---------------------------------------------------------------------------
// GET /api/verse/local-models
// ---------------------------------------------------------------------------

export interface LocalModel {
  name: string;
  /** Which runtime reported it, so a flattened list stays attributable. */
  runtime: 'ollama' | 'lmstudio' | null;
  /** Resident in memory right now (Ollama /api/ps), vs merely installed. */
  loaded: boolean;
  /** Total resident bytes, or null when not reported. */
  sizeBytes: number | null;
  /** Of `sizeBytes`, how much sits in VRAM. null = not reported. */
  sizeVramBytes: number | null;
  /** Keep-alive expiry (ISO). Only meaningful while `loaded`. */
  expiresAt: string | null;
  /** e.g. "79.7B". Provider string, never parsed into a number for display. */
  parameterSize: string | null;
  /** e.g. "Q4_K_M". */
  quantization: string | null;
  /** Native context from model_info["<arch>.context_length"]. */
  nativeContext: number | null;
  /** Context Ashlr actually configures for this seat, when it differs. */
  configuredContext: number | null;
  /**
   * `capabilities` from /api/show. `null` means the capability list was not
   * reported — which is NOT the same as "does not support tools".
   */
  capabilities: string[] | null;
  /**
   * The runtime's own answer to "can this drive an agentic session", which is
   * AUTHORITATIVE over `capabilities` and must be preferred when non-null.
   *
   * This matters: owner T sends `capabilities: []` when a runtime reported no
   * capability list, and reading that array alone would render "no tools" —
   * a hard, wrong gate — where T's `supportsTools: null` correctly means
   * "unknown". Deriving tool support from the array alone was a real defect
   * at this seam, not a cosmetic one.
   */
  supportsTools: boolean | null;
}

export interface LocalModelsSnapshot {
  reachable: boolean;
  models: LocalModel[];
  /** Machine memory budget in bytes, or null when the server did not say. */
  memoryBudgetBytes: number | null;
  reason: string | null;
}

// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(source: Record<string, unknown>, key: string): string | null {
  const v = source[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(source: Record<string, unknown>, key: string): number | null {
  const v = source[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function bool(source: Record<string, unknown>, key: string, fallback = false): boolean {
  const v = source[key];
  return typeof v === 'boolean' ? v : fallback;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Drop anything that looks like a native-profile launcher invocation or an
 * absolute path into the private account store. The server is supposed to
 * strip these; this is the client-side backstop, because the cost of printing
 * one is unacceptable and the cost of showing "no command" is a sentence.
 */
const FORBIDDEN_COMMAND = /(launcher\.mjs|native-profiles|account-connections|console-startup|\/\.ashlr\b|Bearer\s|--token\b)/i;

export function sanitizeCommand(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  if (FORBIDDEN_COMMAND.test(trimmed)) return null;
  // A newline would let a payload smuggle a second command onto the surface.
  if (/[\r\n]/.test(trimmed)) return null;
  return trimmed;
}

function clampPercent(value: number | null): number | null {
  if (value === null) return null;
  return Math.max(0, Math.min(100, value));
}

function projectWindow(raw: unknown): AccountWindow | null {
  const r = record(raw);
  if (!r) return null;
  const id = str(r, 'id') ?? str(r, 'label');
  if (id === null) return null;
  const native = record(r['nativeReport']);
  return {
    id,
    label: str(r, 'label'),
    usedPercent: clampPercent(num(r, 'usedPercent') ?? num(r, 'used_percent')),
    resetsAt: str(r, 'resetsAt') ?? str(r, 'resets_at'),
    resetDescription:
      (native ? str(native, 'resetDescription') : null) ?? str(r, 'resetDescription'),
    limitReached: bool(r, 'limitReached') || bool(r, 'rateLimitReached'),
  };
}

function projectCredits(raw: unknown): AccountCredits | null {
  const r = record(raw);
  if (!r) return null;
  const balance = str(r, 'balance');
  const parsed = balance === null ? num(r, 'balance') : Number.parseFloat(balance);
  return {
    hasCredits: bool(r, 'hasCredits') || bool(r, 'has_credits'),
    unlimited: bool(r, 'unlimited'),
    balance,
    balanceValue: typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null,
  };
}

const PROVIDERS: readonly string[] = ['claude', 'codex', 'grok'];

function projectAccount(raw: unknown): Account | null {
  const r = record(raw);
  if (!r) return null;
  const id = str(r, 'id');
  const provider = str(r, 'provider');
  if (id === null || provider === null || !PROVIDERS.includes(provider)) return null;

  const windows = list(r['windows'])
    .map(projectWindow)
    .filter((w): w is AccountWindow => w !== null);

  const state = str(r, 'state');
  const auth = str(r, 'authentication');
  const unsupportedRaw = record(r['unsupported']);

  return {
    id,
    label: str(r, 'label') ?? id,
    provider: provider as AccountProvider,
    state:
      state === 'checking' || state === 'observed' || state === 'signed-out' || state === 'unavailable'
        ? state
        : 'unavailable',
    authentication: auth === 'signed-in' || auth === 'signed-out' ? auth : 'unknown',
    planType: str(r, 'planType') ?? str(r, 'plan_type'),
    observedAt: str(r, 'observedAt'),
    windows,
    binding: projectWindow(r['binding']),
    credits: projectCredits(r['credits']),
    reason: str(r, 'reason'),
    unsupported: projectUnsupported(r, unsupportedRaw),
    reconnectCommand: sanitizeCommand(r['reconnectCommand']),
    notes: list(r['notes']).filter((n): n is string => typeof n === 'string'),
  };
}

/**
 * A version-pinned probe that failed CLOSED, named rather than swallowed.
 *
 * `unsupported` is not a field on the wire. Owner T reports the failure as the
 * verbatim probe code in `reason` (`usage-version-unsupported`) and states the
 * pin in `notes`, so this derives the structured form from those rather than
 * requiring a late contract change. An explicit `unsupported` object is still
 * honoured first, so a server that grows one later wins without a client edit.
 */
function projectUnsupported(
  r: Record<string, unknown>,
  explicit: Record<string, unknown> | null,
): Account['unsupported'] {
  if (explicit) {
    return {
      code: str(explicit, 'code') ?? CLAUDE_VERSION_REASON,
      pinnedVersion: str(explicit, 'pinnedVersion') ?? str(explicit, 'version'),
    };
  }
  const reason = str(r, 'reason');
  if (reason !== CLAUDE_VERSION_REASON) return null;
  return { code: reason, pinnedVersion: CLAUDE_USAGE_PINNED_VERSION };
}

/**
 * The read-only banner. Owner T reports lease ownership as a structured
 * `collector` status, not a flat `collectorNote`, so the note is derived from
 * it — and ONLY when another process owns the lease, because that is the one
 * case where these readings may be staler than this server's poll interval.
 * A stray `collectorNote` string is still accepted for forward compatibility.
 */
function projectCollectorNote(root: Record<string, unknown>): string | null {
  const flat = str(root, 'collectorNote');
  if (flat) return flat;
  const collector = record(root['collector']);
  if (!collector) return null;
  if (str(collector, 'owner') !== 'another-collector') return null;
  return (
    str(collector, 'note') ??
    'Another collector process owns the quota-refresh lease, so these readings are read-only and may be staler than this server’s poll interval.'
  );
}

export function projectAccountsSnapshot(raw: unknown): AccountsSnapshot | null {
  const root = record(raw);
  if (!root) return null;
  const rawAccounts = Array.isArray(root['accounts']) ? root['accounts'] : Array.isArray(raw) ? raw : null;
  if (rawAccounts === null) return null;
  return {
    sampledAt: str(root, 'sampledAt'),
    refreshing: bool(root, 'refreshing'),
    accounts: rawAccounts.map(projectAccount).filter((a): a is Account => a !== null),
    collectorNote: projectCollectorNote(root),
  };
}

function projectDay(raw: unknown): DailyUsage | null {
  const r = record(raw);
  if (!r) return null;
  const day = str(r, 'day');
  if (day === null || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return {
    day,
    tokensIn: num(r, 'tokensIn') ?? 0,
    tokensOut: num(r, 'tokensOut') ?? 0,
    estCostUsd: num(r, 'estCostUsd') ?? 0,
    sessions: num(r, 'sessions') ?? 0,
    cacheRead: num(r, 'cacheRead'),
    cacheWrite: num(r, 'cacheWrite'),
    cacheHitRate: num(r, 'cacheHitRate'),
  };
}

/**
 * `byDay` is the wire key. Owner T wraps the series as
 * `{window, byDay, estimated, caveats}` rather than returning a bare array
 * (documented deviation 1), so `byDay` is read FIRST. `days` and a bare array
 * remain accepted so an older or differently-shaped server degrades to a
 * rendered series instead of a dead panel.
 */
export function projectUsageSeries(raw: unknown, requested: SeriesWindow): UsageSeries | null {
  const root = record(raw);
  const rawDays = root
    ? Array.isArray(root['byDay'])
      ? root['byDay']
      : Array.isArray(root['days'])
        ? root['days']
        : null
    : Array.isArray(raw)
      ? raw
      : null;
  if (rawDays === null) return null;
  const windowValue = root ? str(root, 'window') : null;
  return {
    window: windowValue === '7d' || windowValue === '30d' ? windowValue : requested,
    days: rawDays
      .map(projectDay)
      .filter((d): d is DailyUsage => d !== null)
      .sort((a, b) => a.day.localeCompare(b.day)),
    generatedAt: root ? str(root, 'generatedAt') : null,
  };
}

function projectLocalModel(raw: unknown, runtime: LocalModel['runtime']): LocalModel | null {
  const r = record(raw);
  if (!r) return null;
  // `label`/`id` are owner T's spellings; `name`/`model` are the Ollama-native
  // ones a differently-shaped server might send.
  const name = str(r, 'label') ?? str(r, 'id') ?? str(r, 'name') ?? str(r, 'model');
  if (name === null) return null;
  const caps = r['capabilities'];
  const state = str(r, 'state');
  const supportsTools = r['supportsTools'];

  // `nativeContextLength` is the architecture maximum; `contextLength` is what
  // the runtime actually configured for the loaded instance. They are two
  // different facts and the panel shows the gap between them, so they must not
  // collapse onto one field.
  const nativeContext = num(r, 'nativeContextLength') ?? num(r, 'nativeContext');
  const configuredContext = num(r, 'contextLength') ?? num(r, 'configuredContext');

  return {
    name,
    runtime,
    loaded: state !== null ? state === 'loaded' : bool(r, 'loaded') || bool(r, 'resident'),
    sizeBytes: num(r, 'sizeBytes') ?? num(r, 'size'),
    sizeVramBytes: num(r, 'sizeVramBytes') ?? num(r, 'size_vram'),
    expiresAt: str(r, 'expiresAt') ?? str(r, 'expires_at'),
    parameterSize: str(r, 'parameterSize') ?? str(r, 'parameter_size'),
    quantization: str(r, 'quantization') ?? str(r, 'quantization_level'),
    nativeContext,
    // Only a genuine narrowing is worth showing. When the runtime reports the
    // same number twice there is no truncation to report.
    configuredContext:
      configuredContext !== null && nativeContext !== null && configuredContext === nativeContext
        ? null
        : configuredContext,
    capabilities: Array.isArray(caps) ? caps.filter((c): c is string => typeof c === 'string') : null,
    supportsTools: typeof supportsTools === 'boolean' ? supportsTools : null,
  };
}

function projectRuntimeReport(
  raw: unknown,
  runtime: NonNullable<LocalModel['runtime']>,
): { reachable: boolean; models: LocalModel[]; reason: string | null } | null {
  const r = record(raw);
  if (!r) return null;
  const rawModels = Array.isArray(r['models']) ? r['models'] : null;
  if (rawModels === null) return null;
  return {
    reachable: bool(r, 'reachable'),
    models: rawModels
      .map((m) => projectLocalModel(m, runtime))
      .filter((m): m is LocalModel => m !== null),
    reason: str(r, 'reason'),
  };
}

/**
 * Owner T reports local availability per RUNTIME (`ollama`, `lmStudio`) with a
 * shared `machine` budget. This panel answers one question — "what can I run
 * right now, and against how much memory" — so the runtimes are flattened into
 * one list, each row keeping its `runtime` so it stays attributable.
 *
 * Reachability is the OR of the runtimes: one dead runtime is not an unreachable
 * local stack. `reason` is only carried when NOTHING is reachable, because a
 * degradation note beside a working list would misdescribe what is on screen.
 *
 * A flat `{reachable, models, memoryBudgetBytes}` body is still accepted, so an
 * older or differently-shaped server degrades rather than rendering nothing.
 */
export function projectLocalModels(raw: unknown): LocalModelsSnapshot | null {
  const root = record(raw);
  if (!root) return null;

  const ollama = projectRuntimeReport(root['ollama'], 'ollama');
  const lmStudio = projectRuntimeReport(root['lmStudio'] ?? root['lmstudio'], 'lmstudio');

  if (ollama !== null || lmStudio !== null) {
    const reports = [ollama, lmStudio].filter((x): x is NonNullable<typeof x> => x !== null);
    const reachable = reports.some((x) => x.reachable);
    const machine = record(root['machine']);
    return {
      reachable,
      models: reports.flatMap((x) => x.models),
      memoryBudgetBytes:
        (machine ? num(machine, 'totalMemoryBytes') : null) ??
        num(root, 'memoryBudgetBytes') ??
        num(root, 'memoryBudget'),
      reason: reachable ? null : (reports.map((x) => x.reason).find((x) => x !== null) ?? null),
    };
  }

  const rawModels = Array.isArray(root['models']) ? root['models'] : null;
  if (rawModels === null) return null;
  return {
    reachable: bool(root, 'reachable', true),
    models: rawModels.map((m) => projectLocalModel(m, null)).filter((m): m is LocalModel => m !== null),
    memoryBudgetBytes: num(root, 'memoryBudgetBytes') ?? num(root, 'memoryBudget'),
    reason: str(root, 'reason'),
  };
}
