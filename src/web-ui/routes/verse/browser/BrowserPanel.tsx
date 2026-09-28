/**
 * routes/verse/browser/BrowserPanel.tsx — the integrated Browser pane (3.15):
 * the browser Mason and a chat's agents share.
 *
 * TWO ENGINES, ONE PANE (native-browser.ts decides, at mount):
 *   - DESKTOP APP (shell contract "browser" v1): each tab is a real native
 *     webview laid exactly over this pane's stage, so ANY site works (no
 *     X-Frame-Options wall), with screenshots (macOS), console + network
 *     capture and an element picker. The webview is a separate native layer:
 *     it is hidden whenever this pane is hidden or a Verse dialog / menu
 *     opens over it, or it would cover them.
 *   - WEB UI / older desktop shell: an <iframe> for loopback dev servers
 *     (the page CSP's `frame-src` allows exactly those) and "Open externally"
 *     for everything else. A cross-origin frame cannot be read, so capture
 *     features say so instead of pretending.
 *
 * AGENTS. With "Agent access" on for this chat, the chat's Claude / local
 * seats get browser tools (core/verse/browser-mcp.ts + verse-mcp-browser-
 * act.ts). Their commands arrive here (long-poll, browser-queries.ts) and run
 * in THIS pane — agent-runner.ts — so an agent only ever sees and touches
 * what Mason sees. Localhost is allowed; other origins only when Mason allows
 * them below. In the desktop app agents can also click, type, select, press
 * keys and scroll (as real input, drawn as a ring in the page, listed in the
 * strip under it); anything that matters shows a card here first — Allow
 * once / Allow for this chat / Deny. Mason clicking or typing in the page
 * while an agent is working pauses it ("You took over") until Resume. They
 * never type into password or payment fields, pick files or download.
 *
 * Props are the pane contract the workbench pane registry mounts
 * (register.ts): the chat it serves, and whether it is on screen.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';

import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { Button, IconButton } from '../../../components/primitives/Button.js';
import { Segmented } from '../../../components/primitives/Segmented.js';
import { Switch } from '../../../components/primitives/Switch.js';
import { IconPlus, IconX } from '../../../components/primitives/icons.js';
import type {
  VerseBrowserAgentCommand,
  VerseBrowserCommandResult,
  VerseBrowserConfirmRequest,
  VerseBrowserConsoleEntry,
  VerseBrowserDecision,
  VerseBrowserNetworkEntry,
  VerseBrowserPolicy,
  VerseBrowserScope,
} from '../../../../core/verse/browser-types.js';
import { asConsoleEntries, asNetworkEntries, formatBrowserConsole, isLoopbackHost } from '../../../../core/verse/browser-types.js';
import type { VersePreviewDevServer } from '../../../../core/verse/workbench-types.js';
import { insertIntoComposer } from '../chat/composer-bridge.js';
import { useTokenGate } from '../context/use-token-gate.js';
import { executeAgentCommand, type BrowserClip, type BrowserExecutor } from './agent-runner.js';
import { originOf, parseBrowserAddress, shortAddress, type BrowserAddress } from './browser-address.js';
import { DEVICE_SIZES, frameRect, isUsableRect, sameRect, stepZoom, zoomLabel, type DevicePreset, type Rect } from './browser-geometry.js';
import {
  BackGlyph,
  CameraGlyph,
  ConsoleGlyph,
  DesktopGlyph,
  ExternalGlyph,
  FillGlyph,
  ForwardGlyph,
  GlobeGlyph,
  PhoneGlyph,
  PickGlyph,
  ReloadGlyph,
  SendGlyph,
  ServerGlyph,
  ShieldGlyph,
  TabletGlyph,
} from './browser-icons.js';
import { browserApi, type BrowserApi } from './browser-queries.js';
import {
  BROWSER_TABS_STORAGE_KEY,
  MAX_BROWSER_TABS,
  activeTab as selectActiveTab,
  browserTabsReducer,
  restoreTabs,
  serializeTabs,
  type BrowserTab,
  type BrowserTabsAction,
} from './browser-tabs.js';
import {
  nativeBrowser,
  nativeRequest,
  subscribeNativeBrowser,
  type ApprovedPage,
  type NativeBrowser,
  type NativeQuery,
} from './native-browser.js';
import { sendCaptureToChat, type BrowserCapture, type BrowserScreenshot, type PickedElement } from './send-to-chat.js';
import styles from './BrowserPanel.module.css';

// ---------------------------------------------------------------------------
// Contract + deps
// ---------------------------------------------------------------------------

export interface BrowserPanelProps {
  /** The chat this pane serves ("Send to chat", agent access). Null → browsing only. */
  sessionId: string | null;
  /** False while the pane is mounted but not on screen (the native layer hides). Default true. */
  visible?: boolean;
  /** Tests inject fakes. */
  deps?: Partial<BrowserPanelDeps>;
}

export interface BrowserPanelDeps {
  api: BrowserApi;
  native: () => NativeBrowser | null;
  /** `window.location.origin`: Verse's own address, never opened here. */
  origin: () => string;
  insert: (sessionId: string, text: string) => boolean;
  openExternal: (url: string) => void;
  storage: () => Pick<Storage, 'getItem' | 'setItem'> | null;
  now: () => Date;
}

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const DEFAULT_DEPS: BrowserPanelDeps = {
  api: browserApi,
  native: () => nativeBrowser(),
  origin: () => window.location.origin,
  insert: insertIntoComposer,
  openExternal: (url) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
  storage: defaultStorage,
  now: () => new Date(),
};

const POLICY_POLL_MS = 5_000;
const CONSOLE_POLL_MS = 2_000;
const BOUNDS_POLL_MS = 400;
const PICK_POLL_MS = 400;
const PICK_TIMEOUT_MS = 90_000;
const NAV_WAIT_MS = 15_000;
/** Operator input within this long of an agent command counts as taking over. */
const AGENT_ACTIVE_MS = 120_000;
const RECENT_ACTIONS_MAX = 6;
/** Anything portalled onto <body> that a native layer would otherwise cover. */
const OVERLAY_SELECTOR = '[role="dialog"],[role="alertdialog"],[aria-modal="true"],[role="menu"],[role="listbox"]';

