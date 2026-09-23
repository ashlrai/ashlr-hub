/**
 * routes/verse/Workspace.tsx — the chat pane: a --strip-height header with a
 * hairline bottom border and ghost controls only, the 2px context line
 * directly beneath it, the 720px transcript column, and the composer docked
 * at the bottom on the same measure.
 *
 * THE HEADER READS LEFT TO RIGHT, in the order a person asks the questions:
 *
 *   [ project      ]  [ seat · model ]  ……  [ meter ] [ delete ] │ [ ⬓ ⬔ ]
 *   [ Chat title   ]
 *
 *  1. WHERE AM I — a two-line lockup: the project above, the chat title
 *     below. It is the only thing in the strip allowed to shrink, and both
 *     of its lines ellipsise, so neither a 200-character title nor a deep
 *     project path can shove the actions off the end.
 *  2. WHAT IS IT RUNNING ON — the seat pill, which is now seat · model ONLY.
 *     The project moved up into the lockup rather than being said twice.
 *  3. WHAT CAN I DO — stream state, context numbers and the destructive
 *     action, then a hairline, then the two pane toggles as a matched pair.
 *
 * With nothing selected the strip is NOT empty: the lockup says "Chat / No
 * chat selected", so the header still answers "where am I" — which the old
 * strip left as a bare band with one icon floating at the right edge.
 *
 * Two capacity responsibilities live here because this component is mounted
 * for the whole life of the Chat section, selected chat or not:
 *
 *  - IT OWNS THE SEAT POLL. `/api/verse/bootstrap` carries the seats and has
 *    no SSE invalidation, while the account collector needs ~75s to warm; a
 *    mount-time snapshot is therefore guaranteed to be the COLD one. See
 *    useSeatsRefresh for the full reasoning.
 *  - The header's seat pill carries the seat's capacity when it is tight or
 *    spent. Quietly: a healthy seat adds nothing to the strip, because a
 *    badge that is always there is a badge nobody reads.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { VerseProject, VerseSeat } from '../../data/api-types.js';
import { Composer } from './Composer.js';
import { ContextMeter } from './ContextMeter.js';
import type { SeatChoice } from './SeatSelector.js';
import { Transcript } from './Transcript.js';
import { PanelIcon, SidebarIcon, TrashIcon, VerseMark } from './verse-icons.js';
import { CapacityChip } from './SeatCapacity.js';
import { seatSubscription, seatSubscriptionSentence, worthFlagging } from './seat-subscription.js';
import { contextWindowFor, projectName, seatById, seatPillLabel } from './verse-model.js';
import { useSeatsRefresh } from './useSeatsRefresh.js';
import type { VerseSessionView } from './useVerseSession.js';
import styles from './Workspace.module.css';

export interface WorkspaceProps {
  view: VerseSessionView;
  seats: readonly VerseSeat[];
  projects: readonly VerseProject[];
  dispatchEnabled: boolean;
  locked: boolean;
  hasAnySessions: boolean;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  onRename: (title: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  onSeatChange: (choice: SeatChoice) => void;
  onNew: () => void;
  onRetry: () => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  resourcesOpen: boolean;
  onToggleResources: () => void;
}

export function Workspace(props: WorkspaceProps) {
  const { view, seats, projects, dispatchEnabled, locked, hasAnySessions, onSend, onStop, onRename, onDelete,
    onSeatChange, onNew, onRetry, sidebarCollapsed, onToggleSidebar, resourcesOpen, onToggleResources } = props;
  const session = view.session;
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const titleInput = useRef<HTMLInputElement>(null);
  const headingId = useId();

  // Mounted for the whole life of the section, so the roster stays live even
  // with the resources panel hidden.
  useSeatsRefresh();

  useEffect(() => {
    setEditing(false);
    setConfirmDelete(false);
  }, [view.sessionId]);

  useEffect(() => {
    if (editing) titleInput.current?.select();
  }, [editing]);

  /**
   * The two pane toggles — always both rendered, always adjacent, so they
   * read as one control for "which panes are open" rather than as whichever
   * of them happens to apply right now.
   */
  const toggles = (
    <div className={styles.toggles} role="group" aria-label="Panels">
      <SidebarToggle collapsed={sidebarCollapsed} onToggle={onToggleSidebar} />
      <ResourcesToggle open={resourcesOpen} onToggle={onToggleResources} />
    </div>
  );

  if (!view.sessionId) {
    return (
      <section className={styles.workspace} aria-label="Chat">
        <header className={styles.header} data-app-region="drag">
          <Lockup
            eyebrow={<span className={styles.eyebrow}>Chat</span>}
            title={
              <span className={styles.titleStatic} data-state="empty">
                {hasAnySessions ? 'No chat selected' : 'No chats yet'}
              </span>
            }
          />
          <div className={styles.headerSpacer} />
          <div className={styles.actions}>{toggles}</div>
        </header>
        <div className={styles.emptyState}>
          <span className={styles.emptyMark} aria-hidden="true"><VerseMark size={36} /></span>
          <h1 className={styles.emptyTitle}>{hasAnySessions ? 'Pick a chat, or start a new one' : 'No chats yet — ⌘N'}</h1>
          <p className={styles.emptyBody}>
            Open a project, choose a seat — a Claude or Codex account, Grok, or a local Ollama model — and talk to an agent that can edit that project.
          </p>
          <button type="button" className={styles.emptyButton} onClick={onNew}>New chat <kbd>⌘N</kbd></button>
          {!dispatchEnabled ? (
            <p className={styles.emptyWarn} role="status">
              This server was started without dispatch, so chats are read-only here. Run <code>ashlr verse</code> to enable sending.
            </p>
          ) : null}
        </div>
      </section>
    );
  }

  async function commitTitle() {
    const next = draftTitle.trim();
    setEditing(false);
    if (!session || !next || next === session.title) return;
    setBusy(true);
    try {
      await onRename(next);
    } finally {
      setBusy(false);
    }
  }

  function onTitleKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void commitTitle();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setEditing(false);
    }
  }

  const running = session?.status === 'running';
  const contextWindow = session ? contextWindowFor(seats, session) : null;
  const activeSeat = session ? seatById(seats, session.seatId) ?? null : null;
  const capacity = activeSeat === null ? null : seatSubscription(activeSeat);
  // The pill's tooltip is the whole story — seat, plan, verdict, evidence,
  // reset, credits — so the strip itself can stay to one short chip.
  const seatTitle = session === null
    ? ''
    : `${activeSeat === null || capacity === null
      ? seatPillLabel(seats, session)
      : seatSubscriptionSentence(activeSeat, capacity)} · ${session.projectPath}`;
  const disabledReason = !dispatchEnabled ? 'Sending is disabled: this server was started without dispatch.' : null;

  return (
    <section className={styles.workspace} aria-labelledby={headingId}>
      <header className={styles.header} data-app-region="drag">
        <Lockup
          eyebrow={session ? (
            // The full path is the tooltip; the strip shows the short name,
            // because a deep path is exactly what used to eat the title.
            <span className={styles.eyebrow} title={session.projectPath}>{projectName(session.projectPath, projects)}</span>
          ) : (
            <span className={`${styles.eyebrow} skeleton ${styles.eyebrowSkeleton}`} aria-hidden="true" />
          )}
          title={session ? (
            editing ? (
              <input ref={titleInput} className={styles.titleInput} value={draftTitle} aria-label="Chat title"
                onChange={(event) => setDraftTitle(event.target.value)} onBlur={() => { void commitTitle(); }}
                onKeyDown={onTitleKey} maxLength={120} />
            ) : (
              <h1 id={headingId} className={styles.title}>
                <button type="button" className={styles.titleButton} title="Rename chat" disabled={busy || !dispatchEnabled}
                  onClick={() => { setDraftTitle(session.title); setEditing(true); }}>
                  {session.title || 'Untitled chat'}
                </button>
              </h1>
            )
          ) : (
            // The skeleton takes .titleStatic, not .title: .title carries the
            // optical pull-back that only the INSET BUTTON needs, and a grey
            // bar hanging --space-2 into the gutter is just a misalignment.
            <h1 id={headingId} className={`${styles.titleStatic} skeleton ${styles.titleSkeleton}`} aria-label="Loading chat" />
          )}
        />

        {session ? (
          <span className={`${styles.seatPill} ${styles[`engine-${session.engine}`] ?? ''}`} data-engine={session.engine}
            data-seat-capacity={capacity !== null && worthFlagging(capacity.cls) ? capacity.cls : undefined}
            title={seatTitle}>
            <span className={styles.engineDot} aria-hidden="true" />
            <span className={styles.seatText}>{seatPillLabel(seats, session)}</span>
            {/* Only when it changes the decision. A chip on every chat is noise. */}
            {capacity !== null && worthFlagging(capacity.cls)
              ? <CapacityChip view={capacity} />
              : null}
          </span>
        ) : null}

        <div className={styles.headerSpacer} />

        {/* One cluster, and it never shrinks: the lockup truncates instead, so
            the actions can never be pushed past the strip's right edge. */}
        <div className={styles.actions}>
          {view.stream === 'reconnecting' ? <span className={styles.streamState} role="status">reconnecting…</span> : null}
          {session ? <ContextMeter contextTokens={session.usage.contextTokens} contextWindow={contextWindow} /> : null}

          {session ? (
            confirmDelete ? (
              <span className={styles.confirm} role="group" aria-label="Confirm delete">
                <span className={styles.confirmText}>Delete this chat?</span>
                <button type="button" className={styles.danger} disabled={busy} onClick={async () => {
                  setBusy(true);
                  try {
                    const ok = await onDelete();
                    if (!ok) setConfirmDelete(false);
                  } finally {
                    setBusy(false);
                  }
                }}>Delete</button>
                <button type="button" className={styles.ghost} onClick={() => setConfirmDelete(false)}>Keep</button>
              </span>
            ) : (
              <button type="button" className={styles.ghostIcon} onClick={() => setConfirmDelete(true)}
                disabled={!dispatchEnabled || running} aria-label="Delete chat"
                title={running ? 'Stop the turn before deleting' : 'Delete chat'}>
                <TrashIcon />
              </button>
            )
          ) : null}

          <span className={styles.actionDivider} aria-hidden="true" />
          {toggles}
        </div>
      </header>

      <Transcript transcript={view.transcript} loaded={view.loaded} loadError={view.loadError} onRetry={onRetry} />

      {session ? (
        <Composer key={session.id} sessionId={session.id} seats={seats} seat={{ seatId: session.seatId, model: session.model }}
          engine={session.engine} running={running} disabled={!dispatchEnabled} disabledReason={disabledReason} locked={locked}
          hintSeen={session.turnCount > 0} contextTokens={session.usage.contextTokens} contextWindow={contextWindow}
          onSend={onSend} onStop={onStop} onSeatChange={onSeatChange} autoFocus />
      ) : null}
    </section>
  );
}

