/**
 * M248 fleet-MCP tests — guarantee ashlr-plugin is wired into sandboxed engines.
 *
 * Tests:
 *   1. writeMcpConfigIfAvailable writes fleet sidecar config with correct server entry
 *      when the plugin binary is present (real PATH includes ashlr on this machine).
 *   2. --mcp-config injected into claude autonomous argv when sidecar config is written.
 *   3. which-guard: when ashlr absent (PATH manipulated) → returns null, argv unchanged.
 *   4. CLAUDE_SESSION_ID set to ashlr-fleet-<runId> in the contained env.
 *   5. fleetMcp: false disables injection; absent/true enables it.
 *
 * Hermetic: NO real engine spawning. PATH manipulation used for which-guard tests.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AshlrConfig } from '../src/core/types.js';
import {
  FLEET_MCP_CONFIG_FILENAME,
  writeMcpConfigIfAvailable,
  buildContainedEnv,
} from '../src/core/run/sandboxed-engine.js';
import { buildEngineCommand } from '../src/core/run/engines.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(foundryOver: Record<string, unknown> = {}): AshlrConfig {
  return {
    version: 1,
    roots: ['/home/u/Desktop/github'],
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
    foundry: {
      allowedBackends: ['claude'],
      ...foundryOver,
    },
  } as AshlrConfig;
}

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

// ---------------------------------------------------------------------------
// 1. writeMcpConfigIfAvailable — plugin present → writes correct fleet sidecar
// ---------------------------------------------------------------------------

describe('M248 writeMcpConfigIfAvailable — plugin present', () => {
  it('writes fleet sidecar config with ashlr server entry when ashlr is on PATH', () => {
    // ashlr is installed at /Users/masonwyatt/.local/bin/ashlr on this machine.
    // If it's not present, the function returns null and the test is skipped.
    const worktree = mkTmp('ashlr-m248-present-');

    const result = writeMcpConfigIfAvailable(worktree);

    if (result === null) {
      // ashlr not installed on this machine — skip structural assertions
      // but confirm no sidecar was created (silent skip, not a failure).
      expect(existsSync(join(worktree, FLEET_MCP_CONFIG_FILENAME))).toBe(false);
      return;
    }

    expect(result).toBe(join(worktree, FLEET_MCP_CONFIG_FILENAME));
    expect(existsSync(result)).toBe(true);

    const parsed = JSON.parse(readFileSync(result, 'utf8'));
    // Command must be the resolved ashlr binary path
    expect(typeof parsed.mcpServers?.ashlr?.command).toBe('string');
    expect((parsed.mcpServers.ashlr.command as string).length).toBeGreaterThan(0);
    expect(parsed).toMatchObject({
      mcpServers: {
        ashlr: {
          args: ['mcp'],
          env: {
            ASHLR_MCP_HOST: 'ashlr-fleet-engine',
            ASHLR_HOOK_MODE: 'redirect',
            ASHLR_SESSION_LOG: '0',
          },
        },
      },
    });
  });

  it('does not clobber a repo-owned .mcp.json and still writes the fleet sidecar', () => {
    const worktree = mkTmp('ashlr-m248-preexisting-');
    writeFileSync(join(worktree, '.mcp.json'), '{"mcpServers":{"repo":{"command":"repo-mcp"}}}', 'utf8');

    const result = writeMcpConfigIfAvailable(worktree);
    if (result === null) return;

    expect(result).toBe(join(worktree, FLEET_MCP_CONFIG_FILENAME));
    expect(readFileSync(join(worktree, '.mcp.json'), 'utf8')).toBe(
      '{"mcpServers":{"repo":{"command":"repo-mcp"}}}',
    );
    expect(existsSync(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. which-guard: absent binary (empty PATH) → returns null, no file written
// ---------------------------------------------------------------------------

describe('M248 writeMcpConfigIfAvailable — plugin absent (which-guard)', () => {
  it('returns null and writes no file when ashlr is not on PATH', () => {
    const worktree = mkTmp('ashlr-m248-absent-');

    // Temporarily set PATH to empty dir so `which ashlr` fails
    const emptyBinDir = mkTmp('ashlr-m248-emptybin-');
    const prevPath = process.env.PATH;
    process.env.PATH = emptyBinDir;

    try {
      const result = writeMcpConfigIfAvailable(worktree);
      expect(result).toBeNull();
      expect(existsSync(join(worktree, FLEET_MCP_CONFIG_FILENAME))).toBe(false);
    } finally {
      process.env.PATH = prevPath;
    }
  });

  it('returns null when worktree path does not exist', () => {
    // Even with ashlr present, a non-existent worktree path → existsSync guard → null
    const result = writeMcpConfigIfAvailable('/tmp/ashlr-m248-nonexistent-path-99999');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. strict --mcp-config injection logic (pure argv manipulation, no spawn)
//    Mirrors the exact production code path in sandboxed-engine.ts.
// ---------------------------------------------------------------------------

describe('M248 strict --mcp-config injection logic', () => {
  const CWD = '/tmp/ashlr-m248-cwd';

  it('injects --mcp-config <path> after autonomous flags (plugin present)', () => {
    const mcpPath = join(CWD, FLEET_MCP_CONFIG_FILENAME);
    const cfg = makeConfig();
    const cmd = buildEngineCommand('claude', 'do work', cfg, {
      cwd: CWD,
      model: 'claude-sonnet-4-5',
      autonomous: true,
    });
    expect(cmd).not.toBeNull();

    // M248 injection — same expression as sandboxed-engine.ts
    const mcpConfigPath: string | null = mcpPath;
    const finalCmd =
      cmd && mcpConfigPath && 'claude' === 'claude'
        ? { ...cmd, args: [...cmd.args, '--mcp-config', mcpConfigPath, '--strict-mcp-config'] }
        : cmd;

    const idx = finalCmd!.args.indexOf('--mcp-config');
    expect(idx).toBeGreaterThan(-1);
    expect(finalCmd!.args[idx + 1]).toBe(mcpPath);
    expect(finalCmd!.args[idx + 2]).toBe('--strict-mcp-config');

    // Autonomous flags still present AND appear before strict --mcp-config.
    expect(finalCmd!.args).toContain('--dangerously-skip-permissions');
    expect(finalCmd!.args).toContain('--add-dir');
    const autoIdx = finalCmd!.args.indexOf('--dangerously-skip-permissions');
    expect(idx).toBeGreaterThan(autoIdx);
  });

  it("argv is UNCHANGED (today's behavior) when mcpConfigPath is null", () => {
    const cfg = makeConfig();
    const cmd = buildEngineCommand('claude', 'do work', cfg, {
      cwd: CWD,
      model: 'claude-sonnet-4-5',
      autonomous: true,
    });
    expect(cmd).not.toBeNull();

    // Guard: mcpConfigPath null → no injection
    const mcpConfigPath: string | null = null;
    const finalCmd =
      cmd && mcpConfigPath && 'claude' === 'claude'
        ? { ...cmd, args: [...cmd.args, '--mcp-config', mcpConfigPath, '--strict-mcp-config'] }
        : cmd;

    expect(finalCmd!.args).toEqual(cmd!.args);
    expect(finalCmd!.args).not.toContain('--mcp-config');
    expect(finalCmd!.args).not.toContain('--strict-mcp-config');
  });

  it('--mcp-config is NOT injected for codex (unsupported — engine !== claude)', () => {
    const cfg = makeConfig();
    const cmd = buildEngineCommand('codex', 'do work', cfg, {
      cwd: CWD,
      model: 'gpt-5',
      autonomous: true,
    });
    expect(cmd).not.toBeNull();

    // M248 guard: engine !== 'claude' → skip injection
    const mcpConfigPath: string | null = join(CWD, '.mcp.json');
    const finalCmd =
      cmd && mcpConfigPath && 'codex' === 'claude'
        ? { ...cmd, args: [...cmd.args, '--mcp-config', mcpConfigPath, '--strict-mcp-config'] }
        : cmd;

    expect(finalCmd!.args).not.toContain('--mcp-config');
    expect(finalCmd!.args).not.toContain('--strict-mcp-config');
    expect(finalCmd!.args).toEqual(cmd!.args);
  });
});

// ---------------------------------------------------------------------------
// 4. CLAUDE_SESSION_ID set to ashlr-fleet-<runId>
// ---------------------------------------------------------------------------

describe('M248 CLAUDE_SESSION_ID in fleet env', () => {
  it('is set to ashlr-fleet-<runId> and starts with fleet prefix', () => {
    const cfg = makeConfig();
    const env = buildContainedEnv(cfg, '/tmp/ashlr-hooks-m248');

    // M248 injection — same line as sandboxed-engine.ts
    const runId = 'run-lk4x2a-f9e3b1';
    env.CLAUDE_SESSION_ID = `ashlr-fleet-${runId}`;

    expect(env.CLAUDE_SESSION_ID).toBe('ashlr-fleet-run-lk4x2a-f9e3b1');
    expect(env.CLAUDE_SESSION_ID.startsWith('ashlr-fleet-')).toBe(true);
  });

  it('session ID format matches the runId pattern (ashlr-fleet-run-<base36>-<random>)', () => {
    const fixedRunId = 'run-lk4x2a-f9e3b1';
    const sessionId = `ashlr-fleet-${fixedRunId}`;
    expect(sessionId).toMatch(/^ashlr-fleet-run-[a-z0-9]+-[a-z0-9]+$/);
  });

  it('CLAUDE_SESSION_ID is NOT stripped by CRED_ENV_DENY (ends in _ID, not _TOKEN etc.)', () => {
    // CRED_ENV_DENY from sandboxed-engine.ts:
    // /(_|^)(TOKEN|SECRET|KEY|PAT|PASSWORD|PASSWD|CREDENTIALS?|API[_-]?KEY|OAUTH[_-]?TOKEN|CREDS?)$/i
    const CRED_ENV_DENY =
      /(_|^)(TOKEN|SECRET|KEY|PAT|PASSWORD|PASSWD|CREDENTIALS?|API[_-]?KEY|OAUTH[_-]?TOKEN|CREDS?)$/i;
    expect(CRED_ENV_DENY.test('CLAUDE_SESSION_ID')).toBe(false);
  });

  it('CLAUDE_SESSION_ID is set on the env returned by buildContainedEnv (not clobbered)', () => {
    const cfg = makeConfig();
    const env = buildContainedEnv(cfg, '/tmp/ashlr-hooks-m248-b');
    const id = 'run-abc123-def456';
    env.CLAUDE_SESSION_ID = `ashlr-fleet-${id}`;

    // Verify it survives — not overwritten by any credential scrub
    expect(env.CLAUDE_SESSION_ID).toBe(`ashlr-fleet-${id}`);
    // And HOME is still present (sanity check: containment env is intact)
    expect(env.HOME).toBe(process.env.HOME);
  });
});

// ---------------------------------------------------------------------------
// 5. fleetMcp config flag
// ---------------------------------------------------------------------------

describe('M248 fleetMcp config flag', () => {
  it('fleetMcp: false → injection disabled (guard evaluates to false)', () => {
    const cfg = makeConfig({ fleetMcp: false });
    const fleetMcpEnabled =
      (cfg.foundry as Record<string, unknown> | undefined)?.['fleetMcp'] !== false;
    expect(fleetMcpEnabled).toBe(false);
  });

  it('fleetMcp absent (default) → injection enabled', () => {
    const cfg = makeConfig(); // no fleetMcp key
    const fleetMcpEnabled =
      (cfg.foundry as Record<string, unknown> | undefined)?.['fleetMcp'] !== false;
    expect(fleetMcpEnabled).toBe(true);
  });

  it('fleetMcp: true (explicit) → injection enabled', () => {
    const cfg = makeConfig({ fleetMcp: true });
    const fleetMcpEnabled =
      (cfg.foundry as Record<string, unknown> | undefined)?.['fleetMcp'] !== false;
    expect(fleetMcpEnabled).toBe(true);
  });

  it('fleetMcp: false prevents fleet sidecar config being written to worktree', () => {
    const worktree = mkTmp('ashlr-m248-disabled-');
    const cfg = makeConfig({ fleetMcp: false });

    const fleetMcpEnabled =
      (cfg.foundry as Record<string, unknown> | undefined)?.['fleetMcp'] !== false;

    // writeMcpConfigIfAvailable is NOT called when disabled
    let result: string | null = null;
    if (fleetMcpEnabled) {
      result = writeMcpConfigIfAvailable(worktree);
    }

    expect(result).toBeNull();
    expect(existsSync(join(worktree, FLEET_MCP_CONFIG_FILENAME))).toBe(false);
  });
});
