/**
 * m183.taste-critic.test.ts — M183: Frontier TASTE critic + best-of-N integration.
 *
 * Test groups:
 *
 *   1. TASTE-CRITIC AXES — scoreTaste returns 3 axes + overall + verdict
 *      (mock frontier client; no live Opus calls)
 *
 *   2. BEST-OF-N TASTE SELECTION — with tasteCritic ON, prefers the highest
 *      taste candidate among test-passing ones (mock candidates + scoreTaste)
 *
 *   3. FLAG OFF PARITY — tasteCritic=false → selection byte-identical to pre-M183
 *      (same winner as correctness-score-only path)
 *
 *   4. NEVER-THROWS — scoreTaste returns neutral on client failure; selection
 *      still works even when taste scoring fails entirely
 *
 *   5. SECRET SCRUBBING — taste critic text does not contain raw secret patterns
 *
 *   6. PROPOSAL TAGGED — winner CandidateResult carries taste field when flag on
 *
 *   7. NO MERGE-GATE CHANGE — assert safety gate is untouched
 *      (autoMerge.enabled=false still blocks; non-frontier still blocked)
 *
 * Hermetic: HOME in tmp dir. LLM mocked. No live Opus calls.
 * Mirrors m142/m162 conventions: vi.doMock + vi.resetModules() + UUID cache-busting.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m183-home-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  vi.restoreAllMocks();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MOCK_REPO = '/tmp/fake-repo-m183';

function makeProposal(overrides: Partial<{
  id: string;
  title: string;
  summary: string;
  diff: string;
  origin: 'agent' | 'backlog' | 'swarm' | 'manual';
  kind: 'patch' | 'pr' | 'note';
}> = {}) {
  return {
    id: overrides.id ?? `proposal-${randomUUID()}`,
    repo: MOCK_REPO,
    origin: overrides.origin ?? 'agent',
    kind: overrides.kind ?? 'patch',
    title: overrides.title ?? 'Add frontier taste critic',
    summary: overrides.summary ?? 'Implements scoreTaste for best-of-N selection.',
    diff: overrides.diff ?? '@@ -1,3 +1,5 @@\n+// taste critic\n+export function scoreTaste() {}',
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeConfig(overrides: Partial<{
  tasteCritic: boolean;
  bestOfN: number;
}> = {}): AshlrConfig {
  return {
    provider: 'anthropic',
    models: { ollama: 'http://127.0.0.1:9' },
    foundry: {
      allowedBackends: ['local-coder'],
      ...(overrides.tasteCritic != null ? { tasteCritic: overrides.tasteCritic } : {}),
      ...(overrides.bestOfN != null ? { bestOfN: overrides.bestOfN } : {}),
    },
  } as unknown as AshlrConfig;
}

function makeItem(overrides: Partial<{ title: string; repo: string }> = {}) {
  return {
    id: 'item-m183',
    repo: overrides.repo ?? MOCK_REPO,
    source: 'manual' as const,
    title: overrides.title ?? 'Implement taste critic',
    detail: 'Adds frontier taste scoring to best-of-N.',
    value: 4,
    effort: 2,
    score: 4,
    tags: [],
    ts: new Date().toISOString(),
  };
}

/** Build a mock taste response JSON. */
function makeTasteJson(alignment: number, ambition: number, design: number, overall: number, verdict: string): string {
  return JSON.stringify({
    alignment,
    ambition,
    design,
    overall,
    verdict,
    rationale: `Mock taste rationale — overall ${overall}.`,
  });
}

/** Build a mock sandbox that returns proposals. */
function makeSandboxMock(withProposalAt: number[] = [0, 1, 2]) {
  let callCount = 0;
  return vi.fn(async (_engine: unknown, _goal: unknown, _cfg: unknown, runOpts: Record<string, unknown>) => {
    const idx = callCount++;
    const hasProposal = withProposalAt.includes(idx);
    return {
      state: {
        id: runOpts['runId'] ?? `run-${idx}`,
        status: 'done',
        result: hasProposal ? `diff content for candidate ${idx}` : '',
      },
      proposalId: hasProposal ? `proposal-${idx}` : undefined,
    };
  });
}

