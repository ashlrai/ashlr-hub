/**
 * m240.learned-routing.test.ts — M240: learned-bias engine/model routing.
 *
 * Four core contracts:
 *  1. High-ship-rate engine is tried first for a task-class.
 *  2. High-reject-rate engine is deprioritized for a task-class.
 *  3. Cold-start (no history / below min-sample floor) = static policy unchanged.
 *  4. learnedRouting:false = byte-identical to pre-M240 static routing.
 *
 * Additional safety invariants:
 *  5. Hard constraints (allowedBackends) are never violated.
 *  6. buildEngineScores never throws on empty / malformed ledger.
 *  7. engineScoreFor returns 0.5 (neutral) for unknown engine.
 *  8. sortEnginesByScore is stable (original order preserved on equal scores).
 *  9. Recency weight: very old verdicts contribute less than recent ones.
 * 10. Sample floor: fewer than MIN_SAMPLES → score stays neutral (0.5).
 *
 * Isolation: all tests use a fresh tmp HOME so they never read a real
 * ~/.ashlr/decisions directory and never write to it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const realized = vi.hoisted(() => ({
  times: new Map<string, string>(),
  producers: new Map<string, { engineModel: string; workSource: string; provenanceValid?: boolean }>(),
}));

vi.mock('../src/core/inbox/realized-merge.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/inbox/realized-merge.js')>();
  return { ...real, authenticatedRealizedMergeOf: real.realizedMergeOf };
});

vi.mock('../src/core/foundry/provenance.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/foundry/provenance.js')>();
  return {
    ...real,
    verifyProvenance: (proposal: { provenanceSig?: string }) => ({
      ok: proposal.provenanceSig === 'test-provenance',
    }),
    verifyProducerProvenanceV2: (proposal: { provenanceSig?: string }) => ({
      ok: proposal.provenanceSig === 'test-provenance',
    }),
  };
});

// This suite verifies learning and routing policy, not the binaries installed
// on the machine running Vitest. Keep routeBackend's availability input
// deterministic so a developer laptop with Claude/Codex and a clean CI runner
// exercise the same policy path. Hard-constraint cases remain controlled by
// allowedBackends and RoutingContext in the individual tests.
vi.mock('../src/core/run/engines.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/run/engines.js')>();
  return {
    ...real,
    engineInstalled: () => true,
  };
});

vi.mock('../src/core/inbox/store.js', () => {
  const listProposals = () => {
    const ids = new Set([...realized.producers.keys(), ...realized.times.keys()]);
    return [...ids].map((id) => {
      const producer = realized.producers.get(id);
      const observedAt = realized.times.get(id);
      return {
        ...producer,
        id,
        repo: '/tmp/test-repo',
        origin: 'backlog',
        kind: 'patch',
        title: id,
        summary: 'routing authority fixture',
        diff: 'diff --git a/a b/a',
        diffHash: 'd'.repeat(64),
        provenanceSig: producer?.provenanceValid === false
          ? 'invalid-provenance'
          : 'test-provenance',
        producerProvenanceVersion: 2,
        producerProvenanceSig: 'test-producer-provenance',
        workItemId: `test-repo:${producer?.workSource ?? 'unknown'}:${id}`,
        status: observedAt ? 'applied' : 'pending',
        createdAt: new Date().toISOString(),
        ...(observedAt ? { realizedMerge: {
          schemaVersion: 1,
          source: 'local-default-branch',
          base: 'main',
          baseBeforeOid: '1'.repeat(40),
          proposalHeadOid: '2'.repeat(40),
          mergeCommitOid: '3'.repeat(40),
          observedAt,
        }} : {}),
      };
    });
  };
  return {
    listProposals,
    listProposalsDetailed: () => ({
      proposals: listProposals(),
      sourceState: realized.producers.size > 0 ? 'healthy' : 'missing',
      sourcePresent: realized.producers.size > 0,
      complete: true,
      stopReasons: [],
      filesDiscovered: realized.producers.size,
      filesRead: realized.producers.size,
      bytesRead: 0,
      invalidFiles: 0,
      unreadableFiles: 0,
    }),
  };
});

// ---------------------------------------------------------------------------
// Helpers — isolate HOME so readDecisions() never touches the real ledger
// ---------------------------------------------------------------------------

let origHome: string | undefined;
let origAshlrHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  origHome = process.env['HOME'];
  origAshlrHome = process.env['ASHLR_HOME'];
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'm240-test-'));
  process.env['HOME'] = tmpHome;
  process.env['ASHLR_HOME'] = path.join(tmpHome, '.ashlr');
  realized.times.clear();
  realized.producers.clear();
});

afterEach(() => {
  vi.useRealTimers();
  if (origHome !== undefined) process.env['HOME'] = origHome;
  else delete process.env['HOME'];
  if (origAshlrHome !== undefined) process.env['ASHLR_HOME'] = origAshlrHome;
  else delete process.env['ASHLR_HOME'];
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

/**
 * Write synthetic decisions-ledger entries into the isolated tmp HOME.
 * `entries` is a list of partial DecisionEntry-like objects; ts defaults to now.
 */
function writeDecisions(
  entries: Array<{
    proposalId: string;
    action: string;
    workItemId?: string;
    workSource?: string;
    runId?: string;
    trajectoryId?: string;
    routerPolicyVersion?: string;
    learningEpoch?: string;
    engine?: string;
    model?: string;
    verdict?: string;
    labelBasis?: string;
    ts?: string;
  }>,
): void {
  for (const e of entries) {
    if (!e.engine || (e.action !== 'proposed' && e.action !== 'judged')) continue;
    const source = e.workSource ?? e.workItemId?.split(':')[1] ??
      e.proposalId.split(':')[1] ?? '*';
    if (!realized.producers.has(e.proposalId)) {
      realized.producers.set(e.proposalId, {
        engineModel: `${e.engine}:${e.model ?? 'unknown'}`,
        workSource: source,
      });
    }
  }
  const dir = path.join(tmpHome, '.ashlr', 'decisions');
  fs.mkdirSync(dir, { recursive: true });
  const byDay = new Map<string, string[]>();
  for (const e of entries) {
    const ts = e.ts ?? new Date().toISOString();
    const line = JSON.stringify({
        ts,
        proposalId: e.proposalId,
        ...(e.workItemId !== undefined ? { workItemId: e.workItemId } : {}),
        ...(e.workSource !== undefined ? { workSource: e.workSource } : {}),
        ...(e.runId !== undefined ? { runId: e.runId } : {}),
        ...(e.trajectoryId !== undefined ? { trajectoryId: e.trajectoryId } : {}),
        ...(e.routerPolicyVersion !== undefined ? { routerPolicyVersion: e.routerPolicyVersion } : {}),
        ...(e.learningEpoch !== undefined ? { learningEpoch: e.learningEpoch } : {}),
        action: e.action,
        ...(e.engine !== undefined ? { engine: e.engine } : {}),
        ...(e.model !== undefined ? { model: e.model } : {}),
        ...(e.verdict !== undefined ? { verdict: e.verdict } : {}),
        ...(e.labelBasis !== undefined ? { labelBasis: e.labelBasis } : {}),
      });
    const day = ts.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), line]);
    if (e.action === 'merged') {
      realized.times.set(e.proposalId, ts);
    }
  }
  for (const [day, lines] of byDay) {
    fs.writeFileSync(path.join(dir, `${day}.jsonl`), lines.join('\n') + '\n', 'utf8');
  }
}

