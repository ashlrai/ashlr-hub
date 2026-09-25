/**
 * routes/verse/sections/ChatSection.tsx — the Chat surface (⌘5):
 *
 *   [sessions 264 | transcript ≤720 | dock 440 (tabs, or two panes split)]
 *
 * plus the new-chat dialog, the delete confirmation, and every mutation the
 * chat surface makes (SPEC-310C §2–§3, unit C2).
 *
 * Takes NO props (the shell contract): the shell lazily mounts it. The ways
 * INTO it from elsewhere in the workbench arrive two ways, both C1's:
 *   - the shell's one-shot command (verse-ui-store): `new-chat` (⌘N, "New
 *     chat on…", with a seat or project), `open-session` (a Needs-you item, a
 *     notification, ⌃Tab, ⌘[ / ⌘]), `focus-composer` (⌃⌥Space);
 *   - the command bus (shell/command-bus.ts): this section serves the
 *     catalog's chat-scope commands — `dock.*`, `chat.sidebar`, `chat.find`,
 *     `chat.turn-prev/next` — for the palette, the native menu and keys.
 * And it reports which chat is open (setVerseActiveSession), which feeds
 * ⌃Tab's recent list and back/forward.
 *
 * 3.10 changes, briefly:
 *   - the resources column became the DOCK (dock/Dock.tsx): Terminal,
 *     Preview and Review through C0's slots, Tasks and Context of its own;
 *     below 1024px it is a sheet, below 480px a bottom sheet;
 *   - the chat list gained filters, pins, archive, unread and a live second
 *     line (C1's activity + session-meta routes, tolerated when absent);
 *   - the ⌘K chat switcher is gone — ⌘K is the shell's command palette;
 *   - the chat-scope keys (⌘\ ⌃` ⌃⇧` ⇧⌘B ⇧⌘D ⌘B) run the same handlers,
 *     matched from C0's catalog while this surface is visible — and only when
 *     the shell's own key handler has not already taken the event.
 *
 * Mutations go through one guard: if no mutation token is held,
 * MutationTokenDialog opens and the action re-runs once unlocked.
 */
import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentProps, type CSSProperties } from 'react';
import type { VerseCreateSessionRequest, VerseSession } from '../../../data/api-types.js';
import type { MutationTokenDialog as MutationTokenDialogComponent } from '../../../components/auth/MutationTokenDialog.js';
import { Button } from '../../../components/primitives/Button.js';
import type { Dialog as DialogComponent } from '../../../components/primitives/Dialog.js';
import { useToast } from '../../../components/primitives/Toast.js';
import { clearReadSession } from '../../../data/auth-store.js';
import { ApiError, DispatchDisabledError } from '../../../data/client.js';
import { useMutationHold, useQuery, useRefresh } from '../../../data/hooks.js';
import { insertIntoComposer } from '../chat/composer-bridge.js';
import { forgetComposerMemory } from '../chat/composer-memory.js';
import type { ChatTask } from '../chat/tasks-model.js';
import { requestTranscriptFind, requestTranscriptStep } from '../chat/transcript-jump.js';
import { noteSessionSeen, useChatActivity } from '../chat/use-chat-activity.js';
import { useSessionRoots } from '../chat/use-session-roots.js';
import { ChatResizer, useChatPanelSizing } from '../ChatResizer.js';
import { CHAT_PANEL_RANGES, MIN_TRANSCRIPT_WIDTH, setChatPanelFit } from '../chat-panel-sizing.js';
import { clearDockRequests, requestTerminal, toggleDock, toggleDockPane, useDock } from '../dock/dock-store.js';
import type { SeatChoice } from '../SeatSelector.js';
import { clampDockWidth, DOCK_LAYOUT, dockPresentation } from '../shell/dock-catalog.js';
import { useCommandHandler } from '../shell/command-bus.js';
import { matchCommand } from '../shell/command-catalog.js';
import { preloadedLazy, preloadedModule } from '../shell/preloaded.js';
import { useSectionVisible } from '../shell/section-visibility.js';
import type { TurnFileChange } from '../shell/slots.js';
import type { Sidebar as SidebarComponent, SidebarRowActions } from '../Sidebar.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { useVerseSession } from '../useVerseSession.js';
import { useVerseUi } from '../useVerseUi.js';
import { openVerseListChannel } from '../verse-events.js';
import {
  cancelVerseTurn,
  createVerseSession,
  deleteVerseSession,
  renameVerseSession,
  sendVerseTurn,
  setVerseSessionMeta,
  verseBootstrapQuery,
  verseSessionsQuery,
  verseWorkspacesQuery,
  VerseMutationLockedError,
} from '../verse-queries.js';
import { forgetVerseSession, setVerseSession, setVerseSessionStatus } from '../verse-store.js';
import {
  clearVerseCommand,
  lastVerseSeat,
  rememberVerseSeat,
  setVerseActiveSession,
  setVerseSection,
  setVerseSidebarCollapsed,
} from '../verse-ui-store.js';
import type { Workspace as WorkspaceComponent } from '../Workspace.js';
import styles from './ChatSection.module.css';

