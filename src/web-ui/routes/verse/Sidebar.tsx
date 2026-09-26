/**
 * routes/verse/Sidebar.tsx — the chat list (3.10, SPEC-310C §2; model:
 * chat/sidebar-model.ts).
 *
 *   [search…………………………] [+] [⫿]
 *   (All) (Running 2) (Needs you 1) (Pinned 3)
 *   SAVED PROJECTS …
 *   PINNED
 *   │ Fix the login bug                 ● 1m 02s
 *   │   npm test
 *   HUB
 *   │ Write the docs                          •      ← unread
 *   │ Migrate the store                       !      ← failed
 *   ▸ ARCHIVED 12
 *
 * One row is a 2px engine tick, the title and ONE status — the most urgent
 * that applies: a pulse with the elapsed time (running), a failure mark, an
 * unread dot, or how long ago. A running row adds a muted second line from
 * activity: the command it is running, or the tail of what it is thinking.
 * Every status is a glyph with an accessible name, at least 11px, and never
 * colour alone (DESIGN §6). The row's tooltip spells the status out too
 * ("… · Last turn failed"), so the "!" is explained to a sighted pointer user
 * as well as to a screen reader.
 *
 * Group headings are the project's display name as it is on disk (never
 * upper-cased: a folder slug shouted in caps is a different-looking name),
 * with the full path as their tooltip. ↑/↓ move between chats, Home/End jump
 * to the ends, Enter opens; ↓ from the search field lands on the first chat.
 *
 * Hover a row (or right-click it, or press Shift+F10 / the menu key on it)
 * for pin, archive, rename, hand off and delete. Pin and archive need C1's
 * session-meta route; on a server without it they are shown disabled with
 * the reason, rather than hidden.
 *
 * ONE SEARCH FIELD, TWO ANSWERS (V3.9): titles and projects filter instantly
 * on the client; underneath, SessionSearch lists chats whose MESSAGES match
 * (a scan on this machine, nothing sent to a model).
 *
 * Saved projects sit above the chats: the registry the operator writes
 * deliberately (workspaces/SavedProjects.tsx).
 */
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import type { VerseProject, VerseSeat, VerseSession } from '../../data/api-types.js';
import type { VerseActivityResponse, VerseSessionMetaResponse } from '../../../core/verse/workbench-types.js';
import type { QueryStatus } from '../../data/cache.js';
import { Button } from '../../components/primitives/Button.js';
import { Dialog } from '../../components/primitives/Dialog.js';
import { RefreshIndicator } from '../../components/primitives/RefreshIndicator.js';
import { SkeletonLine } from '../../components/primitives/Skeleton.js';
import { Tooltip } from '../../components/primitives/Tooltip.js';
import { ActionMenu, type ActionMenuItem, type MenuAnchor } from './chat/ActionMenu.js';
import { LiveTimer } from './chat/LiveTimer.js';
import {
  buildSidebar,
  SIDEBAR_FILTERS,
  SIDEBAR_FILTER_LABEL,
  type SidebarFilter,
  type SidebarGroup,
  type SidebarRow,
} from './chat/sidebar-model.js';
import { ArchiveGlyph, HandoffGlyph, MoreGlyph, PinGlyph, RenameGlyph, TrashGlyph } from './dock/dock-icons.js';
import { PlusIcon, SearchIcon, SidebarIcon } from './verse-icons.js';
import { seatSubscription } from './seat-subscription.js';
import { formatRelative, seatById, seatPillLabel } from './verse-model.js';
import { SavedProjects } from './workspaces/SavedProjects.js';
import { findCommand, formatChord } from './shell/command-catalog.js';
import styles from './Sidebar.module.css';

