/**
 * M348 — FleetStatus exposes values-free Phantom capability.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function writeRunningDaemonState(lastTickAt = new Date().toISOString()): void {
  const ashlrHome = process.env.ASHLR_HOME;
  if (!ashlrHome) throw new Error('ASHLR_HOME must be set before writing daemon state');
  mkdirSync(ashlrHome, { recursive: true });
  writeFileSync(
    join(ashlrHome, 'daemon.json'),
    JSON.stringify(
      {
        running: true,
        pid: process.pid,
        startedAt: lastTickAt,
        lastTickAt,
        todayDate: lastTickAt.slice(0, 10),
        todaySpentUsd: 0,
        itemsProcessed: 1,
        ticks: [],
      },
      null,
      2,
    ),
    'utf8',
  );
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
    getCachedFleetPhantomStatus: (options?: { includeAgentReport?: boolean }) => {
      const status = statusFactory();
      return options?.includeAgentReport === true
        ? status
        : { ...status, agentReport: undefined };
    },
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
      expect(status.phantom?.agentReport).toBeUndefined();
      expect(rendered).toContain('agent yes');
      expect(rendered).not.toContain('report repos=');
      expect(rendered).toContain('values hidden');
    });
  });

  it('surfaces and renders only aggregate Phantom agent report counts', async () => {
    await withFleetMocks(() => {
      const base = phantomStatus();
      const agentReport = {
        valuesHidden: true,
        scannedRepos: 3,
        validReports: 2,
        failedReports: 1,
        statusCounts: {
          ok: 1,
          'requires-approval': 1,
          failed: 1,
          '/Users/masonwyatt/private/repo': 1,
        },
        riskCounts: {
          critical: 1,
          high: 1,
          low: 1,
          'phantom reveal SECRET': 1,
        },
        severityCounts: {
          critical: 1,
          high: 1,
          info: 1,
          'raw finding TOKEN=abc123': 1,
        },
        requiresApprovalCount: 1,
        delegationSafety: {
          safetyCounts: {
            safe: 2,
            unsafe: 1,
            unknown: 1,
            '/Users/masonwyatt/private/repo': 9,
          },
          statusCounts: {
            review: 1,
            blocked: 1,
            'requires-approval': 1,
            'phantom reveal SECRET': 1,
          },
          primaryActionCounts: {
            delegate: 2,
            review: 1,
            block: 1,
            'raw finding TOKEN=abc123': 1,
          },
        },
        repoPath: '/Users/masonwyatt/private/repo',
        command: 'phantom reveal SECRET',
        findings: [{ message: 'raw finding TOKEN=abc123', path: '/Users/masonwyatt/private/repo/.env' }],
      } as unknown as NonNullable<PhantomStatus['agentReport']>;
      return {
        ...base,
        capability: {
          ...base.capability,
          commands: {
            ...base.capability.commands,
            agentAvailable: true,
          },
        },
        agentReport,
      };
    }, async ({ buildFleetStatus, formatFleetStatus }) => {
      writeRunningDaemonState();
      const cfg = baseConfig();
      cfg.phantom = {
        enabled: true,
        agentReportRollup: { enabled: true },
      };
      cfg.foundry = {
        ...cfg.foundry,
        autoMerge: {
          enabled: true,
          trustBasis: 'verification',
          maxRisk: 'low',
        },
      };
      const status = await buildFleetStatus(cfg);
      const serialized = JSON.stringify(status.phantom);
      const serializedStatus = JSON.stringify(status);

      expect(status.phantom?.agentReport).toEqual({
        valuesHidden: true,
        scannedRepos: 3,
        validReports: 2,
        failedReports: 1,
        statusCounts: {
          ok: 1,
          'requires-approval': 1,
          failed: 1,
        },
        riskCounts: {
          critical: 1,
          high: 1,
          low: 1,
        },
        severityCounts: {
          critical: 1,
          high: 1,
          info: 1,
        },
        requiresApprovalCount: 1,
        delegationSafety: {
          safetyCounts: {
            safe: 2,
            unsafe: 1,
            unknown: 1,
          },
          statusCounts: {
            review: 1,
            blocked: 1,
            'requires-approval': 1,
          },
          primaryActionCounts: {
            delegate: 2,
            review: 1,
            block: 1,
          },
        },
      });
      expect(serialized).not.toContain('ANTHROPIC_API_KEY');
      expect(serialized).not.toContain('ASHLR_PULSE_TOKEN');
      expect(serialized).not.toContain('/Users/masonwyatt');
      expect(serialized).not.toContain('agent report --json');
      expect(serializedStatus).not.toContain('phantom reveal SECRET');
      expect(serializedStatus).not.toContain('raw finding TOKEN=abc123');
      expect(serializedStatus).not.toContain('/Users/masonwyatt/private/repo');

      const action = status.nextActions?.find((candidate) => candidate.id === 'review-phantom-audit');
      expect(action).toMatchObject({
        priority: 'high',
        label: 'Review Phantom audit',
      });
      expect(action?.detail).toContain('3 scanned repos');
      expect(action?.detail).toContain('1 approval-required report');
      expect(action?.detail).toContain('1 failed report');
      expect(action?.detail).toContain('2 high/critical risk signals');
      expect(action?.detail).toContain('2 high/critical severity signals');
      expect(action?.detail).toContain('1 unsafe delegation');
      expect(action?.detail).toContain('1 blocked delegation');
      expect(action?.detail).toContain('4 delegation review signals');
      expect(action?.detail).toContain('Values hidden');
      expect(JSON.stringify(action)).not.toContain('phantom reveal SECRET');
      expect(JSON.stringify(action)).not.toContain('raw finding TOKEN=abc123');
      expect(JSON.stringify(action)).not.toContain('/Users/masonwyatt/private/repo');
      expect(status.autonomousShipReadiness).toMatchObject({
        verdict: 'blocked',
        confidence: 'low',
        topBlocker: {
          id: 'phantom-audit-risk',
          label: 'Phantom audit needs review',
          severity: 'high',
          source: 'phantom',
        },
        primaryAction: {
          id: 'review-phantom-audit',
        },
      });
      expect(status.autonomousShipReadiness?.topBlocker?.detail).toContain('2 high/critical risk signals');
      expect(status.autonomousShipReadiness?.sources.find((source) => source.id === 'phantom')).toMatchObject({
        label: 'Phantom Audit',
        status: 'blocked',
        sourceQuality: {
          badge: 'degraded-source',
          sourcePresent: true,
        },
      });
      expect(status.missionBrief).toMatchObject({
        directive: 'Review Phantom audit',
        blocker: {
          id: 'phantom-audit-risk',
        },
        action: {
          id: 'review-phantom-audit',
        },
        evidence: {
          readinessVerdict: 'blocked',
        },
      });
      expect(status.missionBrief?.whyNow).toContain('Phantom audit rollup needs review');

      const rendered = formatFleetStatus(status);
      expect(rendered).toContain('agent yes');
      expect(rendered).toContain('report repos=3 valid=2 failed=1 approvals=1');
      expect(rendered).toContain('status=failed=1/ok=1/requires-approval=1');
      expect(rendered).toContain('risk=critical=1/high=1/low=1');
      expect(rendered).toContain('severity=critical=1/high=1/info=1');
      expect(rendered).toContain('safety=safe=2/unknown=1/unsafe=1');
      expect(rendered).toContain('delegation-status=blocked=1/requires-approval=1/review=1');
      expect(rendered).toContain('actions=block=1/delegate=2/review=1');
      expect(rendered).toContain('values hidden');
      expect(rendered).not.toContain('ANTHROPIC_API_KEY');
      expect(rendered).not.toContain('ASHLR_PULSE_TOKEN');
      expect(rendered).not.toContain('/Users/masonwyatt');
      expect(rendered).not.toContain('agent report --json');
      expect(rendered).toContain('[high] Review Phantom audit');
      expect(rendered).not.toContain('phantom reveal SECRET');
      expect(rendered).not.toContain('raw finding TOKEN=abc123');
    });
  });

  it('does not add a Phantom audit action for clean aggregate counts', async () => {
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
        agentReport: {
          valuesHidden: true,
          scannedRepos: 2,
          validReports: 2,
          failedReports: 0,
          statusCounts: { ok: 2 },
          riskCounts: { low: 2 },
          severityCounts: { info: 2 },
          requiresApprovalCount: 0,
        },
      };
    }, async ({ buildFleetStatus }) => {
      const cfg = baseConfig();
      cfg.phantom = {
        enabled: true,
        agentReportRollup: { enabled: true },
      };
      const status = await buildFleetStatus(cfg);

      expect(status.phantom?.agentReport?.failedReports).toBe(0);
      expect(status.nextActions?.map((action) => action.id)).not.toContain('review-phantom-audit');
      expect(status.autonomousShipReadiness?.topBlocker?.id).not.toBe('phantom-audit-risk');
      expect(status.autonomousShipReadiness?.sources.find((source) => source.id === 'phantom')).toMatchObject({
        label: 'Phantom Audit',
        status: 'healthy',
        detail: 'Phantom audit rollup is clear across 2 scanned repos. Values hidden; only aggregate counts are shown.',
        sourceQuality: {
          badge: 'healthy-source',
          sourcePresent: true,
        },
      });
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
