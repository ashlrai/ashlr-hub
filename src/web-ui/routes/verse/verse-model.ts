/**
 * routes/verse/verse-model.ts — small pure helpers shared by the Verse
 * components (labels, grouping, health → tone). No React, no I/O.
 */
import type { VerseEngine, VerseModelOption, VerseProject, VerseSeat, VerseSeatHealth, VerseSession } from '../../data/api-types.js';
import type { VerseContextMode, VerseWindowSource } from '../../../core/verse/types.js';
import type { Tone } from '../../components/primitives/StatusBadge.js';
// context-math is PURE and browser-safe by contract (its only import is
// type-only), so a value import here does not drag node into the bundle.
import { budgetFor, canonicalModelId, claudeAutocompactFlag, reconcileAutoCompactAt } from '../../../core/verse/context-math.js';
import { usedPercentText } from './percent-text.js';
import { formatTokens } from './verse-store.js';

export const ENGINE_ORDER: readonly VerseEngine[] = ['claude', 'codex', 'grok', 'local'];

export const ENGINE_LABEL: Record<VerseEngine, string> = {
  claude: 'Claude',
  codex: 'Codex',
  grok: 'Grok',
  local: 'Local',
};

export function isVerseEngine(value: string): value is VerseEngine {
  return (ENGINE_ORDER as readonly string[]).includes(value);
}

