import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WorkItem } from '../types.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';

export interface PruneQueuedSelfHealItemsResult {
  scanned: number;
  removed: number;
  failed: boolean;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  renameSync(tmp, filePath);
}

function readQueue(path: string): WorkItem[] {
  if (!existsSync(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('self-heal queue is malformed');
  return parsed as WorkItem[];
}

/** Remove selected generated rows from both mutable queue projections. */
export function pruneQueuedSelfHealItems(
  shouldRemove: (item: WorkItem) => boolean,
): PruneQueuedSelfHealItemsResult {
  const root = join(homedir(), '.ashlr');
  const lock = acquireLocalStoreLock(join(root, '.self-heal-queue.lock'));
  if (!lock) return { scanned: 0, removed: 0, failed: true };
  let scanned = 0;
  let removed = 0;
  let failed = false;
  try {
    const path = join(root, 'self-heal-queue.json');
    const existing = readQueue(path);
    scanned += existing.length;
    const filtered = existing.filter((item) => !shouldRemove(item));
    removed += existing.length - filtered.length;
    if (filtered.length !== existing.length) writeJsonAtomic(path, filtered);
  } catch {
    failed = true;
  }
  try {
    const path = join(root, 'backlog.json');
    if (existsSync(path)) {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (Array.isArray(parsed)) {
        scanned += parsed.length;
        const filtered = parsed.filter((item) => !shouldRemove(item as WorkItem));
        removed += parsed.length - filtered.length;
        if (filtered.length !== parsed.length) writeJsonAtomic(path, filtered);
      } else if (
        parsed &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as { items?: unknown }).items)
      ) {
        const envelope = parsed as { items: unknown[] };
        scanned += envelope.items.length;
        const filtered = envelope.items.filter((item) => !shouldRemove(item as WorkItem));
        removed += envelope.items.length - filtered.length;
        if (filtered.length !== envelope.items.length) writeJsonAtomic(path, { ...parsed, items: filtered });
      }
    }
  } catch {
    failed = true;
  }
  releaseLocalStoreLock(lock);
  return { scanned, removed, failed };
}
