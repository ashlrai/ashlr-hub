/**
 * routes/verse/changes/ChangesPaneHost.tsx — what the dock mounts for the
 * Changes pane (⇧⌘D), registered through ./register.ts.
 *
 * Two views under one tab, so replacing the first-party pane loses nothing:
 *
 *   Turns  ChangesPanel — per-turn checkpoints: review, accept/reject per
 *          file or hunk, Undo turn / Redo, Commit…, Open PR…, review
 *          comments sent back to the seat, "Re-review with…" another seat.
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
import { useChatPaneData } from '../panes/chat-pane-data.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { ChangesPanel } from './ChangesPanel.js';
import styles from './ChangesPanel.module.css';

export type ChangesHostView = 'turns' | 'git';

export function ChangesPaneHost(props: PaneProps & { initialView?: ChangesHostView }) {
  const { sessionId, session, visible, requests, host, initialView = 'turns' } = props;
  // The dock's seats (DockHost provides them): labels and the "Re-review with…" menu.
  const { seats } = useChatPaneData();
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
          <ChangesPanel
            key={sessionId}
            sessionId={sessionId}
            visible={visible}
            session={session && session.id === sessionId ? session : null}
            seats={seats}
            onOpenSession={(id) => host.openSession(id)}
          />
        ) : (
          <ChangesPaneBody {...props} />
        )}
      </div>
    </div>
  );
}
