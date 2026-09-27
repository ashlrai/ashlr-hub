/**
 * 3.15 — Devin parity in Needs-you and Evidence:
 *
 *   - GET /api/verse/devin/previews keys each preview by the DEVIN row's item
 *     id (`fleet:owner-lane-pr:devin-dv_…`), so the drawer's Clean / Held chip
 *     and "Land all clean" reach Devin rows (it used to say `cloud-dv_…`);
 *   - POST /api/verse/devin/tasks/<id>/close takes Mason's optional reason,
 *     like the cloud route; land still refuses one;
 *   - the Devin evidence timeline (src/core/devin/timeline.ts): the pure
 *     builder (session status, ACUs vs cap with a $ estimate, messages sent
 *     from Verse, the shared PR → release chain) and its route,
 *     GET /api/verse/devin/tasks/<id>/timeline, served by the 'cloud-timeline'
 *     module ahead of 'devin' in the real mount table.
 *
 * `gh` is a recorded fake and every timeline source is injected; files live
 * in the worker's isolated ASHLR_HOME (test/setup/home.ts).
 */
import { rmSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { CloudGh } from '../src/core/cloud/pr-actions.js';
import { cloudPrItemId, type CloudPrPreviewsResponse } from '../src/core/cloud/pr-preview.js';
import { clearCloudTimelineCaches, type TimelineSources } from '../src/core/cloud/timeline.js';
import { devinTimelinePath, evidenceTimelinePath, TIMELINE_STEP_ORDER, type CloudTimelineResponse, type TimelineStep } from '../src/core/cloud/timeline-types.js';
import { handleDevinApi, needsYouItems, refreshDevinPrPreviewsGuarded, setDevinApiDepsForTest } from '../src/core/devin/devin-api.js';
import { devinHome, readDevinTask, writeDevinTask } from '../src/core/devin/store.js';
import { buildDevinTimeline, devinMessagesLine, devinTaskTimeline, setDevinTimelineDepsForTest, type DevinTimelineDeps } from '../src/core/devin/timeline.js';
import { DEVIN_USAGE_URL, type DevinTaskV1 } from '../src/core/devin/types.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import { mountedApiModules, setMountedApiModulesForTest, type VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';

const TOKEN = 'devin-evidence-mutation-token';
const REPO = 'ashlrai/devin-canary';
const ID = 'dv_20260927T0400_evid01';
const HEAD = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const NOW = new Date('2026-09-27T12:00:00.000Z');

function task(over: Partial<DevinTaskV1> & { messagesSent?: number } = {}): DevinTaskV1 {
  return {
    v: 1, id: ID, repo: REPO, baseBranch: 'main', branch: `ashlr-devin/${ID}`, title: 'Add a helper', prompt: 'Add a sub helper to utils.',
    origin: 'operator', requestedBy: 'mason', sessionId: 'devin-s1', sessionUrl: 'https://app.devin.ai/sessions/devin-s1', state: 'pr-open',
    stateReason: 'Pull request #9 is open for review.', failure: null,
    createdAt: '2026-09-27T04:00:00.000Z', launchedAt: '2026-09-27T04:00:05.000Z', updatedAt: '2026-09-27T05:00:00.000Z',
    session: { status: 'exit', statusDetail: 'finished', acusConsumed: 3.5, prUrls: [], readAt: '2026-09-27T05:00:00.000Z' },
    maxAcu: 10, devinMode: 'normal',
    pr: { number: 9, url: `https://github.com/${REPO}/pull/9`, state: 'open', draft: false, title: '[ashlr-devin] Add a helper' },
    headSha: HEAD,
    report: { status: 'done', summary: 'Added it.', testsRun: ['npm test'], risks: [] },
    deliveryPin: { number: 9, url: `https://github.com/${REPO}/pull/9` },
    backlogItemId: null,
    ...over,
  } as DevinTaskV1;
}

// ---------------------------------------------------------------------------
// A real http server over the real handlers
// ---------------------------------------------------------------------------

interface FakeGh {
  calls: string[][];
  view: Record<string, unknown>;
}
let gh: FakeGh;

const fakeGh: CloudGh = async (args) => {
  gh.calls.push(args);
  const ok = (stdout: string) => ({ ok: true, stdout, stderr: '' });
  if (args[0] === 'pr' && args[1] === 'view') return ok(JSON.stringify(gh.view));
  if (args[0] === 'api' && args.includes('--jq')) return ok(JSON.stringify({ behind_by: 0, merge_base: BASE }));
  if (args[0] === 'api' && args.includes('Accept: application/vnd.github.diff')) {
    return ok(['diff --git a/src/util.ts b/src/util.ts', 'index 1111111..2222222 100644', '--- a/src/util.ts', '+++ b/src/util.ts', '@@ -1,1 +1,2 @@', ' a', '+b', ''].join('\n'));
  }
  if (args[0] === 'pr' && (args[1] === 'close' || args[1] === 'merge' || args[1] === 'ready')) return ok('');
  return { ok: false, stdout: '', stderr: 'unexpected' };
};

let server: http.Server;
let base: string;
let handler: ApiModule = handleDevinApi;
const ctx: VerseApiContext = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    void handler(ctx, req, res, url.pathname, req.method ?? 'GET').then((handled) => {
      if (!handled) {
        res.writeHead(418, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'declined' }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setDevinApiDepsForTest(null);
  setDevinTimelineDepsForTest(null);
});

beforeEach(() => {
  rmSync(devinHome(), { recursive: true, force: true });
  handler = handleDevinApi;
  gh = {
    calls: [],
    view: {
      number: 9, url: `https://github.com/${REPO}/pull/9`, state: 'OPEN', isDraft: false, headRefOid: HEAD,
      headRefName: `ashlr-devin/${ID}`, baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }], isCrossRepository: false,
    },
  };
  // No standing grant in a test HOME: the compiled ceilings apply.
  setDevinApiDepsForTest({ pr: { gh: fakeGh, policy: () => null } });
  writeDevinTask(task());
});

