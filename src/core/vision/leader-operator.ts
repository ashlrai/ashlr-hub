/**
 * Operator input to the Leader (3.14) — what Mason tells the Leader, kept as
 * small durable records the memo run reads:
 *
 *   operator-directives.json — standing guidance ("focus on X", "stop doing
 *                              Y", "priority: Z"). Active until retired.
 *   operator-questions.json  — every question a memo asked Mason, with a
 *                              stable questionId, and his answer once given.
 *   operator-approvals.json  — actions Mason approved and what came of it.
 *
 * TRUST. Directive and answer TEXT is Mason's own (the operator — trusted):
 * the memo prompt carries it in a trusted block. Question text and action
 * summaries are the Leader's earlier model output (untrusted): the memo
 * prompt carries them in an UNTRUSTED DATA block, so a question that echoed
 * injected evidence can never be promoted to an instruction. A directive
 * steers the Leader's judgement only; it never widens the standing grant —
 * every action still goes through leader-apply.ts's policy check.
 *
 * Everything is scrubbed (secrets, home paths, emails) and length-capped
 * before it is stored. Files are 0600 in the 0700 Leader directory, written
 * atomically under one lock. Paths re-resolve homedir() per call (tests).
 *
 * NODE-ONLY and cheap: leader.ts (a Tier-1 root) imports this for the memo
 * evidence, so its imports are fs / crypto and the private-file helpers only.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { scrubPrivateText } from '../util/scrub.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';
import { leaderRoot } from './leader-memo.js';

// ---------------------------------------------------------------------------
// Vocabulary and limits
// ---------------------------------------------------------------------------

export const OPERATOR_DIRECTIVE_KINDS = ['focus', 'stop', 'priority', 'guidance'] as const;
export type OperatorDirectiveKind = (typeof OPERATOR_DIRECTIVE_KINDS)[number];

/** Where an operator input came from (the thread's channels). */
export type OperatorChannel = 'verse' | 'telegram' | 'cli' | 'system';
export const OPERATOR_CHANNELS: readonly OperatorChannel[] = ['verse', 'telegram', 'cli', 'system'];

export const OPERATOR_LIMITS = Object.freeze({
  /** Active directives at once — more than this is not "standing guidance", it is noise. */
  maxActiveDirectives: 20,
  /** Directive records kept (retired ones are trimmed oldest first). */
  keepDirectives: 200,
  directiveMaxChars: 300,
  keepQuestions: 300,
  answerMaxChars: 2_000,
  questionMaxChars: 500,
  keepApprovals: 200,
  /** Answers / approvals older than this stop feeding the memo prompt. */
  answerFeedDays: 30,
  approvalFeedDays: 14,
  feedMax: 10,
});

export function isOperatorDirectiveKind(value: unknown): value is OperatorDirectiveKind {
  return typeof value === 'string' && (OPERATOR_DIRECTIVE_KINDS as readonly string[]).includes(value);
}

