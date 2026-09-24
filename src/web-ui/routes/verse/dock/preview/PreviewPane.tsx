/**
 * dock/preview/PreviewPane.tsx — the chat dock's Preview (unit C4; SPEC-310C
 * §3). Rendered by C2's Dock through C0's `preview-pane` slot.
 *
 * WHAT IT SHOWS, in tabs:
 *   - a LOOPBACK dev server (http://localhost / 127.0.0.1 only) in an iframe,
 *     with back / forward / reload, an address bar, and a Desktop / 375 frame;
 *     anything else typed in the bar is offered as "Open in browser ↗";
 *   - a file this chat WROTE — HTML, SVG, image, PDF through a short-lived
 *     frame ticket and a CSP sandbox (an opaque origin: its own script runs,
 *     Verse's cookies and API stay out of reach); Markdown rendered here,
 *     sanitised, like a chat message.
 * An empty pane (or the + tab) is the launcher: the dev servers found in the
 * chat's folders — launch.json, package.json scripts, and anything already
 * listening inside them — and the chat's files. Start runs the server in a
 * TERMINAL tab (through the dock, never directly), then waits for its port
 * and opens it.
 *
 * WHAT THE FRAMES MAY DO. A dev server is a different origin (another port),
 * so `allow-same-origin` gives it ITS origin, never Verse's; the sandbox
 * still withholds top navigation, so a page can never navigate Verse away.
 * Verse's own address is refused outright. Back/forward walk the addresses
 * opened HERE: a cross-origin frame's own history is not readable.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { VersePreviewArtifact, VersePreviewArtifactKind, VersePreviewDevServer, VersePreviewTargetsResponse } from '../../../../data/api-types.js';
import { ApiError } from '../../../../data/client.js';
import { Button, IconButton } from '../../../../components/primitives/Button.js';
import { EmptyState } from '../../../../components/primitives/EmptyState.js';
import { Segmented } from '../../../../components/primitives/Segmented.js';
import { SkeletonLine } from '../../../../components/primitives/Skeleton.js';
import { IconExternalLink, IconPlus, IconX } from '../../../../components/primitives/icons.js';
import { MessageMarkdown } from '../../MessageMarkdown.js';
import { usePollWhileVisible, useSectionVisible } from '../../shell/section-visibility.js';
import type { PreviewOpenRequest, PreviewPaneProps } from '../../shell/slots.js';
import { useViewport } from '../../shell/viewport.js';
import {
  ArrowLeftGlyph,
  ArrowRightGlyph,
  DesktopGlyph,
  FileGlyph,
  PhoneGlyph,
  PlayGlyph,
  PreviewGlyph,
  ReloadGlyph,
  ServerGlyph,
} from '../terminal/terminal-icons.js';
import { formatBytes, parsePreviewAddress, previewApi, shortUrl, type PreviewAddress, type PreviewApi } from './preview-client.js';
import styles from './PreviewPane.module.css';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type PreviewTab =
  | { id: string; kind: 'launcher' }
  | { id: string; kind: 'url'; history: string[]; index: number; reloadKey: number }
  | { id: string; kind: 'artifact'; path: string; artifactKind: VersePreviewArtifactKind; reloadKey: number };

type Device = 'desktop' | 'phone';

interface Waiting {
  server: VersePreviewDevServer;
  since: number;
}

type ArtifactContent =
  | { status: 'loading' }
  | { status: 'frame'; src: string }
  | { status: 'text'; text: string }
  | { status: 'error'; message: string };

export interface PreviewPaneDeps {
  api: PreviewApi;
  /** `window.location.origin`: Verse's own address, which is never framed. */
  origin: () => string;
  now: () => number;
}

const DEFAULT_DEPS: PreviewPaneDeps = {
  api: previewApi,
  origin: () => window.location.origin,
  now: () => Date.now(),
};

