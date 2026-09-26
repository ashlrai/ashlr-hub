/**
 * routes/verse/context/context-model.ts — the pure half of the context
 * components (handoff dialog, memory panel, session search). No React, no
 * I/O, so every rule the components render is pinned by a plain unit test.
 *
 * Every number shown here comes from context-math.ts (the one module the
 * server and the browser share), so "compacts ≈367k" in the handoff dialog is
 * the same figure the meter and the seat picker show.
 */
import type { VerseEngine, VerseModelOption, VerseSeat, VerseSession } from '../../../data/api-types.js';
import type {
  VerseContextMode,
  VerseFitVerdict,
  VersePreferences,
  VerseSearchHit,
} from '../../../../core/verse/types.js';
import { VERSE_MEMORY_BLOCK_MAX_BYTES, VERSE_MEMORY_BODY_MAX_BYTES } from '../../../../core/verse/types.js';
import {
  budgetFor,
  canonicalModelId,
  estimateTokensFromChars,
  fitVerdict,
  hasExpansiveMode,
  sessionOverheadTokens,
} from '../../../../core/verse/context-math.js';
import { formatContextWindow, formatRelative } from '../verse-model.js';
import { asClause, percentText, tidyProse } from '../autonomy/format.js';
import { formatTokens } from '../verse-store.js';

// ---------------------------------------------------------------------------
// Handoff
// ---------------------------------------------------------------------------

// The canned "Ask this seat to summarize first" turn is
// VERSE_HANDOFF_SUMMARY_REQUEST in core/verse/types.ts, not a copy here: the
// handoff builder on the server matches that exact text to keep it OUT of the
// new session's "latest requests" (otherwise the new chat is told to write
// another handoff note). A local copy that drifted by one character would
// silently defeat that filter.

/** Mirrors session-engine's TITLE_MAX so a title we send is never cut by the server instead. */
export const TITLE_MAX_CHARS = 120;

const PART_SUFFIX = /\s·\spart\s(\d+)$/;

/**
 * Title for the session a handoff continues in: "Fix the login bug · part 2".
 * A continuation of a continuation counts up rather than stacking suffixes, so
 * the sidebar reads "part 3", never "part 2 · part 2".
 */
export function handoffTitle(sourceTitle: string): string {
  const collapsed = sourceTitle.replace(/\s+/g, ' ').trim();
  const match = PART_SUFFIX.exec(collapsed);
  const base = (match ? collapsed.slice(0, match.index) : collapsed) || 'Untitled chat';
  const next = match ? Number.parseInt(match[1]!, 10) + 1 : 2;
  const suffix = ` · part ${next}`;
  const room = TITLE_MAX_CHARS - suffix.length;
  const clipped = base.length > room ? `${base.slice(0, room - 1).trimEnd()}…` : base;
  return `${clipped}${suffix}`;
}

/**
 * A seat's catalog entry for a model id. Exact id first, then canonical — a
 * session created before the alias fix stores `claude-opus-5.5` while the
 * catalog now lists `claude-opus-5-5` (context-math VERSE_MODEL_ID_ALIASES).
 */
export function modelOption(seat: VerseSeat | null | undefined, modelId: string): VerseModelOption | null {
  if (!seat) return null;
  const exact = seat.models.find((m) => m.id === modelId);
  if (exact) return exact;
  const canonical = canonicalModelId(modelId);
  return seat.models.find((m) => canonicalModelId(m.id) === canonical) ?? null;
}

/**
 * Why a seat+model cannot take a new session right now; null when it can.
 *
 * The seat's own reason is embedded as a clause: its closing period is
 * dropped (no "exhausted..") and any ISO instant in it — a health summary
 * saying when usage resets — is read as the viewer's local time.
 */
export function targetUnavailableReason(
  seat: VerseSeat | null | undefined,
  option: VerseModelOption | null,
  now: number = Date.now(),
): string | null {
  if (!seat) return 'Pick a seat to continue on.';
  if (seat.health.state === 'unavailable') {
    return `${seat.label} is unavailable: ${asClause(tidyProse(seat.health.summary ?? 'no reason given', now))}.`;
  }
  if (!option) return 'Pick a model on this seat.';
  if (option.unavailableReason) {
    return `${option.label} cannot run on ${seat.label}: ${asClause(tidyProse(option.unavailableReason, now))}.`;
  }
  return null;
}

export interface HandoffTarget {
  seatId: string;
  model: string;
}

/**
 * Where a handoff lands by default: the SAME seat and model (the common case
 * is "same agent, fresh context"). When that model can no longer run there,
 * the seat's first runnable model; when the seat itself is gone or
 * unavailable, the first runnable model on any available seat, in the seat
 * list's own order.
 */
