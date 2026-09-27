/**
 * 3.15 retro sweep — reads the task ends the system already recorded
 * (authority ledger rows, inbox decisions, cloud task files, Leader actions)
 * and writes one retro per end, idempotently, with the optional model pass.
 * All sources are injected fakes; HOME is isolated by test/setup/home.ts.
 */
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LedgerEntry } from '../src/core/authority/types.js';
import type { CloudTaskV1 } from '../src/core/cloud/types.js';
import type { LeaderAction } from '../src/core/vision/leader-types.js';
import { applyModelReply, loadRetroModel, type RetroModel } from '../src/core/learn/retro/model.js';
import { fleetEndsFromLedger, sweepRetros, type RetroSweepDeps, type SweepProposal } from '../src/core/learn/retro/sweep.js';
import { listRetros, readKnowledge, readSweepState } from '../src/core/learn/retro/store.js';

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

let seq = 0;
function row<K extends LedgerEntry['kind']>(kind: K, data: Extract<LedgerEntry, { kind: K }>['data'], at = iso(NOW - DAY)): LedgerEntry {
  return { v: 1, seq: seq++, at, actor: 'daemon', grantId: 'g', repo: 'ashlrai/widget', prevHash: 'x', hash: 'y', kind, data } as unknown as LedgerEntry;
}

function gate(proposalId: string, g: string, verdict: 'refuse' | 'owner-lane' | 'pass', code: string, reason: string): LedgerEntry {
  return row('gate:result', { v: 1, gate: g as never, proposalId, repo: 'ashlrai/widget', headSha: null, verdict, code, reason, at: iso(NOW - DAY), digest: 'd' });
}

function landing(id: string, kind: 'merge' | 'revert', proposalId: string | null, revertsLandingId: string | null = null): LedgerEntry {
  return row(kind === 'merge' ? 'merge:landed' : 'revert:landed', {
    v: 1, id, kind, repo: 'ashlrai/widget', baseBranch: 'main', prNumber: 7, headSha: 'h', mergeSha: 'm', proposalId, revertsLandingId,
    grantId: 'g', rolloutStageId: 's', gatesDigest: 'gd', ledgerHead: 'lh', enforcement: 'server', risk: 'low', files: 1, linesAdded: 1, linesDeleted: 0,
    producer: kind === 'merge' ? { engine: 'grok-cli', model: 'grok-4.7', family: 'xai', seatId: 'grok-a' } : null,
    judgeId: null, proposedAt: null, landedAt: iso(NOW - DAY), watchUntil: iso(NOW),
  } as never);
}

const PROPOSALS: Record<string, SweepProposal> = {
  'p-refused': {
    id: 'p-refused', title: 'Fix flaky parser test', summary: 'CRLF', status: 'rejected', createdAt: iso(NOW - 2 * DAY),
    diff: '--- a/src/parser/lex.ts\n+++ b/src/parser/lex.ts\n',
    verifyResult: { passed: false, failed: ['test'], failureCategory: 'code', detail: '2 tests failed', ran: [{ kind: 'test', cmd: ['npm', 'test'] }] },
  },
  'p-merged': { id: 'p-merged', title: 'Add retry', summary: '', status: 'applied', createdAt: iso(NOW - 3 * DAY) },
};

function cloudTask(over: Partial<CloudTaskV1>): CloudTaskV1 {
  return {
    v: 1, id: 'ct_20260926T1000_aaaaaa', repo: 'ashlrai/widget', baseBranch: 'main', branch: 'ashlr-cloud/x', title: 'Write docs', prompt: 'Document the uploader',
    origin: 'operator', requestedBy: 'mason', seat: 'claude-a', sessionId: null, sessionUrl: null, state: 'closed', stateReason: 'Not what I asked for: document the CLI, not the API.',
    failure: null, createdAt: iso(NOW - 2 * DAY), launchedAt: null, updatedAt: iso(NOW - DAY), pr: null, report: null, estimatedCostUsd: 0, backlogItemId: null, needsYouId: null,
    ...over,
  } as CloudTaskV1;
}

function leaderAction(over: Partial<LeaderAction>): LeaderAction {
  return {
    v: 1, id: 'la-1', memoId: 'm-1', kind: 'goal.pause', class: 'B', params: {}, summary: 'Pause goal Router cleanup', why: 'low value',
    createdAt: iso(NOW - 2 * DAY), applyAfter: null, deferredForQuietHours: false, status: 'vetoed', statusReason: null, appliedAt: null,
    vetoedAt: iso(NOW - DAY), vetoNote: 'It unblocks the cost work', inverse: null, ...over,
  } as unknown as LeaderAction;
}

