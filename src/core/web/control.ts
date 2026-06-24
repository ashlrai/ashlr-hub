/**
 * control.ts — M61: Mission Control aggregator.
 *
 * `buildControlSnapshot(cfg)` assembles a unified read-only snapshot for the
 * Mission Control dashboard. Each section is independently guarded — a broken
 * subsystem degrades ONLY that slice; the rest still resolves. Never throws.
 *
 * JSON contract (verbatim, frontend depends on this):
 *   ControlSnapshot.ts                   — ISO stamp
 *   ControlSnapshot.models               — live local-model provider state
 *   ControlSnapshot.fleet                — FleetStatus (reuses buildFleetStatus)
 *   ControlSnapshot.daemon               — running/pid/lastTickAt/todaySpentUsd
 *   ControlSnapshot.usage                — 7d rollup: totals + byProvider
 *   ControlSnapshot.limits               — per-backend rate-window standing ([] when none)
 *   ControlSnapshot.subscriptionLimits   — rolling-window usage + honest provider notes (M63)
 *   ControlSnapshot.logs                 — most-recent-first, capped 50
 */

import type { AshlrConfig } from '../types.js';
import { buildFleetStatus, type FleetStatus } from '../fleet/status.js';
import { getProviderRegistry } from '../providers.js';
import { buildRollup, modelToProviderKey, LOCAL_PROVIDER_KEYS } from '../observability/rollup.js';
import { loadDaemonState } from '../daemon/state.js';
import { usesInWindow, evalQuota, windowToMs } from '../fleet/quota.js';
import { resolveUsageWindows, type UsageWindow, type ProviderLimitEntry } from '../observability/limits.js';
import { loadBacklog } from '../portfolio/backlog.js';
import { readCodexRateLimits } from '../observability/codex-source.js';
import { buildFleetDigest, type FleetRepoRow } from '../fleet/digest.js';
import { loadWorkedLedger } from '../fleet/worked-ledger.js';
import { fleetReadiness, type EngineReadiness } from '../fleet/engine-readiness.js';
import { readAudit } from '../sandbox/audit.js';

// ---------------------------------------------------------------------------
// ControlSnapshot type
// ---------------------------------------------------------------------------

export interface ControlProviderEntry {
  id: string;
  kind: 'local' | 'cloud';
  up: boolean;
  baseUrl: string | null;
  models: string[];
}

export interface ControlModels {
  activeProvider: string | null;
  providers: ControlProviderEntry[];
}

export interface ControlDaemon {
  running: boolean;
  pid: number | null;
  lastTickAt: string | null;
  todaySpentUsd: number;
}

export interface ControlUsageByProvider {
  provider: string;
  tier: 'local' | 'cloud';
  tokens: number;
  costUsd: number;
  sharePct: number;
}

export interface ControlUsage {
  window: '7d';
  totalTokens: number;
  totalCostUsd: number;
  localSavingsUsd: number;
  byProvider: ControlUsageByProvider[];
}

export interface ControlLimit {
  backend: string;
  window: string;
  max: number;
  used: number;
  standing: 'ok' | 'warn' | 'over' | 'unlimited';
}

export interface ControlSubscriptionLimits {
  connected: boolean;
  note: string;
  windows: UsageWindow[];
  providers: ProviderLimitEntry[];
}

// ---------------------------------------------------------------------------
// M82: Subscription usage panel — per-engine burn-down (5h + weekly windows)
// ---------------------------------------------------------------------------

export interface SubscriptionUsageWindow {
  /** Human-readable window label: '5h', '1w', etc. */
  label: string;
  /** 0–100 usage percentage. */
  usedPercent: number;
  /** Unix epoch seconds when this window resets. Absent when unknown. */
  resetsAt?: number;
}

export interface SubscriptionEngineUsage {
  /** Engine identifier, e.g. 'codex', 'claude'. */
  engine: string;
  /** Ordered windows (primary first). Empty when no data available. */
  windows: SubscriptionUsageWindow[];
  /** Subscription plan label when readable from session data. */
  plan?: string;
  /** True when real window data is available; false = best-effort/unknown. */
  hasData: boolean;
}

export interface ControlLogEntry {
  ts: string;
  kind: 'tick' | 'merge' | 'info';
  msg: string;
}

// ---------------------------------------------------------------------------
// M67: Security section
// ---------------------------------------------------------------------------

export interface ControlSecurityFinding {
  /** Basename of the repo the finding came from. */
  repo: string;
  title: string;
  severity: string;
  /** The WorkItem source — always 'security' for binshield items. */
  source: string;
}

