/**
 * routes/verse/sections/ApprovalsSection.tsx — the leash's other end: what the
 * autonomous loop produced while the human was out of it, and the two buttons
 * that decide its fate. Lazy-mounted by VerseApp's rail; takes no props.
 *
 * List + detail are section-local state rather than routed, because the Verse
 * console deliberately has no router (app/VerseConsoleApp.tsx). Selection
 * survives a background refresh; it does not survive a reload, which is
 * correct — a stale approval id is worse than an empty pane.
 *
 * A server without dispatch 404s approve/reject. That is surfaced once, at the
 * top, as a read-only session — the diff, the evidence and the provenance are
 * all still worth reading in that mode, so nothing else is hidden.
 */
import { useState } from 'react';
import { useQuery } from '../../../data/hooks.js';
import { inboxListQuery } from '../../../data/queries.js';
import { ApprovalDetail } from '../approvals/ApprovalDetail.js';
import { ApprovalsList } from '../approvals/ApprovalsList.js';
import { verseBootstrapQuery } from '../verse-queries.js';
import approvals from '../approvals/approvals.module.css';
import styles from './ApprovalsSection.module.css';

export function ApprovalsSection() {
  const bootstrap = useQuery(verseBootstrapQuery);
  const pending = useQuery(inboxListQuery({ status: 'pending', limit: 500 }));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dispatchDenied, setDispatchDenied] = useState(false);

  const dispatchEnabled = (bootstrap.data?.dispatchEnabled ?? true) && !dispatchDenied;
  const pendingCount = pending.data?.pending;

  return (
    <section className={styles.section} aria-label="Approvals">
      <header className={styles.header} data-app-region="drag">
        <h2 className={styles.title}>Approvals</h2>
        <span className={styles.headerMeta}>
          {typeof pendingCount === 'number' ? `${pendingCount} awaiting you` : 'counting…'}
        </span>
      </header>

      {!dispatchEnabled ? (
        <div className={styles.banner} role="status">
          <span className={styles.bannerTitle}>Read-only session</span>
          This server was started without dispatch, so approve and reject are unavailable. Diffs, verification results
          and provenance still read normally — run <code>ashlr verse</code> to decide.
        </div>
      ) : null}

      <div className={`${styles.body} ${approvals.layout}`}>
        <ApprovalsList selectedId={selectedId} onSelect={setSelectedId} />
        <div className={approvals.detailPane}>
          {selectedId ? (
            <ApprovalDetail
              key={selectedId}
              id={selectedId}
              dispatchEnabled={dispatchEnabled}
              onDispatchDisabled={() => setDispatchDenied(true)}
              onDecided={() => setSelectedId(null)}
            />
          ) : (
            <div className={styles.placeholder}>
              Select a proposal to read its diff, its verification result, and where it came from before deciding.
              <p className={styles.placeholderHint}>↑/↓ moves through the queue · pending proposals sort first.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
