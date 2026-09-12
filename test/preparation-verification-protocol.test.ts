/** Mailbox data and fixture-owned filesystem boundaries only. No candidate code or subprocesses. */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface Protocol {
  MAX_MESSAGE_BYTES: number;
  MAX_CALLS: number;
  exact(value: unknown, keys: string[]): boolean;
  publishMessage(file: string, value: unknown): void;
  readMessage(file: string): unknown;
}
let protocol: Protocol;
let root: string;
let mailbox: string;
let file: string;
beforeAll(async () => {
  protocol = await import(new URL('../scripts/evaluators/preparation-verification-protocol.mjs', import.meta.url).href) as Protocol;
});
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'preparation-mailbox-test-')));
  mailbox = join(root, 'mailbox'); fs.mkdirSync(mailbox, { mode: 0o700 });
  file = join(mailbox, 'message.json');
});
afterEach(() => {
  vi.restoreAllMocks(); syncBuiltinESMExports();
  fs.rmSync(root, { recursive: true, force: true });
});
const raw = (value: string | Buffer): void => { fs.writeFileSync(file, value, { mode: 0o600 }); };
const inventory = (): string[] => fs.readdirSync(mailbox).sort();

describe.runIf(process.platform !== 'win32')('private preparation verification mailbox protocol', () => {
  it('round-trips bounded own data with private permissions and no leftover stage', () => {
    const value = { schemaVersion: 1, id: 1, value: { text: 'fixture', list: [null, true, 0, -2.5], empty: {} } };
    protocol.publishMessage(file, value);
    expect(protocol.readMessage(file)).toEqual(value);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(file).nlink).toBe(1);
    expect(inventory()).toEqual(['message.json']);
  });

  it('accepts null-prototype own data without requiring executable conversion', () => {
    const value: Record<string, unknown> = Object.create(null); value.value = 'plain';
    protocol.publishMessage(file, value);
    expect(protocol.readMessage(file)).toEqual({ value: 'plain' });
  });

  it('returns missing without creating a file or changing the directory', () => {
    const before = fs.statSync(mailbox, { bigint: true });
    expect(protocol.readMessage(file)).toBeNull();
    expect(inventory()).toEqual([]);
    const after = fs.statSync(mailbox, { bigint: true });
    expect([after.ino, after.mtimeNs, after.ctimeNs]).toEqual([before.ino, before.mtimeNs, before.ctimeNs]);
  });

  it('never overwrites an already published target and removes its own failed stage', () => {
    protocol.publishMessage(file, { original: true });
    const before = fs.readFileSync(file); const inode = fs.statSync(file).ino;
    expect(() => protocol.publishMessage(file, { replacement: true })).toThrow();
    expect(fs.readFileSync(file)).toEqual(before); expect(fs.statSync(file).ino).toBe(inode);
    expect(inventory()).toEqual(['message.json']);
  });

  it('refuses oversized writes before publishing any bytes', () => {
    expect(() => protocol.publishMessage(file, { text: 'x'.repeat(protocol.MAX_MESSAGE_BYTES) })).toThrow();
    expect(inventory()).toEqual([]);
  });

  it('refuses oversized reads without altering the file', () => {
    raw(Buffer.alloc(protocol.MAX_MESSAGE_BYTES + 1, 0x20));
    expect(() => protocol.readMessage(file)).toThrow();
    expect(fs.statSync(file).size).toBe(protocol.MAX_MESSAGE_BYTES + 1);
  });

  it.each(['', '{', '{broken}', '{}\n{}', '{"value":1} trailing'])('refuses malformed or trailing JSON: %j', value => {
    raw(value); expect(() => protocol.readMessage(file)).toThrow(); expect(fs.readFileSync(file, 'utf8')).toBe(value);
  });

  it('refuses malformed UTF-8 rather than replacing bytes', () => {
    raw(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
    expect(() => protocol.readMessage(file)).toThrow();
  });

  it('refuses a target symlink for both reading and publication without touching its referent', () => {
    const referent = join(root, 'referent.json'); fs.writeFileSync(referent, '{"original":true}\n', { mode: 0o600 });
    fs.symlinkSync(referent, file);
    expect(() => protocol.readMessage(file)).toThrow();
    expect(() => protocol.publishMessage(file, { replacement: true })).toThrow();
    expect(fs.readFileSync(referent, 'utf8')).toBe('{"original":true}\n'); expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
  });

  it('refuses a symlinked parent directory', () => {
    const alias = join(root, 'alias'); fs.symlinkSync(mailbox, alias);
    expect(() => protocol.readMessage(join(alias, 'message.json'))).toThrow();
    expect(() => protocol.publishMessage(join(alias, 'message.json'), {})).toThrow();
    expect(inventory()).toEqual([]);
  });

  it.each([0o644, 0o666, 0o400])('refuses message permissions %s', mode => {
    raw('{}\n'); fs.chmodSync(file, mode);
    expect(() => protocol.readMessage(file)).toThrow();
  });

  it.each([0o755, 0o777])('refuses parent permissions %s even for missing files', mode => {
    fs.chmodSync(mailbox, mode);
    expect(() => protocol.readMessage(file)).toThrow();
    expect(() => protocol.publishMessage(file, {})).toThrow();
    expect(inventory()).toEqual([]);
  });

  it('does not consume a two-link publication window and accepts only after the extra link is removed', () => {
    raw('{"value":1}\n'); const extra = join(mailbox, 'extra'); fs.linkSync(file, extra);
    expect(protocol.readMessage(file)).toBeNull();
    fs.unlinkSync(extra); expect(protocol.readMessage(file)).toEqual({ value: 1 });
  });

  it('refuses more than two hard links', () => {
    raw('{}\n'); fs.linkSync(file, join(mailbox, 'second')); fs.linkSync(file, join(mailbox, 'third'));
    expect(() => protocol.readMessage(file)).toThrow();
    expect(fs.statSync(file).nlink).toBe(3);
  });

  it('refuses mutation after opening the message and still closes the descriptor', () => {
    raw('{"value":1}\n'); const original = fs.readSync; let descriptor: number | undefined;
    const read = vi.spyOn(fs, 'readSync').mockImplementationOnce((...args) => {
      descriptor = args[0]; const count = Reflect.apply(original, fs, args);
      fs.writeFileSync(file, '{"changed":true}\n'); return count;
    });
    syncBuiltinESMExports();
    expect(() => protocol.readMessage(file)).toThrow(); expect(read).toHaveBeenCalledOnce();
    expect(descriptor).toEqual(expect.any(Number));
    expect(() => fs.fstatSync(descriptor!)).toThrow();
  });

  it('refuses a parent directory replacement during publication', () => {
    const original = fs.writeFileSync;
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((...args) => {
      Reflect.apply(original, fs, args);
      fs.renameSync(mailbox, join(root, 'original-mailbox')); fs.mkdirSync(mailbox, { mode: 0o700 });
    });
    syncBuiltinESMExports();
    expect(() => protocol.publishMessage(file, { value: 1 })).toThrow(); expect(write).toHaveBeenCalledOnce();
    expect(fs.existsSync(file)).toBe(false); expect(inventory()).toEqual([]);
  });

  it.each([
    ['undefined', () => ({ value: undefined })], ['function', () => ({ value: () => null })],
    ['symbol value', () => ({ value: Symbol('fixture') })], ['symbol key', () => ({ [Symbol('fixture')]: 1 })],
    ['bigint', () => ({ value: 1n })], ['NaN', () => ({ value: NaN })],
    ['infinity', () => ({ value: Infinity })], ['negative infinity', () => ({ value: -Infinity })],
    ['foreign prototype', () => Object.assign(Object.create({ inherited: true }), { value: 1 })],
    ['Date', () => ({ value: new Date(0) })], ['sparse array', () => ({ value: new Array(2) })],
    ['extra array key', () => ({ value: Object.assign([1], { extra: true }) })],
    ['non-enumerable key', () => Object.defineProperty({}, 'value', { value: 1 })],
    ['cycle', () => { const value: { self?: unknown } = {}; value.self = value; return value; }],
  ] as const)('refuses invalid data before serialization: %s', (_name, make) => {
    expect(() => protocol.publishMessage(file, make())).toThrow(); expect(inventory()).toEqual([]);
  });

  it('rejects accessors and toJSON without invoking either', () => {
    const getter = vi.fn(() => 'not data'); const toJSON = vi.fn(() => ({ valid: true }));
    expect(() => protocol.publishMessage(file, Object.defineProperty({}, 'value', { enumerable: true, get: getter }))).toThrow();
    expect(() => protocol.publishMessage(file, { toJSON })).toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(toJSON).not.toHaveBeenCalled(); expect(inventory()).toEqual([]);
  });

  it('bounds recursive data depth while permitting repeated noncyclic values', () => {
    let nested: unknown = {}; for (let index = 0; index < 51; index++) nested = { value: nested };
    expect(() => protocol.publishMessage(file, nested)).toThrow();
    const shared = { value: 1 }; protocol.publishMessage(file, { first: shared, second: shared });
    expect(protocol.readMessage(file)).toEqual({ first: { value: 1 }, second: { value: 1 } });
  });

  it('checks exact own-data envelope keys without evaluating an accessor', () => {
    const getter = vi.fn();
    expect(protocol.exact({ id: 1 }, ['id'])).toBe(true);
    expect(protocol.exact({ id: 1, extra: true }, ['id'])).toBe(false);
    expect(protocol.exact(Object.create({ id: 1 }), ['id'])).toBe(false);
    expect(protocol.exact(Object.defineProperty({}, 'id', { get: getter }), ['id'])).toBe(false);
    expect(protocol.exact(null, ['id'])).toBe(false); expect(protocol.exact([], [])).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });
});
