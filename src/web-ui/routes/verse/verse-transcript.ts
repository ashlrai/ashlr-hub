/**
 * routes/verse/verse-transcript.ts — what the transcript renders, derived
 * from a session's raw event log (moved out of verse-store.ts).
 *
 * WHY A SEPARATE MODULE: verse-store is on the chat first-paint path (the
 * Chat section opens the selected chat's stream as it mounts), but nothing
 * reads a DERIVED transcript until the workspace or the dock — both lazy
 * chunks — renders one. Keeping the derivation here keeps ~5 KB of it out of
 * the chat first-paint critical JS (SPEC-310A §1, scripts/check-first-paint-
 * budget.mjs). verse-store must never import this module back as a value.
 *
 * `buildTranscript()` derives what the transcript renders from the raw
 * events: streamed `text-delta`s accumulate into a provisional assistant
 * bubble until the matching `assistant-message` arrives and replaces it;
 * `tool-use` and `tool-result` pair up by toolUseId into one card.
 * `getVerseTranscript()` memoizes it per session against the store's event
 * log, rebuilding only the turn segments that changed.
 */
import type { VerseEvent, VerseUsage } from '../../data/api-types.js';
import type { VerseRecoveryHow, VerseThinkingKind } from '../../../core/verse/types.js';
import { getVerseSessionState, getVerseThinkingStats, subscribeVerseStoreLifecycle, type VerseThinkingStat } from './verse-store.js';

// ---------------------------------------------------------------------------
// Per-session memo over the store
// ---------------------------------------------------------------------------

const transcriptMemo = new Map<string, { events: readonly VerseEvent[]; transcript: Transcript; cache: TranscriptCache }>();

// The store tells us when a chat is forgotten or everything is reset
// (logout, tests), exactly when it used to clear this memo itself.
subscribeVerseStoreLifecycle((event) => {
  if (event.kind === 'reset') transcriptMemo.clear();
  else transcriptMemo.delete(event.sessionId);
});

const EMPTY_TRANSCRIPT: Transcript = { items: [], live: false, usage: null, segments: [] };

/**
 * The derived transcript, rebuilt only when the event log changed and then
 * only for the turn segments that changed (see buildTranscript's cache).
 */
export function getVerseTranscript(sessionId: string | null): Transcript {
  if (!sessionId) return EMPTY_TRANSCRIPT;
  const entry = getVerseSessionState(sessionId);
  const memo = transcriptMemo.get(sessionId);
  if (memo && memo.events === entry.events) return memo.transcript;
  const cache = memo?.cache ?? createTranscriptCache();
  const transcript = buildTranscript(entry.events, { cache, thinkingStats: getVerseThinkingStats(sessionId) });
  transcriptMemo.set(sessionId, { events: entry.events, transcript, cache });
  return transcript;
}

// ---------------------------------------------------------------------------
// Transcript derivation
// ---------------------------------------------------------------------------

export type TranscriptItem =
  | { kind: 'user'; key: string; turnId: string; at: string; text: string }
  | { kind: 'assistant'; key: string; turnId: string; at: string; text: string; streaming: boolean }
  | {
      kind: 'thinking';
      key: string;
      turnId: string;
      at: string;
      text: string;
      /** V3.10: the CLI sent a signature-only / redacted block — the model thought, the text is withheld. */
      redacted: boolean;
      /** Streaming wall time: the event's own figure, else what this tab measured; null = unknown. */
      durationMs: number | null;
      /** The CLI's reasoning-token estimate this tab saw while it streamed; null = unknown. */
      estimatedTokens: number | null;
      thinkingKind: VerseThinkingKind | null;
    }
  | {
      kind: 'tool';
      key: string;
      turnId: string;
      at: string;
      toolUseId: string;
      name: string;
      input: unknown;
      result: { output: string; isError: boolean } | null;
      /** tool-use → tool-result wall time; null while pending or unstamped. */
      durationMs: number | null;
    }
  | { kind: 'error'; key: string; turnId: string | null; at: string; message: string; code: string | null }
  | {
      /** V3.9: the CLI compacted its own context. Counts are null when the CLI does not report them (codex). */
      kind: 'compaction';
      key: string;
      turnId: string | null;
      at: string;
      trigger: 'auto' | 'manual';
      preTokens: number | null;
      postTokens: number | null;
      durationMs: number | null;
    }
  | { kind: 'cancelled'; key: string; turnId: string; at: string }
  | { kind: 'turn-done'; key: string; turnId: string; at: string; ok: boolean; durationMs: number }
  /** V3.10: the engine restored a lost native conversation. */
  | { kind: 'recovered'; key: string; turnId: string | null; at: string; how: VerseRecoveryHow; message: string }
  /** V3.10: the log hit its cap and dropped everything before `droppedBefore` (at a turn boundary). */
  | { kind: 'truncated'; key: string; turnId: null; at: string; droppedBefore: number };

