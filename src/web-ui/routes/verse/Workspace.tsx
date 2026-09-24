/**
 * routes/verse/Workspace.tsx — the chat pane: the header strip, the 720px
 * transcript, and — stacked above the composer — everything about the turn
 * you are about to send or are waiting on.
 *
 * THE HEADER (3.10, SPEC-310C §2) reads left to right, in the order a person
 * asks the questions:
 *
 *   [ hub › v310-foundation ]  [C claude-a]  [insight]  ……  [◔ 42%] [⋯] │ [>_][▭][±] │ [⫿][▯]
 *   [ Chat title            ]
 *
 *  1. WHERE AM I — the chat title under a `repo › branch` breadcrumb (the
 *     branch from the chat's shared roots read). The only thing in the strip
 *     allowed to shrink; both lines ellipsise.
 *  2. WHAT IS IT RUNNING ON — the seat: an engine tick and its monogram
 *     (C/X/G/L, never a vendor logo), the seat and model, and a capacity chip
 *     only when the seat is tight or spent.
 *  3. WHAT DO I KNOW — C7's insight chip when an A7 insight cites this chat.
 *  4. WHAT CAN I DO — the context ring (its tooltip is the whole context
 *     story), then ⋯: context mode, compact, hand off, copy id, delete.
 *  5. WHICH PANES — Terminal, Preview and Review toggles (each only once its
 *     unit's pane exists in this build), then the chat list and the dock.
 *
 * NOTHING stacks under the header any more. Seat health, the engine's
 * retry / watchdog notices, context advice and the compact panel share ONE
 * notice slot above the composer (chat/NoticeSlot), in order of consequence.
 * Under it, in this order and each only when it has something to say:
 *
 *   notice      one at a time, "+N more"
 *   queued      C3's "Queued, sends when this turn ends [Edit] [Send now] [×]",
 *               portalled out of the Composer into a host here (its state
 *               lives in the Composer; its PLACE is this order)
 *   live row    ● Running npm test · 1m 02s · 38 tok/s  Stop      ◌ 3 running tasks
 *   branch bar  C5's slot: repo  branch  +35,079 −1,074  [Create PR ▾]
 *   composer    C3's — wired to the handoff (`/handoff`, Continue on ‹seat›)
 *               and to the composer bridge (text the dock drafts in)
 *
 * With nothing selected the strip is not empty: it says "Chat / No chat
 * selected", and the seat-health banner still shows (a signed-out seat is
 * news before you pick a chat).
 *
 * This component owns the seat poll (useSeatsRefresh) because it is mounted
 * for the whole life of the Chat section — see that hook for why a
 * mount-time snapshot of seats is guaranteed to be the cold one.
 */
