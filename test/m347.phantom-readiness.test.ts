/**
 * M347 — values-free Phantom capability snapshot in readiness/preflight.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig, PhantomStatus } from '../src/core/types.js';
import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';

async function withReadinessMocks<T>(
  status: PhantomStatus,
  servers: Array<{ name: string; command: string; args: string[]; source: string }> = [],
  fn: (buildReadiness: (cfg: AshlrConfig) => Promise<unknown>, fx: H1Fixture) => Promise<T>,
): Promise<T> {
  const fx = makeFixture();
  const resolvedServers = servers.map((server) => ({
    ...server,
    source: server.source.replace('$HOME', fx.home),
  }));
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
    getPhantomStatus: () => status,
  }));
  vi.doMock('../src/core/mcp-registry.js', () => ({
    discoverMcpServers: () => ({ servers: resolvedServers }),
  }));

  try {
    const mod = await import('../src/core/readiness.js');
    return await fn(mod.buildReadiness, fx);
  } finally {
    fx.cleanup();
    vi.doUnmock('../src/core/providers.js');
    vi.doUnmock('../src/core/phantom.js');
    vi.doUnmock('../src/core/mcp-registry.js');
    vi.resetModules();
  }
}

function phantomStatus(overrides: Partial<PhantomStatus> = {}): PhantomStatus {
  const secretNames = overrides.secretNames ?? ['ANTHROPIC_API_KEY', 'ASHLR_PULSE_PAT'];
  const known = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'ASHLR_PULSE_PAT', 'ASHLR_PULSE_TOKEN', 'NVIDIA_NIM_API_KEY'];
  const present = secretNames.filter((name) => known.includes(name));
  return {
    installed: true,
    version: '0.6.0',
    initialized: true,
    secretNames,
    capability: {
      valueMode: 'metadata-and-names-only',
      secretCount: secretNames.length,
      knownFleetSecrets: {
        names: known,
        present,
        missing: known.filter((name) => !secretNames.includes(name)),
        pulsePatPresent: secretNames.includes('ASHLR_PULSE_PAT'),
        pulseTokenPresent: secretNames.includes('ASHLR_PULSE_TOKEN'),
        pulseCredentialPresent: secretNames.includes('ASHLR_PULSE_PAT') || secretNames.includes('ASHLR_PULSE_TOKEN'),
      },
      modes: {
        metadataStatus: true,
        childEnvInjectionAvailable: overrides.initialized ?? true,
        mcpServerAvailable: overrides.installed ?? true,
        mutationRequiresHumanApproval: overrides.installed ?? true,
      },
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('M347 readiness Phantom capability snapshot', () => {
  it('adds a values-free Phantom snapshot with secret counts and MCP registration', async () => {
    const report = await withReadinessMocks(
      phantomStatus(),
      [{ name: 'phantom-secrets', command: 'phantom', args: ['mcp'], source: '$HOME/.ashlr/settings.json' }],
      async (buildReadiness) => buildReadiness(makeCfg({})),
    ) as {
      phantom?: {
        installed: boolean;
        initialized: boolean;
        secretCount: number;
        valueMode: string;
        knownFleetSecrets: {
          presentCount: number;
          missingCount: number;
          pulsePatPresent: boolean;
          pulseTokenPresent: boolean;
          pulseCredentialPresent: boolean;
        };
        mcp: { configured: boolean; source: string | null };
      };
      info: Array<{ id: string; detail: string }>;
    };

    expect(report.phantom).toMatchObject({
      installed: true,
      initialized: true,
      secretCount: 2,
      valueMode: 'metadata-and-names-only',
      knownFleetSecrets: {
        presentCount: 2,
        missingCount: 4,
        pulsePatPresent: true,
        pulseTokenPresent: false,
        pulseCredentialPresent: true,
      },
      mcp: {
        configured: true,
        source: '~/.ashlr/settings.json',
      },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('sk-');
    expect(serialized).not.toContain('secretvalue');
    expect(serialized).not.toContain('ANTHROPIC_API_KEY');
    expect(serialized).not.toContain('ASHLR_PULSE_PAT');
    expect(serialized).not.toContain('OPENAI_API_KEY');
    expect(report.phantom).not.toHaveProperty('secretNames');
    expect(report.phantom?.knownFleetSecrets).not.toHaveProperty('names');
    expect(report.phantom?.knownFleetSecrets).not.toHaveProperty('present');
    expect(report.phantom?.knownFleetSecrets).not.toHaveProperty('missing');
    expect(report.info.find((finding) => finding.id === 'phantom')?.detail).toContain('values hidden');
  });

  it('warns when Phantom is installed but not initialized without exposing names or values', async () => {
    const status = phantomStatus({
      initialized: false,
      secretNames: [],
      capability: {
        ...phantomStatus({ secretNames: [] }).capability,
        secretCount: 0,
        modes: {
          metadataStatus: true,
          childEnvInjectionAvailable: false,
          mcpServerAvailable: true,
          mutationRequiresHumanApproval: true,
        },
      },
    });

    const report = await withReadinessMocks(status, [], async (buildReadiness) =>
      buildReadiness(makeCfg({})),
    ) as {
      phantom?: { initialized: boolean; secretCount: number; mcp: { configured: boolean } };
      warnings: Array<{ id: string; detail: string }>;
    };

    expect(report.phantom).toMatchObject({
      initialized: false,
      secretCount: 0,
      mcp: { configured: false },
    });
    expect(report.warnings.find((finding) => finding.id === 'phantom')?.detail)
      .toContain('installed but not initialized');
  });
});
