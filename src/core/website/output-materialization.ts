import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readlinkSync, readdirSync, readSync, realpathSync, rmSync, writeSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

interface SourceEntry { stat: BigIntStats; target?: string; children?: string[] }
interface CopyEntry { name: string; source: string; stat: BigIntStats }
const MAX_ENTRIES = 100_000;
const MAX_BYTES = 5 * 1024 ** 3;
function same(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function contains(parent: string, child: string): boolean {
  const name = relative(parent, child);
  return name === '' || (!isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`));
}

/** Vercel deduplicates functions with internal aliases. Copy their validated bytes, never the links.
 * Call only after the credential-free builder is proven absent, inside its private operation directory.
 * The host and its same-user processes remain trusted; Node has no portable descriptor-relative openat.
 */
export function materializeWebsiteOutput(source: string, destination: string): void {
  const root = resolve(source); const target = resolve(destination);
  if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== root || contains(root, target) || contains(target, root) ||
      realpathSync(dirname(target)) !== dirname(target)) throw new Error('Website output copy roots are unsafe');
  const entries = new Map<string, SourceEntry>();
  const snapshot = (name: string): void => {
    if (entries.size >= MAX_ENTRIES) throw new Error('Website output exceeds materialization limits');
    const path = join(root, name); const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(path);
      if (!link || isAbsolute(link)) throw new Error('Website output alias is not relative');
      entries.set(name, { stat, target: link });
    } else {
      if ((!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1n)) throw new Error('Website output contains an unsupported path');
      const children = stat.isDirectory() ? readdirSync(path).sort() : undefined;
      entries.set(name, { stat, children });
      if (children) for (const child of children) snapshot(join(name, child));
    }
    if (!same(stat, lstatSync(path, { bigint: true }))) throw new Error('Website output changed during materialization');
  };
  snapshot('');
  if (!entries.get('')!.stat.isDirectory()) throw new Error('Website output root is not a directory');
  // Resolve one component at a time in the snapshot: lexical '..' normalization could hide
  // an intermediate outside link, and filesystem realpath would already follow that link.
  const canonical = (name: string): string => {
    const pending = name.split(sep); const parts: string[] = []; let links = 0;
    while (pending.length) {
      const part = pending.shift()!;
      if (!part || part === '.') continue;
      if (part === '..') { if (!parts.length) throw new Error('Website output alias escapes its root'); parts.pop(); continue; }
      const candidate = [...parts, part].join(sep); const entry = entries.get(candidate);
      if (!entry) throw new Error('Website output alias target is missing');
      if (entry.target !== undefined) {
        if (++links > 128) throw new Error('Website output alias cycle');
        pending.unshift(...entry.target.split(sep));
      } else {
        if (pending.length && !entry.stat.isDirectory()) throw new Error('Website output alias traverses a file');
        parts.push(part);
      }
    }
    return parts.join(sep);
  };
  const plan: CopyEntry[] = []; let bytes = 0;
  const expand = (name: string, sourceName: string, ancestors: Set<string>): void => {
    const real = canonical(sourceName); const entry = entries.get(real)!;
    if (plan.length >= MAX_ENTRIES) throw new Error('Website output exceeds materialization limits');
    plan.push({ name, source: real, stat: entry.stat });
    if (entry.stat.isDirectory()) {
      if (ancestors.has(real)) throw new Error('Website output directory alias cycle');
      const nested = new Set(ancestors).add(real);
      for (const child of entry.children!) expand(join(name, child), join(real, child), nested);
    } else {
      bytes += Number(entry.stat.size);
      if (!Number.isSafeInteger(bytes) || bytes > MAX_BYTES) throw new Error('Website output exceeds materialization limits');
    }
  };
  expand('', '', new Set());
  const unchanged = (): void => {
    for (const [name, entry] of entries) {
      const path = join(root, name);
      if (!same(entry.stat, lstatSync(path, { bigint: true })) ||
          (entry.target !== undefined && readlinkSync(path) !== entry.target)) throw new Error('Website output changed during materialization');
    }
  };
  unchanged();
  mkdirSync(target, { mode: 0o700 }); // Exclusive creation: never overwrite or clean an existing directory.
  try {
    const buffer = Buffer.alloc(64 * 1024);
    for (const entry of plan) {
      const path = join(target, entry.name);
      if (entry.stat.isDirectory()) { if (entry.name) mkdirSync(path, { mode: 0o700 }); continue; }
      const inputPath = join(root, entry.source);
      if (realpathSync(inputPath) !== inputPath) throw new Error('Website output changed during materialization');
      const input = openSync(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!same(entry.stat, fstatSync(input, { bigint: true }))) throw new Error('Website output changed during materialization');
        const output = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, Number(entry.stat.mode & 0o777n));
        try {
          let remaining = Number(entry.stat.size);
          while (remaining > 0) {
            const count = readSync(input, buffer, 0, Math.min(buffer.length, remaining), null);
            if (!count) throw new Error('Website output changed during materialization');
            let written = 0;
            while (written < count) {
              const countWritten = writeSync(output, buffer, written, count - written);
              if (!countWritten) throw new Error('Website output copy could not make progress');
              written += countWritten;
            }
            remaining -= count;
          }
          if (readSync(input, buffer, 0, 1, null)) throw new Error('Website output changed during materialization');
        } finally { closeSync(output); }
        if (!same(entry.stat, fstatSync(input, { bigint: true })) || !same(entry.stat, lstatSync(inputPath, { bigint: true }))) throw new Error('Website output changed during materialization');
      } finally { closeSync(input); }
    }
    unchanged();
    for (const entry of [...plan].reverse()) chmodSync(join(target, entry.name), Number(entry.stat.mode & 0o777n));
  } catch (error) { rmSync(target, { recursive: true, force: true }); throw error; }
}
