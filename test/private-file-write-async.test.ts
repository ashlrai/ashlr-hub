import { lstatSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writePrivateFileAtomicallyAsync } from '../src/core/util/private-file-write.js';

const io = vi.hoisted(() => ({ gate: null as Promise<void> | null, entered: null as (() => void) | null, beforeStatReturns: null as (() => void) | null }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args); let stats = 0;
    return new Proxy(handle, { get(target, key) {
      if (key === 'stat') return async (...statArgs: Parameters<typeof handle.stat>) => {
        const result = await handle.stat(...statArgs); if (++stats === 3) io.beforeStatReturns?.(); return result;
      };
      if (key === 'write') return async (...writeArgs: Parameters<typeof handle.write>) => {
        io.entered?.(); if (io.gate) await io.gate;
        return handle.write(...writeArgs);
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
});
let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-private-async-write-'))); io.gate = null; io.entered = null; io.beforeStatReturns = null; });
afterEach(() => { io.gate = null; io.entered = null; io.beforeStatReturns = null; rmSync(root, { recursive: true, force: true }); });
const paths = () => ({ temporary: join(root, 'record.tmp'), target: join(root, 'record.json') });
const options = (beforePublish = () => {}) => ({ anchorPath: root, label: 'Private fixture', beforePublish });

describe('asynchronous private atomic publication', () => {
  it('keeps exact private mode/content and atomically replaces a prior target', async () => {
    const p = paths(); writeFileSync(p.target, 'old', { mode: 0o600 }); const fence = vi.fn();
    await writePrivateFileAtomicallyAsync(p.temporary, p.target, 'new', options(fence));
    expect(readFileSync(p.target, 'utf8')).toBe('new'); expect(lstatSync(p.target).mode & 0o777).toBe(0o600);
    expect(fence).toHaveBeenCalledOnce(); expect(readdirSync(root)).toEqual(['record.json']);
  });
  it('leaves the event loop responsive while actual data write is delayed', async () => {
    let release!: () => void; let entered!: () => void;
    io.gate = new Promise(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { entered = resolve; }); io.entered = entered;
    const p = paths(); let finished = false;
    const result = writePrivateFileAtomicallyAsync(p.temporary, p.target, 'data', options()).then(() => { finished = true; });
    await ready; let painted = false; await new Promise<void>(resolve => setImmediate(() => { painted = true; resolve(); }));
    expect(painted).toBe(true); expect(finished).toBe(false); expect(() => readFileSync(p.target)).toThrow();
    release(); await result; expect(readFileSync(p.target, 'utf8')).toBe('data');
  });
  it('rechecks host ownership/identity after slow IO and refuses publication on loss', async () => {
    let release!: () => void; let entered!: () => void;
    io.gate = new Promise(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { entered = resolve; }); io.entered = entered;
    const p = paths(); writeFileSync(p.target, 'original', { mode: 0o600 }); let held = true;
    const result = writePrivateFileAtomicallyAsync(p.temporary, p.target, 'obsolete', options(() => { if (!held) throw new Error('Ownership changed'); }));
    const refused = expect(result).rejects.toThrow('Ownership changed'); await ready; held = false; release(); await refused;
    expect(readFileSync(p.target, 'utf8')).toBe('original'); expect(readdirSync(root)).toEqual(['record.json']);
  });
  it('pins a mutable Buffer before the first await', async () => {
    const p = paths(); const data = Buffer.from('original');
    const result = writePrivateFileAtomicallyAsync(p.temporary, p.target, data, options()); data.fill(120); await result;
    expect(readFileSync(p.target, 'utf8')).toBe('original');
  });
  it('refuses an existing symlink temporary without touching its destination', async () => {
    const p = paths(); writeFileSync(p.target, 'original', { mode: 0o600 }); symlinkSync(p.target, p.temporary);
    await expect(writePrivateFileAtomicallyAsync(p.temporary, p.target, 'new', options())).rejects.toThrow();
    expect(readFileSync(p.target, 'utf8')).toBe('original'); expect(lstatSync(p.temporary).isSymbolicLink()).toBe(true);
  });
  it('refuses replacement during the final descriptor-stat await before metadata commit', async () => {
    const p = paths(); io.beforeStatReturns = () => {
      unlinkSync(p.temporary); writeFileSync(p.temporary, 'replacement', { mode: 0o600 });
    };
    await expect(writePrivateFileAtomicallyAsync(p.temporary, p.target, 'data', options())).rejects.toThrow('changed before publication');
    expect(readFileSync(p.temporary, 'utf8')).toBe('replacement'); expect(() => readFileSync(p.target)).toThrow();
  });
  it('refuses an inode replacement during IO and never deletes that replacement', async () => {
    let release!: () => void; let entered!: () => void;
    io.gate = new Promise(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { entered = resolve; }); io.entered = entered;
    const p = paths(); const result = writePrivateFileAtomicallyAsync(p.temporary, p.target, 'data', options());
    const refused = expect(result).rejects.toThrow('changed before publication'); await ready;
    unlinkSync(p.temporary); writeFileSync(p.temporary, 'replacement', { mode: 0o600 }); release(); await refused;
    expect(readFileSync(p.temporary, 'utf8')).toBe('replacement'); expect(() => readFileSync(p.target)).toThrow();
  });
});
