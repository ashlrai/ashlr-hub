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

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import { knownConfigPaths } from '../src/core/mcp-registry.js';
import { buildEcosystemMcpEntry, mergeEcosystemServers, cmdMcp } from '../src/cli/mcp.js';
import { locusServerSpec } from '../src/core/integrations/locus.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP = os.tmpdir();
const tmpFiles: string[] = [];
const tmpRoots: string[] = [];

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
  for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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

// ---------------------------------------------------------------------------
// 7. mergeEcosystemServers — locus gets LOCUS_HOME / LOCUS_CLIENT via locusServerSpec
// ---------------------------------------------------------------------------

describe('mergeEcosystemServers — locus registers with identity env', () => {
  const prevHome = process.env['LOCUS_HOME'];

  afterEach(() => {
    if (prevHome === undefined) delete process.env['LOCUS_HOME'];
    else process.env['LOCUS_HOME'] = prevHome;
  });

  it('buildEcosystemMcpEntry(locus) matches locusServerSpec env keys', () => {
    process.env['LOCUS_HOME'] = '/tmp/locus-m66-spec';
    const entry = buildEcosystemMcpEntry({
      name: 'locus',
      command: 'locus-mcp',
      args: [],
    });
    const expected = locusServerSpec({
      locusHome: '/tmp/locus-m66-spec',
      client: 'ashlr-hub',
    });
    expect(entry.command).toBe('locus-mcp');
    expect(entry.args).toEqual([]);
    expect(entry.env?.LOCUS_HOME).toBe(expected.env?.LOCUS_HOME);
    expect(entry.env?.LOCUS_CLIENT).toBe('ashlr-hub');
    expect(entry.env?.LOCUS_NOTIFY).toBe('0');
  });

  it('writes locus with LOCUS_HOME + LOCUS_CLIENT (not command-only)', () => {
    process.env['LOCUS_HOME'] = '/tmp/locus-m66-write';
    const p = tmpPath('locus-env');
    const added = mergeEcosystemServers(
      [{ name: 'locus', command: 'locus-mcp', args: [] }],
      p,
    );
    expect(added).toEqual(['locus']);
    const obj = readJson(p) as {
      mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
    };
    const locus = obj.mcpServers['locus'];
    expect(locus).toBeDefined();
    expect(locus!.command).toBe('locus-mcp');
    expect(locus!.env?.LOCUS_HOME).toBe('/tmp/locus-m66-write');
    expect(locus!.env?.LOCUS_CLIENT).toBe('ashlr-hub');
    expect(locus!.env?.LOCUS_NOTIFY).toBe('0');
  });

  it('upgrades incomplete command-only locus entry on second write', () => {
    process.env['LOCUS_HOME'] = '/tmp/locus-m66-upgrade';
    const p = tmpPath('locus-upgrade');
    // Simulate older write path that only stored command/args.
    writeJson(p, {
      mcpServers: {
        locus: { command: 'locus-mcp', args: [] },
        'phantom-secrets': { command: 'phantom', args: ['mcp', 'serve'] },
      },
    });
    const added = mergeEcosystemServers(
      [{ name: 'locus', command: 'locus-mcp', args: [] }],
      p,
    );
    expect(added).toEqual(['locus']);
    const obj = readJson(p) as {
      mcpServers: Record<string, { command: string; env?: Record<string, string> }>;
    };
    expect(obj.mcpServers['locus']!.env?.LOCUS_HOME).toBe('/tmp/locus-m66-upgrade');
    expect(obj.mcpServers['locus']!.env?.LOCUS_CLIENT).toBe('ashlr-hub');
    // sibling entry preserved
    expect(obj.mcpServers['phantom-secrets']).toBeDefined();
  });

  it('does not re-write locus when required env is already present', () => {
    const p = tmpPath('locus-idempotent');
    writeJson(p, {
      mcpServers: {
        locus: {
          command: 'locus-mcp',
          args: [],
          env: {
            LOCUS_HOME: '/custom/locus',
            LOCUS_CLIENT: 'ashlr-hub',
            LOCUS_NOTIFY: '0',
          },
        },
      },
    });
    const before = fs.readFileSync(p, 'utf8');
    const added = mergeEcosystemServers(
      [{ name: 'locus', command: 'locus-mcp', args: [] }],
      p,
    );
    expect(added).toHaveLength(0);
    // Existing custom LOCUS_HOME must not be clobbered
    const obj = readJson(p) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    expect(obj.mcpServers['locus']!.env?.LOCUS_HOME).toBe('/custom/locus');
    expect(fs.readFileSync(p, 'utf8')).toBe(before);
  });

  it('registers phantom-secrets without inventing a rename to phantom', () => {
    const p = tmpPath('phantom-name');
    mergeEcosystemServers(
      [
        { name: 'phantom-secrets', command: 'phantom', args: ['mcp', 'serve'] },
        { name: 'locus', command: 'locus-mcp', args: [] },
      ],
      p,
    );
    const obj = readJson(p) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(obj.mcpServers)).toContain('phantom-secrets');
    expect(Object.keys(obj.mcpServers)).not.toContain('phantom');
    expect(Object.keys(obj.mcpServers)).toContain('locus');
  });
});


