/**
 * Tests for `ashlr mcp install` subcommand (src/cli/mcp.ts — M3)
 *
 * SAFETY GUARDRAIL: ALL operations target a temp file in os.tmpdir().
 * NEVER touches ~/.claude.json, ~/.claude/settings.json, ~/.mcp.json, etc.
 *
 * Verifies:
 *   - adds the "ashlr" gateway server to the target mcpServers config
 *   - creates a .bak backup before writing
 *   - is idempotent (second install does not duplicate the entry)
 *   - never clobbers existing servers in the config
 *   - handles missing config (creates it fresh)
 *   - handles config with no mcpServers key
 *   - returns exit code 0 on success
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { cmdMcp } from '../src/cli/mcp.js';

// ---------------------------------------------------------------------------
// Safety: verify we are ONLY operating on tmp files
// ---------------------------------------------------------------------------

const HOME = os.homedir();
const FORBIDDEN_PATHS = [
  path.join(HOME, '.claude.json'),
  path.join(HOME, '.claude', 'settings.json'),
  path.join(HOME, '.mcp.json'),
  path.join(HOME, '.ashlrcode', 'settings.json'),
];

/** Assert a path is NOT a real config path. */
function assertNotRealConfig(p: string): void {
  for (const forbidden of FORBIDDEN_PATHS) {
    if (path.resolve(p) === path.resolve(forbidden)) {
      throw new Error(`SAFETY VIOLATION: test attempted to write to ${forbidden}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP = os.tmpdir();
const createdFiles: string[] = [];

function tmpPath(name: string): string {
  const p = path.join(TMP, `ashlr-install-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  assertNotRealConfig(p);
  return p;
}

function writeConfig(p: string, obj: unknown): void {
  assertNotRealConfig(p);
  createdFiles.push(p);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

function readConfig(p: string): unknown {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readConfigTyped(p: string): { mcpServers?: Record<string, unknown> } {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

afterEach(() => {
  for (const f of createdFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
    try { fs.unlinkSync(f + '.bak'); } catch { /* ignore */ }
  }
  createdFiles.length = 0;
});

// ---------------------------------------------------------------------------
// install claude --config <tmp> — fresh empty config
// ---------------------------------------------------------------------------

describe('cmdMcp install — fresh config with empty mcpServers', () => {
  it('returns exit code 0', async () => {
    const p = tmpPath('fresh');
    writeConfig(p, { mcpServers: {} });
    const code = await cmdMcp(['install', 'claude', '--config', p]);
    expect(code).toBe(0);
  });

  it('adds "ashlr" server to mcpServers', async () => {
    const p = tmpPath('adds-ashlr');
    writeConfig(p, { mcpServers: {} });
    await cmdMcp(['install', 'claude', '--config', p]);
    const cfg = readConfigTyped(p);
    expect(cfg.mcpServers).toBeDefined();
    expect('ashlr' in (cfg.mcpServers ?? {})).toBe(true);
  });

  it('added ashlr entry has command field', async () => {
    const p = tmpPath('has-command');
    writeConfig(p, { mcpServers: {} });
    await cmdMcp(['install', 'claude', '--config', p]);
    const cfg = readConfigTyped(p);
    const entry = (cfg.mcpServers ?? {})['ashlr'] as Record<string, unknown> | undefined;
    expect(entry?.command).toBeDefined();
    expect(typeof entry?.command).toBe('string');
  });

  it('added ashlr entry has args field', async () => {
    const p = tmpPath('has-args');
    writeConfig(p, { mcpServers: {} });
    await cmdMcp(['install', 'claude', '--config', p]);
    const cfg = readConfigTyped(p);
    const entry = (cfg.mcpServers ?? {})['ashlr'] as Record<string, unknown> | undefined;
    expect(Array.isArray(entry?.args)).toBe(true);
  });

  it('creates a .bak backup file before writing', async () => {
    const p = tmpPath('bak-created');
    writeConfig(p, { mcpServers: {} });
    await cmdMcp(['install', 'claude', '--config', p]);
    expect(fs.existsSync(p + '.bak')).toBe(true);
  });

  it('.bak contains the original content', async () => {
    const p = tmpPath('bak-content');
    const original = { mcpServers: {} };
    writeConfig(p, original);
    await cmdMcp(['install', 'claude', '--config', p]);
    const bak = JSON.parse(fs.readFileSync(p + '.bak', 'utf8'));
    expect(bak).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// install — config with no mcpServers key
// ---------------------------------------------------------------------------

describe('cmdMcp install — config file with no mcpServers key', () => {
  it('creates mcpServers and adds ashlr entry', async () => {
    const p = tmpPath('no-mcp-key');
    writeConfig(p, { someOtherKey: true });
    await cmdMcp(['install', 'claude', '--config', p]);
    const cfg = readConfigTyped(p);
    expect(cfg.mcpServers).toBeDefined();
    expect('ashlr' in (cfg.mcpServers ?? {})).toBe(true);
  });

  it('preserves other top-level keys', async () => {
    const p = tmpPath('preserves-keys');
    writeConfig(p, { someOtherKey: true });
    await cmdMcp(['install', 'claude', '--config', p]);
    const cfg = readConfig(p) as Record<string, unknown>;
    expect(cfg['someOtherKey']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// install — does not clobber existing servers
// ---------------------------------------------------------------------------

describe('cmdMcp install — never clobbers existing servers', () => {
  it('keeps pre-existing server entries', async () => {
    const p = tmpPath('preserves-existing');
    writeConfig(p, {
      mcpServers: {
        'my-existing-server': { command: 'node', args: ['existing.js'] },
      },
    });
    await cmdMcp(['install', 'claude', '--config', p]);
    const cfg = readConfigTyped(p);
    expect('my-existing-server' in (cfg.mcpServers ?? {})).toBe(true);
  });

  it('preserves existing server command/args unchanged', async () => {
    const p = tmpPath('preserves-cmd');
    const existingEntry = { command: 'python', args: ['-m', 'my_server'] };
    writeConfig(p, { mcpServers: { 'keep-me': existingEntry } });
    await cmdMcp(['install', 'claude', '--config', p]);
    const cfg = readConfigTyped(p);
    const kept = (cfg.mcpServers ?? {})['keep-me'] as typeof existingEntry | undefined;
    expect(kept?.command).toBe('python');
    expect(kept?.args).toEqual(['-m', 'my_server']);
  });

  it('adds ashlr alongside existing servers (total count increases by 1)', async () => {
    const p = tmpPath('count-check');
    writeConfig(p, {
      mcpServers: {
        'server-a': { command: 'node', args: ['a.js'] },
        'server-b': { command: 'node', args: ['b.js'] },
      },
    });
    await cmdMcp(['install', 'claude', '--config', p]);
    const cfg = readConfigTyped(p);
    const keys = Object.keys(cfg.mcpServers ?? {});
    expect(keys).toContain('server-a');
    expect(keys).toContain('server-b');
    expect(keys).toContain('ashlr');
  });
});

// ---------------------------------------------------------------------------
// install — idempotency (second install does not duplicate)
// ---------------------------------------------------------------------------

describe('cmdMcp install — idempotency', () => {
  it('running install twice does not duplicate ashlr entry', async () => {
    const p = tmpPath('idempotent');
    writeConfig(p, { mcpServers: {} });
    await cmdMcp(['install', 'claude', '--config', p]);
    await cmdMcp(['install', 'claude', '--config', p]);
    const cfg = readConfigTyped(p);
    const ashlrEntries = Object.keys(cfg.mcpServers ?? {}).filter(k => k === 'ashlr');
    expect(ashlrEntries).toHaveLength(1);
  });

  it('second install returns exit code 0', async () => {
    const p = tmpPath('idempotent-code');
    writeConfig(p, { mcpServers: {} });
    await cmdMcp(['install', 'claude', '--config', p]);
    const code = await cmdMcp(['install', 'claude', '--config', p]);
    expect(code).toBe(0);
  });

  it('second install does not modify existing servers added before first install', async () => {
    const p = tmpPath('idempotent-preserve');
    writeConfig(p, {
      mcpServers: { 'original-server': { command: 'node', args: [] } },
    });
    await cmdMcp(['install', 'claude', '--config', p]);
    await cmdMcp(['install', 'claude', '--config', p]);
    const cfg = readConfigTyped(p);
    expect('original-server' in (cfg.mcpServers ?? {})).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// install — creates file if it does not exist
// ---------------------------------------------------------------------------

describe('cmdMcp install — creates config if absent', () => {
  it('creates the config file when it does not exist', async () => {
    const p = tmpPath('create-new');
    // Do NOT write the file — it should not exist.
    createdFiles.push(p); // register for cleanup
    expect(fs.existsSync(p)).toBe(false);
    await cmdMcp(['install', 'claude', '--config', p]);
    expect(fs.existsSync(p)).toBe(true);
  });

  it('new config contains ashlr server', async () => {
    const p = tmpPath('create-has-ashlr');
    createdFiles.push(p);
    await cmdMcp(['install', 'claude', '--config', p]);
    const cfg = readConfigTyped(p);
    expect('ashlr' in (cfg.mcpServers ?? {})).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// install ashlrcode — also works
// ---------------------------------------------------------------------------

describe('cmdMcp install — ashlrcode target', () => {
  it('returns exit code 0 for ashlrcode target', async () => {
    const p = tmpPath('ashlrcode-target');
    writeConfig(p, { mcpServers: {} });
    const code = await cmdMcp(['install', 'ashlrcode', '--config', p]);
    expect(code).toBe(0);
  });

  it('adds ashlr server for ashlrcode target', async () => {
    const p = tmpPath('ashlrcode-adds');
    writeConfig(p, { mcpServers: {} });
    await cmdMcp(['install', 'ashlrcode', '--config', p]);
    const cfg = readConfigTyped(p);
    expect('ashlr' in (cfg.mcpServers ?? {})).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// install — malformed config is NEVER clobbered (HIGH regression guard)
// ---------------------------------------------------------------------------

describe('cmdMcp install — refuses to clobber malformed config', () => {
  // A file that exists but is not valid JSON must be left byte-for-byte
  // unchanged and the install must fail with a non-zero exit, rather than
  // deep-merging into {} and destroying the user's real config.
  const MALFORMED = '{ "mcpServers": { "real-server": { "command": "node" }, '; // trailing comma + unterminated

  it('returns a non-zero exit code on malformed JSON', async () => {
    const p = tmpPath('malformed-exit');
    createdFiles.push(p);
    fs.writeFileSync(p, MALFORMED, 'utf8');
    const code = await cmdMcp(['install', 'claude', '--config', p]);
    expect(code).not.toBe(0);
  });

  it('leaves the malformed file byte-for-byte unchanged', async () => {
    const p = tmpPath('malformed-unchanged');
    createdFiles.push(p);
    fs.writeFileSync(p, MALFORMED, 'utf8');
    const before = fs.readFileSync(p, 'utf8');
    await cmdMcp(['install', 'claude', '--config', p]);
    const after = fs.readFileSync(p, 'utf8');
    expect(after).toBe(before);
  });

  it('does not create a .bak (nothing was backed up because parse failed first)', async () => {
    const p = tmpPath('malformed-no-bak');
    createdFiles.push(p);
    fs.writeFileSync(p, MALFORMED, 'utf8');
    await cmdMcp(['install', 'claude', '--config', p]);
    expect(fs.existsSync(p + '.bak')).toBe(false);
  });

  it('does not produce a valid-JSON file that only contains the ashlr entry', async () => {
    const p = tmpPath('malformed-not-clobbered');
    createdFiles.push(p);
    fs.writeFileSync(p, MALFORMED, 'utf8');
    await cmdMcp(['install', 'claude', '--config', p]);
    // Still unparseable → never overwritten with a clean merged result.
    expect(() => JSON.parse(fs.readFileSync(p, 'utf8'))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Safety guard: verify test never attempted to write real configs
// ---------------------------------------------------------------------------

describe('SAFETY: no real config files were touched', () => {
  it('all created files are in os.tmpdir()', () => {
    // This test validates that our tmpPath() helper enforces tmp-only writes.
    // By the time this test runs, all previous tests have cleaned up.
    // We just verify the assertion function itself rejects real paths.
    for (const forbidden of FORBIDDEN_PATHS) {
      expect(() => assertNotRealConfig(forbidden)).toThrow('SAFETY VIOLATION');
    }
  });

  it('a tmp path passes the safety check', () => {
    const safePath = path.join(TMP, 'totally-safe-test-file.json');
    expect(() => assertNotRealConfig(safePath)).not.toThrow();
  });
});