afterEach(() => {
  setMountedApiModulesForTest(null);
  setDevinTimelineDepsForTest(null);
});

async function post<T>(p: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ashlr-token': TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function get<T>(p: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${p}`);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

// ---------------------------------------------------------------------------
// Previews and Needs-you
// ---------------------------------------------------------------------------

describe('Devin PR previews (Needs-you parity)', () => {
  it('the item id is lane-aware: a Devin id gets `devin-`, a cloud id keeps `cloud-`', () => {
    expect(cloudPrItemId(ID)).toBe(`fleet:owner-lane-pr:devin-${ID}`);
    expect(cloudPrItemId('ct_20260927T0400_abc123')).toBe('fleet:owner-lane-pr:cloud-ct_20260927T0400_abc123');
  });

  it('GET /api/verse/devin/previews serves the preview under the Devin row’s own item id, and the row carries the pinned actions', async () => {
    expect(await refreshDevinPrPreviewsGuarded()).toEqual({ checked: 1, updated: 1 });
    const { status, body } = await get<CloudPrPreviewsResponse>('/api/verse/devin/previews');
    expect(status).toBe(200);
    expect(body.previews.map((p) => [p.itemId, p.headSha, p.wouldAutoLand])).toEqual([[`fleet:owner-lane-pr:devin-${ID}`, HEAD, true]]);

    // The producer rebuilds off the caller's stack: first call schedules, the next answers.
    needsYouItems();
    await new Promise((resolve) => setImmediate(resolve));
    const item = needsYouItems().find((i) => i.id === body.previews[0]!.itemId);
    expect(item, 'the preview and the Needs-you row share one id').toBeDefined();
    expect(item!.actions.map((a) => a.label)).toEqual(['Land', 'Close', 'Dismiss']);
    expect(item!.actions[0]!.request!.body).toEqual({ headSha: HEAD });
  });
});

describe('POST /api/verse/devin/tasks/<id>/close with a reason', () => {
  it('records `Closed in Verse: <reason>` on the Devin task and puts the reason in the GitHub comment', async () => {
    const { status, body } = await post<{ ok: boolean; task: DevinTaskV1 }>(`/api/verse/devin/tasks/${ID}/close`, { headSha: HEAD, reason: 'Wrong file:\nhelpers go in src/lib' });
    expect(status).toBe(200);
    expect(body.task.stateReason).toBe('Closed in Verse: Wrong file: helpers go in src/lib');
    expect(readDevinTask(ID)).toMatchObject({ state: 'closed', stateReason: 'Closed in Verse: Wrong file: helpers go in src/lib' });
    expect(gh.calls.filter((c) => c[1] === 'close')).toEqual([
      ['pr', 'close', '9', '--repo', REPO, '--comment', 'Closed from Ashlr Verse (Needs you) without landing. Reason: Wrong file: helpers go in src/lib'],
    ]);
  });

  it('without a reason nothing changes; a bad reason is a 400; land refuses the key', async () => {
    const bad = await post<{ error: string }>(`/api/verse/devin/tasks/${ID}/close`, { headSha: HEAD, reason: { text: 'x' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('The close reason must be text.');
    const land = await post<{ error: string }>(`/api/verse/devin/tasks/${ID}/land`, { headSha: HEAD, reason: 'x' });
    expect(land.status).toBe(400);
    expect(land.body.error).toBe('Unknown field reason.');
    expect(gh.calls).toEqual([]);
    const plain = await post<{ task: DevinTaskV1 }>(`/api/verse/devin/tasks/${ID}/close`, { headSha: HEAD });
    expect(plain.status).toBe(200);
    expect(plain.body.task.stateReason).toBe('Closed in Verse without landing.');
  });
});

// ---------------------------------------------------------------------------
// The Devin evidence timeline — pure builder
// ---------------------------------------------------------------------------

function sources(t: DevinTaskV1, over: Partial<TimelineSources<DevinTaskV1>> = {}): TimelineSources<DevinTaskV1> {
  return {
    task: t,
    merge: { state: 'missing' },
    ledger: { state: 'ok', chain: 'empty', gates: [], landing: null, postMerge: null },
    watch: { state: 'ok', view: null },
    model: null,
    mergeCommit: null,
    release: null,
    ...over,
  };
}

const stepOf = (steps: readonly TimelineStep[], kind: TimelineStep['kind']): TimelineStep => steps.find((s) => s.kind === kind)!;

describe('buildDevinTimeline', () => {
  it('every step, in the fixed order, for a Devin task with an open PR', () => {
    const tl = buildDevinTimeline(sources(task({ messagesSent: 2 } as Partial<DevinTaskV1>)), 2.25, NOW);
    expect(tl.steps.map((s) => s.kind)).toEqual([...TIMELINE_STEP_ORDER]);
    expect(tl).toMatchObject({ v: 1, taskId: ID, repo: REPO, title: 'Add a helper', state: 'pr-open', generatedAt: NOW.toISOString() });

    expect(stepOf(tl.steps, 'objective')).toMatchObject({ source: 'Devin task record', verified: true });
    expect(stepOf(tl.steps, 'objective').detail).toMatch(/^From New Devin task, requested by mason\./);

    const launch = stepOf(tl.steps, 'launch');
    expect(launch).toMatchObject({ title: 'Devin session started (normal mode)', verified: true, link: { href: 'https://app.devin.ai/sessions/devin-s1', label: 'Open in Devin' } });
    expect(launch.detail).toContain(`Branch ashlr-devin/${ID}.`);

    const worker = stepOf(tl.steps, 'worker');
    expect(worker).toMatchObject({ title: 'Devin session · exit (finished)', source: 'Devin API (session status)', verified: true, at: '2026-09-27T05:00:00.000Z' });
    expect(worker.detail).toContain('2 messages sent from Verse.');
    expect(worker.detail).toContain('Model: unknown');

    const report = stepOf(tl.steps, 'report');
    expect(report.verified).toBe(false);
    const pr = stepOf(tl.steps, 'pr');
    expect(pr).toMatchObject({ title: 'PR #9 open', source: 'GitHub, read by the Devin tracker', verified: true, link: { href: `https://github.com/${REPO}/pull/9` } });

    const cost = stepOf(tl.steps, 'cost');
    expect(cost).toMatchObject({ title: '3.5 of 10 ACUs used · ~$7.88 estimated', verified: false, link: { href: DEVIN_USAGE_URL } });
    expect(cost.detail).toContain('$2.25 per ACU');
    expect(cost.detail).toMatch(/estimate/);
  });

  it('a PR without the report block names the Devin fence; merge / closed words say Devin', () => {
    const noReport = buildDevinTimeline(sources(task({ report: null })), 2, NOW);
    expect(stepOf(noReport.steps, 'report').detail).toBe('The pull request carries no ashlr-devin-report block.');
    const closed = buildDevinTimeline(sources(task({ state: 'closed', stateReason: 'Closed in Verse: wrong file', pr: { ...task().pr!, state: 'closed' } })), 2, NOW);
    expect(stepOf(closed.steps, 'merge')).toMatchObject({ title: 'Closed without merging', detail: 'Closed in Verse: wrong file', source: 'Devin task record' });
  });

  it('messages: counted, zero, not recorded, or unreadable — never invented', () => {
    expect(devinMessagesLine(task({ messagesSent: 1 } as Partial<DevinTaskV1>))).toBe('1 message sent from Verse.');
    expect(devinMessagesLine(task({ messagesSent: 0 } as Partial<DevinTaskV1>))).toBe('No messages sent from Verse.');
    expect(devinMessagesLine(task())).toBe('No messages recorded as sent from Verse.');
    expect(devinMessagesLine(task({ messagesSent: -1 } as Partial<DevinTaskV1>))).toBe('Messages sent from Verse: unknown.');
    expect(devinMessagesLine(task({ messagesSent: 'lots' } as unknown as Partial<DevinTaskV1>))).toBe('Messages sent from Verse: unknown.');
  });

  it('ACUs not reported: the cap is named and the budget’s fail-closed rule explained; no $/ACU means no dollar figure', () => {
    const unread = buildDevinTimeline(sources(task({ session: null })), 2.25, NOW);
    expect(stepOf(unread.steps, 'cost')).toMatchObject({ title: 'ACUs not reported (cap 10)', verified: false });
    expect(stepOf(unread.steps, 'cost').detail).toMatch(/counts its full cap/);
    expect(stepOf(unread.steps, 'worker')).toMatchObject({ title: 'Devin session · status not read yet', verified: 'unknown' });
    const noRate = buildDevinTimeline(sources(task()), null, NOW);
    expect(stepOf(noRate.steps, 'cost').title).toBe('3.5 of 10 ACUs used');
    expect(stepOf(noRate.steps, 'cost').detail).toMatch(/no dollar estimate/);
  });

  it('only app.devin.ai becomes a session link; a failed launch with no session says so', () => {
    const spoofed = buildDevinTimeline(sources(task({ sessionUrl: 'https://evil.example/sessions/devin-s1' })), 2, NOW);
    expect(stepOf(spoofed.steps, 'launch').link).toBeUndefined();
    const httpOnly = buildDevinTimeline(sources(task({ sessionUrl: 'http://app.devin.ai/sessions/devin-s1' })), 2, NOW);
    expect(stepOf(httpOnly.steps, 'launch').link).toBeUndefined();
    const failed = buildDevinTimeline(sources(task({ state: 'failed', sessionId: null, sessionUrl: null, session: null, failure: 'auth', stateReason: 'Devin refused the API key (401).', pr: null, deliveryPin: undefined })), 2, NOW);
    expect(stepOf(failed.steps, 'launch')).toMatchObject({ title: 'Launch failed', detail: 'Devin refused the API key (401).' });
    expect(stepOf(failed.steps, 'cost').detail).toBe('No session was started, so no ACUs were used.');
  });

  it('a Devin PR the fleet landed shows the shared merge / release / health chain', () => {
    const landingRecord = {
      v: 1, id: `${REPO}#9@aaaaaaaaaaaa`, kind: 'merge', repo: REPO, baseBranch: 'main', prNumber: 9, headSha: HEAD, mergeSha: 'a'.repeat(40),
      proposalId: ID, revertsLandingId: null, grantId: 'grant-1', rolloutStageId: 's', gatesDigest: 'd', ledgerHead: 'e', enforcement: 'server',
      risk: 'low', files: 1, linesAdded: 1, linesDeleted: 0, producer: null, judgeId: null, proposedAt: null,
      landedAt: '2026-09-27T06:00:00.000Z', watchUntil: '2026-09-27T08:00:00.000Z',
    } as never;
    const tl = buildDevinTimeline(sources(task({ state: 'merged', pr: { ...task().pr!, state: 'merged' } }), {
      ledger: { state: 'ok', chain: 'ok', gates: [], landing: landingRecord, postMerge: null },
      mergeCommit: { sha: 'a'.repeat(40), basis: 'landing' },
      release: { state: 'contained', latestTag: 'v1.2.0', firstTag: 'v1.2.0' },
    }), 2, NOW);
    expect(stepOf(tl.steps, 'merge')).toMatchObject({ title: 'Merged as aaaaaaa', verified: true, link: { href: `https://github.com/${REPO}/commit/${'a'.repeat(40)}` } });
    expect(stepOf(tl.steps, 'release')).toMatchObject({ title: 'In the latest release, v1.2.0', verified: true });
  });
});

// ---------------------------------------------------------------------------
// The Devin evidence timeline — gathering and the route
// ---------------------------------------------------------------------------

function timelineDeps(over: Partial<DevinTimelineDeps> = {}): DevinTimelineDeps {
  return {
    listMergeKeys: () => [],
    readMergeRecord: () => ({ state: 'missing' }),
    readLedger: async () => ({ entries: [], head: null, chain: 'empty', brokenAtSeq: null, reason: null }),
    listWatches: () => [],
    readEvidenceModel: () => null,
    git: async () => ({ code: 1, stdout: '', stderr: 'no', timedOut: false, truncated: false, missing: false }),
    checkoutFor: async () => null,
    usdPerAcu: () => 2,
    ...over,
  };
}

describe('devinTaskTimeline', () => {
  it('reads the Devin store, matches a merge record by the ashlr-devin/<id> branch, and refuses ids Verse did not issue', async () => {
    clearCloudTimelineCaches();
    const record = {
      state: 'ok',
      record: { repo: REPO, proposalId: 'fleet-prop-7', pr: { number: 77, branch: `ashlr-devin/${ID}`, checks: { state: 'green', detail: 'All 4 required checks passed.', at: '2026-09-27T05:30:00.000Z' } }, gates: {}, landing: null, files: 1, linesAdded: 1, linesDeleted: 0, risk: 'low' },
    } as never;
    const tl = await devinTaskTimeline(ID, timelineDeps({ listMergeKeys: () => ['k'], readMergeRecord: () => record }));
    expect(tl!.taskId).toBe(ID);
    expect(stepOf(tl!.steps, 'checks')).toMatchObject({ title: 'Required checks passed', verified: true });
    expect(stepOf(tl!.steps, 'cost').title).toBe('3.5 of 10 ACUs used · ~$7.00 estimated');
    expect(await devinTaskTimeline('ct_20260927T0400_abc123', timelineDeps())).toBeNull();
    expect(await devinTaskTimeline('dv_20260927T0400_zzzzzz', timelineDeps())).toBeNull();
  });

  it('a throwing budget reader degrades to no dollar figure, never a failure', async () => {
    clearCloudTimelineCaches();
    const tl = await devinTaskTimeline(ID, timelineDeps({ usdPerAcu: () => { throw new Error('EACCES'); } }));
    expect(stepOf(tl!.steps, 'cost').title).toBe('3.5 of 10 ACUs used');
  });
});

describe('GET /api/verse/devin/tasks/<id>/timeline', () => {
  async function realMount(): Promise<void> {
    setMountedApiModulesForTest(null);
    const entries = mountedApiModules().filter((m) => m.id === 'cloud-timeline' || m.id === 'cloud' || m.id === 'devin');
    expect(entries.map((m) => m.id)).toEqual(['cloud-timeline', 'cloud', 'devin']);
    const loaded = await Promise.all(entries.map(async (m) => m.load()));
    handler = async (c, req, res, p, method) => {
      for (const h of loaded) if (await h(c, req, res, p, method)) return true;
      return false;
    };
  }

  it('through the real mount order, the timeline module answers before devin’s catch-all 404', async () => {
    await realMount();
    setDevinTimelineDepsForTest(timelineDeps());
    expect(evidenceTimelinePath(ID)).toBe(devinTimelinePath(ID));
    const res = await get<CloudTimelineResponse>(devinTimelinePath(ID));
    expect(res.status).toBe(200);
    expect(res.body.taskId).toBe(ID);
    expect(res.body.steps.map((s) => s.kind)).toEqual([...TIMELINE_STEP_ORDER]);
    // The other Devin routes still reach the Devin module.
    expect((await get<CloudPrPreviewsResponse>('/api/verse/devin/previews')).status).toBe(200);
  });

  it('400 for a non-Devin id or any query; 404 for an unknown task or another verb; 500 without the message', async () => {
    await realMount();
    setDevinTimelineDepsForTest(timelineDeps());
    const cloudId = await get<{ error: string }>('/api/verse/devin/tasks/ct_20260927T0400_abc123/timeline');
    expect(cloudId).toEqual({ status: 400, body: { code: 'VERSE_INVALID', error: 'That is not a Devin task id.' } });
    expect((await get(`${devinTimelinePath(ID)}?x=1`)).status).toBe(400);
    expect(await get(devinTimelinePath('dv_20260927T0400_zzzzzz'))).toEqual({ status: 404, body: { error: 'No Devin task with that id.' } });
    expect((await fetch(`${base}${devinTimelinePath(ID)}`, { method: 'DELETE' })).status).toBe(404);
    setDevinTimelineDepsForTest(timelineDeps({ readTask: () => { throw new Error(`EACCES ${devinHome()}/tasks/${ID}.json`); } }));
    expect(await get(devinTimelinePath(ID))).toEqual({ status: 500, body: { error: 'devin timeline failed' } });
  });
});
