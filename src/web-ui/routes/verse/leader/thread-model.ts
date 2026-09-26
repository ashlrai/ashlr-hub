/**
 * routes/verse/leader/thread-model.ts — pure helpers behind the Leader
 * conversation on Mind (and its one-line preview on Command).
 *
 *   narrow*        every body the page reads, checked field by field: a
 *                  message the page cannot read is dropped, never guessed;
 *   mergeThread    server pages + replies this tab already received + the
 *                  optimistic sends still in flight, in time order, each
 *                  message once (an optimistic send disappears as soon as its
 *                  server copy is in any of the lists);
 *   groupThread    day separators and runs of consecutive messages from one
 *                  sender on one channel (Linear-style: one header per run);
 *   questions      which question messages are answered, and which one a
 *                  Needs-you item means;
 *   awaitingReply  "Leader is thinking…" — honest: only for a message THIS
 *                  tab sent that the server said it would answer later.
 *
 * Framework-free; tested directly (thread-model.test.ts).
 */
import {
  LEADER_THREAD_CHANNELS,
  LEADER_THREAD_KINDS,
  type LeaderSendResult,
  type LeaderThreadChannel,
  type LeaderThreadKind,
  type LeaderThreadMessage,
  type LeaderThreadPage,
  type OperatorDirective,
} from './thread-types.js';
import { parseNeedsYouQuestion } from './question-id.js';

export { parseNeedsYouQuestion };

// ---------------------------------------------------------------------------
// Narrowing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const optString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** One message, or null when a required field is missing or out of vocabulary. */
export function narrowMessage(raw: unknown): LeaderThreadMessage | null {
  if (!isRecord(raw)) return null;
  const { id, at, from, channel, kind, text } = raw;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return null;
  if (from !== 'mason' && from !== 'leader') return null;
  if (typeof text !== 'string') return null;
  // An unknown channel or kind from a newer server still reads as a message.
  const ch = LEADER_THREAD_CHANNELS.includes(channel as LeaderThreadChannel) ? (channel as LeaderThreadChannel) : 'verse';
  const k = LEADER_THREAD_KINDS.includes(kind as LeaderThreadKind) ? (kind as LeaderThreadKind) : 'message';
  const actionIds = Array.isArray(raw['actionIds']) ? raw['actionIds'].filter((a): a is string => typeof a === 'string' && a.length > 0) : null;
  let delivery: Record<string, string> | null = null;
  if (isRecord(raw['delivery'])) {
    const entries = Object.entries(raw['delivery']).filter((e): e is [string, string] => typeof e[1] === 'string');
    delivery = entries.length ? Object.fromEntries(entries) : null;
  }
  return {
    id,
    at,
    from,
    channel: ch,
    kind: k,
    text,
    replyTo: optString(raw['replyTo']),
    memoId: optString(raw['memoId']),
    questionId: optString(raw['questionId']),
    actionIds: actionIds && actionIds.length ? actionIds : null,
    delivery,
  };
}

/** `{ messages: [...] }` (or a bare array); null when neither. Unreadable messages are dropped. */
export function narrowThreadPage(raw: unknown): LeaderThreadPage | null {
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw['messages']) ? raw['messages'] : null;
  if (!list) return null;
  return { messages: list.flatMap((m) => narrowMessage(m) ?? []) };
}

export function narrowDirective(raw: unknown): OperatorDirective | null {
  if (!isRecord(raw)) return null;
  const { id, text } = raw;
  if (typeof id !== 'string' || id.length === 0 || typeof text !== 'string' || text.trim().length === 0) return null;
  // A retired directive is history, not a chip.
  if (optString(raw['retiredAt']) !== null || raw['active'] === false) return null;
  const at = optString(raw['at']) ?? optString(raw['addedAt']) ?? optString(raw['createdAt']);
  const channel = LEADER_THREAD_CHANNELS.includes(raw['channel'] as LeaderThreadChannel)
    ? (raw['channel'] as LeaderThreadChannel)
    : LEADER_THREAD_CHANNELS.includes(raw['source'] as LeaderThreadChannel)
      ? (raw['source'] as LeaderThreadChannel)
      : null;
  return { id, text: text.trim(), at, channel };
}

/** `{ directives: [...] }` (or a bare array) → the ACTIVE ones, oldest first. */
export function narrowDirectives(raw: unknown): OperatorDirective[] | null {
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw['directives']) ? raw['directives'] : null;
  if (!list) return null;
  const out = list.flatMap((d) => narrowDirective(d) ?? []);
  return out.sort((a, b) => (Date.parse(a.at ?? '') || 0) - (Date.parse(b.at ?? '') || 0));
}

export function narrowSendResult(raw: unknown): LeaderSendResult | null {
  if (!isRecord(raw)) return null;
  const message = narrowMessage(raw['message']);
  if (!message) return null;
  return { message, reply: narrowMessage(raw['reply']), directive: narrowDirective(raw['directive']) };
}

