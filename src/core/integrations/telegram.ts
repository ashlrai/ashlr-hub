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
 * Formatting (3.14): every send uses parse_mode=HTML, so text is ESCAPED by
 * default (escapeTelegramHtml) — a stray `<` in model text used to make
 * Telegram reject the whole send. Callers that build Telegram HTML themselves
 * pass `html: true`. Messages over 4096 chars are split on line boundaries;
 * buttons ride on the last chunk. A send Telegram rejects for bad markup is
 * retried once as plain text.
 *
 * Threading (3.14): sends can reply to a message (replyToMessageId) and
 * report every message_id they produced; inbound events carry the message's
 * own id and the id it replied to, so the comms layer can map Telegram
 * messages to Leader-thread messages.
 *
 * Never throws — all errors silently degrade to {ok:false} / [].
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../types.js';
import { splitTelegramText, telegramHtmlToPlain } from './telegram-format.js';

export { escapeTelegramHtml, splitTelegramText, TELEGRAM_MAX_MESSAGE } from './telegram-format.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One inline-keyboard button: a callback (data ≤ 64 bytes) or a public URL. */
export type TelegramButton = { text: string; data: string } | { text: string; url: string };

export interface TelegramSendOpts {
  /**
   * Inline button labels. One per row. callback_data = "<requestId>:<optionIndex>".
   * A label of the form "Label|target" sends `target` as the callback_data
   * instead (or as a URL button when target is a public http(s) URL; local
   * URLs Telegram cannot open are dropped).
   */
  buttons?: string[];
  /** requestId to embed in callback_data (required when buttons is set). */
  requestId?: string;
  /** Explicit inline keyboard (rows of buttons). Takes precedence over `buttons`. */
  keyboard?: TelegramButton[][];
  /** The text is caller-built Telegram HTML — do not escape it. Default false. */
  html?: boolean;
  /** Send as a reply to this Telegram message id (ignored if it no longer exists). */
  replyToMessageId?: number;
}

export interface TelegramSendResult {
  ok: boolean;
  /** Validated Bot API error metadata; descriptions/credential-bearing URLs stay internal. */
  errorCode?: number;
  retryAfterSeconds?: number;
  /** message_id of the FIRST chunk (the one a reply should target). */
  messageId?: number;
  /** message_id of every chunk that was delivered, in order. */
  messageIds?: number[];
  /** True when the text was split and a later chunk failed after the first landed. */
  partial?: boolean;
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
  /** kind='text': this message's id. kind='callback': the id of the message whose button was tapped. */
  messageId?: number;
  /** kind='text': the id of the message Mason replied to (reply_to_message), if any. */
  replyToMessageId?: number;
  /**
   * kind='callback': the raw callback_data, set for routed prefixes
   * (`lt:` Leader-thread buttons, `revert:` merge buttons) that are not
   * "<requestId>:<index>" pairs.
   */
  data?: string;
}

/** callback_data prefixes routed by the comms layer instead of the request store. */
const ROUTED_CALLBACK_PREFIXES = ['lt:', 'revert:'];

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

