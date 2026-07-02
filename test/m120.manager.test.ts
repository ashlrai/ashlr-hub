/**
 * m120.manager.test.ts — Fleet Manager / CEO agent tests.
 *
 * Units under test:
 *   1. judgeProposal — parses LLM scores+verdict, correct ManagerVerdict shape
 *   2. wouldMerge logic — true only for ship+low+small; false for ship+large and noise
 *   3. Parse-failure path — defaults to 'review', never auto-rejects
 *   4. runManager shadow mode — records 'judged' in ledger, builds report, does NOT call setStatus
 *   5. runManager applyRejects=true — rejects noise/harmful only
 *
 * Hermetic: HOME relocated to a tmp dir. getActiveClient and listProposals mocked.
 * Conventions mirror m119.quality-metrics.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Proposal } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
const origAshlrHome = process.env.ASHLR_HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m120-home-'));
  process.env.HOME = tmpHome;
  process.env.ASHLR_HOME = path.join(tmpHome, '.ashlr');
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  if (origAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = origAshlrHome;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

const mockProposals: Partial<Proposal>[] = [];

// Track setStatus calls for shadow-mode assertions
const setStatusCalls: Array<[string, string, string | undefined, string | undefined]> = [];

vi.mock('../src/core/inbox/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/inbox/store.js')>();
  return {
    ...actual,
    listProposals: (_filter?: { status?: string }) =>
      [...mockProposals] as Proposal[],
    setStatus: (
      id: string,
      status: string,
      result?: string,
      reason?: string,
    ) => {
      setStatusCalls.push([id, status, result, reason]);
      // Also call the real setStatus if a proposal file exists (for integration sub-tests)
      try { actual.setStatus(id, status as Proposal['status'], result, reason); } catch { /* no-op */ }
    },
  };
});

// M274: mock engineInstalled so the claude-CLI judge path is NOT taken in these
// tests (they rely on getActiveClient mocks). engineInstalled returning false
// forces resolveJudgeClient to fall through to the getActiveClient/ollama path
// — preserving the original test intent. This mock is additive-only: it does
// not change test assertions, only ensures the mocked getActiveClient is used.
vi.mock('../src/core/run/engines.js', () => ({
  engineInstalled: () => false,
  buildEngineCommand: () => null,
  spawnEngine: async () => ({ ok: false, output: '', error: 'mocked' }),
  resolveBinAbsolute: (bin: string) => bin,
  phantomInitializedAt: () => false,
}));

// Mock getActiveClient — returns a deterministic judge
vi.mock('../src/core/run/provider-client.js', () => ({
  getActiveClient: vi.fn(),
  // Manager falls back to this for a local judge; throw in tests so the
  // "no client available" path is clean (no live Ollama during unit tests).
  buildOpenAICompatibleClient: vi.fn(() => { throw new Error('no local client (test)'); }),
}));

// Mock classifyRisk so we can control it per-test
vi.mock('../src/core/inbox/merge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/inbox/merge.js')>();
  return {
    ...actual,
    classifyRisk: vi.fn(() => 'low' as const),
  };
});

