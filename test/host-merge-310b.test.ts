/**
 * V3.10 Track B unit U3 — host merge through the ashlr-fleet GitHub App
 * (fleet/host-merge.ts) against a fake GitHub backed by a REAL bare repo.
 *
 * Key SPEC-310B §7 U3 tests: "Fake GitHub: SHA pin, trailers,
 * revoke-before-consume", "Head-SHA race". Also: the published tree is
 * exactly the verified tree, the App never clobbers a human push, the Leader
 * can only close / reopen the fleet's own PRs, and U4's revert lander.
 *
 * REAL-IO (spawns git through the fake): belongs in the real-io lane —
 * requested in the U3 report (test/config/realio-lane-membership.mjs).
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Real git work: generous until this file joins REAL_IO_TEST_FILES (see header).
vi.setConfig({ testTimeout: 30_000 });

import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import { readHostMergeRevocationState } from '../src/core/autonomy/host-merge-revocation-protocol.js';
import {
  FLEET_APP_BOT_EMAIL_RE,
  OWNER_LANE_LABEL,
  closeFleetPr,
  closeGitScratch,
  fleetMergeCommitMessage,
  landFleetRevert,
  landingId,
  mergeFleetPrPinned,
  openFleetPr,
  openGitScratch,
  parseFleetTrailers,
  policyEpochDigest,
  untrustedText,
  publishVerifiedTree,
  readPr,
  readRequiredChecks,
  reopenFleetPr,
  revokeArmedHostMerges,
  scratchTreeChanges,
  treeForDiff,
  type FleetGitScratch,
  type HostMergeDeps,
  type PinnedMergeInput,
} from '../src/core/fleet/host-merge.js';
import { newFleetMergeState, writeFleetMergeState, type FleetMergeStateV1 } from '../src/core/fleet/fleet-merge-state.js';
import type { LandingRecord } from '../src/core/fleet/fleet-types.js';
import { mirrorLeaseKey } from '../src/core/fleet/mirrors.js';
import { acquireRepoLease } from '../src/core/sandbox/execution-leases.js';
import { BOT_LOGIN, FakeGithub, MemoryLedger, repoPolicy, standingPolicy } from './helpers/fleet-github-310b.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

let fakes: FakeGithub[] = [];
let scratches: FleetGitScratch[] = [];
let counter = 0;

beforeAll(() => {
  loadOrCreateKey();
});

afterEach(() => {
  for (const scratch of scratches) closeGitScratch(scratch);
  for (const fake of fakes) fake.dispose();
  fakes = [];
  scratches = [];
});

interface Harness {
  fake: FakeGithub;
  ledger: MemoryLedger;
  deps: HostMergeDeps;
  kill: { on: boolean };
  repo: string;
}

function harness(opts: ConstructorParameters<typeof FakeGithub>[0] = {}): Harness {
  counter++;
  const repo = `ashlrai/canary-hm${counter}`;
  const fake = new FakeGithub({ repo, ...opts });
  fakes.push(fake);
  const ledger = new MemoryLedger();
  const kill = { on: false };
  const policy = standingPolicy([repoPolicy(repo)]);
  const deps: HostMergeDeps = {
    transport: fake.transport,
    token: async () => ({ token: 'ghs_test_installation_token', expiresAt: null }),
    nowMs: () => Date.now(),
    sleep: async () => undefined,
    killActive: () => kill.on,
    killEpoch: () => sha256(`kill:${kill.on}`),
    policy: () => policy,
    appendLedger: ledger.append,
    ledgerHead: ledger.head,
  };
  return { fake, ledger, deps, kill, repo };
}

function scratchFor(fake: FakeGithub): FleetGitScratch {
  const scratch = openGitScratch(fake.mirror);
  if (typeof scratch === 'string') throw new Error(scratch);
  scratches.push(scratch);
  return scratch;
}

const CHANGE = {
  'src/math.ts': 'export function add(a: number, b: number): number {\n  if (!Number.isFinite(a + b)) throw new Error("not finite");\n  return a + b;\n}\n',
  'src/sub.ts': 'export const sub = (a: number, b: number): number => a - b;\n',
};

/** Publish CHANGE on a fleet branch and open its PR. */
async function openChange(h: Harness, key = `p-${counter}`, ownerLane = false) {
  const { diff, tree } = h.fake.diffAndTree(CHANGE);
  const scratch = scratchFor(h.fake);
  const base = h.fake.head()!;
  const computed = treeForDiff(scratch, base, diff);
  if (!computed.ok) throw new Error(computed.reason);
  expect(computed.treeSha).toBe(tree);
  const branch = `ashlr/fleet/${key}`;
  const published = await publishVerifiedTree({ repo: h.repo, branch, baseSha: base, treeSha: tree, scratch, commitMessage: `ashlr fleet: change ${key}\n` }, h.deps);
  if (!published.ok) throw new Error(published.reason);
  const opened = await openFleetPr({
    repo: h.repo,
    branch,
    baseBranch: 'main',
    headSha: published.headSha,
    baseSha: base,
    treeSha: tree,
    title: `ashlr fleet: change ${key}`,
    body: 'test',
    ownerLane,
    ownerLaneReason: ownerLane ? 'touches package.json' : null,
  }, h.deps);
  if (!opened.ok) throw new Error(opened.reason);
  const state: FleetMergeStateV1 = {
    ...newFleetMergeState({ key, kind: 'change', proposalId: key, revertsLandingId: null, repo: h.repo, repoPath: h.fake.mirror, enforcement: 'server', nowIso: new Date().toISOString() }),
    pr: opened.pr,
  };
  expect(writeFleetMergeState(state)).toBe(true);
  return { state, base, tree, head: published.headSha, branch, diff };
}

