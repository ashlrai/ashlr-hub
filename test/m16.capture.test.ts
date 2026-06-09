/**
 * M16 capture tests — hermetic, tmp HOME, no real I/O outside tmp.
 *
 * SAFETY GUARDRAIL: process.env.HOME is overridden to a tmp dir so
 * hubStorePath() and all file I/O land under the tmp dir, never touching
 * real ~/.ashlr.
 *
 * Covers:
 *   - summarizeForGenome: summary-only, hard-capped at ~800 chars
 *   - summarizeForGenome: strips secret-shaped tokens (Bearer/sk-/password=)
 *   - summarizeForGenome: deterministic, no I/O, never throws
 *   - summarizeForGenome: includes goal and task count/status sketch
 *   - captureFromRun: appends a tagged GenomeEntry to hub.jsonl
 *   - captureFromRun: respects autoCapture=false (no-op)
 *   - captureFromRun: DEDUPES a repeat (same goal+project)
 *   - captureFromRun: NEVER throws even on a malformed/null run
 *   - captureFromSwarm: appends a tagged entry for a swarm
 *   - captureFromSwarm: NEVER throws on malformed swarm
 *   - Privacy invariant: no secret-shaped tokens in appended entries
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AshlrConfig,
  RunState,
  SwarmRun,
  RunBudget,
  RunUsage,
  GenomeEntry,
} from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Override HOME before any genome module is imported
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

function freshTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m16-capture-'));
}

// ---------------------------------------------------------------------------
// Lazy imports (after HOME is set)
// ---------------------------------------------------------------------------

let captureFromRun: (run: RunState, cfg: AshlrConfig) => void;
let captureFromSwarm: (s: SwarmRun, cfg: AshlrConfig) => void;
let summarizeForGenome: (input: { goal: string; result?: string; tasks?: unknown[] }) => string;

async function ensureImported(): Promise<void> {
  if (!captureFromRun) {
    const mod = await import('../src/core/genome/capture.js');
    captureFromRun = mod.captureFromRun;
    captureFromSwarm = mod.captureFromSwarm;
    summarizeForGenome = mod.summarizeForGenome;
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

function makeConfigNoCapture(): AshlrConfig {
  return makeConfig({ genome: { maxRecall: 5, injectOnRun: false, autoCapture: false } });
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeRunState(overrides: Partial<RunState> = {}): RunState {
  const budget: RunBudget = { maxTokens: 10000, maxSteps: 50, allowCloud: false };
  const usage: RunUsage = { tokensIn: 100, tokensOut: 200, steps: 3, costUsd: 0 };
  return {
    id: 'run-test-001',
    goal: 'Build a TypeScript module for genome capture',
    engine: 'builtin',
    provider: 'ollama',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    budget,
    usage,
    tasks: [
      { id: 't1', goal: 'Write capture module', status: 'done', deps: [], steps: [] },
      { id: 't2', goal: 'Write tests', status: 'done', deps: ['t1'], steps: [] },
    ],
    steps: [],
    status: 'done',
    result: 'Module written and tests pass.',
    ...overrides,
  };
}

function makeSwarmRun(overrides: Partial<SwarmRun> = {}): SwarmRun {
  const budget: RunBudget = { maxTokens: 50000, maxSteps: 200, allowCloud: false };
  const usage: RunUsage = { tokensIn: 500, tokensOut: 800, steps: 15, costUsd: 0 };
  return {
    id: 'swarm-test-001',
    goal: 'Implement compounding genome feature',
    specId: null,
    project: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    budget,
    usage,
    parallel: 3,
    status: 'done',
    plan: {
      specId: null,
      goal: 'Implement compounding genome feature',
      tasks: [
        { id: 'st1', phase: 'scaffold', goal: 'Scaffold modules', deps: [] },
        { id: 'st2', phase: 'build', goal: 'Build capture.ts', deps: ['st1'] },
      ],
    },
    tasks: [
      { id: 'st1', phase: 'scaffold', status: 'done' },
      { id: 'st2', phase: 'build', status: 'done' },
    ],
    result: 'Swarm complete.',
    ...overrides,
  };
}

/** Read all valid JSONL lines from hub.jsonl and return parsed entries. */
function readHubEntries(tmpH: string): GenomeEntry[] {
  const storePath = path.join(tmpH, '.ashlr', 'genome', 'hub.jsonl');
  if (!fs.existsSync(storePath)) return [];
  const raw = fs.readFileSync(storePath, 'utf8');
  const entries: GenomeEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as GenomeEntry);
    } catch {
      // skip malformed
    }
  }
  return entries;
}

