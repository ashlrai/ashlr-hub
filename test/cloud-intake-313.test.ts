/**
 * 3.13 — cloud-PR intake into the standing merge pass (fleet/cloud-intake.ts).
 *
 * Cloud / self-improvement PRs on `ashlr-cloud/<taskId>` become pending fleet
 * proposals the unchanged standing gates judge. Covered here: selection,
 * identity refusals (wrong head ref, moved base, repo not in grant, base not
 * the mirror's), dedupe per head and supersede on a new head, provenance
 * signed over the diff hash, G6 needing a non-Claude judge for `claude:cloud`,
 * G4 reading the report's status, the tracker following the App PR
 * (superseded → merged), KILL, the size caps — and one end-to-end run through
 * runStandingMergePass against the FakeGithub helper (a real bare repo).
 *
 * `gh` is always injected; tasks, proposals and fleet state live in the
 * worker's isolated HOME (test/setup/home.ts). No model is called.
 *
 * REAL-IO (git through the fake) in the end-to-end block only.
 */
import { rmSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

import { classifyCompletionClaimHeuristic, turnIntegrity } from '../src/core/classify/completion-claims.js';
import { closeCloudPr } from '../src/core/cloud/pr-actions.js';
import { cloudHome, readCloudTask, writeCloudTask } from '../src/core/cloud/store.js';
import { refreshCloudTasks } from '../src/core/cloud/tracker.js';
import type { CloudTaskV1 } from '../src/core/cloud/types.js';
import {
  CLOUD_INTAKE_ENGINE_MODEL,
  CLOUD_INTAKE_MAX_TASKS_PER_TICK,
  cloudIntakeSummary,
  ingestCloudPrs,
  resetCloudIntakeCursorForTest,
  type CloudIntakeDeps,
  type CloudIntakeMirror,
} from '../src/core/fleet/cloud-intake.js';
import type { FleetMergeStateRead, FleetMergeStateV1 } from '../src/core/fleet/fleet-merge-state.js';
import { allowedJudgeLanes, evaluateG6 } from '../src/core/fleet/merge-gates.js';
import { mirrorPathFor } from '../src/core/fleet/mirrors.js';
import { producerModelFamily } from '../src/core/fleet/reviewer-independence.js';
import { runStandingMergePass, type StandingPassDeps } from '../src/core/fleet/standing-merge-pass.js';
import type { AutoMergePassResult } from '../src/core/fleet/automerge-pass.js';
import type { FleetEngine, LandingRecord } from '../src/core/fleet/fleet-types.js';
import type { HostMergeDeps } from '../src/core/fleet/host-merge.js';
import { hashDiff, loadOrCreateKey, signProvenance, verifyProvenance } from '../src/core/foundry/provenance.js';
import { loadProposal } from '../src/core/inbox/store.js';
import type { EffectivePolicy } from '../src/core/authority/types.js';
import type { AshlrConfig, DecisionEntry, Proposal } from '../src/core/types.js';
import { FakeGithub, MemoryLedger, judgedDecision, repoPolicy, standingPolicy } from './helpers/fleet-github-310b.js';

beforeAll(() => {
  loadOrCreateKey();
});

beforeEach(() => {
  rmSync(cloudHome(), { recursive: true, force: true });
  resetCloudIntakeCursorForTest();
});

const REPO = 'ashlrai/cloud-canary';
const PR = 77;
const PR_URL = `https://github.com/${REPO}/pull/${PR}`;
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const MERGE_BASE = 'c'.repeat(40);
const cfg = {} as AshlrConfig;

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
const DIFF_B = DIFF.replace('a - b', 'b - a');
const REPORT_DONE = '```ashlr-cloud-report\n{"status":"done","summary":"Added the sub helper.","testsRun":["npm test"],"risks":[]}\n```';

let taskCounter = 0;
function seedTask(patch: Partial<CloudTaskV1> = {}): CloudTaskV1 {
  taskCounter++;
  const id = `ct_20260926T0400_${taskCounter.toString(36).padStart(6, '0')}`;
  const repo = patch.repo ?? REPO;
  const task: CloudTaskV1 = {
    v: 1, id, repo, baseBranch: 'main', branch: `ashlr-cloud/${id}`, title: 'Add a sub helper', prompt: 'p',
    origin: 'self-improve', requestedBy: 'self-improve', seat: 'claude-a', sessionId: 'session_x', sessionUrl: 'https://claude.ai/code/session_x',
    state: 'pr-open', stateReason: null, failure: null, createdAt: new Date(Date.now() - 60_000 * (100 - taskCounter)).toISOString(),
    launchedAt: null, updatedAt: new Date().toISOString(),
    pr: { number: PR, url: `https://github.com/${repo}/pull/${PR}`, state: 'open', draft: true, title: '[ashlr-cloud] Add a sub helper' },
    report: null, deliveryPin: { number: PR, url: `https://github.com/${repo}/pull/${PR}` },
    estimatedCostUsd: 3, backlogItemId: 'bl-sub-helper', needsYouId: null,
    ...patch,
  };
  writeCloudTask(task);
  return readCloudTask(id)!;
}

/** The cloud PR as `gh pr view` describes it; tests mutate it between calls. */
interface CloudPrFixture {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  isCrossRepository: boolean;
  body: string | null;
}

interface Harness {
  deps: Partial<CloudIntakeDeps>;
  calls: string[][];
  prs: Map<string, CloudPrFixture>;
  diffs: Map<string, string>;
  proposals: Map<string, Proposal>;
  fleet: Map<string, FleetMergeStateRead>;
  closes: { number: number; comment: string }[];
  kill: { on: boolean };
  /** Called on every `pr view`, e.g. to move the head mid-read. */
  onView: ((pr: CloudPrFixture, count: number) => void) | null;
}

function prFor(task: CloudTaskV1, patch: Partial<CloudPrFixture> = {}): CloudPrFixture {
  return {
    number: PR, url: `https://github.com/${task.repo}/pull/${PR}`, state: 'OPEN', isDraft: true, headRefOid: HEAD_A,
    headRefName: task.branch, baseRefName: task.baseBranch, isCrossRepository: false, body: REPORT_DONE, ...patch,
  };
}

function harness(): Harness {
  const h: Harness = {
    deps: {},
    calls: [],
    prs: new Map(),
    diffs: new Map([[HEAD_A, DIFF], [HEAD_B, DIFF_B]]),
    proposals: new Map(),
    fleet: new Map(),
    closes: [],
    kill: { on: false },
    onView: null,
  };
  let views = 0;
  let proposalCounter = 0;
  h.deps = {
    gh: async (args) => {
      h.calls.push(args);
      const repo = args[args.indexOf('--repo') + 1] ?? '';
      if (args[0] === 'pr' && args[1] === 'view') {
        const pr = h.prs.get(repo);
        if (!pr) return { ok: false, stdout: '', stderr: 'not found' };
        views++;
        h.onView?.(pr, views);
        return { ok: true, stdout: JSON.stringify(pr), stderr: '' };
      }
      if (args[0] === 'pr' && args[1] === 'close') {
        h.closes.push({ number: Number(args[2]), comment: args[args.indexOf('--comment') + 1]! });
        const pr = h.prs.get(repo);
        if (pr) pr.state = 'CLOSED';
        return { ok: true, stdout: '', stderr: '' };
      }
      if (args[0] === 'api' && args.includes('--jq')) {
        return { ok: true, stdout: JSON.stringify({ merge_base: MERGE_BASE }), stderr: '' };
      }
      if (args[0] === 'api' && args[1] === '-H') {
        const head = args[3]!.split('...')[1]!;
        const diff = h.diffs.get(head);
        return diff === undefined ? { ok: false, stdout: '', stderr: 'no diff' } : { ok: true, stdout: diff, stderr: '' };
      }
      return { ok: false, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
    },
    createProposal: (input) => {
      const proposal = { ...input, id: `p-cloud-${++proposalCounter}`, status: 'pending', createdAt: new Date().toISOString() } as Proposal;
      h.proposals.set(proposal.id, proposal);
      return proposal;
    },
    loadProposal: (id) => h.proposals.get(id) ?? null,
    rejectPending: (id, reason) => {
      const p = h.proposals.get(id);
      if (!p || p.status !== 'pending') return false;
      p.status = 'rejected';
      p.decisionReason = reason;
      return true;
    },
    readFleetMergeState: (key) => h.fleet.get(key) ?? { state: 'missing' },
    lockFleetState: () => () => undefined,
    killActive: () => h.kill.on,
  };
  return h;
}

const policy = (): EffectivePolicy => standingPolicy([repoPolicy(REPO)]);
const mirrors = (base = 'main'): CloudIntakeMirror[] => [{ nameWithOwner: REPO, path: mirrorPathFor(REPO), base }];

function fleetStateWithPr(proposalId: string, diffHash: string, number: number, prState: 'open' | 'closed' | 'merged' = 'open'): FleetMergeStateRead {
  return {
    state: 'ok',
    record: {
      kind: 'change', key: proposalId, proposalId, repo: REPO, diffHash,
      pr: { number, state: prState } as FleetMergeStateV1['pr'],
    } as FleetMergeStateV1,
  };
}

// ---------------------------------------------------------------------------

describe('cloud intake — selection', () => {
  it('ingests only pr-open, pinned, unsuperseded tasks in the grant, and reports why others are refused', async () => {
    const h = harness();
    const eligible = seedTask();
    seedTask({ state: 'running', pr: null, deliveryPin: undefined });
    seedTask({ deliveryPin: undefined });
    seedTask({ state: 'merged' });
    const foreign = seedTask({ repo: 'ashlrai/not-granted' });
    h.prs.set(REPO, prFor(eligible));

    const result = await ingestCloudPrs(cfg, policy(), { mirrors: mirrors(), deps: h.deps });

    expect(result.outcomes.map((o) => [o.taskId, o.action, o.code])).toEqual([
      [eligible.id, 'ingested', 'ingested'],
      [foreign.id, 'refused', 'repo-not-in-grant'],
    ]);
    expect(h.calls.filter((c) => c.includes('ashlrai/not-granted'))).toEqual([]); // refused before any GitHub call
    const proposal = [...h.proposals.values()][0]!;
    expect(proposal).toMatchObject({
      origin: 'agent', kind: 'pr', repo: mirrorPathFor(REPO), diff: DIFF, engineModel: 'claude:cloud', engineTier: 'frontier',
      workItemId: 'bl-sub-helper', runId: eligible.id, status: 'pending',
    });
    expect(readCloudTask(eligible.id)!.intake).toMatchObject({ headSha: HEAD_A, proposalId: proposal.id, diffHash: hashDiff(DIFF), refused: null });
  });

  it('refuses a repo with no current mirror this tick, and a task whose base is not the mirror\'s default branch', async () => {
    const h = harness();
    const t = seedTask();
    h.prs.set(REPO, prFor(t));
    const none = await ingestCloudPrs(cfg, policy(), { mirrors: [], deps: h.deps });
    expect(none.outcomes).toMatchObject([{ action: 'refused', code: 'no-mirror' }]);
    const other = await ingestCloudPrs(cfg, policy(), { mirrors: mirrors('develop'), deps: h.deps });
    expect(other.outcomes).toMatchObject([{ action: 'refused', code: 'base-not-mirror-default' }]);
    expect(h.proposals.size).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it('is bounded per call and rotates through a longer queue', async () => {
    const h = harness();
    const tasks = Array.from({ length: CLOUD_INTAKE_MAX_TASKS_PER_TICK + 2 }, () => seedTask({ repo: 'ashlrai/not-granted' }));
    const first = await ingestCloudPrs(cfg, policy(), { mirrors: mirrors(), deps: h.deps });
    const second = await ingestCloudPrs(cfg, policy(), { mirrors: mirrors(), deps: h.deps });
    expect(first.checked).toBe(CLOUD_INTAKE_MAX_TASKS_PER_TICK);
    const seen = new Set([...first.outcomes, ...second.outcomes].map((o) => o.taskId));
    expect(seen.size).toBe(tasks.length);
  });
});

describe('cloud intake — identity refusals', () => {
  it('refuses a head ref that is not ashlr-cloud/<taskId>', async () => {
    const h = harness();
    const t = seedTask();
    h.prs.set(REPO, prFor(t, { headRefName: 'feature/sneaky' }));
    const result = await ingestCloudPrs(cfg, policy(), { mirrors: mirrors(), deps: h.deps });
    expect(result.outcomes).toMatchObject([{ action: 'refused', code: 'head-ref-mismatch' }]);
    expect(h.proposals.size).toBe(0);
    expect(h.calls.some((c) => c[0] === 'api')).toBe(false);
  });

  it('refuses a PR whose base moved away from the task\'s base', async () => {
    const h = harness();
    const t = seedTask();
    h.prs.set(REPO, prFor(t, { baseRefName: 'release' }));
    const result = await ingestCloudPrs(cfg, policy(), { mirrors: mirrors(), deps: h.deps });
    expect(result.outcomes).toMatchObject([{ action: 'refused', code: 'base-moved' }]);
    expect(h.proposals.size).toBe(0);
  });

  it('refuses a PR that is no longer the pinned delivery, or lives in another repository', async () => {
    const h = harness();
    const t = seedTask();
    h.prs.set(REPO, prFor(t, { number: 78 }));
    expect((await ingestCloudPrs(cfg, policy(), { mirrors: mirrors(), deps: h.deps })).outcomes).toMatchObject([{ code: 'pr-identity-changed' }]);
    h.prs.set(REPO, prFor(t, { isCrossRepository: true }));
    expect((await ingestCloudPrs(cfg, policy(), { mirrors: mirrors(), deps: h.deps })).outcomes).toMatchObject([{ code: 'cross-repository' }]);
    expect(h.proposals.size).toBe(0);
  });

  it('defers (never mixes) when the head moves while the diff is read', async () => {
    const h = harness();
    const t = seedTask();
    h.prs.set(REPO, prFor(t));
    h.onView = (pr, count) => {
      if (count === 2) pr.headRefOid = HEAD_B; // the re-read after the download
    };
    const result = await ingestCloudPrs(cfg, policy(), { mirrors: mirrors(), deps: h.deps });
    expect(result.outcomes).toMatchObject([{ action: 'deferred', code: 'head-moved' }]);
    expect(h.proposals.size).toBe(0);
    expect(readCloudTask(t.id)!.intake).toBeUndefined();
  });
});

describe('cloud intake — dedupe and supersede', () => {
  it('files one proposal per head, and a new head supersedes the old pending proposal', async () => {
    const h = harness();
    const t = seedTask();
    h.prs.set(REPO, prFor(t));
    await ingestCloudPrs(cfg, policy(), { mirrors: mirrors(), deps: h.deps });
    const again = await ingestCloudPrs(cfg, policy(), { mirrors: mirrors(), deps: h.deps });
    expect(again.outcomes).toMatchObject([{ action: 'unchanged', code: 'already-ingested' }]);
    expect(h.proposals.size).toBe(1);
    expect(h.calls.filter((c) => c[0] === 'api')).toHaveLength(2); // the diff was read once

    h.prs.get(REPO)!.headRefOid = HEAD_B;
    const next = await ingestCloudPrs(cfg, policy(), { mirrors: mirrors(), deps: h.deps });
    expect(next.outcomes).toMatchObject([{ action: 'ingested', headSha: HEAD_B }]);
    const [old, fresh] = [...h.proposals.values()];
    expect(old!.status).toBe('rejected');
    expect(old!.decisionReason).toMatch(/superseded by newer head bbbbbbbbbbbb/);
    expect(fresh).toMatchObject({ status: 'pending', diff: DIFF_B });
    expect(readCloudTask(t.id)!.intake).toMatchObject({ headSha: HEAD_B, proposalId: fresh!.id });
  });

  it('never supersedes a proposal the standing pass already carries in an App PR — it closes the cloud PR instead', async () => {
    const h = harness();
    const t = seedTask();
    h.prs.set(REPO, prFor(t));
    await ingestCloudPrs(cfg, policy(), { mirrors: mirrors(), deps: h.deps });
    const proposal = [...h.proposals.values()][0]!;
    h.fleet.set(proposal.id, fleetStateWithPr(proposal.id, hashDiff(DIFF), 12));
    h.prs.get(REPO)!.headRefOid = HEAD_B; // a later push does not ride along

    const result = await ingestCloudPrs(cfg, policy(), { mirrors: mirrors(), deps: h.deps });
    expect(result.outcomes).toMatchObject([{ action: 'superseded', appPr: 12, proposalId: proposal.id }]);
    expect(h.closes).toHaveLength(1);
    expect(h.closes[0]!.number).toBe(PR);
    expect(h.closes[0]!.comment).toMatch(/^Superseded by #12: /);
    expect(h.closes[0]!.comment).toMatch(/Commits pushed after aaaaaaaaaaaa are not part of #12/);
    expect(proposal.status).toBe('pending');
    expect(h.proposals.size).toBe(1);
    const after = readCloudTask(t.id)!;
    expect(after).toMatchObject({ state: 'pr-open', supersededBy: { repo: REPO, number: 12 }, pr: { state: 'closed' } });
    expect(after.stateReason).toMatch(/Superseded by fleet PR #12/);

    // Superseded tasks are no longer candidates; Needs-you actions refuse them.
    const later = await ingestCloudPrs(cfg, policy(), { mirrors: mirrors(), deps: h.deps });
    expect(later.checked).toBe(0);
    const closeAttempt = await closeCloudPr(t.id, HEAD_B, { gh: h.deps.gh! });
    expect(closeAttempt).toMatchObject({ ok: false, status: 409 });
  });

  it('does not close the cloud PR for an App PR carrying a different diff, or one already closed', async () => {
    const h = harness();
    const t = seedTask();
    h.prs.set(REPO, prFor(t));
    await ingestCloudPrs(cfg, policy(), { mirrors: mirrors(), deps: h.deps });
    const proposal = [...h.proposals.values()][0]!;
    h.fleet.set(proposal.id, fleetStateWithPr(proposal.id, hashDiff('something else'), 12));
    await ingestCloudPrs(cfg, policy(), { mirrors: mirrors(), deps: h.deps });
    h.fleet.set(proposal.id, fleetStateWithPr(proposal.id, hashDiff(DIFF), 12, 'closed'));
    await ingestCloudPrs(cfg, policy(), { mirrors: mirrors(), deps: h.deps });
    expect(h.closes).toEqual([]);
    expect(readCloudTask(t.id)!.supersededBy).toBeUndefined();
  });
});

describe('cloud intake — provenance, claims and the judge family', () => {
  it('signs provenance over the diff hash for claude:cloud (identity only), and a changed diff no longer verifies', async () => {
    const h = harness();
    const t = seedTask();
    h.prs.set(REPO, prFor(t));
    await ingestCloudPrs(cfg, policy(), { mirrors: mirrors(), deps: h.deps });
    const proposal = [...h.proposals.values()][0]!;
    expect(proposal.diffHash).toBe(hashDiff(DIFF));
    expect(proposal.provenanceSig).toBe(signProvenance('claude:cloud', 'frontier', hashDiff(DIFF)));
    expect(verifyProvenance(proposal).ok).toBe(true);
    expect(verifyProvenance({ ...proposal, diff: DIFF_B }).ok).toBe(false);
    expect(verifyProvenance({ ...proposal, engineModel: 'grok-cli:grok-4.7' }).ok).toBe(false);
    expect(proposal.summary).toMatch(/UNVERIFIED/);
    expect(proposal.summary).toContain(PR_URL);
  });

  it('G6: claude:cloud is family claude, so only a non-Claude judge can pass it', () => {
    expect(producerModelFamily(CLOUD_INTAKE_ENGINE_MODEL)).toBe('claude');
    const now = Date.now();
    expect(allowedJudgeLanes('claude', null, now)).toEqual(['codex']);
    const widened = allowedJudgeLanes('claude', now - 25 * 3_600_000, now);
    expect(widened).not.toContain('claude-cli');
    expect(widened).not.toContain('local');

    const proposal = { id: 'p-cloud-g6', diff: DIFF, engineModel: CLOUD_INTAKE_ENGINE_MODEL } as Proposal;
    const byClaude = evaluateG6({ proposalId: proposal.id, producerModel: proposal.engineModel, diff: DIFF, decisions: [judgedDecision(proposal, 'claude-opus-4-8')], nowMs: Date.now() });
    expect(byClaude).toMatchObject({ verdict: 'wait', code: 'judge-ineligible', needsJudge: true });
    const byCodex = evaluateG6({ proposalId: proposal.id, producerModel: proposal.engineModel, diff: DIFF, decisions: [judgedDecision(proposal, 'gpt-5.5')], nowMs: Date.now() });
    expect(byCodex).toMatchObject({ verdict: 'pass', code: 'judge-ship' });
  });

  it('G4 reads the report\'s status: a blocked / no-change report over a diff is a silent change', () => {
    const t = seedTask();
    const pr = { url: PR_URL, headSha: HEAD_A };
    const report = (status: 'done' | 'partial' | 'blocked' | 'no-change') =>
      ({ status, summary: 'I fixed and updated and added everything', testsRun: ['npm test'], risks: [] });
    const claim = (text: string) => classifyCompletionClaimHeuristic(text);
    expect(claim(cloudIntakeSummary(t, report('done'), pr))).toBe('claims-change');
    expect(claim(cloudIntakeSummary(t, report('partial'), pr))).toBe('claims-change');
    const blocked = cloudIntakeSummary(t, report('blocked'), pr);
    expect(blocked).not.toMatch(/fixed and updated/); // free text withheld
    expect(claim(blocked)).toBe('reports-blocked');
    expect(turnIntegrity(claim(blocked), 1)).toBe('silent-change');
    expect(claim(cloudIntakeSummary(t, report('no-change'), pr))).toBe('reports-blocked');
    expect(claim(cloudIntakeSummary(t, null, pr))).toBe('unknown');
  });
});

describe('cloud intake — caps and KILL', () => {
  it('refuses an oversized diff once per head (remembered, not re-downloaded)', async () => {
    const h = harness();
    const t = seedTask();
    h.prs.set(REPO, prFor(t));
    const files = Array.from({ length: 11 }, (_, i) => [
      `diff --git a/src/f${i}.ts b/src/f${i}.ts`, 'new file mode 100644', 'index 0000000..1111111', '--- /dev/null', `+++ b/src/f${i}.ts`, '@@ -0,0 +1 @@', `+export const f${i} = ${i};`,
    ].join('\n'));
    h.diffs.set(HEAD_A, `${files.join('\n')}\n`);
    const result = await ingestCloudPrs(cfg, policy(), { mirrors: mirrors(), deps: h.deps });
    expect(result.outcomes).toMatchObject([{ action: 'refused', code: 'diff-over-caps', headSha: HEAD_A }]);
    expect(readCloudTask(t.id)!.intake).toMatchObject({ headSha: HEAD_A, proposalId: null, refused: 'diff-over-caps' });
    const apiCalls = h.calls.filter((c) => c[0] === 'api').length;
    const again = await ingestCloudPrs(cfg, policy(), { mirrors: mirrors(), deps: h.deps });
    expect(again.outcomes).toMatchObject([{ action: 'unchanged', code: 'already-refused:diff-over-caps' }]);
    expect(h.calls.filter((c) => c[0] === 'api')).toHaveLength(apiCalls);

    h.diffs.set(HEAD_B, `${DIFF}${'+x\n'.repeat(1)}${'#'.repeat(300 * 1024)}\n`);
    h.prs.get(REPO)!.headRefOid = HEAD_B;
    const big = await ingestCloudPrs(cfg, policy(), { mirrors: mirrors(), deps: h.deps });
    expect(big.outcomes).toMatchObject([{ action: 'refused', code: 'diff-over-caps', headSha: HEAD_B }]);
    expect(h.proposals.size).toBe(0);
  });

  it('refuses a diff the proposal store would rewrite (secret-like content), and an empty head', async () => {
    const h = harness();
    const t = seedTask();
    h.prs.set(REPO, prFor(t));
    h.diffs.set(HEAD_A, DIFF.replace('a - b', `'${'f'.repeat(40)}'`));
    expect((await ingestCloudPrs(cfg, policy(), { mirrors: mirrors(), deps: h.deps })).outcomes).toMatchObject([{ code: 'diff-not-canonical' }]);
    h.diffs.set(HEAD_B, '');
    h.prs.get(REPO)!.headRefOid = HEAD_B;
    expect((await ingestCloudPrs(cfg, policy(), { mirrors: mirrors(), deps: h.deps })).outcomes).toMatchObject([{ code: 'empty-diff' }]);
    expect(h.proposals.size).toBe(0);
  });

  it('KILL: nothing is read, filed or closed', async () => {
    const h = harness();
    const t = seedTask();
    h.prs.set(REPO, prFor(t));
    h.kill.on = true;
    const result = await ingestCloudPrs(cfg, policy(), { mirrors: mirrors(), deps: h.deps });
    expect(result).toMatchObject({ killed: true, checked: 0, outcomes: [] });
    expect(h.calls).toEqual([]);
    expect(h.proposals.size).toBe(0);
  });
});

describe('cloud tracker — follows the App PR of a superseded task', () => {
  const appPr = (state: 'OPEN' | 'MERGED' | 'CLOSED', headRefName = 'ashlr/fleet/p-cloud-1') =>
    JSON.stringify({ number: 12, url: `https://github.com/${REPO}/pull/12`, state, headRefName });

  function trackerGh(answer: () => string) {
    const calls: string[][] = [];
    return {
      calls,
      gh: async (args: string[]) => {
        calls.push(args);
        return { ok: true, stdout: answer(), stderr: '' };
      },
    };
  }

  it('superseded → merged when the App PR merges (so the backlog item is never released again)', async () => {
    const t = seedTask({ supersededBy: { repo: REPO, number: 12 }, pr: { number: PR, url: PR_URL, state: 'closed', draft: true, title: 't' } });
    let state: 'OPEN' | 'MERGED' | 'CLOSED' = 'OPEN';
    const { gh, calls } = trackerGh(() => appPr(state));
    await refreshCloudTasks({ gh });
    expect(calls[0]).toEqual(['pr', 'view', '12', '--repo', REPO, '--json', 'number,url,state,headRefName']);
    expect(readCloudTask(t.id)).toMatchObject({ state: 'pr-open', stateReason: expect.stringMatching(/Superseded by fleet PR #12/) });
    state = 'MERGED';
    expect(await refreshCloudTasks({ gh })).toMatchObject({ updated: 1 });
    expect(readCloudTask(t.id)).toMatchObject({ state: 'merged', stateReason: 'Landed through the standing gates as fleet PR #12.' });
  });

  it('superseded → closed when the App PR closes; a foreign or unreadable answer changes nothing', async () => {
    const t = seedTask({ supersededBy: { repo: REPO, number: 12 }, pr: { number: PR, url: PR_URL, state: 'closed', draft: true, title: 't' } });
    const before = readCloudTask(t.id)!;
    await refreshCloudTasks(trackerGh(() => appPr('MERGED', 'feature/not-fleet')));
    await refreshCloudTasks(trackerGh(() => 'not json'));
    expect(readCloudTask(t.id)).toEqual(before);
    await refreshCloudTasks(trackerGh(() => appPr('CLOSED')));
    expect(readCloudTask(t.id)).toMatchObject({ state: 'closed', stateReason: 'Fleet PR #12 was closed without merging.' });
  });
});

// ---------------------------------------------------------------------------
// End to end: cloud PR → intake → standing pass (real gates, fake GitHub) →
// App PR → cloud PR closed → merge → tracker marks the task merged.
// ---------------------------------------------------------------------------

describe('cloud intake — end to end through the standing merge pass', () => {
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

  it('lands a cloud PR through G0–G7 with a non-Claude judge, supersedes the cloud PR, and the task ends merged', async () => {
    const repo = 'ashlrai/cloud-e2e';
    fake = new FakeGithub({ repo });
    const f = fake;
    const task = seedTask({ repo, pr: { number: PR, url: `https://github.com/${repo}/pull/${PR}`, state: 'open', draft: true, title: 't' }, deliveryPin: { number: PR, url: `https://github.com/${repo}/pull/${PR}` } });
    // The cloud session's branch on the origin: one commit on top of main.
    f.git(['update-ref', `refs/heads/${task.branch}`, f.head()!]);
    const cloudHead = f.pushCommit(task.branch, { 'src/sub.ts': 'export const sub = (a: number, b: number): number => a - b;\n' }, 'cloud: add sub');
    const cloudPr = { state: 'OPEN' as 'OPEN' | 'CLOSED', comments: [] as string[] };

    const gh = async (args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'view' && args[2] === String(PR)) {
        return {
          ok: true,
          stdout: JSON.stringify({
            number: PR, url: `https://github.com/${repo}/pull/${PR}`, state: cloudPr.state, isDraft: true,
            headRefOid: f.head(task.branch), headRefName: task.branch, baseRefName: 'main', isCrossRepository: false, body: REPORT_DONE,
          }),
          stderr: '',
        };
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        // The tracker following the fleet App PR.
        const pull = f.pulls.get(Number(args[2]));
        if (!pull) return { ok: false, stdout: '', stderr: 'not found' };
        const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        return { ok: true, stdout: JSON.stringify({ number: pull.number, url: `https://github.com/${repo}/pull/${pull.number}`, state, headRefName: pull.headRef }), stderr: '' };
      }
      if (args[0] === 'pr' && args[1] === 'close') {
        cloudPr.state = 'CLOSED';
        cloudPr.comments.push(args[args.indexOf('--comment') + 1]!);
        return { ok: true, stdout: '', stderr: '' };
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

    const livePolicy = { current: standingPolicy([repoPolicy(repo)], { engines: ['local', 'grok-cli', 'claude-cli', 'codex'] }) as EffectivePolicy };
    const e2eMirrors: CloudIntakeMirror[] = [{ nameWithOwner: repo, path: f.mirror, base: 'main' }];

    // ── Tick 1: intake files a REAL pending proposal in the mirror ─────────
    const intake = await ingestCloudPrs(cfg, livePolicy.current, { mirrors: e2eMirrors, deps: { gh } });
    expect(intake.outcomes).toMatchObject([{ action: 'ingested', headSha: cloudHead }]);
    const proposal = loadProposal(intake.outcomes[0]!.proposalId!)!;
    expect(proposal).toMatchObject({ status: 'pending', engineModel: 'claude:cloud', kind: 'pr', origin: 'agent' });
    expect(verifyProvenance(proposal).ok).toBe(true);

    // ── Tick 1: the unchanged standing pass takes it through G0–G6 ─────────
    const ledger = new MemoryLedger();
    const clock = { now: Date.now() };
    const proposals = new Map<string, Proposal>([[proposal.id, proposal]]);
    const decisions = new Map<string, DecisionEntry[]>();
    const judgeCalls: FleetEngine[][] = [];
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
      judgeSeatLanes: ({ producerFamily, waitSinceMs, nowMs }) => ({
        lanes: allowedJudgeLanes(producerFamily, waitSinceMs, nowMs).filter((lane) => ['codex', 'grok-cli', 'claude-cli'].includes(lane)),
        nextEligibleAt: null,
      }),
      runJudge: async (p, _cfg, lanes) => {
        judgeCalls.push([...lanes]);
        const judge = JUDGE_FOR_LANE[lanes[0]!];
        decisions.set(p.id, [...(decisions.get(p.id) ?? []), judgedDecision(p, judge, 'ship', new Date(clock.now))]);
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

    const first = await pass();
    expect(ledger.kinds()).toEqual([
      'gate:result:G0:pass', 'gate:result:G1:pass', 'gate:result:G1b:pass', 'gate:result:G2:pass', 'gate:result:G3:pass',
      'gate:result:G4:pass', 'gate:result:G5:pass', 'gate:result:G6:pass', 'pr:opened',
    ]);
    expect(first.prsOpened).toBe(1);
    expect(judgeCalls).toEqual([['codex']]); // Claude-produced work is never judged by Claude
    const appPr = [...f.pulls.values()][0]!;
    expect(appPr.headRef).toBe(`ashlr/fleet/${proposal.id}`);
    // The App PR's tree is exactly the cloud head's tree (the diff, rebuilt on the verified base).
    expect(f.treeOf(f.headOfPull(appPr.number)!)).toBe(f.treeOf(cloudHead));

    // ── Tick 2: intake closes the cloud PR in favour of the App PR ─────────
    const second = await ingestCloudPrs(cfg, livePolicy.current, { mirrors: e2eMirrors, deps: { gh } });
    expect(second.outcomes).toMatchObject([{ action: 'superseded', appPr: appPr.number }]);
    expect(cloudPr.state).toBe('CLOSED');
    expect(cloudPr.comments[0]).toMatch(new RegExp(`^Superseded by #${appPr.number}: `));
    expect(readCloudTask(task.id)).toMatchObject({ state: 'pr-open', supersededBy: { repo, number: appPr.number } });

    // ── The App PR goes green and the pass merges it, SHA-pinned ───────────
    f.greenRequired(f.headOfPull(appPr.number)!);
    clock.now += 10 * 60 * 1000;
    const merged = await pass();
    expect(merged.merged).toBe(1);
    expect(f.mergeCalls()).toHaveLength(1);

    // ── The tracker follows the App PR: the task is merged, not closed ─────
    await refreshCloudTasks({ gh });
    expect(readCloudTask(task.id)).toMatchObject({ state: 'merged', stateReason: `Landed through the standing gates as fleet PR #${appPr.number}.` });
  });
});
