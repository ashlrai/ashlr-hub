/**
 * goal-planner.ts — M222: expand a milestone-less active Goal into
 * concrete milestones sized and ordered for its objective via the FRONTIER strategist.
 *
 * CONTRACT (paramount):
 *  - NEVER throws: all strategist failures leave the goal unchanged.
 *  - PURE SIDE-EFFECT on the goal store only: no swarm, no PR, no approval.
 *  - Grounded in docs/IMPROVEMENT-BACKLOG.md as an opportunity menu.
 *  - Concrete milestones describe intended outcomes, changes and validation;
 *    useful documentation, maintenance and delivery work can be included.
 *  - Cached per goal id (in-process Map) so the planner runs at most once per
 *    goal per daemon tick; cleared between ticks by the daemon.
 *  - Flag-gated: cfg.foundry?.goalPlanning !== false (default ON). When
 *    goalPlanning is explicitly false the function is a no-op (flag-off =
 *    current behavior: scanner emits nothing for milestone-less goals).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AshlrConfig, Goal } from '../types.js';
import { loadGoal, saveGoal } from '../goals/store.js';
import { northStarDocSummary } from '../ecosystem/map.js';

// ---------------------------------------------------------------------------
// Observability — M223: structured log so daemon log shows planner activity.
// Mirrors the M197 logging pattern used by manager.ts / automerge-pass.ts.
// ---------------------------------------------------------------------------

function plannerLog(level: 'info' | 'warn', msg: string, extra?: Record<string, unknown>): void {
  const line = extra
    ? `[ashlr] goal-planner:${level} ${msg} ${JSON.stringify(extra)}`
    : `[ashlr] goal-planner:${level} ${msg}`;
  if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// ---------------------------------------------------------------------------
// In-process expansion cache — prevents repeated LLM calls within one tick.
// ---------------------------------------------------------------------------

const _expanded = new Set<string>();

/** Clear the in-process cache (called once per daemon tick). */
export function clearGoalPlannerCache(): void {
  _expanded.clear();
}

// ---------------------------------------------------------------------------
// Backlog grounding — read IMPROVEMENT-BACKLOG.md once (cached).
// ---------------------------------------------------------------------------

let _backlogCache: string | null = undefined as unknown as string | null;

function readBacklog(repoRoot: string): string {
  if (_backlogCache !== (undefined as unknown as string | null)) return _backlogCache ?? '';
  try {
    const p = join(repoRoot, 'docs', 'IMPROVEMENT-BACKLOG.md');
    if (existsSync(p)) {
      // Truncate to first 4000 chars — enough for the opportunity menu without
      // blowing the context budget.
      _backlogCache = readFileSync(p, 'utf8').slice(0, 4000);
    } else {
      _backlogCache = '';
    }
  } catch {
    _backlogCache = '';
  }
  return _backlogCache ?? '';
}

// ---------------------------------------------------------------------------
// Milestone extraction from LLM response
// ---------------------------------------------------------------------------

/**
 * Parse a numbered/bulleted list from the LLM response into milestone objects.
 * Accepts:
 *   1. Title — detail
 *   - Title: detail
 *   1) Title\nDetail on next line
 * Preserves the complete ordered plan, or [] on parse failure.
 */