import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from 'react';
import type { VerseContextMode, VerseProject, VerseSeat, VerseSession } from '../../data/api-types.js';
import { engineSupportsModes, hasExpansiveMode } from '../../../core/verse/context-math.js';
import { ENGINE_MONOGRAM } from '../../../core/verse/workbench-types.js';
import { MutationTokenDialog } from '../../components/auth/MutationTokenDialog.js';
import { ActionMenu, anchorBelow, type ActionMenuItem } from './chat/ActionMenu.js';
import { appendParagraph, registerComposerInserter } from './chat/composer-bridge.js';
import { derivePhaseFromTranscript, LiveStatus } from './chat/LiveStatus.js';
import { NoticeSlot, type NoticeCandidate } from './chat/NoticeSlot.js';
import { TasksTray } from './chat/TasksTray.js';
import { countTasks, currentTurnTasks, type ChatTask } from './chat/tasks-model.js';
import { useSessionRoots } from './chat/use-session-roots.js';
import { Composer } from './Composer.js';
import { setSessionContextMode } from './context/context-queries.js';
import { describeContextError, useTokenGate } from './context/use-token-gate.js';
import {
  canCompactNow,
  CompactPanel,
  ContextAdvice,
  contextAdviceVisible,
  ContextMeter,
  CONTEXT_MODE_LABEL,
  expansiveCostCopy,
  standardSwitchCompacts,
} from './ContextMeter.js';
import { CopyGlyph, HandoffGlyph, MoreGlyph, RenameGlyph, TrashGlyph, DOCK_PANE_GLYPH } from './dock/dock-icons.js';
import { openDockPane, requestDiff, toggleDock, toggleDockPane, useDock } from './dock/dock-store.js';
import { DOCK_PANE_LABEL, isPaneAvailable } from './dock/dock-panes.js';
import { saveDraft } from './chat/composer-state.js';
import type { SeatChoice } from './SeatSelector.js';
import { BranchBarSlot, SessionInsightChipSlot } from './shell/slots.js';
import type { DockPaneId } from './shell/dock-catalog.js';
import { findCommand, formatChord } from './shell/command-catalog.js';
import { Transcript } from './Transcript.js';
import { PanelIcon, SidebarIcon, VerseMark } from './verse-icons.js';
import { CapacityChip } from './SeatCapacity.js';
import { seatHealthIssues } from './health/health-model.js';
import { SeatHealthBannerView } from './health/SeatHealthBanner.js';
import { useSeatHealth } from './health/useSeatHealth.js';
import { seatSubscription, seatSubscriptionSentence, worthFlagging } from './seat-subscription.js';
import { projectName, seatById, seatPillLabel, sessionContextBudget, type SessionContextBudget } from './verse-model.js';
import { invalidateVerseLists } from './verse-queries.js';
import { formatTokens, lastTurnActivityAt, setVerseSession, type VerseLiveNotice } from './verse-store.js';
import { rememberVerseSeat } from './verse-ui-store.js';
import { useSeatsRefresh } from './useSeatsRefresh.js';
import { useVerseLive, useVerseTranscript, type VerseSessionView } from './useVerseSession.js';
import styles from './Workspace.module.css';

// Opened on request only: kept out of the chat's first-paint chunk.
const HandoffDialog = lazy(() => import('./context/HandoffDialog.js').then((m) => ({ default: m.HandoffDialog })));

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
  /** Asks for confirmation (ChatSection's dialog), then deletes. */
  onRequestDelete: () => void;
  onSeatChange: (choice: SeatChoice) => void;
  onNew: () => void;
  onRetry: () => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  /**
   * V3.9. Switch the Chat section to another chat — the handoff flow lands
   * on the chat it just created, and "Continued from …" links back. Absent →
   * the new chat is announced and left for the operator to open.
   */
  onOpenSession?: (sessionId: string) => void;
  /** 3.10: the handoff dialog is lifted (the dock's Context pane and a sidebar row open it too). */
  handoffOpen: boolean;
  onHandoffOpenChange: (open: boolean) => void;
  /** 3.10: other chats running right now, for the "◌ N running tasks" chip. */
  otherRunning: readonly ChatTask[];
}

