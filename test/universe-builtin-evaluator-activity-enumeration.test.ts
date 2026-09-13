import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuiltinActivityTracker, initializeBuiltinActivity, inspectBuiltinActivity,
  type BuiltinActivityOwner } from '../scripts/evaluators/preparation-verification-activity.mjs';

const census = vi.hoisted(() => ({ root: '', calls: 0, entries: 0, sorts: 0, sortedEntries: 0,
  reverse: false, duplicate: false, injectAfterLink: '', injections: 0 }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, linkSync: (...args: Parameters<typeof actual.linkSync>) => {
    actual.linkSync(...args);
    if (args[1] === census.injectAfterLink) {
      census.injectAfterLink = ''; census.injections++;
      actual.writeFileSync(`${census.root}/foreign.json`, '{}', { flag: 'wx', mode: 0o600 });
    }
  }, readdirSync: (...args: unknown[]) => {
    const result: unknown = Reflect.apply(actual.readdirSync, actual, args);
    if (args[0] !== census.root || !Array.isArray(result) || !result.every(name => typeof name === 'string')) return result;
    census.calls++; census.entries += result.length;
    if (census.reverse) result.reverse();
    if (census.duplicate && result.length > 1) result[1] = result[0];
    const originalSort = result.sort;
    Object.defineProperty(result, 'sort', { configurable: true, value: function (this: string[], compare?: (a: string, b: string) => number) {
      census.sorts++; census.sortedEntries += this.length;
      return originalSort.call(this, compare);
    } });
    return result;
  } };
});

const roots: string[] = [];
const key = 'c'.repeat(64); // Synthetic invocation key, never a real account credential.
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'builtin-enumeration-'))); roots.push(root);
  const owner: BuiltinActivityOwner = { schemaVersion: 2, invocationId: 'a'.repeat(64), implementationDigest: 'b'.repeat(64),
    deadlineAt: '2099-01-01T00:00:00.000Z' };
  initializeBuiltinActivity(root, owner);
  const tracker = createBuiltinActivityTracker(root, key);
  Object.assign(census, { root, calls: 0, entries: 0, sorts: 0, sortedEntries: 0, reverse: true, duplicate: false,
    injectAfterLink: '', injections: 0 });
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('synthetic absence'), { code: 'ESRCH' }); });
  return { root, owner, tracker };
}
function settled(f: ReturnType<typeof fixture>, id: number) {
  const activity = f.tracker.lifecycle('tool').prepare(); activity.spawned(100000 + id); activity.settled('group-exit-confirmed');
}
afterEach(() => {
  census.root = ''; census.duplicate = false; census.injectAfterLink = ''; vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('builtin activity journal deterministic enumeration work', () => {
  it.each([8, 16, 32])('keeps all action-time scans but does not sort their growing listings (%i activities)', count => {
    const f = fixture();
    for (let id = 1; id <= count; id++) settled(f, id);
    f.tracker.complete();
    // Counts exclude initialization and final inspection. This intentionally
    // preserves scans: it is a guard-sort optimization, NOT a linear-I/O claim.
    expect(census.calls).toBe(7 * count + 3);
    expect(census.entries).toBe((21 * count * count + 29 * count) / 2 + 4);
    expect({ sorts: census.sorts, sortedEntries: census.sortedEntries }).toEqual({ sorts: 0, sortedEntries: 0 });
    expect(process.kill).toHaveBeenCalledTimes(count);
    expect(inspectBuiltinActivity(f.root, f.owner, key)).toBe(true);
    // Final exact-inventory checks still sort; authenticated transcript order
    // must remain independent of the filesystem's reversed enumeration order.
    expect(census.sorts).toBe(2);
    expect(process.kill).toHaveBeenCalledTimes(count);
  });

  it.each(['prepare', 'spawn', 'settle'] as const)('refuses missing-plus-foreign substitution before %s publication', boundary => {
    const f = fixture(); settled(f, 1);
    const activity = boundary === 'prepare' ? null : f.tracker.lifecycle('candidate').prepare();
    if (boundary === 'settle') activity!.spawned(100002);
    fs.renameSync(join(f.root, 'settled-1.json'), join(f.root, 'foreign.json'));
    const expectedAbsent = boundary === 'prepare' ? 'prepared-2.json' : boundary === 'spawn' ? 'spawned-2.json' : 'settled-2.json';
    expect(() => boundary === 'prepare' ? f.tracker.lifecycle('candidate').prepare()
      : boundary === 'spawn' ? activity!.spawned(100002) : activity!.settled('group-exit-confirmed')).toThrow();
    expect(fs.existsSync(join(f.root, expectedAbsent))).toBe(false);
    fs.renameSync(join(f.root, 'foreign.json'), join(f.root, 'settled-1.json'));
    expect(() => f.tracker.lifecycle('tool').prepare()).toThrow();
    expect(() => f.tracker.complete()).toThrow();
    expect(inspectBuiltinActivity(f.root, f.owner, key)).toBe(false);
  });

  it.each(['duplicate-listing', 'extra-file', 'stage-file'] as const)('never replaces exact membership with cardinality-only or subset checks: %s', attack => {
    const f = fixture(); settled(f, 1);
    if (attack === 'duplicate-listing') census.duplicate = true;
    else fs.writeFileSync(join(f.root, attack === 'stage-file' ? 'prepared-2.json.stage' : 'foreign.json'), '{}', { mode: 0o600 });
    expect(() => f.tracker.lifecycle('candidate').prepare()).toThrow();
    expect(fs.existsSync(join(f.root, 'prepared-2.json'))).toBe(false);
    expect(() => f.tracker.complete()).toThrow();
  });

  it('poisons after a foreign file arrives during real publication, retaining the published fact', () => {
    const f = fixture(); settled(f, 1);
    census.injectAfterLink = join(f.root, 'prepared-2.json');
    expect(() => f.tracker.lifecycle('candidate').prepare()).toThrow();
    expect(census.injections).toBe(1);
    // The native link already succeeded; refusal must not erase that evidence
    // or pretend the activity was never prepared. No child is actually spawned.
    const published = fs.readFileSync(join(f.root, 'prepared-2.json'), 'utf8');
    expect(JSON.parse(published)).toMatchObject({ id: 2, kind: 'candidate', phase: 'prepared' });
    expect(fs.existsSync(join(f.root, 'foreign.json'))).toBe(true);
    expect(fs.existsSync(join(f.root, 'spawned-2.json'))).toBe(false);
    fs.unlinkSync(join(f.root, 'foreign.json'));
    expect(() => f.tracker.lifecycle('tool').prepare()).toThrow();
    expect(() => f.tracker.complete()).toThrow();
    expect(fs.readFileSync(join(f.root, 'prepared-2.json'), 'utf8')).toBe(published);
    expect(inspectBuiltinActivity(f.root, f.owner, key)).toBe(false);
  });

  it('still rejects changed authenticated record bytes and wrong invocation keys after completion', () => {
    const f = fixture(); settled(f, 1); f.tracker.complete();
    expect(inspectBuiltinActivity(f.root, f.owner, 'd'.repeat(64))).toBe(false);
    const file = join(f.root, 'spawned-1.json');
    const row = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...row, pgid: 100009 }));
    expect(inspectBuiltinActivity(f.root, f.owner, key)).toBe(false);
  });
});
