/**
 * routes/verse/mind/SessionInsightChip.tsx — the chat-header chip (SPEC-310C
 * §5 "`mind/SessionInsightChip`: Chat's header shows it when an A7 loop or
 * struggle insight cites that chat"; unit C7). Mounted by C2 through C0's
 * `session-insight-chip` slot, which lazy-loads this file and this named
 * export with exactly SessionInsightChipProps.
 *
 * It renders NOTHING unless the reasoning digest cites this chat in a loop
 * or struggle insight — no placeholder, no spinner, no error text in a chat
 * header (a missing digest is simply no chip). When it shows, it is one
 * quiet chip ("Loop · npm test ×6"); pressing it opens a small panel with
 * the insight(s) and a way to Mind. Reads the digest the Mind surface
 * already caches (60 s freshness); it never polls from the chat.
 */
import { useId, useState, type KeyboardEvent } from 'react';
import { useQuery } from '../../../data/hooks.js';
import { formatRelative } from '../autonomy/format.js';
import { goToSection } from '../command/nav.js';
import { reasoningDigestQuery } from '../command/surface-data.js';
import type { SessionInsightChipProps } from '../shell/slots.js';
import { KIND_LABEL, sessionInsights } from './mind-model.js';
import styles from './mind.module.css';

export function SessionInsightChip({ sessionId }: SessionInsightChipProps) {
  const digest = useQuery(reasoningDigestQuery, { freshMs: 60_000 });
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const insights = sessionInsights(digest.data?.value ?? null, sessionId);
  if (insights.length === 0) return null;
  const first = insights[0]!;
  const label = `${KIND_LABEL[first.kind]} · ${first.count}×`;

  function onKey(e: KeyboardEvent<HTMLElement>): void {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <span className={styles.chipWrap} onKeyDown={onKey}>
      <button
        type="button"
        className={styles.chip}
        data-severity={first.severity}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Reasoning insight for this chat: ${first.title}${insights.length > 1 ? ` and ${insights.length - 1} more` : ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={styles.chipDot} data-severity={first.severity} aria-hidden="true" />
        {label}
        {insights.length > 1 ? <span className={styles.chipMore}>+{insights.length - 1}</span> : null}
      </button>
      {open ? (
        <div id={panelId} className={styles.chipPanel} role="region" aria-label="Insights for this chat">
          <ul className={styles.chipList}>
            {insights.map((i) => (
              <li key={i.id}>
                <span className={styles.insightTitle}>{i.title}</span>
                <span className={styles.insightMeta}>
                  {KIND_LABEL[i.kind]} · {i.count}× · last seen {formatRelative(i.lastAt)}
                </span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className={styles.link}
            onClick={() => {
              setOpen(false);
              goToSection('mind', `insight-${first.id}`);
            }}
          >
            See it in Mind
          </button>
        </div>
      ) : null}
    </span>
  );
}
