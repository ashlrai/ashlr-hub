/** Closed, read-only Apple Git selection. Never invokes Apple's launcher. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { types } from 'node:util';

const LOCATIONS = ['/Library/Developer/CommandLineTools/usr/bin/git', '/Applications/Xcode.app/Contents/Developer/usr/bin/git'];
const LIMIT = 256 * 1024 * 1024;
const unavailable = () => new Error('Preparation Git unavailable or changed');
class MissingLocation extends Error {}
function same(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode && a.uid === b.uid &&
    a.gid === b.gid && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function safe(stat, file) {
  return !stat.isSymbolicLink() && stat.uid === 0n && (stat.mode & 0o022n) === 0n &&
    (file ? stat.isFile() && stat.nlink === 1n && (stat.mode & 0o111n) !== 0n && stat.size > 0n && stat.size <= BigInt(LIMIT)
      : stat.isDirectory());
}
function inspect(path) {
  const hierarchy = [path];
  for (let current = dirname(path); ; current = dirname(current)) {
    hierarchy.unshift(current); if (current === dirname(current)) break;
  }
  const captured = hierarchy.map(component => {
    let stat;
    try { stat = lstatSync(component, { bigint: true }); }
    catch (error) { if (error?.code === 'ENOENT') throw new MissingLocation(); throw unavailable(); }
    if (!safe(stat, component === path)) throw unavailable();
    return { path: component, stat };
  });
  if (realpathSync(path) !== path) throw unavailable();
  const before = captured.at(-1).stat;
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let digest;
  try {
    if (!same(before, fstatSync(descriptor, { bigint: true }))) throw unavailable();
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, LIMIT + 1 - total), total);
      if (!Number.isSafeInteger(count) || count < 0 || count > Math.min(buffer.length, LIMIT + 1 - total)) throw unavailable();
      if (!count) break;
      total += count; if (total > LIMIT || BigInt(total) > before.size) throw unavailable();
      hash.update(buffer.subarray(0, count));
    }
    if (BigInt(total) !== before.size || !same(before, fstatSync(descriptor, { bigint: true }))) throw unavailable();
    digest = hash.digest('hex');
  } finally { closeSync(descriptor); }
  for (const component of captured) {
    const current = lstatSync(component.path, { bigint: true });
    if (!safe(current, component.path === path) || !same(component.stat, current)) throw unavailable();
  }
  if (realpathSync(path) !== path) throw unavailable();
  return { path, digest };
}

export function resolvePreparationGit() {
  const missing = [];
  for (const path of LOCATIONS) {
    let pin;
    try { pin = inspect(path); }
    catch (error) { if (!(error instanceof MissingLocation)) throw unavailable(); missing.push(path); continue; }
    // A fallback cannot silently survive a preferred installation appearing
    // while its executable was being read.
    for (const previous of missing) {
      try { inspect(previous); throw unavailable(); }
      catch (error) { if (!(error instanceof MissingLocation)) throw unavailable(); }
    }
    return pin;
  }
  throw unavailable();
}

export function assertPreparationGit(pin) {
  if (!pin || typeof pin !== 'object' || types.isProxy(pin) || ![Object.prototype, null].includes(Object.getPrototypeOf(pin)) ||
      Reflect.ownKeys(pin).length !== 2) throw unavailable();
  const fields = Object.getOwnPropertyDescriptors(pin);
  for (const key of ['path', 'digest']) if (!fields[key] || !Object.hasOwn(fields[key], 'value') || !fields[key].enumerable) throw unavailable();
  const path = fields.path.value, digest = fields.digest.value;
  if (!LOCATIONS.includes(path) || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw unavailable();
  const current = resolvePreparationGit();
  if (current.path !== path || current.digest !== digest) throw unavailable();
}