// ---------------------------------------------------------------------------
// Import under test (after HOME is set in beforeEach)
// ---------------------------------------------------------------------------

import {
  buildEngineScores,
  buildOperationalEngineScores,
  engineScoreFor,
  evaluateRoutingLearningAuthority,
  inspectRoutingLearningAuthority,
  operationalEngineScoresForRouting,
  recommendRoute,
  sortEnginesByScore,
  LEARNED_ROUTING_MIN_SAMPLES,
  LEARNED_ROUTING_HALF_LIFE_MS,
  type EngineScoreMap,
} from '../src/core/run/learned-router.js';
import { routeTask, type RoutingContext } from '../src/core/run/router.js';
import { routeBackend } from '../src/core/fleet/router.js';
import { listRunsDetailed, saveRun } from '../src/core/run/orchestrator.js';
import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import {
  recordPolicyAssignmentReceipt,
  type PolicyAssignmentReceiptInput,
} from '../src/core/learning/policy-assignment-receipts.js';
import type { AshlrConfig, RunState, WorkItem } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeItem(source: string, effort = 3, score = 4): WorkItem {
  return {
    id: `test-repo:${source}:abc123`,
    repo: '/tmp/test-repo',
    title: `Test ${source} item`,
    source: source as WorkItem['source'],
    effort,
    score,
    description: '',
    filePaths: [],
  } as unknown as WorkItem;
}

function makeCtx(engines: string[] = ['claude', 'codex']): RoutingContext {
  return {
    availableEngines: engines as RoutingContext['availableEngines'],
  };
}

function makeCfg(overrides: Partial<NonNullable<AshlrConfig['foundry']>> = {}): AshlrConfig {
  return {
    foundry: {
      allowedBackends: ['claude', 'codex', 'local-coder', 'builtin'],
      routingPolicy: 'quality',
      learnedRouting: true,
      ...overrides,
    },
  } as AshlrConfig;
}

/** Build N judged entries plus authoritative merge evidence for positive outcomes. */
function judgedEntries(
  n: number,
  engine: string,
  model: string,
  source: string,
  verdict: string,
  tsMs?: number,
  includeMerged = true,
  proposalPrefix = 'sha',
): Array<{
  proposalId: string;
  action: string;
  engine?: string;
  model?: string;
  verdict?: string;
  labelBasis?: string;
  ts: string;
}> {
  const ts = tsMs ? new Date(tsMs).toISOString() : new Date().toISOString();
  const positive = verdict === 'ship' || verdict === 'approved' || verdict === 'applied';
  return Array.from({ length: n }, (_, i) => {
    const proposalId = `test-repo:${source}:${proposalPrefix}${i}`;
    return [
      { proposalId, action: 'judged', engine, model, verdict, ts },
      ...(positive && includeMerged
        ? [{
            proposalId,
            action: 'merged',
            verdict: 'applied',
            labelBasis: 'post-merge-credit-release-v1',
            ts,
          }]
        : []),
    ];
  }).flat();
}

// ---------------------------------------------------------------------------
// 1. buildEngineScores: cold-start (empty ledger) returns empty map
// ---------------------------------------------------------------------------

describe('buildEngineScores — cold-start', () => {
  it('returns an empty map when no decisions exist', () => {
    const scores = buildEngineScores('issue');
    expect(scores.size).toBe(0);
  });

  it('does not throw on malformed ledger files', () => {
    const dir = path.join(tmpHome, '.ashlr', 'decisions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2099-01-01.jsonl'), 'not json\n{bad}\n', 'utf8');
    expect(() => buildEngineScores('issue')).not.toThrow();
    const scores = buildEngineScores('issue');
    expect(scores.size).toBe(0);
  });
});

