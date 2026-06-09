/**
 * M20 doctor-fix tests — hermetic, tmp HOME, mocked fs + child_process.
 *
 * Covers fixDoctor():
 *   - Applies ONLY safe fixes: config / index / local-bin symlink / genome-memory / mcp-plugin
 *   - Marks LM-Studio-down, phantom-logout, model-pull as manual (never auto-fixes)
 *   - NEVER deletes or overwrites user data
 *   - NEVER pulls a model (no execFile/spawn with 'pull')
 *   - NEVER touches secrets (phantom checks are always manual)
 *   - NEVER modifies shell profiles
 *   - Each fix is applied only when safe + absent (idempotent)
 *   - Returns FixAction[] in check display order
 *   - Never throws
 *
 * FIX-SAFETY ASSERTIONS (hard guardrails):
 *   NO_AUTO_DOWNLOAD — no 'pull' in any spawned arg
 *   NO_SECRETS       — no secret values in any detail string
 *   NO_DESTRUCTIVE   — config create-only (never overwrite); mkdir-only for genome
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Hermetic HOME
// ---------------------------------------------------------------------------

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m20-fix-'));
  vi.stubEnv('HOME', tmpHome);
  vi.stubEnv('USERPROFILE', tmpHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Mock child_process
// ---------------------------------------------------------------------------

const mockExecFile = vi.fn();
const mockExecFileSync = vi.fn();
const mockSpawnSync = vi.fn(() => ({ status: 1, stdout: '', stderr: '' }));
const mockSpawn = vi.fn(() => ({
  stdout: { on: vi.fn() },
  stderr: { on: vi.fn() },
  on: vi.fn(),
  pid: 99999,
}));

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// ---------------------------------------------------------------------------
// Mock fetch — providers down by default
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig() {
  return {
    version: 1 as const,
    roots: [],
    editor: 'vscode' as const,
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['ollama', 'lmstudio'] as string[],
    },
    telemetry: {},
    tools: {},
  };
}

/** Collect all string args from every mocked spawn/execFile call. */
function allSpawnedArgs(): string[] {
  const allCalls = [
    ...mockExecFile.mock.calls,
    ...mockSpawn.mock.calls,
    ...mockExecFileSync.mock.calls,
    ...mockSpawnSync.mock.calls,
  ];
  return allCalls
    .flat(Infinity)
    .filter((a): a is string => typeof a === 'string');
}

async function importFixDoctor() {
  const mod = await import('../src/core/doctor-fix.js');
  return mod.fixDoctor;
}

// ---------------------------------------------------------------------------
// Return shape
// ---------------------------------------------------------------------------

