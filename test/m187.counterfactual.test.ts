/**
 * m187.counterfactual.test.ts — Counterfactual replay for judge calibration.
 *
 * Covers:
 *   1. cohenKappa: perfect agreement = 1, single pair = null, degenerate = 1
 *   2. Samples only judged-with-OUTCOME proposals (no-outcome traces ignored)
 *   3. Re-judges each via the frontier judge and compares to recorded outcome
 *   4. Computes agreements / disagreements + per-judge kappa + per-source accuracy
 *   5. Persists a calibration report to ~/.ashlr/fleet/calibration.json
 *   6. Respects the sample cap (cfg cast + opts.maxSamples), over-fetch-then-cap
 *   7. Skips traces whose proposal/diff is unrecoverable
 *   8. Never-throws: empty store, missing judge client, throwing judge fn
 *
 * Hermetic: HOME relocated to a tmp dir; all I/O + judge mocked via test seams.
 * Mirrors m141/m143 conventions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Proposal, DecisionEntry } from '../src/core/types.js';
import type { JudgeProposalSource, JudgeTrace } from '../src/core/fleet/judge-trace.js';
import type { ManagerVerdict } from '../src/core/fleet/manager.js';
import type { CounterfactualOpts } from '../src/core/fleet/counterfactual.js';
import {
  signLocalMergeIntent,
  signLocalRealizedMergeReceipt,
} from '../src/core/foundry/provenance.js';

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m187-home-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 0;
function pid(): string { return `p-m187-${_seq++}`; }

function makeTrace(overrides: Partial<JudgeTrace> = {}): JudgeTrace {
  const trace: JudgeTrace = {
    proposalId: pid(),
    judgeEngine: 'historical-judge',
    verdict: 'ship',
    scores: { value: 4, correctness: 4, scope: 2, alignment: 4 },
    fullReasoning: '',
    promptContext: '',
    ts: new Date().toISOString(),
    outcome: 'merged',
    outcomeBasis: 'realized-merge-v1',
    ...overrides,
  };
  if (trace.outcome !== 'merged') delete trace.outcomeBasis;
  return trace;
}

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: pid(),
    repo: '/repos/test',
    origin: 'swarm',
    kind: 'patch',
    title: 'm187 test proposal',
    summary: 'test summary',
    status: 'pending',
    createdAt: new Date().toISOString(),
    diff: '+const x = 1;\n',
    ...overrides,
  } as Proposal;
}

function makeAuthenticatedMergedProposal(
  id: string,
  overrides: Partial<Proposal> = {},
  observedAt = new Date().toISOString(),
): Proposal {
  const repo = path.join(tmpHome, `repo-${id}`);
  fs.mkdirSync(repo, { recursive: true, mode: 0o700 });
  const diffHash = 'd'.repeat(64);
  const baseBeforeOid = 'a'.repeat(40);
  const proposalHeadOid = 'b'.repeat(40);
  const mergeCommitOid = 'c'.repeat(40);
  const unsignedIntent = {
    schemaVersion: 1 as const,
    branch: `ashlr/merge/${id}`,
    base: 'main',
    baseBeforeOid,
    proposalHeadOid,
    diffHash,
    evidencePackDigest: 'e'.repeat(64),
    authorizationId: '1'.repeat(32),
    authorizedAt: new Date().toISOString(),
  };
  const localMergeIntent = {
    ...unsignedIntent,
    attestation: signLocalMergeIntent(id, repo, unsignedIntent),
  };
  const unsignedWitness = {
    schemaVersion: 1 as const,
    source: 'local-default-branch' as const,
    base: 'main',
    baseBeforeOid,
    proposalHeadOid,
    mergeCommitOid,
    observedAt,
    proposalId: id,
    diffHash,
    intentAttestation: localMergeIntent.attestation,
  };
  return makeProposal({
    id,
    repo,
    status: 'applied',
    diffHash,
    verifyResult: { passed: true, baseHead: baseBeforeOid, diffHash },
    localMergeIntent,
    realizedMerge: {
      ...unsignedWitness,
      attestation: signLocalRealizedMergeReceipt(id, repo, unsignedWitness),
    },
    ...overrides,
  });
}

function healthyProposalSource(proposals: Proposal[]): JudgeProposalSource {
  return { sourceState: 'healthy', complete: true, proposals };
}

function makeVerdict(verdict: ManagerVerdict['verdict']): ManagerVerdict {
  return {
    proposalId: 'x',
    verdict,
    value: 4,
    correctness: 4,
    scope: 2,
    alignment: 4,
    rationale: 'mock',
    wouldMerge: false,
  };
}

/**
 * Build a fully-seamed opts object. By default:
 *   - traces: provided list (filtered by outcomeOnly automatically)
 *   - proposals: one per trace id, with a diff
 *   - judge: returns a fixed verdict (or a per-id map)
 */