export function Workspace(props: WorkspaceProps) {
  const { view, seats, projects, dispatchEnabled, locked, hasAnySessions, onSend, onStop, onRename, onRequestDelete,
    onSeatChange, onNew, onRetry, sidebarCollapsed, onToggleSidebar, onOpenSession, handoffOpen, onHandoffOpenChange,
    otherRunning } = props;
  const session = view.session;
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [modeState, setModeState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const [compactOpen, setCompactOpen] = useState(false);
  /** The notice the operator just asked for — shown ahead of the priority order. */
  const [pinnedNotice, setPinnedNotice] = useState<string | null>(null);
  /** Set when a handoff chat was created but there is no host callback to switch to it. */
  const [handoffCreated, setHandoffCreated] = useState<{ title: string } | null>(null);
  const [menu, setMenu] = useState<{ anchor: { x: number; y: number }; from: HTMLElement } | null>(null);
  const [copied, setCopied] = useState(false);
  /** Text another pane drafted in (Review "Add to message", Terminal "Send selection to chat"). */
  const [insertRequest, setInsertRequest] = useState<{ nonce: number; text: string } | null>(null);
  /** "Continue on ‹seat›": the seat the handoff should open on. */
  const [handoffTarget, setHandoffTarget] = useState<SeatChoice | null>(null);
  /** Where the composer's "Queued turns" row renders — between the notice slot and the live row. */
  const [queueHost, setQueueHost] = useState<HTMLDivElement | null>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const headingId = useId();

  // Mounted for the whole life of the section, so the roster stays live.
  useSeatsRefresh();
  const roots = useSessionRoots(session);

  useEffect(() => {
    setEditing(false);
    setModeState({ busy: false, error: null });
    setCompactOpen(false);
    setHandoffCreated(null);
    setPinnedNotice(null);
    setMenu(null);
    setInsertRequest(null);
    setHandoffTarget(null);
  }, [view.sessionId]);

  // The composer bridge (chat/composer-bridge.ts): while THIS chat's composer
  // is on screen and can take text, the dock's "Send selection to chat" and
  // Review's "Add to message" land in its draft through `insertRequest` —
  // never sent, one append per nonce. Registered only when a composer is
  // mounted and enabled: otherwise the bridge's caller says "Open a chat…"
  // instead of dropping the text into a box that is not there.
  const composerSessionId = view.session?.id ?? null;
  // The last request the composer has rendered. Child effects run before
  // this parent's, so by the time this effect runs the Composer has taken it.
  const deliveredInsert = useRef(0);
  useEffect(() => {
    if (insertRequest) deliveredInsert.current = insertRequest.nonce;
  }, [insertRequest]);
  useEffect(() => {
    if (!composerSessionId || !dispatchEnabled) return undefined;
    return registerComposerInserter(composerSessionId, (text) => {
      setInsertRequest((prev) => {
        const nonce = (prev?.nonce ?? 0) + 1;
        // Two inserts inside one render (batched) would otherwise show the
        // composer only the second: an undelivered one is merged, not lost.
        const undelivered = prev !== null && prev.nonce > deliveredInsert.current;
        return { nonce, text: undelivered ? appendParagraph(prev.text, text) : text };
      });
    });
  }, [composerSessionId, dispatchEnabled]);

  // The mode switch is a write: without a held token it parks, asks for the
  // token with a reason, and runs once unlocked.
  const gate = useTokenGate();
  const gateRun = gate.run;

  const sessionId = view.session?.id ?? null;
  /**
   * Standard ⇄ expansive. Explicit only, and it applies from the next turn.
   * The server answers with the updated record (budget fields recomputed),
   * which replaces the store's copy so the ring moves at once.
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
   * note goes into the new chat's composer draft, and the operator reads it
   * and presses Send — that press is the first spend.
   */
  const onHandoffCreated = useCallback((created: VerseSession, text: string) => {
    saveDraft(created.id, text);
    rememberVerseSeat(created.projectPath, { seatId: created.seatId, model: created.model });
    setVerseSession(created.id, created);
    invalidateVerseLists();
    onHandoffOpenChange(false);
    if (onOpenSession) onOpenSession(created.id);
    else {
      setHandoffCreated({ title: created.title });
      setPinnedNotice('handoff-created');
    }
  }, [onOpenSession, onHandoffOpenChange]);

  // Focus, then select: select() alone does not move focus everywhere, and
  // the ⋯ menu hands focus back to its trigger as it closes.
  useEffect(() => {
    if (!editing) return;
    titleInput.current?.focus();
    titleInput.current?.select();
  }, [editing]);

  const lastTurnAtMemo = useMemo(() => lastTurnActivityAt(view.events), [view.events]);

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
          <div className={styles.actions}><PaneToggles sidebarCollapsed={sidebarCollapsed} onToggleSidebar={onToggleSidebar} hasSession={false} /></div>
        </header>
        <WorkspaceSeatHealth seats={seats} />
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
  // Only what the CLI can do: a model with a real expansive budget on an
  // engine that takes a per-invocation budget — or a session already in
  // expansive, which must always be able to switch back.
  const modesAvailable = session !== null && budget !== null && engineSupportsModes(session.engine) &&
    (hasExpansiveMode(budget.option) || mode === 'expansive');
  const activeSeat = session ? seatById(seats, session.seatId) ?? null : null;
  const capacity = activeSeat === null ? null : seatSubscription(activeSeat);
  const seatTitle = session === null
    ? ''
    : `${activeSeat === null || capacity === null
      ? seatPillLabel(seats, session)
      : seatSubscriptionSentence(activeSeat, capacity)} · ${session.projectPath}`;
  const disabledReason = !dispatchEnabled ? 'Sending is disabled: this server was started without dispatch.' : null;
  const runningReason = 'Available when the current turn finishes.';
  const compactable = session !== null && canCompactNow(session.engine);
  const openCompact = compactable ? () => { setHandoffCreated(null); setCompactOpen(true); setPinnedNotice('compact'); } : undefined;
  const compactUnavailableReason = session !== null && session.turnCount === 0 ? 'Nothing to compact yet — this chat has no turns.' : null;
  const handoffReason = disabledReason ?? (running ? runningReason : null);
  const openHandoff = () => { setHandoffCreated(null); setHandoffTarget(null); onHandoffOpenChange(true); };
  /**
   * "Continue on ‹seat›" from the composer's seat chip: the handoff (note
   * drafted from this chat's log, spends nothing) opened for that seat. While
   * the handoff is unavailable (a turn running, dispatch off) it falls back
   * to a plain new chat on that seat, which the seat chip already offered.
   */
  const continueOn = (choice: SeatChoice) => {
    if (handoffReason !== null) {
      onSeatChange(choice);
      return;
    }
    setHandoffCreated(null);
    setHandoffTarget(choice);
    onHandoffOpenChange(true);
  };
  const breadcrumb = session ? projectName(session.projectPath, projects) : '';

  // ---- ⋯ menu -------------------------------------------------------------
  const menuItems: ActionMenuItem[] = [];
  if (session) {
    if (modesAvailable && budget) {
      const other: VerseContextMode = mode === 'standard' ? 'expansive' : 'standard';
      const downgrade = other === 'standard' ? standardSwitchCompacts(budget.option, mode, budget) : null;
      // Switching DOWN past Standard's compaction point is not a free flag
      // flip: the CLI compacts on the next turn. Said in the item, not after.
      const downgradeCopy = downgrade === null ? null : downgrade.definite
        ? `This chat holds ≈${formatTokens(downgrade.tokens)}, past Standard's ≈${formatTokens(downgrade.point)} compaction point — it compacts on the next turn.`
        : `This chat holds up to ≈${formatTokens(downgrade.tokens)}; past ≈${formatTokens(downgrade.point)} it compacts on the next turn.`;
      const reason = !dispatchEnabled ? disabledReason : running ? 'The mode cannot change mid-turn. ' + runningReason : modeState.busy ? 'Switching…' : null;
      menuItems.push({
        id: 'mode',
        label: `Context: switch to ${CONTEXT_MODE_LABEL[other]}`,
        icon: <span aria-hidden="true">◔</span>,
        description: other === 'expansive'
          ? expansiveCostCopy(budget.option, session.engine)
          : downgradeCopy ?? `Now ${CONTEXT_MODE_LABEL[mode]}. Applies from the next turn.`,
        disabled: reason !== null,
        reason,
        onSelect: () => { void changeMode(other); },
      });
    }
    if (compactable) {
      const reason = disabledReason ?? (running ? runningReason : compactUnavailableReason);
      menuItems.push({ id: 'compact', label: 'Compact now…', disabled: reason !== null, reason, onSelect: () => openCompact?.() });
    }
    menuItems.push({
      id: 'handoff',
      label: 'Continue in a fresh chat…',
      icon: <HandoffGlyph size={14} />,
      disabled: handoffReason !== null,
      reason: handoffReason,
      onSelect: openHandoff,
    });
    menuItems.push({
      id: 'rename',
      label: 'Rename',
      icon: <RenameGlyph size={14} />,
      disabled: !dispatchEnabled,
      reason: disabledReason,
      onSelect: () => { setDraftTitle(session.title); setEditing(true); },
    });
    menuItems.push({
      id: 'copy-id',
      label: copied ? 'Copied' : 'Copy chat id',
      icon: <CopyGlyph size={14} />,
      onSelect: () => {
        void navigator.clipboard?.writeText(session.id).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }, () => undefined);
      },
    });
    menuItems.push({
      id: 'delete',
      label: 'Delete chat…',
      icon: <TrashGlyph size={14} />,
      danger: true,
      separated: true,
      disabled: !dispatchEnabled || running,
      reason: running ? 'Stop the turn before deleting.' : disabledReason,
      onSelect: onRequestDelete,
    });
  }

  return (
    <section className={styles.workspace} aria-labelledby={headingId}>
      <header className={styles.header} data-app-region="drag">
        <Lockup
          eyebrow={session ? (
            // The full path is the tooltip; the strip shows `repo › branch`.
            <span className={styles.eyebrow} title={session.projectPath} data-testid="chat-breadcrumb">
              {breadcrumb}
              {roots.branch ? <><span className={styles.crumbSep} aria-hidden="true"> › </span><span className="visually-hidden"> on branch </span><span className={styles.crumbBranch}>{roots.branch}</span></> : null}
            </span>
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
            <h1 id={headingId} className={`${styles.titleStatic} skeleton ${styles.titleSkeleton}`} aria-label="Loading chat" />
          )}
        />

        {session ? (
          <span className={`${styles.seatPill} ${styles[`engine-${session.engine}`] ?? ''}`} data-engine={session.engine}
            data-seat-capacity={capacity !== null && worthFlagging(capacity.cls) ? capacity.cls : undefined}
            title={seatTitle}>
            <span className={styles.engineTick} aria-hidden="true" />
            <span className={styles.monogram} aria-hidden="true">{ENGINE_MONOGRAM[session.engine]}</span>
            <span className={styles.seatText}>{seatPillLabel(seats, session)}</span>
            {capacity !== null && worthFlagging(capacity.cls) ? <CapacityChip view={capacity} /> : null}
          </span>
        ) : null}
        {session ? <SessionInsightChipSlot sessionId={session.id} /> : null}

        <div className={styles.headerSpacer} />

        {/* One cluster, and it never shrinks: the lockup truncates instead. */}
        <div className={styles.actions}>
          {view.stream === 'reconnecting' ? <span className={styles.streamState} role="status">reconnecting…</span> : null}
          {session && budget ? (
            <ContextMeter variant="ring" contextTokens={budget.contextTokens} contextWindow={budget.contextWindow} autoCompactAt={budget.autoCompactAt}
              exact={budget.exact} source={budget.source} mode={modesAvailable ? mode : null} engine={session.engine}
              compactionCount={session.compactionCount ?? 0} />
          ) : null}
          {modeState.error ? <span className={styles.modeError} role="alert">{modeState.error}</span> : null}
          {session ? (
            <button type="button" className={styles.ghostIcon} aria-label="Chat actions" title="Chat actions" aria-haspopup="menu"
              aria-expanded={menu !== null}
              onClick={(event) => setMenu(menu ? null : { anchor: anchorBelow(event.currentTarget, 'end', 260), from: event.currentTarget })}>
              <MoreGlyph />
            </button>
          ) : null}
          <span className={styles.actionDivider} aria-hidden="true" />
          <PaneToggles sidebarCollapsed={sidebarCollapsed} onToggleSidebar={onToggleSidebar} hasSession={session !== null} />
        </div>
      </header>

      <LiveTranscript key={view.sessionId} sessionId={view.sessionId} transcriptOverride={view.transcript} loaded={view.loaded}
        loadError={view.loadError} onRetry={onRetry} engine={session?.engine} handoffFrom={session?.handoffFrom ?? null}
        onOpenSession={onOpenSession} />

      {session && budget ? (
        <ChatNotices session={session} seats={seats} budget={budget} modesAvailable={modesAvailable}
          dispatchEnabled={dispatchEnabled} modeBusy={modeState.busy} lastTurnAt={lastTurnAtMemo}
          compactOpen={compactable && compactOpen} running={running} onSend={onSend}
          onCloseCompact={() => { setCompactOpen(false); setPinnedNotice(null); }}
          onHandoff={openHandoff} onSwitchExpansive={() => { void changeMode('expansive'); }} onCompact={openCompact}
          handoffCreated={handoffCreated} onDismissHandoffCreated={() => setHandoffCreated(null)} pinnedId={pinnedNotice} />
      ) : null}

      {/* The composer's "Queued turns" row is portalled here, so the rows above
          the composer read notice → queued → live → branch bar (SPEC-310C §2).
          An empty host is not laid out (`:empty`). */}
      {session ? <div ref={setQueueHost} className={styles.queueHost} data-testid="queue-slot" /> : null}

      {session ? <LiveRow sessionId={session.id} running={running} otherRunning={otherRunning} onStop={onStop} /> : null}

      {session ? (
        <BranchBarSlot sessionId={session.id} roots={roots.roots} onOpenDiff={requestDiff} />
      ) : null}

      {session ? (
        <Composer key={session.id} sessionId={session.id} seats={seats} seat={{ seatId: session.seatId, model: session.model }}
          engine={session.engine} running={running} disabled={!dispatchEnabled} disabledReason={disabledReason} locked={locked}
          hintSeen={session.turnCount > 0} contextTokens={budget?.contextTokens ?? null} contextWindow={budget?.contextWindow ?? null}
          autoCompactAt={budget?.autoCompactAt ?? null} contextExact={budget?.exact ?? true}
          handoffDraft={session.handoffFrom !== undefined && session.turnCount === 0}
          onSend={onSend} onStop={onStop} onSeatChange={onSeatChange}
          onHandoff={openHandoff} handoffDisabledReason={handoffReason} onContinueOn={continueOn}
          insertRequest={insertRequest} queueSlot={queueHost} autoFocus />
      ) : null}

      {menu && session ? (
        <ActionMenu label="Chat actions" items={menuItems} anchor={menu.anchor} returnFocus={menu.from} onClose={() => setMenu(null)} />
      ) : null}

      {/* Mounted only while open: the dialog fetches a preview (git diff
          --stat on the server) and nothing should run for a closed one. */}
      {session && handoffOpen ? (
        <Suspense fallback={null}>
          {/* `initialTarget` preselects the seat "Continue on ‹seat›" named;
              undefined (the plain Hand off… entry) keeps the dialog's own
              default. HandoffDialog reads it once per open, so a pick made
              inside the dialog wins, and a seat that has since gone falls
              back to the default rather than preselecting nothing. */}
          <HandoffDialog session={session} seats={seats} open onClose={() => { setHandoffTarget(null); onHandoffOpenChange(false); }}
            onCreated={onHandoffCreated} initialTarget={handoffTarget ?? undefined} />
        </Suspense>
      ) : null}
      <MutationTokenDialog {...gate.dialog} tokenLabel="Mutation token" tokenHelp="the mutation token ashlr verse printed" />
    </section>
  );
}

