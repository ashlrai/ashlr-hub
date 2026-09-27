/**
 * routes/verse/panes/builtin/pane-models.ts — what the first-party Files,
 * Sources and Reasoning panes show, derived from the chat's transcript.
 * Pure (no React), so each is tested on its own.
 *
 * These are the STUB panes' models: the Reasoning + Sources unit and the
 * Files work replace the panes through the registry, and may keep or drop
 * these derivations.
 */
import type { TranscriptItem } from '../../verse-transcript.js';
import { actionForName, pathsIn, type ToolAction } from '../../chat/tool-semantics.js';

type ThinkingItem = Extract<TranscriptItem, { kind: 'thinking' }>;

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export type FileTouch = 'created' | 'edited' | 'deleted' | 'read';

export interface TouchedFile {
  path: string;
  /** The strongest thing done to it: created > edited > deleted > read. */
  touch: FileTouch;
  /** Tool calls that named it. */
  count: number;
  lastAt: string;
}

const TOUCH_FOR: Partial<Record<ToolAction, FileTouch>> = { create: 'created', edit: 'edited', delete: 'deleted', read: 'read' };
const TOUCH_RANK: Record<FileTouch, number> = { created: 3, edited: 2, deleted: 1, read: 0 };

/** Every file the chat's tool calls read or changed, changed ones first, then most recent. */
export function touchedFiles(items: readonly TranscriptItem[]): TouchedFile[] {
  const byPath = new Map<string, TouchedFile>();
  for (const item of items) {
    if (item.kind !== 'tool') continue;
    const touch = TOUCH_FOR[actionForName(item.name)];
    if (!touch) continue;
    // A failed edit changed nothing; a failed read still says where it looked.
    if (touch !== 'read' && item.result?.isError) continue;
    for (const path of pathsIn(item.input)) {
      const seen = byPath.get(path);
      if (!seen) {
        byPath.set(path, { path, touch, count: 1, lastAt: item.at });
        continue;
      }
      seen.count += 1;
      if (item.at > seen.lastAt) seen.lastAt = item.at;
      if (TOUCH_RANK[touch] > TOUCH_RANK[seen.touch]) seen.touch = touch;
    }
  }
  const changed = (f: TouchedFile) => (f.touch === 'read' ? 1 : 0);
  return [...byPath.values()].sort((a, b) => changed(a) - changed(b) || (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export type SourceKind = 'web' | 'search' | 'file';

export interface Source {
  key: string;
  kind: SourceKind;
  /** A URL, a query, or a path. */
  target: string;
  /** http(s) only — the one kind a link is drawn for. */
  href: string | null;
  at: string;
  failed: boolean;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function webTarget(input: unknown): { target: string; href: string | null; kind: SourceKind } | null {
  const rec = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : null;
  if (!rec) return null;
  const url = str(rec['url']) ?? str(rec['uri']);
  if (url) return { target: url, href: /^https?:\/\//i.test(url) ? url : null, kind: 'web' };
  const query = str(rec['query']) ?? str(rec['q']) ?? str(rec['search_query']);
  return query ? { target: query, href: null, kind: 'search' } : null;
}

/**
 * What the chat looked at to answer: pages fetched, web searches, files
 * read — newest first, one row per distinct target.
 */
export function chatSources(items: readonly TranscriptItem[]): Source[] {
  const out = new Map<string, Source>();
  const add = (source: Source) => {
    const id = `${source.kind}:${source.target}`;
    const seen = out.get(id);
    if (!seen || source.at > seen.at) out.set(id, { ...source, key: id });
  };
  for (const item of items) {
    if (item.kind !== 'tool') continue;
    const action = actionForName(item.name);
    const failed = item.result?.isError === true;
    if (action === 'web') {
      const web = webTarget(item.input);
      if (web) add({ key: '', kind: web.kind, target: web.target, href: web.href, at: item.at, failed });
    } else if (action === 'read') {
      for (const path of pathsIn(item.input)) add({ key: '', kind: 'file', target: path, href: null, at: item.at, failed });
    }
  }
  return [...out.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

// ---------------------------------------------------------------------------
// Reasoning
// ---------------------------------------------------------------------------

export interface ReasoningTurn {
  turnId: string;
  /** The operator's message that started the turn (first line), when it is in the log. */
  ask: string | null;
  blocks: ThinkingItem[];
}

/** The chat's thinking, turn by turn, newest turn first (blocks in the order they streamed). */
export function reasoningByTurn(items: readonly TranscriptItem[]): ReasoningTurn[] {
  const turns = new Map<string, ReasoningTurn>();
  const asks = new Map<string, string>();
  for (const item of items) {
    if (item.kind === 'user') asks.set(item.turnId, item.text.split('\n', 1)[0]!.slice(0, 140));
    if (item.kind !== 'thinking') continue;
    const turn = turns.get(item.turnId) ?? { turnId: item.turnId, ask: null, blocks: [] };
    turn.blocks.push(item);
    turns.set(item.turnId, turn);
  }
  return [...turns.values()].reverse().map((t) => ({ ...t, ask: asks.get(t.turnId) ?? null }));
}
