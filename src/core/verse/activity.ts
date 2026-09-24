/**
 * core/verse/activity.ts — "what is happening across the whole workbench,
 * right now?" in one in-memory read (V3.10, unit C1; wire shape
 * workbench-types.ts §3, route activity-api.ts).
 *
 * Three consumers poll it: the rail badges and the Needs-you drawer (the
 * page, every 5 s), and the desktop shell (C8's Rust, every 5 s — 30 s while
 * hidden) for native notifications and the dock badge. So the budget is
 * strict: < 5 ms, never blocking, never spawning (SPEC-310C budgets).
 * Everything below is either a pure fold over state already in memory or a
 * cache refreshed OFF the request's stack:
 *
 *   running      engine.listSessions() (in-memory after the store's first
 *                scan) + C3's `peekLiveStatus` when the engine has it
 *   completions  C3's `turnEndsSince` ring when the engine has it; until then
 *                a snapshot DIFF of the session list (TurnEndTracker below)
 *   needsYou     approvals (an incremental, async inbox scan — never on the
 *                request stack), chats (failed + unread, and C3's held
 *                follow-up queues via `queueNeedsYou`), accounts (A2's
 *                cached sweep) and Track B's producers (R1, lazily imported)
 *   badges       autonomy (B-U1), capacity (A2's fused seats), mind (B-U8)
 *
 * HONESTY (docs/VERSE-TELEMETRY-V2.md): a producer that has not landed is
 * `unavailable`, one that throws or returns malformed items is `error`, and
 * the drawer must not say "All clear" for a split whose source is not `ok`.
 * Null means unknown — never zero, never "healthy".
 *
 * NODE-ONLY. No model call, no spend, no secret: seat reports carry reasons
 * already scrubbed by A2; session errors are scrubbed here before they leave.
 */
import { randomBytes } from 'node:crypto';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { inboxDir } from '../inbox/store.js';
import { scrubSecrets } from '../util/scrub.js';
import type { SeatHealthReport } from './health-types.js';
import type { SessionMetaStore } from './session-meta.js';
import type { VerseSeat, VerseSession } from './types.js';
import {
  isNeedsYouItem,
  NEEDS_YOU_DETAIL_MAX,
  NEEDS_YOU_TITLE_MAX,
  VERSE_ACTIVITY_SEEN_PATH,
  VERSE_TURN_END_BUFFER,
  type NeedsYouAction,
  type NeedsYouItem,
  type NeedsYouSeverity,
  type NeedsYouSource,
  type PeekLiveStatus,
  type TurnEndsSince,
  type VerseActivityCompletion,
  type VerseActivityResponse,
  type VerseActivityRunning,
  type VerseActivitySources,
  type VerseAutonomyBadge,
  type VerseCapacityBadge,
  type VerseMindBadge,
  type VerseTurnEnd,
} from './workbench-types.js';

// ===========================================================================
// Inputs
// ===========================================================================

/**
 * The engine surface activity reads (the live one is `peekVerseEngine()`).
 * `peekLiveStatus` / `turnEndsSince` / `queueNeedsYou` are C3's engine
 * methods — OPTIONAL here so an older engine handle (or a test fake) still
 * conforms; without them activity degrades to what the session list says.
 * All three are in-memory reads (no I/O), which is what keeps this route
 * inside its budget.
 */
export interface ActivityEngine {
  listSessions(): VerseSession[];
  peekLiveStatus?: PeekLiveStatus;
  turnEndsSince?: TurnEndsSince;
  /** Held follow-up queues as `chats` / `queue-held` items (C3). */
  queueNeedsYou?: () => NeedsYouItem[];
}

/** Track B's producers (R1). `null` = the module has not landed in this build. */
export type NeedsYouProducerSource = 'authority' | 'fleet' | 'leader';
export type NeedsYouProducers = Record<NeedsYouProducerSource, (() => NeedsYouItem[]) | null>;
/**
 * A producer's own readiness (each module's `needsYouSourceState()`):
 * 'warming' = its first read has not landed yet, 'error' = it cannot vouch
 * for an answer, 'ok' = its items are the truth.
 */
export type NeedsYouSourceState = 'warming' | 'ok' | 'error';
export type NeedsYouProducerStates = Partial<Record<NeedsYouProducerSource, (() => NeedsYouSourceState) | null>>;

