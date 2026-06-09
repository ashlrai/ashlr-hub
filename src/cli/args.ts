/**
 * Shared CLI argument-parsing helpers.
 *
 * Extracted from the per-command parsers where the same validated-flag idioms
 * were repeated. These are pure validators — callers keep their own loop and
 * index handling, so control flow is unchanged.
 */

/**
 * Validate a flag value as a positive integer.
 *
 * Returns `{ n }` on success or `{ error }` with the canonical message
 * (`--<name> requires a positive integer, got: <raw|(missing)>`) on failure.
 * Mirrors the inline `parseInt(...,10)` + `isNaN || <= 0` checks the command
 * parsers used, including the `(missing)` placeholder for an absent value.
 */
export function parsePositiveInt(
  name: string,
  raw: string | undefined,
): { n: number } | { error: string } {
  const n = raw !== undefined ? parseInt(raw, 10) : NaN;
  if (isNaN(n) || n <= 0) {
    return { error: `--${name} requires a positive integer, got: ${raw ?? '(missing)'}` };
  }
  return { n };
}
