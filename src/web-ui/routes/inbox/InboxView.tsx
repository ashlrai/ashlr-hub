/**
 * routes/inbox/InboxView.tsx — proposal review: the human-in-the-loop
 * moment (operator-console brief). Mounted at both `/inbox` (list only) and
 * `/inbox/:id` (list + detail, deep-linkable) so a specific proposal is
 * bookmarkable/shareable, matching the param-route pattern established by
 * `/work/runs/:id` (app/routes.tsx).
 */
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { ProposalList } from './ProposalList.js';
import { ProposalDetail } from './ProposalDetail.js';
import styles from './InboxView.module.css';

export function InboxView() {
  const { id } = useParams<{ id?: string }>();
  const [dispatchDisabled, setDispatchDisabled] = useState(false);

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <h1 className={styles.title}>Inbox</h1>
        <p className={styles.subtitle}>Review proposals, inspect diffs and judge evidence, approve or reject.</p>
      </header>

      {dispatchDisabled ? (
        <div className={styles.dispatchBanner} role="alert">
          This server was started without <code>--allow-dispatch</code>, so approve/reject are read-only right now.
          Restart <code>ashlr serve --allow-dispatch</code> to enable them. Browsing and diff review still work.
        </div>
      ) : null}

      <div className={styles.layout}>
        <div className={styles.listPane}>
          <ProposalList selectedId={id ?? null} onDispatchDisabled={() => setDispatchDisabled(true)} />
        </div>
        <div className={styles.detailPane}>
          {id ? (
            <ProposalDetail id={id} onDispatchDisabled={() => setDispatchDisabled(true)} />
          ) : (
            <div className={styles.emptyDetail}>
              <p>Select a proposal to review its diff and evidence.</p>
              <p className={styles.hint}>↑/↓ to move · Enter to open · Space to select · / to search</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