/**
 * One turn's worth of items — the log cut at each `user-message`. Unchanged
 * segments come back as the SAME object from a cached build, which is what
 * lets the renderer skip every finished turn while one is streaming.
 */
export interface TranscriptSegment {
  key: string;
  items: TranscriptItem[];
}

export interface Transcript {
  items: TranscriptItem[];
  /** True while a turn is open (started and not yet done/cancelled). */
  live: boolean;
  /** Most recent usage frame seen in the log, if any. */
  usage: VerseUsage | null;
  /** `items`, cut into turn segments. Absent on a hand-built transcript (treated as one segment). */
  segments?: TranscriptSegment[];
}

/** Wall time between two ISO stamps; null when either is unparseable. */
function spanMs(from: string, to: string): number | null {
  const a = Date.parse(from);
  const b = Date.parse(to);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : null;
}

interface PendingText {
  turnId: string;
  at: string;
  text: string;
  key: string;
}

interface SegmentBuild {
  /** Items without the trailing streamed text, which depends on whether the WHOLE log is live. */
  items: TranscriptItem[];
  pending: PendingText | null;
  /** The last live-flag change in this segment: true (started), false (ended) or null (none). */
  liveEffect: boolean | null;
  usage: VerseUsage | null;
  /** tool-results in this segment whose tool-use is not in it. */
  orphanResults: string[];
  toolUseIds: string[];
}

interface CachedSegment {
  firstSeq: number;
  lastSeq: number;
  count: number;
  build: SegmentBuild;
  /** The finished segment per trailing-streaming flag it was finalized with. */
  finalized: { streaming: boolean; segment: TranscriptSegment } | null;
}

export interface TranscriptCache {
  segments: Map<string, CachedSegment>;
}

export function createTranscriptCache(): TranscriptCache {
  return { segments: new Map() };
}

export interface BuildTranscriptOptions {
  /** Reuse segments from a previous build of the same session's log. */
  cache?: TranscriptCache;
  /** Measured figures for reasoning blocks this tab watched stream, by the persisted event's seq. */
  thinkingStats?: ReadonlyMap<number, VerseThinkingStat>;
}

/**
 * The original single-pass derivation over `events[from, to)`. A whole log
 * run through it in one range is exactly the pre-3.10 buildTranscript; cut
 * at `user-message` boundaries (where it flushes anyway) the pieces
 * concatenate to the same items.
 */
