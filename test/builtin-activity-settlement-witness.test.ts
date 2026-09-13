/** Real private journals; synthetic reuse cases plus actual owned subprocesses. */
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeBuiltinActivity, createBuiltinActivityTracker, inspectBuiltinActivity, openBuiltinActivityTracker,
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
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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

describe('private evaluator input channel', () => {
  it('accepts exactly 64 lowercase hex bytes across chunks and removes listeners', async () => {
    const f = fixture(), input = new PassThrough(), stop = new AbortController();
    const pending = openBuiltinActivityTracker(f.root, stop.signal, input);
    input.write(f.key.slice(0, 17)); input.end(f.key.slice(17));
    const tracker = await pending; tracker.complete();
    expect(inspectBuiltinActivity(f.root, f.owner, f.key)).toBe(true);
    for (const event of ['data', 'end', 'error', 'close']) expect(input.listenerCount(event)).toBe(0);
  });
  it.each(['short', 'long', 'uppercase', 'high-bit', 'newline', 'empty'])('rejects %s input without recording activity or leaking bytes', async kind => {
    const f = fixture(), input = new PassThrough();
    const pending = openBuiltinActivityTracker(f.root, undefined, input);
    const failure = expect(pending).rejects.toThrow('BUILTIN_ACTIVITY_INPUT_UNAVAILABLE');
    const bytes = kind === 'short' ? f.key.slice(0, 63) : kind === 'long' ? f.key + '0' : kind === 'uppercase' ? 'A'.repeat(64) :
      kind === 'high-bit' ? Buffer.alloc(64, 0xe1) : kind === 'newline' ? f.key + '\n' : '';
    input.end(bytes); await failure;
    expect(readdirSync(f.root)).toEqual(['owner.json']);
  });
  it.each(['cancel', 'timeout', 'error', 'close'])('bounds stalled input on %s', async kind => {
    vi.useFakeTimers();
    const f = fixture(), input = new PassThrough(), stop = new AbortController();
    const pending = openBuiltinActivityTracker(f.root, stop.signal, input);
    const failure = expect(pending).rejects.toThrow('BUILTIN_ACTIVITY_INPUT_UNAVAILABLE');
    input.write(f.key); // A complete key without EOF is not a complete frame.
    if (kind === 'cancel') stop.abort();
    if (kind === 'timeout') await vi.advanceTimersByTimeAsync(5000);
    if (kind === 'error') input.emit('error', new Error('PRIVATE_TRANSPORT_DETAIL'));
    if (kind === 'close') input.emit('close');
    await failure; expect(readdirSync(f.root)).toEqual(['owner.json']);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('refuses an owner swapped while waiting for the private key', async () => {
    const f = fixture(), input = new PassThrough(), pending = openBuiltinActivityTracker(f.root, undefined, input);
    writeFileSync(join(f.root, 'owner.json'), JSON.stringify({ ...f.owner, invocationId: 'c'.repeat(64) }));
    input.end(f.key); await expect(pending).rejects.toThrow('BUILTIN_ACTIVITY_UNAVAILABLE');
  });
  it('does not consume stdin for a legacy owner', async () => {
    const f = fixture(), input = new PassThrough();
    const legacy = { ...f.owner, schemaVersion: 1 as const };
    writeFileSync(join(f.root, 'owner.json'), JSON.stringify(legacy));
    const tracker = await openBuiltinActivityTracker(f.root, undefined, input);
    tracker.complete(); expect(inspectBuiltinActivity(f.root, legacy)).toBe(true);
    expect(input.listenerCount('data')).toBe(0); expect(input.readableFlowing).toBe(null);
  });
  it('transfers a real invocation key over stdin without argv, environment or output exposure', async () => {
    const f = fixture();
    const module = new URL('../scripts/evaluators/preparation-verification-activity.mjs', import.meta.url).href;
    const script = `import {openBuiltinActivityTracker} from ${JSON.stringify(module)};
      const tracker = await openBuiltinActivityTracker(process.argv[1]); tracker.complete();
      process.stdout.write(JSON.stringify({env:process.env, argv:process.argv, owner:tracker.owner}));`;
    const result = await runVerifySubprocessAsync([process.execPath, '--input-type=module', '-e', script, f.root], {
      cwd: f.root, env: {}, input: f.key, timeoutMs: 10_000, requireProcessGroupExit: true,
    });
    if (result.processGroupSettlement === 'unconfirmed') roots.splice(roots.indexOf(f.root), 1);
    expect(result).toMatchObject({ exitCode: 0, stderr: '', processGroupSettlement: 'group-exit-confirmed' });
    expect(JSON.stringify(result)).not.toContain(f.key);
    expect(inspectBuiltinActivity(f.root, f.owner, f.key)).toBe(true);
  }, 15000);
});
