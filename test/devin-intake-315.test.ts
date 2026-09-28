/**
 * 3.15 — Devin PRs through the SAME cloud intake and standing gates.
 *
 * Covered: the Devin source's identity checks (head exactly
 * `ashlr-devin/<taskId>`, same repository, pinned PR, base unchanged), the
 * producer identity `devin:<mode>` (family `devin`, never unknown), G6 needing
 * a frontier judge of another family (Devin itself never judges), the
 * UNVERIFIED report in Devin's words, the source/store mismatch refusal, the
 * disabled lane — and end-to-end runs through runStandingMergePass (a real
 * bare repo via FakeGithub) under the 3.15 TWO-JUDGE RULE: one judge never
 * passes G6 for Devin work; a second judge of a different family does; the
 * App PR then merges only when the live stage names the `devin` engine —
 * otherwise the would-merge is recorded as `shadow` and nothing merges
 * (producerMergeWithheld). The legacy pass skips Devin proposals too.
 */
import { rmSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

import { cloudIntakeSummary, ingestCloudPrs, resetCloudIntakeCursorForTest, type CloudIntakeDeps, type CloudIntakeMirror } from '../src/core/fleet/cloud-intake.js';
import { allowedJudgeLanes, evaluateG6 } from '../src/core/fleet/merge-gates.js';
import { mirrorPathFor } from '../src/core/fleet/mirrors.js';
import {
  evaluateJudgeEligibility,
  isFrontierJudgeId,
  judgeLanePreference,
  producerMergeWithheld,
  producerModelFamily,
} from '../src/core/fleet/reviewer-independence.js';
import { runStandingMergePass, type StandingPassDeps } from '../src/core/fleet/standing-merge-pass.js';
import type { AutoMergePassResult } from '../src/core/fleet/automerge-pass.js';
import type { FleetEngine, LandingRecord } from '../src/core/fleet/fleet-types.js';
import type { HostMergeDeps } from '../src/core/fleet/host-merge.js';
import { hashDiff, loadOrCreateKey, verifyProvenance } from '../src/core/foundry/provenance.js';
import { loadProposal } from '../src/core/inbox/store.js';
import { DEVIN_INTAKE_SOURCE, ingestDevinPrs } from '../src/core/devin/intake.js';
import { devinHome, listDevinTasks, readDevinTask, writeDevinTask } from '../src/core/devin/store.js';
import type { DevinTaskV1 } from '../src/core/devin/types.js';
import type { EffectivePolicy } from '../src/core/authority/types.js';
import type { AshlrConfig, DecisionEntry, Proposal } from '../src/core/types.js';
import { FakeGithub, MemoryLedger, judgedDecision, repoPolicy, standingPolicy } from './helpers/fleet-github-310b.js';

beforeAll(() => {
  loadOrCreateKey();
});

beforeEach(() => {
  rmSync(devinHome(), { recursive: true, force: true });
  resetCloudIntakeCursorForTest();
});

const REPO = 'ashlrai/devin-canary';
const PR = 41;
const HEAD_A = 'a'.repeat(40);
const MERGE_BASE = 'c'.repeat(40);
const cfg = { devin: { enabled: true } } as AshlrConfig;
const DIFF = [
  'diff --git a/src/sub.ts b/src/sub.ts',
  'new file mode 100644',
  'index 0000000..1111111',
  '--- /dev/null',
  '+++ b/src/sub.ts',
  '@@ -0,0 +1 @@',
  '+export const sub = (a: number, b: number): number => a - b;',
  '',
].join('\n');
const REPORT = '```ashlr-devin-report\n{"status":"done","summary":"Added the sub helper.","testsRun":["npm test"],"risks":[]}\n```';

let counter = 0;
function seedTask(patch: Partial<DevinTaskV1> = {}): DevinTaskV1 {
  counter++;
  const id = `dv_20260927T0400_${counter.toString(36).padStart(6, '0')}`;
  const repo = patch.repo ?? REPO;
  const now = new Date().toISOString();
  const task: DevinTaskV1 = {
    v: 1, id, repo, baseBranch: 'main', branch: `ashlr-devin/${id}`, title: 'Add a sub helper', prompt: 'p', origin: 'operator',
    requestedBy: 'mason', sessionId: 'devin-s1', sessionUrl: 'https://app.devin.ai/sessions/devin-s1', state: 'pr-open', stateReason: null,
    failure: null, createdAt: new Date(Date.now() - 60_000 * (100 - counter)).toISOString(), launchedAt: now, updatedAt: now,
    session: null, maxAcu: 10, devinMode: 'normal', headSha: HEAD_A,
    pr: { number: PR, url: `https://github.com/${repo}/pull/${PR}`, state: 'open', draft: false, title: '[ashlr-devin] Add a sub helper' },
    report: null, deliveryPin: { number: PR, url: `https://github.com/${repo}/pull/${PR}` }, backlogItemId: null,
    ...patch,
  };
  writeDevinTask(task);
  return readDevinTask(id)!;
}

function harness(prPatch: Record<string, unknown> = {}) {
  const proposals = new Map<string, Proposal>();
  const calls: string[][] = [];
  let pc = 0;
  const deps: Partial<CloudIntakeDeps<DevinTaskV1>> = {
    gh: async (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'view') {
        const task = listDevinTasks()[0]!;
        return {
          ok: true,
          stdout: JSON.stringify({
            number: PR, url: `https://github.com/${REPO}/pull/${PR}`, state: 'OPEN', isDraft: false, headRefOid: HEAD_A,
            headRefName: task.branch, baseRefName: 'main', isCrossRepository: false, body: REPORT, ...prPatch,
          }),
          stderr: '',
        };
      }
      if (args[0] === 'api' && args.includes('--jq')) return { ok: true, stdout: JSON.stringify({ merge_base: MERGE_BASE }), stderr: '' };
      if (args[0] === 'api' && args[1] === '-H') return { ok: true, stdout: DIFF, stderr: '' };
      return { ok: false, stdout: '', stderr: 'unexpected' };
    },
    createProposal: (input) => {
      const p = { ...input, id: `p-devin-${++pc}`, status: 'pending', createdAt: new Date().toISOString() } as Proposal;
      proposals.set(p.id, p);
      return p;
    },
    loadProposal: (id) => proposals.get(id) ?? null,
    rejectPending: () => true,
    readFleetMergeState: () => ({ state: 'missing' }),
    lockFleetState: () => () => undefined,
    killActive: () => false,
  };
  return { deps, proposals, calls };
}