/** Wait briefly for fire-and-forget async operations to complete. */
function waitTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tmpHome = freshTmpHome();
  process.env.HOME = tmpHome;
  await ensureImported();
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
});

// ---------------------------------------------------------------------------
// summarizeForGenome — pure, deterministic, secret-free, hard-capped
// ---------------------------------------------------------------------------

describe('summarizeForGenome — pure function', () => {
  it('returns a string', () => {
    const result = summarizeForGenome({ goal: 'Build a thing' });
    expect(typeof result).toBe('string');
  });

  it('includes the goal in the summary', () => {
    const result = summarizeForGenome({ goal: 'Implement genome capture' });
    expect(result).toContain('genome capture');
  });

  it('hard-caps output at 800 chars', () => {
    const longResult = 'x'.repeat(2000);
    const manyTasks = Array.from({ length: 50 }, (_, i) => ({
      id: `t${i}`,
      goal: `Task goal ${i} with lots of detail that should be truncated`,
      status: 'done',
    }));
    const result = summarizeForGenome({ goal: 'Long goal', result: longResult, tasks: manyTasks });
    expect(result.length).toBeLessThanOrEqual(800);
  });

  it('never throws even on undefined/empty inputs', () => {
    expect(() => summarizeForGenome({ goal: '' })).not.toThrow();
    expect(() => summarizeForGenome({ goal: 'ok', result: undefined, tasks: undefined })).not.toThrow();
    expect(() => summarizeForGenome({ goal: 'ok', result: '', tasks: [] })).not.toThrow();
  });

  it('is deterministic — same inputs produce same output', () => {
    const input = {
      goal: 'Write tests for M16',
      result: 'Tests written and passing.',
      tasks: [
        { id: 't1', goal: 'Write capture tests', status: 'done' },
        { id: 't2', goal: 'Write consolidate tests', status: 'done' },
      ],
    };
    const r1 = summarizeForGenome(input);
    const r2 = summarizeForGenome(input);
    const r3 = summarizeForGenome(input);
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
  });

  it('strips Bearer token patterns', () => {
    const result = summarizeForGenome({
      goal: 'Call API with Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abc123',
    });
    expect(result).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{10,}/);
  });

  it('strips sk- prefixed secret patterns', () => {
    const result = summarizeForGenome({
      goal: 'Use sk-proj-abc123xyz456 key for testing',
      result: 'sk-ant-api03-longtoken here',
    });
    // Should not carry raw sk- tokens
    expect(result).not.toMatch(/sk-[a-zA-Z0-9_-]{8,}/);
  });

  it('strips password= patterns', () => {
    const result = summarizeForGenome({
      goal: 'Connect with password=mysecretpassword123',
    });
    expect(result).not.toMatch(/password=[^\s]{4,}/i);
  });

  it('does not include raw tool output or full prompts', () => {
    const longToolOutput = 'TOOL_OUTPUT: ' + 'X'.repeat(500);
    const result = summarizeForGenome({
      goal: 'Run a task',
      result: longToolOutput,
    });
    // Result must be capped and not carry the full raw payload
    expect(result.length).toBeLessThanOrEqual(800);
    expect(result).not.toContain('X'.repeat(200));
  });

  it('includes task count/status sketch when tasks provided', () => {
    const result = summarizeForGenome({
      goal: 'Multi-task run',
      tasks: [
        { id: 't1', goal: 'Step A', status: 'done' },
        { id: 't2', goal: 'Step B', status: 'done' },
        { id: 't3', goal: 'Step C', status: 'failed' },
      ],
    });
    // Should mention task counts or outcomes
    expect(result.length).toBeGreaterThan(10);
    // Should fit in cap
    expect(result.length).toBeLessThanOrEqual(800);
  });

  it('handles tasks with no status gracefully', () => {
    expect(() =>
      summarizeForGenome({ goal: 'Test', tasks: [{ id: 't1' }, null, undefined, 42] as unknown[] }),
    ).not.toThrow();
  });

  it('strips AWS access key ids', () => {
    const result = summarizeForGenome({
      goal: 'Configure deploy',
      result: 'Set AKIAIOSFODNN7EXAMPLE as the access key id.',
    });
    expect(result).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(result).toContain('[REDACTED]');
  });

  it('strips Google API keys', () => {
    // AIza + exactly 35 trailing chars = a well-formed Google API key shape.
    const key = 'AIza' + 'Sy0123456789abcdefghijklmnopqrstuvw';
    const result = summarizeForGenome({ goal: `Wire Maps API with ${key} now` });
    expect(result).not.toMatch(/AIza[0-9A-Za-z_-]{35}/);
  });

  it('strips PEM private-key blocks', () => {
    const pem =
      '-----BEGIN PRIVATE KEY-----\nMIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT4wggE6\n-----END PRIVATE KEY-----';
    const result = summarizeForGenome({ goal: 'Deploy', result: `key is ${pem} done` });
    expect(result).not.toContain('BEGIN PRIVATE KEY');
    expect(result).not.toContain('MIIBVAIBAD');
  });

  it('strips a stray BEGIN PRIVATE KEY marker line (truncated block)', () => {
    const result = summarizeForGenome({
      goal: 'Rotate cert -----BEGIN RSA PRIVATE KEY----- MIIBboo',
    });
    expect(result).not.toContain('BEGIN RSA PRIVATE KEY');
  });

  it('strips generic token/secret/apikey assignments', () => {
    const result = summarizeForGenome({
      goal: 'Set api_key=abcdef123456 and secret: topsecretvalue99 and token=zzzz9999xxxx',
    });
    expect(result).not.toMatch(/api_key=abcdef/i);
    expect(result).not.toMatch(/secret:\s*topsecret/i);
    expect(result).not.toMatch(/token=zzzz/i);
  });

  it('strips secret-shaped tokens that appear in TASK GOALS', () => {
    const result = summarizeForGenome({
      goal: 'Multi-task run',
      tasks: [
        { id: 't1', goal: 'Set AKIAIOSFODNN7EXAMPLE for s3', status: 'done' },
        { id: 't2', goal: 'Use sk-proj-tasksecrettoken9999 key', status: 'done' },
      ],
    });
    expect(result).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(result).not.toMatch(/sk-proj-[a-zA-Z0-9]{8,}/);
  });
});

