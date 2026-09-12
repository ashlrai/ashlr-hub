/** Private bounded mailbox data only. No executable objects cross this boundary. */
import * as fs from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { TextDecoder } from 'node:util';

export const MAX_MESSAGE_BYTES = 256 * 1024;
export const MAX_CALLS = 16;
export const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptors(value), key) &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
function fail() { throw new Error('CANDIDATE_MAILBOX_INVALID'); }
function parent(file) {
  if (typeof file !== 'string' || !isAbsolute(file) || resolve(file) !== file) fail();
  const directory = dirname(file), stat = fs.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory ||
      Number(stat.mode & 0o777n) !== 0o700 || typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) fail();
  return { directory, stat };
}
function same(a, b) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs; }
function directoryUnchanged(value) {
  const now = fs.lstatSync(value.directory, { bigint: true });
  if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== value.stat.dev || now.ino !== value.stat.ino ||
      Number(now.mode & 0o777n) !== 0o700 || fs.realpathSync(value.directory) !== value.directory) fail();
}
export function readMessage(file) {
  const anchor = parent(file); let fd;
  try {
    let before;
    try { before = fs.lstatSync(file, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!before.isFile() || before.isSymbolicLink() || Number(before.mode & 0o777n) !== 0o600 ||
        typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid()) ||
        before.size < 2n || before.size > BigInt(MAX_MESSAGE_BYTES)) fail();
    // A wx hard-link publication has a brief two-link window. Never consume
    // it until finalized; a permanent extra link times out without acceptance.
    if (before.nlink === 2n) return null;
    if (before.nlink !== 1n) fail();
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(fd, { bigint: true }); if (!same(before, opened) || opened.nlink !== 1n) fail();
    const bytes = Buffer.alloc(Number(before.size));
    if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) fail();
    const after = fs.fstatSync(fd, { bigint: true }), installed = fs.lstatSync(file, { bigint: true });
    if (!same(before, after) || !same(before, installed) || after.nlink !== 1n || installed.nlink !== 1n) fail();
    directoryUnchanged(anchor);
    return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function jsonData(value, ancestors = new Set(), depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || !value || depth > 48 || ancestors.has(value) ||
      !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  ancestors.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value) && (value.length > MAX_MESSAGE_BYTES || Reflect.ownKeys(value).length !== value.length + 1 ||
      Array.from({ length: value.length }, (_, index) => index).some(index => !Object.hasOwn(descriptors, index)))) fail();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail();
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail();
    jsonData(descriptor.value, ancestors, depth + 1);
  }
  ancestors.delete(value);
}
export function publishMessage(file, value) {
  jsonData(value);
  const bytes = Buffer.from(JSON.stringify(value) + '\n'); if (bytes.length > MAX_MESSAGE_BYTES) fail();
  const anchor = parent(file); const stage = `${file}.${randomBytes(16).toString('hex')}.tmp`; let fd;
  try {
    fd = fs.openSync(stage, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    directoryUnchanged(anchor); fs.linkSync(stage, file); fs.unlinkSync(stage);
    const directoryFd = fs.openSync(anchor.directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    directoryUnchanged(anchor);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(stage); } catch { /* Preserve a failed publication for inspection rather than masking its error. */ }
  }
}