// ---------------------------------------------------------------------------
// Optimistic sends and the merge
// ---------------------------------------------------------------------------

export interface PendingMessage {
  /** Local id ("local-3"); never a server id. */
  clientId: string;
  kind: 'message' | 'answer';
  text: string;
  /** Local ISO time the send started. */
  at: string;
  replyTo: string | null;
  /** For an answer: the question it answers. */
  questionId: string | null;
  state: 'sending' | 'failed';
  /** Operator sentence for a failed send. */
  error: string | null;
}

export type ThreadEntry =
  | { type: 'message'; key: string; at: string; message: LeaderThreadMessage }
  | { type: 'pending'; key: string; at: string; pending: PendingMessage };

/**
 * A server message that is the delivered copy of an optimistic send: from
 * Mason, the same words, not older than the send (allowing CLOCK_SLACK_MS
 * for a server clock a little behind this tab's).
 */
const CLOCK_SLACK_MS = 2 * 60_000;
const norm = (t: string) => t.replace(/\s+/g, ' ').trim();

function isCopyOf(m: LeaderThreadMessage, p: PendingMessage): boolean {
  if (m.from !== 'mason') return false;
  if (norm(m.text) !== norm(p.text)) return false;
  if (p.kind === 'answer' && p.questionId && m.questionId && m.questionId !== p.questionId) return false;
  return Date.parse(m.at) >= Date.parse(p.at) - CLOCK_SLACK_MS;
}

const byTime = (a: { at: string; key: string }, b: { at: string; key: string }) => Date.parse(a.at) - Date.parse(b.at) || 0;

/**
 * Everything known, oldest first, each message once. `pages` are server
 * reads (newest page first or last — order does not matter); `received` are
 * messages this tab got back from a send (its own message and the reply)
 * before the next read; `pending` are sends still in flight or failed.
 */
