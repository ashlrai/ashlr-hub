/**
 * routes/verse/mobile/screens/AgentsScreen.tsx — the Agents tab: every chat,
 * grouped the way the operator acts on them — Working / Needs you / Ready
 * for review / Done — one column at a time behind a chip row.
 *
 * The grouping is the workbench's own (chat/agents-board-model.ts over the
 * chat list's row model), fed by the same reads the Mac's chat list uses:
 *
 *   sessions   GET /api/verse/sessions (verseSessionsQuery; the bootstrap's
 *              copy until it answers), refreshed by the verse-sessions SSE
 *              digest (openVerseListChannel)
 *   activity   useChatActivity() — who is running and what they are doing,
 *              the Needs-you items, read state (polls every 5 s while visible)
 *
 * So a chat is "Working" here exactly when its dot pulses on the Mac.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { VerseActivityRunning } from '../../../../../core/verse/workbench-types.js';
import { refetchQuery } from '../../../../data/cache.js';
import { readFailureReason } from '../../../../data/client.js';
import { useQuery } from '../../../../data/hooks.js';
import { AGENT_COLUMNS, boardCounts, buildAgentsBoard, type AgentColumnId } from '../../chat/agents-board-model.js';
import type { SidebarRow } from '../../chat/sidebar-model.js';
import { useChatActivity } from '../../chat/use-chat-activity.js';
import { verseBootstrapQuery } from '../../verse-bootstrap-query.js';
import { openVerseListChannel } from '../../verse-events.js';
import { formatRelative, modelLabel, projectName, seatLabel } from '../../verse-model.js';
import { verseActivityQuery, verseSessionMetaQuery, verseSessionsQuery } from '../../verse-queries.js';
import { canShowActions, useMobile } from '../mobile-context.js';
import { PlusGlyph } from '../mobile-icons.js';
import { Button, Screen, SkeletonList, cx } from '../ui.js';
import { Badge, Banner, EmptyState, ErrorState, Row, ui, type Tone } from '../ui-parts.js';
import { shortElapsed } from './agent-transcript-model.js';
import styles from './AgentsScreen.module.css';

/** The chip's short name (the board's own label is the long one). */
export const CHIP_LABEL: Readonly<Record<AgentColumnId, string>> = {
  working: 'Working',
  'needs-you': 'Needs you',
  review: 'Review',
  done: 'Done',
};

/** The column shown when the operator has not picked one: the first with anything in it. */
export function defaultColumn(counts: Readonly<Record<AgentColumnId, number>>): AgentColumnId | null {
  for (const c of AGENT_COLUMNS) if (counts[c.id] > 0) return c.id;
  return null;
}

/**
 * The row's second line: what a running agent is doing and for how long,
 * "Failed", "2 new turns", or when it was last touched.
 */
export function agentStatusLine(row: SidebarRow, running: VerseActivityRunning | undefined, now: number = Date.now()): string {
  const { status } = row;
  switch (status.kind) {
    case 'running': {
      const live = running?.live ?? null;
      const doing = live?.tool ? `Using ${live.tool}` : row.live?.text ?? 'Working';
      const started = status.startedAt ? Date.parse(status.startedAt) : NaN;
      const span = Number.isFinite(started) ? shortElapsed(now - started) : null;
      return span ? `${doing} · ${span}` : doing;
    }
    case 'failed':
      return 'Failed';
    case 'unread':
      return `${status.newTurns} new ${status.newTurns === 1 ? 'turn' : 'turns'}`;
    case 'time': {
      if (row.needsYou) return 'Waiting on you';
      const rel = formatRelative(status.at, now);
      if (!rel) return 'unknown';
      if (rel === 'now') return 'Just now';
      return /^\d+[mhd]$/.test(rel) ? `${rel} ago` : rel;
    }
  }
}

export function agentBadge(row: SidebarRow, column: AgentColumnId): { tone: Tone; label: string; pulse: boolean } {
  switch (column) {
    case 'working':
      return { tone: 'running', label: 'Working', pulse: true };
    case 'needs-you':
      return row.status.kind === 'failed' ? { tone: 'danger', label: 'Failed', pulse: false } : { tone: 'warning', label: 'Needs you', pulse: false };
    case 'review':
      return { tone: 'info', label: 'New', pulse: false };
    case 'done':
      return { tone: 'neutral', label: 'Done', pulse: false };
  }
}

/** Pull-to-refresh: the list, activity and read state, forced fresh. */
function refreshAgents(): Promise<unknown> {
  return Promise.all([
    refetchQuery(verseSessionsQuery.key, () => verseSessionsQuery.fetch(), true),
    refetchQuery(verseActivityQuery.key, () => verseActivityQuery.fetch(), true),
    refetchQuery(verseSessionMetaQuery.key, () => verseSessionMetaQuery.fetch(), true),
  ]);
}

