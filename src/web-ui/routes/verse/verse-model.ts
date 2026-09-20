/**
 * routes/verse/verse-model.ts — small pure helpers shared by the Verse
 * components (labels, grouping, health → tone). No React, no I/O.
 */
import type { VerseEngine, VerseProject, VerseSeat, VerseSeatHealth, VerseSession } from '../../data/api-types.js';
import type { Tone } from '../../components/primitives/StatusBadge.js';

export const ENGINE_ORDER: readonly VerseEngine[] = ['claude', 'codex', 'grok', 'local'];

export const ENGINE_LABEL: Record<VerseEngine, string> = {
  claude: 'Claude',
  codex: 'Codex',
  grok: 'Grok',
  local: 'Local',
};

export function isVerseEngine(value: string): value is VerseEngine {
  return (ENGINE_ORDER as readonly string[]).includes(value);
}

export function projectName(path: string, projects: readonly VerseProject[] = []): string {
  const known = projects.find((p) => p.path === path);
  if (known) return known.name;
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function seatById(seats: readonly VerseSeat[], seatId: string): VerseSeat | undefined {
  return seats.find((s) => s.id === seatId);
}

export function seatLabel(seats: readonly VerseSeat[], session: Pick<VerseSession, 'seatId' | 'engine'>): string {
  return seatById(seats, session.seatId)?.label ?? ENGINE_LABEL[session.engine];
}

export function modelLabel(seats: readonly VerseSeat[], session: Pick<VerseSession, 'seatId' | 'model'>): string {
  const seat = seatById(seats, session.seatId);
  return seat?.models.find((m) => m.id === session.model)?.label ?? session.model;
}

/** Context window for a session: the model's own figure when the seat knows it, else the seat default. */
export function contextWindowFor(seats: readonly VerseSeat[], session: Pick<VerseSession, 'seatId' | 'model' | 'usage'>): number | null {
  if (session.usage.contextWindow) return session.usage.contextWindow;
  const seat = seatById(seats, session.seatId);
  return seat?.models.find((m) => m.id === session.model)?.contextWindow ?? seat?.contextWindow ?? null;
}

export function healthTone(state: VerseSeatHealth['state']): Tone {
  switch (state) {
    case 'ready':
      return 'success';
    case 'degraded':
      return 'warning';
    case 'unavailable':
      return 'danger';
    default:
      return 'unknown';
  }
}

export function seatUnavailableReason(seat: VerseSeat): string | null {
  if (seat.health.state !== 'unavailable') return null;
  return seat.health.summary ?? 'seat unavailable';
}

/** Seats grouped in the fixed engine order; empty engines are omitted. */
export function groupSeats(seats: readonly VerseSeat[]): Array<{ engine: VerseEngine; seats: VerseSeat[] }> {
  return ENGINE_ORDER.map((engine) => ({ engine, seats: seats.filter((s) => s.engine === engine) })).filter((g) => g.seats.length > 0);
}

export interface SessionGroup {
  projectPath: string;
  name: string;
  enrolled: boolean;
  sessions: VerseSession[];
}

/** Sidebar grouping: by project, most recently touched project first, sessions newest first. */
export function groupSessions(sessions: readonly VerseSession[], projects: readonly VerseProject[], query = ''): SessionGroup[] {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? sessions.filter((s) =>
        s.title.toLowerCase().includes(q) ||
        s.projectPath.toLowerCase().includes(q) ||
        s.model.toLowerCase().includes(q) ||
        s.seatId.toLowerCase().includes(q))
    : [...sessions];
  const byProject = new Map<string, VerseSession[]>();
  for (const s of filtered) {
    const list = byProject.get(s.projectPath) ?? [];
    list.push(s);
    byProject.set(s.projectPath, list);
  }
  const groups: SessionGroup[] = [];
  for (const [projectPath, list] of byProject) {
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    groups.push({
      projectPath,
      name: projectName(projectPath, projects),
      enrolled: projects.find((p) => p.path === projectPath)?.enrolled ?? false,
      sessions: list,
    });
  }
  groups.sort((a, b) => b.sessions[0]!.updatedAt.localeCompare(a.sessions[0]!.updatedAt));
  return groups;
}

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return formatElapsed(ms);
}

/**
 * Sidebar rows carry a right-aligned relative time. Short by design — the
 * row has ~5ch for it — and it degrades to a date rather than "412d".
 * `now` is injectable so the format is testable without faking the clock.
 */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 0) return 'now';
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(then).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** One-line description of a tool call for a collapsed card header. */
export function summarizeToolInput(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return truncate(input, 96);
  if (typeof input !== 'object') return truncate(String(input), 96);
  const record = input as Record<string, unknown>;
  const preferred = ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt', 'text'];
  for (const key of preferred) {
    const v = record[key];
    if (typeof v === 'string' && v.trim()) return truncate(v.trim().replace(/\s+/g, ' '), 96);
  }
  const keys = Object.keys(record);
  if (keys.length === 0) return '';
  const first = record[keys[0]!];
  const rendered = typeof first === 'string' ? first : JSON.stringify(first);
  return truncate(`${keys[0]}: ${rendered ?? ''}`.replace(/\s+/g, ' '), 96);
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Pretty JSON for tool cards; falls back to String() for non-serializable input. */
export function prettyJson(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

/**
 * Accepts POSIX/Windows absolute paths and `~/...`. The server rewrites the
 * home directory as `~` in every outbound payload (sanitizePublicJson) and
 * expands it again on the way in, so a `~/` project from bootstrap is valid.
 */
export function isAbsolutePath(value: string): boolean {
  return /^(?:\/|~(?:\/|$)|[a-zA-Z]:[\\/]|\\\\)/.test(value) &&
    ![...value].some((c) => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159));
}

/**
 * Seat pill text: "<seat> · <model>", collapsing to just the seat when the
 * model label is already contained in it (local seats expose one model whose
 * name is the seat name), so the pill never reads "Qwen3-Coder · Qwen3-Coder".
 */
export function seatPillLabel(seats: readonly VerseSeat[], ref: Pick<VerseSession, 'seatId' | 'engine' | 'model'>): string {
  const seat = seatLabel(seats, ref);
  const model = modelLabel(seats, ref);
  if (!model || seat.toLowerCase().includes(model.toLowerCase())) return seat;
  return `${seat} · ${model}`;
}