// Loaded on first use, not with the chat: the dock starts closed and the
// new-chat dialog opens on request (SPEC-310C budget: chat critical JS).
const DockHost = lazy(() => import('../dock/DockHost.js').then((m) => ({ default: m.DockHost })));
const NewChatDialog = lazy(() => import('../NewChatDialog.js').then((m) => ({ default: m.NewChatDialog })));

const WorkspaceModule = preloadedLazy<ComponentProps<typeof WorkspaceComponent>>(() => import('../Workspace.js').then((m) => m.Workspace));
const Workspace = WorkspaceModule.Slot;
const SidebarModule = preloadedLazy<ComponentProps<typeof SidebarComponent>>(() => import('../Sidebar.js').then((m) => m.Sidebar));
const Sidebar = SidebarModule.Slot;
/**
 * The delete confirmation and the token prompt draw nothing until an
 * operator acts, and as static imports they (with the dialog primitive and
 * its focus trap, ~4 KB) sat in the chat first-paint critical JS. Preloaded:
 * by the time anyone can click Delete the chunk is in and they mount in the
 * same render that opens them. Both come from one chunk.
 */
const DialogModule = preloadedLazy<ComponentProps<typeof DialogComponent>>(() => import('../../../components/primitives/Dialog.js').then((m) => m.Dialog));
const Dialog = DialogModule.Slot;
const TokenDialogModule = preloadedLazy<ComponentProps<typeof MutationTokenDialogComponent>>(
  () => import('../../../components/auth/MutationTokenDialog.js').then((m) => m.MutationTokenDialog),
);
const MutationTokenDialog = TokenDialogModule.Slot;

/**
 * The two derivations only the workspace's tasks row and the dock read
 * (tool-semantics, sidebar-model and line-diff come with them, ~12 KB). Both
 * consumers are lazy chunks that import these modules themselves, so the
 * download is shared and the values are in before either consumer mounts;
 * until then there is honestly nothing to show.
 */
const DERIVATIONS = preloadedModule(() => Promise.all([import('../chat/tasks-model.js'), import('../chat/turn-files.js')])
  .then(([tasks, files]) => ({ otherRunningChats: tasks.otherRunningChats, lastTurnFiles: files.lastTurnFiles })));
/** Seat lookups for ⌘N "New chat on…" — the only first-paint-path use of verse-model (5.6 KB). */
const SEAT_MODEL = preloadedModule(() => import('../verse-model.js').then((m) => ({ firstRunnableModel: m.firstRunnableModel, seatById: m.seatById })));
const NO_TASKS: readonly ChatTask[] = [];
const NO_TURN_FILES: TurnFileChange[] = [];

/**
 * Resolves when the chat's own chunks (workspace, chat list) are in. Tests
 * await it so a mount renders the whole surface synchronously; nothing in the
 * app needs to — the Suspense skeletons cover the gap.
 */
