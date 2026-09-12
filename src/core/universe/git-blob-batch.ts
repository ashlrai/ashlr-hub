import { createHash } from 'node:crypto';

/** Decode raw Git batch frames, binding every payload to its requested object. */
export function parseGitBlobBatch(bytes: Buffer, oids: readonly string[], maxBytes: number): Buffer[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Invalid Git object byte envelope');
  let offset = 0;
  let total = 0;
  const results = oids.map((oid) => {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) throw new Error('Invalid Git object identity');
    const end = bytes.indexOf(10, offset);
    if (end < 0) throw new Error('Git object batch is incomplete');
    const header = bytes.subarray(offset, end).toString('utf8');
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) blob (0|[1-9][0-9]*)$/.exec(header);
    if (!match || match[1] !== oid) throw new Error('Git object batch identity changed');
    const size = Number(match[2]);
    // Count each destination, including repeated object IDs, against the cap.
    if (!Number.isSafeInteger(size) || size > maxBytes - total ||
        size > bytes.length - end - 2 || bytes[end + size + 1] !== 10) {
      throw new Error('Git object batch exceeds its byte envelope');
    }
    total += size;
    const data = bytes.subarray(end + 1, end + 1 + size);
    const actualOid = createHash(oid.length === 40 ? 'sha1' : 'sha256')
      .update(`blob ${size}\0`).update(data).digest('hex');
    if (actualOid !== oid) throw new Error('Git object content does not match its identity');
    offset = end + size + 2;
    return data;
  });
  if (offset !== bytes.length) throw new Error('Git object batch contains trailing bytes');
  return results;
}
