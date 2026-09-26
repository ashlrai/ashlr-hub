/**
 * M257 → 3.14: the Director is RETIRED — the Leader is the one brain.
 *
 * Until 3.14 `runDirectorCycle` was a third strategic persona: every 15
 * minutes (when cfg.comms.director was true) it asked the strategist model —
 * Claude CLI first, outside the Leader's seat routing and budget gate — for a
 * "decision", sent its digest to Telegram and posted its escalations as
 * decision-needed requests. That duplicated the Leader (vision/leader.ts),
 * whose memo, actions, questions and veto windows now reach Mason through the
 * Leader thread (vision/leader-thread.ts) on every channel.
 *
 * What is left is inspection only:
 *   runDirectorCycle(cfg)  — a no-op whatever cfg.comms.director says (kept so
 *                            the daemon's call site and older configs stay
 *                            harmless; it spends nothing and sends nothing);
 *   runDirectorDryRun(cfg) — the read-only god-view snapshot
 *                            (director-context.ts), no model call, with a
 *                            pointer to the Leader thread.
 *
 * Never throws.
 */

import type { AshlrConfig } from '../types.js';
import { buildDirectorContext, type DirectorContext } from './director-context.js';

export interface DirectorCycleOptions {
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Dry-run formatter (CLI --dry-run path)
// ---------------------------------------------------------------------------

/** The god-view snapshot as text. Never sends anything. Never throws. */
export function formatDryRun(ctx: DirectorContext): string {
  const lines: string[] = [];

  lines.push('=== FLEET GOD-VIEW (read-only) ===');
  lines.push(`Generated: ${new Date().toUTCString()}`);
  lines.push('');

  lines.push('--- GOD-VIEW SNAPSHOT ---');
  lines.push(`Resource posture: ${ctx.resourcePosture.toUpperCase()}`);
  for (const b of ctx.resources.backends) {
    const pct = b.usedPct !== null ? ` ${b.usedPct}%` : '';
    lines.push(`  ${b.backend}: ${b.availability}${pct}`);
  }
  lines.push('');

  lines.push(`Fleet: ${ctx.fleet.daemonRunning ? 'RUNNING' : 'STOPPED'}${ctx.fleet.killed ? ' [KILLED]' : ''}`);
  lines.push(`Today spent: $${ctx.fleet.todaySpentUsd.toFixed(4)}`);
  lines.push(`Proposals: ${ctx.fleet.pendingProposals} pending, ${ctx.fleet.recentMerges} recent merges`);
  lines.push(`Backlog: ${ctx.fleet.backlogItems} items`);
  lines.push('');

  lines.push(
    `Outcomes (24h): ${ctx.outcomes.mergedCount} merged, ${ctx.outcomes.rejectedCount} rejected, $${ctx.outcomes.costUsdToday.toFixed(4)} spent`,
  );
  lines.push(`Cache hit: ${Math.round(ctx.outcomes.cacheHitRate * 100)}%`);
  lines.push('');

  if (ctx.goals.active.length > 0) {
    lines.push(`Active goals (${ctx.goals.active.length}):`);
    for (const g of ctx.goals.active.slice(0, 4)) {
      const pct = Math.round(g.fractionDone * 100);
      lines.push(`  [${g.id}] ${g.objective.slice(0, 60)} — ${pct}% (${g.milestonesDone}/${g.milestonesTotal})`);
    }
    lines.push('');
  }

  if (ctx.learning.lessonsCount > 0) {
    lines.push(`Learning (7d): ${ctx.learning.lessonsCount} lessons, ${ctx.learning.skillCount} skills`);
    lines.push('');
  }

  lines.push('--- STRATEGY ---');
  lines.push('The Director is retired: the Leader is the one strategic brain.');
  lines.push('Read its latest memo with `ashlr leader show`, talk to it with `ashlr leader say "…"`.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retired (3.14): a no-op. No model call, no Telegram message, no request —
 * whatever cfg.comms.director says. The Leader tick and the Leader thread
 * carry strategy and escalations now.
 */
export async function runDirectorCycle(
  _cfg: AshlrConfig,
  _opts: DirectorCycleOptions = {},
): Promise<void> {
  return;
}

/** The read-only god-view snapshot (no model call). Never throws. */
export async function runDirectorDryRun(cfg: AshlrConfig): Promise<string> {
  try {
    return formatDryRun(await buildDirectorContext(cfg));
  } catch {
    return '[director dry-run failed]';
  }
}
