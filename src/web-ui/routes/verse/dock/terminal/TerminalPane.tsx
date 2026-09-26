/**
 * dock/terminal/TerminalPane.tsx — the chat dock's Terminal (unit C4;
 * SPEC-310C §3). Rendered by C2's Dock through C0's `terminal-pane` slot, so
 * this file (and xterm with it) loads only when a terminal is first opened.
 *
 * WHAT IT IS
 *   - One tab per shell, each a LOGIN shell the sidecar runs on a real PTY
 *     (core/verse/terminal.ts), opened in one of this chat's roots. Tabs
 *     live on the server: a page reload reattaches to them and replays their
 *     scrollback. The tab title follows the shell's own OSC title.
 *   - Header: the working directory, "Send selection to chat" (as a fenced
 *     block), a screen-reader mode, and "Open in Terminal.app".
 *   - Selecting text copies it (the ⌘C you would otherwise type next).
 *   - Under Node (no PTY) the pane says the terminal needs the desktop app
 *     and still offers Terminal.app.
 *
 * WIRING
 *   - Output: ONE live stream, the visible tab's (terminal-stream.ts). A
 *     background tab catches up from its last seq when shown again; the
 *     list poll (every 3 s, only while visible) marks unseen output with a dot.
 *   - Input: keystrokes go through a single-flight queue (input-queue.ts) so
 *     they reach the shell in the order they were typed.
 *   - Keys: xterm owns the keyboard while focused, EXCEPT the app's own
 *     chords (⌘K, ⌘J, ⌘1–5, ⌃`, ⌃Tab …, from command-catalog.ts), which it
 *     passes to the page. ⌃C, ⌃R, Esc and ⌥-word motions stay in the shell.
 *   - Requests from the dock (`request`, one per nonce): focus or open a tab
 *     at a root, force a new one (⌃⇧`), paste a command WITHOUT running it
 *     ("Run in terminal"), launch an app or start a dev server (the server
 *     types that command — built from its own catalog, never from the page).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { VerseTerminalFrame, VerseTerminalListResponse, VerseTerminalTab } from '../../../../data/api-types.js';
import { ApiError } from '../../../../data/client.js';
import { Button, IconButton } from '../../../../components/primitives/Button.js';
import { EmptyState } from '../../../../components/primitives/EmptyState.js';
import { SkeletonLine } from '../../../../components/primitives/Skeleton.js';
import { IconExternalLink, IconPlus, IconSend, IconX } from '../../../../components/primitives/icons.js';
import { asSentence } from '../../autonomy/format.js';
import { ActionMenu, anchorBelow, type MenuAnchor } from '../../chat/ActionMenu.js';
import { detectKeyPlatform, eventKeyName, findCommand, formatChord, matchCommand, type KeyPlatform } from '../../shell/command-catalog.js';
import { usePollWhileVisible, useSectionVisible } from '../../shell/section-visibility.js';
import type { VerseTerminalLaunchVia } from '../../../../../core/verse/workbench-types.js';
import type { TerminalPaneProps } from '../../shell/slots.js';
import type { TerminalRequest } from '../dock-store.js';
import { useViewport } from '../../shell/viewport.js';
import { projectName } from '../../verse-model.js';
import { createInputQueue, type InputQueue } from './input-queue.js';
import { base64ToBytes, fenceSelection, terminalApi, TerminalLockedError, type TerminalApi } from './terminal-client.js';
import { openTerminalStream, type TerminalStreamState } from './terminal-stream.js';
import {
  createXtermView,
  resolveTerminalFont,
  resolveTerminalTheme,
  watchThemeChanges,
  type TerminalView,
  type TerminalViewFactory,
} from './terminal-view.js';
import { ChevronDownGlyph, ScreenReaderGlyph, TerminalGlyph } from './terminal-icons.js';
import chrome from '../pane-chrome.module.css';
import styles from './TerminalPane.module.css';

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

export interface TerminalPaneDeps {
  api: TerminalApi;
  createView: TerminalViewFactory;
  openStream: typeof openTerminalStream;
  platform: KeyPlatform;
  writeClipboard: (text: string) => Promise<void>;
}

const DEFAULT_DEPS: TerminalPaneDeps = {
  api: terminalApi,
  createView: createXtermView,
  openStream: openTerminalStream,
  platform: detectKeyPlatform(),
  writeClipboard: async (text) => {
    await navigator.clipboard.writeText(text);
  },
};

/** How often the tab list is refreshed while the pane is on screen. */
export const TERMINAL_LIST_POLL_MS = 3_000;
const SCREEN_READER_PREF_KEY = 'ashlr.verse.terminal.screenReader';
/** Requests already handled, across remounts (the dock keeps its last request around). */
let lastHandledNonce = 0;

