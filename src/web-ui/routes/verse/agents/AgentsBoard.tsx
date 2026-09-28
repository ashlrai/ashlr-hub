/**
 * routes/verse/agents/AgentsBoard.tsx — the Agents board (⌘6): every chat and
 * agent across repos as a card, in four columns by what it needs —
 * Working · Needs you · Ready for review · Done — with its seat and model,
 * repo and branch, how long it has been running, what it has spent, its
 * PR/CI, and the last thing it did.
 *
 * KEYS (while the board has focus): ←/→ or h/l between columns, ↑/↓ or j/k
 * within one, Enter opens the chat, Space the card's details, x selects,
 * e marks read, r resolves a failed turn, s stops, ⌘N new agent, ⇧⌘N the
 * same task on several seats. "Mark read" NEVER clears Needs you — a card
 * leaves that column when its cause is gone or you resolve it.
 *
 * Every write goes through the mutation token (useTokenGate). The board
 * polls while it is the visible surface; nothing here spends except what
 * the operator asks for (a new agent's prompt, an approved plan, Send).
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { AGENT_COLUMN_LABEL, AGENT_COLUMNS, type AgentCard, type AgentColumn } from '../../../../core/verse/agents/types.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { Button } from '../../../components/primitives/Button.js';
import { EmptyState } from '../../../components/primitives/EmptyState.js';
import { Input } from '../../../components/primitives/Input.js';
import { Select } from '../../../components/primitives/Select.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { describeContextError, useTokenGate } from '../context/use-token-gate.js';
import { openPaneInChat } from '../dock/dock-store.js';
import { usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { ENGINE_LABEL } from '../verse-model.js';
import { cancelVerseTurn, verseBootstrapQuery } from '../verse-queries.js';
import { openVerseSession } from '../verse-ui-store.js';
import { getAgentsFocus, isAgentsFocusLive, subscribeAgentsFocus, takeAgentsFocus } from './agents-focus.js';
import {
  agoLabel,
  cardAt,
  ciLabel,
  DEFAULT_FILTER,
  elapsedLabel,
  filterCards,
  groupByColumn,
  locate,
  markReadTargets,
  moveCursor,
  reposOf,
  spendLabel,
  spendTone,
  type BoardCursor,
  type BoardFilter,
  type MoveDirection,
} from './agents-model.js';
import {
  AGENTS_POLL_MS,
  agentsBoardQuery,
  bulkAgents,
  resolveAgentCard,
  spawnAgent,
  type BulkAction,
  type SpawnInput,
} from './agents-queries.js';
import { AgentDetails } from './AgentDetails.js';
import { NewAgentDialog } from './NewAgentDialog.js';
import styles from './Agents.module.css';

type Notice = { tone: 'neutral' | 'danger'; text: string } | null;

const KEY_MOVES: Readonly<Record<string, MoveDirection>> = {
  ArrowUp: 'up', k: 'up', ArrowDown: 'down', j: 'down', ArrowLeft: 'left', h: 'left', ArrowRight: 'right', l: 'right', Home: 'first', End: 'last',
};

function useNow(intervalMs: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, active]);
  return now;
}

export function AgentsBoard() {
  const read = useQuery(agentsBoardQuery);
  const refetch = useRefetch(agentsBoardQuery);
  usePollWhileVisible(refetch, AGENTS_POLL_MS);
  const boot = useQuery(verseBootstrapQuery);
  const visible = useSectionVisible();
  const now = useNow(1_000, visible);
  const gate = useTokenGate();
  const [filter, setFilter] = useState<BoardFilter>(DEFAULT_FILTER);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ open: boolean; multi: boolean }>({ open: false, multi: false });
  const [spawning, setSpawning] = useState(false);
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);

  const allCards = useMemo(() => read.data?.cards ?? [], [read.data]);
  // The clock ticks every second for the elapsed labels; the Done cut-off only needs minutes.
  const minute = Math.floor(now / 60_000);
  const cards = useMemo(() => filterCards(allCards, filter, minute * 60_000), [allCards, filter, minute]);
  const columns = useMemo(() => groupByColumn(cards), [cards]);
  const repos = useMemo(() => reposOf(allCards), [allCards]);
  const cursor: BoardCursor | null = cursorId ? locate(columns, cursorId) : null;
  const details = detailsId ? allCards.find((c) => c.id === detailsId) ?? null : null;

  // ⌘N / ⇧⌘N / ⌘K hand-off (agents-focus.ts).
  const focus = useSyncExternalStore(subscribeAgentsFocus, getAgentsFocus, getAgentsFocus);
  useEffect(() => {
    if (!focus) return;
    if (isAgentsFocusLive(focus)) {
      if (focus.kind === 'new' || focus.kind === 'new-multi') {
        setSpawnError(null);
        setDialog({ open: true, multi: focus.kind === 'new-multi' });
      } else if (focus.cardId) {
        setCursorId(focus.cardId);
        setDetailsId(focus.cardId);
      }
    }
    takeAgentsFocus(focus.seq);
  }, [focus]);

  const act = useCallback(async (key: string, why: string, run: () => Promise<string | null>) => {
    setBusy(key);
    setNotice(null);
    try {
      const message = await gate.run(why, run);
      if (message) setNotice({ tone: 'neutral', text: message });
      refetch();
    } catch (err) {
      setNotice({ tone: 'danger', text: describeContextError(err) });
    } finally {
      setBusy(null);
    }
  }, [gate, refetch]);

  const runBulk = (action: BulkAction, ids: string[], label: string) => {
    if (ids.length === 0) {
      setNotice({ tone: 'neutral', text: action === 'read' ? 'Nothing unread outside Needs you.' : 'Nothing selected.' });
      return;
    }
    void act(`bulk:${action}`, `${label} (${ids.length})`, async () => {
      const results = await bulkAgents(action, ids);
      const ok = results.filter((r) => r.ok).length;
      const skipped = results.filter((r) => r.skipped).length;
      const failed = results.filter((r) => !r.ok && !r.skipped);
      if (action === 'archive') setSelected(new Set());
      return `${label}: ${ok} done${skipped ? `, ${skipped} in Needs you left as they are` : ''}${failed.length ? `, ${failed.length} failed (${failed[0]!.error})` : ''}.`;
    });
  };

  const spawn = (inputs: SpawnInput[]) => {
    setSpawning(true);
    setSpawnError(null);
    void gate.run(inputs.length > 1 ? `Start ${inputs.length} agents` : 'Start an agent', async () => {
      const errors: string[] = [];
      let first: string | null = null;
      let archived = 0;
      // One at a time: each makes a worktree under the repo lock anyway.
      for (const input of inputs) {
        try {
          const res = await spawnAgent(input);
          first ??= res.agent.id;
          archived += res.archivedForCap.length;
        } catch (err) {
          errors.push(`${input.title}: ${describeContextError(err)}`);
        }
      }
      return { first, errors, archived, total: inputs.length };
    }).then((out) => {
      setSpawning(false);
      if (!out) return;
      refetch();
      if (out.errors.length === out.total) {
        setSpawnError(out.errors.join(' '));
        return;
      }
      setDialog({ open: false, multi: false });
      if (out.first) setCursorId(out.first);
      const started = out.total - out.errors.length;
      setNotice({
        tone: out.errors.length ? 'danger' : 'neutral',
        text: `Started ${started} agent${started === 1 ? '' : 's'}.${out.archived ? ` Archived ${out.archived} idle workspace${out.archived === 1 ? '' : 's'} to stay under the cap (restorable).` : ''}${out.errors.length ? ` ${out.errors.join(' ')}` : ''}`,
      });
    }, (err: unknown) => {
      setSpawning(false);
      setSpawnError(describeContextError(err));
    });
  };

  const openChat = (card: AgentCard) => {
    if (card.sessionId) openVerseSession(card.sessionId);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const move = KEY_MOVES[e.key];
    if (move) {
      e.preventDefault();
      const next = moveCursor(columns, cursor, move);
      const card = cardAt(columns, next);
      if (card) {
        setCursorId(card.id);
        boardRef.current?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(card.id)}"]`)?.focus();
      }
      return;
    }
    const card = cardAt(columns, cursor);
    if (!card) return;
    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        openChat(card);
        break;
      case ' ':
        e.preventDefault();
        setDetailsId((id) => (id === card.id ? null : card.id));
        break;
      case 'x':
        e.preventDefault();
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(card.id)) next.delete(card.id);
          else next.add(card.id);
          return next;
        });
        break;
      case 'e':
        e.preventDefault();
        if (card.column === 'needs-you') setNotice({ tone: 'neutral', text: 'Needs you is not cleared by marking read — resolve it (r) or act on it.' });
        else runBulk('read', markReadTargets([card]), 'Mark read');
        break;
      case 'r':
        if (card.reason === 'failed') {
          e.preventDefault();
          void act(`resolve:${card.id}`, 'Resolve this failed turn', async () => { await resolveAgentCard(card.id); return null; });
        }
        break;
      case 's':
        if (card.status === 'running' || card.status === 'setup') {
          e.preventDefault();
          runBulk('stop', [card.id], 'Stop');
        }
        break;
      case 'Escape':
        if (detailsId || selected.size) {
          e.preventDefault();
          setDetailsId(null);
          setSelected(new Set());
        }
        break;
      default:
        break;
    }
  };

  const selectedIds = [...selected].filter((id) => allCards.some((c) => c.id === id));
  const counts = read.data?.counts;
  const projects = boot.data?.projects ?? [];
  const seats = boot.data?.seats ?? [];

  return (
    <section className={styles.section} aria-label="Agents">
      <header className={styles.header}>
        <div className={styles.headerText}>
          <h2 className={styles.title}>Agents</h2>
          <p className={styles.lede}>
            {counts
              ? `${counts.working} working · ${counts['needs-you']} need you · ${counts.review} ready for review`
              : 'Every chat and agent, by what it needs.'}
            {read.data ? ` · ${read.data.liveWorkspaces} of ${read.data.cap} workspaces` : ''}
          </p>
        </div>
        <div className={styles.headerActions}>
          <Select aria-label="Repository" size="sm" value={filter.repo ?? ''} onChange={(e) => setFilter((f) => ({ ...f, repo: e.target.value || null }))}>
            <option value="">All repos</option>
            {repos.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
          <Input aria-label="Filter cards" size="sm" placeholder="Filter" value={filter.query} onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))} />
          <Button size="sm" variant="ghost" onClick={() => runBulk('read', markReadTargets(cards), 'Mark all read')} busy={busy === 'bulk:read'} title="Needs you is never cleared by this">
            Mark all read
          </Button>
          <Button size="sm" variant="subtle" onClick={() => setDialog({ open: true, multi: true })} title="⇧⌘N">Same task on N seats</Button>
          <Button size="sm" variant="primary" onClick={() => setDialog({ open: true, multi: false })} title="⌘N">New agent</Button>
        </div>
      </header>

      {notice ? <p className={styles.banner} data-tone={notice.tone} role="status">{notice.text}</p> : null}
      {read.error && !read.data ? <p className={styles.banner} data-tone="danger" role="alert">{describeContextError(read.error)}</p> : null}

      {selectedIds.length > 0 ? (
        <div className={styles.bulkBar} role="toolbar" aria-label="Selected cards">
          <span>{selectedIds.length} selected</span>
          <Button size="sm" variant="ghost" onClick={() => runBulk('read', markReadTargets(cards, new Set(selectedIds)), 'Mark read')}>Mark read</Button>
          <Button size="sm" variant="ghost" onClick={() => runBulk('stop', selectedIds, 'Stop')}>Stop</Button>
          <Button size="sm" variant="ghost" onClick={() => runBulk('pin', selectedIds, 'Pin')}>Pin</Button>
          <Button size="sm" variant="ghost" onClick={() => runBulk('unpin', selectedIds, 'Unpin')}>Unpin</Button>
          <Button size="sm" variant="danger" onClick={() => runBulk('archive', selectedIds, 'Archive')}>Archive</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      ) : null}

      <div className={styles.body} data-details={details ? 'open' : undefined}>
        {read.data && allCards.length === 0 ? (
          <EmptyState
            title="No agents yet"
            body="Start one with ⌘N: it gets its own worktree and branch, runs the repo’s setup, and shows up here while it works."
            action={<Button variant="primary" size="sm" onClick={() => setDialog({ open: true, multi: false })}>New agent</Button>}
          />
        ) : (
          <div className={styles.board} ref={boardRef} onKeyDown={onKey} aria-label="Agent board" aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Enter Space x e r s">
            {AGENT_COLUMNS.map((column) => (
              <BoardColumn
                key={column}
                column={column}
                cards={columns[column]}
                now={now}
                cursorId={cursor ? cardAt(columns, cursor)?.id ?? null : null}
                selected={selected}
                onFocusCard={(id) => setCursorId(id)}
                onOpen={openChat}
                onDetails={(id) => { setCursorId(id); setDetailsId((d) => (d === id ? null : id)); }}
                onToggleSelect={(id) => setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })}
              />
            ))}
          </div>
        )}
        {details ? (
          <AgentDetails
            card={details}
            now={now}
            onClose={() => setDetailsId(null)}
            onChanged={refetch}
            act={act}
            busy={busy}
            onOpenChat={() => openChat(details)}
            onOpenTerminal={() => { if (details.sessionId) { openVerseSession(details.sessionId); openPaneInChat('terminal', details.sessionId); } }}
            onStop={() => {
              const sessionId = details.sessionId;
              if (sessionId) void act('stop', 'Stop this agent’s turn', async () => { await cancelVerseTurn(sessionId); return null; });
            }}
          />
        ) : null}
      </div>
      <p className={styles.keyHint}>
        ←→↑↓ move · Enter open · Space details · x select · e mark read · r resolve · s stop · ⌘N new agent · ⇧⌘N same task on N seats
      </p>

      <NewAgentDialog
        open={dialog.open}
        multi={dialog.multi}
        projects={projects}
        seats={seats}
        initialRoot={null}
        busy={spawning}
        error={spawnError}
        onClose={() => { if (!spawning) setDialog({ open: false, multi: false }); }}
        onSpawn={spawn}
      />
      <MutationTokenDialog {...gate.dialog} tokenLabel="Mutation token" tokenHelp="the mutation token ashlr verse printed" />
    </section>
  );
}

interface ColumnProps {
  column: AgentColumn;
  cards: AgentCard[];
  now: number;
  cursorId: string | null;
  selected: ReadonlySet<string>;
  onFocusCard: (id: string) => void;
  onOpen: (card: AgentCard) => void;
  onDetails: (id: string) => void;
  onToggleSelect: (id: string) => void;
}

function BoardColumn({ column, cards, now, cursorId, selected, onFocusCard, onOpen, onDetails, onToggleSelect }: ColumnProps) {
  return (
    <section className={styles.column} data-column={column} aria-label={`${AGENT_COLUMN_LABEL[column]}, ${cards.length}`}>
      <h3 className={styles.columnHead}>
        <span>{AGENT_COLUMN_LABEL[column]}</span>
        <span className={styles.count}>{cards.length}</span>
      </h3>
      <ul className={styles.cardList}>
        {cards.map((card) => (
          <li key={card.id}>
            <CardView
              card={card}
              now={now}
              active={card.id === cursorId}
              selected={selected.has(card.id)}
              onFocus={() => onFocusCard(card.id)}
              onOpen={() => onOpen(card)}
              onDetails={() => onDetails(card.id)}
              onToggleSelect={() => onToggleSelect(card.id)}
            />
          </li>
        ))}
        {cards.length === 0 ? <li className={styles.emptyColumn}>{column === 'needs-you' ? 'Nothing is waiting on you.' : '—'}</li> : null}
      </ul>
    </section>
  );
}

interface CardViewProps {
  card: AgentCard;
  now: number;
  active: boolean;
  selected: boolean;
  onFocus: () => void;
  onOpen: () => void;
  onDetails: () => void;
  onToggleSelect: () => void;
}

export function CardView({ card, now, active, selected, onFocus, onOpen, onDetails, onToggleSelect }: CardViewProps) {
  const time = card.startedAt ? elapsedLabel(card.startedAt, now) : agoLabel(card.updatedAt, now);
  const ci = ciLabel(card);
  const tone = spendTone(card.spend);
  return (
    <div
      className={styles.card}
      data-card-id={card.id}
      data-active={active || undefined}
      data-selected={selected || undefined}
      data-column={card.column}
      data-reason={card.reason}
      tabIndex={0}
      role="button"
      aria-pressed={selected}
      aria-label={`${card.title}. ${card.reasonText}.${card.unread ? ' Unread.' : ''}`}
      onFocus={onFocus}
      onClick={(e) => {
        if (e.shiftKey || e.metaKey) onToggleSelect();
        else onDetails();
      }}
      onDoubleClick={onOpen}
    >
      <div className={styles.cardTop}>
        <input
          type="checkbox"
          className={styles.cardCheck}
          checked={selected}
          aria-label={`Select ${card.title}`}
          onClick={(e) => e.stopPropagation()}
          onChange={onToggleSelect}
          tabIndex={-1}
        />
        {card.unread ? <span className={styles.unreadDot} aria-hidden="true" /> : null}
        <span className={styles.cardTitle}>{card.title}</span>
        {card.pinned ? <span className={styles.pin} aria-label="Pinned">•</span> : null}
      </div>
      <div className={styles.cardMeta}>
        {card.engine ? <span className={styles.seatChip} data-engine={card.engine}>{ENGINE_LABEL[card.engine]}{card.model ? ` · ${card.model}` : ''}</span> : null}
        {card.repo ? <span className={styles.muted}>{card.repo}{card.branch ? ` · ${card.branch}` : ''}</span> : null}
      </div>
      <div className={styles.cardReason} data-reason={card.reason}>{card.reasonText}</div>
      <div className={styles.cardStats}>
        {time ? <span title={card.startedAt ? 'Running for' : 'Last activity'}>{time}</span> : null}
        <span data-tone={tone} title="At API list price — an equivalent">{spendLabel(card.spend)}</span>
        {ci ? <span>{ci}</span> : null}
        {card.autoFix ? <span className={styles.flag}>auto-fix</span> : null}
        {card.autoMerge ? <span className={styles.flag}>auto-merge</span> : null}
      </div>
      {card.lastActivity ? <div className={styles.cardLast}>{card.lastActivity}</div> : null}
    </div>
  );
}
