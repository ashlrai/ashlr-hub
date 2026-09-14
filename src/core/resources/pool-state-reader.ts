/** Checked read-only capture of an installed ledger. Never selects a header,
 * provisions a key, takes a writer lease or authorizes execution. */
import { lstatSync, realpathSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { inspectPrivateDirectory } from '../universe/artifacts.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { resourcePoolConfigSnapshot } from './pool-evolution-policy.js';
import type { ResourcePool } from './pool-policy.js';
import { readResourceJson } from './pool-runtime.js';
import { captureResourcePoolStateJson } from './pool-state-capture.js';
import { readResourcePoolStorage, type ResourcePoolStorageView } from './pool-state-storage.js';
import type { ResourceBinding } from './worker.js';

export interface ResourcePoolStorageSnapshot {
  readonly view: ResourcePoolStorageView;
  /** Exact captured source identity AND archive custody, not dispatch authority.
   * Unlike view.isCurrent(), this becomes false after valid header compaction. */
  isCurrent(): boolean;
  /** Original directory identity/privacy and captured archive/key custody only.
   * Does not validate the current header or prove logical receipt equality;
   * callers must acquire and compare a fresh snapshot before publication. */
  isCustodyCurrent(): boolean;
}
function fail(): never { throw new Error('Resource pool storage snapshot unavailable'); }
function path(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && isAbsolute(value) && resolve(value) === value &&
    value !== parse(value).root && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}
function identity(file: string): BigIntStats | null {
  try { return lstatSync(file, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; return fail(); }
}
function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid &&
    left.gid === right.gid && left.nlink === right.nlink && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/** Unlike the generic JSON reader's one-reopen convenience, this acquisition
 * refuses any concurrent header replacement: only its initial source is pinned.
 * Callers may take another observation, but no returned snapshot ever renews. */
export function readResourcePoolStorageSnapshot(rootValue: string, poolValue: ResourcePool, bindingsValue: ResourceBinding[],
  archiveKeyFileValue?: string): ResourcePoolStorageSnapshot {
  try {
    // Capture descriptors before filesystem assurance can call platform adapters.
    const captured = JSON.parse(captureResourcePoolStateJson({ root: rootValue, pool: poolValue, bindings: bindingsValue,
      ...(archiveKeyFileValue === undefined ? {} : { archiveKeyFile: archiveKeyFileValue }) }));
    const { root, archiveKeyFile } = captured as { root: string; archiveKeyFile?: string };
    if (process.platform === 'win32' || !path(root) || archiveKeyFile !== undefined &&
      (!path(archiveKeyFile) || dirname(archiveKeyFile) !== root)) return fail();
    const active = resourcePoolConfigSnapshot(captured.pool, captured.bindings);
    const file = join(root, 'pool-state.json');
    const directory = identity(root); const before = identity(file);
    function checkRoot(): void {
      const currentDirectory = identity(root);
      if (directory === null ? currentDirectory !== null : currentDirectory === null ||
        !currentDirectory.isDirectory() || currentDirectory.isSymbolicLink() || realpathSync(root) !== root ||
        (currentDirectory.mode & 0o777n) !== 0o700n || typeof process.getuid === 'function' && currentDirectory.uid !== BigInt(process.getuid()) ||
        currentDirectory.dev !== directory.dev || currentDirectory.ino !== directory.ino ||
        currentDirectory.mode !== directory.mode || currentDirectory.uid !== directory.uid || currentDirectory.gid !== directory.gid) fail();
    }
    function checkIdentities(): void {
      checkRoot(); const current = identity(file);
      if (before === null ? current !== null : current === null || !sameFile(before, current)) fail();
      // Keep legacy lazy key enrollment: fixed orphan names imply incomplete
      // state, but a separately supplied key is not read for a legacy snapshot.
      if (before === null && (identity(join(root, 'receipt-archive')) !== null || identity(join(root, 'receipt-archive.key')) !== null)) fail();
    }
    function assureDirectory(): void {
      checkRoot();
      if (directory !== null) {
        inspectPrivateDirectory(root);
        if (!assurePrivateStoragePath(root, 'directory', 'inspect-existing', { anchorPath: root }).ok) fail();
      }
      checkRoot();
    }
    function assureSource(): void {
      checkIdentities(); assureDirectory();
      if (directory !== null && before !== null && !assurePrivateStoragePath(file, 'file', 'inspect-existing', { anchorPath: root }).ok) fail();
      checkIdentities();
    }
    assureSource();
    const value = before === null ? { schemaVersion: 1, poolDigest: active.poolDigest, observations: [], attempts: [] }
      : readResourceJson(file, 4 * 1024 * 1024);
    checkIdentities();
    const view = readResourcePoolStorage(value, { root, pool: active.pool, bindings: active.bindings,
      ...(archiveKeyFile === undefined ? {} : { archiveKeyFile }) });
    const isCurrent = () => {
      try {
        assureSource();
        if (!view.isCurrent()) return false;
        // Archive checks also use assurance adapters. Finish with raw identity
        // checks so those callbacks cannot replace the pinned source unnoticed.
        checkIdentities(); return true;
      } catch { return false; }
    };
    const isCustodyCurrent = () => {
      try {
        assureDirectory();
        if (!view.isCurrent()) return false;
        // Archive assurance callbacks cannot replace the originally captured
        // directory, even when its replacement has identical private bytes.
        checkRoot(); return true;
      } catch { return false; }
    };
    if (!isCurrent()) return fail();
    return Object.freeze({ view, isCurrent, isCustodyCurrent });
  } catch { return fail(); }
}
