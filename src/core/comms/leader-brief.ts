/**
 * The Leader's brief (3.15) — what Mason reads on his phone: the morning
 * brief, the evening recap, and the instant answer to "status" / "update" /
 * "what's up".
 *
 *   Morning brief · Sat Sep 27
 *   Shipped: 2 — ashlrai/ashlr-hub#541 https://github.com/…; …
 *   Running: 1 — cloud "Fix X" (PR open) https://…
 *   Blockers: none.
 *   Next: <the Leader's move> · 1 launch at 14:30 unless you veto
 *   Q: <one question> (reply to answer)
 *   <one narrative line from the Leader>
 *
 * FAST PATH. Everything is composed from RECORDED state — the authority
 * ledger (via change-digest's collector), the cloud / Devin task stores, the
 * Leader's state, questions and self-improvement report — with no model call.
 * The only model output is the optional one-line narrative, which the caller
 * fetches with a short timeout and leaves out when it is slow.
 *
 * Sources are injectable for tests. Never throws.
 */

import { autonomyLine, collectDigestFacts, type DigestSources } from './change-digest.js';

export type BriefKind = 'morning' | 'evening' | 'instant';

export interface BriefItem {
  text: string;
  url?: string;
}

export interface BriefFacts {
  nowMs: number;
  sinceMs: number;
  shipped: BriefItem[];
  /** PRs opened in the window (count only — the shipped line leads with merges). */
  prsOpened: number;
  running: BriefItem[];
  blockers: string[];
  next: string[];
  question: { questionId: string; text: string } | null;
  /** Class-B actions waiting on their veto window (the brief offers Approve / Veto on them). */
  pendingActionIds: string[];
}

export interface BriefTaskLike {
  id: string;
  title: string;
  repo: string;
  state: string;
  updatedAt: string;
  sessionUrl?: string | null;
  pr?: { url: string; state: string } | null;
  stateReason?: string | null;
}

export interface BriefLeaderLike {
  health?: { status: string; summary: string } | null;
  latest: { id: string; at: string; status: string; move: { statement: string } | null } | null;
  actions: Array<{ id: string; class: string; status: string; summary: string; applyAfter: string | null; createdAt: string }>;
}

export interface BriefSources {
  digest?: DigestSources;
  leader?: () => BriefLeaderLike | null;
  cloudTasks?: () => BriefTaskLike[];
  devinTasks?: () => BriefTaskLike[];
  /** The oldest open Leader question (recent), or null. */
  openQuestion?: () => { questionId: string; text: string } | null;
  /** Today's self-improvement report text, or null. */
  driveReport?: () => string | null;
  holds?: () => Array<{ repo: string; kind: string; reason: string }>;
  autonomy?: () => { on: boolean; mode: string | null };
}

const ACTIVE = new Set(['queued', 'launching', 'running', 'blocked', 'pr-open']);
const MAX_ITEMS = 3;

function clip(text: string, max: number): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function call<T>(fn: (() => T) | undefined, fallback: T): T {
  if (!fn) return fallback;
  try {
    return fn();
  } catch {
    return fallback;
  }
}

