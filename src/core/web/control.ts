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
 *   ControlSnapshot.subscriptionLimits   — honest stub: cloud limits not wired yet
 *   ControlSnapshot.logs                 — most-recent-first, capped 50
 */

import type { AshlrConfig } from '../types.js';
import { buildFleetStatus, type FleetStatus } from '../fleet/status.js';
import { getProviderRegistry } from '../providers.js';
import { buildRollup, modelToProviderKey, LOCAL_PROVIDER_KEYS } from '../observability/rollup.js';
import { loadDaemonState } from '../daemon/state.js';
import { usesInWindow, evalQuota, windowToMs } from '../fleet/quota.js';

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
  connected: false;
  note: string;
}

export interface ControlLogEntry {
  ts: string;
  kind: 'tick' | 'merge' | 'info';
  msg: string;
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

const SUBSCRIPTION_NOTE =
  'Cloud subscription limits are not wired yet. ' +
  'To connect: set your provider API key (e.g. ANTHROPIC_API_KEY) in the environment. ' +
  'Future work: poll the provider billing API and surface quota/spend here.';

function buildSubscriptionLimits(): ControlSubscriptionLimits {
  return { connected: false, note: SUBSCRIPTION_NOTE };
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
  const subscriptionLimits = buildSubscriptionLimits();
  const logs = buildLogs(LOG_CAP);

  return { ts, models, fleet, daemon, usage, limits, subscriptionLimits, logs };
}
