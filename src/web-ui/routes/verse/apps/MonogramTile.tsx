/**
 * routes/verse/apps/MonogramTile.tsx — the square tile every seat and app row
 * leads with. 3.11.1: engine-backed tiles show the provider's own mark
 * (Anthropic Claude, OpenAI, xAI Grok, Ollama — ProviderLogo) so an account is
 * recognisable at a glance; the mark only identifies the provider, the row's
 * text still names the account. Neutral tiles (Aider, Goose, …) keep their
 * letters.
 *
 * Engine-backed tiles take a 12% tint of the engine hue; marks draw in ink
 * (currentColor, Claude in its brand colour) so contrast never depends on the
 * hue. Decorative: the row's name carries the meaning.
 */
import type { CSSProperties } from 'react';
import type { VerseEngine } from '../../../data/api-types.js';
import { engineColor } from '../../../components/primitives/Tag.js';
import { ProviderLogo } from '../../../components/primitives/ProviderLogo.js';
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
      {engine === null ? monogram.slice(0, 2) : <ProviderLogo engine={engine} size={size === 'sm' ? 14 : 18} />}
    </span>
  );
}
