/**
 * apps-fixtures.test-support.ts — fixtures for the Apps & Accounts tests, typed with
 * the SERVER'S OWN wire types so a contract change breaks the tests at
 * compile time, and shaped like Mason's machine on 2026-09-24 (the live,
 * read-only detection run: ollama 0.33.3, claude 2.1.280, codex 0.136.0,
 * grok 0.2.118, hermes 0.15.1, aider 0.86.2, goose 1.30.0, llama-server 0.4.1;
 * opencode / droid / pi / cline / LM Studio not installed).
 *
 * Pure data (no vitest import) so the visual harness can render the page
 * from exactly the fixtures the tests use.
 */
import type { BudgetView } from '../../../../core/routing/policy.js';
import type { VerseHealthResponse } from '../../../../core/verse/health-types.js';
import type { VerseMcpSnapshot } from '../../../../core/verse/mcp-seat-view.js';
import type { VerseAppRow, VerseAppsResponse } from '../../../../core/verse/workbench-types.js';
import type { VerseBootstrap } from '../../../data/api-types.js';
import { CLAUDE_TIGHT_SEAT, GROK_SEAT, LOCAL_SEAT_V2 } from '../seat-fixtures.test-support.js';

function agent(id: string, name: string, monogram: string, engine: VerseAppRow['engine'], launch: string, version: string | null, ollama: string | null): VerseAppRow {
  const installed = version !== null;
  return {
    id,
    name,
    monogram,
    engine,
    description: `${name} CLI`,
    health: installed ? { state: 'ok', label: 'installed' } : { state: 'off', label: 'not installed' },
    installed,
    version,
    copy: { label: launch, text: launch },
    ollamaLaunch: ollama ? ['ollama', 'launch', ollama] : null,
    toggle: null,
    actions: [{
      kind: 'launch',
      label: 'Launch',
      command: [launch],
      disabledReason: installed ? null : ollama ? `Not installed. Running ollama launch ${ollama} yourself can install it.` : 'Not installed.',
    }],
    seatId: null,
    detail: null,
  };
}

export const APPS: VerseAppsResponse = {
  checkedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
  pathSource: 'login-shell',
  groups: [
    {
      id: 'desktop',
      title: 'Desktop',
      caveat: 'These switch another app to local Ollama models.',
      apps: [
        {
          id: 'claude-desktop',
          name: 'Claude Desktop',
          monogram: 'C',
          engine: 'claude',
          description: 'Use Ollama models in Claude Desktop',
          health: { state: 'off', label: 'off' },
          installed: null,
          version: null,
          copy: null,
          ollamaLaunch: null,
          toggle: { enabled: false, command: ['ollama', 'launch', 'claude-desktop'], restoreCommand: ['ollama', 'launch', 'claude-desktop', '--restore'] },
          actions: [{ kind: 'restore', label: 'Restore', command: ['ollama', 'launch', 'claude-desktop', '--restore'], disabledReason: null }],
          seatId: null,
          detail: "Replaces Claude Desktop's own models with local ones until restored.",
        },
      ],
    },
    {
      id: 'terminal-agents',
      title: 'Terminal agents',
      caveat: null,
      apps: [
        agent('claude-code', 'Claude Code', 'C', 'claude', 'claude', '2.1.280', 'claude'),
        agent('codex', 'Codex', 'X', 'codex', 'codex', '0.136.0', 'codex'),
        agent('grok', 'Grok', 'G', 'grok', 'grok', '0.2.118', null),
        agent('opencode', 'OpenCode', 'O', null, 'opencode', null, 'opencode'),
      ],
    },
    {
      id: 'local-models',
      title: 'Local models',
      caveat: null,
      apps: [
        {
          id: 'ollama', name: 'Ollama', monogram: 'L', engine: 'local', description: 'Local model runtime — serves the local seats',
          health: { state: 'ok', label: 'running' }, installed: true, version: '0.33.3', copy: null, ollamaLaunch: null, toggle: null, actions: [], seatId: null,
          detail: '4 models · 1 loaded · ≈8.5 tok/s end to end, last local turn',
        },
        {
          id: 'lm-studio', name: 'LM Studio', monogram: 'L', engine: 'local', description: 'Local model app with an OpenAI-compatible server',
          health: { state: 'off', label: 'not installed' }, installed: false, version: null, copy: null, ollamaLaunch: null, toggle: null, actions: [], seatId: null, detail: null,
        },
      ],
    },
  ],
};

