/**
 * store.ts — M28: Goal record persistence for `ashlr goals`.
 *
 * Persists one Goal per file at ~/.ashlr/goals/<id>.json (atomic write-then-
 * rename), mirroring the learn/quality/inbox store pattern.
 *
 * GUARDRAILS (paramount — see docs/contracts/CONTRACT-M28.md):
 *  - PURE PERSISTENCE / READ-MOSTLY: this module NEVER runs a swarm, NEVER
 *    authors a spec, NEVER touches a user repo working tree, NEVER emits an
 *    outward action (no applyProposal, no setStatus(approved), no git push, no
 *    createPr, no deploy). It only reads/writes JSON under ~/.ashlr/goals/.
 *  - LOCAL-FIRST: writes ONLY under ~/.ashlr/goals/. Zero network.
 *  - Atomic write: <id>.json.tmp then rename (POSIX-atomic).
 *  - Never throws on read paths: list/load swallow errors and return safe
 *    defaults ([] / null) so callers remain unblocked.
 *  - No secrets stored: Goal/Milestone carry metadata + ids only.
 *  - No new runtime deps; node builtins only.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Goal, GoalStatus, Milestone, MilestoneStatus } from '../types.js';
import { goalsDir } from '../config.js';

// Re-export so existing importers of `goalsDir` from the store keep working;
// the canonical definition now lives in config.ts (single source of truth for
// the ~/.ashlr root). Re-resolved from homedir() at call time so tests that
// relocate HOME still work.
export { goalsDir };

// ---------------------------------------------------------------------------
// Bounded list cap — never read more than this many goal files at once.
// ---------------------------------------------------------------------------

const MAX_LIST = 200;

// ---------------------------------------------------------------------------
// Injectable clock (test determinism)
// ---------------------------------------------------------------------------
//
// All timestamp stamping flows through nowIso(). Tests pass an explicit `now`
// (ISO string) so metric/test paths are fully deterministic — there is NO
// hidden nondeterminism in a stamped record.

/** Current ISO timestamp, or the explicit override when provided (test seam). */
function nowIso(now?: string): string {
  return now ?? new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Path helpers (re-resolved at call time so tests can relocate HOME)
// ---------------------------------------------------------------------------

/**
 * Absolute path to a specific goal file. Validates the id charset (mirrors the
 * swarm store) so the store is self-defending against path traversal
 * regardless of how a caller derived the id. Allowed: word chars, dot, hyphen.
 *
 * @throws when `id` contains anything outside [\w.-].
 */
function goalPath(dir: string, id: string): string {
  if (!/^[\w.-]+$/.test(id)) throw new Error(`Invalid goal id: ${id}`);
  return join(dir, `${id}.json`);
}

/** Ensure the goals directory exists, silently creating it if needed. */
function ensureDir(dir: string): void {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/**
 * Derive a stable slug from text: lowercase, words joined with hyphens, max 48
 * chars, alphanumeric + hyphens only (mirrors spec-store's slugify).
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48)
    .replace(/-$/, '');
}

/**
 * Generate a stable, readable, filename-safe goal id derived from the
 * objective (slug + short hash), mirroring spec-store's generateSpecId so two
 * similar objectives don't silently collide.
 */
function generateGoalId(objective: string): string {
  const slug = slugify(objective) || 'goal';
  const hash = createHash('sha256').update(objective).digest('hex').slice(0, 6);
  return `${slug}-${hash}`;
}

/** Generate a stable milestone id unique within its goal (e.g. `${goalId}-m<order>`). */
function generateMilestoneId(goalId: string, order: number): string {
  return `${goalId}-m${order}`;
}

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

/** Light type-guard so we never return garbage from the store. */
function isValidGoal(parsed: unknown): parsed is Goal {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const g = parsed as Record<string, unknown>;
  return (
    typeof g['id'] === 'string' &&
    typeof g['objective'] === 'string' &&
    typeof g['status'] === 'string' &&
    Array.isArray(g['milestones'])
  );
}

// ---------------------------------------------------------------------------
// Status roll-up — derive a goal's status from its milestones.
// ---------------------------------------------------------------------------

/**
 * Re-roll a goal's status from its milestones. Preserves an explicit human
 * 'paused' / 'archived' (those are sticky human states the mutators set/clear
 * directly). Otherwise: 'planning' when no milestones, 'done' when every
 * non-skipped milestone is 'done', else 'active'.
 */
function rollGoalStatus(goal: Goal): GoalStatus {
  if (goal.status === 'paused' || goal.status === 'archived') return goal.status;
  if (goal.milestones.length === 0) return 'planning';
  const live = goal.milestones.filter((m) => m.status !== 'skipped');
  if (live.length > 0 && live.every((m) => m.status === 'done')) return 'done';
  return 'active';
}

/** Sort milestones in place by ascending `order` (stable). */
function sortMilestones(goal: Goal): void {
  goal.milestones.sort((a, b) => a.order - b.order);
}

// ---------------------------------------------------------------------------
// CRUD — Goal records
// ---------------------------------------------------------------------------

/**
 * Create a new Goal from an objective, persist it, and return it.
 *
 * Assigns a fresh id, status 'planning', empty milestones, and createdAt/
 * updatedAt timestamps. `project` (when given) MUST already be a resolved,
 * ENROLLED absolute repo path — enrollment is enforced by the CLI/advance
 * path, NOT here; this is pure persistence.
 *
 * NEVER runs a swarm, authors a spec, or emits an outward action. Best-effort
 * persistence (returns the in-memory Goal even if the write fails).
 */
export function createGoal(
  objective: string,
  opts?: { project?: string | null; now?: string },
): Goal {
  const now = nowIso(opts?.now);
  const goal: Goal = {
    id: generateGoalId(objective),
    objective,
    project: opts?.project ?? null,
    status: 'planning',
    milestones: [],
    createdAt: now,
    updatedAt: now,
  };
  saveGoal(goal, { now });
  return goal;
}

/**
 * Load a single Goal by id. Returns null when absent, unreadable, or malformed.
 * Read-only. Never throws.
 */
export function loadGoal(id: string): Goal | null {
  try {
    const file = goalPath(goalsDir(), id);
    if (!existsSync(file)) return null;
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isValidGoal(parsed)) return null;
    sortMilestones(parsed);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * List all persisted Goals, most-recent first by updatedAt (bounded MAX_LIST).
 * Skips .tmp sidecars and unreadable/corrupt files. Read-only. Never throws.
 */
export function listGoals(filter?: { status?: GoalStatus }): Goal[] {
  try {
    const dir = goalsDir();
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
      .slice(0, MAX_LIST);
    const goals: Goal[] = [];
    for (const f of files) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        if (isValidGoal(parsed)) {
          sortMilestones(parsed);
          goals.push(parsed);
        }
      } catch {
        /* skip corrupt file */
      }
    }
    const filtered =
      filter?.status !== undefined ? goals.filter((g) => g.status === filter.status) : goals;
    // Newest-first by updatedAt; tiebreak on id so same-ms records order stably.
    filtered.sort((a, b) => {
      if (a.updatedAt < b.updatedAt) return 1;
      if (a.updatedAt > b.updatedAt) return -1;
      if (a.id < b.id) return 1;
      if (a.id > b.id) return -1;
      return 0;
    });
    return filtered;
  } catch {
    return [];
  }
}

/**
 * Persist a Goal record atomically (tmp-write + rename). Bumps updatedAt.
 * Best-effort; never throws (mirrors the swarm/inbox stores).
 */
export function saveGoal(goal: Goal, opts?: { now?: string }): void {
  try {
    const dir = goalsDir();
    ensureDir(dir);
    goal.updatedAt = nowIso(opts?.now);
    sortMilestones(goal);
    const target = goalPath(dir, goal.id);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(goal, null, 2), 'utf8');
    renameSync(tmp, target);
  } catch {
    /* best-effort persistence */
  }
}