/**
 * The transcript, subscribed on its own (V3.10). Everything above re-renders
 * when the session HEAD changes; only this subtree re-renders as tokens and
 * reasoning stream in — at most once per animation frame. Keyed by chat, so
 * search, scroll and the turn announcer start fresh on every switch.
 */
function LiveTranscript({ sessionId, transcriptOverride, ...props }: {
  sessionId: string;
  transcriptOverride: VerseSessionView['transcript'];
} & Omit<ComponentProps<typeof Transcript>, 'transcript' | 'live'>) {
  const transcript = useVerseTranscript(sessionId);
  const live = useVerseLive(sessionId);
  return <Transcript {...props} transcript={transcriptOverride ?? transcript} live={live} />;
}

/**
 * "● Running npm test · 1m 02s · 38 tok/s  Stop" on a 1px amber hairline,
 * with "◌ 3 running tasks" beside it. Its own subscription (transcript +
 * live signals) so the header above never re-renders per token. When this
 * chat is idle but others run, the tasks chip stands alone.
 */
function LiveRow({ sessionId, running, otherRunning, onStop }: {
  sessionId: string;
  running: boolean;
  otherRunning: readonly ChatTask[];
  onStop: () => void;
}) {
  const transcript = useVerseTranscript(sessionId);
  const live = useVerseLive(sessionId);
  const dock = useDock();
  const segments = transcript.segments;
  const lastItems = segments && segments.length > 0 ? segments[segments.length - 1]!.items : transcript.items;
  const liveThinking = live.thinking && live.thinking.turnId === live.turnId ? live.thinking : null;
  const derived = useMemo(() => derivePhaseFromTranscript(lastItems, { thinking: liveThinking }), [lastItems, liveThinking]);
  const tasks = useMemo(() => currentTurnTasks(lastItems), [lastItems]);
  const counts = useMemo(() => countTasks(running ? tasks : [], otherRunning), [running, tasks, otherRunning]);
  const showLive = running && transcript.live;
  if (!showLive && counts.total === 0) return null;
  const tasksActive = dock.state.open && (dock.state.active === 'tasks' || dock.state.splitWith === 'tasks');
  return (
    <div className={styles.liveRow} data-running={showLive || undefined}>
      {showLive ? <LiveStatus live={live} derived={derived} onStop={onStop} showNotice={false} /> : <span className={styles.liveSpacer} />}
      <TasksTray counts={counts} active={tasksActive} onOpen={() => openDockPane('tasks')} />
    </div>
  );
}