export interface ApprovalsView {
  state: 'ok' | 'unavailable' | 'error';
  /** Newest first, capped at ACTIVITY_MAX_APPROVAL_ITEMS. */
  items: NeedsYouItem[];
  /** Every pending proposal, including any past the cap (the badge count stays exact). */
  total: number;
}

export interface HealthView {
  seats: VerseSeat[];
  reports: SeatHealthReport[];
}

export interface ActivityDeps {
  engine: () => ActivityEngine | null;
  meta: SessionMetaStore;
  producers: () => NeedsYouProducers;
  /** Optional: producers that report readiness; one without it is judged by its items alone. */
  producerStates?: () => NeedsYouProducerStates;
  approvals: () => ApprovalsView;
  /** A2's fused seat view; null when the health service is not running. */
  health: () => HealthView | null;
  autonomy: () => VerseAutonomyBadge | null;
  /** B-U8's newest memo time; undefined = the Leader module has not landed. */
  latestMemoAt: (() => string | null) | null;
  now?: () => number;
}

// ===========================================================================
// Cursor
// ===========================================================================

/**
 * `v1.<boot>.<mode>.<seq>` — opaque to clients. `boot` changes with every
 * server process (the engine's seq restarts at 0), `mode` says whose seq it
 * is (`e` = C3's engine ring, `t` = this module's tracker), so a cursor from
 * another process or another mode resets completions instead of replaying or
 * skipping them.
 */
const CURSOR_RE = /^v1\.([0-9a-f]{8})\.([et])\.(\d{1,15})$/;

export interface ParsedCursor {
  boot: string;
  mode: 'e' | 't';
  seq: number;
}

export function parseActivityCursor(raw: string): ParsedCursor | null {
  const m = CURSOR_RE.exec(raw);
  if (!m) return null;
  return { boot: m[1]!, mode: m[2] as 'e' | 't', seq: Number(m[3]) };
}

export function formatActivityCursor(c: ParsedCursor): string {
  return `v1.${c.boot}.${c.mode}.${c.seq}`;
}

// ===========================================================================
// Turn-end tracker (fallback until C3's turnEndsSince lands)
// ===========================================================================

interface TrackedSession {
  status: VerseSession['status'];
  turnCount: number;
}

/**
 * Detects finished turns by diffing session snapshots between polls: a
 * session that was `running` and is not any more ended a turn; one whose
 * turnCount grew between two polls ended one without us ever seeing it run.
 *
 * WHAT IT CANNOT KNOW, stated rather than guessed: a Stop leaves the session
 * `idle`, exactly like a success, so a stopped turn reports `ok`; and a turn
 * that started and ended between polls has no duration (null). C3's engine
 * ring (`turnEndsSince`) replaces all of this with exact records. Duration is
 * always null here: "first seen running" is a poll time, not the turn's start,
 * and a number that looks exact but is not is worse than an honest unknown.
 */
export class TurnEndTracker {
  private sessions = new Map<string, TrackedSession>();
  private ends: VerseTurnEnd[] = [];
  private seq = 0;
  private primed = false;

  get head(): number {
    return this.seq;
  }

  observe(list: readonly VerseSession[], now: number): void {
    const seen = new Set<string>();
    for (const s of list) {
      seen.add(s.id);
      const prev = this.sessions.get(s.id);
      const running = s.status === 'running';
      if (prev && this.primed) {
        const stoppedRunning = prev.status === 'running' && !running;
        const grewUnseen = !running && s.turnCount > prev.turnCount && prev.status !== 'running';
        if (stoppedRunning || grewUnseen) {
          this.seq += 1;
          const at = Number.isFinite(Date.parse(s.updatedAt)) ? s.updatedAt : new Date(now).toISOString();
          this.ends.push({
            seq: this.seq,
            sessionId: s.id,
            turnId: `turn-${s.turnCount}`,
            outcome: s.status === 'error' ? 'failed' : 'ok',
            at,
            durationMs: null,
            turnCount: s.turnCount,
          });
          if (this.ends.length > VERSE_TURN_END_BUFFER) this.ends.splice(0, this.ends.length - VERSE_TURN_END_BUFFER);
        }
      }
      this.sessions.set(s.id, { status: s.status, turnCount: s.turnCount });
    }
    for (const id of [...this.sessions.keys()]) if (!seen.has(id)) this.sessions.delete(id);
    // The first observation is the baseline: history is not "new".
    this.primed = true;
  }