const DEVICE_ICON: Readonly<Record<DevicePreset, ReactElement>> = {
  fill: <FillGlyph size={14} />,
  desktop: <DesktopGlyph size={14} />,
  tablet: <TabletGlyph size={14} />,
  mobile: <PhoneGlyph size={14} />,
};

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Something went wrong.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asScreenshot(value: unknown): (BrowserScreenshot & { scale?: number; origin?: { x: number; y: number } }) | null {
  if (!isRecord(value)) return null;
  const mime = value['mime'];
  const base64 = value['base64'];
  if ((mime !== 'image/png' && mime !== 'image/jpeg') || typeof base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  const origin = isRecord(value['origin']) ? value['origin'] : null;
  return {
    mime,
    base64,
    width: typeof value['width'] === 'number' ? value['width'] : null,
    height: typeof value['height'] === 'number' ? value['height'] : null,
    // Newer desktop shells say how image pixels map back to the page (≤ 1280×800 images).
    ...(typeof value['scale'] === 'number' && Number.isFinite(value['scale']) && value['scale'] > 0 ? { scale: value['scale'] } : {}),
    ...(origin && typeof origin['x'] === 'number' && typeof origin['y'] === 'number' ? { origin: { x: origin['x'], y: origin['y'] } } : {}),
  };
}

/** One line of the recent-actions strip. */
interface AgentActionRow {
  id: string;
  at: number;
  label: string;
  outcome: 'done' | 'failed' | 'allowed' | 'declined';
}

/** What the strip says an agent command did, or null for pure reads (they are not actions). */
function actionLabel(command: VerseBrowserAgentCommand): string | null {
  const args = isRecord(command.args) ? command.args : {};
  const target = typeof args['ref'] === 'string' ? ` ${args['ref']}` : typeof args['x'] === 'number' ? ` at ${Math.round(args['x'])},${Math.round(args['y'] as number)}` : '';
  switch (command.op) {
    case 'navigate':
      return command.url ? `Opened ${shortAddress(command.url)}` : 'Opened a page';
    case 'history':
      return args['direction'] === 'forward' ? 'Went forward' : 'Went back';
    case 'tabs':
      return args['action'] === 'list' ? null : `Tabs: ${String(args['action'])}${typeof args['index'] === 'number' ? ` ${args['index']}` : ''}`;
    case 'evaluate':
      return 'Ran a script';
    case 'act':
      switch (args['kind']) {
        case 'click': return `${args['double'] === true ? 'Double-clicked' : 'Clicked'}${target}`;
        case 'type': return `Typed ${typeof args['text'] === 'string' ? args['text'].length : 0} chars into${target}${args['submit'] === true ? ' + Enter' : ''}`;
        case 'select': return `Selected in${target}`;
        case 'hover': return `Hovered${target}`;
        case 'key': return `Pressed ${String(args['key'] ?? '')}`;
        case 'scroll': return `Scrolled${args['direction'] ? ` ${String(args['direction'])}` : ''}${target}`;
        default: return 'Acted';
      }
    default:
      return null;
  }
}

function tabLabel(tab: BrowserTab): string {
  if (!tab.url) return 'New tab';
  return tab.title?.trim() || shortAddress(tab.url);
}

/** True while a dialog, menu or listbox portalled onto <body> could sit over the stage. */
function useOverlayOpen(stage: HTMLElement | null, enabled: boolean): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!enabled || typeof MutationObserver === 'undefined') {
      setOpen(false);
      return;
    }
    const raf = typeof requestAnimationFrame === 'function' && typeof cancelAnimationFrame === 'function';
    let frame: ReturnType<typeof setTimeout> | number | null = null;
    const check = (): void => {
      frame = null;
      const found = Array.from(document.body.children).some((el) =>
        !(stage && el.contains(stage)) && (el.matches(OVERLAY_SELECTOR) || el.querySelector(OVERLAY_SELECTOR) !== null));
      setOpen(found);
    };
    // Coalesced to one check per frame (a streaming chat mutates <body> rarely,
    // but a portal can mount and unmount in the same tick).
    const schedule = (): void => {
      if (frame !== null) return;
      frame = raf ? requestAnimationFrame(check) : setTimeout(check, 16);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true });
    check();
    return () => {
      observer.disconnect();
      if (frame !== null) {
        if (raf) cancelAnimationFrame(frame as number);
        else clearTimeout(frame as ReturnType<typeof setTimeout>);
      }
    };
  }, [stage, enabled]);
  return open;
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    const onChange = (): void => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

// ---------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------

