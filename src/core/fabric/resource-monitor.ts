/**
 * resource-monitor.ts — M250/M253 Resource Control Plane.
 *
 * Senses per-backend resource headroom and returns a snapshot that the
 * gateway (M252) uses to demote exhausted backends before dispatch.
 *
 * DESIGN INVARIANTS:
 *  - Never throws. Every sensing path is wrapped in try/catch and degrades
 *    to availability:'unknown', which resource-aware dispatch treats as no
 *    trusted capacity signal.
 *  - No network calls except the Ollama localhost health check (2s timeout).
 *  - Claude sensing: first trusts unexpired Claude CLI rate_limit_event JSONL
 *    captured locally, then falls back to OAuth usage, transcript sensing, and
 *    finally legacy stats-cache/fleet budget paths.
 *  - M253 sums the FLEET's own claude token spend (tokensIn+tokensOut) or
 *    costUsd from the decisions-ledger over a rolling
 *    window (default 7d) vs a configured budget. This reflects what the fleet
 *    has consumed — NOT Mason's interactive usage, which is not programmatically
 *    obtainable (stats-cache.json is dead/stale on most machines). The label
 *    clearly says "fleet 7d claude spend vs budget". ~/.claude/stats-cache.json
 *    is used ONLY as a weak fallback when its lastComputedDate is within the
 *    window AND the new ledger-based budget fields are absent.
 *  - Codex sensing delegates entirely to readCodexRateLimits() — real data.
 *  - NIM sensing is reactive-only: reads the in-memory backoff store.
 *  - Local/Ollama sensing: GET /api/ps with 2s timeout.
 *  - Builtin: always available, no sensing needed.
 *
 * Integration point for M255 concurrent dispatcher:
 *   import { getResourceSnapshot } from './resource-monitor.js';
 *   const snap = await getResourceSnapshot(cfg);          // cached 30s
 *   const claudeState = snap.backends.find(b => b.backend === 'claude');
 *   // claudeState.availability tells the dispatcher how many concurrent
 *   // claude slots to allow (open=N, near=N/2, throttled/exhausted=0).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import type { EngineId } from '../types.js';
import { readCodexRateLimits } from '../observability/codex-source.js';
import { readDecisions } from '../fleet/decisions-ledger.js';
import {
  readClaudeUsage,
  DEFAULT_5H_MESSAGE_CAP_PRO,
} from './claude-usage.js';
import { fetchClaudeUsageApi } from './usage-api.js';
import {
  onClaudeRateLimitEventRecorded,
  readLatestClaudeRateLimitEvent,
  type ClaudeRateLimitEvent,
} from './claude-rate-limit-event.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type BackendAvailability =
  | 'open'        // within limits, no recent errors
  | 'near'        // >= warningThreshold% of configured cap
  | 'throttled'   // deliberately held back (protect headroom for human)
  | 'exhausted'   // >= 100% of cap OR recent 429 with no reset time
  | 'unreachable' // health check failed (local only)
  | 'unknown';    // no signal available

export interface BackendResourceState {
  /** Backend engine id. */
  backend: EngineId;
  /** Availability classification. */
  availability: BackendAvailability;
  /** 0–100 estimated usage percentage. Null when unknowable. */
  usedPct: number | null;
  /** Configured hard cap (messages/tokens/requests depending on backend). */
  cap: number | null;
  /** Units for cap/used. */
  capUnit: 'messages' | 'tokens' | 'requests' | 'concurrent' | null;
  /** Window label for the cap (e.g. '7d', '5h', '1d'). */
  capWindow: string | null;
  /** Unix epoch seconds when the window resets. Null when unknown. */
  resetsAt: number | null;
  /** Estimated cost per 1M output tokens (USD). 0 for subscription/local. */
  costPerMTokenOut: number;
  /** Median observed latency (ms). Null until samples exist. */
  p50LatencyMs: number | null;
  /** ISO timestamp of this snapshot. */
  snapshotAt: string;
  /** Reason string for current availability state. */
  reason: string;
  /**
   * Backoff state: set when a 429/error was received.
   * Gateway will not route to this backend until backoffUntilMs has passed.
   */
  backoffUntilMs: number | null;
}

export interface ResourceSnapshot {
  generatedAt: string;
  backends: BackendResourceState[];
}

// ---------------------------------------------------------------------------
// Backoff store — in-memory, resets on process restart (intentional).
// Called by fleet daemon's 429 handler; read by getResourceState().
// ---------------------------------------------------------------------------

const backoffStore = new Map<EngineId, { until: number; reason: string }>();

/**
 * Record a rate-limit backoff for a backend.
 * Also invalidates the snapshot cache so the next call re-senses.
 */
export function recordBackoff(backend: EngineId, retryAfterMs: number, reason: string): void {
  backoffStore.set(backend, { until: Date.now() + retryAfterMs, reason });
  // Invalidate cache so the gateway picks up the backoff immediately.
  _snapshotCache = null;
}

/** Clear backoff for a backend (called after a successful dispatch). */
export function clearBackoff(backend: EngineId): void {
  backoffStore.delete(backend);
  _snapshotCache = null;
}

/**
 * M300: Synchronously peek at the CACHED availability for a backend.
 * Returns the cached availability string when a fresh (<30s) snapshot is
 * available, otherwise returns null (no I/O, never throws).
 *
 * Used by resolveJudgeClient (sync) to avoid awaiting a new snapshot on
 * every judge resolution. If the cache is stale, the caller decides whether a
 * missing signal is acceptable for that path.
 */
