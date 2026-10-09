/**
 * The Leader line (3.15) — Mason's Telegram chat with a founder-operator
 * Leader that keeps him current without nagging and turns "go build X" into
 * real work on the spot.
 *
 * PROACTIVE (runLeaderLine, once per comms cycle, Telegram only)
 *   - Morning brief and evening recap at `comms.briefTimes` (default 08:00 /
 *     19:00, `comms.timeZone` default America/New_York): shipped, running,
 *     blockers, next moves, one question — with links (leader-brief.ts).
 *   - The day's self-improvement report (vision/leader-drive.ts), with
 *     Approve / Veto on any launch still inside its veto window.
 *   - Result pings for work Mason asked for ("PR is up", "failed: …").
 *   - Event pings only when they matter (a revert, a failed revert, the
 *     Leader down) — Jev's `decide` when present, deterministic otherwise.
 *
 * NEVER NAGS
 *   - Quiet hours (`comms.quietHours`, default 23:00–07:00 local): only
 *     urgent pings go out; everything else waits for the morning brief.
 *   - At most `comms.maxPingsPerDay` (default 6) proactive pings a day, and
 *     20 minutes between non-urgent ones. Briefs and replies do not count.
 *   - ONE question at a time: a Leader question is held until the previous
 *     one is answered (or 24 h pass), with Yes / No / Your call buttons when
 *     it is a yes/no question (gateThreadMessage, used by the thread drain).
 *
 * REACTIVE (routeLeaderText, from telegram-channel's converseWithLeader)
 *   status / update / what's up → an instant brief (recorded state; the model
 *   only for the narrative line, with a short timeout); "more" → the rest of
 *   the last long reply; approve / veto by id or by replying to an action
 *   message; "go build X" → a real action at once (cloud / Devin session,
 *   fleet task or backlog item — cheapest capable lane) with a one-line
 *   acknowledgement and a result ping later. Answers, directives and chat fall
 *   through to the Leader thread.
 *
 * AUTHORITY. Every task request becomes an ordinary Leader action through
 * leader-apply (classified A/B/C, ledger first, grant re-checked). Mason's
 * request IS his approval of a class-B launch (applyApprovedLeaderAction — the
 * same path as an Approve tap). Class C and dry run are reported honestly;
 * nothing here bypasses custody, the grant or a lane's budget.
 *
 * State: ~/.ashlr/comms/leader-line.json (0600). Never throws.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';

import type { AshlrConfig } from '../types.js';
import { sendTelegramMessage, telegramEnabled, type InboundEvent, type TelegramButton, type TelegramSendOpts, type TelegramSendResult } from '../integrations/telegram.js';
import { leaderDisplayText } from '../integrations/telegram-format.js';
import { scrubSecrets } from '../util/scrub.js';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';
import { classifyOperatorText, jevChooseLane, jevWorthInterrupting, type OperatorIntent, type TaskLane, type TaskRequest } from '../vision/leader-intent.js';
import { zonedParts } from '../vision/leader-drive.js';
import type { LeaderApplyDeps } from '../vision/leader-apply.js';
import type { LeaderAction } from '../vision/leader-types.js';
import type { LeaderThreadMessage } from '../vision/leader-thread.js';
import { briefFactsText, composeBrief, gatherBriefFacts, type BriefKind, type BriefSources } from './leader-brief.js';
import { lookupTelegramMessage, recordTelegramMessages, registerButtonTarget, type TelegramThreadEntry,
  type TelegramQuestionDraft } from './telegram-thread-map.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface LineConfig {
  enabled: boolean;
  morning: { h: number; m: number } | null;
  evening: { h: number; m: number } | null;
  timeZone: string;
  quiet: { start: number; end: number };
  maxPingsPerDay: number;
  repo: string;
}

export const LINE_DEFAULTS = Object.freeze({
  briefTimes: ['08:00', '19:00'] as const,
  timeZone: 'America/New_York',
  quiet: Object.freeze({ start: 23, end: 7 }),
  maxPingsPerDay: 6,
  /** Urgent pings still have a ceiling (a revert storm is one message, not twenty). */
  maxUrgentPerDay: 4,
  minGapMs: 20 * 60_000,
  /** A brief slot that was missed by more than this is skipped (no 6 pm "morning brief"). */
  briefWindowMinutes: 180,
  /** An unanswered question stops holding the next one after this long. */
  questionHoldMs: 24 * 3_600_000,
  repo: 'ashlrai/phantom',
  narrativeTimeoutMs: 12_000,
  instantNarrativeTimeoutMs: 8_000,
  watchMaxAgeMs: 7 * 86_400_000,
});

function parseHhmm(value: unknown): { h: number; m: number } | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h >= 0 && h < 24 && min >= 0 && min < 60 ? { h, m: min } : null;
}

function validTimeZone(tz: unknown): string {
  if (typeof tz !== 'string' || tz.length === 0) return LINE_DEFAULTS.timeZone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return LINE_DEFAULTS.timeZone;
  }
}

function underTestRunner(): boolean {
  return Boolean(process.env['VITEST']) || process.env['NODE_ENV'] === 'test';
}

export function resolveLineConfig(cfg: AshlrConfig | undefined): LineConfig {
  const c = cfg?.comms;
  const times = Array.isArray(c?.briefTimes) ? c!.briefTimes : [...LINE_DEFAULTS.briefTimes];
  const hour = (v: unknown, d: number): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 24 ? v : d);
  const repo = typeof c?.leaderRepo === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(c.leaderRepo) ? c.leaderRepo : LINE_DEFAULTS.repo;
  return {
    // Default on — except under the test runner, where only an explicit
    // `leaderLine: true` turns it on (a brief must never fire in a test just
    // because the wall clock reads 08:05 in New York).
    enabled: c?.leaderLine === true || (c?.leaderLine !== false && !underTestRunner()),
    morning: parseHhmm(times[0]),
    evening: parseHhmm(times[1]),
    timeZone: validTimeZone(c?.timeZone),
    quiet: { start: hour(c?.quietHours?.start, LINE_DEFAULTS.quiet.start), end: hour(c?.quietHours?.end, LINE_DEFAULTS.quiet.end) },
    maxPingsPerDay: typeof c?.maxPingsPerDay === 'number' && c.maxPingsPerDay >= 0 ? Math.min(50, Math.floor(c.maxPingsPerDay)) : LINE_DEFAULTS.maxPingsPerDay,
    repo,
  };
}

