/**
 * routes/verse/sections/ChatSection.tsx — the Chat section of the Verse
 * shell: sidebar · workspace (720px transcript + docked composer) ·
 * resources panel, plus the new-chat dialog, the ⌘K switcher, and every
 * mutation the chat surface makes.
 *
 * Takes NO props (VERSE-CONTRACT-V2 shell contract): the shell lazily
 * mounts it and hands over ⌘N / ⌘K as one-shot commands through
 * verse-ui-store, because only this section knows which chat is open and
 * therefore what those shortcuts should pre-fill.
 *
 * Mutations go through one guard: if no mutation token is held,
 * MutationTokenDialog opens and the action re-runs once unlocked (the same
 * hand-off the command palette uses).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { VerseCreateSessionRequest, VerseSession } from '../../../data/api-types.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { useToast } from '../../../components/primitives/Toast.js';
import { clearReadSession } from '../../../data/auth-store.js';
import { ApiError, DispatchDisabledError } from '../../../data/client.js';
import { useMutationHold, useQuery, useRefetch } from '../../../data/hooks.js';
import { NewChatDialog } from '../NewChatDialog.js';
import { QuickSwitcher } from '../QuickSwitcher.js';
import { ResourcesPanel } from '../ResourcesPanel.js';
import type { SeatChoice } from '../SeatSelector.js';
import { Sidebar } from '../Sidebar.js';
import { useVerseSession } from '../useVerseSession.js';
import { useVerseUi } from '../useVerseUi.js';
import { openVerseListChannel } from '../verse-events.js';
import {
  cancelVerseTurn,
  createVerseSession,
  deleteVerseSession,
  renameVerseSession,
  sendVerseTurn,
  verseBootstrapQuery,
  verseSessionsQuery,
  VerseMutationLockedError,
} from '../verse-queries.js';
import {
  clearVerseCommand,
  lastVerseSeat,
  rememberVerseSeat,
  setVerseResourcesOpen,
  setVerseResourcesWidth,
  setVerseSidebarCollapsed,
  setVerseSidebarWidth,
  VERSE_RESOURCES,
  VERSE_SIDEBAR,
} from '../verse-ui-store.js';
import { forgetVerseSession, setVerseSession, setVerseSessionStatus } from '../verse-store.js';
import { Workspace } from '../Workspace.js';
import styles from './ChatSection.module.css';

const SELECTED_KEY = 'ashlr.verse.selected.v1';

function loadSelected(): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

function describeError(err: unknown): string {
  if (err instanceof DispatchDisabledError) return 'This server was started without dispatch — run `ashlr verse` to chat.';
  if (err instanceof ApiError) {
    if (err.status === 409) return 'A turn is already running in this chat. Stop it first.';
    if (err.status === 413) return 'That message is too large (64 KB max).';
    if (err.status === 401) return 'Mutation token was rejected. Unlock again with the token ashlr verse printed.';
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

export function ChatSection() {
  const bootstrap = useQuery(verseBootstrapQuery);
  const sessionsQuery = useQuery(verseSessionsQuery);
  const refetchSessions = useRefetch(verseSessionsQuery);
  const refetchBootstrap = useRefetch(verseBootstrapQuery);
  const hold = useMutationHold();
  const toast = useToast();
  const ui = useVerseUi();

  const [selectedId, setSelectedIdState] = useState<string | null>(loadSelected);
  const [query, setQuery] = useState('');
  const [newChat, setNewChat] = useState<{ open: boolean; projectPath?: string | null; seat?: SeatChoice | null }>({ open: false });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const [tokenPrompt, setTokenPrompt] = useState<{ open: boolean; reason: string }>({ open: false, reason: '' });
  const pendingAction = useRef<{ run: () => void; cancel: () => void } | null>(null);
  const drag = useRef<{ id: number; x: number; start: number; side: 'sidebar' | 'resources' } | null>(null);

  const seats = useMemo(() => bootstrap.data?.seats ?? [], [bootstrap.data]);
  const projects = useMemo(() => bootstrap.data?.projects ?? [], [bootstrap.data]);
  const dispatchEnabled = bootstrap.data?.dispatchEnabled ?? true;

  const view = useVerseSession(selectedId, reload);

  // Sidebar list: the sessions query, else bootstrap's copy, with the live
  // store record overlaid for the open chat so its running dot is immediate.
  const sessions = useMemo<VerseSession[]>(() => {
    const base = sessionsQuery.data ?? bootstrap.data?.sessions ?? [];
    if (!view.session) return base;
    const live = view.session;
    return base.some((s) => s.id === live.id) ? base.map((s) => (s.id === live.id ? live : s)) : [live, ...base];
  }, [sessionsQuery.data, bootstrap.data, view.session]);

  const setSelectedId = useCallback((id: string | null) => {
    setSelectedIdState(id);
    try {
      if (id) localStorage.setItem(SELECTED_KEY, id);
      else localStorage.removeItem(SELECTED_KEY);
    } catch {
      /* best-effort */
    }
  }, []);

  // A remembered selection that no longer exists (deleted elsewhere) is dropped once the list is known.
  useEffect(() => {
    if (!selectedId || !sessionsQuery.data) return;
    if (!sessionsQuery.data.some((s) => s.id === selectedId) && !view.session) setSelectedId(null);
  }, [selectedId, sessionsQuery.data, view.session, setSelectedId]);

  // Sidebar digest channel (verse-sessions on /api/events).
  useEffect(() => openVerseListChannel(), []);

  // ---- mutation guard -----------------------------------------------------
  // Runs `action` now when a token is held; otherwise opens the token dialog
  // and runs it once unlocked. Resolves null when the dialog is dismissed.
  const withToken = useCallback(<T,>(reason: string, action: () => Promise<T>): Promise<T | null> => {
    if (hold.hasHold) return action();
    return new Promise<T | null>((resolve) => {
      pendingAction.current = {
        run: () => { void action().then(resolve); },
        cancel: () => resolve(null),
      };
      setTokenPrompt({ open: true, reason });
    });
  }, [hold.hasHold]);

  const fail = useCallback((err: unknown) => {
    if (err instanceof VerseMutationLockedError) return;
    toast.show(describeError(err), 'danger');
  }, [toast]);

  // ---- actions ------------------------------------------------------------
  /**
   * ONE resolution of what "new chat" pre-fills, for every entry point.
   *
   * The sidebar "+", ⌘N, the empty-state button and the quick switcher all
   * land here, so they cannot drift apart again: an explicit prefill wins, the
   * open session is next, and the per-project seat memory is the floor. Only
   * when nothing has ever been started does it fall through to the dialog's
   * `defaultSeatChoice()` — which walks ENGINE_ORDER and lands on Claude, the
   * scarcest account, picked by alphabet rather than intent.
   */
  const openNewChat = useCallback((prefill: { projectPath?: string | null; seat?: SeatChoice | null } = {}) => {
    setCreateError(null);
    const current = view.session;
    const projectPath = prefill.projectPath !== undefined
      ? prefill.projectPath
      : current?.projectPath ?? null;
    // The open session's seat only carries forward onto its OWN project;
    // switching projects asks that project's memory instead.
    const fromCurrent = current && projectPath === current.projectPath
      ? { seatId: current.seatId, model: current.model }
      : null;
    const seat = prefill.seat ?? fromCurrent ?? lastVerseSeat(projectPath);
    setNewChat({ open: true, projectPath, seat });
  }, [view.session]);

  const create = useCallback(async (req: VerseCreateSessionRequest) => {
    await withToken('Starting a chat spawns an agent process for this project.', async () => {
      setCreating(true);
      setCreateError(null);
      try {
        const session = await createVerseSession(req);
        // Remember what this project was actually started on, so the NEXT new
        // chat here opens on it instead of resetting to the default engine.
        rememberVerseSeat(session.projectPath, { seatId: session.seatId, model: session.model });
        setVerseSession(session.id, session);
        setNewChat({ open: false });
        setSelectedId(session.id);
        toast.show(`Started “${session.title}”`, 'success');
      } catch (err) {
        setCreateError(describeError(err));
      } finally {
        setCreating(false);
      }
    });
  }, [withToken, setSelectedId, toast]);

  const send = useCallback(async (text: string) => {
    const id = selectedId;
    if (!id) return false;
    const result = await withToken('Sending a message runs the agent against this project.', async () => {
      setVerseSessionStatus(id, 'running');
      try {
        const response = await sendVerseTurn(id, text);
        // The turn may already have settled (spawn failure, fast vendor error)
        // by the time the 202 is applied; the store checks the log for this
        // turnId before trusting the `running` snapshot.
        setVerseSession(id, response.session, response.turnId);
        return true;
      } catch (err) {
        setVerseSessionStatus(id, 'idle');
        fail(err);
        return false;
      }
    });
    return result === true;
  }, [selectedId, withToken, fail]);

  const stop = useCallback((id: string | null = selectedId) => {
    if (!id) return;
    void withToken('Stopping the running turn.', async () => {
      try {
        await cancelVerseTurn(id);
      } catch (err) {
        fail(err);
      }
    });
  }, [selectedId, withToken, fail]);

  const rename = useCallback(async (title: string) => {
    const id = selectedId;
    if (!id) return false;
    const result = await withToken('Renaming a chat.', async () => {
      try {
        const session = await renameVerseSession(id, title);
        setVerseSession(id, session);
        return true;
      } catch (err) {
        fail(err);
        return false;
      }
    });
    return result === true;
  }, [selectedId, withToken, fail]);

  const remove = useCallback(async () => {
    const id = selectedId;
    if (!id) return false;
    const result = await withToken('Deleting a chat removes its transcript from disk.', async () => {
      try {
        await deleteVerseSession(id);
        forgetVerseSession(id);
        setSelectedId(null);
        toast.show('Chat deleted.', 'neutral');
        return true;
      } catch (err) {
        fail(err);
        return false;
      }
    });
    return result === true;
  }, [selectedId, withToken, fail, setSelectedId, toast]);

  /** Sessions are seat-bound: a different seat means a new chat on the same project. */
  const changeSeat = useCallback((choice: SeatChoice) => {
    const current = view.session;
    if (!current) return;
    openNewChat({ projectPath: current.projectPath, seat: choice });
    toast.show('Chats are bound to one seat — starting a new chat on the same project.', 'neutral');
  }, [view.session, openNewChat, toast]);

  // ---- shell commands (⌘N / ⌘K) -------------------------------------------
  // The rail owns the shortcuts; this section owns what they mean. Each
  // command is consumed once, by nonce, then cleared.
  const handledCommand = useRef(0);
  useEffect(() => {
    const command = ui.command;
    if (!command || command.nonce === handledCommand.current) return;
    handledCommand.current = command.nonce;
    if (command.name === 'quick-switcher') setSwitcherOpen(true);
    // ⌘N and the sidebar "+" both call this with no prefill: openNewChat owns
    // the resolution, so the two affordances cannot mean different things.
    else openNewChat();
    clearVerseCommand();
  }, [ui.command, view.session, openNewChat]);

  // ---- resize -------------------------------------------------------------
  const applyWidth = useCallback((side: 'sidebar' | 'resources', value: number) => {
    if (side === 'sidebar') setVerseSidebarWidth(value);
    else setVerseResourcesWidth(value);
  }, []);

  function resizeKey(side: 'sidebar' | 'resources') {
    return (event: KeyboardEvent<HTMLDivElement>) => {
      const range = side === 'sidebar' ? VERSE_SIDEBAR : VERSE_RESOURCES;
      const current = side === 'sidebar' ? ui.sidebarWidth : ui.resourcesWidth;
      const grow = side === 'sidebar' ? event.key === 'ArrowRight' : event.key === 'ArrowLeft';
      const shrink = side === 'sidebar' ? event.key === 'ArrowLeft' : event.key === 'ArrowRight';
      const next = grow ? current + 20 : shrink ? current - 20 : event.key === 'Home' ? range.min : event.key === 'End' ? range.max : null;
      if (next === null) return;
      event.preventDefault();
      applyWidth(side, next);
    };
  }

  function separator(side: 'sidebar' | 'resources') {
    const range = side === 'sidebar' ? VERSE_SIDEBAR : VERSE_RESOURCES;
    const value = side === 'sidebar' ? ui.sidebarWidth : ui.resourcesWidth;
    return (
      <div className={styles.resize} role="separator" tabIndex={0} aria-orientation="vertical"
        aria-label={side === 'sidebar' ? 'Resize chat list' : 'Resize resources panel'}
        aria-valuemin={range.min} aria-valuemax={range.max} aria-valuenow={value} onKeyDown={resizeKey(side)}
        onPointerDown={(event) => {
          drag.current = { id: event.pointerId, x: event.clientX, start: value, side };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          const d = drag.current;
          if (!d || d.id !== event.pointerId) return;
          const delta = event.clientX - d.x;
          applyWidth(d.side, d.side === 'sidebar' ? d.start + delta : d.start - delta);
        }}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} />
    );
  }

  const style = {
    '--verse-sidebar-width': `${ui.sidebarWidth}px`,
    '--verse-resources-width': `${ui.resourcesWidth}px`,
  } as CSSProperties;

  const dispatchOff = bootstrap.data ? !bootstrap.data.dispatchEnabled : false;
  const resourcesOpen = ui.resourcesOpen;
  const sidebarCollapsed = ui.sidebarCollapsed;

  return (
    <div className={styles.chat} style={style}
      data-sidebar={sidebarCollapsed ? 'collapsed' : 'open'} data-resources={resourcesOpen ? 'open' : 'closed'}>
      <Sidebar sessions={sessions} sessionsStatus={sessionsQuery.status} sessionsError={sessionsQuery.error?.message ?? null}
        projects={projects} seats={seats} selectedId={selectedId} query={query} onQuery={setQuery}
        onSelect={(id) => { setSelectedId(id); if (window.matchMedia?.('(max-width: 760px)')?.matches === true) setVerseSidebarCollapsed(true); }}
        // Identical to ⌘N by construction: both hand the decision to
        // openNewChat, which carries the open session's seat forward and, when
        // there is no open session, falls back to this project's remembered
        // seat rather than to defaultSeatChoice's alphabetical Claude.
        onNew={() => openNewChat()}
        onRetry={() => { refetchSessions(); refetchBootstrap(); }}
        onCollapse={() => setVerseSidebarCollapsed(true)} onDisconnect={() => { void clearReadSession(); }} />
      {separator('sidebar')}
      {/* At phone width the sidebar floats over the transcript; the scrim dismisses it. */}
      <button type="button" className={styles.scrim} aria-label="Close chat list" tabIndex={-1}
        onClick={() => setVerseSidebarCollapsed(true)} />
      <main id="main-content" tabIndex={-1} className={styles.main}>
        {bootstrap.status === 'error' && !bootstrap.data ? (
          <div role="alert" className={styles.banner}>
            <span>{bootstrap.error?.message ?? 'Could not load Verse.'}</span>
            <button type="button" onClick={refetchBootstrap}>Retry</button>
          </div>
        ) : dispatchOff ? (
          <div role="status" className={styles.bannerWarn}>
            Read-only: this server was started without dispatch. Run <code>ashlr verse</code> to send messages.
          </div>
        ) : null}
        <Workspace view={view} seats={seats} projects={projects} dispatchEnabled={dispatchEnabled} locked={!hold.hasHold}
          hasAnySessions={sessions.length > 0} onSend={send} onStop={() => stop()} onRename={rename} onDelete={remove}
          onSeatChange={changeSeat} onNew={() => openNewChat()} onRetry={() => setReload((n) => n + 1)}
          sidebarCollapsed={sidebarCollapsed} onToggleSidebar={() => setVerseSidebarCollapsed(!sidebarCollapsed)}
          resourcesOpen={resourcesOpen} onToggleResources={() => setVerseResourcesOpen(!resourcesOpen)} />
      </main>
      {resourcesOpen ? (
        <>
          {separator('resources')}
          <ResourcesPanel bootstrap={bootstrap.data} sessions={sessions} current={view.session} onStop={(id) => stop(id)}
            onOpen={setSelectedId} onClose={() => setVerseResourcesOpen(false)} />
        </>
      ) : null}

      <NewChatDialog open={newChat.open} onClose={() => setNewChat({ open: false })} projects={projects} seats={seats}
        initialProjectPath={newChat.projectPath ?? null} initialSeat={newChat.seat ?? null} busy={creating} error={createError} onCreate={create} />
      <QuickSwitcher open={switcherOpen} onClose={() => setSwitcherOpen(false)} sessions={sessions} seats={seats} projects={projects}
        onSelectSession={setSelectedId} onNewChat={(seat) => openNewChat({ projectPath: view.session?.projectPath ?? null, seat })} />
      <MutationTokenDialog open={tokenPrompt.open} reason={tokenPrompt.reason} tokenLabel="Mutation token"
        tokenHelp="the mutation token ashlr verse printed"
        onClose={() => {
          setTokenPrompt({ open: false, reason: '' });
          // The dialog calls onClose before onUnlocked on submit, so only treat
          // this as a dismissal if nothing has claimed the pending action by
          // the next tick.
          const pending = pendingAction.current;
          if (!pending) return;
          setTimeout(() => {
            if (pendingAction.current === pending) {
              pendingAction.current = null;
              pending.cancel();
            }
          }, 0);
        }}
        onUnlocked={() => {
          const pending = pendingAction.current;
          pendingAction.current = null;
          pending?.run();
        }} />
    </div>
  );
}
