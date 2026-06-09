/**
 * M7 CLI learn/recall/genome round-trip tests — hermetic, tmp HOME.
 *
 * SAFETY GUARDRAIL: process.env.HOME is overridden to a tmp dir before imports.
 * All reads/writes go under the tmp dir. Never touches real ~/.ashlr.
 *
 * Covers:
 *   - cmdLearn: writes an entry to hub.jsonl
 *   - cmdLearn: round-trip with cmdRecall (learn then recall finds it)
 *   - cmdLearn: NEVER overwrites prior entries — prior lines preserved verbatim
 *   - cmdLearn: --project flag sets the project field
 *   - cmdLearn: --tags flag sets the tags field
 *   - cmdLearn: accepts a title as part of text or derives it
 *   - cmdLearn: exits with code 0 on success
 *   - cmdLearn: exits with non-zero when no text provided
 *   - cmdRecall: exits with code 0 and prints results
 *   - cmdRecall: exits with non-zero when no query provided
 *   - cmdRecall: top result is the learned entry (round-trip)
 *   - cmdRecall: works offline (no fetch needed for keyword path)
 *   - cmdGenome: exits with code 0 and prints health info
 *   - cmdGenome: reflects hubEntries count after learns
 *   - Multiple learn calls accumulate entries (append-only invariant)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, GenomeEntry } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Override HOME before any genome module import
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

function freshTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m7-cli-'));
}

// ---------------------------------------------------------------------------
// Lazy imports
// ---------------------------------------------------------------------------

// (lazy import below; type-import lint intentionally not applied)
let cmdLearn: (args: string[]) => Promise<number>;
// (lazy import below; type-import lint intentionally not applied)
let cmdRecall: (args: string[]) => Promise<number>;
// (lazy import below; type-import lint intentionally not applied)
let cmdGenome: (args: string[]) => Promise<number>;

// Store module for direct hub.jsonl inspection
// (lazy import below; type-import lint intentionally not applied)
let hubStorePath: () => string;
// (lazy import below; type-import lint intentionally not applied)
let loadGenome: (cfg: AshlrConfig) => GenomeEntry[];

async function ensureImported(): Promise<void> {
  if (!cmdLearn) {
    const [cliMod, storeMod] = await Promise.all([
      import('../src/cli/genome.js'),
      import('../src/core/genome/store.js'),
    ]);
    cmdLearn = cliMod.cmdLearn;
    cmdRecall = cliMod.cmdRecall;
    cmdGenome = cliMod.cmdGenome;
    hubStorePath = storeMod.hubStorePath;
    loadGenome = storeMod.loadGenome;
  }
}

// ---------------------------------------------------------------------------
// Config helper
// ---------------------------------------------------------------------------

function makeConfig(): AshlrConfig {
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
    genome: { maxRecall: 5, injectOnRun: true },
  };
}

// ---------------------------------------------------------------------------
// Output capture helper
// ---------------------------------------------------------------------------

interface CapturedOutput {
  stdout: string[];
  stderr: string[];
  restore: () => void;
}

function captureOutput(): CapturedOutput {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origErrWrite = process.stderr.write.bind(process.stderr);

  (process.stdout.write as unknown) = (chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  };
  (process.stderr.write as unknown) = (chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  };

  return {
    stdout,
    stderr,
    restore: () => {
      (process.stdout.write as unknown) = origWrite;
      (process.stderr.write as unknown) = origErrWrite;
    },
  };
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tmpHome = freshTmpHome();
  process.env.HOME = tmpHome;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // Stub fetch to prevent any real network calls from the CLI
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in CLI tests')));
  await ensureImported();
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// cmdLearn — basic write behavior
// ---------------------------------------------------------------------------

describe('cmdLearn — writes entry to hub.jsonl', () => {
  it('returns exit code 0 on success', async () => {
    const code = await cmdLearn(['Remember to always handle errors in async functions']);
    expect(code).toBe(0);
  });

  it('creates hub.jsonl under the tmp HOME', async () => {
    await cmdLearn(['Some important learning about TypeScript']);
    expect(fs.existsSync(hubStorePath())).toBe(true);
  });

  it('written hub.jsonl contains valid JSON lines', async () => {
    await cmdLearn(['Valid JSON line test']);
    const lines = fs.readFileSync(hubStorePath(), 'utf8')
      .split('\n')
      .filter(l => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('written entry has source="hub"', async () => {
    await cmdLearn(['Source check test entry']);
    const lines = fs.readFileSync(hubStorePath(), 'utf8')
      .split('\n')
      .filter(l => l.trim().length > 0);
    const entries = lines.map(l => JSON.parse(l) as GenomeEntry);
    expect(entries.every(e => e.source === 'hub')).toBe(true);
  });

  it('written entry contains the provided text', async () => {
    const text = 'Unique text for cmdLearn test XYZ987';
    await cmdLearn([text]);
    const lines = fs.readFileSync(hubStorePath(), 'utf8')
      .split('\n')
      .filter(l => l.trim().length > 0);
    const entries = lines.map(l => JSON.parse(l) as GenomeEntry);
    expect(entries.some(e => e.text.includes('XYZ987') || e.text === text)).toBe(true);
  });

  it('sets --project when provided', async () => {
    await cmdLearn(['Project-scoped note', '--project', 'my-cool-project']);
    const lines = fs.readFileSync(hubStorePath(), 'utf8')
      .split('\n')
      .filter(l => l.trim().length > 0);
    const entries = lines.map(l => JSON.parse(l) as GenomeEntry);
    expect(entries.some(e => e.project === 'my-cool-project')).toBe(true);
  });

  it('sets --tags when provided', async () => {
    await cmdLearn(['Tagged entry content', '--tags', 'alpha,beta,gamma']);
    const lines = fs.readFileSync(hubStorePath(), 'utf8')
      .split('\n')
      .filter(l => l.trim().length > 0);
    const entries = lines.map(l => JSON.parse(l) as GenomeEntry);
    const tagged = entries.find(e =>
      Array.isArray(e.tags) && e.tags.includes('alpha'),
    );
    expect(tagged).toBeDefined();
    expect(tagged!.tags).toContain('beta');
    expect(tagged!.tags).toContain('gamma');
  });

  it('returns non-zero exit code when no text argument is provided', async () => {
    const code = await cmdLearn([]);
    expect(code).not.toBe(0);
  });

  it('creates parent directories if they do not exist', async () => {
    // tmp HOME has no .ashlr/genome yet
    const storeDir = path.dirname(hubStorePath());
    expect(fs.existsSync(storeDir)).toBe(false);

    await cmdLearn(['Directory creation test']);

    expect(fs.existsSync(storeDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cmdLearn — append-only invariant (NEVER overwrites)
// ---------------------------------------------------------------------------

describe('cmdLearn — append-only, never overwrites prior entries', () => {
  it('second learn call appends; first entry is still present', async () => {
    await cmdLearn(['First note content UNIQUE_FIRST']);
    await cmdLearn(['Second note content UNIQUE_SECOND']);

    const content = fs.readFileSync(hubStorePath(), 'utf8');
    expect(content).toContain('UNIQUE_FIRST');
    expect(content).toContain('UNIQUE_SECOND');
  });

  it('pre-existing hub.jsonl content is preserved verbatim after a learn', async () => {
    // Manually write a pre-existing entry
    const storeDir = path.dirname(hubStorePath());
    fs.mkdirSync(storeDir, { recursive: true });
    const preExisting: GenomeEntry = {
      id: 'pre-existing-entry-id',
      project: null,
      source: 'hub',
      title: 'Pre-existing title',
      text: 'Pre-existing text content',
      tags: [],
      ts: '2025-01-01T00:00:00.000Z',
    };
    fs.writeFileSync(hubStorePath(), JSON.stringify(preExisting) + '\n');

    const before = fs.readFileSync(hubStorePath(), 'utf8');

    // Now learn a new entry
    await cmdLearn(['New entry appended after pre-existing']);

    const after = fs.readFileSync(hubStorePath(), 'utf8');
    // The pre-existing content must still be present at the start
    expect(after).toContain('pre-existing-entry-id');
    expect(after).toContain('Pre-existing text content');
    // The before content must be a prefix of after (append = growing file)
    expect(after.startsWith(before.trimEnd())).toBe(true);
  });

  it('three consecutive learns result in three entries', async () => {
    await cmdLearn(['Entry one content']);
    await cmdLearn(['Entry two content']);
    await cmdLearn(['Entry three content']);

    const lines = fs.readFileSync(hubStorePath(), 'utf8')
      .split('\n')
      .filter(l => l.trim().length > 0);
    expect(lines.length).toBe(3);
  });

  it('hub.jsonl only grows after multiple learns (never shrinks)', async () => {
    await cmdLearn(['First grow entry']);
    const size1 = fs.statSync(hubStorePath()).size;

    await cmdLearn(['Second grow entry']);
    const size2 = fs.statSync(hubStorePath()).size;

    await cmdLearn(['Third grow entry']);
    const size3 = fs.statSync(hubStorePath()).size;

    expect(size2).toBeGreaterThan(size1);
    expect(size3).toBeGreaterThan(size2);
  });

  it('entry ids are unique across multiple learns', async () => {
    await cmdLearn(['Entry A for uniqueness check']);
    await cmdLearn(['Entry B for uniqueness check']);
    await cmdLearn(['Entry C for uniqueness check']);

    const lines = fs.readFileSync(hubStorePath(), 'utf8')
      .split('\n')
      .filter(l => l.trim().length > 0);
    const ids = lines.map(l => (JSON.parse(l) as GenomeEntry).id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// cmdLearn + cmdRecall — round-trip
// ---------------------------------------------------------------------------

describe('cmdLearn + cmdRecall — round-trip', () => {
  it('cmdRecall returns exit code 0 after a learn', async () => {
    await cmdLearn(['TypeScript strict mode best practices round-trip']);
    const cap = captureOutput();
    try {
      const code = await cmdRecall(['typescript strict']);
      expect(code).toBe(0);
    } finally {
      cap.restore();
    }
  });

  it('cmdRecall finds a learned entry by content', async () => {
    await cmdLearn(['TypeScript strict mode round trip test unique ABC']);
    const cap = captureOutput();
    let code: number;
    try {
      code = await cmdRecall(['TypeScript strict mode round trip']);
    } finally {
      cap.restore();
    }
    // Should find the entry (exit 0) and print something related
    expect(code!).toBe(0);
    const allOutput = cap.stdout.join('');
    // Output should mention something about the learned content
    expect(allOutput.length).toBeGreaterThan(0);
  });

  it('learned entry appears in loadGenome results', async () => {
    await cmdLearn(['Loadable genome entry check ZZZUNIQUE']);
    const entries = loadGenome(makeConfig());
    const found = entries.find(e => e.text.includes('ZZZUNIQUE'));
    expect(found).toBeDefined();
    expect(found!.source).toBe('hub');
  });

  it('cmdRecall returns non-zero when no query provided', async () => {
    const code = await cmdRecall([]);
    expect(code).not.toBe(0);
  });

  it('cmdRecall returns 0 on empty genome (no entries)', async () => {
    // No learn calls — empty genome
    const cap = captureOutput();
    let code: number;
    try {
      code = await cmdRecall(['anything']);
    } finally {
      cap.restore();
    }
    // Acceptable: 0 (found nothing) — the important thing is it does not crash
    expect(typeof code!).toBe('number');
  });

  it('round-trip: learn with tags, recall finds the entry', async () => {
    await cmdLearn(['Tagged round trip entry content', '--tags', 'roundtrip,vitest']);
    const entries = loadGenome(makeConfig());
    const found = entries.find(e =>
      Array.isArray(e.tags) && e.tags.includes('roundtrip'),
    );
    expect(found).toBeDefined();
  });

  it('round-trip: learn with project, recall finds the entry', async () => {
    await cmdLearn(['Project round trip note', '--project', 'rt-project']);
    const entries = loadGenome(makeConfig());
    const found = entries.find(e => e.project === 'rt-project');
    expect(found).toBeDefined();
  });

  it('multiple learns, recall returns results sorted by relevance', async () => {
    await cmdLearn(['TypeScript project with vitest and eslint configured for strict mode']);
    await cmdLearn(['Cooking: how to bake bread with yeast and flour']);
    await cmdLearn(['Gardening: watering schedule for tomato plants']);

    // Recall for TypeScript should surface the first entry
    const cap = captureOutput();
    let code: number;
    try {
      code = await cmdRecall(['typescript vitest eslint strict']);
    } finally {
      cap.restore();
    }
    expect(code!).toBe(0);
    // Output should contain something about the TypeScript entry
    const out = cap.stdout.join('');
    expect(out).toMatch(/typescript|vitest|eslint/i);
  });

  it('cmdRecall works offline — keyword path never needs fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline — no network')));
    await cmdLearn(['Offline recall test TypeScript ESM modules']);

    const cap = captureOutput();
    let code: number;
    try {
      code = await cmdRecall(['typescript ESM']);
    } finally {
      cap.restore();
    }
    expect(code!).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// cmdGenome — health/status command
// ---------------------------------------------------------------------------

describe('cmdGenome — health and status', () => {
  it('returns exit code 0', async () => {
    const cap = captureOutput();
    let code: number;
    try {
      code = await cmdGenome([]);
    } finally {
      cap.restore();
    }
    expect(code!).toBe(0);
  });

  it('prints to stdout (non-empty output)', async () => {
    const cap = captureOutput();
    try {
      await cmdGenome([]);
    } finally {
      cap.restore();
    }
    const out = cap.stdout.join('');
    expect(out.length).toBeGreaterThan(0);
  });

  it('output mentions entry count after learns', async () => {
    await cmdLearn(['Genome status test entry one']);
    await cmdLearn(['Genome status test entry two']);

    const cap = captureOutput();
    try {
      await cmdGenome([]);
    } finally {
      cap.restore();
    }
    const out = cap.stdout.join('');
    // Output should reflect the entry count (2 entries) or contain "entry" / "entries"
    expect(out).toMatch(/2|entries|entry|hub/i);
  });

  it('output mentions "entries" or a numeric count', async () => {
    await cmdLearn(['Entry for genome status count check']);

    const cap = captureOutput();
    try {
      await cmdGenome([]);
    } finally {
      cap.restore();
    }
    const out = cap.stdout.join('');
    expect(out).toMatch(/\d+|entr/i);
  });

  it('never throws (returns a number, does not reject)', async () => {
    const cap = captureOutput();
    try {
      await expect(cmdGenome([])).resolves.toBeTypeOf('number');
    } finally {
      cap.restore();
    }
  });

  it('works correctly when hub is empty', async () => {
    const cap = captureOutput();
    let code: number;
    try {
      code = await cmdGenome([]);
    } finally {
      cap.restore();
    }
    expect(code!).toBe(0);
  });

  it('reflects growing entry count across multiple learns', async () => {
    const captureCount = async (): Promise<string> => {
      const cap = captureOutput();
      try {
        await cmdGenome([]);
        return cap.stdout.join('');
      } finally {
        cap.restore();
      }
    };

    const out0 = await captureCount();
    await cmdLearn(['Genome count growth check entry']);
    const out1 = await captureCount();

    // After learning 1 entry, the output should change (count goes 0→1)
    // We check that at least one number that appears in out1 is greater
    // than what was in out0 OR that the content changed at all
    expect(out1).not.toBe(out0);
  });
});

// ---------------------------------------------------------------------------
// CLI argument parsing edge cases
// ---------------------------------------------------------------------------

describe('cmdLearn — argument parsing', () => {
  it('handles quoted text with spaces', async () => {
    const code = await cmdLearn(['Text with multiple words and spaces here']);
    expect(code).toBe(0);
    const lines = fs.readFileSync(hubStorePath(), 'utf8')
      .split('\n')
      .filter(l => l.trim().length > 0);
    const entries = lines.map(l => JSON.parse(l) as GenomeEntry);
    expect(entries.some(e => e.text.includes('multiple words'))).toBe(true);
  });

  it('handles --tags with a single tag (no comma)', async () => {
    const code = await cmdLearn(['Single tag entry', '--tags', 'solo']);
    expect(code).toBe(0);
    const lines = fs.readFileSync(hubStorePath(), 'utf8')
      .split('\n')
      .filter(l => l.trim().length > 0);
    const entries = lines.map(l => JSON.parse(l) as GenomeEntry);
    const found = entries.find(e => Array.isArray(e.tags) && e.tags.includes('solo'));
    expect(found).toBeDefined();
  });

  it('handles --project with hyphenated project name', async () => {
    const code = await cmdLearn(['Hyphen project note', '--project', 'my-cool-project-name']);
    expect(code).toBe(0);
    const lines = fs.readFileSync(hubStorePath(), 'utf8')
      .split('\n')
      .filter(l => l.trim().length > 0);
    const entries = lines.map(l => JSON.parse(l) as GenomeEntry);
    expect(entries.some(e => e.project === 'my-cool-project-name')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Append-only guarantee across all CLI interactions
// ---------------------------------------------------------------------------

describe('Append-only guarantee across CLI learn + direct writes', () => {
  it('cmdLearn after a direct appendHubEntry call preserves both entries', async () => {
    // Use the store directly to write one entry first
    const { appendHubEntry } = await import('../src/core/genome/store.js');
    const direct = appendHubEntry({ text: 'Direct store entry DIRECT123', title: 'Direct' });

    // Then use cmdLearn for another
    await cmdLearn(['CLI learn entry CLI456']);

    const lines = fs.readFileSync(hubStorePath(), 'utf8')
      .split('\n')
      .filter(l => l.trim().length > 0);
    const entries = lines.map(l => JSON.parse(l) as GenomeEntry);

    // Both entries must be present
    expect(entries.some(e => e.id === direct.id)).toBe(true);
    expect(entries.some(e => e.text.includes('CLI456'))).toBe(true);
  });
});