const policy = (): EffectivePolicy => standingPolicy([repoPolicy(REPO)]);
const mirrors = (): CloudIntakeMirror[] => [{ nameWithOwner: REPO, path: mirrorPathFor(REPO), base: 'main' }];

describe('Devin family and G6', () => {
  it('devin:<mode> is family `devin` — never unknown, never claude', () => {
    for (const mode of ['normal', 'fast', 'lite', 'ultra']) expect(producerModelFamily(`devin:${mode}`)).toBe('devin');
    // 3.15 elite self-land: Devin HOSTS other vendors' models (SWE-2, GPT-6,
    // Claude), so a vendor-named suffix keeps the family `devin` — with its
    // two-judge rule and the "Devin must be signed in" merge lock — instead
    // of turning into `unknown` (which no Devin-specific rule would cover).
    expect(producerModelFamily('devin:claude-opus-4-8')).toBe('devin');
    expect(producerModelFamily('devin-cli:gpt-6-sol')).toBe('devin');
    expect(producerModelFamily('devin-cli:swe-2-high')).toBe('devin');
  });

  it('a frontier judge of another family is eligible; Devin never judges; a same-family judge never exists', () => {
    expect(evaluateJudgeEligibility('devin:normal', 'codex:gpt-5.5').eligible).toBe(true);
    expect(evaluateJudgeEligibility('devin:normal', 'grok-cli:grok-4.7').eligible).toBe(true);
    expect(evaluateJudgeEligibility('devin:normal', 'claude-opus-4-8').eligible).toBe(true);
    expect(isFrontierJudgeId('devin:normal')).toBe(false);
    expect(evaluateJudgeEligibility('devin:normal', 'devin:normal').eligible).toBe(false);
    expect(evaluateJudgeEligibility('devin:normal', 'qwen2.5:72b').eligible).toBe(false);
  });

  it('judge lanes: xAI first (least likely to share Devin\'s model), widening after the wait', () => {
    expect(judgeLanePreference('devin')).toEqual(['grok-cli', 'codex', 'claude-cli']);
    expect(allowedJudgeLanes('devin', null, Date.now())).toEqual(['grok-cli']);
  });

  it('G6 waits for a judge, and passes nothing on its own', () => {
    const g6 = evaluateG6({ proposalId: 'p', producerModel: 'devin:normal', diff: DIFF, decisions: [], nowMs: Date.now() });
    expect(g6).toMatchObject({ verdict: 'wait', code: 'awaiting-judge', needsJudge: true, judgedFamilies: [] });
  });

  it('withheld (shadow) unless the stage names Devin AND two judges of different families shipped', () => {
    expect(producerMergeWithheld('devin')).toBe('shadow');
    const two = ['grok-cli:grok-4.7', 'gpt-5.5'];
    expect(producerMergeWithheld('devin', { devinGranted: true, producerModel: 'devin:normal', judgeIds: two })).toBeNull();
    expect(producerMergeWithheld('devin', { devinGranted: false, producerModel: 'devin:normal', judgeIds: two })).toBe('shadow');
    expect(producerMergeWithheld('devin', { devinGranted: true, producerModel: 'devin:normal', judgeIds: ['grok-cli:grok-4.7'] })).toBe('shadow');
    // Same family twice counts once; Devin, local and unknown judges never count.
    expect(producerMergeWithheld('devin', { devinGranted: true, producerModel: 'devin:normal', judgeIds: ['claude-opus-4-8', 'claude-sonnet-5'] })).toBe('shadow');
    expect(producerMergeWithheld('devin', { devinGranted: true, producerModel: 'devin:normal', judgeIds: ['gpt-5.5', 'devin:normal'] })).toBe('shadow');
    expect(producerMergeWithheld('devin', { devinGranted: true, producerModel: 'devin:normal', judgeIds: ['gpt-5.5', 'qwen2.5:72b'] })).toBe('shadow');
    expect(producerMergeWithheld('devin', { devinGranted: true, producerModel: 'devin:normal', judgeIds: ['gpt-5.5', 'grok-4.7'] })).toBe('shadow'); // bare Grok never judges
    for (const f of ['claude', 'openai', 'xai', 'local', 'unknown'] as const) expect(producerMergeWithheld(f)).toBeNull();
  });
});

