/**
 * routes/verse/chat/turn-model.ts — a session as a list of TURNS.
 *
 * `verse-store.groupTranscriptItems()` already folds runs of tool calls into
 * one summary row; what it does not do is say where one exchange ends and
 * the next begins. Everything this file exists for needs that boundary: the
 * per-turn file-activity summary (the blast radius of one ask), the outline
 * that makes a fifty-turn session navigable, keyboard movement between
 * turns, and "jump to the first error in this turn".
 *
 * Pure over `groupTranscriptItems()`'s output — no React, no DOM, no
 * fetching — so the numbers in the summary can be tested directly against an
 * event log.
 */
import { parseUnifiedDiff } from '../../inbox/diff-parser.js';
import type { ToolGroupItem, TranscriptItem, TranscriptRenderItem } from '../verse-store.js';
import { readToolFacts, type ToolAction, type ToolFacts } from './tool-semantics.js';

export type TurnStatus = 'running' | 'ok' | 'error' | 'stopped';

/**
 * Work that survives a transcript rebuild.
 *
 * `buildTurns` runs on EVERY streamed token: `useVerseSession` rebuilds
 * `state.events` per event, `buildTranscript` allocates fresh item objects from
 * it, and both of Transcript's memos therefore miss. Without this, every delta
 * re-derived the semantics of every tool call in the session — including a full
 * LCS diff per Edit payload, which allocates an `Int32Array` up to the 1200-line
 * cap. Fifty moderate edits cost hundreds of milliseconds of main-thread work
 * per frame, on the one surface whose frame budget is already spoken for.
 *
 * Caching is sound because `toolUseId` is a stable identity and a tool call's
 * `{name, input, result}` is immutable ONCE ITS RESULT HAS LANDED
 * (`verse-store.buildTranscript` replaces the item object exactly once, when the
 * `tool-result` event arrives). A cached entry derived while the call was still
 * pending is therefore the only one that can go stale, and it is the only one
 * recomputed.
 */
export interface TurnCache {
  facts: Map<string, ToolFacts>;
  /** `countDiffLines` over the same immutable diff text. */
  counts: Map<string, { additions: number; deletions: number }>;
  /** Flattened searchable text per tool call — the expensive half of the index. */
  toolText: Map<string, string>;
}

export function createTurnCache(): TurnCache {
  return { facts: new Map(), counts: new Map(), toolText: new Map() };
}

/**
 * Facts for one tool call, reusing the cached instance whenever it is still
 * valid. Exported so a test can assert the second build recomputes nothing.
 */
export function cachedToolFacts(
  tool: { toolUseId: string; name: string; input: unknown; result: { output: string; isError: boolean } | null },
  cache: TurnCache | null,
): ToolFacts {
  const hit = cache?.facts.get(tool.toolUseId);
  // A pending entry must be recomputed once the result lands; anything else is
  // derived from data that can no longer change.
  if (hit && !(hit.pending && tool.result !== null)) return hit;
  const fact = readToolFacts({ name: tool.name, input: tool.input, result: tool.result });
  if (cache) {
    cache.facts.set(tool.toolUseId, fact);
    cache.counts.delete(tool.toolUseId);
    cache.toolText.delete(tool.toolUseId);
  }
  return fact;
}

export interface TurnFileEntry {
  path: string;
  reads: number;
  edits: number;
  creates: number;
  deletes: number;
  /** The strongest thing that happened to it: delete > create > edit > read. */
  action: Extract<ToolAction, 'read' | 'edit' | 'create' | 'delete'>;
  /** Tool call to scroll to when the row is clicked. */
  anchorToolUseId: string;
  /** Summed from the diffs the calls carried; 0 when none did. */
  additions: number;
  deletions: number;
  /** At least one call touching this file failed. */
  failed: boolean;
}

export interface TurnBlock {
  key: string;
  turnId: string | null;
  items: TranscriptRenderItem[];
  /** The ask that opened the turn, for the outline. */
  prompt: string | null;
  /** ISO stamp of the first item. */
  at: string;
  files: TurnFileEntry[];
  toolCount: number;
  commandCount: number;
  /** Failing tool calls plus logged errors. */
  errorCount: number;
  /** Id of the first failing thing in the turn, for jump-to-error. */
  firstErrorAnchor: string | null;
  status: TurnStatus;
  durationMs: number | null;
}

