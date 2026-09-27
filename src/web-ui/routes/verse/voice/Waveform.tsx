/**
 * routes/verse/voice/Waveform.tsx — the live mic meter in the dictation pill.
 *
 * Full motion: a scrolling bar waveform of the last ~1.2 s of levels.
 * Reduced motion (OS preference unless Settings says full, or Settings says
 * reduce — the same two triggers as tokens.css): a static level meter, no
 * scrolling and no transitions.
 *
 * Levels arrive at ~20 Hz from `subscribeVoiceLevel`; bars are painted by
 * writing transforms directly, so the meter never re-renders React.
 */
import { useEffect, useRef, useState } from 'react';
import { subscribeVoiceLevel } from './voice-store.js';
import styles from './VoiceInput.module.css';

const BARS = 24;

export function prefersReducedMotion(): boolean {
  try {
    const setting = document.documentElement.getAttribute('data-motion');
    if (setting === 'reduce') return true;
    if (setting === 'full') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function Waveform({ active }: { active: boolean }) {
  const [reduced] = useState(prefersReducedMotion);
  const barsRef = useRef<HTMLSpanElement>(null);
  const meterRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const history = new Array<number>(BARS).fill(0);
    return subscribeVoiceLevel((level) => {
      if (reduced) {
        if (meterRef.current) meterRef.current.style.transform = `scaleX(${Math.max(0.02, level)})`;
        return;
      }
      history.shift();
      history.push(level);
      const bars = barsRef.current?.children;
      if (!bars) return;
      for (let i = 0; i < bars.length; i += 1) {
        const el = bars[i] as HTMLElement;
        el.style.transform = `scaleY(${Math.max(0.08, history[i] ?? 0)})`;
      }
    });
  }, [reduced]);

  if (reduced) {
    return (
      <span className={styles.meter} data-active={active ? 'true' : undefined} aria-hidden="true">
        <span ref={meterRef} className={styles.meterFill} />
      </span>
    );
  }
  return (
    <span ref={barsRef} className={styles.wave} data-active={active ? 'true' : undefined} aria-hidden="true">
      {Array.from({ length: BARS }, (_, i) => (
        <span key={i} className={styles.waveBar} />
      ))}
    </span>
  );
}