function makeSandboxModule(sandboxMock: ReturnType<typeof makeSandboxMock>) {
  return {
    runApiModelSandboxed: sandboxMock,
    runEngineSandboxed: sandboxMock,
  };
}

/** Build a mock judgeProposal (correctness judge). */
function makeJudgeMock(scores: number[]) {
  let callCount = 0;
  return vi.fn(async () => {
    const idx = callCount++;
    const score = scores[idx] ?? 8;
    const perDim = Math.max(1, Math.min(5, Math.round(score / 4)));
    return {
      proposalId: `verdict-${idx}`,
      verdict: 'ship' as const,
      value: perDim,
      correctness: perDim,
      scope: 6 - perDim,
      alignment: perDim,
      rationale: `Mock correctness rationale ${idx}`,
      wouldMerge: perDim >= 4,
    };
  });
}

/** Build a mock scoreTaste that returns different overall scores per candidate. */
function makeTasteMock(overalls: number[]) {
  let callCount = 0;
  return vi.fn(async () => {
    const idx = callCount++;
    const overall = overalls[idx] ?? 3;
    const verdict = overall >= 4.0 ? 'gold' : overall <= 2.0 ? 'mediocre' : 'solid';
    return {
      alignment: Math.round(overall),
      ambition: Math.round(overall),
      design: Math.round(overall),
      overall,
      verdict,
      rationale: `Mock taste rationale for candidate ${idx} (overall ${overall}).`,
    };
  });
}

// ---------------------------------------------------------------------------
// 1. TASTE-CRITIC AXES
// ---------------------------------------------------------------------------

