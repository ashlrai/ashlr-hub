/**
 * Cloud lane persistence (unit C1). Everything lives under `cloudHome()` =
 * `<ashlr home>/cloud` (resolve the ashlr home the same way capacity-history
 * does; never hard-code ~). Tasks: one JSON file per task at
 * `tasks/<id>.json`, written atomically (tmp + rename), mode 0600 in 0700
 * dirs, opened O_NOFOLLOW|O_NONBLOCK like capacity-history. Budget:
 * `budget.json`, defaults from DEFAULT_CLOUD_BUDGET when missing/corrupt.
 */
import type { CloudBudgetUpdate, CloudBudgetV1, CloudTaskV1 } from './types.js';
import { notImplemented } from './_stub.js';

export function cloudHome(): string { return notImplemented('cloudHome'); }
/** Newest first (by createdAt), corrupt files skipped, at most `limit` (default 500). */
export function listCloudTasks(_limit?: number): CloudTaskV1[] { return notImplemented('listCloudTasks'); }
export function readCloudTask(_id: string): CloudTaskV1 | null { return notImplemented('readCloudTask'); }
/** Atomic write; sets updatedAt. Rejects ids not matching CLOUD_TASK_ID_PATTERN. */
export function writeCloudTask(_task: CloudTaskV1): void { notImplemented('writeCloudTask'); }
export function readCloudBudget(): CloudBudgetV1 { return notImplemented('readCloudBudget'); }
/** Validates + clamps (non-negative, sane maxima), persists, returns the result. */
export function updateCloudBudget(_update: CloudBudgetUpdate): CloudBudgetV1 { return notImplemented('updateCloudBudget'); }
/** `ct_<yyyymmdd>T<hhmm>_<6 base36>` from a UTC clock + crypto random. */
export function newCloudTaskId(_now: Date): string { return notImplemented('newCloudTaskId'); }
