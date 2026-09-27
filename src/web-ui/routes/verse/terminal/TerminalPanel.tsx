/**
 * terminal/TerminalPanel.tsx — the Verse terminal (3.15): a Warp-grade
 * terminal the operator and the agents share.
 *
 * WHAT IT IS
 *   - Tabs, each one shell or a SPLIT of two (⌘D right, ⌥⌘D down), laid out
 *     per chat and restored after a reload — the shells themselves live on
 *     the server (core/verse/terminal.ts) and are reattached, scrollback and
 *     command blocks included.
 *   - Each shell: xterm.js on WebGL (DOM fallback), true colour, Unicode 11,
 *     ligatures, ⌘F find, ⌘-click links (URLs, and `file:line` into the
 *     editor), copy on select, 10k lines of scrollback.
 *   - COMMAND BLOCKS (shell integration, OSC 133): every command is a block —
 *     command, duration, exit code, output that folds. A dot beside each
 *     command in the terminal, ⌘↑/⌘↓ between them, and a Blocks view (⇧⌘K)
 *     with Copy output / Send to chat / Explain & fix.
 *   - The AGENT tab: the commands this chat's agents ran, read-only, from the
 *     transcript's own tool events. Nothing is re-run.
 *   - Everything sent to a chat — a block, a selection — goes through the
 *     server's secret scrub first (format=chat, /redact).
 *
 * CONTRACT. `TerminalPanelProps` below is the whole interface; it is a
 * superset of the dock's 3.10 `TerminalPaneProps`, so the adapter
 * (./TerminalPane.tsx) maps one onto the other and the pane registry (or the
 * dock's slot) mounts it lazily. This file is never imported statically from
 * the chat's first-paint path (terminal-lazy.test.ts).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { VerseTerminalStreamFrame, VerseTerminalListResponse, VerseTerminalTab } from '../../../data/api-types.js';
import { ApiError } from '../../../data/client.js';
import { Button, IconButton } from '../../../components/primitives/Button.js';
import { EmptyState } from '../../../components/primitives/EmptyState.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { IconExternalLink, IconPlus, IconSearch, IconSend, IconX } from '../../../components/primitives/icons.js';
import { asSentence } from '../autonomy/format.js';
import { ActionMenu, anchorBelow, type ActionMenuItem, type MenuAnchor } from '../chat/ActionMenu.js';
import { cleanTerminalOutput } from '../chat/ansi.js';
import { detectKeyPlatform } from '../shell/command-keys.js';
import { usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { useViewport } from '../shell/viewport.js';
import { projectName } from '../verse-model.js';
import type { VerseTerminalLaunchVia } from '../../../../core/verse/workbench-types.js';
import { TerminalLockedError } from '../dock/terminal/terminal-client.js';
import { openPanelStream, type TerminalStreamState } from './panel-stream.js';
import { ChevronDownGlyph, TerminalGlyph } from '../dock/terminal/terminal-icons.js';
import { AgentTerminal } from './AgentTerminal.js';
import type { BlockAction } from './BlockList.js';
import { blockChatText, fenceFor, type BlockView, type ChatIntent } from './blocks-model.js';
import {
  addGroup,
  AGENT_GROUP_ID,
  focusPane,
  loadLayout,
  MAX_PANES_PER_GROUP,
  reconcileLayout,
  removePane,
  saveLayout,
  setMode,
  splitGroup,
  type LeafMode,
  type SplitDirection,
  type TerminalGroup,
  type TerminalLayout,
} from './layout-model.js';
import { panelTerminalApi, type PanelTerminalApi } from './panel-client.js';
import { panelKeyLabel, type PanelKeyAction } from './panel-keys.js';
import { TerminalLeaf, type LeafDeps, type LeafHandle, type LeafNotice, type LeafPrefs } from './TerminalLeaf.js';
import { createPanelXtermView, type PanelViewFactory } from './xterm-view.js';
import styles from './TerminalPanel.module.css';

// ===========================================================================
// Contract
// ===========================================================================

/** Open a terminal: focus/open a tab at `root`, optionally pasting (NEVER running) a command. Same shape as the dock's. */
export interface TerminalPanelRequest {
  /** Changes on every request, so the same request twice is two opens. */
  nonce: number;
  root?: string;
  /** Force a new tab (⌃⇧`). */
  newTab?: boolean;
  /** Pasted at the prompt — the operator presses Enter. */
  paste?: string;
  /** Apps [Launch ▸]: the catalog agent to start in a new tab (the server builds the command). */
  appId?: string;
  via?: VerseTerminalLaunchVia;
  model?: string;
  /** Preview's dev-server Start. */
  devServerId?: string;
  /** 3.15: show the Agent tab (e.g. from a transcript command's "Show in terminal"). */
  agent?: boolean;
}

export interface TerminalPanelProps {
  /** The chat this panel belongs to: its tabs, layout and Agent tab. */
  sessionId: string;
  /** The chat's folders, primary first. */
  roots: readonly string[];
  request: TerminalPanelRequest | null;
  /** Draft text into the chat's composer (the operator sends it). Text arrives scrubbed of secrets. */
  onSendToChat: (text: string) => void;
  /**
   * Send text to the chat's seat as a turn ("Explain / fix this error").
   * Optional: without it the text is drafted with onSendToChat instead.
   */
  onAskChat?: (text: string) => void;
  /** False while the panel is a background tab — stop timers, skip work. */
  visible: boolean;
  /** Test / host seams. */
  deps?: Partial<TerminalPanelDeps>;
}

