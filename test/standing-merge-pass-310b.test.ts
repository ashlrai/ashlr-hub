/**
 * V3.10 Track B unit U3 — the standing-grant merge pass end to end
 * (fleet/standing-merge-pass.ts): pending fleet-mirror proposals through
 * G0–G6, the App PR, required checks, the G0 re-check and the SHA-pinned
 * merge — against a fake GitHub backed by a real bare repo, an in-memory
 * ledger, and stubbed verification / judge (no model is ever called).
 *
 * Covers SPEC-310B §7 U3: gate order, owner lane, tamper, head-SHA race,
 * no checks → owner lane, family refusal, no downgrade, local-author cap —
 * plus would-merge under a propose switch, rebuild on a moved base, row
 * dedup across ticks, Stop, and the legacy double-landing guard.
 *
 * REAL-IO (git through the fake): belongs in the real-io lane (U3 report).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Real git work: generous until this file joins REAL_IO_TEST_FILES (see header).
vi.setConfig({ testTimeout: 30_000 });

import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import { closeGitScratch, openGitScratch, parseFleetTrailers, type FleetGitScratch, type HostMergeDeps } from '../src/core/fleet/host-merge.js';
import { allowedJudgeLanes } from '../src/core/fleet/merge-gates.js';
import { proposalHasFleetPr } from '../src/core/fleet/fleet-merge-state.js';
import { runStandingMergePass, type StandingPassDeps } from '../src/core/fleet/standing-merge-pass.js';
import type { AutoMergePassResult } from '../src/core/fleet/automerge-pass.js';
import type { EffectivePolicy } from '../src/core/authority/types.js';
import type { FleetEngine, LandingRecord } from '../src/core/fleet/fleet-types.js';
import type { AshlrConfig, DecisionEntry, Proposal } from '../src/core/types.js';
import { FakeGithub, MemoryLedger, fleetProposal, judgedDecision, repoPolicy, standingPolicy } from './helpers/fleet-github-310b.js';

beforeAll(() => {
  loadOrCreateKey();
});

let fakes: FakeGithub[] = [];
let counter = 0;

afterEach(() => {
  for (const fake of fakes) fake.dispose();
  fakes = [];
});

const JUDGE_FOR_LANE: Record<FleetEngine, string> = {
  'grok-cli': 'grok-cli:grok-4.7',
  'claude-cli': 'claude-opus-4-8',
  codex: 'gpt-5.5',
  local: 'qwen2.5:72b-instruct-q4_K_M',
};

interface World {
  fake: FakeGithub;
  repo: string;
  ledger: MemoryLedger;
  policy: { current: EffectivePolicy | null };
  clock: { now: number };
  kill: { on: boolean };
  proposals: Map<string, Proposal>;
  decisions: Map<string, DecisionEntry[]>;
  statuses: { id: string; status: string; reason: string }[];
  judgeCalls: FleetEngine[][];
  availableLanes: FleetEngine[];
  /** Lets a test make the (stubbed) judge answer as someone else. */
  judgeOverride: string | null;
  deps: Partial<StandingPassDeps>;
}