/** Test hygiene. */
export function resetTerminalPaneForTest(): void {
  lastHandledNonce = 0;
}

function readScreenReaderPref(): boolean {
  try {
    return localStorage.getItem(SCREEN_READER_PREF_KEY) === '1';
  } catch {
    return false;
  }
}

function writeScreenReaderPref(on: boolean): void {
  try {
    localStorage.setItem(SCREEN_READER_PREF_KEY, on ? '1' : '0');
  } catch {
    /* storage unavailable: the choice lasts for this page only */
  }
}

/**
 * Keys the PAGE handles even while the terminal has focus: a catalog command
 * whose chord uses ⌘ (macOS), or ⌃` / ⌃Tab. Everything else — ⌃C, ⌃R, Esc,
 * ⌥← — belongs to the shell. Off macOS `mod` is Ctrl, so only Ctrl+Shift
 * chords and ⌃` / ⌃Tab pass (Ctrl+K must still kill a line).
 */
export function keyPassesToPage(event: KeyboardEvent, platform: KeyPlatform): boolean {
  if (event.type !== 'keydown') return false;
  if (!matchCommand(event, ['chat', 'global'], platform)) return false;
  const key = eventKeyName(event);
  const shellChord = event.ctrlKey && (key === '`' || key === 'tab');
  if (platform === 'mac') return event.metaKey || shellChord;
  return shellChord || (event.ctrlKey && event.shiftKey);
}

function errorText(err: unknown, fallback: string): string {
  if (err instanceof TerminalLockedError) return err.message;
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Unlock actions with the mutation token to use the terminal.';
    if (err.detail) return asSentence(err.detail);
  }
  return fallback;
}

interface ViewRecord {
  view: TerminalView;
  host: HTMLDivElement;
  lastSeq: number;
  queue: InputQueue;
  disposers: Array<{ dispose(): void }>;
}

