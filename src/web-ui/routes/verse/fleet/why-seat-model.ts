/**
 * routes/verse/fleet/why-seat-model.ts — "Why this seat" in words (3.10.1).
 *
 * The card used to print the router's log sentence verbatim — one run-on with
 * every held-back seat's first reason in nested parentheses and a literal
 * "…" — and each HELD BACK entry as `reasons.join('; ')` (hence ".;"), with
 * raw UTC instants and "eligible again: unknown" for seats whose reset was
 * known all along. Now:
 *
 *   - the headline is one short sentence (`SeatDecision.summary`, or the
 *     same words recovered from a 3.10.0 `why`) plus "N seats held back.";
 *   - each held-back seat lists its reasons as prose sentences, without the
 *     reset clauses — those move to "eligible again";
 *   - "eligible again" is derived from the reasons AS DATA: every condition
 *     that must change first ("when you switch autonomy on for this seat")
 *     and the time every time-bound blocker has lifted, in the viewer's zone
 *     ("Fri 11:46 PM") or, for Claude, the provider's own words verbatim.
 *     "unknown" only when nothing says.
 *
 * Records written before 3.10.1 carry only sentences; `parseLegacyReason`
 * recovers the same data from them.
 *
 * Framework-free; tested directly.
 */
import type { SeatDecision, SeatExclusion, SeatReason, SeatReasonKind } from '../../../../core/routing/types.js';
import { describeResetAt } from '../../../../core/verse/seat-readiness.js';
import { asSentence } from '../autonomy/format.js';

const KINDS: ReadonlySet<string> = new Set<SeatReasonKind>([
  'headroom', 'switched-off', 'signed-out', 'unreachable', 'spent', 'reserve', 'session-ceiling',
  'unknown-usage', 'spend-cap', 'model-window', 'context', 'grant', 'lane', 'demoted', 'other',
]);

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

// `asSentence` lives with the other shared prose helpers (autonomy/format.ts);
// re-exported here so this module's callers keep one import.
export { asSentence };

/** Sentences as prose — "A. B." — never "A.; B" and never "A.. B". */
export function joinSentences(texts: readonly string[]): string {
  return texts.map(asSentence).filter(Boolean).join(' ');
}

/** "a", "a and b", "a, b and c". */
function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Reasons as data
// ---------------------------------------------------------------------------

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const ISO_IN_TEXT = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?(?![\w:])/g;

/**
 * Server prose with every ISO instant in it shown in the viewer's zone ("the
 * earliest known reopening is Fri 2:25 PM") — for sentences the server keeps
 * machine-exact for its logs, like a park hold's reason.
 */
export function localTimes(text: string, now: number = Date.now()): string {
  return text.replace(ISO_IN_TEXT, (iso) => describeResetAt(iso, now) ?? iso);
}

function isInstant(text: string | null | undefined): text is string {
  return typeof text === 'string' && ISO_INSTANT.test(text) && Number.isFinite(Date.parse(text));
}

function legacyKind(text: string): SeatReasonKind {
  if (/^autonomy is switched off/i.test(text)) return 'switched-off';
  if (/^signed out/i.test(text)) return 'signed-out';
  if (/not reachable/i.test(text)) return 'unreachable';
  if (/limits that model only/.test(text)) return 'model-window';
  if (/ is spent — /.test(text)) return 'spent';
  if (/is kept for you, so autonomy stops at/.test(text)) return 'reserve';
  if (/used; autonomy stops at .* to protect your live session/.test(text)) return 'session-ceiling';
  if (/unknown usage is not headroom|too stale to spend against|too uncertain to spend against/.test(text)) return 'unknown-usage';
  if (/daily cap/.test(text)) return 'spend-cap';
  if (/tokens of context/.test(text)) return 'context';
  if (/is demoted/.test(text)) return 'demoted';
  if (/\bgrant\b/i.test(text)) return 'grant';
  // A lane cap, as 3.10.0's router wrote it into exclusions: "Codex lanes
  // stay off until…", "The Leader set 0 grok-cli lanes.", "The local runtime
  // serves 0 slot(s).", "…the Claude producer slice is held for your own
  // session." (3.10.1 sends these as `kind: 'lane'`.)
  // The plain-words router says "Codex stays off until the Leader…".
  if (/\blanes?\b|\bslots?\b|producer slice is held|stays off until the Leader/i.test(text)) return 'lane';
  return 'other';
}

// ---------------------------------------------------------------------------
// Lane cap reasons in operator words
// ---------------------------------------------------------------------------

const LEGACY_LANE_LABEL: Readonly<Record<string, string>> = { 'grok-cli': 'Grok', 'claude-cli': 'Claude', codex: 'Codex' };

