/**
 * M257: Elon Director — context assembly.
 *
 * buildDirectorContext(cfg) — assemble a single DirectorContext snapshot from
 * all god-view sources before each director reasoning pass.
 *
 * Each source is read in its own try/catch — any single failure degrades only
 * its slice. The function NEVER throws; it always returns a DirectorContext
 * (potentially with empty/fallback fields).
 *
 * SAFETY: READ-ONLY. This module writes nothing, calls no LLM, triggers no
 * actions. It only reads from existing sources (resource-monitor, fleet/status,
 * decisions-ledger, goals/store, NORTH-STAR.md, genome/store).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AshlrConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ResourcePosture =
  | 'full'        // all frontier backends open, use freely
  | 'preserve'    // claude near/throttled → route to codex+kimi+local
  | 'local-only'  // all frontier exhausted → builtin only
  | 'degraded';   // some backends unreachable/unknown

export interface GoalSummary {
  id: string;
  objective: string;
  status: string;
  fractionDone: number;   // 0–1
  nextMilestone: string | null;
  milestonesDone: number;
  milestonesTotal: number;
}

export interface DirectorContext {
  // Resource headroom — from resource-monitor.ts
  resources: {
    backends: Array<{
      backend: string;
      availability: string;
      usedPct: number | null;
      reason: string;
    }>;
    generatedAt: string;
  };

  // Fleet operational state — from fleet/status.ts
  fleet: {
    daemonRunning: boolean;
    lastTickAt: string | null;
    todaySpentUsd: number;
    backlogItems: number;
    pendingProposals: number;
    frontierPendingProposals: number;
    recentMerges: number;
    killed: boolean;
  };

  // Recent outcomes — from decisions-ledger.ts (last 24h)
  outcomes: {
    mergedCount: number;
    rejectedCount: number;
    costUsdToday: number;
    cacheHitRate: number;               // 0–1
    engineShipRates: Record<string, number>; // engine → ship%
    blockedGoals: string[];             // goalIds with all-blocked milestones
  };

  // Goal state — from goals/store.ts
  goals: {
    active: GoalSummary[];
    planning: GoalSummary[];
    blocked: GoalSummary[];
    recentlyCompleted: GoalSummary[];
  };

  // North-star grounding — from NORTH-STAR.md (static, cached)
  northStar: {
    vision: string;
    pillars: string[];
    nearTermBets: string[];
  };

  // Self-improvement signal — from genome/store (last 7d)
  learning: {
    lessonsCount: number;
    recentLessonTitles: string[];
    skillCount: number;
  };

  // Derived resource posture
  resourcePosture: ResourcePosture;
}

// ---------------------------------------------------------------------------
// NorthStar cache (process-lifetime)
// ---------------------------------------------------------------------------

let _northStarCache: DirectorContext['northStar'] | null = null;

function loadNorthStar(): DirectorContext['northStar'] {
  if (_northStarCache) return _northStarCache;

  try {
    // Walk up from __dirname-equivalent to find docs/NORTH-STAR.md
    const candidates = [
      join(homedir(), 'Desktop', 'github', 'dev-tools', 'ashlr-hub', 'docs', 'NORTH-STAR.md'),
      join(process.cwd(), 'docs', 'NORTH-STAR.md'),
    ];

    let raw = '';
    for (const p of candidates) {
      if (existsSync(p)) {
        raw = readFileSync(p, 'utf8');
        break;
      }
    }

    if (!raw) {
      return { vision: '', pillars: [], nearTermBets: [] };
    }

    // Extract vision paragraph (first paragraph after ## Vision)
    const visionMatch = raw.match(/## Vision\s*([\s\S]*?)(?=##|$)/);
    const visionRaw = visionMatch?.[1]?.trim() ?? '';
    const vision = visionRaw.slice(0, 800);

    // Extract pillar titles from ## Three pillars section
    const pillarsMatch = raw.match(/## Three pillars[\s\S]*?(?=## |$)/);
    const pillarsSection = pillarsMatch?.[0] ?? '';
    const pillars: string[] = [];
    for (const m of pillarsSection.matchAll(/^\d+\.\s+\*\*([^*]+)\*\*/gm)) {
      pillars.push(m[1].trim());
    }

    // Extract near-term bets bullet points
    const betsMatch = raw.match(/## Near-term ambitious bets[\s\S]*?(?=##|$)/);
    const betsSection = betsMatch?.[0] ?? '';
    const nearTermBets: string[] = [];
    for (const m of betsSection.matchAll(/^- (.+)$/gm)) {
      const line = m[1].trim();
      if (line.length > 0 && nearTermBets.length < 5) {
        nearTermBets.push(line.slice(0, 120));
      }
    }

    const result: DirectorContext['northStar'] = { vision, pillars, nearTermBets };
    _northStarCache = result;
    return result;
  } catch {
    return { vision: '', pillars: [], nearTermBets: [] };
  }
}

