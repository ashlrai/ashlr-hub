/**
 * test/m70.md-render.test.ts — M70 ashlr-md render seam
 *
 * Tests three things:
 *
 *   1. buildProposalMarkdown (pure builder) — produces a doc containing the
 *      proposal title in an H1 and a ```diff fenced block.
 *
 *   2. --open path degrades gracefully (no throw) when ashlr-md is absent:
 *      we mock presentMarkdown to return rendered:false and assert cmdInbox
 *      falls through to terminal rendering without throwing.
 *
 *   3. Default (no --open) path still returns the terminal path — cmdInbox
 *      show without --open never calls presentMarkdown.
 *
 * No GUI is launched. presentMarkdown and the inbox store are mocked.
 * Follows the h2-series conventions: isolated tmp HOME, vitest, expect.hasAssertions().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers: isolate HOME so inbox store never touches ~/.ashlr
// ---------------------------------------------------------------------------

let tmpHome: string;

beforeEach(() => {
  tmpHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'ashlr-m70-')));
  process.env['HOME'] = tmpHome;
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Minimal Proposal fixture
// ---------------------------------------------------------------------------

function makeProposal(overrides: Partial<Record<string, unknown>> = {}): import('../src/core/types.js').Proposal {
  return {
    id: 'prop-test-000000-abcd',
    origin: 'swarm',
    kind: 'patch',
    title: 'Add retry logic to the scheduler',
    summary: 'The scheduler drops tasks under load. This patch adds exponential back-off.',
    status: 'pending',
    createdAt: '2026-06-17T12:00:00.000Z',
    repo: join(tmpHome, 'myrepo'),
    diff: [
      'diff --git a/src/scheduler.ts b/src/scheduler.ts',
      'index abc..def 100644',
      '--- a/src/scheduler.ts',
      '+++ b/src/scheduler.ts',
      '@@ -10,6 +10,8 @@',
      ' function run() {',
      '+  await sleep(backoff);',
      '+  backoff *= 2;',
      ' }',
    ].join('\n'),
    ...overrides,
  } as import('../src/core/types.js').Proposal;
}

// ---------------------------------------------------------------------------
// 1. buildProposalMarkdown — pure builder tests
// ---------------------------------------------------------------------------

describe('buildProposalMarkdown (pure builder)', () => {
  it('produces a document containing the proposal title', async () => {
    expect.hasAssertions();
    const { buildProposalMarkdown } = await import('../src/cli/inbox.js');
    const p = makeProposal();
    const md = buildProposalMarkdown(p);

    // The rendered title is used by presentMarkdown as the H1; the body should
    // contain the title so it appears in the viewer body too.
    expect(md).toContain(p.title);
  });

  it('produces a ```diff fenced block when diff is present', async () => {
    expect.hasAssertions();
    const { buildProposalMarkdown } = await import('../src/cli/inbox.js');
    const p = makeProposal();
    const md = buildProposalMarkdown(p);

    // Must contain the opening fence
    expect(md).toContain('```diff');
    // The diff content itself must be inside the fence
    expect(md).toContain('diff --git');
    expect(md).toContain('+  await sleep(backoff);');
  });

  it('omits the diff block when no diff is attached', async () => {
    expect.hasAssertions();
    const { buildProposalMarkdown } = await import('../src/cli/inbox.js');
    const p = makeProposal({ diff: undefined });
    const md = buildProposalMarkdown(p);

    expect(md).not.toContain('```diff');
  });

  it('includes key metadata fields', async () => {
    expect.hasAssertions();
    const { buildProposalMarkdown } = await import('../src/cli/inbox.js');
    const p = makeProposal();
    const md = buildProposalMarkdown(p);

    expect(md).toContain(p.id);
    expect(md).toContain(p.kind);
    expect(md).toContain(p.status);
    expect(md).toContain(p.origin);
    expect(md).toContain(p.repo!);
  });

  it('includes approve/reject action hints for pending proposals', async () => {
    expect.hasAssertions();
    const { buildProposalMarkdown } = await import('../src/cli/inbox.js');
    const p = makeProposal({ status: 'pending' });
    const md = buildProposalMarkdown(p);

    expect(md).toContain('ashlr inbox approve');
    expect(md).toContain('ashlr inbox reject');
  });

  it('does not include action hints for non-pending proposals', async () => {
    expect.hasAssertions();
    const { buildProposalMarkdown } = await import('../src/cli/inbox.js');
    const p = makeProposal({ status: 'applied' });
    const md = buildProposalMarkdown(p);

    expect(md).not.toContain('ashlr inbox approve');
    expect(md).not.toContain('ashlr inbox reject');
  });

  it('includes engineModel when present', async () => {
    expect.hasAssertions();
    const { buildProposalMarkdown } = await import('../src/cli/inbox.js');
    const p = makeProposal({ engineModel: 'claude-3-7-sonnet' });
    const md = buildProposalMarkdown(p);

    expect(md).toContain('claude-3-7-sonnet');
  });
});

// ---------------------------------------------------------------------------
// 2. buildDigestMarkdown — pure builder tests
// ---------------------------------------------------------------------------

describe('buildDigestMarkdown (pure builder)', () => {
  function makeDigestReport(): import('../src/core/types.js').DigestReport {
    return {
      date: '2026-06-17',
      window: '7d',
      headline: 'Fleet quiet — 3 proposals pending review.',
      pendingProposals: 3,
      repos: { total: 5, dirty: 1, stale: 0 },
      portfolio: {
        cost: { window: '7d', spentUsd: 0.0042, projectedMonthlyUsd: 0.18, localSavingsUsd: 0.0010 },
        health: { averageScore: 82, averageGrade: 'B', reposScored: 3, worstRepos: [] },
        goalsInFlight: [],
        backlogTop: [],
        effectiveness: null,
        today: {
          previousAt: '2026-06-16',
          pendingProposalsDelta: 1,
          dirtyReposDelta: 0,
          spendUsdDelta: 0.0001,
          healthScoreDelta: null,
          goalsInFlightDelta: null,
        },
      },
      daemon: null,
      narrative: null,
      narrativeLocal: false,
    } as unknown as import('../src/core/types.js').DigestReport;
  }

  it('produces a document containing the headline', async () => {
    expect.hasAssertions();
    const { buildDigestMarkdown } = await import('../src/cli/digest.js');
    const report = makeDigestReport();
    const md = buildDigestMarkdown(report);

    expect(md).toContain(report.headline);
  });

  it('includes the date and window', async () => {
    expect.hasAssertions();
    const { buildDigestMarkdown } = await import('../src/cli/digest.js');
    const md = buildDigestMarkdown(makeDigestReport());

    expect(md).toContain('2026-06-17');
    expect(md).toContain('7d');
  });

  it('includes cost figures', async () => {
    expect.hasAssertions();
    const { buildDigestMarkdown } = await import('../src/cli/digest.js');
    const md = buildDigestMarkdown(makeDigestReport());

    expect(md).toContain('0.0042');
  });

  it('includes narrative when present', async () => {
    expect.hasAssertions();
    const { buildDigestMarkdown } = await import('../src/cli/digest.js');
    const report = makeDigestReport();
    (report as unknown as Record<string, unknown>)['narrative'] = 'Fleet is healthy overall.';
    const md = buildDigestMarkdown(report);

    expect(md).toContain('Fleet is healthy overall.');
    expect(md).toContain('## Summary');
  });
});

// ---------------------------------------------------------------------------
// 3. --open degrades gracefully when ashlr-md is absent
// ---------------------------------------------------------------------------

describe('--open degrades gracefully when presentMarkdown returns rendered:false', () => {
  /**
   * Seed a proposal JSON file directly so _loadProposal can find it without
   * a live store — mirrors the h3.atomic-writes pattern of writing raw JSON.
   */
  function seedProposal(home: string, p: import('../src/core/types.js').Proposal): void {
    const dir = join(home, '.ashlr', 'inbox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${p.id}.json`), JSON.stringify(p, null, 2), 'utf8');
  }

  it('does not throw when presentMarkdown returns rendered:false (viewer absent)', async () => {
    expect.hasAssertions();

    // Seed the proposal on disk so the store finds it.
    const p = makeProposal();
    seedProposal(tmpHome, p);

    // Mock the markdown module: simulate viewer absent (rendered:false, path present)
    vi.mock('../src/core/integrations/markdown.js', () => ({
      presentMarkdown: vi.fn(() => ({
        rendered: false,
        path: '/tmp/ashlr-test.md',
        detail: 'mdopen not found on PATH — ashlr-md not installed',
      })),
      ashlrMdInstalled: vi.fn(() => false),
    }));

    const { cmdInbox } = await import('../src/cli/inbox.js');

    // Should not throw; falls back to terminal rendering
    let exitCode: number | undefined;
    await expect(
      (async () => { exitCode = await cmdInbox(['show', p.id, '--open']); })()
    ).resolves.not.toThrow();

    // Terminal fallback exits 0 — proposal was found and rendered in terminal
    expect(exitCode).toBe(0);
  });

  it('does not throw when the markdown module itself fails to import', async () => {
    expect.hasAssertions();

    const p = makeProposal();
    seedProposal(tmpHome, p);

    // Mock the markdown module to throw on import (simulates module not built)
    vi.mock('../src/core/integrations/markdown.js', () => {
      throw new Error('module not available');
    });

    const { cmdInbox } = await import('../src/cli/inbox.js');

    let exitCode: number | undefined;
    await expect(
      (async () => { exitCode = await cmdInbox(['show', p.id, '--open']); })()
    ).resolves.not.toThrow();

    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Default (no --open) — presentMarkdown is never called
// ---------------------------------------------------------------------------

describe('default show (no --open) — presentMarkdown is not called', () => {
  function seedProposal(home: string, p: import('../src/core/types.js').Proposal): void {
    const dir = join(home, '.ashlr', 'inbox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${p.id}.json`), JSON.stringify(p, null, 2), 'utf8');
  }

  it('does not call presentMarkdown when --open is absent', async () => {
    expect.hasAssertions();

    const p = makeProposal();
    seedProposal(tmpHome, p);

    const presentSpy = vi.fn(() => ({
      rendered: true,
      path: '/tmp/ashlr-test.md',
      detail: 'opened',
    }));

    vi.mock('../src/core/integrations/markdown.js', () => ({
      presentMarkdown: presentSpy,
      ashlrMdInstalled: vi.fn(() => true),
    }));

    const { cmdInbox } = await import('../src/cli/inbox.js');

    // No --open flag → terminal path
    const exitCode = await cmdInbox(['show', p.id]);
    expect(exitCode).toBe(0);

    // presentMarkdown must NOT have been called
    expect(presentSpy).not.toHaveBeenCalled();
  });
});
