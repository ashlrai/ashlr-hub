/**
 * V3.10 B-U8 — the Leader against the REAL landed units: B-U1's hash-chained
 * authority ledger, U4's repo holds and U5's task queue (tmp HOME). Only the
 * standing policy is a fixture (no grant can exist during the build). A memo
 * applies class-A actions, every row lands on a verified chain, and vetoing
 * the memo undoes all of them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { enactLeaderActions, loadDefaultLeaderDeps, readLeaderDirectives, vetoLeaderMemo } from '../src/core/vision/leader-apply.js';
import { actionIdFor, type AnyLeaderActionDraft } from '../src/core/vision/leader-memo.js';
import { readLedger } from '../src/core/authority/ledger.js';
import { listRepoHolds } from '../src/core/fleet/quarantine.js';
import { makePolicy, useTmpHome } from './helpers/leader-310b-fakes.js';

const home = useTmpHome();
beforeEach(() => home.setup());
afterEach(() => home.teardown());

const MEMO = 'lm-20260924120000-abcdef';

describe('Leader × real ledger / holds / task queue', () => {
  it('applies, records on a verified chain, and a memo veto undoes everything', async () => {
    const deps = await loadDefaultLeaderDeps();
    deps.standingPolicy = () => makePolicy();
    deps.notify = () => undefined;
    const drafts: AnyLeaderActionDraft[] = [
      { kind: 'repo.pause', params: { repo: 'ashlrai/binshield', reason: 'red CI', until: null }, summary: 'Pause binshield', why: 'w' },
      {
        kind: 'work.dispatch',
        params: { task: { repo: 'ashlrai/binshield', source: 'leader', title: 'Add parser tests', detail: 'd', difficulty: 'low', value: 3, requestedBy: 'leader', goalId: null, dedupeKey: null } },
        summary: 'Dispatch', why: 'w',
      },
      { kind: 'lanes.grok', params: { slots: 1 }, summary: 'Fewer lanes', why: 'w' },
    ];
    const actions = await enactLeaderActions(deps, MEMO, drafts, [], { idFor: (i) => actionIdFor(MEMO, i) });
    expect(actions.map((a) => a.status)).toEqual(['applied', 'applied', 'applied']);
    expect(listRepoHolds().map((h) => [h.repo, h.kind])).toEqual([['ashlrai/binshield', 'leader-pause']]);
    expect(readLeaderDirectives()?.grokLanes).toBe(1);

    const chain = await readLedger({ kinds: ['leader:action'] });
    expect(chain.chain).toBe('ok');
    expect(chain.entries.map((e) => (e.kind === 'leader:action' ? e.data.status : ''))).toEqual(['scheduled', 'scheduled', 'scheduled', 'applied', 'applied', 'applied']);

    const veto = await vetoLeaderMemo(deps, MEMO, 'integration');
    expect(veto.records.map((r) => r.restored)).toEqual([true, true, true]);
    expect(listRepoHolds()).toEqual([]);
    expect(readLeaderDirectives()).toBeNull();
    const after = await readLedger();
    expect(after.chain).toBe('ok');
    expect(after.entries.filter((e) => e.kind === 'leader:vetoed')).toHaveLength(3);
  });
});