export function peekBackendAvailability(backend: EngineId): BackendAvailability | null {
  try {
    if (!_snapshotCache || _snapshotCache.expiresAt <= Date.now()) return null;
    const state = _snapshotCache.snapshot.backends.find((b) => b.backend === backend);
    return state?.availability ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface SnapshotCache {
  snapshot: ResourceSnapshot;
  expiresAt: number;
}

let _snapshotCache: SnapshotCache | null = null;
const CACHE_TTL_MS = 30_000; // 30 seconds

function invalidateResourceSnapshotCache(): void {
  _snapshotCache = null;
}

onClaudeRateLimitEventRecorded(invalidateResourceSnapshotCache);

// ---------------------------------------------------------------------------
// Config shape (read defensively — never import from types to avoid coupling)
// ---------------------------------------------------------------------------

interface ClaudeResourceCfg {
  /**
   * M253 TRANSCRIPT (ccusage): 5-hour message cap for Claude Code subscription.
   * When set, transcript-based sensing uses this as the 5h window cap.
   * Defaults to DEFAULT_5H_MESSAGE_CAP_PRO (900) when absent.
   * Set to your plan's limit: ~900 (Pro), ~4500 (Max5), ~9000 (Max20).
   */
  fiveHourMessageCap?: number;
  /**
   * M253 TRANSCRIPT (ccusage): 7-day message cap.
   * Optional secondary window. When absent, only 5h sensing is used for
   * availability classification (7d is reported but not used for thresholds).
   */
  weeklyMessageCap?: number;
  /**
   * M253 TRANSCRIPT (ccusage): 5-hour token cap override.
   * When set, tokens are used instead of message count for availability.
   * Not typically set — message count is the correct subscription metric.
   */
  fiveHourTokenCap?: number;
  /**
   * M253: fleet claude token budget over the window. When set, sensing uses
   * the decisions-ledger token sum (tokensIn+tokensOut) vs this cap.
   * Represents the fleet's own consumption — NOT interactive usage.
   */
  weeklyTokenBudget?: number;
  /**
   * M253: fleet claude cost budget (USD) over the window. When both
   * weeklyTokenBudget and weeklyCostBudgetUsd are set, tokens take precedence.
   */
  weeklyCostBudgetUsd?: number;
  /** Rolling window label. Default: '7d'. */
  window?: string;
  /** protectPct on the claude sub-config (M251). */
  protectPct?: number;
}

interface ResourceOverrideCfg {
  availability?: BackendAvailability;
  until?: string | number;
  resetsAt?: number;
  reason?: string;
  usedPct?: number;
  cap?: number;
  capUnit?: BackendResourceState['capUnit'];
  capWindow?: string;
}

interface ResourceCfgShape {
  claude?: ClaudeResourceCfg;
  overrides?: Record<string, ResourceOverrideCfg>;
  protectPct?: number;
  nim?: { costPerMTokenOut?: number };
  local?: { maxConcurrent?: number; baseUrl?: string };
}

const BACKEND_AVAILABILITIES = new Set<BackendAvailability>([
  'open',
  'near',
  'throttled',
  'exhausted',
  'unreachable',
  'unknown',
]);

function parseAvailability(value: unknown): BackendAvailability | undefined {
  return typeof value === 'string' && BACKEND_AVAILABILITIES.has(value as BackendAvailability)
    ? value as BackendAvailability
    : undefined;
}

function parseCapUnit(value: unknown): BackendResourceState['capUnit'] | undefined {
  return value === 'messages' || value === 'tokens' || value === 'requests' || value === 'concurrent'
    ? value
    : undefined;
}

function parseResourceOverrides(raw: unknown): Record<string, ResourceOverrideCfg> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, ResourceOverrideCfg> = {};
  for (const [backend, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const availability = parseAvailability(v['availability']);
    if (!availability) continue;
    out[backend] = {
      availability,
      until: typeof v['until'] === 'string' || typeof v['until'] === 'number' ? v['until'] : undefined,
      resetsAt: typeof v['resetsAt'] === 'number' ? v['resetsAt'] : undefined,
      reason: typeof v['reason'] === 'string' ? v['reason'] : undefined,
      usedPct: typeof v['usedPct'] === 'number' ? v['usedPct'] : undefined,
      cap: typeof v['cap'] === 'number' ? v['cap'] : undefined,
      capUnit: parseCapUnit(v['capUnit']),
      capWindow: typeof v['capWindow'] === 'string' ? v['capWindow'] : undefined,
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function extractResourceCfg(cfg: unknown): ResourceCfgShape {
  try {
    if (typeof cfg !== 'object' || cfg === null) return {};
    const foundry = (cfg as Record<string, unknown>)['foundry'];
    if (typeof foundry !== 'object' || foundry === null) return {};
    const f = foundry as Record<string, unknown>;

    // M251: claudeResource is the primary config field (new, from types.ts M251).
    // Fall back to foundry.limits.claude for older configs.
    const claudeResource = (f['claudeResource'] as Record<string, unknown> | undefined);
    const claudeLimitsLegacy = (f['limits'] as Record<string, unknown> | undefined)?.['claude'] as Record<string, unknown> | undefined;
    const claudeCfg: ClaudeResourceCfg | undefined = claudeResource
      ? {
          fiveHourMessageCap: typeof claudeResource['fiveHourMessageCap'] === 'number'
            ? (claudeResource['fiveHourMessageCap'] as number) : undefined,
          fiveHourTokenCap: typeof claudeResource['fiveHourTokenCap'] === 'number'
            ? (claudeResource['fiveHourTokenCap'] as number) : undefined,
          weeklyTokenBudget: typeof claudeResource['weeklyTokenBudget'] === 'number'
            ? (claudeResource['weeklyTokenBudget'] as number) : undefined,
          weeklyCostBudgetUsd: typeof claudeResource['weeklyCostBudgetUsd'] === 'number'
            ? (claudeResource['weeklyCostBudgetUsd'] as number) : undefined,
          weeklyMessageCap: typeof claudeResource['weeklyMessageCap'] === 'number'
            ? (claudeResource['weeklyMessageCap'] as number) : undefined,
          window: typeof claudeResource['window'] === 'string'
            ? (claudeResource['window'] as string) : undefined,
          protectPct: typeof claudeResource['protectPct'] === 'number'
            ? (claudeResource['protectPct'] as number) : undefined,
        }
      : claudeLimitsLegacy
        ? {
            weeklyMessageCap: typeof claudeLimitsLegacy['weeklyMessageCap'] === 'number'
              ? (claudeLimitsLegacy['weeklyMessageCap'] as number) : undefined,
            window: typeof claudeLimitsLegacy['window'] === 'string'
              ? (claudeLimitsLegacy['window'] as string) : undefined,
          }
        : undefined;

    // protectPct: prefer claudeResource.protectPct (M251/M253), already in claudeCfg.
    const protectPct = claudeCfg?.protectPct;

    return {
      claude: claudeCfg,
      overrides: parseResourceOverrides(f['resourceOverrides']),
      protectPct,
      nim: (f['nim'] as Record<string, unknown> | undefined) as ResourceCfgShape['nim'],
      local: (f['local'] as Record<string, unknown> | undefined) as ResourceCfgShape['local'],
    };
  } catch {
    return {};
  }
}

function parseOverrideResetAt(override: ResourceOverrideCfg): number | null {
  const raw = override.resetsAt ?? override.until;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 10_000_000_000 ? Math.floor(raw / 1000) : Math.floor(raw);
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
  }
  return null;
}

function overrideState(
  backend: EngineId,
  override: ResourceOverrideCfg | undefined,
): BackendResourceState | null {
  if (!override?.availability) return null;
  const resetsAt = parseOverrideResetAt(override);
  if (resetsAt !== null && resetsAt * 1000 <= Date.now()) return null;

  const untilSuffix = resetsAt !== null
    ? ` until ${new Date(resetsAt * 1000).toISOString()}`
    : '';
  const reason = override.reason
    ? `operator override: ${override.reason}${untilSuffix}`
    : `operator override: ${backend} forced ${override.availability}${untilSuffix}`;

  return {
    backend,
    availability: override.availability,
    usedPct: typeof override.usedPct === 'number' ? override.usedPct : null,
    cap: typeof override.cap === 'number' ? override.cap : null,
    capUnit: override.capUnit ?? null,
    capWindow: override.capWindow ?? null,
    resetsAt,
    costPerMTokenOut: 0,
    p50LatencyMs: null,
    snapshotAt: new Date().toISOString(),
    reason,
    backoffUntilMs: resetsAt !== null ? resetsAt * 1000 : null,
  };
}

// ---------------------------------------------------------------------------
// Per-backend sensing
// ---------------------------------------------------------------------------

/**
 * M253: Sum the fleet's own claude token spend from the decisions-ledger over
 * a rolling window. Returns { tokens, costUsd, entryCount }.
 *
 * Only counts entries where engine starts with 'claude' (case-insensitive).
 * Entries missing tokensIn/tokensOut/costUsd are treated as 0 (pre-M246).
 * Never throws.
 */
function sumFleetClaudeSpend(windowMs: number): { tokens: number; costUsd: number; entryCount: number } {
  try {
    const sinceMs = Date.now() - windowMs;
    const entries = readDecisions({ sinceMs });
    let tokens = 0;
    let costUsd = 0;
    let entryCount = 0;
    for (const e of entries) {
      const eng = (e.engine ?? '').toLowerCase();
      if (!eng.startsWith('claude')) continue;
      entryCount++;
      tokens += (e.tokensIn ?? 0) + (e.tokensOut ?? 0);
      costUsd += e.costUsd ?? 0;
    }
    return { tokens, costUsd, entryCount };
  } catch {
    return { tokens: 0, costUsd: 0, entryCount: 0 };
  }
}

/**
 * M253 staleness guard: return the stats-cache message sum ONLY when
 * lastComputedDate is within the window. Returns:
 *   - a number (>=0) when the file is present and fresh
 *   - null ONLY when the file exists but lastComputedDate is stale
 *   - 0 when the file is missing entirely (preserves M250 behavior: missing = 0)
 *
 * This is a WEAK FALLBACK for the legacy weeklyMessageCap path. When the
 * primary transcript/ledger-based fields are configured, this is never called.
 */
function tryStatsCacheFallback(windowMs: number): number | null {
  try {
    const cachePath = path.join(os.homedir(), '.claude', 'stats-cache.json');
    let raw: string;
    try {
      raw = fs.readFileSync(cachePath, 'utf8');
    } catch {
      return 0; // file missing → treat as 0 used (M250 original behavior)
    }
    const data = JSON.parse(raw) as unknown;
    if (typeof data !== 'object' || data === null) return 0;
    const d = data as Record<string, unknown>;

    // Staleness guard: lastComputedDate must be within the window.
    const lastComputed = d['lastComputedDate'];
    if (typeof lastComputed === 'string') {
      const lastMs = new Date(lastComputed).getTime();
      if (isNaN(lastMs) || Date.now() - lastMs > windowMs) {
        return null; // stale — signal ambiguity to caller
      }
    }

    const activity = d['dailyActivity'];
    if (!Array.isArray(activity)) return 0;

    const sinceMs = Date.now() - windowMs;
    let total = 0;
    for (const entry of activity) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const dateStr = e['date'];
      if (typeof dateStr === 'string') {
        const ts = new Date(dateStr).getTime();
        if (isNaN(ts) || ts < sinceMs) continue;
      }
      const count = e['messageCount'];
      if (typeof count === 'number') total += count;
    }
    return total;
  } catch {
    return 0; // parse error → treat as 0 (safe fallback)
  }
}

function usedPctFromClaudeRateLimitEvent(event: ClaudeRateLimitEvent): number {
  if (event.utilization >= 1) return 100;
  return Math.max(0, Math.min(99, Math.floor(event.utilization * 100)));
}

function capWindowFromClaudeRateLimitType(rateLimitType: string): string {
  switch (rateLimitType) {
    case 'five_hour': return '5h';
    case 'seven_day': return '7d';
    default: return rateLimitType;
  }
}

function claudeRateLimitWindowPriority(rateLimitType: string): number {
  switch (rateLimitType) {
    case 'seven_day': return 2;
    case 'five_hour': return 1;
    default: return 0;
  }
}

interface ClaudeRateLimitClassification {
  availability: BackendAvailability;
  stateLabel: string;
  usedPct: number;
  severity: number;
}

function classifyClaudeRateLimitEvent(
  event: ClaudeRateLimitEvent,
  protectPct: number,
): ClaudeRateLimitClassification | null {
  const usedPct = usedPctFromClaudeRateLimitEvent(event);
  if (event.utilization < 1 && usedPct < 75) return null;

  if (event.utilization >= 1) {
    return {
      availability: 'exhausted',
      stateLabel: 'exhausted',
      usedPct,
      severity: 3,
    };
  }
  if (usedPct >= protectPct) {
    return {
      availability: 'throttled',
      stateLabel: `at protectPct=${protectPct}%`,
      usedPct,
      severity: 2,
    };
  }
  return {
    availability: 'near',
    stateLabel: 'nearing limit',
    usedPct,
    severity: 1,
  };
}

function claudeStateFromRateLimitEvent(rcfg: ResourceCfgShape, nowIso: string): BackendResourceState | null {
  const protectPct = rcfg.protectPct ?? 85;
  const candidates = [
    readLatestClaudeRateLimitEvent({ rateLimitType: 'seven_day' }),
    readLatestClaudeRateLimitEvent({ rateLimitType: 'five_hour' }),
  ].flatMap((event) => {
    if (!event) return [];
    const classification = classifyClaudeRateLimitEvent(event, protectPct);
    return classification ? [{ event, classification }] : [];
  });
  candidates.sort((a, b) =>
    b.classification.severity - a.classification.severity ||
    b.classification.usedPct - a.classification.usedPct ||
    claudeRateLimitWindowPriority(b.event.rateLimitType) - claudeRateLimitWindowPriority(a.event.rateLimitType)
  );
  const selected = candidates[0];
  if (!selected) return null;

  const { event, classification } = selected;
  const {
    availability,
    stateLabel,
    usedPct,
  } = classification;

  if (availability === 'open') {
    return null;
  }

  const resetIso = new Date(event.resetsAt * 1000).toISOString();
  const capWindow = capWindowFromClaudeRateLimitType(event.rateLimitType);

  return {
    backend: 'claude',
    availability,
    usedPct,
    cap: 100,
    capUnit: null,
    capWindow,
    resetsAt: event.resetsAt,
    costPerMTokenOut: 0,
    p50LatencyMs: null,
    snapshotAt: nowIso,
    reason: `claude ${event.rateLimitType} CLI rate_limit_event ${stateLabel}: ${usedPct}% used; status=${event.status}; resetsAt=${resetIso}; source=claude-cli-rate_limit_event`,
    backoffUntilMs: availability === 'exhausted' ? event.resetsAt * 1000 : null,
  };
}

async function senseClaudeState(rcfg: ResourceCfgShape): Promise<BackendResourceState> {
  const now = new Date().toISOString();
  const backoff = backoffStore.get('claude');

  // Check backoff first (429 from claude = immediate throttle)
  if (backoff && backoff.until > Date.now()) {
    return {
      backend: 'claude',
      availability: 'exhausted',
      usedPct: null,
      cap: null,
      capUnit: null,
      capWindow: null,
      resetsAt: Math.floor(backoff.until / 1000),
      costPerMTokenOut: 0,
      p50LatencyMs: null,
      snapshotAt: now,
      reason: `backoff: ${backoff.reason}`,
      backoffUntilMs: backoff.until,
    };
  }

  const protectPct = rcfg.protectPct ?? 85;
  const windowLabel = rcfg.claude?.window ?? '7d';
  const windowMs = 7 * 24 * 60 * 60 * 1000; // always 7d for now

  const cliRateLimitState = claudeStateFromRateLimitEvent(rcfg, now);
  if (cliRateLimitState) return cliRateLimitState;

  // -------------------------------------------------------------------------
  // M254 OAUTH USAGE API PATH (authoritative when no fresh CLI event exists).
  //
  // Fetches five_hour + seven_day utilization from the internal Claude Code
  // OAuth endpoint. 60-second cache; never-throws; returns null on any error
  // or when CLAUDE_CODE_OAUTH_TOKEN / CLAUDE_BRIDGE_OAUTH_TOKEN are absent.
  //
  // When available: availability is classified using max(fiveHourPct, weeklyPct)
  // vs protectPct thresholds. The reason string cites both windows. This is the
  // most authoritative signal — reflects Mason's actual subscription headroom,
  // not just the fleet's transcript files.
  //
  // When null: falls through to the M253 transcript method (fully intact).
  // -------------------------------------------------------------------------
  try {
    const apiUsage = await fetchClaudeUsageApi();
    if (apiUsage !== null) {
      const combinedPct = Math.max(apiUsage.fiveHourPct, apiUsage.weeklyPct);
      const clampedPct  = Math.max(0, Math.min(combinedPct, 200));

      let availability: BackendAvailability;
      let reason: string;

      const sourceNote = `(5h: ${apiUsage.fiveHourPct}%, weekly: ${apiUsage.weeklyPct}%; source=oauth-usage-api)`;

      if (clampedPct >= 100) {
        availability = 'exhausted';
        reason = `claude limit reached: ${clampedPct}% ${sourceNote}`;
      } else if (clampedPct >= protectPct) {
        availability = 'throttled';
        reason = `claude at ${clampedPct}% (protectPct=${protectPct}%) — preserving headroom ${sourceNote}`;
      } else if (clampedPct >= 75) {
        availability = 'near';
        reason = `claude at ${clampedPct}% — nearing limit ${sourceNote}`;
      } else {
        availability = 'open';
        reason = `claude at ${clampedPct}% — within limit ${sourceNote}`;
      }

      // resetsAt: use the higher (further out) of the two reset times, so we
      // don't prematurely claim the window has reset.
      const resetsAt = Math.max(apiUsage.fiveHourResetAt, apiUsage.weeklyResetAt);

      return {
        backend: 'claude',
        availability,
        usedPct: clampedPct,
        cap: 100,
        capUnit: null,    // utilization is already a percentage — no raw cap unit
        capWindow: '7d',  // primary display: weekly (most conservative window)
        resetsAt,
        costPerMTokenOut: 0,
        p50LatencyMs: null,
        snapshotAt: now,
        reason,
        backoffUntilMs: null,
      };
    }
    // apiUsage === null → fall through to transcript/ledger path (source='transcript-fallback')
  } catch {
    // Belt-and-suspenders: fetchClaudeUsageApi() never throws, but guard anyway
  }

  // -------------------------------------------------------------------------
  // M253 TRANSCRIPT PATH (ccusage): real subscription usage from JSONL files.
  //
  // This is the PRIMARY path for sensing actual Claude subscription headroom.
  // It walks ~/.claude/projects/**/*.jsonl and sums message.usage token counts
  // over a 5-hour rolling window (the subscription rate-limit window) and a
  // 7-day window. No config required — defaults to Pro limits (~900 msgs/5h).
  //
  // Activated when: NOT in fleet-ledger mode (no weeklyTokenBudget/costBudget
  // configured) AND there is no explicit opt-out (weeklyTokenBudget=0 is
  // treated as "fleet-ledger mode with zero budget", not opt-out; to opt out
  // set claudeResource.transcriptSensing: false — not yet implemented, TBD).
  //
  // The 5h window is the primary availability signal (matches the subscription
  // rate-limit window). 7d is reported but not used for threshold decisions.
  // -------------------------------------------------------------------------
  const weeklyTokenBudget = rcfg.claude?.weeklyTokenBudget ?? null;
  const weeklyCostBudgetUsd = rcfg.claude?.weeklyCostBudgetUsd ?? null;

  // Only use transcript sensing when:
  //   (a) fleet-ledger mode is NOT configured (no weeklyTokenBudget/costBudget), AND
  //   (b) legacy stats-cache path is NOT configured (no weeklyMessageCap alone).
  //
  // Backward-compat rule: if only weeklyMessageCap is set (the M250 legacy config),
  // defer to the stats-cache path below so existing tests/configs are unaffected.
  // Transcript sensing activates when either fiveHourMessageCap or fiveHourTokenCap
  // is explicitly set, OR when no cap at all is configured (zero-config default).
  const hasLegacyMessageCapOnly =
    (rcfg.claude?.weeklyMessageCap ?? null) !== null &&
    (rcfg.claude?.fiveHourMessageCap ?? null) === null &&
    (rcfg.claude?.fiveHourTokenCap ?? null) === null;

  const useTranscriptSensing =
    weeklyTokenBudget === null &&
    weeklyCostBudgetUsd === null &&
    !hasLegacyMessageCapOnly;

  if (useTranscriptSensing) {
    try {
      const usage = readClaudeUsage();

      // Determine the cap: prefer explicit config, else default to Pro limits.
      // fiveHourTokenCap overrides message-count sensing when set.
      const fiveHourTokenCap = rcfg.claude?.fiveHourTokenCap ?? null;
      const fiveHourMessageCap = rcfg.claude?.fiveHourMessageCap ?? DEFAULT_5H_MESSAGE_CAP_PRO;

      let usedPct: number;
      let capVal: number;
      let capUnit: BackendResourceState['capUnit'];
      let usedLabel: string;
      let capLabel: string;

      if (fiveHourTokenCap !== null) {
        // Token-based 5h sensing
        usedPct = Math.round((usage.tokens5h / fiveHourTokenCap) * 100);
        capVal = fiveHourTokenCap;
        capUnit = 'tokens';
        usedLabel = `${usage.tokens5h.toLocaleString()} tokens`;
        capLabel = `${fiveHourTokenCap.toLocaleString()} tokens`;
      } else {
        // Message-count-based 5h sensing (default — matches subscription metric)
        usedPct = Math.round((usage.messages5h / fiveHourMessageCap) * 100);
        capVal = fiveHourMessageCap;
        capUnit = 'messages';
        usedLabel = `${usage.messages5h} messages`;
        capLabel = `${fiveHourMessageCap} messages`;
      }

      usedPct = Math.max(0, Math.min(usedPct, 200)); // clamp to sensible range

      const source5h = `(5h: ${usedLabel}/${capLabel}; 7d: ${usage.messages7d} msgs; ${usage.filesScanned} session files scanned)`;

      let availability: BackendAvailability;
      let reason: string;

      if (usedPct >= 100) {
        availability = 'exhausted';
        reason = `claude 5h limit reached: ${usedPct}% ${source5h}`;
      } else if (usedPct >= protectPct) {
        availability = 'throttled';
        reason = `claude at ${usedPct}% of 5h cap (protectPct=${protectPct}%) — preserving headroom ${source5h}`;
      } else if (usedPct >= 75) {
        availability = 'near';
        reason = `claude at ${usedPct}% of 5h cap — nearing limit ${source5h}`;
      } else {
        availability = 'open';
        reason = `claude at ${usedPct}% of 5h cap — within limit ${source5h}`;
      }

      return {
        backend: 'claude',
        availability,
        usedPct,
        cap: capVal,
        capUnit,
        capWindow: '5h',
        resetsAt: null, // rolling window — no fixed reset time
        costPerMTokenOut: 0,
        p50LatencyMs: null,
        snapshotAt: now,
        reason,
        backoffUntilMs: null,
      };
    } catch {
      // Transcript sensing failed — fall through to legacy paths
    }
  }

  if (weeklyTokenBudget !== null || weeklyCostBudgetUsd !== null) {
    const spend = sumFleetClaudeSpend(windowMs);

    let usedPct: number;
    let usedLabel: string;
    let capLabel: string;
    let capVal: number;
    let capUnit: BackendResourceState['capUnit'];

    if (weeklyTokenBudget !== null) {
      usedPct = Math.round((spend.tokens / weeklyTokenBudget) * 100);
      usedLabel = `${spend.tokens.toLocaleString()} tokens`;
      capLabel = `${weeklyTokenBudget.toLocaleString()} tokens`;
      capVal = weeklyTokenBudget;
      capUnit = 'tokens';
    } else {
      // cost-based
      usedPct = Math.round((spend.costUsd / weeklyCostBudgetUsd!) * 100);
      usedLabel = `$${spend.costUsd.toFixed(4)}`;
      capLabel = `$${weeklyCostBudgetUsd!.toFixed(2)}`;
      capVal = weeklyCostBudgetUsd!;
      capUnit = 'tokens'; // closest available unit type
    }

    // Clamp to 0 (ledger entries may have no M246 fields yet → 0% is honest)
    usedPct = Math.max(0, usedPct);

    let availability: BackendAvailability;
    let reason: string;
    const honestSuffix = `(fleet ${windowLabel} claude spend vs budget — does NOT include interactive usage)`;

    if (usedPct >= 100) {
      availability = 'exhausted';
      reason = `fleet claude budget exhausted: ${usedLabel}/${capLabel} ${windowLabel} ${honestSuffix}`;
    } else if (usedPct >= protectPct) {
      availability = 'throttled';
      reason = `fleet claude at ${usedPct}% of ${windowLabel} budget (protectPct=${protectPct}%) — preserving headroom ${honestSuffix}`;
    } else if (usedPct >= 75) {
      availability = 'near';
      reason = `fleet claude at ${usedPct}% of ${windowLabel} budget — nearing limit ${honestSuffix}`;
    } else {
      availability = 'open';
      reason = `fleet claude at ${usedPct}% of ${windowLabel} budget — within limit ${honestSuffix}`;
    }

    return {
      backend: 'claude',
      availability,
      usedPct,
      cap: capVal,
      capUnit,
      capWindow: windowLabel,
      resetsAt: null,
      costPerMTokenOut: 0,
      p50LatencyMs: null,
      snapshotAt: now,
      reason,
      backoffUntilMs: null,
    };
  }

  // -------------------------------------------------------------------------
  // M250 LEGACY FALLBACK: weeklyMessageCap + stats-cache.json
  // Only used when stats-cache is fresh (not stale) AND weeklyMessageCap is set.
  // -------------------------------------------------------------------------
  const weeklyMessageCap = rcfg.claude?.weeklyMessageCap ?? null;

  if (weeklyMessageCap !== null) {
    const used = tryStatsCacheFallback(windowMs);
    if (used === null) {
      // Stats-cache file present but stale — data is unreliable
      return {
        backend: 'claude',
        availability: 'unknown',
        usedPct: null,
        cap: weeklyMessageCap,
        capUnit: 'messages',
        capWindow: windowLabel,
        resetsAt: null,
        costPerMTokenOut: 0,
        p50LatencyMs: null,
        snapshotAt: now,
        reason: `claude: stats-cache.json is stale — cannot trust message count; treating as open. Migrate to claudeResource.fiveHourMessageCap for reliable transcript-based sensing.`,
        backoffUntilMs: null,
      };
    }
    // used === 0 when file is missing (M250 original: missing → 0 used → open)

    const usedPct = Math.round((used / weeklyMessageCap) * 100);
    let availability: BackendAvailability;
    let reason: string;

    if (usedPct >= 100) {
      availability = 'exhausted';
      reason = `claude weekly message cap reached: ${used}/${weeklyMessageCap} messages (7d) [stats-cache fallback — includes interactive usage]`;
    } else if (usedPct >= protectPct) {
      availability = 'throttled';
      reason = `claude at ${usedPct}% of weekly cap (protectPct=${protectPct}%) — preserving headroom [stats-cache fallback]`;
    } else if (usedPct >= 75) {
      availability = 'near';
      reason = `claude at ${usedPct}% of weekly cap (7d) — nearing limit [stats-cache fallback]`;
    } else {
      availability = 'open';
      reason = `claude at ${usedPct}% of weekly cap (7d) — within limit [stats-cache fallback]`;
    }

    return {
      backend: 'claude',
      availability,
      usedPct,
      cap: weeklyMessageCap,
      capUnit: 'messages',
      capWindow: windowLabel,
      resetsAt: null,
      costPerMTokenOut: 0,
      p50LatencyMs: null,
      snapshotAt: now,
      reason,
      backoffUntilMs: null,
    };
  }

  // -------------------------------------------------------------------------
  // No budget configured at all — cannot sense
  // -------------------------------------------------------------------------
  return {
    backend: 'claude',
    availability: 'unknown',
    usedPct: null,
    cap: null,
    capUnit: null,
    capWindow: null,
    resetsAt: null,
    costPerMTokenOut: 0,
    p50LatencyMs: null,
    snapshotAt: now,
    reason: 'no claude budget configured (set claudeResource.weeklyTokenBudget or weeklyCostBudgetUsd) — treating as open',
    backoffUntilMs: null,
  };
}

function senseCodexState(): BackendResourceState {
  const now = new Date().toISOString();
  const backoff = backoffStore.get('codex');

  if (backoff && backoff.until > Date.now()) {
    return {
      backend: 'codex',
      availability: 'exhausted',
      usedPct: null,
      cap: null,
      capUnit: null,
      capWindow: null,
      resetsAt: Math.floor(backoff.until / 1000),
      costPerMTokenOut: 0,
      p50LatencyMs: null,
      snapshotAt: now,
      reason: `backoff: ${backoff.reason}`,
      backoffUntilMs: backoff.until,
    };
  }

  try {
    const limits = readCodexRateLimits();
    if (!limits) {
      return {
        backend: 'codex',
        availability: 'unknown',
        usedPct: null,
        cap: null,
        capUnit: null,
        capWindow: null,
        resetsAt: null,
        costPerMTokenOut: 0,
        p50LatencyMs: null,
        snapshotAt: now,
        reason: 'no codex session files found',
        backoffUntilMs: null,
      };
    }

    // Use the higher of primary/secondary (most conservative)
    let best: { usedPercent: number; windowMinutes: number; resetsAt: number } | null = null;
    for (const w of [limits.primary, limits.secondary]) {
      if (!w) continue;
      if (best === null || w.usedPercent > best.usedPercent) best = w;
    }

    if (!best) {
      return {
        backend: 'codex',
        availability: 'unknown',
        usedPct: null,
        cap: null,
        capUnit: null,
        capWindow: null,
        resetsAt: null,
        costPerMTokenOut: 0,
        p50LatencyMs: null,
        snapshotAt: now,
        reason: 'codex session found but no rate-limit data',
        backoffUntilMs: null,
      };
    }

    const usedPct = Math.round(best.usedPercent);
    const mins = best.windowMinutes;
    const capWindow = mins % (60 * 24 * 7) === 0 ? `${mins / (60 * 24 * 7)}w`
      : mins % (60 * 24) === 0 ? `${mins / (60 * 24)}d`
      : mins % 60 === 0 ? `${mins / 60}h`
      : `${mins}m`;

    let availability: BackendAvailability;
    let reason: string;

    if (usedPct >= 100) {
      availability = 'exhausted';
      reason = `codex window ${usedPct}% used (${capWindow}) — exhausted`;
    } else if (usedPct >= 90) {
      availability = 'throttled';
      reason = `codex window ${usedPct}% used (${capWindow}) — near cap`;
    } else if (usedPct >= 75) {
      availability = 'near';
      reason = `codex window ${usedPct}% used (${capWindow}) — nearing limit`;
    } else {
      availability = 'open';
      reason = `codex window ${usedPct}% used (${capWindow}) — within limit`;
    }

    return {
      backend: 'codex',
      availability,
      usedPct,
      cap: 100, // percent-based; real hard limit not exposed
      capUnit: 'requests',
      capWindow,
      resetsAt: best.resetsAt,
      costPerMTokenOut: 0,
      p50LatencyMs: null,
      snapshotAt: now,
      reason,
      backoffUntilMs: null,
    };
  } catch {
    return {
      backend: 'codex',
      availability: 'unknown',
      usedPct: null,
      cap: null,
      capUnit: null,
      capWindow: null,
      resetsAt: null,
      costPerMTokenOut: 0,
      p50LatencyMs: null,
      snapshotAt: now,
      reason: 'codex sensing failed — treating as open',
      backoffUntilMs: null,
    };
  }
}

function senseNimState(rcfg: ResourceCfgShape): BackendResourceState {
  const now = new Date().toISOString();
  const backoff = backoffStore.get('nim');
  const costPerMTokenOut = rcfg.nim?.costPerMTokenOut ?? 0.42;

  if (backoff && backoff.until > Date.now()) {
    return {
      backend: 'nim',
      availability: backoff.until - Date.now() > 60_000 ? 'exhausted' : 'throttled',
      usedPct: null,
      cap: null,
      capUnit: null,
      capWindow: null,
      resetsAt: Math.floor(backoff.until / 1000),
      costPerMTokenOut,
      p50LatencyMs: null,
      snapshotAt: now,
      reason: `backoff: ${backoff.reason}`,
      backoffUntilMs: backoff.until,
    };
  }

  return {
    backend: 'nim',
    availability: 'open',
    usedPct: null,
    cap: null,
    capUnit: null,
    capWindow: null,
    resetsAt: null,
    costPerMTokenOut,
    p50LatencyMs: null,
    snapshotAt: now,
    reason: 'nim: no proactive signal available — treating as open',
    backoffUntilMs: null,
  };
}

/** Ping Ollama /api/ps with a 2-second timeout. Returns null on timeout/error. */
function ollamaPs(baseUrl: string): Promise<{ models: unknown[] } | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 2000);
    try {
      const url = new URL('/api/ps', baseUrl);
      const req = http.get(
        { hostname: url.hostname, port: Number(url.port) || 11434, path: url.pathname, timeout: 2000 },
        (res) => {
          clearTimeout(timer);
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(body) as unknown;
              if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as Record<string, unknown>)['models'])) {
                resolve(parsed as { models: unknown[] });
              } else {
                resolve({ models: [] });
              }
            } catch {
              resolve({ models: [] });
            }
          });
          res.on('error', () => { clearTimeout(timer); resolve(null); });
        },
      );
      req.on('error', () => { clearTimeout(timer); resolve(null); });
      req.on('timeout', () => { req.destroy(); clearTimeout(timer); resolve(null); });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

