/**
 * Tests for src/core/mcp-gateway.ts — probeServer (M3)
 *
 * Uses the in-repo fixture at test/fixtures/mock-mcp-server.mjs which is a
 * real stdio MCP server exposing 2 tools: "ping" and "echo".
 *
 * probeServer() starts the fixture as a child process, lists its tools, and
 * tears it down. Hermetic: no real downstream MCP servers started.
 *
 * Tests:
 *   - probe against the fixture → ok:true, toolCount:2, tools named correctly
 *   - probe against a nonexistent command → ok:false, error set
 *   - probe times out (using a server that hangs) → ok:false within timeout
 *   - probeServer never throws — errors surface in the health object
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as url from 'node:url';

import { probeServer, isSelfGateway, GATEWAY_ENV_MARKER } from '../src/core/mcp-gateway.js';
import type { McpServerSpec } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Fixture path
// ---------------------------------------------------------------------------

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(__dirname, 'fixtures', 'mock-mcp-server.mjs');

function makeSpec(overrides: Partial<McpServerSpec> = {}): McpServerSpec {
  return {
    name: 'mock-server',
    command: 'node',
    args: [FIXTURE_PATH],
    env: undefined,
    source: 'test',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// probeServer — fixture server (2 tools: ping + echo)
// ---------------------------------------------------------------------------

describe('probeServer — fixture mock MCP server', () => {
  it('returns ok:true', async () => {
    const health = await probeServer(makeSpec());
    expect(health.ok).toBe(true);
  }, 15_000);

  it('returns toolCount:2', async () => {
    const health = await probeServer(makeSpec());
    expect(health.toolCount).toBe(2);
  }, 15_000);

  it('tools array contains "ping"', async () => {
    const health = await probeServer(makeSpec());
    expect(health.tools).toContain('ping');
  }, 15_000);

  it('tools array contains "echo"', async () => {
    const health = await probeServer(makeSpec());
    expect(health.tools).toContain('echo');
  }, 15_000);

  it('name matches the spec name', async () => {
    const health = await probeServer(makeSpec({ name: 'test-fixture' }));
    expect(health.name).toBe('test-fixture');
  }, 15_000);

  it('does not set error when ok', async () => {
    const health = await probeServer(makeSpec());
    expect(health.error).toBeUndefined();
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Self-aggregation guard (fork-bomb prevention)
// ---------------------------------------------------------------------------

describe('isSelfGateway — fork-bomb self-exclusion', () => {
  it('flags the documented install entry (name "ashlr", args ["mcp"])', () => {
    const self = makeSpec({
      name: 'ashlr',
      command: '/Users/x/Desktop/github/dev-tools/ashlr-hub/bin/ashlr',
      args: ['mcp'],
    });
    expect(isSelfGateway(self)).toBe(true);
  });

  it('flags a bare `ashlr mcp` command regardless of name', () => {
    expect(isSelfGateway(makeSpec({ name: 'whatever', command: 'ashlr', args: ['mcp'] }))).toBe(true);
  });

  it('does NOT flag a normal downstream server', () => {
    expect(isSelfGateway(makeSpec({ name: 'phantom-secrets', command: 'phantom', args: ['mcp'] }))).toBe(false);
    expect(isSelfGateway(makeSpec({ name: 'some-server', command: 'node', args: ['srv.js'] }))).toBe(false);
  });

  it('does NOT flag an ashlr-named server that is not the gateway (no mcp arg)', () => {
    expect(isSelfGateway(makeSpec({ name: 'ashlr', command: 'ashlr', args: ['--version'] }))).toBe(false);
  });

  it('a registry whose ONLY entry is the gateway yields zero aggregable servers', () => {
    const registry = [
      makeSpec({ name: 'ashlr', command: '/abs/bin/ashlr', args: ['mcp'] }),
    ];
    const aggregable = registry.filter((s) => !isSelfGateway(s));
    expect(aggregable).toHaveLength(0);
  });

  it('exposes a gateway env marker constant for child self-detection', () => {
    expect(typeof GATEWAY_ENV_MARKER).toBe('string');
    expect(GATEWAY_ENV_MARKER.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// probeServer — nonexistent command (ENOENT)
// ---------------------------------------------------------------------------

describe('probeServer — nonexistent command', () => {
  it('does not throw', async () => {
    await expect(
      probeServer(makeSpec({ command: 'totally-nonexistent-binary-xyz-42', args: [] }))
    ).resolves.toBeDefined();
  }, 10_000);

  it('returns ok:false for nonexistent command', async () => {
    const health = await probeServer(
      makeSpec({ command: 'totally-nonexistent-binary-xyz-42', args: [] })
    );
    expect(health.ok).toBe(false);
  }, 10_000);

  it('returns toolCount:0 for nonexistent command', async () => {
    const health = await probeServer(
      makeSpec({ command: 'totally-nonexistent-binary-xyz-42', args: [] })
    );
    expect(health.toolCount).toBe(0);
  }, 10_000);

  it('returns empty tools array for nonexistent command', async () => {
    const health = await probeServer(
      makeSpec({ command: 'totally-nonexistent-binary-xyz-42', args: [] })
    );
    expect(health.tools).toEqual([]);
  }, 10_000);

  it('sets error field for nonexistent command', async () => {
    const health = await probeServer(
      makeSpec({ command: 'totally-nonexistent-binary-xyz-42', args: [] })
    );
    expect(typeof health.error).toBe('string');
    expect(health.error!.length).toBeGreaterThan(0);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// probeServer — unsafe argv refusal (no secret-bearing child process)
// ---------------------------------------------------------------------------

describe('probeServer — unsafe MCP argv', () => {
  it('refuses secret-like argv before launch and redacts the error', async () => {
    const health = await probeServer(
      makeSpec({ args: [FIXTURE_PATH, '--access-token', 'sbp_5bf63c2c9911'] }),
    );

    expect(health.ok).toBe(false);
    expect(health.error).toContain('unsafe MCP argv refused');
    expect(health.error).toContain('<redacted>');
    expect(health.error).not.toContain('sbp_5bf63c2c9911');
  }, 10_000);
});

// ---------------------------------------------------------------------------
// probeServer — timeout (server that never responds)
// ---------------------------------------------------------------------------

describe('probeServer — timeout with unresponsive server', () => {
  it('resolves within a short custom timeout', async () => {
    // Use `node -e "process.stdin.resume()"` — reads stdin but never writes.
    // With a 1.5s timeout this should resolve quickly without hanging the suite.
    const health = await probeServer(
      makeSpec({ command: 'node', args: ['-e', 'process.stdin.resume()'] }),
      1500,
    );
    expect(health).toBeDefined();
  }, 10_000);

  it('returns ok:false when server times out', async () => {
    const health = await probeServer(
      makeSpec({ command: 'node', args: ['-e', 'process.stdin.resume()'] }),
      1500,
    );
    expect(health.ok).toBe(false);
  }, 10_000);

  it('sets error field when timed out', async () => {
    const health = await probeServer(
      makeSpec({ command: 'node', args: ['-e', 'process.stdin.resume()'] }),
      1500,
    );
    expect(typeof health.error).toBe('string');
  }, 10_000);

  it('returns empty tools when timed out', async () => {
    const health = await probeServer(
      makeSpec({ command: 'node', args: ['-e', 'process.stdin.resume()'] }),
      1500,
    );
    expect(health.tools).toEqual([]);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// probeServer — server that exits immediately (crash)
// ---------------------------------------------------------------------------

describe('probeServer — server that exits immediately', () => {
  it('does not throw when server crashes on startup', async () => {
    await expect(
      probeServer(makeSpec({ command: 'node', args: ['-e', 'process.exit(1)'] }))
    ).resolves.toBeDefined();
  }, 10_000);

  it('returns ok:false when server exits immediately', async () => {
    const health = await probeServer(
      makeSpec({ command: 'node', args: ['-e', 'process.exit(1)'] })
    );
    expect(health.ok).toBe(false);
  }, 10_000);

  it('returns toolCount:0 when server exits immediately', async () => {
    const health = await probeServer(
      makeSpec({ command: 'node', args: ['-e', 'process.exit(1)'] })
    );
    expect(health.toolCount).toBe(0);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// probeServer — health shape invariants
// ---------------------------------------------------------------------------

describe('probeServer — McpServerHealth shape invariants', () => {
  it('always returns name matching spec.name', async () => {
    const health = await probeServer(makeSpec({ name: 'shape-test' }));
    expect(health.name).toBe('shape-test');
  }, 15_000);

  it('toolCount always equals tools.length', async () => {
    const health = await probeServer(makeSpec());
    expect(health.toolCount).toBe(health.tools.length);
  }, 15_000);

  it('ok:true implies error is absent', async () => {
    const health = await probeServer(makeSpec());
    if (health.ok) {
      expect(health.error).toBeUndefined();
    }
  }, 15_000);

  it('ok:false implies toolCount is 0', async () => {
    const health = await probeServer(
      makeSpec({ command: 'totally-nonexistent-binary-xyz-42', args: [] })
    );
    if (!health.ok) {
      expect(health.toolCount).toBe(0);
    }
  }, 10_000);
});
