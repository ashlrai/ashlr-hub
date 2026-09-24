/**
 * routes/verse/chat/chapter-model.ts — the ChapterRail's data: one tick per
 * turn the operator started, plus the moments the conversation changed shape
 * (SPEC-310C §2 "ChapterRail", unit C2).
 *
 * A fifty-turn chat is a long scroll with no landmarks; the outline
 * (TranscriptNav) lists turns but takes the width of the transcript to do
 * it. The rail is the glanceable version: a minimap down the right edge
 * where each ask is a tick — red if its turn failed, amber while it runs —
 * and where the context was compacted, the chat was recovered, or it began
 * as a handoff, a marker says so. Position is by ORDER (turn i of n), not by
 * pixel: the rail answers "where in the conversation", and a turn with a
 * 2,000-line build log should not own half of it.
 *
 * Pure over the transcript's TurnBlocks.
 */
import type { TurnBlock, TurnStatus } from './turn-model.js';
import { turnTitle } from './turn-model.js';

export type ChapterMarkerKind = 'compaction' | 'recovered' | 'handoff';

export interface ChapterTick {
  /** The turn's key — what the transcript jumps to. */
  turnKey: string;
  /** 0-based ordinal among ticks. */
  index: number;
  status: TurnStatus;
  /** The ask, one line, for the hover card. */
  title: string;
  /** 0–1 down the rail. */
  position: number;
  /** Markers that fall inside this turn, in order. */
  markers: ChapterMarkerKind[];
}

export interface ChapterModel {
  ticks: ChapterTick[];
  /** The chat began as a handoff: a marker above the first tick. */
  handoff: boolean;
  counts: { failed: number; running: number; compactions: number; recoveries: number };
}

/** Markers carried by a turn's items. Compaction/recovered items can sit in any turn. */
function markersOf(turn: TurnBlock): ChapterMarkerKind[] {
  const out: ChapterMarkerKind[] = [];
  for (const item of turn.items) {
    if (item.kind === 'compaction') out.push('compaction');
    else if (item.kind === 'recovered') out.push('recovered');
  }
  return out;
}

/**
 * Ticks for turns with an ask. A turn with no prompt (the notes before the
 * first ask, a truncated head) carries no tick of its own; its markers ride
 * on the next tick so a compaction is never dropped from the rail.
 */
export function buildChapters(turns: readonly TurnBlock[], opts: { handoff?: boolean } = {}): ChapterModel {
  const ticks: ChapterTick[] = [];
  let carried: ChapterMarkerKind[] = [];
  const counts = { failed: 0, running: 0, compactions: 0, recoveries: 0 };
  for (const turn of turns) {
    const markers = [...carried, ...markersOf(turn)];
    for (const marker of markersOf(turn)) {
      if (marker === 'compaction') counts.compactions += 1;
      else if (marker === 'recovered') counts.recoveries += 1;
    }
    if (turn.prompt === null) {
      carried = markers;
      continue;
    }
    carried = [];
    if (turn.status === 'error') counts.failed += 1;
    if (turn.status === 'running') counts.running += 1;
    ticks.push({ turnKey: turn.key, index: ticks.length, status: turn.status, title: turnTitle(turn, 120), position: 0, markers });
  }
  // Markers after the last ask (a compaction that closed the log) attach to it.
  if (carried.length > 0 && ticks.length > 0) ticks[ticks.length - 1]!.markers.push(...carried);
  const n = ticks.length;
  for (const tick of ticks) tick.position = n <= 1 ? 0 : tick.index / (n - 1);
  return { ticks, handoff: opts.handoff === true, counts };
}

export const CHAPTER_STATUS_WORD: Readonly<Record<TurnStatus, string>> = {
  running: 'running',
  ok: 'done',
  error: 'failed',
  stopped: 'stopped',
};

export const CHAPTER_MARKER_WORD: Readonly<Record<ChapterMarkerKind, string>> = {
  compaction: 'context compacted',
  recovered: 'recovered',
  handoff: 'continued from another chat',
};

/** The accessible name of one tick: "Turn 4 of 12, failed: Fix the login test (context compacted)". */
export function describeTick(tick: ChapterTick, total: number): string {
  const extra = tick.markers.length > 0 ? ` (${[...new Set(tick.markers)].map((m) => CHAPTER_MARKER_WORD[m]).join(', ')})` : '';
  return `Turn ${tick.index + 1} of ${total}, ${CHAPTER_STATUS_WORD[tick.status]}: ${tick.title}${extra}`;
}

// ---------------------------------------------------------------------------
// Streaming cost: the rail must not re-render per token
// ---------------------------------------------------------------------------

const settledSignatures = new WeakMap<TurnBlock, string>();

function turnSignature(turn: TurnBlock): string {
  const cached = settledSignatures.get(turn);
  if (cached !== undefined) return cached;
  let markers = 0;
  for (const item of turn.items) if (item.kind === 'compaction' || item.kind === 'recovered') markers += 1;
  const sig = `${turn.key}:${turn.status}:${markers}:${turn.prompt === null ? 0 : turn.prompt.length}`;
  // A settled turn's TurnBlock never changes (the segment cache hands back the
  // same object), so its signature is computed once; the live turn's each time.
  if (turn.status !== 'running') settledSignatures.set(turn, sig);
  return sig;
}

/**
 * What the rail draws depends on each turn's key, status, markers and ask —
 * none of which a streamed token changes. The transcript rebuilds its turn
 * list on every token, so it compares this signature (cheap: cached per
 * settled turn) and rebuilds the rail's model only when it moves.
 */
export function chaptersSignature(turns: readonly TurnBlock[], handoff: boolean): string {
  let out = handoff ? 'h' : '-';
  for (const turn of turns) out += `|${turnSignature(turn)}`;
  return out;
}
