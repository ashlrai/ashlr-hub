// M122: Fleet oversight snapshot export — buildOversightSnapshot + exportOversight.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { QualityMetrics } from '../types.js';
import type { PulseExportCfg } from './pulse-export.js';
import { computeQualityMetrics } from './quality-metrics.js';
import { listGoals } from '../goals/store.js';
import { progressOf } from '../goals/advance.js';

// ---------------------------------------------------------------------------
// OversightSnapshot — the CEO/cofounder scorecard shape.
// ---------------------------------------------------------------------------

export interface OversightSnapshot {
  /** ISO timestamp when this snapshot was built. */
  generatedAt: string;
  /** Quality metrics over the last 30 days. */
  scorecard: QualityMetrics;
  /** Latest manager-agent verdict summary, or null when no reports exist. */
  manager: {
    generatedAt: string;
    shipped: number;
    review: number;
    noise: number;
    harmful: number;
    recommendations: string[];
  } | null;
  /** Current vision spec, or null when no vision file exists. */
  vision: {
    northStar: string;
    endState: string;
    ambitionLevel: string;
    /** 0–100: average fractionDone across active goals. */
    progressPct: number;
  } | null;
  /** Goal progress summary. */
  goals: {
    /** Goals with status 'active' | 'in-progress'. */
    active: number;
    /** Goals with status 'done'. */
    done: number;
    /** 0–100: avg fractionDone across all non-done, non-archived goals. */
    progressPct: number;
  };
}

// ---------------------------------------------------------------------------
// Internal directory helpers (resolved at call time so tests can relocate HOME)
// ---------------------------------------------------------------------------

function managerDir(): string {
  return join(homedir(), '.ashlr', 'manager');
}

function visionDir(): string {
  return join(homedir(), '.ashlr', 'vision');
}

// ---------------------------------------------------------------------------
// Manager report loader
// ---------------------------------------------------------------------------

interface ManagerVerdict {
  verdict: 'ship' | 'review' | 'noise' | 'harmful';
}

interface RawManagerReport {
  generatedAt: string;
  verdicts: ManagerVerdict[];
  recommendations: string[];
}

function loadLatestManagerReport(): RawManagerReport | null {
  try {
    const dir = managerDir();
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
      .sort()
      .reverse(); // most-recent first (ISO-timestamp filenames sort lexicographically)
    if (files.length === 0) return null;
    const raw = readFileSync(join(dir, files[0]!), 'utf8');
    const parsed = JSON.parse(raw) as RawManagerReport;
    if (typeof parsed.generatedAt !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Vision spec loader
// ---------------------------------------------------------------------------

interface EndStateSpec {
  northStar: string;
  endState: string;
  priorities: string[];
  ambitionLevel: string;
}

function loadLatestVisionSpec(): EndStateSpec | null {
  try {
    const dir = visionDir();
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
      .sort()
      .reverse();
    if (files.length === 0) return null;
    const raw = readFileSync(join(dir, files[0]!), 'utf8');
    const parsed = JSON.parse(raw) as EndStateSpec;
    if (typeof parsed.northStar !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// buildOversightSnapshot — never throws.
// ---------------------------------------------------------------------------

export function buildOversightSnapshot(cfg: PulseExportCfg): OversightSnapshot {
  void cfg; // cfg reserved for future per-user scoping

  const generatedAt = new Date().toISOString();

  // ── Scorecard (quality metrics, 30-day window) ─────────────────────────────
  const scorecard = computeQualityMetrics('30d');

  // ── Goals ─────────────────────────────────────────────────────────────────
  let goalsActive = 0;
  let goalsDone = 0;
  let goalsProgressPct = 0;

  try {
    const allGoals = listGoals();
    const inProgressStatuses = new Set(['active', 'in-progress', 'planning']);
    const inProgressGoals = allGoals.filter(
      (g) => inProgressStatuses.has(g.status),
    );
    goalsActive = inProgressGoals.length;
    goalsDone = allGoals.filter((g) => g.status === 'done').length;

    if (inProgressGoals.length > 0) {
      let totalFraction = 0;
      for (const goal of inProgressGoals) {
        try {
          const prog = progressOf(goal);
          totalFraction += prog.fractionDone;
        } catch {
          // skip this goal's contribution
        }
      }
      goalsProgressPct = Math.round((totalFraction / inProgressGoals.length) * 100);
    }
  } catch {
    // degrade gracefully — goals stays zeroed
  }

  const goals = { active: goalsActive, done: goalsDone, progressPct: goalsProgressPct };

  // ── Manager ───────────────────────────────────────────────────────────────
  let manager: OversightSnapshot['manager'] = null;
  try {
    const report = loadLatestManagerReport();
    if (report) {
      const verdicts = Array.isArray(report.verdicts) ? report.verdicts : [];
      manager = {
        generatedAt: report.generatedAt,
        shipped: verdicts.filter((v) => v.verdict === 'ship').length,
        review:  verdicts.filter((v) => v.verdict === 'review').length,
        noise:   verdicts.filter((v) => v.verdict === 'noise').length,
        harmful: verdicts.filter((v) => v.verdict === 'harmful').length,
        recommendations: Array.isArray(report.recommendations) ? report.recommendations : [],
      };
    }
  } catch {
    // degrade gracefully — manager stays null
  }

  // ── Vision ────────────────────────────────────────────────────────────────
  let vision: OversightSnapshot['vision'] = null;
  try {
    const spec = loadLatestVisionSpec();
    if (spec) {
      vision = {
        northStar:    spec.northStar,
        endState:     spec.endState ?? '',
        ambitionLevel: spec.ambitionLevel ?? 'steady',
        progressPct:  goalsProgressPct, // vision progress = goals progress
      };
    }
  } catch {
    // degrade gracefully — vision stays null
  }

  return { generatedAt, scorecard, manager, vision, goals };
}

// ---------------------------------------------------------------------------
// exportOversight — POST snapshot to ashlr-pulse /api/oversight.
// Mirrors exportToPulse conventions exactly.
// ---------------------------------------------------------------------------

export async function exportOversight(cfg: PulseExportCfg): Promise<boolean> {
  try {
    if (!cfg.pulse?.enabled) return false;

    const pat = process.env['ASHLR_PULSE_PAT'];
    if (!pat) {
      console.log('[ashlr-fleet] oversight export: ASHLR_PULSE_PAT not set — skipping (set it to enable oversight→pulse)');
      return false;
    }

    const endpoint = (cfg.pulse?.endpoint ?? 'http://localhost:3000').replace(/\/$/, '');
    const url = `${endpoint}/api/oversight`;

    const snapshot = buildOversightSnapshot(cfg);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${pat}`,
      },
      body: JSON.stringify({ snapshot }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
