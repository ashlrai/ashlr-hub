/**
 * routes/verse/apps/MonogramTile.tsx — the square letter tile every seat and
 * app row leads with (SPEC-310C §6: engines are a monogram and a 2px tick,
 * never a vendor logo — no brand impersonation, and one visual grammar for
 * the rail, the sidebar, Apps and the capacity strip).
 *
 * Engine-backed tiles take a 12% tint of the engine hue with an ink letter,
 * so the letter's contrast never depends on the hue; neutral tiles (Aider,
 * Goose, …) sit on the surface with a hairline. Decorative: the row's name
 * carries the meaning.
 */
import type { CSSProperties } from 'react';
import type { VerseEngine } from '../../../data/api-types.js';
import { engineColor } from '../../../components/primitives/Tag.js';
import styles from './Apps.module.css';

export function MonogramTile({
  monogram,
  engine,
  size = 'md',
}: {
  monogram: string;
  engine: VerseEngine | null;
  /** md = 32px (Apps rows), sm = 24px (capacity rows). */
  size?: 'sm' | 'md';
}) {
  const style = engine === null ? undefined : ({ '--tile-hue': engineColor(engine) } as CSSProperties);
  return (
    <span
      className={styles.tile}
      data-size={size}
      data-engine={engine ?? undefined}
      style={style}
      aria-hidden="true"
    >
      {monogram.slice(0, 2)}
    </span>
  );
}
