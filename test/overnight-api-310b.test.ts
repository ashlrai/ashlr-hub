/**
 * V3.10 Track B (U5): the Overnight backend — `/api/verse/overnight` GET/POST
 * over daemon/overnight-status.ts, including `discarded[]`, and the morning
 * report. Driven through a real http server (the production mutation gate,
 * body cap and sanitizer), HOME-isolated, daemon liveness and the kill switch
 * injected. Arming never starts anything.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import {
  buildOvernightReport,
  handleOvernightApi,
  setOvernightApiDepsForTest,
  type OvernightActionResult,
  type OvernightReportV1,
  type OvernightStatusView,
} from '../src/core/verse/overnight-api.js';
import {
  adoptOvernightRun,
  pendingOvernightRun,
  readOvernightStatus,
  recordOvernightLedgerRows,
  requestOvernightRun,
} from '../src/core/daemon/overnight-status.js';
import type { DaemonLivenessV1 } from '../src/core/daemon/liveness.js';
import type { LedgerEntry } from '../src/core/authority/types.js';
import type { LandingRecord } from '../src/core/fleet/fleet-types.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const TOKEN = 'test-mutation-token';
let server: http.Server;
let base: string;
let ctx: VerseApiContext;
let kill: 'active' | 'inactive' | 'unknown';
let enrolled: number | null;
let alive: boolean | null;

function liveness(): DaemonLivenessV1 {
  return {
    v: 1,
    checkedAt: new Date().toISOString(),
    state: alive === true ? 'alive' : alive === false ? 'stopped' : 'unknown',
    alive,
    pid: alive ? 4242 : null,
    recorded: { running: alive, pid: null, startedAt: null, lastTickAt: null },
    lock: null,
    activity: null,
    staleRecord: false,
    reason: alive ? 'Running as pid 4242.' : 'The daemon is not running.',
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    void handleOvernightApi(ctx, req, res, url.pathname, req.method ?? 'GET').then((handled) => {
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
});

beforeEach(() => {
  rmSync(join(homedir(), '.ashlr'), { recursive: true, force: true });
  ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true };
  kill = 'inactive';
  enrolled = 3;
  alive = false;
  setOvernightApiDepsForTest({
    killSwitch: () => kill,
    enrolledCount: () => enrolled,
    liveness,
    autoMerge: () => false,
    halts: () => [],
  });
});

afterEach(() => {
  setOvernightApiDepsForTest();
  rmSync(join(homedir(), '.ashlr'), { recursive: true, force: true });
});

async function get<T>(p: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, body: (await res.json()) as T };
}

async function post<T>(body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}/api/verse/overnight`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ashlr-token': TOKEN, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

describe('GET /api/verse/overnight', () => {
  it('answers a disarmed status with the daemon\'s real liveness', async () => {
    const res = await get<OvernightStatusView>('/api/verse/overnight');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ armed: false, run: null, pending: false, daemon: { state: 'stopped', alive: false } });
  });

  it('refuses unknown query parameters', async () => {
    expect((await get('/api/verse/overnight?x=1')).status).toBe(400);
  });
});

describe('POST arm / disarm', () => {
  it('arms a PENDING run (no start time claimed) and says no daemon will start from it', async () => {
    const res = await post<OvernightActionResult>({ action: 'arm', stopRule: { kind: 'after-iterations', iterations: 3 } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.note).toMatch(/No daemon is running right now/);
    expect(res.body.note).toMatch(/Arming never starts one/);
    expect(res.body.status).toMatchObject({ armed: true, pending: true, run: { startedAt: null, iterationsDone: null, stopRule: { kind: 'after-iterations', iterations: 3 } } });
    expect(pendingOvernightRun()).not.toBeNull();
  });

  it('tells Mason a running daemon takes it on its next cycle', async () => {
    alive = true;
    const res = await post<OvernightActionResult>({ action: 'arm', stopRule: { kind: 'until-paused' } });
    expect(res.body.note).toMatch(/running daemon takes it on its next cycle/);
  });

  it('refuses a second arm while one is pending or running', async () => {
    await post({ action: 'arm', stopRule: { kind: 'until-paused' } });
    const again = await post<OvernightActionResult>({ action: 'arm', stopRule: { kind: 'until-paused' } });
    expect(again.status).toBe(409);
    expect(again.body.note).toMatch(/already armed/);
    adoptOvernightRun({ pid: 4242 });
    const running = await post<OvernightActionResult>({ action: 'arm', stopRule: { kind: 'until-paused' } });
    expect(running.status).toBe(409);
    expect(running.body.note).toMatch(/already in progress/);
  });

  it('refuses while the kill switch is engaged or unreadable, and with nothing enrolled', async () => {
    kill = 'active';
    let res = await post<OvernightActionResult>({ action: 'arm', stopRule: { kind: 'until-paused' } });
    expect(res.status).toBe(409);
    expect(res.body.note).toMatch(/kill switch is engaged/);
    kill = 'unknown';
    res = await post<OvernightActionResult>({ action: 'arm', stopRule: { kind: 'until-paused' } });
    expect(res.body.note).toMatch(/could not be read/);
    kill = 'inactive';
    enrolled = 0;
    res = await post<OvernightActionResult>({ action: 'arm', stopRule: { kind: 'until-paused' } });
    expect(res.body.note).toMatch(/no repositories are enrolled/);
    expect(readOvernightStatus().armed).toBe(false);
  });

  it('refuses a stop time already in the past with the run-window module\'s own sentence', async () => {
    const res = await post<{ code: string; error: string }>({ action: 'arm', stopRule: { kind: 'at-time', at: new Date(Date.now() - 60_000).toISOString() } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/in the past/);
  });

  it('validates the body strictly', async () => {
    expect((await post({ action: 'arm', stopRule: { kind: 'until-paused', extra: 1 } })).status).toBe(400);
    expect((await post({ action: 'arm', stopRule: { kind: 'after-iterations', iterations: 0 } })).status).toBe(400);
    expect((await post({ action: 'arm', stopRule: { kind: 'forever' } })).status).toBe(400);
    expect((await post({ action: 'arm', stopRule: { kind: 'until-paused' }, x: 1 })).status).toBe(400);
    expect((await post({ action: 'launch' })).status).toBe(400);
    expect((await post({ action: 'disarm', why: 'x' })).status).toBe(400);
  });

  it('is behind the mutation gate and the dispatch switch', async () => {
    expect((await post({ action: 'disarm' }, { 'x-ashlr-token': 'wrong' })).status).toBe(401);
    ctx = { ...ctx, allowDispatch: false };
    expect((await post({ action: 'disarm' })).status).toBe(404);
  });

  it('disarms a pending run, and leaves a running one alone (pause stops it)', async () => {
    await post({ action: 'arm', stopRule: { kind: 'until-paused' } });
    const disarmed = await post<OvernightActionResult>({ action: 'disarm' });
    expect(disarmed.body).toMatchObject({ ok: true, note: 'Disarmed: the armed run will not start.' });
    expect(readOvernightStatus().armed).toBe(false);

    requestOvernightRun({ kind: 'until-paused' });
    adoptOvernightRun({ pid: 1 });
    const running = await post<OvernightActionResult>({ action: 'disarm' });
    expect(running.body.note).toMatch(/not stopped by disarming/);
    expect(readOvernightStatus().armed).toBe(true);
    const nothing = await post<OvernightActionResult>({ action: 'arm', stopRule: { kind: 'until-paused' } });
    expect(nothing.status).toBe(409);
  });
});

describe('the daemon side: adoption and the ledger fold', () => {
  let seq = 0;
  const row = <K extends LedgerEntry['kind']>(kind: K, data: Extract<LedgerEntry, { kind: K }>['data'], at: string): LedgerEntry =>
    ({ v: 1, seq: seq++, at, actor: 'daemon', grantId: 'g', repo: 'ashlrai/binshield', prevHash: '0'.repeat(64), hash: '1'.repeat(64), kind, data } as LedgerEntry);
  const landing = (id: string, kind: 'merge' | 'revert', over: Partial<LandingRecord> = {}): LandingRecord => ({
    v: 1, id, kind, repo: 'ashlrai/binshield', baseBranch: 'main', prNumber: 12, headSha: 'a'.repeat(40), mergeSha: 'b'.repeat(40),
    proposalId: kind === 'merge' ? 'p-1' : null, revertsLandingId: kind === 'revert' ? 'L1' : null, grantId: 'g', rolloutStageId: '2a',
    gatesDigest: 'c'.repeat(64), ledgerHead: 'e'.repeat(64), enforcement: 'server', risk: 'low', files: 1, linesAdded: 3, linesDeleted: 1,
    producer: null, judgeId: null, proposedAt: null, landedAt: '2026-09-24T02:00:00.000Z', watchUntil: '2026-09-24T04:00:00.000Z', ...over,
  });

  it('a pending run is adopted exactly once, then counts iterations', () => {
    requestOvernightRun({ kind: 'after-iterations', iterations: 2 });
    const adopted = adoptOvernightRun({ pid: 7, now: () => Date.parse('2026-09-24T00:00:00.000Z') });
    expect(adopted?.run).toMatchObject({ startedAt: '2026-09-24T00:00:00.000Z', iterationsDone: 0 });
    expect(adoptOvernightRun({ pid: 8 })).toBeNull();
  });

  it('folds landings, work-gate refusals and reverts into merged / discarded — once', () => {
    requestOvernightRun({ kind: 'until-paused' });
    adoptOvernightRun({ pid: 7 });
    const rows = [
      row('merge:landed', landing('L1', 'merge'), '2026-09-24T02:00:00.000Z'),
      row('gate:result', { v: 1, gate: 'G3', proposalId: 'p-2', repo: 'ashlrai/binshield', headSha: 'd'.repeat(40), verdict: 'refuse', code: 'verify-failed', reason: 'npm test failed: 2 failing', at: '2026-09-24T02:10:00.000Z', digest: 'f'.repeat(64) }, '2026-09-24T02:10:00.000Z'),
      row('gate:result', { v: 1, gate: 'G0', proposalId: 'p-3', repo: 'ashlrai/binshield', headSha: null, verdict: 'refuse', code: 'daily-cap', reason: 'cap reached', at: '2026-09-24T02:11:00.000Z', digest: 'f'.repeat(64) }, '2026-09-24T02:11:00.000Z'),
      row('revert:landed', landing('R1', 'revert', { prNumber: 13, landedAt: '2026-09-24T03:00:00.000Z' }), '2026-09-24T03:00:00.000Z'),
    ];
    const titleOf = (id: string) => (id === 'p-1' ? 'Fix the parser' : null);
    recordOvernightLedgerRows(rows, { titleOf, iterationsDone: 4 });
    recordOvernightLedgerRows(rows, { titleOf });
    const run = readOvernightStatus().run!;
    expect(run.merged).toEqual([{ id: 'p-1', repo: 'ashlrai/binshield', title: 'Fix the parser', at: '2026-09-24T02:00:00.000Z', commit: 'b'.repeat(40) }]);
    expect(run.discarded.map((d) => d.reason)).toEqual([
      'G3 refused it: npm test failed: 2 failing',
      expect.stringMatching(/^reverted after a red post-merge check \(revert PR #13/),
    ]);
    expect(run.iterationsDone).toBe(4);
  });

  it('does nothing without a run in progress', () => {
    const before = readOvernightStatus();
    recordOvernightLedgerRows([row('merge:landed', landing('L9', 'merge'), '2026-09-24T02:00:00.000Z')]);
    expect(readOvernightStatus()).toEqual(before);
  });
});

describe('the morning report', () => {
  it('says so when nothing was ever armed', async () => {
    const res = await get<OvernightReportV1>('/api/verse/overnight/report');
    expect(res.body).toMatchObject({ v: 1, state: 'none', run: null, counts: null });
  });

  it('summarises a concluded run with counts, duration and the halts inside it', () => {
    const report = buildOvernightReport({
      armed: false,
      repos: 3,
      gate: null,
      run: {
        runId: 'r',
        startedAt: '2026-09-24T00:00:00.000Z',
        stopRule: { kind: 'at-time', at: '2026-09-24T07:00:00.000Z' },
        iterationsDone: 40,
        repo: 'ashlrai/binshield',
        activity: 'run-window-clock-reached — window reached',
        merged: [{ id: 'p-1', repo: 'ashlrai/binshield', title: 't', at: '2026-09-24T02:00:00.000Z', commit: 'b'.repeat(40) }],
        discarded: [
          { id: 'p-2', repo: 'ashlrai/binshield', title: 't', at: '2026-09-24T03:00:00.000Z', reason: 'G3 refused it: tests failed' },
          { id: 'L1', repo: 'ashlrai/binshield', title: 't', at: '2026-09-24T04:00:00.000Z', reason: 'reverted after a red post-merge check (revert PR #13)' },
        ],
      },
    }, [
      { at: '2026-09-23T20:00:00.000Z', detail: 'before the run', revertPlan: [] },
      { at: '2026-09-24T05:00:00.000Z', detail: 'FLEET ESCALATION', revertPlan: [] },
    ], Date.parse('2026-09-24T08:00:00.000Z'));
    expect(report.state).toBe('concluded');
    expect(report.counts).toEqual({ merged: 1, discarded: 2, reverted: 1, halts: 1 });
    expect(report.durationMs).toBe(4 * 3_600_000);
    expect(report.headline).toMatch(/^Last run: 1 merge, 2 discarded \(1 reverted\), 1 halt\./);
  });

  it('reports a pending run honestly', () => {
    const report = buildOvernightReport({
      armed: true, repos: 3, gate: null,
      run: { runId: 'r', startedAt: null, stopRule: { kind: 'until-paused' }, iterationsDone: null, repo: null, activity: null, merged: [], discarded: [] },
    }, [], Date.now());
    expect(report.state).toBe('pending');
    expect(report.durationMs).toBeNull();
  });
});

describe('mount chain', () => {
  it('answers false for paths it does not own', async () => {
    const req = {} as http.IncomingMessage;
    const res = {} as http.ServerResponse;
    for (const path of ['/api/verse/fleet/live', '/api/verse/overnightx', '/api/verse/overnight/other']) {
      await expect(handleOvernightApi(ctx, req, res, path, 'GET')).resolves.toBe(false);
    }
  });
});

describe('mirrors recorded apart from repos (L1 leftover 3)', () => {
  it('an arm records the mirror count next to the repo count, and GET shows it', async () => {
    setOvernightApiDepsForTest({
      killSwitch: () => kill,
      enrolledCount: () => 2,
      mirrorCount: () => 4,
      liveness,
      autoMerge: () => false,
      halts: () => [],
    });
    const res = await post<OvernightActionResult>({ action: 'arm', stopRule: { kind: 'until-paused' } });
    expect(res.status).toBe(200);
    expect(readOvernightStatus()).toMatchObject({ repos: 2, mirrors: 4 });
    const view = await get<OvernightStatusView>('/api/verse/overnight');
    expect(view.body).toMatchObject({ repos: 2, mirrors: 4 });
  });

  it('an unknown mirror count is null (never 0); a status written before the field has none', async () => {
    setOvernightApiDepsForTest({
      killSwitch: () => kill,
      enrolledCount: () => 2,
      mirrorCount: () => null,
      liveness,
      autoMerge: () => false,
      halts: () => [],
    });
    await post({ action: 'arm', stopRule: { kind: 'until-paused' } });
    expect(readOvernightStatus().mirrors).toBeNull();
    const dir = join(homedir(), '.ashlr', 'run-window');
    writeFileSync(join(dir, 'status.json'), JSON.stringify({ recordType: 'daemon-overnight-status', armed: false, repos: 1, gate: null, run: null }));
    expect('mirrors' in readOvernightStatus()).toBe(false);
    writeFileSync(join(dir, 'status.json'), JSON.stringify({ recordType: 'daemon-overnight-status', armed: false, repos: 1, mirrors: -3, gate: null, run: null }));
    expect(readOvernightStatus().mirrors).toBeNull();
  });
});
