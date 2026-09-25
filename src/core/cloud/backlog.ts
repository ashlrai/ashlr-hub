/**
 * Self-improvement backlog (unit C1): built-in items (improvement-backlog.ts)
 * plus operator/Leader items at `<cloudHome>/backlog.json`. An item is
 * "claimed" by its newest task; it becomes available again 3 days after
 * that task ends closed/failed/expired, never after merged.
 */
import type { CloudBacklogItem, CloudBacklogView, CloudTaskV1 } from './types.js';
import { notImplemented } from './_stub.js';

export function readCloudBacklog(_tasks: readonly CloudTaskV1[], _now: Date): CloudBacklogView { return notImplemented('readCloudBacklog'); }
/** Next unclaimed item for `repo`, highest priority first, then built-in order. */
export function nextBacklogItem(_tasks: readonly CloudTaskV1[], _repo: string, _now: Date): CloudBacklogItem | null { return notImplemented('nextBacklogItem'); }
/** Adds items (dedupe by id and by normalised title); returns how many were new. Leader/operator entry point. */
export function appendUserBacklogItems(_items: readonly CloudBacklogItem[]): number { return notImplemented('appendUserBacklogItems'); }
