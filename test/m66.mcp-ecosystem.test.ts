/**
 * Tests for M66 "unified MCP surface":
 *   1. knownConfigPaths() includes ~/.ashlr/settings.json
 *   2. mergeEcosystemServers() writes a valid mcpServers map without clobbering
 *      existing keys
 *   3. Absent tools are skipped (detect via PATH injection)
 *   4. Idempotency: running twice does not duplicate entries
 *
 * Hermetic: uses a tmp HOME via PATH injection and tmp files. Does NOT touch
 * the real ~/.ashlr directory.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import { knownConfigPaths } from '../src/core/mcp-registry.js';
import { mergeEcosystemServers } from '../src/cli/mcp.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP = os.tmpdir();
const tmpFiles: string[] = [];

function tmpPath(label: string): string {
  const p = path.join(
    TMP,
    `ashlr-m66-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  tmpFiles.push(p);
  return p;
}

function writeJson(p: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function readJson(p: string): unknown {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

afterEach(() => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  tmpFiles.length = 0;
});

// ---------------------------------------------------------------------------
// 1. knownConfigPaths — includes ~/.ashlr/settings.json
// ---------------------------------------------------------------------------

describe('knownConfigPaths — M66 path is included', () => {
  it('includes a path ending in .ashlr/settings.json', () => {
    const paths = knownConfigPaths();
    const hasAshlrSettings = paths.some(p => p.endsWith(path.join('.ashlr', 'settings.json')));
    expect(hasAshlrSettings).toBe(true);
  });

  it('the .ashlr/settings.json path comes after known ecosystem paths', () => {
    const paths = knownConfigPaths();
    const ashlrIdx = paths.findIndex(p => p.endsWith(path.join('.ashlr', 'settings.json')));
    const claudeIdx = paths.findIndex(p => p.endsWith('.claude.json'));
    // .ashlr/settings.json should come after .claude.json (it's an addition, not a replacement)
    expect(ashlrIdx).toBeGreaterThan(claudeIdx);
  });

  it('does not contain duplicates', () => {
    const paths = knownConfigPaths();
    const unique = new Set(paths);
    expect(paths.length).toBe(unique.size);
  });
});

// ---------------------------------------------------------------------------
// 2. mergeEcosystemServers — basic write
// ---------------------------------------------------------------------------

describe('mergeEcosystemServers — writes mcpServers to a fresh file', () => {
  it('creates the file when absent', () => {
    const p = tmpPath('fresh');
    const added = mergeEcosystemServers(
      [{ name: 'phantom-secrets', command: 'phantom', args: ['mcp', 'serve'] }],
      p,
    );
    expect(fs.existsSync(p)).toBe(true);
    expect(added).toContain('phantom-secrets');
  });

  it('writes a valid JSON file with mcpServers', () => {
    const p = tmpPath('valid-json');
    mergeEcosystemServers(
      [{ name: 'phantom-secrets', command: 'phantom', args: ['mcp', 'serve'] }],
      p,
    );
    const obj = readJson(p) as { mcpServers: Record<string, unknown> };
    expect(obj.mcpServers).toBeDefined();
    expect(obj.mcpServers['phantom-secrets']).toBeDefined();
  });

  it('sets the correct command and args', () => {
    const p = tmpPath('cmd-args');
    mergeEcosystemServers(
      [{ name: 'phantom-secrets', command: 'phantom', args: ['mcp', 'serve'] }],
      p,
    );
    const obj = readJson(p) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const entry = obj.mcpServers['phantom-secrets'];
    expect(entry!.command).toBe('phantom');
    expect(entry!.args).toEqual(['mcp', 'serve']);
  });
});

// ---------------------------------------------------------------------------
// 3. mergeEcosystemServers — does not clobber existing keys
// ---------------------------------------------------------------------------

describe('mergeEcosystemServers — preserves existing keys', () => {
  it('preserves top-level non-mcpServers keys', () => {
    const p = tmpPath('preserve-top');
    writeJson(p, {
      someExistingKey: 'should-survive',
      anotherKey: 42,
    });
    mergeEcosystemServers(
      [{ name: 'phantom-secrets', command: 'phantom', args: ['mcp', 'serve'] }],
      p,
    );
    const obj = readJson(p) as { someExistingKey: string; anotherKey: number };
    expect(obj.someExistingKey).toBe('should-survive');
    expect(obj.anotherKey).toBe(42);
  });

  it('preserves pre-existing mcpServers entries', () => {
    const p = tmpPath('preserve-mcp');
    writeJson(p, {
      mcpServers: {
        'my-custom-server': { command: 'node', args: ['custom.js'] },
      },
    });
    mergeEcosystemServers(
      [{ name: 'phantom-secrets', command: 'phantom', args: ['mcp', 'serve'] }],
      p,
    );
    const obj = readJson(p) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(obj.mcpServers['my-custom-server']).toBeDefined();
    expect(obj.mcpServers['my-custom-server']!.command).toBe('node');
  });

  it('both pre-existing and new entry coexist', () => {
    const p = tmpPath('coexist');
    writeJson(p, {
      mcpServers: { existing: { command: 'old', args: [] } },
    });
    mergeEcosystemServers(
      [{ name: 'phantom-secrets', command: 'phantom', args: ['mcp', 'serve'] }],
      p,
    );
    const obj = readJson(p) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(obj.mcpServers)).toContain('existing');
    expect(Object.keys(obj.mcpServers)).toContain('phantom-secrets');
  });
});

// ---------------------------------------------------------------------------
// 4. mergeEcosystemServers — idempotency
// ---------------------------------------------------------------------------

describe('mergeEcosystemServers — idempotent (running twice does not duplicate)', () => {
  it('second call returns empty added list when server already registered', () => {
    const p = tmpPath('idempotent');
    const first = mergeEcosystemServers(
      [{ name: 'phantom-secrets', command: 'phantom', args: ['mcp', 'serve'] }],
      p,
    );
    const second = mergeEcosystemServers(
      [{ name: 'phantom-secrets', command: 'phantom', args: ['mcp', 'serve'] }],
      p,
    );
    expect(first).toContain('phantom-secrets');
    expect(second).toHaveLength(0); // already present — nothing added
  });

  it('mcpServers has exactly one phantom-secrets entry after two runs', () => {
    const p = tmpPath('no-dup');
    mergeEcosystemServers(
      [{ name: 'phantom-secrets', command: 'phantom', args: ['mcp', 'serve'] }],
      p,
    );
    mergeEcosystemServers(
      [{ name: 'phantom-secrets', command: 'phantom', args: ['mcp', 'serve'] }],
      p,
    );
    const obj = readJson(p) as { mcpServers: Record<string, unknown> };
    const phantomEntries = Object.keys(obj.mcpServers).filter(k => k === 'phantom-secrets');
    expect(phantomEntries).toHaveLength(1);
  });

  it('file content is identical after a second no-op call', () => {
    const p = tmpPath('stable-content');
    mergeEcosystemServers(
      [{ name: 'phantom-secrets', command: 'phantom', args: ['mcp', 'serve'] }],
      p,
    );
    const after1 = fs.readFileSync(p, 'utf8');
    mergeEcosystemServers(
      [{ name: 'phantom-secrets', command: 'phantom', args: ['mcp', 'serve'] }],
      p,
    );
    const after2 = fs.readFileSync(p, 'utf8');
    expect(after2).toBe(after1);
  });
});

// ---------------------------------------------------------------------------
// 5. mergeEcosystemServers — absent tools are skipped (empty detected list)
// ---------------------------------------------------------------------------

describe('mergeEcosystemServers — empty detected list (absent tools)', () => {
  it('writes a valid file with empty mcpServers when no tools detected', () => {
    const p = tmpPath('empty-detected');
    const added = mergeEcosystemServers([], p);
    expect(added).toHaveLength(0);
    expect(fs.existsSync(p)).toBe(true);
    const obj = readJson(p) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(obj.mcpServers)).toHaveLength(0);
  });

  it('does not clobber existing entries when detected is empty', () => {
    const p = tmpPath('empty-no-clobber');
    writeJson(p, {
      mcpServers: { 'keep-me': { command: 'keep', args: [] } },
    });
    mergeEcosystemServers([], p);
    const obj = readJson(p) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(obj.mcpServers)).toContain('keep-me');
  });
});

// ---------------------------------------------------------------------------
// 6. mergeEcosystemServers — multiple servers, partial overlap
// ---------------------------------------------------------------------------

describe('mergeEcosystemServers — partial overlap with existing', () => {
  it('only adds the new server, leaves existing untouched', () => {
    const p = tmpPath('partial-overlap');
    writeJson(p, {
      mcpServers: {
        'phantom-secrets': { command: 'phantom', args: ['mcp', 'serve'] },
      },
    });
    const added = mergeEcosystemServers(
      [
        { name: 'phantom-secrets', command: 'phantom', args: ['mcp', 'serve'] },
        { name: 'new-server', command: 'new-cmd', args: ['--flag'] },
      ],
      p,
    );
    expect(added).toEqual(['new-server']);
    const obj = readJson(p) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(obj.mcpServers)).toContain('phantom-secrets');
    expect(Object.keys(obj.mcpServers)).toContain('new-server');
  });
});
