/**
 * routes/verse/usage/binding-left.ts — what is left of a seat's binding
 * window. Its own module (not capacity-strip-model.ts) because that model is
 * on the chat first-paint path via the rail ring, and only the lazily loaded
 * resource bar and Command's seat strip need this.
 */
import type { CapacityRow } from './capacity-strip-model.js';

/**
 * What is LEFT of the window that binds a seat right now (0–100), or null when
 * no window has a reading: the binding window when it is measured, else the
 * most-used measured one; a flagged limit is 0. The rail's batteries and
 * Command's seat strip both read this, so the two never disagree on headroom.
 */
export function bindingLeftPercent(row: Pick<CapacityRow, 'windows'>): number | null {
  const measured = row.windows.filter((w) => w.usedPercent !== null || w.limitReached);
  if (measured.length === 0) return null;
  const binding = measured.find((w) => w.binding) ?? measured.reduce((a, b) => ((b.usedPercent ?? 100) > (a.usedPercent ?? 100) ? b : a));
  if (binding.limitReached) return 0;
  return Math.max(0, Math.min(100, 100 - (binding.usedPercent ?? 0)));
}