export interface TurnModel {
  turns: TurnBlock[];
  /** Facts keyed by toolUseId, so the cards do not re-derive them. */
  facts: Map<string, ToolFacts>;
  /** Every error anchor in document order — the transcript-level jump list. */
  errorAnchors: string[];
}

/** DOM id for a note (error / stopped / turn-done) so it can be scrolled to. */
export function noteAnchorId(key: string): string {
  return `verse-note-${key.replace(/[^A-Za-z0-9_-]/g, '')}`;
}

/** DOM id for one turn section. */
export function turnAnchorId(key: string): string {
  return `verse-turn-${key.replace(/[^A-Za-z0-9_-]/g, '')}`;
}

const STRENGTH: Record<TurnFileEntry['action'], number> = { read: 0, edit: 1, create: 2, delete: 3 };

/**
 * Additions/deletions for a unified diff, summed across every file in it.
 *
 * This was a flat scan that skipped any line starting with `---` or `+++` as a
 * file header. Inside a hunk those prefixes are CONTENT, not structure: a
 * deleted line reading `-- a/x` is emitted as `--- a/x`, a Markdown `---` rule
 * deleted is `----`, and a diff of a diff — what editing a `.patch` fixture or
 * running `git diff` over one produces — is made almost entirely of them. Every
 * such line was dropped, so the `+N −M` on the collapsed tool card undercounted
 * exactly the changes that are hardest to eyeball.
 *
 * Delegating to the shared parser (`routes/inbox/diff-parser.ts`) fixes that
 * and retires the second diff dialect: `DiffBlock` renders `file.additions` /
 * `file.deletions` out of this same parse, so the badge on the summary line and
 * the stats in the expanded block are now the same numbers by construction
 * rather than by two implementations happening to agree.
 *
 * Cost is real but bounded and paid once: `cachedDiffCounts` memoizes by
 * `toolUseId`, and the text is capped at `MAX_FACT_TEXT_CHARS` upstream.
 */
export function countDiffLines(text: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const file of parseUnifiedDiff(text).files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { additions, deletions };
}

/** `countDiffLines` over text that cannot change once cached. */
function cachedDiffCounts(
  toolUseId: string,
  text: string,
  cache: TurnCache | null,
): { additions: number; deletions: number } {
  const hit = cache?.counts.get(toolUseId);
  if (hit) return hit;
  const counts = countDiffLines(text);
  cache?.counts.set(toolUseId, counts);
  return counts;
}

function toolMembers(item: TranscriptRenderItem): Array<Extract<TranscriptItem, { kind: 'tool' }>> {
  if (item.kind === 'tool') return [item];
  if (item.kind === 'toolGroup') {
    return (item as ToolGroupItem).items.filter((m): m is Extract<TranscriptItem, { kind: 'tool' }> => m.kind === 'tool');
  }
  return [];
}

/**
 * A new turn opens on a `user` item, or on any item whose turnId differs
 * from the one being accumulated. Items that arrive before the first user
 * message (a resumed session's tail, a session-level error with a null
 * turnId) collect into a leading block rather than being dropped.
 */
export function buildTurns(
  items: readonly TranscriptRenderItem[],
  cache: TurnCache | null = null,
): TurnModel {
  const facts = new Map<string, ToolFacts>();
  const errorAnchors: string[] = [];
  const turns: TurnBlock[] = [];

  let current: TranscriptRenderItem[] = [];
  const flush = () => {
    if (current.length === 0) return;
    turns.push(makeTurn(current, facts, errorAnchors, cache));
    current = [];
  };

  let turnId: string | null | undefined;
  for (const item of items) {
    const itemTurn = 'turnId' in item ? item.turnId : null;
    const boundary = item.kind === 'user' || (turnId !== undefined && itemTurn !== null && itemTurn !== turnId);
    if (boundary) flush();
    if (item.kind === 'user' || turnId === undefined || itemTurn !== null) turnId = itemTurn;
    current.push(item);
  }
  flush();

  return { turns, facts, errorAnchors };
}

