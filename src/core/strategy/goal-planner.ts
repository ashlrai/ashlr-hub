/**
 * goal-planner.ts — M222: expand a milestone-less active Goal into 3-6
 * concrete, independently-shippable milestones via the FRONTIER strategist.
 *
 * CONTRACT (paramount):
 *  - NEVER throws: all strategist failures leave the goal unchanged.
 *  - PURE SIDE-EFFECT on the goal store only: no swarm, no PR, no approval.
 *  - Grounded in docs/IMPROVEMENT-BACKLOG.md (the ~60-item opportunity menu)
 *    so milestones are real product work, NOT docs/version bumps.
 *  - Each milestone must be concrete enough for the executor to produce a
 *    value≥4 diff (real capability / real fix — specific file/module/behavior).
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
 * Returns between 3 and 6 items, or [] on parse failure.
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
    const sepRe = /^(.+?)\s*[—–-]{1,2}\s*(.+)$|^(.+?):\s+(.+)$/;
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
        detail: `Implement "${rest}" as a focused, independently-shippable diff.`,
      });
    }
  }

  // Clamp to 3–6
  if (items.length < 3 || items.length > 6) {
    return items.slice(0, 6).length >= 3 ? items.slice(0, 6) : [];
  }
  return items;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * For an active Goal with zero milestones, call the FRONTIER strategist to
 * decompose its objective into 3-6 concrete, independently-shippable
 * milestones, and persist them back to the goal store.
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
    // 3 pillars (recursive self-improvement, ecosystem product factory, composition
    // flywheel) and substantive (value≥4, bound to a repo, not docs/version-bumps).
    const northStarSection = northStarDocSummary();

    const systemPrompt = [
      'You are an expert engineering strategist for an autonomous coding fleet.',
      'Your task is to decompose a high-level objective into 3-6 concrete, independently-shippable milestones.',
      '',
      northStarSection
        ? `GRAND VISION GROUNDING — orient milestones toward these pillars:\n${northStarSection}`
        : '',
      '',
      'RULES (non-negotiable):',
      '1. Each milestone must be a REAL code change: a new capability, a bug fix, a performance improvement, a test harness, or a refactor.',
      '2. NO documentation-only milestones. NO version-bump-only milestones. NO "update README" milestones.',
      '3. Each milestone must be scoped to a single focused diff that a junior engineer could ship in 1-4 hours.',
      '4. Each milestone must be independently shippable — it does not require another milestone to land first.',
      '5. Be concrete: name the specific module, function, interface, or behavior being changed.',
      '6. Each milestone must be substantive (value≥4): a real capability, real fix, or real product improvement — NOT docs/linting/version bumps.',
      '7. Output ONLY a numbered list (1. Title — detail). No prose before or after.',
      '',
      backlog
        ? `OPPORTUNITY MENU (grounded in the repo's known improvement backlog — prefer items from this list when they match the objective):\n${backlog}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    const userPrompt = [
      `Decompose this objective into 3-6 concrete milestones:`,
      `"${goal.objective}"`,
      '',
      'Each milestone: one line, format: "N. <Short Title> — <concrete detail: what file/module/behavior changes and how>"',
      'Example: "1. Add JWT middleware — implement src/auth/jwt.ts with verify() + attach to Express router; add unit tests."',
    ].join('\n');

    const raw = await client.complete(systemPrompt, userPrompt);
    const parsed = parseMilestones(raw);

    if (parsed.length < 3) {
      // Response was unparseable — leave goal unchanged
      plannerLog('warn', 'expansion failed: could not parse ≥3 milestones from strategist response', {
        goalId: goal.id,
        rawSnippet: raw.slice(0, 200),
        parsedCount: parsed.length,
      });
      return goal;
    }

    // Reload fresh from store (avoid stomping concurrent writes)
    const fresh = loadGoal(goal.id) ?? goal;
    if (fresh.milestones.length > 0) return fresh; // someone else expanded it

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
    saveGoal(fresh, { now });
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