function world(opts: { required?: { context: string; appId: number | null }[]; switchTo?: 'propose' | 'autonomous' } = {}): World {
  counter++;
  const repo = `ashlrai/canary-sp${counter}`;
  const fake = new FakeGithub({ repo, ...(opts.required ? { required: opts.required } : {}) });
  fakes.push(fake);
  const ledger = new MemoryLedger();
  const policy = { current: standingPolicy([repoPolicy(repo)], opts.switchTo ? { switch: opts.switchTo } : {}) as EffectivePolicy | null };
  const clock = { now: Date.now() };
  const kill = { on: false };
  const w: World = {
    fake,
    repo,
    ledger,
    policy,
    clock,
    kill,
    proposals: new Map(),
    decisions: new Map(),
    statuses: [],
    judgeCalls: [],
    availableLanes: ['grok-cli', 'claude-cli'],
    judgeOverride: null,
    deps: {},
  };
  const host: HostMergeDeps = {
    transport: fake.transport,
    token: async () => ({ token: 'ghs_test_installation_token', expiresAt: null }),
    nowMs: () => clock.now,
    sleep: async () => undefined,
    killActive: () => kill.on,
    killEpoch: () => (kill.on ? 'b'.repeat(64) : 'a'.repeat(64)),
    policy: () => policy.current,
    appendLedger: ledger.append,
    ledgerHead: ledger.head,
  };
  w.deps = {
    host,
    loadProposal: (id) => w.proposals.get(id) ?? null,
    setStatus: (id, status, _result, reason) => {
      w.statuses.push({ id, status, reason });
      const p = w.proposals.get(id);
      if (p) p.status = status;
      return true;
    },
    verifyAndPersist: async () => ({
      verify: { ok: true, ran: [{ kind: 'test', cmd: ['npm', 'test'] }], detail: 'all green', baseBranch: 'main', baseHead: fake.head()! },
      persisted: true,
      authorityLive: true,
      reason: 'verification evidence persisted under live authority',
    }),
    hasCurrentVerificationBinding: () => false,
    selfEvalParity: async () => ({ ok: true, reason: 'parity' }),
    isSelfRepo: () => false,
    listHolds: () => [],
    mergeTimes24h: async () => ledger.of('merge:landed').map((l) => (l as LandingRecord).landedAt),
    judgeSeatLanes: ({ producerFamily, waitSinceMs, nowMs }) => ({
      // The real router's contract: G6's allowed lanes ∩ seats with headroom.
      lanes: allowedJudgeLanes(producerFamily, waitSinceMs, nowMs).filter((lane) => w.availableLanes.includes(lane)),
      nextEligibleAt: null,
    }),
    runJudge: async (proposal, _cfg, lanes) => {
      w.judgeCalls.push([...lanes]);
      const judge = w.judgeOverride ?? JUDGE_FOR_LANE[lanes[0]!];
      w.decisions.set(proposal.id, [...(w.decisions.get(proposal.id) ?? []), judgedDecision(proposal, judge, 'ship', new Date(clock.now))]);
      return { called: true, reason: `judged by ${judge}` };
    },
    readDecisions: (id) => w.decisions.get(id) ?? [],
    claimIntegrity: async () => ({ integrity: 'consistent', claim: 'claims-change', classifier: 'heuristic' }),
    blastChecks: async () => [],
    postMergeEffects: async () => undefined,
  };
  return w;
}

function emptyOut(): AutoMergePassResult {
  return {
    attempted: 0, merged: 0, branched: 0, handoffs: 0, results: [], judged: 0, judgePerPass: 0, judgeCapped: 0,
    verifyBeforeJudgePerPass: 0, verifyBeforeJudgeRan: 0, verifyBeforeJudgeCapped: 0, judgeEstimatedSpendUsd: 0,
    skipped: [], autoArchived: 0, ttlRejected: 0, invalidRejected: 0,
  };
}

async function pass(w: World, pending: Proposal[] = [...w.proposals.values()].filter((p) => p.status === 'pending')) {
  const out = emptyOut();
  const summary = await runStandingMergePass({ cfg: {} as AshlrConfig, policy: w.policy.current!, pending, out, deps: w.deps });
  return { out, summary };
}

function add(w: World, p: Proposal): Proposal {
  w.proposals.set(p.id, p);
  return p;
}

const SRC_CHANGE = { 'src/sub.ts': 'export const sub = (a: number, b: number): number => a - b;\n' };
const GROK = { engineModel: 'grok-cli:grok-4.7-build-fast', engineTier: 'frontier' as const };

function prOf(w: World) {
  const pulls = [...w.fake.pulls.values()];
  expect(pulls).toHaveLength(1);
  return pulls[0]!;
}