export function preloadChatSurface(): Promise<unknown> {
  return Promise.all([
    WorkspaceModule.ready(), SidebarModule.ready(), DialogModule.ready(), TokenDialogModule.ready(), DERIVATIONS.ready(), SEAT_MODEL.ready(),
  ]);
}

/**
 * The chat list's shape while its chunk loads. A <nav> like the real one, so
 * the grid rules written against `.chat > nav` (collapsed = display:none, the
 * phone-width overlay) hold for it too — but NOT named "Chats": that name is
 * the loaded list's, and a placeholder answering to it would be a lie.
 */
function SidebarSkeleton() {
  return (
    <nav className={styles.sidebarSkeleton} aria-busy="true" aria-label="Loading chat list">
      {[64, 82, 58, 76, 70].map((w) => <SkeletonLine key={w} width={`${w}%`} />)}
    </nav>
  );
}

/** The workspace column's shape while its chunk loads: header, a few lines, the composer bar. */
function WorkspaceSkeleton() {
  return (
    <div className={styles.workspaceSkeleton} role="status" aria-label="Loading chat">
      <div className={styles.skeletonHeader}><SkeletonLine width="32%" /></div>
      <div className={styles.skeletonBody}>
        <SkeletonLine width="72%" />
        <SkeletonLine width="88%" />
        <SkeletonLine width="64%" />
      </div>
      <div className={styles.skeletonComposer}><SkeletonLine width="100%" /></div>
    </div>
  );
}

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
 * VERSE_MODEL_UNAVAILABLE when the chat's model cannot run on its seat.
 * Mapping every 409 to "a turn is already running" told the operator to press
 * a Stop that does nothing, with the server's actual reason thrown away.
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
    return err.detail ?? err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

/** The window's width, for the dock's presentation and its 60% cap. */
function useWindowWidth(): number {
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth || 1440));
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth || 1440);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

/** ⌃⌥Space: the composer's message box, focused (C3's `aria-label="Message"`). */
function focusComposer(): void {
  // After the section has painted (the command may be what mounted it).
  requestAnimationFrame(() => {
    const box = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
    box?.focus();
  });
}

/** Is the key event aimed at an overlay that owns its own keys (a dialog, a menu, the palette)? */
function inOverlay(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[role="dialog"], [role="menu"], [role="listbox"], [aria-modal="true"]') !== null;
}