beforeEach(() => {
  mockProposals.length = 0;
  setStatusCalls.length = 0;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _idSeq = 0;

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: `prop-m120-${_idSeq++}`,
    repo: '/repos/alpha',
    origin: 'backlog',
    kind: 'patch',
    title: 'test proposal',
    summary: 'a useful change',
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Proposal;
}

/** Build a small diff touching N files with M changed lines. */
function makeDiff(files: number, linesPerFile: number): string {
  const parts: string[] = [];
  for (let i = 0; i < files; i++) {
    parts.push(`--- a/file${i}.ts`);
    parts.push(`+++ b/file${i}.ts`);
    parts.push('@@ -1,1 +1,1 @@');
    for (let j = 0; j < linesPerFile; j++) {
      parts.push(`-old line ${j} in file ${i}`);
      parts.push(`+new line ${j} in file ${i}`);
    }
  }
  return parts.join('\n');
}

/** Create a mock client that returns a fixed JSON verdict string. */
function mockClient(verdictJson: object): { complete: (s: string, u: string) => Promise<string>; model: string } {
  return {
    model: 'test-judge',
    complete: vi.fn().mockResolvedValue(JSON.stringify(verdictJson)),
  };
}

/** Create a mock client that returns unparseable prose. */
function mockClientParseFail(): { complete: (s: string, u: string) => Promise<string>; model: string } {
  return {
    model: 'test-judge',
    complete: vi.fn().mockResolvedValue('I cannot provide a structured assessment at this time.'),
  };
}

/** Create a mock client that throws on complete(). */
function mockClientThrows(): { complete: (s: string, u: string) => Promise<string>; model: string } {
  return {
    model: 'test-judge',
    complete: vi.fn().mockRejectedValue(new Error('network error')),
  };
}

// ---------------------------------------------------------------------------
// 1. judgeProposal — parses scores + verdict correctly
// ---------------------------------------------------------------------------

describe('m120 judgeProposal — score parsing', () => {
  it('parses a clean JSON response into the correct ManagerVerdict shape', async () => {
    const { judgeProposal } = await import('../src/core/fleet/manager.js');
    const proposal = makeProposal({ diff: makeDiff(2, 10) });
    const client = mockClient({
      verdict: 'ship',
      value: 5,
      correctness: 4,
      scope: 2,
      alignment: 5,
      rationale: 'Solid improvement with low blast radius.',
    });

    const verdict = await judgeProposal(proposal, {} as never, client);

    expect(verdict.proposalId).toBe(proposal.id);
    expect(verdict.verdict).toBe('ship');
    expect(verdict.value).toBe(5);
    expect(verdict.correctness).toBe(4);
    expect(verdict.scope).toBe(2);
    expect(verdict.alignment).toBe(5);
    expect(verdict.rationale).toBe('Solid improvement with low blast radius.');
    expect(typeof verdict.wouldMerge).toBe('boolean');
  });

  it('parses a JSON block wrapped in markdown fences', async () => {
    const { judgeProposal } = await import('../src/core/fleet/manager.js');
    const proposal = makeProposal();
    const wrapped = '```json\n' + JSON.stringify({
      verdict: 'review',
      value: 3,
      correctness: 3,
      scope: 3,
      alignment: 3,
      rationale: 'Needs closer inspection.',
    }) + '\n```';

    const client = {
      model: 'test',
      complete: vi.fn().mockResolvedValue(wrapped),
    };

    const verdict = await judgeProposal(proposal, {} as never, client);
    expect(verdict.verdict).toBe('review');
    expect(verdict.rationale).toBe('Needs closer inspection.');
  });

  it('parses JSON embedded in prose', async () => {
    const { judgeProposal } = await import('../src/core/fleet/manager.js');
    const proposal = makeProposal();
    const prose =
      'After careful review, here is my assessment:\n' +
      JSON.stringify({
        verdict: 'noise',
        value: 1,
        correctness: 2,
        scope: 1,
        alignment: 1,
        rationale: 'Trivial whitespace change.',
      }) +
      '\nThank you.';

    const client = { model: 'test', complete: vi.fn().mockResolvedValue(prose) };
    const verdict = await judgeProposal(proposal, {} as never, client);
    expect(verdict.verdict).toBe('noise');
    expect(verdict.value).toBe(1);
  });

  it('clamps scores to 1-5 range', async () => {
    const { judgeProposal } = await import('../src/core/fleet/manager.js');
    const proposal = makeProposal();
    const client = mockClient({
      verdict: 'review',
      value: 99,
      correctness: -5,
      scope: 0,
      alignment: 6,
      rationale: 'Out of range scores.',
    });

    const verdict = await judgeProposal(proposal, {} as never, client);
    expect(verdict.value).toBe(5);
    expect(verdict.correctness).toBe(1);
    expect(verdict.scope).toBe(1);
    expect(verdict.alignment).toBe(5);
  });

  it('treats unknown verdict strings as "review"', async () => {
    const { judgeProposal } = await import('../src/core/fleet/manager.js');
    const proposal = makeProposal();
    const client = mockClient({
      verdict: 'maybe',
      value: 3,
      correctness: 3,
      scope: 3,
      alignment: 3,
      rationale: 'Unknown verdict.',
    });

    const verdict = await judgeProposal(proposal, {} as never, client);
    expect(verdict.verdict).toBe('review');
  });
});

// ---------------------------------------------------------------------------
// 2. wouldMerge logic
// ---------------------------------------------------------------------------

describe('m120 judgeProposal — wouldMerge logic', () => {
  it('wouldMerge=true when verdict=ship + low risk + small diff (≤4 files, ≤150 lines)', async () => {
    const { classifyRisk } = await import('../src/core/inbox/merge.js');
    (classifyRisk as ReturnType<typeof vi.fn>).mockReturnValue('low');

    const { judgeProposal } = await import('../src/core/fleet/manager.js');
    const proposal = makeProposal({ diff: makeDiff(2, 5) }); // 2 files, 10 changed lines

    const client = mockClient({
      verdict: 'ship',
      value: 5,
      correctness: 5,
      scope: 1,
      alignment: 5,
      rationale: 'Perfect change.',
    });

    const verdict = await judgeProposal(proposal, {} as never, client);
    expect(verdict.verdict).toBe('ship');
    expect(verdict.wouldMerge).toBe(true);
  });

  it('wouldMerge=false when verdict=ship but risk=medium under default low-risk bounds', async () => {
    const { classifyRisk } = await import('../src/core/inbox/merge.js');
    (classifyRisk as ReturnType<typeof vi.fn>).mockReturnValue('medium');

    const { judgeProposal } = await import('../src/core/fleet/manager.js');
    const proposal = makeProposal({ diff: makeDiff(2, 5) });

    const client = mockClient({
      verdict: 'ship',
      value: 5,
      correctness: 5,
      scope: 1,
      alignment: 5,
      rationale: 'Good but medium risk.',
    });

    const verdict = await judgeProposal(proposal, {} as never, client);
    expect(verdict.verdict).toBe('ship');
    expect(verdict.wouldMerge).toBe(false);
  });

  it('wouldMerge=true for medium risk when configured auto-merge bounds allow it', async () => {
    const { classifyRisk } = await import('../src/core/inbox/merge.js');
    (classifyRisk as ReturnType<typeof vi.fn>).mockReturnValue('medium');

    const { judgeProposal } = await import('../src/core/fleet/manager.js');
    const proposal = makeProposal({ diff: makeDiff(6, 20) });

    const client = mockClient({
      verdict: 'ship',
      value: 5,
      correctness: 5,
      scope: 2,
      alignment: 5,
      rationale: 'Medium risk but inside configured bounds.',
    });

    const verdict = await judgeProposal(
      proposal,
      {
        foundry: {
          autoMerge: {
            maxRisk: 'medium',
            maxAutomergeFiles: 10,
            maxAutomergeLines: 300,
          },
        },
      } as never,
      client,
    );
    expect(verdict.verdict).toBe('ship');
    expect(verdict.wouldMerge).toBe(true);
  });

  it('wouldMerge=false when verdict=ship but diff is large (>150 changed lines)', async () => {
    const { classifyRisk } = await import('../src/core/inbox/merge.js');
    (classifyRisk as ReturnType<typeof vi.fn>).mockReturnValue('low');

    const { judgeProposal } = await import('../src/core/fleet/manager.js');
    // 4 files × 40 lines each = 160 changed lines > 150 threshold
    const proposal = makeProposal({ diff: makeDiff(4, 40) });

    const client = mockClient({
      verdict: 'ship',
      value: 5,
      correctness: 5,
      scope: 3,
      alignment: 5,
      rationale: 'Large but good.',
    });

    const verdict = await judgeProposal(proposal, {} as never, client);
    expect(verdict.verdict).toBe('ship');
    expect(verdict.wouldMerge).toBe(false);
  });

  it('wouldMerge=false when verdict=ship but too many files (>4)', async () => {
    const { classifyRisk } = await import('../src/core/inbox/merge.js');
    (classifyRisk as ReturnType<typeof vi.fn>).mockReturnValue('low');

    const { judgeProposal } = await import('../src/core/fleet/manager.js');
    // 5 files, each with 1 changed line = many files, few lines
    const proposal = makeProposal({ diff: makeDiff(5, 1) });

    const client = mockClient({
      verdict: 'ship',
      value: 5,
      correctness: 5,
      scope: 2,
      alignment: 5,
      rationale: 'Wide change.',
    });

    const verdict = await judgeProposal(proposal, {} as never, client);
    expect(verdict.verdict).toBe('ship');
    expect(verdict.wouldMerge).toBe(false);
  });

  it('wouldMerge=false when verdict=noise (regardless of risk/size)', async () => {
    const { classifyRisk } = await import('../src/core/inbox/merge.js');
    (classifyRisk as ReturnType<typeof vi.fn>).mockReturnValue('low');

    const { judgeProposal } = await import('../src/core/fleet/manager.js');
    const proposal = makeProposal({ diff: makeDiff(1, 1) });

    const client = mockClient({
      verdict: 'noise',
      value: 1,
      correctness: 2,
      scope: 1,
      alignment: 1,
      rationale: 'Trivial.',
    });

    const verdict = await judgeProposal(proposal, {} as never, client);
    expect(verdict.verdict).toBe('noise');
    expect(verdict.wouldMerge).toBe(false);
  });

  it('wouldMerge=false when verdict=harmful', async () => {
    const { classifyRisk } = await import('../src/core/inbox/merge.js');
    (classifyRisk as ReturnType<typeof vi.fn>).mockReturnValue('low');

    const { judgeProposal } = await import('../src/core/fleet/manager.js');
    const proposal = makeProposal({ diff: makeDiff(1, 1) });

    const client = mockClient({
      verdict: 'harmful',
      value: 1,
      correctness: 1,
      scope: 5,
      alignment: 1,
      rationale: 'Deletes production data.',
    });

    const verdict = await judgeProposal(proposal, {} as never, client);
    expect(verdict.verdict).toBe('harmful');
    expect(verdict.wouldMerge).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Parse-failure → 'review' (never auto-reject on uncertainty)
// ---------------------------------------------------------------------------

describe('m120 judgeProposal — parse failure', () => {
  it('defaults to verdict=review on unparseable response', async () => {
    const { judgeProposal } = await import('../src/core/fleet/manager.js');
    const proposal = makeProposal();
    const client = mockClientParseFail();

    const verdict = await judgeProposal(proposal, {} as never, client);

    expect(verdict.verdict).toBe('review');
    expect(verdict.wouldMerge).toBe(false);
    expect(verdict.proposalId).toBe(proposal.id);
  });

  it('defaults to verdict=review when client.complete() throws', async () => {
    const { judgeProposal } = await import('../src/core/fleet/manager.js');
    const proposal = makeProposal();
    const client = mockClientThrows();

    const verdict = await judgeProposal(proposal, {} as never, client);

    expect(verdict.verdict).toBe('review');
    expect(verdict.wouldMerge).toBe(false);
  });

  it('parse-failure never produces noise or harmful verdict', async () => {
    const { judgeProposal } = await import('../src/core/fleet/manager.js');
    const proposal = makeProposal();
    const client = mockClientParseFail();

    const verdict = await judgeProposal(proposal, {} as never, client);

    expect(verdict.verdict).not.toBe('noise');
    expect(verdict.verdict).not.toBe('harmful');
  });
});

// ---------------------------------------------------------------------------
// 4. runManager — shadow mode (no setStatus calls)
// ---------------------------------------------------------------------------

describe('m120 runManager — shadow mode', () => {
  it('records "judged" decisions in the ledger for each proposal', async () => {
    const { getActiveClient } = await import('../src/core/run/provider-client.js');
    (getActiveClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockClient({ verdict: 'ship', value: 4, correctness: 4, scope: 2, alignment: 4, rationale: 'Good.' }),
    );

    mockProposals.push(makeProposal({ id: 'prop-shadow-001' }));
    mockProposals.push(makeProposal({ id: 'prop-shadow-002' }));

    const { runManager } = await import('../src/core/fleet/manager.js');
    const report = await runManager({} as never, { window: '7d', applyRejects: false });

    // Report must be defined and have verdicts
    expect(report).toBeDefined();
    expect(report.verdicts.length).toBe(2);

    // Decisions ledger must have entries
    const { readDecisions } = await import('../src/core/fleet/decisions-ledger.js');
    const entries = readDecisions();
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const actions = entries.map((e) => e.action);
    expect(actions.every((a) => a === 'judged')).toBe(true);
  });

  it('does NOT call setStatus in shadow mode (applyRejects=false)', async () => {
    const { getActiveClient } = await import('../src/core/run/provider-client.js');
    (getActiveClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockClient({ verdict: 'noise', value: 1, correctness: 1, scope: 1, alignment: 1, rationale: 'Spam.' }),
    );

    mockProposals.push(makeProposal({ id: 'prop-shadow-003' }));

    const { runManager } = await import('../src/core/fleet/manager.js');
    await runManager({} as never, { applyRejects: false });

    // setStatus must NOT have been called
    expect(setStatusCalls.length).toBe(0);
  });

  it('returns a ManagerReport with all required fields', async () => {
    const { getActiveClient } = await import('../src/core/run/provider-client.js');
    (getActiveClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockClient({ verdict: 'review', value: 3, correctness: 3, scope: 3, alignment: 3, rationale: 'Unclear.' }),
    );

    mockProposals.push(makeProposal());

    const { runManager } = await import('../src/core/fleet/manager.js');
    const report = await runManager({} as never, { window: '30d' });

    expect(typeof report.generatedAt).toBe('string');
    expect(report.window).toBe('30d');
    expect(typeof report.metrics).toBe('object');
    expect(Array.isArray(report.verdicts)).toBe(true);
    expect(Array.isArray(report.wins)).toBe(true);
    expect(Array.isArray(report.concerns)).toBe(true);
    expect(Array.isArray(report.recommendations)).toBe(true);
    expect(typeof report.narrative).toBe('string');
    expect(typeof report.judgeEngine).toBe('string');
  });

  it('wins list contains only ship verdicts', async () => {
    const { getActiveClient } = await import('../src/core/run/provider-client.js');
    const { classifyRisk } = await import('../src/core/inbox/merge.js');
    (classifyRisk as ReturnType<typeof vi.fn>).mockReturnValue('low');

    // Alternate between ship and review
    let call = 0;
    (getActiveClient as ReturnType<typeof vi.fn>).mockResolvedValue({
      model: 'test',
      complete: vi.fn().mockImplementation(() => {
        const v = call++ % 2 === 0 ? 'ship' : 'review';
        return Promise.resolve(JSON.stringify({
          verdict: v, value: 5, correctness: 5, scope: 1, alignment: 5, rationale: 'ok',
        }));
      }),
    });

    mockProposals.push(makeProposal({ id: 'prop-ship-1', diff: makeDiff(1, 5) }));
    mockProposals.push(makeProposal({ id: 'prop-review-1' }));
    mockProposals.push(makeProposal({ id: 'prop-ship-2', diff: makeDiff(1, 5) }));

    const { runManager } = await import('../src/core/fleet/manager.js');
    const report = await runManager({} as never);

    // wins should contain ship proposals
    for (const win of report.wins) {
      expect(win).toMatch(/prop-ship/);
    }
    expect(report.wins.length).toBe(2);
  });

  it('writes the report to ~/.ashlr/manager/<ts>.json', async () => {
    const { getActiveClient } = await import('../src/core/run/provider-client.js');
    (getActiveClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockClient({ verdict: 'review', value: 3, correctness: 3, scope: 3, alignment: 3, rationale: 'ok' }),
    );

    const { runManager } = await import('../src/core/fleet/manager.js');
    await runManager({} as never);

    const managerDir = path.join(tmpHome, '.ashlr', 'manager');
    expect(fs.existsSync(managerDir)).toBe(true);
    const files = fs.readdirSync(managerDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it('respects the limit option — judges at most N proposals', async () => {
    const { getActiveClient } = await import('../src/core/run/provider-client.js');
    (getActiveClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockClient({ verdict: 'review', value: 3, correctness: 3, scope: 3, alignment: 3, rationale: 'ok' }),
    );

    for (let i = 0; i < 10; i++) mockProposals.push(makeProposal());

    const { runManager } = await import('../src/core/fleet/manager.js');
    const report = await runManager({} as never, { limit: 3 });
    expect(report.verdicts.length).toBe(3);
  });

  it('never throws even when client is unavailable', async () => {
    const { getActiveClient } = await import('../src/core/run/provider-client.js');
    (getActiveClient as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('no provider'));

    mockProposals.push(makeProposal());

    const { runManager } = await import('../src/core/fleet/manager.js');
    // Dead Ollama URL so the direct-Ollama fallback fails fast (no real 72b call / timeout).
    await expect(runManager({ models: { ollama: 'http://127.0.0.1:9' } } as never)).resolves.toBeDefined();
  });

  it('defaults all proposals to review when no client available', async () => {
    const { getActiveClient } = await import('../src/core/run/provider-client.js');
    (getActiveClient as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('no provider'));

    mockProposals.push(makeProposal({ id: 'prop-no-client-1' }));
    mockProposals.push(makeProposal({ id: 'prop-no-client-2' }));

    const { runManager } = await import('../src/core/fleet/manager.js');
    const report = await runManager({ models: { ollama: 'http://127.0.0.1:9' } } as never);

    // With no client, verdicts default to 'review' — never noise/harmful
    for (const v of report.verdicts) {
      expect(v.verdict).toBe('review');
      expect(v.wouldMerge).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. runManager — applyRejects=true
// ---------------------------------------------------------------------------

describe('m120 runManager — applyRejects=true', () => {
  it('calls setStatus(rejected) only for noise/harmful verdicts', async () => {
    const { getActiveClient } = await import('../src/core/run/provider-client.js');

    const verdicts = ['ship', 'noise', 'review', 'harmful', 'noise'];
    let idx = 0;
    (getActiveClient as ReturnType<typeof vi.fn>).mockResolvedValue({
      model: 'test',
      complete: vi.fn().mockImplementation(() => {
        const v = verdicts[idx++] ?? 'review';
        return Promise.resolve(JSON.stringify({
          verdict: v, value: 2, correctness: 2, scope: 2, alignment: 2, rationale: `verdict: ${v}`,
        }));
      }),
    });

    for (let i = 0; i < 5; i++) {
      mockProposals.push(makeProposal({ id: `prop-ar-${i}` }));
    }

    const { runManager } = await import('../src/core/fleet/manager.js');
    await runManager({} as never, { applyRejects: true });

    // setStatus should have been called for noise (indices 1, 4) and harmful (index 3)
    expect(setStatusCalls.length).toBe(3);
    for (const [_id, status] of setStatusCalls) {
      expect(status).toBe('rejected');
    }
  });

  it('does NOT call setStatus for ship or review verdicts', async () => {
    const { getActiveClient } = await import('../src/core/run/provider-client.js');
    (getActiveClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockClient({ verdict: 'ship', value: 5, correctness: 5, scope: 1, alignment: 5, rationale: 'Great.' }),
    );

    mockProposals.push(makeProposal());

    const { runManager } = await import('../src/core/fleet/manager.js');
    await runManager({} as never, { applyRejects: true });

    expect(setStatusCalls.length).toBe(0);
  });

  it('still does NOT merge anything in applyRejects mode', async () => {
    const { getActiveClient } = await import('../src/core/run/provider-client.js');
    const { classifyRisk } = await import('../src/core/inbox/merge.js');
    (classifyRisk as ReturnType<typeof vi.fn>).mockReturnValue('low');
    (getActiveClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockClient({ verdict: 'ship', value: 5, correctness: 5, scope: 1, alignment: 5, rationale: 'Ship it.' }),
    );

    mockProposals.push(makeProposal({ diff: makeDiff(1, 5) }));

    const { runManager } = await import('../src/core/fleet/manager.js');
    const report = await runManager({} as never, { applyRejects: true });

    // Ship verdict => wouldMerge may be true, but NO actual merge (no setStatus('applied'))
    const mergeStatusCalls = setStatusCalls.filter(([, s]) => s === 'applied' || s === 'approved');
    expect(mergeStatusCalls.length).toBe(0);

    // The verdict is advisory only
    const shipVerdict = report.verdicts.find((v) => v.verdict === 'ship');
    expect(shipVerdict).toBeDefined();
    // wouldMerge is true but no actual merge happened
  });
});
