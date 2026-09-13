/** Append-only authenticated B+tree. A root commits to data; it grants no authority. */
import { createHash } from 'node:crypto';
import { types } from 'node:util';

export const ORDERED_IMMUTABLE_INDEX_NODE_BYTES = 32 * 1024;
const WIDTH = 32;
const MIN_WIDTH = WIDTH / 2;
// A non-leaf root at height h contains at least 2 * 16**h entries.
const MAX_HEIGHT = Math.floor(Math.log(Number.MAX_SAFE_INTEGER / 2) / Math.log(MIN_WIDTH));
export interface OrderedImmutableIndexRoot { schemaVersion: 1; nodeDigest: string | null; count: number; height: number }
export interface OrderedImmutableIndexEntry { key: string; valueDigest: string }
export interface OrderedImmutableIndexRange { gt?: string; lt?: string }
export interface OrderedImmutableIndexPageOptions extends OrderedImmutableIndexRange { limit?: number }
export interface OrderedImmutableIndexNode { nodeDigest: string; bytes: string }
export type OrderedImmutableIndexNodeReader = (nodeDigest: string) => string;
interface Reference { nodeDigest: string; minKey: string; maxKey: string; count: number; height: number }
interface Leaf { schemaVersion: 1; height: 0; entries: OrderedImmutableIndexEntry[] }
interface Branch { schemaVersion: 1; height: number; children: Reference[] }
type Node = Leaf | Branch;
export class OrderedImmutableIndexError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'CONFLICT' | 'UNAVAILABLE') {
    super(code === 'INVALID_INPUT' ? 'Invalid ordered index input' : code === 'CONFLICT' ? 'Ordered index identity conflict' : 'Ordered index evidence unavailable');
    this.name = 'OrderedImmutableIndexError';
  }
}
function fail(code: OrderedImmutableIndexError['code'] = 'INVALID_INPUT'): never { throw new OrderedImmutableIndexError(code); }
function record(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) return fail();
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const captured: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || ![...keys, ...optional].includes(key)) return fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) return fail();
    captured[key] = descriptor.value;
  }
  if (keys.some(key => !Object.hasOwn(captured, key))) return fail();
  return captured;
}
function array(value: unknown): unknown[] {
  if (!value || typeof value !== 'object' || types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return fail();
  const length = Object.getOwnPropertyDescriptor(value, 'length')!.value as number;
  if (length < 1 || length > WIDTH || Reflect.ownKeys(value).length !== length + 1) return fail();
  return Array.from({ length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return fail();
    return descriptor.value;
  });
}
function key(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || /[^\x20-\x7e]/.test(value)) return fail();
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 64 || /[^a-f0-9]/.test(value)) return fail();
  return value;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return fail();
  return value;
}
function height(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_HEIGHT) return fail();
  return value;
}
function entry(value: unknown): OrderedImmutableIndexEntry {
  const fields = record(value, ['key', 'valueDigest']);
  return { key: key(fields.key), valueDigest: hash(fields.valueDigest) };
}
function reference(value: unknown): Reference {
  const fields = record(value, ['nodeDigest', 'minKey', 'maxKey', 'count', 'height']);
  const result = { nodeDigest: hash(fields.nodeDigest), minKey: key(fields.minKey), maxKey: key(fields.maxKey), count: count(fields.count), height: height(fields.height) };
  if (result.minKey > result.maxKey || result.count < MIN_WIDTH ** (result.height + 1) || result.count > WIDTH ** (result.height + 1)) return fail();
  return result;
}
export function captureOrderedImmutableIndexRoot(value: unknown): OrderedImmutableIndexRoot {
  const fields = record(value, ['schemaVersion', 'nodeDigest', 'count', 'height']);
  if (fields.schemaVersion !== 1) return fail();
  if (fields.nodeDigest === null) {
    if (fields.count !== 0 || fields.height !== 0) return fail();
    return emptyOrderedImmutableIndexRoot();
  }
  const result: OrderedImmutableIndexRoot = { schemaVersion: 1, nodeDigest: hash(fields.nodeDigest), count: count(fields.count), height: height(fields.height) };
  if (result.count < (result.height ? 2 * MIN_WIDTH ** result.height : 1) || result.count > WIDTH ** (result.height + 1)) return fail();
  return result;
}
export function emptyOrderedImmutableIndexRoot(): OrderedImmutableIndexRoot { return { schemaVersion: 1, nodeDigest: null, count: 0, height: 0 }; }
function range(value: unknown, page = false): OrderedImmutableIndexPageOptions {
  const fields = record(value === undefined ? {} : value, [], page ? ['gt', 'lt', 'limit'] : ['gt', 'lt']);
  const result: OrderedImmutableIndexPageOptions = {};
  if (Object.hasOwn(fields, 'gt')) result.gt = key(fields.gt);
  if (Object.hasOwn(fields, 'lt')) result.lt = key(fields.lt);
  if (result.gt !== undefined && result.lt !== undefined && result.gt >= result.lt) return fail();
  if (Object.hasOwn(fields, 'limit')) {
    if (typeof fields.limit !== 'number' || !Number.isInteger(fields.limit) || fields.limit < 1 || fields.limit > 256) return fail();
    result.limit = fields.limit;
  }
  return result;
}
function canonicalNode(node: Node): string { return JSON.stringify(node) + '\n'; }
function nodeDigest(bytes: string): string { return createHash('sha256').update('ashlr.ordered-immutable-index-node.v1\n').update(bytes).digest('hex'); }
function summarize(node: Node, digest: string): Reference {
  const rows = 'entries' in node ? node.entries : node.children;
  const total = 'entries' in node ? rows.length : node.children.reduce((sum, row) => sum + row.count, 0);
  return { nodeDigest: digest, minKey: 'entries' in node ? node.entries[0].key : node.children[0].minKey,
    maxKey: 'entries' in node ? node.entries.at(-1)!.key : node.children.at(-1)!.maxKey, count: count(total), height: node.height };
}
function parseNode(bytes: unknown, expected: Pick<Reference, 'nodeDigest' | 'count' | 'height'> & Partial<Reference>, isRoot: boolean): Node {
  if (typeof bytes !== 'string' || Buffer.byteLength(bytes) > ORDERED_IMMUTABLE_INDEX_NODE_BYTES || nodeDigest(bytes) !== expected.nodeDigest) return fail('UNAVAILABLE');
  try {
    const value: unknown = JSON.parse(bytes);
    const base = record(value, ['schemaVersion', 'height'], ['entries', 'children']);
    if (base.schemaVersion !== 1 || height(base.height) !== expected.height) return fail();
    let node: Node;
    if (base.height === 0) {
      if (Object.hasOwn(base, 'children')) return fail();
      const entries = array(base.entries).map(entry);
      if ((!isRoot && entries.length < MIN_WIDTH) || entries.some((row, index) => index > 0 && row.key <= entries[index - 1].key)) return fail();
      node = { schemaVersion: 1, height: 0, entries };
    } else {
      if (Object.hasOwn(base, 'entries')) return fail();
      const children = array(base.children).map(reference);
      if (children.length < (isRoot ? 2 : MIN_WIDTH) || children.some((row, index) => row.height !== Number(base.height) - 1 || index > 0 && row.minKey <= children[index - 1].maxKey)) return fail();
      node = { schemaVersion: 1, height: Number(base.height), children };
    }
    const actual = summarize(node, expected.nodeDigest);
    if (canonicalNode(node) !== bytes || actual.count !== expected.count || expected.minKey !== undefined && actual.minKey !== expected.minKey || expected.maxKey !== undefined && actual.maxKey !== expected.maxKey) return fail();
    return node;
  } catch { return fail('UNAVAILABLE'); }
}
function reader(readNode: OrderedImmutableIndexNodeReader) {
  if (typeof readNode !== 'function') return fail();
  const cache = new Map<string, string>();
  return (expected: Pick<Reference, 'nodeDigest' | 'count' | 'height'> & Partial<Reference>, isRoot = false): Node => {
    let bytes = cache.get(expected.nodeDigest);
    if (bytes === undefined) {
      try { bytes = readNode(expected.nodeDigest); } catch { return fail('UNAVAILABLE'); }
      if (typeof bytes !== 'string') {
        if (types.isPromise(bytes)) void Promise.prototype.then.call(bytes, undefined, () => {});
        return fail('UNAVAILABLE');
      }
      cache.set(expected.nodeDigest, bytes);
    }
    return parseNode(bytes, expected, isRoot);
  };
}
export function lookupOrderedImmutableIndex(rootValue: OrderedImmutableIndexRoot, keyValue: string, readNode: OrderedImmutableIndexNodeReader):
  { found: true; valueDigest: string } | { found: false } {
  const root = captureOrderedImmutableIndexRoot(rootValue); const wanted = key(keyValue); const load = reader(readNode);
  if (root.nodeDigest === null) return { found: false };
  let node = load({ ...root, nodeDigest: root.nodeDigest }, true);
  while ('children' in node) {
    const child = node.children.find(row => row.minKey <= wanted && row.maxKey >= wanted);
    if (!child) return { found: false };
    node = load(child);
  }
  const found = node.entries.find(row => row.key === wanted);
  return found ? { found: true, valueDigest: found.valueDigest } : { found: false };
}
function outside(ref: Reference, selected: OrderedImmutableIndexRange): boolean { return selected.gt !== undefined && ref.maxKey <= selected.gt || selected.lt !== undefined && ref.minKey >= selected.lt; }
function inside(ref: Reference, selected: OrderedImmutableIndexRange): boolean { return (selected.gt === undefined || ref.minKey > selected.gt) && (selected.lt === undefined || ref.maxKey < selected.lt); }
function matches(value: string, selected: OrderedImmutableIndexRange): boolean { return (selected.gt === undefined || value > selected.gt) && (selected.lt === undefined || value < selected.lt); }
function query(root: OrderedImmutableIndexRoot, selected: OrderedImmutableIndexRange, readNode: OrderedImmutableIndexNodeReader) {
  const load = reader(readNode);
  const node = root.nodeDigest === null ? null : load({ ...root, nodeDigest: root.nodeDigest }, true);
  const total = (current: Node): number => 'entries' in current ? current.entries.filter(row => matches(row.key, selected)).length :
    current.children.reduce((sum, child) => sum + (outside(child, selected) ? 0 : inside(child, selected) ? child.count : total(load(child))), 0);
  return { load, node, total: node ? total(node) : 0 };
}
/** Counts authenticate the committed range, not availability of every unread subtree file. */
export function countOrderedImmutableIndex(rootValue: OrderedImmutableIndexRoot, options: OrderedImmutableIndexRange, readNode: OrderedImmutableIndexNodeReader): number {
  return query(captureOrderedImmutableIndexRoot(rootValue), range(options), readNode).total;
}
/** Ascending exclusive bounds; nextAfter navigates the same caller-pinned root. */
export function pageOrderedImmutableIndex(rootValue: OrderedImmutableIndexRoot, options: OrderedImmutableIndexPageOptions, readNode: OrderedImmutableIndexNodeReader):
  { items: OrderedImmutableIndexEntry[]; totalMatches: number; nextAfter: string | null } {
  const root = captureOrderedImmutableIndexRoot(rootValue); const selected = range(options, true); const limit = selected.limit ?? 64;
  const state = query(root, selected, readNode); const items: OrderedImmutableIndexEntry[] = [];
  function visit(node: Node): void {
    if ('entries' in node) { for (const row of node.entries) if (items.length < limit && matches(row.key, selected)) items.push({ ...row }); }
    else for (const child of node.children) { if (items.length >= limit) break; if (!outside(child, selected)) visit(state.load(child)); }
  }
  if (state.node) visit(state.node);
  return { items, totalMatches: state.total, nextAfter: state.total > items.length ? items.at(-1)!.key : null };
}
/** Plans new nodes only. The host must separately publish the returned root with CAS. */
export function planOrderedImmutableIndexInsert(rootValue: OrderedImmutableIndexRoot, entryValue: OrderedImmutableIndexEntry, readNode: OrderedImmutableIndexNodeReader):
  { root: OrderedImmutableIndexRoot; nodes: OrderedImmutableIndexNode[]; replayed: boolean } {
  const root = captureOrderedImmutableIndexRoot(rootValue); const added = entry(entryValue); const load = reader(readNode);
  const nodes: OrderedImmutableIndexNode[] = []; let replayed = false;
  function stage(node: Node): Reference {
    const bytes = canonicalNode(node);
    if (Buffer.byteLength(bytes) > ORDERED_IMMUTABLE_INDEX_NODE_BYTES) return fail();
    const digest = nodeDigest(bytes); const ref = summarize(node, digest);
    nodes.push({ nodeDigest: digest, bytes }); return ref;
  }
  function leaves(entries: OrderedImmutableIndexEntry[]): Reference[] {
    return entries.length <= WIDTH ? [stage({ schemaVersion: 1, height: 0, entries })] :
      [stage({ schemaVersion: 1, height: 0, entries: entries.slice(0, MIN_WIDTH) }), stage({ schemaVersion: 1, height: 0, entries: entries.slice(MIN_WIDTH) })];
  }
  function insert(node: Node): Reference[] {
    if ('entries' in node) {
      const existing = node.entries.find(row => row.key === added.key);
      if (existing) { if (existing.valueDigest !== added.valueDigest) return fail('CONFLICT'); replayed = true; return []; }
      return leaves([...node.entries, added].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    }
    let index = node.children.findIndex(child => child.maxKey >= added.key);
    if (index < 0) index = node.children.length - 1;
    const replacement = insert(load(node.children[index]));
    if (replayed) return [];
    const children = [...node.children.slice(0, index), ...replacement, ...node.children.slice(index + 1)];
    return children.length <= WIDTH ? [stage({ schemaVersion: 1, height: node.height, children })] :
      [stage({ schemaVersion: 1, height: node.height, children: children.slice(0, MIN_WIDTH) }), stage({ schemaVersion: 1, height: node.height, children: children.slice(MIN_WIDTH) })];
  }
  const replacements = root.nodeDigest === null ? leaves([added]) : insert(load({ ...root, nodeDigest: root.nodeDigest }, true));
  if (replayed) return { root, nodes: [], replayed: true };
  const top = replacements.length === 1 ? replacements[0] : stage({ schemaVersion: 1, height: replacements[0].height + 1, children: replacements });
  const next = captureOrderedImmutableIndexRoot({ schemaVersion: 1, nodeDigest: top.nodeDigest, count: top.count, height: top.height });
  return { root: next, nodes, replayed: false };
}