/** How long Start waits for the server's port before saying so. */
export const PREVIEW_START_TIMEOUT_MS = 120_000;
const WAIT_POLL_MS = 2_000;
const LAUNCHER_POLL_MS = 5_000;
const STORAGE_PREFIX = 'ashlr.verse.preview.v1:';
const SOURCE_LABEL: Readonly<Record<VersePreviewDevServer['source'], string>> = {
  'launch-json': 'launch.json',
  'package-json': 'package.json',
  listening: 'running',
};
const KIND_LABEL: Readonly<Record<VersePreviewArtifactKind, string>> = {
  html: 'HTML',
  md: 'Markdown',
  svg: 'SVG',
  image: 'Image',
  pdf: 'PDF',
};

let lastHandledNonce = 0;
let idCounter = 0;
const nextId = (): string => `p${++idCounter}`;

/** Test hygiene. */
export function resetPreviewPaneForTest(): void {
  lastHandledNonce = 0;
  idCounter = 0;
}

function kindFromPath(path: string): VersePreviewArtifactKind | null {
  const ext = path.toLowerCase().slice(path.lastIndexOf('.'));
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.md' || ext === '.markdown') return 'md';
  if (ext === '.svg') return 'svg';
  if (ext === '.pdf') return 'pdf';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico'].includes(ext)) return 'image';
  return null;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path;
}

function tabLabel(tab: PreviewTab): string {
  if (tab.kind === 'launcher') return 'New tab';
  if (tab.kind === 'url') return shortUrl(tab.history[tab.index] ?? '');
  return baseName(tab.path);
}

function currentUrl(tab: PreviewTab | null): string | null {
  return tab?.kind === 'url' ? tab.history[tab.index] ?? null : null;
}

/** Tabs worth restoring after a reload (per viewer, per chat; never shared). */
function loadTabs(sessionId: string, origin: string): { tabs: PreviewTab[]; activeId: string | null; device: Device } | null {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${sessionId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { tabs?: unknown; active?: unknown; device?: unknown };
    const tabs: PreviewTab[] = [];
    let activeId: string | null = null;
    if (Array.isArray(parsed.tabs)) {
      parsed.tabs.slice(0, 12).forEach((t: unknown, i: number) => {
        if (!t || typeof t !== 'object') return;
        const rec = t as Record<string, unknown>;
        const id = nextId();
        if (rec['url'] && typeof rec['url'] === 'string' && parsePreviewAddress(rec['url'], origin).kind === 'loopback') {
          tabs.push({ id, kind: 'url', history: [rec['url']], index: 0, reloadKey: 0 });
        } else if (typeof rec['path'] === 'string') {
          const kind = kindFromPath(rec['path']);
          if (kind) tabs.push({ id, kind: 'artifact', path: rec['path'], artifactKind: kind, reloadKey: 0 });
          else return;
        } else {
          return;
        }
        if (parsed.active === i) activeId = id;
      });
    }
    return { tabs, activeId: activeId ?? tabs.at(-1)?.id ?? null, device: parsed.device === 'phone' ? 'phone' : 'desktop' };
  } catch {
    return null;
  }
}