function makeTurn(
  items: TranscriptRenderItem[],
  facts: Map<string, ToolFacts>,
  errorAnchors: string[],
  cache: TurnCache | null,
): TurnBlock {
  const first = items[0]!;
  const byPath = new Map<string, TurnFileEntry>();
  let toolCount = 0;
  let commandCount = 0;
  let errorCount = 0;
  let firstErrorAnchor: string | null = null;
  let status: TurnStatus = 'running';
  let durationMs: number | null = null;
  let prompt: string | null = null;

  const noteError = (anchor: string) => {
    errorCount++;
    if (!firstErrorAnchor) firstErrorAnchor = anchor;
    errorAnchors.push(anchor);
  };

  for (const item of items) {
    if (item.kind === 'user' && prompt === null) prompt = item.text;

    for (const tool of toolMembers(item)) {
      toolCount++;
      const fact = cachedToolFacts(tool, cache);
      facts.set(tool.toolUseId, fact);
      if (fact.action === 'command') commandCount++;
      if (fact.failed) noteError(`verse-tool-${tool.toolUseId.replace(/[^A-Za-z0-9_-]/g, '')}`);

      const action = fact.action;
      if (action !== 'read' && action !== 'edit' && action !== 'create' && action !== 'delete') continue;
      const counts = fact.diff ? cachedDiffCounts(tool.toolUseId, fact.diff.text, cache) : { additions: 0, deletions: 0 };
      for (const path of fact.paths) {
        const entry = byPath.get(path) ?? {
          path,
          reads: 0, edits: 0, creates: 0, deletes: 0,
          action,
          anchorToolUseId: tool.toolUseId,
          additions: 0, deletions: 0,
          failed: false,
        };
        if (action === 'read') entry.reads++;
        else if (action === 'edit') entry.edits++;
        else if (action === 'create') entry.creates++;
        else entry.deletes++;
        if (STRENGTH[action] > STRENGTH[entry.action]) {
          entry.action = action;
          // The row should land on the call that CHANGED the file, not on the
          // read that happened to come first.
          entry.anchorToolUseId = tool.toolUseId;
        }
        if (action !== 'read') {
          entry.additions += counts.additions;
          entry.deletions += counts.deletions;
        }
        if (fact.failed) entry.failed = true;
        byPath.set(path, entry);
      }
    }

    switch (item.kind) {
      case 'error':
        noteError(noteAnchorId(item.key));
        status = 'error';
        break;
      case 'cancelled':
        status = 'stopped';
        break;
      case 'turn-done':
        durationMs = item.durationMs > 0 ? item.durationMs : durationMs;
        // A stop already explained itself; `ok:false` after it is not a
        // second failure (the same rule Transcript's `explained` set uses).
        if (item.ok) status = status === 'running' ? 'ok' : status;
        else if (status === 'running') {
          status = 'error';
          noteError(noteAnchorId(item.key));
        }
        break;
      default:
        break;
    }
  }

  return {
    key: first.key,
    turnId: 'turnId' in first ? first.turnId : null,
    items,
    prompt,
    at: first.at,
    // Strongest action first. The map is in first-touch order, and an agentic
    // turn reads widely before editing narrowly — so in read order the three
    // edits in a 40-file turn sit behind "Show 35 more files", hiding exactly
    // the rows whose `+N −M` justified the summary in the first place.
    files: [...byPath.values()].sort(
      (a, b) =>
        STRENGTH[b.action] - STRENGTH[a.action] ||
        b.additions + b.deletions - (a.additions + a.deletions) ||
        a.path.localeCompare(b.path),
    ),
    toolCount,
    commandCount,
    errorCount,
    firstErrorAnchor,
    status,
    durationMs,
  };
}