export function mergeThread(
  pages: readonly (readonly LeaderThreadMessage[])[],
  received: readonly LeaderThreadMessage[] = [],
  pending: readonly PendingMessage[] = [],
): ThreadEntry[] {
  const byId = new Map<string, LeaderThreadMessage>();
  // Server reads win over a send's echo: they are newer (a status may have moved).
  for (const m of received) byId.set(m.id, m);
  for (const page of pages) for (const m of page) byId.set(m.id, m);
  const messages = [...byId.values()];
  const claimed = new Set<string>();
  const live: PendingMessage[] = [];
  for (const p of pending) {
    // A failed send stays until retried or discarded: its words never arrived.
    const copy = p.state === 'sending' ? messages.find((m) => !claimed.has(m.id) && isCopyOf(m, p)) : undefined;
    if (copy) claimed.add(copy.id);
    else live.push(p);
  }
  // Stable: equal times keep server order, and pending sends sit after the messages of their instant.
  const entries: ThreadEntry[] = [
    ...messages.map((message) => ({ type: 'message' as const, key: message.id, at: message.at, message })),
    ...live.map((p) => ({ type: 'pending' as const, key: p.clientId, at: p.at, pending: p })),
  ];
  return entries.map((e, i) => ({ e, i })).sort((x, y) => byTime(x.e, y.e) || x.i - y.i).map(({ e }) => e);
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export const GROUP_GAP_MS = 5 * 60_000;

export type ThreadRow =
  | { type: 'day'; key: string; label: string }
  | { type: 'group'; key: string; from: 'mason' | 'leader'; channel: LeaderThreadChannel; at: string; entries: ThreadEntry[] }
  /** A system line (a channel note, an update from `system`), centred and quiet. */
  | { type: 'system'; key: string; entry: ThreadEntry & { type: 'message' } };

function entryFrom(e: ThreadEntry): 'mason' | 'leader' {
  return e.type === 'pending' ? 'mason' : e.message.from;
}
function entryChannel(e: ThreadEntry): LeaderThreadChannel {
  return e.type === 'pending' ? 'verse' : e.message.channel;
}
/** Memos and directives are cards and chips: each stands alone, never folded into a run. */
function standsAlone(e: ThreadEntry): boolean {
  return e.type === 'message' && (e.message.kind === 'memo' || e.message.kind === 'directive');
}

function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** "Today", "Yesterday", "Thu, Sep 24" (local). */
export function dayLabel(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  if (dayKey(t) === dayKey(now)) return 'Today';
  if (dayKey(t) === dayKey(now - 86_400_000)) return 'Yesterday';
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

export function groupThread(entries: readonly ThreadEntry[], now: number = Date.now()): ThreadRow[] {
  const rows: ThreadRow[] = [];
  let day: string | null = null;
  let run: Extract<ThreadRow, { type: 'group' }> | null = null;
  let lastAt = 0;
  for (const e of entries) {
    const t = Date.parse(e.at);
    const k = dayKey(t);
    if (k !== day) {
      day = k;
      rows.push({ type: 'day', key: `day-${k}`, label: dayLabel(e.at, now) });
      run = null;
    }
    if (e.type === 'message' && e.message.channel === 'system') {
      rows.push({ type: 'system', key: e.key, entry: e });
      run = null;
      continue;
    }
    const from = entryFrom(e);
    const channel = entryChannel(e);
    const joins = run !== null && !standsAlone(e) && !standsAlone(run.entries[run.entries.length - 1]!) && run.from === from && run.channel === channel && t - lastAt <= GROUP_GAP_MS;
    if (joins && run) run.entries.push(e);
    else {
      run = { type: 'group', key: `g-${e.key}`, from, channel, at: e.at, entries: [e] };
      rows.push(run);
    }
    lastAt = t;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/** question message id → the answer that closed it. */
export function answeredQuestions(messages: readonly LeaderThreadMessage[]): Map<string, LeaderThreadMessage> {
  const questions = messages.filter((m) => m.kind === 'question');
  const out = new Map<string, LeaderThreadMessage>();
  for (const a of messages) {
    if (a.from !== 'mason' || (a.kind !== 'answer' && !a.replyTo)) continue;
    const q = questions.find((q) => (a.questionId && q.questionId === a.questionId) || (a.replyTo && q.id === a.replyTo));
    if (q && !out.has(q.id)) out.set(q.id, a);
  }
  return out;
}

export interface QuestionTarget {
  /** The Needs-you item id, or the server's own question id. */
  questionId?: string | null;
  memoId?: string | null;
  index?: number | null;
  text?: string | null;
}

/**
 * Which question message a target means. Tried in order of certainty: the
 * exact question id; `<memoId>:<index>` in any spelling that ends with it;
 * the memo's question with the same words; the memo's index-th question.
 */
export function findQuestion(messages: readonly LeaderThreadMessage[], target: QuestionTarget): LeaderThreadMessage | null {
  const questions = messages.filter((m) => m.kind === 'question');
  if (target.questionId) {
    const exact = questions.find((q) => q.questionId === target.questionId || q.id === target.questionId);
    if (exact) return exact;
  }
  const parsed = target.questionId ? parseNeedsYouQuestion(target.questionId) : null;
  const memoId = target.memoId ?? parsed?.memoId ?? null;
  const index = target.index ?? parsed?.index ?? null;
  if (memoId !== null && index !== null) {
    const suffix = `${memoId}:${index}`;
    const bySuffix = questions.find((q) => q.questionId === suffix || (q.questionId?.endsWith(`:${suffix}`) ?? false));
    if (bySuffix) return bySuffix;
  }
  const ofMemo = memoId !== null ? questions.filter((q) => q.memoId === memoId) : [];
  if (target.text) {
    const want = norm(target.text).toLowerCase();
    const byText = (ofMemo.length ? ofMemo : questions).find((q) => norm(q.text).toLowerCase() === want || norm(q.text).toLowerCase().includes(want));
    if (byText) return byText;
  }
  if (index !== null && ofMemo[index]) return ofMemo[index]!;
  return null;
}

// ---------------------------------------------------------------------------
// Waiting, previews, words
// ---------------------------------------------------------------------------

/** How long "Leader is thinking…" may show for a send the server said it would answer later. */
export const AWAIT_REPLY_MS = 3 * 60_000;

/**
 * True while a send is in flight, or while a message this tab sent (with no
 * inline reply) is still the newest thing Mason said and nothing from the
 * Leader has come after it — for at most AWAIT_REPLY_MS.
 */
export function awaitingReply(entries: readonly ThreadEntry[], awaiting: ReadonlySet<string>, now: number = Date.now()): boolean {
  if (entries.some((e) => e.type === 'pending' && e.pending.state === 'sending')) return true;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i]!;
    if (e.type !== 'message' || e.message.channel === 'system') continue;
    if (e.message.from === 'leader') return false;
    if (awaiting.has(e.message.id)) return now - Date.parse(e.message.at) < AWAIT_REPLY_MS;
  }
  return false;
}

export const CHANNEL_LABEL: Readonly<Record<LeaderThreadChannel, string>> = {
  verse: 'Verse',
  telegram: 'Telegram',
  cli: 'CLI',
  system: 'System',
};

/** The newest message from the Leader (Command's preview line). */
export function latestLeaderMessage(messages: readonly LeaderThreadMessage[]): LeaderThreadMessage | null {
  let best: LeaderThreadMessage | null = null;
  for (const m of messages) {
    if (m.from !== 'leader' || m.channel === 'system') continue;
    if (!best || Date.parse(m.at) >= Date.parse(best.at)) best = m;
  }
  return best;
}

/**
 * One line of plain text from a message that may be Markdown: fences, marks
 * and link targets dropped, whitespace collapsed, clipped on a word.
 */
export function previewText(text: string, max = 140): string {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:–—-]+$/, '')}…`;
}

/** "9:14 AM" */
export function clockTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
}

/** Longest message the composer sends (the server may cap lower and say so). */
export const LEADER_MESSAGE_MAX = 4_000;
