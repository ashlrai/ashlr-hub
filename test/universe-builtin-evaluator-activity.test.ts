import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_BUILTIN_ACTIVITIES, createBuiltinActivityTracker, initializeBuiltinActivity, inspectBuiltinActivity, type BuiltinActivityOwner } from '../scripts/evaluators/preparation-verification-activity.mjs';

const roots: string[] = [];
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'builtin-activity-'))); roots.push(root);
  const owner: BuiltinActivityOwner = { schemaVersion: 1, invocationId: 'a'.repeat(64), implementationDigest: 'b'.repeat(64),
    deadlineAt: new Date(Date.now() + 60000).toISOString() };
  initializeBuiltinActivity(root, owner);
  return { root, owner };
}
function snapshot(root: string): string {
  return JSON.stringify(fs.readdirSync(root).sort().map(name => {
    const path = join(root, name), stat = fs.lstatSync(path, { bigint: true });
    return { name, ino: String(stat.ino), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs), text: fs.readFileSync(path, 'utf8') };
  }));
}
function absent(): void { vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('absent'), { code: 'ESRCH' }); }); }
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('built-in evaluator durable process activity', () => {
  it.each([4096, 8191])('allows a new activity after %i occupied slots under the fixed aggregate limit', occupied => {
    expect(MAX_BUILTIN_ACTIVITIES).toBe(8192);
    const f = fixture(), tracker = createBuiltinActivityTracker(f.root);
    // Simulate occupancy only: exercising thousands of immutable publications
    // would turn this boundary check into a quadratic filesystem workload.
    const size = vi.spyOn(Map.prototype, 'size', 'get').mockReturnValue(occupied);
    try { tracker.lifecycle('tool').prepare(); } finally { size.mockRestore(); }
    const row = JSON.parse(fs.readFileSync(join(f.root, `prepared-${occupied + 1}.json`), 'utf8')) as { id: number };
    expect(row.id).toBe(occupied + 1);
    expect(inspectBuiltinActivity(f.root, f.owner)).toBe(false);
  });
  it('refuses activity 8193 before publication and preserves the poisoned refusal', () => {
    const f = fixture(), tracker = createBuiltinActivityTracker(f.root), before = snapshot(f.root);
    const size = vi.spyOn(Map.prototype, 'size', 'get').mockReturnValue(MAX_BUILTIN_ACTIVITIES);
    let failure: unknown;
    try { tracker.lifecycle('candidate').prepare(); } catch (error) { failure = error; } finally { size.mockRestore(); }
    expect(failure).toBeInstanceOf(Error);
    expect(snapshot(f.root)).toBe(before);
    expect(() => tracker.lifecycle('tool').prepare()).toThrow();
    expect(() => tracker.complete()).toThrow();
  });
  it.each([8192, 8193])('never accepts a forged completion count of %i without exact activity records', count => {
    const f = fixture(), tracker = createBuiltinActivityTracker(f.root);
    tracker.complete();
    const path = join(f.root, 'complete.json');
    const complete = JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(path, JSON.stringify({ ...complete, count }));
    const before = snapshot(f.root);
    expect(inspectBuiltinActivity(f.root, f.owner)).toBe(false);
    // Neither an in-range count nor an overflow replaces settlement evidence.
    expect(snapshot(f.root)).toBe(before);
  });
  it('initializes once without replacing or adopting existing state', () => {
    const f = fixture(), before = snapshot(f.root);
    expect(() => initializeBuiltinActivity(f.root, f.owner)).toThrow(); expect(snapshot(f.root)).toBe(before);
    expect(() => initializeBuiltinActivity(f.root, { ...f.owner, invocationId: 'invalid' })).toThrow();
    expect(snapshot(f.root)).toBe(before);
  });
  it('publishes prepare before spawn and confirms all groups independently without writes', () => {
    const f = fixture(), tracker = createBuiltinActivityTracker(f.root);
    const candidate = tracker.lifecycle('candidate').prepare();
    expect(fs.existsSync(join(f.root, 'prepared-1.json'))).toBe(true);
    expect(inspectBuiltinActivity(f.root, f.owner)).toBe(false);
    candidate.spawned(123456); candidate.settled('group-exit-confirmed');
    const tool = tracker.lifecycle('tool').prepare(); tool.spawned(123457); tool.settled('group-exit-confirmed'); tracker.complete();
    const before = snapshot(f.root); absent();
    expect(inspectBuiltinActivity(f.root, f.owner)).toBe(true);
    expect(process.kill).toHaveBeenCalledWith(-123456, 0); expect(process.kill).toHaveBeenCalledWith(-123457, 0);
    expect(snapshot(f.root)).toBe(before);
  });
  it('accepts confirmed not-started reservations without checking arbitrary PIDs', () => {
    const f = fixture(), tracker = createBuiltinActivityTracker(f.root), kill = vi.spyOn(process, 'kill');
    tracker.lifecycle('candidate').prepare().settled('not-started'); tracker.complete();
    expect(inspectBuiltinActivity(f.root, f.owner)).toBe(true); expect(kill).not.toHaveBeenCalled();
  });
  it.each(['present', 'denied'] as const)('holds claimed cleanup when a registered group is %s', mode => {
    const f = fixture(), tracker = createBuiltinActivityTracker(f.root), process = tracker.lifecycle('candidate').prepare();
    process.spawned(123456); process.settled('group-exit-confirmed'); tracker.complete();
    vi.spyOn(globalThis.process, 'kill').mockImplementation(() => {
      if (mode === 'denied') throw Object.assign(new Error('denied'), { code: 'EPERM' }); return true;
    });
    expect(inspectBuiltinActivity(f.root, f.owner)).toBe(false);
  });
  it.each(['prepared', 'spawned'] as const)('never completes or adopts %s activity after interruption', phase => {
    const f = fixture(), tracker = createBuiltinActivityTracker(f.root), activity = tracker.lifecycle('tool').prepare();
    if (phase === 'spawned') activity.spawned(123456);
    const before = snapshot(f.root); expect(() => tracker.complete()).toThrow();
    expect(() => createBuiltinActivityTracker(f.root)).toThrow();
    expect(inspectBuiltinActivity(f.root, f.owner)).toBe(false); expect(snapshot(f.root)).toBe(before);
  });
  it('requires exact owner attribution and immutable owner file throughout', () => {
    const f = fixture(), tracker = createBuiltinActivityTracker(f.root);
    expect(tracker.owner).not.toBe(f.owner); expect(Object.isFrozen(tracker.owner)).toBe(true);
    fs.writeFileSync(join(f.root, 'owner.json'), JSON.stringify({ ...f.owner, implementationDigest: 'c'.repeat(64) }));
    expect(() => tracker.lifecycle('tool').prepare()).toThrow();
    expect(inspectBuiltinActivity(f.root, f.owner)).toBe(false);
  });
  it('refuses new launches after the fixed deadline but allows recording completed facts', () => {
    const f = fixture(), tracker = createBuiltinActivityTracker(f.root), activity = tracker.lifecycle('tool').prepare();
    activity.spawned(123456);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.owner.deadlineAt) + 1);
    activity.settled('group-exit-confirmed'); tracker.complete(); absent();
    expect(inspectBuiltinActivity(f.root, f.owner)).toBe(true);
    const g = fixture(); fs.writeFileSync(join(g.root, 'owner.json'), JSON.stringify({ ...g.owner, deadlineAt: f.owner.deadlineAt }));
    expect(() => createBuiltinActivityTracker(g.root).lifecycle('tool').prepare()).toThrow();
  });
  it.each(['extra', 'stage', 'missing', 'wrong-owner', 'wrong-phase', 'symlink', 'missing-complete'] as const)('refuses %s records', kind => {
    const f = fixture(), tracker = createBuiltinActivityTracker(f.root);
    tracker.lifecycle('tool').prepare().settled('not-started'); tracker.complete();
    const path = join(f.root, 'settled-1.json');
    if (kind === 'extra' || kind === 'stage') fs.writeFileSync(join(f.root, kind === 'stage' ? 'prepared-2.json.stage' : 'extra.json'), '{}', { mode: 0o600 });
    if (kind === 'missing') fs.unlinkSync(path);
    if (kind === 'missing-complete') fs.unlinkSync(join(f.root, 'complete.json'));
    if (kind === 'wrong-owner' || kind === 'wrong-phase') {
      const row = JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, unknown>;
      row[kind === 'wrong-owner' ? 'ownerDigest' : 'phase'] = kind === 'wrong-owner' ? 'f'.repeat(64) : 'prepared';
      fs.writeFileSync(path, JSON.stringify(row));
    }
    if (kind === 'symlink') { fs.unlinkSync(path); fs.symlinkSync(join(f.root, 'prepared-1.json'), path); }
    expect(inspectBuiltinActivity(f.root, f.owner)).toBe(false);
  });
  it('poisons duplicate or contradictory lifecycle callbacks', () => {
    const f = fixture(), tracker = createBuiltinActivityTracker(f.root), activity = tracker.lifecycle('candidate').prepare();
    activity.spawned(123456); expect(() => activity.settled('not-started')).toThrow();
    expect(() => activity.settled('group-exit-confirmed')).toThrow(); expect(() => tracker.complete()).toThrow();
    expect(inspectBuiltinActivity(f.root, f.owner)).toBe(false);
  });
  it('vetoes another launch when unexpected files appear in the owned journal', () => {
    const f = fixture(), tracker = createBuiltinActivityTracker(f.root);
    fs.writeFileSync(join(f.root, 'unowned.json'), '{}', { mode: 0o600 });
    expect(() => tracker.lifecycle('candidate').prepare()).toThrow();
    expect(fs.existsSync(join(f.root, 'prepared-1.json'))).toBe(false);
  });
  it('refuses journal mutation during the independent kernel absence check', () => {
    const f = fixture(), tracker = createBuiltinActivityTracker(f.root), activity = tracker.lifecycle('tool').prepare();
    activity.spawned(123456); activity.settled('group-exit-confirmed'); tracker.complete();
    vi.spyOn(process, 'kill').mockImplementation(() => {
      fs.appendFileSync(join(f.root, 'settled-1.json'), ' '); throw Object.assign(new Error('absent'), { code: 'ESRCH' });
    });
    expect(inspectBuiltinActivity(f.root, f.owner)).toBe(false);
  });
});
