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
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { VerseCreateSessionRequest, VerseSession } from '../../../data/api-types.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { useToast } from '../../../components/primitives/Toast.js';
import { clearReadSession } from '../../../data/auth-store.js';
import { ApiError, DispatchDisabledError } from '../../../data/client.js';
import { useMutationHold, useQuery, useRefresh } from '../../../data/hooks.js';
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
  verseWorkspacesQuery,
  VerseMutationLockedError,
} from '../verse-queries.js';
import {
  clearVerseCommand,
  lastVerseSeat,
  rememberVerseSeat,
  setVerseResourcesOpen,
  setVerseSidebarCollapsed,
} from '../verse-ui-store.js';
// Panel widths are NOT in verse-ui-store: `ashlr.verse.ui.v2` is the shell
// contract, and a resizable width is a pair (chosen / afforded) that key
// cannot hold. Same precedent as resources-collapse.ts — its own module,
// its own key. See chat-panel-sizing.ts.
import { ChatResizer, useChatPanelSizing } from '../ChatResizer.js';
import { setChatPanelFit } from '../chat-panel-sizing.js';
import { forgetComposerMemory } from '../chat/composer-state.js';
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

/**
 * Every chat-surface failure in one sentence, branching on the route's CODE
 * before its status.
 *
 * A 409 is not always "busy": POST …/turns also answers 409
 * VERSE_MODEL_UNAVAILABLE when the chat's model cannot run on its seat (e.g.
 * an old `claude-opus-5.5` chat on a seat pinned below Claude Code 2.1.280).
 * Mapping every 409 to "a turn is already running" told the operator to press
 * a Stop that does nothing, on every retry, with the server's actual reason
 * thrown away.
 */
export function describeChatError(err: unknown): string {
  if (err instanceof DispatchDisabledError) return 'This server was started without dispatch — run `ashlr verse` to chat.';
  if (err instanceof ApiError) {
    if (err.code === 'VERSE_MODEL_UNAVAILABLE') {
      const why = err.detail ?? "This chat's model cannot run on its seat.";
      return `${why.replace(/\.?$/, '.')} Continue in a fresh chat on a model this seat can run, or re-pin the seat's CLI (\`ashlr resources profile repin\`).`;
    }
    if (err.status === 409 && (err.code === null || err.code === 'VERSE_SESSION_BUSY')) return 'A turn is already running in this chat. Stop it first.';
    if (err.status === 413) return 'That message is too large (64 KB max).';
    if (err.status === 401) return 'Mutation token was rejected. Unlock again with the token ashlr verse printed.';
    // Any other refusal: the sentence the route author wrote for a person.
    return err.detail ?? err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

export function ChatSection() {
  const bootstrap = useQuery(verseBootstrapQuery);
  const sessionsQuery = useQuery(verseSessionsQuery);
  const refetchSessions = useRefresh(verseSessionsQuery);
  const refetchBootstrap = useRefresh(verseBootstrapQuery);
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
  const chatRef = useRef<HTMLDivElement>(null);
  const panels = useChatPanelSizing();

  const seats = useMemo(() => bootstrap.data?.seats ?? [], [bootstrap.data]);
  const projects = useMemo(() => bootstrap.data?.projects ?? [], [bootstrap.data]);
  // Workspaces come from their own route, not bootstrap: the dialog wants the
  // live per-root status alongside the list, and bootstrap's key set is a
  // frozen contract asserted by test/verse-api.test.ts.
  const workspacesQuery = useQuery(verseWorkspacesQuery);
  const workspaces = useMemo(() => workspacesQuery.data?.workspaces ?? [], [workspacesQuery.data]);
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
    return new Promise<T | null>((resolve, reject) => {
      pendingAction.current = {
        // Pass rejections through: a parked action that fails after the token
        // unlock must reach its caller's catch, not leave it awaiting forever.
        run: () => { action().then(resolve, reject); },
        cancel: () => resolve(null),
      };
      setTokenPrompt({ open: true, reason });
    });
  }, [hold.hasHold]);

  const fail = useCallback((err: unknown) => {
    if (err instanceof VerseMutationLockedError) return;
    toast.show(describeChatError(err), 'danger');
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
        setCreateError(describeChatError(err));
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
        // The transcript is gone from disk; the verbatim prompts must not
        // survive it in browser storage under a dead session id.
        forgetComposerMemory(id);
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

  const dispatchOff = bootstrap.data ? !bootstrap.data.dispatchEnabled : false;
  const resourcesOpen = ui.resourcesOpen;
  const sidebarCollapsed = ui.sidebarCollapsed;

  // ---- fit ----------------------------------------------------------------
  // Tell the sizing store how much room the grid actually has, so a width
  // chosen on a 1900px display cannot strand the transcript at 1100px. This
  // never persists: the chosen width is remembered, the afforded width is
  // recomputed, so widening the window gives the panel its size back.
  useEffect(() => {
    const node = chatRef.current;
    if (!node) return undefined;
    const measure = () => setChatPanelFit({
      containerWidth: node.clientWidth,
      sidebarVisible: !sidebarCollapsed,
      resourcesVisible: resourcesOpen,
    });
    measure();
    // ResizeObserver also catches the rail expanding, which moves this grid's
    // width without a window resize. The listener is the fallback where it is
    // missing (jsdom), where clientWidth is 0 and fitting is skipped anyway.
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [sidebarCollapsed, resourcesOpen]);

  const style = {
    '--verse-sidebar-width': `${panels.effective.sidebar}px`,
    '--verse-resources-width': `${panels.effective.resources}px`,
  } as CSSProperties;

  return (
    <div ref={chatRef} className={styles.chat} style={style}
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
      {/* A hidden panel leaves no handle behind — and the grid templates in
          ChatSection.module.css are written for exactly these item lists. */}
      {sidebarCollapsed ? null : <ChatResizer side="sidebar" label="Resize chat list" className={styles.resize} />}
      {/* At phone width the sidebar floats over the transcript; the scrim dismisses it. */}
      <button type="button" className={styles.scrim} aria-label="Close chat list" tabIndex={-1}
        onClick={() => setVerseSidebarCollapsed(true)} />
      <div className={styles.main}>
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
          resourcesOpen={resourcesOpen} onToggleResources={() => setVerseResourcesOpen(!resourcesOpen)}
          // V3.9: a handoff lands on the chat it created, and "Continued from …"
          // opens the source — both are ordinary selections.
          onOpenSession={setSelectedId} />
      </div>
      {resourcesOpen ? (
        <>
          <ChatResizer side="resources" label="Resize resources panel" className={styles.resize} />
          <ResourcesPanel bootstrap={bootstrap.data} sessions={sessions} current={view.session} events={view.events}
            onStop={(id) => stop(id)} onOpen={setSelectedId} onClose={() => setVerseResourcesOpen(false)} />
        </>
      ) : null}

      <NewChatDialog open={newChat.open} onClose={() => setNewChat({ open: false })} projects={projects} seats={seats} workspaces={workspaces}
        initialProjectPath={newChat.projectPath ?? null} initialSeat={newChat.seat ?? null} busy={creating} error={createError} onCreate={create}
        // The dialog's one write of its own (a seat's default context mode)
        // goes through the same token guard as every other chat mutation.
        runMutation={withToken} />
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
