/**
 * m71.onboard-stack.test.ts — M71: stack detection seam wired into `ashlr onboard`.
 *
 * WHAT IS TESTED:
 *  - buildStackStep() is a pure helper: returns a non-empty advisory array when
 *    stack is installed and never throws regardless of installation state.
 *  - When stack is ABSENT: returns the single dim install-hint line.
 *  - When stack is PRESENT + no services: returns advisory with `stack recommend`
 *    / `stack add <service>` hints.
 *  - When stack is PRESENT + services wired: lists service names and the
 *    Phantom auto-wire note.
 *  - When repo has .stack.toml (stackProjectConfigured): notes it in the output.
 *  - cmdOnboard (--yes, non-interactive) completes (exit 0) and includes a
 *    stack/services line when stack is installed, or the install hint otherwise.
 *    It NEVER throws and NEVER blocks onboarding.
 *
 * SAFETY (mirrors h7.onboard.test.ts conventions):
 *  - Isolated HOME per test via makeFixture; NEVER touches the real ~/.ashlr.
 *  - vi.mock for stack integration functions (stackInstalled / stackStatus /
 *    stackProjectConfigured) — never invokes the real CLI.
 *  - vi.mock for buildReadiness (deterministic ready report, no live probeEndpoint).
 *  - vi.mock for tick (deterministic dry-run shape, no live daemon).
 *  - Every it() ends with expect.hasAssertions().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';

// ── Hoisted mocks (vi.mock is hoisted; spies must be created via vi.hoisted) ──
const { stackInstalledSpy, stackStatusSpy, stackProjectConfiguredSpy, readinessSpy, tickSpy } =
  vi.hoisted(() => ({
    stackInstalledSpy: vi.fn(() => false),
    stackStatusSpy: vi.fn(() => ({ ok: false, detail: 'stack not installed' })),
    stackProjectConfiguredSpy: vi.fn(() => false),
    readinessSpy: vi.fn(),
    tickSpy: vi.fn(async (_cfg: unknown, opts: { dryRun: boolean }) => ({
      ts: new Date().toISOString(),
      itemsConsidered: opts.dryRun ? 0 : 0,
      proposalsCreated: 0,
      spentUsd: 0,
      reason: 'dry-run',
    })),
  }));

vi.mock('../src/core/integrations/stack.js', () => ({
  stackInstalled: stackInstalledSpy,
  stackStatus: stackStatusSpy,
  stackProjectConfigured: stackProjectConfiguredSpy,
}));
vi.mock('../src/core/readiness.js', () => ({ buildReadiness: readinessSpy }));
vi.mock('../src/core/daemon/loop.js', () => ({ tick: tickSpy }));

// Imported AFTER vi.mock declarations so the module sees the mocked versions.
import { buildStackStep, cmdOnboard, _internals } from '../src/cli/onboard.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function readyReport() {
  return {
    ready: true,
    blockers: [],
    warnings: [],
    info: [{ id: 'enrollment', severity: 'info' as const, detail: '0 repo(s) enrolled' }],
    generatedAt: new Date().toISOString(),
  };
}

let fx: H1Fixture | undefined;
let logSpy: ReturnType<typeof vi.spyOn>;

function logged(): string {
  return logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
}

beforeEach(() => {
  fx = makeFixture();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  // Default confirm: decline (non-interactive guard).
  _internals.confirm = vi.fn(async () => false);
  // Default readiness: ready.
  readinessSpy.mockResolvedValue(readyReport());
  // Reset stack spies to "not installed" defaults.
  stackInstalledSpy.mockReturnValue(false);
  stackStatusSpy.mockReturnValue({ ok: false, detail: 'stack not installed' });
  stackProjectConfiguredSpy.mockReturnValue(false);
  tickSpy.mockClear();
});

afterEach(() => {
  fx?.cleanup();
  fx = undefined;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// buildStackStep — pure helper, never throws
// ---------------------------------------------------------------------------

describe('M71 buildStackStep — pure helper', () => {
  it('returns a non-empty array and never throws when stack is absent', () => {
    expect.hasAssertions();
    stackInstalledSpy.mockReturnValue(false);

    const lines = buildStackStep('/tmp/some-repo');

    expect(lines).toBeDefined();
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    // Contains the install hint text (ANSI may wrap it but the keyword is there).
    expect(lines.join('\n')).toMatch(/stack/i);
    expect(lines.join('\n')).toMatch(/install|provision/i);
  });

  it('returns a non-empty array and never throws when stack is installed + no services', () => {
    expect.hasAssertions();
    stackInstalledSpy.mockReturnValue(true);
    stackStatusSpy.mockReturnValue({ ok: true, services: [], detail: '0 service(s)' });
    stackProjectConfiguredSpy.mockReturnValue(false);

    const lines = buildStackStep('/tmp/some-repo');

    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    const joined = lines.join('\n');
    // Advisory heading and hint commands present.
    expect(joined).toMatch(/Services/i);
    expect(joined).toMatch(/stack recommend/);
    expect(joined).toMatch(/stack add/);
  });

  it('lists wired service names and the Phantom auto-wire note when services exist', () => {
    expect.hasAssertions();
    stackInstalledSpy.mockReturnValue(true);
    stackStatusSpy.mockReturnValue({
      ok: true,
      services: ['postgres', 'redis'],
      detail: '2 service(s)',
    });
    stackProjectConfiguredSpy.mockReturnValue(false);

    const lines = buildStackStep('/tmp/some-repo');
    const joined = lines.join('\n');

    expect(joined).toMatch(/postgres/);
    expect(joined).toMatch(/redis/);
    expect(joined).toMatch(/phantom/i);
    expect(joined).toMatch(/stack add/);
  });

  it('notes .stack.toml when stackProjectConfigured returns true', () => {
    expect.hasAssertions();
    stackInstalledSpy.mockReturnValue(true);
    stackStatusSpy.mockReturnValue({ ok: true, services: ['postgres'], detail: '1 service(s)' });
    stackProjectConfiguredSpy.mockReturnValue(true);

    const lines = buildStackStep('/tmp/some-repo');
    const joined = lines.join('\n');

    expect(joined).toMatch(/\.stack\.toml/);
    expect(joined).toMatch(/configured/i);
  });

  it('never throws even if stackStatus throws unexpectedly', () => {
    expect.hasAssertions();
    stackInstalledSpy.mockReturnValue(true);
    stackStatusSpy.mockImplementation(() => {
      throw new Error('unexpected CLI crash');
    });
    stackProjectConfiguredSpy.mockReturnValue(false);

    // Must not throw — degrades to empty (silent) rather than crashing.
    let result: string[] = [];
    expect(() => {
      result = buildStackStep('/tmp/some-repo');
    }).not.toThrow();
    // Returns an array (may be empty on unexpected error — that's fine).
    expect(Array.isArray(result)).toBe(true);
  });

  it('never throws even if stackInstalled throws unexpectedly', () => {
    expect.hasAssertions();
    stackInstalledSpy.mockImplementation(() => {
      throw new Error('PATH lookup crashed');
    });

    let result: string[] = [];
    expect(() => {
      result = buildStackStep('/tmp/some-repo');
    }).not.toThrow();
    expect(Array.isArray(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cmdOnboard integration — stack section appears but never blocks
// ---------------------------------------------------------------------------

describe('M71 cmdOnboard — stack advisory is additive, never blocks', () => {
  it('completes (exit 0) with --yes when stack is NOT installed, prints install hint', async () => {
    expect.hasAssertions();
    stackInstalledSpy.mockReturnValue(false);
    const repo = fx!.makeRepo();

    const code = await cmdOnboard(['--yes', repo.dir]);

    expect(code).toBe(0);
    // The install hint must appear somewhere in the output.
    const out = logged();
    expect(out).toMatch(/stack/i);
    // The existing onboard steps are still present (additive, not replacing).
    expect(out).toContain('ashlr preflight');
    expect(out).toContain('ashlr inbox');
  });

  it('completes (exit 0) with --yes when stack IS installed + no services, shows advisory', async () => {
    expect.hasAssertions();
    stackInstalledSpy.mockReturnValue(true);
    stackStatusSpy.mockReturnValue({ ok: true, services: [], detail: '0 service(s)' });
    stackProjectConfiguredSpy.mockReturnValue(false);
    const repo = fx!.makeRepo();

    const code = await cmdOnboard(['--yes', repo.dir]);

    expect(code).toBe(0);
    const out = logged();
    // Advisory heading present.
    expect(out).toMatch(/Services/i);
    // Hint commands present.
    expect(out).toMatch(/stack recommend/);
    // Existing onboard output still there.
    expect(out).toContain('ashlr preflight');
    expect(out).toContain('ashlr inbox');
  });

  it('completes (exit 0) with --yes when stack IS installed + services wired, lists them', async () => {
    expect.hasAssertions();
    stackInstalledSpy.mockReturnValue(true);
    stackStatusSpy.mockReturnValue({
      ok: true,
      services: ['postgres', 'stripe'],
      detail: '2 service(s)',
    });
    stackProjectConfiguredSpy.mockReturnValue(true);
    const repo = fx!.makeRepo();

    const code = await cmdOnboard(['--yes', repo.dir]);

    expect(code).toBe(0);
    const out = logged();
    expect(out).toMatch(/postgres/);
    expect(out).toMatch(/stripe/);
    expect(out).toMatch(/\.stack\.toml/);
    // The phantom auto-wire note must be present.
    expect(out).toMatch(/phantom/i);
  });

  it('NEVER throws even when buildStackStep encounters an internal error', async () => {
    expect.hasAssertions();
    // Force stackInstalled to throw — the onboarding must still return 0.
    stackInstalledSpy.mockImplementation(() => {
      throw new Error('binary not found on PATH');
    });
    const repo = fx!.makeRepo();

    let code: number = -1;
    let threw = false;
    try {
      code = await cmdOnboard(['--yes', repo.dir]);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(code).toBe(0);
  });

  it('existing onboard output is UNCHANGED (stack section is purely additive)', async () => {
    expect.hasAssertions();
    // Stack absent — minimal output path.
    stackInstalledSpy.mockReturnValue(false);
    const repo = fx!.makeRepo();

    const code = await cmdOnboard(['--yes', repo.dir]);

    expect(code).toBe(0);
    const out = logged();
    // All five numbered steps must still be in the output.
    expect(out).toContain('ashlr preflight');
    expect(out).toMatch(/ashlr sandbox enroll/);
    expect(out).toMatch(/--dry-run/);
    expect(out).toContain('ashlr inbox');
    expect(out).toMatch(/--rollback/);
  });
});
