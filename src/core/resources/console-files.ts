/** Bounded, observational reads of explicit registered projects; not an OS sandbox. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync,
  type BigIntStats } from 'node:fs';
import { join } from 'node:path';
import { matchesResourceConsoleProject, type ResourceConsoleProjectBinding } from './console-projects.js';
import type { ResourceConsoleFileListing, ResourceConsoleFilePreview } from './console-files-types.js';

export const MAX_RESOURCE_FILE_PREVIEW_BYTES = 64 * 1024;
export const MAX_RESOURCE_DIRECTORY_ENTRIES = 256;
export class ResourceConsoleFileError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'UNAVAILABLE' | 'LIMIT_EXCEEDED', message: string) {
    super(message); this.name = 'ResourceConsoleFileError';
  }
}
const DENIED = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage', 'target',
  'credentials', 'credentials.json', 'secrets', 'secrets.json', 'auth.json', 'tokens.json',
  'id_rsa', 'id_ed25519', 'id_ecdsa', 'service-account.json']);
const SAFE_HIDDEN = new Set(['.github', '.gitignore', '.gitattributes', '.editorconfig']);
function hasControl(text: string, allowWhitespace = false): boolean {
  return [...text].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 && !(allowWhitespace && [9, 10, 13].includes(code)) || code >= 127 && code <= 159;
  });
}
function allowedName(name: string): boolean {
  const key = name.normalize('NFC').toLowerCase();
  return name.length > 0 && Buffer.byteLength(name) <= 255 && (!name.startsWith('.') || SAFE_HIDDEN.has(key)) &&
    !/[\\/]/u.test(name) && !hasControl(name) &&
    Buffer.from(name).toString('utf8') === name && !DENIED.has(key) &&
    !/\.(pem|key|p12|pfx|keystore)$/u.test(key);
}
function segments(path: unknown, directory: boolean): string[] {
  if (typeof path !== 'string' || Buffer.byteLength(path) > 4096 ||
    !directory && path === '' || path !== '' && !path.split('/').every(allowedName)) {
    throw new ResourceConsoleFileError('INVALID_INPUT', 'Use an allowed project-relative path.');
  }
  return path === '' ? [] : path.split('/');
}
function safeDirectory(stat: BigIntStats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() &&
    typeof process.getuid === 'function' && stat.uid === BigInt(process.getuid()) && (stat.mode & 0o022n) === 0n;
}
function safeFile(stat: BigIntStats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n &&
    typeof process.getuid === 'function' && stat.uid === BigInt(process.getuid()) && (stat.mode & 0o022n) === 0n &&
    stat.size >= 0n && stat.size <= BigInt(Number.MAX_SAFE_INTEGER);
}
function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid &&
    a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function unavailable(): never { throw new ResourceConsoleFileError('UNAVAILABLE', 'Project file is unsafe, changed, or unavailable.'); }
function translate(error: unknown): never {
  if (error instanceof ResourceConsoleFileError) throw error;
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    throw new ResourceConsoleFileError('NOT_FOUND', 'Project path was not found.');
  }
  return unavailable();
}
/** Every project-relative directory is checked, not merely the leaf's parent.
 * Rechecks detect observed changes; path-based Node APIs cannot eliminate every rename race.
 */
function directories(binding: ResourceConsoleProjectBinding, parts: string[]): () => void {
  if (!matchesResourceConsoleProject(binding)) unavailable();
  const snapshots: Array<{ path: string; stat: BigIntStats }> = [];
  let path = binding.workspace;
  for (const part of ['', ...parts]) {
    if (part) path = join(path, part);
    const stat = lstatSync(path, { bigint: true });
    if (!safeDirectory(stat) || realpathSync(path) !== path) unavailable();
    snapshots.push({ path, stat });
  }
  return () => {
    if (!matchesResourceConsoleProject(binding)) unavailable();
    for (const before of snapshots) {
      const after = lstatSync(before.path, { bigint: true });
      if (!safeDirectory(after) || !same(before.stat, after) || realpathSync(before.path) !== before.path) unavailable();
    }
  };
}

export function listResourceConsoleFiles(binding: ResourceConsoleProjectBinding, path: string): ResourceConsoleFileListing {
  const parts = segments(path, true);
  let handle: ReturnType<typeof opendirSync> | undefined;
  let fd: number | undefined;
  try {
    const verify = directories(binding, parts); const target = join(binding.workspace, ...parts);
    const before = lstatSync(target, { bigint: true });
    fd = openSync(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (!same(before, fstatSync(fd, { bigint: true }))) unavailable();
    handle = opendirSync(target, { encoding: 'utf8', bufferSize: 32 });
    const entries: ResourceConsoleFileListing['entries'] = []; let count = 0;
    for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
      if (++count > MAX_RESOURCE_DIRECTORY_ENTRIES) throw new ResourceConsoleFileError('LIMIT_EXCEEDED', 'Directory exceeds the 256-entry browsing limit.');
      if (!allowedName(entry.name)) continue;
      const child = join(target, entry.name); const stat = lstatSync(child, { bigint: true });
      const kind = safeDirectory(stat) ? 'directory' : safeFile(stat) ? 'file' : null;
      if (!kind || realpathSync(child) !== child) continue;
      entries.push({ name: entry.name, path: [...parts, entry.name].join('/'), kind,
        sizeBytes: kind === 'file' ? Number(stat.size) : null });
    }
    verify(); if (!same(before, fstatSync(fd, { bigint: true }))) unavailable();
    entries.sort((a, b) => a.kind === b.kind ? a.name < b.name ? -1 : a.name > b.name ? 1 : 0 : a.kind === 'directory' ? -1 : 1);
    return { projectId: binding.id, path, entries };
  } catch (error) { return translate(error); }
  finally { if (handle) handle.closeSync(); if (fd !== undefined) closeSync(fd); }
}

export function readResourceConsoleFile(binding: ResourceConsoleProjectBinding, path: string): ResourceConsoleFilePreview {
  const parts = segments(path, false); let fd: number | undefined;
  try {
    const verify = directories(binding, parts.slice(0, -1)); const target = join(binding.workspace, ...parts);
    const before = lstatSync(target, { bigint: true });
    if (!safeFile(before) || realpathSync(target) !== target) unavailable();
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd, { bigint: true });
    if (!safeFile(opened) || !same(before, opened)) unavailable();
    const sizeBytes = Number(opened.size); const raw = Buffer.alloc(Math.min(sizeBytes, MAX_RESOURCE_FILE_PREVIEW_BYTES));
    let offset = 0;
    while (offset < raw.length) {
      const count = readSync(fd, raw, offset, raw.length - offset, offset);
      if (!count) unavailable(); offset += count;
    }
    if (!same(opened, fstatSync(fd, { bigint: true })) || !same(opened, lstatSync(target, { bigint: true })) ||
      realpathSync(target) !== target) unavailable();
    verify();
    const truncated = sizeBytes > raw.length;
    // Streaming decode permits only an incomplete final code point at a preview boundary.
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw, { stream: truncated }); }
    catch { throw new ResourceConsoleFileError('INVALID_INPUT', 'File preview must be valid UTF-8 text.'); }
    if (hasControl(text, true)) {
      throw new ResourceConsoleFileError('INVALID_INPUT', 'Binary or control-character file previews are not supported.');
    }
    return { projectId: binding.id, path, text, sizeBytes, byteLength: Buffer.byteLength(text), truncated,
      digest: createHash('sha256').update(text, 'utf8').digest('hex') };
  } catch (error) { return translate(error); }
  finally { if (fd !== undefined) closeSync(fd); }
}
