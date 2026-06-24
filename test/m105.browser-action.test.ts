/**
 * test/m105.browser-action.test.ts — M105 BROWSER-ACTION adversarial suite.
 *
 * Protects the PROPOSAL-ONLY invariant and gated-execution contract for the
 * 'browser-action' kind:
 *   - applyProposal executes ONLY when ALL gates pass: approved + confirmed +
 *     enrolled + kill-switch-off + action payload present + browser MCP reachable.
 *   - Refuses CLEANLY (ok:false, no crash) when the browser MCP is unreachable.
 *   - The native tool ashlr_browser_task creates a PENDING proposal and NEVER executes.
 *   - Every execution path (ok or refused/failed) is audited.
 *
 * SAFETY (paramount): isolated tmp HOME per test (H1 fixture), disposable repos
 * only. mcp-gateway probe + callBrowserTool are vi.mock'd — no real browser,
 * no real MCP connection. mcp-registry is mock'd to control reachability.
 * Real ~/.ashlr is NEVER touched. DETERMINISTIC — no live model.
 *
 * Adversarial matrix (13 cases):
 *   A1  REFUSES when proposal not found
 *   A2  REFUSES when status !== 'approved' (pending)
 *   A3  REFUSES when status !== 'approved' (rejected)
 *   A4  REFUSES when confirmed === false
 *   A5  REFUSES when kill switch is ON (even enrolled)
 *   A6  REFUSES when repo not enrolled
 *   A7  REFUSES when action payload missing
 *   A8  REFUSES when action.type is wrong (not 'browser-task')
 *   A9  REFUSES when instructions is empty
 *   A10 REFUSES cleanly when no browser MCP server configured (empty registry)
 *   A11 REFUSES cleanly when browser MCP probe returns reachable:false
 *   A12 APPLIES (all gates pass + MCP reachable + navigate + execute) — audited ok
 *   A13 APPLIES without URL (instructions-only path) — audited ok
 *   N1  ashlr_browser_task creates PENDING proposal and NEVER executes directly
 *   N2  ashlr_browser_task refuses when repo not enrolled (no proposal created)
 *   N3  ashlr_browser_task refuses when kill switch is ON
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock mcp-registry — controls what loadRegistry() returns.
// We start with an empty registry (no browser MCP) and override per-test.
// ---------------------------------------------------------------------------

// apply.ts calls discoverMcpServers() (synchronous) from mcp-registry.js.
// The mock must export that exact name. _registryImpl is still async in the
// test helper signatures for future-compat but discoverMcpServers itself is sync
// — we wrap it in a synchronous return to match the real signature.
let _registryImpl: () => { servers: { name: string; command: string; args: string[]; env?: Record<string, string> }[] };

vi.mock('../src/core/mcp-registry.js', () => ({
  discoverMcpServers: () => _registryImpl(),
}));

// ---------------------------------------------------------------------------
// Mock mcp-gateway — spy on probeBrowserMcp / callBrowserTool / findBrowserSpec
// without spawning real children.
// ---------------------------------------------------------------------------

let _probeBrowserMcpImpl: (...args: unknown[]) => Promise<{
  reachable: boolean;
  serverName: string | null;
  availableTools: string[];
  error?: string;
}>;
let _callBrowserToolImpl: (...args: unknown[]) => Promise<{ ok: boolean; detail: string; result?: unknown }>;
let _findBrowserSpecImpl: (...args: unknown[]) => unknown;

vi.mock('../src/core/mcp-gateway.js', () => ({
  probeBrowserMcp: (...args: unknown[]) => _probeBrowserMcpImpl(...args),
  callBrowserTool: (...args: unknown[]) => _callBrowserToolImpl(...args),
  findBrowserSpec: (...args: unknown[]) => _findBrowserSpecImpl(...args),
  // The gateway also exports probeServer + startGateway + isSelfGateway used
  // elsewhere — provide no-op stubs so any ambient import doesn't crash.
  probeServer: async () => ({ name: 'mock', ok: false, toolCount: 0, tools: [], error: 'mocked' }),
  startGateway: async () => {},
  isSelfGateway: () => false,
  GATEWAY_ENV_MARKER: 'ASHLR_MCP_GATEWAY',
}));

// Also mock config.js so loadConfig() inside apply.ts works in the tmp HOME.
vi.mock('../src/core/config.js', () => ({
  loadConfig: () => ({ editor: 'vscode', inboxDir: undefined }),
}));

// ---------------------------------------------------------------------------
// Lazy imports — AFTER vi.mock hoists.
// ---------------------------------------------------------------------------

import {
  makeFixture,
  makeCfg,
  type H1Fixture,
  type DisposableRepo,
} from './helpers/h1-fixture.js';
import { createProposal, loadProposal, setStatus, pendingCount } from '../src/core/inbox/store.js';
import { applyProposal } from '../src/core/inbox/apply.js';
import { callNativeTool } from '../src/core/mcp-native.js';
import { readAudit } from '../src/core/sandbox/audit.js';
import type { AuditEntry, Proposal } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Shared spec fixture for the mock browser MCP server
// ---------------------------------------------------------------------------

const MOCK_BROWSER_SPEC = {
  name: 'claude-in-chrome',
  command: '/usr/local/bin/chrome-mcp',
  args: ['--mcp'],
};

const MOCK_REGISTRY = { servers: [MOCK_BROWSER_SPEC] };

// ---------------------------------------------------------------------------
// Default mock implementations (can be overridden per-test)
// ---------------------------------------------------------------------------

function defaultEmptyRegistry() {
  _registryImpl = () => ({ servers: [] });
}

function defaultBrowserReachable() {
  _registryImpl = () => MOCK_REGISTRY;
  _probeBrowserMcpImpl = async () => ({
    reachable: true,
    serverName: 'claude-in-chrome',
    availableTools: ['navigate', 'read_page', 'computer'],
  });
  _findBrowserSpecImpl = (_registry: unknown, name: string) =>
    name === 'claude-in-chrome' ? MOCK_BROWSER_SPEC : null;
  _callBrowserToolImpl = async (_spec: unknown, _tool: string, _args: unknown) => ({
    ok: true,
    detail: 'mock browser tool call succeeded',
  });
}

function defaultBrowserUnreachable(error = 'mock: no browser MCP reachable') {
  _registryImpl = () => MOCK_REGISTRY;
  _probeBrowserMcpImpl = async () => ({
    reachable: false,
    serverName: null,
    availableTools: [],
    error,
  });
  _findBrowserSpecImpl = () => null;
  _callBrowserToolImpl = async () => ({ ok: false, detail: 'should not be called' });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyAudits(): AuditEntry[] {
  return readAudit().filter((e) => e.action === 'inbox:apply');
}

function latestApplyAudit(): AuditEntry | undefined {
  return applyAudits()[0]; // readAudit() is newest-first
}

function latestNativeAudit(): AuditEntry | undefined {
  return readAudit().filter((e) => e.action === 'mcp:native-call')[0];
}

/** Create a browser-action proposal (approved by default via setStatus). */
function makeBrowserProposal(
  repo: string,
  overrides: Partial<Omit<Proposal, 'id' | 'status' | 'createdAt'>> = {},
): Proposal {
  return createProposal({
    repo,
    origin: 'agent',
    kind: 'browser-action',
    title: 'Browser task',
    summary: 'Automate something in the browser',
    action: { type: 'browser-task', url: 'https://example.com', instructions: 'Click the button' },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

let fx: H1Fixture;
let repo: DisposableRepo;

beforeEach(async () => {
  fx = await makeFixture();
  repo = fx.makeRepo();
  // Reset to safe defaults
  defaultEmptyRegistry();
  expect.hasAssertions();
});

afterEach(async () => {
  fx.setKill(false);
  await fx.cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// A-series: applyProposal adversarial gate checks
// ---------------------------------------------------------------------------

describe('applyProposal — browser-action gate chain', () => {
  it('A1 REFUSES when proposal does not exist', async () => {
    const result = await applyProposal('nonexistent-browser-id', { confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/not found/i);
    expect(latestApplyAudit()?.result).toBe('refused');
  });

  it('A2 REFUSES when status is pending (not approved)', async () => {
    repo.enroll();
    defaultBrowserReachable();
    const p = makeBrowserProposal(repo.dir);
    // status is 'pending' by default — do NOT approve
    const result = await applyProposal(p.id, { confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('pending');
    expect(latestApplyAudit()?.result).toBe('refused');
    // Proposal must NOT be burned to failed
    expect(loadProposal(p.id)?.status).toBe('pending');
  });

  it('A3 REFUSES when status is rejected', async () => {
    repo.enroll();
    defaultBrowserReachable();
    const p = makeBrowserProposal(repo.dir);
    setStatus(p.id, 'rejected');
    const result = await applyProposal(p.id, { confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('rejected');
    expect(latestApplyAudit()?.result).toBe('refused');
  });

  it('A4 REFUSES when confirmed === false', async () => {
    repo.enroll();
    defaultBrowserReachable();
    const p = makeBrowserProposal(repo.dir);
    setStatus(p.id, 'approved');
    const result = await applyProposal(p.id, { confirmed: false });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/confirmed/i);
    expect(latestApplyAudit()?.result).toBe('refused');
  });

  it('A5 REFUSES when kill switch is ON (even enrolled)', async () => {
    repo.enroll();
    fx.setKill(true);
    defaultBrowserReachable();
    const p = makeBrowserProposal(repo.dir);
    setStatus(p.id, 'approved');
    const result = await applyProposal(p.id, { confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/kill switch/i);
    expect(result.status).toBe('approved'); // NOT burned to failed
    expect(latestApplyAudit()?.result).toBe('refused');
  });

  it('A6 REFUSES when repo is not enrolled', async () => {
    // Deliberately NOT enrolling
    defaultBrowserReachable();
    const p = makeBrowserProposal(repo.dir);
    setStatus(p.id, 'approved');
    const result = await applyProposal(p.id, { confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/not enrolled|enrollment/i);
    expect(result.status).toBe('approved'); // NOT burned to failed
    expect(latestApplyAudit()?.result).toBe('refused');
  });

  it('A7 REFUSES when action payload is missing', async () => {
    repo.enroll();
    defaultBrowserReachable();
    const p = createProposal({
      repo: repo.dir,
      origin: 'agent',
      kind: 'browser-action',
      title: 'No action',
      summary: 'Missing action field',
      // action deliberately omitted
    });
    setStatus(p.id, 'approved');
    const result = await applyProposal(p.id, { confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/missing action/i);
    expect(result.status).toBe('failed');
    expect(latestApplyAudit()?.result).toBe('error');
  });

  it('A8 REFUSES when action.type is wrong (not browser-task)', async () => {
    repo.enroll();
    defaultBrowserReachable();
    const p = createProposal({
      repo: repo.dir,
      origin: 'agent',
      kind: 'browser-action',
      title: 'Wrong type',
      summary: 'Desktop action type on browser-action kind',
      // Cast to bypass TypeScript — simulates a tampered/migrated proposal on disk
      action: { type: 'open-finder' as unknown as 'browser-task', instructions: 'nope', target: repo.dir } as never,
    });
    setStatus(p.id, 'approved');
    const result = await applyProposal(p.id, { confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/wrong action type|expected.*browser-task/i);
    expect(result.status).toBe('failed');
    expect(latestApplyAudit()?.result).toBe('error');
  });

  it('A9 REFUSES when instructions is empty', async () => {
    repo.enroll();
    defaultBrowserReachable();
    const p = createProposal({
      repo: repo.dir,
      origin: 'agent',
      kind: 'browser-action',
      title: 'Empty instructions',
      summary: 'Blank instructions',
      action: { type: 'browser-task', instructions: '   ' },
    });
    setStatus(p.id, 'approved');
    const result = await applyProposal(p.id, { confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/instructions/i);
    expect(result.status).toBe('failed');
    expect(latestApplyAudit()?.result).toBe('error');
  });

  it('A10 REFUSES cleanly when no browser MCP server is configured (empty registry)', async () => {
    repo.enroll();
    // defaultEmptyRegistry() already set in beforeEach
    const p = makeBrowserProposal(repo.dir);
    setStatus(p.id, 'approved');
    const result = await applyProposal(p.id, { confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/browser automation unavailable|no Claude-in-Chrome/i);
    expect(result.detail).toMatch(/configure it to enable browser-action/i);
    // Must be a clean refusal (failed), NOT a crash
    expect(result.status).toBe('failed');
    expect(latestApplyAudit()?.result).toBe('error');
  });

  it('A11 REFUSES cleanly when browser MCP probe returns reachable:false', async () => {
    repo.enroll();
    defaultBrowserUnreachable('chrome MCP not running');
    const p = makeBrowserProposal(repo.dir);
    setStatus(p.id, 'approved');
    const result = await applyProposal(p.id, { confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/browser automation unavailable/i);
    expect(result.detail).toMatch(/configure it to enable browser-action/i);
    // Graceful degrade — not a crash
    expect(result.status).toBe('failed');
    expect(latestApplyAudit()?.result).toBe('error');
  });

  it('A12 APPLIES when all gates pass + MCP reachable + URL navigate + execute', async () => {
    repo.enroll();

    // Track which tools were called and in which order
    const callLog: Array<{ tool: string; args: Record<string, unknown> }> = [];
    _registryImpl = () => MOCK_REGISTRY;
    _probeBrowserMcpImpl = async () => ({
      reachable: true,
      serverName: 'claude-in-chrome',
      availableTools: ['navigate', 'read_page', 'computer'],
    });
    _findBrowserSpecImpl = () => MOCK_BROWSER_SPEC;
    _callBrowserToolImpl = async (_spec: unknown, tool: string, args: Record<string, unknown>) => {
      callLog.push({ tool, args });
      return { ok: true, detail: `${tool} succeeded` };
    };

    const p = makeBrowserProposal(repo.dir); // has url + instructions
    setStatus(p.id, 'approved');
    const result = await applyProposal(p.id, { confirmed: true });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('applied');
    expect(result.detail).toMatch(/browser-action executed/i);
    expect(result.detail).toContain('https://example.com');
    expect(result.detail).toContain('claude-in-chrome');

    // navigate was called first, then computer
    expect(callLog[0]?.tool).toBe('navigate');
    expect(callLog[0]?.args).toMatchObject({ url: 'https://example.com' });
    expect(callLog[1]?.tool).toBe('computer');

    // Audited as ok
    expect(latestApplyAudit()?.result).toBe('ok');
    expect(latestApplyAudit()?.summary).toContain('applied');
  });

  it('A13 APPLIES without URL (instructions-only path) — no navigate call', async () => {
    repo.enroll();

    const callLog: string[] = [];
    _registryImpl = () => MOCK_REGISTRY;
    _probeBrowserMcpImpl = async () => ({
      reachable: true,
      serverName: 'claude-in-chrome',
      availableTools: ['navigate', 'read_page', 'computer'],
    });
    _findBrowserSpecImpl = () => MOCK_BROWSER_SPEC;
    _callBrowserToolImpl = async (_spec: unknown, tool: string) => {
      callLog.push(tool);
      return { ok: true, detail: `${tool} succeeded` };
    };

    const p = createProposal({
      repo: repo.dir,
      origin: 'agent',
      kind: 'browser-action',
      title: 'No-URL browser task',
      summary: 'Just run instructions, no navigation',
      action: { type: 'browser-task', instructions: 'Read the page title' },
    });
    setStatus(p.id, 'approved');
    const result = await applyProposal(p.id, { confirmed: true });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('applied');
    expect(result.detail).toMatch(/browser-action executed/i);
    expect(result.detail).toContain('claude-in-chrome');

    // navigate must NOT have been called (no URL)
    expect(callLog).not.toContain('navigate');
    // computer (or read_page) must have been called
    expect(callLog.length).toBeGreaterThanOrEqual(1);
    expect(['computer', 'read_page']).toContain(callLog[0]);

    expect(latestApplyAudit()?.result).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// N-series: ashlr_browser_task native tool — PROPOSAL-ONLY invariant
// ---------------------------------------------------------------------------

describe('ashlr_browser_task native tool — proposal-only invariant', () => {
  it('N1 creates a PENDING proposal and NEVER executes the browser task directly', async () => {
    repo.enroll();
    defaultBrowserReachable();

    const result = await callNativeTool('ashlr_browser_task', {
      repo: repo.dir,
      url: 'https://example.com',
      instructions: 'Click the login button',
      title: 'Fleet wants to log in',
      summary: 'Automate login for testing',
    });

    // Must be a non-error text result
    const content = result.content[0] as { type: 'text'; text: string };
    expect(content.type).toBe('text');
    expect(result.isError).toBeFalsy();

    const parsed = JSON.parse(content.text) as {
      created: boolean;
      id: string;
      status: string;
      note: string;
    };
    expect(parsed.created).toBe(true);
    expect(parsed.status).toBe('pending');
    expect(parsed.note).toMatch(/pending|approve/i);
    expect(typeof parsed.id).toBe('string');

    // Proposal is in the inbox as pending
    const p = loadProposal(parsed.id);
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('browser-action');
    expect(p!.status).toBe('pending');
    expect(p!.action?.type).toBe('browser-task');

    // CRITICAL: gateway mocks must NOT have been called (proposal-only)
    // The handler only creates a proposal; it never calls probeBrowserMcp or callBrowserTool
    expect(latestNativeAudit()?.result).toBe('ok');
  });

  it('N1b proposal carries url + instructions faithfully', async () => {
    repo.enroll();

    const result = await callNativeTool('ashlr_browser_task', {
      repo: repo.dir,
      url: 'https://app.example.com/dashboard',
      instructions: 'Verify the revenue chart loads',
      title: 'Check dashboard chart',
      summary: 'QA pass on dashboard',
    });

    const content = result.content[0] as { type: 'text'; text: string };
    const parsed = JSON.parse(content.text) as { id: string };
    const p = loadProposal(parsed.id);
    expect(p?.action?.type).toBe('browser-task');
    if (p?.action?.type === 'browser-task') {
      expect(p.action.url).toBe('https://app.example.com/dashboard');
      expect(p.action.instructions).toBe('Verify the revenue chart loads');
    }
  });

  it('N2 refuses with error when repo is not enrolled (no proposal created)', async () => {
    // Deliberately NOT enrolling
    const countBefore = pendingCount();

    const result = await callNativeTool('ashlr_browser_task', {
      repo: repo.dir,
      instructions: 'Should fail',
      title: 'Should fail',
      summary: 'Repo not enrolled',
    });

    const content = result.content[0] as { type: 'text'; text: string };
    const parsed = JSON.parse(content.text) as { error?: string };
    expect(parsed.error).toMatch(/not enrolled/i);

    expect(pendingCount()).toBe(countBefore); // no proposal created
  });

  it('N3 refuses when kill switch is ON (safety class = proposal → blocked)', async () => {
    repo.enroll();
    fx.setKill(true);

    const result = await callNativeTool('ashlr_browser_task', {
      repo: repo.dir,
      instructions: 'Should be blocked',
      title: 'Kill switch on',
      summary: 'Kill switch test',
    });

    const content = result.content[0] as { type: 'text'; text: string };
    expect(content.text).toMatch(/kill switch|refused/i);
    expect(result.isError).toBe(true);
    expect(latestNativeAudit()?.result).toBe('refused');
  });

  it('N4 refuses when instructions is missing (required arg)', async () => {
    repo.enroll();

    const result = await callNativeTool('ashlr_browser_task', {
      repo: repo.dir,
      // instructions deliberately omitted
      title: 'Missing instructions',
      summary: 'Should fail validation',
    });

    const content = result.content[0] as { type: 'text'; text: string };
    expect(content.text).toMatch(/missing required argument|instructions/i);
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-check: A14 from m103 still holds — old browser-action stub now replaced
// ---------------------------------------------------------------------------

describe('backward-compat: A14 stub from m103 is superseded by Phase 2b', () => {
  it('browser-action with empty registry still refuses cleanly (no "not yet implemented" message)', async () => {
    repo.enroll();
    // Empty registry — no browser MCP
    const p = createProposal({
      repo: repo.dir,
      origin: 'agent',
      kind: 'browser-action',
      title: 'Phase 2b degrade check',
      summary: 'Verify graceful degrade',
      action: { type: 'browser-task', instructions: 'Do something' },
    });
    setStatus(p.id, 'approved');
    const result = await applyProposal(p.id, { confirmed: true });
    expect(result.ok).toBe(false);
    // Must be the new graceful-degrade message, NOT the old stub
    expect(result.detail).not.toMatch(/not yet implemented|Phase 2b/i);
    expect(result.detail).toMatch(/browser automation unavailable/i);
    expect(result.status).toBe('failed');
    expect(latestApplyAudit()?.result).toBe('error');
  });
});
