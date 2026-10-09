/**
 * The one-call hooks each lane uses. Kept here so the edits inside the lanes
 * (daemon loop, cloud service, Devin service, Leader, Verse chat turns) stay a
 * line or two.
 *
 * Every hook is guidance only: it changes what the brief says, never a route,
 * gate, budget cap or authority. No playbook ⇒ the prompt is byte-identical.
 */
import { listLatestPlaybooksSync, recordPlaybookUse } from './store.js';
import { appendPlaybookBlock, findMacroMentions, isAgentPlaybook, renderPlaybookBlock, resolvePlaybook, resolvePlaybookSync } from './resolve.js';
import type { PlaybookMatch, PlaybookRef, TaskKind } from './types.js';

/**
 * Fleet: append the playbook a daemon work item asks for (by `!macro` in its
 * title/detail — goals, Leader dispatches) or auto-matches, and record the
 * use against the dispatch `runId`, which the resulting Proposal carries.
 * Synchronous (fleet goal assembly is). Never throws. Read-only routing previews
 * pass recordUse:false, rendering the same block without recording a launch.
 */
export interface PreparedFleetPlaybook {
  prompt: string;
  use: { ref: PlaybookRef; match: PlaybookMatch } | null;
}
/** Read-only resolution/rendering; the selected immutable ref can be recorded after admission. */
export function prepareFleetPlaybook(goal: string, item: { repo: string; title: string; detail: string }): PreparedFleetPlaybook {
  try {
    const resolved = resolvePlaybookSync({ text: `${item.title}\n${item.detail}`, repo: item.repo });
    if (!resolved) return { prompt: goal, use: null };
    const block = renderPlaybookBlock(resolved.playbook);
    return block ? { prompt: appendPlaybookBlock(goal, block), use: { ref: resolved.ref, match: resolved.match } }
      : { prompt: goal, use: null };
  } catch { return { prompt: goal, use: null }; }
}
export function withFleetPlaybook(goal: string, item: { repo: string; title: string; detail: string }, runId: string,
  opts: { recordUse?: boolean } = {}): string {
  const prepared = prepareFleetPlaybook(goal, item);
  if (opts.recordUse !== false && prepared.use) void recordPlaybookUse({ lane: 'fleet', key: runId, ...prepared.use });
  return prepared.prompt;
}

export type LaunchPlaybook =
  | { ok: true; ref: PlaybookRef | null; match: PlaybookMatch | null; block: string }
  | { ok: false; error: string };

/**
 * Cloud / Devin launches: resolve once, before the task record is written, so
 * the record carries `playbookRef` and the launch renders exactly that
 * version. An explicit playbook that does not exist refuses the launch (the
 * caller asked for it; running without it would be a silent downgrade).
 */
export async function playbookForLaunch(input: { explicit?: unknown; title: string; prompt: string; repo: string; kind?: TaskKind | null }): Promise<LaunchPlaybook> {
  const explicit = typeof input.explicit === 'string' && input.explicit.trim() ? input.explicit.trim().slice(0, 80) : null;
  const outcome = await resolvePlaybook({ explicit, text: `${input.title}\n${input.prompt}`, repo: input.repo, kind: input.kind ?? null });
  if (!outcome.ok) return outcome;
  if (!outcome.resolved) return { ok: true, ref: null, match: null, block: '' };
  const block = renderPlaybookBlock(outcome.resolved.playbook);
  if (!block) return { ok: true, ref: null, match: null, block: '' };
  return { ok: true, ref: outcome.resolved.ref, match: outcome.resolved.match, block };
}

/** A chat message's playbook: the block the seat reads, and what the transcript shows. */
export interface ChatPlaybook {
  block: string;
  ref: PlaybookRef;
  name: string;
  macro: string;
}

/**
 * Verse chats, every seat (3.15): the playbook the operator TYPED as a
 * `!macro` in this message. Never an auto-match — a chat is a conversation,
 * the same rule the Devin chat launch keeps (devin/service.ts). An unknown
 * `!word` (or a pin to a version that does not exist) is not a playbook: the
 * message goes as written. Synchronous (the engine's turn start is), and no
 * disk read at all unless the text mentions a `!word`. Never throws.
 */
export function chatPlaybook(text: string, repo: string | null): ChatPlaybook | null {
  try {
    if (findMacroMentions(text).length === 0) return null;
    const resolved = resolvePlaybookSync({ text, repo });
    if (!resolved || resolved.match !== 'macro') return null;
    const block = renderPlaybookBlock(resolved.playbook);
    if (!block) return null;
    return { block, ref: resolved.ref, name: resolved.playbook.meta.name, macro: resolved.playbook.meta.macro };
  } catch {
    return null;
  }
}

/** What the Leader sees, so its work.dispatch can name a playbook. Bounded; [] on any failure. */
export interface LeaderPlaybookRow {
  id: string;
  name: string;
  kinds: TaskKind[];
  description: string;
}

export function leaderPlaybookCatalog(limit = 30): LeaderPlaybookRow[] {
  try {
    // Command workflows are terminal templates, never something a dispatch can run under.
    return listLatestPlaybooksSync().filter(isAgentPlaybook).slice(0, limit).map((p) => ({
      id: p.meta.id,
      name: p.meta.name,
      kinds: p.meta.taskKinds,
      description: p.meta.description.slice(0, 160),
    }));
  } catch {
    return [];
  }
}