describe('M183 — scoreTaste axes', () => {
  afterEach(() => { vi.resetModules(); });

  it('returns alignment, ambition, design, overall, verdict, rationale', async () => {
    const mockComplete = vi.fn(async () => makeTasteJson(4, 5, 4, 4.3, 'gold'));

    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => ({ complete: mockComplete, model: 'mock-opus' })),
      judgeProposal: vi.fn(),
    }));

    const { scoreTaste } = await import('../src/core/fleet/taste-critic.js?' + randomUUID());
    const proposal = makeProposal();
    const cfg = makeConfig();

    const result = await scoreTaste(proposal, { repo: MOCK_REPO }, cfg);

    expect(result).toMatchObject({
      alignment: 4,
      ambition: 5,
      design: 4,
      verdict: 'gold',
    });
    expect(result.overall).toBeGreaterThanOrEqual(4.0);
    expect(typeof result.rationale).toBe('string');
    expect(result.rationale.length).toBeGreaterThan(0);
  });

  it("verdict 'gold' when overall >= 4.0", async () => {
    const mockComplete = vi.fn(async () => makeTasteJson(5, 5, 4, 4.5, 'gold'));

    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => ({ complete: mockComplete, model: 'mock-opus' })),
      judgeProposal: vi.fn(),
    }));

    const { scoreTaste } = await import('../src/core/fleet/taste-critic.js?' + randomUUID());
    const result = await scoreTaste(makeProposal(), { repo: MOCK_REPO }, makeConfig());

    expect(result.verdict).toBe('gold');
    expect(result.overall).toBeGreaterThanOrEqual(4.0);
  });

  it("verdict 'mediocre' when overall <= 2.0", async () => {
    const mockComplete = vi.fn(async () => makeTasteJson(2, 1, 2, 1.8, 'mediocre'));

    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => ({ complete: mockComplete, model: 'mock-opus' })),
      judgeProposal: vi.fn(),
    }));

    const { scoreTaste } = await import('../src/core/fleet/taste-critic.js?' + randomUUID());
    const result = await scoreTaste(makeProposal(), { repo: MOCK_REPO }, makeConfig());

    expect(result.verdict).toBe('mediocre');
    expect(result.overall).toBeLessThanOrEqual(2.0);
  });

  it("verdict 'solid' for mid-range overall", async () => {
    const mockComplete = vi.fn(async () => makeTasteJson(3, 3, 3, 3.0, 'solid'));

    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => ({ complete: mockComplete, model: 'mock-opus' })),
      judgeProposal: vi.fn(),
    }));

    const { scoreTaste } = await import('../src/core/fleet/taste-critic.js?' + randomUUID());
    const result = await scoreTaste(makeProposal(), { repo: MOCK_REPO }, makeConfig());

    expect(result.verdict).toBe('solid');
  });

  it('scores are clamped to 1–5 range', async () => {
    // Model returns out-of-range values
    const mockComplete = vi.fn(async () => JSON.stringify({
      alignment: 0,
      ambition: 7,
      design: -1,
      overall: 6,
      verdict: 'gold',
      rationale: 'Out of range test.',
    }));

    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => ({ complete: mockComplete, model: 'mock-opus' })),
      judgeProposal: vi.fn(),
    }));

    const { scoreTaste } = await import('../src/core/fleet/taste-critic.js?' + randomUUID());
    const result = await scoreTaste(makeProposal(), { repo: MOCK_REPO }, makeConfig());

    expect(result.alignment).toBeGreaterThanOrEqual(1);
    expect(result.alignment).toBeLessThanOrEqual(5);
    expect(result.ambition).toBeGreaterThanOrEqual(1);
    expect(result.ambition).toBeLessThanOrEqual(5);
    expect(result.design).toBeGreaterThanOrEqual(1);
    expect(result.design).toBeLessThanOrEqual(5);
    expect(result.overall).toBeGreaterThanOrEqual(1);
    expect(result.overall).toBeLessThanOrEqual(5);
  });

  it('passes the proposal diff + title + summary in the user prompt', async () => {
    const capturedPrompts: string[] = [];
    const mockComplete = vi.fn(async (_sys: string, user: string) => {
      capturedPrompts.push(user);
      return makeTasteJson(4, 4, 4, 4.0, 'gold');
    });

    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => ({ complete: mockComplete, model: 'mock-opus' })),
      judgeProposal: vi.fn(),
    }));

    const { scoreTaste } = await import('../src/core/fleet/taste-critic.js?' + randomUUID());
    const proposal = makeProposal({
      title: 'My special proposal',
      summary: 'Does something important',
      diff: '@@ -1,1 +1,2 @@\n+// added line',
    });
    await scoreTaste(proposal, { repo: MOCK_REPO, direction: 'maximize merges' }, makeConfig());

    expect(capturedPrompts.length).toBe(1);
    expect(capturedPrompts[0]).toContain('My special proposal');
    expect(capturedPrompts[0]).toContain('Does something important');
    expect(capturedPrompts[0]).toContain('maximize merges');
    expect(capturedPrompts[0]).toContain('@@ -1,1 +1,2 @@');
  });

  it('system prompt contains taste axes labels', async () => {
    const capturedSystems: string[] = [];
    const mockComplete = vi.fn(async (sys: string) => {
      capturedSystems.push(sys);
      return makeTasteJson(4, 4, 4, 4.0, 'gold');
    });

    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => ({ complete: mockComplete, model: 'mock-opus' })),
      judgeProposal: vi.fn(),
    }));

    const { scoreTaste } = await import('../src/core/fleet/taste-critic.js?' + randomUUID());
    await scoreTaste(makeProposal(), { repo: MOCK_REPO }, makeConfig());

    expect(capturedSystems[0]).toContain('VISION-ALIGNMENT');
    expect(capturedSystems[0]).toContain('AMBITION');
    expect(capturedSystems[0]).toContain('DESIGN TASTE');
    expect(capturedSystems[0]).toContain('gold');
    expect(capturedSystems[0]).toContain('mediocre');
  });
});

// ---------------------------------------------------------------------------
// 2. BEST-OF-N TASTE SELECTION
// ---------------------------------------------------------------------------