// ---------------------------------------------------------------------------
// Resource posture derivation
// ---------------------------------------------------------------------------

function deriveResourcePosture(
  backends: DirectorContext['resources']['backends'],
): ResourcePosture {
  try {
    const frontier = backends.filter((b) =>
      b.backend === 'claude' || b.backend === 'codex' || b.backend === 'nim',
    );
    const local = backends.filter((b) =>
      b.backend === 'builtin' || b.backend === 'local',
    );

    if (frontier.length === 0) {
      // No frontier configured — check local
      const localOk = local.some((b) => b.availability === 'open' || b.availability === 'near');
      return localOk ? 'local-only' : 'degraded';
    }

    const claude = backends.find((b) => b.backend === 'claude');
    const allFrontierExhausted = frontier.every(
      (b) => b.availability === 'exhausted' || b.availability === 'unreachable',
    );
    const anyUnreachable = backends.some((b) => b.availability === 'unreachable');

    if (allFrontierExhausted) return 'local-only';

    if (
      claude &&
      (claude.availability === 'near' ||
        claude.availability === 'throttled' ||
        claude.availability === 'exhausted')
    ) {
      return 'preserve';
    }

    if (anyUnreachable) return 'degraded';

    // All frontier open
    return 'full';
  } catch {
    return 'degraded';
  }
}

// ---------------------------------------------------------------------------
// Goal summary builder
// ---------------------------------------------------------------------------

