/**
 * grant-scope.ts — Mason edits a grant DRAFT's scope before he signs it
 * (3.15, the Fleet control surface's grant editor).
 *
 * WHAT THIS IS. The server drafts a StandingGrantV1 (verse/authority-api.ts
 * `buildStandingGrantDraft`); the Touch ID sheet now lets Mason change its
 * scope — which repos, which engines, the Leader's classes, the spend caps,
 * how many days, and explicit signed volume limits — and shows a diff against the grant in force before he signs.
 * This module is the PURE edit and the PURE diff.
 *
 * WHY IT CANNOT RAISE ANYTHING BY ITSELF. An edited draft is still only a
 * draft: it is signed by the custody helper under Touch ID (which shows the
 * scope again in its own prompt), and both the helper and the verifier
 * re-check it against the compiled ceilings (STANDING_GRANT_CEILINGS). The
 * edit chooses the available scope and can explicitly replace volume policy:
 *   - repos: a subset of the draft's repos (the enrolled repos + the canary);
 *   - engines: a subset of the draft's engines plus the four fleet lanes —
 *     never `devin` unless the draft already named it (the helper may not
 *     sign it; authority-api decides that);
 *   - leader classes: a subset of A, B; an explicit stage-ID-bound choice
 *     may replace the first rung's classes within that global ceiling;
 *   - spend: mode and metered dollars inside the ceilings;
 *   - days: 1..30;
 *   - volume: positive safe-integer size and nonnegative per-repo daily limits,
 *     with MAX_SAFE_INTEGER explicitly representing No volume cap.
 * Repos/engines are narrowed on every rung; explicit volume edits are reviewed
 * on each changed rung (a stage may never name what
 * the grant does not), and the result is re-parsed by the same strict parser
 * the verifier uses — an invalid edit is refused, never "fixed up".
 */
import { BUDGET_MODES, type BudgetMode } from '../routing/types.js';
import { engineOfSeatId } from '../routing/policy.js';
import { GRANT_LANE_ENGINES, DEVIN_GRANT_ENGINE, type GrantEngine } from '../fleet/fleet-types.js';
import { parseStandingGrantPayload } from './standing-grant.js';
import { STANDING_GRANT_CEILINGS, volumeLimitLabel, type LeaderGrantClass, type StandingGrantV1, type StandingGrantSeat, type SeatRole, STANDING_GRANT_PATTERNS } from './types.js';
import type { GrantDiffLine, GrantScopeEdit, GrantSeatPolicyEdit } from './grant-scope-types.js';

export type { GrantDiffDirection, GrantDiffLine, GrantScopeEdit } from './grant-scope-types.js';

export const GRANT_SCOPE_EDIT_KEYS: readonly (keyof GrantScopeEdit)[] = Object.freeze([
  'repos', 'engines', 'leaderClasses', 'startingStageLeaderClasses', 'maxMode', 'meteredUsdPerDay', 'days', 'conductorGoals', 'maxFiles', 'maxLines', 'repoMaxMergesPerDay', 'seatPolicies',
]);

const LEADER_CLASSES: readonly LeaderGrantClass[] = ['A', 'B'];
const DAY_MS = 86_400_000;

export type GrantScopeEditResult = { ok: true; payload: StandingGrantV1 } | { ok: false; reason: string };

function stringList(value: unknown, what: string, max: number): string[] | string {
  if (!Array.isArray(value) || value.length > max) return `${what} must be a list of at most ${max}`;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 200) return `${what} must hold short strings`;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/** PURE: validate an untrusted edit body (unknown keys refused). */