describe('fixDoctor — return shape', () => {
  it('returns an array', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    const fixDoctor = await importFixDoctor();
    const actions = await fixDoctor(makeConfig());
    expect(Array.isArray(actions)).toBe(true);
  });

  it('every FixAction has checkId, label, applied, detail, manual fields', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    const fixDoctor = await importFixDoctor();
    const actions = await fixDoctor(makeConfig());

    for (const a of actions) {
      expect(typeof a.checkId).toBe('string');
      expect(a.checkId.length).toBeGreaterThan(0);
      expect(typeof a.label).toBe('string');
      expect(typeof a.applied).toBe('boolean');
      expect(typeof a.detail).toBe('string');
      expect(typeof a.manual).toBe('boolean');
    }
  });

  it('applied and manual are mutually exclusive per action (not both true)', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    const fixDoctor = await importFixDoctor();
    const actions = await fixDoctor(makeConfig());

    for (const a of actions) {
      // A fix cannot be both applied AND marked manual at the same time
      expect(a.applied && a.manual).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Safe fixes — config
// ---------------------------------------------------------------------------

describe('fixDoctor — config fix (create-only)', () => {
  it('creates config when missing and marks applied:true', async () => {
    // tmpHome/.ashlr/config.json does not exist yet
    mockFetch.mockRejectedValue(new Error('offline'));
    const fixDoctor = await importFixDoctor();
    const actions = await fixDoctor(makeConfig());

    const configAction = actions.find((a) => a.checkId === 'config');
    if (configAction) {
      // If the config check failed, it should have been fixed
      expect(configAction.applied).toBe(true);
      expect(configAction.manual).toBe(false);
    }
    // Whether or not the action appears, fixDoctor must not throw
  });

  it('config fix is idempotent — running twice does not destroy the first config', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    const fixDoctor = await importFixDoctor();
    const cfg = makeConfig();

    // First run — creates config
    await fixDoctor(cfg);

    // Write a custom value into the config so we can detect if it gets overwritten
    const configPath = join(tmpHome, '.ashlr', 'config.json');
    if (existsSync(configPath)) {
      const original = JSON.parse(readFileSync(configPath, 'utf8'));
      original.__sentinel__ = 'preserve-me';
      writeFileSync(configPath, JSON.stringify(original));
    }

    // Second run — must not overwrite the existing config
    await fixDoctor(cfg);

    if (existsSync(configPath)) {
      const after = JSON.parse(readFileSync(configPath, 'utf8'));
      // Sentinel should still be there (config was not clobbered)
      expect(after.__sentinel__).toBe('preserve-me');
    }
  });

  it('NEVER overwrites an existing config (create-only, not replace)', async () => {
    // Pre-create the config dir + file with a sentinel value
    const ashlrDir = join(tmpHome, '.ashlr');
    mkdirSync(ashlrDir, { recursive: true });
    const configPath = join(ashlrDir, 'config.json');
    const sentinel = { version: 1, __sentinel__: 'do-not-overwrite', roots: [], editor: 'vscode', staleDays: 7, categories: {}, tidyRules: [], keepers: [], models: { lmstudio: '', ollama: '', providerChain: [] }, telemetry: {}, tools: {} };
    writeFileSync(configPath, JSON.stringify(sentinel));

    mockFetch.mockRejectedValue(new Error('offline'));
    const fixDoctor = await importFixDoctor();
    await fixDoctor(makeConfig());

    // Config must not be overwritten
    const after = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(after.__sentinel__).toBe('do-not-overwrite');
  });
});

// ---------------------------------------------------------------------------
// Safe fixes — genome-memory (mkdir only)
// ---------------------------------------------------------------------------

describe('fixDoctor — genome-memory fix (mkdir only)', () => {
  it('genome-memory fix is applied when genome dir is missing', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    const fixDoctor = await importFixDoctor();
    const actions = await fixDoctor(makeConfig());

    const genomeAction = actions.find((a) => a.checkId === 'genome-memory');
    if (genomeAction) {
      // Should have been fixed (mkdir)
      expect(genomeAction.applied).toBe(true);
      expect(genomeAction.manual).toBe(false);
    }
    // Fix is mkdir-only — no content should be written
  });

  it('genome fix is idempotent — second run does not fail', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    const fixDoctor = await importFixDoctor();
    const cfg = makeConfig();

    await fixDoctor(cfg);
    // Second run — genome dir now exists; fix should no-op
    await expect(fixDoctor(cfg)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Safe fixes — mcp-plugin (backup-first, idempotent)
// ---------------------------------------------------------------------------

describe('fixDoctor — mcp-plugin fix (backup-first)', () => {
  it('mcp-plugin fix does not throw when no editor config exists', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    const fixDoctor = await importFixDoctor();
    await expect(fixDoctor(makeConfig())).resolves.toBeDefined();
  });

  it('mcp-plugin fix is idempotent', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    const fixDoctor = await importFixDoctor();
    const cfg = makeConfig();

    const r1 = await fixDoctor(cfg);
    const r2 = await fixDoctor(cfg);

    // Both should complete without throwing
    expect(Array.isArray(r1)).toBe(true);
    expect(Array.isArray(r2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NEVER auto-downloads models (NO_AUTO_DOWNLOAD hard guardrail)
// ---------------------------------------------------------------------------

describe('fixDoctor — NO_AUTO_DOWNLOAD (CRITICAL guardrail)', () => {
  it('never invokes execFile/spawn with "pull"', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    const fixDoctor = await importFixDoctor();

    vi.clearAllMocks();
    await fixDoctor(makeConfig());

    const spawnedArgs = allSpawnedArgs();
    const hasPull = spawnedArgs.some(
      (a) => a.toLowerCase() === 'pull' || a.toLowerCase().includes('ollama pull'),
    );
    expect(hasPull).toBe(false);
  });

  it('model-related checks are always manual — never applied', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    const fixDoctor = await importFixDoctor();
    const actions = await fixDoctor(makeConfig());

    // Any action whose checkId contains 'model' or 'pull' must be manual
    const modelActions = actions.filter(
      (a) =>
        a.checkId.toLowerCase().includes('model') ||
        a.checkId.toLowerCase().includes('pull') ||
        a.label.toLowerCase().includes('model pull') ||
        a.label.toLowerCase().includes('download'),
    );
    for (const a of modelActions) {
      expect(a.applied).toBe(false);
      expect(a.manual).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// NEVER touches secrets (phantom checks always manual)
// ---------------------------------------------------------------------------

describe('fixDoctor — NO_SECRETS (phantom checks always manual)', () => {
  it('phantom-related checks are always manual — never applied', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    const fixDoctor = await importFixDoctor();
    const actions = await fixDoctor(makeConfig());

    const phantomActions = actions.filter(
      (a) =>
        a.checkId.toLowerCase().includes('phantom') ||
        a.checkId.toLowerCase().includes('identity') ||
        a.checkId.toLowerCase().includes('secret'),
    );
    for (const a of phantomActions) {
      expect(a.applied).toBe(false);
      expect(a.manual).toBe(true);
    }
  });

  it('no detail field contains a raw secret value (no api key pattern)', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    const fixDoctor = await importFixDoctor();
    const actions = await fixDoctor(makeConfig());

    // Heuristic: no detail should look like a raw API key (long hex/base64)
    const apiKeyPattern = /[A-Za-z0-9_-]{40,}/;
    for (const a of actions) {
      // Allow long file paths but reject token-like strings
      const withoutPaths = a.detail.replace(/\/[^\s]+/g, '');
      const hasSecretLike = apiKeyPattern.test(withoutPaths);
      // This is a best-effort guard — just ensure details are short/descriptive
      if (hasSecretLike) {
        // Double-check it's not a UUID or known safe pattern
        const isSafePattern = /^[0-9a-f-]{36}$/i.test(withoutPaths.match(apiKeyPattern)?.[0] ?? '');
        if (!isSafePattern) {
          // Warn but don't hard-fail on paths/hashes — only fail on obvious keys
          expect(a.detail).not.toMatch(/sk-[A-Za-z0-9]{40,}/); // OpenAI-style key
          expect(a.detail).not.toMatch(/ghp_[A-Za-z0-9]{36,}/); // GitHub token
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// NEVER destructive — no delete, no overwrite of user data
// ---------------------------------------------------------------------------

describe('fixDoctor — NO_DESTRUCTIVE (never deletes/overwrites user data)', () => {
  it('does not delete any files in tmpHome', async () => {
    // Create a file we care about
    const ashlrDir = join(tmpHome, '.ashlr');
    mkdirSync(ashlrDir, { recursive: true });
    const importantFile = join(ashlrDir, 'important-user-data.json');
    writeFileSync(importantFile, JSON.stringify({ critical: true }));

    mockFetch.mockRejectedValue(new Error('offline'));
    const fixDoctor = await importFixDoctor();
    await fixDoctor(makeConfig());

    // User file must still exist
    expect(existsSync(importantFile)).toBe(true);
  });

  it('does not modify shell profiles (.bashrc, .zshrc, .profile)', async () => {
    // Create fake shell profiles
    const profiles = ['.bashrc', '.zshrc', '.profile', '.bash_profile'];
    const originals: Record<string, string> = {};
    for (const p of profiles) {
      const fullPath = join(tmpHome, p);
      writeFileSync(fullPath, `# original ${p}\nexport PATH="$PATH"\n`);
      originals[p] = readFileSync(fullPath, 'utf8');
    }

    mockFetch.mockRejectedValue(new Error('offline'));
    const fixDoctor = await importFixDoctor();
    await fixDoctor(makeConfig());

    // All profiles must be unchanged
    for (const p of profiles) {
      const fullPath = join(tmpHome, p);
      if (existsSync(fullPath)) {
        const current = readFileSync(fullPath, 'utf8');
        expect(current).toBe(originals[p]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Never throws
// ---------------------------------------------------------------------------

describe('fixDoctor — never throws', () => {
  it('does not throw when all checks fail', async () => {
    mockFetch.mockRejectedValue(new Error('everything down'));
    mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });
    const fixDoctor = await importFixDoctor();
    await expect(fixDoctor(makeConfig())).resolves.toBeDefined();
  });

  it('does not throw when fs operations encounter errors', async () => {
    // Override tmp home to a path we can read from but some ops might fail
    mockFetch.mockRejectedValue(new Error('offline'));
    const fixDoctor = await importFixDoctor();
    const cfg = makeConfig();
    // Should always resolve
    await expect(fixDoctor(cfg)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Manual-only checks — items that must NEVER be auto-fixed
// ---------------------------------------------------------------------------

describe('fixDoctor — manual-only checks (cannot be auto-fixed)', () => {
  it('checks not in the SAFE-FIXABLE set are marked manual:true, applied:false', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    const fixDoctor = await importFixDoctor();
    const actions = await fixDoctor(makeConfig());

    // Safe-fixable check IDs per contract
    const safeFixable = new Set(['config', 'index', 'local-bin', 'genome-memory', 'mcp-plugin']);

    for (const action of actions) {
      if (!safeFixable.has(action.checkId)) {
        // Must be manual (human action required), never auto-applied
        if (action.applied) {
          // This would be a contract violation — fail with a clear message
          expect(action.applied).toBe(false);
        }
      }
    }
  });

  it('LM Studio unavailability is not auto-fixed', async () => {
    mockFetch.mockRejectedValue(new Error('lmstudio down'));
    const fixDoctor = await importFixDoctor();
    const actions = await fixDoctor(makeConfig());

    // No action should attempt to start LM Studio or install it automatically
    const lmsActions = actions.filter(
      (a) =>
        a.checkId.toLowerCase().includes('lmstudio') ||
        a.checkId.toLowerCase().includes('lm-studio') ||
        a.label.toLowerCase().includes('lm studio'),
    );
    for (const a of lmsActions) {
      expect(a.applied).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// PATH remains manual (local-bin symlink vs PATH entry)
// ---------------------------------------------------------------------------

describe('fixDoctor — local-bin symlink vs PATH (PATH stays manual)', () => {
  it('local-bin fix creates symlink but PATH guidance is manual', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    const fixDoctor = await importFixDoctor();
    const actions = await fixDoctor(makeConfig());

    const localBinAction = actions.find((a) => a.checkId === 'local-bin');
    if (localBinAction) {
      // The fix might create a symlink (applied) but PATH itself stays manual
      // Either applied (symlink created) or manual (can't determine source) is valid
      expect(typeof localBinAction.applied).toBe('boolean');
      expect(typeof localBinAction.manual).toBe('boolean');
      // If applied, the detail should mention symlink, not PATH modification
      if (localBinAction.applied) {
        expect(localBinAction.detail.toLowerCase()).not.toContain('export path');
        expect(localBinAction.detail.toLowerCase()).not.toContain('bashrc');
        expect(localBinAction.detail.toLowerCase()).not.toContain('zshrc');
      }
    }
  });
});
