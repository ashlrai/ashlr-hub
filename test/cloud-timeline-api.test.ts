/**
 * 3.13 — GET /api/verse/cloud/tasks/<id>/timeline (src/core/cloud/timeline-api.ts).
 *
 * The real handler behind a real http server (so sendJson's sanitizer is the
 * production one) under a relocated HOME, with every timeline source injected
 * (setCloudTimelineDepsForTest): nothing reads the operator's ~/.ashlr, the
 * ledger or git. Also pins the mount order — the timeline module must be
 * asked before 'cloud', which 404s every /api/verse/cloud/* path it does
 * not know.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

import { handleCloudTimelineApi } from '../src/core/cloud/timeline-api.js';
import { setCloudTimelineDepsForTest, type TimelineDeps } from '../src/core/cloud/timeline.js';
import { cloudTimelinePath, TIMELINE_STEP_ORDER, type CloudTimelineResponse } from '../src/core/cloud/timeline-types.js';
import type { CloudTaskV1 } from '../src/core/cloud/types.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import { mountedApiModules, setMountedApiModulesForTest, type VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';

const ID = 'ct_20260925T1200_abc123';

function task(over: Partial<CloudTaskV1> = {}): CloudTaskV1 {
  return {
    v: 1,
    id: ID,
    repo: 'ashlrai/ashlr-hub',
    baseBranch: 'master',
    branch: `ashlr-cloud/${ID}`,
    title: 'Fix the flaky tracker test',
    prompt: 'Fix the flaky tracker test.',
    origin: 'operator',
    requestedBy: 'mason',
    seat: 'claude-a',
    sessionId: 'session_01abc',
    sessionUrl: 'https://claude.ai/code/session_01abc',
    state: 'pr-open',
    stateReason: null,
    failure: null,
    createdAt: '2026-09-25T12:00:00.000Z',
    launchedAt: '2026-09-25T12:00:05.000Z',
    updatedAt: '2026-09-25T13:00:00.000Z',
    pr: { number: 512, url: 'https://github.com/ashlrai/ashlr-hub/pull/512', state: 'open', draft: true, title: 'Fix' },
    report: { status: 'done', summary: 'Fixed it.', testsRun: ['npm test'], risks: [] },
    estimatedCostUsd: 3,
    backlogItemId: null,
    needsYouId: null,
    ...over,
  };
}

let tasks: Map<string, CloudTaskV1>;
let readThrows = false;

function testDeps(): TimelineDeps {
  return {
    readTask: (id) => {
      if (readThrows) throw new Error(`EACCES ${os.homedir()}/.ashlr/cloud/tasks/${id}.json`);
      return tasks.get(id) ?? null;
    },
    listMergeKeys: () => [],
    readMergeRecord: () => ({ state: 'missing' }),
    readLedger: async () => ({ entries: [], head: null, chain: 'empty', brokenAtSeq: null, reason: null }),
    listWatches: () => [],
    readEvidenceModel: () => null,
    git: async () => ({ code: 1, stdout: '', stderr: 'no', timedOut: false, truncated: false, missing: false }),
    checkoutFor: async () => null,
  };
}

let home: string;
let savedHome: string | undefined;
let savedAshlrHome: string | undefined;
let server: http.Server;
let base: string;
let handler: ApiModule = handleCloudTimelineApi;
const ctx: VerseApiContext = { cfg: {} as AshlrConfig, token: 't'.repeat(64), allowDispatch: true };

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
});

beforeEach(() => {
  savedHome = process.env['HOME'];
  savedAshlrHome = process.env['ASHLR_HOME'];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-timeline-api-'));
  process.env['HOME'] = home;
  process.env['ASHLR_HOME'] = path.join(home, '.ashlr');
  tasks = new Map([[ID, task()]]);
  readThrows = false;
  handler = handleCloudTimelineApi;
  setCloudTimelineDepsForTest(testDeps());
});

afterEach(() => {
  setCloudTimelineDepsForTest(null);
  setMountedApiModulesForTest(null);
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  if (savedAshlrHome === undefined) delete process.env['ASHLR_HOME'];
  else process.env['ASHLR_HOME'] = savedAshlrHome;
  fs.rmSync(home, { recursive: true, force: true });
});

async function get(p: string, method = 'GET'): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${p}`, { method });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe('GET /api/verse/cloud/tasks/<id>/timeline', () => {
  it('answers the ordered timeline for a known task', async () => {
    const res = await get(cloudTimelinePath(ID));
    expect(res.status).toBe(200);
    const body = res.json as CloudTimelineResponse;
    expect(body).toMatchObject({ v: 1, taskId: ID, repo: 'ashlrai/ashlr-hub', state: 'pr-open' });
    expect(body.steps.map((s) => s.kind)).toEqual([...TIMELINE_STEP_ORDER]);
    expect(body.steps.find((s) => s.kind === 'report')?.verified).toBe(false);
  });

  it('404 for a task that does not exist', async () => {
    const res = await get(cloudTimelinePath('ct_20260925T1200_zzzzzz'));
    expect(res.status).toBe(404);
  });

  it('400 for an id that is not a cloud task id, and for any query parameter', async () => {
    expect((await get('/api/verse/cloud/tasks/not-an-id/timeline')).status).toBe(400);
    const q = await get(`${cloudTimelinePath(ID)}?limit=5`);
    expect(q.status).toBe(400);
    expect((q.json as { error: string }).error).toBe('Unknown query parameter: limit.');
  });

  it('only GET: any other verb is a 404', async () => {
    expect((await get(cloudTimelinePath(ID), 'POST')).status).toBe(404);
    expect((await get(cloudTimelinePath(ID), 'DELETE')).status).toBe(404);
  });

  it('a failing store is a message-free 500 (no paths)', async () => {
    readThrows = true;
    const res = await get(cloudTimelinePath(ID));
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ error: 'cloud timeline failed' });
  });

  it('declines every other path without writing, including the rest of the cloud family', async () => {
    for (const p of ['/api/verse/cloud', '/api/verse/cloud/tasks', `/api/verse/cloud/tasks/${ID}/dismiss`, `/api/verse/cloud/tasks/${ID}/timeline/x`, '/api/verse/health']) {
      expect((await get(p)).status, p).toBe(418);
    }
  });
});

describe('mounting', () => {
  it('the real mount table asks cloud-timeline before cloud, so the timeline path is never cloud’s 404', async () => {
    setMountedApiModulesForTest(null);
    const ids = mountedApiModules().map((m) => m.id);
    expect(ids.indexOf('cloud-timeline')).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf('cloud-timeline')).toBe(ids.indexOf('cloud') - 1);
    const entries = mountedApiModules().filter((m) => m.id === 'cloud-timeline' || m.id === 'cloud');
    const loaded = await Promise.all(entries.map(async (m) => ({ id: m.id, h: await m.load() })));
    handler = async (c, req, res, p, method) => {
      for (const { h } of loaded) {
        if (await h(c, req, res, p, method)) return true;
      }
      return false;
    };
    const res = await fetch(`${base}${cloudTimelinePath(ID)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as CloudTimelineResponse;
    expect(body.taskId).toBe(ID);
  });
});
