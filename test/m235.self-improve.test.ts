/**
 * test/m235.self-improve.test.ts — M235: self-improvement reflection loop.
 *
 * Verifies the four key properties of learnFromRejection():
 *  1. Rejection verdicts ('noise' | 'harmful' | 'review') WRITE an anti-playbook
 *     lesson — genome store receives a tagged entry, decisions ledger records
 *     action 'self-improve:written'.
 *  2. 'ship' verdict does NOT write (no false anti-playbook, ledger stays clean).
 *  3. cfg.foundry.selfImprove === false → absolute no-op (gate works).
 *  4. Never throws — even when both stores throw, learnFromRejection() resolves.
 *
 * HERMETICITY:
 *  - HOME overridden to a fresh tmp dir per test — no real ~/.ashlr touched.
 *  - appendHubEntry and recordDecision are MOCKED via vi.mock() so no real I/O
 *    occurs and we get call-level assertions (mirrors m220 / h1 patterns).
 *  - No network, no LLM, no child processes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';

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
  // Other exports present in the module; provide stubs so imports don't fail.
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
  learnFromRejection,
  deriveLesson,
  curateAntiPlaybooks,
  ANTI_PLAYBOOK_INJECT_CAP,
} from '../src/core/fleet/self-improve.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeCfgWithSelfImprove(selfImprove: boolean): AshlrConfig {
  return {
    ...makeCfg(),
    foundry: { selfImprove } as unknown,
  } as AshlrConfig;
}

/** Config with selfImprove absent entirely (should default ON). */
function makeCfgNoSelfImproveFlag(): AshlrConfig {
  return {
    ...makeCfg(),
    foundry: {} as unknown,
  } as AshlrConfig;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m235-home-'));
  process.env.HOME = tmpHome;

  mockAppendHubEntry.mockReset();
  mockRecordDecision.mockReset();

  // Default: both stores succeed (return undefined / void)
  mockAppendHubEntry.mockReturnValue(undefined);
  mockRecordDecision.mockReturnValue(undefined);
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  vi.clearAllMocks();
});

// ===========================================================================
// 1. deriveLesson — pure function sanity checks
// ===========================================================================

describe('M235 deriveLesson — pure function', () => {
  it('produces a non-empty string for each rejection verdict', () => {
    for (const v of ['review', 'noise', 'harmful'] as const) {
      const lesson = deriveLesson(v, 'some reasoning', 'My proposal title');
      expect(typeof lesson).toBe('string');
      expect(lesson.length).toBeGreaterThan(10);
    }
  });

  it('embeds only the finite verdict lesson and discards proposal text', () => {
    const lesson = deriveLesson('noise', 'it was too trivial', 'Rename a variable');
    expect(lesson).toContain('noise');
    expect(lesson).not.toContain('Rename a variable');
    expect(lesson).not.toContain('it was too trivial');
  });

  it('never embeds model reasoning', () => {
    const lesson = deriveLesson('harmful', 'deletes prod data', 'Drop table users');
    expect(lesson).not.toContain('deletes prod data');
    expect(lesson).not.toContain('Drop table users');
  });

  it('handles empty reasoning gracefully', () => {
    const lesson = deriveLesson('review', '', 'some title');
    expect(typeof lesson).toBe('string');
    expect(lesson.length).toBeGreaterThan(0);
    // Should not contain "Judge reasoning:" when reasoning is empty
    expect(lesson).not.toContain('Judge reasoning:');
  });

  it('does not persist extremely long titles', () => {
    const longTitle = 'A'.repeat(200);
    const lesson = deriveLesson('noise', '', longTitle);
    expect(lesson).not.toContain('A'.repeat(80));
  });

  it('does not persist extremely long reasoning', () => {
    const longReason = 'X'.repeat(500);
    const lesson = deriveLesson('review', longReason, 'title');
    expect(lesson).not.toContain('X');
  });

  it('needs no title fallback because title is not retained', () => {
    const lesson = deriveLesson('harmful', '', '');
    expect(lesson).not.toContain('untitled');
  });
});