function parseMilestones(
  raw: string,
): Array<{ title: string; detail: string }> {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const items: Array<{ title: string; detail: string }> = [];

  // Match lines that start with a list marker (1. / 1) / - / *)
  const markerRe = /^(?:\d+[.)]\s+|[-*]\s+)(.*)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = markerRe.exec(line);
    if (!m) continue;
    const rest = m[1]!.trim();

    // Try "Title — detail" or "Title: detail" on the same line
    // ASCII hyphens inside names (rate-limiter, cli-to-desktop) are not separators.
    const sepRe = /^(.+?)\s*(?:[—–]{1,2}|[ \t]+-{1,2}[ \t]+)\s*(.+)$|^(.+?):\s+(.+)$/;
    const sep = sepRe.exec(rest);
    if (sep) {
      const title = (sep[1] ?? sep[3] ?? '').trim();
      const detail = (sep[2] ?? sep[4] ?? '').trim();
      if (title && detail) {
        items.push({ title, detail });
        continue;
      }
    }

    // Title on this line, detail on next (if next line is NOT a list marker)
    const nextLine = lines[i + 1];
    if (nextLine && !markerRe.test(nextLine)) {
      items.push({ title: rest, detail: nextLine });
      i++; // consume the detail line
      continue;
    }

    // Bare title only — synthesize a generic detail
    if (rest.length > 3) {
      items.push({
        title: rest,
        detail: `Deliver "${rest}" with a focused change and verify its intended outcome.`,
      });
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * For an active Goal with zero milestones, call the FRONTIER strategist to
 * decompose its objective into concrete, ordered milestones and persist them
 * back to the goal store.
 *
 * @param goal     The active, milestone-less Goal to expand.
 * @param cfg      AshlrConfig (used to resolve the frontier client).
 * @param repoRoot Absolute path of the repo (used to locate IMPROVEMENT-BACKLOG.md).
 *
 * Returns the updated Goal on success, or the original goal on failure.
 * Never throws.
 */
export async function expandGoalToMilestones(
  goal: Goal,
  cfg: Pick<AshlrConfig, 'foundry'> & Partial<Pick<AshlrConfig, 'models'>>,
  repoRoot: string,
): Promise<Goal> {
  // Guard 1: flag-off → no-op (byte-identical to current behavior)
  const foundry = cfg.foundry as Record<string, unknown> | undefined;
  if (foundry?.['goalPlanning'] === false) {
    plannerLog('info', 'skip: goalPlanning flag is off', { goalId: goal.id });
    return goal;
  }

  // Guard 2: goal must have zero milestones (don't re-plan a partial plan)
  if (goal.milestones.length > 0) return goal;

  // Guard 3: in-process cache — run once per goal per tick
  if (_expanded.has(goal.id)) {
    plannerLog('info', 'skip: already expanded this tick', { goalId: goal.id });
    return goal;
  }
  _expanded.add(goal.id);

  try {
    // Resolve the frontier strategist client (same resolver as manager.ts).
    // Dynamic import avoids a circular dep: manager.ts → scanners.ts → here.
    plannerLog('info', 'expanding goal to milestones', { goalId: goal.id, objective: goal.objective.slice(0, 80) });
    const { resolveFrontierJudgeClient } = await import('../fleet/manager.js');
    const client = resolveFrontierJudgeClient(cfg as AshlrConfig);
    if (!client) {
      plannerLog('warn', 'skip: no frontier client resolved', { goalId: goal.id });
      return goal; // no client available → leave goal unchanged
    }

    const backlog = readBacklog(repoRoot);

    // M231: inject NORTH-STAR grand vision so milestones are aligned to the
    // 3 pillars and useful outcomes, using the same provider-neutral context
    // as other strategy and execution surfaces.
    const northStarSection = northStarDocSummary();

    const systemPrompt = [
      'You are an expert engineering strategist for an autonomous coding fleet.',
      'Decompose the objective into the concrete milestones it needs; choose their number and scope from the work.',
      '',
      northStarSection
        ? `GRAND VISION GROUNDING — orient milestones toward these pillars:\n${northStarSection}`
        : '',
      '',
      'PLANNING GUIDANCE:',
      '1. Prioritize useful outcomes; code, documentation, tests, CI, releases and maintenance can all advance the objective.',
      '2. Describe the specific files, modules, interfaces or behavior being changed and how success will be verified.',
      '3. Prefer focused, reviewable changes; let task complexity determine their scope and duration.',
      '4. Parallelize independent work when useful. When milestones depend on one another, order prerequisites first and describe those dependencies in their details.',
      '5. Judge the plan by the intended outcome and available evidence, rather than a preset task category or score threshold.',
      'OUTPUT FORMAT: Only a numbered list (1. Title — detail). No prose before or after.',
      '',
      backlog
        ? `OPPORTUNITY MENU (grounded in the repo's known improvement backlog — prefer items from this list when they match the objective):\n${backlog}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    const userPrompt = [
      `Decompose this objective into the concrete milestones it needs:`,
      `"${goal.objective}"`,
      '',
      'Each milestone: one line, format: "N. <Short Title> — <concrete detail: what file/module/behavior changes and how>"',
      'Example: "1. Add JWT middleware — implement src/auth/jwt.ts with verify() + attach to Express router; add unit tests."',
    ].join('\n');

    const raw = await client.complete(systemPrompt, userPrompt);
    const parsed = parseMilestones(raw);

    if (parsed.length === 0) {
      // Response was unparseable — leave goal unchanged
      plannerLog('warn', 'expansion failed: could not parse any milestones from strategist response', {
        goalId: goal.id,
        rawSnippet: raw.slice(0, 200),
        parsedCount: parsed.length,
      });
      return goal;
    }

    // Reload fresh from store (avoid stomping concurrent writes)
    const fresh = loadGoal(goal.id) ?? goal;
    if (fresh.milestones.length > 0) return fresh; // someone else expanded it
    const preExpansion = structuredClone(fresh);

    // Append milestones via direct mutation + saveGoal (mirrors addMilestone pattern
    // but batches all milestones in one atomic write)
    const now = new Date().toISOString();
    parsed.forEach((m, i) => {
      fresh.milestones.push({
        id: `${fresh.id}-m${i}`,
        title: m.title,
        detail: m.detail,
        order: i,
        status: 'pending',
        specId: null,
        swarmId: null,
        proposalId: null,
        createdAt: now,
        updatedAt: now,
      });
    });

    // Re-roll status: has milestones → 'active'
    fresh.status = 'active';
    if (!saveGoal(fresh, { now })) {
      plannerLog('warn', 'goal expansion persistence refused — concurrent steering won', {
        goalId: fresh.id,
      });
      return loadGoal(goal.id) ?? preExpansion;
    }
    plannerLog('info', 'goal expanded', {
      goalId: fresh.id,
      milestonesProduced: fresh.milestones.length,
      titles: fresh.milestones.map((m) => m.title),
    });
    return fresh;
  } catch (err) {
    // Strategist failure → goal unchanged, never rethrow
    plannerLog('warn', 'expansion threw — goal unchanged', {
      goalId: goal.id,
      error: (err as Error)?.message ?? String(err),
    });
    return goal;
  }
}
