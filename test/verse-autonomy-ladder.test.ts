/**
 * 3.14 — the autonomy ladder and shadow decisions (src/core/verse/autonomy-ladder.ts),
 * and the ADDITIVE fields they put on the existing authority routes:
 *   GET /api/verse/authority                     + `ladder`
 *   GET /api/verse/authority/ledger?view=decisions
 *
 * Same harness as authority-api-310b: in-memory request/response, a faked
 * custody helper and test trust root, HOME-isolated (never the real ledger).
 */
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ roots: [] as unknown[] }));

vi.mock('../src/core/authority/trust-roots.js', () => ({
  STANDING_GRANT_TRUST_ROOTS: state.roots,
  BURNED_KEY_IDS: Object.freeze(['mason-workstation']),
}));

vi.mock('../src/core/authority/surface.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/core/authority/surface.js')>();
  return {
    ...original,
    currentHostBinding: () => 'a'.repeat(64),
    confinementAvailable: () => ({ ok: true }),
    runningPackageRoot: () => '/test/release',
    verifyAuthoritySurface: (target: 'running' | 'installed') => ({
      ok: true, target, packageRoot: '/test/release', digest: 'b'.repeat(64), fileCount: 1, checkedAt: new Date().toISOString(),
    }),
  };
});

vi.mock('../src/core/authority/custody-client.js', async (importOriginal) => {
  const helpers = await import('./helpers/authority-310b.js');
  return {
    ...(await importOriginal<typeof import('../src/core/authority/custody-client.js')>()),
    custodyStatus: async () => ({
      installed: true, version: 'test', keyInitialized: true, keyId: helpers.TEST_KEY_ID,
      githubApp: false, claudeToken: null, checkedAt: new Date().toISOString(), reasons: [],
    }),
    signGrant: async (payload: import('../src/core/authority/types.js').StandingGrantV1) => helpers.signGrant(payload),
  };
});

import { handleAuthorityApi, resetAuthorityApiCachesForTest } from '../src/core/verse/authority-api.js';
import {
  autonomyLadder,
  readShadowDecisions,
  resetShadowDecisionsCacheForTest,
  shadowDecisionsFromLedger,
  type AutonomyLadderV1,
  type ShadowDecisionsV1,
} from '../src/core/verse/autonomy-ladder.js';
import { invalidateStandingPolicyCache } from '../src/core/authority/effective-config.js';
import { appendLedger, resetLedgerCachesForTest } from '../src/core/authority/ledger.js';
import type { LedgerEntry, LedgerReadResult } from '../src/core/authority/types.js';
import type { GateId } from '../src/core/fleet/fleet-types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import { makeGrant, TEST_ROOT, withTempHome } from './helpers/authority-310b.js';

