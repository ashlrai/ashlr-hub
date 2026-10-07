/** Existing primary→fleet-mirror identity matching, narrowed to a unique current enrollment. */
import { realpathSync } from 'node:fs';
import { goalProjectMatchesRepo } from '../goals/project-match.js';

export function resolveManagerSessionTargets(roots: readonly string[], enrolled: readonly string[]): string[] | null {
  if (!roots.length || new Set(roots).size !== roots.length || new Set(enrolled).size !== enrolled.length) return null;
  try {
    const targets: string[] = [];
    for (const root of roots) {
      if (realpathSync.native(root) !== root) return null;
      // The existing helper is asymmetric: a primary checkout may reach its enrolled mirror.
      // Two ordinary checkouts of the same repository never match each other.
      const candidates = enrolled.filter(target => realpathSync.native(target) === target && goalProjectMatchesRepo(root, target));
      if (candidates.length !== 1) return null;
      targets.push(candidates[0]!);
    }
    return [...new Set(targets)].sort();
  } catch { return null; }
}

export function managerSessionTargetsMatch(roots: readonly string[], enrolled: readonly string[], targets: readonly string[]): boolean {
  const mapped = resolveManagerSessionTargets(roots, enrolled);
  return mapped !== null && mapped.length === targets.length && mapped.every(target => targets.includes(target));
}