async function defaults(): Promise<Required<Omit<BriefSources, 'digest'>>> {
  const base: Required<Omit<BriefSources, 'digest'>> = {
    leader: () => null,
    cloudTasks: () => [],
    devinTasks: () => [],
    openQuestion: () => null,
    driveReport: () => null,
    holds: () => [],
    autonomy: () => ({ on: false, mode: null }),
  };
  const safe = async (fn: () => Promise<void>): Promise<void> => {
    try { await fn(); } catch { /* keep the empty default */ }
  };
  await Promise.all([
    safe(async () => {
      const leader = await import('../vision/leader.js');
      base.leader = () => leader.buildLeaderState(Date.now());
    }),
    safe(async () => {
      const { listCloudTasks } = await import('../cloud/store.js');
      base.cloudTasks = () => listCloudTasks(100) as unknown as BriefTaskLike[];
    }),
    safe(async () => {
      const { listDevinTasks } = await import('../devin/store.js');
      base.devinTasks = () => listDevinTasks(100) as unknown as BriefTaskLike[];
    }),
    safe(async () => {
      const { listLeaderQuestions } = await import('../vision/leader-operator.js');
      base.openQuestion = () => {
        const cutoff = Date.now() - 7 * 86_400_000;
        const open = listLeaderQuestions().filter((q) => q.answer === null && Date.parse(q.askedAt) >= cutoff);
        const q = open[0];
        return q ? { questionId: q.questionId, text: q.text } : null;
      };
    }),
    safe(async () => {
      const { readDriveState } = await import('../vision/leader-drive.js');
      base.driveReport = () => readDriveState().lastReport?.text ?? null;
    }),
    safe(async () => {
      const { listRepoHolds } = await import('../fleet/quarantine.js');
      base.holds = () => listRepoHolds().map((h) => ({ repo: h.repo, kind: h.kind, reason: h.reason }));
    }),
    safe(async () => {
      const { currentStandingPolicy } = await import('../authority/effective-config.js');
      base.autonomy = () => {
        const p = currentStandingPolicy();
        return p ? { on: true, mode: p.switch } : { on: false, mode: null };
      };
    }),
  ]);
  return base;
}