function saveTabs(sessionId: string, tabs: readonly PreviewTab[], activeId: string | null, device: Device): void {
  try {
    const kept = tabs.filter((t) => t.kind !== 'launcher');
    localStorage.setItem(`${STORAGE_PREFIX}${sessionId}`, JSON.stringify({
      tabs: kept.map((t) => (t.kind === 'url' ? { url: t.history[t.index] } : t.kind === 'artifact' ? { path: t.path } : {})),
      active: kept.findIndex((t) => t.id === activeId),
      device,
    }));
  } catch {
    /* storage unavailable: tabs last for this page only */
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PreviewPane({ sessionId, roots, request, onOpenTerminal, visible, deps: depsOverride }: PreviewPaneProps & { deps?: Partial<PreviewPaneDeps> }) {
  const deps = useMemo<PreviewPaneDeps>(() => ({ ...DEFAULT_DEPS, ...depsOverride }), [depsOverride]);
  const sectionVisible = useSectionVisible();
  const shown = visible && sectionVisible;
  const compact = useViewport().compact;

  const [restored] = useState(() => loadTabs(sessionId, deps.origin()));
  const [tabs, setTabs] = useState<PreviewTab[]>(() => restored?.tabs ?? []);
  const [activeId, setActiveId] = useState<string | null>(() => restored?.activeId ?? null);
  const [device, setDevice] = useState<Device>(() => restored?.device ?? 'desktop');
  // The dock keeps this pane mounted across chats: another chat brings ITS
  // tabs. Reset during render (not in an effect) so the save below never
  // writes one chat's tabs under another chat's key.
  const [owner, setOwner] = useState(sessionId);
  const [targets, setTargets] = useState<VersePreviewTargetsResponse | null>(null);
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [addressNote, setAddressNote] = useState<PreviewAddress | null>(null);
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [content, setContent] = useState<ReadonlyMap<string, ArtifactContent>>(() => new Map());
  const [clock, setClock] = useState(() => deps.now());
  const mounted = useRef(true);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const addressRef = useRef<HTMLInputElement>(null);

  if (owner !== sessionId) {
    const next = loadTabs(sessionId, deps.origin());
    setOwner(sessionId);
    setTabs(next?.tabs ?? []);
    setActiveId(next?.activeId ?? null);
    setTargets(null);
    setWaiting(null);
    setNotice(null);
  }

  const active = tabs.find((t) => t.id === activeId) ?? null;
  const url = currentUrl(active);
  const showLauncher = !active || active.kind === 'launcher';

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (owner === sessionId) saveTabs(sessionId, tabs, activeId, device);
  }, [owner, sessionId, tabs, activeId, device]);

  // The address bar mirrors the tab shown.
  useEffect(() => {
    setAddress(active?.kind === 'url' ? (active.history[active.index] ?? '') : active?.kind === 'artifact' ? active.path : '');
    setAddressNote(null);
  }, [active]);

  // -------------------------------------------------------------------------
  // Targets
  // -------------------------------------------------------------------------

  const refreshTargets = useCallback(async (): Promise<VersePreviewTargetsResponse | null> => {
    try {
      const next = await deps.api.targets(sessionId);
      if (!mounted.current) return null;
      setTargets(next);
      setTargetsError(null);
      return next;
    } catch (err) {
      if (mounted.current) setTargetsError(err instanceof ApiError && err.detail ? err.detail : 'Dev servers and files could not be listed.');
      return null;
    }
  }, [deps.api, sessionId]);

  const fetchedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!shown || fetchedFor.current === sessionId) return;
    fetchedFor.current = sessionId;
    void refreshTargets();
  }, [shown, sessionId, refreshTargets]);

  usePollWhileVisible(() => { void refreshTargets(); }, waiting ? WAIT_POLL_MS : LAUNCHER_POLL_MS, {
    enabled: visible && (waiting !== null || showLauncher),
  });

  // -------------------------------------------------------------------------
  // Tabs
  // -------------------------------------------------------------------------

  const openUrl = useCallback((href: string, opts: { newTab?: boolean } = {}) => {
    setNotice(null);
    const current = tabs.find((t) => t.id === activeId);
    // Reuse the launcher tab the operator is looking at; otherwise focus an
    // existing tab on that address, or open a new one.
    if (!opts.newTab && current?.kind === 'launcher') {
      setTabs(tabs.map((t) => (t.id === current.id ? { id: t.id, kind: 'url', history: [href], index: 0, reloadKey: 0 } : t)));
      return;
    }
    const existing = tabs.find((t) => t.kind === 'url' && t.history[t.index] === href);
    if (existing && !opts.newTab) {
      setActiveId(existing.id);
      return;
    }
    const id = nextId();
    setTabs([...tabs, { id, kind: 'url', history: [href], index: 0, reloadKey: 0 }]);
    setActiveId(id);
  }, [tabs, activeId]);

  const navigateActive = useCallback((href: string) => {
    if (!active || active.kind !== 'url') {
      openUrl(href);
      return;
    }
    setTabs((prev) => prev.map((t) => {
      if (t.id !== active.id || t.kind !== 'url') return t;
      const history = [...t.history.slice(0, t.index + 1), href].slice(-50);
      return { ...t, history, index: history.length - 1 };
    }));
  }, [active, openUrl]);

  const openArtifact = useCallback((path: string, kind: VersePreviewArtifactKind) => {
    setNotice(null);
    const existing = tabs.find((t) => t.kind === 'artifact' && t.path === path);
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    const current = tabs.find((t) => t.id === activeId);
    if (current?.kind === 'launcher') {
      setTabs(tabs.map((t) => (t.id === current.id ? { id: t.id, kind: 'artifact', path, artifactKind: kind, reloadKey: 0 } : t)));
      return;
    }
    const id = nextId();
    setTabs([...tabs, { id, kind: 'artifact', path, artifactKind: kind, reloadKey: 0 }]);
    setActiveId(id);
  }, [tabs, activeId]);

  const newLauncherTab = () => {
    const existing = tabs.find((t) => t.kind === 'launcher');
    if (existing) {
      setActiveId(existing.id);
    } else {
      const id = nextId();
      setTabs((prev) => [...prev, { id, kind: 'launcher' }]);
      setActiveId(id);
    }
    void refreshTargets();
  };

  const closeTab = (tab: PreviewTab) => {
    const index = tabs.findIndex((t) => t.id === tab.id);
    const rest = tabs.filter((t) => t.id !== tab.id);
    setTabs(rest);
    setContent((prev) => { const next = new Map(prev); for (const key of prev.keys()) if (key.startsWith(`${tab.id}:`)) next.delete(key); return next; });
    if (activeId === tab.id) setActiveId((rest[index] ?? rest[index - 1] ?? null)?.id ?? null);
  };

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
  // Dev servers: open, start, wait
  // -------------------------------------------------------------------------

  const startServer = useCallback((server: VersePreviewDevServer) => {
    setNotice(null);
    onOpenTerminal({ root: server.root, devServerId: server.id });
    setWaiting({ server, since: deps.now() });
  }, [deps, onOpenTerminal]);

  const openServer = useCallback((server: VersePreviewDevServer) => {
    if (server.running) openUrl(server.url);
    else startServer(server);
  }, [openUrl, startServer]);

  // Waiting for a started server: open it the moment its port answers.
  useEffect(() => {
    if (!waiting || !targets) return;
    const up = targets.devServers.find((s) => s.running && (s.id === waiting.server.id || s.port === waiting.server.port));
    if (up) {
      setWaiting(null);
      openUrl(waiting.server.url);
      return;
    }
    if (deps.now() - waiting.since > PREVIEW_START_TIMEOUT_MS) {
      setWaiting(null);
      setNotice(`Nothing answered on port ${waiting.server.port} within 2 minutes. Check the terminal for errors.`);
    }
    // `clock` ticks every second while waiting, so the timeout is noticed
    // even when a poll brings nothing new.
  }, [targets, waiting, openUrl, deps, clock]);

  // The elapsed-time label while waiting (display only; the poll is separate).
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => setClock(deps.now()), 1_000);
    return () => clearInterval(id);
  }, [waiting, deps]);

  // -------------------------------------------------------------------------
  // Requests from the dock
  // -------------------------------------------------------------------------

  const handleRequest = useCallback(async (req: PreviewOpenRequest) => {
    if (req.url) {
      const parsed = parsePreviewAddress(req.url, deps.origin());
      if (parsed.kind === 'loopback') openUrl(parsed.url);
      else setAddressNote(parsed);
      return;
    }
    if (req.artifactPath) {
      const listed = targets?.artifacts.find((a) => a.path === req.artifactPath);
      const kind = listed?.kind ?? kindFromPath(req.artifactPath);
      if (kind) openArtifact(req.artifactPath, kind);
      else setNotice('That file cannot be previewed.');
      return;
    }
    if (req.devServerId) {
      const list = (await refreshTargets()) ?? targets;
      const server = list?.devServers.find((s) => s.id === req.devServerId);
      if (server) openServer(server);
      else setNotice('That dev server is no longer listed for this chat.');
    }
  }, [deps, openArtifact, openServer, openUrl, refreshTargets, targets]);

  useEffect(() => {
    if (!request || request.nonce <= lastHandledNonce) return;
    lastHandledNonce = request.nonce;
    void handleRequest(request);
  }, [request, handleRequest]);

  // -------------------------------------------------------------------------
  // Artifact content (visible tab only)
  // -------------------------------------------------------------------------

  const contentKey = active?.kind === 'artifact' ? `${active.id}:${active.reloadKey}` : null;
  useEffect(() => {
    if (!shown || !active || active.kind !== 'artifact' || !contentKey || content.has(contentKey)) return;
    const tab = active;
    const key = contentKey;
    setContent((prev) => new Map(prev).set(key, { status: 'loading' }));
    const load = tab.artifactKind === 'md'
      ? deps.api.text(sessionId, tab.path).then((text): ArtifactContent => ({ status: 'text', text }))
      : deps.api.ticket(sessionId, tab.path).then((ticket): ArtifactContent => ({ status: 'frame', src: ticket.url }));
    load.then(
      (value) => { if (mounted.current) setContent((prev) => new Map(prev).set(key, value)); },
      (err: unknown) => {
        const message = err instanceof ApiError && err.status === 404
          ? 'This file is no longer in the chat\'s folder.'
          : err instanceof ApiError && err.status === 413
            ? 'This file is larger than 5 MB, too large to preview.'
            : 'This file could not be loaded.';
        if (mounted.current) setContent((prev) => new Map(prev).set(key, { status: 'error', message }));
      },
    );
  }, [shown, active, contentKey, content, deps.api, sessionId]);

  // -------------------------------------------------------------------------
  // Toolbar
  // -------------------------------------------------------------------------

  const go = (delta: -1 | 1) => {
    if (!active || active.kind !== 'url') return;
    setTabs((prev) => prev.map((t) => (t.id === active.id && t.kind === 'url'
      ? { ...t, index: Math.min(t.history.length - 1, Math.max(0, t.index + delta)) }
      : t)));
  };

  const reload = () => {
    if (!active) return;
    if (active.kind === 'launcher') {
      void refreshTargets();
      return;
    }
    setTabs((prev) => prev.map((t) => (t.id === active.id && t.kind !== 'launcher' ? { ...t, reloadKey: t.reloadKey + 1 } : t)));
  };

  const submitAddress = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parsePreviewAddress(address, deps.origin());
    if (parsed.kind === 'loopback') {
      setAddressNote(null);
      if (active?.kind === 'url') navigateActive(parsed.url);
      else openUrl(parsed.url);
      return;
    }
    setAddressNote(parsed);
  };

  const onAddressKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    setAddress(url ?? (active?.kind === 'artifact' ? active.path : ''));
    setAddressNote(null);
    event.currentTarget.blur();
  };

  const canBack = active?.kind === 'url' && active.index > 0;
  const canForward = active?.kind === 'url' && active.index < active.history.length - 1;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className={styles.pane} data-compact={compact || undefined}>
      <div className={styles.strip}>
        <div className={styles.tabs} role="tablist" aria-label="Previews">
          {tabs.map((tab, index) => {
            const selected = tab.id === activeId;
            const label = tabLabel(tab);
            return (
              <div key={tab.id} className={styles.tab} data-selected={selected || undefined} role="presentation">
                <button
                  ref={(node) => { if (node) tabRefs.current.set(tab.id, node); else tabRefs.current.delete(tab.id); }}
                  type="button"
                  role="tab"
                  id={`preview-tab-${tab.id}`}
                  aria-selected={selected}
                  aria-controls="preview-panel"
                  tabIndex={selected ? 0 : -1}
                  className={styles.tabButton}
                  title={tab.kind === 'url' ? tab.history[tab.index] : tab.kind === 'artifact' ? tab.path : 'Choose what to preview'}
                  onClick={() => setActiveId(tab.id)}
                  onKeyDown={(event) => onTabKeyDown(event, index)}
                >
                  {tab.kind === 'artifact' ? <FileGlyph size={12} /> : tab.kind === 'url' ? <ServerGlyph size={12} /> : <PreviewGlyph size={12} />}
                  <span className={styles.tabTitle}>{label}</span>
                </button>
                <button type="button" className={styles.tabClose} aria-label={`Close preview ${label}`} title="Close"
                  onClick={() => closeTab(tab)}>
                  <IconX size={12} />
                </button>
              </div>
            );
          })}
        </div>
        <IconButton variant="ghost" size="sm" icon={<IconPlus />} aria-label="New preview tab" title="New preview tab"
          className={styles.newTab} onClick={newLauncherTab} />
      </div>

      <div className={styles.toolbar}>
        <div className={styles.nav}>
          <IconButton variant="ghost" size="sm" icon={<ArrowLeftGlyph />} aria-label="Back" disabled={!canBack} onClick={() => go(-1)} />
          <IconButton variant="ghost" size="sm" icon={<ArrowRightGlyph />} aria-label="Forward" disabled={!canForward} onClick={() => go(1)} />
          <IconButton variant="ghost" size="sm" icon={<ReloadGlyph />} aria-label={showLauncher ? 'Refresh the list' : 'Reload'}
            disabled={!active && showLauncher && targets === null} onClick={reload} />
        </div>
        <form className={styles.addressForm} onSubmit={submitAddress} role="search" aria-label="Preview address">
          <input
            ref={addressRef}
            className={styles.address}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={onAddressKeyDown}
            onFocus={(event) => event.currentTarget.select()}
            placeholder="localhost:5173"
            aria-label="Address"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            inputMode="url"
            readOnly={active?.kind === 'artifact'}
          />
        </form>
        {!compact ? (
          <Segmented<Device>
            aria-label="Frame width"
            size="sm"
            value={device}
            onChange={setDevice}
            options={[
              { value: 'desktop', label: <DesktopGlyph size={14} />, ariaLabel: 'Desktop width' },
              { value: 'phone', label: <PhoneGlyph size={14} />, ariaLabel: '375 px width' },
            ]}
          />
        ) : null}
        {url ? (
          <a className={styles.external} href={url} target="_blank" rel="noopener noreferrer" aria-label="Open in browser" title="Open in browser">
            <IconExternalLink />
          </a>
        ) : null}
      </div>

      {addressNote ? <AddressNote note={addressNote} onDismiss={() => setAddressNote(null)} /> : null}

      {waiting ? (
        <div className={styles.waiting} role="status">
          <span className={styles.pulse} aria-hidden="true" />
          <span className={styles.waitingText}>
            Starting <code>{waiting.server.command ?? waiting.server.label}</code> — waiting for {shortUrl(waiting.server.url)}
            {' · '}
            {Math.max(0, Math.round((clock - waiting.since) / 1000))}s
          </span>
          <Button size="sm" variant="ghost" onClick={() => setWaiting(null)}>Stop waiting</Button>
        </div>
      ) : null}

      {notice ? (
        <div className={styles.notice} role="alert">
          <span>{notice}</span>
          <button type="button" className={styles.noticeClose} aria-label="Dismiss" onClick={() => setNotice(null)}><IconX size={12} /></button>
        </div>
      ) : null}

      <div className={styles.body} id="preview-panel" role="tabpanel" aria-labelledby={active ? `preview-tab-${active.id}` : undefined}>
        {showLauncher ? (
          <Launcher
            targets={targets}
            error={targetsError}
            roots={roots}
            onOpenServer={openServer}
            onOpenArtifact={(a) => openArtifact(a.path, a.kind)}
            onRetry={() => void refreshTargets()}
            waitingId={waiting?.server.id ?? null}
          />
        ) : active?.kind === 'url' ? (
          <div className={styles.stage} data-device={device}>
            <iframe
              key={`${active.id}:${active.index}:${active.reloadKey}`}
              className={styles.frame}
              src={active.history[active.index]}
              title={`Preview of ${tabLabel(active)}`}
              // A dev server is another origin: allow-same-origin is ITS origin.
              // No allow-top-navigation: it can never navigate Verse away.
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
              referrerPolicy="no-referrer"
            />
            <p className={styles.frameHint}>
              Blank page? Some servers refuse to be framed.{' '}
              <a href={active.history[active.index]} target="_blank" rel="noopener noreferrer">Open in browser ↗</a>
            </p>
          </div>
        ) : active?.kind === 'artifact' ? (
          <ArtifactView tab={active} content={contentKey ? content.get(contentKey) ?? { status: 'loading' } : { status: 'loading' }} device={device} />
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function AddressNote({ note, onDismiss }: { note: PreviewAddress; onDismiss: () => void }) {
  return (
    <div className={styles.addressNote} role="status">
      {note.kind === 'external' ? (
        <span>
          Only local dev servers open here.{' '}
          <a href={note.url} target="_blank" rel="noopener noreferrer">Open in browser ↗</a>
        </span>
      ) : note.kind === 'self' ? (
        <span>That address is Verse itself.</span>
      ) : (
        <span>Enter a local address, like <code>localhost:5173</code>.</span>
      )}
      <button type="button" className={styles.noticeClose} aria-label="Dismiss" onClick={onDismiss}><IconX size={12} /></button>
    </div>
  );
}

function ArtifactView({ tab, content, device }: { tab: Extract<PreviewTab, { kind: 'artifact' }>; content: ArtifactContent; device: Device }) {
  if (content.status === 'loading') {
    return <div className={styles.loading} aria-busy="true"><SkeletonLine width="50%" /><SkeletonLine width="80%" /></div>;
  }
  if (content.status === 'error') {
    return <EmptyState compact tone="error" title="Preview unavailable" body={content.message} />;
  }
  if (content.status === 'text') {
    return (
      <article className={styles.markdown} aria-label={tab.path}>
        <MessageMarkdown text={content.text} />
      </article>
    );
  }
  if (tab.artifactKind === 'image') {
    return (
      <div className={styles.imageStage}>
        <img className={styles.image} src={content.src} alt={baseName(tab.path)} />
      </div>
    );
  }
  return (
    <div className={styles.stage} data-device={tab.artifactKind === 'pdf' ? 'desktop' : device}>
      <iframe
        key={content.src}
        className={styles.frame}
        src={content.src}
        title={`Preview of ${tab.path}`}
        // HTML and SVG run in a sandbox with NO same-origin (the server's CSP
        // says the same): their own script works, Verse stays out of reach.
        // PDF viewers refuse to run sandboxed (see preview.ts PDF_CSP).
        {...(tab.artifactKind === 'pdf' ? {} : { sandbox: 'allow-scripts' })}
        referrerPolicy="no-referrer"
      />
    </div>
  );
}

function Launcher({ targets, error, roots, onOpenServer, onOpenArtifact, onRetry, waitingId }: {
  targets: VersePreviewTargetsResponse | null;
  error: string | null;
  roots: readonly string[];
  onOpenServer: (server: VersePreviewDevServer) => void;
  onOpenArtifact: (artifact: VersePreviewArtifact) => void;
  onRetry: () => void;
  waitingId: string | null;
}) {
  if (!targets) {
    if (error) {
      return <EmptyState compact tone="error" title="Nothing to list" body={error}
        action={<Button size="sm" variant="subtle" onClick={onRetry}>Try again</Button>} />;
    }
    return <div className={styles.loading} aria-busy="true"><SkeletonLine width="35%" /><SkeletonLine width="70%" /><SkeletonLine width="60%" /></div>;
  }
  const multiRoot = roots.length > 1;
  if (targets.devServers.length === 0 && targets.artifacts.length === 0) {
    return (
      <EmptyState
        compact
        icon={<PreviewGlyph size={20} />}
        title="Nothing to preview yet"
        body="Start a dev server in the terminal, or ask for an HTML report. Local servers and the files this chat writes show up here."
      />
    );
  }
  return (
    <div className={styles.launcher}>
      <section className={styles.section} aria-labelledby="preview-servers-title">
        <h3 className={styles.sectionTitle} id="preview-servers-title">Dev servers</h3>
        {targets.devServers.length === 0 ? (
          <p className={styles.muted}>No dev server found in this chat's folders. Add one to <code>.claude/launch.json</code>, or start it in the terminal.</p>
        ) : (
          <ul className={styles.rows}>
            {targets.devServers.map((server) => (
              <li key={server.id} className={styles.row}>
                <span className={styles.dot} data-running={server.running || undefined} aria-hidden="true" />
                <span className={styles.rowMain}>
                  <span className={styles.rowTitle}>{server.label}</span>
                  <span className={styles.rowMeta}>
                    {shortUrl(server.url)} · {server.running ? 'running' : 'stopped'} · {SOURCE_LABEL[server.source]}
                    {multiRoot ? ` · ${baseName(server.root)}` : ''}
                  </span>
                  {/* What Start will type, before the click — a launch.json row's
                      label is only its name. Skipped when the label already is it. */}
                  {!server.running && server.command && server.command !== server.label ? (
                    <code className={styles.rowCommand}>{server.command}</code>
                  ) : null}
                </span>
                {server.running ? (
                  <Button size="sm" variant="subtle" onClick={() => onOpenServer(server)} aria-label={`Open ${server.label}`}>Open</Button>
                ) : (
                  <Button size="sm" variant="subtle" icon={<PlayGlyph size={12} />} busy={waitingId === server.id}
                    onClick={() => onOpenServer(server)} aria-label={`Start ${server.label}`}
                    title={`Runs ${server.command ?? server.label} in a terminal tab`}>
                    Start
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className={styles.section} aria-labelledby="preview-files-title">
        <h3 className={styles.sectionTitle} id="preview-files-title">This chat's files</h3>
        {targets.artifacts.length === 0 ? (
          <p className={styles.muted}>HTML, Markdown, SVG, images and PDFs this chat writes appear here.</p>
        ) : (
          <ul className={styles.rows}>
            {targets.artifacts.map((artifact) => {
              const tooBig = artifact.bytes > 5 * 1024 * 1024;
              return (
                <li key={artifact.path} className={styles.row}>
                  <FileGlyph size={14} className={styles.fileIcon} />
                  <span className={styles.rowMain}>
                    <span className={styles.rowTitle} title={artifact.path}>{artifact.path}</span>
                    <span className={styles.rowMeta}>{KIND_LABEL[artifact.kind]} · {formatBytes(artifact.bytes)}</span>
                  </span>
                  <Button size="sm" variant="subtle" disabled={tooBig} title={tooBig ? 'Larger than 5 MB' : undefined}
                    onClick={() => onOpenArtifact(artifact)} aria-label={`Open ${artifact.path}`}>
                    Open
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
