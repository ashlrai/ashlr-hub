/**
 * V3.10 Track B unit U3 — the standing-grant merge gates G0–G7 as pure
 * functions (fleet/merge-gates.ts). Real HMAC judge attestations are signed
 * with the provenance key in the isolated test HOME (test/setup/home.ts).
 *
 * Key SPEC-310B §7 U3 tests covered here: gate order, owner lane, tamper,
 * no checks → owner lane, family refusal, no downgrade, local-author cap.
 * (Head-SHA race, SHA pin, trailers and revoke-before-consume need the fake
 * GitHub: test/host-merge-310b.test.ts.)
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { loadOrCreateKey, hashDiff, signJudgeAttestation } from '../src/core/foundry/provenance.js';
import { GATE_ORDER, type GateResult, type RepoHold } from '../src/core/fleet/fleet-types.js';
import {
  JUDGE_PREFERENCE_WAIT_MS,
  allowedJudgeLanes,
  buildGateResult,
  combinedGatesDigest,
  dailyMergeCap,
  effectiveScopeCaps,
  evaluateG0,
  evaluateG1,
  evaluateG1b,
  evaluateG2,
  evaluateG3,
  evaluateG4,
  evaluateG5,
  evaluateG6,
  evaluateG7Checks,
  g7MergeEvaluation,
  gateRowDigest,
  mergeWithheldBecause,
  openGatesDigest,
  recordGateRow,
  type G2Input,
  type GateEvaluation,
} from '../src/core/fleet/merge-gates.js';
import type { DecisionEntry, Proposal } from '../src/core/types.js';
import { repoPolicy, standingPolicy } from './helpers/fleet-github-310b.js';

const REPO = 'ashlrai/fleet-canary';
const NOW = Date.parse('2026-09-24T12:00:00.000Z');

beforeAll(() => {
  loadOrCreateKey();
});

function g0(overrides: Partial<Parameters<typeof evaluateG0>[0]> = {}): GateEvaluation {
  return evaluateG0({
    purpose: 'change',
    policy: standingPolicy([repoPolicy(REPO)]),
    repo: REPO,
    killOn: false,
    holds: [],
    mergeTimes24h: [],
    judgeLanes: ['grok-cli'],
    nowMs: NOW,
    ...overrides,
  });
}

function hold(kind: RepoHold['kind'], until: string | null): RepoHold {
  return { v: 1, repo: REPO, kind, reason: `${kind} test`, since: '2026-09-24T10:00:00.000Z', until, setBy: 'post-merge-watch', landingId: null };
}

describe('G0 — authority', () => {
  it('passes when the grant, stage, switch, holds, cap and judge seat all allow a merge', () => {
    expect(g0()).toMatchObject({ verdict: 'pass', code: 'authorized-merge' });
  });

  it('Stop waits, no grant waits, a repo outside the stage waits', () => {
    expect(g0({ killOn: true })).toMatchObject({ verdict: 'wait', code: 'kill-on' });
    expect(g0({ policy: null })).toMatchObject({ verdict: 'wait', code: 'no-standing-authority' });
    expect(g0({ repo: 'ashlrai/other' })).toMatchObject({ verdict: 'wait', code: 'repo-not-in-stage' });
    expect(g0({ repo: 'AshlrAI/Fleet-Canary' }).verdict).toBe('pass');
  });

  it('holds wait until they lift; an unreadable hold store waits (fail closed); an expired hold is ignored', () => {
    expect(g0({ holds: null })).toMatchObject({ verdict: 'wait', code: 'holds-unreadable' });
    const q = g0({ holds: [hold('quarantine', '2026-09-24T16:00:00.000Z')] });
    expect(q).toMatchObject({ verdict: 'wait', code: 'hold-quarantine', nextEligibleAt: '2026-09-24T16:00:00.000Z' });
    expect(g0({ holds: [hold('owner-hold', null)] })).toMatchObject({ verdict: 'wait', code: 'hold-owner-hold', nextEligibleAt: null });
    expect(g0({ holds: [hold('cooldown', '2026-09-24T11:00:00.000Z')] }).verdict).toBe('pass');
  });

  it('the rolling 24 h daily cap waits until the oldest merge ages out', () => {
    const times = Array.from({ length: 6 }, (_, i) => new Date(NOW - (6 - i) * 60 * 60 * 1000).toISOString());
    const capped = g0({ mergeTimes24h: times });
    expect(capped).toMatchObject({ verdict: 'wait', code: 'daily-cap' });
    expect(capped.nextEligibleAt).toBe(new Date(Date.parse(times[0]!) + 24 * 60 * 60 * 1000).toISOString());
    expect(g0({ mergeTimes24h: times.slice(1) }).verdict).toBe('pass');
    expect(g0({ mergeTimes24h: null })).toMatchObject({ verdict: 'wait', code: 'daily-cap-unknown' });
  });

  it('no judge seat waits, with the router\'s reopening time', () => {
    expect(g0({ judgeLanes: [], judgeNextEligibleAt: '2026-09-25T00:00:00.000Z' }))
      .toMatchObject({ verdict: 'wait', code: 'no-judge-seat', nextEligibleAt: '2026-09-25T00:00:00.000Z' });
    expect(g0({ judgeLanes: null }).verdict).toBe('pass');
  });

  it('propose switch / propose stage / a zero cap pass G0 but withhold the merge', () => {
    const proposeSwitch = standingPolicy([repoPolicy(REPO)], { switch: 'propose' });
    expect(g0({ policy: proposeSwitch })).toMatchObject({ verdict: 'pass', code: 'authorized-propose' });
    expect(mergeWithheldBecause(proposeSwitch, repoPolicy(REPO))).toBe('switch-propose');
    const proposeStage = standingPolicy([repoPolicy(REPO, { stage: 'propose' })]);
    expect(mergeWithheldBecause(proposeStage, proposeStage.repos[0]!)).toBe('stage-propose');
    const shadow = standingPolicy([repoPolicy(REPO, { maxMergesPerDay: 0 })]);
    expect(mergeWithheldBecause(shadow, shadow.repos[0]!)).toBe('shadow');
    // A PR-only repo never needs a merge-count read.
    expect(g0({ policy: proposeStage, mergeTimes24h: null }).verdict).toBe('pass');
  });

  it('a revert passes through holds and the cap, never through Stop or a missing grant', () => {
    const revert = { purpose: 'revert' as const, judgeLanes: null };
    expect(g0({ ...revert, holds: [hold('quarantine', null)], mergeTimes24h: null })).toMatchObject({ verdict: 'pass', code: 'authorized-revert' });
    expect(g0({ ...revert, repo: 'ashlrai/left-the-stage' }).verdict).toBe('pass');
    expect(g0({ ...revert, killOn: true }).code).toBe('kill-on');
    expect(g0({ ...revert, policy: null }).code).toBe('no-standing-authority');
  });

  it('caps: local enforcement ≤ 4 merges a day, the compiled ceiling ≤ 24', () => {
    expect(dailyMergeCap(repoPolicy(REPO, { maxMergesPerDay: 100 }))).toBe(24);
    expect(dailyMergeCap(repoPolicy(REPO, { maxMergesPerDay: 6, enforcement: 'local' }))).toBe(4);
  });
});

describe('G1 / G1b', () => {
  it('protected paths go to the owner lane; an unparseable diff is refused', () => {
    expect(evaluateG1({ paths: ['src/a.ts', 'package.json'], selfRepo: false })).toMatchObject({ verdict: 'owner-lane', code: 'protected-manifest' });
    expect(evaluateG1({ paths: ['src/core/inbox/merge.ts'], selfRepo: true })).toMatchObject({ verdict: 'owner-lane', code: 'protected-tier1-authority-code' });
    expect(evaluateG1({ paths: ['src/core/inbox/merge.ts'], selfRepo: false }).verdict).toBe('pass');
    expect(evaluateG1({ paths: null, selfRepo: false })).toMatchObject({ verdict: 'refuse', code: 'diff-unparseable' });
  });

  it('tampering refuses (it is high risk, never mergeable)', () => {
    const diff = "diff --git a/test/a.test.ts b/test/a.test.ts\n--- a/test/a.test.ts\n+++ b/test/a.test.ts\n@@ -1,2 +1,1 @@\n-  expect(x).toBe(1);\n y\n";
    expect(evaluateG1b(diff)).toMatchObject({ verdict: 'refuse', code: 'test-tamper' });
    expect(evaluateG1b('garbage')).toMatchObject({ verdict: 'refuse', code: 'tamper-unreadable' });
  });
});

function g2(overrides: Partial<G2Input> = {}) {
  const policy = standingPolicy([repoPolicy(REPO)]);
  return evaluateG2({
    partial: false,
    provenance: { ok: true },
    risk: 'medium',
    scope: { files: 3, changedLines: 90 },
    repoPolicy: policy.repos[0]!,
    mergePolicy: policy.merge,
    config: {},
    producerLocal: false,
    ...overrides,
  });
}

describe('G2 — risk and scope: min(grant, config, ceilings)', () => {
  it('a frontier-authored medium change within the caps passes', () => {
    expect(g2()).toMatchObject({ verdict: 'pass', code: 'within-caps', caps: { maxRisk: 'medium', maxFiles: 10, maxLines: 300 } });
  });

  it('LOCAL-AUTHOR CAP: local work merges only at low risk, 4 files / 150 lines', () => {
    expect(g2({ producerLocal: true })).toMatchObject({ verdict: 'refuse', code: 'local-author-cap' });
    expect(g2({ producerLocal: true, risk: 'low', scope: { files: 5, changedLines: 40 } })).toMatchObject({ verdict: 'refuse', code: 'local-author-cap' });
    expect(g2({ producerLocal: true, risk: 'low', scope: { files: 2, changedLines: 151 } })).toMatchObject({ verdict: 'refuse', code: 'local-author-cap' });
    expect(g2({ producerLocal: true, risk: 'low', scope: { files: 4, changedLines: 150 } })).toMatchObject({ verdict: 'pass', caps: { maxRisk: 'low', maxFiles: 4, maxLines: 150 } });
  });

  it('the code names the BINDING cap: a grant cap can rise with the rollout, a compiled local ceiling never does', () => {
    const tight = standingPolicy([repoPolicy(REPO, { maxFiles: 2 })]);
    // 3 files: the grant's 2-file stage cap binds (a later stage may allow it) …
    expect(g2({ producerLocal: true, risk: 'low', scope: { files: 3, changedLines: 20 }, repoPolicy: tight.repos[0]! }).code).toBe('files-over-cap');
    // … 5 files: the local-author ceiling of 4 binds, whatever the grant says.
    expect(g2({ producerLocal: true, risk: 'low', scope: { files: 5, changedLines: 20 } }).code).toBe('local-author-cap');
    // Medium risk from a local model: permanent; from a frontier model under a low-risk stage: growable.
    expect(g2({ producerLocal: true }).code).toBe('local-author-cap');
    const lowStage = standingPolicy([repoPolicy(REPO, { maxRisk: 'low' })]);
    expect(g2({ repoPolicy: lowStage.repos[0]! }).code).toBe('risk-over-cap');
  });

  it('local enforcement repos get the same low / 4 / 150 ceiling', () => {
    const local = standingPolicy([repoPolicy(REPO, { enforcement: 'local' })]);
    expect(g2({ repoPolicy: local.repos[0]! })).toMatchObject({ verdict: 'refuse', code: 'local-enforcement-cap' });
  });

  it('high risk, partial captures and unauthenticated producers are refused outright', () => {
    expect(g2({ risk: 'high' })).toMatchObject({ verdict: 'refuse', code: 'risk-high' });
    expect(g2({ partial: true })).toMatchObject({ verdict: 'refuse', code: 'partial-capture' });
    expect(g2({ provenance: { ok: false, reason: 'provenance signature mismatch' } })).toMatchObject({ verdict: 'refuse', code: 'provenance-invalid' });
    expect(g2({ scope: null })).toMatchObject({ verdict: 'refuse', code: 'diff-unmeasurable' });
  });

  it('config only tightens; it can never loosen past the grant or the compiled ceilings', () => {
    expect(g2({ config: { maxFiles: 2 } })).toMatchObject({ verdict: 'refuse', code: 'files-over-cap' });
    expect(g2({ config: { maxRisk: 'low' } })).toMatchObject({ verdict: 'refuse', code: 'risk-over-cap' });
    const loose = effectiveScopeCaps({
      repoPolicy: repoPolicy(REPO, { maxFiles: 50, maxLines: 9_000 }),
      mergePolicy: standingPolicy([]).merge,
      config: { maxFiles: 40, maxLines: 3_000, maxRisk: 'high' },
      producerLocal: false,
    });
    expect(loose).toEqual({ maxRisk: 'medium', maxFiles: 10, maxLines: 300 });
    expect(g2({ scope: { files: 11, changedLines: 10 } })).toMatchObject({ verdict: 'refuse', code: 'files-over-cap' });
    expect(g2({ scope: { files: 1, changedLines: 301 } })).toMatchObject({ verdict: 'refuse', code: 'lines-over-cap' });
  });
});

describe('G3 / G4 / G5', () => {
  const verified = { ok: true, detail: 'ok', baseBranch: 'main', baseHead: 'a'.repeat(40), commandKinds: ['typecheck', 'test'] };
  const tree = { ok: true as const, treeSha: 'b'.repeat(40) };

  it('passes on green verification with the exact tree bound into the row', () => {
    const e = evaluateG3({ verify: verified, parity: null, tree, diffHash: 'c'.repeat(64) });
    expect(e).toMatchObject({ verdict: 'pass', code: 'verified' });
    expect(e.inputs).toMatchObject({ treeSha: 'b'.repeat(40), baseHead: 'a'.repeat(40) });
  });

  it('never passes unverified work: no commands ⇒ refuse (allowWithoutVerification cannot loosen a grant)', () => {
    expect(evaluateG3({ verify: { ...verified, commandKinds: [] }, parity: null, tree, diffHash: 'c'.repeat(64) }))
      .toMatchObject({ verdict: 'refuse', code: 'no-verification-commands' });
  });

  it('a code failure refuses, an infrastructure failure waits, parity and conflicts refuse', () => {
    expect(evaluateG3({ verify: { ...verified, ok: false, failureCategory: 'code' }, parity: null, tree, diffHash: 'x' }).code).toBe('verify-failed');
    expect(evaluateG3({ verify: { ...verified, ok: false, failureCategory: 'timeout' }, parity: null, tree, diffHash: 'x' }))
      .toMatchObject({ verdict: 'wait', code: 'verify-infra' });
    expect(evaluateG3({ verify: verified, parity: { ok: false, reason: 'flag ON red' }, tree, diffHash: 'x' }).code).toBe('self-eval-parity');
    expect(evaluateG3({ verify: verified, parity: null, tree: { ok: false, reason: 'patch failed', conflict: true }, diffHash: 'x' }).code)
      .toBe('diff-does-not-apply');
    expect(evaluateG3({ verify: null, parity: null, tree: null, diffHash: 'x' }).verdict).toBe('wait');
  });

  it('the tree git built must match the paths G1 judged, and may add no symlink / submodule / hidden protected path', () => {
    const base = { verify: verified, parity: null, tree, diffHash: 'x' };
    const parsedPaths = ['src/a.ts'];
    expect(evaluateG3({ ...base, treeChanges: { changes: [{ path: 'src/a.ts', mode: '100644' }], parsedPaths, selfRepo: false } }).verdict).toBe('pass');
    expect(evaluateG3({ ...base, treeChanges: { changes: [{ path: 'src/a.ts', mode: '100644' }, { path: 'src/b.ts', mode: '100644' }], parsedPaths, selfRepo: false } }).code)
      .toBe('tree-paths-unexpected');
    expect(evaluateG3({ ...base, treeChanges: { changes: [{ path: 'src/a.ts', mode: '120000' }], parsedPaths, selfRepo: false } }).code).toBe('link-or-submodule');
    expect(evaluateG3({ ...base, treeChanges: { changes: [{ path: 'package.json', mode: '100644' }], parsedPaths: ['package.json'], selfRepo: false } }).code)
      .toBe('tree-protected-path');
    expect(evaluateG3({ ...base, treeChanges: { changes: 'diff-tree failed', parsedPaths, selfRepo: false } })).toMatchObject({ verdict: 'wait', code: 'tree-unavailable' });
  });

  it('G4 forced claim-vs-diff and G5 blast checks fail closed', () => {
    expect(evaluateG4({ integrity: 'unsupported-claim', claim: 'claims-change', classifier: 'heuristic' }).code).toBe('claim-mismatch');
    expect(evaluateG4({ integrity: null, claim: null, classifier: 'heuristic', error: 'boom' }).code).toBe('claim-check-failed');
    expect(evaluateG4({ integrity: 'consistent', claim: 'claims-change', classifier: 'heuristic' }).verdict).toBe('pass');
    expect(evaluateG5([{ name: 'blast-radius', outcome: 'blocked', detail: 'risk high' }]).code).toBe('blast-radius');
    expect(evaluateG5([{ name: 'red-team', outcome: 'error', detail: 'threw' }]).code).toBe('red-team-error');
    expect(evaluateG5([])).toMatchObject({ verdict: 'pass', code: 'no-blast-checks-enabled' });
  });
});

function proposal(engineModel: string, diff = 'diff --git a/src/a.ts b/src/a.ts\n'): Proposal {
  return { id: `p-g6-${engineModel.replace(/[^a-z0-9]/gi, '')}`, engineModel, diff } as Proposal;
}

function judged(p: Proposal, judge: string, opts: { verdict?: string; at?: number; attestFor?: string; detail?: string } = {}): DecisionEntry {
  const ts = new Date(opts.at ?? NOW - 60_000).toISOString();
  const verdict = opts.verdict ?? 'ship';
  return {
    ts,
    proposalId: p.id,
    action: 'judged',
    engine: judge,
    model: judge,
    verdict,
    detail: opts.detail ?? (verdict === 'ship' ? 'would-merge' : ''),
    judgeAttestation: signJudgeAttestation({
      proposalId: p.id,
      judgeEngine: judge,
      verdict: 'ship',
      diffHash: hashDiff(opts.attestFor ?? p.diff ?? ''),
      issuedAt: ts,
      mergeIntent: 'would-merge',
    }),
    judgeAttestationIssuedAt: ts,
    judgeAttestationIntent: 'would-merge',
  } as DecisionEntry;
}

function g6(p: Proposal, decisions: DecisionEntry[] | null) {
  return evaluateG6({ proposalId: p.id, producerModel: p.engineModel, diff: p.diff ?? '', decisions, nowMs: NOW });
}

describe('G6 — judge (family refusal, no downgrade)', () => {
  it('local work shipped by the grok-cli seat, HMAC-attested, passes', () => {
    const p = proposal('local-coder:qwen3.8-coder');
    expect(g6(p, [judged(p, 'grok-cli:grok-4.7')])).toMatchObject({ verdict: 'pass', code: 'judge-ship', judgeId: 'grok-cli:grok-4.7' });
  });

  it('Grok work shipped by Claude passes; FAMILY REFUSAL: Grok judging Grok never passes', () => {
    const grokWork = proposal('grok-cli:grok-4.7-build-fast');
    expect(g6(grokWork, [judged(grokWork, 'claude-opus-4-8')]).verdict).toBe('pass');
    const sameFamily = g6(grokWork, [judged(grokWork, 'grok-cli:grok-4.7')]);
    expect(sameFamily).toMatchObject({ verdict: 'wait', code: 'judge-ineligible', needsJudge: true });
    expect(sameFamily.reason).toMatch(/both xai family/);
  });

  it('NO DOWNGRADE: a local judge, a bare Grok id or the per-token API engine never attests', () => {
    const p = proposal('local-coder:qwen3.8-coder');
    for (const judge of ['qwen2.5:72b-instruct-q4_K_M', 'local', 'grok-4.7', 'grok:grok-4.7', 'xai:grok-4.7', 'local-coder:claude-distill']) {
      expect(g6(p, [judged(p, judge)]), judge).toMatchObject({ verdict: 'wait', code: 'judge-ineligible' });
    }
  });

  it('an attestation for another diff, a stale verdict or a missing merge intent never passes', () => {
    const p = proposal('local-coder:qwen3.8-coder');
    expect(g6(p, [judged(p, 'grok-cli:grok-4.7', { attestFor: 'a different diff' })]).code).toBe('judge-attestation-invalid');
    expect(g6(p, [judged(p, 'grok-cli:grok-4.7', { at: NOW - 25 * 60 * 60 * 1000 })]).code).toBe('judge-stale');
    expect(g6(p, [judged(p, 'grok-cli:grok-4.7', { detail: '' })])).toMatchObject({ verdict: 'refuse', code: 'judge-no-merge-intent' });
  });

  it('a newer non-ship from an eligible judge refuses; a judge failure waits; nothing yet waits', () => {
    const p = proposal('local-coder:qwen3.8-coder');
    const older = judged(p, 'grok-cli:grok-4.7', { at: NOW - 120_000 });
    const newer = judged(p, 'grok-cli:grok-4.7', { at: NOW - 60_000, verdict: 'review' });
    expect(g6(p, [older, newer])).toMatchObject({ verdict: 'refuse', code: 'judge-rejected' });
    const failed = judged(p, 'grok-cli:grok-4.7', { verdict: 'review', detail: 'judge-network-failure' });
    expect(g6(p, [failed])).toMatchObject({ verdict: 'wait', code: 'judge-failed', needsJudge: true });
    expect(g6(p, [])).toMatchObject({ verdict: 'wait', code: 'awaiting-judge', needsJudge: true });
    expect(g6(p, null)).toMatchObject({ verdict: 'wait', code: 'decisions-degraded', needsJudge: false });
  });

  it('lanes: the preferred lane only, every qualifying lane after 24 h — never local, never the producer\'s family', () => {
    expect(allowedJudgeLanes('local', null, NOW)).toEqual(['grok-cli']);
    expect(allowedJudgeLanes('local', NOW - JUDGE_PREFERENCE_WAIT_MS + 1, NOW)).toEqual(['grok-cli']);
    expect(allowedJudgeLanes('local', NOW - JUDGE_PREFERENCE_WAIT_MS, NOW)).toEqual(['grok-cli', 'claude-cli', 'codex']);
    expect(allowedJudgeLanes('xai', null, NOW)).toEqual(['claude-cli']);
    expect(allowedJudgeLanes('xai', 0, NOW)).toEqual(['claude-cli', 'codex']);
    expect(allowedJudgeLanes('unknown', 0, NOW)).toEqual([]);
    for (const family of ['local', 'xai', 'claude', 'openai'] as const) {
      expect(allowedJudgeLanes(family, 0, NOW)).not.toContain('local');
    }
    expect(allowedJudgeLanes('xai', 0, NOW)).not.toContain('grok-cli');
  });
});

describe('G7 — required checks (no checks → owner lane)', () => {
  const required = [{ context: 'ci/test', appId: '15368' }];
  const run = (name: string, conclusion: string | null, status = 'completed', appId: string | null = '15368', id = 1) => ({ id, name, appId, status, conclusion });
  const base = { enforcement: 'server' as const, statuses: [], pendingSinceMs: NOW - 60_000, nowMs: NOW };

  it('NO CHECKS → OWNER LANE: a server repo with no required checks can never be proven green', () => {
    expect(evaluateG7Checks({ ...base, required: [], runs: [] })).toMatchObject({ verdict: 'owner-lane', code: 'no-required-checks', state: 'none' });
  });

  it('green, pending, red and timed-out required checks', () => {
    expect(evaluateG7Checks({ ...base, required, runs: [run('ci/test', 'success')] })).toMatchObject({ verdict: 'pass', code: 'checks-green' });
    expect(evaluateG7Checks({ ...base, required, runs: [] })).toMatchObject({ verdict: 'wait', code: 'checks-pending' });
    expect(evaluateG7Checks({ ...base, required, runs: [run('ci/test', null, 'in_progress')] }).verdict).toBe('wait');
    expect(evaluateG7Checks({ ...base, required, runs: [run('ci/test', 'failure')] })).toMatchObject({ verdict: 'refuse', code: 'required-check-failed' });
    expect(evaluateG7Checks({ ...base, required, runs: [run('ci/test', 'cancelled')] }).verdict).toBe('wait');
    expect(evaluateG7Checks({ ...base, required, runs: [], pendingSinceMs: NOW - 25 * 60 * 60 * 1000 }))
      .toMatchObject({ verdict: 'refuse', code: 'checks-timeout' });
  });

  it('a check from the wrong App does not satisfy a required context; the newest run wins', () => {
    expect(evaluateG7Checks({ ...base, required, runs: [run('ci/test', 'success', 'completed', '999')] }).verdict).toBe('wait');
    const rerun = [run('ci/test', 'failure', 'completed', '15368', 1), run('ci/test', 'success', 'completed', '15368', 2)];
    expect(evaluateG7Checks({ ...base, required, runs: rerun }).verdict).toBe('pass');
    expect(evaluateG7Checks({ ...base, required: [{ context: 'lint', appId: null }], runs: [], statuses: [{ context: 'lint', state: 'success' }] }).verdict).toBe('pass');
  });

  it('local enforcement needs the App\'s green ashlr/verify, every other check green, and no red one (3.13)', () => {
    const local = { ...base, enforcement: 'local' as const, required: [] };
    const verify = (conclusion: string | null, appId = '424242', id = 9) => run('ashlr/verify', conclusion, conclusion === null ? 'in_progress' : 'completed', appId, id);
    expect(evaluateG7Checks({ ...local, runs: [] })).toMatchObject({ verdict: 'owner-lane', code: 'no-checks' });
    // 3.13: a green deploy-only / CI check alone no longer proves anything on a local repo.
    expect(evaluateG7Checks({ ...local, runs: [run('build', 'success')] })).toMatchObject({ verdict: 'owner-lane', code: 'no-verify-check' });
    expect(evaluateG7Checks({ ...local, fleetAppId: '424242', runs: [run('build', 'success'), verify('success')] }).verdict).toBe('pass');
    expect(evaluateG7Checks({ ...local, fleetAppId: '424242', runs: [run('build', 'success'), verify('success'), run('lint', 'failure', 'completed', '1', 2)] }).verdict).toBe('refuse');
  });

  it('unreadable checks wait', () => {
    expect(evaluateG7Checks({ ...base, required: null, runs: [] })).toMatchObject({ verdict: 'wait', code: 'checks-unreadable' });
  });

  it('the merge-ready row states whether GitHub closes the base-move race (and says "unknown" when no source says)', () => {
    const green = evaluateG7Checks({ ...base, required, runs: [run('ci/test', 'success')] });
    expect(green.verdict).toBe('pass');
    const row = (strictUpToDate: boolean | null) => g7MergeEvaluation({
      headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), treeSha: 'c'.repeat(40), checks: green, protectionDigest: 'd'.repeat(64), strictUpToDate,
    });
    expect(row(true)).toMatchObject({ verdict: 'pass', code: 'merge-ready' });
    expect(row(true).reason).toContain('GitHub requires the head to be up to date with the base');
    expect(row(false).reason).toContain('GitHub does NOT require the head to be up to date with the base');
    expect(row(null).reason).toContain('up-to-date policy unknown');
    // The flag is part of the hashed inputs: the same merge under a looser policy is a different row.
    expect(row(true).inputs['strictUpToDate']).toBe(true);
    expect(row(false).inputs['strictUpToDate']).toBe(false);
  });
});

describe('rows, digests and dedup', () => {
  const e: GateEvaluation = { verdict: 'pass', code: 'ok', reason: 'fine', inputs: { a: 1 }, nextEligibleAt: null };

  it('the row digest binds gate, proposal, repo, head, verdict, code and inputs — not the wording or the time', () => {
    const base = { gate: 'G2' as const, proposalId: 'p1', repo: REPO, headSha: null, verdict: 'pass' as const, code: 'ok', inputs: { a: 1 } };
    const d = gateRowDigest(base);
    expect(gateRowDigest({ ...base, repo: REPO.toUpperCase() })).toBe(d);
    expect(buildGateResult({ gate: 'G2', proposalId: 'p1', repo: REPO, headSha: null, evaluation: { ...e, reason: 'other words' }, nowMs: NOW + 5_000 }).digest).toBe(d);
    for (const change of [{ verdict: 'wait' as const }, { code: 'x' }, { headSha: 'a'.repeat(40) }, { inputs: { a: 2 } }, { gate: 'G3' as const }, { proposalId: 'p2' }]) {
      expect(gateRowDigest({ ...base, ...change })).not.toBe(d);
    }
  });

  it('GATE ORDER: the trailer digest needs every gate, in order, all passed', () => {
    const rows: Pick<GateResult, 'gate' | 'digest' | 'verdict'>[] = GATE_ORDER.map((gate, i) => ({ gate, digest: String(i).repeat(64).slice(0, 64), verdict: 'pass' }));
    const digest = combinedGatesDigest(rows);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(combinedGatesDigest([...rows].reverse())).toBe(digest);
    expect(() => combinedGatesDigest(rows.filter((r) => r.gate !== 'G1b'))).toThrow(/G1b has no row/);
    expect(() => combinedGatesDigest(rows.map((r) => (r.gate === 'G6' ? { ...r, verdict: 'wait' } : r)))).toThrow(/G6 did not pass/);
    expect(openGatesDigest(rows)).not.toBe(digest);
  });

  it('an unchanged decision is ledgered once; a refused append is not remembered', () => {
    const state = { gates: {} };
    const appended: GateResult[] = [];
    const append = (row: GateResult) => {
      appended.push(row);
      return { ok: true as const };
    };
    const row = buildGateResult({ gate: 'G0', proposalId: 'p1', repo: REPO, headSha: null, evaluation: { ...e, verdict: 'wait', code: 'no-judge-seat' }, nowMs: NOW });
    expect(recordGateRow(state, row, 'g', append)).toEqual({ ok: true, written: true });
    for (let tick = 1; tick <= 50; tick++) {
      const again = buildGateResult({ gate: 'G0', proposalId: 'p1', repo: REPO, headSha: null, evaluation: { ...e, verdict: 'wait', code: 'no-judge-seat', reason: `tick ${tick}` }, nowMs: NOW + tick * 60_000 });
      expect(recordGateRow(state, again, 'g', append)).toEqual({ ok: true, written: false });
    }
    expect(appended).toHaveLength(1);
    const changed = buildGateResult({ gate: 'G0', proposalId: 'p1', repo: REPO, headSha: null, evaluation: e, nowMs: NOW });
    expect(recordGateRow(state, changed, 'g', () => ({ ok: false, reason: 'chain broken' }))).toEqual({ ok: false, reason: 'chain broken' });
    expect(recordGateRow(state, changed, 'g', append)).toEqual({ ok: true, written: true });
    expect(appended).toHaveLength(2);
  });
});