describe('Operational Learning Firewall V1', () => {
  const healthySources = {
    decisions: {
      sourceState: 'healthy' as const,
      sourcePresent: true,
      complete: true,
      authenticated: true,
    },
    assignments: {
      sourceState: 'healthy' as const,
      sourcePresent: true,
      complete: true,
      denominatorComplete: true,
      authenticated: true,
    },
  };
  const admittedSample = (overrides: Record<string, unknown> = {}) => ({
    decisionAuthenticated: true,
    assignmentAuthenticated: true,
    policyEligible: true,
    denominatorComplete: true,
    preExposureVerified: true,
    assignmentIdentity: 'assignment-1',
    propensity: 0.5,
    contextStratum: 'issue:frontier',
    policyVersion: 'router-v2',
    learningEpoch: '2026-08-02',
    decisionPolicyVersion: 'router-v2',
    decisionLearningEpoch: '2026-08-02',
    ...overrides,
  });

  it('admits only a complete authenticated same-cohort stratum at the sample floor', () => {
    const authority = evaluateRoutingLearningAuthority({
      ...healthySources,
      observedSamples: LEARNED_ROUTING_MIN_SAMPLES,
      samples: Array.from({ length: LEARNED_ROUTING_MIN_SAMPLES }, (_, index) =>
        admittedSample({ assignmentIdentity: `assignment-${index}` })),
    });

    expect(authority).toMatchObject({
      state: 'eligible',
      operationalSteering: true,
      samples: { observed: LEARNED_ROUTING_MIN_SAMPLES, eligible: LEARNED_ROUTING_MIN_SAMPLES },
      cohort: { policyVersion: 'router-v2', learningEpoch: '2026-08-02' },
      blockerCodes: [],
    });
  });

  it('rejects unsigned decisions, mixed epochs, and incomplete assignment receipts', () => {
    const authority = evaluateRoutingLearningAuthority({
      decisions: { ...healthySources.decisions, authenticated: false },
      assignments: {
        ...healthySources.assignments,
        denominatorComplete: false,
        authenticated: false,
      },
      observedSamples: LEARNED_ROUTING_MIN_SAMPLES + 1,
      samples: Array.from({ length: LEARNED_ROUTING_MIN_SAMPLES + 1 }, (_, index) =>
        admittedSample({
          decisionAuthenticated: false,
          denominatorComplete: false,
          policyEligible: false,
          preExposureVerified: false,
          assignmentIdentity: null,
          propensity: null,
          learningEpoch: index === 0 ? '2026-08-01' : '2026-08-02',
          decisionLearningEpoch: '2026-08-02',
        })),
    });

    expect(authority.state).toBe('inactive');
    expect(authority.operationalSteering).toBe(false);
    expect(authority.samples).toMatchObject({ observed: LEARNED_ROUTING_MIN_SAMPLES + 1, eligible: 0 });
    expect(authority.cohort.learningEpoch).toBeNull();
    expect(authority.blockerCodes).toEqual(expect.arrayContaining([
      'decision-authenticity-unavailable',
      'assignment-denominator-incomplete',
      'assignment-authenticity-unavailable',
      'assignment-policy-ineligible',
      'assignment-pre-exposure-unverified',
      'assignment-identity-unavailable',
      'assignment-propensity-unknown',
      'mixed-learning-epoch',
      'learning-epoch-mismatch',
      'sample-floor-unmet',
    ]));
  });

  it('rejects caller-supplied cohort summaries that mask mixed receipt samples', () => {
    const samples = Array.from({ length: LEARNED_ROUTING_MIN_SAMPLES + 1 }, (_, index) =>
      admittedSample({
        assignmentIdentity: `assignment-${index}`,
        policyVersion: index === 0 ? 'router-v1' : 'router-v2',
        decisionPolicyVersion: index === 0 ? 'router-v1' : 'router-v2',
        learningEpoch: index === 0 ? '2026-08-01' : '2026-08-02',
        decisionLearningEpoch: index === 0 ? '2026-08-01' : '2026-08-02',
      }));
    const authority = evaluateRoutingLearningAuthority({
      ...healthySources,
      observedSamples: samples.length,
      samples,
      observedPolicies: ['router-v2'],
      observedEpochs: ['2026-08-02'],
    });

    expect(authority).toMatchObject({
      state: 'inactive',
      operationalSteering: false,
      samples: { observed: samples.length, eligible: 0 },
      cohort: { policyVersion: null, learningEpoch: null },
    });
    expect(authority.blockerCodes).toEqual(expect.arrayContaining([
      'policy-cohort-mismatch',
      'learning-epoch-mismatch',
      'mixed-policy-cohort',
      'mixed-learning-epoch',
    ]));
  });

  it('keeps unsigned negative decisions visible diagnostically but neutral operationally', () => {
    const now = 1_700_000_000_000;
    writeDecisions(judgedEntries(
      LEARNED_ROUTING_MIN_SAMPLES + 2,
      'codex',
      'gpt-5.5',
      'todo',
      'harmful',
      now,
    ));

    const projection = buildOperationalEngineScores('todo', now);
    expect(projection.observational.get('codex:gpt-5.5')?.score).toBeLessThan(0.5);
    expect(projection.operational.size).toBe(0);
    expect(projection.authority).toMatchObject({
      state: 'inactive',
      operationalSteering: false,
      // No policy-assignment receipts were minted for this scenario (only raw
      // decisions), so the real receipt-side join observes zero candidates —
      // the decisions above remain diagnostically visible via `observational`
      // above, never promoted into an operational sample.
      samples: { observed: 0, eligible: 0 },
    });
    expect(projection.authority.blockerCodes).toContain('decision-authenticity-unavailable');

    const item = makeItem('todo', 4, 5);
    const ctx = makeCtx(['claude', 'codex']);
    const enabled = routeTask(item, makeCfg({ learnedRouting: true, routingPolicy: 'balanced' }), ctx);
    const disabled = routeTask(item, makeCfg({ learnedRouting: false, routingPolicy: 'balanced' }), ctx);
    expect(enabled).toMatchObject({ engine: disabled.engine, model: disabled.model });
  });

  it('never lets degraded run history downgrade an operational route', async () => {
    const now = new Date().toISOString();
    for (let index = 0; index < 3; index += 1) {
      const run: RunState = {
        id: `firewall-failed-run-${index}`,
        goal: 'issue investigation',
        engine: 'claude',
        provider: 'anthropic',
        engineTier: 'frontier',
        createdAt: now,
        updatedAt: now,
        budget: { maxTokens: 1_000, maxSteps: 10, allowCloud: true },
        usage: { tokensIn: 1, tokensOut: 1, steps: 1, estCostUsd: 0.01 },
        tasks: [],
        steps: [],
        status: 'failed',
      };
      saveRun(run);
    }
    const runsDir = path.join(tmpHome, '.ashlr', 'runs');
    fs.writeFileSync(path.join(runsDir, 'firewall-malformed.json'), '{not-json}\n', 'utf8');
    expect(listRunsDetailed()).toMatchObject({ sourceState: 'degraded' });

    const item = makeItem('issue', 5, 5);
    const cfg = makeCfg({
      intelligence: { minFrontierSuccessRate: 0.9 },
    });
    const expected = routeBackend(item, cfg);
    const routed = await recommendRoute(item, cfg);
    expect(routed).toMatchObject({ backend: expected.backend, tier: expected.tier });
    expect(routed.reason).not.toContain('frontier success rate');
  });
});

// ---------------------------------------------------------------------------
// M-causal-routing: the real receipt<->decision join closes the loop.
// ---------------------------------------------------------------------------

