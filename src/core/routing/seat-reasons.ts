/**
 * Seat reasons as data (3.10.1) — the one place a `SeatReason` becomes the
 * sentence the CLI, the logs and pre-3.10.1 readers print.
 *
 * Why this exists: 3.10.0 built each reason as ONE string with its reset
 * baked in ("… is spent — limit reached (resets 2026-09-26T03:46:56.000Z).")
 * and readers joined those strings with "; ". The Fleet surface then showed
 * ".;" joins, raw UTC instants and nested parentheses, and could not say when
 * a seat would be eligible again without parsing prose. Producers now build
 * `{ kind, text, resetsAt | resetDescription }` and derive the legacy
 * sentence here, byte-for-byte what 3.10.0 wrote, so nothing that prints
 * `reasons` changes.
 *
 * BROWSER-SAFE and PURE: type-only imports.
 */
import type { SeatReason } from './types.js';

/**
 * The legacy sentence for one reason: its text with the reset clause put back
 * before the final period — "(resets <ISO>)" for a machine instant,
 * "(resets <provider words>)" for Claude's prose.
 */
export function reasonSentence(reason: SeatReason): string {
  const reset = reason.resetsAt ?? reason.resetDescription ?? null;
  if (!reset) return reason.text;
  const body = reason.text.replace(/\.\s*$/, '');
  return `${body} (resets ${reset}).`;
}

/** Sentences for a reason list (`SeatExclusion.reasons` from `details`). */
export function reasonSentences(reasons: readonly SeatReason[]): string[] {
  return reasons.map(reasonSentence);
}

/**
 * Seat ids for a one-line log sentence: all of them up to four, else the first
 * three and "and N more" — never a bare "…".
 */
export function listSeatIds(ids: readonly string[]): string {
  if (ids.length <= 4) return ids.join(', ');
  return `${ids.slice(0, 3).join(', ')} and ${ids.length - 3} more`;
}

/**
 * Bound and clean `details` for a persisted record (runtime journal, shadow
 * decision log). `clean` is the caller's secret scrubber; kept a parameter so
 * this module stays browser-safe.
 */
export function boundSeatReasons(
  details: readonly SeatReason[] | undefined,
  clean: (text: string) => string,
  max = 6,
): SeatReason[] | undefined {
  if (!Array.isArray(details)) return undefined;
  return details.slice(0, max).map((r) => {
    const out: SeatReason = { kind: r.kind, text: clean(String(r.text)).slice(0, 300) };
    // Absent stays absent (a compact journal line); present-but-null keeps its null.
    if (typeof r.resetsAt === 'string' && Number.isFinite(Date.parse(r.resetsAt))) out.resetsAt = r.resetsAt;
    else if (r.resetsAt !== undefined) out.resetsAt = null;
    if (typeof r.resetDescription === 'string') out.resetDescription = clean(r.resetDescription).slice(0, 160);
    else if (r.resetDescription !== undefined) out.resetDescription = null;
    return out;
  });
}
