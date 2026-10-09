/**
 * Telegram message formatting — pure helpers shared by the transport
 * (integrations/telegram.ts) and the comms layer.
 *
 * Why this is its own module: every outbound message goes out with
 * parse_mode=HTML, so any `<`, `>` or `&` in model- or user-authored text
 * either renders wrong or makes Telegram reject the whole send ("can't parse
 * entities"). Escaping has to happen exactly once, at the transport edge, and
 * the splitter conservatively bounds the ESCAPED wire length; Telegram's
 * 4096 limit applies after entity parsing. Keeping these pure (no I/O, no config)
 * also lets tests that mock the transport still use the real formatter.
 */

import { formatLeaderDisplayText } from '../vision/leader-display-text.js';

/** Display-only instants on the operator's clock; never alter saved dates or IDs. */
export function telegramInstant(iso: string, nowMs: number = Date.now(), timeZone = 'America/New_York'): string | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/.exec(iso);
  if (!parts) return null;
  const yearValue = Number(parts[1]), month = Number(parts[2]), dayValue = Number(parts[3]);
  const calendar = new Date(0); calendar.setUTCFullYear(yearValue, month - 1, dayValue);
  if (calendar.getUTCFullYear() !== yearValue || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== dayValue) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return null;
  let zone = timeZone;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); }
  catch { zone = 'America/New_York'; }
  const date = new Date(at); const now = new Date(nowMs);
  if (!Number.isFinite(now.getTime())) return null;
  const day = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const time = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(date);
  if (day.format(date) === day.format(now)) return `today ${time}`;
  const year = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric' });
  const label = new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric',
    ...(year.format(date) !== year.format(now) ? { year: 'numeric' } as const : {}) }).format(date);
  return `${label}, ${time}`;
}

/** Generated Leader prose before Telegram escaping; literals and exact IDs stay intact. */
export function leaderDisplayText(text: string, nowMs: number = Date.now(), timeZone = 'America/New_York'): string {
  return formatLeaderDisplayText(text, (iso) => telegramInstant(iso, nowMs, timeZone));
}

// Display-only structured measurements; exact provider values remain in their records.
// Match the shared chart convention without coupling core to the web UI.
const metric = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 2 });
export function telegramMetric(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? metric.format(value) : 'unknown';
}
export function telegramUsd(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value < 0 ? '-' : ''}$${telegramMetric(Math.abs(value))}` : 'unknown';
}
export function telegramPercent(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return 'unknown';
  // Display rounding must not make a not-yet-spent allowance look exhausted.
  return value < 100 && metric.format(value) === '100' ? '<100%' : `${telegramMetric(value)}%`;
}
/** Telegram's hard cap on a single message's text, in characters. */
export const TELEGRAM_MAX_MESSAGE = 4096;

/**
 * Escape text for Telegram's HTML parse mode. Telegram only requires
 * `&`, `<` and `>`; `"` is escaped too so the result is also safe inside an
 * attribute (e.g. an <a href="…">).
 */
export function escapeTelegramHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Strip tags and decode the entities escapeTelegramHtml produces (for plain-text fallbacks). */
export function telegramHtmlToPlain(html: string): string {
  return String(html)
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/**
 * Hard-split one plain line so each piece's ESCAPED length is ≤ max. Never
 * cuts a UTF-16 surrogate pair (emoji) in half.
 */
function hardSplitPlain(line: string, max: number): string[] {
  const out: string[] = [];
  let cur = '';
  let curLen = 0;
  for (const ch of line) {
    // for…of iterates code points, so surrogate pairs stay together.
    const len = escapeTelegramHtml(ch).length;
    if (curLen + len > max && cur) {
      out.push(cur);
      cur = '';
      curLen = 0;
    }
    cur += ch;
    curLen += len;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Greedy line packer: joins lines with '\n' while the measured length stays
 * ≤ max. `measure` returns the on-the-wire length of a line.
 */
function packLines(lines: string[], max: number, measure: (s: string) => number): string[] {
  const chunks: string[] = [];
  let cur: string[] = [];
  let curLen = 0;
  for (const line of lines) {
    const len = measure(line);
    const add = cur.length === 0 ? len : len + 1; // +1 for the joining '\n'
    if (cur.length > 0 && curLen + add > max) {
      chunks.push(cur.join('\n'));
      cur = [];
      curLen = 0;
    }
    cur.push(line);
    curLen += cur.length === 1 ? len : len + 1;
  }
  if (cur.length > 0) chunks.push(cur.join('\n'));
  return chunks;
}

/**
 * Split text into Telegram-sized, wire-ready chunks.
 *
 * - Plain mode (default): the text is escaped here; each returned chunk is
 *   already-escaped HTML ≤ max. Splits prefer line boundaries; an over-long
 *   line is hard-split on code points.
 * - HTML mode (`html: true`): the text is caller-built Telegram HTML. Splits
 *   happen only on line boundaries so a tag pair on one line is never cut; a
 *   single line that is itself too long is degraded to escaped plain text
 *   (tags dropped) rather than risk an unbalanced tag.
 *
 * Always returns at least one chunk; an empty input yields [''] (callers
 * should not send an empty message).
 */
export function splitTelegramText(
  text: string,
  opts: { html?: boolean; max?: number } = {},
): string[] {
  const max = Math.max(16, Math.min(opts.max ?? TELEGRAM_MAX_MESSAGE, TELEGRAM_MAX_MESSAGE));
  const src = String(text ?? '');
  const lines = src.split('\n');

  if (opts.html) {
    const safeLines: string[] = [];
    for (const line of lines) {
      if (line.length <= max) {
        safeLines.push(line);
      } else {
        for (const piece of hardSplitPlain(telegramHtmlToPlain(line), max)) {
          safeLines.push(escapeTelegramHtml(piece));
        }
      }
    }
    return packLines(safeLines, max, (s) => s.length);
  }

  const plainLines: string[] = [];
  for (const line of lines) {
    if (escapeTelegramHtml(line).length <= max) plainLines.push(line);
    else plainLines.push(...hardSplitPlain(line, max));
  }
  return packLines(plainLines, max, (s) => escapeTelegramHtml(s).length).map(escapeTelegramHtml);
}