const ENGINE_NOTICE_WORD: Readonly<Record<VerseLiveNotice['kind'], string>> = {
  retry: 'Retrying',
  preflight: 'Preflight',
  watchdog: 'Still running',
};

/** The advice notes re-check their evidence on this clock (idle-cache advice appears on time, not on the next render). */
const NOTICE_TICK_MS = 60_000;

/**
 * Every notice candidate for this chat, handed to the ONE slot above the
 * composer (chat/NoticeSlot decides which shows). Subscribes to the live
 * signals itself (for the engine's retry / watchdog notice), so a streamed
 * token re-renders this small tree, not the header.
 */
function ChatNotices(props: {
  session: VerseSession;
  seats: readonly VerseSeat[];
  budget: SessionContextBudget;
  modesAvailable: boolean;
  dispatchEnabled: boolean;
  modeBusy: boolean;
  lastTurnAt: string | null;
  compactOpen: boolean;
  running: boolean;
  onSend: (text: string) => Promise<boolean>;
  onCloseCompact: () => void;
  onHandoff: () => void;
  onSwitchExpansive: () => void;
  onCompact?: () => void;
  handoffCreated: { title: string } | null;
  onDismissHandoffCreated: () => void;
  pinnedId: string | null;
}) {
  const { session, seats, budget, modesAvailable, dispatchEnabled, modeBusy, lastTurnAt, compactOpen, running, onSend,
    onCloseCompact, onHandoff, onSwitchExpansive, onCompact, handoffCreated, onDismissHandoffCreated, pinnedId } = props;
  const health = useSeatHealth();
  const live = useVerseLive(session.id);
  const [now, setNow] = useState(() => Date.now());
  const [, bump] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), NOTICE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const reports = health.data?.seats ?? [];
  const candidates: NoticeCandidate[] = [];
  if (seatHealthIssues(reports, seats).length > 0) {
    candidates.push({ id: 'seat-health', kind: 'seat-health', label: 'Seat health', render: () => <SeatHealthBannerView reports={reports} seats={seats} /> });
  }
  const notice = running && live.notice ? live.notice : null;
  if (notice) {
    candidates.push({
      id: `engine:${notice.kind}`,
      kind: 'engine',
      label: ENGINE_NOTICE_WORD[notice.kind],
      render: () => (
        <p className={styles.engineNotice} data-kind={notice.kind} role="status">
          <span className={styles.engineNoticeWord}>{ENGINE_NOTICE_WORD[notice.kind]}</span>
          <span>{notice.message}</span>
        </p>
      ),
    });
  }
  if (contextAdviceVisible(session, budget, modesAvailable, Math.max(now, Date.now()), lastTurnAt)) {
    candidates.push({
      id: 'context-advice',
      kind: 'context',
      label: 'Context advice',
      render: () => (
        <ContextAdvice embedded session={session} budget={budget} modesAvailable={modesAvailable} dispatchEnabled={dispatchEnabled}
          modeBusy={modeBusy} onHandoff={onHandoff} onSwitchExpansive={onSwitchExpansive} onCompact={onCompact} lastTurnAt={lastTurnAt}
          onDismiss={() => bump((n) => n + 1)} />
      ),
    });
  }
  if (handoffCreated) {
    candidates.push({
      id: 'handoff-created',
      kind: 'context',
      label: 'Handoff started',
      render: () => (
        <p className={styles.adviceStatus} role="status">
          Started “{handoffCreated.title}” — open it from the chat list; the handoff note is waiting in its message box.
          <button type="button" className={styles.ghost} onClick={onDismissHandoffCreated}>Dismiss</button>
        </p>
      ),
    });
  }
  if (compactOpen) {
    candidates.push({
      id: 'compact',
      kind: 'compact',
      label: 'Compact now',
      render: () => (
        <CompactPanel engine={session.engine} budget={budget} running={running} dispatchEnabled={dispatchEnabled}
          empty={session.turnCount === 0} onSend={onSend} onClose={onCloseCompact} />
      ),
    });
  }
  return <NoticeSlot notices={candidates} pinnedId={pinnedId} />;
}