export function AgentsScreen() {
  const { permissions, reachability, navigate, refreshActivity } = useMobile();
  const sessionsQuery = useQuery(verseSessionsQuery);
  const boot = useQuery(verseBootstrapQuery);
  const { activity, meta, localSeen } = useChatActivity();
  const [picked, setPicked] = useState<AgentColumnId | null>(null);

  // The verse-sessions digest refreshes the list the moment a chat changes.
  useEffect(() => openVerseListChannel(), []);

  const sessions = sessionsQuery.data ?? boot.data?.sessions ?? null;
  const projects = boot.data?.projects;
  const seats = boot.data?.seats;
  const columns = useMemo(
    () => (sessions ? buildAgentsBoard({ sessions, projects: projects ?? [], activity, meta, localSeen }) : null),
    [sessions, projects, activity, meta, localSeen],
  );
  const counts = columns ? boardCounts(columns) : null;
  const selected = picked ?? (counts ? defaultColumn(counts) : null) ?? 'working';
  const column = columns?.find((c) => c.id === selected) ?? null;
  const runningById = useMemo(() => new Map((activity?.running ?? []).map((r) => [r.sessionId, r])), [activity]);

  const canAct = canShowActions(permissions);
  const disconnected = reachability === 'offline' || reachability === 'unreachable';
  const total = counts ? counts.working + counts['needs-you'] + counts.review + counts.done : 0;

  const refresh = useCallback(() => Promise.all([refreshAgents(), refreshActivity()]), [refreshActivity]);
  const retry = useCallback(() => void refresh().catch(() => undefined), [refresh]);
  const openNew = useCallback(() => navigate({ screen: 'new' }), [navigate]);

  const newButton = canAct ? (
    <Button variant="plain" onClick={openNew} disabled={disconnected} aria-label="New agent">
      <PlusGlyph size={18} />
      <span>New</span>
    </Button>
  ) : null;

  let body;
  if (!sessions || !columns || !counts) {
    body = sessionsQuery.status === 'error' ? (
      <ErrorState title="Couldn’t load your agents" reason={readFailureReason(sessionsQuery.error)} onRetry={retry} />
    ) : (
      <SkeletonList rows={4} label="Loading agents" />
    );
  } else if (total === 0) {
    body = (
      <EmptyState
        title="No agents yet"
        body="Chats you start here or on your Mac show up here, grouped by what they need from you."
        action={canAct ? <Button variant="primary" onClick={openNew} disabled={disconnected}>+ New agent</Button> : undefined}
      />
    );
  } else {
    body = (
      <>
        <div className={ui.chips} role="group" aria-label="Show agents">
          {AGENT_COLUMNS.map((c) => (
            <button
              key={c.id}
              type="button"
              className={ui.chip}
              aria-pressed={c.id === selected}
              onClick={() => setPicked(c.id)}
            >
              {CHIP_LABEL[c.id]} <span className={styles.chipCount}>{counts[c.id]}</span>
            </button>
          ))}
        </div>
        <h2 className={styles.columnTitle}>{column?.label ?? ''}</h2>
        {column && column.rows.length > 0 ? (
          <div className={ui.group}>
            {column.rows.map((row) => {
              const s = row.session;
              const badge = agentBadge(row, column.id);
              const who = [seatLabel(seats ?? [], s), modelLabel(seats ?? [], s), projectName(s.projectPath, projects ?? [])].filter(Boolean).join(' · ');
              return (
                <Row
                  key={s.id}
                  title={s.title || 'Untitled chat'}
                  subtitle={
                    <>
                      <span className={styles.who}>{who}</span>
                      <span className={cx(styles.status, row.status.kind === 'failed' && styles.failed)}>{agentStatusLine(row, runningById.get(s.id))}</span>
                    </>
                  }
                  trailing={<Badge tone={badge.tone} dot={badge.tone === 'running'} pulse={badge.pulse}>{badge.label}</Badge>}
                  onClick={() => navigate({ screen: 'agent', id: s.id, pane: 'transcript' })}
                />
              );
            })}
          </div>
        ) : (
          <EmptyState title={column?.empty ?? 'Nothing here.'} />
        )}
      </>
    );
  }

  return (
    <Screen title="Agents" large trailing={newButton} onRefresh={refresh} label="Agents">
      {disconnected ? (
        <Banner tone="warning">
          {reachability === 'offline'
            ? 'You’re offline. This is the last list your phone saw; starting agents resumes when you reconnect.'
            : 'Can’t reach your Mac. This is the last list your phone saw; starting agents resumes when it answers.'}
        </Banner>
      ) : null}
      {sessions && sessionsQuery.status === 'error' ? (
        <Banner tone="warning">Couldn’t refresh the list: {readFailureReason(sessionsQuery.error)}</Banner>
      ) : null}
      {body}
    </Screen>
  );
}
