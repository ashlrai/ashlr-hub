/**
 * routes/verse/agents/agents-model.ts — the Agents board's pure half: columns,
 * keyboard movement, filters, labels, the seat roster for "same task on N
 * seats", and the spawn form's validation. No React, no fetch — table-tested.
 */
import {
  AGENT_COLUMNS,
  type AgentCard,
  type AgentColumn,
  type AgentSpend,
} from '../../../../core/verse/agents/types.js';
import type { VerseSeat } from '../../../../core/verse/types.js';
import { groupSeats, seatUnavailableReason } from '../verse-model.js';

export type BoardColumns = Record<AgentColumn, AgentCard[]>;

export interface BoardFilter {
  repo: string | null;
  query: string;
  /** Hide Done older than this many ms (null = show every Done card). */
  doneWithinMs: number | null;
}

export const DEFAULT_FILTER: BoardFilter = { repo: null, query: '', doneWithinMs: 3 * 24 * 60 * 60 * 1000 };

export function filterCards(cards: readonly AgentCard[], filter: BoardFilter, now: number): AgentCard[] {
  const q = filter.query.trim().toLowerCase();
  return cards.filter((c) => {
    if (filter.repo && c.repo !== filter.repo) return false;
    if (q && ![c.title, c.repo ?? '', c.branch ?? '', c.model ?? '', c.seatId ?? '', c.reasonText].some((s) => s.toLowerCase().includes(q))) return false;
    if (c.column === 'done' && filter.doneWithinMs !== null && !c.pinned) {
      const t = Date.parse(c.updatedAt);
      if (Number.isFinite(t) && now - t > filter.doneWithinMs) return false;
    }
    return true;
  });
}

export function groupByColumn(cards: readonly AgentCard[]): BoardColumns {
  const out: BoardColumns = { working: [], 'needs-you': [], review: [], done: [] };
  for (const c of cards) out[c.column].push(c);
  return out;
}

