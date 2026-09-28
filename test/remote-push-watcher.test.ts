import { describe, expect, it } from 'vitest';
import { NEEDS_YOU_SOURCES, type NeedsYouSource } from '../src/core/verse/workbench-types.js';
import { createRemotePushWatcher } from '../src/core/web/remote-push-watcher.js';

function fixture() {
  let response: unknown;
  const seen: Array<string | null> = [];
  const sent: string[] = [];
  const sources = Object.fromEntries(NEEDS_YOU_SOURCES.map((source) => [source, 'ok']));
  const row = (cursor: string, ids: string[] = [], completions: object[] = [], changes: Record<string, string> = {}) => ({
    cursor,
    needsYou: ids.map((id) => ({ id, source: 'fleet' as NeedsYouSource })),
    completions,
    sources: { ...sources, ...changes },
  });
  const watcher = createRemotePushWatcher({
    read: async (since) => { seen.push(since); return response; },
    send: async (kind) => { sent.push(kind); },
  });
  return { watcher, row, seen, sent, set: (next: unknown) => { response = next; } };
}

describe('remote push activity watcher', () => {
  it('baselines history, then sends one content-free category for new work and completion', async () => {
    const f = fixture();
    f.set(f.row('c1', ['old'], [{ sessionId: 'history', at: new Date().toISOString(), outcome: 'ok' }]));
    expect(await f.watcher.pollOnce()).toBe(true);
    expect(f.sent).toEqual([]);
    f.set(f.row('c2', ['old', 'new'], [{ sessionId: 'finished', at: new Date().toISOString(), outcome: 'ok' }]));
    expect(await f.watcher.pollOnce()).toBe(true);
    expect(f.sent).toEqual(['needs-you', 'completed']);
    expect(f.seen).toEqual([null, 'c1']);
    f.set(f.row('c3', ['old', 'new']));
    await f.watcher.pollOnce();
    expect(f.sent).toHaveLength(2);
  });

  it('does not turn malformed or unavailable source data into an all-clear or a false recovery alert', async () => {
    const f = fixture();
    f.set(f.row('c1', ['old']));
    await f.watcher.pollOnce();
    f.set({ ...f.row('c2'), sources: null });
    expect(await f.watcher.pollOnce()).toBe(false);
    f.set(f.row('c2', [], [], { fleet: 'error' }));
    await f.watcher.pollOnce();
    f.set(f.row('c3', ['old', 'new']));
    await f.watcher.pollOnce();
    expect(f.sent).toEqual([]);
    f.set(f.row('c4', ['old', 'new', 'newer']));
    await f.watcher.pollOnce();
    expect(f.sent).toEqual(['needs-you']);
    expect(f.seen).toEqual([null, 'c1', 'c1', 'c2', 'c3']);
  });
});
