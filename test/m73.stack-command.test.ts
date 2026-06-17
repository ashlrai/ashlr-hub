/**
 * m73.stack-command.test.ts — M73: `ashlr stack` command.
 *
 * WHAT IS TESTED:
 *  - When stack is NOT installed: non-zero exit + clear message, no throw.
 *  - Mutating actions (add / apply) refused in non-TTY without --yes.
 *  - Mutating actions abort cleanly when confirm returns false.
 *  - Mutating actions proceed (call stackRun) when --yes is passed.
 *  - `--help` prints usage listing read-only vs mutating subcommands.
 *  - Read-only paths (status, list, …) never prompt.
 *  - Unknown subcommand returns exit 2.
 *  - `stack add` without a positional arg returns exit 2.
 *
 * SAFETY:
 *  - vi.mock for stackInstalled / stackStatus / stackRun / stackProjectConfigured
 *    — NEVER shells a real `stack add` or `stack apply` in a test.
 *  - _stackInternals.confirm injected so no live TTY is required.
 *  - process.stdout.isTTY and process.stdin.isTTY patched per test.
 *  - Every it() ends with expect.hasAssertions().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Hoisted mocks ────────────────────────────────────────────────────────────
const { stackInstalledSpy, stackStatusSpy, stackRunSpy } = vi.hoisted(() => ({
  stackInstalledSpy: vi.fn(() => false),
  stackStatusSpy: vi.fn(() => ({ ok: false, detail: 'stack not installed' })),
  stackRunSpy: vi.fn(() => ({ ok: true, stdout: 'mock-output', code: 0 })),
}));

vi.mock('../src/core/integrations/stack.js', () => ({
  stackInstalled: stackInstalledSpy,
  stackStatus: stackStatusSpy,
  stackRun: stackRunSpy,
  stackProjectConfigured: vi.fn(() => false),
}));

// Imported AFTER vi.mock so the module sees mocked versions.
import { cmdStack, _stackInternals } from '../src/cli/stack.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let logSpy: ReturnType<typeof vi.spyOn>;
let _errSpy: ReturnType<typeof vi.spyOn>;
let outSpy: ReturnType<typeof vi.spyOn>;

function logged(): string {
  return logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
}

function stdoutWritten(): string {
  return outSpy.mock.calls.map((c) => c.map(String).join('')).join('');
}

/** Patch process.stdout.isTTY to a given value for the duration of a test. */
function patchTty(value: boolean | undefined): () => void {
  const orig = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
  return () => {
    if (orig) {
      Object.defineProperty(process.stdout, 'isTTY', orig);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (process.stdout as any).isTTY;
    }
  };
}

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  _errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  // Default: stack not installed.
  stackInstalledSpy.mockReturnValue(false);
  stackStatusSpy.mockReturnValue({ ok: false, detail: 'stack not installed' });
  stackRunSpy.mockReturnValue({ ok: true, stdout: '', code: 0 });

  // Default confirm: decline (safe default; tests override per case).
  _stackInternals.confirm = vi.fn(async () => false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Stack not installed
// ---------------------------------------------------------------------------

describe('M73 cmdStack — stack not installed', () => {
  it('returns exit 1 and prints a clear install message (no throw)', async () => {
    expect.hasAssertions();
    stackInstalledSpy.mockReturnValue(false);

    const code = await cmdStack([]);

    expect(code).toBe(1);
    // Must mention "stack" and "install" (or similar) — exact text may include ANSI.
    const out = logged();
    expect(out).toMatch(/stack/i);
    expect(out).toMatch(/install/i);
  });

  it('never throws when stack is absent', async () => {
    expect.hasAssertions();
    stackInstalledSpy.mockReturnValue(false);

    let threw = false;
    try {
      await cmdStack(['status']);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  it('returns exit 1 for mutating action when stack absent — no provision', async () => {
    expect.hasAssertions();
    stackInstalledSpy.mockReturnValue(false);
    const restoreTty = patchTty(true);

    const code = await cmdStack(['add', 'postgres', '--yes']);
    restoreTty();

    expect(code).toBe(1);
    // stackRun must NOT have been called.
    expect(stackRunSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// --help
// ---------------------------------------------------------------------------

describe('M73 cmdStack --help', () => {
  it('prints usage and exits 0', async () => {
    expect.hasAssertions();

    const code = await cmdStack(['--help']);

    expect(code).toBe(0);
    const out = logged();
    // Must list both read-only and mutating categories.
    expect(out).toMatch(/status/i);
    expect(out).toMatch(/read-only/i);
    expect(out).toMatch(/add/i);
    expect(out).toMatch(/apply/i);
    expect(out).toMatch(/MUTATING/i);
    expect(out).toMatch(/confirm-gated/i);
  });

  it('-h also prints help and exits 0', async () => {
    expect.hasAssertions();

    const code = await cmdStack(['-h']);

    expect(code).toBe(0);
    expect(logged()).toMatch(/usage/i);
  });
});

// ---------------------------------------------------------------------------
// Read-only: status
// ---------------------------------------------------------------------------

describe('M73 cmdStack status (read-only)', () => {
  it('prints status when stack is installed (no services)', async () => {
    expect.hasAssertions();
    stackInstalledSpy.mockReturnValue(true);
    stackStatusSpy.mockReturnValue({ ok: true, services: [], detail: '0 service(s)' });

    const code = await cmdStack(['status']);

    expect(code).toBe(0);
    // No confirm prompt was called.
    expect(_stackInternals.confirm).not.toHaveBeenCalled();
    const out = logged();
    expect(out).toMatch(/stack/i);
  });

  it('outputs JSON when --json flag is set', async () => {
    expect.hasAssertions();
    stackInstalledSpy.mockReturnValue(true);
    stackStatusSpy.mockReturnValue({ ok: true, services: ['postgres'], detail: '1 service(s)' });

    const code = await cmdStack(['status', '--json']);

    expect(code).toBe(0);
    const written = stdoutWritten();
    const parsed = JSON.parse(written) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
    expect(Array.isArray(parsed['services'])).toBe(true);
  });

  it('bare `ashlr stack` (no sub) = status', async () => {
    expect.hasAssertions();
    stackInstalledSpy.mockReturnValue(true);
    stackStatusSpy.mockReturnValue({ ok: true, services: [], detail: '0 service(s)' });

    const code = await cmdStack([]);

    expect(code).toBe(0);
    expect(_stackInternals.confirm).not.toHaveBeenCalled();
  });

  it('lists wired services in output', async () => {
    expect.hasAssertions();
    stackInstalledSpy.mockReturnValue(true);
    stackStatusSpy.mockReturnValue({ ok: true, services: ['postgres', 'redis'], detail: '2 service(s)' });

    await cmdStack(['status']);

    const out = logged();
    expect(out).toMatch(/postgres/);
    expect(out).toMatch(/redis/);
  });
});

// ---------------------------------------------------------------------------
// Read-only passthroughs (list / providers / recommend / scan / doctor)
// ---------------------------------------------------------------------------

describe('M73 cmdStack read-only passthroughs', () => {
  const readOnlySubs = ['list', 'providers', 'recommend', 'scan', 'doctor'] as const;

  for (const sub of readOnlySubs) {
    it(`${sub}: calls stackRun and does NOT prompt`, async () => {
      expect.hasAssertions();
      stackInstalledSpy.mockReturnValue(true);
      stackRunSpy.mockReturnValue({ ok: true, stdout: `${sub} output`, code: 0 });

      const code = await cmdStack([sub]);

      expect(code).toBe(0);
      // First arg must be [sub, ...rest]; opts is optional so we only check the args array.
      expect(stackRunSpy).toHaveBeenCalled();
      expect(stackRunSpy.mock.calls[0]![0]).toEqual([sub]);
      // No confirm was called.
      expect(_stackInternals.confirm).not.toHaveBeenCalled();
    });
  }
});

// ---------------------------------------------------------------------------
// Mutating: confirmation gate
// ---------------------------------------------------------------------------

describe('M73 cmdStack mutating — confirmation gate', () => {
  describe('non-TTY without --yes is REFUSED', () => {
    it('stack add refuses in non-TTY without --yes', async () => {
      expect.hasAssertions();
      stackInstalledSpy.mockReturnValue(true);
      const restoreTty = patchTty(undefined); // non-TTY

      const code = await cmdStack(['add', 'postgres']);
      restoreTty();

      expect(code).toBe(2);
      // stackRun must NOT have been called (never provision).
      expect(stackRunSpy).not.toHaveBeenCalled();
    });

    it('stack apply refuses in non-TTY without --yes', async () => {
      expect.hasAssertions();
      stackInstalledSpy.mockReturnValue(true);
      const restoreTty = patchTty(undefined); // non-TTY

      const code = await cmdStack(['apply', 'my-recipe']);
      restoreTty();

      expect(code).toBe(2);
      expect(stackRunSpy).not.toHaveBeenCalled();
    });

    it('refusal message is clear and actionable', async () => {
      expect.hasAssertions();
      stackInstalledSpy.mockReturnValue(true);
      const restoreTty = patchTty(undefined);

      await cmdStack(['add', 'stripe']);
      restoreTty();

      // The message must mention non-TTY, the action, and --yes.
      const errOut = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c.map(String).join(''))
        .join('');
      expect(errOut).toMatch(/non-TTY/i);
      expect(errOut).toMatch(/--yes/i);
    });
  });

  describe('confirm returns false → aborts, no provision', () => {
    it('stack add: aborts when user declines (TTY, no --yes)', async () => {
      expect.hasAssertions();
      stackInstalledSpy.mockReturnValue(true);
      const restoreTty = patchTty(true);
      (_stackInternals.confirm as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const code = await cmdStack(['add', 'postgres']);
      restoreTty();

      expect(code).toBe(0); // graceful abort
      expect(stackRunSpy).not.toHaveBeenCalled();
    });

    it('stack apply: aborts when user declines', async () => {
      expect.hasAssertions();
      stackInstalledSpy.mockReturnValue(true);
      const restoreTty = patchTty(true);
      (_stackInternals.confirm as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const code = await cmdStack(['apply']);
      restoreTty();

      expect(code).toBe(0);
      expect(stackRunSpy).not.toHaveBeenCalled();
    });
  });

  describe('--yes bypasses prompt and calls stackRun', () => {
    it('stack add --yes: calls stackRun([add, service]) without prompting', async () => {
      expect.hasAssertions();
      stackInstalledSpy.mockReturnValue(true);
      stackRunSpy.mockReturnValue({ ok: true, stdout: 'wired postgres', code: 0 });
      const restoreTty = patchTty(undefined); // non-TTY + --yes should both work

      const code = await cmdStack(['add', 'postgres', '--yes']);
      restoreTty();

      expect(code).toBe(0);
      expect(stackRunSpy).toHaveBeenCalled();
      expect(stackRunSpy.mock.calls[0]![0]).toEqual(['add', 'postgres']);
      // confirm was NOT called (bypassed by --yes).
      expect(_stackInternals.confirm).not.toHaveBeenCalled();
    });

    it('stack apply --yes: calls stackRun([apply, recipe]) without prompting', async () => {
      expect.hasAssertions();
      stackInstalledSpy.mockReturnValue(true);
      stackRunSpy.mockReturnValue({ ok: true, stdout: 'applied', code: 0 });
      const restoreTty = patchTty(undefined);

      const code = await cmdStack(['apply', 'my-recipe', '--yes']);
      restoreTty();

      expect(code).toBe(0);
      expect(stackRunSpy).toHaveBeenCalled();
      expect(stackRunSpy.mock.calls[0]![0]).toEqual(['apply', 'my-recipe']);
      expect(_stackInternals.confirm).not.toHaveBeenCalled();
    });

    it('stack apply --yes (no recipe): calls stackRun([apply]) without prompting', async () => {
      expect.hasAssertions();
      stackInstalledSpy.mockReturnValue(true);
      stackRunSpy.mockReturnValue({ ok: true, stdout: 'applied default', code: 0 });
      const restoreTty = patchTty(undefined);

      const code = await cmdStack(['apply', '--yes']);
      restoreTty();

      expect(code).toBe(0);
      expect(stackRunSpy).toHaveBeenCalled();
      expect(stackRunSpy.mock.calls[0]![0]).toEqual(['apply']);
    });
  });

  describe('mutating failure propagates exit code', () => {
    it('stack add --yes: propagates non-zero exit from stackRun', async () => {
      expect.hasAssertions();
      stackInstalledSpy.mockReturnValue(true);
      stackRunSpy.mockReturnValue({ ok: false, stdout: '', code: 1 });
      const restoreTty = patchTty(undefined);

      const code = await cmdStack(['add', 'postgres', '--yes']);
      restoreTty();

      expect(code).not.toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('M73 cmdStack error paths', () => {
  it('unknown subcommand returns exit 2', async () => {
    expect.hasAssertions();

    const code = await cmdStack(['bogus-subcommand']);

    expect(code).toBe(2);
  });

  it('stack add with no positional arg returns exit 2', async () => {
    expect.hasAssertions();
    stackInstalledSpy.mockReturnValue(true);
    const restoreTty = patchTty(true);

    const code = await cmdStack(['add']);
    restoreTty();

    expect(code).toBe(2);
    expect(stackRunSpy).not.toHaveBeenCalled();
  });
});
