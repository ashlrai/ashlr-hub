/**
 * routes/verse/shell/palette-model.ts — the ⌘K palette as data (unit C1;
 * SPEC-310C §1 "⌘K palette"). Pure: items in, ranked groups out.
 *
 *   Needs you › Chats (running first) › Actions › Go to › Seats & Apps › Projects
 *
 *   `>` limits results to actions, `#` to chats (command-catalog PALETTE_PREFIXES).
 *   An empty query shows what needs you (top 3) and the last 5 actions run.
 *   Tab on an item with an argument ("New chat on…") lists its candidates.
 *
 * Ranking is a small fuzzy matcher, not a library: every query word must
 * match (title or keywords), contiguous and word-start matches win, and the
 * catalog's order breaks ties — so "stop" puts "Stop running chats…" above a
 * chat that merely contains an s, t, o and p.
 */
import type { VerseProject, VerseSeat, VerseSession } from '../../../data/api-types.js';
import {
  ENGINE_MONOGRAM,
  type NeedsYouItem,
  type VerseActivityRunning,
} from '../../../../core/verse/workbench-types.js';
import {
  formatChord,
  paletteCommands,
  PALETTE_GROUPS,
  PALETTE_PREFIXES,
  PALETTE_RECENT_LIMIT,
  findCommand,
  type CommandArgumentKind,
  type KeyPlatform,
  type PaletteGroupId,
  type WorkbenchCommand,
} from './command-catalog.js';

export type PaletteItemKind = 'needs-you' | 'chat' | 'command' | 'seat' | 'project' | 'argument';

export interface PaletteItem {
  /** Unique across the whole list (React key + active-descendant id). */
  key: string;
  kind: PaletteItemKind;
  group: PaletteGroupId | 'recent';
  title: string;
  /** Muted second part of the row. */
  subtitle: string | null;
  /** Right-aligned shortcut ("⇧⌘B"), when the command has one. */
  shortcut: string | null;
  /** A one-letter engine monogram for chats and seats; null otherwise. */
  monogram: string | null;
  engine: VerseSession['engine'] | null;
  /** Extra words that match but are not shown. */
  keywords: readonly string[];
  /** Tab fills this. */
  argument: { kind: CommandArgumentKind; prompt: string } | null;
  /** Painted as a warning (running chat, high-severity item). */
  tone: 'neutral' | 'running' | 'warn' | 'danger';
  /** What Enter does — interpreted by the component. */
  payload:
    | { kind: 'needs-you'; itemId: string }
    | { kind: 'chat'; sessionId: string }
    | { kind: 'command'; commandId: string }
    | { kind: 'seat'; seatId: string; label: string }
    | { kind: 'project'; path: string; name: string }
    | { kind: 'argument'; argument: { kind: CommandArgumentKind; id: string; label: string } };
}

export interface PaletteInput {
  needsYou: readonly NeedsYouItem[];
  running: readonly VerseActivityRunning[];
  sessions: readonly VerseSession[];
  seats: readonly VerseSeat[];
  projects: readonly VerseProject[];
  recentActions: readonly string[];
  platform: KeyPlatform;
  now?: number;
}

export const GROUP_LABEL: Readonly<Record<PaletteGroupId | 'recent', string>> = {
  ...(Object.fromEntries(PALETTE_GROUPS.map((g) => [g.id, g.label])) as Record<PaletteGroupId, string>),
  recent: 'Recent',
};

const GROUP_ORDER: readonly (PaletteGroupId | 'recent')[] = [
  'needs-you',
  'recent',
  ...PALETTE_GROUPS.map((g) => g.id).filter((id) => id !== 'needs-you'),
];

/** Per-group caps with a query (the palette is for jumping, not browsing). */
const GROUP_CAP: Readonly<Record<PaletteGroupId | 'recent', number>> = {
  'needs-you': 5,
  recent: PALETTE_RECENT_LIMIT,
  chats: 8,
  actions: 8,
  'go-to': 6,
  'seats-apps': 5,
  projects: 5,
};

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  const prev = text[index - 1]!;
  return /[\s\-_/.:·›,(]/.test(prev) || (/[a-z]/.test(prev) && /[A-Z]/.test(text[index]!));
}

/**
 * Score one query word against one text; null = no match. Contiguous beats
 * scattered, word-start beats mid-word, earlier beats later.
 */
