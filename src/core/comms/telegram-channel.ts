/**
 * 3.14: Telegram as a real two-way line between Mason and the Leader.
 *
 * dispatch.ts owns the cycle (poll → route inbound → drain outbound); this
 * module owns what each Telegram message MEANS:
 *
 * Outbound
 *   - Leader-thread messages (pendingOutbound('telegram')) are drained every
 *     cycle, paced by the caller, and marked delivered. A message that
 *     answers something is sent as a Telegram reply to the message it
 *     answers. Memo / action messages carry [Approve] [Veto] [Details].
 *   - Leader-memo reports from the comms queue get the same buttons.
 *   - Every message we send is recorded (telegram-thread-map) so a later
 *     reply or button tap can be traced back to the Leader-thread message.
 *
 * Inbound (text)
 *   1. keywords: pause / resume / snapshot / revert:<id>:<repo>, and
 *      /help /start /status /leader [text] /directives;
 *   2. a Telegram reply to a Leader QUESTION → answerLeaderQuestion;
 *   3. a bare number while a button-question is outstanding → that option;
 *   4. anything else (incl. a reply to any other Leader message, with
 *      replyTo) → appendMasonMessage; the Leader's reply goes back as a
 *      Telegram reply to Mason's message.
 *
 * Inbound (buttons): `lt:<a|v|d>:<token>` → approveLeaderAction / veto /
 * full memo; 3.15 `lt:<y|n|c>:<token>` → answer a Leader question (Yes / No /
 * Your call). Tokens resolve only to entries we created (see thread map).
 *
 * 3.15 the Leader line (leader-line.ts) sits in front of the conversation:
 * status / update / what's up → an instant brief, "more" → the rest of the
 * last reply, approve / veto by id, "go build X" → real work at once. The
 * thread drain asks it which proactive messages may go now (quiet hours, one
 * question at a time). Replies are kept phone-sized (leader-persona.ts).
 *
 * SAFETY: messages reach here only from Mason's own chat (telegram.ts drops
 * every other chat id). Veto only lowers autonomy; Approve goes through the
 * Leader's own approveLeaderAction gate. Model text is scrubbed of secrets
 * and HTML-escaped at the transport. Never throws.
 */

import type { AshlrConfig } from '../types.js';
import {
  answerCallbackQuery,
  editTelegramQuestionKeyboard,
  telegramQuestionNamespace,
  sendTelegramMessage,
  type InboundEvent,
  type TelegramButton,
  type TelegramSendOpts,
  type TelegramSendResult,
} from '../integrations/telegram.js';
import { escapeTelegramHtml, leaderDisplayText } from '../integrations/telegram-format.js';
import { scrubSecrets } from '../util/scrub.js';
import { cleanOperatorText, OPERATOR_LIMITS } from '../vision/leader-operator.js';
import type { CommsRequest } from './requests.js';
import {
  lookupTelegramMessage,
  markMemoDelivered,
  memoAlreadyDelivered,
  recordTelegramMessages,
  registerButtonTarget,
  resolveButtonTarget,
  telegramIdForThread,
  registerTelegramQuestion,
  bindTelegramQuestionMessage,
  changeTelegramQuestion,
  claimTelegramQuestionText,
  readTelegramQuestionDraft,
  readTelegramQuestionControl,
  settleTelegramQuestionClaim,
  validTelegramQuestionForm,
  type TelegramQuestionDraft,
  type TelegramButtonTarget,
  type TelegramThreadKind,
} from './telegram-thread-map.js';
import type { LeaderThreadMessage } from '../vision/leader-thread.js';
import type { LeaderQuestionProjection, LeaderQuestionSubmission, SubmitLeaderQuestionResult } from '../vision/leader-thread-types.js';
import { LEADER_TELEGRAM_DETAIL_MAX_LINES, LEADER_TELEGRAM_MAX_LINES, fitTelegram, guardPersonaText, wantsDetail } from '../vision/leader-persona.js';
import { QUESTION_ANSWERS, typedQuestionKeyboard, instantBrief, rememberFullReply, routeLeaderText, type ThreadLineHooks } from './leader-line.js';

export const LEADER_CALLBACK_PREFIX = 'lt:';
const LEADER_MEMO_ID_RE = /^lm-\d{14}-[a-f0-9]{6}$/;
const LEADER_ACTION_ID_RE = /^la-\d{14}-[a-f0-9]{6}-\d{1,3}$/;
/** Most actions one tap will approve / veto (a memo carries only a handful). */
const MAX_ACTIONS_PER_TAP = 10;

// ---------------------------------------------------------------------------
// Pacing — informational sends are rate-limited, never blocked
// ---------------------------------------------------------------------------

