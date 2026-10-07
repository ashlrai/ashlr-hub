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
  'manager-message',
  'manager-result',
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

const count = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const nullableCount = (v: unknown): boolean => v === null || count(v);
const optionalCount = (v: unknown): boolean => v === undefined || count(v);
const stringFields = (record: Record<string, unknown>, keys: readonly string[]): boolean =>
  keys.every(key => typeof record[key] === 'string');

/**
 * Frames that feed arithmetic or a live label share one dispatch: malformed
 * values are dropped, never rendered as NaN. Older event types retain their
 * original seq/type-only check.
 */
function frameFieldsValid(e: Record<string, unknown>): boolean {
  switch (e.type) {
    case 'context':
      return count(e.contextTokens) &&
        typeof e.exact === 'boolean' && nullableCount(e.contextWindow) &&
        (e.autoCompactAt === undefined || nullableCount(e.autoCompactAt));
    case 'compaction':
      return (e.trigger === 'auto' || e.trigger === 'manual') &&
        nullableCount(e.preTokens) && nullableCount(e.postTokens) && nullableCount(e.durationMs);
    case 'manager-message':
    case 'manager-result': {
      // Browser shape checks do not grant authority. The host has already
      // validated the exact registered run tuple and actual text digest.
      const message = e.type === 'manager-message';
      const strings = message ? ['text', 'outcomeId', 'messageId'] : ['text', 'outcomeId', 'runId', 'seatId', 'model', 'engine', 'stageId', 'resultDigest'];
      return e.turnId === null && stringFields(e, strings) && (message || e.attemptId === e.stageId);
    }
    case 'thinking-delta':
      return typeof e.text === 'string';
    case 'thinking-progress':
      return count(e.estimatedTokens);
    case 'progress':
      return (e.phase === 'thinking' || e.phase === 'tool' || e.phase === 'writing' || e.phase === 'waiting') &&
        count(e.elapsedMs) &&
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
      return !!s && typeof s === 'object' && typeof s.ref === 'string' && s.ref.length > 0 &&
        stringFields(s, ['kind', 'title', 'origin']);
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
    if (!frameFieldsValid(parsed as Record<string, unknown>)) return null;
    return parsed as VerseEvent;
  } catch {
    return null;
  }
}
