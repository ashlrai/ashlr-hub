/**
 * routes/verse/mobile/screens/new-agent-model.ts — the pure decisions behind
 * the phone's New agent screen: which repos lead the list, which seats can
 * take a turn (and why not), what each selected seat will run, and whether
 * Start may be pressed. No React, no fetch.
 *
 * Seat rules are the workbench's own (routes/verse/SeatSelector.tsx
 * `defaultSeatChoice` / `seatBlockedNote`), rebuilt here from the SAME pure
 * helpers — core/verse/seat-readiness.ts and verse-model.ts — because
 * importing SeatSelector.tsx would drag the desktop composer's stylesheet and
 * context model into this screen's chunk. A seat the engine would refuse is
 * never a default and cannot be chosen; its row says why and where to go.
 *
 * Remembering the last seat per repo (verse-ui-store `lastVerseSeat`) is
 * deliberately NOT used: that store lives in localStorage and pulls the
 * workbench shell, and the phone keeps nothing on the device. The last-used
 * repo is derived from the sessions the Mac already lists instead.
 */
import { rankSeatAlternatives, seatBlock } from '../../../../../core/verse/seat-readiness.js';
import type { VerseModelOption, VerseProject, VerseSeat, VerseSession } from '../../../../data/api-types.js';
import { firstRunnableModel, groupSeats, seatUnavailableReason } from '../../verse-model.js';

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

/** Newest session activity per project path (ms since epoch). */
function lastUsedByPath(sessions: readonly VerseSession[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of sessions) {
    const t = Date.parse(s.updatedAt);
    if (!Number.isFinite(t)) continue;
    if (t > (out.get(s.projectPath) ?? -Infinity)) out.set(s.projectPath, t);
  }
  return out;
}

/**
 * The repo list as the picker shows it: filtered by `query` (name or path,
 * case-insensitive), enrolled repos first, then the most recently used, then
 * by name.
 */
export function orderProjects(projects: readonly VerseProject[], sessions: readonly VerseSession[], query = ''): VerseProject[] {
  const used = lastUsedByPath(sessions);
  const q = query.trim().toLowerCase();
  const matches = q ? projects.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)) : [...projects];
  return matches.sort((a, b) => {
    if (a.enrolled !== b.enrolled) return a.enrolled ? -1 : 1;
    const ua = used.get(a.path) ?? -Infinity;
    const ub = used.get(b.path) ?? -Infinity;
    if (ua !== ub) return ub - ua;
    return a.name.localeCompare(b.name);
  });
}

/** The repo to preselect: the one used most recently, else the first in list order; null when there is none. */
export function defaultProjectPath(projects: readonly VerseProject[], sessions: readonly VerseSession[]): string | null {
  const used = lastUsedByPath(sessions);
  let best: { path: string; at: number } | null = null;
  for (const p of projects) {
    const at = used.get(p.path);
    if (at !== undefined && (best === null || at > best.at)) best = { path: p.path, at };
  }
  return best?.path ?? orderProjects(projects, sessions)[0]?.path ?? null;
}

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

/** Seats in the workbench's current engine order: Claude, Codex, Devin, Grok, local. */
export function orderSeats(seats: readonly VerseSeat[]): VerseSeat[] {
  return groupSeats(seats).flatMap((g) => g.seats);
}

/**
 * Why `seat` cannot take a turn right now, as a short phrase ("out of usage —
 * resets Fri 2:25 PM · try Grok"), or null when it can. The same three
 * refusals the workbench picker makes: the seat's health says unavailable,
 * the engine would refuse it (signed out / out of usage), or none of its
 * models can run on its pinned CLI.
 */
