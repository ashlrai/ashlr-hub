/**
 * routes/verse/Workspace.tsx — the chat pane: a --strip-height header with a
 * hairline bottom border and ghost controls only, the 2px context line
 * directly beneath it, the 720px transcript column, and the composer docked
 * at the bottom on the same measure.
 *
 * THE HEADER READS LEFT TO RIGHT, in the order a person asks the questions:
 *
 *   [ project      ]  [ seat · model ]  ……  [ meter ] [ mode ] [ delete ] │ [ ⬓ ⬔ ]
 *   [ Chat title   ]
 *
 *  1. WHERE AM I — a two-line lockup: the project above, the chat title
 *     below. It is the only thing in the strip allowed to shrink, and both
 *     of its lines ellipsise, so neither a 200-character title nor a deep
 *     project path can shove the actions off the end.
 *  2. WHAT IS IT RUNNING ON — the seat pill, which is now seat · model ONLY.
 *     The project moved up into the lockup rather than being said twice.
 *  3. WHAT CAN I DO — stream state, context numbers, the context-mode chip
 *     (only for a model with a real expansive budget) and the destructive
 *     action, then a hairline, then the two pane toggles as a matched pair.
 *
 * UNDER THE STRIP (V3.9), never in it — the strip is one fixed-height row —
 * sit the context-advice notes: "continue in a fresh chat" when handoffAdvice
 * says so, and "expansive mode could help" when expansiveAdvice does. Both
 * are suggestions with their reasons and costs stated; neither acts on its
 * own. The handoff dialog creates a chat and pre-fills its composer; the
 * operator's Send is the first spend.
 *
 * "Compact now…" (claude and local engines only — see canCompactNow) opens a
 * confirm panel in the same place, reached from the mode menu and from the
 * handoff note. It sends `/compact [focus]` through `onSend`, the composer's
 * own path, so it is an ordinary turn in every respect that matters: token
 * gate, running state, transcript entry, local-only chokepoint.
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
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { VerseContextMode, VerseProject, VerseSeat, VerseSession } from '../../data/api-types.js';
import { engineSupportsModes, hasExpansiveMode } from '../../../core/verse/context-math.js';
import { saveDraft } from './chat/composer-state.js';
import { Composer } from './Composer.js';
import { MutationTokenDialog } from '../../components/auth/MutationTokenDialog.js';
import { setSessionContextMode } from './context/context-queries.js';
import { HandoffDialog } from './context/HandoffDialog.js';
import { describeContextError, useTokenGate } from './context/use-token-gate.js';
import { canCompactNow, CompactPanel, ContextAdvice, ContextMeter, ContextModeControl } from './ContextMeter.js';
import type { SeatChoice } from './SeatSelector.js';
import { Transcript } from './Transcript.js';
import { PanelIcon, SidebarIcon, TrashIcon, VerseMark } from './verse-icons.js';
import { CapacityChip } from './SeatCapacity.js';
import { seatSubscription, seatSubscriptionSentence, worthFlagging } from './seat-subscription.js';
import { projectName, seatById, seatPillLabel, sessionContextBudget } from './verse-model.js';
import { invalidateVerseLists } from './verse-queries.js';
import { setVerseSession } from './verse-store.js';
import { rememberVerseSeat } from './verse-ui-store.js';
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
  /**
   * V3.9. Switch the Chat section to another chat — the handoff flow lands
   * on the chat it just created, and "Continued from …" links back. Absent →
   * the new chat is announced and left for the operator to open.
   */
  onOpenSession?: (sessionId: string) => void;
}

