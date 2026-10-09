/** Pure local speed evidence. Configuration identity is never proof of runtime readiness. */
import type { VerseEvent } from './types.js';

export interface LocalSpeedBinding { seatId: string; model: string; endpoint: string; contextWindow: number }
export interface LocalTurnThroughput {
  tokPerSec: number; at: string; contextWindow: number | null; durationMs: number;
  inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheCreationTokens: number | null;
}

/** Every recorded delta must be present and valid; absence is not measured zero. */
function sumRecorded(previous: number | null | undefined, value: unknown): number | null {
  if (previous === null || typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  const sum = (previous ?? 0) + value;
  return Number.isSafeInteger(sum) ? sum : null;
}

interface LocalSpeedSeat { id: string; engine: string; contextWindow?: number | null; models: readonly { id: string; contextWindow?: number | null }[] }
export function localSpeedBinding(seat: LocalSpeedSeat, model: string, launch: { ollamaBaseUrl: string; anthropicBaseUrl?: string | null }): LocalSpeedBinding | null {
  // A multi-model saved launch cannot identify which model produced old events.
  if (seat.engine !== 'local' || seat.models.length !== 1 || seat.models[0]?.id !== model) return null;
  const contextWindow = seat.contextWindow ?? seat.models[0].contextWindow;
  if (!Number.isSafeInteger(contextWindow) || !(Number(contextWindow) > 0)) return null;
  try {
    const raw = launch.anthropicBaseUrl?.trim() || launch.ollamaBaseUrl;
    const url = new URL(raw);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
        !(host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host))) return null;
    const pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
    return { seatId: seat.id, model, endpoint: url.origin + pathname, contextWindow: Number(contextWindow) };
  } catch { return null; }
}
export function localSpeedKey(binding: LocalSpeedBinding): string {
  return JSON.stringify([binding.seatId, binding.model, binding.endpoint, binding.contextWindow]);
}

/** Latest successful turn with actual usage and duration; retains its original event time. */
export function completedLocalTurnThroughput(events: readonly VerseEvent[]): LocalTurnThroughput | null {
  const usage = new Map<string, { output: number; recordedOutput: number | null; input: number | null; cacheRead: number | null; cacheCreation: number | null; contextWindow: number | null }>();
  const cancelled = new Set<string>();
  const unknownUsage = new Set<string>();
  for (const event of events) {
    if (event.type === 'cancelled') cancelled.add(event.turnId);
    if (event.type === 'usage') {
      const output = event.usage?.outputTokens;
      if (!Number.isFinite(output) || output < 0) { unknownUsage.add(event.turnId); continue; }
      const previous = usage.get(event.turnId);
      const window = event.usage.contextWindow;
      const contextWindow = Number.isSafeInteger(window) && Number(window) > 0 ? window : null;
      // Persisted usage events are deltas (session-engine.applyUsage), including tool calls.
      usage.set(event.turnId, { output: (previous?.output ?? 0) + output,
        recordedOutput: sumRecorded(previous?.recordedOutput, output),
        input: sumRecorded(previous?.input, event.usage.inputTokens),
        cacheRead: sumRecorded(previous?.cacheRead, event.usage.cacheReadTokens),
        cacheCreation: sumRecorded(previous?.cacheCreation, event.usage.cacheCreationTokens),
        contextWindow: previous && previous.contextWindow !== contextWindow ? null : contextWindow });
    }
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type !== 'turn-done' || !event.ok || cancelled.has(event.turnId) || unknownUsage.has(event.turnId) || !Number.isFinite(event.durationMs) ||
        event.durationMs <= 0 || !Number.isFinite(Date.parse(event.at))) continue;
    const reported = usage.get(event.turnId);
    if (!reported || reported.output <= 0) continue;
    const tokPerSec = reported.output / (event.durationMs / 1000);
    if (Number.isFinite(tokPerSec) && tokPerSec > 0) return { tokPerSec, at: event.at, contextWindow: reported.contextWindow,
      durationMs: event.durationMs, inputTokens: reported.input, outputTokens: reported.recordedOutput,
      cacheReadTokens: reported.cacheRead, cacheCreationTokens: reported.cacheCreation };
  }
  return null;
}