// ===========================================================================
// 2. learnFromRejection — writes for rejection verdicts
// ===========================================================================

describe('M235 learnFromRejection — writes anti-playbook for rejection verdicts', () => {
  it('calls appendHubEntry once for verdict "noise"', () => {
    learnFromRejection('prop-001', 'Rename a variable', 'noise', 'too trivial', makeCfg());

    expect(mockAppendHubEntry).toHaveBeenCalledOnce();
    const [input] = mockAppendHubEntry.mock.calls[0] as [Record<string, unknown>];
    // Title must reference verdict
    expect(input['title']).toMatch(/noise/i);
    // Tags must include the anti-playbook tag
    const tags = input['tags'] as string[];
    expect(tags).toContain('m235:anti-playbook');
    expect(tags).toContain('verdict:noise');
    // hubOnly must be true (no project note dropped)
    expect(input['hubOnly']).toBe(true);
    // text must contain the lesson
    expect(typeof input['text']).toBe('string');
    expect((input['text'] as string).length).toBeGreaterThan(10);
    expect(JSON.stringify(input)).not.toContain('Rename a variable');
    expect(JSON.stringify(input)).not.toContain('too trivial');
  });

  it('calls appendHubEntry once for verdict "harmful"', () => {
    learnFromRejection('prop-002', 'Drop table users', 'harmful', 'deletes data', makeCfg());

    expect(mockAppendHubEntry).toHaveBeenCalledOnce();
    const [input] = mockAppendHubEntry.mock.calls[0] as [Record<string, unknown>];
    const tags = input['tags'] as string[];
    expect(tags).toContain('m235:anti-playbook');
    expect(tags).toContain('verdict:harmful');
  });

  it('calls appendHubEntry once for verdict "review"', () => {
    learnFromRejection('prop-003', 'Add logging', 'review', 'needs human review', makeCfg());

    expect(mockAppendHubEntry).toHaveBeenCalledOnce();
    const [input] = mockAppendHubEntry.mock.calls[0] as [Record<string, unknown>];
    const tags = input['tags'] as string[];
    expect(tags).toContain('m235:anti-playbook');
    expect(tags).toContain('verdict:review');
  });

  it('records a decisions-ledger entry with action "self-improve:written" for each rejection', () => {
    for (const v of ['noise', 'harmful', 'review'] as const) {
      mockRecordDecision.mockReset();
      learnFromRejection(`prop-${v}`, `Title ${v}`, v, '', makeCfg());
      expect(mockRecordDecision).toHaveBeenCalledOnce();
      const [entry] = mockRecordDecision.mock.calls[0] as [Record<string, unknown>];
      expect(entry['action']).toBe('self-improve:written');
      expect(entry['proposalId']).toBe(`prop-${v}`);
      expect(entry['detail']).toContain(`verdict=${v}`);
    }
  });

  it('tags include the first 24 chars of proposalId in the proposal: tag', () => {
    const longId = 'abcdefghijklmnopqrstuvwxyz1234567890';
    learnFromRejection(longId, 'My proposal', 'noise', '', makeCfg());

    const [input] = mockAppendHubEntry.mock.calls[0] as [Record<string, unknown>];
    const tags = input['tags'] as string[];
    const proposalTag = tags.find((t) => t.startsWith('proposal:'));
    expect(proposalTag).toBeDefined();
    // Must be capped at 24 chars of the id
    expect(proposalTag).toBe(`proposal:${longId.slice(0, 24)}`);
  });
});

// ===========================================================================
// 3. learnFromRejection — "ship" does NOT write
// ===========================================================================