const GRANT = '0123456789abcdef0123456789abcdef';
const HEAD_A = 'a1b2c3d'.padEnd(40, '0');
const HEAD_B = 'bbbbbbb'.padEnd(40, '1');
const ALL_GATES: GateId[] = ['G0', 'G1', 'G1b', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'];

// ---------------------------------------------------------------------------
// Pure: the ladder
// ---------------------------------------------------------------------------

describe('autonomyLadder (pure)', () => {
  it('is null without a grant', () => {
    expect(autonomyLadder({ grant: null, position: null, lastRolloutMove: null })).toBeNull();
  });

  it('lists every signed stage with who merges, who proposes, caps and what the criterion counts', () => {
    const grant = makeGrant();
    const ladder = autonomyLadder({
      grant,
      position: { stageIndex: 1, stageId: '2a', enteredAt: '2026-09-26T10:00:00.000Z', entrySeq: 7 },
      lastRolloutMove: {
        grantId: grant.grantId, stageIndex: 1, stageId: '2a', enteredAt: '2026-09-26T10:00:00.000Z', entrySeq: 7,
        move: 'advanced', fromStageId: 'shadow', breach: null,
      },
    })!;
    expect(ladder.stages.map((s) => s.id)).toEqual(['shadow', '2a', 'full']);
    expect(ladder.stages[0]).toMatchObject({
      index: 0, merging: [], proposing: ['ashlrai/fleet-canary', 'ashlrai/ashlrcode'],
      maxRisk: 'low', maxFiles: 4, maxLines: 150, counts: 'would-merge digests', criteria: { minMerges: 2 },
    });
    expect(ladder.stages[1]).toMatchObject({ merging: ['ashlrai/fleet-canary', 'ashlrai/ashlrcode'], proposing: [], counts: 'merges' });
    expect(ladder.currentIndex).toBe(1);
    expect(ladder.lastMove).toEqual({ move: 'advanced', fromStageId: 'shadow', toStageId: '2a', at: '2026-09-26T10:00:00.000Z', breach: null });
  });

  it('ignores a move recorded for another grant', () => {
    const grant = makeGrant();
    const ladder = autonomyLadder({
      grant,
      position: null,
      lastRolloutMove: { grantId: 'f'.repeat(32), stageIndex: 0, stageId: 'shadow', enteredAt: 'x', entrySeq: 1, move: 'regressed', fromStageId: '2a', breach: 'b' },
    })!;
    expect(ladder.lastMove).toBeNull();
    expect(ladder.currentIndex).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pure: the decisions fold
// ---------------------------------------------------------------------------

let seq = 0;
function row<K extends LedgerEntry['kind']>(kind: K, data: Extract<LedgerEntry, { kind: K }>['data'], at: string, repo: string | null = null): LedgerEntry {
  seq += 1;
  return { v: 1, seq, at, actor: 'daemon', grantId: GRANT, repo, prevHash: '0'.repeat(64), hash: '0'.repeat(64), kind, data } as LedgerEntry;
}

function gate(proposalId: string, g: GateId, verdict: 'pass' | 'refuse' | 'owner-lane' | 'wait', at: string, head = HEAD_A, reason = `${g} ok`, code = 'ok'): LedgerEntry {
  return row('gate:result', { v: 1, gate: g, proposalId, repo: 'ashlrai/ashlrcode', headSha: head, verdict, code, reason, at, digest: 'd'.repeat(64) }, at, 'ashlrai/ashlrcode');
}

function wouldMerge(proposalId: string, at: string, head = HEAD_A): LedgerEntry {
  return row('gate:would-merge', {
    v: 1, proposalId, repo: 'ashlrai/ashlrcode', headSha: head, gatesDigest: 'e'.repeat(64), withheldBecause: 'shadow',
    risk: 'low', files: 2, linesAdded: 30, linesDeleted: 4, at,
  }, at, 'ashlrai/ashlrcode');
}

function read(entries: LedgerEntry[]): Pick<LedgerReadResult, 'entries' | 'chain' | 'reason' | 'head'> {
  const last = entries[entries.length - 1];
  return { entries, chain: 'ok', reason: null, head: last ? { seq: last.seq, hash: last.hash, at: last.at } : null };
}

describe('shadowDecisionsFromLedger (pure)', () => {
  beforeEach(() => { seq = 0; });

  const accepted = () => row('grant:accepted', {
    grantId: GRANT, grantSeq: 1, keyId: 'k', issuedAt: 't', expiresAt: 't', authoritySurfaceDigest: 'b'.repeat(64), stageIds: ['shadow', '2a'], envelopeDigest: 'c'.repeat(64),
  }, '2026-09-26T00:00:00.000Z');

  it('folds gates, would-merge, refusals, owner lane and waits into one row per proposal, newest first', () => {
    const entries = [
      accepted(),
      ...ALL_GATES.map((g) => gate('p1', g, 'pass', '2026-09-26T01:00:00.000Z')),
      wouldMerge('p1', '2026-09-26T01:01:00.000Z'),
      gate('p2', 'G0', 'pass', '2026-09-26T02:00:00.000Z'),
      gate('p2', 'G1', 'pass', '2026-09-26T02:00:00.000Z'),
      gate('p2', 'G1b', 'pass', '2026-09-26T02:00:00.000Z'),
      gate('p2', 'G2', 'refuse', '2026-09-26T02:00:01.000Z', HEAD_A, 'the diff touches src/core/authority (a protected path)', 'protected-path'),
      gate('p3', 'G0', 'pass', '2026-09-26T03:00:00.000Z'),
      gate('p3', 'G3', 'owner-lane', '2026-09-26T03:00:01.000Z', HEAD_A, 'risk is high', 'risk-over-cap'),
      gate('p4', 'G5', 'wait', '2026-09-26T04:00:00.000Z', HEAD_A, 'no different-family judge has headroom', 'no-judge'),
      gate('p5', 'G0', 'pass', '2026-09-26T05:00:00.000Z'),
    ];
    const out = shadowDecisionsFromLedger(read(entries));
    expect(out.decisions.map((d) => [d.proposalId, d.outcome])).toEqual([
      ['p5', 'in-progress'], ['p4', 'waiting'], ['p3', 'owner-lane'], ['p2', 'refused'], ['p1', 'would-merge'],
    ]);
    const p1 = out.decisions.find((d) => d.proposalId === 'p1')!;
    expect(p1).toMatchObject({
      repo: 'ashlrai/ashlrcode', headShort: 'a1b2c3d', withheldBecause: 'shadow', risk: 'low', files: 2, linesAdded: 30, linesDeleted: 4, stageId: 'shadow',
      why: 'Every gate passed; held because the ladder is in shadow, so it only proposes.',
    });
    expect(p1.gates.map((g) => g.gate)).toEqual(ALL_GATES);
    expect(out.decisions.find((d) => d.proposalId === 'p2')!.why).toBe('Refused at G2: the diff touches src/core/authority (a protected path).');
    expect(out.decisions.find((d) => d.proposalId === 'p3')!.why).toBe('G3 sent it to the owner lane: risk is high.');
    expect(out.decisions.find((d) => d.proposalId === 'p4')!.why).toMatch(/^Waiting at G5: /);
    expect(out.wouldMergeByStage).toEqual({ shadow: 1 });
    expect(out.headSeq).toBe(entries[entries.length - 1]!.seq);
  });

  it('attributes decisions to the stage current when they were written, and lists moves newest first', () => {
    const entries = [
      accepted(),
      wouldMerge('p1', '2026-09-26T01:00:00.000Z'),
      row('rollout:advanced', { grantId: GRANT, fromStageId: 'shadow', toStageId: '2a', toStageIndex: 1, evidence: { hoursInStage: 12, merges: 5, postMergeGreenPct: null, revertRatePct: null, sandboxViolations: 0, reserveBreaches: 0 } }, '2026-09-26T12:00:00.000Z'),
      row('merge:landed', { proposalId: 'p2', repo: 'ashlrai/ashlrcode', prNumber: 41 } as never, '2026-09-26T13:00:00.000Z', 'ashlrai/ashlrcode'),
      row('rollout:regressed', { grantId: GRANT, fromStageId: '2a', toStageId: 'shadow', toStageIndex: 0, breach: '1 sandbox violation in stage 2a', evidence: { hoursInStage: 1, merges: 1, postMergeGreenPct: null, revertRatePct: null, sandboxViolations: 1, reserveBreaches: 0 } }, '2026-09-26T14:00:00.000Z'),
    ];
    const out = shadowDecisionsFromLedger(read(entries));
    expect(out.decisions.find((d) => d.proposalId === 'p1')).toMatchObject({ stageId: 'shadow', outcome: 'would-merge' });
    expect(out.decisions.find((d) => d.proposalId === 'p2')).toMatchObject({ stageId: '2a', outcome: 'merged', prNumber: 41 });
    expect(out.moves).toEqual([
      { move: 'regressed', fromStageId: '2a', toStageId: 'shadow', at: '2026-09-26T14:00:00.000Z', breach: '1 sandbox violation in stage 2a.' },
      { move: 'advanced', fromStageId: 'shadow', toStageId: '2a', at: '2026-09-26T12:00:00.000Z', breach: null },
    ]);
  });

  it('a new head re-runs the gates: a refusal on the old head does not stick to the new one', () => {
    const entries = [
      accepted(),
      gate('p1', 'G2', 'refuse', '2026-09-26T01:00:00.000Z', HEAD_A, 'too big', 'size'),
      ...ALL_GATES.map((g) => gate('p1', g, 'pass', '2026-09-26T02:00:00.000Z', HEAD_B)),
      wouldMerge('p1', '2026-09-26T02:01:00.000Z', HEAD_B),
    ];
    const [p1] = shadowDecisionsFromLedger(read(entries)).decisions;
    expect(p1).toMatchObject({ outcome: 'would-merge', headShort: 'bbbbbbb' });
    expect(p1!.gates.every((g) => g.verdict === 'pass')).toBe(true);
  });

  it('caps the rows and links the PR a proposal opened', () => {
    const entries = [accepted()];
    for (let i = 0; i < 10; i += 1) entries.push(gate(`p${i}`, 'G0', 'pass', `2026-09-26T0${i}:00:00.000Z`));
    entries.push(row('pr:opened', { v: 1, repo: 'ashlrai/ashlrcode', number: 7, proposalId: 'p9', branch: 'ashlr/fleet/p9', headSha: HEAD_A, kind: 'change', ownerLane: false, at: 't' }, '2026-09-26T09:30:00.000Z'));
    const out = shadowDecisionsFromLedger(read(entries), { limit: 3 });
    expect(out.decisions.map((d) => d.proposalId)).toEqual(['p9', 'p8', 'p7']);
    expect(out.decisions[0]!.prNumber).toBe(7);
  });

  it('reads once per ledger head (the cache skips the read while the head is unchanged)', async () => {
    resetShadowDecisionsCacheForTest();
    const entries = [accepted(), wouldMerge('p1', '2026-09-26T01:00:00.000Z')];
    const head = { seq: entries[1]!.seq, hash: 'h1' };
    const readLedger = vi.fn(async () => ({ entries, chain: 'ok' as const, reason: null, brokenAtSeq: null, head: { ...head, at: 't' } }));
    const first = await readShadowDecisions({ readLedger, head: () => head });
    const second = await readShadowDecisions({ readLedger, head: () => head });
    expect(second).toBe(first);
    expect(readLedger).toHaveBeenCalledTimes(1);
    await readShadowDecisions({ readLedger, head: () => ({ seq: head.seq + 1, hash: 'h2' }) });
    expect(readLedger).toHaveBeenCalledTimes(2);
    resetShadowDecisionsCacheForTest();
  });
});

// ---------------------------------------------------------------------------
// The routes (additive fields)
// ---------------------------------------------------------------------------

const TOKEN = 'ladder-test-token';
let restore: () => void;
let ctx: VerseApiContext;

async function call(method: string, url: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(req, { method, url, headers: { 'content-type': 'application/json', 'x-ashlr-token': TOKEN } });
  req.end(body === undefined ? undefined : JSON.stringify(body));
  let status = 0;
  let payload = '';
  const fake = { headersSent: false };
  const res = Object.assign(fake, {
    writeHead(code: number) { status = code; fake.headersSent = true; return fake; },
    end(chunk?: string) { payload = chunk ?? ''; return fake; },
  }) as unknown as ServerResponse;
  const handled = await handleAuthorityApi(ctx, req, res, new URL(url, 'http://localhost').pathname, method);
  return handled ? { status, body: JSON.parse(payload || 'null') as Record<string, unknown> } : null;
}

describe('GET /api/verse/authority + ledger?view=decisions', () => {
  beforeEach(() => {
    restore = withTempHome('ladder-api-').restore;
    state.roots.length = 0;
    ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true };
    resetLedgerCachesForTest();
    invalidateStandingPolicyCache();
    resetAuthorityApiCachesForTest();
  });

  afterEach(() => {
    resetLedgerCachesForTest();
    invalidateStandingPolicyCache();
    resetAuthorityApiCachesForTest();
    restore();
  });

  it('no grant: ladder is null and the decisions view is empty but answers', async () => {
    const status = await call('GET', '/api/verse/authority');
    expect(status?.status).toBe(200);
    expect(status!.body['ladder']).toBeNull();
    const view = await call('GET', '/api/verse/authority/ledger?view=decisions');
    expect(view?.status).toBe(200);
    expect(view!.body).toMatchObject({ v: 1, decisions: [], moves: [] });
  });

  it('rejects an unknown view, and view combined with kind', async () => {
    expect((await call('GET', '/api/verse/authority/ledger?view=nope'))?.status).toBe(400);
    expect((await call('GET', '/api/verse/authority/ledger?view=decisions&kind=gate:result'))?.status).toBe(400);
    // The plain ledger read is unchanged.
    const plain = await call('GET', '/api/verse/authority/ledger?limit=5');
    expect(plain?.status).toBe(200);
    expect(Array.isArray(plain!.body['entries'])).toBe(true);
  });

  it('an active grant carries its ladder, and a would-merge digest shows up as a shadow decision', async () => {
    state.roots.push(TEST_ROOT);
    const draft = await call('GET', '/api/verse/authority/draft');
    const granted = await call('POST', '/api/verse/authority', { action: 'grant', draftDigest: draft!.body['digest'] });
    expect(granted?.status).toBe(200);
    // The POST answers the status too — with the ladder.
    const ladder = granted!.body['ladder'] as AutonomyLadderV1;
    expect(ladder.stages[0]).toMatchObject({ id: 'shadow', index: 0, merging: [], counts: 'would-merge digests', criteria: { minMerges: 5, minHours: 12 } });
    expect(ladder.stages.length).toBeGreaterThan(1);
    expect(ladder.stages.some((s) => s.merging.length > 0)).toBe(true);
    expect(ladder.currentIndex).toBe(0);
    expect(ladder.lastMove).toBeNull();
    expect(ladder.grantId).toBe((granted!.body['grant'] as { grantId: string }).grantId);

    const grantId = ladder.grantId;
    for (const g of ALL_GATES) {
      expect(appendLedger({ kind: 'gate:result', actor: 'daemon', grantId, repo: 'ashlrai/fleet-canary', data: { v: 1, gate: g, proposalId: 'prop-1', repo: 'ashlrai/fleet-canary', headSha: HEAD_A, verdict: 'pass', code: 'ok', reason: 'fine', at: new Date().toISOString(), digest: 'd'.repeat(64) } }).ok).toBe(true);
    }
    appendLedger({ kind: 'gate:would-merge', actor: 'daemon', grantId, repo: 'ashlrai/fleet-canary', data: { v: 1, proposalId: 'prop-1', repo: 'ashlrai/fleet-canary', headSha: HEAD_A, gatesDigest: 'e'.repeat(64), withheldBecause: 'shadow', risk: 'low', files: 1, linesAdded: 3, linesDeleted: 1, at: new Date().toISOString() } });

    const view = await call('GET', '/api/verse/authority/ledger?view=decisions&limit=10');
    expect(view?.status).toBe(200);
    const decisions = view!.body as unknown as ShadowDecisionsV1;
    expect(decisions.decisions).toHaveLength(1);
    expect(decisions.decisions[0]).toMatchObject({ proposalId: 'prop-1', repo: 'ashlrai/fleet-canary', outcome: 'would-merge', stageId: 'shadow', headShort: 'a1b2c3d' });
    expect(decisions.decisions[0]!.gates).toHaveLength(ALL_GATES.length);
    expect(decisions.wouldMergeByStage).toEqual({ shadow: 1 });

    const status = await call('GET', '/api/verse/authority');
    expect(status!.body['rollout']).toMatchObject({ stageId: 'shadow', merges: 1 });
    // The grant flow signs and verifies real ES256 grants: slower than a unit test's default budget under load.
  }, 30_000);
});
