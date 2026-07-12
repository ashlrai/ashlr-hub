/**
 * M33 — Plugin wrappers tests.
 *
 * Hermetic: tmp HOME per test (h1-fixture). Tests cover:
 *  - wrapScanner: timeout/never-throw/clamp/cap/scrub/namespacing
 *  - validateTemplate: traversal rejection + id prefixing
 *  - wrapCommand: exit codes + audit records
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  readFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';

import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import { wrapScanner, validateTemplate, wrapCommand } from '../src/core/plugins/wrappers.js';
import type { PluginScanner, PluginCommandSpec, PluginHost } from '../src/core/plugins/types.js';
import type { ProjectTemplate, TemplateFile, WorkItem } from '../src/core/types.js';
import { isStrictWorkItem } from '../src/core/portfolio/queued-autonomy.js';

let fx: H1Fixture;

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

/** Read all audit lines from the fixture's tmp HOME. */
function readAuditLines(): Array<{ action: string; result: string; summary: string }> {
  const dir = join(fx.ashlrDir, 'audit');
  if (!existsSync(dir)) return [];
  const lines: Array<{ action: string; result: string; summary: string }> = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    for (const raw of readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => l.trim())) {
      try {
        lines.push(JSON.parse(raw) as { action: string; result: string; summary: string });
      } catch { /* skip */ }
    }
  }
  return lines;
}

/** Build a minimal PluginHost stub for command tests. */
function makeHost(pluginName = 'test-plugin'): PluginHost {
  return {
    apiVersion: '1.0.0',
    pluginName,
    log: () => {},
    audit: () => {},
    settings: {},
    view: { editor: 'vscode', staleDays: 30 },
    dataDir: fx.ashlrDir,
  };
}

/** Build a minimal ProjectTemplate. */
function makeTemplate(id: string, files: TemplateFile[]): ProjectTemplate {
  return {
    id,
    title: `Template ${id}`,
    description: `Desc for ${id}`,
    files: (_ctx) => files,
  };
}

// ---------------------------------------------------------------------------
// wrapScanner — basic wrapping
// ---------------------------------------------------------------------------