function hhmm(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

/** Gather the brief from recorded state since `sinceMs`. Never throws. */
export async function gatherBriefFacts(sinceMs: number, nowMs: number, overrides: BriefSources = {}, timeZone = 'America/New_York'): Promise<BriefFacts> {
  const base = await defaults();
  const src = { ...base, ...Object.fromEntries(Object.entries(overrides).filter(([k, v]) => k !== 'digest' && typeof v === 'function')) } as Required<Omit<BriefSources, 'digest'>>;

  let digest: Awaited<ReturnType<typeof collectDigestFacts>> | null = null;
  try {
    digest = await collectDigestFacts(sinceMs, { ...(overrides.digest ?? {}), autonomy: src.autonomy });
  } catch {
    digest = null;
  }
  const events = digest?.events ?? [];
  const shipped: BriefItem[] = events
    .filter((e) => e.kind === 'merge' || (e.kind === 'cloud' && / merged\b/.test(e.text)))
    .map((e) => ({ text: e.text, ...(e.url ? { url: e.url } : {}) }));
  const prsOpened = events.filter((e) => e.kind === 'pr-opened').length;

  const running: BriefItem[] = [];
  for (const [lane, tasks] of [['cloud', call(src.cloudTasks, [])], ['Devin', call(src.devinTasks, [])]] as const) {
    for (const t of tasks) {
      if (!ACTIVE.has(t.state)) continue;
      const url = t.pr?.url ?? t.sessionUrl ?? undefined;
      const state = t.state === 'pr-open' ? 'PR open' : t.state;
      running.push({ text: `${lane} "${clip(t.title, 60)}" (${state})`, ...(url ? { url } : {}) });
    }
  }

  const leader = call(src.leader, null);
  const blockers: string[] = [];
  const health = leader?.health;
  if (health && (health.status === 'degraded' || health.status === 'down')) blockers.push(`Leader ${health.status}: ${clip(health.summary, 120)}`);
  for (const e of events) {
    if (e.kind === 'revert') blockers.push(`reverted ${clip(e.text, 80)}${e.url ? ` ${e.url}` : ''}`);
    if (e.kind === 'revert-failed') blockers.push(clip(e.text, 120));
  }
  const holds = call(src.holds, []);
  if (holds.length > 0) blockers.push(`${holds.length} repo hold${holds.length === 1 ? '' : 's'} (${holds.slice(0, 2).map((h) => `${h.repo}: ${clip(h.reason, 40)}`).join('; ')})`);
  const escalated = (leader?.actions ?? []).filter((a) => a.status === 'escalated' && Date.parse(a.createdAt) >= nowMs - 7 * 86_400_000);
  if (escalated.length > 0) blockers.push(`${escalated.length} ask${escalated.length === 1 ? '' : 's'} outside the grant wait on you`);
  const autonomy = call(src.autonomy, { on: false, mode: null });
  if (!autonomy.on) blockers.push(autonomyLine(autonomy));

  const next: string[] = [];
  const memo = leader?.latest;
  if (memo && memo.status === 'ok' && memo.move && nowMs - Date.parse(memo.at) <= 36 * 3_600_000) next.push(clip(memo.move.statement, 160));
  const pending = (leader?.actions ?? []).filter((a) => a.status === 'scheduled' && a.class === 'B' && a.applyAfter);
  for (const a of pending.slice(0, 2)) next.push(`"${clip(a.summary, 60)}" applies ${hhmm(a.applyAfter!, timeZone)} unless you veto`);
  if (pending.length > 2) next.push(`+${pending.length - 2} more waiting on their veto window`);
  const drive = call(src.driveReport, null);
  if (drive) next.push(clip(drive.split('\n')[0] ?? drive, 120));

  return {
    nowMs,
    sinceMs,
    shipped,
    prsOpened,
    running,
    blockers,
    next,
    question: call(src.openQuestion, null),
    pendingActionIds: pending.map((a) => a.id),
  };
}

function items(list: readonly BriefItem[]): string {
  const shown = list.slice(0, MAX_ITEMS).map((i) => `${i.text}${i.url ? ` ${i.url}` : ''}`);
  const more = list.length > MAX_ITEMS ? ` (+${list.length - MAX_ITEMS} more)` : '';
  return `${shown.join('; ')}${more}`;
}

function header(kind: BriefKind, nowMs: number, timeZone: string): string {
  const d = new Date(nowMs);
  let day: string;
  let time: string;
  try {
    day = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(d);
    time = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  } catch {
    day = d.toISOString().slice(0, 10);
    time = d.toISOString().slice(11, 16);
  }
  return kind === 'morning' ? `Morning brief · ${day}` : kind === 'evening' ? `Evening recap · ${day}` : `Status · ${time}`;
}

/**
 * The brief, phone-sized: one line per section (shipped, running, blockers,
 * next, one question), links inline, then the optional narrative. Pure.
 */
export function composeBrief(kind: BriefKind, facts: BriefFacts, opts: { narrative?: string | null; timeZone?: string } = {}): string {
  const tz = opts.timeZone ?? 'America/New_York';
  const lines = [header(kind, facts.nowMs, tz)];
  const opened = facts.prsOpened > 0 ? ` · ${facts.prsOpened} PR${facts.prsOpened === 1 ? '' : 's'} opened` : '';
  lines.push(facts.shipped.length > 0
    ? `Shipped: ${facts.shipped.length} — ${items(facts.shipped)}${opened}`
    : `Shipped: nothing merged${kind === 'morning' ? ' overnight' : kind === 'evening' ? ' today' : ' since the last brief'}${opened}.`);
  if (facts.running.length > 0) lines.push(`Running: ${facts.running.length} — ${items(facts.running)}`);
  lines.push(facts.blockers.length > 0 ? `Blockers: ${facts.blockers.slice(0, 3).join('; ')}` : 'Blockers: none.');
  if (facts.next.length > 0) lines.push(`Next: ${facts.next.slice(0, 3).join(' · ')}`);
  if (facts.question) lines.push(`Q: ${clip(facts.question.text, 200)} (reply to answer)`);
  const narrative = opts.narrative?.trim();
  if (narrative) lines.push(clip(narrative, 200));
  return lines.join('\n');
}

/** The plain-text facts handed to the narrative call (untrusted data there). */
export function briefFactsText(facts: BriefFacts): string {
  return composeBrief('instant', facts, { narrative: null });
}
