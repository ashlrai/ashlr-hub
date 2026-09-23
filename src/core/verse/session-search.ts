/**
 * Keyword search over past Verse sessions — zero spend, no index, no model.
 *
 * The corpus is the durable event log the session store already keeps
 * (`<id>.events.jsonl`). Only what the OPERATOR and the AGENT said is searched
 * (`user-message`, `assistant-message`): tool inputs and outputs are huge,
 * noisy and full of file contents that would drown every real hit, and
 * `text-delta` / `thinking` duplicate or pre-empt the final message.
 *
 * MATCHING: every term must occur in ONE message (terms are AND-ed,
 * case-insensitive; a "double-quoted phrase" is one term). A hit is a message,
 * so the snippet shown is the place the operator actually remembers.
 *
 * SCORING (deterministic given `now`):
 *   term score  = Σ over terms of (1 + ln(occurrences)) — repetition helps, with
 *                 diminishing returns, so one message that says "migration" 40
 *                 times does not bury every other
 *   title bonus = +1 when every term also appears in the session title
 *   kind weight = user messages ×1.1 (the operator's own words are what they
 *                 search for), assistant ×1.0
 *   recency     = × (0.35 + 0.65 · 0.5^(ageDays / 14)) — a two-week half-life
 *                 that never drives an old exact match to zero
 *
 * BOUNDS — this runs synchronously on the API thread, so it is bounded twice:
 * the newest ≤ VERSE_SEARCH_MAX_SESSIONS sessions (by updatedAt) and at most
 * VERSE_SEARCH_MAX_SCAN_CHARS of message text in total. Either bound tripping
 * sets `truncated`, so the UI can say "searched the most recent N" instead of
 * implying the whole history was covered. At most VERSE_SEARCH_MAX_HITS_PER_SESSION
 * hits come from one session so a single long chat cannot fill the list.
 *
 * Snippets are whitespace-collapsed, ≤ 240 chars, and `scrubSecrets`'d.
 */

import { scrubSecrets } from '../util/scrub.js';

import { VerseServiceError } from './preferences.js';
import type { VerseEvent, VerseSearchHit, VerseSearchResponse, VerseSession } from './types.js';

export const VERSE_SEARCH_MAX_SESSIONS = 200;
/** ~20 MB of message text (UTF-16 code units, which is what is actually scanned). */
export const VERSE_SEARCH_MAX_SCAN_CHARS = 20 * 1024 * 1024;
export const VERSE_SEARCH_DEFAULT_LIMIT = 20;
export const VERSE_SEARCH_MAX_LIMIT = 50;
export const VERSE_SEARCH_MAX_QUERY_CHARS = 200;
export const VERSE_SEARCH_MAX_TERMS = 8;
export const VERSE_SEARCH_MAX_HITS_PER_SESSION = 3;
export const VERSE_SEARCH_SNIPPET_CHARS = 240;
/** Recency half-life. */
const HALF_LIFE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface VerseSearchInput {
  sessions: VerseSession[];
  readEvents: (id: string) => VerseEvent[];
  query: string;
  limit?: number;
  /** Injectable clock for the recency weight (tests). Default: the real clock. */
  now?: () => Date;
}

/**
 * Split a query into lower-cased terms. `"exact phrase"` stays one term;
 * everything else splits on whitespace. Duplicates collapse. Throws
 * VERSE_INVALID for an empty or oversized query.
 */
