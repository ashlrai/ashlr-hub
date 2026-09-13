/** Real private journals; synthetic reuse cases plus an actual owned subprocess.
 * This primitive is not yet enabled by the installed evaluator launcher. */
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeBuiltinActivity, createBuiltinActivityTracker, inspectBuiltinActivity,
  type BuiltinActivityOwner } from '../scripts/evaluators/preparation-verification-activity.mjs';
import { runVerifySubprocessAsync } from '../src/core/run/verify-commands.js';

const roots: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'builtin-witness-'))); roots.push(root);
  const owner: BuiltinActivityOwner = { schemaVersion: 2, invocationId: randomBytes(32).toString('hex'),
    implementationDigest: 'b'.repeat(64), deadlineAt: new Date(Date.now() + 30_000).toISOString() };
  const key = randomBytes(32).toString('hex');
  initializeBuiltinActivity(root, owner);
  return { root, owner, key, tracker: createBuiltinActivityTracker(root, key) };
}
function absent() { return vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
  expect(signal).toBe(0); throw Object.assign(new Error('Synthetic absence'), { code: 'ESRCH' });
}); }
function finish(f: ReturnType<typeof fixture>) {
  const activity = f.tracker.lifecycle('tool').prepare(); activity.spawned(42420);
  activity.settled('group-exit-confirmed'); f.tracker.complete();
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('invocation-authenticated settlement witness', () => {
  it('accepts previously witnessed exit despite synthetic numeric ID reuse without touching the new process', () => {
    const f = fixture(), probe = absent(); finish(f);
    expect(probe).toHaveBeenCalledExactlyOnceWith(-42420, 0);
    probe.mockClear().mockImplementation(() => { throw new Error('Must not probe a historical ID'); });
    const before = readdirSync(f.root).map(name => readFileSync(join(f.root, name), 'utf8'));
    expect(inspectBuiltinActivity(f.root, f.owner, f.key)).toBe(true);
    expect(probe).not.toHaveBeenCalled();
    expect(readdirSync(f.root).map(name => readFileSync(join(f.root, name), 'utf8'))).toEqual(before);
    expect(before.join('')).not.toContain(f.key);
  });
  it.each(['present', 'permission', 'unknown'])('does not authenticate claimed exit when the kernel observation is %s', mode => {
    const f = fixture(), activity = f.tracker.lifecycle('candidate').prepare(); activity.spawned(42420);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      if (mode === 'present') return true;
      throw Object.assign(new Error('Unavailable'), { code: mode === 'permission' ? 'EPERM' : 'EIO' });
    });
    expect(() => activity.settled('group-exit-confirmed')).toThrow();
    expect(() => f.tracker.complete()).toThrow();
    expect(inspectBuiltinActivity(f.root, f.owner, f.key)).toBe(false);
    expect(readdirSync(f.root)).not.toContain('settled-1.json');
  });
  it.each(['missing-key', 'wrong-key', 'missing-proof', 'wrong-proof', 'changed-pgid', 'changed-kind', 'wrong-owner', 'downgrade'])('refuses %s evidence', mode => {
    const f = fixture(); absent(); finish(f);
    const patch = (name: string, change: Record<string, unknown>) => {
      const path = join(f.root, name); writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), ...change }));
    };
    if (mode === 'missing-proof') {
      const path = join(f.root, 'complete.json'), value = JSON.parse(readFileSync(path, 'utf8'));
      delete value.settlementProof; writeFileSync(path, JSON.stringify(value));
    }
    if (mode === 'wrong-proof') patch('complete.json', { settlementProof: 'c'.repeat(64) });
    if (mode === 'changed-pgid') patch('spawned-1.json', { pgid: 42421 });
    if (mode === 'changed-kind') for (const phase of ['prepared', 'spawned', 'settled']) patch(`${phase}-1.json`, { kind: 'candidate' });
    if (mode === 'downgrade') patch('owner.json', { schemaVersion: 1 });
    expect(inspectBuiltinActivity(f.root, mode === 'wrong-owner' ? { ...f.owner, invocationId: 'd'.repeat(64) } : f.owner,
      mode === 'missing-key' ? undefined : mode === 'wrong-key' ? 'e'.repeat(64) : f.key)).toBe(false);
  });
  it('authenticates not-started and empty invocations without probing any process', () => {
    for (const reserve of [false, true]) {
      const f = fixture(), probe = vi.spyOn(process, 'kill');
      if (reserve) f.tracker.lifecycle('candidate').prepare().settled('not-started');
      f.tracker.complete(); expect(inspectBuiltinActivity(f.root, f.owner, f.key)).toBe(true);
      expect(probe).not.toHaveBeenCalled(); probe.mockRestore();
    }
  });
  it('refuses opening a version-two tracker without the invocation secret', () => {
    const f = fixture(); expect(() => createBuiltinActivityTracker(f.root)).toThrow();
  });
  it('authenticates interleaved lifecycle ordering and refuses modification before completion', () => {
    const f = fixture(); absent();
    const a = f.tracker.lifecycle('candidate').prepare(), b = f.tracker.lifecycle('tool').prepare();
    b.spawned(42421); a.spawned(42420); b.settled('group-exit-confirmed'); a.settled('group-exit-confirmed');
    f.tracker.complete(); expect(inspectBuiltinActivity(f.root, f.owner, f.key)).toBe(true);

    const g = fixture(), c = g.tracker.lifecycle('tool').prepare();
    c.spawned(42422); c.settled('group-exit-confirmed');
    const path = join(g.root, 'spawned-1.json');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), pgid: 42423 }));
    // The signer authenticates its private observations, not reread caller data.
    g.tracker.complete(); expect(inspectBuiltinActivity(g.root, g.owner, g.key)).toBe(false);
  });
  it.each(['prepared', 'spawned'])('cannot authenticate interrupted %s work', phase => {
    const f = fixture(), a = f.tracker.lifecycle('tool').prepare();
    if (phase === 'spawned') a.spawned(42420);
    expect(() => f.tracker.complete()).toThrow();
    expect(inspectBuiltinActivity(f.root, f.owner, f.key)).toBe(false);
  });
  it('records a real local process exit through the existing runner and verifies the retained witness', async () => {
    const f = fixture();
    const result = await runVerifySubprocessAsync([process.execPath, '-e', 'process.stdout.write("owned-fixture")'], {
      cwd: f.root, env: {}, timeoutMs: 5000, requireProcessGroupExit: true, processGroupLifecycle: f.tracker.lifecycle('tool'),
    });
    // Preserve evidence rather than deleting a fixture if owned custody is unresolved.
    if (result.processGroupSettlement === 'unconfirmed') roots.splice(roots.indexOf(f.root), 1);
    expect(result.processGroupSettlement).toBe('group-exit-confirmed');
    expect(result.exitCode).toBe(0); expect(result.stdout).toBe('owned-fixture');
    f.tracker.complete(); expect(inspectBuiltinActivity(f.root, f.owner, f.key)).toBe(true);
  }, 15000);
});
