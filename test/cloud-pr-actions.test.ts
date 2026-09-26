/**
 * 3.13 cloud PR triage — the acting half: land / close / update-branch
 * (src/core/cloud/pr-actions.ts) through the real `/api/verse/cloud` handler
 * (mutation gate, strict body, sendJson), the preview sweep behind Needs-you,
 * and the task store under a relocated HOME.
 *
 * `gh` is a recorded fake (setCloudPrActionDepsForTest): nothing here reaches
 * GitHub, and every assertion about what WOULD be sent reads the argv.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

import {
  handleCloudApi,
  needsYouItems,
  refreshCloudPrPreviewsGuarded,
  setCloudNeedsYouReaderForTest,
  setCloudPrActionDepsForTest,
} from '../src/core/cloud/cloud-api.js';
import { CLOUD_CLOSE_COMMENT, cachedCloudPrPreviews, resetCloudPrPreviewsForTest, type CloudGh } from '../src/core/cloud/pr-actions.js';
import type { CloudPrPreviewsResponse } from '../src/core/cloud/pr-preview.js';
import { listCloudTasks, readCloudTask, writeCloudTask } from '../src/core/cloud/store.js';
import type { CloudTaskV1 } from '../src/core/cloud/types.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const TOKEN = 'cloud-triage-mutation-token';
const HEAD = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const ID = 'ct_20260926T1100_tri001';
const REPO = 'ashlrai/ashlr-hub';

let home: string;
let savedHome: string | undefined;
let savedAshlrHome: string | undefined;
let server: http.Server;
let base: string;
let ctx: VerseApiContext;

function task(over: Partial<CloudTaskV1> = {}): CloudTaskV1 {
  return {
    v: 1, id: ID, repo: REPO, baseBranch: 'master', branch: `ashlr-cloud/${ID}`, title: 'Tidy the drawer', prompt: 'p',
    origin: 'self-improve', requestedBy: 'self-improve', seat: 'claude-a', sessionId: 'session_1', sessionUrl: null,
    state: 'pr-open', stateReason: 'Draft pull request #42 is open for review.', failure: null,
    createdAt: '2026-09-26T11:00:00.000Z', launchedAt: '2026-09-26T11:00:05.000Z', updatedAt: '2026-09-26T11:30:00.000Z',
    pr: { number: 42, url: `https://github.com/${REPO}/pull/42`, state: 'open', draft: true, title: '[ashlr-cloud] Tidy' },
    report: { status: 'done', summary: 'Tidied.', testsRun: [], risks: [] },
    deliveryPin: { number: 42, url: `https://github.com/${REPO}/pull/42` },
    estimatedCostUsd: 3, backlogItemId: null, needsYouId: null, ...over,
  };
}

function diffOf(p: string): string {
  return [`diff --git a/${p} b/${p}`, 'index 1111111..2222222 100644', `--- a/${p}`, `+++ b/${p}`, '@@ -1,1 +1,2 @@', ' a', '+b', ''].join('\n');
}

interface FakeGh {
  calls: string[][];
  view: Record<string, unknown>;
  diff: string;
  behindBy: number;
  fail: Partial<Record<'merge' | 'close' | 'ready' | 'update' | 'view', string>>;
}

let gh: FakeGh;

const fakeGh: CloudGh = async (args) => {
  gh.calls.push(args);
  const ok = (stdout: string) => ({ ok: true, stdout, stderr: '' });
  const no = (stderr: string) => ({ ok: false, stdout: '', stderr });
  if (args[0] === 'pr' && args[1] === 'view') return gh.fail.view ? no(gh.fail.view) : ok(JSON.stringify(gh.view));
  if (args[0] === 'api' && args.includes('--jq')) return ok(JSON.stringify({ behind_by: gh.behindBy, merge_base: BASE }));
  if (args[0] === 'api' && args.includes('Accept: application/vnd.github.diff')) return ok(gh.diff);
  if (args[0] === 'pr' && args[1] === 'ready') return gh.fail.ready ? no(gh.fail.ready) : ok('');
  if (args[0] === 'pr' && args[1] === 'merge') return gh.fail.merge ? no(gh.fail.merge) : ok('');
  if (args[0] === 'pr' && args[1] === 'close') return gh.fail.close ? no(gh.fail.close) : ok('');
  if (args[0] === 'api' && args.includes('PUT')) return gh.fail.update ? no(gh.fail.update) : ok('{}');
  return no('unexpected');
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    void handleCloudApi(ctx, req, res, url.pathname, req.method ?? 'GET').then((handled) => {
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'fallthrough' }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setCloudPrActionDepsForTest(null);
  setCloudNeedsYouReaderForTest(null);
});

beforeEach(() => {
  savedHome = process.env['HOME'];
  savedAshlrHome = process.env['ASHLR_HOME'];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-pr-actions-'));
  process.env['HOME'] = home;
  delete process.env['ASHLR_HOME'];
  ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true };
  gh = {
    calls: [],
    view: {
      number: 42, url: `https://github.com/${REPO}/pull/42`, state: 'OPEN', isDraft: true, headRefOid: HEAD,
      headRefName: `ashlr-cloud/${ID}`, baseRefName: 'master', mergeable: 'MERGEABLE', mergeStateStatus: 'DRAFT',
      statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }], isCrossRepository: false,
    },
    diff: diffOf('src/web-ui/routes/verse/shell/thing.ts'),
    behindBy: 0,
    fail: {},
  };
  // No standing grant in a test HOME: the compiled ceilings apply.
  setCloudPrActionDepsForTest({ gh: fakeGh, policy: () => null });
  resetCloudPrPreviewsForTest();
  writeCloudTask(task());
});

afterEach(() => {
  process.env['HOME'] = savedHome;
  if (savedAshlrHome === undefined) delete process.env['ASHLR_HOME'];
  else process.env['ASHLR_HOME'] = savedAshlrHome;
  fs.rmSync(home, { recursive: true, force: true });
});

async function post<T>(p: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ashlr-token': TOKEN, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

const mutations = () => gh.calls.filter((a) => ['merge', 'close', 'ready'].includes(a[1]!) || a.includes('PUT'));

describe('POST /api/verse/cloud/tasks/<id>/land', () => {
  const landPath = `/api/verse/cloud/tasks/${ID}/land`;

  it('readies the draft, then squash-merges exactly the reviewed head, and records the task merged', async () => {
    const { status, body } = await post<{ ok: boolean; task: CloudTaskV1; message: string }>(landPath, { headSha: HEAD });
    expect(status).toBe(200);
    expect(body.message).toBe('Landed #42.');
    expect(mutations()).toEqual([
      ['pr', 'ready', '42', '--repo', REPO],
      ['pr', 'merge', '42', '--repo', REPO, '--squash', '--match-head-commit', HEAD],
    ]);
    // The diff it judged was pinned to merge base … head.
    expect(gh.calls).toContainEqual(['api', '-H', 'Accept: application/vnd.github.diff', `repos/${REPO}/compare/${BASE}...${HEAD}`]);
    const stored = readCloudTask(ID)!;
    expect(stored.state).toBe('merged');
    expect(stored.pr!.state).toBe('merged');
    expect(stored.stateReason).toBe('Landed from Verse (#42).');
  });

  it('refuses when the branch moved since the operator looked — nothing is sent', async () => {
    const { status, body } = await post<{ error: string }>(landPath, { headSha: 'd'.repeat(40) });
    expect(status).toBe(409);
    expect(body.error).toBe(`The branch moved since you looked (now ${HEAD.slice(0, 7)}). Review it again.`);
    expect(mutations()).toEqual([]);
    expect(readCloudTask(ID)!.state).toBe('pr-open');
  });

  it('refuses a protected path (G1) and a conflict, without touching GitHub', async () => {
    gh.diff = diffOf('src/core/authority/ledger.ts');
    const prot = await post<{ error: string }>(landPath, { headSha: HEAD });
    expect(prot.status).toBe(409);
    expect(prot.body.error).toMatch(/protected path \(src\/core\/authority\/ledger\.ts\)/);
    gh.diff = diffOf('docs/x.md');
    gh.view = { ...gh.view, mergeable: 'CONFLICTING' };
    const conflict = await post<{ error: string }>(landPath, { headSha: HEAD });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('It conflicts with master.');
    expect(mutations()).toEqual([]);
  });

  it('refuses a PR that no longer matches the task (another head branch)', async () => {
    gh.view = { ...gh.view, headRefName: 'someone-else' };
    const { status, body } = await post<{ error: string }>(landPath, { headSha: HEAD });
    expect(status).toBe(409);
    expect(body.error).toMatch(/no longer matches this task/);
    expect(mutations()).toEqual([]);
  });

  it("maps GitHub's refusal to a fixed sentence and leaves the task open", async () => {
    gh.fail.merge = 'GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest) /Users/x/.config/gh';
    const { status, body } = await post<{ error: string }>(landPath, { headSha: HEAD });
    expect(status).toBe(409);
    expect(body.error).toBe('The branch moved since it was checked. Review it again.');
    expect(readCloudTask(ID)!.state).toBe('pr-open');
  });

  it('needs the mutation token, a strict body and a real task id', async () => {
    expect((await post(landPath, { headSha: HEAD }, { 'x-ashlr-token': 'wrong' })).status).toBe(401);
    expect((await post<{ error: string }>(landPath, { headSha: 'abc' })).status).toBe(400);
    expect((await post<{ error: string }>(landPath, { headSha: HEAD, squash: false })).body.error).toBe('Unknown field squash.');
    expect((await post(`/api/verse/cloud/tasks/nope/land`, { headSha: HEAD })).status).toBe(400);
    expect((await post(`/api/verse/cloud/tasks/ct_20260926T1100_zzz999/land`, { headSha: HEAD })).status).toBe(404);
    ctx = { ...ctx, allowDispatch: false };
    expect((await post(landPath, { headSha: HEAD })).status).toBe(404);
    expect(mutations()).toEqual([]);
  });

  it('refuses a task whose PR is not verified right now', async () => {
    writeCloudTask(task({ pr: null }));
    const { status, body } = await post<{ error: string }>(landPath, { headSha: HEAD });
    expect(status).toBe(409);
    expect(body.error).toMatch(/can't verify this pull request/);
    expect(gh.calls).toEqual([]);
  });
});

describe('close and update-branch', () => {
  it('closes with the short comment and records the task closed', async () => {
    const { status, body } = await post<{ ok: boolean; task: CloudTaskV1 }>(`/api/verse/cloud/tasks/${ID}/close`, { headSha: HEAD });
    expect(status).toBe(200);
    expect(mutations()).toEqual([['pr', 'close', '42', '--repo', REPO, '--comment', CLOUD_CLOSE_COMMENT]]);
    expect(body.task.state).toBe('closed');
    expect(readCloudTask(ID)!.stateReason).toBe('Closed in Verse without landing.');
  });

  it('updates a branch that is behind, pinned to the reviewed head', async () => {
    gh.behindBy = 3;
    const { status, body } = await post<{ message: string }>(`/api/verse/cloud/tasks/${ID}/update-branch`, { headSha: HEAD });
    expect(status).toBe(200);
    expect(body.message).toBe('Updating #42 from master; checks will run again.');
    expect(mutations()).toEqual([['api', '-X', 'PUT', `repos/${REPO}/pulls/42/update-branch`, '-f', `expected_head_sha=${HEAD}`]]);
    expect(readCloudTask(ID)!.state).toBe('pr-open');
  });

  it('refuses to update a branch that is already up to date', async () => {
    const { status, body } = await post<{ error: string }>(`/api/verse/cloud/tasks/${ID}/update-branch`, { headSha: HEAD });
    expect(status).toBe(409);
    expect(body.error).toBe('#42 is already up to date with master.');
    expect(mutations()).toEqual([]);
  });
});

describe('previews behind Needs-you', () => {
  it('a sweep previews open PRs; the route serves them and Needs-you offers the pinned actions', async () => {
    setCloudNeedsYouReaderForTest(() => listCloudTasks());
    const result = await refreshCloudPrPreviewsGuarded();
    expect(result).toEqual({ checked: 1, updated: 1 });
    const preview = cachedCloudPrPreviews().get(ID)!;
    expect(preview).toMatchObject({ headSha: HEAD, wouldAutoLand: true, prNumber: 42 });

    const res = await fetch(`${base}/api/verse/cloud/previews`);
    const body = (await res.json()) as CloudPrPreviewsResponse;
    expect(res.status).toBe(200);
    expect(body.previews.map((p) => p.itemId)).toEqual([`fleet:owner-lane-pr:cloud-${ID}`]);

    // The producer rebuilds off the caller's stack: first call schedules, the next answers.
    needsYouItems();
    await new Promise((resolve) => setImmediate(resolve));
    const [item] = needsYouItems();
    expect(item!.actions.map((a) => a.label)).toEqual(['Land', 'Close', 'Dismiss']);
    expect(item!.detail).toMatch(/^Clean: /);

    // A second sweep inside the TTL reads nothing from GitHub.
    const before = gh.calls.length;
    expect(await refreshCloudPrPreviewsGuarded()).toEqual({ checked: 0, updated: 0 });
    expect(gh.calls.length).toBe(before);
  });

  it('a PR GitHub cannot describe keeps no preview (so no Land built on an old answer)', async () => {
    setCloudNeedsYouReaderForTest(() => listCloudTasks());
    gh.fail.view = 'HTTP 502';
    expect(await refreshCloudPrPreviewsGuarded()).toEqual({ checked: 1, updated: 0 });
    expect(cachedCloudPrPreviews().has(ID)).toBe(false);
  });

  it('rejects a query on the previews route and any non-GET', async () => {
    expect((await fetch(`${base}/api/verse/cloud/previews?all=1`)).status).toBe(400);
    expect((await post('/api/verse/cloud/previews', {})).status).toBe(404);
  });
});
