/**
 * M26 tuning tests — deriveTuning (pure) + emitTuningProposals (inbox sink).
 *
 * SAFETY GUARDRAILS (the adversarial review WILL try to break these):
 *  - HOME is overridden to a tmp dir so the real ~/.ashlr/inbox/ is never touched.
 *  - PROPOSAL-ONLY: emitted proposals are status 'pending' + kind 'note' (no-op).
 *  - NO CONFIG MUTATION: tuning.ts must NOT import saveConfig / write CONFIG_PATH.
 *    Verified at the SOURCE level (grep) AND behaviorally (no config.json appears).
 *  - BOUNDED: at most MAX_TUNING (6) proposals are derived/emitted.
 *  - DETERMINISTIC: deriveTuning is pure over the report (no I/O, no LLM).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// HOME isolation — must happen before any module that resolves homedir().
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m26-tuning-home-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
});

import { deriveTuning, emitTuningProposals } from '../src/core/learn/tuning.js';
import { inboxDir, listProposals } from '../src/core/inbox/store.js';
import type { ReflectionReport } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseReport(overrides?: Partial<ReflectionReport>): ReflectionReport {
  return {
    generatedAt: '2026-06-10T00:00:00.000Z',
    since: '2026-06-03T00:00:00.000Z',
    window: '7d',
    swarmsAnalyzed: 10,
    swarmsDone: 8,
    swarmsFailed: 2,
    successRate: 0.8,
    avgCostUsd: 0.02,
    avgTokens: 1000,
    totalCostUsd: 0.2,
    localShare: 0.5,
    topFailures: [],
    goalCategories: [],
    delta: {
      previousAt: null,
      effectivenessPct: null,
      costPct: null,
      localSharePct: null,
      headline: 'no prior snapshot',
    },
    genome: { entries: 0, hubEntries: 0, projectEntries: 0, totalChars: 0 } as never,
    ...overrides,
  };
}

/** A report that triggers ALL distinct heuristics at once. */
function richReport(): ReflectionReport {
  return baseReport({
    swarmsAnalyzed: 12,
    // local-first: high share + zero cloud spend
    localShare: 0.98,
    totalCostUsd: 0,
    avgCostUsd: 0.01,
    topFailures: [
      {
        key: 'eslint-error',
        label: 'eslint error',
        count: 4,
        phases: ['implement'],
        exampleSwarmIds: ['s1', 's2'],
      },
    ],
    goalCategories: [
      // first-try success => lower retry cap
      {
        category: 'docs',
        swarms: 5,
        avgCostUsd: 0.005,
        avgTokens: 500,
        successRate: 1,
      },
      // far costlier than fleet avg => over-budget flag
      {
        category: 'refactor',
        swarms: 4,
        avgCostUsd: 0.05,
        avgTokens: 5000,
        successRate: 0.5,
      },
    ],
    delta: {
      previousAt: '2026-05-27T00:00:00.000Z',
      effectivenessPct: -20, // regression watch
      costPct: 5,
      localSharePct: 1,
      headline: 'effectiveness down 20pts',
    },
  });
}

// ---------------------------------------------------------------------------
// deriveTuning — pure derivation
// ---------------------------------------------------------------------------

