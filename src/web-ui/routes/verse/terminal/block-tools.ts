/**
 * terminal/block-tools.ts — what the 3.15 block actions compute, pure (so it
 * is tested without a terminal):
 *
 *   - filter-in-block: an output's lines kept (or dropped, inverted) by a
 *     substring or a regular expression, colour codes kept on the lines shown;
 *   - multi-select: shift-click ranges and ⌘/Ctrl-click toggles;
 *   - bookmarks: per tab, remembered on this device;
 *   - the message a SET of blocks becomes (Send / Ask with several selected);
 *   - `verse://terminal/<tab>/<block>` links;
 *   - how long a running block has been running ("1m 12s").
 */
import { blockChatText, fenceFor, tailForChat, type BlockView, type ChatIntent } from './blocks-model.js';

// ---------------------------------------------------------------------------
// Filter in block
// ---------------------------------------------------------------------------

export interface OutputFilter {
  pattern: string;
  regex: boolean;
  invert: boolean;
  caseSensitive: boolean;
}

export const EMPTY_FILTER: OutputFilter = { pattern: '', regex: false, invert: false, caseSensitive: false };

// eslint-disable-next-line no-control-regex
const SGR_RE = /\x1b\[[0-9;:]*m/g;

/**
 * The lines of `text` (ANSI kept) whose PLAIN text matches — or, inverted,
 * does not. `error` is set (and every line kept) for an invalid regex, so the
 * view never goes blank while one is being typed.
 */
export function filterOutputLines(text: string, filter: OutputFilter): { text: string; shown: number; total: number; error: string | null } {
  const lines = text.split('\n');
  if (!filter.pattern) return { text, shown: lines.length, total: lines.length, error: null };
  let test: (line: string) => boolean;
  if (filter.regex) {
    let re: RegExp;
    try {
      re = new RegExp(filter.pattern, filter.caseSensitive ? '' : 'i');
    } catch (err) {
      return { text, shown: lines.length, total: lines.length, error: err instanceof Error ? err.message : 'invalid regular expression' };
    }
    test = (line) => re.test(line);
  } else {
    const needle = filter.caseSensitive ? filter.pattern : filter.pattern.toLowerCase();
    test = (line) => (filter.caseSensitive ? line : line.toLowerCase()).includes(needle);
  }
  const kept = lines.filter((line) => test(line.replace(SGR_RE, '')) !== filter.invert);
  return { text: kept.join('\n'), shown: kept.length, total: lines.length, error: null };
}

// ---------------------------------------------------------------------------
// Multi-select
// ---------------------------------------------------------------------------

export interface BlockSelection {
  ids: ReadonlySet<string>;
  /** Where the next shift-click range starts. */
  anchor: string | null;
}

export const EMPTY_SELECTION: BlockSelection = { ids: new Set(), anchor: null };

/**
 * A click on a block with modifiers. `range` (shift) selects from the anchor
 * to this block, `toggle` (⌘/Ctrl) adds or removes this one; a plain click is
 * not a selection gesture (null = "not handled", the card folds instead).
 */
export function selectBlock(
  selection: BlockSelection,
  order: readonly string[],
  id: string,
  gesture: { range: boolean; toggle: boolean },
): BlockSelection | null {
  if (gesture.range) {
    const from = selection.anchor !== null ? order.indexOf(selection.anchor) : -1;
    const to = order.indexOf(id);
    if (to < 0) return selection;
    if (from < 0) return { ids: new Set([id]), anchor: id };
    const [a, b] = from <= to ? [from, to] : [to, from];
    const ids = new Set(gesture.toggle ? selection.ids : []);
    for (const x of order.slice(a, b + 1)) ids.add(x);
    return { ids, anchor: selection.anchor };
  }
  if (gesture.toggle) {
    const ids = new Set(selection.ids);
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    return { ids, anchor: id };
  }
  return null;
}

/** Drop ids that no longer exist (a block evicted from the tab). */
export function pruneSelection(selection: BlockSelection, order: readonly string[]): BlockSelection {
  const present = new Set(order);
  if ([...selection.ids].every((id) => present.has(id)) && (selection.anchor === null || present.has(selection.anchor))) return selection;
  return {
    ids: new Set([...selection.ids].filter((id) => present.has(id))),
    anchor: selection.anchor !== null && present.has(selection.anchor) ? selection.anchor : null,
  };
}

// ---------------------------------------------------------------------------
// Several blocks → one message
// ---------------------------------------------------------------------------

/** One message for several blocks, oldest first. `texts` are the server's `format=chat` (scrubbed) command + output. */
export function blocksChatText(
  items: ReadonlyArray<{ block: Pick<BlockView, 'exitCode' | 'failed' | 'cwd' | 'source' | 'running'>; command: string; output: string }>,
  intent: ChatIntent,
): string {
  if (items.length === 1) return blockChatText(items[0]!.block, items[0]!.command, items[0]!.output, intent);
  const failed = items.some(({ block }) => block.failed || (block.exitCode !== null && block.exitCode !== 0));
  const head = intent === 'explain'
    ? `I ran these ${items.length} commands in my terminal${failed ? ' and something failed' : ''}. Explain what went wrong and how to fix it — propose the fix, don't run anything yet.`
    : `I ran these ${items.length} commands in my terminal:`;
  const parts = [head];
  for (const { block, command, output } of items) {
    // Each block gets a share of the budget, so one long log cannot crowd the others out.
    const { text, cut } = tailForChat(output.length > 4_000 ? output.slice(-4_000) : output);
    const status = block.running ? 'still running' : block.exitCode !== null ? `exit ${block.exitCode}` : block.failed ? 'failed' : 'finished';
    const body = `$ ${command}${text ? `\n${text}` : ''}`;
    const fence = fenceFor(body);
    parts.push('', `${block.cwd ? `In \`${block.cwd}\`` : 'Command'} (${status})${cut || output.length > 4_000 ? ' — last lines only' : ''}:`, `${fence}console`, body, fence);
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Links, time
// ---------------------------------------------------------------------------

const TAB_RE = /^t-[a-z0-9]{1,32}$/;
const BLOCK_RE = /^b-\d{1,9}$/;

/** `verse://terminal/<tab>/<block>` — pasted into a chat or a note, it opens that block. */
export function terminalBlockLink(tabId: string, blockId?: string | null): string | null {
  if (!TAB_RE.test(tabId) || (blockId && !BLOCK_RE.test(blockId))) return null;
  return `verse://terminal/${tabId}${blockId ? `/${blockId}` : ''}`;
}

/** "12s", "1m 12s", "1h 03m": the sticky header's elapsed time. */
export function elapsedLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** `http://localhost:5173/` → `localhost:5173` for a button label. */
export function urlLabel(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// Per-device stores: bookmarks, the fix-chip setting
// ---------------------------------------------------------------------------

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;

const BOOKMARKS_KEY = 'ashlr.verse.terminal.bookmarks.v1';
/** Tabs are few and short-lived; the oldest are dropped past this. */
const BOOKMARK_TABS_MAX = 64;

export function loadBookmarks(storage: Store): Record<string, string[]> {
  try {
    const raw = storage?.getItem(BOOKMARKS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [tab, ids] of Object.entries(parsed as Record<string, unknown>)) {
      if (TAB_RE.test(tab) && Array.isArray(ids)) out[tab] = ids.filter((id): id is string => typeof id === 'string' && BLOCK_RE.test(id));
    }
    return out;
  } catch {
    return {};
  }
}

export function toggleBookmark(storage: Store, tabId: string, blockId: string): Record<string, string[]> {
  const all = loadBookmarks(storage);
  const list = all[tabId] ?? [];
  const next = list.includes(blockId) ? list.filter((id) => id !== blockId) : [...list, blockId];
  if (next.length > 0) {
    delete all[tabId];
    all[tabId] = next;
  } else {
    delete all[tabId];
  }
  const tabs = Object.keys(all);
  for (const old of tabs.slice(0, Math.max(0, tabs.length - BOOKMARK_TABS_MAX))) delete all[old];
  try {
    storage?.setItem(BOOKMARKS_KEY, JSON.stringify(all));
  } catch {
    /* this page only */
  }
  return all;
}

const FIX_CHIPS_KEY = 'ashlr.verse.terminal.fixChips.v1';

/** "Suggest fixes with the local model": ON unless turned off (it is free and never leaves this Mac). */
export function loadFixChipsEnabled(storage: Store): boolean {
  try {
    return storage?.getItem(FIX_CHIPS_KEY) !== '0';
  } catch {
    return true;
  }
}

export function saveFixChipsEnabled(storage: Store, on: boolean): void {
  try {
    storage?.setItem(FIX_CHIPS_KEY, on ? '1' : '0');
  } catch {
    /* this page only */
  }
}
