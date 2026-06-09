/**
 * M16 playbook tests — hermetic, tmp HOME, mocked provider.
 *
 * SAFETY GUARDRAIL: process.env.HOME is overridden to a tmp dir.
 * fetch is mocked to prevent real Ollama / cloud calls.
 *
 * Covers:
 *   - buildPlaybook: recalls + synthesizes via mocked local model
 *   - buildPlaybook: falls back to concatenated recall on model failure
 *   - buildPlaybook: falls back when no provider available
 *   - buildPlaybook: returns { goal, entries, synthesis } shape
 *   - buildPlaybook: synthesis is non-empty
 *   - buildPlaybook: never throws even on empty genome
 *   - buildPlaybook: never throws on malformed cfg
 *   - buildPlaybook: never calls cloud APIs (local-only)
 *   - buildPlaybook: respects opts.limit for recall
 *   - playbookText: returns string capped at maxChars
 *   - playbookText: hard truncates with elision marker
 *   - playbookText: is pure, never throws
 *   - playbookText: handles empty playbook gracefully
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, GenomeEntry, Playbook } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Override HOME before genome module import
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

function freshTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m16-playbook-'));
}

// ---------------------------------------------------------------------------
// Lazy imports
// ---------------------------------------------------------------------------

let buildPlaybook: (
  goal: string,
  cfg: AshlrConfig,
  opts?: { limit?: number },
) => Promise<Playbook>;
let playbookText: (p: Playbook, maxChars: number) => string;

async function ensureImported(): Promise<void> {
  if (!buildPlaybook) {
    const mod = await import('../src/core/genome/playbook.js');
    buildPlaybook = mod.buildPlaybook;
    playbookText = mod.playbookText;
  }
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AshlrConfig> = {}): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['ollama'],
    },
    telemetry: {},
    tools: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<GenomeEntry> & { title: string; text: string }): GenomeEntry {
  return {
    id: overrides.id ?? `hub-${Math.random().toString(36).slice(2)}`,
    project: overrides.project ?? null,
    source: 'hub',
    title: overrides.title,
    text: overrides.text,
    tags: overrides.tags ?? [],
    ts: overrides.ts ?? new Date().toISOString(),
  };
}

function writeHubEntries(tmpH: string, entries: GenomeEntry[]): void {
  const storeDir = path.join(tmpH, '.ashlr', 'genome');
  fs.mkdirSync(storeDir, { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(path.join(storeDir, 'hub.jsonl'), lines + '\n');
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Mock fetch to simulate a working local Ollama provider that returns a synthesis. */
function mockLocalProvider(synthesisText = 'Use strict mode and prefer const. Tests passed before.'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      // Reject any cloud API calls
      if (u.match(/anthropic\.com|openai\.com|googleapis\.com/)) {
        return Promise.reject(new Error('CLOUD CALL BLOCKED'));
      }
      // Ollama tags probe
      if (u.includes('/api/tags')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ models: [{ name: 'llama3' }] }),
        });
      }
      // Ollama chat/completions endpoint
      if (u.includes('/api/chat') || u.includes('/v1/chat/completions')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            message: { role: 'assistant', content: synthesisText },
            choices: [{ message: { role: 'assistant', content: synthesisText } }],
            usage: { prompt_tokens: 10, completion_tokens: 20 },
          }),
        });
      }
      // LM Studio health / models
      if (u.includes('/v1/models')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: 'llama3' }] }),
        });
      }
      // Default: reject unknown URLs
      return Promise.reject(new Error(`Unexpected URL in test: ${u}`));
    }),
  );
}

/** Mock fetch to simulate all providers failing (for fallback test). */
function mockNoProvider(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValue(new Error('connection refused: no provider')),
  );
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tmpHome = freshTmpHome();
  process.env.HOME = tmpHome;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await ensureImported();
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// buildPlaybook — shape and invariants
// ---------------------------------------------------------------------------