  since(cursor: number): { cursor: number; ends: VerseTurnEnd[] } {
    return { cursor: this.seq, ends: this.ends.filter((e) => e.seq > cursor) };
  }
}

// ===========================================================================
// Text helpers
// ===========================================================================

function clip(text: string, max: number): string {
  // Control characters are exactly what must go: a title is one line in a
  // native notification and a drawer row, never a terminal escape.
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function titleOf(session: Pick<VerseSession, 'title'>): string {
  const t = clip(session.title ?? '', 80);
  return t.length > 0 ? t : 'Untitled chat';
}

const SEVERITY_RANK: Record<NeedsYouSeverity, number> = { high: 0, warn: 1, info: 2 };

/** Most urgent first: severity, then the soonest to expire, then the newest. */
export function compareNeedsYou(a: NeedsYouItem, b: NeedsYouItem): number {
  const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (sev !== 0) return sev;
  const ea = a.expiresAt ? Date.parse(a.expiresAt) : Number.POSITIVE_INFINITY;
  const eb = b.expiresAt ? Date.parse(b.expiresAt) : Number.POSITIVE_INFINITY;
  if (ea !== eb) return ea - eb;
  const sa = Date.parse(a.since);
  const sb = Date.parse(b.since);
  if (sa !== sb) return sb - sa;
  return a.id.localeCompare(b.id);
}

// ===========================================================================
// Chat + account items (C1's own producers)
// ===========================================================================

function chatFailedItems(sessions: readonly VerseSession[], meta: SessionMetaStore): NeedsYouItem[] {
  const out: NeedsYouItem[] = [];
  for (const s of sessions) {
    if (s.status !== 'error') continue;
    if (meta.isArchived(s.id) || !meta.isUnread(s)) continue;
    // The turnCount is part of the id: a chat that fails AGAIN after being
    // read is a new item (and a new native "Needs you"), not the old one.
    const withTurn = `chats:chat-failed:${s.id}@${s.turnCount}`;
    const id = withTurn.length <= 200 ? withTurn : `chats:chat-failed:${s.id}`.slice(0, 200);
    const done: NeedsYouAction = {
      kind: 'done',
      label: 'Mark read',
      request: { method: 'POST', path: VERSE_ACTIVITY_SEEN_PATH, body: { sessionId: s.id, turnCount: s.turnCount } },
      confirm: null,
      destructive: false,
    };
    out.push({
      id,
      source: 'chats',
      kind: 'chat-failed',
      severity: 'warn',
      title: clip(`Failed: ${titleOf(s)}`, NEEDS_YOU_TITLE_MAX),
      detail: s.lastError ? clip(scrubSecrets(s.lastError), NEEDS_YOU_DETAIL_MAX) : null,
      since: s.updatedAt,
      expiresAt: null,
      subject: { repo: basename(s.projectPath) || null, pr: null, seatId: s.seatId, sessionId: s.id, engine: s.engine },
      target: { kind: 'session', sessionId: s.id },
      actions: [done],
    });
  }
  return out;
}

function accountItems(view: HealthView, nowIso: string): NeedsYouItem[] {
  const labels = new Map(view.seats.map((s) => [s.id, s.label] as const));
  const out: NeedsYouItem[] = [];
  for (const report of view.reports) {
    if (report.engine === 'local') continue;
    const label = clip(labels.get(report.seatId) ?? report.seatId, 60);
    const since = report.checkedAt || nowIso;
    const detail = report.reasons.length > 0 ? clip(report.reasons.join(' · '), NEEDS_YOU_DETAIL_MAX) : null;
    const subject = { repo: null, pr: null, seatId: report.seatId, sessionId: null, engine: report.engine };
    if (report.connection === 'signed-out' || report.connection === 'expiring') {
      const signedOut = report.connection === 'signed-out';
      out.push({
        id: `accounts:reconnect:${report.seatId}`.slice(0, 200),
        source: 'accounts',
        kind: 'reconnect',
        severity: signedOut ? 'high' : 'warn',
        title: clip(signedOut ? `${label} is signed out` : `${label} sign-in expires soon`, NEEDS_YOU_TITLE_MAX),
        detail,
        since,
        expiresAt: signedOut ? null : report.credentialExpiresAt,
        subject,
        target: { kind: 'seat', seatId: report.seatId },
        actions: [
          {
            kind: 'fix',
            label: 'Reconnect',
            request: { method: 'POST', path: '/api/verse/health/reconnect', body: { seatId: report.seatId } },
            confirm: {
              title: `Open the sign-in for ${label}?`,
              body: "Opens the seat's own login in Terminal. Verse never sees or stores the credential.",
              confirmLabel: 'Open sign-in',
            },
            destructive: false,
          },
        ],
      });
    } else if (report.connection === 'binary-skew') {
      out.push({
        id: `accounts:repin:${report.seatId}`.slice(0, 200),
        source: 'accounts',
        kind: 'repin',
        severity: 'warn',
        title: clip(
          report.cliVersion && report.newestCliVersion
            ? `${label} runs CLI ${report.cliVersion}; ${report.newestCliVersion} is installed`
            : `${label} is pinned to an older CLI`,
          NEEDS_YOU_TITLE_MAX,
        ),
        detail,
        since,
        expiresAt: null,
        subject,
        // Re-pinning runs a terminal command; the drawer opens Apps & Accounts
        // where the command is shown (never run from a web click).
        target: { kind: 'section', section: 'apps', anchor: `seat:${report.seatId}`.slice(0, 200) },
        actions: [{ kind: 'fix', label: 'Show fix', request: null, confirm: null, destructive: false }],
      });
    }
  }
  return out;
}

const WINDOW_NAMES: Readonly<Record<string, string>> = {
  five_hour: '5h',
  seven_day: 'weekly',
  seven_day_opus: 'weekly (Opus)',
  seven_day_sonnet: 'weekly (Sonnet)',
};

function friendlyWindow(id: string): string {
  if (WINDOW_NAMES[id]) return WINDOW_NAMES[id]!;
  if (/primary/i.test(id)) return '5h';
  if (/secondary|weekly|week/i.test(id)) return 'weekly';
  return id.replace(/_/g, ' ');
}

/** The scarcest native seat: the highest binding-window percent actually reported. */
export function scarcestSeat(seats: readonly VerseSeat[]): VerseCapacityBadge | null {
  let best: VerseCapacityBadge | null = null;
  for (const seat of seats) {
    if (seat.engine === 'local') continue;
    const binding = seat.capacity?.binding;
    if (!binding || binding.usedPercent === null || !Number.isFinite(binding.usedPercent)) continue;
    const used = Math.max(0, Math.min(100, binding.usedPercent));
    if (best && best.usedPercent >= used) continue;
    best = {
      seatId: seat.id,
      engine: seat.engine,
      label: clip(seat.label, 60),
      usedPercent: used,
      window: friendlyWindow(binding.id),
      resetsAt: binding.resetsAt,
    };
  }
  return best;
}

// ===========================================================================
// The fold
// ===========================================================================

export interface ActivityBuild {
  response: VerseActivityResponse;
  /** Items dropped at the producer boundary (malformed), per source — for tests and logs. */
  dropped: Partial<Record<NeedsYouSource, number>>;
}

export interface ActivityReader {
  readonly bootId: string;
  build(since: ParsedCursor | null): ActivityBuild;
}

export function createActivityReader(deps: ActivityDeps, bootId: string = randomBytes(4).toString('hex')): ActivityReader {
  const now = deps.now ?? Date.now;
  const tracker = new TurnEndTracker();
  // Account items + capacity come from A2's fused view, which reads telemetry
  // files; it changes on a minutes scale, so a 5 s memo keeps activity inside
  // its budget on every poll after the first.
  let healthMemo: { at: number; items: NeedsYouItem[]; capacity: VerseCapacityBadge | null; ok: boolean } | null = null;

  function healthPart(nowMs: number): { items: NeedsYouItem[]; capacity: VerseCapacityBadge | null; ok: boolean } {
    if (healthMemo && nowMs - healthMemo.at < 5_000) return healthMemo;
    let view: HealthView | null = null;
    try { view = deps.health(); } catch { view = null; }
    healthMemo = view
      ? { at: nowMs, items: accountItems(view, new Date(nowMs).toISOString()), capacity: scarcestSeat(view.seats), ok: true }
      : { at: nowMs, items: [], capacity: null, ok: false };
    return healthMemo;
  }

  return {
    bootId,
    build(since) {
      const nowMs = now();
      const nowIso = new Date(nowMs).toISOString();
      const engine = deps.engine();
      const sessions = engine ? engine.listSessions() : [];
      const byId = new Map(sessions.map((s) => [s.id, s] as const));
      const dropped: Partial<Record<NeedsYouSource, number>> = {};
      // Before any unread question: fix the baseline into existing chats so a
      // resumed old chat never lights up all its history (session-meta.ts).
      if (engine) {
        try { deps.meta.seedBaseline(sessions); } catch { /* read state then falls back to the implied baseline */ }
      }

      // ── running ─────────────────────────────────────────────────────────
      const running: VerseActivityRunning[] = [];
      for (const s of sessions) {
        if (s.status !== 'running') continue;
        let live: VerseActivityRunning['live'] = null;
        let startedAt = s.updatedAt;
        if (engine?.peekLiveStatus) {
          try {
            const peek = engine.peekLiveStatus(s.id);
            if (peek) {
              startedAt = peek.startedAt;
              live = { phase: peek.phase, tool: peek.tool, elapsedMs: peek.elapsedMs, thinkingTail: peek.thinkingTail };
            }
          } catch {
            live = null;
          }
        }
        running.push({ sessionId: s.id, title: titleOf(s), engine: s.engine, seatId: s.seatId, startedAt, live });
      }
      running.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.sessionId.localeCompare(b.sessionId)));

      // ── completions ─────────────────────────────────────────────────────
      const mode: 'e' | 't' = engine?.turnEndsSince ? 'e' : 't';
      let head = 0;
      let ends: VerseTurnEnd[] = [];
      if (mode === 't') tracker.observe(sessions, nowMs);
      // A cursor from another process or mode is not an error: it resets to
      // "now" (completions empty), exactly like a first poll.
      const resume = since && since.boot === bootId && since.mode === mode ? since.seq : null;
      try {
        const read = mode === 'e' ? engine!.turnEndsSince!(resume ?? Number.MAX_SAFE_INTEGER) : tracker.since(resume ?? tracker.head);
        head = read.cursor;
        ends = resume === null ? [] : read.ends;
      } catch {
        head = resume ?? 0;
        ends = [];
      }
      const completions: VerseActivityCompletion[] = [];
      for (const end of ends) {
        const s = byId.get(end.sessionId);
        if (!s) continue; // deleted since: nothing to open
        completions.push({ sessionId: end.sessionId, title: titleOf(s), outcome: end.outcome, at: end.at, durationMs: end.durationMs });
      }

      // ── needs you ───────────────────────────────────────────────────────
      const sources: VerseActivitySources = {
        approvals: 'unavailable',
        authority: 'unavailable',
        fleet: 'unavailable',
        leader: 'unavailable',
        chats: engine ? 'ok' : 'unavailable',
        accounts: 'unavailable',
      };
      const items: NeedsYouItem[] = [];

      const approvals = deps.approvals();
      sources.approvals = approvals.state;
      items.push(...approvals.items);

      if (engine) items.push(...chatFailedItems(sessions, deps.meta));
      if (engine?.queueNeedsYou) {
        // Same boundary as Track B's producers: only well-formed `chats`
        // items get through (their action routes are POSTed with the token).
        try {
          const held = engine.queueNeedsYou();
          if (!Array.isArray(held)) throw new TypeError('not an array');
          let bad = 0;
          for (const item of held) {
            if (isNeedsYouItem(item) && item.source === 'chats') items.push(item);
            else bad += 1;
          }
          if (bad > 0) {
            dropped.chats = bad;
            sources.chats = 'error';
          }
        } catch {
          sources.chats = 'error';
        }
      }

      const health = healthPart(nowMs);
      sources.accounts = health.ok ? 'ok' : 'unavailable';
      items.push(...health.items);

      const producers = deps.producers();
      let states: NeedsYouProducerStates = {};
      try { states = deps.producerStates?.() ?? {}; } catch { states = {}; }
      for (const source of ['authority', 'fleet', 'leader'] as const) {
        const read = producers[source];
        if (!read) continue;
        // WHY THE STATE IS READ AFTER THE ITEMS: reading the items is what
        // schedules a producer's first load. A producer still 'warming'
        // answers [] (or throws "still loading"); either would otherwise
        // show as an all-clear or as a failure. It is 'unavailable' — the
        // drawer's "not answering yet", never a false all-clear.
        const stateOf = (): NeedsYouSourceState | null => {
          const probe = states[source];
          if (!probe) return null;
          try {
            const value = probe();
            return value === 'warming' || value === 'ok' || value === 'error' ? value : 'error';
          } catch {
            return 'error';
          }
        };
        try {
          const produced = read();
          if (!Array.isArray(produced)) throw new TypeError('not an array');
          let bad = 0;
          for (const item of produced) {
            // The boundary: a producer may only file items under its own
            // source, and only well-formed ones (isNeedsYouItem also pins
            // every action route to /api/ — the drawer POSTs them with the
            // mutation token).
            if (isNeedsYouItem(item) && item.source === source) items.push(item);
            else bad += 1;
          }
          if (bad > 0) dropped[source] = bad;
          const state = stateOf();
          sources[source] = bad > 0 || state === 'error' ? 'error' : state === 'warming' ? 'unavailable' : 'ok';
        } catch {
          sources[source] = stateOf() === 'warming' ? 'unavailable' : 'error';
        }
      }

      const unique = new Map<string, NeedsYouItem>();
      for (const item of items) if (!unique.has(item.id)) unique.set(item.id, item);
      const needsYou = [...unique.values()].sort(compareNeedsYou);

      // ── badges ──────────────────────────────────────────────────────────
      let autonomy: VerseAutonomyBadge | null = null;
      try { autonomy = deps.autonomy(); } catch { autonomy = null; }
      let mind: VerseMindBadge | null = null;
      if (deps.latestMemoAt) {
        try {
          const latest = deps.latestMemoAt();
          const seenAt = deps.meta.mindSeenAt();
          mind = {
            latestMemoAt: latest,
            unseen: latest !== null && (seenAt === null || Date.parse(latest) > Date.parse(seenAt)),
          };
        } catch {
          mind = null;
        }
      }

      let unread = 0;
      for (const s of sessions) {
        if (s.status === 'running' || deps.meta.isArchived(s.id)) continue;
        if (deps.meta.isUnread(s)) unread += 1;
      }

      return {
        dropped,
        response: {
          cursor: formatActivityCursor({ boot: bootId, mode, seq: head }),
          generatedAt: nowIso,
          running,
          needsYou,
          completions,
          // Approvals past the item cap still count: the badge must not under-report.
          counts: { running: running.length, needsYou: needsYou.length + Math.max(0, approvals.total - approvals.items.length), unread },
          sources,
          autonomy,
          capacity: health.capacity,
          mind,
        },
      };
    },
  };
}