export function parseGrantScopeEdit(value: unknown): { ok: true; edit: GrantScopeEdit } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true, edit: {} };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'scope must be an object' };
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!(GRANT_SCOPE_EDIT_KEYS as readonly string[]).includes(key)) return { ok: false, reason: `unknown scope key: ${key}` };
  }
  const edit: GrantScopeEdit = {};
  if (raw['repos'] !== undefined) {
    const list = stringList(raw['repos'], 'repos', STANDING_GRANT_CEILINGS.maxRepos);
    if (typeof list === 'string') return { ok: false, reason: list };
    edit.repos = list;
  }
  if (raw['engines'] !== undefined) {
    const list = stringList(raw['engines'], 'engines', 8);
    if (typeof list === 'string') return { ok: false, reason: list };
    edit.engines = list as GrantEngine[];
  }
  if (raw['leaderClasses'] !== undefined) {
    const list = stringList(raw['leaderClasses'], 'leaderClasses', 2);
    if (typeof list === 'string') return { ok: false, reason: list };
    if (list.some((c) => !(LEADER_CLASSES as readonly string[]).includes(c))) return { ok: false, reason: 'leaderClasses may name only A and B' };
    edit.leaderClasses = list as LeaderGrantClass[];
  }
  if (raw['startingStageLeaderClasses'] !== undefined) {
    const value = raw['startingStageLeaderClasses'];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'startingStageLeaderClasses must name a stage and classes' };
    const stage = value as Record<string, unknown>;
    if (Object.keys(stage).some((key) => key !== 'stageId' && key !== 'classes') ||
      typeof stage['stageId'] !== 'string' || !STANDING_GRANT_PATTERNS.stageId.test(stage['stageId'])) return { ok: false, reason: 'startingStageLeaderClasses must name a valid stage' };
    const classes = stringList(stage['classes'], 'startingStageLeaderClasses.classes', 2);
    if (typeof classes === 'string') return { ok: false, reason: classes };
    if (classes.some((c) => !(LEADER_CLASSES as readonly string[]).includes(c))) return { ok: false, reason: 'starting stage classes may name only A and B' };
    edit.startingStageLeaderClasses = { stageId: stage['stageId'], classes: classes as LeaderGrantClass[] };
  }
  if (raw['maxMode'] !== undefined) {
    if (typeof raw['maxMode'] !== 'string' || !(BUDGET_MODES as readonly string[]).includes(raw['maxMode'])) return { ok: false, reason: 'maxMode must be all-in, balanced or reserve' };
    edit.maxMode = raw['maxMode'] as BudgetMode;
  }
  if (raw['meteredUsdPerDay'] !== undefined) {
    const n = raw['meteredUsdPerDay'];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > STANDING_GRANT_CEILINGS.maxMeteredUsdPerDay) {
      return { ok: false, reason: `meteredUsdPerDay must be a whole number from 0 to ${STANDING_GRANT_CEILINGS.maxMeteredUsdPerDay}` };
    }
    edit.meteredUsdPerDay = n;
  }
  if (raw['days'] !== undefined) {
    const n = raw['days'];
    const maxDays = Math.floor(STANDING_GRANT_CEILINGS.maxTtlMs / DAY_MS);
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > maxDays) return { ok: false, reason: `days must be a whole number from 1 to ${maxDays}` };
    edit.days = n;
  }
  if (raw['conductorGoals'] !== undefined) {
    if (typeof raw['conductorGoals'] !== 'boolean') return { ok: false, reason: 'conductorGoals must be true or false' };
    edit.conductorGoals = raw['conductorGoals'];
  }
  for (const key of ['maxFiles', 'maxLines'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || (value as number) < 1) return { ok: false, reason: `${key} must be a positive safe integer` };
    edit[key] = value as number;
  }
  if (raw['repoMaxMergesPerDay'] !== undefined) {
    const values = raw['repoMaxMergesPerDay'];
    if (!values || typeof values !== 'object' || Array.isArray(values)) return { ok: false, reason: 'repoMaxMergesPerDay must be an object' };
    const entries = Object.entries(values);
    if (entries.length < 1 || entries.length > STANDING_GRANT_CEILINGS.maxRepos) return { ok: false, reason: 'repoMaxMergesPerDay must name enrolled repos' };
    const seen = new Set<string>();
    for (const [repo, value] of entries) {
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/u.test(repo) || seen.has(repo.toLowerCase()) || !Number.isSafeInteger(value) || value < 0) return { ok: false, reason: 'repo merge limits must be unique repo names and nonnegative safe integers' };
      seen.add(repo.toLowerCase());
    }
    edit.repoMaxMergesPerDay = Object.fromEntries(entries) as Record<string, number>;
  }
  if (raw['seatPolicies'] !== undefined) {
    const policies = raw['seatPolicies'];
    if (!policies || typeof policies !== 'object' || Array.isArray(policies)) return { ok: false, reason: 'seatPolicies must be an object' };
    const entries = Object.entries(policies);
    if (entries.length > STANDING_GRANT_CEILINGS.maxSeats) return { ok: false, reason: 'too many seat policies' };
    const parsed: Record<string, GrantSeatPolicyEdit> = {};
    for (const [id, value] of entries) {
      if (!STANDING_GRANT_PATTERNS.seatId.test(id) || !value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'seat policies must name valid accounts and objects' };
      const seat = value as Record<string, unknown>;
      if (Object.keys(seat).some((key) => !['enabled', 'roles', 'reserveFloorPercent', 'maxSessionWindowPercent'].includes(key))) return { ok: false, reason: 'unknown seat policy field' };
      const out: GrantSeatPolicyEdit = {};
      if (seat['enabled'] !== undefined) {
        if (typeof seat['enabled'] !== 'boolean') return { ok: false, reason: 'seat enabled must be true or false' };
        out.enabled = seat['enabled'];
      }
      if (seat['roles'] !== undefined) {
        const roles = seat['roles'];
        if (!Array.isArray(roles) || roles.length < 1 || roles.length > 3 || roles.some((role) => !['producer', 'judge', 'leader'].includes(role)) || new Set(roles).size !== roles.length) return { ok: false, reason: 'seat roles must be a unique nonempty list of producer, judge or leader' };
        out.roles = [...roles];
      }
      if (seat['reserveFloorPercent'] !== undefined) {
        const n = seat['reserveFloorPercent'];
        if (!Number.isInteger(n) || (n as number) < 0 || (n as number) > 100) return { ok: false, reason: 'seat reserve must be a whole percent from 0 to 100' };
        out.reserveFloorPercent = n as number;
      }
      if (seat['maxSessionWindowPercent'] !== undefined) {
        const n = seat['maxSessionWindowPercent'];
        if (n !== null && (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 100)) return { ok: false, reason: 'seat session ceiling must be null or a whole percent from 1 to 100' };
        out.maxSessionWindowPercent = n as number | null;
      }
      parsed[id] = out;
    }
    edit.seatPolicies = parsed;
  }
  return { ok: true, edit };
}