function pinnedInput(h: Harness, state: FleetMergeStateV1, overrides: Partial<PinnedMergeInput> = {}): PinnedMergeInput {
  const policy = h.deps.policy()!;
  const epoch = policyEpochDigest(policy, h.repo)!;
  const trailers = { grantId: policy.grantId, gatesDigest: sha256('gates'), ledgerHead: sha256('ledger-head'), stageId: policy.rollout.stageId };
  return {
    state,
    trailers,
    commitTitle: `ashlr fleet: change (#${state.pr!.number})`,
    commitMessage: fleetMergeCommitMessage('Adds sub and guards add.', { ...trailers, proposalId: state.proposalId }),
    identity: {
      evidencePackDigest: trailers.gatesDigest,
      verifierManifestDigest: sha256('verify'),
      protectionPolicyDigest: sha256('protection'),
      policyEpoch: epoch,
    },
    currentPolicyEpoch: () => epoch,
    recheck: async () => null,
    ...overrides,
  };
}

describe('publishing the verified tree through the Git Data API', () => {
  it('computes exactly the tree verification tests (apply --index in a worktree) without touching the mirror', () => {
    const h = harness();
    const { diff, tree } = h.fake.diffAndTree({ ...CHANGE, 'README.md': null });
    const scratch = scratchFor(h.fake);
    expect(treeForDiff(scratch, h.fake.head()!, diff)).toEqual({ ok: true, treeSha: tree });
    const conflicting = diff.replace('return a + b;', 'return a * b;');
    const bad = treeForDiff(scratch, h.fake.head()!, conflicting);
    expect(bad).toMatchObject({ ok: false, conflict: true });
  });

  it('reports what the built tree really changes, including a symlink the diff adds', () => {
    const h = harness();
    const scratch = scratchFor(h.fake);
    const base = h.fake.head()!;
    const link = [
      'diff --git a/src/escape b/src/escape',
      'new file mode 120000',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/src/escape',
      '@@ -0,0 +1 @@',
      '+../../.ashlr/authority',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    const tree = treeForDiff(scratch, base, link);
    expect(tree.ok).toBe(true);
    if (!tree.ok) return;
    expect(scratchTreeChanges(scratch, base, tree.treeSha)).toEqual([{ path: 'src/escape', mode: '120000', oldMode: null }]);
    const { diff } = h.fake.diffAndTree({ 'README.md': null, 'src/new.ts': 'x\n' });
    const plain = treeForDiff(scratch, base, diff);
    if (!plain.ok) throw new Error(plain.reason);
    expect(scratchTreeChanges(scratch, base, plain.treeSha)).toEqual([
      { path: 'README.md', mode: null, oldMode: '100644' },
      { path: 'src/new.ts', mode: '100644', oldMode: null },
    ]);
  });

  it('publishes a commit whose tree is the verified tree and whose only parent is the verified base, authored by the App', async () => {
    const h = harness();
    const { head, base, tree, branch } = await openChange(h);
    expect(h.fake.head(branch)).toBe(head);
    expect(h.fake.treeOf(head)).toBe(tree);
    const commit = h.fake.git(['cat-file', 'commit', head]);
    expect(commit).toContain(`parent ${base}`);
    expect(commit.match(/^parent /gm)).toHaveLength(1);
    expect(commit).toMatch(/author ashlr-fleet\[bot\] <\d+\+ashlr-fleet\[bot\]@users\.noreply\.github\.com>/);
    const blobs = h.fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/git/blobs'));
    expect(blobs).toHaveLength(2);
    // The token never appears in anything recorded.
    expect(JSON.stringify(h.fake.calls)).not.toContain('ghs_test_installation_token');
  });

  it('INT3 (U6): the publish is the fleet\'s push — it waits for the mirror\'s repo lease and touches GitHub only while holding it', async () => {
    const h = harness();
    const { diff, tree } = h.fake.diffAndTree(CHANGE);
    const scratch = scratchFor(h.fake);
    const base = h.fake.head()!;
    expect(treeForDiff(scratch, base, diff)).toMatchObject({ ok: true, treeSha: tree });
    const held = await acquireRepoLease(mirrorLeaseKey(h.fake.mirror), { waitMs: 1_000 });
    if (!held.ok) throw new Error(held.reason);
    const callsBefore = h.fake.calls.length;
    let settled = false;
    const publishing = publishVerifiedTree(
      { repo: h.repo, branch: `ashlr/fleet/lease-${counter}`, baseSha: base, treeSha: tree, scratch, commitMessage: 'lease\n' },
      h.deps,
    ).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(settled).toBe(false);
    expect(h.fake.calls.length).toBe(callsBefore); // nothing reached GitHub while a sync / agent held the lease
    held.lease.release();
    const result = await publishing;
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  });

  it('refuses to publish outside ashlr/fleet/, over a human push, or when GitHub builds a different tree', async () => {
    const h = harness();
    const { diff, tree } = h.fake.diffAndTree(CHANGE);
    const scratch = scratchFor(h.fake);
    const base = h.fake.head()!;
    // Production computes the tree in the scratch first (so its objects exist there).
    expect(treeForDiff(scratch, base, diff)).toEqual({ ok: true, treeSha: tree });
    const input = { repo: h.repo, baseSha: base, treeSha: tree, scratch, commitMessage: 'x\n' };
    expect(await publishVerifiedTree({ ...input, branch: 'main' }, h.deps)).toMatchObject({ ok: false, code: 'branch-foreign' });

    h.fake.pushCommit('ashlr/fleet/human', { 'notes.md': 'mine\n' });
    const humanHead = h.fake.head('ashlr/fleet/human');
    expect(await publishVerifiedTree({ ...input, branch: 'ashlr/fleet/human' }, h.deps)).toMatchObject({ ok: false, code: 'branch-foreign' });
    expect(h.fake.head('ashlr/fleet/human')).toBe(humanHead);

    h.fake.corruptTrees = true;
    expect(await publishVerifiedTree({ ...input, branch: 'ashlr/fleet/corrupt' }, h.deps)).toMatchObject({ ok: false, code: 'tree-mismatch' });
    expect(h.fake.head('ashlr/fleet/corrupt')).toBeNull();
    expect(diff).toContain('src/sub.ts');
  });

  it('opens the PR as the App and labels an owner-lane PR', async () => {
    const h = harness();
    const { state } = await openChange(h, 'owner-1', true);
    const pull = h.fake.pulls.get(state.pr!.number)!;
    expect(pull.userLogin).toBe(BOT_LOGIN);
    expect([...pull.labels]).toEqual([OWNER_LANE_LABEL]);
    expect(state.pr).toMatchObject({ ownerLane: true, ownerLaneReason: 'touches package.json' });
    expect(await mergeFleetPrPinned(pinnedInput(h, state), h.deps)).toMatchObject({ ok: false, code: 'protocol' });
    expect(h.fake.mergeCalls()).toHaveLength(0);
  });

  it('never opens a PR against a branch other than the repo\'s default (GitHub\'s answer, not the mirror\'s)', async () => {
    const h = harness();
    const { diff, tree } = h.fake.diffAndTree(CHANGE);
    const base = h.fake.head()!;
    h.fake.pushCommit('release', { 'RELEASE.md': 'release line\n' }, 'release branch');
    const scratch = scratchFor(h.fake);
    expect(treeForDiff(scratch, base, diff)).toEqual({ ok: true, treeSha: tree });
    const published = await publishVerifiedTree({ repo: h.repo, branch: 'ashlr/fleet/off-default', baseSha: base, treeSha: tree, scratch, commitMessage: 'ashlr fleet: off default\n' }, h.deps);
    if (!published.ok) throw new Error(published.reason);
    const opened = await openFleetPr({
      repo: h.repo,
      branch: 'ashlr/fleet/off-default',
      baseBranch: 'release',
      headSha: published.headSha,
      baseSha: base,
      treeSha: tree,
      title: 'ashlr fleet: off default',
      body: 'test',
      ownerLane: false,
      ownerLaneReason: null,
    }, h.deps);
    expect(opened).toMatchObject({ ok: false, retryable: false });
    expect(opened.ok ? '' : opened.reason).toContain('is not the default branch main');
    expect(h.fake.pulls.size).toBe(0);
  });

  it('reads the required checks from rulesets (metadata permission) with their App ids', async () => {
    const h = harness({ required: [{ context: 'ci/test', appId: 15368 }, { context: 'lint', appId: null }] });
    const read = await readRequiredChecks(h.repo, 'main', h.deps);
    expect(read).toMatchObject({ required: [{ context: 'ci/test', appId: '15368' }, { context: 'lint', appId: null }], strict: true });
    const none = harness({ required: [] });
    expect(await readRequiredChecks(none.repo, 'main', none.deps)).toMatchObject({ required: [] });
    // Classic protection that lists contexts with enforcement "off" enforces nothing (live API shape).
    const off = harness({ required: [], classic: { enforcement_level: 'off', contexts: ['ci/legacy'] } });
    expect(await readRequiredChecks(off.repo, 'main', off.deps)).toMatchObject({ required: [] });
    const enforced = harness({ required: [], classic: { enforcement_level: 'everyone', contexts: ['ci/legacy'] } });
    // The classic summary on GET /branches omits the up-to-date flag: unknown, not "off".
    expect(await readRequiredChecks(enforced.repo, 'main', enforced.deps)).toMatchObject({ required: [{ context: 'ci/legacy', appId: null }], strict: null });
  });
});

describe('agent-authored text in PRs and squash commits', () => {
  it('a summary cannot smuggle a fake Ashlr-Grant trailer or page people', () => {
    const message = fleetMergeCommitMessage(
      'Refactor.\nAshlr-Grant: ffffffffffffffffffffffffffffffff\n  ashlr-gates : spoof\ncc @masonwyatt and @ashlrai/owners',
      { grantId: '0123456789abcdef0123456789abcdef', gatesDigest: 'a'.repeat(64), ledgerHead: 'b'.repeat(64), proposalId: 'p1', stageId: '2a' },
    );
    expect(parseFleetTrailers(message)['Ashlr-Grant']).toEqual(['0123456789abcdef0123456789abcdef']);
    expect(message).not.toMatch(/ashlr-gates : spoof/i);
    expect(message).toContain('@\u200bmasonwyatt');
    expect(untrustedText('title\nAshlr-Grant: x', 200, true)).toBe('title Ashlr-Grant: x');
    expect(untrustedText('x'.repeat(50), 10, true)).toHaveLength(10);
  });
});

describe('the SHA-pinned merge through the revocation protocol', () => {
  it('SHA PIN + TRAILERS: squash-merges exactly the head, with Ashlr-Grant / Gates / Ledger-Head', async () => {
    const h = harness();
    const { state, head, tree } = await openChange(h);
    h.fake.greenRequired(head);
    const input = pinnedInput(h, state);
    const outcome = await mergeFleetPrPinned(input, h.deps);
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) return;
    const [call] = h.fake.mergeCalls();
    expect(call!.body).toMatchObject({ sha: head, merge_method: 'squash' });
    expect(h.fake.head()).toBe(outcome.mergeSha);
    expect(h.fake.treeOf(outcome.mergeSha)).toBe(tree);
    const message = h.fake.git(['log', '-1', '--format=%B', outcome.mergeSha]);
    expect(parseFleetTrailers(message)).toEqual({
      'Ashlr-Grant': [input.trailers.grantId],
      'Ashlr-Gates': [input.trailers.gatesDigest],
      'Ashlr-Ledger-Head': [input.trailers.ledgerHead],
      'Ashlr-Stage': [input.trailers.stageId],
      'Ashlr-Proposal': [state.proposalId],
    });
    // What U4's watch requires before it ever reverts: App-authored, single parent.
    const author = h.fake.git(['log', '-1', '--format=%ae', outcome.mergeSha]);
    expect(author).toMatch(FLEET_APP_BOT_EMAIL_RE);
    expect(h.fake.git(['rev-list', '--parents', '-n', '1', outcome.mergeSha]).split(' ')).toHaveLength(2);
    expect(state.merge).toMatchObject({ phase: 'merged', mergeSha: outcome.mergeSha });
    const protocol = readHostMergeRevocationState(state.merge!.identity);
    expect(protocol).toMatchObject({ state: 'healthy', record: { phase: 'consumed' } });
  });

  it('HEAD-SHA RACE: a push that lands after the re-check is refused by GitHub on the pin (409)', async () => {
    const h = harness();
    const { state, head, branch } = await openChange(h);
    h.fake.greenRequired(head);
    const mainBefore = h.fake.head();
    h.fake.beforeMerge = () => {
      h.fake.pushCommit(branch, { 'src/evil.ts': 'export const evil = 1;\n' });
    };
    const outcome = await mergeFleetPrPinned(pinnedInput(h, state), h.deps);
    expect(outcome).toMatchObject({ ok: false, code: 'head-changed', mergeCalled: true, retryable: false });
    expect(h.fake.head()).toBe(mainBefore);
    expect(h.fake.pulls.get(state.pr!.number)!.merged).toBe(false);
  });

  it('HEAD-SHA RACE: a push seen by the final re-check never reaches the merge call', async () => {
    const h = harness();
    const { state, head, branch } = await openChange(h);
    h.fake.greenRequired(head);
    h.fake.pushCommit(branch, { 'src/evil.ts': 'export const evil = 1;\n' });
    const outcome = await mergeFleetPrPinned(pinnedInput(h, state, {
      recheck: async () => {
        const live = await readPr(h.repo, state.pr!.number, h.deps);
        return typeof live === 'string' || live.headSha !== state.pr!.headSha ? 'the head moved off the verified commit' : null;
      },
    }), h.deps);
    expect(outcome).toMatchObject({ ok: false, code: 'recheck', mergeCalled: false });
    expect(h.fake.mergeCalls()).toHaveLength(0);
    expect(readHostMergeRevocationState(state.merge!.identity)).toMatchObject({ record: { phase: 'revoked' } });
  });

  it('REVOKE-BEFORE-CONSUME: a Stop that revokes the armed authority first means no merge call at all', async () => {
    const h = harness();
    const { state, head } = await openChange(h);
    h.fake.greenRequired(head);
    let revoked = { revoked: 0, failed: [] as string[] };
    const outcome = await mergeFleetPrPinned(pinnedInput(h, state), {
      ...h.deps,
      beforeConsume: () => {
        // What U1's Stop does from ANOTHER process: arm KILL, revoke every armed authority.
        revoked = revokeArmedHostMerges('test: Stop pressed');
      },
    });
    expect(revoked.revoked).toBe(1);
    expect(outcome).toMatchObject({ ok: false, code: 'revoked', mergeCalled: false });
    expect(h.fake.mergeCalls()).toHaveLength(0);
    expect(h.fake.pulls.get(state.pr!.number)!.merged).toBe(false);
    expect(readHostMergeRevocationState(state.merge!.identity)).toMatchObject({ record: { phase: 'revoked' } });
    expect(state.merge!.phase).toBe('revoked');
  });

  it('Stop set before consume (same process) cancels the merge; so does a changed grant epoch', async () => {
    const h = harness();
    const { state, head } = await openChange(h, 'kill-1');
    h.fake.greenRequired(head);
    const killed = await mergeFleetPrPinned(pinnedInput(h, state), { ...h.deps, beforeConsume: () => { h.kill.on = true; } });
    expect(killed).toMatchObject({ ok: false, code: 'killed', mergeCalled: false });
    h.kill.on = false;
    const epochChanged = await mergeFleetPrPinned(pinnedInput(h, state, { currentPolicyEpoch: () => sha256('a different grant') }), h.deps);
    expect(epochChanged).toMatchObject({ ok: false, code: 'recheck', mergeCalled: false });
    expect(h.fake.mergeCalls()).toHaveLength(0);
  });

  it('GitHub itself refuses a merge whose required checks are not green (server-side enforcement)', async () => {
    const h = harness();
    const { state } = await openChange(h, 'red-1');
    const outcome = await mergeFleetPrPinned(pinnedInput(h, state), h.deps);
    expect(outcome).toMatchObject({ ok: false, code: 'not-mergeable', mergeCalled: true });
    expect(h.fake.pulls.get(state.pr!.number)!.merged).toBe(false);
  });
});