export interface SidebarProps {
  sessions: readonly VerseSession[];
  sessionsStatus: QueryStatus;
  sessionsError: string | null;
  projects: readonly VerseProject[];
  seats: readonly VerseSeat[];
  selectedId: string | null;
  query: string;
  onQuery: (value: string) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRetry: () => void;
  onCollapse: () => void;
  /** Called only once the operator confirms the footer's "Disconnect from hub" dialog. */
  onDisconnect: () => void;
  /** 3.10 — C1's activity (null: not on this server / not answered yet). */
  activity?: VerseActivityResponse | null;
  /** 3.10 — C1's per-chat meta (null: not on this server / not answered yet). */
  meta?: VerseSessionMetaResponse | null;
  /**
   * Why the per-chat meta could not be read (the server's sentence), when it
   * failed rather than being absent. Pin/Archive then name THIS as their
   * reason instead of "not available on this server yet".
   */
  metaError?: string | null;
  /** Turn counts this tab has seen, per chat. */
  localSeen?: ReadonlyMap<string, number>;
  /** Row actions (3.10). Absent → the row menu is not offered. */
  actions?: SidebarRowActions;
}

export interface SidebarRowActions {
  setPinned: (sessionId: string, pinned: boolean) => void;
  setArchived: (sessionId: string, archived: boolean) => void;
  rename: (sessionId: string, title: string) => Promise<boolean>;
  handoff: (sessionId: string) => void;
  requestDelete: (sessionId: string) => void;
  /** False on a read-only server: every write is shown disabled with this reason. */
  dispatchEnabled: boolean;
}

const NO_SEEN: ReadonlyMap<string, number> = new Map();

// Message search loads with the first query, not with the chat list.
const SessionSearch = lazy(() => import('./context/SessionSearch.js').then((m) => ({ default: m.SessionSearch })));