function buildSegment(
  events: readonly VerseEvent[],
  from: number,
  to: number,
  stats: ReadonlyMap<number, VerseThinkingStat> | undefined,
): SegmentBuild {
  const items: TranscriptItem[] = [];
  const toolIndex = new Map<string, number>();
  const orphanResults: string[] = [];
  const toolUseIds: string[] = [];
  let pending: PendingText | null = null;
  let liveEffect: boolean | null = null;
  let usage: VerseUsage | null = null;

  const flushPending = () => {
    if (!pending) return;
    items.push({ kind: 'assistant', key: pending.key, turnId: pending.turnId, at: pending.at, text: pending.text, streaming: false });
    pending = null;
  };

  for (let i = from; i < to; i += 1) {
    const e = events[i]!;
    switch (e.type) {
      case 'user-message':
        flushPending();
        items.push({ kind: 'user', key: `u-${e.seq}`, turnId: e.turnId, at: e.at, text: e.text });
        break;
      case 'turn-started':
        liveEffect = true;
        break;
      case 'text-delta':
        if (pending && pending.turnId !== e.turnId) flushPending();
        if (!pending) pending = { turnId: e.turnId, at: e.at, text: '', key: `d-${e.seq}` };
        pending.text += e.text;
        break;
      case 'assistant-message':
        // The complete message supersedes whatever deltas streamed before it.
        pending = null;
        items.push({ kind: 'assistant', key: `a-${e.seq}`, turnId: e.turnId, at: e.at, text: e.text, streaming: false });
        break;
      case 'thinking': {
        flushPending();
        const measured = stats?.get(e.seq);
        items.push({
          kind: 'thinking',
          key: `t-${e.seq}`,
          turnId: e.turnId,
          at: e.at,
          text: e.text,
          redacted: e.redacted === true,
          durationMs: typeof e.durationMs === 'number' && Number.isFinite(e.durationMs) && e.durationMs >= 0
            ? e.durationMs
            : measured?.durationMs ?? null,
          estimatedTokens: measured?.estimatedTokens ?? null,
          thinkingKind: e.kind ?? null,
        });
        break;
      }
      case 'tool-use':
        flushPending();
        toolIndex.set(e.toolUseId, items.length);
        toolUseIds.push(e.toolUseId);
        items.push({
          kind: 'tool',
          key: `tu-${e.seq}`,
          turnId: e.turnId,
          at: e.at,
          toolUseId: e.toolUseId,
          name: e.name,
          input: e.input,
          result: null,
          durationMs: null,
        });
        break;
      case 'tool-result': {
        const idx = toolIndex.get(e.toolUseId);
        const existing = idx === undefined ? undefined : items[idx];
        if (existing && existing.kind === 'tool') {
          items[idx!] = { ...existing, result: { output: e.output, isError: e.isError }, durationMs: spanMs(existing.at, e.at) };
        } else {
          orphanResults.push(e.toolUseId);
          items.push({
            kind: 'tool',
            key: `tr-${e.seq}`,
            turnId: e.turnId,
            at: e.at,
            toolUseId: e.toolUseId,
            name: 'tool',
            input: null,
            result: { output: e.output, isError: e.isError },
            durationMs: null,
          });
        }
        break;
      }
      case 'usage':
        usage = e.usage;
        break;
      case 'compaction':
        // Deliberately NO flushPending: CLIs compact between model calls, and
        // flushing a streamed bubble here would leave it in the list when the
        // complete `assistant-message` arrives — the same reply twice.
        items.push({
          kind: 'compaction',
          key: `k-${e.seq}`,
          turnId: e.turnId,
          at: e.at,
          trigger: e.trigger,
          preTokens: e.preTokens,
          postTokens: e.postTokens,
          durationMs: e.durationMs,
        });
        break;
      case 'error':
        flushPending();
        items.push({ kind: 'error', key: `e-${e.seq}`, turnId: e.turnId, at: e.at, message: e.message, code: typeof e.code === 'string' && e.code ? e.code : null });
        break;
      case 'cancelled':
        flushPending();
        liveEffect = false;
        items.push({ kind: 'cancelled', key: `c-${e.seq}`, turnId: e.turnId, at: e.at });
        break;
      case 'turn-done':
        flushPending();
        liveEffect = false;
        items.push({ kind: 'turn-done', key: `td-${e.seq}`, turnId: e.turnId, at: e.at, ok: e.ok, durationMs: e.durationMs });
        break;
      case 'recovered':
        // Like compaction, no flush: recovery happens before the new native
        // session produces anything, never in the middle of a reply.
        items.push({ kind: 'recovered', key: `r-${e.seq}`, turnId: e.turnId, at: e.at, how: e.how, message: e.message });
        break;
      case 'history-truncated':
        items.push({ kind: 'truncated', key: `h-${e.seq}`, turnId: null, at: e.at, droppedBefore: e.droppedBefore });
        break;
      default:
        break;
    }
  }
  return { items, pending, liveEffect, usage, orphanResults, toolUseIds };
}

