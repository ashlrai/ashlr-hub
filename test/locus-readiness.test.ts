/**
 * Values-free Locus identity-plane snapshot in readiness/preflight.
 * Mirrors m347.phantom-readiness.test.ts for the locus facet.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import type { LocusAgentReport, LocusProbeResult } from '../src/core/integrations/locus.js';
import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';

interface LocusMocks {
  available: boolean;
  probe: LocusProbeResult;
  oneline: string;
  enforce: 'off' | 'warn' | 'enforce';
}

async function withReadinessMocks<T>(
  locus: LocusMocks,
  fn: (buildReadiness: (cfg: AshlrConfig) => Promise<unknown>, fx: H1Fixture) => Promise<T>,
): Promise<T> {
  const fx = makeFixture();
  vi.resetModules();
  vi.doMock('../src/core/providers.js', () => ({
    probeEndpoint: async (id: string, url: string) => ({
      id,
      url,
      up: true,
      models: ['mock-model'],
    }),
  }));
  vi.doMock('../src/core/phantom.js', () => ({
    getPhantomStatus: () => ({
      installed: false,
      version: null,
      initialized: false,
      secretNames: [],
      capability: {
        valueMode: 'metadata-and-names-only',
        secretCount: 0,
        knownFleetSecrets: {
          names: [],
          present: [],
          missing: [],
          pulsePatPresent: false,
          pulseTokenPresent: false,
          pulseCredentialPresent: false,
        },
        modes: {
          metadataStatus: false,
          childEnvInjectionAvailable: false,
          mcpServerAvailable: false,
          mutationRequiresHumanApproval: false,
        },
        commands: {
          commandsKnown: false,
          setupAvailable: false,
          execAvailable: false,
          mcpAvailable: false,
          agentAvailable: false,
        },
      },
    }),
  }));
  vi.doMock('../src/core/mcp-registry.js', () => ({
    discoverMcpServers: () => ({ servers: [] }),
  }));
  vi.doMock('../src/core/integrations/locus.js', () => ({
    locusAvailable: () => locus.available,
    locusAgentReport: () => locus.probe,
    locusStatusOneline: () => locus.oneline,
    resolveLocusEnforceMode: () => locus.enforce,
  }));

  try {
    const mod = await import('../src/core/readiness.js');
    return await fn(mod.buildReadiness, fx);
  } finally {
    fx.cleanup();
    vi.doUnmock('../src/core/providers.js');
    vi.doUnmock('../src/core/phantom.js');
    vi.doUnmock('../src/core/mcp-registry.js');
    vi.doUnmock('../src/core/integrations/locus.js');
    vi.resetModules();
  }
}

function sampleReport(overrides: Partial<LocusAgentReport> = {}): LocusAgentReport {
  return {
    version: '1',
    ready: true,
    status: 'ready',
    status_oneline: 'personal:personal',
    home: '/tmp/locus-test-home',
    pin: {
      pinned: true,
      alias: 'personal',
      tenant: 'personal',
      seal_ok: true,
      expired: false,
      frozen: false,
    },
    mcp_registered: { claude: true, cursor: false, codex: false },
    doctor: {},
    commands: {},
    required_servers: ['locus', 'phantom'],
    mcp_command: 'locus-mcp',
    ...overrides,
  };
}

function readyProbe(report: LocusAgentReport = sampleReport()): LocusProbeResult {
  return {
    available: true,
    report,
    exitCode: 0,
    gateOk: true,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readiness Locus identity-plane snapshot', () => {
  it('adds a values-free Locus snapshot with status/pin/ready and no secret material', async () => {
    const report = await withReadinessMocks(
      {
        available: true,
        probe: readyProbe(),
        oneline: 'personal:personal',
        enforce: 'off',
      },
      async (buildReadiness) => buildReadiness(makeCfg({})),
    ) as {
      locus?: {
        available: boolean;
        status: string | null;
        statusOneline: string | null;
        ready: boolean | null;
        gateOk: boolean;
        pin: { sealOk: boolean | null; expired: boolean | null; frozen: boolean | null } | null;
        mcpRegistered: { claude: boolean; cursor: boolean; codex: boolean } | null;
      };
      info: Array<{ id: string; detail: string }>;
      ready: boolean;
    };

    expect(report.locus).toMatchObject({
      available: true,
      status: 'ready',
      statusOneline: 'personal:personal',
      ready: true,
      gateOk: true,
      pin: { sealOk: true, expired: false, frozen: false },
      mcpRegistered: { claude: true, cursor: false, codex: false },
    });
    // Values-free: no home path dump, no credential refs, no raw secret names from env.
    expect(report.locus).not.toHaveProperty('home');
    expect(JSON.stringify(report)).not.toContain('phm:');
    expect(JSON.stringify(report)).not.toContain('sk-');
    expect(JSON.stringify(report)).not.toContain('/tmp/locus-test-home');
    const detail = report.info.find((f) => f.id === 'locus')?.detail;
    expect(detail).toContain('locus ready');
    expect(detail).toContain('pin=personal:personal');
    expect(detail).toContain('values free');
    expect(report.ready).toBe(true);
  });

  it('warns when Locus CLI is missing (optional, like phantom)', async () => {
    const report = await withReadinessMocks(
      {
        available: false,
        probe: {
          available: false,
          report: null,
          exitCode: 2,
          error: 'locus CLI not found on PATH',
          gateOk: false,
        },
        oneline: 'unpinned',
        enforce: 'off',
      },
      async (buildReadiness) => buildReadiness(makeCfg({})),
    ) as {
      locus?: { available: boolean; gateOk: boolean };
      warnings: Array<{ id: string; severity: string; detail: string }>;
      blockers: Array<{ id: string }>;
      ready: boolean;
    };

    expect(report.locus).toMatchObject({ available: false, gateOk: false });
    const warning = report.warnings.find((f) => f.id === 'locus');
    expect(warning?.detail).toContain('locus not installed');
    expect(report.blockers.find((f) => f.id === 'locus')).toBeUndefined();
    expect(report.ready).toBe(true);
  });

  it('escalates missing Locus to a blocker only when LOCUS_ENFORCE=enforce', async () => {
    const report = await withReadinessMocks(
      {
        available: false,
        probe: {
          available: false,
          report: null,
          exitCode: 2,
          error: 'locus CLI not found on PATH',
          gateOk: false,
        },
        oneline: 'unpinned',
        enforce: 'enforce',
      },
      async (buildReadiness) => buildReadiness(makeCfg({})),
    ) as {
      blockers: Array<{ id: string; severity: string; detail: string }>;
      warnings: Array<{ id: string }>;
      ready: boolean;
    };

    const blocker = report.blockers.find((f) => f.id === 'locus');
    expect(blocker?.severity).toBe('blocker');
    expect(blocker?.detail).toContain('locus not installed');
    expect(report.warnings.find((f) => f.id === 'locus')).toBeUndefined();
    expect(report.ready).toBe(false);
  });

  it('warns on unpinned/protected status without exposing secret values', async () => {
    const unhealthy = sampleReport({
      ready: false,
      status: 'protected',
      status_oneline: 'unpinned',
      pin: { pinned: false, seal_ok: false, expired: false, frozen: false },
    });
    const report = await withReadinessMocks(
      {
        available: true,
        probe: {
          available: true,
          report: unhealthy,
          exitCode: 1,
          gateOk: false,
        },
        oneline: 'unpinned',
        enforce: 'off',
      },
      async (buildReadiness) => buildReadiness(makeCfg({})),
    ) as {
      locus?: { status: string | null; statusOneline: string | null; gateOk: boolean };
      warnings: Array<{ id: string; detail: string; fix?: string }>;
      ready: boolean;
    };

    expect(report.locus).toMatchObject({
      status: 'protected',
      statusOneline: 'unpinned',
      gateOk: false,
    });
    const warning = report.warnings.find((f) => f.id === 'locus');
    expect(warning?.detail).toContain('status=protected');
    expect(warning?.detail).toContain('pin=unpinned');
    expect(warning?.fix).toContain('locus enter');
    expect(report.ready).toBe(true);
    expect(JSON.stringify(report)).not.toContain('phm:');
  });

  it('falls back to status --oneline when agent report is empty', async () => {
    const report = await withReadinessMocks(
      {
        available: true,
        probe: {
          available: true,
          report: null,
          exitCode: 2,
          error: 'empty agent report',
          gateOk: false,
        },
        oneline: 'require_pin',
        enforce: 'off',
      },
      async (buildReadiness) => buildReadiness(makeCfg({})),
    ) as {
      locus?: { statusOneline: string | null; error?: string; gateOk: boolean };
      warnings: Array<{ id: string; detail: string }>;
    };

    expect(report.locus?.statusOneline).toBe('require_pin');
    expect(report.locus?.error).toBe('empty agent report');
    expect(report.locus?.gateOk).toBe(false);
    const warning = report.warnings.find((f) => f.id === 'locus');
    expect(warning?.detail).toContain('report failed');
  });
});
