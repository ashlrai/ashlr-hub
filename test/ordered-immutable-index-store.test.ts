/** Synthetic immutable index records; no resource tasks, accounts, or ledger activation. */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOrderedImmutableIndexStore } from '../src/core/util/ordered-immutable-index-store.js';
import { emptyOrderedImmutableIndexRoot, planOrderedImmutableIndexInsert, type OrderedImmutableIndexRoot } from '../src/core/util/ordered-immutable-index.js';

const hooks = vi.hoisted(() => ({ afterWrite: null as ((target: string) => void) | null, denyAssurance: false,
  denyAssurancePath: null as string | null }));
vi.mock('../src/core/util/private-file-write.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/util/private-file-write.js')>();
  return { ...actual, writePrivateFileAtomically: (...args: Parameters<typeof actual.writePrivateFileAtomically>) => {
    actual.writePrivateFileAtomically(...args); hooks.afterWrite?.(args[1]);
  } };
});
vi.mock('../src/core/util/private-storage.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/util/private-storage.js')>();
  return { ...actual, assurePrivateStoragePath: (...args: Parameters<typeof actual.assurePrivateStoragePath>) =>
    hooks.denyAssurance || args[0] === hooks.denyAssurancePath
      ? { ok: false, reason: 'fixture-acl-denied' } : actual.assurePrivateStoragePath(...args) };
});

const key = (index: number) => `id-${String(index).padStart(6, '0')}`;
const valueDigest = (index: number) => createHash('sha256').update(String(index)).digest('hex');
let base: string | undefined;
afterEach(() => {
  hooks.afterWrite = null; hooks.denyAssurance = false; hooks.denyAssurancePath = null; vi.restoreAllMocks();
  if (base) { rmSync(base, { recursive: true, force: true }); base = undefined; }
});
function fixture() {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ordered-index-')));
  const anchor = join(base, 'private'); mkdirSync(anchor, { mode: 0o700 });
  const root = join(anchor, 'index'); mkdirSync(root, { mode: 0o700 });
  const config = { root, anchorPath: anchor };
  return { root, anchor, config, store: createOrderedImmutableIndexStore(config) };
}
function nodePath(root: string, digest: string): string { return join(root, 'nodes', digest.slice(0, 2), digest.slice(2, 4), `${digest}.json`); }
function seed(rootPath: string, total: number): OrderedImmutableIndexRoot {
  // Populate only nodes reachable from a pure-planner synthetic fixture. This is
  // not thousands of durable admissions or thousands of stage() transactions.
  const nodes = new Map<string, string>(); let root = emptyOrderedImmutableIndexRoot();
  for (let index = 0; index < total; index++) {
    const plan = planOrderedImmutableIndexInsert(root, { key: key(index), valueDigest: valueDigest(index) }, hash => nodes.get(hash)!);
    for (const node of plan.nodes) nodes.set(node.nodeDigest, node.bytes);
    root = plan.root;
  }
  function write(hash: string) {
    const bytes = nodes.get(hash)!; const value = JSON.parse(bytes);
    if (value.children) for (const child of value.children) write(child.nodeDigest);
    const target = nodePath(rootPath, hash); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, { mode: 0o600 });
  }
  if (root.nodeDigest) write(root.nodeDigest);
  return root;
}

