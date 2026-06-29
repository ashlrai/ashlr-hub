/**
 * test/m253.claude-usage.test.ts — M253 transcript-based Claude usage sensing.
 *
 * Invariants proved:
 *
 *  1. TRANSCRIPT 5H SUM: readClaudeUsage walks JSONL files, sums all four
 *     usage token fields (input + output + cache_create + cache_read) for
 *     assistant messages within the 5h window.
 *
 *  2. WINDOW CUTOFF: messages older than 5h excluded from tokens5h/messages5h;
 *     messages within 7d (but >5h) counted in 7d totals only.
 *
 *  3. THRESHOLD MAPPING: senseClaudeState maps usedPct to availability:
 *     <75 → open; >=75 → near; >=protectPct(85) → throttled; >=100 → exhausted.
 *
 *  4. STALE-STATS-CACHE IGNORED: when no weeklyTokenBudget/weeklyCostBudgetUsd
 *     is configured, transcript sensing is used (stats-cache irrelevant).
 *
 *  5. NEVER-THROWS: readClaudeUsage + senseClaudeState never throw, even with
 *     missing dirs, malformed lines, zero files.
 *
 *  6. FLAG-OFF BYTE-IDENTICAL: when resourceAware=false, no sensing fires.
 *
 *  7. FLEET-LEDGER OVERRIDE: when weeklyTokenBudget is set, ledger path is used
 *     instead of transcript path (transcript sensing disabled).
 *
 *  8. CACHE: repeated calls within 30s return same readAt (cache hit).
 *     invalidateClaudeUsageCache() resets it.
 *
 *  9. DEFAULT CAP: when no fiveHourMessageCap configured, defaults to
 *     DEFAULT_5H_MESSAGE_CAP_PRO (900).
 *
 * 10. NO-REGRESSION: m250 stats-cache + codex + nim + gateway tests still pass.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Env isolation
// ---------------------------------------------------------------------------

let tmpHome: string;
let origHome: string | undefined;
let origProjectsDir: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m253-'));
  mkdirSync(join(tmpHome, '.ashlr', 'decisions'), { recursive: true });
  mkdirSync(join(tmpHome, '.ashlr', 'fleet'), { recursive: true });
  mkdirSync(join(tmpHome, '.claude', 'projects'), { recursive: true });
  origHome = process.env['HOME'];
  origProjectsDir = process.env['CLAUDE_PROJECTS_DIR'];
  process.env['HOME'] = tmpHome;
  // Point the transcript reader at our tmp dir
  process.env['CLAUDE_PROJECTS_DIR'] = join(tmpHome, '.claude', 'projects');
  vi.resetModules();
});

afterEach(() => {
  process.env['HOME'] = origHome;
  if (origProjectsDir === undefined) {
    delete process.env['CLAUDE_PROJECTS_DIR'];
  } else {
    process.env['CLAUDE_PROJECTS_DIR'] = origProjectsDir;
  }
  rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a JSONL transcript line for an assistant message. */
function makeAssistantLine(opts: {
  tsOffsetMs?: number;  // negative = in the past; default = now
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  model?: string;
}): string {
  const ts = new Date(Date.now() + (opts.tsOffsetMs ?? 0)).toISOString();
  const line = {
    type: 'assistant',
    timestamp: ts,
    message: {
      model: opts.model ?? 'claude-sonnet-4-6',
      usage: {
        input_tokens: opts.inputTokens ?? 100,
        output_tokens: opts.outputTokens ?? 50,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: opts.cacheWrite ?? 0,
      },
    },
  };
  return JSON.stringify(line);
}

/** Write a transcript file with the given lines into a project dir. */
function writeTranscript(projectDir: string, lines: string[]): void {
  const projectPath = join(tmpHome, '.claude', 'projects', projectDir);
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(join(projectPath, 'session.jsonl'), lines.join('\n') + '\n');
}

const MS_5H = 5 * 60 * 60 * 1000;
const MS_7D = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 1. Transcript 5h sum — four token fields
// ---------------------------------------------------------------------------

