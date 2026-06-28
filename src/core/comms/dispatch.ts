/**
 * M137: comms dispatch cycle — send pending requests + poll + match replies.
 *
 * runCommsCycle() is the heartbeat:
 *   1. If nothing is outstanding and a pending request exists → send the next
 *      one via sendIMessage, markSent. Reports (type='report') send-and-done.
 *   2. Poll inbound replies since the watermark. For each matching numeric reply
 *      → resolveRequest + invoke the registered resolution handler for its kind.
 *   3. Advance the watermark.
 *
 * Rate limit: won't send another message if one was sent < SEND_COOLDOWN_MS ago.
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
} from '../integrations/telegram.js';
import {
  listRequests,
  markSent,
  outstanding,
  resolveRequest,
  type CommsRequest,
} from './requests.js';
import type { AshlrConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEND_COOLDOWN_MS = 30_000; // minimum gap between outbound sends

// ---------------------------------------------------------------------------
// Watermark / state
// ---------------------------------------------------------------------------

interface CommsState {
  /** Unix ms — only poll messages newer than this. */
  watermarkMs: number;
  /** Unix ms — when the last outbound message was sent. */
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

/**
 * Re-load the answered request by id and invoke its resolution handler.
 * Extracted from the three identical inline blocks in the Telegram/iMessage paths.
 */
async function reloadAndInvoke(id: string): Promise<void> {
  const { listRequests: lr } = await import('./requests.js');
  const resolved = lr({ status: 'answered' }).find((r) => r.id === id);
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CycleResult {
  sent: number;
  resolved: number;
}

/**
 * Run one comms cycle. Never throws.
 *
 * @param cfg  AshlrConfig — comms.enabled + comms.imessageHandle must be set.
 */
export async function runCommsCycle(cfg: AshlrConfig): Promise<CycleResult> {
  const result: CycleResult = { sent: 0, resolved: 0 };

  // Select transport based on cfg.comms.channel
  const isTelegram = telegramEnabled(cfg);

  try {
    const state = loadState();
    const now = Date.now();

    // ── 1. Send next pending (if nothing outstanding + cooldown elapsed) ──────

    const current = outstanding();
    const cooldownOk = now - state.lastSentMs >= SEND_COOLDOWN_MS;

    if (!current && cooldownOk) {
      const pending = listRequests({ status: 'pending' });
      if (pending.length > 0) {
        const next = pending[0]!;

        let sendOk = false;

        if (isTelegram) {
          // Telegram: send with inline keyboard buttons when the request has options
          const tgOpts =
            next.options.length > 0
              ? { buttons: next.options, requestId: next.id }
              : undefined;
          const { ok } = await sendTelegramMessage(next.text, tgOpts, cfg);
          sendOk = ok;
        } else {
          // iMessage: format text with numbered options
          const text = formatMessage(next);
          const { ok } = await sendIMessage(text, cfg);
          sendOk = ok;
        }

        if (sendOk) {
          markSent(next.id);
          state.lastSentMs = now;
          result.sent++;

          // Reports are send-and-done — immediately mark answered (no reply needed)
          if (next.type === 'report') {
            resolveRequest(next.id, -1, '(report delivered)');
            await invokeHandler({ ...next, status: 'answered', answerIndex: -1 });
            result.resolved++;
          }
        }
      }
    }

    // ── 2. Poll inbound replies ───────────────────────────────────────────────

    if (isTelegram) {
      // ── Telegram path ─────────────────────────────────────────────────────
      const { updates } = await pollTelegramUpdates(cfg);

      for (const event of updates) {
        const out = outstanding();
        if (!out) continue;

        if (event.kind === 'callback') {
          // Button tap: resolve directly by requestId + optionIndex (no numeric parsing)
          if (
            event.requestId === out.id &&
            typeof event.optionIndex === 'number' &&
            event.optionIndex >= 0 &&
            event.optionIndex < out.options.length
          ) {
            resolveRequest(out.id, event.optionIndex);

            // Ack the button tap so Telegram removes the spinner
            if (event.callbackQueryId) {
              await answerCallbackQuery(event.callbackQueryId, cfg);
            }

            await reloadAndInvoke(out.id);
            result.resolved++;
          }
        } else if (event.kind === 'text' && event.text) {
          // Text fallback: still accept leading numeric reply (e.g. "1", "2 approve")
          const match = /^\s*(\d+)\b/.exec(event.text);
          if (!match) continue;

          const num = parseInt(match[1]!, 10);
          if (num < 1 || num > out.options.length) continue;

          const answerIndex = num - 1;
          resolveRequest(out.id, answerIndex);

          await reloadAndInvoke(out.id);
          result.resolved++;
        }
      }

      // Telegram uses its own offset file — no watermarkMs needed
      saveState({ ...state });
    } else {
      // ── iMessage path ─────────────────────────────────────────────────────
      // Lazy import to allow mocking in tests
      const { pollInboundReplies } = await import('../integrations/imessage.js');
      const inbound = await pollInboundReplies(state.watermarkMs, cfg);
      let newWatermark = state.watermarkMs;

      for (const msg of inbound) {
        if (msg.ts > newWatermark) newWatermark = msg.ts;

        // Only attempt resolution if there's an outstanding question/approval
        const out = outstanding();
        if (!out) continue;

        // Parse leading integer from the reply text (1-based)
        const match = /^\s*(\d+)\b/.exec(msg.text);
        if (!match) continue; // non-numeric — safe start: ignore

        const num = parseInt(match[1]!, 10);
        if (num < 1 || num > out.options.length) continue; // out-of-range

        const answerIndex = num - 1; // convert to 0-based
        resolveRequest(out.id, answerIndex);

        await reloadAndInvoke(out.id);
        result.resolved++;
      }

      // ── 3. Advance watermark ─────────────────────────────────────────────
      saveState({ ...state, watermarkMs: newWatermark });
    }
  } catch {
    // top-level safety net — runCommsCycle NEVER throws
  }

  return result;
}
