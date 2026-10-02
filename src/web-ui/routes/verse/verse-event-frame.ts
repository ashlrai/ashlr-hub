/** Browser-safe session SSE vocabulary and arithmetic frame validation. */
import type { VerseEvent, VerseEventType } from '../../data/api-types.js';

/**
 * Every VerseEvent name the stream can carry. EventSource only dispatches
 * NAMED events to listeners registered by name, so a type missing here is
 * silently dropped — the check below turns a new union member into a compile
 * error in this file instead of a meter that never moves.
 */
const EVENT_TYPES = [
  'user-message',
  'turn-started',
  'text-delta',
  'assistant-message',
  'thinking',
  'tool-use',
  'tool-result',
  'usage',
  'turn-done',
  'error',
  'cancelled',
  // V3.9 — a server that predates them simply never sends these names.
  'compaction',
  'context',
  // V3.10 transient (SSE only, never replayed — see VERSE_TRANSIENT_EVENT_TYPES
  // in core/verse/types.ts). They carry the last PERSISTED seq, so a store that
  // dedupes by seq and does not know them yet simply drops them.
  'thinking-delta',
  'thinking-progress',
  'progress',
  'status',
  // V3.10 persisted.
  'recovered',
  'history-truncated',
  // V3.15 persisted (additive): injected / seat-reported sources.
  'source',
  // 3.15 persisted (Devin seats).
  'remote-status',
  'remote-pr',
] as const satisfies readonly VerseEventType[];

type UnlistedEventType = Exclude<VerseEventType, (typeof EVENT_TYPES)[number]>;
// Fails to compile when VerseEventType gains a member EVENT_TYPES does not list.
const EVENT_TYPES_EXHAUSTIVE: [UnlistedEventType] extends [never] ? true : never = true;
void EVENT_TYPES_EXHAUSTIVE;

export const VERSE_EVENT_TYPES: readonly VerseEventType[] = EVENT_TYPES;

const nullableCount = (v: unknown): boolean => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);

/**
 * The two V3.9 frames feed arithmetic (the meter, the compaction count), so a
 * malformed one is dropped here rather than turning the meter into `NaN`.
 * Older event types keep the original seq/type-only check.
 */
function v39FieldsValid(e: Record<string, unknown>): boolean {
  if (e.type === 'context') {
    return typeof e.contextTokens === 'number' && Number.isFinite(e.contextTokens) && e.contextTokens >= 0 &&
      typeof e.exact === 'boolean' && nullableCount(e.contextWindow) &&
      (e.autoCompactAt === undefined || nullableCount(e.autoCompactAt));
  }
  if (e.type === 'compaction') {
    return (e.trigger === 'auto' || e.trigger === 'manual') &&
      nullableCount(e.preTokens) && nullableCount(e.postTokens) && nullableCount(e.durationMs);
  }
  return true;
}

const optionalCount = (v: unknown): boolean => v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0);

/**
 * V3.10 frames that feed arithmetic or a live label (elapsed, tok/s, token
 * estimate) — same rule as v39FieldsValid: malformed → dropped, never NaN.
 */
function v310FieldsValid(e: Record<string, unknown>): boolean {
  switch (e.type) {
    case 'thinking-delta':
      return typeof e.text === 'string';
    case 'thinking-progress':
      return e.estimatedTokens !== undefined && optionalCount(e.estimatedTokens);
    case 'progress':
      return (e.phase === 'thinking' || e.phase === 'tool' || e.phase === 'writing' || e.phase === 'waiting') &&
        typeof e.elapsedMs === 'number' && Number.isFinite(e.elapsedMs) && e.elapsedMs >= 0 &&
        (e.tool === undefined || typeof e.tool === 'string') &&
        optionalCount(e.outTokens) && optionalCount(e.tokPerSec);
    case 'status':
      return (e.kind === 'retry' || e.kind === 'preflight' || e.kind === 'watchdog') && typeof e.message === 'string';
    case 'history-truncated':
      return typeof e.droppedBefore === 'number' && Number.isFinite(e.droppedBefore);
    case 'source': {
      // Kept inline (not core/verse/trace isVerseSource): this file is on the
      // chat's first-paint path and must not pull the trace module in.
      const s = e.source as Record<string, unknown> | null | undefined;
      return !!s && typeof s === 'object' && typeof s.kind === 'string' && typeof s.ref === 'string' && s.ref.length > 0 &&
        typeof s.title === 'string' && typeof s.origin === 'string';
    }
    default:
      return true;
  }
}

/** Exported for tests: one SSE frame's data → a VerseEvent, or null when malformed. */
export function parseVerseEventFrame(raw: string): VerseEvent | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Partial<VerseEvent>;
    if (typeof candidate.seq !== 'number' || typeof candidate.type !== 'string') return null;
    if (!v39FieldsValid(parsed as Record<string, unknown>)) return null;
    if (!v310FieldsValid(parsed as Record<string, unknown>)) return null;
    return parsed as VerseEvent;
  } catch {
    return null;
  }
}