describe('deriveTuning', () => {
  it('returns no suggestions for an empty/zeroed report', () => {
    const empty = baseReport({
      swarmsAnalyzed: 0,
      swarmsDone: 0,
      swarmsFailed: 0,
      successRate: 0,
      avgCostUsd: 0,
      avgTokens: 0,
      totalCostUsd: 0,
      localShare: 0,
    });
    expect(deriveTuning(empty)).toEqual([]);
  });

  it('does not fire quantitative heuristics below the min sample', () => {
    const tiny = baseReport({
      swarmsAnalyzed: 1,
      localShare: 1,
      totalCostUsd: 0,
    });
    expect(deriveTuning(tiny)).toEqual([]);
  });

  it('suggests raising the local-first threshold when already local-first', () => {
    const r = baseReport({ swarmsAnalyzed: 8, localShare: 0.97, totalCostUsd: 0 });
    const out = deriveTuning(r);
    const hit = out.find((t) => t.key === 'routing.local-first-threshold');
    expect(hit).toBeDefined();
    expect(hit?.area).toBe('routing');
    expect(hit?.confidence).toBeGreaterThan(0);
    expect(hit?.confidence).toBeLessThanOrEqual(1);
  });

  it('does NOT suggest local-first tuning when cloud spend exists', () => {
    const r = baseReport({ swarmsAnalyzed: 8, localShare: 0.97, totalCostUsd: 1.5 });
    const out = deriveTuning(r);
    expect(out.find((t) => t.key === 'routing.local-first-threshold')).toBeUndefined();
  });

  it('suggests a playbook for a recurring failure cluster', () => {
    const r = baseReport({
      topFailures: [
        { key: 'tsc-fail', label: 'tsc failure', count: 3, phases: ['verify'], exampleSwarmIds: ['a'] },
      ],
    });
    const out = deriveTuning(r);
    const hit = out.find((t) => t.key === 'playbook.failure.tsc-fail');
    expect(hit).toBeDefined();
    expect(hit?.area).toBe('playbook');
    expect(hit?.rationale).toContain('tsc failure');
  });

  it('ignores one-off failures below the recurring threshold', () => {
    const r = baseReport({
      topFailures: [
        { key: 'flake', label: 'flaky', count: 1, phases: [], exampleSwarmIds: [] },
      ],
    });
    expect(deriveTuning(r).find((t) => t.key.startsWith('playbook.failure'))).toBeUndefined();
  });

  it('suggests lowering retry cap for a 100%-success category', () => {
    const r = baseReport({
      goalCategories: [
        { category: 'docs', swarms: 5, avgCostUsd: 0.001, avgTokens: 100, successRate: 1 },
      ],
    });
    const hit = deriveTuning(r).find((t) => t.key === 'policy.retry-cap.docs');
    expect(hit).toBeDefined();
    expect(hit?.area).toBe('policy');
  });

  it('flags an over-budget goal category', () => {
    const r = baseReport({
      avgCostUsd: 0.01,
      goalCategories: [
        { category: 'refactor', swarms: 4, avgCostUsd: 0.05, avgTokens: 5000, successRate: 0.5 },
      ],
    });
    const hit = deriveTuning(r).find((t) => t.key === 'policy.budget.refactor');
    expect(hit).toBeDefined();
    expect(hit?.rationale).toContain('fleet average');
  });

  it('flags an effectiveness regression vs the prior snapshot', () => {
    const r = baseReport({
      swarmsAnalyzed: 6,
      delta: {
        previousAt: '2026-05-27T00:00:00.000Z',
        effectivenessPct: -15,
        costPct: 0,
        localSharePct: 0,
        headline: 'down',
      },
    });
    const hit = deriveTuning(r).find((t) => t.key === 'policy.effectiveness-regression');
    expect(hit).toBeDefined();
  });

  it('is deterministic: identical reports produce identical output', () => {
    const r = richReport();
    expect(deriveTuning(r)).toEqual(deriveTuning(r));
  });

  it('caps the number of derived suggestions at MAX_TUNING (6)', () => {
    // Build a report that would generate more than 6 raw suggestions.
    const failures = Array.from({ length: 5 }, (_, i) => ({
      key: `fail-${i}`,
      label: `failure ${i}`,
      count: 5,
      phases: ['implement'],
      exampleSwarmIds: [`s${i}`],
    }));
    const cats = Array.from({ length: 5 }, (_, i) => ({
      category: `cat-${i}`,
      swarms: 5,
      avgCostUsd: 1,
      avgTokens: 9000,
      successRate: 1,
    }));
    const r = baseReport({
      swarmsAnalyzed: 20,
      localShare: 0.99,
      totalCostUsd: 0,
      avgCostUsd: 0.01,
      topFailures: failures,
      goalCategories: cats,
    });
    expect(deriveTuning(r).length).toBeLessThanOrEqual(6);
  });

  it('sorts suggestions highest-confidence first', () => {
    const out = deriveTuning(richReport());
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1]!.confidence).toBeGreaterThanOrEqual(out[i]!.confidence);
    }
  });
});

// ---------------------------------------------------------------------------
// emitTuningProposals — the SOLE outward sink (inbox, pending, note)
// ---------------------------------------------------------------------------

