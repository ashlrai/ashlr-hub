/** Exact source lineage for the adopted batching regression; no historical Git objects required. */
import { createHash } from 'node:crypto';

export const PREPARATION_BATCH_TARGET = 'src/core/resources/engineering-preparation.ts';
export const PREPARATION_BATCH_CURRENT_BLOB = 'fff44339010fb6fb665bbdbfc6d7005ef2caafa4';
export const PREPARATION_BATCH_BASELINE_BLOB = '3580166ed585378c051328edf62f403c62acee4b';
export const PREPARATION_BATCH_PATCH_SHA256 = 'ab53b036e471081ea638a200b7b336724fc116b09135fe634e6b53f7e83ed615';

export function preparationSourceBlob(source: string): string {
  return createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
}

/** The caller applies the actual patch only in its owned private scratch tree.
 * Both arms retain the transport/project-overlap fix preceding batch adoption. */
export function reconstructPreparationBatchBaseline(
  current: string,
  patch: Buffer,
  applyPatch: (source: string, reverse: boolean) => string,
): string {
  if (preparationSourceBlob(current) !== PREPARATION_BATCH_CURRENT_BLOB) throw new Error('BATCH_CURRENT_SOURCE_MISMATCH');
  const headers = patch.toString('utf8').match(/^diff --git .+$/gm);
  if (headers?.length !== 1 || headers[0] !== `diff --git a/${PREPARATION_BATCH_TARGET} b/${PREPARATION_BATCH_TARGET}`) {
    throw new Error('BATCH_PATCH_TARGET_MISMATCH');
  }
  if (createHash('sha256').update(patch).digest('hex') !== PREPARATION_BATCH_PATCH_SHA256) throw new Error('BATCH_PATCH_DIGEST_MISMATCH');
  const baseline = applyPatch(current, true);
  if (preparationSourceBlob(baseline) !== PREPARATION_BATCH_BASELINE_BLOB) throw new Error('BATCH_BASELINE_SOURCE_MISMATCH');
  if (applyPatch(baseline, false) !== current) throw new Error('BATCH_SOURCE_ROUNDTRIP_MISMATCH');
  return baseline;
}
