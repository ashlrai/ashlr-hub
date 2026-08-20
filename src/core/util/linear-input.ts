/**
 * Linear-time transforms for uncontrolled string inputs.
 *
 * These helpers deliberately avoid backtracking regular expressions. Their
 * diagnostic variants expose the number of monotonically visited offsets so
 * adversarial regressions can prove a deterministic linear bound without
 * relying on wall-clock timing.
 */

export interface LinearTransformResult {
  value: string;
  examinedOffsets: number;
}

/** Remove every trailing `/` with at most one backwards pass and one slice. */
export function stripTrailingSlashesWithMetrics(value: string): LinearTransformResult {
  let end = value.length;
  let examinedOffsets = 0;

  while (end > 0) {
    examinedOffsets += 1;
    if (value.charCodeAt(end - 1) !== 47) break;
    end -= 1;
  }

  return {
    value: end === value.length ? value : value.slice(0, end),
    examinedOffsets,
  };
}

export function stripTrailingSlashes(value: string): string {
  return stripTrailingSlashesWithMetrics(value).value;
}

const BEGIN_PREFIX = '-----BEGIN';
const END_PREFIX = '-----END';
const PRIVATE_KEY_SUFFIX = 'PRIVATE KEY-----';
const REDACTED = '[REDACTED]';

interface MutableScanMetrics {
  examinedOffsets: number;
}

interface Marker {
  start: number;
  end: number;
}

function isPemLabelCode(code: number): boolean {
  return code === 32 || (code >= 65 && code <= 90);
}

/**
 * Find the next `PREFIX[ A-Z]*PRIVATE KEY-----` marker.
 *
 * The outer cursor and label cursor only advance. A failed label cannot contain
 * another marker because its accepted alphabet excludes `-`, so advancing past
 * the fixed prefix does not skip a possible match.
 */
function findPrivateKeyMarker(
  text: string,
  from: number,
  prefix: string,
  metrics: MutableScanMetrics,
): Marker | null {
  let cursor = from;
  while (cursor < text.length) {
    metrics.examinedOffsets += 1;
    if (!text.startsWith(prefix, cursor)) {
      cursor += 1;
      continue;
    }

    let labelCursor = cursor + prefix.length;
    while (labelCursor <= text.length) {
      metrics.examinedOffsets += 1;
      if (text.startsWith(PRIVATE_KEY_SUFFIX, labelCursor)) {
        return {
          start: cursor,
          end: labelCursor + PRIVATE_KEY_SUFFIX.length,
        };
      }
      if (labelCursor === text.length || !isPemLabelCode(text.charCodeAt(labelCursor))) {
        break;
      }
      labelCursor += 1;
    }

    cursor += prefix.length;
  }
  return null;
}

function findLineFeed(text: string, from: number, metrics: MutableScanMetrics): number {
  let cursor = from;
  while (cursor < text.length) {
    metrics.examinedOffsets += 1;
    if (text.charCodeAt(cursor) === 10) return cursor;
    cursor += 1;
  }
  return text.length;
}

/**
 * Redact complete PEM private-key blocks and truncated BEGIN marker lines.
 *
 * Compatibility contract:
 * - a valid BEGIN through the nearest valid END becomes one `[REDACTED]`;
 * - when no END exists after a BEGIN, the BEGIN marker and the rest of that
 *   physical line are redacted, preserving the line feed and following text;
 * - non-private-key PEM markers are unchanged.
 *
 * Scans are monotonic within disjoint matched regions. The only rescan is the
 * fallback pass after proving that no END exists, keeping examined offsets
 * bounded by a small constant multiple of the input length.
 */
export function redactPrivateKeyBlocksWithMetrics(text: string): LinearTransformResult {
  const metrics: MutableScanMetrics = { examinedOffsets: 0 };
  const chunks: string[] = [];
  let copyFrom = 0;
  let cursor = 0;

  while (cursor < text.length) {
    const begin = findPrivateKeyMarker(text, cursor, BEGIN_PREFIX, metrics);
    if (begin === null) break;

    const end = findPrivateKeyMarker(text, begin.end, END_PREFIX, metrics);
    chunks.push(text.slice(copyFrom, begin.start), REDACTED);

    if (end !== null) {
      cursor = end.end;
      copyFrom = end.end;
      continue;
    }

    // No END marker remains. Preserve the legacy truncated-block behavior for
    // this and all later BEGIN markers without repeating an END search.
    let truncated = begin;
    while (truncated !== null) {
      const lineFeed = findLineFeed(text, truncated.end, metrics);
      cursor = lineFeed;
      copyFrom = lineFeed;
      if (cursor >= text.length) break;

      const next = findPrivateKeyMarker(text, cursor, BEGIN_PREFIX, metrics);
      if (next === null) break;
      chunks.push(text.slice(copyFrom, next.start), REDACTED);
      truncated = next;
    }
    break;
  }

  if (chunks.length === 0) {
    return { value: text, examinedOffsets: metrics.examinedOffsets };
  }
  chunks.push(text.slice(copyFrom));
  return { value: chunks.join(''), examinedOffsets: metrics.examinedOffsets };
}

export function redactPrivateKeyBlocks(text: string): string {
  return redactPrivateKeyBlocksWithMetrics(text).value;
}
