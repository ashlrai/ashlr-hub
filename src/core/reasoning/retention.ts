/**
 * Reasoning retention (V3.10, unit A7).
 *
 * The operator's opt-in (2026-09-24) keeps reasoning TEXT for 30 days and
 * derived FEATURES for 180 days. Applied per UTC day file:
 *
 *  - steps/ day files older than the text window are rewritten with every
 *    `text` emptied (''), keeping the step's metadata as a feature;
 *  - steps/ and features/ day files older than the feature window are deleted;
 *  - if the whole store still exceeds MAX_STORE_BYTES, the oldest day files
 *    are evicted (steps first — they are the large, text-bearing half).
 *
 * Rewrites are async and streamed (a 32 MB day file must not block the event
 * loop), atomic (temp file + rename, 0600), and abort if the file changed
 * while it was being rewritten — a concurrent append is retried next run
 * instead of silently lost.
 */

import { constants as fsConstants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import {
  REASONING_FEATURE_RETENTION_DAYS,
  REASONING_TEXT_RETENTION_DAYS,
} from './types.js';
import {
  DAY_MS,
  MAX_STORE_BYTES,
  isStepRow,
  listDayFiles,
  markStoreChanged,
  readJsonl,
  readStoreState,
  reasoningRoot,
  removeDayFile,
  utcDay,
  writeStoreState,
  type DayFile,
} from './store.js';

const STATE_NAME = 'retention';

interface RetentionState {
  v: 1;
  /** Newest steps day already rewritten text-free. */
  textPrunedThrough: string | null;
  lastRunAt: string | null;
}

export interface RetentionResult {
  textPrunedFiles: number;
  textPrunedRows: number;
  removedFiles: number;
  evictedFiles: number;
  skippedChangedFiles: number;
  bytesAfter: number;
}

export interface RetentionOptions {
  root?: string;
  nowMs?: number;
  /** Override the byte ceiling (tests). */
  maxStoreBytes?: number;
}

/**
 * Rewrite one steps day file with all text removed. Returns the number of
 * rows whose text was cleared, or null when the file changed underneath us
 * (or could not be rewritten safely) and must be retried.
 */
async function stripTextFromDayFile(file: DayFile): Promise<number | null> {
  const before = await lstat(file.path).catch(() => null);
  if (!before) return 0;
  let cleared = 0;
  const lines: string[] = [];
  await readJsonl(file.path, (row) => {
    if (!isStepRow(row)) return; // drop malformed rows while we are here
    if (row.text !== '') cleared += 1;
    lines.push(JSON.stringify({ ...row, text: '' }));
  });
  if (cleared === 0) return 0;

  const tmp = `${file.path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const handle = await open(tmp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
  let renamed = false;
  try {
    await handle.chmod(0o600);
    // Write in slices so serialisation of a large day never becomes one long block.
    for (let i = 0; i < lines.length; i += 1_000) {
      await handle.write(lines.slice(i, i + 1_000).join('\n') + '\n');
    }
    await handle.close();
    const after = await lstat(file.path).catch(() => null);
    if (!after || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
      return null;
    }
    await rename(tmp, file.path);
    renamed = true;
    markStoreChanged();
    return cleared;
  } finally {
    await handle.close().catch(() => undefined);
    if (!renamed) await unlink(tmp).catch(() => undefined);
  }
}

/** Apply the retention policy once. Never throws; partial progress is kept. */
export async function applyReasoningRetention(options: RetentionOptions = {}): Promise<RetentionResult> {
  const root = options.root ?? reasoningRoot();
  const nowMs = options.nowMs ?? Date.now();
  const maxBytes = options.maxStoreBytes ?? MAX_STORE_BYTES;
  const result: RetentionResult = {
    textPrunedFiles: 0,
    textPrunedRows: 0,
    removedFiles: 0,
    evictedFiles: 0,
    skippedChangedFiles: 0,
    bytesAfter: 0,
  };
  try {
    const state = readStoreState<RetentionState>(STATE_NAME, root);
    const prunedThrough = state?.v === 1 ? state.textPrunedThrough : null;
    const lastRunMs = state?.v === 1 && state.lastRunAt ? Date.parse(state.lastRunAt) : Number.NaN;

    // A day file is past a window only when its WHOLE day is: day < cutoffDay.
    const textCutoffDay = utcDay(nowMs - REASONING_TEXT_RETENTION_DAYS * DAY_MS);
    const featureCutoffDay = utcDay(nowMs - REASONING_FEATURE_RETENTION_DAYS * DAY_MS);

    // 1. Drop everything past the feature window.
    for (const kind of ['steps', 'features'] as const) {
      for (const file of await listDayFiles(kind, root)) {
        if (file.day < featureCutoffDay && removeDayFile(file.path)) result.removedFiles += 1;
      }
    }

    // 2. Blank text past the text window. Files already pruned are skipped
    // unless they were modified after the last run.
    let newestPruned = prunedThrough;
    for (const file of await listDayFiles('steps', root)) {
      if (file.day >= textCutoffDay) continue;
      const alreadyDone = prunedThrough !== null && file.day <= prunedThrough &&
        Number.isFinite(lastRunMs) && file.mtimeMs <= lastRunMs;
      if (alreadyDone) continue;
      const cleared = await stripTextFromDayFile(file).catch(() => null);
      if (cleared === null) {
        result.skippedChangedFiles += 1;
        continue;
      }
      if (cleared > 0) {
        result.textPrunedFiles += 1;
        result.textPrunedRows += cleared;
      }
      if (newestPruned === null || file.day > newestPruned) newestPruned = file.day;
    }

    // 3. Enforce the whole-store ceiling, oldest first, steps before features.
    const steps = await listDayFiles('steps', root);
    const features = await listDayFiles('features', root);
    let total = [...steps, ...features].reduce((sum, file) => sum + file.size, 0);
    for (const file of [...steps, ...features]) {
      if (total <= maxBytes) break;
      if (removeDayFile(file.path)) {
        total -= file.size;
        result.evictedFiles += 1;
      }
    }
    result.bytesAfter = total;

    writeStoreState(STATE_NAME, {
      v: 1,
      textPrunedThrough: newestPruned,
      // Wall clock at the END of the run, so files this run rewrote are not
      // mistaken for "modified since" on the next one.
      lastRunAt: new Date(Math.max(nowMs, Date.now())).toISOString(),
    } satisfies RetentionState, root);
  } catch {
    /* retention is maintenance: never fail the caller */
  }
  return result;
}