async function senseLocalState(rcfg: ResourceCfgShape): Promise<BackendResourceState> {
  const now = new Date().toISOString();
  const backoff = backoffStore.get('builtin'); // local uses 'builtin' or its own engine id
  const maxConcurrent = rcfg.local?.maxConcurrent ?? 1;
  const baseUrl = rcfg.local?.baseUrl ?? 'http://localhost:11434';

  if (backoff && backoff.until > Date.now()) {
    return {
      backend: 'builtin',
      availability: 'throttled',
      usedPct: null,
      cap: maxConcurrent,
      capUnit: 'concurrent',
      capWindow: null,
      resetsAt: Math.floor(backoff.until / 1000),
      costPerMTokenOut: 0,
      p50LatencyMs: null,
      snapshotAt: now,
      reason: `backoff: ${backoff.reason}`,
      backoffUntilMs: backoff.until,
    };
  }

  try {
    const ps = await ollamaPs(baseUrl);
    if (ps === null) {
      return {
        backend: 'builtin',
        availability: 'unreachable',
        usedPct: null,
        cap: maxConcurrent,
        capUnit: 'concurrent',
        capWindow: null,
        resetsAt: null,
        costPerMTokenOut: 0,
        p50LatencyMs: null,
        snapshotAt: now,
        reason: `ollama unreachable at ${baseUrl} — health check timed out`,
        backoffUntilMs: null,
      };
    }

    const activeCount = ps.models.length;
    const usedPct = Math.round((activeCount / maxConcurrent) * 100);

    const availability: BackendAvailability = activeCount >= maxConcurrent ? 'near' : 'open';
    const reason = activeCount >= maxConcurrent
      ? `ollama saturated: ${activeCount}/${maxConcurrent} concurrent`
      : `ollama idle: ${activeCount}/${maxConcurrent} concurrent`;

    return {
      backend: 'builtin',
      availability,
      usedPct,
      cap: maxConcurrent,
      capUnit: 'concurrent',
      capWindow: null,
      resetsAt: null,
      costPerMTokenOut: 0,
      p50LatencyMs: null,
      snapshotAt: now,
      reason,
      backoffUntilMs: null,
    };
  } catch {
    // Never block on Ollama health check failure — it's optional infrastructure
    return {
      backend: 'builtin',
      availability: 'open',
      usedPct: null,
      cap: maxConcurrent,
      capUnit: 'concurrent',
      capWindow: null,
      resetsAt: null,
      costPerMTokenOut: 0,
      p50LatencyMs: null,
      snapshotAt: now,
      reason: 'ollama health check failed — treating as open',
      backoffUntilMs: null,
    };
  }
}

