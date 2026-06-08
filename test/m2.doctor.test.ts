/**
 * Tests for src/core/doctor.ts (M2)
 *
 * Stubs providers.ts and phantom.ts so no real network or binary calls happen.
 * Asserts summary counts and specific failure conditions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AshlrConfig, ProviderRegistry, PhantomStatus } from '../src/core/types.js';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Mock phantom.ts and providers.ts BEFORE importing doctor.
// ---------------------------------------------------------------------------

let _phantomStatus: PhantomStatus = {
  installed: true,
  version: '0.6.0',
  initialized: true,
  secretNames: ['ANTHROPIC_API_KEY'],
};

let _providerRegistry: ProviderRegistry = {
  providers: [
    { id: 'lmstudio', url: 'http://localhost:1234/v1/models', up: true, models: ['model-a'] },
    { id: 'ollama',   url: 'http://localhost:11434/api/tags', up: true, models: ['llama3'] },
  ],
  activeProvider: 'lmstudio',
  chain: ['lmstudio', 'ollama'],
};

vi.mock('../src/core/phantom.js', () => ({
  phantomInstalled: () => _phantomStatus.installed,
  getPhantomStatus: () => _phantomStatus,
}));

vi.mock('../src/core/providers.js', () => ({
  probeEndpoint: vi.fn(),
  getProviderRegistry: async (_cfg: AshlrConfig) => _providerRegistry,
  resolveActiveProvider: async (_cfg: AshlrConfig) => _providerRegistry.activeProvider,
}));

// Import doctor AFTER mocks are registered.
import { runDoctor } from '../src/core/doctor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpHome: string;
const origHome = process.env.HOME;

function makeTmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'ashlr-doctor-test-'));
}

function makeConfig(tmpH: string): AshlrConfig {
  const ashlrDir = join(tmpH, '.ashlr');
  mkdirSync(ashlrDir, { recursive: true });
  writeFileSync(
    join(ashlrDir, 'config.json'),
    JSON.stringify({
      version: 1,
      roots: [join(tmpH, 'Desktop')],
      editor: 'cursor',
      staleDays: 30,
      categories: {},
      tidyRules: [],
      keepers: [],
      models: {
        lmstudio: 'http://localhost:1234',
        ollama: 'http://localhost:11434',
        providerChain: ['lmstudio', 'ollama'],
      },
      telemetry: {},
      tools: {},
    }, null, 2),
  );
  return {
    version: 1,
    roots: [join(tmpH, 'Desktop')],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['lmstudio', 'ollama'],
    },
    telemetry: {},
    tools: {},
  };
}

beforeEach(() => {
  tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;

  // Reset to healthy defaults before each test.
  _phantomStatus = {
    installed: true,
    version: '0.6.0',
    initialized: true,
    secretNames: ['ANTHROPIC_API_KEY'],
  };

  _providerRegistry = {
    providers: [
      { id: 'lmstudio', url: 'http://localhost:1234/v1/models', up: true, models: ['model-a'] },
      { id: 'ollama',   url: 'http://localhost:11434/api/tags', up: true, models: ['llama3'] },
    ],
    activeProvider: 'lmstudio',
    chain: ['lmstudio', 'ollama'],
  };
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
});

// ---------------------------------------------------------------------------
// DoctorReport structure
// ---------------------------------------------------------------------------

describe('runDoctor — report structure', () => {
  it('returns a DoctorReport with a generatedAt ISO timestamp', async () => {
    const cfg = makeConfig(tmpHome);
    const report = await runDoctor(cfg);
    expect(() => new Date(report.generatedAt)).not.toThrow();
    expect(new Date(report.generatedAt).toISOString()).toBe(report.generatedAt);
  });

  it('returns a checks array with at least one check', async () => {
    const cfg = makeConfig(tmpHome);
    const report = await runDoctor(cfg);
    expect(Array.isArray(report.checks)).toBe(true);
    expect(report.checks.length).toBeGreaterThan(0);
  });

  it('every check has id, label, status, detail fields', async () => {
    const cfg = makeConfig(tmpHome);
    const report = await runDoctor(cfg);
    for (const check of report.checks) {
      expect(typeof check.id).toBe('string');
      expect(check.id.length).toBeGreaterThan(0);
      expect(typeof check.label).toBe('string');
      expect(['pass', 'warn', 'fail']).toContain(check.status);
      expect(typeof check.detail).toBe('string');
    }
  });

  it('summary counts match actual check statuses', async () => {
    const cfg = makeConfig(tmpHome);
    const report = await runDoctor(cfg);
    const pass = report.checks.filter(c => c.status === 'pass').length;
    const warn = report.checks.filter(c => c.status === 'warn').length;
    const fail = report.checks.filter(c => c.status === 'fail').length;
    expect(report.summary.pass).toBe(pass);
    expect(report.summary.warn).toBe(warn);
    expect(report.summary.fail).toBe(fail);
  });

  it('summary.pass + summary.warn + summary.fail equals checks.length', async () => {
    const cfg = makeConfig(tmpHome);
    const report = await runDoctor(cfg);
    const total = report.summary.pass + report.summary.warn + report.summary.fail;
    expect(total).toBe(report.checks.length);
  });
});

// ---------------------------------------------------------------------------
// Healthy scenario — all green
// ---------------------------------------------------------------------------

describe('runDoctor — all healthy', () => {
  it('has zero fail checks when everything is up', async () => {
    const cfg = makeConfig(tmpHome);
    const report = await runDoctor(cfg);
    expect(report.summary.fail).toBe(0);
  });

  it('has at least one pass check when everything is up', async () => {
    const cfg = makeConfig(tmpHome);
    const report = await runDoctor(cfg);
    expect(report.summary.pass).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// No local provider up → expect a 'fail' check
// ---------------------------------------------------------------------------

describe('runDoctor — no local provider up', () => {
  beforeEach(() => {
    _providerRegistry = {
      providers: [
        { id: 'lmstudio', url: 'http://localhost:1234/v1/models', up: false, models: [], error: 'ECONNREFUSED' },
        { id: 'ollama',   url: 'http://localhost:11434/api/tags', up: false, models: [], error: 'ECONNREFUSED' },
      ],
      activeProvider: null,
      chain: ['lmstudio', 'ollama'],
    };
  });

  it('produces at least one fail check when no provider is up', async () => {
    const cfg = makeConfig(tmpHome);
    const report = await runDoctor(cfg);
    expect(report.summary.fail).toBeGreaterThan(0);
  });

  it('summary.fail is reflected correctly in summary counts', async () => {
    const cfg = makeConfig(tmpHome);
    const report = await runDoctor(cfg);
    const failChecks = report.checks.filter(c => c.status === 'fail');
    expect(report.summary.fail).toBe(failChecks.length);
    expect(failChecks.length).toBeGreaterThan(0);
  });

  it('a provider-related check has id containing "provider"', async () => {
    const cfg = makeConfig(tmpHome);
    const report = await runDoctor(cfg);
    const providerFails = report.checks.filter(
      c => c.status === 'fail' && c.id.includes('provider'),
    );
    expect(providerFails.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Phantom not installed → warn or fail
// ---------------------------------------------------------------------------

describe('runDoctor — phantom not installed', () => {
  beforeEach(() => {
    _phantomStatus = {
      installed: false,
      version: null,
      initialized: false,
      secretNames: [],
    };
  });

  it('produces a warn or fail check for phantom when not installed', async () => {
    const cfg = makeConfig(tmpHome);
    const report = await runDoctor(cfg);
    const phantomChecks = report.checks.filter(c => c.id.includes('phantom'));
    expect(phantomChecks.length).toBeGreaterThan(0);
    const hasProblem = phantomChecks.some(c => c.status === 'warn' || c.status === 'fail');
    expect(hasProblem).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phantom not initialized → warn
// ---------------------------------------------------------------------------

describe('runDoctor — phantom installed but not initialized', () => {
  beforeEach(() => {
    _phantomStatus = {
      installed: true,
      version: '0.6.0',
      initialized: false,
      secretNames: [],
    };
  });

  it('produces a warn or fail for phantom when not initialized', async () => {
    const cfg = makeConfig(tmpHome);
    const report = await runDoctor(cfg);
    const phantomChecks = report.checks.filter(c => c.id.includes('phantom'));
    expect(phantomChecks.length).toBeGreaterThan(0);
    const hasProblem = phantomChecks.some(c => c.status === 'warn' || c.status === 'fail');
    expect(hasProblem).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Config check — present and readable
// ---------------------------------------------------------------------------

describe('runDoctor — config check', () => {
  it('includes a config check', async () => {
    const cfg = makeConfig(tmpHome);
    const report = await runDoctor(cfg);
    const configCheck = report.checks.find(c => c.id === 'config');
    expect(configCheck).toBeDefined();
  });

  it('config check passes when config file exists', async () => {
    const cfg = makeConfig(tmpHome);
    const report = await runDoctor(cfg);
    const configCheck = report.checks.find(c => c.id === 'config');
    expect(configCheck?.status).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// Fix field — structured remediation hints
// ---------------------------------------------------------------------------

describe('runDoctor — fix hints', () => {
  beforeEach(() => {
    _phantomStatus = {
      installed: false,
      version: null,
      initialized: false,
      secretNames: [],
    };
  });

  it('provides a fix hint for phantom not installed', async () => {
    const cfg = makeConfig(tmpHome);
    const report = await runDoctor(cfg);
    const failing = report.checks.filter(
      c => c.id.includes('phantom') && (c.status === 'fail' || c.status === 'warn'),
    );
    // At least one problematic phantom check should have a fix suggestion.
    const hasFix = failing.some(c => typeof c.fix === 'string' && c.fix.length > 0);
    expect(hasFix).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runDoctor never throws — even with degenerate config
// ---------------------------------------------------------------------------

describe('runDoctor — never throws', () => {
  it('completes without throwing when providers are down and phantom is absent', async () => {
    _phantomStatus = {
      installed: false,
      version: null,
      initialized: false,
      secretNames: [],
      error: 'not found',
    };
    _providerRegistry = {
      providers: [],
      activeProvider: null,
      chain: [],
    };

    const cfg = makeConfig(tmpHome);
    await expect(runDoctor(cfg)).resolves.toBeDefined();
  });
});
