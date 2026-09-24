/**
 * useActivity — the shell's cursor loop (unit C1): the first poll is not
 * news, completions arrive once, a missing route is `unavailable` (badges
 * draw nothing), and a failed poll keeps the last good data as `stale`
 * instead of flashing to a false zero.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../data/client.js';
import { activity } from './shell-fixtures.test-support.js';
import { getActivityState, onActivityCompletions, refreshActivity, resetActivityForTest } from './useActivity.js';

afterEach(() => resetActivityForTest());

describe('the activity loop', () => {
  it('sends the cursor back and hands out each completion batch once', async () => {
    const paths: string[] = [];
    let n = 0;
    resetActivityForTest(async (path) => {
      paths.push(path);
      n += 1;
      return activity({
        cursor: `v1.aaaaaaaa.t.${n}`,
        completions: n === 1 ? [{ sessionId: 'old', title: 'History', outcome: 'ok', at: 'x', durationMs: null }] : n === 2 ? [{ sessionId: 's', title: 'New', outcome: 'failed', at: 'x', durationMs: null }] : [],
      });
    });
    const batches: string[][] = [];
    onActivityCompletions((batch) => batches.push(batch.map((c) => c.title)));
    await refreshActivity();
    await refreshActivity();
    await refreshActivity();
    expect(paths).toEqual(['/api/verse/activity', '/api/verse/activity?since=v1.aaaaaaaa.t.1', '/api/verse/activity?since=v1.aaaaaaaa.t.2']);
    // The first poll's completions are history, not news.
    expect(batches).toEqual([['New']]);
    expect(getActivityState().status).toBe('ready');
  });

  it('reports a missing route as unavailable, and a failed poll as stale', async () => {
    resetActivityForTest(async () => {
      throw new ApiError('nf', 404, '/api/verse/activity');
    });
    await refreshActivity();
    expect(getActivityState()).toMatchObject({ status: 'unavailable', data: null });

    let fail = false;
    resetActivityForTest(async () => {
      if (fail) throw new ApiError('boom', 500, '/api/verse/activity');
      return activity();
    });
    await refreshActivity();
    fail = true;
    await refreshActivity();
    expect(getActivityState().status).toBe('stale');
    expect(getActivityState().data?.counts.needsYou).toBe(0);
  });

  it('starts over when the server refuses an old cursor', async () => {
    const paths: string[] = [];
    let n = 0;
    resetActivityForTest(async (path) => {
      paths.push(path);
      n += 1;
      if (n === 2) throw new ApiError('bad cursor', 400, path);
      return activity({ cursor: 'v1.bbbbbbbb.t.9' });
    });
    await refreshActivity();
    await refreshActivity();
    await refreshActivity();
    expect(paths[2]).toBe('/api/verse/activity');
    vi.restoreAllMocks();
  });
});