/** PURE: the engines an edit may choose from, given the server's draft. */
export function editableEngines(draft: Pick<StandingGrantV1, 'engines'>): GrantEngine[] {
  const out: GrantEngine[] = [...GRANT_LANE_ENGINES];
  if (draft.engines.includes(DEVIN_GRANT_ENGINE)) out.push(DEVIN_GRANT_ENGINE);
  // Any engine a newer draft names (e.g. a lane this build does not list yet) stays choosable.
  for (const engine of draft.engines) if (!out.includes(engine)) out.push(engine);
  return out;
}

/** Roles the strict grant contract permits for this already listed account. */
export function editableSeatPolicies(draft: Pick<StandingGrantV1, 'spend'>): Record<string, { roles: SeatRole[] }> {
  return Object.fromEntries(Object.keys(draft.spend.seats).map((id) => [id, { roles: engineOfSeatId(id) === 'devin' ? ['producer'] : ['producer', 'judge', 'leader'] }]));
}

/** PURE: apply `edit` to the server's draft. Refuses (never repairs) an invalid result. */
export function applyGrantScopeEdit(draft: StandingGrantV1, requestedEdit: GrantScopeEdit): GrantScopeEditResult {
  const checkedEdit = parseGrantScopeEdit(requestedEdit);
  if (!checkedEdit.ok) return checkedEdit;
  const edit = checkedEdit.edit;
  const next: StandingGrantV1 = structuredClone(draft);

  if (edit.repos !== undefined) {
    const wanted = new Set(edit.repos.map((r) => r.toLowerCase()));
    const known = new Set(draft.repos.map((r) => r.nameWithOwner.toLowerCase()));
    const unknown = edit.repos.filter((r) => !known.has(r.toLowerCase()));
    if (unknown.length > 0) return { ok: false, reason: `not in this draft: ${unknown.join(', ')} (only enrolled repos can be granted)` };
    if (wanted.size === 0) return { ok: false, reason: 'a grant needs at least one repo' };
    next.repos = next.repos.filter((r) => wanted.has(r.nameWithOwner.toLowerCase()));
    next.rollout.stages = next.rollout.stages
      .map((stage) => ({ ...stage, repos: stage.repos.filter((r) => wanted.has(r.nameWithOwner.toLowerCase())) }))
      .filter((stage) => stage.repos.length > 0);
    if (next.rollout.stages.length === 0) return { ok: false, reason: 'no rung of the ladder names any of those repos' };
  }

  if (edit.engines !== undefined) {
    const allowed = editableEngines(draft);
    const bad = edit.engines.filter((e) => !allowed.includes(e));
    if (bad.length > 0) return { ok: false, reason: `engines not available in this draft: ${bad.join(', ')}` };
    if (edit.engines.length === 0) return { ok: false, reason: 'a grant needs at least one engine' };
    // Keep a stable, canonical order (the draft's first, then the lane order).
    const order = editableEngines(draft);
    next.engines = order.filter((e) => edit.engines!.includes(e));
    next.rollout.stages = next.rollout.stages.map((stage) => ({ ...stage, engines: stage.engines.filter((e) => next.engines.includes(e)) }));
    const empty = next.rollout.stages.find((stage) => stage.engines.length === 0);
    if (empty) return { ok: false, reason: `rung ${empty.id} would have no engine left — keep at least one of ${draft.rollout.stages.find((s) => s.id === empty.id)?.engines.join(', ') ?? 'its engines'}` };
    if (!next.engines.includes(DEVIN_GRANT_ENGINE)) {
      next.spend = { ...next.spend, seats: Object.fromEntries(Object.entries(next.spend.seats).filter(([seatId]) => engineOfSeatId(seatId) !== 'devin')) };
    }
  }

  if (edit.leaderClasses !== undefined) {
    next.leader = { ...next.leader, classes: LEADER_CLASSES.filter((c) => edit.leaderClasses!.includes(c)) };
    next.rollout.stages = next.rollout.stages.map((stage) => ({ ...stage, leaderClasses: stage.leaderClasses.filter((c) => next.leader.classes.includes(c)) }));
  }

  if (edit.startingStageLeaderClasses !== undefined) {
    const choice = edit.startingStageLeaderClasses;
    const first = next.rollout.stages[0];
    // Repo narrowing can drop the first rung. Never silently apply a retained
    // choice to a different starting stage, or widen the global ceiling.
    if (!first || choice.stageId !== draft.rollout.stages[0]?.id || choice.stageId !== first.id) return { ok: false, reason: 'the starting stage changed — review a fresh draft before choosing Leader permissions' };
    if (choice.classes.some((c) => !next.leader.classes.includes(c))) return { ok: false, reason: 'starting stage classes must be within the Leader permission ceiling' };
    first.leaderClasses = LEADER_CLASSES.filter((c) => choice.classes.includes(c));
  }

  if (edit.seatPolicies !== undefined) {
    for (const [id, policy] of Object.entries(edit.seatPolicies)) {
      // Exact identities from this server draft only; no new account authority.
      if (!Object.hasOwn(draft.spend.seats, id) || !Object.hasOwn(next.spend.seats, id)) return { ok: false, reason: 'seat policies may name only accounts in the selected draft' };
      const seat = next.spend.seats[id]!;
      if (policy.enabled !== undefined) seat.enabled = policy.enabled;
      if (policy.roles !== undefined) seat.roles = [...policy.roles];
      if (policy.reserveFloorPercent !== undefined) seat.reserveFloorPercent = policy.reserveFloorPercent;
      if (policy.maxSessionWindowPercent === null) delete seat.maxSessionWindowPercent;
      else if (policy.maxSessionWindowPercent !== undefined) seat.maxSessionWindowPercent = policy.maxSessionWindowPercent;
    }
  }

  if (edit.maxMode !== undefined) next.spend = { ...next.spend, maxMode: edit.maxMode };
  if (edit.meteredUsdPerDay !== undefined) next.spend = { ...next.spend, meteredUsdPerDay: edit.meteredUsdPerDay };
  if (edit.conductorGoals !== undefined) next.conductorGoals = edit.conductorGoals;
  if (edit.days !== undefined) {
    const issued = Date.parse(next.issuedAt);
    if (!Number.isFinite(issued)) return { ok: false, reason: 'the draft has no issue time' };
    next.expiresAt = new Date(issued + Math.min(edit.days * DAY_MS, STANDING_GRANT_CEILINGS.maxTtlMs)).toISOString();
  }

  const volumeChoice = edit.maxFiles !== undefined || edit.maxLines !== undefined || edit.repoMaxMergesPerDay !== undefined;
  if (volumeChoice) {
    // Only an explicit volume edit opts in. Plain renewal and unrelated scope
    // edits retain the marker's absence and legacy local restrictions.
    next.merge = { ...next.merge, volumePolicy: 'operator-signed',
      ...(edit.maxFiles === undefined ? {} : { maxFiles: edit.maxFiles }),
      ...(edit.maxLines === undefined ? {} : { maxLines: edit.maxLines }) };
    if (edit.repoMaxMergesPerDay) {
      const requested = new Map(Object.entries(edit.repoMaxMergesPerDay).map(([name, value]) => [name.toLowerCase(), value]));
      if ([...requested.keys()].some((name) => !next.repos.some((repo) => repo.nameWithOwner.toLowerCase() === name))) return { ok: false, reason: 'merge limits may name only the selected enrolled repos' };
      next.repos = next.repos.map((repo) => ({ ...repo, maxMergesPerDay: requested.get(repo.nameWithOwner.toLowerCase()) ?? repo.maxMergesPerDay }));
    }
    next.rollout.stages = next.rollout.stages.map((stage) => ({ ...stage,
      maxFiles: edit.maxFiles ?? stage.maxFiles,
      maxLines: edit.maxLines ?? stage.maxLines,
      // A propose-only/shadow rung stays non-merging. Every repo's signed
      // limit remains binding beneath this stage aggregate limit.
      maxMergesPerRepoPerDay: edit.repoMaxMergesPerDay && stage.repos.some((repo) => repo.stage === 'merge')
        ? Math.max(...stage.repos.map((entry) => next.repos.find((repo) => repo.nameWithOwner === entry.nameWithOwner)!.maxMergesPerDay))
        : stage.maxMergesPerRepoPerDay,
    }));
  }
  const checked = parseStandingGrantPayload(next);
  if (!checked.ok) return { ok: false, reason: `that scope is not a valid grant: ${checked.reason}` };
  return { ok: true, payload: checked.value };
}