/**
 * The seat health banner with no chat open: it sits in the reading column
 * (there is no composer to sit above). Rendered only when there is something
 * to say, so a healthy roster leaves no padding behind.
 */
function WorkspaceSeatHealth({ seats }: { seats: readonly VerseSeat[] }) {
  const health = useSeatHealth();
  const reports = health.data?.seats ?? [];
  if (seatHealthIssues(reports, seats).length === 0) return null;
  return (
    <div className={styles.advice}>
      <SeatHealthBannerView reports={reports} seats={seats} />
    </div>
  );
}

/** The identity lockup — breadcrumb over title, and the only flex item allowed to give up width. */
function Lockup({ eyebrow, title }: { eyebrow: ReactNode; title: ReactNode }) {
  return (
    <div className={styles.identity}>
      {eyebrow}
      {title}
    </div>
  );
}

function shortcutFor(commandId: string): string | null {
  const chord = findCommand(commandId)?.keys[0];
  return chord ? formatChord(chord) : null;
}

const PANE_COMMAND: Readonly<Record<'terminal' | 'preview' | 'diff', string>> = {
  terminal: 'dock.terminal',
  preview: 'dock.preview',
  diff: 'dock.diff',
};

/**
 * The pane toggles, as one group: Terminal, Preview and Review (each only
 * once its unit's pane is in this build), then the chat list and the dock.
 * All are aria-pressed buttons, so open/closed is spoken, not implied by a
 * name that changes under you. The action and its key are in the tooltip.
 *
 * The chat-list toggle keeps the 3.9 names — "Show chat list" collapsed,
 * "Chat list" expanded (the sidebar owns a "Hide chat list" button, and two
 * controls sharing one accessible name is an ambiguity, not a pair).
 */
