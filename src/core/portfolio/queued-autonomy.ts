/**
 * queued-autonomy.ts — read-only access to generated autonomy work.
 *
 * Self-heal stores work in ~/.ashlr/self-heal-queue.json and invent may append
 * source:"invent" work to ~/.ashlr/backlog.json. These queues are observational
 * inputs only: this module never refreshes scanners or writes state.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { WorkItem } from '../types.js';
import { isActionableSelfHealItem } from '../fleet/self-heal-trust.js';
import { generatedRepairGenerationId } from '../fleet/generated-repair-lifecycle.js';

function isWorkItemLike(value: unknown): value is WorkItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<WorkItem>;
  return (
    typeof item.id === 'string' &&
    typeof item.repo === 'string' &&
    typeof item.source === 'string' &&
    typeof item.title === 'string' &&
    typeof item.detail === 'string' &&
    typeof item.value === 'number' &&
    typeof item.effort === 'number' &&
    typeof item.score === 'number' &&
    Array.isArray(item.tags) &&
    item.tags.every((tag) => typeof tag === 'string') &&
    typeof item.ts === 'string'
  );
}

function readWorkItemsFile(filePath: string): WorkItem[] {
  try {
    if (!existsSync(filePath)) return [];
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (Array.isArray(raw)) return raw.filter(isWorkItemLike);
    if (
      raw &&
      typeof raw === 'object' &&
      Array.isArray((raw as { items?: unknown }).items)
    ) {
      return (raw as { items: unknown[] }).items.filter(isWorkItemLike);
    }
    return [];
  } catch {
    return [];
  }
}

function isQueuedAutonomyItem(item: WorkItem): boolean {
  if (item.source === 'invent') return true;
  if (!item.tags.includes('self-heal')) return false;
  const generationId = generatedRepairGenerationId(item);
  if ((item.repairHandoffId !== undefined || item.repairGenerationId !== undefined) && !generationId) return false;
  return isActionableSelfHealItem(item, generationId
    ? { maxAgeMs: Number.MAX_SAFE_INTEGER }
    : undefined);
}

/** Return all queued self-heal/invent items without mutating any state. */
export function loadQueuedAutonomyItems(): WorkItem[] {
  const root = join(homedir(), '.ashlr');
  const queued = [
    ...readWorkItemsFile(join(root, 'self-heal-queue.json')),
    ...readWorkItemsFile(join(root, 'backlog.json')),
  ];
  const seen = new Set<string>();
  const result: WorkItem[] = [];
  for (const item of queued) {
    if (!isQueuedAutonomyItem(item)) continue;
    const key = `${resolve(item.repo)}\0${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/** Return queued self-heal/invent work for a single enrolled repo. */
export function loadQueuedAutonomyItemsForRepo(repo: string, limit = 25): WorkItem[] {
  const repoKey = resolve(repo);
  const result: WorkItem[] = [];
  for (const item of loadQueuedAutonomyItems()) {
    if (resolve(item.repo) !== repoKey) continue;
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}
