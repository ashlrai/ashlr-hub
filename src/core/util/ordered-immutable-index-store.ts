/** Private content-addressed node staging. Never publishes or selects a ledger root. */
import { randomUUID } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, realpathSync, unlinkSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { types } from 'node:util';
import { acquireLocalStoreLock, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { fsyncDirectory } from './durability.js';
import { writePrivateFileAtomically } from './private-file-write.js';
import { readStableRegularFile } from './stable-file-read.js';
import { assurePrivateStoragePath } from './private-storage.js';
import { captureOrderedImmutableIndexRoot, captureOrderedImmutableIndexLookupKeys, countOrderedImmutableIndex, lookupOrderedImmutableIndex, lookupManyOrderedImmutableIndex, pageOrderedImmutableIndex, selectOrderedImmutableIndex,
  planOrderedImmutableIndexInsert, ORDERED_IMMUTABLE_INDEX_NODE_BYTES, OrderedImmutableIndexError,
  type OrderedImmutableIndexEntry, type OrderedImmutableIndexRoot, type OrderedImmutableIndexRange,
  type OrderedImmutableIndexPageOptions } from './ordered-immutable-index.js';

function unavailable(): never { throw new OrderedImmutableIndexError('UNAVAILABLE'); }
function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new OrderedImmutableIndexError('INVALID_INPUT');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || keys.some(key => typeof key !== 'string' || !names.includes(key))) throw new OrderedImmutableIndexError('INVALID_INPUT');
  const result: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)!;
    if (!descriptor.enumerable || !('value' in descriptor)) throw new OrderedImmutableIndexError('INVALID_INPUT');
    result[name] = descriptor.value;
  }
  return result;
}
function path(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || !isAbsolute(value) || resolve(value) !== value ||
    [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159)) throw new OrderedImmutableIndexError('INVALID_INPUT');
  return value;
}
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function directory(value: string): BigIntStats {
  const stat = lstatSync(value, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(value) !== value ||
    typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid()) ||
    process.platform !== 'win32' && (stat.mode & 0o777n) !== 0o700n) return unavailable();
  if (!assurePrivateStoragePath(value, 'directory', 'inspect-existing', { anchorPath: dirname(value) }).ok) return unavailable();
  return stat;
}
function present(value: string): boolean {
  try { lstatSync(value); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; return unavailable(); }
}

export interface OrderedImmutableIndexStore {
  lookup(root: OrderedImmutableIndexRoot, key: string): ReturnType<typeof lookupOrderedImmutableIndex>;
  lookupMany(root: OrderedImmutableIndexRoot, keys: readonly string[]): ReturnType<typeof lookupManyOrderedImmutableIndex>;
  count(root: OrderedImmutableIndexRoot, range: OrderedImmutableIndexRange): number;
  select(root: OrderedImmutableIndexRoot, rank: number, range?: OrderedImmutableIndexRange): OrderedImmutableIndexEntry | null;
  page(root: OrderedImmutableIndexRoot, options: OrderedImmutableIndexPageOptions): ReturnType<typeof pageOrderedImmutableIndex>;
  /** Return only after NEW reachable nodes are durable; caller still owns root CAS. */
  stage(root: OrderedImmutableIndexRoot, entry: OrderedImmutableIndexEntry, options: { guard(): void }):
    { root: OrderedImmutableIndexRoot; replayed: boolean; nodesStaged: number };
}