export function defaultHandoffTarget(seats: readonly VerseSeat[], source: Pick<VerseSession, 'seatId' | 'model'>): HandoffTarget | null {
  const own = seats.find((s) => s.id === source.seatId);
  if (own && own.health.state !== 'unavailable') {
    const same = modelOption(own, source.model);
    if (same && !same.unavailableReason) return { seatId: own.id, model: same.id };
    const runnable = own.models.find((m) => !m.unavailableReason);
    if (runnable) return { seatId: own.id, model: runnable.id };
  }
  for (const seat of seats) {
    if (seat.health.state === 'unavailable') continue;
    const runnable = seat.models.find((m) => !m.unavailableReason);
    if (runnable) return { seatId: seat.id, model: runnable.id };
  }
  return null;
}

/**
 * The mode a handoff starts in. Only a mode that EXISTS for the target model
 * is ever returned (a mode with no budget would be refused by the server).
 *
 *  1. Same seat and model as the source → keep the source's mode. "Continue in
 *     a fresh chat" means the same settings with a clean context; an operator
 *     who chose expansive for this work chose it for the work.
 *  2. Otherwise the target seat's standing preference (preferences.json).
 *  3. Otherwise standard.
 */
export function defaultHandoffMode(input: {
  option: VerseModelOption | null;
  target: HandoffTarget | null;
  source: Pick<VerseSession, 'seatId' | 'model' | 'contextMode'>;
  preferences: VersePreferences | null | undefined;
}): VerseContextMode {
  const { option, target, source, preferences } = input;
  const valid = (mode: VerseContextMode | undefined): mode is VerseContextMode =>
    mode !== undefined && budgetFor(option, mode) !== null;
  const sameModel = target !== null && target.seatId === source.seatId
    && canonicalModelId(target.model) === canonicalModelId(source.model);
  if (sameModel && valid(source.contextMode ?? 'standard')) return source.contextMode ?? 'standard';
  const preferred = target ? preferences?.seats[target.seatId]?.contextMode : undefined;
  if (valid(preferred)) return preferred;
  return 'standard';
}

/**
 * The mode to put on the create request, or undefined to leave it to the
 * server. A mode is sent only when the model has a budget for it — which is
 * exactly the server's acceptance rule — so what the dialog shows is what is
 * created, and an unknown-window model is never refused over a mode it could
 * not have.
 */
export function requestMode(option: VerseModelOption | null, mode: VerseContextMode): VerseContextMode | undefined {
  return budgetFor(option, mode) !== null ? mode : undefined;
}

/** "1M window · compacts ≈367k" for a model in a mode; null when the budget is unknown. */
export function budgetLine(option: VerseModelOption | null, mode: VerseContextMode): string | null {
  const budget = budgetFor(option, mode);
  if (!budget) return null;
  const window = `${formatContextWindow(budget.contextWindow)} window`;
  return budget.autoCompactAt === null ? window : `${window} · compacts ≈${formatTokens(budget.autoCompactAt)}`;
}

export interface HandoffFit {
  verdict: VerseFitVerdict | null;
  /** The handoff text's own estimate (chars / 4). */
  handoffTokens: number;
  /** The target engine's estimated fixed prompt (context-math `sessionOverheadTokens`). */
  overheadTokens: number;
  /** Handoff + that fixed prompt: what the new session holds before its first reply. */
  needTokens: number;
  /** One sentence for the dialog. */
  text: string;
  tone: 'ok' | 'warn' | 'danger' | 'unknown';
}

/**
 * Will the new session START comfortably? The handoff is small by design
 * (≤ 12k chars ≈ 3k tokens), but every fresh session also carries the CLI's
 * fixed prompt — a large share of a 64k local slot — so this is a real
 * question on small windows, and the sentence shows both halves of the sum
 * rather than a bare verdict.
 *
 * The fixed prompt is the TARGET seat's engine estimate (local ≈15k measured,
 * claude ≈25k, …), not one flat figure: a flat 30k called every handoff to a
 * 64k local seat "too big for one context" when the real sum was ~20k. It is
 * still an estimate — no CLI reports its base prompt before the first turn —
 * so the sentence says "estimated" rather than presenting it as a reading.
 * `engine` null (target seat not known yet) falls back to the largest estimate.
 */
