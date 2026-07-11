import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import type { WorkItem } from '../types.js';
import { loadExistingProvenanceKey, loadOrCreateKey } from '../foundry/provenance.js';
import { scrubSecrets } from '../util/scrub.js';

function normalized(value: string): string {
  return scrubSecrets(value).normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Metadata-only identity for the current scanner-owned objective meaning. */
export function workItemObjectiveHash(
  item: Pick<WorkItem, 'repo' | 'id' | 'source' | 'title' | 'detail'>,
): string | null {
  try {
    loadOrCreateKey();
    const key = loadExistingProvenanceKey();
    if (!key) return null;
    return createHmac('sha256', key).update(JSON.stringify([
      'ashlr:work-item-objective:v2',
      resolve(item.repo),
      item.id,
      item.source,
      normalized(item.title),
      normalized(item.detail),
    ]), 'utf8').digest('hex');
  } catch {
    return null;
  }
}

/** Read-only objective identity for advisory observations; never creates key material. */
export function existingWorkItemObjectiveHash(
  item: Pick<WorkItem, 'repo' | 'id' | 'source' | 'title' | 'detail'>,
): string | null {
  try {
    const key = loadExistingProvenanceKey();
    if (!key) return null;
    return createHmac('sha256', key).update(JSON.stringify([
      'ashlr:work-item-objective:v2',
      resolve(item.repo),
      item.id,
      item.source,
      normalized(item.title),
      normalized(item.detail),
    ]), 'utf8').digest('hex');
  } catch {
    return null;
  }
}
