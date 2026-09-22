/** Current-limitation reproduction with synthetic kernel identities only.
 * Real tracker/private records; no process is spawned or signalled. A future
 * reuse fix must prove distinct ownership, not accept a live numeric PGID. */
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuiltinActivityTracker, initializeBuiltinActivity, inspectBuiltinActivity,
  type BuiltinActivityOwner } from '../scripts/evaluators/preparation-verification-activity.mjs';

const roots: string[] = [];
const PGID = 42420;
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'builtin-pgid-reuse-'))); roots.push(root);
  const owner: BuiltinActivityOwner = { schemaVersion: 1, invocationId: 'a'.repeat(64),
    implementationDigest: 'b'.repeat(64), deadlineAt: new Date(Date.now() + 60_000).toISOString() };
  initializeBuiltinActivity(root, owner);
  const tracker = createBuiltinActivityTracker(root), activity = tracker.lifecycle('tool').prepare();
  activity.spawned(PGID);
  return { root, owner, tracker, activity };
}
function snapshot(root: string): string {
  return JSON.stringify(readdirSync(root).sort().map(name => {
    const path = join(root, name), stat = lstatSync(path, { bigint: true });
    return { name, ino: String(stat.ino), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
      text: readFileSync(path, 'utf8') };
  }));
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('historical builtin activity PGID reuse: current conservative limitation', () => {
  it('rejects an unchanged settled journal when an unrelated synthetic group reuses its historical PGID', () => {
    const f = fixture();
    // These identities exist only in the synthetic kernel model. Production
    // records carry a numeric PGID, so the inspector cannot distinguish them.
    const original = { pgid: PGID, identity: 'owned-tool-before-exit' };
    const unrelated = { pgid: PGID, identity: 'unrelated-group-after-reuse' };
    let current: typeof original | null = original;
    const probe = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      expect(pid).toBe(-PGID); expect(signal).toBe(0);
      if (current) return true;
      throw Object.assign(new Error('Synthetic group absent'), { code: 'ESRCH' });
    });
    current = null;
    // Simulate the trusted runner's definite absence observation before it
    // publishes the real tracker settlement and aggregate completion records.
    expect(() => process.kill(-PGID, 0)).toThrow();
    f.activity.settled('group-exit-confirmed'); f.tracker.complete();
    const before = snapshot(f.root);
    probe.mockClear();
    expect(inspectBuiltinActivity(f.root, f.owner)).toBe(true);
    expect(probe).toHaveBeenCalledExactlyOnceWith(-PGID, 0);

    current = unrelated;
    expect(current.pgid).toBe(original.pgid); expect(current.identity).not.toBe(original.identity);
    probe.mockClear();
    expect(inspectBuiltinActivity(f.root, f.owner)).toBe(false);
    expect(probe).toHaveBeenCalledExactlyOnceWith(-PGID, 0);
    expect(snapshot(f.root)).toBe(before);
  });

  it('still refuses a claimed settlement while the original synthetic group remains live', () => {
    const f = fixture();
    // Deliberately contradictory settlement tests the independent check. A
    // journal claim alone must never excuse an original group that is alive.
    f.activity.settled('group-exit-confirmed'); f.tracker.complete();
    const before = snapshot(f.root);
    const probe = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      expect(pid).toBe(-PGID); expect(signal).toBe(0); return true;
    });
    expect(inspectBuiltinActivity(f.root, f.owner)).toBe(false);
    expect(probe).toHaveBeenCalledExactlyOnceWith(-PGID, 0);
    expect(snapshot(f.root)).toBe(before);
  });
});