// ===========================================================================
// Approvals: an incremental inbox scan, off the request stack
// ===========================================================================

/** The proposal fields the drawer row needs; everything else stays on disk. */
interface ProposalSummary {
  id: string;
  status: string;
  kind: string;
  title: string;
  summary: string;
  repo: string | null;
  riskClass: string | null;
  createdAt: string;
}

/** One pending proposal → one Needs-you item (approve / reject, both confirmed). */
export function approvalItem(p: ProposalSummary): NeedsYouItem {
  const repoName = p.repo ? basename(p.repo) : null;
  const where = repoName ?? 'the target repository';
  const reachesRemote = p.kind === 'pr';
  const consequence = reachesRemote
    ? `Pushes a branch to ${where}'s remote and opens a real pull request. Other people can see it immediately.`
    : p.kind === 'patch'
      ? `Writes the diff to ${where} on disk now. Nothing is pushed, but the working tree changes.`
      : `Applies this ${p.kind} proposal to ${where} now.`;
  const path = (verb: 'approve' | 'reject') => `/api/inbox/${encodeURIComponent(p.id)}/${verb}`;
  return {
    id: `approvals:approval:${p.id}`.slice(0, 200),
    source: 'approvals',
    kind: 'approval',
    severity: p.riskClass === 'high' ? 'high' : p.riskClass === 'medium' ? 'warn' : 'info',
    title: clip(`${p.kind === 'pr' ? 'PR' : p.kind}: ${p.title || 'Untitled proposal'}`, NEEDS_YOU_TITLE_MAX),
    detail: p.summary ? clip(scrubSecrets(p.summary), NEEDS_YOU_DETAIL_MAX) : null,
    since: p.createdAt,
    expiresAt: null,
    subject: { repo: repoName, pr: null, seatId: null, sessionId: null, engine: null },
    target: { kind: 'approval', proposalId: p.id },
    actions: [
      {
        kind: 'approve',
        label: 'Approve',
        request: { method: 'POST', path: path('approve'), body: {} },
        confirm: {
          title: `Approve this ${p.kind} against ${repoName ?? 'the repository'}?`,
          body: consequence,
          confirmLabel: reachesRemote ? 'Approve and open the pull request' : 'Approve and apply',
        },
        // Approve is the irreversible branch (routes/inbox/ConfirmDialog.tsx:
        // the weight goes on what cannot be undone, not on what sounds negative).
        destructive: true,
      },
      {
        kind: 'reject',
        label: 'Reject',
        request: { method: 'POST', path: path('reject'), body: {} },
        confirm: {
          title: 'Reject this proposal?',
          body: `Discards "${clip(p.title, 80)}". It stays in history as rejected and is never applied.`,
          confirmLabel: 'Reject',
        },
        destructive: false,
      },
    ],
  };
}