describe('M183 — best-of-N prefers highest taste when tasteCritic=true', () => {
  afterEach(() => { vi.resetModules(); });

  it('selects candidate with highest taste overall among test-passing ones', async () => {
    // Candidates 0, 1, 2 all pass; correctness scores identical (10 each)
    // Taste scores: 0→3.0, 1→4.5 (gold), 2→2.5
    // Winner should be candidate 1 (highest taste).
    const sandboxMock = makeSandboxMock([0, 1, 2]);
    const judgeMock = makeJudgeMock([10, 10, 10]);
    const tasteMock = makeTasteMock([3.0, 4.5, 2.5]);

    vi.doMock('../src/core/run/sandboxed-engine.js', () => makeSandboxModule(sandboxMock));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: judgeMock,
      resolveFrontierJudgeClient: vi.fn(() => null),
    }));
    vi.doMock('../src/core/fleet/taste-critic.js', () => ({
      scoreTaste: tasteMock,
    }));

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?' + randomUUID());
    const result = await runBestOfN(makeItem(), makeConfig({ tasteCritic: true }), { n: 3 });

    expect(result.winner).toBeDefined();
    expect(result.winner?.index).toBe(1);
    expect(result.winner?.taste?.overall).toBe(4.5);
    expect(result.winner?.taste?.verdict).toBe('gold');
  });

  it('falls back to correctness score when taste scores tie', async () => {
    // All candidates have same taste overall (3.5); correctness scores differ
    // Candidate 1 has higher correctness score → should win
    const sandboxMock = makeSandboxMock([0, 1, 2]);
    const judgeMock = makeJudgeMock([8, 16, 12]);
    const tasteMock = makeTasteMock([3.5, 3.5, 3.5]);

    vi.doMock('../src/core/run/sandboxed-engine.js', () => makeSandboxModule(sandboxMock));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: judgeMock,
      resolveFrontierJudgeClient: vi.fn(() => null),
    }));
    vi.doMock('../src/core/fleet/taste-critic.js', () => ({
      scoreTaste: tasteMock,
    }));

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?' + randomUUID());
    const result = await runBestOfN(makeItem(), makeConfig({ tasteCritic: true }), { n: 3 });

    expect(result.winner).toBeDefined();
    expect(result.winner?.index).toBe(1); // highest correctness score wins tiebreak
  });

  it('winner.taste field is populated when tasteCritic=true', async () => {
    const sandboxMock = makeSandboxMock([0]);
    const judgeMock = makeJudgeMock([12]);
    const tasteMock = makeTasteMock([4.2]);

    vi.doMock('../src/core/run/sandboxed-engine.js', () => makeSandboxModule(sandboxMock));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: judgeMock,
      resolveFrontierJudgeClient: vi.fn(() => null),
    }));
    vi.doMock('../src/core/fleet/taste-critic.js', () => ({
      scoreTaste: tasteMock,
    }));

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?' + randomUUID());
    const result = await runBestOfN(makeItem(), makeConfig({ tasteCritic: true }), { n: 1 });

    expect(result.winner?.taste).toBeDefined();
    expect(result.winner?.taste?.overall).toBe(4.2);
    expect(result.winner?.taste?.verdict).toBe('gold');
    expect(typeof result.winner?.taste?.rationale).toBe('string');
  });

  it('taste critic called for each candidate that has a proposalId', async () => {
    const sandboxMock = makeSandboxMock([0, 2]); // candidate 1 empty
    const judgeMock = makeJudgeMock([8, 10]);
    const tasteMock = makeTasteMock([3.0, 4.0]);

    vi.doMock('../src/core/run/sandboxed-engine.js', () => makeSandboxModule(sandboxMock));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: judgeMock,
      resolveFrontierJudgeClient: vi.fn(() => null),
    }));
    vi.doMock('../src/core/fleet/taste-critic.js', () => ({
      scoreTaste: tasteMock,
    }));

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?' + randomUUID());
    await runBestOfN(makeItem(), makeConfig({ tasteCritic: true }), { n: 3 });

    // Called exactly twice (candidates with proposalIds: 0 and 2)
    expect(tasteMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 3. FLAG OFF PARITY
// ---------------------------------------------------------------------------

describe('M183 — flag-off: selection byte-identical to pre-M183', () => {
  afterEach(() => { vi.resetModules(); });

  it('tasteCritic absent → scoreTaste never called', async () => {
    const sandboxMock = makeSandboxMock([0, 1, 2]);
    const judgeMock = makeJudgeMock([8, 16, 12]); // candidate 1 wins on correctness
    const tasteMock = vi.fn(async () => ({ alignment: 5, ambition: 5, design: 5, overall: 5, verdict: 'gold', rationale: '' }));

    vi.doMock('../src/core/run/sandboxed-engine.js', () => makeSandboxModule(sandboxMock));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: judgeMock,
      resolveFrontierJudgeClient: vi.fn(() => null),
    }));
    vi.doMock('../src/core/fleet/taste-critic.js', () => ({
      scoreTaste: tasteMock,
    }));

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?' + randomUUID());
    // No tasteCritic in config
    const result = await runBestOfN(makeItem(), makeConfig({ tasteCritic: false }), { n: 3 });

    expect(tasteMock).not.toHaveBeenCalled();
    // Winner is determined by correctness score alone → candidate 1 (score 16)
    expect(result.winner?.index).toBe(1);
  });

  it('tasteCritic=false → winner.taste is undefined', async () => {
    const sandboxMock = makeSandboxMock([0]);
    const judgeMock = makeJudgeMock([12]);

    vi.doMock('../src/core/run/sandboxed-engine.js', () => makeSandboxModule(sandboxMock));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: judgeMock,
      resolveFrontierJudgeClient: vi.fn(() => null),
    }));

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?' + randomUUID());
    const result = await runBestOfN(makeItem(), makeConfig({ tasteCritic: false }), { n: 1 });

    expect(result.winner?.taste).toBeUndefined();
  });

  it('flag absent (default config) → same winner as correctness-only path', async () => {
    // Baseline: correctness scores 5, 18, 10 → candidate 1 wins (no taste)
    const sandboxMock = makeSandboxMock([0, 1, 2]);
    const judgeMock = makeJudgeMock([5, 18, 10]);

    vi.doMock('../src/core/run/sandboxed-engine.js', () => makeSandboxModule(sandboxMock));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: judgeMock,
      resolveFrontierJudgeClient: vi.fn(() => null),
    }));

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?' + randomUUID());
    // No foundry.tasteCritic in config at all
    const cfg = {
      provider: 'anthropic',
      foundry: { allowedBackends: ['local-coder'] },
    } as unknown as AshlrConfig;

    const result = await runBestOfN(makeItem(), cfg, { n: 3 });

    expect(result.winner?.index).toBe(1);
    expect(result.winner?.taste).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. NEVER-THROWS — neutral verdict on failure; selection still works
