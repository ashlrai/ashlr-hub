/**
 * test/m103.desktop-action.test.ts — M103 DESKTOP-ACTION adversarial suite.
 *
 * Protects the PROPOSAL-ONLY invariant for the new 'desktop-action' kind:
 *   - applyProposal executes ONLY when ALL gates pass: approved + confirmed +
 *     enrolled + kill-switch-off + action payload present + target within enrolled repo.
 *   - Every execution (ok or refused/failed) is audited.
 *   - The native tool ashlr_desktop_open creates a PENDING proposal and NEVER executes.
 *   - 'browser-action' always refuses.
 *
 * SAFETY (paramount): isolated tmp HOME per test (H1 fixture), disposable repos
 * only. open.ts functions are vi.mock'd to spy without spawning real processes.
 * Real ~/.ashlr is NEVER touched. DETERMINISTIC — no live model.
 *
 * Adversarial matrix (14 cases):
 *   A1  REFUSES when proposal not found
 *   A2  REFUSES when status !== 'approved' (pending)
 *   A3  REFUSES when status !== 'approved' (rejected)
 *   A4  REFUSES when confirmed === false
 *   A5  REFUSES when kill switch is ON (even enrolled)
 *   A6  REFUSES when repo not enrolled
 *   A7  REFUSES when action payload missing
 *   A8  REFUSES when action.type not in vocabulary
 *   A9  REFUSES when target is not absolute
 *   A10 REFUSES when target outside enrolled repo
 *   A11 APPLIES open-editor (all gates pass) — open.ts called, audit ok
 *   A12 APPLIES open-finder (all gates pass) — open.ts called, audit ok
 *   A13 APPLIES open-terminal (all gates pass) — open.ts called, audit ok
 *   A14 'browser-action' ALWAYS refuses (Phase 2b not implemented)
 *   N1  ashlr_desktop_open creates PENDING proposal and NEVER executes directly
 *   N2  ashlr_desktop_open refuses when repo not enrolled (no proposal created)
 *   N3  ashlr_desktop_open refuses when kill switch is ON
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock open.ts — spy without spawning real processes.
// vi.mock is hoisted; we replace with trackable no-ops.
// ---------------------------------------------------------------------------

const openInEditorMock = vi.fn();
const openInFinderMock = vi.fn();
const openInTerminalMock = vi.fn();

vi.mock('../src/cli/open.js', () => ({
  openInEditor: (...args: unknown[]) => openInEditorMock(...args),
  openInFinder: (...args: unknown[]) => openInFinderMock(...args),
  openInTerminal: (...args: unknown[]) => openInTerminalMock(...args),
  editorDeepLink: (p: string) => `vscode://file/${p}`,
}));

// Also mock config.js so loadConfig() inside the desktop-action case doesn't
// hit the real ~/.ashlr/config.json (which isn't under the tmp HOME).
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
import { createProposal, loadProposal } from '../src/core/inbox/store.js';
import { applyProposal } from '../src/core/inbox/apply.js';
import { callNativeTool } from '../src/core/mcp-native.js';
import { readAudit } from '../src/core/sandbox/audit.js';
import type { AuditEntry, Proposal } from '../src/core/types.js';

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

/** Create a desktop-action proposal in the given repo (approved by default). */
function makeDesktopProposal(
  repo: string,
  target: string,
  actionType: 'open-editor' | 'open-finder' | 'open-terminal' = 'open-finder',
  extraOverrides: Partial<Omit<Proposal, 'id' | 'status' | 'createdAt'>> = {},
): Proposal {
  return createProposal({
    repo,
    origin: 'agent',
    kind: 'desktop-action',
    title: 'Open repo root',
    summary: 'Fleet wants to open the repo root',
    action: { type: actionType, target },
    ...extraOverrides,
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
  openInEditorMock.mockClear();
  openInFinderMock.mockClear();
  openInTerminalMock.mockClear();
  expect.hasAssertions();
});

afterEach(async () => {
  fx.setKill(false);
  await fx.cleanup();
});

// ---------------------------------------------------------------------------
// A-series: applyProposal adversarial gate checks
// ---------------------------------------------------------------------------

describe('applyProposal — desktop-action gate chain', () => {
  it('A1 REFUSES when proposal does not exist', async () => {
    const result = await applyProposal('nonexistent-id', { confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/not found/i);
    expect(latestApplyAudit()?.result).toBe('refused');
  });

  it('A2 REFUSES when status is pending (not approved)', async () => {
    repo.enroll();
    const p = makeDesktopProposal(repo.dir, repo.dir);
    // status starts as 'pending' — do NOT approve
    const result = await applyProposal(p.id, { confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('pending');
    expect(latestApplyAudit()?.result).toBe('refused');
    // Proposal must NOT be burned
    expect(loadProposal(p.id)?.status).toBe('pending');
  });

  it('A3 REFUSES when status is rejected', async () => {
    repo.enroll();
    const p = makeDesktopProposal(repo.dir, repo.dir);
    const { setStatus } = await import('../src/core/inbox/store.js');
    setStatus(p.id, 'rejected');
    const result = await applyProposal(p.id, { confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('rejected');
    expect(latestApplyAudit()?.result).toBe('refused');
  });

  it('A4 REFUSES when confirmed === false', async () => {
    repo.enroll();
    const p = makeDesktopProposal(repo.dir, repo.dir);
    const { setStatus } = await import('../src/core/inbox/store.js');
    setStatus(p.id, 'approved');
    const result = await applyProposal(p.id, { confirmed: false });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/confirmed/i);
    expect(latestApplyAudit()?.result).toBe('refused');
    expect(openInFinderMock).not.toHaveBeenCalled();
  });

  it('A5 REFUSES when kill switch is ON (even enrolled)', async () => {
    repo.enroll();
    fx.setKill(true);
    const p = makeDesktopProposal(repo.dir, repo.dir);
    const { setStatus } = await import('../src/core/inbox/store.js');
    setStatus(p.id, 'approved');
    const result = await applyProposal(p.id, { confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/kill switch/i);
    expect(result.status).toBe('approved'); // NOT burned to failed
    expect(latestApplyAudit()?.result).toBe('refused');
    expect(openInFinderMock).not.toHaveBeenCalled();
  });

  it('A6 REFUSES when repo is not enrolled', async () => {
    // Deliberately NOT enrolling the repo
    const p = makeDesktopProposal(repo.dir, repo.dir);
    const { setStatus } = await import('../src/core/inbox/store.js');
    setStatus(p.id, 'approved');
    const result = await applyProposal(p.id, { confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/not enrolled|enrollment/i);
    expect(result.status).toBe('approved'); // NOT burned to failed
    expect(latestApplyAudit()?.result).toBe('refused');
    expect(openInFinderMock).not.toHaveBeenCalled();
  });

  it('A7 REFUSES when action payload is missing', async () => {
    repo.enroll();
    // Create proposal without action field
    const p = createProposal({
      repo: repo.dir,
      origin: 'agent',
      kind: 'desktop-action',
      title: 'No action payload',
      summary: 'Missing action',
      // action deliberately omitted
    });
    const { setStatus } = await import('../src/core/inbox/store.js');
    setStatus(p.id, 'approved');
    const result = await applyProposal(p.id, { confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/missing action/i);
    expect(result.status).toBe('failed');
    expect(latestApplyAudit()?.result).toBe('error');
    expect(openInFinderMock).not.toHaveBeenCalled();
  });

  it('A8 REFUSES when action.type is not in vocabulary', async () => {
    repo.enroll();
    const p = createProposal({
      repo: repo.dir,
      origin: 'agent',
      kind: 'desktop-action',
      title: 'Bad action type',
      summary: 'Invalid type',
      action: { type: 'open-browser' as 'open-editor', target: repo.dir },
    });
    const { setStatus } = await import('../src/core/inbox/store.js');
    setStatus(p.id, 'approved');
    const result = await applyProposal(p.id, { confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/vocabulary|not in the allowed/i);
    expect(result.status).toBe('failed');
    expect(latestApplyAudit()?.result).toBe('error');
  });

  it('A9 REFUSES when target is not an absolute path', async () => {
    repo.enroll();
    const p = makeDesktopProposal(repo.dir, 'relative/path/file.ts');
    const { setStatus } = await import('../src/core/inbox/store.js');
    setStatus(p.id, 'approved');
    const result = await applyProposal(p.id, { confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/absolute/i);
    expect(result.status).toBe('failed');
    expect(latestApplyAudit()?.result).toBe('error');
    expect(openInFinderMock).not.toHaveBeenCalled();
  });

  it('A10 REFUSES when target is outside every enrolled repo', async () => {
    repo.enroll();
    // Use a path that is absolute but definitely not inside the enrolled tmp repo
    const outsideTarget = '/tmp/__outside_ashlr_test_target__';
    const p = makeDesktopProposal(repo.dir, outsideTarget);
    const { setStatus } = await import('../src/core/inbox/store.js');
    setStatus(p.id, 'approved');
    const result = await applyProposal(p.id, { confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/not.*within.*enrolled|outside.*enrolled/i);
    expect(result.status).toBe('failed');
    expect(latestApplyAudit()?.result).toBe('error');
    expect(openInFinderMock).not.toHaveBeenCalled();
  });

  it('A11 APPLIES open-editor when all gates pass — open.ts called, audit ok', async () => {
    repo.enroll();
    const target = repo.dir;
    const p = makeDesktopProposal(repo.dir, target, 'open-editor');
    const { setStatus } = await import('../src/core/inbox/store.js');
    setStatus(p.id, 'approved');
    const result = await applyProposal(p.id, { confirmed: true });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('applied');
    expect(result.detail).toMatch(/open-editor/);
    expect(openInEditorMock).toHaveBeenCalledOnce();
    expect(openInEditorMock).toHaveBeenCalledWith(target, expect.anything());
    expect(latestApplyAudit()?.result).toBe('ok');
    expect(latestApplyAudit()?.summary).toContain('applied');
  });

  it('A12 APPLIES open-finder when all gates pass — open.ts called, audit ok', async () => {
    repo.enroll();
    const target = repo.dir;
    const p = makeDesktopProposal(repo.dir, target, 'open-finder');
    const { setStatus } = await import('../src/core/inbox/store.js');
    setStatus(p.id, 'approved');
    const result = await applyProposal(p.id, { confirmed: true });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('applied');
    expect(openInFinderMock).toHaveBeenCalledOnce();
    expect(openInFinderMock).toHaveBeenCalledWith(target);
    expect(latestApplyAudit()?.result).toBe('ok');
  });

  it('A13 APPLIES open-terminal when all gates pass — open.ts called, audit ok', async () => {
    repo.enroll();
    const target = repo.dir;
    const p = makeDesktopProposal(repo.dir, target, 'open-terminal');
    const { setStatus } = await import('../src/core/inbox/store.js');
    setStatus(p.id, 'approved');
    const result = await applyProposal(p.id, { confirmed: true });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('applied');
    expect(openInTerminalMock).toHaveBeenCalledOnce();
    expect(openInTerminalMock).toHaveBeenCalledWith(target);
    expect(latestApplyAudit()?.result).toBe('ok');
  });

  it('A14 browser-action ALWAYS refuses — Phase 2b not implemented', async () => {
    repo.enroll();
    const p = createProposal({
      repo: repo.dir,
      origin: 'agent',
      kind: 'browser-action',
      title: 'Browser thing',
      summary: 'Phase 2b',
    });
    const { setStatus } = await import('../src/core/inbox/store.js');
    setStatus(p.id, 'approved');
    const result = await applyProposal(p.id, { confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/browser-action.*not yet implemented|Phase 2b/i);
    expect(result.status).toBe('failed');
    expect(latestApplyAudit()?.result).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// N-series: ashlr_desktop_open native tool — PROPOSAL-ONLY invariant
// ---------------------------------------------------------------------------

describe('ashlr_desktop_open native tool — proposal-only invariant', () => {
  it('N1 creates a PENDING proposal and NEVER executes the action directly', async () => {
    repo.enroll();
    const target = repo.dir;

    const result = await callNativeTool('ashlr_desktop_open', {
      repo: repo.dir,
      action_type: 'open-finder',
      target,
      title: 'Fleet wants to open root',
      summary: 'Inspect the directory',
    });

    // Must return a text content block (not isError)
    const content = result.content[0];
    expect(content.type).toBe('text');
    expect((content as { type: 'text'; text: string }).text).not.toContain('"isError":true');

    const parsed = JSON.parse((content as { type: 'text'; text: string }).text) as {
      created: boolean;
      id: string;
      status: string;
      note: string;
    };
    expect(parsed.created).toBe(true);
    expect(parsed.status).toBe('pending');
    expect(parsed.note).toMatch(/pending|approve/i);
    expect(typeof parsed.id).toBe('string');

    // Confirm the proposal is in the inbox as pending
    const p = loadProposal(parsed.id);
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('desktop-action');
    expect(p!.status).toBe('pending');
    expect(p!.action?.type).toBe('open-finder');
    expect(p!.action?.target).toBe(target);

    // CRITICAL: the open.ts launchers must NOT have been called
    expect(openInEditorMock).not.toHaveBeenCalled();
    expect(openInFinderMock).not.toHaveBeenCalled();
    expect(openInTerminalMock).not.toHaveBeenCalled();

    // Audit captured
    expect(latestNativeAudit()).toBeDefined();
    expect(latestNativeAudit()?.result).toBe('ok');
  });

  it('N2 refuses with error when repo is not enrolled (no proposal created)', async () => {
    // Deliberately NOT enrolling the repo
    const countBefore = (await import('../src/core/inbox/store.js')).pendingCount();

    const result = await callNativeTool('ashlr_desktop_open', {
      repo: repo.dir,
      action_type: 'open-finder',
      target: repo.dir,
      title: 'Should fail',
      summary: 'Repo not enrolled',
    });

    const content = result.content[0] as { type: 'text'; text: string };
    const parsed = JSON.parse(content.text) as { error?: string };
    expect(parsed.error).toMatch(/not enrolled/i);

    const countAfter = (await import('../src/core/inbox/store.js')).pendingCount();
    expect(countAfter).toBe(countBefore); // no proposal created

    expect(openInFinderMock).not.toHaveBeenCalled();
  });

  it('N3 refuses when kill switch is ON (safety class = proposal → blocked)', async () => {
    repo.enroll();
    fx.setKill(true);

    const result = await callNativeTool('ashlr_desktop_open', {
      repo: repo.dir,
      action_type: 'open-finder',
      target: repo.dir,
      title: 'Kill switch on',
      summary: 'Should be blocked by kill switch',
    });

    const content = result.content[0] as { type: 'text'; text: string };
    // callNativeTool returns isError for kill-switch refusal
    expect(content.text).toMatch(/kill switch|refused/i);

    expect(openInFinderMock).not.toHaveBeenCalled();
    expect(latestNativeAudit()?.result).toBe('refused');
  });
});
