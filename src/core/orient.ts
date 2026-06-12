/**
 * M31: buildOrientation — composite session-start context for agents.
 *
 * Answers "what should I know before I start working here" in ONE read-only
 * call: genome memory hits + latest health score + persisted backlog items +
 * pending proposal count + portfolio attention (dirty/stale).
 *
 * Contract (CONTRACT-M31):
 *   - READ-ONLY: derives everything from local stores; never scans repos,
 *     never builds an index, never calls a model or the network.
 *   - Every section is BEST-EFFORT: a failing store yields an empty section,
 *     never an exception. buildOrientation NEVER throws.
 *   - Bounded: hits/items are capped so the result stays context-friendly.
 *
 * Consumed by: `ashlr orient` (CLI), the `ashlr_orient` native MCP tool, and
 * the read-only `GET /api/orient` web route.
 */

import { resolve, basename } from 'node:path';
import type { AshlrConfig, OrientResult } from './types.js';
import { recall } from './genome/recall.js';
import { loadPreviousReport } from './quality/store.js';
import { loadBacklog } from './portfolio/backlog.js';
import { pendingCount } from './inbox/store.js';
import { loadIndex } from './index-engine.js';

/** Bounds keeping an orientation small enough to inject into a session. */
const MAX_GENOME_HITS = 5;
const MAX_BACKLOG_ITEMS = 8;
const MAX_HIT_TEXT = 400;
const WORST_DIMENSIONS = 3;

/**
 * Build the orientation. `repo` may be absolute or relative (resolved against
 * cwd); when omitted the orientation is portfolio-wide.
 */
export async function buildOrientation(
  cfg: AshlrConfig,
  repo?: string,
): Promise<OrientResult> {
  const abs = repo && repo.trim() !== '' ? resolve(repo) : null;

  // ── Genome memory (best-effort) ───────────────────────────────────────────
  let genomeHits: OrientResult['genomeHits'] = [];
  try {
    const query = abs ? basename(abs) : 'project conventions decisions overview';
    const hits = await recall(query, cfg, { limit: MAX_GENOME_HITS });
    genomeHits = hits.map((h) => ({
      title: h.entry.title,
      text: h.entry.text.slice(0, MAX_HIT_TEXT),
      score: h.score,
      project: h.entry.project,
    }));
  } catch {
    genomeHits = [];
  }

  // ── Health (best-effort; persisted report only — never re-scans) ─────────
  let health: OrientResult['health'] = null;
  try {
    const report = loadPreviousReport();
    if (report) {
      const score = abs
        ? report.scores.find((s) => resolve(s.repo) === abs) ?? null
        : null;
      if (score) {
        const worst = [...score.dimensions]
          .sort((a, b) => a.score - b.score)
          .slice(0, WORST_DIMENSIONS)
          .map((d) => `${d.dimension} (${d.score})`);
        health = { score: score.score, grade: score.grade, worstDimensions: worst };
      } else if (!abs) {
        health = {
          score: report.averageScore,
          grade: report.averageGrade,
          worstDimensions: report.scores
            .slice(0, WORST_DIMENSIONS)
            .map((s) => `${basename(s.repo)} (${s.score})`),
        };
      }
    }
  } catch {
    health = null;
  }

  // ── Backlog (persisted only — never triggers a scan) ──────────────────────
  let backlogItems: OrientResult['backlogItems'] = [];
  try {
    const backlog = loadBacklog();
    if (backlog) {
      const items = abs
        ? backlog.items.filter((it) => resolve(it.repo) === abs)
        : backlog.items;
      backlogItems = items.slice(0, MAX_BACKLOG_ITEMS).map((it) => ({
        id: it.id,
        source: it.source,
        title: it.title,
        score: it.score,
      }));
    }
  } catch {
    backlogItems = [];
  }

  // ── Pending proposals ──────────────────────────────────────────────────────
  let pendingProposals = 0;
  try {
    pendingProposals = pendingCount();
  } catch {
    pendingProposals = 0;
  }

  // ── Attention (index-derived; no rebuild) ─────────────────────────────────
  let attention: OrientResult['attention'] = null;
  try {
    const index = loadIndex();
    if (index) {
      let dirty = 0;
      let stale = 0;
      for (const item of index.items) {
        if (item.git && item.git.dirty > 0) dirty++;
        if (item.kind === 'repo' && !item.active) stale++;
      }
      attention = { dirtyRepos: dirty, staleRepos: stale };
    }
  } catch {
    attention = null;
  }

  return {
    generatedAt: new Date().toISOString(),
    repo: abs,
    genomeHits,
    health,
    backlogItems,
    pendingProposals,
    attention,
  };
}