describe('M235 learnFromRejection — "ship" verdict does NOT write', () => {
  it('does not call appendHubEntry for verdict "ship"', () => {
    learnFromRejection('prop-ship', 'Great feature', 'ship', 'all good', makeCfg());

    expect(mockAppendHubEntry).not.toHaveBeenCalled();
  });

  it('does not call recordDecision for verdict "ship"', () => {
    learnFromRejection('prop-ship', 'Great feature', 'ship', 'all good', makeCfg());

    expect(mockRecordDecision).not.toHaveBeenCalled();
  });

  it('does not write for unknown/empty verdict strings', () => {
    for (const v of ['', 'unknown', 'approved', 'pending', 'NOISE', 'HARMFUL', 'REVIEW']) {
      mockAppendHubEntry.mockReset();
      mockRecordDecision.mockReset();
      learnFromRejection('prop-x', 'Some title', v, '', makeCfg());
      expect(mockAppendHubEntry).not.toHaveBeenCalled();
      expect(mockRecordDecision).not.toHaveBeenCalled();
    }
  });
});

// ===========================================================================
// 4. learnFromRejection — gate: selfImprove === false
// ===========================================================================

describe('M235 learnFromRejection — gate: cfg.foundry.selfImprove === false', () => {
  it('is a complete no-op when selfImprove is explicitly false', () => {
    const cfg = makeCfgWithSelfImprove(false);
    learnFromRejection('prop-gated', 'Rename X', 'noise', 'too trivial', cfg);

    expect(mockAppendHubEntry).not.toHaveBeenCalled();
    expect(mockRecordDecision).not.toHaveBeenCalled();
  });

  it('writes normally when selfImprove is explicitly true', () => {
    const cfg = makeCfgWithSelfImprove(true);
    learnFromRejection('prop-on', 'Rename X', 'noise', 'too trivial', cfg);

    expect(mockAppendHubEntry).toHaveBeenCalledOnce();
    expect(mockRecordDecision).toHaveBeenCalledOnce();
  });

  it('writes normally when selfImprove flag is absent (default ON)', () => {
    const cfg = makeCfgNoSelfImproveFlag();
    learnFromRejection('prop-default', 'Rename X', 'noise', 'too trivial', cfg);

    expect(mockAppendHubEntry).toHaveBeenCalledOnce();
    expect(mockRecordDecision).toHaveBeenCalledOnce();
  });

  it('is a no-op even for each rejection verdict when selfImprove === false', () => {
    const cfg = makeCfgWithSelfImprove(false);
    for (const v of ['noise', 'harmful', 'review']) {
      mockAppendHubEntry.mockReset();
      mockRecordDecision.mockReset();
      learnFromRejection('prop-gated', 'Any title', v, '', cfg);
      expect(mockAppendHubEntry).not.toHaveBeenCalled();
      expect(mockRecordDecision).not.toHaveBeenCalled();
    }
  });
});

// ===========================================================================
// 5. learnFromRejection — never throws (store-write failures are swallowed)
// ===========================================================================

