/**
 * routes/verse/Sidebar.tsx — search, "New chat", and every session grouped
 * by project. One row is: a 2px engine-identity marker, the title, and a
 * right-aligned relative time. A running chat shows a pulsing dot, never a
 * spinner (DESIGN §4) — a spinner claims the UI is busy; the dot says the
 * agent is.
 *
 * Above the chats sits the SAVED PROJECTS list. The chat groups below it are
 * derived from history — a folder appears only once something has been
 * started on it — so they cannot answer "reopen what I was working on before
 * I ever sent a message". The projects section is the registry the operator
 * writes deliberately, and it is the only place in the console that creates
 * one.
 *
 * ONE SEARCH FIELD, TWO ANSWERS (V3.9). The field filters titles and project
 * paths instantly, on the client, exactly as before; underneath the matching
 * chats, `SessionSearch` lists chats whose MESSAGES match the same words
 * (GET /api/verse/search — a scan of the transcripts on this machine, nothing
 * sent to a model). One box rather than two because two stacked search fields
 * in a narrow column make the operator guess which one to type in; the title
 * answer stays instant and the message answer arrives a debounce later.
 *
 * Seat health and the local runtime live in the resources panel, and the
 * theme toggle lives in the shell rail, so nothing competes with the list.
 *
 * ONE exception, added deliberately: a chat that is RUNNING on a seat whose
 * binding window is spent gets a small marker. That combination is worth
 * interrupting for — the turn in flight is the one about to fail — and it is
 * rare enough that the list stays quiet. Every other row says nothing new;
 * the capacity rides in the row's `title` where it costs no pixels.
 */
import { useId } from 'react';
import type { VerseProject, VerseSeat, VerseSession } from '../../data/api-types.js';
import type { QueryStatus } from '../../data/cache.js';
import { RefreshIndicator } from '../../components/primitives/RefreshIndicator.js';
import { SkeletonLine } from '../../components/primitives/Skeleton.js';
import { Tooltip } from '../../components/primitives/Tooltip.js';
import { PlusIcon, SearchIcon, SidebarIcon } from './verse-icons.js';
import { seatSubscription } from './seat-subscription.js';
import { formatRelative, groupSessions, seatById, seatPillLabel } from './verse-model.js';
import { SavedProjects } from './workspaces/SavedProjects.js';
import { SessionSearch } from './context/SessionSearch.js';
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
  onDisconnect: () => void;
}