function deps(over: Partial<RetroSweepDeps> = {}): RetroSweepDeps {
  const entries = [
    gate('p-refused', 'G3', 'refuse', 'verify-failed', 'verification failed: 2 tests failed'),
    row('pr:opened', { v: 1, repo: 'ashlrai/widget', number: 3, proposalId: 'p-refused', branch: 'ashlr/fleet/p-refused', headSha: 'h', kind: 'change', ownerLane: false, at: iso(NOW - DAY) }),
    row('pr:closed', { repo: 'ashlrai/widget', number: 3, reason: 'gate refused', actor: 'daemon', at: iso(NOW - DAY) }),
    gate('p-owner', 'G1', 'owner-lane', 'protected-ci-config', 'touches protected path .github/workflows/ci.yml'),
    landing('L1', 'merge', 'p-merged'),
    row('post-merge:result', { v: 1, landingId: 'L1', repo: 'ashlrai/widget', mergeSha: 'm', ci: 'red', suite: 'not-run', verdict: 'red', detail: 'CI `test` failed on m', checkedAt: iso(NOW - DAY) }),
    landing('L2', 'revert', null, 'L1'),
    row('pr:closed', { repo: 'ashlrai/widget', number: 9, reason: 'Superseded by #10: smaller change', actor: 'mason', at: iso(NOW - DAY) }),
  ];
  return {
    now: () => NOW,
    readLedger: async () => ({ entries, head: null, chain: 'ok', brokenAtSeq: null, reason: null }) as never,
    decidedProposals: () => [],
    loadProposal: (id) => PROPOSALS[id] ?? null,
    cloudTasks: () => [
      cloudTask({}),
      cloudTask({ id: 'ct_20260926T1000_bbbbbb', state: 'closed', supersededBy: { repo: 'ashlrai/widget', number: 11 } }),
      cloudTask({ id: 'ct_20260926T1000_cccccc', state: 'running' }),
    ],
    leaderActions: () => [leaderAction({}), leaderAction({ id: 'la-2', status: 'applied' })],
    model: null,
    ...over,
  };
}

beforeEach(() => {
  rmSync(join(homedir(), '.ashlr'), { recursive: true, force: true });
  seq = 0;
});

describe('sweep', () => {
  it('writes one retro per recorded end, for every end type, and queues their candidates', async () => {
    const result = await sweepRetros(deps());
    const retros = await listRetros();
    const byKey = Object.fromEntries(retros.map((r) => [r.sourceKey, r]));
    expect(Object.keys(byKey).sort()).toEqual([
      'cloud:ct_20260926T1000_aaaaaa:closed',
      'fleet:ashlrai/widget#9:closed',
      'fleet:p-merged:merged',
      'fleet:p-merged:reverted',
      'fleet:p-owner:owner-laned',
      'fleet:p-refused:verify-failed',
      'leader:la-1:vetoed',
    ]);
    expect(result).toMatchObject({ created: 7, unavailable: [] });
    // Verify output joined from the inbox proposal.
    expect(byKey['fleet:p-refused:verify-failed']!.rootCause!.code).toBe('verify:test');
    expect(byKey['fleet:p-refused:verify-failed']!.paths).toEqual(['src/parser/lex.ts']);
    // The revert joined to its original landing and post-merge verdict.
    expect(byKey['fleet:p-merged:reverted']!.rootCause!.code).toBe('revert:ci-red');
    expect(byKey['fleet:p-merged:merged']!.happened).toContain('grok-cli');
    // A PR the fleet closed after refusing its proposal is NOT a second retro; superseded and running cloud tasks are not ends.
    expect(retros.filter((r) => r.taskId === 'p-refused')).toHaveLength(1);
    const knowledge = await readKnowledge();
    expect(knowledge.length).toBe(result.candidates);
    expect(knowledge.every((n) => n.status === 'pending')).toBe(true);
    expect((await readSweepState()).sweptAt).toBe(iso(NOW));
  });

  it('is idempotent: a second sweep writes nothing new', async () => {
    await sweepRetros(deps());
    const again = await sweepRetros(deps());
    expect(again.created).toBe(0);
    expect(await listRetros()).toHaveLength(7);
  });

  it('a failing source is reported, the rest still run; a broken ledger chain is not read', async () => {
    const r = await sweepRetros(deps({
      readLedger: async () => ({ entries: [], head: null, chain: 'broken', brokenAtSeq: 3, reason: 'x' }) as never,
      cloudTasks: () => { throw new Error('boom'); },
    }));
    expect(r.unavailable).toEqual(['cloud', 'ledger']);
    expect((await listRetros()).map((x) => x.source)).toEqual(['leader']);
  });

  it('respects the per-sweep cap and the window', async () => {
    const r = await sweepRetros(deps(), { maxNew: 2 });
    expect(r.created).toBe(2);
    const old = await sweepRetros(deps({
      readLedger: async () => ({ entries: [], head: null, chain: 'ok', brokenAtSeq: null, reason: null }) as never,
      cloudTasks: () => [cloudTask({ id: 'ct_20260801T1000_dddddd', updatedAt: iso(NOW - 60 * DAY) })],
      leaderActions: () => [],
    }));
    expect(old.created).toBe(0);
  });

  it('inbox ends the ledger did not carry are swept too (and share its keys)', async () => {
    const r = await sweepRetros(deps({
      readLedger: async () => ({ entries: [], head: null, chain: 'empty', brokenAtSeq: null, reason: null }) as never,
      decidedProposals: () => [
        { ...PROPOSALS['p-refused']!, decidedAt: iso(NOW - DAY), decisionReason: 'standing gate G3: verify-failed', result: 'fleet gate G3 refused (verify-failed): 2 tests failed' },
        { id: 'p-x', title: 'Tidy imports', summary: '', status: 'rejected', createdAt: iso(NOW - DAY), decidedAt: iso(NOW - DAY) },
      ],
      cloudTasks: () => [],
      leaderActions: () => [],
    }));
    expect(r.created).toBe(2);
    const keys = (await listRetros()).map((x) => x.sourceKey).sort();
    expect(keys).toEqual(['fleet:p-refused:verify-failed', 'fleet:p-x:closed']);
  });
});

