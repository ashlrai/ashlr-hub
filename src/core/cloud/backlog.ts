/**
 * Self-improvement backlog (unit C1): built-in items (improvement-backlog.ts)
 * plus operator/Leader items at `<cloudHome>/backlog.json`. An item is
 * "claimed" by its newest task; it becomes available again 3 days after
 * that task ends closed/failed/expired, never after merged.
 *
 * File: `{ "v": 1, "items": CloudBacklogItem[] }`, 0600, at most
 * CLOUD_BACKLOG_MAX_USER_ITEMS items. Readers validate every item and skip
 * the bad ones, so one hand-mangled entry cannot hide the rest.
 */
import { join } from 'node:path';

import { readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';
import { BUILTIN_IMPROVEMENT_BACKLOG } from './improvement-backlog.js';
import { CLOUD_REPO_PATTERN, cloudHome, ensureCloudDirectory, listCloudTasks } from './store.js';
import { CLOUD_PROMPT_MAX_CHARS, type CloudBacklogItem, type CloudBacklogView, type CloudTaskState, type CloudTaskV1 } from './types.js';

export const CLOUD_BACKLOG_FILE = 'backlog.json';
export const CLOUD_BACKLOG_MAX_USER_ITEMS = 200;
/** A closed/failed/expired item is retried after this long (a merged one never is). */
export const CLOUD_BACKLOG_RETRY_MS = 3 * 24 * 60 * 60 * 1000;

const BACKLOG_VERSION = 1;
/** 200 items × a 20 000-char prompt, with room for JSON escaping. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const MAX_TITLE_CHARS = 200;
const MAX_AREA_CHARS = 40;

const RETRYABLE: readonly CloudTaskState[] = ['closed', 'failed', 'expired'];

export function cloudBacklogPath(): string {
  return join(cloudHome(), CLOUD_BACKLOG_FILE);
}

/** A clean copy of a valid item, or null. Titles and areas are trimmed; nothing else is rewritten. */
export function validBacklogItem(value: unknown): CloudBacklogItem | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const id = r['id'];
  const title = typeof r['title'] === 'string' ? r['title'].trim() : '';
  const prompt = typeof r['prompt'] === 'string' ? r['prompt'] : '';
  const area = typeof r['area'] === 'string' ? r['area'].trim() : '';
  const priority = r['priority'];
  const repo = r['repo'];
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  if (title === '' || title.length > MAX_TITLE_CHARS) return null;
  if (prompt.trim() === '' || prompt.length > CLOUD_PROMPT_MAX_CHARS) return null;
  if (area === '' || area.length > MAX_AREA_CHARS) return null;
  if (priority !== 1 && priority !== 2 && priority !== 3) return null;
  if (repo !== undefined && (typeof repo !== 'string' || !CLOUD_REPO_PATTERN.test(repo))) return null;
  return { id, title, prompt, area, priority, ...(repo !== undefined ? { repo } : {}) };
}

/** Dedupe key for titles: case, punctuation and spacing do not make an item new. */
export function normaliseBacklogTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The operator/Leader items on disk, validated, deduped, capped. Total: any bad file reads as empty. */
export function readUserBacklogItems(): CloudBacklogItem[] {
  const file = readPrivateFileCapped(cloudBacklogPath(), MAX_FILE_BYTES);
  if (!file || file.truncated) return [];
  let value: unknown;
  try {
    value = JSON.parse(file.text);
  } catch {
    return [];
  }
  // A bare array is accepted too: it is what an operator writes by hand.
  const raw = Array.isArray(value) ? value
    : value !== null && typeof value === 'object' && Array.isArray((value as Record<string, unknown>)['items'])
      ? (value as Record<string, unknown>)['items'] as unknown[]
      : [];
  const ids = new Set(BUILTIN_IMPROVEMENT_BACKLOG.map((item) => item.id));
  const titles = new Set(BUILTIN_IMPROVEMENT_BACKLOG.map((item) => normaliseBacklogTitle(item.title)));
  const items: CloudBacklogItem[] = [];
  for (const entry of raw) {
    if (items.length >= CLOUD_BACKLOG_MAX_USER_ITEMS) break;
    const item = validBacklogItem(entry);
    if (!item || ids.has(item.id) || titles.has(normaliseBacklogTitle(item.title))) continue;
    ids.add(item.id);
    titles.add(normaliseBacklogTitle(item.title));
    items.push(item);
  }
  return items;
}

