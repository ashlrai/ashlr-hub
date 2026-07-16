/**
 * m323.model-granular-routing.test.ts — M323: cost-aware model-granular routing.
 *
 * Covers:
 *  - buildProducerScores joins judged verdicts to 'proposed' producers by
 *    proposalId (judge-model identity never becomes a key) with canonical
 *    spelling collapse;
 *  - selectCostAwareModel: cheapest-clearing-the-bar, never-into-a-bad-model
 *    floor, thin-sample null;
 *  - routeTask integration: flag on steers AWAY from a bad-ship-rate default
 *    (sonnet-5) to the model that ships (opus); flag off / cold start are
 *    byte-identical to the static M321 decisions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — hoisted before module imports
// ---------------------------------------------------------------------------

vi.mock('../src/core/run/engines.js', () => ({
  engineInstalled: vi.fn(() => true),
  engineTierOf: (engine: string) =>
    engine === 'claude' || engine === 'codex' ? 'frontier'
      : engine === 'local-coder' || engine === 'nim' ? 'mid' : 'local',
}));

vi.mock('../src/core/run/sandboxed-engine.js', () => ({
  engineTierOf: (engine: string) =>
    engine === 'claude' || engine === 'codex' ? 'frontier'
      : engine === 'local-coder' || engine === 'nim' ? 'mid' : 'local',
}));

vi.mock('../src/core/fleet/quota.js', () => ({
  withinLimit: vi.fn(() => true),
  evalQuota: vi.fn(() => 'ok'),
  recordUse: vi.fn(),
}));

vi.mock('../src/core/fleet/subscription-usage.js', () => ({
  subscriptionAllows: vi.fn(() => ({ allowed: true, reason: 'mock' })),
  isSubscriptionEngine: vi.fn((e: string) => e === 'claude' || e === 'codex'),
  subscriptionUsage: vi.fn(() => null),
}));

// Ledger fixture — swapped per test via `fixture`.
let fixture: Record<string, unknown>[] = [];
const bareMergedIds = new Set<string>();
const proposalAuthorities = new Map<string, {
  engineModel: string;
  workSource: string;
  provenanceValid?: boolean;
}>();

vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  readDecisions: vi.fn((opts?: { sinceMs?: number }) => {
    const since = opts?.sinceMs ?? 0;
    return fixture.filter((d) => Date.parse(String(d['ts'])) >= since);
  }),
  recordDecision: vi.fn(() => {}),
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

vi.mock('../src/core/inbox/store.js', () => {
  const proposals = () => {
    const realized = fixture.reduce((times, entry) => {
    const id = String(entry['proposalId']);
    if (entry['action'] === 'merged' && !bareMergedIds.has(id)) {
      times.set(id, String(entry['ts']));
    }
    return times;
    }, new Map<string, string>());
    const producers = new Map(fixture
      .filter((entry) => entry['action'] === 'proposed' && typeof entry['engine'] === 'string')
      .map((entry) => [String(entry['proposalId']), entry] as const));
    return [...producers].map(([id, producer]) => {
    const observedAt = realized.get(id);
    const engine = String(producer?.['engine'] ?? 'unknown');
    const model = String(producer?.['model'] ?? '');
    const authority = proposalAuthorities.get(id);
    return ({
    id,
    repo: '/mock/repo',
    origin: 'backlog',
    kind: 'patch',
    title: id,
    summary: 'realized model routing fixture',
    diff: 'diff --git a/a b/a',
    diffHash: 'd'.repeat(64),
    provenanceSig: authority?.provenanceValid === false ? 'invalid-provenance' : 'test-provenance',
    producerProvenanceVersion: 2,
    producerProvenanceSig: 'test-producer-provenance',
    workItemId: `/mock/repo:${String(authority?.workSource ?? producer?.['workSource'] ?? 'unknown')}:${id}`,
    workSource: authority?.workSource ?? producer?.['workSource'],
    engineModel: authority?.engineModel ??
      (model.startsWith(`${engine}:`) ? model : `${engine}:${model}`),
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
  });
  });};
  return {
    listProposals: proposals,
    listProposalsDetailed: () => {
      const rows = proposals();
      return {
        proposals: rows,
        sourceState: rows.length > 0 ? 'healthy' : 'missing',
        sourcePresent: rows.length > 0,
        complete: true,
        stopReasons: [],
        filesDiscovered: rows.length,
        filesRead: rows.length,
        bytesRead: 0,
        invalidFiles: 0,
        unreadableFiles: 0,
      };
    },
  };
});

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------

import type { AshlrConfig, WorkItem, WorkSource } from '../src/core/types.js';
import { routeTask } from '../src/core/run/router.js';
import {
  buildProducerScores,
  selectCostAwareModel,
  LEARNED_ROUTING_MIN_SAMPLES,
} from '../src/core/run/learned-router.js';
import { computeModelRoi } from '../src/core/fleet/quality-metrics.js';
import { KNOWN_MODELS } from '../src/core/run/model-catalog.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const ts = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

/** N proposed+judged chains, with merged evidence for realized positive outcomes. */
function chains(
  idPrefix: string,
  model: string,
  verdicts: string[],
  source = 'issue',
  includeMerged = true,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  verdicts.forEach((verdict, i) => {
    const pid = `${idPrefix}-${i}`;
    // judged (newer) first — readDecisions returns newest-first
    out.push({
      ts: ts(1 + i),
      proposalId: pid,
      action: 'judged',
      // the JUDGE's identity — must never become a producer key
      engine: 'claude-fable-5',
      model: 'claude-fable-5',
      verdict,
    });
    out.push({
      ts: ts(2 + i),
      proposalId: pid,
      action: 'proposed',
      engine: 'claude',
      model,
      workSource: source,
    });
    if (includeMerged && (verdict === 'ship' || verdict === 'approved' || verdict === 'applied')) {
      out.push({
        ts: ts(i),
        proposalId: pid,
        action: 'merged',
        verdict: 'applied',
        labelBasis: 'post-merge-credit-release-v1',
      });
    }
  });
  return out;
}

