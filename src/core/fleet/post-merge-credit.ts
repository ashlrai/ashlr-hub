/**
 * Positive post-merge learning authority.
 *
 * A realized merge is an immutable operational fact, not proof that the change
 * remained beneficial. Only the future purpose-built release protocol may mint
 * this label. Existing merge receipts and observation-only stability witnesses
 * deliberately do not satisfy it.
 */
export const POST_MERGE_CREDIT_POLICY_VERSION = 'post-merge-credit-v1' as const;
export const POST_MERGE_CREDIT_RELEASE_LABEL = 'post-merge-credit-release-v1' as const;

/** Structural recognition only; this string is not release authority. */
export function isPostMergeCreditReleaseLabel(labelBasis: unknown): boolean {
  return labelBasis === POST_MERGE_CREDIT_RELEASE_LABEL;
}

/**
 * No authenticated release verifier exists in this protocol version.
 * Deliberately return false even for the reserved label so raw ledgers,
 * injected dependencies, and caller-controlled metadata cannot mint credit.
 */
export function hasReleasedPostMergeCredit(_labelBasis: unknown): boolean {
  return false;
}