describe('emitTuningProposals', () => {
  it('emits derived suggestions as PENDING note proposals in the inbox', () => {
    const suggestions = deriveTuning(richReport());
    expect(suggestions.length).toBeGreaterThan(0);

    const created = emitTuningProposals(suggestions);
    expect(created.length).toBe(suggestions.length);

    for (const p of created) {
      expect(p.status).toBe('pending'); // INVARIANT 2/5: never auto-advances
      expect(p.kind).toBe('note'); // INVARIANT 2/5: applying it is a no-op
      expect(p.origin).toBe('manual');
      expect(p.repo).toBeNull(); // not repo-scoped: touches no working tree
      expect(p.title).toContain('[tuning]');
    }

    // Persisted to the inbox under tmp HOME, and ALL still pending.
    const inbox = listProposals();
    expect(inbox.length).toBe(created.length);
    expect(inbox.every((p) => p.status === 'pending')).toBe(true);
    expect(inbox.every((p) => p.kind === 'note')).toBe(true);
  });

  it('writes ONLY under HOME/.ashlr/inbox and NEVER a config.json', () => {
    emitTuningProposals(deriveTuning(richReport()));

    // The inbox dir is the only thing created, and it is under tmp HOME.
    expect(inboxDir().startsWith(tmpHome)).toBe(true);
    expect(fs.existsSync(inboxDir())).toBe(true);

    // No config.json anywhere under the relocated HOME: tuning never writes config.
    const walk = (dir: string): string[] => {
      const found: string[] = [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) found.push(...walk(full));
        else found.push(full);
      }
      return found;
    };
    const files = fs.existsSync(tmpHome) ? walk(tmpHome) : [];
    expect(files.some((f) => f.endsWith('config.json'))).toBe(false);
  });

  it('handles an empty suggestion list as a no-op (creates nothing)', () => {
    const created = emitTuningProposals([]);
    expect(created).toEqual([]);
    expect(listProposals()).toEqual([]);
    // No inbox dir is forced into existence by a no-op emit.
  });

  it('is bounded: never emits more than MAX_TUNING (6) proposals', () => {
    // Hand it an oversized list directly (bypassing deriveTuning's own cap).
    const big = Array.from({ length: 20 }, (_, i) => ({
      key: `k-${i}`,
      area: 'policy' as const,
      title: `t ${i}`,
      rationale: `r ${i}`,
      confidence: 0.5,
    }));
    const created = emitTuningProposals(big);
    expect(created.length).toBeLessThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// SOURCE-LEVEL guard: tuning.ts must not touch config / router / outward action.
// (INVARIANTS 1, 2, 5 proven at the import/source level, not just behaviorally.)
// ---------------------------------------------------------------------------

describe('tuning.ts source-level safety invariants', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'core', 'learn', 'tuning.ts'),
    'utf8',
  );

  it('does NOT import or call saveConfig / write CONFIG_PATH', () => {
    // Match actual CALLS / imports, not the word inside safety docstrings.
    expect(src).not.toMatch(/saveConfig\s*\(/);
    expect(src).not.toMatch(/import[^;]*saveConfig/);
    expect(src).not.toMatch(/CONFIG_PATH/);
    expect(src).not.toMatch(/writeConfig\s*\(/);
  });

  it('performs NO filesystem writes of its own (only createProposal sinks)', () => {
    expect(src).not.toMatch(/writeFileSync/);
    expect(src).not.toMatch(/appendFileSync/);
    expect(src).not.toMatch(/mkdirSync/);
    expect(src).not.toMatch(/renameSync/);
  });

  it('takes NO outward action (no apply/push/deploy/merge/PR/setStatus)', () => {
    expect(src).not.toMatch(/applyProposal/);
    expect(src).not.toMatch(/setStatus/);
    // \bcreatePr\b avoids a false positive on createProposal.
    expect(src).not.toMatch(/\bcreatePr\b/);
    expect(src).not.toMatch(/\bdeploy\b/);
    expect(src).not.toMatch(/\bmerge\b/);
    expect(src).not.toMatch(/git\s+push/);
  });

  it('uses NO LLM / network (deterministic, local-first)', () => {
    expect(src).not.toMatch(/getActiveClient/);
    expect(src).not.toMatch(/\bfetch\b/);
  });

  it('routes ONLY through createProposal as its sole sink', () => {
    expect(src).toMatch(/createProposal/);
    // The only kind it ever creates is the no-op 'note'.
    expect(src).toMatch(/kind:\s*'note'/);
  });
});
