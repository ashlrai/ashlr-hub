/**
 * resource-monitor.ts — M250 Resource Control Plane.
 *
 * Senses per-backend resource headroom and returns a snapshot that the
 * gateway (M252) uses to demote exhausted backends before dispatch.
 *
 * DESIGN INVARIANTS:
 *  - Never throws. Every sensing path is wrapped in try/catch and degrades
 *    to availability:'unknown' which the gateway treats as permissive.
 *  - No network calls except the Ollama localhost health check (2s timeout).
 *  - Claude sensing reads ~/.claude/stats-cache.json (message count, 7d sum).
 *    This is a CONSERVATIVE OVER-ESTIMATE — counts human + fleet messages
 *    combined. Acceptable as a demotion signal; not a billing metric.
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

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface SnapshotCache {
  snapshot: ResourceSnapshot;
  expiresAt: number;
}

let _snapshotCache: SnapshotCache | null = null;
const CACHE_TTL_MS = 30_000; // 30 seconds

// ---------------------------------------------------------------------------
// Config shape (read defensively — never import from types to avoid coupling)
// ---------------------------------------------------------------------------

interface ClaudeResourceCfg {
  weeklyMessageCap?: number;
  window?: string;
}

interface ResourceCfgShape {
  claude?: ClaudeResourceCfg;
  protectPct?: number;
  nim?: { costPerMTokenOut?: number };
  local?: { maxConcurrent?: number; baseUrl?: string };
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
          weeklyMessageCap: typeof claudeResource['weeklyMessageCap'] === 'number'
            ? (claudeResource['weeklyMessageCap'] as number) : undefined,
          window: typeof claudeResource['window'] === 'string'
            ? (claudeResource['window'] as string) : undefined,
        }
      : claudeLimitsLegacy
        ? {
            weeklyMessageCap: typeof claudeLimitsLegacy['weeklyMessageCap'] === 'number'
              ? (claudeLimitsLegacy['weeklyMessageCap'] as number) : undefined,
            window: typeof claudeLimitsLegacy['window'] === 'string'
              ? (claudeLimitsLegacy['window'] as string) : undefined,
          }
        : undefined;

    // protectPct comes from claudeResource.protectPct (M251).
    const protectPct = claudeResource && typeof claudeResource['protectPct'] === 'number'
      ? (claudeResource['protectPct'] as number)
      : undefined;

    return {
      claude: claudeCfg,
      protectPct,
      nim: (f['nim'] as Record<string, unknown> | undefined) as ResourceCfgShape['nim'],
      local: (f['local'] as Record<string, unknown> | undefined) as ResourceCfgShape['local'],
    };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Per-backend sensing
// ---------------------------------------------------------------------------

/** Sum messageCount from ~/.claude/stats-cache.json over a rolling 7-day window. */
function sumClaudeMessages7d(): number {
  try {
    const cachePath = path.join(os.homedir(), '.claude', 'stats-cache.json');
    const raw = fs.readFileSync(cachePath, 'utf8');
    const data = JSON.parse(raw) as unknown;
    if (typeof data !== 'object' || data === null) return 0;
    const activity = (data as Record<string, unknown>)['dailyActivity'];
    if (!Array.isArray(activity)) return 0;

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let total = 0;

    for (const entry of activity) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      // date field is typically 'YYYY-MM-DD'
      const dateStr = e['date'];
      if (typeof dateStr === 'string') {
        const ts = new Date(dateStr).getTime();
        if (isNaN(ts) || ts < sevenDaysAgo) continue;
      }
      const count = e['messageCount'];
      if (typeof count === 'number') total += count;
    }

    return total;
  } catch {
    return 0;
  }
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

  const weeklyMessageCap = rcfg.claude?.weeklyMessageCap ?? null;
  const protectPct = rcfg.protectPct ?? 85;

  if (weeklyMessageCap === null) {
    // No cap configured — cannot sense
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
      reason: 'no weeklyMessageCap configured — cannot sense; treating as open',
      backoffUntilMs: null,
    };
  }

  const used = sumClaudeMessages7d();
  const usedPct = Math.round((used / weeklyMessageCap) * 100);

  let availability: BackendAvailability;
  let reason: string;

  if (usedPct >= 100) {
    availability = 'exhausted';
    reason = `claude weekly message cap reached: ${used}/${weeklyMessageCap} messages (7d)`;
  } else if (usedPct >= protectPct) {
    availability = 'throttled';
    reason = `claude at ${usedPct}% of weekly cap (protectPct=${protectPct}%) — preserving headroom for human sessions`;
  } else if (usedPct >= 75) {
    availability = 'near';
    reason = `claude at ${usedPct}% of weekly cap (7d) — nearing limit`;
  } else {
    availability = 'open';
    reason = `claude at ${usedPct}% of weekly cap (7d) — within limit`;
  }

  return {
    backend: 'claude',
    availability,
    usedPct,
    cap: weeklyMessageCap,
    capUnit: 'messages',
    capWindow: rcfg.claude?.window ?? '7d',
    resetsAt: null, // Claude doesn't expose reset time
    costPerMTokenOut: 0,
    p50LatencyMs: null,
    snapshotAt: now,
    reason,
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
 *       b.availability === 'exhausted' ? 0 : cfg.maxConcurrent  // unknown = permissive
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
