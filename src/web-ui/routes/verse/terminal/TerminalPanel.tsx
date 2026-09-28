/**
 * terminal/TerminalPanel.tsx — the Verse terminal (3.15): a Warp-grade
 * terminal the operator and the agents share.
 *
 * WHAT IT IS
 *   - Tabs, each one shell or a SPLIT of up to six (⌘D right, ⌥⌘D down; side
 *     by side, stacked or tiled; ⌥⌘←→↑↓ between them, ⇧⌘Return zooms one), laid
 *     out per chat and restored after a reload — the shells themselves live
 *     on the server (core/verse/terminal.ts) and are reattached, scrollback
 *     and command blocks included. Every visible shell streams over ONE
 *     connection (panel-stream.ts, the multiplexer).
 *   - An INPUT EDITOR at each prompt (CommandInput.tsx): multi-line, bash
 *     highlighting, ghost text and ↑/↓ from the persistent history, path
 *     completion, Ctrl+R history palette, `#`/⌘I plain words → a command (local
 *     model, never run on its own). Raw per shell turns it off.
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
 * 3.15 — THE TERMINAL FOR MANY AGENTS
 *   - Ask any seat: a block's "Ask…" lists every seat (Claude Code, both
 *     Codex accounts, Grok, Devin CLI / cloud, local models) and sends the
 *     scrubbed block to that seat's chat — this chat when it is on that seat,
 *     otherwise a new chat on the same folders (multimodel/ask-seat.ts).
 *     "Ask all ready seats" opens Compare with every ready seat side by side.
 *   - Error-fix chips: a failed command gets the LOCAL model's ≤ 3 candidate
 *     commands ([Paste] types one; nothing runs), opt-out in More.
 *   - Agent tabs (Claude Code, Codex, Devin, Grok launched here) show live
 *     status — running / idle / needs you — from per-launch hooks or their
 *     output (server: terminal-agent-hooks.ts); "needs you" also reaches the
 *     Needs-you drawer and the desktop notifier.
 *   - Blocks: multi-select, sticky running header, re-run, filter-in-block,
 *     bookmarks, verse://terminal links, "Open in Browser pane" for a local URL.
 *   - Launch configurations (.ashlr/verse/launch.json), typed only on Launch.
 *
 * CONTRACT. `TerminalPanelProps` below is the whole interface; it is a
 * superset of the dock's 3.10 `TerminalPaneProps`, so the adapter
 * (./TerminalPane.tsx) maps one onto the other and the pane registry (or the
 * dock's slot) mounts it lazily. This file is never imported statically from
 * the chat's first-paint path (terminal-lazy.test.ts).
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type {
  VerseSeat,
  VerseSession,
  VerseTerminalAgentState,
  VerseTerminalLaunchConfig,
  VerseTerminalStreamFrame,
  VerseTerminalListResponse,
  VerseTerminalTab,
} from '../../../data/api-types.js';
import { ApiError } from '../../../data/client.js';
import { Button, IconButton } from '../../../components/primitives/Button.js';
import { Dialog } from '../../../components/primitives/Dialog.js';
import { EmptyState } from '../../../components/primitives/EmptyState.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { IconExternalLink, IconPlus, IconSearch, IconSend, IconX } from '../../../components/primitives/icons.js';
import { asSentence } from '../autonomy/format.js';
import { ActionMenu, anchorBelow, type ActionMenuItem, type MenuAnchor } from '../chat/ActionMenu.js';
import { cleanTerminalOutput } from '../chat/ansi.js';
import { detectKeyPlatform } from '../shell/command-keys.js';
import { usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { useCommandHandler } from '../shell/command-bus.js';
import { useViewport } from '../shell/viewport.js';
import { projectName } from '../verse-model.js';
import type { VerseTerminalLaunchVia } from '../../../../core/verse/workbench-types.js';
import { TerminalLockedError } from '../dock/terminal/terminal-client.js';
import { openMuxedPanelStream, type TerminalStreamState } from './panel-stream.js';
import { ChevronDownGlyph, TerminalGlyph } from '../dock/terminal/terminal-icons.js';
import { AgentTerminal } from './AgentTerminal.js';
import type { BlockAction, BlockActionExtra } from './BlockList.js';
import { blockChatText, fenceFor, type BlockView, type ChatIntent } from './blocks-model.js';
import {
  blocksChatText,
  loadBookmarks,
  loadFixChipsEnabled,
  saveFixChipsEnabled,
  terminalBlockLink,
  toggleBookmark,
} from './block-tools.js';
import { askableSeats, askSeat, firstSeatPerEngine } from '../multimodel/ask-seat.js';
import { DEFAULT_FLOW_API, type FlowTarget } from '../multimodel/multimodel-flows.js';
import { toAdvisorSeats } from '../multimodel/useAutoSeat.js';
import { requestPreview } from '../dock/dock-store.js';
import { getVerseSessionHead } from '../verse-store.js';
import extra from './TerminalExtras.module.css';
import {
  addGroup,
  AGENT_GROUP_ID,
  focusPane,
  gridShape,
  loadLayout,
  MAX_PANES_PER_GROUP,
  neighborPane,
  paneCells,
  reconcileLayout,
  removePane,
  saveLayout,
  setArrangement,
  setMode,
  splitGroup,
  toggleZoom,
  type GroupArrangement,
  type LeafMode,
  type PaneDirection,
  type SplitDirection,
  type TerminalGroup,
  type TerminalLayout,
} from './layout-model.js';
import { resetCommandInputHistoryCache } from './CommandInput.js';
import { HistoryPalette, type TerminalPaletteMode } from './HistoryPalette.js';
import { createLazyInputEditor, preloadInputEditor } from './input-editor.js';
import type { VerseTerminalAssistMode, VerseTerminalSettings } from '../../../data/api-types.js';
import { panelTerminalApi, type PanelTerminalApi } from './panel-client.js';
import { agentToolsApi, type AgentToolsApi } from '../agent-tools/agent-tools-client.js';
import type { VerseAgentTabInfo } from '../../../../core/verse/verse-mcp-types.js';
import { panelKeyLabel, type PanelKeyAction } from './panel-keys.js';
import { TerminalLeaf, type LeafDeps, type LeafExtras, type LeafHandle, type LeafNotice, type LeafPrefs } from './TerminalLeaf.js';
import { createPanelXtermView, type PanelViewFactory } from './xterm-view.js';
import styles from './TerminalPanel.module.css';

const CompareDialog = lazy(async () => ({ default: (await import('../multimodel/CompareDialog.js')).CompareDialog }));
const LaunchDialog = lazy(async () => ({ default: (await import('./LaunchDialog.js')).LaunchDialog }));
const CommandWorkflowPicker = lazy(async () => ({ default: (await import('../playbooks/CommandWorkflowPicker.js')).CommandWorkflowPicker }));

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
  /** 3.15: ⌘K "Generate command…" — plain words → a command in the focused shell's editor. */
  assist?: boolean;
  /** 3.15: ⌘K "Search terminal history…". */
  history?: boolean;
  /** 3.15: focus this tab (a verse://terminal link, a notification, Needs you) and, with blockId, show that block. */
  tabId?: string;
  blockId?: string;
  /** 3.15: open the launch-configuration dialog. */
  launch?: boolean;

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
  /** 3.15: the chat record ("Ask…" routes from it; default: the store's). */
  session?: VerseSession | null;
  /** 3.15: every seat, for "Ask…" (the dock's ChatPaneData). */
  seats?: readonly VerseSeat[];
  /** 3.15: switch to another chat (a seat's answer landed in a new chat). */
  onOpenSession?: (sessionId: string) => void;
  /** Test / host seams. */
  deps?: Partial<TerminalPanelDeps>;
}

