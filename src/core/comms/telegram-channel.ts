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
 * full memo. Tokens resolve only to entries we created (see thread map).
 *
 * SAFETY: messages reach here only from Mason's own chat (telegram.ts drops
 * every other chat id). Veto only lowers autonomy; Approve goes through the
 * Leader's own approveLeaderAction gate. Model text is scrubbed of secrets
 * and HTML-escaped at the transport. Never throws.
 */

import type { AshlrConfig } from '../types.js';
import {
  answerCallbackQuery,
  sendTelegramMessage,
  type InboundEvent,
  type TelegramButton,
  type TelegramSendOpts,
  type TelegramSendResult,
} from '../integrations/telegram.js';
import { scrubSecrets } from '../util/scrub.js';
import type { CommsRequest } from './requests.js';
import {
  lookupTelegramMessage,
  markMemoDelivered,
  memoAlreadyDelivered,
  recordTelegramMessages,
  registerButtonTarget,
  resolveButtonTarget,
  telegramIdForThread,
  type TelegramButtonTarget,
  type TelegramThreadKind,
} from './telegram-thread-map.js';
import type { LeaderThreadMessage } from '../vision/leader-thread.js';

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
  /** Actions escalated to Mason (class C) — the ones Approve acts on. */
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
      approvable: memo.actions.filter((a) => a.status === 'escalated').map((a) => a.id),
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
    ? `${scrubSecrets(req.text)}\n\nReply to this message to talk to the Leader about it.`
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
  const body = scrubSecrets(msg.text ?? '').trim();
  // Mason's own words from another surface (e.g. Verse), mirrored so the
  // Leader's reply on Telegram has its context.
  if (msg.from === 'mason') return `You (in ${msg.channel === 'verse' ? 'Verse' : String(msg.channel)}):\n${body}`;
  switch (msg.kind) {
    case 'question':
      return `Leader asks:\n${body}\n\n(Reply to this message to answer.)`;
    case 'memo':
      return `Leader memo${msg.memoId ? ` ${msg.memoId}` : ''}\n${body}`;
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
): Promise<boolean> {
  const opts: TelegramSendOpts = {};
  const replyTarget = replyToTg ?? telegramIdForThread(msg.replyTo);
  if (typeof replyTarget === 'number') opts.replyToMessageId = replyTarget;

  const actionIds = (msg.actionIds ?? []).filter((id) => LEADER_ACTION_ID_RE.test(id));
  const memoId = msg.memoId && LEADER_MEMO_ID_RE.test(msg.memoId) ? msg.memoId : undefined;
  if ((msg.kind === 'memo' || msg.kind === 'action') && (memoId || actionIds.length > 0)) {
    opts.keyboard = leaderKeyboard(
      { threadId: msg.id, ...(memoId ? { memoId } : {}), ...(actionIds.length ? { actionIds } : {}) },
      { approve: actionIds.length > 0, veto: true },
    );
  }

  const res = await sendTelegramMessage(formatThreadMessage(msg), opts, cfg);
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
export async function drainLeaderThread(cfg: AshlrConfig, pacer: SendPacer): Promise<DrainResult> {
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
      if (!(await paceNext(pacer))) break;
      const ok = await sendThreadMessage(msg, cfg);
      recordPacedSend(pacer);
      await mod.markDelivered(msg.id, 'telegram', ok);
      if (!ok) {
        out.failed++;
        break;
      }
      out.sent++;
    } catch {
      out.failed++;
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inbound: conversation with the Leader
// ---------------------------------------------------------------------------

async function replyTo(event: InboundEvent, text: string, cfg: AshlrConfig): Promise<TelegramSendResult> {
  const opts = typeof event.messageId === 'number' ? { replyToMessageId: event.messageId } : undefined;
  return sendTelegramMessage(text, opts, cfg);
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
      ({ message, reply } = await mod.answerLeaderQuestion(repliedTo.questionId, text, { channel: 'telegram' }));
    } else {
      // A reply to a memo the comms queue delivered has no thread id: name
      // the memo so the Leader knows what Mason is answering.
      const body = !repliedTo?.threadId && repliedTo?.memoId ? `(re: Leader memo ${repliedTo.memoId}) ${text}` : text;
      const res = await mod.appendMasonMessage(body, {
        channel: 'telegram',
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
      const ok = await sendThreadMessage(reply, cfg, event.messageId);
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
  } catch {
    await replyTo(event, 'Could not reach the Leader just now — try again in a few minutes.', cfg);
  }
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

async function memoDetails(memoId: string): Promise<string> {
  try {
    const { readLeaderMemo } = await import('../vision/leader-memo.js');
    const memo = readLeaderMemo(memoId);
    if (!memo) return 'That Leader memo is no longer on file.';
    const { leaderMemoText } = await import('./handlers.js');
    return scrubSecrets(leaderMemoText(memo));
  } catch {
    return 'Could not read that Leader memo.';
  }
}

async function actionDetails(actionIds: string[]): Promise<string> {
  try {
    const { findStoredAction } = await import('../vision/leader-apply.js');
    const lines: string[] = [];
    for (const id of actionIds.slice(0, MAX_ACTIONS_PER_TAP)) {
      const stored = findStoredAction(id);
      if (!stored) {
        lines.push(`${id}: no longer on file`);
        continue;
      }
      const a = stored.action;
      lines.push(`${a.id} [class ${a.class}] ${a.status}: ${a.summary}`, `  why: ${a.why}`);
    }
    return scrubSecrets(lines.join('\n')) || 'No details on file.';
  } catch {
    return 'Could not read those Leader actions.';
  }
}

/**
 * Handle an `lt:` button tap. Acks the tap (toast) and replies under the
 * tapped message with the outcome. Returns true when the tap was ours.
 */
export async function handleLeaderButton(event: InboundEvent, cfg: AshlrConfig): Promise<boolean> {
  const data = event.data ?? '';
  const m = /^lt:([avd]):(\d{1,12})$/.exec(data);
  if (!m) return false;
  const verb = m[1] as 'a' | 'v' | 'd';
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
      const lines: string[] = [];
      for (const id of actionIds) {
        const r = resultMessage(await mod.approveLeaderAction(id, { channel: 'telegram' }), 'approved');
        lines.push(`${r.ok ? 'Approved' : 'Not approved'} ${id}: ${r.message}`);
      }
      await replyTo(event, scrubSecrets(lines.join('\n')), cfg);
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
        lines.push(r.ok ? `Vetoed: ${r.message}` : `Could not veto ${id}: ${r.message}`);
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

export const TELEGRAM_HELP_TEXT = [
  'Talk to the Leader: just type. Reply to a Leader message to answer it or follow up.',
  '',
  'Commands',
  '/status — fleet, autonomy and Leader status',
  '/leader — the latest Leader memo (or /leader <text> to message the Leader)',
  '/directives — the Leader\'s standing directives and standards',
  '/help — this list',
  'pause / resume — hold or restart messages from the fleet',
  'snapshot — full fleet snapshot',
  '',
  'Buttons: Approve (an escalated action), Veto (undo a memo\'s actions), Details (the full memo).',
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
    const next = s.nextRunAt ? `, next ${s.nextRunAt.slice(0, 16).replace('T', ' ')}` : '';
    lines.push(`Leader: ${last}${next}`);
    if (s.latest) lines.push(`Latest memo: ${s.latest.id} (${ago(s.latest.at, nowMs)})`);
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
    const parts = [`Leader memo ${memo.id} — ${memo.at.slice(0, 16).replace('T', ' ')}${memo.dryRun ? ' (dry run)' : ''}`];
    if (memo.bottleneck) parts.push(`Bottleneck: ${clip(memo.bottleneck.statement, 300)}`);
    if (memo.move) parts.push(`Move: ${clip(memo.move.statement, 300)}`);
    if (memo.questionsForMason.length > 0) parts.push(`Question: ${clip(memo.questionsForMason[0]!, 300)}`);
    const facts = await memoFacts(memo.id);
    const keyboard = leaderKeyboard(
      { memoId: memo.id, ...(facts?.approvable.length ? { actionIds: facts.approvable } : {}) },
      { approve: (facts?.approvable.length ?? 0) > 0, veto: (facts?.live ?? 0) > 0 },
    );
    const res = await sendTelegramMessage(scrubSecrets(parts.join('\n')), {
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

async function directivesText(): Promise<string> {
  try {
    const { readLeaderDirectives, readStandards } = await import('../vision/leader-apply.js');
    const d = readLeaderDirectives();
    const lines: string[] = ['Directives'];
    if (!d) {
      lines.push('  none set (lane and router defaults apply)');
    } else {
      lines.push(`  grok lanes: ${d.grokLanes ?? 'default'}`);
      lines.push(`  codex lanes: ${d.codexEnabled === null ? 'default (off)' : d.codexEnabled ? 'on' : 'off'}`);
      const tuning = d.routerTuning ? Object.entries(d.routerTuning).map(([k, v]) => `${k}=${String(v)}`).join(', ') : '';
      lines.push(`  router tuning: ${tuning || 'none'}`);
      lines.push(`  updated ${d.updatedAt.slice(0, 16).replace('T', ' ')}`);
    }
    const standards = readStandards().filter((s) => !s.retiredAt);
    lines.push('', `Standards (${standards.length})`);
    for (const s of standards.slice(0, 12)) lines.push(`  • [${s.source}] ${clip(s.rule, 160)} — ${s.appliesTo}`);
    if (standards.length > 12) lines.push(`  …and ${standards.length - 12} more`);
    return scrubSecrets(lines.join('\n'));
  } catch {
    return 'Could not read the Leader directives.';
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
      await replyTo(event, TELEGRAM_HELP_TEXT, cfg);
      return true;
    case 'status':
      await replyTo(event, await buildStatusText(), cfg);
      return true;
    case 'leader':
      if (rest) await converseWithLeader(event, rest, cfg);
      else await sendLatestMemo(event, cfg);
      return true;
    case 'directives':
      await replyTo(event, await directivesText(), cfg);
      return true;
    default:
      await replyTo(event, `Unknown command /${cmd}.\n\n${TELEGRAM_HELP_TEXT}`, cfg);
      return true;
  }
}