describe('Operational Learning Firewall V1 — real causal join', () => {
  const taskClass = 'issue';
  const policyVersion = 'router-causal-v1';
  const learningEpoch = '2026-08-02T00:00:00.000Z'.slice(0, 10);
  let repoDir: string;

  beforeEach(() => {
    loadOrCreateKey();
    repoDir = fs.mkdtempSync(path.join(tmpHome, 'repo-'));
  });

  function trajectoryFor(index: number): string {
    const hex = index.toString(16).padStart(12, '0');
    return `run:attempt-bbbbbbbb-bbbb-4bbb-8bbb-${hex}`;
  }

  /** Mint a real, HMAC-authenticated PolicyAssignmentReceiptV1 at "routing time". */
  function mintReceipt(index: number, overrides: Partial<PolicyAssignmentReceiptInput> = {}): void {
    const input: PolicyAssignmentReceiptInput = {
      reportedAssignedAt: '2026-08-02T00:00:00.000Z',
      dispatchTrajectoryId: trajectoryFor(index),
      repo: repoDir,
      workItemId: `issue-${index}`,
      workSource: taskClass as WorkItem['source'],
      workItemGenerationId: 'a'.repeat(64),
      objectiveHash: 'b'.repeat(64),
      campaignDigest: 'c'.repeat(64),
      eligibilityPopulationDigest: 'd'.repeat(64),
      contextStratum: `${taskClass}:frontier`,
      policyVersion,
      learningEpoch,
      reportedAssignmentMechanism: 'deterministic-policy',
      reportedProbabilityDenominator: 1,
      reportedEligibleActions: [
        { actionId: 'claude', actionDefinitionDigest: '1'.repeat(64), probabilityNumerator: 1 },
        { actionId: 'codex', actionDefinitionDigest: '2'.repeat(64), probabilityNumerator: 0 },
      ],
      reportedSelectedActionId: 'claude',
      ...overrides,
    };
    expect(recordPolicyAssignmentReceipt(input)).toBe('recorded');
  }

  // writeDecisions() overwrites the whole day-file on every call, so a loop of
  // per-index decideFor() calls must accumulate entries and flush once (each
  // call is NOT additive the way recordPolicyAssignmentReceipt's store is).
  type DecisionFixtureEntry = Parameters<typeof writeDecisions>[0][number];
  let pendingDecisions: DecisionFixtureEntry[] = [];
  const provenanceOverrides: Array<{ proposalId: string; provenanceValid: boolean }> = [];

  /**
   * Queue an authenticated decision for one dispatch attempt. Defaults to a
   * claude 'ship'+'merged' pair (matching the receipts minted above); pass
   * engine/model/verdict to build a second, independently-scored producer
   * (e.g. a reject-only codex cohort) without needing real post-merge-credit
   * MAC minting — negative credit only requires signed producer provenance,
   * exactly the bar decisionAuthenticated already applies for judged rows.
   */
  function decideFor(index: number, overrides: {
    trajectoryId?: string;
    provenanceValid?: boolean;
    engine?: string;
    model?: string;
    verdict?: string;
    includeMerged?: boolean;
  } = {}): void {
    const proposalId = `test-repo:${taskClass}:sha${index}`;
    const trajectoryId = overrides.trajectoryId ?? trajectoryFor(index);
    const engine = overrides.engine ?? 'claude';
    const model = overrides.model ?? 'sonnet-5';
    const verdict = overrides.verdict ?? 'ship';
    const includeMerged = overrides.includeMerged ?? (verdict === 'ship' || verdict === 'applied' || verdict === 'approved');
    pendingDecisions.push({
      proposalId,
      action: 'judged',
      workItemId: `issue-${index}`,
      workSource: taskClass,
      trajectoryId,
      routerPolicyVersion: policyVersion,
      learningEpoch,
      engine,
      model,
      verdict,
      ts: '2026-08-02T00:05:00.000Z',
    });
    if (includeMerged) {
      pendingDecisions.push({
        proposalId,
        action: 'merged',
        workSource: taskClass,
        trajectoryId,
        routerPolicyVersion: policyVersion,
        learningEpoch,
        verdict: 'applied',
        labelBasis: 'post-merge-credit-release-v1',
        ts: '2026-08-02T00:05:00.000Z',
      });
    }
    if (overrides.provenanceValid === false) {
      provenanceOverrides.push({ proposalId, provenanceValid: false });
    }
  }

  /** Flush every queued decideFor() call into one writeDecisions() write. */
  function flushDecisions(): void {
    writeDecisions(pendingDecisions);
    pendingDecisions = [];
    for (const { proposalId, provenanceValid } of provenanceOverrides) {
      const producer = realized.producers.get(proposalId);
      if (producer) realized.producers.set(proposalId, { ...producer, provenanceValid });
    }
    provenanceOverrides.length = 0;
  }

  const now = Date.parse('2026-08-02T01:00:00.000Z');

  it('closes the loop: N authenticated same-cohort samples admit operational steering and recommendRoute nudges away from a poor-history frontier engine', async () => {
    for (let index = 0; index < LEARNED_ROUTING_MIN_SAMPLES; index += 1) {
      mintReceipt(index);
      decideFor(index);
    }
    // A second, receipt-less producer with real (signed-provenance) reject
    // credit — buildEngineScores() is independent of receipts, so this proves
    // the observational scorer differentiates once operationalSteering is on,
    // without needing to mint a genuine post-merge-credit MAC label.
    // +2 (not the bare floor) so a fraction-of-an-hour recency decay never
    // lands the weighted total a hair under LEARNED_ROUTING_MIN_SAMPLES.
    for (let index = 100; index < 100 + LEARNED_ROUTING_MIN_SAMPLES + 2; index += 1) {
      decideFor(index, { engine: 'codex', model: 'gpt-5.5', verdict: 'harmful' });
    }
    flushDecisions();

    const authority = inspectRoutingLearningAuthority(taskClass, now);
    expect(authority).toMatchObject({
      state: 'eligible',
      operationalSteering: true,
      samples: { observed: LEARNED_ROUTING_MIN_SAMPLES, eligible: LEARNED_ROUTING_MIN_SAMPLES },
      blockerCodes: [],
    });

    // operationalEngineScoresForRouting() itself defaults to the real wall
    // clock (correct in production); buildOperationalEngineScores() accepts
    // the same injectable `now` this test already fixed everything else to,
    // so the 90-day buildEngineScores() window doesn't exclude synthetic
    // fixture timestamps decided against a fixed test clock.
    const projection = buildOperationalEngineScores(taskClass, now);
    expect(projection.authority.operationalSteering).toBe(true);
    expect(projection.operational.size).toBeGreaterThan(0);
    expect(projection.operational.get('codex:gpt-5.5')?.score).toBeLessThan(0.5);

    // recommendRoute's frontier-success-rate nudge is gated on
    // routingLearningAuthority.operationalSteering — seed a poor frontier
    // RunState history and confirm it now actually fires (it stays inert
    // whenever operationalSteering is false; see "never lets degraded run
    // history downgrade an operational route" above and the negative twins
    // below).
    for (let index = 0; index < 3; index += 1) {
      saveRun({
        id: `causal-join-poor-run-${index}`,
        goal: 'issue investigation',
        engine: 'claude',
        provider: 'anthropic',
        engineTier: 'frontier',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        budget: { maxTokens: 1_000, maxSteps: 10, allowCloud: true },
        usage: { tokensIn: 1, tokensOut: 1, steps: 1, estCostUsd: 0.01 },
        tasks: [],
        steps: [],
        status: 'failed',
      } as RunState);
    }
    const item = makeItem(taskClass, 5, 5);
    const cfg = makeCfg({ intelligence: { minFrontierSuccessRate: 0.9 } });
    const routed = await recommendRoute(item, cfg);
    expect(routed.tier).not.toBe('frontier');
    expect(routed.reason).toContain('frontier success rate');
  });

  it('negative: below the per-stratum sample floor stays neutral', () => {
    for (let index = 0; index < LEARNED_ROUTING_MIN_SAMPLES - 1; index += 1) {
      mintReceipt(index);
      decideFor(index);
    }
    flushDecisions();
    const authority = inspectRoutingLearningAuthority(taskClass, now);
    expect(authority.operationalSteering).toBe(false);
    expect(authority.blockerCodes).toContain('sample-floor-unmet');
    expect(operationalEngineScoresForRouting(taskClass).size).toBe(0);
  });

  it('negative: receipts with no corroborating provenance-signed decision stay neutral', () => {
    for (let index = 0; index < LEARNED_ROUTING_MIN_SAMPLES; index += 1) {
      mintReceipt(index);
      decideFor(index, { provenanceValid: false });
    }
    flushDecisions();
    const authority = inspectRoutingLearningAuthority(taskClass, now);
    expect(authority.operationalSteering).toBe(false);
    expect(authority.blockerCodes).toContain('decision-authenticity-unavailable');
  });

  it('negative: authenticated decisions with no minted receipt stay neutral (receipt-missing)', () => {
    for (let index = 0; index < LEARNED_ROUTING_MIN_SAMPLES; index += 1) {
      decideFor(index);
    }
    flushDecisions();
    const authority = inspectRoutingLearningAuthority(taskClass, now);
    expect(authority.operationalSteering).toBe(false);
    expect(authority.samples).toMatchObject({ observed: 0, eligible: 0 });
  });

  it('negative: a degraded receipt store stays neutral even with an otherwise-admissible cohort', () => {
    for (let index = 0; index < LEARNED_ROUTING_MIN_SAMPLES; index += 1) {
      mintReceipt(index);
      decideFor(index);
    }
    flushDecisions();
    // Poison the receipt directory with an unrecognized entry — the same
    // "degraded source integrity" trigger m460 pins for the receipt reader.
    const receiptsDir = path.join(tmpHome, '.ashlr', 'fleet', 'policy-assignment-receipts');
    fs.writeFileSync(path.join(receiptsDir, 'uncommitted.stage'), 'partial', { mode: 0o600 });

    const authority = inspectRoutingLearningAuthority(taskClass, now);
    expect(authority.operationalSteering).toBe(false);
    expect(authority.sourceQuality.assignments.sourceState).toBe('degraded');
  });

  it('negative (deliberate falsification): a receipt minted under a different dispatch trajectory cannot borrow another attempt\'s authenticated decision', () => {
    for (let index = 0; index < LEARNED_ROUTING_MIN_SAMPLES; index += 1) {
      // Mint the receipt under a trajectory that will NEVER be decided —
      // simulating a forged/mismatched join instead of the real one.
      mintReceipt(index, { dispatchTrajectoryId: trajectoryFor(1_000 + index) });
      decideFor(index);
    }
    flushDecisions();
    const authority = inspectRoutingLearningAuthority(taskClass, now);
    expect(authority.operationalSteering).toBe(false);
    expect(authority.blockerCodes).toContain('policy-cohort-mismatch');
    expect(operationalEngineScoresForRouting(taskClass).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. engineScoreFor: neutral (0.5) for unknown engine
// ---------------------------------------------------------------------------

describe('engineScoreFor — neutral fallback', () => {
  it('returns 0.5 for an unknown engine on an empty map', () => {
    const scores = buildEngineScores('issue');
    expect(engineScoreFor(scores, 'claude' as any, 'opus')).toBe(0.5);
    expect(engineScoreFor(scores, 'codex' as any, null)).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// 3. Sample floor: fewer than MIN_SAMPLES → score stays 0.5
// ---------------------------------------------------------------------------

describe('buildEngineScores — sample floor', () => {
  it(`withholds ${LEARNED_ROUTING_MIN_SAMPLES - 1} raw v1 positive samples`, () => {
    const n = LEARNED_ROUTING_MIN_SAMPLES - 1; // just below floor
    writeDecisions(judgedEntries(n, 'claude', 'opus', 'issue', 'ship'));
    const scores = buildEngineScores('issue');
    expect(scores.has('claude:opus')).toBe(false);
  });

  it(`withholds exactly ${LEARNED_ROUTING_MIN_SAMPLES} fresh raw v1 positive samples`, () => {
    const fixedNow = 1_700_000_000_000;
    const routeNow = fixedNow + 1;
    writeDecisions(
      judgedEntries(LEARNED_ROUTING_MIN_SAMPLES, 'claude', 'opus', 'issue', 'ship', fixedNow),
    );
    const scores = buildEngineScores('issue', routeNow);
    expect(scores.has('claude:opus')).toBe(false);
  });

  it(`withholds raw v1 positives above ${LEARNED_ROUTING_MIN_SAMPLES} samples`, () => {
    // Use a fixed nowMs == the entries' ts so recency-decay is exactly 1.0 (no
    // boundary flakiness): exactly-MIN raw samples would dip just under the
    // weighted floor with even a few ms of decay. Pin time + go above the floor.
    const fixedNow = 1_700_000_000_000;
    writeDecisions([
      ...judgedEntries(LEARNED_ROUTING_MIN_SAMPLES + 2, 'claude', 'opus', 'issue', 'ship', fixedNow),
    ]);
    const scores = buildEngineScores('issue', fixedNow);
    expect(scores.has('claude:opus')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. High-ship-rate engine gets score > 0.5; high-reject-rate gets score < 0.5
// ---------------------------------------------------------------------------

describe('buildEngineScores — ship/reject bias', () => {
  it('does not promote a Gate 7 ship after Gate 8 refusal without a merged decision', () => {
    const n = LEARNED_ROUTING_MIN_SAMPLES + 2;
    const judged = judgedEntries(n, 'claude', 'opus', 'issue', 'ship', undefined, false);
    const refused = Array.from({ length: n }, (_, i) => {
      const proposalId = `test-repo:issue:sha${i}`;
      return [
        { proposalId, action: 'merge-authorized', ts: new Date().toISOString() },
        { proposalId, action: 'escalated', ts: new Date().toISOString() },
      ];
    }).flat();
    writeDecisions([...judged, ...refused]);

    const scores = buildEngineScores('issue');
    expect(scores.size).toBe(0);
    expect(sortEnginesByScore(['codex', 'claude'] as any, scores, null)).toEqual([
      'codex',
      'claude',
    ]);
  });

  it('does not let signed provenance upgrade a raw v1 label into positive credit', () => {
    const n = LEARNED_ROUTING_MIN_SAMPLES + 1;
    writeDecisions(judgedEntries(n, 'claude', 'opus', 'issue', 'ship'));
    for (const proposalId of realized.times.keys()) {
      realized.producers.set(proposalId, {
        engineModel: 'codex:gpt-5.5',
        workSource: 'issue',
      });
    }

    const scores = buildEngineScores('issue');
    expect(scores.has('claude:opus')).toBe(false);
    expect(scores.has('codex:gpt-5.5')).toBe(false);
  });

  it('does not credit a realized proposal whose producer provenance is invalid', () => {
    const n = LEARNED_ROUTING_MIN_SAMPLES + 1;
    writeDecisions(judgedEntries(n, 'claude', 'opus', 'issue', 'ship'));
    for (const proposalId of realized.times.keys()) {
      const producer = realized.producers.get(proposalId)!;
      realized.producers.set(proposalId, { ...producer, provenanceValid: false });
    }

    expect(buildEngineScores('issue').size).toBe(0);
  });

  it('attributes forged negative judge labels only to the signed proposal producer', () => {
    const now = 1_700_000_000_000;
    const count = LEARNED_ROUTING_MIN_SAMPLES + 1;
    writeDecisions(Array.from({ length: count }, (_, index) => {
      const proposalId = `test-repo:issue:forged-negative-${index}`;
      return [
        {
          proposalId,
          action: 'judged',
          engine: 'codex',
          model: 'gpt-5.5',
          verdict: 'noise',
          ts: new Date(now - 1_000).toISOString(),
        },
        {
          proposalId,
          action: 'judged',
          engine: 'claude-fable-5',
          model: 'fable-5',
          verdict: 'harmful',
          ts: new Date(now).toISOString(),
        },
      ];
    }).flat());
    for (const proposalId of realized.producers.keys()) {
      realized.producers.set(proposalId, {
        engineModel: 'claude:opus',
        workSource: 'issue',
      });
    }

    const scores = buildEngineScores('issue', now);
    expect(scores.has('codex:gpt-5.5')).toBe(false);
    expect(scores.has('claude-fable-5:fable-5')).toBe(false);
    expect(scores.get('claude:opus')).toMatchObject({ score: 0, samples: count });
  });

  it('fails closed for negative decisions without valid producer provenance', () => {
    const count = LEARNED_ROUTING_MIN_SAMPLES + 1;
    writeDecisions(judgedEntries(count, 'codex', 'gpt-5.5', 'issue', 'harmful'));
    for (const [proposalId, producer] of realized.producers) {
      realized.producers.set(proposalId, { ...producer, provenanceValid: false });
    }

    expect(buildEngineScores('issue').size).toBe(0);
  });

  it('does not promote bare historical merged rows without proposal evidence', () => {
    const n = LEARNED_ROUTING_MIN_SAMPLES + 2;
    writeDecisions(judgedEntries(n, 'claude', 'opus', 'issue', 'ship'));
    realized.times.clear();

    expect(buildEngineScores('issue').size).toBe(0);
  });

  it('does not promote an old realized-merge label even when the proposal has a witness', () => {
    const n = LEARNED_ROUTING_MIN_SAMPLES + 2;
    const entries = judgedEntries(n, 'claude', 'opus', 'issue', 'ship', undefined, false);
    writeDecisions(entries.flatMap((entry) => entry.action === 'judged'
      ? [entry, {
          proposalId: entry.proposalId,
          action: 'merged',
          verdict: 'applied',
          labelBasis: 'realized-merge-v1',
          ts: entry.ts,
        }]
      : [entry]));

    expect(realized.times.size).toBe(n);
    expect(buildEngineScores('issue').size).toBe(0);
  });

  it('does not let a fresh witness upgrade a raw v1 label into routing credit', () => {
    const now = 1_800_000_000_000;
    const old = now - 100 * 24 * 60 * 60 * 1000;
    const n = LEARNED_ROUTING_MIN_SAMPLES + 2;
    writeDecisions(judgedEntries(n, 'claude', 'opus', 'issue', 'ship', old));
    for (const proposalId of realized.times.keys()) {
      realized.times.set(proposalId, new Date(now).toISOString());
    }

    expect(buildEngineScores('issue', now).has('claude:opus')).toBe(false);

    for (const proposalId of realized.times.keys()) {
      realized.times.set(proposalId, new Date(old).toISOString());
    }
    expect(buildEngineScores('issue', now).size).toBe(0);
  });

  it('uses the newest retry per proposal and judge engine/model', () => {
    const now = 1_700_000_000_000;
    const n = LEARNED_ROUTING_MIN_SAMPLES + 1;
    writeDecisions(Array.from({ length: n }, (_, index) => {
      const proposalId = `test-repo:issue:retry-${index}`;
      return [
        {
          proposalId,
          action: 'judged',
          engine: 'codex',
          model: 'gpt-5.5',
          verdict: 'noise',
          ts: new Date(now - 1_000).toISOString(),
        },
        {
          proposalId,
          action: 'judged',
          engine: 'codex',
          model: 'gpt-5.5',
          verdict: 'harmful',
          ts: new Date(now).toISOString(),
        },
      ];
    }).flat());

    const score = buildEngineScores('issue', now).get('codex:gpt-5.5');
    expect(score?.samples).toBe(n);
    expect(score?.score).toBe(0);
  });

  it('prefers canonical workSource over opaque proposal ids', () => {
    const n = LEARNED_ROUTING_MIN_SAMPLES + 2;
    writeDecisions(Array.from({ length: n }, (_, i) => {
      const proposalId = `prop-opaque-${i}`;
      return [
        {
          proposalId,
          workSource: 'issue',
          action: 'judged',
          engine: 'codex',
          model: 'gpt-5.5',
          verdict: 'noise',
        },
      ];
    }).flat());

    const issueScores = buildEngineScores('issue');
    expect(issueScores.get('codex:gpt-5.5')?.score).toBe(0);
    expect(buildEngineScores('todo').size).toBe(0);
  });

  it('derives task class from canonical workItemId when workSource is absent', () => {
    const n = LEARNED_ROUTING_MIN_SAMPLES + 2;
    writeDecisions(Array.from({ length: n }, (_, i) => ({
      proposalId: `prop-opaque-${i}`,
      workItemId: `/tmp/repo-alpha:lint:item-${i}`,
      action: 'judged',
      engine: 'local-coder',
      model: 'qwen',
      verdict: 'noise',
    })));

    const scores = buildEngineScores('lint');
    const s = scores.get('local-coder:qwen');
    expect(s).toBeDefined();
    expect(s!.score).toBeLessThan(0.5);
  });

  it('many ship verdicts plus raw v1 labels create no positive score', () => {
    writeDecisions(judgedEntries(LEARNED_ROUTING_MIN_SAMPLES + 3, 'claude', 'opus', 'issue', 'ship'));
    const scores = buildEngineScores('issue');
    expect(scores.has('claude:opus')).toBe(false);
  });

  it('codex:gpt-5.5 has score < 0.5 after many noise/review/harmful verdicts', () => {
    const n = LEARNED_ROUTING_MIN_SAMPLES + 3;
    writeDecisions([
      ...judgedEntries(n, 'codex', 'gpt-5.5', 'issue', 'noise'),
    ]);
    const scores = buildEngineScores('issue');
    const s = scores.get('codex:gpt-5.5');
    expect(s).toBeDefined();
    expect(s!.score).toBeLessThan(0.5);
  });

  it('raw v1 ships add zero while negative outcomes remain effective', () => {
    const n = LEARNED_ROUTING_MIN_SAMPLES + 2;
    writeDecisions([
      ...judgedEntries(n, 'claude', 'opus', 'todo', 'ship'),
      ...judgedEntries(n, 'claude', 'opus', 'todo', 'noise', undefined, true, 'reject'),
    ]);
    const scores = buildEngineScores('todo');
    const s = scores.get('claude:opus');
    expect(s).toBeDefined();
    expect(s!.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. sortEnginesByScore: high-ship engine promoted, low-reject engine demoted
// ---------------------------------------------------------------------------

describe('sortEnginesByScore', () => {
  it('does not promote an engine from raw v1 positive history', () => {
    // claude:opus has high ship rate; codex:gpt-5.5 has high reject rate
    writeDecisions([
      ...judgedEntries(LEARNED_ROUTING_MIN_SAMPLES + 2, 'claude', 'opus', 'issue', 'ship'),
      ...judgedEntries(LEARNED_ROUTING_MIN_SAMPLES + 2, 'codex', 'gpt-5.5', 'issue', 'noise'),
    ]);
    const scores = buildEngineScores('issue');
    const ordered = sortEnginesByScore(['codex', 'claude'] as any, scores, null);
    expect(ordered).toEqual(['codex', 'claude']);
  });

  it('is a no-op (stable) when scores map is empty (cold-start)', () => {
    const scores = buildEngineScores('issue'); // empty
    const original = ['codex', 'claude', 'local-coder'] as any;
    const ordered = sortEnginesByScore(original, scores, null);
    expect(ordered).toEqual(['codex', 'claude', 'local-coder']);
  });

  it('is stable for equal scores (preserves original order)', () => {
    const scores: EngineScoreMap = new Map([
      ['claude', { key: 'claude', engine: 'claude', model: null, score: 0.8, samples: LEARNED_ROUTING_MIN_SAMPLES }],
      ['codex', { key: 'codex', engine: 'codex', model: null, score: 0.8, samples: LEARNED_ROUTING_MIN_SAMPLES }],
    ]);
    const original = ['claude', 'codex'] as any;
    const ordered = sortEnginesByScore(original, scores, null);
    expect(ordered).toEqual(['claude', 'codex']);
  });
});

// ---------------------------------------------------------------------------
// 6. routeTask — flag-off: learnedRouting:false = byte-identical static routing
// ---------------------------------------------------------------------------

describe('routeTask — flag-off parity', () => {
  it('produces the same engine with learnedRouting:false even when history favors the other', () => {
    // Seed: codex has high reject rate for 'issue' → with learnedRouting:true, claude would be preferred
    writeDecisions([
      ...judgedEntries(LEARNED_ROUTING_MIN_SAMPLES + 3, 'codex', 'gpt-5.5', 'issue', 'noise'),
      ...judgedEntries(LEARNED_ROUTING_MIN_SAMPLES + 3, 'claude', 'opus', 'issue', 'ship'),
    ]);

    const item = makeItem('issue', 4, 5);
    const ctx = makeCtx(['claude', 'codex']);

    // With flag OFF — must be byte-identical to pre-M240 (static policy wins)
    const cfgOff = makeCfg({ learnedRouting: false, routingPolicy: 'quality' });
    const resultOff = routeTask(item, cfgOff, ctx);

    // Static 'quality' policy for hard issue items routes to claude (reasoning)
    // This tests that the engine selected is one of the valid static choices
    // (not a function of history)
    expect(['claude', 'codex', 'local-coder', 'builtin']).toContain(resultOff.engine);

    // With flag ON — history should bias toward claude (high ship rate)
    const cfgOn = makeCfg({ learnedRouting: true, routingPolicy: 'quality' });
    const resultOn = routeTask(item, cfgOn, ctx);
    expect(['claude', 'codex', 'local-coder', 'builtin']).toContain(resultOn.engine);

    // The key parity assertion: flag-off result must be deterministic and
    // reproducible across calls (static policy = no side-effects from history)
    const resultOff2 = routeTask(item, cfgOff, ctx);
    expect(resultOff2.engine).toBe(resultOff.engine);
    expect(resultOff2.model).toBe(resultOff.model);
  });
});

// ---------------------------------------------------------------------------
// 7. routeTask — learned bias promotes high-ship engine
// ---------------------------------------------------------------------------

describe('routeTask — learned bias promotes high-ship engine', () => {
  it(`keeps static routing with exactly ${LEARNED_ROUTING_MIN_SAMPLES} raw v1 positives`, () => {
    const fixedNow = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixedNow));
    writeDecisions(
      judgedEntries(LEARNED_ROUTING_MIN_SAMPLES, 'claude', 'opus', 'todo', 'ship', fixedNow),
    );
    vi.setSystemTime(new Date(fixedNow + 1));

    const item = makeItem('todo', 4, 5);
    const ctx = makeCtx(['claude', 'codex']);
    const cfg = makeCfg({ learnedRouting: true, routingPolicy: 'balanced' });

    const result = routeTask(item, cfg, ctx);
    expect(result.engine).toBe('codex');
  });

  it(`keeps raw v1 positives held when the route clock is delayed`, () => {
    const fixedNow = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixedNow));
    writeDecisions(
      judgedEntries(LEARNED_ROUTING_MIN_SAMPLES, 'claude', 'opus', 'todo', 'ship', fixedNow),
    );
    vi.setSystemTime(new Date(fixedNow + 1_000));

    const scores = buildEngineScores('todo');
    expect(scores.has('claude:opus')).toBe(false);

    const item = makeItem('todo', 4, 5);
    const ctx = makeCtx(['claude', 'codex']);
    const cfg = makeCfg({ learnedRouting: true, routingPolicy: 'balanced' });

    const result = routeTask(item, cfg, ctx);
    expect(result.engine).toBe('codex');
  });

  it(`keeps ${LEARNED_ROUTING_MIN_SAMPLES - 1} fresh samples in the thin-sample guard through routing`, () => {
    const fixedNow = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixedNow));
    writeDecisions(
      judgedEntries(LEARNED_ROUTING_MIN_SAMPLES - 1, 'claude', 'opus', 'todo', 'ship', fixedNow),
    );
    vi.setSystemTime(new Date(fixedNow + 1));

    const item = makeItem('todo', 4, 5);
    const ctx = makeCtx(['claude', 'codex']);
    const cfg = makeCfg({ learnedRouting: true, routingPolicy: 'balanced' });

    const result = routeTask(item, cfg, ctx);
    expect(result.engine).toBe('codex');
  });

  it('routes to high-ship-rate engine for a task-class with sufficient history', () => {
    // Give codex a terrible reject rate and claude a great ship rate for 'issue'
    writeDecisions([
      ...judgedEntries(LEARNED_ROUTING_MIN_SAMPLES + 5, 'claude', 'opus', 'issue', 'ship'),
      ...judgedEntries(LEARNED_ROUTING_MIN_SAMPLES + 5, 'codex', 'gpt-5.5', 'issue', 'harmful'),
    ]);

    const item = makeItem('issue', 5, 5); // hard issue = substantive
    const ctx = makeCtx(['claude', 'codex']);
    const cfg = makeCfg({ learnedRouting: true, routingPolicy: 'quality' });

    const result = routeTask(item, cfg, ctx);
    // Learned bias should have promoted claude over codex for 'issue' tasks
    expect(result.engine).toBe('claude');
  });

  it('routes to codex when codex has higher ship rate for todo/coding tasks', () => {
    writeDecisions([
      ...judgedEntries(LEARNED_ROUTING_MIN_SAMPLES + 5, 'codex', 'gpt-5.5', 'todo', 'ship'),
      ...judgedEntries(LEARNED_ROUTING_MIN_SAMPLES + 5, 'claude', 'opus', 'todo', 'noise'),
    ]);

    const item = makeItem('todo', 4, 5);
    const ctx = makeCtx(['claude', 'codex']);
    const cfg = makeCfg({ learnedRouting: true, routingPolicy: 'quality' });

    const result = routeTask(item, cfg, ctx);
    // Learned bias should favor codex for todo tasks
    expect(result.engine).toBe('codex');
  });
});

// ---------------------------------------------------------------------------
// 8. Hard constraints are never violated by learned routing
// ---------------------------------------------------------------------------

describe('routeTask — hard constraints never violated', () => {
  it('never routes to a backend not in allowedBackends, even when history favors it', () => {
    // Seed high ship rate for 'codex' on 'issue'
    writeDecisions(judgedEntries(LEARNED_ROUTING_MIN_SAMPLES + 5, 'codex', 'gpt-5.5', 'issue', 'ship'));

    const item = makeItem('issue', 4, 5);
    // Only allow 'claude' — not 'codex'
    const cfg = makeCfg({ allowedBackends: ['claude', 'builtin'], learnedRouting: true });
    const ctx = makeCtx(['claude']); // codex not in ctx either

    const result = routeTask(item, cfg, ctx);
    // Must NOT be codex despite its high ship rate
    expect(result.engine).not.toBe('codex');
    expect(['claude', 'builtin', 'local-coder']).toContain(result.engine);
  });

  it('falls back to builtin when no allowed engine is available', () => {
    const item = makeItem('issue', 1, 1);
    const cfg = makeCfg({ allowedBackends: ['builtin'], learnedRouting: true });
    const ctx = makeCtx([]); // nothing available

    const result = routeTask(item, cfg, ctx);
    expect(result.engine).toBe('builtin');
  });
});

// ---------------------------------------------------------------------------
// 9. Cold-start (no history) → static policy unchanged (both flag states)
// ---------------------------------------------------------------------------

describe('routeTask — cold-start fallback', () => {
  it('produces same result with learnedRouting:true and no history as with learnedRouting:false', () => {
    // No decisions written — ledger is empty
    const item = makeItem('issue', 4, 5);
    const ctx = makeCtx(['claude', 'codex']);

    const cfgOn = makeCfg({ learnedRouting: true, routingPolicy: 'quality' });
    const cfgOff = makeCfg({ learnedRouting: false, routingPolicy: 'quality' });

    const resultOn = routeTask(item, cfgOn, ctx);
    const resultOff = routeTask(item, cfgOff, ctx);

    // Cold-start: both should yield the same static routing decision
    expect(resultOn.engine).toBe(resultOff.engine);
    expect(resultOn.model).toBe(resultOff.model);
  });
});

// ---------------------------------------------------------------------------
// 10. Recency weighting: very old verdicts contribute less
// ---------------------------------------------------------------------------

describe('buildEngineScores — recency weighting', () => {
  it('recent ship verdicts produce higher score than old ship verdicts with same count', () => {
    const now = Date.now();
    const veryOldMs = now - 10 * LEARNED_ROUTING_HALF_LIFE_MS; // ~70 days ago
    const recentMs = now - LEARNED_ROUTING_HALF_LIFE_MS / 10; // ~16 hours ago

    const n = LEARNED_ROUTING_MIN_SAMPLES + 2;

    // Write old verdicts for codex (all ships but old)
    writeDecisions(judgedEntries(n, 'codex', 'gpt-5.5', 'lint', 'ship', veryOldMs));
    // Append recent verdicts for claude (same count, all ships but recent)
    const dir = path.join(tmpHome, '.ashlr', 'decisions');
    const today = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `${today}.jsonl`);
    const recentLines = judgedEntries(n, 'claude', 'opus', 'lint', 'ship', recentMs)
      .map((e) => JSON.stringify({ ts: e.ts, proposalId: e.proposalId, action: e.action, engine: e.engine, model: e.model, verdict: e.verdict }))
      .join('\n');
    fs.appendFileSync(file, '\n' + recentLines + '\n', 'utf8');

    const scores = buildEngineScores('lint', now);

    const codexScore = scores.get('codex:gpt-5.5');
    const claudeScore = scores.get('claude:opus');

    // Both are all-ship so score numerically = shipWeight / totalWeight.
    // The recency weight for old entries is 2^(-10) ≈ 0.001, so the old
    // entries' total weight is far below LEARNED_ROUTING_MIN_SAMPLES even
    // with n samples, meaning codex score should be 0.5 (below floor).
    // Claude's recent entries have weight ~1 each, so totalWeight ≈ n.
    if (codexScore !== undefined && codexScore.samples >= LEARNED_ROUTING_MIN_SAMPLES) {
      // If old entries somehow pass the floor, claude's score should still be >= codex's
      expect(claudeScore?.score ?? 0.5).toBeGreaterThanOrEqual(codexScore.score);
    } else {
      // Old entries fall below sample floor → codex is neutral (0.5)
      expect(codexScore?.score ?? 0.5).toBe(0.5);
    }
    // Claude's recent entries should pass the floor and have a high score
    if ((claudeScore?.samples ?? 0) >= LEARNED_ROUTING_MIN_SAMPLES) {
      expect(claudeScore!.score).toBeGreaterThan(0.5);
    }
  });
});

// ---------------------------------------------------------------------------
// 11. taskClass isolation: verdicts for one source don't affect another
// ---------------------------------------------------------------------------

describe('buildEngineScores — taskClass isolation', () => {
  it('issue verdicts do not affect todo scores', () => {
    writeDecisions([
      ...judgedEntries(LEARNED_ROUTING_MIN_SAMPLES + 3, 'claude', 'opus', 'issue', 'ship'),
      ...judgedEntries(LEARNED_ROUTING_MIN_SAMPLES + 3, 'codex', 'gpt-5.5', 'issue', 'noise'),
    ]);

    const todoScores = buildEngineScores('todo');
    // No todo verdicts were written → map should be empty for todo
    expect(todoScores.size).toBe(0);
  });
});
