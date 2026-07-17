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
import { isAbsolute, join } from 'node:path';
import type { AshlrConfig, Goal, GoalStatus, Milestone, MilestoneStatus } from '../types.js';
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
export const DEFAULT_STALE_GOAL_MILESTONE_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_STALE_GOAL_RECOVERY_LIMIT = 10;

export interface RecoveredStaleGoalLane {
  goalId: string;
  milestoneId: string;
  project: string | null;
  title: string;
  ageMs: number;
  previousUpdatedAt: string;
  recoveredAt: string;
  dryRun: boolean;
}

export interface RecoverStaleGoalLanesResult {
  generatedAt: string;
  dryRun: boolean;
  staleMs: number;
  limit: number;
  scannedGoals: number;
  eligible: number;
  recovered: number;
  lanes: RecoveredStaleGoalLane[];
}

export interface ListGoalsDetailedResult {
  goals: Goal[];
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  scannedFiles: number;
  unreadableFiles: number;
  limitExceeded: boolean;
}

export interface GoalPersistenceOptions {
  now?: string;
  stillAuthorized?: () => boolean;
}

export interface UpdateMilestoneStatusOptions extends GoalPersistenceOptions {
  swarmId?: string | null;
  proposalId?: string | null;
  specId?: string | null;
}

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

function parseTimeMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function staleMilestoneAgeMs(nowMs: number, goal: Goal, milestone: Milestone): number | null {
  const updatedMs = parseTimeMs(milestone.updatedAt ?? goal.updatedAt ?? goal.createdAt);
  if (updatedMs === null) return null;
  return Math.max(0, nowMs - updatedMs);
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

function goalIdIdentity(id: string): string {
  // Win32 resolves goal paths case-insensitively; other platforms retain the
  // exact persisted spelling so distinct case-sensitive records stay distinct.
  return process.platform === 'win32' ? id.toLowerCase() : id;
}

function goalIdsMatch(left: string, right: string): boolean {
  return goalIdIdentity(left) === goalIdIdentity(right);
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

const GOAL_STATUSES: ReadonlySet<GoalStatus> = new Set([
  'planning',
  'active',
  'paused',
  'done',
  'archived',
]);

const MILESTONE_STATUSES: ReadonlySet<MilestoneStatus> = new Set([
  'pending',
  'in-progress',
  'proposed',
  'paused',
  'skipped',
  'blocked',
  'done',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function timestampsAreOrdered(createdAt: string, updatedAt: string): boolean {
  return Date.parse(updatedAt) >= Date.parse(createdAt);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isValidMilestone(parsed: unknown): parsed is Milestone {
  if (!isRecord(parsed)) return false;
  const createdAt = parsed['createdAt'];
  const updatedAt = parsed['updatedAt'];
  return (
    typeof parsed['id'] === 'string' && /^[\w.-]+$/.test(parsed['id']) &&
    typeof parsed['title'] === 'string' &&
    typeof parsed['detail'] === 'string' &&
    Number.isSafeInteger(parsed['order']) && (parsed['order'] as number) >= 0 &&
    typeof parsed['status'] === 'string' &&
    MILESTONE_STATUSES.has(parsed['status'] as MilestoneStatus) &&
    isNullableString(parsed['specId']) &&
    isNullableString(parsed['swarmId']) &&
    isNullableString(parsed['proposalId']) &&
    isValidTimestamp(createdAt) &&
    isValidTimestamp(updatedAt) &&
    timestampsAreOrdered(createdAt, updatedAt)
  );
}

/** Full persisted-record guard so parseable corruption cannot look authoritative. */
function isValidGoal(parsed: unknown): parsed is Goal {
  if (!isRecord(parsed)) return false;
  const project = parsed['project'];
  const createdAt = parsed['createdAt'];
  const updatedAt = parsed['updatedAt'];
  const milestones = parsed['milestones'];
  if (
    typeof parsed['id'] !== 'string' || !/^[\w.-]+$/.test(parsed['id']) ||
    typeof parsed['objective'] !== 'string' ||
    (parsed['owner'] !== undefined && typeof parsed['owner'] !== 'string') ||
    !(project === null || (typeof project === 'string' && isAbsolute(project))) ||
    typeof parsed['status'] !== 'string' ||
    !GOAL_STATUSES.has(parsed['status'] as GoalStatus) ||
    !Array.isArray(milestones) ||
    !isValidTimestamp(createdAt) ||
    !isValidTimestamp(updatedAt) ||
    !timestampsAreOrdered(createdAt, updatedAt)
  ) return false;

  const milestoneIds = new Set<string>();
  const milestoneOrders = new Set<number>();
  for (const milestone of milestones) {
    if (!isValidMilestone(milestone) ||
      milestoneIds.has(milestone.id) || milestoneOrders.has(milestone.order)) return false;
    milestoneIds.add(milestone.id);
    milestoneOrders.add(milestone.order);
  }
  return true;
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
 * M109: stamps `owner` from cfg.user?.id ?? cfg.user?.name when cfg is
 * provided (undefined otherwise — backward-compatible).
 *
 * NEVER runs a swarm, authors a spec, or emits an outward action. Best-effort
 * persistence (returns the in-memory Goal even if the write fails).
 */
export function createGoal(
  objective: string,
  opts?: { project?: string | null; now?: string; cfg?: Pick<AshlrConfig, 'user'> },
): Goal {
  const now = nowIso(opts?.now);
  // M109: stamp owner from cfg.user when not already provided.
  const owner = opts?.cfg?.user?.id ?? opts?.cfg?.user?.name;
  const goal: Goal = {
    id: generateGoalId(objective),
    objective,
    project: opts?.project ?? null,
    status: 'planning',
    milestones: [],
    createdAt: now,
    updatedAt: now,
    ...(owner !== undefined ? { owner } : {}),
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
    if (!isValidGoal(parsed) || !goalIdsMatch(parsed.id, id)) return null;
    sortMilestones(parsed);
    return parsed;
  } catch {
    return null;
  }
}

function emptyGoalRead(
  sourceState: ListGoalsDetailedResult['sourceState'],
  overrides: Partial<ListGoalsDetailedResult> = {},
): ListGoalsDetailedResult {
  return {
    goals: [],
    sourceState,
    sourcePresent: sourceState !== 'missing',
    complete: sourceState !== 'degraded',
    scannedFiles: 0,
    unreadableFiles: 0,
    limitExceeded: false,
    ...overrides,
  };
}

/**
 * List persisted Goals with explicit source-quality diagnostics. A missing
 * directory is an authoritative empty source; unreadable, malformed, or
 * truncated sources are degraded and incomplete.
 */
export function listGoalsDetailed(filter?: { status?: GoalStatus }): ListGoalsDetailedResult {
  try {
    const dir = goalsDir();
    if (!existsSync(dir)) return emptyGoalRead('missing');
    const allFiles = readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'));
    const limitExceeded = allFiles.length > MAX_LIST;
    const files = allFiles.slice(0, MAX_LIST);
    const candidates: Array<{ file: string; goal: Goal; identity: string }> = [];
    const identityCounts = new Map<string, number>();
    let unreadableFiles = 0;
    for (const f of files) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        if (isValidGoal(parsed)) {
          const identity = goalIdIdentity(parsed.id);
          candidates.push({ file: f, goal: parsed, identity });
          identityCounts.set(identity, (identityCounts.get(identity) ?? 0) + 1);
        } else {
          unreadableFiles += 1;
        }
      } catch {
        unreadableFiles += 1;
      }
    }
    const goals: Goal[] = [];
    for (const candidate of candidates) {
      const expectedFile = `${candidate.goal.id}.json`;
      if (!goalIdsMatch(candidate.file, expectedFile) || identityCounts.get(candidate.identity) !== 1) {
        unreadableFiles += 1;
        continue;
      }
      sortMilestones(candidate.goal);
      goals.push(candidate.goal);
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
    const complete = unreadableFiles === 0 && !limitExceeded;
    return {
      goals: filtered,
      sourceState: complete ? 'healthy' : 'degraded',
      sourcePresent: true,
      complete,
      scannedFiles: files.length,
      unreadableFiles,
      limitExceeded,
    };
  } catch {
    return emptyGoalRead('degraded');
  }
}

/**
 * List all persisted Goals, most-recent first by updatedAt (bounded MAX_LIST).
 * Skips .tmp sidecars and unreadable/corrupt files. Read-only. Never throws.
 */
export function listGoals(filter?: { status?: GoalStatus }): Goal[] {
  return listGoalsDetailed(filter).goals;
}

/**
 * Persist a Goal record atomically (tmp-write + rename). Bumps updatedAt.
 * Best-effort; returns false on revocation or I/O failure and never throws.
 */
export function saveGoal(
  goal: Goal,
  opts?: GoalPersistenceOptions,
  stillAuthorized: () => boolean = opts?.stillAuthorized ?? (() => true),
): boolean {
  try {
    const dir = goalsDir();
    ensureDir(dir);
    goal.updatedAt = nowIso(opts?.now);
    sortMilestones(goal);
    const target = goalPath(dir, goal.id);
    const tmp = `${target}.tmp`;
    if (!stillAuthorized()) return false;
    writeFileSync(tmp, JSON.stringify(goal, null, 2), 'utf8');
    if (!stillAuthorized()) return false;
    renameSync(tmp, target);
    return true;
  } catch {
    /* best-effort persistence */
    return false;
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
  link?: UpdateMilestoneStatusOptions,
  stillAuthorized: () => boolean = link?.stillAuthorized ?? (() => true),
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
  if (!saveGoal(goal, { now }, stillAuthorized)) return null;
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
 * Reset stale, proposal-less in-progress milestones back to pending.
 *
 * This is an idempotent local recovery primitive for fleet lane locks. It
 * intentionally refuses milestones with proposalId because those may represent
 * real work awaiting review/merge elsewhere. It only edits goal JSON under
 * ~/.ashlr/goals and never touches a user repo, proposal, branch, or remote.
 */
export function recoverStaleGoalLanes(opts?: {
  now?: string;
  staleMs?: number;
  limit?: number;
  dryRun?: boolean;
}): RecoverStaleGoalLanesResult {
  const generatedAt = nowIso(opts?.now);
  const parsedNow = Date.parse(generatedAt);
  const nowMs = Number.isNaN(parsedNow) ? Date.now() : parsedNow;
  const staleMs = Math.max(1, opts?.staleMs ?? DEFAULT_STALE_GOAL_MILESTONE_MS);
  const limit = Math.max(0, opts?.limit ?? DEFAULT_STALE_GOAL_RECOVERY_LIMIT);
  const dryRun = Boolean(opts?.dryRun);
  const goals = listGoals({ status: 'active' });

  const candidates: RecoveredStaleGoalLane[] = [];
  for (const goal of goals) {
    for (const milestone of goal.milestones) {
      if (milestone.status !== 'in-progress') continue;
      if (milestone.proposalId) continue;
      const ageMs = staleMilestoneAgeMs(nowMs, goal, milestone);
      if (ageMs === null || ageMs <= staleMs) continue;
      candidates.push({
        goalId: goal.id,
        milestoneId: milestone.id,
        project: goal.project ?? null,
        title: milestone.title,
        ageMs,
        previousUpdatedAt: milestone.updatedAt ?? goal.updatedAt ?? goal.createdAt,
        recoveredAt: generatedAt,
        dryRun,
      });
    }
  }

  candidates.sort((a, b) => b.ageMs - a.ageMs || a.goalId.localeCompare(b.goalId));
  const selected = candidates.slice(0, limit);
  const lanes: RecoveredStaleGoalLane[] = [];

  for (const lane of selected) {
    if (dryRun) {
      lanes.push(lane);
      continue;
    }
    const updated = updateMilestoneStatus(lane.goalId, lane.milestoneId, 'pending', {
      swarmId: null,
      proposalId: null,
      now: generatedAt,
    });
    if (!updated) continue;
    lanes.push({ ...lane, dryRun: false });
  }

  return {
    generatedAt,
    dryRun,
    staleMs,
    limit,
    scannedGoals: goals.length,
    eligible: candidates.length,
    recovered: dryRun ? 0 : lanes.length,
    lanes,
  };
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