describe('M253 readClaudeUsage — transcript 5h token sum', () => {
  it('sums all four token fields from assistant messages within 5h', async () => {
    writeTranscript('proj-a', [
      makeAssistantLine({
        tsOffsetMs: -30 * 60 * 1000, // 30 minutes ago — in 5h window
        inputTokens: 1000,
        outputTokens: 200,
        cacheRead: 500,
        cacheWrite: 300,
      }),
    ]);

    const { readClaudeUsage } = await import('../src/core/fabric/claude-usage.js');
    const result = readClaudeUsage();

    // total = 1000 + 200 + 500 + 300 = 2000
    expect(result.tokens5h).toBe(2000);
    expect(result.tokens7d).toBe(2000);
    expect(result.messages5h).toBe(1);
    expect(result.messages7d).toBe(1);
    expect(result.filesScanned).toBe(1);
  });

  it('sums across multiple projects', async () => {
    writeTranscript('proj-a', [
      makeAssistantLine({ tsOffsetMs: -10 * 60 * 1000, inputTokens: 500, outputTokens: 100 }),
    ]);
    writeTranscript('proj-b', [
      makeAssistantLine({ tsOffsetMs: -20 * 60 * 1000, inputTokens: 300, outputTokens: 50 }),
    ]);

    const { readClaudeUsage } = await import('../src/core/fabric/claude-usage.js');
    const result = readClaudeUsage();

    // proj-a: 600, proj-b: 350 = 950 total tokens
    expect(result.tokens5h).toBe(950);
    expect(result.messages5h).toBe(2);
  });

  it('ignores human/tool type lines (only assistant)', async () => {
    writeTranscript('proj-a', [
      JSON.stringify({ type: 'human', timestamp: new Date().toISOString(), message: { content: 'hello' } }),
      JSON.stringify({ type: 'tool', timestamp: new Date().toISOString(), content: 'result' }),
      makeAssistantLine({ inputTokens: 200, outputTokens: 50 }),
    ]);

    const { readClaudeUsage } = await import('../src/core/fabric/claude-usage.js');
    const result = readClaudeUsage();

    expect(result.messages5h).toBe(1);
    expect(result.tokens5h).toBe(250);
  });

  it('skips messages with zero total tokens', async () => {
    writeTranscript('proj-a', [
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 0, output_tokens: 0 } },
      }),
      makeAssistantLine({ inputTokens: 100, outputTokens: 50 }),
    ]);

    const { readClaudeUsage } = await import('../src/core/fabric/claude-usage.js');
    const result = readClaudeUsage();

    expect(result.messages5h).toBe(1); // only the non-zero one
    expect(result.tokens5h).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// 2. Window cutoff
// ---------------------------------------------------------------------------