describe('standing merge pass — the happy path and GATE ORDER', () => {
  it('runs G0 → G1 → G1b → G2 → G3 → G4 → G5 → G6, opens the App PR, then merges SHA-pinned once checks are green', async () => {
    const w = world();
    const p = add(w, fleetProposal(w.fake, { files: SRC_CHANGE, ...GROK }));

    const first = await pass(w);
    expect(w.ledger.kinds()).toEqual([
      'gate:result:G0:pass',
      'gate:result:G1:pass',
      'gate:result:G1b:pass',
      'gate:result:G2:pass',
      'gate:result:G3:pass',
      'gate:result:G4:pass',
      'gate:result:G5:pass',
      'gate:result:G6:pass',
      'pr:opened',
    ]);
    expect(first.summary).toMatchObject({ evaluated: 1, prsOpened: 1, merged: 0 });
    expect(w.judgeCalls).toEqual([['claude-cli']]); // Grok work → the claude-a slice
    const pr = prOf(w);
    expect(pr.headRef).toBe(`ashlr/fleet/${p.id}`);
    expect(proposalHasFleetPr(p.id)).toBe(true); // the legacy path now refuses it

    // Checks still pending: nothing merges, one G7 wait row.
    await pass(w);
    expect(w.fake.mergeCalls()).toHaveLength(0);
    expect(w.ledger.gateRows().at(-1)).toMatchObject({ gate: 'G7', verdict: 'wait', code: 'checks-pending' });

    w.fake.greenRequired(w.fake.headOfPull(pr.number)!);
    w.clock.now += 10 * 60 * 1000; // past the check back-off
    const merged = await pass(w);
    expect(merged.summary.merged).toBe(1);
    expect(merged.out.merged).toBe(1);
    const landing = merged.out.landings![0]!;
    expect(landing).toMatchObject({ kind: 'merge', repo: w.repo, prNumber: pr.number, proposalId: p.id, judgeId: 'claude-opus-4-8' });
    expect(w.fake.head()).toBe(landing.mergeSha);
    const trailers = parseFleetTrailers(w.fake.git(['log', '-1', '--format=%B', landing.mergeSha]));
    expect(trailers['Ashlr-Grant']).toEqual([landing.grantId]);
    expect(trailers['Ashlr-Gates']).toEqual([landing.gatesDigest]);
    expect(trailers['Ashlr-Ledger-Head']).toEqual([landing.ledgerHead]);
    expect(w.ledger.kinds().slice(-3)).toEqual(['gate:result:G0:pass', 'gate:result:G7:pass', 'merge:landed']);
    // The merge-ready row says whether GitHub itself closes the base-move race.
    const mergeReady = w.ledger.of('gate:result').at(-1) as { code: string; reason: string };
    expect(mergeReady.code).toBe('merge-ready');
    expect(mergeReady.reason).toContain('GitHub requires the head to be up to date with the base');
    expect(w.statuses.at(-1)).toMatchObject({ id: p.id, status: 'applied' });
    // The ledger head the trailer names was written BEFORE the merge call.
    const headRow = w.ledger.entries.find((e) => e.hash === landing.ledgerHead)!;
    expect(headRow.kind).toBe('gate:result');
  });

  it('dedups: a proposal waiting for a judge seat writes one G0 row, not one per tick', async () => {
    const w = world();
    w.availableLanes = [];
    add(w, fleetProposal(w.fake, { files: SRC_CHANGE, ...GROK }));
    for (let tick = 0; tick < 5; tick++) {
      await pass(w);
      w.clock.now += 60_000;
    }
    expect(w.ledger.kinds()).toEqual(['gate:result:G0:wait']);
    expect(w.ledger.gateRows()[0]).toMatchObject({ code: 'no-judge-seat' });
    expect(w.fake.pulls.size).toBe(0);
  });

  it('Stop: nothing is evaluated, written or opened', async () => {
    const w = world();
    add(w, fleetProposal(w.fake, { files: SRC_CHANGE, ...GROK }));
    w.kill.on = true;
    await pass(w);
    expect(w.ledger.entries).toHaveLength(0);
    expect(w.fake.calls).toHaveLength(0);
  });

  it('proposals in Mason\'s own checkouts are never fleet work', async () => {
    const w = world();
    const p = fleetProposal(w.fake, { files: SRC_CHANGE, ...GROK });
    add(w, { ...p, repo: '/Users/someone/code/fleet-canary' });
    await pass(w);
    expect(w.ledger.entries).toHaveLength(0);
  });
});

