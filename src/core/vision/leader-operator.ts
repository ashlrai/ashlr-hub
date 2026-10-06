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
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { lstatSync } from 'node:fs';

import { fsyncDirectory } from '../util/durability.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { scrubPrivateText } from '../util/scrub.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';
import { leaderRoot, normalizeLeaderQuestionForms } from './leader-memo.js';
import type { LeaderMemoQuestionForm } from './leader-types.js';
import { LEADER_QUESTION_FORM_LIMITS, parseLeaderQuestionSubmission, type LeaderQuestionAcceptance, type LeaderQuestionForm, type LeaderQuestionProjection, type LeaderQuestionSubmission } from './leader-thread-types.js';
import { OPERATOR_DIRECTIVE_MAX, type OperatorChannel, type OperatorDirective, type OperatorDirectiveKind } from './leader-thread-types.js';

export type { OperatorChannel, OperatorDirective, OperatorDirectiveKind } from './leader-thread-types.js';

// ---------------------------------------------------------------------------
// Vocabulary and limits
// ---------------------------------------------------------------------------

export const OPERATOR_DIRECTIVE_KINDS: readonly OperatorDirectiveKind[] = ['focus', 'stop', 'priority', 'guidance'];

/** Where an operator input came from (the thread's channels). */
export const OPERATOR_CHANNELS: readonly OperatorChannel[] = ['verse', 'telegram', 'cli', 'system'];

