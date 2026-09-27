/**
 * Outcomes per playbook version, counted from retros (learn/retro) that carry
 * the playbook ref. A retro exists only once a task ENDED, so a running task
 * counts nowhere yet; `null` would mean unknown, zero means none ended.
 */
import type { RetroEndKind, RetroV1 } from '../learn/retro/types.js';
import type { PlaybookOutcomeCounts } from './types.js';

const REFUSED: ReadonlySet<RetroEndKind> = new Set<RetroEndKind>(['gate-refused', 'owner-laned', 'closed', 'vetoed']);
const FAILED: ReadonlySet<RetroEndKind> = new Set<RetroEndKind>(['verify-failed', 'failed', 'expired']);

export function emptyOutcomes(): PlaybookOutcomeCounts {
  return { merged: 0, refused: 0, reverted: 0, failed: 0, total: 0 };
}

/** Counts by version for one playbook id. Pure. */
export function countPlaybookOutcomes(retros: readonly Pick<RetroV1, 'endKind' | 'playbookRef'>[], id: string): Map<number, PlaybookOutcomeCounts> {
  const out = new Map<number, PlaybookOutcomeCounts>();
  for (const r of retros) {
    const ref = r.playbookRef;
    if (!ref || ref.id !== id) continue;
    const row = out.get(ref.version) ?? emptyOutcomes();
    if (r.endKind === 'merged') row.merged += 1;
    else if (r.endKind === 'reverted') row.reverted += 1;
    else if (REFUSED.has(r.endKind)) row.refused += 1;
    else if (FAILED.has(r.endKind)) row.failed += 1;
    row.total += 1;
    out.set(ref.version, row);
  }
  return out;
}

/** Counts by version, read from the retro store. Unreadable ⇒ empty. */
export async function playbookOutcomes(id: string): Promise<Map<number, PlaybookOutcomeCounts>> {
  try {
    const { listRetros } = await import('../learn/retro/store.js');
    return countPlaybookOutcomes(await listRetros(), id);
  } catch {
    return new Map();
  }
}
