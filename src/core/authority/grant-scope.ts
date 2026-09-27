/**
 * grant-scope.ts — Mason edits a grant DRAFT's scope before he signs it
 * (3.15, the Fleet control surface's grant editor).
 *
 * WHAT THIS IS. The server drafts a StandingGrantV1 (verse/authority-api.ts
 * `buildStandingGrantDraft`); the Touch ID sheet now lets Mason change its
 * scope — which repos, which engines, the Leader's classes, the spend caps,
 * how many days — and shows a diff against the grant in force before he signs.
 * This module is the PURE edit and the PURE diff.
 *
 * WHY IT CANNOT RAISE ANYTHING BY ITSELF. An edited draft is still only a
 * draft: it is signed by the custody helper under Touch ID (which shows the
 * scope again in its own prompt), and both the helper and the verifier
 * re-check it against the compiled ceilings (STANDING_GRANT_CEILINGS). The
 * edit can only CHOOSE within what the server drafted:
 *   - repos: a subset of the draft's repos (the enrolled repos + the canary);
 *   - engines: a subset of the draft's engines plus the four fleet lanes —
 *     never `devin` unless the draft already named it (the helper may not
 *     sign it; authority-api decides that);
 *   - leader classes: a subset of A, B;
 *   - spend: mode and metered dollars inside the ceilings;
 *   - days: 1..30.
 * Every rung of the ladder is narrowed to match (a stage may never name what
 * the grant does not), and the result is re-parsed by the same strict parser
 * the verifier uses — an invalid edit is refused, never "fixed up".
 */
import { BUDGET_MODES, type BudgetMode } from '../routing/types.js';
import { engineOfSeatId } from '../routing/policy.js';
import { FLEET_ENGINES, DEVIN_GRANT_ENGINE, type GrantEngine } from '../fleet/fleet-types.js';
import { parseStandingGrantPayload } from './standing-grant.js';
import { STANDING_GRANT_CEILINGS, type LeaderGrantClass, type StandingGrantV1 } from './types.js';

/** What the grant editor sends. Every field is optional: absent = keep the draft's. */
export interface GrantScopeEdit {
  /** nameWithOwner, a subset of the draft's repos. */
  repos?: string[];
  engines?: GrantEngine[];
  leaderClasses?: LeaderGrantClass[];
  maxMode?: BudgetMode;
  /** Integer USD/day for metered APIs, 0..STANDING_GRANT_CEILINGS.maxMeteredUsdPerDay. */
  meteredUsdPerDay?: number;
  /** 1..30. */
  days?: number;
  conductorGoals?: boolean;
}

export const GRANT_SCOPE_EDIT_KEYS: readonly (keyof GrantScopeEdit)[] = Object.freeze([
  'repos', 'engines', 'leaderClasses', 'maxMode', 'meteredUsdPerDay', 'days', 'conductorGoals',
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
  return { ok: true, edit };
}

/** PURE: the engines an edit may choose from, given the server's draft. */
export function editableEngines(draft: Pick<StandingGrantV1, 'engines'>): GrantEngine[] {
  const out: GrantEngine[] = [...FLEET_ENGINES];
  if (draft.engines.includes(DEVIN_GRANT_ENGINE)) out.push(DEVIN_GRANT_ENGINE);
  // Any engine a newer draft names (e.g. a lane this build does not list yet) stays choosable.
  for (const engine of draft.engines) if (!out.includes(engine)) out.push(engine);
  return out;
}

/** PURE: apply `edit` to the server's draft. Refuses (never repairs) an invalid result. */
export function applyGrantScopeEdit(draft: StandingGrantV1, edit: GrantScopeEdit): GrantScopeEditResult {
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

  if (edit.maxMode !== undefined) next.spend = { ...next.spend, maxMode: edit.maxMode };
  if (edit.meteredUsdPerDay !== undefined) next.spend = { ...next.spend, meteredUsdPerDay: edit.meteredUsdPerDay };
  if (edit.conductorGoals !== undefined) next.conductorGoals = edit.conductorGoals;
  if (edit.days !== undefined) {
    const issued = Date.parse(next.issuedAt);
    if (!Number.isFinite(issued)) return { ok: false, reason: 'the draft has no issue time' };
    next.expiresAt = new Date(issued + Math.min(edit.days * DAY_MS, STANDING_GRANT_CEILINGS.maxTtlMs)).toISOString();
  }

  const checked = parseStandingGrantPayload(next);
  if (!checked.ok) return { ok: false, reason: `that scope is not a valid grant: ${checked.reason}` };
  return { ok: true, payload: checked.value };
}

// ---------------------------------------------------------------------------
// Diff vs the grant in force
// ---------------------------------------------------------------------------

/** `wider` raises authority, `narrower` lowers it, `changed` is neither (e.g. a new expiry). */
export type GrantDiffDirection = 'wider' | 'narrower' | 'changed';

export interface GrantDiffLine {
  field: 'repos' | 'repo-stage' | 'engines' | 'leader' | 'spend-mode' | 'metered' | 'expiry' | 'conductor' | 'ladder' | 'merge-caps';
  label: string;
  before: string;
  after: string;
  direction: GrantDiffDirection;
}

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

/**
 * PURE: what signing `next` changes compared with `current` (null = no grant
 * in force: everything is new, so every line is `wider`). Empty = the same
 * scope (a plain renewal still moves the expiry, which is reported).
 */
export function grantScopeDiff(current: StandingGrantV1 | null, next: StandingGrantV1): GrantDiffLine[] {
  const out: GrantDiffLine[] = [];
  if (!current) {
    out.push({ field: 'repos', label: 'Repositories', before: 'no grant', after: list(next.repos.map((r) => r.nameWithOwner)), direction: 'wider' });
    out.push({ field: 'engines', label: 'Engines', before: 'no grant', after: list(next.engines), direction: 'wider' });
    out.push({ field: 'leader', label: 'Leader classes', before: 'no grant', after: list(next.leader.classes), direction: 'wider' });
    out.push({ field: 'spend-mode', label: 'Budget up to', before: 'no grant', after: next.spend.maxMode, direction: 'wider' });
    out.push({ field: 'metered', label: 'Metered APIs', before: 'no grant', after: `$${next.spend.meteredUsdPerDay}/day`, direction: next.spend.meteredUsdPerDay > 0 ? 'wider' : 'changed' });
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
    out.push({ field: 'merge-caps', label: 'Merge size', before: `${current.merge.maxFiles} files / ${current.merge.maxLines} lines`, after: `${next.merge.maxFiles} files / ${next.merge.maxLines} lines`, direction: wider ? 'wider' : 'narrower' });
  }
  if (current.conductorGoals !== next.conductorGoals) {
    out.push({ field: 'conductor', label: 'Goal conductor', before: current.conductorGoals ? 'live' : 'dry run', after: next.conductorGoals ? 'live' : 'dry run', direction: next.conductorGoals ? 'wider' : 'narrower' });
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