describe.skipIf(process.platform === 'win32')('private ordered index staging and cold reads', () => {
  it('cold-reads more than4096 synthetic entries and stages another without selecting a ledger root', () => {
    const f = fixture(); const old = seed(f.root, 4353);
    const staged = f.store.stage(old, { key: key(4353), valueDigest: valueDigest(4353) }, { guard() {} });
    expect(staged.root.count).toBe(4354);
    const cold = createOrderedImmutableIndexStore(f.config);
    expect(cold.lookup(staged.root, key(4353))).toEqual({ found: true, valueDigest: valueDigest(4353) });
    expect(cold.lookup(old, key(4353))).toEqual({ found: false });
    expect(cold.lookup(staged.root, 'missing')).toEqual({ found: false });
    expect(cold.count(staged.root, { gt: key(100), lt: key(4200) })).toBe(4099);
    expect(cold.select(staged.root, 4353)).toEqual({ key: key(4353), valueDigest: valueDigest(4353) });
    expect(cold.select(staged.root, 4098, { gt: key(100), lt: key(4200) })).toEqual({ key: key(4199), valueDigest: valueDigest(4199) });
    expect(cold.select(old, 4353)).toBeNull();
    const pages: string[] = []; let gt: string | undefined;
    do {
      const page = cold.page(staged.root, { ...(gt ? { gt } : {}), limit: 256 });
      pages.push(...page.items.map(row => row.key)); gt = page.nextAfter ?? undefined;
    } while (gt);
    expect(pages).toEqual(Array.from({ length: 4354 }, (_, index) => key(index)));
    expect(readdirSync(f.root)).toEqual(['nodes']);
    expect(existsSync(join(f.anchor, 'pool-state.json'))).toBe(false);
  }, 30_000);
  it('stages a real leaf split, replays exact identity and refuses a conflicting digest', () => {
    const f = fixture(); const old = seed(f.root, 32);
    const entry = { key: key(32), valueDigest: valueDigest(32) };
    const next = f.store.stage(old, entry, { guard() {} });
    expect(next).toMatchObject({ nodesStaged: 3, replayed: false, root: { count: 33, height: 1 } });
    expect(f.store.stage(next.root, entry, { guard() {} })).toEqual({ root: next.root, nodesStaged: 0, replayed: true });
    expect(() => f.store.stage(next.root, { ...entry, valueDigest: valueDigest(99) }, { guard() {} })).toThrow('identity conflict');
    expect(f.store.count(old, {})).toBe(32);
  });
  it('cold-selects exact rows with fresh ACL, selected-node and pinned-root checks', () => {
    const f = fixture(); const root = seed(f.root, 40);
    const cold = createOrderedImmutableIndexStore(f.config);
    expect(cold.select(root, 0, { gt: key(20) })).toEqual({ key: key(21), valueDigest: valueDigest(21) });
    hooks.denyAssurance = true;
    expect(() => cold.select(root, 0)).toThrow('evidence unavailable');
    expect(() => cold.select(emptyOrderedImmutableIndexRoot(), 0)).toThrow('evidence unavailable');
    hooks.denyAssurance = false;
    const branch = JSON.parse(readFileSync(nodePath(f.root, root.nodeDigest!), 'utf8')) as { children: Array<{ nodeDigest: string }> };
    const selectedPath = nodePath(f.root, branch.children[1]!.nodeDigest); const bytes = readFileSync(selectedPath, 'utf8');
    writeFileSync(selectedPath, '{}\n');
    expect(() => cold.select(root, 39)).toThrow('evidence unavailable');
    writeFileSync(selectedPath, bytes);
    expect(cold.select(root, 39)?.key).toBe(key(39));
    renameSync(f.root, f.root + '-old'); mkdirSync(f.root, { mode: 0o700 });
    expect(() => cold.select(emptyOrderedImmutableIndexRoot(), 0)).toThrow('evidence unavailable');
    expect(readdirSync(f.root)).toEqual([]); // Read-only selection creates no storage.
  });
  it.each(['missing', 'corrupt'] as const)('refuses a %s off-path split sibling changed by the final callback', kind => {
    const f = fixture(); const old = seed(f.root, 32);
    const entry = { key: key(32), valueDigest: valueDigest(32) };
    const plan = planOrderedImmutableIndexInsert(old, entry, hash => readFileSync(nodePath(f.root, hash), 'utf8'));
    const sibling = plan.nodes.find(node => {
      const value = JSON.parse(node.bytes) as { entries?: Array<{ key: string }> };
      return value.entries && !value.entries.some(row => row.key === entry.key);
    });
    expect(sibling).toBeDefined(); expect(plan.nodes).toHaveLength(3);
    // Measure this implementation's last callback on the same real split in a
    // separate private store; do not hard-code a guard count or mock the writer.
    const baselineRoot = join(f.anchor, 'baseline'); mkdirSync(baselineRoot, { mode: 0o700 });
    const baseline = createOrderedImmutableIndexStore({ root: baselineRoot, anchorPath: f.anchor });
    let finalGuard = 0;
    baseline.stage(seed(baselineRoot, 32), entry, { guard() { finalGuard++; } });
    let calls = 0;
    expect(() => f.store.stage(old, entry, { guard() {
      if (++calls !== finalGuard) return;
      const target = nodePath(f.root, sibling!.nodeDigest);
      if (kind === 'missing') unlinkSync(target); else writeFileSync(target, '{}\n');
    } })).toThrow('evidence unavailable');
    expect(calls).toBe(finalGuard);
    // The inserted-key path alone still verifies, demonstrating why a complete
    // NEW-node readback is required. The original commitment remains unchanged.
    expect(f.store.lookup(plan.root, entry.key)).toEqual({ found: true, valueDigest: entry.valueDigest });
    expect(f.store.lookup(old, entry.key)).toEqual({ found: false });
    expect(f.store.lookup(old, key(0))).toEqual({ found: true, valueDigest: valueDigest(0) });
    expect(existsSync(join(f.root, '.index-writer.lock'))).toBe(false);
  }, 30_000);
  it('rechecks the replay path after the final callback even when there are no new nodes', () => {
    const f = fixture(); const old = seed(f.root, 1);
    const entry = { key: key(0), valueDigest: valueDigest(0) }; let finalGuard = 0;
    expect(f.store.stage(old, entry, { guard() { finalGuard++; } }).replayed).toBe(true);
    let calls = 0;
    expect(() => f.store.stage(old, entry, { guard() {
      if (++calls === finalGuard) unlinkSync(nodePath(f.root, old.nodeDigest!));
    } })).toThrow('evidence unavailable');
    expect(calls).toBe(finalGuard);
    expect(existsSync(join(f.root, '.index-writer.lock'))).toBe(false);
  });
  it.each(['mode', 'acl'] as const)('refuses callback %s drift before linking a staged node', kind => {
    const f = fixture(); const empty = emptyOrderedImmutableIndexRoot();
    const entry = { key: key(0), valueDigest: valueDigest(0) };
    const node = planOrderedImmutableIndexInsert(empty, entry, () => '').nodes[0]!;
    const target = nodePath(f.root, node.nodeDigest);
    const staged = join(dirname(target), `.stage-${node.nodeDigest}.json`);
    let stagedWritten = false; let changed = false;
    hooks.afterWrite = path => { if (path === staged) stagedWritten = true; };
    expect(() => f.store.stage(empty, entry, { guard() {
      if (!stagedWritten || changed) return;
      changed = true;
      // Real staged file publication, with a real mode change or a narrowly
      // injected ACL refusal at the shard; outer root/lock custody still holds.
      if (kind === 'mode') chmodSync(staged, 0o644); else hooks.denyAssurancePath = dirname(target);
    } })).toThrow('evidence unavailable');
    expect(changed).toBe(true); expect(existsSync(staged)).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(f.root, '.index-writer.lock'))).toBe(false);
    expect(f.store.lookup(empty, entry.key)).toEqual({ found: false });
  });
  it('captures an entry before host callbacks can replace its fields with getters', () => {
    const f = fixture(); const trap = vi.fn(() => { throw new Error('must not read'); });
    const entry = { key: 'original', valueDigest: valueDigest(1) }; let changed = false;
    const next = f.store.stage(emptyOrderedImmutableIndexRoot(), entry, { guard() {
      if (!changed) { changed = true; Object.defineProperty(entry, 'key', { get: trap, enumerable: true }); }
    } });
    expect(trap).not.toHaveBeenCalled();
    expect(f.store.lookup(next.root, 'original')).toMatchObject({ found: true });
  });
  it('retains an interrupted stage without activating it, then retries exact bytes', () => {
    const f = fixture(); const old = seed(f.root, 32); let interrupted = false;
    hooks.afterWrite = () => { if (!interrupted) { interrupted = true; throw new Error('fixture publication interruption'); } };
    expect(() => f.store.stage(old, { key: key(32), valueDigest: valueDigest(32) }, { guard() {} })).toThrow('evidence unavailable');
    expect(f.store.count(old, {})).toBe(32);
    expect(f.store.lookup(old, key(32))).toEqual({ found: false });
    hooks.afterWrite = null;
    const next = f.store.stage(old, { key: key(32), valueDigest: valueDigest(32) }, { guard() {} });
    expect(f.store.count(next.root, {})).toBe(33);
    expect(readdirSync(f.root)).toEqual(['nodes']);
  });
  it.each([false, true])('recovers only an exact two-name publication, refusing corrupt bytes=%s', corrupt => {
    const f = fixture(); const entry = { key: 'a', valueDigest: valueDigest(1) };
    const plan = planOrderedImmutableIndexInsert(emptyOrderedImmutableIndexRoot(), entry, () => '');
    const node = plan.nodes[0]; const target = nodePath(f.root, node.nodeDigest);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const staged = join(dirname(target), `.stage-${node.nodeDigest}.json`);
    const bytes = corrupt ? 'damaged linked fixture\n' : node.bytes;
    writeFileSync(staged, bytes, { mode: 0o600 }); linkSync(staged, target);
    if (corrupt) {
      expect(() => f.store.stage(emptyOrderedImmutableIndexRoot(), entry, { guard() {} })).toThrow('evidence unavailable');
      expect(readFileSync(target, 'utf8')).toBe(bytes); // Never overwrite damaged evidence.
      expect(f.store.count(emptyOrderedImmutableIndexRoot(), {})).toBe(0);
    } else {
      const completed = f.store.stage(emptyOrderedImmutableIndexRoot(), entry, { guard() {} });
      expect(completed.root).toEqual(plan.root);
      expect(f.store.lookup(completed.root, 'a')).toEqual({ found: true, valueDigest: entry.valueDigest });
    }
    expect(existsSync(staged)).toBe(false); // Only the exact staging alias is removed.
    expect(readdirSync(f.root)).toEqual(['nodes']);
    expect(existsSync(join(f.anchor, 'pool-state.json'))).toBe(false);
  });
  it.each(['root', 'anchor'] as const)('refuses %s directory substitution during the staging guard', kind => {
    const f = fixture(); let moved = false;
    expect(() => f.store.stage(emptyOrderedImmutableIndexRoot(), { key: 'a', valueDigest: valueDigest(1) }, { guard() {
      if (moved) return; moved = true;
      const target = kind === 'root' ? f.root : f.anchor;
      renameSync(target, `${target}-original`); mkdirSync(target, { mode: 0o700 });
      if (kind === 'anchor') mkdirSync(f.root, { mode: 0o700 });
    } })).toThrow('evidence unavailable');
    expect(readdirSync(f.root)).toEqual([]);
  });
  it('refuses missing/unsafe roots without creating directories and checks empty-root ACL assurance', () => {
    const f = fixture();
    expect(() => createOrderedImmutableIndexStore({ root: join(f.anchor, 'absent'), anchorPath: f.anchor })).toThrow('evidence unavailable');
    expect(existsSync(join(f.anchor, 'absent'))).toBe(false);
    hooks.denyAssurance = true;
    expect(() => f.store.lookup(emptyOrderedImmutableIndexRoot(), 'a')).toThrow('evidence unavailable');
  });
  it.each(['corrupt', 'missing', 'symlink', 'hardlink'] as const)('refuses %s node evidence', kind => {
    const f = fixture(); const root = seed(f.root, 1); const target = nodePath(f.root, root.nodeDigest!);
    if (kind === 'corrupt') writeFileSync(target, '{}\n');
    if (kind === 'missing') unlinkSync(target);
    if (kind === 'symlink') { const foreign = join(f.anchor, 'foreign'); renameSync(target, foreign); symlinkSync(foreign, target); }
    if (kind === 'hardlink') linkSync(target, join(f.anchor, 'other-link'));
    expect(() => f.store.lookup(root, key(0))).toThrow('evidence unavailable');
  });
  it('refuses a symlink shard and never overwrites an existing conflicting content-addressed slot', () => {
    const f = fixture(); const root = seed(f.root, 1); const target = nodePath(f.root, root.nodeDigest!);
    writeFileSync(target, 'conflicting fixture bytes\n');
    expect(() => f.store.stage(emptyOrderedImmutableIndexRoot(), { key: key(0), valueDigest: valueDigest(0) }, { guard() {} })).toThrow('evidence unavailable');
    expect(readFileSync(target, 'utf8')).toBe('conflicting fixture bytes\n');
    const shard = dirname(target); renameSync(shard, `${shard}-actual`); symlinkSync(`${shard}-actual`, shard);
    expect(() => f.store.lookup(root, key(0))).toThrow('evidence unavailable');
  });
  it('rejects hostile config and guard options without calling accessors or acquiring a lock', () => {
    const f = fixture(); const trap = vi.fn(() => { throw new Error('private'); });
    expect(() => createOrderedImmutableIndexStore(Object.defineProperty({ anchorPath: f.anchor }, 'root', { get: trap, enumerable: true }) as never)).toThrow('Invalid ordered index input');
    expect(() => f.store.stage(emptyOrderedImmutableIndexRoot(), { key: 'a', valueDigest: valueDigest(1) }, Object.defineProperty({}, 'guard', { get: trap, enumerable: true }) as never)).toThrow();
    expect(trap).not.toHaveBeenCalled();
    expect(() => f.store.stage(emptyOrderedImmutableIndexRoot(), { key: 'a', valueDigest: valueDigest(1) }, { guard() { throw new Error('PRIVATE'); } })).toThrow('Ordered index evidence unavailable');
    expect(readdirSync(f.root)).toEqual([]);
  });
});
