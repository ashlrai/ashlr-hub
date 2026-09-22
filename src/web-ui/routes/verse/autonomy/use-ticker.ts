/**
 * routes/verse/autonomy/use-ticker.ts — a shared 1Hz clock for the countdown
 * and the relative ages in the status header — one interval per consumer
 * rather than a bespoke timer inside each panel.
 *
 * It deliberately keeps ticking under `prefers-reduced-motion`: a countdown is
 * information, not decoration. The design language's quiet-motion rule governs
 * transitions and animation, not numbers that have to stay true.
 */
import { useEffect, useState } from 'react';

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
