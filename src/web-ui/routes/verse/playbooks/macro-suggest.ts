/**
 * routes/verse/playbooks/macro-suggest.ts — the composer's `!` menu: the
 * playbooks whose macro (or id / name) matches what was typed after `!`.
 *
 * The list is read the first time a `!` trigger opens (not on every chat
 * mount), through the shared query cache, so the Playbooks section and the
 * ⋯ sheet reuse it. An older server with no playbooks route answers a
 * reason, not an error.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { playbookKindOf, type PlaybookSummary } from '../../../../core/playbooks/types.js';
import { ensureQuery, getQuerySnapshot, subscribeQuery } from '../../../data/cache.js';
import { playbooksQuery, type PlaybooksRead } from './playbooks-queries.js';

/** How long a read list is reused before the next `!` re-reads it. */
const LIST_MAX_AGE_MS = 60_000;

/**
 * Macro-prefix matches first, then id / name substrings; at most `limit`.
 * Command workflows are left out: no lane resolves their `!macro` (they are
 * pasted into a terminal from Playbooks or the terminal's menu). Pure.
 */
export function matchPlaybookMacros(allRows: readonly PlaybookSummary[], query: string, limit = 8): PlaybookSummary[] {
  const rows = allRows.filter((r) => playbookKindOf(r) === 'agent');
  const q = query.toLowerCase();
  const macroName = (r: PlaybookSummary) => r.macro.replace(/^!/, '');
  const prefix = rows.filter((r) => macroName(r).startsWith(q) || r.id.startsWith(q));
  const rest = q ? rows.filter((r) => !prefix.includes(r) && (r.name.toLowerCase().includes(q) || r.id.includes(q) || macroName(r).includes(q))) : [];
  return [...prefix, ...rest].slice(0, limit);
}

export interface MacroSuggestions {
  rows: PlaybookSummary[] | null;
  /** Why there is nothing to show (no route, unreachable); null while loading or when rows exist. */
  reason: string | null;
}

/** The playbook list while `active`; read on first activation. */
export function usePlaybookMacroSuggestions(active: boolean): MacroSuggestions {
  const key = playbooksQuery.key;
  const entry = useSyncExternalStore(
    useCallback((listener: () => void) => subscribeQuery(key, listener), [key]),
    () => getQuerySnapshot<PlaybooksRead>(key),
    () => getQuerySnapshot<PlaybooksRead>(key),
  );
  useEffect(() => {
    if (active) void ensureQuery(key, () => playbooksQuery.fetch(), LIST_MAX_AGE_MS).catch(() => undefined);
  }, [active, key]);
  const read = entry.data;
  if (!read) return { rows: null, reason: entry.error ? 'Playbooks could not be read.' : null };
  return { rows: read.value, reason: read.value ? null : read.reason ?? 'Playbooks could not be read.' };
}