export interface ControlSecurityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface ControlSecurity {
  /**
   * True when at least one security WorkItem was found in the cached backlog.
   * False when the backlog is absent, empty, or has no security-source items.
   */
  available: boolean;
  findings: ControlSecurityFinding[];
  counts: ControlSecurityCounts;
}

export interface ControlSnapshot {
  ts: string;
  models: ControlModels;
  fleet: FleetStatus;
  daemon: ControlDaemon;
  usage: ControlUsage;
  limits: ControlLimit[];
  subscriptionLimits: ControlSubscriptionLimits;
  logs: ControlLogEntry[];
  /** M67: supply-chain / binshield security findings from cached backlog. */
  security: ControlSecurity;
  /** M82: per-engine subscription burn-down (5h + weekly windows). */
  subscriptionUsage: SubscriptionEngineUsage[];
}

// ---------------------------------------------------------------------------
// Section builders — each is independently guarded
// ---------------------------------------------------------------------------

/** Safe fallback for the models section. */
function fallbackModels(): ControlModels {
  return { activeProvider: null, providers: [] };
}

async function buildModels(cfg: AshlrConfig): Promise<ControlModels> {
  try {
    const registry = await getProviderRegistry(cfg);
    const LOCAL_IDS = new Set(['lmstudio', 'ollama']);
    const providers: ControlProviderEntry[] = registry.providers.map((ep) => ({
      id: ep.id,
      kind: LOCAL_IDS.has(ep.id) ? 'local' : 'cloud',
      up: ep.up,
      baseUrl: ep.url ?? null,
      models: ep.models,
    }));
    return { activeProvider: registry.activeProvider, providers };
  } catch {
    return fallbackModels();
  }
}

/** Safe fallback for the daemon section. */
function fallbackDaemon(): ControlDaemon {
  return { running: false, pid: null, lastTickAt: null, todaySpentUsd: 0 };
}

function buildDaemon(): ControlDaemon {
  try {
    const ds = loadDaemonState();
    return {
      running: ds.running === true,
      pid: typeof ds.pid === 'number' ? ds.pid : null,
      lastTickAt: ds.lastTickAt ?? null,
      todaySpentUsd: typeof ds.todaySpentUsd === 'number' ? ds.todaySpentUsd : 0,
    };
  } catch {
    return fallbackDaemon();
  }
}

/** Safe fallback for the usage section. */
function fallbackUsage(): ControlUsage {
  return {
    window: '7d',
    totalTokens: 0,
    totalCostUsd: 0,
    localSavingsUsd: 0,
    byProvider: [],
  };
}

function buildUsage(cfg: AshlrConfig): ControlUsage {
  try {
    const rollup = buildRollup('7d', cfg);

    // Aggregate byModel into byProvider buckets
    const totalCostUsd = rollup.totals.estCostUsd;
    const totalTokens = rollup.totals.tokensIn + rollup.totals.tokensOut;

    // per-provider accumulators
    const providerMap = new Map<string, { tier: 'local' | 'cloud'; tokens: number; costUsd: number }>();

    for (const mu of rollup.byModel) {
      const provKey = modelToProviderKey(mu.model);
      const tier: 'local' | 'cloud' = LOCAL_PROVIDER_KEYS.has(provKey) ? 'local' : 'cloud';
      const tokens = mu.tokensIn + mu.tokensOut;
      const existing = providerMap.get(provKey);
      if (existing) {
        existing.tokens += tokens;
        existing.costUsd += mu.estCostUsd;
      } else {
        providerMap.set(provKey, { tier, tokens, costUsd: mu.estCostUsd });
      }
    }

    const byProvider: ControlUsageByProvider[] = [];
    for (const [provider, acc] of providerMap.entries()) {
      const sharePct = totalCostUsd > 0
        ? Math.round((acc.costUsd / totalCostUsd) * 1000) / 10
        : totalTokens > 0
          ? Math.round((acc.tokens / totalTokens) * 1000) / 10
          : 0;
      byProvider.push({ provider, tier: acc.tier, tokens: acc.tokens, costUsd: acc.costUsd, sharePct });
    }
    byProvider.sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);

    // Normalise shares to sum exactly to 100 when there is usage
    if (byProvider.length > 0) {
      const rawSum = byProvider.reduce((s, p) => s + p.sharePct, 0);
      if (rawSum > 0) {
        // Proportionally rescale so sum === 100
        const scale = 100 / rawSum;
        let running = 0;
        for (let i = 0; i < byProvider.length - 1; i++) {
          byProvider[i].sharePct = Math.round(byProvider[i].sharePct * scale * 10) / 10;
          running += byProvider[i].sharePct;
        }
        // Last entry gets the remainder to guarantee exact 100 sum
        byProvider[byProvider.length - 1].sharePct =
          Math.round((100 - running) * 10) / 10;
      }
    }

    // localSavingsUsd: what the local tokens would have cost if cloud-priced.
    // We use a conservative $3/$15 estimate for what a cloud provider would charge,
    // then subtract $0 (local cost). Simple heuristic: localTokens * $3/1M in-tokens.
    let localSavingsUsd = 0;
    for (const p of byProvider) {
      if (p.tier === 'local' && p.tokens > 0) {
        // $3/1M tokens — the conservative cloud input price
        localSavingsUsd += (p.tokens / 1_000_000) * 3;
      }
    }
    localSavingsUsd = Math.round(localSavingsUsd * 10000) / 10000;

    return { window: '7d', totalTokens, totalCostUsd, localSavingsUsd, byProvider };
  } catch {
    return fallbackUsage();
  }
}

