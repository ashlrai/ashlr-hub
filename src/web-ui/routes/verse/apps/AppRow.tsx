/**
 * routes/verse/apps/AppRow.tsx — one row, the Ollama-style shape every group
 * shares (SPEC-310C §4): a 32px monogram tile, the name (and version), a
 * one-line description, a health dot WITH a word, and on the right a copy
 * pill, a toggle or an action. At the compact width the right side wraps
 * under the description (container query in Apps.module.css).
 */
import type { ReactNode } from 'react';
import type { VerseEngine } from '../../../data/api-types.js';
import type { HealthTone } from '../health/health-model.js';
import { MonogramTile } from './MonogramTile.js';
import styles from './Apps.module.css';

export function HealthWord({ tone, label }: { tone: HealthTone | 'off'; label: string }) {
  return (
    <span className={styles.health} data-tone={tone}>
      <span className={styles.healthDot} aria-hidden="true" />
      {label}
    </span>
  );
}

export interface AppRowProps {
  /** DOM id prefix; the row's name gets `${id}-name` so controls can reference it. */
  id: string;
  name: string;
  monogram: string;
  engine: VerseEngine | null;
  description: string;
  version?: string | null;
  health: { tone: HealthTone | 'off'; label: string };
  detail?: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
}

export function AppRow({ id, name, monogram, engine, description, version, health, detail, aside, children }: AppRowProps) {
  return (
    <li className={styles.row} data-app={id}>
      <MonogramTile monogram={monogram} engine={engine} />
      <div className={styles.rowMain}>
        <div className={styles.rowHead}>
          <span id={`${id}-name`} className={styles.rowName}>{name}</span>
          {version ? <span className={styles.rowVersion}>{version}</span> : null}
          <HealthWord tone={health.tone} label={health.label} />
        </div>
        <p className={styles.rowDesc}>{description}</p>
        {detail ? <p className={styles.rowDetail}>{detail}</p> : null}
        {children}
      </div>
      {aside ? <div className={styles.rowAside}>{aside}</div> : null}
    </li>
  );
}

/** A labelled group: micro-label title, an optional standing caveat, and a card of rows. */
export function AppGroup({
  id,
  title,
  caveat,
  action,
  children,
  headingRef,
}: {
  id: string;
  title: string;
  caveat?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  headingRef?: React.Ref<HTMLHeadingElement>;
}) {
  const headingId = `apps-group-${id}`;
  return (
    <section className={styles.group} aria-labelledby={headingId} data-group={id}>
      <div className={styles.groupHead}>
        <h3 id={headingId} ref={headingRef} tabIndex={-1} className={styles.groupTitle}>{title}</h3>
        {action}
      </div>
      {caveat ? <p className={styles.caveat}>{caveat}</p> : null}
      <div className={styles.card}>{children}</div>
    </section>
  );
}
