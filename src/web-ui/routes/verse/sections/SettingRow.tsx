/**
 * routes/verse/sections/SettingRow.tsx — the Settings layout primitive:
 * label + description on the left, control on the right, hairline between.
 *
 * The label is a real <label> bound to the control's id when one is given;
 * for composite controls (a radiogroup, a swatch grid) pass `labelId` and
 * point the group's `aria-labelledby` at it instead — a <label> cannot name
 * a group, and an unnamed radiogroup is announced as "group".
 */
import type { ReactNode } from 'react';
import styles from './SettingsSection.module.css';

export interface PanelProps {
  title: ReactNode;
  /** Right-aligned affordance in the panel header (e.g. "Reset"). */
  action?: ReactNode;
  children: ReactNode;
}

export function Panel({ title, action, children }: PanelProps) {
  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <h3 className={styles.panelTitle}>{title}</h3>
        {action}
      </div>
      <div className={styles.panelBody}>{children}</div>
    </section>
  );
}

export interface SettingRowProps {
  label: ReactNode;
  description?: ReactNode;
  /** id of the control this row labels (renders a real <label for>). */
  htmlFor?: string;
  /** id to put on the label text, for a control using aria-labelledby. */
  labelId?: string;
  /** Put the control under the text instead of beside it (sliders, previews). */
  stacked?: boolean;
  children: ReactNode;
}

export function SettingRow({
  label,
  description,
  htmlFor,
  labelId,
  stacked = false,
  children,
}: SettingRowProps) {
  const text = (
    <>
      <span className={styles.rowLabel} id={labelId}>
        {label}
      </span>
      {description ? <span className={styles.rowDescription}>{description}</span> : null}
    </>
  );

  return (
    <div className={`${styles.row} ${stacked ? styles.rowStacked : ''}`}>
      <div className={styles.rowText}>
        {htmlFor ? (
          <label htmlFor={htmlFor} className={styles.rowText}>
            {text}
          </label>
        ) : (
          text
        )}
      </div>
      <div className={styles.rowControl}>{children}</div>
    </div>
  );
}