export interface TerminalPanelDeps extends LeafDeps {
  api: PanelTerminalApi;
  createView: PanelViewFactory;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const DEFAULT_DEPS: TerminalPanelDeps = {
  api: panelTerminalApi,
  createView: createPanelXtermView,
  openStream: openPanelStream,
  platform: detectKeyPlatform(),
  writeClipboard: async (text) => { await navigator.clipboard.writeText(text); },
  openUrl: (url) => {
    // Only web URLs leave the app; anything else (file:, javascript:) is ignored.
    if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
  },
  storage: safeLocalStorage(),
};

export const TERMINAL_PANEL_LIST_POLL_MS = 3_000;
const PREFS_KEY = 'ashlr.verse.terminal.prefs.v1';
/** Shared with the 3.10 pane, so the choice carries over. */
const SCREEN_READER_KEY = 'ashlr.verse.terminal.screenReader';

let lastHandledNonce = 0;
export function resetTerminalPanelForTest(): void {
  lastHandledNonce = 0;
}

function readPrefs(storage: TerminalPanelDeps['storage']): LeafPrefs {
  const prefs: LeafPrefs = { screenReader: false, ligatures: true, gpu: true };
  try {
    const raw = storage?.getItem(PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LeafPrefs>;
      if (typeof parsed.ligatures === 'boolean') prefs.ligatures = parsed.ligatures;
      if (typeof parsed.gpu === 'boolean') prefs.gpu = parsed.gpu;
    }
    prefs.screenReader = storage?.getItem(SCREEN_READER_KEY) === '1';
  } catch {
    /* defaults */
  }
  return prefs;
}

function writePrefs(storage: TerminalPanelDeps['storage'], prefs: LeafPrefs): void {
  try {
    storage?.setItem(PREFS_KEY, JSON.stringify({ ligatures: prefs.ligatures, gpu: prefs.gpu }));
    storage?.setItem(SCREEN_READER_KEY, prefs.screenReader ? '1' : '0');
  } catch {
    /* this page only */
  }
}

function errorText(err: unknown, fallback: string): string {
  if (err instanceof TerminalLockedError) return err.message;
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Unlock actions with the mutation token to use the terminal.';
    if (err.detail) return asSentence(err.detail);
  }
  return fallback;
}

type OpenOptions = { root?: string; cwd?: string; appId?: string; via?: VerseTerminalLaunchVia; model?: string; devServerId?: string; size?: { cols: number; rows: number } };

// ===========================================================================
// Component
// ===========================================================================

