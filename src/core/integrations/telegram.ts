/**
 * M147: Telegram Bot API transport adapter.
 *
 * Provides three primitives:
 *   sendTelegramMessage(text, opts?, cfg)   — POST sendMessage with optional inline buttons
 *   pollTelegramUpdates(cfg)                — getUpdates since stored offset; returns InboundEvents
 *   answerCallbackQuery(queryId, cfg)       — ack a button tap so Telegram removes the spinner
 *
 * Configuration (cfg.comms.telegram):
 *   botToken  — Bot API token from @BotFather. Read from cfg OR TELEGRAM_BOT_TOKEN env.
 *               NEVER logged, NEVER included in errors.
 *   chatId    — The numeric/string chat id to send to and accept messages from.
 *
 * Security:
 *   - Token is NEVER thrown in errors, NEVER logged.
 *   - Only updates whose chat id === cfg.comms.telegram.chatId are returned; all others dropped.
 *   - No-op when not configured (no throw).
 *   - Network done via node fetch/https, never a shell.
 *
 * Offset persistence: ~/.ashlr/comms/telegram-offset (plain text, one integer).
 *
 * Never throws — all errors silently degrade to {ok:false} / [].
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelegramSendOpts {
  /** Inline button labels. One per row. callback_data = "<requestId>:<optionIndex>". */
  buttons?: string[];
  /** requestId to embed in callback_data (required when buttons is set). */
  requestId?: string;
}

export interface TelegramSendResult {
  ok: boolean;
  messageId?: number;
}

/** An inbound event parsed from a Telegram update. */
export interface InboundEvent {
  /** 'text' = normal message; 'callback' = button tap. */
  kind: 'text' | 'callback';
  /** Raw message text (kind='text'). */
  text?: string;
  /** Parsed from callback_data (kind='callback'). */
  requestId?: string;
  /** 0-based option index parsed from callback_data (kind='callback'). */
  optionIndex?: number;
  /** The chat id this event came from. */
  fromChatId: string;
  /** Telegram callback_query id — needed to ack via answerCallbackQuery. */
  callbackQueryId?: string;
}

export interface PollResult {
  updates: InboundEvent[];
  newOffset: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function offsetPath(): string {
  return join(homedir(), '.ashlr', 'comms', 'telegram-offset');
}

function loadOffset(): number {
  try {
    const raw = readFileSync(offsetPath(), 'utf8').trim();
    const n = parseInt(raw, 10);
    return isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function saveOffset(offset: number): void {
  try {
    const dir = join(homedir(), '.ashlr', 'comms');
    mkdirSync(dir, { recursive: true });
    writeFileSync(offsetPath(), String(offset), 'utf8');
  } catch {
    // best-effort
  }
}

/**
 * Resolve the bot token. Prefer cfg; fall back to TELEGRAM_BOT_TOKEN env.
 * Returns undefined when neither is set.
 * NEVER log the returned value.
 */
function resolveToken(cfg: AshlrConfig): string | undefined {
  return cfg.comms?.telegram?.botToken ?? process.env['TELEGRAM_BOT_TOKEN'];
}

function resolveChatId(cfg: AshlrConfig): string | undefined {
  return cfg.comms?.telegram?.chatId;
}

/** True when Telegram transport is usably configured. */
export function telegramEnabled(cfg: AshlrConfig): boolean {
  return (
    cfg.comms?.channel === 'telegram' &&
    cfg.comms?.enabled === true &&
    typeof resolveToken(cfg) === 'string' &&
    (resolveToken(cfg)?.length ?? 0) > 0 &&
    typeof resolveChatId(cfg) === 'string' &&
    (resolveChatId(cfg)?.length ?? 0) > 0
  );
}

/** Build the Telegram Bot API base URL without ever logging the token. */
function apiUrl(cfg: AshlrConfig, method: string): string {
  const token = resolveToken(cfg) ?? '';
  return `https://api.telegram.org/bot${token}/${method}`;
}

/** Scrub token from an error message so it never leaks. */
function scrubToken(msg: string, token: string | undefined): string {
  if (!token) return msg;
  // Replace all occurrences of the token (it may appear in a URL)
  return msg.split(token).join('[REDACTED]');
}

/** Make an HTTPS POST with JSON body. Returns parsed response body or null on error. */
async function postJson(
  url: string,
  body: unknown,
  _token: string | undefined,
): Promise<unknown> {
  const payload = JSON.stringify(body);
  return new Promise<unknown>((resolve) => {
    // Dynamic import to allow test mocks to intercept
    import('node:https').then(({ request }) => {
      const parsed = new URL(url);
      const options = {
        hostname: parsed.hostname,
        port: 443,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 10_000,
      };
      const req = request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            resolve(null);
          }
        });
        res.on('error', () => resolve(null));
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(payload);
      req.end();
    }).catch(() => resolve(null));
  }).catch(() => null);
}

// ---------------------------------------------------------------------------
// sendTelegramMessage
// ---------------------------------------------------------------------------

/**
 * Send a Telegram message to cfg.comms.telegram.chatId.
 *
 * When opts.buttons is set, each button becomes a row in an inline_keyboard.
 * callback_data = "<requestId>:<0-based-index>" for clean resolution.
 *
 * No-op (ok:false) when not configured. Never throws.
 */