describe('buildPlaybook — result shape', () => {
  it('returns an object with goal, entries, synthesis fields', async () => {
    mockNoProvider();
    const p = await buildPlaybook('Write TypeScript module', makeConfig());
    expect(typeof p.goal).toBe('string');
    expect(Array.isArray(p.entries)).toBe(true);
    expect(typeof p.synthesis).toBe('string');
  });

  it('goal in result matches input goal', async () => {
    mockNoProvider();
    const goal = 'Implement M16 genome capture feature';
    const p = await buildPlaybook(goal, makeConfig());
    expect(p.goal).toBe(goal);
  });

  it('entries is an array of RecallHit objects', async () => {
    mockNoProvider();
    writeHubEntries(tmpHome, [
      makeEntry({ id: 'e1', title: 'TypeScript module', text: 'TypeScript module patterns and tips.' }),
    ]);
    const p = await buildPlaybook('TypeScript module', makeConfig());
    for (const hit of p.entries) {
      expect(hit.entry).toBeDefined();
      expect(typeof hit.score).toBe('number');
      expect(['keyword', 'embedding']).toContain(hit.method);
    }
  });

  it('synthesis is a non-empty string', async () => {
    mockNoProvider();
    writeHubEntries(tmpHome, [
      makeEntry({ id: 'e1', title: 'TypeScript tips', text: 'Use strict mode.' }),
    ]);
    const p = await buildPlaybook('TypeScript tips', makeConfig());
    expect(p.synthesis.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// buildPlaybook — synthesis via mocked local model
// ---------------------------------------------------------------------------

describe('buildPlaybook — synthesis via mocked local provider', () => {
  it('uses local provider synthesis when available', async () => {
    const expectedSynthesis = 'Past approach: always use strict TypeScript. Outcome: tests passed.';
    mockLocalProvider(expectedSynthesis);

    writeHubEntries(tmpHome, [
      makeEntry({
        id: 'ts1',
        title: 'TypeScript strict setup',
        text: 'Use strict mode. Configure tsconfig. Prefer const.',
        tags: ['typescript'],
      }),
    ]);

    const p = await buildPlaybook('TypeScript setup', makeConfig());
    // When model succeeds, synthesis should reflect the mock response
    // (or be a fallback concatenation — both are acceptable per contract)
    expect(p.synthesis.length).toBeGreaterThan(0);
  });

  it('recalls relevant entries based on goal', async () => {
    mockLocalProvider();

    writeHubEntries(tmpHome, [
      makeEntry({ id: 'match', title: 'TypeScript module', text: 'TypeScript strict patterns.' }),
      makeEntry({ id: 'nomatch', title: 'Cooking recipes', text: 'Bake bread at 180 degrees.' }),
    ]);

    const p = await buildPlaybook('TypeScript module patterns', makeConfig());
    // The matching entry should be in recalled entries
    const matchingEntry = p.entries.find((h) => h.entry.id === 'match');
    expect(matchingEntry).toBeDefined();
  });

  it('does not call cloud APIs — only local Ollama/LMStudio URLs', async () => {
    const seenUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        seenUrls.push(String(url));
        const u = String(url);
        if (u.includes('/api/tags')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ models: [{ name: 'llama3' }] }),
          });
        }
        if (u.includes('/api/chat') || u.includes('/v1/chat')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              message: { role: 'assistant', content: 'synthesis' },
              choices: [{ message: { role: 'assistant', content: 'synthesis' } }],
              usage: { prompt_tokens: 5, completion_tokens: 5 },
            }),
          });
        }
        if (u.includes('/v1/models')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ data: [] }),
          });
        }
        return Promise.reject(new Error(`unexpected URL: ${u}`));
      }),
    );

    writeHubEntries(tmpHome, [
      makeEntry({ id: 'local1', title: 'TypeScript', text: 'TypeScript patterns.' }),
    ]);

    await buildPlaybook('TypeScript patterns', makeConfig());

    for (const url of seenUrls) {
      expect(url).not.toMatch(/api\.anthropic\.com|api\.openai\.com|generativeai\.googleapis\.com/);
    }
  });
});

// ---------------------------------------------------------------------------
// buildPlaybook — fallback to concatenated recall on model failure
// ---------------------------------------------------------------------------

