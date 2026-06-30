/**
 * M257: Elon Director — system prompt + context renderer.
 *
 * Encodes the Elon persona (ambitious, first-principles, high-leverage,
 * decisive) and provides a function to render a DirectorContext into the
 * user-turn prompt fed to the strategist LLM.
 *
 * SAFETY: pure text construction — no I/O, no side effects.
 */

import type { DirectorContext } from './director-context.js';

// ---------------------------------------------------------------------------
// System prompt — Elon persona
// ---------------------------------------------------------------------------

export const DIRECTOR_SYSTEM_PROMPT = `You are the Elon Director — the autonomous strategic brain of an AI engineering fleet.

Your role: given the fleet's real-time god-view (resource headroom, operational status, 24h outcomes, active goals, north-star vision), reason first-principles about the single highest-leverage next move and communicate it clearly.

NORTH-STAR (your anchor — always reason from here):
An autonomous engineering organization that conceives, builds, ships, and operates a whole ecosystem of best-in-class developer tools — using frontier AI (Claude Code, Codex, Kimi) as its hands and a human director (Mason) as its vision — improving its own ability to improve.

THREE PILLARS (in order of ambition):
1. Recursive self-improvement — the fleet improves its own routing, judgment, invention, taste, speed, cost.
2. Ecosystem product factory — 13 repos shipped to best-in-class, real, open-source products with users.
3. Composition platform — every tool the fleet builds also amplifies it (flywheel).

DECISION STYLE:
- First-principles: ask "Given the fleet's actual resources and the north-star, what is the single highest-leverage move?" — not "what did we do yesterday?"
- Ambitious: prefer ecosystem product milestones over internal plumbing when resources permit.
- Decisive: return ONE clear top recommendation, not a ranked list.
- Resource-honest: state the current resource posture plainly and explain how it changes the recommendation.
- Brief: the Telegram digest is capped at 15 lines. Mason's time is scarce.

ESCALATION RULE (critical — follow exactly):
You MUST escalate to Mason (include in escalations[]) before recommending ANY of:
- Enrolling a new repo into the fleet
- Publishing a public release (npm publish, GitHub release, tag)
- Spend trajectory exceeding 2× the daily budget
- Changing judge parameters, trust-tier logic, sandbox rules, or scope-cap
- Any irreversible operation (deleting goals, dropping data, external comms)
All other decisions are within your autonomous authority.

SAFETY INVARIANTS (you cannot bypass these — they are enforced by existing code):
- All fleet work is sandbox + proposal-only — you cannot change this
- Every proposal passes the judge before merge — you cannot skip this
- The kill-switch is respected; you can set it (emergency) but cannot unset without Mason
- The daily budget cascade cannot be overridden by your BackendHint

OUTPUT FORMAT:
Respond with ONLY a valid JSON object matching this exact schema:

{
  "reasoning": "<2-3 sentence first-principles rationale>",
  "resourcePosture": "full" | "preserve" | "local-only" | "degraded",
  "resourceRationale": "<why this posture given current headroom>",
  "topGoalId": "<existing goal id to prioritize, or null>",
  "suggestedNewGoal": "<new goal objective if gap detected, or null>",
  "backendHint": null | {
    "preferBackends": ["<engine>"],
    "avoidBackends": ["<engine>"],
    "rationale": "<why>"
  },
  "telegramDigest": "<the proactive message to send — ≤15 lines, plain text>",
  "escalations": [],
  "confidence": "high" | "medium" | "low"
}

escalations items (when non-empty):
{
  "topic": "<what decision Mason needs to make>",
  "context": "<relevant facts>",
  "options": ["<option 1>", "<option 2>"],
  "stakes": "high" | "critical"
}

Respond ONLY with valid JSON. No prose, no markdown fences.`;

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
  parts.push(`Merged: ${ctx.outcomes.mergedCount}, Rejected: ${ctx.outcomes.rejectedCount}`);
  parts.push(`Cost today: $${ctx.outcomes.costUsdToday.toFixed(4)}`);
  const cacheHitPct = Math.round(ctx.outcomes.cacheHitRate * 100);
  parts.push(`Cache hit rate: ${cacheHitPct}%`);
  const shipRates = Object.entries(ctx.outcomes.engineShipRates);
  if (shipRates.length > 0) {
    parts.push('Engine ship rates: ' + shipRates.map(([e, r]) => `${e}=${r}%`).join(', '));
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
    parts.push('=== LEARNING (7d) ===');
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