export function fuzzyScore(word: string, text: string): number | null {
  const q = word.toLowerCase();
  if (!q) return 0;
  const lower = text.toLowerCase();
  const at = lower.indexOf(q);
  if (at >= 0) {
    // No length penalty: two titles that both START with the word tie, and
    // the catalog's order decides ("stop" → Stop running chats… before Stop
    // the fleet…, the everyday action before the drastic one).
    let score = 1_000 - at * 4;
    if (isWordStart(text, at)) score += 400;
    if (at === 0) score += 200;
    return score;
  }
  // Subsequence: every character in order.
  let score = 0;
  let from = 0;
  let prevHit = -2;
  for (const ch of q) {
    const hit = lower.indexOf(ch, from);
    if (hit < 0) return null;
    score += hit === prevHit + 1 ? 30 : 5;
    if (isWordStart(text, hit)) score += 20;
    score -= Math.min(20, hit - from);
    prevHit = hit;
    from = hit + 1;
  }
  return score;
}

/** Every word must match the title or a keyword; the best field per word counts. */
export function matchItem(item: Pick<PaletteItem, 'title' | 'subtitle' | 'keywords'>, query: string): number | null {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  let total = 0;
  for (const word of words) {
    let best: number | null = fuzzyScore(word, item.title);
    for (const field of [item.subtitle ?? '', ...item.keywords]) {
      if (!field) continue;
      const s = fuzzyScore(word, field);
      // A keyword / subtitle hit counts, but less than the title itself.
      if (s !== null) best = Math.max(best ?? Number.NEGATIVE_INFINITY, s * 0.6);
    }
    if (best === null) return null;
    total += best;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

function elapsed(startedAt: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(startedAt)) / 1000));
  if (!Number.isFinite(s)) return 'running';
  if (s < 60) return `running ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `running ${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `running ${Math.floor(m / 60)}h ${m % 60}m`;
}