// ---------------------------------------------------------------------------
// Diff vs the grant in force
// ---------------------------------------------------------------------------

const MODE_RANK: Readonly<Record<BudgetMode, number>> = { reserve: 0, balanced: 1, 'all-in': 2 };

function list(values: readonly string[]): string {
  return values.length ? values.join(', ') : 'none';
}

function setDiff(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  const b = new Set(before.map((v) => v.toLowerCase()));
  const a = new Set(after.map((v) => v.toLowerCase()));
  return { added: after.filter((v) => !b.has(v.toLowerCase())), removed: before.filter((v) => !a.has(v.toLowerCase())) };
}

function days(g: Pick<StandingGrantV1, 'issuedAt' | 'expiresAt'>): number {
  return Math.round((Date.parse(g.expiresAt) - Date.parse(g.issuedAt)) / DAY_MS);
}

function seatPolicyDiff(current: StandingGrantV1 | null, next: StandingGrantV1): GrantDiffLine[] {
  const lines: GrantDiffLine[] = [];
  const beforeSeats = current?.spend.seats ?? {};
  for (const id of new Set([...Object.keys(beforeSeats), ...Object.keys(next.spend.seats)])) {
    const before = beforeSeats[id];
    const after = next.spend.seats[id];
    const enabled = (seat: StandingGrantSeat | undefined): string => seat ? seat.enabled ? 'Enabled' : 'Disabled' : 'Not granted';
    const reserve = (seat: StandingGrantSeat | undefined): string => seat ? `${seat.reserveFloorPercent}%` : 'Not granted';
    const session = (seat: StandingGrantSeat | undefined): string => seat ? seat.maxSessionWindowPercent === undefined ? 'No session ceiling' : `${seat.maxSessionWindowPercent}%` : 'Not granted';
    if (!before || !after || before.enabled !== after.enabled) lines.push({ field: 'seat-enabled', label: `${id}: autonomy`, before: enabled(before), after: enabled(after), direction: after?.enabled ? 'wider' : 'narrower' });
    if (!before || !after || setDiff(before.roles, after.roles).added.length > 0 || setDiff(before.roles, after.roles).removed.length > 0) lines.push({ field: 'seat-roles', label: `${id}: roles`, before: before ? list(before.roles) : 'Not granted', after: after ? list(after.roles) : 'Not granted', direction: after && (!before || after.roles.some((role) => !before.roles.includes(role))) ? 'wider' : 'narrower' });
    if (!before || !after || before.reserveFloorPercent !== after.reserveFloorPercent) lines.push({ field: 'seat-reserve', label: `${id}: reserve`, before: reserve(before), after: reserve(after), direction: after && (!before || after.reserveFloorPercent < before.reserveFloorPercent) ? 'wider' : 'narrower' });
    if (!before || !after || before.maxSessionWindowPercent !== after.maxSessionWindowPercent) lines.push({ field: 'seat-session', label: `${id}: session ceiling`, before: session(before), after: session(after), direction: after && (!before || (after.maxSessionWindowPercent ?? Infinity) > (before.maxSessionWindowPercent ?? Infinity)) ? 'wider' : 'narrower' });
  }
  return lines;
}

