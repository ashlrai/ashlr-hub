/**
 * 3.11 cloud lane, unit C2 — the cloud Needs-you producer (cloud-api.ts
 * `cloudNeedsYouItems` / `needsYouItems`) and its merge into the activity
 * fold (activity.ts `ActivityDeps.cloud`).
 *
 * HOME-isolated; the cloud core is module-mocked, so no task store, `gh` or
 * cloud session is touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { CloudTaskV1 } from '../src/core/cloud/types.js';
import { createActivityReader, type ActivityDeps } from '../src/core/verse/activity.js';
import { createSessionMetaStore } from '../src/core/verse/session-meta.js';
import { isNeedsYouItem, type NeedsYouItem } from '../src/core/verse/workbench-types.js';

vi.mock('../src/core/cloud/service.js', () => ({ cloudOverview: vi.fn(), launchCloudTask: vi.fn(), runSelfImprove: vi.fn() }));
vi.mock('../src/core/cloud/store.js', () => ({
  listCloudTasks: () => [],
  readCloudTask: () => null,
  writeCloudTask: vi.fn(),
  updateCloudBudget: vi.fn(),
}));
vi.mock('../src/core/cloud/tracker.js', () => ({ refreshCloudTasks: vi.fn() }));
vi.mock('../src/core/cloud/budget.js', () => ({ cloudBudgetView: vi.fn() }));

const { cloudNeedsYouItems, needsYouItems, setCloudNeedsYouReaderForTest, CLOUD_FAILED_WINDOW_MS } = await import('../src/core/cloud/cloud-api.js');

const NOW = new Date('2026-09-25T18:00:00.000Z');
let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env['HOME'];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-cloud-needs-you-'));
  process.env['HOME'] = home;
});

afterEach(() => {
  setCloudNeedsYouReaderForTest(null);
  process.env['HOME'] = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

let seq = 0;
function task(over: Partial<CloudTaskV1> = {}): CloudTaskV1 {
  seq += 1;
  const id = over.id ?? `ct_20260925T1200_${String(seq).padStart(6, '0')}`;
  return {
    v: 1,
    id,
    repo: 'ashlrai/ashlr-hub',
    baseBranch: 'main',
    branch: `ashlr-cloud/${id}`,
    title: 'Fix the flaky test',
    prompt: 'Fix the flaky test.',
    origin: 'operator',
    requestedBy: 'mason',
    seat: 'claude-a',
    sessionId: 'session_01abc',
    sessionUrl: 'https://claude.ai/code/session_01abc',
    state: 'running',
    stateReason: null,
    failure: null,
    createdAt: '2026-09-25T12:00:00.000Z',
    launchedAt: '2026-09-25T12:00:05.000Z',
    updatedAt: '2026-09-25T17:00:00.000Z',
    pr: null,
    report: null,
    estimatedCostUsd: 3,
    backlogItemId: null,
    needsYouId: null,
    ...over,
  };
}

const PR = { number: 42, url: 'https://github.com/ashlrai/ashlr-hub/pull/42', state: 'open' as const, draft: true, title: '[ashlr-cloud] Fix the flaky test' };

describe('cloudNeedsYouItems — PR ready for review', () => {
  it('files a pr-open task as a fleet owner-lane-pr item with the title, PR link and report summary', () => {
    const t = task({
      state: 'pr-open',
      pr: PR,
      report: { status: 'done', summary: 'Stabilised the retry timing; 3 tests added.', testsRun: ['npx vitest run test/x.test.ts'], risks: [] },
    });
    const [item] = cloudNeedsYouItems([t], NOW);
    expect(isNeedsYouItem(item)).toBe(true);
    expect(item).toMatchObject({
      id: `fleet:owner-lane-pr:cloud-${t.id}`,
      source: 'fleet',
      kind: 'owner-lane-pr',
      severity: 'info',
      title: 'Cloud task ready for review: Fix the flaky test',
      detail: 'Cloud session reports (unverified): Stabilised the retry timing; 3 tests added.',
      since: '2026-09-25T17:00:00.000Z',
      expiresAt: null,
      subject: { repo: 'ashlrai/ashlr-hub', pr: 42, seatId: null, sessionId: null, engine: 'claude' },
      target: { kind: 'url', url: PR.url },
    });
    expect(item!.actions).toEqual([{
      kind: 'done',
      label: 'Dismiss',
      request: { method: 'POST', path: `/api/verse/cloud/tasks/${t.id}/dismiss`, body: {} },
      confirm: { title: 'Stop tracking this cloud task?', body: 'Verse marks it closed. The pull request on GitHub is not touched.', confirmLabel: 'Dismiss' },
      destructive: false,
    }]);
  });

  it('names a non-done report status and says when there is no report', () => {
    const partial = task({ state: 'pr-open', pr: PR, report: { status: 'blocked', summary: 'Needs a secret.', testsRun: [], risks: [] } });
    const none = task({ state: 'pr-open', pr: PR });
    const [a, b] = cloudNeedsYouItems([partial, none], NOW);
    expect(a!.detail).toBe('Cloud session reports (unverified): Needs a secret. (blocked)');
    expect(b!.detail).toBe('No report yet: the pull request has no ashlr-cloud-report block.');
  });

  it('clips long titles to the contract limit and flattens control characters', () => {
    const t = task({ state: 'pr-open', pr: PR, title: `Line one\n\u001b[31m${'word '.repeat(60)}` });
    const [item] = cloudNeedsYouItems([t], NOW);
    expect(item!.title.length).toBeLessThanOrEqual(120);
    // eslint-disable-next-line no-control-regex
    expect(item!.title).not.toMatch(/[\u0000-\u001f]/);
    expect(item!.title.endsWith('…')).toBe(true);
    expect(isNeedsYouItem(item)).toBe(true);
  });

  it('scrubs secret-shaped text out of the report summary', () => {
    const t = task({ state: 'pr-open', pr: PR, report: { status: 'done', summary: 'Rotated ghp_abcdefghijklmnopqrstuvwxyz0123456789 in CI.', testsRun: [], risks: [] } });
    expect(cloudNeedsYouItems([t], NOW)[0]!.detail).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('drops a record whose PR url is not https (the drawer opens it outside the app)', () => {
    const t = task({ state: 'pr-open', pr: { ...PR, url: 'javascript:alert(1)' } });
    expect(cloudNeedsYouItems([t], NOW)).toEqual([]);
  });

  it('ignores a pr-open record with no PR', () => {
    expect(cloudNeedsYouItems([task({ state: 'pr-open', pr: null })], NOW)).toEqual([]);
  });
});

describe('cloudNeedsYouItems — failed launches', () => {
  it('files a recent failure as a chats chat-failed item with the plain reason, targeting Command', () => {
    const t = task({ state: 'failed', failure: 'auth', stateReason: 'The Claude seat is not signed in with a claude.ai account.', updatedAt: '2026-09-25T17:30:00.000Z', sessionId: null, sessionUrl: null });
    const [item] = cloudNeedsYouItems([t], NOW);
    expect(isNeedsYouItem(item)).toBe(true);
    expect(item).toMatchObject({
      id: `chats:chat-failed:cloud-${t.id}`,
      source: 'chats',
      kind: 'chat-failed',
      severity: 'warn',
      title: 'Cloud launch failed: Fix the flaky test',
      detail: 'The Claude seat is not signed in with a claude.ai account.',
      since: '2026-09-25T17:30:00.000Z',
      expiresAt: '2026-09-26T17:30:00.000Z',
      subject: { repo: 'ashlrai/ashlr-hub', pr: null, sessionId: null },
      target: { kind: 'section', section: 'command', anchor: 'cloud' },
    });
    expect(item!.actions[0]).toMatchObject({ kind: 'done', label: 'Dismiss', confirm: null });
  });

  it('has a plain fallback when the failure has no reason', () => {
    const [item] = cloudNeedsYouItems([task({ state: 'failed' })], NOW);
    expect(item!.detail).toBe('The cloud session could not be started.');
  });

  it('only shows failures from the last 24 h', () => {
    const fresh = task({ state: 'failed', updatedAt: new Date(NOW.getTime() - CLOUD_FAILED_WINDOW_MS).toISOString() });
    const old = task({ state: 'failed', updatedAt: new Date(NOW.getTime() - CLOUD_FAILED_WINDOW_MS - 1).toISOString() });
    const garbled = task({ state: 'failed', updatedAt: 'yesterday' });
    expect(cloudNeedsYouItems([fresh, old, garbled], NOW).map((i) => i.id)).toEqual([`chats:chat-failed:cloud-${fresh.id}`]);
  });
});

describe('cloudNeedsYouItems — everything else', () => {
  it.each(['queued', 'launching', 'running', 'merged', 'closed', 'expired'] as const)('files nothing for %s', (state) => {
    expect(cloudNeedsYouItems([task({ state, pr: state === 'merged' || state === 'closed' ? { ...PR, state: state } : null })], NOW)).toEqual([]);
  });
});

describe('needsYouItems (the cached producer)', () => {
  it('answers from its cache and rebuilds off the caller\'s stack', async () => {
    const read = vi.fn(() => [task({ state: 'pr-open', pr: PR })]);
    setCloudNeedsYouReaderForTest(read);
    // First call: nothing cached yet, and no I/O on this stack.
    expect(needsYouItems()).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(read).toHaveBeenCalledTimes(1);
    const items = needsYouItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('owner-lane-pr');
    // Fresh cache: repeated polls do not reread.
    needsYouItems();
    await new Promise((resolve) => setImmediate(resolve));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good answer when the store read fails', async () => {
    let fail = false;
    setCloudNeedsYouReaderForTest(() => {
      if (fail) throw new Error('EIO');
      return [task({ state: 'pr-open', pr: PR })];
    });
    needsYouItems();
    await new Promise((resolve) => setImmediate(resolve));
    expect(needsYouItems()).toHaveLength(1);
    fail = true;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 60_000);
      needsYouItems();
    } finally {
      vi.useRealTimers();
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(needsYouItems()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The merge into activity (activity.ts)
// ---------------------------------------------------------------------------

function activityDeps(cloud: ActivityDeps['cloud'], fleetItems: NeedsYouItem[] | null = []): ActivityDeps {
  return {
    engine: () => null,
    meta: createSessionMetaStore({ root: path.join(home, 'verse') }),
    producers: () => ({ authority: null, fleet: fleetItems === null ? null : () => fleetItems, leader: null }),
    approvals: () => ({ state: 'ok', items: [], total: 0 }),
    health: () => null,
    autonomy: () => null,
    latestMemoAt: null,
    cloud,
    now: () => NOW.getTime(),
  };
}

describe('activity merges the cloud producer', () => {
  it('adds cloud items to Needs-you and counts them', () => {
    const items = cloudNeedsYouItems([
      task({ state: 'pr-open', pr: PR }),
      task({ state: 'failed', stateReason: 'Out of credits.' }),
    ], NOW);
    const { response, dropped } = createActivityReader(activityDeps(() => items), 'c2c2c2c2').build(null);
    expect(response.needsYou.map((i) => i.kind).sort()).toEqual(['chat-failed', 'owner-lane-pr']);
    expect(response.counts.needsYou).toBe(2);
    expect(response.sources.fleet).toBe('ok');
    expect(dropped).toEqual({});
  });

  it('only accepts well-formed items under the fleet and chats sources', () => {
    const [good] = cloudNeedsYouItems([task({ state: 'pr-open', pr: PR })], NOW);
    const foreign = { ...good!, id: 'approvals:approval:cloud-x', source: 'approvals' as const };
    const hostile = { ...good!, id: 'fleet:owner-lane-pr:cloud-y', actions: [{ ...good!.actions[0]!, request: { method: 'POST' as const, path: 'https://evil.example/api', body: {} } }] };
    const { response, dropped } = createActivityReader(activityDeps(() => [good!, foreign, hostile]), 'c2c2c2c3').build(null);
    expect(response.needsYou.map((i) => i.id)).toEqual([good!.id]);
    expect(dropped.fleet).toBe(2);
  });

  it('a cloud producer that throws marks the sources it files under as errored, never a false all-clear', () => {
    const { response } = createActivityReader(activityDeps(() => { throw new Error('boom'); }), 'c2c2c2c4').build(null);
    expect(response.sources.fleet).toBe('error');
    expect(response.needsYou).toEqual([]);
  });

  it('does not upgrade a source that was not answering', () => {
    const { response } = createActivityReader(activityDeps(() => { throw new Error('boom'); }, null), 'c2c2c2c5').build(null);
    expect(response.sources.fleet).toBe('unavailable');
    expect(response.sources.chats).toBe('unavailable');
  });

  it('is optional: no cloud dep behaves exactly as before', () => {
    const { response } = createActivityReader(activityDeps(undefined), 'c2c2c2c6').build(null);
    expect(response.needsYou).toEqual([]);
    expect(response.sources.fleet).toBe('ok');
  });
});
