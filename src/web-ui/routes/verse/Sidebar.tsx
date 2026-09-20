/**
 * routes/verse/Sidebar.tsx — search, "New chat", and every session grouped
 * by project. One row is: a 2px engine-identity marker, the title, and a
 * right-aligned relative time. A running chat shows a pulsing dot, never a
 * spinner (DESIGN §4) — a spinner claims the UI is busy; the dot says the
 * agent is.
 *
 * Seat health and the local runtime live in the resources panel, and the
 * theme toggle lives in the shell rail, so nothing competes with the list.
 */
import { useId } from 'react';
import type { VerseProject, VerseSeat, VerseSession } from '../../data/api-types.js';
import type { QueryStatus } from '../../data/cache.js';
import { RefreshIndicator } from '../../components/primitives/RefreshIndicator.js';
import { SkeletonLine } from '../../components/primitives/Skeleton.js';
import { PlusIcon, SearchIcon, SidebarIcon } from './verse-icons.js';
import { formatRelative, groupSessions, seatPillLabel } from './verse-model.js';
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
        <label className={styles.search} htmlFor={searchId}>
          <span className={styles.searchIcon} aria-hidden="true"><SearchIcon /></span>
          <span className="visually-hidden">Search chats</span>
          <input id={searchId} type="search" value={query} placeholder="Search chats" autoComplete="off"
            onChange={(event) => onQuery(event.target.value)} />
        </label>
        <button type="button" className={styles.iconButton} onClick={onNew} title="New chat (⌘N)" aria-label="New chat">
          <PlusIcon />
        </button>
        <button type="button" className={styles.iconButton} onClick={onCollapse} title="Hide chat list" aria-label="Hide chat list">
          <SidebarIcon />
        </button>
        {sessionsStatus === 'refreshing' ? <RefreshIndicator label="Refreshing chats" /> : null}
      </div>

      <div className={styles.scroll}>
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
          <div className={styles.empty}>
            {query ? <p>No chats match “{query}”.</p> : (
              <>
                <p className={styles.emptyTitle}>No chats yet — ⌘N</p>
                <p>Start one on any project with any seat.</p>
              </>
            )}
          </div>
        ) : groups.map((group) => (
          <section key={group.projectPath} className={styles.group} aria-label={group.name}>
            <h2 className={styles.groupTitle} title={group.projectPath}>
              <span className={styles.groupName}>{group.name}</span>
              {group.enrolled ? <span className={styles.enrolled} title="Enrolled repo">enrolled</span> : null}
            </h2>
            <ul className={styles.list}>
              {group.sessions.map((session) => (
                <li key={session.id}>
                  <button type="button" className={`${styles.session} ${styles[`engine-${session.engine}`] ?? ''}`}
                    aria-current={session.id === selectedId ? 'true' : undefined}
                    data-focus-key={`verse-session:${session.id}`} data-engine={session.engine}
                    onClick={() => onSelect(session.id)} title={`${session.title} · ${seatPillLabel(seats, session)}`}>
                    <span className={styles.marker} aria-hidden="true" />
                    <span className={styles.sessionText}>{session.title || 'Untitled chat'}</span>
                    {session.status === 'running' ? (
                      <span className={styles.running} role="img" aria-label="Running" />
                    ) : session.status === 'error' ? (
                      <span className={styles.errored} role="img" aria-label="Last turn failed">!</span>
                    ) : null}
                    <time className={styles.time} dateTime={session.updatedAt}>{formatRelative(session.updatedAt)}</time>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <footer className={styles.footer}>
        <button type="button" onClick={onDisconnect} className={styles.footerButton}>Disconnect</button>
      </footer>
    </nav>
  );
}
