import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { captureOrderedImmutableIndexRoot, countOrderedImmutableIndex, emptyOrderedImmutableIndexRoot, lookupOrderedImmutableIndex,
  pageOrderedImmutableIndex, planOrderedImmutableIndexInsert, ORDERED_IMMUTABLE_INDEX_NODE_BYTES } from '../src/core/util/ordered-immutable-index.js';

const key = (index: number) => `id-${String(index).padStart(6, '0')}`;
const valueDigest = (index: number) => createHash('sha256').update(String(index)).digest('hex');
const digestNode = (bytes: string) => createHash('sha256').update('ashlr.ordered-immutable-index-node.v1\n').update(bytes).digest('hex');
function fixture(total: number, reverse = false) {
  const nodes = new Map<string, string>(); let root = emptyOrderedImmutableIndexRoot();
  const read = vi.fn((hash: string) => { const bytes = nodes.get(hash); if (!bytes) throw new Error('missing'); return bytes; });
  for (let position = 0; position < total; position++) {
    const index = reverse ? total - position - 1 : position;
    const plan = planOrderedImmutableIndexInsert(root, { key: key(index), valueDigest: valueDigest(index) }, read);
    for (const node of plan.nodes) { expect(Buffer.byteLength(node.bytes)).toBeLessThanOrEqual(ORDERED_IMMUTABLE_INDEX_NODE_BYTES); nodes.set(node.nodeDigest, node.bytes); }
    root = plan.root;
  }
  read.mockClear(); return { nodes, root, read };
}

