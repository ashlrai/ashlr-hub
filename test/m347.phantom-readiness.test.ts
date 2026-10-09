/**
 * M347 — values-free Phantom capability snapshot in readiness/preflight.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig, PhantomStatus } from '../src/core/types.js';
import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';

async function withReadinessMocks<T>(
  status: PhantomStatus | Error,
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
    getPhantomStatus: () => {
      if (status instanceof Error) throw status;
      return status;
    },
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
        childEnvInjectionAvailable: false,
        mcpServerAvailable: overrides.installed ?? true,
        mutationRequiresHumanApproval: overrides.installed ?? true,
      },
      commands: {
        commandsKnown: overrides.installed ?? true,
        setupAvailable: overrides.installed ?? true,
        execAvailable: overrides.installed ?? true,
        mcpAvailable: overrides.installed ?? true,
        agentAvailable: false,
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
        commands: {
          commandsKnown: boolean;
          setupAvailable: boolean;
          execAvailable: boolean;
          mcpAvailable: boolean;
          agentAvailable: boolean;
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
      commands: {
        commandsKnown: true,
        setupAvailable: true,
        execAvailable: true,
        mcpAvailable: true,
        agentAvailable: false,
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
    const detail = report.info.find((finding) => finding.id === 'phantom')?.detail;
    expect(detail).toContain('agent command absent');
    expect(detail).toContain('values hidden');
    expect(detail).toContain('project configured; vault readiness unverified');
  });

  it('surfaces agent command presence without exposing help text', async () => {
    const base = phantomStatus();
    const report = await withReadinessMocks(
      {
        ...base,
        capability: {
          ...base.capability,
          commands: {
            ...base.capability.commands,
            agentAvailable: true,
          },
        },
      },
      [],
      async (buildReadiness) => buildReadiness(makeCfg({})),
    ) as {
      phantom?: { commands: { agentAvailable: boolean } };
      info: Array<{ id: string; detail: string }>;
    };

    expect(report.phantom?.commands.agentAvailable).toBe(true);
    const detail = report.info.find((finding) => finding.id === 'phantom')?.detail;
    expect(detail).toContain('agent command present');
    expect(JSON.stringify(report)).not.toContain('command help text');
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
      commands: {
        commandsKnown: true,
        agentAvailable: false,
      },
      mcp: { configured: false },
    });
    const detail = report.warnings.find((finding) => finding.id === 'phantom')?.detail;
    expect(detail).toContain('installed but project not configured');
    expect(detail).toContain('agent command absent');
  });

  it.each(['status-contract-unsupported', 'status-unavailable', 'status-config-unavailable'])(
    'warns about unverified metadata for %s without suggesting initialization', async (error) => {
      const report = await withReadinessMocks(
        phantomStatus({ initialized: false, secretNames: [], error }),
        [],
        async (buildReadiness) => buildReadiness(makeCfg({})),
      ) as { warnings: Array<{ id: string; detail: string; fix?: string }>; info: Array<{ id: string }> };
      const finding = report.warnings.find((item) => item.id === 'phantom');
      expect(finding?.detail).toBe('Phantom Secrets project metadata status unverified');
      if (error === 'status-config-unavailable') {
        expect(finding?.fix).toBe('Inspect existing project configuration and file access.');
      } else {
        expect(finding?.fix).toContain('phantom-secrets/blob/main/docs/hub-status-contract.md');
      }
      expect(finding?.fix).not.toContain('phantom init');
      expect(report.info.some((item) => item.id === 'phantom')).toBe(false);
    },
  );

  it('uses fixed unverified guidance when the status observer throws', async () => {
    const report = await withReadinessMocks(
      new Error('SECRET_OBSERVATION_SENTINEL'),
      [],
      async (buildReadiness) => buildReadiness(makeCfg({})),
    ) as { warnings: Array<{ id: string; detail: string }> };
    expect(report.warnings.find((item) => item.id === 'phantom')?.detail)
      .toBe('Phantom Secrets project metadata status unverified');
    expect(JSON.stringify(report)).not.toContain('SECRET_OBSERVATION_SENTINEL');
  });

  it('keeps a values-free all-false command snapshot when Phantom is not installed', async () => {
    const status = phantomStatus({
      installed: false,
      version: null,
      initialized: false,
      secretNames: [],
      capability: phantomStatus({ installed: false, secretNames: [] }).capability,
    });

    const report = await withReadinessMocks(status, [], async (buildReadiness) =>
      buildReadiness(makeCfg({})),
    ) as {
      phantom?: { installed: boolean; commands: PhantomStatus['capability']['commands'] };
      warnings: Array<{ id: string; detail: string }>;
    };

    expect(report.phantom).toMatchObject({
      installed: false,
      commands: {
        commandsKnown: false,
        setupAvailable: false,
        execAvailable: false,
        mcpAvailable: false,
        agentAvailable: false,
      },
    });
    expect(report.warnings.find((finding) => finding.id === 'phantom')?.detail)
      .toContain('phantom not installed');
  });
});