function finalizeSegment(key: string, build: SegmentBuild, streaming: boolean): TranscriptSegment {
  const p = build.pending;
  if (!p) return { key, items: build.items };
  return {
    key,
    items: [...build.items, { kind: 'assistant', key: p.key, turnId: p.turnId, at: p.at, text: p.text, streaming }],
  };
}

// `VerseEvent[]` (not readonly) is the published signature: callers type
// their fixture arrays as `Parameters<typeof buildTranscript>[0]` and push.
export function buildTranscript(events: VerseEvent[], options: BuildTranscriptOptions = {}): Transcript {
  const { cache, thinkingStats: stats } = options;
  if (events.length === 0) return { items: [], live: false, usage: null, segments: [] };

  // Cut at every user-message: a new ask always opens a new turn, and the
  // derivation flushes its streamed text there, so nothing spans the cut.
  const starts: number[] = [0];
  for (let i = 1; i < events.length; i += 1) if (events[i]!.type === 'user-message') starts.push(i);

  const builds: Array<{ key: string; build: SegmentBuild; cached: CachedSegment | null }> = [];
  const seenKeys = new Set<string>();
  for (let s = 0; s < starts.length; s += 1) {
    const from = starts[s]!;
    const to = s + 1 < starts.length ? starts[s + 1]! : events.length;
    const firstSeq = events[from]!.seq;
    const lastSeq = events[to - 1]!.seq;
    const count = to - from;
    const key = `s-${firstSeq}`;
    seenKeys.add(key);
    const hit = cache?.segments.get(key);
    if (hit && hit.firstSeq === firstSeq && hit.lastSeq === lastSeq && hit.count === count) {
      builds.push({ key, build: hit.build, cached: hit });
      continue;
    }
    const build = buildSegment(events, from, to, stats);
    const entry: CachedSegment = { firstSeq, lastSeq, count, build, finalized: null };
    cache?.segments.set(key, entry);
    builds.push({ key, build, cached: entry });
  }
  if (cache) for (const key of [...cache.segments.keys()]) if (!seenKeys.has(key)) cache.segments.delete(key);

  // A tool-result whose tool-use sits in an EARLIER segment would have
  // updated that earlier card in the single-pass derivation. It never
  // happens in a real log (a result follows its call inside one turn); if it
  // does, derive the whole log in one pass rather than render it differently.
  if (builds.length > 1) {
    const earlier = new Set<string>();
    for (const b of builds) {
      if (b.build.orphanResults.some((id) => earlier.has(id))) return singlePass(events, stats);
      for (const id of b.build.toolUseIds) earlier.add(id);
    }
  }

  let live = false;
  let usage: VerseUsage | null = null;
  for (const b of builds) {
    if (b.build.liveEffect !== null) live = b.build.liveEffect;
    if (b.build.usage !== null) usage = b.build.usage;
  }

  const segments: TranscriptSegment[] = [];
  const items: TranscriptItem[] = [];
  for (let s = 0; s < builds.length; s += 1) {
    const b = builds[s]!;
    // Deltas still arriving for an open turn render as a streaming bubble;
    // every earlier segment's trailing text was flushed by the next ask.
    const streaming = s === builds.length - 1 ? live : false;
    let segment: TranscriptSegment;
    if (b.cached?.finalized && b.cached.finalized.streaming === streaming) {
      segment = b.cached.finalized.segment;
    } else {
      segment = finalizeSegment(b.key, b.build, streaming);
      if (b.cached) b.cached.finalized = { streaming, segment };
    }
    segments.push(segment);
    for (const item of segment.items) items.push(item);
  }
  return { items, live, usage, segments };
}