export const CLAUDE_SEAT = { ...CLAUDE_TIGHT_SEAT, id: 'claude-a', accountId: 'claude-a' };

export const BOOTSTRAP: VerseBootstrap = {
  seats: [CLAUDE_SEAT, GROK_SEAT, LOCAL_SEAT_V2],
  projects: [{ path: '/Users/op/code/ashlr-hub', name: 'ashlr-hub', enrolled: true }, { path: '/Users/op/code/site', name: 'site', enrolled: false }],
  sessions: [
    { id: 's-old', title: 'old', projectPath: '/Users/op/code/site', updatedAt: '2026-09-20T00:00:00.000Z' },
    { id: 's-new', title: 'new', projectPath: '/Users/op/code/ashlr-hub', updatedAt: '2026-09-24T00:00:00.000Z' },
  ] as unknown as VerseBootstrap['sessions'],
  dispatchEnabled: true,
  localRuntime: {} as VerseBootstrap['localRuntime'],
};

export const HEALTH: VerseHealthResponse = {
  checkedAt: '2026-09-24T10:00:00.000Z',
  seats: [
    {
      seatId: 'claude-a', engine: 'claude', connection: 'binary-skew', checkedAt: 'x', cliVersion: '2.1.257', newestCliVersion: '2.1.280',
      credentialExpiresAt: null, lastRefreshAt: null, resetAt: null, reasons: ['Pinned to Claude Code 2.1.257; 2.1.280 is installed.'],
      fix: { kind: 'repin', command: ['ashlr', 'resources', 'profile', 'repin'] },
    },
    {
      seatId: 'grok', engine: 'grok', connection: 'signed-out', checkedAt: 'x', cliVersion: null, newestCliVersion: null,
      credentialExpiresAt: null, lastRefreshAt: null, resetAt: null, reasons: ['Grok is signed out.'], fix: { kind: 'reauth' },
    },
  ],
};

export const BUDGET = {
  mode: 'balanced',
  seats: {},
  updatedAt: '2026-09-24T10:00:00.000Z',
  headroom: [
    { seatId: 'claude-a', sessionUsedPercent: 15, weeklyUsedPercent: 85, bindingWindow: 'weekly', autonomyHeadroomPercent: 0, resetAt: null, eligibleForAutonomy: false, reasons: ['Past the ceiling.'] },
  ],
  seatInfo: [
    { seatId: 'claude-a', label: 'Claude Max', engine: 'claude', free: false },
    { seatId: 'grok', label: 'Grok', engine: 'grok', free: false },
  ],
  effective: {
    'claude-a': { seatId: 'claude-a', enabled: true, reservePercent: 40, maxSessionWindowPercent: 70 },
    grok: { seatId: 'grok', enabled: true, reservePercent: 0 },
  },
  readingMaxAgeMs: 600_000,
  sampledAt: new Date().toISOString(),
} as unknown as BudgetView;

export const MCP: VerseMcpSnapshot = {
  sampledAt: '2026-09-24T10:00:00.000Z',
  seats: [
    { seatId: 'claude-a', label: 'Claude Max', engine: 'claude', accountId: 'claude-a', servers: [], reason: 'mcp-seat-isolated-by-adapter', configFile: null, configFormat: null, notes: [] },
    {
      seatId: 'codex-a', label: 'Personal Codex', engine: 'codex', accountId: 'codex-a',
      servers: [{ name: 'ashlr', command: 'bun', args: ['server.ts'], env: { ASHLR_TOKEN: '<set>' }, sourceRef: '.codex/config.toml' }],
      reason: 'mcp-account-config-read', configFile: 'config.toml', configFormat: 'toml', notes: [],
    },
    { seatId: 'local', label: 'Local seats (every Ollama tag)', engine: 'local', accountId: 'local', servers: [], reason: 'mcp-seat-isolated-by-adapter', configFile: null, configFormat: null, notes: [] },
  ],
  machine: { servers: [], configured: true, note: 'These are configured on this machine and read by no Verse seat.' },
  scope: {
    available: true, pinned: true, aliasRef: 'ashlr', tenantRef: 'tenant_abc', principalRef: 'me', bindingRef: 'b', sealOk: true, expired: false, frozen: false,
    expiresAt: 'x', status: 'pinned', statusOneline: 'x', reason: 'mcp-scope-pinned',
  },
  notes: ['Servers are configured on this machine, and no Verse seat loads any of them.'],
};