export function isOperatorChannel(value: unknown): value is OperatorChannel {
  return typeof value === 'string' && (OPERATOR_CHANNELS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface OperatorDirective {
  v: 1;
  /** `od-<yyyymmddhhmmss>-<6 hex>` */
  id: string;
  kind: OperatorDirectiveKind;
  /** Mason's words (scrubbed, ≤ directiveMaxChars). */
  text: string;
  /**
   * explicit  — a `directive:` / `focus:` / `stop:` / `priority:` prefix in a message;
   * extracted — the Leader recognised standing guidance in Mason's message
   *             (an extraction call that saw ONLY his message, never evidence);
   * direct    — added through the directives route / CLI.
   */
  source: 'explicit' | 'extracted' | 'direct';
  channel: OperatorChannel;
  /** The thread message it came from; null when added directly. */
  messageId: string | null;
  createdAt: string;
  retiredAt: string | null;
  retiredVia: OperatorChannel | null;
}

export interface LeaderQuestionRecord {
  v: 1;
  /** `lq-<memo stamp>-<memo suffix>-<index>` — derived from the memo, so stable. */
  questionId: string;
  memoId: string;
  index: number;
  /** The Leader's question (UNTRUSTED model text, scrubbed). */
  text: string;
  askedAt: string;
  /** The thread message that asked it; null until posted. */
  messageId: string | null;
  answer: { text: string; at: string; channel: OperatorChannel; messageId: string | null } | null;
}

export type OperatorApprovalOutcome =
  | 'applied'
  | 'recorded-dry-run'
  | 'recorded-outside-grant'
  | 'refused';

export interface OperatorApproval {
  v: 1;
  actionId: string;
  memoId: string;
  kind: string;
  /** The action's summary (UNTRUSTED model text, scrubbed). */
  summary: string;
  at: string;
  channel: OperatorChannel;
  outcome: OperatorApprovalOutcome;
  detail: string;
}

// ---------------------------------------------------------------------------
// Ids and text
// ---------------------------------------------------------------------------

export const OPERATOR_DIRECTIVE_ID_RE = /^od-\d{14}-[a-f0-9]{6}$/;
export const LEADER_QUESTION_ID_RE = /^lq-\d{14}-[a-f0-9]{6}-\d{1,2}$/;
const MEMO_ID_RE = /^lm-(\d{14}-[a-f0-9]{6})$/;

function stamp(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

export function newOperatorId(prefix: string, nowMs: number): string {
  return `${prefix}-${stamp(nowMs)}-${randomBytes(3).toString('hex')}`;
}

/** The stable id of a memo's `index`-th question; null for a malformed memo id. */
export function questionIdFor(memoId: string, index: number): string | null {
  const m = MEMO_ID_RE.exec(memoId);
  if (!m || !Number.isInteger(index) || index < 0 || index > 99) return null;
  return `lq-${m[1]}-${index}`;
}

/**
 * Scrub + normalise operator text: control characters (except newline / tab)
 * out, secrets / home paths / emails redacted, trimmed, capped. Null when
 * nothing is left.
 */
export function cleanOperatorText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const stripped = value.replace(/[\u0000-\u0008\u000B-\u001F\u007F\u2028\u2029]/g, ' ').trim();
  if (stripped.length === 0) return null;
  const scrubbed = scrubPrivateText(stripped.slice(0, max * 2), { emails: true }).trim();
  if (scrubbed.length === 0) return null;
  return scrubbed.length > max ? `${scrubbed.slice(0, max - 1)}…` : scrubbed;
}

function normalizeForDedupe(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const MAX_FILE_BYTES = 512 * 1024;

export function operatorDirectivesPath(): string {
  return join(leaderRoot(), 'operator-directives.json');
}

export function operatorQuestionsPath(): string {
  return join(leaderRoot(), 'operator-questions.json');
}

export function operatorApprovalsPath(): string {
  return join(leaderRoot(), 'operator-approvals.json');
}

function readList<T>(path: string, key: string, valid: (x: unknown) => x is T): T[] {
  const read = readPrivateFileCapped(path, MAX_FILE_BYTES);
  if (!read || read.truncated) return [];
  try {
    const parsed = JSON.parse(read.text) as Record<string, unknown>;
    if (parsed['v'] !== 1 || !Array.isArray(parsed[key])) return [];
    return (parsed[key] as unknown[]).filter(valid);
  } catch {
    return [];
  }
}

function writeList(path: string, key: string, items: readonly unknown[], nowMs: number): void {
  ensurePrivateDirectory(leaderRoot());
  writePrivateFileAtomic(path, `${JSON.stringify({ v: 1, updatedAt: new Date(nowMs).toISOString(), [key]: items })}\n`);
}

/** Read-modify-write under the operator lock. */
function withOperatorLock<T>(fn: () => T): T {
  ensurePrivateDirectory(leaderRoot());
  const lock = acquireLocalStoreLock(join(leaderRoot(), '.operator.lock'), 5_000);
  if (!lock) throw new Error('the Leader operator store is busy');
  try {
    return fn();
  } finally {
    releaseLocalStoreLock(lock);
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isDirective(x: unknown): x is OperatorDirective {
  return isRecord(x) && x['v'] === 1 && typeof x['id'] === 'string' && OPERATOR_DIRECTIVE_ID_RE.test(x['id'])
    && isOperatorDirectiveKind(x['kind']) && typeof x['text'] === 'string' && typeof x['createdAt'] === 'string'
    && (x['retiredAt'] === null || typeof x['retiredAt'] === 'string');
}

function isQuestion(x: unknown): x is LeaderQuestionRecord {
  return isRecord(x) && x['v'] === 1 && typeof x['questionId'] === 'string' && LEADER_QUESTION_ID_RE.test(x['questionId'])
    && typeof x['memoId'] === 'string' && typeof x['text'] === 'string' && typeof x['askedAt'] === 'string'
    && (x['answer'] === null || (isRecord(x['answer']) && typeof x['answer']['text'] === 'string' && typeof x['answer']['at'] === 'string'));
}

function isApproval(x: unknown): x is OperatorApproval {
  return isRecord(x) && x['v'] === 1 && typeof x['actionId'] === 'string' && typeof x['at'] === 'string'
    && typeof x['outcome'] === 'string' && typeof x['summary'] === 'string';
}

// ---------------------------------------------------------------------------
// Directives
// ---------------------------------------------------------------------------

/** Newest first. Retired directives only when asked for. */
export function listOperatorDirectives(opts: { includeRetired?: boolean } = {}): OperatorDirective[] {
  const all = readList(operatorDirectivesPath(), 'directives', isDirective);
  return all.filter((d) => opts.includeRetired === true || d.retiredAt === null).reverse();
}

export type AddDirectiveResult =
  | { ok: true; directive: OperatorDirective; duplicate: boolean }
  | { ok: false; code: 400 | 409; reason: string };

export function addOperatorDirective(
  input: { kind: OperatorDirectiveKind; text: string; source: OperatorDirective['source']; channel: OperatorChannel; messageId?: string | null },
  nowMs: number = Date.now(),
): AddDirectiveResult {
  if (!isOperatorDirectiveKind(input.kind)) return { ok: false, code: 400, reason: `kind must be one of: ${OPERATOR_DIRECTIVE_KINDS.join(', ')}` };
  const text = cleanOperatorText(input.text, OPERATOR_LIMITS.directiveMaxChars);
  if (!text || text.length < 3) return { ok: false, code: 400, reason: 'a directive needs at least a few words' };
  return withOperatorLock((): AddDirectiveResult => {
    const all = readList(operatorDirectivesPath(), 'directives', isDirective);
    const active = all.filter((d) => d.retiredAt === null);
    const key = normalizeForDedupe(text);
    const same = active.find((d) => normalizeForDedupe(d.text) === key);
    if (same) return { ok: true, directive: same, duplicate: true };
    if (active.length >= OPERATOR_LIMITS.maxActiveDirectives) {
      return { ok: false, code: 409, reason: `${active.length} directives are already in force (limit ${OPERATOR_LIMITS.maxActiveDirectives}); retire one first.` };
    }
    const directive: OperatorDirective = {
      v: 1,
      id: newOperatorId('od', nowMs),
      kind: input.kind,
      text,
      source: input.source,
      channel: input.channel,
      messageId: input.messageId ?? null,
      createdAt: new Date(nowMs).toISOString(),
      retiredAt: null,
      retiredVia: null,
    };
    all.push(directive);
    // Trim retired records first; active ones are never dropped.
    let excess = all.length - OPERATOR_LIMITS.keepDirectives;
    const kept = excess > 0 ? all.filter((d) => (excess > 0 && d.retiredAt !== null ? (excess -= 1, false) : true)) : all;
    writeList(operatorDirectivesPath(), 'directives', kept, nowMs);
    return { ok: true, directive, duplicate: false };
  });
}

export type RetireDirectiveResult =
  | { ok: true; directive: OperatorDirective }
  | { ok: false; code: 400 | 404 | 409; reason: string };

export function retireOperatorDirective(id: string, via: OperatorChannel, nowMs: number = Date.now()): RetireDirectiveResult {
  if (!OPERATOR_DIRECTIVE_ID_RE.test(id)) return { ok: false, code: 400, reason: 'directive id is malformed' };
  return withOperatorLock((): RetireDirectiveResult => {
    const all = readList(operatorDirectivesPath(), 'directives', isDirective);
    const target = all.find((d) => d.id === id);
    if (!target) return { ok: false, code: 404, reason: `No directive ${id}.` };
    if (target.retiredAt !== null) return { ok: false, code: 409, reason: `Directive ${id} was already retired.` };
    target.retiredAt = new Date(nowMs).toISOString();
    target.retiredVia = via;
    writeList(operatorDirectivesPath(), 'directives', all, nowMs);
    return { ok: true, directive: target };
  });
}

// ---------------------------------------------------------------------------
// Questions and answers
// ---------------------------------------------------------------------------

/** Every recorded question, oldest first. */
export function listLeaderQuestions(): LeaderQuestionRecord[] {
  return readList(operatorQuestionsPath(), 'questions', isQuestion);
}

export function findLeaderQuestion(questionId: string): LeaderQuestionRecord | null {
  if (!LEADER_QUESTION_ID_RE.test(questionId)) return null;
  return listLeaderQuestions().find((q) => q.questionId === questionId) ?? null;
}

/**
 * Record a memo's questions (idempotent — a question already on file keeps
 * its record, answer included). Returns the records for this memo, in order.
 */
export function registerLeaderQuestions(
  memo: { id: string; at: string; questionsForMason: readonly string[] },
  nowMs: number = Date.now(),
): LeaderQuestionRecord[] {
  const wanted = memo.questionsForMason.flatMap((raw, index) => {
    const questionId = questionIdFor(memo.id, index);
    const text = cleanOperatorText(raw, OPERATOR_LIMITS.questionMaxChars);
    return questionId && text ? [{ questionId, index, text }] : [];
  });
  if (wanted.length === 0) return [];
  return withOperatorLock(() => {
    const all = listLeaderQuestions();
    const byId = new Map(all.map((q) => [q.questionId, q]));
    let added = false;
    const out: LeaderQuestionRecord[] = [];
    for (const w of wanted) {
      const existing = byId.get(w.questionId);
      if (existing) {
        out.push(existing);
        continue;
      }
      const record: LeaderQuestionRecord = {
        v: 1, questionId: w.questionId, memoId: memo.id, index: w.index, text: w.text, askedAt: memo.at, messageId: null, answer: null,
      };
      all.push(record);
      byId.set(record.questionId, record);
      out.push(record);
      added = true;
    }
    if (added) writeList(operatorQuestionsPath(), 'questions', all.slice(-OPERATOR_LIMITS.keepQuestions), nowMs);
    return out;
  });
}

/** Link a question to the thread message that asked it. */
export function setLeaderQuestionMessage(questionId: string, messageId: string, nowMs: number = Date.now()): void {
  withOperatorLock(() => {
    const all = listLeaderQuestions();
    const q = all.find((x) => x.questionId === questionId);
    if (!q || q.messageId === messageId) return;
    q.messageId = messageId;
    writeList(operatorQuestionsPath(), 'questions', all, nowMs);
  });
}

export type RecordAnswerResult =
  | { ok: true; question: LeaderQuestionRecord }
  | { ok: false; code: 400 | 404; reason: string };

/**
 * Record Mason's answer. A second answer replaces the first (he may refine
 * it); the memo run always reads the latest.
 */
export function recordLeaderAnswer(
  questionId: string,
  input: { text: string; channel: OperatorChannel; messageId: string | null },
  nowMs: number = Date.now(),
): RecordAnswerResult {
  if (!LEADER_QUESTION_ID_RE.test(questionId)) return { ok: false, code: 400, reason: 'questionId is malformed' };
  const text = cleanOperatorText(input.text, OPERATOR_LIMITS.answerMaxChars);
  if (!text) return { ok: false, code: 400, reason: 'the answer is empty' };
  return withOperatorLock((): RecordAnswerResult => {
    const all = listLeaderQuestions();
    const q = all.find((x) => x.questionId === questionId);
    if (!q) return { ok: false, code: 404, reason: `No Leader question ${questionId}.` };
    q.answer = { text, at: new Date(nowMs).toISOString(), channel: input.channel, messageId: input.messageId };
    writeList(operatorQuestionsPath(), 'questions', all, nowMs);
    return { ok: true, question: q };
  });
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/** Newest first. */
export function listOperatorApprovals(limit = 50): OperatorApproval[] {
  return readList(operatorApprovalsPath(), 'approvals', isApproval).slice(-limit).reverse();
}

export function recordOperatorApproval(input: Omit<OperatorApproval, 'v' | 'at' | 'summary' | 'detail'> & { summary: string; detail: string }, nowMs: number = Date.now()): OperatorApproval {
  const approval: OperatorApproval = {
    v: 1,
    actionId: input.actionId,
    memoId: input.memoId,
    kind: input.kind,
    summary: cleanOperatorText(input.summary, 200) ?? '',
    at: new Date(nowMs).toISOString(),
    channel: input.channel,
    outcome: input.outcome,
    detail: cleanOperatorText(input.detail, 400) ?? '',
  };
  withOperatorLock(() => {
    const all = readList(operatorApprovalsPath(), 'approvals', isApproval);
    all.push(approval);
    writeList(operatorApprovalsPath(), 'approvals', all.slice(-OPERATOR_LIMITS.keepApprovals), nowMs);
  });
  return approval;
}

// ---------------------------------------------------------------------------
// What the memo run reads
// ---------------------------------------------------------------------------

/**
 * The operator section of the Leader's evidence. `trusted` is Mason's own
 * words and his decisions (rendered as a trusted block); `untrusted` is the
 * Leader's earlier wording those decisions refer to (rendered as UNTRUSTED
 * DATA). Both are keyed by id so the model can join them.
 */
export interface LeaderOperatorContext {
  trusted: {
    directives: { id: string; kind: OperatorDirectiveKind; text: string; since: string }[];
    answers: { questionId: string; answer: string; answeredOn: string }[];
    approvals: { actionId: string; kind: string; outcome: OperatorApprovalOutcome; on: string }[];
  };
  untrusted: {
    answeredQuestions: { questionId: string; question: string }[];
    approvedActions: { actionId: string; summary: string }[];
  };
}

/** Null when Mason has given the Leader nothing (keeps the evidence digest as it was). */
export function readLeaderOperatorContext(nowMs: number): LeaderOperatorContext | null {
  const directives = listOperatorDirectives()
    .slice(0, OPERATOR_LIMITS.maxActiveDirectives)
    .map((d) => ({ id: d.id, kind: d.kind, text: d.text, since: d.createdAt.slice(0, 10) }));
  const answerSince = nowMs - OPERATOR_LIMITS.answerFeedDays * 86_400_000;
  const answered = listLeaderQuestions()
    .filter((q) => q.answer !== null && Date.parse(q.answer.at) >= answerSince)
    .sort((a, b) => Date.parse(b.answer!.at) - Date.parse(a.answer!.at))
    .slice(0, OPERATOR_LIMITS.feedMax);
  const approvalSince = nowMs - OPERATOR_LIMITS.approvalFeedDays * 86_400_000;
  const approvals = listOperatorApprovals(OPERATOR_LIMITS.keepApprovals)
    .filter((a) => Date.parse(a.at) >= approvalSince)
    .slice(0, OPERATOR_LIMITS.feedMax);
  if (directives.length === 0 && answered.length === 0 && approvals.length === 0) return null;
  return {
    trusted: {
      directives,
      answers: answered.map((q) => ({ questionId: q.questionId, answer: q.answer!.text, answeredOn: q.answer!.at.slice(0, 10) })),
      approvals: approvals.map((a) => ({ actionId: a.actionId, kind: a.kind, outcome: a.outcome, on: a.at.slice(0, 10) })),
    },
    untrusted: {
      answeredQuestions: answered.map((q) => ({ questionId: q.questionId, question: q.text })),
      approvedActions: approvals.map((a) => ({ actionId: a.actionId, summary: a.summary })),
    },
  };
}