// Detection reads bounded headers only; these native-header fixtures are never run.
function ecosystemFixture(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'phm-ecosystem-')));
  tmpRoots.push(root);
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.stubEnv('LOCUS_HOME', path.join(root, 'locus-home'));
  return root;
}
function nativeCandidate(directory: string, name = 'phantom'): string {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, process.platform === 'win32' ? `${name}.exe` : name);
  fs.writeFileSync(file, Buffer.from('cffaedfe00000000', 'hex'));
  fs.chmodSync(file, 0o700);
  return fs.realpathSync(file);
}
async function runEcosystem(args: string[] = []): Promise<{ code: number; output: string }> {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => { lines.push(values.map(String).join(' ')); });
  const code = await cmdMcp(['ecosystem', ...args]);
  return { code, output: lines.join('\n') };
}
function settingsFor(root: string): string { return path.join(root, '.ashlr', 'settings.json'); }

describe('ecosystem discovery binds a physical executable without launching it', () => {
  it.skipIf(process.platform === 'win32')('skips first-existing nonexecutables and relative PATH entries, then registers the absolute native candidate', async () => {
    const root = ecosystemFixture(); const early = path.join(root, 'early'); const valid = path.join(root, 'valid with spaces');
    fs.mkdirSync(early); fs.writeFileSync(path.join(early, 'phantom'), 'not executable'); fs.chmodSync(path.join(early, 'phantom'), 0o600);
    const selected = nativeCandidate(valid);
    vi.stubEnv('PATH', ['', '.', early, valid].join(path.delimiter));
    const result = await runEcosystem(['--write']);
    expect(result.code).toBe(0);
    const stored = readJson(settingsFor(root)) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(stored.mcpServers['phantom-secrets']).toEqual({ command: selected, args: ['mcp', 'serve'] });
    vi.stubEnv('PATH', early);
    expect((readJson(settingsFor(root)) as typeof stored).mcpServers['phantom-secrets']!.command).toBe(selected);
    expect(result.output).not.toContain(path.join(early, 'phantom'));
  });

  it.skipIf(process.platform === 'win32')('does not select a directory with the executable name', async () => {
    const root = ecosystemFixture(); const early = path.join(root, 'directory-first');
    fs.mkdirSync(path.join(early, 'phantom'), { recursive: true });
    const selected = nativeCandidate(path.join(root, 'native'));
    vi.stubEnv('PATH', [early, path.dirname(selected)].join(path.delimiter));
    expect((await runEcosystem(['--write'])).code).toBe(0);
    expect((readJson(settingsFor(root)) as { mcpServers: Record<string, { command: string }> }).mcpServers['phantom-secrets']!.command).toBe(selected);
  });

  it.skipIf(process.platform === 'win32')('deduplicates aliases to the same physical executable', async () => {
    const root = ecosystemFixture(); const selected = nativeCandidate(path.join(root, 'native')); const alias = path.join(root, 'alias');
    fs.mkdirSync(alias); fs.symlinkSync(selected, path.join(alias, 'phantom'));
    vi.stubEnv('PATH', [alias, path.dirname(selected), alias].join(path.delimiter));
    expect((await runEcosystem(['--write'])).code).toBe(0);
    expect((readJson(settingsFor(root)) as { mcpServers: Record<string, { command: string }> }).mcpServers['phantom-secrets']!.command).toBe(selected);
  });

  it('refuses distinct native candidates without choosing the first', async () => {
    const root = ecosystemFixture(); const first = nativeCandidate(path.join(root, 'one')); const second = nativeCandidate(path.join(root, 'two'));
    vi.stubEnv('PATH', [path.dirname(first), path.dirname(second)].join(path.delimiter));
    const result = await runEcosystem(['--write']);
    expect(result.output).toContain('ambiguous');
    expect(fs.existsSync(settingsFor(root))).toBe(false);
  });

  it('refuses a bootstrap wrapper without executing or registering it', async () => {
    const root = ecosystemFixture(); const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
    const marker = path.join(root, 'must-not-run');
    const wrapper = path.join(bin, process.platform === 'win32' ? 'phantom.cmd' : 'phantom');
    fs.writeFileSync(wrapper, `#!/bin/sh\n# downloadReleaseBinary\ntouch ${marker}\n`); fs.chmodSync(wrapper, 0o700);
    vi.stubEnv('PATH', bin);
    const result = await runEcosystem(['--write']);
    expect(result.output).toContain('unsupported-launcher');
    expect(fs.existsSync(settingsFor(root))).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('writes the selected Locus MCP executable with existing identity environment', async () => {
    const root = ecosystemFixture(); const selected = nativeCandidate(path.join(root, 'bin'), 'locus-mcp');
    vi.stubEnv('PATH', path.dirname(selected));
    expect((await runEcosystem(['--write'])).code).toBe(0);
    const entry = (readJson(settingsFor(root)) as { mcpServers: Record<string, { command: string; env: Record<string, string> }> }).mcpServers.locus!;
    expect(entry.command).toBe(selected);
    expect(entry.env).toMatchObject({ LOCUS_HOME: path.join(root, 'locus-home'), LOCUS_CLIENT: 'ashlr-hub', LOCUS_NOTIFY: '0' });
  });
});

describe('ecosystem settings refuse unknown content before writes', () => {
  const invalid = [
    ['malformed JSON', '{"private":"do-not-replace",'],
    ['empty existing file', ''], ['null root', 'null'], ['array root', '[]'], ['scalar root', 'false'],
    ['array mcpServers', '{"mcpServers":[]}'], ['null mcpServers', '{"mcpServers":null}'],
    ['scalar server', '{"mcpServers":{"locus":"do-not-replace"}}'],
    ['null server', '{"mcpServers":{"locus":null}}'],
    ['array environment', '{"mcpServers":{"locus":{"command":"locus-mcp","env":[]}}}'],
    ['malformed environment', '{"mcpServers":{"locus":{"command":"locus-mcp","env":{"LOCUS_HOME":3}}}}'],
  ] as const;
  for (const [label, bytes] of invalid) it(`preserves ${label} exactly on direct merge refusal`, () => {
    const p = tmpPath('invalid'); fs.writeFileSync(p, bytes);
    expect(() => mergeEcosystemServers([{ name: 'phantom-secrets', command: '/synthetic/native/phantom', args: ['mcp', 'serve'] }], p)).toThrow('existing MCP settings');
    expect(fs.readFileSync(p, 'utf8')).toBe(bytes);
  });

  it('refuses an existing directory and leaves it intact', () => {
    const root = ecosystemFixture(); const directory = path.join(root, 'settings-directory'); fs.mkdirSync(directory);
    const marker = path.join(directory, 'unrelated'); fs.writeFileSync(marker, 'preserve');
    expect(() => mergeEcosystemServers([], directory)).toThrow('existing MCP settings');
    expect(fs.readFileSync(marker, 'utf8')).toBe('preserve');
  });

  it.skipIf(process.platform === 'win32')('refuses a dangling settings symlink without creating its missing target', () => {
    const root = ecosystemFixture(); const missing = path.join(root, 'missing-target'); const link = path.join(root, 'settings-link');
    fs.symlinkSync(missing, link);
    expect(() => mergeEcosystemServers([], link)).toThrow('existing MCP settings');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('CLI refuses malformed current settings without exposing content or overwriting them', async () => {
    const root = ecosystemFixture(); const selected = nativeCandidate(path.join(root, 'bin')); vi.stubEnv('PATH', path.dirname(selected));
    const p = settingsFor(root); fs.mkdirSync(path.dirname(p)); const bytes = '{"private":"synthetic-secret-do-not-print",'; fs.writeFileSync(p, bytes);
    const result = await runEcosystem(['--write']);
    expect(result.code).toBe(1);
    expect(result.output).toContain('existing MCP settings');
    expect(result.output).not.toContain('synthetic-secret-do-not-print');
    expect(fs.readFileSync(p, 'utf8')).toBe(bytes);
  });
});


it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('CLI distinguishes a real write failure from a parse refusal without promising no change', async () => {
  const root = ecosystemFixture(); const selected = nativeCandidate(path.join(root, 'bin')); vi.stubEnv('PATH', path.dirname(selected));
  const settings = settingsFor(root); fs.mkdirSync(path.dirname(settings)); fs.writeFileSync(settings, '{}'); fs.chmodSync(settings, 0o400);
  const result = await runEcosystem(['--write']);
  expect(result.code).toBe(1);
  expect(result.output).toContain('MCP registration failed');
  expect(result.output).not.toContain('No settings were changed');
  expect(result.output).not.toContain('EACCES');
  expect(fs.readFileSync(settings, 'utf8')).toBe('{}');
});