const PROPOSAL_ID_RE = /^[A-Za-z0-9._-]{1,160}$/;
const MAX_PROPOSAL_BYTES = 16 * 1024 * 1024;
/** The drawer shows this many approvals; `counts.needsYou` is still exact. */
export const ACTIVITY_MAX_APPROVAL_ITEMS = 200;

function summarize(raw: unknown, file: string): ProposalSummary | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = r['id'];
  if (typeof id !== 'string' || !PROPOSAL_ID_RE.test(id) || file !== `${id}.json`) return null;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const createdAt = str(r['createdAt']);
  if (!Number.isFinite(Date.parse(createdAt))) return null;
  return {
    id,
    status: str(r['status']),
    kind: str(r['kind']) || 'proposal',
    title: str(r['title']),
    summary: str(r['summary']),
    repo: typeof r['repo'] === 'string' ? r['repo'] : null,
    riskClass: typeof r['riskClass'] === 'string' ? r['riskClass'] : null,
    createdAt: new Date(Date.parse(createdAt)).toISOString(),
  };
}

interface CachedFile {
  mtimeMs: number;
  size: number;
  summary: ProposalSummary | null;
}

/**
 * Pending proposals, kept current by an ASYNC rescan at most every
 * `intervalMs` and only when the inbox directory changed (proposal writes are
 * atomic renames, which bump the directory's mtime). Only files whose mtime
 * or size moved are re-read. The request path only ever reads the last
 * result — `snapshot()` is O(pending).
 */