export function handoffFit(
  textChars: number,
  option: VerseModelOption | null,
  mode: VerseContextMode,
  engine: VerseEngine | null,
): HandoffFit {
  const handoffTokens = estimateTokensFromChars(textChars);
  const overheadTokens = sessionOverheadTokens(engine);
  const needTokens = handoffTokens + overheadTokens;
  const verdict = fitVerdict(handoffTokens, option, overheadTokens);
  const sum = `~${formatTokens(handoffTokens)} tokens of handoff + an estimated ~${formatTokens(overheadTokens)} of fixed prompt`;
  const standard = budgetFor(option, 'standard');
  const standardCap = standard ? standard.autoCompactAt ?? standard.contextWindow : null;
  const base = { verdict, handoffTokens, overheadTokens, needTokens };
  switch (verdict) {
    case 'fits':
      return { ...base, tone: 'ok', text: `Fits: ${sum} leaves most of the budget before the first compaction.` };
    case 'tight':
      return {
        ...base,
        tone: 'warn',
        text: `Tight: ${sum} is ${percentText((needTokens / (standardCap ?? needTokens)) * 100)} of where this model compacts — the new chat will compact early.`,
      };
    case 'expansive':
      return mode === 'expansive'
        ? { ...base, tone: 'warn', text: `Fits only the expansive budget: ${sum}.` }
        : { ...base, tone: 'danger', text: `Too big for the standard budget (${sum}). Switch to Expansive, or trim the handoff.` };
    case 'split':
      return { ...base, tone: 'danger', text: `Too big for one context on this model (${sum}). Trim the handoff or pick a seat with a larger window.` };
    default:
      return { ...base, verdict: null, tone: 'unknown', text: 'This model’s window is not known, so there is no fit estimate.' };
  }
}

/** True when the target model has a real expansive budget (context-math, re-exported for the dialog). */
export function offersExpansive(option: VerseModelOption | null): boolean {
  return hasExpansiveMode(option);
}

/** A local turn runs on this machine; every other engine spends subscription usage. */
export function turnCostSentence(engine: VerseEngine, seatLabel: string): string {
  return engine === 'local'
    ? `Runs on this machine with ${seatLabel}; it spends no subscription usage.`
    : `Sends one turn to ${seatLabel} and spends from its usage. The automatic preview costs nothing.`;
}

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