export function Sidebar(props: SidebarProps) {
  const { sessions, sessionsStatus, sessionsError, projects, seats, selectedId, query, onQuery, onSelect, onNew,
    onRetry, onCollapse, onDisconnect, activity = null, meta = null, metaError = null, localSeen = NO_SEEN, actions } = props;
  const searchId = useId();
  const newChatShortcut = findCommand('chat.new')?.keys[0];
  const sidebarShortcut = findCommand('chat.sidebar')?.keys[0];
  const newChatHint = newChatShortcut ? formatChord(newChatShortcut) : null;
  const sidebarHint = sidebarShortcut ? formatChord(sidebarShortcut) : null;
  const [filter, setFilter] = useState<SidebarFilter>('all');
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ row: SidebarRow; anchor: MenuAnchor; from: HTMLElement } | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const disconnectTitleId = useId();
  const disconnectCancelRef = useRef<HTMLButtonElement>(null);
  const model = useMemo(
    () => buildSidebar({ sessions, projects, query, filter, activity, meta, localSeen, selectedId }),
    [sessions, projects, query, filter, activity, meta, localSeen, selectedId],
  );
  const loading = sessionsStatus === 'loading' || (sessionsStatus === 'idle' && sessions.length === 0);
  const searching = query.trim().length > 0;
  const scrollRef = useRef<HTMLDivElement>(null);

  /** ↓ from the search field: into the list, on its first chat. */
  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'ArrowDown') return;
    const first = scrollRef.current?.querySelector<HTMLElement>(ROW_SELECTOR);
    if (!first) return;
    event.preventDefault();
    first.focus();
  }

  function openMenu(row: SidebarRow, anchor: MenuAnchor, from: HTMLElement) {
    if (!actions) return;
    setMenu({ row, anchor, from });
  }

  return (
    <nav className={styles.sidebar} aria-label="Chats">
      <div className={styles.head}>
        {/* Draggable strip under the overlay title bar; zero-height in a browser. */}
        <div className={styles.headDragStrip} aria-hidden="true" />
        <label className={styles.search} htmlFor={searchId}>
          <span className={styles.searchIcon} aria-hidden="true"><SearchIcon /></span>
          <span className="visually-hidden">Search chats and messages</span>
          <input id={searchId} type="search" value={query} placeholder="Search chats" autoComplete="off"
            onChange={(event) => onQuery(event.target.value)} onKeyDown={onSearchKeyDown} />
        </label>
        <Tooltip label="New chat" shortcut={newChatHint ?? undefined} placement="bottom">
          <button type="button" className={styles.iconButton} onClick={onNew} aria-label="New chat">
            <PlusIcon />
          </button>
        </Tooltip>
        <Tooltip label="Hide chat list" shortcut={sidebarHint ?? undefined} placement="bottom">
          <button type="button" className={styles.iconButton} onClick={onCollapse} aria-label="Hide chat list">
            <SidebarIcon />
          </button>
        </Tooltip>
        {sessionsStatus === 'refreshing' ? <RefreshIndicator label="Refreshing chats" /> : null}
      </div>

      <FilterChips value={filter} counts={model.counts} onChange={setFilter} />

      <div ref={scrollRef} className={styles.scroll} onKeyDown={onRowsKeyDown}>
        <SavedProjects />
        {loading ? (
          <div className={styles.skeleton} aria-busy="true">
            <SkeletonLine width="48%" /><SkeletonLine width="86%" /><SkeletonLine width="74%" />
            <SkeletonLine width="40%" /><SkeletonLine width="80%" />
          </div>
        ) : sessionsStatus === 'error' && sessions.length === 0 ? (
          <div role="alert" className={styles.error}>
            <p>{sessionsError ?? 'Could not load chats.'}</p>
            <button type="button" onClick={onRetry}>Retry</button>
          </div>
        ) : model.groups.length === 0 ? (
          <EmptyList query={query} filter={filter} hasSessions={sessions.length > 0} newChatHint={newChatHint} onClearQuery={() => onQuery('')}
            onClearFilter={() => setFilter('all')} onNew={onNew} />
        ) : model.groups.map((group) => (
          <GroupView key={group.id} group={group} seats={seats} selectedId={selectedId} renaming={renaming}
            open={group.kind !== 'archived' || archivedOpen || searching || filter !== 'all'}
            onToggle={group.kind === 'archived' ? () => setArchivedOpen((v) => !v) : undefined}
            onSelect={onSelect} onMenu={actions ? openMenu : undefined}
            onRenameDone={async (row, title) => {
              setRenaming(null);
              if (!actions || !title || title === row.session.title) return;
              await actions.rename(row.session.id, title);
            }} />
        ))}
        {searching ? (
          <Suspense fallback={null}>
            <SessionSearch query={query} onOpenSession={onSelect} selectedId={selectedId} />
          </Suspense>
        ) : null}
      </div>

      <footer className={styles.footer}>
        {/* clearReadSession (data/auth-store.ts): ends this window's read
            session — the cookie, the remembered token, the mutation hold,
            cached data and the composer's drafts — and shows the token screen
            again. The chats themselves stay on the hub. Said in the label and
            the tooltip, because "Disconnect" alone reads like a network blip.
            It throws away unsent drafts, so — like Settings ▸ Connection — it
            asks first; onDisconnect runs only from the dialog's red button. */}
        <Tooltip label="Signs this window out: clears cached chats and unsent drafts here. Chats stay on the hub." placement="top">
          <button type="button" onClick={() => setConfirmDisconnect(true)} className={styles.footerButton}
            aria-haspopup="dialog">Disconnect from hub</button>
        </Tooltip>
      </footer>

      {/* The same confirm as Settings ▸ Connection (ConnectionPanel.tsx): the
          Dialog primitive, focus on CANCEL so Enter-Enter keeps the session,
          Escape and the backdrop cancel, and focus returns to the footer
          button. */}
      <Dialog open={confirmDisconnect} onClose={() => setConfirmDisconnect(false)} titleId={disconnectTitleId}
        title="Disconnect from this hub?" initialFocusRef={disconnectCancelRef}
        description="Unsent drafts in open chats will be cleared. Your chats stay on the hub; you will need the read token to reconnect.">
        <div className={styles.confirmActions}>
          <Button ref={disconnectCancelRef} variant="subtle" onClick={() => setConfirmDisconnect(false)}>Cancel</Button>
          <Button variant="danger" onClick={() => {
            setConfirmDisconnect(false);
            onDisconnect();
          }}>Disconnect</Button>
        </div>
      </Dialog>

      {menu && actions ? (
        <ActionMenu label={`Actions for ${menu.row.session.title || 'Untitled chat'}`} anchor={menu.anchor}
          returnFocus={menu.from} onClose={() => setMenu(null)}
          items={rowMenuItems(menu.row, actions, model.metaAvailable, metaError, () => setRenaming(menu.row.session.id))} />
      ) : null}
    </nav>
  );
}

/** Every chat row in the list (search results and saved projects are not rows). */
const ROW_SELECTOR = '[data-focus-key^="verse-session:"]';