export function projectName(path: string, projects: readonly VerseProject[] = []): string {
  const known = projects.find((p) => p.path === path);
  if (known) return known.name;
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function seatById(seats: readonly VerseSeat[], seatId: string): VerseSeat | undefined {
  return seats.find((s) => s.id === seatId);
}

export function seatLabel(seats: readonly VerseSeat[], session: Pick<VerseSession, 'seatId' | 'engine'>): string {
  return seatById(seats, session.seatId)?.label ?? ENGINE_LABEL[session.engine];
}

export function modelLabel(seats: readonly VerseSeat[], session: Pick<VerseSession, 'seatId' | 'model'>): string {
  const seat = seatById(seats, session.seatId);
  return seat?.models.find((m) => m.id === session.model)?.label ?? session.model;
}

/**
 * The seat's catalog entry for a session's model. Exact id first; then the
 * canonical form, because a session created before the alias fix stores
 * `claude-opus-5.5` while today's catalog lists `claude-opus-5-5` (context-math
 * `VERSE_MODEL_ID_ALIASES`) — the record keeps its id, the lookup must not miss.
 */
export function modelOptionFor(seats: readonly VerseSeat[], session: Pick<VerseSession, 'seatId' | 'model'>): VerseModelOption | null {
  const seat = seatById(seats, session.seatId);
  if (!seat) return null;
  const exact = seat.models.find((m) => m.id === session.model);
  if (exact) return exact;
  const canonical = canonicalModelId(session.model);
  return seat.models.find((m) => canonicalModelId(m.id) === canonical) ?? null;
}

/** Everything the meter, the composer's cost hint and the advice banners read. */
export interface SessionContextBudget {
  /** Live occupancy as stored — UNCLAMPED; only the drawing clamps. */
  contextTokens: number;
  contextWindow: number | null;
  autoCompactAt: number | null;
  /** False when `contextTokens` is an upper bound (codex before its rollout is read). */
  exact: boolean;
  /** Where `contextWindow` came from; null when nothing on the record says. */
  source: VerseWindowSource | null;
  mode: VerseContextMode;
  /** The catalog option the session's model maps to on its seat, when listed. */
  option: VerseModelOption | null;
}

function positive(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The window a session is measured against, and where it compacts.
 *
 * Precedence (docs/VERSE-CONTEXT.md, "honesty rules"):
 *
 *  0. LOCAL — the window STORED on the record, whatever its source. Verse
 *     SETS a local seat's window: the claude adapter passes the stored
 *     `usage.contextWindow` as `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, and the
 *     engine refreshes that stored value from live discovery before each
 *     turn. The seat's CURRENT option can differ (another dispatch lane,
 *     another resident num_ctx), and drawing it measured the chat against a
 *     window the CLI was never told — "past the 66k window" for a chat the
 *     CLI compacts at 229k. The meter and the CLI must quote one number.
 *  1. RUNTIME — the CLI reported the window for this session's last turn
 *     (`usage.contextWindowSource === 'runtime'`). Nothing outranks what the
 *     CLI said it is actually running with (e.g. Claude Code clamping a 1M
 *     model to 200k when long-context credit runs out).
 *  2. CATALOG — the seat's CURRENT option for the session's model, in the
 *     session's mode. Current rather than stored so a corrected catalog (a
 *     fixed window table, a mode switch) shows up without waiting for a turn.
 *  3. STORED — whatever the record carries (every pre-3.9 session).
 *  4. The seat's default window, marked `fallback`.
 *
 * A compaction point is only ever DERIVED from a window it belongs to: a
 * runtime window without a stored point is reconciled with context-math's
 * per-engine formula, never paired with a catalog point for another window.
 */
export function sessionContextBudget(
  seats: readonly VerseSeat[],
  session: Pick<VerseSession, 'seatId' | 'model' | 'usage' | 'engine' | 'contextMode'>,
): SessionContextBudget {
  const usage = session.usage;
  // No UI-side legacy rule: the engine materialises a pre-3.9 Claude
  // record's mode (and its budget) on startup and on every touch, so every
  // record reaching the browser already names the mode it runs in.
  const mode: VerseContextMode = session.contextMode ?? 'standard';
  const option = modelOptionFor(seats, session);
  const base = {
    contextTokens: typeof usage.contextTokens === 'number' && Number.isFinite(usage.contextTokens) ? Math.max(0, usage.contextTokens) : 0,
    exact: usage.contextTokensExact !== false,
    mode,
    option,
  };
  const catalog = budgetFor(option, mode);

  const stored = positive(usage.contextWindow);
  if (stored !== null && (session.engine === 'local' || usage.contextWindowSource === 'runtime')) {
    const storedPoint = positive(usage.autoCompactAt ?? null);
    const autoCompactAt = storedPoint ?? reconcileAutoCompactAt({
      engine: session.engine,
      runtimeWindow: stored,
      // A local window is the whole budget (no --autocompact); pairing it
      // with the seat's current option would borrow another window's point.
      budget: session.engine === 'local' ? null : catalog,
      autocompactWindow: session.engine === 'claude' ? claudeAutocompactFlag(option, mode) : null,
      maxOutputTokens: option?.maxOutputTokens ?? null,
    });
    const source = session.engine === 'local' ? usage.contextWindowSource ?? null : 'runtime';
    return { ...base, contextWindow: stored, autoCompactAt, source };
  }
  if (catalog) {
    return { ...base, contextWindow: catalog.contextWindow, autoCompactAt: catalog.autoCompactAt, source: option?.windowSource ?? 'fallback' };
  }
  if (stored !== null) {
    return { ...base, contextWindow: stored, autoCompactAt: positive(usage.autoCompactAt ?? null), source: usage.contextWindowSource ?? null };
  }
  const seatWindow = positive(seatById(seats, session.seatId)?.contextWindow ?? null);
  return { ...base, contextWindow: seatWindow, autoCompactAt: null, source: seatWindow !== null ? 'fallback' : null };
}

/** Context window for a session — see {@link sessionContextBudget} for the precedence. */
export function contextWindowFor(
  seats: readonly VerseSeat[],
  session: Pick<VerseSession, 'seatId' | 'model' | 'usage' | 'engine' | 'contextMode'>,
): number | null {
  return sessionContextBudget(seats, session).contextWindow;
}

/** Plain words for a window's provenance — the meter's tooltip and the resources panel share them. */
export const WINDOW_SOURCE_TEXT: Record<VerseWindowSource, string> = {
  runtime: 'reported by the CLI on the last turn',
  'provider-catalog': "from this seat's own model catalog",
  'cli-catalog': "from the pinned CLI's built-in model table",
  documented: "from the provider's published model table",
  fallback: 'a default estimate — the CLI has not reported the real window yet',
};

/**
 * The same provenance, per engine. On a LOCAL seat nothing is "reported by
 * the CLI": Verse measures the window from the model server (llama-server
 * slot, Ollama residency/defaults) and TELLS Claude Code to use it, so the
 * sentence names both halves.
 */
export function windowSourceText(source: VerseWindowSource, engine: VerseEngine | null | undefined): string {
  if (engine !== 'local') return WINDOW_SOURCE_TEXT[source];
  const from = source === 'runtime' ? 'measured from the local model server'
    : source === 'fallback' ? 'a default estimate — the model server did not report one'
    : WINDOW_SOURCE_TEXT[source];
  return `${from}; Verse passes this window to Claude Code for this chat`;
}

/**
 * The one sentence about Codex's surcharge above its standard window, for
 * every surface that prices Expansive on codex (the mode menu, the
 * "Expansive could help" chip, the new-chat mode selector, the handoff
 * dialog). Worded as REPORTED because that is all it is: the sources
 * docs/VERSE-CONTEXT.md §2.3 cites say GPT-5.6-class requests above 272k
 * count about 2× against plan limits, and Verse has no reading of its own
 * that confirms the multiplier. It multiplies the size ratio the copy quotes
 * (the ratio of the two compaction points), which is why it says "twice that".
 */
export const CODEX_EXPANSIVE_METERING_NOTE =
  'OpenAI reportedly also counts requests above 272k tokens at about 2× against plan limits, so a turn near the expansive limit may cost roughly twice that.';

/** The first model on a seat that can actually run (skips ones listed with an `unavailableReason`). */
export function firstRunnableModel(seat: VerseSeat): VerseModelOption | null {
  return seat.models.find((m) => !m.unavailableReason) ?? null;
}

export function healthTone(state: VerseSeatHealth['state']): Tone {
  switch (state) {
    case 'ready':
      return 'success';
    case 'degraded':
      return 'warning';
    case 'unavailable':
      return 'danger';
    default:
      return 'unknown';
  }
}

export function seatUnavailableReason(seat: VerseSeat): string | null {
  if (seat.health.state !== 'unavailable') return null;
  return seat.health.summary ?? 'seat unavailable';
}

// ---------------------------------------------------------------------------
// Seat capacity — "which account can I actually use right now", at the point
// the choice is made
// ---------------------------------------------------------------------------

/**
 * The four answers a picker needs. Same vocabulary as the Usage section's
 * `CapacityClass` so the two surfaces never use different words for one state.
 */
export type SeatCapacityClass = 'ready' | 'tight' | 'blocked' | 'unread';

/** Word, never colour alone (DESIGN-V2 §6). */
export const SEAT_CAPACITY_WORD: Record<SeatCapacityClass, string> = {
  ready: 'usable',
  tight: 'tight',
  blocked: 'blocked',
  unread: 'no reading',
};

/** Above this share of the binding window a seat is worth flagging. */
const TIGHT_PERCENT = 85;

export interface SeatCapacityNote {
  cls: SeatCapacityClass;
  /**
   * The binding window's percent when it is a real measurement. Null for an
   * unread seat AND at the 100 ceiling, where the upstream value may be the
   * provider's "limit reached" sentinel rather than a reading
   * (docs/VERSE-TELEMETRY-V2.md) — and "limit reached" is true under either.
   */
  usedPercent: number | null;
  /** One short phrase for an option label, a pill title, a menu row. */
  text: string;
}

/** `seven_day_fable` → `weekly (fable)`; `five_hour` → `5-hour`. */
export function seatWindowLabel(id: string): string {
  const known: Record<string, string> = {
    five_hour: '5-hour window',
    seven_day: 'weekly window',
    codex: 'weekly window',
  };
  if (known[id]) return known[id];
  const perModel = /^seven_day_(.+)$/.exec(id);
  if (perModel) return `weekly ${perModel[1]!.replace(/_/g, ' ')} window`;
  return `${id.replace(/_/g, ' ')} window`;
}

/**
 * What a seat's own health says about whether a turn sent to it will land.
 *
 * This exists because the seat picker showed NOTHING: it annotated an option
 * only when `health.state === 'unavailable'`, and Claude's `health` is
 * `unknown` by construction (docs/VERSE-TELEMETRY-V2.md). So a Claude seat
 * whose binding weekly window reads 100% used appeared as an ordinary,
 * enabled, unannotated choice, and the exhaustion was discovered at turn time
 * — exactly the failure the Usage section was built to prevent.
 *
 * A `blocked` seat is MARKED, never disabled: a used-up window can coexist
 * with a spendable credit balance, so refusing the choice would be a stronger
 * claim than the data supports.
 */
export function seatCapacity(seat: VerseSeat): SeatCapacityNote {
  const reason = seatUnavailableReason(seat);
  if (reason !== null) return { cls: 'blocked', usedPercent: null, text: reason };

  const measured = seat.health.windows.filter(
    (w): w is { id: string; usedPercent: number; resetsAt: string | null } =>
      typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent),
  );
  // No window reported a number. That is an unanswered question, not a zero —
  // an empty meter would read "plenty left".
  if (measured.length === 0) return { cls: 'unread', usedPercent: null, text: 'no capacity reading' };

  const binding = measured.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
  const pct = Math.max(0, Math.min(100, binding.usedPercent));
  const where = seatWindowLabel(binding.id);
  if (pct >= 100) return { cls: 'blocked', usedPercent: null, text: `${where} limit reached` };
  return {
    cls: pct >= TIGHT_PERCENT ? 'tight' : 'ready',
    usedPercent: pct,
    text: `${usedPercentText(pct)} of ${where} used`,
  };
}

/** Seats grouped in the fixed engine order; empty engines are omitted. */
export function groupSeats(seats: readonly VerseSeat[]): Array<{ engine: VerseEngine; seats: VerseSeat[] }> {
  return ENGINE_ORDER.map((engine) => ({ engine, seats: seats.filter((s) => s.engine === engine) })).filter((g) => g.seats.length > 0);
}

export interface SessionGroup {
  projectPath: string;
  name: string;
  enrolled: boolean;
  sessions: VerseSession[];
}

/** Sidebar grouping: by project, most recently touched project first, sessions newest first. */
export function groupSessions(sessions: readonly VerseSession[], projects: readonly VerseProject[], query = ''): SessionGroup[] {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? sessions.filter((s) =>
        s.title.toLowerCase().includes(q) ||
        s.projectPath.toLowerCase().includes(q) ||
        s.model.toLowerCase().includes(q) ||
        s.seatId.toLowerCase().includes(q))
    : [...sessions];
  const byProject = new Map<string, VerseSession[]>();
  for (const s of filtered) {
    const list = byProject.get(s.projectPath) ?? [];
    list.push(s);
    byProject.set(s.projectPath, list);
  }
  const groups: SessionGroup[] = [];
  for (const [projectPath, list] of byProject) {
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    groups.push({
      projectPath,
      name: projectName(projectPath, projects),
      enrolled: projects.find((p) => p.path === projectPath)?.enrolled ?? false,
      sessions: list,
    });
  }
  groups.sort((a, b) => b.sessions[0]!.updatedAt.localeCompare(a.sessions[0]!.updatedAt));
  return groups;
}

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return formatElapsed(ms);
}

/**
 * Sidebar rows carry a right-aligned relative time. Short by design — the
 * row has ~5ch for it — and it degrades to a date rather than "412d".
 * `now` is injectable so the format is testable without faking the clock.
 */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 0) return 'now';
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(then).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** One-line description of a tool call for a collapsed card header. */
export function summarizeToolInput(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return truncate(input, 96);
  if (typeof input !== 'object') return truncate(String(input), 96);
  const record = input as Record<string, unknown>;
  const preferred = ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt', 'text'];
  for (const key of preferred) {
    const v = record[key];
    if (typeof v === 'string' && v.trim()) return truncate(v.trim().replace(/\s+/g, ' '), 96);
  }
  const keys = Object.keys(record);
  if (keys.length === 0) return '';
  const first = record[keys[0]!];
  const rendered = typeof first === 'string' ? first : JSON.stringify(first);
  return truncate(`${keys[0]}: ${rendered ?? ''}`.replace(/\s+/g, ' '), 96);
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Pretty JSON for tool cards; falls back to String() for non-serializable input. */
export function prettyJson(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

/**
 * Accepts POSIX/Windows absolute paths and `~/...`. The server rewrites the
 * home directory as `~` in every outbound payload (sanitizePublicJson) and
 * expands it again on the way in, so a `~/` project from bootstrap is valid.
 */
export function isAbsolutePath(value: string): boolean {
  return /^(?:\/|~(?:\/|$)|[a-zA-Z]:[\\/]|\\\\)/.test(value) &&
    ![...value].some((c) => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159));
}

/**
 * Seat pill text: "<seat> · <model>", collapsing to just the seat when the
 * model label is already contained in it (local seats expose one model whose
 * name is the seat name), so the pill never reads "Qwen3-Coder · Qwen3-Coder".
 */
export function seatPillLabel(seats: readonly VerseSeat[], ref: Pick<VerseSession, 'seatId' | 'engine' | 'model'>): string {
  const seat = seatLabel(seats, ref);
  const model = modelLabel(seats, ref);
  if (!model || seat.toLowerCase().includes(model.toLowerCase())) return seat;
  return `${seat} · ${model}`;
}

/**
 * The ONE spelling of a context WINDOW's size, for every surface that prints
 * one (New chat's picker, the context meter, Usage, Resources, Fleet).
 *
 * There used to be two: decimal (`formatTokens`, 65536 → "66k") in the
 * picker and meter, binary (65536 → "64k") in Usage / Resources / Fleet, so
 * one local model read "66k ctx" in New chat and "64k" in Resources. Now:
 *
 *   - an exact multiple of 1024 is quoted in binary k, the way its model card
 *     and a `ctx64k` tag say it: 65536 → "64k", 262144 → "256k", 1048576 → "1M";
 *   - anything else stays decimal: 200000 → "200k", 272000 → "272k", 1000000 → "1M".
 *
 * Token COUNTS (what a chat holds, where it compacts) are not windows and
 * keep `formatTokens`. Lives in this (lazy, already shared) module rather
 * than one of its own: a new module became one more chunk name in the
 * first-paint files' preload tables, and verse-store.ts is first-paint code.
 */
export function formatContextWindow(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isInteger(n) || n < 1024 || n % 1024 !== 0) return formatTokens(n);
  return n < 1_048_576 ? `${n / 1024}k` : `${(n / 1_048_576).toFixed(1).replace(/\.0$/, '')}M`;
}