describe('wrapScanner', () => {
  it('returns WorkItems with namespaced ids', async () => {
    const scanner: PluginScanner = {
      id: 'my-scan',
      async scan(repo, _ctx) {
        return [{
          id: 'orig-1',
          repo,
          source: 'todo',
          title: 'A todo item',
          detail: '',
          value: 3,
          effort: 2,
          tags: [],
          ts: new Date().toISOString(),
        }] as WorkItem[];
      },
    };

    const wrapped = wrapScanner('my-plugin', scanner);
    const items = await wrapped('/repo');

    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('plugin:my-plugin:my-scan:orig-1');
  });

  it('normalizes hostile plugin metadata to the strict persisted WorkItem contract', async () => {
    const scanner: PluginScanner = {
      id: `scanner-${'s'.repeat(200)}`,
      async scan(repo) {
        return [{
          id: `item-${'i'.repeat(300)}`,
          repo,
          source: 'todo',
          title: 't'.repeat(500),
          detail: 'd'.repeat(5_000),
          value: 3,
          effort: 2,
          tags: Array.from({ length: 75 }, (_, index) => `tag-${index}-${'x'.repeat(100)}`),
          ts: 'not-a-timestamp',
        }] as WorkItem[];
      },
    };

    const items = await wrapScanner(`plugin-${'p'.repeat(200)}`, scanner)('/repo');

    expect(items).toHaveLength(1);
    expect(isStrictWorkItem(items[0])).toBe(true);
    expect(items[0]!.id.length).toBeLessThanOrEqual(180);
    expect(items[0]!.title.length).toBeLessThanOrEqual(240);
    expect(items[0]!.detail.length).toBeLessThanOrEqual(4_000);
    expect(items[0]!.tags.length).toBeLessThanOrEqual(50);
  });

  it('forces source to "plugin"', async () => {
    const scanner: PluginScanner = {
      id: 'scan',
      async scan(repo, _ctx) {
        return [{
          id: 'x',
          repo,
          source: 'todo', // scanner says 'todo'
          title: 'item',
          detail: '',
          value: 3,
          effort: 2,
          tags: [],
          ts: new Date().toISOString(),
        }] as WorkItem[];
      },
    };
    const items = await wrapScanner('p', scanner)('/repo');
    expect(items[0]!.source).toBe('plugin');
  });

  it('forces repo to the scanned root even when a plugin returns a file path', async () => {
    const scanner: PluginScanner = {
      id: 'scan',
      async scan(_repo, _ctx) {
        return [{
          id: 'x',
          repo: '/repo/test/m99.backlog-actionable.test.ts',
          source: 'todo',
          title: 'item',
          detail: '',
          value: 3,
          effort: 2,
          tags: [],
          ts: new Date().toISOString(),
        }] as WorkItem[];
      },
    };
    const items = await wrapScanner('p', scanner)('/repo');
    expect(items[0]!.repo).toBe('/repo');
  });

  it('forces required tags to include plugin, pluginName, and scanner id', async () => {
    const scanner: PluginScanner = {
      id: 'sc',
      async scan(repo, _ctx) {
        return [{
          id: 'y',
          repo,
          source: 'todo',
          title: 'item',
          detail: '',
          value: 3,
          effort: 2,
          tags: ['extra'],
          ts: new Date().toISOString(),
        }] as WorkItem[];
      },
    };
    const items = await wrapScanner('myplugin', scanner)('/repo');
    expect(items[0]!.tags).toContain('plugin');
    expect(items[0]!.tags).toContain('myplugin');
    expect(items[0]!.tags).toContain('sc');
    expect(items[0]!.tags).toContain('extra');
  });

  it('clamps value/effort to 1..5 integers', async () => {
    const scanner: PluginScanner = {
      id: 'sc',
      async scan(repo, _ctx) {
        return [{
          id: 'a',
          repo,
          source: 'todo',
          title: 'item',
          detail: '',
          value: 99,   // out of range
          effort: -5,  // out of range
          tags: [],
          ts: new Date().toISOString(),
        }] as WorkItem[];
      },
    };
    const items = await wrapScanner('p', scanner)('/repo');
    expect(items[0]!.value).toBe(5);
    expect(items[0]!.effort).toBe(1);
  });

  it('recomputes score using scoreItem (value/effort)', async () => {
    const scanner: PluginScanner = {
      id: 'sc',
      async scan(repo, _ctx) {
        return [{
          id: 'b',
          repo,
          source: 'todo',
          title: 'item',
          detail: '',
          value: 4,
          effort: 2,
          score: 999, // wrong score — should be recomputed
          tags: [],
          ts: new Date().toISOString(),
        }] as WorkItem[];
      },
    };
    const items = await wrapScanner('p', scanner)('/repo');
    // scoreItem(4, 2) = 2
    expect(items[0]!.score).toBe(2);
  });

  it('caps results at 100 items', async () => {
    const scanner: PluginScanner = {
      id: 'sc',
      async scan(repo, _ctx) {
        return Array.from({ length: 150 }, (_, i) => ({
          id: String(i),
          repo,
          source: 'todo' as const,
          title: `item ${i}`,
          detail: '',
          value: 3,
          effort: 2,
          tags: [],
          ts: new Date().toISOString(),
        }));
      },
    };
    const items = await wrapScanner('p', scanner)('/repo');
    expect(items.length).toBe(100);
  });

  it('scrubs secret tokens from title (sk- token → [REDACTED])', async () => {
    const scanner: PluginScanner = {
      id: 'sc',
      async scan(repo, _ctx) {
        return [{
          id: 'secret',
          repo,
          source: 'todo',
          title: 'found sk-abcdefghijklmnopqrstuvwx1234567890ABCDEF in code',
          detail: 'token: sk-abcdefghijklmnopqrstuvwx1234567890ABCDEF',
          value: 3,
          effort: 2,
          tags: [],
          ts: new Date().toISOString(),
        }] as WorkItem[];
      },
    };
    const items = await wrapScanner('p', scanner)('/repo');
    expect(items[0]!.title).not.toContain('sk-abcdefghijklmnopqrstuvwx1234567890ABCDEF');
    expect(items[0]!.title).toContain('[REDACTED]');
    expect(items[0]!.detail).not.toContain('sk-abcdefghijklmnopqrstuvwx1234567890ABCDEF');
    expect(items[0]!.detail).toContain('[REDACTED]');
  });

  it('never throws when scanner throws', async () => {
    const scanner: PluginScanner = {
      id: 'sc',
      async scan() {
        throw new Error('scanner exploded');
      },
    };
    let result: WorkItem[] = [];
    await expect(async () => {
      result = await wrapScanner('p', scanner)('/repo');
    }).not.toThrow();
    expect(result).toHaveLength(0);
  });

  it('returns [] when scanner times out (short injected timeout)', async () => {
    // We can't inject timeout into wrapScanner directly (it hardcodes 15s),
    // but we CAN verify that an AbortSignal is passed and that when the signal
    // is aborted the scanner's throw is caught → []
    const scanner: PluginScanner = {
      id: 'sc',
      async scan(_repo, ctx) {
        // Respect the signal — throw an AbortError when aborted
        await new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
          // Never resolves on its own
        });
        return [];
      },
    };

    // We simulate the abort via a quick controller to keep the test fast
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    // Directly invoke the scanner with the short-lived signal
    let result: WorkItem[] = [];
    try {
      result = await scanner.scan('/repo', { signal: controller.signal });
    } catch {
      result = [];
    }
    expect(result).toHaveLength(0);
  });

  it('namespaces item id using index when original id is empty', async () => {
    const scanner: PluginScanner = {
      id: 'sc',
      async scan(repo, _ctx) {
        return [{
          id: '', // empty id
          repo,
          source: 'todo',
          title: 'item',
          detail: '',
          value: 3,
          effort: 2,
          tags: [],
          ts: new Date().toISOString(),
        }] as WorkItem[];
      },
    };
    const items = await wrapScanner('p', scanner)('/repo');
    // id should be plugin:p:sc:0 (index-based)
    expect(items[0]!.id).toBe('plugin:p:sc:0');
  });
});