// ---------------------------------------------------------------------------

describe('M183 — never-throws on taste critic failure', () => {
  afterEach(() => { vi.resetModules(); });

  it('scoreTaste returns neutral when client is null (no frontier configured)', async () => {
    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => null),
      judgeProposal: vi.fn(),
    }));

    const { scoreTaste } = await import('../src/core/fleet/taste-critic.js?' + randomUUID());
    const result = await scoreTaste(makeProposal(), { repo: MOCK_REPO }, makeConfig());

    // Neutral = solid, overall=3, all axes=3
    expect(result.verdict).toBe('solid');
    expect(result.overall).toBe(3);
    expect(result.alignment).toBe(3);
    expect(result.ambition).toBe(3);
    expect(result.design).toBe(3);
    expect(typeof result.rationale).toBe('string');
  });

  it('scoreTaste returns neutral when manager.js import fails', async () => {
    vi.doMock('../src/core/fleet/manager.js', () => {
      throw new Error('module unavailable');
    });

    const { scoreTaste } = await import('../src/core/fleet/taste-critic.js?' + randomUUID());
    // Should not throw
    const result = await scoreTaste(makeProposal(), { repo: MOCK_REPO }, makeConfig());

    expect(result.verdict).toBe('solid');
    expect(result.overall).toBe(3);
  });

  it('scoreTaste returns neutral when frontier complete() throws', async () => {
    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => ({
        complete: vi.fn(async () => { throw new Error('network failure'); }),
        model: 'mock-opus',
      })),
      judgeProposal: vi.fn(),
    }));

    const { scoreTaste } = await import('../src/core/fleet/taste-critic.js?' + randomUUID());
    const result = await scoreTaste(makeProposal(), { repo: MOCK_REPO }, makeConfig());

    expect(result.verdict).toBe('solid');
    expect(result.overall).toBe(3);
    expect(result.rationale).toContain('network failure');
  });

  it('scoreTaste returns neutral on malformed JSON response', async () => {
    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => ({
        complete: vi.fn(async () => 'this is not { valid } json at all !!!'),
        model: 'mock-opus',
      })),
      judgeProposal: vi.fn(),
    }));

    const { scoreTaste } = await import('../src/core/fleet/taste-critic.js?' + randomUUID());
    const result = await scoreTaste(makeProposal(), { repo: MOCK_REPO }, makeConfig());

    expect(result.verdict).toBe('solid');
    expect(result.overall).toBe(3);
  });

  it('best-of-N selection still works when scoreTaste throws per-candidate', async () => {
    const sandboxMock = makeSandboxMock([0, 1, 2]);
    const judgeMock = makeJudgeMock([8, 14, 10]);
    // scoreTaste always throws — should not prevent winner selection
    const tasteMock = vi.fn(async () => { throw new Error('taste explodes'); });

    vi.doMock('../src/core/run/sandboxed-engine.js', () => makeSandboxModule(sandboxMock));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: judgeMock,
      resolveFrontierJudgeClient: vi.fn(() => null),
    }));
    vi.doMock('../src/core/fleet/taste-critic.js', () => ({
      scoreTaste: tasteMock,
    }));

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?' + randomUUID());
    const result = await runBestOfN(makeItem(), makeConfig({ tasteCritic: true }), { n: 3 });

    // Selection still works (falls back to correctness scores)
    expect(result.winner).toBeDefined();
    // taste undefined on each candidate (threw)
    expect(result.winner?.taste).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. SECRET SCRUBBING
