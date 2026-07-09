/**
 * Tests for src/core/mcp-registry.ts (M3)
 *
 * Hermetic: writes real temp JSON files in os.tmpdir() for config fixtures,
 * then overrides knownConfigPaths to point at them. No real ~/.claude* touched.
 *
 * Verifies:
 *   - discover dedupes by name (first-occurrence wins)
 *   - sources are tracked correctly
 *   - env value redaction helper hides values
 *   - malformed / unreadable configs are skipped without throwing
 *   - recognises "ashlr" and "phantom-secrets" servers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// We mock the module so we can override knownConfigPaths without touching
// real home-dir files. The mock replaces knownConfigPaths; discoverMcpServers
// is the real implementation exercised through the module.
// ---------------------------------------------------------------------------

// Shared override list that tests mutate.
let _overridePaths: string[] = [];

vi.mock('../src/core/mcp-registry.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/mcp-registry.js')>();
  return {
    ...real,
    knownConfigPaths: () => _overridePaths,
  };
});

import { discoverMcpServers, knownConfigPaths, redactEnv } from '../src/core/mcp-registry.js';
import { cmdMcp } from '../src/cli/mcp.js';
import type { McpServerSpec } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP = os.tmpdir();

/** Write a JSON object to a unique temp file; return the path. */
function writeTmp(obj: unknown, name: string): string {
  const p = path.join(TMP, `ashlr-test-registry-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
  return p;
}

/** Build a config-shaped object with an mcpServers map. */
function makeConfig(servers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>): unknown {
  return { mcpServers: servers };
}

const tmpFiles: string[] = [];

function mkTmp(obj: unknown, name: string): string {
  const p = writeTmp(obj, name);
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  // Clean up temp files.
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  tmpFiles.length = 0;
  _overridePaths = [];
});

async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; stdout: string }> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await fn();
    return { code, stdout: chunks.join('') };
  } finally {
    process.stdout.write = originalWrite;
  }
}

// ---------------------------------------------------------------------------
// knownConfigPaths — override works
// ---------------------------------------------------------------------------

describe('knownConfigPaths — via mock override', () => {
  it('returns the paths set by the mock override', () => {
    _overridePaths = ['/tmp/fake-a.json', '/tmp/fake-b.json'];
    expect(knownConfigPaths()).toEqual(['/tmp/fake-a.json', '/tmp/fake-b.json']);
  });
});

// ---------------------------------------------------------------------------
// discoverMcpServers — single config file
// ---------------------------------------------------------------------------

describe('discoverMcpServers — single config with two servers', () => {
  beforeEach(() => {
    const p = mkTmp(
      makeConfig({
        'my-server': { command: 'node', args: ['server.js'] },
        'other-server': { command: 'python', args: ['-m', 'mcp_server'] },
      }),
      'single',
    );
    _overridePaths = [p];
  });

  it('returns both servers', () => {
    const reg = discoverMcpServers(knownConfigPaths());
    const names = reg.servers.map(s => s.name);
    expect(names).toContain('my-server');
    expect(names).toContain('other-server');
  });

  it('each server has command + args', () => {
    const reg = discoverMcpServers(knownConfigPaths());
    const s = reg.servers.find(s => s.name === 'my-server');
    expect(s?.command).toBe('node');
    expect(s?.args).toEqual(['server.js']);
  });

  it('source is set to the config file path', () => {
    const reg = discoverMcpServers(knownConfigPaths());
    for (const s of reg.servers) {
      expect(typeof s.source).toBe('string');
      expect(s.source.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// discoverMcpServers — deduplication (first-occurrence wins)
// ---------------------------------------------------------------------------

describe('discoverMcpServers — deduplication across config files', () => {
  let pathA: string;
  let pathB: string;

  beforeEach(() => {
    pathA = mkTmp(
      makeConfig({
        'shared-server': { command: 'node', args: ['a.js'] },
        'only-in-a': { command: 'node', args: ['only-a.js'] },
      }),
      'dedup-a',
    );
    pathB = mkTmp(
      makeConfig({
        'shared-server': { command: 'python', args: ['b.py'] },  // duplicate name, different command
        'only-in-b': { command: 'deno', args: ['b.ts'] },
      }),
      'dedup-b',
    );
    _overridePaths = [pathA, pathB];
  });

  it('dedupes: shared-server appears only once', () => {
    const reg = discoverMcpServers(knownConfigPaths());
    const sharedEntries = reg.servers.filter(s => s.name === 'shared-server');
    expect(sharedEntries).toHaveLength(1);
  });

  it('first-occurrence wins: shared-server uses command from config A', () => {
    const reg = discoverMcpServers(knownConfigPaths());
    const shared = reg.servers.find(s => s.name === 'shared-server');
    expect(shared?.command).toBe('node');
    expect(shared?.args).toEqual(['a.js']);
  });

  it('non-duplicate servers from both configs are present', () => {
    const reg = discoverMcpServers(knownConfigPaths());
    const names = reg.servers.map(s => s.name);
    expect(names).toContain('only-in-a');
    expect(names).toContain('only-in-b');
  });

  it('total server count reflects dedup (3, not 4)', () => {
    const reg = discoverMcpServers(knownConfigPaths());
    expect(reg.servers).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// discoverMcpServers — env fields are present (raw values in spec)
// ---------------------------------------------------------------------------

describe('discoverMcpServers — env field is preserved in spec', () => {
  beforeEach(() => {
    const p = mkTmp(
      makeConfig({
        'secret-server': {
          command: 'node',
          args: ['srv.js'],
          env: { API_KEY: 'super-secret-value-12345', DEBUG: '1' },
        },
      }),
      'env',
    );
    _overridePaths = [p];
  });

  it('env is present on the spec', () => {
    const reg = discoverMcpServers(knownConfigPaths());
    const s = reg.servers.find(s => s.name === 'secret-server');
    expect(s?.env).toBeDefined();
  });

  it('env keys are preserved', () => {
    const reg = discoverMcpServers(knownConfigPaths());
    const s = reg.servers.find(s => s.name === 'secret-server');
    expect(Object.keys(s?.env ?? {})).toContain('API_KEY');
    expect(Object.keys(s?.env ?? {})).toContain('DEBUG');
  });
});

// ---------------------------------------------------------------------------
// Env redaction helper — redactEnv
// ---------------------------------------------------------------------------

describe('env redaction: serialized display must not expose values', () => {
  it('redacting env replaces all values with <set>', () => {
    const env = { API_KEY: 'super-secret', TOKEN: 'ghp_abc123' };
    // Simulate what display code should do: redact values before printing.
    const redacted = Object.fromEntries(
      Object.keys(env).map(k => [k, '<set>'])
    );
    expect(redacted['API_KEY']).toBe('<set>');
    expect(redacted['TOKEN']).toBe('<set>');
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('ghp_abc123');
  });

  it('spec env values must not appear in any redacted serialization', () => {
    // If we had raw env, redaction must scrub all values.
    const rawEnv = { SECRET: 'hunter2', API: 'sk-abc987654321' };
    const redacted = Object.fromEntries(Object.keys(rawEnv).map(k => [k, '<set>']));
    const json = JSON.stringify({ env: redacted });
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('sk-abc987654321');
  });
});

// ---------------------------------------------------------------------------
// discoverMcpServers — recognizes ashlr + phantom-secrets
// ---------------------------------------------------------------------------

describe('discoverMcpServers — recognizes ashlr-plugin server', () => {
  beforeEach(() => {
    const p = mkTmp(
      makeConfig({
        ashlr: { command: 'node', args: ['/path/to/ashlr-plugin/dist/index.js', '--mcp'] },
        'phantom-secrets': { command: 'phantom', args: ['mcp'] },
        'some-other': { command: 'npx', args: ['other-server'] },
      }),
      'known-servers',
    );
    _overridePaths = [p];
  });

  it('finds server named "ashlr"', () => {
    const reg = discoverMcpServers(knownConfigPaths());
    const s = reg.servers.find(s => s.name === 'ashlr');
    expect(s).toBeDefined();
    expect(s?.name).toBe('ashlr');
  });

  it('finds server named "phantom-secrets"', () => {
    const reg = discoverMcpServers(knownConfigPaths());
    const s = reg.servers.find(s => s.name === 'phantom-secrets');
    expect(s).toBeDefined();
    expect(s?.name).toBe('phantom-secrets');
  });

  it('does not drop other servers', () => {
    const reg = discoverMcpServers(knownConfigPaths());
    const s = reg.servers.find(s => s.name === 'some-other');
    expect(s).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// discoverMcpServers — malformed / unreadable configs are skipped
// ---------------------------------------------------------------------------

describe('discoverMcpServers — malformed JSON config is skipped', () => {
  beforeEach(() => {
    const badPath = path.join(TMP, `ashlr-test-bad-${Date.now()}.json`);
    fs.writeFileSync(badPath, '{ this is not json !!!', 'utf8');
    tmpFiles.push(badPath);

    const goodPath = mkTmp(
      makeConfig({ 'good-server': { command: 'node', args: ['g.js'] } }),
      'good',
    );
    _overridePaths = [badPath, goodPath];
  });

  it('does not throw when a config file is malformed', () => {
    expect(() => discoverMcpServers(knownConfigPaths())).not.toThrow();
  });

  it('still returns servers from valid configs', () => {
    const reg = discoverMcpServers(knownConfigPaths());
    const names = reg.servers.map(s => s.name);
    expect(names).toContain('good-server');
  });
});

describe('discoverMcpServers — missing config file is skipped', () => {
  beforeEach(() => {
    const missingPath = path.join(TMP, 'ashlr-test-does-not-exist-xyz.json');
    const goodPath = mkTmp(
      makeConfig({ 'fallback-server': { command: 'node', args: [] } }),
      'fallback',
    );
    _overridePaths = [missingPath, goodPath];
  });

  it('does not throw when a config file does not exist', () => {
    expect(() => discoverMcpServers(knownConfigPaths())).not.toThrow();
  });

  it('returns servers from the readable config', () => {
    const reg = discoverMcpServers(knownConfigPaths());
    expect(reg.servers.find(s => s.name === 'fallback-server')).toBeDefined();
  });
});

describe('discoverMcpServers — config with no mcpServers key', () => {
  beforeEach(() => {
    const p = mkTmp({ someOtherKey: { irrelevant: true } }, 'no-mcp');
    _overridePaths = [p];
  });

  it('returns empty servers when no mcpServers key', () => {
    const reg = discoverMcpServers(knownConfigPaths());
    expect(reg.servers).toHaveLength(0);
  });

  it('does not throw', () => {
    expect(() => discoverMcpServers(knownConfigPaths())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// discoverMcpServers — empty config list
// ---------------------------------------------------------------------------

describe('discoverMcpServers — no config paths', () => {
  beforeEach(() => {
    _overridePaths = [];
  });

  it('returns empty registry', () => {
    const reg = discoverMcpServers(knownConfigPaths());
    expect(reg.servers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// discoverMcpServers — stable ordering preserved within a config
// ---------------------------------------------------------------------------

describe('discoverMcpServers — stable ordering', () => {
  beforeEach(() => {
    const p = mkTmp(
      makeConfig({
        alpha: { command: 'node', args: ['a.js'] },
        beta: { command: 'node', args: ['b.js'] },
        gamma: { command: 'node', args: ['c.js'] },
      }),
      'order',
    );
    _overridePaths = [p];
  });

  it('servers appear in iteration order', () => {
    const reg = discoverMcpServers(knownConfigPaths());
    const names = reg.servers.map(s => s.name);
    expect(names).toEqual(['alpha', 'beta', 'gamma']);
  });
});

// ---------------------------------------------------------------------------
// discoverMcpServers — per-project sources tracked
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// discoverMcpServers — per-project projects[*].mcpServers (real ~/.claude.json shape)
// ---------------------------------------------------------------------------

describe('discoverMcpServers — projects[*].mcpServers per-project shape', () => {
  let projPath: string;

  beforeEach(() => {
    // The real ~/.claude.json nests MCP servers under projects["/path"].mcpServers.
    projPath = mkTmp(
      {
        projects: {
          '/Users/x/repo-a': {
            mcpServers: { 'proj-srv': { command: 'node', args: ['p.js'] } },
          },
          '/Users/x/repo-b': {
            mcpServers: { 'phantom-secrets': { command: 'phantom', args: ['mcp'] } },
          },
        },
      },
      'per-project',
    );
    _overridePaths = [projPath];
  });

  it('discovers a server nested under projects[*].mcpServers', () => {
    const reg = discoverMcpServers(knownConfigPaths());
    const s = reg.servers.find(s => s.name === 'proj-srv');
    expect(s).toBeDefined();
    expect(s?.command).toBe('node');
    expect(s?.args).toEqual(['p.js']);
  });

  it('tracks the source file for a per-project server', () => {
    const reg = discoverMcpServers(knownConfigPaths());
    const s = reg.servers.find(s => s.name === 'proj-srv');
    expect(s?.source).toContain(path.basename(projPath));
  });

  it('recognizes phantom-secrets when nested per-project', () => {
    const reg = discoverMcpServers(knownConfigPaths());
    expect(reg.servers.find(s => s.name === 'phantom-secrets')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// redactEnv — exported helper locks the '<set>' behavior
// ---------------------------------------------------------------------------

describe('redactEnv — exported helper hides every value', () => {
  it('replaces all env values with the literal "<set>"', () => {
    const spec: McpServerSpec = {
      name: 'secret-srv',
      command: 'node',
      args: [],
      source: 'test',
      env: { API_KEY: 'super-secret-value', TOKEN: 'ghp_abc123' },
    };
    const redacted = redactEnv(spec);
    expect(redacted.env).toEqual({ API_KEY: '<set>', TOKEN: '<set>' });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('super-secret-value');
    expect(serialized).not.toContain('ghp_abc123');
  });

  it('preserves keys while scrubbing values', () => {
    const spec: McpServerSpec = {
      name: 's', command: 'c', args: [], source: 'test',
      env: { A: '1', B: '2' },
    };
    expect(Object.keys(redactEnv(spec).env ?? {})).toEqual(['A', 'B']);
  });

  it('returns the spec unchanged when there is no env', () => {
    const spec: McpServerSpec = { name: 's', command: 'c', args: [], source: 'test' };
    expect(redactEnv(spec)).toEqual(spec);
  });
});

// ---------------------------------------------------------------------------
// Fleet-engine MCP host — no global downstream aggregation
// ---------------------------------------------------------------------------

describe('cmdMcp list — fleet-engine host isolation', () => {
  it('ignores discovered global MCP servers when ASHLR_MCP_HOST=ashlr-fleet-engine', async () => {
    const p = mkTmp(
      makeConfig({
        globalSecretServer: {
          command: 'node',
          args: ['global-mcp.js'],
        },
      }),
      'fleet-host-isolation',
    );
    _overridePaths = [p];

    const prev = process.env.ASHLR_MCP_HOST;
    process.env.ASHLR_MCP_HOST = 'ashlr-fleet-engine';
    try {
      const { code, stdout } = await captureStdout(() => cmdMcp(['list', '--json']));
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout) as { servers: McpServerSpec[] };
      expect(parsed.servers).toEqual([]);
      expect(stdout).not.toContain('globalSecretServer');
      expect(stdout).not.toContain('global-mcp.js');
    } finally {
      if (prev === undefined) delete process.env.ASHLR_MCP_HOST;
      else process.env.ASHLR_MCP_HOST = prev;
    }
  });
});

describe('discoverMcpServers — source label tracks which file each server came from', () => {
  let pathA: string;
  let pathB: string;

  beforeEach(() => {
    pathA = mkTmp(makeConfig({ 'server-from-a': { command: 'node', args: [] } }), 'src-a');
    pathB = mkTmp(makeConfig({ 'server-from-b': { command: 'node', args: [] } }), 'src-b');
    _overridePaths = [pathA, pathB];
  });

  it('server-from-a has source matching pathA', () => {
    const reg = discoverMcpServers(knownConfigPaths());
    const s = reg.servers.find(s => s.name === 'server-from-a');
    expect(s?.source).toContain(path.basename(pathA));
  });

  it('server-from-b has source matching pathB', () => {
    const reg = discoverMcpServers(knownConfigPaths());
    const s = reg.servers.find(s => s.name === 'server-from-b');
    expect(s?.source).toContain(path.basename(pathB));
  });
});
