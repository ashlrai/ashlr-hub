/**
 * Pinned private-root authority shared by dispatch production and receipt stores.
 * This module is deliberately dependency-leaf: it must not import the ledger or
 * receipt contract, so either can validate durable metadata without a cycle.
 */

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fsyncDirectory } from '../util/durability.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';

export function dispatchProductionDir(): string {
  const configuredHome = process.env.ASHLR_HOME;
  const root = typeof configuredHome === 'string' && configuredHome.trim() !== ''
    ? configuredHome
    : join(homedir(), '.ashlr');
  return join(root, 'dispatch-production');
}

export function sameDispatchProductionFile(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function safeDispatchProductionDirectory(stat: Stats): boolean {
  return !stat.isSymbolicLink() && stat.isDirectory() &&
    (typeof process.getuid !== 'function' || Number(stat.uid) === process.getuid()) &&
    (process.platform === 'win32' || (Number(stat.mode) & 0o022) === 0);
}

interface DispatchProductionWriteRoot {
  path: string;
  realPath: string;
  identity: Stats;
  fd?: number;
}

const dispatchProductionWriteRoots: DispatchProductionWriteRoot[] = [];

export function assertStableDispatchProductionWriteRoot(): void {
  const expected = dispatchProductionWriteRoots.at(-1);
  if (!expected) throw new Error('dispatch production write root unavailable');
  const named = lstatSync(expected.path);
  if (!safeDispatchProductionDirectory(named) || !sameDispatchProductionFile(expected.identity, named) ||
    realpathSync(expected.path) !== expected.realPath) {
    throw new Error('dispatch production write root changed');
  }
  if (expected.fd !== undefined) {
    const opened = fstatSync(expected.fd);
    if (!safeDispatchProductionDirectory(opened) || !sameDispatchProductionFile(expected.identity, opened)) {
      throw new Error('dispatch production write root changed');
    }
  }
  if (process.platform === 'win32' && !assurePrivateStoragePath(
    expected.path, 'directory', 'inspect-owned', { anchorPath: dirname(expected.path) },
  ).ok) throw new Error('unsafe Windows dispatch production root');
}

function openDispatchProductionWriteRoot(): DispatchProductionWriteRoot {
  const path = dispatchProductionDir();
  const parent = dirname(path);
  let created = false;
  let fd: number | undefined;
  try {
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: false, mode: 0o700 });
      created = true;
    }
    const before = lstatSync(path);
    if (!safeDispatchProductionDirectory(before)) throw new Error('unsafe dispatch production write root');
    if (process.platform === 'win32' && !assurePrivateStoragePath(
      path, 'directory', created ? 'secure-created' : 'inspect-owned', { anchorPath: parent },
    ).ok) throw new Error('unsafe Windows dispatch production root');
    const identity = lstatSync(path);
    const realParent = realpathSync(parent);
    const realPath = realpathSync(path);
    if (!safeDispatchProductionDirectory(identity) || !sameDispatchProductionFile(before, identity) ||
      dirname(realPath) !== realParent || basename(realPath) !== basename(path)) {
      throw new Error('unsafe dispatch production write root');
    }
    if (process.platform !== 'win32') {
      const directoryOnly = typeof fsConstants.O_DIRECTORY === 'number' ? fsConstants.O_DIRECTORY : 0;
      fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | directoryOnly);
      const opened = fstatSync(fd);
      if (!safeDispatchProductionDirectory(opened) || !sameDispatchProductionFile(identity, opened)) {
        throw new Error('dispatch production write root changed');
      }
    }
    if (created) fsyncDirectory(parent);
    return { path, realPath, identity, ...(fd === undefined ? {} : { fd }) };
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve primary failure */ } }
    throw error;
  }
}

export function withStableDispatchProductionWriteRoot<T>(consume: () => T): T {
  if (dispatchProductionWriteRoots.length > 0) {
    assertStableDispatchProductionWriteRoot();
    const value = consume();
    assertStableDispatchProductionWriteRoot();
    return value;
  }
  const root = openDispatchProductionWriteRoot();
  dispatchProductionWriteRoots.push(root);
  try {
    assertStableDispatchProductionWriteRoot();
    const value = consume();
    assertStableDispatchProductionWriteRoot();
    return value;
  } finally {
    dispatchProductionWriteRoots.pop();
    if (root.fd !== undefined) { try { closeSync(root.fd); } catch { /* best effort */ } }
  }
}

function ensurePrivateReceiptDirectory(dir: string): void {
  assertStableDispatchProductionWriteRoot();
  const created = !existsSync(dir);
  if (created) mkdirSync(dir, { recursive: false, mode: 0o700 });
  const dirStat = lstatSync(dir);
  if (!safeDispatchProductionDirectory(dirStat)) throw new Error('unsafe receipt directory');
  chmodSync(dir, 0o700);
  if (process.platform === 'win32' && !assurePrivateStoragePath(
    dir, 'directory', created ? 'secure-created' : 'inspect-existing', { anchorPath: dispatchProductionDir() },
  ).ok) throw new Error('unsafe Windows receipt directory');
  if (created) fsyncDirectory(dirname(dir));
  assertStableDispatchProductionWriteRoot();
}

export function ensurePrivateDispatchProductionReceiptDirectory(dir: string): void {
  ensurePrivateReceiptDirectory(dir);
}

export function secureCreatedDispatchProductionReceiptTempFile(path: string): void {
  assertStableDispatchProductionWriteRoot();
  if (!/(?:\.\d+\.tmp|\.[a-f0-9]{32}\.stage)$/.test(basename(path))) {
    throw new Error('receipt secure-created target is not a new temp');
  }
  if (process.platform === 'win32' && !assurePrivateStoragePath(
    path, 'file', 'secure-created', { anchorPath: dispatchProductionDir() },
  ).ok) throw new Error('unsafe Windows receipt file');
}

export function inspectExactDispatchProductionReceiptFile(path: string): void {
  if (dispatchProductionWriteRoots.length > 0) assertStableDispatchProductionWriteRoot();
  if (process.platform === 'win32' && !assurePrivateStoragePath(
    path, 'file', 'inspect-existing', { anchorPath: dispatchProductionDir() },
  ).ok) throw new Error('unsafe Windows receipt authority file');
}

export class ReceiptDirectoryAuthorityError extends Error {
  constructor(readonly reason: string) {
    super(`unsafe Windows receipt authority directory: ${reason}`);
  }
}

export const UNSAFE_RECEIPT_DIRECTORY_REASONS = new Set([
  'anchor-not-reached', 'dacl-not-protected', 'deny-ace', 'inherited-ace',
  'missing-or-duplicate-principal', 'reparse-ancestor', 'reparse-point',
  'unexpected-ace-count', 'untrusted-ancestor-delete', 'untrusted-ancestor-owner',
  'untrusted-item-write', 'wrong-flags', 'wrong-kind', 'wrong-owner', 'wrong-rights',
]);

export function inspectExactDispatchProductionReceiptDirectory(path: string): void {
  if (process.platform !== 'win32') return;
  const assurance = assurePrivateStoragePath(
    path, 'directory', 'inspect-existing', { anchorPath: dispatchProductionDir() },
  );
  if (!assurance.ok) throw new ReceiptDirectoryAuthorityError(assurance.reason);
}
