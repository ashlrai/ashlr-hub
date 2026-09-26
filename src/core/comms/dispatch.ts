/**
 * M137 / 3.14: comms dispatch cycle — poll + route replies, then send.
 *
 * runCommsCycle() is the heartbeat (launchd ai.ashlr.comms-poll, every 180 s):
 *   0. One-time queue migration (comms/migrations.ts), then TTL expiry.
 *   1. Poll inbound FIRST, so Mason's replies and commands act this cycle —
 *      even while comms are paused (otherwise "resume" could never arrive).
 *      Telegram routing lives in telegram-channel.ts: keywords, /commands,
 *      Leader-button taps, answers to a Leader question, numbered answers to
 *      the outstanding button-question, and free text to the Leader thread.
 *   2. Send (skipped while paused):
 *      a. informational messages — reports (digests, Leader memos, test
 *         pings) and, on Telegram, the Leader thread's pending messages.
 *         They NEVER wait for an unanswered question; they are only paced
 *         (≥ sendGapMs apart, at most batchCap per cycle).
 *      b. the single question slot — a question/approval that expects a
 *         numbered answer or a button tap goes out only when no other one is
 *         outstanding and the question cooldown has elapsed.
 *
 * Why the split: before 3.14 every message shared one slot, so a single
 * unanswered June briefing held back 594 rows — including both Leader memos.
 *
 * Expiry: requests older than cfg.comms.requestTtlHours (default 48h) are
 * expired, so an unanswered question cannot block the question slot.
 *
 * Resolution handler registry: other modules call registerResolutionHandler(kind, fn)
 * to receive callbacks when a request of their kind is answered. Best-effort.
 *
 * Never throws.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sendIMessage } from '../integrations/imessage.js';
import {
  sendTelegramMessage,
  pollTelegramUpdates,
  answerCallbackQuery,
  telegramEnabled,
  type InboundEvent,
} from '../integrations/telegram.js';
import {
  DEFAULT_REQUEST_TTL_HOURS,
  expireStaleRequests,
  listRequests,
  markReportDelivered,
  markSent,
  noteSendFailure,
  outstanding,
  resolveRequest,
  type CommsRequest,
} from './requests.js';
import { runCommsMigrationsOnce, type CommsMigrationSummary } from './migrations.js';
import {
  converseWithLeader,
  createPacer,
  drainLeaderThread,
  handleLeaderButton,
  handleSlashCommand,
  LEADER_CALLBACK_PREFIX,
  paceNext,
  recordPacedSend,
  sendReportViaTelegram,
  type SendPacer,
} from './telegram-channel.js';
import { scrubSecrets } from '../util/scrub.js';
import type { AshlrConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum gap between two button-QUESTION sends (informational sends are paced separately). */
const QUESTION_COOLDOWN_MS = 30_000;
/** Default gap between informational sends within one cycle (Telegram flood limits). */
export const DEFAULT_SEND_GAP_MS = 3_000;
/** Default cap on informational sends per cycle; the rest go next cycle. */
export const DEFAULT_BATCH_CAP = 8;
/** A report that fails this many sends in a row is expired, so it cannot wedge the queue. */
const MAX_REPORT_SEND_FAILURES = 3;

/** Request TTL in ms from cfg.comms.requestTtlHours; invalid values use the default. */
export function commsRequestTtlMs(cfg: AshlrConfig): number {
  const hours = cfg.comms?.requestTtlHours;
  const valid = typeof hours === 'number' && Number.isFinite(hours) && hours > 0;
  return (valid ? hours : DEFAULT_REQUEST_TTL_HOURS) * 3_600_000;
}

// ---------------------------------------------------------------------------
// Watermark / state
// ---------------------------------------------------------------------------

interface CommsState {
  /** Unix ms — only poll messages newer than this. */
  watermarkMs: number;
  /** Unix ms — when the last button-question was sent (question cooldown). */
  lastSentMs: number;
}

function statePath(): string {
  return join(homedir(), '.ashlr', 'comms', 'state.json');
}