function buildLimits(cfg: AshlrConfig): ControlLimit[] {
  try {
    const rawLimits = cfg.foundry?.limits;
    if (!rawLimits) return [];
    const result: ControlLimit[] = [];
    for (const [backend, limit] of Object.entries(rawLimits)) {
      if (!limit) continue;
      const windowMs = windowToMs(limit.window);
      const used = usesInWindow(backend as never, windowMs);
      const standing = evalQuota(backend as never, cfg);
      result.push({ backend, window: limit.window, max: limit.max, used, standing });
    }
    return result;
  } catch {
    return [];
  }
}

async function buildSubscriptionLimits(cfg: AshlrConfig): Promise<ControlSubscriptionLimits> {
  try {
    const result = await resolveUsageWindows(cfg);
    return {
      connected: result.connected,
      note: result.note,
      windows: result.windows,
      providers: result.providers,
    };
  } catch {
    return {
      connected: false,
      note: 'Usage window data unavailable.',
      windows: [],
      providers: [],
    };
  }
}

const LOG_CAP = 50;

function buildLogs(cap = LOG_CAP): ControlLogEntry[] {
  try {
    const ds = loadDaemonState();
    const ticks = Array.isArray(ds.ticks) ? ds.ticks : [];
    // ticks are oldest-first in the state; reverse for most-recent-first
    const reversed = [...ticks].reverse();
    const entries: ControlLogEntry[] = [];
    for (const tick of reversed) {
      if (entries.length >= cap) break;
      // Merge event (if any merges happened this tick, emit a separate line first)
      if (typeof tick.merged === 'number' && tick.merged > 0) {
        entries.push({
          ts: tick.ts,
          kind: 'merge',
          msg: `${tick.merged} proposal(s) auto-merged`,
        });
        if (entries.length >= cap) break;
      }
      // Tick event
      const backendStr = tick.backends && Object.keys(tick.backends).length > 0
        ? ' backends=' + Object.entries(tick.backends).map(([k, v]) => `${k}:${v}`).join(',')
        : '';
      const spendStr = typeof tick.spentUsd === 'number'
        ? ` spend=$${tick.spentUsd.toFixed(4)}`
        : '';
      entries.push({
        ts: tick.ts,
        kind: 'tick',
        msg: `tick reason=${tick.reason ?? 'ok'}${backendStr}${spendStr}`,
      });
    }
    return entries;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// M67: Security builder — reads cached backlog, never re-scans live.
// ---------------------------------------------------------------------------

/** Safe fallback for the security section. */
function fallbackSecurity(): ControlSecurity {
  return {
    available: false,
    findings: [],
    counts: { critical: 0, high: 0, medium: 0, low: 0 },
  };
}

/**
 * Aggregate security WorkItems from the persisted backlog (~/.ashlr/backlog.json).
 * Reads cached data only — never shells out to binshield live so /api/control
 * stays fast. Degrades gracefully to available:false when the backlog is absent.
 * Never throws.
 */
export function buildSecurity(): ControlSecurity {
  try {
    const backlog = loadBacklog();
    if (!backlog) return fallbackSecurity();

    const secItems = backlog.items.filter((item) => item.source === 'security');
    if (secItems.length === 0) return fallbackSecurity();

    const counts: ControlSecurityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
    const findings: ControlSecurityFinding[] = [];

    for (const item of secItems) {
      // Severity is the third tag when tags = ['security', 'binshield', <sev>].
      // Fall back to scanning all tags for a known severity keyword.
      const tags = Array.isArray(item.tags) ? item.tags : [];
      const sev =
        (tags[2] as string | undefined) ??
        tags.find((t) => ['critical', 'high', 'medium', 'low'].includes(t)) ??
        'low';

      if (sev === 'critical') counts.critical++;
      else if (sev === 'high') counts.high++;
      else if (sev === 'medium') counts.medium++;
      else counts.low++;

      findings.push({
        repo: item.repo.split('/').pop() ?? item.repo,
        title: item.title,
        severity: sev,
        source: item.source,
      });
    }

    // Sort: critical first, then high, medium, low — same order as backlog display.
    const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    findings.sort((a, b) => (SEV_ORDER[a.severity] ?? 4) - (SEV_ORDER[b.severity] ?? 4));

    return { available: true, findings, counts };
  } catch {
    return fallbackSecurity();
  }
}

// ---------------------------------------------------------------------------
// M82: Subscription usage builder — codex: real 5h+weekly; claude: unknown
// ---------------------------------------------------------------------------

/** Convert raw windowMinutes to a short readable label. */
function minutesToWindowLabel(mins: number): string {
  if (mins % (60 * 24 * 7) === 0) return `${mins / (60 * 24 * 7)}w`;
  if (mins % (60 * 24) === 0)     return `${mins / (60 * 24)}d`;
  if (mins % 60 === 0)            return `${mins / 60}h`;
  return `${mins}m`;
}

/**
 * Build per-engine subscription burn-down windows.
 *
 * Codex: reads readCodexRateLimits() for real 5h (primary) + weekly
 *   (secondary) used-percent + resetsAt. Returns hasData:true.
 * Claude: no local signal — returns hasData:false with empty windows.
 *
 * Fast, read-only, never-throws. Degrades to empty array on any error.
 */
export function buildSubscriptionUsage(): SubscriptionEngineUsage[] {
  const result: SubscriptionEngineUsage[] = [];

  // ── Codex ──────────────────────────────────────────────────────────────
  try {
    const limits = readCodexRateLimits();
    if (limits) {
      const windows: SubscriptionUsageWindow[] = [];
      if (limits.primary) {
        windows.push({
          label: minutesToWindowLabel(limits.primary.windowMinutes),
          usedPercent: limits.primary.usedPercent,
          resetsAt: limits.primary.resetsAt,
        });
      }
      if (limits.secondary) {
        windows.push({
          label: minutesToWindowLabel(limits.secondary.windowMinutes),
          usedPercent: limits.secondary.usedPercent,
          resetsAt: limits.secondary.resetsAt,
        });
      }
      result.push({
        engine: 'codex',
        windows,
        plan: limits.planType,
        hasData: windows.length > 0,
      });
    }
  } catch {
    // degrade silently
  }

  // ── Claude ─────────────────────────────────────────────────────────────
  // No local signal — subscription caps are not API-exposed for Pro/Max plans.
  result.push({
    engine: 'claude',
    windows: [],
    hasData: false,
  });

  return result;
}

// ---------------------------------------------------------------------------
// M90: Fleet-Activity aggregator
// ---------------------------------------------------------------------------

/** A single recent auto-merge event surfaced in the fleet-activity feed. */
export interface FleetMergeEvent {
  repo: string | null;
  proposalId: string | null;
  ts: string;
  engine: string | null;
}

/** A recent daemon tick (last N, newest-first). */
export interface FleetTickEntry {
  ts: string;
  reason: string | null;
  backends: Record<string, number>;
  spentUsd: number;
  merged: number;
}

/** Full fleet-activity payload. */
export interface FleetActivitySnapshot {
  ts: string;
  /** Per-repo proposal/merge counts (7d window). */
  repos: FleetRepoRow[];
  totalProposed: number;
  totalAutoMerged: number;
  totalPending: number;
  totalDeclined: number;
  /** Recent auto-merge audit events (newest-first, capped 20). */
  recentMerges: FleetMergeEvent[];
  /** Per-engine readiness (throttled to ~10s). */
  engineReadiness: EngineReadiness[];
  /** Per-engine subscription burn-down (reused from buildSubscriptionUsage). */
  subscriptionUsage: SubscriptionEngineUsage[];
  /** Number of items currently in the worked-ledger cooldown window. */
  cooldownCount: number;
  /** Last N daemon ticks (newest-first, capped 20). */
  recentTicks: FleetTickEntry[];
}

// Throttle cache for fleetReadiness — 2s probes are expensive; cache for 10s.
let _readinessCache: { result: EngineReadiness[]; at: number } | null = null;
const READINESS_TTL_MS = 10_000;

function cachedFleetReadiness(cfg?: AshlrConfig): EngineReadiness[] {
  const now = Date.now();
  if (_readinessCache && now - _readinessCache.at < READINESS_TTL_MS) {
    return _readinessCache.result;
  }
  try {
    const result = fleetReadiness(cfg);
    _readinessCache = { result, at: now };
    return result;
  } catch {
    return _readinessCache?.result ?? [];
  }
}

/** Reset the readiness throttle cache (for tests). */
export function resetReadinessCache(): void {
  _readinessCache = null;
}

/**
 * Aggregate fleet-activity data from multiple sources. Each section degrades
 * independently. Never throws.
 */
export async function buildFleetActivity(cfg: AshlrConfig): Promise<FleetActivitySnapshot> {
  const ts = new Date().toISOString();

  // Per-repo digest (7d window)
  let digest = await buildFleetDigest('7d').catch(() => ({
    running: false,
    lastTickAt: null,
    todaySpentUsd: 0,
    itemsProcessed: 0,
    repos: [] as FleetRepoRow[],
    totalProposed: 0,
    totalAutoMerged: 0,
    totalPending: 0,
    totalDeclined: 0,
  }));

  // Recent auto-merge events from audit (action starts with 'merge.')
  let recentMerges: FleetMergeEvent[] = [];
  try {
    const auditEntries = readAudit(200);
    recentMerges = auditEntries
      .filter((e) => e.action.startsWith('merge.'))
      .slice(0, 20)
      .map((e) => {
        // summary format: "proposalId=<id> engine=<eng> ..."
        const propMatch = /proposalId=([^\s]+)/.exec(e.summary);
        const engMatch  = /engine=([^\s]+)/.exec(e.summary);
        return {
          repo: e.repo,
          proposalId: propMatch?.[1] ?? null,
          ts: e.ts,
          engine: engMatch?.[1] ?? null,
        };
      });
  } catch {
    // degrade silently
  }

  // Engine readiness (throttled)
  const engineReadinessResult = cachedFleetReadiness(cfg);

  // Subscription burn-down (reuse existing builder)
  const subscriptionUsage = buildSubscriptionUsage();

  // Worked-ledger cooldown count
  let cooldownCount = 0;
  try {
    const ledger = loadWorkedLedger();
    const now = Date.now();
    const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h
    cooldownCount = ledger.events.filter((e) => {
      if (e.outcome !== 'empty') return false;
      const ms = Date.parse(e.ts);
      return !Number.isNaN(ms) && now - ms < COOLDOWN_MS;
    }).length;
  } catch {
    // degrade silently
  }

  // Recent daemon ticks (newest-first, capped 20)
  let recentTicks: FleetTickEntry[] = [];
  try {
    const ds = loadDaemonState();
    const ticks = Array.isArray(ds.ticks) ? ds.ticks : [];
    recentTicks = [...ticks].reverse().slice(0, 20).map((t) => ({
      ts: t.ts,
      reason: t.reason ?? null,
      backends: t.backends ?? {},
      spentUsd: typeof t.spentUsd === 'number' ? t.spentUsd : 0,
      merged: typeof t.merged === 'number' ? t.merged : 0,
    }));
  } catch {
    // degrade silently
  }

  return {
    ts,
    repos: digest.repos,
    totalProposed: digest.totalProposed,
    totalAutoMerged: digest.totalAutoMerged,
    totalPending: digest.totalPending,
    totalDeclined: digest.totalDeclined,
    recentMerges,
    engineReadiness: engineReadinessResult,
    subscriptionUsage,
    cooldownCount,
    recentTicks,
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Assemble a full ControlSnapshot. Each section is independently guarded so a
 * broken subsystem never causes the whole snapshot to fail. Never throws.
 */
export async function buildControlSnapshot(cfg: AshlrConfig): Promise<ControlSnapshot> {
  const ts = new Date().toISOString();

  const [models, fleet] = await Promise.all([
    buildModels(cfg),
    buildFleetStatus(cfg).catch((): FleetStatus => ({
      generatedAt: ts,
      daemon: { running: false, lastTickAt: null, todaySpentUsd: 0 },
      backends: [],
      queue: { backlogItems: 0 },
      proposals: { pending: 0, frontierPending: 0, applied: 0 },
      merges: { recent: 0 },
      killed: false,
    })),
  ]);

  const daemon = buildDaemon();
  const usage = buildUsage(cfg);
  const limits = buildLimits(cfg);
  const subscriptionLimits = await buildSubscriptionLimits(cfg);
  const logs = buildLogs(LOG_CAP);
  const security = buildSecurity();
  const subscriptionUsage = buildSubscriptionUsage();

  return { ts, models, fleet, daemon, usage, limits, subscriptionLimits, logs, security, subscriptionUsage };
}