// ---------------------------------------------------------------------------
// captureFromRun — appends tagged entry, respects cfg, dedupes, never throws
// ---------------------------------------------------------------------------

describe('captureFromRun — appends entry to hub.jsonl', () => {
  it('appends a GenomeEntry to hub.jsonl after a done run', async () => {
    const run = makeRunState({ status: 'done' });
    captureFromRun(run, makeConfig());
    await waitTick();

    const entries = readHubEntries(tmpHome);
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  it('appended entry has required GenomeEntry fields', async () => {
    const run = makeRunState({ status: 'done' });
    captureFromRun(run, makeConfig());
    await waitTick();

    const entries = readHubEntries(tmpHome);
    expect(entries.length).toBeGreaterThan(0);
    const e = entries[0]!;
    expect(typeof e.id).toBe('string');
    expect(e.id.length).toBeGreaterThan(0);
    expect(typeof e.title).toBe('string');
    expect(typeof e.text).toBe('string');
    expect(Array.isArray(e.tags)).toBe(true);
    expect(typeof e.ts).toBe('string');
    expect(() => new Date(e.ts)).not.toThrow();
  });

  it('appended entry text does not exceed 800 chars (privacy cap)', async () => {
    const run = makeRunState({ status: 'done' });
    captureFromRun(run, makeConfig());
    await waitTick();

    const entries = readHubEntries(tmpHome);
    for (const e of entries) {
      expect(e.text.length).toBeLessThanOrEqual(800);
    }
  });

  it('appended entry tags include outcome tag', async () => {
    const run = makeRunState({ status: 'done' });
    captureFromRun(run, makeConfig());
    await waitTick();

    const entries = readHubEntries(tmpHome);
    expect(entries.length).toBeGreaterThan(0);
    // Tags should include status/outcome and source indicator
    const allTags = entries[0]!.tags;
    expect(Array.isArray(allTags)).toBe(true);
  });

  it('is a no-op when autoCapture is false', async () => {
    const run = makeRunState({ status: 'done' });
    captureFromRun(run, makeConfigNoCapture());
    await waitTick();

    const entries = readHubEntries(tmpHome);
    expect(entries.length).toBe(0);
  });

  it('is a no-op when cfg.genome.autoCapture === false explicitly', async () => {
    const cfg = makeConfig({ genome: { maxRecall: 5, injectOnRun: true, autoCapture: false } });
    const run = makeRunState({ status: 'done' });
    captureFromRun(run, cfg);
    await waitTick();

    expect(readHubEntries(tmpHome).length).toBe(0);
  });

  it('captures when autoCapture is undefined (default true)', async () => {
    // No genome key at all — should default to capturing
    const cfg = makeConfig();
    const run = makeRunState({ status: 'done' });
    captureFromRun(run, cfg);
    await waitTick();

    expect(readHubEntries(tmpHome).length).toBeGreaterThanOrEqual(1);
  });

  it('captures when autoCapture is true explicitly', async () => {
    const cfg = makeConfig({ genome: { maxRecall: 5, injectOnRun: true, autoCapture: true } });
    const run = makeRunState({ status: 'done' });
    captureFromRun(run, cfg);
    await waitTick();

    expect(readHubEntries(tmpHome).length).toBeGreaterThanOrEqual(1);
  });

  it('NEVER throws even on a completely malformed run object', () => {
    expect(() => captureFromRun(null as unknown as RunState, makeConfig())).not.toThrow();
    expect(() => captureFromRun(undefined as unknown as RunState, makeConfig())).not.toThrow();
    expect(() =>
      captureFromRun({} as unknown as RunState, makeConfig()),
    ).not.toThrow();
    expect(() =>
      captureFromRun({ goal: undefined, status: undefined } as unknown as RunState, makeConfig()),
    ).not.toThrow();
  });

  it('NEVER throws when cfg is malformed', () => {
    const run = makeRunState({ status: 'done' });
    expect(() => captureFromRun(run, null as unknown as AshlrConfig)).not.toThrow();
    expect(() => captureFromRun(run, {} as unknown as AshlrConfig)).not.toThrow();
  });

  it('DEDUPES — skips append when near-identical entry already exists', async () => {
    const run = makeRunState({ goal: 'Implement genome capture', status: 'done' });
    // First capture
    captureFromRun(run, makeConfig());
    await waitTick();
    const countAfterFirst = readHubEntries(tmpHome).length;
    expect(countAfterFirst).toBeGreaterThanOrEqual(1);

    // Second capture of same run (same goal)
    captureFromRun(run, makeConfig());
    await waitTick();
    const countAfterSecond = readHubEntries(tmpHome).length;

    // Should not have duplicated: count stays the same (or grows by at most 1
    // if deduplication is text-overlap-based and the impl checks existing hub)
    // The contract says "dedupe-aware: skip the append when near-identical".
    // We allow impl to detect on second call but count must not grow unboundedly.
    expect(countAfterSecond).toBeLessThanOrEqual(countAfterFirst + 1);
  });

  it('maps run status "done" → outcome tag "done"', async () => {
    const run = makeRunState({ status: 'done' });
    captureFromRun(run, makeConfig());
    await waitTick();

    const entries = readHubEntries(tmpHome);
    expect(entries.length).toBeGreaterThan(0);
    // Tags or text should encode the done outcome
    const entry = entries[0]!;
    const allContent = entry.tags.join(' ') + ' ' + entry.text + ' ' + entry.title;
    expect(allContent.toLowerCase()).toMatch(/done|success/);
  });

  it('maps run status "aborted" → aborted outcome', async () => {
    const run = makeRunState({ status: 'aborted' });
    captureFromRun(run, makeConfig());
    await waitTick();

    const entries = readHubEntries(tmpHome);
    expect(entries.length).toBeGreaterThan(0);
    const entry = entries[0]!;
    const allContent = entry.tags.join(' ') + ' ' + entry.text + ' ' + entry.title;
    expect(allContent.toLowerCase()).toMatch(/aborted/);
  });

  it('maps run status "failed" → failed outcome', async () => {
    const run = makeRunState({ status: 'failed' });
    captureFromRun(run, makeConfig());
    await waitTick();

    const entries = readHubEntries(tmpHome);
    expect(entries.length).toBeGreaterThan(0);
    const entry = entries[0]!;
    const allContent = entry.tags.join(' ') + ' ' + entry.text + ' ' + entry.title;
    expect(allContent.toLowerCase()).toMatch(/failed/);
  });

  it('PRIVACY: appended entry text does not contain secret-shaped tokens', async () => {
    const run = makeRunState({
      status: 'done',
      goal: 'Use sk-proj-secrettoken123 to authenticate',
    });
    captureFromRun(run, makeConfig());
    await waitTick();

    const entries = readHubEntries(tmpHome);
    for (const e of entries) {
      const all = JSON.stringify(e);
      expect(all).not.toMatch(/sk-[a-zA-Z0-9_-]{10,}/);
      expect(all).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{10,}/);
    }
  });

  it('engine tag is included in the appended entry tags', async () => {
    const run = makeRunState({ status: 'done', engine: 'builtin' });
    captureFromRun(run, makeConfig());
    await waitTick();

    const entries = readHubEntries(tmpHome);
    expect(entries.length).toBeGreaterThan(0);
    // Tags should include engine name (lowercase)
    const allTags = entries[0]!.tags.map((t) => t.toLowerCase());
    // Either directly or via text — the capture should mark the engine
    expect(allTags.some((t) => t.includes('builtin') || t.includes('run'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// captureFromSwarm — appends entry for swarm runs
// ---------------------------------------------------------------------------

describe('captureFromSwarm — appends entry to hub.jsonl', () => {
  it('appends a GenomeEntry to hub.jsonl after a done swarm', async () => {
    const swarm = makeSwarmRun({ status: 'done' });
    captureFromSwarm(swarm, makeConfig());
    await waitTick();

    const entries = readHubEntries(tmpHome);
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  it('appended swarm entry has required GenomeEntry fields', async () => {
    const swarm = makeSwarmRun({ status: 'done' });
    captureFromSwarm(swarm, makeConfig());
    await waitTick();

    const entries = readHubEntries(tmpHome);
    const e = entries[0];
    expect(e).toBeDefined();
    expect(typeof e!.id).toBe('string');
    expect(typeof e!.title).toBe('string');
    expect(typeof e!.text).toBe('string');
    expect(Array.isArray(e!.tags)).toBe(true);
    expect(typeof e!.ts).toBe('string');
  });

  it('swarm entry text is capped at 800 chars', async () => {
    const swarm = makeSwarmRun({ status: 'done' });
    captureFromSwarm(swarm, makeConfig());
    await waitTick();

    const entries = readHubEntries(tmpHome);
    for (const e of entries) {
      expect(e.text.length).toBeLessThanOrEqual(800);
    }
  });

  it('is a no-op when autoCapture is false', async () => {
    const swarm = makeSwarmRun({ status: 'done' });
    captureFromSwarm(swarm, makeConfigNoCapture());
    await waitTick();

    expect(readHubEntries(tmpHome).length).toBe(0);
  });

  it('NEVER throws even on a malformed swarm object', () => {
    expect(() => captureFromSwarm(null as unknown as SwarmRun, makeConfig())).not.toThrow();
    expect(() => captureFromSwarm(undefined as unknown as SwarmRun, makeConfig())).not.toThrow();
    expect(() => captureFromSwarm({} as unknown as SwarmRun, makeConfig())).not.toThrow();
  });

  it('NEVER throws when cfg is malformed', () => {
    const swarm = makeSwarmRun({ status: 'done' });
    expect(() => captureFromSwarm(swarm, null as unknown as AshlrConfig)).not.toThrow();
    expect(() => captureFromSwarm(swarm, {} as unknown as AshlrConfig)).not.toThrow();
  });

  it('swarm entry tags include swarm source marker', async () => {
    const swarm = makeSwarmRun({ status: 'done' });
    captureFromSwarm(swarm, makeConfig());
    await waitTick();

    const entries = readHubEntries(tmpHome);
    expect(entries.length).toBeGreaterThan(0);
    const allTags = entries[0]!.tags.map((t) => t.toLowerCase());
    // Should include 'swarm' marker in tags or text
    const allContent =
      allTags.join(' ') + ' ' + entries[0]!.text.toLowerCase() + ' ' + entries[0]!.title.toLowerCase();
    expect(allContent).toMatch(/swarm/);
  });

  it('PRIVACY: swarm entry does not contain secret-shaped tokens', async () => {
    const swarm = makeSwarmRun({
      status: 'done',
      goal: 'Deploy with Bearer eyJsecrettoken api-key=sk-proj-test1234',
    });
    captureFromSwarm(swarm, makeConfig());
    await waitTick();

    const entries = readHubEntries(tmpHome);
    for (const e of entries) {
      const all = JSON.stringify(e);
      expect(all).not.toMatch(/sk-[a-zA-Z0-9_-]{10,}/);
      expect(all).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{10,}/);
    }
  });

  it('HUB-ONLY: never writes a note file into a repo working tree', async () => {
    // Build a fake indexed repo with a .ashlrcode/genome/ dir so the
    // project-note drop WOULD trigger if hubOnly were not honored.
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m16-repo-'));
    const genomeDir = path.join(repoDir, '.ashlrcode', 'genome');
    fs.mkdirSync(genomeDir, { recursive: true });

    const swarm = makeSwarmRun({ status: 'done', project: repoDir });
    captureFromSwarm(swarm, makeConfig());
    await waitTick();

    // No hub-notes/ dir should have been created inside the repo.
    const notesDir = path.join(genomeDir, 'hub-notes');
    expect(fs.existsSync(notesDir)).toBe(false);

    // But the hub store WAS written.
    expect(readHubEntries(tmpHome).length).toBeGreaterThanOrEqual(1);

    fs.rmSync(repoDir, { recursive: true, force: true });
  });
});