/** Opaque configuration binding; never contains the bot token or chat identity. */
export function telegramQuestionNamespace(cfg: AshlrConfig, receivedChatId?: string): string | null {
  const token = resolveToken(cfg), chatId = resolveChatId(cfg);
  if (!telegramEnabled(cfg) || !token || !chatId || receivedChatId !== undefined && receivedChatId !== String(chatId)) return null;
  return createHash('sha256').update(JSON.stringify(['leader-question-v1', token, String(chatId)])).digest('hex');
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

/**
 * Test seam: a fake Bot API transport. Receives the METHOD name (never the
 * URL, so the token cannot leak into a fake) and the JSON body; returns the
 * parsed API response (or null for a network failure). Null restores HTTPS.
 */
export type TelegramTransport = (method: string, body: Record<string, unknown>) => Promise<unknown>;
let _transport: TelegramTransport | null = null;
export function setTelegramTransportForTests(t: TelegramTransport | null): void {
  _transport = t;
}

async function callApi(cfg: AshlrConfig, method: string, body: Record<string, unknown>): Promise<unknown> {
  if (_transport) {
    try {
      return await _transport(method, body);
    } catch {
      return null;
    }
  }
  return postJson(apiUrl(cfg, method), body, resolveToken(cfg));
}

/** Explicit operator action only; ordinary sends/startup never update this profile. */
export const TELEGRAM_PHANTOM_BRAND = Object.freeze({
  name: 'Phantom',
  description: 'Phantom by AshlrAI brings your engineering agents together. Follow fleet progress, answer the Leader, and guide work from Telegram.',
  shortDescription: 'Phantom by AshlrAI — your engineering fleet, wherever you are.',
});

type BrandField = keyof typeof TELEGRAM_PHANTOM_BRAND;
type BrandFieldState = 'different' | 'unchanged' | 'verified' | 'failed' | 'unconfirmed' | 'not-attempted';
interface BrandError {
  stage: 'configuration' | 'identity' | BrandField;
  reason: 'not-configured' | 'invalid-bot-id' | 'bot-mismatch' | 'malformed-response' | 'rejected' | 'unavailable' | 'readback-different';
  errorCode?: number;
  retryAfterSeconds?: number;
}
export interface TelegramBrandResult {
  mode: 'preview' | 'apply';
  status: 'preview' | 'verified' | 'partial' | 'blocked' | 'unknown';
  botId: number | null;
  username: string | null;
  fields: Record<BrandField, { desired: string; state: BrandFieldState }>;
  errors: BrandError[];
  checkedAt: string;
}

const BRAND_FIELDS = [
  { key: 'name', getter: 'getMyName', setter: 'setMyName', parameter: 'name', limit: 64 },
  { key: 'description', getter: 'getMyDescription', setter: 'setMyDescription', parameter: 'description', limit: 512 },
  { key: 'shortDescription', getter: 'getMyShortDescription', setter: 'setMyShortDescription', parameter: 'short_description', limit: 120 },
] as const;

function brandObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Provider descriptions/URLs/profile prose never enter the public result. */
function brandFailure(value: unknown, stage: BrandError['stage']): BrandError {
  const response = brandObject(value);
  if (!response) return { stage, reason: 'unavailable' };
  if (response['ok'] !== false) return { stage, reason: 'malformed-response' };
  const parsed = parseSendResponse(response);
  return { stage, reason: 'rejected',
    ...(parsed.errorCode !== undefined ? { errorCode: parsed.errorCode } : {}),
    ...(parsed.retryAfterSeconds !== undefined ? { retryAfterSeconds: parsed.retryAfterSeconds } : {}) };
}

async function observeTelegramBrand(cfg: AshlrConfig, expectedBotId?: number): Promise<{
  botId: number | null; username: string | null; values: Partial<Record<BrandField, string>>; errors: BrandError[];
}> {
  const observation = { botId: null as number | null, username: null as string | null,
    values: {} as Partial<Record<BrandField, string>>, errors: [] as BrandError[] };
  const raw = await callApi(cfg, 'getMe', {}), response = brandObject(raw), bot = brandObject(response?.['result']);
  if (response?.['ok'] !== true || !bot || !positiveSafeInteger(bot['id']) || bot['is_bot'] !== true) {
    observation.errors.push(brandFailure(raw, 'identity'));
    return observation;
  }
  observation.botId = bot['id'];
  // Username is public identity, but malformed/arbitrary free text is not echoed.
  if (typeof bot['username'] === 'string' && /^[a-zA-Z0-9_]{5,32}$/.test(bot['username'])) observation.username = bot['username'];
  if (expectedBotId !== undefined && observation.botId !== expectedBotId) {
    observation.errors.push({ stage: 'identity', reason: 'bot-mismatch' });
    return observation;
  }
  const responses = await Promise.all(BRAND_FIELDS.map((field) => callApi(cfg, field.getter, { language_code: '' })));
  BRAND_FIELDS.forEach((field, index) => {
    const value = responses[index], envelope = brandObject(value), result = brandObject(envelope?.['result']);
    const text = result?.[field.parameter];
    if (envelope?.['ok'] !== true || typeof text !== 'string' || [...text].length > field.limit) {
      observation.errors.push(brandFailure(value, field.key));
    } else observation.values[field.key] = text;
  });
  return observation;
}

/** Preview is read-only. Apply binds the same configured bot, writes only differing
 * default-locale fields, then verifies fresh facts. Telegram has no multi-field CAS;
 * failures never authorize a retry/rollback or an automatic startup migration. */
export async function syncTelegramDisplayBrand(
  cfg: AshlrConfig, opts: { apply?: boolean; expectedBotId?: number } = {},
): Promise<TelegramBrandResult> {
  const result: TelegramBrandResult = { mode: opts.apply ? 'apply' : 'preview', status: 'unknown', botId: null, username: null,
    fields: { name: { desired: TELEGRAM_PHANTOM_BRAND.name, state: 'not-attempted' },
      description: { desired: TELEGRAM_PHANTOM_BRAND.description, state: 'not-attempted' },
      shortDescription: { desired: TELEGRAM_PHANTOM_BRAND.shortDescription, state: 'not-attempted' } },
    errors: [], checkedAt: new Date().toISOString() };
  if (opts.apply && !positiveSafeInteger(opts.expectedBotId)) {
    result.status = 'blocked'; result.errors.push({ stage: 'identity', reason: 'invalid-bot-id' }); return result;
  }
  // Copy only this transport's configuration; pin the resolved env token before awaits.
  const token = resolveToken(cfg);
  const snapshot: AshlrConfig = { ...cfg, comms: { ...cfg.comms, telegram: { ...cfg.comms?.telegram, botToken: token } } };
  if (!telegramEnabled(snapshot)) {
    result.status = 'blocked'; result.errors.push({ stage: 'configuration', reason: 'not-configured' }); return result;
  }
  const before = await observeTelegramBrand(snapshot, opts.apply ? opts.expectedBotId : undefined);
  result.botId = before.botId; result.username = before.username; result.errors.push(...before.errors);
  for (const field of BRAND_FIELDS) {
    const observed = before.values[field.key];
    if (observed !== undefined) result.fields[field.key].state = observed === TELEGRAM_PHANTOM_BRAND[field.key] ? 'unchanged' : 'different';
  }
  if (before.errors.length) {
    if (before.errors.some((error) => error.reason === 'bot-mismatch')) result.status = 'blocked';
    result.checkedAt = new Date().toISOString(); return result;
  }
  if (!opts.apply) { result.status = 'preview'; result.checkedAt = new Date().toISOString(); return result; }
  let attempted = false;
  for (const field of BRAND_FIELDS) {
    if (result.fields[field.key].state === 'unchanged') continue;
    attempted = true;
    const raw = await callApi(snapshot, field.setter, { [field.parameter]: TELEGRAM_PHANTOM_BRAND[field.key], language_code: '' });
    const response = brandObject(raw);
    if (response?.['ok'] !== true || response['result'] !== true) {
      result.fields[field.key].state = 'failed'; result.errors.push(brandFailure(raw, field.key)); break;
    }
    result.fields[field.key].state = 'unconfirmed';
  }
  const after = await observeTelegramBrand(snapshot, before.botId!);
  result.errors.push(...after.errors);
  const identityMatches = after.botId === before.botId && !after.errors.some((error) => error.stage === 'identity');
  for (const field of BRAND_FIELDS) {
    const observed = identityMatches ? after.values[field.key] : undefined;
    if (observed === TELEGRAM_PHANTOM_BRAND[field.key]) result.fields[field.key].state = 'verified';
    else if (observed === undefined || result.fields[field.key].state === 'unchanged' || result.fields[field.key].state === 'unconfirmed') {
      result.fields[field.key].state = 'unconfirmed';
    } else if (result.fields[field.key].state === 'different') result.fields[field.key].state = 'not-attempted';
    if (observed !== undefined && observed !== TELEGRAM_PHANTOM_BRAND[field.key]) result.errors.push({ stage: field.key, reason: 'readback-different' });
  }
  result.status = BRAND_FIELDS.every((field) => result.fields[field.key].state === 'verified') ? 'verified' : attempted ? 'partial' : 'unknown';
  result.checkedAt = new Date().toISOString(); return result;
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
        res.on('error', () => resolve(null));
        // A server error is ambiguous even if its body resembles an ordinary
        // markup rejection. Drain it without authorizing another send.
        if ((res.statusCode ?? 0) >= 500) {
          res.resume();
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            resolve(null);
          }
        });
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