describe('model pass', () => {
  it('refines failure retros only, keeps the deterministic root cause, queues its extra candidate for review', async () => {
    const complete = vi.fn(async () => JSON.stringify({
      doDifferently: ['Run npm test locally with CRLF fixtures before proposing.'],
      betterPrompt: 'Fix the CRLF handling in the lexer and add a CRLF fixture test.',
      candidates: [{ text: 'Parser tests need CRLF fixtures; add one with every lexer change.', pathGlobs: ['src/parser/**'], taskKinds: ['fix', 'bogus'] }],
      rootCause: 'the model may not change this',
    }));
    const model: RetroModel = { engine: 'grok-cli', model: 'grok-4.7', complete };
    await sweepRetros(deps({ model }));
    const retros = await listRetros();
    const refused = retros.find((r) => r.sourceKey === 'fleet:p-refused:verify-failed')!;
    expect(refused.model).toMatchObject({ engine: 'grok-cli' });
    expect(refused.rootCause!.code).toBe('verify:test');
    expect(refused.betterPrompt).toContain('CRLF fixture test');
    expect(refused.candidates.some((c) => c.text.includes('CRLF fixtures') && c.scope.taskKinds.join() === 'fix')).toBe(true);
    // Success and Leader retros are never sent.
    expect(retros.find((r) => r.endKind === 'merged')!.model).toBeNull();
    expect(retros.find((r) => r.source === 'leader')!.model).toBeNull();
    const sentPayloads = complete.mock.calls.map((c) => String((c as unknown[])[1]));
    expect(sentPayloads.every((p) => !p.includes('"endKind":"merged"'))).toBe(true);
    const state = await readSweepState();
    expect(Object.values(state.modelCalls)[0]).toBe(complete.mock.calls.length);
    expect((await readKnowledge()).every((n) => n.status === 'pending')).toBe(true);
  });

  it('malformed or failing replies leave the deterministic retro untouched', async () => {
    const base = (await sweepRetros(deps({ model: { engine: 'local', model: null, complete: async () => { throw new Error('seat down'); } } })), await listRetros());
    expect(base.every((r) => r.model === null)).toBe(true);
    const r = base.find((x) => x.rootCause)!;
    expect(applyModelReply(r, 'not json at all', { engine: 'x', model: null, at: 'now' })).toBe(r);
    expect(applyModelReply(r, '{"doDifferently": [1, 2]}', { engine: 'x', model: null, at: 'now' })).toBe(r);
  });

  it('is off unless foundry.retroModel is true', async () => {
    expect(await loadRetroModel({})).toBeNull();
    expect(await loadRetroModel({ foundry: { retroModel: false } })).toBeNull();
  });
});

describe('ledger joins', () => {
  it('an owner-lane PR later closed by Mason yields both the owner-lane and the close', () => {
    const ends = fleetEndsFromLedger([
      gate('p-o', 'G1', 'owner-lane', 'protected-authority', 'touches protected src/core/authority/x.ts'),
      row('pr:opened', { v: 1, repo: 'ashlrai/widget', number: 4, proposalId: 'p-o', branch: 'b', headSha: 'h', kind: 'change', ownerLane: true, at: iso(NOW) }),
      row('pr:closed', { repo: 'ashlrai/widget', number: 4, reason: 'Not now; the authority refactor lands first', actor: 'mason', at: iso(NOW) }),
    ], () => null);
    expect(ends.map((e) => `${e.proposalId}:${e.endKind}`).sort()).toEqual(['p-o:closed', 'p-o:owner-laned']);
  });
});