function buildOpts(args: {
  traces: JudgeTrace[];
  proposals?: Record<string, Proposal | null>;
  verdictFor?: (proposal: Proposal) => ManagerVerdict['verdict'];
  judgeClient?: { complete: (s: string, u: string) => Promise<string>; model: string } | null;
  judgeFn?: CounterfactualOpts['_judgeProposalFn'];
  decisions?: Record<string, DecisionEntry[]>;
  maxSamples?: number;
  judgeCalls?: { n: number };
  proposalSource?: JudgeProposalSource;
  proposalReads?: { n: number };
  persistFn?: CounterfactualOpts['_persistFn'];
}): CounterfactualOpts {
  const proposals =
    args.proposals ??
    Object.fromEntries(args.traces.map((t) => [
      t.proposalId,
      t.outcome === 'merged'
        ? makeAuthenticatedMergedProposal(t.proposalId)
        : makeProposal({ id: t.proposalId }),
    ]));

  const judgeClient =
    args.judgeClient === undefined
      ? { complete: vi.fn().mockResolvedValue(''), model: 'frontier-opus-mock' }
      : args.judgeClient;

  const judgeFn: CounterfactualOpts['_judgeProposalFn'] =
    args.judgeFn ??
    (async (proposal) => {
      if (args.judgeCalls) args.judgeCalls.n++;
      const v = args.verdictFor ? args.verdictFor(proposal) : 'ship';
      return makeVerdict(v);
    });

  return {
    maxSamples: args.maxSamples,
    _readTracesFn: (filter) => {
      let out = args.traces;
      if (filter?.outcomeOnly) out = out.filter((t) => t.outcome !== undefined);
      if (filter?.limit && filter.limit > 0) out = out.slice(0, filter.limit);
      return out;
    },
    _readDecisionsFn: (opts) =>
      (opts?.proposalId && args.decisions?.[opts.proposalId]) || [],
    _readProposalsFn: () => {
      if (args.proposalReads) args.proposalReads.n++;
      return args.proposalSource ?? healthyProposalSource(
        Object.values(proposals).filter((proposal): proposal is Proposal => proposal !== null),
      );
    },
    _resolveJudgeFn: () => judgeClient,
    _judgeProposalFn: judgeFn,
    _persistFn: args.persistFn,
  };
}

const CFG = {} as never;

// ---------------------------------------------------------------------------
// 1. cohenKappa
// ---------------------------------------------------------------------------

