/**
 * Leaf module for the post-merge-credit-release structural label.
 *
 * Extracted out of post-merge-credit.ts so it can be imported by
 * decisions-ledger.ts and judge-trace.ts WITHOUT recreating the
 * decisions-ledger.ts <-> post-merge-credit.ts import cycle:
 *
 *   decisions-ledger.ts  -> post-merge-credit.ts (for POST_MERGE_CREDIT_RELEASE_LABEL)
 *   post-merge-credit.ts -> decisions-ledger.ts  (for readDecisions/recordDecision)
 *
 * Cold-importing either side of that cycle first (or judge-trace.ts, which
 * also read the constant off post-merge-credit.ts) was load-order-dependent:
 * whichever module happened to be reached first could observe the other
 * side's `const POST_MERGE_CREDIT_RELEASE_LABEL` binding before it was
 * initialized, throwing `ReferenceError: Cannot access
 * 'POST_MERGE_CREDIT_RELEASE_LABEL' before initialization`.
 *
 * This module has NO imports from anywhere in that cycle (only the bare
 * literal + a structural-recognition-only helper), so it always finishes
 * evaluating before any importer can observe a TDZ hole. post-merge-credit.ts
 * re-exports both symbols so its existing public API (isPostMergeCreditReleaseLabel,
 * consumed by inbox/store.ts, skill-records.ts, skill-retrieval.ts, etc.) is
 * unchanged.
 *
 * NOTE: the bare literal is structural recognition only — NOT release
 * authority. Authority is minted exclusively by post-merge-credit.ts's
 * hasReleasedPostMergeCredit (HMAC-verified), not by string equality here.
 */

export const POST_MERGE_CREDIT_RELEASE_LABEL = 'post-merge-credit-release-v1' as const;

/** Structural recognition only; this string is not release authority. */
export function isPostMergeCreditReleaseLabel(labelBasis: unknown): boolean {
  return labelBasis === POST_MERGE_CREDIT_RELEASE_LABEL;
}
