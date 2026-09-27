/**
 * Does a goal's `project` target this repo path?
 *
 * Goals are bound to a local checkout (`goal.project`, e.g.
 * ~/Desktop/github/dev-tools/binshield). Under a standing grant the resident
 * daemon never works in Mason's checkouts: it enrolls only the fleet's own
 * mirrors (~/.ashlr/fleet/mirrors/<owner>__<name>, fleet/mirrors.ts). An
 * exact-path match therefore never held there, and every goal — including
 * those on repos inside the grant — was skipped without a log line (live,
 * 2026-09-27: 0 goal work items across 21 open goals).
 *
 * Rule: the exact path always matches (unchanged). In addition, when `repo`
 * IS a fleet mirror, a goal whose checkout's GitHub `origin` is that mirror's
 * repo targets it too. Nothing else widens: two different checkouts of one
 * repo still do not match each other, a checkout without a GitHub origin
 * never matches a mirror, and which mirrors exist is still decided by the
 * grant's current stage (planAutonomousEnrollment) — this only lets a goal
 * reach a mirror that is already enrolled.
 *
 * READ-ONLY (a .git/config read, cached by repo-identity.ts). Never throws.
 */
import { basename, dirname, resolve } from 'node:path';

import { fleetMirrorsDir, repoIdentityOfPath } from '../fleet/repo-identity.js';

function mirrorIdentityOf(repo: string): string | null {
  try {
    if (resolve(dirname(repo)) !== resolve(fleetMirrorsDir())) return null;
    if (!basename(repo).includes('__')) return null;
    return repoIdentityOfPath(resolve(repo));
  } catch {
    return null;
  }
}

export function goalProjectMatchesRepo(project: string | null | undefined, repo: string): boolean {
  if (typeof project !== 'string' || project.length === 0) return false;
  try {
    if (resolve(project) === resolve(repo)) return true;
    const mirror = mirrorIdentityOf(repo);
    if (mirror === null) return false;
    const target = repoIdentityOfPath(resolve(project));
    return target !== null && target.toLowerCase() === mirror.toLowerCase();
  } catch {
    return false;
  }
}