describe('M235 learnFromRejection — never throws', () => {
  it('does not throw when appendHubEntry throws', () => {
    mockAppendHubEntry.mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() =>
      learnFromRejection('prop-throw-1', 'Risky proposal', 'noise', 'low value', makeCfg()),
    ).not.toThrow();
  });

  it('does not throw when recordDecision throws', () => {
    mockRecordDecision.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    expect(() =>
      learnFromRejection('prop-throw-2', 'Risky proposal', 'harmful', 'dangerous', makeCfg()),
    ).not.toThrow();
  });

  it('does not throw when BOTH stores throw simultaneously', () => {
    mockAppendHubEntry.mockImplementation(() => {
      throw new Error('genome store unavailable');
    });
    mockRecordDecision.mockImplementation(() => {
      throw new Error('ledger unavailable');
    });

    expect(() =>
      learnFromRejection('prop-throw-3', 'Any title', 'review', 'needs review', makeCfg()),
    ).not.toThrow();
  });

  it('does not throw when cfg.foundry is undefined', () => {
    const cfg = makeCfg({ foundry: undefined });
    expect(() =>
      learnFromRejection('prop-no-foundry', 'Some proposal', 'noise', '', cfg),
    ).not.toThrow();
    // Default ON: writes should have been attempted
    expect(mockAppendHubEntry).toHaveBeenCalledOnce();
  });

  it('does not throw when cfg.foundry throws during property access', () => {
    // Simulate a pathological cfg where accessing foundry throws
    const badCfg = {
      ...makeCfg(),
      get foundry(): never {
        throw new Error('foundry getter crashed');
      },
    } as unknown as AshlrConfig;

    expect(() =>
      learnFromRejection('prop-bad-cfg', 'Any title', 'noise', '', badCfg),
    ).not.toThrow();
    // Gate throws → early return → no writes
    expect(mockAppendHubEntry).not.toHaveBeenCalled();
    expect(mockRecordDecision).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 6. curateAntiPlaybooks — pure function
// ===========================================================================

describe('M235 curateAntiPlaybooks — pure curation', () => {
  const nowMs = Date.now();

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
      title: `Entry ${id}`,
      text: 'x'.repeat(textLen),
      tags,
      ts: new Date(nowMs + tsOffset).toISOString(),
    };
  }

  it('returns [] for an empty array', () => {
    expect(curateAntiPlaybooks([])).toEqual([]);
  });

  it('returns [] for non-array input (defensive)', () => {
    // @ts-expect-error intentional bad input
    expect(curateAntiPlaybooks(null)).toEqual([]);
    // @ts-expect-error intentional bad input
    expect(curateAntiPlaybooks(undefined)).toEqual([]);
  });

  it('only includes entries tagged "m235:anti-playbook"', () => {
    const tagged = makeEntry('a', ['m235:anti-playbook']);
    const other = makeEntry('b', ['some-other-tag']);
    const result = curateAntiPlaybooks([tagged, other]);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('a');
  });

  it('excludes entries older than 90 days', () => {
    const oldMs = 91 * 24 * 60 * 60 * 1000; // 91 days ago
    const fresh = makeEntry('fresh', ['m235:anti-playbook'], 0);
    const stale = makeEntry('stale', ['m235:anti-playbook'], -oldMs);
    const result = curateAntiPlaybooks([fresh, stale]);
    expect(result.map((e) => e.id)).toContain('fresh');
    expect(result.map((e) => e.id)).not.toContain('stale');
  });

  it('returns entries sorted most-recent first', () => {
    const e1 = makeEntry('older', ['m235:anti-playbook'], -10000);
    const e2 = makeEntry('newer', ['m235:anti-playbook'], -1000);
    const result = curateAntiPlaybooks([e1, e2]);
    expect(result[0]!.id).toBe('newer');
    expect(result[1]!.id).toBe('older');
  });

  it('caps total chars at ANTI_PLAYBOOK_INJECT_CAP (800)', () => {
    // Each entry: title.length + text.length ≈ 10 + 200 = 210 chars
    // Four of them = 840 which exceeds 800 → only 3 should fit
    const entries = ['a', 'b', 'c', 'd'].map((id, i) =>
      makeEntry(id, ['m235:anti-playbook'], -i * 1000, 200),
    );
    const result = curateAntiPlaybooks(entries);
    const total = result.reduce((sum, e) => sum + e.title.length + e.text.length, 0);
    expect(total).toBeLessThanOrEqual(ANTI_PLAYBOOK_INJECT_CAP);
    // At least one entry was returned (sanity)
    expect(result.length).toBeGreaterThan(0);
  });

  it('never throws on malformed entry ts values', () => {
    const badTs = makeEntry('bad', ['m235:anti-playbook']);
    (badTs as Record<string, unknown>)['ts'] = 'not-a-date';
    expect(() => curateAntiPlaybooks([badTs])).not.toThrow();
    // Entry with invalid ts is kept (treated as no ts → fresh)
    expect(curateAntiPlaybooks([badTs])).toHaveLength(1);
  });
});
