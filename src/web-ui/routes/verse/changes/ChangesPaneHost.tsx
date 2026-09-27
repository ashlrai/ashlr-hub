/**
 * routes/verse/changes/ChangesPaneHost.tsx — what the dock mounts for the
 * Changes pane (⇧⌘D), registered through ./register.ts.
 *
 * Two views under one tab, so replacing the first-party pane loses nothing:
 *
 *   Turns  ChangesPanel — per-turn checkpoints: review, accept/reject per
 *          file or hunk, Undo turn / Redo, Commit…, Open PR….
 *   Git    the existing Review pane (uncommitted / branch diff with line
 *          notes you add to the message), through its slot.
 *
 * A diff request from elsewhere (the branch bar's ± counts, a transcript
 * link — `requests.diff`) is a request for the Git view, so it switches there.
 */
import { useEffect, useRef, useState } from 'react';
import { EmptyState } from '../../../components/primitives/EmptyState.js';
import { Segmented } from '../../../components/primitives/Segmented.js';
import { ChangesPaneBody } from '../panes/builtin/SlotPanes.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { ChangesPanel } from './ChangesPanel.js';
import styles from './ChangesPanel.module.css';

export type ChangesHostView = 'turns' | 'git';

export function ChangesPaneHost(props: PaneProps & { initialView?: ChangesHostView }) {
  const { sessionId, visible, requests, initialView = 'turns' } = props;
  const [view, setView] = useState<ChangesHostView>(initialView);
  const handledNonce = useRef<number | null>(requests?.diff?.nonce ?? null);

  useEffect(() => {
    const req = requests?.diff;
    if (!req || handledNonce.current === req.nonce) return;
    handledNonce.current = req.nonce;
    setView('git');
  }, [requests?.diff]);

  if (!sessionId) {
    return <EmptyState compact title="No chat open" body="Open a chat to review what its agent changed, turn by turn." />;
  }

  return (
    <div className={styles.host}>
      <div className={styles.hostBar}>
        <Segmented<ChangesHostView>
          size="sm"
          aria-label="Changes view"
          value={view}
          onChange={setView}
          options={[
            { value: 'turns', label: 'Turns' },
            { value: 'git', label: 'Git' },
          ]}
        />
      </div>
      <div className={styles.hostBody}>
        {view === 'turns' ? (
          <ChangesPanel key={sessionId} sessionId={sessionId} visible={visible} />
        ) : (
          <ChangesPaneBody {...props} />
        )}
      </div>
    </div>
  );
}