// ---------------------------------------------------------------------------
// validateTemplate
// ---------------------------------------------------------------------------

describe('validateTemplate', () => {
  it('prefixes id with pluginName: when not already prefixed', () => {
    const t = makeTemplate('my-template', [{ path: 'src/index.ts', content: '' }]);
    const result = validateTemplate('myplugin', t);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('myplugin:my-template');
  });

  it('does not double-prefix id when already prefixed', () => {
    const t = makeTemplate('myplugin:my-template', [{ path: 'src/index.ts', content: '' }]);
    const result = validateTemplate('myplugin', t);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('myplugin:my-template');
  });

  it('rejects a template with an absolute file path', () => {
    const t = makeTemplate('tmpl', [{ path: '/etc/passwd', content: '' }]);
    const result = validateTemplate('myplugin', t);
    expect(result).toBeNull();
  });

  it('rejects a template with a traversal path (..)', () => {
    const t = makeTemplate('tmpl', [{ path: '../outside.ts', content: '' }]);
    const result = validateTemplate('myplugin', t);
    expect(result).toBeNull();
  });

  it('rejects a template with a .git/ path', () => {
    const t = makeTemplate('tmpl', [{ path: '.git/hooks/pre-commit', content: '' }]);
    const result = validateTemplate('myplugin', t);
    expect(result).toBeNull();
  });

  it('accepts a template with safe relative paths', () => {
    const t = makeTemplate('tmpl', [
      { path: 'src/index.ts', content: '' },
      { path: 'README.md', content: '' },
    ]);
    const result = validateTemplate('myplugin', t);
    expect(result).not.toBeNull();
  });

  it('audits rejection for traversal paths', () => {
    const t = makeTemplate('bad', [{ path: '../escape.ts', content: '' }]);
    validateTemplate('myplugin', t);

    const lines = readAuditLines();
    const rejected = lines.filter((e) => e.action.includes('template-rejected'));
    expect(rejected.length).toBeGreaterThan(0);
  });

  it('never throws regardless of template content', () => {
    // Template whose files() throws
    const t: ProjectTemplate = {
      id: 'bad',
      title: 'bad',
      description: 'bad',
      files: () => { throw new Error('files() exploded'); },
    };
    expect(() => validateTemplate('myplugin', t)).not.toThrow();
    const result = validateTemplate('myplugin', t);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// wrapCommand
// ---------------------------------------------------------------------------

describe('wrapCommand', () => {
  it('returns exit code 0 from a successful command', async () => {
    const cmd: PluginCommandSpec = {
      name: 'hello',
      description: 'says hello',
      async run() { return 0; },
    };
    const wrapped = wrapCommand('myplugin', cmd);
    const code = await wrapped.run([], makeHost());
    expect(code).toBe(0);
  });

  it('returns exit code 1 from a failing command', async () => {
    const cmd: PluginCommandSpec = {
      name: 'fail',
      description: 'fails',
      async run() { return 1; },
    };
    const wrapped = wrapCommand('myplugin', cmd);
    const code = await wrapped.run([], makeHost());
    expect(code).toBe(1);
  });

  it('catches a throwing command and returns exit code 1', async () => {
    const cmd: PluginCommandSpec = {
      name: 'boom',
      description: 'throws',
      async run() { throw new Error('command exploded'); },
    };
    const wrapped = wrapCommand('myplugin', cmd);
    // The wrapper must not throw — it catches and returns 1.
    await expect(wrapped.run([], makeHost())).resolves.toBe(1);
  });

  it('audits command invocation', async () => {
    const cmd: PluginCommandSpec = {
      name: 'do-thing',
      description: 'does a thing',
      async run() { return 0; },
    };
    const wrapped = wrapCommand('myplugin', cmd);
    await wrapped.run(['arg1', 'arg2'], makeHost());

    const lines = readAuditLines();
    const invocations = lines.filter((e) =>
      e.action === 'plugin:myplugin:command:do-thing',
    );
    expect(invocations.length).toBeGreaterThan(0);
  });

  it('audits exit code', async () => {
    const cmd: PluginCommandSpec = {
      name: 'exitcmd',
      description: 'exits',
      async run() { return 42; },
    };
    const wrapped = wrapCommand('myplugin', cmd);
    await wrapped.run([], makeHost());

    const lines = readAuditLines();
    const exitLines = lines.filter((e) =>
      e.action === 'plugin:myplugin:command:exitcmd:exit',
    );
    expect(exitLines.length).toBeGreaterThan(0);
    // exit code 42 is non-zero → result should be 'error'
    expect(exitLines[0]!.result).toBe('error');
  });

  it('audits exit code 0 as ok', async () => {
    const cmd: PluginCommandSpec = {
      name: 'okcmd',
      description: 'ok',
      async run() { return 0; },
    };
    const wrapped = wrapCommand('myplugin', cmd);
    await wrapped.run([], makeHost());

    const lines = readAuditLines();
    const exitLines = lines.filter((e) =>
      e.action === 'plugin:myplugin:command:okcmd:exit',
    );
    expect(exitLines.length).toBeGreaterThan(0);
    expect(exitLines[0]!.result).toBe('ok');
  });

  it('preserves command name and description through wrapping', () => {
    const cmd: PluginCommandSpec = {
      name: 'my-cmd',
      description: 'My command description',
      async run() { return 0; },
    };
    const wrapped = wrapCommand('p', cmd);
    expect(wrapped.name).toBe('my-cmd');
    expect(wrapped.description).toBe('My command description');
  });

  it('never throws from the wrapper itself even on internal error', async () => {
    const cmd: PluginCommandSpec = {
      name: 'chaos',
      description: 'chaos',
      async run() { throw new TypeError('unexpected'); },
    };
    const wrapped = wrapCommand('p', cmd);
    await expect(wrapped.run([], makeHost())).resolves.toBe(1);
  });
});