describe('Devin intake (the cloud intake with the Devin source)', () => {
  it('files a pending proposal signed devin:<mode>, with an UNVERIFIED Devin report', async () => {
    const t = seedTask({ devinMode: 'lite' });
    const h = harness();
    const result = await ingestDevinPrs(cfg, policy(), { mirrors: mirrors(), deps: h.deps });
    expect(result.outcomes).toMatchObject([{ taskId: t.id, action: 'ingested', headSha: HEAD_A }]);
    const p = [...h.proposals.values()][0]!;
    expect(p).toMatchObject({ engineModel: 'devin:lite', engineTier: 'frontier', runId: t.id, title: '[devin] Add a sub helper', diff: DIFF, diffHash: hashDiff(DIFF) });
    expect(verifyProvenance(p).ok).toBe(true);
    expect(p.summary).toMatch(/^Devin session report \(UNVERIFIED/);
    expect(p.summary).toContain(`Source: Devin task ${t.id}`);
    expect(p.summary).toContain('Produced by a Devin (Cognition) session');
    expect(readDevinTask(t.id)!.intake).toMatchObject({ headSha: HEAD_A, proposalId: p.id });
  });

  it('refuses a head ref that is not ashlr-devin/<taskId>, a fork, and a PR retargeted to another base', async () => {
    seedTask();
    const wrongHead = await ingestDevinPrs(cfg, policy(), { mirrors: mirrors(), deps: harness({ headRefName: 'devin/some-branch' }).deps });
    expect(wrongHead.outcomes).toMatchObject([{ action: 'refused', code: 'head-ref-mismatch' }]);
    const fork = await ingestDevinPrs(cfg, policy(), { mirrors: mirrors(), deps: harness({ isCrossRepository: true }).deps });
    expect(fork.outcomes).toMatchObject([{ action: 'refused', code: 'cross-repository' }]);
    const base = await ingestDevinPrs(cfg, policy(), { mirrors: mirrors(), deps: harness({ baseRefName: 'release' }).deps });
    expect(base.outcomes).toMatchObject([{ action: 'refused', code: 'base-moved' }]);
  });

  it('a cloud-branch task in the Devin store is never selected; the lane off is a no-op', async () => {
    const h = harness();
    // The store validates branch = ashlr-devin/<id>, so the only way a foreign branch can appear is a
    // hand-edited source: the intake filters on the source's prefix before any GitHub call.
    const rogue = { ...seedTask(), branch: 'ashlr-cloud/x' } as DevinTaskV1;
    const result = await ingestCloudPrs<DevinTaskV1>(cfg, policy(), {
      mirrors: mirrors(), source: DEVIN_INTAKE_SOURCE,
      deps: { ...h.deps, listTasks: () => [rogue], readTask: () => rogue, writeTask: () => undefined },
    });
    expect(result.checked).toBe(0);
    expect(h.calls).toEqual([]);

    seedTask();
    const off = await ingestDevinPrs({} as AshlrConfig, policy(), { mirrors: mirrors(), deps: harness().deps });
    expect(off).toMatchObject({ checked: 0, ingested: 0 });
  });

  it('a non-cloud source without its own task store is refused outright (never reads the cloud store)', async () => {
    const result = await ingestCloudPrs<DevinTaskV1>(cfg, policy(), { mirrors: mirrors(), source: DEVIN_INTAKE_SOURCE, deps: { gh: async () => ({ ok: false, stdout: '', stderr: '' }) } });
    expect(result).toMatchObject({ checked: 0, outcomes: [] });
  });

  it('the cloud source still words its summary exactly as before', () => {
    const summary = cloudIntakeSummary({ id: 'ct_x', origin: 'chat' } as never, null, { url: 'https://github.com/o/r/pull/1', headSha: HEAD_A });
    expect(summary).toContain('Cloud session report (UNVERIFIED');
    expect(summary).toContain('No ashlr-cloud-report block was found');
    expect(summary).toContain('Produced by a Claude cloud session');
  });
});

describe('Devin PR end to end through the standing merge pass — shadow-only', () => {
  let fake: FakeGithub | null = null;
  afterEach(() => {
    fake?.dispose();
    fake = null;
  });

  const JUDGE_FOR_LANE: Record<FleetEngine, string> = {
    'grok-cli': 'grok-cli:grok-4.7',
    'claude-cli': 'claude-opus-4-8',
    codex: 'gpt-5.5',
    local: 'qwen2.5:72b-instruct-q4_K_M',
  };

  function emptyOut(): AutoMergePassResult {
    return {
      attempted: 0, merged: 0, branched: 0, handoffs: 0, results: [], judged: 0, judgePerPass: 0, judgeCapped: 0,
      verifyBeforeJudgePerPass: 0, verifyBeforeJudgeRan: 0, verifyBeforeJudgeCapped: 0, judgeEstimatedSpendUsd: 0,
      skipped: [], autoArchived: 0, ttlRejected: 0, invalidRejected: 0,
    };
  }

  interface E2EOptions {
    /** Does the live stage name the `devin` engine (Mason signed Devin in)? */
    devinGranted: boolean;
    /** The verdict of each judge call, in order (default: every judge ships). */
    verdicts?: Array<'ship' | 'review'>;
  }

  let e2eRuns = 0;

  async function runDevinE2E(opts: E2EOptions) {
    const repo = `ashlrai/devin-e2e-${++e2eRuns}`;
    fake = new FakeGithub({ repo });
    const f = fake;
    const task = seedTask({ repo, pr: { number: PR, url: `https://github.com/${repo}/pull/${PR}`, state: 'open', draft: false, title: 't' }, deliveryPin: { number: PR, url: `https://github.com/${repo}/pull/${PR}` } });
    f.git(['update-ref', `refs/heads/${task.branch}`, f.head()!]);
    const devinHead = f.pushCommit(task.branch, { 'src/sub.ts': 'export const sub = (a: number, b: number): number => a - b;\n' }, 'devin: add sub');

    const gh = async (args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'view' && args[2] === String(PR)) {
        return {
          ok: true,
          stdout: JSON.stringify({
            number: PR, url: `https://github.com/${repo}/pull/${PR}`, state: 'OPEN', isDraft: false,
            headRefOid: f.head(task.branch), headRefName: task.branch, baseRefName: 'main', isCrossRepository: false, body: REPORT,
          }),
          stderr: '',
        };
      }
      if (args[0] === 'api' && args.includes('--jq')) {
        const [baseRef, head] = args[1]!.split('/compare/')[1]!.split('...');
        return { ok: true, stdout: JSON.stringify({ merge_base: f.git(['merge-base', baseRef!, head!]) }), stderr: '' };
      }
      if (args[0] === 'api' && args[1] === '-H') {
        const [mb, head] = args[3]!.split('/compare/')[1]!.split('...');
        return { ok: true, stdout: `${f.git(['diff', '--no-color', mb!, head!])}\n`, stderr: '' };
      }
      return { ok: false, stdout: '', stderr: 'unexpected' };
    };

    const base = standingPolicy([repoPolicy(repo)], { engines: ['local', 'grok-cli', 'claude-cli', 'codex'] });
    const livePolicy = {
      current: (opts.devinGranted
        ? {
            ...base,
            engines: [...base.engines, 'devin'],
            spend: { ...base.spend, seats: { ...base.spend.seats, devin: { seatId: 'devin', enabled: true, reserveFloorPercent: 0, maxSessionWindowPercent: null, roles: ['producer'] } } },
          }
        : base) as EffectivePolicy,
    };
    const intake = await ingestDevinPrs(cfg, livePolicy.current, { mirrors: [{ nameWithOwner: repo, path: f.mirror, base: 'main' }], deps: { gh } });
    expect(intake.outcomes).toMatchObject([{ action: 'ingested', headSha: devinHead }]);
    const proposal = loadProposal(intake.outcomes[0]!.proposalId!)!;
    expect(proposal).toMatchObject({ status: 'pending', engineModel: 'devin:normal' });

    const ledger = new MemoryLedger();
    const clock = { now: Date.now() };
    const proposals = new Map<string, Proposal>([[proposal.id, proposal]]);
    const decisions = new Map<string, DecisionEntry[]>();
    const judgeCalls: FleetEngine[][] = [];
    const verdicts = [...(opts.verdicts ?? [])];
    const host: HostMergeDeps = {
      transport: f.transport,
      token: async () => ({ token: 'ghs_test_installation_token', expiresAt: null }),
      nowMs: () => clock.now,
      sleep: async () => undefined,
      killActive: () => false,
      killEpoch: () => 'a'.repeat(64),
      policy: () => livePolicy.current,
      appendLedger: ledger.append,
      ledgerHead: ledger.head,
    };
    const deps: Partial<StandingPassDeps> = {
      host,
      loadProposal: (id) => proposals.get(id) ?? null,
      setStatus: (id, status) => {
        const p = proposals.get(id);
        if (p) p.status = status;
        return true;
      },
      verifyAndPersist: async () => ({
        verify: { ok: true, ran: [{ kind: 'test', cmd: ['npm', 'test'] }], detail: 'all green', baseBranch: 'main', baseHead: f.head()! },
        persisted: true,
        authorityLive: true,
        reason: 'verification evidence persisted under live authority',
      }),
      hasCurrentVerificationBinding: () => false,
      selfEvalParity: async () => ({ ok: true, reason: 'parity' }),
      isSelfRepo: () => false,
      listHolds: () => [],
      mergeTimes24h: async () => ledger.of('merge:landed').map((l) => (l as LandingRecord).landedAt),
      judgeSeatLanes: ({ producerFamily, waitSinceMs, nowMs, excludeFamilies }) => ({
        lanes: allowedJudgeLanes(producerFamily, waitSinceMs, nowMs, excludeFamilies ?? []).filter((lane) => ['codex', 'grok-cli', 'claude-cli'].includes(lane)),
        nextEligibleAt: null,
      }),
      runJudge: async (p, _cfg, lanes) => {
        judgeCalls.push([...lanes]);
        const judge = JUDGE_FOR_LANE[lanes[0]!];
        const verdict = verdicts.shift() ?? 'ship';
        decisions.set(p.id, [...(decisions.get(p.id) ?? []), judgedDecision(p, judge, verdict, new Date(clock.now))]);
        return { called: true, reason: `judged by ${judge}` };
      },
      readDecisions: (id) => decisions.get(id) ?? [],
      claimIntegrity: async () => ({ integrity: 'consistent', claim: 'claims-change', classifier: 'heuristic' }),
      blastChecks: async () => [],
      postMergeEffects: async () => undefined,
    };
    const pass = async () => {
      const pending = [...proposals.values()].filter((p) => p.status === 'pending');
      return runStandingMergePass({ cfg, policy: livePolicy.current, pending, out: emptyOut(), deps });
    };
    return { f, ledger, clock, pass, judgeCalls, proposal };
  }

  /** Past the pass's 15-minute "do not re-ask a paid judge" window. */
  const JUDGE_RETRY_WAIT_MS = 16 * 60 * 1000;

  it('one judge never passes G6 for Devin work: it waits for a judge of ANOTHER family', async () => {
    const run = await runDevinE2E({ devinGranted: true });
    const first = await run.pass();
    expect(first.prsOpened).toBe(0);
    expect(run.judgeCalls).toEqual([['grok-cli']]);
    expect(run.ledger.kinds()).toContain('gate:result:G6:wait');
    expect(run.ledger.kinds()).not.toContain('pr:opened');
    // Within the retry window no second paid judge is asked.
    await run.pass();
    expect(run.judgeCalls).toHaveLength(1);
  });

  it('two judges of different families pass G6; still `shadow` when the stage does not name Devin', async () => {
    const run = await runDevinE2E({ devinGranted: false });
    await run.pass();
    run.clock.now += JUDGE_RETRY_WAIT_MS;
    const second = await run.pass();
    // The second judge is asked ONLY on lanes of other families (never xAI again).
    expect(run.judgeCalls).toEqual([['grok-cli'], ['codex', 'claude-cli']]);
    expect(second.prsOpened).toBe(1);
    expect(run.ledger.kinds()).toContain('gate:result:G6:pass');
    const appPr = [...run.f.pulls.values()][0]!;

    run.f.greenRequired(run.f.headOfPull(appPr.number)!);
    run.clock.now += 10 * 60 * 1000;
    const third = await run.pass();
    expect(third.merged).toBe(0);
    expect(run.f.mergeCalls()).toHaveLength(0);
    const wouldMerge = run.ledger.of('gate:would-merge') as Array<{ withheldBecause: string }>;
    expect(wouldMerge).toHaveLength(1);
    expect(wouldMerge[0]!.withheldBecause).toBe('shadow');
  });

  it('merges only when the stage names Devin AND two independent non-Devin judges shipped', async () => {
    const run = await runDevinE2E({ devinGranted: true });
    await run.pass();
    run.clock.now += JUDGE_RETRY_WAIT_MS;
    await run.pass();
    expect(run.judgeCalls).toEqual([['grok-cli'], ['codex', 'claude-cli']]);
    const appPr = [...run.f.pulls.values()][0]!;
    run.f.greenRequired(run.f.headOfPull(appPr.number)!);
    run.clock.now += 10 * 60 * 1000;
    const merged = await run.pass();
    expect(merged.merged).toBe(1);
    expect(run.f.mergeCalls()).toHaveLength(1);
    expect(run.ledger.of('gate:would-merge')).toHaveLength(0);
  });

  it('a rejection from the second judge refuses it, whatever the first judge said', async () => {
    const run = await runDevinE2E({ devinGranted: true, verdicts: ['ship', 'review'] });
    await run.pass();
    run.clock.now += JUDGE_RETRY_WAIT_MS;
    await run.pass();
    expect(run.ledger.kinds()).toContain('gate:result:G6:refuse');
    expect(run.ledger.kinds()).not.toContain('pr:opened');
    expect(run.proposal.status).toBe('rejected');
  });
});
