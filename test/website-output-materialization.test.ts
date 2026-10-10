import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeWebsiteOutput } from '../src/core/website/output-materialization.js';
import { inventoryWebsiteOutput } from '../src/core/website/host-release.js';
const reads = vi.hoisted(() => ({ afterRead: null as (() => void) | null, bytes: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, readSync: (...args: Parameters<typeof actual.readSync>) => {
    const count = actual.readSync(...args); reads.bytes += count; reads.afterRead?.(); return count;
  } };
});

let home: string; let source: string; let target: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'website-output-'))); source = join(home, 'raw'); target = join(home, 'frozen');
  mkdirSync(source); writeFileSync(join(source, 'config.json'), '{"version":3}');
  mkdirSync(join(source, 'functions')); mkdirSync(join(source, 'functions', 'docs.func'));
  writeFileSync(join(source, 'functions', 'docs.func', 'index.js'), Buffer.from([0, 255, 1, 128]));
  chmodSync(join(source, 'functions', 'docs.func', 'index.js'), 0o755);
});
afterEach(() => { reads.afterRead = null; reads.bytes = 0; rmSync(home, { recursive: true, force: true }); });

describe('confined Vercel output materialization', () => {
  it('expands deduplicated function and file aliases to independent binary-safe regular copies', () => {
    symlinkSync('docs.func', join(source, 'functions', 'index.func'));
    symlinkSync('index.func/index.js', join(source, 'functions', 'shared.js'));
    materializeWebsiteOutput(source, target);
    const copied = join(target, 'functions', 'index.func', 'index.js');
    expect(readFileSync(copied)).toEqual(Buffer.from([0, 255, 1, 128]));
    expect(lstatSync(copied).mode & 0o777).toBe(0o755);
    expect(lstatSync(copied).ino).not.toBe(lstatSync(join(target, 'functions', 'docs.func', 'index.js')).ino);
    expect(lstatSync(join(target, 'functions', 'index.func')).isSymbolicLink()).toBe(false);
    expect(inventoryWebsiteOutput(target).entries.some(entry => entry.path === 'functions/shared.js')).toBe(true);
    writeFileSync(join(source, 'functions', 'docs.func', 'index.js'), 'changed');
    expect(readFileSync(copied)).toEqual(Buffer.from([0, 255, 1, 128]));
  });
  it.each([
    ['absolute', '/etc/passwd'], ['outside', '../outside'], ['missing', 'absent'], ['self', 'alias'], ['ancestor', '.'],
  ])('rejects %s aliases without creating upload output', (_name, link) => {
    symlinkSync(link, join(source, 'alias'));
    expect(() => materializeWebsiteOutput(source, target)).toThrow();
    expect(() => lstatSync(target)).toThrow();
  });
  it('rejects an intermediate external path even when .. would lexically hide it', () => {
    symlinkSync('../outside', join(source, 'outside'));
    symlinkSync('outside/../config.json', join(source, 'alias'));
    expect(() => materializeWebsiteOutput(source, target)).toThrow();
    expect(() => lstatSync(target)).toThrow();
  });
  it('rejects mutually recursive aliases and aliases from a child to its ancestor', () => {
    symlinkSync('b', join(source, 'a')); symlinkSync('a', join(source, 'b'));
    expect(() => materializeWebsiteOutput(source, target)).toThrow();
    rmSync(join(source, 'a')); rmSync(join(source, 'b'));
    symlinkSync('..', join(source, 'functions', 'parent'));
    expect(() => materializeWebsiteOutput(source, target)).toThrow();
  });
  it('rejects hard links', () => {
    linkSync(join(source, 'config.json'), join(source, 'second-config.json'));
    expect(() => materializeWebsiteOutput(source, target)).toThrow();
  });
  it.skipIf(process.platform === 'win32')('rejects named pipes without opening or blocking on them', () => {
    execFileSync('mkfifo', [join(source, 'pipe')]);
    expect(() => materializeWebsiteOutput(source, target)).toThrow();
  });
  it('never overwrites or removes an existing destination', () => {
    mkdirSync(target); writeFileSync(join(target, 'keep'), 'existing');
    expect(() => materializeWebsiteOutput(source, target)).toThrow();
    expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('existing');
  });
  it('bounds reads to the captured size and removes partial output if a source grows during copying', () => {
    reads.bytes = 0;
    reads.afterRead = () => {
      reads.afterRead = null; writeFileSync(join(source, 'config.json'), 'x'.repeat(1024 * 1024));
    };
    expect(() => materializeWebsiteOutput(source, target)).toThrow('changed during materialization');
    expect(reads.bytes).toBeLessThanOrEqual(Buffer.byteLength('{"version":3}') + 1);
    expect(() => lstatSync(target)).toThrow();
  });
  it('rejects output beyond the expanded byte limit without reading its sparse file', () => {
    const large = join(source, 'large'); writeFileSync(large, ''); truncateSync(large, 5 * 1024 ** 3 + 1);
    reads.bytes = 0;
    expect(() => materializeWebsiteOutput(source, target)).toThrow('exceeds materialization limits');
    expect(reads.bytes).toBe(0); expect(() => lstatSync(target)).toThrow();
  });
  it('rejects root links and overlapping source/destination trees', () => {
    symlinkSync(source, join(home, 'raw-link'));
    expect(() => materializeWebsiteOutput(join(home, 'raw-link'), target)).toThrow();
    expect(() => materializeWebsiteOutput(source, join(source, 'nested'))).toThrow();
    expect(() => materializeWebsiteOutput(source, home)).toThrow();
  });
});