export function BrowserPanel({ sessionId, visible = true, deps: depsOverride }: BrowserPanelProps) {
  const deps = useMemo<BrowserPanelDeps>(() => ({ ...DEFAULT_DEPS, ...depsOverride }), [depsOverride]);
  const api = deps.api;
  const native = useMemo(() => deps.native(), [deps]);
  const verseOrigin = useMemo(() => deps.origin(), [deps]);
  const mode: 'native' | 'frame' = native ? 'native' : 'frame';
  const gate = useTokenGate();

  const [tabsState, rawDispatch] = useReducer(browserTabsReducer, undefined, () => {
    let raw: string | null = null;
    try {
      raw = deps.storage()?.getItem(BROWSER_TABS_STORAGE_KEY) ?? null;
    } catch {
      raw = null;
    }
    return restoreTabs(raw);
  });
  const tabsStateRef = useRef(tabsState);
  tabsStateRef.current = tabsState;
  // Native navigation events and agent commands can dispatch before React's
  // next render. Keep the action fence's tab view current within that gap.
  const dispatch = useCallback((action: BrowserTabsAction) => {
    tabsStateRef.current = browserTabsReducer(tabsStateRef.current, action);
    rawDispatch(action);
  }, [rawDispatch]);
  const tab = selectActiveTab(tabsState);

  const [device, setDevice] = useState<DevicePreset>('fill');
  const [zoom, setZoom] = useState(1);
  const [address, setAddress] = useState(tab.url ?? '');
  const [addressNote, setAddressNote] = useState<BrowserAddress | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);
  const [logs, setLogs] = useState<{ url: string; console: VerseBrowserConsoleEntry[]; network: VerseBrowserNetworkEntry[] } | null>(null);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [shot, setShot] = useState<BrowserScreenshot | null>(null);
  const [element, setElement] = useState<PickedElement | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<null | 'shot' | 'send' | 'access'>(null);
  const [policy, setPolicy] = useState<VerseBrowserPolicy | null>(null);
  const [servers, setServers] = useState<VersePreviewDevServer[] | null>(null);
  const [agentActivity, setAgentActivity] = useState<string | null>(null);
  // The operator took the pane over while an agent was working: agent commands wait for Resume.
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const [confirmCard, setConfirmCard] = useState<{ request: VerseBrowserConfirmRequest; answer: (d: VerseBrowserDecision) => void } | null>(null);
  const confirmAnswerRef = useRef<((d: VerseBrowserDecision) => void) | null>(null);
  const [recentActions, setRecentActions] = useState<AgentActionRow[]>([]);
  const lastAgentAtRef = useRef(0);
  const agentOnRef = useRef(false);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const docVisible = useDocumentVisible();
  const overlayOpen = useOverlayOpen(stageEl, mode === 'native' && visible);

  // Persist tabs (per viewer; a convenience, so every failure is ignored).
  useEffect(() => {
    try {
      deps.storage()?.setItem(BROWSER_TABS_STORAGE_KEY, serializeTabs(tabsState));
    } catch {
      /* private window, quota: the pane works without it */
    }
  }, [tabsState, deps]);

  // The address bar follows the active tab (unless the operator is typing in it).
  const addressFocused = useRef(false);
  useEffect(() => {
    if (!addressFocused.current) setAddress(tab.url ?? '');
  }, [tab.id, tab.url]);

  // Per-tab captures belong to the page they came from.
  useEffect(() => {
    setShot(null);
    setElement(null);
    setLogs(null);
    setLogsError(null);
  }, [tab.id]);

  // -------------------------------------------------------------------------
  // Native layer: events, placement, visibility
  // -------------------------------------------------------------------------

  const openedRef = useRef<Set<string>>(new Set());
  const activeIdRef = useRef(tabsState.activeId);
  activeIdRef.current = tabsState.activeId;
  const lastBoundsRef = useRef<Rect | null>(null);
  const shownRef = useRef<string | null>(null);

  /** Mason used the pane while an agent was working: pause the agent until he presses Resume. */
  const noteOperatorInput = useCallback(() => {
    if (agentOnRef.current && Date.now() - lastAgentAtRef.current < AGENT_ACTIVE_MS) setPaused(true);
  }, []);

  useEffect(() => {
    if (!native) return undefined;
    return subscribeNativeBrowser((event) => {
      switch (event.kind) {
        case 'operator':
          // Genuine input only: native never reports the agent's own synthesised events.
          if (event.tab === activeIdRef.current) noteOperatorInput();
          break;
        case 'nav':
          dispatch({ type: 'native-nav', id: event.tab, url: event.url, loading: event.loading });
          break;
        case 'title':
          dispatch({ type: 'title', id: event.tab, title: event.title });
          break;
        case 'blocked':
          setNotice(`Blocked ${shortAddress(event.url)} — ${event.reason}.`);
          break;
        case 'closed':
          openedRef.current.delete(event.tab);
          // The page Mason is looking at went away natively (⌘W while it had
          // focus): close the tab here too rather than silently re-opening
          // it. A background tab that was evicted just re-opens on its next
          // activation.
          if (event.tab === activeIdRef.current && shownRef.current === event.tab) {
            shownRef.current = null;
            dispatch({ type: 'close', id: event.tab });
          }
          break;
        default:
          break;
      }
    });
  }, [native, noteOperatorInput, dispatch]);

  const showNative = mode === 'native' && visible && docVisible && !overlayOpen && tab.url !== null && !gate.dialog.open;

  const placeNative = useCallback((force = false) => {
    if (!native) return;
    const stage = stageRef.current;
    if (!showNative || !stage || !tab.url) {
      if (shownRef.current !== null) {
        native.send({ op: 'hide' });
        shownRef.current = null;
        lastBoundsRef.current = null;
      }
      return;
    }
    const box = stage.getBoundingClientRect();
    const rect = frameRect({ x: box.left, y: box.top, width: box.width, height: box.height }, device);
    if (!isUsableRect(rect)) return;
    if (!openedRef.current.has(tab.id)) {
      if (native.send({ op: 'open', tab: tab.id, url: tab.url, bounds: rect })) {
        openedRef.current.add(tab.id);
        shownRef.current = tab.id;
        lastBoundsRef.current = rect;
        if (zoom !== 1) native.send({ op: 'zoom', tab: tab.id, factor: zoom });
      }
      return;
    }
    if (!force && shownRef.current === tab.id && sameRect(lastBoundsRef.current, rect)) return;
    native.send({ op: 'bounds', tab: tab.id, bounds: rect });
    shownRef.current = tab.id;
    lastBoundsRef.current = rect;
  }, [native, showNative, tab.id, tab.url, device, zoom]);

  useEffect(() => {
    placeNative(true);
    if (!native || !showNative) return undefined;
    const stage = stageRef.current;
    const onResize = (): void => placeNative();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    if (stage) observer?.observe(stage);
    window.addEventListener('resize', onResize);
    // Position can change without a resize (a sidebar collapsing beside the
    // pane moves it sideways); a cheap rect check catches that.
    const timer = setInterval(onResize, BOUNDS_POLL_MS);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', onResize);
      clearInterval(timer);
    };
  }, [native, showNative, placeNative]);

  // Leaving the pane hides every native tab (they survive for the next mount).
  useEffect(() => () => {
    if (native) native.send({ op: 'hide' });
  }, [native]);

  useEffect(() => {
    if (native && openedRef.current.has(tab.id)) native.send({ op: 'zoom', tab: tab.id, factor: zoom });
  }, [native, zoom, tab.id]);

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  const navigateTab = useCallback((id: string, url: string) => {
    dispatch({ type: 'navigate', id, url });
    if (native && openedRef.current.has(id)) native.send({ op: 'navigate', tab: id, url });
  }, [native, dispatch]);

  const submitAddress = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseBrowserAddress(address, verseOrigin);
    if (parsed.kind !== 'url') {
      setAddressNote(parsed);
      return;
    }
    setAddressNote(null);
    setAddress(parsed.url);
    // Like any browser: Enter hands the bar back to the page, so redirects
    // and in-page navigation show up in it again.
    addressFocused.current = false;
    const input = (event.currentTarget as HTMLFormElement).querySelector('input');
    input?.blur();
    noteOperatorInput();
    navigateTab(tab.id, parsed.url);
  };

  const onAddressKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    setAddress(tab.url ?? '');
    setAddressNote(null);
    event.currentTarget.blur();
  };

  const goBack = () => {
    noteOperatorInput();
    if (native && openedRef.current.has(tab.id)) native.send({ op: 'back', tab: tab.id });
    else dispatch({ type: 'step', id: tab.id, delta: -1 });
  };
  const goForward = () => {
    noteOperatorInput();
    if (native && openedRef.current.has(tab.id)) native.send({ op: 'forward', tab: tab.id });
    else dispatch({ type: 'step', id: tab.id, delta: 1 });
  };
  const reload = () => {
    noteOperatorInput();
    if (!tab.url) {
      void refreshServers();
      return;
    }
    if (native && openedRef.current.has(tab.id)) native.send({ op: 'reload', tab: tab.id });
    else dispatch({ type: 'reload', id: tab.id });
  };

  const openExternally = (url: string) => {
    if (native) native.send({ op: 'external', url });
    else deps.openExternal(url);
  };

  const closeTab = (id: string) => {
    if (native && openedRef.current.has(id)) {
      native.send({ op: 'close', tab: id });
      openedRef.current.delete(id);
      if (shownRef.current === id) shownRef.current = null;
    }
    dispatch({ type: 'close', id });
  };

  // -------------------------------------------------------------------------
  // Dev servers (the launcher)
  // -------------------------------------------------------------------------

  const refreshServers = useCallback(async (signal?: AbortSignal) => {
    if (!sessionId) {
      setServers([]);
      return;
    }
    try {
      const targets = await api.targets(sessionId, signal);
      const rows = [...targets.devServers].sort((a, b) => Number(b.running) - Number(a.running));
      setServers(rows);
    } catch {
      if (!signal?.aborted) setServers([]);
    }
  }, [api, sessionId]);

  useEffect(() => {
    if (!visible || tab.url !== null) return undefined;
    const ctrl = new AbortController();
    void refreshServers(ctrl.signal);
    return () => ctrl.abort();
  }, [visible, tab.url, refreshServers]);

  // -------------------------------------------------------------------------
  // Capture: console, screenshot, picker
  // -------------------------------------------------------------------------

  const queryTab = useCallback((what: NativeQuery, timeoutMs = 6_000, approved?: ApprovedPage): Promise<unknown> => {
    if (!native) return Promise.reject(new Error('Needs the Ashlr desktop app.'));
    if (!openedRef.current.has(tab.id)) return Promise.reject(new Error('No page is open.'));
    return nativeRequest(native, (req) => ({ op: 'query', tab: tab.id, req, what, ...(approved ? { approved } : {}) }), timeoutMs);
  }, [native, tab.id]);

  const readConsole = useCallback(async () => {
    const data = await queryTab('console');
    const record = isRecord(data) ? data : {};
    return {
      url: typeof record['url'] === 'string' ? record['url'] : tab.url ?? '',
      console: asConsoleEntries(record['console']),
      network: asNetworkEntries(record['network']),
    };
  }, [queryTab, tab.url]);

  useEffect(() => {
    if (!devtoolsOpen || mode !== 'native' || !visible || !tab.url) return undefined;
    let live = true;
    const pull = async (): Promise<void> => {
      try {
        const next = await readConsole();
        if (live) {
          setLogs(next);
          setLogsError(null);
        }
      } catch (err) {
        if (live) setLogsError(errorText(err));
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), CONSOLE_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [devtoolsOpen, mode, visible, tab.url, readConsole]);

  const takeScreenshot = useCallback(async (clip?: BrowserClip): Promise<BrowserScreenshot & { scale?: number; origin?: { x: number; y: number } }> => {
    if (!native) throw new Error('Screenshots need the Ashlr desktop app — a web page cannot capture another site\'s frame.');
    if (!native.capabilities.screenshot) throw new Error('This desktop shell cannot take screenshots on this platform yet (macOS only).');
    if (!openedRef.current.has(tab.id)) throw new Error('No page is open.');
    const data = await nativeRequest(native, (req) => ({ op: 'screenshot', tab: tab.id, req, ...(clip ? { clip } : {}) }), 20_000);
    const parsed = asScreenshot(data);
    if (!parsed) throw new Error('The screenshot could not be read.');
    return parsed;
  }, [native, tab.id]);

  const onScreenshot = async () => {
    setBusy('shot');
    try {
      setShot(await takeScreenshot());
    } catch (err) {
      setNotice(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const pickTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPickPolling = () => {
    if (pickTimer.current) clearInterval(pickTimer.current);
    pickTimer.current = null;
  };
  useEffect(() => stopPickPolling, []);
  useEffect(() => {
    // A new tab or page ends a pick in progress.
    stopPickPolling();
    setPicking(false);
  }, [tab.id, tab.url]);

  const onPick = async () => {
    if (picking) {
      stopPickPolling();
      setPicking(false);
      void queryTab('pick-cancel').catch(() => {});
      return;
    }
    try {
      await queryTab('pick-start');
    } catch (err) {
      setNotice(errorText(err));
      return;
    }
    setPicking(true);
    const started = Date.now();
    stopPickPolling();
    pickTimer.current = setInterval(() => {
      if (Date.now() - started > PICK_TIMEOUT_MS) {
        stopPickPolling();
        setPicking(false);
        void queryTab('pick-cancel').catch(() => {});
        return;
      }
      queryTab('pick-poll', 3_000).then((data) => {
        if (!isRecord(data)) return;
        if (data['state'] === 'picked' && isRecord(data['result'])) {
          const r = data['result'];
          stopPickPolling();
          setPicking(false);
          if (typeof r['selector'] === 'string' && typeof r['html'] === 'string') {
            setElement({ selector: r['selector'], html: r['html'], ...(typeof r['text'] === 'string' ? { text: r['text'] } : {}) });
          }
        } else if (data['state'] === 'idle') {
          // Escape in the page cancelled it.
          stopPickPolling();
          setPicking(false);
        }
      }).catch(() => {});
    }, PICK_POLL_MS);
  };

  const onSendToChat = async () => {
    if (!sessionId) {
      setNotice('Open a chat to send this to it.');
      return;
    }
    setBusy('send');
    try {
      const capture: BrowserCapture = { url: tab.url, title: tab.title, screenshot: shot, element, notes: [] };
      if (mode === 'native' && tab.url && native?.capabilities.console !== false) {
        try {
          const read = await readConsole();
          capture.console = read.console;
          capture.network = read.network;
        } catch {
          capture.notes!.push('the console could not be read');
        }
      } else if (mode === 'frame' && tab.url) {
        capture.notes!.push('console, network errors and screenshots need the Ashlr desktop app');
      }
      const send = () => sendCaptureToChat(sessionId, capture, { attach: api.attach, insert: deps.insert, now: deps.now });
      const result = shot ? await gate.run('Attach the browser screenshot to this chat', send) : await send();
      if (result === null) return;
      if (!result.ok) {
        setNotice(result.message);
        return;
      }
      setShot(null);
      setElement(null);
      setNotice(result.attached ? 'Added to the message box with the screenshot attached — nothing was sent.' : 'Added to the message box — nothing was sent.');
    } catch (err) {
      setNotice(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  // -------------------------------------------------------------------------
  // Agent access (policy) and the command loop
  // -------------------------------------------------------------------------

  const refreshPolicy = useCallback(async (signal?: AbortSignal) => {
    if (!sessionId) {
      setPolicy(null);
      return;
    }
    try {
      setPolicy(await api.policy(sessionId, signal));
    } catch {
      if (!signal?.aborted) setPolicy(null);
    }
  }, [api, sessionId]);

  useEffect(() => {
    if (!visible || !sessionId) return undefined;
    const ctrl = new AbortController();
    void refreshPolicy(ctrl.signal);
    const timer = setInterval(() => void refreshPolicy(), POLICY_POLL_MS);
    return () => {
      ctrl.abort();
      clearInterval(timer);
    };
  }, [visible, sessionId, refreshPolicy]);

  const setAccess = async (enabled: boolean) => {
    if (!sessionId) return;
    setBusy('access');
    try {
      const next = await gate.run(enabled ? 'Let this chat\'s agents use the browser' : 'Turn off browser access for this chat', () => api.setAccess(sessionId, enabled));
      if (next) setPolicy(next);
    } catch (err) {
      setNotice(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const setScope = async (scope: VerseBrowserScope, enabled: boolean) => {
    if (!sessionId) return;
    setBusy('access');
    try {
      const reason = scope === 'browser_act'
        ? (enabled ? 'Let this chat\'s agents click and type in the browser' : 'Stop agents clicking and typing')
        : (enabled ? 'Let this chat\'s agents run full-privilege scripts in localhost pages, including access to cookies and stored credentials' : 'Stop agents running page scripts');
      const next = await gate.run(reason, () => api.setAccess(sessionId, enabled, scope));
      if (next) setPolicy(next);
    } catch (err) {
      setNotice(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const revokeAllowance = async (key: string) => {
    if (!sessionId) return;
    try {
      const next = await gate.run('Forget an "Allow for this chat" answer', () => api.revokeAllowance(sessionId, key));
      if (next) setPolicy(next);
    } catch (err) {
      setNotice(errorText(err));
    }
  };

  const allowOrigin = async (origin: string, allowed: boolean) => {
    if (!sessionId) return;
    try {
      const next = await gate.run(allowed ? `Let this chat's agents open ${origin}` : `Stop agents opening ${origin}`, () => api.allowOrigin(sessionId, origin, allowed));
      if (next) setPolicy(next);
    } catch (err) {
      setNotice(errorText(err));
    }
  };

  /** Resolves when the tab's next page load finishes (or after NAV_WAIT_MS, still loading). */
  const waitForLoad = useCallback((id: string, fallbackUrl: string | null): Promise<{ url: string | null; title: string | null; loading: boolean }> => {
    return new Promise((resolve) => {
      let last = fallbackUrl;
      let title: string | null = null;
      const stop = subscribeNativeBrowser((event) => {
        if (event.kind === 'title' && event.tab === id) title = event.title;
        if (event.kind !== 'nav' || event.tab !== id) return;
        last = event.url;
        if (!event.loading) {
          stop();
          clearTimeout(timer);
          resolve({ url: last, title, loading: false });
        }
      });
      const timer = setTimeout(() => {
        stop();
        resolve({ url: last, title, loading: true });
      }, NAV_WAIT_MS);
    });
  }, []);

  // The executor sees the CURRENT pane every time a command runs.
  const executorRef = useRef<BrowserExecutor | null>(null);
  executorRef.current = {
    mode,
    capabilities: {
      screenshot: mode === 'native' && native?.capabilities.screenshot === true,
      text: mode === 'native' && native?.capabilities.text !== false,
      console: mode === 'native' && native?.capabilities.console !== false,
      act: mode === 'native' && native?.capabilities.act === true,
    },
    current: () => ({ tabId: tab.id, url: tab.url, title: tab.title, tabs: tabsState.tabs.length }),
    navigate: async (url) => {
      const id = tab.id;
      navigateTab(id, url);
      if (!native) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return { url, title: null, loading: false };
      }
      const landed = await waitForLoad(id, url);
      return { url: landed.url ?? url, title: landed.title, loading: landed.loading };
    },
    query: (what, timeoutMs, approved) => queryTab(what, timeoutMs, approved),
    history: async (direction) => {
      const id = tab.id;
      if (native && openedRef.current.has(id)) {
        const waiting = waitForLoad(id, tab.url);
        native.send({ op: direction, tab: id });
        return waiting;
      }
      dispatch({ type: 'step', id, delta: direction === 'back' ? -1 : 1 });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return { url: null, title: null, loading: false };
    },
    tabs: () => tabsStateRef.current.tabs.map((t, index) => ({ id: t.id, index, url: t.url, title: t.title, active: t.id === tabsStateRef.current.activeId })),
    openTab: async (url) => {
      dispatch({ type: 'new-tab', url });
      await new Promise((resolve) => setTimeout(resolve, url ? 1_500 : 0));
    },
    selectTab: (index) => {
      const target = tabsStateRef.current.tabs[index];
      if (!target) return false;
      dispatch({ type: 'activate', id: target.id });
      return true;
    },
    closeTab: (index) => {
      const target = tabsStateRef.current.tabs[index];
      if (!target) return false;
      closeTab(target.id);
      return true;
    },
    confirm: (request) => new Promise<VerseBrowserDecision>((resolve) => {
      const expires = Date.parse(request.expiresAt);
      // Answer a little before the sidecar gives up, so a late click never races it.
      const ms = Math.max(1_000, Math.min(118_000, (Number.isFinite(expires) ? expires - Date.now() : 118_000) - 2_000));
      let done = false;
      const finish = (decision: VerseBrowserDecision): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        confirmAnswerRef.current = null;
        setConfirmCard(null);
        resolve(decision);
      };
      const timer = setTimeout(() => finish('deny'), ms);
      confirmAnswerRef.current = finish;
      setConfirmCard({ request, answer: finish });
    }),
    paused: () => pausedRef.current,
    screenshot: takeScreenshot,
    text: async (limit) => {
      const data = await queryTab('text');
      const r = isRecord(data) ? data : {};
      const text = typeof r['text'] === 'string' ? r['text'] : '';
      return {
        url: typeof r['url'] === 'string' ? r['url'] : tab.url ?? '',
        title: typeof r['title'] === 'string' ? r['title'] : null,
        text: text.slice(0, limit),
        truncated: r['truncated'] === true || text.length > limit,
      };
    },
    console: readConsole,
  };

  const agentOn = policy?.agentAccess === true;
  agentOnRef.current = agentOn;
  useEffect(() => {
    if (!agentOn) setPaused(false);
  }, [agentOn]);

  const recordAction = useCallback((command: VerseBrowserAgentCommand, result: VerseBrowserCommandResult) => {
    let label = actionLabel(command);
    let outcome: AgentActionRow['outcome'] = result.ok ? 'done' : 'failed';
    if (command.op === 'confirm') {
      const args = isRecord(command.args) ? command.args : {};
      const decision = isRecord(result.data) ? result.data['decision'] : null;
      label = `Asked you: ${typeof args['action'] === 'string' ? args['action'].slice(0, 80) : 'an action'}`;
      outcome = decision === 'once' || decision === 'chat' ? 'allowed' : 'declined';
    }
    if (!label) return;
    setRecentActions((rows) => [{ id: command.id, at: Date.now(), label, outcome }, ...rows].slice(0, RECENT_ACTIONS_MAX));
  }, []);

  useEffect(() => {
    if (!sessionId || !visible || !agentOn) return undefined;
    const ctrl = new AbortController();
    let stopped = false;
    void (async () => {
      while (!stopped) {
        if (!api.canWrite()) {
          setAgentActivity('Unlock actions to let the agent use the browser.');
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          continue;
        }
        try {
          const { commands } = await api.commands(sessionId, ctrl.signal);
          for (const command of commands) {
            if (stopped) break;
            if (command.op !== 'status') lastAgentAtRef.current = Date.now();
            setAgentActivity(command.op === 'navigate' && command.url
              ? `Agent opened ${shortAddress(command.url)}`
              : command.op === 'confirm' ? 'Agent is waiting for your answer' : `Agent: ${command.op.replace('-', ' ')}`);
            const result = await executeAgentCommand(command, executorRef.current!, verseOrigin, (id) => api.canDispatch(sessionId, id));
            recordAction(command, result);
            await api.result(sessionId, result).catch(() => {});
          }
        } catch {
          if (stopped) break;
          await new Promise((resolve) => setTimeout(resolve, 3_000));
        }
      }
    })();
    return () => {
      stopped = true;
      ctrl.abort();
      setAgentActivity(null);
      // A card nobody can answer any more is a no.
      confirmAnswerRef.current?.('deny');
    };
  }, [sessionId, visible, agentOn, api, verseOrigin, recordAction]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const frameable = tab.url ? parseBrowserAddress(tab.url, verseOrigin) : null;
  const canCapture = mode === 'native' && tab.url !== null;
  const screenshotTitle = mode !== 'native'
    ? 'Screenshots need the Ashlr desktop app'
    : native?.capabilities.screenshot ? 'Screenshot' : 'Screenshots are macOS-only in this desktop shell';

  return (
    <div className={styles.pane} data-mode={mode}>
      <div className={styles.strip}>
        <div className={styles.tabs} role="tablist" aria-label="Browser tabs">
          {tabsState.tabs.map((t) => {
            const selected = t.id === tabsState.activeId;
            const label = tabLabel(t);
            return (
              <div key={t.id} className={styles.tab} data-selected={selected || undefined} role="presentation">
                <button type="button" role="tab" aria-selected={selected} aria-controls="browser-stage" tabIndex={selected ? 0 : -1}
                  className={styles.tabButton} title={t.url ?? 'New tab'} onClick={() => { noteOperatorInput(); dispatch({ type: 'activate', id: t.id }); }}>
                  {t.loading ? <span className={styles.spinner} aria-hidden="true" /> : <GlobeGlyph size={12} />}
                  <span className={styles.tabTitle}>{label}</span>
                </button>
                <button type="button" className={styles.tabClose} aria-label={`Close ${label}`} title="Close tab" onClick={() => { noteOperatorInput(); closeTab(t.id); }}>
                  <IconX size={12} />
                </button>
              </div>
            );
          })}
        </div>
        <IconButton variant="ghost" size="sm" icon={<IconPlus />} aria-label="New tab" title="New tab" className={styles.newTab}
          disabled={tabsState.tabs.length >= MAX_BROWSER_TABS} onClick={() => { noteOperatorInput(); dispatch({ type: 'new-tab' }); }} />
      </div>

      <div className={styles.toolbar}>
        <div className={styles.group}>
          <IconButton variant="ghost" size="sm" icon={<BackGlyph />} aria-label="Back" title="Back"
            disabled={!tab.url || (mode === 'frame' && tab.index <= 0)} onClick={goBack} />
          <IconButton variant="ghost" size="sm" icon={<ForwardGlyph />} aria-label="Forward" title="Forward"
            disabled={!tab.url || (mode === 'frame' && tab.index >= tab.history.length - 1)} onClick={goForward} />
          <IconButton variant="ghost" size="sm" icon={<ReloadGlyph />} aria-label={tab.url ? 'Reload' : 'Refresh dev servers'}
            title={tab.url ? 'Reload' : 'Refresh dev servers'} onClick={reload} />
        </div>
        <form className={styles.addressForm} onSubmit={submitAddress} role="search" aria-label="Browser address">
          <input
            className={styles.address}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={onAddressKeyDown}
            onFocus={(event) => { addressFocused.current = true; event.currentTarget.select(); }}
            onBlur={() => { addressFocused.current = false; }}
            placeholder={mode === 'native' ? 'Search or type an address — localhost:5173' : 'localhost:5173'}
            aria-label="Address"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            inputMode="url"
          />
        </form>
        <div className={styles.group}>
          <Segmented<DevicePreset>
            aria-label="Device size"
            size="sm"
            value={device}
            onChange={setDevice}
            options={(['fill', 'desktop', 'tablet', 'mobile'] as const).map((d) => ({
              value: d,
              label: DEVICE_ICON[d],
              ariaLabel: d === 'fill' ? 'Fill the pane' : DEVICE_SIZES[d].label,
            }))}
          />
          <div className={styles.zoom} role="group" aria-label="Zoom">
            <button type="button" className={styles.zoomButton} aria-label="Zoom out" title="Zoom out" onClick={() => setZoom((z) => stepZoom(z, -1))}>−</button>
            <button type="button" className={styles.zoomValue} aria-label={`Zoom ${zoomLabel(zoom)} — reset`} title="Reset zoom" onClick={() => setZoom(1)}>{zoomLabel(zoom)}</button>
            <button type="button" className={styles.zoomButton} aria-label="Zoom in" title="Zoom in" onClick={() => setZoom((z) => stepZoom(z, 1))}>+</button>
          </div>
        </div>
        <div className={styles.group}>
          <IconButton variant="ghost" size="sm" icon={<CameraGlyph />} aria-label="Screenshot" title={screenshotTitle}
            disabled={!tab.url || busy === 'shot'} onClick={() => void onScreenshot()} />
          <IconButton variant={picking ? 'subtle' : 'ghost'} size="sm" icon={<PickGlyph />} aria-label={picking ? 'Cancel element picker' : 'Pick an element'}
            aria-pressed={picking} title={canCapture ? (picking ? 'Cancel picking (Esc in the page)' : 'Pick an element') : 'The element picker needs the Ashlr desktop app'}
            disabled={!canCapture} onClick={() => void onPick()} />
          <IconButton variant={devtoolsOpen ? 'subtle' : 'ghost'} size="sm" icon={<ConsoleGlyph />} aria-label="Console" aria-pressed={devtoolsOpen}
            title="Console and network errors" onClick={() => setDevtoolsOpen((o) => !o)} />
          <IconButton variant="ghost" size="sm" icon={<ExternalGlyph />} aria-label="Open in your browser" title="Open in your browser"
            disabled={!tab.url} onClick={() => tab.url && openExternally(tab.url)} />
          <Button size="sm" variant="subtle" icon={<SendGlyph />} disabled={!sessionId || !tab.url || busy === 'send'} busy={busy === 'send'}
            onClick={() => void onSendToChat()} title={sessionId ? 'Draft the page, console and any capture into this chat’s message box' : 'Open a chat first'}>
            Send to chat
          </Button>
        </div>
      </div>

      {addressNote ? (
        <div className={styles.note} role="status">
          {addressNote.kind === 'self' ? 'That address is Verse itself — it cannot open inside its own browser.' : addressNote.kind === 'invalid' ? addressNote.reason : null}
          <button type="button" className={styles.noteClose} aria-label="Dismiss" onClick={() => setAddressNote(null)}><IconX size={12} /></button>
        </div>
      ) : null}
      {notice ? (
        <div className={styles.note} role="alert">
          {notice}
          <button type="button" className={styles.noteClose} aria-label="Dismiss" onClick={() => setNotice(null)}><IconX size={12} /></button>
        </div>
      ) : null}
      {picking ? <div className={styles.note} role="status">Click an element in the page to pick it — Esc cancels.</div> : null}
      {confirmCard ? <ConfirmCard request={confirmCard.request} onAnswer={confirmCard.answer} /> : null}
      {paused ? (
        <div className={styles.note} role="status" data-kind="paused">
          <strong>You took over.</strong> The agent is paused while you use the page.
          <Button size="sm" variant="subtle" className={styles.noteAction} onClick={() => setPaused(false)}>Resume agent</Button>
        </div>
      ) : null}

      {shot || element ? (
        <div className={styles.tray} aria-label="Captured for the chat">
          {shot ? (
            <figure className={styles.trayItem}>
              <img className={styles.thumb} src={`data:${shot.mime};base64,${shot.base64}`} alt={`Screenshot of ${tab.url ?? 'the page'}`} />
              <figcaption>{shot.width && shot.height ? `${shot.width} × ${shot.height}` : 'Screenshot'}</figcaption>
              <button type="button" className={styles.noteClose} aria-label="Discard screenshot" onClick={() => setShot(null)}><IconX size={12} /></button>
            </figure>
          ) : null}
          {element ? (
            <figure className={styles.trayItem}>
              <code className={styles.selector} title={element.selector}>{element.selector}</code>
              <figcaption>{element.text ? element.text.slice(0, 80) : 'element'}</figcaption>
              <button type="button" className={styles.noteClose} aria-label="Discard element" onClick={() => setElement(null)}><IconX size={12} /></button>
            </figure>
          ) : null}
          <span className={styles.trayHint}>Included with <strong>Send to chat</strong>.</span>
        </div>
      ) : null}

      <div className={styles.body}>
        <div
          id="browser-stage"
          role="tabpanel"
          aria-label={tab.url ? `Page: ${tabLabel(tab)}` : 'New tab'}
          className={styles.stage}
          data-device={device}
          ref={(node) => { stageRef.current = node; setStageEl(node); }}
        >
          {!tab.url ? (
            <Launcher servers={servers} hasChat={sessionId !== null} onOpen={(url) => navigateTab(tab.id, url)} />
          ) : mode === 'native' ? (
            // The native webview is drawn OVER this box by the desktop shell.
            // What shows through is only ever a placeholder while it moves.
            <div className={styles.nativeHole} aria-hidden={showNative}>
              {!showNative ? <span className={styles.nativeHint}>{overlayOpen || gate.dialog.open ? 'Page hidden while a dialog is open.' : 'Page hidden.'}</span> : null}
            </div>
          ) : frameable?.kind === 'url' && frameable.frameable ? (
            <div className={styles.frameBox} data-device={device}>
              <iframe
                key={`${tab.id}:${tab.index}:${tab.reloadKey}`}
                className={styles.frame}
                src={tab.url}
                title={`Browser: ${tabLabel(tab)}`}
                // A dev server is another origin (another port): allow-same-origin
                // is ITS origin, never Verse's. No top navigation, ever.
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
                referrerPolicy="no-referrer"
                style={zoom !== 1 ? { transform: `scale(${zoom})`, transformOrigin: '0 0', width: `${100 / zoom}%`, height: `${100 / zoom}%` } : undefined}
                onLoad={() => dispatch({ type: 'loaded', id: tab.id })}
              />
            </div>
          ) : (
            <div className={styles.external}>
              <GlobeGlyph size={28} />
              <p className={styles.externalTitle}>{shortAddress(tab.url)} can’t be shown in the web UI</p>
              <p className={styles.externalBody}>
                A browser tab can only frame local dev servers (and most sites refuse framing). The Ashlr desktop app shows any site here, with screenshots and console.
              </p>
              <Button size="sm" variant="primary" icon={<ExternalGlyph />} onClick={() => openExternally(tab.url!)}>Open in your browser</Button>
            </div>
          )}
        </div>

        {devtoolsOpen ? (
          <section className={styles.devtools} aria-label="Console and network">
            <header className={styles.devtoolsHeader}>
              <span>Console · network errors</span>
              {logs ? <span className={styles.muted}>{logs.console.length} messages · {logs.network.length} failed requests</span> : null}
            </header>
            {mode !== 'native' ? (
              <p className={styles.muted}>
                A page in an embedded frame belongs to another origin, so its console cannot be read from here. Open this page in the Ashlr desktop app to capture console output and failed requests (or use your browser’s developer tools).
              </p>
            ) : !tab.url ? (
              <p className={styles.muted}>Open a page to see its console.</p>
            ) : logsError ? (
              <p className={styles.muted}>{logsError}</p>
            ) : (
              <pre className={styles.logs}>{logs ? formatBrowserConsole(logs.console, logs.network, 200) : 'Reading…'}</pre>
            )}
          </section>
        ) : null}
      </div>

      {sessionId && agentOn && recentActions.length > 0 ? (
        <ol className={styles.actions} aria-label="Recent agent actions">
          {recentActions.map((row) => (
            <li key={row.id} className={styles.action} data-outcome={row.outcome} title={new Date(row.at).toLocaleTimeString()}>
              {row.label}
              {row.outcome === 'failed' ? ' — failed' : row.outcome === 'declined' ? ' — declined' : row.outcome === 'allowed' ? ' — allowed' : ''}
            </li>
          ))}
        </ol>
      ) : null}

      {sessionId ? (
        <AgentAccessBar
          policy={policy}
          busy={busy === 'access'}
          activity={paused ? 'Paused — you took over.' : agentActivity}
          mode={mode}
          canAct={mode === 'native' && native?.capabilities.act === true}
          onToggle={(on) => void setAccess(on)}
          onScope={(scope, on) => void setScope(scope, on)}
          onAllow={(origin, allowed) => void allowOrigin(origin, allowed)}
          onRevoke={(key) => void revokeAllowance(key)}
          currentOrigin={tab.url ? originOf(tab.url) : null}
        />
      ) : null}

      <MutationTokenDialog open={gate.dialog.open} reason={gate.dialog.reason} tokenLabel="Mutation token"
        tokenHelp="the mutation token ashlr verse printed" onClose={gate.dialog.onClose} onUnlocked={gate.dialog.onUnlocked} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Launcher({ servers, hasChat, onOpen }: { servers: VersePreviewDevServer[] | null; hasChat: boolean; onOpen: (url: string) => void }) {
  return (
    <div className={styles.launcher}>
      <p className={styles.launcherTitle}>Open a page</p>
      <p className={styles.muted}>Type an address above, or open a dev server{hasChat ? ' found in this chat’s folders' : ''}.</p>
      {servers === null ? (
        <p className={styles.muted}>Looking for dev servers…</p>
      ) : servers.length === 0 ? (
        <p className={styles.muted}>{hasChat ? 'No dev servers found (launch.json, package.json scripts, or anything listening in these folders).' : 'Open a chat to see its dev servers.'}</p>
      ) : (
        <ul className={styles.servers}>
          {servers.map((s) => (
            <li key={s.id} className={styles.server}>
              <ServerGlyph size={14} />
              <span className={styles.serverLabel} title={s.label}>{s.label}</span>
              <span className={styles.serverUrl}>{shortAddress(s.url)}</span>
              <span className={styles.badge} data-running={s.running || undefined}>{s.running ? 'running' : 'stopped'}</span>
              <Button size="sm" variant={s.running ? 'subtle' : 'ghost'} onClick={() => onOpen(s.url)}
                title={s.running ? `Open ${s.url}` : 'Not running — start it from the Preview pane or a terminal, then open'}>
                Open
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The operator's say over one agent action. The page's own words for the
 * element (untrusted) are shown as plain text, next to — never instead of —
 * what Verse knows: the action, the origin and why it is being asked.
 */
function ConfirmCard({ request, onAnswer }: { request: VerseBrowserConfirmRequest; onAnswer: (decision: VerseBrowserDecision) => void }) {
  const [left, setLeft] = useState(() => Math.max(0, Math.round((Date.parse(request.expiresAt) - Date.now()) / 1000)));
  useEffect(() => {
    const timer = setInterval(() => setLeft(Math.max(0, Math.round((Date.parse(request.expiresAt) - Date.now()) / 1000))), 1_000);
    return () => clearInterval(timer);
  }, [request.expiresAt]);
  return (
    <section className={styles.confirm} role="group" aria-label="The agent is asking to act">
      <div className={styles.confirmHead}>
        <ShieldGlyph size={14} />
        <strong>The agent wants to: {request.action}</strong>
        <span className={styles.muted}>{Number.isFinite(left) ? `${left}s` : ''}</span>
      </div>
      <p className={styles.confirmBody}>
        On <code>{request.origin}</code>
        {request.target ? <> · the page calls it <q>{request.target}</q></> : null}
      </p>
      {request.reasons.length > 0 ? (
        <ul className={styles.confirmReasons}>
          {request.reasons.map((reason) => <li key={reason}>Asked because {reason}.</li>)}
        </ul>
      ) : null}
      <div className={styles.confirmActions}>
        <Button size="sm" variant="primary" onClick={() => onAnswer('once')}>Allow once</Button>
        <Button size="sm" variant="subtle" onClick={() => onAnswer('chat')}>Allow for this chat</Button>
        <Button size="sm" variant="ghost" onClick={() => onAnswer('deny')}>Deny</Button>
      </div>
    </section>
  );
}

function AgentAccessBar({ policy, busy, activity, mode, canAct, onToggle, onScope, onAllow, onRevoke, currentOrigin }: {
  policy: VerseBrowserPolicy | null;
  busy: boolean;
  activity: string | null;
  mode: 'native' | 'frame';
  canAct: boolean;
  onToggle: (on: boolean) => void;
  onScope: (scope: VerseBrowserScope, on: boolean) => void;
  onAllow: (origin: string, allowed: boolean) => void;
  onRevoke: (key: string) => void;
  currentOrigin: string | null;
}) {
  const on = policy?.agentAccess === true;
  const act = policy?.actAccess === true;
  const script = policy?.scriptAccess === true;
  const allowances = policy?.allowances ?? [];
  const allowed = policy?.allowedOrigins ?? [];
  const blocked = policy?.blocked ?? [];
  const engines = policy?.toolEngines ?? ['claude', 'local'];
  // The page Mason is on is outside localhost and not allowed: offer it in one click.
  let offer: string | null = null;
  if (currentOrigin && !allowed.includes(currentOrigin) && !blocked.some((b) => b.origin === currentOrigin)) {
    try {
      if (!isLoopbackHost(new URL(currentOrigin).hostname)) offer = currentOrigin;
    } catch {
      offer = null;
    }
  }
  return (
    <section className={styles.agent} aria-label="Agent access">
      <div className={styles.agentRow}>
        <ShieldGlyph size={14} />
        <Switch checked={on} disabled={busy || policy === null} onChange={onToggle} label="Agents in this chat can use this browser" />
        <span className={styles.muted}>
          {on
            ? activity ?? `Localhost only${allowed.length ? ` + ${allowed.length} allowed` : ''} · ${act && canAct ? 'look, click and type — asks you before anything that matters' : 'look, navigate, screenshot, read'} · never passwords, payments, files or downloads.`
            : `Gives ${engines.includes('claude') ? 'Claude and local' : engines.join(', ')} seats browser tools from their next turn.`}

          {on && mode === 'frame' ? ' In the web UI agents can only navigate.' : ''}
          {on && mode === 'native' && !canAct ? ' Update the desktop app to let agents click and type.' : ''}
        </span>
      </div>
      {on ? (
        <div className={styles.agentRow}>
          <Switch checked={act} disabled={busy} onChange={(next) => onScope('browser_act', next)} label="Click and type" />
          <Switch checked={script} disabled={busy || !act} onChange={(next) => onScope('browser_script', next)} label="Run scripts (localhost)" />
        </div>
      ) : null}
      {on && allowances.length > 0 ? (
        <div className={styles.agentOrigins} aria-label="Allowed for this chat">
          {allowances.map((key) => (
            <span key={`k-${key}`} className={styles.chip} data-kind="allowance">
              {key}
              <button type="button" className={styles.noteClose} aria-label={`Stop allowing ${key}`} onClick={() => onRevoke(key)}><IconX size={12} /></button>
            </span>
          ))}
        </div>
      ) : null}
      {on && (blocked.length > 0 || allowed.length > 0 || offer) ? (
        <div className={styles.agentOrigins}>
          {blocked.map((b) => (
            <span key={`b-${b.origin}`} className={styles.chip} data-kind="blocked">
              Agent asked for {b.origin}
              <button type="button" className={styles.chipAction} onClick={() => onAllow(b.origin, true)}>Allow for this chat</button>
            </span>
          ))}
          {allowed.map((origin) => (
            <span key={`a-${origin}`} className={styles.chip}>
              {origin}
              <button type="button" className={styles.noteClose} aria-label={`Stop allowing ${origin}`} onClick={() => onAllow(origin, false)}><IconX size={12} /></button>
            </span>
          ))}
          {offer ? (
            <span className={styles.chip} data-kind="offer">
              Agents can’t see {offer}
              <button type="button" className={styles.chipAction} onClick={() => onAllow(offer, true)}>Allow</button>
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export default BrowserPanel;