/** The line runs (briefs, pings) when Telegram is the channel and it was not switched off. */
export function leaderLineEnabled(cfg: AshlrConfig | undefined): boolean {
  return cfg !== undefined && telegramEnabled(cfg) && resolveLineConfig(cfg).enabled;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface LineWatch {
  actionId: string;
  lane: 'cloud' | 'devin' | 'fleet';
  taskId: string;
  title: string;
  requestedAt: string;
  notifiedAt: string | null;
}

export interface LineStateV1 {
  v: 1;
  /** Local day each slot was last sent. */
  briefs: { morning: string | null; evening: string | null };
  lastBriefAt: string | null;
  pings: { at: string; key: string; urgent: boolean }[];
  seenEvents: string[];
  eventCursor: string | null;
  watches: LineWatch[];
  /** The last reply that was cut for the phone ("more" sends the rest). */
  lastFull: { text: string; at: string } | null;
  /** The question currently put to Mason (one at a time). */
  question: { questionId: string; sentAt: string } | null;
  /** Last day a "Leader down" ping went out (once a day at most). */
  downPingDay: string | null;
}

function emptyState(): LineStateV1 {
  return { v: 1, briefs: { morning: null, evening: null }, lastBriefAt: null, pings: [], seenEvents: [], eventCursor: null, watches: [], lastFull: null, question: null, downPingDay: null };
}

export function leaderLineStatePath(): string {
  return join(homedir(), '.ashlr', 'comms', 'leader-line.json');
}

export function readLineState(): LineStateV1 {
  const read = readPrivateFileCapped(leaderLineStatePath(), 512 * 1024);
  if (!read || read.truncated) return emptyState();
  try {
    const p = JSON.parse(read.text) as Partial<LineStateV1>;
    if (p.v !== 1) return emptyState();
    const base = emptyState();
    return {
      v: 1,
      briefs: { morning: typeof p.briefs?.morning === 'string' ? p.briefs.morning : null, evening: typeof p.briefs?.evening === 'string' ? p.briefs.evening : null },
      lastBriefAt: typeof p.lastBriefAt === 'string' ? p.lastBriefAt : null,
      pings: Array.isArray(p.pings) ? p.pings.filter((x) => x && typeof x.at === 'string') : base.pings,
      seenEvents: Array.isArray(p.seenEvents) ? p.seenEvents.filter((x): x is string => typeof x === 'string') : [],
      eventCursor: typeof p.eventCursor === 'string' ? p.eventCursor : null,
      watches: Array.isArray(p.watches) ? p.watches.filter((w) => w && typeof w.taskId === 'string' && typeof w.lane === 'string') : [],
      lastFull: p.lastFull && typeof p.lastFull.text === 'string' ? p.lastFull : null,
      question: p.question && typeof p.question.questionId === 'string' ? p.question : null,
      downPingDay: typeof p.downPingDay === 'string' ? p.downPingDay : null,
    };
  } catch {
    return emptyState();
  }
}

export function writeLineState(state: LineStateV1, nowMs: number): void {
  try {
    ensurePrivateDirectory(join(homedir(), '.ashlr', 'comms'));
    const dayAgo = nowMs - 2 * 86_400_000;
    const bounded: LineStateV1 = {
      ...state,
      pings: state.pings.filter((p) => Date.parse(p.at) >= dayAgo).slice(-100),
      seenEvents: state.seenEvents.slice(-300),
      watches: state.watches.filter((w) => nowMs - Date.parse(w.requestedAt) <= LINE_DEFAULTS.watchMaxAgeMs).slice(-50),
    };
    writePrivateFileAtomic(leaderLineStatePath(), `${JSON.stringify(bounded)}\n`);
  } catch { /* best-effort: the worst case is one repeated brief */ }
}

// ---------------------------------------------------------------------------
// Pacing (pure)
// ---------------------------------------------------------------------------

export function inQuietHours(nowMs: number, lc: Pick<LineConfig, 'quiet' | 'timeZone'>): boolean {
  const { start, end } = lc.quiet;
  if (start === end) return false;
  const hour = zonedParts(nowMs, lc.timeZone).hour;
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

/** Which brief is due now, if any (one per slot per local day; a long-missed slot is skipped). */
export function dueBrief(nowMs: number, lc: LineConfig, state: LineStateV1): Exclude<BriefKind, 'instant'> | null {
  if (!lc.enabled) return null;
  const z = zonedParts(nowMs, lc.timeZone);
  const mins = z.hour * 60 + z.minute;
  for (const kind of ['morning', 'evening'] as const) {
    const t = kind === 'morning' ? lc.morning : lc.evening;
    if (!t) continue;
    const at = t.h * 60 + t.m;
    if (mins >= at && mins < at + LINE_DEFAULTS.briefWindowMinutes && state.briefs[kind] !== z.day && !inQuietHours(nowMs, lc)) return kind;
  }
  return null;
}

export type PingClass = 'urgent' | 'requested' | 'normal';

/**
 * May a proactive ping go out now? `urgent` passes quiet hours (up to its own
 * cap); `requested` (a result Mason asked for) ignores the daily cap but not
 * quiet hours; `normal` respects both, plus the minimum gap.
 */
export function pingAllowed(nowMs: number, lc: LineConfig, state: LineStateV1, cls: PingClass): { ok: boolean; reason: string | null } {
  const today = zonedParts(nowMs, lc.timeZone).day;
  const todays = state.pings.filter((p) => zonedParts(Date.parse(p.at), lc.timeZone).day === today);
  if (cls === 'urgent') {
    return todays.filter((p) => p.urgent).length >= LINE_DEFAULTS.maxUrgentPerDay
      ? { ok: false, reason: 'urgent cap reached today' }
      : { ok: true, reason: null };
  }
  if (inQuietHours(nowMs, lc)) return { ok: false, reason: 'quiet hours' };
  if (cls === 'requested') return { ok: true, reason: null };
  if (todays.filter((p) => !p.urgent).length >= lc.maxPingsPerDay) return { ok: false, reason: 'daily ping cap reached' };
  const last = todays.filter((p) => !p.urgent).map((p) => Date.parse(p.at)).sort((a, b) => b - a)[0];
  if (last !== undefined && nowMs - last < LINE_DEFAULTS.minGapMs) return { ok: false, reason: 'too soon after the last ping' };
  return { ok: true, reason: null };
}

/**
 * The thread drain's gate: replies to Mason always go; proactive messages
 * wait out quiet hours; a question waits while another is unanswered.
 */
export function gateThreadMessage(
  msg: Pick<LeaderThreadMessage, 'kind' | 'replyTo' | 'questionId'>,
  nowMs: number,
  lc: LineConfig,
  state: LineStateV1,
  isAnswered: (questionId: string) => boolean,
): 'send' | 'hold' {
  if (!lc.enabled) return 'send';
  if (msg.replyTo) return 'send';
  if (inQuietHours(nowMs, lc)) return 'hold';
  if (msg.kind === 'question') {
    const open = state.question;
    if (open && open.questionId !== msg.questionId && !isAnswered(open.questionId) && nowMs - Date.parse(open.sentAt) < LINE_DEFAULTS.questionHoldMs) return 'hold';
  }
  return 'send';
}

/** "Should we…?", "Do you want…?" — a question two buttons can answer. */
export function isYesNoQuestion(text: string): boolean {
  const t = text.trim();
  return /\?\s*$/.test(t) && /^(?:should|shall|do|does|did|can|could|would|will|is|are|may|want|ok(?:ay)? to|approve)\b/i.test(t) && !/\b(?:which|what|how|who|where|when)\b/i.test(t.split(/[,;]/)[0] ?? '');
}

export const QUESTION_ANSWERS = Object.freeze({
  y: 'Yes.',
  n: 'No.',
  c: 'Your call — decide, act inside the grant, and tell me what you did.',
});

/** [Yes] [No] [Your call] for a yes/no Leader question (`lt:y|n|c:<token>`). */
export function questionKeyboard(target: { questionId: string; threadId?: string }): TelegramButton[][] {
  const token = registerButtonTarget({ questionId: target.questionId, ...(target.threadId ? { threadId: target.threadId } : {}) });
  return [[
    { text: 'Yes', data: `lt:y:${token}` },
    { text: 'No', data: `lt:n:${token}` },
    { text: 'Your call', data: `lt:c:${token}` },
  ]];
}

/** Explicit typed forms only: every tap names the visible draft revision. */
export function typedQuestionKeyboard(draft: TelegramQuestionDraft): TelegramButton[][] {
  const data = (verb: string, index?: number): string =>
    `lt:q:${draft.token}:${draft.revision.toString(36)}:${verb}${index === undefined ? '' : `:${index}`}`;
  if (draft.claim) return [];
  const rows: TelegramButton[][] = (draft.form.options ?? []).map((label, index) => [{
    text: `${draft.selected.includes(index) ? '✓ ' : '○ '}${label}`, data: data('o', index),
  }]);
  if (draft.form.mode === 'multiple') rows.push([{ text: 'Select all', data: data('a') }, { text: 'Clear', data: data('c') }]);
  if (draft.form.mode !== 'short-answer') rows.push([{ text: 'Submit', data: data('s') }, { text: 'Write an answer', data: data('w') }]);
  else rows.push([{ text: 'Write an answer', data: data('w') }]);
  return rows;
}

function actionKeyboard(actionIds: readonly string[]): TelegramButton[][] {
  const token = registerButtonTarget({ actionIds: [...actionIds] });
  return [[
    { text: 'Approve', data: `lt:a:${token}` },
    { text: 'Veto', data: `lt:v:${token}` },
    { text: 'Details', data: `lt:d:${token}` },
  ]];
}

// ---------------------------------------------------------------------------
// Deps (tests inject)
// ---------------------------------------------------------------------------

type ThreadModule = typeof import('../vision/leader-thread.js');

export interface LaneBudget {
  mode: 'reserve' | 'balanced' | 'all-in';
  cloud: { ok: boolean; reason: string | null } | null;
  devin: { ok: boolean; reason: string | null } | null;
}

export interface TaskStatus {
  state: string;
  url: string | null;
  reason: string | null;
}

export interface LeaderLineDeps {
  now(): number;
  briefSources?: BriefSources;
  narrative(facts: string, cfg: AshlrConfig, timeoutMs: number): Promise<string | null>;
  apply(): Promise<LeaderApplyDeps>;
  thread(): Promise<ThreadModule | null>;
  laneBudget(apply: LeaderApplyDeps): Promise<LaneBudget>;
  taskStatus(lane: LineWatch['lane'], taskId: string): Promise<TaskStatus | null>;
  isAnswered(questionId: string): boolean;
  driveReport(): { day: string; text: string; actionIds: string[]; postedAt: string | null } | null;
  markDriveReportPosted(day: string, nowMs: number): void;
  events(sinceMs: number): Promise<Array<{ key: string; kind: string; text: string; url?: string }>>;
  leaderHealth(): { status: string; summary: string } | null;
}

let depsOverride: Partial<LeaderLineDeps> | null = null;

/** Test hook: inject fakes (null restores production). */
export function setLeaderLineDepsForTest(next: Partial<LeaderLineDeps> | null): void {
  depsOverride = next;
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  return Promise.race([
    p.catch(() => fallback),
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
      timer.unref?.();
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

const TERMINAL_OR_DELIVERED = new Set(['pr-open', 'merged', 'closed', 'failed', 'expired', 'done', 'cancelled']);

function productionDeps(): LeaderLineDeps {
  return {
    now: () => Date.now(),
    narrative: async (facts, cfg, timeoutMs) => {
      const thread = await import('../vision/leader-thread.js');
      return thread.leaderNarrativeLine(facts, { cfg, timeoutMs });
    },
    apply: async () => (await import('../vision/leader-apply.js')).loadDefaultLeaderDeps(),
    thread: async () => {
      try { return await import('../vision/leader-thread.js'); } catch { return null; }
    },
    laneBudget: async (apply) => {
      let mode: LaneBudget['mode'] = 'balanced';
      try { mode = apply.budget.load().mode; } catch { /* default */ }
      let cloud: LaneBudget['cloud'] = null;
      let devin: LaneBudget['devin'] = null;
      try {
        const [store, budget] = await Promise.all([import('../cloud/store.js'), import('../cloud/budget.js')]);
        cloud = budget.cloudBudgetView(store.listCloudTasks(), store.readCloudBudget(), new Date()).canLaunch;
      } catch { cloud = null; }
      try {
        if (apply.powers?.devin?.fleetEnabled()) {
          const [store, budget] = await Promise.all([import('../devin/store.js'), import('../devin/budget.js')]);
          devin = budget.devinBudgetView(store.listDevinTasks(), store.readDevinBudget(), new Date()).canFleetLaunch;
        }
      } catch { devin = null; }
      return { mode, cloud, devin };
    },
    taskStatus: async (lane, taskId) => {
      try {
        if (lane === 'cloud') {
          const t = (await import('../cloud/store.js')).readCloudTask(taskId);
          return t ? { state: t.state, url: t.pr?.url ?? t.sessionUrl, reason: t.stateReason } : null;
        }
        if (lane === 'devin') {
          const t = (await import('../devin/store.js')).readDevinTask(taskId);
          return t ? { state: t.state, url: t.pr?.url ?? t.sessionUrl, reason: t.stateReason } : null;
        }
        const q = (await import('../fleet/task-source.js')).readTaskQueue();
        const t = q.ok ? q.tasks.find((x) => x.id === taskId) : undefined;
        return t ? { state: t.status, url: null, reason: null } : null;
      } catch {
        return null;
      }
    },
    isAnswered: (questionId) => {
      try {
        // Sync read through a cached import (leader-operator is small and already loaded by the thread).
        return operatorModule?.findLeaderQuestion(questionId)?.answer != null;
      } catch {
        return false;
      }
    },
    driveReport: () => driveModule?.readDriveState().lastReport ?? null,
    markDriveReportPosted: (day, nowMs) => { driveModule?.markDriveReportPosted(day, nowMs); },
    events: async (sinceMs) => {
      const { collectDigestFacts } = await import('./change-digest.js');
      const facts = await collectDigestFacts(sinceMs);
      return facts.events;
    },
    leaderHealth: () => leaderState?.health ?? null,
  };
}

// Modules the sync deps read (loaded once per cycle in `prepare`).
let operatorModule: typeof import('../vision/leader-operator.js') | null = null;
let driveModule: typeof import('../vision/leader-drive.js') | null = null;
let leaderState: { health?: { status: string; summary: string } } | null = null;

async function prepare(): Promise<void> {
  try { operatorModule = await import('../vision/leader-operator.js'); } catch { operatorModule = null; }
  try { driveModule = await import('../vision/leader-drive.js'); } catch { driveModule = null; }
  try { leaderState = (await import('../vision/leader.js')).buildLeaderState(Date.now()); } catch { leaderState = null; }
}

function lineDeps(): LeaderLineDeps {
  return { ...productionDeps(), ...(depsOverride ?? {}) } as LeaderLineDeps;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function sentIds(res: TelegramSendResult): number[] {
  if (Array.isArray(res.messageIds) && res.messageIds.length > 0) return res.messageIds;
  return typeof res.messageId === 'number' ? [res.messageId] : [];
}

async function send(text: string, cfg: AshlrConfig, opts: TelegramSendOpts, record: Omit<TelegramThreadEntry, 'tg' | 'at'>): Promise<boolean> {
  const res = await sendTelegramMessage(leaderDisplayText(scrubSecrets(text), Date.now(), cfg.comms?.timeZone), opts, cfg);
  if (res.ok) recordTelegramMessages(sentIds(res), record);
  return res.ok;
}

function notePing(state: LineStateV1, nowMs: number, key: string, urgent: boolean): void {
  state.pings.push({ at: new Date(nowMs).toISOString(), key, urgent });
}

// ---------------------------------------------------------------------------
// Briefs
// ---------------------------------------------------------------------------

/**
 * Compose a brief from recorded state (+ an optional narrative line fetched
 * with a short timeout). Returns the text, the actions still in their veto
 * window, and the question it carries.
 */
export async function buildBrief(
  kind: BriefKind,
  cfg: AshlrConfig,
  opts: { sinceMs?: number; narrativeTimeoutMs?: number } = {},
): Promise<{ text: string; pendingActionIds: string[]; question: { questionId: string; text: string } | null }> {
  const d = lineDeps();
  const lc = resolveLineConfig(cfg);
  const nowMs = d.now();
  const sinceMs = opts.sinceMs ?? nowMs - (kind === 'instant' ? 12 : 24) * 3_600_000;
  const facts = await gatherBriefFacts(sinceMs, nowMs, d.briefSources ?? {}, lc.timeZone);
  const timeoutMs = opts.narrativeTimeoutMs ?? (kind === 'instant' ? LINE_DEFAULTS.instantNarrativeTimeoutMs : LINE_DEFAULTS.narrativeTimeoutMs);
  const narrative = timeoutMs > 0 ? await withTimeout(d.narrative(briefFactsText(facts), cfg, timeoutMs), timeoutMs, null) : null;
  return { text: composeBrief(kind, facts, { narrative, timeZone: lc.timeZone }), pendingActionIds: facts.pendingActionIds, question: facts.question };
}

async function deliverBrief(
  kind: BriefKind,
  cfg: AshlrConfig,
  state: LineStateV1,
  nowMs: number,
  replyToMessageId?: number,
): Promise<boolean> {
  const d = lineDeps();
  const since = kind === 'instant'
    ? nowMs - 12 * 3_600_000
    : Math.max(nowMs - 36 * 3_600_000, state.lastBriefAt ? Date.parse(state.lastBriefAt) : nowMs - 24 * 3_600_000);
  const brief = await buildBrief(kind, cfg, { sinceMs: since });
  // One question at a time: carry it only when none is already out (or that one was answered).
  const outstanding = state.question && !d.isAnswered(state.question.questionId) && nowMs - Date.parse(state.question.sentAt) < LINE_DEFAULTS.questionHoldMs
    ? state.question.questionId : null;
  let text = brief.text;
  let question = brief.question;
  if (question && outstanding && outstanding !== question.questionId) {
    text = text.split('\n').filter((l) => !l.startsWith('Q: ')).join('\n');
    question = null;
  }
  const opts: TelegramSendOpts = {};
  let legacyQuestionControls = true;
  if (question) {
    try {
      const mod = await d.thread();
      if (typeof mod?.readLeaderQuestion === 'function') {
        const current = mod.readLeaderQuestion(question.questionId);
        legacyQuestionControls = current !== null && !current.questionForm;
        if (!legacyQuestionControls) {
          // Typed prompts must leave through the real thread delivery path,
          // which binds their actual bot message and owns the draft. A brief
          // must not mark that pending prompt delivered without its controls.
          text = text.split('\n').filter(line => !line.startsWith('Q: ')).join('\n');
          question = null;
        }
      }
    } catch {
      legacyQuestionControls = false;
      text = text.split('\n').filter(line => !line.startsWith('Q: ')).join('\n');
      question = null;
    }
  }
  if (typeof replyToMessageId === 'number') opts.replyToMessageId = replyToMessageId;
  if (brief.pendingActionIds.length > 0) opts.keyboard = actionKeyboard(brief.pendingActionIds.slice(0, 10));
  else if (question && legacyQuestionControls && isYesNoQuestion(question.text)) opts.keyboard = questionKeyboard({ questionId: question.questionId });
  const ok = await send(text, cfg, opts, {
    kind: question ? 'question' : 'update',
    ...(question ? { questionId: question.questionId } : {}),
    ...(brief.pendingActionIds.length ? { actionIds: brief.pendingActionIds.slice(0, 10) } : {}),
  });
  if (ok && question) {
    state.question = { questionId: question.questionId, sentAt: new Date(nowMs).toISOString() };
    // The thread's own message for this question must not go out a second time.
    await markQuestionDelivered(question.questionId);
  }
  return ok;
}

async function markQuestionDelivered(questionId: string): Promise<void> {
  try {
    const thread = await lineDeps().thread();
    const record = operatorModule?.findLeaderQuestion(questionId);
    if (thread && record?.messageId) thread.markDelivered(record.messageId, 'telegram', true);
  } catch { /* the gate still holds a second question */ }
}

/** The instant brief for "status" / "update" / "what's up" (and /status). */
export async function instantBrief(cfg: AshlrConfig): Promise<string> {
  await prepare();
  try {
    return (await buildBrief('instant', cfg)).text;
  } catch {
    return 'Status: the Leader could not read its state just now — try again in a minute.';
  }
}

// ---------------------------------------------------------------------------
// The proactive cycle
// ---------------------------------------------------------------------------

export interface LeaderLineResult {
  brief: BriefKind | null;
  pings: number;
  driveReport: boolean;
}

function watchLine(w: LineWatch, status: TaskStatus): string {
  const lane = w.lane === 'cloud' ? 'Cloud' : w.lane === 'devin' ? 'Devin' : 'Fleet';
  switch (status.state) {
    case 'pr-open': return `${lane}: "${w.title}" — PR is up${status.url ? ` ${status.url}` : ''}. Review when ready.`;
    case 'merged': return `${lane}: "${w.title}" — merged${status.url ? ` ${status.url}` : ''}. Done.`;
    case 'done': return `${lane}: "${w.title}" — done.`;
    case 'closed': return `${lane}: "${w.title}" — closed without landing${status.reason ? `: ${status.reason}` : ''}.`;
    case 'cancelled': return `${lane}: "${w.title}" — cancelled.`;
    default: return `${lane}: "${w.title}" — ${status.state}${status.reason ? `: ${status.reason}` : ''}. I'll take another run at it unless you say otherwise.`;
  }
}

/**
 * One pass of the proactive line. Call once per comms cycle (Telegram, not
 * paused). Order: brief → self-improvement report → result pings → event
 * pings. Never throws.
 */
export async function runLeaderLine(cfg: AshlrConfig): Promise<LeaderLineResult> {
  const out: LeaderLineResult = { brief: null, pings: 0, driveReport: false };
  if (!leaderLineEnabled(cfg)) return out;
  await prepare();
  const d = lineDeps();
  const lc = resolveLineConfig(cfg);
  const nowMs = d.now();
  const state = readLineState();
  try {
    // 1. Scheduled brief.
    const kind = dueBrief(nowMs, lc, state);
    if (kind) {
      const today = zonedParts(nowMs, lc.timeZone).day;
      if (await deliverBrief(kind, cfg, state, nowMs)) {
        state.briefs[kind] = today;
        state.lastBriefAt = new Date(nowMs).toISOString();
        out.brief = kind;
      }
    }

    // 2. The day's self-improvement report.
    const report = d.driveReport();
    if (report && !report.postedAt && pingAllowed(nowMs, lc, state, 'normal').ok) {
      const ids = report.actionIds.slice(0, 10);
      const ok = await send(report.text, cfg, ids.length ? { keyboard: actionKeyboard(ids) } : {}, { kind: 'update', ...(ids.length ? { actionIds: ids } : {}) });
      if (ok) {
        d.markDriveReportPosted(report.day, nowMs);
        notePing(state, nowMs, `drive:${report.day}`, false);
        out.driveReport = true;
        out.pings += 1;
      }
    }

    // 3. Results of work Mason asked for.
    for (const w of state.watches) {
      if (w.notifiedAt) continue;
      const status = await d.taskStatus(w.lane, w.taskId);
      if (!status || !TERMINAL_OR_DELIVERED.has(status.state)) continue;
      if (!pingAllowed(nowMs, lc, state, 'requested').ok) break;
      if (await send(watchLine(w, status), cfg, {}, { kind: 'update', actionIds: [w.actionId] })) {
        w.notifiedAt = new Date(nowMs).toISOString();
        notePing(state, nowMs, `watch:${w.taskId}`, false);
        out.pings += 1;
      }
    }

    // 4. Events that matter now.
    const since = state.eventCursor ? Date.parse(state.eventCursor) : nowMs - 3_600_000;
    const events = await d.events(Math.max(since - 3_600_000, nowMs - 48 * 3_600_000)).catch(() => []);
    const seen = new Set(state.seenEvents);
    for (const e of events) {
      if (seen.has(e.key)) continue;
      seen.add(e.key);
      state.seenEvents.push(e.key);
      if (e.kind !== 'revert' && e.kind !== 'revert-failed') continue; // merges and PRs ride the brief
      // A failed revert is urgent (bad code is live); a landed revert is worth
      // a ping unless Jev judges it can wait for the brief.
      const urgent = e.kind === 'revert-failed';
      const todays = state.pings.filter((p) => zonedParts(Date.parse(p.at), lc.timeZone).day === zonedParts(nowMs, lc.timeZone).day);
      const lastPing = state.pings.map((p) => Date.parse(p.at)).sort((a, b) => b - a)[0];
      const { interrupt } = await jevWorthInterrupting(
        { id: e.key, title: e.text, kind: e.kind, source: 'fleet', severity: urgent ? 'high' : 'warn', since: null },
        { quietHours: inQuietHours(nowMs, lc), pushesToday: todays.length, minutesSinceLastPush: lastPing === undefined ? null : (nowMs - lastPing) / 60_000 },
        true,
      );
      if (!interrupt) continue;
      if (!pingAllowed(nowMs, lc, state, urgent ? 'urgent' : 'normal').ok) continue;
      const text = e.kind === 'revert-failed' ? `Urgent: ${e.text}. The fleet could not undo a bad merge — look now.` : `Reverted: ${e.text}${e.url ? ` ${e.url}` : ''}. The fleet caught it; I'm on the root cause.`;
      if (await send(text, cfg, {}, { kind: 'notification' })) {
        notePing(state, nowMs, e.key, urgent);
        out.pings += 1;
      }
    }
    state.eventCursor = new Date(nowMs).toISOString();

    // 5. The Leader itself down: once a day, in working hours.
    const health = d.leaderHealth();
    const today = zonedParts(nowMs, lc.timeZone).day;
    if (health?.status === 'down' && state.downPingDay !== today && pingAllowed(nowMs, lc, state, 'normal').ok) {
      if (await send(`Heads up: the Leader is down — ${health.summary}`, cfg, {}, { kind: 'notification' })) {
        state.downPingDay = today;
        notePing(state, nowMs, `down:${today}`, false);
        out.pings += 1;
      }
    }
  } catch { /* never break the comms cycle */ }
  writeLineState(state, nowMs);
  return out;
}

// ---------------------------------------------------------------------------
// The thread drain's hooks
// ---------------------------------------------------------------------------

export interface ThreadLineHooks {
  gate(msg: LeaderThreadMessage): 'send' | 'hold';
  /** The keyboard a question gets (null = none). */
  questionKeyboard(msg: LeaderThreadMessage): TelegramButton[][] | null;
  sent(msg: LeaderThreadMessage): void;
  /** Persist what `sent` recorded. */
  flush(): void;
}

/** Hooks for drainLeaderThread; null when the line is off (the drain behaves as before). */
export async function threadLineHooks(cfg: AshlrConfig): Promise<ThreadLineHooks | null> {
  if (!leaderLineEnabled(cfg)) return null;
  await prepare();
  const d = lineDeps();
  const lc = resolveLineConfig(cfg);
  const state = readLineState();
  let dirty = false;
  return {
    gate: (msg) => gateThreadMessage(msg, d.now(), lc, state, (id) => d.isAnswered(id)),
    questionKeyboard: (msg) => (msg.kind === 'question' && msg.questionId && !msg.questionForm && isYesNoQuestion(msg.text)
      ? questionKeyboard({ questionId: msg.questionId, threadId: msg.id })
      : null),
    sent: (msg) => {
      if (msg.kind === 'question' && msg.questionId) {
        state.question = { questionId: msg.questionId, sentAt: new Date(d.now()).toISOString() };
        dirty = true;
      }
    },
    flush: () => {
      if (dirty) writeLineState(state, d.now());
    },
  };
}

// ---------------------------------------------------------------------------
// Mason → the line
// ---------------------------------------------------------------------------

async function replyTo(event: InboundEvent, text: string, cfg: AshlrConfig, extra: TelegramSendOpts = {}): Promise<TelegramSendResult> {
  const opts: TelegramSendOpts = { ...extra, ...(typeof event.messageId === 'number' ? { replyToMessageId: event.messageId } : {}) };
  return sendTelegramMessage(leaderDisplayText(scrubSecrets(text), Date.now(), cfg.comms?.timeZone), opts, cfg);
}

/** Remember a long reply so "more" can send the rest. */
export function rememberFullReply(text: string, nowMs: number = Date.now()): void {
  const state = readLineState();
  state.lastFull = { text, at: new Date(nowMs).toISOString() };
  writeLineState(state, nowMs);
}

function titleFor(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const cap = t.charAt(0).toUpperCase() + t.slice(1);
  return cap.length > 78 ? `${cap.slice(0, 77)}…` : cap;
}

function taskPrompt(task: TaskRequest, repo: string): string {
  return `Mason (the owner) asked for this directly, via Telegram:\n\n"${task.text}"\n\nRepository: ${repo}. First confirm what exists today; then deliver the smallest complete change that does it, with tests that prove it. Say in the PR how you verified it and anything you chose not to do.`;
}

/** Cheapest capable lane for a task (deterministic; Jev may pick among the allowed ones). */
export function defaultLane(task: TaskRequest, budget: LaneBudget): TaskLane {
  if (task.size === 'small') return 'fleet';
  if (budget.mode !== 'reserve' && budget.cloud?.ok) return 'cloud';
  if (budget.mode !== 'reserve' && budget.devin?.ok) return 'devin';
  return 'fleet';
}

async function draftFor(lane: TaskLane, task: TaskRequest, repo: string): Promise<import('../vision/leader-memo.js').AnyLeaderActionDraft | null> {
  const { buildLeaderActionDraft } = await import('../vision/leader-memo.js');
  const title = titleFor(task.text);
  const why = `Mason asked for it on Telegram: "${task.text}"`;
  switch (lane) {
    case 'cloud': return buildLeaderActionDraft('cloud.launch', { repo, title, prompt: taskPrompt(task, repo), purpose: 'task' }, `Mason's ask (cloud): ${title}`, why);
    case 'devin': return buildLeaderActionDraft('devin.launch', { repo, title, prompt: taskPrompt(task, repo) }, `Mason's ask (Devin): ${title}`, why);
    case 'backlog': return buildLeaderActionDraft('backlog.add', { repo, title, prompt: taskPrompt(task, repo), priority: 1 }, `Mason's ask (queued): ${title}`, why);
    default: return buildLeaderActionDraft('work.dispatch', {
      task: { repo, title, detail: taskPrompt(task, repo), difficulty: task.size === 'small' ? 'low' : 'high', value: 4 },
    }, `Mason's ask (fleet): ${title}`, why);
  }
}

function hhmmIn(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

/** One or two lines: what happened to Mason's ask. */
export function taskAckText(action: LeaderAction, lane: TaskLane, repo: string, tz: string, fellBackFrom?: { lane: TaskLane; reason: string }): string {
  const p = action.params as unknown as { title?: string; task?: { title?: string } };
  const title = p.title ?? p.task?.title ?? action.summary;
  const prefix = fellBackFrom ? `${fellBackFrom.lane === 'cloud' ? 'Cloud' : 'Devin'} said no (${fellBackFrom.reason}) — ` : '';
  switch (action.status) {
    case 'applied': {
      const detail = action.statusReason && /https?:\/\//.test(action.statusReason) ? ` ${action.statusReason.match(/https?:\/\/\S+/)![0].replace(/[.)]+$/, '')}` : '';
      if (lane === 'backlog') return `${prefix}Queued: "${title}" is in the backlog for ${repo}; the self-improvement scheduler takes it within budget.`;
      if (lane === 'fleet') return `${prefix}On it. "${title}" is queued for the fleet on ${repo}. I'll ping when it lands.`;
      return `${prefix}On it. ${lane === 'cloud' ? 'Cloud' : 'Devin'} session launched on ${repo}: "${title}".${detail}\nI'll ping when the PR is up.`;
    }
    case 'scheduled':
      return `${prefix}Scheduled: "${title}" launches ${action.applyAfter ? hhmmIn(action.applyAfter, tz) : 'soon'} unless you veto.${action.statusReason ? ` ${action.statusReason}` : ''}`;
    case 'escalated':
      return `Can't start "${title}": ${action.statusReason ?? 'it is outside the standing grant'} Widen the grant (phm authority), or tell me a different lane.`;
    case 'refused':
      return action.statusReason?.startsWith('dry run:')
        ? `Recorded "${title}", not started — ${action.statusReason}`
        : `Blocked: "${title}" — ${action.statusReason ?? 'refused'}`;
    default:
      return `That did not start: ${action.statusReason ?? action.status}.`;
  }
}

function watchOf(action: LeaderAction, lane: TaskLane): LineWatch | null {
  if (action.status !== 'applied' || !action.inverse) return null;
  const inv = action.inverse;
  const p = action.params as unknown as { title?: string; task?: { title?: string } };
  const title = (p.title ?? p.task?.title ?? action.summary).slice(0, 80);
  if (inv.op === 'launch-recall') return { actionId: action.id, lane: inv.lane, taskId: inv.taskId, title, requestedAt: action.createdAt, notifiedAt: null };
  if (inv.op === 'cancel-task' && lane === 'fleet') return { actionId: action.id, lane: 'fleet', taskId: inv.taskId, title, requestedAt: action.createdAt, notifiedAt: null };
  return null;
}

/**
 * "Go build X": plan the work as a Leader action on the cheapest capable lane
 * (or the one Mason named), apply it now under his approval, fall back once
 * to the fleet when a paid lane's budget says no, acknowledge in one line and
 * watch it for a result ping.
 */
export async function handleTaskRequest(event: InboundEvent, task: TaskRequest, cfg: AshlrConfig): Promise<void> {
  const d = lineDeps();
  const lc = resolveLineConfig(cfg);
  const repo = task.repo ?? lc.repo;
  let apply: LeaderApplyDeps;
  try {
    apply = await d.apply();
  } catch {
    await replyTo(event, 'Could not load the Leader\'s action lanes just now — nothing was started. Try again in a minute.', cfg);
    return;
  }
  const budget = await d.laneBudget(apply).catch((): LaneBudget => ({ mode: 'balanced', cloud: null, devin: null }));
  let lane: TaskLane = task.lane ?? defaultLane(task, budget);
  if (!task.lane) {
    // Jev's chooseLane may pick among the lanes open right now; the cheapest capable lane is the fallback.
    const open: TaskLane[] = ['fleet', ...(budget.mode !== 'reserve' && budget.cloud?.ok ? ['cloud' as const] : []), ...(budget.mode !== 'reserve' && budget.devin?.ok ? ['devin' as const] : [])];
    lane = (await jevChooseLane({ title: titleFor(task.text), body: task.text, repo, githubRepo: true }, open, open.includes(lane) ? lane : 'fleet')).lane;
  }
  const { enactDirectLeaderActions } = await import('../vision/leader-drive.js');
  const enact = async (l: TaskLane): Promise<LeaderAction | null> => {
    const draft = await draftFor(l, task, repo);
    if (!draft) return null;
    const res = await enactDirectLeaderActions(apply, [draft], { approvedVia: 'telegram' });
    return res.actions[0] ?? null;
  };
  // A paid launch can take up to a minute and a half (the cloud CLI): say so
  // at once instead of going quiet, then report what actually happened.
  if (lane === 'cloud' || lane === 'devin') {
    await replyTo(event, `Launching a ${lane === 'cloud' ? 'cloud' : 'Devin'} session for "${titleFor(task.text)}" on ${repo}…`, cfg);
  }
  let action = await enact(lane);
  let fellBackFrom: { lane: TaskLane; reason: string } | undefined;
  if (action && (lane === 'cloud' || lane === 'devin') && (action.status === 'refused' || action.status === 'failed') && !action.statusReason?.startsWith('dry run:')) {
    fellBackFrom = { lane, reason: (action.statusReason ?? 'refused').replace(/\.$/, '') };
    lane = 'fleet';
    action = (await enact('fleet')) ?? action;
  }
  if (!action) {
    await replyTo(event, 'I could not turn that into a task (it did not validate). Say it as "build <what> in <owner/repo>".', cfg);
    return;
  }
  const ack = taskAckText(action, lane, repo, lc.timeZone, fellBackFrom);
  const buttons = action.status === 'scheduled' && action.class === 'B' ? { keyboard: actionKeyboard([action.id]) } : {};
  const res = await replyTo(event, ack, cfg, buttons);
  if (res.ok) recordTelegramMessages(sentIds(res), { kind: 'action', actionIds: [action.id], memoId: action.memoId });
  const watch = watchOf(action, lane);
  if (watch) {
    const state = readLineState();
    state.watches.push(watch);
    writeLineState(state, d.now());
  }
  // The Mind surface sees the ask and the outcome too (already delivered here).
  try {
    const thread = await d.thread();
    thread?.postLeaderMessage({ channel: 'telegram', kind: 'action', text: `You asked: "${task.text}"\n${ack}`, actionIds: [action.id], memoId: action.memoId, delivery: { telegram: 'sent' } });
  } catch { /* the action log still has it */ }
}

async function approveOrVeto(event: InboundEvent, intent: OperatorIntent, cfg: AshlrConfig): Promise<void> {
  const ids = (intent.actionIds ?? []).slice(0, 10);
  const lines: string[] = [];
  if (intent.kind === 'approve') {
    const thread = await lineDeps().thread();
    if (!thread) {
      await replyTo(event, 'Approval is not available in this build.', cfg);
      return;
    }
    const ackIds: string[] = [];
    for (const id of ids) {
      try {
        const res = await thread.approveLeaderAction(id, { channel: 'telegram', cfg });
        lines.push(`${res.ok ? 'Approved' : 'Not approved'} action: ${res.message}`);
        if (res.thread?.reply?.id) ackIds.push(res.thread.reply.id);
      } catch (err) {
        lines.push(`Not approved action: ${err instanceof Error && err.name === 'LeaderThreadError' ? err.message : 'the Leader is unreachable right now'}`);
      }
    }
    const sent = await replyTo(event, lines.join('\n'), cfg);
    for (const ackId of ackIds) thread.markDelivered(ackId, 'telegram', sent.ok);
    return;
  }
  const apply = await import('../vision/leader-apply.js');
  const deps = await lineDeps().apply();
  for (const id of ids) {
    const r = await apply.vetoLeaderAction(deps, id, 'Vetoed from Telegram');
    lines.push(r.ok ? `Vetoed action: ${r.message}` : `Could not veto action: ${r.message}`);
  }
  await replyTo(event, lines.join('\n') || 'Nothing to veto.', cfg);
}

/**
 * Route one text from Mason. Returns true when the line handled it (status,
 * more, approve / veto, a task request); false = let the Leader thread take
 * it (answers, directives, conversation). Never throws.
 */
export async function routeLeaderText(event: InboundEvent, text: string, cfg: AshlrConfig): Promise<boolean> {
  try {
    const repliedTo = lookupTelegramMessage(event.replyToMessageId);
    const intent = await classifyOperatorText(text, {
      replyToKind: repliedTo?.kind ?? null,
      replyActionIds: repliedTo?.actionIds ?? [],
    });
    switch (intent.kind) {
      case 'status': {
        await prepare();
        const state = readLineState();
        await deliverBrief('instant', cfg, state, lineDeps().now(), event.messageId);
        writeLineState(state, lineDeps().now());
        return true;
      }
      case 'detail': {
        const full = readLineState().lastFull;
        // More is one human-requested reply, not a queued delivery: the
        // transport splits the stored answer, and even a partial send consumes
        // this intent without a model fallback, replay or clearing the answer.
        await replyTo(event, full ? full.text : 'Nothing longer on file — that was the whole answer.', cfg);
        return true;
      }
      case 'approve':
      case 'veto':
        if (!intent.actionIds || intent.actionIds.length === 0) return false;
        await approveOrVeto(event, intent, cfg);
        return true;
      case 'task':
        if (!intent.task) return false;
        await handleTaskRequest(event, intent.task, cfg);
        return true;
      default:
        return false;
    }
  } catch {
    return false;
  }
}