/** Both root and its direct parent must already be explicitly created private directories. */
export function createOrderedImmutableIndexStore(value: { root: string; anchorPath: string }): OrderedImmutableIndexStore {
  const config = fields(value, ['root', 'anchorPath']); const root = path(config.root); const anchor = path(config.anchorPath);
  if (dirname(root) !== anchor || root === anchor) throw new OrderedImmutableIndexError('INVALID_INPUT');
  let rootIdentity: BigIntStats; let anchorIdentity: BigIntStats;
  try { anchorIdentity = directory(anchor); rootIdentity = directory(root); } catch { return unavailable(); }
  function bound(): void {
    try { if (!sameIdentity(directory(anchor), anchorIdentity) || !sameIdentity(directory(root), rootIdentity)) unavailable(); }
    catch { unavailable(); }
  }
  function locations(nodeDigest: string) {
    if (typeof nodeDigest !== 'string' || nodeDigest.length !== 64 || /[^a-f0-9]/.test(nodeDigest)) throw new OrderedImmutableIndexError('INVALID_INPUT');
    const paths = [join(root, 'nodes'), join(root, 'nodes', nodeDigest.slice(0, 2)), join(root, 'nodes', nodeDigest.slice(0, 2), nodeDigest.slice(2, 4))];
    return { paths, file: join(paths[2], `${nodeDigest}.json`) };
  }
  function read(nodeDigest: string, staged = false): string {
    const target = locations(nodeDigest);
    const file = staged ? join(dirname(target.file), `.stage-${nodeDigest}.json`) : target.file;
    try {
      bound(); const before = target.paths.map(directory);
      const stat = lstatSync(file, { bigint: true });
      if (process.platform !== 'win32' && (stat.mode & 0o777n) !== 0o600n) return unavailable();
      if (!assurePrivateStoragePath(file, 'file', 'inspect-existing', { anchorPath: root }).ok) return unavailable();
      const result = readStableRegularFile(file, { anchorPath: root, maxFileBytes: ORDERED_IMMUTABLE_INDEX_NODE_BYTES, remainingBytes: ORDERED_IMMUTABLE_INDEX_NODE_BYTES });
      if (!result.ok) return unavailable();
      bound();
      if (target.paths.some((path, index) => !sameIdentity(directory(path), before[index]))) return unavailable();
      return result.text;
    } catch { return unavailable(); }
  }
  function inspect<T>(action: () => T): T { bound(); const result = action(); bound(); return result; }
  return {
    lookup: (commitment, key) => inspect(() => lookupOrderedImmutableIndex(commitment, key, read)),
    lookupMany(commitment, keys) {
      const captured = captureOrderedImmutableIndexRoot(commitment); const requested = captureOrderedImmutableIndexLookupKeys(keys);
      return inspect(() => lookupManyOrderedImmutableIndex(captured, requested, read));
    },
    count: (commitment, range) => inspect(() => countOrderedImmutableIndex(commitment, range, read)),
    select: (commitment, rank, range) => inspect(() => selectOrderedImmutableIndex(commitment, rank, read, range)),
    page: (commitment, options) => inspect(() => pageOrderedImmutableIndex(commitment, options, read)),
    stage(commitment, added, value) {
      const options = fields(value, ['guard']);
      if (typeof options.guard !== 'function') throw new OrderedImmutableIndexError('INVALID_INPUT');
      const hostGuard = options.guard as () => unknown;
      // Pure capture rejects hostile caller data before acquiring a writer lock.
      const captured = captureOrderedImmutableIndexRoot(commitment);
      const capturedEntry = fields(added, ['key', 'valueDigest']) as unknown as OrderedImmutableIndexEntry;
      const initial = planOrderedImmutableIndexInsert(captured, capturedEntry, read);
      function guarded(): void {
        bound();
        let result: unknown;
        try { result = hostGuard(); } catch { return unavailable(); }
        if (result instanceof Promise) void result.catch(() => {});
        if (result !== undefined) return unavailable();
        bound();
      }
      guarded();
      const lock = acquireLocalStoreLock(join(root, '.index-writer.lock'), 500, { anchorPath: anchor, exactPrivateStorage: true });
      if (!lock) return unavailable();
      let answer: { root: OrderedImmutableIndexRoot; replayed: boolean; nodesStaged: number } | undefined;
      let failed: unknown;
      try {
        const guard = () => { guarded(); if (!ownsLocalStoreLock(lock)) unavailable(); };
        guard();
        // Revalidate all visited original nodes under the actual staging lease.
        const plan = planOrderedImmutableIndexInsert(captured, capturedEntry, read);
        if (JSON.stringify(plan) !== JSON.stringify(initial)) return unavailable();
        for (const node of plan.nodes) {
          const target = locations(node.nodeDigest);
          const staged = join(dirname(target.file), `.stage-${node.nodeDigest}.json`);
          for (const path of target.paths) {
            guard();
            if (!present(path)) { directory(dirname(path)); mkdirSync(path, { mode: 0o700 }); }
            directory(path); fsyncDirectory(dirname(path)); guard();
          }
          if (present(staged) && present(target.file)) {
            // Recover only our exact two-name publication. The retained target
            // is then independently read/hash-compared before returning a root.
            const left = lstatSync(staged, { bigint: true }); const right = lstatSync(target.file, { bigint: true });
            if (!sameIdentity(left, right) || !left.isFile() || left.isSymbolicLink() || left.nlink !== 2n || right.nlink !== 2n ||
              typeof process.getuid === 'function' && left.uid !== BigInt(process.getuid()) ||
              process.platform !== 'win32' && (left.mode & 0o777n) !== 0o600n) return unavailable();
            guard();
            if (!sameIdentity(lstatSync(staged, { bigint: true }), left) || !sameIdentity(lstatSync(target.file, { bigint: true }), right)) return unavailable();
            unlinkSync(staged); fsyncDirectory(dirname(target.file));
          }
          if (present(target.file)) {
            if (read(node.nodeDigest) !== node.bytes) return unavailable();
            // A prior publication can survive a failed directory barrier.
            fsyncDirectory(dirname(target.file));
          } else {
            if (present(staged)) { if (read(node.nodeDigest, true) !== node.bytes) return unavailable(); }
            else writePrivateFileAtomically(join(dirname(target.file), `.index-${randomUUID()}.tmp`), staged, node.bytes, {
                anchorPath: root, label: 'Ordered index node', prepublish: () => {
                  guard(); for (const path of target.paths) directory(path);
                  if (present(staged)) unavailable();
                },
              });
            if (read(node.nodeDigest, true) !== node.bytes) return unavailable();
            const stageIdentity = lstatSync(staged, { bigint: true });
            const publicationDirectories = target.paths.map(directory);
            guard();
            // Recheck bytes, exact-private file custody and every shard after
            // the callback; inode equality alone does not preserve permissions.
            if (read(node.nodeDigest, true) !== node.bytes ||
              !sameIdentity(lstatSync(staged, { bigint: true }), stageIdentity) ||
              target.paths.some((path, index) => !sameIdentity(directory(path), publicationDirectories[index]))) return unavailable();
            linkSync(staged, target.file); // Atomic no-clobber, including a racing target.
            const installed = lstatSync(target.file, { bigint: true }); const source = lstatSync(staged, { bigint: true });
            if (!sameIdentity(installed, stageIdentity) || !sameIdentity(source, stageIdentity) || installed.nlink !== 2n || source.nlink !== 2n) return unavailable();
            unlinkSync(staged); fsyncDirectory(dirname(target.file));
          }
          guard(); if (read(node.nodeDigest) !== node.bytes) return unavailable();
        }
        // No host callback follows the final dependency readback. A callback
        // can invalidate an off-path split sibling while root custody survives.
        guard();
        // Read back every NEW reachable node, not just the inserted-key path.
        for (const node of plan.nodes) { if (read(node.nodeDigest) !== node.bytes) return unavailable(); }
        lookupOrderedImmutableIndex(plan.root, capturedEntry.key, read);
        answer = { root: plan.root, replayed: plan.replayed, nodesStaged: plan.nodes.length };
      } catch (error) { failed = error; }
      finally { if (!releaseLocalStoreLock(lock)) failed = new OrderedImmutableIndexError('UNAVAILABLE'); }
      if (failed !== undefined || answer === undefined) return unavailable();
      return answer;
    },
  };
}