describe('m187 — cohenKappa', () => {
  it('returns null for fewer than 2 pairs', async () => {
    const { cohenKappa } = await import('../src/core/fleet/counterfactual.js');
    expect(cohenKappa([])).toBeNull();
    expect(cohenKappa([{ a: 'merge', b: 'merge' }])).toBeNull();
  });

  it('returns 1.0 for perfect agreement across two categories', async () => {
    const { cohenKappa } = await import('../src/core/fleet/counterfactual.js');
    const k = cohenKappa([
      { a: 'merge', b: 'merge' },
      { a: 'reject', b: 'reject' },
      { a: 'merge', b: 'merge' },
      { a: 'reject', b: 'reject' },
    ]);
    expect(k).toBeCloseTo(1.0, 5);
  });

  it('returns 1.0 for degenerate all-one-category', async () => {
    const { cohenKappa } = await import('../src/core/fleet/counterfactual.js');
    const k = cohenKappa([
      { a: 'merge', b: 'merge' },
      { a: 'merge', b: 'merge' },
    ]);
    expect(k).toBe(1.0);
  });

  it('returns negative kappa for systematic disagreement', async () => {
    const { cohenKappa } = await import('../src/core/fleet/counterfactual.js');
    const k = cohenKappa([
      { a: 'merge', b: 'reject' },
      { a: 'reject', b: 'merge' },
      { a: 'merge', b: 'reject' },
      { a: 'reject', b: 'merge' },
    ]);
    expect(k).not.toBeNull();
    expect(k!).toBeLessThan(0);
  });

  it('never throws on malformed input', async () => {
    const { cohenKappa } = await import('../src/core/fleet/counterfactual.js');
    expect(() => cohenKappa(undefined as never)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. Samples only judged-with-outcome proposals
// ---------------------------------------------------------------------------

describe('m187 — samples only outcome-linked proposals', () => {
  it('ignores an unqualified historical merged outcome', async () => {
    const { runCounterfactualReplay } = await import('../src/core/fleet/counterfactual.js');
    const trace = makeTrace({ proposalId: 'legacy-unqualified' });
    delete trace.outcomeBasis;
    const calls = { n: 0 };

    const report = await runCounterfactualReplay(CFG, buildOpts({
      traces: [trace],
      judgeCalls: calls,
    }));

    expect(report.replayed).toBe(0);
    expect(report.agreements).toBe(0);
    expect(calls.n).toBe(0);
  });

  it('fails closed on a malformed merged basis injected in memory', async () => {
    const { runCounterfactualReplay } = await import('../src/core/fleet/counterfactual.js');
    const trace = makeTrace({ proposalId: 'malformed-basis' });
    trace.outcomeBasis = 'operator-said-so' as never;
    const calls = { n: 0 };

    const report = await runCounterfactualReplay(CFG, buildOpts({
      traces: [trace],
      judgeCalls: calls,
    }));

    expect(report.replayed).toBe(0);
    expect(calls.n).toBe(0);
  });

  it('replays only merged traces backed by current authenticated proposal witnesses', async () => {
    const { runCounterfactualReplay } = await import('../src/core/fleet/counterfactual.js');
    const ids = ['valid-merge', 'forged-merge', 'stale-merge', 'stripped-merge'];
    const traces = ids.map((proposalId) => makeTrace({ proposalId }));
    const valid = makeAuthenticatedMergedProposal(ids[0]!);
    const forged = makeAuthenticatedMergedProposal(ids[1]!);
    forged.realizedMerge!.attestation = '0'.repeat(64);
    const stale = makeAuthenticatedMergedProposal(
      ids[2]!,
      {},
      new Date(Date.now() + 30_000).toISOString(),
    );
    const stripped = makeAuthenticatedMergedProposal(ids[3]!);
    delete stripped.realizedMerge;
    const calls = { n: 0 };

    const report = await runCounterfactualReplay(CFG, buildOpts({
      traces,
      proposalSource: healthyProposalSource([valid, forged, stale, stripped]),
      judgeCalls: calls,
    }));

    expect(report.details.map((detail) => detail.proposalId)).toEqual(['valid-merge']);
    expect(report.replayed).toBe(1);
    expect(calls.n).toBe(1);
  });

  it.each([
    { sourceState: 'degraded' as const, complete: false },
    { sourceState: 'healthy' as const, complete: false },
  ])('withholds calibration and persistence for $sourceState complete=$complete proposal input', async (quality) => {
    const { runCounterfactualReplay, calibrationReportPath } = await import(
      '../src/core/fleet/counterfactual.js'
    );
    const trace = makeTrace({ proposalId: 'withheld-source' });
    const persist = vi.fn();
    const calls = { n: 0 };

    const report = await runCounterfactualReplay(CFG, buildOpts({
      traces: [trace],
      proposalSource: {
        ...quality,
        proposals: [makeAuthenticatedMergedProposal(trace.proposalId)],
      },
      judgeCalls: calls,
      persistFn: persist,
    }));

    expect(report).toMatchObject({
      replayed: 0,
      agreements: 0,
      disagreements: 0,
      kappaByJudge: {},
      calibrationBySource: {},
      details: [],
    });
    expect(report.notes.join(' ')).toMatch(/calibration withheld.*degraded or incomplete/i);
    expect(calls.n).toBe(0);
    expect(persist).not.toHaveBeenCalled();
    expect(fs.existsSync(calibrationReportPath())).toBe(false);
  });

  it('takes one proposal snapshot before replay and persistence', async () => {
    const { runCounterfactualReplay } = await import('../src/core/fleet/counterfactual.js');
    const proposalReads = { n: 0 };
    const events: string[] = [];

    const opts = buildOpts({
      traces: [makeTrace({ proposalId: 'single-snapshot' })],
      proposalReads,
      persistFn: () => { events.push('persist'); },
    });
    const readSnapshot = opts._readProposalsFn!;
    opts._readProposalsFn = () => {
      events.push('snapshot');
      return readSnapshot();
    };
    const judgeProposal = opts._judgeProposalFn!;
    opts._judgeProposalFn = async (...args) => {
      events.push('replay');
      return judgeProposal(...args);
    };

    const report = await runCounterfactualReplay(CFG, opts);

    expect(report.replayed).toBe(1);
    expect(proposalReads.n).toBe(1);
    expect(events).toEqual(['snapshot', 'replay', 'persist']);
  });

  it('ignores traces without a recorded outcome', async () => {
    const { runCounterfactualReplay } = await import('../src/core/fleet/counterfactual.js');

    const withOutcome = makeTrace({ proposalId: 'has-outcome', outcome: 'merged' });
    const noOutcome = makeTrace({ proposalId: 'no-outcome', outcome: undefined });

    const calls = { n: 0 };
    const report = await runCounterfactualReplay(CFG, buildOpts({
      traces: [withOutcome, noOutcome],
      judgeCalls: calls,
    }));

    // Only the outcome-linked proposal is replayed.
    expect(report.replayed).toBe(1);
    expect(calls.n).toBe(1);
    expect(report.details.map((d) => d.proposalId)).toEqual(['has-outcome']);
  });

  it('returns an empty report (and note) when no outcome-linked traces exist', async () => {
    const { runCounterfactualReplay } = await import('../src/core/fleet/counterfactual.js');
    const report = await runCounterfactualReplay(CFG, buildOpts({
      traces: [makeTrace({ outcome: undefined })],
    }));
    expect(report.replayed).toBe(0);
    expect(report.agreements).toBe(0);
    expect(report.notes.join(' ')).toMatch(/no judged proposals with a recorded outcome/i);
  });
});

// ---------------------------------------------------------------------------
// 3 + 4. Re-judges and computes agreement / kappa / per-source accuracy
// ---------------------------------------------------------------------------

describe('m187 — re-judge + agreement + kappa + source breakdown', () => {
  it('suppresses durable trace recording for synthetic replay judgments', async () => {
    const { runCounterfactualReplay } = await import('../src/core/fleet/counterfactual.js');
    const judgeOptions: unknown[] = [];
    const judgeFn: NonNullable<CounterfactualOpts['_judgeProposalFn']> = async (
      _proposal,
      _cfg,
      _client,
      options,
    ) => {
      judgeOptions.push(options);
      return makeVerdict('ship');
    };

    const report = await runCounterfactualReplay(CFG, buildOpts({
      traces: [makeTrace({ proposalId: 'ephemeral-replay', outcome: 'merged' })],
      judgeFn,
    }));

    expect(report.replayed).toBe(1);
    expect(judgeOptions).toEqual([{ recordTrace: false }]);
  });

  it('replays a proposal once when retries produced multiple trace ids', async () => {
    const { runCounterfactualReplay } = await import('../src/core/fleet/counterfactual.js');
    const calls = { n: 0 };
    const older = makeTrace({
      traceId: 'trace-retry-old', proposalId: 'retry-once', outcome: 'merged',
      ts: '2025-01-01T00:00:00.000Z', outcomeAt: '2025-01-02T00:00:00.000Z',
    });
    const newer = makeTrace({
      traceId: 'trace-retry-new', proposalId: 'retry-once', outcome: 'merged',
      ts: '2025-01-03T00:00:00.000Z', outcomeAt: '2025-01-04T00:00:00.000Z',
    });
    const report = await runCounterfactualReplay(CFG, buildOpts({
      traces: [older, newer], judgeCalls: calls,
    }));

    expect(report.replayed).toBe(1);
    expect(calls.n).toBe(1);
    expect(report.details).toHaveLength(1);
  });

  it('counts an agreement when fresh verdict intent matches the outcome intent', async () => {
    const { runCounterfactualReplay } = await import('../src/core/fleet/counterfactual.js');

    // merged outcome (intent=merge) + fresh verdict 'ship' (intent=merge) → agree
    const trace = makeTrace({ proposalId: 'agree-1', outcome: 'merged', judgeEngine: 'judgeA' });
    const report = await runCounterfactualReplay(CFG, buildOpts({
      traces: [trace],
      verdictFor: () => 'ship',
    }));

    expect(report.replayed).toBe(1);
    expect(report.agreements).toBe(1);
    expect(report.disagreements).toBe(0);
    expect(report.details[0]!.agreed).toBe(true);
    expect(report.details[0]!.replayVerdict).toBe('ship');
    expect(report.details[0]!.replayIntent).toBe('merge');
    expect(report.details[0]!.outcomeIntent).toBe('merge');
    expect(report.details[0]!.replayJudgeEngine).toBe('frontier-opus-mock');
  });

  it('counts a disagreement when fresh verdict diverges from the realized outcome', async () => {
    const { runCounterfactualReplay } = await import('../src/core/fleet/counterfactual.js');

    // merged outcome (intent=merge) but fresh verdict 'noise' (intent=reject) → disagree
    const trace = makeTrace({ proposalId: 'disagree-1', outcome: 'merged' });
    const report = await runCounterfactualReplay(CFG, buildOpts({
      traces: [trace],
      verdictFor: () => 'noise',
    }));

    expect(report.agreements).toBe(0);
    expect(report.disagreements).toBe(1);
    expect(report.details[0]!.agreed).toBe(false);
  });

  it('computes per-judge kappa keyed by the original judge engine', async () => {
    const { runCounterfactualReplay } = await import('../src/core/fleet/counterfactual.js');

    // 4 traces all originally judged by 'judgeA'. Two merged→ship (agree-merge),
    // two rejected→noise (agree-reject) → perfect agreement, kappa ~ 1.0.
    const traces = [
      makeTrace({ proposalId: 'k1', judgeEngine: 'judgeA', outcome: 'merged' }),
      makeTrace({ proposalId: 'k2', judgeEngine: 'judgeA', outcome: 'merged' }),
      makeTrace({ proposalId: 'k3', judgeEngine: 'judgeA', outcome: 'rejected' }),
      makeTrace({ proposalId: 'k4', judgeEngine: 'judgeA', outcome: 'rejected' }),
    ];
    const report = await runCounterfactualReplay(CFG, buildOpts({
      traces,
      // ship for the merged ones, noise for the rejected ones → perfect.
      verdictFor: (p) => (p.id === 'k1' || p.id === 'k2' ? 'ship' : 'noise'),
    }));

    expect(report.replayed).toBe(4);
    const cal = report.kappaByJudge['judgeA'];
    expect(cal).toBeDefined();
    expect(cal!.sampleSize).toBe(4);
    expect(cal!.agreements).toBe(4);
    expect(cal!.agreementRate).toBe(1);
    expect(cal!.kappa).toBeCloseTo(1.0, 5);
  });

  it('breaks down accuracy by work-source (engineModel)', async () => {
    const { runCounterfactualReplay } = await import('../src/core/fleet/counterfactual.js');

    const traces = [
      makeTrace({ proposalId: 's1', outcome: 'merged' }),
      makeTrace({ proposalId: 's2', outcome: 'merged' }),
    ];
    const proposals: Record<string, Proposal> = {
      s1: makeAuthenticatedMergedProposal('s1', { engineModel: 'codex:gpt-5.5' }),
      s2: makeAuthenticatedMergedProposal('s2', { engineModel: 'claude:opus' }),
    };
    const report = await runCounterfactualReplay(CFG, buildOpts({
      traces,
      proposals,
      // codex agrees (ship→merge), claude disagrees (noise→reject)
      verdictFor: (p) => (p.engineModel === 'codex:gpt-5.5' ? 'ship' : 'noise'),
    }));

    expect(report.calibrationBySource['codex:gpt-5.5']!.accuracy).toBe(1);
    expect(report.calibrationBySource['claude:opus']!.accuracy).toBe(0);
    expect(report.details.find((d) => d.proposalId === 's1')!.workSource).toBe('codex:gpt-5.5');
  });

  it('falls back to the decisions ledger engine/model for work-source', async () => {
    const { runCounterfactualReplay } = await import('../src/core/fleet/counterfactual.js');

    // Proposal has no engineModel and origin will be used unless ledger wins.
    // Here proposal has no engineModel/origin sentinel; ledger supplies model.
    const trace = makeTrace({ proposalId: 'led-1', outcome: 'merged' });
    const proposal = makeAuthenticatedMergedProposal('led-1');
    delete (proposal as Partial<Proposal>).engineModel;
    delete (proposal as Partial<Proposal>).origin;

    const report = await runCounterfactualReplay(CFG, buildOpts({
      traces: [trace],
      proposals: { 'led-1': proposal },
      decisions: {
        'led-1': [{ ts: 't', proposalId: 'led-1', action: 'judged', model: 'gemini:flash' }],
      },
    }));

    expect(report.details[0]!.workSource).toBe('gemini:flash');
  });
});

// ---------------------------------------------------------------------------
// 5. Persists the calibration report
// ---------------------------------------------------------------------------

describe('m187 — persists calibration.json', () => {
  it('writes ~/.ashlr/fleet/calibration.json with the report shape', async () => {
    const { runCounterfactualReplay, calibrationReportPath } = await import(
      '../src/core/fleet/counterfactual.js'
    );

    const report = await runCounterfactualReplay(CFG, buildOpts({
      traces: [makeTrace({ proposalId: 'persist-1', outcome: 'merged' })],
      verdictFor: () => 'ship',
    }));
    expect(report.replayed).toBe(1);

    const p = calibrationReportPath();
    expect(p).toContain(path.join('.ashlr', 'fleet', 'calibration.json'));
    expect(fs.existsSync(p)).toBe(true);

    const onDisk = JSON.parse(fs.readFileSync(p, 'utf8')) as typeof report;
    expect(onDisk.replayed).toBe(1);
    expect(onDisk.agreements).toBe(1);
    expect(typeof onDisk.generatedAt).toBe('string');
    expect(onDisk.kappaByJudge).toBeDefined();
    expect(onDisk.calibrationBySource).toBeDefined();
    expect(Array.isArray(onDisk.details)).toBe(true);
  });

  it('scrubs secrets out of the persisted report', async () => {
    const { runCounterfactualReplay, calibrationReportPath } = await import(
      '../src/core/fleet/counterfactual.js'
    );

    // Smuggle a secret into the work-source string via the proposal engineModel.
    const trace = makeTrace({ proposalId: 'secret-1', outcome: 'merged' });
    const proposal = makeAuthenticatedMergedProposal('secret-1', {
      engineModel: 'engine api_key=sk-abcdefghijklmnopqrstuvwx',
    });
    await runCounterfactualReplay(CFG, buildOpts({
      traces: [trace],
      proposals: { 'secret-1': proposal },
    }));

    const raw = fs.readFileSync(calibrationReportPath(), 'utf8');
    expect(raw).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(raw).toContain('[REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// 6. Respects the cap
// ---------------------------------------------------------------------------

describe('m187 — respects the sample cap', () => {
  it('caps replays at opts.maxSamples', async () => {
    const { runCounterfactualReplay } = await import('../src/core/fleet/counterfactual.js');

    const traces = Array.from({ length: 8 }, (_, i) =>
      makeTrace({ proposalId: `cap-${i}`, outcome: 'merged' }),
    );
    const calls = { n: 0 };
    const report = await runCounterfactualReplay(CFG, buildOpts({
      traces,
      maxSamples: 3,
      judgeCalls: calls,
    }));

    expect(report.replayed).toBe(3);
    expect(calls.n).toBe(3);
  });

  it('defaults to a cap of 10 and reads cfg.foundry.counterfactualSampleCap', async () => {
    const { runCounterfactualReplay } = await import('../src/core/fleet/counterfactual.js');

    const traces = Array.from({ length: 20 }, (_, i) =>
      makeTrace({ proposalId: `dc-${i}`, outcome: 'merged' }),
    );

    // Default cap (10) when neither opts nor cfg specify one.
    const defReport = await runCounterfactualReplay(CFG, buildOpts({ traces }));
    expect(defReport.replayed).toBe(10);

    // cfg cast cap overrides the default.
    const cfgCap = { foundry: { counterfactualSampleCap: 5 } } as never;
    const cfgReport = await runCounterfactualReplay(cfgCap, buildOpts({ traces }));
    expect(cfgReport.replayed).toBe(5);
  });

  it('cap <= 0 replays nothing', async () => {
    const { runCounterfactualReplay } = await import('../src/core/fleet/counterfactual.js');
    const report = await runCounterfactualReplay(CFG, buildOpts({
      traces: [makeTrace({ outcome: 'merged' })],
      maxSamples: 0,
    }));
    expect(report.replayed).toBe(0);
    expect(report.notes.join(' ')).toMatch(/cap <= 0/i);
  });
});

// ---------------------------------------------------------------------------
// 7. Skips unrecoverable diffs
// ---------------------------------------------------------------------------

describe('m187 — skips unrecoverable proposals', () => {
  it('skips traces whose proposal is missing or has no diff, notes the skip', async () => {
    const { runCounterfactualReplay } = await import('../src/core/fleet/counterfactual.js');

    const traces = [
      makeTrace({ proposalId: 'ok-1', outcome: 'merged' }),
      makeTrace({ proposalId: 'gone-1', outcome: 'merged' }),
      makeTrace({ proposalId: 'nodiff-1', outcome: 'merged' }),
    ];
    const proposals: Record<string, Proposal | null> = {
      'ok-1': makeAuthenticatedMergedProposal('ok-1'),
      'gone-1': null, // proposal file gone
      'nodiff-1': makeAuthenticatedMergedProposal('nodiff-1', { diff: '   ' }), // empty diff
    };
    const report = await runCounterfactualReplay(CFG, buildOpts({ traces, proposals }));

    expect(report.replayed).toBe(1);
    expect(report.details[0]!.proposalId).toBe('ok-1');
    expect(report.notes.join(' ')).toMatch(/skipped/i);
  });

  it('returns an empty report when outcomes exist but no diffs are recoverable', async () => {
    const { runCounterfactualReplay } = await import('../src/core/fleet/counterfactual.js');
    const report = await runCounterfactualReplay(CFG, buildOpts({
      traces: [makeTrace({ proposalId: 'x', outcome: 'merged' })],
      proposals: { x: null },
    }));
    expect(report.replayed).toBe(0);
    expect(report.notes.join(' ')).toMatch(/unrecoverable/i);
  });
});

// ---------------------------------------------------------------------------
// 8. Never-throws
// ---------------------------------------------------------------------------

describe('m187 — never throws', () => {
  it('returns an empty report when no frontier judge is available', async () => {
    const { runCounterfactualReplay } = await import('../src/core/fleet/counterfactual.js');
    const report = await runCounterfactualReplay(CFG, buildOpts({
      traces: [makeTrace({ outcome: 'merged' })],
      judgeClient: null,
    }));
    expect(report.replayed).toBe(0);
    expect(report.notes.join(' ')).toMatch(/no frontier judge/i);
  });

  it('does not throw when the judge fn throws on every proposal', async () => {
    const { runCounterfactualReplay } = await import('../src/core/fleet/counterfactual.js');
    const opts = buildOpts({ traces: [makeTrace({ outcome: 'merged' })] });
    opts._judgeProposalFn = async () => {
      throw new Error('boom');
    };

    let report!: Awaited<ReturnType<typeof runCounterfactualReplay>>;
    await expect(
      (async () => {
        report = await runCounterfactualReplay(CFG, opts);
      })(),
    ).resolves.toBeUndefined();
    // All proposals failed → nothing replayed, but no throw.
    expect(report.replayed).toBe(0);
  });

  it('does not throw on a completely empty trace store', async () => {
    const { runCounterfactualReplay } = await import('../src/core/fleet/counterfactual.js');
    const report = await runCounterfactualReplay(CFG, buildOpts({ traces: [] }));
    expect(report.replayed).toBe(0);
  });
});
