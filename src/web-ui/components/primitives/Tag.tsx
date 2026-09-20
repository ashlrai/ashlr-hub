/**
 * components/primitives/Tag.tsx — a small, quiet label: a seat pill, a model
 * name, a repo, a risk class. NOT a status badge (that is StatusBadge, which
 * owns the status-color mapping) and not a button.
 *
 * `engine` tints the leading dot with that provider's identity hue. Identity
 * hues are never used for the text itself (design doc §2) — the tag's label
 * stays in the normal text color so it keeps its contrast in both themes.
 */
import type { ReactNode } from 'react';
import type { VerseEngine } from '../../data/api-types.js';
import styles from './Tag.module.css';

const ENGINE_COLOR: Record<VerseEngine, string> = {
  claude: 'var(--engine-claude)',
  codex: 'var(--engine-codex)',
  grok: 'var(--engine-grok)',
  local: 'var(--engine-local)',
};

export interface TagProps {
  children: ReactNode;
  /** Provider identity: tints the leading dot and the pill's edge. */
  engine?: VerseEngine;
  /** Monospace for ids, paths and model names. */
  mono?: boolean;
  size?: 'sm' | 'md';
  /** Show a leading dot even without an engine. */
  dot?: boolean;
  title?: string;
  className?: string;
}

export function Tag({ children, engine, mono = false, size = 'md', dot = false, title, className }: TagProps) {
  const showDot = dot || engine !== undefined;
  return (
    <span
      className={`${styles.tag} ${styles[size]} ${mono ? styles.mono : ''} ${className ?? ''}`}
      title={title}
      data-engine={engine}
    >
      {showDot ? (
        <span
          className={styles.dot}
          style={engine ? { background: ENGINE_COLOR[engine] } : undefined}
          aria-hidden="true"
        />
      ) : null}
      {children}
    </span>
  );
}

/** The 2px identity marker used on session rows and seat pills. */
export function EngineMarker({ engine, className }: { engine: VerseEngine; className?: string }) {
  return <span className={`${styles.marker} ${className ?? ''}`} style={{ background: ENGINE_COLOR[engine] }} aria-hidden="true" />;
}

export function engineColor(engine: VerseEngine): string {
  return ENGINE_COLOR[engine];
}