function loadState(): CommsState {
  try {
    if (!existsSync(statePath())) return { watermarkMs: Date.now(), lastSentMs: 0 };
    const raw = readFileSync(statePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<CommsState>;
    return {
      watermarkMs: typeof parsed.watermarkMs === 'number' ? parsed.watermarkMs : Date.now(),
      lastSentMs: typeof parsed.lastSentMs === 'number' ? parsed.lastSentMs : 0,
    };
  } catch {
    return { watermarkMs: Date.now(), lastSentMs: 0 };
  }
}

function saveState(s: CommsState): void {
  try {
    const dir = join(homedir(), '.ashlr', 'comms');
    mkdirSync(dir, { recursive: true });
    writeFileSync(statePath(), JSON.stringify(s, null, 2) + '\n', 'utf8');
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Resolution handler registry
// ---------------------------------------------------------------------------

type ResolutionHandler = (req: CommsRequest) => void | Promise<void>;
const _handlers = new Map<string, ResolutionHandler>();

/**
 * Register a handler invoked when a request of the given kind is answered.
 * The latest registration for a kind wins. Handler is called best-effort —
 * errors are swallowed. This is the hook for Elon/Manager siblings to wire in.
 */
export function registerResolutionHandler(kind: string, fn: ResolutionHandler): void {
  _handlers.set(kind, fn);
}

async function invokeHandler(req: CommsRequest): Promise<void> {
  const fn = _handlers.get(req.kind);
  if (!fn) return;
  try {
    await fn(req);
  } catch {
    // best-effort — handler errors must not crash the cycle
  }
}

/** Re-load the answered request by id and invoke its resolution handler. */
async function reloadAndInvoke(id: string): Promise<void> {
  const resolved = listRequests({ status: 'answered' }).find((r) => r.id === id);
  if (resolved) {
    await invokeHandler(resolved);
  }
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

/**
 * Format a request as an iMessage text. Reports send the text as-is.
 * Questions/approvals append numbered options.
 */
function formatMessage(req: CommsRequest): string {
  if (req.type === 'report' || req.options.length === 0) {
    return req.text;
  }
  const opts = req.options.map((o, i) => `${i + 1}. ${o}`).join('  ');
  return `${req.text}\n\nReply ${req.options.length === 1 ? '1' : `1-${req.options.length}`}: ${opts}`;
}

/**
 * A numbered answer is a message that is JUST a number ("2", " 2. ").
 * Anything longer is conversation and goes to the Leader — before 3.14 any
 * leading integer ("3 things I want…") was swallowed as an option pick.
 */
const NUMERIC_ANSWER_RE = /^\s*(\d{1,3})\s*[.)]?\s*$/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CycleResult {
  sent: number;
  resolved: number;
  /** Present only on the cycle that ran the one-time queue migration. */
  migration?: CommsMigrationSummary;
}

export interface CycleOptions {
  /** Gap between informational sends (ms). Default DEFAULT_SEND_GAP_MS. */
  sendGapMs?: number;
  /** Max informational sends this cycle. Default DEFAULT_BATCH_CAP. */
  batchCap?: number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Telegram inbound
// ---------------------------------------------------------------------------

function replyOpts(event: InboundEvent): { replyToMessageId: number } | undefined {
  return typeof event.messageId === 'number' ? { replyToMessageId: event.messageId } : undefined;
}

/** "revert:<proposalId>:<repo>" — creates a SIGNED REVERT PROPOSAL. Never applies. */
async function handleRevert(spec: string, event: InboundEvent, cfg: AshlrConfig): Promise<void> {
  const m = /^\s*revert:([^:]+):(.*)$/i.exec(spec);
  if (!m) return;
  const proposalId = (m[1] ?? '').trim();
  const repo = (m[2] ?? '').trim();
  if (!proposalId) return;
  try {
    const { buildRevertProposal } = await import('./events.js');
    const proposal = await buildRevertProposal(proposalId, repo || process.cwd(), cfg);
    const text = proposal
      ? `Revert proposal created (pending, not applied): "${proposal.title}" — review at http://localhost:4317/proposals/${proposal.id}`
      : `Could not create revert proposal for "${proposalId}" — see dashboard for details`;
    await sendTelegramMessage(text, replyOpts(event), cfg);
  } catch {
    // best-effort
  }
}

async function handleTelegramCallback(event: InboundEvent, cfg: AshlrConfig, result: CycleResult): Promise<void> {
  if (event.data?.startsWith(LEADER_CALLBACK_PREFIX)) {
    await handleLeaderButton(event, cfg);
    return;
  }
  if (event.data?.startsWith('revert:')) {
    if (event.callbackQueryId) await answerCallbackQuery(event.callbackQueryId, cfg, 'Creating a revert proposal…');
    await handleRevert(event.data, event, cfg);
    return;
  }
  // Button tap on a numbered question: resolve by requestId + optionIndex.
  const out = outstanding();
  if (
    out &&
    event.requestId === out.id &&
    typeof event.optionIndex === 'number' &&
    event.optionIndex >= 0 &&
    event.optionIndex < out.options.length
  ) {
    resolveRequest(out.id, event.optionIndex);
    // Ack the button tap so Telegram removes the spinner
    if (event.callbackQueryId) await answerCallbackQuery(event.callbackQueryId, cfg);
    await reloadAndInvoke(out.id);
    result.resolved++;
    return;
  }
  // A tap on an expired / already-answered question: say so instead of spinning.
  if (event.callbackQueryId) await answerCallbackQuery(event.callbackQueryId, cfg, 'That question is no longer open.');
}

async function handleTelegramText(event: InboundEvent, text: string, cfg: AshlrConfig, result: CycleResult): Promise<void> {
  // M212: pause/resume commands (comms soft-pause).
  if (/^\s*pause(\s+fleet)?\s*$/i.test(text)) {
    const { setPause } = await import('./pause.js');
    setPause(true);
    await sendTelegramMessage('⏸ Fleet messages paused. Send "resume" to restart.', replyOpts(event), cfg);
    return;
  }
  if (/^\s*resume(\s+fleet)?\s*$/i.test(text)) {
    const { setPause } = await import('./pause.js');
    setPause(false);
    await sendTelegramMessage('▶️ Fleet resumed.', replyOpts(event), cfg);
    return;
  }

  // M215: "snapshot" / "dashboard" — read-only fleet snapshot.
  if (/^\s*(snapshot|dashboard|status\s+full)\s*$/i.test(text)) {
    try {
      const { buildFleetSnapshot } = await import('./events.js');
      const snapshot = await buildFleetSnapshot(cfg);
      await sendTelegramMessage(snapshot, replyOpts(event), cfg);
    } catch {
      // best-effort — never crash the cycle
    }
    return;
  }

  // M215: "revert:<proposalId>:<repo>" typed (or from an old merge button).
  if (/^\s*revert:[^:]+:/i.test(text)) {
    await handleRevert(text, event, cfg);
    return;
  }

  // 3.14: /help /start /status /leader /directives (unknown /x → help).
  if (await handleSlashCommand(event, text, cfg)) return;

  // A Telegram reply to one of our Leader messages is conversation — even a
  // bare number ("2") answering a Leader question — so it never picks an
  // option of an unrelated outstanding button-question.
  const { lookupTelegramMessage } = await import('./telegram-thread-map.js');
  const repliedTo = lookupTelegramMessage(event.replyToMessageId);
  if (!repliedTo || (!repliedTo.threadId && !repliedTo.memoId)) {
    const out = outstanding();
    const numMatch = out ? NUMERIC_ANSWER_RE.exec(text) : null;
    const num = numMatch ? parseInt(numMatch[1]!, 10) : NaN;
    if (out && numMatch && num >= 1 && num <= out.options.length) {
      resolveRequest(out.id, num - 1);
      await reloadAndInvoke(out.id);
      result.resolved++;
      return;
    }
  }

  // Everything else is Mason talking to the Leader. Auth: telegram.ts already
  // dropped messages from foreign chat ids, so this path is Mason-only.
  await converseWithLeader(event, text, cfg);
}

async function pollTelegram(cfg: AshlrConfig, result: CycleResult): Promise<void> {
  const { updates } = await pollTelegramUpdates(cfg);
  for (const event of updates ?? []) {
    try {
      if (event.kind === 'callback') await handleTelegramCallback(event, cfg, result);
      else if (event.kind === 'text' && event.text) await handleTelegramText(event, event.text, cfg, result);
    } catch {
      // one bad event must not stop the rest
    }
  }
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

/** Send every pending report (FIFO), paced. Reports never wait for a question. */
async function sendReports(cfg: AshlrConfig, isTelegram: boolean, pacer: SendPacer, result: CycleResult): Promise<void> {
  const reports = listRequests({ status: 'pending', type: 'report' });
  for (const next of reports) {
    if (!(await paceNext(pacer))) return;
    const ok = isTelegram
      ? await sendReportViaTelegram(next, cfg)
      : (await sendIMessage(scrubSecrets(formatMessage(next)), cfg)).ok;
    recordPacedSend(pacer);
    if (!ok) {
      // Transport is likely down — retry next cycle; a report that keeps
      // failing is expired so it cannot wedge the ones behind it.
      noteSendFailure(next.id, Date.now(), MAX_REPORT_SEND_FAILURES);
      return;
    }
    markReportDelivered(next.id);
    result.sent++;
    await invokeHandler({ ...next, status: 'answered', answerIndex: -1 });
    result.resolved++;
  }
}

/** The single question slot: one button-question outstanding at a time. */
async function sendNextQuestion(cfg: AshlrConfig, isTelegram: boolean, state: CommsState, nowMs: number, result: CycleResult): Promise<void> {
  if (outstanding()) return;
  if (nowMs - state.lastSentMs < QUESTION_COOLDOWN_MS) return;
  const next = listRequests({ status: 'pending' }).find((r) => r.type !== 'report');
  if (!next) return;

  let sendOk = false;
  if (isTelegram) {
    const tgOpts = next.options.length > 0 ? { buttons: next.options, requestId: next.id } : undefined;
    const { ok } = await sendTelegramMessage(scrubSecrets(next.text), tgOpts, cfg);
    sendOk = ok;
  } else {
    const { ok } = await sendIMessage(scrubSecrets(formatMessage(next)), cfg);
    sendOk = ok;
  }
  if (sendOk) {
    markSent(next.id);
    state.lastSentMs = nowMs;
    result.sent++;
  }
}

/**
 * Run one comms cycle. Never throws.
 *
 * @param cfg  AshlrConfig — comms.enabled + a configured channel.
 */
export async function runCommsCycle(cfg: AshlrConfig, opts: CycleOptions = {}): Promise<CycleResult> {
  const result: CycleResult = { sent: 0, resolved: 0 };
  const isTelegram = telegramEnabled(cfg);

  try {
    const { isPaused } = await import('./pause.js');
    const state = loadState();
    const now = Date.now();

    // ── 0. One-time migration, then expire stale requests ─────────────────
    const migration = runCommsMigrationsOnce(now);
    if (migration) result.migration = migration;
    expireStaleRequests(now, commsRequestTtlMs(cfg));

    // ── 1. Inbound ────────────────────────────────────────────────────────
    if (isTelegram) {
      // Polled even while paused, so "resume" (and /status) still work.
      await pollTelegram(cfg, result);
    } else if (!isPaused()) {
      // iMessage: only numbered answers to the outstanding question.
      const { pollInboundReplies } = await import('../integrations/imessage.js');
      const inbound = await pollInboundReplies(state.watermarkMs, cfg);
      let newWatermark = state.watermarkMs;
      for (const msg of inbound) {
        if (msg.ts > newWatermark) newWatermark = msg.ts;
        const out = outstanding();
        if (!out) continue;
        const match = /^\s*(\d+)\b/.exec(msg.text);
        if (!match) continue; // non-numeric — safe start: ignore
        const num = parseInt(match[1]!, 10);
        if (num < 1 || num > out.options.length) continue; // out-of-range
        resolveRequest(out.id, num - 1);
        await reloadAndInvoke(out.id);
        result.resolved++;
      }
      state.watermarkMs = newWatermark;
    }

    // ── 2. Outbound (held while paused) ───────────────────────────────────
    if (!isPaused()) {
      const pacer = createPacer({
        gapMs: opts.sendGapMs ?? DEFAULT_SEND_GAP_MS,
        batchCap: opts.batchCap ?? DEFAULT_BATCH_CAP,
        ...(opts.sleep ? { sleep: opts.sleep } : {}),
      });
      await sendReports(cfg, isTelegram, pacer, result);
      if (isTelegram) {
        const drained = await drainLeaderThread(cfg, pacer);
        result.sent += drained.sent;
      }
      await sendNextQuestion(cfg, isTelegram, state, now, result);
    }

    saveState(state);
  } catch {
    // top-level safety net — runCommsCycle NEVER throws
  }

  return result;
}