/**
 * Delete a Goal record by id. Idempotent — deleting an absent goal is a no-op.
 * Pure FS under ~/.ashlr/goals; never touches a user repo. Never throws.
 */
export function deleteGoal(id: string): void {
  try {
    unlinkSync(goalPath(goalsDir(), id));
  } catch {
    /* idempotent no-op */
  }
}

// ---------------------------------------------------------------------------
// Milestone mutators — the human's STEERING controls.
//
// Each mutator loads the goal, mutates milestones IN MEMORY, re-sorts by order,
// re-rolls the goal status, and saveGoal()s. None of them runs a swarm or
// emits an outward action — they are pure local edits to the plan.
// ---------------------------------------------------------------------------

/**
 * Append a new Milestone to a Goal (status 'pending', specId/swarmId/proposalId
 * null) at the end of the current order. Returns the updated Goal, or null if
 * the goal does not exist. Used by planner.decomposeGoal to materialize a plan.
 */
export function addMilestone(
  goalId: string,
  milestone: Pick<Milestone, 'title' | 'detail'>,
  opts?: { now?: string },
): Goal | null {
  const goal = loadGoal(goalId);
  if (!goal) return null;
  const now = nowIso(opts?.now);
  const nextOrder =
    goal.milestones.length === 0
      ? 0
      : Math.max(...goal.milestones.map((m) => m.order)) + 1;
  goal.milestones.push({
    id: generateMilestoneId(goalId, nextOrder),
    title: milestone.title,
    detail: milestone.detail,
    order: nextOrder,
    status: 'pending',
    specId: null,
    swarmId: null,
    proposalId: null,
    createdAt: now,
    updatedAt: now,
  });
  goal.status = rollGoalStatus(goal);
  saveGoal(goal, { now });
  return goal;
}

/**
 * Set a milestone's status (and optionally link swarmId/proposalId/specId).
 * This is the ONLY way the advance path records progress (pending ->
 * in-progress -> proposed, or -> blocked). Returns the updated Goal, or null
 * if not found.
 *
 * NOTE: this mutates the M28 Goal record ONLY — it NEVER calls inbox setStatus
 * and NEVER approves/applies the linked proposal.
 */