type Notice = { tone: 'error' | 'info'; text: string };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TerminalPane({ sessionId, roots, request, onSendToChat, visible, deps: depsOverride }: TerminalPaneProps & { deps?: Partial<TerminalPaneDeps> }) {
  const deps = useMemo<TerminalPaneDeps>(() => ({ ...DEFAULT_DEPS, ...depsOverride }), [depsOverride]);
  const sectionVisible = useSectionVisible();
  const shown = visible && sectionVisible;
  const compact = useViewport().compact;

  const [list, setList] = useState<VerseTerminalListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [creating, setCreating] = useState(false);
  const [streamState, setStreamState] = useState<TerminalStreamState | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [copied, setCopied] = useState(false);
  const [screenReader, setScreenReader] = useState(readScreenReaderPref);
  const [viewFailed, setViewFailed] = useState(false);
  const [readyIds, setReadyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [rootMenu, setRootMenu] = useState<{ anchor: MenuAnchor; from: HTMLElement } | null>(null);
  const [seen, setSeen] = useState<ReadonlyMap<string, string>>(() => new Map());

  const views = useRef(new Map<string, ViewRecord>());
  const hosts = useRef(new Map<string, HTMLDivElement>());
  const creatingViews = useRef(new Set<string>());
  const autoCreated = useRef(false);
  const pendingPaste = useRef<{ tabId: string; text: string } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  /**
   * True while a shell the operator CLICKED for is opening (New terminal, the
   * folder menu). Any other open — the automatic first one, a dock request —
   * shows the pane opening instead of "No terminal open"; a click keeps the
   * empty state (and the focused, busy button) where it is.
   */
  const manualOpen = useRef(false);

  const allTabs = useMemo(() => list?.tabs ?? [], [list]);
  const exitedIds = useRef(new Set<string>());
  exitedIds.current = new Set(allTabs.filter((t) => t.exited).map((t) => t.id));
  const tabs = useMemo(() => allTabs.filter((t) => t.sessionId === sessionId), [allTabs, sessionId]);
  const active = tabs.find((t) => t.id === activeId) ?? null;
  const otherChats = allTabs.length - tabs.length;

  // -------------------------------------------------------------------------
  // The tab list
  // -------------------------------------------------------------------------

  const refresh = useCallback(async () => {
    try {
      const next = await deps.api.list();
      if (!mounted.current) return;
      setList(next);
      setLoadError(null);
    } catch (err) {
      if (!mounted.current) return;
      setLoadError(errorText(err, 'The terminal list could not be loaded.'));
    }
  }, [deps.api]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; };
  }, [refresh]);

  usePollWhileVisible(() => { void refresh(); }, TERMINAL_LIST_POLL_MS, { enabled: visible });

  // Keep the active tab valid: the first of this chat's tabs when it vanished.
  useEffect(() => {
    if (!list) return;
    if (activeId && tabs.some((t) => t.id === activeId)) return;
    setActiveId(tabs.at(-1)?.id ?? null);
  }, [list, tabs, activeId]);

  // Forget views of tabs that no longer exist (killed elsewhere, idle-closed).
  useEffect(() => {
    if (!list) return;
    const live = new Set(list.tabs.map((t) => t.id));
    for (const [id, rec] of views.current) {
      if (live.has(id)) continue;
      disposeRecord(rec);
      views.current.delete(id);
      setReadyIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  }, [list]);

  // The active tab's output is seen as it arrives.
  useEffect(() => {
    if (!active || !shown) return;
    setSeen((prev) => (prev.get(active.id) === active.lastActivityAt ? prev : new Map(prev).set(active.id, active.lastActivityAt)));
  }, [active, shown]);

  // Dispose everything on unmount (the SERVER keeps the shells).
  useEffect(() => () => {
    for (const rec of views.current.values()) disposeRecord(rec);
    views.current.clear();
    for (const t of [resizeTimer, copyTimer, selectionTimer]) if (t.current) clearTimeout(t.current);
  }, []);

  function disposeRecord(rec: ViewRecord): void {
    rec.queue.dispose();
    for (const d of rec.disposers) {
      try { d.dispose(); } catch { /* already gone */ }
    }
    try { rec.view.dispose(); } catch { /* already gone */ }
  }

  // -------------------------------------------------------------------------
  // Creating, closing, restarting tabs
  // -------------------------------------------------------------------------

  const sizeHint = useCallback((): { cols: number; rows: number } => {
    for (const rec of views.current.values()) {
      if (rec.view.cols > 1 && rec.view.rows > 1) return { cols: rec.view.cols, rows: rec.view.rows };
    }
    return { cols: 80, rows: 24 };
  }, []);

  const createTab = useCallback(async (opts: { root?: string; appId?: string; via?: VerseTerminalLaunchVia; model?: string; devServerId?: string } = {}): Promise<VerseTerminalTab | null> => {
    setCreating(true);
    setNotice(null);
    try {
      const tab = await deps.api.create({
        sessionId,
        ...(opts.root ? { root: opts.root } : {}),
        ...(opts.appId ? { appId: opts.appId } : {}),
        // How the app launches (Ollama, a local model): only with an app — the server refuses them alone.
        ...(opts.appId && opts.via ? { via: opts.via } : {}),
        ...(opts.appId && opts.model ? { model: opts.model } : {}),
        ...(opts.devServerId ? { devServerId: opts.devServerId } : {}),
        ...sizeHint(),
      });
      if (!mounted.current) return tab;
      setList((prev) => (prev ? { ...prev, tabs: [...prev.tabs.filter((t) => t.id !== tab.id), tab] } : prev));
      setActiveId(tab.id);
      return tab;
    } catch (err) {
      if (mounted.current) setNotice({ tone: 'error', text: errorText(err, 'The terminal could not be opened.') });
      return null;
    } finally {
      if (mounted.current) setCreating(false);
    }
  }, [deps.api, sessionId, sizeHint]);

  const closeTab = useCallback(async (tab: VerseTerminalTab) => {
    try {
      await deps.api.kill(tab.id);
    } catch (err) {
      // Already gone on the server is as good as closed.
      if (!(err instanceof ApiError && err.status === 404)) {
        setNotice({ tone: 'error', text: errorText(err, 'The terminal could not be closed.') });
        return;
      }
    }
    const rec = views.current.get(tab.id);
    if (rec) {
      disposeRecord(rec);
      views.current.delete(tab.id);
    }
    setList((prev) => (prev ? { ...prev, tabs: prev.tabs.filter((t) => t.id !== tab.id) } : prev));
    if (activeId === tab.id) {
      const index = tabs.findIndex((t) => t.id === tab.id);
      const neighbour = tabs[index + 1] ?? tabs[index - 1] ?? null;
      setActiveId(neighbour?.id ?? null);
    }
  }, [activeId, deps.api, tabs]);

  const restartTab = useCallback(async (tab: VerseTerminalTab) => {
    const next = await createTab({ root: tab.root });
    if (next) await closeTab(tab);
  }, [closeTab, createTab]);

  // Another chat (the dock keeps this pane mounted across chats): its own
  // first look may open a shell again.
  const autoCreatedFor = useRef(sessionId);
  if (autoCreatedFor.current !== sessionId) {
    autoCreatedFor.current = sessionId;
    autoCreated.current = false;
  }

  // First look at an empty pane: open a shell in the chat's primary root.
  useEffect(() => {
    if (!list || !list.available || !shown || autoCreated.current || creating) return;
    if (request && request.nonce > lastHandledNonce) return; // the request decides
    autoCreated.current = true;
    if (tabs.length === 0) void createTab({});
  }, [list, shown, tabs.length, creating, createTab, request]);

  // -------------------------------------------------------------------------
  // Views (xterm) — one per tab, created when its panel mounts
  // -------------------------------------------------------------------------

  const attachView = useCallback(async (tabId: string, host: HTMLDivElement) => {
    if (views.current.has(tabId) || creatingViews.current.has(tabId)) return;
    creatingViews.current.add(tabId);
    try {
      const view = await deps.createView({ ...resolveTerminalFont(host), theme: resolveTerminalTheme(host), screenReaderMode: readScreenReaderPref() });
      if (!mounted.current || !hosts.current.has(tabId)) {
        view.dispose();
        return;
      }
      view.open(host);
      const queue = createInputQueue((b64) => deps.api.input(tabId, b64), {
        onError: (err) => {
          if (mounted.current) setNotice({ tone: 'error', text: errorText(err, 'That input did not reach the shell.') });
        },
      });
      const rec: ViewRecord = { view, host, lastSeq: 0, queue, disposers: [] };
      // Keystrokes into a shell that has exited go nowhere (the exit bar offers Restart).
      rec.disposers.push(view.onData((data) => { if (!exitedIds.current.has(tabId)) queue.pushText(data); }));
      rec.disposers.push(view.onBinary((data) => { if (!exitedIds.current.has(tabId)) queue.pushBinary(data); }));
      rec.disposers.push(view.onSelectionChange(() => {
        const selected = view.hasSelection();
        setHasSelection(selected);
        if (!selected) return;
        // Copy on select, once the drag settles.
        if (selectionTimer.current) clearTimeout(selectionTimer.current);
        selectionTimer.current = setTimeout(() => {
          const text = view.getSelection();
          if (!text) return;
          deps.writeClipboard(text).then(() => {
            if (!mounted.current) return;
            setCopied(true);
            if (copyTimer.current) clearTimeout(copyTimer.current);
            copyTimer.current = setTimeout(() => setCopied(false), 1_200);
          }, () => { /* clipboard refused (no user gesture): the selection still works with ⌘C */ });
        }, 150);
      }));
      view.setKeyFilter((event) => !keyPassesToPage(event, deps.platform));
      views.current.set(tabId, rec);
      setViewFailed(false);
      setReadyIds((prev) => new Set(prev).add(tabId));
    } catch (err) {
      console.error('[verse] terminal view failed to load', err);
      if (mounted.current) setViewFailed(true);
    } finally {
      creatingViews.current.delete(tabId);
    }
  }, [deps]);

  // One stable ref callback per tab: a fresh closure each render would make
  // React detach and re-attach the host on every render.
  const attachRef = useRef(attachView);
  attachRef.current = attachView;
  const hostRefs = useRef(new Map<string, (node: HTMLDivElement | null) => void>());
  const hostRef = (tabId: string) => {
    let ref = hostRefs.current.get(tabId);
    if (!ref) {
      ref = (node) => {
        if (node) {
          hosts.current.set(tabId, node);
          void attachRef.current(tabId, node);
        } else {
          hosts.current.delete(tabId);
          hostRefs.current.delete(tabId);
        }
      };
      hostRefs.current.set(tabId, ref);
    }
    return ref;
  };

  // Fit the visible view to its panel and tell the shell its size.
  const fitActive = useCallback(() => {
    if (!activeId) return;
    const rec = views.current.get(activeId);
    if (!rec) return;
    const before = { cols: rec.view.cols, rows: rec.view.rows };
    const size = rec.view.fit();
    if (!size || (size.cols === before.cols && size.rows === before.rows && active && active.cols === size.cols && active.rows === size.rows)) return;
    if (resizeTimer.current) clearTimeout(resizeTimer.current);
    const id = activeId;
    resizeTimer.current = setTimeout(() => {
      deps.api.resize(id, size.cols, size.rows).catch(() => { /* the next fit retries */ });
    }, 100);
  }, [active, activeId, deps.api]);

  useEffect(() => {
    if (!shown || !activeId || !readyIds.has(activeId)) return;
    fitActive();
    const body = bodyRef.current;
    if (!body || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fitActive);
    });
    observer.observe(body);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [shown, activeId, readyIds, fitActive]);

  // Theme follows the app (explicit toggle or OS appearance).
  useEffect(() => watchThemeChanges(() => {
    for (const rec of views.current.values()) rec.view.setTheme(resolveTerminalTheme(rec.host));
  }), []);

  // -------------------------------------------------------------------------
  // The live stream (visible tab only)
  // -------------------------------------------------------------------------

  const applyPaste = useCallback((tabId: string) => {
    const pending = pendingPaste.current;
    if (!pending || pending.tabId !== tabId) return;
    const rec = views.current.get(tabId);
    if (!rec) return;
    pendingPaste.current = null;
    const text = pending.text.replace(/[\r\n]+$/, '');
    if (text.includes('\n') && !rec.view.bracketedPaste()) {
      // Without bracketed paste a shell would RUN each line as it arrives.
      deps.writeClipboard(text).then(
        () => setNotice({ tone: 'info', text: 'That command has several lines, so it was copied instead: paste it with ⌘V.' }),
        () => setNotice({ tone: 'error', text: 'That command has several lines and could not be pasted safely.' }),
      );
    } else {
      rec.view.paste(text);
    }
    rec.view.focus();
  }, [deps]);

  useEffect(() => {
    if (!shown || !activeId || !readyIds.has(activeId)) {
      setStreamState(null);
      return;
    }
    const rec = views.current.get(activeId);
    if (!rec) return;
    const tabId = activeId;
    let firstOutput = true;
    const onFrame = (frame: VerseTerminalFrame) => {
      if (frame.type === 'output') {
        if (frame.seq <= rec.lastSeq) return;
        // A gap means the scrollback ring dropped frames this view never got:
        // start over from what the server still has rather than draw a torn screen.
        if (rec.lastSeq > 0 && frame.seq > rec.lastSeq + 1) rec.view.reset();
        rec.view.write(base64ToBytes(frame.dataBase64));
        rec.lastSeq = frame.seq;
        if (firstOutput) {
          firstOutput = false;
          if (pendingPaste.current?.tabId === tabId) setTimeout(() => applyPaste(tabId), 120);
        }
        return;
      }
      setList((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          tabs: prev.tabs.map((t) => {
            if (t.id !== tabId) return t;
            if (frame.type === 'title') return t.title === frame.title ? t : { ...t, title: frame.title };
            return { ...t, exited: { code: frame.code, signal: frame.signal, at: new Date().toISOString() } };
          }),
        };
      });
    };
    const stream = deps.openStream(tabId, () => rec.lastSeq, {
      onFrame,
      onState: (state) => {
        if (!mounted.current) return;
        setStreamState(state);
        if (state === 'gone') void refresh();
      },
    });
    // An existing tab that already has output can take a paste right away.
    if (pendingPaste.current?.tabId === tabId && rec.lastSeq > 0) setTimeout(() => applyPaste(tabId), 0);
    return () => stream.close();
  }, [shown, activeId, readyIds, deps, refresh, applyPaste]);

  // -------------------------------------------------------------------------
  // Requests from the dock
  // -------------------------------------------------------------------------

  const handleRequest = useCallback(async (req: TerminalRequest) => {
    const root = req.root ?? active?.root ?? roots[0];
    const wantsNew = req.newTab === true || Boolean(req.appId) || Boolean(req.devServerId);
    let target: VerseTerminalTab | null = null;
    if (!wantsNew) {
      target = (active && !active.exited && (!req.root || active.root === req.root) ? active : null)
        ?? tabs.find((t) => !t.exited && (!req.root || t.root === req.root)) ?? null;
    }
    if (target) {
      setActiveId(target.id);
    } else {
      target = await createTab({
        ...(root ? { root } : {}),
        ...(req.appId ? { appId: req.appId } : {}),
        ...(req.via ? { via: req.via } : {}),
        ...(req.model ? { model: req.model } : {}),
        ...(req.devServerId ? { devServerId: req.devServerId } : {}),
      });
    }
    if (!target) return;
    if (req.paste) {
      pendingPaste.current = { tabId: target.id, text: req.paste };
      const rec = views.current.get(target.id);
      if (rec && rec.lastSeq > 0) applyPaste(target.id);
    } else {
      views.current.get(target.id)?.view.focus();
    }
  }, [active, applyPaste, createTab, roots, tabs]);

  useEffect(() => {
    if (!request || !list || request.nonce <= lastHandledNonce) return;
    lastHandledNonce = request.nonce;
    autoCreated.current = true;
    if (!list.available) return;
    void handleRequest(request);
  }, [request, list, handleRequest]);

  // Focus the terminal when its tab becomes the visible one.
  useEffect(() => {
    if (!shown || !activeId || !readyIds.has(activeId)) return;
    views.current.get(activeId)?.view.focus();
  }, [shown, activeId, readyIds]);

  // -------------------------------------------------------------------------
  // Header actions
  // -------------------------------------------------------------------------

  const sendSelection = () => {
    if (!activeId) return;
    const text = views.current.get(activeId)?.view.getSelection() ?? '';
    if (!text.trim()) return;
    onSendToChat(fenceSelection(text));
  };

  const toggleScreenReader = () => {
    const next = !screenReader;
    setScreenReader(next);
    writeScreenReaderPref(next);
    for (const rec of views.current.values()) rec.view.setScreenReaderMode(next);
  };

  const openExternal = async () => {
    try {
      await deps.api.openExternal(sessionId, active?.root ?? roots[0]);
      setNotice({ tone: 'info', text: 'Opened in Terminal.' });
    } catch (err) {
      setNotice({ tone: 'error', text: errorText(err, 'Terminal could not be opened.') });
    }
  };

  const openByClick = (opts: { root?: string }) => {
    manualOpen.current = true;
    void createTab(opts).finally(() => { manualOpen.current = false; });
  };

  const onNewTabClick = () => {
    openByClick(active?.root ? { root: active.root } : {});
  };

  // Tabs: ←/→ move and activate, Home/End jump (WAI-ARIA tabs, automatic activation).
  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    const tab = tabs[next]!;
    setActiveId(tab.id);
    tabRefs.current.get(tab.id)?.focus();
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (!list) {
    if (loadError) {
      return (
        <div className={styles.pane}>
          <EmptyState compact tone="error" title="Terminal is not reachable" body={loadError}
            action={<Button size="sm" variant="subtle" onClick={() => void refresh()}>Try again</Button>} />
        </div>
      );
    }
    return (
      <div className={styles.pane} aria-busy="true">
        {/* The strip's row is held from the first frame so the chrome does not drop in under the dock's tabs. */}
        <div className={styles.strip} aria-hidden="true" />
        <div className={styles.loading}>
          <SkeletonLine width="40%" />
          <SkeletonLine width="70%" />
        </div>
      </div>
    );
  }

  if (!list.available) {
    return (
      <div className={styles.pane}>
        <EmptyState
          compact
          icon={<TerminalGlyph size={20} />}
          title="Terminal needs the desktop app"
          body="This Verse server has no built-in terminal. Open the project in Terminal instead, or use the Ashlr desktop app."
          action={deps.platform === 'mac' ? (
            <Button size="sm" variant="subtle" icon={<IconExternalLink />} onClick={() => void openExternal()}>Open in Terminal</Button>
          ) : undefined}
        />
        {notice ? <p className={styles.inlineNotice} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p> : null}
      </div>
    );
  }

  const canChooseRoot = roots.length > 1;
  const newTabChord = findCommand('dock.terminal-new')?.keys[0];
  const newTabKey = newTabChord ? formatChord(newTabChord, deps.platform) : null;
  // Before a chat's first shell is open — the automatic one on first sight,
  // or one a dock request asked for — the pane shows it opening instead of
  // flashing "No terminal open" for the moment the request takes.
  const opening = tabs.length === 0 && !viewFailed && (!autoCreated.current || (creating && !manualOpen.current));
  // The folder the header names: the visible tab's (or, for the render before
  // the active tab is chosen, the one that will be), or while the first shell
  // opens the chat's primary folder, where it opens — so the row does not
  // appear, or change, when the tab lands.
  const headerRoot = active?.root ?? tabs.at(-1)?.root ?? (opening ? roots[0] ?? null : null);

  return (
    <div className={styles.pane} data-compact={compact || undefined}>
      <div className={styles.strip}>
        <div className={styles.tabs} role="tablist" aria-label="Terminals">
          {tabs.map((tab, index) => {
            const selected = tab.id === activeId;
            const unseen = !selected && (seen.get(tab.id) ?? tab.createdAt) < tab.lastActivityAt;
            return (
              <div key={tab.id} className={styles.tab} data-selected={selected || undefined} role="presentation">
                <button
                  ref={(node) => { if (node) tabRefs.current.set(tab.id, node); else tabRefs.current.delete(tab.id); }}
                  type="button"
                  role="tab"
                  id={`terminal-tab-${tab.id}`}
                  aria-selected={selected}
                  aria-controls={`terminal-panel-${tab.id}`}
                  tabIndex={selected ? 0 : -1}
                  className={styles.tabButton}
                  title={`${tab.title} — ${tab.root}`}
                  onClick={() => setActiveId(tab.id)}
                  onKeyDown={(event) => onTabKeyDown(event, index)}
                >
                  <span className={styles.tabTitle}>{tab.title}</span>
                  {tab.exited ? <span className={styles.tabExited}>exited</span> : null}
                  {unseen && !tab.exited ? <span className={styles.unseen} aria-label="new output" role="img" /> : null}
                </button>
                <button type="button" className={styles.tabClose} aria-label={`Close terminal ${tab.title}`}
                  title="Close terminal" onClick={() => void closeTab(tab)}>
                  <IconX size={12} />
                </button>
              </div>
            );
          })}
        </div>
        <div className={styles.stripActions}>
          <IconButton variant="ghost" size="sm" icon={<IconPlus />} aria-label="New terminal tab"
            title={newTabKey ? `New terminal tab (${newTabKey})` : 'New terminal tab'}
            busy={creating} onClick={onNewTabClick} />
          {canChooseRoot ? (
            <IconButton variant="ghost" size="sm" icon={<ChevronDownGlyph />} aria-label="New terminal in…" aria-haspopup="menu"
              aria-expanded={rootMenu !== null} title="Choose the folder"
              onClick={(event) => setRootMenu({ anchor: anchorBelow(event.currentTarget), from: event.currentTarget })} />
          ) : null}
        </div>
      </div>

      {headerRoot !== null ? (
        <div className={`${chrome.header} ${styles.header}`}>
          {/* The folder's NAME; the full path (a home or temp path) is the tooltip. */}
          <span className={`${chrome.title} ${styles.cwd}`} title={headerRoot}>{projectName(headerRoot)}</span>
          <span className={styles.headerStatus} role="status" aria-live="polite">
            {streamState === 'reconnecting' ? 'Reconnecting…' : streamState === 'expired' ? 'Session expired — reload to reconnect' : copied ? 'Copied' : ''}
          </span>
          <div className={chrome.actions}>
            <Button variant="ghost" size="sm" icon={<IconSend />} disabled={!hasSelection} aria-label="Send selection to chat"
              title={hasSelection ? 'Send the selected text to the chat as a code block' : 'Select text in the terminal first'}
              onClick={sendSelection}>
              {compact ? null : 'Send to chat'}
            </Button>
            <IconButton variant="ghost" size="sm" icon={<ScreenReaderGlyph />} aria-label="Screen reader mode" aria-pressed={screenReader}
              title={screenReader ? 'Screen reader mode is on' : 'Screen reader mode'} onClick={toggleScreenReader} />
            {deps.platform === 'mac' ? (
              <IconButton variant="ghost" size="sm" icon={<IconExternalLink />} aria-label="Open in Terminal.app"
                title="Open this folder in Terminal.app" onClick={() => void openExternal()} />
            ) : null}
          </div>
        </div>
      ) : null}

      {notice ? (
        <div className={styles.notice} data-tone={notice.tone} role={notice.tone === 'error' ? 'alert' : 'status'}>
          <span>{notice.text}</span>
          <button type="button" className={styles.noticeClose} aria-label="Dismiss" title="Dismiss" onClick={() => setNotice(null)}>
            <IconX size={12} />
          </button>
        </div>
      ) : null}

      <div className={styles.body} ref={bodyRef}>
        {viewFailed ? (
          <EmptyState compact tone="error" title="The terminal could not load" body="The rest of the chat still works."
            action={<Button size="sm" variant="subtle" onClick={() => {
              setViewFailed(false);
              for (const [id, host] of hosts.current) void attachView(id, host);
            }}>Try again</Button>} />
        ) : null}
        {opening ? (
          <div className={styles.loading} role="status" aria-label="Opening a shell">
            <SkeletonLine width="30%" />
          </div>
        ) : null}
        {tabs.length === 0 && !viewFailed && !opening ? (
          <EmptyState compact icon={<TerminalGlyph size={20} />} title="No terminal open"
            body={`Click New terminal${newTabKey ? ` or press ${newTabKey}` : ''} to open a login shell in this chat's folder.${otherChats > 0 ? ` ${otherChats} ${otherChats === 1 ? 'terminal is' : 'terminals are'} open in other chats.` : ''}`}
            action={<Button size="sm" variant="subtle" icon={<IconPlus />} busy={creating} onClick={onNewTabClick}>New terminal</Button>} />
        ) : null}
        {tabs.map((tab) => {
          const selected = tab.id === activeId;
          return (
            <div
              key={tab.id}
              id={`terminal-panel-${tab.id}`}
              role="tabpanel"
              aria-labelledby={`terminal-tab-${tab.id}`}
              className={styles.panel}
              hidden={!selected}
            >
              <div className={styles.viewport}>
                <div className={styles.host} ref={hostRef(tab.id)} data-testid={`terminal-host-${tab.id}`} />
                {!readyIds.has(tab.id) && !viewFailed ? (
                  <div className={styles.viewLoading} aria-hidden="true"><SkeletonLine width="30%" /></div>
                ) : null}
              </div>
              {tab.exited ? (
                <div className={styles.exitBar} role="status">
                  <span>
                    {tab.exited.signal && tab.exited.code === null
                      ? `Shell ended (${tab.exited.signal}).`
                      : `Shell exited${tab.exited.code === null ? '' : ` with code ${tab.exited.code}`}.`}
                  </span>
                  <Button size="sm" variant="subtle" onClick={() => void restartTab(tab)}>Restart</Button>
                  <Button size="sm" variant="ghost" onClick={() => void closeTab(tab)}>Close</Button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {rootMenu ? (
        <ActionMenu
          label="New terminal in"
          anchor={rootMenu.anchor}
          returnFocus={rootMenu.from}
          onClose={() => setRootMenu(null)}
          items={roots.map((root) => ({
            id: root,
            label: projectName(root),
            description: root,
            onSelect: () => { openByClick({ root }); },
          }))}
        />
      ) : null}
    </div>
  );
}