export function Sidebar(props: SidebarProps) {
  const { sessions, sessionsStatus, sessionsError, projects, seats, selectedId, query, onQuery, onSelect, onNew,
    onRetry, onCollapse, onDisconnect } = props;
  const searchId = useId();
  const groups = groupSessions(sessions, projects, query);
  const loading = sessionsStatus === 'loading' || (sessionsStatus === 'idle' && sessions.length === 0);

  return (
    <nav className={styles.sidebar} aria-label="Chats">
      <div className={styles.head}>
        {/* Draggable strip under the overlay title bar, so the cleared
            space still moves the window instead of being a dead band.
            Zero-height in a browser. */}
        <div className={styles.headDragStrip} aria-hidden="true" />
        <label className={styles.search} htmlFor={searchId}>
          <span className={styles.searchIcon} aria-hidden="true"><SearchIcon /></span>
          <span className="visually-hidden">Search chats and messages</span>
          <input id={searchId} type="search" value={query} placeholder="Search chats" autoComplete="off"
            onChange={(event) => onQuery(event.target.value)} />
        </label>
        {/* Icon-only, so each keeps its own aria-label: the tooltip is the
            DESCRIPTION, never the accessible name. */}
        <Tooltip label="New chat" shortcut="⌘N" placement="bottom">
          <button type="button" className={styles.iconButton} onClick={onNew} aria-label="New chat">
            <PlusIcon />
          </button>
        </Tooltip>
        <Tooltip label="Hide chat list" placement="bottom">
          <button type="button" className={styles.iconButton} onClick={onCollapse} aria-label="Hide chat list">
            <SidebarIcon />
          </button>
        </Tooltip>
        {sessionsStatus === 'refreshing' ? <RefreshIndicator label="Refreshing chats" /> : null}
      </div>

      <div className={styles.scroll}>
        {/* Saved projects, above the chats. A chat list groups only the
            folders something has ALREADY been started on; this is the list of
            folders the operator asked to keep, which is the one that answers
            "open the thing I was working on yesterday". It reads and writes
            the workspace registry itself — see workspaces/SavedProjects.tsx. */}
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
        ) : groups.length === 0 ? (
          <div className={query ? `${styles.empty} ${styles.emptyCompact}` : styles.empty}>
            {query ? (
              <>
                <p className={styles.emptyTitle}>No chat titles match “{query}”</p>
                <p>Titles and projects match as you type. Chats whose messages match, if any, are listed below.</p>
                {/* A dead end needs a way out. Without this the only exit is
                    to find the field again and clear it by hand. */}
                <button type="button" className={styles.emptyAction} onClick={() => onQuery('')}>
                  Clear search
                </button>
              </>
            ) : (
              <>
                <p className={styles.emptyTitle}>No chats yet</p>
                <p>Start one on any project with any seat.</p>
                {/* Deliberately NOT named "New chat": the header already has a
                    control by that name, and two buttons sharing one
                    accessible name is a coin toss for anyone navigating by
                    name rather than by sight. */}
                <button type="button" className={styles.emptyAction} onClick={onNew}>
                  Start your first chat <kbd className={styles.emptyKey}>⌘N</kbd>
                </button>
              </>
            )}
          </div>
        ) : groups.map((group) => (
          <section key={group.projectPath} className={styles.group} aria-label={group.name}>
            {/* The path stays a native `title`: this heading is not focusable,
                so a tooltip would reach mice only, and what it discloses is
                the text the ellipsis clipped rather than a description. */}
            <h2 className={styles.groupTitle} title={group.projectPath}>
              <span className={styles.groupName}>{group.name}</span>
              {group.enrolled ? <span className={styles.enrolled}>enrolled</span> : null}
              <span className={styles.groupCount} aria-hidden="true">{group.sessions.length}</span>
            </h2>
            <ul className={styles.list}>
              {group.sessions.map((session) => {
                const seat = seatById(seats, session.seatId);
                const capacity = seat === undefined ? null : seatSubscription(seat);
                // Quiet by default: the marker appears only where it changes
                // what the operator would do — a turn in flight on a seat
                // whose binding window is spent.
                const spentWhileRunning = session.status === 'running' && capacity?.cls === 'blocked';
                const title = capacity === null || capacity.cls === 'ready' || capacity.cls === 'unread'
                  ? `${session.title} · ${seatPillLabel(seats, session)}`
                  : `${session.title} · ${seatPillLabel(seats, session)} · ${capacity.summary}`;
                return (
                  <li key={session.id}>
                    {/* The row is where the list stops being scannable: the
                        title is clipped at one line and the seat is not drawn
                        at all. A native `title` disclosed both to mice only —
                        this one opens on keyboard focus too, and cannot be
                        clipped by the sidebar's own overflow. */}
                    <Tooltip label={title} placement="right">
                      <button type="button" className={`${styles.session} ${styles[`engine-${session.engine}`] ?? ''}`}
                        aria-current={session.id === selectedId ? 'true' : undefined}
                        data-focus-key={`verse-session:${session.id}`} data-engine={session.engine}
                        onClick={() => onSelect(session.id)}>
                        <span className={styles.marker} aria-hidden="true" />
                        <span className={styles.sessionText}>{session.title || 'Untitled chat'}</span>
                        {spentWhileRunning && capacity !== null ? (
                          <span className={styles.seatSpent} role="img"
                            aria-label={`Seat limit reached: ${capacity.summary}`}>▮</span>
                        ) : null}
                        {session.status === 'running' ? (
                          <span className={styles.running} role="img" aria-label="Running" />
                        ) : session.status === 'error' ? (
                          <span className={styles.errored} role="img" aria-label="Last turn failed">!</span>
                        ) : null}
                        <time className={styles.time} dateTime={session.updatedAt}>{formatRelative(session.updatedAt)}</time>
                      </button>
                    </Tooltip>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {/* Message matches for the same words. Renders nothing until the query
            is long enough to be worth a scan, and nothing at all on a server
            that has no search route — the title list above still answers. */}
        {query.trim() ? <SessionSearch query={query} onOpenSession={onSelect} selectedId={selectedId} /> : null}
      </div>

      <footer className={styles.footer}>
        <button type="button" onClick={onDisconnect} className={styles.footerButton}>Disconnect</button>
      </footer>
    </nav>
  );
}