export function ChatSection() {
  const bootstrap = useQuery(verseBootstrapQuery);
  const sessionsQuery = useQuery(verseSessionsQuery);
  const refetchSessions = useRefresh(verseSessionsQuery);
  const refetchBootstrap = useRefresh(verseBootstrapQuery);
  const hold = useMutationHold();
  const toast = useToast();
  const ui = useVerseUi();
  const visible = useSectionVisible();
  const dock = useDock();
  const chatActivity = useChatActivity();
  const windowWidth = useWindowWidth();
  const deleteTitleId = useId();

  const [selectedId, setSelectedIdState] = useState<string | null>(loadSelected);
  const [query, setQuery] = useState('');
  const [newChat, setNewChat] = useState<{ open: boolean; projectPath?: string | null; seat?: SeatChoice | null }>({ open: false });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [tokenPrompt, setTokenPrompt] = useState<{ open: boolean; reason: string }>({ open: false, reason: '' });
  const [handoffFor, setHandoffFor] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<VerseSession | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [chatWidth, setChatWidth] = useState(0);
  const pendingAction = useRef<{ run: () => void; cancel: () => void } | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const panels = useChatPanelSizing();

  const seats = useMemo(() => bootstrap.data?.seats ?? [], [bootstrap.data]);
  const projects = useMemo(() => bootstrap.data?.projects ?? [], [bootstrap.data]);
  // Workspaces come from their own route (live per-root status for the dialog).
  const workspacesQuery = useQuery(verseWorkspacesQuery);
  const workspaces = useMemo(() => workspacesQuery.data?.workspaces ?? [], [workspacesQuery.data]);
  const dispatchEnabled = bootstrap.data?.dispatchEnabled ?? true;

  const view = useVerseSession(selectedId, reload);
  const roots = useSessionRoots(view.session);

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

  // ---- recency + read state -------------------------------------------------
  // Pane requests (a pasted command, a diff to open) belong to the chat they
  // were raised in: switching chats drops them. A SWITCH only — the first run
  // of this effect is the section mounting, and that is exactly when Apps'
  // [Launch ▸] (raised on another surface, which then brings Chat forward)
  // has a terminal request waiting; clearing it here left an empty dock.
  const requestsFor = useRef(selectedId);
  useEffect(() => {
    setVerseActiveSession(selectedId);
    if (requestsFor.current !== selectedId) {
      requestsFor.current = selectedId;
      clearDockRequests();
    }
  }, [selectedId]);

  // Reading a chat — its turns up to now — while this surface is on screen.
  const openTurnCount = view.session?.turnCount ?? null;
  useEffect(() => {
    if (!visible || !selectedId || openTurnCount === null) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    noteSessionSeen(selectedId, openTurnCount);
  }, [visible, selectedId, openTurnCount]);

  // ---- mutation guard ---------------------------------------------------------
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

  // ---- actions ----------------------------------------------------------------
  /**
   * ONE resolution of what "new chat" pre-fills, for every entry point (the
   * sidebar "+", ⌘N, the empty state, the palette's "New chat on…"): an
   * explicit prefill wins, the open session is next, and the per-project
   * seat memory is the floor.
   */
  const openNewChat = useCallback((prefill: { projectPath?: string | null; seat?: SeatChoice | null } = {}) => {
    setCreateError(null);
    const current = view.session;
    const projectPath = prefill.projectPath !== undefined ? prefill.projectPath : current?.projectPath ?? null;
    // The open session's seat only carries forward onto its OWN project.
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
        // The turn may already have settled by the time the 202 is applied;
        // the store checks the log for this turnId before trusting `running`.
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

  const renameChat = useCallback(async (id: string, title: string) => {
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
  }, [withToken, fail]);

  const removeChat = useCallback(async (id: string) => {
    const result = await withToken('Deleting a chat removes its transcript from disk.', async () => {
      try {
        await deleteVerseSession(id);
        forgetVerseSession(id);
        // The transcript is gone from disk; the verbatim prompts must not
        // survive it in browser storage under a dead session id.
        forgetComposerMemory(id);
        if (id === selectedId) setSelectedId(null);
        toast.show('Chat deleted.', 'neutral');
        return true;
      } catch (err) {
        fail(err);
        return false;
      }
    });
    return result === true;
  }, [withToken, fail, setSelectedId, toast, selectedId]);

  const setMeta = useCallback((id: string, update: { pinned?: boolean; archived?: boolean }, reason: string) => {
    void withToken(reason, async () => {
      try {
        await setVerseSessionMeta(id, update);
      } catch (err) {
        fail(err);
      }
    });
  }, [withToken, fail]);

  /** Sessions are seat-bound: a different seat means a new chat on the same project. */
  const changeSeat = useCallback((choice: SeatChoice) => {
    const current = view.session;
    if (!current) return;
    openNewChat({ projectPath: current.projectPath, seat: choice });
    toast.show('Chats are bound to one seat — starting a new chat on the same project.', 'neutral');
  }, [view.session, openNewChat, toast]);

  const requestDelete = useCallback((id: string) => {
    const target = sessions.find((s) => s.id === id) ?? null;
    if (target) setDeleteTarget(target);
  }, [sessions]);

  const startHandoff = useCallback((id: string) => {
    if (id !== selectedId) setSelectedId(id);
    setHandoffFor(id);
  }, [selectedId, setSelectedId]);

  const selectFromList = useCallback((id: string) => {
    setSelectedId(id);
    // At phone width the list floats over the chat; picking a chat closes it.
    if (window.matchMedia?.('(max-width: 760px)')?.matches === true) setVerseSidebarCollapsed(true);
  }, [setSelectedId]);

  // ---- commands: the shell's hand-offs, the bus, and the chat's own keys ------
  const toggleSidebar = useCallback(() => setVerseSidebarCollapsed(!ui.sidebarCollapsed), [ui.sidebarCollapsed]);
  // ⌃` : a terminal, focused — the active tab, else one at the chat's root
  // (TerminalPane resolves an empty request that way). Pressed again while
  // Terminal is on screen it hides it, like every editor's ⌃`.
  const terminalShown = dock.state.open && (dock.state.active === 'terminal' || dock.state.splitWith === 'terminal');
  const openTerminal = useCallback(() => {
    if (terminalShown) toggleDockPane('terminal');
    else requestTerminal({});
  }, [terminalShown]);
  // ⌃⇧` : always a NEW tab, in the active tab's root (else the chat's primary).
  const newTerminalTab = useCallback(() => requestTerminal({ newTab: true }), []);

  // The shell's one-shot command, consumed once by nonce.
  const handledCommand = useRef(0);
  const seatModel = SEAT_MODEL.useLoaded();
  useEffect(() => {
    const command = ui.command;
    if (!command || command.nonce === handledCommand.current) return;
    // "New chat on…" resolves its seat through verse-model, which loads just
    // after first paint: leave the command pending (unconsumed) until it is
    // in — this effect re-runs when it lands.
    if (command.name === 'new-chat' && !seatModel) return;
    handledCommand.current = command.nonce;
    switch (command.name) {
      case 'open-session':
        if (command.sessionId) setSelectedId(command.sessionId);
        break;
      case 'focus-composer':
        focusComposer();
        break;
      case 'new-chat': {
        // "New chat on…" carries a seat (and maybe a project); ⌘N carries neither.
        const { seatById, firstRunnableModel } = seatModel!;
        const seat = command.seatId ? seatById(seats, command.seatId) : undefined;
        // The model this project last used on that seat, else the seat's first runnable one.
        const remembered = lastVerseSeat(command.projectPath ?? null);
        const model = !seat ? undefined : remembered?.seatId === seat.id ? remembered.model : firstRunnableModel(seat)?.id;
        openNewChat({
          ...(command.projectPath !== undefined ? { projectPath: command.projectPath } : {}),
          ...(seat && model ? { seat: { seatId: seat.id, model } } : {}),
        });
        break;
      }
      default:
        // 'quick-switcher' (pre-3.10): ⌘K is the shell's palette now.
        break;
    }
    clearVerseCommand();
  }, [ui.command, openNewChat, seats, setSelectedId, seatModel]);

  // The catalog's chat-scope commands, for the palette, the menu and keys.
  const handlers: ReadonlyArray<[string, () => void | boolean]> = [
    ['chat.sidebar', toggleSidebar],
    ['chat.find', () => requestTranscriptFind()],
    ['chat.turn-prev', () => requestTranscriptStep(-1)],
    ['chat.turn-next', () => requestTranscriptStep(1)],
    ['dock.toggle', toggleDock],
    ['dock.terminal', openTerminal],
    ['dock.terminal-new', newTerminalTab],
    ['dock.preview', () => toggleDockPane('preview')],
    ['dock.diff', () => toggleDockPane('diff')],
  ];
  const handlerMap = new Map(handlers);
  useCommandHandler('chat.sidebar', handlerMap.get('chat.sidebar')!);
  useCommandHandler('chat.find', handlerMap.get('chat.find')!);
  useCommandHandler('chat.turn-prev', handlerMap.get('chat.turn-prev')!);
  useCommandHandler('chat.turn-next', handlerMap.get('chat.turn-next')!);
  useCommandHandler('dock.toggle', handlerMap.get('dock.toggle')!);
  useCommandHandler('dock.terminal', handlerMap.get('dock.terminal')!);
  useCommandHandler('dock.terminal-new', handlerMap.get('dock.terminal-new')!);
  useCommandHandler('dock.preview', handlerMap.get('dock.preview')!);
  useCommandHandler('dock.diff', handlerMap.get('dock.diff')!);

  // Keys, as a fallback: the shell's handler routes catalog keys through the
  // bus and marks the event handled (preventDefault); this listener acts only
  // on an event nobody took, and only while the surface is visible and no
  // overlay (a dialog, a menu, the palette) owns the keyboard. ⌘F and ⌥↑/↓
  // are the transcript's own listeners, which follow the same rule.
  const handlerRef = useRef(handlerMap);
  handlerRef.current = handlerMap;
  useEffect(() => {
    if (!visible) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || inOverlay(event.target)) return;
      const command = matchCommand(event, ['chat']);
      if (!command || command.scope !== 'chat') return;
      if (command.id === 'chat.find' || command.id === 'chat.turn-prev' || command.id === 'chat.turn-next') return;
      const run = handlerRef.current.get(command.id);
      if (!run) return;
      event.preventDefault();
      run();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [visible]);

  const dispatchOff = bootstrap.data ? !bootstrap.data.dispatchEnabled : false;
  const sidebarCollapsed = ui.sidebarCollapsed;

  // ---- layout -------------------------------------------------------------------
  const presentation = dockPresentation(windowWidth);
  const dockOpen = dock.state.open && dock.state.tabs.length > 0;
  const dockColumn = dockOpen && presentation === 'column';
  // The dock yields before the transcript does: never past the window's 60%,
  // and never so wide that the transcript (plus the chat list, when shown at
  // its minimum) drops under its floor. The floor for the dock is its 320px.
  const sidebarFloor = sidebarCollapsed ? 0 : CHAT_PANEL_RANGES.sidebar.min;
  const dockWidth = dockColumn
    ? Math.max(DOCK_LAYOUT.minWidth, Math.min(
      clampDockWidth(dock.state.width, windowWidth),
      chatWidth > 0 ? chatWidth - MIN_TRANSCRIPT_WIDTH - sidebarFloor : Number.POSITIVE_INFINITY,
    ))
    : 0;

  useEffect(() => {
    const node = chatRef.current;
    if (!node) return undefined;
    const measure = () => {
      setChatWidth(node.clientWidth);
      setChatPanelFit({
        // The dock's column is not the sidebar's to spend.
        containerWidth: Math.max(0, node.clientWidth - dockWidth),
        sidebarVisible: !sidebarCollapsed,
        resourcesVisible: false,
      });
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [sidebarCollapsed, dockWidth]);

  const style = {
    '--verse-sidebar-width': `${panels.effective.sidebar}px`,
    '--verse-dock-width': `${dockWidth}px`,
  } as CSSProperties;

  // ---- dock data ------------------------------------------------------------------
  const derive = DERIVATIONS.useLoaded();
  const otherRunning = useMemo(
    () => (derive ? derive.otherRunningChats(sessions, chatActivity.activity, selectedId) : NO_TASKS),
    [derive, sessions, chatActivity.activity, selectedId],
  );
  const turnFiles = useMemo<TurnFileChange[]>(
    () => (derive ? derive.lastTurnFiles(view.events, roots.roots) : NO_TURN_FILES),
    [derive, roots.roots, view.events],
  );

  const actions: SidebarRowActions = {
    setPinned: (id, pinned) => setMeta(id, { pinned }, pinned ? 'Pinning a chat.' : 'Unpinning a chat.'),
    setArchived: (id, archived) => setMeta(id, { archived }, archived ? 'Archiving a chat.' : 'Unarchiving a chat.'),
    rename: renameChat,
    handoff: startHandoff,
    requestDelete,
    dispatchEnabled,
  };

  return (
    <div ref={chatRef} className={styles.chat} style={style}
      data-sidebar={sidebarCollapsed ? 'collapsed' : 'open'} data-dock={dockColumn ? 'open' : 'closed'}>
      <Suspense fallback={<SidebarSkeleton />}>
      <Sidebar sessions={sessions} sessionsStatus={sessionsQuery.status} sessionsError={sessionsQuery.error?.message ?? null}
        projects={projects} seats={seats} selectedId={selectedId} query={query} onQuery={setQuery}
        onSelect={selectFromList} onNew={() => openNewChat()}
        onRetry={() => { refetchSessions(); refetchBootstrap(); }}
        onCollapse={() => setVerseSidebarCollapsed(true)} onDisconnect={() => { void clearReadSession(); }}
        activity={chatActivity.activity} meta={chatActivity.meta} localSeen={chatActivity.localSeen} actions={actions} />
      </Suspense>
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
        <Suspense fallback={<WorkspaceSkeleton />}>
        <Workspace view={view} seats={seats} projects={projects} dispatchEnabled={dispatchEnabled} locked={!hold.hasHold}
          hasAnySessions={sessions.length > 0} onSend={send} onStop={() => stop()}
          onRename={(title) => (selectedId ? renameChat(selectedId, title) : Promise.resolve(false))}
          onRequestDelete={() => { if (selectedId) requestDelete(selectedId); }}
          onSeatChange={changeSeat} onNew={() => openNewChat()} onRetry={() => setReload((n) => n + 1)}
          sidebarCollapsed={sidebarCollapsed} onToggleSidebar={() => setVerseSidebarCollapsed(!sidebarCollapsed)}
          onOpenSession={setSelectedId}
          handoffOpen={handoffFor !== null && handoffFor === selectedId}
          onHandoffOpenChange={(open) => setHandoffFor(open ? selectedId : null)}
          otherRunning={otherRunning} />
        </Suspense>
      </div>
      {dockOpen ? (
        <Suspense fallback={null}>
          <DockHost presentation={presentation} windowWidth={windowWidth} columnWidth={dockWidth} session={view.session} seats={seats}
            events={view.events} roots={roots.roots} rootsData={roots.data} rootsError={roots.error} turnFiles={turnFiles}
            otherRunning={otherRunning} dispatchEnabled={dispatchEnabled} onOpenSession={setSelectedId}
            onHandoff={(id) => setHandoffFor(id)}
            // Accounts & capacity live in Apps & Accounts (C6) since 3.10.
            onOpenAccounts={() => setVerseSection('apps')}
            onSendToChat={(text) => { if (!selectedId || !insertIntoComposer(selectedId, text)) toast.show('Open a chat to send this to it.', 'neutral'); }}
            onAddToMessage={(text) => { if (!selectedId || !insertIntoComposer(selectedId, text)) toast.show('Open a chat to add this to its message.', 'neutral'); }} />
        </Suspense>
      ) : null}

      {newChat.open ? (
        <Suspense fallback={null}>
          <NewChatDialog open onClose={() => setNewChat({ open: false })} projects={projects} seats={seats} workspaces={workspaces}
            initialProjectPath={newChat.projectPath ?? null} initialSeat={newChat.seat ?? null} busy={creating} error={createError} onCreate={create}
            // The dialog's one write of its own (a seat's default context mode)
            // goes through the same token guard as every other chat mutation.
            runMutation={withToken} />
        </Suspense>
      ) : null}
      {/* Closed dialogs render nothing, so a not-yet-loaded one (fallback null) looks the same. */}
      <Suspense fallback={null}>
      <Dialog open={deleteTarget !== null} onClose={() => { if (!deleting) setDeleteTarget(null); }} titleId={deleteTitleId}
        title="Delete this chat?"
        description={deleteTarget ? `“${deleteTarget.title || 'Untitled chat'}” and its transcript are removed from this machine. This cannot be undone.` : undefined}>
        <div className={styles.dialogActions}>
          <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>Keep</Button>
          <Button variant="danger" busy={deleting} onClick={async () => {
            const target = deleteTarget;
            if (!target) return;
            setDeleting(true);
            try {
              await removeChat(target.id);
            } finally {
              setDeleting(false);
              setDeleteTarget(null);
            }
          }}>Delete</Button>
        </div>
      </Dialog>
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
      </Suspense>
    </div>
  );
}