/** Built-in first, then user items, each in file order: the tie-break after priority. */
function allItems(): CloudBacklogItem[] {
  return [...BUILTIN_IMPROVEMENT_BACKLOG, ...readUserBacklogItems()];
}

interface Claim {
  claimedBy: string | null;
  lastState: CloudTaskState | null;
}

/** Newest task per backlog item id. */
function newestTaskByItem(tasks: readonly CloudTaskV1[]): Map<string, CloudTaskV1> {
  const newest = new Map<string, CloudTaskV1>();
  for (const task of tasks) {
    if (!task.backlogItemId) continue;
    const seen = newest.get(task.backlogItemId);
    if (!seen || Date.parse(task.createdAt) > Date.parse(seen.createdAt)) newest.set(task.backlogItemId, task);
  }
  return newest;
}

function claimOf(task: CloudTaskV1 | undefined, nowMs: number): Claim {
  if (!task) return { claimedBy: null, lastState: null };
  if (RETRYABLE.includes(task.state)) {
    // updatedAt is when the task last changed — for a terminal task, when it ended.
    const endedAt = Date.parse(task.updatedAt);
    const released = Number.isFinite(endedAt) && nowMs - endedAt >= CLOUD_BACKLOG_RETRY_MS;
    return { claimedBy: released ? null : task.id, lastState: task.state };
  }
  // Non-terminal: in progress. Merged: done for good.
  return { claimedBy: task.id, lastState: task.state };
}

function ordered<T extends CloudBacklogItem>(items: readonly T[]): T[] {
  return items.map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.priority - b.item.priority || a.index - b.index)
    .map(({ item }) => item);
}

export function readCloudBacklog(tasks: readonly CloudTaskV1[], now: Date): CloudBacklogView {
  const newest = newestTaskByItem(tasks);
  const nowMs = now.getTime();
  const items = ordered(allItems()).map((item) => ({ ...item, ...claimOf(newest.get(item.id), nowMs) }));
  return { items, nextUp: items.find((item) => item.claimedBy === null)?.id ?? null };
}

/** Next unclaimed item for `repo`, highest priority first, then built-in order. */
export function nextBacklogItem(tasks: readonly CloudTaskV1[], repo: string, now: Date): CloudBacklogItem | null {
  const newest = newestTaskByItem(tasks);
  const nowMs = now.getTime();
  const target = repo.toLowerCase();
  // An item without a repo targets whichever repo self-improvement is pointed at.
  const match = ordered(allItems()).find((item) =>
    (item.repo === undefined || item.repo.toLowerCase() === target) && claimOf(newest.get(item.id), nowMs).claimedBy === null);
  return match ?? null;
}

/** Adds items (dedupe by id and by normalised title); returns how many were new. Leader/operator entry point. */
export function appendUserBacklogItems(items: readonly CloudBacklogItem[]): number {
  if (!Array.isArray(items) || items.length === 0) return 0;
  let existing = readUserBacklogItems();
  const ids = new Set([...BUILTIN_IMPROVEMENT_BACKLOG, ...existing].map((item) => item.id));
  const titles = new Set([...BUILTIN_IMPROVEMENT_BACKLOG, ...existing].map((item) => normaliseBacklogTitle(item.title)));
  const fresh: CloudBacklogItem[] = [];
  for (const entry of items) {
    const item = validBacklogItem(entry);
    if (!item || ids.has(item.id) || titles.has(normaliseBacklogTitle(item.title))) continue;
    ids.add(item.id);
    titles.add(normaliseBacklogTitle(item.title));
    fresh.push(item);
  }
  if (fresh.length === 0) return 0;

  if (existing.length + fresh.length > CLOUD_BACKLOG_MAX_USER_ITEMS) {
    // Make room by retiring items that are finished for good (their newest
    // task merged), oldest first — never an item still waiting to run.
    const newest = newestTaskByItem(listCloudTasks());
    let excess = existing.length + fresh.length - CLOUD_BACKLOG_MAX_USER_ITEMS;
    existing = existing.filter((item) => {
      if (excess > 0 && newest.get(item.id)?.state === 'merged') {
        excess -= 1;
        return false;
      }
      return true;
    });
  }
  const accepted = fresh.slice(0, Math.max(0, CLOUD_BACKLOG_MAX_USER_ITEMS - existing.length));
  if (accepted.length === 0) return 0;
  ensureCloudDirectory();
  writePrivateFileAtomic(cloudBacklogPath(), `${JSON.stringify({ v: BACKLOG_VERSION, items: [...existing, ...accepted] }, null, 2)}\n`);
  return accepted.length;
}