export class ApprovalsScanner {
  private files = new Map<string, CachedFile>();
  private items: NeedsYouItem[] = [];
  private total = 0;
  private state: ApprovalsView['state'] = 'unavailable';
  private lastScan = 0;
  private dirMtime = -1;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly dir: () => string = inboxDir,
    private readonly intervalMs = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  snapshot(): ApprovalsView {
    if (this.now() - this.lastScan >= this.intervalMs) void this.refresh();
    return { state: this.state, items: this.items, total: this.total };
  }

  /** Start (or join) a scan; resolves when it has finished. Never rejects. */
  refresh(): Promise<void> {
    if (!this.inFlight) {
      this.lastScan = this.now();
      this.inFlight = this.scan()
        .catch(() => { this.state = 'error'; })
        .finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  private async scan(): Promise<void> {
    const dir = this.dir();
    let dirStat;
    try {
      dirStat = await lstat(dir);
    } catch {
      // No inbox yet: nothing is waiting, and that is a real answer.
      this.files.clear();
      this.items = [];
      this.total = 0;
      this.state = 'ok';
      return;
    }
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
      this.state = 'error';
      return;
    }
    if (dirStat.mtimeMs === this.dirMtime && this.state === 'ok') return;
    const names = (await readdir(dir)).filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'));
    const next = new Map<string, CachedFile>();
    for (const name of names) {
      const full = join(dir, name);
      let st;
      try { st = await stat(full); } catch { continue; }
      if (!st.isFile() || st.size > MAX_PROPOSAL_BYTES) continue;
      const cached = this.files.get(name);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        next.set(name, cached);
        continue;
      }
      let summary: ProposalSummary | null = null;
      try {
        summary = summarize(JSON.parse(await readFile(full, 'utf8')) as unknown, name);
      } catch {
        summary = null;
      }
      next.set(name, { mtimeMs: st.mtimeMs, size: st.size, summary });
    }
    this.files = next;
    this.dirMtime = dirStat.mtimeMs;
    const pending = [...next.values()]
      .map((f) => f.summary)
      .filter((s): s is ProposalSummary => s !== null && s.status === 'pending')
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id.localeCompare(b.id)));
    this.items = pending.slice(0, ACTIVITY_MAX_APPROVAL_ITEMS).map(approvalItem);
    this.total = pending.length;
    this.state = 'ok';
  }
}
