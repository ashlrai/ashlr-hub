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
import type { EngineId, EngineTier, WorkItem, WorkSource } from '../types.js';
import { isActionableSelfHealItem } from '../fleet/self-heal-trust.js';
import { generatedRepairGenerationId } from '../fleet/generated-repair-lifecycle.js';

const WORK_SOURCES = new Set<WorkSource>([
  'issue', 'todo', 'test', 'dep', 'doc', 'security', 'plugin', 'self', 'lint', 'goal', 'hygiene', 'invent',
]);
const ENGINE_IDS = new Set<EngineId>([
  'builtin', 'local-coder', 'ashlrcode', 'aw', 'claude', 'codex', 'hermes', 'kimi', 'nim', 'opencode', 'grok',
]);
const ENGINE_TIERS = new Set<EngineTier>(['local', 'mid', 'frontier']);

function validRepairParentMetadata(item: Partial<WorkItem>): boolean {
  const hasMetadata =
    item.repairParentItemId !== undefined ||
    item.repairParentSource !== undefined ||
    item.repairParentBackend !== undefined ||
    item.repairParentTier !== undefined;
  if (!hasMetadata) return true;
  return (
    typeof item.repairParentItemId === 'string' &&
    item.repairParentItemId.length > 0 &&
    item.repairParentItemId.length <= 180 &&
    typeof item.repairParentSource === 'string' &&
    WORK_SOURCES.has(item.repairParentSource as WorkSource) &&
    (item.repairParentBackend === null ||
      (typeof item.repairParentBackend === 'string' && ENGINE_IDS.has(item.repairParentBackend as EngineId))) &&
    (item.repairParentTier === null ||
      (typeof item.repairParentTier === 'string' && ENGINE_TIERS.has(item.repairParentTier as EngineTier)))
  );
}

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
    typeof item.ts === 'string' &&
    validRepairParentMetadata(item)
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
