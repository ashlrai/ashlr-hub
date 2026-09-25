/**
 * routes/verse/dock/ContextPane.tsx — everything about THIS chat's context,
 * in the dock (SPEC-310C §3 "Context", unit C2).
 *
 * It is the old resources column minus the accounts: seat meters, the local
 * runtime and the running list moved to Apps & Accounts (C6) and the Tasks
 * pane, because they were never about the chat you were reading. What stays:
 *
 *   This chat   usage, context efficiency, the idle-cache warning (ChatUsage)
 *   Folders     each root with its branch and dirty count (SessionRoots)
 *   Handoff     "Continue in a fresh chat…" — the same dialog the notice offers
 *   Memory      the project's shared MEMORY.md (MemoryPanel)
 *   → Accounts & capacity
 *
 * Every figure is read from the session record, its event log and the
 * shared roots read — the pane itself makes no request except MemoryPanel's
 * own, and spends nothing.
 */
import { useEffect, useState } from 'react';
import type { VerseEvent, VerseSeat, VerseSession, VerseSessionRootsResponse } from '../../../data/api-types.js';
import { ChatUsage } from '../context/ChatUsage.js';
import { MemoryPanel } from '../context/MemoryPanel.js';
import { SessionRoots } from '../SessionRoots.js';
import styles from './panes.module.css';

/** The idle-cache warning only has to notice an hour passing. */
const IDLE_TICK_MS = 30_000;

export interface ContextPaneProps {
  session: VerseSession | null;
  seats: readonly VerseSeat[];
  events: readonly VerseEvent[];
  roots: VerseSessionRootsResponse | null;
  rootsError: string | null;
  /** Opens the handoff dialog; absent → the action is not offered here. */
  onHandoff?: () => void;
  /** Why handoff is unavailable right now (a turn is running, dispatch is off); null = available. */
  handoffDisabledReason?: string | null;
  onOpenAccounts: () => void;
  /** False while this pane is a background tab: its clock stops. */
  visible: boolean;
}

function useSlowNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), IDLE_TICK_MS);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export function ContextPane({ session, seats, events, roots, rootsError, onHandoff, handoffDisabledReason = null, onOpenAccounts, visible }: ContextPaneProps) {
  const now = useSlowNow(visible && session !== null);
  return (
    <div className={styles.pane} aria-label="Context">
      <section className={styles.section} aria-labelledby="dock-context-chat">
        <h3 id="dock-context-chat" className={styles.sectionTitle}>This chat</h3>
        {session
          ? <ChatUsage session={session} seats={seats} events={events} now={now} />
          : <p className={styles.muted}>Open a chat to see its usage and context.</p>}
      </section>

      {session ? (
        <div className={styles.section}>
          <SessionRoots session={session} data={roots} error={rootsError} />
        </div>
      ) : null}

      {session && onHandoff ? (
        <section className={styles.section} aria-labelledby="dock-context-handoff">
          <h3 id="dock-context-handoff" className={styles.sectionTitle}>Handoff</h3>
          <p className={styles.muted}>
            Verse drafts a note from this chat&apos;s log — free — and opens a fresh chat with it in the message box. Nothing is sent until you press Send.
          </p>
          <button type="button" className={styles.action} onClick={onHandoff} disabled={handoffDisabledReason !== null}
            title={handoffDisabledReason ?? undefined}>
            Continue in a fresh chat…
          </button>
          {/* Always mounted: the reason comes and goes with every turn, and
              an unmounting line would shift Memory below it each time. */}
          <p className={`${styles.muted} ${styles.reserve}`}>{handoffDisabledReason ?? ''}</p>
        </section>
      ) : null}

      <div className={styles.section}>
        <MemoryPanel projectPath={session?.projectPath ?? null} refreshKey={session?.turnCount ?? 0} />
      </div>

      <div className={styles.section}>
        <button type="button" className={styles.link} onClick={onOpenAccounts}>Accounts &amp; capacity →</button>
      </div>
    </div>
  );
}