/** ↑/↓ between chat rows, Home/End to the ends. Enter is the row button's own. */
function onRowsKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
  const target = event.target as HTMLElement;
  if (!target.matches(ROW_SELECTOR)) return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(ROW_SELECTOR)];
  const at = rows.indexOf(target);
  let next: HTMLElement | undefined;
  if (event.key === 'ArrowDown') next = rows[at + 1];
  else if (event.key === 'ArrowUp') next = rows[at - 1];
  else if (event.key === 'Home') next = rows[0];
  else if (event.key === 'End') next = rows[rows.length - 1];
  else return;
  event.preventDefault();
  next?.focus();
}

/** The row's status in words, for its tooltip (the glyph's accessible name, said to everyone). */
function rowStatusWords(status: SidebarRow['status']): string | null {
  switch (status.kind) {
    case 'running': return 'Running';
    case 'failed': return 'Last turn failed';
    case 'unread': return `${status.newTurns} new turn${status.newTurns === 1 ? '' : 's'}`;
    default: return null;
  }
}

function rowMenuItems(row: SidebarRow, actions: SidebarRowActions, metaAvailable: boolean, metaError: string | null,
  startRename: () => void): ActionMenuItem[] {
  const id = row.session.id;
  const running = row.status.kind === 'running';
  const writeReason = !actions.dispatchEnabled ? 'This server was started without dispatch.' : null;
  const metaReason = writeReason
    ?? (metaAvailable ? null : metaError ? `Pins and archive unavailable. ${metaError}` : 'Not available on this server yet.');
  return [
    {
      id: 'pin',
      label: row.pinned ? 'Unpin' : 'Pin',
      icon: <PinGlyph size={14} />,
      disabled: metaReason !== null,
      reason: metaReason,
      onSelect: () => actions.setPinned(id, !row.pinned),
    },
    {
      id: 'archive',
      label: row.archived ? 'Unarchive' : 'Archive',
      icon: <ArchiveGlyph size={14} />,
      disabled: metaReason !== null,
      reason: metaReason,
      onSelect: () => actions.setArchived(id, !row.archived),
    },
    { id: 'rename', label: 'Rename', icon: <RenameGlyph size={14} />, disabled: writeReason !== null, reason: writeReason, onSelect: startRename },
    {
      id: 'handoff',
      label: 'Continue in a fresh chat…',
      icon: <HandoffGlyph size={14} />,
      disabled: writeReason !== null || running,
      reason: writeReason ?? (running ? 'Available when its turn finishes.' : null),
      onSelect: () => actions.handoff(id),
    },
    {
      id: 'delete',
      label: 'Delete…',
      icon: <TrashGlyph size={14} />,
      danger: true,
      separated: true,
      disabled: writeReason !== null || running,
      reason: writeReason ?? (running ? 'Stop its turn before deleting.' : null),
      onSelect: () => actions.requestDelete(id),
    },
  ];
}

/**
 * All / Running / Needs you / Pinned — one radio group, ONE tab stop, ←/→
 * between the options (the list below is where Tab should go next).
 */