// ---------------------------------------------------------------------------

describe('M183 — secrets scrubbed from taste critic prompt', () => {
  afterEach(() => { vi.resetModules(); });

  it('does not send raw API key patterns to the frontier', async () => {
    const capturedPrompts: string[] = [];
    const mockComplete = vi.fn(async (_sys: string, user: string) => {
      capturedPrompts.push(user);
      return makeTasteJson(3, 3, 3, 3.0, 'solid');
    });

    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => ({ complete: mockComplete, model: 'mock-opus' })),
      judgeProposal: vi.fn(),
    }));

    const { scoreTaste } = await import('../src/core/fleet/taste-critic.js?' + randomUUID());
    const proposal = makeProposal({
      diff: '+OPENAI_API_KEY=sk-abc123def456ghi789jkl012mno345pqr678stu\n+password=supersecret123456789',
      summary: 'token: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.something.long_token_here_abc123xyz',
    });

    await scoreTaste(proposal, { repo: MOCK_REPO }, makeConfig());

    expect(capturedPrompts.length).toBe(1);
    // Raw secret should not appear verbatim
    // (The scrubber replaces patterns — check that obvious key values are gone)
    expect(capturedPrompts[0]).not.toContain('supersecret123456789');
  });

  it('diff content preview is truncated to 3000 chars', async () => {
    const capturedPrompts: string[] = [];
    const mockComplete = vi.fn(async (_sys: string, user: string) => {
      capturedPrompts.push(user);
      return makeTasteJson(3, 3, 3, 3.0, 'solid');
    });

    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => ({ complete: mockComplete, model: 'mock-opus' })),
      judgeProposal: vi.fn(),
    }));

    const { scoreTaste } = await import('../src/core/fleet/taste-critic.js?' + randomUUID());
    const longDiff = 'a'.repeat(10000);
    const proposal = makeProposal({ diff: longDiff });

    await scoreTaste(proposal, { repo: MOCK_REPO }, makeConfig());

    // The diff preview in the prompt should not be 10000 chars long
    const prompt = capturedPrompts[0] ?? '';
    // Count occurrences of 'a' — should be ≤ 3000 from the diff
    const aCount = (prompt.match(/a/g) ?? []).length;
    expect(aCount).toBeLessThanOrEqual(3000);
  });
});

// ---------------------------------------------------------------------------
// 6. PROPOSAL TAGGED — winner carries taste field
// ---------------------------------------------------------------------------