export function Workspace(props: WorkspaceProps) {
  const { view, seats, projects, dispatchEnabled, locked, hasAnySessions, onSend, onStop, onRename, onDelete,
    onSeatChange, onNew, onRetry, sidebarCollapsed, onToggleSidebar, resourcesOpen, onToggleResources,
    onOpenSession } = props;
  const session = view.session;
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [modeState, setModeState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);
  /** Set when a handoff chat was created but there is no host callback to switch to it. */
  const [handoffCreated, setHandoffCreated] = useState<{ title: string } | null>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const headingId = useId();

  // Mounted for the whole life of the section, so the roster stays live even
  // with the resources panel hidden.
  useSeatsRefresh();

  useEffect(() => {
    setEditing(false);
    setConfirmDelete(false);
    setModeState({ busy: false, error: null });
    setHandoffOpen(false);
    setCompactOpen(false);
    setHandoffCreated(null);
  }, [view.sessionId]);

  // The mode switch is a write: without a held token it parks, asks for the
  // token with a reason, and runs once unlocked — the same hand-off the Chat
  // section's own actions use, owned here because the chip lives here.
  const gate = useTokenGate();
  const gateRun = gate.run;

  const sessionId = view.session?.id ?? null;
  /**
   * Standard ⇄ expansive. Explicit only — the suggestion chip calls this too,
   * on a click, never on its own — and it applies from the next turn. The
   * server answers with the updated record (budget fields recomputed for the
   * new mode), which replaces the store's copy so the meter moves at once.
   */
  const changeMode = useCallback(async (mode: VerseContextMode) => {
    if (!sessionId) return;
    setModeState({ busy: true, error: null });
    try {
      const updated = await gateRun('Changing the context mode changes the compaction flag this chat runs with from its next turn.',
        () => setSessionContextMode(sessionId, mode));
      if (updated) setVerseSession(updated.id, updated);
      setModeState({ busy: false, error: null });
    } catch (err) {
      setModeState({ busy: false, error: describeContextError(err) });
    }
  }, [sessionId, gateRun]);

  /**
   * The handoff dialog created a chat. Its first message is NOT sent: the
   * note goes into the new chat's composer draft (composer-state, the same
   * per-session draft store the composer restores on mount), and the operator
   * reads it and presses Send — that press is the first spend.
   */
  const onHandoffCreated = useCallback((created: VerseSession, text: string) => {
    saveDraft(created.id, text);
    rememberVerseSeat(created.projectPath, { seatId: created.seatId, model: created.model });
    setVerseSession(created.id, created);
    invalidateVerseLists();
    setHandoffOpen(false);
    if (onOpenSession) onOpenSession(created.id);
    else setHandoffCreated({ title: created.title });
  }, [onOpenSession]);

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
  const budget = session ? sessionContextBudget(seats, session) : null;
  const mode: VerseContextMode = session?.contextMode ?? 'standard';
  // The chip only offers what the CLI can do: a model with a real expansive
  // budget on an engine that takes a per-invocation budget — or a session
  // already in expansive, which must always be able to switch back.
  const modesAvailable = session !== null && budget !== null && engineSupportsModes(session.engine) &&
    (hasExpansiveMode(budget.option) || mode === 'expansive');
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
  // The engine answers 409 to a mode change while a turn runs, so the chip is
  // disabled for the turn's length rather than offering a choice that fails.
  const modeDisabledReason = disabledReason ?? (running ? 'Available when the current turn finishes — the mode cannot change mid-turn.' : null);
  const compactable = session !== null && canCompactNow(session.engine);
  const openCompact = compactable ? () => { setHandoffCreated(null); setCompactOpen(true); } : undefined;

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
          {session && budget ? (
            <ContextMeter contextTokens={budget.contextTokens} contextWindow={budget.contextWindow} autoCompactAt={budget.autoCompactAt}
              exact={budget.exact} source={budget.source} mode={modesAvailable ? mode : null} engine={session.engine}
              compactionCount={session.compactionCount ?? 0} />
          ) : null}
          {session && budget && modesAvailable ? (
            <ContextModeControl mode={mode} option={budget.option} busy={modeState.busy} error={modeState.error}
              disabled={!dispatchEnabled || running} disabledReason={modeDisabledReason}
              onChange={(next) => { void changeMode(next); }} onCompact={openCompact} />
          ) : null}

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

      {session && budget ? (
        <ContextAdvice session={session} budget={budget} modesAvailable={modesAvailable} dispatchEnabled={dispatchEnabled}
          modeBusy={modeState.busy} onHandoff={() => { setHandoffCreated(null); setHandoffOpen(true); }}
          onSwitchExpansive={() => { void changeMode('expansive'); }} onCompact={openCompact} />
      ) : null}
      {session && budget && compactable && compactOpen ? (
        <div className={styles.advice}>
          <CompactPanel engine={session.engine} budget={budget} running={running} dispatchEnabled={dispatchEnabled}
            empty={session.turnCount === 0} onSend={onSend} onClose={() => setCompactOpen(false)} />
        </div>
      ) : null}
      {handoffCreated ? (
        <div className={styles.advice}>
          <p className={styles.adviceStatus} role="status">
            Started “{handoffCreated.title}” — open it from the chat list; the handoff note is waiting in its message box.
          </p>
        </div>
      ) : null}

      <Transcript transcript={view.transcript} loaded={view.loaded} loadError={view.loadError} onRetry={onRetry}
        engine={session?.engine} handoffFrom={session?.handoffFrom ?? null} onOpenSession={onOpenSession} />

      {session ? (
        <Composer key={session.id} sessionId={session.id} seats={seats} seat={{ seatId: session.seatId, model: session.model }}
          engine={session.engine} running={running} disabled={!dispatchEnabled} disabledReason={disabledReason} locked={locked}
          hintSeen={session.turnCount > 0} contextTokens={budget?.contextTokens ?? null} contextWindow={budget?.contextWindow ?? null}
          autoCompactAt={budget?.autoCompactAt ?? null} contextExact={budget?.exact ?? true}
          handoffDraft={session.handoffFrom !== undefined && session.turnCount === 0}
          onSend={onSend} onStop={onStop} onSeatChange={onSeatChange} autoFocus />
      ) : null}

      {/* Mounted only while open: the dialog fetches a preview (git diff
          --stat on the server) and nothing should run for a closed one. */}
      {session && handoffOpen ? (
        <HandoffDialog session={session} seats={seats} open onClose={() => setHandoffOpen(false)} onCreated={onHandoffCreated} />
      ) : null}
      <MutationTokenDialog {...gate.dialog} tokenLabel="Mutation token" tokenHelp="the mutation token ashlr verse printed" />
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