export const OPERATOR_LIMITS = Object.freeze({
  /** Active directives at once — more than this is not "standing guidance", it is noise. */
  maxActiveDirectives: 20,
  /** Directive records kept (retired ones are trimmed oldest first). */
  keepDirectives: 200,
  /** Shared with the Verse directive box (leader-thread-types.ts). */
  directiveMaxChars: OPERATOR_DIRECTIVE_MAX,
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

export interface LeaderQuestionRecord {
  v: 1;
  /** `<memoId>:<index>` — derived from the memo, so stable (= the Needs-you item id's tail). */
  questionId: string;
  memoId: string;
  index: number;
  /** The Leader's question (UNTRUSTED model text, scrubbed). */
  text: string;
  askedAt: string;
  /** The thread message that asked it; null until posted. */
  messageId: string | null;
  questionForm?: LeaderQuestionForm;
  answer: { text: string; at: string; channel: OperatorChannel; messageId: string | null; typedAcceptance?: LeaderQuestionAcceptance } | null;
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
export const LEADER_QUESTION_ID_RE = /^lm-\d{14}-[a-f0-9]{6}:\d{1,2}$/;
const MEMO_ID_RE = /^lm-\d{14}-[a-f0-9]{6}$/;

function stamp(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

export function newOperatorId(prefix: string, nowMs: number): string {
  return `${prefix}-${stamp(nowMs)}-${randomBytes(3).toString('hex')}`;
}

/**
 * The stable id of a memo's `index`-th question: `<memoId>:<index>` — exactly
 * the tail of its Needs-you item id (`leader:leader-question:<memoId>:<index>`).
 * Null for a malformed memo id.
 */
export function questionIdFor(memoId: string, index: number): string | null {
  if (!MEMO_ID_RE.test(memoId) || !Number.isInteger(index) || index < 0 || index > 99) return null;
  return `${memoId}:${index}`;
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
  const content = `${JSON.stringify({ v: 1, updatedAt: new Date(nowMs).toISOString(), [key]: items })}\n`;
  if (path === operatorQuestionsPath()) writeQuestionPrivateFile(path, content);
  else writePrivateFileAtomic(path, content);
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

/** Protect each newly published inode; Windows inherited ACLs are not an exact private DACL. */
function writeQuestionPrivateFile(path: string, content: string): void {
  writePrivateFileAtomic(path, content);
  const rootBefore = lstatSync(leaderRoot(), { bigint: true });
  const before = lstatSync(path, { bigint: true });
  const owned = (uid: bigint): boolean => typeof process.getuid !== 'function' || uid === BigInt(process.getuid());
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink() || !owned(rootBefore.uid) ||
    !before.isFile() || before.isSymbolicLink() || !owned(before.uid) || before.nlink !== 1n ||
    before.size !== BigInt(Buffer.byteLength(content)) || process.platform !== 'win32' &&
    ((rootBefore.mode & 0o7777n) !== 0o700n || (before.mode & 0o7777n) !== 0o600n) ||
    !assurePrivateStoragePath(path, 'file', 'secure-created', { anchorPath: leaderRoot() }).ok) {
    throw new Error('Leader question state is unavailable');
  }
  const after = lstatSync(path, { bigint: true });
  const rootAfter = lstatSync(leaderRoot(), { bigint: true });
  if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || before.dev !== after.dev ||
    before.ino !== after.ino || before.uid !== after.uid || before.size !== after.size || before.mode !== after.mode ||
    !rootAfter.isDirectory() || rootAfter.isSymbolicLink() || rootBefore.dev !== rootAfter.dev ||
    rootBefore.ino !== rootAfter.ino || rootBefore.uid !== rootAfter.uid || rootBefore.mode !== rootAfter.mode) {
    throw new Error('Leader question state is unavailable');
  }
}

/** Exact private reads are shared by the question container and initialization marker. */
function readQuestionPrivateJson(path: string, maxBytes: number): unknown {
  const rootBefore = lstatSync(leaderRoot(), { bigint: true });
  const before = lstatSync(path, { bigint: true });
  const owned = (uid: bigint): boolean => typeof process.getuid !== 'function' || uid === BigInt(process.getuid());
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink() || !owned(rootBefore.uid) ||
    !before.isFile() || before.isSymbolicLink() || !owned(before.uid) || before.nlink !== 1n ||
    process.platform !== 'win32' && ((rootBefore.mode & 0o7777n) !== 0o700n || (before.mode & 0o7777n) !== 0o600n) ||
    !assurePrivateStoragePath(path, 'file', 'inspect-existing', { anchorPath: leaderRoot() }).ok) {
    throw new Error('Leader question state is unavailable');
  }
  const read = readPrivateFileCapped(path, maxBytes);
  const after = lstatSync(path, { bigint: true });
  const rootAfter = lstatSync(leaderRoot(), { bigint: true });
  if (!read || read.truncated || before.dev !== after.dev || before.ino !== after.ino ||
    before.mode !== after.mode || before.uid !== after.uid || before.size !== after.size ||
    before.ctimeNs !== after.ctimeNs || rootBefore.dev !== rootAfter.dev || rootBefore.ino !== rootAfter.ino ||
    rootBefore.mode !== rootAfter.mode || rootBefore.uid !== rootAfter.uid || rootBefore.ctimeNs !== rootAfter.ctimeNs) {
    throw new Error('Leader question state is unavailable');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(read.text); } catch { throw new Error('Leader question state is unavailable'); }
  return parsed;
}

function questionInitializationPath(): string { return join(leaderRoot(), 'question-initialized.json'); }

function readQuestionInitialization(): boolean {
  try { lstatSync(questionInitializationPath()); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error('Leader question state is unavailable');
  }
  const marker = readQuestionPrivateJson(questionInitializationPath(), 1_024);
  if (!isRecord(marker) || Object.keys(marker).sort().join(',') !== 'initialized,schemaVersion' ||
    marker['schemaVersion'] !== 1 || marker['initialized'] !== true) throw new Error('Leader question state is unavailable');
  return true;
}

/** Called only under the operator lock; never reconstructs a marked missing store. */
function ensureQuestionInitialization(nowMs: number): void {
  if (readQuestionInitialization()) {
    // A prior initializer may have renamed the marker before a durability failure.
    fsyncDirectory(leaderRoot());
    return;
  }
  let missing = false;
  try { lstatSync(operatorQuestionsPath()); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing = true;
    else throw new Error('Leader question state is unavailable');
  }
  if (missing) {
    writeList(operatorQuestionsPath(), 'questions', [], nowMs);
    fsyncDirectory(leaderRoot());
  } else readQuestionsStrict();
  writeQuestionPrivateFile(questionInitializationPath(), JSON.stringify({ schemaVersion: 1, initialized: true }) + '\n');
  fsyncDirectory(leaderRoot());
  readQuestionInitialization();
}

/** Typed controls never interpret an unreadable/malformed store as unanswered. */
function readQuestionsStrict(): LeaderQuestionRecord[] {
  readQuestionInitialization();
  const parsed = readQuestionPrivateJson(operatorQuestionsPath(), MAX_FILE_BYTES);
  if (!isRecord(parsed) || parsed['v'] !== 1 || !Array.isArray(parsed['questions']) ||
    parsed['questions'].length > OPERATOR_LIMITS.keepQuestions ||
    !parsed['questions'].every((row) => isQuestion(row) &&
      questionIdFor(row.memoId, row.index) === row.questionId &&
      (row.messageId === null || typeof row.messageId === 'string'))) {
    throw new Error('Leader question state is unavailable');
  }
  const questions = parsed['questions'] as LeaderQuestionRecord[];
  if (new Set(questions.map((q) => q.questionId)).size !== questions.length) {
    throw new Error('Leader question state is unavailable');
  }
  return questions;
}

function questionFormFor(
  question: Pick<LeaderQuestionRecord, 'questionId' | 'text' | 'askedAt' | 'index'>,
  form: LeaderMemoQuestionForm,
): LeaderQuestionForm | null {
  const askedAt = Date.parse(question.askedAt);
  if (!Number.isFinite(askedAt)) return null;
  const expiry = askedAt + LEADER_QUESTION_FORM_LIMITS.presentationMaxAgeMs;
  if (!Number.isFinite(new Date(expiry).getTime())) return null;
  const expiresAt = new Date(expiry).toISOString();
  const payload = { questionId: question.questionId, text: question.text, askedAt: question.askedAt,
    index: question.index, mode: form.mode, ...(form.options ? { options: form.options } : {}), expiresAt };
  return { schemaVersion: 1, revision: createHash('sha256').update(JSON.stringify(payload)).digest('hex').replace(/(.{8})(?=.)/g, '$1-'),
    mode: form.mode, ...(form.options ? { options: [...form.options] } : {}), expiresAt };
}

function currentQuestionForm(question: LeaderQuestionRecord): LeaderQuestionForm | null {
  const form = question.questionForm;
  if (!form || form.schemaVersion !== 1 ||
    Object.keys(form).sort().join(',') !== (form.mode === 'short-answer'
      ? 'expiresAt,mode,revision,schemaVersion' : 'expiresAt,mode,options,revision,schemaVersion')) return null;
  const forms = normalizeLeaderQuestionForms([{ index: 0, mode: form.mode,
    ...(form.options !== undefined ? { options: form.options } : {}) }], [question.text]);
  if (!forms || !forms[0]) return null;
  const expected = questionFormFor(question, { ...forms[0], index: question.index });
  return expected && expected.revision === form.revision && expected.expiresAt === form.expiresAt &&
    JSON.stringify(expected.options) === JSON.stringify(form.options) ? expected : null;
}

/** Safe exact read projection; fields outside the question contract never leave the store. */
export function projectLeaderQuestion(question: LeaderQuestionRecord): LeaderQuestionProjection {
  const form = currentQuestionForm(question);
  if (question.questionForm !== undefined && !form) throw new Error('Leader question state is unavailable');
  const answer = question.answer;
  let projectedAnswer: LeaderQuestionProjection['answer'] = null;
  if (answer) {
    const text = cleanOperatorText(answer.text, OPERATOR_LIMITS.answerMaxChars);
    if (!text || !isOperatorChannel(answer.channel) || !Number.isFinite(Date.parse(answer.at)) ||
      !(answer.messageId === null || typeof answer.messageId === 'string')) {
      throw new Error('Leader question state is unavailable');
    }
    projectedAnswer = { text, at: answer.at, channel: answer.channel, messageId: answer.messageId };
    const acceptance = answer.typedAcceptance;
    if (acceptance && form && acceptance.schemaVersion === 1 && acceptance.formRevision === form.revision &&
      acceptance.text === text && acceptance.at === answer.at && acceptance.messageId === answer.messageId) {
      const parsed = parseLeaderQuestionSubmission({ schemaVersion: 1, formRevision: acceptance.formRevision,
        kind: acceptance.kind, ...(acceptance.kind === 'options'
          ? { optionIndices: acceptance.optionIndices } : { text: acceptance.text }) });
      const exactValue = parsed && (parsed.kind === 'text' ? form.mode === 'short-answer' :
        form.options && form.mode !== 'short-answer' && (form.mode !== 'single' || parsed.optionIndices.length === 1) &&
        parsed.optionIndices.every((index, position) => index < form.options!.length &&
          (position === 0 || index > parsed.optionIndices[position - 1]!)) &&
        parsed.optionIndices.map((index) => form.options![index]!).join('; ') === text);
      if (parsed && exactValue) projectedAnswer.typedAcceptance = { schemaVersion: 1, formRevision: form.revision,
        kind: parsed.kind, ...(parsed.kind === 'options' ? { optionIndices: [...parsed.optionIndices] } : {}),
        text, at: answer.at, messageId: answer.messageId };
    }
  }
  const text = cleanOperatorText(question.text, OPERATOR_LIMITS.questionMaxChars);
  if (!text || !Number.isFinite(Date.parse(question.askedAt))) throw new Error('Leader question state is unavailable');
  return { questionId: question.questionId, text, askedAt: question.askedAt, messageId: question.messageId,
    ...(form ? { questionForm: form } : {}), answered: answer !== null, answer: projectedAnswer };
}

export function readLeaderQuestionStrict(questionId: string): LeaderQuestionProjection | null {
  const question = readQuestionsStrict().find((q) => q.questionId === questionId);
  return question ? projectLeaderQuestion(question) : null;
}

export type RecordTypedLeaderAnswerResult = {
  outcome: 'recorded' | 'already-answered' | 'stale' | 'held';
  question: LeaderQuestionProjection | null;
  reason?: string;
};

/** Canonical acceptance precedes thread append/model work and cannot be reopened by a replay. */
export function recordTypedLeaderAnswer(
  questionId: string,
  submission: LeaderQuestionSubmission,
  input: { channel: OperatorChannel; messageId: string },
  nowMs: number = Date.now(),
): RecordTypedLeaderAnswerResult {
  if (!LEADER_QUESTION_ID_RE.test(questionId) || !parseLeaderQuestionSubmission(submission) ||
    !isOperatorChannel(input.channel) || !/^lt-\d{14}-[a-f0-9]{6}$/.test(input.messageId) || !Number.isFinite(nowMs)) {
    return { outcome: 'stale', question: null, reason: 'The submitted question is invalid.' };
  }
  const started = performance.now();
  try {
    return withOperatorLock((): RecordTypedLeaderAnswerResult => {
      const all = readQuestionsStrict();
      const question = all.find((q) => q.questionId === questionId);
      if (!question) return { outcome: 'stale', question: null, reason: 'This question is unavailable.' };
      const form = currentQuestionForm(question);
      const projection = projectLeaderQuestion(question);
      if (!form || form.revision !== submission.formRevision) {
        return { outcome: 'stale', question: projection, reason: 'This question presentation changed.' };
      }
      if (question.answer !== null) return { outcome: 'already-answered', question: projection };
      const acceptedAtMs = nowMs + Math.max(0, performance.now() - started);
      if (acceptedAtMs < Date.parse(question.askedAt) || acceptedAtMs >= Date.parse(form.expiresAt)) {
        return { outcome: 'stale', question: projection, reason: 'This question presentation expired; you can still write an answer.' };
      }
      let text: string;
      let optionIndices: number[] | undefined;
      if (submission.kind === 'options') {
        optionIndices = [...submission.optionIndices].sort((a, b) => a - b);
        if (!form.options || form.mode === 'short-answer' ||
          form.mode === 'single' && optionIndices.length !== 1 ||
          optionIndices.some((index) => index >= form.options!.length)) {
          return { outcome: 'stale', question: projection, reason: 'The selection does not match this question.' };
        }
        text = optionIndices.map((index) => form.options![index]!).join('; ');
      } else {
        if (form.mode !== 'short-answer') {
          return { outcome: 'stale', question: projection, reason: 'This form requires a choice; write an ordinary answer to refine it.' };
        }
        const cleaned = cleanOperatorText(submission.text, OPERATOR_LIMITS.answerMaxChars * 2);
        if (!cleaned || cleaned.length > OPERATOR_LIMITS.answerMaxChars) {
          return { outcome: 'stale', question: projection, reason: 'The complete answer must fit within 2000 characters.' };
        }
        text = cleaned;
      }
      if (!text || text.length > OPERATOR_LIMITS.answerMaxChars) return { outcome: 'stale', question: projection };
      const at = new Date(acceptedAtMs).toISOString();
      ensureQuestionInitialization(acceptedAtMs);
      question.answer = { text, at, channel: input.channel, messageId: input.messageId,
        typedAcceptance: { schemaVersion: 1, formRevision: form.revision, kind: submission.kind,
          ...(optionIndices ? { optionIndices } : {}), text, at, messageId: input.messageId } };
      writeList(operatorQuestionsPath(), 'questions', all, acceptedAtMs);
      fsyncDirectory(leaderRoot());
      return { outcome: 'recorded', question: projectLeaderQuestion(question) };
    });
  } catch {
    // The write may have completed before a later failure: only an exact canonical read can reconcile it.
    return { outcome: 'held', question: null, reason: 'Leader question state is unavailable; check the saved answer before submitting again.' };
  }
}

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
  memo: { id: string; at: string; questionsForMason: readonly string[]; questionForms?: readonly LeaderMemoQuestionForm[] },
  nowMs: number = Date.now(),
): LeaderQuestionRecord[] {
  const wanted = memo.questionsForMason.flatMap((raw, index) => {
    const questionId = questionIdFor(memo.id, index);
    const text = cleanOperatorText(raw, OPERATOR_LIMITS.questionMaxChars);
    return questionId && text ? [{ questionId, index, text }] : [];
  });
  if (wanted.length === 0) return [];
  const forms = normalizeLeaderQuestionForms(memo.questionForms ?? [], memo.questionsForMason) ?? [];
  return withOperatorLock(() => {
    let missing = false;
    try { lstatSync(operatorQuestionsPath()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing = true;
      else throw new Error('Leader question state is unavailable');
    }
    const initialized = readQuestionInitialization();
    if (missing && initialized) throw new Error('Leader question state is unavailable');
    const all = missing ? [] : readQuestionsStrict();
    if (forms.length > 0) ensureQuestionInitialization(nowMs);
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
      const form = forms.find((f) => f.index === w.index);
      if (form) {
        const bound = questionFormFor(record, form);
        if (bound) record.questionForm = bound;
      }
      all.push(record);
      byId.set(record.questionId, record);
      out.push(record);
      added = true;
    }
    if (added) {
      writeList(operatorQuestionsPath(), 'questions', all.slice(-OPERATOR_LIMITS.keepQuestions), nowMs);
      if (forms.length > 0 || initialized) fsyncDirectory(leaderRoot());
    }
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
