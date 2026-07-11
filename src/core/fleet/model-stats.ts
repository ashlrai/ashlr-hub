/**
 * model-stats.ts — M335: the joined per-model economics view behind the
 * dashboard Models tab.
 *
 * Joins three telemetry streams onto one canonical (engine, model) key:
 *  - computeModelRoi (M322): dispatches, tokens, producer + judge spend,
 *    ship-rate, latency, cost-per-merged-proposal;
 *  - judge traces (M141/M332): real-world outcomes — reverted / followed-up —
 *    attributed to the PRODUCER via the proposalId join;
 *  - best-of-N ledger (M333): per-model entered/won counts → win rate.
 *
 * PURE reads; never throws; [] on cold start.
 */

import { readDecisions } from './decisions-ledger.js';
import { readJudgeTraces } from './judge-trace.js';
import { readBestOfNRecords } from './best-of-n-ledger.js';
import { computeModelRoi, type ModelRoi } from './quality-metrics.js';
import { canonicalModelTag } from '../run/model-catalog.js';

export interface ModelStats extends ModelRoi {
  /** The joined key: `${engine}:${canonicalTag}`. */
  engineModel: string;
  /** Real-world outcomes (M332 outcome-watcher). */
  outcomes: { reverted: number; followedUp: number };
  /** Multi-model best-of-N participation (M333). */
  bestOfN: { entered: number; won: number; winRate: number };
}

function windowMs(window: '7d' | '30d' | 'all'): number | undefined {
  if (window === '7d') return 7 * 24 * 60 * 60 * 1000;
  if (window === '30d') return 30 * 24 * 60 * 60 * 1000;
  return undefined;
}

/**
 * Compute the joined per-model stats, sorted by dispatches desc. Models seen
 * ONLY in best-of-N races (never a solo 'proposed' dispatch) still appear,
 * zero-filled on the ROI side — a candidate that never wins must stay
 * visible, or the tab would hide exactly the models losing races.
 */
export function computeModelStats(window: '7d' | '30d' | 'all'): ModelStats[] {
  try {
    const wm = windowMs(window);
    const sinceMs = wm !== undefined ? Date.now() - wm : undefined;

    const roi = computeModelRoi(window);
    const out = new Map<string, ModelStats>();
    const ensure = (key: string, engine: string, model: string): ModelStats => {
      let s = out.get(key);
      if (!s) {
        const base: ModelRoi = roi[key] ?? {
          engine,
          model,
          dispatches: 0,
          judged: 0,
          shipVerdicts: 0,
          merged: 0,
          rejected: 0,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          judgeCostUsd: 0,
          avgLatencyMs: null,
          shipRate: 0,
          costPerMergedUsd: null,
        };
        s = {
          ...base,
          engineModel: key,
          outcomes: { reverted: 0, followedUp: 0 },
          bestOfN: { entered: 0, won: 0, winRate: 0 },
        };
        out.set(key, s);
      }
      return s;
    };
    for (const [key, r] of Object.entries(roi)) ensure(key, r.engine, r.model);

    // ── Outcomes: producer join (a trace carries the JUDGE's identity) ────
    try {
      const producerOf = new Map<string, string>();
      for (const e of readDecisions(sinceMs !== undefined ? { sinceMs } : undefined)) {
        if (e.action !== 'proposed' || !e.engine) continue;
        const tag = canonicalModelTag(e.engine, e.model ?? '');
        const key = tag ? `${e.engine}:${tag}` : e.engine;
        if (!producerOf.has(e.proposalId)) producerOf.set(e.proposalId, key);
      }
      for (const t of readJudgeTraces({
        outcomeOnly: true,
        ...(sinceMs !== undefined ? { sinceMs } : {}),
        requireComplete: true,
      })) {
        const key = producerOf.get(t.proposalId);
        if (!key || !out.has(key)) continue;
        if (t.outcome === 'reverted') out.get(key)!.outcomes.reverted++;
        else if (t.outcome === 'followed-up') out.get(key)!.outcomes.followedUp++;
      }
    } catch {
      /* outcomes are best-effort */
    }

    // ── Best-of-N participation ───────────────────────────────────────────
    try {
      for (const rec of readBestOfNRecords(sinceMs !== undefined ? { sinceMs } : undefined)) {
        for (const c of rec.candidates) {
          if (!c.engine) continue;
          const tag = canonicalModelTag(c.engine, c.model ?? '');
          const key = tag ? `${c.engine}:${tag}` : c.engine;
          const s = ensure(key, c.engine, tag || '(default)');
          s.bestOfN.entered++;
          if (c.won) s.bestOfN.won++;
        }
      }
      for (const s of out.values()) {
        s.bestOfN.winRate = s.bestOfN.entered > 0 ? s.bestOfN.won / s.bestOfN.entered : 0;
      }
    } catch {
      /* best-of-N stats are best-effort */
    }

    return [...out.values()].sort((a, b) => b.dispatches - a.dispatches);
  } catch {
    return [];
  }
}
