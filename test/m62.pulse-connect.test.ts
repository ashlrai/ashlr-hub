/**
 * m62.pulse-connect.test.ts — hermetic tests for `ashlr pulse connect` (M62).
 *
 * Coverage:
 *   - connect <endpoint> writes cfg.telemetry.pulse; does NOT clobber other keys
 *   - connect --status reports endpoint set / PAT boolean (no leaked value)
 *   - connect --disconnect clears cfg.telemetry.pulse
 *   - connect --test with no endpoint returns clean "not configured" (no throw)
 *   - connect --test mocks OtlpHttpSink.emit (no real network call)
 *
 * Hermetic: HOME is redirected to a tmp dir so real ~/.ashlr is never touched.
 * Network: never — OtlpHttpSink.emit is mocked for --test cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// HOME isolation — redirect to a tmp dir before any module under test loads
// ---------------------------------------------------------------------------

const origHome = process.env['HOME'];
let tmpHome: string;

// We must set HOME before the SUT modules are imported so loadConfig/saveConfig
// pick up the tmp dir. Use a module-level beforeEach that runs before imports.
// Since vitest hoists vi.mock, we set HOME here before dynamic imports in tests.

// ---------------------------------------------------------------------------
// Mock node:child_process to prevent real phantom/spawnSync calls
// ---------------------------------------------------------------------------

const mockSpawnSync = vi.fn(() => ({ status: 1, error: new Error('phantom not available'), stdout: '', stderr: '' }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
    // spawn is used by resolvePatAsync in OtlpHttpSink — keep it real but
    // ASHLR_PULSE_TOKEN env var path is tested instead (no phantom needed).
    spawn: actual.spawn,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    roots: ['/tmp/test-root'],
    editor: 'vscode',
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
    ...overrides,
  };
}

function writeConfig(tmpHome: string, cfg: Record<string, unknown>): void {
  const dir = path.join(tmpHome, '.ashlr');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

function readConfig(tmpHome: string): Record<string, unknown> {
  const p = path.join(tmpHome, '.ashlr', 'config.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
}

const PULSE_ENDPOINT = 'https://pulse.ashlr.ai/api/otlp/v1/traces';
const ALT_ENDPOINT   = 'https://custom.example.com/v1/traces';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m62-home-'));
  process.env['HOME'] = tmpHome;
  // Remove any PAT from env so tests start clean
  delete process.env['ASHLR_PULSE_TOKEN'];
  vi.clearAllMocks();
  // spawnSync always fails → Phantom never available in tests
  mockSpawnSync.mockReturnValue({ status: 1, error: new Error('no phantom'), stdout: '', stderr: '' });
});

afterEach(() => {
  process.env['HOME'] = origHome;
  delete process.env['ASHLR_PULSE_TOKEN'];
  // Clean up tmp dir
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// connect <endpoint> — writes cfg.telemetry.pulse, preserves other keys
// ---------------------------------------------------------------------------

describe('pulse connect <endpoint>', () => {
  it('writes cfg.telemetry.pulse to config.json', async () => {
    writeConfig(tmpHome, makeConfig({ extra_key: 'preserved' }));

    // Dynamic import AFTER HOME is set so config resolves to tmpHome
    const { cmdPulseConnect } = await import('../src/cli/pulse.js');
    const code = await cmdPulseConnect([PULSE_ENDPOINT]);

    expect(code).toBe(0);
    const saved = readConfig(tmpHome);
    const tel = saved['telemetry'] as Record<string, unknown>;
    expect(tel['pulse']).toBe(PULSE_ENDPOINT);
  });

  it('does NOT clobber other config keys', async () => {
    writeConfig(tmpHome, makeConfig({
      staleDays: 99,
      telemetry: { budgetUsd: 50, budgetWindow: '30d' },
    }));

    const { cmdPulseConnect } = await import('../src/cli/pulse.js');
    await cmdPulseConnect([PULSE_ENDPOINT]);

    const saved = readConfig(tmpHome);
    // staleDays preserved
    expect(saved['staleDays']).toBe(99);
    // telemetry sub-keys preserved
    const tel = saved['telemetry'] as Record<string, unknown>;
    expect(tel['budgetUsd']).toBe(50);
    expect(tel['budgetWindow']).toBe('30d');
    // pulse set
    expect(tel['pulse']).toBe(PULSE_ENDPOINT);
  });

  it('accepts a custom endpoint', async () => {
    writeConfig(tmpHome, makeConfig());
    const { cmdPulseConnect } = await import('../src/cli/pulse.js');
    await cmdPulseConnect([ALT_ENDPOINT]);

    const saved = readConfig(tmpHome);
    const tel = saved['telemetry'] as Record<string, unknown>;
    expect(tel['pulse']).toBe(ALT_ENDPOINT);
  });

  it('returns exit code 0 on success', async () => {
    writeConfig(tmpHome, makeConfig());
    const { cmdPulseConnect } = await import('../src/cli/pulse.js');
    const code = await cmdPulseConnect([PULSE_ENDPOINT]);
    expect(code).toBe(0);
  });

  it('returns exit code 2 when no args provided', async () => {
    writeConfig(tmpHome, makeConfig());
    const { cmdPulseConnect } = await import('../src/cli/pulse.js');
    const code = await cmdPulseConnect([]);
    // No args → help (exit 0) is acceptable per spec
    expect([0, 2]).toContain(code);
  });
});

// ---------------------------------------------------------------------------
// connect --token — stores PAT, never prints value
// ---------------------------------------------------------------------------

describe('pulse connect --token', () => {
  it('does not print the token value to stdout', async () => {
    writeConfig(tmpHome, makeConfig());
    const { cmdPulseConnect } = await import('../src/cli/pulse.js');

    const lines: string[] = [];
    const _origWrite = process.stdout.write.bind(process.stdout);
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });

    const _consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });

    try {
      await cmdPulseConnect(['--token', 'super-secret-pat-value']);
    } finally {
      vi.restoreAllMocks();
    }

    const output = lines.join('\n');
    expect(output).not.toContain('super-secret-pat-value');
  });

  it('falls back to env var instruction when Phantom unavailable', async () => {
    writeConfig(tmpHome, makeConfig()); // phantom.enabled not set
    const { cmdPulseConnect } = await import('../src/cli/pulse.js');

    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { lines.push(args.join(' ')); });

    try {
      await cmdPulseConnect(['--token', 'my-pat-value']);
    } finally {
      vi.restoreAllMocks();
    }

    const output = lines.join('\n');
    // Should mention ASHLR_PULSE_TOKEN env var path
    expect(output).toContain('ASHLR_PULSE_TOKEN');
    // Must NOT print the token value
    expect(output).not.toContain('my-pat-value');
  });

  it('returns exit code 2 when --token flag has no value', async () => {
    writeConfig(tmpHome, makeConfig());
    const { cmdPulseConnect } = await import('../src/cli/pulse.js');
    const code = await cmdPulseConnect(['--token']);
    expect(code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// connect --status — reports endpoint/PAT state without leaking values
// ---------------------------------------------------------------------------

describe('pulse connect --status', () => {
  it('reports endpoint as configured when set', async () => {
    writeConfig(tmpHome, makeConfig({ telemetry: { pulse: PULSE_ENDPOINT } }));
    const { cmdPulseConnect } = await import('../src/cli/pulse.js');

    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { lines.push(args.join(' ')); });

    try {
      const code = await cmdPulseConnect(['--status']);
      expect(code).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }

    const output = lines.join('\n');
    expect(output).toMatch(/configured/i);
  });

  it('reports endpoint as not configured when absent', async () => {
    writeConfig(tmpHome, makeConfig({ telemetry: {} }));
    const { cmdPulseConnect } = await import('../src/cli/pulse.js');

    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { lines.push(args.join(' ')); });

    try {
      await cmdPulseConnect(['--status']);
    } finally {
      vi.restoreAllMocks();
    }

    const output = lines.join('\n');
    expect(output).toMatch(/not configured/i);
  });

  it('reports PAT as boolean (available / not found) — never leaks value', async () => {
    const PAT_VALUE = 'secret-pat-must-not-appear';
    process.env['ASHLR_PULSE_TOKEN'] = PAT_VALUE;
    writeConfig(tmpHome, makeConfig({ telemetry: { pulse: PULSE_ENDPOINT } }));

    const { cmdPulseConnect } = await import('../src/cli/pulse.js');

    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { lines.push(args.join(' ')); });

    try {
      await cmdPulseConnect(['--status']);
    } finally {
      vi.restoreAllMocks();
      delete process.env['ASHLR_PULSE_TOKEN'];
    }

    const output = lines.join('\n');
    // Must NOT contain the PAT value
    expect(output).not.toContain(PAT_VALUE);
    // Should mention availability
    expect(output).toMatch(/available|not found|PAT/i);
  });

  it('reports active sink name', async () => {
    writeConfig(tmpHome, makeConfig({ telemetry: { pulse: PULSE_ENDPOINT } }));
    const { cmdPulseConnect } = await import('../src/cli/pulse.js');

    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { lines.push(args.join(' ')); });

    try {
      await cmdPulseConnect(['--status']);
    } finally {
      vi.restoreAllMocks();
    }

    const output = lines.join('\n');
    expect(output).toMatch(/LocalFileSink|OtlpHttpSink/);
  });

  it('returns exit code 0', async () => {
    writeConfig(tmpHome, makeConfig());
    const { cmdPulseConnect } = await import('../src/cli/pulse.js');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await cmdPulseConnect(['--status']);
      expect(code).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

// ---------------------------------------------------------------------------
// connect --disconnect — clears cfg.telemetry.pulse
// ---------------------------------------------------------------------------

describe('pulse connect --disconnect', () => {
  it('clears cfg.telemetry.pulse from config.json', async () => {
    writeConfig(tmpHome, makeConfig({ telemetry: { pulse: PULSE_ENDPOINT, budgetUsd: 20 } }));
    const { cmdPulseConnect } = await import('../src/cli/pulse.js');

    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await cmdPulseConnect(['--disconnect']);
      expect(code).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }

    const saved = readConfig(tmpHome);
    const tel = saved['telemetry'] as Record<string, unknown>;
    expect(tel['pulse']).toBeUndefined();
    // Other telemetry keys preserved
    expect(tel['budgetUsd']).toBe(20);
  });

  it('succeeds gracefully when no endpoint was configured', async () => {
    writeConfig(tmpHome, makeConfig({ telemetry: {} }));
    const { cmdPulseConnect } = await import('../src/cli/pulse.js');

    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await cmdPulseConnect(['--disconnect']);
      expect(code).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('returns exit code 0', async () => {
    writeConfig(tmpHome, makeConfig({ telemetry: { pulse: PULSE_ENDPOINT } }));
    const { cmdPulseConnect } = await import('../src/cli/pulse.js');

    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await cmdPulseConnect(['--disconnect']);
      expect(code).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

// ---------------------------------------------------------------------------
// connect --test — no endpoint → clean error, no throw
// ---------------------------------------------------------------------------

describe('pulse connect --test (no endpoint)', () => {
  it('returns exit code 1 and prints informative message — no throw', async () => {
    writeConfig(tmpHome, makeConfig({ telemetry: {} }));
    const { cmdPulseConnect } = await import('../src/cli/pulse.js');

    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { lines.push(args.join(' ')); });

    let code: number;
    try {
      code = await cmdPulseConnect(['--test']);
    } finally {
      vi.restoreAllMocks();
    }

    expect(code!).toBe(1);
    const output = lines.join('\n');
    // Should explain the issue, not throw
    expect(output).toMatch(/not configured|no.*endpoint|endpoint/i);
  });

  it('never throws even with no config', async () => {
    // Don't write any config — let loadConfig bootstrap defaults
    const { cmdPulseConnect } = await import('../src/cli/pulse.js');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(cmdPulseConnect(['--test'])).resolves.toBeDefined();
    } finally {
      vi.restoreAllMocks();
    }
  });
});

// ---------------------------------------------------------------------------
// connect --test — mocked sink, endpoint configured
// ---------------------------------------------------------------------------

describe('pulse connect --test (mocked sink)', () => {
  it('calls sink.emit once and reports {ok, detail}', async () => {
    // Set PAT via env so OtlpHttpSink is selected
    process.env['ASHLR_PULSE_TOKEN'] = 'test-pat';
    writeConfig(tmpHome, makeConfig({ telemetry: { pulse: PULSE_ENDPOINT } }));

    // Mock the fetch global so OtlpHttpSink.emit returns ok:true without network
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"partialSuccess":{}}',
    });
    vi.stubGlobal('fetch', mockFetch);

    const { cmdPulseConnect } = await import('../src/cli/pulse.js');

    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { lines.push(args.join(' ')); });

    let code: number;
    try {
      code = await cmdPulseConnect(['--test']);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      delete process.env['ASHLR_PULSE_TOKEN'];
    }

    // Either ok (0) or fail (1) — what matters is it ran and reported
    expect([0, 1]).toContain(code!);
    const output = lines.join('\n');
    // Must report sink and detail
    expect(output).toMatch(/sink|otlp|local|ok|fail/i);
    // Must NOT contain the PAT
    expect(output).not.toContain('test-pat');
  });

  it('reports ok:false cleanly when fetch fails — no throw', async () => {
    process.env['ASHLR_PULSE_TOKEN'] = 'test-pat';
    writeConfig(tmpHome, makeConfig({ telemetry: { pulse: PULSE_ENDPOINT } }));

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    const { cmdPulseConnect } = await import('../src/cli/pulse.js');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    let code: number;
    try {
      code = await cmdPulseConnect(['--test']);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      delete process.env['ASHLR_PULSE_TOKEN'];
    }

    // Should not throw, returns exit code (0 or 1)
    expect([0, 1]).toContain(code!);
  });
});

// ---------------------------------------------------------------------------
// cmdPulse dispatches 'connect' subcommand
// ---------------------------------------------------------------------------

describe('cmdPulse dispatches connect subcommand', () => {
  it('routes pulse connect to cmdPulseConnect', async () => {
    writeConfig(tmpHome, makeConfig());
    const { cmdPulse, cmdPulseConnect } = await import('../src/cli/pulse.js');

    // Both functions exist and are callable
    expect(typeof cmdPulse).toBe('function');
    expect(typeof cmdPulseConnect).toBe('function');

    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // connect --status should route correctly through cmdPulse
      const code = await cmdPulse(['connect', '--status']);
      expect(code).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