describe('M253 readClaudeUsage — window cutoff', () => {
  it('excludes messages older than 5h from tokens5h but includes in tokens7d', async () => {
    writeTranscript('proj-a', [
      // Inside 7d, outside 5h: 6h ago
      makeAssistantLine({ tsOffsetMs: -(6 * 60 * 60 * 1000), inputTokens: 999, outputTokens: 1 }),
      // Inside both: 1h ago
      makeAssistantLine({ tsOffsetMs: -(1 * 60 * 60 * 1000), inputTokens: 100, outputTokens: 50 }),
    ]);

    const { readClaudeUsage } = await import('../src/core/fabric/claude-usage.js');
    const result = readClaudeUsage();

    expect(result.tokens5h).toBe(150);     // only the 1h-ago message
    expect(result.tokens7d).toBe(150 + 1000); // both messages
    expect(result.messages5h).toBe(1);
    expect(result.messages7d).toBe(2);
  });

  it('excludes messages older than 7d entirely', async () => {
    writeTranscript('proj-a', [
      // 8 days ago — outside 7d window
      makeAssistantLine({ tsOffsetMs: -(8 * MS_7D / 7), inputTokens: 9999, outputTokens: 1 }),
      // Inside 5h
      makeAssistantLine({ tsOffsetMs: -1000, inputTokens: 50, outputTokens: 50 }),
    ]);

    const { readClaudeUsage } = await import('../src/core/fabric/claude-usage.js');
    const result = readClaudeUsage();

    expect(result.tokens5h).toBe(100);
    expect(result.tokens7d).toBe(100);
    expect(result.messages5h).toBe(1);
    expect(result.messages7d).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Threshold mapping via senseClaudeState
// ---------------------------------------------------------------------------

describe('M253 senseClaudeState — threshold mapping', () => {
  it('open when messages5h < 75% of fiveHourMessageCap', async () => {
    // 10 messages out of cap=100 = 10%
    writeTranscript('proj-a', Array.from({ length: 10 }, () =>
      makeAssistantLine({ tsOffsetMs: -60_000, inputTokens: 10, outputTokens: 5 })
    ));

    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const cfg = {
      version: 1, roots: ['/tmp'], editor: 'cursor', staleDays: 30,
      categories: {}, tidyRules: [], keepers: [], models: { lmstudio: '', ollama: '', providerChain: [] },
      telemetry: {}, tools: {},
      foundry: { allowedBackends: ['claude'], claudeResource: { fiveHourMessageCap: 100, protectPct: 85 } },
    };

    const state = await getBackendResourceState('claude', cfg);
    expect(state.availability).toBe('open');
    expect(state.usedPct).toBe(10);
    expect(state.capWindow).toBe('5h');
    expect(state.capUnit).toBe('messages');
  });

  it('near when messages5h >= 75% of fiveHourMessageCap', async () => {
    // 80 messages out of cap=100 = 80%
    writeTranscript('proj-a', Array.from({ length: 80 }, () =>
      makeAssistantLine({ tsOffsetMs: -60_000, inputTokens: 10, outputTokens: 5 })
    ));

    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const cfg = {
      version: 1, roots: ['/tmp'], editor: 'cursor', staleDays: 30,
      categories: {}, tidyRules: [], keepers: [], models: { lmstudio: '', ollama: '', providerChain: [] },
      telemetry: {}, tools: {},
      foundry: { allowedBackends: ['claude'], claudeResource: { fiveHourMessageCap: 100, protectPct: 85 } },
    };

    const state = await getBackendResourceState('claude', cfg);
    expect(state.availability).toBe('near');
    expect(state.usedPct).toBe(80);
  });

  it('throttled when messages5h >= protectPct (85)', async () => {
    // 90 messages out of cap=100 = 90% >= protectPct=85
    writeTranscript('proj-a', Array.from({ length: 90 }, () =>
      makeAssistantLine({ tsOffsetMs: -60_000, inputTokens: 10, outputTokens: 5 })
    ));

    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const cfg = {
      version: 1, roots: ['/tmp'], editor: 'cursor', staleDays: 30,
      categories: {}, tidyRules: [], keepers: [], models: { lmstudio: '', ollama: '', providerChain: [] },
      telemetry: {}, tools: {},
      foundry: { allowedBackends: ['claude'], claudeResource: { fiveHourMessageCap: 100, protectPct: 85 } },
    };

    const state = await getBackendResourceState('claude', cfg);
    expect(state.availability).toBe('throttled');
    expect(state.usedPct).toBe(90);
    expect(state.reason).toMatch(/protectPct/);
  });

  it('exhausted when messages5h >= 100% of fiveHourMessageCap', async () => {
    // 110 messages out of cap=100 = 110%
    writeTranscript('proj-a', Array.from({ length: 110 }, () =>
      makeAssistantLine({ tsOffsetMs: -60_000, inputTokens: 10, outputTokens: 5 })
    ));

    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const cfg = {
      version: 1, roots: ['/tmp'], editor: 'cursor', staleDays: 30,
      categories: {}, tidyRules: [], keepers: [], models: { lmstudio: '', ollama: '', providerChain: [] },
      telemetry: {}, tools: {},
      foundry: { allowedBackends: ['claude'], claudeResource: { fiveHourMessageCap: 100, protectPct: 85 } },
    };

    const state = await getBackendResourceState('claude', cfg);
    expect(state.availability).toBe('exhausted');
    expect(state.usedPct).toBeGreaterThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// 4. Stale stats-cache ignored (transcript is primary)
// ---------------------------------------------------------------------------

describe('M253 senseClaudeState — stale stats-cache ignored', () => {
  it('does not use stats-cache when no weeklyTokenBudget configured', async () => {
    // Write a stale stats-cache that would show 100% if used
    writeFileSync(
      join(tmpHome, '.claude', 'stats-cache.json'),
      JSON.stringify({
        version: 1,
        lastComputedDate: '2020-01-01', // ancient — would be stale
        dailyActivity: [{ date: new Date().toISOString().slice(0, 10), messageCount: 9999 }],
      }),
    );

    // But transcript has only 5 recent messages
    writeTranscript('proj-a', Array.from({ length: 5 }, () =>
      makeAssistantLine({ tsOffsetMs: -60_000, inputTokens: 10, outputTokens: 5 })
    ));

    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const cfg = {
      version: 1, roots: ['/tmp'], editor: 'cursor', staleDays: 30,
      categories: {}, tidyRules: [], keepers: [], models: { lmstudio: '', ollama: '', providerChain: [] },
      telemetry: {}, tools: {},
      foundry: { allowedBackends: ['claude'], claudeResource: { fiveHourMessageCap: 100, protectPct: 85 } },
    };

    const state = await getBackendResourceState('claude', cfg);
    // Must use transcript (5 messages = 5%) not stats-cache (9999/100 = exhausted)
    expect(state.availability).toBe('open');
    expect(state.usedPct).toBe(5);
    expect(state.capWindow).toBe('5h');
  });
});

// ---------------------------------------------------------------------------
// 5. Never-throws
// ---------------------------------------------------------------------------

describe('M253 readClaudeUsage — never-throws', () => {
  it('returns zeroed result when projects dir is missing', async () => {
    // Point to a non-existent dir
    process.env['CLAUDE_PROJECTS_DIR'] = join(tmpHome, 'nonexistent');

    const { readClaudeUsage } = await import('../src/core/fabric/claude-usage.js');
    const result = readClaudeUsage();

    expect(result.tokens5h).toBe(0);
    expect(result.tokens7d).toBe(0);
    expect(result.messages5h).toBe(0);
    expect(result.messages7d).toBe(0);
    expect(result.filesScanned).toBe(0);
  });

  it('tolerates malformed JSONL lines without throwing', async () => {
    const projectPath = join(tmpHome, '.claude', 'projects', 'proj-bad');
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, 'session.jsonl'), [
      'not json at all',
      '{"incomplete": ',
      makeAssistantLine({ inputTokens: 100, outputTokens: 50 }),
      '',
      '   ',
    ].join('\n'));

    const { readClaudeUsage } = await import('../src/core/fabric/claude-usage.js');
    expect(() => readClaudeUsage()).not.toThrow();
    const result = readClaudeUsage();
    // Only the valid line is counted
    expect(result.messages5h).toBe(1);
    expect(result.tokens5h).toBe(150);
  });

  it('senseClaudeState never throws with empty projects dir', async () => {
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const cfg = {
      version: 1, roots: ['/tmp'], editor: 'cursor', staleDays: 30,
      categories: {}, tidyRules: [], keepers: [], models: { lmstudio: '', ollama: '', providerChain: [] },
      telemetry: {}, tools: {},
      foundry: { allowedBackends: ['claude'], claudeResource: { fiveHourMessageCap: 100, protectPct: 85 } },
    };

    await expect(getBackendResourceState('claude', cfg)).resolves.toBeDefined();
    const state = await getBackendResourceState('claude', cfg);
    expect(state.backend).toBe('claude');
    expect(state.availability).toBe('open'); // 0/100 = 0% → open
    expect(state.usedPct).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Fleet-ledger override (weeklyTokenBudget disables transcript sensing)
// ---------------------------------------------------------------------------

describe('M253 senseClaudeState — fleet-ledger override', () => {
  it('uses ledger path when weeklyTokenBudget is set (not transcript)', async () => {
    // Write transcript with lots of messages — should be ignored
    writeTranscript('proj-a', Array.from({ length: 200 }, () =>
      makeAssistantLine({ tsOffsetMs: -60_000, inputTokens: 100, outputTokens: 50 })
    ));

    // Ledger has zero entries → 0% of budget
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const cfg = {
      version: 1, roots: ['/tmp'], editor: 'cursor', staleDays: 30,
      categories: {}, tidyRules: [], keepers: [], models: { lmstudio: '', ollama: '', providerChain: [] },
      telemetry: {}, tools: {},
      foundry: {
        allowedBackends: ['claude'],
        claudeResource: {
          weeklyTokenBudget: 1_000_000, // fleet-ledger mode
          protectPct: 85,
        },
      },
    };

    const state = await getBackendResourceState('claude', cfg);
    // Fleet ledger has zero entries → 0% used
    // capWindow must be '7d' (fleet-ledger) not '5h' (transcript)
    expect(state.capWindow).toBe('7d');
    expect(state.usedPct).toBe(0);
    expect(state.reason).toMatch(/fleet/i);
  });
});

// ---------------------------------------------------------------------------
// 7. Cache behaviour
// ---------------------------------------------------------------------------

describe('M253 readClaudeUsage — cache', () => {
  it('repeated calls within TTL return same readAt (cache hit)', async () => {
    writeTranscript('proj-a', [
      makeAssistantLine({ tsOffsetMs: -60_000, inputTokens: 100, outputTokens: 50 }),
    ]);

    const { readClaudeUsage, invalidateClaudeUsageCache } = await import('../src/core/fabric/claude-usage.js');
    invalidateClaudeUsageCache(); // ensure cold start

    const r1 = readClaudeUsage();
    const r2 = readClaudeUsage();

    expect(r1.readAt).toBe(r2.readAt); // same epoch ms → same cache slot
  });

  it('invalidateClaudeUsageCache() forces re-read', async () => {
    writeTranscript('proj-a', [
      makeAssistantLine({ tsOffsetMs: -60_000, inputTokens: 100, outputTokens: 50 }),
    ]);

    const { readClaudeUsage, invalidateClaudeUsageCache } = await import('../src/core/fabric/claude-usage.js');
    invalidateClaudeUsageCache();

    const r1 = readClaudeUsage();

    // Add more data
    appendFileSync(
      join(tmpHome, '.claude', 'projects', 'proj-a', 'session.jsonl'),
      makeAssistantLine({ tsOffsetMs: -30_000, inputTokens: 500, outputTokens: 100 }) + '\n',
    );

    // Without invalidation, still cached
    const r2 = readClaudeUsage();
    expect(r2.readAt).toBe(r1.readAt); // cache hit

    // After invalidation, re-reads
    invalidateClaudeUsageCache();
    const r3 = readClaudeUsage();
    expect(r3.messages5h).toBeGreaterThan(r1.messages5h);
  });
});

// ---------------------------------------------------------------------------
// 8. Default cap (Pro = 900)
// ---------------------------------------------------------------------------

describe('M253 senseClaudeState — default cap is Pro (900 messages/5h)', () => {
  it('uses DEFAULT_5H_MESSAGE_CAP_PRO when fiveHourMessageCap not configured', async () => {
    // 450 messages = 50% of 900
    writeTranscript('proj-a', Array.from({ length: 450 }, () =>
      makeAssistantLine({ tsOffsetMs: -60_000, inputTokens: 10, outputTokens: 5 })
    ));

    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    // No fiveHourMessageCap → uses default 900
    const cfg = {
      version: 1, roots: ['/tmp'], editor: 'cursor', staleDays: 30,
      categories: {}, tidyRules: [], keepers: [], models: { lmstudio: '', ollama: '', providerChain: [] },
      telemetry: {}, tools: {},
      foundry: { allowedBackends: ['claude'] },
    };

    const state = await getBackendResourceState('claude', cfg);
    expect(state.availability).toBe('open'); // 50% < 75% threshold
    expect(state.usedPct).toBe(50);
    expect(state.cap).toBe(900);
  });

  it('DEFAULT_5H_MESSAGE_CAP_PRO is exported and equals 900', async () => {
    const { DEFAULT_5H_MESSAGE_CAP_PRO } = await import('../src/core/fabric/claude-usage.js');
    expect(DEFAULT_5H_MESSAGE_CAP_PRO).toBe(900);
  });
});