/** The fix chips' "Ask …" row: one seat per family, the ones that fix code. */
const FIX_ASK_ENGINES = ['claude', 'codex', 'devin'] as const;

/** A tab strip badge for an agent tab's live status. */
function agentBadge(state: VerseTerminalAgentState | null | undefined): { state: string; label: string; title: string } | null {
  if (!state) return null;
  const who = state.agent === 'claude-code' ? 'Claude Code' : state.agent === 'codex' ? 'Codex' : state.agent === 'devin' ? 'Devin' : 'Grok';
  const how = state.channel === 'hooks' ? 'from its hooks' : 'read from its output';
  if (state.state === 'needs-you') return { state: 'needs-you', label: 'needs you', title: `${who} needs you${state.message ? `: ${state.message}` : ''} (${how})` };
  if (state.state === 'running') return { state: 'running', label: 'working', title: `${who} is working (${how})` };
  return { state: 'idle', label: 'idle', title: `${who} is idle (${how})` };
}

/** The most urgent status among a tab's panes. */
function groupAgentState(states: ReadonlyArray<VerseTerminalAgentState | null | undefined>): VerseTerminalAgentState | null {
  const rank = { 'needs-you': 3, running: 2, idle: 1 } as const;
  let best: VerseTerminalAgentState | null = null;
  for (const s of states) if (s && (!best || rank[s.state] > rank[best.state])) best = s;
  return best;
}

type AskSource = { tabId: string | null; blocks: BlockView[] };

