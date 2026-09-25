/**
 * Delivery tracker (unit C1): for every non-terminal task, ask GitHub for a
 * PR whose head is `task.branch` (`gh pr list --repo <repo> --head <branch>
 * --state all --json number,url,state,isDraft,title,body --limit 1`), update
 * state/pr/report, and expire tasks with no PR after CLOUD_TASK_EXPIRY_MS.
 * `gh` failures leave tasks unchanged (never throw into callers).
 */
import { notImplemented } from './_stub.js';

export interface CloudTrackerDeps {
  gh?: (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  now?: () => Date;
}

export function refreshCloudTasks(_deps?: CloudTrackerDeps): Promise<{ checked: number; updated: number }> { return notImplemented('refreshCloudTasks'); }