describe('owner lane', () => {
  it('OWNER LANE: a protected path opens a labelled PR that is never merged, even when green', async () => {
    const w = world();
    add(w, fleetProposal(w.fake, { files: { ...SRC_CHANGE, 'package.json': '{ "name": "canary", "version": "1.0.1" }\n' }, ...GROK }));
    await pass(w);
    expect(w.ledger.kinds()).toEqual(['gate:result:G0:pass', 'gate:result:G1:owner-lane', 'pr:opened']);
    expect(w.ledger.gateRows()[1]).toMatchObject({ code: 'protected-manifest' });
    expect((w.ledger.of('pr:opened')[0] as { ownerLane: boolean }).ownerLane).toBe(true);
    const pr = prOf(w);
    expect([...pr.labels]).toEqual(['ashlr:owner-lane']);
    expect(w.judgeCalls).toHaveLength(0); // no paid judge spent on Mason's lane
    w.fake.greenRequired(w.fake.headOfPull(pr.number)!);
    w.clock.now += 60 * 60 * 1000;
    await pass(w);
    expect(w.fake.mergeCalls()).toHaveLength(0);
  });

  it('NO CHECKS → OWNER LANE: a repo with no required checks never auto-merges', async () => {
    const w = world({ required: [] });
    add(w, fleetProposal(w.fake, { files: SRC_CHANGE, ...GROK }));
    await pass(w);
    const pr = prOf(w);
    w.fake.setCheck(w.fake.headOfPull(pr.number)!, 'some-optional-job', 'success');
    w.clock.now += 10 * 60 * 1000;
    const second = await pass(w);
    expect(w.ledger.gateRows().at(-1)).toMatchObject({ gate: 'G7', verdict: 'owner-lane', code: 'no-required-checks' });
    expect([...pr.labels]).toContain('ashlr:owner-lane');
    expect(second.summary.ownerLane).toBe(1);
    expect(w.fake.mergeCalls()).toHaveLength(0);
  });

  it('HEAD-SHA RACE: a push to the fleet branch after it opened sends the PR to the owner lane, unmerged', async () => {
    const w = world();
    add(w, fleetProposal(w.fake, { files: SRC_CHANGE, ...GROK }));
    await pass(w);
    const pr = prOf(w);
    const raced = w.fake.pushCommit(pr.headRef, { 'src/evil.ts': 'export const evil = true;\n' });
    w.fake.greenRequired(raced);
    w.clock.now += 10 * 60 * 1000;
    await pass(w);
    expect(w.ledger.gateRows().at(-1)).toMatchObject({ gate: 'G7', verdict: 'owner-lane', code: 'head-sha-changed', headSha: raced });
    expect([...pr.labels]).toContain('ashlr:owner-lane');
    expect(w.fake.mergeCalls()).toHaveLength(0);
  });
});

describe('refusals', () => {
  it('TAMPER: removing an expect( is high risk — refused, rejected, no PR', async () => {
    const w = world();
    const p = add(w, fleetProposal(w.fake, {
      files: { 'test/math.test.ts': "import { it } from 'vitest';\nimport { add } from '../src/math.js';\nit('adds', () => {\n  add(1, 2);\n});\n" },
      ...GROK,
    }));
    await pass(w);
    expect(w.ledger.kinds()).toEqual(['gate:result:G0:pass', 'gate:result:G1:pass', 'gate:result:G1b:refuse']);
    expect(w.ledger.gateRows()[2]).toMatchObject({ code: 'test-tamper' });
    expect(w.statuses).toEqual([expect.objectContaining({ id: p.id, status: 'rejected' })]);
    expect(w.fake.pulls.size).toBe(0);
  });

  it('LOCAL-AUTHOR CAP: a local model\'s medium-risk source change is refused at G2', async () => {
    const w = world();
    const p = add(w, fleetProposal(w.fake, { files: SRC_CHANGE, engineModel: 'local-coder:qwen3.8-coder', engineTier: 'local' }));
    await pass(w);
    expect(w.ledger.gateRows().at(-1)).toMatchObject({ gate: 'G2', verdict: 'refuse', code: 'local-author-cap' });
    expect(w.statuses).toEqual([expect.objectContaining({ id: p.id, status: 'rejected' })]);
    expect(w.fake.pulls.size).toBe(0);
  });

  it('a grant-cap refusal keeps the proposal pending (a later rollout stage may allow it)', async () => {
    const w = world();
    w.policy.current = standingPolicy([repoPolicy(w.repo, { maxRisk: 'low' })]);
    add(w, fleetProposal(w.fake, { files: SRC_CHANGE, ...GROK }));
    await pass(w);
    expect(w.ledger.gateRows().at(-1)).toMatchObject({ gate: 'G2', verdict: 'refuse', code: 'risk-over-cap' });
    expect(w.statuses).toEqual([]);
  });
});

