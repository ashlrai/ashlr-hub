/**
 * routes/verse/chat/turn-files.ts — the files the latest turn changed, for
 * the Review pane's "This turn" scope (slots.tsx `TurnFileChange`, unit C2).
 *
 * Read from the session's event log (the head's structural events — tool
 * calls and results, never streamed tokens), so it is recomputed when a
 * call lands, not per token. A call counts when it MUTATES the tree (edit,
 * create, delete — tool-semantics MUTATING_ACTIONS) and its result was not
 * an error. Paths are made relative to the root that contains them; a path
 * under none of the chat's roots is left out rather than guessed at.
 */
import type { VerseEvent } from '../../../data/api-types.js';
import type { TurnFileChange } from '../shell/slots.js';
import { MUTATING_ACTIONS, readToolFacts } from './tool-semantics.js';

function relativeTo(path: string, roots: readonly string[]): TurnFileChange | null {
  // The longest root wins: a worktree nested inside its repo is its own root.
  const sorted = [...roots].sort((a, b) => b.length - a.length);
  for (const root of sorted) {
    const prefix = root.endsWith('/') ? root : `${root}/`;
    if (path.startsWith(prefix)) return { root, path: path.slice(prefix.length) };
  }
  // A relative path is relative to the primary root (the CLI's cwd).
  if (!path.startsWith('/') && roots[0]) return { root: roots[0], path: path.replace(/^\.\//, '') };
  return null;
}

export function lastTurnFiles(events: readonly VerseEvent[], roots: readonly string[]): TurnFileChange[] {
  if (roots.length === 0) return [];
  let start = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]!.type === 'user-message') {
      start = i;
      break;
    }
  }
  const results = new Map<string, { output: string; isError: boolean }>();
  for (let i = start; i < events.length; i += 1) {
    const e = events[i]!;
    if (e.type === 'tool-result') results.set(e.toolUseId, { output: e.output, isError: e.isError });
  }
  const seen = new Set<string>();
  const out: TurnFileChange[] = [];
  for (let i = start; i < events.length; i += 1) {
    const e = events[i]!;
    if (e.type !== 'tool-use') continue;
    const result = results.get(e.toolUseId);
    if (!result || result.isError) continue;
    const facts = readToolFacts({ name: e.name, input: e.input, result });
    if (!MUTATING_ACTIONS.includes(facts.action) || facts.failed) continue;
    for (const path of facts.paths) {
      const change = relativeTo(path, roots);
      if (!change) continue;
      const key = `${change.root}\u0000${change.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(change);
    }
  }
  return out;
}