export interface SendPacer {
  /** Minimum gap between two sends in this cycle (ms). */
  gapMs: number;
  /** Informational sends left in this cycle's batch. */
  remaining: number;
  lastSendAt: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export function createPacer(opts: { gapMs?: number; batchCap?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}): SendPacer {
  return {
    gapMs: Math.max(0, opts.gapMs ?? 3_000),
    remaining: Math.max(0, opts.batchCap ?? 8),
    lastSendAt: 0,
    sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: opts.now ?? Date.now,
  };
}

/** Wait out the gap since the previous send. Returns false when the batch cap is spent. */
export async function paceNext(p: SendPacer): Promise<boolean> {
  if (p.remaining <= 0) return false;
  if (p.lastSendAt > 0) {
    const wait = p.gapMs - (p.now() - p.lastSendAt);
    if (wait > 0) await p.sleep(wait);
  }
  return true;
}

export function recordPacedSend(p: SendPacer): void {
  p.remaining -= 1;
  p.lastSendAt = p.now();
}

// ---------------------------------------------------------------------------
// Leader thread access (lazy: the thread module may pull in model plumbing)
// ---------------------------------------------------------------------------

type LeaderThreadModule = typeof import('../vision/leader-thread.js');

async function thread(): Promise<LeaderThreadModule | null> {
  try {
    return await import('../vision/leader-thread.js');
  } catch {
    return null;
  }
}

function sendResultIds(res: TelegramSendResult): number[] {
  if (Array.isArray(res.messageIds) && res.messageIds.length > 0) return res.messageIds;
  return typeof res.messageId === 'number' ? [res.messageId] : [];
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

/** [Approve] [Veto] [Details] for a memo / action message. Approve only when something awaits approval. */
export function leaderKeyboard(target: Omit<TelegramButtonTarget, 'at'>, show: { approve: boolean; veto: boolean }): TelegramButton[][] {
  const token = registerButtonTarget(target);
  const row: TelegramButton[] = [];
  if (show.approve) row.push({ text: 'Approve', data: `${LEADER_CALLBACK_PREFIX}a:${token}` });
  if (show.veto) row.push({ text: 'Veto', data: `${LEADER_CALLBACK_PREFIX}v:${token}` });
  row.push({ text: 'Details', data: `${LEADER_CALLBACK_PREFIX}d:${token}` });
  return [row];
}

interface MemoFacts {
  actionIds: string[];
  /**
   * Actions awaiting Mason — a class-B action inside its veto window
   * (Approve applies it now) or an escalated class-C one (Approve records
   * it). Same rule as the Leader's own memo summary.
   */
  approvable: string[];
  /** Applied or still inside their veto window — what Veto undoes. */
  live: number;
}

async function memoFacts(memoId: string): Promise<MemoFacts | null> {
  if (!LEADER_MEMO_ID_RE.test(memoId)) return null;
  try {
    const { readLeaderMemo } = await import('../vision/leader-memo.js');
    const memo = readLeaderMemo(memoId);
    if (!memo) return null;
    return {
      actionIds: memo.actions.map((a) => a.id),
      approvable: memo.actions
        .filter((a) => (a.status === 'scheduled' && a.class === 'B') || a.status === 'escalated')
        .map((a) => a.id),
      live: memo.actions.filter((a) => a.status === 'applied' || a.status === 'scheduled').length,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Outbound: comms-queue reports
// ---------------------------------------------------------------------------

/**
 * Send one informational request (a report). Leader-memo reports get memo
 * buttons and are recorded as delivered memos. Returns whether it landed.
 */
export async function sendReportViaTelegram(req: CommsRequest, cfg: AshlrConfig): Promise<boolean> {
  const memoId = typeof req.meta?.['memoId'] === 'string' ? (req.meta['memoId'] as string) : undefined;
  const isMemo = req.kind === 'leader-memo' && memoId !== undefined;
  const opts: TelegramSendOpts = {};
  let kind: TelegramThreadKind = 'notification';
  let actionIds: string[] | undefined;
  if (isMemo) {
    kind = 'memo';
    const facts = await memoFacts(memoId);
    actionIds = facts?.approvable.length ? facts.approvable : undefined;
    opts.keyboard = leaderKeyboard(
      { memoId, ...(actionIds ? { actionIds } : {}) },
      { approve: (facts?.approvable.length ?? 0) > 0, veto: (facts?.live ?? 0) > 0 },
    );
  }
  const text = isMemo
    ? `${leaderDisplayText(scrubSecrets(req.text))}\n\nReply to this message to talk to the Leader about it.`
    : scrubSecrets(req.text);
  const res = await sendTelegramMessage(text, opts, cfg);
  if (res.ok) {
    recordTelegramMessages(sendResultIds(res), { kind, ...(memoId ? { memoId } : {}), ...(actionIds ? { actionIds } : {}) });
    if (isMemo) markMemoDelivered(memoId);
  }
  return res.ok;
}

// ---------------------------------------------------------------------------
// Outbound: Leader thread
// ---------------------------------------------------------------------------

/** How a Leader-thread message reads on the phone (plain text; escaped at the transport). */
export function formatThreadMessage(msg: LeaderThreadMessage): string {
  // 3.15: the Leader always speaks as itself (leader-persona.ts); Mason's own words are shown as written.
  const body = scrubSecrets(msg.from === 'mason' ? (msg.text ?? '') : leaderDisplayText(guardPersonaText(msg.text ?? ''))).trim();
  // Mason's own words from another surface (e.g. Verse), mirrored so the
  // Leader's reply on Telegram has its context.
  if (msg.from === 'mason') return `You (in ${msg.channel === 'verse' ? 'Verse' : String(msg.channel)}):\n${body}`;
  switch (msg.kind) {
    case 'question':
      return `Leader asks:\n${body}\n\n(Reply to this message to answer.)`;
    case 'memo': {
      // Only the display loses IDs; the exact memo/action targets remain in
      // the thread map and buttons. Phone-sized:
      // the Details button carries the full memo.
      const text = (/^Memo(?: |\n|$)/.test(body) ? `Leader ${body.replace(/^Memo/, 'memo')}` : `Leader memo\n${body}`)
        .replace('Approve or veto any of them by id.', 'Use Approve / Veto, or reply to this message.');
      return fitTelegram(text, LEADER_TELEGRAM_MAX_LINES + 2).text.replace('… (say "more" for the rest)', '… (tap Details for the full memo)');
    }
    case 'action':
      return `Leader action:\n${body}`;
    case 'directive':
      return `Directive:\n${body}`;
    case 'update':
      return `Leader update:\n${body}`;
    default:
      return `Leader:\n${body}`;
  }
}

/**
 * Send one Leader-thread message and record it. `replyToTg` overrides the
 * Telegram message it replies to (used when answering Mason's message).
 */
export async function sendThreadMessage(
  msg: LeaderThreadMessage,
  cfg: AshlrConfig,
  replyToTg?: number,
  shape: { maxLines?: number; keyboard?: TelegramButton[][] | null } = {},
): Promise<boolean> {
  const opts: TelegramSendOpts = {};
  let typedDraft: TelegramQuestionDraft | null = null;
  const namespace = telegramQuestionNamespace(cfg);
  if (msg.kind === 'question' && msg.questionForm !== undefined) {
    if (!namespace || !msg.questionId || !validTelegramQuestionForm(msg.questionForm)) return false;
    typedDraft = registerTelegramQuestion(namespace, msg.questionId, msg.id, msg.questionForm);
    if (!typedDraft) return false;
  }
  const replyTarget = replyToTg ?? telegramIdForThread(msg.replyTo);
  if (typeof replyTarget === 'number') opts.replyToMessageId = replyTarget;

  let actionIds = (msg.actionIds ?? []).filter((id) => LEADER_ACTION_ID_RE.test(id));
  const memoId = msg.memoId && LEADER_MEMO_ID_RE.test(msg.memoId) ? msg.memoId : undefined;
  if (msg.kind === 'memo' && memoId) {
    // Approve only what still awaits Mason; Veto only when something is live.
    const facts = await memoFacts(memoId);
    const approvable = facts ? actionIds.filter((id) => facts.approvable.includes(id)) : [];
    const listed = actionIds.length > 0 ? actionIds : (facts?.approvable ?? []);
    actionIds = approvable.length > 0 ? approvable : listed.filter((id) => facts?.approvable.includes(id));
    opts.keyboard = leaderKeyboard(
      { threadId: msg.id, memoId, ...(actionIds.length ? { actionIds } : {}) },
      { approve: actionIds.length > 0, veto: (facts?.live ?? 0) > 0 },
    );
  } else if (msg.kind === 'action' && !msg.replyTo && actionIds.length > 0) {
    // A proactive action notice (not the acknowledgement of Mason's own tap).
    opts.keyboard = leaderKeyboard(
      { threadId: msg.id, ...(memoId ? { memoId } : {}), actionIds },
      { approve: true, veto: true },
    );
  } else if (shape.keyboard) {
    // 3.15: a yes/no Leader question gets Yes / No / Your call.
    opts.keyboard = shape.keyboard;
  }
  if (typedDraft) opts.keyboard = typedQuestionKeyboard(typedDraft);

  let text = formatThreadMessage(msg);
  if (shape.maxLines !== undefined) {
    const fit = fitTelegram(text, shape.maxLines);
    if (fit.truncated) {
      try { rememberFullReply(text); } catch { /* "more" just has nothing */ }
    }
    text = fit.text;
  }
  const res = await sendTelegramMessage(text, opts, cfg);
  if (typedDraft) {
    const keyboardMessageId = res.messageIds?.at(-1) ?? res.messageId;
    if (!res.ok || res.partial || namespace !== telegramQuestionNamespace(cfg) || typeof keyboardMessageId !== 'number' ||
        !bindTelegramQuestionMessage(typedDraft.token, namespace!, keyboardMessageId)) return false;
  }
  if (res.ok) {
    recordTelegramMessages(sendResultIds(res), {
      threadId: msg.id,
      kind: msg.kind,
      ...(memoId ? { memoId } : {}),
      ...(msg.questionId ? { questionId: msg.questionId } : {}),
      ...(actionIds.length ? { actionIds } : {}),
    });
  }
  return res.ok;
}

export interface DrainResult {
  sent: number;
  failed: number;
  skipped: number;
}

/**
 * Deliver the Leader thread's pending Telegram messages, paced. A memo that
 * already reached Mason through the comms queue is marked delivered without
 * a second send. Stops at the first transport failure (the rest retry next
 * cycle). Never throws.
 */
export async function drainLeaderThread(cfg: AshlrConfig, pacer: SendPacer, line?: ThreadLineHooks | null): Promise<DrainResult> {
  const out: DrainResult = { sent: 0, failed: 0, skipped: 0 };
  const mod = await thread();
  if (!mod) return out;
  let pending: LeaderThreadMessage[] = [];
  try {
    pending = (await mod.pendingOutbound('telegram')) ?? [];
  } catch {
    return out;
  }
  for (const msg of pending) {
    try {
      if (!msg || typeof msg.text !== 'string' || (msg.from === 'mason' && msg.channel === 'telegram')) {
        // Nothing to show (Mason's own Telegram messages are already on his phone).
        if (msg?.id) await mod.markDelivered(msg.id, 'telegram', true);
        out.skipped++;
        continue;
      }
      if (msg.kind === 'memo' && memoAlreadyDelivered(msg.memoId)) {
        await mod.markDelivered(msg.id, 'telegram', true);
        out.skipped++;
        continue;
      }
      // 3.15: quiet hours and one-question-at-a-time (leader-line.ts). Held
      // messages stay pending and go out on a later cycle.
      if (line && line.gate(msg) === 'hold') {
        out.skipped++;
        continue;
      }
      if (!(await paceNext(pacer))) break;
      const ok = await sendThreadMessage(msg, cfg, undefined, { keyboard: line?.questionKeyboard(msg) ?? null });
      recordPacedSend(pacer);
      await mod.markDelivered(msg.id, 'telegram', ok);
      if (!ok) {
        out.failed++;
        break;
      }
      line?.sent(msg);
      out.sent++;
    } catch {
      out.failed++;
      break;
    }
  }
  try { line?.flush(); } catch { /* best-effort */ }
  return out;
}

// ---------------------------------------------------------------------------
// Inbound: conversation with the Leader
// ---------------------------------------------------------------------------

/** `html: true` = `text` is already Telegram HTML (every dynamic part escaped by the caller). */
async function replyTo(event: InboundEvent, text: string, cfg: AshlrConfig, format?: { html: true }): Promise<TelegramSendResult> {
  const opts: TelegramSendOpts = {
    ...(typeof event.messageId === 'number' ? { replyToMessageId: event.messageId } : {}),
    ...(format?.html ? { html: true } : {}),
  };
  return sendTelegramMessage(text, Object.keys(opts).length > 0 ? opts : undefined, cfg);
}

function directiveText(directive: unknown): string | null {
  if (!directive) return null;
  if (typeof directive === 'string') return directive;
  if (typeof directive === 'object') {
    const d = directive as Record<string, unknown>;
    for (const k of ['text', 'summary', 'statement', 'rule']) {
      if (typeof d[k] === 'string' && (d[k] as string).trim()) return d[k] as string;
    }
  }
  return null;
}

/**
 * Hand Mason's text to the Leader thread and send the Leader's reply back as
 * a Telegram reply to his message. Answers a Leader question when he replied
 * to one. Never throws.
 */
export async function converseWithLeader(event: InboundEvent, text: string, cfg: AshlrConfig): Promise<void> {
  // 3.15: status, "more", approve / veto and "go build X" are the line's.
  if (await routeLeaderText(event, text, cfg)) return;
  const mod = await thread();
  if (!mod) {
    await replyTo(event, 'The Leader thread is not available in this build — your message was not recorded.', cfg);
    return;
  }
  const repliedTo = lookupTelegramMessage(event.replyToMessageId);
  try {
    let message: LeaderThreadMessage | undefined;
    let reply: LeaderThreadMessage | null = null;
    let directive: unknown;
    if (repliedTo?.kind === 'question' && repliedTo.questionId) {
      if (typeof mod.readLeaderQuestion === 'function' && typeof mod.submitLeaderQuestion === 'function') {
        const question = mod.readLeaderQuestion(repliedTo.questionId);
        if (!question) {
          await replyTo(event, 'That question is unavailable. Your words were not submitted.', cfg); return;
        }
        const namespace = telegramQuestionNamespace(cfg, event.fromChatId);
        const draft = namespace && typeof event.replyToMessageId === 'number'
          ? readTelegramQuestionDraft(namespace, event.replyToMessageId, repliedTo.questionId) : null;
        const pendingClaim = draft?.claim;
        if (typeof event.messageId === 'number' && pendingClaim && pendingClaim.inboundMessageId !== null &&
            pendingClaim.inboundMessageId === event.messageId) {
          await replyTo(event, exactTypedAcceptance(question, pendingClaim.submission)
            ? 'Your answer is saved.' : 'That submission is unconfirmed. Your draft is retained.', cfg);
          return;
        }
        if (question.questionForm && !question.answered &&
            (!draft || draft.form.revision !== question.questionForm.revision || draft.claim)) {
          await replyTo(event, 'That typed question is held. Your words were not submitted; do not repeat an uncertain submission.', cfg);
          return;
        }
        if (question.questionForm?.mode === 'short-answer' && !question.answered) {
          const claimed = namespace && typeof event.replyToMessageId === 'number' && typeof event.messageId === 'number'
            ? claimTelegramQuestionText(namespace, event.replyToMessageId, event.messageId, repliedTo.questionId, text) : null;
          if (!claimed?.claim || claimed.form.revision !== question.questionForm.revision || namespace !== telegramQuestionNamespace(cfg, event.fromChatId)) {
            await replyTo(event, 'That typed question is held. Your words were not submitted; do not repeat an uncertain submission.', cfg);
            return;
          }
          const result = await mod.submitLeaderQuestion(repliedTo.questionId, claimed.claim.submission, { channel: 'telegram', cfg });
          if (result.outcome === 'recorded' && result.message) {
            recordTelegramMessages([event.messageId!], { kind: 'answer', threadId: result.message.id, questionId: repliedTo.questionId });
          }
          await replyTo(event, await deliverTypedQuestionResult(result, claimed, cfg, event.messageId!), cfg);
          return;
        }
      }
      // For a choice form, an actual human reply in words is the intentional
      // ordinary answer/refinement path, never a failed typed submission fallback.
      ({ message, reply } = await mod.answerLeaderQuestion(repliedTo.questionId, text, { channel: 'telegram', cfg }));
    } else {
      // A reply to a memo the comms queue delivered has no thread id: name
      // the memo so the Leader knows what Mason is answering.
      const body = !repliedTo?.threadId && repliedTo?.memoId ? `(re: Leader memo ${repliedTo.memoId}) ${text}` : text;
      const res = await mod.appendMasonMessage(body, {
        channel: 'telegram',
        cfg,
        ...(repliedTo?.threadId ? { replyTo: repliedTo.threadId } : {}),
      });
      message = res.message;
      reply = res.reply;
      directive = res.directive;
    }

    // Remember Mason's own message so a later (async) Leader reply threads under it.
    if (typeof event.messageId === 'number' && message?.id) {
      recordTelegramMessages([event.messageId], { threadId: message.id, kind: 'mason' });
    }

    if (reply && typeof reply.text === 'string' && reply.text.trim()) {
      // Phone-sized unless he asked for detail; "more" sends the rest.
      const maxLines = wantsDetail(text) ? LEADER_TELEGRAM_DETAIL_MAX_LINES : LEADER_TELEGRAM_MAX_LINES;
      const ok = await sendThreadMessage(reply, cfg, event.messageId, { maxLines: maxLines + 1 });
      await mod.markDelivered(reply.id, 'telegram', ok);
      return;
    }
    const d = directiveText(directive);
    await replyTo(
      event,
      d
        ? `Directive recorded: ${scrubSecrets(d)}`
        : 'Noted — the Leader has it and will reply here.',
      cfg,
    );
  } catch (err) {
    await replyTo(event, `Could not pass that to the Leader: ${errorText(err)}`, cfg);
  }
}

/** A thread refusal (LeaderThreadError: bad input, unknown question) is worth showing; anything else is generic. */
function errorText(err: unknown): string {
  if (err instanceof Error && err.name === 'LeaderThreadError' && err.message) return scrubSecrets(err.message);
  return 'the Leader is unreachable right now — try again in a few minutes.';
}

// ---------------------------------------------------------------------------
// Inbound: buttons
// ---------------------------------------------------------------------------

function resultMessage(r: unknown, fallback: string): { ok: boolean; message: string } {
  if (r && typeof r === 'object') {
    const o = r as Record<string, unknown>;
    const ok = o['ok'] !== false;
    const message = typeof o['message'] === 'string' ? (o['message'] as string) : fallback;
    return { ok, message };
  }
  return { ok: Boolean(r), message: fallback };
}

function exactTypedAcceptance(question: LeaderQuestionProjection | null, submission: LeaderQuestionSubmission): boolean {
  const accepted = question?.answer?.typedAcceptance;
  if (!accepted || accepted.formRevision !== submission.formRevision || accepted.kind !== submission.kind) return false;
  if (submission.kind === 'text') return accepted.text === cleanOperatorText(submission.text, OPERATOR_LIMITS.answerMaxChars * 2);
  return JSON.stringify(accepted.optionIndices) === JSON.stringify(submission.optionIndices) &&
    accepted.text === submission.optionIndices.map(index => question?.questionForm?.options?.[index]).join('; ');
}

async function deliverTypedQuestionResult(result: SubmitLeaderQuestionResult, draft: TelegramQuestionDraft,
  cfg: AshlrConfig, replyToMessageId: number): Promise<string> {
  const submission = draft.claim?.submission;
  if (!submission) return 'That submission is held.';
  if (telegramQuestionNamespace(cfg) !== draft.namespace) return 'Question configuration changed. Submission status is held.';
  if (exactTypedAcceptance(result.question, submission)) {
    const messageId = result.question?.answer?.typedAcceptance?.messageId;
    if (messageId) settleTelegramQuestionClaim(draft.token, draft.namespace, submission, messageId);
    // The BOT question retains its original association. Only a genuine human
    // inbound message can be mapped to a separate canonical answer message.
    await editTelegramQuestionKeyboard(draft.messageId!, [], cfg);
    if (result.outcome === 'recorded' && result.reply) {
      const mod = await thread();
      const ok = await sendThreadMessage(result.reply, cfg, replyToMessageId, { maxLines: LEADER_TELEGRAM_MAX_LINES + 1 });
      await mod?.markDelivered(result.reply.id, 'telegram', ok);
    }
    return 'Your answer is saved.';
  }
  if (result.outcome === 'already-answered') return 'This question already has an answer.';
  if (result.outcome === 'stale') return 'That question changed. Your draft was retained; no answer was submitted.';
  return 'Submission is held. Your draft was retained; do not repeat it.';
}

async function handleTypedQuestionButton(event: InboundEvent, cfg: AshlrConfig): Promise<boolean> {
  if (!(event.data ?? '').startsWith('lt:q:')) return false;
  const ack = async (text: string): Promise<void> => {
    if (event.callbackQueryId) await answerCallbackQuery(event.callbackQueryId, cfg, text);
  };
  const match = /^lt:q:([a-f0-9]{24}):([0-9a-z]{1,6}):([oacsw])(?::(\d{1,2}))?$/.exec(event.data!);
  const namespace = telegramQuestionNamespace(cfg, event.fromChatId);
  if (!namespace) return true;
  await ack('Checking question…');
  if (!match || !namespace || !event.callbackQueryId || !Number.isSafeInteger(event.messageId) ||
      (match[3] === 'o') !== (match[4] !== undefined)) {
    await ack('That question control is unavailable.'); return true;
  }
  const bound = readTelegramQuestionControl(match[1]!, namespace, event.messageId!);
  const mod = await thread();
  if (!bound || !mod || typeof mod.readLeaderQuestion !== 'function' || typeof mod.submitLeaderQuestion !== 'function') {
    await ack('Typed answers are unavailable. Your draft is retained.'); return true;
  }
  let question: LeaderQuestionProjection | null;
  try { question = mod.readLeaderQuestion(bound.questionId); }
  catch { await ack('Question state is held. Your draft is retained.'); return true; }
  if (namespace !== telegramQuestionNamespace(cfg, event.fromChatId) ||
      !question || question.questionForm?.revision !== bound.form.revision || question.answered && !bound.claim) {
    await ack('That question changed or already has an answer. Your draft is retained.'); return true;
  }
  const operation = { o: 'option', a: 'all', c: 'clear', s: 'submit', w: 'write' } as const;
  const changed = changeTelegramQuestion({ token: match[1]!, namespace, messageId: event.messageId!,
    revision: parseInt(match[2]!, 36), callbackId: event.callbackQueryId,
    operation: operation[match[3] as keyof typeof operation],
    ...(match[4] === undefined ? {} : { optionIndex: Number(match[4]) }) });
  if (!changed) { await ack('Question state is held. Reply in words when it is available.'); return true; }
  const draft = changed.draft;
  if (changed.outcome === 'draft' || changed.outcome === 'stale') {
    if (namespace === telegramQuestionNamespace(cfg, event.fromChatId)) {
      const edited = await editTelegramQuestionKeyboard(event.messageId!, typedQuestionKeyboard(draft), cfg);
      await ack(changed.outcome === 'stale' ? 'Old keyboard: use the updated choices.'
        : edited ? 'Choices updated. Submit when ready.' : 'Choices retained. Keyboard update is unconfirmed.');
    }
    return true;
  }
  if (changed.outcome === 'write') {
    await ack('Reply to the question in your own words.'); return true;
  }
  try {
    question = mod.readLeaderQuestion(draft.questionId);
    if (changed.outcome !== 'submit') {
      if (draft.claim && exactTypedAcceptance(question, draft.claim.submission)) {
        const messageId = question?.answer?.typedAcceptance?.messageId;
        if (messageId) settleTelegramQuestionClaim(draft.token, namespace, draft.claim.submission, messageId);
        if (namespace === telegramQuestionNamespace(cfg, event.fromChatId)) await editTelegramQuestionKeyboard(event.messageId!, [], cfg);
        await ack('Your answer is saved.');
      } else await ack(changed.outcome === 'duplicate' ? 'That tap was already handled.'
        : 'Submission is held. Your draft is retained.');
      return true;
    }
    if (namespace !== telegramQuestionNamespace(cfg, event.fromChatId) ||
        question?.questionForm?.revision !== draft.form.revision || !draft.claim) {
      await ack('That question changed. Your submission is held.'); return true;
    }
    const result = await mod.submitLeaderQuestion(draft.questionId, draft.claim.submission, { channel: 'telegram', cfg });
    await ack(await deliverTypedQuestionResult(result, draft, cfg, event.messageId!));
  } catch { await ack('Submission is unconfirmed. Your draft is retained; do not repeat it.'); }
  return true;
}

async function memoDetails(memoId: string): Promise<string> {
  try {
    const { readLeaderMemo } = await import('../vision/leader-memo.js');
    const memo = readLeaderMemo(memoId);
    if (!memo) return 'That Leader memo is no longer on file.';
    const { leaderMemoText } = await import('./handlers.js');
    return leaderDisplayText(scrubSecrets(leaderMemoText(memo)));
  } catch {
    return 'Could not read that Leader memo.';
  }
}

async function actionDetails(actionIds: string[]): Promise<string> {
  try {
    const { findStoredAction } = await import('../vision/leader-apply.js');
    const lines: string[] = [];
    for (const [index, id] of actionIds.slice(0, MAX_ACTIONS_PER_TAP).entries()) {
      const stored = findStoredAction(id);
      if (!stored) {
        lines.push(`Action ${index + 1}: no longer on file`);
        continue;
      }
      const a = stored.action;
      lines.push(`Action ${index + 1} [class ${a.class}] ${a.status}: ${a.summary}`, `  why: ${a.why}`);
    }
    return leaderDisplayText(scrubSecrets(lines.join('\n'))) || 'No details on file.';
  } catch {
    return 'Could not read those Leader actions.';
  }
}

/**
 * Handle an `lt:` button tap. Acks the tap (toast) and replies under the
 * tapped message with the outcome. Returns true when the tap was ours.
 */
export async function handleLeaderButton(event: InboundEvent, cfg: AshlrConfig): Promise<boolean> {
  if (await handleTypedQuestionButton(event, cfg)) return true;
  const data = event.data ?? '';
  const m = /^lt:([avdync]):(\d{1,12})$/.exec(data);
  if (!m) return false;
  const verb = m[1] as 'a' | 'v' | 'd' | 'y' | 'n' | 'c';
  const target = resolveButtonTarget(m[2]!);
  const ack = async (t: string): Promise<void> => {
    if (event.callbackQueryId) await answerCallbackQuery(event.callbackQueryId, cfg, t);
  };
  if (!target) {
    await ack('That button has expired.');
    return true;
  }
  const memoId = target.memoId && LEADER_MEMO_ID_RE.test(target.memoId) ? target.memoId : undefined;
  const actionIds = (target.actionIds ?? []).filter((id) => LEADER_ACTION_ID_RE.test(id)).slice(0, MAX_ACTIONS_PER_TAP);

  try {
    if (verb === 'y' || verb === 'n' || verb === 'c') {
      // 3.15: Yes / No / Your call on a Leader question.
      const questionId = target.questionId;
      const mod = await thread();
      if (!questionId || !mod) {
        await ack('That question is no longer open.');
        return true;
      }
      await ack(verb === 'y' ? 'Yes' : verb === 'n' ? 'No' : 'Your call');
      const { message, reply } = await mod.answerLeaderQuestion(questionId, QUESTION_ANSWERS[verb], { channel: 'telegram', cfg });
      // A tapped BOT message remains the question. It is not a human reply.
      void message;
      if (reply && typeof reply.text === 'string' && reply.text.trim()) {
        const ok = await sendThreadMessage(reply, cfg, event.messageId, { maxLines: LEADER_TELEGRAM_MAX_LINES + 1 });
        await mod.markDelivered(reply.id, 'telegram', ok);
      }
      return true;
    }

    if (verb === 'd') {
      await ack('Details');
      const text = memoId ? await memoDetails(memoId) : actionIds.length ? await actionDetails(actionIds) : 'No details on file.';
      await replyTo(event, text, cfg);
      return true;
    }

    if (verb === 'a') {
      if (actionIds.length === 0) {
        await ack('Nothing here awaits approval.');
        return true;
      }
      const mod = await thread();
      if (!mod) {
        await ack('Approval is not available in this build.');
        return true;
      }
      await ack('Approving…');
      // One combined reply. Each approval also queues the Leader's
      // acknowledgement in the thread (pending for Telegram); it is marked
      // delivered only once this reply — which carries it — has landed, so
      // the drain never sends it a second time.
      const lines: string[] = [];
      const ackIds: string[] = [];
      for (const id of actionIds) {
        try {
          const res = await mod.approveLeaderAction(id, { channel: 'telegram', cfg });
          const r = resultMessage(res, 'approved');
          const leaderSays = res?.thread?.reply?.text;
          lines.push(`${r.ok ? 'Approved' : 'Not approved'} action: ${leaderDisplayText(leaderSays && leaderSays.trim() ? leaderSays : r.message)}`);
          if (res?.thread?.reply?.id) ackIds.push(res.thread.reply.id);
        } catch (err) {
          lines.push(`Not approved action: ${errorText(err)}`);
        }
      }
      const sent = await replyTo(event, scrubSecrets(lines.join('\n')), cfg);
      for (const ackId of ackIds) await mod.markDelivered(ackId, 'telegram', sent.ok);
      return true;
    }

    // verb === 'v' — a veto only lowers what autonomy is doing (SPEC-310B I1),
    // so Mason's own chat is enough, exactly like the 'leader-veto' request.
    await ack('Vetoing…');
    const apply = await import('../vision/leader-apply.js');
    const deps = await apply.loadDefaultLeaderDeps();
    const lines: string[] = [];
    if (memoId) {
      const r = await apply.vetoLeaderMemo(deps, memoId, 'Vetoed from Telegram');
      lines.push(r.ok ? `Vetoed: ${r.message}` : `Could not veto: ${r.message}`);
    } else {
      for (const id of actionIds) {
        const r = await apply.vetoLeaderAction(deps, id, 'Vetoed from Telegram');
        lines.push(r.ok ? `Vetoed: ${r.message}` : `Could not veto action: ${r.message}`);
      }
    }
    await replyTo(event, scrubSecrets(lines.join('\n') || 'Nothing to veto.'), cfg);
  } catch {
    await replyTo(event, 'That did not go through — try again, or use Verse.', cfg);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Inbound: slash commands
// ---------------------------------------------------------------------------

const TELEGRAM_HELP_INTRO = 'Talk to the Leader: type a message, or reply to one to follow up.';
const TELEGRAM_HELP_SECTIONS = [
  ['Read', [
    ['/status or /brief', 'shipped, running, blockers and next'],
    ['status / update / what\'s up', 'the same instant brief'],
    ['/leader', 'latest Leader memo'],
    ['snapshot', 'full fleet snapshot'],
  ]],
  ['Talk & work', [
    ['/leader <text>', 'message the Leader'],
    ['/task <owner/repo> <what to do>', 'hand work to an enabled Telegram automation'],
    ['build X / fix Y in owner/repo', 'ask the Leader to start work within the grant'],
  ]],
  ['Decisions', [
    ['approve <id> / veto <id>', 'or reply "approve" / "veto" to an action message'],
    ['/directives', 'your standing directives to the Leader'],
    ['/settings', 'the Leader\'s settings and standards'],
  ]],
  ['Messages', [
    ['more', 'expand the last long reply'],
    ['pause / resume', 'pause or resume fleet messages'],
    ['/help', 'this guide'],
  ]],
] as const;
const TELEGRAM_HELP_BUTTONS = 'Buttons: Approve (apply a scheduled class-B action now, or record your approval of a class-C ask); Veto undoes the memo\'s actions; Details opens the full memo.';

/** Plain help stays available to CLI/test consumers; Telegram uses source-built HTML. */
export const TELEGRAM_HELP_TEXT = [
  TELEGRAM_HELP_INTRO,
  ...TELEGRAM_HELP_SECTIONS.flatMap(([heading, entries]) => [
    '', heading, ...entries.map(([command, description]) => `${command} — ${description}`),
  ]),
  '', TELEGRAM_HELP_BUTTONS,
].join('\n');

/** Escape every command/example before adding our fixed heading/code tags. */
const TELEGRAM_HELP_HTML = [
  escapeTelegramHtml(TELEGRAM_HELP_INTRO),
  ...TELEGRAM_HELP_SECTIONS.flatMap(([heading, entries]) => [
    '', `<b>${escapeTelegramHtml(heading)}</b>`,
    ...entries.map(([command, description]) => `<code>${escapeTelegramHtml(command)}</code> — ${escapeTelegramHtml(description)}`),
  ]),
  '', escapeTelegramHtml(TELEGRAM_HELP_BUTTONS),
].join('\n');

function ago(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown';
  const mins = Math.round((nowMs - t) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** /status — honest, local-only status (no model calls). */
export async function buildStatusText(nowMs: number = Date.now()): Promise<string> {
  const lines: string[] = ['Status'];
  try {
    const { isPaused } = await import('./pause.js');
    if (isPaused()) lines.push('Messages: paused (send "resume" to restart)');
  } catch { /* skip */ }
  try {
    const { autonomyLine } = await import('./change-digest.js');
    lines.push(autonomyLine());
  } catch { /* skip */ }
  try {
    const { listRequests, outstanding } = await import('./requests.js');
    const out = outstanding();
    const pending = listRequests({ status: 'pending' }).length;
    lines.push(`Queue: ${pending} pending${out ? `, awaiting your answer: "${clip(out.text, 80)}"` : ''}`);
  } catch { /* skip */ }
  try {
    const { buildLeaderState } = await import('../vision/leader.js');
    const s = buildLeaderState(nowMs);
    const last = s.lastRun ? `last run ${ago(s.lastRun.at, nowMs)} (${s.lastRun.outcome})` : 'no run yet';
    const next = s.nextRunAt ? `, next ${leaderDisplayText(s.nextRunAt, nowMs)}` : '';
    lines.push(`Leader: ${last}${next}`);
    if (s.latest) lines.push(`Latest memo: ${ago(s.latest.at, nowMs)}`);
  } catch { /* skip */ }
  return lines.join('\n');
}

/** /leader — the latest memo's headline with buttons. */
async function sendLatestMemo(event: InboundEvent, cfg: AshlrConfig): Promise<void> {
  try {
    const { buildLeaderState } = await import('../vision/leader.js');
    const memo = buildLeaderState(Date.now()).latest;
    if (!memo) {
      await replyTo(event, 'No Leader memo yet. Message the Leader with /leader <text>, or just type.', cfg);
      return;
    }
    const parts = [`Leader memo — ${leaderDisplayText(memo.at)}${memo.dryRun ? ' (dry run)' : ''}`];
    if (memo.bottleneck) parts.push(`Bottleneck: ${clip(memo.bottleneck.statement, 300)}`);
    if (memo.move) parts.push(`Move: ${clip(memo.move.statement, 300)}`);
    if (memo.questionsForMason.length > 0) parts.push(`Question: ${clip(memo.questionsForMason[0]!, 300)}`);
    const facts = await memoFacts(memo.id);
    const keyboard = leaderKeyboard(
      { memoId: memo.id, ...(facts?.approvable.length ? { actionIds: facts.approvable } : {}) },
      { approve: (facts?.approvable.length ?? 0) > 0, veto: (facts?.live ?? 0) > 0 },
    );
    const res = await sendTelegramMessage(leaderDisplayText(scrubSecrets(parts.join('\n'))), {
      keyboard,
      ...(typeof event.messageId === 'number' ? { replyToMessageId: event.messageId } : {}),
    }, cfg);
    if (res.ok) {
      recordTelegramMessages(sendResultIds(res), {
        kind: 'memo',
        memoId: memo.id,
        ...(facts?.approvable.length ? { actionIds: facts.approvable } : {}),
      });
    }
  } catch {
    await replyTo(event, 'Could not read the Leader state.', cfg);
  }
}

export const DIRECTIVES_EMPTY_HTML =
  'No standing directives — send <code>focus: …</code>, <code>stop: …</code>, <code>priority: …</code> or <code>directive: …</code>';

/**
 * /directives — Mason's ACTIVE standing directives (leader-operator.ts,
 * operator-directives.json), newest first, as Telegram HTML: id, kind, text.
 * Every stored value is escaped here (the reply goes out with html: true).
 */
export async function directivesHtml(): Promise<string> {
  try {
    const { listOperatorDirectives } = await import('../vision/leader-operator.js');
    const active = listOperatorDirectives();
    if (active.length === 0) return DIRECTIVES_EMPTY_HTML;
    const lines = [`<b>Standing directives (${active.length})</b>`];
    for (const d of active) {
      lines.push(`• <code>${escapeTelegramHtml(d.id)}</code> [${escapeTelegramHtml(d.kind)}] ${escapeTelegramHtml(scrubSecrets(d.text))}`);
    }
    return lines.join('\n');
  } catch {
    return escapeTelegramHtml('Could not read your standing directives.');
  }
}

/** /settings — the Leader's own settings (lanes, router tuning) and standards. */
async function settingsText(): Promise<string> {
  try {
    const { readLeaderDirectives, readStandards } = await import('../vision/leader-apply.js');
    const d = readLeaderDirectives();
    const lines: string[] = ['Leader settings'];
    if (!d) {
      lines.push('  none set (lane and router defaults apply)');
    } else {
      lines.push(`  grok lanes: ${d.grokLanes ?? 'default'}`);
      lines.push(`  codex lanes: ${d.codexEnabled === null ? 'default (off)' : d.codexEnabled ? 'on' : 'off'}`);
      const tuning = d.routerTuning ? Object.entries(d.routerTuning).map(([k, v]) => `${k}=${String(v)}`).join(', ') : '';
      lines.push(`  router tuning: ${tuning || 'none'}`);
      lines.push(`  updated ${leaderDisplayText(d.updatedAt)}`);
    }
    const standards = readStandards().filter((s) => !s.retiredAt);
    lines.push('', `Standards (${standards.length})`);
    for (const s of standards.slice(0, 12)) lines.push(`  • [${s.source}] ${clip(s.rule, 160)} — ${s.appliesTo}`);
    if (standards.length > 12) lines.push(`  …and ${standards.length - 12} more`);
    return scrubSecrets(lines.join('\n'));
  } catch {
    return 'Could not read the Leader settings.';
  }
}

/**
 * Handle a `/command`. Returns true when the text was a command (handled,
 * including unknown commands, which get the help text).
 */
export async function handleSlashCommand(event: InboundEvent, text: string, cfg: AshlrConfig): Promise<boolean> {
  const m = /^\s*\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text);
  if (!m) return false;
  const cmd = m[1]!.toLowerCase();
  const rest = (m[2] ?? '').trim();
  switch (cmd) {
    case 'help':
    case 'start':
      await replyTo(event, TELEGRAM_HELP_HTML, cfg, { html: true });
      return true;
    case 'status':
    case 'brief':
      // 3.15: the instant brief from recorded state (the model only for its narrative line).
      await replyTo(event, await instantBrief(cfg), cfg);
      return true;
    case 'leader':
      if (rest) await converseWithLeader(event, rest, cfg);
      else await sendLatestMemo(event, cfg);
      return true;
    case 'directives':
      await replyTo(event, await directivesHtml(), cfg, { html: true });
      return true;
    case 'settings':
      await replyTo(event, await settingsText(), cfg);
      return true;
    case 'task': {
      // 3.15 automations: routed by an enabled Telegram automation covering
      // the repo, through its lane's own gates. Lazy: most chats never use it.
      const task = /^([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\s+([\s\S]+)$/.exec(rest);
      if (!task) {
        await replyTo(event, 'Usage: /task <owner/repo> <what to do>', cfg);
        return true;
      }
      try {
        const { receiveTelegramTask } = await import('../automations/engine.js');
        const result = await receiveTelegramTask(task[1]!, task[2]!);
        await replyTo(event, scrubSecrets(result.message), cfg);
      } catch {
        await replyTo(event, 'Could not hand that over — try again, or use Verse → Automations.', cfg);
      }
      return true;
    }
    default:
      await replyTo(event, `Unknown command <code>${escapeTelegramHtml(`/${cmd}`)}</code>.\n\n${TELEGRAM_HELP_HTML}`, cfg, { html: true });
      return true;
  }
}
