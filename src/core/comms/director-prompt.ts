/**
 * M257: the god-view context renderer.
 *
 * 3.14: the Director's model call and its persona prompt are retired (the
 * Leader is the one strategic brain — comms/director.ts). What remains
 * renders a DirectorContext as text for read-only inspection.
 *
 * SAFETY: pure text construction — no I/O, no side effects.
 */

import type { DirectorContext } from './director-context.js';

// ---------------------------------------------------------------------------
// User-turn renderer
// ---------------------------------------------------------------------------

/**
 * Render a DirectorContext into the user-turn prompt for the LLM.
 * Serializes the god-view snapshot compactly — omits null/empty fields.
 */
export function renderDirectorPrompt(ctx: DirectorContext): string {
  const parts: string[] = [];

  // ── Resource state ────────────────────────────────────────────────────────
  parts.push('=== RESOURCE SNAPSHOT ===');
  parts.push(`Posture: ${ctx.resourcePosture.toUpperCase()}`);
  for (const b of ctx.resources.backends) {
    const pct = b.usedPct !== null ? ` ${b.usedPct}%` : '';
    parts.push(`  ${b.backend}: ${b.availability}${pct} — ${b.reason.slice(0, 100)}`);
  }
  parts.push('');

  // ── Fleet status ──────────────────────────────────────────────────────────
  parts.push('=== FLEET STATUS ===');
  parts.push(`Daemon: ${ctx.fleet.daemonRunning ? 'RUNNING' : 'STOPPED'}${ctx.fleet.killed ? ' (KILLED)' : ''}`);
  parts.push(`Today spent: $${ctx.fleet.todaySpentUsd.toFixed(4)}`);
  parts.push(`Backlog: ${ctx.fleet.backlogItems} items`);
  parts.push(`Proposals: ${ctx.fleet.pendingProposals} pending (${ctx.fleet.frontierPendingProposals} frontier), ${ctx.fleet.recentMerges} recent merges`);
  if (ctx.fleet.lastTickAt) parts.push(`Last tick: ${ctx.fleet.lastTickAt}`);
  parts.push('');

  // ── 24h outcomes ─────────────────────────────────────────────────────────
  parts.push('=== 24H OUTCOMES ===');
  parts.push(`Realized merges (factual only): ${ctx.outcomes.mergedCount}, Rejected: ${ctx.outcomes.rejectedCount}`);
  parts.push(`Cost today: $${ctx.outcomes.costUsdToday.toFixed(4)}`);
  const cacheHitPct = Math.round(ctx.outcomes.cacheHitRate * 100);
  parts.push(`Cache hit rate: ${cacheHitPct}%`);
  const shipRates = Object.entries(ctx.outcomes.engineShipRates);
  if (shipRates.length > 0) {
    parts.push('Released-credit engine ship rates: ' + shipRates.map(([e, r]) => `${e}=${r}%`).join(', '));
  }
  if (ctx.outcomes.blockedGoals.length > 0) {
    parts.push(`Blocked goals: ${ctx.outcomes.blockedGoals.join(', ')}`);
  }
  parts.push('');

  // ── Goal state ────────────────────────────────────────────────────────────
  parts.push('=== GOAL STATE ===');
  if (ctx.goals.active.length > 0) {
    parts.push(`Active (${ctx.goals.active.length}):`);
    for (const g of ctx.goals.active.slice(0, 6)) {
      const pct = Math.round(g.fractionDone * 100);
      const next = g.nextMilestone ? ` → next: ${g.nextMilestone.slice(0, 60)}` : '';
      parts.push(`  [${g.id}] ${g.objective.slice(0, 70)} — ${pct}% (${g.milestonesDone}/${g.milestonesTotal})${next}`);
    }
  }
  if (ctx.goals.planning.length > 0) {
    parts.push(`Planning (${ctx.goals.planning.length}): ${ctx.goals.planning.map((g) => g.id).join(', ')}`);
  }
  if (ctx.goals.blocked.length > 0) {
    parts.push(`Blocked (${ctx.goals.blocked.length}): ${ctx.goals.blocked.map((g) => g.id).join(', ')}`);
  }
  if (ctx.goals.recentlyCompleted.length > 0) {
    parts.push(`Recently completed: ${ctx.goals.recentlyCompleted.map((g) => g.id).join(', ')}`);
  }
  parts.push('');

  // ── North-star ────────────────────────────────────────────────────────────
  parts.push('=== NORTH-STAR ===');
  if (ctx.northStar.vision) {
    parts.push(ctx.northStar.vision.slice(0, 300));
  }
  if (ctx.northStar.pillars.length > 0) {
    ctx.northStar.pillars.forEach((p, i) => parts.push(`  Pillar ${i + 1}: ${p}`));
  }
  if (ctx.northStar.nearTermBets.length > 0) {
    parts.push('Near-term bets:');
    ctx.northStar.nearTermBets.slice(0, 3).forEach((b) => parts.push(`  • ${b.slice(0, 100)}`));
  }
  parts.push('');

  // ── Learning signal ───────────────────────────────────────────────────────
  if (ctx.learning.lessonsCount > 0 || ctx.learning.skillCount > 0) {
    parts.push('=== LEARNING (7d; positive skills require authenticated release) ===');
    parts.push(`Lessons: ${ctx.learning.lessonsCount}, Skills: ${ctx.learning.skillCount}`);
    if (ctx.learning.recentLessonTitles.length > 0) {
      parts.push('Recent: ' + ctx.learning.recentLessonTitles.join('; '));
    }
    parts.push('');
  }

  parts.push('=== YOUR TASK ===');
  parts.push('Reason first-principles. Return the DirectorDecision JSON object described in the system prompt.');

  return parts.join('\n');
}