describe('the judge (G6)', () => {
  it('FAMILY REFUSAL: a same-family ship never passes; the proposal waits for a different family', async () => {
    const w = world();
    w.judgeOverride = 'grok-cli:grok-4.7'; // a misrouted judge answers as Grok
    add(w, fleetProposal(w.fake, { files: SRC_CHANGE, ...GROK }));
    await pass(w);
    expect(w.judgeCalls).toEqual([['claude-cli']]); // Grok work is only ever sent to Claude
    expect(w.ledger.gateRows().at(-1)).toMatchObject({ gate: 'G6', verdict: 'wait', code: 'judge-ineligible' });
    expect(w.fake.pulls.size).toBe(0);
  });

  it('NO DOWNGRADE: local work waits for its Grok judge; only after 24 h may another qualifying lane judge it', async () => {
    const w = world();
    w.availableLanes = ['claude-cli']; // the grok seat has no headroom
    add(w, fleetProposal(w.fake, { files: { 'docs/NOTES.md': '# notes\n' }, engineModel: 'local-coder:qwen3.8-coder', engineTier: 'local' }));
    await pass(w);
    expect(w.ledger.gateRows()).toEqual([expect.objectContaining({ gate: 'G0', verdict: 'wait', code: 'no-judge-seat' })]);
    expect(w.judgeCalls).toEqual([]);
    w.clock.now += 23 * 60 * 60 * 1000;
    await pass(w);
    expect(w.judgeCalls).toEqual([]);
    w.clock.now += 2 * 60 * 60 * 1000; // 25 h waiting
    await pass(w);
    expect(w.judgeCalls).toEqual([['claude-cli']]);
    for (const lanes of w.judgeCalls) expect(lanes).not.toContain('local');
    expect(w.fake.pulls.size).toBe(1);
  });
});