export function updateMilestoneStatus(
  goalId: string,
  milestoneId: string,
  status: MilestoneStatus,
  link?: {
    swarmId?: string | null;
    proposalId?: string | null;
    specId?: string | null;
    now?: string;
  },
): Goal | null {
  const goal = loadGoal(goalId);
  if (!goal) return null;
  const m = goal.milestones.find((x) => x.id === milestoneId);
  if (!m) return null;
  const now = nowIso(link?.now);
  m.status = status;
  if (link) {
    if (link.swarmId !== undefined) m.swarmId = link.swarmId;
    if (link.proposalId !== undefined) m.proposalId = link.proposalId;
    if (link.specId !== undefined) m.specId = link.specId;
  }
  m.updatedAt = now;
  goal.status = rollGoalStatus(goal);
  saveGoal(goal, { now });
  return goal;
}

/**
 * Clear ALL of a goal's milestones, returning it to a fresh, unplanned state
 * (status re-rolled to 'planning'). Used by the CLI `goals plan --replace` to
 * support an explicit, destructive re-plan WITHOUT duplicating the milestone
 * set. Pure local edit under ~/.ashlr/goals — never runs a swarm, never touches
 * a user repo, never approves/applies a proposal. Returns the updated Goal, or
 * null if not found.
 */
export function clearMilestones(goalId: string, opts?: { now?: string }): Goal | null {
  const goal = loadGoal(goalId);
  if (!goal) return null;
  goal.milestones = [];
  goal.status = rollGoalStatus(goal);
  saveGoal(goal, { now: opts?.now });
  return goal;
}

/**
 * Reorder a goal's milestones to match the given id sequence (any ids omitted
 * keep their relative order after the listed ones). Rewrites `order` keys and
 * re-sorts. Returns the updated Goal, or null if not found.
 */
export function reorderMilestones(
  goalId: string,
  orderedIds: string[],
  opts?: { now?: string },
): Goal | null {
  const goal = loadGoal(goalId);
  if (!goal) return null;
  const rank = new Map<string, number>();
  orderedIds.forEach((id, i) => rank.set(id, i));
  // Listed ids first (in the given order), then the rest in their current order.
  const reordered = [...goal.milestones].sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id)! : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(b.id) ? rank.get(b.id)! : Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return a.order - b.order;
  });
  reordered.forEach((m, i) => {
    m.order = i;
  });
  goal.milestones = reordered;
  saveGoal(goal, { now: opts?.now });
  return goal;
}

/**
 * Pause a single milestone (status 'paused') or, when milestoneId is omitted,
 * pause the WHOLE goal (goal.status 'paused' — no milestone advances). A paused
 * milestone is skipped by nextActionableMilestone(). Returns updated Goal/null.
 */
export function pauseMilestone(
  goalId: string,
  milestoneId?: string,
  opts?: { now?: string },
): Goal | null {
  const goal = loadGoal(goalId);
  if (!goal) return null;
  const now = nowIso(opts?.now);
  if (milestoneId) {
    const m = goal.milestones.find((x) => x.id === milestoneId);
    if (!m) return null;
    m.status = 'paused';
    m.updatedAt = now;
    goal.status = rollGoalStatus(goal);
  } else {
    goal.status = 'paused';
  }
  saveGoal(goal, { now });
  return goal;
}

/**
 * Resume a milestone back to 'pending' or, when milestoneId is omitted, resume
 * the WHOLE goal (re-roll goal.status). A milestone is resumable when it is
 * 'paused' (human steering) OR 'blocked' (a prior advance that threw / needs
 * recovery) — both transition back to 'pending' so it can be re-advanced. This
 * is the recovery path out of the 'blocked' state the advance error-handler
 * sets. Returns updated Goal/null.
 */
export function resumeMilestone(
  goalId: string,
  milestoneId?: string,
  opts?: { now?: string },
): Goal | null {
  const goal = loadGoal(goalId);
  if (!goal) return null;
  const now = nowIso(opts?.now);
  if (milestoneId) {
    const m = goal.milestones.find((x) => x.id === milestoneId);
    if (!m) return null;
    if (m.status === 'paused' || m.status === 'blocked') {
      m.status = 'pending';
      m.updatedAt = now;
    }
    if (goal.status !== 'archived') goal.status = rollGoalStatus(goal);
  } else {
    // Resume the whole goal: clear the sticky 'paused' so rollGoalStatus recomputes.
    if (goal.status === 'paused') goal.status = 'planning';
    goal.status = rollGoalStatus(goal);
  }
  saveGoal(goal, { now });
  return goal;
}

/**
 * Skip a milestone permanently (status 'skipped'); it is excluded from progress
 * denominators and never advanced. Returns updated Goal, or null if not found.
 */
export function skipMilestone(
  goalId: string,
  milestoneId: string,
  opts?: { now?: string },
): Goal | null {
  const goal = loadGoal(goalId);
  if (!goal) return null;
  const m = goal.milestones.find((x) => x.id === milestoneId);
  if (!m) return null;
  const now = nowIso(opts?.now);
  m.status = 'skipped';
  m.updatedAt = now;
  goal.status = rollGoalStatus(goal);
  saveGoal(goal, { now });
  return goal;
}
