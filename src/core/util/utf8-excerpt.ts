/** Decode only a bounded UTF-8 prefix, preserving a leading BOM as source text.
 * An unfinished code point is permitted only at a real byte-limit cutoff, never at EOF.
 * Bytes beyond the prefix are not validated; callers retain their own binary policy. */
export function decodeUtf8Excerpt(bytes: Uint8Array, maxBytes: number): { text: string; truncated: boolean } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('Invalid UTF-8 excerpt limit');
  const truncated = bytes.byteLength > maxBytes;
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    .decode(bytes.subarray(0, maxBytes), { stream: truncated });
  return { text, truncated };
}