/** UTF-8 byte length — the unit the server's caps (64 KB memory content, 64 KB turn) are written in. */
export function utf8Bytes(text: string): number {
  if (encoder) return encoder.encode(text).length;
  // Fallback for an environment with no TextEncoder: count code points by width.
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * The API's default request-body cap: `readBody` in src/core/web/api.ts, which
 * every /api/verse POST uses unless its route passes a larger one (only
 * POST /memory does — see MEMORY_BODY_MAX_BYTES). A write travels as JSON, so what must fit is
 * the ENCODED body — every `\n` and `"` escaped to two bytes — not the text
 * alone; the editors measure it so a refusal happens on screen instead of as
 * "request body too large".
 */
export const API_BODY_MAX_BYTES = 65_536;

/**
 * POST /api/verse/memory's own body cap — mirrors `VERSE_MEMORY_BODY_MAX_BYTES`
 * in src/core/verse/verse-api.ts (a server module the browser cannot import):
 * room for 64 KiB of content in which EVERY byte escapes to two, plus the
 * project path and the JSON around it. The server still holds the CONTENT to
 * VERSE_MEMORY_MAX_BYTES after parsing. Guarding the memory editor with the
 * 64 KiB default instead blocked saves the server accepts — a 60–64 KB
 * MEMORY.md with ordinary line breaks could not be edited from the panel,
 * which is the exact case the server's larger cap exists for.
 */
export const MEMORY_BODY_MAX_BYTES = VERSE_MEMORY_BODY_MAX_BYTES;

/** UTF-8 size of `body` exactly as the client will send it. */
export function jsonBodyBytes(body: unknown): number {
  return utf8Bytes(JSON.stringify(body) ?? '');
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return `${kb < 10 ? kb.toFixed(1).replace(/\.0$/, '') : Math.round(kb)} KB`;
}

/**
 * A relative time that reads as a phrase: "just now", "5m ago", "on Sep 19".
 * `formatRelative` (verse-model) is sized for a 5ch sidebar column and reads
 * as a bare token; prose needs the preposition.
 */
export function relativePhrase(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) return null;
  const short = formatRelative(iso, now);
  if (!short) return null;
  if (short === 'now') return 'just now';
  // Only the relative tokens ("5m", "3h", "2d") take "ago". Anything else is a
  // DATE, whatever the locale prints: "Sep 1" (en-US) but "1 Sept" (en-GB)
  // and "1. Sept." (de) start with a digit — testing for a leading digit
  // printed "Last completed 1 Sept ago." outside the US.
  return /^\d+[mhd]$/.test(short) ? `${short} ago` : `on ${short}`;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * Shapes that are almost certainly credentials. MEMORY.md is sent to every
 * seat's model on every turn, so a pasted key would travel to every provider
 * — the panel warns BEFORE the save rather than trusting the server's scrub
 * to catch it on the way out. Conservative on purpose: a false alarm on prose
 * would teach the operator to ignore the warning.
 */
const SECRET_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'a private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'an Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { label: 'an OpenAI-style API key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { label: 'an xAI API key', re: /\bxai-[A-Za-z0-9]{32,}/ },
  { label: 'a GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/ },
  { label: 'an AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: 'a Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { label: 'a Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'a Stripe secret key', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}/ },
];

/**
 * Mirrors `VERSE_MEMORY_BLOCK_MAX_BYTES` in src/core/verse/project-memory.ts
 * (a node module the browser cannot import): the most memory text a chat's
 * instructions carry, however large MEMORY.md itself is.
 */
export const MEMORY_BLOCK_MAX_BYTES = VERSE_MEMORY_BLOCK_MAX_BYTES;

/**
 * What memory costs, in the one wording the memory panel and the resources
 * panel share. Memory is ON by default and snapshotted into every new chat's
 * system prompt (claude `--append-system-prompt`, codex `developer_instructions`,
 * grok `--rules`), which re-rides every turn, and it asks writable seats to
 * read and update MEMORY.md — tool calls and output. On a paid seat that is
 * real (if small, mostly cached) usage, so "nothing here spends" would be
 * false for exactly the operator deciding whether to leave it on near a limit.
 * Reading and editing the file from the panel is still free.
 */
export const MEMORY_SPEND_NOTE =
  `Reading and editing memory here spends nothing. On a paid seat it is not free to use: each new chat’s system prompt carries a memory block of up to ${MEMORY_BLOCK_MAX_BYTES / 1024} KB, re-sent every turn (cached after the first), and the agent reads and updates MEMORY.md as it works. Local seats spend nothing.`;

/** The first credential shape found, as a phrase ("a GitHub token"), or null. */
export function secretLike(text: string): string | null {
  for (const { label, re } of SECRET_PATTERNS) if (re.test(text)) return label;
  return null;
}

/**
 * The placeholder the server's scrubber (src/core/util/scrub.ts) writes over
 * secret-shaped text in every rule. In a memory view flagged
 * `contentSanitized`, each one stands for a REAL value still in MEMORY.md.
 */
export const REDACTION_MARKER = '[REDACTED]';

/** How many redaction placeholders a text carries. */
export function redactionMarkers(text: string): number {
  return text.split(REDACTION_MARKER).length - 1;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Below this many characters a keyword search over every message is noise, not recall. */
export const SEARCH_MIN_CHARS = 2;
/** Keystrokes inside this window collapse into one request. */
export const SEARCH_DEBOUNCE_MS = 250;
/** Hits asked for per search — enough to fill the sidebar twice over. */
export const SEARCH_LIMIT = 30;

/** Whitespace-separated terms, lowercased and de-duplicated (the server ANDs them). */
export function searchTerms(query: string): string[] {
  const out: string[] = [];
  for (const raw of query.toLowerCase().split(/\s+/)) {
    if (raw && !out.includes(raw)) out.push(raw);
  }
  return out;
}

export interface HighlightSegment {
  text: string;
  match: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Split `text` into plain and matched runs for every term, case-insensitive.
 * Longest terms first so "migrate" wins over "migrat" at the same position.
 */
export function highlightSegments(text: string, terms: readonly string[]): HighlightSegment[] {
  const usable = [...terms].filter((t) => t.length > 0).sort((a, b) => b.length - a.length);
  if (usable.length === 0 || text.length === 0) return text ? [{ text, match: false }] : [];
  const re = new RegExp(usable.map(escapeRegExp).join('|'), 'gi');
  const out: HighlightSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    if (m[0].length === 0) continue;
    if (start > last) out.push({ text: text.slice(last, start), match: false });
    out.push({ text: m[0], match: true });
    last = start + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), match: false });
  return out;
}

export interface SessionSearchGroup {
  sessionId: string;
  title: string;
  projectPath: string;
  engine: VerseEngine;
  /** The best-scoring hit in this session (the server returns hits best-first). */
  top: VerseSearchHit;
  /** Every hit this session contributed to the response. */
  count: number;
  /** Newest hit time, for the row's relative time. */
  latestAt: string;
}

/**
 * One row per session. The server ranks MESSAGES; the sidebar lists CHATS,
 * and five rows for one chat would push every other match off screen. Order
 * is the order each session first appears, i.e. by its best hit.
 */
export function groupSearchHits(hits: readonly VerseSearchHit[]): SessionSearchGroup[] {
  const groups = new Map<string, SessionSearchGroup>();
  for (const hit of hits) {
    const existing = groups.get(hit.sessionId);
    if (!existing) {
      groups.set(hit.sessionId, {
        sessionId: hit.sessionId,
        title: hit.title,
        projectPath: hit.projectPath,
        engine: hit.engine,
        top: hit,
        count: 1,
        latestAt: hit.at,
      });
      continue;
    }
    existing.count += 1;
    if (hit.at > existing.latestAt) existing.latestAt = hit.at;
  }
  return [...groups.values()];
}
