/**
 * routes/verse/Workspace.tsx — the chat pane: a 48px header strip with a
 * hairline bottom border and ghost controls only, the 2px context line
 * directly beneath it, the 720px transcript column, and the composer docked
 * at the bottom on the same measure.
 *
 * With nothing selected it renders the empty state ("No chats yet — ⌘N").
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { VerseProject, VerseSeat } from '../../data/api-types.js';
import { Composer } from './Composer.js';
import { ContextMeter } from './ContextMeter.js';
import type { SeatChoice } from './SeatSelector.js';
import { Transcript } from './Transcript.js';
import { PanelIcon, SidebarIcon, TrashIcon, VerseMark } from './verse-icons.js';
import { contextWindowFor, projectName, seatPillLabel } from './verse-model.js';
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

  useEffect(() => {
    setEditing(false);
    setConfirmDelete(false);
  }, [view.sessionId]);

  useEffect(() => {
    if (editing) titleInput.current?.select();
  }, [editing]);

  const chrome = (
    <>
      {sidebarCollapsed ? (
        <button type="button" className={styles.ghostIcon} onClick={onToggleSidebar} title="Show chat list" aria-label="Show chat list">
          <SidebarIcon />
        </button>
      ) : null}
    </>
  );

  if (!view.sessionId) {
    return (
      <section className={styles.workspace} aria-label="Chat">
        <header className={styles.header} data-app-region="drag">
          {chrome}
          <div className={styles.headerSpacer} />
          <ResourcesToggle open={resourcesOpen} onToggle={onToggleResources} />
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
  const disabledReason = !dispatchEnabled ? 'Sending is disabled: this server was started without dispatch.' : null;

  return (
    <section className={styles.workspace} aria-labelledby={headingId}>
      <header className={styles.header} data-app-region="drag">
        {chrome}
        {session ? (
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
        ) : <h1 id={headingId} className={`${styles.title} skeleton ${styles.titleSkeleton}`} aria-label="Loading chat" />}

        {session ? (
          <span className={`${styles.seatPill} ${styles[`engine-${session.engine}`] ?? ''}`} data-engine={session.engine}
            title={`${seatPillLabel(seats, session)} · ${session.projectPath}`}>
            <span className={styles.engineDot} aria-hidden="true" />
            <span className={styles.seatText}>{seatPillLabel(seats, session)}</span>
            <span className={styles.projectName}>{projectName(session.projectPath, projects)}</span>
          </span>
        ) : null}

        <div className={styles.headerSpacer} />

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
        <ResourcesToggle open={resourcesOpen} onToggle={onToggleResources} />
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

function ResourcesToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className={styles.ghostIcon} onClick={onToggle} aria-pressed={open}
      title={open ? 'Hide resources' : 'Show resources'} aria-label="Resources">
      <PanelIcon />
    </button>
  );
}