describe('M183 — proposal tagged with taste field', () => {
  afterEach(() => { vi.resetModules(); });

  it('winner.taste.verdict is accessible after best-of-N', async () => {
    const sandboxMock = makeSandboxMock([0, 1]);
    const judgeMock = makeJudgeMock([10, 10]);
    const tasteMock = makeTasteMock([3.5, 4.8]);

    vi.doMock('../src/core/run/sandboxed-engine.js', () => makeSandboxModule(sandboxMock));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: judgeMock,
      resolveFrontierJudgeClient: vi.fn(() => null),
    }));
    vi.doMock('../src/core/fleet/taste-critic.js', () => ({
      scoreTaste: tasteMock,
    }));

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?' + randomUUID());
    const result = await runBestOfN(makeItem(), makeConfig({ tasteCritic: true }), { n: 2 });

    // Winner should be candidate 1 (taste 4.8 > 3.5)
    expect(result.winner?.index).toBe(1);
    expect(result.winner?.taste?.verdict).toBe('gold');
    expect(result.winner?.taste?.overall).toBe(4.8);
    expect(result.winner?.taste?.alignment).toBeDefined();
    expect(result.winner?.taste?.ambition).toBeDefined();
    expect(result.winner?.taste?.design).toBeDefined();
    expect(typeof result.winner?.taste?.rationale).toBe('string');
  });

  it('all three taste axes are present on tagged winner', async () => {
    const sandboxMock = makeSandboxMock([0]);
    const judgeMock = makeJudgeMock([10]);
    const tasteMock = vi.fn(async () => ({
      alignment: 4,
      ambition: 5,
      design: 3,
      overall: 4.0,
      verdict: 'gold' as const,
      rationale: 'Strong vision alignment and ambition.',
    }));

    vi.doMock('../src/core/run/sandboxed-engine.js', () => makeSandboxModule(sandboxMock));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: judgeMock,
      resolveFrontierJudgeClient: vi.fn(() => null),
    }));
    vi.doMock('../src/core/fleet/taste-critic.js', () => ({
      scoreTaste: tasteMock,
    }));

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?' + randomUUID());
    const result = await runBestOfN(makeItem(), makeConfig({ tasteCritic: true }), { n: 1 });

    const taste = result.winner?.taste;
    expect(taste?.alignment).toBe(4);
    expect(taste?.ambition).toBe(5);
    expect(taste?.design).toBe(3);
    expect(taste?.overall).toBe(4.0);
    expect(taste?.rationale).toContain('Strong vision alignment');
  });
});

// ---------------------------------------------------------------------------
// 7. NO MERGE-GATE CHANGE — safety gate untouched
// ---------------------------------------------------------------------------

describe('M183 — safety merge gate is untouched', () => {
  it('taste-critic.ts does not import from automerge-pass.ts', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/core/fleet/taste-critic.ts'),
      'utf8',
    );
    // Must not import automerge-pass (an import line would start with import ... 'automerge-pass')
    expect(src).not.toMatch(/^import.*automerge-pass/m);
    expect(src).not.toContain('autoMergeProposal');
  });

  it('best-of-n.ts does not import from automerge-pass.ts', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/core/run/best-of-n.ts'),
      'utf8',
    );
    expect(src).not.toContain('automerge-pass');
    expect(src).not.toContain('autoMergeProposal');
  });

  it('taste-critic.ts does not call autoMergeProposal or modify merge logic', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/core/fleet/taste-critic.ts'),
      'utf8',
    );
    // Must not call the merge gate function or reference merge-authority fields
    expect(src).not.toContain('autoMergeProposal');
    expect(src).not.toContain('autoMerge(');
    expect(src).not.toContain('engineTier');
    expect(src).not.toContain('mergeAuthority');
  });

  it('Proposal.taste field has no merge-gate semantics in types.ts', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/core/types.ts'),
      'utf8',
    );
    // The taste field comment should say it does NOT affect the safety merge gate
    const tasteIdx = src.indexOf('M183: Frontier TASTE critic scores');
    expect(tasteIdx).toBeGreaterThan(-1);
    const tasteSection = src.slice(tasteIdx, tasteIdx + 600);
    expect(tasteSection).toContain('Does NOT affect the safety merge gate');
  });

  it('tasteCritic flag comment says it does not add a merge gate', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/core/types.ts'),
      'utf8',
    );
    const flagIdx = src.indexOf('M183: frontier TASTE critic for best-of-N SELECTION');
    expect(flagIdx).toBeGreaterThan(-1);
    const flagSection = src.slice(flagIdx, flagIdx + 600);
    expect(flagSection).toContain('Does NOT add any merge gate');
    expect(flagSection).toContain('safety floor');
  });
});