function builtinState(backend: EngineId = 'builtin'): BackendResourceState {
  return {
    backend,
    availability: 'open',
    usedPct: null,
    cap: null,
    capUnit: null,
    capWindow: null,
    resetsAt: null,
    costPerMTokenOut: 0,
    p50LatencyMs: null,
    snapshotAt: new Date().toISOString(),
    reason: 'always available',
    backoffUntilMs: null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sense the resource state for a single backend.
 * Never throws.
 */
export async function getBackendResourceState(
  backend: EngineId,
  cfg: unknown,
): Promise<BackendResourceState> {
  try {
    const rcfg = extractResourceCfg(cfg);
    const override = overrideState(backend, rcfg.overrides?.[backend]);
    if (override) return override;

    switch (backend) {
      case 'claude':    return await senseClaudeState(rcfg);
      case 'codex':     return senseCodexState();
      case 'nim':       return senseNimState(rcfg);
      case 'builtin':   return await senseLocalState(rcfg);
      default:          return builtinState(backend);
    }
  } catch {
    return {
      backend,
      availability: 'unknown',
      usedPct: null,
      cap: null,
      capUnit: null,
      capWindow: null,
      resetsAt: null,
      costPerMTokenOut: 0,
      p50LatencyMs: null,
      snapshotAt: new Date().toISOString(),
      reason: 'sensing failed — treating as open',
      backoffUntilMs: null,
    };
  }
}

/**
 * Get a full resource snapshot for all configured backends.
 *
 * Cached for 30 seconds (TTL resets on recordBackoff() calls).
 * Never throws.
 *
 * M255 integration point: the concurrent dispatcher calls this before
 * building its concurrency slots map:
 *
 *   const snap = await getResourceSnapshot(cfg);
 *   const slotsPerBackend = new Map<EngineId, number>();
 *   for (const b of snap.backends) {
 *     slotsPerBackend.set(b.backend,
 *       b.availability === 'open'      ? cfg.maxConcurrent    :
 *       b.availability === 'near'      ? Math.ceil(cfg.maxConcurrent / 2) :
 *       b.availability === 'throttled' ? 0 :
 *       b.availability === 'exhausted' ? 0 :
 *       b.availability === 'unreachable' ? 0 : 0 // unknown/future = no trusted slots
 *     );
 *   }
 */
export async function getResourceSnapshot(cfg: unknown): Promise<ResourceSnapshot> {
  try {
    const now = Date.now();

    // Return cached snapshot if fresh
    if (_snapshotCache && _snapshotCache.expiresAt > now) {
      return _snapshotCache.snapshot;
    }

    // Determine which backends to sense (based on allowedBackends config)
    const backendsToSense: EngineId[] = ['claude', 'codex', 'nim', 'builtin'];
    try {
      if (typeof cfg === 'object' && cfg !== null) {
        const foundry = (cfg as Record<string, unknown>)['foundry'];
        if (typeof foundry === 'object' && foundry !== null) {
          const allowed = (foundry as Record<string, unknown>)['allowedBackends'];
          if (Array.isArray(allowed) && allowed.length > 0) {
            // Sense only configured backends + builtin (always)
            const configuredSet = new Set<EngineId>(
              (allowed as string[]).filter((b): b is EngineId =>
                ['builtin', 'claude', 'codex', 'nim', 'ashlrcode', 'aw', 'hermes', 'opencode'].includes(b)
              )
            );
            configuredSet.add('builtin');
            // Replace with configured set but keep all unique
            backendsToSense.splice(0, backendsToSense.length,
              ...(['claude', 'codex', 'nim', 'builtin'] as EngineId[]).filter(b => configuredSet.has(b))
            );
          }
        }
      }
    } catch {
      // Use default list
    }

    const states = await Promise.all(
      backendsToSense.map(b => getBackendResourceState(b, cfg))
    );

    // Deduplicate by backend id (builtin may appear multiple times)
    const seen = new Set<EngineId>();
    const backends: BackendResourceState[] = [];
    for (const s of states) {
      if (!seen.has(s.backend)) {
        seen.add(s.backend);
        backends.push(s);
      }
    }

    const snapshot: ResourceSnapshot = {
      generatedAt: new Date().toISOString(),
      backends,
    };

    _snapshotCache = { snapshot, expiresAt: now + CACHE_TTL_MS };
    return snapshot;
  } catch {
    // Belt-and-suspenders: return a safe fallback snapshot
    return {
      generatedAt: new Date().toISOString(),
      backends: [{
        backend: 'builtin',
        availability: 'open',
        usedPct: null,
        cap: null,
        capUnit: null,
        capWindow: null,
        resetsAt: null,
        costPerMTokenOut: 0,
        p50LatencyMs: null,
        snapshotAt: new Date().toISOString(),
        reason: 'snapshot failed — safe fallback',
        backoffUntilMs: null,
      }],
    };
  }
}
