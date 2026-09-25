/**
 * routes/verse/dock/Dock.tsx — the chat's right-hand workbench: Terminal,
 * Preview, Review, Tasks and Context as tabs, one pane or two stacked
 * (SPEC-310C §3, unit C2; contracts: shell/dock-catalog.ts, shell/slots.tsx).
 *
 * THE CONTAINER, NOT THE PANES. Terminal and Preview are C4's, Review is
 * C5's; the dock renders them through C0's slots, so it never imports their
 * code (xterm and the diff viewer stay off the chat's critical path) and a
 * pane whose file has not landed simply has no tab. Tasks and Context are
 * C2's own and arrive as render props from the Chat section, which holds
 * the data they show.
 *
 * LAYOUT follows the window (dockPresentation):
 *   ≥ 1024px   a column right of the transcript, 320px … 60% of the window,
 *              resized by dragging its left edge or with ←/→ on that edge;
 *   480–1023   a sheet over the chat from the right;
 *   < 480      a bottom sheet, 75vh.
 * Two panes split vertically ("Preview over Terminal"), their boundary
 * dragged or moved with ↑/↓.
 *
 * KEEP-ALIVE. A pane stays mounted from the moment its tab opens until the
 * tab closes — hidden, not unmounted, when another tab is on top — so a
 * terminal keeps its scrollback and a preview its page. Each pane is told
 * whether it is visible, so it can stop timers while hidden.
 *
 * State (open, tabs, split, width) lives in dock-store.ts and persists with
 * the shell's v3 blob.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { EmptyState } from '../../../components/primitives/EmptyState.js';
import { ActionMenu, anchorBelow, type ActionMenuItem, type MenuAnchor } from '../chat/ActionMenu.js';
import { findCommand, formatChord } from '../shell/command-catalog.js';
import { DOCK_LAYOUT, DOCK_PANES, clampDockWidth, type DockPaneId, type DockPresentation } from '../shell/dock-catalog.js';
import { DiffPaneSlot, PreviewPaneSlot, TerminalPaneSlot, type TurnFileChange } from '../shell/slots.js';
import { DOCK_PANE_LABEL, isPaneAvailable } from './dock-panes.js';
import {
  closeDock,
  closeDockTab,
  openDockPane,
  requestTerminalBelow,
  setDockSplitRatio,
  setDockWidth,
  splitDock,
  useDock,
} from './dock-store.js';
import { CloseGlyph, DOCK_PANE_GLYPH, SplitGlyph } from './dock-icons.js';
import styles from './Dock.module.css';

export interface DockProps {
  presentation: DockPresentation;
  /** Window width, for the 60% cap. */
  windowWidth: number;
  /** The width the column may actually take (after the transcript's floor); column presentation only. */
  columnWidth: number;
  sessionId: string | null;
  roots: readonly string[];
  turnFiles: readonly TurnFileChange[];
  /** Terminal ▸ Send selection to chat: already fenced. */
  onSendToChat: (text: string) => void;
  /** Review ▸ Add to message: `path:line: note`. */
  onAddToMessage: (text: string) => void;
  /** C2's own panes. */
  renderTasks: (visible: boolean) => ReactNode;
  renderContext: (visible: boolean) => ReactNode;
}

export { DOCK_PANE_LABEL, isPaneAvailable };

/** A catalog command's chord as this platform prints it ("⌘N" / "Ctrl+N"), or null when it has none. */
function chordOf(id: string): string | null {
  const chord = findCommand(id)?.keys[0];
  return chord ? formatChord(chord) : null;
}

const KEY_STEP = 16;
const KEY_STEP_COARSE = 64;
const RATIO_STEP = 0.05;