const CALLBACK_DATA_MAX_BYTES = 64;

function isPublicHttpUrl(target: string): boolean {
  try {
    const u = new URL(target);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    // Telegram rejects the WHOLE send for a URL button it cannot open.
    return !(h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h.startsWith('127.') || h === '[::1]');
  } catch {
    return false;
  }
}

function callbackDataOk(data: string): boolean {
  const bytes = Buffer.byteLength(data, 'utf8');
  return bytes > 0 && bytes <= CALLBACK_DATA_MAX_BYTES;
}

/** Build the inline keyboard for a send (null = no keyboard). */
function buildKeyboard(opts: TelegramSendOpts | undefined): Record<string, string>[][] | null {
  if (opts?.keyboard && opts.keyboard.length > 0) {
    const rows = opts.keyboard
      .map((row) =>
        row
          .filter((b) => ('url' in b ? isPublicHttpUrl(b.url) : callbackDataOk(b.data)))
          .map((b): Record<string, string> => ('url' in b ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data })),
      )
      .filter((row) => row.length > 0);
    return rows.length > 0 ? rows : null;
  }
  if (opts?.buttons && opts.buttons.length > 0) {
    const reqId = opts.requestId ?? 'unknown';
    const rows: Record<string, string>[][] = [];
    opts.buttons.forEach((label, idx) => {
      const pipe = label.indexOf('|');
      if (pipe < 0) {
        rows.push([{ text: label, callback_data: `${reqId}:${idx}` }]);
        return;
      }
      const text = label.slice(0, pipe);
      const target = label.slice(pipe + 1);
      if (/^https?:\/\//i.test(target)) {
        if (isPublicHttpUrl(target)) rows.push([{ text, url: target }]);
        return; // a local URL cannot be opened from a phone — drop the button
      }
      if (callbackDataOk(target)) rows.push([{ text, callback_data: target }]);
    });
    return rows.length > 0 ? rows : null;
  }
  return null;
}