export function parseSearchQuery(query: string): string[] {
  if (typeof query !== 'string') throw new VerseServiceError('VERSE_INVALID', 'q must be a string');
  const trimmed = query.trim();
  if (trimmed.length === 0) throw new VerseServiceError('VERSE_INVALID', 'q is required');
  if (trimmed.length > VERSE_SEARCH_MAX_QUERY_CHARS) {
    throw new VerseServiceError('VERSE_INVALID', `q must be at most ${VERSE_SEARCH_MAX_QUERY_CHARS} characters`);
  }
  const terms: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(trimmed)) !== null) {
    const raw = (match[1] ?? match[2] ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    // A lone quote character is punctuation, not a term.
    const term = raw.replace(/^"+|"+$/g, '');
    if (term.length === 0 || terms.includes(term)) continue;
    terms.push(term);
  }
  if (terms.length === 0) throw new VerseServiceError('VERSE_INVALID', 'q has no searchable terms');
  if (terms.length > VERSE_SEARCH_MAX_TERMS) {
    throw new VerseServiceError('VERSE_INVALID', `q may contain at most ${VERSE_SEARCH_MAX_TERMS} terms`);
  }
  return terms;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return VERSE_SEARCH_DEFAULT_LIMIT;
  return Math.min(VERSE_SEARCH_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/**
 * ≤ VERSE_SEARCH_SNIPPET_CHARS of whitespace-collapsed, secret-scrubbed text
 * around the first match. Scrubbed BEFORE windowing so a redaction can never
 * push the snippet over its cap or leave half a token at a window edge.
 */
export function buildSnippet(text: string, firstTerm: string): string {
  const collapsed = scrubSecrets(text.replace(/\s+/g, ' ').trim());
  const max = VERSE_SEARCH_SNIPPET_CHARS;
  if (collapsed.length <= max) return collapsed;
  const ellipsis = '…';
  // Reserve room for an ellipsis at both ends, then place the match about a
  // third of the way in: enough lead-in to read it in context.
  const room = max - 2 * ellipsis.length;
  const at = Math.max(0, collapsed.toLowerCase().indexOf(firstTerm));
  let start = Math.max(0, at - Math.floor(room / 3));
  const end = Math.min(collapsed.length, start + room);
  start = Math.max(0, end - room);
  return `${start > 0 ? ellipsis : ''}${collapsed.slice(start, end)}${end < collapsed.length ? ellipsis : ''}`;
}

function recencyWeight(at: string, nowMs: number): number {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return 0.35;
  const ageDays = Math.max(0, (nowMs - t) / DAY_MS);
  return 0.35 + 0.65 * Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

function sessionRecency(session: VerseSession): number {
  const t = Date.parse(session.updatedAt);
  return Number.isFinite(t) ? t : 0;
}

export function searchSessions(input: VerseSearchInput): VerseSearchResponse {
  const terms = parseSearchQuery(input.query);
  const limit = clampLimit(input.limit);
  const nowMs = (input.now ?? (() => new Date()))().getTime();

  // Newest first; ties broken by id so the scan order is deterministic.
  const ordered = [...input.sessions].sort(
    (a, b) => sessionRecency(b) - sessionRecency(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  let truncated = ordered.length > VERSE_SEARCH_MAX_SESSIONS;
  const candidates = ordered.slice(0, VERSE_SEARCH_MAX_SESSIONS);

  const hits: VerseSearchHit[] = [];
  let scannedSessions = 0;
  let scannedChars = 0;

  for (const session of candidates) {
    if (scannedChars >= VERSE_SEARCH_MAX_SCAN_CHARS) {
      truncated = true;
      break;
    }
    scannedSessions += 1;
    let events: VerseEvent[];
    try {
      events = input.readEvents(session.id);
    } catch {
      continue; // One unreadable log must not fail the whole search.
    }
    const titleLower = session.title.toLowerCase();
    const titleBonus = terms.every((term) => titleLower.includes(term)) ? 1 : 0;
    const sessionHits: VerseSearchHit[] = [];

    for (const event of events) {
      if (event.type !== 'user-message' && event.type !== 'assistant-message') continue;
      const text = typeof event.text === 'string' ? event.text : '';
      if (text.length === 0) continue;
      if (scannedChars >= VERSE_SEARCH_MAX_SCAN_CHARS) {
        truncated = true;
        break;
      }
      scannedChars += text.length;
      const lower = text.toLowerCase();
      let termScore = 0;
      let all = true;
      for (const term of terms) {
        const n = countOccurrences(lower, term);
        if (n === 0) { all = false; break; }
        termScore += 1 + Math.log(n);
      }
      if (!all) continue;
      const kind = event.type === 'user-message' ? 'user' : 'assistant';
      const score = (termScore + titleBonus) * (kind === 'user' ? 1.1 : 1) * recencyWeight(event.at, nowMs);
      sessionHits.push({
        sessionId: session.id,
        title: session.title,
        projectPath: session.projectPath,
        engine: session.engine,
        seq: event.seq,
        at: event.at,
        kind,
        snippet: buildSnippet(text, terms[0]),
        score: Math.round(score * 1000) / 1000,
      });
    }

    sessionHits.sort(compareHits);
    hits.push(...sessionHits.slice(0, VERSE_SEARCH_MAX_HITS_PER_SESSION));
  }

  hits.sort(compareHits);
  return {
    query: input.query.trim(),
    hits: hits.slice(0, limit),
    scannedSessions,
    truncated,
  };
}

/** Best first; then newest; then a stable order so equal scores never shuffle. */
function compareHits(a: VerseSearchHit, b: VerseSearchHit): number {
  if (b.score !== a.score) return b.score - a.score;
  const at = Date.parse(b.at) - Date.parse(a.at);
  if (Number.isFinite(at) && at !== 0) return at;
  if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
  return b.seq - a.seq;
}