export function TerminalPanel({ sessionId, roots, request, onSendToChat, onAskChat, visible, deps: override }: TerminalPanelProps) {
  const deps = useMemo<TerminalPanelDeps>(() => ({ ...DEFAULT_DEPS, ...override }), [override]);
  const sectionVisible = useSectionVisible();
  const shown = visible && sectionVisible;
  const compact = useViewport().compact;

  const [list, setList] = useState<VerseTerminalListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [layout, setLayout] = useState<TerminalLayout>(() => loadLayout(sessionId, deps.storage));
  const [notice, setNotice] = useState<LeafNotice | null>(null);
  const [creating, setCreating] = useState(false);
  const [streamStates, setStreamStates] = useState<ReadonlyMap<string, TerminalStreamState>>(() => new Map());
  const [selection, setSelection] = useState<{ tabId: string; text: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<LeafPrefs>(() => readPrefs(deps.storage));
  const [menu, setMenu] = useState<{ kind: 'root' | 'more' | 'block'; anchor: MenuAnchor; from: HTMLElement | null; items: ActionMenuItem[]; label: string } | null>(null);
  const [seen, setSeen] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [agentHighlight, setAgentHighlight] = useState<string | null>(null);
  const [pasteTick, setPasteTick] = useState(0);

  const leaves = useRef(new Map<string, LeafHandle>());
  const leafRefs = useRef(new Map<string, (handle: LeafHandle | null) => void>());
  const mounted = useRef(true);
  const autoCreated = useRef(false);
  const pendingPaste = useRef<{ tabId: string; text: string } | null>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  // Another chat (the dock keeps the panel mounted across chats): its own layout.
  const layoutFor = useRef(sessionId);
  if (layoutFor.current !== sessionId) {
    layoutFor.current = sessionId;
    autoCreated.current = false;
  }
  useEffect(() => {
    setLayout(loadLayout(sessionId, deps.storage));
  }, [sessionId, deps.storage]);

  const allTabs = useMemo(() => list?.tabs ?? [], [list]);
  const tabs = useMemo(() => allTabs.filter((t) => t.sessionId === sessionId), [allTabs, sessionId]);
  const tabById = useMemo(() => new Map(tabs.map((t) => [t.id, t])), [tabs]);
  const tabIdsKey = tabs.map((t) => t.id).join(',');

  // Fit the layout to the shells that exist (and persist it).
  useEffect(() => {
    if (!list) return;
    setLayout((prev) => reconcileLayout(prev, tabIdsKey ? tabIdsKey.split(',') : []));
  }, [list, tabIdsKey]);
  useEffect(() => {
    if (list) saveLayout(sessionId, layout, deps.storage);
  }, [layout, list, sessionId, deps.storage]);

  const activeGroup: TerminalGroup | null = layout.active === AGENT_GROUP_ID ? null : layout.groups.find((g) => g.id === layout.active) ?? null;
  const agentActive = layout.active === AGENT_GROUP_ID || (list !== null && !list.available && layout.groups.length === 0);
  const focusedTab = activeGroup ? tabById.get(activeGroup.focused) ?? null : null;
  const focusedMode: LeafMode = focusedTab ? layout.modes[focusedTab.id] ?? 'terminal' : 'terminal';

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
      if (mounted.current) setLoadError(errorText(err, 'The terminal list could not be loaded.'));
    }
  }, [deps.api]);

  useEffect(() => { void refresh(); }, [refresh]);
  usePollWhileVisible(() => { void refresh(); }, TERMINAL_PANEL_LIST_POLL_MS, { enabled: visible });

  // Output seen as it arrives in the visible panes.
  useEffect(() => {
    if (!shown || !activeGroup) return;
    setSeen((prev) => {
      let next: Map<string, string> | null = null;
      for (const id of activeGroup.panes) {
        const t = tabById.get(id);
        if (!t || prev.get(id) === t.lastActivityAt) continue;
        next ??= new Map(prev);
        next.set(id, t.lastActivityAt);
      }
      return next ?? prev;
    });
  }, [shown, activeGroup, tabById]);

  const patchTab = useCallback((tabId: string, patch: (t: VerseTerminalTab) => VerseTerminalTab) => {
    setList((prev) => (prev ? { ...prev, tabs: prev.tabs.map((t) => (t.id === tabId ? patch(t) : t)) } : prev));
  }, []);

  // -------------------------------------------------------------------------
  // Creating / closing shells
  // -------------------------------------------------------------------------

  const sizeHint = useCallback(() => {
    for (const leaf of leaves.current.values()) {
      const size = leaf.size();
      if (size) return size;
    }
    return { cols: 80, rows: 24 };
  }, []);

  const createShell = useCallback(async (opts: OpenOptions): Promise<VerseTerminalTab | null> => {
    setCreating(true);
    setNotice(null);
    try {
      const tab = await deps.api.create({
        sessionId,
        ...(opts.root ? { root: opts.root } : {}),
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.appId ? { appId: opts.appId } : {}),
        ...(opts.appId && opts.via ? { via: opts.via } : {}),
        ...(opts.appId && opts.model ? { model: opts.model } : {}),
        ...(opts.devServerId ? { devServerId: opts.devServerId } : {}),
        ...(opts.size ?? sizeHint()),
      });
      if (mounted.current) setList((prev) => (prev ? { ...prev, tabs: [...prev.tabs.filter((t) => t.id !== tab.id), tab] } : prev));
      return tab;
    } catch (err) {
      if (mounted.current) setNotice({ tone: 'error', text: errorText(err, 'The terminal could not be opened.') });
      return null;
    } finally {
      if (mounted.current) setCreating(false);
    }
  }, [deps.api, sessionId, sizeHint]);

  const openInNewGroup = useCallback(async (opts: OpenOptions) => {
    const tab = await createShell(opts);
    if (tab && mounted.current) setLayout((prev) => addGroup(prev, tab.id));
    return tab;
  }, [createShell]);

  /** Where a new shell should start: beside the focused one (its root, and its cwd when the shell reported one). */
  const hereOptions = useCallback((): OpenOptions => {
    if (!focusedTab) return {};
    return { root: focusedTab.root, ...(focusedTab.cwd ? { cwd: focusedTab.cwd } : {}) };
  }, [focusedTab]);

  const split = useCallback(async (direction: SplitDirection) => {
    if (!activeGroup) return;
    if (activeGroup.panes.length >= MAX_PANES_PER_GROUP) {
      setNotice({ tone: 'info', text: 'A tab holds two terminals at most. Open a new tab instead.' });
      return;
    }
    const groupId = activeGroup.id;
    // Start the shell at the size it will have (half of its neighbour), so its
    // first prompt is not drawn for a wider screen than the one it lands in.
    const here = focusedTab ? leaves.current.get(focusedTab.id)?.size() ?? null : null;
    const size = here
      ? direction === 'row' ? { cols: Math.max(20, Math.floor((here.cols - 1) / 2)), rows: here.rows } : { cols: here.cols, rows: Math.max(5, Math.floor((here.rows - 1) / 2)) }
      : undefined;
    let tab = await createShell({ ...hereOptions(), ...(size ? { size } : {}) });
    // A cwd the server refuses (outside the root): start at the root.
    if (!tab && focusedTab?.cwd) tab = await createShell({ root: focusedTab.root, ...(size ? { size } : {}) });
    if (!tab || !mounted.current) return;
    const created = tab;
    setLayout((prev) => splitGroup(prev, groupId, created.id, direction) ?? addGroup(prev, created.id));
  }, [activeGroup, createShell, hereOptions, focusedTab]);

  const closeShell = useCallback(async (tab: VerseTerminalTab) => {
    try {
      await deps.api.kill(tab.id);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) {
        setNotice({ tone: 'error', text: errorText(err, 'The terminal could not be closed.') });
        return;
      }
    }
    setList((prev) => (prev ? { ...prev, tabs: prev.tabs.filter((t) => t.id !== tab.id) } : prev));
    setLayout((prev) => removePane(prev, tab.id));
  }, [deps.api]);

  const closeGroup = useCallback(async (group: TerminalGroup) => {
    for (const id of [...group.panes]) {
      const tab = tabById.get(id);
      if (tab) await closeShell(tab);
    }
  }, [closeShell, tabById]);

  const restartShell = useCallback(async (tab: VerseTerminalTab) => {
    const next = await createShell({ root: tab.root });
    if (!next) return;
    setLayout((prev) => {
      const group = prev.groups.find((g) => g.panes.includes(tab.id));
      if (!group) return addGroup(prev, next.id);
      return { ...prev, groups: prev.groups.map((g) => (g.id === group.id ? { ...g, panes: g.panes.map((p) => (p === tab.id ? next.id : p)), focused: g.focused === tab.id ? next.id : g.focused } : g)) };
    });
    try { await deps.api.kill(tab.id); } catch { /* already gone */ }
    setList((prev) => (prev ? { ...prev, tabs: prev.tabs.filter((t) => t.id !== tab.id) } : prev));
  }, [createShell, deps.api]);

  // First look at an empty chat: open a shell in its primary folder.
  useEffect(() => {
    if (!list || !list.available || !shown || autoCreated.current || creating) return;
    if (request && request.nonce > lastHandledNonce) return;
    autoCreated.current = true;
    if (tabs.length === 0 && layout.active !== AGENT_GROUP_ID) void openInNewGroup({});
  }, [list, shown, tabs.length, creating, request, layout.active, openInNewGroup]);

  // -------------------------------------------------------------------------
  // Requests (from the dock / registry)
  // -------------------------------------------------------------------------

  const pasteInto = useCallback((tabId: string, text: string) => {
    pendingPaste.current = { tabId, text };
    setPasteTick((n) => n + 1);
  }, []);

  const handleRequest = useCallback(async (req: TerminalPanelRequest) => {
    if (req.agent) {
      setLayout((prev) => ({ ...prev, active: AGENT_GROUP_ID }));
      return;
    }
    const wantsNew = req.newTab === true || Boolean(req.appId) || Boolean(req.devServerId);
    let target: VerseTerminalTab | null = null;
    if (!wantsNew) {
      const live = tabs.filter((t) => !t.exited && (!req.root || t.root === req.root));
      target = (focusedTab && live.includes(focusedTab) ? focusedTab : null) ?? live.at(-1) ?? null;
    }
    if (target) {
      const group = layout.groups.find((g) => g.panes.includes(target!.id));
      if (group) setLayout((prev) => ({ ...focusPane(prev, group.id, target!.id), modes: { ...prev.modes, [target!.id]: 'terminal' } }));
    } else {
      target = await openInNewGroup({
        ...(req.root ?? focusedTab?.root ?? roots[0] ? { root: req.root ?? focusedTab?.root ?? roots[0] } : {}),
        ...(req.appId ? { appId: req.appId } : {}),
        ...(req.via ? { via: req.via } : {}),
        ...(req.model ? { model: req.model } : {}),
        ...(req.devServerId ? { devServerId: req.devServerId } : {}),
      });
    }
    if (!target) return;
    if (req.paste) pasteInto(target.id, req.paste);
    else leaves.current.get(target.id)?.focus();
  }, [focusedTab, layout.groups, openInNewGroup, pasteInto, roots, tabs]);

  useEffect(() => {
    if (!request || !list || request.nonce <= lastHandledNonce) return;
    lastHandledNonce = request.nonce;
    autoCreated.current = true;
    if (!list.available && !request.agent) return;
    void handleRequest(request);
  }, [request, list, handleRequest]);

  // -------------------------------------------------------------------------
  // Chat hand-off (always scrubbed by the server first)
  // -------------------------------------------------------------------------

  const deliver = useCallback((text: string, intent: ChatIntent) => {
    if (intent === 'explain' && onAskChat) onAskChat(text);
    else onSendToChat(text);
    setNotice({ tone: 'info', text: intent === 'explain' && onAskChat ? 'Sent to the chat.' : 'Added to the chat’s message box.' });
  }, [onAskChat, onSendToChat]);

  const flashCopied = useCallback((what: string) => {
    setCopied(what);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => { if (mounted.current) setCopied(null); }, 1_400);
  }, []);

  const terminalBlockText = useCallback(async (tabId: string, block: BlockView, format: 'text' | 'chat') => {
    const res = await deps.api.blockOutput(tabId, block.id, format);
    return { command: res.command, output: res.output };
  }, [deps.api]);

  const runBlockAction = useCallback(async (tabId: string | null, action: BlockAction, block: BlockView) => {
    try {
      switch (action) {
        case 'copy-command':
          await deps.writeClipboard(block.command);
          flashCopied('Command copied');
          return;
        case 'copy-output': {
          const text = block.source === 'agent' || tabId === null
            ? cleanTerminalOutput(block.output ?? '')
            : (await terminalBlockText(tabId, block, 'text')).output;
          await deps.writeClipboard(text);
          flashCopied('Output copied');
          return;
        }
        case 'send':
        case 'explain': {
          const intent: ChatIntent = action;
          if (block.source === 'agent' || tabId === null) {
            // The transcript reached the page through the server's public-JSON scrub already.
            deliver(blockChatText(block, block.command, cleanTerminalOutput(block.output ?? ''), intent), intent);
          } else {
            const { command, output } = await terminalBlockText(tabId, block, 'chat');
            deliver(blockChatText(block, command, output, intent), intent);
          }
          return;
        }
        case 'jump':
          if (!tabId) return;
          setLayout((prev) => setMode(prev, tabId, 'terminal'));
          setTimeout(() => leaves.current.get(tabId)?.jumpTo(block.id), 0);
          return;
        case 'paste': {
          const target = focusedTab && !focusedTab.exited ? focusedTab : tabs.find((t) => !t.exited) ?? null;
          if (target) {
            const group = layout.groups.find((g) => g.panes.includes(target.id));
            if (group) setLayout((prev) => setMode(focusPane(prev, group.id, target.id), target.id, 'terminal'));
            pasteInto(target.id, block.command);
          } else {
            const tab = await openInNewGroup({});
            if (tab) pasteInto(tab.id, block.command);
          }
          return;
        }
      }
    } catch (err) {
      setNotice({ tone: 'error', text: errorText(err, 'That did not work.') });
    }
  }, [deliver, deps, flashCopied, focusedTab, layout.groups, openInNewGroup, pasteInto, tabs, terminalBlockText]);

  const sendSelection = useCallback(async () => {
    const tabId = selection?.tabId ?? focusedTab?.id;
    if (!tabId) return;
    const text = (leaves.current.get(tabId)?.getSelection() ?? selection?.text ?? '').replace(/\s+$/, '');
    if (!text.trim()) return;
    try {
      const clean = await deps.api.redact(text);
      const fence = fenceFor(clean);
      onSendToChat(`${fence}\n${clean}\n${fence}`);
      setNotice({ tone: 'info', text: 'Added to the chat’s message box.' });
    } catch (err) {
      setNotice({ tone: 'error', text: errorText(err, 'The selection could not be sent.') });
    }
  }, [deps.api, focusedTab, onSendToChat, selection]);

  // -------------------------------------------------------------------------
  // Leaf callbacks
  // -------------------------------------------------------------------------

  const onMeta = useCallback((tabId: string, frame: Exclude<VerseTerminalStreamFrame, { type: 'output' } | { type: 'block' }>) => {
    patchTab(tabId, (t) => {
      switch (frame.type) {
        case 'title': return t.title === frame.title ? t : { ...t, title: frame.title };
        case 'exit': return { ...t, exited: { code: frame.code, signal: frame.signal, at: new Date().toISOString() } };
        case 'cwd': return t.cwd === frame.cwd ? t : { ...t, cwd: frame.cwd };
        case 'integration': return t.shellIntegration === frame.state ? t : { ...t, shellIntegration: frame.state };
      }
    });
  }, [patchTab]);

  const onKeyAction = useCallback((tabId: string, action: PanelKeyAction) => {
    switch (action) {
      case 'find':
        leaves.current.get(tabId)?.openFind();
        return;
      case 'split-right':
        void split('row');
        return;
      case 'split-down':
        void split('column');
        return;
      case 'prev-block':
      case 'next-block':
        // The leaf walks its own markers.
        return;
      case 'toggle-blocks':
        setLayout((prev) => setMode(prev, tabId, (prev.modes[tabId] ?? 'terminal') === 'terminal' ? 'blocks' : 'terminal'));
        return;
    }
  }, [split]);

  const onSelection = useCallback((tabId: string, has: boolean, text: string) => {
    setSelection(has ? { tabId, text } : null);
    if (!has || !text) return;
    // Copy on select (the ⌘C you would type next), once the drag settles.
    deps.writeClipboard(text).then(() => { if (mounted.current) flashCopied('Copied'); }, () => { /* no user gesture: ⌘C still works */ });
  }, [deps, flashCopied]);

  const onStreamState = useCallback((tabId: string, state: TerminalStreamState | null) => {
    setStreamStates((prev) => {
      if ((prev.get(tabId) ?? null) === state) return prev;
      const next = new Map(prev);
      if (state === null) next.delete(tabId);
      else next.set(tabId, state);
      return next;
    });
    if (state === 'gone') void refresh();
  }, [refresh]);

  const onBlockMenu = useCallback((tabId: string, block: BlockView, anchorEl: HTMLElement) => {
    const failed = block.failed || (block.exitCode !== null && block.exitCode !== 0);
    const items: ActionMenuItem[] = [
      { id: 'copy-output', label: 'Copy output', onSelect: () => void runBlockAction(tabId, 'copy-output', block), disabled: block.fullscreen, reason: block.fullscreen ? 'A full-screen program keeps no output.' : null },
      { id: 'send', label: 'Send to chat', description: 'Adds the command and its output to the message box (secrets removed).', onSelect: () => void runBlockAction(tabId, 'send', block) },
      ...(failed ? [{ id: 'explain', label: 'Explain and fix this error', description: onAskChat ? 'Sends it to this chat’s seat.' : 'Drafts the question in the message box.', onSelect: () => void runBlockAction(tabId, 'explain', block) }] : []),
      { id: 'copy-command', label: 'Copy command', onSelect: () => void runBlockAction(tabId, 'copy-command', block), disabled: !block.command },
      { id: 'blocks', label: 'Show in Blocks', onSelect: () => setLayout((prev) => setMode(prev, tabId, 'blocks')) },
    ];
    setMenu({ kind: 'block', anchor: anchorBelow(anchorEl, 'end'), from: null, items, label: `Command: ${block.command || 'command'}` });
  }, [onAskChat, runBlockAction]);

  const leafRef = (tabId: string) => {
    let ref = leafRefs.current.get(tabId);
    if (!ref) {
      ref = (handle) => {
        if (handle) {
          leaves.current.set(tabId, handle);
        } else {
          leaves.current.delete(tabId);
          leafRefs.current.delete(tabId);
        }
      };
      leafRefs.current.set(tabId, ref);
    }
    return ref;
  };

  // A paste into a shell that is still starting waits for its first output
  // (the prompt): typeahead before a profile finishes can be eaten by it.
  useEffect(() => {
    if (pasteTick === 0) return undefined;
    const tryPaste = () => {
      const pending = pendingPaste.current;
      if (!pending) return true;
      const leaf = leaves.current.get(pending.tabId);
      if (!leaf?.size() || !leaf.hasOutput()) return false;
      pendingPaste.current = null;
      // A beat after the prompt, so it is not interleaved with its drawing.
      setTimeout(() => leaf.paste(pending.text), 120);
      return true;
    };
    if (tryPaste()) return undefined;
    const timer = setInterval(() => { if (tryPaste()) clearInterval(timer); }, 200);
    const stop = setTimeout(() => clearInterval(timer), 10_000);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [pasteTick]);

  // -------------------------------------------------------------------------
  // Header actions
  // -------------------------------------------------------------------------

  const updatePrefs = (patch: Partial<LeafPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      writePrefs(deps.storage, next);
      return next;
    });
  };

  const openExternal = async () => {
    try {
      await deps.api.openExternal(sessionId, focusedTab?.root ?? roots[0]);
      setNotice({ tone: 'info', text: 'Opened in Terminal.' });
    } catch (err) {
      setNotice({ tone: 'error', text: errorText(err, 'Terminal could not be opened.') });
    }
  };

  const openMoreMenu = (from: HTMLElement) => {
    const items: ActionMenuItem[] = [
      { id: 'find', label: `Find… (${panelKeyLabel('find', deps.platform)})`, onSelect: () => focusedTab && leaves.current.get(focusedTab.id)?.openFind(), disabled: !focusedTab },
      { id: 'clear', label: 'Clear screen and scrollback', onSelect: () => focusedTab && leaves.current.get(focusedTab.id)?.clear(), disabled: !focusedTab },
      { id: 'ligatures', label: prefs.ligatures ? 'Turn ligatures off' : 'Turn ligatures on', description: 'For fonts that have them (Fira Code, JetBrains Mono…), with GPU rendering.', onSelect: () => updatePrefs({ ligatures: !prefs.ligatures }) },
      { id: 'gpu', label: prefs.gpu ? 'Turn GPU rendering off' : 'Turn GPU rendering on', description: 'Applies to terminals opened from now on.', onSelect: () => updatePrefs({ gpu: !prefs.gpu }) },
      { id: 'sr', label: prefs.screenReader ? 'Turn screen reader mode off' : 'Turn screen reader mode on', onSelect: () => updatePrefs({ screenReader: !prefs.screenReader }) },
      ...(deps.platform === 'mac' ? [{ id: 'external', label: 'Open in Terminal.app', onSelect: () => void openExternal() }] : []),
    ];
    setMenu({ kind: 'more', anchor: anchorBelow(from), from, items, label: 'Terminal' });
  };

  const openRootMenu = (from: HTMLElement) => {
    setMenu({
      kind: 'root',
      anchor: anchorBelow(from),
      from,
      label: 'New terminal in',
      items: roots.map((root) => ({ id: root, label: projectName(root), description: root, onSelect: () => void openInNewGroup({ root }) })),
    });
  };

  // Tabs: ←/→ move and activate, Home/End jump (WAI-ARIA tabs, automatic activation).
  const stripIds = [...layout.groups.map((g) => g.id), AGENT_GROUP_ID];
  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % stripIds.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + stripIds.length) % stripIds.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = stripIds.length - 1;
    if (next < 0) return;
    event.preventDefault();
    const id = stripIds[next]!;
    setLayout((prev) => ({ ...prev, active: id }));
    tabRefs.current.get(id)?.focus();
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (!list) {
    if (loadError) {
      return (
        <div className={styles.panel}>
          <EmptyState compact tone="error" title="Terminal is not reachable" body={loadError}
            action={<Button size="sm" variant="subtle" onClick={() => void refresh()}>Try again</Button>} />
        </div>
      );
    }
    return (
      <div className={styles.panel} aria-busy="true">
        <div className={styles.strip} aria-hidden="true" />
        <div className={styles.loading}><SkeletonLine width="40%" /><SkeletonLine width="70%" /></div>
      </div>
    );
  }

  const newTabKey = 'New terminal tab';
  const opening = tabs.length === 0 && !agentActive && (!autoCreated.current || creating);
  const focusedState = focusedTab ? streamStates.get(focusedTab.id) ?? null : null;
  const status = focusedState === 'reconnecting' ? 'Reconnecting…'
    : focusedState === 'expired' ? 'Session expired — reload to reconnect'
      : copied ?? '';
  const agentSelected = agentActive;

  return (
    <div className={styles.panel} data-compact={compact || undefined}>
      <div className={styles.strip}>
        <div className={styles.tabs} role="tablist" aria-label="Terminals">
          {layout.groups.map((group, index) => {
            const selected = !agentSelected && group.id === layout.active;
            const first = tabById.get(group.panes[0]!);
            if (!first) return null;
            const title = group.panes.length > 1 ? `${first.title} +${group.panes.length - 1}` : first.title;
            const exited = group.panes.every((id) => tabById.get(id)?.exited);
            const unseen = !selected && group.panes.some((id) => {
              const t = tabById.get(id);
              return t && !t.exited && (seen.get(id) ?? t.createdAt) < t.lastActivityAt;
            });
            return (
              <div key={group.id} className={styles.tab} data-selected={selected || undefined} role="presentation">
                <button
                  ref={(node) => { if (node) tabRefs.current.set(group.id, node); else tabRefs.current.delete(group.id); }}
                  type="button"
                  role="tab"
                  id={`terminal-tab-${group.id}`}
                  aria-selected={selected}
                  aria-controls={`terminal-group-${group.id}`}
                  tabIndex={selected ? 0 : -1}
                  className={styles.tabButton}
                  title={`${title} — ${first.cwd ?? first.root}`}
                  onClick={() => setLayout((prev) => ({ ...prev, active: group.id }))}
                  onKeyDown={(event) => onTabKeyDown(event, index)}
                >
                  <span className={styles.tabTitle}>{title}</span>
                  {first.agent ? <span className={styles.tabMeta}>agent</span> : null}
                  {exited ? <span className={styles.tabMeta}>exited</span> : null}
                  {unseen ? <span className={styles.unseen} aria-label="new output" role="img" /> : null}
                </button>
                <button type="button" className={styles.tabClose} aria-label={`Close terminal ${title}`} title="Close terminal"
                  onClick={() => void closeGroup(group)}>
                  <IconX size={12} />
                </button>
              </div>
            );
          })}
          <div className={styles.tab} data-selected={agentSelected || undefined} role="presentation">
            <button
              ref={(node) => { if (node) tabRefs.current.set(AGENT_GROUP_ID, node); else tabRefs.current.delete(AGENT_GROUP_ID); }}
              type="button"
              role="tab"
              id="terminal-tab-agent"
              aria-selected={agentSelected}
              aria-controls="terminal-group-agent"
              tabIndex={agentSelected ? 0 : -1}
              className={styles.tabButton}
              title="Commands this chat's agents ran (read-only)"
              onClick={() => setLayout((prev) => ({ ...prev, active: AGENT_GROUP_ID }))}
              onKeyDown={(event) => onTabKeyDown(event, stripIds.length - 1)}
            >
              <span className={styles.tabTitle}>Agent</span>
              <span className={styles.tabMeta}>read-only</span>
            </button>
          </div>
        </div>
        <div className={styles.stripActions}>
          {list.available ? (
            <>
              <IconButton variant="ghost" size="sm" icon={<IconPlus />} aria-label="New terminal tab" title={newTabKey}
                busy={creating} onClick={() => void openInNewGroup(hereOptions())} />
              {roots.length > 1 ? (
                <IconButton variant="ghost" size="sm" icon={<ChevronDownGlyph />} aria-label="New terminal in…" aria-haspopup="menu"
                  aria-expanded={menu?.kind === 'root'} title="Choose the folder"
                  onClick={(event) => openRootMenu(event.currentTarget)} />
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {!agentSelected && focusedTab ? (
        <div className={styles.header}>
          <span className={styles.cwd} title={focusedTab.cwd ?? focusedTab.root}>{projectName(focusedTab.cwd ?? focusedTab.root)}</span>
          <span className={styles.headerStatus} role="status" aria-live="polite">{status}</span>
          <div className={styles.headerActions}>
            <div className={styles.segmented} role="group" aria-label="View">
              <button type="button" aria-pressed={focusedMode === 'terminal'} onClick={() => setLayout((prev) => setMode(prev, focusedTab.id, 'terminal'))}>Terminal</button>
              <button type="button" aria-pressed={focusedMode === 'blocks'} title={`Commands as blocks (${panelKeyLabel('toggle-blocks', deps.platform)})`}
                onClick={() => setLayout((prev) => setMode(prev, focusedTab.id, 'blocks'))}>Blocks</button>
            </div>
            {!compact ? (
              <>
                <IconButton variant="ghost" size="sm" icon={<SplitGlyph direction="row" />} aria-label="Split right"
                  title={`Split right${deps.platform === 'mac' ? ` (${panelKeyLabel('split-right', deps.platform)})` : ''}`}
                  disabled={(activeGroup?.panes.length ?? 0) >= MAX_PANES_PER_GROUP} onClick={() => void split('row')} />
                <IconButton variant="ghost" size="sm" icon={<SplitGlyph direction="column" />} aria-label="Split down"
                  title={`Split down${deps.platform === 'mac' ? ` (${panelKeyLabel('split-down', deps.platform)})` : ''}`}
                  disabled={(activeGroup?.panes.length ?? 0) >= MAX_PANES_PER_GROUP} onClick={() => void split('column')} />
              </>
            ) : null}
            <IconButton variant="ghost" size="sm" icon={<IconSearch />} aria-label="Find in terminal"
              title={`Find (${panelKeyLabel('find', deps.platform)})`} onClick={() => leaves.current.get(focusedTab.id)?.openFind()} />
            <Button variant="ghost" size="sm" icon={<IconSend />} disabled={!selection} aria-label="Send selection to chat"
              title={selection ? 'Send the selected text to the chat as a code block (secrets removed)' : 'Select text in the terminal first'}
              onClick={() => void sendSelection()}>
              {compact ? null : 'Send to chat'}
            </Button>
            <IconButton variant="ghost" size="sm" icon={<MoreGlyph />} aria-label="More terminal options" aria-haspopup="menu"
              aria-expanded={menu?.kind === 'more'} title="More" onClick={(event) => openMoreMenu(event.currentTarget)} />
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

      <div className={styles.body}>
        {!list.available && !agentSelected ? (
          <EmptyState
            compact
            icon={<TerminalGlyph size={20} />}
            title="Terminal needs the desktop app"
            body="This Verse server has no built-in terminal. The Agent tab still shows what this chat's agents ran."
            action={deps.platform === 'mac' ? (
              <Button size="sm" variant="subtle" icon={<IconExternalLink />} onClick={() => void openExternal()}>Open in Terminal</Button>
            ) : undefined}
          />
        ) : null}
        {opening && list.available ? (
          <div className={styles.loading} role="status" aria-label="Opening a shell"><SkeletonLine width="30%" /></div>
        ) : null}
        {list.available && tabs.length === 0 && !opening && !agentSelected ? (
          <EmptyState compact icon={<TerminalGlyph size={20} />} title="No terminal open"
            body="Open a login shell in this chat's folder. Each command you run becomes a block you can copy, send to the chat, or ask it to fix."
            action={<Button size="sm" variant="subtle" icon={<IconPlus />} busy={creating} onClick={() => void openInNewGroup({})}>New terminal</Button>} />
        ) : null}

        {layout.groups.map((group) => {
          const selected = !agentSelected && group.id === layout.active;
          return (
            <div
              key={group.id}
              id={`terminal-group-${group.id}`}
              role="tabpanel"
              aria-labelledby={`terminal-tab-${group.id}`}
              className={styles.group}
              data-direction={group.direction}
              data-split={group.panes.length > 1 || undefined}
              hidden={!selected}
            >
              {group.panes.map((id) => {
                const tab = tabById.get(id);
                if (!tab) return null;
                return (
                  <TerminalLeaf
                    key={id}
                    ref={leafRef(id)}
                    tab={tab}
                    deps={deps}
                    shown={shown && selected}
                    focused={group.focused === id}
                    mode={layout.modes[id] ?? 'terminal'}
                    prefs={prefs}
                    onFocus={() => setLayout((prev) => focusPane(prev, group.id, id))}
                    onMeta={onMeta}
                    onBlockAction={(tabId, action, block) => void runBlockAction(tabId, action, block)}
                    onBlockMenu={onBlockMenu}
                    onKeyAction={onKeyAction}
                    onSelection={onSelection}
                    onNotice={setNotice}
                    onStreamState={onStreamState}
                    onRestart={(t) => void restartShell(t)}
                    onClose={(t) => void closeShell(t)}
                    onError={errorText}
                  />
                );
              })}
            </div>
          );
        })}

        <div id="terminal-group-agent" role="tabpanel" aria-labelledby="terminal-tab-agent" className={styles.group} hidden={!agentSelected}>
          {agentSelected ? (
            <AgentTerminal
              sessionId={sessionId}
              highlightId={agentHighlight}
              onAction={(action, block) => {
                setAgentHighlight(block.id);
                void runBlockAction(null, action, block);
              }}
            />
          ) : null}
        </div>
      </div>

      {menu ? (
        <ActionMenu label={menu.label} anchor={menu.anchor} returnFocus={menu.from} onClose={() => setMenu(null)} items={menu.items} />
      ) : null}
    </div>
  );
}

/** A split glyph: two panes side by side (row) or stacked (column). Same grammar as the shared icons. */
function SplitGlyph({ direction }: { direction: SplitDirection }) {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
      {direction === 'row' ? <path d="M8 2.75v10.5" /> : <path d="M1.75 8h12.5" />}
    </svg>
  );
}

function MoreGlyph() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="3.5" cy="8" r="1.25" /><circle cx="8" cy="8" r="1.25" /><circle cx="12.5" cy="8" r="1.25" />
    </svg>
  );
}