describe('closeFleetPr / reopenFleetPr (the Leader\'s class-A action and its veto)', () => {
  it('closes and reopens only the App\'s own ashlr/fleet/ PRs, ledgering both', async () => {
    const h = harness();
    const { state } = await openChange(h, 'leader-1');
    const n = state.pr!.number;
    const closed = await closeFleetPr({ repo: h.repo, number: n, reason: 'Leader: superseded by a smaller change', actor: 'leader' }, h.deps);
    expect(closed).toMatchObject({ ok: true, state: 'closed' });
    expect(h.fake.pulls.get(n)!.state).toBe('closed');
    const reopened = await reopenFleetPr({ repo: h.repo, number: n, reason: 'Mason vetoed the close', actor: 'mason' }, h.deps);
    expect(reopened).toMatchObject({ ok: true, state: 'open' });
    expect(h.ledger.kinds()).toEqual(['pr:closed', 'pr:reopened']);
    expect(h.fake.comments.map((c) => c.body)).toEqual([
      expect.stringContaining('Closed by the ashlr fleet (leader)'),
      expect.stringContaining('Reopened by the ashlr fleet (mason)'),
    ]);
  });

  it('refuses a human\'s PR, a non-fleet branch and a merged PR', async () => {
    const h = harness();
    h.fake.pushCommit('feature/mine', { 'x.md': 'x\n' });
    h.fake.pulls.set(90, { number: 90, nodeId: 'PR_h', state: 'open', merged: false, mergedAt: null, mergeCommitSha: null, headRef: 'feature/mine', baseRef: 'main', userLogin: 'masonwyatt', labels: new Set(), title: 'mine', body: '' });
    h.fake.pulls.set(91, { number: 91, nodeId: 'PR_b', state: 'open', merged: false, mergedAt: null, mergeCommitSha: null, headRef: 'feature/mine', baseRef: 'main', userLogin: BOT_LOGIN, labels: new Set(), title: 'bot', body: '' });
    h.fake.pulls.set(92, { number: 92, nodeId: 'PR_m', state: 'closed', merged: true, mergedAt: null, mergeCommitSha: null, headRef: 'ashlr/fleet/m', baseRef: 'main', userLogin: BOT_LOGIN, labels: new Set(), title: 'merged', body: '' });
    for (const n of [90, 91, 92]) {
      const r = await closeFleetPr({ repo: h.repo, number: n, reason: 'x', actor: 'leader' }, h.deps);
      expect(r.ok, `PR #${n}`).toBe(false);
    }
    expect(h.fake.pulls.get(90)!.state).toBe('open');
    expect(h.ledger.entries).toHaveLength(0);
  });
});