/** `12 files · 4 edited, 8 read` — the one-line form for a collapsed summary. */
export function describeFiles(files: readonly TurnFileEntry[]): string {
  if (files.length === 0) return '';
  const counts = { edited: 0, created: 0, deleted: 0, read: 0 };
  for (const file of files) {
    if (file.action === 'edit') counts.edited++;
    else if (file.action === 'create') counts.created++;
    else if (file.action === 'delete') counts.deleted++;
    else counts.read++;
  }
  const parts: string[] = [];
  if (counts.created) parts.push(`${counts.created} created`);
  if (counts.edited) parts.push(`${counts.edited} edited`);
  if (counts.deleted) parts.push(`${counts.deleted} deleted`);
  if (counts.read) parts.push(`${counts.read} read`);
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// In-session search
// ---------------------------------------------------------------------------

/**
 * Everything in a turn that is worth searching, flattened once and cached on
 * the turn object. A rebuilt transcript produces new objects, so the WeakMap
 * lets the old strings go with them.
 */
const SEARCH_TEXT = new WeakMap<TurnBlock, string>();

/** Per tool call — a build log should not make one turn megabytes of index. */
const TOOL_TEXT_LIMIT = 4000;

/**
 * One tool call flattened for search. Cached by `toolUseId` under the same
 * immutability rule as the facts: `JSON.stringify` of a 4000-char payload per
 * call per keystroke is what made an active query cost the whole session.
 */
function toolSearchText(
  item: Extract<TranscriptItem, { kind: 'tool' }>,
  cache: TurnCache | null,
): string {
  const hit = cache?.toolText.get(item.toolUseId);
  if (hit !== undefined) return hit;
  const parts: string[] = [item.name];
  if (typeof item.input === 'string') parts.push(item.input.slice(0, TOOL_TEXT_LIMIT));
  else if (item.input) {
    try {
      parts.push(JSON.stringify(item.input).slice(0, TOOL_TEXT_LIMIT));
    } catch {
      /* a payload that will not stringify simply is not searchable */
    }
  }
  if (item.result) parts.push(item.result.output.slice(0, TOOL_TEXT_LIMIT));
  const text = parts.join('\n');
  // Only cache a finished call: a pending one's output is still to come.
  if (cache && item.result) cache.toolText.set(item.toolUseId, text);
  return text;
}

export function turnSearchText(turn: TurnBlock, cache: TurnCache | null = null): string {
  const cached = SEARCH_TEXT.get(turn);
  if (cached !== undefined) return cached;
  const parts: string[] = [];
  const visit = (item: TranscriptRenderItem | TranscriptItem): void => {
    switch (item.kind) {
      case 'user':
      case 'assistant':
      case 'thinking':
        parts.push(item.text);
        break;
      case 'error':
        parts.push(item.message);
        break;
      case 'tool':
        parts.push(toolSearchText(item, cache));
        break;
      case 'toolGroup':
        for (const member of (item as ToolGroupItem).items) visit(member);
        break;
      default:
        break;
    }
  };
  for (const item of turn.items) visit(item);
  const text = parts.join('\n');
  SEARCH_TEXT.set(turn, text);
  return text;
}

export interface TurnMatch {
  turnKey: string;
  /** Text around the first hit, for the outline row. */
  snippet: string;
}

const SNIPPET_PAD = 48;

/** Case-insensitive substring search across every turn, in document order. */
export function searchTurns(
  turns: readonly TurnBlock[],
  query: string,
  cache: TurnCache | null = null,
): TurnMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const out: TurnMatch[] = [];
  for (const turn of turns) {
    const haystack = turnSearchText(turn, cache);
    const at = haystack.toLowerCase().indexOf(needle);
    if (at === -1) continue;
    const from = Math.max(0, at - SNIPPET_PAD);
    const to = Math.min(haystack.length, at + needle.length + SNIPPET_PAD);
    const snippet = `${from > 0 ? '…' : ''}${haystack.slice(from, to).replace(/\s+/g, ' ').trim()}${to < haystack.length ? '…' : ''}`;
    out.push({ turnKey: turn.key, snippet });
  }
  return out;
}

/** Turn title for the outline: the ask, trimmed to one line. */
export function turnTitle(turn: TurnBlock, max = 72): string {
  const source = turn.prompt?.replace(/\s+/g, ' ').trim();
  if (source) return source.length > max ? `${source.slice(0, max - 1)}…` : source;
  if (turn.toolCount > 0) return `${turn.toolCount} tool call${turn.toolCount === 1 ? '' : 's'}`;
  return 'Session note';
}