/**
 * PURE: what signing `next` changes compared with `current` (null = no grant
 * in force: everything is new, so every line is `wider`). Empty = the same
 * scope (a plain renewal still moves the expiry, which is reported).
 */
export function grantScopeDiff(current: StandingGrantV1 | null, next: StandingGrantV1): GrantDiffLine[] {
  const out: GrantDiffLine[] = seatPolicyDiff(current, next);
  if (!current) {
    out.push({ field: 'repos', label: 'Repositories', before: 'no grant', after: list(next.repos.map((r) => r.nameWithOwner)), direction: 'wider' });
    out.push({ field: 'engines', label: 'Engines', before: 'no grant', after: list(next.engines), direction: 'wider' });
    out.push({ field: 'leader', label: 'Leader classes', before: 'no grant', after: list(next.leader.classes), direction: 'wider' });
    for (const stage of next.rollout.stages) out.push({ field: 'stage-leader', label: `${stage.id}: Leader permissions`, before: 'no grant', after: list(stage.leaderClasses), direction: stage.leaderClasses.length ? 'wider' : 'changed' });
    out.push({ field: 'spend-mode', label: 'Budget up to', before: 'no grant', after: next.spend.maxMode, direction: 'wider' });
    out.push({ field: 'metered', label: 'Metered APIs', before: 'no grant', after: `$${next.spend.meteredUsdPerDay}/day`, direction: next.spend.meteredUsdPerDay > 0 ? 'wider' : 'changed' });
    out.push({ field: 'merge-caps', label: 'Merge volume', before: 'no grant', after: `${volumeLimitLabel(next.merge.maxFiles)} files / ${volumeLimitLabel(next.merge.maxLines)} lines`, direction: 'wider' });
    out.push({ field: 'volume-policy', label: 'Local volume limits', before: 'no grant', after: next.merge.volumePolicy === 'operator-signed' ? 'Use signed repo/size limits for all models and enforcement modes' : 'Legacy 4 files / 150 lines; local enforcement 4 merges/day', direction: 'wider' });
    out.push({ field: 'expiry', label: 'Valid for', before: 'no grant', after: `${days(next)} days`, direction: 'changed' });
    return out;
  }
  const repos = setDiff(current.repos.map((r) => r.nameWithOwner), next.repos.map((r) => r.nameWithOwner));
  if (repos.added.length) out.push({ field: 'repos', label: 'Repositories added', before: '—', after: list(repos.added), direction: 'wider' });
  if (repos.removed.length) out.push({ field: 'repos', label: 'Repositories removed', before: list(repos.removed), after: '—', direction: 'narrower' });
  for (const repo of next.repos) {
    const was = current.repos.find((r) => r.nameWithOwner.toLowerCase() === repo.nameWithOwner.toLowerCase());
    if (was && was.stage !== repo.stage) {
      out.push({ field: 'repo-stage', label: `${repo.nameWithOwner} may`, before: was.stage, after: repo.stage, direction: repo.stage === 'merge' ? 'wider' : 'narrower' });
    }
  }
  const engines = setDiff(current.engines, next.engines);
  if (engines.added.length) out.push({ field: 'engines', label: 'Engines added', before: '—', after: list(engines.added), direction: 'wider' });
  if (engines.removed.length) out.push({ field: 'engines', label: 'Engines removed', before: list(engines.removed), after: '—', direction: 'narrower' });
  const leader = setDiff(current.leader.classes, next.leader.classes);
  if (leader.added.length || leader.removed.length) {
    out.push({ field: 'leader', label: 'Leader classes', before: list(current.leader.classes), after: list(next.leader.classes), direction: leader.added.length ? 'wider' : 'narrower' });
  }
  if (current.spend.maxMode !== next.spend.maxMode) {
    out.push({ field: 'spend-mode', label: 'Budget up to', before: current.spend.maxMode, after: next.spend.maxMode, direction: MODE_RANK[next.spend.maxMode] > MODE_RANK[current.spend.maxMode] ? 'wider' : 'narrower' });
  }
  if (current.spend.meteredUsdPerDay !== next.spend.meteredUsdPerDay) {
    out.push({ field: 'metered', label: 'Metered APIs', before: `$${current.spend.meteredUsdPerDay}/day`, after: `$${next.spend.meteredUsdPerDay}/day`, direction: next.spend.meteredUsdPerDay > current.spend.meteredUsdPerDay ? 'wider' : 'narrower' });
  }
  if (current.merge.maxFiles !== next.merge.maxFiles || current.merge.maxLines !== next.merge.maxLines) {
    const wider = next.merge.maxFiles > current.merge.maxFiles || next.merge.maxLines > current.merge.maxLines;
    out.push({ field: 'merge-caps', label: 'Merge size', before: `${volumeLimitLabel(current.merge.maxFiles)} files / ${volumeLimitLabel(current.merge.maxLines)} lines`, after: `${volumeLimitLabel(next.merge.maxFiles)} files / ${volumeLimitLabel(next.merge.maxLines)} lines`, direction: wider ? 'wider' : 'narrower' });
  }
  if (current.merge.volumePolicy !== next.merge.volumePolicy) {
    out.push({ field: 'volume-policy', label: 'Local volume limits', before: current.merge.volumePolicy === 'operator-signed' ? 'Use signed repo/size limits' : 'Legacy 4 files / 150 lines; local enforcement 4 merges/day', after: next.merge.volumePolicy === 'operator-signed' ? 'Use signed repo/size limits for all models and enforcement modes; risk/CI unchanged' : 'Legacy local limits', direction: next.merge.volumePolicy ? 'wider' : 'narrower' });
  }
  for (const repo of next.repos) {
    const before = current.repos.find((r) => r.nameWithOwner.toLowerCase() === repo.nameWithOwner.toLowerCase());
    if (before && before.maxMergesPerDay !== repo.maxMergesPerDay) out.push({ field: 'merge-frequency', label: `${repo.nameWithOwner} merges/day`, before: volumeLimitLabel(before.maxMergesPerDay), after: volumeLimitLabel(repo.maxMergesPerDay), direction: repo.maxMergesPerDay > before.maxMergesPerDay ? 'wider' : 'narrower' });
  }
  if (current.conductorGoals !== next.conductorGoals) {
    out.push({ field: 'conductor', label: 'Goal conductor', before: current.conductorGoals ? 'live' : 'dry run', after: next.conductorGoals ? 'live' : 'dry run', direction: next.conductorGoals ? 'wider' : 'narrower' });
  }
  for (const stage of next.rollout.stages) {
    const before = current.rollout.stages.find((s) => s.id === stage.id);
    const classes = setDiff(before?.leaderClasses ?? [], stage.leaderClasses);
    if (classes.added.length || classes.removed.length) out.push({ field: 'stage-leader', label: `${stage.id}: Leader permissions`, before: before ? list(before.leaderClasses) : 'not granted at this stage', after: list(stage.leaderClasses), direction: classes.added.length ? 'wider' : 'narrower' });
    if (before && (before.maxFiles !== stage.maxFiles || before.maxLines !== stage.maxLines || before.maxMergesPerRepoPerDay !== stage.maxMergesPerRepoPerDay)) {
      const label = (s: typeof stage): string => `${volumeLimitLabel(s.maxFiles)} files / ${volumeLimitLabel(s.maxLines)} lines / ${volumeLimitLabel(s.maxMergesPerRepoPerDay)} merges/repo/day`;
      const wider = stage.maxFiles > before.maxFiles || stage.maxLines > before.maxLines || stage.maxMergesPerRepoPerDay > before.maxMergesPerRepoPerDay;
      out.push({ field: 'stage-volume', label: `${stage.id} volume`, before: label(before), after: label(stage), direction: wider ? 'wider' : 'narrower' });
    }
  }
  const beforeLadder = current.rollout.stages.map((s) => s.id);
  const afterLadder = next.rollout.stages.map((s) => s.id);
  if (beforeLadder.join('>') !== afterLadder.join('>')) {
    out.push({ field: 'ladder', label: 'Ladder', before: beforeLadder.join(' → '), after: afterLadder.join(' → '), direction: 'changed' });
  }
  if (current.expiresAt !== next.expiresAt) {
    out.push({ field: 'expiry', label: 'Expires', before: current.expiresAt.slice(0, 10), after: `${next.expiresAt.slice(0, 10)} (${days(next)} days)`, direction: 'changed' });
  }
  return out;
}