export async function sendTelegramMessage(
  text: string,
  opts?: TelegramSendOpts,
  cfg?: AshlrConfig,
): Promise<TelegramSendResult> {
  if (!cfg || !telegramEnabled(cfg)) return { ok: false };

  const token = resolveToken(cfg);
  const chatId = resolveChatId(cfg)!;

  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    };

    if (opts?.buttons && opts.buttons.length > 0) {
      const reqId = opts.requestId ?? 'unknown';
      body['reply_markup'] = {
        inline_keyboard: opts.buttons.map((label, idx) => [
          { text: label, callback_data: `${reqId}:${idx}` },
        ]),
      };
    }

    const url = apiUrl(cfg, 'sendMessage');
    const resp = await postJson(url, body, token);

    if (
      resp &&
      typeof resp === 'object' &&
      (resp as Record<string, unknown>)['ok'] === true
    ) {
      const result = (resp as Record<string, unknown>)['result'] as Record<string, unknown> | undefined;
      return { ok: true, messageId: typeof result?.['message_id'] === 'number' ? result['message_id'] : undefined };
    }
    return { ok: false };
  } catch (err) {
    // Scrub token from any error that might surface it
    const msg = err instanceof Error ? err.message : String(err);
    void scrubToken(msg, token); // consume to satisfy lint; we don't re-throw
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// pollTelegramUpdates
// ---------------------------------------------------------------------------

/**
 * Poll for new Telegram updates using getUpdates long-poll (offset-based).
 * Returns InboundEvents for text messages AND callback_query button taps.
 * Drops updates from any chat id !== cfg.comms.telegram.chatId.
 * Advances and persists the offset on each call.
 * Never throws.
 */
export async function pollTelegramUpdates(cfg: AshlrConfig): Promise<PollResult> {
  if (!telegramEnabled(cfg)) return { updates: [], newOffset: 0 };

  const token = resolveToken(cfg);
  const allowedChatId = resolveChatId(cfg)!;
  const offset = loadOffset();

  try {
    const body: Record<string, unknown> = {
      timeout: 0,       // non-blocking poll; dispatch cycle handles timing
      allowed_updates: ['message', 'callback_query'],
    };
    if (offset > 0) body['offset'] = offset;

    const url = apiUrl(cfg, 'getUpdates');
    const resp = await postJson(url, body, token);

    if (
      !resp ||
      typeof resp !== 'object' ||
      (resp as Record<string, unknown>)['ok'] !== true
    ) {
      return { updates: [], newOffset: offset };
    }

    const rawUpdates = (resp as Record<string, unknown>)['result'];
    if (!Array.isArray(rawUpdates) || rawUpdates.length === 0) {
      return { updates: [], newOffset: offset };
    }

    const events: InboundEvent[] = [];
    let maxUpdateId = offset - 1;

    for (const upd of rawUpdates) {
      if (typeof upd !== 'object' || upd === null) continue;
      const u = upd as Record<string, unknown>;
      const updateId = typeof u['update_id'] === 'number' ? u['update_id'] : -1;
      if (updateId > maxUpdateId) maxUpdateId = updateId;

      // Text message
      if (u['message'] && typeof u['message'] === 'object') {
        const msg = u['message'] as Record<string, unknown>;
        const chat = (msg['chat'] as Record<string, unknown> | undefined);
        const fromChatId = String(chat?.['id'] ?? '');
        if (fromChatId !== String(allowedChatId)) continue; // auth: drop foreign

        const text = typeof msg['text'] === 'string' ? msg['text'] : undefined;
        if (text !== undefined) {
          events.push({ kind: 'text', text, fromChatId });
        }
      }

      // Callback query (button tap)
      if (u['callback_query'] && typeof u['callback_query'] === 'object') {
        const cbq = u['callback_query'] as Record<string, unknown>;
        const chat = ((cbq['message'] as Record<string, unknown> | undefined)?.['chat'] as Record<string, unknown> | undefined);
        const fromChatId = String(chat?.['id'] ?? '');
        if (fromChatId !== String(allowedChatId)) continue; // auth: drop foreign

        const callbackQueryId = typeof cbq['id'] === 'string' ? cbq['id'] : undefined;
        const data = typeof cbq['data'] === 'string' ? cbq['data'] : '';
        // Parse callback_data = "<requestId>:<optionIndex>"
        const colonIdx = data.lastIndexOf(':');
        if (colonIdx < 0) continue; // malformed — skip
        const reqId = data.slice(0, colonIdx);
        const idxRaw = parseInt(data.slice(colonIdx + 1), 10);
        if (!isFinite(idxRaw)) continue;

        events.push({
          kind: 'callback',
          requestId: reqId,
          optionIndex: idxRaw,
          fromChatId,
          callbackQueryId,
        });
      }
    }

    // Advance offset to maxUpdateId + 1 so acknowledged updates are not re-delivered
    const newOffset = maxUpdateId >= 0 ? maxUpdateId + 1 : offset;
    saveOffset(newOffset);

    return { updates: events, newOffset };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void scrubToken(msg, token);
    return { updates: [], newOffset: offset };
  }
}

// ---------------------------------------------------------------------------
// answerCallbackQuery
// ---------------------------------------------------------------------------

/**
 * Acknowledge a Telegram callback_query so the spinner on the button is removed.
 * Fire-and-forget; never throws.
 */
export async function answerCallbackQuery(
  callbackQueryId: string,
  cfg: AshlrConfig,
): Promise<void> {
  if (!telegramEnabled(cfg)) return;
  try {
    const url = apiUrl(cfg, 'answerCallbackQuery');
    await postJson(url, { callback_query_id: callbackQueryId }, resolveToken(cfg));
  } catch {
    // best-effort ack — failure is harmless (spinner times out on its own)
  }
}