export function seatBlockedReason(seat: VerseSeat, seats: readonly VerseSeat[], now: number = Date.now()): string | null {
  const unavailable = seatUnavailableReason(seat);
  if (unavailable !== null) return unavailable;
  const block = seatBlock(seat, null, now);
  if (block !== null) {
    const phrase = block.reason
      .replace(`${seat.label} is `, '')
      .replace(/ to use this seat\.$/, '')
      .replace(/\.$/, '');
    const best = rankSeatAlternatives(seat.id, seats, null, now)[0];
    const bestLabel = best === undefined ? null : seats.find((s) => s.id === best)?.label ?? null;
    return bestLabel === null ? phrase : `${phrase} · try ${bestLabel}`;
  }
  if (firstRunnableModel(seat) === null) return 'no model this seat can run';
  return null;
}

/** The first seat (in engine order) that can take a turn; null when none can. */
export function defaultSeatId(seats: readonly VerseSeat[], now: number = Date.now()): string | null {
  return orderSeats(seats).find((s) => seatBlockedReason(s, seats, now) === null)?.id ?? null;
}

/** The option's text in the model select: its label, and why it cannot run when it cannot. */
export function modelOptionText(model: VerseModelOption): string {
  return model.unavailableReason ? `${model.label} — ${model.unavailableReason}` : model.label;
}

// ---------------------------------------------------------------------------
// The plan Start carries out
// ---------------------------------------------------------------------------

export interface SpawnTarget {
  seatId: string;
  seatLabel: string;
  /** The model id to create the session with. */
  model: string;
}

export interface SpawnInput {
  seats: readonly VerseSeat[];
  /** Selected seats in the order they were chosen; the first is the primary. */
  seatIds: readonly string[];
  /** The model chosen for the primary seat; null = its default runnable model. */
  primaryModel: string | null;
  now?: number;
}

/**
 * One target per selected seat that can run: the primary seat with the model
 * the operator chose (when that model can run), every other seat with its own
 * first runnable model. Blocked or unknown seats are dropped — they cannot be
 * selected, and a stale selection must not reach the server.
 */
export function spawnPlan({ seats, seatIds, primaryModel, now = Date.now() }: SpawnInput): SpawnTarget[] {
  const out: SpawnTarget[] = [];
  seatIds.forEach((id, index) => {
    const seat = seats.find((s) => s.id === id);
    if (!seat || seatBlockedReason(seat, seats, now) !== null) return;
    const chosen = index === 0 && primaryModel ? seat.models.find((m) => m.id === primaryModel && !m.unavailableReason) : undefined;
    const model = chosen ?? firstRunnableModel(seat);
    if (!model) return;
    if (out.some((t) => t.seatId === seat.id)) return;
    out.push({ seatId: seat.id, seatLabel: seat.label, model: model.id });
  });
  return out;
}

/** Why Start cannot be pressed yet, in the order the operator fills the form; null = ready. */
export function startBlocker(input: { projectPath: string | null; plan: readonly SpawnTarget[]; prompt: string }): string | null {
  if (!input.projectPath) return 'Choose a repo.';
  if (input.plan.length === 0) return 'Choose a seat that can run.';
  if (!input.prompt.trim()) return 'Say what the agent should do.';
  return null;
}

/** "Claude", "Claude and Codex", "Claude, Codex and Grok". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The confirmation's body for a multi-seat start. */
export function spawnConsequences(plan: readonly SpawnTarget[], repoName: string): string {
  return `Starts ${plan.length} agents on ${joinNames(plan.map((t) => t.seatLabel))} in ${repoName}; each spends from its own seat.`;
}

export interface SpawnResult {
  target: SpawnTarget;
  /** The chat that was created (even when its first turn did not send); null when creation failed. */
  sessionId: string | null;
  /** Why this seat did not start, in the server's words; null on success. */
  error: string | null;
}

/** The toast after a start where some seats failed: which, and why. */
export function partialFailureText(results: readonly SpawnResult[]): string {
  const failed = results.filter((r) => r.error !== null);
  const started = results.length - failed.length;
  const why = failed.map((r) => `${r.target.seatLabel}: ${r.error}`).join(' ');
  return `Started ${started} of ${results.length} agents. ${why}`.trim();
}
