/**
 * routes/verse/verse-readouts.ts — display derivations the chat's lazy
 * surfaces (workspace, transcript, context meter, composer, usage panels)
 * read from a session's events and usage.
 *
 * Split from verse-store.ts because the store is on the chat first-paint
 * path and these are not: a value exported from the store rides in its
 * first-paint chunk whoever imports it.
 */
import { formatMetric } from '../../components/charts/format-metric.js';
import type { VerseEvent } from '../../data/api-types.js';

/**
 * When this chat last talked to its provider — the newest `usage`,
 * `turn-done`, `cancelled` or TURN-attributed `context` event — or null when
 * the log holds none (no turn yet, or the log is not loaded).
 *
 * WHY NOT `session.updatedAt`: the idle-cache advice ("the prompt cache has
 * likely expired") asks how long the PROVIDER has gone without a request,
 * and `updatedAt` moves on things that never reach a provider: a rename, a
 * context-mode switch (whose `context` event has `turnId: null`), a reload's
 * record save. Measured from `updatedAt`, one rename silenced the warning
 * for another hour while the cache stayed cold.
 */
export function lastTurnActivityAt(events: readonly VerseEvent[]): string | null {
  let latest: string | null = null;
  for (const e of events) {
    const turnActivity = e.type === 'usage' || e.type === 'turn-done' || e.type === 'cancelled' ||
      (e.type === 'context' && e.turnId !== null);
    if (turnActivity && typeof e.at === 'string' && (latest === null || e.at > latest)) latest = e.at;
  }
  return latest;
}

/**
 * "120k" / "1.2M" — compact token counts for the meter and usage rows.
 *
 * Two significant figures are display-only. Choose the unit AFTER rounding,
 * so counts near a unit boundary read "1k" or "1M", never "1000" or "1000k".
 */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const rounded = Number(Math.round(n).toPrecision(2));
  if (Math.abs(rounded) < 1000) return formatMetric(rounded);
  if (Math.abs(rounded) < 1_000_000) return `${formatMetric(rounded / 1000)}k`;
  return `${formatMetric(rounded / 1_000_000)}M`;
}