function summarizeGoal(g: {
  id: string;
  objective: string;
  status: string;
  milestones: Array<{ status: string; title?: string }>;
}): GoalSummary {
  try {
    const live = g.milestones.filter((m) => m.status !== 'skipped');
    const done = live.filter((m) => m.status === 'done').length;
    const total = live.length;
    const fractionDone = total > 0 ? done / total : 0;

    const next = live.find((m) => m.status === 'pending' || m.status === 'in-progress');
    const nextMilestone = next
      ? ('title' in next && typeof next.title === 'string' ? next.title : null)
      : null;

    return {
      id: g.id,
      objective: g.objective,
      status: g.status,
      fractionDone,
      nextMilestone,
      milestonesDone: done,
      milestonesTotal: total,
    };
  } catch {
    return {
      id: g.id,
      objective: g.objective,
      status: g.status,
      fractionDone: 0,
      nextMilestone: null,
      milestonesDone: 0,
      milestonesTotal: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** For testing: reset the north-star cache. */
export function _resetNorthStarCache(): void {
  _northStarCache = null;
}

/**
 * Assemble the full DirectorContext snapshot.
 *
 * Each source is wrapped in try/catch — any failure degrades gracefully.
 * Never throws.
 */
export async function buildDirectorContext(cfg: AshlrConfig): Promise<DirectorContext> {
  const WINDOW_24H_MS = 24 * 60 * 60 * 1000;
  const sinceMs = Date.now() - WINDOW_24H_MS;

  // ── 1. Resource snapshot ──────────────────────────────────────────────────
  let resourcesData: DirectorContext['resources'] = {
    backends: [],
    generatedAt: new Date().toISOString(),
  };

  try {
    const { getResourceSnapshot } = await import('../fabric/resource-monitor.js');
    const snap = await getResourceSnapshot(cfg);
    resourcesData = {
      backends: snap.backends.map((b) => ({
        backend: b.backend,
        availability: b.availability,
        usedPct: b.usedPct,
        reason: b.reason,
      })),
      generatedAt: snap.generatedAt,
    };
  } catch {
    // degrade — empty backends
  }

  const resourcePosture = deriveResourcePosture(resourcesData.backends);

  // ── 2. Fleet status ───────────────────────────────────────────────────────
  let fleetData: DirectorContext['fleet'] = {
    daemonRunning: false,
    lastTickAt: null,
    todaySpentUsd: 0,
    backlogItems: 0,
    pendingProposals: 0,
    frontierPendingProposals: 0,
    recentMerges: 0,
    killed: false,
  };

  try {
    const { buildFleetStatus } = await import('../fleet/status.js');
    const fs = await buildFleetStatus(cfg);
    fleetData = {
      daemonRunning: fs.daemon.running,
      lastTickAt: fs.daemon.lastTickAt,
      todaySpentUsd: fs.daemon.todaySpentUsd,
      backlogItems: fs.queue.backlogItems,
      pendingProposals: fs.proposals.pending,
      frontierPendingProposals: fs.proposals.frontierPending,
      recentMerges: fs.merges.recent,
      killed: fs.killed,
    };
  } catch {
    // degrade — leave zeros
  }

  // ── 3. Decisions outcomes (last 24h) ──────────────────────────────────────
  let outcomesData: DirectorContext['outcomes'] = {
    mergedCount: 0,
    rejectedCount: 0,
    costUsdToday: 0,
    cacheHitRate: 0,
    engineShipRates: {},
    blockedGoals: [],
  };

  try {
    const { readDecisions } = await import('../fleet/decisions-ledger.js');
    const decisions = readDecisions({ sinceMs });

    let merged = 0;
    let rejected = 0;
    let costUsd = 0;
    let cacheHits = 0;
    let cacheTotal = 0;
    const engineShip = new Map<string, number>();
    const engineTotal = new Map<string, number>();

    for (const d of decisions) {
      if (d.action === 'merged') merged++;
      if (d.action === 'rejected') rejected++;
      costUsd += d.costUsd ?? 0;
      if (d.cacheHit !== undefined) {
        cacheTotal++;
        if (d.cacheHit) cacheHits++;
      }
      if (d.engine) {
        const eng = d.engine;
        engineTotal.set(eng, (engineTotal.get(eng) ?? 0) + 1);
        if (d.action === 'merged' || (d.action === 'judged' && d.verdict === 'ship')) {
          engineShip.set(eng, (engineShip.get(eng) ?? 0) + 1);
        }
      }
    }

    const engineShipRates: Record<string, number> = {};
    for (const [eng, total] of engineTotal.entries()) {
      const shipped = engineShip.get(eng) ?? 0;
      engineShipRates[eng] = total > 0 ? Math.round((shipped / total) * 100) : 0;
    }

    outcomesData = {
      mergedCount: merged,
      rejectedCount: rejected,
      costUsdToday: costUsd,
      cacheHitRate: cacheTotal > 0 ? cacheHits / cacheTotal : 0,
      engineShipRates,
      blockedGoals: [],
    };
  } catch {
    // degrade — leave zeros
  }

  // ── 4. Goal state ─────────────────────────────────────────────────────────
  let goalsData: DirectorContext['goals'] = {
    active: [],
    planning: [],
    blocked: [],
    recentlyCompleted: [],
  };

  try {
    const { listGoals } = await import('../goals/store.js');
    const allActive = (listGoals as (f?: unknown) => Array<{
      id: string;
      objective: string;
      status: string;
      milestones: Array<{ status: string; title?: string }>;
      updatedAt: string;
    }>)({ status: 'active' });
    const allPlanning = (listGoals as (f?: unknown) => Array<{
      id: string;
      objective: string;
      status: string;
      milestones: Array<{ status: string; title?: string }>;
      updatedAt: string;
    }>)({ status: 'planning' });
    const allDone = (listGoals as (f?: unknown) => Array<{
      id: string;
      objective: string;
      status: string;
      milestones: Array<{ status: string; title?: string }>;
      updatedAt: string;
    }>)({ status: 'done' });

    // Blocked = active goals where ALL non-skipped milestones are blocked/paused
    const blockedGoals: GoalSummary[] = [];
    const trulyActive: GoalSummary[] = [];
    const blockedGoalIds: string[] = [];

    for (const g of allActive) {
      const live = g.milestones.filter((m) => m.status !== 'skipped');
      const isAllBlocked =
        live.length > 0 &&
        live.every((m) => m.status === 'blocked' || m.status === 'paused');
      if (isAllBlocked) {
        blockedGoals.push(summarizeGoal(g));
        blockedGoalIds.push(g.id);
      } else {
        trulyActive.push(summarizeGoal(g));
      }
    }

    // Recently completed = done in last 48h
    const since48h = Date.now() - 48 * 60 * 60 * 1000;
    const recentlyCompleted = allDone
      .filter((g) => {
        const ms = Date.parse(g.updatedAt);
        return !isNaN(ms) && ms >= since48h;
      })
      .map(summarizeGoal)
      .slice(0, 5);

    outcomesData.blockedGoals = blockedGoalIds;

    goalsData = {
      active: trulyActive.slice(0, 8),
      planning: allPlanning.map(summarizeGoal).slice(0, 5),
      blocked: blockedGoals.slice(0, 5),
      recentlyCompleted,
    };
  } catch {
    // degrade — leave empty
  }

  // ── 5. North-star ─────────────────────────────────────────────────────────
  const northStar = loadNorthStar();

  // ── 6. Genome learning signal ─────────────────────────────────────────────
  let learningData: DirectorContext['learning'] = {
    lessonsCount: 0,
    recentLessonTitles: [],
    skillCount: 0,
  };

  try {
    const { hubStorePath } = await import('../genome/store.js');
    const hubPath = hubStorePath();
    if (existsSync(hubPath)) {
      const raw = readFileSync(hubPath, 'utf8');
      let antiPlaybookCount = 0;
      let skillCount = 0;
      const recentTitles: string[] = [];
      const since7d = Date.now() - 7 * 24 * 60 * 60 * 1000;

      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const entry = JSON.parse(t) as {
            tags?: string[];
            ts?: string;
            title?: string;
          };
          if (!Array.isArray(entry.tags)) continue;
          const isAnti = entry.tags.includes('m235:anti-playbook');
          const isSkill = entry.tags.includes('m243:skill');
          const ts = entry.ts ? Date.parse(entry.ts) : 0;
          const inWindow = ts >= since7d;
          if (isAnti && inWindow) {
            antiPlaybookCount++;
            if (entry.title && recentTitles.length < 3) {
              recentTitles.push(entry.title.slice(0, 80));
            }
          }
          if (isSkill && inWindow) skillCount++;
        } catch {
          // malformed line — skip
        }
      }

      learningData = {
        lessonsCount: antiPlaybookCount,
        recentLessonTitles: recentTitles,
        skillCount,
      };
    }
  } catch {
    // degrade — leave zeros
  }

  return {
    resources: resourcesData,
    fleet: fleetData,
    outcomes: outcomesData,
    goals: goalsData,
    northStar,
    learning: learningData,
    resourcePosture,
  };
}