/**
 * The identity lockup — context over name, one column, and the only flex item
 * in the strip that is allowed to give up width.
 */
function Lockup({ eyebrow, title }: { eyebrow: ReactNode; title: ReactNode }) {
  return (
    <div className={styles.identity}>
      {eyebrow}
      {title}
    </div>
  );
}

/**
 * Pane toggles. Both are `aria-pressed` buttons, so the open/closed state is
 * spoken rather than implied by a name that changes under you.
 *
 * The collapsed name stays "Show chat list" — that is the contract the Chat
 * section's own tests drive — while the expanded one is "Chat list" and NOT
 * "Hide chat list", because the sidebar already owns a button by that exact
 * name and two controls sharing one accessible name is an ambiguity, not a
 * pair. The action itself is in the tooltip in both states.
 */
function SidebarToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <button type="button" className={styles.ghostIcon} onClick={onToggle} aria-pressed={!collapsed}
      title={collapsed ? 'Show chat list' : 'Hide chat list'} aria-label={collapsed ? 'Show chat list' : 'Chat list'}>
      <SidebarIcon />
    </button>
  );
}

function ResourcesToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className={styles.ghostIcon} onClick={onToggle} aria-pressed={open}
      title={open ? 'Hide resources' : 'Show resources'} aria-label="Resources">
      <PanelIcon />
    </button>
  );
}