export function Dock(props: DockProps) {
  const { presentation, windowWidth, columnWidth } = props;
  const { state, requests } = useDock();
  const panelRef = useRef<HTMLElement>(null);
  const tabRefs = useRef(new Map<DockPaneId, HTMLButtonElement>());
  const idBase = useId();
  const [menu, setMenu] = useState<{ kind: 'add' | 'split'; anchor: MenuAnchor; from: HTMLElement } | null>(null);
  // Panes mount on first show and stay mounted while their tab is open.
  const [mounted, setMounted] = useState<ReadonlySet<DockPaneId>>(() => new Set(state.open && state.active ? [state.active] : []));

  const tabs = state.tabs.filter(isPaneAvailable);
  const active = state.active !== null && tabs.includes(state.active) ? state.active : tabs[0] ?? null;
  const split = state.splitWith !== null && tabs.includes(state.splitWith) && state.splitWith !== active ? state.splitWith : null;
  const open = state.open && active !== null;
  const sheet = presentation !== 'column';

  useEffect(() => {
    if (!open) return;
    setMounted((prev) => {
      const want = [active, split].filter((p): p is DockPaneId => p !== null);
      const next = new Set([...prev].filter((p) => tabs.includes(p)));
      for (const p of want) next.add(p);
      if (next.size === prev.size && [...next].every((p) => prev.has(p))) return prev;
      return next;
    });
  }, [open, active, split, tabs.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps -- tabs is compared by content

  // A sheet takes focus when it opens and gives it back when it closes; a
  // column does not steal focus from the composer.
  useEffect(() => {
    if (!open || !sheet) return undefined;
    const before = document.activeElement as HTMLElement | null;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      if (before && document.contains(before)) before.focus({ preventScroll: true });
    };
  }, [open, sheet]);

  const onSheetKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (!sheet) return;
    // Esc belongs to a terminal (vim, less, a REPL) when focus is in one.
    const inTerminal = event.target instanceof Element && event.target.closest('[data-dock-pane="terminal"]') !== null;
    if (event.key === 'Escape' && !inTerminal && !event.defaultPrevented) {
      event.preventDefault();
      closeDock();
      return;
    }
    if (event.key !== 'Tab' || inTerminal) return;
    const node = panelRef.current;
    if (!node) return;
    const focusable = Array.from(node.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'))
      .filter((el) => !el.closest('[hidden]'));
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }, [sheet]);

  if (!open) return null;

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, pane: DockPaneId) {
    const i = tabs.indexOf(pane);
    let next: DockPaneId | undefined;
    if (event.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
    else if (event.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (event.key === 'Home') next = tabs[0];
    else if (event.key === 'End') next = tabs[tabs.length - 1];
    else if ((event.key === 'Delete' || event.key === 'Backspace') && tabs.length > 0) {
      event.preventDefault();
      closeDockTab(pane);
      return;
    }
    if (!next) return;
    event.preventDefault();
    openDockPane(next);
    tabRefs.current.get(next)?.focus();
  }

  const closedPanes = DOCK_PANES.map((p) => p.id).filter((id) => isPaneAvailable(id) && !tabs.includes(id));
  const addItems: ActionMenuItem[] = closedPanes.map((id) => ({
    id,
    label: DOCK_PANE_LABEL[id],
    icon: DOCK_PANE_GLYPH[id]({}),
    onSelect: () => openDockPane(id),
  }));
  const splitCandidates = DOCK_PANES.map((p) => p.id).filter((id) => isPaneAvailable(id) && id !== active);
  const splitItems: ActionMenuItem[] = [
    ...splitCandidates.map((id) => ({
      id,
      label: `${DOCK_PANE_LABEL[id]} below`,
      icon: DOCK_PANE_GLYPH[id]({}),
      onSelect: () => splitDock(id),
    })),
    ...(split ? [{ id: 'unsplit', label: 'One pane', separated: true, onSelect: () => splitDock(null) }] : []),
  ];

  const toggleChord = chordOf('dock.toggle');
  const width = presentation === 'column' ? columnWidth : clampDockWidth(state.width, windowWidth);
  const label = `Dock: ${DOCK_PANE_LABEL[active!]}${split ? ` over ${DOCK_PANE_LABEL[split]}` : ''}`;

  const panel = (
    <aside
      ref={panelRef}
      className={styles.dock}
      data-presentation={presentation}
      data-split={split ? 'true' : undefined}
      aria-label={label}
      role={sheet ? 'dialog' : 'complementary'}
      aria-modal={sheet ? true : undefined}
      tabIndex={-1}
      style={presentation === 'bottom-sheet' ? { height: `${DOCK_LAYOUT.bottomSheetHeightVh}vh` } : { width }}
      onKeyDown={onSheetKeyDown}
    >
      {presentation === 'column' ? <WidthHandle width={width} windowWidth={windowWidth} /> : null}
      {presentation === 'bottom-sheet' ? <span className={styles.grabber} aria-hidden="true" /> : null}
      <div className={styles.head}>
        <div className={styles.tabs} role="tablist" aria-label="Dock panes">
          {tabs.map((pane) => {
            const Icon = DOCK_PANE_GLYPH[pane];
            const selected = pane === active;
            const below = pane === split;
            return (
              <div key={pane} className={styles.tabWrap} data-selected={selected || undefined} data-below={below || undefined}>
                <button
                  ref={(node) => { if (node) tabRefs.current.set(pane, node); else tabRefs.current.delete(pane); }}
                  type="button"
                  role="tab"
                  id={`${idBase}-tab-${pane}`}
                  aria-selected={selected}
                  aria-controls={`${idBase}-pane-${pane}`}
                  tabIndex={selected ? 0 : -1}
                  className={styles.tab}
                  onClick={() => openDockPane(pane)}
                  onKeyDown={(event) => onTabKeyDown(event, pane)}
                  title={below ? `${DOCK_PANE_LABEL[pane]} (lower pane)` : undefined}
                >
                  <Icon size={14} />
                  <span className={styles.tabLabel}>{DOCK_PANE_LABEL[pane]}</span>
                </button>
                <button type="button" className={styles.tabClose} aria-label={`Close ${DOCK_PANE_LABEL[pane]}`}
                  title={`Close ${DOCK_PANE_LABEL[pane]}`} tabIndex={-1} onClick={() => closeDockTab(pane)}>
                  <CloseGlyph size={12} />
                </button>
              </div>
            );
          })}
        </div>
        <div className={styles.headActions}>
          {/* Always drawn (disabled when every pane is open) so the actions
              never shift when the last closed pane is added back. */}
          <button type="button" className={styles.iconButton} aria-label="Add a pane"
            title={closedPanes.length > 0 ? 'Add a pane' : 'Every pane is already open'} aria-haspopup="menu"
            aria-expanded={menu?.kind === 'add'} disabled={closedPanes.length === 0}
            onClick={(event) => setMenu({ kind: 'add', anchor: anchorBelow(event.currentTarget), from: event.currentTarget })}>
            <span className={styles.plus} aria-hidden="true">+</span>
          </button>
          {presentation !== 'bottom-sheet' && splitItems.length > 0 ? (
            <button type="button" className={styles.iconButton} aria-label={split ? 'Split: change or undo' : 'Split the dock'}
              title={split ? 'Change the split' : 'Split: show a second pane below'} aria-haspopup="menu" aria-expanded={menu?.kind === 'split'}
              aria-pressed={split !== null}
              onClick={(event) => setMenu({ kind: 'split', anchor: anchorBelow(event.currentTarget), from: event.currentTarget })}>
              <SplitGlyph size={14} />
            </button>
          ) : null}
          <button type="button" className={styles.iconButton} aria-label="Close the dock"
            title={`Close the dock${toggleChord ? ` (${toggleChord})` : ''}`} onClick={closeDock}>
            <CloseGlyph size={14} />
          </button>
        </div>
      </div>

      <div className={styles.body}>
        {tabs.filter((p) => mounted.has(p) || p === active || p === split).map((pane) => {
          const shown = pane === active || (pane === split && presentation !== 'bottom-sheet');
          const position = pane === active ? 'top' : pane === split ? 'bottom' : 'hidden';
          return (
            <div
              key={pane}
              id={`${idBase}-pane-${pane}`}
              role="tabpanel"
              aria-labelledby={`${idBase}-tab-${pane}`}
              className={styles.pane}
              data-dock-pane={pane}
              data-position={shown ? position : 'hidden'}
              hidden={!shown}
              inert={!shown}
              style={shown && split && presentation !== 'bottom-sheet'
                ? { flexBasis: `${(position === 'top' ? state.splitRatio : 1 - state.splitRatio) * 100}%`, order: position === 'top' ? 0 : 2 }
                : undefined}
            >
              <DockPane pane={pane} visible={shown} {...props} requests={requests} />
            </div>
          );
        })}
        {split && presentation !== 'bottom-sheet' ? <SplitHandle ratio={state.splitRatio} lower={DOCK_PANE_LABEL[split]} /> : null}
      </div>

      {menu ? (
        <ActionMenu
          label={menu.kind === 'add' ? 'Add a pane' : 'Split the dock'}
          items={menu.kind === 'add' ? addItems : splitItems}
          anchor={menu.anchor}
          returnFocus={menu.from}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </aside>
  );

  if (!sheet) return panel;
  return (
    <div className={styles.sheetLayer} data-presentation={presentation}>
      <button type="button" className={styles.scrim} aria-label="Close the dock" tabIndex={-1} onClick={closeDock} />
      {panel}
    </div>
  );
}

function DockPane({ pane, visible, sessionId, roots, turnFiles, onSendToChat, onAddToMessage, renderTasks, renderContext, requests }:
  DockProps & { pane: DockPaneId; visible: boolean; requests: ReturnType<typeof useDock>['requests'] }) {
  if (pane === 'tasks') return <>{renderTasks(visible)}</>;
  if (pane === 'context') return <>{renderContext(visible)}</>;
  if (sessionId === null) {
    const newChat = chordOf('chat.new');
    return (
      <EmptyState compact title={`Open a chat to use ${DOCK_PANE_LABEL[pane]}`}
        body={`Pick a chat in the sidebar${newChat ? ` or start one with ${newChat}` : ''}. ${DOCK_PANE_LABEL[pane]} works in that chat's folders.`} />
    );
  }
  switch (pane) {
    case 'terminal':
      return <TerminalPaneSlot sessionId={sessionId} roots={roots} request={requests.terminal} onSendToChat={onSendToChat} visible={visible} />;
    case 'preview':
      return (
        // Dev-server Start: Terminal opens BELOW Preview, so the page appears
        // on top when its port answers (SPEC-310C acceptance step 3).
        <PreviewPaneSlot sessionId={sessionId} roots={roots} request={requests.preview} visible={visible}
          onOpenTerminal={requestTerminalBelow} />
      );
    case 'diff':
      return <DiffPaneSlot sessionId={sessionId} roots={roots} request={requests.diff} turnFiles={turnFiles} onAddToMessage={onAddToMessage} visible={visible} />;
    default:
      return null;
  }
}

/** The column's left edge: drag, or ←/→ (⇧ for coarse), double-click for the default. */
function WidthHandle({ width, windowWidth }: { width: number; windowWidth: number }) {
  const max = Math.max(DOCK_LAYOUT.minWidth, Math.floor(windowWidth * DOCK_LAYOUT.maxWidthFraction));
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
    document.body.setAttribute('data-verse-resizing', 'true');
  }
  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start) return;
    // The dock grows leftward: moving the edge left by N widens it by N.
    setDockWidth(clampDockWidth(start.startWidth + (start.startX - event.clientX), windowWidth));
  }
  function end() {
    drag.current = null;
    setDragging(false);
    document.body.removeAttribute('data-verse-resizing');
  }
  useEffect(() => () => document.body.removeAttribute('data-verse-resizing'), []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? KEY_STEP_COARSE : KEY_STEP;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = width + step;
    else if (event.key === 'ArrowRight') next = width - step;
    else if (event.key === 'Home') next = DOCK_LAYOUT.minWidth;
    else if (event.key === 'End') next = max;
    if (next === null) return;
    event.preventDefault();
    setDockWidth(clampDockWidth(next, windowWidth));
  }

  return (
    <div className={styles.widthHandle} role="separator" aria-orientation="vertical" aria-label="Resize the dock"
      aria-valuemin={DOCK_LAYOUT.minWidth} aria-valuemax={max} aria-valuenow={Math.round(width)} tabIndex={0}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
      onDoubleClick={() => setDockWidth(DOCK_LAYOUT.defaultWidth)} onKeyDown={onKeyDown} />
  );
}

/** The boundary between the two stacked panes: drag, or ↑/↓. */
function SplitHandle({ ratio, lower }: { ratio: number; lower: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ top: number; height: number } | null>(null);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const body = ref.current?.parentElement;
    if (!body) return;
    event.preventDefault();
    const rect = body.getBoundingClientRect();
    drag.current = { top: rect.top, height: rect.height };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || d.height <= 0) return;
    setDockSplitRatio((event.clientY - d.top) / d.height);
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowUp') { event.preventDefault(); setDockSplitRatio(ratio - RATIO_STEP); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setDockSplitRatio(ratio + RATIO_STEP); }
  }
  return (
    <div ref={ref} className={styles.splitHandle} role="separator" aria-orientation="horizontal"
      aria-label={`Resize: ${lower} below`} aria-valuemin={Math.round(DOCK_LAYOUT.splitRatio.min * 100)}
      aria-valuemax={Math.round(DOCK_LAYOUT.splitRatio.max * 100)} aria-valuenow={Math.round(ratio * 100)} tabIndex={0}
      style={{ order: 1 }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
      onDoubleClick={() => setDockSplitRatio(DOCK_LAYOUT.splitRatio.default)} onKeyDown={onKeyDown} />
  );
}
