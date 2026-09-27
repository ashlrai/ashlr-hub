/**
 * The one-call hooks each lane uses. Kept here so the edits inside the lanes
 * (daemon loop, cloud service, Devin service, Leader) stay a line or two.
 *
 * Every hook is guidance only: it changes what the brief says, never a route,
 * gate, budget cap or authority. No playbook ⇒ the prompt is byte-identical.
 */
import { listLatestPlaybooksSync, recordPlaybookUse } from './store.js';
import { appendPlaybookBlock, renderPlaybookBlock, resolvePlaybook, resolvePlaybookSync } from './resolve.js';
import type { PlaybookMatch, PlaybookRef, TaskKind } from './types.js';

/**
 * Fleet: append the playbook a daemon work item asks for (by `!macro` in its
 * title/detail — goals, Leader dispatches) or auto-matches, and record the
 * use against the dispatch `runId`, which the resulting Proposal carries.
 * Synchronous (fleet goal assembly is). Never throws.
 */
export function withFleetPlaybook(goal: string, item: { repo: string; title: string; detail: string }, runId: string): string {
  try {
    const resolved = resolvePlaybookSync({ text: `${item.title}\n${item.detail}`, repo: item.repo });
    if (!resolved) return goal;
    const block = renderPlaybookBlock(resolved.playbook);
    if (!block) return goal;
    void recordPlaybookUse({ lane: 'fleet', key: runId, ref: resolved.ref, match: resolved.match });
    return appendPlaybookBlock(goal, block);
  } catch {
    return goal;
  }
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

/** What the Leader sees, so its work.dispatch can name a playbook. Bounded; [] on any failure. */
export interface LeaderPlaybookRow {
  id: string;
  name: string;
  kinds: TaskKind[];
  description: string;
}

export function leaderPlaybookCatalog(limit = 30): LeaderPlaybookRow[] {
  try {
    return listLatestPlaybooksSync().slice(0, limit).map((p) => ({
      id: p.meta.id,
      name: p.meta.name,
      kinds: p.meta.taskKinds,
      description: p.meta.description.slice(0, 160),
    }));
  } catch {
    return [];
  }
}
