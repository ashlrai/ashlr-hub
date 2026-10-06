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

import { describeResetAt } from '../verse/seat-readiness.js';

const LEADER_DISPLAY_ID = String.raw`(?:lm-\d{14}-[a-f0-9]{6}(?::\d{1,2})?|la-\d{14}-[a-f0-9]{6}-\d{1,3}|lt-\d{14}-[a-f0-9]{6}|od-\d{14}-[a-f0-9]{6})`;
// Source-owned action summaries end in an ID, optionally followed by the
// existing advisory label. A filename such as file(id).ts is not that field.
const DISPLAY_ID_PARENS = new RegExp(String.raw`(^|\n)([ \t]*[•-]\s+\[[ABC]\][^\n]*)[ \t]+\(${LEADER_DISPLAY_ID}\)(?= — Jev suggests|\r?$)`, 'gm');
const DISPLAY_ID_LABEL = new RegExp(String.raw`\b((?:Leader\s+)?(?:memo|action|message|directive|question))\s+${LEADER_DISPLAY_ID}(?![\w./-])`, 'gi');
const DISPLAY_ID_OUTCOME = new RegExp(String.raw`\b(Approved|Not approved|Vetoed|Could not veto)\s+${LEADER_DISPLAY_ID}(?![\w./-])`, 'g');
const DISPLAY_ID_ITEM = new RegExp(String.raw`(^|\n)([ \t]*[•-]\s*)(${LEADER_DISPLAY_ID})(?![\w./-])`, 'g');
const DISPLAY_ISO = /(?<![\w./-])\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})(?![\w./-])/g;
const DISPLAY_LITERAL = /(https?:\/\/[^\s]+|```[\s\S]*?```|`[^`\r\n]*`|"[^"\r\n]*")/g;

/**
 * Generated Leader prose only, before HTML escaping. Human labels replace
 * known source-owned ID contexts; identifiers in literal answers, links,
 * filenames and code are not display labels and must stay exact. Callers
 * must not feed the result back into the thread, prompts or callback data.
 */
export function leaderDisplayText(text: string, nowMs: number = Date.now()): string {
  const literalSpans = Array.from(text.matchAll(DISPLAY_LITERAL), (match) => [match.index, match.index + match[0].length] as const);
  // Keep the complete action-line context when its summary contains a quote,
  // filename or URL. Only remove a terminal metadata field outside literals:
  // an action-shaped line inside a code fence is still code, not metadata.
  const withoutActionIds = text.replace(DISPLAY_ID_PARENS, (match, start: string, summary: string, offset: number) => {
    const idStart = offset + start.length + summary.length;
    const idEnd = offset + match.length;
    if (literalSpans.some(([from, to]) => idStart < to && idEnd > from)) return match;
    return `${start}${summary}`;
  });
  return withoutActionIds.split(DISPLAY_LITERAL).map((part, index) => {
    if (index % 2 === 1) return part;
    return part
      .replace(DISPLAY_ID_LABEL, '$1')
      .replace(DISPLAY_ID_OUTCOME, '$1 action')
      .replace(DISPLAY_ID_ITEM, (_match, start: string, bullet: string, id: string) => {
        const label = id.startsWith('la-') ? 'action' : id.startsWith('od-') ? 'directive' : id.startsWith('lt-') ? 'message' : 'memo';
        return `${start}${bullet}${label}`;
      })
      .replace(DISPLAY_ISO, (iso) => describeResetAt(iso, nowMs) ?? iso);
  }).join('');
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