interface ParsedSendResponse {
  ok: boolean;
  messageId?: number;
  description?: string;
  errorCode?: number;
  retryAfterSeconds?: number;
  /** Only an actual negative Bot API response may authorize a short retry. */
  providerThrottle?: boolean;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function parseSendResponse(resp: unknown): ParsedSendResponse {
  if (!resp || typeof resp !== 'object' || Array.isArray(resp)) return { ok: false };
  const r = resp as Record<string, unknown>;
  if (r['ok'] === true) {
    const result = r['result'] as Record<string, unknown> | undefined;
    return { ok: true, messageId: typeof result?.['message_id'] === 'number' ? (result['message_id'] as number) : undefined };
  }
  // Missing/malformed acknowledgements are ambiguous, never permission to repeat.
  if (r['ok'] !== false) return { ok: false };
  const errorCode = positiveSafeInteger(r['error_code']) ? r['error_code'] : undefined;
  const parameters = r['parameters'];
  const retry = parameters && typeof parameters === 'object' && !Array.isArray(parameters)
    ? (parameters as Record<string, unknown>)['retry_after'] : undefined;
  const retryAfterSeconds = positiveSafeInteger(retry) ? retry : undefined;
  return {
    ok: false,
    ...(errorCode === 400 && typeof r['description'] === 'string' ? { description: r['description'] } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    ...(errorCode === 429 && retryAfterSeconds !== undefined ? { providerThrottle: true } : {}),
  };
}

const TELEGRAM_SEND_GAP_MS = 3_000;
const TELEGRAM_SHORT_RETRY_MS = 3_000;
const TELEGRAM_IDLE_LANE_MS = 60_000;
interface TelegramSendClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}
const defaultSendClock: TelegramSendClock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
let sendClock = defaultSendClock;
let lastClockAt = 0;
let nextPruneAt = 0;
interface SendLane {
  tail: Promise<void>;
  queued: number;
  lastAttemptAt?: number;
  throttleUntil: number;
  retryAfterSeconds?: number;
  touchedAt: number;
}
const sendLanes = new Map<string, SendLane>();

/** Explicit clock seam: fake transports still take the same pacing/retry path. */
export function setTelegramSendClockForTests(clock: TelegramSendClock | null): void {
  sendClock = clock ?? defaultSendClock;
  lastClockAt = 0;
  nextPruneAt = 0;
  sendLanes.clear();
}

function sendNow(): number {
  const now = sendClock.now();
  if (!Number.isFinite(now) || now < 0) throw new Error('invalid Telegram send clock');
  // Production uses a monotonic clock. Rollback in an injected clock cannot admit early.
  lastClockAt = Math.max(lastClockAt, now);
  return lastClockAt;
}

function getSendLane(cfg: AshlrConfig): SendLane {
  const now = sendNow();
  if (now >= nextPruneAt) {
    nextPruneAt = now + TELEGRAM_IDLE_LANE_MS;
    for (const [key, lane] of sendLanes) {
      // Never discard an in-flight lane or an outstanding provider floor. This
      // bounded-frequency idle pruning is not an account cap/durable cooldown.
      if (lane.queued === 0 && now >= lane.throttleUntil && now - lane.touchedAt >= TELEGRAM_IDLE_LANE_MS) sendLanes.delete(key);
    }
  }
  const key = createHash('sha256').update(JSON.stringify([resolveToken(cfg), resolveChatId(cfg)])).digest('hex');
  let lane = sendLanes.get(key);
  if (!lane) {
    lane = { tail: Promise.resolve(), queued: 0, throttleUntil: 0, touchedAt: now };
    sendLanes.set(key, lane);
  }
  return lane;
}

function heldThrottle(lane: SendLane, now: number): ParsedSendResponse {
  const remaining = Number.isFinite(lane.throttleUntil) ? Math.ceil((lane.throttleUntil - now) / 1_000) : lane.retryAfterSeconds;
  return { ok: false, errorCode: 429, ...(positiveSafeInteger(remaining) ? { retryAfterSeconds: remaining } : {}) };
}

async function pacedSend(cfg: AshlrConfig, body: Record<string, unknown>, shortRetry = false): Promise<ParsedSendResponse> {
  const lane = getSendLane(cfg);
  const prior = lane.tail;
  let release!: () => void;
  lane.tail = new Promise<void>((resolve) => { release = resolve; });
  lane.queued++;
  try {
    await prior;
    while (true) {
      const now = sendNow();
      const throttleWait = lane.throttleUntil - now;
      // Long 429 never sleeps in bot intake. A local refusal is NOT a new Bot API
      // rejection and cannot authorize an automatic retry by another caller.
      if (throttleWait > 0 && (!shortRetry || throttleWait > TELEGRAM_SHORT_RETRY_MS)) return heldThrottle(lane, now);
      const gapWait = lane.lastAttemptAt === undefined ? 0 : lane.lastAttemptAt + TELEGRAM_SEND_GAP_MS - now;
      const wait = Math.max(0, throttleWait, gapWait);
      if (wait === 0) break;
      await sendClock.sleep(wait);
    }
    lane.lastAttemptAt = sendNow();
    const response = parseSendResponse(await callApi(cfg, 'sendMessage', body));
    if (response.providerThrottle && response.retryAfterSeconds !== undefined) {
      const delay = response.retryAfterSeconds * 1_000;
      const now = sendNow();
      // An unrepresentably large valid floor remains held; overflow must never
      // turn a throttled lane into permission to contact Telegram.
      lane.throttleUntil = Number.isSafeInteger(delay) && Number.isSafeInteger(Math.ceil(now + delay)) ? now + delay : Infinity;
      lane.retryAfterSeconds = response.retryAfterSeconds;
    }
    return response;
  } finally {
    lane.queued--;
    lane.touchedAt = lastClockAt;
    release();
  }
}

function sendErrorMetadata(response: ParsedSendResponse): Pick<TelegramSendResult, 'errorCode' | 'retryAfterSeconds'> {
  return {
    ...(response.errorCode !== undefined ? { errorCode: response.errorCode } : {}),
    ...(response.retryAfterSeconds !== undefined ? { retryAfterSeconds: response.retryAfterSeconds } : {}),
  };
}

/**
 * Send a Telegram message to cfg.comms.telegram.chatId.
 *
 * Text is escaped for parse_mode=HTML unless opts.html is set, and split into
 * ≤4096-char chunks (buttons ride on the last chunk; replyToMessageId applies
 * to the first). When opts.buttons is set, each button becomes a row in an
 * inline_keyboard with callback_data = "<requestId>:<0-based-index>".
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
  // Match lane identity to the request URL/body across pacing awaits, including
  // an environment-derived token. This snapshot is not an authority assertion.
  const sendCfg: AshlrConfig = {
    ...cfg,
    comms: { ...cfg.comms!, telegram: { ...cfg.comms?.telegram, botToken: token, chatId } },
  };

  try {
    const chunks = splitTelegramText(String(text ?? ''), { html: opts?.html === true }).filter((c) => c.length > 0);
    if (chunks.length === 0) return { ok: false };
    const keyboard = buildKeyboard(opts);
    const messageIds: number[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text: chunk,
        parse_mode: 'HTML',
      };
      if (i === 0 && typeof opts?.replyToMessageId === 'number' && opts.replyToMessageId > 0) {
        // allow_sending_without_reply: a deleted original must not fail the send.
        body['reply_parameters'] = { message_id: opts.replyToMessageId, allow_sending_without_reply: true };
      }
      if (i === chunks.length - 1 && keyboard) {
        body['reply_markup'] = { inline_keyboard: keyboard };
      }

      let rateRetryUsed = false;
      const attempt = async (payload: Record<string, unknown>): Promise<ParsedSendResponse> => {
        let response = await pacedSend(sendCfg, payload);
        if (!rateRetryUsed && response.providerThrottle && response.retryAfterSeconds !== undefined && response.retryAfterSeconds * 1_000 <= TELEGRAM_SHORT_RETRY_MS) {
          rateRetryUsed = true;
          response = await pacedSend(sendCfg, payload, true);
        }
        return response;
      };
      let res = await attempt(body);
      if (!res.ok && res.errorCode === 400 && res.description && /pars|entit/i.test(res.description)) {
        // Explicit markup rejection: one plain fallback. Ambiguous responses,
        // 429 and 5xx cannot enter this path or repeat a possibly accepted send.
        const plain: Record<string, unknown> = { ...body, text: telegramHtmlToPlain(chunk) };
        delete plain['parse_mode'];
        res = await attempt(plain);
      }
      if (!res.ok) {
        // First chunk failed → nothing landed. A later chunk failing still
        // counts as delivered (re-sending would duplicate what Mason has).
        return messageIds.length === 0 && i === 0
          ? { ok: false, ...sendErrorMetadata(res) }
          : { ok: true, messageId: messageIds[0], messageIds, partial: true, ...sendErrorMetadata(res) };
      }
      if (typeof res.messageId === 'number') messageIds.push(res.messageId);
    }

    return { ok: true, messageId: messageIds[0], messageIds };
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

    const resp = await callApi(cfg, 'getUpdates', body);

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
          const messageId = typeof msg['message_id'] === 'number' ? (msg['message_id'] as number) : undefined;
          const replied = msg['reply_to_message'] as Record<string, unknown> | undefined;
          const replyToMessageId =
            replied && typeof replied['message_id'] === 'number' ? (replied['message_id'] as number) : undefined;
          events.push({
            kind: 'text',
            text,
            fromChatId,
            ...(messageId !== undefined ? { messageId } : {}),
            ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
          });
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
        const cbMsg = cbq['message'] as Record<string, unknown> | undefined;
        const tappedMessageId = typeof cbMsg?.['message_id'] === 'number' ? (cbMsg['message_id'] as number) : undefined;
        if (ROUTED_CALLBACK_PREFIXES.some((p) => data.startsWith(p))) {
          events.push({
            kind: 'callback',
            data,
            fromChatId,
            callbackQueryId,
            ...(tappedMessageId !== undefined ? { messageId: tappedMessageId } : {}),
          });
          continue;
        }
        // Parse callback_data = "<requestId>:<optionIndex>"
        const colonIdx = data.lastIndexOf(':');
        if (colonIdx < 0) continue; // malformed — skip
        const reqId = data.slice(0, colonIdx);
        const idxRaw = parseInt(data.slice(colonIdx + 1), 10);
        // MED-1: reject non-finite AND negative option indices at parse time.
        if (!isFinite(idxRaw) || idxRaw < 0) continue;

        events.push({
          kind: 'callback',
          requestId: reqId,
          optionIndex: idxRaw,
          fromChatId,
          callbackQueryId,
          ...(tappedMessageId !== undefined ? { messageId: tappedMessageId } : {}),
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
  text?: string,
): Promise<void> {
  if (!telegramEnabled(cfg)) return;
  try {
    const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
    // A toast is plain text (no parse_mode) and capped at 200 chars by Telegram.
    if (text) body['text'] = text.slice(0, 200);
    await callApi(cfg, 'answerCallbackQuery', body);
  } catch {
    // best-effort ack — failure is harmless (spinner times out on its own)
  }
}

/** One supported markup edit; unknown/throttled results never trigger replay. */
export async function editTelegramQuestionKeyboard(messageId: number, keyboard: TelegramButton[][], cfg: AshlrConfig): Promise<boolean> {
  if (!telegramEnabled(cfg) || !Number.isSafeInteger(messageId) || messageId <= 0 || keyboard.length > 12 ||
      keyboard.some(row => row.length > 3 || row.some(button => !('data' in button) ||
        !callbackDataOk(button.data) || !button.text || button.text.length > 220))) return false;
  try {
    const result = await callApi(cfg, 'editMessageReplyMarkup', { chat_id: resolveChatId(cfg), message_id: messageId,
      reply_markup: { inline_keyboard: buildKeyboard({ keyboard }) ?? [] } });
    if (!result || typeof result !== 'object') return false;
    const row = result as Record<string, unknown>;
    return row['ok'] === true && (row['result'] === true || typeof row['result'] === 'object' && row['result'] !== null);
  } catch { return false; }
}