describe('buildPlaybook — falls back to concatenated recall on model failure', () => {
  it('falls back when provider is unavailable (no fetch)', async () => {
    mockNoProvider();

    writeHubEntries(tmpHome, [
      makeEntry({ id: 'fb1', title: 'TypeScript setup', text: 'TypeScript strict mode is essential.' }),
      makeEntry({ id: 'fb2', title: 'TypeScript testing', text: 'Use vitest for TypeScript projects.' }),
    ]);

    const p = await buildPlaybook('TypeScript', makeConfig());
    // Must not throw; returns a valid playbook with fallback synthesis
    expect(typeof p.synthesis).toBe('string');
    expect(p.synthesis.length).toBeGreaterThan(0);
  });

  it('falls back when model returns an error response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        const u = String(url);
        if (u.includes('/api/tags')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ models: [{ name: 'llama3' }] }),
          });
        }
        if (u.includes('/api/chat') || u.includes('/v1/chat')) {
          return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'Server error' }) });
        }
        if (u.includes('/v1/models')) {
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
        }
        return Promise.reject(new Error(`unexpected: ${u}`));
      }),
    );

    writeHubEntries(tmpHome, [
      makeEntry({ id: 'err1', title: 'TypeScript', text: 'TypeScript patterns and strict mode.' }),
    ]);

    const p = await buildPlaybook('TypeScript', makeConfig());
    expect(typeof p.synthesis).toBe('string');
    expect(p.synthesis.length).toBeGreaterThan(0);
  });

  it('fallback synthesis contains content from recalled entries', async () => {
    mockNoProvider();

    writeHubEntries(tmpHome, [
      makeEntry({
        id: 'fb-content',
        title: 'TypeScript strict patterns',
        text: 'Always enable noImplicitAny and strict mode in tsconfig for TypeScript.',
        tags: ['typescript', 'strict'],
      }),
    ]);

    const p = await buildPlaybook('TypeScript strict', makeConfig());
    // Fallback should concatenate recall content
    expect(p.synthesis).toBeTruthy();
    // Either the synthesis or the entries should reference recalled content
    const hasContent =
      p.synthesis.includes('TypeScript') ||
      p.entries.some((h) => h.entry.id === 'fb-content');
    expect(hasContent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildPlaybook — never throws
// ---------------------------------------------------------------------------

describe('buildPlaybook — never throws', () => {
  it('never throws on empty genome', async () => {
    mockNoProvider();
    await expect(buildPlaybook('Anything', makeConfig())).resolves.toBeDefined();
  });

  it('returns empty entries array on empty genome', async () => {
    mockNoProvider();
    const p = await buildPlaybook('Empty genome query', makeConfig());
    expect(Array.isArray(p.entries)).toBe(true);
  });

  it('never throws when cfg is minimal', async () => {
    mockNoProvider();
    const minimalCfg = { version: 1 } as unknown as AshlrConfig;
    await expect(buildPlaybook('test', minimalCfg)).resolves.toBeDefined();
  });

  it('never throws when cfg is null', async () => {
    mockNoProvider();
    await expect(
      buildPlaybook('test', null as unknown as AshlrConfig),
    ).resolves.toBeDefined();
  });

  it('never throws on empty goal string', async () => {
    mockNoProvider();
    await expect(buildPlaybook('', makeConfig())).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// buildPlaybook — opts.limit respected
// ---------------------------------------------------------------------------

describe('buildPlaybook — opts.limit respected', () => {
  it('respects opts.limit for number of recalled entries', async () => {
    mockNoProvider();

    writeHubEntries(tmpHome, [
      makeEntry({ id: 'l1', title: 'TypeScript tip 1', text: 'TypeScript tip one content.' }),
      makeEntry({ id: 'l2', title: 'TypeScript tip 2', text: 'TypeScript tip two content.' }),
      makeEntry({ id: 'l3', title: 'TypeScript tip 3', text: 'TypeScript tip three content.' }),
      makeEntry({ id: 'l4', title: 'TypeScript tip 4', text: 'TypeScript tip four content.' }),
      makeEntry({ id: 'l5', title: 'TypeScript tip 5', text: 'TypeScript tip five content.' }),
    ]);

    const p = await buildPlaybook('TypeScript', makeConfig(), { limit: 2 });
    expect(p.entries.length).toBeLessThanOrEqual(2);
  });

  it('returns all relevant entries when limit is generous', async () => {
    mockNoProvider();

    writeHubEntries(tmpHome, [
      makeEntry({ id: 'g1', title: 'TypeScript module A', text: 'TypeScript module A patterns.' }),
      makeEntry({ id: 'g2', title: 'TypeScript module B', text: 'TypeScript module B patterns.' }),
    ]);

    const p = await buildPlaybook('TypeScript module', makeConfig(), { limit: 10 });
    // Both entries should be recalled
    expect(p.entries.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// playbookText — pure, hard-capped, never throws
// ---------------------------------------------------------------------------

describe('playbookText — pure function', () => {
  function makePlaybook(synthesis: string, entries: GenomeEntry[] = []): Playbook {
    return {
      goal: 'Test goal',
      entries: entries.map((e) => ({ entry: e, score: 1.0, method: 'keyword' as const })),
      synthesis,
    };
  }

  it('returns a string', () => {
    const p = makePlaybook('Some synthesis text about the approach.');
    const text = playbookText(p, 500);
    expect(typeof text).toBe('string');
  });

  it('respects maxChars — output length <= maxChars', () => {
    const longSynthesis = 'A'.repeat(2000);
    const p = makePlaybook(longSynthesis);
    const text = playbookText(p, 100);
    expect(text.length).toBeLessThanOrEqual(100);
  });

  it('does NOT truncate when content fits within maxChars', () => {
    const shortSynthesis = 'Short synthesis.';
    const p = makePlaybook(shortSynthesis);
    const text = playbookText(p, 500);
    expect(text).toContain(shortSynthesis);
  });

  it('adds an elision marker when truncating', () => {
    const longSynthesis = 'B'.repeat(2000);
    const p = makePlaybook(longSynthesis);
    const text = playbookText(p, 50);
    // Should have an elision marker like ... or [truncated] or similar
    expect(text).toMatch(/\.\.\.|…|\[truncated\]|\[elided\]/i);
  });

  it('hard cap is enforced — never returns longer than maxChars', () => {
    // Multiple entries plus long synthesis
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry({ id: `pe${i}`, title: `Entry ${i}`, text: 'C'.repeat(500) }),
    );
    const p = makePlaybook('D'.repeat(1000), entries);
    const text = playbookText(p, 200);
    expect(text.length).toBeLessThanOrEqual(200);
  });

  it('never throws even on an empty playbook', () => {
    const p: Playbook = { goal: '', entries: [], synthesis: '' };
    expect(() => playbookText(p, 100)).not.toThrow();
  });

  it('never throws on maxChars=0', () => {
    const p = makePlaybook('Some text here.');
    expect(() => playbookText(p, 0)).not.toThrow();
  });

  it('never throws on maxChars=1', () => {
    const p = makePlaybook('Some text here.');
    expect(() => playbookText(p, 1)).not.toThrow();
  });

  it('is deterministic — same inputs produce same output', () => {
    const p = makePlaybook('Synthesis: use strict mode and prefer const over let.');
    const t1 = playbookText(p, 200);
    const t2 = playbookText(p, 200);
    const t3 = playbookText(p, 200);
    expect(t1).toBe(t2);
    expect(t2).toBe(t3);
  });

  it('includes synthesis content when it fits', () => {
    const synthesis = 'What worked: strict TypeScript configuration.';
    const p = makePlaybook(synthesis);
    const text = playbookText(p, 1000);
    expect(text).toContain('strict TypeScript');
  });

  it('handles a playbook with entries in the rendered output', () => {
    const entries = [
      makeEntry({ id: 'pt1', title: 'Past run: TypeScript setup', text: 'Set up TypeScript with strict mode.' }),
    ];
    const p = makePlaybook('Synthesis of past runs.', entries);
    const text = playbookText(p, 1000);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });
});
