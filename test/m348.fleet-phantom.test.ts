/**
 * M348 — FleetStatus exposes values-free Phantom capability.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AshlrConfig, PhantomStatus } from '../src/core/types.js';

function baseConfig(): AshlrConfig {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    telemetry: {},
    tools: {},
    phantom: { enabled: true },
    foundry: {
      allowedBackends: ['builtin'],
      usePhantom: true,
    },
  } as AshlrConfig;
}

function phantomStatus(overrides: Partial<PhantomStatus> = {}): PhantomStatus {
  const known = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GITHUB_TOKEN',
    'ASHLR_PULSE_PAT',
    'ASHLR_PULSE_TOKEN',
    'NVIDIA_NIM_API_KEY',
  ];
  const present = ['ANTHROPIC_API_KEY', 'ASHLR_PULSE_TOKEN'];
  return {
    installed: true,
    version: '0.6.0',
    initialized: true,
    secretNames: [...present, 'sk-should-never-surface'],
    capability: {
      valueMode: 'metadata-and-names-only',
      secretCount: present.length,
      knownFleetSecrets: {
        names: known,
        present,
        missing: known.filter((name) => !present.includes(name)),
        pulsePatPresent: false,
        pulseTokenPresent: true,
        pulseCredentialPresent: true,
      },
      modes: {
        metadataStatus: true,
        childEnvInjectionAvailable: true,
        mcpServerAvailable: true,
        mutationRequiresHumanApproval: true,
      },
      commands: {
        commandsKnown: true,
        setupAvailable: true,
        execAvailable: true,
        mcpAvailable: true,
        agentAvailable: false,
      },
    },
    ...overrides,
  };
}

async function withFleetMocks<T>(
  statusFactory: () => PhantomStatus,
  fn: (mods: {
    buildFleetStatus: typeof import('../src/core/fleet/status.js')['buildFleetStatus'];
    formatFleetStatus: typeof import('../src/cli/fleet.js')['formatFleetStatus'];
  }) => Promise<T>,
): Promise<T> {
  const tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m348-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevAshlrHome = process.env.ASHLR_HOME;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.ASHLR_HOME = join(tmpHome, '.ashlr');
  vi.resetModules();
  vi.doMock('../src/core/phantom.js', () => ({
    getCachedFleetPhantomStatus: () => statusFactory(),
  }));
  vi.doMock('../src/core/mcp-registry.js', () => ({
    discoverMcpServers: () => ({
      servers: [
        {
          name: 'phantom-secrets',
          command: 'phantom',
          args: ['mcp'],
          source: '/Users/masonwyatt/.ashlr/settings.json',
        },
      ],
    }),
  }));

  try {
    const [statusMod, cliMod] = await Promise.all([
      import('../src/core/fleet/status.js'),
      import('../src/cli/fleet.js'),
    ]);
    return await fn({
      buildFleetStatus: statusMod.buildFleetStatus,
      formatFleetStatus: cliMod.formatFleetStatus,
    });
  } finally {
    vi.doUnmock('../src/core/phantom.js');
    vi.doUnmock('../src/core/mcp-registry.js');
    vi.resetModules();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevAshlrHome === undefined) delete process.env.ASHLR_HOME;
    else process.env.ASHLR_HOME = prevAshlrHome;
    rmSync(tmpHome, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('M348 FleetStatus Phantom capability', () => {
  it('surfaces a values-free Phantom snapshot and formatter line', async () => {
    await withFleetMocks(phantomStatus, async ({ buildFleetStatus, formatFleetStatus }) => {
      const status = await buildFleetStatus(baseConfig());
      const serialized = JSON.stringify(status.phantom);

      expect(status.phantom).toMatchObject({
        state: 'ready',
        installed: true,
        initialized: true,
        valueMode: 'metadata-and-names-only',
        secretCount: 2,
        knownFleetSecrets: {
          total: 6,
          presentCount: 2,
          missingCount: 4,
          pulseCredentialPresent: true,
          nimApiKeyPresent: false,
        },
        config: {
          phantomExecEnabled: true,
          fleetSecretInjectionEnabled: true,
        },
        commands: {
          commandsKnown: true,
          setupAvailable: true,
          execAvailable: true,
          mcpAvailable: true,
          agentAvailable: false,
        },
        mcp: { configured: true },
      });
      expect(serialized).not.toContain('ANTHROPIC_API_KEY');
      expect(serialized).not.toContain('ASHLR_PULSE_TOKEN');
      expect(serialized).not.toContain('sk-should-never-surface');
      expect(serialized).not.toContain('/Users/masonwyatt');

      const rendered = formatFleetStatus(status);
      expect(rendered).toContain('Phantom:');
      expect(rendered).toContain('ready v0.6.0');
      expect(rendered).toContain('2/6 known fleet secrets');
      expect(rendered).toContain('pulse yes');
      expect(rendered).toContain('nim no');
      expect(rendered).toContain('mcp yes');
      expect(rendered).toContain('agent no');
      expect(rendered).toContain('values hidden');
      expect(rendered).not.toContain('ANTHROPIC_API_KEY');
      expect(rendered).not.toContain('ASHLR_PULSE_TOKEN');
      expect(rendered).not.toContain('sk-should-never-surface');
    });
  });

  it('renders agent yes only when Phantom reports an actual agent command', async () => {
    await withFleetMocks(() => {
      const base = phantomStatus();
      return {
        ...base,
        capability: {
          ...base.capability,
          commands: {
            ...base.capability.commands,
            agentAvailable: true,
          },
        },
      };
    }, async ({ buildFleetStatus, formatFleetStatus }) => {
      const status = await buildFleetStatus(baseConfig());
      const rendered = formatFleetStatus(status);

      expect(status.phantom?.commands.agentAvailable).toBe(true);
      expect(rendered).toContain('agent yes');
      expect(rendered).toContain('values hidden');
    });
  });

  it('keeps command metadata for installed but uninitialized Phantom', async () => {
    await withFleetMocks(() => {
      const base = phantomStatus({ secretNames: [] });
      return {
        ...base,
        initialized: false,
        secretNames: [],
        capability: {
          ...base.capability,
          secretCount: 0,
          modes: {
            ...base.capability.modes,
            childEnvInjectionAvailable: false,
          },
        },
      };
    }, async ({ buildFleetStatus, formatFleetStatus }) => {
      const status = await buildFleetStatus(baseConfig());

      expect(status.phantom).toMatchObject({
        state: 'not-initialized',
        initialized: false,
        secretCount: 0,
        commands: {
          commandsKnown: true,
          agentAvailable: false,
        },
      });
      expect(formatFleetStatus(status)).toContain('agent no');
    });
  });

  it('keeps all command support false when Phantom is not installed', async () => {
    await withFleetMocks(() => {
      const base = phantomStatus({ installed: false, secretNames: [] });
      return {
        ...base,
        version: null,
        initialized: false,
        secretNames: [],
        capability: {
          ...base.capability,
          secretCount: 0,
          commands: {
            commandsKnown: false,
            setupAvailable: false,
            execAvailable: false,
            mcpAvailable: false,
            agentAvailable: false,
          },
        },
      };
    }, async ({ buildFleetStatus }) => {
      const status = await buildFleetStatus(baseConfig());

      expect(status.phantom).toMatchObject({
        state: 'not-installed',
        installed: false,
        commands: {
          commandsKnown: false,
          setupAvailable: false,
          execAvailable: false,
          mcpAvailable: false,
          agentAvailable: false,
        },
      });
    });
  });

  it('degrades without throwing when the cached Phantom probe fails', async () => {
    await withFleetMocks(() => {
      throw new Error('phantom probe failed at /Users/masonwyatt/.ashlr/settings.json');
    }, async ({ buildFleetStatus }) => {
      const status = await buildFleetStatus(baseConfig());

      expect(status.phantom).toMatchObject({
        state: 'degraded',
        installed: false,
        initialized: false,
        secretCount: 0,
        commands: {
          commandsKnown: false,
          setupAvailable: false,
          execAvailable: false,
          mcpAvailable: false,
          agentAvailable: false,
        },
        mcp: { configured: false },
      });
      expect(status.phantom?.error).toContain('phantom probe failed');
      expect(status.phantom?.error).not.toContain('/Users/masonwyatt');
    });
  });
});
