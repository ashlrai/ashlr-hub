/**
 * Leaf module for the post-merge-credit structural label.
 *
 * Keeping this import-free breaks the decisions-ledger/post-merge-credit ESM
 * cycle. The literal is structural recognition only; it grants no release or
 * routing authority.
 */

export const POST_MERGE_CREDIT_RELEASE_LABEL = 'post-merge-credit-release-v1' as const;

/** Structural recognition only; this string is not release authority. */
export function isPostMergeCreditReleaseLabel(labelBasis: unknown): boolean {
  return labelBasis === POST_MERGE_CREDIT_RELEASE_LABEL;
}
