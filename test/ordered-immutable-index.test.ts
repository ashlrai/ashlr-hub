import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { captureOrderedImmutableIndexRoot, countOrderedImmutableIndex, emptyOrderedImmutableIndexRoot, lookupOrderedImmutableIndex, lookupManyOrderedImmutableIndex,
  pageOrderedImmutableIndex, selectOrderedImmutableIndex, planOrderedImmutableIndexInsert, ORDERED_IMMUTABLE_INDEX_NODE_BYTES } from '../src/core/util/ordered-immutable-index.js';

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
  it('batch lookups read each unique visited node once while preserving order, repeats and exact absence', () => {
    const f = fixture(1200); const keys = Array.from({ length: 4096 }, (_, index) => index % 4 === 0 ? 'absent' : key(index % 1200));
    const expected = keys.map(wanted => lookupOrderedImmutableIndex(f.root, wanted, f.read));
    const pointReads = f.read.mock.calls.length; f.read.mockClear();
    expect(lookupManyOrderedImmutableIndex(f.root, keys, f.read)).toEqual(expected);
    const visited = f.read.mock.calls.map(([hash]) => hash);
    expect(visited.length).toBe(new Set(visited).size); expect(visited.length).toBeLessThan(pointReads / 10);
    f.read.mockClear();
    expect(lookupManyOrderedImmutableIndex(f.root, Array(4096).fill('absent'), f.read)).toEqual(Array.from({ length: 4096 }, () => ({ found: false })));
    expect(f.read).toHaveBeenCalledTimes(1);
  });
  it('captures the entire key batch and root before reader callbacks, with independent result objects', () => {
    const f = fixture(40); const root = { ...f.root }; const keys = [key(1), key(39), key(1)]; const getter = vi.fn(); let changed = false;
    const read = (hash: string) => {
      if (!changed) { changed = true; root.count = 999; Object.defineProperty(keys, '1', { enumerable: true, get: getter }); }
      return f.read(hash);
    };
    const result = lookupManyOrderedImmutableIndex(root, keys, read);
    expect(result).toEqual([1, 39, 1].map(index => ({ found: true, valueDigest: valueDigest(index) })));
    expect(getter).not.toHaveBeenCalled();
    if (result[0]!.found) result[0]!.valueDigest = valueDigest(99);
    expect(result[2]).toEqual({ found: true, valueDigest: valueDigest(1) });
  });
  it('revalidates each reference even when a forged second range shares cached leaf bytes', () => {
    const f = fixture(16); const leafDigest = f.root.nodeDigest!;
    const bytes = JSON.stringify({ schemaVersion: 1, height: 1, children: [
      { nodeDigest: leafDigest, minKey: key(0), maxKey: key(15), count: 16, height: 0 },
      { nodeDigest: leafDigest, minKey: key(16), maxKey: key(31), count: 16, height: 0 },
    ] }) + '\n';
    const root = { schemaVersion: 1 as const, nodeDigest: digestNode(bytes), count: 32, height: 1 };
    f.nodes.set(root.nodeDigest, bytes);
    expect(lookupManyOrderedImmutableIndex(root, [key(0)], f.read)).toEqual([{ found: true, valueDigest: valueDigest(0) }]);
    f.read.mockClear();
    expect(() => lookupManyOrderedImmutableIndex(root, [key(0), key(16)], f.read)).toThrow('evidence unavailable');
    expect(f.read.mock.calls.map(([hash]) => hash)).toEqual([root.nodeDigest, leafDigest]);
  });
  it('rejects every malformed batch before touching the reader', () => {
    const f = fixture(1); const getter = vi.fn(); const accessor = [key(0)]; Object.defineProperty(accessor, '0', { enumerable: true, get: getter });
    const symbol = [key(0)]; Object.defineProperty(symbol, Symbol('foreign'), { value: true });
    for (const keys of [null, {}, new Array(1), accessor, symbol, Array(4097).fill('a'), ['a', '\n'], new Proxy(['a'], { ownKeys: getter })]) {
      expect(() => lookupManyOrderedImmutableIndex(f.root, keys as never, f.read)).toThrow('Invalid ordered index input');
    }
    expect(f.read).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled();
    expect(lookupManyOrderedImmutableIndex(f.root, [], f.read)).toEqual([]); expect(f.read).not.toHaveBeenCalled();
  });
  it.each(['missing', 'corrupt'] as const)('does not reuse cached node evidence after a %s next-call change', kind => {
    const f = fixture(40); expect(lookupManyOrderedImmutableIndex(f.root, [key(39), key(39)], f.read)).toHaveLength(2);
    const target = f.read.mock.calls.at(-1)![0];
    if (kind === 'missing') f.nodes.delete(target); else f.nodes.set(target, '{}\n');
    expect(() => lookupManyOrderedImmutableIndex(f.root, [key(0), key(39)], f.read)).toThrow('evidence unavailable');
  });
  it('proves empty absence without reading files', () => {
    const read = vi.fn(); const root = emptyOrderedImmutableIndexRoot();
    expect(lookupOrderedImmutableIndex(root, 'a', read)).toEqual({ found: false });
    expect(countOrderedImmutableIndex(root, {}, read)).toBe(0);
    expect(pageOrderedImmutableIndex(root, {}, read)).toEqual({ items: [], totalMatches: 0, nextAfter: null });
    expect(selectOrderedImmutableIndex(root, 0, read)).toBeNull();
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
  it('selects exact ranks beyond4096 with logarithmic touched paths, not preceding pages', () => {
    // Synthetic ordered identities only, not thousands of resource executions.
    const f = fixture(4353);
    for (const rank of [0, 1, 15, 16, 31, 32, 100, 2048, 4096, 4352]) {
      f.read.mockClear();
      expect(selectOrderedImmutableIndex(f.root, rank, f.read)).toEqual({ key: key(rank), valueDigest: valueDigest(rank) });
      expect(f.read.mock.calls.length).toBeLessThanOrEqual(f.root.height + 1);
    }
    const selected = { gt: key(100), lt: key(4200) };
    for (const rank of [0, 15, 2049, 4098]) {
      f.read.mockClear();
      expect(selectOrderedImmutableIndex(f.root, rank, f.read, selected)).toEqual({ key: key(rank + 101), valueDigest: valueDigest(rank + 101) });
      expect(f.read.mock.calls.length).toBeLessThanOrEqual(3 * f.root.height + 1);
    }
    expect(selectOrderedImmutableIndex(f.root, 4099, f.read, selected)).toBeNull();
    expect(selectOrderedImmutableIndex(f.root, Number.MAX_SAFE_INTEGER, f.read)).toBeNull();
    expect(selectOrderedImmutableIndex(f.root, 0, f.read, { gt: 'id-002', lt: 'id-003' })?.key).toBe(key(2000));
    expect(selectOrderedImmutableIndex(f.root, 999, f.read, { gt: 'id-002', lt: 'id-003' })?.key).toBe(key(2999));
    expect(selectOrderedImmutableIndex(f.root, 1000, f.read, { gt: 'id-002', lt: 'id-003' })).toBeNull();
  });
  it.each([false, true])('selects all ranks across ascending/descending split shape=%s', reverse => {
    const f = fixture(65, reverse);
    const selected = { gt: key(15), lt: key(49) };
    for (let rank = 0; rank < 33; rank++) {
      expect(selectOrderedImmutableIndex(f.root, rank, f.read, selected)?.key).toBe(key(rank + 16));
    }
    expect(selectOrderedImmutableIndex(f.root, 33, f.read, selected)).toBeNull();
    expect(selectOrderedImmutableIndex(f.root, 0, f.read, { gt: key(64) })).toBeNull();
    expect(selectOrderedImmutableIndex(f.root, 0, f.read, { lt: key(0) })).toBeNull();
    expect(selectOrderedImmutableIndex(f.root, 0, f.read, { gt: key(1), lt: key(2) })).toBeNull();
  });
  it.each(['missing', 'corrupt'] as const)('refuses a %s selected node without treating it as out of range', kind => {
    const f = fixture(40); const rootBytes = f.nodes.get(f.root.nodeDigest!)!;
    const selectedDigest = (JSON.parse(rootBytes) as { children: Array<{ nodeDigest: string }> }).children[1]!.nodeDigest;
    if (kind === 'missing') f.nodes.delete(selectedDigest); else f.nodes.set(selectedDigest, '{}\n');
    expect(countOrderedImmutableIndex(f.root, {}, f.read)).toBe(40);
    expect(selectOrderedImmutableIndex(f.root, 0, f.read)?.key).toBe(key(0));
    expect(() => selectOrderedImmutableIndex(f.root, 39, f.read)).toThrow('evidence unavailable');
    expect(selectOrderedImmutableIndex(f.root, 40, f.read)).toBeNull();
    f.nodes.set(f.root.nodeDigest!, '{}\n');
    expect(() => selectOrderedImmutableIndex(f.root, 40, f.read)).toThrow('evidence unavailable');
  });
  it('captures selection root/range before reader callbacks and detaches selected entries', () => {
    const f = fixture(65); const root = { ...f.root }; const selected = { gt: key(15), lt: key(49) };
    const getter = vi.fn(() => { throw new Error('must not invoke'); }); let changed = false;
    const read = (hash: string) => {
      if (!changed) {
        changed = true; root.count = 1;
        Object.defineProperty(selected, 'gt', { enumerable: true, get: getter });
        selected.lt = key(17);
      }
      return f.read(hash);
    };
    const row = selectOrderedImmutableIndex(root, 20, read, selected)!;
    expect(row.key).toBe(key(36)); expect(getter).not.toHaveBeenCalled(); row.key = 'changed';
    expect(selectOrderedImmutableIndex(f.root, 36, f.read)?.key).toBe(key(36));
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null])('rejects malformed selection rank %s before reading', rank => {
    const read = vi.fn();
    expect(() => selectOrderedImmutableIndex(emptyOrderedImmutableIndexRoot(), rank as number, read)).toThrow('Invalid ordered index input');
    expect(read).not.toHaveBeenCalled();
  });
  it('rejects hostile selection ranges and malformed roots without evaluating hooks', () => {
    const trap = vi.fn(() => { throw new Error('hostile'); }); const empty = emptyOrderedImmutableIndexRoot();
    for (const selected of [Object.defineProperty({}, 'gt', { enumerable: true, get: trap }),
      new Proxy({}, { getPrototypeOf: trap }), { gt: 'z', lt: 'a' }, { limit: 1 }, { gt: undefined }]) {
      expect(() => selectOrderedImmutableIndex(empty, 0, trap, selected)).toThrow('Invalid ordered index input');
    }
    expect(() => selectOrderedImmutableIndex({ ...empty, count: 1 }, 0, trap)).toThrow();
    expect(trap).not.toHaveBeenCalled();
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
