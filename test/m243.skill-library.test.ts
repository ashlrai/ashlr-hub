/**
 * test/m243.skill-library.test.ts — M243: skill-library positive write-back.
 *
 * Verifies the key properties of the skill-library module:
 *  1. applied+ship → genome appendHubEntry called with workflow tagged 'm243:skill';
 *     decisions ledger records 'skill-library:written'.
 *  2. flag-off (skillLibrary: false) → absolute no-op (byte-identical).
 *  3. genome-write-throw → swallowed, learnFromApplied never throws.
 *  4. distillWorkflow produces an abstracted workflow, NOT the raw diff verbatim.
 *  5. curateSkills: stale-archive cap (90d) + char cap (SKILL_INJECT_CAP).
 *
 * HERMETICITY:
 *  - HOME overridden to a fresh tmp dir per test — no real ~/.ashlr touched.
 *  - appendHubEntry and recordDecision are MOCKED via vi.mock() so no real I/O
 *    occurs and we get call-level assertions (mirrors m235 pattern).
 *  - Fixed timestamps via vi.setSystemTime() — no Date.now()-flaky tests.
 *  - No network, no LLM, no child processes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, Proposal } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// HOME isolation — override before any module resolves homedir()
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

// ---------------------------------------------------------------------------
// Mocks — declared before lazy imports so modules bind to the mocks
// ---------------------------------------------------------------------------

const mockAppendHubEntry = vi.fn();
vi.mock('../src/core/genome/store.js', () => ({
  appendHubEntry: (...args: unknown[]) => mockAppendHubEntry(...args),
  loadGenome: vi.fn(() => []),
  genomeHealth: vi.fn(() => ({})),
  genomeHubHealth: vi.fn(() => ({})),
  hubStorePath: vi.fn(() => ''),
}));

const mockRecordDecision = vi.fn();
vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  recordDecision: (...args: unknown[]) => mockRecordDecision(...args),
  readDecisions: vi.fn(() => []),
  decisionsDir: vi.fn(() => ''),
}));

// ---------------------------------------------------------------------------
// Lazy import — after mocks
// ---------------------------------------------------------------------------

import {
  learnFromApplied,
  distillWorkflow,
  curateSkills,
  SKILL_INJECT_CAP,
} from '../src/core/fleet/skill-library.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_TS = new Date('2026-01-15T12:00:00.000Z');

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-m243-001',
    repo: '/home/user/myrepo',
    origin: 'swarm',
    kind: 'patch',
    title: 'Fix null pointer in auth module',
    summary: 'Added null check before accessing user.token to prevent crash',
    status: 'pending',
    createdAt: FIXED_TS.toISOString(),
    engineTier: 'frontier',
    engineModel: 'claude:claude-opus-4-5',
    diff: '--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,3 +1,4 @@\n+if (!user) return;\n const tok = user.token;',
    ...overrides,
  } as Proposal;
}

function makeCfg(overrides?: Partial<AshlrConfig>): AshlrConfig {
  return {
    version: 1,
    daemon: {
      dailyBudgetUsd: 10.0,
      perTickItems: 3,
      parallel: 2,
      intervalMs: 100,
      cooldownMs: 6 * 60 * 60 * 1000,
    },
    ...overrides,
  } as AshlrConfig;
}

function makeCfgWithSkillLibrary(skillLibrary: boolean): AshlrConfig {
  return {
    ...makeCfg(),
    foundry: { skillLibrary } as unknown,
  } as AshlrConfig;
}

function makeCfgNoFlag(): AshlrConfig {
  return {
    ...makeCfg(),
    foundry: {} as unknown,
  } as AshlrConfig;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m243-home-'));
  process.env.HOME = tmpHome;

  vi.useFakeTimers();
  vi.setSystemTime(FIXED_TS);

  mockAppendHubEntry.mockReset();
  mockRecordDecision.mockReset();

  mockAppendHubEntry.mockReturnValue(undefined);
  mockRecordDecision.mockReturnValue(undefined);
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ===========================================================================
// 1. distillWorkflow — pure function checks
// ===========================================================================

describe('M243 distillWorkflow — pure function', () => {
  it('returns a non-empty string containing the proposal title', () => {
    const p = makeProposal({ title: 'Add rate limiting to API' });
    const workflow = distillWorkflow(p);
    expect(typeof workflow).toBe('string');
    expect(workflow.length).toBeGreaterThan(20);
    expect(workflow).toContain('Add rate limiting to API');
  });

  it('contains the engine/model info', () => {
    const p = makeProposal({ engineModel: 'claude:claude-opus-4-5', engineTier: 'frontier' });
    const workflow = distillWorkflow(p);
    expect(workflow).toContain('claude:claude-opus-4-5');
  });

  it('contains the repo path', () => {
    const p = makeProposal({ repo: '/home/user/myrepo' });
    const workflow = distillWorkflow(p);
    expect(workflow).toContain('/home/user/myrepo');
  });

  it('includes the summary when present', () => {
    const p = makeProposal({ summary: 'Added null check for user object' });
    const workflow = distillWorkflow(p);
    expect(workflow).toContain('Added null check for user object');
  });

  it('does NOT include the raw diff verbatim', () => {
    // AWM/Voyager principle: workflow must be abstracted, not a raw diff copy
    const p = makeProposal({
      diff: '--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,3 +1,4 @@\n+if (!user) return;\n const tok = user.token;',
    });
    const workflow = distillWorkflow(p);
    // The raw unified diff hunk markers must not appear verbatim
    expect(workflow).not.toContain('--- a/src/auth.ts');
    expect(workflow).not.toContain('+++ b/src/auth.ts');
    expect(workflow).not.toContain('@@ -1,3 +1,4 @@');
  });

  it('derives a task class from the title', () => {
    const bugP = makeProposal({ title: 'Fix crash in parser' });
    expect(distillWorkflow(bugP)).toContain('bug-fix');

    const featP = makeProposal({ title: 'Add new dashboard feature' });
    expect(distillWorkflow(featP)).toContain('feature-add');

    const refactorP = makeProposal({ title: 'Refactor auth module' });
    expect(distillWorkflow(refactorP)).toContain('refactor');
  });

  it('truncates extremely long titles to 80 chars in the workflow text', () => {
    const longTitle = 'B'.repeat(200);
    const p = makeProposal({ title: longTitle });
    const workflow = distillWorkflow(p);
    expect(workflow).toContain('B'.repeat(80));
    expect(workflow).not.toContain('B'.repeat(81));
  });

  it('falls back gracefully when title is empty', () => {
    const p = makeProposal({ title: '' });
    const workflow = distillWorkflow(p);
    expect(workflow).toContain('(untitled)');
  });

  it('falls back to engineTier when engineModel is absent', () => {
    const p = makeProposal({ engineModel: undefined, engineTier: 'frontier' });
    const workflow = distillWorkflow(p);
    expect(workflow).toContain('frontier');
  });
});

// ===========================================================================
// 2. learnFromApplied — ship verdict writes a skill
// ===========================================================================

describe('M243 learnFromApplied — applied+ship writes skill to genome', () => {
  it('calls appendHubEntry once with workflow tagged m243:skill', () => {
    const p = makeProposal();
    learnFromApplied(p, makeCfg());

    expect(mockAppendHubEntry).toHaveBeenCalledOnce();
    const [input] = mockAppendHubEntry.mock.calls[0] as [Record<string, unknown>];

    // Tags must include the skill tag
    const tags = input['tags'] as string[];
    expect(tags).toContain('m243:skill');

    // hubOnly must be true
    expect(input['hubOnly']).toBe(true);

    // text must be a non-empty string (the workflow)
    expect(typeof input['text']).toBe('string');
    expect((input['text'] as string).length).toBeGreaterThan(10);
  });

  it('workflow text does NOT contain raw diff verbatim', () => {
    const p = makeProposal({
      diff: '--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n+const x = 1;',
    });
    learnFromApplied(p, makeCfg());

    const [input] = mockAppendHubEntry.mock.calls[0] as [Record<string, unknown>];
    const text = input['text'] as string;
    expect(text).not.toContain('--- a/foo.ts');
    expect(text).not.toContain('+++ b/foo.ts');
  });

  it('tags include the first 24 chars of proposalId in the proposal: tag', () => {
    const longId = 'abcdefghijklmnopqrstuvwxyz1234567890';
    const p = makeProposal({ id: longId });
    learnFromApplied(p, makeCfg());

    const [input] = mockAppendHubEntry.mock.calls[0] as [Record<string, unknown>];
    const tags = input['tags'] as string[];
    const proposalTag = tags.find((t) => t.startsWith('proposal:'));
    expect(proposalTag).toBeDefined();
    expect(proposalTag).toBe(`proposal:${longId.slice(0, 24)}`);
  });

  it('records a decisions-ledger entry with action "skill-library:written"', () => {
    const p = makeProposal();
    learnFromApplied(p, makeCfg());

    expect(mockRecordDecision).toHaveBeenCalledOnce();
    const [entry] = mockRecordDecision.mock.calls[0] as [Record<string, unknown>];
    expect(entry['action']).toBe('skill-library:written');
    expect(entry['proposalId']).toBe(p.id);
    expect(entry['detail']).toContain('engine=');
  });

  it('writes normally when skillLibrary flag is absent (default ON)', () => {
    learnFromApplied(makeProposal(), makeCfgNoFlag());
    expect(mockAppendHubEntry).toHaveBeenCalledOnce();
    expect(mockRecordDecision).toHaveBeenCalledOnce();
  });

  it('writes normally when skillLibrary is explicitly true', () => {
    learnFromApplied(makeProposal(), makeCfgWithSkillLibrary(true));
    expect(mockAppendHubEntry).toHaveBeenCalledOnce();
    expect(mockRecordDecision).toHaveBeenCalledOnce();
  });
});

// ===========================================================================
// 3. learnFromApplied — flag-off is a byte-identical no-op
// ===========================================================================

describe('M243 learnFromApplied — flag-off (skillLibrary: false) is a no-op', () => {
  it('does not call appendHubEntry when skillLibrary is false', () => {
    learnFromApplied(makeProposal(), makeCfgWithSkillLibrary(false));
    expect(mockAppendHubEntry).not.toHaveBeenCalled();
  });

  it('does not call recordDecision when skillLibrary is false', () => {
    learnFromApplied(makeProposal(), makeCfgWithSkillLibrary(false));
    expect(mockRecordDecision).not.toHaveBeenCalled();
  });

  it('is a no-op for multiple proposal shapes when skillLibrary is false', () => {
    const cfg = makeCfgWithSkillLibrary(false);
    for (const title of ['Fix bug', 'Add feature', 'Refactor module', 'Update deps']) {
      mockAppendHubEntry.mockReset();
      mockRecordDecision.mockReset();
      learnFromApplied(makeProposal({ title }), cfg);
      expect(mockAppendHubEntry).not.toHaveBeenCalled();
      expect(mockRecordDecision).not.toHaveBeenCalled();
    }
  });
});

// ===========================================================================
// 4. learnFromApplied — never throws (store-write failures are swallowed)
// ===========================================================================

describe('M243 learnFromApplied — never throws', () => {
  it('does not throw when appendHubEntry throws', () => {
    mockAppendHubEntry.mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => learnFromApplied(makeProposal(), makeCfg())).not.toThrow();
  });

  it('does not throw when recordDecision throws', () => {
    mockRecordDecision.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    expect(() => learnFromApplied(makeProposal(), makeCfg())).not.toThrow();
  });

  it('does not throw when BOTH stores throw simultaneously', () => {
    mockAppendHubEntry.mockImplementation(() => {
      throw new Error('genome store unavailable');
    });
    mockRecordDecision.mockImplementation(() => {
      throw new Error('ledger unavailable');
    });

    expect(() => learnFromApplied(makeProposal(), makeCfg())).not.toThrow();
  });

  it('does not throw when cfg.foundry is undefined', () => {
    const cfg = makeCfg({ foundry: undefined });
    expect(() => learnFromApplied(makeProposal(), cfg)).not.toThrow();
    // Default ON: writes should have been attempted
    expect(mockAppendHubEntry).toHaveBeenCalledOnce();
  });

  it('does not throw when cfg.foundry getter throws', () => {
    const badCfg = {
      ...makeCfg(),
      get foundry(): never {
        throw new Error('foundry getter crashed');
      },
    } as unknown as AshlrConfig;

    expect(() => learnFromApplied(makeProposal(), badCfg)).not.toThrow();
    // Gate throws → early return → no writes
    expect(mockAppendHubEntry).not.toHaveBeenCalled();
    expect(mockRecordDecision).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 5. curateSkills — pure curation
// ===========================================================================

describe('M243 curateSkills — pure curation', () => {
  // Use fixed time so stale-archive is deterministic.
  const nowMs = FIXED_TS.getTime();

  function makeEntry(
    id: string,
    tags: string[],
    tsOffset = 0,
    textLen = 100,
  ) {
    return {
      id,
      project: null,
      source: 'hub' as const,
      title: `Skill ${id}`,
      text: 'x'.repeat(textLen),
      tags,
      ts: new Date(nowMs + tsOffset).toISOString(),
    };
  }

  it('returns [] for an empty array', () => {
    expect(curateSkills([])).toEqual([]);
  });

  it('returns [] for non-array input (defensive)', () => {
    // @ts-expect-error intentional bad input
    expect(curateSkills(null)).toEqual([]);
    // @ts-expect-error intentional bad input
    expect(curateSkills(undefined)).toEqual([]);
  });

  it('only includes entries tagged "m243:skill"', () => {
    const tagged = makeEntry('a', ['m243:skill']);
    const other = makeEntry('b', ['m235:anti-playbook']);
    const unrelated = makeEntry('c', ['some-other-tag']);
    const result = curateSkills([tagged, other, unrelated]);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('a');
  });

  it('excludes entries older than 90 days', () => {
    const oldMs = 91 * 24 * 60 * 60 * 1000;
    const fresh = makeEntry('fresh', ['m243:skill'], 0);
    const stale = makeEntry('stale', ['m243:skill'], -oldMs);
    const result = curateSkills([fresh, stale]);
    expect(result.map((e) => e.id)).toContain('fresh');
    expect(result.map((e) => e.id)).not.toContain('stale');
  });

  it('returns entries sorted most-recent first', () => {
    const e1 = makeEntry('older', ['m243:skill'], -10000);
    const e2 = makeEntry('newer', ['m243:skill'], -1000);
    const result = curateSkills([e1, e2]);
    expect(result[0]!.id).toBe('newer');
    expect(result[1]!.id).toBe('older');
  });

  it('caps total chars at SKILL_INJECT_CAP', () => {
    // Each entry: title ~10 + text 200 = ~210 chars; 4 entries ~840 > 800
    const entries = ['a', 'b', 'c', 'd'].map((id, i) =>
      makeEntry(id, ['m243:skill'], -i * 1000, 200),
    );
    const result = curateSkills(entries);
    const total = result.reduce((sum, e) => sum + e.title.length + e.text.length, 0);
    expect(total).toBeLessThanOrEqual(SKILL_INJECT_CAP);
    expect(result.length).toBeGreaterThan(0);
  });

  it('never throws on malformed entry ts values', () => {
    const badTs = makeEntry('bad', ['m243:skill']);
    (badTs as Record<string, unknown>)['ts'] = 'not-a-date';
    expect(() => curateSkills([badTs])).not.toThrow();
    // Entry with invalid ts is kept (treated as no ts → fresh)
    expect(curateSkills([badTs])).toHaveLength(1);
  });

  it('keeps an entry with invalid ts in the fresh set', () => {
    const badTs = makeEntry('kept', ['m243:skill']);
    (badTs as Record<string, unknown>)['ts'] = 'invalid-date-string';
    const result = curateSkills([badTs]);
    expect(result.map((e) => e.id)).toContain('kept');
  });
});