function PaneToggles({ sidebarCollapsed, onToggleSidebar, hasSession }: { sidebarCollapsed: boolean; onToggleSidebar: () => void; hasSession: boolean }) {
  const { state } = useDock();
  const shows = (pane: DockPaneId) => state.open && (state.active === pane || state.splitWith === pane);
  const panes = (['terminal', 'preview', 'diff'] as const).filter((pane) => hasSession && isPaneAvailable(pane));
  const dockKey = shortcutFor('dock.toggle');
  const listKey = shortcutFor('chat.sidebar');
  return (
    <div className={styles.toggles} role="group" aria-label="Panels">
      {panes.map((pane) => {
        const Icon = DOCK_PANE_GLYPH[pane];
        const key = shortcutFor(PANE_COMMAND[pane]);
        const on = shows(pane);
        return (
          <button key={pane} type="button" className={`${styles.ghostIcon} ${styles.paneToggle}`} aria-pressed={on} aria-label={DOCK_PANE_LABEL[pane]}
            title={`${on ? 'Hide' : 'Show'} ${DOCK_PANE_LABEL[pane]}${key ? ` (${key})` : ''}`} onClick={() => toggleDockPane(pane)}>
            <Icon />
          </button>
        );
      })}
      {panes.length > 0 ? <span className={`${styles.actionDivider} ${styles.paneToggle}`} aria-hidden="true" /> : null}
      <button type="button" className={styles.ghostIcon} onClick={onToggleSidebar} aria-pressed={!sidebarCollapsed}
        title={`${sidebarCollapsed ? 'Show' : 'Hide'} chat list${listKey ? ` (${listKey})` : ''}`}
        aria-label={sidebarCollapsed ? 'Show chat list' : 'Chat list'}>
        <SidebarIcon />
      </button>
      <button type="button" className={styles.ghostIcon} onClick={toggleDock} aria-pressed={state.open}
        title={`${state.open ? 'Hide' : 'Show'} the dock${dockKey ? ` (${dockKey})` : ''}`} aria-label="Dock">
        <PanelIcon />
      </button>
    </div>
  );
}
