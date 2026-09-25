/**
 * 3.11 cloud lane — self-improvement backlog and claims
 * (src/core/cloud/backlog.ts). HOME-isolated; tasks are passed in except
 * where the append path reads the store to retire finished items.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  appendUserBacklogItems,
  CLOUD_BACKLOG_MAX_USER_ITEMS,
  CLOUD_BACKLOG_RETRY_MS,
  cloudBacklogPath,
  nextBacklogItem,
  readCloudBacklog,
  readUserBacklogItems,
} from '../src/core/cloud/backlog.js';
import { BUILTIN_IMPROVEMENT_BACKLOG } from '../src/core/cloud/improvement-backlog.js';
import { writeCloudTask } from '../src/core/cloud/store.js';
import type { CloudBacklogItem, CloudTaskV1 } from '../src/core/cloud/types.js';

let home: string;
let savedHome: string | undefined;
let savedAshlrHome: string | undefined;

beforeEach(() => {
  savedHome = process.env['HOME'];
  savedAshlrHome = process.env['ASHLR_HOME'];
  delete process.env['ASHLR_HOME'];
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-backlog-')));
  process.env['HOME'] = home;
});

afterEach(() => {
  process.env['HOME'] = savedHome;
  if (savedAshlrHome === undefined) delete process.env['ASHLR_HOME'];
  else process.env['ASHLR_HOME'] = savedAshlrHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-09-24T12:00:00.000Z');
const DAY = 86_400_000;
let seq = 0;

function task(itemId: string, state: CloudTaskV1['state'], endedAgoMs = 0, createdAgoMs = endedAgoMs + 1000): CloudTaskV1 {
  seq += 1;
  const id = `ct_20260924T1200_${String(seq).padStart(6, '0')}`;
  return {
    v: 1, id, repo: 'ashlrai/ashlr-hub', baseBranch: 'master', branch: `ashlr-cloud/${id}`, title: 't', prompt: 'p',
    origin: 'self-improve', requestedBy: 'self-improve', seat: 'claude-a', sessionId: null, sessionUrl: null, state,
    stateReason: null, failure: null, createdAt: new Date(NOW.getTime() - createdAgoMs).toISOString(), launchedAt: null,
    updatedAt: new Date(NOW.getTime() - endedAgoMs).toISOString(), pr: null, report: null, estimatedCostUsd: 3,
    backlogItemId: itemId, needsYouId: null,
  };
}

const item = (id: string, patch: Partial<CloudBacklogItem> = {}): CloudBacklogItem =>
  ({ id, title: `Item ${id}`, prompt: `Do ${id}.`, area: 'tests', priority: 2, ...patch });

// Built-in order by priority: the first priority-1 item leads.
const builtinOrdered = [...BUILTIN_IMPROVEMENT_BACKLOG].map((it, i) => ({ it, i })).sort((a, b) => a.it.priority - b.it.priority || a.i - b.i).map(({ it }) => it);
const FIRST = builtinOrdered[0]!.id;
const SECOND = builtinOrdered[1]!.id;

describe('view', () => {
  it('lists built-in items by priority then built-in order, all unclaimed, with nextUp', () => {
    const view = readCloudBacklog([], NOW);
    expect(view.items.map((i) => i.id)).toEqual(builtinOrdered.map((i) => i.id));
    expect(view.items.every((i) => i.claimedBy === null && i.lastState === null)).toBe(true);
    expect(view.nextUp).toBe(FIRST);
  });
});

describe('claims', () => {
  it('an in-progress task claims its item', () => {
    const t = task(FIRST, 'running');
    const view = readCloudBacklog([t], NOW);
    expect(view.items.find((i) => i.id === FIRST)).toMatchObject({ claimedBy: t.id, lastState: 'running' });
    expect(view.nextUp).toBe(SECOND);
    expect(nextBacklogItem([t], 'ashlrai/ashlr-hub', NOW)?.id).toBe(SECOND);
  });

  it('a merged item is done for good', () => {
    const t = task(FIRST, 'merged', 30 * DAY);
    expect(readCloudBacklog([t], NOW).items.find((i) => i.id === FIRST)!.claimedBy).toBe(t.id);
  });

  it.each(['closed', 'failed', 'expired'] as const)('a %s item comes back after 3 days, not before', (state) => {
    const recent = task(FIRST, state, CLOUD_BACKLOG_RETRY_MS - 60_000);
    expect(nextBacklogItem([recent], 'ashlrai/ashlr-hub', NOW)?.id).toBe(SECOND);
    const old = task(FIRST, state, CLOUD_BACKLOG_RETRY_MS);
    expect(nextBacklogItem([old], 'ashlrai/ashlr-hub', NOW)?.id).toBe(FIRST);
    expect(readCloudBacklog([old], NOW).items.find((i) => i.id === FIRST)).toMatchObject({ claimedBy: null, lastState: state });
  });

  it('the NEWEST task decides', () => {
    const oldMerged = task(FIRST, 'merged', 10 * DAY, 20 * DAY);
    const newerFailed = task(FIRST, 'failed', 5 * DAY, 6 * DAY);
    expect(nextBacklogItem([oldMerged, newerFailed], 'ashlrai/ashlr-hub', NOW)?.id).toBe(FIRST);
    const newerRunning = task(FIRST, 'running', 0, 1000);
    expect(nextBacklogItem([newerFailed, newerRunning], 'ashlrai/ashlr-hub', NOW)?.id).toBe(SECOND);
  });

  it('returns null when everything is claimed', () => {
    const tasks = BUILTIN_IMPROVEMENT_BACKLOG.map((i) => task(i.id, 'running'));
    expect(nextBacklogItem(tasks, 'ashlrai/ashlr-hub', NOW)).toBeNull();
    expect(readCloudBacklog(tasks, NOW).nextUp).toBeNull();
  });
});

describe('user items', () => {
  it('appends validated, deduped items (id and normalised title, including against built-ins) at 0600', () => {
    const added = appendUserBacklogItems([
      item('leader-m1-1', { priority: 1 }),
      item('leader-m1-1'),                                        // duplicate id in the batch
      item('leader-m1-2', { title: '  ITEM leader-m1-1!! ' }),    // same title, normalised
      item(FIRST),                                                // built-in id
      item('x-1', { title: BUILTIN_IMPROVEMENT_BACKLOG[0]!.title.toUpperCase() }), // built-in title
      item('bad id!'),
      item('no-prompt', { prompt: '  ' }),
      item('bad-prio', { priority: 4 as 1 }),
      item('bad-repo', { repo: 'not/a repo' }),
      item('other-repo', { repo: 'ashlrai/other' }),
    ]);
    expect(added).toBe(2);
    expect(readUserBacklogItems().map((i) => i.id)).toEqual(['leader-m1-1', 'other-repo']);
    expect(fs.statSync(cloudBacklogPath()).mode & 0o777).toBe(0o600);
    expect(appendUserBacklogItems([item('leader-m1-1')])).toBe(0);
    expect(appendUserBacklogItems([])).toBe(0);
  });

  it('user items rank by priority after built-ins of the same priority, and repo-scoped items only match their repo', () => {
    appendUserBacklogItems([item('u-p1', { priority: 1 }), item('u-other', { priority: 1, repo: 'ashlrai/other' })]);
    const ids = readCloudBacklog([], NOW).items.map((i) => i.id);
    const lastBuiltinP1 = Math.max(...builtinOrdered.filter((i) => i.priority === 1).map((i) => ids.indexOf(i.id)));
    expect(ids.indexOf('u-p1')).toBe(lastBuiltinP1 + 1);
    expect(nextBacklogItem([], 'ashlrai/other', NOW)?.id).toBe(FIRST);
    const claimAll = BUILTIN_IMPROVEMENT_BACKLOG.map((i) => task(i.id, 'running'));
    expect(nextBacklogItem(claimAll, 'ashlrai/other', NOW)?.id).toBe('u-p1');
    expect(nextBacklogItem([...claimAll, task('u-p1', 'running')], 'ashlrai/other', NOW)?.id).toBe('u-other');
    expect(nextBacklogItem([...claimAll, task('u-p1', 'running')], 'ashlrai/ashlr-hub', NOW)).toBeNull();
  });

  it('reads a hand-written bare array, skipping bad entries; a corrupt file reads as empty', () => {
    fs.mkdirSync(path.dirname(cloudBacklogPath()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(cloudBacklogPath(), JSON.stringify([item('ok-1'), { id: 'broken' }, item('ok-2')]), { mode: 0o600 });
    expect(readUserBacklogItems().map((i) => i.id)).toEqual(['ok-1', 'ok-2']);
    fs.writeFileSync(cloudBacklogPath(), '{"v":1,"items":[', { mode: 0o600 });
    expect(readUserBacklogItems()).toEqual([]);
    expect(readCloudBacklog([], NOW).items).toHaveLength(BUILTIN_IMPROVEMENT_BACKLOG.length);
  });

  it('caps the file at 200 items, retiring merged items first and never waiting ones', () => {
    const many = Array.from({ length: CLOUD_BACKLOG_MAX_USER_ITEMS }, (_, i) => item(`u-${i}`));
    expect(appendUserBacklogItems(many)).toBe(CLOUD_BACKLOG_MAX_USER_ITEMS);
    expect(appendUserBacklogItems([item('overflow')])).toBe(0);

    // Two items finished for good make room for two new ones.
    const merged = [task('u-0', 'merged'), task('u-5', 'merged')];
    for (const t of merged) writeCloudTask(t);
    expect(appendUserBacklogItems([item('new-1'), item('new-2'), item('new-3')])).toBe(2);
    const ids = readUserBacklogItems().map((i) => i.id);
    expect(ids).toHaveLength(CLOUD_BACKLOG_MAX_USER_ITEMS);
    expect(ids).not.toContain('u-0');
    expect(ids).not.toContain('u-5');
    expect(ids.slice(-2)).toEqual(['new-1', 'new-2']);

    // A hand-edited file past the cap is read only up to the cap.
    fs.writeFileSync(cloudBacklogPath(), JSON.stringify({ v: 1, items: Array.from({ length: 250 }, (_, i) => item(`h-${i}`)) }), { mode: 0o600 });
    expect(readUserBacklogItems()).toHaveLength(CLOUD_BACKLOG_MAX_USER_ITEMS);
  });
});