/**
 * The exact sentence shapes the pre-plain-words router (≤ 3.11) wrote with a
 * lane id where the lane's name belongs. Only these are rewritten: a lane id
 * elsewhere is left alone ("grok-cli is not in foundry.allowedBackends." names
 * the config value to change, and a seat id like `codex-cmp` is never a lane).
 */
const LEGACY_LANE_SHAPES: readonly RegExp[] = [
  /^(The Leader set \d+ )(grok-cli)( lanes?\.)$/,
  /^(No )(grok-cli|claude-cli|codex)( seat has the producer role in the grant\.)$/,
  /^(The grant's current (?:rollout )?stage does not include )(grok-cli|claude-cli|codex)(\.)$/,
  /^(The )(grok-cli|claude-cli|codex)( lane has no slots this tick\.)$/,
  /^(No )(grok-cli|claude-cli|codex)( engine is installed and allowed in this build\.)$/,
  /^(No )(grok-cli|claude-cli|codex)( seat is known, so no usage can be checked\.)$/,
];

/**
 * A lane cap reason (the router's `capReason`, also a held-back seat's lane
 * reason) as the operator reads it. The server writes these in plain words at
 * the source (dispatch-router.ts `planLanes`, tick-hooks-live.ts), and they
 * pass through trimmed.
 *
 * OLDER WORDING STILL ARRIVES: the daemon runs its own compiled build until it
 * restarts, and the fleet runtime journal keeps each run's seat decision with
 * the words of the router that made it. Those older sentences ("2 slot(s)",
 * "(a class-B action)", "grok-cli") are rewritten into the same plain words;
 * every rule matches only the old wording, so a current sentence is unchanged.
 */
export function laneReasonText(reason: string): string {
  let text = reason.trim();
  text = text.replace(
    /^Codex lanes stay off until the Leader enables them after the usage reset \(a class-B action\)\.$/,
    'Codex stays off until the Leader turns it on after the usage reset (you can veto it).',
  );
  // "2 slot(s)" → "2 slots"; "1 local slot(s)" → "1 local slot".
  text = text.replace(/\b(\d+)((?:\s+[A-Za-z-]+)*?)\s+([A-Za-z]+)\(s\)/g,
    (_m, n: string, mid: string, word: string) => `${n}${mid} ${word}${Number(n) === 1 ? '' : 's'}`);
  for (const shape of LEGACY_LANE_SHAPES) {
    text = text.replace(shape, (_m, head: string, id: string, tail: string) => `${head}${LEGACY_LANE_LABEL[id] ?? id}${tail}`);
  }
  return text;
}

/**
 * A pre-3.10.1 reason sentence, back into data: the " (resets …)" clause the
 * server appended is split off (an instant → `resetsAt`, Claude's prose →
 * `resetDescription`), as is a demotion's "until <instant>".
 */
export function parseLegacyReason(sentence: string): SeatReason {
  const trimmed = sentence.trim();
  const clause = /^([\s\S]*?) \(resets ([\s\S]+)\)\.?$/.exec(trimmed);
  let text = clause ? `${clause[1]}.` : trimmed;
  const reset = clause ? clause[2]!.trim() : null;
  let resetsAt: string | null = isInstant(reset) ? reset : null;
  const demoted = / is demoted until (\S+): /.exec(text);
  if (demoted && isInstant(demoted[1])) {
    resetsAt = demoted[1];
    text = text.replace(` until ${demoted[1]}:`, ':');
  }
  return {
    kind: legacyKind(text),
    text,
    resetsAt,
    resetDescription: reset !== null && !isInstant(reset) ? reset : null,
  };
}

/** An exclusion's reasons as data: its 3.10.1 `details`, or its sentences parsed. */
export function exclusionReasons(x: SeatExclusion): SeatReason[] {
  if (Array.isArray(x.details) && (x.details.length > 0 || x.reasons.length === 0)) {
    // A newer server may add kinds; anything unrecognised reads as `other`.
    return x.details.map((r) => (KINDS.has(r.kind) ? r : { ...r, kind: 'other' as const }));
  }
  return x.reasons.map(parseLegacyReason);
}

/** The reasons a HELD BACK row prints: blockers and notes, never the "N% left" line; lane caps in plain words. */
export function heldBackText(x: SeatExclusion): string {
  return joinSentences(exclusionReasons(x).filter((r) => r.kind !== 'headroom').map((r) => (r.kind === 'lane' ? laneReasonText(r.text) : r.text)));
}

// ---------------------------------------------------------------------------
// Eligible again
// ---------------------------------------------------------------------------

/** What must change before the seat can take this work again. */
export interface EligibleAgain {
  /** Conditions a person or the fleet must meet first, in words. */
  conditions: string[];
  /** The instant every time-bound blocker has lifted (the LATEST reset among them); null when none is known. */
  at: string | null;
  /** Provider reset wording with no instant (Claude), verbatim. */
  prose: string[];
  /** A time-bound blocker whose lift time nobody reported. */
  timeUnknown: boolean;
  /** Set when the seat can never take THIS work (it does not fit). */
  never: string | null;
}

const CONDITION: Partial<Record<SeatReasonKind, string>> = {
  'switched-off': 'you switch autonomy on for this seat',
  'signed-out': 'you reconnect this account',
  unreachable: 'it is reachable again',
  'unknown-usage': 'a fresh usage reading arrives',
  'spend-cap': 'its daily spend cap resets',
  grant: 'the standing grant allows it',
  lane: 'its lane has a free slot',
};

/** Blockers that lift on their own at a time: a window reset, a demotion's end. */
const TIMED: ReadonlySet<SeatReasonKind> = new Set<SeatReasonKind>(['spent', 'reserve', 'session-ceiling', 'demoted']);

/** Claude's wording, without the "resets" some sources lead with. */
function resetWords(text: string): string {
  return text.trim().replace(/^resets\s+/i, '');
}

export function eligibleAgain(x: SeatExclusion): EligibleAgain {
  const conditions: string[] = [];
  const prose: string[] = [];
  let at: string | null = null;
  let timeUnknown = false;
  let never: string | null = null;
  for (const r of exclusionReasons(x)) {
    if (r.kind === 'context') {
      never = 'not for this task — it needs a larger context window than this seat has';
      continue;
    }
    const condition = CONDITION[r.kind];
    if (condition && !conditions.includes(condition)) conditions.push(condition);
    if (!TIMED.has(r.kind)) continue;
    // The seat is free only once EVERY time-bound blocker has lifted.
    if (isInstant(r.resetsAt)) {
      if (at === null || Date.parse(r.resetsAt) > Date.parse(at)) at = r.resetsAt;
    } else if (r.resetDescription) {
      const words = resetWords(r.resetDescription);
      if (!prose.includes(words)) prose.push(words);
    } else {
      timeUnknown = true;
    }
  }
  // The server's own estimate, when the reasons themselves carried no time.
  if (at === null && prose.length === 0 && isInstant(x.nextEligibleAt)) {
    at = x.nextEligibleAt;
    timeUnknown = false;
  }
  return { conditions, at, prose, timeUnknown, never };
}

/**
 * "Fri 11:46 PM"; "when you switch autonomy on for this seat, not before Fri
 * 11:46 PM"; "Sep 25 at 6:59pm (America/New_York)" (Claude's words); and
 * "unknown" only when nothing says.
 */
export function describeEligibleAgain(e: EligibleAgain, now: number = Date.now()): string {
  if (e.never) return e.never;
  const times = [...(e.at ? [describeResetAt(e.at, now) ?? e.at] : []), ...e.prose];
  const time = times.length > 0 ? times.join(' and ') : null;
  const when = e.conditions.length > 0 ? `when ${listWords(e.conditions)}` : null;
  if (when && time) return `${when}, not before ${time}`;
  if (when) return when;
  if (time) return time;
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Headline
// ---------------------------------------------------------------------------

const ROUTED = /^Routed (?:autonomous )?[\w-]+-difficulty \w+ work to (.+?) \(([^()]+)\)(?: with (\d+)% of its (5-hour|weekly) window left for autonomy| (at no cost))?: ([\w-]+) mode prefers (.+?) first for this work(?:; held back [\s\S]*)?\.$/;
const NOTHING = /^(No seat (?:the grant lets produce )?can take [\s\S]*?) \([\s\S]*\)(?:; the earliest known reopening is \S+)?\.$/;

/**
 * The short headline recovered from a 3.10.0 `why` — the same words a 3.10.1
 * router writes as `summary` ("Grok — 94% of its weekly window left; balanced
 * mode prefers Grok for this work."). Anything unrecognised is returned as is.
 */
export function legacySummary(why: string): string {
  const text = why.trim();
  const routed = ROUTED.exec(text);
  if (routed) {
    const [, label, , room, windowWord, free, mode, engine] = routed;
    const lead = room ? ` — ${room}% of its ${windowWord} window left` : free ? ' — free, no usage window' : '';
    return lead ? `${label}${lead}; ${mode} mode prefers ${engine} for this work.` : `${label} — ${mode} mode prefers ${engine} for this work.`;
  }
  const nothing = NOTHING.exec(text);
  if (nothing) return `${nothing[1]}.`;
  return text;
}

/** The card's one-line headline: the choice and why, then how many seats were held back. */
export function decisionSummary(d: SeatDecision): string {
  const lead = asSentence(d.summary ?? legacySummary(d.why));
  const n = d.exclusions.length;
  return n === 0 ? lead : `${lead} ${n === 1 ? '1 seat' : `${n} seats`} held back.`;
}