export function reposOf(cards: readonly AgentCard[]): string[] {
  return [...new Set(cards.map((c) => c.repo).filter((r): r is string => Boolean(r)))].sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Keyboard movement: ↑/↓ (j/k) within a column, ←/→ (h/l) across columns
// ---------------------------------------------------------------------------

export interface BoardCursor {
  column: AgentColumn;
  index: number;
}

export type MoveDirection = 'up' | 'down' | 'left' | 'right' | 'first' | 'last';

/** The next cursor. Empty columns are skipped sideways; the row is clamped to the new column. */
export function moveCursor(columns: BoardColumns, cursor: BoardCursor | null, dir: MoveDirection): BoardCursor | null {
  const nonEmpty = AGENT_COLUMNS.filter((c) => columns[c].length > 0);
  if (nonEmpty.length === 0) return null;
  if (!cursor || columns[cursor.column].length === 0) return { column: nonEmpty[0]!, index: 0 };
  const list = columns[cursor.column];
  const index = Math.min(cursor.index, list.length - 1);
  switch (dir) {
    case 'up':
      return { column: cursor.column, index: Math.max(0, index - 1) };
    case 'down':
      return { column: cursor.column, index: Math.min(list.length - 1, index + 1) };
    case 'first':
      return { column: cursor.column, index: 0 };
    case 'last':
      return { column: cursor.column, index: list.length - 1 };
    case 'left':
    case 'right': {
      const at = nonEmpty.indexOf(cursor.column);
      const step = dir === 'left' ? -1 : 1;
      const nextColumn = nonEmpty[at + step];
      if (!nextColumn) return { column: cursor.column, index };
      return { column: nextColumn, index: Math.min(index, columns[nextColumn].length - 1) };
    }
  }
}

export function cardAt(columns: BoardColumns, cursor: BoardCursor | null): AgentCard | null {
  if (!cursor) return null;
  return columns[cursor.column][cursor.index] ?? null;
}

/** Where a card id sits now (cards move between polls; the cursor follows the card). */
export function locate(columns: BoardColumns, id: string): BoardCursor | null {
  for (const column of AGENT_COLUMNS) {
    const index = columns[column].findIndex((c) => c.id === id);
    if (index >= 0) return { column, index };
  }
  return null;
}

/**
 * "Mark read" targets: never a Needs-you card (marking read does not clear
 * something blocked on you), never one already read.
 */
export function markReadTargets(cards: readonly AgentCard[], ids?: ReadonlySet<string>): string[] {
  return cards.filter((c) => (!ids || ids.has(c.id)) && c.column !== 'needs-you' && c.unread && c.sessionId).map((c) => c.id);
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export function elapsedLabel(fromIso: string | null, now: number): string | null {
  if (!fromIso) return null;
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function agoLabel(iso: string | null, now: number): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function usd(n: number): string {
  return n >= 100 ? `$${Math.round(n)}` : n >= 10 ? `$${n.toFixed(1)}` : `$${n.toFixed(2)}`;
}

/** "$1.24 of $5" / "$0.80" / "12.4k tokens" (no list price). */
export function spendLabel(spend: AgentSpend): string {
  if (spend.usd === null) return spend.tokens > 0 ? `${compactTokens(spend.tokens)} tokens` : '—';
  return spend.capUsd !== null ? `${usd(spend.usd)} of ${usd(spend.capUsd)}` : usd(spend.usd);
}

export function spendTone(spend: AgentSpend): 'neutral' | 'warning' | 'danger' {
  if (spend.fraction === null) return 'neutral';
  if (spend.fraction >= 1) return 'danger';
  return spend.fraction >= 0.8 ? 'warning' : 'neutral';
}

export function compactTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function ciLabel(card: AgentCard): string | null {
  const c = card.checks;
  if (!c) return null;
  if (!c.pr) return c.ci === 'unknown' ? null : c.dirty > 0 ? `${c.dirty} uncommitted` : c.ahead > 0 ? `${c.ahead} ahead` : null;
  const state = c.pr.state === 'merged' ? 'merged' : c.pr.state === 'closed' ? 'closed' : c.ci === 'passing' ? 'green' : c.ci === 'failing' ? 'red' : c.ci === 'pending' ? 'running' : 'no checks';
  return `#${c.pr.number} ${state}`;
}

// ---------------------------------------------------------------------------
// Seats for "same task on N seats"
// ---------------------------------------------------------------------------

export interface SeatRow {
  seatId: string;
  label: string;
  engine: VerseSeat['engine'];
  model: string | null;
  modelLabel: string | null;
  disabled: string | null;
}

/** Each seat with its first runnable model, in the picker's engine order. */
export function seatRows(seats: readonly VerseSeat[]): SeatRow[] {
  const rows: SeatRow[] = [];
  for (const group of groupSeats(seats)) {
    for (const seat of group.seats) {
      const seatReason = seatUnavailableReason(seat);
      const model = seat.models.find((m) => !(typeof m.unavailableReason === 'string' && m.unavailableReason.trim()));
      rows.push({
        seatId: seat.id,
        label: seat.label,
        engine: seat.engine,
        model: model?.id ?? null,
        modelLabel: model?.label ?? null,
        disabled: seatReason ?? (model ? null : 'No model on this seat can run right now.'),
      });
    }
  }
  return rows;
}

export interface SpawnForm {
  root: string;
  title: string;
  prompt: string;
  seats: Array<{ seatId: string; model: string }>;
  isolate: boolean;
  planFirst: boolean;
  capText: string;
  autoFix: boolean;
  autoMerge: boolean;
}

export type SpawnCheck = { ok: true; cap: number | null } | { ok: false; error: string };

export function checkSpawnForm(form: SpawnForm): SpawnCheck {
  if (!form.root) return { ok: false, error: 'Pick a repository.' };
  if (form.seats.length === 0) return { ok: false, error: 'Pick at least one seat.' };
  if (form.seats.length > 1 && !form.isolate) return { ok: false, error: 'Several seats on one task each need their own workspace.' };
  if (!form.prompt.trim()) return { ok: false, error: 'Say what the agent should do.' };
  if (form.autoMerge && !form.isolate) return { ok: false, error: 'Auto-merge needs the agent in its own workspace (its own branch).' };
  const capText = form.capText.trim().replace(/^\$/, '');
  let cap: number | null = null;
  if (capText) {
    const n = Number(capText);
    if (!Number.isFinite(n) || n <= 0 || n > 10_000) return { ok: false, error: 'The spend cap is a dollar amount above 0.' };
    cap = Math.round(n * 100) / 100;
  }
  return { ok: true, cap };
}

/** A title from the prompt's first line when none was typed. */
export function titleFromPrompt(prompt: string): string {
  const first = prompt.trim().split('\n')[0]?.trim() ?? '';
  const clean = first.replace(/[#*`>_]/g, '').trim();
  if (!clean) return 'Agent';
  return clean.length <= 60 ? clean : `${clean.slice(0, 57).replace(/\s+\S*$/, '')}…`;
}