function singlePass(events: readonly VerseEvent[], stats: ReadonlyMap<number, VerseThinkingStat> | undefined): Transcript {
  const build = buildSegment(events, 0, events.length, stats);
  const live = build.liveEffect ?? false;
  const segment = finalizeSegment(`s-${events[0]!.seq}`, build, live);
  return { items: segment.items, live, usage: build.usage, segments: [segment] };
}

// ---------------------------------------------------------------------------
// Render-time grouping
// ---------------------------------------------------------------------------

export type ToolGroupMember = Extract<TranscriptItem, { kind: 'tool' | 'thinking' }>;

export interface ToolGroupItem {
  kind: 'toolGroup';
  key: string;
  turnId: string;
  at: string;
  items: ToolGroupMember[];
  /** Tool calls only (thinking blocks are not counted). */
  toolCount: number;
  /** "Read ×6, Edit ×4" — names in first-seen order. */
  summary: string;
  errorCount: number;
  /** A member is still waiting for its result. */
  pending: boolean;
  /** Wall time between the first and last member, when both have parseable timestamps. */
  spanMs: number | null;
}

export type TranscriptRenderItem = TranscriptItem | ToolGroupItem;

/**
 * Fold runs of consecutive tool calls from the same turn that hold two or
 * more calls into one `toolGroup`, so an agentic turn reads as "N tool calls"
 * with a single disclosure instead of a wall of cards. A single call (with
 * whatever reasoning surrounds it) stays as it is.
 * Pure over buildTranscript()'s output (the index-based tool-result pairing
 * there is untouched).
 *
 * Reasoning INTERLEAVED between tool calls folds with them (it explains the
 * next call). Reasoning that ENDS a run — the model's last thought before it
 * answers or before the next ask — is lifted out and rendered on its own, so
 * the part worth reading is never two disclosures deep. A run of reasoning
 * alone never folds.
 */
export function groupTranscriptItems(items: readonly TranscriptItem[]): TranscriptRenderItem[] {
  const out: TranscriptRenderItem[] = [];
  let run: ToolGroupMember[] = [];

  const flush = () => {
    if (run.length === 0) return;
    let end = run.length;
    while (end > 0 && run[end - 1]!.kind === 'thinking') end -= 1;
    const folded = run.slice(0, end);
    const trailing = run.slice(end);
    // Only a run with two or more CALLS is worth a disclosure: "1 tool" hiding
    // a single call plus the reasoning before it is a click for nothing.
    if (folded.filter((m) => m.kind === 'tool').length >= 2) out.push(makeToolGroup(folded));
    else for (const member of folded) out.push(member);
    for (const thought of trailing) out.push(thought);
    run = [];
  };

  for (const item of items) {
    if ((item.kind === 'tool' || item.kind === 'thinking') && (run.length === 0 || run[0]!.turnId === item.turnId)) {
      run.push(item);
      continue;
    }
    flush();
    if (item.kind === 'tool' || item.kind === 'thinking') run.push(item);
    else out.push(item);
  }
  flush();
  return out;
}

function makeToolGroup(members: ToolGroupMember[]): ToolGroupItem {
  const counts = new Map<string, number>();
  let errorCount = 0;
  let pending = false;
  for (const m of members) {
    if (m.kind !== 'tool') continue;
    counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
    if (m.result === null) pending = true;
    else if (m.result.isError) errorCount += 1;
  }
  const toolCount = [...counts.values()].reduce((a, b) => a + b, 0);
  const summary = [...counts.entries()].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ');
  const span = spanMs(members[0]!.at, members[members.length - 1]!.at);
  return {
    kind: 'toolGroup',
    key: `g-${members[0]!.key}`,
    turnId: members[0]!.turnId,
    at: members[0]!.at,
    items: members,
    toolCount,
    summary,
    errorCount,
    pending,
    spanMs: span,
  };
}