export interface TerminalPanelDeps extends LeafDeps {
  api: PanelTerminalApi;
  /** 3.15 agent tools: which tabs an agent drives, sharing and takeover (optional; absent = no agent-tools UI). */
  agentTools?: AgentToolsApi;
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
  agentTools: agentToolsApi,
  createView: createPanelXtermView,
  // Every pane on one connection (panel-stream.ts): six panes, one of the browser's ~6 slots.
  openStream: openMuxedPanelStream,
  createInputEditor: createLazyInputEditor,
  preloadInputEditor,
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
/** Per chat: the shells set to Raw input (their own line editor only). */
const RAW_KEY_PREFIX = 'ashlr.verse.terminal.raw.v1:';
/** Shared with the 3.10 pane, so the choice carries over. */
const SCREEN_READER_KEY = 'ashlr.verse.terminal.screenReader';

let lastHandledNonce = 0;
export function resetTerminalPanelForTest(): void {
  lastHandledNonce = 0;
}

function readPrefs(storage: TerminalPanelDeps['storage']): LeafPrefs {
  const prefs: LeafPrefs = { screenReader: false, ligatures: true, gpu: true, inputEditor: true };
  try {
    const raw = storage?.getItem(PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LeafPrefs>;
      if (typeof parsed.ligatures === 'boolean') prefs.ligatures = parsed.ligatures;
      if (typeof parsed.gpu === 'boolean') prefs.gpu = parsed.gpu;
      if (typeof parsed.inputEditor === 'boolean') prefs.inputEditor = parsed.inputEditor;
    }
    prefs.screenReader = storage?.getItem(SCREEN_READER_KEY) === '1';
  } catch {
    /* defaults */
  }
  return prefs;
}

function writePrefs(storage: TerminalPanelDeps['storage'], prefs: LeafPrefs): void {
  try {
    storage?.setItem(PREFS_KEY, JSON.stringify({ ligatures: prefs.ligatures, gpu: prefs.gpu, inputEditor: prefs.inputEditor }));
    storage?.setItem(SCREEN_READER_KEY, prefs.screenReader ? '1' : '0');
  } catch {
    /* this page only */
  }
}

function readRaw(storage: TerminalPanelDeps['storage'], sessionId: string): ReadonlySet<string> {
  try {
    const parsed = JSON.parse(storage?.getItem(`${RAW_KEY_PREFIX}${sessionId}`) ?? '[]') as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string').slice(0, 64) : []);
  } catch {
    return new Set();
  }
}

function writeRaw(storage: TerminalPanelDeps['storage'], sessionId: string, raw: ReadonlySet<string>): void {
  try {
    if (raw.size === 0) storage?.removeItem(`${RAW_KEY_PREFIX}${sessionId}`);
    else storage?.setItem(`${RAW_KEY_PREFIX}${sessionId}`, JSON.stringify([...raw]));
  } catch {
    /* this page only */
  }
}

const ASSIST_MODE_LABELS: Readonly<Record<VerseTerminalAssistMode, string>> = {
  auto: 'Local model, then cloud Grok (shares terminal context)',
  local: 'Local model only',
  off: 'Off',
};

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

export function TerminalPanel({ sessionId, roots, request, onSendToChat, onAskChat, visible, session: sessionProp, seats = [], onOpenSession, deps: override }: TerminalPanelProps) {
  const deps = useMemo<TerminalPanelDeps>(() => ({ ...DEFAULT_DEPS, ...override }), [override]);
  const sectionVisible = useSectionVisible();
  const shown = visible && sectionVisible;
  const compact = useViewport().compact;

  const [list, setList] = useState<VerseTerminalListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [layout, setLayout] = useState<TerminalLayout>(() => loadLayout(sessionId, deps.storage));
  const [notice, setNotice] = useState<LeafNotice | null>(null);
  // 3.15 agent tools: tabs an agent drives (its own, or a shell you shared), and takeovers.
  const [agentTabs, setAgentTabs] = useState<ReadonlyMap<string, VerseAgentTabInfo>>(new Map());
  const [creating, setCreating] = useState(false);
  const [streamStates, setStreamStates] = useState<ReadonlyMap<string, TerminalStreamState>>(() => new Map());
  const [selection, setSelection] = useState<{ tabId: string; text: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<LeafPrefs>(() => readPrefs(deps.storage));
  const [menu, setMenu] = useState<{ kind: 'root' | 'more' | 'block'; anchor: MenuAnchor; from: HTMLElement | null; items: ActionMenuItem[]; label: string } | null>(null);
  const [seen, setSeen] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [agentHighlight, setAgentHighlight] = useState<string | null>(null);
  const [pasteTick, setPasteTick] = useState(0);
  const [rawTabs, setRawTabs] = useState<ReadonlySet<string>>(() => readRaw(deps.storage, sessionId));
  const [palette, setPalette] = useState<{ mode: TerminalPaletteMode; tabId: string | null; draft: string } | null>(null);
  const [settings, setSettings] = useState<VerseTerminalSettings | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  // 3.15 many agents
  const [bookmarks, setBookmarks] = useState<Record<string, string[]>>(() => loadBookmarks(deps.storage));
  const [fixChips, setFixChips] = useState(() => loadFixChipsEnabled(deps.storage));
  const [compare, setCompare] = useState<{ prompt: string } | null>(null);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [workflowsOpen, setWorkflowsOpen] = useState(false);
  const [asked, setAsked] = useState<{ text: string; sessionId: string | null } | null>(null);


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
    setRawTabs(readRaw(deps.storage, sessionId));
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
  useEffect(() => {
    if (!list) return;
    const live = new Set(tabIdsKey ? tabIdsKey.split(',') : []);
    setRawTabs((prev) => {
      const next = new Set([...prev].filter((id) => live.has(id)));
      if (next.size === prev.size) return prev;
      writeRaw(deps.storage, sessionId, next);
      return next;
    });
  }, [list, tabIdsKey, sessionId, deps.storage]);

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
    if (deps.agentTools) {
      try {
        const { tabs: infos } = await deps.agentTools.tabs();
        if (mounted.current) setAgentTabs(new Map(infos.map((info) => [info.tabId, info])));
      } catch { /* optional: no agent-tools marks this round */ }
    }
  }, [deps.api, deps.agentTools]);

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
      setNotice({ tone: 'info', text: `A tab holds ${MAX_PANES_PER_GROUP} terminals at most. Open a new tab instead.` });
      return;
    }
    const groupId = activeGroup.id;
    // Start the shell at about the size it will have, so its first prompt is
    // not drawn for a wider screen than the one it lands in (the first fit corrects it).
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

  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  /** ⌥⌘←→↑↓: the neighbouring pane in its group gets the keyboard. */
  const focusToward = useCallback((tabId: string, direction: PaneDirection) => {
    const group = layoutRef.current.groups.find((g) => g.panes.includes(tabId));
    if (!group || group.zoomed) return;
    const target = neighborPane(group, tabId, direction);
    if (!target) return;
    setLayout((prev) => focusPane(prev, group.id, target));
    leaves.current.get(target)?.focus();
  }, []);

  /** ⌘I / "Generate command…": in the shell's input editor when it shows, else the palette (its result is pasted, never run). */
  const openAssist = useCallback((tabId: string | null) => {
    const leaf = tabId ? leaves.current.get(tabId) : undefined;
    if (leaf?.openAssist()) return;
    setPalette({ mode: 'assist', tabId, draft: '' });
  }, []);

  const openHistory = useCallback((tabId: string | null, draft: string) => {
    setPalette({ mode: 'history', tabId, draft });
  }, []);

  const onHistorySearch = useCallback((tabId: string, draft: string) => openHistory(tabId, draft), [openHistory]);

  const setRaw = useCallback((tabId: string, on: boolean) => {
    setRawTabs((prev) => {
      if (prev.has(tabId) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(tabId);
      else next.delete(tabId);
      writeRaw(deps.storage, sessionId, next);
      return next;
    });
    setTimeout(() => leaves.current.get(tabId)?.focus(), 0);
  }, [deps.storage, sessionId]);

  const loadSettings = useCallback(async () => {
    if (!deps.api.settings) return;
    try {
      const next = await deps.api.settings();
      if (mounted.current) setSettings(next);
    } catch {
      /* the menu shows what it can */
    }
  }, [deps.api]);

  const updateSettings = useCallback(async (patch: Partial<VerseTerminalSettings>) => {
    if (!deps.api.updateSettings) return;
    try {
      const next = await deps.api.updateSettings(patch);
      if (!mounted.current) return;
      setSettings(next);
      if (patch.history !== undefined) {
        resetCommandInputHistoryCache();
        setNotice({ tone: 'info', text: next.history ? 'Command history is on: commands you finish are remembered (secrets removed).' : 'Command history is off: nothing new is recorded.' });
      }
    } catch (err) {
      setNotice({ tone: 'error', text: errorText(err, 'That setting could not be changed.') });
    }
  }, [deps.api]);

  const clearHistory = useCallback(async () => {
    setConfirmClear(false);
    if (!deps.api.clearHistory) return;
    try {
      await deps.api.clearHistory();
      resetCommandInputHistoryCache();
      setNotice({ tone: 'info', text: 'Command history cleared.' });
    } catch (err) {
      setNotice({ tone: 'error', text: errorText(err, 'The history could not be cleared.') });
    }
  }, [deps.api]);

  const pasteInto = useCallback((tabId: string, text: string) => {
    pendingPaste.current = { tabId, text };
    setPasteTick((n) => n + 1);
  }, []);

  const handleRequest = useCallback(async (req: TerminalPanelRequest) => {
    if (req.agent) {
      setLayout((prev) => ({ ...prev, active: AGENT_GROUP_ID }));
      return;
    }
    if (req.assist || req.history) {
      const target = focusedTab && !focusedTab.exited ? focusedTab : tabs.find((t) => !t.exited) ?? null;
      if (req.assist) openAssist(target?.id ?? null);
      else openHistory(target?.id ?? null, '');
      return;
    }
    if (req.launch) {
      setLaunchOpen(true);
      return;
    }
    if (req.tabId) {
      // A verse://terminal link, a notification, a Needs-you row: that tab (and block), if it is still open.
      const tabId = req.tabId;
      const group = layout.groups.find((g) => g.panes.includes(tabId));
      if (!group || !tabById.has(tabId)) {
        setNotice({ tone: 'info', text: 'That terminal is no longer open.' });
        return;
      }
      setLayout((prev) => focusPane(prev, group.id, tabId));
      const blockId = req.blockId;
      if (blockId) {
        setLayout((prev) => setMode(prev, tabId, 'blocks'));
        setTimeout(() => leaves.current.get(tabId)?.jumpTo(blockId), 0);
      } else {
        setTimeout(() => leaves.current.get(tabId)?.focus(), 0);
      }

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
  }, [focusedTab, layout.groups, openAssist, openHistory, openInNewGroup, pasteInto, roots, tabs, tabById]);


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

  const currentSession = useCallback((): VerseSession | null => sessionProp ?? getVerseSessionHead(sessionId).session ?? null, [sessionProp, sessionId]);
  const askTargetsAll = useMemo(() => askableSeats(seats), [seats]);

  /** Send `text` to a seat's chat: this chat on that seat, else a new chat on the same folders. */
  const sendToSeat = useCallback(async (target: FlowTarget, text: string, title: string) => {
    const source = currentSession();
    if (!source) {
      onSendToChat(text);
      setNotice({ tone: 'info', text: 'Added to the chat’s message box.' });
      return;
    }
    setAsked({ text: `Asking ${target.label}…`, sessionId: null });
    try {
      const res = await askSeat(DEFAULT_FLOW_API, { source, target, text, title, relation: 'compare' });
      if (!mounted.current) return;
      setAsked({ text: res.created ? `Sent to ${res.label} in a new chat.` : `Sent to ${res.label} in this chat.`, sessionId: res.created ? res.sessionId : null });
    } catch (err) {
      if (!mounted.current) return;
      setAsked(null);
      setNotice({ tone: 'error', text: errorText(err, `${target.label} could not be asked.`) });
    }
  }, [currentSession, onSendToChat]);

  const deliver = useCallback((text: string, intent: ChatIntent) => {
    if (intent === 'explain' && onAskChat) {
      onAskChat(text);
      setNotice({ tone: 'info', text: 'Sent to the chat.' });
      return;
    }
    const source = intent === 'explain' ? currentSession() : null;
    if (source) {
      const own = askTargetsAll.find((t) => t.seatId === source.seatId)
        ?? { seatId: source.seatId, model: source.model, label: 'this chat’s seat', engine: source.engine };
      void sendToSeat(own, text, source.title);
      return;
    }
    onSendToChat(text);
    setNotice({ tone: 'info', text: 'Added to the chat’s message box.' });
  }, [askTargetsAll, currentSession, onAskChat, onSendToChat, sendToSeat]);

  const flashCopied = useCallback((what: string) => {
    setCopied(what);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => { if (mounted.current) setCopied(null); }, 1_400);
  }, []);

  const terminalBlockText = useCallback(async (tabId: string, block: BlockView, format: 'text' | 'chat') => {
    const res = await deps.api.blockOutput(tabId, block.id, format);
    return { command: res.command, output: res.output };
  }, [deps.api]);

  /** Blocks → their scrubbed chat text (agent blocks were scrubbed on the way to the page). */
  const chatTextFor = useCallback(async (source: AskSource, intent: ChatIntent): Promise<string> => {
    const items = await Promise.all(source.blocks.map(async (block) => {
      if (block.source === 'agent' || source.tabId === null) return { block, command: block.command, output: cleanTerminalOutput(block.output ?? '') };
      const { command, output } = await terminalBlockText(source.tabId, block, 'chat');
      return { block, command, output };
    }));
    return blocksChatText(items, intent);
  }, [terminalBlockText]);

  const askAbout = useCallback(async (source: AskSource, target: FlowTarget) => {
    try {
      const text = await chatTextFor(source, 'explain');
      const first = source.blocks[0];
      await sendToSeat(target, text, `Terminal · ${(first?.command || 'command').slice(0, 60)}`);
    } catch (err) {
      setNotice({ tone: 'error', text: errorText(err, 'That did not work.') });
    }
  }, [chatTextFor, sendToSeat]);

  const askAll = useCallback(async (source: AskSource) => {
    try {
      setCompare({ prompt: await chatTextFor(source, 'explain') });
    } catch (err) {
      setNotice({ tone: 'error', text: errorText(err, 'That did not work.') });
    }
  }, [chatTextFor]);

  /** "Ask…": every seat, then "all ready seats side by side". */
  const openAskMenu = useCallback((anchorEl: HTMLElement, source: AskSource) => {
    const hasSession = currentSession() !== null;
    const ready = askTargetsAll.filter((t) => t.ready);
    const items: ActionMenuItem[] = askTargetsAll.map((t) => ({
      id: `ask:${t.seatId}`,
      label: `Ask ${t.label}`,
      description: t.ready ? (currentSession()?.seatId === t.seatId ? 'In this chat.' : 'In a new chat on the same folders.') : 'May be busy or signed out.',
      onSelect: () => void askAbout(source, t),
      disabled: !hasSession,
      reason: hasSession ? null : 'Open a chat first.',
    }));
    items.push({
      id: 'ask-all',
      label: `Ask all ready seats (${ready.length})`,
      description: 'Their proposed fixes side by side (Compare). Nothing is sent until you confirm.',
      onSelect: () => void askAll(source),
      disabled: !hasSession || ready.length < 2,
      reason: ready.length < 2 ? 'Needs at least two ready seats.' : !hasSession ? 'Open a chat first.' : null,
      separated: true,
    });
    if (askTargetsAll.length === 0) {
      items.unshift({ id: 'none', label: 'No seats are connected', onSelect: () => undefined, disabled: true, reason: 'Connect an account in Apps & Accounts.' });
    }
    setMenu({ kind: 'block', anchor: anchorBelow(anchorEl, 'end'), from: anchorEl, items, label: source.blocks.length > 1 ? `Ask about ${source.blocks.length} commands` : 'Ask a seat' });
  }, [askAbout, askAll, askTargetsAll, currentSession]);

  const runBlockAction = useCallback(async (tabId: string | null, action: BlockAction, block: BlockView, more?: BlockActionExtra) => {
    try {
      switch (action) {
        case 'ask':
          if (more?.anchor) openAskMenu(more.anchor, { tabId, blocks: [block] });
          return;
        case 'ask-seat': {
          const target = askTargetsAll.find((t) => t.seatId === more?.seatId);
          if (target) await askAbout({ tabId, blocks: [block] }, target);
          return;
        }
        case 'rerun': {
          const tab = tabId ? tabById.get(tabId) : null;
          if (!tab || tab.exited || !block.command) return;
          // An explicit click on Re-run: the command line, then Enter — exactly as if retyped.
          const bytes = new TextEncoder().encode(`${block.command.replace(/[\r\n]+/g, ' ')}\r`);
          let bin = '';
          for (const b of bytes) bin += String.fromCharCode(b);
          await deps.api.input(tab.id, btoa(bin));
          setLayout((prev) => setMode(prev, tab.id, 'terminal'));
          return;
        }
        case 'bookmark':
          if (tabId) setBookmarks(toggleBookmark(deps.storage, tabId, block.id));
          return;
        case 'copy-link': {
          const link = tabId ? terminalBlockLink(tabId, block.id) : null;
          if (!link) return;
          await deps.writeClipboard(link);
          flashCopied('Link copied');
          return;
        }
        case 'open-url':
          if (more?.url && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(more.url)) requestPreview({ url: more.url });
          return;
        case 'paste-text':
          if (tabId && more?.text) {
            const group = layout.groups.find((g) => g.panes.includes(tabId));
            if (group) setLayout((prev) => setMode(focusPane(prev, group.id, tabId), tabId, 'terminal'));
            pasteInto(tabId, more.text);
          }
          return;
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
  }, [askAbout, askTargetsAll, deliver, deps, flashCopied, focusedTab, layout.groups, openAskMenu, openInNewGroup, pasteInto, tabById, tabs, terminalBlockText]);

  const onSelectionAction = useCallback(async (tabId: string, action: 'copy-output' | 'send' | 'ask', blocks: BlockView[], anchor?: HTMLElement) => {
    const source: AskSource = { tabId, blocks };
    try {
      if (action === 'ask') {
        if (anchor) openAskMenu(anchor, source);
        return;
      }
      if (action === 'send') {
        onSendToChat(await chatTextFor(source, 'send'));
        setNotice({ tone: 'info', text: `${blocks.length} commands added to the chat’s message box.` });
        return;
      }
      const texts = await Promise.all(blocks.map(async (b) => `$ ${b.command}\n${(await terminalBlockText(tabId, b, 'text')).output}`));
      await deps.writeClipboard(texts.join('\n\n'));
      flashCopied(`${blocks.length} outputs copied`);
    } catch (err) {
      setNotice({ tone: 'error', text: errorText(err, 'That did not work.') });
    }
  }, [chatTextFor, deps, flashCopied, onSendToChat, openAskMenu, terminalBlockText]);

  const fixTargets = useMemo(() => firstSeatPerEngine(seats, FIX_ASK_ENGINES).map((t) => ({ seatId: t.seatId, label: t.label })), [seats]);
  const bookmarkSets = useMemo(() => new Map(Object.entries(bookmarks).map(([tab, ids]) => [tab, new Set(ids)] as const)), [bookmarks]);
  const emptyBookmarks = useMemo(() => new Set<string>(), []);
  const fixApi = deps.api.fix;
  const loadFix = useMemo(() => (fixChips && fixApi ? (tabId: string, block: BlockView) => fixApi(tabId, block.id) : null), [fixChips, fixApi]);
  const leafExtrasFor = useCallback((tabId: string): LeafExtras => ({
    bookmarks: bookmarkSets.get(tabId) ?? emptyBookmarks,
    loadFix,
    askTargets: fixTargets,
    onOpenUrl: (url) => requestPreview({ url }),
    onSelectionAction: (id, action, blocks, anchor) => void onSelectionAction(id, action, blocks, anchor),
  }), [bookmarkSets, emptyBookmarks, fixTargets, loadFix, onSelectionAction]);
  const leafExtras = useMemo(() => new Map(tabs.map((t) => [t.id, leafExtrasFor(t.id)] as const)), [tabs, leafExtrasFor]);

  // -------------------------------------------------------------------------
  // Launch configurations, command workflows (palette + More menu)
  // -------------------------------------------------------------------------

  // The palette's entries: served here while the panel is shown (the shell's fallbacks otherwise).
  useCommandHandler('terminal.launch', () => { setLaunchOpen(true); return true; }, shown && Boolean(list?.available));
  useCommandHandler('terminal.workflows', () => { setWorkflowsOpen(true); return true; }, shown);

  /** A filled workflow: pasted at the focused (or any live) shell's prompt — never run. */
  const pasteWorkflow = useCallback(async (text: string) => {
    const target = focusedTab && !focusedTab.exited ? focusedTab : tabs.find((t) => !t.exited) ?? null;
    if (target) {
      const group = layout.groups.find((g) => g.panes.includes(target.id));
      if (group) setLayout((prev) => setMode(focusPane(prev, group.id, target.id), target.id, 'terminal'));
      pasteInto(target.id, text);
      return;
    }
    const tab = await openInNewGroup({});
    if (tab) pasteInto(tab.id, text);
  }, [focusedTab, layout.groups, openInNewGroup, pasteInto, tabs]);

  const loadLaunchConfigs = useCallback(async () => {
    if (!deps.api.launchList) throw new Error('Launch configurations need a newer server.');
    return deps.api.launchList(sessionId);
  }, [deps.api, sessionId]);

  const launchConfig = useCallback(async (config: VerseTerminalLaunchConfig) => {
    if (!deps.api.launch) throw new Error('Launch configurations need a newer server.');
    let res;
    try {
      res = await deps.api.launch({ sessionId, root: config.root, name: config.name, digest: config.digest, ...sizeHint() });
    } catch (err) {
      throw new Error(errorText(err, 'That configuration could not be launched.'));
    }
    if (!mounted.current) return;
    const opened = res.groups.flatMap((g) => g.tabs);
    setList((prev) => (prev ? { ...prev, tabs: [...prev.tabs.filter((t) => !opened.some((o) => o.id === t.id)), ...opened] } : prev));
    setLayout((prev) => {
      let next = prev;
      for (const group of res.groups) {
        const [first, second] = group.tabs;
        if (!first) continue;
        next = addGroup(next, first.id);
        const added = next.groups.find((g) => g.panes.includes(first.id));
        if (second && added) next = splitGroup(next, added.id, second.id, group.split === 'down' ? 'column' : 'row') ?? addGroup(next, second.id);
      }
      return next;
    });
    if (res.errors.length > 0) setNotice({ tone: 'error', text: `Launched with problems: ${res.errors.join('; ')}` });
    else setNotice({ tone: 'info', text: `Launched “${config.name}”.` });
  }, [deps.api, sessionId, sizeHint]);

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
        case 'agent-state': return { ...t, agentState: frame.agentState };
        default: return t;
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
      case 'focus-left':
      case 'focus-right':
      case 'focus-up':
      case 'focus-down':
        focusToward(tabId, action.slice('focus-'.length) as PaneDirection);
        return;
      case 'zoom-pane': {
        const group = layoutRef.current.groups.find((g) => g.panes.includes(tabId));
        if (group) setLayout((prev) => toggleZoom(focusPane(prev, group.id, tabId), group.id));
        return;
      }
      case 'assist':
        openAssist(tabId);
        return;
    }
  }, [split, focusToward, openAssist]);

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
      { id: 'ask', label: 'Ask…', description: 'Any seat — Claude Code, Codex, Devin, Grok, a local model — or all of them side by side.', onSelect: () => setTimeout(() => openAskMenu(anchorEl, { tabId, blocks: [block] }), 0) },
      { id: 'copy-command', label: 'Copy command', onSelect: () => void runBlockAction(tabId, 'copy-command', block), disabled: !block.command },
      { id: 'copy-link', label: 'Copy link', description: 'A verse://terminal link to this block.', onSelect: () => void runBlockAction(tabId, 'copy-link', block) },
      { id: 'bookmark', label: bookmarkSets.get(tabId)?.has(block.id) ? 'Remove bookmark' : 'Bookmark', onSelect: () => void runBlockAction(tabId, 'bookmark', block) },
      { id: 'blocks', label: 'Show in Blocks', onSelect: () => setLayout((prev) => setMode(prev, tabId, 'blocks')) },
    ];
    setMenu({ kind: 'block', anchor: anchorBelow(anchorEl, 'end'), from: null, items, label: `Command: ${block.command || 'command'}` });
  }, [bookmarkSets, onAskChat, openAskMenu, runBlockAction]);

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
    void loadSettings();
    const group = activeGroup;
    const layoutItems: ActionMenuItem[] = group && group.panes.length > 1 ? [
      ...(['row', 'column', 'grid'] as GroupArrangement[]).map((arrangement) => ({
        id: `layout-${arrangement}`,
        ...(arrangement === 'row' ? { separated: true } : {}),
        label: `${arrangement === group.direction ? '✓ ' : ''}${arrangement === 'row' ? 'Side by side' : arrangement === 'column' ? 'Stacked' : 'Grid'}`,
        onSelect: () => setLayout((prev) => setArrangement(prev, group.id, arrangement)),
      })),
      { id: 'zoom', label: `${group.zoomed ? 'Show every pane' : 'Zoom this pane'} (${panelKeyLabel('zoom-pane', deps.platform)})`, onSelect: () => setLayout((prev) => toggleZoom(prev, group.id)) },
    ] : [];
    const history = settings?.history ?? true;
    const assistMode = settings?.assist ?? 'local';
    const raw = focusedTab ? rawTabs.has(focusedTab.id) : false;
    const items: ActionMenuItem[] = [
      { id: 'find', label: `Find… (${panelKeyLabel('find', deps.platform)})`, onSelect: () => focusedTab && leaves.current.get(focusedTab.id)?.openFind(), disabled: !focusedTab },
      { id: 'history', label: 'Command history… (Ctrl+R)', description: 'Search what you ran; Return puts it at the prompt without running it.', onSelect: () => openHistory(focusedTab?.id ?? null, '') },
      { id: 'assist', label: `Generate a command… (${panelKeyLabel('assist', deps.platform)})`, description: assistMode === 'auto' ? 'Local model first; Grok may receive the request and recent terminal context.' : 'Describe it in words; the configured local model writes it for you to review.', onSelect: () => openAssist(focusedTab?.id ?? null), disabled: assistMode === 'off', reason: assistMode === 'off' ? 'Plain-English commands are turned off below.' : null },
      ...layoutItems,
      {
        id: 'raw',
        separated: true,
        label: raw ? 'Use the input editor in this shell' : 'Raw input for this shell',
        description: raw ? 'Back to the editor at each prompt: history, completion, plain words.' : 'Keys go straight to the shell: your zsh-autosuggestions, fzf and prompt, untouched.',
        onSelect: () => focusedTab && setRaw(focusedTab.id, !raw),
        disabled: !focusedTab || !prefs.inputEditor,
      },
      { id: 'input-editor', label: prefs.inputEditor ? 'Turn the input editor off' : 'Turn the input editor on', description: 'For every shell: a prompt editor with history, completion and plain words.', onSelect: () => updatePrefs({ inputEditor: !prefs.inputEditor }) },
      { id: 'history-toggle', separated: true, label: history ? 'Stop recording command history' : 'Record command history', description: 'Kept in ~/.ashlr/verse on this Mac, secrets removed.', onSelect: () => void updateSettings({ history: !history }), disabled: !deps.api.updateSettings },
      { id: 'history-clear', label: 'Clear command history…', danger: true, onSelect: () => setConfirmClear(true), disabled: !deps.api.clearHistory },
      ...(['auto', 'local', 'off'] as VerseTerminalAssistMode[]).map((mode) => ({
        id: `assist-${mode}`,
        label: `${mode === assistMode ? '✓ ' : ''}Plain-English commands: ${ASSIST_MODE_LABELS[mode]}`,
        onSelect: () => void updateSettings({ assist: mode }),
        disabled: !deps.api.updateSettings,
      })),
      { id: 'clear', separated: true, label: 'Clear screen and scrollback', onSelect: () => focusedTab && leaves.current.get(focusedTab.id)?.clear(), disabled: !focusedTab },
      { id: 'ligatures', label: prefs.ligatures ? 'Turn ligatures off' : 'Turn ligatures on', description: 'For fonts that have them (Fira Code, JetBrains Mono…), with GPU rendering.', onSelect: () => updatePrefs({ ligatures: !prefs.ligatures }) },
      { id: 'gpu', label: prefs.gpu ? 'Turn GPU rendering off' : 'Turn GPU rendering on', description: 'Applies to terminals opened from now on.', onSelect: () => updatePrefs({ gpu: !prefs.gpu }) },
      { id: 'sr', label: prefs.screenReader ? 'Turn screen reader mode off' : 'Turn screen reader mode on', onSelect: () => updatePrefs({ screenReader: !prefs.screenReader }) },
      ...(deps.platform === 'mac' ? [{ id: 'external', label: 'Open in Terminal.app', onSelect: () => void openExternal() }] : []),
      ...shareMenuItems(),
      {
        id: 'launch', label: 'Launch configuration…', separated: true,
        description: 'Tabs, splits and commands from .ashlr/verse/launch.json — typed only when you launch one.',
        onSelect: () => setLaunchOpen(true), disabled: !list?.available || !deps.api.launchList,
      },
      {
        id: 'workflows', label: 'Command workflow…',
        description: 'Fill a saved command’s parameters and paste it at the prompt (it does not run).',
        onSelect: () => setWorkflowsOpen(true), disabled: !list?.available,
      },
      {
        id: 'fix-chips', label: fixChips ? 'Stop suggesting fixes' : 'Suggest fixes with the local model',
        description: 'When a command fails, the local model offers up to three commands to paste. Free, and nothing leaves this Mac.',
        onSelect: () => { saveFixChipsEnabled(deps.storage, !fixChips); setFixChips(!fixChips); },
      },

    ];
    setMenu({ kind: 'more', anchor: anchorBelow(from), from, items, label: 'Terminal' });
  };

  // 3.15 agent tools: share one of YOUR shells in this chat with its agent (the
  // chat's Agent tools must be on "Share my shells"). Never an agent's own tab
  // or an Apps launch.
  const shareMenuItems = (): ActionMenuItem[] => {
    const api = deps.agentTools;
    if (!api || !focusedTab || focusedTab.agent || focusedTab.appId || focusedTab.sessionId !== sessionId) return [];
    const shared = agentTabs.get(focusedTab.id)?.kind === 'shared';
    return [{
      id: 'share-agent',
      label: shared ? 'Stop sharing this shell with the agent' : 'Share this shell with the agent…',
      description: shared
        ? 'The agent can no longer type here or read this shell.'
        : 'The chat\'s agent may run commands here and read the output. Typing yourself pauses it.',
      onSelect: () => {
        void api.share(sessionId, focusedTab.id, !shared).then(
          () => { setNotice({ tone: 'info', text: shared ? 'This shell is yours alone again.' : 'Shared with this chat\'s agent. Type in it to take it back over.' }); void refresh(); },
          (err: unknown) => setNotice({ tone: 'error', text: errorText(err, 'Switch this chat\'s Agent tools to "Share my shells" first (Chat actions → Agent tools).') }),
        );
      },
    }];
  };

  const resumeAgent = (tabId: string) => {
    void deps.agentTools?.resume(tabId).then(
      () => { setNotice({ tone: 'info', text: 'Handed back to the agent.' }); void refresh(); },
      (err: unknown) => setNotice({ tone: 'error', text: errorText(err, 'The terminal could not be handed back.') }),
    );
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
                  {(() => {
                    const badge = agentBadge(groupAgentState(group.panes.map((id) => tabById.get(id)?.agentState)));
                    if (badge) return <span className={extra.agentBadge} data-state={badge.state} title={badge.title} aria-label={badge.title}>{badge.label}</span>;
                    return first.agent ? <span className={styles.tabMeta}>agent</span> : null;
                  })()}
                  {agentTabs.get(first.id)?.kind === 'shared' ? <span className={styles.tabMeta}>shared</span> : null}
                  {agentTabs.get(first.id)?.takenOverAt ? <span className={styles.tabMeta}>you have it</span> : null}

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

      {!agentSelected && focusedTab && agentTabs.get(focusedTab.id)?.takenOverAt ? (
        <div className={styles.notice} data-tone="info" role="status" data-testid="terminal-takeover">
          <span>You took over this terminal, so the agent is paused here.</span>
          <Button size="sm" variant="subtle" onClick={() => resumeAgent(focusedTab.id)}>Resume agent</Button>
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

      {confirmClear ? (
        <div className={styles.notice} role="alertdialog" aria-label="Clear command history">
          <span>Clear every command in the history? This cannot be undone.</span>
          <Button size="sm" variant="subtle" onClick={() => void clearHistory()}>Clear</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmClear(false)}>Cancel</Button>

        </div>
      ) : null}
      {asked ? (
        <div className={styles.notice} role="status">
          <span>{asked.text}</span>
          {asked.sessionId && onOpenSession ? (
            <Button size="sm" variant="ghost" onClick={() => { const id = asked.sessionId!; setAsked(null); onOpenSession(id); }}>Open chat</Button>
          ) : null}
          <button type="button" className={styles.noticeClose} aria-label="Dismiss" title="Dismiss" onClick={() => setAsked(null)}>
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
          const cells = new Map(paneCells(group).map((c) => [c.id, c]));
          const zoomed = group.zoomed && group.panes.includes(group.zoomed) ? group.zoomed : null;
          return (
            <div
              key={group.id}
              id={`terminal-group-${group.id}`}
              role="tabpanel"
              aria-labelledby={`terminal-tab-${group.id}`}
              className={styles.group}
              data-direction={zoomed ? 'row' : group.direction}
              data-cols={group.direction === 'grid' && !zoomed ? gridShape(group.panes.length).cols : undefined}
              data-split={(group.panes.length > 1 && !zoomed) || undefined}
              data-zoomed={zoomed ? true : undefined}
              hidden={!selected}
            >
              {group.panes.map((id) => {
                const tab = tabById.get(id);
                if (!tab) return null;
                const concealed = zoomed !== null && zoomed !== id;
                return (
                  <TerminalLeaf
                    key={id}
                    ref={leafRef(id)}
                    tab={tab}
                    deps={deps}
                    shown={shown && selected && !concealed}
                    concealed={concealed}
                    gridSpan={group.direction === 'grid' && !zoomed ? cells.get(id)?.span ?? 1 : 1}
                    raw={rawTabs.has(id)}
                    onHistorySearch={onHistorySearch}
                    focused={group.focused === id}
                    mode={layout.modes[id] ?? 'terminal'}
                    prefs={prefs}
                    assistMode={settings?.assist ?? 'local'}
                    onFocus={() => setLayout((prev) => focusPane(prev, group.id, id))}
                    onMeta={onMeta}
                    onBlockAction={(tabId, action, block, more) => void runBlockAction(tabId, action, block, more)}
                    {...(leafExtras.get(id) ? { extras: leafExtras.get(id)! } : {})}
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

      {palette ? (
        <HistoryPalette
          mode={palette.mode}
          assistMode={settings?.assist ?? 'local'}
          api={deps.api}
          tabId={palette.tabId}
          cwd={(palette.tabId ? tabById.get(palette.tabId)?.cwd ?? tabById.get(palette.tabId)?.root : null) ?? null}
          initialQuery={palette.draft}
          onClose={() => setPalette(null)}
          onPick={(command) => {
            const target = palette.tabId ?? focusedTab?.id ?? null;
            const leaf = target ? leaves.current.get(target) : undefined;
            // Into the editor (or pasted at the prompt) — never run.
            if (leaf) setTimeout(() => leaf.insertCommand(command), 0);
            else void openInNewGroup({}).then((tab) => { if (tab) pasteInto(tab.id, command); });
          }}
          {...(palette.mode === 'history' && palette.tabId ? {
            onPassThrough: (query: string) => {
              const leaf = leaves.current.get(palette.tabId!);
              if (!leaf) return;
              // The shell's own Ctrl+R (fzf, atuin…), searching for what was typed.
              leaf.sendText(`\x12${query}`);
              setTimeout(() => leaf.focus(), 0);
            },
          } : {})}
          {...(settings?.history === false || deps.api.updateSettings ? { onEnableHistory: () => void updateSettings({ history: true }) } : {})}
        />
      ) : null}
      {compare && currentSession() ? (
        <Suspense fallback={null}>
          <CompareDialog
            mode="compare"
            prompt={compare.prompt}
            selectAll
            maxSeats={askTargetsAll.filter((t) => t.ready).length}
            source={currentSession()!}
            seats={seats}
            advisorSeats={toAdvisorSeats(seats.filter((s) => s.health.state === 'ready'))}
            advice={null}
            onStarted={() => undefined}
            onClose={() => setCompare(null)}
          />
        </Suspense>
      ) : null}

      {launchOpen ? (
        <Suspense fallback={null}>
          <LaunchDialog load={loadLaunchConfigs} onLaunch={launchConfig} onClose={() => setLaunchOpen(false)} />
        </Suspense>
      ) : null}

      {workflowsOpen ? (
        <Dialog open onClose={() => setWorkflowsOpen(false)} titleId="terminal-workflows-title" title="Command workflows"
          description="Fill the parameters; the command is pasted at the prompt and runs only when you press Enter.">
          <Suspense fallback={<SkeletonLine width="50%" />}>
            <CommandWorkflowPicker onPaste={(text) => void pasteWorkflow(text)} onClose={() => setWorkflowsOpen(false)} />
          </Suspense>
        </Dialog>

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