describe('merge-time behavior', () => {
  it('a propose switch records one would-merge per head and never merges', async () => {
    const w = world({ switchTo: 'propose' });
    add(w, fleetProposal(w.fake, { files: SRC_CHANGE, ...GROK }));
    await pass(w);
    const pr = prOf(w);
    w.fake.greenRequired(w.fake.headOfPull(pr.number)!);
    for (let tick = 0; tick < 3; tick++) {
      w.clock.now += 20 * 60 * 1000;
      await pass(w);
    }
    expect(w.ledger.of('gate:would-merge')).toEqual([expect.objectContaining({ withheldBecause: 'switch-propose', headSha: w.fake.headOfPull(pr.number) })]);
    expect(w.fake.mergeCalls()).toHaveLength(0);
  });

  it('a moved base is re-verified and the head rebuilt; the landed tree is the verified one', async () => {
    const w = world();
    add(w, fleetProposal(w.fake, { files: SRC_CHANGE, ...GROK }));
    await pass(w);
    const pr = prOf(w);
    const firstHead = w.fake.headOfPull(pr.number)!;
    const newBase = w.fake.pushCommit('main', { 'README.md': '# canary\n\nmoved\n' });
    w.fake.syncMirror(); // U6's per-tick mirror reset
    w.clock.now += 10 * 60 * 1000;
    await pass(w);
    const rebuilt = w.fake.headOfPull(pr.number)!;
    expect(rebuilt).not.toBe(firstHead);
    expect(w.fake.git(['rev-parse', `${rebuilt}^`])).toBe(newBase);
    w.fake.greenRequired(rebuilt);
    w.clock.now += 10 * 60 * 1000;
    const merged = await pass(w);
    expect(merged.summary.merged).toBe(1);
    expect(w.fake.git(['show', `${w.fake.head()}:README.md`])).toContain('moved');
    expect(w.fake.git(['show', `${w.fake.head()}:src/sub.ts`])).toContain('sub');
  });

  it('the daily cap holds across PRs: with a cap of 1 the second green PR waits (rolling 24 h)', async () => {
    const w = world();
    w.policy.current = standingPolicy([repoPolicy(w.repo, { maxMergesPerDay: 1 })]);
    add(w, fleetProposal(w.fake, { files: SRC_CHANGE, ...GROK, title: 'first' }));
    add(w, fleetProposal(w.fake, { files: { 'docs/NOTES.md': '# notes\n' }, ...GROK, title: 'second' }));
    await pass(w);
    expect(w.fake.pulls.size).toBe(2);
    const greenAll = () => {
      for (const pull of w.fake.pulls.values()) if (pull.state === 'open') w.fake.greenRequired(w.fake.headOfPull(pull.number)!);
    };
    for (let tick = 0; tick < 4; tick++) {
      greenAll();
      w.fake.syncMirror();
      w.clock.now += 10 * 60 * 1000;
      await pass(w);
    }
    expect(w.fake.mergeCalls()).toHaveLength(1);
    expect(w.ledger.gateRows().filter((r) => r.gate === 'G0' && r.code === 'daily-cap')).not.toHaveLength(0);
    w.clock.now += 25 * 60 * 60 * 1000; // the first merge ages out of the window
    for (let tick = 0; tick < 3; tick++) {
      greenAll();
      w.fake.syncMirror();
      w.clock.now += 10 * 60 * 1000;
      await pass(w);
    }
    expect(w.fake.mergeCalls().length).toBeGreaterThanOrEqual(2);
  });

  it('a proposal handled in the inbox (rejected / applied by hand) withdraws its fleet PR instead of landing twice', async () => {
    const w = world();
    const p = add(w, fleetProposal(w.fake, { files: SRC_CHANGE, ...GROK }));
    await pass(w);
    const pr = prOf(w);
    w.fake.greenRequired(w.fake.headOfPull(pr.number)!);
    p.status = 'approved'; // Mason took it through the manual path
    w.clock.now += 10 * 60 * 1000;
    await pass(w, []);
    expect(w.fake.pulls.get(pr.number)!.state).toBe('closed');
    expect(w.fake.mergeCalls()).toHaveLength(0);
    expect(w.ledger.kinds()).toContain('pr:closed');
  });

  it('a judge that answers without a usable verdict is not re-asked every tick', async () => {
    const w = world();
    w.judgeOverride = 'qwen2.5:72b-instruct-q4_K_M'; // an ineligible answer
    add(w, fleetProposal(w.fake, { files: SRC_CHANGE, ...GROK }));
    await pass(w);
    w.clock.now += 60_000;
    await pass(w);
    expect(w.judgeCalls).toHaveLength(1);
    w.clock.now += 20 * 60 * 1000;
    await pass(w);
    expect(w.judgeCalls).toHaveLength(2);
  });

  it('a Stop between the green checks and the merge leaves the PR open and unmerged', async () => {
    const w = world();
    add(w, fleetProposal(w.fake, { files: SRC_CHANGE, ...GROK }));
    await pass(w);
    const pr = prOf(w);
    w.fake.greenRequired(w.fake.headOfPull(pr.number)!);
    w.clock.now += 10 * 60 * 1000;
    let scratch: FleetGitScratch | null = null;
    const opened = openGitScratch(w.fake.mirror);
    if (typeof opened !== 'string') scratch = opened;
    // Stop pressed while the merge authority is armed.
    w.deps.host = { ...w.deps.host!, beforeConsume: () => { w.kill.on = true; } };
    await pass(w);
    closeGitScratch(scratch);
    expect(w.fake.mergeCalls()).toHaveLength(0);
    expect(w.fake.pulls.get(pr.number)!.state).toBe('open');
  });
});