describe('immutable ordered commitment index', () => {
  it('proves empty absence without reading files', () => {
    const read = vi.fn(); const root = emptyOrderedImmutableIndexRoot();
    expect(lookupOrderedImmutableIndex(root, 'a', read)).toEqual({ found: false });
    expect(countOrderedImmutableIndex(root, {}, read)).toBe(0);
    expect(pageOrderedImmutableIndex(root, {}, read)).toEqual({ items: [], totalMatches: 0, nextAfter: null });
    expect(read).not.toHaveBeenCalled();
  });
  it('retains more than 4096 synthetic identities, exact absence, strict ranges and bounded navigation', () => {
    const f = fixture(4353); expect(f.root.count).toBe(4353);
    expect(lookupOrderedImmutableIndex(f.root, key(4096), f.read)).toEqual({ found: true, valueDigest: valueDigest(4096) });
    expect(f.read.mock.calls.length).toBeLessThanOrEqual(f.root.height + 1);
    expect(lookupOrderedImmutableIndex(f.root, `${key(4096)}!`, f.read)).toEqual({ found: false });
    f.read.mockClear();
    expect(countOrderedImmutableIndex(f.root, { gt: key(100), lt: key(4200) }, f.read)).toBe(4099);
    expect(f.read.mock.calls.length).toBeLessThan(32); // Boundary paths, not a full history scan.
    let after: string | undefined; const ids: string[] = [];
    do {
      const page = pageOrderedImmutableIndex(f.root, { ...(after ? { gt: after } : {}), limit: 256 }, f.read);
      ids.push(...page.items.map(row => row.key)); after = page.nextAfter ?? undefined;
    } while (after);
    expect(ids).toEqual(Array.from({ length: 4353 }, (_, index) => key(index)));
    expect(new Set(ids).size).toBe(4353);
  });
  it('inserts descending keys across splits without changing old root snapshots', () => {
    const f = fixture(600, true); const before = f.root;
    const plan = planOrderedImmutableIndexInsert(before, { key: 'a', valueDigest: valueDigest(900) }, f.read);
    for (const node of plan.nodes) f.nodes.set(node.nodeDigest, node.bytes);
    expect(lookupOrderedImmutableIndex(before, 'a', f.read)).toEqual({ found: false });
    expect(lookupOrderedImmutableIndex(plan.root, 'a', f.read)).toMatchObject({ found: true });
    expect(pageOrderedImmutableIndex(plan.root, { limit: 1 }, f.read).items[0].key).toBe('a');
    expect(plan.nodes.length).toBeLessThanOrEqual(2 * (before.height + 1) + 1);
  });
  it('replays identical values without new nodes and refuses identity substitution', () => {
    const f = fixture(40);
    expect(planOrderedImmutableIndexInsert(f.root, { key: key(7), valueDigest: valueDigest(7) }, f.read)).toEqual({ root: f.root, nodes: [], replayed: true });
    expect(() => planOrderedImmutableIndexInsert(f.root, { key: key(7), valueDigest: valueDigest(8) }, f.read)).toThrow('identity conflict');
  });
  it('pins exact canonical node bytes and fails closed for missing/corrupt queried nodes', () => {
    const f = fixture(40); const original = f.nodes.get(f.root.nodeDigest!)!;
    f.nodes.set(f.root.nodeDigest!, original + ' ');
    expect(() => lookupOrderedImmutableIndex(f.root, key(1), f.read)).toThrow('evidence unavailable');
    f.nodes.set(f.root.nodeDigest!, original);
    const child = JSON.parse(original).children[0].nodeDigest;
    f.nodes.delete(child);
    expect(() => lookupOrderedImmutableIndex(f.root, key(1), f.read)).toThrow('evidence unavailable');
    // Count proves the committed root summary, not availability of unread files.
    expect(countOrderedImmutableIndex(f.root, {}, f.read)).toBe(40);
  });
  it('refuses an accidentally asynchronous reader without leaking its rejected promise', async () => {
    const f = fixture(1);
    const asynchronous = async () => { throw new Error('private asynchronous failure'); };
    expect(() => lookupOrderedImmutableIndex(f.root, key(0), asynchronous as never)).toThrow('evidence unavailable');
    await Promise.resolve();
  });
  it.each(['order', 'count', 'height', 'bounds', 'duplicate', 'canonical'] as const)('refuses malformed %s even when the caller supplies its hash', kind => {
    const f = fixture(40); const node = JSON.parse(f.nodes.get(f.root.nodeDigest!)!);
    if (kind === 'order') node.children.reverse();
    if (kind === 'count') node.children[0].count++;
    if (kind === 'height') node.children[0].height++;
    if (kind === 'bounds') node.children[0].maxKey = 'zzzz';
    if (kind === 'duplicate') node.children[1] = node.children[0];
    const bytes = kind === 'canonical' ? JSON.stringify(node, null, 2) + '\n' : JSON.stringify(node) + '\n';
    const root = { ...f.root, nodeDigest: digestNode(bytes) };
    expect(() => lookupOrderedImmutableIndex(root, key(1), () => bytes)).toThrow('evidence unavailable');
  });
  it('rejects root/entry/range accessors, proxies and sparse node arrays without invoking them', () => {
    const trap = vi.fn(() => { throw new Error('hostile'); });
    const root = Object.defineProperty(emptyOrderedImmutableIndexRoot(), 'count', { get: trap });
    expect(() => captureOrderedImmutableIndexRoot(root)).toThrow('Invalid ordered index input');
    expect(() => captureOrderedImmutableIndexRoot(new Proxy({}, { getPrototypeOf: trap }))).toThrow('Invalid ordered index input');
    expect(() => planOrderedImmutableIndexInsert(emptyOrderedImmutableIndexRoot(), Object.defineProperty({ key: 'a' }, 'valueDigest', { get: trap, enumerable: true }) as never, trap)).toThrow();
    expect(() => countOrderedImmutableIndex(emptyOrderedImmutableIndexRoot(), Object.create({ gt: 'a' }), trap)).toThrow();
    expect(() => pageOrderedImmutableIndex(emptyOrderedImmutableIndexRoot(), Object.defineProperty({}, 'limit', { get: trap, enumerable: true }), trap)).toThrow();
    expect(trap).not.toHaveBeenCalled();
    const bytes = '{"schemaVersion":1,"height":0,"entries":[null]}\n';
    expect(() => lookupOrderedImmutableIndex({ schemaVersion: 1, nodeDigest: digestNode(bytes), count: 1, height: 0 }, 'a', () => bytes)).toThrow();
  });
  it.each([{ gt: '' }, { lt: 'a\n' }, { gt: 'b', lt: 'a' }, { limit: 0 }, { limit: 257 }, { limit: undefined }, { extra: 1 }, null])('rejects malformed query %#', options => {
    expect(() => pageOrderedImmutableIndex(emptyOrderedImmutableIndexRoot(), options as never, () => '')).toThrow('Invalid ordered index input');
  });
  it('accepts bounded printable keys and rejects oversized nodes/keys or inconsistent roots', () => {
    const plan = planOrderedImmutableIndexInsert(emptyOrderedImmutableIndexRoot(), { key: 'a'.repeat(256), valueDigest: valueDigest(1) }, () => '');
    expect(plan.root.count).toBe(1);
    expect(() => planOrderedImmutableIndexInsert(plan.root, { key: 'a'.repeat(257), valueDigest: valueDigest(2) }, () => '')).toThrow();
    expect(() => captureOrderedImmutableIndexRoot({ ...plan.root, count: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(() => captureOrderedImmutableIndexRoot({ ...emptyOrderedImmutableIndexRoot(), count: 1 })).toThrow();
    expect(() => lookupOrderedImmutableIndex(plan.root, 'a', () => ' '.repeat(ORDERED_IMMUTABLE_INDEX_NODE_BYTES + 1))).toThrow();
  });
});
