/**
 * M31 — gateway integration: the real `ashlr mcp` gateway (this repo's built
 * CLI) must advertise every native tool with ZERO downstream servers.
 *
 * Uses the m3 probeServer pattern: spawn the gateway as a child under an
 * isolated tmp HOME (so no real downstream MCP servers are discovered), list
 * its tools, tear down. Builds dist/ once if missing (cli-tidy-json pattern).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import { probeServer } from '../src/core/mcp-gateway.js';
import { listNativeTools } from '../src/core/mcp-native.js';
import type { McpServerSpec } from '../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const cliEntry = join(repoRoot, 'dist', 'cli', 'index.js');

let fx: H1Fixture;

beforeAll(() => {
  if (!existsSync(cliEntry)) {
    execSync('npm run build', { cwd: repoRoot, stdio: 'pipe' });
  }
}, 120_000);

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
  // Minimal config so the gateway's loadConfig() finds a valid file.
  mkdirSync(join(fx.ashlrDir), { recursive: true });
  writeFileSync(join(fx.ashlrDir, 'config.json'), JSON.stringify({ version: 1 }));
});

afterEach(() => {
  fx.cleanup();
});

function gatewaySpec(): McpServerSpec {
  return {
    name: 'ashlr-under-test',
    command: process.execPath,
    args: [cliEntry, 'mcp'],
    // probeServer injects HOME from the live env via withToolEnv/safeChildBase;
    // process.env.HOME already points at the tmp HOME (fixture).
    env: undefined,
    source: 'test',
  };
}

describe('gateway serves native tools', () => {
  it('advertises all native tools with zero downstreams', async () => {
    const health = await probeServer(gatewaySpec(), 20_000);
    expect(health.ok).toBe(true);
    const expected = listNativeTools().map((t) => t.name);
    for (const name of expected) {
      expect(health.tools).toContain(name);
    }
    // tmp HOME discovers no downstream servers — only natives are present.
    expect(health.toolCount).toBe(expected.length);
  }, 30_000);
});