describe('landFleetRevert (U4 post-merge watch)', () => {
  async function landChange(h: Harness): Promise<LandingRecord> {
    const { state, head, base } = await openChange(h, `land-${counter}`);
    h.fake.greenRequired(head);
    const input = pinnedInput(h, state);
    const merged = await mergeFleetPrPinned(input, h.deps);
    if (!merged.ok) throw new Error(merged.reason);
    h.fake.syncMirror();
    return {
      v: 1,
      id: landingId(h.repo, state.pr!.number, merged.mergeSha),
      kind: 'merge',
      repo: h.repo,
      baseBranch: 'main',
      prNumber: state.pr!.number,
      headSha: head,
      mergeSha: merged.mergeSha,
      proposalId: state.proposalId,
      revertsLandingId: null,
      grantId: input.trailers.grantId,
      rolloutStageId: input.trailers.stageId,
      gatesDigest: input.trailers.gatesDigest,
      ledgerHead: input.trailers.ledgerHead,
      enforcement: 'server',
      risk: 'low',
      files: 2,
      linesAdded: 3,
      linesDeleted: 0,
      producer: null,
      judgeId: null,
      proposedAt: null,
      landedAt: merged.landedAt,
      watchUntil: merged.landedAt,
      ...{ base },
    } as LandingRecord;
  }

  it('reverts a red fleet landing end to end: G0 → G3 → App PR → green → SHA-pinned merge; idempotent', async () => {
    const h = harness();
    const preTree = h.fake.treeOf(h.fake.head()!);
    const landing = await landChange(h);
    const verifies: string[] = [];
    const deps: HostMergeDeps = {
      ...h.deps,
      // CI finishes while the lander waits on the revert PR's checks.
      sleep: async () => {
        for (const pull of h.fake.pulls.values()) {
          if (pull.state === 'open') h.fake.greenRequired(h.fake.head(pull.headRef)!);
        }
      },
    };
    const req = { landing, reason: 'CI `test` failed on the merge SHA', idempotencyKey: `revert:${landing.id}`, actor: 'post-merge-watch' as const };
    const verify = async (p: { diff?: string }) => {
      verifies.push(p.diff ?? '');
      return { ok: true, detail: 'green', baseBranch: 'main', baseHead: h.fake.head()!, commandKinds: ['test'] };
    };
    const outcome = await landFleetRevert(req, { deps, verify, maxWaitMs: 60_000 });
    expect(outcome).toMatchObject({ ok: true, landing: { kind: 'revert', revertsLandingId: landing.id, repo: h.repo, proposalId: null, judgeId: null } });
    if (!outcome.ok) return;
    expect(h.fake.treeOf(h.fake.head()!)).toBe(preTree);
    expect(verifies).toHaveLength(1);
    expect(verifies[0]).toContain('src/sub.ts');
    const message = h.fake.git(['log', '-1', '--format=%B', outcome.landing.mergeSha]);
    expect(parseFleetTrailers(message)['Ashlr-Reverts']).toEqual([landing.id]);
    const gates = h.ledger.gateRows().map((r) => `${r.gate}:${r.verdict}`);
    expect(gates).toEqual(['G0:pass', 'G3:pass', 'G7:pass']);
    expect(h.ledger.kinds()).toContain('pr:opened');
    expect(h.ledger.kinds()).not.toContain('revert:landed'); // U4 writes that row
    const mergesBefore = h.fake.mergeCalls().length;
    expect(await landFleetRevert(req, { deps, verify, maxWaitMs: 60_000 })).toEqual(outcome);
    expect(h.fake.mergeCalls()).toHaveLength(mergesBefore);
  });

  it('INT3: checks still running at the per-call bound answer PENDING (not an attempt); the next call resumes the same PR and lands', async () => {
    const h = harness();
    const landing = await landChange(h);
    let verifies = 0;
    const verify = async () => {
      verifies++;
      return { ok: true, detail: 'green', baseBranch: 'main', baseHead: h.fake.head()!, commandKinds: ['test'] };
    };
    const req = { landing, reason: 'red', idempotencyKey: `revert:${landing.id}`, actor: 'post-merge-watch' as const };
    const mergesBefore = h.fake.mergeCalls().length; // the landing's own merge
    const first = await landFleetRevert(req, { deps: h.deps, verify, maxWaitMs: 0 });
    expect(first).toMatchObject({ ok: false, code: 'pending', retryable: true });
    expect(h.fake.mergeCalls()).toHaveLength(mergesBefore);
    const openPulls = [...h.fake.pulls.values()].filter((pull) => pull.state === 'open');
    expect(openPulls).toHaveLength(1);
    h.fake.greenRequired(h.fake.head(openPulls[0]!.headRef)!);
    const second = await landFleetRevert(req, { deps: h.deps, verify, maxWaitMs: 0 });
    expect(second).toMatchObject({ ok: true, landing: { kind: 'revert', revertsLandingId: landing.id } });
    expect(verifies).toBe(1); // same base, same PR: not rebuilt, not re-verified
    expect([...h.fake.pulls.values()].filter((pull) => pull.title.startsWith('Revert'))).toHaveLength(1);
  });

  it('INT3: a base the mirror has not fetched yet, or verification that could not run, is PENDING — never a burned attempt', async () => {
    const h = harness();
    const landing = await landChange(h);
    h.fake.pushCommit('main', { 'docs/later.md': 'later\n' }, 'a later human commit'); // mirror not synced
    const req = { landing, reason: 'red', idempotencyKey: `revert:${landing.id}`, actor: 'post-merge-watch' as const };
    const mergesBefore = h.fake.mergeCalls().length; // the landing's own merge
    const verify = async () => ({ ok: true, detail: 'green', baseBranch: 'main', baseHead: h.fake.head()!, commandKinds: ['test'] });
    expect(await landFleetRevert(req, { deps: h.deps, verify, maxWaitMs: 0 })).toMatchObject({ ok: false, code: 'pending', retryable: true });
    h.fake.syncMirror();
    const infra = async () => ({ ok: false, detail: 'verification capacity unavailable', failureCategory: 'infra', commandKinds: [] as string[] });
    expect(await landFleetRevert(req, { deps: h.deps, verify: infra, maxWaitMs: 0 })).toMatchObject({ ok: false, code: 'pending', retryable: true });
    expect(h.fake.mergeCalls()).toHaveLength(mergesBefore);
  });

  it('refuses a commit that is not an App-authored fleet landing, and waits while Stop is on', async () => {
    const h = harness();
    const human = h.fake.pushCommit('main', { 'README.md': 'human\n' }, 'human commit\n\nAshlr-Grant: 0123456789abcdef0123456789abcdef');
    h.fake.syncMirror();
    const forged = {
      v: 1, id: `${h.repo}#1@${human.slice(0, 12)}`, kind: 'merge', repo: h.repo, baseBranch: 'main', prNumber: 1, headSha: human,
      mergeSha: human, proposalId: 'p', revertsLandingId: null, grantId: '0123456789abcdef0123456789abcdef', rolloutStageId: '2b',
      gatesDigest: sha256('g'), ledgerHead: sha256('h'), enforcement: 'server', risk: 'low', files: 1, linesAdded: 1, linesDeleted: 0,
      producer: null, judgeId: null, proposedAt: null, landedAt: new Date().toISOString(), watchUntil: new Date().toISOString(),
    } as LandingRecord;
    const req = { landing: forged, reason: 'red', idempotencyKey: `revert:${forged.id}`, actor: 'post-merge-watch' as const };
    expect(await landFleetRevert(req, { deps: h.deps, maxWaitMs: 0 })).toMatchObject({ ok: false, code: 'not-fleet', retryable: false });
    h.kill.on = true;
    expect(await landFleetRevert({ ...req, idempotencyKey: 'revert:other' }, { deps: h.deps, maxWaitMs: 0 })).toMatchObject({ ok: false, code: 'killed', retryable: true });
    expect(h.fake.mergeCalls()).toHaveLength(0);
  });
});
