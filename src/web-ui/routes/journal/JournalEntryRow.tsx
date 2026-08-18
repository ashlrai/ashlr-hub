/**
 * routes/journal/JournalEntryRow.tsx — one line of the work journal.
 * `<details data-state-key>` per DESIGN.md's scroll/expanded-state-survival
 * pattern (useScrollRestore) so expanding a row to drill in survives a
 * background refresh; `data-focus-key` on the summary so keyboard focus
 * survives the same. The detail body (JournalEntryDetail) only mounts once
 * expanded — see that file's header comment for why.
 */
import { useState } from 'react';
import { StatusBadge } from '../../components/primitives/StatusBadge.js';
import { EpistemicBadge } from '../../components/primitives/Epistemic.js';
import { JournalEntryDetail } from './JournalEntryDetail.js';
import type { JournalEntry } from './journal-model.js';
import styles from './JournalEntryRow.module.css';

const SOURCE_LABEL: Record<JournalEntry['source'], string> = {
  'daemon-tick': 'Daemon',
  merge: 'Merge',
  'agent-action': 'Agent',
  run: 'Run',
  proposal: 'Proposal',
};

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

export function JournalEntryRow({ entry }: { entry: JournalEntry }) {
  const hasDrillIn = Boolean(entry.drillIn);
  // <details> stays UNCONTROLLED on purpose — useScrollRestore
  // (hooks/useScrollRestore.ts) restores expanded/collapsed state by setting
  // the DOM `.open` property directly on `[data-state-key]` elements, which
  // a React-controlled `open` prop would fight on the next render. `expanded`
  // here only gates whether the (expensive: fetches a proposal or polls a
  // run) <JournalEntryDetail/> actually mounts — it does not drive the
  // <details> element itself. The native `toggle` event fires for both user
  // clicks and scroll-restore's programmatic `.open = true`, so this stays
  // in sync either way.
  const [expanded, setExpanded] = useState(false);

  return (
    <details
      className={styles.row}
      data-state-key={`journal-${entry.id}`}
      onToggle={(e) => setExpanded(e.currentTarget.open)}
    >
      <summary className={styles.summary} data-focus-key={`journal-${entry.id}`}>
        <span className={styles.sourceTag} data-source={entry.source}>
          {SOURCE_LABEL[entry.source]}
        </span>
        <span className={styles.when} title={entry.ts}>
          {formatWhen(entry.ts)}
        </span>
        <StatusBadge status={entry.statusLabel} />
        {entry.repo ? <span className={styles.repo}>{entry.repo}</span> : null}
        <span className={styles.title}>{entry.title}</span>
        <EpistemicBadge quality={entry.sourceQuality} />
        {hasDrillIn ? (
          <span className={styles.expandHint} aria-hidden="true">
            why? ▾
          </span>
        ) : null}
      </summary>
      <div className={styles.body}>
        <p className={styles.detailText}>{entry.detail}</p>
        {expanded && entry.drillIn ? <JournalEntryDetail drillIn={entry.drillIn} /> : null}
      </div>
    </details>
  );
}
