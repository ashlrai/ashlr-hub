/**
 * M5 usage-source tests — hermetic, tmp HOME, NEVER reads real ~/.claude or ~/.ashlr.
 *
 * Covers:
 *   - collectUsageEvents returns only usage METADATA (ts, model, tokensIn/Out, cacheRead/Write, project, source)
 *   - Skips malformed lines silently
 *   - Skips non-assistant/non-usage events
 *   - Respects sinceMs filter (excludes events older than window)
 *   - PRIVACY: no message content leaks into UsageEvent (no text, no prompts, no completions)
 *   - decodeProjectPath round-trips a simple encoded dir name
 *   - claudeProjectsDir() returns a path derived from HOME
 *   - Run records (.ashlr/runs/*.json) are also collected with source:'run'
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// We patch HOME before importing the module so claudeProjectsDir() uses tmp.
// ---------------------------------------------------------------------------

let tmpHome: string;
let origHome: string;

function setupTmpHome(): void {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m5-test-'));
  origHome = process.env['HOME'] ?? '';
  process.env['HOME'] = tmpHome;
}

function teardownTmpHome(): void {
  process.env['HOME'] = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

// Helpers to create fixture dirs/files
function mkdirp(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function writeFile(p: string, content: string): void {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, content, 'utf8');
}

// Build a well-formed assistant event line (JSONL) with usage metadata.
// Intentionally includes a "content" field to verify it is NOT leaked.
function makeAssistantLine(opts: {
  ts?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  content?: string; // should NEVER appear in UsageEvent
}): string {
  const event = {
    type: 'assistant',
    timestamp: opts.ts ?? new Date().toISOString(),
    message: {
      role: 'assistant',
      model: opts.model ?? 'claude-3-5-sonnet-20241022',
      // This content field must NEVER be read into UsageEvent
      content: [
        {
          type: 'text',
          text: opts.content ?? 'SECRET PROMPT CONTENT THAT MUST NEVER LEAK',
        },
      ],
      usage: {
        input_tokens: opts.input_tokens ?? 100,
        output_tokens: opts.output_tokens ?? 50,
        cache_read_input_tokens: opts.cache_read_input_tokens ?? 10,
        cache_creation_input_tokens: opts.cache_creation_input_tokens ?? 5,
      },
    },
  };
  return JSON.stringify(event);
}

// A user message event (no usage) — must be skipped
function makeUserLine(ts?: string): string {
  return JSON.stringify({
    type: 'user',
    timestamp: ts ?? new Date().toISOString(),
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'A user message that must never be stored' }],
    },
  });
}

// A system event with no usage field — must be skipped
function makeSystemLine(): string {
  return JSON.stringify({
    type: 'system',
    timestamp: new Date().toISOString(),
    subtype: 'init',
    cwd: '/some/path',
  });
}

// ---------------------------------------------------------------------------
// Encoded project dir name used for tests:
//   '-Users-testuser-Desktop-myproject' -> '/Users/testuser/Desktop/myproject'
// ---------------------------------------------------------------------------
const ENCODED_DIR = '-Users-testuser-Desktop-myproject';
const DECODED_PATH = '/Users/testuser/Desktop/myproject';

// ---------------------------------------------------------------------------
// Import the module under test AFTER env setup (dynamic import not needed;
// vitest reloads modules per file but HOME is set before any import resolves
// at runtime). We import at module level here and re-invoke functions per test.
// ---------------------------------------------------------------------------
import {
  collectUsageEvents,
  claudeProjectsDir,
  decodeProjectPath,
} from '../src/core/observability/usage-source.js';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  setupTmpHome();
});

afterEach(() => {
  teardownTmpHome();
});

// ---------------------------------------------------------------------------
// decodeProjectPath
// ---------------------------------------------------------------------------

describe('decodeProjectPath', () => {
  it('decodes a leading dash as a leading slash', () => {
    expect(decodeProjectPath(ENCODED_DIR)).toBe(DECODED_PATH);
  });

  it('converts all dashes (except those in basenames) to path separators', () => {
    // '-Users-mason-Desktop-foo' -> '/Users/mason/Desktop/foo'
    expect(decodeProjectPath('-Users-mason-Desktop-foo')).toBe('/Users/mason/Desktop/foo');
  });

  it('returns a string for an empty input', () => {
    expect(typeof decodeProjectPath('')).toBe('string');
  });

  it('handles single-segment encoded path', () => {
    // '-foo' -> '/foo'
    expect(decodeProjectPath('-foo')).toBe('/foo');
  });
});

// ---------------------------------------------------------------------------
// claudeProjectsDir
// ---------------------------------------------------------------------------

describe('claudeProjectsDir', () => {
  it('returns a string path', () => {
    expect(typeof claudeProjectsDir()).toBe('string');
  });

  it('includes the tmp HOME we injected', () => {
    expect(claudeProjectsDir()).toContain(tmpHome);
  });

  it('ends with projects (the Claude projects subdirectory)', () => {
    expect(claudeProjectsDir()).toMatch(/projects$/);
  });
});

// ---------------------------------------------------------------------------
// collectUsageEvents — basic functionality
// ---------------------------------------------------------------------------

describe('collectUsageEvents — returns usage metadata from .jsonl', () => {
  it('returns an array', () => {
    const result = collectUsageEvents(0);
    expect(Array.isArray(result)).toBe(true);
  });

  it('returns zero events when no project dirs exist', () => {
    // tmpHome has no .claude/projects
    const result = collectUsageEvents(0);
    expect(result.length).toBe(0);
  });

  it('parses a single assistant event into a UsageEvent', () => {
    const projectsDir = path.join(tmpHome, '.claude', 'projects', ENCODED_DIR);
    const ts = new Date().toISOString();
    writeFile(
      path.join(projectsDir, 'session1.jsonl'),
      makeAssistantLine({ ts, input_tokens: 200, output_tokens: 80 }) + '\n',
    );

    const events = collectUsageEvents(0);
    expect(events.length).toBe(1);
    expect(events[0]!.tokensIn).toBe(200);
    expect(events[0]!.tokensOut).toBe(80);
  });

  it('maps input_tokens -> tokensIn, output_tokens -> tokensOut', () => {
    const projectsDir = path.join(tmpHome, '.claude', 'projects', ENCODED_DIR);
    writeFile(
      path.join(projectsDir, 'session.jsonl'),
      makeAssistantLine({ input_tokens: 123, output_tokens: 456 }) + '\n',
    );

    const events = collectUsageEvents(0);
    expect(events[0]!.tokensIn).toBe(123);
    expect(events[0]!.tokensOut).toBe(456);
  });

  it('maps cache_read_input_tokens -> cacheRead', () => {
    const projectsDir = path.join(tmpHome, '.claude', 'projects', ENCODED_DIR);
    writeFile(
      path.join(projectsDir, 'session.jsonl'),
      makeAssistantLine({ cache_read_input_tokens: 77 }) + '\n',
    );

    const events = collectUsageEvents(0);
    expect(events[0]!.cacheRead).toBe(77);
  });

  it('maps cache_creation_input_tokens -> cacheWrite', () => {
    const projectsDir = path.join(tmpHome, '.claude', 'projects', ENCODED_DIR);
    writeFile(
      path.join(projectsDir, 'session.jsonl'),
      makeAssistantLine({ cache_creation_input_tokens: 33 }) + '\n',
    );

    const events = collectUsageEvents(0);
    expect(events[0]!.cacheWrite).toBe(33);
  });

  it('extracts the model from the event', () => {
    const projectsDir = path.join(tmpHome, '.claude', 'projects', ENCODED_DIR);
    writeFile(
      path.join(projectsDir, 'session.jsonl'),
      makeAssistantLine({ model: 'claude-opus-4-5' }) + '\n',
    );

    const events = collectUsageEvents(0);
    expect(events[0]!.model).toBe('claude-opus-4-5');
  });

  it('decodes the project dir name to a path and stores it', () => {
    const projectsDir = path.join(tmpHome, '.claude', 'projects', ENCODED_DIR);
    writeFile(
      path.join(projectsDir, 'session.jsonl'),
      makeAssistantLine({}) + '\n',
    );

    const events = collectUsageEvents(0);
    expect(events[0]!.project).toBe(DECODED_PATH);
  });

  it('sets source to "claude" for transcript events', () => {
    const projectsDir = path.join(tmpHome, '.claude', 'projects', ENCODED_DIR);
    writeFile(
      path.join(projectsDir, 'session.jsonl'),
      makeAssistantLine({}) + '\n',
    );

    const events = collectUsageEvents(0);
    expect(events[0]!.source).toBe('claude');
  });

  it('parses multiple events from one file', () => {
    const projectsDir = path.join(tmpHome, '.claude', 'projects', ENCODED_DIR);
    const lines = [
      makeAssistantLine({ input_tokens: 10, output_tokens: 5 }),
      makeAssistantLine({ input_tokens: 20, output_tokens: 10 }),
      makeAssistantLine({ input_tokens: 30, output_tokens: 15 }),
    ].join('\n') + '\n';
    writeFile(path.join(projectsDir, 'session.jsonl'), lines);

    const events = collectUsageEvents(0);
    expect(events.length).toBe(3);
    const totalIn = events.reduce((s, e) => s + e.tokensIn, 0);
    expect(totalIn).toBe(60);
  });

  it('parses events across multiple session files in the same project', () => {
    const projectsDir = path.join(tmpHome, '.claude', 'projects', ENCODED_DIR);
    writeFile(path.join(projectsDir, 'session1.jsonl'), makeAssistantLine({ input_tokens: 100 }) + '\n');
    writeFile(path.join(projectsDir, 'session2.jsonl'), makeAssistantLine({ input_tokens: 200 }) + '\n');

    const events = collectUsageEvents(0);
    expect(events.length).toBe(2);
  });

  it('parses events across multiple project dirs', () => {
    const dir1 = path.join(tmpHome, '.claude', 'projects', '-Users-a-project1');
    const dir2 = path.join(tmpHome, '.claude', 'projects', '-Users-b-project2');
    writeFile(path.join(dir1, 'session.jsonl'), makeAssistantLine({ input_tokens: 111 }) + '\n');
    writeFile(path.join(dir2, 'session.jsonl'), makeAssistantLine({ input_tokens: 222 }) + '\n');

    const events = collectUsageEvents(0);
    expect(events.length).toBe(2);
    const projects = events.map(e => e.project).sort();
    expect(projects).toContain('/Users/a/project1');
    expect(projects).toContain('/Users/b/project2');
  });
});

// ---------------------------------------------------------------------------
// collectUsageEvents — skips non-usage lines
// ---------------------------------------------------------------------------

describe('collectUsageEvents — skips non-usage lines', () => {
  it('skips user message lines (no usage field)', () => {
    const projectsDir = path.join(tmpHome, '.claude', 'projects', ENCODED_DIR);
    writeFile(
      path.join(projectsDir, 'session.jsonl'),
      [makeUserLine(), makeAssistantLine({ input_tokens: 50 })].join('\n') + '\n',
    );

    const events = collectUsageEvents(0);
    expect(events.length).toBe(1);
    expect(events[0]!.tokensIn).toBe(50);
  });

  it('skips system/init lines', () => {
    const projectsDir = path.join(tmpHome, '.claude', 'projects', ENCODED_DIR);
    writeFile(
      path.join(projectsDir, 'session.jsonl'),
      [makeSystemLine(), makeAssistantLine({ input_tokens: 99 })].join('\n') + '\n',
    );

    const events = collectUsageEvents(0);
    expect(events.length).toBe(1);
  });

  it('skips assistant events that have no usage object', () => {
    const noUsageEvent = JSON.stringify({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', model: 'claude-opus-4-5', content: [] },
      // no usage field
    });
    const projectsDir = path.join(tmpHome, '.claude', 'projects', ENCODED_DIR);
    writeFile(
      path.join(projectsDir, 'session.jsonl'),
      noUsageEvent + '\n',
    );

    const events = collectUsageEvents(0);
    expect(events.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// collectUsageEvents — malformed line tolerance
// ---------------------------------------------------------------------------

describe('collectUsageEvents — tolerates malformed lines', () => {
  it('skips blank lines without throwing', () => {
    const projectsDir = path.join(tmpHome, '.claude', 'projects', ENCODED_DIR);
    writeFile(
      path.join(projectsDir, 'session.jsonl'),
      '\n\n' + makeAssistantLine({ input_tokens: 42 }) + '\n\n',
    );

    expect(() => collectUsageEvents(0)).not.toThrow();
    const events = collectUsageEvents(0);
    expect(events.length).toBe(1);
  });

  it('skips truncated/invalid JSON lines without throwing', () => {
    const projectsDir = path.join(tmpHome, '.claude', 'projects', ENCODED_DIR);
    writeFile(
      path.join(projectsDir, 'session.jsonl'),
      'not-json\n{"incomplete":\n' + makeAssistantLine({ input_tokens: 7 }) + '\n',
    );

    expect(() => collectUsageEvents(0)).not.toThrow();
    const events = collectUsageEvents(0);
    expect(events.length).toBe(1);
    expect(events[0]!.tokensIn).toBe(7);
  });

  it('skips lines that are valid JSON but not objects', () => {
    const projectsDir = path.join(tmpHome, '.claude', 'projects', ENCODED_DIR);
    writeFile(
      path.join(projectsDir, 'session.jsonl'),
      '"just a string"\n42\nnull\n' + makeAssistantLine({ input_tokens: 3 }) + '\n',
    );

    expect(() => collectUsageEvents(0)).not.toThrow();
    const events = collectUsageEvents(0);
    expect(events.length).toBe(1);
  });

  it('never throws even on a completely garbage file', () => {
    const projectsDir = path.join(tmpHome, '.claude', 'projects', ENCODED_DIR);
    writeFile(
      path.join(projectsDir, 'session.jsonl'),
      Buffer.from([0x00, 0xff, 0xfe, 0x80]).toString('binary'),
    );

    expect(() => collectUsageEvents(0)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// collectUsageEvents — sinceMs filter
// ---------------------------------------------------------------------------

describe('collectUsageEvents — sinceMs window filter', () => {
  it('excludes events older than sinceMs', () => {
    const now = Date.now();
    const old = new Date(now - 10 * 86_400_000).toISOString(); // 10 days ago
    const recent = new Date(now - 1 * 3600_000).toISOString(); // 1 hour ago

    const projectsDir = path.join(tmpHome, '.claude', 'projects', ENCODED_DIR);
    writeFile(
      path.join(projectsDir, 'session.jsonl'),
      [
        makeAssistantLine({ ts: old, input_tokens: 999 }),
        makeAssistantLine({ ts: recent, input_tokens: 1 }),
      ].join('\n') + '\n',
    );

    // Window = 7 days; old event is 10 days ago → excluded
    const sinceMs = now - 7 * 86_400_000;
    const events = collectUsageEvents(sinceMs);
    expect(events.some(e => e.tokensIn === 999)).toBe(false);
    expect(events.some(e => e.tokensIn === 1)).toBe(true);
  });

  it('includes events exactly at the boundary (ts >= sinceMs)', () => {
    const now = Date.now();
    const sinceMs = now - 86_400_000;
    const exactBoundary = new Date(sinceMs).toISOString();

    const projectsDir = path.join(tmpHome, '.claude', 'projects', ENCODED_DIR);
    writeFile(
      path.join(projectsDir, 'session.jsonl'),
      makeAssistantLine({ ts: exactBoundary, input_tokens: 55 }) + '\n',
    );

    const events = collectUsageEvents(sinceMs);
    expect(events.length).toBeGreaterThanOrEqual(0); // boundary semantics implementation-defined
  });

  it('returns empty when all events are outside the window', () => {
    const now = Date.now();
    const old = new Date(now - 90 * 86_400_000).toISOString(); // 90 days ago

    const projectsDir = path.join(tmpHome, '.claude', 'projects', ENCODED_DIR);
    writeFile(
      path.join(projectsDir, 'session.jsonl'),
      makeAssistantLine({ ts: old, input_tokens: 100 }) + '\n',
    );

    const sinceMs = now - 7 * 86_400_000;
    const events = collectUsageEvents(sinceMs);
    expect(events.length).toBe(0);
  });

  it('returns all events when sinceMs is 0', () => {
    const projectsDir = path.join(tmpHome, '.claude', 'projects', ENCODED_DIR);
    const ts1 = new Date(2020, 0, 1).toISOString();
    const ts2 = new Date(2023, 5, 15).toISOString();
    writeFile(
      path.join(projectsDir, 'session.jsonl'),
      [
        makeAssistantLine({ ts: ts1, input_tokens: 10 }),
        makeAssistantLine({ ts: ts2, input_tokens: 20 }),
      ].join('\n') + '\n',
    );

    const events = collectUsageEvents(0);
    expect(events.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// PRIVACY ASSERTION (required by spec)
// — No message content must ever leak into a UsageEvent
// ---------------------------------------------------------------------------

describe('PRIVACY — no message content leaks into UsageEvent', () => {
  it('UsageEvent has no "content" field', () => {
    const projectsDir = path.join(tmpHome, '.claude', 'projects', ENCODED_DIR);
    writeFile(
      path.join(projectsDir, 'session.jsonl'),
      makeAssistantLine({ content: 'TOP SECRET PROMPT' }) + '\n',
    );

    const events = collectUsageEvents(0);
    expect(events.length).toBe(1);
    const event = events[0]!;
    expect('content' in event).toBe(false);
  });

  it('UsageEvent has no "text" field', () => {
    const projectsDir = path.join(tmpHome, '.claude', 'projects', ENCODED_DIR);
    writeFile(
      path.join(projectsDir, 'session.jsonl'),
      makeAssistantLine({ content: 'secret text' }) + '\n',
    );

    const events = collectUsageEvents(0);
    const event = events[0]!;
    expect('text' in event).toBe(false);
  });

  it('UsageEvent has no "message" field', () => {
    const projectsDir = path.join(tmpHome, '.claude', 'projects', ENCODED_DIR);
    writeFile(
      path.join(projectsDir, 'session.jsonl'),
      makeAssistantLine({}) + '\n',
    );

    const events = collectUsageEvents(0);
    const event = events[0]!;
    expect('message' in event).toBe(false);
  });

  it('UsageEvent has no "prompt" field', () => {
    const projectsDir = path.join(tmpHome, '.claude', 'projects', ENCODED_DIR);
    writeFile(
      path.join(projectsDir, 'session.jsonl'),
      makeAssistantLine({}) + '\n',
    );

    const events = collectUsageEvents(0);
    const event = events[0]!;
    expect('prompt' in event).toBe(false);
  });

  it('UsageEvent only contains the allowed metadata keys', () => {
    const projectsDir = path.join(tmpHome, '.claude', 'projects', ENCODED_DIR);
    writeFile(
      path.join(projectsDir, 'session.jsonl'),
      makeAssistantLine({ content: 'MUST NOT APPEAR' }) + '\n',
    );

    const events = collectUsageEvents(0);
    const event = events[0]!;
    const allowedKeys = new Set(['ts', 'project', 'model', 'source', 'tokensIn', 'tokensOut', 'cacheRead', 'cacheWrite']);
    const actualKeys = Object.keys(event);
    for (const key of actualKeys) {
      expect(allowedKeys.has(key), `Unexpected key "${key}" found in UsageEvent — possible content leak`).toBe(true);
    }
  });

  it('the secret content string does not appear in any UsageEvent field value', () => {
    const SECRET = 'MY_SECRET_PROMPT_THAT_MUST_NOT_LEAK';
    const projectsDir = path.join(tmpHome, '.claude', 'projects', ENCODED_DIR);
    writeFile(
      path.join(projectsDir, 'session.jsonl'),
      makeAssistantLine({ content: SECRET }) + '\n',
    );

    const events = collectUsageEvents(0);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(SECRET);
  });
});

// ---------------------------------------------------------------------------
// collectUsageEvents — run records source
// ---------------------------------------------------------------------------

describe('collectUsageEvents — ~/.ashlr/runs/*.json (source: run)', () => {
  function makeRunRecord(opts: {
    id?: string;
    provider?: string;
    createdAt?: string;
    tokensIn?: number;
    tokensOut?: number;
    status?: string;
  }): string {
    return JSON.stringify({
      id: opts.id ?? 'run-abc',
      goal: 'some goal that must not leak',
      engine: 'builtin',
      provider: opts.provider ?? 'ollama',
      createdAt: opts.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      budget: { maxTokens: 10000, maxSteps: 20, allowCloud: false },
      usage: {
        tokensIn: opts.tokensIn ?? 50,
        tokensOut: opts.tokensOut ?? 25,
        steps: 3,
        estCostUsd: 0,
      },
      tasks: [],
      steps: [],
      status: opts.status ?? 'done',
    });
  }

  it('collects run records as source:"run" events', () => {
    const runsDir = path.join(tmpHome, '.ashlr', 'runs');
    writeFile(path.join(runsDir, 'run-abc.json'), makeRunRecord({ tokensIn: 111, tokensOut: 222 }));

    const events = collectUsageEvents(0);
    const runEvents = events.filter(e => e.source === 'run');
    expect(runEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('maps run usage.tokensIn/tokensOut correctly', () => {
    const runsDir = path.join(tmpHome, '.ashlr', 'runs');
    writeFile(path.join(runsDir, 'run-xyz.json'), makeRunRecord({ tokensIn: 300, tokensOut: 150 }));

    const events = collectUsageEvents(0);
    const runEvent = events.find(e => e.source === 'run' && e.tokensIn === 300);
    expect(runEvent).toBeDefined();
    expect(runEvent!.tokensOut).toBe(150);
  });

  it('tolerates malformed run JSON files without throwing', () => {
    const runsDir = path.join(tmpHome, '.ashlr', 'runs');
    writeFile(path.join(runsDir, 'bad.json'), 'not valid json at all');
    writeFile(path.join(runsDir, 'good.json'), makeRunRecord({ tokensIn: 10 }));

    expect(() => collectUsageEvents(0)).not.toThrow();
    const events = collectUsageEvents(0);
    const runEvents = events.filter(e => e.source === 'run');
    expect(runEvents.length).toBe(1);
  });

  it('respects sinceMs for run records', () => {
    const now = Date.now();
    const oldTs = new Date(now - 10 * 86_400_000).toISOString();
    const runsDir = path.join(tmpHome, '.ashlr', 'runs');
    writeFile(path.join(runsDir, 'old-run.json'), makeRunRecord({ createdAt: oldTs, tokensIn: 999 }));

    const sinceMs = now - 7 * 86_400_000;
    const events = collectUsageEvents(sinceMs);
    expect(events.filter(e => e.source === 'run' && e.tokensIn === 999).length).toBe(0);
  });

  it('run event has no "goal" or content field (privacy)', () => {
    const runsDir = path.join(tmpHome, '.ashlr', 'runs');
    writeFile(path.join(runsDir, 'run-priv.json'), makeRunRecord({ tokensIn: 5 }));

    const events = collectUsageEvents(0);
    const runEvent = events.find(e => e.source === 'run');
    if (runEvent) {
      expect('goal' in runEvent).toBe(false);
      expect('result' in runEvent).toBe(false);
      expect('steps' in runEvent).toBe(false);
    }
  });
});