/** N fresh chains, with merged evidence for realized positive outcomes. */
function freshChains(
  idPrefix: string,
  model: string,
  verdicts: string[],
  tsMs: number,
  source = 'issue',
): Record<string, unknown>[] {
  const stamp = new Date(tsMs).toISOString();
  const out: Record<string, unknown>[] = [];
  verdicts.forEach((verdict, i) => {
    const pid = `${idPrefix}-${i}`;
    out.push({
      ts: stamp,
      proposalId: pid,
      action: 'judged',
      engine: 'claude-fable-5',
      model: 'claude-fable-5',
      verdict,
    });
    out.push({
      ts: stamp,
      proposalId: pid,
      action: 'proposed',
      engine: 'claude',
      model,
      workSource: source,
    });
    if (verdict === 'ship' || verdict === 'approved' || verdict === 'applied') {
      out.push({
        ts: stamp,
        proposalId: pid,
        action: 'merged',
        verdict: 'applied',
        labelBasis: 'post-merge-credit-release-v1',
      });
    }
  });
  return out;
}

/** sonnet-5 ships badly (1/6), opus ships perfectly (6/6). */
const SONNET_BAD_OPUS_GOOD = [
  ...chains('s5', 'claude:claude-sonnet-5', ['ship', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected']),
  ...chains('op', 'claude:claude-opus-4-8', ['ship', 'ship', 'ship', 'ship', 'ship', 'ship']),
];

/** sonnet-5 ships well (5/6) — cheapest clearing the bar. */
const SONNET_GOOD = [
  ...chains('s5', 'claude:claude-sonnet-5', ['ship', 'ship', 'ship', 'ship', 'ship', 'rejected']),
  ...chains('op', 'claude:claude-opus-4-8', ['ship', 'ship', 'ship', 'ship', 'ship', 'ship']),
];

/** Too few samples on every model. */
const THIN = [
  ...chains('s5', 'claude:claude-sonnet-5', ['ship', 'rejected']),
  ...chains('op', 'claude:claude-opus-4-8', ['ship', 'ship']),
];

function baseConfig(): AshlrConfig {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: { name: 'vscode' },
    models: { providerChain: ['ollama'], routing: [] },
  } as unknown as AshlrConfig;
}

function cfgWith(extra?: Partial<NonNullable<AshlrConfig['foundry']>>): AshlrConfig {
  return {
    ...baseConfig(),
    foundry: { allowedBackends: ['claude', 'builtin'] as never[], ...extra },
  } as AshlrConfig;
}

let _seq = 0;
function makeItem(over: Partial<WorkItem> & { source: WorkSource }): WorkItem {
  _seq++;
  return {
    id: `item-${_seq}`,
    repo: '/mock/repo',
    title: 'mock task',
    detail: 'mock detail',
    value: 3,
    effort: 5,
    score: 9,
    tags: [],
    ts: new Date().toISOString(),
    ...over,
  } as WorkItem;
}

const CLAUDE_CTX = { availableEngines: ['claude', 'builtin'] } as never;

beforeEach(() => {
  _seq = 0;
  fixture = [];
  bareMergedIds.clear();
  proposalAuthorities.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// buildProducerScores
// ---------------------------------------------------------------------------

describe('M323 buildProducerScores', () => {
  it('withholds raw v1 positives while attributing negatives to canonical producers', () => {
    fixture = SONNET_GOOD;
    const scores = buildProducerScores('issue', NOW);
    expect(scores.has('claude:sonnet-5')).toBe(true);
    expect(scores.has('claude:opus')).toBe(false);
    // judge identity never becomes a key
    expect(scores.has('claude-fable-5:claude-fable-5')).toBe(false);
    expect(scores.has('claude-fable-5:fable-5')).toBe(false);
    const s5 = scores.get('claude:sonnet-5')!;
    expect(s5.samples).toBeLessThan(LEARNED_ROUTING_MIN_SAMPLES);
    expect(s5.score).toBe(0.5);
  });

  it('does not create task-class scores from raw v1 positives', () => {
    fixture = chains('s5', 'claude:claude-sonnet-5', ['ship', 'ship', 'ship', 'ship', 'ship'], 'lint');
    expect(buildProducerScores('issue', NOW).size).toBe(0);
    expect(buildProducerScores('lint', NOW).size).toBe(0);
  });

  it('cold start → empty map', () => {
    fixture = [];
    expect(buildProducerScores('issue', NOW).size).toBe(0);
  });

  it('ignores future negative judgments', () => {
    const proposalId = 'future-negative';
    fixture = [
      {
        ts: new Date(NOW + HOUR).toISOString(),
        proposalId,
        action: 'judged',
        engine: 'claude-fable-5',
        model: 'claude-fable-5',
        verdict: 'harmful',
      },
      {
        ts: ts(1),
        proposalId,
        action: 'proposed',
        engine: 'claude',
        model: 'claude:claude-sonnet-5',
        workSource: 'issue',
      },
    ];

    expect(buildProducerScores('issue', NOW).size).toBe(0);
  });

  it('does not credit a producer when Gate 7 ships but Gate 8 refuses', () => {
    const count = LEARNED_ROUTING_MIN_SAMPLES + 2;
    fixture = [
      ...chains(
        'gate8-refused',
        'claude:claude-sonnet-5',
        Array.from({ length: count }, () => 'ship'),
        'issue',
        false,
      ),
      ...Array.from({ length: count }, (_, index) => [
        { ts: ts(0.5), proposalId: `gate8-refused-${index}`, action: 'merge-authorized' },
        { ts: ts(0.25), proposalId: `gate8-refused-${index}`, action: 'escalated' },
      ]).flat(),
    ];

    expect(buildProducerScores('issue', NOW).size).toBe(0);
  });

  it('does not credit a producer for a bare historical merged row', () => {
    fixture = chains(
      'bare-merge',
      'claude:claude-sonnet-5',
      Array.from({ length: LEARNED_ROUTING_MIN_SAMPLES + 2 }, () => 'ship'),
    );
    for (const entry of fixture) {
      if (entry['action'] === 'merged') bareMergedIds.add(String(entry['proposalId']));
    }

    expect(buildProducerScores('issue', NOW).size).toBe(0);
  });

  it('does not credit a producer for an old realized-merge label with a current witness', () => {
    const count = LEARNED_ROUTING_MIN_SAMPLES + 2;
    fixture = chains(
      'legacy-merge',
      'claude:claude-sonnet-5',
      Array.from({ length: count }, () => 'ship'),
    ).map((entry) => entry['action'] === 'merged'
      ? { ...entry, labelBasis: 'realized-merge-v1' }
      : entry);

    expect(buildProducerScores('issue', NOW).size).toBe(0);
  });

  it('signed proposal identity cannot upgrade a raw v1 label into credit', () => {
    const count = LEARNED_ROUTING_MIN_SAMPLES + 1;
    fixture = chains(
      'forged-producer',
      'claude:claude-sonnet-5',
      Array.from({ length: count }, () => 'ship'),
    );
    for (let index = 0; index < count; index += 1) {
      proposalAuthorities.set(`forged-producer-${index}`, {
        engineModel: 'codex:gpt-5.5',
        workSource: 'issue',
      });
    }

    const scores = buildProducerScores('issue', NOW);
    expect(scores.has('claude:sonnet-5')).toBe(false);
    expect(scores.has('codex:gpt-5.5')).toBe(false);
  });

  it('uses signed proposal identity for negative outcomes despite forged ledger labels', () => {
    const count = LEARNED_ROUTING_MIN_SAMPLES + 1;
    fixture = chains(
      'forged-negative',
      'claude:claude-sonnet-5',
      Array.from({ length: count }, () => 'harmful'),
    );
    for (let index = 0; index < count; index += 1) {
      proposalAuthorities.set(`forged-negative-${index}`, {
        engineModel: 'codex:gpt-5.5',
        workSource: 'issue',
      });
    }

    const scores = buildProducerScores('issue', NOW);
    expect(scores.has('claude:sonnet-5')).toBe(false);
    expect(scores.has('claude-fable-5:fable-5')).toBe(false);
    expect(scores.get('codex:gpt-5.5')?.score).toBe(0);
  });

  it('fails closed for negative outcomes with invalid producer provenance', () => {
    const count = LEARNED_ROUTING_MIN_SAMPLES + 1;
    fixture = chains(
      'invalid-negative',
      'claude:claude-sonnet-5',
      Array.from({ length: count }, () => 'rejected'),
    );
    for (let index = 0; index < count; index += 1) {
      proposalAuthorities.set(`invalid-negative-${index}`, {
        engineModel: 'claude:claude-sonnet-5',
        workSource: 'issue',
        provenanceValid: false,
      });
    }

    expect(buildProducerScores('issue', NOW).size).toBe(0);
  });

  it('does not credit realized proposals with invalid producer provenance', () => {
    const count = LEARNED_ROUTING_MIN_SAMPLES + 1;
    fixture = chains(
      'invalid-provenance',
      'claude:claude-sonnet-5',
      Array.from({ length: count }, () => 'ship'),
    );
    for (let index = 0; index < count; index += 1) {
      proposalAuthorities.set(`invalid-provenance-${index}`, {
        engineModel: 'claude:claude-sonnet-5',
        workSource: 'issue',
        provenanceValid: false,
      });
    }

    expect(buildProducerScores('issue', NOW).size).toBe(0);
  });

  it('does not credit an outcome when different producers claim the same proposal id', () => {
    fixture = [
      { ts: ts(1), proposalId: 'shared', action: 'judged', verdict: 'ship' },
      { ts: ts(2), proposalId: 'shared', action: 'proposed', engine: 'codex', model: 'codex:gpt-5.3-codex' },
      {
        ts: ts(3),
        proposalId: 'shared',
        action: 'proposed',
        engine: 'claude',
        model: 'claude:claude-sonnet-5',
        workSource: 'lint',
      },
    ];

    expect(buildProducerScores('issue', NOW).size).toBe(0);
  });

  it(`withholds exactly ${LEARNED_ROUTING_MIN_SAMPLES} fresh raw v1 producer samples`, () => {
    const fixedNow = 1_700_000_000_000;
    fixture = freshChains(
      'op-fresh',
      'claude:claude-opus-4-8',
      Array.from({ length: LEARNED_ROUTING_MIN_SAMPLES }, () => 'ship'),
      fixedNow,
    );
    const scores = buildProducerScores('issue', fixedNow + 1);
    expect(scores.has('claude:opus')).toBe(false);
  });
});

describe('M323 realized model ROI', () => {
  it('deduplicates judge retries while raw v1 merges lose to adverse truth', () => {
    const proposalId = 'roi-realized';
    fixture = [
      {
        ts: ts(4), proposalId, action: 'proposed', engine: 'claude',
        model: 'claude:claude-sonnet-5', costUsd: 2,
      },
      {
        ts: ts(3), proposalId, action: 'judged', engine: 'claude-fable-5',
        model: 'claude-fable-5', verdict: 'noise', costUsd: 1,
      },
      {
        ts: ts(2), proposalId, action: 'judged', engine: 'claude-fable-5',
        model: 'claude-fable-5', verdict: 'ship', costUsd: 0.5,
      },
      {
        ts: ts(1.5),
        proposalId,
        action: 'merged',
        verdict: 'applied',
        labelBasis: 'post-merge-credit-release-v1',
      },
      {
        ts: ts(1),
        proposalId,
        action: 'merged',
        verdict: 'applied',
        labelBasis: 'post-merge-credit-release-v1',
      },
      { ts: ts(2.5), proposalId, action: 'rejected', verdict: 'rejected' },
    ];

    const roi = computeModelRoi('all')['claude:sonnet-5'];
    expect(roi).toMatchObject({
      dispatches: 1,
      judged: 1,
      shipVerdicts: 1,
      shipRate: 1,
      merged: 0,
      rejected: 1,
      judgeCostUsd: 0.5,
      costPerMergedUsd: null,
    });
  });

  it('rejects bare merged ROI history and keeps the newest rejection', () => {
    const proposalId = 'roi-bare-merge';
    fixture = [
      {
        ts: ts(3), proposalId, action: 'proposed', engine: 'codex',
        model: 'codex:gpt-5.5', costUsd: 2,
      },
      { ts: ts(2), proposalId, action: 'merged', verdict: 'applied' },
      { ts: ts(1), proposalId, action: 'rejected', verdict: 'rejected' },
    ];
    bareMergedIds.add(proposalId);

    expect(computeModelRoi('all')['codex:gpt-5.5']).toMatchObject({
      merged: 0,
      rejected: 1,
      costPerMergedUsd: null,
    });
  });

  it('does not let old realized-merge labels bias ROI over a rejection', () => {
    const proposalId = 'roi-old-realized-label';
    fixture = [
      {
        ts: ts(4), proposalId, action: 'proposed', engine: 'claude',
        model: 'claude:claude-sonnet-5', costUsd: 2,
      },
      {
        ts: ts(3), proposalId, action: 'judged', engine: 'claude-fable-5',
        model: 'claude-fable-5', verdict: 'ship', costUsd: 0.5,
      },
      {
        ts: ts(2), proposalId, action: 'merged', verdict: 'applied',
        labelBasis: 'realized-merge-v1',
      },
      {
        ts: ts(1.5), proposalId, action: 'merged', verdict: 'applied',
        labelBasis: 'realized-merge-v1',
      },
      { ts: ts(1), proposalId, action: 'rejected', verdict: 'rejected' },
    ];

    expect(computeModelRoi('all')['claude:sonnet-5']).toMatchObject({
      dispatches: 1,
      judged: 1,
      shipVerdicts: 1,
      merged: 0,
      rejected: 1,
      costPerMergedUsd: null,
    });
  });
});

// ---------------------------------------------------------------------------
// selectCostAwareModel
// ---------------------------------------------------------------------------

describe('M323 selectCostAwareModel', () => {
  const claudeLarge = KNOWN_MODELS.filter(
    (m) => m.engine === 'claude' && m.tier === 'large' && m.id !== 'claude:fable-5',
  );

  it('returns no learned candidate from raw v1 positive history', () => {
    fixture = SONNET_GOOD;
    const scores = buildProducerScores('issue', NOW);
    const pick = selectCostAwareModel(claudeLarge, scores, { minShipRate: 0.6 });
    expect(pick).toBeNull();
  });

  it('a lower or higher bar cannot authorize raw v1 positives', () => {
    fixture = SONNET_GOOD; // s5 ≈ 0.83, opus = 1.0
    const scores = buildProducerScores('issue', NOW);
    const pick = selectCostAwareModel(claudeLarge, scores, { minShipRate: 0.9 });
    expect(pick).toBeNull();
  });

  it('never learns INTO a bad model: all sampled < 0.5 → null', () => {
    // M338 (review fix): 8 verdicts so the recency-weighted sample count
    // clears LEARNED_ROUTING_MIN_SAMPLES — 5 verdicts at ages 1–5h decay to
    // ~4.94 weighted samples, which silently exercised the THIN-SAMPLE path
    // instead of the <0.5 floor this test exists to pin.
    fixture = chains('s5', 'claude:claude-sonnet-5', [
      'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'ship',
    ]);
    const scores = buildProducerScores('issue', NOW);
    const s5 = scores.get('claude:sonnet-5')!;
    expect(s5.samples).toBeGreaterThanOrEqual(LEARNED_ROUTING_MIN_SAMPLES); // floor path, not thin-sample
    expect(s5.score).toBeLessThan(0.5);
    const onlySonnet = KNOWN_MODELS.filter((m) => m.id === 'claude:sonnet-5');
    expect(selectCostAwareModel(onlySonnet, scores, { minShipRate: 0.6 })).toBeNull();
  });

  it('thin samples → null (static fallback)', () => {
    fixture = THIN;
    const scores = buildProducerScores('issue', NOW);
    expect(selectCostAwareModel(claudeLarge, scores, { minShipRate: 0.6 })).toBeNull();
  });

  it(`withholds ${LEARNED_ROUTING_MIN_SAMPLES - 1} fresh raw v1 producer samples`, () => {
    const fixedNow = 1_700_000_000_000;
    fixture = freshChains(
      'op-thin',
      'claude:claude-opus-4-8',
      Array.from({ length: LEARNED_ROUTING_MIN_SAMPLES - 1 }, () => 'ship'),
      fixedNow,
    );
    const scores = buildProducerScores('issue', fixedNow + 1);
    expect(scores.has('claude:opus')).toBe(false);
    expect(selectCostAwareModel(claudeLarge, scores, { minShipRate: 0.6 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// routeTask integration
// ---------------------------------------------------------------------------

describe('M323 routeTask integration', () => {
  const flagOn = { modelGranularRouting: { enabled: true } };

  it('does not steer into an uncredited raw v1 alternative', () => {
    fixture = SONNET_BAD_OPUS_GOOD;
    const item = makeItem({ source: 'issue' });
    const result = routeTask(item, cfgWith(flagOn), CLAUDE_CTX);
    expect(result.engine).toBe('claude');
    expect(result.catalogEntry?.id).toBe('claude:sonnet-5');
    expect(result.reason).not.toContain('M323 learned');
  });

  it('raw v1 positive history preserves the static sonnet pick', () => {
    fixture = SONNET_GOOD;
    const item = makeItem({ source: 'issue' });
    const result = routeTask(item, cfgWith(flagOn), CLAUDE_CTX);
    expect(result.model).toBe('claude-sonnet-5');
    expect(result.reason).not.toContain('M323 learned');
  });

  it('flag OFF: static M321 decision even with a bad-ship-rate ledger', () => {
    fixture = SONNET_BAD_OPUS_GOOD;
    const item = makeItem({ source: 'issue' });
    const result = routeTask(item, cfgWith(), CLAUDE_CTX);
    expect(result.model).toBe('claude-sonnet-5'); // static workhorse pick
    expect(result.reason).not.toContain('M323');
  });

  it('flag ON + cold start: byte-identical static decision', () => {
    fixture = [];
    const item = makeItem({ source: 'issue' });
    const on = routeTask(item, cfgWith(flagOn), CLAUDE_CTX);
    const off = routeTask(item, cfgWith(), CLAUDE_CTX);
    expect(on.engine).toBe(off.engine);
    expect(on.model).toBe(off.model);
    expect(on.reason).toBe(off.reason);
  });

  it('flag ON + thin samples: static decision preserved', () => {
    fixture = THIN;
    const item = makeItem({ source: 'issue' });
    const result = routeTask(item, cfgWith(flagOn), CLAUDE_CTX);
    expect(result.model).toBe('claude-sonnet-5');
    expect(result.reason).not.toContain('M323');
  });

  it(`flag ON + exactly ${LEARNED_ROUTING_MIN_SAMPLES} raw v1 positives preserves static routing`, () => {
    const fixedNow = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixedNow));
    fixture = freshChains(
      'op-route',
      'claude:claude-opus-4-8',
      Array.from({ length: LEARNED_ROUTING_MIN_SAMPLES }, () => 'ship'),
      fixedNow,
    );
    vi.setSystemTime(new Date(fixedNow + 1));

    const item = makeItem({ source: 'issue' });
    const result = routeTask(item, cfgWith(flagOn), CLAUDE_CTX);
    expect(result.catalogEntry?.id).toBe('claude:sonnet-5');
    expect(result.reason).not.toContain('M323 learned');
  });

  it(`flag ON + ${LEARNED_ROUTING_MIN_SAMPLES - 1} fresh producer samples preserves the static model`, () => {
    const fixedNow = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixedNow));
    fixture = freshChains(
      'op-route-thin',
      'claude:claude-opus-4-8',
      Array.from({ length: LEARNED_ROUTING_MIN_SAMPLES - 1 }, () => 'ship'),
      fixedNow,
    );
    vi.setSystemTime(new Date(fixedNow + 1));

    const item = makeItem({ source: 'issue' });
    const result = routeTask(item, cfgWith(flagOn), CLAUDE_CTX);
    expect(result.model).toBe('claude-sonnet-5');
    expect(result.reason).not.toContain('M323');
  });

  it('cfg.foundry.models override still beats the learned pick', () => {
    fixture = SONNET_BAD_OPUS_GOOD;
    const item = makeItem({ source: 'issue' });
    const result = routeTask(
      item,
      cfgWith({ ...flagOn, models: { claude: 'opus' } as never }),
      CLAUDE_CTX,
    );
    expect(result.model).toBe('opus');
    expect(result.reason).toContain('cfg override');
  });
});