function relative(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const m = Math.round((now - t) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function projectName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function commandItem(command: WorkbenchCommand, platform: KeyPlatform, group: PaletteGroupId | 'recent'): PaletteItem {
  const chord = command.keys[0];
  return {
    key: `${group}:cmd:${command.id}`,
    kind: 'command',
    group,
    title: command.title,
    subtitle: command.scope === 'chat' || command.scope === 'composer' ? 'in Chat' : null,
    shortcut: chord ? formatChord(chord, platform) : null,
    monogram: null,
    engine: null,
    keywords: [...(command.keywords ?? []), command.section.toLowerCase()],
    argument: command.argument ? { ...command.argument } : null,
    tone: command.guard?.confirm.destructive ? 'danger' : 'neutral',
    payload: { kind: 'command', commandId: command.id },
  };
}

/** Every candidate item, before the query. */
export function buildPaletteItems(input: PaletteInput): PaletteItem[] {
  const now = input.now ?? Date.now();
  const items: PaletteItem[] = [];

  for (const n of input.needsYou) {
    items.push({
      key: `needs-you:${n.id}`,
      kind: 'needs-you',
      group: 'needs-you',
      title: n.title,
      subtitle: n.subject.repo ?? n.subject.seatId ?? null,
      shortcut: null,
      monogram: n.subject.engine ? ENGINE_MONOGRAM[n.subject.engine] : null,
      engine: n.subject.engine,
      keywords: [n.kind.replace(/-/g, ' '), n.source, 'needs you'],
      argument: null,
      tone: n.severity === 'high' ? 'danger' : n.severity === 'warn' ? 'warn' : 'neutral',
      payload: { kind: 'needs-you', itemId: n.id },
    });
  }

  const running = new Map(input.running.map((r) => [r.sessionId, r] as const));
  const sessions = [...input.sessions].sort((a, b) => {
    const ra = running.has(a.id) || a.status === 'running' ? 0 : 1;
    const rb = running.has(b.id) || b.status === 'running' ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
  });
  for (const s of sessions) {
    const live = running.get(s.id);
    const isRunning = !!live || s.status === 'running';
    const status = isRunning ? (live ? elapsed(live.startedAt, now) : 'running') : s.status === 'error' ? 'failed' : relative(s.updatedAt, now);
    items.push({
      key: `chat:${s.id}`,
      kind: 'chat',
      group: 'chats',
      title: s.title || 'Untitled chat',
      subtitle: [projectName(s.projectPath), status].filter(Boolean).join(' · '),
      shortcut: null,
      monogram: ENGINE_MONOGRAM[s.engine],
      engine: s.engine,
      keywords: [s.model, s.seatId, projectName(s.projectPath)],
      argument: null,
      tone: isRunning ? 'running' : s.status === 'error' ? 'warn' : 'neutral',
      payload: { kind: 'chat', sessionId: s.id },
    });
  }

  for (const command of paletteCommands('actions')) items.push(commandItem(command, input.platform, 'actions'));
  for (const command of paletteCommands('go-to')) items.push(commandItem(command, input.platform, 'go-to'));

  for (const seat of input.seats) {
    items.push({
      key: `seat:${seat.id}`,
      kind: 'seat',
      group: 'seats-apps',
      title: `New chat on ${seat.label}`,
      subtitle: seat.id,
      shortcut: null,
      monogram: ENGINE_MONOGRAM[seat.engine],
      engine: seat.engine,
      keywords: [seat.engine, seat.label, 'seat', 'account'],
      argument: null,
      tone: 'neutral',
      payload: { kind: 'seat', seatId: seat.id, label: seat.label },
    });
  }

  for (const project of input.projects) {
    items.push({
      key: `project:${project.path}`,
      kind: 'project',
      group: 'projects',
      title: `New chat in ${project.name || projectName(project.path)}`,
      subtitle: project.enrolled ? 'enrolled in the fleet' : null,
      shortcut: null,
      monogram: null,
      engine: null,
      keywords: [project.name, projectName(project.path)],
      argument: null,
      tone: 'neutral',
      payload: { kind: 'project', path: project.path, name: project.name || projectName(project.path) },
    });
  }

  return items;
}

/** The candidates Tab offers for an argument. */
export function argumentItems(kind: CommandArgumentKind, input: PaletteInput): PaletteItem[] {
  const base = (id: string, label: string, subtitle: string | null, monogram: string | null, engine: PaletteItem['engine']): PaletteItem => ({
    key: `arg:${kind}:${id}`,
    kind: 'argument',
    group: 'actions',
    title: label,
    subtitle,
    shortcut: null,
    monogram,
    engine,
    keywords: [id],
    argument: null,
    tone: 'neutral',
    payload: { kind: 'argument', argument: { kind, id, label } },
  });
  switch (kind) {
    case 'seat':
      return input.seats.map((s) => base(s.id, s.label, s.id, ENGINE_MONOGRAM[s.engine], s.engine));
    case 'project':
      return input.projects.map((p) => base(p.path, p.name || projectName(p.path), null, null, null));
    case 'session':
      return input.sessions.map((s) => base(s.id, s.title || 'Untitled chat', projectName(s.projectPath), ENGINE_MONOGRAM[s.engine], s.engine));
    case 'section':
      return [];
    default:
      return [];
  }
}

export interface PaletteGroup {
  id: PaletteGroupId | 'recent';
  label: string;
  items: PaletteItem[];
}

export interface PaletteView {
  groups: PaletteGroup[];
  /** Flattened, in display order — what ↑/↓ walks. */
  flat: PaletteItem[];
  /** The prefix in force (`>` / `#`), if any. */
  prefix: '>' | '#' | null;
}

/** Items → ranked, grouped, capped view for `rawQuery`. */
export function paletteView(items: readonly PaletteItem[], rawQuery: string, recentActions: readonly string[], platform: KeyPlatform): PaletteView {
  let query = rawQuery;
  let prefix: '>' | '#' | null = null;
  const first = query.trimStart().charAt(0);
  if (first === '>' || first === '#') {
    prefix = first;
    query = query.trimStart().slice(1);
  }
  const only: PaletteGroupId | null = prefix ? PALETTE_PREFIXES[prefix] : null;
  const trimmed = query.trim();

  const groups = new Map<PaletteGroupId | 'recent', Array<{ item: PaletteItem; score: number; order: number }>>();
  const push = (item: PaletteItem, score: number, order: number) => {
    const list = groups.get(item.group) ?? [];
    list.push({ item, score, order });
    groups.set(item.group, list);
  };

  if (trimmed === '' && !prefix) {
    // Empty query: what needs you, then what you did last.
    items.filter((i) => i.group === 'needs-you').slice(0, 3).forEach((item, order) => push(item, 0, order));
    const recent = recentActions.map((id) => findCommand(id)).filter((c): c is WorkbenchCommand => c !== null && c.group !== null);
    const shown = recent.length > 0 ? recent : (['chat.new', 'needs-you.open', 'shortcuts.open'] as const).map((id) => findCommand(id)!);
    shown.slice(0, PALETTE_RECENT_LIMIT).forEach((command, order) => push(commandItem(command, platform, 'recent'), 0, order));
  } else {
    items.forEach((item, order) => {
      if (only && item.group !== only) return;
      const score = trimmed === '' ? 0 : matchItem(item, trimmed);
      if (score === null) return;
      push(item, score, order);
    });
  }

  const out: PaletteGroup[] = [];
  for (const id of GROUP_ORDER) {
    const list = groups.get(id);
    if (!list || list.length === 0) continue;
    // Chats: running first (SPEC-310C §1), then by match. Everything else by
    // match, with catalog / recency order breaking ties.
    const runRank = (e: { item: PaletteItem }) => (id === 'chats' && e.item.tone === 'running' ? 0 : 1);
    list.sort((a, b) => runRank(a) - runRank(b) || b.score - a.score || a.order - b.order);
    const cap = prefix ? 50 : GROUP_CAP[id];
    out.push({ id, label: GROUP_LABEL[id], items: list.slice(0, cap).map((e) => e.item) });
  }
  return { groups: out, flat: out.flatMap((g) => g.items), prefix };
}