function FilterChips({ value, counts, onChange }: { value: SidebarFilter; counts: Record<SidebarFilter, number>; onChange: (f: SidebarFilter) => void }) {
  const refs = useRef(new Map<SidebarFilter, HTMLButtonElement>());
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const i = SIDEBAR_FILTERS.indexOf(value);
    let next: SidebarFilter | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = SIDEBAR_FILTERS[(i + 1) % SIDEBAR_FILTERS.length];
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = SIDEBAR_FILTERS[(i - 1 + SIDEBAR_FILTERS.length) % SIDEBAR_FILTERS.length];
    else if (event.key === 'Home') next = SIDEBAR_FILTERS[0];
    else if (event.key === 'End') next = SIDEBAR_FILTERS[SIDEBAR_FILTERS.length - 1];
    if (!next) return;
    event.preventDefault();
    onChange(next);
    refs.current.get(next)?.focus();
  }
  return (
    <div className={styles.filters} role="radiogroup" aria-label="Show chats" onKeyDown={onKeyDown}>
      {SIDEBAR_FILTERS.map((f) => {
        const n = counts[f];
        const checked = f === value;
        return (
          <button key={f} ref={(node) => { if (node) refs.current.set(f, node); else refs.current.delete(f); }}
            type="button" role="radio" aria-checked={checked} tabIndex={checked ? 0 : -1} className={styles.filter}
            data-filter={f} onClick={() => onChange(f)}>
            {SIDEBAR_FILTER_LABEL[f]}
            {f !== 'all' && n > 0 ? <span className={styles.filterCount}>{n}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function EmptyList({ query, filter, hasSessions, newChatHint, onClearQuery, onClearFilter, onNew }: {
  query: string;
  filter: SidebarFilter;
  hasSessions: boolean;
  newChatHint: string | null;
  onClearQuery: () => void;
  onClearFilter: () => void;
  onNew: () => void;
}) {
  if (query.trim()) {
    return (
      <div className={`${styles.empty} ${styles.emptyCompact}`}>
        <p className={styles.emptyTitle}>No chat titles match “{query}”</p>
        <p>Titles and projects match as you type. Chats whose messages match, if any, are listed below.</p>
        <button type="button" className={styles.emptyAction} onClick={onClearQuery}>Clear search</button>
      </div>
    );
  }
  if (filter !== 'all' && hasSessions) {
    const what = filter === 'running' ? 'No chat is running' : filter === 'needs-you' ? 'Nothing needs you' : 'No pinned chats';
    return (
      <div className={`${styles.empty} ${styles.emptyCompact}`}>
        <p className={styles.emptyTitle}>{what}</p>
        {filter === 'pinned' ? <p>Pin a chat from its row menu — hover it, or right-click.</p> : null}
        <button type="button" className={styles.emptyAction} onClick={onClearFilter}>Show all chats</button>
      </div>
    );
  }
  return (
    <div className={styles.empty}>
      <p className={styles.emptyTitle}>No chats yet</p>
      <p>Start one on any project with any seat.</p>
      {/* Not named "New chat": the header already has a control by that name. */}
      <button type="button" className={styles.emptyAction} onClick={onNew}>
        Start your first chat {newChatHint ? <kbd className={styles.emptyKey}>{newChatHint}</kbd> : null}
      </button>
    </div>
  );
}

function GroupView({ group, seats, selectedId, renaming, open, onToggle, onSelect, onMenu, onRenameDone }: {
  group: SidebarGroup;
  seats: readonly VerseSeat[];
  selectedId: string | null;
  renaming: string | null;
  open: boolean;
  onToggle?: () => void;
  onSelect: (id: string) => void;
  onMenu?: (row: SidebarRow, anchor: MenuAnchor, from: HTMLElement) => void;
  onRenameDone: (row: SidebarRow, title: string) => Promise<void>;
}) {
  const listId = useId();
  return (
    <section className={styles.group} aria-label={group.label} data-group={group.kind}>
      <h2 className={styles.groupTitle} title={group.projectPath ?? undefined}>
        {onToggle ? (
          <button type="button" className={styles.groupToggle} aria-expanded={open} aria-controls={listId} onClick={onToggle}>
            <span className={styles.twist} data-open={open || undefined} aria-hidden="true" />
            <span className={styles.groupName}>{group.label}</span>
          </button>
        ) : <span className={styles.groupName}>{group.label}</span>}
        {group.enrolled ? <span className={styles.enrolled}>enrolled</span> : null}
        <span className={styles.groupCount} aria-hidden="true">{group.rows.length}</span>
      </h2>
      <ul id={listId} className={styles.list} hidden={!open}>
        {open ? group.rows.map((row) => (
          <li key={row.session.id}>
            {renaming === row.session.id ? (
              <RenameRow row={row} onDone={(title) => { void onRenameDone(row, title); }} />
            ) : (
              <SessionRowView row={row} seats={seats} selected={row.session.id === selectedId} onSelect={onSelect} onMenu={onMenu} />
            )}
          </li>
        )) : null}
      </ul>
    </section>
  );
}

function SessionRowView({ row, seats, selected, onSelect, onMenu }: {
  row: SidebarRow;
  seats: readonly VerseSeat[];
  selected: boolean;
  onSelect: (id: string) => void;
  onMenu?: (row: SidebarRow, anchor: MenuAnchor, from: HTMLElement) => void;
}) {
  const { session, status } = row;
  const seat = seatById(seats, session.seatId);
  const capacity = seat === undefined ? null : seatSubscription(seat);
  // Quiet by default: a marker only where it changes what the operator would
  // do — a turn in flight on a seat whose binding window is spent.
  const spentWhileRunning = status.kind === 'running' && capacity?.cls === 'blocked';
  const tip = [
    session.title || 'Untitled chat',
    seatPillLabel(seats, session),
    capacity === null || capacity.cls === 'ready' || capacity.cls === 'unread' ? null : capacity.summary,
    rowStatusWords(status),
  ].filter((part) => part !== null).join(' · ');
  const rowRef = useRef<HTMLButtonElement>(null);

  function onContextMenu(event: ReactMouseEvent<HTMLButtonElement>) {
    if (!onMenu) return;
    event.preventDefault();
    onMenu(row, { x: event.clientX, y: event.clientY }, event.currentTarget);
  }
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!onMenu) return;
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      onMenu(row, { x: rect.left + 24, y: rect.bottom }, event.currentTarget);
    }
  }

  return (
    <div className={styles.row} data-selected={selected || undefined}>
      <Tooltip label={tip} placement="right">
        <button ref={rowRef} type="button" className={`${styles.session} ${styles[`engine-${session.engine}`] ?? ''}`}
          aria-current={selected ? 'true' : undefined}
          data-focus-key={`verse-session:${session.id}`} data-engine={session.engine} data-status={status.kind}
          aria-haspopup={onMenu ? 'menu' : undefined} aria-keyshortcuts={onMenu ? 'Shift+F10' : undefined}
          onClick={() => onSelect(session.id)} onContextMenu={onContextMenu} onKeyDown={onKeyDown}>
          <span className={styles.marker} aria-hidden="true" />
          <span className={styles.sessionBody}>
            <span className={styles.sessionText}>{session.title || 'Untitled chat'}</span>
            {row.live ? <span className={styles.liveLine} title={row.live.text}>{row.live.text}</span> : null}
          </span>
          {spentWhileRunning && capacity !== null ? (
            <span className={styles.seatSpent} role="img" aria-label={`Seat limit reached: ${capacity.summary}`}>▮</span>
          ) : null}
          <RowStatus row={row} />
        </button>
      </Tooltip>
      {onMenu ? (
        // A pointer affordance only, hidden from assistive tech: the row itself
        // announces its menu (aria-haspopup) and opens it with Shift+F10 or
        // the menu key, so a screen reader hears ONE control per chat.
        <button type="button" className={styles.rowMore} tabIndex={-1} aria-hidden="true" title="Chat actions"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            onMenu(row, { x: rect.right - 220, y: rect.bottom + 4 }, rowRef.current ?? event.currentTarget);
          }}>
          <MoreGlyph size={14} />
        </button>
      ) : null}
    </div>
  );
}

function RowStatus({ row }: { row: SidebarRow }) {
  const { status, session } = row;
  // One wording for the glyph's name and the row's tooltip (rowStatusWords).
  const words = rowStatusWords(status) ?? undefined;
  switch (status.kind) {
    case 'running':
      return (
        <span className={styles.statusRunning}>
          <span className={styles.running} role="img" aria-label={words} />
          {status.startedAt ? <LiveTimer className={styles.elapsed} since={status.startedAt} /> : null}
        </span>
      );
    case 'failed':
      return <span className={styles.errored} role="img" aria-label={words}>!</span>;
    case 'unread':
      return <span className={styles.unread} role="img" aria-label={words} />;
    default:
      return <time className={styles.time} dateTime={session.updatedAt}>{formatRelative(session.updatedAt)}</time>;
  }
}

function RenameRow({ row, onDone }: { row: SidebarRow; onDone: (title: string) => void }) {
  const [value, setValue] = useState(row.session.title);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  const finish = (title: string) => {
    if (done.current) return;
    done.current = true;
    onDone(title.trim());
  };
  return (
    <div className={`${styles.row} ${styles.renameRow}`}>
      <input ref={input} className={styles.renameInput} value={value} maxLength={120} aria-label="Chat title"
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => finish(value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); finish(value); }
          else if (event.key === 'Escape') { event.preventDefault(); finish(row.session.title); }
        }} />
    </div>
  );
}
